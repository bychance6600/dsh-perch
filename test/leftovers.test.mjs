/**
 * leftovers.test.mjs —— A15：删除清单复核之后，仓库里不再留已删功能的入口。
 *
 * 只守「还有没有入口 / 说明里还写没写」，不测那些功能的旧语义——
 * 出门、请神、导入卡、桌面通知、旁听都已经从 0.1.0 删掉了。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const exists = (p) => fs.existsSync(new URL('../' + p, import.meta.url))

test('A15：已删的模块不在仓库里，也不再注册入口', () => {
  for (const f of [
    'lib/outing.js', 'lib/possess.js', 'lib/keepsake.js', 'lib/pocket.js',
    'lib/sessionnote.js', 'lib/keep.js', 'lib/dream.js', 'lib/import.js',
    'lib/notify.js', 'lib/update.js', 'lib/selfupdate.js', 'lib/comment.js',
    'lib/hear.js', 'lib/channels/bili.js',
  ]) assert.equal(exists(f), false, f + ' 应该已经删掉')

  const settings = read('lib/settings.js')
  assert.doesNotMatch(settings, /outing/, '设置里不该再有 outing 组')
  assert.doesNotMatch(settings, /hearEvery|comment/, '设置里不该再有旁听/评论')

  const observe = read('lib/observe.js')
  assert.doesNotMatch(observe, /awayNow|outingWakeText|st\.away/, '观测台不该再算出门/请神')
  assert.doesNotMatch(observe, /lib\/import\.js|lib\/notify\.js/, '不该再指向已删模块')

  const store = read('lib/store.js')
  assert.doesNotMatch(store, /outsideSessions|outings\.json|possessions\.json/, 'store 不该再读出门台账')

  const client = read('lib/client.js')
  assert.doesNotMatch(client, /能不能出门|st\.away/, '界面上不该再提出门')
  assert.doesNotMatch(client, /旁听|请神/, '界面上不该再提旁听/请神')
})

test('A15：说明.md 列的是现在真有的文件，不再列已删的', () => {
  const text = read('lib/readme.js')
  for (const name of ['qq-wal.jsonl', 'qq-outbox.jsonl', 'douyin-profile/', 'home.json', 'people.json', 'notes.json', 'journal.json']) {
    assert.ok(text.includes(name), '说明.md 缺 ' + name)
  }
  for (const gone of ['keepsakes/', 'keepsakes.json', 'outings.json', 'possessions.json', 'session-notes.json']) {
    assert.equal(text.includes(gone), false, '说明.md 不该再列 ' + gone)
  }
})
