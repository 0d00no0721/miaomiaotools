// client 纯逻辑：简化状态机（无 DOM 引用，可单测）。
// 精简自 whale-girl 的 15 状态 → 保留核心陪伴子集：
//   idle / think / working / celebrate / sleep + 拖拽 drag + 自发/互动扩展。
// 零负反馈：无饥饿/心情衰减，宠物不因冷落受罚；空闲久了只打盹，互动即醒。
// 说明：error / disappointed 素材刻意不接入（零负反馈）；welcome 不做首播。

// 状态名权威集合（精简子集）。素材缺失时 client 回退隐藏（不 emoji）。
// 顺序即语义（非优先级，优先级见 STATE_TABLE 行序）。
export const STATE_NAMES = Object.freeze([
  'drag', 'wake', 'celebrate', 'joy', 'play', 'eat',
  'working', 'think', 'walk', 'wait', 'sleep', 'idle',
])

// 常量窗口时长（毫秒）
export const SLEEP_AFTER_MS = 60000       // 空闲 60s 入睡
export const DRAG_RELEASE_MS = 1500       // 拖拽放下后缓冲回 idle
export const ROUND_CELEBRATE_MS = 4000    // 回合完成庆祝窗口

// 互动/自发行为窗口时长（毫秒）
export const WAKE_MS = 1200               // 睡眠唤醒 once 过渡窗口
export const JOY_MS = 2500                // 戳一戳「开心」窗口
export const PLAY_MS = 3000               // 戳一戳「玩耍」/自发玩耍窗口
export const EAT_MS = 2600                // 自发进食窗口
export const WAIT_MS = 2500               // 待机变体（wiggle）窗口
export const WALK_MS = 6000               // 单次散步窗口

/**
 * 状态优先级表（文法单源）。行序即优先级：首行命中即返回。
 * 输入 c：{ dragging, dragReleaseUntil, wakeUntil, celebrateUntil,
 *           joyUntil, playUntil, eatUntil, walkUntil, waitUntil,
 *           sessionThink, workingActive, sleeping, now }
 * 窗口时间戳一律为「绝对 ms」，比较用 now。
 */
export const STATE_TABLE = [
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
export function pickState(c) {
  for (const row of STATE_TABLE) {
    if (row.when(c)) return row.state
  }
  return 'idle' // 理论不可达
}

/** 帧播放模式（manifest 每状态必填）。 */
export const PLAYBACK_MODES = Object.freeze(['loop', 'pingpong', 'once', 'blink'])

/**
 * 是否到推进帧的时刻（纯函数，fps 门控）。
 * lastAt===0 视为「首次」→ 返回 true（由调用方随即置 lastAt=now）。
 */
export function shouldAdvance(now, lastAt, fps) {
  if (lastAt === 0) return true
  return now - lastAt >= 1000 / (fps > 0 ? fps : 1)
}

/**
 * 单一帧推进器（唯一实现，供渲染器复用，杜绝双源漂移）。
 * 输入 { mode, frame, dir, frames, blinkProb } 返回 { frame, dir }。
 *   loop：0→…→N-1→0；pingpong：0→…→N-1→…→0（内部维护 dir 翻转）；
 *   once：播完锁末帧；blink：常态锁帧0，按概率触发放一眼再回帧0。
 */
export function nextFrame(mode, frame, dir, frames, blinkProb = 0.03) {
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
export const RHYTHM_LEVELS = Object.freeze(['chill', 'normal', 'hyper'])

// 参数说明（单位 ms；数组 = [min, max] 随机区间）：
//   walkEvery  自发散步间隔；workEvery/ workDur 思考期「认真干活」插曲节奏；
//   waitEvery  待机 wiggle 变体轮换间隔；selfPlayEvery 自发玩耍间隔；blinkProb 眨眼概率/评估。
const RHYTHM = {
  chill:  { walkEvery: [20000, 30000], workEvery: [12000, 18000], workDur: [4000, 8000], waitEvery: [15000, 25000], selfPlayEvery: [25000, 40000], blinkProb: 0.02 },
  normal: { walkEvery: [10000, 18000], workEvery: [8000, 18000],  workDur: [4000, 8000], waitEvery: [10000, 18000], selfPlayEvery: [20000, 30000], blinkProb: 0.03 },
  hyper:  { walkEvery: [4000, 8000],   workEvery: [4000, 8000],   workDur: [4000, 8000], waitEvery: [6000, 10000],  selfPlayEvery: [8000, 14000],  blinkProb: 0.05 },
}

/** 取指定档位节奏参数（非法 level 回退 normal）。 */
export function pickRhythm(level = 'normal') {
  return RHYTHM[RHYTHM_LEVELS.includes(level) ? level : 'normal']
}

/** 在 [min, max] 内取随机浮点（闭区间）。 */
export function randIn(range) {
  const [min, max] = range
  return min + Math.random() * (max - min)
}