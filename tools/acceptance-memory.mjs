#!/usr/bin/env node
/**
 * acceptance-memory.mjs —— 记忆图谱 / 三种 kinds / 布局 / 过滤 / 性能的验收表
 *
 * 只读真账本，不 apply、不写盘、不改 lib/。默认读 ~/.dsh-perch-samples。
 * 产出一张可重复跑的表，不是结论：
 *   1. /api/memory 三种 kinds（belief / utterance / heard）的节点数与 JSON 字节数
 *   2. 同一份数据跑两次，页面布局坐标逐项 deepEqual
 *   3. 关掉 heard 后，belief 的坐标不变（当前页面没有 heard 时，额外用 status 过滤做代理检查）
 *   4. 布局 + 首帧绘制耗时（Node 内用 vm 跑页面脚本，不启浏览器）
 *   5. node --test --test-isolation=none 全量回归不增红
 *
 * 用法：
 *   node tools/acceptance-memory.mjs
 *   node tools/acceptance-memory.mjs --root ~/.dsh-perch-samples --json
 *   node tools/acceptance-memory.mjs --skip-regression
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import * as vm from 'node:vm'

import { MEMORY_PAGE } from '../lib/memory-page.js'
import { registerObserve } from '../lib/observe.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ROOT = join(homedir(), '.dsh-perch-samples')

/** 产品验收口径：三种 kinds 的节点数。数字来自真账本，不是实现巧合。 */
export const EXPECTED_KIND_COUNTS = Object.freeze({
  belief: 860,
  utterance: 868,
  heard: 1486,
})

/** 约 1.2 MiB；给 1.1–1.4 MiB 的容差，避免把「约」写成逐字节相等。 */
export const EXPECTED_TOTAL_BYTES = 1.2 * 1024 * 1024
export const BYTES_MIN = 1.1 * 1024 * 1024
export const BYTES_MAX = 1.4 * 1024 * 1024

/** AGENTS.md 里的全量基线（2026-11-13）。 */
export const BASELINE = Object.freeze({ tests: 1485, pass: 1474, fail: 9, skipped: 2 })

const PERF_LIMIT_MS = 1000
const REGRESSION_TIMEOUT_MS = 300000

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { root: DEFAULT_ROOT, json: false, skipRegression: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (!v) throw new Error(a + ' 后面要跟一个值')
      return v
    }
    if (a === '--root') out.root = resolve(val())
    else if (a === '--json') out.json = true
    else if (a === '--skip-regression') out.skipRegression = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error('不认识的参数：' + a + '（--help 看用法）')
  }
  out.root = resolve(out.root)
  return out
}

function fakeRes() {
  const res = {
    code: 200,
    body: '',
    headers: {},
    writableEnded: false,
    writeHead(code, headers) {
      res.code = code
      Object.assign(res.headers, headers || {})
      return res
    },
    end(chunk) {
      if (chunk) res.body += String(chunk)
      res.writableEnded = true
      return res
    },
    get json() {
      try { return JSON.parse(res.body) } catch { return null }
    },
  }
  return res
}

/** 直接调 registerObserve 拿 /dsh-perch/api/memory 的响应；不经过 apply，不播种、不写盘。 */
export async function callMemory(root) {
  const routes = []
  const ctx = {
    webServer: { register(ex) { routes.push(ex); return () => {} } },
    connection: { requestRejection: () => null },
    logger: { info() {}, warn() {}, error() {} },
    get(key) { return ctx[key] },
  }
  const handle = registerObserve(ctx, { root })
  try {
    const route = routes.find((r) => r.path === '/dsh-perch/api/memory')
    if (!route) throw new Error('没有注册 /dsh-perch/api/memory')
    const res = fakeRes()
    const t0 = performance.now()
    await route.handler({ method: 'GET', url: '/dsh-perch/api/memory', headers: { accept: 'application/json' } }, res)
    const ms = performance.now() - t0
    if (res.code !== 200) throw new Error('HTTP ' + res.code + '：' + String(res.body).slice(0, 200))
    const body = res.json
    if (!body || !Array.isArray(body.nodes)) throw new Error('响应形状不对：缺 nodes 数组')
    return { body, bytes: Buffer.byteLength(res.body, 'utf8'), ms, responseText: res.body }
  } finally {
    handle.dispose?.()
  }
}

/** 读账本原件：per-type 条数与字节数。只读、只统计，不解析成派生结果。 */
export function readLedger(root) {
  const file = join(root, 'events.jsonl')
  if (!existsSync(file)) throw new Error('读不到账本：' + file + '（用 --root 指到样本目录）')
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0)
  const types = {}
  let parseErrors = 0
  for (const line of lines) {
    let ev
    try { ev = JSON.parse(line) } catch { parseErrors += 1; ev = null }
    const type = String(ev?.type || 'unknown')
    const slot = types[type] || (types[type] = { count: 0, bytes: 0 })
    slot.count += 1
    slot.bytes += Buffer.byteLength(line, 'utf8') + 1
  }
  return { file, bytes: Buffer.byteLength(raw, 'utf8'), lines: lines.length, types, parseErrors }
}

export function countKinds(nodes) {
  const byKind = {}
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const kind = String(n?.kind || 'unknown')
    const slot = byKind[kind] || (byKind[kind] = { count: 0, bytes: 0, nodes: [] })
    slot.count += 1
    slot.nodes.push(n)
  }
  for (const slot of Object.values(byKind)) slot.bytes = Buffer.byteLength(JSON.stringify(slot.nodes), 'utf8')
  return {
    byKind,
    total: Array.isArray(nodes) ? nodes.length : 0,
    bytes: Buffer.byteLength(JSON.stringify(Array.isArray(nodes) ? nodes : []), 'utf8'),
  }
}

export function cloneData(data) {
  return JSON.parse(JSON.stringify(data))
}

function makeElement(id, tagName = 'div') {
  return {
    id,
    tagName,
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      toggle(c, on) { if (on === undefined) on = !this._set.has(c); if (on) this._set.add(c); else this._set.delete(c); return on },
      contains(c) { return this._set.has(c) },
    },
    listeners: {},
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    min: 0,
    max: 100,
    offsetWidth: 0,
    offsetHeight: 0,
    children: [],
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn) },
    emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev) },
    setAttribute(k, v) { this[k] = String(v) },
    getAttribute(k) { return this[k] == null ? null : String(this[k]) },
    insertBefore(node) { this.children.unshift(node); return node },
    remove() {},
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900 } },
  }
}

function makeCanvasContext() {
  const gradient = { addColorStop() {} }
  const noop = () => {}
  const ctx = {
    setTransform: noop,
    clearRect: noop,
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    fillRect: noop,
    save: noop,
    translate: noop,
    scale: noop,
    restore: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    moveTo: noop,
    lineTo: noop,
    setLineDash: noop,
    closePath: noop,
    measureText: (text) => ({ width: String(text).length * 6 }),
    fillText: noop,
  }
  return ctx
}

/**
 * 在 Node 里跑 lib/memory-page.js 的整段页面脚本：DOM / canvas / fetch 都用桩。
 * 返回第一次 paint 后的 __memoryGraph、全部节点的屏幕坐标、以及「数据到达→首帧完成」的毫秒数。
 */
export async function runPage(data, opts = {}) {
  const scriptMatch = MEMORY_PAGE.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  if (!scriptMatch) throw new Error('memory-page.js 里找不到 <script>')
  const script = scriptMatch[1]

  const elements = new Map()
  const getEl = (id) => {
    let el = elements.get(id)
    if (!el) { el = makeElement(id); elements.set(id, el) }
    return el
  }
  const modeButtons = ['status', 'group', 'time'].map((m) => {
    const b = makeElement('', 'button')
    b['data-mode'] = m
    return b
  })
  const ctx2d = makeCanvasContext()
  let canvas = null
  const makeCanvas = () => {
    const c = makeElement('', 'canvas')
    c.width = 0
    c.height = 0
    c.getContext = () => ctx2d
    c.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900 })
    c.setPointerCapture = () => {}
    c.releasePointerCapture = () => {}
    return c
  }

  const document = {
    hidden: false,
    getElementById: getEl,
    createElement(tag) { return String(tag) === 'canvas' ? makeCanvas() : makeElement('', tag) },
    querySelectorAll(sel) { return sel === '#modes button' ? modeButtons : [] },
    addEventListener() {},
  }

  let graph = null
  let paintAt = 0
  let fetchAt = 0
  let resolvePaint
  const painted = new Promise((r) => { resolvePaint = r })
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    performance,
    AbortController,
    document,
    location: { hash: '', pathname: '/dsh-perch/memory', search: '' },
    history: { replaceState() {} },
    navigator: {},
    devicePixelRatio: 1,
    requestAnimationFrame() { return 1 },
    cancelAnimationFrame() {},
    matchMedia() { return { matches: false, addEventListener() {} } },
    addEventListener() {},
    fetch: async () => {
      fetchAt = performance.now()
      return { ok: true, status: 200, json: async () => data }
    },
  }
  sandbox.window = sandbox
  Object.defineProperty(sandbox, '__memoryGraph', {
    configurable: true,
    get() { return graph },
    set(v) { graph = v; paintAt = performance.now(); resolvePaint(v) },
  })

  vm.createContext(sandbox)
  vm.runInContext(script, sandbox, { filename: 'memory-page.inline.js' })

  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('页面 5s 内没有完成首帧；empty=' + getEl('emptyWhy').textContent)), 5000)
  })
  try {
    await Promise.race([painted, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!graph) throw new Error('页面没有暴露 __memoryGraph')
  // vm 里造出来的对象原型来自另一个 realm，isDeepStrictEqual 会因原型不同判 false；
  // 先 JSON 往返成宿主对象，比较的是坐标本身，不是对象的出生地。
  const stats = JSON.parse(JSON.stringify(graph.stats()))
  const coords = []
  for (let i = 0; i < data.nodes.length; i += 1) {
    const p = graph.clientOf(i)
    coords.push(p ? { x: p.x, y: p.y, id: p.id } : null)
  }
  return {
    graph,
    stats,
    coords,
    paintMs: paintAt - fetchAt,
    legend: getEl('legend'),
    search: getEl('search'),
    when: getEl('when'),
    elements,
    canvas,
  }
}

function coordsForBeliefs(run, data) {
  return data.nodes.map((n, i) => ({ i, kind: n.kind, coord: run.graph.clientOf(i) })).filter((x) => x.kind === 'belief')
}

export function triggerStatusFilter(run, status) {
  const target = {
    getAttribute(name) { return name === 'data-status' ? status : null },
  }
  run.legend.emit('click', {
    target: { closest() { return target } },
  })
}

export function triggerSearchFilter(run, text) {
  run.search.value = text
  run.search.emit('input')
}

/** 布局确定性：同一份数据两个独立页面实例，比较全部节点的屏幕坐标。 */
export async function checkLayoutDeterminism(data) {
  const a = await runPage(cloneData(data))
  const b = await runPage(cloneData(data))
  const same = isDeepStrictEqual(a.stats.axes, b.stats.axes) &&
    a.coords.length === b.coords.length &&
    a.coords.every((p, i) => isDeepStrictEqual(p, b.coords[i]))
  return {
    status: same ? '通过' : '不通过',
    measured: 'axes + ' + a.coords.length + ' 个屏幕坐标 deepEqual=' + same,
    detail: { axesA: a.stats.axes, axesB: b.stats.axes },
    runs: [a, b],
    ms: Math.max(a.paintMs, b.paintMs),
  }
}

/**
 * 布局/过滤解耦。当前页面只认 status/group/cited/recent/search，没有 heard 类型；
 * 有 heard 时优先找 setKindFilter/toggleKind；没有就明说「不通过」，并用 status 过滤做代理检查。
 */
export async function checkFilterDecoupling(data) {
  const saysHeard = Array.isArray(data.nodes) && data.nodes.some((n) => String(n?.kind) === 'heard')
  const run = await runPage(cloneData(data))
  const before = coordsForBeliefs(run, data)
  let proxy = null

  const status = Array.isArray(data.nodes) && data.nodes.some((n) => n?.status === 'refuted')
    ? 'refuted'
    : (Array.isArray(data.nodes) && data.nodes.some((n) => n?.kind === 'scar') ? 'scar' : null)
  if (status) {
    triggerStatusFilter(run, status)
    const after = coordsForBeliefs(run, data)
    const same = isDeepStrictEqual(before.map((x) => x.coord), after.map((x) => x.coord))
    proxy = { filter: 'status=' + status, same }
  } else {
    triggerSearchFilter(run, '____acceptance_no_hit____')
    const after = coordsForBeliefs(run, data)
    proxy = { filter: 'search=____acceptance_no_hit____', same: isDeepStrictEqual(before.map((x) => x.coord), after.map((x) => x.coord)) }
  }

  if (!saysHeard) {
    return {
      status: '不通过',
      measured: 'API 没有 heard 节点，页面也没有 heard 开关；代理 ' + proxy.filter + ' 前后 belief 坐标 deepEqual=' + proxy.same,
      detail: { saysHeard, proxy },
      run,
    }
  }

  const g = run.graph
  let applied = ''
  if (typeof g.setKindFilter === 'function') {
    g.setKindFilter('heard', false)
    applied = 'setKindFilter("heard", false)'
  } else if (typeof g.toggleKind === 'function') {
    g.toggleKind('heard')
    applied = 'toggleKind("heard")'
  }
  if (!applied) {
    return {
      status: '不通过',
      measured: '有 heard 节点，但页面没有暴露关掉 heard 的入口',
      detail: { saysHeard, proxy },
      run,
    }
  }
  const after = coordsForBeliefs(run, data)
  const same = isDeepStrictEqual(before.map((x) => x.coord), after.map((x) => x.coord))
  return {
    status: same ? '通过' : '不通过',
    measured: applied + ' 前后 belief 坐标 deepEqual=' + same,
    detail: { saysHeard, proxy, applied },
    run,
  }
}

export function runRegression(cwd = REPO) {
  const t0 = performance.now()
  const r = spawnSync(process.execPath, ['--test', '--test-isolation=none'], {
    cwd,
    encoding: 'utf8',
    timeout: REGRESSION_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  })
  const ms = performance.now() - t0
  const out = String(r.stdout || '') + '\n' + String(r.stderr || '')
  const pick = (label) => {
    const m = out.match(new RegExp('(?:#|ℹ)\\s*' + label + '\\s+(\\d+)'))
    return m ? Number(m[1]) : null
  }
  const tests = pick('tests')
  const pass = pick('pass')
  const fail = pick('fail')
  const skipped = pick('skipped')
  const parsed = tests != null && pass != null && fail != null
  const ok = parsed && fail <= BASELINE.fail && tests >= BASELINE.tests
  return {
    status: ok ? '通过' : '不通过',
    measured: parsed
      ? tests + ' tests / ' + pass + ' pass / ' + fail + ' fail / ' + (skipped ?? '?') + ' skipped（基线 ' + BASELINE.tests + '/' + BASELINE.pass + '/' + BASELINE.fail + '/' + BASELINE.skipped + '）'
      : '没解析到 node --test 汇总（exit=' + r.status + '）',
    detail: { tests, pass, fail, skipped, exitCode: r.status, ms, tail: out.slice(-4000) },
    ms,
  }
}

export async function runAcceptance(opts = {}) {
  const root = resolve(opts.root || DEFAULT_ROOT)
  const api = await callMemory(root)
  const ledger = readLedger(root)
  const kinds = countKinds(api.body.nodes)

  const kindRows = Object.entries(EXPECTED_KIND_COUNTS).map(([kind, expected]) => {
    const got = kinds.byKind[kind] || { count: 0, bytes: 0 }
    return { kind, expected, count: got.count, bytes: got.bytes, ok: got.count === expected }
  })
  const bytesOk = api.bytes >= BYTES_MIN && api.bytes <= BYTES_MAX
  const apiKindsOk = kindRows.every((r) => r.ok)
  const kindsRow = {
    status: apiKindsOk && bytesOk ? '通过' : '不通过',
    measured: kindRows.map((r) => r.kind + ' ' + r.count + '/' + r.expected + ' 条 ' + r.bytes + 'B').join('；') +
      '；API ' + api.bytes + 'B（期望约 1.2MiB，' + Math.round(BYTES_MIN) + '–' + Math.round(BYTES_MAX) + 'B）' +
      '；账本 ' + ledger.bytes + 'B',
    detail: { kindRows, apiBytes: api.bytes, apiKindsOk, bytesOk, ledger },
  }

  const det = await checkLayoutDeterminism(api.body)
  const filter = await checkFilterDecoupling(api.body)
  const perf = {
    status: det.ms < PERF_LIMIT_MS ? '通过' : '不通过',
    measured: '两次布局+首帧取最大 ' + det.ms.toFixed(1) + 'ms（上限 ' + PERF_LIMIT_MS + 'ms）',
    detail: { runs: det.runs.map((r) => r.paintMs) },
  }
  const regression = opts.skipRegression
    ? { status: '未跑', measured: '--skip-regression', detail: null }
    : runRegression(opts.cwd || REPO)

  const rows = [
    { key: 'kinds', item: '1. /api/memory 三种 kinds', ...kindsRow },
    { key: 'layout', item: '2. 布局确定性', status: det.status, measured: det.measured, detail: det.detail },
    { key: 'filter', item: '3. 关掉 heard 后 belief 坐标不变', status: filter.status, measured: filter.measured, detail: filter.detail },
    { key: 'perf', item: '4. 布局 + 首帧 < 1000ms', status: perf.status, measured: perf.measured, detail: perf.detail },
    { key: 'regression', item: '5. 全量回归不增红', status: regression.status, measured: regression.measured, detail: regression.detail },
  ]
  const verdict = rows.every((r) => r.status === '通过')
  const kindSummary = {}
  for (const [kind, slot] of Object.entries(kinds.byKind)) kindSummary[kind] = { count: slot.count, bytes: slot.bytes }
  return { root, generatedAt: new Date().toISOString(), verdict, rows, apiMs: api.ms, ledger, kinds: { total: kinds.total, bytes: kinds.bytes, byKind: kindSummary } }
}

function printTable(result) {
  const cols = ['项', '结果', '实测']
  const widths = [30, 8, 110]
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')
  console.log(line(cols))
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'))
  for (const row of result.rows) console.log(line([row.item, row.status, row.measured]))
  console.log('')
  console.log('根目录：' + result.root)
  console.log('总判定：' + (result.verdict ? '通过' : '不通过'))
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('用法：node tools/acceptance-memory.mjs [--root DIR] [--json] [--skip-regression]')
    console.log('默认根目录：' + DEFAULT_ROOT)
    return 0
  }
  const result = await runAcceptance(args)
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else printTable(result)
  return result.verdict ? 0 : 1
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((err) => {
    console.error('验收失败：' + (err?.stack || err))
    process.exitCode = 1
  })
}
