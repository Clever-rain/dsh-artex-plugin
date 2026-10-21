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
import {
  TaskStore, ResourceStore, TaskIndex, isValidTaskId,
  createTask, addActivity as graphAddActivity,
} from './graph.js'
import { interruptChildren as interruptChildrenImpl, interruptChild as interruptChildImpl, runChild as runChildImpl, awaitChild as awaitChildImpl, outcome as outcomeImpl, abortOnly as abortOnlyImpl, abortOrTimeout as abortOrTimeoutImpl, nudge as nudgeImpl } from './runner.js'
import { runLoop as runLoopImpl, finish as finishImpl, completeGracefully as completeGracefullyImpl, beginSettling as beginSettlingImpl, drain as drainImpl, plannerRound as plannerRoundImpl, dispatchWorkers as dispatchWorkersImpl, runWorker as runWorkerImpl, finishWorker as finishWorkerImpl, pushEvent as pushEventImpl, wake as wakeImpl, waitEvent as waitEventImpl, sleepOrAbort as sleepOrAbortImpl } from './scheduler.js'
import { maybeRunAnalyst as maybeRunAnalystImpl } from './analyst.js'
import { recordUsage as recordUsageImpl } from './usage.js'
import { addIntents as addIntentsImpl, addHint as addHintImpl, proveGoal as proveGoalImpl, setTodos as setTodosImpl, setBrief as setBriefImpl, setAnalysis as setAnalysisImpl, promoteIntent as promoteIntentImpl, roleForIntent as roleForIntentImpl, recordFacts as recordFactsImpl, recordFinding as recordFindingImpl, addResources as addResourcesImpl, runtimeForTask as runtimeForTaskImpl } from './graph-ops.js'
import { snapshot as snapshotImpl, status as statusImpl, report as reportImpl } from './reporting.js'
import { handleSessionEvent as handleSessionEventImpl } from './session-indexer.js'
import { sleep } from './util.js'
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
    const requested = this.providerName
    if (requested && names.includes(requested)) return requested
    const fallback = names.includes('spawn') ? 'spawn' : names[0]
    if (!fallback) throw new Error('ARTEX 需要至少一个本地 subagent provider（例如 spawn），当前一个都没有注册')
    if (requested && fallback !== requested) {
      this.logger.warn?.(`[artex] provider "${requested}" 未注册，回退到 "${fallback}"`)
    }
    return fallback
  }

  roleOf(sessionId) {
    return sessionId ? this.roles.get(sessionId) : undefined
  }

  liveTask(taskId) {
    const id = String(taskId)
    if (!isValidTaskId(id)) return undefined
    return this.tasks.get(id)
  }

  async loadTask(taskId) {
    const id = String(taskId)
    if (!isValidTaskId(id)) return undefined
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
    const id = String(taskId)
    if (!isValidTaskId(id)) throw new Error(`非法 task_id: ${id}`)
    const live = this.liveTask(id)
    if (live) return live.task
    const stored = await this.loadTask(id)
    if (!stored) throw new Error(`ARTEX 任务 ${id} 不存在`)
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
    task.provider = this.providerName
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
    await this.index.register(task).catch((error) => this.logger.warn?.(`[artex] task index register failed: ${error?.message || error}`))
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
    return setAnalysisImpl(this, task, text, citations)
  }

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
    return addIntentsImpl(this, task, items)
  }

  addHint(task, texts) {
    return addHintImpl(this, task, texts)
  }

  proveGoal(task, goalId, evidenceId, reason, allowNegative = false) {
    return proveGoalImpl(this, task, goalId, evidenceId, reason, allowNegative)
  }

  setTodos(task, items) {
    return setTodosImpl(this, task, items)
  }
  setBrief(task, text, citations) {
    return setBriefImpl(this, task, text, citations)
  }
  promoteIntent(task, intentId) {
    return promoteIntentImpl(this, task, intentId)
  }

  roleForIntent(taskId, intentId) {
    return roleForIntentImpl(this, taskId, intentId)
  }

  recordFacts(task, entries, intentId) {
    return recordFactsImpl(this, task, entries, intentId)
  }

  recordFinding(task, input) {
    return recordFindingImpl(this, task, input)
  }

  async addResources(task, items, role) {
    return addResourcesImpl(this, task, items, role)
  }

  runtimeForTask(task) {
    return runtimeForTaskImpl(this, task)
  }
  handleSessionEvent(session, event) {
    return handleSessionEventImpl(this, session, event)
  }
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
    return snapshotImpl(this, task, live)
  }

  async status(taskId, options = {}) {
    return statusImpl(this, taskId, options)
  }

  report(task) {
    return reportImpl(this, task)
  }
}
