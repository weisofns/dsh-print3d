import { createRequire } from 'node:module'
import { writeTextFile } from './io.js'

const require = createRequire(import.meta.url)
const { generate } = require('../../scripts/gen_parametric_stl.cjs')

export function makeGenParametricStlTool(ctx) {
  return {
    name: 'print3d_gen_parametric_stl',
    description:
      '生成一个水密的 ASCII STL（box / cylinder / tube / sphere）并直接写入 .stl 文件，返回文件路径。' +
      '默认文件名为 <shape>.stl；可用 output_path 指定（绝对，或相对工作区）。',
    parameters: {
      type: 'object',
      properties: {
        shape: {
          type: 'string',
          enum: ['box', 'cylinder', 'tube', 'sphere'],
          description: '形状：box 长方体、cylinder 圆柱、tube 圆管、sphere 球体。',
        },
        x: { type: 'number', description: 'box 的 X 尺寸 mm（默认 20）。' },
        y: { type: 'number', description: 'box 的 Y 尺寸 mm（默认 20）。' },
        z: { type: 'number', description: 'box 的 Z 尺寸 mm（默认 10）。' },
        d: { type: 'number', description: 'cylinder/tube/sphere 的外径 mm（默认 20）。' },
        id: { type: 'number', description: 'tube 的内径 mm（默认 6，须小于 d）。' },
        h: { type: 'number', description: 'cylinder/tube 的高度 mm（默认 30）。' },
        segments: { type: 'number', description: '圆周分段数（默认 cylinder/tube 64，sphere 32）。' },
        output_path: { type: 'string', description: '输出 .stl 文件路径（绝对，或相对工作区；默认 <shape>.stl）。' },
      },
      required: ['shape'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: `已生成 ${value.shape} STL（${value.sizeBytes} 字节）→ ${value.outputPath}` }]
      },
    },
    async execute(args, exec) {
      const { output_path, ...params } = args
      const result = generate(params)
      const outputPath = writeTextFile(ctx, exec, output_path || `${result.shape}.stl`, result.stl)
      return { shape: result.shape, sizeBytes: result.sizeBytes, outputPath }
    },
  }
}
