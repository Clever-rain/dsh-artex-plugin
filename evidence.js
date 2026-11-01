/**
 * finding ↔ 原始证据绑定：工件哈希与步骤校验。
 *
 * 目的：finding 的 evidence 不再只是自由文本——可以锚定
 * 过程库步骤（activity id）与磁盘工件（含 sha256），
 * prove_goal / retest / 报告时可下钻到"哪一步、哪个文件"得出该结论。
 */

import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/** 单工件哈希读取上限：更大的文件只给大小不给哈希（避免为算哈希读爆内存）。 */
const MAX_HASH_BYTES = 64 * 1024 * 1024

/**
 * 校验并固化工件引用。
 * @param {string} cwd 任务工作区（工件必须落在 cwd 之内，防任意路径读取）
 * @param {Array<{path:string, note?:string}>} artifacts
 * @returns {Promise<Array<{path:string, note:string, sha256?:string, bytes:number}>>}
 */
export async function bindArtifacts(cwd, artifacts) {
  const out = []
  const root = resolve(cwd)
  for (const item of Array.isArray(artifacts) ? artifacts : []) {
    const rawPath = String(item?.path ?? '').trim()
    if (!rawPath) throw new Error('evidence_refs.artifacts[].path 不能为空')
    const abs = resolve(root, rawPath)
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`evidence_refs 工件必须位于任务工作区内：${rawPath}`)
    }
    const info = await stat(abs).catch(() => undefined)
    if (!info || !info.isFile()) {
      throw new Error(`evidence_refs 工件不存在或不是文件：${rawPath}`)
    }
    const entry = {
      path: rawPath,
      note: item?.note ? String(item.note).slice(0, 200) : '',
      bytes: info.size,
    }
    if (info.size <= MAX_HASH_BYTES) {
      const hash = createHash('sha256')
      const handle = await open(abs, 'r')
      try {
        const buffer = Buffer.alloc(info.size)
        await handle.read(buffer, 0, info.size, 0)
        hash.update(buffer)
      } finally {
        await handle.close().catch(() => undefined)
      }
      entry.sha256 = hash.digest('hex')
    } else {
      entry.sha256 = undefined
      entry.note = `${entry.note}${entry.note ? ' ' : ''}(超过 64MB，未计算哈希)`
    }
    out.push(entry)
  }
  return out
}

/**
 * 校验步骤引用：activity id 必须真实存在于本任务过程库。
 * @returns {number[]} 归一化后的步骤 id
 */
export function bindSteps(task, steps) {
  const ids = [...new Set((Array.isArray(steps) ? steps : []).map(Number).filter(n => Number.isFinite(n) && n > 0))]
  if (ids.length === 0) return []
  const existing = new Set((Array.isArray(task.activities) ? task.activities : []).map(a => Number(a.id)))
  const missing = ids.filter(id => !existing.has(id))
  if (missing.length > 0) {
    throw new Error(`evidence_refs.steps 引用了不存在的过程步骤：${missing.map(id => `#${id}`).join(' ')}（用 artex_trace 查本任务的 step_id）`)
  }
  return ids
}
