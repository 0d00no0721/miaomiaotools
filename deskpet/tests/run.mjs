// 极简断言跑测（node --test 会 spawn 子进程，sandbox 下 EPERM；用单进程直跑）。
import {
  pickState, STATE_NAMES, nextFrame, shouldAdvance, pickRhythm, randIn,
  SLEEP_AFTER_MS, DRAG_RELEASE_MS, ROUND_CELEBRATE_MS,
  WAKE_MS, JOY_MS, PLAY_MS, EAT_MS, WAIT_MS, WALK_MS,
} from '../client/logic.mjs'
import { parseCharacters, listCharacters, defaultCharacter, getCharacter, stateOf } from '../client/character.mjs'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ok  ', label) }
  else { fail++; console.log('  FAIL', label, '\n     got:', a, '\n   want:', e) }
}
function ok(v, label) { if (v) { pass++; console.log('  ok  ', label) } else { fail++; console.log('  FAIL', label) } }

const flatten = (o = {}) => ({
  dragging: false, dragReleaseUntil: 0, wakeUntil: 0, celebrateUntil: 0,
  joyUntil: 0, playUntil: 0, eatUntil: 0, walkUntil: 0, waitUntil: 0,
  sessionThink: false, workingActive: false, sleeping: false, now: Date.now(),
  ...o,
})

// ---- pickState：优先级 ----
eq(pickState(flatten({ dragging: true, sessionThink: true, workingActive: true, celebrateUntil: Date.now() + 500 })), 'drag', '拖拽最高优先级')
eq(pickState(flatten({ wakeUntil: Date.now() + 500 })), 'wake', '唤醒过渡')
eq(pickState(flatten({ celebrateUntil: Date.now() + 1000, sessionThink: true })), 'celebrate', '庆祝优先')
eq(pickState(flatten({ joyUntil: Date.now() + 500 })), 'joy', '开心态')
eq(pickState(flatten({ playUntil: Date.now() + 500 })), 'play', '玩耍态')
eq(pickState(flatten({ eatUntil: Date.now() + 500 })), 'eat', '进食态')
eq(pickState(flatten({ sessionThink: true, workingActive: true })), 'working', '思考期干活插曲')
eq(pickState(flatten({ sessionThink: true })), 'think', '思考态')
eq(pickState(flatten({ walkUntil: Date.now() + 500 })), 'walk', '散步态')
eq(pickState(flatten({ waitUntil: Date.now() + 500 })), 'wait', '待机变体')
eq(pickState(flatten({ sleeping: true })), 'sleep', '睡眠态')
eq(pickState(flatten()), 'idle', '默认 idle')
// 思考期压制自发行为（walk/wait 在 sessionThink 时回落到 think）
eq(pickState(flatten({ sessionThink: true, walkUntil: Date.now() + 500 })), 'think', '思考期压制散步')
eq(pickState(flatten({ sessionThink: true, waitUntil: Date.now() + 500 })), 'think', '思考期压制待机变体')

// ---- STATE_NAMES ----
eq([...STATE_NAMES], ['drag', 'wake', 'celebrate', 'joy', 'play', 'eat', 'working', 'think', 'walk', 'wait', 'sleep', 'idle'], '状态名集合')

// ---- nextFrame：各模式 ----
eq(nextFrame('loop', 0, 1, 3), { frame: 1, dir: 1 }, 'loop 前进')
eq(nextFrame('loop', 2, 1, 3), { frame: 0, dir: 1 }, 'loop 回绕')
eq(nextFrame('pingpong', 0, 1, 3), { frame: 1, dir: 1 }, 'pingpong 前进')
eq(nextFrame('pingpong', 2, -1, 3), { frame: 1, dir: -1 }, 'pingpong 上边界反转')
eq(nextFrame('pingpong', 1, -1, 3), { frame: 0, dir: 1 }, 'pingpong 下边界反转')
eq(nextFrame('pingpong', 0, 1, 1), { frame: 0, dir: 1 }, 'pingpong 单帧不越界')
eq(nextFrame('once', 1, 1, 3), { frame: 2, dir: 1 }, 'once 前进')
eq(nextFrame('once', 2, 1, 3), { frame: 2, dir: 1 }, 'once 锁末帧')

// ---- shouldAdvance：fps 门控 ----
ok(shouldAdvance(0, 0, 3) === true, '首次立即推进')
ok(shouldAdvance(1000, 0, 3) === true, 'lastAt=0 视为首次')
ok(shouldAdvance(333, 1, 3) === false, '未到帧间隔不推进（3fps 间隔 333.33ms）')
ok(shouldAdvance(400, 100, 3) === false, '仍是未到（间距 300ms）')
ok(shouldAdvance(500, 166, 3) === true, '达帧间隔推进')
ok(shouldAdvance(1000, 0, 0) === true, '非法 fps 回退')

// ---- pickRhythm / randIn ----
eq(pickRhythm('normal').blinkProb, 0.03, 'normal 档眨眼概率')
eq(pickRhythm('chill').walkEvery, [20000, 30000], 'chill 档散步间隔')
eq(pickRhythm('hyper').workEvery, [4000, 8000], 'hyper 档工作插曲间隔')
eq(pickRhythm('BOGUS').blinkProb, 0.03, '非法档位回退 normal')
{
  const [a, b] = [10, 20]
  let inRange = true
  for (let i = 0; i < 200; i++) {
    const v = randIn([a, b])
    if (v < a || v > b) { inRange = false; break }
  }
  ok(inRange, 'randIn 落在区间内')
}

// ---- 常量存在性（防止误删接线常量） ----
ok(SLEEP_AFTER_MS > 0 && DRAG_RELEASE_MS > 0 && ROUND_CELEBRATE_MS > 0, '核心常量存在')
ok(WAKE_MS > 0 && JOY_MS > 0 && PLAY_MS > 0 && EAT_MS > 0 && WAIT_MS > 0 && WALK_MS > 0, '扩展窗口常量存在')

// ---- character 层（回归） ----
{
  const m = { characters: { 'whale-girl': { name: '鲸鱼娘', states: { idle: { sheet: 'idle.png', frames: 3 } } }, cat: { name: '猫', states: {} } }, default: 'whale-girl' }
  eq(defaultCharacter(m), 'whale-girl', '多角色 default')
  eq(listCharacters(m), ['whale-girl', 'cat'], '多角色列表')
  eq(getCharacter(m, 'cat').name, '猫', '取角色')
  eq(stateOf(getCharacter(m, 'whale-girl'), 'idle').frames, 3, '取状态动画集')
}
{
  const m = { states: { idle: { sheet: 'idle.png', frames: 3 } } }
  eq(defaultCharacter(m), 'whale-girl', '旧简写 default')
  eq(getCharacter(m, 'whale-girl').states.idle.frames, 3, '旧简写取帧数')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)