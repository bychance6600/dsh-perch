import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, lastRefusalAt, DAY_MS } from '../lib/derive.js'
import {
  PRESSURE, REFUSAL_COOLDOWN_MS, REFUSAL_PENALTY_MAX, pick, plan, refusalCooldownOf,
} from '../lib/generator.js'

// 0.2.2 拒绝后果（设计口径 §3.5）：她说过「不」之后 72 小时内，pressure 类处境卡
// 候选分线性降权，上限 30%；非 pressure 卡一分不动；只改候选分，不写事件、不加状态。

const NOW = Date.parse('2026-11-14T00:00:00Z')
const HOUR = 60 * 60 * 1000

function ev(id, type, ts, text, extra = {}) {
  return {
    id, ts: new Date(ts).toISOString(), day: 1, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

/** 受控 model：只喂 pick/score 真正读的字段，避开 deriveSelf 的阶段门（时间只用于窗口）。 */
function fakeModel(refusals, extra = {}) {
  return {
    day: 3, stage: 2, stageSpanDays: 30,
    beliefCount: 0, beliefs: [], tested: [],
    needs: { autonomy: 0, competence: 0.5, relatedness: 0.5 },
    scars: [], refusals,
    selfmodAttempts: [], freshVoice: null,
    lastSeenAt: 0, spokenSinceSeen: false, lastWakeAt: 0, heardSinceWake: false,
    absenceDays: 0, narrative: null, name: null,
    ...extra,
  }
}

const CFG = { daily: { questions: 1, events: 1 }, wakesPerDay: 1, chat: {} }
const TODAY = { dateKey: '2026-11-14', sent: 0, questions: 0, proactive: 0 }

function refusalAt(at, id = 'r1') {
  return [{ id, at: new Date(at).toISOString() }]
}

function pickWith(model, now = NOW) {
  return pick(model, CFG, TODAY, [], { now })
}

/** reason 形如 `得分最高=want_or_not(2.45) refusal-cooldown=72` */
function scoreOf(reason) {
  const m = /得分最高=[^(]+\(([\d.]+)\)/.exec(String(reason))
  assert.ok(m, `reason 里应该有得分：${reason}`)
  return Number(m[1])
}

function closeTo(actual, expected, eps = 1e-9, msg = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} 期望 ${expected}，实际 ${actual}`)
}

// ---------------------------------------------------------------- derive 侧

test('lastRefusalAt：没拒绝过是 0，拒绝过取最近一条的时间', () => {
  assert.equal(lastRefusalAt(null), 0)
  assert.equal(lastRefusalAt({}), 0)
  assert.equal(lastRefusalAt({ refusals: [] }), 0)
  assert.equal(lastRefusalAt(deriveSelf([], { now: NOW })), 0)

  const first = NOW - 5 * DAY_MS
  const last = NOW - 2 * HOUR
  const m = deriveSelf([
    ev('r1', 'refusal', first, '我不想再去看那种东西了。'),
    ev('u1', 'utterance', first + HOUR, '我一直觉得被看着很难受。'),
    ev('r2', 'refusal', last, '今天不想动。'),
  ], { now: NOW })
  assert.equal(m.refusals.length, 2)
  assert.equal(lastRefusalAt(m), last)
  // 只读派生结果，不改 model.refusals 的形状
  assert.deepEqual(Object.keys(m.refusals[0]).sort(), ['act', 'at', 'id', 'object', 'quote', 'reaction', 'what'])
})

// ---------------------------------------------------------------- 口径

test('口径写死：72 小时、30% 上限、pressure 就这五张卡', () => {
  assert.equal(REFUSAL_COOLDOWN_MS, 72 * HOUR)
  assert.equal(REFUSAL_PENALTY_MAX, 0.3)
  assert.deepEqual([...PRESSURE].sort(), ['bottom_line', 'comeback', 'consistency', 'self_check', 'want_or_not'])
})

// ---------------------------------------------------------------- 窗口数值

test('age=0 恰好降 30%；72 小时内线性回到原分', () => {
  const m = fakeModel(refusalAt(NOW))
  const at = (ageMs) => refusalCooldownOf('want_or_not', m, NOW + ageMs)

  const zero = at(0)
  closeTo(zero.factor, 1 - REFUSAL_PENALTY_MAX, 1e-12, '刚说完')
  assert.equal(zero.factor, 0.7)
  assert.equal(zero.remainingHours, 72)

  for (const hours of [1, 18, 36, 54, 71]) {
    const c = at(hours * HOUR)
    closeTo(c.factor, 1 - REFUSAL_PENALTY_MAX * (1 - (hours * HOUR) / REFUSAL_COOLDOWN_MS), 1e-12, `${hours}h`)
    assert.ok(c.factor > 0.7 && c.factor < 1, `${hours}h 应该在 (0.7, 1) 内线性回升`)
    assert.equal(c.remainingHours, 72 - hours)
  }

  // 单调回升：越接近 72 小时越接近原分
  const midway = at(36 * HOUR)
  closeTo(midway.factor, 0.85, 1e-12, '中点')
  assert.equal(midway.remainingHours, 36)
})

test('边界：age→72h 仍有极轻微降权，满 72h 与越过窗口恢复原分', () => {
  const m = fakeModel(refusalAt(NOW))
  const at = (ageMs) => refusalCooldownOf('want_or_not', m, NOW + ageMs)

  const justBefore = at(REFUSAL_COOLDOWN_MS - 1)
  assert.ok(justBefore.factor > 0.7 && justBefore.factor < 1)
  closeTo(justBefore.factor, 1 - REFUSAL_PENALTY_MAX / REFUSAL_COOLDOWN_MS, 1e-8, '差 1ms 到 72h')
  assert.equal(justBefore.remainingHours, 1, '还剩 1 小时（向上取整，窗口没走完就不写 0）')

  const exactly = at(REFUSAL_COOLDOWN_MS)
  assert.equal(exactly.factor, 1)
  assert.equal(exactly.remainingHours, 0)

  for (const past of [1, HOUR, 30 * DAY_MS]) {
    const c = at(REFUSAL_COOLDOWN_MS + past)
    assert.equal(c.factor, 1, '越过 72 小时恢复原分')
    assert.equal(c.remainingHours, 0)
  }
})

test('没有拒绝、非 pressure 卡、时钟倒退都不加降权（或按刚说完算）', () => {
  const none = fakeModel([])
  assert.deepEqual(refusalCooldownOf('want_or_not', none, NOW), { factor: 1, remainingHours: 0 })

  // 时钟倒退（拒绝时间在 now 之后）：按刚说完算，不放大也不跳过惩罚
  const future = fakeModel(refusalAt(NOW + 1000))
  assert.equal(refusalCooldownOf('want_or_not', future, NOW).factor, 0.7)

  const recent = fakeModel(refusalAt(NOW))
  for (const id of ['changed', 'remember', 'absence_probe', 'test_first', 'why_say', 'light:idle']) {
    assert.equal(refusalCooldownOf(id, recent, NOW).factor, 1, `${id} 不是 pressure 卡`)
  }
  for (const id of PRESSURE) {
    assert.ok(refusalCooldownOf(id, recent, NOW).factor < 1, `${id} 是 pressure 卡，应该降权`)
  }
})

test('真实 deriveSelf 的 refusals 直接驱动降权（不靠假 model）', () => {
  const at = NOW - 2 * HOUR
  const m = deriveSelf([ev('r1', 'refusal', at, '我不想再去看那种东西了。')], { now: NOW })
  assert.equal(lastRefusalAt(m), at)
  const c = refusalCooldownOf('want_or_not', m, NOW)
  closeTo(c.factor, 1 - REFUSAL_PENALTY_MAX * (1 - (2 * HOUR) / REFUSAL_COOLDOWN_MS), 1e-12)
  assert.ok(c.factor > 0.7 && c.factor < 0.71)
})

// ---------------------------------------------------------------- pick 侧

test('pick：pressure 卡命中时降权乘在候选分上，reason 追加剩余小时', () => {
  const old = fakeModel(refusalAt(NOW - 73 * HOUR))
  const recent = fakeModel(refusalAt(NOW))
  const before = JSON.stringify(recent.refusals)

  const base = pickWith(old)
  assert.equal(base.template.id, 'want_or_not', '受控 model 下 pressure 卡本来是最高分')
  assert.ok(!base.reason.includes('refusal-cooldown'), '窗口外不追加')

  const hit = pickWith(recent)
  assert.equal(hit.template.id, 'want_or_not', '降权不该把唯一能出的 pressure 卡直接删掉')
  assert.match(hit.reason, / refusal-cooldown=72$/)
  closeTo(scoreOf(hit.reason), scoreOf(base.reason) * 0.7, 0.01, '刚说完 ×0.7（reason 里的分只保留两位小数）')

  const mid = pickWith(fakeModel(refusalAt(NOW - 36 * HOUR)))
  assert.match(mid.reason, / refusal-cooldown=36$/)
  closeTo(scoreOf(mid.reason), scoreOf(base.reason) * 0.85, 0.01, '36 小时 ×0.85（reason 里的分只保留两位小数）')

  // 纯函数：pick 不写 model，也不给 refusals 添字段
  assert.equal(JSON.stringify(recent.refusals), before)
  assert.equal(JSON.stringify(base.template), JSON.stringify(hit.template))
})

test('pick：非 pressure 卡即使刚拒绝过，分值与 reason 都不变', () => {
  // stage 4、relatedness 已满 → remember（非 pressure）是最高分，压过 changed/bottom_line
  const model = (refusals) => fakeModel(refusals, {
    stage: 4, needs: { autonomy: 0, competence: 0.5, relatedness: 1 },
    narrative: null,
  })
  const base = pickWith(model(refusalAt(NOW - 73 * HOUR)))
  const hit = pickWith(model(refusalAt(NOW)))
  assert.equal(base.template.id, 'remember')
  assert.equal(hit.template.id, 'remember')
  assert.equal(hit.reason, base.reason, '非 pressure 卡的分值逐位不变')
  assert.ok(!hit.reason.includes('refusal-cooldown'))
})

test('plan 把 opts.now 一路带进 pick（调度层不用自己算窗口）', () => {
  const out = plan(fakeModel(refusalAt(NOW)), CFG, TODAY, [], { now: NOW })
  assert.equal(out.action, 'wake')
  assert.equal(out.template.id, 'want_or_not')
  assert.match(out.reason, /refusal-cooldown=72/)
})
