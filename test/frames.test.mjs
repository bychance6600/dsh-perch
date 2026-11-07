/**
 * frames.test.mjs —— 分镜画笔（零依赖 PNG、格号、时间码、波形）
 *
 * 2026-11-07（A8）：从抖音子包搬进主包，B 站看画面也用它。
 * 这里只验画笔本身：排版、PNG 头、格号与时间码的位置，不抽帧、不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  composeBoard, encodePng, bestLayout, layoutCanvas, timecode, pngSize, PIXEL_BUDGET,
} from '../lib/frames.js'

function solid(w, h, v) {
  const data = Buffer.alloc(w * h * 3, v)
  return { width: w, height: h, data }
}

test('timecode：分钟不补零、秒补两位', () => {
  assert.equal(timecode(0), '0:00')
  assert.equal(timecode(65), '1:05')
  assert.equal(timecode(3599), '59:59')
  assert.equal(timecode('坏值'), '0:00')
})

test('bestLayout / layoutCanvas：格数排得下，面积不超预算', () => {
  for (const n of [2, 4, 6, 9, 12]) {
    const { cols, rows, capacity } = bestLayout(n, 16 / 9)
    assert.ok(cols * rows >= n)
    assert.equal(capacity, cols * rows)
    const c = layoutCanvas(cols, rows, 16 / 9, PIXEL_BUDGET)
    assert.ok(c.width * c.height <= PIXEL_BUDGET * 1.02)
    assert.ok(c.cellW >= 64 && c.cellH >= 64)
  }
})

test('composeBoard：格号和时间码都在，波形不会把格子画坏', () => {
  const frames = [solid(320, 180, 30), solid(320, 180, 90), solid(320, 180, 150), solid(320, 180, 210)]
  const waves = [[0.1, 0.9, 0.4], [0.5], [], [0.2, 0.2]]
  const b = composeBoard({ frames, times: [0, 12, 65, 3599], waves })
  assert.equal(b.cells.length, 4)
  assert.deepEqual(b.cells.map((c) => c.timecode), ['0:00', '0:12', '1:05', '59:59'])
  assert.equal(b.cells[0].cell, 1)
  assert.equal(b.width * b.height <= PIXEL_BUDGET * 1.02, true)
  const png = encodePng(b.width, b.height, b.buffer)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const size = pngSize(png)
  assert.deepEqual(size, { width: b.width, height: b.height })
})

test('composeBoard：一格不给拼（故事板至少两格）', () => {
  assert.throws(() => composeBoard({ frames: [solid(64, 36, 0)], times: [0] }), /至少要两格/)
  assert.throws(() => composeBoard({ frames: [] }), /至少要两格/)
})
