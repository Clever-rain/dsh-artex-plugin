/**
 * 探索图领域模型：目标 / 意图 / 事实 / 发现 / 提示 / 待办 / brief / 分析。
 * 纯数据函数，不依赖文件系统。
 */

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

export function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [截断 ${text.length - max} 字符]`
}
