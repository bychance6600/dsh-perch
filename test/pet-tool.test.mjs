/**
 * pet-tool.test.mjs —— pet_act 只在开启时存在（2026-11-08，m09369）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PET_ACTIONS, registerPetAct } from '../lib/pet/tool.js'
import { FISH_TOOLS } from '../lib/restrict.js'

function fakeCtx() {
  const list = []
  return { tools: { register: (t) => { list.push(t); return { dispose() {} } } }, list }
}

test('pet_act 不在常驻白名单里；开着才由 extra 追加', () => {
  assert.equal(FISH_TOOLS.includes('pet_act'), false)
  assert.equal(PET_ACTIONS.length, 10)
})

test('动作只认十种，成功时只回一句动作，不回状态数字', async () => {
  const ctx = fakeCtx()
  const sent = []
  registerPetAct(ctx, { enabled: () => true, sendAct: (a, w) => { sent.push([a, w]); return true } })
  const tool = ctx.list[0]
  assert.equal(tool.name, 'pet_act')
  const ok = await tool.execute({ action: 'nod', why: '听见了' })
  assert.deepEqual(ok, { ok: true, note: '点了点头' })
  assert.deepEqual(sent, [['nod', '听见了']])

  const bad = await tool.execute({ action: '唱歌' })
  assert.equal(bad.ok, false)
  assert.match(bad.note, /没有这个动作/)
  assert.equal(sent.length, 1)
})

test('注册出来的工具带 output.render，render 返回 ContentBlock 数组', async () => {
  const ctx = fakeCtx()
  registerPetAct(ctx, { enabled: () => true, sendAct: () => true })
  const tool = ctx.list[0]
  assert.equal(tool.output?.schema?.type, 'object')
  assert.deepEqual(tool.output?.schema?.required, ['ok', 'note'])
  assert.equal(typeof tool.output?.render, 'function')
  const blocks = tool.output.render({ action: 'nod' }, { ok: true, note: '点了点头' })
  assert.ok(Array.isArray(blocks))
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /动了/)
  const bad = tool.output.render({ action: 'nod' }, { ok: false, note: '桌宠没开。' })
  assert.ok(Array.isArray(bad))
  assert.match(bad[0].text, /没动/)
})

test('parameters 过 toJsonSchema：干净标准 JSON，不是手写形态（2026-11-08 真机）', () => {
  const ctx = fakeCtx()
  registerPetAct(ctx, { enabled: () => true, sendAct: () => true })
  const p = ctx.list[0].parameters
  assert.equal(p.type, 'object')
  assert.equal(p.additionalProperties, false)
  assert.deepEqual(p.required, ['action'])
  assert.deepEqual(p.properties.action.enum, [...PET_ACTIONS])
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
})

test('关着 / 没连上都不抛，只说一句', async () => {
  const off = fakeCtx()
  registerPetAct(off, { enabled: () => false })
  assert.deepEqual(await off.list[0].execute({ action: 'laugh' }), { ok: false, note: '桌宠没开。' })

  const down = fakeCtx()
  registerPetAct(down, { enabled: () => true, sendAct: () => false })
  assert.deepEqual(await down.list[0].execute({ action: 'laugh' }), { ok: false, note: '桌宠没连上，动作没送出去。' })
})
