// wallpapers Node half：壁纸目录扫描 + 素材托管 + 清单 API。
// 暴露：
//   GET /wallpapers/catalog         → 可播放壁纸清单 JSON
//   GET /wallpapers/media?item=&f= → 托管某 item 的视频/图片/网页资源
//   GET /wallpapers/item?item=     → 托管 web 壁纸的入口 html（供 iframe）
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { CATALOG_PATH, MEDIA_PATH, ITEM_PATH, SCENE_PATH, SCENE_AUDIO_PATH } from './src/routes.mjs'
import { DEFAULT_WALLPAPER_DIR, UNPACKED_DIR_NAME, scanCatalog, contentTypeFor, isSafeRel } from './src/catalog.mjs'
import { parseScene } from './src/scene.mjs'
/**
 * 解析 HTTP Range 头（格式 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`）。
 * 返回：{ start, end } —— 合法区间（已 clamp 到 [0, size-1]）；
 *       null —— 无 Range 头（整文件）；
 *       -1 —— 非法/不满足（调用方返回 416）。
 */
function parseRange(rangeHeader, size) {
  if (typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=')) return null
  const spec = rangeHeader.slice('bytes='.length).trim()
  if (spec === '') return -1
  const parts = spec.split(',')
  if (parts.length !== 1) return -1 // 只支持单段，多段直接回退整文件亦可；这里拒绝
  const m = /^(\d*)-(\d*)$/.exec(parts[0])
  if (!m) return -1
  const [, a, b] = m
  let start, end
  if (a === '' && b === '') return -1
  if (a === '') {
    // bytes=-N：末尾 N 字节
    const suffix = Number(b)
    if (!Number.isFinite(suffix) || suffix <= 0) return -1
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    if (!Number.isFinite(start) || start < 0) return -1
    if (b === '') {
      end = size - 1
    } else {
      end = Number(b)
      if (!Number.isFinite(end)) return -1
    }
    if (start > end) return -1
    end = Math.min(end, size - 1)
  }
  if (start >= size || size <= 0) return -1 // 越界
  return { start, end }
}

export { CATALOG_PATH, MEDIA_PATH, ITEM_PATH, SCENE_PATH, SCENE_AUDIO_PATH } from './src/routes.mjs'
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
        const stat = statSync(abs)
          const size = stat.size
          const type = contentTypeFor(f)
          const range = parseRange(req.headers.range, size)
          if (range === -1) {
            res.writeHead(416, { 'content-range': `bytes */${size}` })
            res.end()
            return
          }
          if (range === null) {
            res.writeHead(200, {
              'content-type': type,
              'content-length': size,
              'accept-ranges': 'bytes',
              'cache-control': 'no-cache',
            })
            createReadStream(abs).on('error', () => { if (!res.headersSent) res.writeHead(500); res.end() }).pipe(res)
            return
          }
          res.writeHead(206, {
            'content-type': type,
            'content-range': `bytes ${range.start}-${range.end}/${size}`,
            'content-length': range.end - range.start + 1,
            'accept-ranges': 'bytes',
            'cache-control': 'no-cache',
          })
          createReadStream(abs, { start: range.start, end: range.end }).on('error', () => { if (!res.headersSent) res.writeHead(500); res.end() }).pipe(res)
          return
/* 以下为旧「整文件 readFileSync + res.end(data)」实现，已被上方 Range 分支取代。
          保留为注释以免遗留未定义的 data 引用；不要再次启用（大视频需流式 + Range）。
        res.writeHead(200, {
          
          'cache-control': 'no-cache',
        })
        res.end(data)
*/
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

  // ---- 场景音频托管（限定 output/<id>/sounds/<file>，杜绝目录穿越）----
    ctx.webServer.register({
      kind: 'exact',
      path: SCENE_AUDIO_PATH,
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const item = url.searchParams.get('item')
        const f = url.searchParams.get('f')
        const respond = (code, msg) => {
          res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(msg)
        }
        // item 必须是单个安全段（craftId）；f 必须是单个安全段（且不能含路径分隔符）
        if (!item || !isSafeRel(item)) return respond(400, 'bad item')
        if (!f || !isSafeRel(f)) return respond(400, 'bad file')
        const soundsDir = join(DEFAULT_WALLPAPER_DIR, UNPACKED_DIR_NAME, item, 'sounds')
        // 二次防御：f 必须是站内 basename，解析后必须仍在 soundsDir 内。
        const abs = join(soundsDir, f)
        if (!abs.startsWith(soundsDir + sep)) return respond(400, 'bad path')
        try {
          if (!existsSync(abs) || !statSync(abs).isFile()) return respond(404, 'not found')
          const stat = statSync(abs)
          const size = stat.size
          const type = contentTypeFor(f)
          const range = parseRange(req.headers.range, size)
          if (range === -1) {
            res.writeHead(416, { 'content-range': `bytes */${size}` })
            res.end()
            return
          }
          if (range === null) {
            res.writeHead(200, {
              'content-type': type,
              'content-length': size,
              'accept-ranges': 'bytes',
              'cache-control': 'no-cache',
            })
            createReadStream(abs).on('error', () => { if (!res.headersSent) res.writeHead(500); res.end() }).pipe(res)
            return
          }
          res.writeHead(206, {
            'content-type': type,
            'content-range': `bytes ${range.start}-${range.end}/${size}`,
            'content-length': range.end - range.start + 1,
            'accept-ranges': 'bytes',
            'cache-control': 'no-cache',
          })
          createReadStream(abs, { start: range.start, end: range.end }).on('error', () => { if (!res.headersSent) res.writeHead(500); res.end() }).pipe(res)
        } catch {
          respond(404, 'not found')
        }
      },
    })
}