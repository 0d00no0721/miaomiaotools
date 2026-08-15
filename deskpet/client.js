window.__ModuleLoader__.load({
	id: "deskpet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
// deskpet 浏览器 half：纯 DOM 自渲染悬浮宠物（右下角形态，精简自 whale-girl）。
// 标准 bundle client 形态：exports { name, apply } 经 __ModuleLoader__.load 注册，
// 由 client 内核挂载时调用 apply(ctx)。ctx 仅可选消费 sessions；缺席时降级（宠物照常跑）。
// 状态机：idle/think/working/celebrate/sleep + 拖拽 drag + 自发/互动扩展
//   （walk/eat/play/joy/wait/wake）。零负反馈：无饥饿/心情衰减；空闲久打盹，互动即醒。
// 路由前缀单一来源：client bundle（内联）与 Node half 共用。
// 改前缀只改这里；任何文件不得手写 '/deskpet/...' 字面量。
const ROUTE_PREFIX = '/deskpet'
const ASSETS_PATH = `${ROUTE_PREFIX}/assets`
const STATE_PATH = `${ROUTE_PREFIX}/state`
// client 纯逻辑：简化状态机（无 DOM 引用，可单测）。
// 精简自 whale-girl 的 15 状态 → 保留核心陪伴子集：
//   idle / think / working / celebrate / sleep + 拖拽 drag + 自发/互动扩展。
// 零负反馈：无饥饿/心情衰减，宠物不因冷落受罚；空闲久了只打盹，互动即醒。
// 说明：error / disappointed 素材刻意不接入（零负反馈）；welcome 不做首播。

// 状态名权威集合（精简子集）。素材缺失时 client 回退隐藏（不 emoji）。
// 顺序即语义（非优先级，优先级见 STATE_TABLE 行序）。
const STATE_NAMES = Object.freeze([
  'drag', 'wake', 'celebrate', 'joy', 'play', 'eat',
  'working', 'think', 'walk', 'wait', 'sleep', 'idle',
])

// 常量窗口时长（毫秒）
const SLEEP_AFTER_MS = 60000       // 空闲 60s 入睡
const DRAG_RELEASE_MS = 1500       // 拖拽放下后缓冲回 idle
const ROUND_CELEBRATE_MS = 4000    // 回合完成庆祝窗口

// 互动/自发行为窗口时长（毫秒）
const WAKE_MS = 1200               // 睡眠唤醒 once 过渡窗口
const JOY_MS = 2500                // 戳一戳「开心」窗口
const PLAY_MS = 3000               // 戳一戳「玩耍」/自发玩耍窗口
const EAT_MS = 2600                // 自发进食窗口
const WAIT_MS = 2500               // 待机变体（wiggle）窗口
const WALK_MS = 6000               // 单次散步窗口

/**
 * 状态优先级表（文法单源）。行序即优先级：首行命中即返回。
 * 输入 c：{ dragging, dragReleaseUntil, wakeUntil, celebrateUntil,
 *           joyUntil, playUntil, eatUntil, walkUntil, waitUntil,
 *           sessionThink, workingActive, sleeping, now }
 * 窗口时间戳一律为「绝对 ms」，比较用 now。
 */
const STATE_TABLE = [
  { state: 'drag', when: (c) => c.dragging },
  { state: 'wake', when: (c) => c.wakeUntil > c.now },
  { state: 'celebrate', when: (c) => c.celebrateUntil > c.now },
  { state: 'joy', when: (c) => c.joyUntil > c.now },
  { state: 'play', when: (c) => c.playUntil > c.now },
  { state: 'eat', when: (c) => c.eatUntil > c.now },
  { state: 'working', when: (c) => c.workingActive && c.sessionThink },
  { state: 'think', when: (c) => c.sessionThink },
  { state: 'walk', when: (c) => c.walkUntil > c.now && !c.sessionThink },
  { state: 'wait', when: (c) => c.waitUntil > c.now && !c.sessionThink },
  { state: 'sleep', when: (c) => c.sleeping && !c.sessionThink },
  { state: 'idle', when: () => true },
]

/** 选择当前动画状态名。 */
function pickState(c) {
  for (const row of STATE_TABLE) {
    if (row.when(c)) return row.state
  }
  return 'idle' // 理论不可达
}

/** 帧播放模式（manifest 每状态必填）。 */
const PLAYBACK_MODES = Object.freeze(['loop', 'pingpong', 'once', 'blink'])

/**
 * 是否到推进帧的时刻（纯函数，fps 门控）。
 * lastAt===0 视为「首次」→ 返回 true（由调用方随即置 lastAt=now）。
 */
function shouldAdvance(now, lastAt, fps) {
  if (lastAt === 0) return true
  return now - lastAt >= 1000 / (fps > 0 ? fps : 1)
}

/**
 * 单一帧推进器（唯一实现，供渲染器复用，杜绝双源漂移）。
 * 输入 { mode, frame, dir, frames, blinkProb } 返回 { frame, dir }。
 *   loop：0→…→N-1→0；pingpong：0→…→N-1→…→0（内部维护 dir 翻转）；
 *   once：播完锁末帧；blink：常态锁帧0，按概率触发放一眼再回帧0。
 */
function nextFrame(mode, frame, dir, frames, blinkProb = 0.03) {
  const n = Math.max(1, Math.floor(frames))
  const d = dir === 1 ? 1 : -1
  switch (mode) {
    case 'pingpong': {
      if (n <= 1) return { frame: 0, dir: 1 }
      let f = frame + d
      let nd = d
      if (f >= n - 1) { f = n - 1; nd = -1 }
      else if (f <= 0) { f = 0; nd = 1 }
      return { frame: f, dir: nd }
    }
    case 'once':
      return { frame: Math.min(frame + 1, n - 1), dir: d }
    case 'blink':
      if (frame === 0) {
        return Math.random() < blinkProb ? { frame: 1, dir: d } : { frame: 0, dir: d }
      }
      return { frame: (frame + 1) % n, dir: d }
    case 'loop':
    default:
      return { frame: (frame + 1) % n, dir: d }
  }
}

// ---- 活动频率档位（本期仅集中参数 + normal 默认，暂不接 UI 开关） ----
const RHYTHM_LEVELS = Object.freeze(['chill', 'normal', 'hyper'])

// 参数说明（单位 ms；数组 = [min, max] 随机区间）：
//   walkEvery  自发散步间隔；workEvery/ workDur 思考期「认真干活」插曲节奏；
//   waitEvery  待机 wiggle 变体轮换间隔；selfPlayEvery 自发玩耍间隔；blinkProb 眨眼概率/评估。
const RHYTHM = {
  chill:  { walkEvery: [20000, 30000], workEvery: [12000, 18000], workDur: [4000, 8000], waitEvery: [15000, 25000], selfPlayEvery: [25000, 40000], blinkProb: 0.02 },
  normal: { walkEvery: [10000, 18000], workEvery: [8000, 18000],  workDur: [4000, 8000], waitEvery: [10000, 18000], selfPlayEvery: [20000, 30000], blinkProb: 0.03 },
  hyper:  { walkEvery: [4000, 8000],   workEvery: [4000, 8000],   workDur: [4000, 8000], waitEvery: [6000, 10000],  selfPlayEvery: [8000, 14000],  blinkProb: 0.05 },
}

/** 取指定档位节奏参数（非法 level 回退 normal）。 */
function pickRhythm(level = 'normal') {
  return RHYTHM[RHYTHM_LEVELS.includes(level) ? level : 'normal']
}

/** 在 [min, max] 内取随机浮点（闭区间）。 */
function randIn(range) {
  const [min, max] = range
  return min + Math.random() * (max - min)
}
// 角色清单解析层：manifest 角色索引的纯函数读面（无 DOM，可单测）。
// manifest 形状：{ characters: { <id>: { name?, states } }, default }；
// 兼容旧顶层 states 简写 = 单角色。
const DEFAULT_ROLE_ID = 'whale-girl'

/** 角色 id 合法字符集（URL 路径安全）。 */
const ROLE_ID_RE = /^[a-z0-9-]+$/

/** 从 manifest 提取角色索引。返回 { characters, defaultId, order }。 */
function parseCharacters(manifest) {
  const raw = manifest?.characters
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const characters = {}
    for (const [id, ch] of Object.entries(raw)) {
      if (ch === null || typeof ch !== 'object') continue
      characters[id] = {
        id,
        name: typeof ch.name === 'string' ? ch.name : id,
        states: ch.states !== null && typeof ch.states === 'object' ? ch.states : {},
      }
    }
    const defaultId = typeof manifest.default === 'string' && manifest.default in characters
      ? manifest.default
      : Object.keys(characters)[0] ?? DEFAULT_ROLE_ID
    return { characters, defaultId, order: Object.keys(characters) }
  }
  // 旧格式：顶层 states = 单角色
  return {
    characters: {
      [DEFAULT_ROLE_ID]: {
        id: DEFAULT_ROLE_ID,
        name: DEFAULT_ROLE_ID,
        states: manifest?.states !== null && typeof manifest?.states === 'object' ? manifest.states : {},
      },
    },
    defaultId: DEFAULT_ROLE_ID,
    order: [DEFAULT_ROLE_ID],
  }
}

function listCharacters(manifest) {
  return parseCharacters(manifest).order
}

function defaultCharacter(manifest) {
  return parseCharacters(manifest).defaultId
}

function getCharacter(manifest, id) {
  return parseCharacters(manifest).characters[id] ?? null
}

/** 取某状态的动画集（sheet/frames/fps/playback）；缺失返回 undefined。 */
function stateOf(character, stateName) {
  return character?.states?.[stateName]
}
const ASSETS_URL = ASSETS_PATH
const MANIFEST_URL = `${ASSETS_URL}/manifest.json`
const TICK_MS = 50
const POLL_MS = 2000

const name = 'deskpet'

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

function apply(ctx = {}) {
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
		module.exports = { name: name, apply: apply };
		return module.exports;
	}
});
