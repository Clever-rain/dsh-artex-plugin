/**
 * Super-agent 设计模式移植的冒烟测试（docs/superagent-patterns-port.md）：
 * 1. Effects 队列：幂等 / 持久化 / 失败重放
 * 2. 两级过滤：准入（schema/去重/模式/速率/scope）与裁决状态机
 * 3. 订阅直通：hint 路由到在跑 worker、不唤醒 planner
 * 4. Mandate 版本化：policyRev 递增、审批吊销、领取闸 mandate_revoked
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EffectOutbox } from '../effects.js'
import { admitTriggers, ingestTriggers, acceptTrigger, ignoreTrigger, TRIGGER_RATE_MAX } from '../triggers.js'
import { createTask, addIntents as graphAddIntents, requestApproval as graphRequestApproval } from '../graph.js'
import { addHint, emitTriggers, decideTrigger, updatePolicy } from '../graph-ops.js'
import { dispatchWorkers } from '../scheduler.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ------------------------------------------------------------ 1. Effects 队列 */

{
  const dir = await mkdtemp(join(tmpdir(), 'artex-effects-'))
  try {
    const delivered = []
    let failures = 0
    const outbox = new EffectOutbox({ dirFor: () => dir })
    outbox.registerDeliverer('note', async (effect) => {
      if (failures > 0) { failures -= 1; throw new Error('模拟投递失败') }
      delivered.push(effect.key)
    })
    const first = await outbox.emit('taskA', { kind: 'note', key: 'k1', payload: { summary: 'x' } })
    assert.equal(first.created, true)
    await sleep(20)
    assert.deepEqual(delivered, ['k1'])
    // 幂等：同 key 不再投递
    const dup = await outbox.emit('taskA', { kind: 'note', key: 'k1', payload: { summary: 'x' } })
    assert.equal(dup.created, false)
    assert.equal(dup.effect.status, 'sent')
    await sleep(20)
    assert.deepEqual(delivered, ['k1'])
    // 失败留档 → 重放补投
    failures = 1
    await outbox.emit('taskA', { kind: 'note', key: 'k2', payload: {} })
    await sleep(20)
    assert.deepEqual(delivered, ['k1'], 'k2 第一次投递应失败')
    let summary = await outbox.summary('taskA')
    assert.equal(summary.failed, 1)
    await outbox.replay('taskA')
    await sleep(20)
    assert.deepEqual(delivered, ['k1', 'k2'])
    // 崩溃恢复：新实例从磁盘重建状态
    const restored = new EffectOutbox({ dirFor: () => dir })
    restored.registerDeliverer('note', async (effect) => { delivered.push(`re:${effect.key}`) })
    const again = await restored.emit('taskA', { kind: 'note', key: 'k2', payload: {} })
    assert.equal(again.created, false, '重启后同 key 仍幂等')
    assert.equal(again.effect.status, 'sent')
    summary = await restored.summary('taskA')
    assert.equal(summary.sent, 2)
    console.log('OK effects outbox（幂等/失败重放/崩溃恢复）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------ 2. 两级过滤（纯函数） */

{
  const base = { policy: { allowedTargets: [] }, triggers: [], triggerMode: 'auto' }
  // schema：未知 kind / 空文本
  let r = admitTriggers(base, [{ kind: 'bogus', text: 'x' }, { kind: 'note', text: '  ' }])
  assert.equal(r.admitted.length, 0)
  assert.equal(r.decisions.filter(d => d.decision === 'rejected').length, 2)
  // 去重：同 kind+source+text
  const task1 = { policy: { allowedTargets: [] }, triggers: [], triggerMode: 'auto' }
  r = admitTriggers(task1, [{ kind: 'alert', source: 'ci', text: '构建失败 #42' }])
  ingestTriggers(task1, r.admitted)
  assert.equal(r.admitted.length, 1)
  r = admitTriggers(task1, [{ kind: 'alert', source: 'ci', text: '构建失败 #42' }])
  assert.equal(r.admitted.length, 0)
  assert.equal(r.decisions[0].reason, 'duplicate')
  // 模式：off 拒收；observe 留档为 observed 且接单被硬拒
  const taskOff = { policy: { allowedTargets: [] }, triggers: [], triggerMode: 'off' }
  r = admitTriggers(taskOff, [{ kind: 'note', text: 'hello' }])
  assert.equal(r.admitted.length, 0)
  assert.equal(r.decisions[0].reason, 'mode_off')
  const taskObs = { policy: { allowedTargets: [] }, triggers: [], triggerMode: 'observe' }
  r = admitTriggers(taskObs, [{ kind: 'note', text: '观察这条' }])
  ingestTriggers(taskObs, r.admitted)
  assert.equal(r.admitted[0].status, 'observed')
  assert.throws(() => acceptTrigger(taskObs, r.admitted[0].id, 99), /observe/)
  // 速率上限
  const taskRate = { policy: { allowedTargets: [] }, triggers: [], triggerMode: 'auto' }
  const many = Array.from({ length: TRIGGER_RATE_MAX + 2 }, (_, i) => ({ kind: 'note', text: `第 ${i} 条` }))
  r = admitTriggers(taskRate, many)
  assert.equal(r.admitted.length, TRIGGER_RATE_MAX)
  assert.equal(r.decisions.filter(d => d.reason === 'rate_limited').length, 2)
  // scope：声明了 allowedTargets 时，文本里的范围外目标被拒
  const taskScope = { policy: { allowedTargets: ['*.example.com'] }, triggers: [], triggerMode: 'auto' }
  r = admitTriggers(taskScope, [{ kind: 'webhook', text: '扫描 https://evil-outside.com 发现异常' }])
  assert.equal(r.admitted.length, 0)
  assert.match(r.decisions[0].reason, /^out_of_scope/)
  r = admitTriggers(taskScope, [{ kind: 'webhook', text: 'https://api.example.com 证书将过期' }])
  assert.equal(r.admitted.length, 1)
  // 裁决状态机：pending → accepted（绑定意图）；ignored 终态；已裁决不能再接
  const task2 = { policy: { allowedTargets: [] }, triggers: [], triggerMode: 'auto' }
  r = admitTriggers(task2, [{ kind: 'issue', text: '登录页 500' }, { kind: 'issue', text: '静态资源 404' }])
  ingestTriggers(task2, r.admitted)
  const t1 = acceptTrigger(task2, r.admitted[0].id, 7)
  assert.equal(t1.status, 'accepted')
  assert.equal(t1.intentId, 7)
  assert.throws(() => acceptTrigger(task2, r.admitted[0].id, 8), /已裁决/)
  const t2 = ignoreTrigger(task2, r.admitted[1].id, '与目标无关')
  assert.equal(t2.status, 'ignored')
  console.log('OK triggers 两级过滤（schema/去重/模式/速率/scope/裁决）')
}

/* ------------------------------------------------------------ 3. 订阅直通 + 引擎级接线 */

function makeFakeEngine(task) {
  const rt = {
    task,
    children: new Map(),
    events: [],
    finished: false,
    settling: false,
    completing: false,
    abort: { signal: { aborted: false } },
    running: new Map(),
    workerSeq: 0,
  }
  const nudges = []
  const activities = []
  const engine = {
    tasks: new Map([[task.id, rt]]),
    runtimeForTask(t) {
      const r = this.tasks.get(t.id)
      if (!r) throw new Error('no rt')
      return r
    },
    addActivity(r, a) { activities.push(a); return { ...a, id: activities.length, at: Date.now() } },
    pushEvent(r, ev) { r.events.push(ev) },
    async nudge(r, childId, text) { nudges.push({ childId, text }) },
    async runWorker() { return { state: 'done', output: '' } },
    persist() {},
    logger: { warn: () => {} },
  }
  return { engine, rt, nudges, activities }
}

{
  const task = createTask({ id: 'thinttest1', goal: 'g', ownerSession: 's1', cwd: '/tmp', limits: {} })
  const { engine, rt, nudges } = makeFakeEngine(task)
  // 一条 running 意图 + 活跃子会话
  const created = graphAddIntents(task, [{ summary: '调查入口 A' }])
  const intent = task.intents.find(i => i.id === created[0].id)
  intent.state = 'running'
  rt.children.set(`intent-${intent.id}`, 'child-1')
  // 直通：显式 intent_id
  let res = addHint(engine, task, ['把重点放在参数污染上'], { intent_id: intent.id })
  assert.equal(res.routed.length, 1)
  assert.equal(res.queued, 0)
  assert.equal(nudges.length, 1)
  assert.equal(nudges[0].childId, 'child-1')
  assert.match(nudges[0].text, /参数污染/)
  assert.equal(rt.events.length, 0, '直通不应唤醒 planner')
  assert.equal(task.hints.length, 1, '提示仍落 hints 供 planner 事后可见')
  // 直通：#<id> 前缀解析
  res = addHint(engine, task, [`#${intent.id} 别忘了看 fact #3`])
  assert.equal(res.routed.length, 1)
  assert.equal(nudges.length, 2)
  // 目标不在跑 → 回退规划者路径并唤醒
  intent.state = 'open'
  res = addHint(engine, task, ['全局换方向'], { intent_id: intent.id })
  assert.equal(res.routed.length, 0)
  assert.equal(res.queued, 1)
  assert.equal(rt.events.length, 1)
  console.log('OK hint 订阅直通（直投/前缀解析/回退唤醒）')
}

/* ------------------------------------------------------------ 4. 触发注入 + 裁决 + Mandate */

{
  const task = createTask({ id: 'ttrigtest1', goal: 'g', ownerSession: 's1', cwd: '/tmp', limits: {} })
  const { engine, rt } = makeFakeEngine(task)
  // auto：准入 → pending + 唤醒事件
  let { admitted } = emitTriggers(engine, task, [{ kind: 'alert', source: 'ci', text: ' nightly 扫描发现新端口 8443 ' }])
  assert.equal(admitted.length, 1)
  assert.equal(admitted[0].status, 'pending')
  assert.equal(rt.events.filter(e => e.kind === 'trigger').length, 1)
  // planner 接单（addIntents trigger_id 路径由 graph-ops.addIntents 负责，这里走 acceptTrigger 层已在纯函数段覆盖）
  // planner 忽略
  const ignored = decideTrigger(engine, task, { trigger_id: admitted[0].id, reason: '已知服务' })
  assert.equal(ignored.status, 'ignored')
  // observe 模式：留档不唤醒
  task.triggerMode = 'observe'
  ;({ admitted } = emitTriggers(engine, task, [{ kind: 'note', text: '仅观察' }]))
  assert.equal(admitted[0].status, 'observed')
  assert.equal(rt.events.filter(e => e.kind === 'trigger').length, 1, 'observe 不应再唤醒')
  // Mandate：updatePolicy 递增 rev + 吊销待审批授权 + 事件
  task.triggerMode = 'auto'
  const created = graphAddIntents(task, [{ summary: '待审批的高风险动作' }])
  const intent = task.intents.find(i => i.id === created[0].id)
  graphRequestApproval(task, intent.id, { reason: '横向移动', action: 'psexec' })
  intent.approval.request.rev = task.policyRev
  const result = updatePolicy(engine, task, { allowed_targets: ['*.example.com'], read_only: true })
  assert.equal(result.policyRev, 2)
  assert.equal(result.revokedApprovals, 1)
  assert.equal(intent.approval.pending, false)
  assert.equal(intent.approval.decision.result, 'revoked')
  assert.equal(task.policy.readOnly, true)
  assert.deepEqual(task.policy.allowedTargets, ['*.example.com'])
  assert.ok(rt.events.some(e => e.kind === 'policy'))
  console.log('OK 触发注入/裁决 + Mandate 版本化（rev/吊销/事件）')
}

/* ------------------------------------------------------------ 5. 领取闸：mandate_revoked */

{
  const task = createTask({ id: 'tmandate01', goal: 'g', ownerSession: 's1', cwd: '/tmp', limits: { maxWorkers: 1 } })
  const { engine, rt } = makeFakeEngine(task)
  const created = graphAddIntents(task, [{ summary: '旧章意图' }, { summary: '新章意图' }])
  const stale = task.intents.find(i => i.id === created[0].id)
  const fresh = task.intents.find(i => i.id === created[1].id)
  stale.mandateRev = 1
  fresh.mandateRev = 2
  task.policyRev = 2
  dispatchWorkers(engine, rt)
  assert.equal(stale.state, 'stopped')
  assert.equal(stale.reason, 'mandate_revoked')
  assert.equal(fresh.state, 'running', '新章意图应被正常领取')
  assert.ok(rt.events.some(e => e.kind === 'policy' && /吊销/.test(e.summary)))
  // 未盖章的旧意图（功能上线前存量）豁免
  const legacy = graphAddIntents(task, [{ summary: '存量未盖章意图' }])
  const legacyIntent = task.intents.find(i => i.id === legacy[0].id)
  rt.running.clear()
  dispatchWorkers(engine, rt)
  assert.equal(legacyIntent.state, 'running', '未盖章旧意图应豁免 Mandate 闸')
  console.log('OK Mandate 领取闸（stale 终结/新章领取/存量豁免）')
}

console.log('patterns-smoke 全部通过')
