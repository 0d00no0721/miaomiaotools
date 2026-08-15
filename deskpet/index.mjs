// deskpet Node half：静态素材服务 + 最小活动信号（供 client 感知「思考中/回合完成」）。
// 精简形态：不做积累账本 / 成长体系 / 状态持久化；宠物状态与交互全在 client 本地。
// 只暴露：
//   - GET /deskpet/assets/**  静态 sprite sheet + manifest 服务
//   - GET /deskpet/state       最小活动快照 { anyActive, celebrateUntil }
// 活动信号在 /state 处理器内按「当前 agent 是否 running」实时计算（client 每 2s 轮询，
// 无需监听 scoped 的 agent/status 事件）：running→idle 翻转时置 celebrateUntil 窗口。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSETS_PATH, sanitizeAssetPath, contentTypeFor } from './src/assets.mjs'
import { STATE_PATH } from './src/routes.mjs'

export { ASSETS_PATH } from './src/assets.mjs'
export { STATE_PATH } from './src/routes.mjs'

export const name = 'deskpet'
export const inject = ['webServer', 'agents']

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(__dirname, 'assets')

/** 回合完成庆祝窗口（ms）。 */
const CELEBRATE_MS = 4000

export function apply(ctx) {
  // 上一轮 /state 的 anyActive；用于检测 running→idle 翻转（回合完成）。
  let prevAnyActive = false
  let celebrateUntil = 0

  // 静态素材路由：/deskpet/assets/** → assets/ 目录，路径净化防目录穿越。
  ctx.webServer.register({
    kind: 'prefix',
    path: ASSETS_PATH,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const rel = sanitizeAssetPath(url.pathname)
      if (rel === null) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad path')
        return
      }
      try {
        const data = readFileSync(join(ASSETS_DIR, rel))
        res.writeHead(200, { 'content-type': contentTypeFor(rel), 'cache-control': 'no-cache' })
        res.end(data)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    },
  })

  // 最小活动快照路由：计算 anyActive，并在 running→idle 翻转时置庆祝窗口。
  ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (_req, res) => {
      const anyActive = ctx.agents.list().some((a) => a.status === 'running')
      if (prevAnyActive && !anyActive) celebrateUntil = Date.now() + CELEBRATE_MS
      prevAnyActive = anyActive
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        anyActive,
        celebrateUntil: Math.max(0, celebrateUntil - Date.now()),
      }))
    },
  })
}