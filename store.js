/**
 * 资源图 / 任务快照 / 全局索引的持久化层。
 * 只依赖文件系统，不依赖模型与视图。
 */

import { mkdir, readFile, writeFile, appendFile, rename, readdir, rm, stat, open } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { MAX_FACTS, MAX_FINDINGS } from './model.js'

export const GRAPH_DIR = '.artex'

const now = () => Date.now()

/** 生成规则：t + base36 时间戳 + 4 位 hex；禁止路径分隔符与点。 */
export function isValidTaskId(taskId) {
  return /^t[0-9a-z-]{3,40}$/.test(String(taskId ?? ''))
}

/* ---------------------------------------------------------- resource graph */

/** Cross-task resource store: dedupe by (type, key||name). */
export class ResourceStore {
  constructor(rootDir) {
    this.dir = join(rootDir, GRAPH_DIR)
    this.path = join(this.dir, 'resources.json')
    this.counter = 0
    this.items = []
    this.loaded = false
    this.loadPromise = undefined
    this.saving = Promise.resolve()
    this.lastError = undefined
  }

  /** 单飞加载：并发 upsert 不会看到"已标记 loaded 但 items 仍为空"的中间态。 */
  async load() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = JSON.parse(await readFile(this.path, 'utf8'))
          this.counter = Number(raw.counter) || 0
          this.items = Array.isArray(raw.items) ? raw.items : []
        } catch (error) {
          if (error?.code !== 'ENOENT') this.lastError = error
        } finally {
          this.loaded = true
        }
      })()
    }
    return this.loadPromise
  }

  static keyOf(item) {
    const type = String(item.type || 'resource').trim().toLowerCase()
    const key = String(item.key || item.name || '').trim().toLowerCase()
    return `${type}::${key}`
  }

  async upsert(items, taskId) {
    await this.load()
    const out = []
    for (const raw of items) {
      const name = String(raw?.name ?? '').trim()
      if (!name) continue
      const key = ResourceStore.keyOf({ ...raw, name })
      const existing = this.items.find(x => ResourceStore.keyOf(x) === key)
      if (existing) {
        const attrs = raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : null
        if (attrs) {
          existing.attrsByTask = existing.attrsByTask || {}
          if (taskId) existing.attrsByTask[taskId] = { ...(existing.attrsByTask[taskId] || {}), ...attrs }
          const conflicts = {}
          for (const [k, v] of Object.entries(attrs)) {
            if (k in existing.attrs && JSON.stringify(existing.attrs[k]) !== JSON.stringify(v)) conflicts[k] = existing.attrs[k]
          }
          if (Object.keys(conflicts).length > 0) {
            existing.conflicts = existing.conflicts || []
            existing.conflicts.push({ taskId: taskId || null, at: now(), previous: conflicts })
            if (existing.conflicts.length > 50) existing.conflicts = existing.conflicts.slice(-50)
          }
          existing.attrs = { ...existing.attrs, ...attrs }
        }
        existing.updatedBy = taskId || existing.updatedBy || null
        existing.updatedAt = now()
        if (taskId && !existing.tasks.includes(taskId)) existing.tasks.push(taskId)
        out.push({ id: existing.id, name: existing.name, type: existing.type, created: false })
        continue
      }
      this.counter += 1
      const item = {
        id: this.counter,
        type: String(raw.type || 'resource'),
        name,
        key: raw.key ? String(raw.key) : name,
        attrs: raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : {},
        attrsByTask: taskId && raw.attrs && typeof raw.attrs === 'object' ? { [taskId]: raw.attrs } : {},
        conflicts: [],
        updatedBy: taskId || null,
        createdAt: now(),
        updatedAt: now(),
        tasks: taskId ? [taskId] : [],
      }
      this.items.push(item)
      out.push({ id: item.id, name: item.name, type: item.type, created: true })
    }
    this.save()
    return out
  }

  list(filter = {}) {
    const q = filter.q ? String(filter.q).toLowerCase() : ''
    return this.items
      .filter(x => !filter.type || x.type === filter.type)
      .filter(x => !q || `${x.name}\n${x.key}\n${JSON.stringify(x.attrs)}`.toLowerCase().includes(q))
      .slice(0, 200)
      .map(x => ({ id: x.id, type: x.type, name: x.name, attrs: x.attrs }))
  }

  save() {
    const payload = JSON.stringify({ counter: this.counter, items: this.items })
    this.saving = this.saving.then(async () => {
      await mkdir(this.dir, { recursive: true })
      await writeAtomic(this.path, payload)
    }).catch((error) => {
      this.lastError = error
    })
    return this.saving
  }
}

/* ------------------------------------------------------------ persistence */

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/**
 * 回读时的截断策略：保留尾部 max 条，外加 goals[].evidence 指向的节点。
 * 与 model.js trimCollection 的保护策略一致 —— 否则长任务重启后
 * 「证据 #N」会指向已被截掉的节点。
 */
function keepWithEvidence(items, max, evidenceIds) {
  if (!Array.isArray(items) || items.length <= max) return items
  const kept = new Map(items.slice(-max).map(item => [item.id, item]))
  for (const item of items) {
    if (evidenceIds.has(item.id)) kept.set(item.id, item)
  }
  return [...kept.values()].sort((a, b) => a.id - b.id)
}

export class TaskStore {
  constructor(cwd, options = {}) {
    this.cwd = cwd
    this.root = join(cwd, GRAPH_DIR)
    this.paths = new Map()
    this.pending = new Map()
    this.written = new Map()
    this.onError = options.onError
    this.lastError = undefined
  }

  taskDir(taskId) {
    const id = String(taskId)
    if (!isValidTaskId(id)) throw new Error(`非法 task_id: ${id}`)
    const tasksRoot = join(this.root, 'tasks')
    const dir = join(tasksRoot, id)
    if (!dir.startsWith(tasksRoot + sep)) throw new Error(`非法 task_id: ${id}`)
    return dir
  }

  pathOf(taskId) {
    return join(this.taskDir(taskId), 'task.json')
  }

  /** 快照只存元数据：activities / facts / findings 各自 JSONL 为权威副本。 */
  snapshotPayload(task) {
    const { activities, facts, findings, ...rest } = task
    return JSON.stringify(rest)
  }

  jsonlPath(taskId, name) {
    return join(this.taskDir(taskId), `${name}.jsonl`)
  }

  entryFor(taskId) {
    let entry = this.written.get(taskId)
    if (!entry) {
      entry = { facts: new Set(), findings: new Set(), factLines: 0, findingLines: 0 }
      this.written.set(taskId, entry)
    }
    return entry
  }

  async appendNew(task, entry) {
    const facts = Array.isArray(task.facts) ? task.facts : []
    const findings = Array.isArray(task.findings) ? task.findings : []
    const newFacts = facts.filter(f => !entry.facts.has(f.id))
    const newFindings = findings.filter(f => !entry.findings.has(f.id))
    if (newFacts.length > 0) {
      const path = this.jsonlPath(task.id, 'facts')
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, newFacts.map(f => `${JSON.stringify(f)}\n`).join(''), 'utf8')
      for (const f of newFacts) entry.facts.add(f.id)
      entry.factLines += newFacts.length
    }
    if (newFindings.length > 0) {
      const path = this.jsonlPath(task.id, 'findings')
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, newFindings.map(f => `${JSON.stringify(f)}\n`).join(''), 'utf8')
      for (const f of newFindings) entry.findings.add(f.id)
      entry.findingLines += newFindings.length
    }
    // 文件行数超过内存上限 2 倍时压实，避免 JSONL 无界增长。
    if (entry.factLines > MAX_FACTS * 2) {
      const path = this.jsonlPath(task.id, 'facts')
      await writeAtomic(path, facts.map(f => `${JSON.stringify(f)}\n`).join(''))
      entry.facts = new Set(facts.map(f => f.id))
      entry.factLines = facts.length
    }
    if (entry.findingLines > MAX_FINDINGS * 2) {
      const path = this.jsonlPath(task.id, 'findings')
      await writeAtomic(path, findings.map(f => `${JSON.stringify(f)}\n`).join(''))
      entry.findings = new Set(findings.map(f => f.id))
      entry.findingLines = findings.length
    }
  }

  /** Persist metadata + append only new facts/findings (atomic rename, compact JSON). */
  save(task) {
    const path = this.pathOf(task.id)
    const payload = this.snapshotPayload(task)
    const prev = this.paths.get(task.id) ?? Promise.resolve()
    const next = prev.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const entry = this.entryFor(task.id)
      await this.appendNew(task, entry)
      await writeAtomic(path, payload)
    }).catch((error) => {
      this.lastError = error
      this.onError?.(error)
    })
    this.paths.set(task.id, next)
    return next
  }

  /**
   * 合并写：高频 mutation 只安排一次延迟落盘，flush 时序列化最新状态。
   * 返回的 promise 在真正写完后 resolve。
   */
  scheduleSave(task, delay = 200) {
    const id = task.id
    const existing = this.pending.get(id)
    if (existing) {
      existing.task = task
      return existing.promise
    }
    const entry = { task, timer: undefined, resolve: undefined, promise: undefined }
    entry.promise = new Promise((resolve) => { entry.resolve = resolve })
    entry.timer = setTimeout(() => { void this.flush(id) }, Math.max(0, delay))
    this.pending.set(id, entry)
    return entry.promise
  }

  async flush(id) {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    await this.save(entry.task)
    entry.resolve()
  }

  async flushAll() {
    await Promise.all([...this.pending.keys()].map(id => this.flush(id)))
  }

  /** Append-only process log, so long runs survive the in-memory activity cap. */
  appendActivity(task, activity) {
    const path = join(this.taskDir(task.id), 'activity.jsonl')
    const line = `${JSON.stringify(activity)}\n`
    const prev = this.paths.get(`${task.id}:activity`) ?? Promise.resolve()
    const next = prev.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, line, 'utf8')
    }).catch((error) => {
      this.lastError = error
      this.onError?.(error)
    })
    this.paths.set(`${task.id}:activity`, next)
    return next
  }

  /** 从 JSONL 尾部回填过程日志（最多 4000 条）；窗口按平均行长自适应。 */
  async readActivities(taskId) {
    let handle
    try {
      handle = await open(join(this.taskDir(taskId), 'activity.jsonl'), 'r')
      const info = await handle.stat()
      const size = info.size
      if (size === 0) return []
      const readRange = async (start, length) => {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, start)
        return buffer.toString('utf8')
      }
      // 先用 1 MB 探针估算平均行长，避免固定 4 MB 在长行日志下只恢复几百条。
      const probeLength = Math.min(size, 1024 * 1024)
      const probeStart = Math.max(0, size - probeLength)
      const probe = await readRange(probeStart, probeLength)
      const probeLines = Math.max(1, (probe.match(/\n/g) || []).length)
      const averageLine = probeLength / probeLines
      const targetBytes = Math.min(size, Math.max(4 * 1024 * 1024, Math.ceil(averageLine * 4000 * 1.2)))
      const start = Math.max(0, size - Math.min(targetBytes, 64 * 1024 * 1024))
      const length = size - start
      const text = await readRange(start, length)
      let body = text
      if (start > 0) {
        const newline = body.indexOf('\n')
        if (newline >= 0) body = body.slice(newline + 1)
      }
      const out = []
      for (const line of body.split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
      }
      return out.slice(-4000)
    } catch {
      return []
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async readJsonl(taskId, name) {
    try {
      const text = await readFile(this.jsonlPath(taskId, name), 'utf8')
      const items = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { items.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
      }
      return { items, exists: true }
    } catch {
      return { items: [], exists: false }
    }
  }

  async load(taskId) {
    const raw = JSON.parse(await readFile(this.pathOf(taskId), 'utf8'))
    if (!raw || typeof raw !== 'object') throw new Error('task snapshot 损坏')
    const factsFile = await this.readJsonl(taskId, 'facts')
    const findingsFile = await this.readJsonl(taskId, 'findings')
    // 与内存层 trimCollection 对齐：超上限时保留目标证据，否则回读后 evidence 会指向已删节点。
    const evidenceIds = new Set(
      (Array.isArray(raw.goals) ? raw.goals : [])
        .map(goal => Number(goal?.evidence))
        .filter(id => Number.isFinite(id) && id > 0),
    )
    if (factsFile.exists) {
      const merged = new Map()
      for (const f of [...(Array.isArray(raw.facts) ? raw.facts : []), ...factsFile.items]) merged.set(f.id, f)
      raw.facts = keepWithEvidence([...merged.values()].sort((a, b) => a.id - b.id), MAX_FACTS, evidenceIds)
    }
    if (findingsFile.exists) {
      const merged = new Map()
      for (const f of [...(Array.isArray(raw.findings) ? raw.findings : []), ...findingsFile.items]) merged.set(f.id, f)
      raw.findings = keepWithEvidence([...merged.values()].sort((a, b) => a.id - b.id), MAX_FINDINGS, evidenceIds)
    }
    // 新格式快照不存 facts/findings；对应 JSONL 不存在时也要补空数组。
    if (!Array.isArray(raw.facts)) raw.facts = []
    if (!Array.isArray(raw.findings)) raw.findings = []
    const entry = this.entryFor(taskId)
    if (factsFile.exists) {
      entry.facts = new Set(factsFile.items.map(f => f.id))
      entry.factLines = factsFile.items.length
    }
    if (findingsFile.exists) {
      entry.findings = new Set(findingsFile.items.map(f => f.id))
      entry.findingLines = findingsFile.items.length
    }
    if (!Array.isArray(raw.activities) || raw.activities.length === 0) {
      const activities = await this.readActivities(taskId)
      if (activities.length > 0) {
        raw.activities = activities
        raw.activitySeq = Math.max(Number(raw.activitySeq) || 0, ...activities.map(a => Number(a.id) || 0))
      }
    }
    return raw
  }

  /** Task ids present on disk (newest first), for status queries after a restart. */
  async ids() {
    try {
      const entries = await readdir(join(this.root, 'tasks'), { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
    } catch {
      return []
    }
  }
}

/**
 * 全局任务索引：taskId → cwd。
 * 快照仍在各自工作区的 .artex 下，索引只解决"换一个 cwd 也能按 id 找到任务"。
 */
export class TaskIndex {
  constructor(path = join(homedir(), '.dsh', 'artex-index.json'), options = {}) {
    this.path = path
    this.items = {}
    this.loadPromise = undefined
    this.onError = options.onError
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = JSON.parse(await readFile(this.path, 'utf8'))
          this.items = raw?.items && typeof raw.items === 'object' ? raw.items : {}
        } catch (error) {
          if (error?.code !== 'ENOENT') this.onError?.(error)
        }
      })()
    }
    return this.loadPromise
  }

  async register(task) {
    if (!task?.id || !task?.cwd) return
    await this.load()
    await this.withLock(async () => {
      // 锁内重新读取磁盘，避免多窗口各自持有旧 items 互相覆盖。
      let disk = {}
      try {
        const raw = JSON.parse(await readFile(this.path, 'utf8'))
        disk = raw?.items && typeof raw.items === 'object' ? raw.items : {}
      } catch { /* 首次写入 */ }
      this.items = { ...disk, ...this.items }
      this.items[task.id] = { cwd: task.cwd, ownerSession: task.ownerSession, updatedAt: now() }
      const ids = Object.keys(this.items)
      if (ids.length > 500) {
        for (const id of ids.sort((a, b) => (this.items[a].updatedAt || 0) - (this.items[b].updatedAt || 0)).slice(0, ids.length - 500)) {
          delete this.items[id]
        }
      }
      await writeAtomic(this.path, JSON.stringify({ items: this.items }))
    })
  }

  async withLock(fn) {
    const lock = `${this.path}.lock`
    await mkdir(dirname(lock), { recursive: true })
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        await mkdir(lock)
        try {
          return await fn()
        } finally {
          await rm(lock, { recursive: true, force: true }).catch(() => undefined)
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const info = await stat(lock)
          if (Date.now() - info.mtimeMs > 30000) {
            await rm(lock, { recursive: true, force: true }).catch(() => undefined)
            continue
          }
        } catch { /* 锁刚被释放 */ }
        await delay(20)
      }
    }
    throw new Error('ARTEX 任务索引锁超时')
  }

  async lookup(taskId) {
    const id = String(taskId)
    if (!isValidTaskId(id)) return undefined
    await this.load()
    return this.items[id]?.cwd
  }

  async ownerOf(taskId) {
    const id = String(taskId)
    if (!isValidTaskId(id)) return undefined
    await this.load()
    return this.items[id]?.ownerSession
  }
}
