/**
 * replaystat.js —— 记「最近一次从事件流重放」花了多久（2026-11-12）
 *
 * 为什么单独一个文件：`deriveSelf` 是纯函数，改它会让「同一批事件永远算出同一个模型」
 * 这件事多出一个副作用（而且另有人在改 derive.js，容易冲突）。计时放在调用侧，
 * 只关心「这次调用花了多少毫秒」，结果给数据页的「上次重放」一行看。
 *
 * 只记最近一次，不做平均、不落盘：它回答的是「现在盘里这份账本重放一次要多久」，
 * 不是性能报表。进程重启后归零，第一次重放之前读取方拿到 0，界面显示「—」。
 */

import { performance } from 'node:perf_hooks'
import { deriveSelf } from './derive.js'

let lastMs = 0
let lastAt = 0

/** 调一次 deriveSelf，顺手记下耗时（毫秒，取整）。 */
export function timedDeriveSelf(events, opts) {
  const t0 = performance.now()
  const model = deriveSelf(events, opts)
  const ms = performance.now() - t0
  lastMs = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
  lastAt = Date.now()
  return model
}

/** 最近一次的毫秒数；还没重放过就是 0。 */
export function lastReplayMs() {
  return lastMs
}

/** 最近一次发生在什么时候（ms 时间戳）；还没重放过就是 0。界面据此区分「0ms」与「没有值」。 */
export function lastReplayAt() {
  return lastAt
}

/** 测试用：把记录清回「还没重放过」。 */
export function resetReplayStat() {
  lastMs = 0
  lastAt = 0
}
