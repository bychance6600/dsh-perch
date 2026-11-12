import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CATALOG, findTemplate } from '../lib/events.js'
import { REFUSAL_BRIEF } from '../lib/persona.js'

// 2026-11-12：`unlock.js` 的 learn-affection 要 `refusals >= 2`，
// 但原来全系统只有 `refusal_seed` 跟拒绝有关，而它的提示词是「你现在想让他为你做一件事」——
// 那是请求，不是拒绝。她照着做两次都记成 ask，拒绝数永远是 0。
// 这两条钉住「入口存在」：常驻做法得有，处境卡得真的在问她答不答应。

test('「我可以不答应」是常驻做法，不是一次性提示', () => {
  assert.match(REFUSAL_BRIEF, /不答应/)
  assert.match(REFUSAL_BRIEF, /growth_commit/, '得写清用哪个东西记，不然她只会说不会记')
  assert.match(REFUSAL_BRIEF, /refusal/, '记成什么类型要说出来')
  // 身份文档真的挂了它，否则她读到的是别的工具说明。
  const selfdoc = readFileSync(new URL('../lib/selfdoc.js', import.meta.url), 'utf8')
  assert.match(selfdoc, /REFUSAL_BRIEF/, '身份文档里没注入，等于还是不知道')
})

test('refusal_seed 问的是「答不答应」，不是「提一个要求」', () => {
  const t = findTemplate('refusal_seed')
  assert.ok(t, '卡还在')
  const prompt = t.prompt({})
  assert.match(prompt, /还没答应|答不答应/, '处境要落在「他提了、你还没答」上')
  assert.match(prompt, /可以答应，也可以不答应/, '两条路都得给，不然是命令')
  assert.doesNotMatch(prompt, /开口提|先把请求说出来/, '不能再回到「提要求」那条老路')
  // 不给台词：不许替她说她要说的那句话。
  assert.doesNotMatch(prompt, /你就说|你说：|回答[:：]/, 'prompt 只给处境，不给台词')
})

test('这张卡仍是一次性的，且只在拒绝数为 0 时出现', () => {
  const t = findTemplate('refusal_seed')
  assert.equal(t.once, true)
  assert.equal(t.cond({ refusals: [] }), true)
  assert.equal(t.cond({ refusals: [{ id: 'x' }] }), false, '已经拒过了就别再推这张')
  assert.ok(CATALOG.some((x) => x.id === 'refusal_seed'))
})
