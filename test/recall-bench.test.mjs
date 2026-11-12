/**
 * recall-bench.test.mjs —— 验收工装自己的测试
 *
 * 工装坏掉时最坏的情况是「没有报错，只给了一张错的对照表」，所以这里只测这一层：
 *   ① 汇总里 p50 / p95 真有数，不是 NaN；
 *   ② --diff 的输出格式稳定（按 id 比，不掺时间与正文）；
 *   ③ 缺 queries.jsonl 时报错说得清「找的是哪、要什么格式」；
 *   ④ ranked 侧能通过同义词扩展把「不开心」送到「难过」那条上——
 *      这是 P3 的验收命根子，工装自己先得证明它送得过去。
 *
 * 不测 searchEvents 的排序（那是 lib/recall.js 的测试），也不连真账本
 * （真账本在 ~/.dsh-perch-samples/，不进仓库，测试只用临时目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseArgs,
  parseQueries,
  readQueries,
  optionsFor,
  runOne,
  runBench,
  percentile,
  renderDiffRow,
  renderSummary,
  renderReport,
  DEFAULT_LIMIT,
} from '../tools/recall-bench.mjs'

const T0 = Date.parse('2026-09-01T00:00:00Z')

/**
 * 50 条合成事件。故意只让少数几条带「会被问起」的词：
 *   - ev_b03 有「屋子里的灯」；
 *   - ev_b05 / ev_b30 都含「他说」，一老一新，用来让两档排出不同顺序；
 *   - ev_b17 是「难过」，用来验同义词那条。
 */
function buildEvents() {
  const special = new Map([
    [3, '屋子里那盏灯我擦了三遍，还是有点灰。'],
    [5, '他说过那句「先放着」，我记下来了。'],
    [17, '今天有点难过，说不上为什么。'],
    [30, '他说：明天再说吧。'],
  ])
  const out = []
  for (let i = 0; i < 50; i += 1) {
    out.push({
      id: `ev_b${String(i).padStart(2, '0')}`,
      v: 1,
      ts: new Date(T0 + i * 3_600_000).toISOString(),
      day: 1,
      stage: 1,
      type: i % 3 === 0 ? 'heard' : i % 7 === 0 ? 'judgment' : 'utterance',
      source: 'system',
      text: special.get(i) ?? `第 ${i} 条：日常里的一点小事，没什么要特别记住的。`,
      refs: [],
      verdict: null,
      confidence: 0.5,
      flags: [],
    })
  }
  return out
}

const QUERIES = [
  { q: '屋子里的灯', expect: ['ev_b03'] },
  { q: '他说', expect: ['ev_b05'] },
  { q: '不开心', expect: ['ev_b17'] },
]

/** 假的同义词表：只把「不开心」改写成「难过」，够验工装是不是真的把改写送进去了 */
function fakeExpand(q) {
  return q === '不开心' ? ['难过'] : []
}

function benchNow() {
  // 固定 now：日期与 ago 不随运行时间漂，断言才能写死
  return T0 + 50 * 3_600_000 + 86_400_000
}

test('汇总里有真的 p50 / p95，不是 NaN', () => {
  const events = buildEvents()
  const bench = runBench(events, QUERIES, { now: benchNow(), solidIds: new Set(['ev_b05']), expand: fakeExpand })
  assert.equal(bench.n, 3)
  assert.equal(bench.expected, 3)
  for (const mode of ['literal', 'ranked']) {
    const s = bench.summary[mode]
    assert.equal(typeof s.p50, 'number')
    assert.equal(typeof s.p95, 'number')
    assert.ok(Number.isFinite(s.p50) && s.p50 >= 0, `${mode}.p50 = ${s.p50}`)
    assert.ok(Number.isFinite(s.p95) && s.p95 >= 0, `${mode}.p95 = ${s.p95}`)
    assert.ok(s.p95 >= s.p50, 'p95 不该小于 p50')
    assert.ok(s.hits >= 0 && s.hits <= 3)
  }
  assert.match(renderSummary(bench), /literal\s+命中 \d\/3/)
})

test('percentile 用最近秩，小样本也落在真实值上', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2)
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4)
  assert.equal(percentile([], 0.95), null)
})

test('两档参数口径：literal 不叠显著性，ranked 叠', () => {
  const lit = optionsFor('literal', { limit: 5 })
  assert.equal(lit.weigh, false)
  assert.equal(lit.mode, 'literal')
  const solid = new Set(['ev_b05'])
  const ranked = optionsFor('ranked', { limit: 5, solidIds: solid })
  assert.equal(ranked.weigh, true)
  assert.equal(ranked.mode, 'ranked')
  assert.equal(ranked.solidIds, solid)
})

test('「不开心」在 ranked 下能召回「难过」，literal 下不能', () => {
  const events = buildEvents()
  const item = { q: '不开心', expect: ['ev_b17'] }
  const lit = runOne(events, item, { mode: 'literal', now: benchNow() })
  assert.equal(lit.hits, 0, '字面模式下不该命中（这证明后面那条不是碰巧）')
  const ranked = runOne(events, item, {
    mode: 'ranked',
    now: benchNow(),
    solidIds: new Set(),
    expand: fakeExpand,
  })
  assert.equal(ranked.hits, 1)
  assert.equal(ranked.ids[0], 'ev_b17')
})

test('--diff 只打两档 top 不一样的行，格式稳定', () => {
  const events = buildEvents()
  const bench = runBench(events, QUERIES, { now: benchNow(), solidIds: new Set(['ev_b05']), expand: fakeExpand })

  const block = renderDiffRow({ ...bench.rows[1], i: 2 })
  assert.equal(
    block,
    '#02 「他说」\n  literal 1/1 ev_b30 ev_b05\n  ranked  1/1 ev_b05 ev_b30',
  )

  const report = renderReport(bench, { diff: true })
  assert.ok(report.includes(block), '不一致的那条要在报告里')
  assert.ok(!report.includes('「屋子里的灯」'), '两档一样的行不该出现在 --diff 里')
  assert.ok(report.includes('「不开心」'), 'literal 空、ranked 命中，这条也该算「不一样」')
  const same = renderReport(runBench(buildEvents(), [{ q: '屋子里的灯', expect: [] }], { now: benchNow(), solidIds: new Set() }), { diff: true })
  assert.match(same, /两档 top 完全一致/)
})

test('完整报告每条都带 id · 日期 · 首40字 与两档汇总', () => {
  const bench = runBench(buildEvents(), QUERIES, { now: benchNow(), solidIds: new Set(), expand: fakeExpand })
  const report = renderReport(bench, { diff: false })
  assert.match(report, /#01 「屋子里的灯」/)
  assert.match(report, /ev_b03 · \d{4}-\d{2}-\d{2} · /)
  assert.match(report, /—— 汇总 ——/)
  assert.match(report, /literal\s+命中/)
  assert.match(report, /ranked\s+命中/)
})

test('缺 queries.jsonl 时报错说清楚找的是哪、要什么格式', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fish-recall-bench-'))
  try {
    const missing = join(dir, 'queries.jsonl')
    assert.throws(
      () => readQueries(missing),
      (e) => {
        assert.ok(e.message.includes(missing), e.message)
        assert.match(e.message, /每行一条/)
        assert.match(e.message, /--queries/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('问卷坏行带行号，空问卷也报错', () => {
  assert.throws(
    () => parseQueries('{"q":"好的"}\n坏行', 'q.jsonl'),
    /q\.jsonl:2 不是合法 JSON/,
  )
  assert.throws(() => parseQueries('\n\n', 'q.jsonl'), /一条 query 都没有/)
  assert.throws(() => parseQueries('{"q":""}', 'q.jsonl'), /少了 "q"/)
  assert.throws(() => parseQueries('{"q":"x","expect":"ev_1"}', 'q.jsonl'), /"expect" 要是字符串数组/)
  assert.deepEqual(parseQueries('{"q":"x"}', 'q.jsonl'), [{ q: 'x', expect: [] }])
})

test('参数：默认值、--limit 越界、不认识的参数都直接报错', () => {
  const d = parseArgs([], { root: '/tmp/somewhere' })
  assert.equal(d.limit, DEFAULT_LIMIT)
  assert.equal(d.queriesPath, join('/tmp/somewhere', 'queries.jsonl'))
  assert.equal(d.json, false)

  const j = parseArgs(['--json', '--diff', '--limit', '3'], { root: '/tmp/somewhere' })
  assert.equal(j.json, true)
  assert.equal(j.diff, true)
  assert.equal(j.limit, 3)

  assert.throws(() => parseArgs(['--limit', '999'], { root: '/tmp/x' }), /1–20/)
  assert.throws(() => parseArgs(['--nope'], { root: '/tmp/x' }), /不认识的参数/)
})
