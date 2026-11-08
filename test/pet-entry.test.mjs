/**
 * pet-entry.test.mjs —— 入口约定：路径、参数、超时、退出码（2026-11-08，m10008）
 *
 * 契约正文在 body 仓库 docs/launch.md；这里只测纯函数，真 spawn 留手测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  bodyArgs,
  childEnv,
  classifyExit,
  entrySpec,
  EXIT_CODES,
  HELLO_TIMEOUT_MS,
  isElectronPath,
  MAX_ATTEMPTS,
  petIdOf,
  RETRY_WAITS,
  STOP_GRACE_MS,
  BYE_GRACE_MS,
} from '../lib/pet/entry.js'

test('默认参数：协议 v1、大小 1、穿透开、宠物包 default，位置不写', () => {
  assert.deepEqual(bodyArgs({}), ['--protocol=1', '--size=1', '--click-through=1', '--pet=default'])
})

test('自定义大小、位置、穿透、宠物包，额外参数接在后面', () => {
  assert.deepEqual(
    bodyArgs({ size: 1.25, position: 'bottom-right', clickThrough: false, petId: 'cat-2', args: ['--foo', 'bar'] }),
    ['--protocol=1', '--size=1.25', '--position=bottom-right', '--click-through=0', '--pet=cat-2', '--foo', 'bar'],
  )
})

test('大小夹在 0.5–2.0；坏值回 1', () => {
  assert.equal(bodyArgs({ size: 0.1 })[1], '--size=0.5')
  assert.equal(bodyArgs({ size: 9 })[1], '--size=2')
  assert.equal(bodyArgs({ size: 'abc' })[1], '--size=1')
})

test('位置只认白名单；空串和乱写的都不传', () => {
  assert.equal(bodyArgs({ position: '' }).includes('--position='), false)
  assert.equal(bodyArgs({ position: '../x' }).includes('--position='), false)
  assert.equal(bodyArgs({ position: 'top-left' })[2], '--position=top-left')
})

test('宠物包 id 只收短标识；空的、带空格的都回 default', () => {
  assert.equal(petIdOf({}), 'default')
  assert.equal(petIdOf({ petId: '  ' }), 'default')
  assert.equal(petIdOf({ petId: '../x' }), 'default')
  assert.equal(petIdOf({ petId: 'shiba_2' }), 'shiba_2')
  assert.equal(bodyArgs({ petId: 'bad id' }).at(-1), '--pet=default')
})

test('打包产物：直接起，cwd 是可执行文件所在目录', () => {
  const exe = resolve('D:/pets/dsh-roost-pet.exe')
  const spec = entrySpec({ path: exe, size: 1.1 })
  assert.equal(spec.path, exe)
  assert.equal(spec.cwd, resolve('D:/pets'))
  assert.deepEqual(spec.args, ['--protocol=1', '--size=1.1', '--click-through=1', '--pet=default'])
})

test('开发态：electron.exe 前面加仓库根，cwd 也是仓库根', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-roost-pet-entry-'))
  try {
    const dist = join(repo, 'node_modules', 'electron', 'dist')
    await mkdir(dist, { recursive: true })
    const exe = join(dist, 'electron.exe')
    await writeFile(exe, '')
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'dsh-roost-pet' }))
    const spec = entrySpec({ path: exe })
    assert.equal(spec.path, exe)
    assert.equal(spec.cwd, repo)
    assert.equal(spec.args[0], repo)
    assert.equal(spec.args[1], '--protocol=1')
    assert.equal(spec.args.at(-1), '--pet=default')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('开发态：仓库根也可以显式填 pet.repo；填错不会猜', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-roost-pet-entry-bad-'))
  try {
    const exe = join(dir, 'electron.exe')
    await writeFile(exe, '')
    assert.throws(() => entrySpec({ path: exe }), /pet\.repo/)
    const repo = join(dir, 'repo')
    await mkdir(repo, { recursive: true })
    const spec = entrySpec({ path: exe, repo })
    assert.equal(spec.cwd, repo)
    assert.equal(spec.args[0], repo)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('isElectronPath 只认 electron / electron.exe', () => {
  assert.equal(isElectronPath('C:/x/node_modules/electron/dist/electron.exe'), true)
  assert.equal(isElectronPath('/opt/electron'), true)
  assert.equal(isElectronPath('D:/pets/dsh-roost-pet.exe'), false)
  assert.equal(isElectronPath('D:/pets/electron-wrapper.exe'), false)
})

test('childEnv 删掉 ELECTRON_RUN_AS_NODE，别的原样留着', () => {
  const base = { ELECTRON_RUN_AS_NODE: '1', PATH: 'x', FOO: 'bar' }
  const env = childEnv(base)
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal(env.PATH, 'x')
  assert.equal(env.FOO, 'bar')
  assert.equal(base.ELECTRON_RUN_AS_NODE, '1')
})

test('退出码：0 和已说 bye 是 clean', () => {
  assert.equal(classifyExit(0), 'clean')
  assert.equal(classifyExit(null, null, { clean: true }), 'clean')
  assert.equal(classifyExit(1, null, { clean: true }), 'clean')
})

test('退出码：3 已经有一只、4 参数错，不重试', () => {
  assert.equal(classifyExit(EXIT_CODES.alreadyRunning), 'dead')
  assert.equal(classifyExit(EXIT_CODES.badArgs), 'dead')
})

test('退出码：1、2、信号、其他都按退避重试', () => {
  assert.equal(classifyExit(EXIT_CODES.crash), 'retry')
  assert.equal(classifyExit(EXIT_CODES.protocol), 'retry')
  assert.equal(classifyExit(null, 'SIGTERM'), 'retry')
  assert.equal(classifyExit(9), 'retry')
})

test('超时与重试次数是定值，不靠 body 猜', () => {
  assert.equal(HELLO_TIMEOUT_MS, 10_000)
  assert.equal(MAX_ATTEMPTS, 3)
  assert.deepEqual(RETRY_WAITS, [1000, 5000])
  assert.equal(STOP_GRACE_MS, 2000)
  assert.equal(BYE_GRACE_MS, 3000)
})
