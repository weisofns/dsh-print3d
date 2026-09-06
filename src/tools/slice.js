import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { resolveOutputPath, sessionCwd, OUTPUT_ROOT } from './io.js'

const execFileAsync = promisify(execFile)

const PRUSA_CANDIDATES = [
  'C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe',
  'C:/Program Files (x86)/Prusa3D/PrusaSlicer/prusa-slicer-console.exe',
  'prusa-slicer-console',
]

function findPrusaSlicer(explicit) {
  if (explicit) return explicit
  for (const candidate of PRUSA_CANDIDATES) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else {
      return candidate // 交给 PATH 解析
    }
  }
  return null
}

export function makeSliceTool(ctx) {
  return {
    name: 'print3d_slice',
    description:
      '用 PrusaSlicer 无头模式（prusa-slicer-console --export-gcode）把 STL 切成 G-code。' +
      '自动使用 PrusaSlicer 内置默认配置（含通用 PLA 材料），无需单独的材料配置文件；可用 config_path 指定自定义配置包。默认输出到 桌面/3Doutput/gcode/。',
    parameters: {
      type: 'object',
      properties: {
        stl_path: { type: 'string', description: 'STL 文件路径（绝对，或相对工作区）。' },
        output_path: { type: 'string', description: '输出 G-code 路径（默认与 STL 同名 .gcode）。' },
        config_path: { type: 'string', description: '可选：自定义 PrusaSlicer 配置包 .ini 路径（默认用 PrusaSlicer 内置配置，含通用 PLA 材料）。' },
        prusa_slicer: { type: 'string', description: 'prusa-slicer-console 可执行文件路径（可选，默认自动探测）。' },
      },
      required: ['stl_path'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec)
      const stlAbs = resolveOutputPath(args.stl_path, cwd)
      if (!existsSync(stlAbs)) throw new Error(`print3d_slice: STL 不存在：${stlAbs}`)
      const outAbs = args.output_path
        ? resolveOutputPath(args.output_path, cwd)
        : join(OUTPUT_ROOT, 'gcode', basename(stlAbs).replace(/\.stl$/i, '.gcode'))
      const prusa = findPrusaSlicer(args.prusa_slicer)
      if (!prusa) {
        throw new Error('print3d_slice: 未找到 PrusaSlicer。请安装 PrusaSlicer，或用 prusa_slicer 参数指定 prusa-slicer-console.exe 的绝对路径。')
      }
      const cmdArgs = ['--export-gcode', '--output', outAbs]
      if (args.config_path) cmdArgs.push('--load', resolveOutputPath(args.config_path, cwd))
      cmdArgs.push(stlAbs)
      try {
        const { stdout, stderr } = await execFileAsync(prusa, cmdArgs, {
          timeout: 300000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        })
        return {
          ok: true,
          outputPath: outAbs,
          stlPath: stlAbs,
          prusaSlicer: prusa,
          stdoutTail: String(stdout || '').slice(-1500),
          stderrTail: String(stderr || '').slice(-1500),
        }
      } catch (err) {
        const detail = String(err.stderr || err.message || '').slice(-2000)
        throw new Error(`print3d_slice: PrusaSlicer 切片失败：${detail}`)
      }
    },
  }
}
