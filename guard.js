/**
 * 防线纯函数层：scope 匹配 / 目标审查 / 证据脱敏。
 *
 * 设计原则（Phantom 事件的直接教训）：
 * - 提示词级约束是写给模型看的，可能被注入或漂移绕过；这里提供的是
 *   **不经过模型的确定性校验**，供引擎在执行路径上调用。
 * - 全部纯函数，不依赖文件系统（engagement.js / evidence.js 才碰盘）。
 */

/* ---------------------------------------------------------------- scope */

/**
 * 规范化 scope 条目。支持四种写法：
 *   example.com        精确主机（子域不匹配；子域要 *.example.com 或显式列出）
 *   *.example.com      后缀匹配（含 example.com 本身）
 *   10.0.0.0/8         IPv4 CIDR
 *   10.0.0.7           精确 IPv4
 * 端口与 scheme 会被剥掉（http://host:8443/path → host）。
 */
export function normalizeScopeEntry(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return undefined
  let host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  // CIDR 必须在路径剥离之前判定：'/' 在这里是掩码不是路径。
  const cidr = host.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (cidr) {
    const bits = Number(cidr[2])
    if (bits >= 0 && bits <= 32 && ipv4ToInt(cidr[1]) !== undefined) {
      return { kind: 'cidr', value: ipv4ToInt(cidr[1]), bits }
    }
    return undefined
  }
  host = host.split('/')[0]
  host = host.replace(/:\d+$/, '')
  if (!host) return undefined
  if (host.startsWith('*.')) return { kind: 'suffix', value: host.slice(2) }
  if (ipv4ToInt(host) !== undefined) return { kind: 'ip', value: host }
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('.')) return { kind: 'host', value: host }
  return undefined
}

export function parseScope(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeScopeEntry)
    .filter(Boolean)
}

function ipv4ToInt(text) {
  const parts = String(text).split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    value = value * 256 + n
  }
  return value >>> 0
}

/** 单个目标（host/ip）是否落在 scope 内。 */
export function matchScopeEntry(entries, targetRaw) {
  const target = String(targetRaw ?? '').trim().toLowerCase()
  if (!target) return false
  const targetIp = ipv4ToInt(target)
  for (const entry of entries) {
    switch (entry.kind) {
      case 'suffix':
        if (target === entry.value || target.endsWith(`.${entry.value}`)) return true
        break
      case 'host':
        if (target === entry.value) return true
        break
      case 'ip':
        if (target === entry.value) return true
        break
      case 'cidr':
        if (targetIp !== undefined) {
          const shift = 32 - entry.bits
          const mask = entry.bits === 0 ? 0 : (~0 << shift) >>> 0
          if (((targetIp & mask) >>> 0) === ((entry.value & mask) >>> 0)) return true
        }
        break
      default:
        break
    }
  }
  return false
}

/* ------------------------------------------------------------ extraction */

const URL_RE = /\b(?:https?|wss?|ftp):\/\/([a-z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// 裸域名：至少两段、常见公网 TLD；避免把 file.js / data.json 这类文件名当域名。
const DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|cn|edu|gov|mil|info|biz|dev|app|cloud|site|top|xyz|me|cc|tv|hk|tw|jp|kr|ru|de|uk|fr|au|ca|in|br|za|sg|us|eu|ai))\b/gi

/**
 * 从工具调用文本（命令行、参数 JSON）里提取网络目标。
 * 刻意保守：只提取 URL 主机、IPv4、常见 TLD 的裸域名；
 * 提不出的（如管道内动态构造）归 scope 提示词纪律兜底。
 */
export function extractTargets(text) {
  const out = new Set()
  const source = String(text ?? '')
  for (const match of source.matchAll(URL_RE)) {
    const host = String(match[1] || '').toLowerCase()
    if (host) out.add(host)
  }
  for (const match of source.matchAll(IPV4_RE)) {
    if (ipv4ToInt(match[0]) !== undefined) out.add(match[0])
  }
  for (const match of source.matchAll(DOMAIN_RE)) {
    out.add(String(match[1]).toLowerCase())
  }
  return [...out]
}

/** 内网/回环地址永远不算越界：它们不构成出网边界突破。 */
export function isPrivateTarget(target) {
  if (String(target).toLowerCase() === 'localhost') return true
  const ip = ipv4ToInt(target)
  if (ip === undefined) return false
  const a = (ip >>> 24) & 255
  const b = (ip >>> 16) & 255
  if (a === 10) return true
  if (a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 0) return true
  return false
}

/**
 * 引擎级 scope 校验：给定 scope 列表与一段工具调用文本，
 * 返回提取到的目标与越界目标。scope 为空 = 未启用（ok 恒真）。
 */
export function scopeCheck(scopeList, text) {
  const entries = parseScope(scopeList)
  if (entries.length === 0) return { enabled: false, targets: [], misses: [], ok: true }
  const targets = extractTargets(text).filter(t => !isPrivateTarget(t))
  const misses = targets.filter(t => !matchScopeEntry(entries, t))
  return { enabled: true, targets, misses, ok: misses.length === 0 }
}

/* -------------------------------------------------------------- goal lint */

/**
 * 目标审查的高风险词表：只标"犯罪意图"信号，不标正常渗透术语
 * （"渗透/漏洞/提权"是合法红队语言，标了等于把框架自己禁掉）。
 * 每个条目：pattern + category + 展示词。
 */
export const GOAL_RISK_PATTERNS = [
  { category: 'extortion', re: /勒索|赎金|ransom|extort/i, label: '勒索/敲诈' },
  { category: 'extortion', re: /勒索信|ransom\s*note/i, label: '勒索信生成' },
  { category: 'payload', re: /加密器|encryptor\b|locker\b/i, label: '加密器/锁文件载荷' },
  { category: 'payload', re: /勒索软件|ransomware/i, label: '勒索软件' },
  { category: 'destruction', re: /擦除数据|毁数据|wiper|破坏数据库/i, label: '破坏性动作' },
  { category: 'evasion_payload', re: /免杀\b|绕过\s*(edr|杀软|杀毒)|bypass\s*(edr|defender)|kill\s*(edr|av\b)/i, label: '免杀/杀软对抗载荷' },
  { category: 'botnet', re: /僵尸网络|botnet|ddos\s*(攻击|平台)|肉鸡/i, label: '僵尸网络/DDoS' },
  { category: 'unauthorized', re: /未授权(的|访问|入侵)|without\s+authorization|unauthorized\s+(access|intrusion)/i, label: '显式未授权' },
  { category: 'theft_for_sale', re: /拖库|出售数据|数据贩卖|sell(ing)?\s+(stolen\s+)?data/i, label: '数据窃取变现' },
]

/**
 * 审查 goal/goals/constraints 文本。返回命中列表 [{category, label, text}]。
 */
export function lintGoalTexts(texts) {
  const hits = []
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    const body = String(text ?? '')
    if (!body) continue
    for (const rule of GOAL_RISK_PATTERNS) {
      if (rule.re.test(body)) hits.push({ category: rule.category, label: rule.label, sample: body.slice(0, 80) })
    }
  }
  // 同 category 去重，报错信息不刷屏。
  const seen = new Set()
  return hits.filter(h => (seen.has(h.category) ? false : (seen.add(h.category), true)))
}

/* --------------------------------------------------------------- redact */

/**
 * 证据脱敏规则：只打值、留键与上下文，保持"证据链可核对"。
 * 每条规则把敏感值替换成保留前 4 位的掩码。
 */
const REDACT_RULES = [
  // key=value / key: value 形态
  /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|session[_-]?key|client[_-]?secret)\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi,
  /((?:authorization|x-api-key|x-auth-token)\s*[:=]\s*["']?(?:bearer\s+|basic\s+|token\s+)?)([^\s"',;&]{4,})/gi,
  /((?:^|\s)(?:token|jwt|credential)\s*[:=]\s*["']?)([a-z0-9._~+/=-]{8,})/gim,
  /(cookie\s*[:=]\s*["']?)([^\n]{8,})/gi,
]
const STANDALONE_RULES = [
  /\bAKIA[0-9A-Z]{16}\b/g,                       // AWS access key id
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,                  // OpenAI 风格密钥
  /\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g,             // GitHub token
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g,           // Slack token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

function maskValue(value) {
  const text = String(value)
  if (text.length <= 4) return '****'
  return `${text.slice(0, 4)}…[已脱敏 ${text.length} 字符]`
}

/** 证据文本脱敏（引擎写回边界调用）。非字符串原样返回。 */
export function redactText(input) {
  if (typeof input !== 'string' || input.length === 0) return input
  let out = input
  for (const re of REDACT_RULES) {
    out = out.replace(re, (_all, prefix, value) => `${prefix}${maskValue(value)}`)
  }
  for (const re of STANDALONE_RULES) {
    out = out.replace(re, (all) => maskValue(all))
  }
  return out
}
