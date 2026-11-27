/**
 * 一键诊断（本地版）——维护功能 M2/M3。
 *
 * 和 `lib/log.js` 的「导出运行日志」不是一回事：
 * - 导出：给用户自己看 / 丢给 AI 排查的，含事件流尾巴（可能有她说过的话）；
 * - 诊断包：**发给维护端**的，只出环境、配置开关与数量、自检结果、事件类型计数、
 *   日志里的 warn/error 行。不出现事件正文、消息文本、人名、群号、cookie、key。
 *
 * 首版是纯文本单文件而不是 zip：零依赖下拼 zip 中央目录不值得先付这个复杂度，
 * 一个文件 < 2MB 就够把人卡在哪说清楚。需要多文件时再加（见规格）。
 *
 * 2026-11-27 公开仓 issue #12（主人 m02861「先把诊断这个弄出来」开工）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { scrub, tailLog } from './log.js'

/** 一个诊断包最多这么大（规格验收：< 2MB）。 */
export const DIAG_MAX_BYTES = 2 * 1024 * 1024
/** 本地最多留这么多份，多了删最旧的（按文件名排序，名字里带时间戳）。 */
export const DIAG_KEEP = 20
/** 日志里最多抄这么多行 warn/error。 */
export const DIAG_LOG_LINES = 120

export function diagDir(root) {
  return join(root || process.env.DSH_ROOST_HOME || '.', 'out', 'diag')
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 20261127-093015，本地时间。 */
export function diagStamp(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

export function diagName(now = new Date()) {
  return `dsh-perch-诊断-${diagStamp(now)}.txt`
}

function readTailText(file, maxBytes) {
  const st = statSync(file)
  const size = st.size
  const readBytes = Math.min(size, Math.max(1024, maxBytes))
  const buf = readFileSync(file)
  const slice = buf.subarray(buf.length - readBytes)
  const text = slice.toString('utf8')
  // 从尾部读，第一行可能是半截，丢掉。
  return { text, partial: readBytes < size, size }
}

/**
 * 事件流只出类型计数，绝不出正文。
 * 采样尾部（默认 512KB）而不是整个文件——几万条的账本全读一遍没必要。
 */
export function eventTypeCounts(root, { maxBytes = 512 * 1024 } = {}) {
  const out = { exists: false, bytes: 0, sampled: 0, badLines: 0, types: [], why: '' }
  const file = join(root || '', 'events.jsonl')
  try {
    if (!root || !existsSync(file)) return out
    const { text, partial, size } = readTailText(file, maxBytes)
    out.exists = true
    out.bytes = size
    const lines = text.split('\n').filter((l) => l.trim())
    if (partial) lines.shift()
    const counts = new Map()
    for (const line of lines) {
      let type = ''
      try {
        const ev = JSON.parse(line)
        type = String(ev?.type ?? '(无类型)')
      } catch {
        out.badLines += 1
        type = '(坏行)'
      }
      counts.set(type, (counts.get(type) || 0) + 1)
    }
    out.sampled = lines.length
    out.types = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }))
  } catch (err) {
    out.why = String(err?.message ?? err)
  }
  return out
}

/** 配置只出「开关与数量」：够判断坏在哪，又不泄露凭证与内容。 */
export function configSummary(config) {
  const c = config && typeof config === 'object' ? config : {}
  const qq = c.channels?.qq ?? {}
  const n = (v) => (Array.isArray(v) ? v.length : 0)
  const on = (v) => (v === false ? '关' : v ? '开' : '未配')
  return [
    `QQ 渠道: ${on(qq.enabled)} · 群 ${n(qq.groups)} 个 · 客厅 ${n(qq.rooms)} 个 · 只回点名 ${qq.mentionOnly === false ? '否' : '是'}`,
    `B 站: ${on(c.bili?.enabled)} · 刷站: ${on(c.browse?.enabled)} · 抖音: ${on(c.browse?.douyin?.enabled)}`,
    `桌宠: ${on(c.pet?.enabled)} · 日记: ${on(c.diary?.enabled)}`,
    `工具: 收窄 ${c.tools?.restrict === false ? '关' : '开'} · 白名单 ${n(c.tools?.allow)} 个`,
  ]
}

function checksLines(checks) {
  if (!checks || !Array.isArray(checks.items) || !checks.items.length) {
    return ['自检: (没跑；用 ?checks=0 跳过或当时跑不动)']
  }
  const bad = checks.items.filter((it) => !it.ok)
  const out = [`自检: ${checks.summary || `${checks.items.length - bad.length}/${checks.items.length} 项正常`}`]
  for (const it of checks.items) {
    // 只抄坏的那几项：好的项把包撑大，对排查没帮助。
    if (it.ok) continue
    out.push(`BAD ${it.label || it.id}: ${it.detail || ''}${it.fix ? ` | 修法: ${it.fix}` : ''}`)
  }
  return out
}

/** 日志里可能夹着 key/cookie 这类值；诊断包要发给别人，先按「名字=值」再洗一遍。 */
function redactSecrets(text) {
  return String(text ?? '').replace(
    /(cookie|token|secret|password|passwd|authorization|bearer|api[_-]?key)\s*[=:]\s*[^\s,;'"}\]]{3,}/gi,
    '$1=***',
  )
}

function logLinesText(root) {
  const tail = tailLog(root, { lines: 400, maxBytes: 256 * 1024 })
  if (!tail.exists) return { text: '(还没有日志文件)', count: 0, exists: false, bytes: 0 }
  const picked = tail.lines.filter((l) => /\s\[(warn|error)\]\s/.test(l))
  const lines = picked.slice(-DIAG_LOG_LINES)
  // logLine 写入时已经 scrub 过一次；这里再洗一遍，防老版本日志里带没洗的内容。
  const text = lines.length ? lines.map((l) => redactSecrets(scrub(l)).slice(0, 500)).join('\n') : '(最近没有 warn/error)'
  return { text, count: lines.length, exists: true, bytes: tail.bytes }
}

function codeCounts(lines) {
  const m = new Map()
  for (const l of lines) {
    // 两种写法都认：裸 token `E_BRIDGE_WS`，和 `code=E_BRIDGE_WS` / `code: E_...`。
    const seen = new Set()
    for (const re of [/\bE_[A-Z0-9_]{2,}\b/g, /code[=:]\s*([A-Z][A-Z0-9_]{2,})/g]) {
      let r
      while ((r = re.exec(l))) seen.add(r[1] ?? r[0])
    }
    for (const code of seen) m.set(code, (m.get(code) || 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }))
}

/**
 * 生成诊断包正文。返回 { text, summary }。
 * `checks` 是 `lib/selfcheck.js` 的 runChecks 结果；`config` 原样传进来（内部只读安全字段）。
 */
export function buildDiagnose(root, { version = '', config = null, checks = null, now = new Date(), eventMaxBytes = 512 * 1024 } = {}) {
  const events = eventTypeCounts(root, { maxBytes: eventMaxBytes })
  const log = logLinesText(root)
  const codes = codeCounts(log.text.split('\n'))
  const lines = [
    '=== dsh-perch 诊断包（本地生成，未上传） ===',
    `生成时间: ${new Date(now).toISOString()}`,
    `插件版本: ${version || '(未知)'}`,
    `Node: ${process.version} / 平台: ${platform()} ${arch()} / 系统: ${release()}`,
    `状态库: ${root || '(未知)'}`,
    '',
    '--- 配置摘要（只有开关与数量，没有凭证与内容） ---',
    ...configSummary(config),
    '',
    '--- 自检 ---',
    ...checksLines(checks),
    '',
    `--- 事件流（文件 ${events.bytes} 字节；采样 ${events.sampled} 条）---`,
    events.exists
      ? `类型计数: ${events.types.map((t) => `${t.type}=${t.count}`).join(' · ') || '(空)'}`
      : '(还没有 events.jsonl)',
    events.badLines ? `解析不了的坏行: ${events.badLines} 条` : '',
    '',
    `--- 日志 warn/error（最近 ${log.count} 行；文件 ${log.bytes} 字节）---`,
    codes.length ? `错误码计数: ${codes.map((c) => `${c.code}×${c.count}`).join(' · ')}` : '错误码计数: (日志里没写 code)',
    log.text,
    '',
    '=== 结束：本文件不含事件正文、消息、人名、群号、cookie、模型 key ===',
  ].filter((l) => l != null)
  let text = lines.join('\n') + '\n'

  // 硬上限：超了就从中间截断，保留头尾——头和尾才是排查要用的。
  if (Buffer.byteLength(text, 'utf8') > DIAG_MAX_BYTES) {
    const head = lines.slice(0, 40).join('\n')
    const tail = lines.slice(-60).join('\n')
    text = `${head}\n\n…（包太大，中间省略；原样 ${Buffer.byteLength(text, 'utf8')} 字节）…\n\n${tail}\n`
  }

  const badCount = checks && Array.isArray(checks.items) ? checks.items.filter((it) => !it.ok).length : 0
  const summary =
    `dsh-perch 诊断 ${version || '(未知版本)'} / ${platform()} ${arch()}\n` +
    `自检: ${checks ? `${badCount} 项坏` : '没跑'} · 日志 warn/error ${log.count} 行 · ` +
    `事件采样 ${events.sampled} 条${events.types.length ? `（${events.types.length} 种类型）` : ''}\n` +
    `报告文件: ${diagName(now)}（发群里时连文件一起发）`
  return { text, summary }
}

/** 写盘 + 只留最近 DIAG_KEEP 份。返回 { path, name, bytes }。 */
export function saveDiagnose(root, text, { now = new Date(), keep = DIAG_KEEP } = {}) {
  const dir = diagDir(root)
  mkdirSync(dir, { recursive: true })
  const name = diagName(now)
  const path = join(dir, name)
  writeFileSync(path, text, 'utf8')
  const bytes = Buffer.byteLength(text, 'utf8')
  try {
    const files = readdirSync(dir)
      .filter((f) => /^dsh-perch-诊断-.*\.txt$/.test(f))
      .sort()
    while (files.length > Math.max(1, keep)) {
      const old = files.shift()
      try {
        unlinkSync(join(dir, old))
      } catch {
        /* 删旧包失败不影响这次 */
      }
    }
  } catch {
    /* 清理失败不影响保存 */
  }
  return { path, name, bytes }
}
