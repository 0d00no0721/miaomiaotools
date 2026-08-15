// deskpet 浏览器 half：纯 DOM 自渲染悬浮宠物（右下角形态，精简自 whale-girl）。
// 标准 bundle client 形态：exports { name, apply } 经 __ModuleLoader__.load 注册，
// 由 client 内核挂载时调用 apply(ctx)。ctx 仅可选消费 sessions；缺席时降级（宠物照常跑）。
// 状态机：idle/think/working/celebrate/sleep + 拖拽 drag + 自发/互动扩展
//   （walk/eat/play/joy/wait/wake）。零负反馈：无饥饿/心情衰减；空闲久打盹，互动即醒。
import { ASSETS_PATH, STATE_PATH } from '../src/routes.mjs'
import {
  pickState, shouldAdvance, nextFrame, pickRhythm, randIn,
  SLEEP_AFTER_MS, DRAG_RELEASE_MS, ROUND_CELEBRATE_MS,
  WAKE_MS, JOY_MS, PLAY_MS, EAT_MS, WAIT_MS, WALK_MS,
} from './logic.mjs'
import { parseCharacters, listCharacters, defaultCharacter, getCharacter, stateOf } from './character.mjs'

const ASSETS_URL = ASSETS_PATH
const MANIFEST_URL = `${ASSETS_URL}/manifest.json`
const TICK_MS = 50
const POLL_MS = 2000

export const name = 'deskpet'

// ---- 精简 CSS（关键定位由 JS 内联，宿主可能清理 CSS 注入）----
const CSS = `
[data-deskpet] { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 110px; height: 110px; font-family: system-ui, sans-serif;
  user-select: none; touch-action: none; }
[data-deskpet] .pet-stage { position: absolute; inset: 0; display: grid; place-items: center;
  will-change: transform; }
[data-deskpet] .pet-sprite { width: 100%; height: 100%; background-repeat: no-repeat;
  background-size: auto 100%; background-position: 0 0; image-rendering: auto;
  filter: drop-shadow(0 4px 6px rgba(0,0,0,.25)); pointer-events: none;
  transition: transform .18s ease; }
[data-deskpet] .pet-hitarea { position: absolute; inset: 0; cursor: grab; z-index: 3; border-radius: 8px; }
[data-deskpet] .pet-hitarea.dragging { cursor: grabbing; }
[data-deskpet] .pet-menu { position: absolute; left: 50%; top: calc(100% + 10px); transform: translateX(-50%);
  width: max-content; background: rgba(24,28,38,.94); border: 1px solid rgba(255,255,255,.10);
  border-radius: 10px; padding: 6px; color: #E8EBF2; font-size: 12px; z-index: 4;
  box-shadow: 0 12px 32px rgba(0,0,0,.38); display: none; }
[data-deskpet] .pet-menu.open { display: block; }
[data-deskpet] .pet-menu button { display: block; width: 100%; background: none; border: none;
  color: #E8EBF2; padding: 6px 10px; text-align: left; border-radius: 6px; cursor: pointer; font-size: 12px; }
[data-deskpet] .pet-menu button:hover { background: rgba(255,255,255,.12); }
[data-deskpet] .pet-menu .menu-title { padding: 4px 10px; opacity: .6; font-size: 11px; }
`

export function apply(ctx = {}) {
  // 幂等守卫：bundle 重复执行（HMR/loader 重跑）时不重复挂载。
  if (document.querySelector('[data-deskpet]') !== null) {
    console.warn('[deskpet] apply 已存在实例，跳过重复挂载')
    return () => {}
  }

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // ---- 运行状态 ----
  let manifest = { characters: {}, default: null }
  let roleId = localStorage.getItem('deskpet:character') || null
  let rhythm = pickRhythm('normal')

  // 交互/状态窗口（一律绝对 ms 时间戳）
  let dragging = false
  let dragReleaseUntil = 0
  let celebrateUntil = 0           // 服务端回合完成窗口（绝对 ms，poll 时换算）
  let celebrateLocalUntil = 0      // 本地戳一戳庆祝窗口
  let joyUntil = 0                 // 戳一戳「开心」
  let playUntil = 0                // 戳一戳「玩耍」/自发玩耍
  let eatUntil = 0                 // 自发进食
  let waitUntil = 0                // 待机 wiggle 变体
  let wakeUntil = 0                // 睡眠唤醒 once 过渡
  let walkUntil = 0                // 散步窗口

  let sessionThink = false         // 服务端 anyActive
  let workingActive = false        // 思考期随机「认真干活」插曲
  let lastInteractionAt = Date.now()
  let frame = 0
  let pingpongDir = 1
  let menuOpen = false
  let currentState = ''            // 上一帧的状态名，用于检测状态切换
  let lastFrameAt = 0              // 上一次推进帧的时间戳（按 fps 控制节奏）
  let motionPhase = 0              // float/wiggle/shake 相位基准

  // 散步水平移动
  let walkDir = -1                 // -1 左 / 1 右（初始贴右下角朝左）
  let walkPx = 0                   // 本轮已走像素（用于到边界反转）

  // ---- DOM ----
  const host = document.createElement('div')
  host.setAttribute('data-deskpet', '')
  host.setAttribute('role', 'group')
  host.setAttribute('aria-label', '桌面宠物')
  host.style.cssText = 'position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;'
  document.body.appendChild(host)

  const stage = document.createElement('div')
  stage.className = 'pet-stage'
  host.appendChild(stage)

  const sprite = document.createElement('div')
  sprite.className = 'pet-sprite'
  stage.appendChild(sprite)

  const hitarea = document.createElement('div')
  hitarea.className = 'pet-hitarea'
  host.appendChild(hitarea)

  const menu = document.createElement('div')
  menu.className = 'pet-menu'
  host.appendChild(menu)

  // ---- 角色资源加载 ----
  const loaded = {}

  async function loadManifest() {
    try {
      const r = await fetch(MANIFEST_URL, { cache: 'no-store' })
      manifest = await r.json()
      const def = defaultCharacter(manifest)
      if (roleId === null || getCharacter(manifest, roleId) === null) roleId = def
      localStorage.setItem('deskpet:character', roleId)
      renderMenu()
      renderFrame()
    } catch (e) {
      console.warn('[deskpet] manifest 加载失败：', e)
    }
  }

  async function loadSheet(stateName, anim) {
    if (!anim || !anim.sheet) return
    const key = `${roleId}:${stateName}`
    if (loaded[key]) return
    try {
      const r = await fetch(`${ASSETS_URL}/characters/${roleId}/${anim.sheet}`, { cache: 'no-store' })
      if (!r.ok) return
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      loaded[key] = { url, frames: anim.frames ?? 1 }
    } catch (e) {
      console.warn('[deskpet] sprite 加载失败：', anim.sheet, e)
    }
  }

  // ---- 状态与动画解析 ----
  function currentAnim() {
    const character = getCharacter(manifest, roleId)
    if (!character) return null
    const now = Date.now()
    const c = {
      dragging,
      dragReleaseUntil,
      wakeUntil,
      celebrateUntil: Math.max(celebrateLocalUntil, celebrateUntil),
      joyUntil,
      playUntil,
      eatUntil,
      walkUntil,
      waitUntil,
      sessionThink,
      workingActive,
      sleeping: !dragging && now - lastInteractionAt > SLEEP_AFTER_MS && !sessionThink,
      now,
    }
    const state = pickState(c)
    return { state, anim: stateOf(character, state) }
  }

  // ---- motion 动效（manifest.motion: float/wiggle/shake/tilt）----
  function applyMotion(state, anim, draggingNow) {
    const motion = anim?.motion
    const speed = anim?.motionSpeed ?? 1
    const phase = motionPhase * speed
    let transform = ''
    if (draggingNow && motion === 'tilt') {
      // 拖拽跟随：按水平移动方向轻微倾斜。
      const tilt = Math.max(-6, Math.min(6, (dragVelX ?? 0) * 0.4))
      transform = `rotate(${tilt}deg)`
    } else if (motion === 'float') {
      transform = `translateY(${Math.sin(phase) * 4}px)`
    } else if (motion === 'wiggle') {
      transform = `rotate(${Math.sin(phase * 2) * 3}deg)`
    } else if (motion === 'shake') {
      transform = `translateX(${Math.sin(phase * 6) * 3}px)`
    }
    // 散步方向镜像（walk 需要 flip；其余状态不镜像）。
    const flip = state === 'walk' && walkDir === 1 ? -1 : 1
    stage.style.transform = (transform
      ? `${transform}${flip !== 1 ? ' scaleX(-1)' : ''}`
      : (flip !== 1 ? 'scaleX(-1)' : ''))
  }

  // ---- 帧渲染 ----
  function renderFrame() {
    const resolved = currentAnim()
    const state = resolved?.state ?? 'idle'
    const anim = resolved?.anim ?? null
    // 状态切换：重置帧索引与朝向，避免上一状态的帧位/方向残留造成跳变。
    if (state !== currentState) {
      currentState = state
      frame = 0
      pingpongDir = 1
      lastFrameAt = 0
    }
    const res = loaded[`${roleId}:${state}`]
    if (res) {
      const frameWpx = sprite.offsetHeight || 110
      sprite.style.backgroundImage = `url(${res.url})`
      sprite.style.backgroundSize = 'auto 100%'
      sprite.style.backgroundPosition = `${-frame * frameWpx}px 0`
      sprite.style.backgroundColor = 'transparent'
      sprite.style.display = 'block'
    } else {
      sprite.style.backgroundImage = 'none'
      sprite.style.backgroundColor = 'transparent'
      sprite.style.display = 'none'
      if (anim) void loadSheet(state, anim)
    }
    applyMotion(state, anim, dragging)
  }

  // ---- 帧推进（复用 logic.nextFrame + shouldAdvance，单源） ----
  function stepFrame() {
    const resolved = currentAnim()
    if (!resolved) return
    const { state, anim } = resolved
    const res = loaded[`${roleId}:${state}`]
    if (!res || !anim || !anim.playback || res.frames <= 1) return
    const fps = anim.fps ?? 3
    const now = Date.now()
    if (!shouldAdvance(now, lastFrameAt, fps)) return
    lastFrameAt = now
    const nxt = nextFrame(anim.playback, frame, pingpongDir, res.frames, rhythm.blinkProb)
    frame = nxt.frame
    pingpongDir = nxt.dir
  }

  // ---- 菜单 ----
  function renderMenu() {
    menu.innerHTML = ''
    const title = document.createElement('div')
    title.className = 'menu-title'
    title.textContent = '换角色'
    menu.appendChild(title)
    for (const id of listCharacters(manifest)) {
      const ch = getCharacter(manifest, id)
      const b = document.createElement('button')
      b.textContent = `${ch?.name ?? id}${id === roleId ? ' ✓' : ''}`
      b.addEventListener('click', () => {
        roleId = id
        localStorage.setItem('deskpet:character', id)
        frame = 0
        renderMenu()
        renderFrame()
        lastInteractionAt = Date.now()
      })
      menu.appendChild(b)
    }
  }

  function toggleMenu(open) {
    menuOpen = open
    menu.classList.toggle('open', open)
  }

  // ---- 交互：戳一戳（随机轮换 celebrate/joy/play） ----
  function poke() {
    lastInteractionAt = Date.now()
    wakeFromSleep()
    // 每次互动先清空互斥的自发窗口，避免残留窗外状态竞争。
    eatUntil = 0; waitUntil = 0
    const roll = Math.random()
    const now = Date.now()
    if (roll < 0.4) celebrateLocalUntil = now + ROUND_CELEBRATE_MS
    else if (roll < 0.7) joyUntil = now + JOY_MS
    else playUntil = now + PLAY_MS
    renderFrame()
  }

  // ---- 睡眠唤醒：播 wake once 过渡 ----
  function wakeFromSleep() {
    const now = Date.now()
    if (now - lastInteractionAt > SLEEP_AFTER_MS) {
      wakeUntil = now + WAKE_MS
    }
  }

  // ---- 拖拽 ----
  let dragStart = null
  let dragOffset = null
  let didDrag = false
  let dragVelX = 0
  let lastDragX = 0

  hitarea.addEventListener('pointerdown', (e) => {
    dragStart = { x: e.clientX, y: e.clientY }
    dragOffset = {
      x: e.clientX - host.offsetLeft,
      y: e.clientY - host.offsetTop,
    }
    lastDragX = e.clientX
    dragVelX = 0
    hitarea.setPointerCapture(e.pointerId)
  })
  hitarea.addEventListener('pointermove', (e) => {
    if (!dragStart) return
    dragVelX = e.clientX - lastDragX
    lastDragX = e.clientX
    const dx = e.clientX - dragStart.x
    const dy = e.clientY - dragStart.y
    if (!dragging && Math.hypot(dx, dy) > 6) {
      dragging = true
      didDrag = true
      hitarea.classList.add('dragging')
      toggleMenu(false)
    }
    if (dragging) {
      host.style.left = `${e.clientX - dragOffset.x}px`
      host.style.top = `${e.clientY - dragOffset.y}px`
      host.style.right = 'auto'
      host.style.bottom = 'auto'
    }
  })
  hitarea.addEventListener('pointerup', (e) => {
    hitarea.releasePointerCapture(e.pointerId)
    const wasDrag = dragging
    dragging = false
    dragStart = null
    dragVelX = 0
    hitarea.classList.remove('dragging')
    if (wasDrag) {
      dragReleaseUntil = Date.now() + DRAG_RELEASE_MS
      lastInteractionAt = Date.now()
      wakeFromSleep()
    } else if (!didDrag) {
      // 纯点击：戳一戳
      poke()
    }
    didDrag = false
  })
  hitarea.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    toggleMenu(!menuOpen)
  })

  // ---- 服务端活动轮询 ----
  async function pollState() {
    try {
      const r = await fetch(STATE_PATH, { cache: 'no-store' })
      if (!r.ok) return
      const s = await r.json()
      sessionThink = !!s.anyActive
      const rem = Math.max(0, s.celebrateUntil ?? 0)
      celebrateUntil = rem > 0 ? Date.now() + rem : 0
    } catch (e) {
      // 服务端不可达 → 降级（本地 idle/sleep 照常）。
    }
  }

  // ---- 自发行为调度（思考期工作插曲 / 散步 / 进食 / 玩耍 / 待机变体） ----
  let workingTimer = null
  function scheduleWorking() {
    clearTimeout(workingTimer)
    workingTimer = setTimeout(() => {
      if (sessionThink) {
        workingActive = true
        workingTimer = setTimeout(() => {
          workingActive = false
          scheduleWorking()
        }, randIn(rhythm.workDur))
      } else {
        workingActive = false
        scheduleWorking()
      }
    }, randIn(rhythm.workEvery))
  }

  let walkTimer = null
  function scheduleWalk() {
    clearTimeout(walkTimer)
    walkTimer = setTimeout(() => {
      // 仅空闲未思考、未睡眠时自发散步。
      if (!sessionThink && !currentAnimSleeping()) {
        startWalk()
      }
      scheduleWalk()
    }, randIn(rhythm.walkEvery))
  }

  function currentAnimSleeping() {
    const now = Date.now()
    return !dragging && now - lastInteractionAt > SLEEP_AFTER_MS && !sessionThink
  }

  function startWalk() {
    walkUntil = Date.now() + WALK_MS
    walkPx = 0
    // 方向延续但初始贴边时朝内侧走；由 tick 里的边界反转决定实际方向。
    walkDir = -1
    // 若当前已因拖拽脱离右下角，则朝水平中心随机走。
    if (host.style.left) {
      walkDir = Math.random() < 0.5 ? -1 : 1
    }
  }

  // 每 tick 推进散步的水平位移（在视口内 clamp，越界反转方向）。
  function stepWalk() {
    if (walkUntil <= Date.now()) return
    const step = 0.6 // px / tick（约 12px/s）
    walkPx += step
    // 若处于右下角定位（无 left），先转为 left/top 以支持水平平移。
    if (!host.style.left) {
      const rect = host.getBoundingClientRect()
      host.style.left = `${rect.left}px`
      host.style.top = `${rect.top}px`
      host.style.right = 'auto'
      host.style.bottom = 'auto'
    }
    const cur = host.offsetLeft
    const width = host.offsetWidth || 110
    const maxX = window.innerWidth - width - 8
    let nx = cur + walkDir * step
    if (nx < 8) { nx = 8; walkDir = 1 }
    else if (nx > maxX) { nx = maxX; walkDir = -1 }
    host.style.left = `${nx}px`
  }

  let eatTimer = null
  function scheduleEat() {
    clearTimeout(eatTimer)
    eatTimer = setTimeout(() => {
      // 偶尔自发进食（小事一桩，安抚陪伴感）。
      if (!sessionThink && !currentAnimSleeping() && walkUntil <= Date.now()) {
        eatUntil = Date.now() + EAT_MS
      }
      scheduleEat()
    }, randIn(rhythm.selfPlayEvery))
  }

  let playTimer = null
  function scheduleSelfPlay() {
    clearTimeout(playTimer)
    playTimer = setTimeout(() => {
      if (!sessionThink && !currentAnimSleeping() && walkUntil <= Date.now()) {
        playUntil = Date.now() + PLAY_MS
      }
      scheduleSelfPlay()
    }, randIn(rhythm.selfPlayEvery))
  }

  let waitTimer = null
  function scheduleWait() {
    clearTimeout(waitTimer)
    waitTimer = setTimeout(() => {
      if (!sessionThink && !currentAnimSleeping() && walkUntil <= Date.now()
          && eatUntil <= Date.now() && playUntil <= Date.now()) {
        waitUntil = Date.now() + WAIT_MS
      }
      scheduleWait()
    }, randIn(rhythm.waitEvery))
  }

  // ---- 主循环 ----
  const tickTimer = setInterval(() => {
    motionPhase += TICK_MS / 1000
    stepWalk()
    stepFrame()
    renderFrame()
  }, TICK_MS)

  const pollTimer = setInterval(pollState, POLL_MS)

  // ---- 启动 ----
  void loadManifest()
  void pollState()
  scheduleWorking()
  scheduleWalk()
  scheduleEat()
  scheduleSelfPlay()
  scheduleWait()

  // ---- 清理 ----
  return () => {
    clearInterval(tickTimer)
    clearInterval(pollTimer)
    clearTimeout(workingTimer)
    clearTimeout(walkTimer)
    clearTimeout(eatTimer)
    clearTimeout(playTimer)
    clearTimeout(waitTimer)
    if (hitarea.releasePointerCapture) {
      try { hitarea.releasePointerCapture(1) } catch {}
    }
    host.remove()
    style.remove()
  }
}