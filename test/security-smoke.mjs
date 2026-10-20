/** v0.3.6 权限与配置回归：读权限默认收紧、跨任务读取开关、config.mode 生效。 */

import assert from 'node:assert/strict'
import { createTask } from '../graph.js'
import { createTools } from '../tools.js'
import { DEFAULTS, resolveTaskMode } from '../engine.js'

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

// config.mode 作为默认值生效
assert.equal(resolveTaskMode(undefined, 'audit'), 'audit')
assert.equal(resolveTaskMode('objective', 'audit'), 'objective', '任务参数优先')
assert.equal(resolveTaskMode(undefined, undefined), 'objective')

console.log('OK security', { crossTaskRead: 'guarded' })
