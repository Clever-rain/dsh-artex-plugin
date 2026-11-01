/**
 * 子会话事件索引：tool/call、tool/result、assistant/message → 过程库与 usage。
 * 同时承担 P0-1 引擎级 scope 越界检测：worker 的宿主工具调用里提取网络目标，
 * 越 allowed_targets 即触发引擎处置（与提示词约束互补，不依赖模型自觉）。
 */

import { oneLine, textOf } from './util.js'
import { scopeCheck } from './guard.js'

export function handleSessionEvent(engine, session, event) {
    try {
      const sessionId = session?.header?.id ?? session?.id
      if (!sessionId) return
      const role = engine.roles.get(sessionId)
      if (!role) return
      const rt = engine.tasks.get(role.taskId)
      if (!rt || rt.finished) return
      const data = event?.data
      if (!data) return

      // 用量统计对所有角色生效（planner 与 worker 都计入任务成本）。
      if (event.type === 'assistant/message') {
        engine.recordUsage(rt, role, data.usage)
        if (role.role !== 'worker') return
        const text = textOf(data.message?.content)
        if (!text) return
        engine.addActivity(rt, {
          intentId: role.intentId,
          worker: 'worker',
          kind: 'text',
          summary: oneLine(text, 160),
          detail: text,
        })
        return
      }

      if (role.role !== 'worker') return

      if (event.type === 'tool/call') {
        const name = String(data.name || '')
        if (name.startsWith('artex_')) return // 写回已单独记录，不重复索引
        role.pending.set(data.callId, { name, arguments: data.arguments })
        // P0-1 引擎级 scope 检测：提取调用里的网络目标（URL 主机/IP/域名），
        // 命中 allowed_targets 之外即处置。检测在调用事件上发生（执行前一刻），
        // 但 DSH 不给插件抢占拦截能力，处置 = 记录/提醒/停任务。
        const policy = rt.task.policy || {}
        if (policy.allowedTargets?.length > 0 && engine.scopeEnforcement(rt.task) !== 'off') {
          const verdict = scopeCheck(policy.allowedTargets, `${name} ${String(data.arguments ?? '')}`)
          if (verdict.ok === false) engine.flagScopeViolation(rt, role, name, verdict)
        }
        return
      }

      if (event.type === 'tool/result') {
        const callId = data.message?.toolCallId ?? data.callId
        const pending = role.pending.get(callId)
        if (!pending) return
        role.pending.delete(callId)
        const detail = textOf(data.message?.content)
        engine.addActivity(rt, {
          intentId: role.intentId,
          worker: 'worker',
          kind: 'step',
          tool: pending.name,
          summary: `${pending.name} ${oneLine(pending.arguments, 140)}`,
          detail,
          isError: data.message?.isError === true || data.error !== undefined,
        })
      }
    } catch (error) {
      engine.logger.warn?.(`[artex] session event index failed: ${error?.message || error}`)
    }
  }

  /** 累计子会话的 provider usage，作为任务成本口径（输出/输入 token 与调用次数）。 */
