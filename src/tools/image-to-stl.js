import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveOutputPath, sessionCwd, writeToCategory, writeTextFile } from './io.js'

const require = createRequire(import.meta.url)
const { generate } = require('../../scripts/image_to_stl.cjs')

export function makeImageToStlTool(ctx) {
  return {
    name: 'print3d_image_to_stl',
    description:
      '把图片（照片/logo/图纸/零件截图）转成可打印的 3D 模型 STL。' +
      'extrude 模式：抠出零件剪影并挤出成 2.5D 平板件（打印零件用，默认）；' +
      'lithophane 模式：按灰度生成透光浮雕（透光看就是照片）。' +
      'JPEG/WebP 依赖本机 sharp（DSH 自带），PNG 可用内置解码。默认写到 桌面/3Doutput/stl/。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片文件路径（绝对，或相对工作区）。' },
        mode: { type: 'string', enum: ['extrude', 'lithophane'], description: 'extrude=剪影挤出成平板件（默认）；lithophane=灰度透光浮雕。' },
        width_mm: { type: 'number', description: '模型最长边宽度 mm（默认 60）。' },
        depth_mm: { type: 'number', description: 'extrude 模式挤出高度 mm（默认 5）。' },
        threshold: { type: 'number', description: 'extrude 模式二值化阈值 0-255（默认自动 Otsu，一般不用指定）。' },
        invert: { type: 'boolean', description: '反转：默认 false（亮部=零件）；true 表示暗部=零件。' },
        min_thickness_mm: { type: 'number', description: 'lithophane 最小厚度 mm（默认 0.8）。' },
        max_thickness_mm: { type: 'number', description: 'lithophane 最大厚度 mm（默认 2.5）。' },
        max_pixels: { type: 'number', description: '降采样后最长边像素（默认 150，越大越精细但 STL 越大）。' },
        output_path: { type: 'string', description: '输出 .stl 路径（默认 桌面/3Doutput/stl/<图片名>-<mode>.stl）。' },
      },
      required: ['image_path'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{
          type: 'text',
          text: `图片→模型完成（${value.mode}，${value.widthMm.toFixed(1)}×${value.heightMm.toFixed(1)}mm，高 ${value.depthMm}mm）→ ${value.outputPath}`,
        }]
      },
    },
    async execute(args, exec) {
      const imageAbs = resolveOutputPath(args.image_path, sessionCwd(ctx, exec))
      if (!existsSync(imageAbs)) throw new Error(`print3d_image_to_stl: 图片不存在：${imageAbs}`)
      const { output_path, ...params } = args
      const result = await generate({ ...params, imagePath: imageAbs })
      const base = basename(imageAbs).replace(/\.[^.]+$/, '')
      const outputPath = output_path
        ? writeTextFile(ctx, exec, output_path, result.stl)
        : writeToCategory('stl', `${base}-${result.mode}.stl`, result.stl)
      return { mode: result.mode, stlPath: outputPath, ...result, sizeBytes: result.sizeBytes }
    },
  }
}
