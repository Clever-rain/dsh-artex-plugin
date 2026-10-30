/**
 * 会话级启用开关（/artex on|off 与浏览器开关 chip 共用的状态层）。
 *
 * 语义：
 * - 按 owner 会话 id 记录「本会话是否允许调用 artex_* 工具」；缺省 true（装了插件就能用，向后兼容）。
 * - 显式关闭是唯一的持久状态：文件里只存 { sessionId: false }，删除/损坏一律回到默认开。
 * - 运行中的任务不受开关影响（它们的写回来自子会话，子会话有自己的会话 id，默认开）；
 *   开关只拦 owner 会话自己发起的新调用（见 index.js 的 tools.guard）。
 *
 * 存储：插件私有 JSON（profile 级，与全局任务索引同目录），同步读、防抖原子写。
 * 会话日志里的 /artex 命令行（command/run）是人类可见的切换记录；本文件是它的机器可读投影。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SAVE_DEBOUNCE_MS = 300

export function createSessionFlags({ filePath, logger } = {}) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('session flags 需要 filePath')
  }
  /** @type {Map<string, false>} 只记录显式关闭的会话。 */
  const disabled = new Map()
  let saveTimer = null

  // 同步加载：tools.guard 是同步检查，开关必须在任何工具执行前就绪。
  try {
    const raw = readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        if (value === false && typeof key === 'string' && key !== '') disabled.set(key, false)
      }
    }
  } catch {
    // 文件不存在/损坏：回到默认全开。
  }

  function flush() {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = join(dirname(filePath), `.flags-${process.pid}-${Date.now()}.tmp`)
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(disabled), null, 1) + '\n')
      renameSync(tmp, filePath)
    } catch (error) {
      logger?.warn?.(`artex: 会话开关落盘失败：${error?.message ?? error}`)
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      flush()
    }, SAVE_DEBOUNCE_MS)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  return {
    filePath,
    /** 缺省 true；只有显式 /artex off（或 chip 关闭）过的会话返回 false。 */
    isEnabled(sessionId) {
      const key = String(sessionId ?? '')
      if (key === '') return true
      return !disabled.has(key)
    },
    /** 显式设置；enabled=true 时从关闭名单里移除（回到默认）。 */
    set(sessionId, enabled) {
      const key = String(sessionId ?? '')
      if (key === '') return false
      if (enabled === false) disabled.set(key, false)
      else disabled.delete(key)
      scheduleSave()
      return disabled.has(key) === false
    },
    /** 测试/收尾用：立即落盘并取消待写的防抖。 */
    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      flush()
    },
    /** 当前显式关闭的会话数（诊断用）。 */
    get disabledCount() {
      return disabled.size
    },
  }
}

/**
 * tools.guard 的判定函数（纯、同步）：返回拒绝原因字符串，undefined = 放行。
 * 只拦 artex_* 工具；owner 会话关闭时全拦（含只读），语义保持一条线：
 * 「本会话已停用 ARTEX」，重新启用只有 /artex on 或点 composer 的开关。
 */
export function artexGateReason(toolName, enabled) {
  if (enabled !== false) return undefined
  if (typeof toolName !== 'string' || !toolName.startsWith('artex_')) return undefined
  return '本会话已通过 /artex off 停用 ARTEX 编排工具；如需使用，请用户输入 /artex on（或点输入框左侧的 🧭 开关）重新启用'
}
