/**
 * prefetch.test.mjs —— 0.5.0 M1 唤醒预取（issue #20）的守门测试
 * 守四件事：只在四种「要用到过去」的轮次预取、纸条优先、≤3 条且 ≤300 tokens、缓存按 mtime+size 失效。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { prefetchFor, prefetchTriggers, estimateTokens, PREFETCH_MAX, PREFETCH_TOKENS, PREFETCH_CHARS } from '../lib/prefetch.js'
import { readEventsCached } from '../lib/recall.js'
import { appendEvent } from '../lib/store.js'

const NOW = Date.parse('2026-11-27T12:00:00+08:00')
async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-prefetch-'))
}

async function seed(root, type, text) {
  return appendEvent({ type, text }, { day: 1, stage: 1, source: 'tool' }, root)
}

test('prefetch：四种触发各认各的，无关的一轮不触发', () => {
  assert.deepEqual(prefetchTriggers('你还记得那次在群里叫我姐姐吗'), ['past'])
  assert.deepEqual(prefetchTriggers('小满昨天说的那件事'), ['entity'])
  assert.deepEqual(prefetchTriggers('你不是认姐姐了吗，还叫过'), ['correction'])
  assert.deepEqual(prefetchTriggers('那你愿意叫姐姐吗'), ['growth'])
  for (const text of ['今天天气不错', '在吗', '']) assert.deepEqual(prefetchTriggers(text), [])
})

test('prefetch：跟过去无关的一轮不查账本', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '今天天气不错，我出去走了走。')
  assert.equal(await prefetchFor(root, '今天天气不错', { now: NOW, names: [] }), null)
  assert.equal(await prefetchFor(root, '在吗', { now: NOW, names: [] }), null)
  assert.equal(await prefetchFor(root, '', { now: NOW, names: [] }), null)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：纸条有相关项就不翻账本', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '他上次说想换工作，我记着呢。')
  await fs.writeFile(path.join(root, 'notes.json'), JSON.stringify({ notes: [{ id: 'n_ab12', text: '明天问问他工作怎么样', at: NOW }] }), 'utf8')
  const hit = await prefetchFor(root, '你工作怎么样了，上次说的那个还记得吗', { now: NOW, names: [] })
  assert.ok(hit)
  assert.equal(hit.source, 'notes')
  assert.match(hit.text, /纸上记着：明天问问他工作怎么样（n_ab12）/)
  assert.doesNotMatch(hit.text, /他上次说想换工作/)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：账本最多 3 条、每条带 id、同 query 稳定，且不超字数和 token', async () => {
  const root = await tmpRoot()
  for (let i = 1; i <= 5; i += 1) await seed(root, 'utterance', `我上次在群里叫她姐姐，第 ${i} 次。`)
  const heard = '你还记得上次在群里叫我姐姐吗'
  const a = await prefetchFor(root, heard, { now: NOW, names: [] })
  assert.ok(a)
  assert.equal(a.source, 'ledger')
  assert.ok(a.count <= PREFETCH_MAX)
  assert.equal(a.items.length, a.count)
  for (const item of a.items) {
    assert.match(item.id, /^ev_/)
    assert.ok(item.line.includes(item.id))
  }
  assert.ok(a.text.length <= PREFETCH_CHARS)
  assert.ok(a.tokens <= PREFETCH_TOKENS)
  assert.equal((a.text.match(/（可能相关）/g) ?? []).length, 1, '最多标一条「可能相关」')
  assert.equal((await prefetchFor(root, heard, { now: NOW, names: [] })).text, a.text, '固定 now 不许抖')
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：超预算就少带几条，绝不超字数', async () => {
  const root = await tmpRoot()
  for (let i = 1; i <= 5; i += 1) await seed(root, 'utterance', `${'上次那件事我记了很久。'.repeat(10)}（第 ${i} 条）`)
  const hit = await prefetchFor(root, '你还记得上次那件事吗', { now: NOW, names: [], maxTokens: 60 })
  if (hit) {
    assert.ok(hit.tokens <= 60)
    assert.ok(hit.text.length <= PREFETCH_CHARS)
  }
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：成长判断优先她自己的判断与承诺', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '我愿意叫姐姐。')
  await seed(root, 'refusal', '我不想叫姐姐。')
  const hit = await prefetchFor(root, '那你愿意叫姐姐吗', { now: NOW, names: [] })
  assert.ok(hit)
  assert.match(hit.text.split('\n')[1], /她(说过|拒绝过|改口)/)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：她认识的人名也算「话里有专有名词」', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '小满说那件事先放着。')
  assert.equal(await prefetchFor(root, '小满说的那件事', { now: NOW, names: [] }), null)
  assert.ok(await prefetchFor(root, '小满说的那件事', { now: NOW, names: ['小满'] }))
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：账本缓存按 mtime+size 失效', async () => {
  const root = await tmpRoot()
  const a = await readEventsCached(root)
  assert.equal(a.cached, false)
  assert.equal(a.events.length, 0)
  await seed(root, 'utterance', '一句话。')
  const b = await readEventsCached(root)
  assert.equal(b.cached, false, '账本变了要重读')
  assert.equal(b.events.length, 1)
  const c = await readEventsCached(root)
  assert.equal(c.cached, true, '没变要命中缓存')
  await seed(root, 'utterance', '又一句。')
  const d = await readEventsCached(root)
  assert.equal(d.cached, false)
  assert.equal(d.events.length, 2)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：token 估算把中文与英文分开算', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('姐姐'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('姐姐abcd'), 3)
})
