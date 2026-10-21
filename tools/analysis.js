/**
 * analysis 工具组。
 */

import { artifact, describe, integer, boolean, strings, resolve, requireOwner, requireRole, requireRead, liveRuntime, pickLimits, RUN_PARAMETERS } from '../tools-shared.js'

export function analysisTools({ engine, config }) {
  return [
    artifact({
      name: 'artex_set_analysis',
      description: `analyst 专用（所有者也可手工注入）：提交一份**独立分析**供规划者参考。分析不具决策权：不改 brief、不派意图、不写事实；规划者读取后自行决定采纳或驳回并写清理由。
建议内容：brief 与事实的一致性检查、被忽略的线索（带 trace/fact id）、覆盖缺口或路径重排建议。` + `\n整体替换，建议 ≤1200 字符。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          text: { type: 'string', required: true, description: '分析全文（Markdown）' },
          citations: { type: 'array', items: { type: 'integer' }, description: '可选：引用的 fact/finding/intent 节点 id' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['analyst'])
        liveRuntime(engine, task)
        if (!String(args.text || '').trim()) throw new Error('text 不能为空')
        const analysis = engine.setAnalysis(task, args.text, args.citations)
        return analysis
          ? `独立分析已提交（第 ${analysis.round} 轮，${analysis.text.length} 字符，引用 ${analysis.citations.length} 个节点）`
          : '提交失败：text 为空'
      },
    }),
  ]
}
