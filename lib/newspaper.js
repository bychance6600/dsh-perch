/**
 * newspaper.js —— 报纸层的两本账：判重表与执行记录（A24，2026-11-07）
 *
 * 借的是 bili-duty（MIT）的做法，但只借账本，不借它的「值不值得看」评分：
 *   - `seen.md` 判重表：每推一条写一行。事件流仍然是真相源，这本表是
 *     第二道账——事件流读坏了、被重置了，也不会因此把刚看过的又端回来。
 *   - `runs.md` 执行记录：每轮一行，**失败也写**。出了事能回答「那一轮
 *     到底扫了几条、为什么一条都没收」。
 *
 * 三条硬规矩：
 *   1. 判重表读不出来（坏行、没权限）→ 返回 ok:false，调用方必须停下这一轮。
 *      绝不能把「读不出来」当成「没记录过」——那等于把她看过的全部重推一遍。
 *   2. 时间读不出来的老行按「还算看过」处理（和 browse.seenBvids 同一条原则）。
 *   3. 这里写的「为什么值得 / 依据来源」只进账本，**不进她看到的素材**。
 *      代码不替她想，账本只是把选它的机械理由留给人看。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const SEEN_FILE = 'seen.md'
export const RUNS_FILE = 'runs.md'

const SEEN_HEAD = `# 判重表

<!-- 一行一条：- BV号 | 时间 | 处置 | 理由。手工改也行；改坏了这一轮会停，不会当成没记过。 -->

`

const RUNS_HEAD = `# 执行记录

<!-- 每轮一行，失败也写。字段：时间 | 触发 | 结果 | 扫描 | 收取 | 跳过 | 无字幕 | 备注 -->

`

const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '／').trim().slice(0, max)
const validId = (s) => /^[A-Za-z0-9_-]{1,40}$/.test(String(s ?? ''))

/** 本地「YYYY-MM-DD HH:MM:SS」，给人读的 */
function stamp(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 读判重表。
 * @returns {Promise<{ok:boolean, ids:Set<string>, rows:object[], malformed:number, error?:string, file:string}>}
 *   ids 是仍在判重窗口内的；rows 是全表（老行留作历史，不删）。
 */
export async function readSeen(root, o = {}) {
  const file = root ? join(root, SEEN_FILE) : ''
  if (!root) return { ok: false, ids: new Set(), rows: [], malformed: 0, error: '没有数据目录', file }
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    // 第一次跑还没有这本表：空表是正常的，不是读坏了。
    if (err?.code === 'ENOENT') return { ok: true, ids: new Set(), rows: [], malformed: 0, file }
    return { ok: false, ids: new Set(), rows: [], malformed: 0, error: String(err?.message ?? err), file }
  }
  const days = Number.isFinite(Number(o.days)) ? Number(o.days) : 0
  const now = Number(o.now ?? Date.now())
  const ttl = days > 0 ? days * 86400000 : 0
  const rows = []
  const ids = new Set()
  let malformed = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('<!--')) continue
    if (!line.startsWith('- ')) { malformed += 1; continue }
    const parts = line.slice(2).split('|').map((s) => s.trim())
    if (parts.length < 4 || !validId(parts[0])) { malformed += 1; continue }
    const [id, at, action, why] = parts
    const ms = Date.parse(at)
    const row = { id, at, action, why, ms: Number.isFinite(ms) ? ms : 0 }
    rows.push(row)
    // 时间读不出来 → 按「还算看过」；读得出来且超出窗口 → 只留在历史里。
    if (ttl > 0 && row.ms > 0 && now - row.ms > ttl) continue
    ids.add(id)
  }
  if (malformed > 0) {
    return { ok: false, ids: new Set(), rows, malformed, error: `${SEEN_FILE} 有 ${malformed} 行读不出来`, file }
  }
  return { ok: true, ids, rows, malformed: 0, file }
}

/**
 * 往判重表里追加。entries: [{id, at?, action?, why?}]
 * 永不抛出。
 */
export async function appendSeen(root, entries, o = {}) {
  const file = root ? join(root, SEEN_FILE) : ''
  if (!root) return { ok: false, file, error: '没有数据目录' }
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && validId(e.id))
  if (!list.length) return { ok: true, file }
  const at = new Date(Number(o.now ?? Date.now())).toISOString()
  const lines = list.map((e) => {
    const when = e.at ? clean(e.at, 40) : at
    return `- ${e.id} | ${when} | ${clean(e.action ?? 'push', 20)} | ${clean(e.why, 120)}`
  }).join('\n') + '\n'
  try {
    await fs.mkdir(root, { recursive: true })
    let exists = true
    try { await fs.access(file) } catch { exists = false }
    await fs.appendFile(file, (exists ? '' : SEEN_HEAD) + lines, 'utf8')
    return { ok: true, file }
  } catch (err) {
    return { ok: false, file, error: String(err?.message ?? err) }
  }
}

/**
 * 往执行记录里追加一轮。失败也写。
 * row: {now?, trigger?, result?, scanned?, picked?, skipped?, noSub?, note?, items?:[{id,why,basis}]}
 * 永不抛出。
 */
export async function appendRun(root, row = {}) {
  const file = root ? join(root, RUNS_FILE) : ''
  if (!root) return { ok: false, file, error: '没有数据目录' }
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
  const trigger = ({ manual: '手动', wake: '醒来', forced: '手动' })[String(row.trigger ?? '')] ?? '醒来'
  const head = `- ${stamp(row.now)} | ${clean(trigger, 20)} | ${clean(row.result ?? '未知', 30)} | ` +
    `扫描 ${n(row.scanned)} | 收取 ${n(row.picked)} | 跳过 ${n(row.skipped)} | 无字幕 ${n(row.noSub)} | ` +
    `备注：${clean(row.note, 160) || '—'}`
  const items = (Array.isArray(row.items) ? row.items : []).map((it) =>
    `  - ${clean(it.id, 40)} 为什么值得：${clean(it.why, 120) || '—'}｜依据来源：${clean(it.basis, 80) || '仅标题'}`)
  // 「因无字幕跳过 N 条」：这一层（报纸）不读字幕，N 只可能是 0。
  // 只在真收了东西的那一轮写这句，免得失败记录里也挂一句解释。
  if (items.length) items.push(`  - 无字幕跳过 ${n(row.noSub)} 条（这一层不读字幕，0 = 没有一条因此被跳过）`)
  const block = head + '\n' + items.join('\n') + '\n\n'
  try {
    await fs.mkdir(root, { recursive: true })
    let exists = true
    try { await fs.access(file) } catch { exists = false }
    await fs.appendFile(file, (exists ? '' : RUNS_HEAD) + block, 'utf8')
    return { ok: true, file }
  } catch (err) {
    return { ok: false, file, error: String(err?.message ?? err) }
  }
}
