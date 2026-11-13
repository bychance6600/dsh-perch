/**
 * acceptance-memory.test.mjs —— 记忆验收工装的纯函数与页面桩
 *
 * 不碰真账本、不跑全量回归；真账本矩阵在 tools/acceptance-memory.mjs。
 * 合成数据只用来钉：realm 归一化后的坐标比较、kinds 统计、缺 heard 时的判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  countKinds,
  readLedger,
  runPage,
  checkLayoutDeterminism,
  checkFilterDecoupling,
  triggerStatusFilter,
  parseArgs,
  EXPECTED_KIND_COUNTS,
} from '../tools/acceptance-memory.mjs'

const T0 = Date.parse('2026-11-10T12:00:00.000Z')

function node(id, overrides = {}) {
  return {
    id,
    kind: 'belief',
    text: '今天风很大',
    at: new Date(T0).toISOString(),
    conf: 0.7,
    status: 'active',
    supersededBy: null,
    mentions: 1,
    ...overrides,
  }
}

function sampleData() {
  return {
    ok: true,
    stage: 2,
    stageName: '开始记得',
    events: 4,
    stats: { beliefs: 2, scars: 1, refuted: 1, refined: 0, tension: 0, hard: 0 },
    nodes: [
      node('a', { text: '楼下那只猫今天又来了' }),
      node('b', { text: '我不喜欢下雨天', status: 'refuted', supersededBy: 'a' }),
      node('c', { text: '今天风很大' }),
      node('d', { kind: 'scar', text: '那次我没说出口' }),
    ],
    edges: [{ s: 'b', t: 'a', kind: 'refuted', w: 0.6 }],
  }
}

test('parseArgs：默认根目录与 --skip-regression', () => {
  const a = parseArgs([])
  assert.equal(a.skipRegression, false)
  assert.ok(a.root.endsWith('.dsh-perch-samples'))
  const b = parseArgs(['--root', '/tmp/x', '--json', '--skip-regression'])
  assert.equal(b.root, '/tmp/x')
  assert.equal(b.json, true)
  assert.equal(b.skipRegression, true)
  assert.throws(() => parseArgs(['--nope']), /不认识的参数/)
})

test('countKinds：按 kind 计数与 JSON 字节数', () => {
  const got = countKinds(sampleData().nodes)
  assert.equal(got.total, 4)
  assert.equal(got.byKind.belief.count, 3)
  assert.equal(got.byKind.scar.count, 1)
  assert.ok(got.byKind.belief.bytes > 0)
  assert.ok(got.bytes > 0)
  assert.deepEqual(Object.keys(EXPECTED_KIND_COUNTS), ['belief', 'utterance', 'heard'])
})

test('readLedger：逐行计数、字节与坏行数；缺文件报清楚', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-acc-'))
  try {
    const file = join(dir, 'events.jsonl')
    await writeFile(file, [
      JSON.stringify({ id: '1', type: 'utterance', text: 'a' }),
      JSON.stringify({ id: '2', type: 'heard', text: 'b' }),
      '{坏行',
      '',
    ].join('\n'), 'utf8')
    const got = readLedger(dir)
    assert.equal(got.lines, 3)
    assert.equal(got.types.utterance.count, 1)
    assert.equal(got.types.heard.count, 1)
    assert.equal(got.types.unknown.count, 1)
    assert.equal(got.parseErrors, 1)
    assert.ok(got.bytes > 0)
    assert.throws(() => readLedger(join(dir, 'nope')), /读不到账本/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('页面桩：同一份数据跑两次，axes 与全部屏幕坐标 deepEqual', async () => {
  const data = sampleData()
  const a = await runPage(data)
  const b = await runPage(data)
  assert.equal(a.coords.length, 4)
  assert.deepEqual(a.stats.axes, b.stats.axes)
  assert.deepEqual(a.coords, b.coords)
  assert.ok(a.paintMs > 0)
  const det = await checkLayoutDeterminism(data)
  assert.equal(det.status, '通过')
  assert.match(det.measured, /axes \+ 4 个屏幕坐标 deepEqual=true/)
})

test('没有 heard：验收项明确不通过，但 status 过滤前后 belief 坐标不变', async () => {
  const data = sampleData()
  const got = await checkFilterDecoupling(data)
  assert.equal(got.status, '不通过')
  assert.match(got.measured, /没有 heard/)
  assert.equal(got.detail.proxy.same, true)
  assert.equal(got.detail.proxy.filter, 'status=refuted')

  const run = await runPage(data)
  const pick = () => [0, 1, 2, 3]
    .filter((i) => data.nodes[i].kind === 'belief')
    .map((i) => {
      const p = run.graph.clientOf(i)
      return { x: p.x, y: p.y, id: p.id }
    })
  const before = pick()
  triggerStatusFilter(run, 'refuted')
  const after = pick()
  assert.deepEqual(before, after)
  const stats = JSON.parse(JSON.stringify(run.graph.stats()))
  assert.equal(stats.matched, 1, 'refuted 过滤只留下 1 个 belief')
})
