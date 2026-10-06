/**
 * print3d-toolset-gate —— 工具集闸门（preset 级）。
 *
 * 用途：能力有限的本地小模型（8B 级）在工具一多时就会幻觉（编造路径、跳过工具手写代码、
 * 声称「配置文件缺失」）。靠 persona 劝说效果有限，正规做法是用 DSH 的工具可见性机制
 * `ctx.tools.restrict({ allow })` 在 **preset scope** 内把全局工具裁到核心集：
 * 站在该 preset 下的每一个 agent 都只看得见 allow 里的工具，清单外的全局工具直接不可见
 * （不是「被禁止调用」，而是模型根本看不到，因此不会尝试）。
 *
 * 用法（放进 agent preset 的 composition）：
 *   - id: print3d-toolset-gate
 *     name: 'dsh-print3d/gate'
 *     config:
 *       allow:
 *         - print3d_parametric_print
 *         …
 *
 * 未配置 allow（或为空）时本模块不做任何事，preset 保持全量工具 —— 云端大模型用不到它。
 */

export const name = 'print3d-toolset-gate'

// 必须在 `tools` 就绪后再 restrict，否则注册表还没建好。
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const raw = Array.isArray(config.allow) ? config.allow : []
  const allow = raw.filter((n) => typeof n === 'string' && n.trim() !== '')
  if (allow.length === 0) return

  ctx.effect(() => {
    try {
      return ctx.tools.restrict({ allow })
    } catch (err) {
      // restrict 对未知名/空清单会失败。宁可退回全量工具，也不能让 preset 挂载失败
      // —— preset 挂不上等于这个 agent 直接不可用，代价远大于模型看到几个多余工具。
      const msg = err && err.message ? err.message : String(err)
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(`print3d-toolset-gate: restrict 未生效（退回全量工具）：${msg}`)
      }
      return () => {}
    }
  }, 'dsh-print3d: toolset gate')
}
