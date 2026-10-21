/** 审计报告回归：P0/P1/P2 已修项的确定性断言。 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTask, addIntents, claimIntent, recordFact, reportFinding, proveGoal, addHint,
  MAX_FACTS, MAX_FINDINGS, MAX_HINTS,
} from '../model.js'
import { recordFacts, proveGoal as proveGoalOp } from '../graph-ops.js'
import { ResourceStore, TaskStore, TaskIndex, isValidTaskId } from '../store.js'
import { ArtexEngine, DEFAULTS } from '../engine.js'
import { snapshot } from '../reporting.js'
import { selectNextIntent, plannerRound } from '../scheduler.js'
import { createTools } from '../tools.js'

const root = await mkdtemp(join(tmpdir(), 'artex-audit-'))
try {
  const makeTask = (id = 't-audit-1') => createTask({
    id, description: 'audit regression', goal: 'g', goals: ['goal one'],
    constraints: [], ownerSession: 'owner', cwd: root, outDir: join(root, '.artex', 'tasks', id), limits: {},
  })

  // P0-1：非法 task_id 不得进入路径
  assert.equal(isValidTaskId('t-audit-1'), true)
  assert.equal(isValidTaskId('../../../outside'), false)
  assert.throws(() => new TaskStore(root).taskDir('../../../outside'), /非法 task_id/)
  const engine = new ArtexEngine({
    ctx: { get: () => undefined },
    config: { ...DEFAULTS, indexPath: join(root, 'index.json') },
    logger: { warn: () => {} },
  })
  await assert.rejects(() => engine.resolveTask('../../../outside'), /非法 task_id/)

  // P0-2：集合上限与 hint 截断；目标证据不被淘汰
  const capped = makeTask('t-audit-2')
  const evidence = recordFact(capped, { summary: 'keep me', outcome: 'found' })
  capped.goals[0].status = 'met'
  capped.goals[0].evidence = evidence.id
  for (let i = 0; i < 2100; i++) recordFact(capped, { summary: `fact ${i}` })
  assert.ok(capped.facts.length <= MAX_FACTS + 1, `facts=${capped.facts.length}`)
  assert.ok(capped.facts.some(f => f.id === evidence.id), '目标证据应保留')
  for (let i = 0; i < 520; i++) reportFinding(capped, { title: `finding ${i}` })
  assert.ok(capped.findings.length <= MAX_FINDINGS + 1, `findings=${capped.findings.length}`)
  addHint(capped, 'x'.repeat(200000))
  assert.ok(capped.hints.length <= MAX_HINTS)
  assert.ok(capped.hints.at(-1).text.length <= 2100, `hint=${capped.hints.at(-1).text.length}`)

  // P1-4 / P1-5：负结果需显式允许、已达成不可重复、summary 必填
  const proof = makeTask('t-audit-3')
  const negative = recordFact(proof, { summary: 'path dead', outcome: 'none' })
  assert.equal(proveGoal(proof, 1, negative.id, 'r').ok, false)
  assert.equal(proveGoal(proof, 1, negative.id, 'r', { allowNegative: true }).ok, true)
  assert.equal(proveGoal(proof, 1, negative.id, 'r', { allowNegative: true }).ok, false)
  assert.throws(() => recordFact(proof, { detail: 'no summary' }), /summary 不能为空/)

  // P1-1：优先级 DESC, id ASC
  const queue = makeTask('t-audit-4')
  addIntents(queue, [{ summary: 'low', priority: 1 }, { summary: 'high', priority: 10 }])
  assert.equal(selectNextIntent(queue).summary, 'high')

  // P1-2：只能写回运行中的意图
  const attr = makeTask('t-audit-5')
  addIntents(attr, [{ summary: 'one' }, { summary: 'two' }])
  const stub = {
    runtimeForTask: () => ({ task: attr }),
    roleForIntent: () => undefined,
    addActivity: () => ({}),
    pushEvent: () => {},
    persist: () => {},
  }
  assert.throws(() => recordFacts(stub, attr, [{ summary: 'x' }], attr.intents[0].id), /不在运行中/)
  claimIntent(attr, attr.intents[0].id, 'work#1')
  const written = recordFacts(stub, attr, [{ summary: 'x' }], attr.intents[0].id)
  assert.equal(written[0].intentId, attr.intents[0].id)

  // P0-3：证明/新增意图会 pushEvent（唤醒主循环）
  const events = []
  const wakeTask = makeTask('t-audit-6')
  const wakeStub = {
    ...stub,
    runtimeForTask: () => ({ task: wakeTask }),
    pushEvent: (_rt, e) => events.push(e),
  }
  const fact = recordFact(wakeTask, { summary: 'proof', outcome: 'found' })
  proveGoalOp(wakeStub, wakeTask, 1, fact.id, 'ok')
  assert.equal(events.some(e => e.kind === 'goal'), true)

  // P1-7：资源 attrs 保留来源与冲突
  const resources = new ResourceStore(join(root, 'resources'))
  await resources.upsert([{ type: 'host', name: 'db', attrs: { owner: 'A' } }], 'task-a')
  await resources.upsert([{ type: 'host', name: 'db', attrs: { owner: 'B' } }], 'task-b')
  const item = resources.items[0]
  assert.equal(item.updatedBy, 'task-b')
  assert.deepEqual(item.attrsByTask['task-a'], { owner: 'A' })
  assert.equal(item.conflicts.length, 1)

  // P1-8：provider 缺失时告警并回退
  const warnings = []
  const fallback = new ArtexEngine({
    ctx: { get: () => undefined, subagents: { list: () => ['other'] } },
    config: { ...DEFAULTS, provider: 'missing', indexPath: join(root, 'index2.json') },
    logger: { warn: (m) => warnings.push(m) },
  })
  assert.equal(fallback.resolveProvider(), 'other')
  assert.ok(warnings.some(w => w.includes('未注册')))

  // P2-7：snapshot 暴露 settling
  const snap = snapshot({ config: DEFAULTS, providerName: 'spawn' }, makeTask('t-audit-7'), { settling: true })
  assert.equal(snap.settling, true)
  assert.equal(snap.provider, 'spawn')

  // P1-3：子会话不能启动新任务
  const controlTask = makeTask('t-audit-8')
  const controlEngine = {
    roleOf: (id) => id === 'child' ? { role: 'worker', taskId: controlTask.id, intentId: 1 } : undefined,
    resolveTask: async () => controlTask,
    startTask: async () => { throw new Error('SHOULD-NOT-START') },
  }
  const tools = createTools({ engine: controlEngine, config: DEFAULTS })
  const runTool = tools.find(t => t.name === 'artex_run_task')
  await assert.rejects(
    () => runTool.execute({ goal: 'x' }, { agent: { id: 'child' }, signal: new AbortController().signal }),
    /子会话不能启动新任务/,
  )

  // P1-6：planner 瞬态失败会重试
  const retryTask = makeTask('t-audit-9')
  let plannerCalls = 0
  const retryEngine = {
    config: { ...DEFAULTS, plannerRetries: 2 },
    addActivity: () => ({}),
    persist: () => {},
    maybeRunAnalyst: async () => {},
    runChild: async () => {
      plannerCalls += 1
      if (plannerCalls === 1) throw new Error('429 transient')
      return { text: 'ok', output: [], stopReason: 'completed' }
    },
  }
  await plannerRound(retryEngine, { task: retryTask, abort: new AbortController(), finished: false }, [], {})
  assert.equal(plannerCalls, 2)

  // P2-5：索引注册加锁合并，两个实例并发不互相覆盖
  const indexPath = join(root, 'idx.json')
  const idxA = new TaskIndex(indexPath)
  const idxB = new TaskIndex(indexPath)
  await Promise.all([
    idxA.register({ id: 't-audit-a', cwd: '/a' }),
    idxB.register({ id: 't-audit-b', cwd: '/b' }),
  ])
  const idxC = new TaskIndex(indexPath)
  await idxC.load()
  assert.equal(idxC.items['t-audit-a'].cwd, '/a')
  assert.equal(idxC.items['t-audit-b'].cwd, '/b')

  // P1-2（工具层）：worker 传他人的运行中意图也被拒
  const wt = makeTask('t-audit-10')
  addIntents(wt, [{ summary: 'a' }, { summary: 'b' }])
  for (const intent of wt.intents) intent.state = 'running'
  const workerRole = { role: 'worker', taskId: wt.id, intentId: wt.intents[0].id }
  const workerEngine = {
    roleOf: () => workerRole,
    resolveTask: async () => wt,
    liveTask: () => ({ task: wt, finished: false }),
    roleForIntent: () => workerRole,
    recordFacts: () => [],
  }
  const workerTools = createTools({ engine: workerEngine, config: DEFAULTS })
  const recordTool = workerTools.find(t => t.name === 'artex_record_fact')
  await assert.rejects(
    () => recordTool.execute({ summary: 'x', intent_id: wt.intents[1].id }, { agent: { id: 'child' } }),
    /只能写回自己领到的意图/,
  )

  console.log('OK audit-regressions')
} finally {
  await rm(root, { recursive: true, force: true })
}
