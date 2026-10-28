/**
 * 角色视图与查询：overview / plannerView / workerView / digest / delta / trace。
 * 只读投影，不修改图。
 */

import { intentById, nodeById, nodeKind, openIntents, runningIntents, truncate, intentDepsSatisfied } from './model.js'

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
      // total 用累计真值而不是内存窗口长度：trim 后 len() 会静默失真。
      total: task.stats.facts,
      kept: task.facts.length,
      truncated: task.stats.facts > task.facts.length || undefined,
      filtered: q ? true : undefined,
      recent: recent.map(f => ({
        id: f.id,
        summary: f.summary,
        confidence: f.confidence,
        intent_id: f.intentId,
      })),
    },
    findings: task.findings.slice(-50).map(f => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      intent_id: f.intentId,
    })),
    findings_total: task.stats.findings,
    findings_kept: task.findings.length,
    findings_truncated: task.findings.length > 50 || undefined,
    hints: task.hints.map(h => ({ id: h.id, text: h.text })),
    todos: task.todos,
    stats: {
      round: task.round,
      intents_total: task.stats.intents,
      facts_total: task.stats.facts,
      findings_total: task.stats.findings,
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
    // by_outcome 只统计内存窗口内的事实；total 是累计真值，kept 标注窗口深度。
    facts: {
      total: task.stats.facts,
      kept: task.facts.length,
      truncated: task.stats.facts > task.facts.length || undefined,
      by_outcome: byOutcome,
      retracted: task.facts.filter(f => f.retracted === true).length || undefined,
      superseded: task.facts.filter(f => f.supersededBy).length || undefined,
    },
    findings: task.stats.findings,
    findings_kept: task.findings.length,
    findings_by_status: {
      open: task.findings.filter(f => (f.status || 'open') === 'open').length,
      verified: task.findings.filter(f => f.status === 'verified').length,
      rejected: task.findings.filter(f => f.status === 'rejected').length,
      needs_retest: task.findings.filter(f => f.status === 'needs_retest').length,
    },
    conflicts: Array.isArray(task.conflicts) ? task.conflicts.length : 0,
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
    if (Array.isArray(intent.dependsOn) && intent.dependsOn.length > 0) {
      row.depends_on = intent.dependsOn
      if (!intentDepsSatisfied(task, intent)) row.blocked_by_deps = true
    }
    const yields = intentYields(task, intent.id)
    if (yields.length > 0) row.yields = yields
    if (intent.writes.facts || intent.writes.findings || intent.writes.resources) row.writes = intent.writes
    if (withState) {
      row.state = intent.state
      if (intent.reason) row.reason = intent.reason
    }
    return row
  }
  const deltaFactIds = new Set((options.delta?.facts || []).map(f => f.id))
  return {
    mode: task.mode,
    stale_brief: options.staleBrief === true,
    digest: options.digest || digestOf(task),
    delta: options.delta,
    // analysis 由提示词正文单独渲染，避免在 JSON 里重复一遍。
    analysis_round: task.analysis?.round ?? undefined,
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
      total: task.stats.facts,
      kept: task.facts.length,
      truncated: task.stats.facts > task.facts.length || undefined,
      recent: facts.filter(f => !deltaFactIds.has(f.id)).slice(-factsLimit).reverse().map(f => ({
        id: f.id,
        summary: truncate(f.summary, 160),
        confidence: f.confidence,
        outcome: f.outcome,
        intent_id: f.intentId,
        // 同文不同结局会并存：不标出来，规划者看到的是两条互相矛盾、没有先后的证据（N31）。
        superseded_by: f.supersededBy || undefined,
        supersedes: f.supersedes || undefined,
        retracted: f.retracted === true || undefined,
      })),
    },
    findings_total: task.stats.findings,
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
    facts_total: task.stats.facts,
    findings_total: task.stats.findings,
    facts_recent: task.facts.slice(-factsLimit).reverse().map((f) => {
      const marks = [f.supersededBy ? `已被 #${f.supersededBy} 取代` : '', f.retracted ? '已撤回' : ''].filter(Boolean).join('，')
      return `#${f.id} [${f.confidence}${f.outcome ? `/${f.outcome}` : ''}] ${truncate(f.summary, 80)}${marks ? `（${marks}）` : ''}`
    }),
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

/**
 * 确定性的覆盖矩阵（无模型参与）：每条目标，按关键字匹配统计与之相关的事实/发现。
 * gap = 目标未证明、且证据/相关事实都为空——audit 收口前应被消化或显式接受。
 */
export function coverageOf(task) {
  const rows = []
  for (const g of task.goals) {
    const haystack = (n) => `${n.summary ?? ''}\n${n.detail ?? ''}\n${n.title ?? ''}`
    const tokens = [...new Set((String(g.text).toLowerCase().match(/[a-z0-9_]{2,}|[一-鿿]{2,}/g)) || [])]
    const links = (list) => (tokens.length > 0 ? list.filter(n => tokens.some(t => haystack(n).toLowerCase().includes(t))) : [])
    const factsLinked = links(task.facts)
    const findingsLinked = links(task.findings)
    const evidenceNode = g.evidence ? nodeById(task, g.evidence) : undefined
    rows.push({
      id: g.id,
      text: truncate(String(g.text ?? ''), 160),
      status: g.status,
      evidence: g.evidence ?? undefined,
      evidence_outcome: evidenceNode?.outcome ?? g.evidenceOutcome ?? undefined,
      facts_linked: factsLinked.length,
      findings_linked: findingsLinked.length,
      outcomes: {
        found: factsLinked.filter(f => f.outcome === 'found').length,
        none: factsLinked.filter(f => f.outcome === 'none').length,
        inconclusive: factsLinked.filter(f => f.outcome === 'inconclusive').length,
      },
      gap: g.status !== 'met' && factsLinked.length === 0 && findingsLinked.length === 0 && !g.evidence,
      keywords: tokens.slice(0, 6),
    })
  }
  return {
    mode: task.mode,
    goals: rows,
    gaps: rows.filter(r => r.gap).map(r => r.id),
    covered: rows.length - rows.filter(r => r.gap).length,
    total: rows.length,
    conflicts_total: Array.isArray(task.conflicts) ? task.conflicts.length : 0,
  }
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

/**
 * 态势投影构建失败时的降级视图：收官/收尾证明轮用它继续，
 * planner 只能依据 brief 与本轮事件谨慎判定（明确禁止扩展性决策）。
 * 只含防御性渲染的目标与计数，保证自身不再抛错。
 */
export function degradedView(task, error) {
  const safeText = (value, max = 160) => {
    try {
      return truncate(String(value ?? ''), max)
    } catch {
      return ''
    }
  }
  return {
    mode: task.mode === 'audit' ? 'audit' : 'objective',
    degraded: true,
    degraded_reason: String(error || 'unknown'),
    digest: undefined,
    delta: undefined,
    goals: (Array.isArray(task.goals) ? task.goals : []).map(g => ({
      id: g?.id,
      text: safeText(g?.text),
      status: g?.status || 'open',
      ...(g?.evidence ? { evidence: g.evidence } : {}),
    })),
    intents: { open: [], running: [], blueprints: [], recent_done: [] },
    facts: { total: Number(task?.stats?.facts) || 0, kept: 0, truncated: true, recent: [] },
    findings: [],
    hints: [],
  }
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
