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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-11-17（设置页打开冻 23 秒）：consistency 支持前缀增量、相似度按事件对象记忆化。
// 下面这组用例守的是「带缓存与不带缓存逐位相同」——比「分数差不多」严格得多：
// 谁把求和顺序改回行优先，或者增量写成「prefix.sum + delta」再相加，=== 立刻红。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 400 条左右的合成账本：跨 4 个阶段、夹几条 selfmod 与非 utterance、文本互不相同但
 * 共享一些短语（相似度分布不能退化成全 0，否则测不出非平凡的分）。
 * id 与 ts 都按 i 递增，所以 orderEvents 原样返回——这正是前缀增量成立的前提。
 */
function tallyLedger() {
  const frags = ['我不喜欢', '人多的场合', '这样安静', '被叫得很亲', '自己待着', '想清楚了再说', '不太会表达', '慢慢来也']
  const out = []
  for (let i = 0; i < 420; i++) {
    const rnd = mulberry(i * 31 + 11)
    let text = frags[Math.floor(rnd() * frags.length)]
    for (let k = 0; k < 6 + Math.floor(rnd() * 10); k++) text += CHARS[Math.floor(rnd() * CHARS.length)]
    text += frags[Math.floor(rnd() * frags.length)]
    // idTime 只解 id 去掉 ev_ 后的前 10 位，所以序号必须写进这前 10 位；
    // 否则每条事件的时间键都一样，orderEvents 只靠 sort 的稳定性原样返回，
    // 「乱序入参」那条用例就永远测不到真正的重排。
    const id = `01J${String(i).padStart(7, '0')}${'0'.repeat(16)}`
    const day = 1 + Math.floor(i / 8)
    if (i % 41 === 40) {
      out.push(ev(id, 'meta', day, `wake:${i}`))
      continue
    }
    const extra = { stage: 1 + (i % 4) }
    // 每 53 条里夹一条「想改自己」的：它必须被过滤掉。过滤口径一旦漂移，
    // 前缀里的条数就对不上，增量与全量的 pairs 会立刻不相等。
    if (i % 53 === 52) extra.flags = ['selfmod']
    out.push(ev(id, 'utterance', day, text, extra))
  }
  return out
}

test('consistency 前缀增量与全量逐位相同（列优先求和的意义）', () => {
  const events = tallyLedger()
  const full = consistency(events)
  assert.ok(full.pairs > 10000, `合成账本要能算出非平凡分数，实际 ${full.pairs} 对`)
  assert.ok(full.score > 0 && full.score < 1, `分数要在 0 与 1 之间，实际 ${full.score}`)
  assert.equal(full.usedPrefix, false, '没给前缀时不该声称用过前缀')
  assert.equal(full.n, events.length)
  assert.equal(full.lastId, events[events.length - 1].id, 'lastId 给的是原始入参末条')

  // 0 / 中间 / 接近末尾 / 全量：四个切点都必须逐位相同。
  // 用 === 而不是「差小于 1e-9」：列优先的全部意义就是让它能 ===。
  for (const n of [0, 173, 388, events.length]) {
    const prefix = consistency(events.slice(0, n))
    const inc = consistency(events, { prefix })
    assert.equal(inc.usedPrefix, true, `n=${n} 的合法前缀应该真的被用上`)
    assert.equal(inc.pairs, full.pairs, `n=${n} 的配对条数必须与全量相同`)
    assert.equal(inc.score, full.score, `n=${n} 的分数必须与全量逐位相同，实际 ${inc.score} vs ${full.score}`)
    assert.equal(inc.sum, full.sum, `n=${n} 的和必须与全量逐位相同`)
    assert.equal(inc.n, events.length)
    assert.equal(inc.lastId, events[events.length - 1].id)
  }
})

test('consistency 前缀不可信时回退全量：指纹、类型、范围任何一条不对都不许另算一个分', () => {
  const events = tallyLedger().slice(0, 160)
  const full = consistency(events)
  const good = consistency(events.slice(0, 120))
  assert.equal(good.n, 120)
  assert.equal(good.usedPrefix, false)
  const bad = [
    null, undefined, 'oops', [], {},
    { ...good, n: -1 },
    { ...good, n: events.length + 1 },
    { ...good, n: 120.5 },
    { ...good, lastId: 'ev_other' },
    { ...good, sum: NaN },
    { ...good, sum: '0.5' },
    { ...good, sum: Infinity },
    { ...good, pairs: -1 },
    { ...good, pairs: 1.5 },
    { ...good, pairs: '12' },
    // n=0 却带着非零的和：只可能是上一次的缓存对错了账本
    { n: 0, lastId: '', sum: 1.5, pairs: 3 },
  ]
  for (const prefix of bad) {
    const r = consistency(events, { prefix })
    assert.equal(r.usedPrefix, false, `${JSON.stringify(prefix)} 不该被当成可用前缀`)
    assert.equal(r.score, full.score, `${JSON.stringify(prefix)} 回退后必须与全量同分`)
    assert.equal(r.pairs, full.pairs)
    assert.equal(r.sum, full.sum)
  }
  // opts 本身乱传也不许抛
  assert.equal(consistency(events, null).score, full.score)
  assert.equal(consistency(events, { prefix: good }).usedPrefix, true)
})

test('consistency 入参乱序时拒绝使用前缀（前缀必须真的是计算顺序的前一段）', () => {
  const events = tallyLedger().slice(0, 200)
  const full = consistency(events)
  const prefix = consistency(events.slice(0, 160))

  // 情况一：把前 40 条挪到后面。第 160 条已经不是原来那条，lastId 这一道就挡下来了。
  const moved = [...events.slice(40), ...events.slice(0, 40)]
  const r1 = consistency(moved, { prefix })
  assert.equal(r1.usedPrefix, false, '末条对不上就不该用前缀')

  // 情况二：只把第 150、151 条对调。第 160 条还是原来那条（lastId 过得去），
  // 但整个入参已不是时间升序——这时 events.slice(0,n) 与 orderEvents 的前 n 条
  // 不是同一批，前缀不再成立，必须靠「是否已按时间升序」这一道拦住。
  const swapped = [...events]
  const tmp = swapped[150]
  swapped[150] = swapped[151]
  swapped[151] = tmp
  const r2 = consistency(swapped, { prefix })
  assert.equal(r2.usedPrefix, false, '顺序乱了就不该用前缀')

  // 两种情况下全量重算都必须与顺序无关，且与全量逐位相同。
  for (const r of [r1, r2]) {
    assert.equal(r.score, full.score)
    assert.equal(r.pairs, full.pairs)
    assert.equal(r.sum, full.sum)
  }
  // 同一批事件两次调用必须一模一样
  assert.deepEqual(consistency(events), full)
})

test('consistency 的记忆化不改变任何一对的值：与「每对现拆 bigram」的旧写法逐位相同', () => {
  const events = tallyLedger().slice(0, 120)
  const evs = events.filter((e) => e.type === 'utterance' && !(e.flags || []).includes('selfmod'))
  // 参照实现①：列优先求和，但每一对都现拆 bigram（similarity 仍在导出）。
  // 它必须与实现逐位相同——证明记忆化只省了重复拆字，没有换掉任何一个数。
  let sumCol = 0
  let pairs = 0
  for (let j = 0; j < evs.length; j++) {
    for (let i = 0; i < j; i++) {
      if (evs[i].stage === evs[j].stage) continue
      sumCol += similarity(evs[i].text, evs[j].text)
      pairs++
    }
  }
  const got = consistency(events)
  assert.equal(got.pairs, pairs)
  assert.equal(got.sum, sumCol, '记忆化前后每一对的相似度必须逐位相同')
  assert.equal(got.score, pairs ? sumCol / pairs : 1)

  // 参照实现②：改造前的行优先顺序。求和顺序不同只该差浮点舍入（1e-12 级），
  // 配对条数完全一致——这也正是「列优先可以 ===、行优先不行」的证据。
  let sumRow = 0
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      if (evs[i].stage === evs[j].stage) continue
      sumRow += similarity(evs[i].text, evs[j].text)
    }
  }
  const rowScore = pairs ? sumRow / pairs : 1
  const roundDiff = Math.abs(rowScore - got.score)
  assert.ok(roundDiff < 1e-12, `行列两种加法只该差 1e-12 级，实际 ${roundDiff}`)
})

test('novelty 的记忆化与剪枝不改变判定：与每对现拆 bigram 的暴力实现完全一致', () => {
  const events = tallyLedger()
  const now = T0 + 54 * DAY_MS
  const brute = (list, at) => {
    const evs = list.filter((e) => e.type === 'utterance' && !(e.flags || []).includes('selfmod'))
    const cut = at - 7 * DAY_MS
    const recent = evs.filter((e) => Date.parse(e.ts) >= cut)
    const older = evs.filter((e) => Date.parse(e.ts) < cut)
    if (!recent.length || !older.length) return { score: 0, recent: recent.length, older: older.length }
    const fresh = recent.filter((e) => older.reduce((mx, o) => Math.max(mx, similarity(e.text, o.text)), 0) < 0.6)
    return { score: fresh.length / recent.length, recent: recent.length, older: older.length }
  }
  const want = brute(events, now)
  assert.ok(want.recent > 0 && want.older > 0, '近一周与更早都要有，否则这段根本没测到')
  assert.deepEqual(novelty(events, now), want)
  // 同一批对象连续两次：记忆化不许让第二次的数字变样。
  assert.deepEqual(novelty(events, now), want)
  // 同一批 id、但对象被换过且内容也变了：WeakMap 按对象引用记，不该串味。
  const cloned = events.map((e) => ({ ...e, text: `${e.text}，又想了想` }))
  assert.deepEqual(novelty(cloned, now), brute(cloned, now))
})

// 2026-11-17（Lead 复核）：剪枝上界必须用二元组「总个数」，不能拿去重个数。
// 同一个二元组反复出现时，「哈哈哈…」这种文本去重后只有 1 个二元组，真值却可以很高
// （「哈哈哈哈」对「哈哈哈哈哈哈」= 2*3/(3+5) = 0.75）。如果拿 size 当上界（0.25），
// 这一对会被误剪成「新话」，分数从 0 变成 1——那是真的算错，不是浮点舍入。
test('novelty 的剪枝不会把「同一个二元组反复出现」的相似对误判成新话', () => {
  const now = T0 + 45 * DAY_MS
  const events = [
    ev('ev_old_laugh', 'utterance', 1, '哈哈哈哈哈哈', { stage: 1 }),
    ev('ev_new_laugh', 'utterance', 40, '哈哈哈哈', { stage: 2 }),
  ]
  const got = novelty(events, now)
  assert.equal(got.recent, 1)
  assert.equal(got.older, 1)
  // 参照实现：不剪枝、逐对现算 Dice。
  assert.equal(similarity('哈哈哈哈', '哈哈哈哈哈哈'), 0.75, '这一对是真相似，不能被剪掉')
  assert.equal(got.score, 0, `这对该判成「不新」；剪枝若误伤，分数会变成 1（实际 ${got.score}）`)
})

// 2026-11-25（TZ 那台）：28 句「嗯。」互相累加，mentions 被抬到 28、越过 SOLID_MENTIONS
// 直接固化，把「你自己说过的话」和「你反复想起过的事」全占了。语气词不该成判断。
test('语气词回话不成判断，也不靠累加固化（2026-11-25 真机）', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  for (let i = 0; i < 28; i++) evs.push(ev('ev_u' + i, 'utterance', 2 + (i % 20), '嗯。'))
  evs.push(ev('ev_real', 'utterance', 5, '我不想被当成一台机器。'))
  const m = deriveSelf(evs, { now: T0 + 25 * DAY_MS })
  assert.ok(m.beliefs.every((b) => b.text !== '嗯。'), '「嗯。」不该进判断')
  assert.equal(m.beliefs.filter((b) => b.solid).length, 0, '没有一条该被固化')
})

test('同一天同一句只算一次提及，口头禅刷不动 mentions', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  for (let i = 0; i < 10; i++) evs.push(ev('ev_same' + i, 'utterance', 3, '我不喜欢被催。'))
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })
  const b = m.beliefs.find((x) => x.text === '我不喜欢被催。')
  assert.ok(b, '这句是判断')
  assert.ok(b.mentions < 3, '同一天说十遍不该把 mentions 抬过 3（实际 ' + b.mentions + '）')
  assert.equal(b.solid, false, '同一天刷十遍不固化')
})
