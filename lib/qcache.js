/**
 * qcache.js —— 体检值的派生缓存（2026-11-17）
 *
 * 为什么有它：设置页「状态」那三个数（稳定 / 一致 / 新鲜）算一次要几十秒，
 * 而它们只给主人看一眼——不进提示词、不参与成长判定、她本人看不见（AGENTS §3）。
 * 主人 m00428 批准放缓存，但加了条件：
 *   「可以放缓存 但是要控制这个缓存 没用的时候要删掉
 *     不要因为长时间用这个项目导致磁盘被缓存沾满」
 *
 * 所以这份缓存的边界是硬的，改之前先想清楚：
 *   1. 一个指标一个文件：`<root>/cache/<name>.json`，文件里**只有一条记录**，
 *      覆盖式写。不按 key 累积 ⇒ 文件数恒等于指标数（今天 2 个），不随天数涨。
 *   2. 指纹对不上就覆盖；文件坏了（JSON 解不开 / 版本不对 / 名字不对）**删掉**，
 *      绝不留到最后当垃圾。
 *   3. 序列化后超过 MAX_BYTES（256KB）就不写——宁可每次重算，也不写大文件。
 *   4. MAX_AGE_MS（14 天）没被碰过就删：这条就是「没用的时候删掉」。
 *      读的时候顺手 touch 一次 mtime，所以天天在用的不会到期。
 *   5. 目录整体也有上限（MAX_FILES 个文件 / MAX_DIR_BYTES 字节），超了从最旧的开始删。
 *   6. 全部是派生值：删了不影响任何正确性，只是下次多算一会儿。
 *      **不许**把任何真相（事件、配置、她的判断）放进这里。
 *
 * 并发：写走 store.writeAtomic（tmp + rename）；两个进程同时写同一个指标，
 * 赢的那个留下，输的那个也只是一份等价的派生值，不需要锁。
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeAtomic } from './store.js'

/**
 * 记录格式版本。字段语义变了就升，旧文件会被当成坏的直接删。
 * v2（2026-11-17 晚）：加 checksum——缓存里存的是派生值，但派生值**也得自证**，
 * 不然一个手改过的 sum 会让设置页安安静静显示一个假数（AGENTS §20：缓存不是第二份真相）。
 */
export const CACHE_VERSION = 2

/** 单个缓存文件的上限。超过就不写（不是截断：截断的缓存比没有更糟）。 */
export const MAX_BYTES = 256 * 1024

/** 多久没被读过就算「没用了」。14 天。 */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** cache/ 目录里最多留几个文件。指标数现在是 2，留 8 给以后。 */
export const MAX_FILES = 8

/** cache/ 目录整体上限 1MB。两个 256KB 的缓存加起来也只有一半。 */
export const MAX_DIR_BYTES = 1024 * 1024

/** 缓存名只能是短横线小写：防止拼路径时跑出 cache/ 目录。 */
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

export function cacheDir(root) {
  return join(String(root), 'cache')
}

export function cachePath(root, name) {
  if (!NAME_RE.test(String(name ?? ''))) throw new Error(`缓存名不合法：${name}`)
  return join(cacheDir(root), `${name}.json`)
}

async function statOrNull(file) {
  try {
    return await fs.stat(file)
  } catch {
    return null
  }
}

async function removeFile(file) {
  try {
    // recursive：cache/ 里的东西全是派生的，连误建出来的子目录一起清掉。
    await fs.rm(file, { force: true, recursive: true })
    return true
  } catch {
    return false
  }
}

function fresh(rec, name) {
  return Boolean(
    rec &&
      typeof rec === 'object' &&
      !Array.isArray(rec) &&
      rec.v === CACHE_VERSION &&
      rec.name === name &&
      typeof rec.fingerprint === 'string' &&
      rec.fingerprint.length > 0,
  )
}

/**
 * 一条记录的校验和：把「会改变读数」的字段按固定顺序拼起来取 SHA-256。
 * 只防「文件被改坏/被手改」这一类，不防有意的伪造（那要靠重算，不是缓存的事）。
 */
function checksumOf(rec) {
  let data
  try {
    data = JSON.stringify(rec?.data)
  } catch {
    return ''
  }
  return createHash('sha256')
    .update(JSON.stringify([rec?.v, rec?.name, rec?.fingerprint, rec?.at, data]))
    .digest('hex')
}

/**
 * 读一条缓存记录。
 *
 * 返回 { v, name, fingerprint, at, data } 或 null。
 * 「没用的时候删掉」在这里落地：坏文件、版本不对、过期（mtime 超过 MAX_AGE_MS）
 * 一律当场删掉再返回 null；读到了就 touch 一下 mtime，让它继续活着。
 *
 * 任何 IO 错误都吞掉返回 null —— 缓存读不出来只是慢一点，不该拖垮请求。
 */
export async function readCache(root, name, opts = {}) {
  const now = Number(opts.now ?? Date.now())
  let file
  try {
    file = cachePath(root, name)
  } catch {
    return null
  }
  const st = await statOrNull(file)
  if (!st) return null
  // 过期检查用 mtime：读的时候会 touch，所以「天天在用」的不会到期。
  if (now - st.mtimeMs > MAX_AGE_MS) {
    await removeFile(file)
    return null
  }
  let rec
  try {
    const raw = await fs.readFile(file, 'utf8')
    rec = JSON.parse(raw)
  } catch {
    await removeFile(file)
    return null
  }
  if (!fresh(rec, name)) {
    await removeFile(file)
    return null
  }
  // 内容自证：checksum 对不上说明文件被改过（或写到一半坏了），当坏文件删掉重算。
  if (rec.checksum !== checksumOf(rec)) {
    await removeFile(file)
    return null
  }
  if (opts.touch !== false) {
    // 只动 mtime，不重写文件内容：一次 utimes 比一次原子写便宜得多。
    await fs.utimes(file, new Date(now), new Date(now)).catch(() => {})
  }
  return rec
}

/** 指纹一致才算命中；不一致返回 null（旧值留着，等下一次 write 覆盖）。 */
export async function readCacheValue(root, name, fingerprint, opts = {}) {
  const rec = await readCache(root, name, opts)
  if (!rec) return null
  if (rec.fingerprint !== String(fingerprint ?? '')) return null
  return rec.data ?? null
}

/**
 * 写一条缓存记录（覆盖式）。任何失败都返回 { ok:false, reason }，不抛。
 * 写完顺手 prune 一次：这样即使调用方忘了，磁盘也不会被撑大。
 */
export async function writeCache(root, name, fingerprint, data, opts = {}) {
  const now = Number(opts.now ?? Date.now())
  let file
  try {
    file = cachePath(root, name)
  } catch (err) {
    return { ok: false, reason: 'bad-name', error: String(err?.message ?? err) }
  }
  const fp = String(fingerprint ?? '')
  if (!fp) return { ok: false, reason: 'no-fingerprint' }
  const payload = { v: CACHE_VERSION, name, fingerprint: fp, at: now, data }
  payload.checksum = checksumOf(payload)
  let text
  try {
    text = JSON.stringify(payload)
  } catch (err) {
    return { ok: false, reason: 'serialize', error: String(err?.message ?? err) }
  }
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_BYTES) return { ok: false, reason: 'too-big', bytes }
  try {
    await writeAtomic(file, text, 0o600)
  } catch (err) {
    return { ok: false, reason: 'write', error: String(err?.message ?? err) }
  }
  await pruneCache(root, { now }).catch(() => {})
  return { ok: true, bytes, file }
}

/**
 * 清理：删过期的、删不是 .json 的、超数量/超总量时从最旧的开始删。
 * 永不抛。返回 { removed, kept, bytes }。
 */
export async function pruneCache(root, opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const dir = cacheDir(root)
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return { removed: 0, kept: 0, bytes: 0 }
  }
  const entries = []
  let removed = 0
  for (const name of names) {
    const file = join(dir, name)
    const st = await statOrNull(file)
    if (!st) continue
    if (!name.endsWith('.json') || !st.isFile()) {
      await removeFile(file)
      removed += 1
      continue
    }
    if (now - st.mtimeMs > MAX_AGE_MS) {
      await removeFile(file)
      removed += 1
      continue
    }
    entries.push({ name, file, bytes: st.size, mtime: st.mtimeMs })
  }
  entries.sort((a, b) => b.mtime - a.mtime) // 新的在前
  let bytes = 0
  const kept = []
  for (const e of entries) {
    const overCount = kept.length >= MAX_FILES
    const overBytes = bytes + e.bytes > MAX_DIR_BYTES
    if (overCount || overBytes) {
      await removeFile(e.file)
      removed += 1
      continue
    }
    kept.push(e.name)
    bytes += e.bytes
  }
  return { removed, kept: kept.length, bytes }
}

/** 全部删掉（测试 / 自检 / 重置前用）。永不抛。 */
export async function clearCache(root) {
  try {
    await fs.rm(cacheDir(root), { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 给自检/测试看：目录里有什么、多大。永不抛。 */
export async function cacheInfo(root) {
  const dir = cacheDir(root)
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return { dir, files: [], bytes: 0 }
  }
  const files = []
  let bytes = 0
  for (const name of names) {
    const st = await statOrNull(join(dir, name))
    if (!st) continue
    files.push({ name, bytes: st.size, mtime: st.mtimeMs })
    bytes += st.size
  }
  return { dir, files, bytes }
}
