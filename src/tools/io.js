import { isAbsolute, join } from 'node:path'
import { writeFileSync } from 'node:fs'

// 从调用会话拿到工作目录（SessionHeader.cwd 是已验证的绝对路径）。
export function sessionCwd(ctx, exec) {
  const id = exec && exec.agent && exec.agent.id
  const session = ctx.sessions ? ctx.sessions.get(id) : undefined
  return session && session.header ? session.header.cwd : undefined
}

export function resolveOutputPath(path, cwd) {
  if (isAbsolute(path)) return path
  return join(cwd || process.cwd(), path)
}

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
