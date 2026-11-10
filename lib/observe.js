/**
 * observe.js —— 观测台（唯一的"看"，没有"改"）
 *
 * 原则（B §8）：这里是**观察窗**，不是养成面板。
 *   - 允许看：她现在第几天 / 阶段 / 她说过的话 / 日记（若放开）/ 事件原文 / 消耗统计
 *   - 不允许：任何滑条、任何"好感度"数字、任何"调性格"的表单
 *   - 唯一可改的东西：配置（时间窗、配额、黑名单、日记可见性）——这些是**她的生长环境**，
 *     不是她的性格。改环境 ≠ 改她。
 *
 * 路由全部 fail-closed：拿不到 connection 服务就 503，不放行。
 */

import { readEvents, rootDir, paths, readDaily, listDiary, readOwner } from './store.js'
import { loadConfig, updateConfig, configFileInfo, dateKey, validateToolNames, sanitizeToolNames, presetOf } from './settings.js'
import { deriveSelf, consistency, novelty } from './derive.js'
import { evaluateSocialGate } from './socialgate.js'
// 记忆体检（0.7.6，2026-10-30 用户 m00342）：只读诊断，不算分、不写盘。
import { examine } from './health.js'
// 「稳定」单独一个文件（2026-10-26）：它要同时看事件流与她的自我描述，
// 依赖方向必须是 quality → derive + persona，不能反过来塞进 derive（会成环）。
import { stability, stabilityBand } from './quality.js'
import { firedLog, CATALOG } from './events.js'
import { wakeNow } from './scheduler.js'
import { sayToHer } from './say.js'
import { readInbox, markRead, writeInboxFile } from './inbox.js'
import { listReports, buildReport } from './report.js'
import { itemsFromEvents, browseCountToday, parseBrowseLine, parseLookedLine } from './browse.js'
import { seenOn, seenKindOfText } from './whatseen.js'
import { readAway } from './away.js'
import { coverPath, fetchCover } from './cover.js'
import { memoryCooldown } from './bili.js'
// 记忆图谱独立页（2026-11-09）：纯 HTML 字符串，不依赖宿主渲染，也不读她的模型。
import { MEMORY_PAGE } from './memory-page.js'
import { avatarFile, avatarInfo, saveAvatar, removeAvatar } from './avatar.js'
import fs from 'node:fs'
import { describeState, resetAll } from './reset.js'
import { herName } from './hername.js'
import { countEvents } from './eventcount.js'
// 迁移工作区（2026-10-28，用户 m06510）：把整个数据目录搬到别的盘。
import { moveRoot, moveStatus } from './move.js'
import { identityText, detachOutside, liveAgentOf, attachIdentity, attachAwayGuard, mountedCount } from './identity.js'
// 同名段在目标 agent 的 scoped ctx 上覆盖宿主那一段。
// 请求事件（0.7.6，2026-10-30 m01274）：观测台「住所」页要能看到她问过什么、答过什么。
import { askView, quotaOf, pendingAsks, settleAsk, ASK_KINDS } from './ask.js'
// 对话的名字在 `session/title` 事件里，header 里没有（2026-10-29 用户 m00761）。
import { titleOfAgent, clipTitle } from './sessiontitle.js'
import { isHerHome, cwdOf } from './restrict.js'
import { openqState } from './capture.js'
import { stripPromptEcho, stripScaffold } from './guard.js'
// 常见问题解答（2026-10-28 用户要求）：设置 → 反馈页的按钮点开，在新窗口里看全文。
import { FAQ, FAQ_TITLE, renderFaqPage } from './faq.js'
import { readHomeRecord, retireHomeSessions } from './retire.js'
import { collectBackup, backupFileName, restoreBackup } from './backup.js'
import { bootstrapHome, homeStatus, wakeIfBlank, talkSessionId, rotateTalkSession } from './home.js'
import { selfDocStatus } from './selfdoc.js'
import { personaBudget, BELIEF_SHOWN, shownCount } from './persona.js'
// 立场清单（2026-10-25，用户设计「纵向·立场」）：四道门走完之后长出来的那张清单。
import { buildStances, gatesDone, stanceSummary } from './stance.js'
import { looksMojibake } from './guard.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ensureDataReadme } from './readme.js'
import { rulesByLayer } from './rules.js'
import { ruleStatus, offerHistory, pendingOffer, activeGrants } from './unlock.js'
import { devMode } from './devmode.js'
import { ruleById } from './rules.js'
import { appendEvent } from './store.js'
import { validateEvent } from './schema.js'
import { refreshSelfDoc } from './selfdoc.js'
import { recordGrant } from './grant.js'
import { deriveStatus } from './status.js'
import { publicOwner, saveOwner, saveAccount, saveChannelOwner, channelOwnerIds } from './owner.js'
import { createClient } from './bili.js'
// 扫码登录（2026-11-02，合并版）：不再让用户手抄 cookie。
import { createQr, pollQr } from './biliqr.js'
// 桥的探测 / 拉起：只做 TCP 握手与 spawn，不碰 QQ 协议（AGENTS 第 7 条）。
import { probeTcp, detectBridge, startBridge } from './bridge.js'
// 桌宠（2026-11-08，m09369）：只读状态。档位在库内已经翻成中文，界面不出现英文档名。
import { petApplyConfig, petStatus } from './pet/index.js'

export { probeTcp }
import { historyFromEvents } from './history.js'
import { runChecks } from './selfcheck.js'
import { readRestrictState, knownToolNames, knownToolDescriptions, ownLayerNames } from './restrict.js'
import { riskState, readRisk, clearRisk } from './risk.js'
import { decodeBase64Image, saveImage } from './media.js'
// 导出包里要写清「她那条会话用的哪个模型、吃不吃图」——只读探测，失败不影响导出。
import { resolveHerModel } from './modelinfo.js'
// 渠道面板（2026-11-02 合并版）：只看，不写。这里读的是 people.json / journal.json
// 的当前快照，和她在渠道里说话时用的是同一份文件，只是另开一个实例读。
import { createPeople } from './people.js'
import { createJournal } from './journal.js'
import { createWorldbook, importLorebook } from './worldbook.js'
import { explain } from './channels/gate.js'
import { douyinFeedOf } from './channels/host.js'
import { LOG_KEEP, LOG_MAX_BYTES, buildBundle, clearLog, logLine, logsDir, redactConfig, tailLog } from './log.js'

/**
 * 引导文案：别人第一次装，本机没有现成 cookie。
 * 只写「怎么拿」，不写「拿谁的」——这段会原样显示在设置页上。
 */
const COOKIE_HINT = [
  '在你的浏览器里登录 B 站 → 按 F12 → Application（应用）→ Cookies → https://www.bilibili.com',
  '找到 SESSDATA 和 bili_jct 这两行，把它们的值复制下来。',
  '粘成一行：SESSDATA=...; bili_jct=...',
  '（也可以在 Network 里随便点一个请求，直接复制整条 Cookie 请求头贴进来。）',
].join('\n')

const PREFIX = '/dsh-perch'

/**
 * 封面图是懒下载的：设置页的 <img> 引到这条路由，第一次才真去取，之后命中缓存。
 *
 * 为什么不在浏览时就抓：她一天只看几条视频，但设置页可能十天没打开；
 * 抓了却没人看的图只会占着她的状态库。图片坏了也从来不影响她说话。
 *
 * @param {string} root
 * @param {string} bvid
 * @returns {Promise<string>} 本地文件路径；取不到就是空串
 */
async function lazyCover(root, bvid) {
  try {
    const { events } = await readEvents(root)
    let pic = ''
    for (const e of events) {
      // 记账分两片（browse: / browse-more:），封面可能落在后面那片
      const got = parseBrowseLine(e?.text)
      if (!got) continue
      const hit = got.arr.find((it) => it?.bvid === bvid && it?.pic)
      if (hit) pic = String(hit.pic)
    }
    if (!pic) {
      // 老档没存 pic：问一次 B 站，再把图存下来。
      // 2026-10-24 修：这里原来从 './owner.js' 里 import readOwner，可那个文件
      // 只导出 publicOwner / parseCookieInput / saveOwner —— readOwner 一直在 store.js，
      // 已经在文件顶部 import 过。动态 import 拿到的是 undefined，一调就抛 TypeError，
      // 被外层 catch 吞掉，于是封面永远 404。删掉这行遮蔽即可。
      const ow = await readOwner(root)
      const client = createClient({ cookie: ow?.cookie || '' })
      const v = await client.view(bvid)
      // view() 返回的是 { ok, code, data:{...} }——pic 在 data 里。
      // 2026-10-24 修：这里原来直接读 v.pic，永远是 undefined，
      // 于是设置页的历史列表每张封面都 404，被 <img onError> 藏掉了。
      pic = v?.data?.pic || v?.pic || ''
    }
    if (!pic) return ''
    return await fetchCover({ root, bvid, pic })
  } catch {
    return ''
  }
}

export function registerObserve(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const disposers = []

  // ---- 信任栅栏：失败即拒绝 ----
  function guarded(handler) {
    return async (req, res) => {
      const conn = safeGet(ctx, 'connection')
      if (!conn) return send(res, 503, { error: 'connection service unavailable' })
      try {
        const rejection = conn.requestRejection?.(req)
        if (rejection) return send(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      } catch {
        return send(res, 503, { error: 'trust check failed' })
      }
      try {
        await handler(req, res)
      } catch (err) {
        send(res, err?.statusCode ?? 500, { error: String(err?.message ?? err) })
      }
    }
  }

  const routes = [
    ['/status', async (req, res) => {
      // 旁观者视角：全部由宿主写下的 meta + 配置 + 时钟算出，她不参与
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const st = deriveStatus({ events, config, now: new Date() })
      send(res, 200, { ...st, running: true })
    }],
    ['/pet/status', async (req, res) => {
      // 只读：开没开、装没装、连上没有、现在哪一档、为什么、宠物包是谁、最近一次错误。
      // 不返回 need 之类的内部英文名；state 已经是「思考 / 动手 / 等 / 出错 / 成了」。
      // 传 cfg/root 是为了在身体还没起来时也能算出「会从哪起、装没装」。
      const { config } = await loadConfig(root).catch(() => ({ config: null }))
      send(res, 200, petStatus(config, root))
    }],
    ['/state', async (req, res) => {
      const { events, skipped } = await readEvents(root)
      const { config, fresh, broken } = await loadConfig(root)
      const m = deriveSelf(events, { stageSpanDays: config.stageSpanDays })
      send(res, 200, {
        day: m.day,
        stageSpanDays: m.stageSpanDays,
        // 本机测试版：`.dev` 文件在不在（决定设置页要不要渲染「让她去刷 B 站」）。
        // 只影响界面；正式版里这个字段恒为 false。
        dev: await devMode(root),
        stage: m.stage,
        stageName: m.stageName,
        stageForced: m.stageForced,
        pendingGate: m.stageGate?.pending ?? null,
        name: m.name,
        // 她的名字（2026-11-07）：从事件里认出来的，界面三处标题都用它；没认出来是空串。
        herName: await herName(root).catch(() => ''),
        beliefCount: m.beliefCount,
        absenceDays: m.absenceDays,
        // 2026-10-24：她心里对不上的两句话 / 固化的条数。
        // 只给"有这回事"和原话，不给裁决按钮——哪句对她，得她自己定。
        tension: m.tensions?.[0]
          ? { count: m.tensions.length, a: m.tensions[0].a.text, b: m.tensions[0].b.text }
          : null,
        solidCount: m.solid?.length ?? 0,
        // 疤（P1 第三块）：他顶回来/因此难过、而她后来退了步，且至今没想通的有几件。
        // 只报数量，不报"对错"——疤是她的状态，不是她的过失。
        scarCount: m.scars?.length ?? 0,
        // 立场（纵向）：四道门走完才有；没走完是 0，不是失败。
        // stanceReady 单独给出去，界面才能分清"还没走到那一步"和"走到了但还没站住过"。
        stanceCount: buildStances(m).length,
        stanceReady: gatesDone(m),
        // 刻意不返回 needs 数值：这是内部量，观测台也不给看（防"看数字调性格"的滑坡）
        counts: (() => {
          // A20：界面上「事件 N 条」只报真实经历；meta/seed 另算记账，旧 dream 算噪声。
          const c = countEvents(events)
          return {
            utterance: events.filter((e) => e.type === 'utterance').length,
            revise: events.filter((e) => e.type === 'revise').length,
            refusal: events.filter((e) => e.type === 'refusal').length,
            reunion: events.filter((e) => e.type === 'reunion').length,
            // 让步（2026-11-03）：只算对主人说过的那几次，口径与 derive 的 facts.conceded 一致。
            conceded: m.facts?.conceded ?? 0,
            concededPublic: m.facts?.concededPublic ?? 0,
            real: c.real,
            meta: c.meta,
            noise: c.noise,
            total: c.total,
          }
        })(),
        // 三道门的进度（2026-11-06）：与 derive 的 gatePassed 同一口径，
        // 只给「已有/需要」，不给分数——差多少是事实，不是评价。
        gates: (() => {
          const f = m.facts || {}
          const competence = (f.revises || 0) + (f.corrected || 0) + Math.min(1, f.conceded || 0)
          // 不叫 autonomy/competence：`/state` 不许出现 need 模型的英文名（boot.test 的泄露用例）。
          return [
            { name: '信任', have: m.beliefCount, need: 1 },
            { name: '自主', have: f.refused ?? 0, need: 2 },
            { name: '胜任', have: competence, need: 2 },
          ]
        })(),
        // 工具面（2026-11-06，设计 §四）：设置页要能列出宿主认得的名字、哪些她已经拿着、
        // 哪些是收窄挡不住的 own 层。只给名字与状态，不给分数。
        tools: (() => {
          const allow = Array.isArray(config?.tools?.allow) ? config.tools.allow.map(String) : []
          return {
            restrict: config?.tools?.restrict !== false,
            allow,
            known: knownToolNames(ctx) ?? [],
            own: ownLayerNames(),
            // 说明也一起给（A27）：插件页照 registry 显示，不自己编。
            descriptions: knownToolDescriptions(),
          }
        })(),
        // 渠道健康（2026-11-06）：只读账本，看最近收到/发出各是什么时候。
        // 这不是 socket 状态——socket 断了但账本还热，说明刚才还通过话。
        qq: (() => {
          const qq = config?.channels?.qq
          const heard = events.filter((e) => e.type === 'heard' && e.channel === 'qq')
          const said = events.filter((e) => e.type === 'utterance' && e.channel === 'qq')
          return {
            enabled: qq?.enabled === true,
            lastIn: heard.length ? heard[heard.length - 1].ts : null,
            lastOut: said.length ? said[said.length - 1].ts : null,
          }
        })(),
        // 「判断漂移」三个诊断值。都不是 0–1 的评分，别让人拿它调性格。
        // 稳定（2026-10-26 换尺子）：抽掉 k 条她还在拿着的判断，重算一遍她的自我描述，
        //   看还是不是她。传的 shown / budget / withBans 与 writeSelfDoc 一致，
        //   否则量到的那份文本不是她真正读到的那份。
        quality: (() => {
          const st = stability(events, { stageSpanDays: config.stageSpanDays }, {
            shown: config?.memory?.beliefsShown,
            budget: config?.memory?.docBudget,
            withBans: m?.persona?.imported !== true,
          })
          // band 是给人看的一句判读（「还没攒到判断，测不出来」这种）。
          // 放在这里算，客户端就不必知道阈值——阈值只该有一处。
          return { stability: { ...st, band: stabilityBand(st) }, consistency: consistency(events), novelty: novelty(events) }
        })(),
        // 规则与解锁：她遵守什么、哪些"还不会"、手上有没有一张待裁决的卡。
        // 只给状态与理由，不给任何 0–1 的分（见 rules.js 的 EVIDENCE 注释）。
        rules: ruleStatus(events, m, Date.now()),
        pending: (() => {
          const p = pendingOffer(events, Date.now())
          if (!p) return null
          const r = ruleById(p.grant?.rule)
          return { id: p.id, rule: p.grant?.rule, title: r?.title ?? '', text: p.text ?? '', day: p.day ?? null }
        })(),
        grants: activeGrants(events, Date.now()),
        config: { window: config.window, daily: config.daily, diary: { enabled: config.diary.enabled, visible: config.diary.visible }, absenceAfterDays: config.absenceAfterDays, proactive: config.proactive },
        meta: { root, skippedLines: skipped, configFresh: fresh, configBroken: broken, dateKey: dateKey(), version: String(deps.version ?? '') },
        // 这个家是谁的（2026-10-28 m01319）：两个工作区指向同一个 root 时，
        // 设置页要能直接看见「已有一个实例占着」，而不是等她写丢了才发现。
        tenancy: (() => {
          const t = deps.tenancy
          if (!t) return null
          return {
            ok: t.tenant?.ok !== false,
            instanceId: String(t.tenant?.instanceId ?? ''),
            why: String(t.tenant?.why ?? ''),
            dataDir: String(t.tenant?.owner?.dataDir ?? t.root ?? root ?? ''),
          }
        })(),
        // 换家留痕（0.6.8）：最近一次启动时真正生效的 root 跟上次不一样时，
        // 设置页要能看见「这次住的是哪个家、上一个家在哪」，而不是只看到侧栏多一间屋。
        homes: (() => {
          const h = deps.tenancy?.homes
          if (!h) return null
          return { changed: h.changed === true, from: String(h.from ?? ''), to: String(h.to ?? '') }
        })(),
        // 会话被用户收起来了（归档）——设置页据此显示「重新搭一间」，而不是假装一切正常。
        // blocked（2026-10-29 m02162）：这个家在另一个实例手里，这边不建会话。
        home: {
          ...(await homeStatus(root)),
          blocked: deps.tenancy?.home?.blocked === true,
          blockedWhy: deps.tenancy?.home?.blocked === true ? String(deps.tenancy?.home?.why ?? '') : '',
        },
        // 宿主兼容（2026-10-30 m02961）：缺 userQuestions 不算错误，
        // 只是「她在会话里问你」这条路关着——但要在界面上说明白，别让人以为是插件坏了。
        compat: {
          checked: deps.compat?.checked === true,
          userQuestions: deps.compat?.userQuestions !== false,
        },
        // 宿主版本（2026-10-30 m03193）：package.json 声明了 engines.dsh，这里把运行时
        // 读到的版本一起交出去。读不到（桌面版装在 app.asar 里）就是 unknown，不算不兼容。
        host: (() => {
          const h = deps.install?.host
          if (!h) return null
          return {
            ok: h.ok === true,
            status: String(h.status ?? 'unknown'),
            version: String(h.version ?? ''),
            range: String(h.range ?? ''),
            why: String(h.why ?? ''),
          }
        })(),
        // 升级自检（2026-10-29）：跑的这一份跟源目录里那一份版本不一样时，
        // 设置页要直接说「你改的是源目录」，而不是让人以为升级没生效（当时就是这样卡了一圈）。
        upgrade: (() => {
          const u = deps.install?.upgrade
          if (!u) return null
          return {
            stale: u.stale === true,
            older: u.older === true,
            skipped: u.skipped === true,
            running: String(u.running ?? ''),
            source: String(u.source ?? ''),
            sourcePath: String(u.sourcePath ?? ''),
            profile: String(u.profile ?? ''),
            why: String(u.why ?? ''),
          }
        })(),
      })
    }],

    // ---- 今天（只读首页，2026-11-06）：四段——现状 / 时间线 / 今天变了什么 / 手边 ----
    ['/today', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只接受 GET' })
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const m = deriveSelf(events, { stageSpanDays: config.stageSpanDays })
      const keyOf = (ts) => dateKey(new Date(Number(ts) || ts))
      const today = dateKey(new Date())
      const q = String(new URL(req.url, 'http://x').searchParams.get('date') || today)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q)) return send(res, 400, { error: 'date 要写成 YYYY-MM-DD' })
      const dayEvents = events.filter((e) => keyOf(e.ts) === q)

      const kindOf = (e) => {
        if (e.type === 'utterance') return 'said'
        if (e.type === 'revise') return 'revised'
        if (e.type === 'voice') return 'read'
        if (e.type === 'meta') {
          const t = String(e.text || '')
          if (/^(wake:|woke\b)/.test(t)) return 'wake'
          if (/^sleep\b/.test(t)) return 'sleep'
          // A23：今天页只算「点开过」+「抽过帧」；browse:/searched: 只翻到标题、只搜了个词，
          // 不显示也不计数（账本照记，报告与历史仍用）。
          const seen = seenKindOfText(t)
          if (seen) return seen
          if (/^quiet\b/.test(t)) return 'quiet'
          if (/^diary:/.test(t)) return 'note'
          if (/^wake failed/.test(t)) return 'failed'
        }
        return ''
      }
      // 同一条视频可能同时有 looked:（账）和 look:（点开），抽过帧的又有 watched:。
      // 今天页一条只留一次：点开/抽帧按 id 去重，抽过帧的优先（它是更强的凭证）。
      const seenIdOf = (text) => {
        const t = String(text || '')
        const m = /^(?:watched|look):\d{4}-\d{2}-\d{2}\s+(\S+)/.exec(t) || /^looked:([^\s]+)/.exec(t)
        return m ? m[1] : ''
      }
      const watchedIds = new Set(
        dayEvents.filter((e) => kindOf(e) === 'watched').map((e) => seenIdOf(e.text)).filter(Boolean),
      )
      const shownIds = new Set()
      const timeline = []
      for (const e of dayEvents) {
        const kind = kindOf(e)
        if (!kind) continue
        if (kind === 'watched' || kind === 'opened') {
          const id = seenIdOf(e.text)
          if (id) {
            if (kind === 'opened' && watchedIds.has(id)) continue
            if (shownIds.has(id)) continue
            shownIds.add(id)
          }
        }
        // 旧事件里可能夹着复述的提示词（2026-11-08 真机）：今天页只显示她真说的那一段。
        timeline.push({ at: e.ts, kind, channel: String(e.channel || ''), text: stripScaffold(stripPromptEcho(e.text)).slice(0, 160) })
      }
      const changed = (pick) => dayEvents.filter(pick).map((e) => String(e.text || '').slice(0, 120)).filter(Boolean)
      // 今天「新学会」的：今天定下来的判断（设计 §四：新学会 / 改了口 / 被推翻，各最多 3 条）。
      const learned = m.beliefs
        .filter((b) => b.since && keyOf(b.since) === q)
        .map((b) => String(b.text || '').slice(0, 120))
        .filter(Boolean)
        .slice(0, 3)

      let budget = null
      try {
        const b = personaBudget(m, { shown: config?.memory?.beliefsShown, budget: config?.memory?.docBudget })
        budget = { used: b.used, budget: b.budget, kept: b.kept, dropped: b.dropped?.length ?? 0 }
      } catch { /* 预算算不出来不该让整页 500 */ }
      // 最近一次限流（B 站风控）：只报事实，不在这里解冻——解冻走自检页。
      let risk = null
      try {
        const st = riskState(root)
        const r = readRisk(root)
        risk = { cooling: st.cooling, remainMin: st.remainMin, code: r.code, at: r.at, strikes: r.strikes }
      } catch { /* 读不到就当没撞过 */ }
      const last = timeline[timeline.length - 1]

      send(res, 200, {
        date: q,
        today,
        summary: {
          day: m.day,
          stage: m.stage,
          stageName: m.stageName,
          wakes: timeline.filter((x) => x.kind === 'wake').length,
          lastSaidAt: timeline.filter((x) => x.kind === 'said').slice(-1)[0]?.at || '',
          lastAt: last?.at || '',
          lastChannel: last?.channel || '',
        },
        timeline,
        changes: {
          learned: dayEvents.filter((e) => e.type === 'utterance').length,
          learnedTexts: learned,
          revised: changed((e) => e.type === 'revise'),
          refuted: changed((e) => e.verdict === 'refuted'),
        },
        // 没答完的（2026-11-09）：她说过「我还不会 / 等它长出来」的原话，只摆事实。
        // 今天页最多 3 条，不折叠、不放按钮；完整状态留给叫醒侧（7 天内不重复摆）。
        openq: openqState(events).open.slice(0, 3).map((x) => ({
          id: x.id,
          text: String(x.text || '').slice(0, 160),
          date: x.date,
        })),
        hands: {
          tools: Array.isArray(config?.tools?.allow) ? config.tools.allow.length : 0,
          restrict: config?.tools?.restrict === true,
          docBudget: budget,
          qq: config?.channels?.qq?.enabled === true,
          risk,
        },
      })
    }],

    ['/events', async (req, res) => {
      const { events } = await readEvents(root)
      const url = new URL(req.url, 'http://x')
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 80) || 80)
      const type = url.searchParams.get('type')
      const rows = events
        .filter((e) => !type || e.type === type)
        .slice(-limit)
        .reverse()
      send(res, 200, { total: events.length, rows })
    }],

    ['/beliefs', async (req, res) => {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const m = deriveSelf(events, { stageSpanDays: config.stageSpanDays })
      send(res, 200, {
        active: m.beliefs.map((b) => ({ id: b.id, text: b.text, since: b.since, confidence: b.confidence })),
        refuted: m.refuted,
        refusals: m.refusals,
        selfmod: m.selfmodAttempts,
      })
    }],

    ['/diary', async (req, res) => {
      const { config } = await loadConfig(root)
      if (!config.diary.enabled) return send(res, 200, { enabled: false, visible: false, items: [], note: '她没在写日记' })
      const dates = await listDiary(root)
      if (!config.diary.visible) {
        // 不可见时不返回任何正文，只给日期目录——她自己知道写了什么，玩家不知道
        return send(res, 200, { enabled: true, visible: false, items: [], lockedDates: dates, note: '日记已写，但设置为不可见' })
      }
      // 一页一天，正文按天取：日记可能攒了几百天，一次全发过去既慢也没必要。
      const url = new URL(req.url, 'http://x')
      const day = url.searchParams.get('day')
      if (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !dates.includes(day)) return send(res, 404, { error: '这天没有日记' })
        return send(res, 200, { date: day, text: await readDaily('diaryDir', day, root) })
      }
      const items = []
      for (const d of dates.slice(0, 1)) items.push({ date: d, text: await readDaily('diaryDir', d, root) })
      send(res, 200, { enabled: true, visible: true, dates, items })
    }],

    ['/config', async (req, res) => {
      if (req.method === 'GET') {
        const { config } = await loadConfig(root)
        const info = await configFileInfo(root)
        return send(res, 200, { config, file: info })
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readBody(req)
        let patch
        try { patch = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
        // strictTools 是客户端「手动点保存白名单」这一条路带的标记，不是设置项：
        // 它在顶层白名单校验之前摘掉，免得被当成「这一版还不支持保存」的键拒掉。
        // 语义：带它 = 用户刚敲完字、坏名字必须当场拦；不带 = 页面自动保存，丢掉坏名字照存。
        const strictTools = patch.strictTools === true
        delete patch.strictTools
        // 白名单：只允许改"环境"，不允许任何指向她本人的键
        // chat/memory 是 2026-10-23 加的：一个是会话轮换阈值，一个是她能背多少字。
        // 两个都不是性格，但必须在这里登记，否则观测台「保存」会被 400 挡回来。
        // bili 是 2026-10-29 补的：0.6.5 给 issue #5 加了「请求间隔 / 请求抖动」两个设置项，
        // 客户端 buildConfig() 每次整表提交都带着它们，白名单却漏登记——于是用户改任何一项
        // 设置都会看到一句「没存上」，而且整张表都没存进去（自动保存是整表提交）。
        // 教训：新增顶层设置项时，settings.js 的 DEFAULTS 和这张白名单必须同时改；
        // test/p5.test.mjs 里有一条防漂移用例，直接从 client.js 的 buildConfig() 反查这张表。
        // persona 不在这里：没有从设置页直接改的入口——那等于给了一个「关掉那两条禁令」的开关。
        // proactive 是 2026-10-30 加的（本机实验，.dev 专属）：她主动开口的频率与概率。
        // channels 是 2026-11-02 加的（合并版）：渠道页签改开关 / 桥地址 / 群白名单走的就是这条路由。
        // 它只装「在哪、开不开、多久一次」，人格键在 settings.js 里就被过滤掉了。
        // pair 是 2026-11-07 加的（m08813）：插件页「两份说好的文件」的开关与两个绝对路径。
        // 它只决定她能不能碰那两份，不是人格键；客户端每次整表提交都带着它。
        const allowed = ['stageSpanDays', 'wakesPerDay', 'window', 'daily', 'diary', 'absenceAfterDays', 'avoid', 'browse', 'bili', 'video', 'chat', 'memory', 'tools', 'pair', 'pet', 'observe', 'ui', 'proactive', 'channels']
        const bad = Object.keys(patch).filter((k) => !allowed.includes(k))
        // 这句话会原样冒到界面上，所以写成人话（界面会把它放在「技术信息」那一行）：
        // 原来那句「不允许修改：bili」既不说人话，也让人以为自己填错了。
        if (bad.length) {
          // 2026-10-29（用户 m02241）：白名单拒收以前不留痕。
          // 自动保存是**整表提交**，只要有一个顶层键没登记，整张表都存不进去，
          // 用户看到一句「没存上」却不知道是谁拖累的。历史上出过「漏登记 bili 组」那次事故。
          logLine('warn', [
            '/config 保存被白名单挡回：',
            `拒了 ${bad.join('、')}`,
            `提交的键 ${Object.keys(patch).join('、')}`,
          ], root)
          return send(res, 400, { error: `这一版还不支持保存：${bad.join('、')}` })
        }
        // 白名单必须真的存在（2026-10-24）：宿主 restrict 遇到不认识的名字会抛错，
        // 整条收窄当场失效、她退回全量工具面。所以坏名字绝不能写进 config。
        //
        // 但「不许写坏名字」不等于「整张表都不许存」（2026-10-31，issue #14 @ming-fish）：
        // 设置页的自动保存是**整表提交**，用户 config.json 里留着一个早就没有的工具名
        // （他那边是裸的 `delete`），于是改任何一个开关都 400，而界面上那句提示还指着
        // 「插件这一版还没接上它」——方向完全错了。
        //
        // 现在分两条路：
        //   · 用户在输入框里敲完点「保存」→ 带 strictTools，坏名字当场 400，得说清打错了；
        //   · 页面自动保存（整表回传盘上的旧名单）→ 丢掉坏名字、其余照常存，把丢掉的回给界面。
        // 「不许把坏名字写进 config」这条底线两条路都守住了：写进去的永远只有干净那份。
        let droppedTools = []
        if (patch.tools && patch.tools.allow !== undefined) {
          if (strictTools) {
            const check = validateToolNames(patch.tools.allow, knownToolNames(ctx))
            if (!check.ok) {
              logLine('warn', ['/config 保存被工具名校验挡回：', `不存在的名字 ${check.unknown.join('、')}`], root)
              return send(res, 400, {
                error: `这些工具名不存在：${check.unknown.join('、')}`,
                unknown: check.unknown,
              })
            }
            patch.tools.allow = check.names
          } else {
            const clean = sanitizeToolNames(patch.tools.allow, knownToolNames(ctx))
            patch.tools.allow = clean.names
            droppedTools = clean.dropped
            if (droppedTools.length) {
              // 留痕：这条以前是静默失败源（一句「没存上」，整表都没进去），现在改成
              // 「丢了名字但其余存下去了」，事后得能查是谁拖累的。
              logLine('warn', [
                '/config 里的工具名在这台机器上不存在，已跳过：',
                droppedTools.join('、'),
                `保留 ${clean.names.length} 个`,
              ], root)
            }
          }
        }
        const before = await loadConfig(root).catch(() => null)
        const next = await updateConfig(patch, root)
        // 桌宠的 idleSleepMin 是运行时参数：保存后当场重判，不用重启（2026-11-08 16:53）。
        petApplyConfig(next)
        // 设置改了，身份文档里按设置现算的那几句（作息、次数）要马上跟着变。
        // 幂等：内容没变就不写，不会因为自动保存每敲一下就重写一份。
        await refreshSelfDoc(root).catch(() => {})
        // 审计：日记可见性每翻一次就落一行，事后查得到是谁、随哪次提交翻的。
        // 2026-10-28 用户反馈「开了『让我看日记』插件又自己关」——光靠猜猜不出来，
        // 至少让下一次发生时日志里有一行可对。
        const wasVisible = before?.config?.diary?.visible === true
        const nowVisible = next?.diary?.visible === true
        if (wasVisible !== nowVisible) {
          logLine('info', [
            'diary.visible',
            wasVisible ? 'on' : 'off',
            '->',
            nowVisible ? 'on' : 'off',
            `by=${Object.keys(patch).join(',')}`,
          ], root)
        }
        return send(res, 200, { ok: true, config: next, droppedTools })
      }
      send(res, 405, { error: 'method not allowed' })
    }],

    // ---- 工具名名单（2026-10-24）----
    // 只给名字不给定义：白名单输入框要能当场判断「这个名字到底存不存在」。
    // ok:false = 宿主这个版本拿不到全局视角，界面退回只做形状校验。
    // 社会层（2026-11-02，用户 m02861）：**只读**。
    // 她能不能开、开没开，只在事件流里；这里只把她现在的样子摆出来，
    // 没有任何「替我开」的按钮——开了就等于主人能把她变成另一种人。
    ['/social', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const { config } = await loadConfig(root)
      const model = deriveSelf(events, { stageSpanDays: config.stageSpanDays })
      const gate = evaluateSocialGate({ model, events })
      const social = model.influence?.social ?? {}
      return send(res, 200, {
        open: gate.open === true,
        at: gate.at ?? '',
        ok: gate.ok === true,
        reason: gate.why ?? '',
        gates: (gate.gates ?? []).map((g) => ({
          label: g.label,
          value: g.value,
          need: g.need,
          ok: g.ok === true,
          why: g.why ?? '',
        })),
        count: social.count ?? 0,
        kept: social.kept ?? 0,
        beliefs: (social.beliefs ?? []).slice(-20),
      })
    }],
    ['/tools', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const known = knownToolNames(ctx)
      // ownLayer：看得见、但 restrict() 点不了名的那些（dsh-ops 的 ops_* 就在这）。
      // 客户端拿它提示「加进白名单只是让守卫放行」，不是「收窄会把她挡住」。
      return send(res, 200, {
        ok: Boolean(known && known.length),
        known: known ?? [],
        ownLayer: ownLayerNames(),
        descriptions: knownToolDescriptions(),
      })
    }],
    // 只给两件事：看规则在哪一层、裁决她提上来的那一张。
    // 没有"新建规则"、没有"编辑规则"——规则不是设置项。
    ['/rules', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const { config } = await loadConfig(root)
      const model = deriveSelf(events, config)
      return send(res, 200, {
        layers: rulesByLayer(),
        status: ruleStatus(events, model, Date.now()),
        history: offerHistory(events).slice(-20),
        pending: (() => {
          const p = pendingOffer(events, Date.now())
          return p ? { id: p.id, rule: p.grant?.rule || '', why: p.text || '' } : null
        })(),
        offersOn: config?.rules?.offers !== false,
      })
    }],

    ['/decide', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req)
      let body
      try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const verdict = body.verdict === 'approve' || body.verdict === 'reject' ? body.verdict : null
      if (!verdict) return send(res, 400, { error: 'verdict 只能是 approve 或 reject' })
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const p = pendingOffer(events, Date.now())
      if (!p) return send(res, 409, { error: '现在没有待裁决的申请' })
      // 0.7.5：写入逻辑搬到 lib/grant.js——会话里的提问卡片也走同一条路，
      // 两个入口必须写同一份事件（两个坑的注释也一起搬过去了）。
      const r = await recordGrant(root, {
        offerId: p.id,
        rule: p.grant?.rule || '',
        verdict,
        reason: typeof body.reason === 'string' ? body.reason : '',
      })
      if (!r.ok) return send(res, 400, { error: r.error })
      return send(res, 200, { ok: true, verdict })
    }],

    ['/owner', async (req, res) => {
      if (req.method === 'GET') {
        const ow = await readOwner(root)
        const { config } = await loadConfig(root)
        return send(res, 200, {
          ...publicOwner(ow),
          hint: COOKIE_HINT,
        })
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req)
        let body
        try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
        if (body.test) {
          // 探一次「这个 cookie 到底能不能说话」：能登录、能看到自己的 mid 与昵称。
          const ow = await readOwner(root)
          if (!ow?.cookie) return send(res, 200, { ok: false, note: '还没存 cookie。' })
          try {
            const c = createClient({ cookie: ow.cookie })
            const me = await c.me()
            if (!me?.isLogin) return send(res, 200, { ok: false, note: '这个 cookie 登不上，可能过期了。' })
            // 2026-10-27：这里只记「这份 cookie 登的是哪个账号」（只读 account），
            // 不再覆盖 mid / nickname —— 那两格是领养人，用户手填的大号。
            // 以前自动填进去，导致拿小号 cookie 时 @ 到小号自己。
            const owner = await saveAccount(me, root)
            return send(res, 200, { ok: true, note: `登上了：${me.uname}（uid ${me.mid}）`, mid: String(me.mid), name: String(me.uname), account: owner.account, canWrite: Boolean(me.canWrite) })
          } catch (err) {
            return send(res, 200, { ok: false, note: `连不上：${String(err?.message ?? err).slice(0, 60)}` })
          }
        }
        const patch = {}
        if (body.mid !== undefined) patch.mid = body.mid
        if (body.nickname !== undefined) patch.nickname = body.nickname
        if (body.cookie !== undefined) patch.cookie = body.cookie
        const r = Object.keys(patch).length ? await saveOwner(patch, root) : { ok: true, note: '存下了。', owner: publicOwner(await readOwner(root)) }
        // 2026-10-27：存了 cookie 就认一次「登的是谁」，只写只读的 account；
        // 领养人那两格（mid / nickname）原样保留，用户填的是要 @ 的大号。
        // 认不出来不影响「cookie 已经存好了」这件事。
        if (r.ok && patch.cookie) {
          try {
            const probe = createClient({ cookie: (await readOwner(root))?.cookie || '' })
            const me = await probe.me()
            if (me?.isLogin && me.uname) {
              const r2 = await saveAccount(me, root)
              if (r2) return send(res, 200, { ...r, owner: r2, note: `${r.note || '存下了。'} 登录的是：${me.uname}（uid ${me.mid}）` })
            }
          } catch { /* 认不出来就算了，cookie 已经存下 */ }
        }
        return send(res, r.ok ? 200 : 400, r)
      }
      send(res, 405, { error: 'method not allowed' })
    }],

    // 扫码登录（2026-11-02，合并版）。
    //   POST /bili/qr        → 要一张新码，回 { key, url, svg }
    //   POST /bili/qr/poll   → 问一次扫没扫；成功就地存 cookie，并认一次登录的是谁
    // 只做「拿凭据」这一件事：存与校验仍走 saveOwner / me()，不另起一套登录态。
    ['/bili/qr', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const tail = String(req.url ?? '').replace(/\?.*$/, '').replace(/^.*\/bili\/qr/, '')
      if (tail === '/poll') {
        const raw = await readBody(req)
        let body = {}
        try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
        const key = String(body.key ?? '').trim()
        if (!key) return send(res, 400, { error: '没有 key' })
        const r = await pollQr(key)
        if (!r.ok) return send(res, 200, { ok: false, status: r.status ?? 'error', note: r.why ?? '没扫成。' })
        if (r.status !== 'ok') return send(res, 200, { ok: true, status: r.status, message: r.message ?? '' })
        // 拿到的就是一条完整 cookie：存下来，再用同一条路探一次「登的是谁」。
        const saved = await saveOwner({ cookie: r.cookie }, root)
        if (!saved?.ok) return send(res, 200, { ok: false, status: 'error', note: saved?.note ?? 'cookie 没存进去。' })
        let name = ''
        let mid = ''
        try {
          const me = await createClient({ cookie: r.cookie }).me()
          if (me?.isLogin) {
            name = String(me.uname ?? '')
            mid = String(me.mid ?? '')
            await saveAccount(me, root)
          }
        } catch { /* 认不出来不影响「已经登上了」 */ }
        return send(res, 200, { ok: true, status: 'ok', name, mid, note: name ? `登上了：${name}` : '登上了。' })
      }
      if (tail && tail !== '/') return send(res, 404, { error: 'not found' })
      const qr = await createQr()
      if (!qr.ok) return send(res, 200, { ok: false, note: qr.why ?? 'B 站没给二维码。' })
      return send(res, 200, { ok: true, key: qr.key, url: qr.url, svg: qr.svg, expiresIn: qr.expiresIn })
    }],

    ['/browse', async (req, res) => {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const dk = dateKey()
      const items = itemsFromEvents(events, dk)
      const used = browseCountToday(events, dk)
      // 2026-10-30 客户反馈：状态窗以前只有 browse: 那一档（"翻到过"），
      // 于是"看过画面"和"只扫了眼标题"在这里长得一模一样。现在三档分开给。
      const seen = seenOn(events, dk)
      // 「看过的全部」这个列表只给 BV 号，不给标题——标题可以去报告里看。
      // 理由：这里是状态窗，报告才是"她今天看了什么"的正式记录，两处别分叉。
      // 2026-11-06（A7「账分两边」）：looked: 后面现在可能挂着 `from:push|pick|feed|search:<词>`。
      // 这里按行解析，只取前面的 id——否则状态窗里会出现「BV1xx from:push」这种半截字符串。
      // 同时按来源记个数：平台递的和她自己找的，从这里开始分开数。
      const lookedAll = []
      const lookedByFrom = {}
      for (const e of events) {
        if (e?.type !== 'meta') continue
        const got = parseLookedLine(e.text)
        if (!got) continue
        lookedAll.push(got.id)
        const k = got.from || 'unknown'
        lookedByFrom[k] = (lookedByFrom[k] ?? 0) + 1
      }
      send(res, 200, {
        enabled: Boolean(config?.browse?.enabled),
        perDay: Number(config?.browse?.perDay ?? 0),
        usedToday: used,
        topN: Number(config?.browse?.topN ?? 0),
        keywords: config?.browse?.keywords ?? [],
        items,
        // 真的抽帧看过画面的（今天）
        watched: seen.watched,
        watchedCount: seen.watched.length,
        // 翻到过但没看画面
        glancedCount: seen.glanced.length,
        // 他递过来、她还没看的
        handed: seen.handed,
        lookedCount: lookedAll.length,
        lookedRecent: lookedAll.slice(-20).reverse(),
        // 按来源分开的条数（unknown＝老行，没记来源）。
        lookedByFrom,
        avoidKeywords: config?.avoid?.keywords ?? [],
        avoidMids: config?.avoid?.upMids ?? [],
        minDuration: Number(config?.avoid?.minDuration ?? 0),
      })
    }],

    // 她看过什么（2026-10-23 用户提：想回她却不知道她看的哪条）。
    // 只读事件流里已有的 browse: 记账，不新增落盘。
    ['/history', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const days = Math.max(1, Math.min(180, Number(url.searchParams.get('days')) || 14))
      const { events } = await readEvents(root)
      const groups = historyFromEvents(events, { days })
      const total = groups.reduce((a, g) => a + g.items.length, 0)
      send(res, 200, { days, total, groups })
    }],

    // 环境自检：它现在到底能不能工作。`?net=0` 跳过联网（不想碰 B 站时用）。
    ['/selfcheck', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const net = url.searchParams.get('net') !== '0'
      const { config } = await loadConfig(root)
      const client = net
        // 2026-10-25 修：readOwner 是 async，原来漏了 await → cookie 永远是空串，
        // 自检的联网检查因此是个「没登录的匿名请求」，风控更容易踩。
        ? createClient({ cookie: (await readOwner(root))?.cookie || '', log: () => {} })
        : null
      // QQ 三项（A30）：连接状态从渠道层现读；桥有没有起只在联网自检时探一次
      // （只做本机 TCP 握手，不碰 QQ 协议）。
      let live = null
      try {
        if (typeof deps.channels?.status === 'function') live = await deps.channels.status()
      } catch { /* 渠道层没起来：自检自己会报「没有状态」 */ }
      const qq = config?.channels?.qq
      const bridge = net && qq?.enabled === true
        ? await detectBridge({ wsUrl: qq?.wsUrl, bridgePath: qq?.bridgePath }).catch(() => null)
        : null
      const r = await runChecks({
        root,
        config,
        channels: live?.channels ?? null,
        bridge,
        host: {
          sessionController: ctx.get?.('sessionController') ?? ctx.sessionController,
          webServer: ctx.get?.('webServer') ?? ctx.webServer,
          connection: ctx.get?.('connection') ?? ctx.connection,
        },
        tools: ctx.get?.('tools') ?? ctx.tools,
        // attachments 服务在不在，决定 read_image 注册得上不上（宿主原文：
        // "read_image registers only while a durable ctx.attachments service is mounted"）。
        // 有 ctx.get 就是权威答案：查不到 = 真没挂 ⇒ false。
        // 没有 ctx.get（假环境/预检）就别猜，传 undefined 让自检说「判不准」。
        attachments: typeof ctx.get === 'function'
          ? Boolean(ctx.get('attachments'))
          : (ctx.attachments ? true : undefined),
        client,
        net,
        preset: presetOf(config),
        sessionPreset: (await homeStatus(root))?.preset ?? '',
        restrict: readRestrictState(),
        restrictEnabled: config?.tools?.restrict !== false,
      })
      send(res, 200, r)
    }],

    // 「你不在的时候」：不推送，只在你回来时告诉你错过了什么。
    ['/away', async (req, res) => {
      send(res, 200, await readAway(root))
    }],

    // 封面图：设置页的历史列表直接 <img src>。跟着状态库走，没有就是 404。
    ['/cover', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-perch\/cover\/(BV[0-9A-Za-z]{10})/)
      if (!m) { send(res, 404, { error: 'no cover' }); return }
      const file = coverPath(root, m[1]) || (await lazyCover(root, m[1]))
      if (!file) { send(res, 404, { error: 'no cover' }); return }
      try {
        const buf = fs.readFileSync(file)
        const ext = file.split('.').pop().toLowerCase()
        const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        res.writeHead(200, {
          'content-type': ct,
          'content-length': buf.length,
          'cache-control': 'private, max-age=86400',
        })
        res.end(buf)
      } catch {
        send(res, 404, { error: 'no cover' })
      }
    }],

    // 头像（2026-10-24）：插件不自带任何图片，谁用谁自己传一张。
    //   GET  /avatar            出图（没有就是 404，客户端自己画空圈）
    //   GET  /avatar/info       元信息 { present, mime, bytes, at }
    //   POST /avatar            { data: base64, mime } 存一张；{ remove: true } 删掉
    ['/avatar', async (req, res) => {
      const url = String(req.url ?? '')
      if (url.startsWith(PREFIX + '/avatar/info')) { send(res, 200, avatarInfo(root)); return }
      if (req.method === 'POST') {
        let body = {}
        try {
          const raw = await readBody(req, 4_000_000)
          body = raw ? JSON.parse(raw) : {}
        } catch { body = {} }
        const r = body && body.remove ? removeAvatar(root) : saveAvatar(root, body)
        if (!r || r.ok === false) { send(res, 400, { error: (r && r.why) || '没存上' }); return }
        send(res, 200, { ok: true, removed: Boolean(r.removed), ...avatarInfo(root) })
        return
      }
      const file = avatarFile(root)
      if (!file) { send(res, 404, { error: 'no avatar' }); return }
      try {
        const buf = fs.readFileSync(file)
        const ext = file.split('.').pop().toLowerCase()
        const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
        res.writeHead(200, { 'content-type': ct, 'content-length': buf.length, 'cache-control': 'no-store' })
        res.end(buf)
      } catch { send(res, 404, { error: 'no avatar' }) }
    }],

    // 静态图（2026-10-25 两张原理图）。
    // 只放白名单文件名，不做通用文件服务——这是插件自己的说明书，不是文件浏览器。
    // 用处：`GET /dsh-perch/media/principle-loop.svg`、`/dsh-perch/media/principle-memory.svg`。
    // 2026-11-06：反馈页撤了交流群二维码，这条路由只出原理图。
    ['/media', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-perch\/media\/((?:principle-[a-z]+\.svg))$/)
      if (!m) { send(res, 404, { error: 'no file' }); return }
      try {
        const file = fileURLToPath(new URL(`../media/${m[1]}`, import.meta.url))
        const buf = fs.readFileSync(file)
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-length': buf.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(buf)
      } catch { send(res, 404, { error: 'no file' }) }
    }],

    // 风控状态：冷却到什么时候、撞过几次。POST {clear:true} 立即解冻。
    ['/risk', async (req, res) => {
      if (req.method === 'POST') {
        let body = {}
        try { body = await readBody(req) } catch { body = {} }
        const cleared = Boolean(body?.clear)
        if (cleared) clearRisk(root)
        send(res, 200, { ...riskState(root), memory: memoryCooldown(), cleared })
        return
      }
      send(res, 200, { ...riskState(root), memory: memoryCooldown() })
    }],

    ['/reports', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const want = String(url.searchParams.get('date') ?? '').trim()
      const dates = await listReports(root)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(want)) {
        return send(res, 200, { dates, date: null, md: '' })
      }
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      // 预览与落盘走同一个 buildReport，避免"界面看到的"和"文件里的"两套逻辑。
      const diary = await readDaily('diaryDir', want, root).catch(() => null)
      const md = buildReport({
        dateKey: want,
        // 和落盘的报告同一份口径（看过画面 / 翻到过 / 递了没看）
        seen: seenOn(events, want),
        events,
        diary,
        diaryVisible: config?.diary?.visible === true,
      })
      send(res, 200, { dates, date: want, md })
    }],

    ['/templates', async (req, res) => {
      const { events } = await readEvents(root)
      const fired = firedLog(events)
      send(res, 200, {
        // once / repeat 一起给出：同一处境能不能回来，是性格能不能长出来的关键之一
        // （2026-10-24 事件复现）。count 是该模板累计出过几次，lastAt 是最后一次的时间戳。
        rows: CATALOG.map((t) => ({
          id: t.id,
          stage: t.stage,
          asks: t.asks,
          once: Boolean(t.once),
          everyDays: Number(t.repeat?.everyDays ?? 0) || null,
          fired: fired.has(t.id),
          count: Number(fired.get(t.id)?.count ?? 0),
          lastAt: fired.get(t.id)?.lastAt ? new Date(fired.get(t.id).lastAt).toISOString() : null,
        })),
      })
    }],

    ['/wake', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      // ?focus=browse：设置页那个「让她去刷 B 站」按钮（仅本机测试版）。
      // 传下去之后 wakeNow 会跳过「今天该不该醒」的判断，只做一件事：叫醒她，并让这一轮
      // 的处境明确指向 B 站首页。
      let focus = ''
      try { focus = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('focus') ?? '' } catch { /* 解析失败就当没传 */ }
      // 点按钮之后日志里以前什么都看不到，分不清「没点」和「点了被挡」（2026-11-03 折腾了四轮）。
      logLine('info', [`叫醒请求 focus=${focus || '(无)'}`], root)
      const r = await wakeNow(ctx, {
        root,
        focus,
        // 手动叫醒这一轮的 deps 是新建的，不接上渠道的话「刷抖音」那条线是空的。
        douyinFeed: douyinFeedOf(deps.channels),
        log: (...a) => console.log('[dsh-perch]', ...a),
      })
      // 失败时补一个 error 字段：前端 jpost 只认得 error，不然界面只会显示「HTTP 409」，
      // 而真正的原因（「今天已经叫过三次了」这类）就在 r.why 里。
      send(res, r.ok ? 200 : 409, r.ok ? r : { ...r, error: r.why || '这次没叫醒' })
    }],

    // ---- P3-1：对话入口 ----
    // 这是唯一一条"你说的话会进到她那里"的路由。POST { text }。
    // 返回她这一轮新写的话（可能一句都没有——允许她不回）。
    ['/say', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      // 带图的请求会大很多（base64 膨胀 4/3），单独给一个更高的上限
      const raw = await readBody(req, 12_000_000)
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是 JSON' }) }
      const text = String(body.text ?? '').trim()

      // 图：落盘成文件，然后只把**路径**递给她（她用 read_image 读）
      // 不走 content block / attachment 体系——那是给附件上传用的，插件侧没有稳定入口；
      // 而 read_image 这条路已实测可用（2026-10-23：她读出一张写着 7 的图并答「七」）。
      let imagePath = ''
      if (body.image) {
        const dec = decodeBase64Image(body.image)
        if (!dec.ok) return send(res, 400, { error: dec.why })
        const saved = await saveImage(root, dec.buf, { prefix: 'him' })
        if (!saved.ok) return send(res, 400, { error: saved.why })
        imagePath = saved.path
      }

      if (!text && !imagePath) return send(res, 400, { error: 'text 不能为空' })
      const r = await sayToHer(ctx, text, { root, imagePath, log: (...a) => console.log('[dsh-perch]', ...a) })
      // 一律 200：请求本身是合法的，被拦下是**规则的结果**，不是接口出错。
      // 用 503 会让观测台的 jpost 抛异常，把「这句我没递给她」变成一句技术错误。
      send(res, 200, r)
    }],

    // ---- P3-2：信箱 ----
    ['/inbox', async (req, res) => {
      if (req.method === 'POST') {
        // 标记已读（读到最新一条）
        const r = await markRead(root)
        await writeInboxFile(root).catch(() => null)
        return send(res, 200, r)
      }
      const url = new URL(req.url, 'http://x')
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200)
      const box = await readInbox(root, { limit })
      // 顺手保证 inbox.md 存在且是最新的（幂等重写，失败不影响接口）
      await writeInboxFile(root, { limit: 60 }).catch(() => null)
      send(res, 200, box)
    }],

    // ---- P3：她住在哪 ----
    // 观测台要知道"她的屋子"建好没有、会话 id 是什么、身份文件多大。
    // 这里**只读**：建屋子是启动时的事，不是按一下按钮就重开一个会话。
    ['/home', async (req, res) => {
      const h = await homeStatus(root)
      const d = await selfDocStatus(root)
      const { config: cfg } = await loadConfig(root)
      // 工作区标题现读、不记在 home.json：用户可能在宿主侧栏自己改名，
      // 记下来的会一直是老名字（2026-10-25 加，用来核对「她的家」真的落上了）。
      let wsTitle = ''
      try {
        const reg = ctx.get?.('workspaceRegistry')
        wsTitle = String(reg?.get?.(h.wsId)?.title ?? '')
      } catch { wsTitle = '' }
      send(res, 200, {
        workspace: { id: h.wsId, ok: Boolean(h.wsId), title: wsTitle },
        // 会话健康（2026-11-06，设计 §四）：轮数、上次换会话、连续没送进去几次。
        session: {
          id: h.sessionId,
          ok: Boolean(h.sessionId),
          turns: h.turns,
          rotateAfter: Number(cfg?.chat?.rotateAfter ?? 0),
          rotatedAt: h.rotatedAt,
          rotatedFrom: h.rotatedFrom,
          status: h.status,
          archivedAt: h.archivedAt,
          failStreak: h.failStreak,
          lastFailAt: h.lastFailAt,
          lastFailWhy: h.lastFailWhy,
        },
        dir: h.dir,
        createdAt: h.createdAt,
        selfDoc: { exists: d.exists, bytes: d.bytes, mtime: d.mtime },
      })
    }],

    // ---- 数据文件夹路径（2026-10-24 加）----
    // 为什么要有这条路由：界面上**不显示任何绝对路径**（用户 m03440），
    // 但「复制路径」按钮还需要真路径，而路径该由服务端现算——
    // 客户端原来自己拼 `${root}\\${name}`，反斜杠是 Windows 假设，换平台就错。
    // 顺手在这里确保数据文件夹根上有一份「说明.md」，跟着备份一起走。
    ['/paths', async (req, res) => {
      const p = paths(root)
      await ensureDataReadme(root)
      send(res, 200, {
        root: p.root,
        events: p.events,
        out: p.outDir,
        diary: p.diaryDir,
        home: p.herDir,
        inbox: join(p.root, 'inbox.md'),
        log: join(p.root, 'logs', 'dsh-perch.log'),
      })
    }],

    // ---- 上下文与记忆（2026-10-23 加）----
    // 只回答「她现在背了多少东西、还能背多少」，全是客观计数，没有分数。
    // 用户要的是能看见"上下文在长"，不是看见一个成长进度条——
    // 后者是 N2 明令禁止的东西，别借"可视化"复活它。
    ['/memory', async (req, res) => {
      // 独立页（2026-11-09）：地址栏直接打开时给 HTML 外壳。
      // settings 页里的 fetch 不带 text/html，仍旧走下面的 JSON，形状不变。
      if (String(req?.headers?.accept ?? '').includes('text/html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(MEMORY_PAGE)
        return
      }
      const { config } = await loadConfig(root)
      const { events } = await readEvents(root)
      const model = deriveSelf(events, { stageSpanDays: config.stageSpanDays })
      const doc = await selfDocStatus(root)
      const h = await homeStatus(root)
      const budget = Number(config?.memory?.docBudget ?? 1800)
      // 用「字」而不是「字节」算用量：中文一个字三字节，按字节算会永远显示撑满。
      // 摆几条判断由配置决定（1–8），身份文档和这里的数字必须同源
      const shownCap = shownCount(config?.memory?.beliefsShown ?? BELIEF_SHOWN)
      // 禁不禁用跟身份文档同源：只看事件流里有没有「导入」那条标记（2026-10-27，用户 m03769），
      // 不看 config——备份/恢复搬回来的 config 不算数。
      const pb = personaBudget(model, { budget, withBans: model?.persona?.imported !== true, shown: shownCap })
      const diary = await listDiary(root).catch(() => [])
      // 2026-10-24：这个数原来写死 8，而身份文档里实际只摆 BELIEF_SHOWN（3）条。
      // 界面说"8 条在眼前"、她只看见 3 条——用户当场问过这个矛盾，现在对齐同一条常量。
      const shown = Math.min(shownCap, model.beliefs.length)
      const folded = Math.max(0, model.beliefs.length - shown)
      const lastSleep = [...events].reverse()
        .find((e) => e?.type === 'meta' && String(e.text ?? '').startsWith('sleep:'))
      send(res, 200, {
        selfDoc: { bytes: doc.bytes, chars: pb.used, budget, usedRatio: pb.usedRatio, dropped: pb.dropped, mtime: doc.mtime },
        // 被预算挤掉的段（她这轮看不见的部分）——如实报，不要假装全都在
        sections: {
          beliefsShown: shown,
          beliefsFolded: folded,
          refuted: model.refuted.length,
          // 「勇于拒绝」：和自主门同一个数（refusal 事件 + 话里明确拒绝，严格口径）。
          // 只报 refusals 会让界面出现「拒绝过 0 却过了自主门」——用户 2026-10-24 指出过。
          refused: model.facts?.refused ?? model.refusals.length,
          refusals: model.refusals.length,
          narrative: model.narrative ? 1 : 0,
          // 2026-10-24：她自己心里对不上的地方 / 已经固化的判断。
          // 给他看的是「有两句话对不上」这件事本身，不是让他去裁决。
          tensions: model.tensions?.length ?? 0,
          tensionFirst: model.tensions?.[0]
            ? { a: model.tensions[0].a.text, b: model.tensions[0].b.text, sim: model.tensions[0].sim }
            : null,
          solid: model.solid?.length ?? 0,
          // 2026-10-24：他的反应归因（接受/坚持/受伤/离开），以及"有后果"的那几种之和。
          // hurts 是第三块"疤"的入口，所以只报事实，不报分数。
          reactions: model.facts?.reactions ?? { accept: 0, insist: 0, hurt: 0, leave: 0, other: 0 },
          hurts: model.facts?.hurts ?? 0,
          // 最近三次拒绝的形状（原话 + 动作 + 对象 + 他的反应）
          refusals: model.refusals.slice(-3).map((r) => ({
            at: r.at, quote: r.quote ?? r.what, act: r.act ?? '', object: r.object ?? '', reaction: r.reaction ?? null,
          })),
          // 疤（P1 第三块）：没想通的有几件，以及第一件的原话。
          // 页面只显示数量与原话，不显示"该不该退让"——那是她的判断，不是系统的判断。
          scars: model.scars?.length ?? 0,
          scarsResolved: model.facts?.scarsResolved ?? 0,
          scarFirst: model.scars?.[0]
            ? { at: model.scars[0].at, quote: model.scars[0].quote, reaction: model.scars[0].reaction, conceded: model.scars[0].concedeText ?? null }
            : null,
          // 评论区里别人的话（2026-10-24，用户 m02454）：读到几条、几条被她认下。
          // 「认下」= 三天内她自己说过一句意思相近的；那条话本身已经是一条判断，不进这里。
          voices: model.facts?.voices ?? 0,
          voicesEchoed: model.facts?.voicesEchoed ?? 0,
          voiceLast: model.voices?.length
            ? {
                at: model.voices[model.voices.length - 1].at,
                text: model.voices[model.voices.length - 1].text,
                echoed: Boolean(model.voices[model.voices.length - 1].echoed),
              }
            : null,
          // 立场清单（2026-10-25，用户设计「纵向·立场」）。
          // 四道门走完才可能非零；没走完就是 0，不是"没长出来"，是"还没走到"。
          ...stanceSummary(buildStances(model)),
        },
        events: events.length,
        diaries: diary.length,
        session: { turns: h.turns, rotateAfter: Number(config?.chat?.rotateAfter ?? 0), rotatedAt: h.rotatedAt },
        sleep: {
          everyDays: Number(config?.memory?.sleepEveryDays ?? 0),
          last: lastSleep ? String(lastSleep.text).slice(6, 16) : '',
        },
        recall: { days: 30, limit: 5 },
      })
    }],

    // ---- 记忆体检（0.7.6，2026-10-30 用户 m00342）----
    // 只读：拿账本按现在的规则算一遍，不写事件、不改配置。
    // 故意不做成「她自己的自我评估」：她看不到这些数，撞不到「不读自身数值」。
    ['/health', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只接受 GET' })
      const { config } = await loadConfig(root)
      const { events } = await readEvents(root)
      send(res, 200, examine(events, { stageSpanDays: config?.stageSpanDays }))
    }],


    // ---- 运行日志导出（2026-10-24）----
    // 用户点名要「运行日志导出」。它的价值不在"能看到日志"，而在**出事之后能拿到现场**：
    // 她某晚没说话、没刷站、没写日记，只看设置页是猜不出来的。
    // 三条路由刻意分开：预览（小）、导出（大、纯文本、给 AI 看）、清空（单独一次点击）。
    ['/log', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' })
      const url = new URL(req.url, 'http://x')
      const lines = Math.max(10, Math.min(500, Number(url.searchParams.get('lines') ?? 60) || 60))
      const tail = tailLog(root, { lines })
      return send(res, 200, {
        ...tail,
        dir: logsDir(root),
        maxBytes: LOG_MAX_BYTES,
        keep: LOG_KEEP,
      })
    }],

    ['/log/export', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' })
      const url = new URL(req.url, 'http://x')
      const lines = Math.max(50, Math.min(2000, Number(url.searchParams.get('lines') ?? 300) || 300))
      // 自检要按「真宿主」跑：不传 config 与 host 的话，导出里会假报
      // 「宿主接口缺失」「没有时段配置」——那会让看日志的人按错误线索排查。
      const { config } = await loadConfig(root).catch(() => ({ config: null }))
      let checks = null
      let live = null
      try {
        if (typeof deps.channels?.status === 'function') live = await deps.channels.status()
      } catch { /* 导出不许因为渠道层没起来而失败 */ }
      try {
        checks = await runChecks({
          root,
          config,
          channels: live?.channels ?? null,
          host: {
            sessionController: ctx.get?.('sessionController') ?? ctx.sessionController,
            webServer: ctx.get?.('webServer') ?? ctx.webServer,
            connection: ctx.get?.('connection') ?? ctx.connection,
          },
          tools: ctx.get?.('tools') ?? ctx.tools,
          net: false,
          now: new Date(),
          preset: presetOf(config),
          sessionPreset: (await homeStatus(root))?.preset ?? '',
          restrict: readRestrictState(),
          restrictEnabled: config?.tools?.restrict !== false,
        })
      } catch (err) {
        checks = { summary: `自检跑不动：${String(err?.message ?? err)}`, items: [] }
      }
      // 「她看不见画面」有一半原因在模型本身：模型不吃图，采到帧也白搭。
      // 这一行以前完全没有，导出包里查不出来，所以单独探一次（只读、失败不影响导出）。
      let model = null
      try {
        const h = await homeStatus(root)
        model = await resolveHerModel(ctx, h?.sessionId)
      } catch (err) {
        model = { provider: '', model: '', imageInput: null, why: `读不到：${String(err?.message ?? err)}` }
      }
      const text = buildBundle(root, {
        checks,
        version: deps.version ?? '',
        restrict: readRestrictState(),
        config: redactConfig(config),
        model,
        lines,
      })
      // 纯文本直出，不套 JSON：这个接口的产物是给人（和别的 AI）读的，不是给程序解析的。
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="dsh-perch-log-${dateKey()}.txt"`,
      })
      res.end(text)
    }],

    ['/log/clear', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: '只支持 POST' })
      const r = clearLog(root)
      logLine('info', ['日志被手动清空（来自设置页）'], root)
      return send(res, 200, r)
    }],

    // ---- 迁移工作区（2026-10-28，用户 m06510）----
    // GET  → 现在住哪、有多少东西、能不能立刻搬（给按钮旁的说明用）
    // POST { target } → 搬到 target 里（新位置 = <target>\dsh-perch，除非那里已经是一份档）
    // 语义是「复制 + 验字节 + 写指针 + 旧目录改名封存」，见 lib/move.js 头注释。
    // **重启 DSH 才生效**：root 是在 apply() 里算一次的东西。
    ['/move', async (req, res) => {
      if (req.method === 'GET') {
        const st = await moveStatus(root)
        return send(res, 200, { ...st, canPick: true })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req, 20_000)
      let b = null
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const r = await moveRoot(ctx, { root, target: b.target, log: (m) => logLine('info', [m], root) })
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      send(res, 200, r)
    }],

    // ---- P4：把她放回第一天 ----
    // GET  → 将要封存什么（给确认框用）；POST { confirm: 'reset' } → 改名封存 + 重开。
    // 必须带 confirm 字面量：这不是一个能误触的按钮。
    // ---- 备份与恢复（2026-10-25，发布体检第 2 项）----
    // 为什么是单文件 json 而不是 zip：不引依赖，双击能看，能直接发出去。
    // 恢复的语义是「先封存再放回」（见 lib/backup.js 的头注释），不是覆盖删除。
    ['/backup', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const b = await collectBackup(root)
      // fileName 给浏览器当下载名；它在 checkBundle 里是多余字段，恢复时会被忽略。
      send(res, 200, { ...b, fileName: backupFileName() })
    }],

    ['/backup/restore', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req, 96_000_000)
      let b = null
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const r = await restoreBackup(b, root)
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      send(res, 200, {
        ok: true,
        restored: r.restored,
        quarantined: r.quarantined,
        note: '重启 DSH 之后她才是这份档的样子。',
      })
    }],

    ['/ask', async (req, res) => {
      if (req.method === 'GET') {
        const { events } = await readEvents(root)
        return send(res, 200, {
          ok: true,
          kinds: ASK_KINDS,
          quota: quotaOf(events),
          pending: pendingAsks(events).map((e) => ({
            id: e.id,
            ts: e.ts,
            kind: String(e?.ask?.kind ?? ''),
            subject: String(e?.ask?.subject ?? ''),
            question: String(e.text ?? ''),
            options: Array.isArray(e?.ask?.options) ? e.ask.options : [],
          })),
          items: askView(events),
        })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.action !== 'answer') return send(res, 400, { error: 'action 只能是 answer' })
      const r = await settleAsk(root, {
        askId: b.askId,
        verdict: b.verdict,
        reason: b.reason,
        via: 'ui',
      })
      if (!r.ok) return send(res, 409, { ok: false, why: r.why })
      logLine('info', ['请求事件：回答', String(b.askId || ''), String(b.verdict || '')], root)
      return send(res, 200, { ok: true })
    }],

    ['/reset', async (req, res) => {
      if (req.method === 'GET') {
        const info = await describeState(root)
        return send(res, 200, { ...info, root })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.confirm !== 'reset') return send(res, 400, { error: '要带 confirm:"reset"' })
      // 2026-10-25 修：resetAll 只搬 ~/.dsh-perch，宿主侧的工作区/会话记录在
      // ~/.dsh/storages/workspace.json 里，不跟着状态库走 —— 所以先记下 home.json
      // （resetAll 之后它就被搬走了），重置成功再把旧会话归档。
      const home = await readHomeRecord(root)
      const r = await resetAll(root)
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      const retired = await retireHomeSessions(ctx, { root, home, log: (m) => console.log('[dsh-perch]', m) })
      // 2026-10-26 修（用户 m00260）：重置只搬状态库 + 归档旧会话，**不会**建新会话——
      // 新建发生在 bootstrapHome，而它只在 DSH 启动时跑。于是「点了重置 → 侧栏空着 →
      // 不知道去哪儿说话」。这里重置完立刻把新的一局开出来，不用等下次启动。
      const { config: cfg } = await loadConfig(root)
      const fresh = await bootstrapHome(ctx, {
        root,
        preset: presetOf(cfg),
        log: (m) => console.log('[dsh-perch]', m),
        // 重置流程本来就是「我要一局新的」：旧会话已经被 retire 归档，
        // 归档态默认不重建（0.6.8），所以这里必须明说要。
        force: true,
      })
      // 空白会话在侧栏里是隐形的（宿主 sessionVisible：blank && id !== current → false）。
      // 插件用 API 建的会话不会被设成当前会话，所以要让她先动一轮，侧栏才看得见。
      const woke = fresh.ok
        ? await wakeIfBlank(ctx, { sessionId: fresh.sessionId, root, log: (m) => console.log('[dsh-perch]', m), freshOnly: !fresh.reused })
        : { woke: false }
      send(res, 200, {
        ok: true,
        movedTo: r.movedTo,
        archived: retired.archived,
        retiredError: retired.ok ? '' : retired.why,
        fresh: fresh.ok ? { wsId: fresh.wsId, sessionId: fresh.sessionId, title: fresh.reused ? '' : '跟她说话', woke: woke.woke === true } : null,
        freshError: fresh.ok ? '' : fresh.why,
        note: fresh.ok
          ? (retired.ok
            ? '旧的一切已经封存，旧会话移进「已归档」。新的一局已经开好；点一下「叫醒她」，侧栏里才会出现那条会话。'
            : '状态库已封存，新的一局也开好了；只有旧会话没全收进「已归档」。点一下「叫醒她」，侧栏里才会出现会话。')
          : '状态库已封存，但新会话没建出来（重启 DSH 会自动建）。',
      })
    }],

    // 重新搭一間（0.6.8）：会话被归档之后插件不再自动重建（见 home.js 的判据），
    // 所以必须有一个明说的入口，否则「收起来」等于「永远回不去」。
    // 只建新会话，**不搬状态库**——那件事归 /reset。
    ['/home/rebuild', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.confirm !== 'rebuild') return send(res, 400, { error: '要带 confirm:"rebuild"' })
      const { config: cfg } = await loadConfig(root)
      const fresh = await bootstrapHome(ctx, {
        root,
        preset: presetOf(cfg),
        log: (m) => console.log('[dsh-perch]', m),
        force: true,
      })
      const woke = fresh.ok
        ? await wakeIfBlank(ctx, { sessionId: fresh.sessionId, root, log: (m) => console.log('[dsh-perch]', m), freshOnly: !fresh.reused })
        : { woke: false }
      send(res, fresh.ok ? 200 : 409, {
        ok: fresh.ok,
        sessionId: fresh.sessionId ?? '',
        wasArchived: fresh.wasArchived === true,
        woke: woke.woke === true,
        error: fresh.ok ? '' : fresh.why,
        note: fresh.ok
          ? '新的一局搭好了。点一下「叫醒她」，侧栏里才会出现这条会话。'
          : fresh.why,
      })
    }],

    // ---- 换一条会话（2026-11-06，设计 §四「会话健康」）----
    // 和 /home/rebuild 的区别：rebuild 是「屋子没了，重搭」；rotate 是
    // 「屋子还在，这条聊不动了」——旧会话改名留档，原话搬几句过去。
    ['/home/rotate', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.confirm !== 'rotate') return send(res, 400, { error: '要带 confirm:"rotate"' })
      const h = await homeStatus(root)
      const rot = await rotateTalkSession(
        ctx.get?.('sessionController') ?? ctx.sessionController,
        { root, wsId: h.wsId, log: (m) => console.log('[dsh-perch]', m) },
      )
      send(res, rot.ok ? 200 : 409, {
        ok: rot.ok,
        sessionId: rot.sessionId ?? '',
        old: rot.old ?? '',
        error: rot.ok ? '' : (rot.why ?? '没换成'),
      })
    }],

    // 常见问题解答（2026-10-28 用户要求）：设置 → 反馈页的按钮 → 就地展开一个
    // 可滚动面板，正文在 lib/faq.js。
    //
    // 为什么不是新窗口（用户 m00416「点了没有反应」的根因）：
    //   宿主 connection 的信任栅栏要的是 App 内置登录 cookie，**浏览器地址栏直接
    //   敲这个路径只会拿到 403**（observe.js 底部 PAGE 那段注释记的是同一条链：
    //   requestRejection → admit → browserAuth.isAuthenticated）。所以 `target=_blank`
    //   打开的新标签页注定是一片 forbidden，看起来就像「点了没反应」。
    //   改成就地展开：同源请求天然带着 cookie，不依赖任何窗口策略。
    ['/faq.data', async (req, res) => {
      const body = JSON.stringify({ ok: true, title: FAQ_TITLE, items: FAQ })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    }],

    // 整页版本仍然保留：给「在 App 内部用新窗口打开」留一条路，也方便调试。
    ['/faq', async (req, res) => {
      const html = renderFaqPage()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
      })
      res.end(html)
    }],

    // ---- 渠道面板：她在外面说过话的地方，以及她现在认得谁 ----
    // 只有一处写操作：`POST /channels/send` 代发（2026-11-02）。
    // 代发是**主人以自己的名义**说话，不经过她、不写事件流——她的记忆里不该多出一句她没说过的话。
    // 印象怎么变是她的事，主人只能看。面板也不许出现任何「她应该是什么样」的输入框——那条线在 AGENTS.md 里。
    ['/channels', async (req, res) => {
      // 代发：和读面板共用一个前缀路由，所以先按 method + 路径尾巴分流。
      if (req.method === 'POST') {
        const path = String(req.url ?? '').split('?')[0]
        // A29：主人 id 按渠道存进 owner.json（0600），不再写 config。
        // 设置页的「主人的 QQ 号」走这一条；其它渠道以后各自一条，互不覆盖。
        if (/\/owner\/?$/.test(path)) {
          let body
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
          const r = await saveChannelOwner(String(body?.channel ?? ''), body?.id, root)
          return send(res, r.ok ? 200 : 400, r)
        }
        // 测一下桥通不通（2026-11-02）：只做 TCP 握手，不握手协议、不发消息。
        if (/\/ping\/?$/.test(path)) {
          let body
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
          const channel = String(body?.channel ?? '').trim()
          if (channel === 'qq') {
            const { config } = await loadConfig(root)
            const raw = String(config?.channels?.qq?.wsUrl || 'ws://127.0.0.1:3001')
            let u
            try { u = new URL(raw) } catch { return send(res, 200, { ok: false, note: '这个地址不是合法的 ws:// 地址。' }) }
            const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80))
            const r = await probeTcp(u.hostname, port, 3000)
            return send(res, 200, r.ok
              ? { ok: true, note: `${u.hostname}:${port} 通了。桥在跑；接下来看它认不认令牌。` }
              : { ok: false, note: `${u.hostname}:${port} 连不上（${r.why}）。先确认 SnowLuma 已经起来、WS 正向端口开的就是这个。` })
          }
          if (channel === 'douyin') {
            const { config } = await loadConfig(root)
            const p = String(config?.channels?.douyin?.browserPath || '').trim()
            if (!p) return send(res, 200, { ok: true, note: '没填路径：启动时会自己去找 Edge / Chrome。' })
            return send(res, 200, fs.existsSync(p)
              ? { ok: true, note: '这个路径存在。' }
              : { ok: false, note: '这个路径不存在。留空让插件自己找更省事。' })
          }
          if (channel === 'bili') {
            const ow = await readOwner(root)
            if (!ow?.cookie) return send(res, 200, { ok: false, note: '还没登录。点上面的「扫码登录」。' })
            try {
              const me = await createClient({ cookie: ow.cookie }).me()
              return send(res, 200, me?.isLogin
                ? { ok: true, note: `登录有效：${me.uname}（uid ${me.mid}）` }
                : { ok: false, note: '这份登录已经失效了，重新扫码。' })
            } catch (err) {
              return send(res, 200, { ok: false, note: `连不上 B 站：${String(err?.message ?? err).slice(0, 60)}` })
            }
          }
          return send(res, 400, { error: '不认识的渠道' })
        }
        // QQ 桥的「起没起 / 拉起来」：只读配置 + spawn 用户自己填的那一个程序，不碰协议。
        if (/\/bridge\/?$/.test(path)) {
          let body
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
          const { config } = await loadConfig(root)
          const qq = config?.channels?.qq ?? {}
          if (String(body?.action ?? '') === 'start') {
            const r = await startBridge(qq?.bridgePath)
            return send(res, 200, r)
          }
          const st = await detectBridge({ wsUrl: qq?.wsUrl, bridgePath: qq?.bridgePath })
          return send(res, 200, st)
        }
        if (!/\/send\/?$/.test(path)) return send(res, 404, { error: '没有这个接口' })
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return send(res, 400, { error: 'body 不是合法 JSON' })
        }
        const channel = String(body?.channel ?? '').trim()
        const conversationId = String(body?.conversationId ?? '').trim()
        const text = String(body?.text ?? '')
        if (!channel || !conversationId) return send(res, 400, { error: '缺 channel 或 conversationId' })
        if (!text.trim()) return send(res, 400, { error: '话是空的' })
        if (text.length > 1000) return send(res, 400, { error: '一次最多 1000 字' })
        if (typeof deps.channels?.sendAs !== 'function') return send(res, 400, { error: '渠道层没有起来' })
        const r = await deps.channels
          .sendAs({
            channel,
            kind: body?.kind === 'group' ? 'group' : 'private',
            conversationId,
            conversationName: String(body?.conversationName ?? ''),
            text,
          })
          .catch((err) => ({ ok: false, why: String(err?.message ?? err).slice(0, 160) }))
        if (!r?.ok) return send(res, 400, { error: r?.why || '没发出去' })
        return send(res, 200, { ok: true })
      }

      const { config } = await loadConfig(root)
      // 主人 id 的真相在 owner.json；不在 config 里回吐。
      const owners = await readOwner(root).then((ow) => channelOwnerIds(ow, config?.channels)).catch(() => ({}))
      let live = { ok: false, channels: [], notes: [], why: '渠道层没有起来（可能一个都没开）' }
      try {
        if (typeof deps.channels?.status === 'function') live = await deps.channels.status()
      } catch (err) {
        live = { ok: false, channels: [], notes: [], why: String(err?.message ?? err).slice(0, 160) }
      }
      let people = []
      let threads = []
      try {
        const all = await createPeople(root).list({ limit: 200 })
        people = all.map((p) => ({
          id: p.id,
          name: p.name ?? '',
          impression: p.impression ?? '',
          count: p.count ?? 0,
          channels: Array.isArray(p.channels) ? p.channels : [],
          last: p.last ?? 0,
        }))
      } catch { /* 文件坏了不该让面板 500：空列表比报错有用 */ }
      try {
        threads = await createJournal(root).threads({ limit: 100 })
      } catch { /* 同上 */ }
      send(res, 200, {
        ok: live.ok === true,
        why: live.why ?? '',
        channels: live.channels ?? [],
        notes: live.notes ?? [],
        settings: config?.channels ?? {},
        owners,
        people,
        threads,
        gate: ['channel-off', 'group-reply-off', 'group-not-allowed', 'group-not-mentioned', 'stage-too-early', 'quiet-hours', 'peak-hours', 'cooldown', 'rate-limited', 'daily-limit', 'auto-silent']
          .map((why) => ({ why, text: explain(why) })),
      })
    }],

    // ---- 世界书（2026-11-02）：她能查的「事实册子」 ----
    // 这里能导入、能删，但**没有一处能改「她是谁」**——世界书是知识，不是人格（AGENTS.md §2）。
    // 导入认 SillyTavern 的两种格式；认不出的条目丢掉，并回报丢了几条。
    ['/worldbook', async (req, res) => {
      const wb = createWorldbook(root)
      const path = String(req.url ?? '').split('?')[0]
      try {
        if (req.method === 'GET') {
          send(res, 200, { ok: true, entries: await wb.list(), stats: await wb.stats() })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: 'method not allowed' })
          return
        }
        let body = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          send(res, 400, { error: 'body 不是合法 JSON' })
          return
        }
        if (/\/clear\/?$/.test(path)) {
          await wb.clear()
          send(res, 200, { ok: true, stats: await wb.stats() })
          return
        }
        if (/\/remove\/?$/.test(path)) {
          const id = String(body?.id ?? '').trim()
          if (!id) {
            send(res, 400, { error: '缺 id' })
            return
          }
          await wb.remove(id)
          send(res, 200, { ok: true, stats: await wb.stats() })
          return
        }
        if (/\/add\/?$/.test(path)) {
          const keys = String(body?.keys ?? '').trim()
          const text = String(body?.text ?? '').trim()
          if (!keys || !text) {
            send(res, 400, { error: '触发词和内容都要填' })
            return
          }
          const out = await wb.add([{ keys, text }])
          send(res, 200, { ok: true, ...out, stats: await wb.stats() })
          return
        }
        if (/\/import\/?$/.test(path)) {
          const r = importLorebook(body?.data ?? body)
          if (!r.ok) {
            send(res, 400, { error: r.why })
            return
          }
          const out = body?.mode === 'replace' ? await wb.replace(r.entries) : await wb.add(r.entries)
          send(res, 200, { ok: true, imported: r.entries.length, skipped: r.skipped, ...out, stats: await wb.stats() })
          return
        }
        send(res, 404, { error: '没有这个接口' })
      } catch (err) {
        send(res, 500, { error: String(err?.message ?? err).slice(0, 160) })
      }
    }],

    // ---- 记忆图谱的数据（2026-11-09，图谱 v2）----
    // 独立页 /dsh-perch/memory 只读这一个接口：节点是她说过的判断、改过口的旧句、
    // 被推翻的旧句和留下的疤；硬边分「被推翻」与「对不上」两类，相近边由页面按
    // 二元组重合度自己算。只读、不写盘、不带任何秘密；页面本身不含数据，接口是 JSON。
    ['/api/memory', async (req, res) => {
      const { config } = await loadConfig(root)
      const { events } = await readEvents(root)
      const model = deriveSelf(events, { stageSpanDays: config?.stageSpanDays })
      const beliefs = Array.isArray(model?.beliefs) ? model.beliefs : []
      const usable = events.filter((e) => e && e.influence !== 'none')
      const evById = new Map()
      for (const e of usable) if (e.id) evById.set(String(e.id), e)

      const nodes = []
      const seen = new Set()
      const add = (node) => {
        const id = String(node?.id ?? '')
        if (!id || seen.has(id)) return false
        seen.add(id)
        nodes.push({ ...node, id })
        return true
      }

      // 还在生效的判断。deriveSelf 的 beliefs 只含 status=active 的那些，
      // 所以这里补上 mentions（被重复提起几次，含自己那次）。
      for (const b of beliefs) {
        add({
          id: b?.id,
          kind: 'belief',
          text: String(b?.text ?? '').slice(0, 140),
          at: b?.since ?? '',
          conf: Number(b?.confidence ?? 0.5),
          status: 'active',
          mentions: Math.max(0, Number(b?.mentions) || 0),
        })
      }

      // 疤：没想通的那几次拒绝。它不是判断，没有改口/推翻，mentions 记 0。
      for (const s of (Array.isArray(model?.scars) ? model.scars : [])) {
        add({
          id: s?.id,
          kind: 'scar',
          text: String(s?.quote ?? s?.what ?? '').slice(0, 140),
          at: s?.at ?? '',
          conf: 0.5,
          status: 'active',
          mentions: 0,
        })
      }

      // 改过口 / 被推翻的旧句不在 model.beliefs 里（deriveSelf 只把 active 的排序暴露出来），
      // 但 revise 事件里还留着 refs 和 verdict。按事件顺序记最后一次状态，再补成节点。
      const revised = new Map()
      for (const e of usable) {
        if (e.type !== 'revise') continue
        const status = e.verdict === 'refuted' ? 'refuted' : 'refined'
        for (const raw of (Array.isArray(e.refs) ? e.refs : [])) {
          const id = String(raw ?? '')
          if (id) revised.set(id, { status, at: e.ts ?? '' })
        }
      }
      const refutedText = new Map()
      for (const r of (Array.isArray(model?.refuted) ? model.refuted : [])) {
        const id = String(r?.oldId ?? '')
        if (id) refutedText.set(id, r?.oldText ?? '')
      }
      for (const [id, r] of revised) {
        if (seen.has(id)) continue
        const old = evById.get(id)
        add({
          id,
          kind: 'belief',
          text: String(refutedText.get(id) ?? old?.text ?? '').slice(0, 140),
          at: old?.ts ?? r.at ?? '',
          conf: 0.5,
          status: r.status,
          mentions: 0,
        })
      }

      // 被推翻的边：oldId 来自 model.refuted；新句是这次 revise 事件自己（新的 id 就是事件 id）。
      const edges = []
      const edgeKey = new Set()
      const pushEdge = (s, t, kind, w) => {
        if (!seen.has(s) || !seen.has(t)) return
        const k = s + '\u0000' + t + '\u0000' + kind
        if (edgeKey.has(k)) return
        edgeKey.add(k)
        edges.push({ s, t, kind, w })
      }
      for (const r of (Array.isArray(model?.refuted) ? model.refuted : [])) {
        const oldId = String(r?.oldId ?? '')
        if (!oldId) continue
        let newId = ''
        const rev = usable.find((e) => e.type === 'revise' && e.ts === r.at
          && Array.isArray(e.refs) && e.refs.map(String).includes(oldId))
        if (rev?.id) newId = String(rev.id)
        if (!newId) {
          const nb = beliefs.find((b) => String(b?.text ?? '') === String(r?.newText ?? '')
            && String(b?.since ?? '') === String(r?.at ?? ''))
          if (nb?.id) newId = String(nb.id)
        }
        if (newId) pushEdge(oldId, newId, 'refuted', 1)
      }

      // 对不上的边：deriveSelf 的 tensions，仍然只连还在生效的判断。
      for (const t of (Array.isArray(model?.tensions) ? model.tensions : [])) {
        const a = String(t?.a?.id ?? '')
        const b = String(t?.b?.id ?? '')
        if (a && b) pushEdge(a, b, 'tension', Number(t?.sim) || 0)
      }

      const count = (status) => nodes.filter((n) => n.status === status).length
      send(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        stage: model?.stage ?? null,
        stageName: model?.stageName ?? '',
        events: events.length,
        stats: {
          beliefs: beliefs.length,
          scars: nodes.filter((n) => n.kind === 'scar').length,
          refuted: count('refuted'),
          refined: count('refined'),
          tension: edges.filter((e) => e.kind === 'tension').length,
          hard: edges.filter((e) => e.kind === 'tension').length,
        },
        nodes,
        edges,
      })
    }],

    ['/', async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
    }],
  ]

  const webServer = safeGet(ctx, 'webServer')
  if (!webServer?.register) return { dispose() {} }

  // 独立页要能在浏览器地址栏直接打开：'/memory' 只放行 Accept: text/html 的那一次，
  // 同一个地址的 JSON 查询仍旧要过信任栅栏；'/api/memory' 是页面自己 fetch 的只读 JSON
  // （同源、不设 CORS 头，别的站点拿不到正文）。
  const openPage = (p, h) => async (req, res) => {
    if (p === '/api/memory') return h(req, res)
    if (p === '/memory' && String(req?.headers?.accept ?? '').includes('text/html')) return h(req, res)
    return guarded(h)(req, res)
  }
  for (const [p, h] of routes) {
    const handler = openPage(p, h)
    const ex = p === '/' ? { kind: 'exact', path: PREFIX, handler } : { kind: 'prefix', path: PREFIX + p, handler }
    try {
      const d = webServer.register(ex)
      if (typeof d === 'function') disposers.push(d)
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
    } catch (err) {
      console.warn('[dsh-perch] 路由注册失败', p, err?.message ?? err)
    }
  }

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}

/**
 * 把一条已经存在的会话恢复成活的 agent（0.6.27，用户 m03372）。
 *
 * 为什么不用 `sc.resume`：真机上 `sessionController` 是带 `@Remote` 装饰的服务，
 * 暴露面只有 list/search/create/selectModel/modelCatalog/rename/fork/prompt/
 * attachment/updateQueue/cancel/page/follow/projections/control，**没有 resume**；
 * 0.6.26 直接调它，每次都 500「宿主没有 sessionController.resume」。
 * 正确入口 `resolveAgent(sessionId)` 内部 resolve → resume，并发恢复会去重，
 * 返回 `{ agent }`，失败返回 `{ error }`（session/not-found、session/writer-held…）。
 */
export async function resolveSessionAgent(sc, sessionId) {
  const got = typeof sc?.resolveAgent === 'function'
    ? await sc.resolveAgent(sessionId)
    : (typeof sc?.agents?.resolveAgent === 'function' ? await sc.agents.resolveAgent(sessionId) : null)
  if (got === null) throw new Error('宿主没有 sessionController.resolveAgent，接不回上次那条会话')
  if (got?.error) throw got.error
  if (!got?.agent) throw new Error('宿主说恢复好了，但没把那条会话的 agent 交出来')
  return got.agent
}

function safeGet(ctx, key) {
  try { return ctx.get(key) } catch { return null }
}

function send(res, code, obj) {
  if (res.writableEnded) return
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 读请求体。
 *
 * ⚠️ 2026-10-23 修：原实现是 `data += chunk`。
 * chunk 是 Buffer，`+=` 会对**每个 chunk 单独**调一次 toString（默认 utf8），
 * 于是一个汉字被 TCP 从中间切开时，两半各自解成替换符 `\uFFFD`，拼不回来。
 * 她的提示词有好几 KB（人设身份段 + 你说的话），必然被切成多个 chunk，
 * 你说的话就夹在里面 —— 所以真机上她收到的是一串 `\ufffd`，回了句「传过来的字是碎的」。
 * 正确做法：收 Buffer 数组，最后 Buffer.concat().toString('utf8') 一次性解码，
 * 跨 chunk 切断的多字节序列这样才拼得回来。
 */
function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return }
      chunks.push(b)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (looksMojibake(text)) {
        const err = new Error('正文不是 UTF-8，没递给她')
        err.statusCode = 400
        return reject(err)
      }
      resolve(text)
    })
    req.on('error', reject)
  })
}

/**
 * 独立页面的替代品。
 *
 * 历史（2026-10-22）：这里原本有一份 ~120 行的单页观测台（PAGE 常量），
 * 但它**实际上永远打不开** —— connection 的信任栅栏要的是 App 内置的登录 cookie，
 * 在浏览器地址栏直接敲 /dsh-perch 只会拿到 401（已从 app.asar 里的
 * `requestRejection` → `admit` → `browserAuth.isAuthenticated` 链路确认）。
 *
 * 真正的观测台现在在 `lib/client.js`（settings.section）：在 App 里打开「设置 → 鱼」，
 * 那里是同源请求，cookie 天然带着。这条路由保留只为了让走错门的浏览器拿到一句说明，
 * 而不是一句 401。
 */
const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>鱼 · 观测台搬进 App 了</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#d7dde5;',
  '  font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  '.box{max-width:540px;padding:26px 30px;border:1px solid #262d36;border-radius:12px;background:#12161c}',
  'h1{font-size:16px;margin:0 0 12px;font-weight:600}',
  'p{margin:9px 0;color:#9aa4b2;font-size:13px;line-height:1.75}',
  'code{background:#1b212a;border:1px solid #262d36;border-radius:5px;padding:1px 6px;font-size:12px;color:#d7dde5}',
  '</style></head>',
  '<body><div class="box">',
  '  <h1>观测台搬进 App 里了</h1>',
  '  <p>这一页只能从 App 内部打开 —— 在浏览器里直接访问会被登录栅栏拦下。这是设计如此，不是坏了。</p>',
  '  <p>请到 <code>设置 → 鱼</code>：她的状态、她自己说过的话、日记、生长环境，都在那里。</p>',
  '  <p>她的数据仍然全部在 <code>~/.dsh-perch</code>，可以直接看文件。</p>',
  '</div></body></html>',
].join('\n')
