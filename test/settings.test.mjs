import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, DEFAULTS, inWindow, dateKey, pickWakeTime, updateConfig, loadConfig } from '../lib/settings.js'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('空配置得到完整默认值（含用户新加的 three 配额项）', () => {
  const c = normalizeConfig({})
  assert.equal(c.stageSpanDays, 30)
  assert.equal(c.daily.events, 4, '2026-11-02 默认 2→4（配合 wakesPerDay 2，有效 2 次/天）')
  assert.equal(c.daily.questions, 1)
  // daily.proactive 已并入 wakesPerDay（两个旋钮管同一件事，必有一个是死键）
  assert.equal(c.daily.proactive, undefined, 'proactive 不应再存在')
  assert.equal(c.wakesPerDay, 2, '唤醒次数唯一旋钮')
  assert.equal(c.diary.enabled, true)
  assert.equal(c.diary.visible, false, '日记默认不给看')
  assert.ok(Array.isArray(c.avoid.keywords) && c.avoid.keywords.includes('恐怖'))
})

test('部分配置自动补全其余键（可扩展性的核心）', () => {
  const c = normalizeConfig({ stageSpanDays: 60, diary: { visible: true } })
  assert.equal(c.stageSpanDays, 60)
  assert.equal(c.diary.visible, true)
  assert.equal(c.diary.enabled, true, '没传的键必须从默认值补回')
  assert.deepEqual(c.window, DEFAULTS.window)
})

test('老配置里的 growthDays 迁到 stageSpanDays（A28 改名，不改数值）', () => {
  const old = normalizeConfig({ growthDays: 45 })
  assert.equal(old.stageSpanDays, 45, '旧键的值要接过来')
  assert.equal(old.growthDays, undefined, '旧键不能再留在配置里')

  const both = normalizeConfig({ growthDays: 7, stageSpanDays: 60 })
  assert.equal(both.stageSpanDays, 60, '新旧都在时以新键为准')
  assert.equal(both.growthDays, undefined)
})

test('未知键不会被丢弃（向前兼容：以后加的配置项老版本也不炸）', () => {
  const c = normalizeConfig({ somethingNew: { a: 1 } })
  assert.deepEqual(c.somethingNew, { a: 1 })
})

test('越界值被夹到合法区间', () => {
  const c = normalizeConfig({ stageSpanDays: 9999, wakesPerDay: -5, daily: { events: 99 } })
  assert.equal(c.stageSpanDays, 180)
  assert.equal(c.wakesPerDay, 0)
  assert.equal(c.daily.events, 6)
})

test('非法时间窗回落到默认，不抛错', () => {
  assert.deepEqual(normalizeConfig({ window: ['25:00', 'abc'] }).window, DEFAULTS.window)
  assert.deepEqual(normalizeConfig({ window: ['09:00', '09:00'] }).window, DEFAULTS.window)
  assert.deepEqual(normalizeConfig({ window: ['09:00', '12:30'] }).window, ['09:00', '12:30'])
})

test('黑名单可追加、去重、去空', () => {
  const c = normalizeConfig({ avoid: { keywords: ['恐怖', '恐怖', ' ', '新的禁忌'] } })
  assert.deepEqual(c.avoid.keywords, ['恐怖', '新的禁忌'])
})

test('inWindow 普通与跨零点都正确', () => {
  const at = (h, m) => new Date(2026, 9, 22, h, m)
  const day = normalizeConfig({ window: ['20:00', '23:00'] })
  assert.equal(inWindow(day, at(19, 59)), false)
  assert.equal(inWindow(day, at(20, 0)), true)
  assert.equal(inWindow(day, at(23, 0)), true)
  assert.equal(inWindow(day, at(23, 1)), false)

  const night = normalizeConfig({ window: ['22:00', '02:00'] })
  assert.equal(inWindow(night, at(23, 30)), true)
  assert.equal(inWindow(night, at(1, 30)), true)
  assert.equal(inWindow(night, at(12, 0)), false)
})

test('pickWakeTime 落在窗内', () => {
  const cfg = normalizeConfig({ window: ['20:00', '23:00'] })
  for (const s of [0, 0.25, 0.5, 0.999]) {
    const t = pickWakeTime(cfg, s)
    assert.ok(t >= 20 * 60 && t <= 23 * 60, `${t}`)
  }
})

test('dateKey 用本地时区', () => {
  assert.equal(dateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('updateConfig 是合并而不是覆盖，且落盘后能被 loadConfig 读回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cfg-'))
  try {
    await updateConfig({ stageSpanDays: 45 }, root)
    await updateConfig({ diary: { visible: true } }, root)
    const { config } = await loadConfig(root)
    assert.equal(config.stageSpanDays, 45, '第二次更新不该把第一次的改动冲掉')
    assert.equal(config.diary.visible, true)
    assert.equal(config.daily.events, 4, '默认值仍然在（4 条）')
    const onDisk = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    assert.equal(onDisk.stageSpanDays, 45)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('落盘时把旧键清掉，只留 stageSpanDays（A28 迁移）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cfg-migrate-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'config.json'), JSON.stringify({ growthDays: 45 }), 'utf8')
    await updateConfig({ diary: { visible: true } }, root)
    const onDisk = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    assert.equal(onDisk.stageSpanDays, 45)
    assert.equal(onDisk.growthDays, undefined)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('配置文件不存在时返回默认值，且不主动写盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cfg2-'))
  try {
    const r = await loadConfig(root)
    assert.equal(r.fresh, true)
    await assert.rejects(readFile(join(root, 'config.json'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('白名单解析：半角/全角逗号、空格、换行都算分隔，去重保序', async () => {
  const { parseToolNames } = await import('../lib/settings.js')
  assert.deepEqual(parseToolNames('skill, web_search，read_image\nskill'), ['skill', 'web_search', 'read_image'])
  assert.deepEqual(parseToolNames(''), [])
  assert.deepEqual(parseToolNames(null), [])
  assert.deepEqual(parseToolNames(['web_search', ' web_search ']), ['web_search'])
})

test('白名单校验：拼错的名字与不存在的工具都不许过，拿不到名单时不做存在性判断', async () => {
  const { validateToolNames } = await import('../lib/settings.js')
  const known = ['web_search', 'read_image', 'skill']

  const ok = validateToolNames('skill, read_image', known)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.names, ['skill', 'read_image'])
  assert.equal(ok.checked, true)

  // 拼错一个字母：形状合法但名单里没有 —— 这正是会让她退回全量工具面的那种
  const typo = validateToolNames('web_serch', known)
  assert.equal(typo.ok, false)
  assert.deepEqual(typo.unknown, ['web_serch'])

  // 大写/空格/中文：连形状都不对
  const shape = validateToolNames('Web_Search', null)
  assert.equal(shape.ok, false)
  assert.deepEqual(shape.unknown, ['Web_Search'])

  // known 为 null：只做形状校验，checked:false（不把「不知道」当「不存在」）
  const blind = validateToolNames('some_future_tool', null)
  assert.equal(blind.ok, true)
  assert.equal(blind.checked, false)

  // 空输入永远合法（留空 = 不额外给）
  assert.equal(validateToolNames('', known).ok, true)
})

// 2026-11-07（A29）：主人 id 不再有默认值；老配置里的旧键仍保留，供 owner.json 迁移回落。
test('渠道默认值里没有 ownerId；老配置的旧键不被抹掉（A29）', () => {
  const fresh = normalizeConfig({})
  assert.equal(Object.prototype.hasOwnProperty.call(fresh.channels.qq, 'ownerId'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(fresh.channels.douyin, 'ownerId'), false)
  const old = normalizeConfig({ channels: { qq: { ownerId: '10001' }, douyin: { ownerId: '20002' } } })
  assert.equal(old.channels.qq.ownerId, '10001')
  assert.equal(old.channels.douyin.ownerId, '20002')
})


// 2026-11-07（A8）：看画面的四件事（几张、每张几格、细节档、清晰度）都进配置。
test('看画面的设置：默认一张、正常档、720P；乱写会被夹回来（A8）', () => {
  const d = normalizeConfig({})
  assert.equal(d.video.boards, 1)
  assert.equal(d.video.detail, 'normal')
  assert.equal(d.video.quality, 64)
  const odd = normalizeConfig({ video: { boards: 99, detail: 'ultra', quality: 999 } })
  assert.equal(odd.video.boards, 3)
  assert.equal(odd.video.detail, 'normal')
  assert.equal(odd.video.quality, 80)
  const low = normalizeConfig({ video: { boards: 0, detail: 'compact', quality: 1 } })
  assert.equal(low.video.boards, 1)
  assert.equal(low.video.detail, 'compact')
  assert.equal(low.video.quality, 16)
})


test('B 站与抖音共用一个 0–6 的每日上限（B15）', () => {
  const c = normalizeConfig({ browse: { perDay: 9, douyin: { perDay: 8 } } })
  assert.equal(c.browse.perDay, 6, '总数最多 6')
  assert.equal(c.browse.douyin.perDay, 6, '旧配置里那个也夹到 6')
  const z = normalizeConfig({ browse: { perDay: -3, douyin: { perDay: -1 } } })
  assert.equal(z.browse.perDay, 0)
  assert.equal(z.browse.douyin.perDay, 0)
})

test('桌宠入口参数：大小夹住、位置只认白名单、穿透默认开（m09850）', () => {
  const d = normalizeConfig({})
  assert.equal(d.pet.size, 1.0)
  assert.equal(d.pet.position, '')
  assert.equal(d.pet.clickThrough, true)
  assert.equal(d.pet.idleSleepMin, 5)
  assert.equal(d.pet.pokeMinGapMs, 60_000)

  const c = normalizeConfig({ pet: { enabled: true, path: ' D:/pet.exe ', repo: ' D:/body ', size: 9, position: '../x', clickThrough: false, pack: 'cat-2', idleSleepMin: 99, pokeMinGapMs: 120_000 } })
  assert.equal(c.pet.enabled, true)
  assert.equal(c.pet.path, 'D:/pet.exe')
  assert.equal(c.pet.repo, 'D:/body')
  assert.equal(c.pet.size, 2)
  assert.equal(c.pet.position, '')
  assert.equal(c.pet.clickThrough, false)
  assert.equal(c.pet.pack, 'cat-2')
  assert.equal(c.pet.petId, undefined)
  assert.equal(c.pet.idleSleepMin, 60)
  assert.equal(c.pet.pokeMinGapMs, 120_000)

  assert.equal(normalizeConfig({ pet: { size: 0.1 } }).pet.size, 0.5)
  assert.equal(normalizeConfig({ pet: { size: 'abc' } }).pet.size, 1.0)
  assert.equal(normalizeConfig({ pet: { position: 'top-left' } }).pet.position, 'top-left')
  assert.equal(normalizeConfig({}).pet.pack, 'default')
  assert.equal(normalizeConfig({ pet: { pack: '../x' } }).pet.pack, 'default')
  // 老配置的 petId 要迁到 pack，不能把已经选好的角色丢回 default。
  assert.equal(normalizeConfig({ pet: { petId: 'legacy-1' } }).pet.pack, 'legacy-1')
  assert.equal(normalizeConfig({ pet: { petId: 'legacy-1', pack: 'cat-2' } }).pet.pack, 'cat-2')
  assert.equal(normalizeConfig({ pet: { idleSleepMin: 0 } }).pet.idleSleepMin, 1)
  assert.equal(normalizeConfig({ pet: { idleSleepMin: 'abc' } }).pet.idleSleepMin, 5)
  // 两次点击之间：默认 60 秒，夹在 5–600 秒。
  assert.equal(normalizeConfig({ pet: { pokeMinGapMs: 1 } }).pet.pokeMinGapMs, 5_000)
  assert.equal(normalizeConfig({ pet: { pokeMinGapMs: 999_999 } }).pet.pokeMinGapMs, 600_000)
  assert.equal(normalizeConfig({ pet: { pokeMinGapMs: 'abc' } }).pet.pokeMinGapMs, 60_000)
})
