/**
 * verify 工具组：复测闭环、结构化冲突、撤回、确定性覆盖矩阵。
 */

import { artifact, describe, resolve, requireRole, requireRead, liveRuntime } from '../tools-shared.js'
import { coverageOf } from '../graph.js'

export function verifyTools({ engine, config }) {
  return [
    artifact({
      name: 'artex_retest_finding',
      description: '对一条 finding 落复测结论（逐条）。结果会写回 finding.status（open → verified / rejected / needs_retest），报告和 ingest 里都能看出"是否真的被验证过"。**只有确实有证据/有校验路径才写，不要乱批量点头。**',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          finding_id: { type: 'integer', required: true, description: '被复核的 finding id' },
          result: { type: 'string', enum: ['verified', 'rejected', 'needs_retest'], required: true, description: 'verified=能复现；rejected=复现不了或证据相反；needs_retest=证据不足待新证据' },
          note: describe('校验路径说明：看了什么证据/哪一步、为什么得出此结论---供审计追溯'),
        },
        required: ['finding_id', 'result'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner', 'verifier'])
        liveRuntime(engine, task)
        const finding = engine.retestFinding(task, {
          finding_id: args.finding_id,
          result: args.result,
          note: args.note,
        }, { worker: role?.role || 'owner' })
        return `finding #${finding.id} 复测为 ${finding.status}（retests: ${finding.retests.length}）${args.note ? `\n校验路径：${args.note}` : ''}`
      },
    }),
    artifact({
      name: 'artex_record_conflict',
      description: '把两条**给出相反结论**的节点（fact / finding / 跨类型）落为结构化冲突：双方保留、互为 contradicts。比一个糊在 brief 里的"有矛盾"强：调度图每条冲突独立可查、planner 会当场被唤醒。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          a: { type: 'integer', required: true, description: '冲突一方的节点 id' },
          b: { type: 'integer', required: true, description: '冲突另一方的节点 id' },
          kind: { type: 'string', enum: ['contradiction', 'supersedes'], description: 'contradiction=同时成立但矛盾（默认）；supersedes=新证据取代旧结论' },
          note: describe('冲突要点一句话（跟谁矛盾、为什么严重）'),
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['worker', 'analyst', 'planner'])
        liveRuntime(engine, task)
        const conflict = engine.recordConflict(task, {
          a: args.a,
          b: args.b,
          kind: args.kind,
          note: args.note,
          intentId: role?.intentId ?? null,
          worker: role?.role || 'owner',
        })
        return `冲突已登记：#${conflict.a} ↔ #${conflict.b}（kind=${conflict.kind}，id=${conflict.id}）。规划者已被唤醒。`
      },
    }),
    artifact({
      name: 'artex_retract_fact',
      description: '撤回一条事实：fact 保留在图上但从此不能作 prove_goal 证据（用于旧结论被新证据推翻时，不说假话、也不删档）。met 状态的 goal 如果正由这条 fact 撑着，回退改由其它证据证明或让目标回 open 状态重跑。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          fact_id: { type: 'integer', required: true, description: '要撤回的 fact id' },
          reason: describe('撤回原因一句话'),
        },
        required: ['fact_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        const fact = engine.retractFact(task, { fact_id: args.fact_id, reason: args.reason, worker: role?.role || 'owner' })
        const reopened = Array.isArray(fact.reopenedGoals) ? fact.reopenedGoals : []
        return `fact #${fact.id} 已撤回${args.reason ? `：${args.reason}` : ''}。该节点不能再作 prove_goal 证据。`
          + (reopened.length > 0 ? `\n受影响目标已回退 open，需用其它证据重新证明：${reopened.map(id => `goal#${id}`).join(' ')}` : '')
      },
    }),
    artifact({
      name: 'artex_coverage_report',
      description: '审计收口前的覆盖矩阵（确定性、无模型判断）：逐 goal 列出"已证明/相关事实/相关发现/结局统计"，gap=true 表示该目标没有任何相关证据。audit 模式收口时会把这个矩阵随报告落库。可以终态后调用。',
      parameters: {
        type: 'object',
        properties: { task_id: describe('可选：任务 id') },
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRead(agent, role, task, config)
        const report = coverageOf(task)
        return JSON.stringify(report, null, 2)
      },
    }),
  ]
}
