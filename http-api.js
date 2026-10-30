/**
 * `/api/artex` 浏览器路由：插件自己的 client 半边（composer 开关 chip、会话行徽章）
 * 与 host 半边之间的数据通道。与 @local/dsh-artex-view 同一套做法：
 * Host 注册 webServer 路由，浏览器 fetch POST，只接受回环来源。
 *
 * op:
 * - state      { sessionId, cwd? }            → { ok, enabled, tasks: LightTask[] }
 * - setEnabled { sessionId, enabled: boolean } → { ok, enabled }
 *
 * LightTask 是轮询友好的最小摘要（不搬整张任务图）：id/description/status/live/settling/createdAt。
 * 写操作只有 setEnabled——开关是会话级偏好，不是任务操作；任务控制仍走 artex_* 工具。
 */

const MAX_TASKS = 20

function cleanId(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > 0 && text.length <= 200 ? text : ''
}

function cleanPath(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length === 0 || text.length > 1000) return ''
  // 控制字符直接按码位判定，避免正则里再嵌转义
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code === 0 || code === 10 || code === 13) return ''
  }
  // 只接受绝对路径（盘符 / UNC / POSIX 根）：相对串与任意 token 不值得建 workspace store（N36）。
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(text)) return ''
  return text
}

/** listTasks 行 → 轻量摘要；字段缺失一律容忍。 */
function lightTask(row) {
  const task = row?.task ?? row ?? {}
  return {
    id: String(task.id ?? ''),
    description: typeof task.description === 'string' && task.description !== ''
      ? task.description
      : (typeof task.goal === 'string' ? task.goal : ''),
    status: typeof task.status === 'string' ? task.status : 'unknown',
    live: row?.live === true,
    settling: row?.settling === true,
    createdAt: Number(task.createdAt) || 0,
  }
}

/**
 * @param {{ viewApi: { listTasks: Function }, flags: object }} deps
 * @returns (body: unknown) => Promise<object> 纯派发（HTTP 壳在 index.js）
 */
export function createArtexHttpDispatch({ viewApi, flags }) {
  return async function dispatch(body) {
    const op = typeof body?.op === 'string' ? body.op : ''
    const sessionId = cleanId(body?.sessionId)
    if (!sessionId) return { ok: false, error: 'missing sessionId' }
    switch (op) {
      case 'state': {
        if (typeof viewApi?.listTasks !== 'function') {
          return { ok: false, error: 'artex service unavailable' }
        }
        const rows = await viewApi.listTasks({ sessionId, cwd: cleanPath(body?.cwd) || undefined, limit: MAX_TASKS })
        const tasks = (Array.isArray(rows) ? rows : []).slice(0, MAX_TASKS).map(lightTask)
          .filter(task => task.id !== '')
        return { ok: true, enabled: flags.isEnabled(sessionId), tasks }
      }
      case 'setEnabled': {
        if (typeof body?.enabled !== 'boolean') return { ok: false, error: 'missing enabled (boolean)' }
        const enabled = flags.set(sessionId, body.enabled)
        return { ok: true, enabled }
      }
      default:
        return { ok: false, error: `unknown op: ${op}` }
    }
  }
}
