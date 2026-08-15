// 路由前缀单一来源：client bundle（内联）与 Node half 共用。
// 改前缀只改这里；任何文件不得手写 '/deskpet/...' 字面量。
export const ROUTE_PREFIX = '/deskpet'
export const ASSETS_PATH = `${ROUTE_PREFIX}/assets`
export const STATE_PATH = `${ROUTE_PREFIX}/state`