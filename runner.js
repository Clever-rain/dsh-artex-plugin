/**
 * 子会话执行器：spawn 子会话、等待结果、中断、续跑提示。
 */

import { mkdir } from 'node:fs/promises'
import { settlePrompt } from './prompts.js'
import { sleep, textOf } from './util.js'

export function interruptChildren(engine, rt) {
    for (const childId of rt.children.values()) engine.interruptChild(rt, childId)
  }

export function interruptChild(engine, rt, childId) {
    try {
      engine.subagents.interrupt(childId, { kind: 'ancestor', agent: rt.ownerAgent })
    } catch (error) {
      engine.logger.warn?.(`[artex] interrupt ${childId} failed: ${error?.message || error}`)
    }
  }

  /* ------------------------------------------------------------------ loop */

export async function runChild(engine, rt, spec) {
    const parent = rt.ownerAgent
    const controller = new AbortController()
    const onAbort = () => {
      try { controller.abort(rt.abort.signal.reason) } catch { /* ignore */ }
    }
    rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    let activation
    try {
      if (spec.cwd) await mkdir(spec.cwd, { recursive: true }).catch(() => undefined)
      // 角色 deny ∪ 任务级策略（read_only/allowed_tools）deny：spawn 落地真实边界。
      const deny = spec.deny ?? engine.denyForTask(rt.task, spec.role)
      const request = {
        prompt: [{ type: 'text', text: spec.prompt }],
        parent,
        ...spec.cwd ? { cwd: spec.cwd } : {},
        ...deny.length > 0 ? { toolFilter: { deny } } : {},
      }
      activation = await engine.subagents.startActivation({
        provider: engine.providerName,
        label: spec.label,
        request,
        signal: controller.signal,
        delivery: 'caller',
      })
    } catch (error) {
      rt.abort.signal.removeEventListener('abort', onAbort)
      throw new Error(`启动 ${spec.role} 子会话失败：${error?.message || error}`)
    }
    const childId = activation.childId
    const role = {
      taskId: rt.task.id,
      role: spec.role,
      kind: spec.kind || null,
      intentId: spec.intentId ?? null,
      writes: { facts: 0, findings: 0, resources: 0, outcomes: { found: 0, none: 0, inconclusive: 0, blueprint: 0 } },
      pending: new Map(),
    }
    engine.roles.set(childId, role)
    if (spec.key) rt.children.set(spec.key, childId)
    try {
      return await engine.awaitChild(rt, activation, spec, role)
    } finally {
      if (spec.key) rt.children.delete(spec.key)
      engine.roles.delete(childId)
      rt.abort.signal.removeEventListener('abort', onAbort)
    }
  }

export async function awaitChild(engine, rt, activation, spec, role) {
    const settled = activation.result.then(
      result => ({ kind: 'settled', result }),
      error => ({ kind: 'settled', result: { output: [], stopReason: 'error', diagnostic: String(error?.message || error) } }),
    )
    const timeoutMs = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : 0
    const first = await Promise.race([
      settled,
      timeoutMs > 0 ? engine.abortOrTimeout(rt, timeoutMs) : engine.abortOnly(rt),
    ])

    if (first.kind === 'settled') return engine.outcome(first.result, role, false)

    if (first.kind === 'abort') {
      engine.interruptChild(rt, activation.childId)
      const after = await Promise.race([settled, sleep(15000).then(() => ({ kind: 'hard' }))])
      if (after.kind === 'settled') return engine.outcome(after.result, role, true)
      void activation.dispose().catch(() => undefined)
      return engine.outcome({ output: [], stopReason: 'aborted' }, role, true)
    }

    // 墙钟预算耗尽：先给收尾机会（ARTEX settlement），宽限期后再硬停。
    await engine.nudge(rt, activation.childId, settlePrompt(role.role, role.kind))
    const grace = Number(rt.task.limits.settleGraceMs) || 0
    const graced = await Promise.race([settled, sleep(grace > 0 ? grace : 0).then(() => ({ kind: 'grace' }))])
    if (graced.kind === 'settled') return engine.outcome(graced.result, role, true)
    engine.interruptChild(rt, activation.childId)
    const hard = await Promise.race([settled, sleep(30000).then(() => ({ kind: 'hard' }))])
    if (hard.kind === 'settled') return engine.outcome(hard.result, role, true)
    void activation.dispose().catch(() => undefined)
    return engine.outcome({ output: [], stopReason: 'timeout' }, role, true)
  }

export function outcome(engine, result, role, timedOut) {
    return {
      text: textOf(result?.output),
      stopReason: result?.stopReason || 'completed',
      timedOut,
      writes: { ...role.writes, outcomes: { ...role.writes.outcomes } },
    }
  }

export function abortOnly(engine, rt) {
    return new Promise((resolve) => {
      if (rt.abort.signal.aborted) return resolve({ kind: 'abort' })
      const onAbort = () => {
        rt.abort.signal.removeEventListener('abort', onAbort)
        resolve({ kind: 'abort' })
      }
      rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

export function abortOrTimeout(engine, rt, ms) {
    return new Promise((resolve) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        rt.abort.signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish({ kind: 'abort' })
      const timer = setTimeout(() => finish({ kind: 'timeout' }), ms)
      timer.unref?.()
      if (rt.abort.signal.aborted) return finish({ kind: 'abort' })
      rt.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

export async function nudge(engine, rt, childId, text) {
    try {
      await engine.subagents.sendMessage(
        rt.ownerAgent,
        childId,
        [{ type: 'text', text }],
        { signal: new AbortController().signal },
      )
    } catch (error) {
      engine.logger.warn?.(`[artex] steer ${childId} failed: ${error?.message || error}`)
    }
  }

  /* ----------------------------------------------------------- event queue */
