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
