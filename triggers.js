/**
 * 两级过滤（移植自 dsh-superagent 的 admission gate + eval）：
 *
 * 第一级（本模块，确定性、零模型）：schema → 去重 → 模式闸门 → 速率上限 → scope 过滤。
 * 第二级（planner，模型）：准入的 trigger 进 task.triggers（status=pending）并唤醒规划者，
 * 规划者用 artex_add_intent(trigger_id=...) 接单，或 artex_decide_trigger 忽略。
 * 每个 trigger 的终态都落在 task.triggers[].status 上（accepted/ignored/observed/rejected），可审计。
 *
 * trigger_mode 三档（对应 superagent eval 的 off/observe/auto）：
 *   off     —— 触发一律拒收（decision 留档 reason=mode_off）；
 *   observe —— 记录 + 唤醒评估，但不许接单（addIntents 带 trigger_id 会被拒）；
 *   auto    —— 记录 + 唤醒，可接单（默认）。
 */

import { createHash } from 'node:crypto'
import { scopeCheck } from './guard.js'

export const TRIGGER_KINDS = ['issue', 'alert', 'webhook', 'schedule', 'note']
export const TRIGGER_MODES = ['off', 'observe', 'auto']

/** 每任务触发窗口速率上限：10 分钟 20 条（确定性防洪）。 */
export const TRIGGER_RATE_WINDOW_MS = 10 * 60 * 1000
export const TRIGGER_RATE_MAX = 20
/** task.triggers 持久化上限（超出淘汰最旧的已决条目）。 */
export const MAX_TRIGGERS = 200
const MAX_TEXT = 4000

/** 触发去重键：kind+source+text 的内容哈希（轮询重投/抖动不重复接单）。 */
export function triggerKey({ kind, source, text }) {
  return createHash('sha1').update(`${kind}|${source ?? ''}|${text}`).digest('hex').slice(0, 16)
}

/**
 * 第一级准入判定（纯函数，可测）。
 * @param {object} task 任务快照（读 triggerMode/policy/triggers）
 * @param {Array<{kind?, source?, text?, meta?}>} items 待准入触发
 * @param {number} [nowMs] 当前时间（测试注入）
 * @returns {{admitted: object[], decisions: object[]}} admitted 已带上 id/key/status='pending'；
 *   decisions 是本批全部结论（含 admitted 的 receive 记录与 reject 记录）。
 */
export function admitTriggers(task, items, nowMs = Date.now()) {
  const mode = TRIGGER_MODES.includes(task.triggerMode) ? task.triggerMode : 'auto'
  const existing = Array.isArray(task.triggers) ? task.triggers : []
  const knownKeys = new Set(existing.map(t => t.key))
  // 速率窗口计数：只看本任务最近 10 分钟已准入的。
  const recentCount = existing.filter(t => nowMs - Number(t.at) < TRIGGER_RATE_WINDOW_MS).length
  let admittedInBatch = 0
  const admitted = []
  const decisions = []
  let seq = Math.max(0, ...existing.map(t => Number(t.id) || 0))

  for (const raw of items) {
    const kind = String(raw?.kind ?? 'note').trim() || 'note'
    const source = raw?.source == null ? 'manual' : String(raw.source).slice(0, 120)
    const text = String(raw?.text ?? '').trim()
    const meta = raw?.meta && typeof raw.meta === 'object' ? raw.meta : {}
    const reject = (reason) => decisions.push({ kind, source, text: text.slice(0, 80), decision: 'rejected', reason, at: nowMs })

    // 1. schema
    if (!TRIGGER_KINDS.includes(kind)) { reject(`unknown_kind:${kind}`); continue }
    if (!text) { reject('empty_text'); continue }
    if (text.length > MAX_TEXT) { reject(`text_too_long:${text.length}`); continue }
    // 2. 去重
    const key = triggerKey({ kind, source, text })
    if (knownKeys.has(key)) { reject('duplicate'); continue }
    // 3. 模式闸门
    if (mode === 'off') { reject('mode_off'); continue }
    // 4. 速率上限
    if (recentCount + admittedInBatch >= TRIGGER_RATE_MAX) { reject('rate_limited'); continue }
    // 5. scope 过滤：任务声明了 allowedTargets 时，文本里的目标必须在范围内。
    const scope = Array.isArray(task.policy?.allowedTargets) ? task.policy.allowedTargets : []
    if (scope.length > 0) {
      const check = scopeCheck(scope, text)
      if (check.enabled && !check.ok) { reject(`out_of_scope:${String(check.misses[0] ?? '').slice(0, 60)}`); continue }
    }

    seq += 1
    admittedInBatch += 1
    knownKeys.add(key)
    const trigger = {
      id: seq,
      key,
      kind,
      source,
      text,
      meta,
      at: nowMs,
      status: mode === 'observe' ? 'observed' : 'pending',
      decidedAt: mode === 'observe' ? nowMs : null,
      intentId: null,
      reason: mode === 'observe' ? 'observe_mode' : '',
    }
    admitted.push(trigger)
    decisions.push({ id: trigger.id, key, kind, source, text: text.slice(0, 80), decision: trigger.status === 'observed' ? 'observed' : 'admitted', reason: trigger.reason || undefined, at: nowMs })
  }
  return { admitted, decisions }
}

/**
 * 落进任务：追加触发（淘汰最旧已决），返回新增条目。
 * 调用方负责 persist 与（auto 模式的）唤醒。
 */
export function ingestTriggers(task, triggers) {
  task.triggers = Array.isArray(task.triggers) ? task.triggers : []
  task.triggers.push(...triggers)
  if (task.triggers.length > MAX_TRIGGERS) {
    const pending = task.triggers.filter(t => t.status === 'pending')
    const settled = task.triggers.filter(t => t.status !== 'pending').sort((a, b) => b.id - a.id)
    task.triggers = [...pending, ...settled.slice(0, Math.max(0, MAX_TRIGGERS - pending.length))].sort((a, b) => a.id - b.id)
  }
  return triggers
}

/** 接单：pending → accepted，绑定意图。observe 模式拒单（第二级纪律的确定性硬门）。 */
export function acceptTrigger(task, triggerId, intentId) {
  const mode = TRIGGER_MODES.includes(task.triggerMode) ? task.triggerMode : 'auto'
  const trigger = (task.triggers || []).find(t => t.id === Number(triggerId))
  if (!trigger) throw new Error(`trigger #${triggerId} 不存在`)
  if (mode === 'observe' || trigger.status === 'observed') {
    throw new Error(`trigger_mode=observe：只允许研判留档，不允许接单（trigger #${trigger.id}）`)
  }
  if (trigger.status !== 'pending') throw new Error(`trigger #${trigger.id} 已裁决（status=${trigger.status}）`)
  trigger.status = 'accepted'
  trigger.decidedAt = Date.now()
  trigger.intentId = Number(intentId)
  return trigger
}

/** 忽略：pending → ignored（含 observed → ignored 的补裁决）。 */
export function ignoreTrigger(task, triggerId, reason = '') {
  const trigger = (task.triggers || []).find(t => t.id === Number(triggerId))
  if (!trigger) throw new Error(`trigger #${triggerId} 不存在`)
  if (trigger.status !== 'pending' && trigger.status !== 'observed') {
    throw new Error(`trigger #${trigger.id} 已裁决（status=${trigger.status}）`)
  }
  trigger.status = 'ignored'
  trigger.decidedAt = Date.now()
  trigger.reason = String(reason || '').slice(0, 200)
  return trigger
}

/** 规划者视角的待决清单（渲染进每轮提示）。 */
export function pendingTriggers(task) {
  return (task.triggers || []).filter(t => t.status === 'pending')
}
