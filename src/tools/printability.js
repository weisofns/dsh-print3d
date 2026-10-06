import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolveOutputPath, sessionCwd } from './io.js'

const require = createRequire(import.meta.url)
const { check, loadTriangles } = require('../../scripts/printability.cjs')
const { loadProfile } = require('../../scripts/printer_profile.cjs')

const pct = (v) => `${(v * 100).toFixed(1)}%`

export function makePrintabilityTool(ctx) {
  return {
    name: 'print3d_printability_check',
    description:
      '可打印性预检：拿到一个 STL 先判断「能不能打、该怎么摆」，而不是只看它多大。' +
      '输出：悬垂角度分档面积、建议打印方向（试 6 个朝下姿态选悬垂最少的）、床尺寸是否够、' +
      '高细比翻倒风险、层数与耗材量。已知不覆盖壁厚（需切片后看刀路简图）。' +
      '床尺寸与层高默认取打印机配置（print3d_printer_profile）。',
    parameters: {
      type: 'object',
      properties: {
        stl_path: { type: 'string', description: 'STL 文件路径（绝对，或相对工作区）。' },
        layer_height: { type: 'number', description: '层高 mm（默认取打印机配置）。' },
      },
      required: ['stl_path'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const b = value.base
        const best = value.best
        const lines = [
          `可打印性预检：${value.triangles} 面包围 ${value.best.size.x.toFixed(1)}×${value.best.size.y.toFixed(1)}×${value.best.size.z.toFixed(1)}mm`,
          `体积 ${(value.volume / 1000).toFixed(2)} cm³ · 约 ${value.filamentMeters.toFixed(1)}m / ${value.grams.toFixed(1)}g · ${value.layers} 层（层高 ${value.layerHeight}mm）`,
          `原朝向悬垂占比 ${pct(b.overhangRatio)}（严重 ${b.severe.toFixed(0)}mm² / 警示 ${b.warn.toFixed(0)}mm²）`,
          `推荐朝向：${best.name} —— 悬垂占比 ${pct(best.overhangRatio)}，高度 ${best.height.toFixed(1)}mm`,
          `稳定性：${value.stability.risk}${value.stability.note ? '（' + value.stability.note + '）' : ''}`,
        ]
        if (value.bedOverflow.length) lines.push(`⚠ 超出打印床：${value.bedOverflow.join('；')}`)
        else lines.push(`床尺寸（${value.bed.x}×${value.bed.y}×${value.bed.z}）：放得下`)
        const alts = value.orientations.filter((o) => o.name !== best.name && o.overhangRatio > best.overhangRatio)
        if (alts.length) {
          lines.push('其他朝向对比：' + alts.slice(0, 3).map((o) => `${o.name} ${pct(o.overhangRatio)}/${o.height.toFixed(0)}mm`).join('，'))
        }
        lines.push('注意：壁厚未覆盖 —— 薄壁需切片后用 print3d_toolpath_map 看刀路确认。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const abs = resolveOutputPath(args.stl_path, sessionCwd(ctx, exec))
      if (!existsSync(abs)) throw new Error(`print3d_printability_check: STL 不存在：${abs}`)
      const p = loadProfile()
      const r = check(loadTriangles(abs), {
        bed: { x: p.bed_width, y: p.bed_depth, z: p.bed_height },
        layer_height: args.layer_height || p.layer_height,
      })
      return { ...r, stlPath: abs }
    },
  }
}
