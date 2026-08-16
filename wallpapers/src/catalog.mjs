// 壁纸目录扫描：解析 Wallpaper Engine 创意工坊目录（project.json）为可播放清单。
// 纯 Node，零依赖；只读本地目录。可播放类型：
//   video/Video → 单个 .mp4（浏览器 <video> 直接播放）
//   scene/Scene 与 web/Web 等其他类型 → 低成本复刻：用户在与 project.json 同级的目录里
//                放一张文件名含「屏幕截图」的图片作为背景；音频由同目录 audio.json 清单
//                指定（相对项目目录路径；sounds/ 前缀表示解包音频）。无截图 → 忽略；
//                无音频清单 → 纯图壁纸不播声。web 原生渲染（iframe live2d 等）不再支持。
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

// 音频扩展名集合（暂未参与清单校验；保留以兼容将来按扩展名过滤的需求）。
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a'])

// scene 复刻：背景图扩展名集合。
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/**
 * 在 itemDir 里找一张「用户放置的背景图」：文件名含「屏幕截图」的图片。
 * 返回相对文件名（不含路径），无则返回 null。
 */
function findScreenshot(itemDir) {
  let entries = []
  try { entries = readdirSync(itemDir) } catch { return null }
  for (const name of entries) {
    if (!name.includes('屏幕截图')) continue
    const dot = name.lastIndexOf('.')
    if (dot === -1) continue
    const ext = name.slice(dot).toLowerCase()
    if (!IMAGE_EXTS.has(ext)) continue
    const p = join(itemDir, name)
    try { if (statSync(p).isFile()) return name } catch {}
  }
  return null
}

/** 音频清单文件名（相对 item 目录）：{ audios: [相对路径, ...] }。 */
const AUDIO_MANIFEST_NAME = 'audio.json'

/**
 * 读 item 目录下的 audio.json，返回用户显式指定的音频相对路径数组。
 * 格式：{ audios: ["assets/audio/Theme_339.ogg", ...] }（相对 item 目录，多段路径）。
 * 无清单 / 解析失败 / audios 非数组 / 相对路径不安全 → 返回 []（纯图壁纸，不播声）。
 */
function readAudioManifest(itemDir) {
  const mp = join(itemDir, AUDIO_MANIFEST_NAME)
  if (!existsSync(mp)) return []
  let m
  try { m = JSON.parse(readFileSync(mp, 'utf8')) } catch { return [] }
  const audios = Array.isArray(m?.audios) ? m.audios : []
  const out = []
  for (const a of audios) {
    if (typeof a === 'string' && isSafeRel(a)) out.push(a)
  }
  return out
}

/**
 * 扫描壁纸根目录，返回可播放清单条目数组。
 * 每项：{ id, title, kind: 'video'|'scene'|'unsupported', file, preview, image?, audios? }。
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

    // --- web 类型：已按用户拍板弃用 web 原生渲染（iframe live2d 等）---
    // 但若用户在该目录放了「屏幕截图」图片，则按「图+音频清单」低成本复刻（见下方 scene 规则）。
    if (prj.type === 'web') {
      const img = findScreenshot(itemDir)
      if (img === null) {
        items.push({ id, title, kind: 'unsupported', file: '', preview: prj.preview || '' })
        continue
      }
      const audios = readAudioManifest(itemDir)
      items.push({ id, title, kind: 'scene', file: '', preview: prj.preview || '', image: img, audios })
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

    // --- scene 类型（.pkg）：低成本复刻（图 + 音频清单）---
    // 规则（用户拍板）：用户在与 .pkg 同级的目录里放一张文件名含「屏幕截图」的图片 +（可选）audio.json 清单。
    // 有截图 → kind:'scene' 进可播放；无截图 → 忽略。音频仅取 audio.json 列出的（缺失/为空 → 纯图不播声）。
    if (prj.type === 'scene') {
      const img = findScreenshot(itemDir)
      if (img === null) continue // 没有「屏幕截图」图片 → 该 scene 我不要
      const audios = readAudioManifest(itemDir)
      items.push({ id, title, kind: 'scene', file: '', preview: prj.preview || '', image: img, audios })
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
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.bmp': 'image/bmp',
}

/** 按扩展名映射 content-type，未知返回 octet-stream。 */
export function contentTypeFor(rel) {
  const dot = rel.lastIndexOf('.')
  const ext = dot === -1 ? '' : rel.slice(dot).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}
