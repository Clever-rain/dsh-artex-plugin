/** 共享小工具。 */

export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, 2 ** 31 - 1))))

/** 从 provider 的 content blocks 里提取纯文本。 */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** 压成一行，供活动日志摘要使用。 */
export function oneLine(value, max = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Provider / 子会话错误归类：决定重试退避策略与是否值得再试。 */
export function classifyError(error) {
  const text = String(error?.message || error || '').toLowerCase()
  if (/429|rate.?limit|too many requests|quota|额度/.test(text)) return 'rate_limit'
  if (/context.{0,16}(length|window|overflow)|too long|max(imum)?.?context|prompt is too long/.test(text)) return 'context'
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|overloaded/.test(text)) return 'server'
  if (/econn|etimedout|esockettimedout|network|socket hang|fetch failed|enotfound|eai_again/.test(text)) return 'network'
  return 'unknown'
}

/** 分类退避（毫秒）：rate_limit 长冷却、server/network 指数、其余短线性。 */
export function retryBackoffMs(category, attempt) {
  const step = Math.max(1, attempt)
  if (category === 'rate_limit') return Math.min(120000, 30000 * step)
  if (category === 'server' || category === 'network') return Math.min(60000, 5000 * 2 ** (step - 1))
  return Math.min(5000, Math.max(200, 800 * step))
}

/** context 类错误重试同一提示没有意义，快速失败把现场留给收尾路径。 */
export function isRetryWorthless(category) {
  return category === 'context'
}

/** 子会话 stopReason 别名归一化：不同 provider 措辞收敛到内部四种语义。 */
export function normalizeStopReason(raw) {
  const text = String(raw || '').toLowerCase().trim()
  switch (text) {
    case 'aborted':
    case 'abort':
    case 'interrupted':
    case 'interrupt':
    case 'cancelled':
    case 'canceled':
      return 'aborted'
    case 'max-tokens':
    case 'max_tokens':
    case 'maxtokens':
    case 'length':
      return 'max-tokens'
    case 'timeout':
    case 'timedout':
    case 'timed-out':
      return 'timeout'
    case 'error':
    case 'failed':
    case 'errored':
      return 'error'
    default:
      return text || 'completed'
  }
}
