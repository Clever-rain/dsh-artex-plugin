/**
 * 图操作门面：planner/worker 的写回动作（意图、事实、发现、brief、分析、目标）。
 */

import { oneLine } from './util.js'
import { intentById } from './model.js'
import { addIntents as graphAddIntents, addHint as graphAddHint, proveGoal as graphProveGoal, setTodos as graphSetTodos, setBrief as graphSetBrief, setAnalysis as graphSetAnalysis, promoteIntent as graphPromoteIntent, recordFact as graphRecordFact, reportFinding as graphReportFinding } from './graph.js'

function requireRunningIntent(task, intentId) {
  if (intentId == null) return null
  const intent = intentById(task, Number(intentId))
  if (!intent) throw new Error(`意图 #${intentId} 不存在`)
  if (intent.state !== 'running') throw new Error(`意图 #${intentId} 不在运行中（state=${intent.state}），不能挂写回`)
  return intent
}

export function addIntents(engine, task, items, options = {}) {
    const rt = engine.runtimeForTask(task)
    const results = graphAddIntents(rt.task, items)
    const created = results.filter(r => r.id > 0).map(r => r.id)
    if (created.length > 0) {
      engine.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'intent',
        summary: `新增意图 ${created.map(id => `#${id}`).join(' ')}`,
      })
      rt.stalls = 0
      // planner 在自己这一轮里派意图不需要再唤醒自己；所有者手工派意图仍唤醒。
      if (options.notify !== false) {
        engine.pushEvent(rt, { kind: 'intent', summary: `新增意图 ${created.map(id => `#${id}`).join(' ')}` })
      }
      void engine.persist(rt)
    }
    return results
  }

export function addHint(engine, task, texts) {
    const rt = engine.runtimeForTask(task)
    const added = []
    for (const text of texts) {
      const hint = graphAddHint(rt.task, text)
      if (hint) added.push(hint)
    }
    if (added.length > 0) {
      engine.addActivity(rt, { intentId: null, worker: 'human', kind: 'hint', summary: `新增提示：${oneLine(added.map(h => h.text).join('；'), 200)}` })
      engine.pushEvent(rt, { kind: 'hint', summary: added.map(h => oneLine(h.text, 100)).join('；') })
      void engine.persist(rt)
    }
    return added
  }

export function proveGoal(engine, task, goalId, evidenceId, reason, allowNegative = false) {
    const rt = engine.runtimeForTask(task)
    const result = graphProveGoal(rt.task, goalId, evidenceId, reason, { allowNegative })
    if (result.ok) {
      engine.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'goal',
        summary: `目标 #${goalId} 标记达成（证据 #${evidenceId}）`,
        detail: reason || '',
      })
      engine.pushEvent(rt, { kind: 'goal', summary: `目标 #${goalId} 已证明` })
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

export function promoteIntent(engine, task, intentId) {
    const rt = engine.runtimeForTask(task)
    const result = graphPromoteIntent(rt.task, intentId)
    if (result.ok) {
      engine.addActivity(rt, {
        intentId: result.intent.id,
        worker: 'planner',
        kind: 'promote',
        summary: `蓝图提升为 open：#${result.intent.id}`,
      })
      engine.pushEvent(rt, { kind: 'intent', summary: `蓝图 #${result.intent.id} 提升为 open` })
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

export function recordFacts(engine, task, entries, intentId) {
    const rt = engine.runtimeForTask(task)
    const targetId = intentId ?? entries[0]?.intentId ?? entries[0]?.intent_id ?? null
    requireRunningIntent(rt.task, targetId)
    for (const entry of entries) {
      if (!String(entry?.summary ?? '').trim()) throw new Error('每条 fact 的 summary 都不能为空')
    }
    const facts = entries.map(entry => graphRecordFact(rt.task, {
      summary: entry.summary,
      detail: entry.detail,
      evidence: entry.evidence,
      confidence: entry.confidence,
      outcome: entry.outcome,
      resourceIds: entry.resourceIds ?? entry.resource_ids,
      intentId: targetId,
    }))
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
      // 不唤醒：事实是高频进度数据，由 done/finding/goal 统一带出，避免每批事实烧一个规划轮。
      void engine.persist(rt)
    }
    return facts
  }

export function recordFinding(engine, task, input) {
    const rt = engine.runtimeForTask(task)
    const targetId = input.intentId ?? input.intent_id ?? null
    requireRunningIntent(rt.task, targetId)
    const finding = graphReportFinding(rt.task, { ...input, intentId: targetId })
    const role = engine.roleForIntent(task.id, finding.intentId)
    if (role) role.writes.findings += 1
    engine.addActivity(rt, {
      intentId: finding.intentId,
      worker: 'worker',
      kind: 'finding',
      summary: `发现 #${finding.id} ${oneLine(finding.title, 100)}`,
      detail: `${finding.detail || ''}\n${finding.evidence || ''}`,
    })
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

  /* -------------------------------------------------------------- session events */

  /**
   * 把 worker 子会话的工具调用/结果索引成过程库（ARTEX activity），
   * 让其它 work 能按关键字回看，而不是只看最终结论。
   */
