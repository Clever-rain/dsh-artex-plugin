/**
 * 独立分析者：按触发条件运行只读 analyst 并把建议写回图。
 */

import { analystPrompt } from './prompts.js'
import { digestOf, deltaOf, plannerView } from './graph.js'
import { sleep } from './util.js'

export async function maybeRunAnalyst(engine, rt, triggers = []) {
    const t = rt.task
    const mode = rt.viewMode === 'analyst' || rt.viewMode === 'hybrid'
      ? rt.viewMode
      : 'planner'
    if (mode === 'planner' || rt.finished || rt.abort.signal.aborted) return null
    // 第一轮还没有 brief，分析没有意义。
    if (t.round <= 1) return null
    if (triggers.some(x => x.kind === 'final')) return null
    if ((rt.analystRuns || 0) >= (Number(engine.config.analystMaxRuns) || 0)) return null
    const now = Date.now()
    if (now - (rt.lastAnalystAt || 0) < (Number(engine.config.analystCooldownMs) || 0)) return null

    const every = Math.max(1, Number(engine.config.analystEveryRounds) || 3)
    const factThreshold = Math.max(1, Number(engine.config.analystFactThreshold) || 8)
    const factsSince = t.facts.length - (rt.lastAnalystFactCount || 0)
    const failedSince = t.intents.filter(i => i.state === 'failed' && (i.endedAt || 0) > (rt.lastAnalystAt || 0)).length
    const stale = Boolean(t.brief) && (t.round - t.brief.round) > 1
    let should = false
    if (mode === 'analyst') {
      should = true
    } else if (t.mode === 'audit') {
      should = (t.round - (rt.lastAnalystRound || 0) >= every) || factsSince >= factThreshold
    } else {
      should = failedSince > 0 || (factsSince > 0 && (t.round - (rt.lastAnalystRound || 0) >= every))
    }
    if (stale) should = true
    if (!should) return null

    const since = rt.lastAnalystAt || 0
    rt.analystRuns = (rt.analystRuns || 0) + 1
    rt.lastAnalystAt = now
    rt.lastAnalystFactCount = t.facts.length
    rt.lastAnalystRound = t.round

    const view = plannerView(t, {
      factsLimit: 8,
      digest: digestOf(t),
      delta: deltaOf(t, since),
      staleBrief: stale,
    })
    engine.addActivity(rt, {
      intentId: null,
      worker: 'analyst',
      kind: 'round',
      summary: `独立分析第 ${t.round} 轮（${mode}）`,
      detail: `facts_since=${factsSince} failed_since=${failedSince} stale=${stale}`,
    })
    try {
      const outcome = await engine.runChild(rt, {
        role: 'analyst',
        key: `analyst-${t.round}`,
        label: `ARTEX analyst · round ${t.round}`,
        prompt: analystPrompt({ task: t, view }),
        timeoutMs: Number(engine.config.analystTimeoutMs) || 180000,
        cwd: engine.config.isolateWorkdir ? t.outDir : undefined,
      })
      engine.addActivity(rt, {
        intentId: null,
        worker: 'analyst',
        kind: 'result',
        summary: `独立分析第 ${t.round} 轮结论`,
        detail: outcome.text,
      })
      void engine.persist(rt)
      return outcome
    } catch (error) {
      engine.addActivity(rt, {
        intentId: null,
        worker: 'analyst',
        kind: 'error',
        summary: `独立分析第 ${t.round} 轮失败`,
        detail: String(error?.message || error),
      })
      engine.logger.warn?.(`[artex] analyst failed: ${error?.message || error}`)
      return null
    }
  }

  /** analyst 写入独立分析；planner 读取后自行决定是否采纳。 */
