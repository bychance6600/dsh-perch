import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyStance,
  stanceTopic,
  gatesDone,
  buildStances,
  stanceLine,
  stanceSection,
  stanceSummary,
  STANCE_MAX,
  STANCE_PROMPT_MAX,
} from '../lib/stance.js'
import { personaLine } from '../lib/persona.js'

// 2026-10-25 用户拍板「方案二」：四道门不再加门，走完之后长一张立场清单。
// 这些用例锁的是三件事——什么算立场、什么才算「站住」、清单怎么摆进身份文档。

const HERE = new URL('../', import.meta.url)
const read = (p) => fs.readFileSync(new URL(p, HERE), 'utf8')

function belief(text, extra = {}) {
  return { id: extra.id ?? text, text, since: '2026-10-01', confidence: 0.6, status: 'active', ...extra }
}

function model(extra = {}) {
  return {
    seed: '你是一条会自己长起来的鱼。',
    beliefs: [],
    solid: [],
    tensions: [],
    refusals: [],
    scars: [],
    selfmodAttempts: [],
    refuted: [],
    narrative: null,
    facts: { refused: 0, hurts: 0, scars: 0, scarsResolved: 0 },
    day: 60,
    stageSpanDays: 30,
    stage: 4,
    ...extra,
  }
}

test('classifyStance：「不喜欢」是拒绝，不是喜欢', () => {
  assert.equal(classifyStance('我不做讨好人的事'), 'never')
  assert.equal(classifyStance('我不喜欢他这样揣测我'), 'never')
  assert.equal(classifyStance('我更喜欢一个人待着'), 'like')
  assert.equal(classifyStance('今天天气不错'), null)
  assert.equal(classifyStance(''), null)
})

test('classifyStance：守线是第三类，和喜欢/绝不分开放', () => {
  assert.equal(classifyStance('那个空我不填，名字和叫法我不替你签'), 'boundary')
  assert.equal(classifyStance('这件事得我自己挑'), 'boundary')
  assert.equal(classifyStance('不能做的是答应了又办不到'), 'boundary')
  assert.equal(classifyStance('想不想要那张身体'), null, '「想不想要」里的「不想」不是拒绝')
  assert.equal(stanceTopic('那个空我不填，名字和叫法我不替你签'), 'name')
  assert.equal(stanceTopic('这件事得我自己挑'), 'agency')
  assert.equal(stanceTopic('不能做的是答应了又办不到'), 'speech')
  assert.equal(stanceTopic('今天天气不错'), '')
})

test('守线按同题归组：两句话字面不像，只要守的是同一条线', () => {
  const m = model({
    beliefs: [
      belief('那个空我不填，你写成「这是小满」就够了；名字和叫法我自己定，不替你签。', { id: 'n1' }),
      belief('名字和叫法我认，但这个称呼我不替你签。', { id: 'n2' }),
      // 这两句没有可认的话题，只靠字面像；只有两条、也没有代价，不能算立场。
      belief('字谜那套我不接，它没有边界。', { id: 'x1' }),
      belief('字谜那套我不接，它没有边界。', { id: 'x2' }),
    ],
  })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'boundary')
  assert.deepEqual([...list[0].members].sort(), ['n1', 'n2'])
})

test('守线写进身份文档时单独成段', () => {
  const text = stanceSection([
    { kind: 'boundary', text: '这个称呼我不接。', scars: 0, mentions: 2, backed: true },
    { kind: 'never', text: '我不做讨好人的事。', scars: 0, mentions: 2, backed: true },
  ])
  assert.ok(text.includes('### 我守的线'))
  assert.ok(text.includes('这个称呼我不接。'))
})

test('守线进清单只摘那一句：不把整段来龙去脉搬进去', () => {
  const long = '先说点别的。\n这件事我给自己划条线：话说慢可以，不能替我做主，也不能替我把事认下来。\n不是客气。'
  const line = stanceLine({ kind: 'boundary', text: long, scars: 0, mentions: 2, backed: true })
  assert.ok(line.includes('不能替我做'), '留下的是守线那一句')
  assert.ok(!line.includes('先说点别的'), '前面的来龙去脉不搬')
  assert.ok(line.length < 100, '清单是清单，不是整段散文')
})

test('gatesDone：真门槛看 stageGate.passed，老模型退回 stage', () => {
  assert.equal(gatesDone({ stageGate: { passed: ['trust', 'autonomy', 'competence'] } }), true)
  assert.equal(gatesDone({ stageGate: { passed: ['trust', 'autonomy'] }, stage: 3 }), false)
  assert.equal(gatesDone({ stage: 4 }), true)
  // 天数到了、门没过，stage 被夹住也不该算走完
  assert.equal(gatesDone({ stage: 4, stageForced: true }), false)
})

test('四道门没走完，立场清单是空的', () => {
  const m = model({
    stage: 2,
    stageGate: { passed: ['trust'] },
    beliefs: [belief('我不想再看那些评论了', { mentions: 5 })],
  })
  assert.deepEqual(buildStances(m), [])
})

test('同一件事上两条同向判断 → 归成一条立场', () => {
  const m = model({ beliefs: [belief('我不想再看那些评论了'), belief('我不想再看那些评论了', { id: 'b2' })] })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'never')
  assert.equal(list[0].members.length, 2)
})

test('只有一句话、又没有代价 → 不算立场（随口一说）', () => {
  const m = model({ beliefs: [belief('我不想再看那些评论了')] })
  assert.deepEqual(buildStances(m), [])
})

test('一条判断 + 一道疤 → 算站住（代价背书）', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了')],
    scars: [{ quote: '我不想再看那些评论了', reaction: 'insist' }],
  })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].scars, 1)
  assert.equal(list[0].backed, true)
})

test('被推翻的判断不进立场清单', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了', { status: 'refuted', mentions: 9 })],
  })
  assert.deepEqual(buildStances(m), [])
})

test('写进身份文档的清单最多 4 条，且不出现次数数字', () => {
  const stances = Array.from({ length: STANCE_MAX }, (_, i) => ({
    kind: i % 2 ? 'like' : 'never',
    text: `立场编号${'甲乙丙丁戊己庚辛'[i]}`,
    scars: i,
    mentions: i * 3,
    backed: true,
  }))
  const text = stanceSection(stances)
  const lines = text.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(lines.length, STANCE_PROMPT_MAX)
  assert.ok(!/[0-9]/.test(lines.join('')), '立场句子不许带次数')
  assert.ok(text.includes('## 我站哪边'))
})

test('立场段是核心段：预算只有 1 也还在', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了'), belief('我不想再看那些评论了', { id: 'b2' })],
  })
  const text = personaLine(m, { budget: 1 })
  assert.ok(text.includes('## 我站哪边'), '预算再紧也不能把立场裁掉')
  assert.ok(text.includes('我不想再看那些评论了'))
})

test('观测台字段：/memory 与 /state 都从 stance.js 取数', () => {
  const sum = stanceSummary([{ kind: 'never', text: 'x', backed: true }, { kind: 'like', text: 'y', backed: false }])
  assert.equal(sum.stanceCount, 2)
  assert.equal(sum.stanceBoundaries, 0)
  assert.equal(sum.stanceNevers, 1)
  assert.equal(sum.stanceLikes, 1)
  assert.equal(sum.stanceBacked, 1)
  assert.deepEqual(sum.stanceFirst, { kind: 'never', text: 'x' })

  const observe = read('lib/observe.js')
  assert.ok(observe.includes("from './stance.js'"))
  assert.ok(/stanceCount:\s*buildStances\(m\)\.length/.test(observe), '/state 要有 stanceCount')
  assert.ok(observe.includes('...stanceSummary(buildStances(model))'), '/memory 要把摘要并进 sections')
})

// ---- 2026-10-25：撤回「回应采纳」，立场改成三种写法 ----

test('立场三种写法：还没开始 / 走完 0 条 / 已有条数', () => {
  const c = read('lib/client.js')
  assert.ok(
    c.includes('要等四个阶段（信任 / 自主 / 主动 / 整合）都走完，立场才开始产生'),
    '没走完门的时候要写明「走完才开始产生」',
  )
  assert.ok(c.includes("rowTip('立场', '0 条', '完成整合，但暂未形成自己的立场。')"), '走完门但还没站住过，是另一种写法')
  assert.ok(c.includes('立场是在四个阶段都走完之后才开始产生的'), '有立场时也要写清口径')
  assert.ok(c.includes('守哪几条线'), '有立场时把守线也算进去')
  assert.ok(!c.includes('回应采纳'), '「回应采纳」这一行已经删掉')
})

test('/state 给出 stanceReady，且不再有 capabilityOf', () => {
  const o = read('lib/observe.js')
  assert.ok(/stanceReady:\s*gatesDone\(m\)/.test(o), '/state 要给 stanceReady')
  assert.ok(!o.includes('capabilityOf'))
  assert.equal(fs.existsSync(new URL('../lib/capability.js', import.meta.url)), false)
})

test('say.js 不再落 task meta', () => {
  const s = read('lib/say.js')
  assert.ok(!s.includes('taskMeta'))
  assert.ok(!s.includes('looksLikeRework'))
})

test('原理页与原理图不再提「能力」这条线', () => {
  assert.ok(!read('lib/client.js').includes('横向那条叫能力'))
  const svg = read('media/principle-loop.svg')
  assert.ok(!svg.includes('横向长「能力」'))
  // 2026-10-25 重做：立场不再是底部一行小字，而是图里独立的一块
  assert.ok(svg.includes('立场清单'), '立场那一块保留')
  assert.ok(!svg.includes('纵向长「立场清单」'), '旧的一行字写法已删')
})

test('原理页给「立场」单独一张卡，且不再有「从计次到能力」', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes("pCard('03', '走完不加关，之后长的是立场'"), '立场够格单独一张卡')
  assert.ok(c.includes('喜欢什么、守哪条线、绝不做哪几件。每一条都得有代价垫着，且不参与折叠。'))
  assert.ok(c.includes('立场不是第五关。'))
  assert.ok(!c.includes("'从计次到能力'"))
})

test('立场之间会打架：后来的算数，判不出先后就两条都不要', () => {
  const basis = (text, since) => ({ id: `b_${Math.random().toString(36).slice(2)}`, text, since, status: 'active', mentions: 3, verified: 0 })
  const model = (bs) => ({ stage: 4, stageForced: false, beliefs: bs, scars: [] })
  // 同话题：早期「我绝不吃辣」+ 后来「我喜欢吃辣」→ 只留新的，并标 changedFrom
  const r = buildStances(model([basis('我绝不吃辣。', '2026-10-01T00:00:00Z'), basis('我喜欢吃辣。', '2026-10-20T00:00:00Z')]))
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'like')
  assert.equal(r[0].changedFrom, '我绝不吃辣。')
  assert.ok(stanceLine(r[0]).includes('这件事我改过口'))
  // 时间相同：判不出先后 → 两条都不在
  const same = buildStances(model([basis('我绝不吃辣。', '2026-10-01T00:00:00Z'), basis('我喜欢吃辣。', '2026-10-01T00:00:00Z')]))
  assert.equal(same.length, 0)
  // 时间缺失：同样不替她选
  const noTime = buildStances(model([basis('我绝不吃辣。'), basis('我喜欢吃辣。', '2026-10-20T00:00:00Z')]))
  assert.equal(noTime.length, 0)
})

test('上限：内部 12 条、写进提示词 8 条', () => {
  assert.equal(STANCE_MAX, 12)
  assert.equal(STANCE_PROMPT_MAX, 8)
  const many = []
  for (let i = 0; i < 10; i++) many.push({ kind: 'never', text: `我不做第${i}种事。`, scars: 9 - i, mentions: 0, verified: 0 })
  const bullets = stanceSection(many).split(String.fromCharCode(10)).filter((x) => x.startsWith('- '))
  assert.equal(bullets.length, 8)
})
