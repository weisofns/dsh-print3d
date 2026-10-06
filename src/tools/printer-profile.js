import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DEFAULTS, PROFILE_PATH, loadProfile, saveProfile } = require('../../scripts/printer_profile.cjs')

function summary(p) {
  return [
    `打印机：${p.name}（${p.material} / ${p.firmware}）`,
    `挤出：喷嘴 ${p.nozzle}mm · 耗材 ${p.filament_diameter}mm`,
    `床：${p.bed_width}×${p.bed_depth}×${p.bed_height}mm`,
    `切片后端：${p.slicer}`,
    `工艺：层高 ${p.layer_height}mm（首层 ${p.first_layer_height}）· ${p.nozzle_temp}/${p.bed_temp}℃ · ${p.speed}mm/s · 填充 ${p.infill}% · 墙 ${p.walls} · 顶底 ${p.top_bottom_layers} 层 · 底边 ${p.brim_mm}mm`,
    `配置文件：${PROFILE_PATH}`,
  ].join('\n')
}

export function makePrinterProfileTool(_ctx) {
  return {
    name: 'print3d_printer_profile',
    description:
      '读取/修改本机打印机参数（单一数据源）。这份配置是 print3d_slice / print3d_parametric_print 的默认值来源，' +
      '优先级：工具入参 > 本配置 > 内置默认。用户还可用可视化窗口 tools\\printer-setup.bat 编辑同一份文件。' +
      'action=get 读取；action=set 配合 values 修改（如 {"nozzle":0.6,"nozzle_temp":215}）；action=reset 恢复默认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'reset'], description: 'get=读取（默认）/ set=修改 / reset=恢复内置默认。' },
        values: {
          type: 'object',
          description: 'action=set 时的新值，键名：name, material, firmware, nozzle, filament_diameter, bed_width, bed_depth, bed_height, slicer, prusa_slicer_path, cura_engine_path, layer_height, first_layer_height, nozzle_temp, bed_temp, speed, travel_speed, infill, walls, top_bottom_layers, brim_mm。',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const head = value.action === 'set' ? '已更新打印机配置：' : (value.action === 'reset' ? '已恢复内置默认：' : '当前打印机配置：')
        return [{ type: 'text', text: `${head}\n${value.summary}` }]
      },
    },
    async execute(args) {
      const action = args.action || 'get'
      let profile
      if (action === 'set') {
        const values = args.values || {}
        if (!Object.keys(values).length) throw new Error('print3d_printer_profile: action=set 需要提供 values。')
        profile = saveProfile(values)
      } else if (action === 'reset') {
        profile = saveProfile({ ...DEFAULTS })
      } else {
        profile = loadProfile()
      }
      return { action, profile, summary: summary(profile) }
    },
  }
}
