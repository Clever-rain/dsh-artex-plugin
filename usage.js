/**
 * 用量统计：按角色累计 provider usage。
 */


export function recordUsage(engine, rt, role, usage) {
    if (!usage) return
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    if (input === 0 && output === 0) return
    const t = rt.task
    t.usage = t.usage || { input_tokens: 0, output_tokens: 0, calls: 0, by_role: {}, by_intent: {} }
    t.usage.by_role = t.usage.by_role || {}
    t.usage.input_tokens += input
    t.usage.output_tokens += output
    t.usage.calls += 1
    const slot = t.usage.by_role[role.role] || (t.usage.by_role[role.role] = { input_tokens: 0, output_tokens: 0, calls: 0 })
    slot.input_tokens += input
    slot.output_tokens += output
    slot.calls += 1
    // 意图级成本：一条意图花了多少 token 一眼可查（planner 等无 intentId 的按 $role 桶）。
    t.usage.by_intent = t.usage.by_intent || {}
    const bucket = role.intentId ? `#${role.intentId}` : `$${role.role || 'unknown'}`
    const islot = t.usage.by_intent[bucket] || (t.usage.by_intent[bucket] = { input_tokens: 0, output_tokens: 0, calls: 0 })
    islot.input_tokens += input
    islot.output_tokens += output
    islot.calls += 1
  }
