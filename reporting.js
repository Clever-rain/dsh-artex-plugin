/**
 * 任务快照 / 状态查询 / 最终报告。
 */

import { digestOf, openIntents, runningIntents } from './graph.js'
import { formatReport } from './report.js'

export function snapshot(engine, task, live) {
    const stateCount = {}
    for (const intent of task.intents) stateCount[intent.state] = (stateCount[intent.state] || 0) + 1
    const endsAt = task.endedAt ?? Date.now()
    // 证据节点的可信度/结局：让 prove 链在快照与报告里闭环（reason 不再只躺在库里）。
    const evidenceMeta = (id) => {
      if (!id) return {}
      const node = task.facts.find(f => f.id === Number(id)) || task.findings.find(f => f.id === Number(id))
      return {
        evidence_confidence: node?.confidence || (node ? 'finding' : undefined),
        evidence_missing: node ? undefined : true,
      }
    }
    return {
      task_id: task.id,
      owner_session: task.ownerSession,
      status: task.status,
      live: Boolean(live && !live.finished),
      mode: task.mode || 'objective',
      view_mode: task.viewMode || engine.config.viewMode || 'planner',
      provider: task.provider || engine.providerName || engine.config.provider,
      settling: Boolean(live?.settling),
      degraded: live?.lastViewError ? { reason: live.lastViewError, consecutive_failures: live.viewFailures || 0 } : undefined,
      description: task.description,
      goal: task.goal,
      rounds: task.round,
      limits: task.limits,
      campaign: task.campaign || undefined,
      engagement: task.engagement ? { id: task.engagement.id, window: task.engagement.window } : undefined,
      scope: task.policy?.allowedTargets?.length > 0
        ? { allowed_targets: task.policy.allowedTargets, enforcement: task.policy.scopeEnforcement || engine.config.scopeEnforcement || 'warn', violations: Array.isArray(task.violations) ? task.violations.length : 0 }
        : undefined,
      pending_approvals: task.intents.filter(i => i.approval?.pending === true).map(i => ({ id: i.id, summary: i.summary, request: i.approval?.request })),
      risk_confirm: task.riskConfirm || undefined,
      brief: task.brief?.text || undefined,
      brief_round: task.brief?.round ?? undefined,
      analysis: task.analysis?.text || undefined,
      analysis_round: task.analysis?.round ?? undefined,
      analysis_runs: task.analysisRuns || 0,
      digest: digestOf(task),
      goals: task.goals.map(g => ({
        id: g.id,
        text: g.text,
        status: g.status,
        evidence: g.evidence,
        evidence_outcome: g.evidenceOutcome,
        reason: g.reason || undefined,
        ...evidenceMeta(g.evidence),
      })),
      intents: {
        total: task.intents.length,
        open: openIntents(task).length,
        running: runningIntents(task).length,
        by_state: stateCount,
      },
      facts: task.stats.facts,
      facts_kept: task.facts.length,
      facts_truncated: task.stats.facts > task.facts.length || undefined,
      findings: task.findings.slice(-50).map(f => ({ id: f.id, title: f.title, severity: f.severity, status: f.status || 'open', intent_id: f.intentId })),
      findings_total: task.stats.findings,
      findings_kept: task.findings.length,
      findings_by_status: {
        open: task.findings.filter(f => (f.status || 'open') === 'open').length,
        verified: task.findings.filter(f => f.status === 'verified').length,
        rejected: task.findings.filter(f => f.status === 'rejected').length,
        needs_retest: task.findings.filter(f => f.status === 'needs_retest').length,
      },
      conflicts: Array.isArray(task.conflicts) ? task.conflicts.length : 0,
      coverage: task.mode === 'audit' && task.report?.coverage
        ? { covered: task.report.coverage.covered, total: task.report.coverage.total, gaps: task.report.coverage.gaps }
        : undefined,
      resources: task.stats.resources,
      usage: task.usage || { input_tokens: 0, output_tokens: 0, calls: 0, by_role: {}, by_intent: {} },
      hints: task.hints.map(h => h.text),
      todos: task.todos,
      elapsed_ms: endsAt - task.createdAt,
      finish_detail: task.finishDetail,
      out_dir: task.outDir,
    }
  }

export async function status(engine, taskId, options = {}) {
    if (taskId) {
      const rt = engine.liveTask(taskId)
      if (rt) return engine.snapshot(rt.task, rt)
      const stored = await engine.loadTask(taskId)
      if (!stored) throw new Error(`ARTEX 任务 ${taskId} 不存在`)
      return engine.snapshot(stored, undefined)
    }
    const all = [...engine.tasks.values()].map(rt => engine.snapshot(rt.task, rt))
    if (!options.ownerSession) return all
    const extra = new Set((options.taskIds || []).map(String))
    return all.filter(s => String(s.owner_session) === String(options.ownerSession) || extra.has(String(s.task_id)))
  }

export function report(engine, task) {
    return formatReport(task)
  }

/* ---------------------------------------------------------------- campaign */

/**
 * P3-1 战役聚合视图：跨任务汇总目标达成 / 发现 / 成本。
 * 索引里的每个任务读 loadMeta（轻量，不加载全量事实），活任务直接读内存。
 */
export async function campaignStatus(engine, campaign) {
    const name = String(campaign ?? '').trim()
    if (!name) throw new Error('campaign 不能为空')
    const items = await engine.index.byCampaign(name)
    const rows = []
    for (const item of items) {
      try {
        const live = engine.liveTask(item.id)
        const task = live ? live.task : await engine.storeFor(item.cwd).tasks.loadMeta(item.id)
        if (!task) continue
        const goals = Array.isArray(task.goals) ? task.goals : []
        const findings = Array.isArray(task.findings) ? task.findings : []
        rows.push({
          id: task.id,
          description: task.description,
          status: task.status,
          mode: task.mode || 'objective',
          live: Boolean(live && !live.finished),
          rounds: task.round ?? 0,
          goals_met: goals.filter(g => g.status === 'met').length,
          goals_total: goals.length,
          facts: task.stats?.facts ?? 0,
          findings_total: findings.length,
          findings_open: findings.filter(f => (f.status || 'open') === 'open').length,
          findings_verified: findings.filter(f => f.status === 'verified').length,
          tokens: (task.usage?.input_tokens || 0) + (task.usage?.output_tokens || 0),
          violations: Array.isArray(task.violations) ? task.violations.length : 0,
          engagement: task.engagement?.id || undefined,
        })
      } catch {
        // 单个任务读取失败不拖垮聚合视图。
      }
    }
    const totals = rows.reduce((acc, row) => ({
      tasks: acc.tasks + 1,
      running: acc.running + (row.live ? 1 : 0),
      goals_met: acc.goals_met + row.goals_met,
      goals_total: acc.goals_total + row.goals_total,
      facts: acc.facts + row.facts,
      findings_total: acc.findings_total + row.findings_total,
      findings_verified: acc.findings_verified + row.findings_verified,
      tokens: acc.tokens + row.tokens,
      violations: acc.violations + row.violations,
    }), { tasks: 0, running: 0, goals_met: 0, goals_total: 0, facts: 0, findings_total: 0, findings_verified: 0, tokens: 0, violations: 0 })
    return { campaign: name, tasks: rows, totals }
  }

/** 索引当前知悉的全部战役名。 */
export async function campaignList(engine) {
    return engine.index.campaigns()
  }
