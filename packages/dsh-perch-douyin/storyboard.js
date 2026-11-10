/**
 * storyboard.js —— 抖音分镜（A25）
 *
 * 一条视频不再只给三张截图：按格编号拼成一张故事板，每格左下角写时间码，
 * 整张图的像素数不超过预算（默认 480000）。她看故事板时知道每格对应第几秒；
 * 觉得哪一格看不清，就用 sampleId + cell 要那一格的原始采样画面。
 *
 * 三条纪律：
 *   · 这是一次观看的采样，不是整条视频——文本里必须这么说，不许说成"看完了"；
 *   · 零依赖：JPEG/PNG 不引库，ffmpeg 只负责把视频解成 rawvideo，拼图与编号自己画；
 *   · 永不抛：拉不到、解不开、写不进都返回 { ok:false, why }。
 *
 * 借的是思路（SAOS-3624 / dsh-video-storyboard，MIT）：格编号徽标、时间码、像素预算、
 * zoom 按 sampleId+cell 回原图。代码是自己写的——这里没有 jpeg-js，也不引入任何依赖。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

export const PIXEL_BUDGET = 480_000
export const MAX_ZOOMS = 3
export const MAX_CALLS = 6
export const MAX_INVALID = 3
export const SAMPLE_TTL_MS = 2 * 60 * 60 * 1000
export const BOARD_PREFIX = 'dy-board-'
export const SOURCE_PREFIX = 'dy-src-'

const GUTTER = 4
const MIN_CELL = 64
const BG = [18, 18, 20]
const BADGE_BG = [0, 0, 0]
const BADGE_FG = [255, 235, 59]
const TIME_FG = [255, 255, 255]

const DIGITS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}
const DIGIT_W = 5
const DIGIT_H = 7

/** 时间码：分钟数不补零，秒补两位，例如 0:03、1:27。 */
export function timecode(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0))
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0')
}

/**
 * 选一组 (cols, rows)：让画布比例最接近源比例；多余格补灰，不硬塞。
 * @param {number} n 格数
 * @param {number} aspect 源画面宽/高
 */
export function bestLayout(n, aspect = 16 / 9) {
  const count = Math.max(1, Math.min(16, Math.floor(Number(n) || 1)))
  const a = Number(aspect) > 0 ? Number(aspect) : 16 / 9
  let best = null
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols)
    const canvas = (cols / rows) * a
    let cost = Math.abs(Math.log(canvas / a))
    if (canvas > a) cost += 0.12
    const padded = cols * rows - count
    const key = Math.round((cost + 0.15 * padded) * 1e6) / 1e6
    if (!best || key < best.key || (key === best.key && cols * rows < best.cells)) {
      best = { key, cols, rows, cells: cols * rows }
    }
  }
  return { cols: best.cols, rows: best.rows, capacity: best.cells }
}

/** 画布尺寸：整图面积 <= budget，格宽高按剩余空间均分。 */
export function layoutCanvas(cols, rows, cellAspect, budget = PIXEL_BUDGET, gutter = GUTTER) {
  const aspect = (cols * cellAspect) / rows
  const gw = Math.sqrt(Math.max(1, budget) * aspect)
  const gh = gw / aspect
  const cellW = Math.max(1, Math.floor((gw - gutter * (cols + 1)) / cols))
  const cellH = Math.max(1, Math.floor((gh - gutter * (rows + 1)) / rows))
  return {
    width: cols * cellW + gutter * (cols + 1),
    height: rows * cellH + gutter * (rows + 1),
    cellW,
    cellH,
  }
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0)

function fillRect(buf, width, height, x, y, w, h, color, alpha = 1) {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(width, x + w)
  const y1 = Math.min(height, y + h)
  const r = color[0]
  const g = color[1]
  const b = color[2]
  for (let py = y0; py < y1; py += 1) {
    let idx = (py * width + x0) * 3
    for (let px = x0; px < x1; px += 1) {
      if (alpha >= 1) {
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b
      } else {
        buf[idx] = clamp255(buf[idx] * (1 - alpha) + r * alpha)
        buf[idx + 1] = clamp255(buf[idx + 1] * (1 - alpha) + g * alpha)
        buf[idx + 2] = clamp255(buf[idx + 2] * (1 - alpha) + b * alpha)
      }
      idx += 3
    }
  }
}

function drawGlyph(buf, width, height, text, x, y, scale, color) {
  let cursor = x
  for (const ch of String(text)) {
    if (ch === ':') {
      const colW = Math.max(1, scale)
      fillRect(buf, width, height, cursor, y + Math.round(DIGIT_H * scale * 0.25), colW, colW, color)
      fillRect(buf, width, height, cursor, y + Math.round(DIGIT_H * scale * 0.7), colW, colW, color)
      cursor += (2 * scale)
      continue
    }
    if (ch === '.') {
      const dot = Math.max(1, scale)
      fillRect(buf, width, height, cursor, y + DIGIT_H * scale - dot, dot, dot, color)
      cursor += 2 * scale
      continue
    }
    const glyph = DIGITS[ch]
    if (!glyph) continue
    for (let row = 0; row < DIGIT_H; row += 1) {
      for (let col = 0; col < DIGIT_W; col += 1) {
        if (glyph[row][col] === '1') {
          fillRect(buf, width, height, cursor + col * scale, y + row * scale, scale, scale, color)
        }
      }
    }
    cursor += (DIGIT_W + 1) * scale
  }
  return cursor - x
}

function textWidth(text, scale) {
  let w = 0
  for (const ch of String(text)) w += (ch === ':' || ch === '.' ? 2 : DIGIT_W + 1) * scale
  return Math.max(0, w - scale)
}

function scaleFor(cellH, cellW, text, ratio) {
  const byHeight = Math.floor((cellH * ratio) / DIGIT_H)
  const byWidth = Math.floor((cellW * 0.8) / Math.max(1, textWidth(text, 1)))
  return Math.max(1, Math.min(byHeight, byWidth))
}

/** 左上角格编号：黑底黄字。 */
function drawBadge(buf, width, height, x, y, cellW, cellH, label) {
  const s = scaleFor(cellH, cellW, String(label), 0.2)
  const pad = Math.max(2, Math.round(cellH * 0.02))
  const tw = textWidth(String(label), s)
  fillRect(buf, width, height, x, y, tw + pad * 2, DIGIT_H * s + pad * 2, BADGE_BG, 0.9)
  drawGlyph(buf, width, height, String(label), x + pad, y + pad, s, BADGE_FG)
}

/** 左下角时间码：黑底白字。 */
function drawTime(buf, width, height, x, y, cellW, cellH, sec) {
  const text = timecode(sec)
  const s = scaleFor(cellH, cellW, text, 0.16)
  const pad = Math.max(2, Math.round(cellH * 0.02))
  const tw = textWidth(text, s)
  fillRect(buf, width, height, x, y + cellH - (DIGIT_H * s + pad * 2), tw + pad * 2, DIGIT_H * s + pad * 2, BADGE_BG, 0.85)
  drawGlyph(buf, width, height, text, x + pad, y + cellH - (DIGIT_H * s + pad), s, TIME_FG)
}

/** 最近邻缩放：一格一格贴，够快，也够看清。 */
function blitFit(buf, width, height, x, y, cellW, cellH, frame) {
  const sw = frame.width
  const sh = frame.height
  const ratio = Math.min(cellW / sw, cellH / sh)
  const w = Math.max(1, Math.floor(sw * ratio))
  const h = Math.max(1, Math.floor(sh * ratio))
  const left = x + Math.floor((cellW - w) / 2)
  const top = y + Math.floor((cellH - h) / 2)
  for (let ty = 0; ty < h; ty += 1) {
    const sy = Math.min(sh - 1, Math.floor((ty + 0.5) / ratio))
    const drow = (top + ty) * width
    for (let tx = 0; tx < w; tx += 1) {
      const sx = Math.min(sw - 1, Math.floor((tx + 0.5) / ratio))
      const si = (sy * sw + sx) * 3
      const di = (drow + left + tx) * 3
      buf[di] = frame.data[si]
      buf[di + 1] = frame.data[si + 1]
      buf[di + 2] = frame.data[si + 2]
    }
  }
}

/**
 * 拼一张故事板。frames 是原始 rgb24 帧，顺序即 1..n 格。
 * @returns {{buffer:Buffer,width:number,height:number,cellW:number,cellH:number,cells:object[]}}
 */
export function composeBoard({ frames, times = [], budget = PIXEL_BUDGET } = {}) {
  const list = Array.isArray(frames) ? frames.filter((f) => f && f.width > 0 && f.height > 0 && f.data) : []
  if (list.length < 2) throw new Error('故事板至少要两格')
  const aspect = list[0].width / list[0].height
  const { cols, rows } = bestLayout(list.length, aspect)
  let size = layoutCanvas(cols, rows, aspect, budget)
  // 预算很小时不许把格子压到看不清：先保底，再接受整图略超预算（调用方会如实报数）。
  if (size.cellW < MIN_CELL || size.cellH < MIN_CELL) {
    const need = Math.sqrt((MIN_CELL * cols) * (MIN_CELL * rows))
    size = layoutCanvas(cols, rows, aspect, Math.max(budget, need * need * 1.4))
  }
  const width = size.width
  const height = size.height
  const cellW = size.cellW
  const cellH = size.cellH
  const buffer = Buffer.alloc(width * height * 3)
  for (let i = 0; i < buffer.length; i += 3) {
    buffer[i] = BG[0]; buffer[i + 1] = BG[1]; buffer[i + 2] = BG[2]
  }
  const cells = []
  for (let pos = 0; pos < cols * rows; pos += 1) {
    const r = Math.floor(pos / cols)
    const c = pos % cols
    const x = GUTTER + c * (cellW + GUTTER)
    const y = GUTTER + r * (cellH + GUTTER)
    const frame = list[pos]
    if (!frame) {
      fillRect(buffer, width, height, x, y, cellW, cellH, [42, 42, 46])
      continue
    }
    blitFit(buffer, width, height, x, y, cellW, cellH, frame)
    const cell = pos + 1
    drawBadge(buffer, width, height, x + 2, y + 2, cellW, cellH, cell)
    drawTime(buffer, width, height, x, y, cellW, cellH, times[pos] ?? 0)
    cells.push({
      cell,
      row: r + 1,
      col: c + 1,
      time: Number(times[pos] ?? 0),
      timecode: timecode(times[pos] ?? 0),
    })
  }
  return { buffer, width, height, cellW, cellH, cells }
}

// ---- PNG 编码（零依赖） ----

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** rgb24 → PNG。只写必要块：IHDR / IDAT / IEND，逐行 filter 0。 */
export function encodePng(width, height, rgb) {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  if (!rgb || rgb.length < w * h * 3) throw new Error('PNG 数据不够')
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = zlib.deflateSync(raw, { level: 6 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 从 PNG 的 IHDR 里读宽高（测试与诊断用；不解码像素）。 */
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// ---- 抽帧 ----

/**
 * 用 ffmpeg 把某一秒解成 rgb24。width 固定，高按比例（-2 保证偶数）。
 * 只在这一个函数里碰子进程；测试可以整个换掉。
 */
export function extractFrame({ bin, input, time, width = 720 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin || 'ffmpeg', [
        '-v', 'error',
        '-ss', String(Math.max(0, Number(time) || 0)),
        '-i', input,
        '-frames:v', '1',
        '-vf', 'scale=' + width + ':-2',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        'pipe:1',
      ], { windowsHide: true })
    } catch (err) {
      resolve({ ok: false, why: String(err?.message ?? err).slice(0, 120) })
      return
    }
    const out = []
    let errText = ''
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => { errText = (errText + b.toString('utf8')).slice(-400) })
    child.on('error', (err) => resolve({ ok: false, why: String(err?.message ?? err).slice(0, 120) }))
    child.on('close', (code) => {
      const data = Buffer.concat(out)
      if (code !== 0 || !data.length) {
        resolve({ ok: false, why: errText.trim().slice(0, 120) || ('ffmpeg 退出 ' + code) })
        return
      }
      const h = data.length / (width * 3)
      if (!Number.isInteger(h) || h < 2) {
        resolve({ ok: false, why: '解出来的画面尺寸不对' })
        return
      }
      resolve({ ok: true, width, height: h, data })
    })
  })
}

function sampleFile(dir, sampleId, ext) {
  return path.join(dir, BOARD_PREFIX + sampleId + '.' + ext)
}

/** 失效的故事板：连图带元数据一起清掉。 */
export async function pruneSamples(dir, { now = Date.now(), ttlMs = SAMPLE_TTL_MS } = {}) {
  let names = []
  try { names = await fs.readdir(dir) } catch { return 0 }
  let n = 0
  for (const name of names) {
    if (!name.startsWith(BOARD_PREFIX) || !name.endsWith('.json')) continue
    const full = path.join(dir, name)
    try {
      const rec = JSON.parse(await fs.readFile(full, 'utf8'))
      const at = Date.parse(rec?.at ?? '')
      if (!Number.isFinite(at) || now - at > ttlMs) {
        await fs.rm(full, { force: true }).catch(() => {})
        for (const cell of rec?.cells ?? []) await fs.rm(cell.src, { force: true }).catch(() => {})
        await fs.rm(path.join(dir, BOARD_PREFIX + rec?.sampleId + '.png'), { force: true }).catch(() => {})
        n += 1
      }
    } catch { /* 读不出来的留给下一次 */ }
  }
  return n
}

/**
 * 做一张故事板并落盘。
 * @param {{bin:string,input:string,duration:number,outDir:string,id:string,count?:number,
 *          budget?:number,extract?:Function,now?:number,ttlMs?:number}} o
 */
export async function makeStoryboard(o = {}) {
  const bin = o.bin
  const input = o.input
  const duration = o.duration ?? 0
  const outDir = o.outDir
  const id = o.id ?? ''
  const count = o.count ?? 6
  const budget = o.budget ?? PIXEL_BUDGET
  const extract = o.extract ?? extractFrame
  const now = o.now ?? Date.now()
  const ttlMs = o.ttlMs ?? SAMPLE_TTL_MS
  if (!input) return { ok: false, why: '没有视频文件' }
  if (!outDir) return { ok: false, why: '没有放图的地方' }
  const total = Math.max(2, Math.min(16, Math.floor(Number(count) || 6)))
  const sampleId = randomBytes(6).toString('hex')
  try {
    await fs.mkdir(outDir, { recursive: true })
    await pruneSamples(outDir, { now, ttlMs }).catch(() => {})
    const dur = Number(duration) > 0 ? Number(duration) : total
    const times = []
    for (let i = 0; i < total; i += 1) {
      // 均匀取在每一段的中间：避开片头黑场，也不把最后一帧压在结尾。
      times.push(Math.max(0, Math.min(dur - 0.05, (dur * (i + 0.5)) / total)))
    }
    const frames = []
    const usedTimes = []
    for (const t of times) {
      const got = await extract({ bin, input, time: t, width: 720 })
      if (got?.ok && got.data?.length) {
        frames.push({ width: got.width, height: got.height, data: got.data })
        usedTimes.push(t)
      }
    }
    if (frames.length < 2) return { ok: false, why: '只解出一帧，拼不成故事板' }
    const board = composeBoard({ frames, times: usedTimes, budget })
    const png = encodePng(board.width, board.height, board.buffer)
    const boardPath = sampleFile(outDir, sampleId, 'png')
    await fs.writeFile(boardPath, png)
    const cells = []
    for (let i = 0; i < frames.length; i += 1) {
      const f = frames[i]
      const srcPath = path.join(outDir, SOURCE_PREFIX + sampleId + '-' + (i + 1) + '.png')
      await fs.writeFile(srcPath, encodePng(f.width, f.height, f.data))
      cells.push({ ...board.cells[i], src: srcPath })
    }
    const rec = {
      sampleId,
      videoId: String(id ?? ''),
      at: new Date(now).toISOString(),
      ttlMs,
      pixelBudget: budget,
      board: boardPath,
      width: board.width,
      height: board.height,
      boardPixels: board.width * board.height,
      cells,
      zoomCount: 0,
      calls: 0,
      invalidCount: 0,
      closed: false,
      closedWhy: '',
    }
    await fs.writeFile(sampleFile(outDir, sampleId, 'json'), JSON.stringify(rec, null, 2))
    return {
      ok: true,
      sampleId,
      path: boardPath,
      cells,
      width: board.width,
      height: board.height,
      boardPixels: board.width * board.height,
      count: frames.length,
    }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
  }
}

/** 读一张故事板的元数据。号不对/文件没了返回 null。 */
export async function readSample(dir, sampleId) {
  const id = String(sampleId ?? '').trim()
  if (!/^[a-f0-9]{6,40}$/.test(id)) return null
  try {
    return JSON.parse(await fs.readFile(sampleFile(dir, id, 'json'), 'utf8'))
  } catch {
    return null
  }
}

async function saveSample(dir, rec) {
  await fs.writeFile(sampleFile(dir, rec.sampleId, 'json'), JSON.stringify(rec, null, 2))
}

/**
 * 按 sampleId + cell 要一格原图。
 * 每次调用都算一次模型调用（预算 MAX_CALLS）；放大成功另有 MAX_ZOOMS 上限；
 * 连续 MAX_INVALID 次无效格号就停止这次观看（A25 的"连续三次无效决策"）。
 */
export async function zoomSample({ dir, sampleId, cell, now = Date.now() } = {}) {
  const rec = await readSample(dir, sampleId)
  if (!rec) return { ok: false, why: '这张故事板已经不在了（号不对或已经清理），重新打开一条再看。' }
  if (rec.closed) return { ok: false, why: rec.closedWhy || '这次观看已经停了。' }
  const at = Date.parse(rec.at ?? '')
  const ttl = Number(rec.ttlMs ?? SAMPLE_TTL_MS)
  if (!Number.isFinite(at) || now - at > ttl) {
    rec.closed = true
    rec.closedWhy = '这张故事板过期了，重新打开一条再看。'
    await saveSample(dir, rec).catch(() => {})
    return { ok: false, why: rec.closedWhy }
  }
  rec.calls = Number(rec.calls ?? 0) + 1
  if (rec.calls > MAX_CALLS) {
    rec.closed = true
    rec.closedWhy = '这次观看的调用预算用完了（' + MAX_CALLS + ' 次）——想看就重新打开一条。'
    await saveSample(dir, rec).catch(() => {})
    return { ok: false, why: rec.closedWhy }
  }
  const n = Number(cell)
  const list = Array.isArray(rec.cells) ? rec.cells : []
  if (!Number.isInteger(n) || n < 1 || n > list.length) {
    rec.invalidCount = Number(rec.invalidCount ?? 0) + 1
    if (rec.invalidCount >= MAX_INVALID) {
      rec.closed = true
      rec.closedWhy = '连续 ' + MAX_INVALID + ' 次格号不对，这次观看停了。'
    }
    await saveSample(dir, rec).catch(() => {})
    return {
      ok: false,
      why: rec.closed ? rec.closedWhy : ('没有第 ' + (Number.isFinite(n) ? n : '') + ' 格——这张图只有 ' + list.length + ' 格。'),
      invalid: true,
      remaining: Math.max(0, MAX_INVALID - rec.invalidCount),
    }
  }
  if (Number(rec.zoomCount ?? 0) >= MAX_ZOOMS) {
    await saveSample(dir, rec).catch(() => {})
    return { ok: false, why: '这次观看的放大次数用完了（' + MAX_ZOOMS + ' 次）——再看一条吧。' }
  }
  rec.zoomCount = Number(rec.zoomCount ?? 0) + 1
  rec.invalidCount = 0
  await saveSample(dir, rec).catch(() => {})
  const hit = list[n - 1]
  return {
    ok: true,
    path: hit.src,
    cell: n,
    time: hit.time,
    timecode: hit.timecode,
    remaining: Math.max(0, MAX_ZOOMS - rec.zoomCount),
  }
}
