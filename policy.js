/**
 * 角色工具策略：单一事实来源。
 *
 * 之前 engine 里三份 *_DENY 常量硬编码了 31 处工具名，新增工具要改三处且容易漏。
 * 现在只维护"每个角色允许哪些 artex 工具"，deny 列表由注册到的工具名自动推导；
 * 控制类工具（run/start/stop/status/hint）只给所有者，不出现在角色白名单里。
 */

/** 全量工具名（与 tools.js 的注册必须一致，测试会校验）。 */
export const TOOL_NAMES = [
  'artex_run_task',
  'artex_start_task',
  'artex_task_status',
  'artex_stop_task',
  'artex_add_hint',
  'artex_graph_overview',
  'artex_node_detail',
  'artex_trace',
  'artex_add_intent',
  'artex_promote_intent',
  'artex_set_brief',
  'artex_prove_goal',
  'artex_set_todos',
  'artex_record_fact',
  'artex_report_finding',
  'artex_add_resource',
  'artex_set_analysis',
]

/** 每个角色允许调用的 artex 工具（读工具可被多个角色共享）。 */
export const ROLE_ALLOW = {
  planner: [
    'artex_graph_overview', 'artex_node_detail', 'artex_trace',
    'artex_set_brief', 'artex_add_intent', 'artex_promote_intent',
    'artex_prove_goal', 'artex_set_todos',
  ],
  worker: [
    'artex_graph_overview', 'artex_node_detail', 'artex_trace',
    'artex_record_fact', 'artex_report_finding', 'artex_add_resource',
  ],
  analyst: [
    'artex_graph_overview', 'artex_node_detail', 'artex_trace',
    'artex_set_analysis',
  ],
}

/** 该角色应被 toolFilter 收掉的工具（只列 artex_*，内置工具不受影响）。 */
export function denyForRole(role, toolNames = TOOL_NAMES) {
  const allow = new Set(ROLE_ALLOW[role] || [])
  return toolNames.filter(name => !allow.has(name))
}

/**
 * 一致性校验：TOOL_NAMES 与真实注册的工具名一致；角色白名单引用的工具都存在；
 * 每个工具要么属于某个角色，要么是 owner-only 控制工具。
 */
export function assertPolicyCoverage(toolNames) {
  const known = new Set(toolNames)
  if (TOOL_NAMES.length !== toolNames.length || TOOL_NAMES.some(n => !known.has(n))) {
    throw new Error(`policy.TOOL_NAMES 与注册工具不一致：policy=${TOOL_NAMES.length}, actual=${toolNames.length}`)
  }
  const assigned = new Set()
  for (const [role, list] of Object.entries(ROLE_ALLOW)) {
    for (const name of list) {
      if (!known.has(name)) throw new Error(`角色 ${role} 引用了不存在的工具 ${name}`)
      assigned.add(name)
    }
  }
  const ownerOnly = toolNames.filter(n => !assigned.has(n))
  const expectedOwnerOnly = ['artex_run_task', 'artex_start_task', 'artex_task_status', 'artex_stop_task', 'artex_add_hint']
  if (ownerOnly.length !== expectedOwnerOnly.length || expectedOwnerOnly.some(n => !ownerOnly.includes(n))) {
    throw new Error(`owner-only 工具集合变化：${ownerOnly.join(', ')}`)
  }
  return { assigned: assigned.size, ownerOnly }
}
