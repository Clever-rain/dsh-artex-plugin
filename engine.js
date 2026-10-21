/**
 * ARTEX 编排引擎：事件驱动的 planner / worker 闭环。
 *
 * 与 ARTEX（Go）的对应关系：
 *   plannerLoop      -> runLoop + plannerRound（每轮一个全新 planner 子会话）
 *   workerLoop × N   -> dispatchWorkers（并发上限 maxWorkers）
 *   frontier         -> task.intents 里 state==='open' 的节点
 *   debounce(800ms)  -> waitEvent + debounceMs
 *   heartbeat(≥600s) -> waitEvent 超时触发一轮巡检
 *   NotifyDone       -> finishWorker -> pushEvent({kind:'done'})
 *   NotifyFinding    -> reportFinding -> pushEvent({kind:'finding'})
 *   settlement       -> 超时先发收尾消息，宽限期后 interrupt
 *   KillWork/Steer   -> subagents.interrupt / subagents.sendMessage
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import {
  TaskStore, ResourceStore, TaskIndex,
  createTask, addIntents as graphAddIntents, addActivity as graphAddActivity, addHint as graphAddHint,
  claimIntent, finishIntent, allGoalsMet, plannerView, workerView, recordFact as graphRecordFact,
  reportFinding as graphReportFinding, setTodos as graphSetTodos, proveGoal as graphProveGoal,
  digestOf, deltaOf, setBrief as graphSetBrief, promoteIntent as graphPromoteIntent,
  setAnalysis as graphSetAnalysis,
  openIntents, runningIntents,
} from './graph.js'
import { plannerPrompt, workerPrompt, analystPrompt, settlePrompt, siblingStopPrompt, formatReport } from './prompts.js'
import { interruptChildren as interruptChildrenImpl, interruptChild as interruptChildImpl, runChild as runChildImpl, awaitChild as awaitChildImpl, outcome as outcomeImpl, abortOnly as abortOnlyImpl, abortOrTimeout as abortOrTimeoutImpl, nudge as nudgeImpl } from './runner.js'
import { runLoop as runLoopImpl, finish as finishImpl, completeGracefully as completeGracefullyImpl, beginSettling as beginSettlingImpl, drain as drainImpl, plannerRound as plannerRoundImpl, dispatchWorkers as dispatchWorkersImpl, runWorker as runWorkerImpl, finishWorker as finishWorkerImpl, pushEvent as pushEventImpl, wake as wakeImpl, waitEvent as waitEventImpl, sleepOrAbort as sleepOrAbortImpl } from './scheduler.js'
import { maybeRunAnalyst as maybeRunAnalystImpl } from './analyst.js'
import { recordUsage as recordUsageImpl } from './usage.js'
import { oneLine, sleep, textOf } from './util.js'
import { normalizeConfig } from './config.js'
import { TOOL_NAMES, denyForRole } from './policy.js'

export { DEFAULTS } from './config.js'


/** 任务模式优先级：任务参数 > 插件配置 > objective。 */
export function resolveTaskMode(taskMode, configMode) {
  if (taskMode) return taskMode === 'audit' ? 'audit' : 'objective'
  return configMode === 'audit' ? 'audit' : 'objective'
}

export class ArtexEngine {
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    const normalized = normalizeConfig(config || {}, logger)
    this.config = normalized.config
    this.logger = logger || console
    this.tasks = new Map() // taskId -> runtime
    this.roles = new Map() // child sessionId -> { taskId, role, intentId, writes, pending }
    this.stores = new Map() // cwd -> { tasks: TaskStore, resources: ResourceStore }
    this.index = new TaskIndex(this.config.indexPath, {
      onError: (error) => this.logger.warn?.(`[artex] task index error: ${error?.message || error}`),
    })
    this.providerName = this.config.provider
    this.disposed = false
    this.toolNames = [...TOOL_NAMES]
  }

  /** 真实注册的工具名（index.js 注册后注入；缺省用 policy 的静态清单）。 */
  setToolNames(names) {
    if (Array.isArray(names) && names.length > 0) this.toolNames = [...names]
  }

  denyFor(role) {
    return denyForRole(role, this.toolNames)
  }

  get subagents() {
    return this.ctx.subagents
  }

  /* ------------------------------------------------------------- plumbing */

  storeFor(cwd) {
    let entry = this.stores.get(cwd)
    if (!entry) {
      entry = {
        tasks: new TaskStore(cwd, { onError: (error) => this.logger.warn?.(`[artex] snapshot save failed: ${error?.message || error}`) }),
        resources: new ResourceStore(cwd),
      }
      this.stores.set(cwd, entry)
    }
    return entry
  }

  async cwdFor(agent, signal) {
    const wd = typeof this.ctx.get === 'function' ? this.ctx.get('workingDirectory') : undefined
    if (wd && typeof wd.ensure === 'function') {
      try {
        return await wd.ensure(agent, signal)
      } catch {
        // 落到 session header。
      }
    }
    return agent?.session?.header?.cwd || process.cwd()
  }

  resolveProvider() {
    const names = this.subagents.list()
    if (names.includes(this.providerName)) return this.providerName
    if (names.includes('spawn')) return 'spawn'
    if (names.length > 0) return names[0]
    throw new Error('ARTEX 需要至少一个本地 subagent provider（例如 spawn），当前一个都没有注册')
  }

  roleOf(sessionId) {
    return sessionId ? this.roles.get(sessionId) : undefined
  }

  liveTask(taskId) {
    return this.tasks.get(String(taskId))
  }

  async loadTask(taskId) {
    const id = String(taskId)
    // 先查全局索引（跨 cwd），再回退到本进程已知的 workspace。
    const cwd = await this.index.lookup(id)
    if (cwd) {
      try {
        return await this.storeFor(cwd).tasks.load(id)
      } catch {
        // 索引过期（目录被删/移动），继续回退。
      }
    }
    for (const entry of this.stores.values()) {
      try {
        return await entry.tasks.load(id)
      } catch {
        // 换下一个 workspace 根。
      }
    }
    return undefined
  }

  async resolveTask(taskId) {
    const live = this.liveTask(taskId)
    if (live) return live.task
    const stored = await this.loadTask(taskId)
    if (!stored) throw new Error(`ARTEX 任务 ${taskId} 不存在`)
    return stored
  }

  /* --------------------------------------------------------------- lifecycle */

  async startTask({ agent, goal, description, goals, constraints, mode, viewMode, analyst, limits = {}, signal }) {
    if (this.disposed) throw new Error('ARTEX 插件已卸载')
    if (!agent) throw new Error('ARTEX 需要调用它的 agent 会话')
    if (!String(goal || '').trim()) throw new Error('goal 不能为空')
    this.providerName = this.resolveProvider()
    // 开关优先级：任务级 analyst / 插件级 enableHybrid 任一关闭 → planner；
    // 否则按任务 view_mode > 插件 viewMode > hybrid 生效。
    const requestedView = ['planner', 'hybrid', 'analyst'].includes(viewMode)
      ? viewMode
      : this.config.viewMode
    const effectiveView = (this.config.enableHybrid === false || analyst === false)
      ? 'planner'
      : (['planner', 'hybrid', 'analyst'].includes(requestedView) ? requestedView : 'hybrid')
    const cwd = await this.cwdFor(agent, signal)
    const stores = this.storeFor(cwd)
    const id = `t${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    const effectiveMode = resolveTaskMode(mode, this.config.mode)
    const merged = {
      ...this.config,
      ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined && v !== null)),
    }
    const task = createTask({
      id,
      description,
      goal: String(goal).trim(),
      goals,
      constraints,
      mode: effectiveMode,
      viewMode: effectiveView,
      ownerSession: agent.id,
      cwd,
      outDir: stores.tasks.taskDir(id),
      limits: {
        maxWorkers: Math.max(0, Number(merged.maxWorkers) || 0),
        maxRounds: Math.max(1, Number(merged.maxRounds) || 1),
        maxStalls: Math.max(1, Number(merged.maxStalls) || 1),
        debounceMs: Math.max(50, Number(merged.debounceMs) || 800),
        heartbeatMs: Math.max(1000, Number(merged.heartbeatMs) || 600000),
        workerTimeoutMs: Math.max(0, Number(merged.workerTimeoutMs) || 0),
        plannerTimeoutMs: Math.max(0, Number(merged.plannerTimeoutMs) || 0),
        settleGraceMs: Math.max(0, Number(merged.settleGraceMs) || 0),
        breakthroughGraceMs: Math.max(0, Number(merged.breakthroughGraceMs) || 0),
        budgetMs: Math.max(0, Number(merged.budgetMs) || 0),
      },
    })
    const rt = {
      task,
      ownerAgent: agent,
      abort: new AbortController(),
      events: [],
      waiters: [],
      running: new Map(),
      children: new Map(),
      stalls: 0,
      settling: false,
      completing: false,
      finalProofDone: false,
      siblingStops: new Set(),
      viewMode: effectiveView,
      analystRuns: 0,
      lastAnalystAt: 0,
      lastAnalystFactCount: 0,
      lastAnalystRound: 0,
      finished: false,
      startedAt: Date.now(),
      done: undefined,
      doneResolve: undefined,
      loop: undefined,
      deadlineTimer: undefined,
      finishedStatus: undefined,
      finishDetail: undefined,
    }
    rt.done = new Promise((resolve) => { rt.doneResolve = resolve })
    this.tasks.set(id, rt)
    this.evictOld()
    await stores.tasks.save(task)
    await this.index.register(task).catch(() => undefined)
    rt.loop = this.runLoop(rt).catch((error) => {
      this.logger.warn?.(`[artex] task ${id} loop failed: ${error?.message || error}`)
      if (!rt.finished) this.finish(rt, 'failed', String(error?.message || error))
    })
    if (task.limits.budgetMs > 0) {
      rt.deadlineTimer = setTimeout(() => { void this.beginSettling(rt) }, task.limits.budgetMs)
      rt.deadlineTimer.unref?.()
    }
    return rt
  }

  evictOld() {
    if (this.tasks.size <= 24) return
    for (const [id, rt] of this.tasks) {
      if (rt.finished) this.tasks.delete(id)
      if (this.tasks.size <= 24) break
    }
  }

  async stopTask(taskId, reason = '用户/主 agent 停止') {
    const rt = this.liveTask(taskId)
    if (!rt || rt.finished) return false
    rt.finishedStatus = 'stopped'
    rt.finishDetail = reason
    this.interruptChildren(rt)
    rt.abort.abort(reason)
    return true
  }

  async dispose() {
    this.disposed = true
    for (const rt of this.tasks.values()) {
      try { rt.abort.abort('plugin disposed') } catch { /* already aborted */ }
      this.interruptChildren(rt)
    }
    await Promise.race([
      Promise.allSettled([...this.tasks.values()].map(rt => rt.done)),
      sleep(3000),
    ])
    // 把合并写队列里尚未落盘的快照刷掉，避免插件卸载丢最近状态。
    await Promise.race([
      Promise.allSettled([...this.stores.values()].map(entry => entry.tasks.flushAll())),
      sleep(2000),
    ])
  }

  interruptChildren(rt) {
    return interruptChildrenImpl(this, rt)
  }

  interruptChild(rt, childId) {
    return interruptChildImpl(this, rt, childId)
  }

  async runLoop(rt) {
    return runLoopImpl(this, rt)
  }

  finish(rt, status, detail) {
    return finishImpl(this, rt, status, detail)
  }
  async completeGracefully(rt, detail) {
    return completeGracefullyImpl(this, rt, detail)
  }

  beginSettling(rt) {
    return beginSettlingImpl(this, rt)
  }

  async drain(rt, graceMs) {
    return drainImpl(this, rt, graceMs)
  }

  async plannerRound(rt, triggers, options = {}) {
    return plannerRoundImpl(this, rt, triggers, options)
  }
  async maybeRunAnalyst(rt, triggers = []) {
    return maybeRunAnalystImpl(this, rt, triggers)
  }
  setAnalysis(task, text, citations) {
    const rt = this.runtimeForTask(task)
    const analysis = graphSetAnalysis(rt.task, text, citations)
    if (analysis) {
      this.addActivity(rt, {
        intentId: null,
        worker: 'analyst',
        kind: 'analysis',
        summary: `提交独立分析（第 ${analysis.round} 轮）`,
        detail: analysis.text,
      })
      void this.persist(rt)
    }
    return analysis
  }

  /* ---------------------------------------------------------------- worker */

  dispatchWorkers(rt) {
    return dispatchWorkersImpl(this, rt)
  }

  async runWorker(rt, intent, workerName) {
    return runWorkerImpl(this, rt, intent, workerName)
  }

  finishWorker(rt, intent, outcome) {
    return finishWorkerImpl(this, rt, intent, outcome)
  }

  async runChild(rt, spec) {
    return runChildImpl(this, rt, spec)
  }

  async awaitChild(rt, activation, spec, role) {
    return awaitChildImpl(this, rt, activation, spec, role)
  }

  outcome(result, role, timedOut) {
    return outcomeImpl(this, result, role, timedOut)
  }

  abortOnly(rt) {
    return abortOnlyImpl(this, rt)
  }

  abortOrTimeout(rt, ms) {
    return abortOrTimeoutImpl(this, rt, ms)
  }

  async nudge(rt, childId, text) {
    return nudgeImpl(this, rt, childId, text)
  }

  pushEvent(rt, event) {
    return pushEventImpl(this, rt, event)
  }

  wake(rt, kind) {
    return wakeImpl(this, rt, kind)
  }

  waitEvent(rt, timeoutMs) {
    return waitEventImpl(this, rt, timeoutMs)
  }

  sleepOrAbort(rt, ms) {
    return sleepOrAbortImpl(this, rt, ms)
  }

  addActivity(rt, input) {
    const activity = graphAddActivity(rt.task, input)
    void this.storeFor(rt.task.cwd).tasks.appendActivity(rt.task, activity)
    return activity
  }

  persist(rt) {
    return this.storeFor(rt.task.cwd).tasks.scheduleSave(rt.task, Number(this.config.saveDebounceMs) || 200)
  }

  /** 立即落盘（收官/停止时用），并清掉合并写队列。 */
  async flushPersist(rt) {
    await this.storeFor(rt.task.cwd).tasks.flush(rt.task.id)
  }

  addIntents(task, items) {
    const rt = this.runtimeForTask(task)
    const results = graphAddIntents(rt.task, items)
    const created = results.filter(r => r.id > 0).map(r => r.id)
    if (created.length > 0) {
      this.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'intent',
        summary: `新增意图 ${created.map(id => `#${id}`).join(' ')}`,
      })
      rt.stalls = 0
      void this.persist(rt)
    }
    return results
  }

  addHint(task, texts) {
    const rt = this.runtimeForTask(task)
    const added = []
    for (const text of texts) {
      const hint = graphAddHint(rt.task, text)
      if (hint) added.push(hint)
    }
    if (added.length > 0) {
      this.addActivity(rt, { intentId: null, worker: 'human', kind: 'hint', summary: `新增提示：${oneLine(added.map(h => h.text).join('；'), 200)}` })
      this.pushEvent(rt, { kind: 'hint', summary: added.map(h => oneLine(h.text, 100)).join('；') })
      void this.persist(rt)
    }
    return added
  }

  proveGoal(task, goalId, evidenceId, reason) {
    const rt = this.runtimeForTask(task)
    const result = graphProveGoal(rt.task, goalId, evidenceId, reason)
    if (result.ok) {
      this.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'goal',
        summary: `目标 #${goalId} 标记达成（证据 #${evidenceId}）`,
        detail: reason || '',
      })
      void this.persist(rt)
    }
    return result
  }

  setTodos(task, items) {
    const rt = this.runtimeForTask(task)
    const todos = graphSetTodos(rt.task, items)
    void this.persist(rt)
    return todos
  }

  /** 规划者维护全局认知：整体替换、按轮次版本化。 */
  setBrief(task, text, citations) {
    const rt = this.runtimeForTask(task)
    const brief = graphSetBrief(rt.task, text, citations)
    if (brief) {
      this.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'brief',
        summary: `更新全局认知（第 ${brief.round} 轮）`,
        detail: brief.text,
      })
      void this.persist(rt)
    }
    return brief
  }

  /** 把 blueprint 提升为 open，进入 frontier。 */
  promoteIntent(task, intentId) {
    const rt = this.runtimeForTask(task)
    const result = graphPromoteIntent(rt.task, intentId)
    if (result.ok) {
      this.addActivity(rt, {
        intentId: result.intent.id,
        worker: 'planner',
        kind: 'promote',
        summary: `蓝图提升为 open：#${result.intent.id}`,
      })
      void this.persist(rt)
    }
    return result
  }

  roleForIntent(taskId, intentId) {
    if (!intentId) return undefined
    for (const role of this.roles.values()) {
      if (role.taskId === taskId && role.intentId === Number(intentId)) return role
    }
    return undefined
  }

  recordFacts(task, entries, intentId) {
    const rt = this.runtimeForTask(task)
    const facts = entries.map(entry => graphRecordFact(rt.task, {
      summary: entry.summary,
      detail: entry.detail,
      evidence: entry.evidence,
      confidence: entry.confidence,
      outcome: entry.outcome,
      resourceIds: entry.resourceIds ?? entry.resource_ids,
      intentId: entry.intentId ?? entry.intent_id ?? intentId,
    }))
    if (facts.length > 0) {
      const role = this.roleForIntent(task.id, facts[0].intentId)
      if (role) {
        role.writes.facts += facts.length
        for (const fact of facts) {
          if (fact.outcome) {
            role.writes.outcomes = role.writes.outcomes || { found: 0, none: 0, inconclusive: 0, blueprint: 0 }
            role.writes.outcomes[fact.outcome] += 1
          }
        }
      }
      this.addActivity(rt, {
        intentId: intentId ?? facts[0].intentId,
        worker: 'worker',
        kind: 'fact',
        summary: facts.map(f => `#${f.id} ${oneLine(f.summary, 80)}`).join('；'),
        detail: facts.map(f => `#${f.id} ${f.summary}\n${f.detail || ''}\n${f.evidence || ''}`).join('\n\n'),
      })
      void this.persist(rt)
    }
    return facts
  }

  recordFinding(task, input) {
    const rt = this.runtimeForTask(task)
    const finding = graphReportFinding(rt.task, input)
    const role = this.roleForIntent(task.id, finding.intentId)
    if (role) role.writes.findings += 1
    this.addActivity(rt, {
      intentId: finding.intentId,
      worker: 'worker',
      kind: 'finding',
      summary: `发现 #${finding.id} ${oneLine(finding.title, 100)}`,
      detail: `${finding.detail || ''}\n${finding.evidence || ''}`,
    })
    this.pushEvent(rt, {
      kind: 'finding',
      intentId: finding.intentId,
      summary: `#${finding.id} ${oneLine(finding.title, 120)}（severity=${finding.severity}）`,
    })
    void this.persist(rt)
    return finding
  }

  async addResources(task, items, role) {
    const rt = this.runtimeForTask(task)
    const stores = this.storeFor(rt.task.cwd)
    const results = await stores.resources.upsert(items, rt.task.id)
    const created = results.filter(r => r.created)
    if (created.length > 0) {
      rt.task.stats.resources += created.length
      if (role && role.writes) role.writes.resources += created.length
      this.addActivity(rt, {
        intentId: role?.intentId ?? null,
        worker: role?.role ?? 'worker',
        kind: 'resource',
        summary: `登记资源 ${created.map(r => `#${r.id} ${r.name}`).join('；')}`,
      })
      void this.persist(rt)
    }
    return results
  }

  runtimeForTask(task) {
    const rt = this.tasks.get(task.id)
    if (!rt) throw new Error(`ARTEX 任务 ${task.id} 已结束，不能再写入（可用 artex_task_status 查看快照）`)
    if (rt.finished) throw new Error(`ARTEX 任务 ${task.id} 已结束（${task.status}），不能再写入`)
    return rt
  }

  /* -------------------------------------------------------------- session events */

  /**
   * 把 worker 子会话的工具调用/结果索引成过程库（ARTEX activity），
   * 让其它 work 能按关键字回看，而不是只看最终结论。
   */
  handleSessionEvent(session, event) {
    try {
      const sessionId = session?.header?.id ?? session?.id
      if (!sessionId) return
      const role = this.roles.get(sessionId)
      if (!role) return
      const rt = this.tasks.get(role.taskId)
      if (!rt || rt.finished) return
      const data = event?.data
      if (!data) return

      // 用量统计对所有角色生效（planner 与 worker 都计入任务成本）。
      if (event.type === 'assistant/message') {
        this.recordUsage(rt, role, data.usage)
        if (role.role !== 'worker') return
        const text = textOf(data.message?.content)
        if (!text) return
        this.addActivity(rt, {
          intentId: role.intentId,
          worker: 'worker',
          kind: 'text',
          summary: oneLine(text, 160),
          detail: text,
        })
        return
      }

      if (role.role !== 'worker') return

      if (event.type === 'tool/call') {
        const name = String(data.name || '')
        if (name.startsWith('artex_')) return // 写回已单独记录，不重复索引
        role.pending.set(data.callId, { name, arguments: data.arguments })
        return
      }

      if (event.type === 'tool/result') {
        const callId = data.message?.toolCallId ?? data.callId
        const pending = role.pending.get(callId)
        if (!pending) return
        role.pending.delete(callId)
        const detail = textOf(data.message?.content)
        this.addActivity(rt, {
          intentId: role.intentId,
          worker: 'worker',
          kind: 'step',
          tool: pending.name,
          summary: `${pending.name} ${oneLine(pending.arguments, 140)}`,
          detail,
          isError: data.message?.isError === true || data.error !== undefined,
        })
      }
    } catch (error) {
      this.logger.warn?.(`[artex] session event index failed: ${error?.message || error}`)
    }
  }

  /** 累计子会话的 provider usage，作为任务成本口径（输出/输入 token 与调用次数）。 */
  recordUsage(rt, role, usage) {
    return recordUsageImpl(this, rt, role, usage)
  }

  cleanupRoles(rt) {
    for (const [sessionId, role] of this.roles) {
      if (role.taskId === rt.task.id) this.roles.delete(sessionId)
    }
  }

  async onAgentDisposed(agent) {
    for (const rt of this.tasks.values()) {
      if (rt.finished) continue
      if (agent?.id === rt.ownerAgent?.id) {
        await this.stopTask(rt.task.id, '所有者会话已关闭')
      }
    }
  }

  /* ----------------------------------------------------------------- views */

  snapshot(task, live) {
    const stateCount = {}
    for (const intent of task.intents) stateCount[intent.state] = (stateCount[intent.state] || 0) + 1
    const endsAt = task.endedAt ?? Date.now()
    return {
      task_id: task.id,
      owner_session: task.ownerSession,
      status: task.status,
      live: Boolean(live && !live.finished),
      mode: task.mode || 'objective',
      view_mode: task.viewMode || this.config.viewMode || 'planner',
      description: task.description,
      goal: task.goal,
      rounds: task.round,
      limits: task.limits,
      brief: task.brief?.text || undefined,
      brief_round: task.brief?.round ?? undefined,
      analysis: task.analysis?.text || undefined,
      analysis_round: task.analysis?.round ?? undefined,
      analysis_runs: task.analysisRuns || 0,
      digest: digestOf(task),
      goals: task.goals.map(g => ({ id: g.id, text: g.text, status: g.status, evidence: g.evidence })),
      intents: {
        total: task.intents.length,
        open: openIntents(task).length,
        running: runningIntents(task).length,
        by_state: stateCount,
      },
      facts: task.facts.length,
      findings: task.findings.slice(-50).map(f => ({ id: f.id, title: f.title, severity: f.severity, intent_id: f.intentId })),
      findings_total: task.findings.length,
      resources: task.stats.resources,
      usage: task.usage || { input_tokens: 0, output_tokens: 0, calls: 0, by_role: {} },
      hints: task.hints.map(h => h.text),
      todos: task.todos,
      elapsed_ms: endsAt - task.createdAt,
      finish_detail: task.finishDetail,
      out_dir: task.outDir,
    }
  }

  async status(taskId) {
    if (taskId) {
      const rt = this.liveTask(taskId)
      if (rt) return this.snapshot(rt.task, rt)
      const stored = await this.loadTask(taskId)
      if (!stored) throw new Error(`ARTEX 任务 ${taskId} 不存在`)
      return this.snapshot(stored, undefined)
    }
    return [...this.tasks.values()].map(rt => this.snapshot(rt.task, rt))
  }

  report(task) {
    return formatReport(task)
  }
}
