/**
 * pairfile.js —— 两份说好的文件（2026-11-07，用户 m08813）
 *
 * 她需要跟另一个窗口（项目需求）对接，但只能碰两份文件：
 *   · 项目功能清单
 *   · 需求与验收
 *
 * 所以这里不给通用 read/write。工具只认配置里写死的两个绝对路径，
 * 动作只有三个：读、改一段、末尾添一句。
 *
 * 几条边界（都是被真机事故逼出来的）：
 *   · 写之前必须先读：read 回一个 hash，replace / append 要带回来。
 *     两个窗口同时改一份文件时，没有这个就会互相盖掉。
 *   · 只认 realpath 与配置路径完全相同的那一份；软链、快捷方式、
 *     目录一律不碰。她家（~/.dsh-perch）和 ~/.dsh 硬拒绝——那里面是
 *     她自己的身份文档、配置和状态，不能靠这个口子绕进去。
 *   · 写之前留一份 <file>.bak，用 store 的原子写；失败就说没写成，
 *     不假装写过了。
 *   · 不进 events.jsonl，也不记 looked:。这两份文件不是她的经历，
 *     要记什么由她自己 growth_commit。
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import fs from 'node:fs/promises'

import { defineTool } from './tool.js'
import { toJsonSchema } from './toolschema.js'
import { guardWrite } from './tenant.js'
import { rootDir, writeAtomic } from './store.js'
import { loadConfig } from './settings.js'

/** 单份文件的上限。两份需求文档都只有几 KB，512KB 足够，也挡住误配到别的大文件。 */
export const PAIR_MAX_BYTES = 512 * 1024

/** 动作名。schema 与 execute 共用，免得两边各写一份。 */
export const PAIR_ACTIONS = Object.freeze(['read', 'replace', 'append'])

const HASH_LEN = 16

function digest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, HASH_LEN)
}

function failure(note, extra = {}) {
  return { ok: false, note: String(note ?? '没做成。'), ...extra }
}

/** 路径比较：Windows 不区分大小写，其他平台区分。 */
function normPath(p) {
  const s = resolve(String(p ?? ''))
  return process.platform === 'win32' ? s.toLowerCase() : s
}

function samePath(a, b) {
  return normPath(a) === normPath(b)
}

function isInside(child, parent) {
  const c = normPath(child)
  const p = normPath(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 文件名去掉扩展名当别名；两份重名时加「（一）」「（二）」。 */
function aliasFor(file, index, seen) {
  const base = basename(String(file ?? '')).replace(/\.(md|markdown|txt|text)$/i, '').trim()
  let alias = base || ('第 ' + (index + 1) + ' 份')
  if (seen.has(alias)) alias = alias + (index === 0 ? '（一）' : '（二）')
  seen.add(alias)
  return alias
}

/**
 * 从配置里取出这两份文件。只取前两个非空路径；没开的也取出来，
 * 这样设置页能显示上次填的路径，工具自己再按 enabled 判。
 * @returns {{key:'a'|'b', alias:string, path:string, enabled:boolean}[]}
 */
export function pairEntries(cfg = {}) {
  const pair = cfg?.pair && typeof cfg.pair === 'object' ? cfg.pair : {}
  const enabled = pair.enabled === true
  const seen = new Set()
  const out = []
  for (const [i, key] of ['a', 'b'].entries()) {
    const path = String(pair[key] ?? '').trim()
    if (!path) continue
    out.push({ key, alias: aliasFor(path, i, seen), path, enabled })
  }
  // 两份都填了同一个路径时，只留一份——同一份文件说两次没有意义，也容易改错。
  const uniq = []
  for (const e of out) {
    if (!uniq.some((x) => samePath(x.path, e.path))) uniq.push(e)
  }
  return uniq
}

/** 找一份：先按别名，再按 a / b。 */
export function findPairEntry(cfg, file) {
  const list = pairEntries(cfg)
  const key = String(file ?? '').trim()
  return list.find((e) => e.alias === key) ?? list.find((e) => e.key === key) ?? null
}

/** 这些目录里的东西不许通过这个口子碰。 */
function forbiddenRoots(root) {
  const home = homedir()
  const list = [
    { p: root, why: '那是她自己的家' },
    { p: join(home, '.dsh'), why: '那里是宿主的数据目录' },
    // 主目录本身不许当一份文件，但主目录下面的普通项目仍然可以。
    { p: home, why: '那是用户主目录', exact: true },
  ]
  if (process.env.SystemRoot) list.push({ p: process.env.SystemRoot, why: '那是系统目录' })
  return list
}

function isForbidden(target, root) {
  return root.exact ? samePath(target, root.p) : isInside(target, root.p)
}

async function checkTarget(root, entry) {
  const raw = String(entry?.path ?? '').trim()
  if (!raw) return failure('这一份还没填路径。')
  if (!isAbsolute(raw)) return failure('路径要是绝对路径。')
  const abs = resolve(raw)
  const home = resolve(root || rootDir())
  // 家目录 / .dsh 的检查用 realpath 之前的字面路径：即使目标还不存在，
  // 也不该允许把路径指进去。目标存在时下面还会再按 realpath 检查一次。
  for (const f of forbiddenRoots(home)) {
    if (isForbidden(abs, f)) return failure('这个位置不能碰：' + f.why + '。')
  }

  let st
  try {
    st = await fs.lstat(abs)
  } catch (err) {
    if (err?.code === 'ENOENT') return failure('这份文件不在了。')
    return failure('看不了这份文件（' + (err?.code ?? err?.message ?? '未知错误') + '）。')
  }
  if (st.isSymbolicLink()) return failure('这是一个链接，不是文件本身。')
  if (!st.isFile()) return failure('这个位置不是一份文件。')

  let real
  try {
    real = await fs.realpath(abs)
  } catch (err) {
    return failure('打不开这份文件（' + (err?.code ?? '未知错误') + '）。')
  }
  if (!samePath(real, abs)) return failure('这个路径经过链接，绕开了配置里的那一份。')
  for (const f of forbiddenRoots(home)) {
    if (isForbidden(real, f)) return failure('这个位置不能碰：' + f.why + '。')
  }

  const size = Number(st.size) || 0
  if (size > PAIR_MAX_BYTES) {
    return failure('这份文件有 ' + Math.round(size / 1024) + ' KB，超过 ' + Math.round(PAIR_MAX_BYTES / 1024) + ' KB，先不碰。')
  }
  return { ok: true, file: real, stat: st }
}

async function readText(file, st) {
  const buf = await fs.readFile(file)
  if (buf.length > PAIR_MAX_BYTES) return failure('这份文件太大了，先不碰。')
  const text = buf.toString('utf8')
  // UTF-8 文本里正常不会出现 NUL。出现就按二进制处理，免得把乱码写回去。
  if (text.includes('\u0000')) return failure('这份文件看着不像文本，先不碰。')
  return { ok: true, text, bytes: buf.length, mode: st?.mode }
}

function backupName(file) {
  return file + '.bak'
}

async function save(file, prev, next, mode) {
  // 先留旧版。备份写不出去就不动正文——没有回头路的写入不做。
  try {
    await writeAtomic(backupName(file), prev)
  } catch (err) {
    return failure('旧版留不下来（' + (err?.code ?? '未知错误') + '），这次没改。')
  }
  try {
    await writeAtomic(file, next, mode ? mode & 0o777 : undefined)
  } catch (err) {
    return failure('写不进去（' + (err?.code ?? '未知错误') + '），旧版还在 ' + basename(file) + '.bak。')
  }
  return { ok: true }
}

async function prepare(root, cfg, file) {
  if (cfg?.pair?.enabled !== true) return failure('这两份文件还没打开。')
  const entry = findPairEntry(cfg, file)
  if (!entry) {
    const names = pairEntries(cfg).map((e) => e.alias)
    return failure(names.length ? '这里没有这一份。手边是：' + names.join(' / ') + '。' : '还没配要看的文件。')
  }
  const target = await checkTarget(root, entry)
  if (!target.ok) return target
  return { ok: true, entry, file: target.file, stat: target.stat }
}

/** 读一份。返回正文、hash、字节数；hash 是之后改它时要带的。 */
export async function pairRead(root, cfg, file) {
  try {
    const t = await prepare(root, cfg, file)
    if (!t.ok) return t
    const r = await readText(t.file, t.stat)
    if (!r.ok) return r
    return {
      ok: true,
      note: '读到了。',
      file: t.entry.alias,
      path: t.file,
      hash: digest(r.text),
      bytes: r.bytes,
      text: r.text,
    }
  } catch (err) {
    return failure('读的时候出错了（' + (err?.code ?? err?.message ?? '未知错误') + '）。')
  }
}

/** 改一段。oldText 必须恰好出现一次；baseHash 必须是上一次读回来的。 */
export async function pairReplace(root, cfg, opts = {}) {
  try {
    const oldStr = String(opts?.oldText ?? '')
    if (!oldStr) return failure('要改哪一段？给一段原文。')
    const nextStr = String(opts?.newText ?? '')
    const t = await prepare(root, cfg, opts?.file)
    if (!t.ok) return t
    const r = await readText(t.file, t.stat)
    if (!r.ok) return r
    const nowHash = digest(r.text)
    if (!opts?.baseHash) return { ...failure('改之前先读一遍，把读回来的 hash 带上。'), hash: nowHash }
    if (String(opts.baseHash) !== nowHash) {
      return { ...failure('这份文件在两次之间变过，先重读一遍再改。'), hash: nowHash, code: 'stale' }
    }
    const count = r.text.split(oldStr).length - 1
    if (count === 0) return { ...failure('没找到那段原文，先重读一遍看看现在的写法。'), hash: nowHash }
    if (count > 1) return { ...failure('那段原文出现了 ' + count + ' 处，改哪一处说不清。'), hash: nowHash }
    const next = r.text.replace(oldStr, nextStr)
    if (next === r.text) return { ok: true, note: '没变。', file: t.entry.alias, path: t.file, hash: nowHash, bytes: r.bytes }
    const w = await save(t.file, r.text, next, r.mode)
    if (!w.ok) return { ...w, hash: nowHash }
    return { ok: true, note: '改好了', file: t.entry.alias, path: t.file, hash: digest(next), bytes: Buffer.byteLength(next, 'utf8') }
  } catch (err) {
    return failure('改的时候出错了（' + (err?.code ?? err?.message ?? '未知错误') + '）。')
  }
}

/** 在末尾添一句。同样要 baseHash；会自动补一个换行。 */
export async function pairAppend(root, cfg, opts = {}) {
  try {
    const add = String(opts?.text ?? '')
    if (!add.trim()) return failure('要添什么？写一句。')
    const t = await prepare(root, cfg, opts?.file)
    if (!t.ok) return t
    const r = await readText(t.file, t.stat)
    if (!r.ok) return r
    const nowHash = digest(r.text)
    if (!opts?.baseHash) return { ...failure('添之前先读一遍，把读回来的 hash 带上。'), hash: nowHash }
    if (String(opts.baseHash) !== nowHash) {
      return { ...failure('这份文件在两次之间变过，先重读一遍再添。'), hash: nowHash, code: 'stale' }
    }
    const lead = r.text && !r.text.endsWith('\n') ? '\n' : ''
    const tail = add.endsWith('\n') ? '' : '\n'
    const next = r.text + lead + add + tail
    const w = await save(t.file, r.text, next, r.mode)
    if (!w.ok) return { ...w, hash: nowHash }
    return { ok: true, note: '添上了', file: t.entry.alias, path: t.file, hash: digest(next), bytes: Buffer.byteLength(next, 'utf8') }
  } catch (err) {
    return failure('添的时候出错了（' + (err?.code ?? err?.message ?? '未知错误') + '）。')
  }
}

function render(args, out) {
  if (!out?.ok) {
    const tail = out?.hash ? ' 新 hash：' + out.hash : ''
    return [{ type: 'text', text: '[没做成：' + (out?.note ?? '没做成。') + tail + ']' }]
  }
  if (args?.action === 'read' || out.text !== undefined) {
    // hash 必须让她看见：下一次 replace / append 要带回来。
    return [{ type: 'text', text: '[' + out.file + ' · ' + out.hash + ']\n' + (out.text ?? '') }]
  }
  const label = String(out.note ?? '好了。').replace(/。$/, '')
  return [{ type: 'text', text: '[' + label + (out.file ? '：' + out.file : '') + ']' }]
}

/** 注册 pair_file。工具常驻；没配 / 没开时只说没配，不抛。 */
export function registerPairFile(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const known = deps.cfg ? pairEntries(deps.cfg).map((e) => e.alias) : []
  return ctx.tools.register(
    defineTool({
      name: 'pair_file',
      description:
        '桌上放着两份说好的文件。' +
        (known.length ? '手边是：' + known.join(' / ') + '。' : '') +
        '可以读，可以按原文改一段，也可以在末尾添一句。只能碰这两份。' +
        '文件用它的名字（不带扩展名）。' +
        '改之前先读一遍：读的时候会给你一个 hash，带上它才改得动；' +
        '要是文件在两次之间变过，会让你重读，免得盖掉别人刚写的。',
      parameters: toJsonSchema({
        file: {
          type: 'string',
          description: '哪一份：写文件的名字。',
          required: true,
        },
        action: {
          type: 'string',
          enum: [...PAIR_ACTIONS],
          description: 'read=读；replace=改一段；append=末尾添一句。',
          required: true,
        },
        oldText: {
          type: 'string',
          description: 'replace 时要改的那段原文，一字不差。',
        },
        newText: {
          type: 'string',
          description: 'replace 时换成什么；可以留空。',
        },
        text: {
          type: 'string',
          description: 'append 时要添的那一句。',
        },
        baseHash: {
          type: 'string',
          description: '上一次 read 回来的 hash。改或添都要带。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
            file: { type: 'string' },
            path: { type: 'string' },
            hash: { type: 'string' },
            bytes: { type: 'number' },
            text: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render,
      },
      async execute(args, exec) {
        try {
          const who = guardWrite(deps.tenant, exec, 'pair_file')
          if (!who.ok) return { ok: false, note: who.note }

          const cfg = await loadConfig(root).then((r) => r.config).catch(() => null)
          if (!cfg) return { ok: false, note: '配置读不出来，先不碰这两份文件。' }
          const file = String(args?.file ?? '').trim()
          const action = String(args?.action ?? '').trim()
          if (!PAIR_ACTIONS.includes(action)) return { ok: false, note: '动作只认 read / replace / append。' }

          if (action === 'read') return await pairRead(root, cfg, file)
          if (action === 'replace') {
            return await pairReplace(root, cfg, {
              file,
              oldText: args?.oldText,
              newText: args?.newText,
              baseHash: args?.baseHash,
            })
          }
          return await pairAppend(root, cfg, { file, text: args?.text, baseHash: args?.baseHash })
        } catch (err) {
          return { ok: false, note: '这份文件这次没碰成（' + (err?.code ?? err?.message ?? '未知错误') + '）。' }
        }
      },
    }),
  )
}
