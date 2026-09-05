import { isAbsolute, join } from 'node:path'
import { writeFileSync } from 'node:fs'

// 解析调用会话的工作区根目录。优先走 DSH 官方的 sandboxPolicy 机制
// （resolve({ session }).workspaceRoot，与 write 工具同源），
// 保证落盘到会话工作区，而不是只读的宿主进程 cwd。
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
