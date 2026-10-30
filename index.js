/**
 * DSH × ARTEX：把 ARTEX 的「双图 + planner/worker 事件驱动编排」搬进 DSH。
 *
 * 入口只做三件事：建立引擎、注册工具、把子会话事件喂给引擎做过程索引。
 * 真正的编排逻辑在 engine.js，图模型在 graph.js，角色纪律在 prompts.js。
 */

import { dirname, join } from 'node:path'

import { ArtexEngine } from './engine.js'
import { createTools } from './tools.js'
import { createViewApi } from './view-api.js'
import { artexGateReason, createSessionFlags } from './flags.js'
import { createArtexCommand } from './command.js'
import { createArtexHttpDispatch } from './http-api.js'

export const name = 'artex-orchestration'

/** Host 硬依赖：工具注册表 + 子会话（spawn/fork provider）。 */
export const inject = ['tools', 'subagents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config 插件行配置（见 cordis.patch.yml）
 */
export function apply(ctx, config = {}) {
  const logger = (() => {
    const target = ctx.logger ?? console
    return {
      warn: (...args) => {
        try {
          target.warn(...args)
        } catch {
          // 日志失败不影响编排。
        }
      },
    }
  })()

  const engine = new ArtexEngine({
    ctx,
    config: config || {},
    logger,
  })

  // 会话级启用开关（/artex off、composer chip 共用）：profile 级 JSON，与全局任务索引同目录。
  const flags = createSessionFlags({
    filePath: join(dirname(engine.index.path), 'artex-session-flags.json'),
    logger,
  })
  engine.flags = flags

  // 只读视图服务与 /api/artex 共用同一个实例（createViewApi 纯读，无副作用）。
  const viewApi = createViewApi(engine)

  // 软门禁：本会话 /artex off 后，该会话发起的 artex_* 调用一律在这里被拒。
  // 运行中任务的子会话有自己的会话 id（默认开），不受影响。
  ctx.effect(() => ctx.tools.guard(execution => artexGateReason(
    execution?.name,
    execution?.agent?.id !== undefined ? flags.isEnabled(String(execution.agent.id)) : true,
  )))

  // 人类命令 /artex on|off|status：命令行进会话日志（command/run 含参数），即切换的可见标记。
  ctx.effect(() => {
    const commands = ctx.get?.('commands')
    if (!commands || typeof commands.register !== 'function') return undefined
    return commands.register(createArtexCommand({ engine, flags }))
  })

  // 浏览器半边的数据通道：/api/artex（开关 chip + 会话行徽章轮询 state、点按 setEnabled）。
  ctx.effect(() => {
    const webServer = ctx.get?.('webServer')
    if (!webServer || typeof webServer.register !== 'function') return undefined
    const dispatch = createArtexHttpDispatch({ viewApi, flags })
    return webServer.register({
      kind: 'exact',
      path: '/api/artex',
      handler: (req, res) => void handleArtexRequest(req, res, dispatch),
    })
  })

  // 工具是全局注册的；角色边界由 execute 内的会话身份校验 + 子会话 toolFilter 双重保证。
  ctx.effect(() => {
    const definitions = createTools({ engine, config: engine.config })
    engine.setToolNames(definitions.map(definition => definition.name))
    const disposers = definitions.map(definition => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 单个工具注销失败不阻断其余清理。
        }
      }
    }
  })

  // 只读 Host Service：供视图插件（@local/dsh-artex-view 等）读取任务列表与快照。
  // ctx.provide 返回 disposer，放进 ctx.effect 由 Cordis 在插件卸载时自动撤销服务。
  ctx.effect(() => ctx.provide('artex', viewApi))

  // 把 worker 子会话的 tool/call、tool/result、assistant/message 索引成过程库，
  // 这样别的 work 能按关键字回看执行过程（ARTEX activity + trace 检索）。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    engine.handleSessionEvent(session, event)
  }))

  // 所有者会话关闭时停掉它启动的任务，避免无主任务继续烧模型调用。
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    void engine.onAgentDisposed(agent)
  }))

  // 插件卸载：中断所有任务并等待收敛；开关落盘的待写防抖也冲掉。
  ctx.effect(() => () => {
    flags.flush()
    void engine.dispose()
  })
}

/* ------------------------------------------------------------------ /api/artex 的 HTTP 壳
 * 与 @local/dsh-artex-view 同一套：POST only、只收本机回环来源、body ≤ 1 MB；
 * 业务派发是纯函数 createArtexHttpDispatch（可测），这里只做传输层。 */

const MAX_API_BODY = 1024 * 1024

async function handleArtexRequest(req, res, dispatch) {
  try {
    if (req.method !== 'POST') return sendApiJson(res, 405, { ok: false, error: 'POST only' })
    if (!apiOriginAllowed(req)) return sendApiJson(res, 403, { ok: false, error: 'forbidden origin' })
    const body = await readApiBody(req)
    const reply = await dispatch(body)
    return sendApiJson(res, 200, reply)
  } catch (error) {
    return sendApiJson(res, 200, { ok: false, error: String(error?.message ?? error) })
  }
}

function readApiBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_API_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error(`invalid json: ${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

/** 只接受本机回环来源；桌面端 Origin 常为 app:// 或缺失，一并放行。 */
function apiOriginAllowed(req) {
  const remote = req.socket?.remoteAddress ? String(req.socket.remoteAddress) : ''
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '' || origin === 'null') return true
  if (typeof origin === 'string' && /^app:/i.test(origin)) return true
  try {
    if (new URL(origin).host === host) return true
  } catch {
    /* fall through */
  }
  return false
}

function sendApiJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}
