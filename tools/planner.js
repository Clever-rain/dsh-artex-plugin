/**
 * planner 工具组。
 */

import { artifact, describe, integer, boolean, resolve, requireRole, liveRuntime } from '../tools-shared.js'

export function plannerTools({ engine, config }) {
  return [
    artifact({
      name: 'artex_add_intent',
      description: `规划者专用：向 frontier 批量提交意图（最多 4 条）。意图 = 一句话方向（"对什么做什么、为什么"）。
- kind：\`pursue\`=追一条路径（成功即停、失败写 none 并回溯）；\`enumerate\`=枚举验证一批候选（命中也不停）。
- state：\`open\` 进入队列；\`blueprint\` 只登记为候选，之后可用 artex_promote_intent 提升。
- path_parent：pursue 在路径树里的上级意图，用于失败回溯。
提交前与 open/running/blueprint/recent_done 去重；已判死（failed）的方向不要原样重派。
只读任务所有者与 planner 可调用。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          intents: {
            type: 'array',
            description: '意图数组（优先用这个批量提交）',
            items: {
              type: 'object',
              properties: {
                summary: { type: 'string', required: true, description: '一句话方向' },
                kind: { type: 'string', enum: ['pursue', 'enumerate'], description: 'pursue=追一条路径；enumerate=枚举验证（默认按任务 mode 继承）' },
                state: { type: 'string', enum: ['open', 'blueprint'], description: 'open=进入队列；blueprint=只登记候选（默认 open）' },
                path_parent: integer('可选：pursue 的上级意图 id（路径树/回溯点）'),
                priority: integer('优先级 0-10，默认 5'),
                parents: { type: 'array', items: { type: 'integer' }, description: '派生自哪些 fact/finding 节点 id' },
                resource_ids: { type: 'array', items: { type: 'integer' }, description: '锚定的资源 id' },
              },
              required: ['summary'],
              additionalProperties: false,
            },
          },
          summary: describe('[单条] 意图方向'),
          kind: { type: 'string', enum: ['pursue', 'enumerate'], description: '[单条] 意图类型' },
          state: { type: 'string', enum: ['open', 'blueprint'], description: '[单条] open 或 blueprint' },
          path_parent: integer('[单条] 路径上级意图 id'),
          parents: { type: 'array', items: { type: 'integer' }, description: '[单条] 上游节点 id' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        const items = Array.isArray(args.intents) && args.intents.length > 0
          ? args.intents
          : args.summary
            ? [{ summary: args.summary, parents: args.parents, kind: args.kind, state: args.state, path_parent: args.path_parent, priority: args.priority }]
            : []
        if (items.length === 0) throw new Error('intents 或 summary 至少给一个')
        const dropped = Math.max(0, items.length - 4)
        const results = engine.addIntents(task, items, { notify: role?.role !== 'planner' })
        const created = results.filter(r => r.id > 0)
        const duplicates = results.filter(r => r.duplicate)
        return `已创建 ${created.length} 条意图：${created.map(r => `#${r.id} ${r.summary}`).join('；') || '（无）'}`
          + (duplicates.length > 0 ? `\n跳过重复 ${duplicates.length} 条：${duplicates.map(d => `${d.summary}（已有 #${d.id}，${d.state}）`).join('；')}` : '')
          + (dropped > 0 ? `\n仅提交前 4 条，另有 ${dropped} 条未提交` : '')
      },
    }),
    artifact({
      name: 'artex_prove_goal',
      description: '规划者专用：用一条已存在的 fact 或 finding 作为证据，标记某条目标达成。**所有目标都被标记后任务自动完成**（这是唯一的收官方式）。证据必须真实存在于本任务；目标含可量化条件时先核对态势里的实测值，未达标禁止标记。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          goal_id: { type: 'integer', required: true, description: '目标节点 id（见态势 goals[].id）' },
          evidence_id: { type: 'integer', required: true, description: '作为证据的 fact/finding 节点 id' },
          reason: describe('一句话说明为什么这条证据足以证明目标达成'),
          allow_negative: { type: 'boolean', description: '仅当目标本身是负向结论（如“无共享/未监听”）时设为 true，允许 outcome=none 的事实作为证据；默认拒绝负结果。' },
        },
        required: ['goal_id', 'evidence_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        const result = engine.proveGoal(task, args.goal_id, args.evidence_id, args.reason, args.allow_negative === true)
        if (!result.ok) throw new Error(result.error)
        const remaining = task.goals.filter(g => g.status !== 'met')
        return `目标 #${args.goal_id} 已标记达成（证据 ${result.kind} #${args.evidence_id}）。`
          + (result.allMet
            ? '全部目标已达成，任务将自动完成。'
            : `剩余未达成目标：${remaining.map(g => `#${g.id}`).join(' ')}`)
      },
    }),
    artifact({
      name: 'artex_set_todos',
      description: `规划者专用：整体替换跨轮规划待办（每次调用都是全量替换，不是追加）。待办是规划者跨唤醒的唯一记忆，用来记串行依赖链：先把整条链记成待办，每轮只派前置已满足的那一步，事实出现后把对应步骤标 completed。
status: pending | in_progress | completed。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          todos: {
            type: 'array',
            required: true,
            description: '完整待办清单',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', required: true, description: '一步可执行/可验证的规划动作' },
                status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'], description: '状态' },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['todos'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        const todos = engine.setTodos(task, args.todos)
        const marks = { pending: '☐', in_progress: '▶', completed: '✔' }
        return `待办已更新为 ${todos.length} 条：\n${todos.map(t => `${marks[t.status]} ${t.content}`).join('\n') || '（空清单）'}`
      },
    }),
    artifact({
      name: 'artex_set_brief',
      description: `规划者专用：整体替换**全局认知 brief**（每次全量替换，不是追加）。brief 是跨轮保留、覆盖全任务历史的综合认知，不是本轮摘要。
必须包含：已确认结论（带 fact#id）、未解决的问题（缺什么证据）、覆盖地图（audit）或路径树（objective）、当前策略。
与态势冲突时以事实为准，并更新这里。` + `\n建议 ≤1200 字符，超长会被截断。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          text: { type: 'string', required: true, description: 'brief 全文（Markdown，建议按模板组织）' },
          citations: { type: 'array', items: { type: 'integer' }, description: '可选：支撑 brief 的 fact/finding 节点 id' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        if (!String(args.text || '').trim()) throw new Error('text 不能为空')
        const brief = engine.setBrief(task, args.text, args.citations)
        return brief
          ? `全局认知已更新（第 ${brief.round} 轮，${brief.text.length} 字符，引用 ${brief.citations.length} 个节点）`
          : '更新失败：text 为空'
      },
    }),
    artifact({
      name: 'artex_promote_intent',
      description: '规划者专用：把一条 blueprint 意图提升为 open，进入 frontier 等待执行。用于回溯或调整优先级后启用之前只登记为候选的路径。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          intent_id: { type: 'integer', required: true, description: 'blueprint 意图 id' },
        },
        required: ['intent_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        const result = engine.promoteIntent(task, args.intent_id)
        if (!result.ok) throw new Error(result.error)
        return `蓝图 #${result.intent.id} 已提升为 open：${result.intent.summary}`
      },
    }),
  ]
}
