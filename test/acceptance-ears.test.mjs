/**
 * test/acceptance-ears.test.mjs —— 「耳朵」验收工装的 node --test 壳
 *
 * 本体在 tools/acceptance-ears.mjs（零依赖 CLI）。这里只是让 `node --test` 能跑它：
 *
 *   - 实现还没合并（lib/audio.js 不存在、qq.js 里没有 fetchAudio / transcode 注入点）时，
 *     整组 skip：跑它必红，红是预期的「等实现」，不该污染全量基线。
 *   - 实现合并后自动解除 skip，跑同一套 A–E，断言 0 红。
 *   - 夹具全在工装里（假 WebSocket / 假时钟 / 假下载 / 假转码 / 假耳朵），
 *     不联网、不依赖真 ffmpeg、不写真实账本；临时目录跑完即删。
 *
 * 等实现合并后复跑：node --test test/acceptance-ears.test.mjs
 * 单独看逐项报告：   node tools/acceptance-ears.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectImplementation, runAcceptance, formatReport } from '../tools/acceptance-ears.mjs'

const impl = detectImplementation()

test('耳朵验收工装：A–E（等实现合并后自动开始验收）', { skip: impl.hasAudioPipeline ? false : `等实现合并：${impl.audioPath} 不存在，lib/channels/qq.js 里也没有 fetchAudio / transcode 注入点` }, async (t) => {
  const result = await runAcceptance()
  const report = formatReport(result)
  t.diagnostic(`\n${report}\n`)
  assert.equal(result.counts.fail, 0, `验收有 ${result.counts.fail} 条 FAIL：\n${report}`)
  assert.ok(result.counts.pass > 0, '一条都没跑起来：验收工装没接上适配器')
})

// 这两个用例与实现无关：永远验证工装自己还在（防止工装被误删 / 静默失效）。
test('验收工装：实现检测不会把「没有管线」当成「有管线」', () => {
  assert.equal(typeof impl.hasAudioPipeline, 'boolean')
  if (impl.audioFile === false) {
    assert.ok(
      !impl.markers.includes('fetchAudio') || impl.markers.includes('transcode'),
      'qq.js 里只有 fetchAudio、没有 transcode：管线检测漏了一种注入点',
    )
  }
})

test('验收工装：读的是这个 worktree 里的 lib/channels/qq.js', () => {
  assert.equal(impl.qqPath.endsWith('/lib/channels/qq.js'), true)
  assert.equal(impl.qqSourcePresent, true, `读不到 ${impl.qqPath}：${impl.qqError}`)
})
