/**
 * video.test.mjs —— 抽帧管道（2026-10-30 按 GitHub issue #13 重写后的回归）
 *
 * issue #13 的核心断言有两条，这个文件逐条盯着：
 *   1. **子进程不需要写权限**：帧和拼图都从 stdout 拿，落盘由插件自己做。
 *      所以「ffmpeg 跑得起来但写不了文件」不该再表现成「被风控」。
 *   2. **失败原因是真实的**：带退出码 + stderr 前两行，并落到 media/ffmpeg.log。
 *
 * 前 5 条不需要真 ffmpeg（用注入的 ffmpeg 探测结果 + 一个跑不起来的 bin 模拟），
 * 最后一条真跑一遍管道，环境里没有 ffmpeg 时自动跳过——它验的是「不写盘也能出图」，
 * 而没有真 ffmpeg 就没法验这件事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { grabFrames, sampleTimes, normalizeAt, pickSceneTimes, frameDiff, matchCues, wavePeaks, DETAIL, ensureCaFile } from '../lib/video.js'
import { detectFfmpeg, mediaDir } from '../lib/media.js'

const BVID = 'BV1ph4y1g75E'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-perch-video-'))
}

/** 一个假客户端：view/playurl 两条都按 B 站形状返回，可由用例覆盖 */
function fakeClient(over = {}) {
  return {
    async view() { return { ok: true, data: { cid: 1, duration: 6, title: '测试片' } } },
    async playurl() { return { ok: true, data: { url: 'D:/nowhere/clip.mp4', duration: 6 } } },
    ...over,
  }
}

/** 恒失败的 ffmpeg：指向一个不存在的二进制，spawn 会发 'error' */
const NO_SUCH_BIN = { ok: true, bin: join(tmpdir(), 'definitely-not-ffmpeg-xyz', 'ffmpeg.exe') }

// ---- 帧时刻（2026-11-01 用户 m02712：等距九帧 → 分段抖动 + at）----
// 等距的问题是每次取到的都是那同九张图，反复看等于看同一张拼图。

test('sampleTimes：分段抖动，每段必有帧、严格递增、不出头尾 4%', () => {
  const duration = 600
  const seq = [0.1, 0.9, 0.5, 0.3, 0.7, 0.0, 0.99, 0.42, 0.61]
  let i = 0
  const rand = () => seq[i++ % seq.length]
  const times = sampleTimes(duration, 9, rand)

  assert.equal(times.length, 9)
  for (let k = 0; k < times.length; k++) {
    assert.ok(times[k] >= duration * 0.04, `第 ${k} 帧不许落回片头黑场：${times[k]}`)
    assert.ok(times[k] <= duration * 0.96, `第 ${k} 帧不许落进片尾下滑栏：${times[k]}`)
    if (k > 0) assert.ok(times[k] > times[k - 1], '时刻要严格递增，别让 ffmpeg 来回 seek')
  }
  // 每段都落到了（覆盖不丢）：第 k 帧应落在第 k 段里
  const seg = (duration * 0.96 - duration * 0.04) / 9
  for (let k = 0; k < 9; k++) {
    const from = duration * 0.04 + seg * k
    assert.ok(times[k] >= from && times[k] <= from + seg, `第 ${k} 帧跑到别的段去了`)
  }
})

test('sampleTimes：每次取到的时刻不一样（这正是要修的病）', () => {
  const a = sampleTimes(600, 9)
  const b = sampleTimes(600, 9)
  // 随机源独立，九帧全同的概率是 0；真同了就说明根本没抖
  assert.notDeepEqual(a, b)
})

test('sampleTimes：不知道时长就按固定间隔退回去，不崩', () => {
  assert.deepEqual(sampleTimes(0, 3), [0, 5, 10])
  assert.deepEqual(sampleTimes(-1, 2), [0, 5])
})

test('normalizeAt：夹回片内、丢掉乱写、排好序', () => {
  assert.deepEqual(normalizeAt(90, 600), [90])
  assert.deepEqual(normalizeAt([90, 30], 600), [30, 90])
  assert.deepEqual(normalizeAt([99999], 600), [599.5], '越界要夹回片尾前，不能交给 ffmpeg 去失败')
  assert.deepEqual(normalizeAt([-5, 'x', null], 600), [], '乱写的全丢掉')
  assert.deepEqual(normalizeAt(undefined, 600), [])
  assert.deepEqual(normalizeAt([], 600), [])
  assert.deepEqual(normalizeAt([100, 100, 100], 0), [100, 100, 100], '没时长就不夹，重复保留')
})

test('grabFrames：点了名却一个合法时刻都没有，就别悄悄退回随机', async () => {
  // 悄悄退回随机最坏：她以为看的是自己点的那一秒，其实看的是别处
  const root = await tmpRoot()
  const r = await grabFrames({ bvid: BVID, root, client: fakeClient(), at: ['不是秒数'], ffmpeg: NO_SUCH_BIN })
  assert.equal(r.ok, false)
  assert.match(r.why, /时间点看不懂/)
})

test('grabFrames：不是 BV 号就直说，不去联网', async () => {
  const root = await tmpRoot()
  let touched = false
  const client = fakeClient({ async view() { touched = true; return { ok: false } } })
  const r = await grabFrames({ bvid: 'nope', root, client })
  assert.equal(r.ok, false)
  assert.equal(r.why, '不是 BV 号')
  assert.equal(touched, false)
})

test('grabFrames：本机没有 ffmpeg 时，理由与「跑起来失败」分开', async () => {
  const root = await tmpRoot()
  const r = await grabFrames({
    bvid: BVID, root, client: fakeClient(),
    ffmpeg: { ok: false, bin: '', why: 'PATH 上没有 ffmpeg' },
  })
  assert.equal(r.ok, false)
  assert.match(r.why, /没有可用的 ffmpeg/)
  assert.match(r.why, /PATH 上没有 ffmpeg/)
})

test('grabFrames：本机没有 ffmpeg 时，也要先说清上游到底怎么了', async () => {
  // 2026-10-30 CI 上 4 个 job 同时红就是这条：ffmpeg 探测以前在最前面，
  // runner 没装 ffmpeg → 412、要登录这些真实原因全被「本机没有可用的 ffmpeg」盖掉。
  // 装在用户机器上同样害人：视频被删了，她却说「装个 ffmpeg 吧」。
  const root = await tmpRoot()
  const r = await grabFrames({
    bvid: BVID, root,
    ffmpeg: { ok: false, bin: '', why: 'PATH 上没有 ffmpeg' },
    client: fakeClient({ async view() { throw new Error('接口 412：请求被拦截') } }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, '接口 412：请求被拦截')
})

test('grabFrames：取不到视频信息时，把上游那句话原样透出来', async () => {
  const root = await tmpRoot()
  const r = await grabFrames({
    bvid: BVID, root,
    client: fakeClient({ async view() { throw new Error('接口 412：请求被拦截') } }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, '接口 412：请求被拦截')
})

test('grabFrames：拿不到播放地址时不当成抽帧失败', async () => {
  const root = await tmpRoot()
  const r = await grabFrames({
    bvid: BVID, root,
    client: fakeClient({ async playurl() { return { ok: false, message: '要登录' } } }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.why, '要登录')
})

test('grabFrames：ffmpeg 跑不起来时，理由带真实原因而不是「被风控」', async () => {
  const root = await tmpRoot()
  const r = await grabFrames({ bvid: BVID, root, client: fakeClient(), ffmpeg: NO_SUCH_BIN, frames: 4 })

  assert.equal(r.ok, false)
  // 这是 issue #13 咬得最狠的一句：以前不管什么原因都说「可能被风控」
  assert.doesNotMatch(r.why, /风控/)
  assert.match(r.why, /一帧都没取到/)
  assert.match(r.why, /启动失败|退出码/)

  // 原始细节要落一份到 media/ffmpeg.log，导日志时才能查
  const logPath = join(await mediaDir(root), 'ffmpeg.log')
  const log = await readFile(logPath, 'utf8')
  assert.match(log, new RegExp(BVID))
  assert.match(log, /grab/)
})

test('源码守门：失败原因要先过 scrub 再交出去（stderr 里可能有签名播放地址）', async () => {
  // describe() 的输出有两个去处都不该带凭据：media/ffmpeg.log（日志）
  // 和 watch.js 的 note（直接交给模型看）。日志那条自己有 scrub，
  // 交给模型那条只有 describe 这一道关。
  const src = await readFile(new URL('../lib/video.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function describe'))
  assert.match(body.slice(0, 500), /scrub\(/, 'describe() 里的 stderr 必须先过 scrub')
  assert.match(
    body.slice(0, 500),
    /scrub\(firstLines\(/,
    'scrub 要套在 firstLines 外面（先取前两行再脱敏，两件事都要做）',
  )
})

test('源码守门：不给 ffmpeg 任何文件路径输出（issue #13 的核心）', async () => {
  // #13 的根因是「沙箱不让 ffmpeg 子进程写 ~/.dsh-perch」。修法不是给 ffmpeg 换个能写的路径，
  // 而是**根本不让它写文件**：帧和拼图都走 stdout，落盘由插件自己做。
  // 这条守门就是防止以后有人「顺手」把输出路径加回去——加了在完整权限下照样绿，
  // 只有在 workspace-write 的真机上才会炸，那时候就很难查了。
  const src = await readFile(new URL('../lib/video.js', import.meta.url), 'utf8')

  // 旧写法留下过 tmp-* 临时目录，这个不该再出现
  assert.doesNotMatch(src, /tmp-\$\{/, '不该再建 tmp-* 临时帧目录')

  // 每一处 ffmpeg 调用都必须把像素/声音吐到 stdout（`-`），不给它任何文件输出路径。
  // 2026-11-07（A8）：拼图从 ffmpeg 的 tile 改成自己用 lib/frames.js 画，
  // 所以这里不再只认 image2pipe+png；rawvideo 与 s16le 同样只能写 `-`。
  const runs = (src.match(/runFfmpeg\((?!bin, args, o)/g) ?? []).length
  assert.ok(runs >= 2, `至少要两处 ffmpeg 调用（抽帧 + 取声音），实际 ${runs}`)
  assert.match(src, /'-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',/)
  assert.match(src, /'-f', 's16le', '-',/)

  // -i 的入参只能是 url 或 `-`（stdin），不能是 join(...) 拼出来的文件路径
  for (const m of src.matchAll(/-'?i'?,\s*([^\],\n]+)/g)) {
    const arg = m[1].trim()
    assert.ok(
      arg === 'url' || arg === "'-'" || arg === '"-"',
      `-i 只该吃 url 或 stdin（'-'），实际是 ${arg}`,
    )
  }
})

test('ensureCaFile：用 Node 自带的根证书写出一份 PEM，第二次不重写', async () => {
  const root = await tmpRoot()
  const file = await ensureCaFile(root)
  const txt = await readFile(file, 'utf8')
  assert.match(txt, /^-----BEGIN CERTIFICATE-----/m)
  assert.ok((txt.match(/BEGIN CERTIFICATE/g) ?? []).length >= 50, '根证书不该只有一两张')

  const first = await stat(file)
  const again = await ensureCaFile(root)
  assert.equal(again, file)
  const second = await stat(file)
  assert.equal(second.mtimeMs, first.mtimeMs, '内容没变就别重写')
})

test('源码守门：联网抽帧永远带着 CA 且开着校验（2026-11-07 真机）', async () => {
  // ffmpeg 9 的 tls_verify 默认是 true，但 gnutls 那份 Windows 构建没有根证书，
  // 真机上 bili_watch 因此一帧都取不到。不能退回 tls_verify=0——那是为了看图
  // 把整条链路的证书校验关掉；改成显式喂 Node 的根证书。
  const src = await readFile(new URL('../lib/video.js', import.meta.url), 'utf8')

  // 只数带引号的代码字面量，注释里提到的名字不算（否则注释写两遍就误报）
  const ca = (src.match(/'-ca_file'/g) ?? []).length
  const verify = (src.match(/'-tls_verify'/g) ?? []).length
  assert.equal(ca, 1, `-ca_file 只该出现一处（成对写好），实际 ${ca}`)
  assert.equal(verify, ca, `-ca_file 与 -tls_verify 必须成对（ca=${ca}, verify=${verify}）`)

  // 成对还不够，顺序也得对：同一行里 -tls_verify 1 在前、-ca_file 在后
  assert.match(
    src,
    /netArgs\.push\('-tls_verify', '1', '-ca_file', caFile\)/,
    '联网时该在同一处同时加 -tls_verify 1 和 -ca_file',
  )
  assert.match(src, /ensureCaFile\(root\)/, '没指定 CA 时要自己生成一份')
  assert.doesNotMatch(src, /'-tls_verify', '0'/, '不许为了出图关掉证书校验')
})

test('grabFrames：帧与拼图都从 stdout 拿，mp4 在本地也能跑通（不写盘给子进程）', async (t) => {
  const ff = detectFfmpeg()
  if (!ff.ok) {
    t.skip(`本机没有 ffmpeg（${ff.why}），跳过真跑管道`)
    return
  }

  const root = await tmpRoot()
  const src = join(root, 'clip.mp4')
  // 造一段 3 秒的测试片：不联网，也不需要外部素材
  const { spawnSync } = await import('node:child_process')
  const mk = spawnSync(ff.bin, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=3',
    '-pix_fmt', 'yuv420p', '-y', src,
  ], { windowsHide: true, timeout: 60_000 })
  if (mk.status !== 0) {
    t.skip('造测试片失败，跳过')
    return
  }

  const dir = await mediaDir(root)
  await mkdir(dir, { recursive: true })

  const client = fakeClient({
    async view() { return { ok: true, data: { cid: 1, duration: 3, title: '本地测试片' } } },
    async playurl() { return { ok: true, data: { url: src, duration: 3 } } },
  })

  const r = await grabFrames({ bvid: BVID, root, client, ffmpeg: ff, frames: 9 })

  assert.equal(r.ok, true, `抽帧应成功，实际：${r.why}`)
  assert.equal(r.shots, 9)
  assert.equal(r.title, '本地测试片')
  // 交给模型的路径必须是正斜杠（反斜杠写进 markdown 图片显示不出来）
  assert.doesNotMatch(r.path, /\\/)
  assert.match(r.path, /^.+media\/sheet-BV1ph4y1g75E-.+\.png$/)

  const st = await stat(r.path.split('/').join(sep))
  assert.ok(st.size > 1024, `拼图应该不是空的，实际 ${st.size} 字节`)
  const buf = await readFile(r.path.split('/').join(sep))
  assert.equal(buf.subarray(0, 8).toString('hex'), PNG_MAGIC.toString('hex'))

  // 旧实现会在 media/ 下留 tmp-* 临时帧目录；新实现不落中间文件
  const names = await readdir(dir)
  assert.equal(names.filter((x) => x.startsWith('tmp-')).length, 0, '不该再留下临时帧目录')
})

test('grabFrames：给了 at 就只取那几个时刻（真跑本地片）', async (t) => {
  const ff = detectFfmpeg()
  if (!ff.ok) {
    t.skip(`本机没有 ffmpeg（${ff.why}），跳过`)
    return
  }
  const root = await tmpRoot()
  const src = join(root, 'clip.mp4')
  const { spawnSync } = await import('node:child_process')
  const mk = spawnSync(ff.bin, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15:duration=4',
    '-pix_fmt', 'yuv420p', '-y', src,
  ], { windowsHide: true, timeout: 60_000 })
  if (mk.status !== 0) {
    t.skip('造测试片失败，跳过')
    return
  }
  await mkdir(await mediaDir(root), { recursive: true })
  const client = fakeClient({
    async view() { return { ok: true, data: { cid: 1, duration: 4, title: '点名看' } } },
    async playurl() { return { ok: true, data: { url: src, duration: 4 } } },
  })

  const r = await grabFrames({ bvid: BVID, root, client, ffmpeg: ff, at: [1, 2.5] })
  assert.equal(r.ok, true, `应成功，实际：${r.why}`)
  assert.equal(r.shots, 2, '只取她点名的两个时刻')
  assert.deepEqual(r.times, [1, 2.5], '要把实际取的时刻回给她')
})

test('grabFrames：拼图失败时不把 ffmpeg 的报错当成图落盘', async (t) => {
  const ff = detectFfmpeg()
  if (!ff.ok) {
    t.skip(`本机没有 ffmpeg（${ff.why}），跳过`)
    return
  }
  const root = await tmpRoot()

  // 给一个「能读、但不是视频」的输入：ffmpeg 会失败并把原因写 stderr
  const notVideo = join(root, 'not-a-video.mp4')
  await writeFile(notVideo, 'this is definitely not a video file', 'utf8')

  const client = fakeClient({
    async view() { return { ok: true, data: { cid: 1, duration: 3, title: '坏文件' } } },
    async playurl() { return { ok: true, data: { url: notVideo, duration: 3 } } },
  })

  const r = await grabFrames({ bvid: BVID, root, client, ffmpeg: ff, frames: 4 })
  assert.equal(r.ok, false)
  assert.doesNotMatch(r.why, /风控/)
  assert.match(r.why, /一帧都没取到/)

  // 失败时不能留下 sheet 文件（以前可能落一个 0 字节或一段报错文本）
  const dir = await mediaDir(root)
  const sheets = (await readdir(dir).catch(() => [])).filter((x) => x.startsWith('sheet-'))
  assert.equal(sheets.length, 0, `失败时不该留下拼图文件，实际有 ${sheets.join(',')}`)
})


// ---- A8：切点检测、字幕找回、波形（2026-11-07）----

/** 造一张纯色灰度帧：frameDiff 只看亮度，刚好够测切点。 */
function solid(w, h, v) {
  const data = Buffer.alloc(w * h * 3, v)
  return { width: w, height: h, data }
}

test('pickSceneTimes：画面变化大的时刻优先，不是等距抽帧', () => {
  // 0–2 秒一个画面，3–4 秒换了画面；要两格时应该挑到切点附近。
  const samples = [
    { t: 0, frame: solid(16, 9, 0) },
    { t: 1, frame: solid(16, 9, 0) },
    { t: 2, frame: solid(16, 9, 0) },
    { t: 3, frame: solid(16, 9, 255) },
    { t: 4, frame: solid(16, 9, 255) },
  ]
  assert.ok(frameDiff(samples[0].frame, samples[3].frame) > 0.9)
  assert.equal(frameDiff(samples[0].frame, samples[1].frame), 0)
  const times = pickSceneTimes(samples, 2)
  assert.deepEqual(times, [0, 3], '第二格应该落在换画面的那一刻，而不是 2 或 4')
})

test('pickSceneTimes：要的格数比候选多时原样给回，仍然升序', () => {
  const samples = [{ t: 2 }, { t: 0 }, { t: 1 }]
  assert.deepEqual(pickSceneTimes(samples, 9), [0, 1, 2])
  assert.deepEqual(pickSceneTimes([], 4), [])
})

test('matchCues：整句命中排第一；只命中碎片也给，但分数低', () => {
  const cues = [
    { t: 10, text: '今天我们先讲一下这个' },
    { t: 30, text: '亚细亚生产方式的核心是什么' },
    { t: 50, text: '回到刚才那个问题' },
  ]
  const exact = matchCues(cues, '亚细亚生产方式')
  assert.equal(exact[0].t, 30)
  assert.ok(exact[0].score > 1, '整句命中应该拿到 1 以上')
  const loose = matchCues(cues, '生产关系和生产力')
  assert.ok(loose.length >= 1)
  assert.ok(loose[0].score < 1)
  assert.deepEqual(matchCues(cues, '一'), [], '一个字不猜')
})

test('wavePeaks：每段给固定根数，幅度归一，空 PGM 不崩', () => {
  const n = 8000
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i += 1) {
    pcm.writeInt16LE(i < n / 2 ? 16000 : -32000, i * 2)
  }
  const [a, b] = wavePeaks(pcm, [[0, 0.5], [0.5, 1]], 8)
  assert.equal(a.length, 8)
  assert.equal(b.length, 8)
  assert.ok(a.every((x) => x >= 0 && x <= 1))
  assert.ok(b.some((x) => x > 0.9), '后半段更响，峰值应该接近 1')
  assert.deepEqual(wavePeaks(Buffer.alloc(0), [[0, 1]], 4), [[]])
})

test('细节档：三档都给出格大小、取点数和像素预算（A8 设置项要用）', () => {
  for (const k of ['compact', 'normal', 'fine']) {
    assert.ok(DETAIL[k].cell >= 200)
    assert.ok(DETAIL[k].samples >= 4)
    assert.ok(DETAIL[k].budget >= 300000)
  }
  assert.ok(DETAIL.fine.cell > DETAIL.normal.cell)
})
