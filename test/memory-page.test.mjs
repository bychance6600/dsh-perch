/**
 * memory-page.test.mjs —— 记忆页「真 3D」的结构与行为守门
 *
 * 不启动浏览器：布局、投影、拾取、上色、面板都是纯函数；
 * 页面字符串只检查那些不能丢的入口和文案。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { memoryCore, MEMORY_PAGE } from '../lib/memory-page.js'

const core = memoryCore()
const OPTS = { seed: 1234567 }

function makeNodes(n) {
  const kinds = ['belief', 'utterance', 'heard']
  return Array.from({ length: n }, (_, i) => ({
    id: 'n' + i,
    kind: kinds[i % 3],
    text: '第' + i + '条记录，猫在窗台上',
    at: '2026-10-' + String((i % 28) + 1).padStart(2, '0'),
    source: i % 2 ? 'qq' : 'bili',
    mentions: i % 5,
  }))
}

function hue(rgb) {
  const sum = rgb[0] + rgb[1] + rgb[2]
  return [rgb[0] / sum, rgb[1] / sum]
}

test('3D 空间殖民：2363 点首帧布局 < 300ms，固定种子逐坐标可复现', () => {
  const nodes = makeNodes(2363)
  const t0 = performance.now()
  const model = core.buildModel({ nodes }, OPTS)
  const ms = performance.now() - t0

  assert.equal(model.nodes.length, 2363)
  assert.ok(ms < 300, '2363 点布局耗时 ' + ms.toFixed(1) + 'ms，超过 300ms')
  let far = 0
  for (const n of model.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z))
    const r = Math.hypot(n.x, n.y, n.z)
    if (r > far) far = r
  }
  assert.ok(far > 80, '点只铺在中心一小团：最大半径 ' + far.toFixed(1))

  const a = core.buildModel({ nodes: makeNodes(800) }, OPTS)
  const b = core.buildModel({ nodes: makeNodes(800) }, OPTS)
  assert.deepEqual(a.nodes.map((n) => [n.x, n.y, n.z]), b.nodes.map((n) => [n.x, n.y, n.z]))
})

test('5 万点：首帧 < 1200ms，先画 12000 个，随后补全到全部', () => {
  const nodes = makeNodes(50000)
  const t0 = performance.now()
  const model = core.buildModel({ nodes }, OPTS)
  const ms = performance.now() - t0

  assert.equal(model.nodes.length, 50000)
  assert.ok(ms < 1200, '5 万点首帧布局 ' + ms.toFixed(1) + 'ms，超过 1200ms')

  let limit = core.initialDrawLimit(model.nodes.length)
  assert.equal(limit, 12000)
  limit = core.nextDrawLimit(limit, model.nodes.length, core.LAYOUT.DRAW_STEP)
  assert.equal(limit, 16000)
  for (let i = 0; i < 20 && limit < model.nodes.length; i++) {
    limit = core.nextDrawLimit(limit, model.nodes.length, core.LAYOUT.DRAW_STEP)
  }
  assert.equal(limit, 50000)
  assert.match(MEMORY_PAGE, /setTimeout\(function\(\)\{\s*fillTimer = null;/)
  assert.match(MEMORY_PAGE, /\}, 200\);/)
})

test('颜色只由 kind 决定：远近只改大小与亮度，不改色相；heard 更小更暗', () => {
  for (const kind of ['belief', 'utterance', 'heard']) {
    const near = core.colorFor(kind, 0.9)
    const far = core.colorFor(kind, 0.45)
    const hn = hue([near.r, near.g, near.b])
    const hf = hue([far.r, far.g, far.b])
    assert.ok(Math.abs(hn[0] - hf[0]) < 0.015, kind + ' 近处色相变了')
    assert.ok(Math.abs(hn[1] - hf[1]) < 0.015, kind + ' 近处色相变了')
    assert.ok(near.r + near.g + near.b > far.r + far.g + far.b, kind + ' 远处应该更暗')
  }
  const belief = core.nodeStyle({ kind: 'belief' }, 0.8)
  const heard = core.nodeStyle({ kind: 'heard' }, 0.8)
  assert.ok(heard.radius < belief.radius, 'heard 应该更小')
  assert.ok(heard.color.a < belief.color.a, 'heard 应该更暗')
})

test('关掉 heard 只改可见性，不改判断坐标', () => {
  const model = core.buildModel({ nodes: makeNodes(900) }, OPTS)
  const before = model.nodes.map((n) => [n.id, n.x, n.y, n.z])
  const filter = { types: { belief: true, utterance: true, heard: false }, onlyCited: false, q: '' }
  const belief = model.nodes.find((n) => n.kind === 'belief')
  const heard = model.nodes.find((n) => n.kind === 'heard')
  assert.equal(core.matchNode(heard, filter), false)
  assert.equal(core.matchNode(belief, filter), true)
  assert.deepEqual(model.nodes.map((n) => [n.id, n.x, n.y, n.z]), before)
})

test('透视与拾取：同点远处更小；12px 内取最近，同距离取 z 小（靠前）', () => {
  const view = { yaw: 0, pitch: 0, dist: 430 }
  const center = core.project({ x: 0, y: 0, z: 0 }, view, 1000, 800)
  assert.equal(Math.round(center.x), 500)
  assert.equal(Math.round(center.y), 400)
  const near = core.project({ x: 40, y: 0, z: -120 }, view, 1000, 800)
  const far = core.project({ x: 40, y: 0, z: 120 }, view, 1000, 800)
  assert.ok(near.s > far.s)

  function p(id, x, y, z) { return { id, x, y, z, node: { id } } }
  const points = [p('a', 100, 100, 5), p('b', 108, 100, 3), p('c', 92, 100, -3), p('d', 130, 100, 0)]
  const picked = core.pickNearest(points, 100, 100, 12)
  assert.equal(picked.id, 'a', '最近的 0px 点应该优先')
  const tie = core.pickNearest([p('back', 108, 100, 2), p('front', 92, 100, -2)], 100, 100, 12)
  assert.equal(tie.id, 'front', '同距离取 z 更小的')
  assert.equal(core.pickNearest(points, 200, 200, 12), null)
})

test('侧栏：旧句 → 改口 → 现话；改过但账本没留旧句也留标题', () => {
  const model = core.buildModel({
    nodes: [
      { id: 'old', kind: 'belief', text: '我不喜欢猫。', status: 'refuted', supersededBy: 'fresh', at: '2026-10-01', source: 'qq' },
      { id: 'fresh', kind: 'belief', text: '猫挺可爱的。', status: 'active', at: '2026-10-02', source: 'qq' },
      { id: 'r1', kind: 'belief', text: '大概吧。', status: 'refined', at: '2026-10-03', source: 'bili' },
    ],
  }, OPTS)
  assert.equal(core.chainRows(model.byId.old, model).length, 1)
  assert.equal(core.chainRows(model.byId.fresh, model).length, 1)
  const html = core.panelHtml(model.byId.old, model)
  assert.match(html, /我不喜欢猫/)
  assert.match(html, /猫挺可爱的/)
  assert.match(html, /她改过这里/)
  assert.match(html, /原话 → 改口 → 现话/)
  assert.match(html, /判断/)
  assert.match(html, /出处：qq/)
  assert.match(core.panelHtml(model.byId.r1, model), /她改过这里/)
  assert.match(core.panelHtml(null, model), /点一个点看她说的话/)
})

test('页面：默认收起 340px 抽屉、竖标签、三类计数、HUD 真数与补全提示', () => {
  assert.match(MEMORY_PAGE, /width:340px/)
  assert.match(MEMORY_PAGE, /translateX\(100%\)/)
  // 抽屉覆盖在画布上（挤压 stage 会在右边留一条黑带）
  assert.match(MEMORY_PAGE, /main\.panel-open #stage\{right:0\}/)
  assert.match(MEMORY_PAGE, /main\.panel-open \.zoom\{right:356px\}/)
  assert.match(MEMORY_PAGE, /这一条 ◀/)
  assert.match(MEMORY_PAGE, /<aside id="panel" class="panel" aria-hidden="true">/)
  for (const kind of ['belief', 'utterance', 'heard']) {
    assert.match(MEMORY_PAGE, new RegExp('data-kind="' + kind + '"'))
    assert.match(MEMORY_PAGE, new RegExp('data-count="' + kind + '"'))
  }
  assert.match(MEMORY_PAGE, /其余已长成判断/)
  assert.match(MEMORY_PAGE, /metaCounts/)
  assert.match(MEMORY_PAGE, /id="search"/)
  assert.match(MEMORY_PAGE, /id="onlyCited"/)
  assert.match(MEMORY_PAGE, /id="zoomReset"/)
  assert.match(MEMORY_PAGE, /<canvas id="graph"/)
})

test('投影按 z 远→近作画；拖动只改视角，不重跑布局；静止不自转', () => {
  assert.match(MEMORY_PAGE, /order\.sort\(function\(a,b\)\{ return b\.z - a\.z \}\)/)
  // 任意旋转：拖动走四元数轨道球（不再只有 yaw/pitch 两轴）
  assert.match(MEMORY_PAGE, /CORE\.qAxis\(-dy, dx, 0, len \* 0\.0055\)/)
  assert.match(MEMORY_PAGE, /view\.q = CORE\.qNorm\(CORE\.qMul\(dq, drag\.q/)
  // 滚轮按当前距离缩放（近处更细），范围 70–900；Shift+拖动平移
  assert.match(MEMORY_PAGE, /var stepK = Math\.max\(0\.08, view\.dist \/ CORE\.VIEW\.DIST\) \* 0\.5/)
  assert.match(MEMORY_PAGE, /view\.dist = clamp\(view\.dist \+ ev\.deltaY \* stepK, CORE\.VIEW\.DIST_MIN, CORE\.VIEW\.DIST_MAX\)/)
  assert.match(MEMORY_PAGE, /view\.panX = drag\.panX \+ dx/)
  assert.doesNotMatch(MEMORY_PAGE, /view\.q\s*\+=/)
  assert.doesNotMatch(MEMORY_PAGE, /requestAnimationFrame/)
  assert.match(MEMORY_PAGE, /CORE\.buildModel\(data\)/)
})

test('文案与只读：固定页脚、无「他」、无「四道门/三道门」、无外部脚本', () => {
  assert.match(MEMORY_PAGE, /颜色是事件的种类，枝干是生长顺序，不是论断之间的关系/)
  assert.doesNotMatch(MEMORY_PAGE, /他/)
  assert.doesNotMatch(MEMORY_PAGE, /四道门|三道门/)
  assert.doesNotMatch(MEMORY_PAGE, /localStorage|indexedDB|document\.cookie/)
  assert.doesNotMatch(MEMORY_PAGE, /<script[^>]+src=/)
  assert.match(MEMORY_PAGE, /fetch\(API, \{ cache: "no-store" \}\)/)
})
