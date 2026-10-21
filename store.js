/**
 * 资源图 / 任务快照 / 全局索引的持久化层。
 * 只依赖文件系统，不依赖模型与视图。
 */

import { mkdir, readFile, writeFile, appendFile, rename, readdir, rm, stat, open } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'

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

export class TaskStore {
  constructor(cwd, options = {}) {
    this.cwd = cwd
    this.root = join(cwd, GRAPH_DIR)
    this.paths = new Map()
    this.pending = new Map()
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

  /** 快照不重复存过程日志：activities 已有 activity.jsonl 作为权威副本。 */
  snapshotPayload(task) {
    const { activities, ...rest } = task
    return JSON.stringify(rest)
  }

  /** Persist the graph snapshot (atomic rename, compact JSON, no activities). */
  save(task) {
    const path = this.pathOf(task.id)
    const payload = this.snapshotPayload(task)
    const prev = this.paths.get(task.id) ?? Promise.resolve()
    const next = prev.then(async () => {
      await mkdir(dirname(path), { recursive: true })
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

  /** 从 JSONL 尾部回填过程日志（最多 4000 条），避免整份读取 19 MB 级日志。 */
  async readActivities(taskId) {
    let handle
    try {
      handle = await open(join(this.taskDir(taskId), 'activity.jsonl'), 'r')
      const info = await handle.stat()
      const maxBytes = 4 * 1024 * 1024
      const start = Math.max(0, info.size - maxBytes)
      const length = info.size - start
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      let text = buffer.toString('utf8')
      if (start > 0) {
        const newline = text.indexOf('\n')
        if (newline >= 0) text = text.slice(newline + 1)
      }
      const out = []
      for (const line of text.split('\n')) {
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

  async load(taskId) {
    const raw = JSON.parse(await readFile(this.pathOf(taskId), 'utf8'))
    if (!raw || typeof raw !== 'object') throw new Error('task snapshot 损坏')
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
          if (Date.now() - info.mtimeMs > 3000) {
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
