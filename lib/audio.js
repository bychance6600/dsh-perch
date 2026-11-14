/**
 * audio.js —— 把任意常见音频变成「耳朵」能吃的 WAV。
 *
 * 为什么要有这一层（2026-11-14）：QQ 的语音（amr / silk / mp3 / m4a / ogg…）不是
 * 16kHz 单声道 PCM16 WAV，宿主 speechToText（见 lib/senses.js）只吃这个格式。
 * 所以入站语音要先经 ffmpeg 转一道；没有 ffmpeg、或者桥给的是 ffmpeg 解不了的
 * silk，就如实报失败——上层会把这条记成「没听清」，绝不猜内容。
 *
 * 依赖只有 ffmpeg（运行时资产，见 AGENTS §15），不引第三方包（AGENTS §1）。
 * ffmpeg 的查找顺序不在这里重复：`media.js` 的 `detectFfmpeg()` 已经定好了
 * （DSH_ROOST_FFMPEG → 自带 bin/<平台>-<架构> → PATH），调用方把 bin 传进来。
 *
 * 临时文件：解码结果先写 `os.tmpdir()` 下随机命名的 .wav，读成 Buffer 后**立刻删**；
 * 下载的源文件也落在 os.tmpdir()，由 `downloadAudio()` 返回的 `cleanup()` 负责删。
 * 两个函数都不抛「业务失败」：
 *   - `decodeToWav` 成功返回 Buffer，失败**抛 Error**（message 里带 ffmpeg 的原因）；
 *   - `downloadAudio` 永不抛，返回 `{ ok:true, path, bytes, cleanup }` 或 `{ ok:false, why }`。
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 单条语音的下载上限：与入站图片一致（10MB）。更长的语音已经是「文件」而不是「话」了。 */
export const AUDIO_MAX_BYTES = 10 * 1024 * 1024
/** 下载超时：和入站图片用同一档（15s）。 */
export const AUDIO_DOWNLOAD_TIMEOUT_MS = 15_000
/** 转码超时：60s 的 16k 单声道 wav 只有 1.9MB，正常转码远用不完 30s。 */
export const TRANSCODE_TIMEOUT_MS = 30_000

/** URL/文件名后缀 → 临时文件后缀。判不出来就 .audio，ffmpeg 按内容自己认。 */
const AUDIO_EXT = {
  amr: 'amr', mp3: 'mp3', m4a: 'm4a', wav: 'wav', ogg: 'ogg', oga: 'oga',
  opus: 'opus', silk: 'silk', slk: 'silk', flac: 'flac', aac: 'aac', webm: 'webm',
}

function audioExtOf(target) {
  const clean = String(target ?? '').split('?')[0].split('#')[0]
  const dot = clean.lastIndexOf('.')
  const suffix = dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
  return AUDIO_EXT[suffix] ?? 'audio'
}

/**
 * 把 WAV 规整成「44 字节头 + fmt + data」的最简形态。
 *
 * 为什么需要（2026-11-14 真机）：ffmpeg 默认会写一个 LIST 元数据块，宿主的转写服务
 * 解析 WAV 时直接拒，报 `Invalid speech WAV`——它只认最朴素的布局。这里按最小
 * 结构重建，其他块（LIST/fact/…）一律丢掉。
 * @param {Buffer} buf 已是 RIFF/WAVE 的字节
 * @returns {Buffer}
 */
export function canonicalWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw new Error('WAV 太短')
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString('latin1')
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (body + size > buf.length) break
    if (id === 'fmt ' && fmt === null) fmt = buf.subarray(body, body + size)
    else if (id === 'data' && data === null) data = buf.subarray(body, body + size)
    if (fmt !== null && data !== null) break
    off = body + size + (size % 2)
  }
  if (fmt === null || fmt === null || data === null) throw new Error('WAV 里没有 fmt/data 块')
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8, 'latin1')
  head.write('fmt ', 12, 'latin1')
  head.writeUInt32LE(16, 16)
  // 只保留标准 16 字节 fmt 字段（PCM）；扩展格式（WAVE_FORMAT_EXTENSIBLE）时取前 16。
  fmt.copy(head, 20, 0, Math.min(16, fmt.length))
  if (fmt.length < 16) throw new Error('fmt 块不完整')
  head.write('data', 36, 'latin1')
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/**
 * 跑一次 ffmpeg（只收 stderr，用来报错）。成功 resolve，失败 reject(Error)。
 * 超时直接 SIGKILL：ffmpeg 卡在坏文件上时不会自己出来。
 */
function runFfmpeg(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let settled = false
    let timer = null
    let child = null

    const finish = (fn, value) => {
      if (settled) return false
      settled = true
      if (timer !== null) clearTimeout(timer)
      fn(value)
      return true
    }

    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      reject(new Error(`启动 ffmpeg 失败：${error?.message ?? error}`))
      return
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
      finish(reject, new Error(`转码超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer?.unref?.()

    child.stderr?.on('data', (chunk) => {
      // 只留最后一截：ffmpeg 的错误原因一般在末尾，前面的进度输出没价值。
      if (stderr.length < 4000) stderr += String(chunk)
    })
    child.on('error', (error) => finish(reject, new Error(`ffmpeg 起不来：${error?.message ?? error}`)))
    child.on('close', (code, signal) => {
      if (settled) return
      if (code === 0) { finish(resolve); return }
      const detail = stderr.trim().slice(-300) || '没有输出'
      finish(reject, new Error(`ffmpeg 退出码 ${code ?? signal ?? '?'}：${detail}`))
    })
  })
}

/**
 * 把任意常见音频转成 16kHz 单声道 PCM16 WAV。
 *
 * @param {string} inputPath 本地音频文件路径（调用方负责下载/清理）
 * @param {{ ffmpegPath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<Buffer>} WAV 字节
 * @throws {Error} 没有 ffmpeg / 输入解不了 / 超时 / 转出来是空的——消息里写着原因
 */
export async function decodeToWav(inputPath, { ffmpegPath = 'ffmpeg', timeoutMs = TRANSCODE_TIMEOUT_MS } = {}) {
  const input = String(inputPath ?? '').trim()
  if (input === '') throw new Error('没有音频文件')
  if (String(ffmpegPath ?? '').trim() === '') throw new Error('没找到 ffmpeg')

  const out = join(tmpdir(), `dsh-perch-wav-${randomUUID()}.wav`)
  try {
    await runFfmpeg(String(ffmpegPath), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', input,
      // 宿主的 speechToText 只吃这个规格（见 lib/senses.js 的 hear 注释）。
      // 不带元数据：ffmpeg 会写 LIST 块，宿主只认最朴素的 WAV（真机报过 Invalid speech WAV）。
      '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le',
      '-f', 'wav', out,
    ], timeoutMs)

    const wav = await fs.readFile(out)
    if (wav.length === 0) throw new Error('转出来是空 WAV')
    if (wav.slice(0, 4).toString('latin1') !== 'RIFF') throw new Error('转出来的不是 WAV')
    // 再规整一次：-map_metadata 能去掉大多数，但格式保证不能只靠它。
    return canonicalWav(wav)
  } finally {
    // 无论如何都删：临时目录里不许留她的语音。
    await fs.unlink(out).catch(() => {})
  }
}

/** 边下边量：超过 maxBytes 立刻放弃，不把内存当垃圾桶。 */
async function readCapped(res, maxBytes) {
  if (res.body !== null && res.body !== undefined && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) throw new Error('too-large')
      chunks.push(buf)
    }
    return Buffer.concat(chunks)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) throw new Error('too-large')
  return buf
}

/**
 * 下载一段语音到 `os.tmpdir()` 的临时文件，交给 transcode 去解。
 * **永不抛**：调用方（QQ 适配器）只按 {ok, why} 记「没听清」。
 *
 * @param {string} url http(s) 地址
 * @param {{ maxBytes?: number, timeoutMs?: number, fetchImpl?: Function }} [opts]
 * @returns {Promise<{ok:true, path:string, bytes:number, cleanup:()=>Promise<void>}
 *                  |{ok:false, why:string}>}
 */
export async function downloadAudio(url, {
  maxBytes = AUDIO_MAX_BYTES,
  timeoutMs = AUDIO_DOWNLOAD_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = String(url ?? '').trim()
  if (target === '') return { ok: false, why: '没有音频地址' }
  if (typeof fetchImpl !== 'function') return { ok: false, why: '没有可用的 fetch' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('下载超时')), timeoutMs)
  timer?.unref?.()

  try {
    let res
    try {
      res = await fetchImpl(target, { signal: ac.signal })
    } catch (error) {
      const name = String(error?.name ?? '')
      return { ok: false, why: name === 'AbortError' ? `下载超时（${timeoutMs}ms）` : `下载失败：${error?.message ?? error}` }
    }
    if (res === null || typeof res !== 'object' || res.ok !== true) {
      return { ok: false, why: `HTTP ${res?.status ?? '?'}` }
    }
    const declared = Number(res.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, why: `音频太大（${(declared / 1048576).toFixed(1)}MB，上限 ${maxBytes / 1048576}MB）` }
    }

    let bytes
    try {
      bytes = await readCapped(res, maxBytes)
    } catch (error) {
      if (String(error?.message ?? '') === 'too-large') {
        return { ok: false, why: `音频太大（上限 ${maxBytes / 1048576}MB）` }
      }
      return { ok: false, why: `下载失败：${error?.message ?? error}` }
    }
    if (bytes.length === 0) return { ok: false, why: '空的音频' }

    const path = join(tmpdir(), `dsh-perch-audio-${randomUUID()}.${audioExtOf(target)}`)
    try {
      await fs.writeFile(path, bytes, { mode: 0o600 })
    } catch (error) {
      return { ok: false, why: `临时文件写不进去：${error?.message ?? error}` }
    }
    return {
      ok: true,
      path,
      bytes: bytes.length,
      cleanup: async () => { await fs.unlink(path).catch(() => {}) },
    }
  } finally {
    clearTimeout(timer)
  }
}
