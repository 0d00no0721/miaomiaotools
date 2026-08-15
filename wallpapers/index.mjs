// wallpapers Node half：壁纸目录扫描 + 素材托管 + 清单 API。
// 暴露：
//   GET /wallpapers/catalog         → 可播放壁纸清单 JSON
//   GET /wallpapers/media?item=&f= → 托管某 item 的视频/图片/网页资源
//   GET /wallpapers/item?item=     → 托管 web 壁纸的入口 html（供 iframe）
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { CATALOG_PATH, MEDIA_PATH, ITEM_PATH, SCENE_PATH } from './src/routes.mjs'
import { DEFAULT_WALLPAPER_DIR, UNPACKED_DIR_NAME, scanCatalog, contentTypeFor, isSafeRel } from './src/catalog.mjs'
import { parseScene } from './src/scene.mjs'

export { CATALOG_PATH, MEDIA_PATH, ITEM_PATH, SCENE_PATH } from './src/routes.mjs'
export { DEFAULT_WALLPAPER_DIR } from './src/catalog.mjs'

export const name = 'wallpapers'
export const inject = ['webServer']

export function apply(ctx) {
  // ---- 清单 API ----
  ctx.webServer.register({
    kind: 'exact',
    path: CATALOG_PATH,
    handler: (_req, res) => {
      const result = scanCatalog(DEFAULT_WALLPAPER_DIR)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(JSON.stringify(result))
    },
  })

  // ---- 素材托管（视频/图片/网页附属资源）----
  ctx.webServer.register({
    kind: 'exact',
    path: MEDIA_PATH,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const item = url.searchParams.get('item')
      const f = url.searchParams.get('f')
      const respond = (code, msg) => {
        res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(msg)
      }
      if (!item || !isSafeRel(item)) return respond(400, 'bad item')
      if (!f || !isSafeRel(f)) return respond(400, 'bad file')
      const abs = join(DEFAULT_WALLPAPER_DIR, item, f)
      // 二次防御：确保解析后仍在 item 目录内。
      if (!abs.startsWith(join(DEFAULT_WALLPAPER_DIR, item) + sep)
          && abs !== join(DEFAULT_WALLPAPER_DIR, item)) {
        return respond(400, 'bad path')
      }
      try {
        if (!existsSync(abs) || !statSync(abs).isFile()) return respond(404, 'not found')
        const data = readFileSync(abs)
        res.writeHead(200, {
          'content-type': contentTypeFor(f),
          'cache-control': 'no-cache',
        })
        res.end(data)
      } catch {
        respond(404, 'not found')
      }
    },
  })

  // ---- web 壁纸入口 html 托管 ----
  ctx.webServer.register({
    kind: 'exact',
    path: ITEM_PATH,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const item = url.searchParams.get('item')
      const file = url.searchParams.get('file')
      if (!item || !isSafeRel(item)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad item')
        return
      }
      const itemDir = join(DEFAULT_WALLPAPER_DIR, item)
      // 入口文件：优先显式 file 参数，否则读 project.json 的 file，最后兜底 index.html
      let entryRel = file
      if (!entryRel || !isSafeRel(entryRel)) {
        let prjFile = 'index.html'
        try {
          const pj = JSON.parse(readFileSync(join(itemDir, 'project.json'), 'utf8'))
          if (typeof pj?.file === 'string' && isSafeRel(pj.file)) prjFile = pj.file
        } catch {}
        entryRel = prjFile
      }
      const entry = join(itemDir, entryRel)
      try {
        if (!existsSync(entry) || !statSync(entry).isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('no html entry')
          return
        }
        const data = readFileSync(entry)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(data)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    },
  })
// ---- 场景壁纸图层清单（output/<id>/scene.json → 浏览器可近似还原的图层列表）----
    ctx.webServer.register({
      kind: 'exact',
      path: SCENE_PATH,
      handler: (req, res) => {
        const respond = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(obj))
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const item = url.searchParams.get('item')
        if (!item || !isSafeRel(item)) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('bad item')
          return
        }
        const unpackedDir = join(DEFAULT_WALLPAPER_DIR, UNPACKED_DIR_NAME, item)
        const result = parseScene(unpackedDir)
        if (!result.ok) {
          respond(404, { ok: false, error: result.error || 'scene unavailable' })
          return
        }
        respond(200, result)
      },
    })
}