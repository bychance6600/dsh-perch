/**
 * pet/actions.js —— 角色包里有哪些动作（2026-11-08 17:50 协调板）
 *
 * 动作不是 roost 写死的：body 的 pet.json 里 `animations.actions` 的键就是它能演的动作。
 * 这里只做一件只读的事：按 body 的顺序找到 pet.json，取键名和 labels；
 * 找不到、读坏了、一个动作都没有，就回落到内置那 10 个。
 *
 * 解析顺序（和 body 的 --pet-dir > ~/.dsh-roost/pets/<id> > <repo>/pets/<id> 对齐）：
 *   1. pet.dir（预留；roost 目前没有设置项，但读到就用）
 *   2. <root>/pets/<pack>/pet.json
 *   3. <repo>/pets/<pack>/pet.json（开发态）
 *
 * 这里不执行、不写盘、不联网；动作表变了要重启才生效（工具 schema 在注册时定）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { petIdOf } from './entry.js'

/** 内置动作：角色包读不到时回落到这一份。 */
export const BUILTIN_ACTIONS = Object.freeze([
  'nod', 'shake', 'bounce', 'shy', 'laugh', 'stretch', 'sleep', 'wake', 'quiet', 'loud',
])

/** 内置动作的中文说明。角色包的 labels 可以覆盖它。 */
export const BUILTIN_ACTION_TEXT = Object.freeze({
  nod: '点了点头',
  shake: '摇了摇头',
  bounce: '跳了一下',
  shy: '有点不好意思',
  laugh: '笑了一下',
  stretch: '伸了个懒腰',
  sleep: '去睡了',
  wake: '醒了',
  quiet: '安静下来',
  loud: '出了点声',
})

/** 动作名只收短标识：body 的协议和 CLI 都按这个形状用。 */
export function safeActionName(name) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(String(name ?? '').trim())
}

/** 显示用的一句中文：labels 优先，其次内置说明，最后用动作名本身。 */
export function actionLabel(action, labels = {}) {
  const key = String(action ?? '').trim()
  const custom = labels && typeof labels === 'object' ? labels[key] : ''
  if (typeof custom === 'string' && custom.trim()) return custom.trim().slice(0, 40)
  return BUILTIN_ACTION_TEXT[key] ?? key
}

/** 找 pet.json 的候选路径；只返回去重后的绝对路径。 */
export function petPackCandidates(pet = {}, root = '') {
  const p = pet && typeof pet === 'object' ? pet : {}
  const out = []
  const dir = String(p.dir ?? '').trim()
  if (dir) out.push(join(resolve(dir), 'pet.json'))
  if (root) out.push(join(resolve(root), 'pets', petIdOf(p), 'pet.json'))
  const repo = String(p.repo ?? '').trim()
  if (repo) out.push(join(resolve(repo), 'pets', petIdOf(p), 'pet.json'))
  return [...new Set(out)]
}

/**
 * 读角色包的动作表。
 * @returns {{actions:string[], labels:Record<string,string>, source:string, name:string}}
 */
export function readPetPack(pet = {}, root = '') {
  for (const file of petPackCandidates(pet, root)) {
    try {
      if (!existsSync(file)) continue
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      const raw = doc?.animations?.actions
      const actions = Object.keys(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
        .map((x) => String(x).trim())
        .filter(safeActionName)
      if (!actions.length) continue
      const rawLabels = doc?.labels && typeof doc.labels === 'object' && !Array.isArray(doc.labels) ? doc.labels : {}
      const labels = {}
      for (const name of actions) {
        if (typeof rawLabels[name] === 'string' && rawLabels[name].trim()) {
          labels[name] = rawLabels[name].trim().slice(0, 40)
        }
      }
      return {
        actions: [...new Set(actions)],
        labels,
        source: file,
        name: typeof doc?.name === 'string' ? doc.name.trim().slice(0, 80) : '',
      }
    } catch { /* 读坏了就看下一个，最后回落内置 */ }
  }
  return { actions: [...BUILTIN_ACTIONS], labels: {}, source: '', name: '' }
}
