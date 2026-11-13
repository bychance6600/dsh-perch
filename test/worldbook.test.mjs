/**
 * worldbook.test.mjs —— 「她知道的事」这一层
 *
 * 要守住的是一句话：**事实可以给，人格不能给。**
 * 所以这里测的几乎全是边界：不建文件、不进事件流、不超上限、认不出的条目丢掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createWorldbook,
  importLorebook,
  isSettingOwned,
  matchEntries,
  knowledgeBlock,
  WORLDBOOK_FILE,
  MATCH_MAX,
  MATCH_CHARS,
} from '../lib/worldbook.js'
import { buildPrompt } from '../lib/channels/router.js'
import { renderSelfDoc, writeSelfDoc, KNOWLEDGE_SHOWN } from '../lib/selfdoc.js'
import { deriveSelf } from '../lib/derive.js'
import { updateConfig } from '../lib/settings.js'

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-wb-'))
}

const lorebook = {
  entries: {
    0: { key: ['临江', '临江市'], content: '临江是座沿江的小城，冬天很冷。', disable: false },
    1: { key: ['公司'], content: '她在一家做地图的小公司上班，三楼。' },
    2: { key: [], content: '没有关键词，应该被丢掉。' },
    3: { key: ['猫'], content: '' , disable: false },
  },
}

test('导入：认 SillyTavern 的 entries 对象，也认数组；没关键词/没正文的丢掉并报数', () => {
  const a = importLorebook(lorebook)
  assert.equal(a.ok, true)
  assert.equal(a.entries.length, 2)
  assert.equal(a.added, 2)
  assert.equal(a.skipped, 0)
  assert.equal(a.merged, 0)
  assert.equal(a.dropped, 2)
  assert.deepEqual(a.entries[0].keys, ['临江', '临江市'])

  const b = importLorebook([{ key: ['学校'], content: '她在临江三中读过书。' }])
  assert.equal(b.entries.length, 1)
  assert.equal(b.entries[0].keys[0], '学校')

  const c = importLorebook({ nope: 1 })
  assert.equal(c.ok, false)
  assert.ok(c.why)
})

test('降级成可选事实卡（0.2.2）：一轮最多 2 条、共 600 字，长的截断', () => {
  assert.equal(MATCH_MAX, 2)
  assert.equal(MATCH_CHARS, 600)

  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, keys: ['临江'], text: `第${i}条`, enabled: true, at: i }))
  assert.equal(matchEntries(many, '临江').length, 2)

  // 两条各 400 字：第二条截到 200 字，总数正好卡在 600，不许超。
  const fat = [
    { id: 'a', keys: ['长'], text: '甲'.repeat(400), enabled: true, at: 1 },
    { id: 'b', keys: ['长'], text: '乙'.repeat(400), enabled: true, at: 2 },
  ]
  const hit = matchEntries(fat, '很长的一段话')
  assert.equal(hit.length, 2)
  assert.ok(hit.reduce((n, h) => n + h.text.length, 0) <= MATCH_CHARS)
  assert.ok(hit[1].text.endsWith('…'))
})

test('导入查重：同一份世界书连续导入两次，第二次一条都不新增（0.2.2）', () => {
  const first = importLorebook(lorebook)
  assert.equal(first.added, 2)

  const second = importLorebook(lorebook, first.entries)
  assert.equal(second.ok, true)
  assert.equal(second.added, 0)
  assert.equal(second.skipped, 2)
  assert.equal(second.merged, 0)
  assert.equal(second.entries.length, 0)
})

test('重复导入不新增：写库那层也查重，第二次 added 是 0', async () => {
  const root = await tmpRoot()
  const wb = createWorldbook(root)
  const r1 = await wb.add(importLorebook(lorebook).entries)
  assert.equal(r1.added, 2)
  assert.equal(r1.count, 2)

  const r2 = await wb.add(importLorebook(lorebook).entries)
  assert.equal(r2.added, 0)
  assert.equal(r2.skipped, 2)
  assert.equal(r2.count, 2)

  // 整本替换也一样：内容没变，条目数不涨。
  const r3 = await wb.replace(importLorebook(lorebook).entries)
  assert.equal(r3.added, 2)
  assert.equal(r3.count, 2)

  assert.equal((await wb.stats()).count, 2)
  await fs.rm(root, { recursive: true, force: true })
})

test('导入查重：keys 高度重叠、说法相近的合并成一条（并集 keys、留长正文、旧身份不变）', () => {
  const existing = [
    { id: 'w-old', keys: ['临江', '临江市', '江边', '小城'], text: '临江是座沿江的小城，冬天很冷。', enabled: true, at: 7 },
  ]
  const r = importLorebook(
    [{ key: ['临江', '临江市', '江边', '小城', '冬天'], content: '临江是座沿江的小城，冬天非常冷。' }],
    existing,
  )
  assert.equal(r.added, 0)
  assert.equal(r.skipped, 0)
  assert.equal(r.merged, 1)
  assert.equal(r.entries.length, 1)
  const e = r.entries[0]
  assert.equal(e.id, 'w-old') // 旧条目的身份没有被导入改掉
  assert.equal(e.at, 7)
  assert.deepEqual(e.keys, ['临江', '临江市', '江边', '小城', '冬天'])
  assert.equal(e.text, '临江是座沿江的小城，冬天非常冷。')
})

test('写库时也合并：同一条事实换个说法再加一遍，只升级旧条目、不多出一条', async () => {
  const root = await tmpRoot()
  const wb = createWorldbook(root)
  await wb.add([{ key: ['临江', '临江市', '江边', '小城'], content: '临江是座沿江的小城，冬天很冷。' }])
  const r = await wb.add([{ key: ['临江', '临江市', '江边', '小城', '冬天'], content: '临江是座沿江的小城，冬天非常冷。' }])
  assert.equal(r.added, 0)
  assert.equal(r.merged, 1)
  assert.equal(r.count, 1)
  const list = await wb.list()
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].keys, ['临江', '临江市', '江边', '小城', '冬天'])
  await fs.rm(root, { recursive: true, force: true })
})

test('越界条目照旧由 isSettingOwned 挡掉：导入查重不放宽这条', () => {
  const r = importLorebook({
    entries: [
      { key: ['作息'], content: '她一般晚上八点到十一点之间醒着，一天醒两次。' },
      { key: ['临江'], content: '住在临江路 12 号。' },
    ],
  })
  assert.equal(r.added, 2) // 作息条目照样存进册子（不丢数据）
  const setting = r.entries.find((e) => e.keys.includes('作息'))
  assert.equal(isSettingOwned(setting), true)

  // 但读的时候一条都不取：对话里只按设置现算的作息。
  assert.equal(matchEntries(r.entries, '你的作息是怎样的？').length, 0)
  assert.deepEqual(matchEntries(r.entries, '临江的作息').map((h) => h.id), [r.entries.find((e) => e.keys.includes('临江')).id])
})

test('导入：disable:true 的条目留着但标成不启用', () => {
  const r = importLorebook({ entries: [{ key: ['旧设定'], content: '已经不成立了。', disable: true }] })
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].enabled, false)
})

test('匹配：长关键词优先、超上限截断、不启用的不参与', () => {
  const entries = [
    { id: 'a', keys: ['学校'], text: '学校很大。', enabled: true, at: 1 },
    { id: 'b', keys: ['临江三中'], text: '临江三中是她念书的地方。', enabled: true, at: 2 },
    { id: 'c', keys: ['秘密'], text: '这条不该被取到。', enabled: false, at: 3 },
  ]
  const hit = matchEntries(entries, '你还记得临江三中吗')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].id, 'b')

  const many = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, keys: ['临江'], text: `第${i}条`, enabled: true, at: i }))
  assert.equal(matchEntries(many, '临江').length, MATCH_MAX)
  assert.equal(matchEntries(entries, '').length, 0)
})

test('匹配：总字数有上限，长的截断并加省略号', () => {
  const entries = [{ id: 'a', keys: ['长'], text: '字'.repeat(5000), enabled: true, at: 1 }]
  const hit = matchEntries(entries, '很长的一段话', { chars: 20 })
  assert.equal(hit.length, 1)
  assert.ok(hit[0].text.length <= 20)
  assert.ok(hit[0].text.endsWith('…'))
})

test('存储：没导入过不建文件；导入后是 0600，读完能拿回同样的条目', async () => {
  const root = await tmpRoot()
  const wb = createWorldbook(root)
  assert.deepEqual(await wb.list(), [])
  await assert.rejects(fs.stat(path.join(root, WORLDBOOK_FILE)))

  await wb.replace(importLorebook(lorebook).entries)
  const st = await fs.stat(path.join(root, WORLDBOOK_FILE))
  // Windows 上 mode 位不可靠，只在类 POSIX 上断言
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600)

  const list = await createWorldbook(root).list()
  assert.equal(list.length, 2)

  const stats = await wb.stats()
  assert.equal(stats.count, 2)
  assert.equal(stats.enabled, 2)
  assert.ok(stats.chars > 0)

  await wb.add([{ key: ['新'], content: '后来加的一条。' }])
  assert.equal((await wb.stats()).count, 3)
  const all = await wb.list()
  await wb.remove(all[0].id)
  assert.equal((await wb.stats()).count, 2)

  await wb.clear()
  assert.equal((await wb.stats()).count, 0)
  await fs.rm(root, { recursive: true, force: true })
})

test('提示词：有命中才加「你知道的事」，没有就一个字不加', () => {
  assert.equal(knowledgeBlock([]), '')
  const block = knowledgeBlock([{ text: '临江是座沿江的小城。' }])
  assert.match(block, /你知道的事/)
  assert.match(block, /临江是座沿江的小城/)
  // 0.2.2：降级成可选事实卡——用不上就不用，不是这一轮的必答题
  assert.match(block, /用不上就不用/)
  assert.match(block, /不是你要主动提的话题/)
  // 是事实，不是要求
  assert.doesNotMatch(block, /你是一个/)
  // 陈述句、第一人称：不许写成「你应该记住这些」
  assert.doesNotMatch(block, /你应该/)

  const msg = { channel: 'qq', kind: 'group', conversationId: '1', conversationName: '群', personName: 'Lily', text: '在吗' }
  assert.doesNotMatch(buildPrompt(msg, [], {}), /你知道的事/)
  assert.match(buildPrompt(msg, [], { knowledge: [{ text: '临江是座沿江的小城。' }] }), /你知道的事/)
})

test('界面回执说清新增/跳过重复/合并三条数（0.2.2）', async () => {
  const src = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('条重复'), '导入回执要写「跳过 Y 条重复」')
  assert.ok(src.includes('跳过 ${n(r?.skipped)} 条重复'))
  assert.ok(src.includes('合并 ${n(r?.merged)} 条'))
  assert.ok(src.includes('新增 ${n(r?.added)} 条'))
})

test('身份文档也带上她知道的事：他在的时候，她也知道这些', async () => {
  const root = await tmpRoot()
  await createWorldbook(root).add([{ key: ['临江'], content: '住在临江路 12 号。' }])
  await writeSelfDoc(root, {})

  const doc = await fs.readFile(path.join(root, 'home', '她的身份.md'), 'utf8')
  assert.match(doc, /## 我知道的事/)
  assert.match(doc, /临江路 12 号/)
  // 还是事实，不是人设
  assert.doesNotMatch(doc, /你是一个温柔的人/)

  await fs.rm(root, { recursive: true, force: true })
})

test('身份文档里的作息按设置现算，世界书里的作息不再压过它（2026-11-07 真机）', async () => {
  const root = await tmpRoot()
  await updateConfig({ wakesPerDay: 3, window: ['08:00', '23:00'] }, root)
  await createWorldbook(root).add([
    { key: ['作息'], content: '她一般晚上八点到十一点之间醒着，一天醒两次。' },
    { key: ['临江'], content: '住在临江路 12 号。' },
    { key: ['旧设定'], content: '这条停用了，不该出现。', enabled: false },
  ])
  await writeSelfDoc(root, {})

  const doc = await fs.readFile(path.join(root, 'home', '她的身份.md'), 'utf8')
  assert.match(doc, /定时叫醒落在 08:00–23:00 之间，一天最多 3 次/)
  assert.doesNotMatch(doc, /晚上八点到十一点/)
  assert.doesNotMatch(doc, /一天醒两次/)
  assert.doesNotMatch(doc, /这条停用了/)
  assert.match(doc, /临江路 12 号/)

  await fs.rm(root, { recursive: true, force: true })
})

test('对话里也不从世界书取作息：这条归设置管（2026-11-07 真机）', () => {
  const entries = [
    { id: 'a', keys: ['作息'], text: '晚上八点到十一点醒着，一天两次。', enabled: true, at: 1 },
    { id: 'b', keys: ['临江'], text: '住在临江路 12 号。', enabled: true, at: 1 },
  ]
  assert.equal(matchEntries(entries, '你的作息是怎样的？').length, 0)
  assert.deepEqual(matchEntries(entries, '临江的作息').map((h) => h.id), ['b'])
})

test('设置里把定时叫醒关掉时，身份文档写「关着」，不写旧次数', () => {
  const doc = renderSelfDoc({ ...deriveSelf([]), stage: 1 }, { wakeWindow: ['08:00', '23:00'], wakeLimit: 0 })
  assert.match(doc, /定时叫醒现在是关着的/)
})

test('没导入过世界书时，身份文档里连标题都不出现', () => {
  const doc = renderSelfDoc({ ...deriveSelf([]), stage: 1 }, {})
  assert.equal(doc.includes('## 我知道的事'), false)
  assert.equal(KNOWLEDGE_SHOWN, 24)
})
