/**
 * hername.test.mjs —— 她的名字从事件里认（2026-11-07，用户 m02288）
 *
 * 名字不写在代码里、也不做成人设输入框：只认「他自己说的那句」，
 * 群友起的外号、她复述别人的话、指代词（这/那）都不算。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  pickHerName, nameGivingEvent, herName,
  workspaceTitle, sessionTitle, navLabel,
} from '../lib/hername.js'

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-name-'))
}

function ev(over = {}) {
  return {
    id: 'ev_01J000000000000000000000A', v: 1, ts: '2026-11-02T14:39:29.452Z', day: 1, stage: 1,
    type: 'heard', source: 'system', text: '小满是你的名字', refs: [], verdict: null, confidence: 0.5,
    flags: [], person: 'u_1', visibility: 'private', channel: 'qq', origin: 'owner',
    influence: 'constitution',
    ...over,
  }
}

test('pickHerName 认得「你的名字是…」「给你起名…」「以后你就叫…」「我有名字了」', () => {
  assert.equal(pickHerName('是的 小满是你的名字 雀雀是我对你这可爱女孩子的爱称'), '小满')
  assert.equal(pickHerName('小满就是你的名字'), '小满')
  assert.equal(pickHerName('我给你起了名字：小满'), '小满')
  assert.equal(pickHerName('以后你就叫阿岸'), '阿岸')
  // 2026-11-10：TZ 那边说的是这个语序，之前认不出——「你就叫」被「以后」隔开了
  assert.equal(pickHerName('你以后就叫鱼欣'), '鱼欣')
  assert.equal(pickHerName('从今天起你就叫鱼欣吧'), '鱼欣')
  // 2026-11-12：TZ 说的是「我给你取名叫鱼欣」——中间没有「名字」二字，之前认不出，
  // 界面上就一直叫「她」「她的家」。
  assert.equal(pickHerName('我给你取名叫鱼欣'), '鱼欣')
  assert.equal(pickHerName('我给你取名叫鱼欣，你没拒绝，认可了这个名字'), '鱼欣')
  assert.equal(pickHerName('我有名字了：小满。'), '小满')
})

test('pickHerName 不认指代、不认对他的称呼、不认她说要改自己', () => {
  assert.equal(pickHerName('那是你的名字'), null)
  assert.equal(pickHerName('这是你的名字你已经认了对吧'), null)
  assert.equal(pickHerName('他给我起了名字：小满'), null, '「给我起的」是他在说自己')
  assert.equal(pickHerName('我以后称呼你叫阿岸，行吗'), null, '阿岸是她对他的称呼')
  assert.equal(pickHerName('你叫我去买菜'), null)
})

test('nameGivingEvent：主人在私聊/宿主里说的才算，群里别人的玩笑不算', () => {
  assert.equal(nameGivingEvent(ev()), true)
  assert.equal(nameGivingEvent(ev({ channel: 'dsh', visibility: '' })), true)
  assert.equal(nameGivingEvent(ev({ visibility: 'public' })), false, '群里说的是群友的名字')
  assert.equal(nameGivingEvent(ev({ type: 'utterance', text: '我有名字了：小满' })), true)
  assert.equal(nameGivingEvent(ev({ type: 'utterance', text: '你叫小满，我得先认出这是叫我' })), false)
  assert.equal(nameGivingEvent(ev({ type: 'revise', text: '小满这半句站得住' })), false)
})

test('herName 取最后一次命名；后来的盖掉先前的（换名）', async () => {
  const root = await tmpRoot()
  const rows = [
    ev({ id: 'ev_01J000000000000000000000A', text: '我给你起了名字：小满' }),
    ev({ id: 'ev_01J000000000000000000000B', ts: '2026-11-03T00:00:00.000Z', text: '以后你就叫阿岸' }),
  ]
  await fs.writeFile(path.join(root, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  assert.equal(await herName(root), '阿岸')
})

test('herName 不认群里的外号，也不被指代词带偏', async () => {
  const root = await tmpRoot()
  const rows = [
    ev({ id: 'ev_01J000000000000000000000A', text: '是的 小满是你的名字' }),
    ev({ id: 'ev_01J000000000000000000000B', ts: '2026-11-03T12:01:57.635Z', text: '孤独哥：你叫小满', visibility: 'public' }),
    ev({ id: 'ev_01J000000000000000000000C', ts: '2026-11-04T15:37:58.205Z', text: '当然了 那是你的名字' }),
  ]
  await fs.writeFile(path.join(root, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  assert.equal(await herName(root), '小满')
})

test('读不到事件流时返回空串，不抛', async () => {
  assert.equal(await herName(await tmpRoot()), '')
})

test('三处标题跟着名字走，没有名字就用「她」', () => {
  assert.equal(workspaceTitle('小满'), '小满的家')
  assert.equal(sessionTitle('小满'), '跟小满说话')
  assert.equal(navLabel('小满'), '小满')
  assert.equal(workspaceTitle(''), '她的家')
  assert.equal(sessionTitle(''), '跟她说话')
  assert.equal(navLabel(''), '她')
})
