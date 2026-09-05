import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(here, '..', 'skills')

// 每个技能对应 skills/<id>/SKILL.md；注册名加 print3d- 前缀避免与其它技能冲突。
const SKILL_IDS = ['slicing', 'gcode', 'modeling', 'analysis', 'diagnosis']

function parseSkillMarkdown(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) return { description: '', content: markdown.trim() }
  const front = match[1]
  const descMatch = front.match(/^description:\s*(.+)$/m)
  const description = descMatch ? descMatch[1].trim() : ''
  return { description, content: markdown.slice(match[0].length).trim() }
}

export function registerSkills(ctx) {
  for (const id of SKILL_IDS) {
    const markdown = readFileSync(join(skillsDir, id, 'SKILL.md'), 'utf8')
    const { description, content } = parseSkillMarkdown(markdown)
    const skill = {
      name: `print3d-${id}`,
      description,
      content,
      source: 'bundled',
      provider: 'dsh-print3d',
      invocation: { modelInvocable: true, userInvocable: false },
    }
    ctx.effect(() => ctx.skills.register(skill), `dsh-print3d: skill ${skill.name}`)
  }
}
