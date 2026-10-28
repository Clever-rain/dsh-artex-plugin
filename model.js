/**
 * 探索图领域模型：目标 / 意图 / 事实 / 发现 / 提示 / 待办 / brief / 分析。
 * 纯数据函数，不依赖文件系统。
 */

const now = () => Date.now()

function emptyStats() {
  return { intents: 0, facts: 0, findings: 0, hints: 0, resources: 0, activities: 0 }
}

/** 任务级工具/沙箱策略：任务参数的规范化形状（真实门禁在 spawn 的 toolFilter/cwd，提示词进 prompt）。 */
export function normalizePolicy(policy = {}) {
  const clean = value => (Array.isArray(value) ? [...new Set(value.map(v => String(v).trim()).filter(Boolean))] : [])
  return {
    allowedTools: clean(policy.allowedTools ?? policy.allowed_tools),
    readOnly: policy.readOnly === true || policy.read_only === true,
    allowedPaths: clean(policy.allowedPaths ?? policy.allowed_paths),
  }
}

/** Create the in-memory shape of one task's exploration graph. */
export function createTask(input) {
  const t = {
    v: 1,
    id: input.id,
    description: input.description || '未命名任务',
    goal: input.goal,
    constraints: Array.isArray(input.constraints) ? input.constraints.filter(Boolean) : [],
    policy: normalizePolicy(input.policy),
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
    conflicts: [],
    stats: emptyStats(),
    usage: { input_tokens: 0, output_tokens: 0, calls: 0, by_role: {}, by_intent: {} },
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
  // 默认单批 4 条（artex_add_intent 的护栏），artex_plan 可抬到 12。
  const limit = Math.max(1, Number(options.max) || 4)
  for (const raw of items.slice(0, limit)) {
    const summary = String(raw?.summary ?? raw?.text ?? '').trim()
    if (!summary) continue
    // 失败/中止/启动受阻的方向允许用同一 summary 重试；blueprint 返回已有 id 供 promote。
    // blocked 目前只由 worker 启动失败（provider/资源类瞬态错误）产生，允许重派原方向。
    const dup = task.intents.find(i => i.summary === summary && !['failed', 'stopped', 'blocked'].includes(i.state))
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
      // 显式串行依赖：全部依赖完成后才可被领取（草地：依赖以外部校验保证存在）。
      dependsOn: normalizeIds(raw?.depends_on ?? raw?.dependsOn),
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

/** 规范化比对文本：大小写与折叠空白不影响判定。 */
export function normalizeSummaryText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 事实写回去重的回看窗口（条）：只在近期范围内比对，长任务开销恒定。 */
export const FACT_DEDUP_WINDOW = 500

/**
 * brief/analysis 引用上限：保护集无上限时，事实保留量会被顶到 2×MAX_FACTS（N30）。
 * 200 条足够表达覆盖地图/路径树，超出按最近写入为准。
 */
export const MAX_CITATIONS = 200

/** 最近窗口内同文（规范化 summary）的事实，不看结局；用于标注取代关系。 */
export function findSameSummaryFact(task, summary, ignoreId = 0) {
  const key = normalizeSummaryText(summary)
  if (!key) return undefined
  const list = task.facts || []
  const start = Math.max(0, list.length - FACT_DEDUP_WINDOW)
  for (let i = list.length - 1; i >= start; i -= 1) {
    const existing = list[i]
    if (existing.id !== ignoreId && normalizeSummaryText(existing.summary) === key) return existing
  }
  return undefined
}

/**
 * 判重：同文且结局相同才算重复。
 * 结局不同（audit 里"先判无、重测命中"）是新证据，必须允许入库，否则图上
 * 会永久保留旧结论、prove_goal 也拿不到命中作证据（N26）。
 * 任一侧 outcome 缺省时按重复处理：缺省不携带新结论。
 */
export function findDuplicateFact(task, summary, ignoreId = 0, outcome = undefined) {
  const existing = findSameSummaryFact(task, summary, ignoreId)
  if (!existing) return undefined
  if (outcome != null && existing.outcome != null && String(outcome) !== String(existing.outcome)) return undefined
  return existing
}

/**
 * 血缘锚点校验：parents 只能指向已存在的 fact/finding（提示词纪律写死这一点）。
 * 返回非法 id 列表（空数组 = 全部合法）；引用被 trim 掉的旧节点也算非法。
 */
export function danglingParents(task, parents) {
  return (Array.isArray(parents) ? parents : []).filter((id) => {
    const kind = nodeKind(task, id)
    return kind !== 'fact' && kind !== 'finding'
  })
}

/** 依赖是否全部完成：依赖只认 done（failed/stopped/exhausted 的依赖不算完成，规划者需要改路线）。 */
export function intentDepsSatisfied(task, intent) {
  const deps = Array.isArray(intent?.dependsOn) ? intent.dependsOn : []
  if (deps.length === 0) return true
  return deps.every(id => intentById(task, id)?.state === 'done')
}

/** 依赖是否已无可能完成（任一依赖落入终态死角）：供规划者识别死锁路线。 */
export function intentDepsDead(task, intent) {
  const deps = Array.isArray(intent?.dependsOn) ? intent.dependsOn : []
  return deps.some((id) => {
    const dep = intentById(task, id)
    return !dep || ['failed', 'exhausted', 'blocked'].includes(dep.state)
  })
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

export const MAX_FACTS = 2000
export const MAX_FINDINGS = 500
export const MAX_HINTS = 200

/** 长跑集合的硬上限：优先保留目标证据与 brief/analysis 的引用，其余淘汰最旧条目。 */
function trimCollection(task, key, max) {
  const list = task[key]
  if (!Array.isArray(list) || list.length <= max) return
  const protectedIds = new Set(task.goals.map(g => g.evidence).filter(Boolean))
  // brief/analysis 的 citations 与目标证据同权：否则 trim 后 brief 里的 fact#id 会悬空。
  // 但只认最近 MAX_CITATIONS 条——保护集本身不能无界（N30），旧快照里可能存着上千条。
  const recentCitations = (list) => (Array.isArray(list) ? list.slice(-MAX_CITATIONS) : [])
  for (const id of recentCitations(task.brief?.citations)) protectedIds.add(id)
  for (const id of recentCitations(task.analysis?.citations)) protectedIds.add(id)
  const keep = []
  for (let i = 0; i < list.length; i++) {
    if (i >= list.length - max || protectedIds.has(list[i].id)) keep.push(list[i])
  }
  task[key] = keep
}

export function recordFact(task, input) {
  const summary = String(input?.summary ?? '').trim()
  if (!summary) throw new Error('fact.summary 不能为空')
  const fact = {
    id: nextNodeId(task),
    summary,
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
  trimCollection(task, 'facts', MAX_FACTS)
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
    // 生命周期：open → verified / rejected（artex_retest_finding 驱动）。
    status: 'open',
    retests: [],
    createdAt: now(),
  }
  task.findings.push(finding)
  task.stats.findings += 1
  if (finding.intentId) {
    const intent = intentById(task, finding.intentId)
    if (intent) intent.writes.findings += 1
  }
  trimCollection(task, 'findings', MAX_FINDINGS)
  task.updatedAt = now()
  return finding
}

/** finding 复测闭环：open → verified / rejected；rejected 保留但计为无效。 */
export function retestFinding(task, id, result, note) {
  const finding = task.findings.find(f => f.id === Number(id))
  if (!finding) return { ok: false, error: `finding #${id} 不存在` }
  const verdict = ['verified', 'rejected', 'needs_retest'].includes(result) ? result : undefined
  if (!verdict) return { ok: false, error: `非法复测结论 "${result}"，允许：verified | rejected | needs_retest` }
  finding.status = verdict
  finding.retests.push({ result: verdict, note: note ? String(note) : '', at: now() })
  task.updatedAt = now()
  return { ok: true, finding }
}

/** 撤回一条事实：留档但不再可作证据；digest 里单独可见。 */
export function retractFact(task, id, reason) {
  const fact = task.facts.find(f => f.id === Number(id))
  if (!fact) return { ok: false, error: `fact #${id} 不存在` }
  if (fact.retracted) return { ok: false, error: `fact #${id} 已是撤回状态` }
  fact.retracted = true
  fact.retractedAt = now()
  fact.retractedReason = reason ? String(reason) : ''
  // 已经用这条事实证明过的目标必须回退：否则任务可以凭一条被撤回的证据判完成（N33）。
  const reopened = []
  for (const goal of task.goals) {
    if (Number(goal.evidence) !== fact.id) continue
    goal.status = 'open'
    goal.retractedEvidence = fact.id
    goal.evidence = undefined
    goal.evidenceOutcome = undefined
    goal.reason = 'evidence_retracted'
    reopened.push(goal.id)
  }
  if (reopened.length > 0) fact.reopenedGoals = reopened
  task.updatedAt = now()
  return { ok: true, fact, reopened }
}

const MAX_CONFLICTS = 200

/**
 * 结构化冲突记录：两条事实/发现给出相反结论时，保留双方并在图上互为 contradicts。
 * 由 worker（现场发现冲突）或 analyst（战略复审发现矛盾）显式落盘。
 */
export function recordConflict(task, input) {
  const a = Number(input?.a)
  const b = Number(input?.b)
  const kinds = { a: nodeKind(task, a), b: nodeKind(task, b) }
  const evid = new Set(['fact', 'finding'])
  if (!evid.has(kinds.a) || !evid.has(kinds.b) || a === b) {
    return { ok: false, error: `冲突双方必须是本任务里已存在的 fact/finding：#${a}(${kinds.a || '不存在'}) ↔ #${b}(${kinds.b || '不存在'})` }
  }
  task.conflicts = Array.isArray(task.conflicts) ? task.conflicts : []
  if (task.conflicts.length >= MAX_CONFLICTS) task.conflicts.shift()
  const conflict = {
    id: nextNodeId(task),
    a,
    b,
    kind: input.kind === 'supersedes' ? 'supersedes' : 'contradiction',
    note: input.note ? String(input.note) : '',
    createdAt: now(),
  }
  task.conflicts.push(conflict)
  for (const [node, other] of [[nodeById(task, a), b], [nodeById(task, b), a]]) {
    if (!node) continue
    node.contradicts = [...new Set([...(Array.isArray(node.contradicts) ? node.contradicts : []), other])]
  }
  task.updatedAt = now()
  return { ok: true, conflict }
}

export function addHint(task, text) {
  const hint = { id: nextNodeId(task), text: truncate(String(text).trim(), 2000), createdAt: now(), consumed: false }
  if (!hint.text) return undefined
  task.hints.push(hint)
  task.stats.hints += 1
  trimCollection(task, 'hints', MAX_HINTS)
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

/** 从正文里抽 "#12" 形式的引用：模型通常把依据写进正文，而不是 citations 参数（N29）。 */
function extractCitations(text) {
  const out = []
  for (const match of String(text || '').matchAll(/#(\d{1,9})/g)) out.push(Number(match[1]))
  return out
}

/** 规划者维护的全局认知：整体替换、按轮次版本化（与 todos 同为"综合"而非"追加"）。 */
export function setBrief(task, text, citations = []) {
  const clean = String(text || '').trim()
  if (!clean) return undefined
  const body = truncate(clean, 2000)
  task.brief = {
    text: body,
    round: task.round,
    updatedAt: now(),
    // 引用从落库正文里抽：超长正文被截断，抽截断之外的 id 只会让保护集虚增。
    citations: normalizeIds([...(Array.isArray(citations) ? citations : []), ...extractCitations(body)]).slice(-MAX_CITATIONS),
  }
  task.updatedAt = now()
  return task.brief
}

/** analyst 的独立分析：只读输入、单独存放，planner 决定是否采纳（不直接改 brief）。 */
export function setAnalysis(task, text, citations = []) {
  const clean = String(text || '').trim()
  if (!clean) return undefined
  const analysisBody = truncate(clean, 2000)
  task.analysis = {
    text: analysisBody,
    round: task.round,
    updatedAt: now(),
    citations: normalizeIds([...(Array.isArray(citations) ? citations : []), ...extractCitations(analysisBody)]).slice(-MAX_CITATIONS),
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

export function proveGoal(task, goalId, evidenceId, reason, options = {}) {
  const goal = task.goals.find(g => g.id === Number(goalId))
  if (!goal) return { ok: false, error: `goal #${goalId} 不存在` }
  if (goal.status === 'met') return { ok: false, error: `goal #${goalId} 已达成，不能重复证明` }
  const evidence = nodeById(task, evidenceId)
  const evidenceKind = nodeKind(task, evidenceId)
  if (!evidence || (evidenceKind !== 'fact' && evidenceKind !== 'finding')) {
    return { ok: false, error: `evidence_id #${evidenceId} 必须是本任务里已存在的事实(fact)或发现(finding)` }
  }
  if (evidence.outcome === 'blueprint') {
    return { ok: false, error: 'blueprint 只是备选路径，不能作为目标达成证据' }
  }
  if (evidence.retracted === true) {
    return { ok: false, error: `节点 #${evidenceId} 已被撤回（retracted），不能再作目标达成证据` }
  }
  if (evidence.outcome === 'none' && options.allowNegative !== true) {
    return { ok: false, error: 'outcome=none 是负结果；若目标本身是负向结论（如“无共享”），请显式传 allow_negative=true' }
  }
  if (evidence.confidence === 'inferred' && options.allowInferred !== true) {
    return { ok: false, error: 'confidence=inferred 的推断事实默认不能作证据：请先派意图升级为 observed/finding；确需放行请显式传 allow_inferred=true' }
  }
  goal.status = 'met'
  goal.evidence = Number(evidenceId)
  goal.evidenceOutcome = evidence.outcome || 'found'
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
