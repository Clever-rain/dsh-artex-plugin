/**
 * ARTEX 双图内核 / dual-graph kernel.
 *
 * 探索图（每任务独立）：goal / intent / fact / finding / hint + 血缘边
 *   spawns        goal -> intent          目标派生出意图
 *   derived_from  fact|finding -> intent  结论派生自上游节点
 *   yields        intent -> fact|finding  意图产出
 *   proves        fact|finding -> goal    证据证明目标达成
 * 资源图（跨任务共享）：type + key 去重，意图/事实/发现通过 resource_ids 锚定。
 *
 * 纯数据 + 文件持久化，没有任何模型/服务依赖，便于单测与恢复。
 */

import { mkdir, readFile, writeFile, appendFile, rename, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const GRAPH_DIR = '.artex'

const now = () => Date.now()

function emptyStats() {
  return { intents: 0, facts: 0, findings: 0, hints: 0, resources: 0, activities: 0 }
}

/** Create the in-memory shape of one task's exploration graph. */
export function createTask(input) {
  const t = {
    v: 1,
    id: input.id,
    description: input.description || '未命名任务',
    goal: input.goal,
    constraints: Array.isArray(input.constraints) ? input.constraints.filter(Boolean) : [],
    ownerSession: input.ownerSession,
    cwd: input.cwd,
    outDir: input.outDir,
    status: 'created',
    mode: input.mode === 'audit' ? 'audit' : 'objective',
    viewMode: ['planner', 'hybrid', 'analyst'].includes(input.viewMode) ? input.viewMode : undefined,
    lastPlannerRoundAt: 0,
    createdAt: now(),
    updatedAt: now(),
    limits: { ...input.limits },
    round: 0,
    nodeSeq: 0,
    activitySeq: 0,
    brief: undefined,
    analysis: undefined,
    goals: [],
    intents: [],
    facts: [],
    findings: [],
    hints: [],
    todos: [],
    activities: [],
    stats: emptyStats(),
    usage: { input_tokens: 0, output_tokens: 0, calls: 0, by_role: {} },
    report: undefined,
  }
  const goalTexts = Array.isArray(input.goals) && input.goals.length > 0 ? input.goals : [input.goal]
  for (const text of goalTexts) {
    t.goals.push({ id: nextNodeId(t), text: String(text), status: 'open', reason: undefined, evidence: undefined, metAt: undefined })
  }
  return t
}

function nextNodeId(task) {
  task.nodeSeq += 1
  return task.nodeSeq
}

function nextActivityId(task) {
  task.activitySeq += 1
  return task.activitySeq
}

export function allGoalsMet(task) {
  return task.goals.length > 0 && task.goals.every(g => g.status === 'met')
}

export function openIntents(task) {
  return task.intents.filter(i => i.state === 'open')
}

export function runningIntents(task) {
  return task.intents.filter(i => i.state === 'running')
}

export function intentById(task, id) {
  return task.intents.find(i => i.id === Number(id))
}

export function nodeById(task, id) {
  const n = Number(id)
  return task.goals.find(x => x.id === n)
    || task.intents.find(x => x.id === n)
    || task.facts.find(x => x.id === n)
    || task.findings.find(x => x.id === n)
    || task.hints.find(x => x.id === n)
    || undefined
}

export function nodeKind(task, id) {
  const n = Number(id)
  if (task.goals.some(x => x.id === n)) return 'goal'
  if (task.intents.some(x => x.id === n)) return 'intent'
  if (task.facts.some(x => x.id === n)) return 'fact'
  if (task.findings.some(x => x.id === n)) return 'finding'
  if (task.hints.some(x => x.id === n)) return 'hint'
  return undefined
}

/* ---------------------------------------------------------------- mutations */

/** Planner dispatch: batch of intents (max 4, like ARTEX add_intent). */
export function addIntents(task, items, options = {}) {
  const out = []
  const limit = Math.max(1, Math.min(4, options.max ?? 4))
  for (const raw of items.slice(0, limit)) {
    const summary = String(raw?.summary ?? raw?.text ?? '').trim()
    if (!summary) continue
    // 失败/中止的方向允许用同一 summary 重试；blueprint 返回已有 id 供 promote。
    const dup = task.intents.find(i => i.summary === summary && !['failed', 'stopped'].includes(i.state))
    if (dup && options.allowDuplicate !== true) {
      out.push({ id: dup.id, duplicate: true, state: dup.state, summary })
      continue
    }
    const intent = {
      id: nextNodeId(task),
      summary,
      state: raw?.state === 'blueprint' ? 'blueprint' : 'open',
      kind: raw?.kind === 'enumerate' || raw?.kind === 'pursue'
        ? raw.kind
        : (task.mode === 'audit' ? 'enumerate' : 'pursue'),
      pathParent: normalizeIntentRef(task, raw?.path_parent ?? raw?.pathParent),
      priority: Number.isFinite(raw?.priority) ? raw.priority : 5,
      resourceIds: normalizeIds(raw?.resource_ids),
      parents: normalizeIds(raw?.parents),
      createdAt: now(),
      startedAt: undefined,
      endedAt: undefined,
      worker: undefined,
      output: undefined,
      writes: { facts: 0, findings: 0, resources: 0 },
      outcomes: { found: 0, none: 0, inconclusive: 0, blueprint: 0 },
      reason: undefined,
    }
    task.intents.push(intent)
    task.stats.intents += 1
    out.push({ id: intent.id, summary, state: intent.state, kind: intent.kind })
  }
  task.updatedAt = now()
  return out
}

/** 只接受本任务里已存在的意图 id；非法值归 null。 */
function normalizeIntentRef(task, value) {
  const id = Number(value)
  if (!Number.isFinite(id) || id <= 0) return null
  return task.intents.some(i => i.id === id) ? id : null
}

function normalizeIds(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map(x => Number(x)).filter(x => Number.isFinite(x) && x > 0)
}

export function claimIntent(task, id, worker) {
  const intent = intentById(task, id)
  if (!intent || intent.state !== 'open') return undefined
  intent.state = 'running'
  intent.startedAt = now()
  intent.worker = worker
  task.updatedAt = now()
  return intent
}

export function finishIntent(task, id, patch) {
  const intent = intentById(task, id)
  if (!intent) return undefined
  intent.state = patch.state
  intent.endedAt = now()
  intent.output = patch.output
  intent.reason = patch.reason
  if (patch.writes) intent.writes = { ...patch.writes }
  task.updatedAt = now()
  return intent
}

export function recordFact(task, input) {
  const fact = {
    id: nextNodeId(task),
    summary: String(input.summary).trim(),
    detail: input.detail ? String(input.detail) : '',
    evidence: input.evidence ? String(input.evidence) : '',
    confidence: input.confidence === 'inferred' ? 'inferred' : 'observed',
    outcome: ['found', 'none', 'inconclusive', 'blueprint'].includes(input.outcome) ? input.outcome : undefined,
    intentId: input.intentId ? Number(input.intentId) : null,
    resourceIds: normalizeIds(input.resourceIds),
    createdAt: now(),
  }
  task.facts.push(fact)
  task.stats.facts += 1
  if (fact.intentId) {
    const intent = intentById(task, fact.intentId)
    if (intent) {
      intent.writes.facts += 1
      if (!intent.outcomes) intent.outcomes = { found: 0, none: 0, inconclusive: 0, blueprint: 0 }
      if (fact.outcome) intent.outcomes[fact.outcome] += 1
    }
  }
  task.updatedAt = now()
  return fact
}

export function reportFinding(task, input) {
  const finding = {
    id: nextNodeId(task),
    title: String(input.title || input.summary || '').trim(),
    detail: input.detail ? String(input.detail) : '',
    severity: input.severity ? String(input.severity) : 'unknown',
    evidence: input.evidence ? String(input.evidence) : '',
    intentId: input.intentId ? Number(input.intentId) : null,
    resourceIds: normalizeIds(input.resourceIds),
    createdAt: now(),
  }
  task.findings.push(finding)
  task.stats.findings += 1
  if (finding.intentId) {
    const intent = intentById(task, finding.intentId)
    if (intent) intent.writes.findings += 1
  }
  task.updatedAt = now()
  return finding
}

export function addHint(task, text) {
  const hint = { id: nextNodeId(task), text: String(text).trim(), createdAt: now(), consumed: false }
  if (!hint.text) return undefined
  task.hints.push(hint)
  task.stats.hints += 1
  task.updatedAt = now()
  return hint
}

export function setTodos(task, items) {
  task.todos = items
    .filter(it => it && String(it.content || '').trim())
    .map(it => ({
      content: String(it.content).trim(),
      status: ['pending', 'in_progress', 'completed'].includes(it.status) ? it.status : 'pending',
    }))
  task.updatedAt = now()
  return task.todos
}

/** 规划者维护的全局认知：整体替换、按轮次版本化（与 todos 同为"综合"而非"追加"）。 */
export function setBrief(task, text, citations = []) {
  const clean = String(text || '').trim()
  if (!clean) return undefined
  task.brief = {
    text: truncate(clean, 2000),
    round: task.round,
    updatedAt: now(),
    citations: normalizeIds(citations),
  }
  task.updatedAt = now()
  return task.brief
}

/** analyst 的独立分析：只读输入、单独存放，planner 决定是否采纳（不直接改 brief）。 */
export function setAnalysis(task, text, citations = []) {
  const clean = String(text || '').trim()
  if (!clean) return undefined
  task.analysis = {
    text: truncate(clean, 2000),
    round: task.round,
    updatedAt: now(),
    citations: normalizeIds(citations),
  }
  task.analysisRuns = (task.analysisRuns || 0) + 1
  task.updatedAt = now()
  return task.analysis
}

/** 把 blueprint 提升为 open，进入 frontier。 */
export function promoteIntent(task, id) {
  const intent = intentById(task, id)
  if (!intent) return { ok: false, error: `意图 #${id} 不存在` }
  if (intent.state !== 'blueprint') return { ok: false, error: `意图 #${id} 不是 blueprint（当前 ${intent.state}）` }
  intent.state = 'open'
  task.updatedAt = now()
  return { ok: true, intent }
}

export function proveGoal(task, goalId, evidenceId, reason) {  const goal = task.goals.find(g => g.id === Number(goalId))
  if (!goal) return { ok: false, error: `goal #${goalId} 不存在` }
  const evidence = nodeById(task, evidenceId)
  const evidenceKind = nodeKind(task, evidenceId)
  if (!evidence || (evidenceKind !== 'fact' && evidenceKind !== 'finding')) {
    return { ok: false, error: `evidence_id #${evidenceId} 必须是本任务里已存在的事实(fact)或发现(finding)` }
  }
  goal.status = 'met'
  goal.evidence = Number(evidenceId)
  goal.reason = reason ? String(reason) : ''
  goal.metAt = now()
  task.updatedAt = now()
  return { ok: true, goal, kind: evidenceKind, allMet: allGoalsMet(task) }
}

/** A step of process trace (worker tool call/result), used for cross-work look-back. */
export function addActivity(task, input) {
  const activity = {
    id: nextActivityId(task),
    intentId: input.intentId ? Number(input.intentId) : null,
    worker: input.worker || '',
    kind: input.kind || 'step',
    tool: input.tool || '',
    summary: truncate(String(input.summary || ''), 240),
    detail: truncate(String(input.detail || ''), 4000),
    isError: input.isError === true,
    at: now(),
  }
  task.activities.push(activity)
  task.stats.activities += 1
  // 有上限地保留过程库，避免长任务把内存吃满（磁盘 JSONL 仍保留全量）。
  if (task.activities.length > 4000) task.activities.splice(0, task.activities.length - 4000)
  task.updatedAt = now()
  return activity
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [截断 ${text.length - max} 字符]`
}

/* ---------------------------------------------------------------- queries */

export function intentYields(task, intentId) {
  return [
    ...task.facts.filter(f => f.intentId === intentId).map(f => f.id),
    ...task.findings.filter(f => f.intentId === intentId).map(f => f.id),
  ]
}

function briefIntent(task, i) {
  return {
    id: i.id,
    summary: i.summary,
    state: i.state,
    parents: i.parents,
    yields: intentYields(task, i.id),
    writes: i.writes,
  }
}

/**
 * The situational snapshot attached to every planner wake-up (mirrors
 * graph_overview): goals + open/running/recent_done intents + facts + findings.
 */
export function overview(task, options = {}) {
  const factsLimit = Math.max(1, Math.min(50, options.factsLimit ?? 20))
  const q = options.factsQ ? String(options.factsQ).toLowerCase() : ''
  const facts = q ? task.facts.filter(f => `${f.summary}\n${f.detail}`.toLowerCase().includes(q)) : task.facts
  const recent = facts.slice(-factsLimit).reverse()
  const done = task.intents.filter(i => ['done', 'exhausted', 'blocked', 'stopped'].includes(i.state)).slice(-8).reverse()
  return {
    task: { id: task.id, description: task.description, goal: task.goal, status: task.status },
    goals: task.goals.map(g => ({ id: g.id, text: g.text, status: g.status, evidence: g.evidence })),
    constraints: task.constraints,
    intents: {
      open: openIntents(task).map(i => briefIntent(task, i)),
      running: runningIntents(task).map(i => briefIntent(task, i)),
      recent_done: done.map(i => briefIntent(task, i)),
    },
    facts: {
      total: task.facts.length,
      recent: recent.map(f => ({
        id: f.id,
        summary: f.summary,
        confidence: f.confidence,
        intent_id: f.intentId,
      })),
    },
    findings: task.findings.map(f => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      intent_id: f.intentId,
    })),
    hints: task.hints.map(h => ({ id: h.id, text: h.text })),
    todos: task.todos,
    stats: {
      round: task.round,
      intents_total: task.intents.length,
      facts_total: task.facts.length,
      findings_total: task.findings.length,
      resources_total: task.stats.resources,
    },
  }
}

/** 确定性事实底数：不产生判断，只统计，供规划者校准 brief。 */
export function digestOf(task) {
  const byOutcome = { found: 0, none: 0, inconclusive: 0, blueprint: 0, unset: 0 }
  for (const f of task.facts) {
    const key = f.outcome || 'unset'
    byOutcome[key] = (byOutcome[key] || 0) + 1
  }
  const states = {}
  for (const i of task.intents) states[i.state] = (states[i.state] || 0) + 1
  return {
    mode: task.mode,
    facts: { total: task.facts.length, by_outcome: byOutcome },
    findings: task.findings.length,
    intents: states,
    failed_paths: task.intents
      .filter(i => i.state === 'failed')
      .slice(-6)
      .map(i => ({ id: i.id, summary: truncate(i.summary, 100), reason: i.reason })),
    resources: task.stats.resources,
  }
}

/** 本轮增量：上一次规划之后新增的事实/发现/结束的意图。 */
export function deltaOf(task, since) {
  const at = Number(since) || 0
  return {
    since: at > 0 ? new Date(at).toISOString() : '(任务开始)',
    facts: task.facts.filter(f => f.createdAt > at).slice(-10).map(f => ({
      id: f.id,
      summary: truncate(f.summary, 120),
      confidence: f.confidence,
      outcome: f.outcome,
      intent_id: f.intentId,
    })),
    findings: task.findings.filter(f => f.createdAt > at).slice(-5).map(f => ({
      id: f.id,
      title: truncate(f.title, 100),
      severity: f.severity,
      intent_id: f.intentId,
    })),
    intents: task.intents.filter(i => i.endedAt && i.endedAt > at).slice(-8).map(i => ({
      id: i.id,
      state: i.state,
      summary: truncate(i.summary, 100),
      reason: i.reason,
    })),
  }
}

/**
 * 规划者视图：只保留"派意图 / 判目标"需要的字段。
 * brief 由提示词正文单独渲染，不在这里重复；digest/delta 由引擎注入。
 */
export function plannerView(task, options = {}) {
  const factsLimit = Math.max(1, Math.min(50, options.factsLimit ?? 5))
  const q = options.factsQ ? String(options.factsQ).toLowerCase() : ''
  const facts = q ? task.facts.filter(f => `${f.summary}\n${f.detail}`.toLowerCase().includes(q)) : task.facts
  const briefRow = (intent, withState = false) => {
    const row = { id: intent.id, summary: truncate(intent.summary, 160) }
    if (intent.kind === 'pursue') row.kind = 'pursue'
    if (intent.pathParent) row.path_parent = intent.pathParent
    if (intent.parents.length > 0) row.parents = intent.parents
    const yields = intentYields(task, intent.id)
    if (yields.length > 0) row.yields = yields
    if (intent.writes.facts || intent.writes.findings || intent.writes.resources) row.writes = intent.writes
    if (withState) {
      row.state = intent.state
      if (intent.reason) row.reason = intent.reason
    }
    return row
  }
  return {
    mode: task.mode,
    stale_brief: options.staleBrief === true,
    digest: options.digest || digestOf(task),
    delta: options.delta,
    analysis: task.analysis?.text
      ? { text: truncate(task.analysis.text, 1200), round: task.analysis.round, citations: task.analysis.citations }
      : undefined,
    analysis_runs: task.analysisRuns || 0,
    goals: task.goals.map(g => ({
      id: g.id,
      text: g.text,
      status: g.status,
      ...(g.evidence ? { evidence: g.evidence } : {}),
    })),
    intents: {
      open: openIntents(task).map(i => briefRow(i)),
      running: runningIntents(task).map(i => briefRow(i)),
      blueprints: task.intents.filter(i => i.state === 'blueprint').slice(-10).map(i => briefRow(i)),
      recent_done: task.intents
        .filter(i => ['done', 'failed', 'exhausted', 'blocked', 'stopped'].includes(i.state))
        .slice(-6)
        .reverse()
        .map(i => briefRow(i, true)),
    },
    facts: {
      total: task.facts.length,
      recent: facts.slice(-factsLimit).reverse().map(f => ({
        id: f.id,
        summary: truncate(f.summary, 160),
        confidence: f.confidence,
        outcome: f.outcome,
        intent_id: f.intentId,
      })),
    },
    findings: task.findings.slice(-20).map(f => ({
      id: f.id,
      title: truncate(f.title, 100),
      severity: f.severity,
      intent_id: f.intentId,
    })),
    hints: task.hints.map(h => ({ id: h.id, text: truncate(h.text, 200) })),
  }
}

/**
 * 执行者视图：只保留"别重复、别越界"所需的最小态势，外加共享的全局认知摘要。
 */
export function workerView(task, intent, options = {}) {
  const factsLimit = Math.max(1, Math.min(20, options.factsLimit ?? 5))
  const others = task.intents.filter(i => i.state === 'running' && i.id !== intent.id)
  const done = task.intents.filter(i => ['done', 'failed', 'exhausted', 'blocked', 'stopped'].includes(i.state)).slice(-3)
  const view = {
    mode: task.mode,
    kind: intent.kind,
    goals: task.goals.map(g => `${g.id}.[${g.status}] ${truncate(g.text, 80)}`),
    facts_total: task.facts.length,
    findings_total: task.findings.length,
    facts_recent: task.facts.slice(-factsLimit).reverse().map(f => `#${f.id} [${f.confidence}${f.outcome ? `/${f.outcome}` : ''}] ${truncate(f.summary, 80)}`),
    findings: task.findings.slice(-8).map(f => `#${f.id} ${truncate(f.title, 60)}`),
  }
  if (intent.pathParent) {
    const parent = intentById(task, intent.pathParent)
    if (parent) view.path = `#${parent.id} ${truncate(parent.summary, 100)}`
  }
  if (task.brief?.text) view.brief = truncate(task.brief.text, 600)
  if (others.length > 0) view.running_others = others.map(i => `#${i.id} ${truncate(i.summary, 70)}`)
  if (done.length > 0) view.recent_done = done.map(i => `#${i.id} ${i.state} ${truncate(i.summary, 60)}`)
  if (task.hints.length > 0) view.hints = task.hints.map(h => truncate(h.text, 100))
  return view
}

/** Full node content for node_detail. */
export function detail(task, id) {
  const n = nodeById(task, id)
  if (!n) return undefined
  const kind = nodeKind(task, id)
  const base = { ...n, kind }
  if (kind === 'intent') {
    base.yields = intentYields(task, n.id)
    base.parents = n.parents
  }
  if (kind === 'fact' || kind === 'finding') {
    base.from_intent = n.intentId ? intentById(task, n.intentId)?.summary : undefined
  }
  return base
}

/** Which intents ran, and how many trace steps each has. */
export function listTraces(task) {
  return task.intents
    .filter(i => i.state !== 'open')
    .map(i => ({
      intent_id: i.id,
      summary: i.summary,
      state: i.state,
      steps: task.activities.filter(a => a.intentId === i.id).length,
      output: truncate(String(i.output || ''), 240),
    }))
}

/** Keyword search across every worker's process trace (excludes own intent optionally). */
export function searchTraces(task, q, options = {}) {
  const needle = String(q || '').toLowerCase()
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  if (!needle) return []
  const exclude = options.excludeIntentId ? Number(options.excludeIntentId) : 0
  const hits = []
  for (const a of task.activities) {
    if (a.intentId && exclude && a.intentId === exclude) continue
    if (a.kind === 'thinking' || a.kind === 'usage') continue
    if (!`${a.summary}\n${a.detail}`.toLowerCase().includes(needle)) continue
    hits.push({ intent_id: a.intentId, step_id: a.id, worker: a.worker, kind: a.kind, tool: a.tool, summary: a.summary })
    if (hits.length >= limit) break
  }
  return hits
}

/** Trace detail: step list, or full content for up to 5 requested steps. */
export function getTrace(task, intentId, stepIds) {
  const steps = task.activities.filter(a => a.intentId === Number(intentId))
  if (!stepIds || stepIds.length === 0) {
    return {
      intent_id: Number(intentId),
      steps: steps.map(s => ({ step_id: s.id, kind: s.kind, tool: s.tool, summary: s.summary, is_error: s.isError })),
    }
  }
  const wanted = stepIds.map(Number).slice(0, 5)
  const found = steps.filter(s => wanted.includes(s.id))
  return {
    intent_id: Number(intentId),
    steps: found.map(s => ({ step_id: s.id, kind: s.kind, tool: s.tool, summary: s.summary, is_error: s.isError, detail: s.detail })),
    omitted_step_ids: stepIds.map(Number).slice(5),
  }
}

/* ---------------------------------------------------------- resource graph */

/** Cross-task resource store: dedupe by (type, key||name). */
export class ResourceStore {
  constructor(rootDir) {
    this.dir = join(rootDir, GRAPH_DIR)
    this.path = join(this.dir, 'resources.json')
    this.counter = 0
    this.items = []
    this.loaded = false
    this.loadPromise = undefined
    this.saving = Promise.resolve()
    this.lastError = undefined
  }

  /** 单飞加载：并发 upsert 不会看到"已标记 loaded 但 items 仍为空"的中间态。 */
  async load() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = JSON.parse(await readFile(this.path, 'utf8'))
          this.counter = Number(raw.counter) || 0
          this.items = Array.isArray(raw.items) ? raw.items : []
        } catch (error) {
          if (error?.code !== 'ENOENT') this.lastError = error
        } finally {
          this.loaded = true
        }
      })()
    }
    return this.loadPromise
  }

  static keyOf(item) {
    const type = String(item.type || 'resource').trim().toLowerCase()
    const key = String(item.key || item.name || '').trim().toLowerCase()
    return `${type}::${key}`
  }

  async upsert(items, taskId) {
    await this.load()
    const out = []
    for (const raw of items) {
      const name = String(raw?.name ?? '').trim()
      if (!name) continue
      const key = ResourceStore.keyOf({ ...raw, name })
      const existing = this.items.find(x => ResourceStore.keyOf(x) === key)
      if (existing) {
        existing.updatedAt = now()
        if (taskId && !existing.tasks.includes(taskId)) existing.tasks.push(taskId)
        if (raw.attrs && typeof raw.attrs === 'object') existing.attrs = { ...existing.attrs, ...raw.attrs }
        out.push({ id: existing.id, name: existing.name, type: existing.type, created: false })
        continue
      }
      this.counter += 1
      const item = {
        id: this.counter,
        type: String(raw.type || 'resource'),
        name,
        key: raw.key ? String(raw.key) : name,
        attrs: raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : {},
        createdAt: now(),
        updatedAt: now(),
        tasks: taskId ? [taskId] : [],
      }
      this.items.push(item)
      out.push({ id: item.id, name: item.name, type: item.type, created: true })
    }
    this.save()
    return out
  }

  list(filter = {}) {
    const q = filter.q ? String(filter.q).toLowerCase() : ''
    return this.items
      .filter(x => !filter.type || x.type === filter.type)
      .filter(x => !q || `${x.name}\n${x.key}\n${JSON.stringify(x.attrs)}`.toLowerCase().includes(q))
      .slice(0, 200)
      .map(x => ({ id: x.id, type: x.type, name: x.name, attrs: x.attrs }))
  }

  save() {
    const payload = JSON.stringify({ counter: this.counter, items: this.items })
    this.saving = this.saving.then(async () => {
      await mkdir(this.dir, { recursive: true })
      await writeAtomic(this.path, payload)
    }).catch((error) => {
      this.lastError = error
    })
    return this.saving
  }
}

/* ------------------------------------------------------------ persistence */

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

export class TaskStore {
  constructor(cwd, options = {}) {
    this.cwd = cwd
    this.root = join(cwd, GRAPH_DIR)
    this.paths = new Map()
    this.pending = new Map()
    this.onError = options.onError
    this.lastError = undefined
  }

  taskDir(taskId) {
    return join(this.root, 'tasks', taskId)
  }

  pathOf(taskId) {
    return join(this.taskDir(taskId), 'task.json')
  }

  /** 快照不重复存过程日志：activities 已有 activity.jsonl 作为权威副本。 */
  snapshotPayload(task) {
    const { activities, ...rest } = task
    return JSON.stringify(rest)
  }

  /** Persist the graph snapshot (atomic rename, compact JSON, no activities). */
  save(task) {
    const path = this.pathOf(task.id)
    const payload = this.snapshotPayload(task)
    const prev = this.paths.get(task.id) ?? Promise.resolve()
    const next = prev.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeAtomic(path, payload)
    }).catch((error) => {
      this.lastError = error
      this.onError?.(error)
    })
    this.paths.set(task.id, next)
    return next
  }

  /**
   * 合并写：高频 mutation 只安排一次延迟落盘，flush 时序列化最新状态。
   * 返回的 promise 在真正写完后 resolve。
   */
  scheduleSave(task, delay = 200) {
    const id = task.id
    const existing = this.pending.get(id)
    if (existing) {
      existing.task = task
      return existing.promise
    }
    const entry = { task, timer: undefined, resolve: undefined, promise: undefined }
    entry.promise = new Promise((resolve) => { entry.resolve = resolve })
    entry.timer = setTimeout(() => { void this.flush(id) }, Math.max(0, delay))
    this.pending.set(id, entry)
    return entry.promise
  }

  async flush(id) {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    await this.save(entry.task)
    entry.resolve()
  }

  async flushAll() {
    await Promise.all([...this.pending.keys()].map(id => this.flush(id)))
  }

  /** Append-only process log, so long runs survive the in-memory activity cap. */
  appendActivity(task, activity) {
    const path = join(this.taskDir(task.id), 'activity.jsonl')
    const line = `${JSON.stringify(activity)}\n`
    const prev = this.paths.get(`${task.id}:activity`) ?? Promise.resolve()
    const next = prev.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, line, 'utf8')
    }).catch((error) => {
      this.lastError = error
      this.onError?.(error)
    })
    this.paths.set(`${task.id}:activity`, next)
    return next
  }

  /** 从 JSONL 回填过程日志（最多 4000 条，与内存上限一致）。 */
  async readActivities(taskId) {
    try {
      const text = await readFile(join(this.taskDir(taskId), 'activity.jsonl'), 'utf8')
      const out = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
      }
      return out.slice(-4000)
    } catch {
      return []
    }
  }

  async load(taskId) {
    const raw = JSON.parse(await readFile(this.pathOf(taskId), 'utf8'))
    if (!raw || typeof raw !== 'object') throw new Error('task snapshot 损坏')
    if (!Array.isArray(raw.activities) || raw.activities.length === 0) {
      const activities = await this.readActivities(taskId)
      if (activities.length > 0) {
        raw.activities = activities
        raw.activitySeq = Math.max(Number(raw.activitySeq) || 0, ...activities.map(a => Number(a.id) || 0))
      }
    }
    return raw
  }

  /** Task ids present on disk (newest first), for status queries after a restart. */
  async ids() {
    try {
      const entries = await readdir(join(this.root, 'tasks'), { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
    } catch {
      return []
    }
  }
}

/**
 * 全局任务索引：taskId → cwd。
 * 快照仍在各自工作区的 .artex 下，索引只解决"换一个 cwd 也能按 id 找到任务"。
 */
export class TaskIndex {
  constructor(path = join(homedir(), '.dsh', 'artex-index.json'), options = {}) {
    this.path = path
    this.items = {}
    this.loadPromise = undefined
    this.onError = options.onError
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = JSON.parse(await readFile(this.path, 'utf8'))
          this.items = raw?.items && typeof raw.items === 'object' ? raw.items : {}
        } catch (error) {
          if (error?.code !== 'ENOENT') this.onError?.(error)
        }
      })()
    }
    return this.loadPromise
  }

  async register(task) {
    if (!task?.id || !task?.cwd) return
    await this.load()
    this.items[task.id] = { cwd: task.cwd, updatedAt: now() }
    const ids = Object.keys(this.items)
    if (ids.length > 500) {
      for (const id of ids.sort((a, b) => (this.items[a].updatedAt || 0) - (this.items[b].updatedAt || 0)).slice(0, ids.length - 500)) {
        delete this.items[id]
      }
    }
    try {
      await writeAtomic(this.path, JSON.stringify({ items: this.items }))
    } catch (error) {
      this.onError?.(error)
    }
  }

  async lookup(taskId) {
    await this.load()
    return this.items[String(taskId)]?.cwd
  }
}
