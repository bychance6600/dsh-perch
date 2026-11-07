import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  PIXEL_BUDGET,
  MAX_ZOOMS,
  MAX_CALLS,
  MAX_INVALID,
  bestLayout,
  composeBoard,
  encodePng,
  makeStoryboard,
  pngSize,
  readSample,
  timecode,
  zoomSample,
} from '../packages/dsh-roost-douyin/storyboard.js'

function frame(w = 320, h = 568, shade = 90) {
  const data = Buffer.alloc(w * h * 3, shade)
  return { width: w, height: h, data }
}

async function tmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'roost-board-'))
}

function fakeExtract(w = 320, h = 568) {
  let n = 0
  return async () => {
    n += 1
    return { ok: true, width: w, height: h, data: frame(w, h, 40 + n * 20).data }
  }
}

test('时间码按分钟:秒写，分钟不补零', () => {
  assert.equal(timecode(0), '0:00')
  assert.equal(timecode(3.9), '0:03')
  assert.equal(timecode(67), '1:07')
  assert.equal(timecode(-4), '0:00')
})

test('故事板按预算排版：整图像素数不超过 480000，格数够用', () => {
  const frames = Array.from({ length: 6 }, () => frame(720, 1280, 80))
  const board = composeBoard({ frames, times: [0, 1, 2, 3, 4, 5] })
  assert.ok(board.width * board.height <= PIXEL_BUDGET, `${board.width * board.height} 超了预算`)
  assert.equal(board.cells.length, 6)
  assert.deepEqual(board.cells.map((c) => c.cell), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(board.cells.map((c) => c.timecode), ['0:00', '0:01', '0:02', '0:03', '0:04', '0:05'])
  const png = encodePng(board.width, board.height, board.buffer)
  assert.deepEqual(pngSize(png), { width: board.width, height: board.height })
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
})

test('格数是奇数时多出来的位置补灰，不编号', () => {
  const board = composeBoard({ frames: Array.from({ length: 5 }, () => frame()), times: [0, 1, 2, 3, 4] })
  assert.equal(board.cells.length, 5)
  assert.equal(board.cells[4].cell, 5)
  const { cols, rows } = bestLayout(5, 320 / 568)
  assert.equal(cols * rows >= 5, true)
})

test('做一张故事板：图、元数据、每格原图都落盘，预算照报', async () => {
  const dir = await tmp()
  const made = await makeStoryboard({
    bin: 'ffmpeg',
    input: 'fake.mp4',
    duration: 30,
    outDir: dir,
    id: '123456789',
    count: 6,
    extract: fakeExtract(),
    now: Date.parse('2026-11-07T03:00:00Z'),
  })
  assert.equal(made.ok, true)
  assert.match(made.sampleId, /^[a-f0-9]{12}$/)
  assert.ok(made.boardPixels <= PIXEL_BUDGET)
  assert.equal(made.cells.length, 6)
  const onDisk = await fs.readFile(made.path)
  assert.deepEqual(pngSize(onDisk), { width: made.width, height: made.height })
  const rec = await readSample(dir, made.sampleId)
  assert.equal(rec.videoId, '123456789')
  assert.equal(rec.cells.length, 6)
  assert.equal(rec.boardPixels, made.boardPixels)
  assert.ok(rec.cells.every((c) => c.src && c.timecode))
  // 每格时间落在这一段的中间：0..30 六等分，第一格 2.5 秒
  assert.equal(rec.cells[0].time, 2.5)
  assert.equal(rec.cells[5].time, 27.5)
  for (const c of rec.cells) {
    const st = await fs.stat(c.src)
    assert.ok(st.size > 0)
  }
})

test('zoom 按 sampleId+cell 回原图；放大三次后用完；不会碰到平台', async () => {
  const dir = await tmp()
  const made = await makeStoryboard({
    bin: 'ffmpeg', input: 'fake.mp4', duration: 12, outDir: dir, id: '1', count: 4, extract: fakeExtract(),
  })
  for (let i = 1; i <= MAX_ZOOMS; i += 1) {
    const got = await zoomSample({ dir, sampleId: made.sampleId, cell: i })
    assert.equal(got.ok, true)
    assert.equal(got.cell, i)
    assert.equal(got.path, made.cells[i - 1].src)
    const st = await fs.stat(got.path)
    assert.ok(st.size > 0)
  }
  const over = await zoomSample({ dir, sampleId: made.sampleId, cell: 1 })
  assert.equal(over.ok, false)
  assert.match(over.why, /放大次数用完了/)
})

test('连续三次无效格号就停止这次观看；有效的会清零', async () => {
  const dir = await tmp()
  const made = await makeStoryboard({
    bin: 'ffmpeg', input: 'fake.mp4', duration: 12, outDir: dir, id: '2', count: 4, extract: fakeExtract(),
  })
  assert.equal((await zoomSample({ dir, sampleId: made.sampleId, cell: 2 })).ok, true)
  for (let i = 0; i < MAX_INVALID; i += 1) {
    const bad = await zoomSample({ dir, sampleId: made.sampleId, cell: 99 })
    assert.equal(bad.ok, false)
    assert.equal(bad.invalid, true)
  }
  const after = await zoomSample({ dir, sampleId: made.sampleId, cell: 1 })
  assert.equal(after.ok, false)
  assert.match(after.why, /连续 3 次格号不对/)
  const rec = await readSample(dir, made.sampleId)
  assert.equal(rec.closed, true)
  assert.equal(rec.invalidCount, 3)
})

test('每次调用都记进预算：六次之后连有效格号也停', async () => {
  const dir = await tmp()
  const made = await makeStoryboard({
    bin: 'ffmpeg', input: 'fake.mp4', duration: 12, outDir: dir, id: '3', count: 4, extract: fakeExtract(),
  })
  // 有效的会把无效计数清零，所以两次有效夹着四次无效，正好六次调用、还没停。
  assert.equal((await zoomSample({ dir, sampleId: made.sampleId, cell: 1 })).ok, true)
  for (let i = 0; i < 2; i += 1) await zoomSample({ dir, sampleId: made.sampleId, cell: 0 })
  assert.equal((await zoomSample({ dir, sampleId: made.sampleId, cell: 2 })).ok, true)
  for (let i = 0; i < 2; i += 1) await zoomSample({ dir, sampleId: made.sampleId, cell: 0 })
  const rec = await readSample(dir, made.sampleId)
  assert.equal(rec.closed, false)
  assert.equal(rec.calls, MAX_CALLS)
  const seventh = await zoomSample({ dir, sampleId: made.sampleId, cell: 1 })
  assert.equal(seventh.ok, false)
  assert.match(seventh.why, /预算/)
})

test('故事板过了有效期就不许回原图；号不对返回 null', async () => {
  const dir = await tmp()
  const made = await makeStoryboard({
    bin: 'ffmpeg', input: 'fake.mp4', duration: 12, outDir: dir, id: '4', count: 3, extract: fakeExtract(),
    now: Date.parse('2026-11-07T00:00:00Z'),
  })
  assert.equal(await readSample(dir, 'not-a-sample'), null)
  const late = await zoomSample({
    dir,
    sampleId: made.sampleId,
    cell: 1,
    now: Date.parse('2026-11-07T05:00:00Z'),
  })
  assert.equal(late.ok, false)
  assert.match(late.why, /过期/)
})

test('douyin_look 接上了故事板与 zoom：开一条给 sampleId，zoom 不开浏览器', async () => {
  const src = await fs.readFile(new URL('../lib/douyinlook.js', import.meta.url), 'utf8')
  assert.ok(src.includes('storyboardOf'))
  assert.ok(src.includes('zoomDouyinSample'))
  assert.ok(src.includes("what === 'zoom'"))
  assert.ok(src.includes('sample_id'))
  assert.ok(src.includes('cell'))
  assert.ok(src.includes('故事板拼好了'))
  // zoom 分支必须在开浏览器之前返回：否则要一个浏览器才能看一眼旧图。
  const iZoom = src.indexOf("if (what === 'zoom')")
  const iTransport = src.indexOf('if (!transport) {')
  assert.ok(iZoom > 0 && iZoom < iTransport)
})
