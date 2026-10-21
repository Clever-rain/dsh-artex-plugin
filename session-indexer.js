/**
 * 子会话事件索引：tool/call、tool/result、assistant/message → 过程库与 usage。
 */

import { oneLine, textOf } from './util.js'

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
