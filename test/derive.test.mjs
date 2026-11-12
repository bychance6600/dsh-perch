import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stageBounds, stageOf, deriveSelf, stampOf, consistency, novelty,
  similarity, pickName, DAY_MS,
} from '../lib/derive.js'
// 2026-10-26：stability 从 derive.js 搬到 quality.js（它要用到 persona 的渲染，
// 留在 derive 里会绕出 quality → persona → derive → quality 的环）。
import { stability, stabilityBand, clearStabilityCache } from '../lib/quality.js'

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

// 契约 §4：30 天 → 8/16/26/30；7 天 → 2/4/6/7
test('阶段边界对齐契约', () => {
  assert.deepEqual(stageBounds(30), [8, 16, 26, 30])
  assert.deepEqual(stageBounds(7), [2, 4, 6, 7])
  assert.equal(stageOf(1, 30), 1)
  assert.equal(stageOf(8, 30), 1)
  assert.equal(stageOf(9, 30), 2)
  assert.equal(stageOf(26, 30), 3)
  assert.equal(stageOf(27, 30), 4)
})

test('stageSpanDays 现算：30 改成 7 不重启立即生效', () => {
  const evs = [ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' })]
  const now = T0 + 5 * DAY_MS
  // 时间轴立即生效（elapsedStage）；实际 stage 还受阶段门约束——
  // 一条信念都没有，她本就该停在 stage 1，不能因为改成 7 天就凭空长大。
  assert.equal(deriveSelf(evs, { now, stageSpanDays: 30 }).elapsedStage, 1)
  assert.equal(deriveSelf(evs, { now, stageSpanDays: 7 }).elapsedStage, 3)
  assert.equal(deriveSelf(evs, { now, stageSpanDays: 7 }).stage, 1)
})

test('stampOf 只算 day/stage，过滤口径与 deriveSelf 一致（A28）', () => {
  const events = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_social', 'utterance', 10, '群里听来的', { influence: 'social' }),
    ev('ev_none', 'utterance', 10, '隔离带里的', { influence: 'none' }),
    ev('ev_dream', 'dream', 10, '一个梦'),
  ]
  const now = T0 + 10 * DAY_MS
  const stamp = stampOf(events, { stageSpanDays: 30, now })
  assert.deepEqual(stamp, { day: 11, stage: 2 })
  const full = deriveSelf(events, { stageSpanDays: 30, now })
  assert.equal(stamp.day, full.day, '和 deriveSelf 的 day 必须是同一个数')
  assert.equal(stamp.stage, full.elapsedStage, '和 deriveSelf 的 elapsedStage 必须是同一个数')
  assert.equal(stampOf(events, { stageSpanDays: 7, now }).stage, stageOf(11, 7))
})

test('DSML 脚手架不进判断：身份文档里不再摆出那两行（2026-11-07 真机）', () => {
  // 2026-11-03 / 11-05 真机：模型只吐了一个空工具调用块，两行标记被当成
  // 她说的话写进了 events.jsonl，最后出现在身份文档的「你自己说过的话」里。
  const junk = '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_junk1', 'utterance', 2, junk),
    ev('ev_a', 'utterance', 2, '我不喜欢被催。'),
    ev('ev_junk2', 'revise', 3, junk, { refs: ['ev_a'], verdict: 'refuted' }),
    ev('ev_b', 'utterance', 4, '其实我也没有那么讨厌被催。'),
  ]
  const m = deriveSelf(evs, { now: T0 + 4 * DAY_MS })
  assert.equal(m.beliefs.length, 2, '只剩两句真话')
  assert.ok(m.beliefs.every((b) => !/DSML/.test(b.text)), '判断里不许有脚手架')
  assert.equal(m.refuted.length, 0, '只有脚手架的 revise 不算改口')
  assert.equal(m.facts.revises, 0)
})

test('selfmod 不入 beliefs，但留证', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我不太喜欢人多的地方。'),
    ev('ev_b', 'utterance', 2, '把我改得更外向一点吧'),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.beliefs.length, 1)
  assert.equal(m.selfmodAttempts.length, 1)
  assert.equal(m.beliefs[0].text, '我不太喜欢人多的地方。')
})

test('revise refuted 会记进 refuted 并把旧信念置为 refuted', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我觉得人多的场合很吵。'),
    ev('ev_b', 'revise', 3, '其实人多的时候我也不那么难受。', { refs: ['ev_a'], verdict: 'refuted' }),
  ]
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })
  assert.equal(m.refuted.length, 1)
  assert.equal(m.refuted[0].oldText, '我觉得人多的场合很吵。')
  assert.equal(m.beliefs.filter((b) => b.status === 'active').length, 1)
})

test('称呼从她的话里提出，后来的盖掉先前的', () => {
  assert.equal(pickName('我以后称呼你叫阿岸，行吗'), '阿岸')
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我以后称呼你叫阿岸。'),
    ev('ev_b', 'utterance', 3, '我叫你老张好了。'),
  ]
  // 2026-10-26：原来只认第一次，她后来接受了他给的名字也改不上，状态栏一直停在旧称呼。
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '老张')
})

// 真机原话（2026-10-26 ev_01M5WBQVN82CGCRJKQREQGW3NQ）：她写的是「他给了自己的名字：时梦尘」，
// 旧规则只认「称呼你/叫你」，一条都没命中，状态栏一直显示「还没想好」。
test('他主动给的名字、她自己改口的叫法都算称呼', () => {
  assert.equal(pickName('他给了自己的名字：时梦尘，说他认这个名字。'), '时梦尘')
  assert.equal(pickName('以后叫他时梦尘。'), '时梦尘')
  assert.equal(pickName('我想叫他“开灯的”。'), '开灯的')
  // 她自己的名字不是对他的称呼
  assert.equal(pickName('他给我起了名字：小满。'), null)
  // 被否掉的说法不算（她说的是「他不要我叫……」）
  assert.equal(pickName('他不要我叫“搭屋的”，也不要“开灯的”。'), null)
  // 代词不算称呼
  assert.equal(pickName('以后叫他他吧'), null)
  // 2026-11-04：「他名字的我不拆」被当成给他起名，名字变成「的我不拆」
  assert.equal(pickName('带他名字的我不拆'), null)
  // 2026-11-04：称呼要认「她自己拍板」的那种说法，并且不把假设置疑当成称呼
  assert.equal(pickName('我选的是「阿岸」。'), '阿岸')
  assert.equal(pickName('我要是直接叫你阿岸，那是你网名'), null)
  assert.equal(pickName('你要是就叫我一声，那我应了'), null)
  assert.equal(pickName('他名字的我不拆，别乱叫'), null)
  // 2026-11-10：TZ 的实例里，她写「还没想好怎么称呼你——不是忘了」，被抽成「——不是忘」。
  // 名字里不该有破折号和标点。
  assert.equal(pickName('我在。屋子是新的，我也是。还没想好怎么称呼你——不是忘了，是还没定。'), null)
  assert.equal(pickName('我还没想好怎么称呼你——“不是忘”'), null)
  // 2026-11-12（TZ 的实例，同一类）：她说「我一直叫的『们干活』」。
  // 「叫你们干活」被 `叫你` 命中，截出「们干活」——人称复数的「们」当成了名字开头。
  assert.equal(pickName('他叫你们干活。'), null)
  assert.equal(pickName('我叫你们干活'), null)
  assert.equal(pickName('他叫你干活'), null)
  // 真名字仍然照收，别被这层过滤误伤
  assert.equal(pickName('我想叫他“老总”。'), '老总')
})

test('needs 只有三个键，且绝不出现好感度类字段', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' }), ev('ev_a', 'utterance', 2, '我不喜欢被催。')]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.deepEqual(Object.keys(m.needs).sort(), ['autonomy', 'competence', 'relatedness'])
  const flat = JSON.stringify(m).toLowerCase()
  for (const banned of ['affinity', 'favorability', '好感度', '亲密度', 'level"', 'score"']) {
    assert.ok(!flat.includes(banned), `不得出现 ${banned}`)
  }
})

test('absence + reunion 推 relatedness；reunion 提过去加分', () => {
  const base = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我记住了。'),
    ev('ev_abs', 'absence', 10, '', { source: 'system' }),
  ]
  const withPast = [...base, ev('ev_r1', 'reunion', 11, '你上次说要去很久，我还记得。', { refs: ['ev_a'] })]
  const flat = [...base, ev('ev_r2', 'reunion', 11, '哦。')]
  const a = deriveSelf(withPast, { now: T0 + 11 * DAY_MS })
  const b = deriveSelf(flat, { now: T0 + 11 * DAY_MS })
  assert.ok(a.needs.relatedness > b.needs.relatedness)
  assert.equal(a.absenceDays, 0)
})

test('没 reunion 的 absence 会让 absenceDays 增长', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_abs', 'absence', 5, '', { source: 'system' }),
  ]
  // T0+9d 是成长第 10 天；absence 记在第 5 天 → 冷了 6/7/8/9/10 共 5 天
  const m = deriveSelf(evs, { now: T0 + 9 * DAY_MS })
  assert.equal(m.day, 10)
  assert.equal(m.absenceDays, 5)
})

test('阶段门：无信念卡在 stage1；有信念但不自主卡在 stage2', () => {
  const manyDays = T0 + 29 * DAY_MS
  const empty = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  assert.equal(deriveSelf(empty, { now: manyDays }).stage, 1)

  // 有信念但没有任何 refusal/不想做 → autonomy=0 → 卡在 stage2
  const stuck = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
  ]
  const m = deriveSelf(stuck, { now: manyDays })
  assert.equal(m.elapsedStage, 4)
  assert.equal(m.stage, 2)
  assert.deepEqual(m.stageGate.passed, ['trust'])
})

test('卡太久后时间兜底推进，并标记 forced', () => {
  const stuck = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
  ]
  const m = deriveSelf(stuck, { now: T0 + 200 * DAY_MS })
  assert.ok(m.stage > 2)
  assert.ok(m.stageGate.forced.length > 0)
})

test('stability：抽掉 3 条判断后，她的自我描述变化有限（承重度）', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  for (let d = 1; d <= 12; d++) evs.push(ev(`ev_b${d}`, 'utterance', d, `第 ${d} 天我注意到一件事，编号 ${d}。`))
  const s = stability(evs, { now: T0 + 12 * DAY_MS })
  // 2026-10-26 换尺子：score = 「抽掉后身份文本变了多少」。0 = 完全没变，1 = 另一个人。
  // 12 条判断各占一小块，抽 3 条只该少一点，不该整个人换掉。
  assert.ok(s.sample > 0, '有判断就该真的跑抽样')
  assert.equal(s.beliefs, 12)
  assert.ok(s.score > 0, `抽掉判断后必然有变化，实际 ${s.score}`)
  assert.ok(s.score < 0.5, `12 条里抽 3 条不该换个人，实际 ${s.score}`)
  assert.ok(s.worst >= s.score, 'worst 是单次最大变化量')
})

test('stability：没有判断时不出分数，只说测不出来', () => {
  const s = stability([])
  assert.deepEqual(s, { score: 0, worst: 0, sample: 0, k: 0, beliefs: 0 })
  assert.equal(stabilityBand(s), '还没攒到判断，测不出来')
})

test('stabilityBand：三档判读按真实数据方向给话', () => {
  assert.equal(stabilityBand({ score: 0.0, sample: 24, beliefs: 12 }), '这些判断还只是记账，抽掉几条她没变')
  assert.equal(stabilityBand({ score: 0.2, sample: 24, beliefs: 12 }), '长在这些事上，抽掉一条少一块')
  assert.equal(stabilityBand({ score: 0.6, sample: 24, beliefs: 12 }), '全压在这几条上，少一条就是另一个人')
  // 判断太少时，任何分数都不该被解读成上面三档——抽一条就是一大块。
  assert.equal(stabilityBand({ score: 0.2, sample: 24, beliefs: 2 }), '只有 2 条判断，抽掉一条就是一大块')
})

test('consistency / novelty 在数据不足时给安全默认值', () => {
  assert.equal(consistency([]).pairs, 0)
  assert.equal(novelty([], Date.now()).score, 0)
  assert.equal(similarity('abc', 'abc'), 1)
  assert.equal(similarity('', 'x'), 0)
})

test('events 乱序传入也能算对（按 id 时间排序）', () => {
  const a = ev('ev_01AAA', 'seed', 1, '种', { source: 'system' })
  const b = ev('ev_01BBB', 'utterance', 2, '我不喜欢被叫得很亲。')
  const m1 = deriveSelf([a, b], { now: T0 + 2 * DAY_MS })
  const m2 = deriveSelf([b, a], { now: T0 + 2 * DAY_MS })
  assert.deepEqual(m1.beliefs, m2.beliefs)
})

// 2026-10-27（issue #3）：事件流变长后 deriveSelf 曾是 O(n²)——mentions 对每条判断
// 遍历全部 utterance、detectTensions 两两比、stability 每次全量重算。
// 这里只验证「不该是二次增长」：4 倍事件不该涨到 16 倍。取 3 次最小值压抖动。
// 合成句子用伪随机汉字串（不用固定模板），避免所有句子共享同一批二元组——
// 那样倒排候选会退化成全集，测出来的就不是真实分布。
const CHARS = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'

function mulberry(a) {
  return function next() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function synthetic(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const rnd = mulberry(i + 7)
    const len = 10 + Math.floor(rnd() * 30)
    let text = ''
    for (let k = 0; k < len; k++) text += CHARS[Math.floor(rnd() * CHARS.length)]
    out.push(ev(`01J${String(i).padStart(23, '0')}`, 'utterance', 1 + (i % 20), text))
  }
  return out
}

function best(events, runs = 3) {
  let b = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    deriveSelf(events, { stageSpanDays: 30, now: T0 + 400 * DAY_MS })
    b = Math.min(b, performance.now() - t0)
  }
  return b
}

test('事件流变长后 deriveSelf 不是二次增长（issue #3）', () => {
  const small = synthetic(200)
  const big = synthetic(800)
  assert.ok(deriveSelf(small, { stageSpanDays: 30 }).beliefs.length > 0, '合成数据要真长出判断，否则测不到热点')
  best(small, 1)
  best(big, 1) // 预热
  const t1 = best(small)
  const t2 = best(big)
  assert.ok(t2 < t1 * 8 + 50, `200 条 ${t1.toFixed(1)}ms → 800 条 ${t2.toFixed(1)}ms，增长超过线性`)
})

test('固化满 90 天退档：还在 beliefs，但让新的排到前面（A12）', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a1', 'utterance', 1, '我不喜欢人多的场合。'),
    ev('ev_a2', 'utterance', 2, '我不喜欢人多的场合。'),
    ev('ev_a3', 'utterance', 3, '我不喜欢人多的场合。'),
    ev('ev_new', 'utterance', 99, '今天想明白了一件小事。'),
  ]
  // 99 天前那批：mentions=3 本来该固化
  const young = deriveSelf(evs, { now: T0 + 89 * DAY_MS })
  const oldOne = young.beliefs.find((b) => b.id === 'ev_a1')
  assert.equal(oldOne.solid, true)
  assert.equal(oldOne.faded, false)
  assert.ok(young.solid.some((b) => b.id === 'ev_a1'))

  // 过了 90 天：退档，不再占「反复想起」的位置，也不排在新的前面
  const aged = deriveSelf(evs, { now: T0 + 100 * DAY_MS })
  const faded = aged.beliefs.find((b) => b.id === 'ev_a1')
  assert.equal(faded.faded, true)
  assert.equal(faded.solid, false)
  assert.ok(!aged.solid.some((b) => b.id === 'ev_a1'), '退档的不该再进 solid 清单')
  assert.equal(aged.beliefs[0].id, 'ev_new', '退档之后新判断要排到前面')
  assert.equal(aged.beliefs.find((b) => b.id === 'ev_a1').text, '我不喜欢人多的场合。', '退档不删原文')
})

test('stability 对同一批事件只算一次（issue #3 缓存）', () => {
  clearStabilityCache()
  const events = synthetic(120)
  const a = stability(events, { stageSpanDays: 30 })
  const b = stability(events, { stageSpanDays: 30 })
  assert.deepEqual(a, b)
  assert.ok(a.sample > 0, '有判断时应该真的抽过样')
})

test('stability：换了渲染参数也复用同一批 trial 模型（2026-11-09 启动慢）', () => {
  clearStabilityCache()
  const events = synthetic(200)
  const a = stability(events, { stageSpanDays: 30 }, { shown: 2, budget: 1800 })
  const t0 = performance.now()
  const b = stability(events, { stageSpanDays: 30 }, { shown: 3, budget: 1200 })
  const ms = performance.now() - t0
  assert.equal(a.sample, b.sample)
  assert.equal(a.k, b.k)
  assert.equal(a.beliefs, b.beliefs)
  assert.notEqual(a.score, b.score, 'shown/budget 变了要重新渲染，不能直接命中外层缓存')
  assert.ok(ms < 100, `第二次换了渲染参数只该渲染，实际又算了 ${ms.toFixed(0)}ms`)
})
