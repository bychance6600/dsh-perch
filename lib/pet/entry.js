/**
 * pet/entry.js —— roost 怎么起 body：路径、参数、超时、退出码
 *
 * 2026-11-08（m10008）。入口契约的唯一来源是 body 仓库的 docs/launch.md
 * （契约正文在 body 仓库 docs/launch.md）。这里只做可执行版本：
 * 改约定先改文档，再改这里和两边代码。
 *
 * 两种可执行文件：
 *   1. 打包产物 dsh-roost-pet.exe：直接起，cwd 是它所在目录；
 *   2. 开发态 electron.exe：参数前面加 body 仓库根，cwd 也是仓库根。
 * 开发态的仓库根优先读 pet.repo；没填时只从标准布局
 * <repo>/node_modules/electron/dist/electron.exe 反推，推不出来就报错，不猜别的路径。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PROTOCOL_VERSION } from './bridge.js'

/** 从 spawn 到收到 hello 的上限。协议说 10 秒；Electron 冷启动也要留够。 */
export const HELLO_TIMEOUT_MS = 10_000
/** 最多起几次（第一次 + 两次重试）。 */
export const MAX_ATTEMPTS = 3
/** 两次尝试之间等多久；第三次失败后置 dead，不再排。 */
export const RETRY_WAITS = [1000, 5000]
/** off() 时给 body 自己退出的时间；到点才动手。 */
export const STOP_GRACE_MS = 2000
/** body 说了 bye 之后，最多等它这么久。 */
export const BYE_GRACE_MS = 3000

/**
 * body 的退出码约定（launch.md §3 / 施工单 §4.4）：
 * 0 正常，1 未分类崩溃，2 握手/协议失败，3 已经有一只，4 参数/配置错。
 */
export const EXIT_CODES = {
  clean: 0,
  crash: 1,
  protocol: 2,
  alreadyRunning: 3,
  badArgs: 4,
}

/** 允许写进 --position 的值；空串 = 让 body 记住上次位置。 */
export const POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center']

/** 便携版 body 的文件名；默认放在 <root>/pet/ 下（2026-11-08 17:44 协调板）。 */
export const PET_BODY_NAME = 'dsh-roost-pet.exe'

/** 没填 pet.path 时，身体应该在哪：<root>/pet/dsh-roost-pet.exe。 */
export function defaultPetPath(root = '') {
  return root ? join(resolve(root), 'pet', PET_BODY_NAME) : join('pet', PET_BODY_NAME)
}

/** 实际要起的 exe：pet.path 优先，空着就用默认位置。 */
export function petPathOf(pet = {}, root = '') {
  const raw = String(pet?.path ?? '').trim()
  return raw ? resolve(raw) : defaultPetPath(root)
}

function sizeOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(2, Math.max(0.5, n))
}

function fmtSize(n) {
  return String(Number(n.toFixed(2)))
}

/** 角色包 id（config.pet.pack；老配置的 petId 也认）：缺省 default；只收短标识。 */
export function petIdOf(pet = {}) {
  const raw = String(pet?.pack ?? pet?.petId ?? '').trim()
  if (!raw) return 'default'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw)) return 'default'
  return raw
}

/**
 * 生成 body 的启动参数。顺序固定（launch.md §2）：
 * 协议 → 大小 → 位置 → 穿透 → 宠物包 → 额外参数。
 * 额外参数来自 config.pet.args，原样接在后面；body 自己决定认不认。
 */
export function bodyArgs(pet = {}) {
  const p = pet && typeof pet === 'object' ? pet : {}
  const args = [
    '--protocol=' + PROTOCOL_VERSION,
    '--size=' + fmtSize(sizeOf(p.size)),
  ]
  const pos = String(p.position ?? '').trim()
  if (POSITIONS.includes(pos)) args.push('--position=' + pos)
  args.push('--click-through=' + (p.clickThrough === false ? 0 : 1))
  args.push('--pet=' + petIdOf(p))
  const extra = Array.isArray(p.args) ? p.args.map((x) => String(x)).filter((x) => x !== '') : []
  return [...args, ...extra]
}

/** electron / electron.exe（大小写不敏感，兼容 Windows 路径）。 */
export function isElectronPath(path) {
  return /(^|[\\/])electron(?:\.exe)?$/i.test(String(path ?? '').trim())
}

/**
 * 开发态的标准布局：<repo>/node_modules/electron/dist/electron.exe。
 * 只有 package.json 里确实是 dsh-roost-pet 才认，避免把别的仓库当身体。
 */
function inferRepoFromElectron(exe) {
  const repo = resolve(dirname(exe), '..', '..', '..')
  try {
    const pkgPath = join(repo, 'package.json')
    if (!existsSync(pkgPath)) return ''
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return pkg?.name === 'dsh-roost-pet' ? repo : ''
  } catch {
    return ''
  }
}

/**
 * 把 pet 配置解析成一次 spawn 的三件事：可执行文件、参数、cwd。
 * 解析失败就抛错，由 index.js 转成一次失败重试；不在别处另写一套路径规则。
 */
export function entrySpec(pet = {}) {
  const p = pet && typeof pet === 'object' ? pet : {}
  const rawPath = String(p.path ?? '').trim()
  if (!rawPath) throw new Error('没填宠物包的路径')
  const exe = resolve(rawPath)
  const args = bodyArgs(p)
  if (!isElectronPath(exe)) {
    return { path: exe, args, cwd: dirname(exe) }
  }
  const configured = String(p.repo ?? '').trim()
  const repo = configured ? resolve(configured) : inferRepoFromElectron(exe)
  if (!repo) {
    throw new Error('开发态要用 Electron 起：请填 pet.repo（body 仓库根）')
  }
  return { path: exe, args: [repo, ...args], cwd: repo }
}

/**
 * 子进程环境：spawn 前删掉 ELECTRON_RUN_AS_NODE。
 * Windows 上有些环境会继承它，Electron 会当成 node 跑，主进程根本不启动。
 */
export function childEnv(base = process.env) {
  const env = { ...(base || {}) }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * 退出码怎么算：
 * - 已经说过 bye，或退出码 0：正常关掉，不重拉；
 * - 3（已经有一只）/ 4（参数错）：重试也不会好，直接 dead；
 * - 2（握手/协议失败）、1、信号、其他：按退避重试。
 */
export function classifyExit(code, signal, { clean = false } = {}) {
  if (clean) return 'clean'
  const n = code == null || code === '' ? null : Number(code)
  if (n === EXIT_CODES.clean) return 'clean'
  if (n === EXIT_CODES.alreadyRunning || n === EXIT_CODES.badArgs) return 'dead'
  return 'retry'
}
