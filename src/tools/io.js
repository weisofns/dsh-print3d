import { isAbsolute, join, dirname } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

// 固定输出根目录：<用户目录>/Desktop/3Doutput，按类别分文件夹（stl / gcode / preview）。
const HOME = process.env.USERPROFILE || homedir()
export const OUTPUT_ROOT = join(HOME, 'Desktop', '3Doutput')

// 解析调用会话的工作区根目录（用于显式 output_path 的相对解析）。
export function sessionCwd(ctx, exec) {
  const id = exec && exec.agent && exec.agent.id
  const session = ctx.sessions && id ? ctx.sessions.get(id) : undefined
  const sandboxPolicy = ctx.get ? ctx.get('sandboxPolicy') : undefined
  if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
    try {
      const policy = session ? sandboxPolicy.resolve({ session }) : sandboxPolicy.resolve({})
      if (policy && policy.workspaceRoot) return policy.workspaceRoot
    } catch (_) {
      // 落到下面的回退
    }
  }
  if (session && session.header && session.header.cwd) return session.header.cwd
  return undefined
}

export function resolveOutputPath(path, cwd) {
  if (isAbsolute(path)) return path
  return join(cwd || process.cwd(), path)
}

// 写文本到 3Doutput/<category>/<filename>（自动建目录），返回绝对路径。
export function writeToCategory(category, filename, content) {
  const abs = join(OUTPUT_ROOT, category, filename)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return abs
}

// 写二进制到 3Doutput/<category>/<filename>。
export function writeBinaryToCategory(category, filename, bytes) {
  const abs = join(OUTPUT_ROOT, category, filename)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return abs
}

// 显式 output_path：写相对工作区（或绝对路径）。
export function writeTextFile(ctx, exec, relPath, content) {
  const abs = resolveOutputPath(relPath, sessionCwd(ctx, exec))
  writeFileSync(abs, content, 'utf8')
  return abs
}

export function writeBinaryFile(ctx, exec, relPath, bytes) {
  const abs = resolveOutputPath(relPath, sessionCwd(ctx, exec))
  writeFileSync(abs, bytes)
  return abs
}
