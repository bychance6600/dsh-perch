/**
 * pet-actions.test.mjs —— 角色包的 pet.json 决定身体能演什么（2026-11-08 17:50）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  BUILTIN_ACTIONS,
  actionLabel,
  petPackCandidates,
  readPetPack,
  safeActionName,
} from '../lib/pet/actions.js'

test('动作名只收短标识；labels 优先，没给就用内置，再没有就用名字', () => {
  assert.equal(safeActionName('wave'), true)
  assert.equal(safeActionName('wave-2'), true)
  assert.equal(safeActionName('挥手'), true)
  assert.equal(safeActionName('可爱宅舞'), true)
  assert.equal(safeActionName('a/b'), false)
  assert.equal(safeActionName('../x'), false)
  assert.equal(safeActionName('bad name'), false)
  assert.equal(safeActionName(''), false)
  assert.equal(actionLabel('nod'), '点了点头')
  assert.equal(actionLabel('wave'), 'wave')
  assert.equal(actionLabel('wave', { wave: '挥手' }), '挥手')
  assert.equal(actionLabel('wave', { wave: '   ' }), 'wave')
})

test('找 pet.json 的顺序：pet.dir > 家目录角色包 > 开发态仓库', () => {
  const pet = { dir: 'D:/packs/cat', repo: 'D:/repo/pet', pack: 'cat' }
  const got = petPackCandidates(pet, 'D:/roost')
  assert.deepEqual(got, [
    join(resolve('D:/packs/cat'), 'pet.json'),
    join(resolve('D:/roost'), 'pets', 'cat', 'pet.json'),
    join(resolve('D:/repo/pet'), 'pets', 'cat', 'pet.json'),
  ])
  // 同一个路径出现两次只留一次。
  assert.equal(petPackCandidates({ repo: 'D:/roost', pack: 'cat' }, 'D:/roost').length, 1)
})

test('读角色包：只认 animations.actions 的键，过滤坏名字，labels 只留用得到的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roost-pack-'))
  const dir = join(root, 'pets', 'cat')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'pet.json'), JSON.stringify({
    name: '小猫',
    animations: {
      actions: {
        wave: { file: 'wave.webm', from: 0, to: 600 },
        nod: { file: 'nod.webm' },
        '坏 名字': { file: 'x.webm' },
        sleep: [{ file: 'a.webm' }, { file: 'b.webm' }],
      },
    },
    labels: { wave: '挥手', nope: '不该出现', sleep: 3 },
  }))
  const pack = readPetPack({ pack: 'cat' }, root)
  assert.deepEqual(pack.actions, ['wave', 'nod', 'sleep'])
  assert.deepEqual(pack.labels, { wave: '挥手' })
  assert.equal(pack.name, '小猫')
  assert.match(pack.source, /pet\.json$/)
  await rm(root, { recursive: true, force: true })
})

test('角色包缺了、读坏了、动作是空的：回落内置那 10 个', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roost-pack-bad-'))
  const dir = join(root, 'pets', 'cat')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'pet.json'), '{ 这不是 json')
  assert.deepEqual(readPetPack({ pack: 'cat' }, root).actions, [...BUILTIN_ACTIONS])
  await writeFile(join(dir, 'pet.json'), JSON.stringify({ animations: { actions: {} } }))
  assert.deepEqual(readPetPack({ pack: 'cat' }, root).actions, [...BUILTIN_ACTIONS])
  await rm(root, { recursive: true, force: true })
})
