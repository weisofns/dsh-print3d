import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolveOutputPath, sessionCwd } from './io.js'

const require = createRequire(import.meta.url)
const { describeImage } = require('../../scripts/ollama_vision.cjs')

export function makeVisionDescribeTool(ctx) {
  return {
    name: 'print3d_image_describe',
    description:
      '让本地视觉模型（Ollama qwen2.5vl）描述一张图片，返回结构化文字：物体/几何类型/长宽比/孔洞/明暗/建议建模方式。' +
      '本地文本模型没有视觉能力时，用它来「看」图，再决定用 print3d_image_to_stl 还是 print3d_parametric_print。' +
      '需要本机 Ollama 正在运行。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片文件路径（绝对，或相对工作区）。' },
        question: { type: 'string', description: '要问视觉模型的具体问题（默认：3D 打印结构分析）。' },
        model: { type: 'string', description: 'Ollama 视觉模型名（默认 qwen2.5vl:7b；可选 qwen2.5vl:3b 更快）。' },
      },
      required: ['image_path'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: `图片识别结果：\n${value.text}` }]
      },
    },
    async execute(args, exec) {
      const imageAbs = resolveOutputPath(args.image_path, sessionCwd(ctx, exec))
      if (!existsSync(imageAbs)) throw new Error(`print3d_image_describe: 图片不存在：${imageAbs}`)
      const text = await describeImage({ imagePath: imageAbs, question: args.question, model: args.model })
      return { text, model: args.model || 'qwen2.5vl:7b', imagePath: imageAbs }
    },
  }
}
