// 壁纸目录扫描：解析 Wallpaper Engine 创意工坊目录（project.json）为可播放清单。
// 纯 Node，零依赖；只读本地目录。可播放类型：
//   video/Video → 单个 .mp4（浏览器 <video> 直接播放）
//   web/Web    → 已弃用（用户拍板），归入 unsupported，不进入可播放列表
//   scene/Scene → 已弃用（用户拍板），归入 unsupported，不进入可播放列表
// 其余（preset 依赖型、dxs 骨骼动画）暂不支持，仅作占位/提示列出。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 默认壁纸根目录（可被 env DSH_WALLPAPERS_DIR 覆盖）。 */
export const DEFAULT_WALLPAPER_DIR =
  process.env.DSH_WALLPAPERS_DIR || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960'

/** 场景型壁纸（.pkg）解包目录名（相对壁纸根目录）。由 repkg extract 生成。 */
export const UNPACKED_DIR_NAME = 'output'

/** 解析单个 item 的 project.json，返回 { type, title, file, preview, titleRaw }。 */
function readProject(itemDir) {
  const pjPath = join(itemDir, 'project.json')
  if (!existsSync(pjPath)) return null
  let p
  try {
    p = JSON.parse(readFileSync(pjPath, 'utf8'))
  } catch {
    return null
  }
  const type = String(p.type || '').toLowerCase()
  return {
    type,
    title: typeof p.title === 'string' ? p.title : '',
    file: typeof p.file === 'string' ? p.file : '',
    preview: typeof p.preview === 'string' ? p.preview : '',
  }
}

/** 判断一段相对路径是否安全（拒绝 .. / . / 空段 / 反斜杠 / 绝对路径）。 */
export function isSafeRel(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return false
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false
  const segs = rel.split(/[\\/]/)
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false
  }
  return true
}

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv'])

/** 在 item 目录里定位真正的媒体文件（项目声明的 file，或目录里第一个视频）。 */
function locateMedia(itemDir, declaredFile) {
  if (declaredFile && isSafeRel(declaredFile)) {
    const p = join(itemDir, declaredFile)
    if (existsSync(p)) return { relPath: declaredFile, absPath: p }
  }
  // 兜底：目录里第一个视频文件
  let entries = []
  try { entries = readdirSync(itemDir) } catch { return null }
  for (const name of entries) {
    const dot = name.lastIndexOf('.')
    if (dot === -1) continue
    const ext = name.slice(dot).toLowerCase()
    if (VIDEO_EXTS.has(ext)) {
      const p = join(itemDir, name)
      try { if (statSync(p).isFile()) return { relPath: name, absPath: p } } catch {}
    }
  }
  return null
}

/**
 * 扫描壁纸根目录，返回可播放清单条目数组。
 * 每项：{ id, title, kind: 'video'|'web'|'unsupported', file, preview }。
 */
export function scanCatalog(rootDir = DEFAULT_WALLPAPER_DIR) {
  if (!existsSync(rootDir)) return { ok: false, error: `壁纸目录不存在：${rootDir}`, items: [] }
  let childNames = []
  try { childNames = readdirSync(rootDir) } catch (e) { return { ok: false, error: String(e), items: [] } }

  const items = []
  for (const name of childNames) {
    if (name === 'output' || name.startsWith('.')) continue
    const itemDir = join(rootDir, name)
    let st
    try { st = statSync(itemDir) } catch { continue }
    if (!st.isDirectory()) continue

    const prj = readProject(itemDir)
    if (prj === null) continue

    const id = name
    const title = prj.title || id

    // --- web 类型：已按用户拍板弃用，归入 unsupported（不再进可播放列表） ---
    if (prj.type === 'web') {
      items.push({ id, title, kind: 'unsupported', file: '', preview: prj.preview || '' })
      continue
    }

    // --- video 类型 ---
    if (prj.type === 'video') {
      const media = locateMedia(itemDir, prj.file)
      if (media) {
        items.push({ id, title, kind: 'video', file: media.relPath, preview: prj.preview || '' })
      } else {
        items.push({ id, title, kind: 'unsupported', file: '', preview: prj.preview || '' })
      }
      continue
    }

// --- scene 类型（.pkg）：已按用户拍板弃用（preview 256×256 过糊、图层重建丢动画），
  //   不再进入可播放列表，与 preset 依赖型一并计入 unsupported 占位。SCENE_PATH 路由与
  //   src/scene.mjs 保留为将来可能恢复的残余（无副作用）。 ---
// 分支仍保留，仅让 scene 归入 unsupported 计数（item 无 kind 字段，client 端
  // normalizeCatalog 会将其判为非 video/web → unsupported）。scene 永远不进可播放列表。
if (prj.type === 'scene') {
      
        
        
        items.push({
          id,
          title,
          
          file: '',
          
        })
        continue
      }
    // --- preset 依赖型 / 其他：暂不支持播放，但列出（供占位/提示） ---
    items.push({ id, title, kind: 'unsupported', file: '', preview: prj.preview || '' })
  }

  return { ok: true, root: rootDir, items }
}

/** MIME 映射（视频/图像/网页）。 */
const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.json-tex': 'application/json; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}

/** 按扩展名映射 content-type，未知返回 octet-stream。 */
export function contentTypeFor(rel) {
  const dot = rel.lastIndexOf('.')
  const ext = dot === -1 ? '' : rel.slice(dot).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}
