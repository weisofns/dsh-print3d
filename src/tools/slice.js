import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { resolveOutputPath, sessionCwd, OUTPUT_ROOT, writeBinaryToCategory } from './io.js'

const require = createRequire(import.meta.url)
const { sliceWithCura, findCuraEngine } = require('../../scripts/cura_slice.cjs')
const { loadProfile } = require('../../scripts/printer_profile.cjs')
const { buildToolpathMap } = require('../../scripts/gcode_map.cjs')

// 切片完成后自动生成刀路简图并附成原生图片块。
// 目的：让「切片 → 自检」成为默认动作，而不是每次都要 agent 记得手动调
// print3d_toolpath_map。失败不影响切片本身（只记 mapError）。
export async function attachToolpathMap(ctx, gcodePath, opts = {}) {
  if (opts.attach_map === false) return {}
  try {
    const text = readFileSync(gcodePath, 'utf8')
    const r = buildToolpathMap(text, { size: opts.map_size })
    const bytes = r.png
    const mapPath = writeBinaryToCategory('preview', `map-${Date.now()}.png`, bytes)
    const out = {
      mapPath,
      mapSummary: `刀路简图 ${r.image}：${r.stats.layers} 层（${r.stats.layerHeights}）· 段 ${r.stats.segments}（挤出 ${r.stats.extrusionSegments} / 空驶 ${r.stats.travelSegments}）· 疑似悬垂层 ${r.stats.overhangLayers}`,
    }
    const attachments = ctx.get('attachments')
    if (attachments !== undefined) {
      try {
        out.mapRef = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'toolpath-map.png' })
      } catch (_) {
        // 附件存储不可用时只返回路径
      }
    }
    return out
  } catch (err) {
    return { mapError: String((err && err.message) || err).slice(0, 200) }
  }
}

// 参数优先级：工具入参 > 打印机配置文件（%USERPROFILE%\.print3d\printer.json）> 后端内置默认。
// 配置文件由窗口程序 tools\printer-setup.bat 可视化编辑。
export function withProfile(opts = {}) {
  const p = loadProfile()
  const pick = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v)
  return {
    ...opts,
    slicer: pick(opts.slicer, p.slicer),
    layer_height: pick(opts.layer_height, p.layer_height),
    first_layer_height: pick(opts.first_layer_height, p.first_layer_height),
    filament_diameter: pick(opts.filament_diameter, p.filament_diameter),
    nozzle: pick(opts.nozzle, p.nozzle),
    infill: pick(opts.infill, p.infill),
    nozzle_temp: pick(opts.nozzle_temp, p.nozzle_temp),
    bed_temp: pick(opts.bed_temp, p.bed_temp),
    speed: pick(opts.speed, p.speed),
    travel_speed: pick(opts.travel_speed, p.travel_speed),
    walls: pick(opts.walls, p.walls),
    top_bottom_layers: pick(opts.top_bottom_layers, p.top_bottom_layers),
    brim_mm: pick(opts.brim_mm, p.brim_mm),
    cura_engine: pick(opts.cura_engine, p.cura_engine_path || undefined),
    prusa_slicer: pick(opts.prusa_slicer, p.prusa_slicer_path || undefined),
  }
}

const execFileAsync = promisify(execFile)

const PRUSA_ABS = [
  'C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe',
  'C:/Program Files (x86)/Prusa3D/PrusaSlicer/prusa-slicer-console.exe',
]

function findPrusaSlicer(explicit) {
  if (explicit) return explicit
  for (const c of PRUSA_ABS) {
    if (existsSync(c)) return c
  }
  return 'prusa-slicer-console' // 交给 PATH 解析
}

function prusaAvailable(explicit) {
  if (explicit) return existsSync(explicit)
  return PRUSA_ABS.some((c) => existsSync(c))
}

// 后端选择：auto 优先 PrusaSlicer（配置体系更完整），没有则用 Cura。
function resolveBackend(want, prusaPath, curaEngine) {
  if (want === 'prusa' || want === 'cura') return want
  if (prusaAvailable(prusaPath)) return 'prusa'
  if (findCuraEngine(curaEngine)) return 'cura'
  return null
}

// 核心切片逻辑（供 print3d_slice 与 print3d_parametric_print 复用）。
// opts 透传给 Cura 后端：slicer / cura_engine / layer_height / filament_diameter /
// nozzle / infill / nozzle_temp / bed_temp / speed / travel_speed / walls / top_bottom_layers / brim_mm
export async function sliceStl(stlAbs, outAbs, configAbs, prusaPath, opts = {}) {
  const backend = resolveBackend(opts.slicer || 'auto', prusaPath, opts.cura_engine)
  if (!backend) {
    throw new Error(
      'print3d_slice: 未找到可用切片器。\n' +
      '  PrusaSlicer：' + PRUSA_ABS.join('  或  ') + '\n' +
      '  CuraEngine：C:/Program Files (x86)/Cura_15.04/CuraEngine.exe\n' +
      '可用 prusa_slicer / cura_engine 参数指定可执行文件绝对路径。',
    )
  }

  if (backend === 'cura') {
    const r = await sliceWithCura(stlAbs, outAbs, opts)
    return { ...r, slicer: 'cura', configUsed: 'cura-engine-defaults' }
  }

  const prusa = findPrusaSlicer(prusaPath)
  const cmdArgs = ['--export-gcode', '--output', outAbs]
  let configUsed = 'default'
  if (configAbs && existsSync(configAbs)) {
    cmdArgs.push('--load', configAbs)
    configUsed = 'custom'
  } else {
    // 没有自定义配置包时，用打印机配置（printer.json）做命令行覆盖。
    // 不覆盖的话 PrusaSlicer 会用它自己的内置默认（层高 0.35/0.3、床温 0），
    // 「窗口里设的」与「实际切的」就对不上 —— 这一点是实测发现的。
    const add = (flag, v, suffix = '') => {
      if (v === undefined || v === null || v === '') return
      cmdArgs.push(flag, `${v}${suffix}`)
    }
    add('--layer-height', opts.layer_height)
    add('--first-layer-height', opts.first_layer_height)
    add('--temperature', opts.nozzle_temp)
    add('--bed-temperature', opts.bed_temp)
    add('--fill-density', opts.infill, '%')
    add('--filament-diameter', opts.filament_diameter)
    add('--nozzle-diameter', opts.nozzle)
    add('--perimeters', opts.walls)
    add('--top-solid-layers', opts.top_bottom_layers)
    add('--bottom-solid-layers', opts.top_bottom_layers)
    add('--brim-width', opts.brim_mm)
    add('--travel-speed', opts.travel_speed)
    if (cmdArgs.length > 3) configUsed = 'profile'
  }
  cmdArgs.push(stlAbs)
  try {
    const { stdout, stderr } = await execFileAsync(prusa, cmdArgs, {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    })
    return {
      outputPath: outAbs,
      slicer: 'prusa',
      prusaSlicer: prusa,
      configUsed,
      stdoutTail: String(stdout || '').slice(-1500),
      stderrTail: String(stderr || '').slice(-1500),
    }
  } catch (err) {
    const detail = String(err.stderr || err.message || '').slice(-2000)
    throw new Error(`print3d_slice: PrusaSlicer 切片失败：${detail}`)
  }
}

export function makeSliceTool(ctx) {
  return {
    name: 'print3d_slice',
    description:
      '把 STL 切成 G-code，支持两个后端（slicer 参数选，默认 auto）：' +
      'prusa＝PrusaSlicer 无头模式（prusa-slicer-console --export-gcode，用内置默认配置含通用 PLA）；' +
      'cura＝CuraEngine（已适配 Cura 15.04/Cura_SteamEngine，参数由下方 Cura 项控制）。' +
      'Cura 后端注意：filament_diameter 默认按 1.75mm，与实际耗材不符会直接导致挤出量错误，务必核对；' +
      '其 G-code 自带完整起收尾（升温/等温/结束关加热）。默认输出到 桌面/3Doutput/gcode/。',
    parameters: {
      type: 'object',
      properties: {
        stl_path: { type: 'string', description: 'STL 文件路径（绝对，或相对工作区）。' },
        output_path: { type: 'string', description: '输出 G-code 路径（默认与 STL 同名 .gcode）。' },
        slicer: { type: 'string', enum: ['auto', 'prusa', 'cura'], description: '切片后端：auto（默认，优先 PrusaSlicer）/ prusa / cura。' },
        config_path: { type: 'string', description: '可选：自定义 PrusaSlicer 配置包 .ini 路径（仅 prusa 后端）。' },
        prusa_slicer: { type: 'string', description: 'prusa-slicer-console 可执行文件路径（可选，默认自动探测）。' },
        cura_engine: { type: 'string', description: 'CuraEngine.exe 路径（可选，默认自动探测 Cura 15.04）。' },

        layer_height: { type: 'number', description: 'Cura：层高 mm（默认 0.2）。' },
        first_layer_height: { type: 'number', description: 'Cura：首层厚 mm（默认 0.3）。' },
        filament_diameter: { type: 'number', description: 'Cura：耗材直径 mm（默认 1.75；老 Cura 官方默认是 2.85，务必按实际耗材填）。' },
        nozzle: { type: 'number', description: 'Cura：喷嘴直径 mm（默认 0.4，决定挤出宽度）。' },
        infill: { type: 'number', description: 'Cura：填充率 %（默认 20）。' },
        nozzle_temp: { type: 'number', description: 'Cura：喷嘴温度 ℃（默认 200）。' },
        bed_temp: { type: 'number', description: 'Cura：热床温度 ℃（默认 60，不需要热床填 0）。' },
        speed: { type: 'number', description: 'Cura：打印速度 mm/s（默认 50）。' },
        travel_speed: { type: 'number', description: 'Cura：空驶速度 mm/s（默认 120）。' },
        walls: { type: 'number', description: 'Cura：墙数（默认 2）。' },
        top_bottom_layers: { type: 'number', description: 'Cura：顶/底实心层数（默认 3）。' },
        brim_mm: { type: 'number', description: 'Cura：底边宽度 mm（默认 0=只用一圈 skirt）。' },
      },
      required: ['stl_path'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const blocks = []
        if (value.mapRef) blocks.push({ type: 'image', attachment: value.mapRef })
        const conf = value.slicer === 'cura' ? 'CuraEngine 15.04 风格参数'
          : value.configUsed === 'custom' ? '自定义配置包'
          : value.configUsed === 'profile' ? '打印机配置（printer.json）'
          : 'PrusaSlicer 默认配置（通用 PLA）'
        const lines = [`切片完成（${conf}）→ ${value.outputPath}`]
        if (value.mapSummary) lines.push(value.mapSummary)
        if (value.mapPath) lines.push(`简图 PNG：${value.mapPath}`)
        if (value.mapError) lines.push(`（简图生成失败，不影响切片：${value.mapError}）`)
        blocks.push({ type: 'text', text: lines.join('\n') })
        return blocks
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const stlAbs = resolveOutputPath(args.stl_path, cwd)
      if (!existsSync(stlAbs)) throw new Error(`print3d_slice: STL 不存在：${stlAbs}`)
      const outAbs = args.output_path
        ? resolveOutputPath(args.output_path, cwd)
        : join(OUTPUT_ROOT, 'gcode', basename(stlAbs).replace(/\.stl$/i, '.gcode'))
      const configAbs = args.config_path ? resolveOutputPath(args.config_path, cwd) : undefined
      const { stl_path, output_path, config_path, ...opts } = args
      const resolved = withProfile(opts)
      const sliced = await sliceStl(stlAbs, outAbs, configAbs, resolved.prusa_slicer, resolved)
      const map = await attachToolpathMap(ctx, sliced.outputPath, args)
      return { ok: true, stlPath: stlAbs, ...sliced, ...map }
    },
  }
}
