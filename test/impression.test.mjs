/**
 * impression.test.mjs —— 每人印象（A4，2026-11-07）
 *
 * 守住清单 A4 的五条：主人 impression 非空、群友（没点她的）不建、旧版可回退、
 * 不进身份文档、只从「跟他自己有关」的句子里抽。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  pickSnippet, mergeParts, composeImpression, shouldRewrite, rememberImpression,
  dayKey, TURNS_PER_IMPRESSION, SAID_MAX,
} from '../lib/impression.js'
import { createPeople, IMPRESSION_MAX } from '../lib/people.js'
import { matchPeople, renderPeople, tokensOf } from '../lib/recall.js'

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-imp-'))
}

const msg = (over = {}) => ({
  channel: 'qq', kind: 'group', conversationId: '111', conversationName: '产品群',
  personId: 'u_7', personName: '阿泽',
  text: '我在做一个播客，下周要录第二期。',
  at: Date.now(),
  ...over,
})

test('pickSnippet 只抽「关于他自己」的那一句', () => {
  assert.equal(pickSnippet('我在做一个播客，下周要录第二期。'), '我在做一个播客，下周要录第二期')
  assert.equal(pickSnippet('你觉得呢？今天天气不错。'), '', '不是关于他的，不抽')
  const q = pickSnippet('我是做后端的，最近在学做饭。')
  assert.ok(q.length <= 28, '引句有上限')
})

test('composeImpression：四段都在，且 ≤150 字', () => {
  const parts = {
    call: '阿泽',
    met: '在 QQ 群「产品群」认识的（11 月 2 日）',
    said: ['我在做一个播客，下周要录第二期', '我是做后端的，最近在学做饭'],
    last: '11 月 7 日他说「今天先不聊了」',
  }
  const text = composeImpression(parts)
  assert.match(text, /叫他阿泽/)
  assert.match(text, /认识的/)
  assert.match(text, /他说过：/)
  assert.match(text, /最近一次：/)
  assert.ok(text.length <= IMPRESSION_MAX, `印象超了：${text.length}`)
})

test('composeImpression：要紧的太多时先丢引句，不丢称呼和怎么认识', () => {
  const said = Array.from({ length: 6 }, (_, i) => `我要说一件特别重要的事第${i}件`)
  const text = composeImpression({ call: '阿泽', met: '在 QQ 群里认识的（11 月 2 日）', said, last: '11 月 7 日他说过话' })
  assert.ok(text.length <= IMPRESSION_MAX)
  assert.match(text, /叫他阿泽/)
})

test('shouldRewrite：第一次就写；之后每 N 句或换一天', () => {
  const now = new Date(2026, 10, 7, 20, 0).getTime()
  assert.equal(shouldRewrite(null), false)
  assert.equal(shouldRewrite({ impression: '', count: 1 }), true)
  const p = { impression: '叫他阿泽。', impressionAt: now, impressionCount: 3, count: 3 }
  assert.equal(shouldRewrite(p, now + 1000), false, '刚写过、也没隔天')
  assert.equal(shouldRewrite({ ...p, count: 3 + TURNS_PER_IMPRESSION }, now + 1000), true, '隔了 N 句')
  const tomorrow = new Date(2026, 10, 8, 9, 0).getTime()
  assert.equal(shouldRewrite(p, tomorrow), true, '换了一天')
  assert.equal(dayKey(tomorrow), '2026-11-08')
})

test('rememberImpression：新的人第一句就留下印象，旧版可回退，计数不乱涨', async () => {
  const root = await tmpRoot()
  try {
    const people = createPeople(root)
    const now = new Date(2026, 10, 2, 21, 0).getTime()
    await people.upsert('u_7', { name: '阿泽', channel: 'qq', now })
    const p1 = await rememberImpression(people, msg({ at: now }), now)
    assert.ok(p1, '第一句就要写')
    assert.equal(p1.count, 1, '写印象不该多算一次见面')
    assert.match(p1.impression, /叫他阿泽/)
    assert.match(p1.impression, /产品群/)
    assert.match(p1.impression, /播客/)
    assert.ok(p1.impression.length <= IMPRESSION_MAX)
    assert.equal(p1.impressionParts.said.length, 1)

    // 还没到下一轮：不重写
    const p2 = await rememberImpression(people, msg({ at: now + 60_000 }), now + 60_000)
    assert.equal(p2, null)

    // 换了一天：重写，旧版进历史
    const nextDay = new Date(2026, 10, 3, 9, 0).getTime()
    await people.upsert('u_7', { channel: 'qq', now: nextDay })
    const p3 = await rememberImpression(people, msg({ text: '我养了一只猫叫豆子。', at: nextDay }), nextDay)
    assert.ok(p3)
    assert.match(p3.impression, /猫/)
    assert.equal(p3.impressionHistory.length, 1, '旧版留一份')
    assert.match(p3.impressionHistory[0].text, /播客/)

    // 回退
    const back = await people.restoreImpression('u_7', 1)
    assert.match(back.impression, /播客/)
    assert.match(back.impressionHistory.at(-1).text, /猫/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('rememberImpression：没这个人就不写（只给说过话的人建）', async () => {
  const root = await tmpRoot()
  try {
    const people = createPeople(root)
    assert.equal(await rememberImpression(people, msg(), Date.now()), null)
    assert.equal(await people.get('u_7'), null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('said 最多三条，重复的不再记', async () => {
  const root = await tmpRoot()
  try {
    const people = createPeople(root)
    let now = new Date(2026, 10, 2, 21, 0).getTime()
    await people.upsert('u_7', { name: '阿泽', now })
    const lines = ['我是做后端的。', '我在学做饭。', '我养了一只猫。', '我下周要去出差。']
    let p = null
    for (let i = 0; i < lines.length; i++) {
      now += 1000
      await people.upsert('u_7', { now })
      p = await rememberImpression(people, msg({ text: lines[i], at: now }), now, { turns: 1 })
    }
    assert.ok(p)
    assert.ok(p.impressionParts.said.length <= SAID_MAX, `said 超了：${p.impressionParts.said.length}`)
    const merged = mergeParts(p.impressionParts, msg({ text: lines[0] }), now)
    assert.equal(merged.said.filter((x) => x.includes('后端')).length, 1, '同一句不记两遍')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('her_recall 的人那一段：按名字或内容命中，且不给没说过话的人', () => {
  const list = [
    { name: '阿泽', impression: '叫他阿泽。在 QQ 群「产品群」认识的。他说过：我在做一个播客。' },
    { name: 'Lily', impression: '叫他 Lily。在 QQ 群里认识的。' },
  ]
  assert.equal(matchPeople(list, '阿泽').length, 1)
  assert.equal(matchPeople(list, '播客')[0].name, '阿泽', '按印象正文也能翻到')
  assert.equal(matchPeople(list, '路人').length, 0)
  assert.equal(matchPeople(list, '').length, 0, '空查询不翻人')
  const text = renderPeople(matchPeople(list, '阿泽'))
  assert.match(text, /你记得的人/)
  assert.match(text, /阿泽：叫他阿泽/)
  assert.ok(tokensOf('阿泽').includes('阿泽'))
})
