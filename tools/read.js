/**
 * read 工具组。
 */

import { artifact, describe, integer, resolve, requireRead } from '../tools-shared.js'
import { overview, detail, listTraces, searchTraces, getTrace } from '../graph.js'
import { OVERVIEW_MAX_CHARS, clampInt, filterOverview, truncatedViewResponse, writeJsonAtomic } from './status-format.js'

export function readTools({ engine, config }) {
  return [
    artifact({
      name: 'artex_graph_overview',
      description: `读 ARTEX 任务的探索图态势投影：目标与状态、open/running/recent_done 意图（含血缘 parents/yields 与写回计数）、最近事实、最近发现、提示、跨轮待办。**默认有界**：facts_limit 默认 10 条，整段 JSON 超过 max_chars（默认 6000）时把完整态势落盘到 \`<task.outDir>/overview_latest.json\`，只返回一个带 preview + 文件路径的可解析包装，避免单次读取把整张图灌进上下文。sections 可只要其中几块；要全量细节读落盘文件或 artex_node_detail。只读。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          facts_q: describe('可选：在事实摘要/详情里做关键字过滤'),
          facts_limit: integer('返回多少条最近事实（默认 10，最大 50）'),
          sections: {
            type: 'array',
            items: { type: 'string', enum: ['goals', 'intents', 'facts', 'findings', 'hints', 'todos', 'stats', 'pending_approvals', 'scope'] },
            description: '可选：只保留这些顶层块（缺省=全量；task 与非空 pending_approvals 始终保留）',
          },
          max_chars: integer('单次返回字符硬上限（默认 6000，clamp 256..200000）'),
        },
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRead(agent, role, task, config)
        const maxChars = clampInt(args.max_chars, OVERVIEW_MAX_CHARS, 256, 200000)
        const factsLimit = clampInt(args.facts_limit, 10, 1, 50)
        const full = overview(task, {
          factsLimit,
          factsQ: args.facts_q,
        })
        const filtered = filterOverview(full, args.sections)
        const inline = JSON.stringify(filtered)
        if (inline.length <= maxChars) return inline
        // 超限：完整（未按 sections 过滤）态势落盘，返回可解析包装。
        // bytes 一律指「完整 view」的字节数：写盘成功=落盘文件大小；失败=等价 JSON 大小。
        const outDir = typeof task.outDir === 'string' ? task.outDir : ''
        let file = null
        let bytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
        if (outDir) {
          try {
            const info = await writeJsonAtomic(outDir, 'overview_latest.json', full)
            file = info.path
            bytes = info.bytes
          } catch { /* 落盘失败时仍返回 preview，file 为 null */ }
        }
        return truncatedViewResponse(inline, {
          bytes,
          file,
          note: file ? '完整态势已落盘；用 read/grep 按需取，或 artex_node_detail 按 id 取节点' : '完整态势落盘失败；用 sections/facts_limit 缩小查询或 artex_node_detail 按 id 取节点',
        }, maxChars)
      },
    }),
    artifact({
      name: 'artex_node_detail',
      description: '读某个探索图节点的完整内容（goal/intent/fact/finding/hint）：摘要 + 详情 + 证据 + confidence + 来源意图。写报告或复核否定结论前用它取全证据。只读。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', required: true, description: '探索节点 id（fact/finding/intent 的编号，不是资源 id）' },
          task_id: describe('可选：任务 id'),
        },
        required: ['id'],
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRead(agent, role, task, config)
        const node = detail(task, args.id)
        if (!node) throw new Error(`节点 #${args.id} 不存在于任务 ${task.id}`)
        return JSON.stringify(node)
      },
    }),
    artifact({
      name: 'artex_trace',
      description: `回看 worker 的**执行过程**（不是最终结论），三种用法：
1) 不带参数：列出跑过的 work（intent_id/state/步数/输出摘要）；
2) 只给 q：在本任务所有 work 的过程里按关键字检索（自动排除自己这条意图），返回 intent_id + step_id + 摘要；
3) 给 intent_id（可再给 step_ids，一次最多 5 个）：取该 work 的步骤摘要或指定步骤的完整内容。
用于"别人是不是已经跑过这个命令/见过这个报错"的复用，避免重复劳动。只读。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          q: describe('可选：关键字（在步骤摘要与完整内容上匹配）'),
          intent_id: integer('可选：看某个 work 的步骤'),
          step_ids: { type: 'array', items: { type: 'integer' }, description: '可选：取完整内容的步骤 id（最多 5 个）' },
          limit: integer('检索命中上限（默认 20，最大 100）'),
        },
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRead(agent, role, task, config)
        if (args.q) {
          const hits = searchTraces(task, args.q, {
            limit: args.limit ?? 20,
            excludeIntentId: role?.intentId ?? undefined,
          })
          return JSON.stringify({ q: args.q, hits, total: hits.length })
        }
        if (args.intent_id) {
          return JSON.stringify(getTrace(task, args.intent_id, args.step_ids))
        }
        return JSON.stringify(listTraces(task))
      },
    }),
  ]
}
