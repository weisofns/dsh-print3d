import { registerSkills } from './skills.js'
import { makeToolDefinitions } from './tools/index.js'
import { registerPersona } from './persona.js'

export const name = 'dsh-print3d'

// 硬依赖：tools/skills 注册表、sessions（拿会话 cwd 用于落盘）、systemPrompt（注册精简 persona 段）。
// 附件存储（attachments）用 ctx.get 可选读取，缺了 gcode_render 就退化为 base64。
export const inject = ['tools', 'skills', 'sessions', 'systemPrompt']

export function apply(ctx) {
  for (const definition of makeToolDefinitions(ctx)) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-print3d: tool ${definition.name}`)
  }
  registerSkills(ctx)
  registerPersona(ctx)
}
