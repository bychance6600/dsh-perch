/**
 * install-pet.test.mjs —— 一条命令把身体和角色包装进她的家（2026-11-08 17:44）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../tools/install-pet.mjs', import.meta.url))

function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

function zipDir(dir, out) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path ${q(join(dir, '*'))} -DestinationPath ${q(out)} -Force`,
  ], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error('压缩测试包失败：' + (r.stderr || r.stdout || r.error))
}

test('没有 --body 时不装，只说用法', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /要 --body/)
  assert.match(r.stderr, /--pack/)
})

test('解 body、解角色包、写配置；改配置前留备份（2026-11-08 17:44）', async (t) => {
  // 解压用的是 PowerShell 的 Expand-Archive；Linux 的 runner 上没有这个命令。
  if (process.platform !== 'win32') return t.skip('身体和角色包只在 Windows 上解压')
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-roost-install-'))
  const src = join(tmp, 'src')
  const body = join(src, 'body')
  const pack = join(src, 'pack')
  await mkdir(body, { recursive: true })
  await mkdir(pack, { recursive: true })
  await writeFile(join(body, 'dsh-roost-pet.exe'), 'not a real exe')
  await writeFile(join(body, 'resources.pak'), 'x')
  await writeFile(join(pack, 'pet.json'), JSON.stringify({ name: '小猫', animations: { actions: { wave: {} } } }))
  const bodyZip = join(tmp, 'body.zip')
  const packZip = join(tmp, 'pack.zip')
  zipDir(body, bodyZip)
  zipDir(pack, packZip)

  const root = join(tmp, 'home')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'config.json'), JSON.stringify({ growthDays: 30, pet: { enabled: false } }, null, 2))

  const r = spawnSync(process.execPath, [
    SCRIPT, '--body', bodyZip, '--pack', packZip, '--id', 'cat-2', '--root', root,
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr || r.stdout)

  const exe = join(root, 'pet', 'dsh-roost-pet.exe')
  assert.equal(existsSync(exe), true)
  assert.equal(existsSync(join(root, 'pets', 'cat-2', 'pet.json')), true)

  const cfg = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  assert.equal(cfg.growthDays, 30)
  assert.equal(cfg.pet.enabled, true)
  assert.equal(cfg.pet.path, exe)
  assert.equal(cfg.pet.pack, 'cat-2')

  const backups = (await readdir(root)).filter((x) => x.startsWith('config.json.bak-'))
  assert.equal(backups.length, 1)
  await rm(tmp, { recursive: true, force: true })
})
