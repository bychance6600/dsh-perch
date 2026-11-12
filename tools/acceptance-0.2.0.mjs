#!/usr/bin/env node
/**
 * acceptance-0.2.0.mjs —— 0.2.0 六项机制的联合验收（只读、不写账本）
 *
 * 产出是一张可重复跑的对照表，不是结论：
 *   一、模式 × 链接（literal / ranked+links 关 / ranked+links 开）
 *   一之二、--seeds：每条 query 的 top3 seeds 与 1 跳邻居（只输出）
 *   二、模式 × 按人（不传 person / 群里出现过的人 / 只私聊过的人）
 *   三、时间区间闭区间边界
 *   四、近况四计数边界
 *   五、遗忘阈值边界与真账本命中
 *   六、真账本：links 触发、近况原文、遗忘命中
 *   七、与上一版（6192037）逐字节对照：literal / ranked+links 关 / derive
 *
 * 真账本与问卷默认在 ~/.dsh-perch-samples（不进仓库）。不 push、不 merge、不改 lib/。
 *
 * 用法：
 *   node tools/acceptance-0.2.0.mjs
 *   node tools/acceptance-0.2.0.mjs --root ~/.dsh-perch-samples --limit 8
 *   node tools/acceptance-0.2.0.mjs --now 2026-11-10T12:00:00Z --json
 *   node tools/acceptance-0.2.0.mjs --skip-old
 *   node tools/acceptance-0.2.0.mjs --seeds --skip-old
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import {
  DEFAULT_LIMIT,
  buildLinks,
  loadExpander,
  loadLinksSupport,
  optionsFor,
  percentile,
  readEventsFile,
  readQueries,
  runP5,
} from './recall-bench.mjs'
import {
  RECALL_DAYS,
  RECALL_FRESH_DAYS,
  RECALL_FRESH_MAX,
  RECALL_TYPE_BONUS,
  recallImportanceOf,
  searchEvents,
  solidIdsOf,
  supersededIdsOf,
} from '../lib/recall.js'
import { buildIndex, scoreQuery } from '../lib/search-index.js'
import { spreadRank } from '../lib/links.js'
import { stripPromptEcho, stripScaffold } from '../lib/guard.js'
import {
  deriveSelf,
  recentCountsOf,
  recencyOf,
  similarity,
  RECENT_REPLY_MS,
  RECENT_WINDOW_DAYS,
} from '../lib/derive.js'
import {
  FORGET_LINE,
  FORGET_MATCH_MIN,
  forgetLine,
  recencyLine,
} from '../lib/persona.js'
import { newId } from '../lib/schema.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OLD_COMMIT = '6192037'
const DEFAULT_ROOT = join(homedir(), '.dsh-perch-samples')

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 产品口径，不是实现巧合：正好 7×24 小时仍算「最近七天」。 */
const WINDOW_NOTE = '窗口口径：7 天为闭区间，正好 7×24 小时算「最近七天」（产品决定，不是实现巧合）'

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    root: DEFAULT_ROOT,
    queriesPath: '',
    limit: DEFAULT_LIMIT,
    now: undefined,
    json: false,
    skipOld: false,
    seeds: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (!v) throw new Error(a + ' 后面要跟一个值')
      return v
    }
    if (a === '--root') out.root = resolve(val())
    else if (a === '--queries') out.queriesPath = resolve(val())
    else if (a === '--limit') out.limit = Number(val())
    else if (a === '--now') out.now = val()
    else if (a === '--json') out.json = true
    else if (a === '--skip-old') out.skipOld = true
    else if (a === '--seeds') out.seeds = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error('不认识的参数：' + a + '（--help 看用法）')
  }
  out.root = resolve(out.root)
  out.queriesPath = out.queriesPath || join(out.root, 'queries.jsonl')
  if (!Number.isFinite(out.limit) || out.limit < 1 || out.limit > 20) {
    throw new Error('--limit 要在 1–20 之间')
  }
  out.limit = Math.floor(out.limit)
  if (out.now !== undefined) {
    const n = /^\d+$/.test(String(out.now)) ? Number(out.now) : Date.parse(String(out.now))
    if (!Number.isFinite(n)) throw new Error('--now 要一个毫秒数或 ISO 时间')
    out.now = n
  }
  return out
}

function usage() {
  return [
    '用法：node tools/acceptance-0.2.0.mjs [选项]',
    '',
    '  --root <dir>      账本目录，默认 ~/.dsh-perch-samples',
    '  --queries <file>  问卷，默认 <root>/queries.jsonl',
    '  --limit <n>       每条最多取几条（1–20，默认 8）',
    '  --now <t>         冻结“现在”（毫秒或 ISO）；默认 Date.now()',
    '  --json            机器可读',
    '  --skip-old        跳过与 6192037 的逐字节对照',
    '  --seeds           每条 query 额外打印 top3 seeds 与 1 跳邻居（只输出）',
    '  -h, --help        这页',
  ].join('\n')
}

function evAt(at, body) {
  return { id: newId(at), ts: new Date(at).toISOString(), influence: 'constitution', ...body }
}

function fmtMs(v) {
  return v === null || v === undefined ? '—' : Number(v).toFixed(2) + 'ms'
}

function fmtScore(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(3)
}

function snippet(text, n = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function rate(hits, expected) {
  return expected ? (hits / expected * 100).toFixed(0) + '%' : '—'
}

function table(rows, cols) {
  const widths = cols.map(([, key, w]) => Math.max(w, ...rows.map((r) => String(r[key] ?? '').length)))
  const line = (vals) => '| ' + vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join(' | ') + ' |'
  return [
    line(cols.map(([label]) => label)),
    '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |',
    ...rows.map((r) => line(cols.map(([, key]) => r[key]))),
  ].join('\n')
}

/** 两条等长 101 字文本，恰好共享 k 个二元组：Dice = k/100。 */
function longPair(k) {
  const chars = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i))
  const base = chars.slice(0, k + 1).join('')
  const tail = 100 - k
  return [base + chars.slice(200, 200 + tail).join(''), base + chars.slice(300, 300 + tail).join('')]
}

function forgetModel(topicA, now) {
  const old = evAt(now - 10 * DAY, { type: 'heard', origin: 'owner', text: topicA })
  return deriveSelf([
    evAt(now - 3 * DAY, { type: 'utterance', text: '今天风很大' }),
    evAt(now - 2 * DAY, { type: 'utterance', text: '楼下有只猫' }),
    evAt(now - DAY, { type: 'revise', text: '我后来换了说法', verdict: 'refuted', refs: [old.id] }),
    old,
  ], { now })
}

function stripNew(v) {
  if (Array.isArray(v)) return v.map(stripNew)
  if (v instanceof Set) return new Set([...v].map(stripNew))
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, stripNew(x)]))
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === 'refs' || k === 'refTexts') continue
      o[k] = stripNew(x)
    }
    return o
  }
  return v
}

/** 与 lib/recall.js 的 freshnessOf 同口径；只用于把 seed 的 rank 复算出来打给工装看。 */
function freshnessAt(ts, now) {
  const ageDays = Math.max(0, (now - ts) / DAY)
  return RECALL_FRESH_MAX * Math.exp(-ageDays / RECALL_FRESH_DAYS)
}

/**
 * 复算 ranked 每条命中的 rank，仅供 --seeds 输出。
 * 口径必须与 lib/recall.js 的 searchEvents 一致：过滤 meta / superseded / 空文本，
 * rank = BM25 + max(重要度, 类型加成) + 新鲜度。不改计分，也不把结果塞回 searchEvents。
 */
function rankMapOf(events, query, now) {
  const superseded = supersededIdsOf(events)
  const factors = recallImportanceOf(events, 30)
  const bm25 = scoreQuery(buildIndex(events), query)
  const since = RECALL_DAYS > 0 ? now - RECALL_DAYS * DAY : -Infinity
  const ranks = new Map()
  for (const ev of events) {
    if (!ev || ev.type === 'meta') continue
    const id = String(ev.id)
    if (superseded.has(id)) continue
    if (!stripScaffold(stripPromptEcho(ev.text))) continue
    const ts = Date.parse(ev.ts)
    if (!Number.isFinite(ts) || ts < since) continue
    const relevance = bm25.get(id) ?? 0
    if (!(relevance > 0)) continue
    let importance = 0
    if (factors.solid.has(id)) importance += 3
    if (factors.scars.has(id)) importance += 2
    if (factors.singles.has(id)) importance += 1
    const typeBonus = RECALL_TYPE_BONUS[String(ev.type ?? '')] ?? 0
    ranks.set(id, relevance + Math.max(importance, typeBonus) + freshnessAt(ts, now))
  }
  return ranks
}

/** 每条 query 的 top3 seeds + 各自 1 跳邻居；邻居分数按 spreadRank(seed.rank) 算。 */
function seedReport(events, query, { now, solid, links, limit = 3 } = {}) {
  const rows = searchEvents(events, query, {
    ...optionsFor('ranked', { limit, solidIds: solid }),
    now,
    links: false,
  }).rows
  const ranks = rankMapOf(events, query, now)
  return rows.map((row, i) => {
    const id = String(row.id)
    const rank = ranks.get(id)
    // lib/links.js 返回 Set，工装参考实现返回数组；两种都摊平。
    const neighbors = [...(links.get(id) ?? [])].map((raw) => ({
      id: String(raw),
      score: Number.isFinite(rank) ? spreadRank(rank) : null,
    }))
    return { seed: i + 1, id, rank: Number.isFinite(rank) ? rank : null, neighbors }
  })
}

async function loadOld() {
  const temp = await mkdtemp(join(tmpdir(), 'perch-old-'))
  const buf = execFileSync('git', ['archive', OLD_COMMIT], { cwd: REPO, maxBuffer: 512 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', temp], { input: buf, maxBuffer: 512 * 1024 * 1024 })
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}\n')
  const recall = await import(pathToFileURL(join(temp, 'lib/recall.js')).href)
  const derive = await import(pathToFileURL(join(temp, 'lib/derive.js')).href)
  return { temp, recall, derive }
}

async function main() {
  let args
  try {
    args = parseArgs()
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
    return
  }
  if (args.help) {
    console.log(usage())
    return
  }

  const failures = []
  const addFail = (name, detail) => failures.push({ name, detail })
  const now = args.now ?? Date.now()
  const eventsPath = join(args.root, 'events.jsonl')
  const events = readEventsFile(eventsPath)
  const queries = readQueries(args.queriesPath)
  const expand = await loadExpander()
  const solid = solidIdsOf(events)
  const byId = new Map(events.map((e) => [String(e.id), e]))

  const out = {
    root: args.root,
    eventsPath,
    queriesPath: args.queriesPath,
    events: events.length,
    queries: queries.length,
    limit: args.limit,
    now: new Date(now).toISOString(),
    oldCommit: OLD_COMMIT,
    windowNote: WINDOW_NOTE,
  }

  // ---- 一、模式 × 链接 ----
  const support = await loadLinksSupport()
  const links = support.build(events)
  const p5 = runP5(events, queries, { limit: args.limit, now, expand, links, linksKind: support.kind })
  const matrix = [
    { label: 'literal', key: 'literal' },
    { label: 'ranked + links 关', key: 'linksOff' },
    { label: 'ranked + links 开', key: 'linksOn' },
  ].map(({ label, key }) => {
    const s = p5.summary[key]
    return {
      label,
      hits: s.hits + '/' + p5.expected,
      rate: rate(s.hits, p5.expected),
      p50: fmtMs(s.p50),
      p95: fmtMs(s.p95),
    }
  })
  out.matrix = { n: p5.n, expected: p5.expected, linksKind: support.kind, rows: matrix, summary: p5.summary }
  const expectedOn = p5.summary.linksOn.hits
  const expectedOff = p5.summary.linksOff.hits
  if (expectedOn < expectedOff) addFail('links 开比关少命中', expectedOff + ' → ' + expectedOn)

  // ---- 一之二、seeds 与 1 跳邻居（只输出，不计分） ----
  let seedRows = []
  if (args.seeds) {
    seedRows = queries.map((item) => ({
      q: item.q,
      seeds: seedReport(events, item.q, { now, solid, links }),
    }))
    out.seeds = seedRows
  }

  // ---- 二、模式 × 按人 ----
  const A = 'u_2482138204' // 只在群里出现过
  const B = 'u_1845721578' // 另一个群里的人（硬断言不许出现在按 A 的结果里）
  const C = 'u_323978714' // 只在 B 站私聊里出现过
  const personQs = [
    queries.find((x) => x.q.includes('群里的事我为什么总说是二手'))?.q,
    queries.find((x) => x.q.includes('谁在群里说打游戏亏了30亿游戏币'))?.q,
    queries.find((x) => x.q.includes('在群里提到我该怎么写'))?.q,
    '雪兔子说送死的过程中捡了好多是什么意思？',
    queries.find((x) => x.q.includes('相信一个人为什么不是一句话的事'))?.q,
  ].filter(Boolean)
  const expectOf = (q) => queries.find((x) => x.q === q)?.expect ?? []
  const searchRanked = (q, personIds) => {
    const t0 = performance.now()
    const rows = searchEvents(events, q, {
      ...optionsFor('ranked', { limit: args.limit, solidIds: solid }),
      now,
      ...(personIds ? { personIds } : {}),
    }).rows
    return { rows, ms: performance.now() - t0, hits: expectOf(q).filter((id) => rows.some((r) => r.id === id)).length }
  }
  const leakOf = (rows, allowed) => rows
    .map((r) => byId.get(String(r.id)))
    .filter((e) => e && e.type === 'heard' && e.person && !allowed.includes(String(e.person)))
  const personModes = [
    { label: '不传 person', ids: null },
    { label: '按 A（群里）', ids: [A] },
    { label: '按 C（只私聊）', ids: [C] },
  ]
  const person = []
  for (const mode of personModes) {
    const rows = []
    for (const q of personQs) {
      const got = searchRanked(q, mode.ids)
      rows.push({
        q,
        hits: got.hits + '/' + expectOf(q).length,
        rows: got.rows.length,
        top1: got.rows[0] ? String(got.rows[0].id) : '—',
        top1Text: got.rows[0] ? snippet(got.rows[0].text) : '（空）',
        ms: fmtMs(got.ms),
      })
    }
    person.push({ label: mode.label, rows })
    if (mode.ids) {
      const allowed = mode.ids
      for (const r of rows) {
        const got = searchRanked(r.q, allowed)
        const leaks = leakOf(got.rows, allowed)
        if (leaks.length) addFail('按人结果里混进别人', mode.label + ' · ' + r.q + ' · ' + leaks.map((e) => e.person).join(','))
      }
    }
  }
  const bLeak = person.find((p) => p.label === '按 A（群里）')
  if (bLeak) {
    const hit = bLeak.rows.some((r) => r.top1Text.includes('雪兔子'))
    if (hit) addFail('按 A 的结果 top1 仍是 B 的话', bLeak.rows.find((r) => r.top1Text.includes('雪兔子'))?.top1 ?? '')
  }
  out.person = { A, B, C, queries: personQs, modes: person }

  // ---- 三、时间区间 ----
  const T0 = now
  const ev = evAt(T0, { type: 'utterance', text: '边界词' })
  const timeRun = (o) => searchEvents([ev], '边界词', { mode: 'literal', now: T0, limit: 8, ...o }).rows.length
  const timeCases = [
    { name: 'from=to=事件时刻', got: timeRun({ from: T0, to: T0 }), want: 1 },
    { name: 'to=事件时刻 ISO', got: timeRun({ from: T0, to: new Date(T0).toISOString() }), want: 1 },
    { name: 'from=事件+1ms', got: timeRun({ from: T0 + 1, to: T0 + 2 }), want: 0 },
    { name: 'to=事件-1ms', got: timeRun({ from: T0 - 2, to: T0 - 1 }), want: 0 },
  ]
  for (const c of timeCases) if (c.got !== c.want) addFail('时间闭区间', c.name + ' got=' + c.got + ' want=' + c.want)
  out.time = timeCases

  // ---- 四、近况边界 ----
  const heardAt = (before) => [evAt(T0 - before, { type: 'heard', origin: 'owner', text: '在吗' })]
  const recencyCases = [
    { name: '30 分 29:59', got: recentCountsOf(heardAt(30 * MIN - 1000), T0).unanswered, want: 0 },
    { name: '30 分 30:00', got: recentCountsOf(heardAt(30 * MIN), T0).unanswered, want: 1 },
    { name: '30 分 30:01', got: recentCountsOf(heardAt(30 * MIN + 1000), T0).unanswered, want: 1 },
    { name: '6 天 23:59', got: recentCountsOf(heardAt(6 * DAY + 23 * HOUR + 59 * MIN), T0).unanswered, want: 1 },
    { name: '7 天整（闭区间）', got: recentCountsOf(heardAt(7 * DAY), T0).unanswered, want: 1 },
    { name: '7 天 +1 分', got: recentCountsOf(heardAt(7 * DAY + MIN), T0).unanswered, want: 0 },
  ]
  for (const c of recencyCases) if (c.got !== c.want) addFail('近况边界', c.name + ' got=' + c.got + ' want=' + c.want)
  const zeroModel = deriveSelf([], { now: T0 })
  const zeroLine = recencyLine(zeroModel)
  if (zeroLine !== '') addFail('近况全 0', '应为空串，实际：' + zeroLine)
  const anyModel = deriveSelf([
    evAt(T0 - 2 * DAY, { type: 'heard', origin: 'owner', text: '早点睡' }),
    evAt(T0 - 3 * DAY, { type: 'refusal', text: '我不想说' }),
    evAt(T0 - 4 * DAY, { type: 'revise', text: '我改口了', verdict: 'refuted', refs: [] }),
    evAt(T0 - HOUR, { type: 'meta', text: 'wake:2026-11-10T11:00:00.000Z' }),
  ], { now: T0 })
  const anyLine = recencyLine(anyModel)
  for (const w of ['所以', '因此', '应该', '你需要', '别']) {
    if (anyLine.includes(w)) addFail('近况因果/建议词', w + ' in ' + anyLine)
  }
  out.recency = {
    cases: recencyCases,
    allZeroLine: zeroLine,
    sampleLine: anyLine,
    windowNote: WINDOW_NOTE,
    constants: { RECENT_WINDOW_DAYS, RECENT_REPLY_MS },
  }

  // ---- 五、遗忘边界 ----
  const forgetCases = []
  for (const k of [44, 45, 46]) {
    const [a, b] = longPair(k)
    const sim = similarity(a, b)
    const got = forgetLine(forgetModel(a, T0), b)
    const want = k === 44 ? '' : FORGET_LINE
    forgetCases.push({ dice: (sim).toFixed(2), got: got === FORGET_LINE ? '命中' : '不命中', want: k === 44 ? '不命中' : '命中' })
    if (got !== want) addFail('遗忘阈值', 'Dice=' + sim.toFixed(2) + ' got=' + (got || '空'))
  }
  const [fa, fb] = longPair(46)
  const hitModel = forgetModel(fa, T0)
  const hitLine = forgetLine(hitModel, fb)
  if (hitLine !== FORGET_LINE) addFail('遗忘命中', '应为固定一句，实际：' + hitLine)
  if (hitLine.includes(fa)) addFail('遗忘复读', '命中句里出现了旧话原文')
  const longTopic = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i)).slice(0, 300).join('')
  const longModel = forgetModel(longTopic, T0)
  const refBelief = (longModel.beliefs ?? []).find((b) => Array.isArray(b.refTexts) && b.refTexts.length)
  if (!refBelief) addFail('refTexts 截断', '没有找到带 refTexts 的折叠判断')
  else if (refBelief.refTexts[0].length > 200) addFail('refTexts 截断', '长度 ' + refBelief.refTexts[0].length)
  if (forgetLine(hitModel, '完全不相干的一句话') !== '') addFail('遗忘不命中', '不相干的话也命中了')
  out.forget = {
    min: FORGET_MATCH_MIN,
    cases: forgetCases,
    line: FORGET_LINE,
    refTextsMax: refBelief ? Math.max(...refBelief.refTexts.map((x) => x.length)) : null,
  }

  // ---- 六、真账本 ----
  const realModel = deriveSelf(events, { now })
  const realRecency = recencyOf(realModel)
  const realLine = recencyLine(realModel)
  const realForgetQueries = queries
    .map((x) => ({ q: x.q, line: forgetLine(realModel, x.q) }))
    .filter((x) => x.line)
  const recentHeard = events.filter((e) => e.type === 'heard' && e.origin === 'owner').slice(-30)
  const realForgetHeard = recentHeard
    .map((e) => ({ id: String(e.id), text: snippet(e.text, 60), line: forgetLine(realModel, e.text) }))
    .filter((x) => x.line)
  // 产品实现的 searchEvents 不给行打 related 标记（那是工装参考实现才有）；
  // 带出的行只能按「links 开比 links 关多出来的 id」数。
  const linkedRows = p5.rows.reduce((n, r) => {
    const off = new Set(r.linksOff.ids)
    return n + r.linksOn.ids.filter((id) => !off.has(id)).length
  }, 0)
  const changedRows = p5.rows.filter((r) => !r.sameOffOn).length
  const edges = [...links.values()].reduce((n, set) => n + set.size, 0)
  out.real = {
    events: events.length,
    linksKind: support.kind,
    linkNodes: links.size,
    linkEdges: edges,
    linkedRows,
    changedRows,
    recency: realRecency,
    recencyLine: realLine,
    forgetQueryHits: realForgetQueries,
    forgetHeardHits: realForgetHeard,
    forgetHitCount: realForgetQueries.length + realForgetHeard.length,
    beliefCount: (realModel.beliefs ?? []).length,
  }

  // ---- 七、上一版逐字节 ----
  if (!args.skipOld) {
    let old = null
    try {
      old = await loadOld()
      const literalDiff = []
      const rankedDiff = []
      for (const item of queries) {
        const curLiteral = searchEvents(events, item.q, { ...optionsFor('literal', { limit: args.limit }), now }).rows
        const oldLiteral = old.recall.searchEvents(events, item.q, { limit: args.limit, weigh: false, mode: 'literal', now }).rows
        if (JSON.stringify(curLiteral) !== JSON.stringify(oldLiteral)) {
          literalDiff.push({ q: item.q, cur: curLiteral.map((r) => r.id), old: oldLiteral.map((r) => r.id) })
        }
        const curRanked = searchEvents(events, item.q, { ...optionsFor('ranked', { limit: args.limit, solidIds: solid }), now, links: false }).rows
        const oldSolid = old.recall.solidIdsOf(events)
        const oldRanked = old.recall.searchEvents(events, item.q, {
          limit: args.limit, weigh: true, solidIds: oldSolid, mode: 'ranked', links: false, now,
        }).rows
        if (JSON.stringify(curRanked) !== JSON.stringify(oldRanked)) {
          rankedDiff.push({ q: item.q, cur: curRanked.map((r) => r.id), old: oldRanked.map((r) => r.id) })
        }
      }
      const oldModel = old.derive.deriveSelf(events, { now })
      const curModel = deriveSelf(events, { now })
      const same = isDeepStrictEqual(stripNew(oldModel), stripNew(curModel))
      const diffKeys = []
      if (!same) {
        const keys = new Set([...Object.keys(oldModel), ...Object.keys(curModel)])
        for (const k of keys) {
          if (!isDeepStrictEqual(stripNew(oldModel[k]), stripNew(curModel[k]))) diffKeys.push(k)
        }
      }
      out.old = {
        commit: OLD_COMMIT,
        literalSame: queries.length - literalDiff.length,
        literalTotal: queries.length,
        rankedSame: queries.length - rankedDiff.length,
        rankedTotal: queries.length,
        deriveSame: same,
        deriveDiffKeys: diffKeys,
        literalDiff: literalDiff.slice(0, 3),
        rankedDiff: rankedDiff.slice(0, 3),
      }
      if (literalDiff.length) addFail('旧版 literal 不一致', String(literalDiff.length) + ' 条')
      if (rankedDiff.length) addFail('旧版 ranked(links 关) 不一致', String(rankedDiff.length) + ' 条')
      if (!same) addFail('旧版 derive 不一致', diffKeys.join(',') || 'see diff')
    } catch (e) {
      out.old = { commit: OLD_COMMIT, error: String(e?.message ?? e) }
      addFail('旧版对照失败', out.old.error)
    } finally {
      if (old?.temp) await rm(old.temp, { recursive: true, force: true }).catch(() => {})
    }
  }

  out.failures = failures
  if (args.json) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log('0.2.0 联合验收 · 只读')
    console.log('账本 ' + eventsPath + '（' + events.length + ' 条）· 问卷 ' + args.queriesPath + '（' + queries.length + ' 条，计分 ' + p5.expected + ' 个 expect）')
    console.log('now ' + out.now + ' · 每条 top ' + args.limit + ' · links=' + support.kind + '（' + links.size + ' 节点 / ' + edges + ' 边）')
    console.log(WINDOW_NOTE)
    console.log('')
    console.log('一、模式 × 链接')
    console.log(table(matrix, [
      ['档位', 'label', 18], ['命中', 'hits', 10], ['命中率', 'rate', 7], ['p50', 'p50', 9], ['p95', 'p95', 9],
    ]))
    if (args.seeds) {
      console.log('')
      console.log('一之二、seeds 与 1 跳邻居（只输出，不计分）')
      for (const [i, item] of seedRows.entries()) {
        console.log('[' + (i + 1) + '] ' + item.q)
        if (!item.seeds.length) console.log('  （无命中）')
        for (const s of item.seeds) {
          console.log('  seed ' + s.seed + ' ' + s.id + ' rank=' + fmtScore(s.rank))
          if (!s.neighbors.length) console.log('    （无 1 跳邻居）')
          for (const n of s.neighbors) console.log('    -> ' + n.id + ' score=' + fmtScore(n.score))
        }
      }
    }
    console.log('')
    console.log('二、模式 × 按人（每条各 5 个 query）')
    for (const mode of person) {
      console.log('[' + mode.label + ']')
      console.log(table(mode.rows, [
        ['query', 'q', 26], ['命中', 'hits', 8], ['条数', 'rows', 5], ['top1', 'top1', 26], ['首 40 字', 'top1Text', 42],
      ]))
    }
    console.log('')
    console.log('三、时间区间闭区间')
    for (const c of timeCases) console.log('  ' + (c.got === c.want ? 'ok ' : 'FAIL') + ' ' + c.name + ' got=' + c.got + ' want=' + c.want)
    console.log('')
    console.log('四、近况四计数')
    for (const c of recencyCases) console.log('  ' + (c.got === c.want ? 'ok ' : 'FAIL') + ' ' + c.name + ' got=' + c.got + ' want=' + c.want)
    console.log('  全 0 句：' + (zeroLine === '' ? '（不出现）' : zeroLine))
    console.log('  有数句：' + anyLine)
    console.log('')
    console.log('五、遗忘阈值（FORGET_MATCH_MIN=' + FORGET_MATCH_MIN + '）')
    for (const c of forgetCases) console.log('  Dice ' + c.dice + ' → ' + c.got + '（应' + c.want + '）')
    console.log('  命中句：' + hitLine)
    console.log('  refTexts 最长：' + (refBelief ? Math.max(...refBelief.refTexts.map((x) => x.length)) : '—') + ' 字（上限 200）')
    console.log('')
    console.log('六、真账本')
    console.log('  links：' + links.size + ' 节点 / ' + edges + ' 边；links 开带出 ' + linkedRows + ' 行，排序变化 ' + changedRows + ' / ' + p5.rows.length + ' 条')
    console.log('  近况四个数：' + JSON.stringify(realRecency))
    console.log('  近况句原文：' + (realLine || '（空）'))
    console.log('  遗忘命中：' + out.real.forgetHitCount + ' 次（问卷 ' + realForgetQueries.length + ' · 最近主人 heard ' + realForgetHeard.length + '）')
    for (const h of realForgetQueries.slice(0, 3)) console.log('    ! ' + snippet(h.q, 50))
    console.log('')
    if (!args.skipOld) {
      console.log('七、与 ' + OLD_COMMIT + ' 逐字节')
      if (out.old?.error) console.log('  FAIL ' + out.old.error)
      else {
        console.log('  literal ' + out.old.literalSame + '/' + out.old.literalTotal + ' 一致')
        console.log('  ranked(links 关) ' + out.old.rankedSame + '/' + out.old.rankedTotal + ' 一致')
        console.log('  derive ' + (out.old.deriveSame ? '一致（已剥掉 beliefs 的新增 refs/refTexts）' : '不一致 · ' + out.old.deriveDiffKeys.join(',')))
      }
      console.log('')
    }
    console.log('—— 判定 ——')
    console.log(failures.length ? '  FAIL ' + failures.length + ' 项' : '  PASS 全部断言通过')
    for (const f of failures) console.log('  ! ' + f.name + '：' + f.detail)
  }
  if (failures.length) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
