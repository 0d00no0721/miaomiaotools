// 角色清单解析层：manifest 角色索引的纯函数读面（无 DOM，可单测）。
// manifest 形状：{ characters: { <id>: { name?, states } }, default }；
// 兼容旧顶层 states 简写 = 单角色。
export const DEFAULT_ROLE_ID = 'whale-girl'

/** 角色 id 合法字符集（URL 路径安全）。 */
export const ROLE_ID_RE = /^[a-z0-9-]+$/

/** 从 manifest 提取角色索引。返回 { characters, defaultId, order }。 */
export function parseCharacters(manifest) {
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

export function listCharacters(manifest) {
  return parseCharacters(manifest).order
}

export function defaultCharacter(manifest) {
  return parseCharacters(manifest).defaultId
}

export function getCharacter(manifest, id) {
  return parseCharacters(manifest).characters[id] ?? null
}

/** 取某状态的动画集（sheet/frames/fps/playback）；缺失返回 undefined。 */
export function stateOf(character, stateName) {
  return character?.states?.[stateName]
}