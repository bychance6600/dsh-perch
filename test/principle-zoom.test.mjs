import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8')

const CLIENT = await read('lib/client.js')

test('原理页五块文案按新结构固化进源码', () => {
  // 2026-11-12 重画：开头一句、五步、四阶段、立场，顺序固定。
  assert.ok(CLIENT.includes('她不是按设定演出来的：一次表态、一次撞上、一次改写，才会留下一条判断。'))
  assert.ok(CLIENT.includes('一、她怎么长'))
  assert.ok(CLIENT.includes('二、记忆的两层'))
  assert.ok(CLIENT.includes('三、谁的话算数'))
  assert.ok(CLIENT.includes('四、她能在哪说话'))
  assert.ok(CLIENT.includes('五、诚实边界'))
  assert.ok(CLIENT.includes('表态 → 撞上 → 落差 → 改写 → 回顾。少一步「改写」，经历就只是流水账。'))
  assert.ok(CLIENT.includes('1 信任（写过一条自己的判断）→ 2 自主（真的拒绝过两件事）→ 3 主动（两次推翻自己的判断）→ 4 整合（回头看）。'))
  assert.ok(CLIENT.includes('走完不加关，之后长的是立场'))
  assert.ok(CLIENT.includes('不是第五关'))
  assert.ok(CLIENT.includes('翻旧事三条路'))
  assert.ok(CLIENT.includes('顺着线索找'))
  assert.ok(CLIENT.includes('最近七天醒了几次'))
  assert.ok(CLIENT.includes('她知道自己忘了什么'))
  assert.ok(!/三道门/.test(CLIENT), '「三道门」这个说法已经统一成「瓶颈」')
  assert.ok(!/四道门/.test(CLIENT), '「四道门」这个说法已经统一成「瓶颈」')
})

test('设计骨架用「」而不是字面量星号', () => {
  assert.ok(CLIENT.includes('这些理论是设计骨架'))
  assert.ok(!CLIENT.includes('**设计骨架**'))
})

test('两张图可以点开放大：灯箱带缩放与拖动', () => {
  assert.ok(CLIENT.includes('const zoomable = (src, alt, caption, marginBottom)'))
  assert.ok(CLIENT.includes("role: 'button',"))
  assert.ok(CLIENT.includes("title: '点一下放大（滚轮缩放、按住拖动、Esc 关闭）'"))
  assert.ok(CLIENT.includes('setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false })'))
  // 缩放范围 1–4 倍
  assert.ok(CLIENT.includes('Math.min(4, Math.max(1, z.scale *'))
  // 拖动：位移累加 + 「拖完不算点击」的 moved 判断
  assert.ok(CLIENT.includes('dragRef.current = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty, moved: false }'))
  assert.ok(CLIENT.includes('if (!dragRef.current || !dragRef.current.moved) setZoom(null)'))
  assert.ok(CLIENT.includes('onDoubleClick: () => setZoom'))
  assert.ok(CLIENT.includes("if (e.key === 'Escape') setZoom(null)"))
  assert.ok(CLIENT.includes('滚轮缩放 ${Math.round(zoom.scale * 100)}%'))
  // 两张图都走 zoomable，不再是裸 img
  assert.ok(CLIENT.includes('zoomable(`${API}/media/principle-loop.svg`'))
  assert.ok(CLIENT.includes('zoomable(`${API}/media/principle-memory.svg`'))
})

test('开发者留言：换掉旧文案，整页最下面收尾，署名居右', () => {
  assert.ok(CLIENT.includes('这套东西没有终点。四个阶段走完只是开始——之后长成什么样，我和你都不知道。'))
  assert.ok(CLIENT.includes('你不需要先学一套操作：日常说话就够了，变化会出现在每一次对话里。'))
  assert.ok(CLIENT.includes("'——来自开发者'"))
  assert.ok(CLIENT.includes("textAlign: 'right'"), '署名要居右')
  for (const old of [
    '机器训练、强化学习、重温 deepseekV1（大笨鱼）',
    '或许这就是 AGI 诞生的一种路径也说不定呢。',
    '连开发者自己也不知道你的 agent 会变成什么样子',
  ]) {
    assert.ok(!CLIENT.includes(old), `旧文案必须删掉：${old}`)
  }
  // 位置：在「诚实边界」之后、且是 principlePage 的最后一个子节点之一（和放大层并列）
  const iBoundary = CLIENT.indexOf("groupFull('五、诚实边界',")
  const iNote = CLIENT.indexOf('const devNote = h(')
  const iPage = CLIENT.indexOf("const principlePage = h('div', { className: 'page' },")
  assert.ok(iNote > 0 && iNote < iPage, 'devNote 要在 principlePage 之前定义好')
  assert.ok(iBoundary > iPage, '「诚实边界」在 principlePage 里面，留言排在它之后')
  assert.ok(/devNote,\s*\r?\n\s*\r?\n\s*zoomOverlay\)/.test(CLIENT), '留言与放大层都挂在原理页末尾')
})

test('放大层只在原理页挂载，不会出现在别的页', () => {
  const matches = CLIENT.match(/zoomOverlay/g) || []
  // 定义 1 次 + 挂在 principlePage 里 1 次
  assert.equal(matches.length, 2, `zoomOverlay 应只出现 2 次，实际 ${matches.length}`)
  assert.equal((CLIENT.match(/const \[zoom, setZoom\] = useState\(null\)/g) || []).length, 1)
})

test('状态声明加在 useState 列表最后（不顶掉按下标注入的测试）', () => {
  const iAuto = CLIENT.indexOf("const [autoNote, setAutoNote] = useState('')")
  const iZoom = CLIENT.indexOf('const [zoom, setZoom] = useState(null)')
  const iLoad = CLIENT.indexOf('const load = useCallback(async () => {')
  assert.ok(iAuto > 0 && iZoom > iAuto && iLoad > iZoom, 'zoom 应插在 autoNote 之后、load 之前')
})

test('插件的根目录自检：这两张图仍然由服务端白名单出图', async () => {
  const observe = await read('lib/observe.js')
  assert.ok(observe.includes('principle-[a-z]+'))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok((pkg.files || []).includes('media'), 'package.json.files 必须含 media')
  assert.ok(root.length > 0)
})
