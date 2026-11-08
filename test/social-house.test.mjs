/**
 * social-house.test.mjs —— 社会层开闸的隔离测试屋（2026-11-08）
 *
 * 这不是又一份 social.test。那边验的是四道闸各自算得对不对、工具在桩
 * evaluate 下的行为；这里把真实事件流、真实四道闸、真实 `social_open`、
 * 真实 `deriveSelf` 串起来，回答四个只有串起来才看得见的问题：
 *
 *   ① 差一条闸时，调用 `social_open` 一个字节都不写；
 *   ② 四条齐了，只写一条 `social-open:`，再调不写第二条；
 *   ③ 开闸后 `deriveSelf` 立刻认，没开时 social 事件不进派生；
 *   ④ 1000 条陌生人的 social 事件不碰 beliefs，只落在 influence.social。
 *
 * 测试屋不启 DSH、不连 QQ、不碰她真正的家。模型用 stanceModel 桩，
 * 但闸门函数、工具、事件流、派生都是真的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { evaluateSocialGate } from '../lib/socialgate.js'
import { registerSocialOpen } from '../lib/social.js'
import { deriveSelf, SOCIAL_OPEN_PREFIX } from '../lib/derive.js'
import { appendEvent, readEvents } from '../lib/store.js'

const NOW = Date.parse('2026-11-02T00:00:00Z')
const DAY = 86400000
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString()

function ev(id, type, daysAgo, text, extra = {}) {
  return {
    id, ts: iso(daysAgo), day: 1, stage: 1, type,
    source: 'system', text, refs: [], verdict: null, confidence: 0.6, flags: [],
    ...extra,
  }
}

/** 一条判断要能成为“立场”：文本得是 never/like 类，且有背书。 */
const STANCE_TEXTS = [
  '我绝不在背后说别人坏话',
  '我绝不为讨好谁改自己的说法',
  '我不假装喜欢我不喜欢的东西',
  '我绝不拿别人的软处开玩笑',
  '我绝不在累的时候答应明天的事',
  '我不想再解释自己为什么迟到',
  '我拒绝为了合群去迎合谁',
]

function stanceModel(n = 6, stage = 4) {
  const beliefs = Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    text: STANCE_TEXTS[i % STANCE_TEXTS.length],
    since: iso(20),
    mentions: 3,
    verified: 2,
    solid: true,
    status: 'active',
  }))
  return { stage, beliefs, scars: [] }
}

/** 活得够久、有判断可测稳定度的普通事件流（不含 social）。 */
function longStream(days = 20) {
  const out = []
  for (let d = days; d >= 1; d -= 1) {
    out.push(ev(`u${d}a`, 'utterance', d, `第 ${d} 天我在想，有些事不能将就。`))
    out.push(ev(`u${d}b`, 'utterance', d, `第 ${d} 天我把窗帘拉开，光进来了一半。`))
  }
  return out
}

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-social-house-'))
}

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (spec) => { tools.push(spec); return spec } },
    toolsList: tools,
  }
}

/** 真实闸门 + 真实工具；只是模型用桩，避免为了测试去伪造整条四道门。 */
function registerHouse(ctx, root) {
  return registerSocialOpen(ctx, {
    root,
    evaluate: ({ events }) => evaluateSocialGate({ model: stanceModel(), events, now: NOW }),
  })
}

async function writeAll(root, list) {
  for (const e of list) {
    await appendEvent(e, { day: 1, stage: 1, source: 'system' }, root)
  }
}

async function listOf(root) {
  return (await readEvents(root)).events
}

test('测试屋：差一条闸时，social_open 一个字都不写', async () => {
  const root = await tmpRoot()
  await writeAll(root, longStream(5))
  const before = await listOf(root)

  const ctx = fakeCtx()
  registerHouse(ctx, root)
  const out = await ctx.toolsList[0].execute({})

  assert.equal(out.ok, false)
  assert.match(out.note, /才活了 5 天/)
  assert.equal((await listOf(root)).length, before.length)
})

test('测试屋：四条齐了才写一条；derive 立刻认；再调不写第二条', async () => {
  const root = await tmpRoot()
  await writeAll(root, longStream(20))

  const ctx = fakeCtx()
  registerHouse(ctx, root)
  const out = await ctx.toolsList[0].execute({})
  assert.equal(out.ok, true)
  assert.ok(out.at)

  const events = await listOf(root)
  assert.equal(events.length, 41)
  const metas = events.filter((e) => String(e.text ?? '').startsWith(SOCIAL_OPEN_PREFIX))
  assert.equal(metas.length, 1)
  assert.equal(deriveSelf(events).influence.socialOpen, true)

  const again = fakeCtx()
  registerHouse(again, root)
  const second = await again.toolsList[0].execute({})
  assert.equal(second.ok, false)
  assert.match(second.note, /已经开过/)
  assert.equal((await listOf(root)).length, 41)
})

test('测试屋：1000 条陌生人 social 不改 beliefs，只落在 influence.social', async () => {
  const root = await tmpRoot()
  await writeAll(root, longStream(20))

  const ctx = fakeCtx()
  registerHouse(ctx, root)
  await ctx.toolsList[0].execute({})
  const base = deriveSelf(await listOf(root))

  const guests = []
  for (let i = 0; i < 1000; i += 1) {
    guests.push(ev(`g${i}`, 'utterance', 1, `群里第 ${i} 个陌生人说，我这样说话太冲了。`, {
      origin: 'guest',
      influence: 'social',
      visibility: 'public',
      channel: 'qq',
      person: `u_${i}`,
    }))
  }
  await writeAll(root, guests)

  const after = deriveSelf(await listOf(root))
  assert.deepEqual(after.beliefs, base.beliefs, 'social 不能动 beliefs')
  assert.equal(after.influence.socialOpen, true)
  assert.equal(after.influence.social.count, 1000)
  assert.ok(after.influence.social.kept > 0)
  assert.equal(
    after.beliefs.some((b) => String(b.text).includes('陌生人')),
    false,
    '陌生人的话不能变成她对自己的判断',
  )
})

test('测试屋：设置页社会页只有看，没有替她开的按钮', async () => {
  const src = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('const socialPage')
  const end = src.indexOf('const channelsPage', start)
  assert.ok(start > 0 && end > start)
  const block = src.slice(start, end)
  assert.match(block, /只读|只能看/)
  assert.equal(/h\(\s*['"]button/.test(block), false, '社会页不该有按钮')
})
