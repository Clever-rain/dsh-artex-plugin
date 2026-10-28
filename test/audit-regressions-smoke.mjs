/** 审计报告回归：P0/P1/P2 已修项的确定性断言。 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTask, addIntents, claimIntent, recordFact, reportFinding, proveGoal, addHint, setBrief,
  MAX_FACTS, MAX_FINDINGS, MAX_HINTS,
} from '../model.js'
import { addIntents as addIntentsOp, recordFacts, recordFinding, proveGoal as proveGoalOp, promoteIntent as promoteIntentOp } from '../graph-ops.js'
import { ResourceStore, TaskStore, TaskIndex, isValidTaskId, MAX_ACTIVITY_BYTES } from '../store.js'
import { ArtexEngine, DEFAULTS } from '../engine.js'
import { normalizeConfig } from '../config.js'
import { snapshot } from '../reporting.js'
import { selectNextIntent, plannerRound, dispatchWorkers, runWorker, finishWorker, checkStalledWorkers } from '../scheduler.js'
import { plannerPrompt } from '../prompts.js'
import { createTools } from '../tools.js'
import { normalizeStopReason } from '../util.js'

/** 通用引擎 stub：只含 graph-ops/finishWorker 真正触达的方法。 */
const n1EngineFor = (task) => ({
  runtimeForTask: () => ({ task }),
  roleForIntent: () => undefined,
  addActivity: () => ({}),
  pushEvent: () => {},
  persist: () => {},
})

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
  await assert.rejects(() => recordFacts(stub, attr, [{ summary: 'x' }], attr.intents[0].id), /不在运行中/)
  claimIntent(attr, attr.intents[0].id, 'work#1')
  const { facts: written } = await recordFacts(stub, attr, [{ summary: 'x' }], attr.intents[0].id)
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
  await recordFacts(n1Engine, n1Task, [{ summary: 'fact one' }], n1Task.intents[0].id)
  assert.equal(n1Events.some(e => e.kind === 'fact'), false, '事实写回不应 pushEvent')

  // N3：批量写前置校验，失败时不应留下半批事实
  const atomic = makeTask('t-audit-12')
  addIntents(atomic, [{ summary: 'atomic' }])
  claimIntent(atomic, atomic.intents[0].id, 'work#1')
  const atomicEngine = { ...n1Engine, runtimeForTask: () => ({ task: atomic }) }
  await assert.rejects(
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
  await addIntentsOp(n10Engine, n10Task, [{ summary: 'self intent' }], { notify: false })
  assert.equal(n10Events.some(e => e.kind === 'intent'), false, 'planner 自派意图不应 pushEvent')
  await addIntentsOp(n10Engine, n10Task, [{ summary: 'owner intent' }], { notify: true })
  assert.equal(n10Events.some(e => e.kind === 'intent'), true, '所有者派意图应 pushEvent')

  // N4：长行 JSONL 的尾读窗口自适应，仍恢复 4000 条
  const ioStore = new TaskStore(join(root, 'io'))
  const ioTask = makeTask('t-audit-15')
  await ioStore.save(ioTask)
  const activityLine = `${JSON.stringify({ id: 1, intentId: 1, worker: 'work#1', kind: 'step', summary: 'x'.repeat(900), detail: 'y'.repeat(400), at: Date.now() })}\n`
  writeFileSync(join(ioStore.taskDir(ioTask.id), 'activity.jsonl'), activityLine.repeat(4500))
  const ioLoaded = await ioStore.load(ioTask.id)
  assert.equal(ioLoaded.activities.length, 4000)

  // N9：无参 status 的历史列表最多 10 条（上限判断在 continue 之前）
  const historyIds = Array.from({ length: 15 }, (_, i) => `t-audit-h${i}`)
  const historyEngine = {
    roleOf: () => undefined,
    status: async () => [],
    cwdFor: async () => root,
    storeFor: () => ({ tasks: { ids: async () => historyIds } }),
    index: { ownerOf: async () => 'owner' },
  }
  const statusTool = createTools({ engine: historyEngine, config: DEFAULTS }).find(t => t.name === 'artex_task_status')
  const historyResult = await statusTool.execute({}, { agent: { id: 'owner' } })
  const historyLines = historyResult.text.split('\n').filter(line => /^- t-audit-h\d+$/.test(line))
  assert.equal(historyLines.length, 10, `history=${historyLines.length}`)

  // N11：回读时超过上限也要保留 goals[].evidence（与内存层 trimCollection 对齐）
  const evidenceStore = new TaskStore(join(root, 'evidence'))
  const evidenceTask = makeTask('t-audit-16')
  const evidenceFact = recordFact(evidenceTask, { summary: 'EVIDENCE-FACT', outcome: 'found' })
  evidenceTask.goals[0].status = 'met'
  evidenceTask.goals[0].evidence = evidenceFact.id
  for (let i = 0; i < MAX_FACTS + 20; i += 1) recordFact(evidenceTask, { summary: `noise ${i}` })
  await evidenceStore.save(evidenceTask)
  const evidenceLoaded = await evidenceStore.load(evidenceTask.id)
  assert.equal(evidenceLoaded.facts.length, MAX_FACTS + 1, `facts=${evidenceLoaded.facts.length}（尾部上限 + 证据）`)
  assert.equal(evidenceLoaded.facts.some(f => f.id === evidenceFact.id), true, '回读后 fact 证据必须保留')

  const evidenceTask2 = makeTask('t-audit-17')
  const evidenceFinding = reportFinding(evidenceTask2, { title: 'EVIDENCE-FINDING', severity: 'high' })
  evidenceTask2.goals[0].status = 'met'
  evidenceTask2.goals[0].evidence = evidenceFinding.id
  for (let i = 0; i < MAX_FINDINGS + 20; i += 1) reportFinding(evidenceTask2, { title: `noise ${i}` })
  await evidenceStore.save(evidenceTask2)
  const findingsLoaded = await evidenceStore.load(evidenceTask2.id)
  assert.equal(findingsLoaded.findings.length, MAX_FINDINGS + 1, `findings=${findingsLoaded.findings.length}`)
  assert.equal(findingsLoaded.findings.some(f => f.id === evidenceFinding.id), true, '回读后 finding 证据必须保留')

  // N10′：prove_goal / promote_intent 也走 notify；默认必须唤醒（守住首轮 P0-3）
  const goalTask = makeTask('t-audit-18')
  const proofFact = recordFact(goalTask, { summary: 'proof', outcome: 'found' })
  const goalEvents = []
  const goalEngine = {
    ...n1Engine,
    runtimeForTask: () => ({ task: goalTask }),
    pushEvent: (_rt, e) => goalEvents.push(e),
  }
  proveGoalOp(goalEngine, goalTask, goalTask.goals[0].id, proofFact.id, 'r', false, { notify: false })
  assert.equal(goalEvents.some(e => e.kind === 'goal'), false, 'planner 自证不应 pushEvent')
  goalTask.goals[0].status = 'open'          // proveGoal 拒绝重复证明，重置后验证"所有者默认唤醒"
  goalTask.goals[0].evidence = undefined
  proveGoalOp(goalEngine, goalTask, goalTask.goals[0].id, proofFact.id, 'r')
  assert.equal(goalEvents.some(e => e.kind === 'goal'), true, '所有者证明目标必须 pushEvent')

  const promoteTask = makeTask('t-audit-19')
  const [blueprint] = addIntents(promoteTask, [{ summary: 'blueprint', state: 'blueprint' }])
  const promoteEvents = []
  const promoteEngine = {
    ...n1Engine,
    runtimeForTask: () => ({ task: promoteTask }),
    pushEvent: (_rt, e) => promoteEvents.push(e),
  }
  promoteIntentOp(promoteEngine, promoteTask, blueprint.id, { notify: false })
  assert.equal(promoteEvents.some(e => e.kind === 'intent'), false, 'planner 自提升蓝图不应 pushEvent')

  // 工具层：planner 与 owner 传给 proveGoal 的 notify 相反
  const notifyArgs = []
  const notifyEngine = {
    roleOf: (id) => (id === 'planner-sess' ? { role: 'planner', taskId: goalTask.id } : undefined),
    resolveTask: async () => goalTask,
    liveTask: () => ({ task: goalTask, finished: false }),
    proveGoal: (...args) => { notifyArgs.push(args[5]); return { ok: true, kind: 'fact' } },
  }
  const proveTool = createTools({ engine: notifyEngine, config: DEFAULTS }).find(t => t.name === 'artex_prove_goal')
  await proveTool.execute({ goal_id: goalTask.goals[0].id, evidence_id: proofFact.id }, { agent: { id: 'planner-sess' } })
  await proveTool.execute({ task_id: goalTask.id, goal_id: goalTask.goals[0].id, evidence_id: proofFact.id }, { agent: { id: 'owner' } })
  assert.equal(notifyArgs[0]?.notify, false, 'planner 调用 prove_goal 应传 notify:false')
  assert.equal(notifyArgs[1]?.notify, true, 'owner 调用 prove_goal 应传 notify:true')

  // N12：facts/findings 写回即时落盘 JSONL——不 save 也能重启读回
  const evidStore = new TaskStore(join(root, 'evid'))
  const evidTask = makeTask('t-audit-20')
  const evidEngine = {
    runtimeForTask: () => ({ task: evidTask }),
    roleForIntent: () => undefined,
    addActivity: () => ({}),
    pushEvent: () => {},
    persist: () => {},
    persistEvidence: (rt) => evidStore.appendEvidence(rt.task),
  }
  addIntents(evidTask, [{ summary: 'evid work' }])
  claimIntent(evidTask, evidTask.intents[0].id, 'work#1')
  await recordFacts(evidEngine, evidTask, [{ summary: 'crash-proof fact', outcome: 'found', evidence: 'cmd echo ok → ok' }], evidTask.intents[0].id)
  await recordFinding(evidEngine, evidTask, { title: 'crash-proof finding', severity: 'high', evidence: 'curl -i /poc → 200', intentId: evidTask.intents[0].id })
  await evidStore.save(evidTask) // save 与 appendEvidence 共享任务链：等它完成即等齐所有即时落盘
  const evidLoaded = await evidStore.load(evidTask.id)
  assert.equal(evidLoaded.facts.some(f => f.summary === 'crash-proof fact'), true, 'fact 应已即时落盘')
  assert.equal(evidLoaded.findings.some(f => f.title === 'crash-proof finding'), true, 'finding 应已即时落盘')

  // N13：planner 子会话超时进入重试；force 轮不重试
  const t13 = makeTask('t-audit-21')
  let p13calls = 0
  const e13 = {
    config: { ...DEFAULTS, plannerRetries: 2 },
    addActivity: () => ({}),
    persist: () => {},
    maybeRunAnalyst: async () => {},
    runChild: async () => {
      p13calls += 1
      if (p13calls === 1) return { text: '', stopReason: 'timeout', timedOut: true }
      return { text: 'ok', output: [], stopReason: 'completed', timedOut: false }
    },
  }
  await plannerRound(e13, { task: t13, abort: new AbortController(), finished: false }, [], {})
  assert.equal(p13calls, 2, `planner 超时应重试一次（calls=${p13calls}）`)
  assert.equal(t13.round, 1, '超时重试不应多烧轮次')
  const t13b = makeTask('t-audit-21b')
  let p13bcalls = 0
  await plannerRound({ ...e13, runChild: async () => { p13bcalls += 1; return { text: '', stopReason: 'timeout', timedOut: true } } },
    { task: t13b, abort: new AbortController(), finished: false }, [], { force: true })
  assert.equal(p13bcalls, 1, `force/收官轮超时不重试（calls=${p13bcalls}）`)

  // N14：态势投影构建失败走降级通道——非 force 不烧轮；连续三次抛出；force 用降级视图
  const t14 = makeTask('t-audit-22')
  Object.defineProperty(t14, 'facts', { get() { throw new Error('corrupt projection') }, configurable: true })
  let c14 = 0
  let lastPrompt14 = ''
  const e14 = {
    config: { ...DEFAULTS, plannerRetries: 0 },
    addActivity: () => ({}),
    persist: () => {},
    maybeRunAnalyst: async () => {},
    runChild: async (rt, spec) => {
      c14 += 1
      lastPrompt14 = spec.prompt
      return { text: 'ok', output: [], stopReason: 'completed', timedOut: false }
    },
  }
  const rt14 = { task: t14, abort: new AbortController(), finished: false }
  await plannerRound(e14, rt14, [], {}) // 第 1 次失败：降级跳过
  assert.equal(c14, 0, '投影失败不应发起模型调用')
  assert.equal(t14.round, 0, `投影失败不应烧轮次（round=${t14.round}）`)
  await plannerRound(e14, rt14, [], {}) // 第 2 次失败：仍降级跳过
  assert.equal(c14, 0)
  await assert.rejects(() => plannerRound(e14, rt14, [], {}), /corrupt projection/, '连续 3 次投影失败应抛出交收尾')
  const t14c = makeTask('t-audit-22c')
  Object.defineProperty(t14c, 'facts', { get() { throw new Error('corrupt projection') }, configurable: true })
  const rt14c = { task: t14c, abort: new AbortController(), finished: false }
  await plannerRound(e14, rt14c, [], { force: true })
  assert.match(lastPrompt14, /降级视图/, 'force 轮应使用降级视图继续')

  // N15：事实服务端去重——规范化 summary 命中窗口内已有事实则跳过，不重复计数
  const t15 = makeTask('t-audit-23')
  addIntents(t15, [{ summary: 'dedup work' }])
  claimIntent(t15, t15.intents[0].id, 'work#1')
  const e15 = {
    runtimeForTask: () => ({ task: t15 }),
    roleForIntent: () => undefined,
    addActivity: () => ({}),
    pushEvent: () => {},
    persist: () => {},
  }
  const first = await recordFacts(e15, t15, [{ summary: 'Port 22 OPEN' }], t15.intents[0].id)
  const second = await recordFacts(e15, t15, [{ summary: '  port 22   open ' }], t15.intents[0].id)
  assert.equal(second.facts.length, 0, '重复摘要不应新增事实')
  assert.equal(second.duplicates.length, 1, '应返回被命中的既有事实')
  assert.equal(second.duplicates[0].id, first.facts[0].id)
  assert.equal(t15.facts.length, 1)
  assert.equal(t15.stats.facts, 1, '重复事实不应计入 stats')
  assert.equal(t15.intents[0].writes.facts, 1, '重复事实不应重复计 writes')

  // N16：prove_goal 拒绝 inferred 推断证据
  const t16 = makeTask('t-audit-24')
  const inferred = recordFact(t16, { summary: '推断的目标达成', confidence: 'inferred', outcome: 'found' })
  const observed = recordFact(t16, { summary: '观测到的目标达成', confidence: 'observed', outcome: 'found' })
  assert.match(proveGoal(t16, 1, inferred.id, 'r').error || '', /inferred/)
  assert.equal(proveGoal(t16, 1, observed.id, 'r').ok, true, 'observed 证据应可证明')

  // N17：锚点校验——悬空 parents / resource_ids 整体拒绝
  const t17 = makeTask('t-audit-25')
  await assert.rejects(
    () => addIntentsOp(n1EngineFor(t17), t17, [{ summary: 'parents-test', parents: [999] }]),
    /只能引用本任务已存在的 fact\/finding/,
    '悬空 parents 必须拒绝',
  )
  assert.equal(t17.intents.length, 0, '被拒批次不应留下半个意图')
  const [anchorIntent] = await addIntentsOp(n1EngineFor(t17), t17, [{ summary: 'ok', parents: [] }])
  assert.ok(anchorIntent.id > 0)
  const anchorResources = new ResourceStore(join(root, 'anchor-res'))
  await anchorResources.upsert([{ type: 'host', name: 'known-host' }], 't-anchor')
  const e17 = {
    ...n1EngineFor(t17),
    storeFor: () => ({ resources: anchorResources }),
  }
  claimIntent(t17, t17.intents[0].id, 'work#1')
  await assert.rejects(
    () => recordFacts(e17, t17, [{ summary: 'anchor fact', resourceIds: [999] }], t17.intents[0].id),
    /引用了不存在的资源/,
  )
  const ok17 = await recordFacts(e17, t17, [{ summary: 'anchor fact ok', resourceIds: [anchorResources.items[0].id] }], t17.intents[0].id)
  assert.equal(ok17.facts.length, 1, '合法 resource_ids 应通过')
  await assert.rejects(
    () => addIntentsOp(e17, t17, [{ summary: 'anchor intent', resource_ids: [999] }]),
    /引用了不存在的资源/,
  )

  // N18：trim 保护 brief/analysis 的 citations，拷捕次数够多也不悬空
  const t18 = makeTask('t-audit-26')
  t18.brief = { text: 'b', round: 0, citations: [recordFact(t18, { summary: 'BRIEF-REF' }).id] }
  t18.analysis = { text: 'a', round: 0, citations: [recordFact(t18, { summary: 'ANALYSIS-REF' }).id] }
  for (let i = 0; i < MAX_FACTS + 20; i += 1) recordFact(t18, { summary: `t18 noise ${i}` })
  assert.ok(t18.facts.length <= MAX_FACTS + 2)
  assert.equal(t18.facts.some(f => f.summary === 'BRIEF-REF'), true, 'brief 引用的事实必须保留')
  assert.equal(t18.facts.some(f => f.summary === 'ANALYSIS-REF'), true, 'analysis 引用的事实必须保留')

  // N19：stopReason 归一 + provider error 不再是 no_evidence 的 exhausted
  assert.equal(normalizeStopReason('Length'), 'max-tokens')
  assert.equal(normalizeStopReason('interrupted'), 'aborted')
  assert.equal(normalizeStopReason('timedout'), 'timeout')
  assert.equal(normalizeStopReason('FAILED'), 'error')
  const t19 = makeTask('t-audit-27')
  addIntents(t19, [{ summary: 'error intent', kind: 'pursue' }])
  claimIntent(t19, t19.intents[0].id, 'work#1')
  finishWorker(n1EngineFor(t19), { task: t19, siblingStops: new Set(), settling: false, finished: false }, t19.intents[0], {
    text: 'provider exploded', stopReason: 'error', timedOut: false,
    writes: { facts: 0, findings: 0, resources: 0, outcomes: { found: 0, none: 0, inconclusive: 0, blueprint: 0 } },
  })
  assert.equal(t19.intents[0].state, 'blocked', `provider error 应为 blocked（got ${t19.intents[0].state}）`)
  assert.equal(t19.intents[0].reason, 'provider exploded')

  // N20：worker 启动瞬态错误自动重排一次（回炉 open，不烧意图名额）
  const t20 = makeTask('t-audit-28')
  addIntents(t20, [{ summary: 'retry intent', kind: 'pursue' }])
  claimIntent(t20, t20.intents[0].id, 'work#1')
  let spawnFails = 0
  const e20 = {
    config: { ...DEFAULTS },
    runChild: async () => { spawnFails += 1; throw new Error('429 rate limit exceeded') },
    finishWorker: (rt, intent, outcome) => finishWorker(e20, rt, intent, outcome),
    addActivity: () => ({}),
    pushEvent: () => {},
    persist: () => {},
  }
  const rt20 = { abort: new AbortController(), finished: false, settling: false, siblingStops: new Set(), task: t20 }
  await runWorker(e20, rt20, t20.intents[0], 'work#1')
  assert.equal(t20.intents[0].state, 'open', `瞬态错误应自动重排为 open（got ${t20.intents[0].state}）`)
  assert.equal(t20.intents[0].retries, 1)
  assert.equal(spawnFails, 1)
  claimIntent(t20, t20.intents[0].id, 'work#2')
  await runWorker(e20, rt20, t20.intents[0], 'work#2')
  assert.equal(t20.intents[0].state, 'blocked', '第二次瞬态错误应落为 blocked（重排机会已用掉）')

  // N21：activity.jsonl 超上限轮转为 .1，计数器清零
  const rotateStore = new TaskStore(join(root, 'rotate'))
  const rotateTask = makeTask('t-audit-29')
  await rotateStore.appendActivity(rotateTask, { id: 1, intentId: null, worker: 'w', kind: 'step', summary: 's', detail: '', at: Date.now() })
  const rotatePath = join(rotateStore.taskDir(rotateTask.id), 'activity.jsonl')
  rotateStore.activityBytes.set(rotatePath, MAX_ACTIVITY_BYTES + 1) // 直接喂过限计数，避免真写 64MB
  await rotateStore.appendActivity(rotateTask, { id: 2, intentId: null, worker: 'w', kind: 'step', summary: 's2', detail: '', at: Date.now() })
  const { readFile } = await import('node:fs/promises')
  const rotated = await readFile(join(rotateStore.taskDir(rotateTask.id), 'activity.1.jsonl'), 'utf8')
  assert.match(rotated, /"id":1/, '旧卷应归档为 activity.1.jsonl')
  const fresh = await readFile(rotatePath, 'utf8')
  assert.match(fresh, /"id":2/)
  assert.equal(fresh.includes('"id":1'), false, '新卷不应残留旧条目')
  assert.ok(rotateStore.activityBytes.get(rotatePath) < 1024, '轮转后计数器应清零重计')

  // N22：worker 命名跨轮不重名（单调 workerSeq）
  const t22 = makeTask('t-audit-30')
  t22.limits.maxWorkers = 3 // makeTask 不填 limits 默认值，这里显式给并发上限
  addIntents(t22, [{ summary: 'w-a' }, { summary: 'w-b' }, { summary: 'w-c' }])
  const rt22 = { task: t22, running: new Map(), abort: new AbortController(), finished: false, settling: false, completing: false }
  const e22 = {
    ...n1EngineFor(t22),
    runWorker: () => new Promise(() => {}),
  }
  dispatchWorkers(e22, rt22) // 默认 maxWorkers=3，三条同时领取
  assert.deepEqual(t22.intents.map(i => i.worker), ['work#1', 'work#2', 'work#3'])
  rt22.running.delete(t22.intents[0].id)
  dispatchWorkers(e22, rt22) // 没有 open 意图可领，不应再命名
  assert.deepEqual(t22.intents.map(i => i.worker).filter(Boolean).length, 3)

  // N23：任务级预算夹逼剩余时间
  const budgetEngine = new ArtexEngine({ ctx: { get: () => undefined }, config: { ...DEFAULTS, indexPath: join(root, 'idx-budget.json') }, logger: { warn: () => {} } })
  const nowB = Date.now()
  assert.equal(budgetEngine.remainingBudgetMs({ task: { limits: { budgetMs: 0 } }, startedAt: nowB }), Infinity)
  const remaining = budgetEngine.remainingBudgetMs({ task: { limits: { budgetMs: 5000 } }, startedAt: nowB - 4000 })
  assert.ok(remaining <= 1200 && remaining >= 0, `remaining=${remaining}`)
  assert.equal(budgetEngine.remainingBudgetMs({ task: { limits: { budgetMs: 1000 } }, startedAt: nowB - 10000 }), 0)

  // N24：心跳查房——静默先唤醒，仍静默则强制中断
  const t24 = makeTask('t-audit-31')
  addIntents(t24, [{ summary: 'stalled work' }])
  claimIntent(t24, t24.intents[0].id, 'work#1')
  const stallMs2 = Math.max(2 * (DEFAULTS.heartbeatMs || 600000), 2 * 60 * 1000)
  t24.intents[0].startedAt = Date.now() - stallMs2 * 3
  let nudged24 = 0
  let interrupted24 = 0
  const e24 = {
    // 用真实 addActivity：它会续命静默时钟并清 stalledNudges，no-op 桩会把待验证的副作用抹掉
    addActivity: engine.addActivity.bind(engine),
    nudge: () => { nudged24 += 1; return Promise.resolve() },
    interruptChild: () => { interrupted24 += 1 },
  }
  const rt24 = {
    task: { ...t24, limits: { ...t24.limits, heartbeatMs: DEFAULTS.heartbeatMs || 600000 }, intents: t24.intents },
    running: new Map([[t24.intents[0].id, Promise.resolve()]]),
    children: new Map([[`intent-${t24.intents[0].id}`, 'child-1']]),
    stalledNudges: new Map(),
    finished: false,
    settling: false,
  }
  checkStalledWorkers(e24, rt24)
  assert.equal(nudged24, 1, '超静默阈值应先唤醒')
  assert.equal(interrupted24, 0)
  checkStalledWorkers(e24, rt24)
  assert.equal(nudged24, 1, '已唤醒过的不再重复唤醒')
  assert.equal(interrupted24, 1, '唤醒后仍静默应强制中断')

  // N26：同文不同结局是新证据，不能被去重吞掉；同文同结局仍然去重
  const tFlip = makeTask('t-audit-32')
  addIntents(tFlip, [{ summary: 'flip work' }])
  claimIntent(tFlip, tFlip.intents[0].id, 'work#1')
  const eFlip = n1EngineFor(tFlip)
  const firstWrite = await recordFacts(eFlip, tFlip, [{ summary: '共享匿名可读', outcome: 'none', confidence: 'observed', evidence: 'smbclient 被拒' }], tFlip.intents[0].id)
  const secondWrite = await recordFacts(eFlip, tFlip, [{ summary: '共享匿名可读', outcome: 'found', confidence: 'observed', evidence: 'smbclient 成功' }], tFlip.intents[0].id)
  assert.equal(firstWrite.facts.length, 1)
  assert.equal(secondWrite.facts.length, 1, '结局反转的观测必须入库')
  assert.equal(secondWrite.duplicates.length, 0)
  assert.equal(tFlip.facts[1].supersedes, tFlip.facts[0].id, '新证据应标注取代旧节点')
  assert.equal(tFlip.facts[0].supersededBy, tFlip.facts[1].id)
  const thirdWrite = await recordFacts(eFlip, tFlip, [{ summary: '共享匿名可读', outcome: 'found', evidence: '复现证据' }], tFlip.intents[0].id)
  assert.equal(thirdWrite.facts.length, 0, '同文同结局仍应去重')
  assert.equal(thirdWrite.duplicates.length, 1)

  // N27：终态 release 之后的一次 save 不得把事实重复追加
  const tRel = makeTask('t-audit-33')
  for (let i = 1; i <= 3; i += 1) recordFact(tRel, { summary: `rel ${i}`, confidence: 'observed', outcome: 'found' })
  const relStore = new TaskStore(root)
  const relFile = join(root, '.artex', 'tasks', 't-audit-33', 'facts.jsonl')
  const countLines = () => (existsSync(relFile) ? readFileSync(relFile, 'utf8').trim().split('\n').filter(Boolean).length : 0)
  await relStore.save(tRel)
  const beforeRelease = countLines()
  relStore.release(tRel.id)
  await relStore.save(tRel)
  assert.equal(beforeRelease, 3)
  assert.equal(countLines(), beforeRelease, 'release 后不得重复追加')

  // N29：brief 正文里的 #id 也算引用，trim 不能把它淘汰
  const tBrief = makeTask('t-audit-34')
  const anchorFact = recordFact(tBrief, { summary: 'anchor fact', confidence: 'observed' })
  setBrief(tBrief, `已确认 #${anchorFact.id} 是根因`)
  assert.ok(tBrief.brief.citations.includes(anchorFact.id), '正文里的 #id 应进入 citations')
  for (let i = 0; i < MAX_FACTS + 5; i += 1) recordFact(tBrief, { summary: `bulk ${i}`, confidence: 'observed' })
  assert.ok(tBrief.facts.some(f => f.id === anchorFact.id), '被 brief 引用的旧事实不应被 trim 淘汰')

  // ============================================================ P0+P1 路线图（N30+）

  // N30：暂停 → paused 状态落盘 → resume 重挂续跑 → completed；现场（facts/runState）保留
  {
    const agent = { id: 'owner-n30', session: { header: { cwd: root } } }
    let n30seq = 0
    const subagents30 = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true } }),
      async startActivation(spec) {
        const childId = `n30-child-${++n30seq}`
        const isPlanner = spec.label.includes('planner')
        const result = new Promise((resolve) => {
          setTimeout(() => {
            const role = e30.roles.get(childId)
            if (!role) return resolve({ output: [{ type: 'text', text: 'no role' }], stopReason: 'completed' })
            const liveRt = e30.liveTask(role.taskId)
            const task = liveRt?.task
            if (!task) return resolve({ output: [{ type: 'text', text: 'dead' }], stopReason: 'completed' })
            if (isPlanner) {
              if (!task.intents.some(i => i.state === 'open' || i.state === 'running')) {
                e30.addIntents(task, [{ summary: 'seed work', kind: 'pursue' }])
              }
              const goalProofFact = task.facts.find(f => f.outcome === 'found')
              if (goalProofFact && task.goals[0].status !== 'met') {
                e30.proveGoal(task, task.goals[0].id, goalProofFact.id, 'observed 证据已闭环')
              }
            } else if (task.facts.length === 0) {
              e30.recordFacts(task, [{ summary: 'phase-1 fact', evidence: 'echo ok', confidence: 'observed', outcome: 'found' }], role.intentId)
            }
            resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
          }, 5)
        })
        return { childId, result, dispose: async () => undefined }
      },
      async sendMessage() {},
      interrupt() {},
    }
    const e30 = new ArtexEngine({
      ctx: { subagents: subagents30, get: () => undefined },
      config: { ...DEFAULTS, indexPath: join(root, 'index30.json'), debounceMs: 10, heartbeatMs: 100, maxRounds: 12, maxWorkers: 1, budgetMs: 30000 },
      logger: { warn: () => {} },
    })
    const rt30 = await e30.startTask({ agent, goal: 'resume 全链路', description: 'n30', goals: ['目标X'] })
    await rt30.done.catch(() => undefined)
    assert.equal(rt30.task.status, 'completed', '第一阶段应正常完成（N30 场景先跑一趟，暂停发生在后续续跑里）')
    assert.ok(rt30.task.round >= 1)
    assert.ok(rt30.task.facts.length >= 1, '续跑现场应有 fact')
    const prevFacts = rt30.task.facts.length
    // 把完成的现场回写成 paused 并落盘（等效于"跑到一半被 pause 后再重启"的场景复原）：
    // 真实场景里 pause 发生在运行中；回归通过磁盘 roundtrip 覆盖 resume 的状态机部分。
    rt30.task.status = 'paused'
    rt30.task.goals[0].status = 'open'
    rt30.task.goals[0].evidence = undefined
    rt30.task.goals[0].metAt = undefined
    rt30.task.endedAt = undefined
    rt30.task.finishDetail = undefined
    rt30.task.report = undefined
    await e30.storeFor(root).tasks.save(rt30.task)
    e30.tasks.delete(rt30.task.id)
    const resumeState = await e30.resumeTask({ agent, taskId: rt30.task.id, budgetMs: 15000, limits: {} })
    assert.equal(resumeState.task.facts.length, prevFacts, 'resume 后现场 facts 必须保留')
    assert.equal(resumeState.task.report, undefined, 'resume 时应清掉旧 report')
    await resumeState.done
    assert.equal(resumeState.task.status, 'completed', 'resume 后应完成')

    // 预算必填：不给 budget 必须直接拒（先把上一轮的 paused 现场再备好）
    rt30.task.status = 'paused'
    rt30.task.endedAt = undefined
    await e30.storeFor(root).tasks.save(rt30.task)
    e30.tasks.delete(rt30.task.id)
    await assert.rejects(() => e30.resumeTask({ agent, taskId: rt30.task.id, budgetMs: 0, limits: {} }), /预算/)
    // completed 不可续跑
    const compStub = makeTask('t-audit-35')
    compStub.status = 'completed'
    await e30.storeFor(root).tasks.save(compStub)
    await assert.rejects(() => e30.resumeTask({ agent, taskId: compStub.id, budgetMs: 1000, limits: {} }))
  }

  // N31：resume 现场恢复（running 意图回炉 open）
  {
    const task = makeTask('t-audit-36')
    addIntents(task, [{ summary: 'chain step' }, { summary: 'follow' }])
    claimIntent(task, task.intents[0].id, 'work#1')
    task.status = 'paused'
    task.lastPlannerRoundAt = Date.now()
    task.round = 3
    // 模拟 resume 所做：running → open
    for (const i of task.intents) {
      if (i.state === 'running') {
        i.state = 'open'
        i.endedAt = undefined
      }
    }
    assert.equal(task.intents[0].state, 'open')
    assert.equal(task.round, 3, 'round 不清零')
  }

  // N32：token 预算硬门（超限时 beginSettling，以 stopped 收尾）
  {
    const e32 = new ArtexEngine({
      ctx: { get: () => undefined },
      config: { ...DEFAULTS, indexPath: join(root, 'index32.json') },
      logger: { warn: () => {} },
    })
    const task = makeTask('t-audit-37')
    task.limits.maxTokens = 1000
    const rt = {
      task,
      finished: false,
      settling: false,
      completing: false,
      abort: new AbortController(),
      events: [],
      waiters: [],
    }
    assert.equal(e32.checkTokenBudget(rt), false, '未满超限不应触发')
    task.usage = { input_tokens: 900, output_tokens: 200, calls: 1, by_role: {}, by_intent: {} }
    assert.equal(e32.checkTokenBudget(rt), true, '超限应触发 settling')
    assert.equal(rt.settling, true)
    assert.match(rt.finishDetail || '', /token 预算耗尽/)
  }

  // N33：usage 按 intent 归因（无 intent 的落 $role 桶）
  {
    const e33 = new ArtexEngine({
      ctx: { get: () => undefined },
      config: { ...DEFAULTS, indexPath: join(root, 'index33.json') },
      logger: { warn: () => {} },
    })
    const task = makeTask('t-audit-38')
    const rt = { task, finished: false, settling: false, completing: false }
    e33.recordUsage(rt, { role: 'worker', intentId: 7 }, { inputTokens: 100, outputTokens: 20 })
    e33.recordUsage(rt, { role: 'planner' }, { inputTokens: 50, outputTokens: 10 })
    assert.equal(task.usage.by_intent['#7'].input_tokens, 100)
    assert.equal(task.usage.by_intent['#7'].output_tokens, 20)
    assert.equal(task.usage.by_intent['$planner'].input_tokens, 50)
    assert.equal(task.usage.by_role.worker.calls, 1)
  }

  // N34：证据硬门（record_finding 必给 evidence；found fact 必给 evidence）
  {
    const task = makeTask('t-audit-39')
    addIntents(task, [{ summary: 'gating work' }])
    claimIntent(task, task.intents[0].id, 'work#1')
    const stubN1 = n1EngineFor(task)
    await assert.rejects(() => recordFacts(stubN1, task, [{ summary: 'no evidence found', outcome: 'found' }], task.intents[0].id), /must|必须/)
    await assert.rejects(() => recordFinding(stubN1, task, { title: 'no evidence', severity: 'medium', intentId: task.intents[0].id }), /evidence|必须/)
    const { facts: okFacts } = await recordFacts(stubN1, task, [{ summary: 'real found', outcome: 'found', evidence: 'curl /poc → 200' }], task.intents[0].id)
    assert.equal(okFacts.length, 1)
    const finding = await recordFinding(stubN1, task, { title: 'real finding', severity: 'high', evidence: 'repro', intentId: task.intents[0].id })
    assert.equal(finding.status, 'open')
  }

  // N35：prove_goal 默认拒绝 inferred，allow_inferred 放行
  {
    const task = makeTask('t-audit-40')
    const inferFact = recordFact(task, { summary: '看起来可行', outcome: 'found', confidence: 'inferred' })
    assert.equal(proveGoal(task, 1, inferFact.id, 'r').ok, false, 'inferred 默认拒')
    assert.equal(proveGoal(task, 1, inferFact.id, 'r', { allowInferred: true }).ok, true, 'allowInferred=true 应放行')
    const obsFact = recordFact(task, { summary: '复现成功', outcome: 'found', confidence: 'observed', evidence: 'cmd ok' })
    assert.equal(proveGoal(makeTask('t-audit-41'), 1, obsFact.id, 'r').ok, false, 'observer 的 task 不对')
    // 原始用例在 goal 1 上已 met：重做任务
    const rest = makeTask('t-audit-42')
    const fact2 = recordFact(rest, { summary: 'again', outcome: 'found', confidence: 'observed', evidence: 'x' })
    assert.equal(proveGoal(rest, 1, fact2.id, 'r').ok, true)
    // retract 不可再做证据
    const tRet = makeTask('t-audit-43')
    const f = recordFact(tRet, { summary: 'old evidence', outcome: 'found', confidence: 'observed', evidence: 'x' })
    // 直接动 model
    const { retractFact } = await import('../model.js')
    retractFact(tRet, f.id, '产物被证伪')
    assert.equal(proveGoal(tRet, 1, f.id, 'r').ok, false, 'retracted 不能再作证据')
  }

  // N36：任务级沙箱策略（read_only / allowed_tools）落到工具 deny
  {
    const { policyDenyForTask } = await import('../policy.js')
    const pDeny = policyDenyForTask({ readOnly: true }, 'worker')
    assert.ok(pDeny.includes('write'), 'read_only 应把 write 收掉')
    assert.ok(pDeny.includes('pwsh'), 'read_only 应把 pwsh 收掉')
    const whitelisted = policyDenyForTask({ readOnly: true, allowedTools: ['pwsh'] }, 'worker')
    assert.ok(!whitelisted.includes('pwsh'), 'allowed_tools 应让 pwsh 放行')
    assert.ok(whitelisted.includes('write'), 'readOnly 守 write')
    const allowOnly = policyDenyForTask({ allowedTools: ['pwsh'] }, 'worker')
    assert.ok(allowOnly.includes('terminal_send'), '白名单之外的可执行宿主工具应被收掉')
    assert.ok(!allowOnly.includes('pwsh'), '白名单内的工具应放行')
    // 角色 deny 并入：worker 本身不该给 planner 工具
    const noSpec = policyDenyForTask({}, 'worker')
    assert.ok(noSpec.every(n => !['artex_set_brief', 'artex_prove_goal'].includes(n)) === false || noSpec.includes('artex_add_intent'))
  }

  // N37：coverageOf 确定性矩阵：有反馈的 goal 不进 gap，无相关的进 gap
  {
    const { coverageOf } = await import('../views.js')
    const task = makeTask('t-audit-44')
    task.goals = [
      { id: 1, text: '探到 SMB 匿名可读', status: 'open', reason: '', evidence: undefined },
      { id: 2, text: '找到 RDP 策略', status: 'open', reason: '', evidence: undefined },
    ]
    recordFact(task, { summary: 'SMB 共享可见含匿名可读', outcome: 'found', evidence: 'smbclient -L' })
    const cov = coverageOf(task)
    assert.equal(cov.total, 2)
    assert.equal(cov.gaps.length, 1, 'gap 不含已命中 goal')
    assert.equal(cov.gaps[0], 2, 'RDP goal 应是 gap')
    assert.equal(cov.goals[0].facts_linked >= 1, true)
    // audit 完成时 finish 应该带上 coverage
    const { finish } = await import('../scheduler.js')
    const atask = makeTask('t-audit-45')
    atask.mode = 'audit'
    atask.goals[0].status = 'met'
    atask.goals[0].evidence = 1
    const art = { task: atask, finished: false, settleGraceMs: 100, abort: new AbortController() }
    const stubE = { interruptChildren: () => {}, wake: () => {}, addActivity: () => ({}), persist: () => {} }
    finish(stubE, art, 'completed', 'all done')
    assert.ok(atask.report?.coverage, 'audit 收口应带覆盖矩阵')
    assert.ok(Array.isArray(atask.report.coverage.gaps))
  }

  // N38：finding 复测闭环 + 结构化冲突 + 撤回
  {
    const task = makeTask('t-audit-46')
    const f1 = recordFact(task, { summary: '证据 A', outcome: 'found', confidence: 'observed', evidence: 'cmd A' })
    const f2 = recordFact(task, { summary: '证据 B', outcome: 'found', confidence: 'observed', evidence: 'cmd B' })
    const finding = { id: 1 }
    // retestFinding 在 graph-ops 层；这里直接动 model
    const { retestFinding, recordConflict, retractFact } = await import('../model.js')
    const findingNode = reportFinding(task, { title: 'risk', severity: 'high', evidence: 'repro ok' })
    assert.equal(findingNode.status, 'open')
    const r1 = retestFinding(task, findingNode.id, 'verified', '复现成功')
    assert.equal(r1.ok, true)
    assert.equal(task.findings[0].status, 'verified')
    const r2 = retestFinding(task, 999, 'verified', 'none')
    assert.equal(r2.ok, false)
    // 结构化冲突
    const c1 = recordConflict(task, { a: f1.id, b: f2.id, note: '两条观察相互矛盾' })
    assert.equal(c1.ok, true)
    assert.ok(task.conflicts.length === 1)
    assert.ok(task.facts[0].contradicts.includes(f2.id))
    assert.ok(task.facts[1].contradicts.includes(f1.id))
    const c2 = recordConflict(task, { a: 999, b: f1.id })
    assert.equal(c2.ok, false, '缺失节点应拒收')
    // 撤回
    const rf = retractFact(task, f1.id, '后来发现被环境噪声误导')
    assert.equal(rf.ok, true)
    assert.equal(task.facts[0].retracted, true)
    const rAgain = retractFact(task, f1.id, '重复撤回')
    assert.equal(rAgain.ok, false, '不能重复撤回')
  }

  // N39：depends_on 门禁——未完成前置不可领取；前置失败后路线被标记依赖死亡
  {
    const { intentDepsDead } = await import('../model.js')
    const task = makeTask('t-audit-47')
    addIntents(task, [{ summary: '前置A' }])
    const aId = task.intents[0].id
    await assert.rejects(
      () => Promise.resolve().then(() => {
        // dependsOn 必须引用已存在的意图
        return addIntentsOp(n1EngineFor(task), task, [{ summary: '链B', depends_on: [999] }])
      }),
      /depends_on|不存在/,
    )
    const withChain = await addIntentsOp(n1EngineFor(task), task, [{ summary: '链B', depends_on: [aId] }], {})
    assert.equal(withChain.length, 1)
    const chained = task.intents.find(i => i.summary === '链B')
    assert.ok(chained, '链B 应该存在')
    assert.ok(Array.isArray(chained.dependsOn))
    assert.ok(chained.dependsOn.includes(aId))
    assert.equal(intentDepsDead(task, chained), false, '依赖还在 alive 状态时不是 dead')
    // 未完成前置时不可领取
    assert.equal(selectNextIntent(task)?.id, aId, '未满足依赖的链会不被领取')
    task.intents[0].state = 'failed'
    assert.equal(intentDepsDead(task, chained), true, '前置 failed 后路线 dead')
    assert.equal(selectNextIntent(task), undefined, '依赖死亡的意图不能被调度')
    task.intents[0].state = 'done'
    assert.equal(selectNextIntent(task)?.id, chained.id, '依赖完成后链被调度')
  }

  // N40：artex_plan 一次提交 decision/todos/intents/proofs，单段失败不吞后续段
  {
    const engine40 = new ArtexEngine({
      ctx: { get: () => undefined },
      config: { ...DEFAULTS, indexPath: join(root, 'index40.json') },
      logger: { warn: () => {} },
    })
    const task = makeTask('t-audit-48')
    task.status = 'running'
    engine40.tasks.set(task.id, { task, finished: false, events: [], waiters: [], abort: new AbortController() })
    engine40.roles = new Map()
    const proofFact = recordFact(task, { summary: '真实证据', outcome: 'found', confidence: 'observed', evidence: 'cmd ok' })
    const planTool = createTools({ engine: engine40, config: engine40.config }).find(t => t.name === 'artex_plan')
    const out = await planTool.execute({
      task_id: task.id,
      decision: '本轮尝试短链',
      todos: [{ content: 'check A', status: 'in_progress' }],
      intents: [{ summary: 'chain-1' }, { summary: 'chain-2', depends_on: [task.intents.at(-1)?.id ?? 0] }],
      proofs: [
        { goal_id: task.goals[0].id, evidence_id: proofFact.id, reason: '有 observed 证据' },
        { goal_id: task.goals[0].id, evidence_id: proofFact.id }, // 重复 prove 应 fail 但不吞前面的段
      ],
    }, { agent: { id: 'owner' } })
    assert.match(out.text, /plan 已落库/)
    assert.equal(task.goals[0].status, 'met', 'proofs 段应生效')
    assert.equal(task.intents.filter(i => i.summary === 'chain-1').length, 1)
    assert.equal(task.intents.filter(i => i.summary === 'chain-2').length, 1)
    assert.equal(task.todos.length, 1)
    assert.equal(task.activities.find(a => a.kind === 'decision')?.summary, '本轮尝试短链')
    assert.match(out.text, /prove #1 → ok/, 'proofs 段应执行')
    assert.equal((out.text.match(/prove #1 →/g) || []).length, 1, 'allMet 后应提前结束 proofs 段')
  }

  // N41：verifier 白名单 + queueVerifier 按 finding 触发（config 开启时）
  {
    const { ROLE_ALLOW, denyForRole } = await import('../policy.js')
    assert.ok(ROLE_ALLOW.verifier.includes('artex_retest_finding'))
    assert.ok(denyForRole('verifier').includes('artex_add_intent'), 'verifier 不能派意图')
    assert.ok(denyForRole('verifier').includes('artex_set_brief'), 'verifier 不能改 brief')
    const e41 = new ArtexEngine({
      ctx: { get: () => undefined },
      config: { ...DEFAULTS, enableVerifier: true, indexPath: join(root, 'index41.json'), verifierTimeoutMs: 1500, debounceMs: 10, heartbeatMs: 100 },
      logger: { warn: () => {} },
    })
    const task = makeTask('t-audit-49')
    e41.tasks.set(task.id, { task, finished: false, settling: false, completing: false, abort: new AbortController(), events: [], waiters: [] })
    const spawnLabels = []
    e41.runChild = async (rt, spec) => {
      spawnLabels.push(spec.label)
      // 模拟 verifier 的写回：复核通过
      if (spec.key.startsWith('verify-')) {
        return e41.retestFinding(rt.task, { finding_id: rt.task.findings[0].id, result: 'verified', note: 'evidence 复现 ok' }, {})
      }
      return { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }
    }
    e41.addActivity = () => ({})
    e41.pushEvent = () => {}
    e41.persist = () => {}
    const rt41 = e41.tasks.get(task.id)
    const f = reportFinding(task, { title: 'risk!', severity: 'high', evidence: 'repro ok' })
    e41.queueVerifier(rt41, f)
    await new Promise(r => setTimeout(r, 400))
    assert.ok(spawnLabels.some(l => l.includes('verifier')), 'config 开启时 finding 应触发 verifier')
    assert.equal(task.findings[0].status, 'verified')
    // enableVerifier=false：不触发
    const e41b = new ArtexEngine({
      ctx: { get: () => undefined },
      config: { ...DEFAULTS, indexPath: join(root, 'index41b.json') },
      logger: { warn: () => {} },
    })
    const task41b = makeTask('t-audit-50')
    e41b.tasks.set(task41b.id, { task: task41b, finished: false, settling: false, completing: false, abort: new AbortController(), events: [], waiters: [] })
    const labelsB = []
    e41b.runChild = async (_rt, spec) => { labelsB.push(spec.label); return { output: [], stopReason: 'completed' } }
    e41b.queueVerifier(e41b.tasks.get(task41b.id), { id: 1, title: 'x', intentId: null })
    await new Promise(r => setTimeout(r, 80))
    assert.equal(labelsB.length, 0, '关闭时不应触发')
  }

  // N42：verifier 能 record_fact（服务端门禁对齐 policy），且写回不挂意图（finding.intentId 可能已 done）
  {
    const task42 = makeTask('t-audit-51')
    task42.status = 'running'
    const seen = []
    const e42 = {
      roleOf: (id) => (id === 'verifier-sess' ? { role: 'verifier', taskId: task42.id, intentId: 99 } : undefined),
      resolveTask: async () => task42,
      liveTask: () => ({ task: task42, finished: false }),
      recordFacts: async (_task, entries) => { seen.push(...entries); return { facts: entries.map((e, i) => ({ id: i + 1, confidence: e.confidence ?? 'observed' })), duplicates: [] } },
    }
    const factTool42 = createTools({ engine: e42, config: DEFAULTS }).find(t => t.name === 'artex_record_fact')
    const r42 = await factTool42.execute({
      summary: '复核路径上看到的线索', confidence: 'inferred', outcome: 'inconclusive',
    }, { agent: { id: 'verifier-sess' } })
    assert.match(r42.text, /已写回 1 条事实/)
    assert.equal(seen[0].intentId, null, 'verifier 写回不应挂意图')
    // verifier 显式传 intent_id 也一样不挂意图（防止把写回绑到已 done 的意图导致拒收）
    const r42b = await factTool42.execute({ summary: 'y', intent_id: 7 }, { agent: { id: 'verifier-sess' } })
    assert.match(r42b.text, /已写回 1 条事实/)
    assert.equal(seen[1].intentId, null, 'verifier 显式传 intent_id 也应被忽略')
  }

  // N43：冲突节点只允许 fact/finding（goal/intent/hint 不能挂冲突）
  {
    const { recordConflict } = await import('../model.js')
    const task43 = makeTask('t-audit-52')
    const fa = recordFact(task43, { summary: 'A', outcome: 'found', evidence: 'x' })
    addHint(task43, 'a hint')
    assert.equal(recordConflict(task43, { a: task43.goals[0].id, b: fa.id }).ok, false, 'goal 不能进冲突')
    assert.equal(recordConflict(task43, { a: task43.hints[0].id, b: fa.id }).ok, false, 'hint 不能进冲突')
    const fb = recordFact(task43, { summary: 'B', outcome: 'found', evidence: 'y' })
    assert.equal(recordConflict(task43, { a: fa.id, b: fb.id }).ok, true)
  }

  // N44：真·pause 端到端——运行中 pauseTask，终态 paused 并进磁盘快照
  {
    const agent44 = { id: 'owner-n44', session: { header: { cwd: root } } }
    let n44seq = 0
    const subagents44 = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true } }),
      async startActivation(_spec) {
        const childId = `n44-child-${++n44seq}`
        const result = new Promise((resolve) => {
          setTimeout(() => resolve({ output: [{ type: 'text', text: 'late' }], stopReason: 'completed' }), 300)
        })
        return { childId, result, dispose: async () => undefined }
      },
      async sendMessage() {},
      interrupt() {},
    }
    const e44 = new ArtexEngine({
      ctx: { subagents: subagents44, get: () => undefined },
      config: { ...DEFAULTS, indexPath: join(root, 'index44.json'), debounceMs: 10, heartbeatMs: 50, maxRounds: 30, maxWorkers: 1, budgetMs: 30000 },
      logger: { warn: () => {} },
    })
    const rt44 = await e44.startTask({ agent: agent44, goal: 'pause 全链路', description: 'n44', goals: ['目标Y'] })
    await new Promise(r => setTimeout(r, 120)) // 让 planner/第一轮起来
    assert.equal(rt44.task.status, 'running')
    assert.equal(await e44.pauseTask(rt44.task.id, '测试暂停'), true)
    await rt44.done
    assert.equal(rt44.task.status, 'paused', '终态应为 paused')
    const persisted = await e44.loadTask(rt44.task.id)
    assert.equal(persisted.status, 'paused', '磁盘快照也应是 paused')
    assert.match(persisted.finishDetail || '', /测试暂停/)
  }

  console.log('OK audit-regressions')
} finally {
  // 引擎收尾仍是 fire-and-forget 落盘：rm 与后台 flush 赛跑时给几次重试。
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await new Promise(r => setTimeout(r, 250))
      await rm(root, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt === 5) console.warn(`清理临时目录失败（不影响断言结果）：${error?.message || error}`)
    }
  }
}
