#!/usr/bin/env node
/**
 * tools/install-pet.mjs —— 把桌宠身体和角色包装进她的家（2026-11-08 17:44 协调板）
 *
 * 零依赖。Windows 上用 PowerShell 的 Expand-Archive（不引第三方解压库）。
 *
 *   node tools/install-pet.mjs --body dsh-roost-pet.zip --pack default.zip
 *   node tools/install-pet.mjs --body dsh-roost-pet.zip --pack test2.zip --id test2
 *
 * 做的事：
 *   1. body 解到 <root>/pet/（找 dsh-roost-pet.exe，允许 zip 里套一层目录）
 *   2. pack 解到 <root>/pets/<id>/
 *   3. 改 <root>/config.json：pet.enabled=true、pet.path=<exe>、pet.pack=<id>
 *      改之前留 config.json.bak-<时间>
 *
 * root 默认 ~/.dsh-roost；测试或临时装可以用 --root。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const BODY_NAME = 'dsh-roost-pet.exe'
const PACK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function usage() {
  return [
    '用法：node tools/install-pet.mjs --body <zip> [--pack <zip>] [--id default] [--root <dir>]',
    '',
    '  --body  桌宠 body 的便携版 zip（解到 <root>/pet/）',
    '  --pack  角色包 zip（解到 <root>/pets/<id>/）',
    '  --id    角色包文件夹名，默认 default',
    '  --root  她的数据目录，默认 ~/.dsh-roost',
    '  --help  看这一页',
  ].join('\n')
}

function argOf(argv, name, fallback = '') {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : fallback
}

function has(argv, name) {
  return argv.includes(name)
}

function die(message, code = 1) {
  console.error('没装成：' + message)
  process.exit(code)
}

/** 用 PowerShell 解压；每个参数都做单引号转义，不拼未转义的路径。 */
function expand(zipPath, dest) {
  mkdirSync(dest, { recursive: true })
  const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const script = 'Expand-Archive -LiteralPath ' + q(zipPath) + ' -DestinationPath ' + q(dest) + ' -Force'
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (r.error) die('解压失败：' + (r.error.message || String(r.error)))
  if (r.status !== 0) die('解压失败：' + basename(zipPath))
}

/** 在解压目录里找 body 的 exe；返回最浅的那一个。 */
function findBody(dir, depth = 0) {
  if (depth > 4) return ''
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === BODY_NAME) return join(dir, e.name)
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const hit = findBody(join(dir, e.name), depth + 1)
    if (hit) return hit
  }
  return ''
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function main() {
  const argv = process.argv.slice(2)
  if (has(argv, '--help') || has(argv, '-h')) {
    console.log(usage())
    return
  }

  const bodyZip = argOf(argv, '--body')
  const packZip = argOf(argv, '--pack')
  const id = String(argOf(argv, '--id', 'default')).trim() || 'default'
  const root = resolve(argOf(argv, '--root', process.env.DSH_ROOST_HOME || join(homedir(), '.dsh-roost')))

  if (!bodyZip) die('要 --body <zip>。\n\n' + usage())
  if (!PACK_RE.test(id)) die('角色包 id 只能用字母、数字、点、下划线、短横线：' + id)
  if (!existsSync(bodyZip)) die('找不到 body zip：' + bodyZip)
  if (packZip && !existsSync(packZip)) die('找不到角色包 zip：' + packZip)

  // 1) 身体
  const bodyDir = join(root, 'pet')
  expand(resolve(bodyZip), bodyDir)
  const exe = findBody(bodyDir)
  if (!exe) die('zip 解开了，但里面没有 ' + BODY_NAME + '：' + bodyDir)

  // 2) 角色包（可选）
  let packDir = ''
  if (packZip) {
    packDir = join(root, 'pets', id)
    expand(resolve(packZip), packDir)
    if (!existsSync(join(packDir, 'pet.json'))) {
      die('角色包解开了，但没有 pet.json：' + packDir)
    }
  }

  // 3) 配置
  const cfgPath = join(root, 'config.json')
  let cfg = {}
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('不是对象')
    } catch (err) {
      die('config.json 读不出来，先别覆盖它：' + (err?.message ?? err))
    }
    copyFileSync(cfgPath, cfgPath + '.bak-' + stamp())
  }
  cfg.pet = cfg.pet && typeof cfg.pet === 'object' && !Array.isArray(cfg.pet) ? cfg.pet : {}
  cfg.pet.enabled = true
  cfg.pet.path = exe
  if (packZip) cfg.pet.pack = id
  mkdirSync(root, { recursive: true })
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')

  console.log('装好了。')
  console.log('  身体：' + exe)
  if (packDir) console.log('  角色包：' + packDir + '（' + id + '）')
  console.log('  配置：' + cfgPath)
  console.log('')
  console.log('下一步：重启 DSH。设置 → 插件 → 桌宠 里应显示「已安装」。')
}

main()
