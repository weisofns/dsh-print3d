import { isAbsolute, join } from 'node:path'
import { writeFileSync } from 'node:fs'

// 从调用会话拿到工作目录（SessionHeader.cwd 是已验证的绝对路径）。
export function sessionCwd(ctx, exec) {
  let id = exec && exec.agent && exec.agent.id
  if (!id) {
    // exec.agent 可能缺省，回退到当前发起工具调用的 agent
    const agents = ctx.get ? ctx.get('agents') : undefined
    const initiator = agents ? agents.currentInitiator() : undefined
    id = initiator ? initiator.id : undefined
  }
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
