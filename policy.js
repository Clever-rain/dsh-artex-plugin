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
  'artex_resume_task',
  'artex_graph_overview',
  'artex_node_detail',
  'artex_trace',
  'artex_add_intent',
  'artex_promote_intent',
  'artex_set_brief',
  'artex_prove_goal',
  'artex_set_todos',
  'artex_plan',
  'artex_record_fact',
  'artex_report_finding',
  'artex_add_resource',
  'artex_set_analysis',
  'artex_record_conflict',
  'artex_retract_fact',
  'artex_retest_finding',
  'artex_coverage_report',
]

/** 每个角色允许调用的 artex 工具（读工具可被多个角色共享）。 */
export const ROLE_ALLOW = {
  planner: [
    'artex_graph_overview', 'artex_node_detail', 'artex_trace',
    'artex_set_brief', 'artex_add_intent', 'artex_promote_intent',
    'artex_prove_goal', 'artex_set_todos', 'artex_plan',
    'artex_retract_fact', 'artex_coverage_report', 'artex_retest_finding',
  ],
  worker: [
    'artex_graph_overview', 'artex_node_detail', 'artex_trace',
    'artex_record_fact', 'artex_report_finding', 'artex_add_resource',
    'artex_record_conflict', 'artex_coverage_report',
  ],
  analyst: [
    'artex_graph_overview', 'artex_node_detail', 'artex_trace',
    'artex_set_analysis', 'artex_record_conflict', 'artex_coverage_report',
  ],
  // 独立验证者：只验证单条 finding，不参与规划（P1-8：防止角色膨胀）。
  verifier: [
    'artex_graph_overview', 'artex_node_detail', 'artex_trace',
    'artex_record_fact', 'artex_retest_finding', 'artex_coverage_report',
  ],
}

/** 该角色应被 toolFilter 收掉的工具（只列 artex_*，内置工具不受影响）。 */
export function denyForRole(role, toolNames = TOOL_NAMES) {
  const allow = new Set(ROLE_ALLOW[role] || [])
  return toolNames.filter(name => !allow.has(name))
}

/**
 * 任务级沙箱策略落成工具的 deny 名（P0-4）。
 * 已知写/执行类宿主工具名：各 Harness profile 不完全一致，收掉不存在的名字是无害 no-op，
 * 主作用是把确定性边界写进 spawn 的 toolFilter，而不是只写进提示词。
 * read_only、allowed_tools 任一开启即生效；allowed_tools 在白名单里优先级高于 read_only 收名单。
 */
export const HOST_WRITE_TOOL_NAMES = [
  'pwsh', 'bash', 'edit', 'write', 'read', // read 保留对但有命名歧义——从 deny 列表独立处理
  'terminal_open', 'terminal_send', 'terminal_close', 'terminal_signal',
  'workflow', 'ralph', 'subagent', 'subagent_fork', 'spawn_teammate',
  'plugin_manager', 'plugin_market', 'create_worktree', 'working_directory',
  'team_task_create', 'team_task_update', 'team_task_get', 'send_message', 'interrupt_agent',
  'schedule_create', 'schedule_update', 'schedule_delete', 'record_goal', 'create_goal', 'update_goal',
  'present', 'job_kill',
]

/** 计算任务策略 toolFilter deny：read_only/allowed_tools 之外的写类宿主工具；artex_* 走角色白名单。 */
export function policyDenyForTask(policy = {}, role, toolNames = TOOL_NAMES) {
  const denied = new Set(denyForRole(role, toolNames))
  const allow = new Set((policy.allowedTools || []).map(n => String(n).trim()).filter(Boolean))
  if (policy.readOnly === true) {
    for (const name of HOST_WRITE_TOOL_NAMES) {
      if (name === 'read') continue // 读 API 绝不能被收口
      if (!allow.has(name)) denied.add(name)
    }
  }
  if (allow.size > 0) {
    // 精确白名单：白名单之外的已知写/执行宿主工具一并收掉。
    for (const name of HOST_WRITE_TOOL_NAMES) {
      if (name === 'read') continue
      if (!allow.has(name)) denied.add(name)
    }
  }
  return [...denied]
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
  const expectedOwnerOnly = ['artex_run_task', 'artex_start_task', 'artex_task_status', 'artex_stop_task', 'artex_add_hint', 'artex_resume_task']
  if (ownerOnly.length !== expectedOwnerOnly.length || expectedOwnerOnly.some(n => !ownerOnly.includes(n))) {
    throw new Error(`owner-only 工具集合变化：${ownerOnly.join(', ')}`)
  }
  return { assigned: assigned.size, ownerOnly }
}
