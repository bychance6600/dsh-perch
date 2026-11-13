/**
 * memory-page-growth.test.mjs —— 记忆页「神经生长」版的结构守门
 *
 * 这里不启动浏览器，只测两件东西：
 *   1. 布局/筛选/面板这些纯函数在 3214 点规模上的行为；
 *   2. 页面字符串里那几条不能丢的入口（三类开关、搜索、只看被引用、侧栏）。
 *
 * 页面是自绘 canvas，坐标一旦被筛选改动就会「跳」，所以过滤只改可见性，
 * 不改 x/y；这一条单独测。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { memoryCore, MEMORY_PAGE } from '../lib/memory-page.js'

const core = memoryCore()
const OPTS = { width: 1440, height: 900, seed: 0x51ed270b }

function makeNodes(n) {
  const kinds = ['belief', 'utterance', 'heard']
  return Array.from({ length: n }, (_, i) => ({
    id: 'n' + i,
    kind: kinds[i % kinds.length],
    text: '第' + i + '条记录，猫在窗台上',
    at: '2026-10-' + String((i % 28) + 1).padStart(2, '0'),
    source: i % 2 ? 'qq' : 'bili',
    mentions: i % 5,
  }))
}

test('空间殖民：3214 点铺在椭圆里，单次布局 < 1s，固定种子可复现', () => {
  const nodes = makeNodes(3214)
  const t0 = performance.now()
  const model = core.buildModel({ nodes }, OPTS)
  const ms = performance.now() - t0

  assert.equal(model.nodes.length, 3214)
  assert.equal(model.branches.length, 3213)
  assert.ok(ms < 1000, '3214 点布局耗时 ' + ms.toFixed(1) + 'ms，超过 1s')

  const { rx, ry } = model.layout
  assert.ok(rx > 0 && ry > 0)
  let maxQ = 0
  for (const n of model.nodes) {
    const q = (n.x / rx) ** 2 + (n.y / ry) ** 2
    assert.ok(q <= 1.0001, n.id + ' 跑出椭圆：q=' + q)
    if (q > maxQ) maxQ = q
  }
  // 不能只铺中心一小团；至少要碰到椭圆半径的八成左右。
  assert.ok(maxQ > 0.64, '最大半径只到 ' + Math.sqrt(maxQ).toFixed(3))

  const small = makeNodes(500)
  const a = core.buildModel({ nodes: small }, OPTS)
  const b = core.buildModel({ nodes: small }, OPTS)
  assert.deepEqual(a.nodes.map((n) => [n.x, n.y]), b.nodes.map((n) => [n.x, n.y]))
})

test('三类开关：只改可见性，不改坐标；听过的话更暗', () => {
  const model = core.buildModel({ nodes: makeNodes(900) }, OPTS)
  const before = model.nodes.map((n) => [n.id, n.x, n.y])
  const byKind = (kind) => model.nodes.find((n) => n.kind === kind)
  const belief = byKind('belief')
  const utterance = byKind('utterance')
  const heard = byKind('heard')

  const f = { types: { belief: true, utterance: false, heard: true }, onlyCited: false, q: '' }
  assert.equal(core.matchNode(belief, f), true)
  assert.equal(core.matchNode(utterance, f), false)
  assert.equal(core.matchNode(heard, f), true)
  assert.equal(core.nodeAlpha(heard, { types: { belief: true, utterance: true, heard: true }, onlyCited: false, q: '' }) <
    core.nodeAlpha(belief, { types: { belief: true, utterance: true, heard: true }, onlyCited: false, q: '' }), true)

  // 过滤之后坐标一个都没动
  assert.deepEqual(model.nodes.map((n) => [n.id, n.x, n.y]), before)

  const allOff = { types: { belief: false, utterance: false, heard: false }, onlyCited: false, q: '' }
  assert.equal(core.matchNode(belief, allOff), false)
  assert.equal(core.matchNode(utterance, allOff), false)
  assert.equal(core.matchNode(heard, allOff), false)
})

test('搜索与只看被引用过：字面命中文本/出处/类型，引用门槛沿用旧页的 2 次', () => {
  const nodes = [
    { id: 'b1', kind: 'belief', text: '猫会自己找地方晒太阳', source: 'qq', mentions: 3, at: '2026-10-01' },
    { id: 'b2', kind: 'belief', text: '狗在门口等', source: 'bili', mentions: 0, at: '2026-10-02' },
    { id: 'u1', kind: 'utterance', text: '猫挺可爱的', source: 'qq', mentions: 1, at: '2026-10-03' },
    { id: 'h1', kind: 'heard', text: '今天下雨了', source: 'bili', mentions: 0, at: '2026-10-04' },
  ]
  const model = core.buildModel({ nodes }, OPTS)
  const get = (id) => model.byId[id]
  const search = { types: { belief: true, utterance: true, heard: true }, onlyCited: false, q: '猫' }
  assert.equal(core.matchNode(get('b1'), search), true)
  assert.equal(core.matchNode(get('u1'), search), true)
  assert.equal(core.matchNode(get('b2'), search), false)
  assert.equal(core.matchNode(get('h1'), search), false)

  const cited = { types: { belief: true, utterance: true, heard: true }, onlyCited: true, q: '' }
  assert.equal(core.matchNode(get('b1'), cited), true, '被引用 3 次应该留下')
  assert.equal(core.matchNode(get('u1'), cited), false, '只被引用 1 次不算')
  assert.equal(core.matchNode(get('b2'), cited), false)

  const typeSearch = { types: { belief: true, utterance: true, heard: true }, onlyCited: false, q: '听过的话' }
  assert.equal(core.matchNode(get('h1'), typeSearch), true, '搜索也应该能命中类型标签')
})

test('侧栏：改口链显示旧句/新句、「她改过这里」与「原话 → 改口 → 现话」', () => {
  const model = core.buildModel({
    nodes: [
      { id: 'old', kind: 'belief', text: '我不喜欢猫。', status: 'refuted', supersededBy: 'fresh', at: '2026-10-01', source: 'qq' },
      { id: 'fresh', kind: 'belief', text: '猫挺可爱的。', status: 'active', at: '2026-10-02', source: 'qq' },
    ],
  }, OPTS)
  const old = model.byId.old
  const rows = core.chainRows(old, model)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].old.id, 'old')
  assert.equal(rows[0].fresh.id, 'fresh')

  const freshRows = core.chainRows(model.byId.fresh, model)
  assert.equal(freshRows.length, 1, '新句那一侧也要能看见改口链')
  assert.equal(freshRows[0].old.id, 'old')

  const html = core.panelHtml(old, model)
  assert.match(html, /我不喜欢猫/)
  assert.match(html, /猫挺可爱的/)
  assert.match(html, /她改过这里/)
  assert.match(html, /原话 → 改口 → 现话/)
  assert.match(html, /判断/)
  assert.match(html, /2026-10-01/)
  assert.match(html, /出处：qq/)
  assert.match(core.panelHtml(model.byId.fresh, model), /我不喜欢猫/)
  assert.match(core.panelHtml(null, model), /点一个点看她说的话/)
})

test('页面字符串：三类开关、搜索、只看被引用、侧栏与固定页脚都在', () => {
  for (const kind of ['belief', 'utterance', 'heard']) {
    assert.match(MEMORY_PAGE, new RegExp('data-kind="' + kind + '"'))
  }
  assert.match(MEMORY_PAGE, /id="search"/)
  assert.match(MEMORY_PAGE, /id="onlyCited"/)
  assert.match(MEMORY_PAGE, /id="panel"/)
  assert.match(MEMORY_PAGE, /这一条 ◀/)
  assert.match(MEMORY_PAGE, /width:340px/)
  assert.match(MEMORY_PAGE, /translateX\(100%\)/)
  assert.match(MEMORY_PAGE, /translateY\(100%\)/)
  assert.match(MEMORY_PAGE, /canvas/)
  assert.match(MEMORY_PAGE, /scale\(s, s\)/)
  assert.match(MEMORY_PAGE, /rgba\(88,116,158,0\.16\)/)
  assert.match(MEMORY_PAGE, /#7ec8ff/)
  assert.match(MEMORY_PAGE, /#ce90ff/)
  assert.match(MEMORY_PAGE, /#56708f/)
  assert.match(MEMORY_PAGE, /颜色是事件的种类，枝干是生长顺序，不是论断之间的关系/)
  assert.match(MEMORY_PAGE, /fetch\(API, \{ cache: "no-store" \}\)/)
  assert.doesNotMatch(MEMORY_PAGE, /localStorage|indexedDB|document\.cookie/)
  assert.doesNotMatch(MEMORY_PAGE, /四道门|三道门/)
  assert.doesNotMatch(MEMORY_PAGE, /他/)
})
