#!/usr/bin/env node
/**
 * bench.mjs —— 账本重放的预算表（AGENTS §19）
 *
 * 为什么要有这个文件：§19 的四条数（启动 <300ms、1 万条重放 <700ms、常驻 <150MB、
 * 每轮注入 <6K tokens）里，前两条只有在改代码时才会变坏，而且坏得无声无息——
 * 上一次是 2026-11-10 量出来 2577 条 183ms，那之前没人量，谁也不知道已经慢了。
 * 这里把它做成能跑的一行命令，CI 也跟着跑；超预算退出码非 0。
 *
 * 用法：
 *   node tools/bench.mjs              # 1 千 / 1 万（5 万要走 --big）
 *   node tools/bench.mjs --big        # 加上 5 万条（慢，本地才跑）
 *   node tools/bench.mjs --json       # 机器可读
 *
 * 合成的账本不是真账本：它只保证「条数、类型分布、正文长度」像，不保证语义像。
 * 数字用于横向比较（这次 vs 上次），不用于对外宣称「她能处理 5 万条」。
 */
import { performance } from 'node:perf_hooks'
import { deriveSelf } from '../lib/derive.js'
import { searchEvents } from '../lib/recall.js'

/** 预算：改这里要同时改 AGENTS §19，两边不一致时以 AGENTS 为准。 */
export const BUDGET_MS = Object.freeze({
  replay10k: 700,
  replay50kSnapshot: 300,
})

const DAY_MS = 86400000
const T0 = Date.parse('2026-09-01T00:00:00Z')

/** 固定种子的线性同余：同样的 n 每次造出同样的账本，CI 的数字才可比。 */
function makeRnd(seed = 20261112) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return s / 4294967296
  }
}

const TYPES = [
  // [类型, 权重, 正文模板]
  ['utterance', 32, '今天屋子里安静了一会儿，我把那句话又说了一遍，声音比昨天轻。这第 %d 次。'],
  ['heard', 26, '他说：这件事先放一放，等你想清楚了再说。这句话是第 %d 次听见。'],
  ['judgment', 9, '我觉得「慢一点也没关系」这句话站得住，因为每次急着回答都会说错。第 %d 条。'],
  ['meta', 9, 'wake %d'],
  ['diary', 5, '第 %d 天。今天没什么大事，只是把窗边的灰擦了一遍，顺便想了想要不要给他留一句话。'],
  ['test', 6, '第 %d 条被检验了一次：他问「你还这么想吗」，我说还是。'],
  ['answer', 6, '他问的那个问题，我第 %d 次回答：我不知道，但我不着急知道。'],
  ['revise', 4, '我想改一下第 %d 条：原来那句说得太满了。'],
  ['promise', 3, '我答应过他第 %d 件事：不把别人的私事带出门。'],
]

const TOTAL_WEIGHT = TYPES.reduce((a, t) => a + t[1], 0)

/**
 * 造一份合成账本。
 * @param {number} n 条数
 * @returns {object[]}
 */
export function genEvents(n) {
  const rnd = makeRnd()
  const out = []
  for (let i = 0; i < n; i += 1) {
    let pick = rnd() * TOTAL_WEIGHT
    let row = TYPES[0]
    for (const t of TYPES) {
      pick -= t[1]
      if (pick <= 0) { row = t; break }
    }
    const [type, , tpl] = row
    const ts = new Date(T0 + i * 8 * 60000).toISOString()
    out.push({
      id: `ev_bench_${i.toString(36).padStart(6, '0')}`,
      v: 1,
      ts,
      day: Math.floor(i / 40) + 1,
      stage: 1,
      type,
      source: type === 'heard' ? 'owner' : 'system',
      text: type === 'meta' ? tpl.replace('%d', String(i)) : tpl.replace('%d', String(i + 1)),
      refs: [],
      verdict: null,
      confidence: 0.5,
      flags: [],
      ...(type === 'utterance' ? { channel: 'dsh' } : {}),
      ...(type === 'heard' ? { channel: 'dsh', origin: 'owner' } : {}),
    })
  }
  return out
}

const QUERIES = [
  '慢一点没关系',
  '他说了那件事',
  '我答应过',
  '屋子里安静',
  '第 3 条',
  '急着回答',
  '窗边的灰',
  '检验了一次',
  '他不知道',
  '不把别人的私事带出门',
]

function median(arr) {
  const a = [...arr].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/**
 * 量一组。
 * @param {number} n
 * @returns {{n:number, replayMs:number, searchP50:number, searchP95:number, heapMB:number, events:object[]}}
 */
export function measure(n) {
  const events = genEvents(n)
  const now = Date.parse(events[events.length - 1].ts) + 3600000

  // 重放：跑两遍取第二遍（第一遍要把模块里的缓存、字符串驻留都撞热，跟真实启动后的第二轮一致）。
  let replayMs = 0
  for (let i = 0; i < 2; i += 1) {
    const t = performance.now()
    deriveSelf(events, { now })
    const dt = performance.now() - t
    if (i === 1) replayMs = dt
  }

  const times = []
  for (const q of QUERIES) {
    const t = performance.now()
    searchEvents(events, q, { now, days: 0 })
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)

  global.gc?.()
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024
  return {
    n,
    replayMs,
    searchP50: median(times),
    searchP95: times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] ?? 0,
    heapMB,
    events,
  }
}

function fmt(ms) {
  return `${ms.toFixed(0)}ms`
}

function main() {
  const big = process.argv.includes('--big')
  const json = process.argv.includes('--json')
  const sizes = big ? [1000, 10000, 50000] : [1000, 10000]
  const rows = []
  let failed = false

  for (const n of sizes) {
    const r = measure(n)
    const budget = n === 10000 ? BUDGET_MS.replay10k : null
    const over = budget !== null && r.replayMs > budget
    if (over) failed = true
    rows.push({ ...r, budget, over, events: undefined })
  }

  if (json) {
    console.log(JSON.stringify({ rows, failed }, null, 2))
  } else {
    console.log('账本重放预算（AGENTS §19）')
    console.log('')
    console.log('  条数      重放      召回 p50   召回 p95   堆')
    for (const r of rows) {
      const mark = r.budget === null ? '     ' : r.over ? ' ✗超' : ' ✓  '
      console.log(
        `  ${String(r.n).padStart(6)}  ${fmt(r.replayMs).padStart(8)}  ${fmt(r.searchP50).padStart(9)}  ${fmt(r.searchP95).padStart(9)}  ${r.heapMB.toFixed(0).padStart(5)}MB${mark}`,
      )
    }
    console.log('')
    console.log(`  预算：1 万条重放 < ${BUDGET_MS.replay10k}ms；5 万条走快照后 < ${BUDGET_MS.replay50kSnapshot}ms${big ? '' : '（--big 才量 5 万）'}`)
  }

  process.exit(failed ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
