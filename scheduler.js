/**
 * 调度器：主循环、规划轮、派发 worker、突破停止、收尾与证明轮。
 */

import { allGoalsMet, claimIntent, finishIntent, digestOf, deltaOf, plannerView, workerView, degradedView, coverageOf, intentDepsSatisfied } from './graph.js'
import { plannerPrompt, workerPrompt, settlePrompt, siblingStopPrompt, stallNudgePrompt } from './prompts.js'
import { oneLine, sleep, classifyError, retryBackoffMs, isRetryWorthless, normalizeStopReason } from './util.js'

/** 子会话墙钟与任务剩余预算取 min：预算尾巴上新起的子会话不能超 budget 一整段。 */
function clampToBudget(engine, rt, timeoutMs) {
  const remaining = typeof engine.remainingBudgetMs === 'function' ? engine.remainingBudgetMs(rt) : Infinity
  if (remaining === Infinity) return timeoutMs
  const ms = Number(timeoutMs) || 0
  if (ms <= 0) return Math.max(1000, remaining)
  return Math.max(1000, Math.min(ms, remaining))
}

export async function runLoop(engine, rt) {
    const t = rt.task
    t.status = 'running'
    engine.persist(rt)
    try {
      while (!rt.abort.signal.aborted && !rt.finished) {
        if (rt.settling) {
          await engine.drain(rt, t.limits.settleGraceMs)
          if (!rt.finished && !rt.finalProofDone && (t.facts.length > 0 || t.findings.length > 0) && t.goals.some(g => g.status !== 'met')) {
            // 收尾证明轮：预算已耗尽，但已有事实时用宽限时间做最后一次目标判定。
            rt.finalProofDone = true
            const timeoutMs = Math.max(1000, Math.min(
              Number(t.limits.plannerTimeoutMs) || 60000,
              Number(t.limits.settleGraceMs) || 30000,
            ))
            await engine.plannerRound(rt, [{ kind: 'final', summary: '预算耗尽，做最后一次目标判定' }], { force: true, timeoutMs })
            if (allGoalsMet(t)) {
              await engine.completeGracefully(rt, '全部目标已证明（收尾证明轮）')
              break
            }
          }
          engine.finish(rt, rt.finishedStatus || 'timeout', rt.finishDetail || '任务级预算耗尽')
          break
        }
        if (allGoalsMet(t)) {
          await engine.completeGracefully(rt, '全部目标已证明')
          break
        }
        engine.dispatchWorkers(rt)
        const active = rt.running.size > 0 || t.intents.some(i => i.state === 'open')
        if (!active) {
          if (t.round >= t.limits.maxRounds) {
            const unmet = t.goals.some(g => g.status !== 'met')
            if (!rt.finalProofDone && unmet) {
              // 收官证明轮：轮次用尽但已有新证据时，给规划者最后一次判目标的机会。
              rt.finalProofDone = true
              await engine.plannerRound(rt, [{ kind: 'final', summary: '轮次用尽，做最后一次目标判定' }], { force: true })
              if (rt.abort.signal.aborted || rt.finished) break
              if (allGoalsMet(t)) {
                await engine.completeGracefully(rt, '全部目标已证明（收官证明轮）')
                break
              }
            }
            engine.finish(rt, 'max_rounds', `达到规划轮次上限 ${t.limits.maxRounds}`)
            break
          }
          await engine.plannerRound(rt, rt.events.splice(0))
          if (rt.abort.signal.aborted || rt.finished) break
          if (allGoalsMet(t)) {
            await engine.completeGracefully(rt, '全部目标已证明')
            break
          }
          if (t.limits.maxWorkers === 0) {
            engine.finish(rt, 'planned', '仅规划模式（max_workers=0），不派 worker')
            break
          }
          engine.dispatchWorkers(rt)
          if (rt.running.size === 0 && !t.intents.some(i => i.state === 'open')) {
            rt.stalls += 1
            if (rt.stalls >= t.limits.maxStalls) {
              engine.finish(rt, 'stalled', `连续 ${rt.stalls} 轮规划没有产出可执行的新方向`)
              break
            }
            await engine.sleepOrAbort(rt, Math.max(500, t.limits.debounceMs))
          }
          continue
        }
        const ev = await engine.waitEvent(rt, t.limits.heartbeatMs)
        if (rt.abort.signal.aborted || rt.finished) break
        if (ev !== 'heartbeat') await engine.sleepOrAbort(rt, t.limits.debounceMs)
        else engine.checkStalledWorkers(rt) // 心跳除了规划，也复查在跑 work 的静默量
        if (rt.abort.signal.aborted || rt.finished) break
        const triggers = rt.events.splice(0)
        if (t.round >= t.limits.maxRounds) continue
        await engine.plannerRound(rt, triggers)
        if (allGoalsMet(t)) {
          await engine.completeGracefully(rt, '全部目标已证明')
          break
        }
      }
    } catch (error) {
      if (!rt.finished) {
        const evidence = t.facts.length + t.findings.length
        if (evidence > 0) {
          engine.finish(rt, 'stopped', `planner 连续失败；已保留 ${evidence} 条事实现场，可人工复核（${String(error?.message || error)}）`)
        } else {
          engine.finish(rt, 'failed', String(error?.message || error))
        }
      }
    } finally {
      await engine.drain(rt, 15000)
      engine.finish(rt, rt.finishedStatus || 'stopped', rt.finishDetail || '引擎退出')
      await engine.flushPersist(rt)
      engine.releaseStore(rt) // 回收持久化层内存状态；快照/JSONL 保留可重载
      rt.doneResolve(t)
      engine.cleanupRoles(rt)
    }
  }

export function finish(engine, rt, status, detail) {
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
    // audit 收口硬指标：确定性覆盖矩阵随终态一并存档（暂停不贴，paused 还要续跑）。
    if (t.mode === 'audit' && status !== 'paused') {
      t.report.coverage = coverageOf(t)
      if (t.report.coverage.gaps.length > 0) {
        t.report.coverage_gap_summary = `覆盖缺口 goal ${t.report.coverage.gaps.map(id => `#${id}`).join(' ')}：${t.report.coverage.gaps.length}/${t.report.coverage.total} 条目标没有任何相关证据`
      }
    }
    if (rt.deadlineTimer) {
      clearTimeout(rt.deadlineTimer)
      rt.deadlineTimer = undefined
    }
    engine.interruptChildren(rt)
    engine.wake(rt, 'abort')
    void engine.persist(rt)
  }

  /**
   * 目标达成后的"突破收尾"：先停兄弟 pursue，给它们一个写回现场的宽限，
   * 再硬停并收官。顺序不能反——finish() 之后写操作会被拒绝。
   */

export async function completeGracefully(engine, rt, detail) {
    if (rt.completing || rt.finished) return
    rt.completing = true
    const t = rt.task
    const runningIds = [...rt.running.keys()]
    if (runningIds.length > 0) {
      rt.siblingStops = new Set(runningIds)
      for (const intentId of runningIds) {
        const childId = rt.children.get(`intent-${intentId}`)
        if (!childId) continue
        engine.addActivity(rt, {
          intentId,
          worker: 'engine',
          kind: 'system',
          summary: '目标已由其它路径达成，发送"停止并回报现场"指令',
        })
        void engine.nudge(rt, childId, siblingStopPrompt())
      }
      const grace = Number(t.limits.breakthroughGraceMs) || 0
      await Promise.race([Promise.allSettled([...rt.running.values()]), sleep(grace)])
      if (rt.running.size > 0) {
        for (const intentId of [...rt.running.keys()]) {
          const childId = rt.children.get(`intent-${intentId}`)
          if (childId) engine.interruptChild(rt, childId)
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
    engine.finish(rt, 'completed', detail)
  }

export function beginSettling(engine, rt, options = {}) {
    if (rt.finished || rt.settling) return
    rt.settling = true
    if (!rt.finishDetail && options.reason) rt.finishDetail = options.reason
    for (const [childId, role] of engine.roles) {
      if (role.taskId !== rt.task.id) continue
      engine.addActivity(rt, { intentId: role.intentId, worker: 'engine', kind: 'system', summary: `${options.reason || '任务预算耗尽'}，向子会话发送收尾指令` })
      void engine.nudge(rt, childId, settlePrompt(role.role, role.kind))
    }
    engine.pushEvent(rt, { kind: 'budget', summary: options.reason || '任务级预算耗尽' })
  }

export async function drain(engine, rt, graceMs) {
    const running = [...rt.running.values()]
    if (running.length > 0) {
      await Promise.race([Promise.allSettled(running), sleep(graceMs > 0 ? graceMs : 0)])
    }
    if (rt.running.size === 0) {
      // verifier 串行链给一次收敛机会（终态快照里结论要完整）。
      if (rt.verifierQueue) await Promise.race([rt.verifierQueue, sleep(Math.min(5000, Math.max(1000, graceMs)))])
      return
    }
    engine.interruptChildren(rt)
    await Promise.race([Promise.allSettled([...rt.running.values()]), sleep(15000)])
    if (rt.verifierQueue) await Promise.race([rt.verifierQueue, sleep(5000)])
  }

  /* --------------------------------------------------------------- planner */

export async function plannerRound(engine, rt, triggers, options = {}) {
    const t = rt.task
    if (!options.force && t.round >= t.limits.maxRounds) return
    t.round += 1
    const round = t.round
    const since = t.lastPlannerRoundAt
    t.lastPlannerRoundAt = Date.now()
    const staleBrief = Boolean(t.brief) && (round - t.brief.round) > 1
    await engine.maybeRunAnalyst(rt, triggers)
    // 态势构建与子会话重试分离：投影构建失败走降级通道，不再炸掉整个任务。
    let view
    try {
      view = plannerView(t, {
        factsLimit: 5,
        digest: digestOf(t),
        delta: deltaOf(t, since),
        staleBrief,
      })
      rt.viewFailures = 0
      rt.lastViewError = undefined
    } catch (error) {
      rt.viewFailures = (rt.viewFailures || 0) + 1
      rt.lastViewError = String(error?.message || error)
      engine.addActivity(rt, {
        intentId: null,
        worker: 'planner',
        kind: 'error',
        summary: `态势投影构建失败（连续第 ${rt.viewFailures} 次）`,
        detail: rt.lastViewError,
      })
      engine.logger?.warn?.(`[artex] plannerView failed: ${rt.lastViewError}`)
      void engine.persist(rt)
      if (options.force) {
        // 收官/收尾证明轮退无可退：降级视图继续，planner 依据 brief 与本轮事件谨慎判定。
        view = degradedView(t, rt.lastViewError)
      } else if (rt.viewFailures >= 3) {
        throw error // 连续三次：仍按旧语义交给 runLoop 统一收尾（保留现场）
      } else {
        // 短暂降级：本轮不发生规划、轮次让回，等下个事件或心跳重建视图。
        t.round -= 1
        t.lastPlannerRoundAt = since
        return
      }
    }
    const prompt = plannerPrompt({ task: t, view, triggers, round })
    engine.addActivity(rt, {
      intentId: null,
      worker: 'planner',
      kind: 'round',
      summary: `规划第 ${round} 轮`,
      detail: triggers.map(x => `${x.kind}:${x.summary || ''}`).join('\n'),
    })
    let outcome
    let lastError
    const configuredRetries = engine.config.plannerRetries
    const retries = configuredRetries == null ? 2 : Math.max(0, Number(configuredRetries) || 0)
    const attempts = 1 + retries
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        outcome = await engine.runChild(rt, {
          role: 'planner',
          key: `plan-${round}-a${attempt}`,
          label: `ARTEX planner · round ${round}${attempt > 1 ? ` · retry ${attempt}` : ''}`,
          prompt,
          timeoutMs: clampToBudget(engine, rt, options.timeoutMs ?? t.limits.plannerTimeoutMs),
          cwd: engine.config.isolateWorkdir ? t.outDir : undefined,
        })
        if (outcome?.timedOut && !options.force && !rt.abort.signal.aborted && attempt < attempts) {
          // 子会话静默超时与启动瞬态失败同级：消耗一次重试，轮次不重计。
          engine.addActivity(rt, {
            intentId: null,
            worker: 'planner',
            kind: 'error',
            summary: `规划第 ${round} 轮子会话超时（第 ${attempt}/${attempts} 次，重试）`,
          })
          outcome = undefined
          continue
        }
        lastError = undefined
        break
      } catch (error) {
        const category = classifyError(error)
        lastError = error
        engine.addActivity(rt, {
          intentId: null,
          worker: 'planner',
          kind: 'error',
          summary: `规划第 ${round} 轮失败（第 ${attempt}/${attempts} 次，${category}）`,
          detail: String(error?.message || error),
        })
        // context 类错误重试同一提示没有意义，快速失败交给收尾；其余按类别退避。
        if (isRetryWorthless(category)) break
        if (attempt < attempts) {
          const backoff = retryBackoffMs(category, attempt)
          if (typeof engine.sleepOrAbort === 'function') await engine.sleepOrAbort(rt, backoff)
          else await sleep(backoff)
        }
      }
    }
    if (!outcome) throw lastError
    engine.addActivity(rt, {
      intentId: null,
      worker: 'planner',
      kind: 'result',
      summary: `规划第 ${round} 轮结论`,
      detail: outcome.text,
    })
    void engine.persist(rt)
  }

  /* --------------------------------------------------------------- analyst */

  /**
   * 按 viewMode 与触发策略决定是否在规划轮之前跑一次独立分析。
   * analyst 只读、只写 analysis，不参与决策；失败不影响规划（记一条 error 活动）。
   */

export function selectNextIntent(task) {
  // 显式依赖门禁：depends_on 里的意图全部 done 才可领取；依赖失败的方向不会被调度，
  // 由 planner 在下一轮决定改路线（意图视图里标 blocked_by_deps）。
  return task.intents
    .filter(i => i.state === 'open' && intentDepsSatisfied(task, i))
    .sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5) || a.id - b.id)[0]
}

export function dispatchWorkers(engine, rt) {
    if (rt.finished || rt.settling || rt.completing || rt.abort.signal.aborted) return
    const t = rt.task
    while (rt.running.size < t.limits.maxWorkers) {
      const intent = selectNextIntent(t)
      if (!intent) break
      // 单调递增的全任务序号：跨轮不重名，日志/血缘里不再出现"两个 work#2"。
      rt.workerSeq = (rt.workerSeq || 0) + 1
      const workerName = `work#${rt.workerSeq}`
      claimIntent(t, intent.id, workerName)
      engine.addActivity(rt, {
        intentId: intent.id,
        worker: workerName,
        kind: 'start',
        summary: `worker 领取意图 #${intent.id}：${oneLine(intent.summary, 120)}`,
      })
      const promise = engine.runWorker(rt, intent, workerName).catch((error) => {
        engine.logger.warn?.(`[artex] worker #${intent.id} failed: ${error?.message || error}`)
      }).finally(() => {
        rt.running.delete(intent.id)
      })
      rt.running.set(intent.id, promise)
    }
  }

export async function runWorker(engine, rt, intent, workerName) {
    const t = rt.task
    const prompt = workerPrompt({ task: t, intent, view: workerView(t, intent, { factsLimit: 5 }) })
    let outcome
    try {
      outcome = await engine.runChild(rt, {
        role: 'worker',
        key: `intent-${intent.id}`,
        intentId: intent.id,
        kind: intent.kind,
        label: `ARTEX worker · intent #${intent.id}`,
        prompt,
        timeoutMs: clampToBudget(engine, rt, t.limits.workerTimeoutMs),
        cwd: engine.config.isolateWorkdir ? `${t.outDir}/i${intent.id}` : undefined,
      })
    } catch (error) {
      const message = String(error?.message || error)
      const category = classifyError(error)
      // 启动类瞬态错误自动重排一次：意图回炉 open，下一拍 dispatch 重领，planner 不必换措辞重派。
      if (['rate_limit', 'server', 'network'].includes(category)
        && (intent.retries || 0) < 1
        && !rt.abort.signal.aborted && !rt.finished) {
        intent.retries = (intent.retries || 0) + 1
        finishIntent(t, intent.id, { state: 'open', output: '', reason: `auto_retry(${category})`, writes: intent.writes })
        intent.endedAt = undefined
        engine.addActivity(rt, {
          intentId: intent.id,
          worker: workerName,
          kind: 'system',
          summary: `worker 启动失败（${category}），意图 #${intent.id} 自动重排一次`,
          detail: message,
        })
        engine.pushEvent(rt, { kind: 'intent', summary: `意图 #${intent.id} 启动失败自动重排（${category}）` })
        void engine.persist(rt)
        return
      }
      engine.finishWorker(rt, intent, {
        text: '',
        stopReason: 'error',
        timedOut: false,
        writes: { facts: 0, findings: 0, resources: 0, outcomes: { found: 0, none: 0, inconclusive: 0, blueprint: 0 } },
        error: `[${category}] ${message}`,
      })
      return
    }
    engine.finishWorker(rt, intent, outcome)
  }

export function finishWorker(engine, rt, intent, outcome) {
    const t = rt.task
    const writes = outcome.writes || { facts: 0, findings: 0, resources: 0 }
    const outcomes = writes.outcomes || { found: 0, none: 0, inconclusive: 0, blueprint: 0 }
    let state
    let reason
    const stopReason = normalizeStopReason(outcome.stopReason)
    if (outcome.error) {
      state = 'blocked'
      reason = outcome.error
    } else if (rt.siblingStops?.has(intent.id)) {
      state = 'stopped'
      reason = t.mode === 'audit' ? 'goal_met' : 'sibling_breakthrough'
    } else if (stopReason === 'error') {
      // provider 返回 error：与启动失败同类，记 blocked 而不是 no_evidence exhausted。
      state = 'blocked'
      reason = oneLine(outcome.text || 'provider error', 160)
    } else if (outcome.timedOut || stopReason === 'timeout') {
      state = 'exhausted'
      reason = 'worker 预算耗尽'
    } else if (stopReason === 'aborted') {
      state = 'stopped'
      reason = 'aborted'
    } else if (stopReason === 'max-tokens') {
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
    engine.addActivity(rt, {
      intentId: intent.id,
      worker: intent.worker,
      kind: 'result',
      summary: `意图 #${intent.id} 结束：${state}`,
      detail: outcome.text || outcome.error || '',
      isError: state === 'blocked',
    })
    engine.pushEvent(rt, {
      kind: 'done',
      intentId: intent.id,
      state,
      summary: `${oneLine(intent.summary, 100)}${outcome.text ? ` → ${oneLine(outcome.text, 160)}` : ''}`,
    })
    void engine.persist(rt)
  }

  /* -------------------------------------------------------------- watchdog */

  /**
   * 心跳查房：在跑 worker 静默超过阈值（2× 心跳，且至少 2 分钟）→ 先发唤醒提示；
   * 下个心跳仍无动静 → 强制中断（finishWorker 按 aborted 归 stopped，planner 可重派该方向）。
   * “还活着”的判定时钟挂在 engine.addActivity：任何带 intentId 的写回/进程事件都会清零。
   */
export function checkStalledWorkers(engine, rt) {
    if (rt.finished || rt.settling) return
    const t = rt.task
    const heartbeat = Number(t.limits.heartbeatMs) || 600000
    const stallMs = Math.max(2 * heartbeat, 2 * 60 * 1000)
    const now = Date.now()
    for (const intentId of rt.running.keys()) {
      const intent = t.intents.find(i => i.id === intentId)
      if (!intent) continue
      const last = intent.lastActivityAt || intent.startedAt || now
      if (now - last < stallMs) continue
      rt.stalledNudges = rt.stalledNudges || new Map()
      const nudges = rt.stalledNudges.get(intentId) || 0
      const childId = rt.children.get(`intent-${intentId}`)
      if (nudges === 0) {
        rt.stalledNudges.set(intentId, 1)
        engine.addActivity(rt, {
          intentId,
          worker: 'engine',
          kind: 'system',
          summary: `意图 #${intentId} 静默超过 ${Math.round(stallMs / 60000)} 分钟，发送唤醒提示`,
        })
        if (childId) void engine.nudge(rt, childId, stallNudgePrompt())
        continue
      }
      engine.addActivity(rt, {
        intentId,
        worker: 'engine',
        kind: 'system',
        summary: `意图 #${intentId} 唤醒后仍静默，强制中断（stopped，可被重派）`,
      })
      rt.stalledNudges.delete(intentId)
      if (childId) engine.interruptChild(rt, childId)
    }
  }

  /* ------------------------------------------------------------------ child */

export function pushEvent(engine, rt, event) {
    rt.events.push(event)
    engine.wake(rt, 'edge')
  }

export function wake(engine, rt, kind) {
    const waiters = rt.waiters.splice(0, rt.waiters.length)
    for (const waiter of waiters) waiter(kind === 'abort' ? 'abort' : 'edge')
  }

export function waitEvent(engine, rt, timeoutMs) {
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

export function sleepOrAbort(engine, rt, ms) {
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
