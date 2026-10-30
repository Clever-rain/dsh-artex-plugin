/** view-api 冒烟：listTasks 排序/过滤、taskSnapshot 资源过滤与鉴权。纯 node，不依赖 DSH 运行时。 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, recordFact, reportFinding, TaskStore, ResourceStore } from '../graph.js'
import { createViewApi } from '../view-api.js'

const root = await mkdtemp(join(tmpdir(), 'artex-view-api-'))

const makeDiskTask = async ({ id, owner, createdAt, description }) => {
  const task = createTask({
    id,
    description,
    goal: `目标 ${id}`,
    goals: [`目标 ${id}`],
    constraints: [],
    ownerSession: owner,
    cwd: root,
    outDir: join(root, '.artex', 'tasks', id),
    limits: {},
  })
  // 固定时钟：让排序断言可确定。
  task.createdAt = createdAt
  task.updatedAt = createdAt
  return task
}

try {
  /* ------------------------------------------------ fixture: 磁盘任务 */
  const diskA = await makeDiskTask({ id: 't-disk-a', owner: 'owner-a', createdAt: 1000, description: '磁盘任务 A' })
  recordFact(diskA, { summary: '磁盘事实 A', evidence: 'echo a', outcome: 'found', resourceIds: [5] })
  const store = new TaskStore(root)
  await store.save(diskA) // 新格式：task.json 只有元数据，facts 落在 facts.jsonl

  const diskB = await makeDiskTask({ id: 't-disk-b', owner: 'owner-b', createdAt: 3000, description: '磁盘任务 B' })
  await store.save(diskB)

  const diskC = await makeDiskTask({ id: 't-disk-c', owner: 'owner-a', createdAt: 1500, description: '磁盘任务 C' })
  await store.save(diskC)

  // 旧索引条目（index item 没有 ownerSession）：靠 task.json 里的 ownerSession 判定归属。
  const diskOld = await makeDiskTask({ id: 't-disk-old', owner: 'owner-a', createdAt: 1200, description: '旧索引任务 A' })
  await store.save(diskOld)
  const diskOldB = await makeDiskTask({ id: 't-disk-old-b', owner: 'owner-b', createdAt: 2500, description: '旧索引任务 B' })
  await store.save(diskOldB)

  // 索引项存在但 task.json 缺失 -> 列表应跳过；损坏 task.json -> 列表不应抛错。
  await mkdir(join(root, '.artex', 'tasks', 't-corrupt'), { recursive: true })
  await writeFile(join(root, '.artex', 'tasks', 't-corrupt', 'task.json'), '{ not json', 'utf8')

  /* ------------------------------------------------ fixture: live 任务 */
  const liveTask = await makeDiskTask({ id: 't-live-c', owner: 'owner-a', createdAt: 2000, description: 'live 任务 C' })
  recordFact(liveTask, { summary: 'live 事实', evidence: 'echo live', outcome: 'found' })
  reportFinding(liveTask, { title: 'live 发现', severity: 'high', evidence: 'repro', intentId: undefined })

  /* ------------------------------------------------ fixture: 资源库 */
  // 资源 ids：1/2/3 归属 disk-a（三种归属规则各一），4/7 归属 disk-b，
  // 5 只被 disk-a 事实的 resourceIds 引用（补充路径），6 归属 live 任务。
  const resourceItems = [
    { id: 1, type: 'domain', name: 'a.example.com', attrs: {}, attrsByTask: {}, tasks: ['t-disk-a'], updatedBy: 't-disk-a', createdAt: 1, updatedAt: 1 },
    { id: 2, type: 'file', name: '/tmp/x', attrs: {}, attrsByTask: {}, tasks: [], updatedBy: 't-disk-a', createdAt: 2, updatedAt: 2 },
    { id: 3, type: 'service', name: 'http://a.example.com:8080', attrs: {}, attrsByTask: { 't-disk-a': { port: 8080 } }, tasks: [], updatedBy: null, createdAt: 3, updatedAt: 3 },
    { id: 4, type: 'ip', name: '10.0.0.1', attrs: {}, attrsByTask: {}, tasks: ['t-disk-b'], updatedBy: 't-disk-b', createdAt: 4, updatedAt: 4 },
    { id: 5, type: 'credential', name: 'token-1', attrs: {}, attrsByTask: {}, tasks: [], updatedBy: null, createdAt: 5, updatedAt: 5 },
    { id: 6, type: 'app', name: 'live-app', attrs: {}, attrsByTask: {}, tasks: ['t-live-c'], updatedBy: 't-live-c', createdAt: 6, updatedAt: 6 },
    { id: 7, type: 'dataset', name: 'unrelated', attrs: {}, attrsByTask: {}, tasks: ['t-disk-b'], updatedBy: 't-disk-b', createdAt: 7, updatedAt: 7 },
  ]
  await mkdir(join(root, '.artex'), { recursive: true })
  await writeFile(join(root, '.artex', 'resources.json'), JSON.stringify({ counter: resourceItems.length, items: resourceItems }), 'utf8')

  /* ------------------------------------------------ stub engine（真实 store 类） */
  const stores = new Map()
  const indexItems = {
    't-disk-a': { cwd: root, ownerSession: 'owner-a', updatedAt: 1000 },
    't-disk-b': { cwd: root, ownerSession: 'owner-b', updatedAt: 3000 },
    't-disk-c': { cwd: root, ownerSession: 'owner-a', updatedAt: 1500 },
    't-live-c': { cwd: root, ownerSession: 'owner-a', updatedAt: 2000 },
    't-disk-old': { cwd: root, updatedAt: 1200 }, // 旧格式索引项：无 ownerSession
    't-disk-old-b': { cwd: root, updatedAt: 2500 }, // 旧格式索引项，快照里属于 owner-b
    't-missing': { cwd: root, ownerSession: 'owner-a', updatedAt: 1200 },
    't-corrupt': { cwd: root, ownerSession: 'owner-a', updatedAt: 1100 },
  }
  const engine = {
    tasks: new Map([['t-live-c', { task: liveTask, finished: false, settling: true }]]),
    config: { allowCrossTaskRead: false },
    index: {
      items: indexItems,
      async load() { return indexItems },
      async lookup(taskId) { return indexItems[String(taskId)]?.cwd },
    },
    storeFor(cwd) {
      let entry = stores.get(cwd)
      if (!entry) {
        entry = { tasks: new TaskStore(cwd), resources: new ResourceStore(cwd) }
        stores.set(cwd, entry)
      }
      return entry
    },
    liveTask(taskId) { return this.tasks.get(String(taskId)) },
    async loadTask(taskId) {
      try {
        return await this.storeFor(root).tasks.load(String(taskId))
      } catch {
        return undefined
      }
    },
  }
  const api = createViewApi(engine)

  /* ------------------------------------------------------- TaskStore.loadMeta */
  assert.equal(await store.loadMeta('t-missing'), undefined, 'ENOENT 应返回 undefined')
  assert.equal(await store.loadMeta('bad/id'), undefined, '非法 task id 应返回 undefined')
  const metaA = await store.loadMeta('t-disk-a')
  assert.equal(metaA.id, 't-disk-a')
  assert.equal(metaA.ownerSession, 'owner-a')
  assert.equal(metaA.cwd, root)
  assert.equal(metaA.status, 'created')
  assert.equal(metaA.mode, 'objective')
  assert.equal(metaA.description, '磁盘任务 A')
  assert.equal(metaA.goal, '目标 t-disk-a')
  assert.ok(Number.isFinite(metaA.createdAt))
  assert.ok(Number.isFinite(metaA.updatedAt))
  assert.deepEqual(metaA.facts, [], 'loadMeta 不应读取 facts.jsonl')
  assert.deepEqual(metaA.findings, [], 'loadMeta 应补齐 findings 空数组')
  assert.equal(metaA.stats.facts, 1, 'stats 应来自 task.json 元数据')
  assert.equal((await store.load('t-disk-a')).facts.length, 1, 'load() 才合并 JSONL')

  /* --------------------------------------------------- ResourceStore.itemsForTask */
  const resourceStore = new ResourceStore(root)
  assert.deepEqual((await resourceStore.itemsForTask('t-disk-a')).map(r => r.id), [1, 2, 3])
  assert.deepEqual((await resourceStore.itemsForTask('t-disk-b')).map(r => r.id), [4, 7])
  assert.deepEqual(await resourceStore.itemsForTask('t-unknown'), [])

  /* ------------------------------------------------------------- listTasks */
  const list = await api.listTasks({ sessionId: 'owner-a' })
  assert.deepEqual(
    list.map(x => x.task.id),
    ['t-live-c', 't-disk-c', 't-disk-old', 't-disk-a'],
    '应按 createdAt 降序且只含本会话任务（旧索引项靠快照 ownerSession 归属）',
  )
  assert.ok(!list.some(x => x.task.id === 't-disk-b'), '其他会话的任务不应出现')
  assert.ok(!list.some(x => x.task.id === 't-disk-old-b'), '旧索引项里属于其他会话的任务也不应出现')
  assert.ok(!list.some(x => x.task.id === 't-missing'), 'task.json 缺失的索引项应跳过')
  assert.ok(!list.some(x => x.task.id === 't-corrupt'), '损坏的 task.json 应跳过而不是抛错')
  assert.equal(list[0].live, true)
  assert.equal(list[0].settling, true)
  assert.equal(list[0].task.facts.length, 1, 'live 任务应返回完整任务对象')
  assert.equal(list[0].task.findings.length, 1)
  assert.equal(list[1].live, false)
  assert.equal(list[1].settling, false)
  assert.deepEqual(list[2].task.facts, [], '磁盘任务只给元数据，不带 facts 明细')
  assert.deepEqual(list[3].task.facts, [], '磁盘任务只给元数据，不带 facts 明细')

  const limited = await api.listTasks({ sessionId: 'owner-a', limit: 2 })
  assert.deepEqual(limited.map(x => x.task.id), ['t-live-c', 't-disk-c'], 'limit 应生效')
  assert.deepEqual(await api.listTasks({ sessionId: 'owner-nobody' }), [])
  assert.deepEqual(await api.listTasks({}), [], '缺 sessionId 时不应返回任何任务')

  // live 任务同时在索引里：按 id 去重，仍只出现一次且 live=true。
  assert.equal(list.filter(x => x.task.id === 't-live-c').length, 1, 'live 与索引应去重')

  /* ------------------------------------------------------------ taskSnapshot */
  const snapA = await api.taskSnapshot({ taskId: 't-disk-a', sessionId: 'owner-a' })
  assert.equal(snapA.live, false)
  assert.equal(snapA.settling, false)
  assert.equal(snapA.task.id, 't-disk-a')
  assert.equal(snapA.task.facts.length, 1, 'taskSnapshot 应合并 facts.jsonl')
  assert.deepEqual(snapA.resources.map(r => r.id), [1, 2, 3, 5], '资源 = 归属 ∪ facts.resourceIds 引用')
  assert.equal(snapA.resources_total, resourceItems.length)

  const snapLive = await api.taskSnapshot({ taskId: 't-live-c', sessionId: 'owner-a' })
  assert.equal(snapLive.live, true)
  assert.equal(snapLive.settling, true)
  assert.equal(snapLive.task.findings.length, 1)
  assert.deepEqual(snapLive.resources.map(r => r.id), [6], '只返回与本任务相关的资源')

  // 已结束的 live runtime：live=false（仍返回内存对象，不重复 loadTask）。
  engine.tasks.get('t-live-c').finished = true
  engine.tasks.get('t-live-c').settling = false
  const snapFinished = await api.taskSnapshot({ taskId: 't-live-c', sessionId: 'owner-a' })
  assert.equal(snapFinished.live, false)
  assert.equal(snapFinished.settling, false)
  engine.tasks.get('t-live-c').finished = false
  engine.tasks.get('t-live-c').settling = true

  /* ------------------------------------------------------------------ 鉴权 */
  await assert.rejects(
    () => api.taskSnapshot({ taskId: 't-disk-b', sessionId: 'owner-a' }),
    /无权读取该任务/,
    '非所有者读取应被拒绝',
  )
  await assert.rejects(
    () => api.taskSnapshot({ taskId: 't-disk-a' }),
    /无权读取该任务/,
    '缺 sessionId 不能绕过鉴权',
  )
  await assert.rejects(
    () => api.taskSnapshot({ taskId: 't-nope', sessionId: 'owner-a' }),
    /不存在/,
    '不存在的任务应 throw',
  )

  engine.config.allowCrossTaskRead = true
  const cross = await api.taskSnapshot({ taskId: 't-disk-b', sessionId: 'owner-a' })
  assert.equal(cross.task.ownerSession, 'owner-b', 'allowCrossTaskRead 应放行跨任务读取')
  assert.ok(cross.resources.some(r => r.id === 4))
  const crossNoSession = await api.taskSnapshot({ taskId: 't-disk-b' })
  assert.equal(crossNoSession.task.id, 't-disk-b', 'allowCrossTaskRead 打开时可不带 sessionId（仅限本机回环路由）')
  engine.config.allowCrossTaskRead = false

  console.log('OK view-api', {
    list: list.map(x => `${x.task.id}${x.live ? ':live' : ''}`),
    resourcesOfDiskA: snapA.resources.map(r => r.id),
    resourcesTotal: snapA.resources_total,
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
