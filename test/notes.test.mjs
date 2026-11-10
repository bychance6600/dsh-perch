/**
 * notes.test.mjs —— 桌上那张纸（her_note，2026-11-06，设计文档 §三）
 *
 * 守四件事：
 *   1. 便条落在 notes.json，不进事件流（它不是一段经历）；
 *   2. 上限真的生效：太长拒收、最多 20 条、重复的只留一条；
 *   3. 划掉按编号或 id 都行，划不掉的回一句不吓人的话；
 *   4. 叫醒消息只摊前几条，空纸不占地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NOTE_MAX,
  NOTES_MAX,
  addNote,
  doneNote,
  readNotes,
  registerNotes,
  wakeNotesLine,
} from '../lib/notes.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-perch-notes-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (t) => { tools.push(t); return { dispose() {} } } },
    _tools: tools,
  }
}

test('记一条、读回来；文件就是 notes.json，不写事件流', async () => {
  await withRoot(async (root) => {
    const r = await addNote(root, '  明天问问他工作怎么样  ')
    assert.equal(r.ok, true)
    assert.ok(r.id.startsWith('n_'))
    const list = await readNotes(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].text, '明天问问他工作怎么样')
    assert.ok(list[0].at > 0)

    const raw = JSON.parse(await readFile(join(root, 'notes.json'), 'utf8'))
    assert.equal(raw.notes.length, 1)
    // notes.json 与事件流是两回事：这里不该出现 events.jsonl。
    await assert.rejects(readFile(join(root, 'events.jsonl'), 'utf8'))
  })
})

test('空白的拒收；太长的拒收；同一句只留一条', async () => {
  await withRoot(async (root) => {
    assert.equal((await addNote(root, '   ')).ok, false)
    const long = '字'.repeat(NOTE_MAX + 1)
    const r = await addNote(root, long)
    assert.equal(r.ok, false)
    assert.match(r.note, new RegExp(String(NOTE_MAX)))

    assert.equal((await addNote(root, '听完那首歌')).ok, true)
    const dup = await addNote(root, '听完那首歌')
    assert.equal(dup.ok, true)
    assert.equal((await readNotes(root)).length, 1)
  })
})

test('纸上最多 20 条，超了先掉最旧的', async () => {
  await withRoot(async (root) => {
    for (let i = 0; i < NOTES_MAX + 3; i += 1) {
      const r = await addNote(root, `第 ${i} 条`)
      assert.equal(r.ok, true)
    }
    const list = await readNotes(root)
    assert.equal(list.length, NOTES_MAX)
    assert.equal(list[0].text, '第 3 条')
    assert.equal(list[list.length - 1].text, `第 ${NOTES_MAX + 2} 条`)
  })
})

test('划掉：按编号、按 id 都行；划不掉时说纸上没有', async () => {
  await withRoot(async (root) => {
    await addNote(root, '第一件')
    const second = await addNote(root, '第二件')
    assert.equal((await doneNote(root, '1')).ok, true)
    assert.deepEqual((await readNotes(root)).map((n) => n.text), ['第二件'])
    assert.equal((await doneNote(root, second.id)).ok, true)
    assert.deepEqual(await readNotes(root), [])

    const miss = await doneNote(root, '9')
    assert.equal(miss.ok, false)
    assert.match(miss.note, /没有/)
  })
})

test('叫醒消息：空纸给空串，有纸只摊最后三条', async () => {
  await withRoot(async (root) => {
    assert.equal(await wakeNotesLine(root), '')
    for (const t of ['A', 'B', 'C', 'D']) await addNote(root, t)
    const line = await wakeNotesLine(root)
    assert.match(line, /桌上那张纸还记着/)
    assert.match(line, /- B/)
    assert.match(line, /- C/)
    assert.match(line, /- D/)
    assert.doesNotMatch(line, /- A/)
  })
})

test('registerNotes 注册 her_note：参数是 object schema，render 返回 ContentBlock', async () => {
  const ctx = fakeCtx()
  registerNotes(ctx, { root: join(tmpdir(), 'dsh-perch-notes-reg') })
  const spec = ctx._tools[0]
  assert.equal(spec.name, 'her_note')
  assert.equal(spec.parameters.type, 'object')
  assert.equal(spec.parameters.properties.text.type, 'string')
  assert.equal(spec.parameters.properties.done.type, 'string')
  assert.equal(spec.parameters.required, undefined, '两个参数都可以不带：不带就是翻一眼')

  await withRoot(async (root) => {
    registerNotes(ctx, { root })
    const tool = ctx._tools[1]
    const wrote = await tool.execute({ text: '回头把那集看完' })
    assert.equal(wrote.ok, true)
    const blocks = spec.output.render({ text: '回头把那集看完' }, wrote)
    assert.ok(Array.isArray(blocks))
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /记下/)

    const read = await tool.execute({})
    assert.equal(read.ok, true)
    assert.match(read.note, /1\. 回头把那集看完/)
    const listBlocks = spec.output.render({}, read)
    assert.ok(Array.isArray(listBlocks))
    assert.match(listBlocks[0].text, /回头把那集看完/)

    const done = await tool.execute({ done: '1' })
    assert.equal(done.ok, true)
    assert.match(spec.output.render({ done: '1' }, done)[0].text, /划掉/)
    assert.deepEqual(await readNotes(root), [])
  })
})
