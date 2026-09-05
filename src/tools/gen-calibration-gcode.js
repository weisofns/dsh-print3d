import { createRequire } from 'node:module'
import { writeTextFile } from './io.js'

const require = createRequire(import.meta.url)
const { generate } = require('../../scripts/gen_calibration_gcode.cjs')

export function makeGenCalibrationGcodeTool(ctx) {
  return {
    name: 'print3d_gen_calibration_gcode',
    description:
      '生成可上机的校准件 G-code（Marlin/Klipper 方言）：cube / temp-tower / first-layer / retraction / bridge。' +
      '自带安全起收尾脚本（升温、结束关加热）。默认返回 G-code 文本；传 output_path 则直接写入 .gcode 文件。',
    parameters: {
      type: 'object',
      properties: {
        part: {
          type: 'string',
          enum: ['cube', 'temp-tower', 'first-layer', 'retraction', 'bridge'],
          description: '校准件类型：cube XYZ 立方体、temp-tower 温度塔、first-layer 首层方块、retraction 回抽双柱、bridge 架桥。',
        },
        nozzle: { type: 'number', description: '喷嘴温度 ℃（默认 200）。' },
        bed: { type: 'number', description: '热床温度 ℃（默认 60）。' },
        layer_height: { type: 'number', description: '层高 mm（默认 0.2）。' },
        line_width: { type: 'number', description: '线宽 mm（默认 0.4）。' },
        speed: { type: 'number', description: '打印速度 mm/s（默认 40）。' },
        size: { type: 'number', description: '尺寸 mm（默认 cube 20，first-layer 60）。' },
        start: { type: 'number', description: 'temp-tower 起始温度 ℃（默认 220）。' },
        end: { type: 'number', description: 'temp-tower 结束温度 ℃（默认 180）。' },
        step: { type: 'number', description: 'temp-tower 每段温差 ℃（默认 5）。' },
        segment_height: { type: 'number', description: 'temp-tower 每段高度 mm（默认 8）。' },
        post_radius: { type: 'number', description: 'retraction 柱半径 mm（默认 4）。' },
        post_height: { type: 'number', description: 'retraction 柱高 mm（默认 30）。' },
        gap: { type: 'number', description: 'retraction 两柱间距 mm（默认 10）。' },
        tower_width: { type: 'number', description: 'bridge 塔柱宽 mm（默认 10）。' },
        tower_height: { type: 'number', description: 'bridge 塔柱高 mm（默认 20）。' },
        span: { type: 'number', description: 'bridge 桥跨度 mm（默认 30）。' },
        output_path: { type: 'string', description: '可选：直接把 G-code 写入此路径（绝对，或相对工作区）。' },
      },
      required: ['part'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.outputPath) {
          return [{ type: 'text', text: `已生成 ${value.part} G-code（${value.sizeBytes} 字节）→ ${value.outputPath}（上机前请人工核对温度/尺寸/固件方言）` }]
        }
        return [{ type: 'text', text: value.gcode }]
      },
    },
    async execute(args, exec) {
      const { output_path, ...p } = args
      const result = generate({
        part: p.part,
        nozzle: p.nozzle,
        bed: p.bed,
        layerHeight: p.layer_height,
        lineWidth: p.line_width,
        speed: p.speed,
        size: p.size,
        start: p.start,
        end: p.end,
        step: p.step,
        segmentHeight: p.segment_height,
        postRadius: p.post_radius,
        postHeight: p.post_height,
        gap: p.gap,
        towerWidth: p.tower_width,
        towerHeight: p.tower_height,
        span: p.span,
      })
      if (output_path) {
        const outputPath = writeTextFile(ctx, exec, output_path, result.gcode)
        return { part: result.part, sizeBytes: result.sizeBytes, outputPath }
      }
      return result
    },
  }
}
