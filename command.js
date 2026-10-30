/**
 * `/artex on | off | status` 人类命令（Host `commands` 服务）。
 *
 * 定位：会话级启用开关的人类入口。命令行本身（command/run，含参数）落在会话
 * 日志里，就是「这个会话动过 ARTEX 开关」的持久可见标记——不需要额外发明事件。
 *
 * - on/off：切换本会话 artex_* 工具门禁（写 flags，落盘）。
 * - status（或无参数）：报告开关状态 + 本会话内存中任务的简表。
 * 关闭只拦新调用；已在运行的任务由子会话驱动，不受影响（见 flags.js 顶部说明）。
 */

const VERBS = new Set(['on', 'off', 'status'])

/** 本会话内存中任务的按状态计数（live runtime，不含磁盘历史——完整列表看 ARTEX 会话视图）。 */
function liveSummary(engine, sessionId) {
  const counts = {}
  let live = 0
  for (const rt of engine.tasks.values()) {
    const task = rt?.task
    if (!task || String(task.ownerSession) !== String(sessionId)) continue
    counts[task.status] = (counts[task.status] || 0) + 1
    if (rt.finished !== true) live += 1
  }
  return { counts, live }
}

function statusText(flags, engine, sessionId) {
  const enabled = flags.isEnabled(sessionId)
  const { counts, live } = liveSummary(engine, sessionId)
  const states = Object.entries(counts).map(([status, n]) => `${status} ×${n}`).join('，') || '无'
  return [
    `ARTEX：本会话${enabled ? '**已启用**' : '**已停用**'}（${enabled ? 'artex_* 工具可用' : 'artex_* 工具被门禁拦截'}）`,
    `本会话任务：${states}${live > 0 ? `；其中 ${live} 个仍在运行` : ''}`,
    enabled ? '停用：输入 `/artex off`（运行中的任务不受影响，仅拦新调用）。' : '启用：输入 `/artex on`。',
  ].join('\n')
}

/**
 * @param {{ engine: object, flags: object }} deps
 * @returns CommandDefinition（见 @deepseek-ai/dsh-commands）
 */
export function createArtexCommand({ engine, flags }) {
  return {
    name: 'artex',
    description: '本会话的 ARTEX 编排开关：/artex on 启用，/artex off 停用（拦本会话的 artex_* 新调用），/artex status 查看状态',
    input: { hint: 'on | off | status' },
    // 参数（on/off）写进 command/run：会话日志里的开关切换记录。
    recordInput: true,
    async handler({ agent, rawInput }) {
      const sessionId = String(agent?.id ?? '')
      if (sessionId === '') {
        return { kind: 'error', text: '无法确定当前会话，开关未生效。' }
      }
      const verb = String(rawInput ?? '').trim().toLowerCase()
      if (verb === '' || verb === 'status') {
        return { kind: 'success', text: statusText(flags, engine, sessionId) }
      }
      if (!VERBS.has(verb)) {
        return { kind: 'error', text: `未知参数「${verb}」。用法：/artex on | off | status` }
      }
      const enabled = verb === 'on'
      flags.set(sessionId, enabled)
      return {
        kind: 'success',
        text: enabled
          ? 'ARTEX 已在本会话启用：artex_* 工具恢复可用。'
          : 'ARTEX 已在本会话停用：本会话新的 artex_* 调用会被拦截（运行中的任务不受影响）。输入 /artex on 重新启用。',
      }
    },
  }
}
