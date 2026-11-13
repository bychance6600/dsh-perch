import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { appendEvent } from '../lib/store.js'

/**
 * 记忆图谱三层接口（2026-11-13）。
 *
 * 这个文件只钉接口口径：判断 / 她说过的话 / 她听见的话、kinds 过滤、
 * meta.counts、以及「只问 belief 的老信封一个字段都不多」。
 * 派生的正确性仍在 derive.test / boot.test 里，别在这里重测。
 */

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-memory-api-'))
  const oldHomes = process.env.DSH_ROOST_HOMES
  process.env.DSH_ROOST_HOMES = join(root, 'homes.json')
  try {
    return await fn(root)
  } finally {
    if (oldHomes === undefined) delete process.env.DSH_ROOST_HOMES
    else process.env.DSH_ROOST_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx() {
  const routes = []
  const ctx = {
    tools: { register: () => () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => null },
    sessionController: { async create() {}, async prompt() {} },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
  }
  return { ctx, routes }
}

function fakeRes() {
  const res = {
    code: 200,
    body: '',
    headers: {},
    writableEnded: false,
    writeHead(code, headers) { res.code = code; Object.assign(res.headers, headers || {}); return res },
    end(chunk) { if (chunk) res.body += String(chunk); res.writableEnded = true; return res },
    get json() { try { return JSON.parse(res.body) } catch { return null } },
  }
  return res
}

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function getMemory(routes, query = '') {
  const route = await waitFor(() => routes.find((r) => r.path === '/dsh-perch/api/memory'))
  assert.ok(route, '记忆接口要注册')
  const res = fakeRes()
  await route.handler({ url: '/dsh-perch/api/memory' + query, method: 'GET' }, res)
  assert.equal(res.code, 200, res.body)
  assert.ok(res.json, '接口要返回 JSON')
  return res.json
}

/** 一本最小的账：一句成了判断、一句是让步（留在原话层）、一句听见的、一句 influence:none。 */
async function seedLedger(root) {
  const belief = await appendEvent({ type: 'utterance', source: 'tool', text: '我喜欢安静。' }, { source: 'tool' }, root)
  const raw = await appendEvent({ type: 'utterance', source: 'tool', text: '你说得对。' }, { source: 'tool' }, root)
  const heard = await appendEvent({
    type: 'heard', source: 'system', text: '群里有人说今天下雨。', channel: 'qq',
    origin: 'guest', influence: 'social',
  }, { source: 'system' }, root)
  await appendEvent({
    type: 'heard', source: 'system', text: '这条不该出现在图谱里。', channel: 'qq',
    origin: 'guest', influence: 'none',
  }, { source: 'system' }, root)
  return { belief, raw, heard }
}

test('记忆 API：默认返回三层，meta.counts 按账本层数', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    try {
      const ev = await seedLedger(root)
      const json = await getMemory(routes)

      assert.deepEqual(json.meta?.counts, { belief: 1, utterance: 2, heard: 1 })
      assert.equal(json.nodes.filter((n) => n.kind === 'belief').length, 1)
      assert.ok(json.nodes.some((n) => n.id === ev.raw.id && n.kind === 'utterance'),
        '没长成判断的原话要留在 utterance 层')
      assert.ok(json.nodes.some((n) => n.id === ev.heard.id && n.kind === 'heard'))

      const heard = json.nodes.find((n) => n.id === ev.heard.id)
      assert.equal(heard.text, '群里有人说今天下雨。')
      assert.equal(heard.channel, 'qq')
      assert.equal(heard.at, ev.heard.ts)
      assert.ok(!json.nodes.some((n) => n.text === '这条不该出现在图谱里。'),
        'influence:none 的事件不进食图谱')
    } finally {
      h.dispose?.()
    }
  })
})

test('记忆 API：?kinds=belief 保持老信封，不多 meta、不多原话层', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    try {
      await seedLedger(root)
      const json = await getMemory(routes, '?kinds=belief')

      assert.deepEqual(Object.keys(json).sort(), [
        'edges', 'events', 'generatedAt', 'nodes', 'ok', 'stage', 'stageName', 'stats',
      ], '老客户端只问 belief 时，返回的字段与加三层之前完全一样')
      assert.equal(json.meta, undefined, '只问 belief 时不许加 meta')
      assert.ok(json.nodes.length > 0)
      assert.ok(json.nodes.every((n) => n.kind === 'belief' || n.kind === 'scar'),
        'belief 层只交判断与疤')
      assert.ok(!json.nodes.some((n) => n.kind === 'utterance' || n.kind === 'heard'))
    } finally {
      h.dispose?.()
    }
  })
})

test('记忆 API：?kinds=utterance 只交原话层，计数仍是整层总数', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    try {
      const ev = await seedLedger(root)
      const json = await getMemory(routes, '?kinds=utterance')

      assert.deepEqual(json.meta?.counts, { belief: 1, utterance: 2, heard: 1 },
        'meta.counts 报整层有多少条，不因过滤变成 0')
      assert.equal(json.nodes.length, 1, '已经长成判断的那句不重复画点')
      assert.equal(json.nodes[0].id, ev.raw.id)
      assert.equal(json.nodes[0].kind, 'utterance')
      assert.deepEqual(json.edges, [])
    } finally {
      h.dispose?.()
    }
  })
})

test('记忆 API：?kinds=heard 只交听见层，text 截 140 字并带上 channel', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    try {
      const long = '雨'.repeat(200)
      const heard = await appendEvent({
        type: 'heard', source: 'system', text: long, channel: 'bili',
        origin: 'guest', influence: 'social',
      }, { source: 'system' }, root)
      const json = await getMemory(routes, '?kinds=heard')

      assert.equal(json.nodes.length, 1)
      assert.equal(json.nodes[0].kind, 'heard')
      assert.equal(json.nodes[0].id, heard.id)
      assert.equal(json.nodes[0].text.length, 140)
      assert.equal(json.nodes[0].channel, 'bili')
      assert.equal(json.nodes[0].at, heard.ts)
      assert.deepEqual(json.meta?.counts, { belief: 0, utterance: 0, heard: 1 })
    } finally {
      h.dispose?.()
    }
  })
})
