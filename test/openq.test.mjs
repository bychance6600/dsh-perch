/**
 * openq（没答完的问题）—— 2026-11-09
 *
 * 为什么单开一条测试：这件事横跨 schema / capture / scheduler / 今天页，
 * 但每处都只做很小的一件事。最容易被改坏的不是某一行代码，而是口径：
 *   - 只认 source === 'system' 的 utterance（她自己的 tool 写入不算）；
 *   - 同一句 24h 只记一条、一天最多 2 条；
 *   - 叫醒时只摆事实，不写「你怎么看 / 去查查」；
 *   - 7 天内不重复摆，30 天没下文标 stale。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { ALL_TYPES, HER_TYPES, validateEvent } from '../lib/schema.js'
import { appendEvent, readEvents } from '../lib/store.js'
import { dateKey } from '../lib/settings.js'
import {
  OPENQ_MAX_PER_DAY,
  OPENQ_RESURFACE_DAYS,
  openqPattern,
  openqState,
  openqWakeLine,
  openqMaterialLine,
  captureOpenq,
  openqWakeNote,
} from '../lib/capture.js'
import { registerObserve } from '../lib/observe.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-09T12:00:00.000Z')
const T0 = Date.parse('2026-11-09T04:00:00.000Z')
const T1 = Date.parse('2026-11-09T05:00:00.000Z')
const T2 = Date.parse('2026-11-09T06:00:00.000Z')

function cnDate(ts) {
  const dk = dateKey(new Date(ts))
  return Number(dk.slice(5, 7)) + ' 月 ' + Number(dk.slice(8, 10)) + ' 日'
}

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-openq-'))
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

async function getToday(root) {
  const routes = new Map()
  registerObserve(fakeCtx(routes), { root })
  const handler = routes.get('/dsh-perch/today')
  assert.ok(handler, '/today 路由要注册上')
  const req = Object.assign(Readable.from([]), { method: 'GET', headers: {} })
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

test('schema：openq / openq-close 是系统侧类型，她写不了', () => {
  assert.ok(ALL_TYPES.includes('openq'), 'ALL_TYPES 要有 openq')
  assert.ok(ALL_TYPES.includes('openq-close'), 'ALL_TYPES 要有 openq-close')
  assert.ok(!HER_TYPES.includes('openq'), 'openq 不能进 HER_TYPES')
  assert.ok(!HER_TYPES.includes('openq-close'), 'openq-close 不能进 HER_TYPES')

  const ok = validateEvent({ type: 'openq', text: '我还不会', refs: ['ev_' + 'A'.repeat(26)] }, { source: 'system' })
  assert.equal(ok.type, 'openq')
  assert.throws(
    () => validateEvent({ type: 'openq', text: '我还不会' }, { source: 'tool' }),
    /你不可以写 openq 类事件/,
  )
})

test('recognizer：只认那三族，且要落在句末/标点前 20 字内', () => {
  for (const s of [
    '我还不会。',
    '我还没学会——不是不肯，是不会。',
    '我还到不了。',
    '等它自己长出来吧。',
    '我不知道怎么开口。',
    '我还不会，跟会不会是两回事。',
    '我还不会，' + '因为'.repeat(12) + '。',
  ]) {
    assert.ok(openqPattern(s), '应该命中：' + s)
  }

  assert.equal(openqPattern('我还在，不会因为没聊透就变了。'), '', '逗号隔开的半句不算')
  assert.equal(openqPattern('朋友说「我还不会」，我记下了'), '', '引用别人的话不算')
  assert.equal(openqPattern('今天天气很好。'), '')
  assert.equal(openqPattern('我还不会' + '因为'.repeat(12) + '。'), '', '离句末太远不算')
})

test('capture：只扫 source === system，按 utterance 去重', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  const u1 = await appendEvent({ type: 'utterance', text: '我还不会。', ts: new Date(T0).toISOString() }, ctx, root)
  const tool = await appendEvent(
    { type: 'utterance', text: '我还不会。', ts: new Date(T1).toISOString() },
    { ...ctx, source: 'tool' },
    root,
  )
  const u2 = await appendEvent({ type: 'utterance', text: '等它自己长出来吧。', ts: new Date(T1).toISOString() }, ctx, root)

  const first = await captureOpenq(root, { now: NOW })
  assert.equal(first.added.length, 2, '两条 system 原话各记一条')
  assert.deepEqual(first.added.map((e) => e.refs[0]).sort(), [u1.id, u2.id].sort())
  assert.ok(first.added.every((e) => e.source === 'system'))
  assert.ok(!first.added.some((e) => e.refs.includes(tool.id)), 'tool 写入不参与识别')

  const second = await captureOpenq(root, { now: NOW })
  assert.equal(second.added.length, 0, '同一条 utterance 不重复记')
}))

test('capture：一天最多 2 条', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  for (const [text, ts] of [
    ['我还不会。', T0],
    ['我还没学会。', T1],
    ['我不知道怎么开口。', T2],
  ]) {
    await appendEvent({ type: 'utterance', text, ts: new Date(ts).toISOString() }, ctx, root)
  }
  const { added } = await captureOpenq(root, { now: NOW })
  assert.equal(added.length, OPENQ_MAX_PER_DAY)
}))

test('capture：30 天没下文写 openq-close(stale)，不再进 open', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  const old = new Date(NOW - 40 * DAY).toISOString()
  const oq = await appendEvent({ type: 'openq', text: '我还不会。', refs: ['ev_' + 'B'.repeat(26)], ts: old }, ctx, root)
  const { closed } = await captureOpenq(root, { now: NOW })
  assert.equal(closed.length, 1)
  assert.equal(closed[0].type, 'openq-close')
  assert.equal(closed[0].text, 'stale')
  assert.deepEqual(closed[0].refs, [oq.id])
  const { events } = await readEvents(root)
  assert.equal(openqState(events, { now: NOW }).open.length, 0)
}))

test('openqState：7 天内摆过的不再 due，超过 7 天重新 due', () => {
  const id = 'ev_' + 'C'.repeat(26)
  const oq = {
    id, type: 'openq', text: '我还不会。', refs: ['ev_' + 'D'.repeat(26)],
    ts: new Date(NOW - 3 * DAY).toISOString(), day: 1, stage: 1,
  }
  const meta = (ago) => ({
    id: 'ev_' + 'E'.repeat(26), type: 'meta',
    text: 'surfaced:' + id + ' ' + new Date(NOW - ago * DAY).toISOString(),
  })
  assert.equal(openqState([oq, meta(2)], { now: NOW }).due.length, 0)
  assert.equal(openqState([oq, meta(OPENQ_RESURFACE_DAYS + 1)], { now: NOW }).due.length, 1)
})

test('叫醒文案：只摆事实，没有祈使句', () => {
  const oq = {
    id: 'ev_' + 'F'.repeat(26), type: 'openq', text: '我还不会，跟会不会是两回事。',
    refs: ['ev_' + 'G'.repeat(26)], ts: new Date(NOW - 2 * DAY).toISOString(), day: 1, stage: 1,
  }
  const q = openqWakeLine([oq], { now: NOW })
  assert.ok(q, '要有一句')
  assert.ok(q.line.includes('你说过一句'))
  assert.ok(q.line.includes(oq.text))
  assert.ok(q.line.includes('这句还没有下文'))
  const wrapper = q.line.replace('「' + oq.text + '」', '')
  for (const bad of ['去查', '查查', '想想', '分析', '复盘', '看看', '试试', '应该', '要不要', '请', '记得', '别忘了', '你怎么看']) {
    assert.ok(!wrapper.includes(bad), '提示里不能有祈使句：' + bad)
  }
})

test('材料：只从 7 天内的 searched / looked-from-search 取一条，按最近', () => {
  const q = { text: '我还没学会撒娇。' }
  const ev = (text, ago) => ({ type: 'meta', text, ts: new Date(NOW - ago * DAY).toISOString() })
  const line = openqMaterialLine([
    ev('searched:撒娇 bili', 9), // 太老，不算
    ev('looked:BV1xx411c7mD from:feed', 0.5), // 没有可对上的词，不拿 BV 号硬凑
    ev('searched:天气 bili', 0.2), // 不相关，哪怕更近
    ev('looked:BV1xx411c7mD from:search:撒娇_语气', 1),
    ev('searched:撒娇 bili', 2),
  ], q, { now: NOW })
  assert.equal(line, '相关的：' + cnDate(NOW - DAY) + '你看过一条关于「撒娇 语气」的。')
})

test('材料：只重合停用词、looked 来自 feed、超过 7 天，都不算', () => {
  const q = { text: '我不知道怎么开口。' }
  const ev = (text, ago) => ({ type: 'meta', text, ts: new Date(NOW - ago * DAY).toISOString() })
  assert.equal(openqMaterialLine([
    ev('searched:怎么 bili', 1),
    ev('looked:BV1xx411c7mD from:feed', 1),
    ev('looked:BV1xx411c7mD from:search:开口', 8),
    ev('searched:开口 bili', 8),
  ], q, { now: NOW }), '')
})

test('openqWakeNote：摆问题时并排一条事实材料，整段没有祈使句', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  await appendEvent({ type: 'utterance', text: '我还没学会撒娇。', ts: new Date(T0).toISOString() }, ctx, root)
  await appendEvent({ type: 'meta', text: 'searched:撒娇 bili', ts: new Date(T1).toISOString() }, ctx, root)

  const text = await openqWakeNote(root, { now: NOW })
  assert.ok(text.includes('这句还没有下文'))
  assert.match(text, /相关的：\d+ 月 \d+ 日你搜过「撒娇」。/)

  // 去掉引号里的原话与材料词，剩下的提示语里不能有派活的话。
  const wrapper = text.replace(/「[^」]*」/g, '')
  for (const bad of ['去查', '查查', '想想', '分析', '复盘', '看看', '试试', '应该', '要不要', '请', '记得', '别忘了', '你怎么看']) {
    assert.ok(!wrapper.includes(bad), '提示里不能有祈使句：' + bad)
  }

  const { events } = await readEvents(root)
  assert.ok(events.some((e) => e.type === 'meta' && e.text.startsWith('surfaced:')), '摆过仍要记 surfaced')
}))

test('openqWakeNote：摆一次就记 surfaced，第二天不再摆', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  await appendEvent({ type: 'utterance', text: '我还不会。', ts: new Date(T0).toISOString() }, ctx, root)
  const first = await openqWakeNote(root, { now: NOW })
  assert.ok(first.includes('这句还没有下文'))
  assert.ok(!first.includes('相关的：'), '没有对得上的材料就不加，别硬凑')
  const { events } = await readEvents(root)
  assert.ok(events.some((e) => e.type === 'meta' && e.text.startsWith('surfaced:')), '要记 surfaced')
  const again = await openqWakeNote(root, { now: NOW + DAY })
  assert.equal(again, '', '7 天内不重复摆')
}))

test('叫醒侧真的调用 openqWakeNote，且在看她刷到什么之前', async () => {
  const src = await readFile(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.ok(src.includes('openqWakeNote(root'))
  assert.ok(src.indexOf('openqWakeNote(root') < src.indexOf('const look = await lookBeforeWake'))
})

test('今天页：多出一条「没答完的」，最多 3 条，关掉的不出现', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  const made = []
  for (let i = 0; i < 4; i++) {
    made.push(await appendEvent(
      { type: 'openq', text: '我还不会 ' + i, refs: ['ev_' + String(i).repeat(26)], ts: new Date(NOW - i * 1000).toISOString() },
      ctx,
      root,
    ))
  }
  await appendEvent({ type: 'openq-close', text: 'concluded', refs: [made[0].id] }, ctx, root)
  const { status, json } = await getToday(root)
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.openq), '要有 openq 字段')
  assert.equal(json.openq.length, 3)
  assert.ok(!json.openq.some((x) => x.text.includes('我还不会 0')), '关掉的不出现')

  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const changes = src.indexOf("'今天变了什么'")
  const section = src.indexOf("'没答完的'")
  const hands = src.indexOf("'手边'")
  assert.ok(changes > -1 && section > changes && hands > section, '「没答完的」要夹在今天变了什么和手边之间')
  assert.ok(src.includes('qs.slice(0, 3)'), '今天页最多 3 条')
}))
