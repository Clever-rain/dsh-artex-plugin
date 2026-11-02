/**
 * 图操作门面：planner/worker 的写回动作（意图、事实、发现、brief、分析、目标）。
 */

import { oneLine } from './util.js'
import { intentById, danglingParents, findDuplicateFact, findSameSummaryFact, requestApproval as graphRequestApproval, resolveApproval as graphResolveApproval, normalizePolicy, intentAwaitingApproval } from './model.js'
import { admitTriggers, ingestTriggers, acceptTrigger, ignoreTrigger } from './triggers.js'
import { addIntents as graphAddIntents, addHint as graphAddHint, proveGoal as graphProveGoal, setTodos as graphSetTodos, setBrief as graphSetBrief, setAnalysis as graphSetAnalysis, promoteIntent as graphPromoteIntent, recordFact as graphRecordFact, reportFinding as graphReportFinding, retestFinding as graphRetestFinding, recordConflict as graphRecordConflict, retractFact as graphRetractFact } from './graph.js'
import { bindArtifacts, bindSteps } from './evidence.js'

function requireRunningIntent(task, intentId) {
  if (intentId == null) return null
  const intent = intentById(task, Number(intentId))
  if (!intent) throw new Error(`意图 #${intentId} 不存在`)
  if (intent.state !== 'running') throw new Error(`意图 #${intentId} 不在运行中（state=${intent.state}），不能挂写回`)
  return intent
}

/**
 * 写入前的锚点校验（与 ARTEX tools.go:1037-1066 同一道防线）：
 * - parents 必须指向已存在的 fact/finding（被 trim 淘汰的旧节点也不能再引用）；
 * - resource_ids 必须已登记在资源图里。
 * 校验失败整体拒绝（不留半批），错误信息直接给模型自纠。
 */
async function validateAnchors(engine, rt, { parents = [], resourceIds = [] } = {}) {
  const badParents = danglingParents(rt.task, parents)
  if (badParents.length > 0) {
    throw new Error(`parents 只能引用本任务已存在的 fact/finding：${badParents.map(id => `#${id}`).join(' ')} 不是有效的 fact/finding 节点（可能已被截断淘汰）`)
  }
  const ids = [...new Set((resourceIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0))]
  if (ids.length === 0) return
  const resources = engine.storeFor(rt.task.cwd).resources
  await resources.load()
  const missing = ids.filter(id => !resources.has(id))
  if (missing.length > 0) {
    throw new Error(`resource_ids 引用了不存在的资源：${missing.map(id => `#${id}`).join(' ')}（先用 artex_add_resource 登记，再引用其 id）`)
  }
}

export async function addIntents(engine, task, items, options = {}) {
    const rt = engine.runtimeForTask(task)
    for (const item of items) {
      await validateAnchors(engine, rt, {
        parents: item?.parents,
        resourceIds: item?.resource_ids ?? item?.resourceIds,
      })
      // 显式串行依赖：只能引用此前已存在的意图（同批内部暂不互引，跨轮加链更可控）。
      const deps = [...new Set([...(item?.depends_on ?? item?.dependsOn ?? [])].flat().map(Number).filter(n => Number.isFinite(n) && n > 0))]
      const missing = deps.filter(id => !intentById(rt.task, id))
      if (missing.length > 0) {
        throw new Error(`depends_on 引用了不存在的意图：${missing.map(id => `#${id}`).join(' ')}（先派前置意图，再挂依赖）`)
      }
      // 两级过滤接单前置校验：trigger 必须存在且可接（observe 模式在此硬拒）。
      const triggerId = item?.trigger_id ?? item?.triggerId
      if (triggerId != null) {
        const trigger = (rt.task.triggers || []).find(t => t.id === Number(triggerId))
        if (!trigger) throw new Error(`trigger_id #${triggerId} 不存在（先用 artex_emit 注入触发）`)
        const mode = rt.task.triggerMode === 'observe' || trigger.status === 'observed'
        if (mode) throw new Error(`trigger_mode=observe：trigger #${trigger.id} 只允许研判留档，不允许接单`)
        if (trigger.status !== 'pending') throw new Error(`trigger #${trigger.id} 已裁决（status=${trigger.status}）`)
      }
    }
    const results = graphAddIntents(rt.task, items, { max: options.max })
    const created = results.filter(r => r.id > 0).map(r => r.id)
    if (created.length > 0) {
      // Mandate 盖章（移植 dsh-superagent）：意图绑定创建时的 policyRev；
      // trigger 接单落终态（accepted + 绑定意图）。
      for (const r of results) {
        if (r.id <= 0) continue
        const intent = intentById(rt.task, r.id)
        if (intent) intent.mandateRev = rt.task.policyRev ?? 1
      }
      items.forEach((item, index) => {
        const triggerId = item?.trigger_id ?? item?.triggerId
        const intentId = results[index]?.id
        if (triggerId != null && intentId > 0) acceptTrigger(rt.task, triggerId, intentId)
      })
      engine.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'intent',
        summary: `新增意图 ${created.map(id => `#${id}`).join(' ')}`,
      })
      rt.stalls = 0
      // 默认不唤醒：仅工具层显式 notify:true（所有者手工派意图）才唤醒。
      if (options.notify === true) {
        engine.pushEvent(rt, { kind: 'intent', summary: `新增意图 ${created.map(id => `#${id}`).join(' ')}` })
      }
      void engine.persist(rt)
    }
    return results
  }

/** 订阅直通路由前缀：`#<intentId> 内容` 与显式 intent_id 参数等价。 */
const HINT_ROUTE_RE = /^#(\d+)\s*[:：]?\s+/

/**
 * 注入提示（移植 dsh-superagent 的订阅直通）：
 * - 带 intent_id（或文本以 `#<id>` 开头）且目标意图**正在运行** → 直接 nudge 该 worker
 *   子会话，**不唤醒 planner**（省下整轮规划的 token）；提示照常落 hints/activity，
 *   planner 下一轮自然苏醒时可见路由记录。
 * - 其余情况走原路径：进 hints 并唤醒 planner。
 * @returns {{hints: object[], routed: Array<{intentId: number}>, queued: number}}
 */
export function addHint(engine, task, texts, options = {}) {
    const rt = engine.runtimeForTask(task)
    const added = []
    const routed = []
    let queued = 0
    const items = Array.isArray(texts) ? texts : [texts]
    for (const raw of items) {
      let text = String(raw ?? '').trim()
      let targetId = options.intent_id ?? options.intentId ?? null
      const prefix = text.match(HINT_ROUTE_RE)
      if (targetId == null && prefix) {
        targetId = Number(prefix[1])
        text = text.slice(prefix[0].length).trim()
      }
      const hint = graphAddHint(rt.task, text)
      if (!hint) continue
      added.push(hint)
      // 直通判定：目标意图在跑（rt.children 里有活的 worker 子会话）才直投。
      const intent = targetId != null ? rt.task.intents.find(i => i.id === Number(targetId)) : null
      const childId = intent && intent.state === 'running' ? rt.children.get(`intent-${intent.id}`) : undefined
      if (intent && childId) {
        routed.push({ intentId: intent.id })
        engine.addActivity(rt, {
          intentId: intent.id,
          worker: 'human',
          kind: 'hint-routed',
          summary: `提示直通 worker（意图 #${intent.id}）：${oneLine(text, 120)}`,
        })
        void engine.nudge(rt, childId, `[订阅直通] 任务所有者给你的提示（不经过 planner，照常写回）：\n${text}`)
      } else {
        queued += 1
      }
    }
    if (added.length > 0) {
      if (queued > 0) {
        engine.addActivity(rt, { intentId: null, worker: 'human', kind: 'hint', summary: `新增提示：${oneLine(added.map(h => h.text).join('；'), 200)}` })
        engine.pushEvent(rt, { kind: 'hint', summary: added.map(h => oneLine(h.text, 100)).join('；') })
      }
      void engine.persist(rt)
    }
    return { hints: added, routed, queued }
  }

/* ------------------------------------------------------ 两级过滤：触发注入与裁决 */

/**
 * artex_emit 的核心（owner-only）：第一级确定性准入 → 落 task.triggers → auto 模式唤醒
 * planner（第二级 = 规划者接单/忽略，decision 全量留档）。
 */
export function emitTriggers(engine, task, items) {
    const rt = engine.runtimeForTask(task)
    const { admitted, decisions } = admitTriggers(rt.task, items)
    const ingested = ingestTriggers(rt.task, admitted)
    if (ingested.length > 0) {
      engine.addActivity(rt, {
        intentId: null,
        worker: 'human',
        kind: 'trigger',
        summary: `触发准入 ${ingested.length} 条：${ingested.map(t => `#${t.id}[${t.kind}]`).join(' ')}`,
        detail: decisions.map(d => `${d.decision}${d.reason ? `(${d.reason})` : ''}: ${d.text ?? ''}`).join('\n'),
      })
      // auto=pending 的触发唤醒第二级（planner）；observe 仅留档不唤醒（省 token，
      // planner 下次自然苏醒时评估，且接单被 acceptTrigger 硬拒）。
      const pending = ingested.filter(t => t.status === 'pending')
      if (pending.length > 0) {
        engine.pushEvent(rt, { kind: 'trigger', summary: `${pending.length} 条触发待裁决：${pending.map(t => `#${t.id}[${t.kind}] ${oneLine(t.text, 60)}`).join('；')}` })
      }
      void engine.persist(rt)
    }
    return { admitted: ingested, decisions }
  }

/** 规划者对触发做负裁决（接单走 artex_add_intent 的 trigger_id 正裁决）。 */
export function decideTrigger(engine, task, { trigger_id, reason = '' }) {
    const rt = engine.runtimeForTask(task)
    const trigger = ignoreTrigger(rt.task, trigger_id, reason)
    engine.addActivity(rt, {
      intentId: null,
      worker: 'planner',
      kind: 'trigger',
      summary: `触发 #${trigger.id} 被忽略${reason ? `：${oneLine(reason, 100)}` : ''}`,
    })
    void engine.persist(rt)
    return trigger
  }

/* ------------------------------------------------------ Mandate 版本化：策略热更新 */

/**
 * artex_update_policy 的核心（owner-only，移植 dsh-superagent 的 Policy 版本化）：
 * 合并补丁 → policyRev+1 → 吊销所有待审批授权（随旧 Mandate 失效）→ 唤醒 planner。
 * 领取闸（scheduler.dispatchWorkers）会把 mandateRev 过期的意图终结为 mandate_revoked。
 */
export function updatePolicy(engine, task, patch = {}) {
    const rt = engine.runtimeForTask(task)
    const oldRev = rt.task.policyRev ?? 1
    const current = rt.task.policy || {}
    // 合并：只接受白名单字段；normalizePolicy 负责清洗（与启动路径同一套规范化）。
    const merged = normalizePolicy({
      allowedTools: current.allowedTools,
      readOnly: current.readOnly,
      allowedPaths: current.allowedPaths,
      allowedTargets: current.allowedTargets,
      scopeEnforcement: current.scopeEnforcement,
      engagement: current.engagement,
      redactEvidence: current.redactEvidence,
      maxTokensPerIntent: current.maxTokensPerIntent,
      skillPacks: current.skillPacks,
      ...(patch.allowed_tools !== undefined ? { allowedTools: patch.allowed_tools } : {}),
      ...(patch.allowed_targets !== undefined ? { allowedTargets: patch.allowed_targets } : {}),
      ...(patch.read_only !== undefined ? { readOnly: patch.read_only } : {}),
      ...(patch.allowed_paths !== undefined ? { allowedPaths: patch.allowed_paths } : {}),
      ...(patch.scope_enforcement !== undefined ? { scopeEnforcement: patch.scope_enforcement } : {}),
      ...(patch.max_tokens_per_intent !== undefined ? { maxTokensPerIntent: patch.max_tokens_per_intent } : {}),
    })
    rt.task.policy = merged
    if (Array.isArray(patch.constraints)) {
      rt.task.constraints = patch.constraints.map(c => String(c).trim()).filter(Boolean)
    }
    if (patch.trigger_mode !== undefined) {
      if (!['off', 'observe', 'auto'].includes(patch.trigger_mode)) {
        throw new Error(`trigger_mode 只能是 off/observe/auto，收到 ${patch.trigger_mode}`)
      }
      rt.task.triggerMode = patch.trigger_mode
    }
    const newRev = oldRev + 1
    rt.task.policyRev = newRev
    // 吊销待审批授权：旧 Mandate 签发的批准一律失效（superagent：mandateRevoked）。
    let revoked = 0
    for (const intent of rt.task.intents) {
      if (intentAwaitingApproval(intent)) {
        intent.approval.pending = false
        intent.approval.decision = { result: 'revoked', note: `policyRev ${oldRev}→${newRev}，授权随策略变更失效`, at: Date.now() }
        revoked += 1
      }
    }
    engine.addActivity(rt, {
      intentId: null,
      worker: 'human',
      kind: 'policy',
      summary: `策略更新：policyRev ${oldRev}→${newRev}${revoked > 0 ? `，吊销 ${revoked} 项待审批授权` : ''}`,
      detail: Object.keys(patch).map(k => `${k}=${JSON.stringify(patch[k]).slice(0, 120)}`).join('\n'),
    })
    engine.pushEvent(rt, { kind: 'policy', summary: `策略已变更（rev ${oldRev}→${newRev}）：旧 Mandate 意图将在领取时被吊销，请按新策略重派` })
    void engine.persist(rt)
    return { policyRev: newRev, revokedApprovals: revoked, policy: merged }
  }

export function proveGoal(engine, task, goalId, evidenceId, reason, allowNegative = false, options = {}) {
    const rt = engine.runtimeForTask(task)
    const result = graphProveGoal(rt.task, goalId, evidenceId, reason, { allowNegative, allowInferred: options.allowInferred === true })
    if (result.ok) {
      engine.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'goal',
        summary: `目标 #${goalId} 标记达成（证据 #${evidenceId}）`,
        detail: reason || '',
      })
      // 默认唤醒：所有者证明目标后必须让主循环立刻收敛（首轮 P0-3）。
      // 规划者自己证的由本轮返回后的 allGoalsMet 检查兜底，不必再烧一轮。
      if (options.notify !== false) {
        engine.pushEvent(rt, { kind: 'goal', summary: `目标 #${goalId} 已证明` })
      }
      void engine.persist(rt)
    }
    return result
  }

export function setTodos(engine, task, items) {
    const rt = engine.runtimeForTask(task)
    const todos = graphSetTodos(rt.task, items)
    void engine.persist(rt)
    return todos
  }

  /** 规划者维护全局认知：整体替换、按轮次版本化。 */

export function setBrief(engine, task, text, citations) {
    const rt = engine.runtimeForTask(task)
    const brief = graphSetBrief(rt.task, text, citations)
    if (brief) {
      engine.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'brief',
        summary: `更新全局认知（第 ${brief.round} 轮）`,
        detail: brief.text,
      })
      void engine.persist(rt)
    }
    return brief
  }

  /** 把 blueprint 提升为 open，进入 frontier。 */

export function setAnalysis(engine, task, text, citations) {
    const rt = engine.runtimeForTask(task)
    const analysis = graphSetAnalysis(rt.task, text, citations)
    if (analysis) {
      engine.addActivity(rt, {
        intentId: null,
        worker: 'analyst',
        kind: 'analysis',
        summary: `提交独立分析（第 ${analysis.round} 轮）`,
        detail: analysis.text,
      })
      void engine.persist(rt)
    }
    return analysis
  }

  /* ---------------------------------------------------------------- worker */

export function promoteIntent(engine, task, intentId, options = {}) {
    const rt = engine.runtimeForTask(task)
    const result = graphPromoteIntent(rt.task, intentId)
    if (result.ok) {
      engine.addActivity(rt, {
        intentId: result.intent.id,
        worker: 'planner',
        kind: 'promote',
        summary: `蓝图提升为 open：#${result.intent.id}`,
      })
      if (options.notify !== false) {
        engine.pushEvent(rt, { kind: 'intent', summary: `蓝图 #${result.intent.id} 提升为 open` })
      }
      void engine.persist(rt)
    }
    return result
  }

export function roleForIntent(engine, taskId, intentId) {
    if (!intentId) return undefined
    for (const role of engine.roles.values()) {
      if (role.taskId === taskId && role.intentId === Number(intentId)) return role
    }
    return undefined
  }

/* ---------------------------------------------------------------- approval */

/** worker/planner 请求人工审批：意图挂起（pending），owner 裁决前不会被领取。 */
export function requestApproval(engine, task, intentId, request = {}) {
    const rt = engine.runtimeForTask(task)
    const intent = graphRequestApproval(rt.task, intentId, request)
    // Mandate 盖章：审批授权绑定当前 policyRev，策略变更时被 updatePolicy 整体吊销。
    intent.approval.request.rev = rt.task.policyRev ?? 1
    engine.addActivity(rt, {
      intentId: intent.id,
      worker: request.by || 'worker',
      kind: 'approval',
      summary: `意图 #${intent.id} 请求人工审批：${oneLine(request.reason || request.action || '', 120)}`,
      detail: `动作：${request.action || '-'}\n理由：${request.reason || '-'}`,
    })
    engine.pushEvent(rt, { kind: 'approval', summary: `意图 #${intent.id} 等待人工审批` })
    void engine.persist(rt)
    return intent
  }

/** owner 裁决审批：approve 恢复派发；reject 终止意图。 */
export function resolveApproval(engine, task, intentId, decision, note = '') {
    const rt = engine.runtimeForTask(task)
    const { intent, decision: result } = graphResolveApproval(rt.task, intentId, decision, note)
    engine.addActivity(rt, {
      intentId: intent.id,
      worker: 'human',
      kind: 'approval',
      summary: `意图 #${intent.id} 审批${result === 'approved' ? '通过' : '被拒'}${note ? `：${oneLine(note, 120)}` : ''}`,
      detail: note || '',
    })
    engine.pushEvent(rt, { kind: 'approval', summary: `意图 #${intent.id} 审批${result === 'approved' ? '通过' : '被拒'}` })
    void engine.persist(rt)
    return { intent, decision: result }
  }

export async function recordFacts(engine, task, entries, intentId) {
    const rt = engine.runtimeForTask(task)
    const targetId = intentId ?? entries[0]?.intentId ?? entries[0]?.intent_id ?? null
    requireRunningIntent(rt.task, targetId)
    for (const entry of entries) {
      if (!String(entry?.summary ?? '').trim()) throw new Error('每条 fact 的 summary 都不能为空')
    }
    await validateAnchors(engine, rt, { resourceIds: entries.flatMap(e => e.resourceIds ?? e.resource_ids ?? []) })
    // 证据硬门禁：outcome=found 必须能给得出证据（P0-3）；"看起来像"写成 inferred 而不是 found。
    for (const entry of entries) {
      if (entry?.outcome === 'found' && !String(entry.evidence ?? '').trim()) {
        throw new Error('outcome=found 的事实必须给 evidence（命令输出/返回体等复现凭据）；推断请落 inferred')
      }
    }
    const facts = []
    const duplicates = []
    for (const entry of entries) {
      // 服务端去重：规范化 summary + 相同结局命中近期窗口时跳过重写，返回已有节点。
      // stats / intent.writes / outcomes 都不重计——重复证据不改变图景。
      // 结局不同 = 新证据（audit 里"先判无、重测命中"是常态），不能当重复丢掉（N26）。
      const dup = findDuplicateFact(rt.task, entry.summary, 0, entry.outcome)
      if (dup) {
        duplicates.push(dup)
        continue
      }
      const prior = findSameSummaryFact(rt.task, entry.summary)
      const recorded = graphRecordFact(rt.task, {
        summary: entry.summary,
        detail: entry.detail,
        evidence: entry.evidence,
        confidence: entry.confidence,
        outcome: entry.outcome,
        resourceIds: entry.resourceIds ?? entry.resource_ids,
        intentId: targetId,
      })
      // 同文不同结局：保留新证据，并双向标注取代关系，报告里能看出结论被翻过。
      if (prior && prior.outcome !== recorded.outcome && rt.task.facts.includes(prior)) {
        recorded.supersedes = prior.id
        prior.supersededBy = recorded.id
      }
      facts.push(recorded)
    }
    if (facts.length > 0) {
      const role = engine.roleForIntent(task.id, facts[0].intentId)
      if (role) {
        role.writes.facts += facts.length
        for (const fact of facts) {
          if (fact.outcome) {
            role.writes.outcomes = role.writes.outcomes || { found: 0, none: 0, inconclusive: 0, blueprint: 0 }
            role.writes.outcomes[fact.outcome] += 1
          }
        }
      }
      engine.addActivity(rt, {
        intentId: targetId,
        worker: 'worker',
        kind: 'fact',
        summary: facts.map(f => `#${f.id} ${oneLine(f.summary, 80)}`).join('；'),
        detail: facts.map(f => `#${f.id} ${f.summary}\n${f.detail || ''}\n${f.evidence || ''}`).join('\n\n'),
      })
      // 证据即时落盘（不等待合并写窗口），崩溃也只丢元数据指针；不唤醒规划者。
      void engine.persistEvidence?.(rt)
      void engine.persist(rt)
    }
    return { facts, duplicates }
  }

export async function recordFinding(engine, task, input) {
    const rt = engine.runtimeForTask(task)
    const targetId = input.intentId ?? input.intent_id ?? null
    requireRunningIntent(rt.task, targetId)
    await validateAnchors(engine, rt, { resourceIds: input.resourceIds ?? input.resource_ids })
    // 证据硬门禁：finding 必须有可复现证据（P0-3），不然只是"看着像"。
    if (!String(input.evidence ?? '').trim()) {
      throw new Error('report_finding 必须给 evidence：发现是已验证成果，需要可复现凭据（命令/回包/复现步骤）。没复现的请记为 inferred fact。')
    }
    // 原始证据绑定：步骤锚点 + 工件哈希（P1-1）。校验失败整体拒绝，finding 不入库。
    let evidenceRefs
    const refs = input.evidence_refs ?? input.evidenceRefs
    if (refs && typeof refs === 'object') {
      const steps = bindSteps(rt.task, refs.steps)
      const artifacts = refs.artifacts !== undefined
        ? await bindArtifacts(rt.task.cwd, refs.artifacts)
        : undefined
      evidenceRefs = {
        ...(steps.length > 0 ? { steps } : {}),
        ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
      }
      if (!evidenceRefs.steps && !evidenceRefs.artifacts) evidenceRefs = undefined
    }
    const finding = graphReportFinding(rt.task, { ...input, intentId: targetId, evidenceRefs })
    const role = engine.roleForIntent(task.id, finding.intentId)
    if (role) role.writes.findings += 1
    engine.addActivity(rt, {
      intentId: finding.intentId,
      worker: 'worker',
      kind: 'finding',
      summary: `发现 #${finding.id} ${oneLine(finding.title, 100)}`,
      detail: `${finding.detail || ''}\n${finding.evidence || ''}`,
    })
    // 发现是最高价值证据：先即时落盘，再唤醒规划者（不等合并写窗口）。
    void engine.persistEvidence?.(rt)
    // 独立 verifier：按 finding 触发、串行复核、只验证不参与规划。
    engine.queueVerifier?.(rt, finding)
    engine.pushEvent(rt, {
      kind: 'finding',
      intentId: finding.intentId,
      summary: `#${finding.id} ${oneLine(finding.title, 120)}（severity=${finding.severity}）`,
    })
    void engine.persist(rt)
    return finding
  }

export async function addResources(engine, task, items, role) {
    const rt = engine.runtimeForTask(task)
    const stores = engine.storeFor(rt.task.cwd)
    const results = await stores.resources.upsert(items, rt.task.id)
    const created = results.filter(r => r.created)
    if (created.length > 0) {
      rt.task.stats.resources += created.length
      if (role && role.writes) role.writes.resources += created.length
      engine.addActivity(rt, {
        intentId: role?.intentId ?? null,
        worker: role?.role ?? 'worker',
        kind: 'resource',
        summary: `登记资源 ${created.map(r => `#${r.id} ${r.name}`).join('；')}`,
      })
      void engine.persist(rt)
    }
    return results
  }

export function runtimeForTask(engine, task) {
    const rt = engine.tasks.get(task.id)
    if (!rt) throw new Error(`ARTEX 任务 ${task.id} 已结束，不能再写入（可用 artex_task_status 查看快照）`)
    if (rt.finished) throw new Error(`ARTEX 任务 ${task.id} 已结束（${task.status}），不能再写入`)
    return rt
  }

  /* ----------------------------------------------------------- lifecycle */

/** finding 复测闭环（verifier/planner/owner）：状态落到节点上随快照持久化。 */
export function retestFinding(engine, task, input, options = {}) {
    const rt = engine.runtimeForTask(task)
    const result = graphRetestFinding(rt.task, input.finding_id ?? input.findingId, input.result, input.note)
    if (!result.ok) throw new Error(result.error)
    engine.addActivity(rt, {
      intentId: result.finding.intentId ?? null,
      worker: options.worker || 'verifier',
      kind: 'verify',
      summary: `finding #${result.finding.id} 复测为 ${input.result}${input.note ? `：${oneLine(input.note, 120)}` : ''}`,
      detail: input.note || '',
    })
    void engine.persistEvidence?.(rt)
    void engine.persist(rt)
    return result.finding
  }

/** 结构化冲突记录：两条节点给相反结论时，保留双方并在图上互为 contradicts。 */
export function recordConflict(engine, task, input) {
    const rt = engine.runtimeForTask(task)
    const result = graphRecordConflict(rt.task, input)
    if (!result.ok) throw new Error(result.error)
    engine.addActivity(rt, {
      intentId: input.intentId ?? input.intent_id ?? null,
      worker: input.worker || 'analyst',
      kind: 'conflict',
      summary: `冲突 #${result.conflict.id}：#${result.conflict.a} ↔ #${result.conflict.b}`,
      detail: input.note || '',
    })
    // 冲突即规划信号：让 planner 立刻看到矛盾，不要等下一轮巡检。
    engine.pushEvent(rt, { kind: 'conflict', summary: `证据冲突 #${result.conflict.a} ↔ #${result.conflict.b}` })
    void engine.persist(rt)
    return result.conflict
  }

/** 撤回一条事实：留档但 prove_goal 拒绝使用（纠正旧图，不假装没发生过）。 */
export function retractFact(engine, task, input) {
    const rt = engine.runtimeForTask(task)
    const result = graphRetractFact(rt.task, input.fact_id ?? input.factId, input.reason)
    if (!result.ok) throw new Error(result.error)
    const reopened = Array.isArray(result.reopened) ? result.reopened : []
    engine.addActivity(rt, {
      intentId: result.fact.intentId ?? null,
      worker: input.worker || 'planner',
      kind: 'retract',
      summary: `撤回 fact #${result.fact.id}${reopened.length > 0 ? `，目标 #${reopened.join(' #')} 回退 open` : ''}${input.reason ? `：${oneLine(input.reason, 120)}` : ''}`,
      detail: input.reason || '',
    })
    engine.pushEvent(rt, { kind: 'fact', summary: `fact #${result.fact.id} 已撤回${reopened.length > 0 ? `，目标 #${reopened.join(' #')} 需重新证明` : ''}` })
    void engine.persistEvidence?.(rt)
    void engine.persist(rt)
    return result.fact
  }

  /* -------------------------------------------------------------- session events */

  /**
   * 把 worker 子会话的工具调用/结果索引成过程库（ARTEX activity），
   * 让其它 work 能按关键字回看，而不是只看最终结论。
   */
