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
提交前与 open/running/blueprint/recent_done 去重；已判死（failed）的方向不要原样重派；启动受阻（blocked，多为瞬态错误）的方向可以原样重派。
锚点校验：parents 只能引用仍存在的 fact/finding id；resource_ids 必须是已登记的资源 id——悬空引用会被服务端拒绝（整批不入库）。
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
                depends_on: { type: 'array', items: { type: 'integer' }, description: '显式串行依赖：只在前置意图全部 done 后才可被领取，失败的前置要靠你改路线。只能引用此前已存在的意图 id。' },
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
        const results = await engine.addIntents(task, items, { notify: role?.role !== 'planner' })
        const created = results.filter(r => r.id > 0)
        const duplicates = results.filter(r => r.duplicate)
        return `已创建 ${created.length} 条意图：${created.map(r => `#${r.id} ${r.summary}`).join('；') || '（无）'}`
          + (duplicates.length > 0 ? `\n跳过重复 ${duplicates.length} 条：${duplicates.map(d => `${d.summary}（已有 #${d.id}，${d.state}）`).join('；')}` : '')
          + (dropped > 0 ? `\n仅提交前 4 条，另有 ${dropped} 条未提交` : '')
      },
    }),
    artifact({
      name: 'artex_prove_goal',
      description: '规划者专用：用一条已存在的 fact 或 finding 作为证据，标记某条目标达成。**所有目标都被标记后任务自动完成**（这是唯一的收官方式）。证据必须真实存在于本任务；目标含可量化条件时先核对态势里的实测值，未达标禁止标记。证据分级硬约束：`confidence=inferred` 的推断事实不能作证据（先去验证升级），blueprint 不可作证据，outcome=none 仅在目标本身是负向结论且显式传 allow_negative 时可用。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          goal_id: { type: 'integer', required: true, description: '目标节点 id（见态势 goals[].id）' },
          evidence_id: { type: 'integer', required: true, description: '作为证据的 fact/finding 节点 id' },
          reason: describe('一句话说明为什么这条证据足以证明目标达成'),
          allow_negative: { type: 'boolean', description: '仅当目标本身是负向结论（如“无共享/未监听”）时设为 true，允许 outcome=none 的事实作为证据；默认拒绝负结果。' },
          allow_inferred: { type: 'boolean', description: '应急口袋：允许 confidence=inferred 的推断事实作证据。默认拒绝；只有明确接受"这次是推断"时才用，质量门应在其它层把关。' },
        },
        required: ['goal_id', 'evidence_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        const result = engine.proveGoal(task, args.goal_id, args.evidence_id, args.reason, args.allow_negative === true, { notify: role?.role !== 'planner', allowInferred: args.allow_inferred === true })
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
      name: 'artex_plan',
      description: `规划者专用：**一轮的结构化计划协议**——把本轮所有动作一次提交，服务端按固定顺序逐段执行并把回执一起返回，比散打多个工具更稳，也更利于审计溯源。
建议内容：decision（本轮一句话决定，会写入过程库）→ todos（可整量替换）→ intents（一次最多 12 条，支持 depends_on 显式串链）→ proofs（可证目标一次证完，同样证据硬门）。
**单段失败不中断后续段**（回执里逐段标注 ok/error）——适合中途有抖动也要保住主线的轮次。
证明一条后任务如果满足 allGoalsMet 会提前完成：proofs 之后的那段 return 可能看不到，但写回已落库。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          decision: describe('本轮决策一句话，写入过程库供审计'),
          todos: {
            type: 'array',
            description: '整体替换的跨轮待办（见 artex_set_todos）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
          intents: {
            type: 'array',
            description: '本轮要下发的意图（一次最多 12 条；字段同 artex_add_intent，额外支持 depends_on）',
            items: { type: 'object' },
            maxItems: 12,
          },
          proofs: {
            type: 'array',
            description: '要证明的目标（字段同 artex_prove_goal）',
            items: {
              type: 'object',
              properties: {
                goal_id: { type: 'integer', required: true },
                evidence_id: { type: 'integer', required: true },
                reason: { type: 'string' },
                allow_negative: { type: 'boolean' },
                allow_inferred: { type: 'boolean' },
              },
              required: ['goal_id', 'evidence_id'],
              additionalProperties: false,
            },
          },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)

        const lines = []

        // 1. decision：审计句式，写进过程库供事后 trace。
        if (args.decision && String(args.decision).trim()) {
          engine.addActivity(engine.liveTask(task.id), {
            intentId: null,
            worker: role?.role || 'owner',
            kind: 'decision',
            summary: String(args.decision),
          })
          lines.push(`决定：${String(args.decision).trim()}`)
        }

        // 2. todos：整体替换。
        if (Array.isArray(args.todos)) {
          const todos = engine.setTodos(task, args.todos)
          lines.push(`待办 → ${todos.length} 条`)
        }

        // 3. intents：批量下发（最多 12 条）。
        if (Array.isArray(args.intents) && args.intents.length > 0) {
          const capped = args.intents.slice(0, 12)
          try {
            const results = await engine.addIntents(task, capped, { notify: role?.role !== 'planner', max: 12 })
            const created = results.filter(r => r.id > 0)
            const duplicates = results.filter(r => r.duplicate)
            const dropped = Math.max(0, args.intents.length - capped.length)
            lines.push(`意图 → 新建 ${created.length} 条（${created.map(r => `#${r.id}`).join(' ')}）`
              + (duplicates.length > 0 ? ` 跳重 ${duplicates.length} 条` : '')
              + (dropped > 0 ? ` 超限裁掉 ${dropped} 条` : ''))
          } catch (error) {
            lines.push(`意图 → 段失败：${error?.message || error}`)
          }
        }

        // 4. proofs：逐条给证；单条失败继续下一条，同时统计 met 数。
        if (Array.isArray(args.proofs) && args.proofs.length > 0) {
          for (const proof of args.proofs) {
            try {
              const result = engine.proveGoal(
                task, proof.goal_id, proof.evidence_id, proof.reason,
                proof.allow_negative === true,
                { notify: false, allowInferred: proof.allow_inferred === true },
              )
              if (!result.ok) throw new Error(result.error)
              lines.push(`prove #${proof.goal_id} → ok（证据 ${result.kind}#${proof.evidence_id}${result.allMet ? '，全部 met，将完成' : ''}）`)
              if (result.allMet) break
            } catch (error) {
              lines.push(`prove #${proof.goal_id} → fail：${error?.message || error}`)
            }
          }
        }

        if (lines.length === 0) {
          return 'plan 为空：给 decision / todos / intents / proofs 至少一段'
        }
        return `plan 已落库（任务 #${task.id}，round ${task.round}）：\n- ${lines.join('\n- ')}`
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
        const result = engine.promoteIntent(task, args.intent_id, { notify: role?.role !== 'planner' })
        if (!result.ok) throw new Error(result.error)
        return `蓝图 #${result.intent.id} 已提升为 open：${result.intent.summary}`
      },
    }),
  ]
}
