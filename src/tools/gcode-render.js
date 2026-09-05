import { createRequire } from 'node:module'
import { writeBinaryFile, writeBinaryToCategory } from './io.js'

const require = createRequire(import.meta.url)
const { renderGcode } = require('../../scripts/gcode_render.cjs')

export function makeGcodeRenderTool(ctx) {
  return {
    name: 'print3d_gcode_render',
    description:
      '把 G-code 刀路渲染成俯视图 PNG（按 ;TYPE: 上色：红=外墙/内壁、蓝=填充、绿=实心/顶面/桥、橙=裙边、紫=支撑、灰=空驶）。' +
      '默认以原生图片块返回，并写入 桌面/3Doutput/preview/；可用 output_path 指定其它路径。把 .gcode 完整文本作为 gcode_text 传入。',
    parameters: {
      type: 'object',
      properties: {
        gcode_text: { type: 'string', description: 'G-code 文件的完整文本内容。' },
        size: { type: 'number', description: '输出正方形边长（像素，默认 1000）。' },
        output_path: { type: 'string', description: '可选：把 PNG 写入此路径（绝对，或相对工作区）。' },
      },
      required: ['gcode_text'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const blocks = []
        if (value.imageRef) blocks.push({ type: 'image', attachment: value.imageRef })
        const summary = `G-code 刀路预览：${value.image}，共 ${value.segments} 段（挤出 ${value.extrusionSegments}，空驶 ${value.travelSegments}）。包围盒：X [${value.bbox.minX}, ${value.bbox.maxX}]，Y [${value.bbox.minY}, ${value.bbox.maxY}]。`
        const extra = []
        if (value.outputPath) extra.push(`PNG 已写入：${value.outputPath}`)
        if (!value.imageRef) extra.push(`PNG data URI：data:image/png;base64,${value.pngBase64}`)
        blocks.push({ type: 'text', text: [summary, ...extra].join('\n') })
        return blocks
      },
    },
    async execute(args, exec) {
      const size = typeof args.size === 'number' && args.size > 0 ? args.size : 1000
      const result = renderGcode(args.gcode_text, size)
      const bytes = Buffer.from(result.pngBase64, 'base64')
      let outputPath
      if (args.output_path) {
        outputPath = writeBinaryFile(ctx, exec, args.output_path, bytes)
      } else {
        outputPath = writeBinaryToCategory('preview', `toolpath-${Date.now()}.png`, bytes)
      }
      let imageRef
      const attachments = ctx.get('attachments')
      if (attachments !== undefined) {
        try {
          imageRef = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'toolpath.png' })
        } catch (_) {
          // 附件存储不可用时退化为 base64 data URI
        }
      }
      return {
        image: result.image,
        segments: result.segments,
        extrusionSegments: result.extrusionSegments,
        travelSegments: result.travelSegments,
        bbox: result.bbox,
        pngBase64: result.pngBase64,
        imageRef,
        outputPath,
      }
    },
  }
}
