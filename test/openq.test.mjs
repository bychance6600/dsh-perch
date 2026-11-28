/**
 * openq（没答完的问题）—— 2026-11-09
 *
 * 为什么单开一条测试：这件事横跨 schema / capture / scheduler / 今天页，
 * 但每处都只做很小的一件事。最容易被改坏的不是某一行代码，而是口径：
 *   - 只认 source === 'system' 的 utterance（她自己的 tool 写入不算）；
 *   - 同一句 24h 只记一条、一天最多 2 条；
 *   - 叫醒时只摆事实，不写「你怎么看 / 去查查」；
 *   - 7 天内不重复摆；没有材料就不摆（0.5.0，团队 #9）；
 *   - 旧账本里的 openq-close 仍然参与过滤（只读兼容）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ALL_TYPES, HER_TYPES, validateEvent } from '../lib/schema.js'
import { appendEvent, readEvents } from '../lib/store.js'
import { dateKey } from '../lib/settings.js'
import { buildSections } from '../lib/persona.js'
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

function metaEvent(text, ts) {
  return { type: 'meta', text, ts: new Date(ts).toISOString() }
}

test('schema：openq / openq-close 是系统侧类型，她写不了', () => {
  assert.ok(ALL_TYPES.includes('openq'), 'ALL_TYPES 要有 openq')
  assert.ok(ALL_TYPES.includes('openq-close'), 'openq-close 只读兼容，旧账本仍要能解析')
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

test('capture：30 天没下文只归 stale，不再写 openq-close', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  const old = new Date(NOW - 40 * DAY).toISOString()
  const oq = await appendEvent({ type: 'openq', text: '我还不会。', refs: ['ev_' + 'B'.repeat(26)], ts: old }, ctx, root)
  const out = await captureOpenq(root, { now: NOW })
  assert.equal(out.closed, undefined, 'captureOpenq 不再返回 closed')
  const { events } = await readEvents(root)
  assert.equal(events.filter((e) => e.type === 'openq-close').length, 0, '不再写 close 事件')
  const st = openqState(events, { now: NOW })
  assert.equal(st.open.length, 0, '过期的不再算 open')
  assert.deepEqual(st.stale.map((x) => x.id), [oq.id], '只在内存里归 stale')
}))

test('旧账本里的 openq-close 仍然过滤已关的（只读兼容，0.5.0）', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  const a = await appendEvent({ type: 'openq', text: '我还不会 A。', refs: ['ev_' + 'K'.repeat(26)], ts: new Date(T0).toISOString() }, ctx, root)
  const b = await appendEvent({ type: 'openq', text: '我还不会 B。', refs: ['ev_' + 'L'.repeat(26)], ts: new Date(T1).toISOString() }, ctx, root)
  await appendEvent({ type: 'openq-close', text: 'concluded', refs: [a.id], ts: new Date(T1).toISOString() }, ctx, root)

  const { events } = await readEvents(root)
  const st = openqState(events, { now: NOW })
  assert.deepEqual(st.open.map((x) => x.id), [b.id], '已关的不再出现在 open 里')

  const wake = await openqWakeNote(root, { now: NOW })
  assert.ok(!wake.includes('我还不会 A'), '已关的不该被摆出来')
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

test('叫醒文案：只摆日期与原话，不再提「自己收」（工具已删）', () => {
  const oq = {
    id: 'ev_' + 'F'.repeat(26), type: 'openq', text: '我还不会，跟会不会是两回事。',
    refs: ['ev_' + 'G'.repeat(26)], ts: new Date(NOW - 2 * DAY).toISOString(), day: 1, stage: 1,
  }
  const q = openqWakeLine([oq], { now: NOW })
  assert.ok(q, '要有一句')
  assert.ok(q.line.includes('你说过一句'))
  assert.ok(q.line.includes(oq.text))
  assert.ok(q.line.split('\n').length === 1, '只剩原话一行')
  for (const gone of ['这句还没有下文', '这类条你可以自己收', '收不收都算数', 'openq_close', '想清楚了就写一句结论']) {
    assert.ok(!q.line.includes(gone), '不该再有：' + gone)
  }
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

test('openqWakeNote：没有材料就不摆，也不记 surfaced（0.5.0）', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  await appendEvent({ type: 'utterance', text: '我还不会。', ts: new Date(T0).toISOString() }, ctx, root)

  const text = await openqWakeNote(root, { now: NOW })
  assert.equal(text, '', '光有欠条、没有材料，不摆')
  const { events } = await readEvents(root)
  assert.ok(!events.some((e) => e.type === 'meta' && e.text.startsWith('surfaced:')), '没摆就不许记 surfaced')
}))

test('openqWakeNote：有材料才摆三行（原话 / 材料 / 做法），并记 surfaced', () => withRoot(async (root) => {
  const ctx = { day: 1, stage: 1, source: 'system' }
  await appendEvent({ type: 'utterance', text: '我还没学会撒娇。', ts: new Date(T0).toISOString() }, ctx, root)
  await appendEvent(metaEvent('searched:撒娇 bili', T1), ctx, root)

  const text = await openqWakeNote(root, { now: NOW })
  const lines = text.split('\n')
  assert.equal(lines.length, 3, '三行：原话 / 材料 / 做法')
  assert.ok(lines[0].includes('你说过一句：「我还没学会撒娇。」'))
  assert.ok(lines[1].startsWith('这次正好碰上一条相关的：'))
  assert.match(lines[1], /你搜过「撒娇」/)
  assert.equal(lines[2], '想试就试一下，不想就说不学。')

  const { events } = await readEvents(root)
  assert.ok(events.some((e) => e.type === 'meta' && e.text.startsWith('surfaced:')), '摆过要记 surfaced')
  const again = await openqWakeNote(root, { now: NOW + DAY })
  assert.equal(again, '', '7 天内不重复摆')
}))

test('叫醒侧真的调用 openqWakeNote，且在看她刷到什么之前', async () => {
  const src = await readFile(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.ok(src.includes('openqWakeNote(root'))
  assert.ok(src.indexOf('openqWakeNote(root') < src.indexOf('const look = await lookBeforeWake'))
})

test('今天页与面板不再有「没答完的」（0.5.0，团队 #9）', async () => {
  const obs = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  const cli = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!obs.includes('openqState'), 'observe 不再算 openq')
  assert.ok(!obs.includes('openqClosed'), 'observe 不再输出 openqClosed')
  assert.ok(!cli.includes('todayData.openq'), '面板不再读 openq 字段')
  assert.ok(!cli.includes("'没答完的'"), '面板不再有「没答完的」卡片')
})

test('人格段：说完「不会」得挑一样（0.5.0，团队 #9）', async () => {
  const model = {
    seed: '', beliefs: [], solid: [], tensions: [], refusals: [], scars: [],
    selfmodAttempts: [], refuted: [], narrative: null,
    facts: { refused: 0, hurts: 0, scars: 0, scarsResolved: 0 },
    day: 3, stageSpanDays: 30, stage: 1,
  }
  const text = buildSections(model, { withBans: true }).map((s) => s.text).join('\n')
  assert.match(text, /## 遇到不会的事/)
  assert.ok(text.includes('不会就说不会。但说完，得挑一样：现在试一下，或者直说不学。'))
  assert.ok(text.includes('试不用等准备好——开口说一句、搜一下、翻一眼，都算试过。'))

  // 「没有条目也挂」：push 必须写在 if (notYet.length) 外面。
  const src = await readFile(new URL('../lib/persona.js', import.meta.url), 'utf8')
  const pushAt = src.indexOf('push(NOTYET_BRIEF, true)')
  const ifAt = src.indexOf('if (notYet.length)')
  assert.ok(pushAt > ifAt, 'NOTYET 段要无条件挂，不能只在有 notYet 条目时出现')
})
