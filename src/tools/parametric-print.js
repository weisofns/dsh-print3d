import { createRequire } from 'node:module'
import { join } from 'node:path'
import { writeToCategory, OUTPUT_ROOT } from './io.js'
import { sliceStl } from './slice.js'

const require = createRequire(import.meta.url)
const { generate } = require('../../scripts/gen_parametric_stl.cjs')

export function makeParametricPrintTool(_ctx) {
  return {
    name: 'print3d_parametric_print',
    description:
      '一键参数化打印：生成参数化 STL 并用 PrusaSlicer 切成 G-code，返回两个文件路径。' +
      '传 shape 与尺寸参数即可，无需手动协调建模和切片两步。',
    parameters: {
      type: 'object',
      properties: {
        shape: {
          type: 'string',
          enum: ['box', 'cylinder', 'tube', 'sphere', 'cone', 'rounded_box', 'gear'],
          description: '形状：box 长方体、cylinder 圆柱、tube 圆管、sphere 球体、cone 圆台/圆锥、rounded_box 圆角盒、gear 直齿齿轮。',
        },
        x: { type: 'number', description: 'box/rounded_box 的 X 尺寸 mm（默认 20）。' },
        y: { type: 'number', description: 'box/rounded_box 的 Y 尺寸 mm（默认 20）。' },
        z: { type: 'number', description: 'box/rounded_box 的 Z 尺寸 mm（默认 10）。' },
        d: { type: 'number', description: 'cylinder/tube/sphere 的外径 mm（默认 20）。' },
        id: { type: 'number', description: 'tube 的内径 mm（默认 6，须小于 d）。' },
        h: { type: 'number', description: 'cylinder/tube/cone 的高度 mm（默认 30）。' },
        segments: { type: 'number', description: '圆周分段数（默认 cylinder/tube 64，sphere 32，gear 128）。' },
        d1: { type: 'number', description: 'cone 的下底直径 mm（默认 20）。' },
        d2: { type: 'number', description: 'cone 的上底直径 mm（默认 10，0 为圆锥）。' },
        r: { type: 'number', description: 'rounded_box 的圆角半径 mm（默认 3，须小于 min(x,y)/2）。' },
        teeth: { type: 'number', description: 'gear 的齿数（默认 12）。' },
        module: { type: 'number', description: 'gear 的模数 mm（默认 1，决定齿大小）。' },
        thickness: { type: 'number', description: 'gear 的厚度 mm（默认 5）。' },
        bore: { type: 'number', description: 'gear 的中心孔径 mm（默认 4，0 为实心）。' },
      },
      required: ['shape'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const conf = value.configUsed === 'custom' ? '自定义配置' : 'PrusaSlicer 默认配置（通用 PLA）'
        return [{ type: 'text', text: `已生成并切片 ${value.shape}（${conf}）：STL → ${value.stlPath}；G-code → ${value.gcodePath}` }]
      },
    },
    async execute(args) {
      const result = generate(args)
      const stlPath = writeToCategory('stl', `${result.shape}.stl`, result.stl)
      const gcodePath = join(OUTPUT_ROOT, 'gcode', `${result.shape}.gcode`)
      const sliced = await sliceStl(stlPath, gcodePath, undefined, undefined)
      return {
        shape: result.shape,
        stlPath,
        gcodePath: sliced.outputPath,
        configUsed: sliced.configUsed,
      }
    },
  }
}
