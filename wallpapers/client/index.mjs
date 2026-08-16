// wallpapers 浏览器 half：全屏动态背景（视频/网页）+ 悬浮壁纸面板。
// 注：scene 型壁纸已按用户拍板彻底弃用 —— catalog 不再产生 scene 可播放项，
// 下述 scene 渲染函数（renderSceneDead/compositeLayers/fallbackPreview 等）为保留的
// 死代码（无任何调用链触达），仅为将来可能恢复留底；不要误以为 scene 仍被支持。
// 标准 bundle client 形态：exports { name, apply } 经 __ModuleLoader__.load 注册，
// 由 client 内核挂载时调用 apply(ctx)。ctx 仅可选消费；缺席时降级（背景照常跑）。
// 纯 DOM 自渲染，不依赖 React / settings 页 / api-proxy 白名单。
import { CATALOG_PATH, MEDIA_PATH, ITEM_PATH, SCENE_PATH } from '../src/routes.mjs'
import {
  SELECTED_KEY, MODE_KEY, NONE_ID, RANDOM_ID, MODES,
  normalizeCatalog, resolveSelection, findItem, isMetaSelection,
} from './logic.mjs'
import { WPE_ICON } from './icon.mjs'

export const name = 'wallpapers'

// localStorage 键：音量（0-100）与「离开此网页时静音」开关。
const VOLUME_KEY = 'wallpapers:volume'
const MUTE_ON_BLUR_KEY = 'wallpapers:muteOnBlur'

// ---- 精简 CSS ----
const CSS = `
[data-wallpapers] { all: initial; }
/* 壁纸层：固定在视口最底层，位于 body 背景之上、界面 #root 之下；永不拦截交互 */
[data-wallpapers].wp-layer { position: fixed; inset: 0; z-index: 0; overflow: hidden;
  pointer-events: none; background: #000; }
[data-wallpapers].wp-layer video, [data-wallpapers].wp-layer iframe {
position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border: 0; }
    
    
  
  


  
/* 对话背景模式：加一层暗色半透明遮罩压暗壁纸，保证文字可读（遮罩用 ::after 叠加在壁纸上、界面下） */
[data-wallpapers].wp-layer.wp-chat { opacity: var(--wp-chat-opacity, 1); }
[data-wallpapers].wp-layer.wp-chat::after { content: ''; position: absolute; inset: 0;
  background: rgba(8,10,16,.5); }
/* 全屏模式：壁纸完整亮度铺满，但依然保持在界面之下（不盖文字） */
[data-wallpapers].wp-layer.wp-fullscreen { opacity: 1; }
/* 关键：壁纸激活时，把界面各层背景 token 改成半透明，让壁纸从底层透出；
   同时内联清除 body 背景（见 applyWallpaper）压制皮肤工作室图片。
   透明度用 --wp-glass 统一控制（0=全透明 1=不透明）。 */
body[data-wallpapers-active] {
  background: transparent !important;
  --wp-glass: 0.78;
  --dsw-alias-bg-base: rgba(249,250,251, var(--wp-glass));
  --dsw-alias-bg-layer-1: rgba(243,245,251, var(--wp-glass));
  --dsw-alias-bg-layer-2: rgba(233,237,247, var(--wp-glass));
  --dsw-alias-bg-layer-3: rgba(228,234,247, var(--wp-glass));
  --dsw-alias-bg-overlay: rgba(238,241,249, var(--wp-glass));
  --dsw-alias-bg-module-platform: rgba(233,237,247, var(--wp-glass));
  --dsw-specific-sidebar-fill: rgba(242,245,250, var(--wp-glass));
  --dsw-specific-menu: rgba(243,245,251, var(--wp-glass));
  --dsw-specific-input-major: rgba(255,255,255, var(--wp-glass));
}
/* 深色主题下用深色底的半透明，避免浅色 token 在深色下发白 */
body[data-wallpapers-active][data-ds-dark-theme] {
  --dsw-alias-bg-base: rgba(16,22,42, var(--wp-glass));
  --dsw-alias-bg-layer-1: rgba(26,34,56, var(--wp-glass));
  --dsw-alias-bg-layer-2: rgba(32,42,68, var(--wp-glass));
  --dsw-alias-bg-layer-3: rgba(30,39,64, var(--wp-glass));
  --dsw-alias-bg-overlay: rgba(26,34,56, var(--wp-glass));
  --dsw-alias-bg-module-platform: rgba(32,42,68, var(--wp-glass));
  --dsw-specific-sidebar-fill: rgba(29,37,57, var(--wp-glass));
  --dsw-specific-menu: rgba(26,34,56, var(--wp-glass));
  --dsw-specific-input-major: rgba(26,34,56, var(--wp-glass));
}
body[data-wallpapers-active] #root { position: relative; z-index: 1; }
[data-wallpapers].wp-btn { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 44px; height: 44px; border-radius: 12px; cursor: pointer; border: 1px solid rgba(255,255,255,.18);
  background: rgba(24,28,38,.82); padding: 0; overflow: hidden; display: flex; align-items: center;
  justify-content: center; user-select: none; box-shadow: 0 8px 24px rgba(0,0,0,.35);
  transition: transform .15s ease; }
[data-wallpapers].wp-btn:hover { transform: scale(1.08); }
[data-wallpapers].wp-btn .wp-btn-icon { width: 100%; height: 100%; object-fit: cover; border-radius: 11px;
  display: block; }
[data-wallpapers].wp-panel { position: fixed; right: 16px; bottom: 60px; z-index: 2147483000;
  width: 300px; max-height: 70vh; overflow-y: auto; background: rgba(24,28,38,.96);
  border: 1px solid rgba(255,255,255,.12); border-radius: 12px; color: #E8EBF2;
  font-family: system-ui, sans-serif; font-size: 13px; box-shadow: 0 16px 40px rgba(0,0,0,.45); }
/* 面板头部：整体 sticky，标题行 + 副栏（音量/静音开关）两行一起常驻顶端 */
[data-wallpapers].wp-panel .wp-head { position: sticky; top: 0; z-index: 1;
  background: rgba(24,28,38,.98); border-bottom: 1px solid rgba(255,255,255,.1); }
[data-wallpapers].wp-panel .wp-headrow { display: flex; align-items: center;
  justify-content: space-between; font-weight: 600; padding: 10px 12px 6px; }
[data-wallpapers].wp-panel .wp-subbar { display: flex; align-items: center; gap: 8px;
  padding: 0 12px 10px; font-weight: 400; }
[data-wallpapers].wp-subbar .wp-vol-label { opacity: .7; font-size: 12px; white-space: nowrap; }
[data-wallpapers].wp-subbar input[type=range] { flex: 1 1 auto; accent-color: #608eff; margin: 0; }
[data-wallpapers].wp-subbar .wp-vol-val { min-width: 34px; text-align: right; opacity: .7;
  font-size: 12px; font-variant-numeric: tabular-nums; }
[data-wallpapers].wp-subbar .wp-mute-toggle { display: flex; align-items: center; gap: 5px;
  cursor: pointer; opacity: .85; font-size: 12px; white-space: nowrap; user-select: none; }
[data-wallpapers].wp-subbar .wp-mute-toggle:hover { opacity: 1; }
[data-wallpapers].wp-subbar .wp-mute-toggle input { cursor: pointer; margin: 0; }


  

[data-wallpapers].wp-panel .wp-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.06); }
[data-wallpapers].wp-panel .wp-item:hover { background: rgba(255,255,255,.06); }
[data-wallpapers].wp-panel .wp-item.on { background: rgba(96,142,255,.22); }
[data-wallpapers].wp-panel .wp-thumb { width: 48px; height: 30px; border-radius: 4px; flex: 0 0 auto;
  background-size: cover; background-position: center; background-color: rgba(255,255,255,.08); }
[data-wallpapers].wp-panel .wp-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-wallpapers].wp-panel .wp-kind { font-size: 10px; opacity: .6; text-transform: uppercase; }
[data-wallpapers].wp-panel .wp-empty { padding: 16px 12px; opacity: .6; text-align: center; }
[data-wallpapers].wp-close { position: absolute; top: 6px; right: 8px; cursor: pointer; opacity: .6; }
[data-wallpapers].wp-close:hover { opacity: 1; }
`

export function apply(ctx = {}) {
  // 幂等守卫
  if (document.querySelector('[data-wallpapers].wp-btn') !== null) {
    console.warn('[wallpapers] apply 已存在实例，跳过重复挂载')
    return () => {}
  }

  // 注入样式
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // ---- 运行状态 ----
  let catalog = { playable: [], unsupportedCount: 0, root: '' }
  let selected = localStorage.getItem(SELECTED_KEY) || NONE_ID
    if (selected === RANDOM_ID) selected = NONE_ID // 随机已移除：遗留 __random__ 归一化为无壁纸
  const mode = MODES.fullscreen // 固定全屏（对话背景/全屏切换已于用户拍板移除）
  let panelOpen = false
  let savedBodyBg = null // 激活时保存并清除 body 背景（压制皮肤工作室图片），停用时恢复
let rotateTimer = null // 随机已移除；保留变量让清理里的 clearTimeout(null) 成为无害 no-op
  let sceneGen = 0 // scene 渲染代数，切壁纸时递增以丢弃过期的异步图层

  // ---- 音量与「离开网页静音」状态 ----
  const volVal = Number(localStorage.getItem(VOLUME_KEY))
  let volume = Number.isFinite(volVal) ? Math.min(100, Math.max(0, volVal)) : 0
  let muteOnBlur = localStorage.getItem(MUTE_ON_BLUR_KEY) === '1' // 默认关闭
  let currentVideo = null // 当前背景 <video> 元素（音量/静音实时作用于它）
  let pageActive = true // 页面可见且窗口聚焦（离开网页 = false）
  let windowHasFocus = true

  // ---- 背景层 ----
  const layer = document.createElement('div')
  layer.setAttribute('data-wallpapers', '')
  layer.className = 'wp-layer'
  document.body.appendChild(layer)

  // ---- 悬浮按钮 ----
  const btn = document.createElement('button')
  btn.setAttribute('data-wallpapers', '')
  btn.setAttribute('aria-label', '壁纸')
  btn.className = 'wp-btn'
  const icon = document.createElement('img')
  icon.className = 'wp-btn-icon'
  icon.src = WPE_ICON
  icon.alt = '壁纸'
  icon.draggable = false
  btn.appendChild(icon)
  document.body.appendChild(btn)

  // ---- 面板 ----
  const panel = document.createElement('div')
  panel.setAttribute('data-wallpapers', '')
  panel.className = 'wp-panel'
  panel.style.display = 'none'
  document.body.appendChild(panel)

  // ---- 资源 URL 构造 ----
  function mediaUrl(item, file) {
    return `${MEDIA_PATH}?item=${encodeURIComponent(item)}&f=${encodeURIComponent(file)}`
  }
  function itemUrl(item, file) {
    const fq = file ? `&file=${encodeURIComponent(file)}` : ''
    return `${ITEM_PATH}?item=${encodeURIComponent(item)}${fq}`
  }
  function sceneUrl(item) {
    return `${SCENE_PATH}?item=${encodeURIComponent(item)}`
  }

  // 场景壁纸：把 "r g b" 这种 0-1 浮点颜色转成 CSS rgb()
  function clearcolorToCss(s) {
    if (typeof s !== 'string' || s === '') return '#000'
    const parts = s.trim().split(/\s+/).map(Number)
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return '#000'
    const c = (n) => Math.round(Math.min(1, Math.max(0, n)) * 255)
    return `rgb(${c(parts[0])}, ${c(parts[1])}, ${c(parts[2])})`
  }

  // 回退：没有可还原图层时，用 preview 缩略图铺满（仅兜底，分辨率低）
  function fallbackPreview(item) {
    const img = document.createElement('img')
    img.className = 'wp-scene-preview'
    img.alt = ''
    if (item && item.preview) {
      img.src = mediaUrl(item.id, item.preview)
      img.addEventListener('error', () => { console.warn('[wallpapers] 场景预览加载失败', item.preview) })
    }
    layer.appendChild(img)
  }

  // 图层重建：按 scene.json 把高清透明 PNG 图层叠加成静态首帧
  function compositeLayers(holder, id, data) {
    const sceneW = Number(data.width) || 0
    const sceneH = Number(data.height) || 0
    if (sceneW <= 0 || sceneH <= 0) return
    holder.style.background = clearcolorToCss(data.clearcolor)
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 场景画布以 cover 方式铺满视口，保持纵横比不变形
    const scale = Math.max(vw / sceneW, vh / sceneH)
    const canvasW = sceneW * scale
    const canvasH = sceneH * scale
    holder.style.width = `${canvasW}px`
    holder.style.height = `${canvasH}px`
    holder.style.left = `${(vw - canvasW) / 2}px`
    holder.style.top = `${(vh - canvasH) / 2}px`
    for (const l of data.layers) {
      const img = document.createElement('img')
      img.className = 'wp-scene-img'
      img.src = `${MEDIA_PATH}?item=${encodeURIComponent('output/' + id)}&f=${encodeURIComponent(l.rel)}`
      const sx = Number(l.scale?.[0]) || 1
      const sy = Number(l.scale?.[1]) || 1
      const w = (Number(l.size?.[0]) || 0) * sx * scale
      const h = (Number(l.size?.[1]) || 0) * sy * scale
      const cx = (Number(l.origin?.[0]) || 0) * scale
      const cy = (Number(l.origin?.[1]) || 0) * scale
      const angleDeg = ((Number(l.angleZ) || 0) * 180 / Math.PI)
      img.style.cssText = `position:absolute; left:${cx - w / 2}px; top:${cy - h / 2}px;`
        + ` width:${w}px; height:${h}px; opacity:${Number(l.alpha) || 1};`
        + ` transform:rotate(${angleDeg}deg);`
      holder.appendChild(img)
    }
  }

  // [死代码·留底] scene 渲染已弃用，本函数不再被任何调用链触达；如需恢复 scene
  // 预览方案，可重新接入此函数（preview.gif 或图层重建）。仅保留以作参考。
  function renderSceneDead(item) {
    layer.classList.add('wp-scene')
    const holder = document.createElement('div')
    holder.className = 'wp-scene-holder'
    holder.style.cssText = 'position:absolute; inset:0; overflow:hidden; pointer-events:none;'
    layer.appendChild(holder)
    const gen = sceneGen
    fetch(sceneUrl(item.id), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (gen !== sceneGen) return // 已切走，丢弃过期场景
      if (data && data.ok && Array.isArray(data.layers) && data.layers.length > 0) {
        compositeLayers(holder, item.id, data)
      } else {
        fallbackPreview(item)
      }
    }).catch(() => { fallbackPreview(item) })
  }

  // ---- 音量 / 静音状态应用到当前 video ----
  // forceMuted 仅在「用户未交互发声」阶段使用：视频最初以 muted 加载绕过 autoplay 限制。
  function applyAudioState(video, forceMuted = false) {
    const v = video || currentVideo
    if (!v) return
    const inBackground = !pageActive
    const shouldMute = forceMuted || volume === 0 || (muteOnBlur && inBackground)
    if (v.muted !== shouldMute) v.muted = shouldMute
    v.volume = volume / 100
  }

  // 根据窗口/页面可见性刷新当前视频静音（离开网页时静音的开关在此生效）。
  function refreshPageActive() {
    pageActive = windowHasFocus && !document.hidden
    applyAudioState(currentVideo)
  }
  // 命名 handler，供绑定与清理复用（避免匿名函数无法 removeEventListener）。
  function onWinBlur() { windowHasFocus = false; refreshPageActive() }
  function onWinFocus() { windowHasFocus = true; refreshPageActive() }

  // ---- 应用壁纸到背景层 ----
  function applyWallpaper() {
    layer.innerHTML = ''
    layer.classList.remove('wp-scene')
    sceneGen++ // 旧 scene fetch 失效
    const resolved = resolveSelection(selected, catalog.playable)
    if (resolved === NONE_ID) {
        layer.style.display = 'none' // 无壁纸：隐藏黑色背景层，避免盖住界面文字（bug 修复）
      document.body.removeAttribute('data-wallpapers-active')
      document.body.style.removeProperty('--wp-glass')
      if (savedBodyBg !== null) {
        document.body.style.backgroundImage = savedBodyBg
        savedBodyBg = null
      }
      layer.style.pointerEvents = 'none'
      currentVideo = null
      return
    }
    const item = findItem(catalog.playable, resolved)
    if (!item) {
        layer.style.display = 'none' // 无可用壁纸：隐藏黑色背景层
      document.body.removeAttribute('data-wallpapers-active')
      document.body.style.removeProperty('--wp-glass')
      if (savedBodyBg !== null) {
        document.body.style.backgroundImage = savedBodyBg
        savedBodyBg = null
      }
      layer.style.pointerEvents = 'none'
      currentVideo = null
      return
    }

    // 激活：给 body 打标，让界面浮在壁纸之上、body 背景变透明；
    // 同时内联清除 body 背景（压制皮肤工作室画在 body 上的图片，避免双重显示）
    layer.style.display = '' // 有壁纸：恢复显示背景层
      document.body.setAttribute('data-wallpapers-active', '')
    if (savedBodyBg === null) {
      savedBodyBg = document.body.style.backgroundImage
      document.body.style.backgroundImage = 'none'
    }

    if (item.kind === 'video') {
      const v = document.createElement('video')
      v.setAttribute('autoplay', '')
      v.setAttribute('loop', '')
      v.setAttribute('playsinline', '')
      v.src = mediaUrl(item.id, item.file)
      v.addEventListener('error', () => { console.warn('[wallpapers] 视频加载失败', item.file) })
      currentVideo = v
      // 初始 muted 以绕过浏览器有声 autoplay 限制；用户拖动音量条时才真正解禁发声。
      applyAudioState(v, true)
      const p = v.play()
      if (p && p.catch) p.catch(() => {})
      layer.appendChild(v)
    } // web/scene 不再支持（catalog 已不产出，仅剩 video）
      
      
      
      
      
    
      
      
/* web/scene 分支删除后的残余闭合花括号，已注释
    }
*/

    // 展示模式：都保持在界面之下，区别只在壁纸亮度与界面玻璃透明度
    layer.classList.toggle('wp-fullscreen', mode === MODES.fullscreen)
    layer.classList.toggle('wp-chat', mode === MODES.chat)
    if (mode === MODES.chat) {
      // 对话背景：壁纸压暗 + 界面玻璃较不透明（文字最清楚）
      layer.style.setProperty('--wp-chat-opacity', '0.75')
      document.body.style.setProperty('--wp-glass', '0.82')
    } else {
      // 全屏：壁纸完整亮度 + 界面玻璃更透（壁纸更突出，文字仍可读）
      layer.style.setProperty('--wp-chat-opacity', '1')
      document.body.style.setProperty('--wp-glass', '0.6')
    }
    layer.style.pointerEvents = 'none'
  }

  // ---- 渲染面板 ----
  function renderPanel() {
    panel.innerHTML = ''
    const head = document.createElement('div')
    head.className = 'wp-head'
    // 标题行（标题 + ✕）
    const row = document.createElement('div')
    row.className = 'wp-headrow'
    const t = document.createElement('span')
    t.textContent = '壁纸 (Wallpaper)'
    const close = document.createElement('span')
    close.className = 'wp-close'
    close.textContent = '✕'
    close.addEventListener('click', () => setPanel(false))
    row.appendChild(t)
    row.appendChild(close)
    head.appendChild(row)
    // 副栏（第二行）：音量滑杆 + 「离开此网页时静音」开关
    const sub = document.createElement('div')
    sub.className = 'wp-subbar'
    const volLabel = document.createElement('span')
    volLabel.className = 'wp-vol-label'
    volLabel.textContent = '🔊 音量'
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = '100'
    range.step = '1'
    range.value = String(volume)
    const volVal = document.createElement('span')
    volVal.className = 'wp-vol-val'
    volVal.textContent = `${volume}%`
    range.addEventListener('input', () => {
      volume = Math.min(100, Math.max(0, Number(range.value) || 0))
      localStorage.setItem(VOLUME_KEY, String(volume))
      volVal.textContent = `${volume}%`
      // 用户拖动 = 交互手势，触发真正发声（解除初始 muted）。
      applyAudioState(currentVideo)
    })
    const muteLab = document.createElement('label')
    muteLab.className = 'wp-mute-toggle'
    const muteChk = document.createElement('input')
    muteChk.type = 'checkbox'
    muteChk.checked = muteOnBlur
    muteChk.addEventListener('change', () => {
      muteOnBlur = muteChk.checked
      localStorage.setItem(MUTE_ON_BLUR_KEY, muteOnBlur ? '1' : '0')
      applyAudioState(currentVideo)
    })
    const muteTxt = document.createElement('span')
    muteTxt.textContent = '离开网页静音'
    muteLab.appendChild(muteChk)
    muteLab.appendChild(muteTxt)
    sub.appendChild(volLabel)
    sub.appendChild(range)
    sub.appendChild(volVal)
    sub.appendChild(muteLab)
    head.appendChild(sub)
    panel.appendChild(head)

    
    
    
    
      
      
      
      
      
/* 以下为删除模式条后的残余（孤立闭合花括号），已整体注释，勿启用
    }
*/
    
    
    

    // 无壁纸
    const mkMeta = (id, label) => {
      const d = document.createElement('div')
      d.className = 'wp-item' + (selected === id ? ' on' : '')
      const name = document.createElement('div')
      name.className = 'wp-name'
      name.textContent = label
      d.appendChild(name)
      d.addEventListener('click', () => { selected = id; localStorage.setItem(SELECTED_KEY, id); applyWallpaper(); renderPanel() })
      panel.appendChild(d)
    }
    mkMeta(NONE_ID, '🚫 无壁纸')
    

    // 播放列表
    if (catalog.playable.length === 0) {
      const e = document.createElement('div')
      e.className = 'wp-empty'
      e.textContent = '未发现可播放的壁纸（视频）'
      panel.appendChild(e)
    } else {
      for (const it of catalog.playable) {
        const d = document.createElement('div')
        d.className = 'wp-item' + (selected === it.id ? ' on' : '')
        const thumb = document.createElement('div')
        thumb.className = 'wp-thumb'
        if (it.preview) thumb.style.backgroundImage = `url(${mediaUrl(it.id, it.preview)})`
        const name = document.createElement('div')
        name.className = 'wp-name'
        name.textContent = it.title
        const kind = document.createElement('span')
        kind.className = 'wp-kind'
        kind.textContent = it.kind
        name.appendChild(kind)
        d.appendChild(thumb)
        d.appendChild(name)
        d.addEventListener('click', () => { selected = it.id; localStorage.setItem(SELECTED_KEY, it.id); applyWallpaper(); renderPanel() })
        panel.appendChild(d)
      }
    }

    if (catalog.unsupportedCount > 0) {
      const note = document.createElement('div')
      note.className = 'wp-empty'
      note.textContent = `${catalog.unsupportedCount} 个壁纸暂不支持（web / scene / preset 依赖型等）`
      panel.appendChild(note)
    }
  }

  function setPanel(open) {
    panelOpen = open
    panel.style.display = open ? 'block' : 'none'
    if (open) renderPanel()
  }

  btn.addEventListener('click', () => setPanel(!panelOpen))

  // ---- 加载清单 ----
  async function loadCatalog() {
    try {
      const r = await fetch(CATALOG_PATH, { cache: 'no-store' })
      if (!r.ok) return
      const data = await r.json()
      catalog = normalizeCatalog(data)
      applyWallpaper()
      if (panelOpen) renderPanel()
    } catch (e) {
      console.warn('[wallpapers] 清单加载失败：', e)
    }
  }

  
  
  
  
/* 随机 rotate 残余（rotateTimer 已删除）：
    clearTimeout(rotateTimer)
    
    
  }
*/

  // ---- 启动 ----
  document.addEventListener('visibilitychange', refreshPageActive)
  window.addEventListener('blur', onWinBlur)
  window.addEventListener('focus', onWinFocus)
  void loadCatalog()
  applyWallpaper()
  

  // ---- 清理 ----
  return () => {
    clearTimeout(rotateTimer)
    document.removeEventListener('visibilitychange', refreshPageActive)
    window.removeEventListener('blur', onWinBlur)
    window.removeEventListener('focus', onWinFocus)
    currentVideo = null
    document.body.removeAttribute('data-wallpapers-active')
    document.body.style.removeProperty('--wp-glass')
    if (savedBodyBg !== null) {
      document.body.style.backgroundImage = savedBodyBg
      savedBodyBg = null
    }
    layer.remove()
    btn.remove()
    panel.remove()
    style.remove()
  }
}