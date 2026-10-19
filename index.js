/**
 * DSH × ARTEX：把 ARTEX 的「双图 + planner/worker 事件驱动编排」搬进 DSH。
 *
 * 入口只做三件事：建立引擎、注册工具、把子会话事件喂给引擎做过程索引。
 * 真正的编排逻辑在 engine.js，图模型在 graph.js，角色纪律在 prompts.js。
 */

import { ArtexEngine, DEFAULTS } from './engine.js'
import { createTools } from './tools.js'

export const name = 'artex-orchestration'

/** Host 硬依赖：工具注册表 + 子会话（spawn/fork provider）。 */
export const inject = ['tools', 'subagents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config 插件行配置（见 cordis.patch.yml）
 */
export function apply(ctx, config = {}) {
  const logger = (() => {
    const target = ctx.logger ?? console
    return {
      warn: (...args) => {
        try {
          target.warn(...args)
        } catch {
          // 日志失败不影响编排。
        }
      },
    }
  })()

  const engine = new ArtexEngine({
    ctx,
    config: { ...DEFAULTS, ...(config || {}) },
    logger,
  })

  // 工具是全局注册的；角色边界由 execute 内的会话身份校验 + 子会话 toolFilter 双重保证。
  ctx.effect(() => {
    const disposers = createTools({ engine, config: engine.config }).map(definition => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 单个工具注销失败不阻断其余清理。
        }
      }
    }
  })

  // 把 worker 子会话的 tool/call、tool/result、assistant/message 索引成过程库，
  // 这样别的 work 能按关键字回看执行过程（ARTEX activity + trace 检索）。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    engine.handleSessionEvent(session, event)
  }))

  // 所有者会话关闭时停掉它启动的任务，避免无主任务继续烧模型调用。
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    void engine.onAgentDisposed(agent)
  }))

  // 插件卸载：中断所有任务并等待收敛。
  ctx.effect(() => () => {
    void engine.dispose()
  })
}
