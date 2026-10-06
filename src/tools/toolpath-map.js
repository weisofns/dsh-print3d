import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolveOutputPath, sessionCwd, writeBinaryFile, writeBinaryToCategory } from './io.js'

const require = createRequire(import.meta.url)
const { buildToolpathMap } = require('../../scripts/gcode_map.cjs')

export function makeToolpathMapTool(ctx) {
  return {
    name: 'print3d_toolpath_map',
    description:
      '生成「刀路简图」——一张多面板诊断图，供你直接观察切片结果并判断是否可打印：' +
      '① 俯视全览（按 ;TYPE: 上色）② 侧视轮廓（每层 X 跨度沿 Z 堆叠，橙色=疑似悬垂层）' +
      '③ 首层（床附着面积/形状）④ 顶层（顶面是否完整、有无破洞）。底部为图例色块。' +
      '优先用 gcode_path 直接读文件（避免把大 G-code 读进上下文）；也可传 gcode_text。' +
      '默认写入 桌面/3Doutput/preview/ 并以原生图片块返回。',
    parameters: {
      type: 'object',
      properties: {
        gcode_path: { type: 'string', description: 'G-code 文件路径（推荐，绝对或相对工作区）。' },
        gcode_text: { type: 'string', description: 'G-code 完整文本（备选；文件较大时请改用 gcode_path）。' },
        size: { type: 'number', description: '画布宽度像素（默认 1200）。' },
        output_path: { type: 'string', description: '可选：PNG 输出路径（默认 桌面/3Doutput/preview/map-<时间戳>.png）。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const blocks = []
        if (value.imageRef) blocks.push({ type: 'image', attachment: value.imageRef })
        const s = value.stats
        const lines = [
          `刀路简图 ${value.image}：`,
          '  ① 左上 俯视全览（X-Y，按类型上色）',
          '  ② 右上 侧视轮廓（每层 X 跨度沿 Z 堆叠；橙色=疑似悬垂层）',
          '  ③ 左下 首层（床附着）',
          '  ④ 右下 顶层（顶面完整性）',
          `  底部图例从左到右：${value.legend.map((l) => l[0]).join(' / ')}`,
          `统计：${s.layers} 层（${s.layerHeights}）；段 ${s.segments}（挤出 ${s.extrusionSegments} / 空驶 ${s.travelSegments}）`,
          `尺寸：X ${s.bounds.minX}~${s.bounds.maxX}，Y ${s.bounds.minY}~${s.bounds.maxY}，Z 0~${s.bounds.maxZ}`,
          `疑似悬垂层：${s.overhangLayers}`,
          `PNG 已写入：${value.outputPath}`,
        ]
        if (!value.imageRef) lines.push(`PNG data URI：data:image/png;base64,${value.pngBase64}`)
        blocks.push({ type: 'text', text: lines.join('\n') })
        return blocks
      },
    },
    async execute(args, exec) {
      let text = args.gcode_text
      let source = '(gcode_text)'
      if (args.gcode_path) {
        const abs = resolveOutputPath(args.gcode_path, sessionCwd(ctx, exec))
        if (!existsSync(abs)) throw new Error(`print3d_toolpath_map: G-code 不存在：${abs}`)
        text = readFileSync(abs, 'utf8')
        source = abs
      }
      if (!text) throw new Error('print3d_toolpath_map: 需要 gcode_path 或 gcode_text。')

      const result = buildToolpathMap(text, { size: args.size })
      const bytes = result.png
      const outputPath = args.output_path
        ? writeBinaryFile(ctx, exec, args.output_path, bytes)
        : writeBinaryToCategory('preview', `map-${Date.now()}.png`, bytes)

      let imageRef
      const attachments = ctx.get('attachments')
      if (attachments !== undefined) {
        try {
          imageRef = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'toolpath-map.png' })
        } catch (_) {
          // 附件存储不可用时退化为 base64
        }
      }
      // undefined 不是合法 JSON，直接挂上去会让工具返回值校验失败
      // （"value is not lossless JSON"）。只挂确实有值的字段。
      const out = {
        image: result.image,
        source,
        stats: result.stats,
        legend: result.legend,
        panels: result.panels,
        outputPath,
      }
      if (imageRef) out.imageRef = imageRef
      else out.pngBase64 = bytes.toString('base64')
      return out
    },
  }
}
