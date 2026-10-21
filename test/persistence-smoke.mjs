/** v0.3.6 持久化回归：快照不存 activities、合并写、资源单飞加载、全局索引。 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, addActivity, recordFact, TaskStore, ResourceStore, TaskIndex } from '../graph.js'

const root = await mkdtemp(join(tmpdir(), 'artex-persist-'))
try {
  const task = createTask({
    id: 't-persist-1',
    description: '持久化测试',
    goal: '验证快照与索引',
    goals: ['一个目标'],
    constraints: [],
    ownerSession: 'owner',
    cwd: root,
    outDir: join(root, '.artex', 'tasks', 't-persist-1'),
    limits: {},
  })
  addActivity(task, { intentId: null, worker: 'test', kind: 'step', summary: '一步', detail: 'x'.repeat(500) })

  const store = new TaskStore(root)
  await store.save(task)
  const snapshot = await readFile(store.pathOf(task.id), 'utf8')
  assert.equal(snapshot.includes('\n'), false, '快照应为紧凑单行 JSON')
  const raw = JSON.parse(snapshot)
  assert.equal('activities' in raw, false, '快照不应包含 activities')
  assert.equal(raw.description, '持久化测试')

  // 过程日志独立保存，load 时回填
  await store.appendActivity(task, task.activities[0])
  const loaded = await store.load(task.id)
  assert.equal(loaded.activities.length, 1, 'load 应从 activity.jsonl 回填过程日志')

  // 合并写：两次 schedule 只落一次最终状态
  loaded.description = 'v2'
  const p1 = store.scheduleSave(loaded, 10)
  loaded.description = 'v3'
  const p2 = store.scheduleSave(loaded, 10)
  await Promise.all([p1, p2])
  const after = JSON.parse(await readFile(store.pathOf(task.id), 'utf8'))
  assert.equal(after.description, 'v3')

  // 资源单飞加载 + 并发 upsert 去重
  const resources = new ResourceStore(root)
  const [a, b] = await Promise.all([
    resources.upsert([{ type: 'file', name: 'a.txt' }], task.id),
    resources.upsert([{ type: 'file', name: 'A.TXT' }], task.id),
  ])
  assert.equal(a[0].id, b[0].id, '大小写不同的同名资源应去重')
  assert.equal([a[0].created, b[0].created].filter(Boolean).length, 1, '并发 upsert 只能创建一次')

  // 全局索引：新实例可按 id 找到 cwd
  const indexPath = join(root, 'index.json')
  const index = new TaskIndex(indexPath)
  await index.register(task)
  const index2 = new TaskIndex(indexPath)
  assert.equal(await index2.lookup(task.id), root)

  // P0-2：facts/findings 分片；快照不重复存，二次保存不重复追加
  const sharded = createTask({
    id: 't-persist-2', description: 'shard', goal: 'g', goals: ['g'], constraints: [],
    ownerSession: 'owner', cwd: root, outDir: join(root, '.artex', 'tasks', 't-persist-2'), limits: {},
  })
  recordFact(sharded, { summary: 'fact one', outcome: 'found' })
  recordFact(sharded, { summary: 'fact two' })
  const shardStore = new TaskStore(root)
  await shardStore.save(sharded)
  const shardRaw = JSON.parse(await readFile(shardStore.pathOf(sharded.id), 'utf8'))
  assert.equal('facts' in shardRaw, false, '快照不应包含 facts')
  const shardLoaded = await new TaskStore(root).load(sharded.id)
  assert.equal(shardLoaded.facts.length, 2)
  await shardStore.save(shardLoaded)
  const shardReloaded = await new TaskStore(root).load(sharded.id)
  assert.equal(shardReloaded.facts.length, 2, '重复保存不应重复追加事实')

  console.log('OK persistence', { snapshotBytes: snapshot.length })
} finally {
  await rm(root, { recursive: true, force: true })
}
