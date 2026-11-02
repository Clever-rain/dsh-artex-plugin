/**
 * Effects 队列（移植自 dsh-superagent 的 effect 表）：持久化副作用 outbox。
 *
 * 原则：副作用**先落盘、后投递**。进程崩溃最多丢一次投递尝试，不丢副作用本身；
 * resumeTask / 插件重启时对 pending 条目重放。投递按 key 幂等——同 key 的 emit
 * 返回既有条目，不重复投递。
 *
 * 与 superagent 的差异：投递器按 kind 注册（这里是内存函数表，不是 Channel 插件），
 * 顺序保证到"单任务串行 pump"，跨任务不保证（与 superagent 的单引擎串行等价到任务粒度）。
 */

import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const now = () => Date.now()

/** effects.jsonl 单文件上限：超出后压实（仅保留 pending/failed + 最近 200 条已投递）。 */
export const MAX_EFFECTS_BYTES = 8 * 1024 * 1024
const KEEP_SENT = 200

export class EffectOutbox {
  /**
   * @param {() => string} dirFor 任务目录解析（.artex/tasks/<id>）
   * @param {(error: unknown) => void} [onError] 落盘错误回调（不阻断编排）
   */
  constructor({ dirFor, onError } = {}) {
    this.dirFor = dirFor
    this.onError = onError
    /** taskId -> { effects: Map<key, effect>, seq: number, loaded: boolean, writing: Promise } */
    this.boxes = new Map()
    /** taskId -> Promise（pump 串行链） */
    this.pumps = new Map()
    /** kind -> async (effect, ctx) => void（抛错=投递失败，会重试） */
    this.deliverers = new Map()
  }

  pathOf(taskId) {
    return join(this.dirFor(taskId), 'effects.jsonl')
  }

  registerDeliverer(kind, fn) {
    this.deliverers.set(String(kind), fn)
  }

  async #load(taskId) {
    let box = this.boxes.get(taskId)
    if (!box) {
      box = { effects: new Map(), seq: 0, loaded: false, writing: Promise.resolve() }
      this.boxes.set(taskId, box)
    }
    if (box.loaded) return box
    box.loaded = true
    try {
      const text = await readFile(this.pathOf(taskId), 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const effect = JSON.parse(trimmed)
          if (!effect || typeof effect.key !== 'string') continue
          box.effects.set(effect.key, effect)
          box.seq = Math.max(box.seq, Number(effect.id) || 0)
        } catch { /* 跳过损坏行 */ }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#error(error)
    }
    return box
  }

  #error(error) {
    try { this.onError?.(error) } catch { /* 日志失败不阻断 */ }
  }

  /** 追加一行（状态变迁也追加——JSONL 是事件日志，内存 Map 是折叠视图）。 */
  #append(taskId, effect) {
    const box = this.boxes.get(taskId)
    const line = `${JSON.stringify(effect)}\n`
    box.writing = box.writing.then(async () => {
      const path = this.pathOf(taskId)
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, line, 'utf8')
    }).catch((error) => this.#error(error))
    return box.writing
  }

  /** 压实：文件超限时重写为折叠视图（pending/failed 全保留，sent 只留最近 KEEP_SENT 条）。 */
  async #compact(taskId) {
    const box = this.boxes.get(taskId)
    const path = this.pathOf(taskId)
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(path).catch(() => null)
      if (!info || info.size <= MAX_EFFECTS_BYTES) return
      const all = [...box.effects.values()].sort((a, b) => a.id - b.id)
      const open = all.filter(e => e.status !== 'sent')
      const sent = all.filter(e => e.status === 'sent').slice(-KEEP_SENT)
      const payload = [...open, ...sent].sort((a, b) => a.id - b.id).map(e => `${JSON.stringify(e)}\n`).join('')
      const tmp = `${path}.${process.pid}.${now()}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, path)
    } catch (error) {
      this.#error(error)
    }
  }

  /**
   * 发出一个副作用：同 key 幂等（返回既有条目）；新条目先落 pending 再投递。
   * @returns {Promise<{effect: object, created: boolean}>}
   */
  async emit(taskId, { kind, key, payload = {}, deliver = true }) {
    if (!kind || typeof kind !== 'string') throw new Error('effect 需要 kind')
    if (!key || typeof key !== 'string') throw new Error('effect 需要幂等 key')
    const box = await this.#load(taskId)
    const existing = box.effects.get(key)
    if (existing) {
      // 已 sent 的不重投；pending/failed 的由 pump 补投。
      if (existing.status !== 'sent' && deliver) this.#pump(taskId)
      return { effect: existing, created: false }
    }
    const effect = {
      id: ++box.seq,
      key,
      kind: String(kind),
      payload,
      status: 'pending',
      attempts: 0,
      firstAt: now(),
      lastAt: now(),
      error: null,
    }
    box.effects.set(key, effect)
    await this.#append(taskId, effect)
    if (deliver) this.#pump(taskId)
    return { effect, created: true }
  }

  /** 单任务串行 pump：逐条投 pending/failed（attempts<5），成功标 sent。 */
  #pump(taskId) {
    const prev = this.pumps.get(taskId) ?? Promise.resolve()
    const next = prev.then(() => this.#drain(taskId)).catch(() => {})
    this.pumps.set(taskId, next)
    return next
  }

  async #drain(taskId) {
    const box = await this.#load(taskId)
    const pending = [...box.effects.values()]
      .filter(e => e.status !== 'sent' && e.attempts < 5)
      .sort((a, b) => a.id - b.id)
    for (const effect of pending) {
      const deliverer = this.deliverers.get(effect.kind)
      effect.attempts += 1
      effect.lastAt = now()
      if (!deliverer) {
        effect.status = 'failed'
        effect.error = `no deliverer for kind ${effect.kind}`
        await this.#append(taskId, effect)
        continue
      }
      try {
        await deliverer(effect, { taskId })
        effect.status = 'sent'
        effect.error = null
      } catch (error) {
        effect.status = 'failed'
        effect.error = String(error?.message ?? error).slice(0, 300)
      }
      await this.#append(taskId, effect)
    }
    await this.#compact(taskId)
  }

  /** 重放入口（resumeTask / 插件重启后）：把所有 pending/failed 再投一遍。 */
  async replay(taskId) {
    await this.#load(taskId)
    return this.#pump(taskId)
  }

  /** 状态摘要（status 视图用）。 */
  async summary(taskId) {
    const box = await this.#load(taskId)
    let pending = 0, sent = 0, failed = 0
    for (const e of box.effects.values()) {
      if (e.status === 'sent') sent += 1
      else if (e.status === 'failed') failed += 1
      else pending += 1
    }
    return { pending, sent, failed }
  }

  /** 任务终态清理内存（文件保留）。 */
  drop(taskId) {
    this.boxes.delete(taskId)
    this.pumps.delete(taskId)
  }
}
