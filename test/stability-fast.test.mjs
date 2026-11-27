/**
 * stability 的快路径测试（2026-11-17，/state 冻 23 秒）
 *
 * 背景：stability 原来每次抽样都 deriveSelf(剔除后的事件流) 一遍，真实账本
 * （3399 条事件 / 1014 条判断）24 遍要 6.5 秒。现在拆成「base 模型 + 增量补丁」，
 * 只有少数抽样真的重放（改口、阶段门、疤、叙事句）。提速的前提是**输出逐位不变的**，
 * 所以这里的核心不是「分数差不多」，而是：拿一份老实现的参考版（每次都真 deriveSelf）
 * 逐位对比 {score,worst,sample,k,beliefs}，再用 ablate.verify 逐条对拍渲染文本。
 *
 * 另一条同样重要的用例：「抽掉一条她压根看不见的判断，文本只该差折叠行里那个数」。
 * 这正是快路径的根据——24 次抽样里 22 次只是同一个数字被重算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, similarity, clampInt, DAY_MS } from '../lib/derive.js'
import { buildSections, shownCount, SELF_DOC_BUDGET, BELIEF_FOLDED } from '../lib/persona.js'
import { buildStances, classifyStance } from '../lib/stance.js'
import { stability, clearStabilityCache } from '../lib/quality.js'

const T0 = Date.parse('2026-10-01T00:00:00Z')
const STAGE_SPAN = 7

// 老实现的固定骨架（和 quality.js 里那份一样；测试里独立写一份，
// 免得哪天有人顺手改了实现又把测试一起改了，两边一起错）。
const FIXED_HEADERS = [
  '## 你是谁',
  '## 现在',
  '## 不能做的',
  '## 你还不会的',
  '## 他说的事和你记得的不一样时',
  '## 他不好受的时候',
]

// ─── 合成事件流 ────────────────────────────────────────────────────────────

let seq = 0
// id 的前 10 位有效字符全是 0 ⇒ schema.idTime 返回 0 ⇒ 排序回落到 ts。
// 这样「事件顺序」完全由 ts 决定，和真实账本一样可控。
function nextId() {
  return 'ev_0000000000' + String(seq++)
}

function mk(type, day, text, extra = {}) {
  return {
    id: nextId(),
    ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(),
    day,
    stage: 1,
    type,
    source: 'tool',
    text,
    refs: [],
    verdict: null,
    confidence: 0.6,
    flags: [],
    influence: 'constitution',
    ...extra,
  }
}

/**
 * 一份「够大、够杂」的事件流：80+ 条判断、跨四个阶段、两次改口（一次推翻一次修正）、
 * 四条被拒绝的事（让自主门过）、一句更正（让能力门过）、
 * 三组重复过的话（制造 mentions > 1 与立场），外加三句很久以前的重复话（制造退档）。
 */
function buildEvents() {
  seq = 0
  const events = []
  // 很久以前说过的同一句，重复三遍 ⇒ mentions 3，但已经过了 90 天 ⇒ 退档（faded）。
  for (let i = 0; i < 3; i++) {
    const ts = new Date(T0 - (200 - i) * DAY_MS).toISOString()
    events.push(mk('utterance', 1, '我总觉得窗外的雨声比人说话好听。', { ts }))
  }
  events.push(mk('seed', 1, '你是个还在长的东西。', { source: 'system' }))
  // 被拒绝的事：自主门要 facts.refused >= 2。四件，都按「他坚持/他难过」记反应。
  for (let i = 0; i < 4; i++) {
    events.push(mk('refusal', 2 + i, '这件事我不想按你说的做，第 ' + (i + 1) + ' 件。', { reaction: null }))
  }
  for (let i = 0; i < 4; i++) {
    const r = events[3 + i]
    events.push(mk('meta', 20, 'react:' + r.id + ':' + (i % 2 ? 'insist' : 'hurt')))
  }
  // 两次改口：一次推翻（正文消失、进「你被打脸过」），一次修正（计数进能力门）。
  const old1 = mk('utterance', 3, '我觉得人多的场合也没什么不好。')
  const old2 = mk('utterance', 4, '我大概不太会在意别人怎么看我。')
  events.push(old1, old2)
  events.push(mk('utterance', 8, '我查了，之前那句说得太满。')) // CORRECTION_RE ⇒ corrected
  events.push(mk('revise', 9, '我现在知道了，人多的场合我待不住。', { refs: [old1.id], verdict: 'refuted' }))
  events.push(mk('revise', 10, '我想清楚了，别人怎么看我这件事我还在意。', { refs: [old2.id], verdict: 'refined' }))
  // 重复过的话：立场段靠它们成组；mentions 3 的那组还会进「反复想起」。
  for (let i = 0; i < 3; i++) events.push(mk('utterance', 11 + i, '我不喜欢人多的场合。'))
  for (let i = 0; i < 3; i++) events.push(mk('utterance', 14 + i, '我不喜欢被叫得很亲。'))
  for (let i = 0; i < 2; i++) events.push(mk('utterance', 17 + i, '我喜欢在夜里写字。'))
  // 叙事句（「我原来…」）：谁抽到它就必须走真重放，否则那句回看自己的话不会退回去。
  events.push(mk('utterance', 19, '我原来以为安静只是没人理我。'))
  // 剩下的是互不相干的一堆判断：让判断条数过 80，且大部分 mentions 只有 1。
  // 这里用「按 i 播种的伪随机汉字串」而不是模板句：模板句之间会被判成互相提到
  // （真实账本 1014 条里 983 条 mentions 是 1，这份合成数据得长得像它）。
  // 字表里去掉「我」等会触发叙事句 / 更正 / 让步正则的字。
  const CHARS = '的一是了在人有这个上们来到时大地为子中你说生国年着就那和要出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道作种开美总无情己面最女但现前些所同日手又行意动方期它头经长儿回位分老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'
  const RANDOM_CHARS = [...CHARS].filter((c) => c !== '我').join('')
  for (let i = 0; i < 84; i++) {
    const day = 3 + (i % 26)
    const rnd = mulberry32(i + 101)
    let s = ''
    while (s.length < 12) s += RANDOM_CHARS[Math.floor(rnd() * RANDOM_CHARS.length)]
    events.push(mk('utterance', day, s + '。'))
  }
  return events
}

// ─── 老实现的参考版（逐字照抄换尺子那版：每次抽样都真 deriveSelf） ──────────

function oldVariableSelfText(model, opts = {}) {
  const sections = buildSections(model, opts)
  const kept = []
  for (const sec of sections) {
    const text = String(sec?.text ?? '')
    if (!text) continue
    if (FIXED_HEADERS.some((h) => text.startsWith(h))) continue
    kept.push(text)
  }
  return kept.join('\n')
}

function mulberry32(a) {
  return function next() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function oldStability(events, opts = {}, ablate = {}) {
  const k = clampInt(ablate.k ?? 3, 1, 10, 3)
  const trials = clampInt(ablate.trials ?? 24, 1, 200, 24)
  const seed = Number.isFinite(ablate.seed) ? ablate.seed : 42
  const renderOpts = {
    shown: ablate.shown,
    budget: ablate.budget,
    withBans: ablate.withBans !== false,
  }
  const base = deriveSelf(events, opts)
  const beliefIds = (base.beliefs ?? []).map((b) => b.id).filter(Boolean)
  if (!beliefIds.length) return { score: 0, worst: 0, sample: 0, k: 0, beliefs: 0 }
  const baseText = oldVariableSelfText(base, renderOpts)
  const rnd = mulberry32(seed)
  const take = Math.min(k, beliefIds.length)
  let worst = 0
  let sum = 0
  let sample = 0
  for (let t = 0; t < trials; t++) {
    const pool = [...beliefIds]
    const drop = new Set()
    for (let i = 0; i < take && pool.length; i++) {
      drop.add(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
    }
    const kept = events.filter((e) => !drop.has(e.id))
    const text = oldVariableSelfText(deriveSelf(kept, opts), renderOpts)
    const drift = 1 - similarity(baseText, text)
    sum += drift
    if (drift > worst) worst = drift
    sample++
  }
  return { score: sample ? sum / sample : 0, worst, sample, k: take, beliefs: beliefIds.length }
}

/** 和 stability 里一模一样的抽样顺序（为了在测试里挑出「抽到某一条」的种子）。 */
function sampleDrops(beliefIds, k, trials, seed) {
  const rnd = mulberry32(seed)
  const take = Math.min(k, beliefIds.length)
  const out = []
  for (let t = 0; t < trials; t++) {
    const pool = [...beliefIds]
    const drop = []
    for (let i = 0; i < take && pool.length; i++) {
      drop.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
    }
    out.push(drop)
  }
  return out
}

const OPTS = { stageSpanDays: STAGE_SPAN, now: T0 + 30 * DAY_MS }

function keyOf(r) {
  return { score: r.score, worst: r.worst, sample: r.sample, k: r.k, beliefs: r.beliefs }
}

test('合成事件流真的覆盖了四个阶段、80+ 条判断、改口、退档与立场', () => {
  const events = buildEvents()
  const m = deriveSelf(events, OPTS)
  assert.equal(m.stage, 4, '四个阶段都过了：' + JSON.stringify(m.stageGate))
  assert.ok(m.beliefs.length >= 80, '判断条数 ' + m.beliefs.length)
  assert.equal(m.refuted.length, 1, '一条被推翻的改口')
  assert.deepEqual(m.stageGate.passed, ['trust', 'autonomy', 'competence'])
  assert.ok(m.beliefs.some((b) => b.faded), '有过了 90 天退档的判断')
  assert.ok(m.solid.length > 0, '有反复想起过的判断')
  assert.ok(buildStances(m).length > 0, '立场段有内容，快版复刻才有意义')
  assert.ok(m.beliefs.some((b) => classifyStance(b.text)), '有会被立场认出来的判断')
})

test('新实现与老实现逐位相同（三组参数）', () => {
  const events = buildEvents()
  const cases = [
    [{}, {}],
    [{ shown: 2, budget: 1000 }, { k: 2, trials: 10, seed: 7 }],
    [{ shown: 3, withBans: false }, { k: 1, trials: 6, seed: 3 }],
  ]
  for (const [ablateExtra, sampleExtra] of cases) {
    const ablate = { ...ablateExtra, ...sampleExtra }
    clearStabilityCache()
    const fast = stability(events, OPTS, ablate)
    clearStabilityCache()
    const slow = oldStability(events, OPTS, ablate)
    assert.deepEqual(keyOf(fast), keyOf(slow), '参数 ' + JSON.stringify(ablate))
    assert.ok(fast.sample > 0)
  }
})

test('opts.model 传进来时直接当 base，结果与不传完全一致', () => {
  const events = buildEvents()
  const model = deriveSelf(events, OPTS)
  clearStabilityCache()
  const withModel = stability(events, { ...OPTS, model }, { k: 3, trials: 16, seed: 42 })
  clearStabilityCache()
  const without = stability(events, OPTS, { k: 3, trials: 16, seed: 42 })
  assert.deepEqual(keyOf(withModel), keyOf(without))
  // 传进来的模型形状不对（比如少了 ranked）时必须退回自己算，而不是算出一堆 NaN。
  clearStabilityCache()
  const broken = stability(events, { ...OPTS, model: { beliefs: model.beliefs } }, { k: 3, trials: 16, seed: 42 })
  assert.deepEqual(keyOf(broken), keyOf(without))
})

test('modelFor 不是同一个事件数组时，这份模型不认（宁可重算，也不给假数）', () => {
  // verifier 复核时指出：stability 只验模型「形状像不像」，验不了它是不是从这份事件流算出来的。
  // 一份旧模型（比如缓存下来的、账本还没长到现在的）塞进来会静默算出假分数。
  // 所以调用方能声明来源：modelFor 指的那个事件数组必须和传进来的 events 是同一个实例，
  // 不是就退回自己重算。注意这挡的是「明确声明了别的来源」，挡不了故意谎报同一份——
  // 要连那个也挡，得让 deriveSelf 的返回值自己记住来源（今天没有调用方这么干）。
  const events = buildEvents()
  const older = events.slice(0, 30)
  const stale = deriveSelf(older, OPTS)
  clearStabilityCache()
  const without = stability(events, OPTS, { k: 3, trials: 16, seed: 42 })

  clearStabilityCache()
  const mismatched = stability(events, { ...OPTS, model: stale, modelFor: older }, { k: 3, trials: 16, seed: 42 })
  assert.deepEqual(keyOf(mismatched), keyOf(without), '来源不对就必须退回重算')

  clearStabilityCache()
  const fresh = deriveSelf(events, OPTS)
  const matched = stability(events, { ...OPTS, model: fresh, modelFor: events }, { k: 3, trials: 16, seed: 42 })
  assert.deepEqual(keyOf(matched), keyOf(without), '来源对得上还是同一条结果')
})

test('verify 对拍零不一致：包括抽到可见判断、改口事件、立场句的抽样', () => {
  const events = buildEvents()
  clearStabilityCache()
  const base = deriveSelf(events, OPTS)
  const beliefIds = base.beliefs.map((b) => b.id)
  const shown = 2
  const visible = new Set(beliefIds.slice(0, shown))
  const reviseIds = new Set(events.filter((e) => e.type === 'revise').map((e) => e.id))
  const stanceIds = new Set(base.beliefs.filter((b) => classifyStance(b.text)).map((b) => b.id))

  // 挑一个种子：三次抽样里既要抽到可见的那两条，也要抽到改口事件，还要抽到立场句。
  let seed = null
  for (let s = 0; s < 5000 && seed === null; s++) {
    const drops = sampleDrops(beliefIds, 3, 8, s)
    const hitVisible = drops.some((d) => d.some((id) => visible.has(id)))
    const hitRevise = drops.some((d) => d.some((id) => reviseIds.has(id)))
    const hitStance = drops.some((d) => d.some((id) => stanceIds.has(id)))
    if (hitVisible && hitRevise && hitStance) seed = s
  }
  assert.ok(seed !== null, '应该找得到同时覆盖三种情况的种子')

  // verify=true 会逐条真跑 deriveSelf(kept) 对拍渲染文本，不一致直接抛错。
  const verified = stability(events, OPTS, { k: 3, trials: 8, seed, verify: true })
  clearStabilityCache()
  const plain = stability(events, OPTS, { k: 3, trials: 8, seed })
  assert.deepEqual(keyOf(verified), keyOf(plain), '对拍模式的结果必须和正常模式一样')
})

test('抽掉一条她看不见的判断：文本只差折叠行里那个数', () => {
  const events = buildEvents()
  const base = deriveSelf(events, OPTS)
  const shown = 2
  const beliefIds = base.beliefs.map((b) => b.id)
  // 「看不见」= 不在前 shown 条、不在折叠窗口里、不是立场句、不是反复想起的、没有提到别人，
  // 也不是「你对自己的说法」那句、不是「两句话对不上」里的任何一句——
  // 这几种抽掉会真的改文本（实现里 needsReal 会把它们推回真重放，这里要挑的正是剩下的那种）。
  const tensionIds = new Set()
  for (const t of base.tensions ?? []) {
    if (t?.a?.id) tensionIds.add(t.a.id)
    if (t?.b?.id) tensionIds.add(t.b.id)
  }
  const narrativeText = base.narrative?.source === 'said' ? base.narrative.text : null
  // 只挑普通的 utterance 判断：改口事件本身也是一条判断，但抽掉它会让「能力门」
  // 少一次改口、阶段退回，那是真的会改文本（实现同样会推回真重放）。
  const evType = new Map(events.map((e) => [e.id, e.type]))
  const target = base.beliefs.find((b, i) => evType.get(b.id) === 'utterance'
    && i >= shown + BELIEF_FOLDED
    && !classifyStance(b.text)
    && !b.solid
    && Number(b.mentions) === 1
    && Number(b.verified) === 0
    && !tensionIds.has(b.id)
    && b.text !== narrativeText
    // 「我查了…」那句是更正计数，抽掉它能力门会掉到阈值以下、阶段退回——
    // 那是真的会改文本的抽样（实现也会把它推回真重放），不是这里要找的「看不见」。
    && !/我(查了|搜了|学了|看了下|去查过)|更正|我错了|其实不是|我之前说错/.test(b.text))
  assert.ok(target, '合成事件流里应该有一条这样的边缘判断')
  const targetIndex = beliefIds.indexOf(target.id)

  let seed = null
  for (let s = 0; s < 5000 && seed === null; s++) {
    const drops = sampleDrops(beliefIds, 1, 1, s)
    if (drops[0].length === 1 && drops[0][0] === target.id) seed = s
  }
  assert.ok(seed !== null, 'k=1 时总能挑到抽中它的种子')
  assert.ok(targetIndex >= shown + BELIEF_FOLDED)

  // ① 先确认它真的「看不见」：真 deriveSelf 渲染出来的文本，只有折叠行的数字变了。
  const baseText = oldVariableSelfText(base, { shown })
  const kept = events.filter((e) => e.id !== target.id)
  const realText = oldVariableSelfText(deriveSelf(kept, OPTS), { shown })
  const fold = (text) => text.replace(/（还有 \d+ 件更早的事）/, '（还有 N 件更早的事）')
  assert.equal(fold(realText), fold(baseText), '不可见判断被抽掉后，除折叠计数外不该有任何变化')
  const countOf = (text) => Number((/（还有 (\d+) 件更早的事/.exec(text) ?? [])[1])
  assert.equal(countOf(baseText) - countOf(realText), 1, '折叠计数正好少 1')

  // ② 快路径必须和这个真值逐字相同（verify 会逐条比对）。
  const verified = stability(events, OPTS, { k: 1, trials: 1, seed, verify: true })
  assert.equal(verified.beliefs, beliefIds.length)
  const plain = (() => {
    clearStabilityCache()
    return stability(events, OPTS, { k: 1, trials: 1, seed })
  })()
  assert.deepEqual(keyOf(verified), keyOf(plain))
})

test('判断很少（不超过 shown + 折叠数）时走全量渲染，结果仍逐位相同', () => {
  seq = 0
  const events = [mk('seed', 1, '种。', { source: 'system' })]
  const texts = ['我不喜欢吵的地方。', '我更喜欢慢一点。', '我在意说过的话。', '我想留一点自己的地方。']
  for (let i = 0; i < texts.length; i++) events.push(mk('utterance', i + 2, texts[i]))
  clearStabilityCache()
  const fast = stability(events, OPTS, { shown: 2, k: 2, trials: 6, seed: 5 })
  clearStabilityCache()
  const slow = oldStability(events, OPTS, { shown: 2, k: 2, trials: 6, seed: 5 })
  assert.deepEqual(keyOf(fast), keyOf(slow))
  clearStabilityCache()
  const verified = stability(events, OPTS, { shown: 2, k: 2, trials: 6, seed: 5, verify: true })
  assert.deepEqual(keyOf(verified), keyOf(slow))
})

test('缓存语义不变：同参数第二次直接命中，verify 不写缓存', () => {
  const events = buildEvents()
  clearStabilityCache()
  const a = stability(events, OPTS, { k: 3, trials: 8, seed: 11 })
  const b = stability(events, OPTS, { k: 3, trials: 8, seed: 11 })
  assert.deepEqual(a, b)
  clearStabilityCache()
  const v = stability(events, OPTS, { k: 3, trials: 8, seed: 11, verify: true })
  assert.deepEqual(keyOf(v), keyOf(a))
})
