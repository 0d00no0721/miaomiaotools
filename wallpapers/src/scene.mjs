// wallpapers scene 解析：把 Wallpaper Engine 场景型壁纸（.pkg 解包后的 output/<id>/）
// 的 scene.json 解析为「可在浏览器里近似还原首帧」的图层清单。
// 纯 Node，零依赖，只读本地目录。
//
// WE 的 scene 是闭源引擎渲染的原生格式（自定义 shader 特效、粒子、3D 模型、脚本文字），
// 浏览器无法像素级复刻。本模块只抽取「2D 图像图层」（image 字段 → models/*.json → materials/*.json
// → textures[0] 纹理名 → materials/ 里已解包的 .png/.jpg 图片），按 scene.json 里的
// origin/size/scale/alpha 排版，用 clearcolor 作为底色，还原出接近 WE 首帧的静态合成画面。
// 粒子 / 3D 模型 / 文字脚本 / 特效层一律跳过。
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 图片纹理扩展名优先级（repkg 解包后纹理名仍有扩展名；找不到时在这些扩展里挑）。 */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']

/** 解析 "x y z" 这类 WE 用空格分隔的向量字符串为数值数组。 */
function parseVec(s, fallback = [0, 0, 0]) {
  if (typeof s !== 'string') return fallback
  const parts = s.trim().split(/\s+/).map(Number)
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return fallback
  return parts
}

/** 在 itemDir 下解析一个「图像图层引用」路径（models/*.json → materials/*.json → 纹理名 → 图片文件）。
 *  返回可 URL 化的相对路径（相对 itemDir，用 / 分隔），失败返回 null。 */
function resolveImageFile(itemDir, imageRel) {
  if (typeof imageRel !== 'string' || imageRel === '') return null
  // imageRel 形如 "models/xxx.json"，是相对 itemDir 的路径。
  const modelRel = imageRel.replace(/\\/g, '/')
  let modelPath = join(itemDir, ...modelRel.split('/'))
  let model
  try {
    model = JSON.parse(readFileSync(modelPath, 'utf8'))
  } catch {
    return null
  }
  // model.json 里 material 字段指向 materials/*.json
  const matRel = typeof model?.material === 'string' ? model.material.replace(/\\/g, '/') : ''
  let textureName = null
  if (matRel) {
    try {
      const mat = JSON.parse(readFileSync(join(itemDir, ...matRel.split('/')), 'utf8'))
      const tex = mat?.passes?.[0]?.textures?.[0]
      if (typeof tex === 'string' && tex !== '') textureName = tex
    } catch {
      return null
    }
  }
  if (!textureName) return null
  // 纹理名（如 "44873217_p0..."）没有扩展名；在 materials 目录里按图片扩展名找。
  // 也可能 textures[0] 本身带扩展名；先按原名试，再按 materials/ 目录枚举。
  const candidates = []
  if (/\.[a-z0-9]+$/i.test(textureName)) {
    candidates.push(textureName) // 纹理名自带扩展名
  }
  for (const ext of IMAGE_EXTS) {
    candidates.push(`${textureName}${ext}`)
  }
  for (const cand of candidates) {
    const rel = `materials/${cand}`
    const abs = join(itemDir, 'materials', cand)
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return rel
    } catch { /* ignore */ }
  }
  return null
}

/**
 * 解析 output/<id>/scene.json，返回可播放的静态图层清单。
 * 入参：unpackedDir = output/<id>（已由 repkg extract 解包）。
 * 出参：
 *   { ok:false, error }  —— 无 scene.json 或不可读
 *   { ok:true, width, height, clearcolor:'r g b', layers:[{ rel, origin:[x,y], size:[w,h],
 *     scale:[x,y,z], alpha, angleZ }] }
 */
export function parseScene(unpackedDir) {
  const scenePath = join(unpackedDir, 'scene.json')
  if (!existsSync(scenePath)) return { ok: false, error: 'no scene.json' }
  let scene
  try {
    scene = JSON.parse(readFileSync(scenePath, 'utf8'))
  } catch (e) {
    return { ok: false, error: `scene.json 解析失败：${e.message}` }
  }

  const proj = scene?.general?.orthogonalprojection
  const width = Number(proj?.width) || 0
  const height = Number(proj?.height) || 0
  const clearcolor = typeof scene?.general?.clearcolor === 'string' ? scene.general.clearcolor : ''

  const layers = []
  const objs = Array.isArray(scene?.objects) ? scene.objects : []
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    if (typeof o.image !== 'string' || o.image === '') continue // 只处理 2D 图像图层
    if (o.visible === false) continue
    const rel = resolveImageFile(unpackedDir, o.image)
    if (!rel) continue // 纹理没有被解包成图片（如仅有 .tex），跳过该层

    const origin = parseVec(o.origin)
    const size = parseVec(o.size)
    const scale = parseVec(o.scale, [1, 1, 1])
    const alpha = typeof o.alpha === 'number' && Number.isFinite(o.alpha) ? o.alpha : 1
    const angles = parseVec(o.angles)
    const angleZ = angles[2] ?? 0

    layers.push({
      rel,
      origin: [origin[0] ?? 0, origin[1] ?? 0],
      size: [size[0] ?? 0, size[1] ?? 0],
      scale: [scale[0] ?? 1, scale[1] ?? 1],
      alpha,
      angleZ,
    })
  }

  if (layers.length === 0) {
    return { ok: false, error: '无可还原的图像图层（纹理缺失）', empty: true }
  }

  return { ok: true, width, height, clearcolor, layers }
}