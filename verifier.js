/**
 * 独立验证者（verifier）：按 finding 触发，只验证单条 finding，不参与规划。
 *
 * 为什么独立而不让 analyst 做：analyst 是战略复审（brief/方向），验证是逐条证据复现，
 * 合并会角色膨胀。所以 verifier 的 toolFilter 白名单只有"读 + retest + record_fact"，
 * 也没有任何决策入口（不能 prove、不能派意图）；复核结论经 artex_retest_finding 落库。
 *
 * 串行：每任务一条 promise 链（发现率高时也不并发，避免 token 浪费）。
 */

import { oneLine, sleep } from './util.js'
import { verifierPrompt } from './prompts.js'

/** finding 落库后排队复核（引擎在 recordFinding 边界调用）。 */
export function queueVerifier(engine, rt, finding) {
    if (engine.config.enableVerifier !== true) return
    if (!finding || rt.finished) return
    rt.verifierQueue = (rt.verifierQueue ?? Promise.resolve())
      .then(() => runOne(engine, rt, finding))
      .catch((error) => {
        engine.logger?.warn?.(`[artex] verifier finding #${finding?.id}: ${error?.message || error}`)
        engine.addActivity(rt, {
          intentId: finding?.intentId ?? null,
          worker: 'engine',
          kind: 'error',
          summary: `verifier 复核 finding #${finding?.id} 失败已被吞回队列后面`,
          detail: String(error?.message || error),
        })
      })
    // 终态前给 verifier 一条收敛机会：drain 里 await rt.verifierQueue。
  }

async function runOne(engine, rt, finding) {
    if (rt.finished || rt.completing || rt.abort.signal.aborted) return
    if (rt.settling) return // 收尾期不再发起新的复测（预算已经不够烧）
    const t = rt.task
    const prompt = verifierPrompt({ task: t, finding })
    engine.addActivity(rt, {
      intentId: finding.intentId ?? null,
      worker: 'engine',
      kind: 'system',
      summary: `verifier 复核 finding #${finding.id}：${oneLine(finding.title, 80)}`,
    })
    const remaining = typeof engine.remainingBudgetMs === 'function' ? engine.remainingBudgetMs(rt) : Infinity
    const timeoutMs = remaining === Infinity
      ? (Number(engine.config.verifierTimeoutMs) || 300000)
      : Math.max(1000, Math.min(Number(engine.config.verifierTimeoutMs) || 300000, remaining))
    try {
      const outcome = await engine.runChild(rt, {
        role: 'verifier',
        key: `verify-${finding.id}`,
        intentId: finding.intentId ?? null,
        label: `ARTEX verifier · finding #${finding.id}`,
        prompt,
        timeoutMs,
        cwd: engine.config.isolateWorkdir ? `${t.outDir}/v${finding.id}` : undefined,
      })
      if (outcome?.text) {
        engine.addActivity(rt, {
          intentId: finding.intentId ?? null,
          worker: 'verifier',
          kind: 'verify',
          summary: `finding #${finding.id} 复核结论`,
          detail: outcome.text,
        })
      }
      // verifier 的落库结论由它自己调 artex_retest_finding 完成；这里只把文本快照进过程库。
      void engine.persist(rt)
    } finally {
      // 让链路喘口气：finding 密集时防刷屏 spawn（也比 budget 更平滑地节流）。
      await sleep(250)
    }
  }
