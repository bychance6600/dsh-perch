/**
 * gate.test.mjs —— 该不该叫醒她
 *
 * 冷却的唯一目的是防刷屏。群里几十条要压住，主人自己在私信里连说三句不该被压；
 * 被点名的、被管理员叫到的，也不该被冷却压住。
 *
 * 2026-11-06：时间相关的判断都传一个固定的「晚上八点」（非夜间、非峰时），
 * 否则测试在半夜跑会假红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canReply,
  REPLY_COOLDOWN_MS,
  GROUP_COOLDOWN_MS,
  RATE_LIMIT_PER_MIN,
  GROUP_DAILY_MAX,
} from '../lib/channels/gate.js'

const cfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'] } } }
const NOW = Date.parse('2026-11-06T20:00:00+08:00')
const base = { channel: 'qq', stage: 3, config: cfg, now: NOW }

test('gate：主人私聊连说两句，第二句不压', () => {
  const r = canReply({ ...base, kind: 'dm', conversationId: '10086', isOwner: true, lastReplyAt: base.now - 1000 })
  assert.equal(r.ok, true)
  assert.equal(r.why, '')
})

test('gate：群里被 @ 时冷却豁免——点名了就该应', () => {
  const r = canReply({
    ...base,
    kind: 'group',
    conversationId: '999',
    isOwner: true,
    mentioned: true,
    lastReplyAt: base.now - 1000,
  })
  assert.equal(r.ok, true)
})

test('gate：群里没被点名，才受 120s 冷却限制', () => {
  const quietCfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'], mentionOnly: false } } }
  const r = canReply({
    ...base,
    config: quietCfg,
    kind: 'group',
    conversationId: '999',
    isOwner: false,
    stage: 3,
    lastReplyAt: base.now - 1000,
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'cooldown')
})

test('gate：管理员说话不受群冷却限制', () => {
  const quietCfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'], mentionOnly: false } } }
  const r = canReply({
    ...base,
    config: quietCfg,
    kind: 'group',
    conversationId: '999',
    isOwner: false,
    isAdmin: true,
    stage: 3,
    lastReplyAt: base.now - 1000,
  })
  assert.equal(r.ok, true)
})

test('gate：陌生人的私聊仍然受冷却限制', () => {
  const r = canReply({
    ...base,
    kind: 'dm',
    conversationId: '20000',
    isOwner: false,
    lastReplyAt: base.now - (REPLY_COOLDOWN_MS - 1),
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'cooldown')
})

test('gate：冷却时间过去之后就放行', () => {
  const r = canReply({
    ...base,
    kind: 'dm',
    conversationId: '20000',
    isOwner: false,
    lastReplyAt: base.now - REPLY_COOLDOWN_MS,
  })
  assert.equal(r.ok, true)
})

test('gate：群里没 @ 她就不开口，@ 了才说话', () => {
  const cfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['123456789'] } } }
  const notMentioned = canReply({ channel: 'qq', kind: 'group', conversationId: '123456789', isOwner: true, stage: 3, config: cfg, now: NOW })
  assert.equal(notMentioned.ok, false)
  assert.equal(notMentioned.why, 'group-not-mentioned')
  const mentioned = canReply({ channel: 'qq', kind: 'group', conversationId: '123456789', isOwner: true, stage: 3, config: cfg, mentioned: true, now: NOW })
  assert.equal(mentioned.ok, true)
})

test('gate：mentionOnly 关掉之后群里又回到「每句都接」', () => {
  const cfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['123456789'], mentionOnly: false } } }
  const r = canReply({ channel: 'qq', kind: 'group', conversationId: '123456789', isOwner: true, stage: 3, config: cfg, now: NOW })
  assert.equal(r.ok, true)
})

test('gate：私聊不受 @ 规则影响', () => {
  const cfg = { channels: { qq: { enabled: true, ownerId: '1' } } }
  const r = canReply({ channel: 'qq', kind: 'dm', conversationId: '1', isOwner: true, stage: 1, config: cfg, now: NOW })
  assert.equal(r.ok, true)
})

test('gate：夜里 23:00–08:00，群里不点名就不叫醒她', () => {
  const quietCfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'], mentionOnly: false } } }
  const night = Date.parse('2026-11-06T23:30:00+08:00')
  const r = canReply({ channel: 'qq', kind: 'group', conversationId: '999', isOwner: false, stage: 3, config: quietCfg, now: night })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'quiet-hours')
  const mentioned = canReply({ channel: 'qq', kind: 'group', conversationId: '999', isOwner: false, stage: 3, config: quietCfg, now: night, mentioned: true })
  assert.equal(mentioned.ok, true)
})

test('gate：工作日峰时 9–12 只接点名的；周末同一时刻照常', () => {
  const quietCfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'], mentionOnly: false } } }
  const peak = Date.parse('2026-11-06T10:30:00+08:00') // 周五上午
  const r = canReply({ channel: 'qq', kind: 'group', conversationId: '999', isOwner: false, stage: 3, config: quietCfg, now: peak })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'peak-hours')
  const weekend = Date.parse('2026-11-07T10:30:00+08:00') // 周六上午
  const ok = canReply({ channel: 'qq', kind: 'group', conversationId: '999', isOwner: false, stage: 3, config: quietCfg, now: weekend })
  assert.equal(ok.ok, true)
  const mentioned = canReply({ ...base, config: quietCfg, kind: 'group', conversationId: '999', isOwner: false, mentioned: true, now: peak })
  assert.equal(mentioned.ok, true)
})

test('gate：一分钟 30 条封顶', () => {
  const recentReplies = Array.from({ length: RATE_LIMIT_PER_MIN }, (_, i) => ({
    at: NOW - i * 1000,
    kind: 'dm',
    conversationId: '20000',
  }))
  const r = canReply({ ...base, kind: 'dm', conversationId: '20000', isOwner: false, recentReplies })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'rate-limited')
  const justUnder = recentReplies.slice(1)
  const ok = canReply({ ...base, kind: 'dm', conversationId: '20000', isOwner: false, recentReplies: justUnder })
  assert.equal(ok.ok, true)
})

test('gate：一个群一天 20 条封顶，别的群不受影响', () => {
  const many = Array.from({ length: GROUP_DAILY_MAX }, (_, i) => ({
    at: NOW - i * 60_000,
    kind: 'group',
    conversationId: '999',
  }))
  const quietCfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'], mentionOnly: false } } }
  const r = canReply({ ...base, config: quietCfg, kind: 'group', conversationId: '999', isOwner: false, mentioned: true, recentReplies: many })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'daily-limit')
  const otherCfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999', '888'], mentionOnly: false } } }
  const other = canReply({ ...base, config: otherCfg, kind: 'group', conversationId: '888', isOwner: false, mentioned: true, recentReplies: many })
  assert.equal(other.ok, true)
})

test('gate：被回复也算点名（回复她那条 = 在跟她说话）', () => {
  const r = canReply({ ...base, kind: 'group', conversationId: '999', isOwner: false, replyToSelf: true, lastReplyAt: NOW - 1000 })
  assert.equal(r.ok, true)
})

test('gate：没人跟她说过的群，不该因为「没点名」被记成 cooldown', () => {
  // 回归：冷却只在真的回过之后才算——lastReplyAt 为空时不该拦。
  const quietCfg = { channels: { qq: { enabled: true, replyInGroup: true, groups: ['999'], mentionOnly: false } } }
  const r = canReply({ ...base, config: quietCfg, kind: 'group', conversationId: '999', isOwner: false, lastReplyAt: 0 })
  assert.equal(r.ok, true)
})

test('gate：群冷却常量是 120s', () => {
  assert.equal(GROUP_COOLDOWN_MS, 120_000)
})
