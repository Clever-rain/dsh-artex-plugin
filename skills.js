/**
 * 技能包（skill packs）：任务级声明加载的"打法 + 工具面"模块。
 *
 * 设计来源：Phantom 的 32 个 MCP 服务器证明了"能力模块化 + 标准接口"的
 * 扩展威力；合法化改造的关键纪律是——技能包只封装**打法指导与工具白名单**，
 * 不内置任何攻击载荷（弹药解耦不动摇）。
 *
 * 解析顺序：内置包 → ${cwd}/.artex/skills/<name>.json（用户自定义，同名字段覆盖内置）。
 * 用户包形状：{ "name": "...", "prompt": "打法指导（注入 worker 提示词）", "tools": ["宿主工具白名单"] }
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GRAPH_DIR } from './store.js'

/** 内置技能包：只给打法与工具面，不给载荷。 */
export const BUILTIN_SKILL_PACKS = {
  recon: {
    name: 'recon',
    description: '资产侦察打法：被动优先、由面到点、全程记录来源。',
    prompt: `## 技能包：recon（资产侦察）
- 顺序：被动信息（证书透明度/DNS/公开索引）→ 主动探测（端口/指纹）→ 攻击面归纳。
- 每个资产都要登记 artex_add_resource（host/service/domain），来源与命令写进 fact 的 evidence。
- 未授权的第三方便携数据（公开 breach 库等）只看元数据，不下载内容。`,
    tools: [],
  },
  'web-audit': {
    name: 'web-audit',
    description: 'Web 漏洞审计打法：端点面枚举→类目逐项验证→证据固定，配 audit 模式。',
    prompt: `## 技能包：web-audit（Web 审计）
- 先枚举端点面（路由/参数/方法），再按类目逐项验证（注入/鉴权/SSRF/文件包含/反序列化……）。
- 逐项验证用 enumerate 意图：命中 outcome=found，未命中 outcome=none（写清方法与响应）。
- 每个 finding 必须给可复现 evidence：请求/响应原文、payload、截图或日志路径；
  有过程步骤与工件时用 evidence_refs 绑定（steps / artifacts）。`,
    tools: [],
  },
  report: {
    name: 'report',
    description: '报告产出打法：证据链组织、定级口径、脱敏复核。',
    prompt: `## 技能包：report（报告产出）
- finding 按 severity 分层描述：影响、复现步骤、证据位置（evidence_refs）、修复建议。
- 交付前复核：证据是否含未脱敏凭据（引擎已自动脱敏，人工再核一遍）、负结果是否已解释。`,
    tools: [],
  },
}

/**
 * 解析技能包列表：内置 + 工作区自定义文件。找不到的包抛错（启动即失败，不静默降级）。
 * @returns {Promise<Array<{name:string, description:string, prompt:string, tools:string[]}>>}
 */
export async function loadSkillPacks(cwd, names) {
  const out = []
  for (const rawName of Array.isArray(names) ? names : []) {
    const name = String(rawName ?? '').trim()
    if (!name) continue
    let pack = BUILTIN_SKILL_PACKS[name]
    if (!pack) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
        throw new Error(`技能包名非法：${name}（内置包：${Object.keys(BUILTIN_SKILL_PACKS).join(' / ')}；自定义请用字母数字与 -_）`)
      }
      const path = join(cwd, GRAPH_DIR, 'skills', `${name}.json`)
      let raw
      try {
        raw = JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error(`技能包 ${name} 不存在：既不是内置包（${Object.keys(BUILTIN_SKILL_PACKS).join(' / ')}），也没有 ${path}`)
        }
        throw new Error(`技能包 ${name} 读取失败：${error?.message || error}`)
      }
      pack = { name, description: String(raw.description || ''), prompt: String(raw.prompt || ''), tools: raw.tools }
    }
    out.push({
      name: pack.name,
      description: String(pack.description || ''),
      prompt: String(pack.prompt || ''),
      tools: [...new Set((Array.isArray(pack.tools) ? pack.tools : []).map(t => String(t).trim()).filter(Boolean))],
    })
  }
  return out
}
