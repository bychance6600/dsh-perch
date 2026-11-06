/**
 * notes.js —— 桌上那张纸：her_note（2026-11-06，设计文档 §三「桌子」）
 *
 * 为什么要有它：她一天里会答应一些事（「明天问问他工作怎么样」「这首歌回头听完」），
 * 醒来之后不该从零开始。这张纸是**她自己的**备忘录，不是给人看的日程表——
 * 主人看不到它的编辑入口，也不替她写。
 *
 * 三条边界：
 *   1. **不进事件流**。纸上记的是「还没做的事」，不是「我是什么样的人」；
 *      写一条便条不算一段经历，删掉也不算遗忘。所以它落在 notes.json，
 *      和信箱、日记一样是家具，不是记忆。
 *   2. **有上限**。最多 20 条、每条 120 字；超了先掉最旧的那条。
 *      上限写死在代码里，不进配置——否则它就成了「把桌子调大一点」的旋钮。
 *   3. **醒来先看见**。scheduler 在叫醒消息里放一张纸上的前几条
 *      （见 lib/scheduler.js 的 wakeNotes 调用）；不做定时提醒，不催她。
 *
 * 文件形状：{ "notes": [ { "id": "n_…", "text": "…", "at": 1762… } ] }
 */

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { toJsonSchema } from './toolschema.js'
import { rootDir, readJson, writeAtomic } from './store.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'

/** 一条便条最多多少字。再长就不是「记一笔」，是写文章。 */
export const NOTE_MAX = 120
/** 纸上最多留多少条。 */
export const NOTES_MAX = 20
/** 醒来时最多摊开几条。 */
export const WAKE_NOTES = 3

const FILE = 'notes.json'

/** @returns {Promise<Array<{id:string,text:string,at:number}>>} */
export async function readNotes(root = rootDir()) {
  const data = await readJson(join(root, FILE), { notes: [] }).catch(() => ({ notes: [] }))
  const list = Array.isArray(data?.notes) ? data.notes : []
  return list
    .filter((n) => n && typeof n.text === 'string' && n.text.trim())
    .map((n) => ({
      id: String(n.id ?? ''),
      text: String(n.text).slice(0, NOTE_MAX),
      at: Number(n.at) || 0,
    }))
}

async function writeNotes(root, list) {
  await writeAtomic(join(root, FILE), JSON.stringify({ notes: list }, null, 2))
}

/**
 * 记一条。永不抛。
 * @returns {Promise<{ok:boolean, note:string, id:string}>}
 */
export async function addNote(root = rootDir(), text = '') {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return { ok: false, note: '空白的，没记。', id: '' }
  if (body.length > NOTE_MAX) {
    return { ok: false, note: `太长了，压到 ${NOTE_MAX} 字以内再说。`, id: '' }
  }
  try {
    const list = await readNotes(root)
    const same = list.find((n) => n.text === body)
    if (same) return { ok: true, note: '已经在纸上了。', id: same.id }
    const note = { id: `n_${randomUUID().slice(0, 8)}`, text: body, at: Date.now() }
    list.push(note)
    // 超了先掉最旧的：桌子有边，但掉下去的那条之前已经提醒过她一次。
    while (list.length > NOTES_MAX) list.shift()
    await writeNotes(root, list)
    return { ok: true, note: '记下了。', id: note.id }
  } catch {
    return { ok: false, note: '没记上。', id: '' }
  }
}

/**
 * 划掉一条。key 可以是编号（从 1 数）或 id。
 * @returns {Promise<{ok:boolean, note:string}>}
 */
export async function doneNote(root = rootDir(), key = '') {
  const k = String(key ?? '').trim()
  if (!k) return { ok: false, note: '要说划掉哪一条。' }
  try {
    const list = await readNotes(root)
    let idx = -1
    if (/^\d+$/.test(k)) {
      const n = Number(k)
      if (n >= 1 && n <= list.length) idx = n - 1
    } else {
      idx = list.findIndex((n) => n.id === k)
    }
    if (idx < 0) return { ok: false, note: '纸上没有这一条。' }
    list.splice(idx, 1)
    await writeNotes(root, list)
    return { ok: true, note: '划掉了。' }
  } catch {
    return { ok: false, note: '没划掉。' }
  }
}

/** 纸上的前几条，摊成叫醒消息里的一小段。空纸返回空串。 */
export async function wakeNotesLine(root = rootDir(), limit = WAKE_NOTES) {
  try {
    const list = await readNotes(root)
    if (!list.length) return ''
    const cap = Math.max(1, Math.min(WAKE_NOTES, Number(limit) || WAKE_NOTES))
    const lines = list.slice(-cap).map((n) => `- ${n.text}`)
    return ['桌上那张纸还记着：', ...lines].join('\n')
  } catch {
    return ''
  }
}

/** 注册 her_note 工具。 */
export function registerNotes(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_note',
      description:
        '桌上有张纸：答应过、还没做完的事随手记下来，下次醒来会先看见。' +
        '做完了就划掉。什么都不带就是翻一眼纸上有什么。',
      parameters: toJsonSchema({
        text: {
          type: 'string',
          description: `要记在纸上的那一句。${NOTE_MAX} 字以内。`,
        },
        done: {
          type: 'string',
          description: '已经做完的那条，写它的编号或纸上那个短号。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        // 回执只给最小的一句：不说还剩几条（会变成配额感），
        // 也不把纸上的原文回给她（那是复读）。
        render: (args, out) => {
          if (!out.ok) return [{ type: 'text', text: `[没记：${out.note}]` }]
          if (args?.done) return [{ type: 'text', text: '[划掉了]' }]
          if (args?.text) {
            return [{ type: 'text', text: out.note === '已经在纸上了。' ? '[已经在纸上了]' : '[记下了]' }]
          }
          // 翻一眼：整张纸直接摊开，编号就是划掉时要写的那个。
          return [{ type: 'text', text: out.note }]
        },
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_note')
        if (!who.ok) return { ok: false, note: who.note }

        // 先划掉：一句话里同时带 text 与 done 时，按「做完旧的、记新的」处理。
        if (args?.done) {
          const r = await doneNote(root, args.done)
          if (!args?.text) return r
        }
        if (args?.text) {
          const r = await addNote(root, args.text)
          return { ok: r.ok, note: r.note }
        }
        const list = await readNotes(root)
        if (!list.length) return { ok: true, note: '纸上空着。' }
        const body = list.map((n, i) => `${i + 1}. ${n.text}`).join('\n')
        return { ok: true, note: body }
      },
    }),
  )
}
