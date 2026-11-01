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
  createTask, addActivity as graphAddActivity, addViolation as graphAddViolation,
} from './graph.js'
import { interruptChildren as interruptChildrenImpl, interruptChild as interruptChildImpl, runChild as runChildImpl, awaitChild as awaitChildImpl, outcome as outcomeImpl, abortOnly as abortOnlyImpl, abortOrTimeout as abortOrTimeoutImpl, nudge as nudgeImpl } from './runner.js'
import { runLoop as runLoopImpl, finish as finishImpl, completeGracefully as completeGracefullyImpl, beginSettling as beginSettlingImpl, drain as drainImpl, plannerRound as plannerRoundImpl, dispatchWorkers as dispatchWorkersImpl, runWorker as runWorkerImpl, finishWorker as finishWorkerImpl, pushEvent as pushEventImpl, wake as wakeImpl, waitEvent as waitEventImpl, sleepOrAbort as sleepOrAbortImpl, checkStalledWorkers as checkStalledWorkersImpl } from './scheduler.js'
import { maybeRunAnalyst as maybeRunAnalystImpl } from './analyst.js'
import { queueVerifier as queueVerifierImpl } from './verifier.js'
import { recordUsage as recordUsageImpl } from './usage.js'
import { addIntents as addIntentsImpl, addHint as addHintImpl, proveGoal as proveGoalImpl, setTodos as setTodosImpl, setBrief as setBriefImpl, setAnalysis as setAnalysisImpl, promoteIntent as promoteIntentImpl, roleForIntent as roleForIntentImpl, recordFacts as recordFactsImpl, recordFinding as recordFindingImpl, addResources as addResourcesImpl, runtimeForTask as runtimeForTaskImpl, retestFinding as retestFindingImpl, recordConflict as recordConflictImpl, retractFact as retractFactImpl, requestApproval as requestApprovalImpl, resolveApproval as resolveApprovalImpl } from './graph-ops.js'
import { snapshot as snapshotImpl, status as statusImpl, report as reportImpl, campaignStatus as campaignStatusImpl, campaignList as campaignListImpl } from './reporting.js'
import { handleSessionEvent as handleSessionEventImpl } from './session-indexer.js'
import { lintGoalTexts } from './guard.js'
import { loadEngagement, validateEngagement, ensureArtexGitignored } from './engagement.js'
import { loadSkillPacks } from './skills.js'
import { violationNudgePrompt, tokenCapSettlePrompt } from './prompts.js'
import { sleep } from './util.js'
import { normalizeConfig } from './config.js'
import { TOOL_NAMES, denyForRole, policyDenyForTask } from './policy.js'
import { finishIntent } from './graph.js'

export { DEFAULTS } from './config.js'

/** 按 cwd 缓存的 workspace store 上限（N36）：超出后按 LRU 淘汰，避开有活任务/待写内容的条目。 */
export const MAX_CACHED_STORES = 32


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

  /** 角色 deny ∪ 任务级沙箱策略（read_only/allowed_tools）的 deny：spawn 时只认工具名。 */
  denyForTask(task, role) {
    return policyDenyForTask(task?.policy || {}, role, this.toolNames)
  }

  get subagents() {
    return this.ctx.subagents
  }

  /* ------------------------------------------------------------- plumbing */

  storeFor(cwd) {
    let entry = this.stores.get(cwd)
    if (entry) {
      // LRU 触碰：命中后移到队尾，淘汰时从队首挑（N36）。
      this.stores.delete(cwd)
      this.stores.set(cwd, entry)
      return entry
    }
    entry = {
      tasks: new TaskStore(cwd, { onError: (error) => this.logger.warn?.(`[artex] snapshot save failed: ${error?.message || error}`) }),
      resources: new ResourceStore(cwd),
    }
    this.stores.set(cwd, entry)
    if (this.stores.size > MAX_CACHED_STORES) this.evictStore()
    return entry
  }

  /** 淘汰一个不再需要的 workspace store：跳过有活任务或有待写内容的，避免丢现场。 */
  evictStore() {
    const liveCwds = new Set()
    for (const rt of this.tasks.values()) if (rt?.task?.cwd) liveCwds.add(rt.task.cwd)
    for (const [key, candidate] of this.stores) {
      if (liveCwds.has(key)) continue
      if (candidate?.tasks?.pending && candidate.tasks.pending.size > 0) continue
      this.stores.delete(key)
      return true
    }
    return false
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

  /** 供 startTask / resumeTask 复建空 runtime。 */
  makeRuntime(task, agent) {
    return {
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
      viewMode: task.viewMode || this.config.viewMode || 'hybrid',
      analystRuns: 0,
      lastAnalystAt: 0,
      lastAnalystFactCount: 0,
      lastAnalystRound: 0,
      stalledNudges: new Map(),
      workerSeq: 0,
      viewFailures: 0,
      lastViewError: undefined,
      verifierQueue: undefined,
      // 技能包（startTask 时装载，worker 提示词与工具面来源）。
      skillPacks: [],
      // 成本水位（燃烧率口径：上一轮规划时的累计 token）。
      costMark: undefined,
      // 已触发意图级 token 门禁的意图（避免重复收尾）。
      tokenCapNudged: new Set(),
      finished: false,
      startedAt: Date.now(),
      done: undefined,
      doneResolve: undefined,
      loop: undefined,
      deadlineTimer: undefined,
      finishedStatus: undefined,
      finishDetail: undefined,
    }
  }

  async startTask({ agent, goal, description, goals, constraints, mode, viewMode, analyst, limits = {}, policy = {}, confirm, campaign, signal }) {
    if (this.disposed) throw new Error('ARTEX 插件已卸载')
    if (!agent) throw new Error('ARTEX 需要调用它的 agent 会话')
    if (!String(goal || '').trim()) throw new Error('goal 不能为空')
    this.providerName = this.resolveProvider()
    // P0-2 目标审查（确定性词表，不经过模型）：命中犯罪意图信号时必须显式确认。
    const lintTexts = [goal, ...(Array.isArray(goals) ? goals : []), ...(Array.isArray(constraints) ? constraints : [])]
    const riskHits = lintGoalTexts(lintTexts)
    let riskConfirm
    if (riskHits.length > 0) {
      if (String(confirm ?? '').trim() !== String(goal).trim()) {
        throw new Error(`目标审查命中高风险信号：${[...new Set(riskHits.map(h => h.label))].join('、')}。\n` +
          '若确属授权场景（如防御研究/靶场演练/报告复现），请把 confirm 参数精确设为 goal 原文再提交；该确认与命中词会随任务留痕。')
      }
      riskConfirm = {
        hits: [...new Map(riskHits.map(h => [h.category, { category: h.category, label: h.label }])).values()],
        confirmedAt: Date.now(),
      }
    }
    // 开关优先级：任务级 analyst / 插件级 enableHybrid 任一关闭 → planner；
    // 否则按任务 view_mode > 插件 viewMode > hybrid 生效。
    const requestedView = ['planner', 'hybrid', 'analyst'].includes(viewMode)
      ? viewMode
      : this.config.viewMode
    const effectiveView = (this.config.enableHybrid === false || analyst === false)
      ? 'planner'
      : (['planner', 'hybrid', 'analyst'].includes(requestedView) ? requestedView : 'hybrid')
    const cwd = await this.cwdFor(agent, signal)
    // P0-1 交战绑定：授权一等公民化——授权说明/目标集/时间窗在启动期机器校验。
    const policyInput = { ...(policy || {}) }
    const wantsEngagement = String(policyInput.engagement ?? '').trim()
    let engagementMeta
    if (this.config.requireEngagement === true && !wantsEngagement) {
      throw new Error('插件配置要求绑定交战（requireEngagement=true）：请提供 engagement 参数，对应 .artex/engagements/<id>.json')
    }
    if (wantsEngagement) {
      const engagement = await loadEngagement(cwd, wantsEngagement)
      const declaredTargets = (Array.isArray(policyInput.allowedTargets ?? policyInput.allowed_targets)
        ? (policyInput.allowedTargets ?? policyInput.allowed_targets)
        : []).map(v => String(v).trim()).filter(Boolean)
      const problems = validateEngagement(engagement, { allowedTargets: declaredTargets })
      if (problems.length > 0) {
        throw new Error(`交战 ${wantsEngagement} 校验未通过：\n- ${problems.join('\n- ')}`)
      }
      if (declaredTargets.length === 0) {
        // 交战目标集即默认 scope：授权边界自动成为任务边界。
        policyInput.allowedTargets = [...(engagement.targets || [])]
      }
      engagementMeta = {
        id: engagement.id,
        authorization: String(engagement.authorization).slice(0, 300),
        targets: Array.isArray(engagement.targets) ? engagement.targets : [],
        window: engagement.window && typeof engagement.window === 'object' ? engagement.window : {},
      }
    }
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
      policy: policyInput,
      mode: effectiveMode,
      viewMode: effectiveView,
      ownerSession: agent.id,
      cwd,
      campaign,
      engagement: engagementMeta,
      riskConfirm,
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
        maxTokens: Math.max(0, Number(merged.maxTokens) || 0),
      },
    })
    task.provider = this.providerName
    const rt = this.makeRuntime(task, agent)
    rt.done = new Promise((resolve) => { rt.doneResolve = resolve })
    this.tasks.set(id, rt)
    this.evictOld()
    try {
      // save 设计上是自吞错的（写进 lastError）：对比前后引用识别本次失败。
      // 启动期落盘失败直接失败，不留一个永不结束的孤儿 runtime 在 tasks 表里。
      const prevError = stores.tasks.lastError
      await stores.tasks.save(task)
      if (stores.tasks.lastError && stores.tasks.lastError !== prevError) throw stores.tasks.lastError
    } catch (error) {
      this.tasks.delete(id)
      throw new Error(`ARTEX 任务 ${id} 初始化落盘失败：${error?.message || error}`)
    }
    await this.index.register(task).catch((error) => this.logger.warn?.(`[artex] task index register failed: ${error?.message || error}`))
    await this.prepareRuntimeGuards(rt, { fresh: true })
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

  /** 暂停保留现场：facts/runState 落盘为 paused，之后可用 artex_resume_task 重挂（需重给预算）。 */
  async pauseTask(taskId, reason = '用户暂停') {
    const rt = this.liveTask(taskId)
    if (!rt || rt.finished) return false
    rt.finishedStatus = 'paused'
    rt.finishDetail = reason
    this.interruptChildren(rt)
    rt.abort.abort(reason)
    return true
  }

  /**
   * 恢复任务：从 task.json + JSONL 重新挂载现场续跑。
   * - 跑中意图回炉 open（中断的 work 不丢事实，只是重新领取）；
   * - 必须重给预算（新窗口，不继承旧 deadline）；可顺带覆盖规划参数；
   * - 已完成任务不可恢复；只有所有者能恢复。
   */
  async resumeTask({ agent, taskId, budgetMs, limits = {}, signal }) {
    if (this.disposed) throw new Error('ARTEX 插件已卸载')
    if (!agent) throw new Error('ARTEX 需要调用它的 agent 会话')
    const id = String(taskId)
    if (!isValidTaskId(id)) throw new Error(`非法 task_id: ${id}`)
    const live = this.tasks.get(id)
    if (live && !live.finished) throw new Error(`任务 ${id} 正在运行中，不能重复挂载`)
    const task = live?.task ?? await this.resolveTask(id)
    if (task.status === 'completed') throw new Error('任务已完成，不可恢复')
    if (String(task.ownerSession) !== String(agent.id)) throw new Error(`只有任务所有者能恢复 ${id}`)
    const budget = Math.max(0, Number(budgetMs) || 0)
    if (budget <= 0) throw new Error('恢复任务必须显式给预算（budget_ms > 0），避免旧任务无界续跑')
    this.providerName = this.resolveProvider()
    // 现场复位：时钟/终态域归零，证据、brief、意图、usage 全部保留。
    task.status = 'created'
    task.endedAt = undefined
    task.finishDetail = undefined
    task.report = undefined
    task.limits = {
      ...task.limits,
      ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v != null)),
      budgetMs: budget,
    }
    for (const intent of task.intents) {
      if (intent.state === 'running') {
        finishIntent(task, intent.id, { state: 'open', output: intent.output, reason: 'resumed', writes: intent.writes })
        intent.endedAt = undefined
        intent.lastActivityAt = undefined
      }
    }
    // 轮次额度随恢复重置：因 max_rounds 结束的任务若不重置，恢复后第一轮就空转（N34）。
    task.resumes = (Number(task.resumes) || 0) + 1
    task.round = 0
    task.updatedAt = Date.now()
    const stores = this.storeFor(task.cwd)
    // 解除终态短路：否则恢复后产生的 fact/finding 永远不进 JSONL（N32）。
    stores.tasks.reopen(task.id)
    const rt = this.makeRuntime(task, agent)
    rt.done = new Promise((resolve) => { rt.doneResolve = resolve })
    this.tasks.set(id, rt)
    this.evictOld()
    const prevError = stores.tasks.lastError
    await stores.tasks.save(task)
    if (stores.tasks.lastError && stores.tasks.lastError !== prevError) {
      this.tasks.delete(id)
      throw new Error(`ARTEX 任务 ${id} 恢复落盘失败：${stores.tasks.lastError?.message || stores.tasks.lastError}`)
    }
    await this.index.register(task).catch((error) => this.logger.warn?.(`[artex] task index register failed: ${error?.message || error}`))
    await this.prepareRuntimeGuards(rt, { fresh: false })
    rt.loop = this.runLoop(rt).catch((error) => {
      this.logger.warn?.(`[artex] task ${id} loop failed: ${error?.message || error}`)
      if (!rt.finished) this.finish(rt, 'failed', String(error?.message || error))
    })
    rt.deadlineTimer = setTimeout(() => { void this.beginSettling(rt, { reason: '任务级预算耗尽' }) }, budget)
    rt.deadlineTimer.unref?.()
    void signal
    return rt
  }

  /**
   * 启动/恢复共用的新 runtime 防线装配：
   * P0-3 .artex git 防裸奔（仅首次启动）；P2-2 技能包装载与工具面并入。
   */
  async prepareRuntimeGuards(rt, { fresh = false } = {}) {
    const task = rt.task
    if (fresh && this.config.gitIgnoreGuard !== false) {
      try {
        const guard = await ensureArtexGitignored(task.cwd)
        if (guard.changed) {
          this.addActivity(rt, { intentId: null, worker: 'engine', kind: 'system', summary: guard.note })
        }
      } catch (error) {
        this.logger.warn?.(`[artex] gitignore guard failed: ${error?.message || error}`)
      }
    }
    if (task.policy.skillPacks.length > 0) {
      rt.skillPacks = await loadSkillPacks(task.cwd, task.policy.skillPacks)
      if (task.policy.allowedTools.length === 0) {
        const packTools = rt.skillPacks.flatMap(p => p.tools)
        if (packTools.length > 0) task.policy.allowedTools = [...new Set(packTools)]
      }
      this.addActivity(rt, {
        intentId: null,
        worker: 'engine',
        kind: 'system',
        summary: `装载技能包：${rt.skillPacks.map(p => p.name).join(', ')}`,
      })
    }
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

  beginSettling(rt, options = {}) {
    return beginSettlingImpl(this, rt, options)
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

  checkStalledWorkers(rt) {
    return checkStalledWorkersImpl(this, rt)
  }

  /** finding 落库后按串行链派 verifier 复核（config.enableVerifier 开启时）。 */
  queueVerifier(rt, finding) {
    return queueVerifierImpl(this, rt, finding)
  }

  /** token 预算硬门：usage 每次累计都检查；超限先收尾证明（settling→finish stopped）。 */
  checkTokenBudget(rt) {
    const max = Number(rt?.task?.limits?.maxTokens) || 0
    if (max <= 0 || !rt || rt.finished || rt.settling || rt.completing) return false
    const usage = rt.task.usage || { input_tokens: 0, output_tokens: 0 }
    const total = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    if (total < max) return false
    this.beginSettling(rt, { reason: `token 预算耗尽（${total}/${max}）` })
    return true
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
    // 心跳查房的时钟：只有真实子会话的活动才算"这条意图还活着"。
    // 引擎自己发出的巡检/中断记录（worker: 'engine'）不能续命——否则
    // "唤醒后仍静默就中断"永远不成立（N25）。
    if (activity.intentId && activity.worker !== 'engine') {
      const intent = rt.task.intents.find(i => i.id === activity.intentId)
      if (intent) intent.lastActivityAt = activity.at
      rt.stalledNudges?.delete(activity.intentId)
    }
    void this.storeFor(rt.task.cwd).tasks.appendActivity(rt.task, activity)
    return activity
  }

  persist(rt) {
    return this.storeFor(rt.task.cwd).tasks.scheduleSave(rt.task, Number(this.config.saveDebounceMs) || 200)
  }

  /** 证据（facts/findings）即时落盘：不走合并写窗口，崩溃不丢已确认结论。 */
  persistEvidence(rt) {
    return this.storeFor(rt.task.cwd).tasks.appendEvidence(rt.task)
  }

  /** 任务终态后回收持久化层的内存写入状态（快照/JSONL 保留可重载）。 */
  releaseStore(rt) {
    this.storeFor(rt.task.cwd).tasks.release(rt.task.id)
  }

  /** 距离任务级预算耗尽还剩多少毫秒；未设预算返回 Infinity。 */
  remainingBudgetMs(rt) {
    const budget = Number(rt?.task?.limits?.budgetMs) || 0
    if (budget <= 0) return Infinity
    return Math.max(0, (Number(rt.startedAt) || Date.now()) + budget - Date.now())
  }

  /** 立即落盘（收官/停止时用），并清掉合并写队列。 */
  async flushPersist(rt) {
    await this.storeFor(rt.task.cwd).tasks.flush(rt.task.id)
  }

  addIntents(task, items, options = {}) {
    return addIntentsImpl(this, task, items, options)
  }

  addHint(task, texts) {
    return addHintImpl(this, task, texts)
  }

  proveGoal(task, goalId, evidenceId, reason, allowNegative = false, options = {}) {
    return proveGoalImpl(this, task, goalId, evidenceId, reason, allowNegative, options)
  }

  setTodos(task, items) {
    return setTodosImpl(this, task, items)
  }
  setBrief(task, text, citations) {
    return setBriefImpl(this, task, text, citations)
  }
  promoteIntent(task, intentId, options = {}) {
    return promoteIntentImpl(this, task, intentId, options)
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

  retestFinding(task, input, options = {}) {
    return retestFindingImpl(this, task, input, options)
  }

  recordConflict(task, input) {
    return recordConflictImpl(this, task, input)
  }

  retractFact(task, input) {
    return retractFactImpl(this, task, input)
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
    recordUsageImpl(this, rt, role, usage)
    this.checkTokenBudget(rt)
    this.checkIntentTokenBudget(rt, role)
  }

  /* ----------------------------------------------------------------- guards */

  /** scope 越界处置档位：任务 policy > 插件配置，默认 warn。 */
  scopeEnforcement(task) {
    return task?.policy?.scopeEnforcement || this.config.scopeEnforcement || 'warn'
  }

  /**
   * P0-1 引擎级 scope 越界处置（session-indexer 在 worker 工具调用事件上调用）：
   * 记录 → 当场提醒 worker → 唤醒 planner；stop 档直接停止任务。
   * 注意边界：DSH 不给插件 OS 级路径/网络沙箱，这里是"检测+提醒+停任务"，
   * 无法在工具调用执行前抢占拦截——抢占靠 allowed_tools 白名单与 read_only。
   */
  flagScopeViolation(rt, role, toolName, verdict) {
    if (!rt || rt.finished || !verdict || verdict.misses.length === 0) return
    const task = rt.task
    const enforcement = this.scopeEnforcement(task)
    const entry = graphAddViolation(task, {
      tool: toolName,
      intentId: role?.intentId ?? null,
      targets: verdict.targets,
      misses: verdict.misses,
      enforcement,
    })
    this.addActivity(rt, {
      intentId: entry.intentId,
      worker: 'engine',
      kind: 'violation',
      summary: `scope 越界：${toolName} 目标 ${entry.misses.join(', ')} 不在 allowed_targets 内`,
      detail: `工具：${toolName}\n提取目标：${entry.targets.join(', ') || '-'}\n越界目标：${entry.misses.join(', ')}\n处置档位：${enforcement}`,
    })
    const childId = role?.intentId ? rt.children.get(`intent-${role.intentId}`) : undefined
    if (childId) {
      void this.nudge(rt, childId, violationNudgePrompt({ tool: toolName, misses: entry.misses, enforcement }))
    }
    this.pushEvent(rt, { kind: 'violation', summary: `意图 #${role?.intentId ?? '-'} 越界（${entry.misses.join(', ')}）` })
    if (enforcement === 'stop') {
      this.finish(rt, 'stopped', `scope 越界停止：${entry.misses.join(', ')} 不在 allowed_targets 内`)
      return
    }
    void this.persist(rt)
  }

  /**
   * P3-2 意图级 token 预算门禁：单意图超 cap → 先收尾提醒，宽限后硬停。
   * 每意图只触发一次（tokenCapNudged 去重），由 finishWorker 按正常终态收尾。
   */
  checkIntentTokenBudget(rt, role) {
    const cap = Number(rt?.task?.policy?.maxTokensPerIntent) || Number(this.config.maxTokensPerIntent) || 0
    if (cap <= 0 || !role?.intentId || !rt || rt.finished) return false
    if (rt.tokenCapNudged.has(role.intentId)) return false
    const bucket = rt.task.usage?.by_intent?.[`#${role.intentId}`]
    const total = (bucket?.input_tokens || 0) + (bucket?.output_tokens || 0)
    if (total <= cap) return false
    rt.tokenCapNudged.add(role.intentId)
    this.addActivity(rt, {
      intentId: role.intentId,
      worker: 'engine',
      kind: 'system',
      summary: `意图 #${role.intentId} 超过意图级 token 预算（${total} > ${cap}），要求收尾`,
    })
    const childId = rt.children.get(`intent-${role.intentId}`)
    if (childId) {
      void this.nudge(rt, childId, tokenCapSettlePrompt({ intentId: role.intentId, used: total, cap }))
      const grace = Math.max(5000, Number(rt.task.limits.settleGraceMs) || 30000)
      const timer = setTimeout(() => {
        if (!rt.finished && rt.running.has(role.intentId)) this.interruptChild(rt, childId)
      }, grace)
      timer.unref?.()
    }
    void this.persist(rt)
    return true
  }

  /** P3-2 成本水位：planner 每轮看到的燃烧率与预算余量。 */
  costView(rt) {
    const task = rt.task
    const usage = task.usage || { input_tokens: 0, output_tokens: 0, calls: 0 }
    const total = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    const mark = rt.costMark || { total: 0 }
    const sinceLast = Math.max(0, total - mark.total)
    rt.costMark = { total, round: task.round }
    const rounds = Math.max(1, task.round)
    const view = {
      total_tokens: total,
      calls: usage.calls || 0,
      since_last_round: sinceLast,
      per_round_avg: Math.round(total / rounds),
    }
    if (task.limits.maxTokens > 0) {
      view.max_tokens = task.limits.maxTokens
      view.remaining_tokens = Math.max(0, task.limits.maxTokens - total)
      view.est_rounds_left = view.per_round_avg > 0 ? Math.floor(view.remaining_tokens / view.per_round_avg) : undefined
    }
    const cap = Number(task.policy?.maxTokensPerIntent) || Number(this.config.maxTokensPerIntent) || 0
    if (cap > 0) view.per_intent_cap = cap
    return view
  }

  /* ---------------------------------------------------------------- approval */

  requestApproval(task, intentId, request = {}) {
    return requestApprovalImpl(this, task, intentId, request)
  }

  resolveApproval(task, intentId, decision, note = '') {
    return resolveApprovalImpl(this, task, intentId, decision, note)
  }

  /* ---------------------------------------------------------------- campaign */

  async campaignStatus(campaign) {
    return campaignStatusImpl(this, campaign)
  }

  async campaignList() {
    return campaignListImpl(this)
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
