/**
 * pet-state.test.mjs —— 她会怎么动（2026-11-08，m09369）
 *
 * 守四件事：
 *   1. 五档只用事实翻译，不猜情绪；
 *   2. «动手» 精确到 tool/call；
 *   3. done / error 到点自己收回 waiting；
 *   4. 睡和醒是身体动作，不占五档。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PET_STATES,
  STATE_LABELS,
  asleepFromEvents,
  awakeChange,
  holdLeft,
  initialState,
  labelOf,
  reducePetState,
  stateAt,
  toolWhy,
} from '../lib/pet/state.js'

test('初始档是「等」，五档的界面字都是中文', () => {
  const s = initialState(1000)
  assert.equal(s.state, 'waiting')
  assert.equal(s.why, '等：她醒着，没在做事')
  assert.equal(s.until, 0)
  assert.deepEqual([...PET_STATES], ['thinking', 'acting', 'waiting', 'error', 'done'])
  assert.equal(labelOf('thinking'), '思考')
  assert.equal(labelOf('acting'), '动手')
  assert.equal(labelOf('done'), '成了')
  assert.equal(labelOf('没有这一档'), '等')
  assert.equal(STATE_LABELS.error, '出错')
})

test('回合开始和「人说话了」进思考；不是人说的不动', () => {
  const s = initialState(0)
  assert.equal(reducePetState(s, { type: 'turn/start' }, { now: 10 }).state, 'thinking')
  assert.equal(reducePetState(s, { type: 'user/message' }, { now: 10, human: false }).state, 'waiting')
  assert.equal(reducePetState(s, { type: 'user/message' }, { now: 10, human: true }).state, 'thinking')
})

test('动手：tool/call 按工具名说一句事实，tool/result 回思考', () => {
  const s = initialState(0)
  const a = reducePetState(s, { type: 'tool/call', data: { name: 'bili_look' } }, { now: 10 })
  assert.equal(a.state, 'acting')
  assert.equal(a.why, '动手：在翻 B 站')
  assert.equal(toolWhy('没有这个工具'), '动手：在做事')

  const b = reducePetState(a, { type: 'tool/result', data: {} }, { now: 20 })
  assert.equal(b.state, 'thinking')
  assert.equal(b.why, '思考：刚动完手')

  // assistant/message 只影响气泡，不改档。
  assert.equal(reducePetState(b, { type: 'assistant/message' }, { now: 30 }).state, 'thinking')
})

test('回合完了停 2 秒「成了」，失败停 5 秒「出错」，到点回「等」', () => {
  const done = reducePetState(initialState(0), { type: 'turn/end', data: { reason: { kind: 'completed' } } }, { now: 100 })
  assert.equal(done.state, 'done')
  assert.equal(done.why, '成了：这一轮完了')
  assert.equal(holdLeft(done, 100), 2000)
  assert.equal(stateAt(done, 2099).state, 'done')
  assert.equal(stateAt(done, 2100).state, 'waiting')
  assert.equal(stateAt(done, 2100).why, '等：她醒着，没在做事')

  const bad = reducePetState(initialState(0), { type: 'turn/end', data: { reason: { kind: 'error' } } }, { now: 100 })
  assert.equal(bad.state, 'error')
  assert.equal(bad.why, '出错：回合失败')
  assert.equal(holdLeft(bad, 100), 5000)
  assert.equal(stateAt(bad, 5101).state, 'waiting')

  const failed = reducePetState(initialState(0), { type: 'prompt-failed' }, { now: 0 })
  assert.equal(failed.state, 'error')
})

test('睡不睡看账本最后一条 sleep 之后有没有事，不看时段', () => {
  const now = new Date(2026, 10, 8, 15, 0)
  const sleep = { type: 'meta', text: 'sleep:2026-11-08' }
  assert.equal(asleepFromEvents([], now), false)
  assert.equal(asleepFromEvents([{ type: 'utterance', text: '还在' }], now), false)
  assert.equal(asleepFromEvents([{ type: 'utterance' }, sleep], now), true)
  assert.equal(asleepFromEvents([sleep, { type: 'meta', text: 'wake:2026-11-08 ?' }], now), false)
  assert.equal(asleepFromEvents([{ type: 'meta', text: 'sleep:2026-11-07' }, sleep], now), true)
  assert.equal(asleepFromEvents([sleep, { type: 'meta', text: 'sleep:2026-11-07' }], now), false)
})

test('睡和醒只在真的翻面时各发一次动作', () => {
  const a = awakeChange(initialState(0), false, 0)
  assert.deepEqual(a, { asleep: true, act: 'sleep', why: '睡：她不在' })
  const b = awakeChange({ ...initialState(0), asleep: true }, false, 0)
  assert.equal(b.act, '')
  const c = awakeChange({ ...initialState(0), asleep: true }, true, 0)
  assert.deepEqual(c, { asleep: false, act: 'wake', why: '醒：她回来了' })
  const d = awakeChange(initialState(0), true, 0)
  assert.equal(d.act, '')
})
