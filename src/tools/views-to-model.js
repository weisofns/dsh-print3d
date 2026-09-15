import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { writeToCategory, writeTextFile } from './io.js'

const require = createRequire(import.meta.url)
const { viewsToStl } = require('../../scripts/views_to_stl.cjs')

export function makeViewsToModelTool(ctx) {
  return {
    name: 'print3d_views_to_model',
    description:
      'CAD 三视图 → 3D 模型：把正视图/俯视图/侧视图的剪影各自沿视线方向挤出后求交集（视觉凸包），生成可打印的 STL。' +
      '两种输入：给 drawing_path（一张图上排好三视图，自动切分并按轴长一致性自动认定正/俯/侧），或分别给 front/top/side 三张图。' +
      '对棱柱类和沿轴贯穿的孔可精确还原；被遮挡的内部特征会丢失（视觉凸包只会偏保守）。默认写到 桌面/3Doutput/stl/。',
    parameters: {
      type: 'object',
      properties: {
        drawing_path: { type: 'string', description: '单张三视图图纸路径（自动切分，优先于 front/top/side）。' },
        front_path: { type: 'string', description: '正视图（看 X-Z 面）图片路径。' },
        top_path: { type: 'string', description: '俯视图（看 X-Y 面）图片路径。' },
        side_path: { type: 'string', description: '侧视图（看 Y-Z 面）图片路径。' },
        width_mm: { type: 'number', description: '零件 X 方向实际宽度 mm（默认 60），另两轴按视图纵横比推出。' },
        voxel_mm: { type: 'number', description: '体素边长 mm（默认 0.8，越小越精细但 STL 越大；建议 >= 喷嘴直径的一半）。' },
        gap_ratio: { type: 'number', description: '单图切分时的视图间距阈值，占图纸长边比例（默认 0.03）。切不开就调小。' },
        max_pixels: { type: 'number', description: '图纸解码后最长边像素（默认 400）。' },
        invert: { type: 'boolean', description: '反转：默认 false（亮部=实体）；true 表示暗部=实体。' },
        output_path: { type: 'string', description: '输出 .stl 路径（默认 桌面/3Doutput/stl/views-model.stl）。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const warn = value.ratioErr > 0.05 ? `（注意：侧视图比例偏差 ${(value.ratioErr * 100).toFixed(1)}%）` : ''
        return [{
          type: 'text',
          text: `三视图重建完成：${value.Xmm.toFixed(1)}×${value.Ymm.toFixed(1)}×${value.Zmm.toFixed(1)}mm，` +
            `体素 ${value.nx}×${value.ny}×${value.nz} ${warn} → ${value.outputPath}`,
        }]
      },
    },
    async execute(args, exec) {
      const paths = args.drawing_path
        ? ['drawing_path']
        : ['front_path', 'top_path', 'side_path']
      for (const k of paths) {
        if (!existsSync(args[k])) throw new Error(`print3d_views_to_model: 文件不存在：${args[k]}`)
      }
      const { output_path, ...params } = args
      const r = await viewsToStl({
        ...params,
        drawingPath: args.drawing_path,
        frontPath: args.front_path,
        topPath: args.top_path,
        sidePath: args.side_path,
      })
      const outputPath = output_path
        ? writeTextFile(ctx, exec, output_path, r.stl)
        : writeToCategory('stl', 'views-model.stl', r.stl)
      return {
        outputPath,
        Xmm: r.Xmm, Ymm: r.Ymm, Zmm: r.Zmm,
        nx: r.nx, ny: r.ny, nz: r.nz,
        voxelCount: r.count, ratioErr: r.ratioErr,
        sizeBytes: r.sizeBytes,
      }
    },
  }
}
