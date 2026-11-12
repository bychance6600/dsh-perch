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
import { searchEvents, solidIdsOf } from '../lib/recall.js'

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
    } else if (a === '--diff') {
      out.diff = true
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
export function renderRow(r, { show = SHOW_ROWS } = {}) {
  const out = [`#${String(r.i).padStart(2, '0')} 「${r.q}」 期望 ${r.expect.length} 条`]
  for (const mode of ['literal', 'ranked']) {
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
export function renderDiffRow(r) {
  const ids = (side) => (side.ids.length ? side.ids.join(' ') : '（空）')
  return [
    `#${String(r.i).padStart(2, '0')} 「${r.q}」`,
    `  literal ${r.literal.hits}/${r.expect.length} ${ids(r.literal)}`,
    `  ranked  ${r.ranked.hits}/${r.expect.length} ${ids(r.ranked)}`,
  ].join('\n')
}

/** 末尾两行汇总 */
export function renderSummary(bench) {
  const line = (mode) => {
    const s = bench.summary[mode]
    const rate = s.hitRate === null ? '—（问卷没标 expect）' : `${(s.hitRate * 100).toFixed(0)}%`
    return `  ${mode.padEnd(7)} 命中 ${s.hits}/${bench.expected}（${rate}）  p50 ${fmtMs(s.p50)}  p95 ${fmtMs(s.p95)}`
  }
  return [line('literal'), line('ranked')].join('\n')
}

/** 拼整张表。diff=true 时只打两档不一致的块。 */
export function renderReport(bench, { diff = false } = {}) {
  const parts = []
  const blocks = []
  bench.rows.forEach((r, idx) => {
    const item = { ...r, i: idx + 1 }
    if (diff) {
      if (!r.sameTop) blocks.push(renderDiffRow(item))
    } else {
      blocks.push(renderRow(item))
    }
  })
  if (!blocks.length) parts.push(diff ? '两档 top 完全一致，没有可对照的行。' : '（问卷是空的）')
  else parts.push(blocks.join(diff ? '\n\n' : '\n\n'))
  parts.push('—— 汇总 ——')
  parts.push(renderSummary(bench))
  return parts.join('\n')
}

function usage() {
  return [
    '用法：node tools/recall-bench.mjs [选项]',
    '',
    '  --root <dir>      账本目录，默认 ~/.dsh-perch-samples',
    '  --queries <file>  问卷文件，默认 <root>/queries.jsonl',
    '  --limit <n>       每条最多取几条（1–20，默认 8），屏幕只打前 3',
    '  --diff            只打 literal 与 ranked 结果不一致的行',
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
    const bench = runBench(events, queries, { limit: args.limit, expand })
    if (args.json) {
      console.log(JSON.stringify({
        root: args.root,
        queriesPath: args.queriesPath,
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
    console.log(`召回对照：literal vs ranked`)
    console.log(`账本 ${eventsPath}（${events.length} 条）· 问卷 ${args.queriesPath}（${queries.length} 条）· 每条取 top ${args.limit}`)
    if (!expand) {
      console.log('（ranked 现在只叠显著性；P3 的 lib/search-index.js 出现后会自动接上同义词扩展）')
    }
    console.log('')
    if (args.diff) {
      console.log(renderReport(bench, { diff: true }))
    } else {
      const blocks = bench.rows.map((r, idx) => renderRow({ ...r, i: idx + 1 }))
      console.log(blocks.join('\n\n'))
      console.log('')
      console.log('—— 汇总 ——')
      console.log(renderSummary(bench))
    }
  } catch (e) {
    console.error(e?.userFacing ? e.message : (e?.stack || String(e)))
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
