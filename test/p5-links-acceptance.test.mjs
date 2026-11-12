/**
 * p5-links-acceptance.test.mjs —— P5 记忆链接（M4）的独立验收
 *
 * 只验验收脚本这一层，不验产品排序（那是 lib/recall.js 的事）：
 *   ① links 关掉时，结果必须和「没有链接功能」逐字节一致；
 *   ② 参考实现 buildLinks：只连判断（utterance / revise），Dice >= 0.35，最多 3 条；
 *   ③ 1 跳扩散把链接挂在父条目后面，标出 related，裁到 limit；
 *   ④ 「变差」判定与输出格式稳定（query、位次、被挤掉的 id 都在）；
 *   ⑤ 三列表头 / 汇总 / top1 差异的文本格式。
 *
 * 真账本在 ~/.dsh-perch-samples/，不进仓库；这里只用合成账本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LINKS_MAX,
  LINKS_MIN_DICE,
  buildLinks,
  diceOf,
  findRegressions,
  loadLinksSupport,
  optionsFor,
  percentile,
  renderP5Report,
  renderP5Row,
  renderP5Summary,
  renderP5TopDiff,
  renderRegression,
  runBench,
  runP5,
  spreadLinkedRows,
} from '../tools/recall-bench.mjs'

const T0 = Date.parse('2026-09-01T00:00:00Z')
const HOUR = 3_600_000

/** 合成事件：字段与 store.js 写出来的一致，searchEvents 才吃得下 */
function ev(i, type, text) {
  return {
    id: `ev_p5${String(i).padStart(2, '0')}`,
    v: 1,
    ts: new Date(T0 + i * HOUR).toISOString(),
    day: 1,
    stage: 1,
    type,
    source: 'system',
    text,
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
  }
}

/**
 * 一小份有结构的账本：
 *   - ev_p501 / 02 / 05 三条「信任…」高度相似，该互相连上；
 *   - ev_p503 完全无关，不该建边；
 *   - ev_p504 只有两个字，tokens < 2，不参与；
 *   - ev_p506 是 heard，听到的话不算「判断」，不当链接的源头；
 *   - ev_p507 是 meta，回忆里根本不出现。
 */
function buildLedger() {
  return [
    ev(1, 'utterance', '信任是一句话'),
    ev(2, 'utterance', '信任不是一句话'),
    ev(3, 'utterance', '完全无关的天空'),
    ev(4, 'utterance', '面'),
    ev(5, 'revise', '信任从来不是一句话'),
    ev(6, 'heard', '信任是一句话吗'),
    ev(7, 'meta', '账本快照：信任'),
  ]
}

const NOW = T0 + 24 * HOUR

function denseLinks(events) {
  const ids = events.map((e) => e.id)
  const m = new Map()
  for (const id of ids) m.set(id, ids.filter((x) => x !== id))
  return m
}

test('diceOf：没有交集就是 0，交集按 2|A∩B|/(|A|+|B|)', () => {
  assert.equal(diceOf([], ['a']), 0)
  assert.equal(diceOf(['a'], ['b']), 0)
  assert.equal(diceOf(['a', 'b'], ['a', 'b']), 1)
  assert.equal(diceOf(['a', 'b'], ['a', 'c']), 0.5)
})

test('buildLinks：只连 utterance / revise，Dice >= 0.35，最多 3 条', () => {
  const events = buildLedger()
  const links = buildLinks(events)

  assert.ok(links.get('ev_p501').includes('ev_p502'), '相似的两条要连上')
  assert.ok(links.get('ev_p501').includes('ev_p505'), 'revise 也是判断，要算')
  assert.ok(!links.has('ev_p503'), '没有交集的不建边')
  assert.ok(!links.has('ev_p504'), 'tokens 太少的跳过')
  assert.ok(!links.has('ev_p506'), 'heard 不是判断，不当源头')
  assert.ok(!links.has('ev_p507'), 'meta 不参与')

  for (const ids of links.values()) assert.ok(ids.length <= LINKS_MAX && ids.length > 0)

  const strict = buildLinks(events, { minDice: 0.99 })
  assert.equal(strict.size, 0, '阈值调高后不该还有边')
  assert.equal(LINKS_MIN_DICE, 0.35)

  const one = buildLinks(events, { maxLinks: 1 })
  for (const ids of one.values()) assert.equal(ids.length, 1)
})

test('spreadLinkedRows：挂在父条目后面，标 related，跳过 meta，裁到 limit', () => {
  const events = buildLedger()
  const base = [{ id: 'ev_p501', date: '2026-09-01', ago: 0, type: 'utterance', text: '信任是一句话' }]
  const links = new Map([['ev_p501', ['ev_p502', 'ev_p505', 'ev_p507']]])
  const out = spreadLinkedRows(events, base, links, { limit: 3, now: NOW })

  assert.deepEqual(out.map((r) => r.id), ['ev_p501', 'ev_p502', 'ev_p505'])
  assert.equal(out[0].related, undefined)
  assert.equal(out[1].related, 'ev_p501')
  assert.match(out[1].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(!out.some((r) => r.id === 'ev_p507'), 'meta 不出现')
  assert.equal(out.length, 3, '不超过 limit')
})

test('性质：links 关掉时与「没有链接功能」逐字节一致（同一条账本跑两次）', () => {
  const events = buildLedger()
  const queries = [{ q: '信任', expect: ['ev_p502'] }, { q: '无关', expect: ['ev_p503'] }]
  const solidIds = new Set()

  const p5 = runP5(events, queries, { now: NOW, solidIds, links: buildLinks(events), linksKind: 'reference' })
  const again = runP5(events, queries, { now: NOW, solidIds, links: buildLinks(events), linksKind: 'reference' })
  const noLinks = runBench(events, queries, { now: NOW, solidIds })

  p5.rows.forEach((r, i) => {
    assert.equal(
      JSON.stringify(r.linksOff.rows),
      JSON.stringify(noLinks.rows[i].ranked.rows),
      `${r.q}：links 关的结果必须与没有链接功能时逐字节一致`,
    )
    assert.equal(JSON.stringify(again.rows[i].linksOff.rows), JSON.stringify(r.linksOff.rows), '同一账本跑两次必须一样')
    assert.deepEqual(r.linksOff.ids, noLinks.rows[i].ranked.ids)
  })
  assert.equal(p5.summary.linksOff.hits, noLinks.summary.ranked.hits)

  // 链接表换成「人人都连人人」，links 关那一列也不许动
  const dense = runP5(events, queries, { now: NOW, solidIds, links: denseLinks(events), linksKind: 'reference' })
  dense.rows.forEach((r, i) => {
    assert.deepEqual(r.linksOff.ids, noLinks.rows[i].ranked.ids)
  })
  assert.ok(dense.rows.some((r) => !r.sameOffOn), '参考实现至少要真能带出东西，否则这条性质是空转')

  // 开关不存在时发出的参数里就不该有 links 键
  assert.ok(!('links' in optionsFor('ranked', { limit: 3, solidIds })))
  assert.ok(!('links' in optionsFor('literal', { limit: 3 })))
})

test('findRegressions：命中变未命中、位次后退都算变差，带被挤掉的 id', () => {
  const rows = [
    {
      q: 'q',
      expect: ['ev_x', 'ev_y'],
      linksOff: { ids: ['ev_x', 'ev_a', 'ev_b'] },
      linksOn: { ids: ['ev_a', 'ev_x'] },
    },
    {
      q: '丢了',
      expect: ['ev_z'],
      linksOff: { ids: ['ev_z'] },
      linksOn: { ids: ['ev_q'] },
    },
    {
      q: '没命中过',
      expect: ['ev_n'],
      linksOff: { ids: ['ev_a'] },
      linksOn: { ids: ['ev_b'] },
    },
  ]
  const reg = findRegressions(rows)
  assert.equal(reg.length, 2, '第三条两边都没命中，不算变差')
  assert.deepEqual(
    reg.map((r) => [r.i, r.expect, r.offPos, r.onPos]),
    [[1, 'ev_x', 0, 1], [2, 'ev_z', 0, -1]],
  )
  assert.deepEqual(reg[0].dropped, ['ev_b'])
  assert.deepEqual(reg[1].dropped, [], '被挤掉的是期望那条自己，不重复列')
  assert.equal(
    renderRegression(reg[0]),
    '  ! #01 「q」 ev_x 位次 1 → 2；被挤掉 ev_b',
  )
  assert.match(renderRegression(reg[1]), /位次 1 → 未命中；被挤掉 （其余条目都还在）/)
})

test('三列表格：命中数 / ms / related 标注', () => {
  const row = {
    i: 1,
    q: '信任',
    expect: ['ev_p502'],
    literal: { hits: 1, ms: 1, rows: [{ id: 'ev_p502', date: '2026-09-01', text: '信任不是一句话' }] },
    linksOff: { hits: 1, ms: 2, rows: [{ id: 'ev_p502', date: '2026-09-01', text: '信任不是一句话' }] },
    linksOn: {
      hits: 1,
      ms: 1.5,
      rows: [
        { id: 'ev_p502', date: '2026-09-01', text: '信任不是一句话' },
        { id: 'ev_p501', date: '2026-09-01', text: '信任是一句话', related: 'ev_p502' },
      ],
    },
  }
  assert.equal(
    renderP5Row(row),
    [
      '#01 「信任」 期望 1 条',
      '  literal 1/1 1.00ms',
      '    - ev_p502 · 2026-09-01 · 信任不是一句话',
      '  links 关 1/1 2.00ms',
      '    - ev_p502 · 2026-09-01 · 信任不是一句话',
      '  links 开 1/1 1.50ms',
      '    - ev_p502 · 2026-09-01 · 信任不是一句话',
      '    - ev_p501 · 2026-09-01 · 信任是一句话（由 ev_p502 带出）',
    ].join('\n'),
  )
})

test('汇总：三行命中率与 p50 / p95，判定跟着有没有变差走', () => {
  const side = (hits, p50, p95) => ({ hits, hitRate: hits / 2, p50, p95 })
  const bench = {
    expected: 2,
    summary: {
      literal: side(1, 1, 2),
      linksOff: side(2, 1.5, 2.5),
      linksOn: side(2, 2, 3),
    },
    regressions: [],
    rows: [],
  }
  const text = renderP5Summary(bench)
  assert.match(text, /literal\s+命中 1\/2（50%）\s+p50 1\.00ms\s+p95 2\.00ms/)
  assert.match(text, /links 关\s+命中 2\/2（100%）/)
  assert.match(text, /links 开\s+命中 2\/2（100%）/)
  assert.match(text, /没有变差/)

  const worse = renderP5Summary({
    ...bench,
    summary: { ...bench.summary, linksOn: side(1, 2, 3) },
    regressions: [{ i: 1, q: 'q', expect: 'ev_x', offPos: 0, onPos: -1, worse: true, dropped: [] }],
  })
  assert.match(worse, /有 1 条变差/)

  const noExpect = renderP5Summary({ ...bench, expected: 0, summary: {
    literal: { hits: 0, hitRate: null, p50: 1, p95: 2 },
    linksOff: { hits: 0, hitRate: null, p50: 1, p95: 2 },
    linksOn: { hits: 0, hitRate: null, p50: 1, p95: 2 },
  }, regressions: [] })
  assert.match(noExpect, /问卷没标 expect/)
})

test('top1 差异：只列三档不一致的行', () => {
  const bench = {
    rows: [
      { q: '一样', top1: { literal: 'a', linksOff: 'a', linksOn: 'a' } },
      { q: '被带回来', top1: { literal: 'a', linksOff: 'b', linksOn: 'c' } },
    ],
  }
  const text = renderP5TopDiff(bench)
  assert.match(text, /#02 「被带回来」 literal a · off b · on c/)
  assert.ok(!text.includes('「一样」'))
  assert.match(renderP5TopDiff({ rows: [{ q: 'x', top1: { literal: 'a', linksOff: 'a', linksOn: 'a' } }] }), /三档 top1 全同/)

  const ledger = buildLedger()
  const report = renderP5Report(
    runP5(ledger, [{ q: '信任', expect: ['ev_p502'] }], {
      now: NOW,
      solidIds: new Set(),
      links: buildLinks(ledger),
      linksKind: 'reference',
    }),
  )
  assert.match(report, /—— 汇总 ——/)
  assert.match(report, /—— 三档 top1 差异 ——/)
})

test('percentile 与产品落地探测：没落地就是 reference，落地了就用产品的 buildLinks', async () => {
  assert.equal(percentile([3, 1, 2], 0.95), 3)
  assert.equal(percentile([], 0.5), null)
  const support = await loadLinksSupport()
  assert.ok(support.kind === 'lib' || support.kind === 'reference')
  if (support.kind === 'reference') assert.equal(support.build, buildLinks)
  assert.equal(typeof support.recallKnows, 'boolean')
})
