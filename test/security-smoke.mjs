/** v0.3.6 权限与配置回归：读权限默认收紧、跨任务读取开关、config.mode 生效。 */

import assert from 'node:assert/strict'
import { createTask } from '../graph.js'
import { createTools } from '../tools.js'
import { DEFAULTS, resolveTaskMode } from '../engine.js'
import { TOOL_NAMES, denyForRole, assertPolicyCoverage } from '../policy.js'
import { normalizeConfig } from '../config.js'

const task = createTask({
  id: 't-sec-1',
  description: '权限测试',
  goal: '验证读权限',
  goals: ['一个目标'],
  constraints: [],
  ownerSession: 'owner-session',
  cwd: '/tmp',
  outDir: '/tmp/.artex/tasks/t-sec-1',
  limits: {},
})

const engine = {
  roleOf: () => undefined,
  resolveTask: async () => task,
  status: async () => ({ task_id: task.id, owner_session: task.ownerSession }),
  cwdFor: async () => '/tmp',
  storeFor: () => ({ tasks: { ids: async () => [] } }),
}

const ownerExec = { agent: { id: 'owner-session' }, signal: new AbortController().signal }
const otherExec = { agent: { id: 'other-session' }, signal: new AbortController().signal }

const closed = createTools({ engine, config: { ...DEFAULTS, allowCrossTaskRead: false } })
const overview = closed.find(t => t.name === 'artex_graph_overview')

await assert.rejects(
  () => overview.execute({ task_id: task.id }, otherExec),
  /无权读取/,
  '默认应拒绝跨任务读取',
)
const ownerResult = await overview.execute({ task_id: task.id }, ownerExec)
assert.ok(ownerResult.text.includes(task.id), 'owner 应能读取')

const open = createTools({ engine, config: { ...DEFAULTS, allowCrossTaskRead: true } })
const otherResult = await open.find(t => t.name === 'artex_graph_overview').execute({ task_id: task.id }, otherExec)
assert.ok(otherResult.text.includes(task.id), '开启 allowCrossTaskRead 后应可读')

// 控制工具也要能真正执行（回归：拆分后 control 模块漏导入 callerOf）
const statusEngine = {
  ...engine,
  status: async () => ({
    task_id: task.id, owner_session: task.ownerSession, status: 'completed', mode: 'objective', view_mode: 'planner',
    goal: 'g', rounds: 1, intents: { by_state: {} }, facts: 0, findings: [], findings_total: 0,
    resources: 0, elapsed_ms: 1, finish_detail: '',
  }),
}
const statusTool = createTools({ engine: statusEngine, config: { ...DEFAULTS } }).find(t => t.name === 'artex_task_status')
const statusResult = await statusTool.execute({ task_id: task.id }, ownerExec)
assert.ok(statusResult.text.includes(task.id), 'task_status 应能执行')

// config.mode 作为默认值生效
assert.equal(resolveTaskMode(undefined, 'audit'), 'audit')
assert.equal(resolveTaskMode('objective', 'audit'), 'objective', '任务参数优先')
assert.equal(resolveTaskMode(undefined, undefined), 'objective')

// 角色策略与真实注册工具一致（新增工具漏配会在这里失败）
const allTools = createTools({ engine, config: { ...DEFAULTS } })
assertPolicyCoverage(allTools.map(t => t.name))
assert.equal(TOOL_NAMES.length, allTools.length)
const workerDeny = denyForRole('worker')
assert.ok(workerDeny.includes('artex_add_intent'), 'worker 不应能派意图')
assert.equal(workerDeny.includes('artex_record_fact'), false, 'worker 应保留写回工具')
const analystDeny = denyForRole('analyst')
assert.ok(analystDeny.includes('artex_record_fact'), 'analyst 不应写事实')
assert.equal(analystDeny.includes('artex_set_analysis'), false, 'analyst 应保留 set_analysis')

// 配置归一化：未知键/非法枚举告警，数字与布尔字符串可转换
const normalized = normalizeConfig({ unknownKey: 1, viewMode: 'bogus', maxWorkers: '4', enableHybrid: 'false' })
assert.equal(normalized.warnings.length >= 2, true, `应产生告警: ${normalized.warnings.join('; ')}`)
assert.equal(normalized.config.maxWorkers, 4)
assert.equal(normalized.config.enableHybrid, false)
assert.equal(normalized.config.viewMode, 'hybrid', '非法枚举回退默认值')

console.log('OK security', { crossTaskRead: 'guarded', policy: 'consistent' })
