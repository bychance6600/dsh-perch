import test from 'node:test'
import assert from 'node:assert/strict'

import { loadSubModule, SUB_CANDIDATES } from '../lib/channels/sub.js'

test('抖音子包：仓库里那一份能被直接加载（不要求 npm 装过）', async () => {
  const mod = await loadSubModule()
  assert.equal(typeof mod?.createCdpTransport, 'function', '整包下载时应该能加载 packages/ 里的子包')
  assert.equal(typeof mod?.browseFeed, 'function')
  assert.equal(mod?.create, undefined, '子包只做材料层：没有聊天适配器')
})

test('抖音子包：先找已安装的包，再退回仓库路径', () => {
  assert.equal(SUB_CANDIDATES[0], 'dsh-perch-douyin')
  assert.ok(SUB_CANDIDATES[1].includes('packages/dsh-perch-douyin/index.js'))
})
