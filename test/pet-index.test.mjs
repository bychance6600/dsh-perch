/**
 * pet-index.test.mjs —— 默认关时零副作用（2026-11-08，m09369）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { petEnabled, petSendAct, petStatus, startPet } from '../lib/pet/index.js'

const ctx = { on: () => () => {}, tools: { register: () => ({ dispose() {} }) } }

test('pet 关着：不 spawn、不订阅、状态就是没开', async () => {
  let spawned = 0
  const root = await mkdtemp(join(tmpdir(), 'dsh-roost-pet-off-'))
  const pet = await startPet(ctx, {
    root,
    cfg: { pet: { enabled: false, path: 'D:/不存在/pet.exe' } },
    spawn: () => { spawned += 1; throw new Error('不该走到这里') },
  })
  assert.equal(spawned, 0)
  assert.equal(petStatus().enabled, false)
  assert.equal(petStatus().state, '等')
  assert.equal(petSendAct('nod'), false)
  pet.off()
  await rm(root, { recursive: true, force: true })
})

test('开着但没填路径：记一句原因，也不 spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roost-pet-empty-'))
  let spawned = 0
  const pet = await startPet(ctx, {
    root,
    cfg: { pet: { enabled: true, path: '' } },
    spawn: () => { spawned += 1; throw new Error('不该走到这里') },
  })
  assert.equal(spawned, 0)
  assert.equal(petStatus().enabled, true)
  assert.equal(petStatus().lastError, '没填宠物包的路径')
  assert.match(petStatus().why, /还没填宠物包的路径/)
  pet.off()
  assert.equal(petStatus().enabled, false)
  await rm(root, { recursive: true, force: true })
})

test('状态只给中文档位，不出现 need / 内部英文名', () => {
  const s = petStatus()
  assert.ok(['思考', '动手', '等', '出错', '成了'].includes(s.state), s.state)
  assert.doesNotMatch(`${s.state} ${s.why}`, /need|thinking|acting|waiting|error|done/i)
})

test('启动参数、握手超时、退出码都走入口约定，不各写一份', async () => {
  const src = await readFile(new URL('../lib/pet/index.js', import.meta.url), 'utf8')
  assert.match(src, /entrySpec\(cfg\.pet/)
  assert.match(src, /env: childEnv\(process\.env\)/)
  assert.match(src, /helloTimeoutMs: HELLO_TIMEOUT_MS/)
  assert.match(src, /classifyExit\(code, signal/)
})

test('睡不睡只看她自己的睡迹，不拿时段和 wokeToday 推', async () => {
  const src = await readFile(new URL('../lib/pet/index.js', import.meta.url), 'utf8')
  assert.match(src, /asleepFromEvents\(events/)
  assert.doesNotMatch(src, /deriveStatus/)
  assert.doesNotMatch(src, /wokeToday/)
})

test('petEnabled 只认 true + 非空路径', () => {
  assert.equal(petEnabled({ pet: { enabled: true, path: 'D:/pet.exe' } }), true)
  assert.equal(petEnabled({ pet: { enabled: 'true', path: 'D:/pet.exe' } }), false)
  assert.equal(petEnabled({ pet: { enabled: true, path: '   ' } }), false)
  assert.equal(petEnabled({}), false)
})
