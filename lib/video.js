/**
 * video.js —— 让她真的「看过」一条视频，而不是只读了它的简介
 *
 * 之前她判断一条视频好不好，全靠标题/简介/标签/弹幕——那些是别人替她写的字。
 * 这个模块只做一件事：从视频里取 9 帧，拼成一张 3×3 的图，存成文件。
 * 之后 she 用 read_image 读它，等于一次看完整条视频的关键画面。
 *
 * 为什么不用 yt-dlp / 不下载整段：
 *   - B 站给了 dash 播放地址，ffmpeg 能直接从 http 拉流并 seek；
 *   - 抽 9 帧只要几次短 seek，合计几秒、几 MB，而不是把 40MB 全下下来；
 *   - 少一个依赖（yt-dlp）就少一处要用户装的东西。
 *
 * 为什么抽 9 帧、为什么不按镜头切换：
 *   跨整条视频找镜头切换要读完整个流（网络代价 = 全量下载）。
 *   9 帧是**覆盖优先**的折中：看得见"这条视频大致是什么样"，
 *   而不是"某一分钟里切了几个镜头"。
 *
 * 2026-11-01：从「等距九帧」改成「分段抖动」，并给 bili_watch 补了 at（用户 m02712）。
 *   等距的问题是：同一条视频每次取到的都是那同九张图，反复看等于看同一张拼图。
 *   抖动之后每段仍必有帧（覆盖不丢），但每次取到的时刻不同。
 *   她要细看某一刻，就用 at 点名要那一秒，不必再靠猜。
 *
 * 2026-10-30 改（GitHub issue #13「看画面在 workspace-write 下必然失败」）
 *   1. 帧与拼图**一律走 stdout 管道**，由插件自己 fs.writeFile。
 *      为什么：DSH 的文件策略会限制 ffmpeg 这类子进程往 ~/.dsh-roost 写文件
 *      （`[image2] Could not open file … Permission denied`，exit -13），
 *      而插件进程本身写得进去。以前把输出路径直接交给 ffmpeg，于是现象是
 *      「playurl 明明正常、就是一帧都取不到」，还被归因成「被风控」。
 *      改成管道后子进程只往 stdout 吐字节，一个写权限都不需要，
 *      连中间帧的临时目录也整个省掉了（拼图时把各帧 PNG 顺序拼起来喂 stdin）。
 *   2. 失败原因改成**真实的**：带 ffmpeg 退出码 + stderr 前两行，
 *      并 appends 到 media/ffmpeg.log（已脱敏），不再用「可能被风控」这种猜。
 *   3. `-headers` / TLS 参数只在 http(s) 输入时才加：它们是网络协议私有选项，
 *      对本地文件输入会直接 `Option headers not found.` 退出 1（2026-10-30 实测）。
 *   4. 2026-11-07 真机：ffmpeg 9 的 `tls_verify` 默认变成了 true，而 gnutls 那份
 *      Windows 构建没带上可用的根证书，于是 `bili_watch` 在 `[tls] Peer certificate
 *      failed verification` 上一帧都取不到。不能退回 `-tls_verify 0`——那等于为了
 *      能看图就把整条链路的证书校验关掉。改成把 Node 自带的根证书写进
 *      `media/ffmpeg-ca.pem`，再显式 `-tls_verify 1 -ca_file`。用户用
 *      `DSH_ROOST_CA_FILE` / `o.caFile` 指定时仍以他给的为准。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { spawn } from 'node:child_process'
import { detectFfmpeg, mediaDir } from './media.js'
import { composeBoard, encodePng } from './frames.js'
import { createClient } from './bili.js'
import { slashed } from './posix.js'
import { rootDir, readOwner } from './store.js'
import { scrub } from './log.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 一帧用掉多少秒的网络等待上限
const FRAME_TIMEOUT_MS = 25_000

// stdout 上限：帧是缩到 360px 宽的 PNG，正常一帧几十 KB；这个上限只防意外
const STDOUT_MAX_BYTES = 32 * 1024 * 1024
const STDERR_MAX = 4000

// PNG 魔数：管道输出**必须**校验，否则 ffmpeg 把报错写进 stdout 时会被当成图落盘
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isHttp(url) {
  return /^https?:\/\//i.test(String(url ?? ''))
}

/**
 * 跑一次 ffmpeg，同时收 stdout 与 stderr。不抛。
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?:number, stdin?:Buffer|null}} [o]
 * @returns {Promise<{code:number, stderr:string, stdout:Buffer}>}
 */
function runFfmpeg(bin, args, o = {}) {
  const timeoutMs = o.timeoutMs ?? FRAME_TIMEOUT_MS
  const stdin = o.stdin ?? null
  return new Promise((resolve) => {
    let err = ''
    let outLen = 0
    let overflow = false
    const chunks = []
    let done = false
    let timer = null

    const finish = (code) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      // 输出超上限时退出码可能还是 0，但字节已经被扔了；用 -4 标出来，
      // 免得 describe() 说成「退出码 0」让人以为成功。
      resolve({ code: overflow ? -4 : code, stderr: err, stdout: Buffer.concat(chunks) })
    }

    let p
    try {
      // stdio[0]：喂管道时接 stdin，否则一律 ignore——ffmpeg 会读 stdin 等交互指令，
      // 在无终端环境下留着它可能把进程挂住。
      p = spawn(bin, args, {
        windowsHide: true,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ code: -2, stderr: String(e?.message ?? e), stdout: Buffer.alloc(0) })
      return
    }

    timer = setTimeout(() => {
      if (done) return
      try { p.kill('SIGKILL') } catch { /* ignore */ }
      err += '\n(timeout)'
      finish(-1)
    }, timeoutMs)

    p.stdout.on('data', (c) => {
      if (overflow) return
      outLen += c.length
      // 超上限时**整份丢掉**，不要留半截：截断的 PNG 可能魔数还对、看起来像张图，
      // 那比直接失败更难查。宁可报「输出太大」。
      if (outLen > STDOUT_MAX_BYTES) {
        overflow = true
        chunks.length = 0
        err += `\n(stdout 超过 ${STDOUT_MAX_BYTES} 字节，已丢弃)`
        return
      }
      chunks.push(c)
    })
    p.stderr.on('data', (c) => { if (err.length < STDERR_MAX) err += String(c) })
    p.on('error', (e) => { err += String(e?.message ?? e); finish(-2) })
    p.on('close', (code) => finish(code ?? -3))

    if (stdin) {
      // EPIPE：ffmpeg 提前退出时写 stdin 会报，不能让它变成未捕获异常
      p.stdin.on('error', () => { /* ignore */ })
      p.stdin.end(stdin)
    }
  })
}

/** stderr 前 n 行（去掉空行），用于把失败说清楚 */
function firstLines(s, n = 2) {
  return String(s ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' / ')
}

/** 把一次 ffmpeg 运行说成人能看懂的一句（带退出码，这是以前最缺的东西） */
function describe(r, noImage = false) {
  // 过一遍 scrub：stderr 里可能带签名播放地址（有时还带 Cookie 参数），
  // 这句话既会进日志、也会被 watch.js 当作 note 直接交给模型，两处都不该有凭据。
  const why = scrub(firstLines(r?.stderr) || '没有 stderr 输出')
  if (r?.code === -1) return `超时（${why}）`
  if (r?.code === -2) return `启动失败：${why}`
  if (r?.code === -4) return `输出太大，已丢弃（${why}）`
  // 退出码 0 却没拿到图：ffmpeg 正常退出了，但吐的不是 PNG（或短得离谱）。
  // 这时说「退出码 0」会让人以为没问题，得单独说清楚。
  if (r?.code === 0 && noImage) return `ffmpeg 正常退出，但没吐出可用的图（${why}）`
  return `ffmpeg 退出码 ${r?.code}：${why}`
}

/** 从一次运行的 stdout 里取 PNG；不是 PNG 就返回 null（不拿报错当图） */
function pngOf(r) {
  if (!r || r.code !== 0) return null
  const buf = r.stdout
  if (!Buffer.isBuffer(buf) || buf.length <= 512) return null
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null
  return buf
}

/**
 * 把 ffmpeg 的失败细节落到 media/ffmpeg.log。
 * 为什么要单独一份：用户导出日志时常常只带 logs/，而这里放的是子进程原始输出；
 * 过 scrub 是因为 stderr 里可能出现带 token 的播放地址。
 */
async function appendFfmpegLog(root, text) {
  try {
    const dir = await mediaDir(root)
    await fs.appendFile(join(dir, 'ffmpeg.log'), `${new Date().toISOString()} ${scrub(text)}\n`, 'utf8')
  } catch { /* 日志写不进去不能连累主流程 */ }
}

/** B 站直链要 Referer + UA + cookie 才给拉；缺一样就是 403 */
function headersFor(bvid, cookie) {
  const lines = [
    `Referer: https://www.bilibili.com/video/${bvid}`,
    `User-Agent: ${UA}`,
    'Accept: */*',
  ]
  if (cookie) lines.push(`Cookie: ${cookie}`)
  return lines.join('\r\n') + '\r\n'
}

/**
 * 帧时刻：把可用区间切成 n 段，每段在中间 60% 里随机取一点。
 *
 * 中间 60% 是留边：不许贴段边界，否则相邻两帧可能挤到同一秒；
 * 也避免第一帧落回片头黑场、最后一帧落回片尾下滑栏。
 * 时刻严格递增，所以 seek 仍然只往前跑。
 *
 * @param {number} duration 秒；<=0 表示不知道时长
 * @param {number} n 要几帧
 * @param {() => number} [rand] 注入的随机源（单测用，默认 Math.random）
 */
export function sampleTimes(duration, n, rand = Math.random) {
  const count = Math.max(1, Math.min(16, Number(n ?? 9)))
  const times = []
  if (!(duration > 0)) {
    // 不知道时长就按固定间隔退回去：这时抖动没有分母可算
    for (let i = 0; i < count; i++) times.push(i * 5)
    return times
  }
  const lo = duration * 0.04
  const hi = duration * 0.96
  const span = Math.max(0, hi - lo)
  const seg = span / count
  for (let i = 0; i < count; i++) {
    const a = lo + seg * i + seg * 0.2
    const b = lo + seg * (i + 1) - seg * 0.2
    const v = Number(rand())
    const r = Number.isFinite(v) ? Math.max(0, Math.min(0.999, v)) : 0.5
    times.push(a + (b - a) * r)
  }
  return times
}

/**
 * 她点名的时刻：接受一个数或一个数组（秒），越界的夹回片内，乱写的丢掉。
 * 一条都不合法就返回空数组——调用方据此退回自动抖动，或者干脆告诉她看不懂。
 */
export function normalizeAt(at, duration = 0) {
  const raw = Array.isArray(at) ? at : at === undefined || at === null || at === '' ? [] : [at]
  const cap = duration > 0 ? Math.max(0, duration - 0.5) : Infinity
  const out = []
  for (const v of raw) {
    // null / '' / 布尔会被 Number() 悄悄变成 0——那不是她点名的时刻，是没写
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') continue
    const t = Number(v)
    if (!Number.isFinite(t) || t < 0) continue
    out.push(Math.min(t, cap))
    if (out.length >= 16) break
  }
  // 递增，ffmpeg 就不用来回 seek
  return out.sort((x, y) => x - y)
}

/**
 * 细节档：一条视频看多细。
 * compact 省流量与时间，fine 给细节，normal 是默认。
 */
export const DETAIL = {
  compact: { cell: 240, samples: 8, wave: false, budget: 320_000 },
  normal: { cell: 320, samples: 12, wave: true, budget: 480_000 },
  fine: { cell: 480, samples: 18, wave: true, budget: 900_000 },
}

/** 把一次 ffmpeg 的 stdout 当 rawvideo 解出一帧（rgb24）。 */
async function extractRaw({ bin, url, headers, time, width, timeoutMs = 20_000, extra = [] }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(headers ? ['-headers', headers] : []),
    ...(Array.isArray(extra) ? extra : []),
    '-ss', String(Math.max(0, Number(time) || 0)),
    '-i', url,
    '-frames:v', '1',
    '-vf', `scale=${Math.max(16, Math.round(width))}:-2`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]
  const r = await runFfmpeg(bin, args, { timeoutMs })
  if (r.code !== 0 || !r.stdout?.length) return { ok: false, why: describe(r, true) }
  const w = Math.max(16, Math.round(width))
  const h = r.stdout.length / (w * 3)
  if (!Number.isInteger(h) || h < 2) return { ok: false, why: describe(r, true) }
  return { ok: true, width: w, height: h, data: r.stdout }
}

/** 32×18 的灰度指纹：只为比较「这一帧和上一帧像不像」，不给人看。 */
function signature(frame) {
  const gw = 32
  const gh = 18
  const out = new Float32Array(gw * gh)
  for (let y = 0; y < gh; y += 1) {
    const sy = Math.min(frame.height - 1, Math.floor(((y + 0.5) / gh) * frame.height))
    for (let x = 0; x < gw; x += 1) {
      const sx = Math.min(frame.width - 1, Math.floor(((x + 0.5) / gw) * frame.width))
      const i = (sy * frame.width + sx) * 3
      out[y * gw + x] = (frame.data[i] * 0.299 + frame.data[i + 1] * 0.587 + frame.data[i + 2] * 0.114) / 255
    }
  }
  return out
}

/** 两帧的平均亮度差（0..1）。 */
export function frameDiff(a, b) {
  if (!a || !b) return 0
  // 采样点包了一层 { t, frame, sig }，直接传整条采样也能比（A8 单测踩到过）。
  const sa = a.sig ?? signature(a.frame ?? a)
  const sb = b.sig ?? signature(b.frame ?? b)
  let sum = 0
  for (let i = 0; i < sa.length; i += 1) sum += Math.abs(sa[i] - sb[i])
  return sum / sa.length
}

/**
 * 从候选采样里挑切点：变化大的优先，同时保证时间上有间隔、覆盖全片。
 * 纯函数，单测直接喂假数据。
 *
 * @param {{t:number,frame?:object,sig?:Float32Array}[]} samples 按时间升序
 * @param {number} want 要几格
 */
export function pickSceneTimes(samples = [], want = 9) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(Number(s.t)))
    .map((s) => ({ ...s, t: Math.max(0, Number(s.t)) }))
    .sort((a, b) => a.t - b.t)
  const n = Math.max(1, Math.min(16, Math.floor(Number(want) || 9)))
  if (list.length <= n) return list.map((s) => s.t)

  const score = list.map((s, i) => ({
    i,
    t: s.t,
    d: i === 0 ? 1 : frameDiff(list[i - 1], s),
  }))
  const span = Math.max(0.01, list[list.length - 1].t - list[0].t)
  const minGap = Math.max(0.35, span / (n * 1.6))
  const picked = []
  for (const row of [...score].sort((a, b) => b.d - a.d)) {
    if (picked.length >= n) break
    if (picked.some((p) => Math.abs(p.t - row.t) < minGap)) continue
    picked.push(row)
  }
  // 切点不够就按等距补，保证覆盖，而不是把空位留白。
  if (picked.length < n) {
    for (let k = 0; k < n && picked.length < n; k += 1) {
      const t = list[0].t + (span * (k + 0.5)) / n
      if (picked.some((p) => Math.abs(p.t - t) < minGap * 0.5)) continue
      picked.push({ i: 0, t, d: 0 })
    }
  }
  return picked.map((p) => p.t).sort((a, b) => a - b).slice(0, n)
}

/** 字幕里按一句话找回大致时间码：先找整句，再退到两字切片命中。 */
export function matchCues(cues = [], phrase = '', limit = 5) {
  const q = String(phrase ?? '').trim()
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const nq = norm(q)
  if (nq.length < 2) return []
  const grams = []
  for (let i = 0; i + 2 <= nq.length; i += 1) grams.push(nq.slice(i, i + 2))
  const rows = []
  for (const c of Array.isArray(cues) ? cues : []) {
    const text = String(c?.text ?? '').trim()
    if (!text) continue
    const nt = norm(text)
    let score = 0
    if (nt.includes(nq)) score = 1 + nq.length / Math.max(1, nt.length)
    else {
      for (const g of new Set(grams)) if (nt.includes(g)) score += 1
      score = score / Math.max(1, grams.length)
    }
    if (score > 0) rows.push({ t: Math.max(0, Number(c?.t) || 0), text, score })
  }
  return rows.sort((a, b) => b.score - a.score || a.t - b.t).slice(0, Math.max(1, limit))
}

/** PCM s16le → 每段一个 0..1 的峰值数组（每段最多 peaksPer 根柱）。 */
export function wavePeaks(pcm, segments = [], peaksPer = 24) {
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.alloc(0)
  const total = Math.floor(buf.length / 2)
  if (!total) return segments.map(() => [])
  return segments.map(([a, b]) => {
    const s = Math.max(0, Math.min(total - 1, Math.floor(a * total)))
    const e = Math.max(s + 1, Math.min(total, Math.floor(b * total)))
    const out = []
    const step = Math.max(1, Math.floor((e - s) / peaksPer))
    for (let i = s; i < e && out.length < peaksPer; i += step) {
      let peak = 0
      const stop = Math.min(e, i + step)
      for (let j = i; j < stop; j += 1) peak = Math.max(peak, Math.abs(buf.readInt16LE(j * 2)))
      out.push(Math.min(1, peak / 32768))
    }
    return out
  })
}

async function scanCandidates({ bin, url, headers, duration, count, extra = [] }) {
  const times = sampleTimes(duration, count)
  const samples = []
  for (const t of times) {
    const got = await extractRaw({ bin, url, headers, time: t, width: 96, timeoutMs: 12_000, extra })
    if (got?.ok) samples.push({ t, frame: got, sig: signature(got) })
  }
  return samples
}

async function grabWave({ bin, url, headers, duration, times, extra = [] }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(headers ? ['-headers', headers] : []),
    ...(Array.isArray(extra) ? extra : []),
    '-i', url,
    '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-',
  ]
  const r = await runFfmpeg(bin, args, { timeoutMs: 45_000 })
  if (r.code !== 0 || !r.stdout?.length) return null
  const segs = times.map((t, i) => {
    const next = i + 1 < times.length ? times[i + 1] : (duration > 0 ? duration : t + 1)
    return [t / Math.max(0.01, duration || next), next / Math.max(0.01, duration || next)]
  })
  return wavePeaks(r.stdout, segs)
}

function chunkTimes(times, boards) {
  const n = Math.max(1, Math.min(3, Math.floor(Number(boards) || 1)))
  if (n <= 1 || times.length <= n) return [times]
  const out = []
  const per = Math.ceil(times.length / n)
  for (let i = 0; i < times.length; i += per) out.push(times.slice(i, i + per))
  return out
}

/**
 * 按一句话找回大致时间码：读官方/AI 字幕，匹配到就给出秒数。
 * 没字幕就直说没字幕，不拿弹幕或猜来凑。
 */
export async function findMoment(o = {}) {
  const root = o.root ?? rootDir()
  const bvid = String(o.bvid ?? '').trim()
  const phrase = String(o.find ?? o.phrase ?? '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return { ok: false, why: '不是 BV 号', cues: [] }
  if (phrase.length < 2) return { ok: false, why: '要给我一句话，至少两个字。', cues: [] }
  let cookie = ''
  try { cookie = (await readOwner(root))?.cookie ?? '' } catch { cookie = '' }
  const client = o.client ?? createClient({ cookie })
  let info
  try { info = await client.view(bvid) } catch (e) {
    return { ok: false, why: String(e?.message ?? e), cues: [] }
  }
  if (!info?.ok) return { ok: false, why: info?.message ?? '取不到这条视频的信息', cues: [] }
  const cid = info.data?.cid
  if (!cid) return { ok: false, why: '取不到分P信息（cid）', cues: [] }
  if (typeof client.subtitle !== 'function') return { ok: false, why: '这条拿不到字幕', cues: [] }
  let sub
  try { sub = await client.subtitle(bvid, cid) } catch (e) {
    return { ok: false, why: String(e?.message ?? e), cues: [] }
  }
  if (!sub?.ok || !Array.isArray(sub.data) || !sub.data.length) {
    return { ok: false, why: sub?.message || '这条没有字幕轨（或需要登录）', cues: [] }
  }
  const cues = matchCues(sub.data, phrase)
  if (!cues.length) return { ok: false, why: '字幕里没找到这句话。', cues: [] }
  return { ok: true, why: '', cues, title: String(info.data?.title ?? '') }
}

/**
 * 看一条视频：先探容器头/时长，再按画面变化挑切点，拼成带格号、时间码、波形的故事板。
 *
 * @param {object} o
 * @param {string} o.bvid
 * @param {object} [o.client] 注入的 bili 客户端（单测用假的）
 * @param {string} [o.root]
 * @param {number} [o.frames] 每张几格
 * @param {number} [o.boards] 看几张（1–3）
 * @param {'compact'|'normal'|'fine'} [o.detail]
 * @param {number} [o.quality] 16/32/64/80
 * @param {number|number[]} [o.at] 她点名的时刻（秒）
 * @param {number} [o.from] 只重扫这一段（秒）
 * @param {number} [o.to]
 */
const CA_PEM = rootCertificates.map((c) => String(c).trim()).filter(Boolean).join('\n') + '\n'

/**
 * 给 ffmpeg 用的根证书文件。放在 media/ 里（和 ffmpeg.log 同处），内容来自 Node
 * 自带的 `tls.rootCertificates`。只写一次；内容变了（Node 升级）才重写。
 *
 * 为什么要自己写：2026-11-07 真机的 ffmpeg 9 + gnutls 在 Windows 上没人给它
 * 根证书，默认又开着 `tls_verify`，于是连 B 站 CDN 都握不上手。
 *
 * @param {string} root 数据目录
 * @returns {Promise<string>} PEM 文件路径
 */
export async function ensureCaFile(root) {
  if (!CA_PEM.trim()) throw new Error('Node 没有带根证书')
  const file = join(await mediaDir(root), 'ffmpeg-ca.pem')
  try {
    const old = await fs.readFile(file, 'utf8')
    if (old === CA_PEM) return file
  } catch { /* 没有就写一份 */ }
  await fs.writeFile(file, CA_PEM, 'utf8')
  return file
}

export async function grabFrames(o = {}) {
  const root = o.root ?? rootDir()
  const bvid = String(o.bvid ?? '').trim()
  const fail = (why, extra = {}) => ({
    ok: false, path: '', paths: [], why, title: '', up: '', view: 0, duration: 0,
    shots: 0, times: [], boards: [], ...extra,
  })

  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return fail('不是 BV 号')

  const explicitCa = String(o.caFile ?? process.env.DSH_ROOST_CA_FILE ?? '').trim()
  let cookie = ''
  try { cookie = (await readOwner(root))?.cookie ?? '' } catch { cookie = '' }

  const client = o.client ?? createClient({ cookie })
  let info
  try {
    info = await client.view(bvid)
  } catch (e) {
    return fail(String(e?.message ?? e))
  }
  if (!info?.ok) return fail(info?.message ?? '取不到这条视频的信息')

  const cid = info.data?.cid
  if (!cid) return fail('取不到分P信息（cid）')

  const detail = DETAIL[String(o.detail ?? '').trim()] ?? DETAIL.normal
  const quality = [16, 32, 64, 80].includes(Number(o.quality)) ? Number(o.quality) : 64
  let pu
  try {
    pu = await client.playurl(bvid, cid, { qn: quality })
  } catch (e) {
    return fail(String(e?.message ?? e))
  }
  if (!pu?.ok || !pu.data?.url) return fail(pu?.message ?? '拿不到播放地址（可能要登录或这条视频有地区限制）')

  const ff = o.ffmpeg ?? detectFfmpeg()
  if (!ff.ok) return fail(`本机没有可用的 ffmpeg（${ff.why}）。装好后重试，或先只看文字。`)

  const url = pu.data.url
  const audioUrl = String(pu.data.audioUrl ?? '')
  const duration = Number(info.data?.duration ?? pu.data?.duration ?? 0) || 0
  const net = isHttp(url)
  const headers = net ? headersFor(bvid, cookie) : ''
  const dir = await mediaDir(root)
  let caFile = explicitCa
  if (net && !caFile) {
    try { caFile = await ensureCaFile(root) } catch (e) {
      return fail(`证书文件写不出来（${String(e?.message ?? e)}），先只看文字吧。`)
    }
  }
  const netArgs = []
  if (net) {
    netArgs.push('-headers', headers)
    // 2026-11-07 真机：ffmpeg 9 默认校验证书，但它的 gnutls 构建没有根证书。
    // 显式喂 Node 带的根证书，并保持校验开着；不要为了能出图退回 tls_verify=0。
    netArgs.push('-tls_verify', '1', '-ca_file', caFile)
  }
  const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`

  // 时刻：点名 > 重扫一段 > 切点检测 > 等距兜底。
  const atRaw = o.at === undefined || o.at === null || o.at === '' ? [] : (Array.isArray(o.at) ? o.at : [o.at])
  const asked = normalizeAt(o.at, duration)
  if (atRaw.length && !asked.length) return fail('给的时间点看不懂——要秒数，比如 90 或 [30, 90]。')

  const from = Number(o.from)
  const to = Number(o.to)
  const hasRange = Number.isFinite(from) || Number.isFinite(to)
  const lo = Number.isFinite(from) ? Math.max(0, from) : 0
  const hi = Number.isFinite(to) ? Math.max(lo + 0.5, to) : (duration > 0 ? duration : lo + 60)

  let times = []
  if (asked.length) times = asked.filter((t) => t >= lo && t <= hi)
  if (!times.length && hasRange) {
    times = sampleTimes(hi - lo, o.frames ?? 9).map((t) => Math.min(hi - 0.1, lo + t))
  }
  if (times.length && asked.length === 0 && !hasRange) {
    // 问了 at 就按 at，不掺切点；否则走切点检测。
  }

  if (!times.length) {
    const want = Math.max(1, Math.min(16, Number(o.frames ?? 9) || 9))
    const samples = await scanCandidates({
      bin: ff.bin, url, headers, duration, extra: netArgs,
      count: Math.min(24, Math.max(detail.samples, want * 2)),
    })
    if (samples.length >= 2) times = pickSceneTimes(samples, want)
    if (!times.length) times = sampleTimes(duration, want)
  }

  // 分张：每张故事板几格；一张放不下就按时间切连续段。
  const groups = chunkTimes(times, o.boards ?? 1)

  // 音频波形：失败就退化成没有波形，不拦着看图。
  let waves = null
  if (detail.wave && audioUrl) {
    try {
      const wave = await grabWave({ bin: ff.bin, url: audioUrl, headers, duration, times, extra: netArgs })
      if (wave) waves = wave
    } catch { /* 波形是加分项，不是必需项 */ }
  }

  const boards = []
  const allTimes = []
  const paths = []
  let shots = 0
  let firstFail = ''

  for (let b = 0; b < groups.length; b += 1) {
    const group = groups[b]
    const frames = []
    const used = []
    for (let i = 0; i < group.length; i += 1) {
      const t = group[i]
      let got = await extractRaw({ bin: ff.bin, url, headers, time: t, width: detail.cell, extra: netArgs })
      if (!got?.ok) {
        const back = duration > 0 ? Math.min(duration - 0.5, t + 1.5) : t + 1.5
        got = await extractRaw({ bin: ff.bin, url, headers, time: Math.max(0, back), width: detail.cell, extra: netArgs })
      }
      if (got?.ok) {
        frames.push(got)
        used.push(t)
      } else if (!firstFail) firstFail = got?.why || '取不到画面'
    }
    if (frames.length < 1) continue

    const globalOffset = times.indexOf(group[0])
    const groupWaves = waves ? frames.map((_, i) => waves[globalOffset + i] ?? []) : []
    const board = composeBoard({ frames, times: used, waves: groupWaves, budget: detail.budget })
    const png = encodePng(board.width, board.height, board.buffer)
    const file = join(dir, `sheet-${bvid}-${stamp}-${b + 1}.png`)
    await fs.writeFile(file, png)
    const rel = slashed(file)
    paths.push(rel)
    boards.push({ path: rel, times: used.map((t) => Math.round(t * 10) / 10), cells: board.cells.length, width: board.width, height: board.height })
    allTimes.push(...used)
    shots += frames.length
  }

  if (!paths.length) {
    const why = firstFail || 'ffmpeg 没有输出任何帧'
    await appendFfmpegLog(root, `grab ${bvid} failed: ${why}`)
    return fail(`一帧都没取到：${why}`)
  }

  return {
    ok: true,
    path: paths[0],
    paths,
    why: '',
    title: String(info.data?.title ?? ''),
    up: String(info.data?.up ?? ''),
    view: Number(info.data?.view) || 0,
    duration,
    shots,
    times: allTimes.map((t) => Math.round(t * 10) / 10),
    boards,
    detail: String(o.detail ?? 'normal'),
  }
}
