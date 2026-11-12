/**
 * principle.test.mjs —— 原理页 + 两张自制 SVG（2026-11-12 重画）
 *
 * 守六件事：
 *   1. 两张图真的在包里（`media/principle-*.svg`），且是合法 XML 片段（标签闭合、无裸 &）；
 *   2. 出图走服务端白名单路由，客户端不内联图（bundle 已经十多万字节，别再塞 SVG）；
 *   3. 页签顺序：插件 → 原理 → 数据；
 *   4. 页面上把理论出处写全了，五块顺序固定，诚实边界还在；
 *   5. 原理页不出现「鱼」「大笨鱼」「AGI」「deepseek」，也不出现男字旁代词；
 *   6. 全局样式前缀是 .perch，头像占位字是「她」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT = join(ROOT, 'lib', 'client.js')
const OBSERVE = join(ROOT, 'lib', 'observe.js')
const LOOP = join(ROOT, 'media', 'principle-loop.svg')
const MEMORY = join(ROOT, 'media', 'principle-memory.svg')
const PKG = join(ROOT, 'package.json')

test('两张原理图在包里，而且是完整的 svg', async () => {
  for (const [file, viewBox, must] of [
    // 图一 2026-11-12 重画：左边输入、中间五步、右边留下什么、底部四阶段与三道瓶颈
    [LOOP, 'viewBox="0 0 1400 1180"', [
      '她怎么长', '撞上来的事', '五步循环', '表态', '撞上', '落差', '改写', '回顾',
      '1 信任', '2 自主', '3 主动', '4 整合', '一条', '判断', '拒绝', '两次', '推翻', '立场清单',
    ]],
    // 图二 2026-11-12 重画：账 / 重放 / 派生 / 三条检索路 / 两个底部方块
    [MEMORY, 'viewBox="0 0 1400 1040"', [
      '记忆的两层', 'events.jsonl', '重放', '阶段', '判断', '印象', '立场',
      '字面', '加权', '顺着线索找', '折叠 ≠ 删除', '丢了重放就回来', '记不清原话了',
    ]],
  ]) {
    const svg = await readFile(file, 'utf8')
    assert.ok(svg.startsWith('<svg'), `${file} 必须以 <svg 开头`)
    assert.ok(svg.trimEnd().endsWith('</svg>'), `${file} 必须完整闭合`)
    assert.ok(svg.includes(viewBox), `${file} 要有固定 viewBox（大屏小屏都按比例缩）`)
    for (const word of must) assert.ok(svg.includes(word), `${file} 里缺少「${word}」`)
    // 裸 & 会把 SVG 变成解析错误（XML 里 & 必须转义）
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(svg), `${file} 里有未转义的 &`)
    // 组标签必须成对，否则浏览器会静默截断后半张图
    const open = (svg.match(/<g[\s>]/g) || []).length
    const close = (svg.match(/<\/g>/g) || []).length
    assert.equal(open, close, `${file} 的 <g> 开合不配对：${open} vs ${close}`)
    assert.ok(!svg.includes('他'), `${file} 不许出现男字旁代词`)
  }
})

test('出图走服务端白名单路由，客户端不内联图', async () => {
  const ob = await readFile(OBSERVE, 'utf8')
  assert.ok(ob.includes("['/media', async (req, res)"), '必须有 /media 路由')
  // 2026-11-06：反馈页撤掉交流群二维码，/media 白名单里只留原理图。
  assert.ok(ob.includes('/^\\/dsh-perch\\/media\\/((?:principle-[a-z]+\\.svg))$/'), '文件名必须白名单匹配')
  // 同一条路由按扩展名给类型，不再是一句写死的常量。
  assert.ok(ob.includes("'image/svg+xml; charset=utf-8'"), '必须声明 svg 类型')
  assert.ok(!ob.includes('feedback-qr'), '反馈页二维码已撤，白名单里不再放行它')
  assert.ok(ob.includes('fileURLToPath(new URL(`../media/'), '必须从包内 media/ 读文件')

  const cl = await readFile(CLIENT, 'utf8')
  assert.ok(cl.includes('zoomable(`${API}/media/principle-loop.svg`'), '图一必须走 /media 路由')
  assert.ok(cl.includes('zoomable(`${API}/media/principle-memory.svg`'), '图二必须走 /media 路由')
  assert.ok(!cl.includes('feedback-qr'), '反馈页不再挂群二维码')
  assert.ok(!cl.includes('<svg'), '客户端里不许内联 SVG（会让 bundle 无谓变大）')
})

test('页签顺序：按她的一天排，原理在插件之后、数据之前（2026-11-06）', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  const tabs = cl.match(/const TABS = \[([\s\S]*?)\n {6}\]/)
  assert.ok(tabs, '必须能定位到 TABS')
  const ids = [...tabs[1].matchAll(/\['([a-z]+)', '[^']+'\]/g)].map((m) => m[1])
  // 2026-11-06（0.1.0 重建）：按她的一天排；今天在最前也是默认页，记忆并进成长与数据。
  // 社会页只读，开闸只能她自己按；渠道页只放「在哪、开不开、多久一次」。
  // 2026-11-07（A15）：出门/请神已删，页签里不再有它。
  assert.deepEqual(ids, ['today', 'now', 'grow', 'home', 'social', 'bili', 'channels', 'env', 'principle', 'data', 'feedback'])
  assert.ok(cl.includes("channels: '渠道："), 'TAB_HELP 必须有渠道页说明')
  assert.ok(cl.includes("showTab('channels') ? channelsPage : null"), '渠道页要挂进渲染树')
  assert.ok(!/AUTO_SAVE_TABS = new Set\(.*channels/.test(cl), '渠道不进自动保存页签')
  assert.ok(cl.includes("social: '社会："), 'TAB_HELP 必须有社会页说明')
  assert.ok(cl.includes("showTab('social') ? socialPage : null"), '社会页要挂进渲染树')
  assert.ok(cl.includes("jget('/social')"), '社会页要有数据来源')
  // 2026-11-06：出门（含「先确认一下」那套一次性确认）整块删掉了，相关断言一并作废。
  assert.ok(cl.includes('...TABS.map(([id, name]) =>'), '页签栏不过滤')

  assert.ok(cl.includes("principle: '原理："), 'TAB_HELP 必须有原理页说明')
  assert.ok(cl.includes("showTab('principle') ? principlePage : null"), '必须真的挂上渲染')
  assert.ok(cl.indexOf("showTab('principle')") > cl.indexOf("showTab('env')"), '原理在插件之后')
  assert.ok(cl.indexOf("showTab('principle')") < cl.indexOf("showTab('data')"), '原理在数据之前')
})

test('原理页五块顺序固定，理论出处写全，诚实边界还在', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  assert.ok(cl.includes('她不是按设定演出来的：一次表态、一次撞上、一次改写，才会留下一条判断。'), '开头第一句必须固定')
  assert.ok(cl.includes('表态 → 撞上 → 落差 → 改写 → 回顾。少一步「改写」，经历就只是流水账。'), '五步循环要写全')
  assert.ok(cl.includes('1 信任（写过一条自己的判断）→ 2 自主（真的拒绝过两件事）→ 3 主动（两次推翻自己的判断）→ 4 整合（回头看）。'), '四阶段与三道瓶颈要写全')
  assert.ok(cl.includes('喜欢什么、守哪条线、绝不做哪几件。每一条都得有代价垫着，且不参与折叠。'), '立场清单要写全')
  assert.ok(cl.includes('翻旧事三条路') && cl.includes('顺着线索找'), '翻旧事要写全三条路')
  assert.ok(cl.includes('只翻某个人说的，或某一段时间里的'), '要说明能按人、按时间限定')
  assert.ok(cl.includes('最近七天醒了几次、几次没接上话、几次明确说不、几次被纠正'), '近况要能看见这几项')
  assert.ok(cl.includes('她知道自己忘了什么'), '要说明她知道自己忘了什么')

  const heads = ['一、她怎么长', '二、记忆的两层', '三、谁的话算数', '四、她能在哪说话', '五、诚实边界']
  let prev = -1
  for (const head of heads) {
    const at = cl.indexOf(`groupFull('${head}'`)
    assert.ok(at > prev, `五块必须按顺序出现：${head}`)
    prev = at
  }

  for (const name of [
    'Kolb 经验学习圈', 'Piaget 失衡', 'Bowlby 依恋理论', 'Erikson 心理社会发展',
    'Festinger 认知失调', 'Bartlett 重构记忆', 'Cowan 工作记忆容量', 'Tulving 线索依赖遗忘',
    'Bjork 遗忘的适应功能', 'Dewey 经验连续性', 'Schön 反思性实践', 'Vygotsky 最近发展区',
    'Bloom 掌握学习', 'Metzinger 自我模型',
  ]) {
    assert.ok(cl.includes(name), `原理页必须提到「${name}」`)
  }
  for (const scene of ['学习', '认知重构', '人格养成']) {
    assert.ok(cl.includes(scene), `用途里必须有「${scene}」`)
  }
  assert.ok(cl.includes('诚实边界'), '必须写明这只是借理论当骨架')
  const start = cl.indexOf('const devNote = h(')
  const end = cl.indexOf('const envPage = h(')
  assert.ok(start > 0 && end > start, '必须能切出原理页区域')
  assert.ok(!/他/.test(cl.slice(start, end)), '原理页文字不许出现男字旁代词')
})

test('原理页不出现「鱼」「大笨鱼」「AGI」「deepseek」', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  const start = cl.indexOf('const devNote = h(')
  const end = cl.indexOf('const envPage = h(')
  const page = cl.slice(start, end)
  for (const word of ['鱼', '大笨鱼', 'AGI', 'deepseek']) {
    assert.ok(!page.includes(word), `原理页不许出现「${word}」`)
  }
  for (const file of [LOOP, MEMORY]) {
    const svg = await readFile(file, 'utf8')
    for (const word of ['鱼', '大笨鱼', 'AGI', 'deepseek']) {
      assert.ok(!svg.includes(word), `${file} 不许出现「${word}」`)
    }
  }
})

test('样式前缀改成 .perch，头像占位字改成「她」', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  assert.ok(cl.includes('.perch{color:var(--dsw-alias-label-primary)'), '样式前缀必须是 .perch')
  assert.ok(!cl.includes('.dfish'), '旧的 .dfish 前缀必须全部改掉')
  assert.ok(cl.includes("h('span', null, '她')"), '没有头像时画空圈占位')
  assert.ok(cl.includes('DSH「设置 → 她」里的一节'), '头部注释不能还写「设置 → 鱼」')
})

test('package.json 会一起发布 media/', async () => {
  const pkg = JSON.parse(await readFile(PKG, 'utf8'))
  assert.ok(pkg.files.includes('media'), 'files 里必须带上 media，否则装出去没有图')
})
