/**
 * 任务快照 / 状态查询 / 最终报告。
 */

import { digestOf } from './graph.js'
import { formatReport } from './report.js'

export function snapshot(engine, task, live) {
    const stateCount = {}
    for (const intent of task.intents) stateCount[intent.state] = (stateCount[intent.state] || 0) + 1
    const endsAt = task.endedAt ?? Date.now()
    return {
      task_id: task.id,
      owner_session: task.ownerSession,
      status: task.status,
      live: Boolean(live && !live.finished),
      mode: task.mode || 'objective',
      view_mode: task.viewMode || engine.config.viewMode || 'planner',
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

export async function status(engine, taskId) {
    if (taskId) {
      const rt = engine.liveTask(taskId)
      if (rt) return engine.snapshot(rt.task, rt)
      const stored = await engine.loadTask(taskId)
      if (!stored) throw new Error(`ARTEX 任务 ${taskId} 不存在`)
      return engine.snapshot(stored, undefined)
    }
    return [...engine.tasks.values()].map(rt => engine.snapshot(rt.task, rt))
  }

export function report(engine, task) {
    return formatReport(task)
  }
