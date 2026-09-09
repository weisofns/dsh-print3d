import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { estimate } = require('../../scripts/gcode_estimate.cjs')

export function makeGcodeEstimateTool(_ctx) {
  return {
    name: 'print3d_gcode_estimate',
    description:
      '估算 G-code 的打印时间（匀速近似，实际约为 1.1–1.3 倍）、耗材长度/质量、层数/层高，以及喷嘴温度（含完整温度序列 nozzleTempSequence，用于检查温度塔的温度梯度）。' +
      '把 .gcode 文件的完整文本作为 gcode_text 传入（先用 read 工具读取文件）。',
    parameters: {
      type: 'object',
      properties: {
        gcode_text: { type: 'string', description: 'G-code 文件的完整文本内容。' },
        density: { type: 'number', description: '耗材密度 g/cm³（默认 1.24 = PLA）。' },
      },
      required: ['gcode_text'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const density = typeof args.density === 'number' && args.density > 0 ? args.density : 1.24
      return estimate(args.gcode_text, density)
    },
  }
}
