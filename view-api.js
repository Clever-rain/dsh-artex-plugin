/**
 * 只读数据接口（Host Service `artex`）：供 @local/dsh-artex-view 等视图插件
 * 读取任务列表与任务快照。
 *
 * 设计要点：
 * - 不参与编排、不写磁盘、不改引擎状态；
 * - 列表页只读 task.json 元数据（TaskStore.loadMeta），不为每个任务加载 JSONL；
 * - 快照复用 engine.loadTask()（已合并 facts/findings JSONL），不另写合并逻辑；
 * - 鉴权与 tools/read.js 的 requireRead 对齐：默认只服务任务所有者，
 *   config.allowCrossTaskRead === true 时放行。
 */

import { isValidTaskId } from './store.js'

/** 列表上限：与 CONTRACT §2/§3 的「最多 50 条」一致。 */
export const MAX_LIST_LIMIT = 50

function clampLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return MAX_LIST_LIMIT
  return Math.min(Math.floor(value), MAX_LIST_LIMIT)
}

function sameSession(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false
  return String(a) === String(b)
}

/** 与 tools/read.js 的 requireRead 语义一致：默认只允许任务所有者读取。 */
function assertReadable(engine, task, sessionId) {
  if (engine?.config?.allowCrossTaskRead === true) return
  if (!sameSession(sessionId, task?.ownerSession)) throw new Error('无权读取该任务')
}

/** task.json 元数据读取：吞掉单个损坏/过期索引项，避免整张列表失败。 */
async function loadDiskMeta(engine, taskId, cwd) {
  try {
    if (cwd) return await engine.storeFor(cwd).tasks.loadMeta(taskId)
    // 索引项缺 cwd 时回退到本进程已知的 workspace 根。
    const roots = engine.stores instanceof Map ? [...engine.stores.keys()] : []
    for (const root of roots) {
      const meta = await engine.storeFor(root).tasks.loadMeta(taskId)
      if (meta) return meta
    }
  } catch {
    // 损坏的快照/无权限目录：视为不可列表。
  }
  return undefined
}

/** facts/findings/intents 上 resourceIds 的并集：资源过滤的补充来源。 */
function referencedResourceIds(task) {
  const ids = new Set()
  for (const list of [task?.intents, task?.facts, task?.findings]) {
    if (!Array.isArray(list)) continue
    for (const node of list) {
      if (!node || !Array.isArray(node.resourceIds)) continue
      for (const raw of node.resourceIds) {
        const id = Number(raw)
        if (Number.isFinite(id)) ids.add(id)
      }
    }
  }
  return ids
}

/**
 * 本任务相关资源 = 资源库自身归属（tasks / updatedBy / attrsByTask）
 * ∪ facts/findings/intents 的 resourceIds 引用（防遗漏）。
 */
async function resourcesForTask(engine, task) {
  const cwd = task?.cwd || await engine.index?.lookup?.(task?.id)
  if (!cwd) return { related: [], total: 0 }
  const store = engine.storeFor(cwd).resources
  const owned = await store.itemsForTask(task.id)
  const byId = new Map(owned.map(item => [Number(item.id), item]))
  const refs = referencedResourceIds(task)
  if (refs.size > 0) {
    for (const item of store.items) {
      const id = Number(item?.id)
      if (refs.has(id) && !byId.has(id)) byId.set(id, item)
    }
  }
  const related = [...byId.values()].sort((a, b) => Number(a?.id) - Number(b?.id))
  return { related, total: store.items.length }
}

export function createViewApi(engine) {
  return {
    /**
     * 当前会话拥有的任务（live + 磁盘索引 + 指定 cwd 的 .artex/tasks 扫描），
     * 按 createdAt 降序，最多 limit 条。
     * 返回 [{ task, live, settling }]；磁盘任务只含元数据（无 facts/findings 明细）。
     *
     * `cwd` 可选：全局索引索引不到的历史任务（旧版本/自定义 indexPath 创建的）
     * 只在各自工作区的 `.artex/tasks` 里；视图侧从会话头拿到 cwd 后传进来，
     * 列表才不会漏任务。
     */
    async listTasks({ sessionId, cwd, limit = MAX_LIST_LIMIT } = {}) {
      if (sessionId === undefined || sessionId === null || sessionId === '') return []
      const out = []
      const seen = new Set()

      // 1) 内存 runtime 优先：它一定比 task.json 新（含刚结束未回收的 runtime）。
      for (const [taskId, rt] of engine.tasks) {
        const task = rt?.task
        if (!task || !sameSession(task.ownerSession, sessionId)) continue
        const id = String(task.id ?? taskId)
        seen.add(id)
        const live = rt.finished !== true
        out.push({ task, live, settling: live && rt.settling === true })
      }

      // 2) 磁盘索引：只读 task.json 元数据，不加载 facts/findings JSONL。
      await engine.index.load()
      const items = engine.index.items && typeof engine.index.items === 'object' ? engine.index.items : {}
      const diskCandidates = Object.entries(items)
        .filter(([taskId, entry]) => {
          if (!entry || seen.has(String(taskId)) || !isValidTaskId(taskId)) return false
          // 旧索引条目没有 ownerSession：先读快照元数据，再按快照里的 ownerSession 过滤
          // （与 tools/control.js 处理旧索引的方式一致）。
          if (entry.ownerSession === undefined || entry.ownerSession === null) return true
          return sameSession(entry.ownerSession, sessionId)
        })
      const metas = await Promise.all(diskCandidates.map(([taskId, entry]) => loadDiskMeta(engine, taskId, entry.cwd)))
      for (let i = 0; i < diskCandidates.length; i += 1) {
        const [taskId] = diskCandidates[i]
        const meta = metas[i]
        if (!meta) continue
        // 索引信息可能过期：以快照里的 ownerSession 为准再做一次过滤。
        if (!sameSession(meta.ownerSession, sessionId)) continue
        seen.add(String(taskId))
        out.push({ task: meta, live: false, settling: false })
      }

      // 3) 显式 cwd：扫该工作区 .artex/tasks。全局索引可能缺旧任务（索引被重建、
      //    bench 用自定义 indexPath 等），只靠索引会少列一半。
      if (typeof cwd === 'string' && cwd.trim() !== '') {
        const root = cwd.trim()
        try {
          const store = engine.storeFor(root).tasks
          const ids = await store.ids()
          const scanned = await Promise.all(ids.map(taskId => store.loadMeta(taskId).catch(() => undefined)))
          for (const meta of scanned) {
            if (!meta || !isValidTaskId(String(meta.id)) || seen.has(String(meta.id))) continue
            if (!sameSession(meta.ownerSession, sessionId)) continue
            seen.add(String(meta.id))
            out.push({ task: meta, live: false, settling: false })
          }
        } catch {
          // 目录不存在 / 无权限：忽略这一路来源，列表其余部分照常。
        }
      }

      out.sort((a, b) => {
        const delta = (Number(b.task?.createdAt) || 0) - (Number(a.task?.createdAt) || 0)
        if (delta !== 0) return delta
        return String(b.task?.id ?? '').localeCompare(String(a.task?.id ?? ''))
      })
      return out.slice(0, clampLimit(limit))
    },

    /**
     * 一个任务的完整快照：{ task, resources, resources_total, live, settling }。
     * live 任务直接取 rt.task（含 facts/findings）；否则 engine.loadTask() 合并 JSONL。
     * 不存在 -> throw；无权限 -> throw（allowCrossTaskRead 放行）。
     */
    async taskSnapshot({ taskId, sessionId } = {}) {
      const id = String(taskId ?? '')
      let rt
      let task
      if (isValidTaskId(id)) {
        rt = engine.liveTask(id)
      }
      if (rt) {
        task = rt.task
      } else {
        if (!isValidTaskId(id)) {
          throw new Error(id ? `ARTEX 任务 ${id} 不存在` : 'ARTEX 任务不存在')
        }
        task = await engine.loadTask(id)
        if (!task) throw new Error(`ARTEX 任务 ${id} 不存在`)
      }
      assertReadable(engine, task, sessionId)
      const live = Boolean(rt) && rt.finished !== true
      const settling = live && rt.settling === true
      const resources = await resourcesForTask(engine, task)
      return {
        task,
        resources: resources.related,
        resources_total: resources.total,
        live,
        settling,
      }
    },
  }
}
