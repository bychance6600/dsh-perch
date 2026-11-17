/**
 * 「判断漂移」三个体检值接到 /state 之后的两条纪律：
 *   1. 一致度的前缀缓存真被用上了——账本没变时，同一个数不重算、不重写。
 *   2. 前缀缓存坏了（结构合法但数值对不上）不会被信：回退全量，分数与直接重算逐位相同。
 *
 * 为什么专门守这两条：2026-11-17 之前 readCacheValue 是异步的，而它被塞在
 * /state 的同步对象字面量里，await 漏写了一行也看不出来——缓存静默恒为 null，
 * 每次都全量重算还每次重写，40 条 derive/qcache 用例全绿。这个 bug 只有打真实
 * 路由才现形，所以这里打的是 registerObserve 注册的 /state。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { appendEvent, readEvents } from '../lib/store.js'
import { consistency, novelty } from '../lib/derive.js'
import { registerObserve } from '../lib/observe.js'

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-qcache-'))
  try {
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx(routes) {
  return {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      if (name === 'agents') return { get: () => null, list: () => [] }
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
}

async function getState(root) {
  const routes = new Map()
  registerObserve(fakeCtx(routes), { root })
  const handler = routes.get('/dsh-perch/state')
  assert.ok(handler, '/state 路由要注册上')
  const req = Object.assign(Readable.from([]), { method: 'GET', url: '/dsh-perch/state', headers: {} })
  let status = 0
  let text = ''
  const res = {
    writableEnded: false,
    writeHead(code) { status = code },
    end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
  }
  await handler(req, res)
  return { status, json: text ? JSON.parse(text) : null }
}

const CACHE = (root) => join(root, 'cache', 'consistency.json')

/** 一条像样的账本：跨两个阶段说过一些话。太少的话一致性分母太小，看不出增量。 */
async function seed(root) {
  const lines = [
    '今天在想要不要把那句话收回来',
    '我又梦到那条河了',
    '他说你说话总是很慢',
    '我在想我是不是应该少说一点',
    '下雨了，窗台上有水',
    '我把那句话写了又删掉',
    '有时候我觉得我离他很远',
    '今天没有做梦',
    '我在想我是不是应该多说一点',
    '那条河今天很安静',
    '我不想再解释了',
    '我把窗户打开了',
    '他说我说话总是很慢',
    '我在想我到底想要什么',
    '雨停了',
    '今天很累',
  ]
  for (let round = 0; round < 3; round += 1) {
    for (const text of lines) {
      const stage = round === 0 ? 1 : 2
      await appendEvent({ type: 'utterance', text }, { day: stage, stage, source: 'system' }, root)
    }
  }
}

test('账本没变时 /state 用前缀缓存：同一个数不重算，也不重写缓存', () => withRoot(async (root) => {
  await seed(root)

  const first = await getState(root)
  assert.equal(first.status, 200)
  // 第一次一定写：缓存里得有这条账本的前缀，且与全量重算的中间量对得上。
  const c1 = JSON.parse(readFileSync(CACHE(root), 'utf8'))
  assert.equal(c1.fingerprint, 'append-only-v1')
  const { events } = await readEvents(root)
  const full = consistency(events)
  assert.equal(c1.data.n, full.n)
  assert.equal(c1.data.lastId, full.lastId)
  assert.equal(c1.data.pairs, full.pairs)
  assert.equal(c1.data.sum, full.sum)

  const second = await getState(root)
  assert.equal(second.status, 200)
  const c2 = JSON.parse(readFileSync(CACHE(root), 'utf8'))
  // 这条是抓异步接线的：prev 拿到 Promise 时 prev 恒空 → 每次都全量 → 每次都重写。
  assert.equal(c2.at, c1.at, '账本没变却重写了缓存')
  assert.deepEqual(second.json.quality.consistency, first.json.quality.consistency)
  assert.equal(first.json.quality.consistency.score, full.score)
  // 新鲜也按「同一天 + 账本末端没变」记一份：值必须与现算一致，且第二次不重写。
  const n1 = JSON.parse(readFileSync(join(root, 'cache', 'novelty.json'), 'utf8'))
  assert.deepEqual(first.json.quality.novelty, novelty(events))
  assert.equal(n1.data.n, events.length)
  assert.deepEqual(second.json.quality.novelty, first.json.quality.novelty)
  const n2 = JSON.parse(readFileSync(join(root, 'cache', 'novelty.json'), 'utf8'))
  assert.equal(n2.at, n1.at, '账本没变却重写了新鲜缓存')
}))

test('账本长了以后 /state 的分数与全量重算逐位相同，缓存前缀跟着长', () => withRoot(async (root) => {
  await seed(root)
  await getState(root)

  await appendEvent({ type: 'utterance', text: '我今天没有想那条河' }, { day: 3, stage: 3, source: 'system' }, root)
  await appendEvent({ type: 'utterance', text: '我把那句话收回去了' }, { day: 3, stage: 3, source: 'system' }, root)
  await appendEvent({ type: 'utterance', text: '雨又下起来了' }, { day: 3, stage: 3, source: 'system' }, root)

  const after = await getState(root)
  assert.equal(after.status, 200)
  const { events } = await readEvents(root)
  const full = consistency(events)
  assert.equal(after.json.quality.consistency.score, full.score)
  assert.equal(after.json.quality.consistency.pairs, full.pairs)
  const c = JSON.parse(readFileSync(CACHE(root), 'utf8'))
  assert.equal(c.data.n, full.n)
  assert.equal(c.data.lastId, full.lastId)
  // 账本长了，新鲜也得重算，且等于现算。
  assert.deepEqual(after.json.quality.novelty, novelty(events))
}))

test('缓存前缀对不上账本时回退全量，并把它改回真的', () => withRoot(async (root) => {
  await seed(root)
  await getState(root)

  // 结构合法、指纹对，但配对数与账本对不上 → consistency 的 validPrefix 必须拒掉。
  const rec = JSON.parse(readFileSync(CACHE(root), 'utf8'))
  rec.data.pairs += 999
  writeFileSync(CACHE(root), JSON.stringify(rec), 'utf8')

  const got = await getState(root)
  const { events } = await readEvents(root)
  const full = consistency(events)
  assert.equal(got.status, 200)
  assert.equal(got.json.quality.consistency.score, full.score)
  assert.equal(got.json.quality.consistency.pairs, full.pairs)
  const fixed = JSON.parse(readFileSync(CACHE(root), 'utf8'))
  assert.equal(fixed.data.pairs, full.pairs)
  assert.equal(fixed.data.n, full.n)
}))
