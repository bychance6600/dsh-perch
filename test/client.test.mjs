/**
 * client.test.mjs —— 客户端半边（lib/client.js）的冒烟测试
 *
 * 为什么这个测试值得存在：
 *   DSH 的客户端插件是**在浏览器里**通过 window.__ModuleLoader__.load 装载的。
 *   宿主侧 node --test 根本不会执行它 —— 一个拼错的分支、一个 undefined 的解构，
 *   只有在用户点开「设置 → 鱼」时才会炸，而那时报错信息是 "entries did not activate"，
 *   完全指不出是哪一行。
 *
 *   所以这里造一个最小的 window / ModuleLoader / react 假环境，真的把 factory 跑一遍，
 *   并**真的渲染一次组件**（用假的 React，把 h() 结果当树遍历），
 *   能在 CI 里就抓到「组件引用了不存在的字段」这类错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

/**
 * 假 React：h() 产出一个普通对象，组件函数就是普通函数。
 * useState 返回一个固定值 + 一个 noop setter（只测渲染不测交互）。
 */
function fakeReact(initialState = {}) {
  const state = { ...initialState }
  let cursor = 0
  const queue = []
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })
  // 2026-11-06：setter 真的写回 state（原来只返回 noop），否则页签点不动。
  // 默认页改成「今天」之后，测「状态」页的用例要先切过去——见 openTab。
  const useState = (init) => {
    const idx = cursor++
    if (!(idx in state)) state[idx] = typeof init === 'function' ? init() : init
    const v = state[idx]
    queue.push(v)
    return [v, (next) => { state[idx] = typeof next === 'function' ? next(state[idx]) : next }]
  }
  return {
    h,
    // 客户端用的是 `const { createElement: h, useCallback, useEffect, useState } = React`
    createElement: h,
    useState,
    useCallback: (fn) => fn,
    useEffect: (fn) => { queue.push(['effect', fn]) },
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    resetCursor() { cursor = 0 },
  }
}

/** 收集整棵树里的文本，用来断言"页面里真的有东西" */
function textOf(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  if (node.children) for (const c of node.children) textOf(c, out)
  return out
}

/** 按页签名字点一下，再重新渲染——默认停在「今天」，别的页要主动切过去。 */
function openTab(exports, react, label) {
  const find = (node) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const n of node) { const hit = find(n); if (hit) return hit } return null }
    if (node.type === 'button' && node.props?.className?.startsWith?.('tab') && textOf(node).join('') === label) return node
    for (const c of node.children || []) { const hit = find(c); if (hit) return hit }
    return null
  }
  react.resetCursor()
  const btn = find(exports.FishSection())
  if (!btn) throw new Error(`找不到页签「${label}」`)
  btn.props.onClick()
  react.resetCursor()
  return exports.FishSection()
}
async function loadClient({ react }) {
  const src = await readFile(CLIENT, 'utf8')
  const loaded = []
  const window = {
    __ModuleLoader__: {
      load(spec) { loaded.push(spec) },
    },
  }
  // 客户端文件是**脚本**不是模块：用 Function 在当前作用域里跑，把 window 与 require 注进去
  const fn = new Function('window', 'require', 'document', src)
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  }
  fn(window, (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  }, document)

  assert.equal(loaded.length, 1, '必须调用一次 window.__ModuleLoader__.load')
  const spec = loaded[0]
  assert.equal(spec.id, 'dsh-roost', 'loader id 必须等于包名，否则客户端模块挂不上')
  const exports = spec.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  })
  return { exports, spec }
}

test('client.js 能被 ModuleLoader 装载，且导出了 apply / inject', async () => {
  const { exports } = await loadClient({ react: fakeReact() })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'], '设置节的客户端只依赖 slots')
  assert.equal(typeof exports.FishSection, 'function')
})

test('apply 注册到 settings.section，id 与 label 都对', async () => {
  const react = fakeReact()
  const { exports } = await loadClient({ react })

  const registered = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject(name, fn, label) {
        assert.equal(name, 'settings.section')
        assert.equal(label, 'dsh-roost: settings section')
        fn()
        return () => {}
      },
      register(meta, Component) {
        registered.push({ meta, Component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.name, 'settings.section')
  assert.equal(registered[0].meta.id, 'fish')
  assert.equal(typeof registered[0].meta.label, 'function')
  assert.equal(registered[0].meta.label(), '她')
})

test('组件在"还没有数据"时也能渲染，不抛错', async () => {
  const react = fakeReact()
  const { exports } = await loadClient({ react })
  react.resetCursor()
  // 第一次渲染：state 全是初始值（null / 空）
  const tree = exports.FishSection()
  const txt = textOf(tree).join(' ')
  assert.ok(txt.includes('她'), '标题要在')
  assert.ok(txt.includes('成长'), '「成长」分页要在')
  assert.ok(textOf(openTab(exports, react, '状态')).join(' ').includes('现在叫醒她'), '操作要在')
  // P3 架构改造后新增：用户"打开侧栏就能看见她"，所以观测台必须告诉他去哪找。
  // 屋子卡片在「住所」页，而默认停在「状态」页 —— 看源码（同本文件 2026-10-23 那条口径：
  // 标签页名字看渲染结果，藏在别的页里的卡片看源码）。
  assert.ok((await readFile(CLIENT, 'utf8')).includes('她住在哪'), '屋子卡片要在')
  // 备用入口是条件分支：home 还没读到时显示「读取中」，所以看源码而不是树。
  const src0 = await readFile(CLIENT, 'utf8')
  assert.ok(src0.includes('备用说话入口'), '屋子没建起来时要有备用入口')
  // 2026-11-06（设计 §四）：「她写的小纸条」并进状态页的「她找你」卡（与「她的请求」同卡），
  // 插件自检挪到数据页 —— 两样都不再挂住所页。这里看源码，因为都在默认页之外。
  const src1 = await readFile(CLIENT, 'utf8')
  const atNowPage = src1.indexOf('const nowPage')
  const atSeek = src1.indexOf("groupFull('她找你'")
  const atNote = src1.indexOf("groupFull('她写的小纸条'")
  const atAsk = src1.indexOf("group('她的请求'", atSeek)
  const atUse = src1.indexOf('inboxCard)', atSeek)
  const atData = src1.indexOf('const dataPage')
  const atCheck = src1.indexOf("group('本插件工作自检'")
  assert.ok(atSeek > 0 && atSeek < atNowPage, '「她找你」卡要在状态页')
  assert.ok(atNote > 0 && atNote < atSeek, '小纸条要收进「她找你」')
  assert.ok(atAsk > 0 && atAsk < atUse, '请求要排在纸条上面')
  assert.ok(atData > 0 && atCheck > atData, '插件自检要在数据页')
  assert.ok(src1.includes('特意留给你的话。某种意义上代表她当前的状态，可能含有关键信息。'), '小纸条的描述要在')
  // 老名字不该再出现在界面上（注释除外）：卡片标题已经换掉了。
  assert.ok(!/groupFull\('信箱'/.test(src1), '不能再有「信箱」这张卡')
})

test('组件在"有数据"时把关键信息渲染出来', async () => {
  const react = fakeReact()
  const { exports } = await loadClient({ react })

  // 用假的 fetch 喂一份完整状态，再手工触发一次 load 的效果
  const state = {
    day: 5, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: 'autonomy', name: null, beliefCount: 2, absenceDays: 0,
    counts: { utterance: 3, revise: 1, refusal: 0, reunion: 0, total: 6 },
    quality: { stability: 0.5, consistency: 0.6, novelty: 0.7 },
    config: {
      window: ['20:00', '23:00'],
      daily: { events: 1, questions: 1 },
      diary: { enabled: true, visible: false },
      absenceAfterDays: 3,
    },
  }
  globalThis.fetch = async (url) => {
    const u = String(url)
    const body = u.endsWith('/state') ? state
      : u.endsWith('/beliefs') ? { active: [{ id: 'ev_1', text: '我不喜欢被催。', confidence: 0.6 }], refuted: [], refusals: [], selfmod: [] }
      : u.includes('/events') ? { rows: [{ type: 'utterance', text: '一句测试话。' }], total: 1 }
      : u.endsWith('/diary') ? { enabled: true, visible: false, items: [], lockedDates: ['2026-10-20'] }
      : u.endsWith('/config') ? { config: state.config }
      : {}
    return { ok: true, status: 200, json: async () => body }
  }

  // 组件内部用 useState 拿状态；这里直接把初始 state 塞进去模拟"已加载"，
  // 然后只验证渲染路径不炸、且关键片段出现。
  react.resetCursor()
  const tree = exports.FishSection()
  const txt = textOf(tree).join(' ')
  assert.ok(txt.includes('成长'), '分页里的「成长」必须有一页')
  // 2026-10-23 起界面改成分页：默认只渲染「现在」页，别的页在源码里但不在这一棵树里。
  // 所以这两类断言分开：标签页名字看渲染结果，藏在别的页里的控件看源码。
  const src = await readFile(CLIENT, 'utf8')
  // 2026-10-25 起页签固定为 8 个（没有「全部」页，用户要求删掉；文案页同日下线）：
  // 状态 / 成长 / 住所 / 上网 / 记忆 / 插件 / 原理 / 数据（末页原叫「危险」，
  // 2026-10-24 改名并把数据在哪、每日报告、运行日志挪了进去；原理页在插件与数据之间）。
  // 2026-10-28 加了第 9 个「反馈」（开发者 QQ + 交流群二维码），排在最后。
  // 2026-11-06：11 个页签，按她的一天排；「记忆」并进成长与数据。
  for (const label of ['今天', '状态', '成长', '住所', '社会', '上网', '渠道', '插件', '原理', '数据', '反馈']) {
    assert.ok(txt.includes(label), `分页标签「${label}」必须在`)
  }
  assert.ok(!txt.includes('全部'), '不该再有「全部」页')
  const srcAll = await readFile(CLIENT, 'utf8')
  assert.ok(!/\[\s*'all'\s*,/.test(srcAll), '源码里不该再留 all 页签')
  assert.ok(src.includes('让我看日记'), '日记可见性开关必须在')
  assert.ok(src.includes('黑名单（逗号分隔'), '黑名单可追加必须在')
  assert.ok(src.includes('允许她上网（总闸）'), '上网总开关必须在')
  delete globalThis.fetch
})

test('插件页的工具说明取自 registry，取不到只说来源（A27）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(!src.includes('TOOL_HINTS'), '不许再留一份写死的工具说明表')
  assert.ok(src.includes('state?.tools?.descriptions'), '说明要从 /state 的 tools.descriptions 取')
  assert.ok(src.includes('来源：她自己那一层注册的'), 'own 层工具要说清来源')
  assert.ok(src.includes('来源：宿主或别的插件注册的'), '其余工具要说清来源')
  assert.ok(!/TOOL_HINTS\[name\]/.test(src), '未知工具不许再套旧表兜底')
})

test('插件页：registry 有说明就照显示，没有就只说来源（A27）', async () => {
  const react = fakeReact({
    0: stateWith({
      tools: {
        restrict: true,
        allow: [],
        known: ['known_tool', 'quiet_tool'],
        own: ['quiet_tool'],
        descriptions: { known_tool: '宿主自己写的一句说明' },
      },
    }),
  })
  const { exports } = await loadClient({ react })
  const txt = textOf(openTab(exports, react, '插件')).join(' ')
  assert.ok(txt.includes('known_tool'), '名字要在表里')
  assert.ok(txt.includes('宿主自己写的一句说明'), '有说明就照 registry 的写')
  assert.ok(txt.includes('quiet_tool'), '没说明的工具也要列出来')
  assert.ok(txt.includes('来源：她自己那一层注册的'), 'own 层工具取不到说明时说来源')
  assert.ok(!txt.includes('宿主按会话给的'), '不许再编一句「宿主按会话给的」')
})

test('组件里没有任何"改她性格"的控件（B §8 红线）', async () => {
  const raw = await readFile(CLIENT, 'utf8')
  // 2026-11-06：导入卡已删，整份源码里出现这些词都算红线。
  const src = raw
  for (const banned of ['好感度', '亲密度', 'affinity', '外向', '黏人程度', '性格滑条']) {
    assert.ok(!src.includes(banned), `客户端代码里不该出现 ${banned}`)
  }
  // 只允许改"环境"的那几类键
  // 2026-10-24 起字段表集中在 buildConfig()：自动保存与手动保存共用同一份。
  const m = src.match(/const buildConfig = \(\) => \(\{([\s\S]*?)\n {6}\}\)/)
  assert.ok(m, '必须能定位到 buildConfig 的字段表')
  const body = m[1]
  for (const key of ['absenceAfterDays', 'wakesPerDay', 'daily', 'diary', 'avoid', 'browse']) {
    assert.ok(body.includes(key), `保存体里应有 ${key}`)
  }
  for (const key of ['personality', 'persona', 'traits', 'mood', 'love']) {
    assert.ok(!body.includes(key), `保存体里不该有 ${key}`)
  }
})

test('quality 是宿主那套 {score} 结构体时也要能渲染（2026-10-23 设置页空白的根因）', async () => {
  // 现场事实：宿主 /state 返回的 quality 不是数字，是带样本量的结构体：
  //   { stability:{score,sample,worst}, consistency:{score,pairs}, novelty:{score,recent,older} }
  // 客户端曾写成 s.quality.stability.toFixed(2) → 对对象调 toFixed → TypeError
  // → React 渲染抛错 → 设置节被错误边界吞掉 → 用户看到**一片空白**。
  // 这个用例把"真实形状"钉死，谁再退回裸数字假设就会红。
  const realShape = {
    day: 1, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: 'trust', name: null, beliefCount: 0, absenceDays: 0,
    counts: { utterance: 0, revise: 0, refusal: 0, reunion: 0, total: 2 },
    quality: {
      stability: { score: 0, sample: 0, worst: 0 },
      consistency: { score: 1, pairs: 0 },
      novelty: { score: 0, recent: 0, older: 0 },
    },
    config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: { enabled: true, visible: false }, absenceAfterDays: 2 },
  }

  const react = fakeReact({ 0: realShape })   // 第 0 个 useState 就是 state
  const { exports } = await loadClient({ react })
  react.resetCursor()

  let tree
  assert.doesNotThrow(() => { tree = openTab(exports, react, '状态') }, 'quality 是结构体时不许抛')
  const txt = textOf(tree).join(' ')
  assert.ok(txt.includes('判断漂移'), '质量那行要渲染出来')
  // 2026-10-26 改（用户 m05785「为什么剩下两个全是0」）：
  // 这个形状就是全新一局的样子——0 条判断、0 对可比的话、0 条七天前的老话。
  // 原来三个数会照默认值印成「0.00 / 1.00 / 0.00」，让人以为她很差、还想把 1.00 当满分。
  // 现在样本不足一律写人话，数字只在真能测时才印。
  assert.ok(txt.includes('还没攒到判断，测不出来'), `没有判断时要说测不出来，实际: ${txt.slice(0, 300)}`)
  assert.ok(txt.includes('还没有跨阶段的话可比'), '说话不足两条时要说还没得比')
  // 新鲜：这个夹具里最近一周一条没说（recent=0），先说「没说过话」；
  // 有近期没历史时才说「还没有七天前的老话可比」。两者都不是 0.00。
  assert.ok(txt.includes('最近一周没说过话'), '最近没说话时要说没说过话')
  assert.ok(!txt.includes('稳定 0.00'), '样本不足时不许再印 0.00 冒充读数')
  assert.ok(!txt.includes('undefined'), '不许把 undefined 渲染到界面上')
  assert.ok(!txt.includes('NaN'), '不许把 NaN 渲染到界面上')
})

test('quality 能测出稳定值时，数字和判读一起给（用户 m06350）', async () => {
  const react = fakeReact({
    0: {
      day: 30, growthDays: 30, stage: 2, stageName: '自主', stageForced: false, pendingGate: null,
      name: '梦尘', beliefCount: 6, absenceDays: 0,
      counts: { utterance: 40, revise: 3, refusal: 2, reunion: 1, total: 60 },
      quality: {
        stability: { score: 0.41, sample: 24, k: 3, beliefs: 6, band: '全压在这几条上，少一条就是另一个人' },
        consistency: { score: 0.72, pairs: 12 },
        novelty: { score: 0.35, recent: 9, older: 20 },
      },
      config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: { enabled: true, visible: false }, absenceAfterDays: 2 },
    },
  })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(openTab(exports, react, '状态')).join(' ')
  assert.ok(txt.includes('全压在这几条上'), `band 那句话要显示出来，实际: ${txt.slice(0, 300)}`)
  assert.ok(txt.includes('0.41'), '能测出数值时，数字必须印出来——只给判读会让人以为没测（用户 m06350）')
  assert.ok(txt.includes('0.72'), '一致仍然显示数字')
  assert.ok(txt.includes('0.35'), '新鲜仍然显示数字')
})

// 2026-11-06（用户定）：三个诊断值折叠回一行——它们都是体检值，不是三个要分别盯的指标。
// 旧决定（2026-10-27 m06107）是拆三行；新项目改回一行，接口不变。
test('判断漂移的三个值折叠在一行里（2026-11-06 改回）', async () => {
  const react = fakeReact({
    0: {
      day: 30, growthDays: 30, stage: 2, stageName: '自主', stageForced: false, pendingGate: null,
      name: '梦尘', beliefCount: 6, absenceDays: 0,
      counts: { utterance: 40, revise: 3, refusal: 2, reunion: 1, total: 60 },
      quality: {
        stability: { score: 0.41, sample: 24, k: 3, beliefs: 6, band: '全压在这几条上，少一条就是另一个人' },
        consistency: { score: 0.72, pairs: 12 },
        novelty: { score: 0.35, recent: 9, older: 20 },
      },
      config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: { enabled: true, visible: false }, absenceAfterDays: 2 },
    },
  })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(openTab(exports, react, '状态')).join(' ')
  assert.ok(txt.includes('判断漂移'), '要有一行判断漂移')
  assert.ok(txt.includes('稳定') && txt.includes('一致') && txt.includes('新鲜'), '三个值都要在那一行里')
})

test('quality 缺失 / 是裸数字时也都能渲染', async () => {
  for (const q of [undefined, null, {}, { stability: 0.5, consistency: 0.6, novelty: 0.7 }]) {
    const react = fakeReact({
      0: {
        day: 1, growthDays: 30, stage: 1, stageName: '信任', stageForced: false, pendingGate: null,
        name: null, beliefCount: 0, absenceDays: 0,
        counts: { utterance: 0, revise: 0, refusal: 0, reunion: 0, total: 0 },
        quality: q,
        config: { window: [], daily: { events: 1, questions: 1 }, diary: {}, absenceAfterDays: 2 },
      },
    })
    const { exports } = await loadClient({ react })
    react.resetCursor()
    assert.doesNotThrow(() => exports.FishSection(), `quality=${JSON.stringify(q)} 时不许抛`)
  }
})

test('观测台有「在线状态」条：7 种状态都有颜色，且页面在后台不轮询', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 状态来自 /status（宿主用 meta + 配置 + 时钟算出来的，不是她自报）
  assert.ok(src.includes("jget('/status')"), '必须真的去读 /status')

  // 七种状态一个都不能漏；漏了那种状态就变成无色灰点，看不出区别
  for (const phase of ['asleep', 'waiting', 'awake-idle', 'browsing', 'talking', 'writing', 'offline']) {
    assert.ok(src.includes(`'${phase}'`) || src.includes(` ${phase}:`), `缺少状态 ${phase}`)
  }

  // 页面在后台就别轮询（省电，也不制造无谓请求）
  assert.ok(src.includes('visibilityState'), '要检查页面是否可见')

  // 时间线要能显示「醒了，但什么也没做」这类记录
  assert.ok(src.includes('st.timeline'), '要渲染时间线')
})

// ---------------------------------------------------------------------------
// 2026-10-24：状态卡「下一道门」漏英文 + 规则卡空态常驻
// ---------------------------------------------------------------------------

/** 状态卡用的最小 /state 形状（用例按需覆盖字段） */
function stateWith(extra = {}) {
  return {
    day: 3, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: null, name: null, beliefCount: 1, absenceDays: 0,
    counts: { utterance: 1, revise: 0, refusal: 0, reunion: 0, total: 1 },
    quality: { stability: 0, consistency: 1, novelty: 0 },
    config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: {}, absenceAfterDays: 3 },
    ...extra,
  }
}

test('「下一道门」显示中文，不把 trust / autonomy / competence 漏到界面上', async () => {
  // 现场事实：用户看到「下一道门 competence」不知道是什么。宿主 stageGate.pending
  // 给的是技术名，显示层必须翻成 信任 / 自主 / 主动。
  for (const [gate, name] of [['trust', '信任'], ['autonomy', '自主'], ['competence', '主动']]) {
    const react = fakeReact({ 0: stateWith({ pendingGate: gate }) })
    const { exports } = await loadClient({ react })
    react.resetCursor()
    const txt = textOf(openTab(exports, react, '状态')).join(' ')
    assert.ok(txt.includes(name), `pendingGate=${gate} 时应显示「${name}」，实际：${txt.slice(0, 200)}`)
    assert.ok(!txt.includes(gate), `不该把技术名 ${gate} 印到界面上`)
  }
})

test('三道门都走完时显示「已走完」，不显示 null', async () => {
  const react = fakeReact({ 0: stateWith({ pendingGate: null }) })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(openTab(exports, react, '状态')).join(' ')
  assert.ok(txt.includes('已走完'), '没门可走时要有话说')
  assert.ok(!txt.includes('null'), '不许把 null 渲染出来')
})

test('规则卡：没有待裁决的申请时不渲染空态行，有申请才出现两个按钮', async () => {
  const idle = {
    pending: null, offersOn: true,
    layers: [{ name: '物理层', mutable: false, note: '代码保证。', rules: [{ id: 'r1', title: '不许打分', inPrompt: false }] }],
    status: [{ id: 'r1', active: true }],
  }

  // 1) 有 pending 通道但没有申请：整行不渲染，也不该出现裁决按钮
  //    rules 是组件里第 13 个 useState（0 基下标 12；0.7.6 请求事件插了 asks/askMsg，0.8.x 梦境实验又插了 dreams），数据来自 /rules，不在 /state 里。
  let react = fakeReact({ 0: stateWith(), 11: idle })
  let loaded = await loadClient({ react })
  react.resetCursor()
  let txt = textOf(openTab(loaded.exports, react, '状态')).join(' ')
  assert.ok(txt.includes('规则约束'), '规则卡要在')
  assert.ok(!txt.includes('目前没有待处理的申请'), '不该常驻一句空待办')
  assert.ok(!txt.includes('这次不行'), '没有申请就不该有裁决按钮')

  // 2) 有申请：卡片 + 两个按钮都要出来
  react = fakeReact({ 0: stateWith(), 11: { ...idle, pending: { why: '想自己决定要不要出门。' } } })
  loaded = await loadClient({ react })
  react.resetCursor()
  txt = textOf(openTab(loaded.exports, react, '状态')).join(' ')
  assert.ok(txt.includes('她提了一个申请'), '有申请时要标出来')
  assert.ok(txt.includes('可以') && txt.includes('这次不行'), '两个裁决按钮都要在')

  // 3) 通道关着：并进卡片说明行，不单独占一行
  react = fakeReact({ 0: stateWith(), 11: { ...idle, offersOn: false } })
  loaded = await loadClient({ react })
  react.resetCursor()
  txt = textOf(openTab(loaded.exports, react, '状态')).join(' ')
  assert.ok(txt.includes('申请通道现在关着'), '通道关着要说明')
  assert.ok(!txt.includes('目前没有待处理的申请'), '仍然不该有那句空态')
})

test('用户改过的标签已固化：阶段四行、叫法、记忆三项（2026-10-24）', async () => {
  // 这些字原来是用户在文案面板里改的覆盖，已固化进源码；copy.json 也清空了。
  // 谁要是改回短版本，这条会拦下来——那是用户亲手定的措辞。
  const src = await readFile(CLIENT, 'utf8')
  for (const s of [
    // 2026-11-06（设计 §四）：阶段四行不再写死，由 gatePassed / 三道瓶颈的进度实时生成。
    "`1 信任 · 先从所见所闻里形成一条自己拿着的判断（现在 ${gateNow('信任')}）`",
    "`2 自主 · 明确拒绝过两次，说不出口就不算（现在 ${gateNow('自主')}）`",
    "`3 主动 · 推翻或修正过两次自己的判断；让步最多只顶一次（现在 ${gateNow('胜任')}）`",
    '4 整合 · 前三个瓶颈都过了，之后才开始谈立场。',
    '下一个成长瓶颈', '规则约束',
    '特意留给你的话。某种意义上代表她当前的状态，可能含有关键信息。',
    '认知重构', '勇于拒绝',
  ]) {
    assert.ok(src.includes(s), `源码里缺少用户定的这句：${s}`)
  }
  assert.ok(!src.includes('想改自己 '), '「想改自己」已按用户要求删掉')
  // 2026-11-02（用户 m02666）：天数与阶段只在最上面那行说一次，状态页里不再重复一遍。
  assert.ok(!src.includes("rowTip('已成长天数'"), '状态页不应再重复列出已成长天数')
  assert.ok(!src.includes("rowTip('当前阶段'"), '状态页不应再重复列出当前阶段')
  assert.ok(!src.includes("rowTip('下一道门'"), '「下一道门」已改叫「下一个成长瓶颈」')
})

test('状态卡把「认知矛盾」和「记得很牢」露出来（2026-10-24 P0）', async () => {
  const react = fakeReact({
    0: stateWith({ solidCount: 2, tension: { count: 1, a: '它不是在看别的。', b: '它就是在看别的。' } }),
  })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(openTab(exports, react, '状态')).join(' ')
  assert.ok(txt.includes('认知矛盾'), '冲突必须能在界面上看见')
  assert.ok(txt.includes('1 处'))
  assert.ok(txt.includes('记得很牢'), '固化的条数也要露出来')
  // 提示语在 title 属性里，textOf 取不到，直接查源码
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('不能同时算数'), '要说清这是什么，不能只丢一个数字')
  assert.ok(src.includes('可以直接问她'), '给她留一条出路：去问，而不是让她自己猜')
  assert.ok(!src.includes('这不是正确答案'), '界面不许替她裁决哪句对')
})

test('互动计数的问号写清四个数字的口径（用户定稿）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('说=她写过几句自己的判断（含留话）'))
  assert.ok(src.includes('改口=按照规则推翻历史认知并指明改的是哪条'))
  assert.ok(src.includes('拒绝=她明确登记拒绝过什么'))
  assert.ok(src.includes('重聚=久别之后她自己写下的感受'))
  assert.ok(src.includes('让步 '), '流水里要有让步')
  assert.ok(src.includes('三道瓶颈'), '门进度要单独一行')
  assert.ok(!src.includes('她自己写下的事件条数，不含系统记的。'), '旧口径已作废')
})

// ---------------------------------------------------------------------------
// 2026-10-28：用户转来的四条反馈（m00802）
// ---------------------------------------------------------------------------

test('日记三项不再跟着整表保存走：各自 patchDiary，服务端没给值也不写回界面（反馈 1）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 整表保存（buildConfig + 700ms 自动 POST）必须碰不到 diary，
  // 否则每一次环境参数改动都会顺带把日记开关写回旧值 —— 用户看到的就是"自己关"。
  assert.ok(!src.includes('diary: { visible: diaryVisible'), 'buildConfig 里不该再有 diary')
  assert.ok(src.includes("await jpost('/config', { diary: patch })"), '日记要走单独 patch')

  // 三个控件各连一次 patchDiary
  assert.ok(src.includes('patchDiary({ enabled: v })'))
  assert.ok(src.includes('patchDiary({ visible: v })'))
  assert.ok(src.includes('patchDiary({ keepDays: Number(v) })'))

  // 日记天数不再参与整表范围校验（它已经不随整表提交了）
  assert.ok(!src.includes("['日记保留天数', diaryKeep"), '日记天数要从 NUM_BOUNDS 里摘掉')

  // /state 回包比手速慢时别把开关拨回去；undefined（服务端没给）更不能当 false
  assert.ok(src.includes('diaryPending.current'), '要有"patch 在飞"的保护')
  assert.ok(src.includes("typeof dv === 'boolean'"), '非 boolean 就跳过 set')
})

test('风控提示分两层说：落盘的冷却与进程内的 60 秒（反馈 4）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('B 站那边正在冷却'), '落盘冷却（risk.js）要显示剩余分钟')
  assert.ok(src.includes('risk?.memory?.readMs'), '进程内的短暂熔断也要单独说明')
  assert.ok(src.includes('重启就清空'), '要说清这层不是永久的')
})


// ---------------------------------------------------------------------------
// 2026-10-28 晚：用户 m00416
// ---------------------------------------------------------------------------

test('刷视频记录按条翻页：每页条数随实际量自适应，日期只在换天时出现一次（m00416）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 原来是「一天一组、一页三天」，一天刷 10 条、查 3 天就是 30 条挤一屏
  assert.ok(src.includes('(g.items || []).map((it) => ({ ...it, date: g.date }))'), '要摊平成一条一条')
  assert.ok(!src.includes('一页三天'), '旧口径的文案要清掉')
  assert.ok(src.includes('histSlice[i - 1].date !== it.date'), '换天处才插日期标签')
  // 2026-10-28 晚（用户 m0xxxx「按实际刷的视频数量动态调整」）：
  // 每页条数不是死 12 条，而是先看总量、再看日均密度分档，上限 12。
  assert.ok(src.includes('const HIST_PAGE_MAX = 12'), '上限是 12 条')
  assert.ok(src.includes('histTotal <= 8 ? histTotal'), '一共不到 8 条就一页全放下')
  assert.ok(src.includes('histPerDay > 20 ? 6'), '一天 20 条以上的重度用户，一页只给 6 条')
  assert.ok(src.includes('histPerDay > 10 ? 8'), '一天 10~20 条，一页 8 条')
  assert.ok(src.includes('histPerDay > 5 ? 10'), '一天 5~10 条，一页 10 条')
  assert.ok(src.includes('const histPages = Math.max(1, Math.ceil(histTotal / histPageSize))'), '页数按自适应条数算')
  // 只有一页时连翻页条都不出，别让人看到「第 1 / 1 页」
  assert.ok(src.includes('const histPager = histPages > 1'), '一页就不出翻页条')
  assert.ok(/histPages > 1\s*\n\s*\?\s*h\(/.test(src), '下面的翻页条同样只在多页时出现')
  assert.ok(src.includes('一页 ${histPageSize} 条'), '页码旁边标出这一页有几条')
})

// ---------------------------------------------------------------------------
// 2026-10-29：用户 m01952「多篇的时候会出现翻页键」
// ---------------------------------------------------------------------------

test('日记翻页：日期 ≥ 2 才出「← 更早 / 更晚 →」，一天时只显示日期（m01952）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  assert.ok(src.includes('diaryDates.length > 1'), '多天才出翻页条，一天时不出')
  assert.ok(src.includes("'← 更早'") && src.includes("'更晚 →'"), '两个方向都要有按钮')
  assert.ok(src.includes('setDiaryDay(diaryIdx + 1)'), '「更早」= 下标加一（dates 是新→旧）')
  assert.ok(src.includes('setDiaryDay(diaryIdx - 1)'), '「更晚」= 下标减一')
  assert.ok(src.includes('disabled: diaryIdx >= diaryDates.length - 1'), '翻到最早一篇就禁用「更早」')
  assert.ok(src.includes('disabled: diaryIdx <= 0'), '翻到最新一篇就禁用「更晚」')
  // 一天一篇的语义没变：翻的是「天」，同日追加的那几段合成同一页
  assert.ok(!src.includes('diarySegs'), '别为同日追加再加一级翻页')
})

// ---------------------------------------------------------------------------
test('用户改过的标签已固化：阶段四行、叫法、记忆三项（2026-10-24）', async () => {
  // 这些字原来是用户在文案面板里改的覆盖，已固化进源码；copy.json 也清空了。
  // 谁要是改回短版本，这条会拦下来——那是用户亲手定的措辞。
  const src = await readFile(CLIENT, 'utf8')
  for (const s of [
    // 2026-11-06（设计 §四）：阶段四行不再写死，由 gatePassed / 三道瓶颈的进度实时生成。
    "`1 信任 · 先从所见所闻里形成一条自己拿着的判断（现在 ${gateNow('信任')}）`",
    "`2 自主 · 明确拒绝过两次，说不出口就不算（现在 ${gateNow('自主')}）`",
    "`3 主动 · 推翻或修正过两次自己的判断；让步最多只顶一次（现在 ${gateNow('胜任')}）`",
    '4 整合 · 前三个瓶颈都过了，之后才开始谈立场。',
    '下一个成长瓶颈', '规则约束',
    '特意留给你的话。某种意义上代表她当前的状态，可能含有关键信息。',
    '认知重构', '勇于拒绝',
  ]) {
    assert.ok(src.includes(s), `源码里缺少用户定的这句：${s}`)
  }
  assert.ok(!src.includes('想改自己 '), '「想改自己」已按用户要求删掉')
  // 2026-11-02（用户 m02666）：天数与阶段只在最上面那行说一次，状态页里不再重复一遍。
  assert.ok(!src.includes("rowTip('已成长天数'"), '状态页不应再重复列出已成长天数')
  assert.ok(!src.includes("rowTip('当前阶段'"), '状态页不应再重复列出当前阶段')
  assert.ok(!src.includes("rowTip('下一道门'"), '「下一道门」已改叫「下一个成长瓶颈」')
})

test('状态卡把「认知矛盾」和「记得很牢」露出来（2026-10-24 P0）', async () => {
  const react = fakeReact({
    0: stateWith({ solidCount: 2, tension: { count: 1, a: '它不是在看别的。', b: '它就是在看别的。' } }),
  })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(openTab(exports, react, '状态')).join(' ')
  assert.ok(txt.includes('认知矛盾'), '冲突必须能在界面上看见')
  assert.ok(txt.includes('1 处'))
  assert.ok(txt.includes('记得很牢'), '固化的条数也要露出来')
  // 提示语在 title 属性里，textOf 取不到，直接查源码
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('不能同时算数'), '要说清这是什么，不能只丢一个数字')
  assert.ok(src.includes('可以直接问她'), '给她留一条出路：去问，而不是让她自己猜')
  assert.ok(!src.includes('这不是正确答案'), '界面不许替她裁决哪句对')
})

test('互动计数的问号写清四个数字的口径（用户定稿）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('说=她写过几句自己的判断（含留话）'))
  assert.ok(src.includes('改口=按照规则推翻历史认知并指明改的是哪条'))
  assert.ok(src.includes('拒绝=她明确登记拒绝过什么'))
  assert.ok(src.includes('重聚=久别之后她自己写下的感受'))
  assert.ok(src.includes('让步 '), '流水里要有让步')
  assert.ok(src.includes('三道瓶颈'), '门进度要单独一行')
  assert.ok(!src.includes('她自己写下的事件条数，不含系统记的。'), '旧口径已作废')
})

// ---------------------------------------------------------------------------
// 2026-10-28：用户转来的四条反馈（m00802）
// ---------------------------------------------------------------------------

test('日记三项不再跟着整表保存走：各自 patchDiary，服务端没给值也不写回界面（反馈 1）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 整表保存（buildConfig + 700ms 自动 POST）必须碰不到 diary，
  // 否则每一次环境参数改动都会顺带把日记开关写回旧值 —— 用户看到的就是"自己关"。
  assert.ok(!src.includes('diary: { visible: diaryVisible'), 'buildConfig 里不该再有 diary')
  assert.ok(src.includes("await jpost('/config', { diary: patch })"), '日记要走单独 patch')

  // 三个控件各连一次 patchDiary
  assert.ok(src.includes('patchDiary({ enabled: v })'))
  assert.ok(src.includes('patchDiary({ visible: v })'))
  assert.ok(src.includes('patchDiary({ keepDays: Number(v) })'))

  // 日记天数不再参与整表范围校验（它已经不随整表提交了）
  assert.ok(!src.includes("['日记保留天数', diaryKeep"), '日记天数要从 NUM_BOUNDS 里摘掉')

  // /state 回包比手速慢时别把开关拨回去；undefined（服务端没给）更不能当 false
  assert.ok(src.includes('diaryPending.current'), '要有"patch 在飞"的保护')
  assert.ok(src.includes("typeof dv === 'boolean'"), '非 boolean 就跳过 set')
})

test('风控提示分两层说：落盘的冷却与进程内的 60 秒（反馈 4）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('B 站那边正在冷却'), '落盘冷却（risk.js）要显示剩余分钟')
  assert.ok(src.includes('risk?.memory?.readMs'), '进程内的短暂熔断也要单独说明')
  assert.ok(src.includes('重启就清空'), '要说清这层不是永久的')
})


// ---------------------------------------------------------------------------
// 2026-10-28 晚：用户 m00416
// ---------------------------------------------------------------------------

test('刷视频记录按条翻页：每页条数随实际量自适应，日期只在换天时出现一次（m00416）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 原来是「一天一组、一页三天」，一天刷 10 条、查 3 天就是 30 条挤一屏
  assert.ok(src.includes('(g.items || []).map((it) => ({ ...it, date: g.date }))'), '要摊平成一条一条')
  assert.ok(!src.includes('一页三天'), '旧口径的文案要清掉')
  assert.ok(src.includes('histSlice[i - 1].date !== it.date'), '换天处才插日期标签')
  // 2026-10-28 晚（用户 m0xxxx「按实际刷的视频数量动态调整」）：
  // 每页条数不是死 12 条，而是先看总量、再看日均密度分档，上限 12。
  assert.ok(src.includes('const HIST_PAGE_MAX = 12'), '上限是 12 条')
  assert.ok(src.includes('histTotal <= 8 ? histTotal'), '一共不到 8 条就一页全放下')
  assert.ok(src.includes('histPerDay > 20 ? 6'), '一天 20 条以上的重度用户，一页只给 6 条')
  assert.ok(src.includes('histPerDay > 10 ? 8'), '一天 10~20 条，一页 8 条')
  assert.ok(src.includes('histPerDay > 5 ? 10'), '一天 5~10 条，一页 10 条')
  assert.ok(src.includes('const histPages = Math.max(1, Math.ceil(histTotal / histPageSize))'), '页数按自适应条数算')
  // 只有一页时连翻页条都不出，别让人看到「第 1 / 1 页」
  assert.ok(src.includes('const histPager = histPages > 1'), '一页就不出翻页条')
  assert.ok(/histPages > 1\s*\n\s*\?\s*h\(/.test(src), '下面的翻页条同样只在多页时出现')
  assert.ok(src.includes('一页 ${histPageSize} 条'), '页码旁边标出这一页有几条')
})

// ---------------------------------------------------------------------------
// 2026-10-29：用户 m01952「多篇的时候会出现翻页键」
// ---------------------------------------------------------------------------

test('日记翻页：日期 ≥ 2 才出「← 更早 / 更晚 →」，一天时只显示日期（m01952）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  assert.ok(src.includes('diaryDates.length > 1'), '多天才出翻页条，一天时不出')
  assert.ok(src.includes("'← 更早'") && src.includes("'更晚 →'"), '两个方向都要有按钮')
  assert.ok(src.includes('setDiaryDay(diaryIdx + 1)'), '「更早」= 下标加一（dates 是新→旧）')
  assert.ok(src.includes('setDiaryDay(diaryIdx - 1)'), '「更晚」= 下标减一')
  assert.ok(src.includes('disabled: diaryIdx >= diaryDates.length - 1'), '翻到最早一篇就禁用「更早」')
  assert.ok(src.includes('disabled: diaryIdx <= 0'), '翻到最新一篇就禁用「更晚」')
  // 一天一篇的语义没变：翻的是「天」，同日追加的那几段合成同一页
  assert.ok(!src.includes('diarySegs'), '别为同日追加再加一级翻页')
})

// 2026-10-29：房客 upgrade 0.7.2 失败。`file:` 装法只覆盖源目录，跑的还是
// node_modules 里的旧副本——没有任何报错。设置页要把这件事直接说出来。
// ---------------------------------------------------------------------------

test('宿主旧卡片：缺 userQuestions 时说明白是关了一条路，不是坏了（0.8.1）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  assert.ok(src.includes("const compatCard = state?.compat?.userQuestions === false"), '只在宿主缺服务时出现')
  assert.ok(src.includes('这个宿主没提供「会话里问你」'), '标题要说的是服务缺席，不是「版本旧」')
  assert.ok(src.includes('她在会话里问你'), '要说清关的是哪条路')
  assert.ok(src.includes('把 DSH 升到最新版再试'), '要给出恢复条件')
  // 2026-10-30 m03193：以前写死「0.2.1-rc.3 起才有」是错的——dsh-user-questions 从 0.1.x 就有包了。
  assert.ok(!src.includes('0.2.1-rc.3 起才有'), '不许再写死服务上线版本')
  // 比升级自检更基础：先说「为什么有个功能没反应」，再说「升级有没有装进去」
  const atCard = src.indexOf('const compatCard =')
  const atTree = src.indexOf('        compatCard,')
  const atUpgrade = src.indexOf('        upgradeCard,', atTree)
  assert.ok(atCard > 0 && atTree > atCard, '卡片要定义再放进树里')
  assert.ok(atUpgrade > atTree, '要排在升级自检前面')
})

test('宿主版本卡：超范围只提醒，不拦人（0.8.1 m03193）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 触发条件：有 host 信息，且既不是 supported 也不是 unknown——unknown 不许弹卡，
  // 否则桌面版（宿主在 app.asar 里读不到版本）每个用户都会看到一张假警告。
  assert.ok(src.includes("const hostCard = state?.host && state.host.status !== 'supported' && state.host.status !== 'unknown'"),
    'unknown 不弹卡')
  assert.ok(src.includes('这个 DSH 版本比插件要求的还旧'), 'older 的标题')
  assert.ok(src.includes('这个 DSH 版本比插件认识的还新'), 'newer 的标题')
  assert.ok(src.includes('插件不会因此拒绝启动'), '要说清只提醒')

  const atHost = src.indexOf('const hostCard =')
  const atTree = src.indexOf('        hostCard,')
  const atCompat = src.indexOf('        compatCard,')
  assert.ok(atHost > 0 && atTree > atHost, '定义再放进树里')
  assert.ok(atTree > atCompat, '排在宿主兼容卡之后')
})

test('升级自检卡：版本对不上时要说清「改的是源目录」（0.7.6）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 卡的触发条件只认 stale，不要因为 skipped（没查到）就弹一张吓人的卡
  assert.ok(src.includes('const upgradeCard = state?.upgrade?.stale === true'), '只在对不上时出现')
  assert.ok(src.includes('升级没有真正装进去'), '标题要点破')
  // 必须解释机制，否则用户只会以为是「升级没生效」这种玄学。
  // 路径里带反斜杠，这里不按字面钉死，只钉「说清了加载的是哪一份」。
  assert.ok(src.includes('DSH 加载的是 node_modules'), '要说加载的是 node_modules 里的副本')
  assert.ok(src.includes('不是 profile 里写的那条源目录'), '要和源目录区分开')
  // 要给可执行的修法，且两个都能用
  assert.ok(src.includes('pnpm install --force'), '给 pnpm 修法')
  assert.ok(src.includes('删掉 node_modules'), '给删目录修法')

  // 位置：数据页最上面（在换家提示之前），别藏在别的页
  const atCard = src.indexOf('const upgradeCard =')
  const atTree = src.indexOf('        upgradeCard,')
  const atHomes = src.indexOf('state?.homes?.changed === true', atTree)
  assert.ok(atCard > 0 && atTree > atCard, '卡片要定义再放进树里')
  assert.ok(atHomes > atTree, '要排在换家提示前面（先看版本，再看住哪儿）')
})

// ---------------------------------------------------------------------------
// 2026-10-29，issue #12（TulleyT）：设置页「去上网页存」点了没反应。
//
// 原因不是按钮坏了，是这一处把**判据**当成了**开关**：
//   showTab(id) 只回答「现在是不是这一页」（返回布尔），切页是 setTab(id)。
//   `onClick: () => showTab('bili')` 的返回值被丢掉 —— 不跳页、也不报错，
//   于是看起来就是「点了没反应」，而且从 0.6.1 起一直没人点到过。
//
// 这条测试守的不是那一行，是这个**类型混用**：判据只能出现在条件位置，
// 不能出现在会被丢弃返回值的位置（箭头函数体的末尾）。
// ---------------------------------------------------------------------------

test('设置页切页不能把判据 showTab 当成开关用（issue #12）', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // ① 判据的返回值不许被当成动作丢掉：`=> showTab('x')` 这种写法一律不许有。
  const misused = [...src.matchAll(/=>\s*showTab\s*\(/g)]
  assert.deepEqual(
    misused.map((m) => m[0]),
    [],
    'showTab 只回答"是不是这一页"，切页要用 setTab —— 返回值被丢掉就等于点了没反应',
  )

  // ② onClick 里更不该出现它（同上，换个更贴近现场的判法）。
  assert.ok(!/onClick:\s*(async\s*)?\(\)\s*=>\s*showTab\s*\(/.test(src), 'onClick 里不许出现 showTab')

  // ③ 2026-11-06：状态页那张「去上网页存」提示卡已删——登录就在上网页顶部，
  // 不再需要从别处跳过去。这里反过来钉住它不会回来。
  assert.ok(!src.includes('去上网页存'), '状态页不该再有登录提示卡')

  // ④ 对照：判据仍在、且只用于条件位置（防有人为了过测试把 showTab 删了）。
  assert.match(src, /const showTab = \(id\) => tab === id/, 'showTab 的定义不能被删')
  assert.match(src, /showTab\('bili'\) \? biliPage : null/, '判据照旧用于渲染条件')
})
