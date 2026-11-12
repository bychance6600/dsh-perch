#!/usr/bin/env node
/**
 * recall-bench.mjs —— literal / ranked 两档召回的对照表（P3 验收工装）
 *
 * 为什么要有这个文件：P3 要换 relevance（同义词 + BM25），但「换了之后她记不记得
 * 以前能记起的事」在沙箱里自证不了。这份工具不产出结论，只产出一张**能重复跑**的
 * 对照表：同一条 query，分别在 literal 与 ranked 下召回什么、命中几条期望、各花多久。
 *
 * 数据不进仓库（AGENTS §19 与 samples/README 的规矩）：账本与问卷都放在
 * ~/.dsh-perch-samples/ 下，本文件只读、不写、不联网。
 *
 * 口径（P3 没落地之前先这样，落地后自动接上）：
 *   literal = searchEvents(..., { weigh: false, mode: 'literal' })
 *   ranked  = searchEvents(..., { weigh: true, solidIds, mode: 'ranked' })
 *   - 现在 searchEvents 只认 weigh，mode 会被忽略；P3 落地后它认 mode 就自动生效。
 *   - 若 lib/search-index.js 导出 expandQuery / synonymsOf，main 会把它接到 ranked
 *     一侧当同义词扩展（文件不存在时静默退回纯 weigh）。
 *
 * 用法：
 *   node tools/recall-bench.mjs                 # 默认读 ~/.dsh-perch-samples/
 *   node tools/recall-bench.mjs --diff          # 只打 literal / ranked 不一致的行
 *   node tools/recall-bench.mjs --json
 *   node tools/recall-bench.mjs --root <dir> --queries <file> --limit 8
 *
 * 返回码：0 = 跑完；1 = 参数/文件错。
 */
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { searchEvents, solidIdsOf, tokensOf } from '../lib/recall.js'

export const DEFAULT_ROOT = join(homedir(), '.dsh-perch-samples')
export const DEFAULT_LIMIT = 8
/** 每条 query 在屏幕上只打前几条（完整结果看 --json） */
export const SHOW_ROWS = 3
/** 每行正文最多多少字 */
export const SNIPPET = 40

function fail(msg) {
  const err = new Error(msg)
  err.userFacing = true
  return err
}

/**
 * 参数解析。不引第三方库（零依赖铁律），也不做「猜」：
 * 认不出的参数直接报错，免得打错一个字母却静默按默认值跑。
 *
 * @param {string[]} argv
 * @param {{root?:string, env?:Record<string,string|undefined>}} o
 */
export function parseArgs(argv = process.argv.slice(2), o = {}) {
  const out = {
    root: o.root ?? DEFAULT_ROOT,
    queriesPath: '',
    limit: DEFAULT_LIMIT,
    json: false,
    diff: false,
    mode: 'both',
    p5: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--root') {
      const v = argv[++i]
      if (!v) throw fail('--root 后面要跟一个目录')
      out.root = v
    } else if (a === '--queries') {
      const v = argv[++i]
      if (!v) throw fail('--queries 后面要跟一个文件')
      out.queriesPath = v
    } else if (a === '--limit') {
      const v = argv[++i]
      if (!v) throw fail('--limit 后面要跟一个数')
      out.limit = Number(v)
    } else if (a === '--json') {
      out.json = true
    } else if (a === '--mode') {
      const v = argv[++i]
      if (!['literal', 'ranked', 'both'].includes(v)) throw fail('--mode 只认 literal / ranked / both')
      out.mode = v
    } else if (a === '--diff') {
      out.diff = true
    } else if (a === '--p5') {
      out.p5 = true
    } else if (a === '--help' || a === '-h') {
      out.help = true
    } else {
      throw fail(`不认识的参数：${a}（--help 看用法）`)
    }
  }
  out.root = resolve(out.root)
  out.queriesPath = out.queriesPath ? resolve(out.queriesPath) : join(out.root, 'queries.jsonl')
  const n = Number(out.limit)
  if (!Number.isFinite(n) || n < 1 || n > 20) throw fail('--limit 要在 1–20 之间（默认 8）')
  out.limit = Math.floor(n)
  out.modes = out.mode === 'both' ? ['literal', 'ranked'] : [out.mode]
  return out
}

/**
 * 解析问卷正文。每行一条 {"q":"...","expect":["事件id"]}；空行与 # 注释跳过。
 * 报错带行号，别让人对着 30 行 JSON 猜哪条坏了。
 *
 * @param {string} text
 * @param {string} source 只用于报错信息
 */
export function parseQueries(text, source = 'queries.jsonl') {
  const out = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      throw fail(`${source}:${i + 1} 不是合法 JSON（每行一条）：${line.slice(0, 80)}`)
    }
    const q = typeof obj?.q === 'string' ? obj.q.trim() : ''
    if (!q) throw fail(`${source}:${i + 1} 少了 "q"（要一条非空的问题）`)
    const expect = obj?.expect === undefined ? [] : obj.expect
    if (!Array.isArray(expect) || expect.some((x) => typeof x !== 'string' || !x.trim())) {
      throw fail(`${source}:${i + 1} 的 "expect" 要是字符串数组，可以是空数组`)
    }
    out.push({ q, expect: expect.map((x) => x.trim()) })
  }
  if (!out.length) throw fail(`${source} 里一条 query 都没有`)
  return out
}

/** 读问卷文件。缺文件时报清楚：找的是哪、要什么格式、数据该放哪。 */
export function readQueries(path) {
  if (!existsSync(path)) {
    throw fail(
      `找不到问卷文件：${path}\n` +
        '  它是本地验收数据，不进仓库；每行一条：{\"q\":\"你想问的\",\"expect\":[\"ev_...\"]}\n' +
        `  也可以显式指定：--queries <file>（默认 <root>/queries.jsonl，root 默认 ${DEFAULT_ROOT}）`,
    )
  }
  return parseQueries(readFileSync(path, 'utf8'), path)
}

/** 读账本。一行一条事件；坏行说明行号。 */
export function readEventsFile(path) {
  if (!existsSync(path)) {
    throw fail(`找不到账本：${path}\n  它是一行一条事件的 JSONL；验收数据放 ${DEFAULT_ROOT}，不进仓库`)
  }
  const events = []
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      throw fail(`${path}:${i + 1} 不是合法 JSON`)
    }
  }
  if (!events.length) throw fail(`账本里没有事件：${path}`)
  return events
}

/**
 * 两档的检索参数。mode 字段现在 searchEvents 还不认，先传着，
 * 等 P3 认了就不用改这里——这是这一层唯一的目的。
 */
export function optionsFor(mode, { limit = DEFAULT_LIMIT, solidIds } = {}) {
  if (mode === 'literal') return { limit, weigh: false, mode: 'literal' }
  return { limit, weigh: true, solidIds, mode: 'ranked' }
}

/**
 * 同义词扩展的接入口：P3 的 lib/search-index.js 里若导出 expandQuery（或 synonymsOf），
 * 就用它给 ranked 侧补几条改写过的问题。文件不在就是 null——今天的 ranked 只叠显著性。
 * @returns {Promise<((q:string)=>string[])|null>}
 */
export async function loadExpander() {
  try {
    const m = await import('../lib/search-index.js')
    const fn = m.expandQuery ?? m.synonymsOf ?? null
    return typeof fn === 'function' ? fn : null
  } catch {
    return null
  }
}

/** 把改写出来的几条结果的并集按「被几条 query 命中」排一下（工装侧的近似，不是产品逻辑） */
function mergeVariantRows(groups, limit) {
  const seen = new Map()
  groups.forEach((rows, gi) => {
    for (const r of rows) {
      const id = String(r.id ?? '')
      if (!id) continue
      const cur = seen.get(id)
      if (cur) cur.weight += 1
      else seen.set(id, { row: r, weight: 1, order: gi })
    }
  })
  return [...seen.values()]
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.row)
}

/**
 * 跑一条 query 的一档。
 *
 * @param {object[]} events
 * @param {{q:string, expect?:string[]}} item
 * @param {{mode:'literal'|'ranked', limit?:number, now?:number, solidIds?:Set<string>|string[],
 *          expand?:(q:string)=>string[]|null}} o
 * @returns {{rows:object[], ids:string[], hits:number, ms:number}}
 */
export function runOne(events, item, o = {}) {
  const mode = o.mode === 'literal' ? 'literal' : 'ranked'
  const limit = o.limit ?? DEFAULT_LIMIT
  const now = o.now ?? Date.now()
  const base = optionsFor(mode, { limit, solidIds: o.solidIds })
  const t0 = performance.now()
  let rows
  const variants = mode === 'ranked' && typeof o.expand === 'function'
    ? (o.expand(item.q) ?? []).filter((x) => typeof x === 'string' && x.trim() && x.trim() !== item.q)
    : []
  if (!variants.length) {
    rows = searchEvents(events, item.q, { ...base, now }).rows
  } else {
    const groups = [searchEvents(events, item.q, { ...base, now }).rows]
    for (const v of variants) groups.push(searchEvents(events, v.trim(), { ...base, now }).rows)
    rows = mergeVariantRows(groups, limit)
  }
  const ms = performance.now() - t0
  const ids = rows.map((r) => String(r.id ?? ''))
  const expect = Array.isArray(item.expect) ? item.expect : []
  const hits = expect.filter((id) => ids.includes(id)).length
  return { rows, ids, hits, ms }
}


/* ------------------------------------------------------------------ *
 * P5 记忆链接（M4）的对照：literal / ranked(links 关) / ranked(links 开)
 *
 * 真值口径在 docs/新版本-记忆.md 的 M4：
 *   - 对每条 belief 算 Dice，取 top-3 且 >= 0.35；
 *   - 召回命中后，把 links 里的判断以 0.5 权重加进结果；
 *   - links 算在独立缓存里，不进 derive 主路径。
 *
 * 如果 lib/links.js 已经落地（且 lib/recall.js 认得 links 开关），这里直接用产品
 * 的实现；没落地时用下面这份**工装侧参考实现**先把三列跑通——它只在内存里算，
 * 不写账本、不改产品，报告开头会写明这一列不是产品结果。
 * ------------------------------------------------------------------ */

/** 1 跳扩散的权重（M4 口径） */
export const LINKS_WEIGHT = 0.5
/** 建链接的最低 Dice（M4 口径） */
export const LINKS_MIN_DICE = 0.35
/** 每条最多几条链接（M4 口径） */
export const LINKS_MAX = 3

/** 参与建链接的类型：她自己的判断（belief）；听到的话不算「判断」 */
export const LINKS_TYPES = new Set(['utterance', 'revise'])

/** Dice 系数：链接的相似度口径 */
export function diceOf(a, b) {
  const A = new Set(a ?? [])
  const B = new Set(b ?? [])
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  // 必须共享至少一个非停用片段；没有交集就不算相关（M4 硬约束）
  if (!inter) return 0
  return (2 * inter) / (A.size + B.size)
}

/**
 * 参考实现：按 M4 口径给每条判断建 links。
 * @param {object[]} events
 * @param {{minDice?:number, maxLinks?:number}} o
 * @returns {Map<string,string[]>}
 */
export function buildLinks(events = [], o = {}) {
  const minDice = o.minDice ?? LINKS_MIN_DICE
  const maxLinks = o.maxLinks ?? LINKS_MAX
  const items = []
  for (const ev of events ?? []) {
    if (!ev || !LINKS_TYPES.has(ev.type)) continue
    const toks = tokensOf(ev.text)
    if (toks.length < 2) continue
    items.push({ id: String(ev.id ?? ''), toks, ts: Date.parse(ev.ts) || 0 })
  }
  // 倒排：只算「至少共享一个片段」的对。全量两两在千条账本上要好几秒，
  // 产品要求 links 首次 < 2s，工装得先能在这个量级上跑得动。
  const index = new Map()
  items.forEach((it, i) => {
    for (const t of it.toks) {
      const arr = index.get(t)
      if (arr) arr.push(i)
      else index.set(t, [i])
    }
  })
  const out = new Map()
  for (let i = 0; i < items.length; i += 1) {
    const inter = new Map()
    for (const t of items[i].toks) {
      for (const j of index.get(t) ?? []) {
        if (j !== i) inter.set(j, (inter.get(j) ?? 0) + 1)
      }
    }
    const cand = []
    for (const [j, n] of inter) {
      const d = (2 * n) / (items[i].toks.length + items[j].toks.length)
      if (d >= minDice) cand.push({ id: items[j].id, d, ts: items[j].ts })
    }
    cand.sort((a, b) => b.d - a.d || b.ts - a.ts || (a.id < b.id ? -1 : 1))
    if (cand.length) out.set(items[i].id, cand.slice(0, maxLinks).map((x) => x.id))
  }
  return out
}

/**
 * 产品的 links 模块落地了没有。只看两件事：
 *   1) lib/links.js 能 import 且导出 buildLinks；
 *   2) lib/recall.js 的源码里出现 links（说明 searchEvents 认这个开关）。
 * 两条都满足才走产品实现；否则用参考实现，并在报告里说清楚。
 */
export async function loadLinksSupport() {
  let build = null
  try {
    const m = await import('../lib/links.js')
    if (typeof m.buildLinks === 'function') build = m.buildLinks
  } catch {
    build = null
  }
  let recallKnows = false
  try {
    recallKnows = /links/.test(readFileSync(new URL('../lib/recall.js', import.meta.url), 'utf8'))
  } catch {
    recallKnows = false
  }
  if (build && recallKnows) return { kind: 'lib', build, recallKnows }
  return { kind: 'reference', build: buildLinks, recallKnows }
}

function localDay(ts) {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

/**
 * 参考实现的「1 跳扩散」：命中之后把 links 里的判断以 0.5 权重挂到结果后面。
 * searchEvents 不吐分数，所以这里按「父条目在结果里的先后」挂——工装侧近似，
 * 只用来先量「会不会变差」，不是产品的排序。
 *
 * @param {object[]} events
 * @param {object[]} baseRows 基础召回（多取一些，留出被挤掉的空间）
 * @param {Map<string,string[]>} links
 */
export function spreadLinkedRows(events, baseRows, links, { limit = DEFAULT_LIMIT, now = Date.now() } = {}) {
  const byId = new Map((events ?? []).map((e) => [String(e?.id ?? ''), e]))
  const seen = new Set()
  const out = []
  const toRow = (ev, ts, related) => {
    const text = String(ev.text ?? '')
    return {
      id: String(ev.id ?? ''),
      date: localDay(ts),
      ago: Math.max(0, Math.floor((now - ts) / 86_400_000)),
      type: String(ev.type ?? ''),
      text: text.length > 200 ? text.slice(0, 199) + '…' : text,
      related,
    }
  }
  // 挂的位置是「紧跟在带出它的那条后面」：0.5 权重低于父条目，但仍在结果里，
  // 不是全排在队尾（那样后取 limit 时会被整段裁掉，等于没接上）。
  outer: for (const r of baseRows) {
    if (!seen.has(r.id)) {
      seen.add(r.id)
      out.push(r)
    }
    if (out.length >= limit) break
    for (const id of links.get(r.id) ?? []) {
      if (seen.has(id)) continue
      const ev = byId.get(id)
      if (!ev || ev.type === 'meta') continue
      const ts = Date.parse(ev.ts)
      if (!Number.isFinite(ts)) continue
      seen.add(id)
      out.push(toRow(ev, ts, r.id))
      if (out.length >= limit) break outer
    }
  }
  return out.slice(0, limit)
}

/**
 * 跑一条 query 的三档。
 *
 * @param {object[]} events
 * @param {{q:string, expect?:string[]}} item
 * @param {{limit?:number, now?:number, solidIds?:Set<string>|string[],
 *          expand?:(q:string)=>string[]|null, links?:Map<string,string[]>,
 *          linksKind?:'lib'|'reference'}} o
 */
export function runP5One(events, item, o = {}) {
  const limit = o.limit ?? DEFAULT_LIMIT
  const now = o.now ?? Date.now()
  const solidIds = o.solidIds
  const expect = Array.isArray(item.expect) ? item.expect : []
  const hitsOf = (ids) => expect.filter((id) => ids.includes(id)).length

  const literal = runOne(events, item, { limit, now, mode: 'literal' })
  const linksOff = runOne(events, item, { limit, now, mode: 'ranked', solidIds, expand: o.expand })

  let linksOn
  if (o.linksKind === 'lib') {
    const t0 = performance.now()
    const rows = searchEvents(events, item.q, {
      ...optionsFor('ranked', { limit, solidIds }),
      now,
      links: true,
    }).rows
    const ms = performance.now() - t0
    const ids = rows.map((r) => String(r.id ?? ''))
    linksOn = { rows, ids, ms, hits: hitsOf(ids) }
  } else {
    const t0 = performance.now()
    // 基础召回多取一点，给扩散腾位置；扩散后再裁到 limit
    const base = runOne(events, item, {
      limit: Math.min(20, limit * 3),
      now,
      mode: 'ranked',
      solidIds,
      expand: o.expand,
    })
    const rows = spreadLinkedRows(events, base.rows, o.links ?? new Map(), { limit, now })
    const ms = performance.now() - t0
    const ids = rows.map((r) => String(r.id ?? ''))
    linksOn = { rows, ids, ms, hits: hitsOf(ids) }
  }

  return {
    q: item.q,
    expect,
    literal,
    linksOff,
    linksOn,
    sameOffOn: JSON.stringify(linksOff.ids) === JSON.stringify(linksOn.ids),
    top1: {
      literal: literal.ids[0] ?? '',
      linksOff: linksOff.ids[0] ?? '',
      linksOn: linksOn.ids[0] ?? '',
    },
  }
}

/**
 * 跑整份问卷的三列。
 *
 * @param {object[]} events
 * @param {{q:string, expect?:string[]}[]} queries
 * @param {{limit?:number, now?:number, links?:Map<string,string[]>,
 *          linksKind?:'lib'|'reference', expand?:(q:string)=>string[]|null}} o
 */
export function runP5(events, queries, o = {}) {
  const limit = o.limit ?? DEFAULT_LIMIT
  const now = o.now ?? Date.now()
  const solidIds = o.solidIds ?? solidIdsOf(events)
  const linksKind = o.linksKind ?? 'reference'
  const links = o.links ?? (linksKind === 'lib' ? new Map() : buildLinks(events))
  const rows = queries.map((item) =>
    runP5One(events, item, { limit, now, solidIds, expand: o.expand, links, linksKind }),
  )
  const expected = rows.reduce((n, r) => n + r.expect.length, 0)
  const side = (key) => {
    const hits = rows.reduce((n, r) => n + r[key].hits, 0)
    const times = rows.map((r) => r[key].ms)
    return {
      hits,
      hitRate: expected ? hits / expected : null,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
    }
  }
  const summary = {
    n: rows.length,
    expected,
    literal: side('literal'),
    linksOff: side('linksOff'),
    linksOn: side('linksOn'),
  }
  return { n: rows.length, expected, limit, linksKind, rows, summary, regressions: findRegressions(rows) }
}

/**
 * 「links 开不许变差」的判定：对每条 query 的每个 expect id 比位次。
 * 只有当 expect 非空时才有意义；真账本的问卷 expect 是空的，就只列 top1 差异。
 *
 * @param {{q:string, expect:string[], linksOff:object, linksOn:object}[]} rows
 * @returns {{i:number, q:string, expect:string, offPos:number, onPos:number, worse:boolean,
 *            dropped:string[]}[]}
 */
export function findRegressions(rows) {
  const out = []
  rows.forEach((r, idx) => {
    const expect = Array.isArray(r.expect) ? r.expect : []
    if (!expect.length) return
    const offIds = r.linksOff.ids
    const onIds = r.linksOn.ids
    for (const id of expect) {
      // 被挤掉的其它条目；期望的那条自己由「位次 → 未命中」说，不重复列
      const dropped = offIds.filter((x) => !onIds.includes(x) && x !== id)
      const offPos = offIds.indexOf(id) // -1 = 没命中
      const onPos = onIds.indexOf(id)
      if (onPos < 0 && offPos < 0) continue
      // 变差 = 从命中变成没命中，或位次后退
      const worse = onPos < 0 || (offPos >= 0 && onPos > offPos)
      if (worse) out.push({ i: idx + 1, q: r.q, expect: id, offPos, onPos, worse, dropped })
    }
  })
  return out
}

/** 最近秩百分位：小样本也不至于像线性插值那样给出一个「不存在的数」 */
export function percentile(values, p) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y)
  if (!a.length) return null
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))
  return a[idx]
}

/**
 * 跑整份问卷：每条 query 两档各跑一次，汇总条数、命中率、p50 / p95。
 *
 * @param {object[]} events
 * @param {{q:string, expect?:string[]}[]} queries
 * @param {{limit?:number, now?:number, solidIds?:Set<string>|string[], expand?:(q:string)=>string[]|null}} o
 */
export function runBench(events, queries, o = {}) {
  const limit = o.limit ?? DEFAULT_LIMIT
  const now = o.now ?? Date.now()
  const solidIds = o.solidIds ?? solidIdsOf(events)
  const rows = queries.map((item) => {
    const literal = runOne(events, item, { limit, now, mode: 'literal' })
    const ranked = runOne(events, item, { limit, now, mode: 'ranked', solidIds, expand: o.expand })
    const expect = Array.isArray(item.expect) ? item.expect : []
    const sameTop = JSON.stringify(literal.ids.slice(0, SHOW_ROWS)) === JSON.stringify(ranked.ids.slice(0, SHOW_ROWS))
    return { q: item.q, expect, literal, ranked, sameTop }
  })

  const expected = rows.reduce((n, r) => n + r.expect.length, 0)
  const side = (mode) => {
    const hits = rows.reduce((n, r) => n + r[mode].hits, 0)
    const times = rows.map((r) => r[mode].ms)
    return {
      hits,
      hitRate: expected ? hits / expected : null,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
    }
  }
  return {
    n: rows.length,
    expected,
    limit,
    rows,
    summary: { n: rows.length, expected, literal: side('literal'), ranked: side('ranked') },
  }
}

function firstChars(text, n = SNIPPET) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

function fmtMs(ms) {
  return `${Number(ms ?? 0).toFixed(2)}ms`
}

/** 一条 query 的完整块（--json 不给、默认给） */
export function renderRow(r, { show = SHOW_ROWS, modes = ['literal', 'ranked'] } = {}) {
  const out = [`#${String(r.i).padStart(2, '0')} 「${r.q}」 期望 ${r.expect.length} 条`]
  for (const mode of modes) {
    const side = r[mode]
    out.push(`  ${mode.padEnd(7)} ${side.hits}/${r.expect.length} ${fmtMs(side.ms)}`)
    for (const row of side.rows.slice(0, show)) {
      out.push(`    - ${row.id} · ${row.date} · ${firstChars(row.text)}`)
    }
    if (!side.rows.length) out.push('    （没翻到）')
  }
  return out.join('\n')
}

/**
 * --diff 的块：只列两档 top 有没有差别、差在哪几个 id。
 * 格式要稳定（测试盯着），所以不掺时间、不掺正文。
 */
export function renderDiffRow(r, { modes = ['literal', 'ranked'] } = {}) {
  const ids = (side) => (side.ids.length ? side.ids.join(' ') : '（空）')
  return [
    `#${String(r.i).padStart(2, '0')} 「${r.q}」`,
    ...modes.map((mode) => `  ${mode.padEnd(7)} ${r[mode].hits}/${r.expect.length} ${ids(r[mode])}`),
  ].join('\n')
}

/** 末尾两行汇总 */
export function renderSummary(bench, { modes = ['literal', 'ranked'] } = {}) {
  const line = (mode) => {
    const s = bench.summary[mode]
    const rate = s.hitRate === null ? '—（问卷没标 expect）' : `${(s.hitRate * 100).toFixed(0)}%`
    return `  ${mode.padEnd(7)} 命中 ${s.hits}/${bench.expected}（${rate}）  p50 ${fmtMs(s.p50)}  p95 ${fmtMs(s.p95)}`
  }
  return modes.map(line).join('\n')
}

/** 拼整张表。diff=true 时只打两档不一致的块。 */
export function renderReport(bench, { diff = false, modes = ['literal', 'ranked'] } = {}) {
  const parts = []
  const blocks = []
  bench.rows.forEach((r, idx) => {
    const item = { ...r, i: idx + 1 }
    if (diff) {
      if (!r.sameTop) blocks.push(renderDiffRow(item, { modes }))
    } else {
      blocks.push(renderRow(item, { modes }))
    }
  })
  if (!blocks.length) parts.push(diff ? '两档 top 完全一致，没有可对照的行。' : '（问卷是空的）')
  else parts.push(blocks.join(diff ? '\n\n' : '\n\n'))
  parts.push('—— 汇总 ——')
  parts.push(renderSummary(bench, { modes }))
  return parts.join('\n')
}

/* ---------------- P5 三列的渲染 ---------------- */

const P5_LABELS = [
  ['literal', 'literal'],
  ['linksOff', 'links 关'],
  ['linksOn', 'links 开'],
]

function fmtPos(pos) {
  return pos < 0 ? '未命中' : String(pos + 1)
}

/** 一条 query 的三列块 */
export function renderP5Row(r, { show = SHOW_ROWS } = {}) {
  const out = ['#' + String(r.i).padStart(2, '0') + ' 「' + r.q + '」 期望 ' + r.expect.length + ' 条']
  for (const [key, label] of P5_LABELS) {
    const side = r[key]
    out.push('  ' + label.padEnd(7) + ' ' + side.hits + '/' + r.expect.length + ' ' + fmtMs(side.ms))
    for (const row of side.rows.slice(0, show)) {
      const tag = row.related ? '（由 ' + row.related + ' 带出）' : ''
      out.push('    - ' + row.id + ' · ' + row.date + ' · ' + firstChars(row.text) + tag)
    }
    if (!side.rows.length) out.push('    （没翻到）')
  }
  return out.join('\n')
}

/** 变差的那一行：query、位次（off → on）、被挤掉的 id */
export function renderRegression(reg) {
  return (
    '  ! #' + String(reg.i).padStart(2, '0') + ' 「' + reg.q + '」 ' + reg.expect + ' ' +
    '位次 ' + fmtPos(reg.offPos) + ' → ' + fmtPos(reg.onPos) + '；被挤掉 ' +
    (reg.dropped.length ? reg.dropped.join(' ') : '（其余条目都还在）')
  )
}

/** 三行汇总 + 判定 */
export function renderP5Summary(bench) {
  const lines = []
  for (const [key, label] of P5_LABELS) {
    const s = bench.summary[key]
    const rate = s.hitRate === null ? '—（问卷没标 expect）' : ((s.hitRate * 100).toFixed(0) + '%')
    lines.push('  ' + label.padEnd(7) + ' 命中 ' + s.hits + '/' + bench.expected + '（' + rate + '）  p50 ' + fmtMs(s.p50) + '  p95 ' + fmtMs(s.p95))
  }
  const off = bench.summary.linksOff.hits
  const on = bench.summary.linksOn.hits
  if (!bench.expected) {
    lines.push('  判定：问卷没标 expect，只报数不判「变差」；top1 差异见下。')
  } else if (bench.regressions.length) {
    lines.push('  判定：links 开 ' + on + ' / 关 ' + off + '，有 ' + bench.regressions.length + ' 条变差（逐条见上）。')
  } else {
    lines.push('  判定：links 开 ' + on + ' ≥ 关 ' + off + '，没有变差。')
  }
  return lines.join('\n')
}

/** 三档 top1 不同的那几条 */
export function renderP5TopDiff(bench) {
  const diffs = []
  bench.rows.forEach((r, idx) => {
    const { literal, linksOff, linksOn } = r.top1
    if (literal === linksOff && linksOff === linksOn) return
    diffs.push(
      '  #' + String(idx + 1).padStart(2, '0') + ' 「' + r.q + '」 literal ' + (literal || '（空）') + ' · off ' + (linksOff || '（空）') + ' · on ' + (linksOn || '（空）'),
    )
  })
  if (!diffs.length) return '三档 top1 全同，没有可看的差异。'
  return diffs.join('\n')
}

/**
 * 整张三列表。kind=reference 时表头明说：这一列是工装侧参考实现，不是产品结果。
 */
export function renderP5Report(bench, { show = SHOW_ROWS } = {}) {
  const parts = []
  const blocks = bench.rows.map((r, idx) => renderP5Row({ ...r, i: idx + 1 }, { show }))
  parts.push(blocks.join('\n\n'))
  if (bench.regressions.length) {
    parts.push('—— 变差的行 ——')
    parts.push(bench.regressions.map(renderRegression).join('\n'))
  }
  parts.push('—— 汇总 ——')
  parts.push(renderP5Summary(bench))
  parts.push('—— 三档 top1 差异 ——')
  parts.push(renderP5TopDiff(bench))
  return parts.join('\n')
}
function usage() {
  return [
    '用法：node tools/recall-bench.mjs [选项]',
    '',
    '  --root <dir>      账本目录，默认 ~/.dsh-perch-samples',
    '  --queries <file>  问卷文件，默认 <root>/queries.jsonl',
    '  --limit <n>       每条最多取几条（1–20，默认 8），屏幕只打前 3',
    '  --mode <which>    只跑一档：literal / ranked / both（默认 both）',
    '  --diff            只打 literal 与 ranked 结果不一致的行',
    '  --p5              P5 三列对照：literal / ranked(links 关) / ranked(links 开)',
    '  --json            机器可读（完整结果）',
    '  -h, --help        这页',
  ].join('\n')
}

async function main() {
  let args
  try {
    args = parseArgs()
  } catch (e) {
    console.error(String(e.message))
    process.exitCode = 1
    return
  }
  if (args.help) {
    console.log(usage())
    return
  }
  try {
    const eventsPath = join(args.root, 'events.jsonl')
    const events = readEventsFile(eventsPath)
    const queries = readQueries(args.queriesPath)
    const expand = await loadExpander()
    if (args.p5) {
      const support = await loadLinksSupport()
      const links = support.build(events)
      const bench = runP5(events, queries, { limit: args.limit, expand, links, linksKind: support.kind })
      if (args.json) {
        console.log(JSON.stringify({
          root: args.root,
          queriesPath: args.queriesPath,
          events: events.length,
          linksKind: bench.linksKind,
          links: links.size,
          n: bench.n,
          expected: bench.expected,
          limit: bench.limit,
          summary: bench.summary,
          regressions: bench.regressions,
          rows: bench.rows.map((r) => ({
            q: r.q,
            expect: r.expect,
            top1: r.top1,
            sameOffOn: r.sameOffOn,
            literal: { ids: r.literal.ids, hits: r.literal.hits, ms: r.literal.ms },
            linksOff: { ids: r.linksOff.ids, hits: r.linksOff.hits, ms: r.linksOff.ms },
            linksOn: {
              ids: r.linksOn.ids,
              hits: r.linksOn.hits,
              ms: r.linksOn.ms,
              related: r.linksOn.rows.filter((x) => x.related).map((x) => ({ id: x.id, from: x.related })),
            },
          })),
        }, null, 2))
        return
      }
      console.log('P5 三列对照：literal / ranked(links 关) / ranked(links 开)')
      console.log('账本 ' + eventsPath + '（' + events.length + ' 条）· 问卷 ' + args.queriesPath + '（' + queries.length + ' 条）· 每条取 top ' + args.limit)
      if (support.kind === 'lib') {
        console.log('links：产品实现（lib/links.js 已落地）· 建成 ' + links.size + ' 条')
      } else {
        console.log('links：还没落地，这一列用**工装侧参考实现**（Dice top-' + LINKS_MAX + ' ≥ ' + LINKS_MIN_DICE + '，1 跳 × ' + LINKS_WEIGHT + '）——只是先把三列跑通，不是产品结果')
        console.log('      建成 ' + links.size + ' 条（只看 utterance / revise）')
      }
      if (!expand) {
        console.log('（ranked 现在只叠显著性；P3 的 lib/search-index.js 出现后会自动接上同义词扩展）')
      }
      console.log('')
      console.log(renderP5Report(bench))
      return
    }
    const bench = runBench(events, queries, { limit: args.limit, expand })
    if (args.json) {
      console.log(JSON.stringify({
        root: args.root,
        queriesPath: args.queriesPath,
        mode: args.mode,
        events: events.length,
        ...bench,
        rows: bench.rows.map((r) => ({
          q: r.q,
          expect: r.expect,
          sameTop: r.sameTop,
          literal: { ids: r.literal.ids, hits: r.literal.hits, ms: r.literal.ms },
          ranked: { ids: r.ranked.ids, hits: r.ranked.hits, ms: r.ranked.ms },
        })),
      }, null, 2))
      return
    }
    console.log(`召回对照：${args.mode === 'both' ? 'literal vs ranked' : args.mode}`)
    console.log(`账本 ${eventsPath}（${events.length} 条）· 问卷 ${args.queriesPath}（${queries.length} 条）· 每条取 top ${args.limit}`)
    if (!expand) {
      console.log('（ranked 现在只叠显著性；P3 的 lib/search-index.js 出现后会自动接上同义词扩展）')
    }
    console.log('')
    if (args.diff) {
      console.log(renderReport(bench, { diff: true, modes: args.modes }))
    } else {
      const blocks = bench.rows.map((r, idx) => renderRow({ ...r, i: idx + 1 }, { modes: args.modes }))
      console.log(blocks.join('\n\n'))
      console.log('')
      console.log('—— 汇总 ——')
      console.log(renderSummary(bench, { modes: args.modes }))
    }
  } catch (e) {
    console.error(e?.userFacing ? e.message : (e?.stack || String(e)))
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
