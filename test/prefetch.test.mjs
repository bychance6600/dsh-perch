/**
 * prefetch.test.mjs —— 0.5.0 M1 唤醒预取（issue #20）的守门测试
 * 守四件事：只在四种「要用到过去」的轮次预取、纸条优先、≤3 条且 ≤300 tokens、缓存按 mtime+size 失效。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { prefetchFor, prefetchTriggers, estimateTokens, PREFETCH_MAX, PREFETCH_TOKENS, PREFETCH_CHARS } from '../lib/prefetch.js'
import { readEventsCached } from '../lib/recall.js'
import { appendEvent } from '../lib/store.js'
import {
  HOST_PERSONA_SECTION,
  IDENTITY_SECTION,
  PREFETCH_SECTION,
  TOOLS_SECTION,
  WAKE_SECTION,
  attachAssembleFix,
  clearWakeSection,
  setWakeSection,
} from '../lib/identity.js'
import {
  beginExternalTurn,
  clearExternalHeard,
  endExternalTurn,
  setExternalHeard,
  _resetExternalTurn,
} from '../lib/extturn.js'
import { PROACTIVE_TRIGGER } from '../lib/proactive.js'

const NOW = Date.parse('2026-11-27T12:00:00+08:00')
async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fish-prefetch-'))
}

async function seed(root, type, text) {
  return appendEvent({ type, text }, { day: 1, stage: 1, source: 'tool' }, root)
}

test('prefetch：四种触发各认各的，无关的一轮不触发', () => {
  assert.deepEqual(prefetchTriggers('你还记得那次在群里叫我姐姐吗'), ['past'])
  assert.deepEqual(prefetchTriggers('小满昨天说的那件事'), ['entity'])
  assert.deepEqual(prefetchTriggers('你不是认姐姐了吗，还叫过'), ['correction'])
  assert.deepEqual(prefetchTriggers('那你愿意叫姐姐吗'), ['growth'])
  for (const text of ['今天天气不错', '在吗', '']) assert.deepEqual(prefetchTriggers(text), [])
})

test('prefetch：跟过去无关的一轮不查账本', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '今天天气不错，我出去走了走。')
  assert.equal(await prefetchFor(root, '今天天气不错', { now: NOW, names: [] }), null)
  assert.equal(await prefetchFor(root, '在吗', { now: NOW, names: [] }), null)
  assert.equal(await prefetchFor(root, '', { now: NOW, names: [] }), null)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：纸条有相关项就不翻账本', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '他上次说想换工作，我记着呢。')
  await fs.writeFile(path.join(root, 'notes.json'), JSON.stringify({ notes: [{ id: 'n_ab12', text: '明天问问他工作怎么样', at: NOW }] }), 'utf8')
  const hit = await prefetchFor(root, '你工作怎么样了，上次说的那个还记得吗', { now: NOW, names: [] })
  assert.ok(hit)
  assert.equal(hit.source, 'notes')
  assert.match(hit.text, /纸上记着：明天问问他工作怎么样（n_ab12）/)
  assert.doesNotMatch(hit.text, /他上次说想换工作/)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：纸条只沾一个常见字眼不算相关，改查账本', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '11-23 那晚先拿草稿档跑一张炸蘑菇，不验画质，只看它能不能让我看懂那盘菜——所以得看了才算数。')
  // 纸条只跟这句话共一个「说的」，不是纸上写着这件事（2026-11-27 真机回放）
  await fs.writeFile(path.join(root, 'notes.json'), JSON.stringify({ notes: [{ id: 'n_w0', text: '他说过的规矩都记着', at: NOW }] }), 'utf8')
  const hit = await prefetchFor(root, '我们说的那句「看了才算数」，你后来验了没', { now: NOW, names: [] })
  assert.ok(hit, '要能查账本')
  assert.equal(hit.source, 'ledger')
  assert.match(hit.text, /看了才算数/)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：账本最多 3 条、每条带 id、同 query 稳定，且不超字数和 token', async () => {
  const root = await tmpRoot()
  for (let i = 1; i <= 5; i += 1) await seed(root, 'utterance', `我上次在群里叫她姐姐，第 ${i} 次。`)
  const heard = '你还记得上次在群里叫我姐姐吗'
  const a = await prefetchFor(root, heard, { now: NOW, names: [] })
  assert.ok(a)
  assert.equal(a.source, 'ledger')
  assert.ok(a.count <= PREFETCH_MAX)
  assert.equal(a.items.length, a.count)
  for (const item of a.items) {
    assert.match(item.id, /^ev_/)
    assert.ok(item.line.includes(item.id))
  }
  assert.ok(a.text.length <= PREFETCH_CHARS)
  assert.ok(a.tokens <= PREFETCH_TOKENS)
  assert.equal((a.text.match(/（可能相关）/g) ?? []).length, 1, '最多标一条「可能相关」')
  assert.equal((await prefetchFor(root, heard, { now: NOW, names: [] })).text, a.text, '固定 now 不许抖')
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：超预算就少带几条，绝不超字数', async () => {
  const root = await tmpRoot()
  for (let i = 1; i <= 5; i += 1) await seed(root, 'utterance', `${'上次那件事我记了很久。'.repeat(10)}（第 ${i} 条）`)
  const hit = await prefetchFor(root, '你还记得上次那件事吗', { now: NOW, names: [], maxTokens: 60 })
  if (hit) {
    assert.ok(hit.tokens <= 60)
    assert.ok(hit.text.length <= PREFETCH_CHARS)
  }
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：成长判断优先她自己的判断与承诺', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '我愿意叫姐姐。')
  await seed(root, 'refusal', '我不想叫姐姐。')
  const hit = await prefetchFor(root, '那你愿意叫姐姐吗', { now: NOW, names: [] })
  assert.ok(hit)
  assert.match(hit.text.split('\n')[1], /她(说过|拒绝过|改口)/)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：她认识的人名也算「话里有专有名词」', async () => {
  const root = await tmpRoot()
  await seed(root, 'utterance', '小满说那件事先放着。')
  assert.equal(await prefetchFor(root, '小满说的那件事', { now: NOW, names: [] }), null)
  assert.ok(await prefetchFor(root, '小满说的那件事', { now: NOW, names: ['小满'] }))
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：账本缓存按 mtime+size 失效', async () => {
  const root = await tmpRoot()
  const a = await readEventsCached(root)
  assert.equal(a.cached, false)
  assert.equal(a.events.length, 0)
  await seed(root, 'utterance', '一句话。')
  const b = await readEventsCached(root)
  assert.equal(b.cached, false, '账本变了要重读')
  assert.equal(b.events.length, 1)
  const c = await readEventsCached(root)
  assert.equal(c.cached, true, '没变要命中缓存')
  await seed(root, 'utterance', '又一句。')
  const d = await readEventsCached(root)
  assert.equal(d.cached, false)
  assert.equal(d.events.length, 2)
  await fs.rm(root, { recursive: true, force: true })
})

test('prefetch：token 估算把中文与英文分开算', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('姐姐'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('姐姐abcd'), 3)
})

// ---- 团队卡 #7（issue #7）：预取从渠道层搬到组装层，一处注入、所有入口覆盖 ----
//
// 假宿主只做两件事：`ctx.on` 收钩子；按真机的顺序先 emit `agent/inbox/claimed`、
// 再 `systemPrompt.assemble()`。这个顺序是从 asar 核实的（dsh-agent-loop 的 preStep）：
// 本轮那条 user/message 要等 assemble 之后才 append 进 session。所以下面
// 「session 里一条 user 都没有、但 claim 过一条」的夹具就是真机的形状。

function fakeAgent({ session } = {}) {
  const hooks = []
  const agent = {
    session: session ?? { id: 's1', snapshotEvents: () => [] },
    ctx: {
      on: (evt, fn, o) => {
        const hook = { evt, fn, o }
        hooks.push(hook)
        return () => {
          const i = hooks.indexOf(hook)
          if (i >= 0) hooks.splice(i, 1)
        }
      },
    },
  }
  return { agent, hooks }
}

const hookOf = (hooks, evt) => hooks.find((h) => h.evt === evt)

/** 宿主先发 claim（在 assemble 之前）。 */
function claimInto(hooks, agent, { text, id = 'm1', kind = 'user' } = {}) {
  hookOf(hooks, 'agent/inbox/claimed').fn({
    agent,
    turn: 1,
    message: { id, source: { kind }, content: [{ type: 'text', text }] },
  })
}

/**
 * 跑一次组装：宿主给的 sections 与真机同形——只有 `{name, text}`、没有 order
 * （复核 P1-1：PromptPresentation 只把 name/text 带进 assemble 结果，order 到不了这里）。
 */
async function assembleOnce(hooks, agent, { tools = true, identity = true } = {}) {
  const sections = [{ name: HOST_PERSONA_SECTION, text: 'You are a coding agent' }]
  if (identity) sections.push({ name: IDENTITY_SECTION, text: '## 你是谁' })
  if (tools) sections.push({ name: TOOLS_SECTION, text: '## 手边有什么' })
  sections.push({ name: WAKE_SECTION, text: '' })
  return hookOf(hooks, 'system-prompt/assemble').fn({}, { agent }, async () => ({ sections }))
}

/** 假预取：记下每次问到的「话」，按次序返回预先排好的结果（用完停在最后一条）。 */
function spyPrefetch(...hits) {
  const calls = []
  const prefetch = async (root, heard) => {
    calls.push({ root, heard })
    const h = hits[Math.min(calls.length - 1, hits.length - 1)]
    return h ?? null
  }
  return { prefetch, calls }
}

const HIT = { text: '## 可能相关的旧事（只是线索，不是结论）\n- 她上次在群里叫过他姐姐（e_1）', count: 1 }
const sectionNames = (out) => out.sections.map((s) => s.name)
const prefetchLogs = (logs) => logs.filter((l) => l.startsWith('prefetch '))

test('组装层预取：用本轮 inbox 那句查（assemble 时 session 里还没有它），查到就插 perch:prefetch', async () => {
  const { agent, hooks } = fakeAgent() // session 里一条事件都没有
  const { prefetch, calls } = spyPrefetch(HIT)
  const logs = []
  const off = attachAssembleFix(agent, { root: '/root', prefetch, log: (m) => logs.push(m) })
  claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
  const out = await assembleOnce(hooks, agent)
  // 真机上 sections 没有 order，只能按段名定位：紧跟在 perch:tools 后面。
  assert.deepEqual(sectionNames(out), [IDENTITY_SECTION, TOOLS_SECTION, PREFETCH_SECTION, WAKE_SECTION])
  assert.equal(
    sectionNames(out).indexOf(PREFETCH_SECTION),
    sectionNames(out).indexOf(TOOLS_SECTION) + 1,
    '线索紧跟在手边工具之后',
  )
  assert.equal(out.sections.find((s) => s.name === PREFETCH_SECTION).text, HIT.text)
  assert.deepEqual(calls.map((c) => c.heard), ['你还记得上次在群里叫我姐姐吗'])
  assert.equal(calls[0].root, '/root')
  // 每轮一条、格式固定：查过几次、多少字、这轮是谁在说。
  assert.deepEqual(prefetchLogs(logs), [`prefetch n=1 chars=${HIT.text.length} source=dsh`])
  off()
  assert.equal(hooks.length, 0, '拆卸时两条钩子一起摘')
})

test('组装层预取：没线索就不插段（查过，但段不许空挂着）', async () => {
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(null)
  const logs = []
  attachAssembleFix(agent, { root: '/root', prefetch, log: (m) => logs.push(m) })
  claimInto(hooks, agent, { text: '今天天气不错' })
  const out = await assembleOnce(hooks, agent)
  assert.deepEqual(sectionNames(out), [IDENTITY_SECTION, TOOLS_SECTION, WAKE_SECTION])
  assert.equal(calls.length, 1)
  assert.deepEqual(prefetchLogs(logs), ['prefetch n=0 chars=0 source=dsh'])
})

test('组装层预取：同一轮多次组装只检索一次，但每次组装都带着段', async () => {
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT)
  attachAssembleFix(agent, { root: '/root', prefetch })
  claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
  for (let i = 0; i < 3; i += 1) {
    const out = await assembleOnce(hooks, agent)
    assert.ok(sectionNames(out).includes(PREFETCH_SECTION), `第 ${i + 1} 次组装也要有段`)
  }
  assert.equal(calls.length, 1, '工具循环里 assemble 会反复触发，但只许检索一次')
})

test('组装层预取：上一轮的临时段不漏到下一轮；下一轮换了句话就重新检索', async () => {
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT, null)
  attachAssembleFix(agent, { root: '/root', prefetch })
  claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗', id: 'm1' })
  const out1 = await assembleOnce(hooks, agent)
  assert.ok(sectionNames(out1).includes(PREFETCH_SECTION))
  claimInto(hooks, agent, { text: '今天天气不错', id: 'm2' })
  const out2 = await assembleOnce(hooks, agent)
  assert.deepEqual(sectionNames(out2), [IDENTITY_SECTION, TOOLS_SECTION, WAKE_SECTION], '新的一轮不带着上一轮的线索')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].heard, '今天天气不错')
})

test('组装层预取：调度唤醒轮（perch:wake 非空）不检索也不插段', async () => {
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT)
  const logs = []
  attachAssembleFix(agent, { root: '/root', prefetch, log: (m) => logs.push(m) })
  setWakeSection('这一次的处境：醒来看一眼，推了一条视频')
  try {
    claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
    const out = await assembleOnce(hooks, agent)
    assert.deepEqual(sectionNames(out), [IDENTITY_SECTION, TOOLS_SECTION, WAKE_SECTION])
    assert.equal(calls.length, 0, '处境已经在 wake 段里，不再叠线索')
    assert.equal(prefetchLogs(logs).length, 0)
  } finally {
    clearWakeSection()
  }
})

test('组装层预取：渠道轮的日志写 source=channel（router 在 askHer 外侧包着 beginExternalTurn）', async () => {
  _resetExternalTurn()
  const { agent, hooks } = fakeAgent()
  const { prefetch } = spyPrefetch(HIT)
  const logs = []
  attachAssembleFix(agent, { root: '/root', prefetch, log: (m) => logs.push(m) })
  beginExternalTurn()
  try {
    claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
    await assembleOnce(hooks, agent)
  } finally {
    endExternalTurn()
    _resetExternalTurn()
  }
  assert.deepEqual(prefetchLogs(logs).map((l) => l.split(' ').at(-1)), ['source=channel'])
})

test('组装层预取：拿不到 inbox 事件时退回 session 里最后一条 user（跳过触发语）', async () => {
  const session = {
    id: 's2',
    snapshotEvents: () => [
      { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: '小满昨天说的那件事' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: '嗯。' }] } } },
    ],
  }
  const { agent, hooks } = fakeAgent({ session })
  const { prefetch, calls } = spyPrefetch(HIT)
  attachAssembleFix(agent, { root: '/root', prefetch })
  const out = await assembleOnce(hooks, agent) // 没有 claim：老宿主那条路
  assert.deepEqual(calls.map((c) => c.heard), ['小满昨天说的那件事'])
  assert.ok(sectionNames(out).includes(PREFETCH_SECTION))
})

test('组装层预取：inbox 里是「没有人跟你说话」或 retry 时不当成一句人话', async () => {
  const session = {
    id: 's3',
    snapshotEvents: () => [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: PROACTIVE_TRIGGER }], source: { kind: 'user' } } },
    ],
  }
  const { agent, hooks } = fakeAgent({ session })
  const { prefetch, calls } = spyPrefetch(HIT)
  attachAssembleFix(agent, { root: '/root', prefetch })
  claimInto(hooks, agent, { text: PROACTIVE_TRIGGER, id: 'c1' })
  claimInto(hooks, agent, { text: '（空回复）', id: 'c2', kind: 'retry' })
  const out = await assembleOnce(hooks, agent)
  assert.equal(calls.length, 0)
  assert.deepEqual(sectionNames(out), [IDENTITY_SECTION, TOOLS_SECTION, WAKE_SECTION])
})

test('组装层预取：上一轮的线索不会跟着一条没有正文的消息再摆一遍', async () => {
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT)
  attachAssembleFix(agent, { root: '/root', prefetch })
  claimInto(hooks, agent, { text: '小满昨天说的那件事', id: 'c1' })
  const first = await assembleOnce(hooks, agent)
  assert.deepEqual(calls.map((c) => c.heard), ['小满昨天说的那件事'])
  assert.ok(sectionNames(first).includes(PREFETCH_SECTION))
  // 第二次是 retry：这一轮没有新的正文，不能拿上一轮那句再查一次。
  claimInto(hooks, agent, { text: '', id: 'c2', kind: 'retry' })
  const second = await assembleOnce(hooks, agent)
  assert.equal(calls.length, 1)
  assert.deepEqual(sectionNames(second), [IDENTITY_SECTION, TOOLS_SECTION, WAKE_SECTION])
})

test('组装层预取：预取自己炸了也不影响这一轮的提示词', async () => {
  const { agent, hooks } = fakeAgent()
  const prefetch = async () => {
    throw new Error('boom')
  }
  attachAssembleFix(agent, { root: '/root', prefetch })
  claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
  const out = await assembleOnce(hooks, agent)
  assert.deepEqual(sectionNames(out), [IDENTITY_SECTION, TOOLS_SECTION, WAKE_SECTION])
})

test('组装层预取：老调用方不给 root 时只做整改、不预取，也不多挂事件', async () => {
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT)
  attachAssembleFix(agent, { prefetch })
  assert.equal(hookOf(hooks, 'agent/inbox/claimed'), undefined)
  const out = await assembleOnce(hooks, agent)
  assert.deepEqual(sectionNames(out), [IDENTITY_SECTION, TOOLS_SECTION, WAKE_SECTION])
  assert.equal(calls.length, 0)
})

test('组装层预取：按段名插——tools 后 / 只有身份段时跟身份 / 两个锚点都没有时放末尾', async () => {
  // 真机上 sections 只有 name/text。tools 段在：紧跟它后面。
  {
    const { agent, hooks } = fakeAgent()
    attachAssembleFix(agent, { root: '/root', prefetch: spyPrefetch(HIT).prefetch })
    claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
    assert.deepEqual(
      sectionNames(await assembleOnce(hooks, agent)),
      [IDENTITY_SECTION, TOOLS_SECTION, PREFETCH_SECTION, WAKE_SECTION],
    )
  }
  // 只有身份段：跟在身份段后面。
  {
    const { agent, hooks } = fakeAgent()
    attachAssembleFix(agent, { root: '/root', prefetch: spyPrefetch(HIT).prefetch })
    claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
    assert.deepEqual(
      sectionNames(await assembleOnce(hooks, agent, { tools: false })),
      [IDENTITY_SECTION, PREFETCH_SECTION, WAKE_SECTION],
    )
  }
  // 两个锚点都没有：放末尾（reorderForHer 之后就在 wake 后面）。
  {
    const { agent, hooks } = fakeAgent()
    attachAssembleFix(agent, { root: '/root', prefetch: spyPrefetch(HIT).prefetch })
    claimInto(hooks, agent, { text: '你还记得上次在群里叫我姐姐吗' })
    assert.deepEqual(
      sectionNames(await assembleOnce(hooks, agent, { tools: false, identity: false })),
      [WAKE_SECTION, PREFETCH_SECTION],
    )
  }
})

test('组装层预取：渠道轮用 router 递来的原话检索，不拿 buildPrompt 的整段稿纸', async () => {
  _resetExternalTurn()
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT)
  const logs = []
  attachAssembleFix(agent, { root: '/root', prefetch, log: (m) => logs.push(m) })
  const raw = '你还记得上次说你叫我姐姐吗'
  // 真机渠道轮 inbox 里的正文是 buildPrompt 整段：开头是群 header，末尾是回不回你自己定。
  claimInto(hooks, agent, {
    text: [
      '（QQ 的群「家里」。说话的是 小满。你对他有印象：爱开玩笑。）',
      '',
      '前面几句：',
      '- 小满：今天加班',
      '',
      '「你还记得上次说你叫我姐姐吗」',
      '',
      '（回不回、怎么回，你自己定。）',
    ].join('\n'),
  })
  beginExternalTurn()
  setExternalHeard(raw)
  try {
    const out = await assembleOnce(hooks, agent)
    assert.ok(sectionNames(out).includes(PREFETCH_SECTION))
    // 同一轮工具循环里再组装一次：不重复检索。
    await assembleOnce(hooks, agent)
  } finally {
    clearExternalHeard()
    endExternalTurn()
    _resetExternalTurn()
  }
  assert.deepEqual(calls.map((c) => c.heard), [raw], '查的是原话，不是整段稿纸')
  assert.deepEqual(prefetchLogs(logs), [`prefetch n=1 chars=${HIT.text.length} source=channel`])
})

test('组装层预取：渠道轮没有递原话时，退回本轮 claim 的正文', async () => {
  _resetExternalTurn()
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT)
  attachAssembleFix(agent, { root: '/root', prefetch })
  claimInto(hooks, agent, { text: '群里的整段稿纸' })
  beginExternalTurn()
  try {
    await assembleOnce(hooks, agent)
  } finally {
    endExternalTurn()
    _resetExternalTurn()
  }
  assert.deepEqual(calls.map((c) => c.heard), ['群里的整段稿纸'])
})

test('组装层预取：不在渠道轮时，旁路里残留的原话不会被当成这一轮的话', async () => {
  const { agent, hooks } = fakeAgent()
  const { prefetch, calls } = spyPrefetch(HIT)
  const logs = []
  attachAssembleFix(agent, { root: '/root', prefetch, log: (m) => logs.push(m) })
  claimInto(hooks, agent, { text: '面板里说的这句' })
  setExternalHeard('渠道上一轮的原话') // 并发/清理失败的残留
  try {
    await assembleOnce(hooks, agent)
  } finally {
    clearExternalHeard()
  }
  assert.deepEqual(calls.map((c) => c.heard), ['面板里说的这句'])
  assert.deepEqual(prefetchLogs(logs).map((l) => l.split(' ').at(-1)), ['source=dsh'])
})
