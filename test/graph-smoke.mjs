import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskStore, ResourceStore, createTask, addIntents, claimIntent, finishIntent, recordFact,
  reportFinding, addHint, setTodos, proveGoal, allGoalsMet, overview, detail, addActivity,
  listTraces, searchTraces, getTrace, plannerView, workerView,
} from '../graph.js'
import { plannerPrompt, workerPrompt, settlePrompt, formatReport } from '../prompts.js'
import { createTools } from '../tools.js'
import { DEFAULTS } from '../engine.js'

const root = await mkdtemp(join(tmpdir(), 'artex-'))
try {
  const task = createTask({
    id: 't-test-1',
    description: '冒烟任务',
    goal: '验证双图与工具 schema',
    goals: ['目标 A', '目标 B'],
    constraints: ['只读'],
    ownerSession: 'sess-owner',
    cwd: root,
    outDir: join(root, '.artex', 'tasks', 't-test-1'),
    limits: { ...DEFAULTS },
  })
  assert.equal(task.goals.length, 2)

  const intents = addIntents(task, [
    { summary: '方向一：读 A', parents: [] },
    { summary: '方向二：读 B', priority: 8 },
    { summary: '方向一：读 A' }, // duplicate
  ])
  assert.equal(intents.filter(r => r.id > 0).length, 2)
  assert.equal(intents.filter(r => r.duplicate).length, 1)

  const id = intents[0].id
  claimIntent(task, id, 'work#1')
  const fact = recordFact(task, { summary: 'A 可读', detail: '细节', evidence: 'cat A', intentId: id })
  const finding = reportFinding(task, { title: 'B 缺陷', severity: 'high', evidence: 'proof', intentId: id })
  assert.equal(task.stats.facts, 1)
  assert.equal(task.intents.find(i => i.id === id).writes.facts, 1)
  assert.equal(task.intents.find(i => i.id === id).writes.findings, 1)

  addActivity(task, { intentId: id, worker: 'work#1', kind: 'step', tool: 'cat', summary: 'cat A', detail: 'A 可读 content' })
  assert.equal(listTraces(task).length, 1)
  assert.equal(searchTraces(task, '可读', { excludeIntentId: 999 }).length >= 1, true)
  assert.equal(searchTraces(task, '可读', { excludeIntentId: id }).length, 0)
  assert.equal(getTrace(task, id).steps.length, 1)
  assert.equal(getTrace(task, id, [task.activities[0].id]).steps[0].detail.length > 0, true)

  finishIntent(task, id, { state: 'done', output: '完成 A', writes: { facts: 1, findings: 0, resources: 0 } })

  const goals = addHint(task, '提示一')
  assert.ok(goals)
  setTodos(task, [{ content: '第二步', status: 'pending' }])
  assert.equal(task.todos.length, 1)

  const proved = proveGoal(task, task.goals[0].id, fact.id, '事实 A 证明目标 A')
  assert.equal(proved.ok, true)
  assert.equal(proved.allMet, false)
  assert.equal(proveGoal(task, task.goals[1].id, 9999, 'x').ok, false)
  assert.equal(proveGoal(task, task.goals[1].id, finding.id, '发现 B 证明目标 B').allMet, true)
  assert.equal(allGoalsMet(task), true)

  // 资源图去重
  const resources = new ResourceStore(root)
  const first = await resources.upsert([{ type: 'file', name: 'a.txt' }], task.id)
  const again = await resources.upsert([{ type: 'file', name: 'A.TXT' }], task.id)
  assert.equal(first[0].id, again[0].id)
  assert.equal(again[0].created, false)

  // 快照往返
  const store = new TaskStore(root)
  await store.save(task)
  const loaded = await store.load(task.id)
  assert.equal(loaded.goals.length, 2)
  assert.equal(loaded.facts.length, 1)
  assert.equal(loaded.status, 'created')

  // 提示词渲染：v0.2 用角色投影 + 紧凑 JSON
  const pView = plannerView(loaded)
  const wView = workerView(loaded, loaded.intents[0])
  const planner = plannerPrompt({ task: loaded, view: pView, triggers: [{ kind: 'done', intentId: id, state: 'done', summary: '完成 A' }], round: 1 })
  assert.match(planner, /ARTEX 规划者/)
  assert.match(planner, /t-test-1/)
  assert.equal(planner.includes('"tasks"'), false)
  const worker = workerPrompt({ task: loaded, intent: loaded.intents[0], view: wView })
  assert.match(worker, /ARTEX 执行者/)
  assert.equal(worker.includes('"todos"'), false, 'worker 视图不应含 planner 待办')
  assert.equal(worker.includes('"constraints"'), false, 'worker 视图不应重复 constraints')
  assert.equal(worker.includes('\n "'), false, 'JSON 应为紧凑格式')
  assert.ok(worker.length < 3500, `worker prompt 过长: ${worker.length}`)
  assert.match(worker, new RegExp(`意图 #${loaded.intents[0].id}`))
  assert.equal(pView.constraints, undefined)
  assert.equal(pView.todos, undefined)
  assert.match(settlePrompt('worker'), /写回/)
  assert.match(formatReport(loaded), /冒烟任务/)

  // 工具 schema：必须是标准 JSON Schema（无属性级 required:true），且根 required 正确
  const engine = { roleOf: () => undefined, config: {} }
  const tools = createTools({ engine, config: DEFAULTS })
  assert.ok(tools.length >= 14)
  for (const tool of tools) {
    assert.ok(tool.name.startsWith('artex_'), tool.name)
    assert.equal(tool.parameters.type, 'object')
    const json = JSON.stringify(tool.parameters)
    assert.equal(json.includes('"required":true'), false, `${tool.name} 仍有属性级 required:true`)
    for (const [, child] of Object.entries(tool.parameters.properties || {})) {
      if (child && typeof child === 'object') assert.notEqual(child.required, true)
    }
    assert.equal(typeof tool.output.schema.type, 'string')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  const runTask = tools.find(t => t.name === 'artex_run_task')
  assert.deepEqual(runTask.parameters.required, ['goal'])
  const prove = tools.find(t => t.name === 'artex_prove_goal')
  assert.deepEqual([...prove.parameters.required].sort(), ['evidence_id', 'goal_id'])
  const setTodosTool = tools.find(t => t.name === 'artex_set_todos')
  assert.deepEqual(setTodosTool.parameters.required, ['todos'])
  assert.equal(setTodosTool.parameters.properties.todos.items.properties.status.enum.length, 3)

  console.log('OK', {
    tools: tools.length,
    intents: task.intents.length,
    facts: task.facts.length,
    findings: task.findings.length,
    resources: first.length,
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
