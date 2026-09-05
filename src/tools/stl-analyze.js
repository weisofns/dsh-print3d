import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { analyzeStlText } = require('../../scripts/stl_analyze.cjs')

export function makeStlAnalyzeTool(_ctx) {
  return {
    name: 'print3d_stl_analyze',
    description:
      '分析 ASCII STL 网格：包围盒、三角面数、体积、表面积、悬垂比例、边界边/非流形边统计与水密性。' +
      '把 .stl 文件的完整文本作为 stl_text 传入（先用 read 工具读取文件）。',
    parameters: {
      type: 'object',
      properties: {
        stl_text: { type: 'string', description: 'ASCII STL 文件的完整文本内容。' },
      },
      required: ['stl_text'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      return analyzeStlText(args.stl_text)
    },
  }
}
