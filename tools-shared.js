/**
 * 工具共享层：schema 构造、artifact 包装、会话/角色校验、run/start 参数。
 */

export const describe = text => ({ type: 'string', description: text })
export const integer = text => ({ type: 'integer', description: text })
export const boolean = text => ({ type: 'boolean', description: text })
export const strings = text => ({ type: 'array', items: { type: 'string' }, description: text })

export const TEXT_OUTPUT = {
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
export function standardize(node) {
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

export function artifact({ name, description, parameters, execute, concurrent = false }) {
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

export function callerOf(engine, exec) {
  const agent = exec?.agent
  if (!agent) throw new Error('ARTEX 工具必须由 agent 会话调用')
  return { agent, role: engine.roleOf(agent.id) }
}

export async function resolve(engine, exec, taskId) {
  const caller = callerOf(engine, exec)
  const id = taskId || caller.role?.taskId
  if (!id) throw new Error('缺少 task_id：非 ARTEX 角色会话必须显式指定任务')
  const task = await engine.resolveTask(id)
  return { ...caller, task }
}

export const isOwner = (agent, task) => String(agent.id) === String(task.ownerSession)

export function requireOwner(agent, task) {
  if (!isOwner(agent, task)) {
    throw new Error(`该操作只允许任务 ${task.id} 的所有者会话调用（当前会话不是所有者）`)
  }
}

export function requireRole(agent, role, task, allowed) {
  if (isOwner(agent, task)) return 'owner'
  if (role && role.taskId === task.id && allowed.includes(role.role)) return role.role
  throw new Error(`该操作只允许任务所有者或 ${allowed.join('/')} 角色调用`)
}

/** 读权限：默认只允许 owner 与任务自己的子会话；跨任务读取需显式开启。 */
export function requireRead(agent, role, task, config) {
  if (config?.allowCrossTaskRead === true) return
  if (isOwner(agent, task)) return
  if (role && String(role.taskId) === String(task.id)) return
  throw new Error(`无权读取任务 ${task.id}：仅任务所有者或其子会话可读（可在插件配置开启 allowCrossTaskRead）`)
}

export function liveRuntime(engine, task) {
  const rt = engine.liveTask(task.id)
  if (!rt || rt.finished) {
    throw new Error(`ARTEX 任务 ${task.id} 当前不在运行（status=${task.status}），不能执行写操作`)
  }
  return rt
}

export const LIMIT_KEYS = {
  max_workers: 'maxWorkers',
  max_rounds: 'maxRounds',
  max_stalls: 'maxStalls',
  debounce_ms: 'debounceMs',
  heartbeat_ms: 'heartbeatMs',
  worker_timeout_ms: 'workerTimeoutMs',
  planner_timeout_ms: 'plannerTimeoutMs',
  settle_grace_ms: 'settleGraceMs',
  breakthrough_grace_ms: 'breakthroughGraceMs',
  budget_ms: 'budgetMs',
}

export function pickLimits(args) {
  const limits = {}
  for (const [from, to] of Object.entries(LIMIT_KEYS)) {
    if (args[from] !== undefined) limits[to] = args[from]
  }
  return limits
}

export const RUN_PARAMETERS = {
  goal: { type: 'string', required: true, description: '总目标：一句话说清要达成的最终结果。' },
  description: describe('任务短标题（用于列表与日志），缺省截取 goal。'),
  goals: strings('可选：把总目标拆成 1..N 条"可独立判定是否达成"的验收目标；缺省时总目标本身作为唯一目标。规划者用 artex_prove_goal 逐条证明，全部证明后任务自动完成。'),
  constraints: strings('可选：硬约束（安全边界、禁止项、范围限制）。会以最高优先级注入 planner 与每个 worker，凌驾于一切探索偏好。'),
  mode: { type: 'string', enum: ['objective', 'audit'], description: 'objective=达成目的（首个充分突破即收官，可并行铺多条 pursue）；audit=发现风险（覆盖最大化，枚举验证、正负结果都要有证据）。默认 objective。' },
  view_mode: { type: 'string', enum: ['planner', 'hybrid', 'analyst'], description: '全局视野策略：hybrid=按触发跑 analyst（默认）；planner=只用 planner brief；analyst=每轮都跑。' },
  analyst: { type: 'boolean', description: 'hybrid 开关（默认继承插件配置，通常为 true）：false=关闭 analyst，回到传统 planner-only 模式；与 mode:"objective" 组合即传统非审计模式。' },
  max_workers: integer('并发 worker 数（默认 3）。0 = 只做规划不执行（用于先看方案）。'),
  max_rounds: integer('规划轮次上限（默认 24），达到后结束任务。'),
  max_stalls: integer('连续多少轮规划没有产出可执行方向就停止（默认 2）。'),
  budget_ms: integer('任务级墙钟预算（毫秒，默认 0 = 不限）。耗尽后先让 worker 收尾再停。'),
  worker_timeout_ms: integer('单个 worker 的墙钟预算（毫秒，默认 1200000 = 20 分钟）。'),
  planner_timeout_ms: integer('单轮 planner 的墙钟预算（毫秒，默认 900000）。'),
  heartbeat_ms: integer('无任何变动时的巡检间隔（毫秒，默认 600000）。'),
  debounce_ms: integer('图变动合并窗口（毫秒，默认 800）。'),
  settle_grace_ms: integer('预算耗尽后等待收尾的宽限期（毫秒，默认 90000）。'),
  breakthrough_grace_ms: integer('突破后等待其它 pursue 写回现场的宽限期（毫秒，默认 30000），到期硬停。'),
}

/* ------------------------------------------------------------- factories */
