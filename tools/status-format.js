/**
 * 上下文治理：状态/态势的摘要化渲染、全量落盘、输出硬上限。
 *
 * 设计目标：
 * - 工具默认只回「有界摘要」，完整运行态落 `<outDir>/*.json`，会话里只留指针；
 * - 细节仍可按需取：把落盘文件交给 read/grep，或 artex_node_detail 按节点 id 取；
 * - planner / worker / 报告链路不受影响（它们读的是服务端投影与任务图，不走这里）。
 *
 * 本模块是纯函数 + 文件写入，不依赖 engine，便于单测。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** `artex_task_status.sections` 允许的块。 */
export const STATUS_SECTIONS = ['goals', 'intents', 'facts', 'usage', 'hints', 'todos', 'scope', 'findings']

/** `artex_graph_overview.sections` 允许的块（映射到 overview 顶层键）。 */
export const OVERVIEW_SECTIONS = ['goals', 'intents', 'facts', 'findings', 'hints', 'todos', 'stats', 'pending_approvals', 'scope']

/** status 摘要默认硬上限（字符）。 */
export const STATUS_MAX_CHARS = 4000

/** graph_overview 默认硬上限（字符）。 */
export const OVERVIEW_MAX_CHARS = 6000

/** 单条标题/摘要的默认裁剪长度。 */
const CLIP = 100

export function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** 压成一行并按码点（code point）裁剪；标题/目标/提示这类短文本。码点语义避免把 emoji/补充平面字符切成孤代理。 */
export function clip(value, max = CLIP) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const points = [...text]
  return points.length > max ? `${points.slice(0, max).join('')}…` : text
}

/** 参数里的 sections 既接受数组也接受逗号分隔字符串。 */
export function sectionList(value, allowed) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(',') : []
  const picked = raw.map(item => String(item).trim().toLowerCase()).filter(item => allowed.includes(item))
  return picked.length > 0 ? [...new Set(picked)] : undefined
}

/**
 * 输出硬上限：超限时优先在换行处截断，并追加一句说明。
 * @param {string} text 待返回文本
 * @param {number} maxChars 字符上限
 * @param {string} [note] 截断说明（不含换行，调用方给纯说明；空串则不加）
 * @returns {{text: string, truncated: boolean, bytes: number, chars: number}}
 */
export function capText(text, maxChars, note = '') {
  const points = [...String(text ?? '')]
  const limit = Math.max(1, Math.trunc(maxChars))
  if (points.length <= limit) {
    const intact = points.join('')
    return { text: intact, truncated: false, bytes: Buffer.byteLength(intact, 'utf8'), chars: points.length }
  }
  const suffix = note ? `\n${note}` : ''
  const budget = Math.max(0, limit - [...suffix].length)
  let cutPoints = points.slice(0, budget)
  const lastLine = cutPoints.lastIndexOf('\n')
  if (lastLine > budget * 0.6) cutPoints = cutPoints.slice(0, lastLine)
  let outPoints = [...cutPoints, ...suffix]
  if (outPoints.length > limit) outPoints = outPoints.slice(0, limit)
  const out = outPoints.join('')
  return { text: out, truncated: true, bytes: Buffer.byteLength(out, 'utf8'), chars: outPoints.length }
}

/**
 * 原子写 JSON（同目录临时文件 + rename；rename 失败时退化为直接覆写）。
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function writeJsonAtomic(dir, name, value) {
  const target = join(dir, name)
  const body = `${JSON.stringify(value, null, 2)}\n`
  const bytes = Buffer.byteLength(body, 'utf8')
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${name}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
  try {
    await writeFile(tmp, body, 'utf8')
  } catch (error) {
    // 写临时文件本身就失败：清掉可能的半成品，避免目录里留 .tmp 垃圾。
    await unlink(tmp).catch(() => {})
    throw error
  }
  try {
    await rename(tmp, target)
  } catch {
    // Windows 上目标文件被并发读/占位时 rename 可能失败，退回直接覆盖。
    await writeFile(target, body, 'utf8')
    await unlink(tmp).catch(() => {})
  }
  return { path: target, bytes }
}

/* ------------------------------------------------------------ status view */

function stateCounts(snapshot) {
  const byState = snapshot?.intents?.by_state
  return byState && typeof byState === 'object' ? byState : {}
}

function factsByOutcome(snapshot) {
  const byOutcome = snapshot?.digest?.facts?.by_outcome
  return byOutcome && typeof byOutcome === 'object' ? byOutcome : undefined
}

function hintText(hint) {
  if (hint && typeof hint === 'object') return hint.text ?? hint.summary ?? ''
  return hint
}

/**
 * 渲染 `artex_task_status` 的单任务摘要。
 *
 * @param {object} snapshot `engine.status(taskId)` 的返回值（字段可能缺失，需容错）
 * @param {{findingsLimit?: number, sections?: string[]}} [options]
 * @returns {string} 不含落盘指针行的摘要文本
 */
export function formatStatusSummary(snapshot, options = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const findingsLimit = clampInt(options.findingsLimit, 10, 0, 50)
  const selected = sectionList(options.sections, STATUS_SECTIONS)
  const sections = new Set(selected || ['goals', 'findings'])
  const lines = []

  const goalList = Array.isArray(snap.goals) ? snap.goals : []
  const met = goalList.filter(goal => goal && goal.status === 'met').length
  const byState = stateCounts(snap)
  const findingsTotal = Number.isFinite(snap.findings_total)
    ? snap.findings_total
    : Array.isArray(snap.findings) ? snap.findings.length : 0
  const verified = snap.findings_by_status?.verified
  const flags = []
  if (snap.live) flags.push('live')
  if (snap.settling) flags.push('收尾中')
  if (snap.campaign) flags.push(`战役 ${snap.campaign}`)
  if (snap.engagement?.id) flags.push(`交战 ${snap.engagement.id}`)
  const head = `${snap.task_id} [${snap.status}] (${snap.mode || 'objective'}/${snap.view_mode || 'planner'})`
  lines.push(flags.length > 0 ? `${head} · ${flags.join(' · ')}` : head)
  lines.push([
    `轮次 ${snap.rounds ?? 0}`,
    `goals ${met}/${goalList.length}`,
    `意图 ${Object.keys(byState).length > 0 ? JSON.stringify(byState) : '{}'}`,
    `事实 ${snap.facts ?? 0}`,
    `发现 ${findingsTotal}${verified ? `（verified ${verified}）` : ''}`,
    `资源 ${snap.resources ?? 0}`,
  ].join(' · '))

  const runLine = [
    `用时 ${Math.round((Number(snap.elapsed_ms) || 0) / 1000)}s`,
    `pending_approvals ${Array.isArray(snap.pending_approvals) ? snap.pending_approvals.length : 0}`,
  ]
  if (snap.brief_round) runLine.push(`brief@r${snap.brief_round}`)
  else if (snap.brief) runLine.push('brief')
  if (snap.analysis_round) runLine.push(`analysis@r${snap.analysis_round}`)
  const violations = Number(snap.scope?.violations) || 0
  if (violations > 0) runLine.push(`⚠越界 ${violations}`)
  lines.push(runLine.join(' · '))

  // 审批门必须可见：无论 sections 是否包含，都列前 3 条。
  const approvals = Array.isArray(snap.pending_approvals) ? snap.pending_approvals : []
  if (approvals.length > 0) {
    for (const approval of approvals.slice(0, 3)) {
      lines.push(`- 待审批 #${approval?.id} ${clip(approval?.summary, CLIP)}`)
    }
    if (approvals.length > 3) lines.push(`…还有 ${approvals.length - 3} 条待审批`)
  }

  if (snap.finish_detail) lines.push(`结束原因：${clip(snap.finish_detail, 200)}`)

  if (sections.has('goals')) {
    const unmet = goalList.filter(goal => goal && goal.status !== 'met')
    for (const goal of unmet.slice(0, 5)) {
      lines.push(`- [goal#${goal.id}] ${goal.status || 'open'} ${clip(goal.text, 120)}`)
    }
    if (unmet.length > 5) lines.push(`…还有 ${unmet.length - 5} 条未达成`)
  }

  if (sections.has('intents')) {
    const ordered = ['open', 'running', 'failed', 'blocked', 'exhausted', 'done', 'blueprint', 'stopped']
    const parts = []
    for (const state of ordered) {
      if (byState[state] !== undefined) parts.push(`${state} ${byState[state]}`)
    }
    for (const state of Object.keys(byState)) {
      if (!ordered.includes(state)) parts.push(`${state} ${byState[state]}`)
    }
    if (parts.length > 0) lines.push(`意图：${parts.join(' · ')}`)
  }

  if (sections.has('facts')) {
    const byOutcome = factsByOutcome(snap)
    if (byOutcome) {
      const order = ['found', 'none', 'inconclusive', 'blueprint', 'unset']
      lines.push(`事实分布：${order.map(key => `${key} ${byOutcome[key] ?? 0}`).join(' · ')}`)
    } else {
      lines.push(`事实 ${snap.facts ?? 0} / 内存窗口 ${snap.facts_kept ?? '?'}`)
    }
  }

  if (sections.has('usage')) {
    const usage = snap.usage
    if (usage) {
      lines.push(`tokens 入 ${usage.input_tokens ?? 0} / 出 ${usage.output_tokens ?? 0} / 调用 ${usage.calls ?? 0}`)
    }
  }

  if (sections.has('hints')) {
    const hints = Array.isArray(snap.hints) ? snap.hints : []
    for (const hint of hints.slice(-5)) lines.push(`- hint ${clip(hintText(hint), CLIP)}`)
  }

  if (sections.has('todos')) {
    const todos = Array.isArray(snap.todos) ? snap.todos : []
    for (const todo of todos.slice(0, 5)) {
      lines.push(`- [${todo?.status || 'pending'}] ${clip(todo?.content ?? todo?.text ?? todo, CLIP)}`)
    }
    if (todos.length > 5) lines.push(`…还有 ${todos.length - 5} 条待办`)
  }

  if (sections.has('scope')) {
    const scope = snap.scope
    if (scope && Array.isArray(scope.allowed_targets) && scope.allowed_targets.length > 0) {
      lines.push(`scope：${clip(scope.allowed_targets.join(', '), 200)}（处置 ${scope.enforcement || 'warn'}，越界 ${scope.violations ?? 0}）`)
    }
  }

  if (sections.has('findings')) {
    const findings = Array.isArray(snap.findings) ? snap.findings : []
    const shown = findingsLimit > 0 ? findings.slice(-findingsLimit).reverse() : []
    for (const finding of shown) {
      lines.push(`- #${finding?.id} [${finding?.severity || 'unknown'}] ${clip(finding?.title, CLIP)}`)
    }
    if (findingsLimit > 0 && findingsTotal > shown.length) {
      lines.push(`…还有 ${findingsTotal - shown.length} 条（artex_node_detail 按 id 取，或 detail:"full" 后读 status_latest.json / findings.jsonl）`)
    }
  }

  return lines.join('\n')
}

/* ---------------------------------------------------------- overview view */

const OVERVIEW_KEYS = {
  goals: 'goals',
  intents: 'intents',
  facts: 'facts',
  findings: 'findings',
  hints: 'hints',
  todos: 'todos',
  stats: 'stats',
  pending_approvals: 'pending_approvals',
  scope: 'scope_violations',
}

/** 块的伴随键：请求该块时一并带出（findings 的总量计数在顶层而非块内）。 */
const OVERVIEW_COMPANIONS = {
  findings: ['findings_total', 'findings_kept', 'findings_truncated'],
}

/**
 * 按 sections 过滤 overview 顶层键：task 永远保留；非空待审批永远保留（安全）。
 */
export function filterOverview(view, sections) {
  const selected = sectionList(sections, OVERVIEW_SECTIONS)
  if (!selected) return view
  const wanted = new Set(selected.map(section => OVERVIEW_KEYS[section]))
  const out = {}
  if (view && typeof view === 'object' && view.task) out.task = view.task
  for (const key of Object.values(OVERVIEW_KEYS)) {
    if (wanted.has(key) && view && view[key] !== undefined) out[key] = view[key]
  }
  for (const section of selected) {
    for (const key of OVERVIEW_COMPANIONS[section] || []) {
      if (view && view[key] !== undefined) out[key] = view[key]
    }
  }
  if (Array.isArray(view?.pending_approvals) && view.pending_approvals.length > 0 && out.pending_approvals === undefined) {
    out.pending_approvals = view.pending_approvals
  }
  return out
}

/**
 * 超限时返回可解析的包装 JSON（preview + 落盘指针），并保证长度 ≤ maxChars。
 * @param {string} preview 过滤后 JSON（完整 inline 形态）
 * @param {{bytes: number, file: string|null, note?: string}} meta
 * @param {number} maxChars
 */
export function truncatedViewResponse(preview, meta, maxChars) {
  const limit = Math.max(1, Math.trunc(maxChars))
  const points = [...String(preview)]
  let budget = Math.max(0, limit - 160)
  // 注意：必须区分「未提供」与「显式置空」——`fields.file ?? meta.file` 会把降级用的 null 重新弹回长路径。
  const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key)
  const build = (size, fields = {}) => JSON.stringify({
    truncated: true,
    bytes: meta.bytes,
    file: has(fields, 'file') ? fields.file : meta.file,
    note: has(fields, 'note') ? fields.note : meta.note,
    preview: fields.preview === false ? undefined : points.slice(0, size).join(''),
  })
  let candidate = build(budget)
  for (let attempt = 0; attempt < 40 && candidate.length > limit; attempt += 1) {
    budget = Math.floor(budget * 0.7)
    candidate = build(budget)
  }
  // 逐级降级兜底：去 preview → 去 note → 截断 file 路径 → 只留计数，保证 ≤ limit。
  if (candidate.length > limit) candidate = build(0, { preview: false })
  if (candidate.length > limit) candidate = build(0, { preview: false, note: undefined })
  if (candidate.length > limit) {
    const file = meta.file ? `…${String(meta.file).slice(-Math.max(0, limit - 48))}` : null
    candidate = build(0, { preview: false, note: undefined, file })
  }
  if (candidate.length > limit) candidate = build(0, { preview: false, note: undefined, file: null })
  return candidate
}
