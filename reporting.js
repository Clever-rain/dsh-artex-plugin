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
      findings: task.findings.slice(-50).map(f => ({ id: f.id, title: f.title, severity: f.severity, intent_id: f.intentId })),
      findings_total: task.stats.findings,
      findings_kept: task.findings.length,
      resources: task.stats.resources,
      usage: task.usage || { input_tokens: 0, output_tokens: 0, calls: 0, by_role: {} },
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
