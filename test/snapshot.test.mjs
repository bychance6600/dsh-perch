/**
 * snapshot.js —— 5 万条重放快照（2026-11-12）
 *
 * 守四件事：
 *   1. 200 / 1200 / 3000 条：快照读出的模型与 deriveSelf 全等；
 *   2. 指纹不匹配、文件坏、snapshot.events 比实际多 → 一律丢弃重放；
 *   3. 模型里有 Map / 未知字段 / 缺字段 → 不写，下次照常重放；
 *   4. 命中快照不调用 timedDeriveSelf，「上次重放」只记真实重放。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deriveSelf } from '../lib/derive.js'
import { readModel, readModelMeta, snapshotFingerprint, writeSnapshot } from '../lib/snapshot.js'
import { rebuild } from '../lib/store.js'
import { lastReplayAt, lastReplayMs, resetReplayStat } from '../lib/replaystat.js'
import { genEvents } from '../tools/bench.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-12T12:00:00.000Z')

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-snapshot-'))
  try {
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function writeEvents(root, events) {
  writeFileSync(
    join(root, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  )
}

function writeSnapshotPayload(root, payload) {
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify(payload), 'utf8')
}

async function seeded(root, n, now = NOW) {
  const events = genEvents(n)
  writeEvents(root, events)
  const model = deriveSelf(events, { now })
  const written = await writeSnapshot(root, model, events, { now })
  assert.equal(written.ok, true, '快照应该写成功')
  return { events, model, written }
}

test('指纹由条数、最后一条 id、本地日期、阶段跨度组成', () => {
  const events = genEvents(3)
  const fp = snapshotFingerprint(events, { now: NOW })
  assert.match(fp, /^3:ev_bench_[^:]+:\d{4}-\d{2}-\d{2}:30$/)

  // dayKey 按本地日期算，不是 UTC。
  const late = new Date(2026, 10, 12, 23, 30, 0)
  const next = new Date(2026, 10, 13, 0, 30, 0)
  assert.match(snapshotFingerprint(events, { now: late }), /:2026-11-12:/)
  assert.match(snapshotFingerprint(events, { now: next }), /:2026-11-13:/)

  // stageSpanDays 与 deriveSelf 用同一个 clampInt：7–180，默认 30。
  assert.match(snapshotFingerprint(events, { now: NOW, stageSpanDays: 1 }), /:7$/)
  assert.match(snapshotFingerprint(events, { now: NOW, stageSpanDays: 999 }), /:180$/)
  assert.match(snapshotFingerprint(events, { now: NOW, stageSpanDays: 45 }), /:45$/)

  assert.equal(snapshotFingerprint([], { now: NOW }), null)
  const noId = [{ ...events[0], id: '' }]
  assert.equal(snapshotFingerprint(noId, { now: NOW }), null)
})

test('200 / 1200 / 3000 条：快照模型与 deriveSelf 全等', async () => {
  for (const n of [200, 1200, 3000]) {
    await withRoot(async (root) => {
      const { model } = await seeded(root, n)

      const meta = await readModelMeta(root, { now: NOW })
      assert.equal(meta.fromSnapshot, true, `${n} 条应该命中快照`)
      assert.equal(meta.reason, 'hit')
      assert.deepStrictEqual(meta.model, model, `${n} 条快照模型必须与 deriveSelf 全等`)

      const direct = await readModel(root, { now: NOW })
      assert.deepStrictEqual(direct, model)

      // 0600：快照里有她的全部模型，不能给同机其他用户顺手读。
      const mode = statSync(join(root, 'snapshot.json')).mode & 0o777
      assert.equal(mode, 0o600)
    })
  }
})

test('rebuild 之后真的留下快照，下一次读命中', async () => {
  await withRoot(async (root) => {
    const events = genEvents(200)
    writeEvents(root, events)
    const state = await rebuild(root, { now: NOW, stageSpanDays: 30 })
    assert.equal(state.events, 200)
    assert.equal(existsSync(join(root, 'snapshot.json')), true)

    const meta = await readModelMeta(root, { now: NOW })
    assert.equal(meta.fromSnapshot, true)
    assert.deepStrictEqual(meta.model, deriveSelf(events, { now: NOW }))
  })
})

test('指纹不匹配（跨天）→ 丢弃快照重放', async () => {
  await withRoot(async (root) => {
    const { events } = await seeded(root, 200)
    resetReplayStat()
    const later = NOW + DAY
    const meta = await readModelMeta(root, { now: later })
    assert.equal(meta.fromSnapshot, false)
    assert.equal(meta.reason, 'fingerprint-mismatch')
    assert.deepStrictEqual(meta.model, deriveSelf(events, { now: later }))
    assert.ok(lastReplayAt() > 0, '未命中必须记一次真实重放')
  })
})

test('账本追加一条 → 条数/最后 id 对不上，丢弃快照', async () => {
  await withRoot(async (root) => {
    await seeded(root, 200)
    const events = genEvents(201)
    writeEvents(root, events)
    const meta = await readModelMeta(root, { now: NOW })
    assert.equal(meta.fromSnapshot, false)
    assert.equal(meta.reason, 'count-mismatch')
    assert.deepStrictEqual(meta.model, deriveSelf(events, { now: NOW }))
  })
})

test('snapshot.events 大于实际条数 → 丢弃快照', async () => {
  await withRoot(async (root) => {
    await seeded(root, 200)
    // 账本“变短”在只追加的真实世界里不会发生；发生了就是快照来自另一份账本。
    const events = genEvents(100)
    writeEvents(root, events)
    const meta = await readModelMeta(root, { now: NOW })
    assert.equal(meta.fromSnapshot, false)
    assert.equal(meta.reason, 'stale-count')
    assert.deepStrictEqual(meta.model, deriveSelf(events, { now: NOW }))
  })
})

test('快照文件坏 → 改名留证据，丢弃重放', async () => {
  await withRoot(async (root) => {
    const { events } = await seeded(root, 200)
    writeFileSync(join(root, 'snapshot.json'), '{"v":1,"model":', 'utf8')
    const meta = await readModelMeta(root, { now: NOW })
    assert.equal(meta.fromSnapshot, false)
    assert.deepStrictEqual(meta.model, deriveSelf(events, { now: NOW }))
    // readJson 会把坏文件改名 .corrupt.*，不静默吞掉。
    assert.equal(existsSync(join(root, 'snapshot.json')), false)
  })
})

test('快照模型缺字段 / 多字段 → 不读，重放', async () => {
  await withRoot(async (root) => {
    const { events, model } = await seeded(root, 200)
    const payload = JSON.parse(readFileSync(join(root, 'snapshot.json'), 'utf8'))
    delete payload.model.tested
    writeSnapshotPayload(root, payload)
    const missing = await readModelMeta(root, { now: NOW })
    assert.equal(missing.fromSnapshot, false)
    assert.equal(missing.reason, 'bad-model')
    assert.deepStrictEqual(missing.model, model)

    const extra = { ...model, surprise: 1 }
    const w = await writeSnapshot(root, extra, events, { now: NOW })
    assert.equal(w.ok, false)
    assert.equal(w.reason, 'bad-model')
  })
})

test('模型里有 Map → writeSnapshot 不写盘，下次照常重放', async () => {
  await withRoot(async (root) => {
    const events = genEvents(200)
    writeEvents(root, events)
    const model = deriveSelf(events, { now: NOW })
    const bad = { ...model, needs: new Map() }
    const w = await writeSnapshot(root, bad, events, { now: NOW })
    assert.equal(w.ok, false)
    assert.equal(w.reason, 'bad-model')
    assert.equal(existsSync(join(root, 'snapshot.json')), false)

    const meta = await readModelMeta(root, { now: NOW })
    assert.equal(meta.fromSnapshot, false)
    assert.deepStrictEqual(meta.model, model)
  })
})

test('空账本算不出指纹 → 不写快照', async () => {
  await withRoot(async (root) => {
    writeEvents(root, [])
    const w = await writeSnapshot(root, {}, [], { now: NOW })
    assert.equal(w.ok, false)
    assert.equal(w.reason, 'no-fingerprint')
    assert.equal(existsSync(join(root, 'snapshot.json')), false)
  })
})

test('启动 miss 且 opts.persist → 补写快照；下一次命中', async () => {
  await withRoot(async (root) => {
    const events = genEvents(200)
    writeEvents(root, events)
    assert.equal(existsSync(join(root, 'snapshot.json')), false)

    const miss = await readModelMeta(root, { now: NOW, persist: true })
    assert.equal(miss.fromSnapshot, false)
    assert.equal(miss.wrote, 'written')
    assert.equal(existsSync(join(root, 'snapshot.json')), true)

    const hit = await readModelMeta(root, { now: NOW, persist: true })
    assert.equal(hit.fromSnapshot, true)
    assert.deepStrictEqual(hit.model, miss.model)
  })
})

test('命中快照不污染「上次重放」；未命中才记', async () => {
  await withRoot(async (root) => {
    await seeded(root, 200)
    resetReplayStat()
    const hit = await readModelMeta(root, { now: NOW })
    assert.equal(hit.fromSnapshot, true)
    assert.equal(lastReplayMs(), 0)
    assert.equal(lastReplayAt(), 0)

    const events = genEvents(201)
    writeEvents(root, events)
    const miss = await readModelMeta(root, { now: NOW })
    assert.equal(miss.fromSnapshot, false)
    assert.ok(lastReplayAt() > 0)
    assert.ok(lastReplayMs() >= 0)
  })
})
