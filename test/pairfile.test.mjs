/**
 * pairfile.test.mjs —— 两份说好的文件（2026-11-07，m08813）
 *
 * 守四件事：
 *   1. 只认配置里那两个绝对路径，别名按文件名；
 *   2. 读回 hash，改 / 添都要带回来；没带或过期，一个字都不写；
 *   3. 改一段只能命中一处；写之前留 .bak；
 *   4. 她自己的家（~/.dsh-roost）不能从这条路进去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PAIR_MAX_BYTES,
  findPairEntry,
  pairAppend,
  pairEntries,
  pairRead,
  pairReplace,
  registerPairFile,
} from '../lib/pairfile.js'
import { updateConfig } from '../lib/settings.js'

async function withDirs(fn) {
  // Windows 的 %TEMP% 可能是 8.3 短路径（RUNNER~1），realpath 会把它展开；
  // 不先展开的话，下面「realpath 与配置路径相同」的防链接检查会把正常路径误判成链接。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-roost-pair-root-')))
  const work = await realpath(await mkdtemp(join(tmpdir(), 'dsh-roost-pair-work-')))
  try {
    await fn(root, work)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function seed(work) {
  const a = join(work, '功能清单.md')
  const b = join(work, '需求与验收.md')
  await writeFile(a, '# 功能清单\n\n- 会眨眼\n', 'utf8')
  await writeFile(b, '# 需求与验收\n', 'utf8')
  const cfg = { pair: { enabled: true, a, b } }
  return { a, b, cfg }
}

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (t) => { tools.push(t); return { dispose() {} } } },
    _tools: tools,
  }
}

test('pairEntries：按文件名起别名；关了也记得路径；同一个路径只留一份', () => {
  const a = join(tmpdir(), '功能清单.md')
  const b = join(tmpdir(), '需求与验收.md')
  const list = pairEntries({ pair: { enabled: true, a, b } })
  assert.deepEqual(list.map((e) => e.alias), ['功能清单', '需求与验收'])
  assert.deepEqual(list.map((e) => e.key), ['a', 'b'])
  assert.ok(list.every((e) => e.enabled === true))

  const off = pairEntries({ pair: { enabled: false, a } })
  assert.equal(off.length, 1)
  assert.equal(off[0].enabled, false)
  assert.equal(findPairEntry({ pair: { enabled: true, a, b } }, '需求与验收').key, 'b')
  assert.equal(findPairEntry({ pair: { enabled: true, a } }, '没有这个'), null)

  const dup = pairEntries({ pair: { enabled: true, a, b: a } })
  assert.equal(dup.length, 1)
})

test('读：返回正文、16 位 hash、字节数；没开 / 没这一份都说清楚', async () => {
  await withDirs(async (root, work) => {
    const { cfg } = await seed(work)
    const r = await pairRead(root, cfg, '功能清单')
    assert.equal(r.ok, true)
    assert.match(r.text, /会眨眼/)
    assert.equal(r.hash.length, 16)
    assert.ok(r.bytes > 0)

    const off = await pairRead(root, { pair: { ...cfg.pair, enabled: false } }, '功能清单')
    assert.equal(off.ok, false)
    assert.match(off.note, /还没打开/)

    const miss = await pairRead(root, cfg, '别的文件')
    assert.equal(miss.ok, false)
    assert.match(miss.note, /没有这一份/)
  })
})

test('改一段：没带 hash / hash 过期 / 命中多处都不写；正常改时留 .bak', async () => {
  await withDirs(async (root, work) => {
    const { a, cfg } = await seed(work)
    const read = await pairRead(root, cfg, '功能清单')

    const noHash = await pairReplace(root, cfg, { file: '功能清单', oldText: '会眨眼', newText: '会笑' })
    assert.equal(noHash.ok, false)
    assert.match(noHash.note, /先读一遍/)

    const stale = await pairReplace(root, cfg, { file: '功能清单', oldText: '会眨眼', newText: '会笑', baseHash: '0'.repeat(16) })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'stale')
    assert.equal(await readFile(a, 'utf8'), '# 功能清单\n\n- 会眨眼\n')

    const multi = await pairReplace(root, cfg, {
      file: '功能清单',
      oldText: '\n',
      newText: ' ',
      baseHash: read.hash,
    })
    assert.equal(multi.ok, false)
    assert.match(multi.note, /[0-9]+ 处/)

    const ok = await pairReplace(root, cfg, {
      file: '功能清单',
      oldText: '会眨眼',
      newText: '会笑',
      baseHash: read.hash,
    })
    assert.equal(ok.ok, true)
    assert.match(await readFile(a, 'utf8'), /会笑/)
    assert.equal(await readFile(a + '.bak', 'utf8'), '# 功能清单\n\n- 会眨眼\n')

    // 旧 hash 已经过期：同一份旧 hash 不能再改一次。
    const again = await pairReplace(root, cfg, {
      file: '功能清单',
      oldText: '会笑',
      newText: '会哭',
      baseHash: read.hash,
    })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'stale')
  })
})

test('末尾添一句：自动补换行，也要 hash；写坏了不假装成功', async () => {
  await withDirs(async (root, work) => {
    const { b, cfg } = await seed(work)
    const read = await pairRead(root, cfg, '需求与验收')

    const noHash = await pairAppend(root, cfg, { file: '需求与验收', text: '再加一条' })
    assert.equal(noHash.ok, false)

    const ok = await pairAppend(root, cfg, { file: '需求与验收', text: '再加一条', baseHash: read.hash })
    assert.equal(ok.ok, true)
    const text = await readFile(b, 'utf8')
    assert.match(text, /# 需求与验收\n再加一条\n$/)
    assert.ok(await stat(b + '.bak'))
  })
})

test('她自己的家不许从这条路进去；目录也不当文件', async () => {
  await withDirs(async (root, work) => {
    await mkdir(join(root, 'home'), { recursive: true })
    const self = join(root, 'home', '她的身份.md')
    await writeFile(self, '你是……', 'utf8')
    const cfg = { pair: { enabled: true, a: self, b: join(work, '需求与验收.md') } }
    const r = await pairRead(root, cfg, '她的身份')
    assert.equal(r.ok, false)
    assert.match(r.note, /不能碰/)

    const dirCfg = { pair: { enabled: true, a: work } }
    const dirAlias = pairEntries(dirCfg)[0].alias
    const dir = await pairRead(root, dirCfg, dirAlias)
    assert.equal(dir.ok, false)
    assert.match(dir.note, /不是一份文件/)
  })
})

test('太大的文件不读；二进制不读', async () => {
  await withDirs(async (root, work) => {
    const big = join(work, '大文件.md')
    await writeFile(big, 'x'.repeat(PAIR_MAX_BYTES + 1), 'utf8')
    const bigCfg = { pair: { enabled: true, a: big } }
    const r = await pairRead(root, bigCfg, '大文件')
    assert.equal(r.ok, false)
    assert.match(r.note, /超过/)

    const bin = join(work, '二进制.md')
    await writeFile(bin, Buffer.from([0x61, 0x00, 0x62]))
    const binCfg = { pair: { enabled: true, a: bin } }
    const rb = await pairRead(root, binCfg, '二进制')
    assert.equal(rb.ok, false)
    assert.match(rb.note, /不像文本/)
  })
})

test('registerPairFile：注册的是 pair_file，read 的 render 带 hash', async () => {
  await withDirs(async (root, work) => {
    const { a, b } = await seed(work)
    await updateConfig({ pair: { enabled: true, a, b } }, root)

    const ctx = fakeCtx()
    registerPairFile(ctx, { root, cfg: { pair: { enabled: true, a, b } } })
    const spec = ctx._tools[0]
    assert.equal(spec.name, 'pair_file')
    assert.match(spec.description, /手边是：功能清单 \/ 需求与验收/)
    assert.equal(spec.parameters.type, 'object')
    assert.ok(spec.parameters.properties.file.required !== true)
    assert.deepEqual(spec.parameters.required, ['file', 'action'])
    assert.ok(spec.parameters.properties.action.enum.includes('read'))
    assert.equal(typeof spec.output.render, 'function')

    const read = await spec.execute({ file: '功能清单', action: 'read' })
    assert.equal(read.ok, true)
    const blocks = spec.output.render({ action: 'read' }, read)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /功能清单 · [0-9a-f]{16}/)
    assert.match(blocks[0].text, /会眨眼/)

    const changed = await spec.execute({
      file: '功能清单',
      action: 'replace',
      oldText: '会眨眼',
      newText: '会笑',
      baseHash: read.hash,
    })
    assert.equal(changed.ok, true)
    assert.match(spec.output.render({ action: 'replace' }, changed)[0].text, /改好了：功能清单/)
  })
})
