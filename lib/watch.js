/**
 * watch.js —— 工具 `bili_watch`：她要「看画面」的时候用这个
 *
 * 为什么不塞进 bili_look 自动做：抽一次帧要十秒左右、还要占额度。
 * 她翻列表时看四条视频就自动抽四次，既慢又浪费。**让她自己决定哪条值得看画面**，
 * 这也正好是「自主」这个维度唯一的可验证载体——跟当初给她 bili_look 是同一个理由。
 */

import { readEvents, appendEvent, rootDir } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { grabFrames, findMoment } from './video.js'
import { logLine } from './log.js'

import { defineTool } from './tool.js'
import { slashed } from './posix.js'
import { guardWrite } from './tenant.js'

/** 今天已经看过几条（只数成功的，失败不占额度） */
export function watchedToday(events, dk) {
  const key = `watched:${dk}`
  return (events ?? []).filter((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(key)).length
}

/** 没有 tenancy（单测、老调用）时自己拼一个，理由同 look.js 的 tenancyOf。 */
function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}

function fmtTime(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

export function registerWatch(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  // 单测用的接缝：抽帧与字幕找回都可以注入，不联网也能验「find 不占额度」「from/to 有传下去」。
  const grab = deps.grabFrames ?? grabFrames
  const findIt = deps.findMoment ?? findMoment

  return ctx.tools.register(
    defineTool({
      name: 'bili_watch',
      description:
        '看一条视频的画面。会先看画面变化挑切点，再拼成带格号和时间码的故事板，' +
        '把文件路径告诉你；你用 read_image 打开就能看见。取一次要十几秒，' +
        '所以别每条都看，挑你真的想知道"画面里是什么"的那条。' +
        '想只重扫某一段，就传 from / to（秒）；想盯住某一刻，传 at（秒）。' +
        '只想知道一句话大概在第几分钟，传 find，不用取画面。不用它也可以。',
      // 用完整 JSON Schema（不是简写 DSL）：工具参数必须是根级 type:object，
      // 否则 provider 直接拒 "schema must be a JSON Schema of 'type: object'"。
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: '哪条视频（形如 BV1xx411c7mD）。' },
          at: {
            type: 'array',
            items: { type: 'number' },
            description: '可选：只要这几个时刻（秒），比如 [30, 90, 120]。',
          },
          from: { type: 'number', description: '可选：只重扫这一段，从第几秒开始。' },
          to: { type: 'number', description: '可选：只重扫这一段，到第几秒结束。' },
          find: { type: 'string', description: '可选：一句话，找回它在字幕里的大致时间码；不取画面。' },
        },
        required: ['bvid'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string', description: '拼好的图在哪（用 read_image 读它）' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        // render 必须返回 ContentBlock 数组，签名是 (args, value)
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看成：${out.note}` }],
      },
      async execute(args, exec) {
        // 2026-11-01（issue #16 第二半，用户 m03454）：看画面也写事件（watched:），
        // 同样要认「谁在看、看的是哪栋房子」。
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'bili_watch')
        if (!who.ok) return { ok: false, path: '', text: '', note: who.note }

        const bvid = String(args?.bvid ?? '').trim()
        const { config } = await loadConfig(root)
        if (!config?.browse?.enabled) return { ok: false, path: '', text: '', note: '现在打不开。' }
        if (config?.video?.enabled === false) {
          // 2026-10-28 起每个失败分支都写一行日志。以前这里一个字都没有，
          // 用户那边「看不到画面」时导出包里完全查不出是被哪一条挡下的
          // （另一台机器的排查就卡在这儿，只能靠猜）。
          logLine('info', ['看画面：设置里关掉了看视频'], root)
          return { ok: false, path: '', text: '', note: '现在看不了画面。' }
        }
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
          logLine('info', ['看画面：视频号不合法', bvid || '(空)'], root)
          return { ok: false, path: '', text: '', note: '这不是一个视频号。' }
        }

        // 只找回时间码：读字幕，不取画面、不占「看画面」的额度。
        const phrase = String(args?.find ?? '').trim()
        if (phrase) {
          const hit = await findIt({ bvid, root, find: phrase })
          if (!hit.ok) {
            logLine('info', ['看画面：字幕里没找到', bvid, hit.why ?? ''], root)
            return { ok: false, path: '', text: '', note: hit.why || '没找到这句话。' }
          }
          const times = hit.cues.map((x) => `${fmtTime(x.t)}（${x.text.slice(0, 40)}）`).join('\n')
          return {
            ok: true,
            path: '',
            text: [`《${hit.title || bvid}》里，这句话大致在这些地方：`, times, '要看清那几秒，就用 at 传对应的秒数。'].join('\n'),
            note: '',
          }
        }

        const ev = await readEvents(root).catch(() => ({ events: [] }))
        const dk = dateKey()
        const cap = Math.max(0, Number(config?.video?.perDay ?? 2))
        const used = watchedToday(ev.events, dk)
        // 额度用完只说"不想看了"，不报数字——她不该知道有个计数器在管她（N2）
        if (used >= cap) {
          // 日志里可以写数字：这是给人看的，不是给她看的。
          logLine('info', ['看画面：今日额度已满', `${used}/${cap}`, bvid], root)
          return { ok: false, path: '', text: '', note: '今天不想再看画面了。' }
        }

        const from = Number(args?.from)
        const to = Number(args?.to)
        if (args?.from !== undefined && !Number.isFinite(from)) return { ok: false, path: '', text: '', note: '起点要写成秒数。' }
        if (args?.to !== undefined && !Number.isFinite(to)) return { ok: false, path: '', text: '', note: '终点要写成秒数。' }
        if (Number.isFinite(from) && Number.isFinite(to) && to <= from) return { ok: false, path: '', text: '', note: '终点要在起点后面。' }

        const r = await grab({
          bvid, root,
          frames: config?.video?.frames,
          boards: config?.video?.boards,
          detail: config?.video?.detail,
          quality: config?.video?.quality,
          at: args?.at,
          from: Number.isFinite(from) ? from : undefined,
          to: Number.isFinite(to) ? to : undefined,
        })
        if (!r.ok) {
          logLine('warn', ['看画面：抽帧失败', bvid, r.why ?? ''], root)
          return { ok: false, path: '', text: '', note: r.why }
        }

        await appendEvent(
          {
            type: 'meta',
            ...(who.sessionId ? { sessionId: who.sessionId } : {}),
            // 2026-10-30：原来这行只有 BV 号，于是「她真的看过画面的那几条」
            // 在报告里没法显示标题——只能退回去用 browse: 记账凑，
            // 结果又跟「只扫了眼标题」混成一片（客户反馈的那个 bug）。
            // 把展示信息跟着凭证一起落下来，报告就不必二次取数、也不必猜。
            // 老事件没有这段 JSON，读的一方必须两种形状都认（whatseen.js）。
            text: `watched:${dk} ${bvid} ${JSON.stringify({
              title: String(r.title ?? '').slice(0, 120),
              up: String(r.up ?? '').slice(0, 60),
              duration: Number(r.duration) || 0,
              view: Number(r.view) || 0,
              boards: Array.isArray(r.boards) ? r.boards.length : 1,
              detail: String(r.detail ?? ''),
            })}`,
          },
          { source: 'system' },
          root,
        ).catch(() => {})

        // 路径一律给正斜杠：宿主渲染 markdown 图片时会拿路径拼 /api/file，
        // C:\... 这种反斜杠写法在客户端解析后取不到文件，图片就显示成「无法预览」
        // （2026-10-26 实测：同一张图 C:\ 版失败、C:/ 版正常）。
        const posix = slashed(r.path)
        // 成功的这一条也要记：跟日志里「今日额度已满」对得上，才知道额度是怎么用掉的。
        logLine('info', ['看画面：取到了', bvid, `${used + 1}/${cap}`, posix], root)
        return {
          ok: true,
          path: posix,
          text: [
            `《${r.title || bvid}》的画面，我按变化挑了 ${r.shots} 格，拼成 ${r.paths.length} 张故事板：`,
            ...r.paths.map((p, i) => {
              const board = r.boards?.[i]
              const ts = Array.isArray(board?.times) ? board.times.map((t) => `${t} 秒`).join('、') : ''
              return [`第 ${i + 1} 张${ts ? `（${ts}）` : ''}：`, p]
            }),
            '每张图左上角是格号、左下角是时间码，底部那道细线是声音的起伏。',
            '这是一次采样，不是整条视频。用 read_image 读它就能看见；要在回复里贴图，路径照抄上面那行——用正斜杠。',
          ].join('\n'),
          note: '',
        }
      },
    }),
  )
}
