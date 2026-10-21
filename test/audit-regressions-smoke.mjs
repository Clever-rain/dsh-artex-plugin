/** 审计报告回归：P0/P1/P2 已修项的确定性断言。 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTask, addIntents, claimIntent, recordFact, reportFinding, proveGoal, addHint,
  MAX_FACTS, MAX_FINDINGS, MAX_HINTS,
} from '../model.js'
import { addIntents as addIntentsOp, recordFacts, proveGoal as proveGoalOp } from '../graph-ops.js'
import { ResourceStore, TaskStore, TaskIndex, isValidTaskId } from '../store.js'
import { ArtexEngine, DEFAULTS } from '../engine.js'
import { normalizeConfig } from '../config.js'
import { snapshot } from '../reporting.js'
import { selectNextIntent, plannerRound } from '../scheduler.js'
import { plannerPrompt } from '../prompts.js'
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

  // N1：事实写回不再唤醒 planner（避免每批事实烧一个规划轮）
  const n1Events = []
  const n1Task = makeTask('t-audit-11')
  addIntents(n1Task, [{ summary: 'collect' }])
  claimIntent(n1Task, n1Task.intents[0].id, 'work#1')
  const n1Engine = {
    runtimeForTask: () => ({ task: n1Task }),
    roleForIntent: () => ({ writes: { facts: 0, findings: 0, resources: 0, outcomes: {} } }),
    addActivity: () => ({}),
    pushEvent: (_rt, e) => n1Events.push(e),
    persist: () => {},
  }
  recordFacts(n1Engine, n1Task, [{ summary: 'fact one' }], n1Task.intents[0].id)
  assert.equal(n1Events.some(e => e.kind === 'fact'), false, '事实写回不应 pushEvent')

  // N3：批量写前置校验，失败时不应留下半批事实
  const atomic = makeTask('t-audit-12')
  addIntents(atomic, [{ summary: 'atomic' }])
  claimIntent(atomic, atomic.intents[0].id, 'work#1')
  const atomicEngine = { ...n1Engine, runtimeForTask: () => ({ task: atomic }) }
  assert.throws(
    () => recordFacts(atomicEngine, atomic, [{ summary: 'first ok' }, { summary: '   ' }], atomic.intents[0].id),
    /summary.*不能为空/,
  )
  assert.equal(atomic.facts.length, 0, '批量失败不应留下第一条事实')

  // N2：fact / intent 事件渲染为正确语义，不再是"意图结束"
  const rendered = plannerPrompt({
    task: makeTask('t-audit-13'),
    view: { goals: [], digest: {}, delta: {} },
    round: 2,
    triggers: [{ kind: 'fact', intentId: 5, summary: '新增事实 #12' }, { kind: 'intent', summary: '新增意图 #9' }],
  })
  assert.match(rendered, /新增事实（意图 #5）/)
  assert.match(rendered, /意图变化：新增意图 #9/)
  assert.equal(rendered.includes('意图 #undefined 结束'), false)

  // N5：原型链键当作未知配置，不抛异常
  const protoConfig = normalizeConfig(JSON.parse('{"__proto__":{"polluted":true},"toString":1,"bogusKey":2}'))
  assert.equal(protoConfig.warnings.length >= 3, true)
  assert.equal({}.polluted, undefined)

  // N10：planner 自派意图不触发额外规划轮
  const n10Task = makeTask('t-audit-14')
  const n10Events = []
  const n10Engine = {
    ...n1Engine,
    runtimeForTask: () => ({ task: n10Task }),
    pushEvent: (_rt, e) => n10Events.push(e),
  }
  addIntentsOp(n10Engine, n10Task, [{ summary: 'self intent' }], { notify: false })
  assert.equal(n10Events.some(e => e.kind === 'intent'), false, 'planner 自派意图不应 pushEvent')
  addIntentsOp(n10Engine, n10Task, [{ summary: 'owner intent' }], { notify: true })
  assert.equal(n10Events.some(e => e.kind === 'intent'), true, '所有者派意图应 pushEvent')

  // N4：长行 JSONL 的尾读窗口自适应，仍恢复 4000 条
  const ioStore = new TaskStore(join(root, 'io'))
  const ioTask = makeTask('t-audit-15')
  await ioStore.save(ioTask)
  const activityLine = `${JSON.stringify({ id: 1, intentId: 1, worker: 'work#1', kind: 'step', summary: 'x'.repeat(900), detail: 'y'.repeat(400), at: Date.now() })}\n`
  writeFileSync(join(ioStore.taskDir(ioTask.id), 'activity.jsonl'), activityLine.repeat(4500))
  const ioLoaded = await ioStore.load(ioTask.id)
  assert.equal(ioLoaded.activities.length, 4000)

  console.log('OK audit-regressions')
} finally {
  await rm(root, { recursive: true, force: true })
}
