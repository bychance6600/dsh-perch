/**
 * import.test.mjs —— 把旧对话里「他说过的话」搬进来（2026-11-10）
 *
 * 只测边界：宿主注入的运行时上下文被滤掉、她的回复不读、重复不写第二遍、
 * 干跑不落盘、--write 才写 heard 并留 import-mark。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../tools/import.mjs', import.meta.url))

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true })
}

async function fixture(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perch-import-'))
  await writeFile(join(dir, 'chat.txt'), lines.join('\n'), 'utf8')
  return dir
}

test('干跑：滤掉运行时上下文，不写盘', async () => {
  const dir = await fixture([
    '今天很累，先睡了。',
    'Current runtime context. This snapshot supersedes earlier ones.',
    '你还记得我们说的那只猫吗？',
  ])
  const root = await mkdtemp(join(tmpdir(), 'dsh-perch-root-'))
  const r = run(['--from', dir, '--root', root])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /可用 2 句/)
  assert.match(r.stdout, /injected 1/)
  assert.match(r.stdout, /干跑，未写盘/)
  assert.equal(existsSync(join(root, 'events.jsonl')), false)
  await rm(dir, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

test('--merge：对面导出的 events.jsonl 只接 heard 与 import-mark', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-perch-root-'))
  const exported = join(root, 'from-other.jsonl')
  await writeFile(
    exported,
    [
      JSON.stringify({ type: 'heard', time: 1762000000000, text: '搬过来的一句。' }),
      JSON.stringify({ type: 'heard', time: 1762000001000, text: '搬过来的一句。' }),
      JSON.stringify({ type: 'meta', time: 1762000000500, text: 'import-mark:other:1' }),
      JSON.stringify({ type: 'utterance', text: '她的话不该被接' }),
    ].join('\n'),
    'utf8',
  )
  const dry = run(['--merge', exported, '--root', root])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /可用 1 条/)
  assert.match(dry.stdout, /干跑/)

  const w = run(['--merge', exported, '--root', root, '--write'])
  assert.equal(w.status, 0, w.stderr)
  const events = (await readFile(join(root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(events.filter((e) => e.type === 'heard').length, 1)
  assert.ok(events.some((e) => e.type === 'meta' && /import-mark:other:1/.test(e.text)))
  assert.equal(events.filter((e) => e.type === 'utterance').length, 0)
  await rm(root, { recursive: true, force: true })
})

test('--write：写 heard 与 import-mark；同一句不写第二遍', async () => {
  const dir = await fixture(['第一句话。', '第一句话。', '第二句话。'])
  const root = await mkdtemp(join(tmpdir(), 'dsh-perch-root-'))
  const first = run(['--from', dir, '--root', root, '--write'])
  assert.equal(first.status, 0, first.stderr)
  const raw = await readFile(join(root, 'events.jsonl'), 'utf8')
  const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const heard = events.filter((e) => e.type === 'heard')
  assert.equal(heard.length, 2)
  assert.ok(heard.every((e) => e.source === 'system'))
  assert.ok(events.some((e) => e.type === 'meta' && /import-mark:/.test(e.text)))

  const second = run(['--from', dir, '--root', root, '--write'])
  assert.equal(second.status, 0, second.stderr)
  const after = (await readFile(join(root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)
  assert.equal(after.length, events.length, '重复导入不该再写事件')
  await rm(dir, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})
