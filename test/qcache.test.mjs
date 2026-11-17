/**
 * qcache.test.mjs —— 体检缓存必须「能删、会自删、长不大」
 *
 * 背景（用户 m00428，2026-11-17）：
 *   「可以放缓存 但是要控制这个缓存 没用的时候要删掉
 *    不要因为长时间用这个项目导致磁盘被缓存沾满」
 *
 * 所以这里测的不是「缓存能命中」，而是**缓存不会变成垃圾**：
 * 坏文件当场删、过期当场删、超上限从最旧的删、单个文件太大宁可不写。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  CACHE_VERSION,
  MAX_AGE_MS,
  MAX_BYTES,
  MAX_DIR_BYTES,
  MAX_FILES,
  cacheDir,
  cacheInfo,
  cachePath,
  clearCache,
  pruneCache,
  readCache,
  readCacheValue,
  writeCache,
} from '../lib/qcache.js'
import { paths } from '../lib/store.js'

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-qcache-'))
const DAY = 24 * 60 * 60 * 1000

test('写进去、读回来：指纹一致才命中', async () => {
  const root = tmp()
  const w = await writeCache(root, 'consistency', 'fp-1', { sum: 0.5, pairs: 3 })
  assert.equal(w.ok, true)
  const rec = await readCache(root, 'consistency')
  assert.equal(rec.v, CACHE_VERSION)
  assert.equal(rec.fingerprint, 'fp-1')
  assert.deepEqual(await readCacheValue(root, 'consistency', 'fp-1'), { sum: 0.5, pairs: 3 })
  assert.equal(await readCacheValue(root, 'consistency', 'fp-2'), null, '指纹不符不算命中')
})

test('数据文件夹里的 cache/ 由 paths() 承认', () => {
  assert.equal(paths('/tmp/x').cacheDir, join('/tmp/x', 'cache'))
  assert.equal(cacheDir('/tmp/x'), join('/tmp/x', 'cache'))
})

test('坏文件当场删，不留到最后当垃圾', async () => {
  const root = tmp()
  fs.mkdirSync(cacheDir(root), { recursive: true })
  const file = cachePath(root, 'stability')
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  assert.equal(await readCache(root, 'stability'), null)
  assert.equal(fs.existsSync(file), false, '坏文件必须被删掉')
})

test('版本不对 / 名字不对也删', async () => {
  const root = tmp()
  fs.mkdirSync(cacheDir(root), { recursive: true })
  const file = cachePath(root, 'stability')
  fs.writeFileSync(file, JSON.stringify({ v: 99, name: 'stability', fingerprint: 'x', at: Date.now(), data: 1 }))
  assert.equal(await readCache(root, 'stability'), null)
  assert.equal(fs.existsSync(file), false)

  fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, name: '别的', fingerprint: 'x', at: Date.now(), data: 1 }))
  assert.equal(await readCache(root, 'stability'), null)
  assert.equal(fs.existsSync(file), false)
})

test('超过 14 天没碰过就删（没用的时候删掉）', async () => {
  const root = tmp()
  await writeCache(root, 'novelty', 'fp', { score: 0.1 })
  const file = cachePath(root, 'novelty')
  const old = (Date.now() - MAX_AGE_MS - 60 * 1000) / 1000
  fs.utimesSync(file, old, old)
  assert.equal(await readCache(root, 'novelty'), null)
  assert.equal(fs.existsSync(file), false)
})

test('读一次就算用过：天天读的不会过期', async () => {
  const root = tmp()
  await writeCache(root, 'novelty', 'fp', { score: 0.1 })
  const file = cachePath(root, 'novelty')
  const old = (Date.now() - MAX_AGE_MS + 60 * 1000) / 1000
  fs.utimesSync(file, old, old)
  assert.ok(await readCache(root, 'novelty'), '还没到 14 天，应该能读到')
  const age = Date.now() - fs.statSync(file).mtimeMs
  assert.ok(age < 60 * 1000, '读过以后 mtime 应该被 touch 到现在')
})

test('单个文件太大宁可不写（不截断）', async () => {
  const root = tmp()
  const big = 'x'.repeat(MAX_BYTES + 1024)
  const w = await writeCache(root, 'stability', 'fp', big)
  assert.equal(w.ok, false)
  assert.equal(w.reason, 'too-big')
  assert.equal(fs.existsSync(cachePath(root, 'stability')), false)
})

test('缓存名不许跑出 cache/ 目录', async () => {
  const root = tmp()
  assert.throws(() => cachePath(root, '../evil'))
  assert.throws(() => cachePath(root, 'a/b'))
  assert.equal(await readCache(root, '../evil'), null, '读也不抛，只是拿不到')
  const w = await writeCache(root, 'A-Bad', 'fp', 1)
  assert.equal(w.ok, false)
  assert.equal(w.reason, 'bad-name')
})

test('文件数超上限就从最旧的删，非 json 一律删', async () => {
  const root = tmp()
  fs.mkdirSync(cacheDir(root), { recursive: true })
  const base = Date.now() - 60 * 1000
  for (let i = 0; i < 12; i++) {
    const file = join(cacheDir(root), `m${i}.json`)
    fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, name: `m${i}`, fingerprint: 'f', at: base, data: i }))
    const t = (base - i * 1000) / 1000
    fs.utimesSync(file, t, t)
  }
  fs.writeFileSync(join(cacheDir(root), 'junk.txt'), 'x', 'utf8')
  const r = await pruneCache(root)
  assert.ok(r.kept <= MAX_FILES, `最多留 ${MAX_FILES} 个，实际 ${r.kept}`)
  assert.equal(fs.existsSync(join(cacheDir(root), 'junk.txt')), false)
  // 留下的是最新的那批
  assert.equal(fs.existsSync(join(cacheDir(root), 'm0.json')), true)
  assert.equal(fs.existsSync(join(cacheDir(root), 'm11.json')), false)
})

test('目录总量超上限也从最旧的删', async () => {
  const root = tmp()
  fs.mkdirSync(cacheDir(root), { recursive: true })
  const base = Date.now() - 60 * 1000
  const chunk = 400 * 1024
  for (let i = 0; i < 4; i++) {
    const file = join(cacheDir(root), `big${i}.json`)
    fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, name: `big${i}`, fingerprint: 'f', at: base, data: 'x'.repeat(chunk) }))
    const t = (base - i * 1000) / 1000
    fs.utimesSync(file, t, t)
  }
  const r = await pruneCache(root)
  assert.ok(r.bytes <= MAX_DIR_BYTES, `目录最多 ${MAX_DIR_BYTES} 字节，实际 ${r.bytes}`)
  assert.equal(fs.existsSync(join(cacheDir(root), 'big0.json')), true, '最新的留下')
  assert.equal(fs.existsSync(join(cacheDir(root), 'big3.json')), false, '最旧的删掉')
})

test('写一次就顺手 prune，调用方忘了也不会撑大', async () => {
  const root = tmp()
  fs.mkdirSync(cacheDir(root), { recursive: true })
  const old = (Date.now() - MAX_AGE_MS - 60 * 1000) / 1000
  for (let i = 0; i < 3; i++) {
    const file = join(cacheDir(root), `old${i}.json`)
    fs.writeFileSync(file, '{}', 'utf8')
    fs.utimesSync(file, old, old)
  }
  await writeCache(root, 'consistency', 'fp', { a: 1 })
  const info = await cacheInfo(root)
  assert.deepEqual(info.files.map((f) => f.name), ['consistency.json'])
  assert.ok(info.bytes < 4096)
})

test('缓存内容被改过：checksum 对不上就当坏文件删掉，不返回假数', async () => {
  // 背景：verifier 复核时发现「把 consistency.json 的 sum 手改 +100，/state 会安静地
  // 返回一个假分数」——派生的东西也得自证，不然缓存就成了第二份真相（AGENTS §20）。
  const root = tmp()
  await writeCache(root, 'consistency', 'fp-1', { sum: 10, pairs: 20 })
  const file = cachePath(root, 'consistency')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(typeof rec.checksum, 'string')
  assert.equal(rec.checksum.length, 64)
  const tampered = JSON.parse(JSON.stringify(rec))
  tampered.data.sum += 100
  fs.writeFileSync(file, JSON.stringify(tampered), 'utf8')
  assert.equal(await readCacheValue(root, 'consistency', 'fp-1'), null, '改过的值不许被信任')
  assert.equal(fs.existsSync(file), false, '对不上就当坏文件删掉')

  // 同理：只改 data 里的一个数、或者只改 at，都必须被识破。
  await writeCache(root, 'novelty', 'fp-2', { score: 0.9 })
  const rec2 = JSON.parse(fs.readFileSync(cachePath(root, 'novelty'), 'utf8'))
  rec2.data.score = 0.123
  fs.writeFileSync(cachePath(root, 'novelty'), JSON.stringify(rec2), 'utf8')
  assert.equal(await readCacheValue(root, 'novelty', 'fp-2'), null)
  assert.equal(fs.existsSync(cachePath(root, 'novelty')), false)
})

test('cache/ 里混进非 .json 的东西（含子目录）会被清掉', async () => {
  const root = tmp()
  fs.mkdirSync(join(cacheDir(root), 'junk-dir'), { recursive: true })
  fs.writeFileSync(join(cacheDir(root), 'junk.txt'), 'x', 'utf8')
  const pruned = await pruneCache(root)
  assert.equal(pruned.removed, 2)
  assert.equal(fs.existsSync(join(cacheDir(root), 'junk-dir')), false)
  assert.equal(fs.existsSync(join(cacheDir(root), 'junk.txt')), false)
})

test('目录不存在时读/清都不抛', async () => {
  const root = tmp()
  assert.equal(await readCache(root, 'stability'), null)
  assert.deepEqual(await clearCache(root), { ok: true })
  assert.deepEqual(await pruneCache(root), { removed: 0, kept: 0, bytes: 0 })
})
