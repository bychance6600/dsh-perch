/**
 * snapshot.js —— 账本重放的派生快照（2026-11-12）
 *
 * 为什么要有这个文件：deriveSelf 是纯函数，但 5 万条事件重放一次要 7 秒多。
 * AGENTS §19 的预算是「1 万条 < 700ms；5 万条起必须走快照」。快照不是新真相：
 * 它只是 deriveSelf 的一次输出，指纹对不上、文件坏了、条数不对，一律丢掉重放。
 *
 * 三条纪律：
 *   1. 只写派生结果，不写事件；events.jsonl 仍然只有 appendEvent 一个写入口。
 *   2. 白名单序列化：模型里出现未知字段、Map/Set、undefined、非有限数，宁可不写。
 *   3. 读快照命中时**不调用** timedDeriveSelf —— replaystat 只记真实重放。
 */

import { deriveSelf, clampInt } from './derive.js'
import { paths, readEvents, readJson, writeAtomic } from './store.js'
import { timedDeriveSelf } from './replaystat.js'

/**
 * deriveSelf 当前返回的顶层字段（lib/derive.js:1087）。
 * 加字段时必须同步这里；不同步的后果是快照写不出去（安全），而不是读到半个模型。
 */
export const SNAPSHOT_FIELDS = Object.freeze([
  'seed',
  'day',
  'stageSpanDays',
  'persona',
  'stage',
  'elapsedStage',
  'stageName',
  'name',
  'beliefs',
  'ranked',
  'solid',
  'tensions',
  'scars',
  'scarCount',
  'voices',
  'freshVoice',
  'beliefCount',
  'influence',
  'refuted',
  'refusals',
  'selfmodAttempts',
  'reunions',
  'corrected',
  'tested',
  'needs',
  'facts',
  'absenceDays',
  'narrative',
  'lastAbsence',
  'lastSeenAt',
  'lastWakeAt',
  'spokenSinceSeen',
  'heardSinceWake',
  'lastReunion',
  'stageGate',
  'stageForced',
])

const FIELD_SET = new Set(SNAPSHOT_FIELDS)

function localDayKey(now) {
  const d = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 快照指纹：条数、最后一条事件 id、本地日期、阶段跨度。
 *
 * 为什么带 dayKey：deriveSelf 的 day / ageDays 按「现在」算，跨天以后同一批事件
 * 可能得到不同模型；只按条数做指纹会把昨天的她当成今天的。
 * 为什么带 stageSpanDays：它是 deriveSelf 的参数，改设置就得重算。
 *
 * 算不出来（空账本 / 最后一条没 id / now 非法）返回 null，调用方据此不写快照。
 */
export function snapshotFingerprint(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return null
  const last = events[events.length - 1]
  const id = last && last.id != null ? String(last.id) : ''
  if (!id) return null
  const dayKey = localDayKey(opts.now ?? Date.now())
  if (!dayKey) return null
  const stageSpanDays = clampInt(opts.stageSpanDays ?? 30, 7, 180, 30)
  return `${events.length}:${id}:${dayKey}:${stageSpanDays}`
}

function walkModel(value, path) {
  if (value === null) return
  const t = typeof value
  if (t === 'string' || t === 'boolean') return
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} 不是有限数`)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walkModel(value[i], `${path}[${i}]`)
    return
  }
  if (t === 'object') {
    if (value instanceof Map || value instanceof Set || value instanceof Date) {
      throw new Error(`${path} 不是普通 JSON 值`)
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${path} 的原型不是普通对象`)
    }
    for (const [k, v] of Object.entries(value)) walkModel(v, `${path}.${k}`)
    return
  }
  throw new Error(`${path} 是 ${t}，不能序列化`)
}

/**
 * 白名单式校验模型。只接受 deriveSelf 的 36 个字段，字段一个不能少、一个不能多；
 * 任何 Map/Set/Date/undefined/NaN 都抛。返回原对象（不克隆：JSON.parse 出来已经是新对象）。
 */
export function snapshotModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error('模型不是对象')
  }
  for (const key of Object.keys(model)) {
    if (!FIELD_SET.has(key)) throw new Error(`模型多出字段 ${key}`)
  }
  for (const key of SNAPSHOT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(model, key)) {
      throw new Error(`模型缺少字段 ${key}`)
    }
    walkModel(model[key], key)
  }
  return model
}

/**
 * 写快照。任何失败都返回 { ok:false }，不抛、不留下半份文件——
 * 调用方（rebuild / 测试 / 将来的启动路径）照常重放即可。
 */
export async function writeSnapshot(root, model, events, opts = {}) {
  const fingerprint = snapshotFingerprint(events, opts)
  if (!fingerprint) return { ok: false, reason: 'no-fingerprint' }
  let safeModel
  try {
    safeModel = snapshotModel(model)
  } catch (err) {
    return { ok: false, reason: 'bad-model', error: String(err?.message ?? err) }
  }
  const payload = {
    v: 1,
    fingerprint,
    events: events.length,
    dayKey: localDayKey(opts.now ?? Date.now()),
    stageSpanDays: clampInt(opts.stageSpanDays ?? 30, 7, 180, 30),
    builtAt: new Date().toISOString(),
    model: safeModel,
  }
  let text
  try {
    text = JSON.stringify(payload)
  } catch (err) {
    return { ok: false, reason: 'serialize', error: String(err?.message ?? err) }
  }
  try {
    await writeAtomic(paths(root).snapshot, text, 0o600)
    return { ok: true, fingerprint, bytes: Buffer.byteLength(text) }
  } catch (err) {
    return { ok: false, reason: 'write', error: String(err?.message ?? err) }
  }
}

function snapshotProblem(snap, events, fingerprint) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return 'bad-shape'
  if (snap.v !== 1) return 'bad-version'
  if (!Number.isInteger(snap.events)) return 'bad-count'
  // 账本只会追加；快照记的条数比实际多，说明它来自另一份/未来的账本。
  if (snap.events > events.length) return 'stale-count'
  if (snap.events !== events.length) return 'count-mismatch'
  if (snap.fingerprint !== fingerprint) return 'fingerprint-mismatch'
  return null
}

/**
 * 读模型：先查快照，命中就直接返回；否则走 timedDeriveSelf（真实重放）。
 *
 * @returns {Promise<object>} deriveSelf 形状的模型
 */
export async function readModel(root, opts = {}) {
  const meta = await readModelMeta(root, opts)
  return meta.model
}

/**
 * 同 readModel，但多返回 fromSnapshot / reason / fingerprint，给 bench 与测试看命中路径。
 * 命中快照时绝不调用 timedDeriveSelf：否则「上次重放」会被读快照的耗时污染。
 */
export async function readModelMeta(root, opts = {}) {
  const { events } = await readEvents(root)
  const fingerprint = snapshotFingerprint(events, opts)

  if (fingerprint) {
    let snap = null
    try {
      snap = await readJson(paths(root).snapshot, null)
    } catch {
      // 读不了（权限/IO）就当没有快照；重放仍然可用。
      snap = null
    }
    const problem = snapshotProblem(snap, events, fingerprint)
    if (!problem) {
      try {
        const model = snapshotModel(snap.model)
        return { model, fromSnapshot: true, reason: 'hit', fingerprint }
      } catch {
        // 模型字段不对：快照作废，下面重放。
      }
    }
    const model = timedDeriveSelf(events, opts)
    const wrote = await persistIfAsked(root, model, events, opts)
    return {
      model,
      fromSnapshot: false,
      reason: problem ?? 'bad-model',
      fingerprint,
      wrote,
    }
  }

  const model = timedDeriveSelf(events, opts)
  const wrote = await persistIfAsked(root, model, events, opts)
  return { model, fromSnapshot: false, reason: 'no-fingerprint', fingerprint: null, wrote }
}

/**
 * 启动路径要能自己把快照补上：否则生产里永远只有 bench 会写快照。
 * 只在 opts.persist 为 true 且这次是真的重放（miss）时调用；命中时绝不写。
 */
async function persistIfAsked(root, model, events, opts) {
  if (!opts.persist) return null
  const wrote = await writeSnapshot(root, model, events, opts)
  return wrote.ok ? 'written' : wrote.reason
}

/** 方便自检：快照里的条数（坏文件/没有都返回 null）。 */
export async function snapshotEvents(root) {
  try {
    const snap = await readJson(paths(root).snapshot, null)
    return Number.isInteger(snap?.events) ? snap.events : null
  } catch {
    return null
  }
}
