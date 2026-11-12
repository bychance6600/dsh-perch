#!/usr/bin/env node
/**
 * bench.mjs —— 账本重放的预算表（AGENTS §19）
 *
 * 为什么要有这个文件：§19 的四条数（启动 <300ms、1 万条重放 <700ms、常驻 <150MB、
 * 每轮注入 <6K tokens）里，前两条只有在改代码时才会变坏，而且坏得无声无息——
 * 上一次是 2026-11-10 量出来 2577 条 183ms，那之前没人量，谁也不知道已经慢了。
 * 这里把它做成能跑的一行命令，CI 也跟着跑；超预算退出码非 0。
 *
 * 5 万条按 AGENTS §19 必须走快照：这里先按 rebuild 的路径写一份 snapshot.json，
 * 再读两次，第二次必须是 fromSnapshot 命中，且模型与 deriveSelf 全等。
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
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { deriveSelf } from '../lib/derive.js'
import { readModelMeta, writeSnapshot } from '../lib/snapshot.js'
import { searchEvents } from '../lib/recall.js'

/** 预算：改这里要同时改 AGENTS §19，两边不一致时以 AGENTS 为准。 */
export const BUDGET_MS = Object.freeze({
  replay10k: 700,
  replay50kSnapshot: 300,
})

/** §19：常驻内存 < 150MB；搜索索引单独再量一次，避免被账本/模型摊薄。 */
export const MEMORY_BUDGET_MB = 150

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
 * 在带 --expose-gc 的子进程里量 5 万条的**活堆**：
 * 账本 + deriveSelf 模型 + 搜索索引都在，GC 之后再看 heapUsed。
 * 父进程不带 --expose-gc 时 heapUsed 里全是没回收的临时对象，那个数不能当常驻内存。
 */
export function measureMemory(n = 50000) {
  const benchUrl = new URL(import.meta.url).href
  const deriveUrl = new URL('../lib/derive.js', import.meta.url).href
  const indexUrl = new URL('../lib/search-index.js', import.meta.url).href
  const script = `
import { genEvents } from ${JSON.stringify(benchUrl)}
import { deriveSelf } from ${JSON.stringify(deriveUrl)}
import { buildIndex } from ${JSON.stringify(indexUrl)}
const events = genEvents(${Number(n)})
const now = Date.parse(events[events.length - 1].ts) + 3600000
const model = deriveSelf(events, { now })
global.gc()
const before = process.memoryUsage().heapUsed
const index = buildIndex(events)
global.gc()
const after = process.memoryUsage().heapUsed
console.log(JSON.stringify({
  n: events.length,
  indexed: index.N,
  terms: index.postings.size,
  indexHeapMB: (after - before) / 1048576,
  liveHeapMB: after / 1048576,
  modelFields: Object.keys(model).length,
}))
`
  const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`内存子进程失败：${String(r.stderr || r.error || r.status).slice(0, 500)}`)
  const line = String(r.stdout || '').trim().split('\n').pop()
  const out = JSON.parse(line)
  return {
    ...out,
    overIndex: out.indexHeapMB > MEMORY_BUDGET_MB,
    overLive: out.liveHeapMB > MEMORY_BUDGET_MB,
  }
}

function searchStats(events, now) {
  const times = []
  for (const q of QUERIES) {
    const t = performance.now()
    searchEvents(events, q, { now, days: 0 })
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return {
    searchP50: median(times),
    searchP95: times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] ?? 0,
  }
}

/**
 * 量一组（1 千 / 1 万：直接重放）。
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

  const { searchP50, searchP95 } = searchStats(events, now)
  global.gc?.()
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024
  return { n, replayMs, searchP50, searchP95, heapMB, events }
}

/**
 * 量 5 万条的快照路径（AGENTS §19：5 万条起必须走快照）。
 *
 * 先按 rebuild 的路径付一次 deriveSelf + writeSnapshot（冷路径，不计入预算），
 * 然后连读两次 readModelMeta；第二次必须是 fromSnapshot，且模型与 deriveSelf 全等。
 *
 * @param {number} n
 * @returns {Promise<object>}
 */
export async function measureSnapshot(n) {
  const events = genEvents(n)
  const now = Date.parse(events[events.length - 1].ts) + 3600000
  const root = mkdtempSync(join(tmpdir(), 'fish-bench-snapshot-'))
  try {
    writeFileSync(
      join(root, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    )

    const coldT = performance.now()
    const derived = deriveSelf(events, { now })
    const coldMs = performance.now() - coldT
    const written = await writeSnapshot(root, derived, events, { now })
    if (!written.ok) throw new Error(`快照没写成：${written.reason}`)

    const firstT = performance.now()
    const first = await readModelMeta(root, { now })
    const firstMs = performance.now() - firstT

    const secondT = performance.now()
    const second = await readModelMeta(root, { now })
    const secondMs = performance.now() - secondT

    const modelMatches = isDeepStrictEqual(second.model, derived)
    const { searchP50, searchP95 } = searchStats(events, now)
    global.gc?.()
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024
    return {
      n,
      // 预算看第二次读（文件已在页缓存里）；第一次读也单独列出来。
      replayMs: secondMs,
      replayColdMs: coldMs,
      searchP50,
      searchP95,
      heapMB,
      events,
      snapshot: {
        firstMs,
        secondMs,
        coldMs,
        bytes: written.bytes,
        firstFromSnapshot: first.fromSnapshot,
        secondFromSnapshot: second.fromSnapshot,
        secondReason: second.reason,
        modelMatches,
      },
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fmt(ms) {
  return `${ms.toFixed(0)}ms`
}

async function main() {
  const big = process.argv.includes('--big')
  const json = process.argv.includes('--json')
  const sizes = big ? [1000, 10000, 50000] : [1000, 10000]
  const rows = []
  let failed = false

  for (const n of sizes) {
    const r = n === 50000 ? await measureSnapshot(n) : measure(n)
    const budget = n === 10000
      ? BUDGET_MS.replay10k
      : n === 50000
        ? BUDGET_MS.replay50kSnapshot
        : null
    const over = budget !== null && r.replayMs > budget
    if (over) failed = true
    if (r.snapshot && (!r.snapshot.firstFromSnapshot || !r.snapshot.secondFromSnapshot || !r.snapshot.modelMatches)) {
      failed = true
    }
    rows.push({ ...r, budget, over, events: undefined })
  }

  let memory = null
  if (big) {
    try {
      memory = measureMemory(50000)
      if (memory.overIndex || memory.overLive) failed = true
      // 表里 5 万那行的「堆」用 GC 后的活堆；上面 heapMB 是未强制 GC 的 alloc，
      // 只适合横向看趋势，不适合当常驻内存。
      if (!memory.error) {
        const row = rows.find((x) => x.n === 50000)
        if (row) row.heapMB = memory.liveHeapMB
      }
    } catch (err) {
      failed = true
      memory = { error: String(err?.message ?? err) }
    }
  }

  if (json) {
    console.log(JSON.stringify({ rows, memory, failed }, null, 2))
  } else {
    console.log('账本重放预算（AGENTS §19）')
    console.log('')
    console.log('  条数      重放      召回 p50   召回 p95   堆       来源')
    for (const r of rows) {
      const mark = r.budget === null ? '     ' : r.over ? ' ✗超' : ' ✓  '
      const source = r.snapshot
        ? `快照 ${r.snapshot.firstFromSnapshot && r.snapshot.secondFromSnapshot ? '命中' : '未命中'}（第 2 次 ${fmt(r.snapshot.secondMs)} / 冷重放 ${fmt(r.snapshot.coldMs)}）`
        : '重放'
      console.log(
        `  ${String(r.n).padStart(6)}  ${fmt(r.replayMs).padStart(8)}  ${fmt(r.searchP50).padStart(9)}  ${fmt(r.searchP95).padStart(9)}  ${r.heapMB.toFixed(0).padStart(5)}MB  ${source}${mark}`,
      )
    }
    console.log('')
    console.log(`  预算：1 万条重放 < ${BUDGET_MS.replay10k}ms；5 万条走快照后 < ${BUDGET_MS.replay50kSnapshot}ms${big ? '' : '（--big 才量 5 万）'}`)
    if (memory) {
      if (memory.error) {
        console.log(`  5 万条常驻内存：✗ ${memory.error}`)
      } else {
        console.log(`  5 万条常驻内存（GC 后）：索引 ${memory.indexHeapMB.toFixed(0)}MB / 活堆 ${memory.liveHeapMB.toFixed(0)}MB（各 < ${MEMORY_BUDGET_MB}MB）${memory.overIndex || memory.overLive ? ' ✗超' : ' ✓'}`)
      }
    }
    if (rows.some((r) => r.snapshot)) {
      const s = rows.find((r) => r.snapshot).snapshot
      console.log(`  快照自检：写 ${s.bytes} B；第一次 ${s.firstFromSnapshot ? '命中' : '未命中'} ${fmt(s.firstMs)}；第二次 ${s.secondFromSnapshot ? '命中' : '未命中'} ${fmt(s.secondMs)}；模型与 deriveSelf ${s.modelMatches ? '全等' : '不等'}`)
    }
  }

  process.exit(failed ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
