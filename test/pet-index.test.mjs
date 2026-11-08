/**
 * pet-index.test.mjs —— 默认关时零副作用（2026-11-08，m09369）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { petApplyConfig, petEnabled, petSendAct, petStatus, pokeKind, startPet } from '../lib/pet/index.js'

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

test('开着但没装：installed:false、只说还没装身体，不刷错误也不 spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roost-pet-empty-'))
  let spawned = 0
  const pet = await startPet(ctx, {
    root,
    cfg: { pet: { enabled: true, path: '' } },
    spawn: () => { spawned += 1; throw new Error('不该走到这里') },
  })
  assert.equal(spawned, 0)
  const s = petStatus()
  assert.equal(s.enabled, true)
  assert.equal(s.installed, false)
  assert.equal(s.path, join(root, 'pet', 'dsh-roost-pet.exe'))
  assert.equal(s.lastError, '')
  assert.match(s.why, /还没装身体/)
  pet.off()
  assert.equal(petStatus().enabled, false)
  await rm(root, { recursive: true, force: true })
})

test('路径空着时默认找 <root>/pet/dsh-roost-pet.exe；文件在就算装了', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roost-pet-default-'))
  await mkdir(join(root, 'pet'), { recursive: true })
  const exe = join(root, 'pet', 'dsh-roost-pet.exe')
  await writeFile(exe, '')
  const s = petStatus({ pet: { enabled: true, path: '', pack: 'cat' } }, root)
  assert.equal(s.enabled, true)
  assert.equal(s.installed, true)
  assert.equal(s.path, exe)
  assert.equal(s.pack, 'cat')
  await rm(root, { recursive: true, force: true })
})

test('状态只给中文档位，不出现 need / 内部英文名', () => {
  const s = petStatus()
  assert.ok(['思考', '动手', '等', '出错', '成了'].includes(s.state), s.state)
  assert.doesNotMatch(`${s.state} ${s.why}`, /need|thinking|acting|waiting|error|done/i)
})

test('启动参数、握手超时、退出码都走入口约定，不各写一份', async () => {
  const src = await readFile(new URL('../lib/pet/index.js', import.meta.url), 'utf8')
  assert.match(src, /entrySpec\(\{ \.\.\.\(cfg\.pet \?\? \{\}\), path: petPath \}\)/)
  assert.match(src, /env: childEnv\(process\.env\)/)
  assert.match(src, /helloTimeoutMs: HELLO_TIMEOUT_MS/)
  assert.match(src, /classifyExit\(code, signal/)
})

test('睡不睡按回合与最后一次动静算，不读睡迹、时段和 wokeToday（2026-11-08 16:00）', async () => {
  const src = await readFile(new URL('../lib/pet/index.js', import.meta.url), 'utf8')
  assert.match(src, /awakeByActivity\(base\.turnActive, base\.lastActivityAt/)
  assert.match(src, /base\.turnActive = true/)
  assert.match(src, /base\.lastActivityAt = now/)
  assert.match(src, /idleSleepMin: idleMinutes\(cfg\?\.pet\?\.idleSleepMin\)/)
  assert.doesNotMatch(src, /asleepFromEvents/)
  assert.doesNotMatch(src, /deriveStatus/)
  assert.doesNotMatch(src, /wokeToday/)
})

test('设置页改 idleSleepMin 当场热更，不用重启（2026-11-08 16:53）', async () => {
  const src = await readFile(new URL('../lib/pet/index.js', import.meta.url), 'utf8')
  assert.match(src, /export function petApplyConfig\(cfg\)/)
  assert.match(src, /runtime\.idleSleepMin = idleMinutes\(cfg\?\.pet\?\.idleSleepMin\)/)
  assert.match(src, /runtime\.checkAwake\?\.\(\)/)
  assert.match(src, /base\.checkAwake = checkAwake/)
  const obs = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.match(obs, /petApplyConfig\(next\)/)
  assert.equal(typeof petApplyConfig, 'function')
})

test('petEnabled 只认 true；路径空着也算开，会去默认位置找身体', () => {
  assert.equal(petEnabled({ pet: { enabled: true, path: 'D:/pet.exe' } }), true)
  assert.equal(petEnabled({ pet: { enabled: 'true', path: 'D:/pet.exe' } }), false)
  assert.equal(petEnabled({ pet: { enabled: true, path: '   ' } }), true)
  assert.equal(petEnabled({}), false)
})

test('戳一下：隔够了就排一轮，回合进行中也不早退（2026-11-08 23:20）', async () => {
  const now = 1_800_000_000_000
  assert.equal(pokeKind(now - 59_999, now, 60_000), 'ignore')
  assert.equal(pokeKind(now - 60_000, now, 60_000), 'turn')
  assert.equal(pokeKind(0, now, 60_000), 'turn')
  // 配置坏值 / 越界都夹回 5–600 秒。
  assert.equal(pokeKind(now - 4_000, now, 1), 'ignore')
  assert.equal(pokeKind(now - 5_000, now, 1), 'turn')

  // 2026-11-08 23:20 协调板：回合中只记 meta 的话，meta 不进上下文，她永远看不见。
  // 现在 pokeKind 不再看 turnActive；pokeTurn 也不因 turnActive 早退，交给 mode:'queue' 等这一轮结束。
  const src = await readFile(new URL('../lib/pet/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /pokeKind\(base\.turnActive/)
  assert.doesNotMatch(src, /if \(base\.turnActive \|\| !base\.sessionId\) return/)
  assert.match(src, /await talkSessionId\(ctx, \{ root \}\)/)
  assert.match(src, /if \(!sid\) return/)
  assert.match(src, /mode: 'queue'/)
})

test('戳一下不写 seen、不进 heard；只记 meta 和一句固定的轻提示', async () => {
  const src = await readFile(new URL('../lib/pet/index.js', import.meta.url), 'utf8')
  assert.match(src, /text: `poke:\$\{iso\}`/)
  assert.match(src, /他伸手戳了你一下。回不回应、怎么回应，你自己定。/)
  assert.match(src, /void notePoke\(iso\)/)
  assert.match(src, /void pokeTurn\(\)\.catch\(/)
  assert.match(src, /poke 间隔不到/)
  assert.doesNotMatch(src, /poke[\s\S]{0,200}seen:/i)
})
