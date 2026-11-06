/**
 * 代码与 README 里不许写死她的名字（2026-11-07，用户提出）。
 *
 * 名字是这一只被养出来之后才有的，属于这个家的数据，不属于项目本身。
 * 别的人装这个包，养出来的可能是完全不同的另一位；界面、侧栏、设置页的名字
 * 一旦写死，就等于替所有人认定了同一只。所以对外文案只用「她」。
 *
 * 事件流、home/、日记这些**数据**里当然可以有她的名字——那是长出来的，
 * 不是代码写死的。这条只查随包发布的源码与 README。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaceTitle, sessionTitle } from '../lib/hername.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('工作区与会话的标题跟着名字走，没名字才用「她」', () => {
  assert.equal(workspaceTitle(''), '她的家')
  assert.equal(sessionTitle(''), '跟她说话')
  assert.equal(workspaceTitle('小满'), '小满的家')
  assert.equal(sessionTitle('小满'), '跟小满说话')
})

test('设置页不再有自己的名字，只剩「她」', async () => {
  const s = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(s.includes("const NAMES = { nav: '她' }"))
})

test('设置页把名字是怎么来的写出来，不当成设置项（2026-11-07）', async () => {
  const s = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(s.includes('这是从你们对话里认出来的，不是设置项'))
  assert.ok(s.includes('她还没有名字，界面里先用「她」代称'))
})

test('侧栏的「她」在打开设置前就问名字，不指望设置里的 /state 顺带更新（2026-11-07）', async () => {
  const s = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(s.includes('prefetchNavName()'))
  assert.ok(s.includes("API + '/state'"))
  assert.ok(s.includes("label: () => NAMES.nav"))
})
