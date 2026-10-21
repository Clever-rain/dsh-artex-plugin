/**
 * 调度器：主循环、规划轮、派发 worker、突破停止、收尾与证明轮。
 */

import { allGoalsMet, claimIntent, finishIntent, digestOf, deltaOf, plannerView, workerView } from './graph.js'
import { plannerPrompt, workerPrompt, settlePrompt, siblingStopPrompt } from './prompts.js'
import { oneLine, sleep } from './util.js'

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
          engine.finish(rt, 'timeout', '任务级预算耗尽')
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

export function beginSettling(engine, rt) {
    if (rt.finished || rt.settling) return
    rt.settling = true
    for (const [childId, role] of engine.roles) {
      if (role.taskId !== rt.task.id) continue
      engine.addActivity(rt, { intentId: role.intentId, worker: 'engine', kind: 'system', summary: '任务预算耗尽，向子会话发送收尾指令' })
      void engine.nudge(rt, childId, settlePrompt(role.role, role.kind))
    }
    engine.pushEvent(rt, { kind: 'budget', summary: '任务级预算耗尽' })
  }

export async function drain(engine, rt, graceMs) {
    const running = [...rt.running.values()]
    if (running.length > 0) {
      await Promise.race([Promise.allSettled(running), sleep(graceMs > 0 ? graceMs : 0)])
    }
    if (rt.running.size === 0) return
    engine.interruptChildren(rt)
    await Promise.race([Promise.allSettled([...rt.running.values()]), sleep(15000)])
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
          key: `plan-${round}`,
          label: `ARTEX planner · round ${round}`,
          prompt,
          timeoutMs: options.timeoutMs ?? t.limits.plannerTimeoutMs,
          cwd: engine.config.isolateWorkdir ? t.outDir : undefined,
        })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        engine.addActivity(rt, {
          intentId: null,
          worker: 'planner',
          kind: 'error',
          summary: `规划第 ${round} 轮失败（第 ${attempt}/${attempts} 次）`,
          detail: String(error?.message || error),
        })
        if (attempt < attempts) await sleep(Math.min(5000, Math.max(200, (t.limits.debounceMs || 800) * attempt)))
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
  return task.intents
    .filter(i => i.state === 'open')
    .sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5) || a.id - b.id)[0]
}

export function dispatchWorkers(engine, rt) {
    if (rt.finished || rt.settling || rt.completing || rt.abort.signal.aborted) return
    const t = rt.task
    while (rt.running.size < t.limits.maxWorkers) {
      const intent = selectNextIntent(t)
      if (!intent) break
      const workerName = `work#${rt.running.size + 1}`
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
        timeoutMs: t.limits.workerTimeoutMs,
        cwd: engine.config.isolateWorkdir ? `${t.outDir}/i${intent.id}` : undefined,
      })
    } catch (error) {
      engine.finishWorker(rt, intent, {
        text: '',
        stopReason: 'error',
        timedOut: false,
        writes: { facts: 0, findings: 0, resources: 0, outcomes: { found: 0, none: 0, inconclusive: 0, blueprint: 0 } },
        error: String(error?.message || error),
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
    if (outcome.error) {
      state = 'blocked'
      reason = outcome.error
    } else if (rt.siblingStops?.has(intent.id)) {
      state = 'stopped'
      reason = t.mode === 'audit' ? 'goal_met' : 'sibling_breakthrough'
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
