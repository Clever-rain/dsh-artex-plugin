/**
 * 模型可见的 ARTEX 工具集。
 *
 * 角色边界参照 ARTEX 的按 agent 绑定：
 *   控制面（run/start/stop/status/hint）—— 任务所有者会话；
 *   planner（add_intent / prove_goal / set_todos）—— 只有 planner 与所有者；
 *   worker（record_fact / report_finding / add_resource）—— worker 与所有者；
 *   读（overview / node_detail / trace）—— 任何能定位任务的会话。
 * 子会话的工具可见性由 spawn provider 的 toolFilter 再收一道（见 engine 的 DENY 常量）。
 */

import { overview, detail, listTraces, searchTraces, getTrace } from './graph.js'

const describe = text => ({ type: 'string', description: text })
const integer = text => ({ type: 'integer', description: text })
const boolean = text => ({ type: 'boolean', description: text })
const strings = text => ({ type: 'array', items: { type: 'string' }, description: text })

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/**
 * 把「属性级 required:true」的书写法转成标准 JSON Schema（对象级 required 数组），
 * 因为我们不用 defineTool 编译，模型接口看到的必须是合法 schema。
 */
function standardize(node) {
  if (!node || typeof node !== 'object') return node
  const out = {}
  const childRequired = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && value === true) continue
    if (key === 'properties' && value && typeof value === 'object') {
      const properties = {}
      for (const [name, child] of Object.entries(value)) {
        if (child && child.required === true) childRequired.push(name)
        properties[name] = standardize(child)
      }
      out.properties = properties
      continue
    }
    if (key === 'items') {
      out.items = standardize(value)
      continue
    }
    if ((key === 'oneOf' || key === 'anyOf') && Array.isArray(value)) {
      out[key] = value.map(standardize)
      continue
    }
    out[key] = value
  }
  if (childRequired.length > 0) {
    const existing = Array.isArray(node.required) ? node.required : []
    out.required = [...new Set([...existing, ...childRequired])]
  }
  return out
}

function artifact({ name, description, parameters, execute, concurrent = false }) {
  const definition = {
    name,
    description,
    parameters: standardize(parameters),
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const text = await execute(args || {}, exec)
      return { text: String(text ?? '') }
    },
  }
  if (concurrent) definition.isConcurrencySafe = () => true
  return definition
}

/* ------------------------------------------------------------- policy */

function callerOf(engine, exec) {
  const agent = exec?.agent
  if (!agent) throw new Error('ARTEX 工具必须由 agent 会话调用')
  return { agent, role: engine.roleOf(agent.id) }
}

async function resolve(engine, exec, taskId) {
  const caller = callerOf(engine, exec)
  const id = taskId || caller.role?.taskId
  if (!id) throw new Error('缺少 task_id：非 ARTEX 角色会话必须显式指定任务')
  const task = await engine.resolveTask(id)
  return { ...caller, task }
}

const isOwner = (agent, task) => String(agent.id) === String(task.ownerSession)

function requireOwner(agent, task) {
  if (!isOwner(agent, task)) {
    throw new Error(`该操作只允许任务 ${task.id} 的所有者会话调用（当前会话不是所有者）`)
  }
}

function requireRole(agent, role, task, allowed) {
  if (isOwner(agent, task)) return 'owner'
  if (role && role.taskId === task.id && allowed.includes(role.role)) return role.role
  throw new Error(`该操作只允许任务所有者或 ${allowed.join('/')} 角色调用`)
}

function liveRuntime(engine, task) {
  const rt = engine.liveTask(task.id)
  if (!rt || rt.finished) {
    throw new Error(`ARTEX 任务 ${task.id} 当前不在运行（status=${task.status}），不能执行写操作`)
  }
  return rt
}

const LIMIT_KEYS = {
  max_workers: 'maxWorkers',
  max_rounds: 'maxRounds',
  max_stalls: 'maxStalls',
  debounce_ms: 'debounceMs',
  heartbeat_ms: 'heartbeatMs',
  worker_timeout_ms: 'workerTimeoutMs',
  planner_timeout_ms: 'plannerTimeoutMs',
  settle_grace_ms: 'settleGraceMs',
  budget_ms: 'budgetMs',
}

function pickLimits(args) {
  const limits = {}
  for (const [from, to] of Object.entries(LIMIT_KEYS)) {
    if (args[from] !== undefined) limits[to] = args[from]
  }
  return limits
}

const RUN_PARAMETERS = {
  goal: { type: 'string', required: true, description: '总目标：一句话说清要达成的最终结果。' },
  description: describe('任务短标题（用于列表与日志），缺省截取 goal。'),
  goals: strings('可选：把总目标拆成 1..N 条"可独立判定是否达成"的验收目标；缺省时总目标本身作为唯一目标。规划者用 artex_prove_goal 逐条证明，全部证明后任务自动完成。'),
  constraints: strings('可选：硬约束（安全边界、禁止项、范围限制）。会以最高优先级注入 planner 与每个 worker，凌驾于一切探索偏好。'),
  max_workers: integer('并发 worker 数（默认 3）。0 = 只做规划不执行（用于先看方案）。'),
  max_rounds: integer('规划轮次上限（默认 24），达到后结束任务。'),
  max_stalls: integer('连续多少轮规划没有产出可执行方向就停止（默认 2）。'),
  budget_ms: integer('任务级墙钟预算（毫秒，默认 0 = 不限）。耗尽后先让 worker 收尾再停。'),
  worker_timeout_ms: integer('单个 worker 的墙钟预算（毫秒，默认 1200000 = 20 分钟）。'),
  planner_timeout_ms: integer('单轮 planner 的墙钟预算（毫秒，默认 900000）。'),
  heartbeat_ms: integer('无任何变动时的巡检间隔（毫秒，默认 600000）。'),
  debounce_ms: integer('图变动合并窗口（毫秒，默认 800）。'),
  settle_grace_ms: integer('预算耗尽后等待收尾的宽限期（毫秒，默认 90000）。'),
}

/* ------------------------------------------------------------- factories */

export function createTools({ engine, config }) {
  const engineNote = config.isolateWorkdir
    ? '子会话在任务目录下的独立工作目录里工作'
    : '子会话继承当前工作区目录'

  return [
    artifact({
      name: 'artex_run_task',
      description: `用 ARTEX 多 agent 编排跑一个**长程、可分解、需要多方向并行推进**的目标：规划者(planner)按图态势派意图，多个执行者(worker)并发领取意图干活并写回事实，图一变就唤醒规划者，直到所有验收目标被证据证明。适合"需要多轮探索/多方并行/结论要沉淀成事实库"的任务；单步任务直接用普通工具，不要用它。

行为：**阻塞**直到任务结束（完成/超时/停止/无新方向），返回结构化报告。内部会为每一轮规划、每条意图各开一个子会话（真实 subagent，${engineNote}），因此会产生多次模型调用。过程中可以用 artex_task_status 另开任务查看进度，但本调用本身不返回中间状态。

写回模型：worker 通过 artex_record_fact（结论，带证据与 confidence）、artex_report_finding（已验证成果）、artex_add_resource（新实体）把产出写进任务图谱；规划者只能派意图/证明目标，不能亲自干活。`,
      parameters: { type: 'object', properties: RUN_PARAMETERS, required: ['goal'], additionalProperties: false },
      async execute(args, exec) {
        const { agent } = callerOf(engine, exec)
        const rt = await engine.startTask({
          agent,
          goal: args.goal,
          description: args.description || args.goal,
          goals: args.goals,
          constraints: args.constraints,
          limits: pickLimits(args),
          signal: exec.signal,
        })
        const stop = () => { void engine.stopTask(rt.task.id, '调用方中断') }
        exec.signal?.addEventListener?.('abort', stop, { once: true })
        try {
          const task = await rt.done
          return engine.report(task)
        } finally {
          exec.signal?.removeEventListener?.('abort', stop)
        }
      },
    }),

    artifact({
      name: 'artex_start_task',
      description: '后台启动一个 ARTEX 编排任务，立即返回 task_id，不阻塞当前轮。之后用 artex_task_status 查看进度、artex_stop_task 停止、artex_add_hint 注入战略提示。注意：后台任务结束时**不会**自动唤醒本会话，需要你（或用户）主动轮询状态。',
      parameters: { type: 'object', properties: RUN_PARAMETERS, required: ['goal'], additionalProperties: false },
      async execute(args, exec) {
        const { agent } = callerOf(engine, exec)
        const rt = await engine.startTask({
          agent,
          goal: args.goal,
          description: args.description || args.goal,
          goals: args.goals,
          constraints: args.constraints,
          limits: pickLimits(args),
          signal: exec.signal,
        })
        return `ARTEX 任务已在后台启动：${rt.task.id}
目标：${rt.task.goal}
验收目标：${rt.task.goals.map(g => `\n  - [goal#${g.id}] ${g.text}`).join('')}
并发 worker：${rt.task.limits.maxWorkers} · 轮次上限：${rt.task.limits.maxRounds}${rt.task.limits.budgetMs ? ` · 预算：${Math.round(rt.task.limits.budgetMs / 1000)}s` : ''}
快照目录：${rt.task.outDir}

下一步：artex_task_status(task_id="${rt.task.id}") 查看进度；artex_add_hint 注入提示；artex_stop_task 停止。`
      },
    }),

    artifact({
      name: 'artex_task_status',
      description: '查看 ARTEX 任务状态：状态/轮次/目标达成情况/意图计数/事实与发现/待办/上限。不传 task_id 时列出本会话内存里的所有任务（以及当前工作区磁盘上的历史任务 id）。',
      parameters: {
        type: 'object',
        properties: { task_id: describe('可选：任务 id；省略则列出任务') },
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        if (args.task_id) {
          const snapshot = await engine.status(String(args.task_id))
          return `${snapshot.task_id} [${snapshot.status}] ${snapshot.goal}
轮次 ${snapshot.rounds} · 意图 ${JSON.stringify(snapshot.intents.by_state)} · 事实 ${snapshot.facts} · 发现 ${snapshot.findings.length} · 资源 ${snapshot.resources}
用时 ${Math.round(snapshot.elapsed_ms / 1000)}s${snapshot.finish_detail ? ` · ${snapshot.finish_detail}` : ''}

${JSON.stringify(snapshot)}`
        }
        const live = await engine.status()
        const { agent } = callerOf(engine, exec)
        const cwd = await engine.cwdFor(agent, exec.signal)
        const onDisk = await engine.storeFor(cwd).tasks.ids()
        const liveIds = new Set(live.map(t => t.task_id))
        const listing = live.length > 0
          ? live.map(t => `- ${t.task_id} [${t.status}] rounds=${t.rounds} facts=${t.facts} findings=${t.findings.length} · ${t.goal}`).join('\n')
          : '- （本进程内没有活动任务）'
        const history = onDisk.filter(id => !liveIds.has(id)).slice(0, 10)
        return `## 本进程任务
${listing}
${history.length > 0 ? `\n## 磁盘上其它任务\n${history.map(id => `- ${id}`).join('\n')}` : ''}`
      },
    }),

    artifact({
      name: 'artex_stop_task',
      description: '停止一个正在运行的 ARTEX 任务：中断所有在跑 worker 与 planner，任务状态记为 stopped。省略 task_id 时停止本会话启动的活动任务。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          reason: describe('停止原因（记录到任务快照）'),
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role } = callerOf(engine, exec)
        let taskId = args.task_id || role?.taskId
        if (!taskId) {
          const own = [...engine.tasks.values()].find(rt => !rt.finished && isOwner(agent, rt.task))
          taskId = own?.task.id
        }
        if (!taskId) throw new Error('找不到要停止的任务：请显式传 task_id')
        const task = await engine.resolveTask(taskId)
        requireOwner(agent, task)
        const ok = await engine.stopTask(task.id, args.reason || '主 agent 停止')
        if (!ok) throw new Error(`任务 ${task.id} 不在运行中`)
        return `已请求停止 ${task.id}；在跑的子会话被中断，状态将在下一拍落盘。`
      },
    }),

    artifact({
      name: 'artex_add_hint',
      description: '给运行中的 ARTEX 任务注入战略提示（会立刻唤醒规划者写入本轮态势，并在后续每轮的 hints 里可见）。用于人在环路纠偏：换重点、排除某方向、提醒某条已知线索。可一次给多条。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id；省略时用调用者所属任务'),
          hints: strings('要注入的提示（优先用数组批量提交）'),
          text: describe('[单条] 提示内容'),
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireOwner(agent, task)
        liveRuntime(engine, task)
        const texts = Array.isArray(args.hints) && args.hints.length > 0
          ? args.hints
          : args.text ? [args.text] : []
        if (texts.length === 0) throw new Error('hints 或 text 至少给一个')
        const added = engine.addHint(task, texts.map(String))
        void role
        return `已注入 ${added.length} 条提示：${added.map(h => `#${h.id}`).join(' ')}。规划者已被唤醒。`
      },
    }),

    artifact({
      name: 'artex_graph_overview',
      description: '读 ARTEX 任务的完整探索图态势（比规划者每轮看到的投影更全）：目标与状态、open/running/recent_done 意图（含血缘 parents/yields 与写回计数）、最近事实、最近发现、提示、跨轮待办。可用 facts_q 在事实全文里检索，facts_limit 调整返回条数。只读。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          facts_q: describe('可选：在事实摘要/详情里做关键字过滤'),
          facts_limit: integer('返回多少条最近事实（默认 20，最大 50）'),
        },
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        const { task } = await resolve(engine, exec, args.task_id)
        return JSON.stringify(overview(task, {
          factsLimit: args.facts_limit ?? 20,
          factsQ: args.facts_q,
        }))
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
        const { task } = await resolve(engine, exec, args.task_id)
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
        const { task, role } = await resolve(engine, exec, args.task_id)
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

    artifact({
      name: 'artex_add_intent',
      description: `规划者专用：向 frontier 批量提交探索意图（最多 4 条）。意图 = 一句话的开放探索方向（"对什么做什么、为什么"），不是固定分类。
提交前先与 open/running/recent_done 去重：已被覆盖的不再派；recent_done 里 done 的方向只有出现材料性新机理才重派，exhausted/blocked 的先看 trace 再决定接续还是换打法。
强依赖的串行链用 artex_set_todos 记整条链，每轮只派"前置已满足"的那一步，不要把一条链并行拆散。
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
                priority: integer('优先级 0-10，默认 5'),
                parents: { type: 'array', items: { type: 'integer' }, description: '派生自哪些 fact/finding 节点 id' },
                resource_ids: { type: 'array', items: { type: 'integer' }, description: '锚定的资源 id' },
              },
              required: ['summary'],
              additionalProperties: false,
            },
          },
          summary: describe('[单条] 意图方向'),
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
          : args.summary ? [{ summary: args.summary, parents: args.parents }] : []
        if (items.length === 0) throw new Error('intents 或 summary 至少给一个')
        const results = engine.addIntents(task, items)
        const created = results.filter(r => r.id > 0)
        const duplicates = results.filter(r => r.duplicate)
        return `已创建 ${created.length} 条意图：${created.map(r => `#${r.id} ${r.summary}`).join('；') || '（无）'}`
          + (duplicates.length > 0 ? `\n跳过重复 ${duplicates.length} 条：${duplicates.map(d => d.summary).join('；')}` : '')
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
        },
        required: ['goal_id', 'evidence_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['planner'])
        liveRuntime(engine, task)
        const result = engine.proveGoal(task, args.goal_id, args.evidence_id, args.reason)
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
      name: 'artex_record_fact',
      description: `执行者写回：把本意图得到的**结论/观察/判断**写进探索图（不是资源，也不是已验证成果）。
纪律：多个观察汇总成**一条**事实（summary 一句话 + detail 展开），默认就写一条；只写增量（不要换措辞重记已有事实）；只写真实看到的——给 evidence（一行：做了什么 + 最能证明的一两行结果），标 confidence（observed=直接看到 / inferred=据现象推断）。否定/存疑结论也写，但用 inferred 并说明用了哪些手段。
task 所有者与 worker 可调用。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          intent_id: integer('来源意图 id；worker 省略时自动挂到自己领到的意图'),
          summary: describe('一句话结论（默认单条）'),
          detail: describe('对 summary 的展开：观察到的细节、过程、推理'),
          evidence: describe('一行证据：命令/操作 + 关键输出'),
          confidence: { type: 'string', enum: ['observed', 'inferred'], description: 'observed=直接看到；inferred=据现象推断（默认 observed）' },
          resource_ids: { type: 'array', items: { type: 'integer' }, description: '这条结论锚定的资源 id' },
          facts: {
            type: 'array',
            description: '（极少数例外）只在确有彼此完全独立、无法归并的结论时才用数组分条',
            items: {
              type: 'object',
              properties: {
                summary: { type: 'string', required: true },
                detail: describe('展开'),
                evidence: describe('证据'),
                confidence: { type: 'string', enum: ['observed', 'inferred'] },
              },
              required: ['summary'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['worker'])
        liveRuntime(engine, task)
        const intentId = args.intent_id ?? role?.intentId ?? undefined
        const entries = Array.isArray(args.facts) && args.facts.length > 0
          ? args.facts.map(f => ({
            ...f,
            intentId,
            resourceIds: f.resource_ids ?? args.resource_ids,
          }))
          : [{
            summary: args.summary,
            detail: args.detail,
            evidence: args.evidence,
            confidence: args.confidence,
            intentId,
            resourceIds: args.resource_ids,
          }]
        if (!entries[0].summary) throw new Error('summary 不能为空')
        const facts = engine.recordFacts(task, entries, intentId)
        return `已写回 ${facts.length} 条事实：${facts.map(f => `#${f.id}`).join(' ')}（confidence=${facts.map(f => f.confidence).join(',')}）`
      },
    }),

    artifact({
      name: 'artex_report_finding',
      description: `执行者写回：登记一个**已验证的成果/发现**（有可复现证据）。只有本次真实复现或验证过、能给出可复现步骤或证据才用；"看起来像/版本匹配/推断可行"一律改为 artex_record_fact（confidence=inferred）。
登记后会立即唤醒规划者（不必等本 worker 结束），并进入任务发现列表。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          intent_id: integer('来源意图 id；worker 省略时自动挂到自己领到的意图'),
          title: { type: 'string', required: true, description: '一句话成果标题' },
          detail: describe('详细说明：是什么、影响、复现步骤'),
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info', 'unknown'], description: '严重度/重要性（默认 unknown）' },
          evidence: describe('可复现证据：命令/请求 + 关键输出，或复现步骤'),
          resource_ids: { type: 'array', items: { type: 'integer' }, description: '关联资源 id' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['worker'])
        liveRuntime(engine, task)
        if (!String(args.title || '').trim()) throw new Error('title 不能为空')
        const finding = engine.recordFinding(task, {
          title: args.title,
          detail: args.detail,
          severity: args.severity,
          evidence: args.evidence,
          resourceIds: args.resource_ids,
          intentId: args.intent_id ?? role?.intentId ?? undefined,
        })
        return `已登记发现 #${finding.id}：${finding.title}（severity=${finding.severity}）。规划者已被唤醒。`
      },
    }),

    artifact({
      name: 'artex_add_resource',
      description: `登记本任务发现、以后要反复引用的对象（文件/接口/主机/服务/数据表/模块/凭据/依赖……）：只登记对象本身，判断与结论用 artex_record_fact。资源图跨任务共享，按 (type,key||name) 去重，重复登记返回已有 id。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          resources: {
            type: 'array',
            description: '资源数组（优先用这个批量登记）',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', required: true, description: '资源类型，如 file/api/host/service/dataset/module/credential' },
                name: { type: 'string', required: true, description: '可识别的名字（路径/URL/主机名/表名…）' },
                key: describe('可选：去重键（缺省用 name）'),
                attrs: { type: 'object', additionalProperties: true, description: '可选：结构化属性' },
              },
              required: ['type', 'name'],
              additionalProperties: false,
            },
          },
          type: describe('[单条] 资源类型'),
          name: describe('[单条] 资源名'),
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['worker', 'planner'])
        liveRuntime(engine, task)
        const items = Array.isArray(args.resources) && args.resources.length > 0
          ? args.resources
          : args.name ? [{ type: args.type || 'resource', name: args.name }] : []
        if (items.length === 0) throw new Error('resources 或 name 至少给一个')
        const results = await engine.addResources(task, items, role)
        return `已登记 ${results.length} 个资源：${results.map(r => `#${r.id} ${r.name}${r.created ? '' : '(已存在)'}`).join('；')}`
      },
    }),
  ]
}
