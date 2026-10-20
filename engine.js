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
  TaskStore, ResourceStore,
  createTask, addIntents as graphAddIntents, addActivity as graphAddActivity, addHint as graphAddHint,
  claimIntent, finishIntent, allGoalsMet, plannerView, workerView, recordFact as graphRecordFact,
  reportFinding as graphReportFinding, setTodos as graphSetTodos, proveGoal as graphProveGoal,
  digestOf, deltaOf, setBrief as graphSetBrief, promoteIntent as graphPromoteIntent,
  openIntents, runningIntents,
} from './graph.js'
import { plannerPrompt, workerPrompt, settlePrompt, siblingStopPrompt, formatReport } from './prompts.js'

export const DEFAULTS = {
  /** ctx.subagents provider；默认 in-process spawn。 */
  provider: 'spawn',
  /** 任务内 worker 并发（ARTEX 默认 3）。 */
  maxWorkers: 3,
  /** 规划轮次上限（安全阀，ARTEX 本身不限轮）。 */
  maxRounds: 24,
  /** 连续「规划后仍然无任何可执行方向」的次数上限。 */
  maxStalls: 2,
  /** 图变动合并窗口（ARTEX 800ms）。 */
  debounceMs: 800,
  /** 无变动时的巡检间隔（ARTEX ≥600s）。 */
  heartbeatMs: 600000,
  /** 单个 worker 的墙钟预算（ARTEX agents.run_seconds 默认 1200s）。 */
  workerTimeoutMs: 1200000,
  /** 单轮 planner 的墙钟预算（ARTEX planner 自身不限，这里给安全阀）。 */
  plannerTimeoutMs: 900000,
  /** 默认任务模式：objective=达成目的；audit=覆盖评估。 */
  mode: 'objective',
  /** 预算耗尽后的收尾宽限（ARTEX settleDrainGrace 90s）。 */
  settleGraceMs: 90000,
  /** 突破后等待兄弟路径写回现场的宽限。 */
  breakthroughGraceMs: 30000,
  /** 任务级预算；0 = 不限。 */
  budgetMs: 0,
  /** worker/planner 是否在任务目录下的独立 cwd 里工作（ARTEX 语义）；默认继承工作区。 */
  isolateWorkdir: false,
}

/** planner 不该拥有的执行型工具（ARTEX：planner 不写 fact/asset）。 */
export const PLANNER_DENY = [
  'artex_run_task', 'artex_start_task', 'artex_stop_task', 'artex_add_hint',
  'artex_record_fact', 'artex_report_finding', 'artex_add_resource',
]

/** worker 不该拥有的规划/控制型工具（ARTEX：worker 不产意图、不判目标）。 */
export const WORKER_DENY = [
  'artex_run_task', 'artex_start_task', 'artex_stop_task', 'artex_add_hint',
  'artex_add_intent', 'artex_prove_goal', 'artex_set_todos', 'artex_set_brief', 'artex_promote_intent',
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, 2 ** 31 - 1))))

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

function oneLine(value, max = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export class ArtexEngine {
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.logger = logger || console
    this.tasks = new Map() // taskId -> runtime
    this.roles = new Map() // child sessionId -> { taskId, role, intentId, writes, pending }
    this.stores = new Map() // cwd -> { tasks: TaskStore, resources: ResourceStore }
    this.providerName = this.config.provider
    this.disposed = false
  }

  get subagents() {
    return this.ctx.subagents
  }

  /* ------------------------------------------------------------- plumbing */

  storeFor(cwd) {
    let entry = this.stores.get(cwd)
    if (!entry) {
      entry = { tasks: new TaskStore(cwd), resources: new ResourceStore(cwd) }
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
    for (const entry of this.stores.values()) {
      try {
        return await entry.tasks.load(String(taskId))
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

  async startTask({ agent, goal, description, goals, constraints, mode, limits = {}, signal }) {
    if (this.disposed) throw new Error('ARTEX 插件已卸载')
    if (!agent) throw new Error('ARTEX 需要调用它的 agent 会话')
    if (!String(goal || '').trim()) throw new Error('goal 不能为空')
    this.providerName = this.resolveProvider()
    const cwd = await this.cwdFor(agent, signal)
    const stores = this.storeFor(cwd)
    const id = `t${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
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
      mode: mode === 'audit' ? 'audit' : 'objective',
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
      siblingStops: new Set(),
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
    if (!rt) return false
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
  }

  interruptChildren(rt) {
    for (const childId of rt.children.values()) this.interruptChild(rt, childId)
  }

  interruptChild(rt, childId) {
    try {
      this.subagents.interrupt(childId, { kind: 'ancestor', agent: rt.ownerAgent })
    } catch (error) {
      this.logger.warn?.(`[artex] interrupt ${childId} failed: ${error?.message || error}`)
    }
  }

  /* ------------------------------------------------------------------ loop */

  async runLoop(rt) {
    const t = rt.task
    t.status = 'running'
    this.persist(rt)
    try {
      while (!rt.abort.signal.aborted && !rt.finished) {
        if (rt.settling) {
          await this.drain(rt, t.limits.settleGraceMs)
          this.finish(rt, 'timeout', '任务级预算耗尽')
          break
        }
        if (allGoalsMet(t)) {
          await this.completeGracefully(rt, '全部目标已证明')
          break
        }
        this.dispatchWorkers(rt)
        const active = rt.running.size > 0 || t.intents.some(i => i.state === 'open')
        if (!active) {
          if (t.round >= t.limits.maxRounds) {
            this.finish(rt, 'max_rounds', `达到规划轮次上限 ${t.limits.maxRounds}`)
            break
          }
          await this.plannerRound(rt, rt.events.splice(0))
          if (rt.abort.signal.aborted || rt.finished) break
          if (allGoalsMet(t)) {
            await this.completeGracefully(rt, '全部目标已证明')
            break
          }
          if (t.limits.maxWorkers === 0) {
            this.finish(rt, 'planned', '仅规划模式（max_workers=0），不派 worker')
            break
          }
          this.dispatchWorkers(rt)
          if (rt.running.size === 0 && !t.intents.some(i => i.state === 'open')) {
            rt.stalls += 1
            if (rt.stalls >= t.limits.maxStalls) {
              this.finish(rt, 'stalled', `连续 ${rt.stalls} 轮规划没有产出可执行的新方向`)
              break
            }
            await this.sleepOrAbort(rt, Math.max(500, t.limits.debounceMs))
          }
          continue
        }
        const ev = await this.waitEvent(rt, t.limits.heartbeatMs)
        if (rt.abort.signal.aborted || rt.finished) break
        if (ev !== 'heartbeat') await this.sleepOrAbort(rt, t.limits.debounceMs)
        if (rt.abort.signal.aborted || rt.finished) break
        const triggers = rt.events.splice(0)
        if (t.round >= t.limits.maxRounds) continue
        await this.plannerRound(rt, triggers)
        if (allGoalsMet(t)) {
          await this.completeGracefully(rt, '全部目标已证明')
          break
        }
      }
    } catch (error) {
      if (!rt.finished) this.finish(rt, 'failed', String(error?.message || error))
    } finally {
      await this.drain(rt, 15000)
      this.finish(rt, rt.finishedStatus || 'stopped', rt.finishDetail || '引擎退出')
      await this.persist(rt)
      rt.doneResolve(t)
      this.cleanupRoles(rt)
    }
  }

  finish(rt, status, detail) {
    if (rt.finished) return
    rt.finished = true
    const t = rt.task
    t.status = status
    t.endedAt = Date.now()
    t.finishDetail = detail
    t.report = {
      status,
      detail,
      rounds: t.round,
      goals: t.goals.map(g => ({ id: g.id, status: g.status, evidence: g.evidence, text: g.text })),
      facts: t.facts.length,
      findings: t.findings.length,
      resources: t.stats.resources,
    }
    if (rt.deadlineTimer) {
      clearTimeout(rt.deadlineTimer)
      rt.deadlineTimer = undefined
    }
    this.interruptChildren(rt)
    this.wake(rt, 'abort')
    void this.persist(rt)
  }

  /**
   * 目标达成后的"突破收尾"：先停兄弟 pursue，给它们一个写回现场的宽限，
   * 再硬停并收官。顺序不能反——finish() 之后写操作会被拒绝。
   */
  async completeGracefully(rt, detail) {
    if (rt.completing || rt.finished) return
    rt.completing = true
    const t = rt.task
    const runningIds = [...rt.running.keys()]
    if (runningIds.length > 0) {
      rt.siblingStops = new Set(runningIds)
      for (const intentId of runningIds) {
        const childId = rt.children.get(`intent-${intentId}`)
        if (!childId) continue
        this.addActivity(rt, {
          intentId,
          worker: 'engine',
          kind: 'system',
          summary: '目标已由其它路径达成，发送"停止并回报现场"指令',
        })
        void this.nudge(rt, childId, siblingStopPrompt())
      }
      const grace = Number(t.limits.breakthroughGraceMs) || 0
      await Promise.race([Promise.allSettled([...rt.running.values()]), sleep(grace)])
      if (rt.running.size > 0) {
        for (const intentId of [...rt.running.keys()]) {
          const childId = rt.children.get(`intent-${intentId}`)
          if (childId) this.interruptChild(rt, childId)
        }
        await Promise.race([Promise.allSettled([...rt.running.values()]), sleep(15000)])
      }
    }
    // 队列里尚未领取的意图：目标已达成，不再执行（blueprint 保留为候选记录）。
    for (const intent of t.intents) {
      if (intent.state === 'open') {
        finishIntent(t, intent.id, { state: 'stopped', output: intent.output, reason: 'goal_met', writes: intent.writes })
      }
    }
    this.finish(rt, 'completed', detail)
  }

  beginSettling(rt) {
    if (rt.finished || rt.settling) return
    rt.settling = true
    for (const [childId, role] of this.roles) {
      if (role.taskId !== rt.task.id) continue
      this.addActivity(rt, { intentId: role.intentId, worker: 'engine', kind: 'system', summary: '任务预算耗尽，向子会话发送收尾指令' })
      void this.nudge(rt, childId, settlePrompt(role.role, role.kind))
    }
    this.pushEvent(rt, { kind: 'budget', summary: '任务级预算耗尽' })
  }

  async drain(rt, graceMs) {
    const running = [...rt.running.values()]
    if (running.length > 0) {
      await Promise.race([Promise.allSettled(running), sleep(graceMs > 0 ? graceMs : 0)])
    }
    if (rt.running.size === 0) return
    this.interruptChildren(rt)
    await Promise.race([Promise.allSettled([...rt.running.values()]), sleep(15000)])
  }

  /* --------------------------------------------------------------- planner */

  async plannerRound(rt, triggers) {
    const t = rt.task
    if (t.round >= t.limits.maxRounds) return
    t.round += 1
    const round = t.round
    const since = t.lastPlannerRoundAt
    t.lastPlannerRoundAt = Date.now()
    const staleBrief = Boolean(t.brief) && (round - t.brief.round) > 1
    const prompt = plannerPrompt({
      task: t,
      view: plannerView(t, {
        factsLimit: 5,
        digest: digestOf(t),
        delta: deltaOf(t, since),
        staleBrief,
      }),
      triggers,
      round,
    })
    this.addActivity(rt, {
      intentId: null,
      worker: 'planner',
      kind: 'round',
      summary: `规划第 ${round} 轮`,
      detail: triggers.map(x => `${x.kind}:${x.summary || ''}`).join('\n'),
    })
    let outcome
    try {
      outcome = await this.runChild(rt, {
        role: 'planner',
        key: `plan-${round}`,
        label: `ARTEX planner · round ${round}`,
        prompt,
        timeoutMs: t.limits.plannerTimeoutMs,
        cwd: this.config.isolateWorkdir ? t.outDir : undefined,
        deny: PLANNER_DENY,
      })
    } catch (error) {
      this.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'error',
        summary: `规划第 ${round} 轮失败`,
        detail: String(error?.message || error),
      })
      throw error
    }
    this.addActivity(rt, {
      intentId: null,
      worker: 'planner',
      kind: 'result',
      summary: `规划第 ${round} 轮结论`,
      detail: outcome.text,
    })
    await this.persist(rt)
  }

  /* ---------------------------------------------------------------- worker */

  dispatchWorkers(rt) {
    if (rt.finished || rt.settling || rt.completing || rt.abort.signal.aborted) return
    const t = rt.task
    while (rt.running.size < t.limits.maxWorkers) {
      const intent = t.intents.find(i => i.state === 'open')
      if (!intent) break
      const workerName = `work#${rt.running.size + 1}`
      claimIntent(t, intent.id, workerName)
      this.addActivity(rt, {
        intentId: intent.id,
        worker: workerName,
        kind: 'start',
        summary: `worker 领取意图 #${intent.id}：${oneLine(intent.summary, 120)}`,
      })
      const promise = this.runWorker(rt, intent, workerName).catch((error) => {
        this.logger.warn?.(`[artex] worker #${intent.id} failed: ${error?.message || error}`)
      }).finally(() => {
        rt.running.delete(intent.id)
      })
      rt.running.set(intent.id, promise)
    }
  }

  async runWorker(rt, intent, workerName) {
    const t = rt.task
    const prompt = workerPrompt({ task: t, intent, view: workerView(t, intent, { factsLimit: 5 }) })
    let outcome
    try {
      outcome = await this.runChild(rt, {
        role: 'worker',
        key: `intent-${intent.id}`,
        intentId: intent.id,
        kind: intent.kind,
        label: `ARTEX worker · intent #${intent.id}`,
        prompt,
        timeoutMs: t.limits.workerTimeoutMs,
        cwd: this.config.isolateWorkdir ? `${t.outDir}/i${intent.id}` : undefined,
        deny: WORKER_DENY,
      })
    } catch (error) {
      this.finishWorker(rt, intent, {
        text: '',
        stopReason: 'error',
        timedOut: false,
        writes: { facts: 0, findings: 0, resources: 0, outcomes: { found: 0, none: 0, inconclusive: 0, blueprint: 0 } },
        error: String(error?.message || error),
      })
      return
    }
    this.finishWorker(rt, intent, outcome)
  }

  finishWorker(rt, intent, outcome) {
    const t = rt.task
    const writes = outcome.writes || { facts: 0, findings: 0, resources: 0 }
    const outcomes = writes.outcomes || { found: 0, none: 0, inconclusive: 0, blueprint: 0 }
    let state
    let reason
    if (outcome.error) {
      state = 'blocked'
      reason = outcome.error
    } else if (rt.siblingStops?.has(intent.id)) {
      state = 'stopped'
      reason = 'sibling_breakthrough'
    } else if (outcome.timedOut) {
      state = 'exhausted'
      reason = 'worker 预算耗尽'
    } else if (outcome.stopReason === 'aborted') {
      state = 'stopped'
      reason = 'aborted'
    } else if (outcome.stopReason === 'max-tokens') {
      state = 'exhausted'
      reason = 'max_tokens'
    } else if (intent.kind === 'pursue') {
      if (outcomes.found > 0 || writes.findings > 0) {
        state = 'done'
        reason = 'path_success'
      } else if (outcomes.none > 0) {
        state = 'failed'
        reason = 'path_dead'
      } else {
        state = 'exhausted'
        reason = 'no_evidence'
      }
    } else {
      state = 'done'
      reason = 'enumerated'
    }
    finishIntent(t, intent.id, { state, output: outcome.text, reason, writes })
    this.addActivity(rt, {
      intentId: intent.id,
      worker: intent.worker,
      kind: 'result',
      summary: `意图 #${intent.id} 结束：${state}`,
      detail: outcome.text || outcome.error || '',
      isError: state === 'blocked',
    })
    this.pushEvent(rt, {
      kind: 'done',
      intentId: intent.id,
      state,
      summary: `${oneLine(intent.summary, 100)}${outcome.text ? ` → ${oneLine(outcome.text, 160)}` : ''}`,
    })
    void this.persist(rt)
  }

  /* ------------------------------------------------------------------ child */

  async runChild(rt, spec) {
    const parent = rt.ownerAgent
    const controller = new AbortController()
    const onAbort = () => {
      try { controller.abort(rt.abort.signal.reason) } catch { /* ignore */ }
    }
    rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    let activation
    try {
      if (spec.cwd) await mkdir(spec.cwd, { recursive: true }).catch(() => undefined)
      const request = {
        prompt: [{ type: 'text', text: spec.prompt }],
        parent,
        ...spec.cwd ? { cwd: spec.cwd } : {},
        ...spec.deny && spec.deny.length > 0 ? { toolFilter: { deny: spec.deny } } : {},
      }
      activation = await this.subagents.startActivation({
        provider: this.providerName,
        label: spec.label,
        request,
        signal: controller.signal,
        delivery: 'caller',
      })
    } catch (error) {
      rt.abort.signal.removeEventListener('abort', onAbort)
      throw new Error(`启动 ${spec.role} 子会话失败：${error?.message || error}`)
    }
    const childId = activation.childId
    const role = {
      taskId: rt.task.id,
      role: spec.role,
      kind: spec.kind || null,
      intentId: spec.intentId ?? null,
      writes: { facts: 0, findings: 0, resources: 0, outcomes: { found: 0, none: 0, inconclusive: 0, blueprint: 0 } },
      pending: new Map(),
    }
    this.roles.set(childId, role)
    if (spec.key) rt.children.set(spec.key, childId)
    try {
      return await this.awaitChild(rt, activation, spec, role)
    } finally {
      if (spec.key) rt.children.delete(spec.key)
      this.roles.delete(childId)
      rt.abort.signal.removeEventListener('abort', onAbort)
    }
  }

  async awaitChild(rt, activation, spec, role) {
    const settled = activation.result.then(
      result => ({ kind: 'settled', result }),
      error => ({ kind: 'settled', result: { output: [], stopReason: 'error', diagnostic: String(error?.message || error) } }),
    )
    const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : 0
    const first = await Promise.race([
      settled,
      timeoutMs > 0 ? this.abortOrTimeout(rt, timeoutMs) : this.abortOnly(rt),
    ])

    if (first.kind === 'settled') return this.outcome(first.result, role, false)

    if (first.kind === 'abort') {
      this.interruptChild(rt, activation.childId)
      const after = await Promise.race([settled, sleep(15000).then(() => ({ kind: 'hard' }))])
      if (after.kind === 'settled') return this.outcome(after.result, role, true)
      void activation.dispose().catch(() => undefined)
      return this.outcome({ output: [], stopReason: 'aborted' }, role, true)
    }

    // 墙钟预算耗尽：先给收尾机会（ARTEX settlement），宽限期后再硬停。
    await this.nudge(rt, activation.childId, settlePrompt(spec.role))
    const grace = Number(rt.task.limits.settleGraceMs) || 0
    const graced = await Promise.race([settled, sleep(grace > 0 ? grace : 0).then(() => ({ kind: 'grace' }))])
    if (graced.kind === 'settled') return this.outcome(graced.result, role, true)
    this.interruptChild(rt, activation.childId)
    const hard = await Promise.race([settled, sleep(30000).then(() => ({ kind: 'hard' }))])
    if (hard.kind === 'settled') return this.outcome(hard.result, role, true)
    void activation.dispose().catch(() => undefined)
    return this.outcome({ output: [], stopReason: 'timeout' }, role, true)
  }

  outcome(result, role, timedOut) {
    return {
      text: textOf(result?.output),
      stopReason: result?.stopReason || 'completed',
      timedOut,
      writes: { ...role.writes, outcomes: { ...role.writes.outcomes } },
    }
  }

  abortOnly(rt) {
    return new Promise((resolve) => {
      if (rt.abort.signal.aborted) return resolve({ kind: 'abort' })
      const onAbort = () => {
        rt.abort.signal.removeEventListener('abort', onAbort)
        resolve({ kind: 'abort' })
      }
      rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  abortOrTimeout(rt, ms) {
    return new Promise((resolve) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        rt.abort.signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish({ kind: 'abort' })
      const timer = setTimeout(() => finish({ kind: 'timeout' }), ms)
      timer.unref?.()
      if (rt.abort.signal.aborted) return finish({ kind: 'abort' })
      rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async nudge(rt, childId, text) {
    try {
      await this.subagents.sendMessage(
        rt.ownerAgent,
        childId,
        [{ type: 'text', text }],
        { signal: new AbortController().signal },
      )
    } catch (error) {
      this.logger.warn?.(`[artex] steer ${childId} failed: ${error?.message || error}`)
    }
  }

  /* ----------------------------------------------------------- event queue */

  pushEvent(rt, event) {
    rt.events.push(event)
    this.wake(rt, 'edge')
  }

  wake(rt, kind) {
    const waiters = rt.waiters.splice(0, rt.waiters.length)
    for (const waiter of waiters) waiter(kind === 'abort' ? 'abort' : 'edge')
  }

  waitEvent(rt, timeoutMs) {
    if (rt.events.length > 0) return Promise.resolve('edge')
    return new Promise((resolve) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        rt.abort.signal.removeEventListener('abort', onAbort)
        const index = rt.waiters.indexOf(finish)
        if (index >= 0) rt.waiters.splice(index, 1)
        resolve(value)
      }
      const onAbort = () => finish('abort')
      const timer = setTimeout(() => finish('heartbeat'), Math.max(50, timeoutMs))
      timer.unref?.()
      if (rt.abort.signal.aborted) return finish('abort')
      rt.waiters.push(finish)
      rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  sleepOrAbort(rt, ms) {
    return new Promise((resolve) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        rt.abort.signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish('abort')
      const timer = setTimeout(() => finish('timeout'), Math.max(0, ms))
      timer.unref?.()
      if (rt.abort.signal.aborted) return finish('abort')
      rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /* --------------------------------------------------------------- mutations */

  addActivity(rt, input) {
    const activity = graphAddActivity(rt.task, input)
    void this.storeFor(rt.task.cwd).tasks.appendActivity(rt.task, activity)
    return activity
  }

  persist(rt) {
    return this.storeFor(rt.task.cwd).tasks.save(rt.task)
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
    if (!usage) return
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    if (input === 0 && output === 0) return
    const t = rt.task
    t.usage = t.usage || { input_tokens: 0, output_tokens: 0, calls: 0, by_role: {} }
    t.usage.by_role = t.usage.by_role || {}
    t.usage.input_tokens += input
    t.usage.output_tokens += output
    t.usage.calls += 1
    const slot = t.usage.by_role[role.role] || (t.usage.by_role[role.role] = { input_tokens: 0, output_tokens: 0, calls: 0 })
    slot.input_tokens += input
    slot.output_tokens += output
    slot.calls += 1
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
      status: task.status,
      live: Boolean(live && !live.finished),
      mode: task.mode || 'objective',
      description: task.description,
      goal: task.goal,
      rounds: task.round,
      limits: task.limits,
      brief: task.brief?.text || undefined,
      brief_round: task.brief?.round ?? undefined,
      digest: digestOf(task),
      goals: task.goals.map(g => ({ id: g.id, text: g.text, status: g.status, evidence: g.evidence })),
      intents: {
        total: task.intents.length,
        open: openIntents(task).length,
        running: runningIntents(task).length,
        by_state: stateCount,
      },
      facts: task.facts.length,
      findings: task.findings.map(f => ({ id: f.id, title: f.title, severity: f.severity, intent_id: f.intentId })),
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
