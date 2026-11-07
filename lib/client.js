/**
 * client.js —— 观测台的浏览器半边（DSH「设置 → 鱼」里的一节）
 *
 * 为什么要有这一半（2026-10-22 定案）：
 *   宿主那半边 `observe.js` 注册的 `/dsh-roost/*` 路由是 JSON API，但**没有一个能点开的页面**——
 *   在浏览器里直接输 `/dsh-roost` 会被 connection 的信任栅栏挡成 401（它要的是 App 内的登录 cookie）。
 *   而 whale 的实证说明：**在 App 内部**（设置页里）同源 fetch 这些路由是通的，cookie 天然带着。
 *   所以观测台的正确形态是 settings.section，不是一个独立 HTML 页面。
 *
 * 数据流：section ⇄ 同源 fetch `/dsh-roost/*` ⇄ `~/.dsh-roost/`
 *   这里**只读 + 改环境**（时间窗、配额、日记可见性、冷落阈值），
 *   没有任何指向她本人的控件 —— 那是 B §8 的红线。
 */
window.__ModuleLoader__.load({
  id: 'dsh-roost',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const API = '/dsh-roost'
    const NS = 'fish'

    // ------------------------------------------------- 工具名白名单（2026-10-24）
    // 客户端就地实现一份，规则与 lib/settings.js 的 validateToolNames 一致
    // （那份是 node 模块，这边只能 require('react')，拿不到）。
    // 真正的拦截在服务端 /config：拼错的名字连盘都写不进去。
    const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/
    function parseToolNames(input) {
      // 与 lib/settings.js 同一份规则：数组里夹带逗号也要再拆一次
      const raw = (Array.isArray(input) ? input : [input]).flatMap((x) => String(x ?? '').split(/[,，\s]+/))
      const seen = new Set()
      const out = []
      for (const x of raw) {
        const s = x.trim()
        if (!s || seen.has(s)) continue
        seen.add(s)
        out.push(s)
      }
      return out
    }
    function checkToolNames(input, known) {
      const names = parseToolNames(input)
      const set = Array.isArray(known) && known.length ? new Set(known.map(String)) : null
      const unknown = names.filter((n) => !TOOL_NAME_RE.test(n) || (set && !set.has(n)))
      return { ok: unknown.length === 0, names, unknown, checked: Boolean(set) }
    }

    // ---------------------------------------------------------------- 样式
    const CSS_TAG = 'dsh-roost/section.css'
    const CSS = [
      '.dfish{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}',
      '.dfish h2{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dfish .sub{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px;margin:0}',
      '.dfish .card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px}',
      '.dfish .card>h3{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}',
      '.dfish .kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:13px;line-height:19px}',
      '.dfish .kv b{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.dfish ul{margin:0;padding-left:17px;font-size:13px;line-height:20px}',
      '.dfish li{margin:3px 0}',
      '.dfish .tag{display:inline-block;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}',
      '.dfish pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);font-family:ui-monospace,Consolas,monospace}',
      '.dfish .empty{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}',
      '.dfish .dim{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dfish .err{color:#e5484d;font-size:12.5px;white-space:pre-wrap}',
      '.dfish .ok{color:#30a46c;font-size:12.5px;white-space:pre-wrap}',
      '.dfish .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dfish .form{display:flex;flex-direction:column;gap:9px;font-size:13px}',
      '.dfish .form label{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dfish input[type=number]{width:62px;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:26px;padding:0 7px;outline:none}',
      '.dfish input[type=text]{flex:1;min-width:200px;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:26px;padding:0 7px;outline:none}',
      '.dfish button{background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 12px;cursor:pointer}',
      '.dfish button:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dfish button:disabled{opacity:.5;cursor:default}',
      '.dfish textarea{width:100%;box-sizing:border-box;min-height:66px;resize:vertical;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:8px 10px;outline:none}',
      '.dfish .said{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:21px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;margin:6px 0}',
      '.dfish .badge{display:inline-block;min-width:16px;text-align:center;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:10.5px;line-height:16px;margin-left:6px}',
      '.dfish .tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:5px;background:rgba(128,128,128,.06)}',
      '.dfish .tab{background:transparent;border:.5px solid transparent;border-radius:7px;height:28px;padding:0 11px;font-size:12.5px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));cursor:pointer}',
      '.dfish .tab:hover{color:var(--dsw-alias-label-primary);background:rgba(128,128,128,.12)}',
      // 选中态踩过两次坑（2026-10-25 用户真机截图暴露）：
      // ① 最初写死 color:#fff —— 深色主题下白字压白底，整片看不见；
      // ② 改成 brand-primary 当底色 —— 那其实是「正文墨色」（浅色 #0f1115 近黑 / 深色 #f9fafb 近白），
      //    于是浅色主题出现黑块、深色主题出现白块，仍然难看。
      // 正确做法：底色只用中性的浅罩层，强调靠 state-business-primary 的字色和描边。
      '.dfish .tab.on{background:rgba(128,128,128,.18);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-state-business-primary);font-weight:500}',
      '.dfish .tab.on:hover{color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.24)}',
      '.dfish .tabs .grow{flex:1}',
      '.dfish .tabhint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:-6px 0 0}',
      '.dfish .page{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start}',
      '.dfish .page>.card{min-width:0}',
      '.dfish .card.full{grid-column:1 / -1}',
      '.dfish .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 18px}',
      '.dfish .fld{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dfish .fl{display:flex;flex-direction:column;gap:2px}',
      '.dfish .flabel{font-size:13px;line-height:19px}',
      '.dfish .fhint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dfish .hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.dfish .warn{font-size:12px;line-height:18px;color:#b8860b;margin:6px 0}',
      // 下拉框（2026-10-25 用户真机反馈：暗色下「只有一个白条」，字全看不见）。
      // 根因：select 背景写的是 transparent，原生控件在深色主题里会用 UA 白底绘制，
      // 而字色是 label-primary（深色主题下接近白）——白底白字。option 弹层同理。
      // 修法：底色改成主题的不透明层色，option 显式给同一组底色/字色，
      // color-scheme 继承 <html> 上宿主设的 dark/light（原生弹层跟着切换）。
      '.dfish select{height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText);color-scheme:inherit;font-size:12.5px;padding:0 8px;outline:none;cursor:pointer;max-width:240px}',
      '.dfish select option{background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText)}',
      '.dfish input[type=time]{height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText);color-scheme:inherit;font-size:12.5px;padding:0 6px;outline:none}',
      '.dfish .step{width:26px;height:26px;padding:0;border-radius:6px;font-size:14px;line-height:1}',
      // 日记翻页条（2026-10-26）：日期多于一天才出现，一行放得下三个元素就够。
      '.dfish .pager{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 8px}',
      '.dfish .pager button{height:24px;padding:0 10px;font-size:12px;border-radius:6px}',
      '.dfish .pager .dim{font-size:12px;font-variant-numeric:tabular-nums}',
      '.dfish .sw{position:relative;width:40px;height:22px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:rgba(128,128,128,.18);cursor:pointer;transition:background .15s}',
      '.dfish .sw .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}',
      '.dfish .sw.on{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.dfish .sw.on .knob{left:20px}',
      '.dfish .savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:4px}',
      '.dfish button.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.dfish button.primary:hover:not(:disabled){opacity:.9;color:var(--dsw-alias-label-primary-inverted,#fff)}',
      // GitHub 链接（2026-10-25 用户要求）：商标小图 + 文字，点开新窗口。
      // 用 inline-flex 让 icon 和文字基线对齐；hover 只换颜色不动位置。
      '.dfish .ghlink{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-decoration:none;border-radius:6px;padding:2px 4px;margin-left:-4px}',
      '.dfish .ghlink:hover{color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.1)}',
      '.dfish .ghlink svg{flex:0 0 auto}',
    ].join('\n')

    function useStyleOnce() {
      useEffect(() => {
        if (document.querySelector(`style[data-tag="${CSS_TAG}"]`)) return
        const el = document.createElement('style')
        el.setAttribute('data-tag', CSS_TAG)
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ---------------------------------------------------------------- 工具
    const esc = (s) => String(s == null ? '' : s)

    /**
     * 把质量指标渲染成两位小数。
     *
     * 为什么要有这个函数（2026-10-23，观测台空白页的根因）：
     *   宿主那边 `/state` 的 quality 不是数字，是带样本量的结构体
     *   `{ stability: { score, sample, worst }, consistency: { score, pairs }, novelty: { score, recent, older } }`
     *   （样本太少时故意不报裸分数，避免"看数字调性格"）。
     *   而这里原来写的是 `s.quality.stability.toFixed(2)` —— 对一个对象调 toFixed，
     *   React 渲染抛 TypeError，整节被错误边界吞掉，用户看到的就是**设置页一片空白**。
     *   所以这里同时接受数字和 `{score}` 两种形态，取不到就给 em dash，绝不再抛。
     */
    function q2(v) {
      const n = typeof v === 'number' ? v : Number(v && v.score)
      return Number.isFinite(n) ? n.toFixed(2) : '—'
    }

    /**
     * 「判断漂移」那一行的值：样本不够时不准印 0.00。
     *
     * 2026-10-26（用户 m05785「为什么剩下两个全是0」）：三个指标在样本不足时给的
     * 默认值原本被直接当成结果显示——没有判断时稳定 0.00、说话不足两条时一致 1.00、
     * 没有七天前的老话时新鲜 0.00。三个数里有两个是"还没法测"，不是"她很差"。
     * 现在把这种情况写成一句人话，数字只在真的能测时才印。
     */
    function bandOf(v) {
      return typeof v === 'string' ? v.trim() : ''
    }
    function qStability(v) {
      if (!v) return '—'
      const band = bandOf(v && v.band)
      // 2026-10-27（用户 m06350）：能测出来的时候，数字和判读一起给——只印那句
      // 「长在这些事上，抽掉一条少一块」，用户看不出到底是多少，以为没测。
      // 样本不够时才只给判读：那种 0.00 是默认值，不是测量结果，不能当数字印。
      if (!Number(v.sample ?? 0) || !Number(v.beliefs ?? 0)) return band || '还没攒到判断，测不出来'
      const n = Number(v.score)
      const num = Number.isFinite(n) ? n.toFixed(2) : '—'
      return band ? `${num} · ${band}` : num
    }
    function qConsistency(v) {
      if (!v) return '—'
      const pairs = Number(v.pairs ?? 0)
      if (!pairs) return '还没有跨阶段的话可比'
      const n = Number(v.score)
      return Number.isFinite(n) ? n.toFixed(2) : '—'
    }
    function qNovelty(v) {
      if (!v) return '—'
      const recent = Number(v.recent ?? 0)
      const older = Number(v.older ?? 0)
      if (!recent) return '最近一周没说过话'
      if (!older) return '还没有七天前的老话可比'
      const n = Number(v.score)
      return Number.isFinite(n) ? n.toFixed(2) : '—'
    }

    async function jget(path) {
      const r = await fetch(API + path, { headers: { accept: 'application/json' } })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403 ? '（被信任栅栏拒绝：请在 App 内打开这一页）' : ''
        throw new Error(`HTTP ${r.status}${hint} ${j.error || ''}`.trim())
      }
      return j
    }

    async function jpost(path, body) {
      const r = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body == null ? {} : body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      return j
    }

    // ---------------------------------------------------------------- 组件
    function FishSection() {
      useStyleOnce()
      const [state, setState] = useState(null)
      const [beliefs, setBeliefs] = useState(null)
      const [events, setEvents] = useState([])
      const [diary, setDiary] = useState(null)
      const [browse, setBrowse] = useState(null)
      const [reports, setReports] = useState({ dates: [], date: null, md: '' })
      const [inbox, setInbox] = useState(null)
      const [home, setHome] = useState(null)
      // 请求事件（0.7.6，m01274）：她问过什么、答过什么。只在住所页用到。
      const [asks, setAsks] = useState(null)
      // 请求事件：在这里补答之后的提示（弹卡答过的就不写了）。
      const [askMsg, setAskMsg] = useState('')
      // 梦（2026-10-30 m02837，本机实验 A 案）：只在 .dev 下才取得到，公开版 404。
      const [mem, setMem] = useState(null)
      // 规则与解禁（R3，2026-10-24）：四层规则 + 她提上来的那一张申请
      const [rules, setRules] = useState(null)
      const [st, setSt] = useState(null)
      const [rotateAfter, setRotateAfter] = useState(40)
      const [docBudget, setDocBudget] = useState(1800)
      const [beliefsShown, setBeliefsShown] = useState(2)
      // 记忆体检（0.7.6，2026-10-30 用户 m00342）：点一下才算，不自动跑。
      const [health, setHealth] = useState(null)
      const [healthBusy, setHealthBusy] = useState(false)
      const [toolsAllowText, setToolsAllowText] = useState('')
      const [toolsRestrict, setToolsRestrict] = useState(true)
      // 白名单草稿态（2026-10-24，用户要求）：输入框里的字先不提交，
      // 点「保存设置」才写盘——否则敲一半就被页面其它地方的保存带上去，拼错一个字母整条收窄失效。
      const [toolsAllowSaved, setToolsAllowSaved] = useState([])
      const [toolsKnown, setToolsKnown] = useState(null)
      // 看得见、但收窄挡不住的那些（own 层，比如 dsh-ops 的 ops_*）。白名单放行 = 守卫放行。
      const [toolsOwnLayer, setToolsOwnLayer] = useState([])
      const [toolsSaveNote, setToolsSaveNote] = useState('')
      const [toolsSaveErr, setToolsSaveErr] = useState('')
      // 运行日志（2026-10-24）：只在点开时才读，不参与 30 秒轮询。
      const [logTail, setLogTail] = useState(null)
      const [logBusy, setLogBusy] = useState(false)
      // 备份与恢复（2026-10-25）：只在数据页用，不进轮询。
      const [backupBusy, setBackupBusy] = useState(false)
      const [backupMsg, setBackupMsg] = useState('')
      // 迁移工作区（2026-10-28，用户 m06510）
      const [moveBusy, setMoveBusy] = useState(false)
      const [moveMsg, setMoveMsg] = useState('')
      const [moveAsk, setMoveAsk] = useState(false)
      const [moveTarget, setMoveTarget] = useState('')
      const [moveInfo, setMoveInfo] = useState(null)
      let topEl = null
      const [sayText, setSayText] = useState('')
      const [said, setSaid] = useState([])
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      // 设置界面重做（2026-10-23）：当前页 + 新增的几个环境项
      const [tab, setTab] = useState('today')
      const [todayData, setTodayData] = useState(null)
      const [todayErr, setTodayErr] = useState('')
      const [todayDate, setTodayDate] = useState('')
      const [stageSpanDaysUi, setStageSpanDaysUi] = useState(30)
      const [diaryKeep, setDiaryKeep] = useState(0)
      const [browseDeepRead, setBrowseDeepRead] = useState(6)
      // 评论区里别人的话（2026-10-24，用户 m02454）：默认开，每次最多留 1 条。
      const [browseVoices, setBrowseVoices] = useState(true)
      const [videoOn, setVideoOn] = useState(true)
      const [videoPerDay, setVideoPerDay] = useState(2)
      const [videoFrames, setVideoFrames] = useState(9)
      const [videoBoards, setVideoBoards] = useState(1)
      const [videoDetail, setVideoDetail] = useState('normal')
      const [videoQuality, setVideoQuality] = useState(64)
      const [avoidMinDur, setAvoidMinDur] = useState(60)
      const [avoidMids, setAvoidMids] = useState('')
      const [sleepEvery, setSleepEvery] = useState(7)
      const [sleepKeep, setSleepKeep] = useState(12)

      // 生长环境（可编辑的那几项）
      const [absent, setAbsent] = useState(2)
      const [diaryVisible, setDiaryVisible] = useState(false)
      const [diaryEnabled, setDiaryEnabled] = useState(true)
      const [wakes, setWakes] = useState(1)
      const [eventsPerDay, setEventsPerDay] = useState(1)
      const [questionsPerDay, setQuestionsPerDay] = useState(1)
      // 主动说话（0.8.1 本机实验，.dev 专属）：她自己决定要不要开口。频率是上限，不是要求。
      const [proactiveMax, setProactiveMax] = useState(2)
      const [avoidText, setAvoidText] = useState('')
      // 刷站（全是环境参数：她今天能不能上网、一次看见几条，不是她爱看什么）
      const [browseOn, setBrowseOn] = useState(true)
      const [browsePerDay, setBrowsePerDay] = useState(1)
      const [browseTopN, setBrowseTopN] = useState(4)
      const [browseDanmaku, setBrowseDanmaku] = useState(6)
      // 刷抖音（2026-11-02，用户 m03490）：和刷 B 站一个地位，配额各算各的。
      const [dyBrowseOn, setDyBrowseOn] = useState(false)
      const [dyBrowsePerDay, setDyBrowsePerDay] = useState(1)
      const [dyBrowseTopN, setDyBrowseTopN] = useState(4)
      // 请求节奏（issue #5）：服务器/机房 IP 需要放慢，家宽可以更快
      const [biliMinGap, setBiliMinGap] = useState(800)
      const [biliJitter, setBiliJitter] = useState(500)
      // 渠道（2026-11-02 合并版）：她能碰到外面的哪些地方，以及她现在认得谁。
      // 这一页**没有**任何「她是什么样的人」的输入框——那条线不在这里让。
      const [chan, setChan] = useState(null)
  const [soc, setSoc] = useState(null)
  // 代发（2026-11-02）：她不说的时候，你可以用自己的名义回一句。
  // 只发一串字，不参与她的人格——所以这里给的是输入框，不是「她该怎么说话」。
  const [chanDraft, setChanDraft] = useState({})
  const [chanSending, setChanSending] = useState('')
  // 扫码登录（2026-11-02）：二维码只在内存里，页面一关就作废。
  // { key, svg, status, note, done }
  const [qr, setQr] = useState(null)
  // 「测一下通不通」：只对 QQ 桥 / 抖音浏览器路径 / B 站登录态做一次探测。
  const [ping, setPing] = useState(null)
  // 「启动桥」的结果只留一句话，不存状态——桥起来以后是它自己在跑。
  const [bridgeMsg, setBridgeMsg] = useState('')
  // 世界书（2026-11-02）：她能查的「事实册子」。是知识，不是人格——所以能导入、能删。
  const [wb, setWb] = useState(null)
  const [wbText, setWbText] = useState('')
  const [wbKey, setWbKey] = useState('')
  const [wbFact, setWbFact] = useState('')
  const [wbBusy, setWbBusy] = useState('')
      // 时段（2026-10-23 加）：醒来 / 上网，两段各自可调。
      // 2026-11-06：评论区说话整块下线，「说话时间段」跟着一起去掉——她不再在 B 站发评论。
      const [wakeFrom, setWakeFrom] = useState('20:00')
      const [wakeTo, setWakeTo] = useState('23:00')
      const [browseFrom, setBrowseFrom] = useState('08:00')
      const [browseTo, setBrowseTo] = useState('23:00')
      // 重置
      const [resetInfo, setResetInfo] = useState(null)
      const [resetAsk, setResetAsk] = useState(false)
      // 看过什么 / 自检 / 风控（2026-10-23 加）
      const [hist, setHist] = useState({ groups: [], total: 0 })
      const [histDays, setHistDays] = useState(14)
      const [checks, setChecks] = useState(null)
      const [checking, setChecking] = useState(false)
      const [risk, setRisk] = useState(null)
      // 你不在的时候（2026-10-23 加）
      const [away, setAway] = useState(null)
      // 设置界面 2.0（2026-10-24）：观看历史分页 + 报告默认收起
      const [histPage, setHistPage] = useState(0)
      const [showReport, setShowReport] = useState(false)
      // 常见问题解答（2026-10-28 用户 m00416）：改成就地展开，不再开新窗口（见 feedbackPage 前的注释）
      // 主人是谁 + B 站登录（2026-10-23 加）
      const [ow, setOw] = useState(null)
      const [owCookie, setOwCookie] = useState('')
      const [owNote, setOwNote] = useState('')
      // 数据文件夹的真路径。**只在内存里用，不上屏**（用户 m03440）。
      const [dataPaths, setDataPaths] = useState(null)
      // 头像（2026-10-24）：插件不自带任何图片，谁用谁自己传一张
      const [avatarV, setAvatarV] = useState(0)
      const [avatarPresent, setAvatarPresent] = useState(false)
      const [avatarBytes, setAvatarBytes] = useState(0)
      const [avatarBusy, setAvatarBusy] = useState(false)
      const [avatarNote, setAvatarNote] = useState('')
      // 自动保存（2026-10-24 用户）：设置项改完就生效，不再需要滚到底点保存。
      const [autoNote, setAutoNote] = useState('')
      // 抖音浏览器路径（2026-11-06）：挪到「上网」页的抖音卡里，和它的开关放在一起。
      const [dyBrowserPath, setDyBrowserPath] = useState('')
      // 工具表搜索（2026-11-06，设计 §四 插件页）：只过滤名字，不改配置。
      const [toolQuery, setToolQuery] = useState('')
      // 保存回执和保存失败是两件事，不许挤成一行（2026-10-29 用户：这两句没有联系，
      // 也不属于同类型的提示）。回执只是「存到了」的一句确认，两秒半自己消失；
      // 失败是一个要处理的状态，放在页签栏上方，一句人话 + 一行技术信息，自己点掉。
      // 尤其不能让失败去占「改完就生效」那条说明的位置——两句摆在一起自相矛盾。
      const [saveFail, setSaveFail] = useState('')
      // 保存时被跳过的工具名（2026-10-31，issue #14 @ming-fish）。
      // 服务端不再因为一个「这台机器上没有的名字」把整张表拒掉，而是丢掉它、其余照存。
      // 丢掉的东西必须说出来——否则用户以为自己设的还在，实际悄悄少了一个。
      const [droppedTools, setDroppedTools] = useState([])
      const savedTimer = useRef(null)
      const flashSaved = () => {
        setAutoNote(`已保存 ${new Date().toTimeString().slice(0, 8)}`)
        setSaveFail('')
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setAutoNote(''), 2500)
      }
      // 首屏载入完先把基线记下来，否则一打开页面就会把刚读到的配置又写回去一遍。
      const baselinePending = useRef(true)
      const lastSaved = useRef('')
      // 日记三项单独提交（2026-10-28 用户反馈「开了『让我看日记』插件又自己关」）：
      // 记下最后一次动过它们的时刻，用来挡住紧接着的 load() 把旧值写回输入框。
      const diaryTouchedAt = useRef(0)
      // 还没回包的日记 patch 数量：有在飞的就不让 load() 覆盖输入框。
      const diaryPending = useRef(0)
      // 原理页两张图：点开看原图，滚轮缩放、按住拖动（2026-10-25 用户：插件里看不清）。
      const [zoom, setZoom] = useState(null)
      const dragRef = useRef(null)
      // 2026-10-25：单轮回复字数预算（0 = 不限，默认就不提任何长度要求）
      const [replyChars, setReplyChars] = useState(0)
      // B 站登录提示卡：他点过「不用了」就别再出现（存进 config.ui）
      // 日记翻页（2026-10-26 用户 m01201）：一天一页、日期多于一天才出翻页按钮。
      // 正文按天取（`/diary?day=…`），翻过的缓存进 ref，来回翻不重复请求。
      const [diaryDay, setDiaryDay] = useState(0)
      const diaryCache = useRef({})
      const diaryLoaded = useRef(false)
      const [, setDiaryTick] = useState(0)

      // 当前这天的正文没缓存就去取一次（一页一天，不预取；翻回去靠缓存）。
      const diaryDates = diary?.dates ?? []
      const diaryIdx = Math.min(Math.max(diaryDay, 0), Math.max(diaryDates.length - 1, 0))
      const diaryCur = diaryDates[diaryIdx] ?? null
      useEffect(() => {
        if (!diaryCur || diaryCache.current[diaryCur] !== undefined) return undefined
        let dead = false
        jget(`/diary?day=${diaryCur}`)
          .then((r) => {
            if (dead) return
            diaryCache.current[diaryCur] = r?.text ?? ''
            setDiaryTick((n) => n + 1)
          })
          .catch(() => {})
        return () => { dead = true }
      }, [diaryCur])

      useEffect(() => {
        if (!zoom) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setZoom(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [zoom])

      const load = useCallback(async () => {
        setErr('')
        // 重新读盘之后要重新记基线（撤销 / 刷新都走这里）。
        baselinePending.current = true
        try {
          const s = await jget('/state')
          setState(s)
          // 名字（2026-11-07）：服务端从事件里认出来的；认不出就是「她」。
          NAMES.nav = String(s.herName || '她')
          setAbsent(Number(s.config?.absenceAfterDays ?? 2))
          // 刚点过日记开关就别用服务端的旧值把它压回去（下面的 patchDiary 已经存过盘了）
          if (!diaryPending.current && Date.now() - diaryTouchedAt.current > 3000) {
            // 服务端没给这个字段（undefined）不等于 false，别把空值当成「关掉」写回界面
            const dv = s.config?.diary?.visible
            const de = s.config?.diary?.enabled
            if (typeof dv === 'boolean') setDiaryVisible(dv)
            if (typeof de === 'boolean') setDiaryEnabled(de)
          }
          setWakes(Number(s.config?.wakesPerDay ?? 1))
          setEventsPerDay(Number(s.config?.daily?.events ?? 1))
          setQuestionsPerDay(Number(s.config?.daily?.questions ?? 1))
          // 主动说话（.dev 专属）：没这个字段就是没开过，保持默认关闭。
          const pr = s.config?.proactive
          if (pr && typeof pr === 'object') {
            setProactiveMax(Number(pr.maxPerDay ?? 2))
          }

          const [b, e, d, c, br, ib, hm, pth] = await Promise.all([
            jget('/beliefs'),
            jget('/events?limit=25'),
            jget('/diary'),
            jget('/config'),
            jget('/browse'),
            jget('/inbox?limit=60').catch(() => null),
            jget('/home').catch(() => null),
            jget('/paths').catch(() => null),
          ])
          setBeliefs(b)
          setEvents(e.rows || [])
          setDiary(d)
          // 首天正文随 /diary 一起回来了，先灌进翻页缓存（省一次往返）。
          for (const it of d?.items ?? []) diaryCache.current[it.date] = it.text
          // 只有第一次载入才跳到最新一天：30 秒轮询不该把人正在看的那页弹走。
          if (!diaryLoaded.current) {
            setDiaryDay(0)
            diaryLoaded.current = true
          }
          setBrowse(br)
          setInbox(ib)
          setHome(hm)
          setDataPaths(pth)
          // 迁移工作区：只读她现在住哪、有多少东西（失败就只显示按钮，不影响别处）
          jget('/move').then(setMoveInfo).catch(() => {})
          // 请求事件：她问过什么、哪些还没答（失败就只显示空卡）
          jget('/ask').then(setAsks).catch(() => {})
          // 上下文与记忆：单独取，失败不影响其它卡片
          jget('/memory').then(setMem).catch(() => {})
          // 她以前看过什么 / 风控状态：都是只读，失败不影响其它卡片
          jget(`/history?days=${histDays}`).then(setHist).catch(() => {})
          jget('/risk').then(setRisk).catch(() => {})
          jget('/away').then(setAway).catch(() => {})
          // 头像元信息（有没有、多大）。没有就是空圈，不回落任何内置图。
          jget('/avatar/info').then((r) => {
            setAvatarPresent(Boolean(r && r.present))
            setAvatarBytes(Number(r && r.bytes) || 0)
          }).catch(() => {})
          // 规则与解禁（R3）：失败不影响其它卡片
          jget('/rules').then(setRules).catch(() => {})
          // 运行日志：失败就当没这回事（日志本身坏了不该拖垮设置页）
          // 渠道面板：只读的状态 + 认识的人 + 最近的流水。失败就当没有这一页的数据。
          jget('/channels').then(setChan).catch(() => {})
      jget('/social').then(setSoc).catch(() => {})
          jget('/worldbook').then(setWb).catch(() => {})
          jget('/log?lines=40').then(setLogTail).catch(() => {})
          // 报告：先拿日期列表，再取最新那天的正文（失败不影响其它卡片）
          jget('/reports').then(async (r) => {
            if (!r.dates?.length) return setReports(r)
            const one = await jget(`/reports?date=${r.dates[0]}`)
            setReports(one)
          }).catch(() => {})
          const cfg = c.config || {}
          setAbsent(Number(cfg.absenceAfterDays ?? 2))
          setWakes(Number(cfg.wakesPerDay ?? 1))
          setEventsPerDay(Number(cfg.daily?.events ?? 1))
          setQuestionsPerDay(Number(cfg.daily?.questions ?? 1))
          setAvoidText(((cfg.avoid?.keywords) || []).join('，'))
          setBrowseOn(cfg.browse?.enabled !== false)
          setBrowsePerDay(Number(cfg.browse?.perDay ?? 1))
          setBrowseTopN(Number(cfg.browse?.topN ?? 4))
          setDyBrowseOn(cfg.browse?.douyin?.enabled === true)
          setDyBrowsePerDay(Number(cfg.browse?.douyin?.perDay ?? 1))
          setDyBrowseTopN(Number(cfg.browse?.douyin?.topN ?? 4))
          setDyBrowserPath(String(cfg.browse?.douyin?.browserPath ?? cfg.channels?.douyin?.browserPath ?? ''))
          setBrowseDanmaku(Number(cfg.browse?.danmaku ?? 6))
          setBiliMinGap(Number(cfg.bili?.minIntervalMs ?? 800))
          setBiliJitter(Number(cfg.bili?.jitterMs ?? 500))
          setRotateAfter(Number(cfg.chat?.rotateAfter ?? 40))
          setReplyChars(Number(cfg.chat?.replyChars ?? 0))
          setToolsAllowText((cfg.tools?.allow ?? []).join(', '))
          setToolsAllowSaved(Array.isArray(cfg.tools?.allow) ? cfg.tools.allow.map(String) : [])
          setToolsRestrict(cfg.tools?.restrict !== false)
          setDocBudget(Number(cfg.memory?.docBudget ?? 1800))
          setBeliefsShown(Number(cfg.memory?.beliefsShown ?? 2))
          setStageSpanDaysUi(Number(cfg.stageSpanDays ?? 30))
          setDiaryKeep(Number(cfg.diary?.keepDays ?? 0))
          setBrowseDeepRead(Number(cfg.browse?.deepRead ?? 6))
          setBrowseVoices(cfg.browse?.voices !== false)
          setVideoOn(cfg.video?.enabled !== false)
          setVideoPerDay(Number(cfg.video?.perDay ?? 2))
          setVideoFrames(Number(cfg.video?.frames ?? 9))
          setVideoBoards(Number(cfg.video?.boards ?? 1))
          setVideoDetail(String(cfg.video?.detail ?? 'normal'))
          setVideoQuality(Number(cfg.video?.quality ?? 64))
          setAvoidMinDur(Number(cfg.avoid?.minDuration ?? 60))
          setAvoidMids(((cfg.avoid?.upMids) || []).join('，'))
          setSleepEvery(Number(cfg.memory?.sleepEveryDays ?? 7))
          setSleepKeep(Number(cfg.memory?.sleepKeep ?? 12))
          // 时段：醒来 / 上网。坏值由服务端兜底，这里只做展示。
          const w0 = Array.isArray(cfg.window) ? cfg.window : ['20:00', '23:00']
          setWakeFrom(w0[0]); setWakeTo(w0[1])
          const b0 = Array.isArray(cfg.browse?.window) ? cfg.browse.window : ['08:00', '23:00']
          setBrowseFrom(b0[0]); setBrowseTo(b0[1])
          jget('/reset').then(setResetInfo).catch(() => {})
          // 登录的是哪个号（有没有 cookie、昵称、uid）。cookie 原文永远不下发。
          jget('/owner').then(setOw).catch(() => {})
        } catch (e) {
          setErr(e.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      // 在线状态每 30 秒刷一次；页面在后台就不轮询（省电，也不制造无谓请求）。
      // 2026-10-23 加：他要能看见「醒了但没做什么」这种状态，而不是只有结果。
      useEffect(() => {
        let stop = false
        const peek = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try { const r = await jget('/status'); if (!stop) setSt(r) }
          catch { if (!stop) setSt({ phase: 'offline', label: '离线', detail: '服务没开，或者插件没加载' }) }
        }
        peek()
        const t = setInterval(peek, 30_000)
        return () => { stop = true; clearInterval(t) }
      }, [])

      // 只提交"环境"字段。她的性格相关的键一个都不在这里（B §8）。
      // 手动按钮和自动保存在同一处组装，避免两份字段表漂移。
      const buildConfig = () => ({
        absenceAfterDays: Number(absent),
        wakesPerDay: Number(wakes),
        daily: { events: Number(eventsPerDay), questions: Number(questionsPerDay) },
        stageSpanDays: Number(stageSpanDaysUi),
        // diary 不在这张表里：它有自己的 patchDiary（见下）。
        // 整表提交会把日记三项一起写一遍，手里一旦是旧值就等于替用户把开关关掉。
        avoid: {
          keywords: avoidText.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
          minDuration: Number(avoidMinDur),
          upMids: avoidMids.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
        },
        window: [wakeFrom, wakeTo],
        browse: { enabled: browseOn, perDay: Number(browsePerDay), topN: Number(browseTopN), deepRead: Number(browseDeepRead), danmaku: Number(browseDanmaku), voices: Boolean(browseVoices), window: [browseFrom, browseTo] },
        video: { enabled: videoOn, perDay: Number(videoPerDay), frames: Number(videoFrames), boards: Number(videoBoards), detail: videoDetail, quality: Number(videoQuality) },
        bili: { minIntervalMs: Number(biliMinGap), jitterMs: Number(biliJitter) },
        chat: { rotateAfter: Number(rotateAfter), replyChars: Number(replyChars) },
        tools: { restrict: Boolean(toolsRestrict), allow: toolsAllowSaved },
        memory: { docBudget: Number(docBudget), sleepEveryDays: Number(sleepEvery), sleepKeep: Number(sleepKeep), beliefsShown: Number(beliefsShown) },
      })

      // 数字框可能停在半截（清空、只打了一个「1」）。这种值不写盘，
      // 否则服务端 clamp 会静默改成下限，用户以为自己输的就是生效值。
      const NUM_BOUNDS = [
        ['缺席判定天数', absent, 1, 30],
        ['每天醒几次', wakes, 0, 4],
        ['每天最多几条事件', eventsPerDay, 0, 5],
        ['每天最多几个问题', questionsPerDay, 0, 5],
        ['四个阶段天数', stageSpanDaysUi, 7, 180],
        // 日记三项不在这里：它们由 patchDiary 单独提交（整表保存会把开关写回旧值）。
        ['最短屏蔽时长', avoidMinDur, 0, 3600],
        ['每天看几次', browsePerDay, 0, 6],
        ['每次几条', browseTopN, 1, 20],
        ['深读几条评论', browseDeepRead, 0, 40],
        ['弹幕几条', browseDanmaku, 0, 30],
        ['请求间隔', biliMinGap, 200, 120000],
        ['请求抖动', biliJitter, 0, 60000],
        ['每天看几个视频', videoPerDay, 0, 6],
        ['抽几帧', videoFrames, 4, 16],
        ['几张故事板', videoBoards, 1, 3],
        ['多少轮换会话', rotateAfter, 0, 500],
        ['每轮最多写多少字', replyChars, 0, 2000],
        ['上下文上限', docBudget, 600, 4000],
        ['一次看见几条', beliefsShown, 1, 8],
        ['几天想一次', sleepEvery, 0, 60],
        ['留几条自述', sleepKeep, 0, 100],
      ]
      const badNumber = () => {
        for (const [label, value, lo, hi] of NUM_BOUNDS) {
          const n = Number(value)
          if (!Number.isFinite(n) || n < lo || n > hi) return `${label}（${lo}–${hi}）`
        }
        return ''
      }

      const save = async (silent = false) => {
        if (!silent) { setBusy('save'); setNote('') }
        try {
          await jpost('/config', buildConfig())
          if (silent) flashSaved()
          else { setNote('已保存。下一轮 tick 生效。'); await load() }
        } catch (e) {
          if (silent) setSaveFail(e.message)
          else setErr(e.message)
        } finally { if (!silent) setBusy('') }
      }

      // 日记三项单独提交（2026-10-28 用户反馈「开了『让我看日记』插件又自己关」）。
      // 走整表保存时，任何一项环境参数变化都会顺带把 diary 一起写一遍；
      // 只要那一刻手里是旧值，开关就被静默翻回去。这里改成「改了哪项就只提交哪项」，
      // 服务端 updateConfig 是深合并，没传的键原样保留。
      const patchDiary = async (patch) => {
        diaryTouchedAt.current = Date.now()
        diaryPending.current += 1
        try {
          await jpost('/config', { diary: patch })
          flashSaved()
        } catch (e) { setSaveFail(e.message) } finally { diaryPending.current -= 1 }
      }

      // 主动说话（0.8.1 本机实验）：同样只提交改了的那一项，别把别的开关写回旧值。
      const patchProactive = async (patch) => {
        try {
          await jpost('/config', { proactive: patch })
          flashSaved()
        } catch (e) { setSaveFail(e.message) }
      }

      // 渠道：同样按渠道提交（深合并），改一个渠道不会碰另一个渠道的凭据与群号。
      // 扫码登录（2026-11-02）：要一张码，然后每 2 秒问一次。
      // 成功后服务端已经把 cookie 存进 owner.json 了，这里只把界面刷一遍。
      const startQr = async () => {
        setQr({ status: 'loading', note: '正在向 B 站要二维码…' })
        try {
          const r = await jpost('/bili/qr', {})
          if (!r?.ok) { setQr({ status: 'error', note: r?.note || '没拿到二维码。' }); return }
          setQr({ key: r.key, svg: r.svg, status: 'waiting', note: '用手机 B 站扫这张码。' })
        } catch (e) {
          setQr({ status: 'error', note: e?.message || '连不上。' })
        }
      }

      useEffect(() => {
        if (!qr?.key || qr.done) return undefined
        let alive = true
        const run = async () => {
          while (alive) {
            await new Promise((r) => setTimeout(r, 2000))
            if (!alive) return
            let r = null
            try { r = await jpost('/bili/qr/poll', { key: qr.key }) } catch { continue }
            if (!alive) return
            if (!r) continue
            if (r.status === 'ok') {
              setQr((q) => ({ ...q, done: true, status: 'ok', note: r.note || '登上了。' }))
              load()
              return
            }
            if (r.status === 'expired' || r.status === 'error' || r.ok === false) {
              setQr((q) => ({ ...q, done: true, status: r.status === 'expired' ? 'expired' : 'error', note: r.note || (r.status === 'expired' ? '二维码过期了，重新要一张。' : '没扫成。') }))
              return
            }
            setQr((q) => ({ ...q, status: r.status || 'waiting' }))
          }
        }
        void run()
        return () => { alive = false }
      }, [qr?.key, qr?.done, load])

      const startBridgeNow = async () => {
        setBridgeMsg('正在拉起…')
        try {
          const r = await jpost('/channels/bridge', { action: 'start' })
          setBridgeMsg(String(r?.note || (r?.ok ? '起来了。' : '没起来。')))
        } catch (e) {
          setBridgeMsg(String(e?.message || '起不来。'))
        }
      }

      const doPing = async (channel) => {
        setPing({ channel, text: '测一下…' })
        try {
          const r = await jpost('/channels/ping', { channel })
          setPing({ channel, text: String(r?.note || (r?.ok ? '通了。' : '不通。')) })
        } catch (e) {
          setPing({ channel, text: String(e?.message || '测不了。') })
        }
      }

      const pingRow = (channel) => h('div', { className: 'row', style: { gap: '8px', alignItems: 'center', marginTop: '6px' } },
        h('button', { type: 'button', onClick: () => { void doPing(channel) } }, '测一下通不通'),
        ping?.channel === channel && ping.text ? h('span', { className: 'dim' }, ping.text) : null)

      const patchDyBrowsing = async (patch) => {
        try {
          await jpost('/config', { browse: { douyin: patch } })
          flashSaved()
        } catch (e) { setSaveFail(e.message) }
      }

      const patchChannel = async (name, patch) => {
        try {
          await jpost('/config', { channels: { [name]: patch } })
          flashSaved()
          jget('/channels').then(setChan).catch(() => {})
        } catch (e) { setSaveFail(e.message) }
      }

      // A29：主人的 id 按渠道存进 owner.json（0600）。渠道配置只放环境参数，
      // 「谁算主人」是认人，不是她的性格，也不该跟渠道开关混在一张表里。
      const patchOwner = async (channel, id) => {
        try {
          await jpost('/channels/owner', { channel, id })
          flashSaved()
          jget('/channels').then(setChan).catch(() => {})
        } catch (e) { setSaveFail(e.message) }
      }

      // 代发：她不说的时候，你以自己的名义回一句。
      // 线程键是 `渠道:类型:会话id`（journal 的 threadKey），这里原样拆回去。
      const sendAsMe = async (thread) => {
        const text = String(chanDraft[thread?.key] ?? '').trim()
        if (!text || chanSending) return
        const [channel, kind, ...rest] = String(thread.key).split(':')
        const conversationId = rest.join(':')
        setChanSending(thread.key)
        try {
          await jpost('/channels/send', {
            channel,
            kind: kind === 'group' ? 'group' : 'private',
            conversationId,
            conversationName: thread.name || thread.key,
            text,
          })
          setChanDraft((d) => ({ ...d, [thread.key]: '' }))
          flashSaved()
          const fresh = await jget('/channels').catch(() => null)
          if (fresh) setChan(fresh)
        } catch (e) {
          setSaveFail(e.message)
        } finally {
          setChanSending('')
        }
      }

      // 世界书：导入 SillyTavern 的 JSON（lorebook 与数组两种都认）。
      // 导入的是**事实**，不是「她该是什么样」——所以这里只有导入和删除，没有编辑人格的地方。
      const importWb = async () => {
        const raw = String(wbText ?? '').trim()
        if (!raw || wbBusy) return
        let data
        try {
          data = JSON.parse(raw)
        } catch {
          setSaveFail('这段不是合法 JSON')
          return
        }
        setWbBusy('import')
        try {
          await jpost('/worldbook/import', { data })
          setWbText('')
          flashSaved()
          const fresh = await jget('/worldbook').catch(() => null)
          if (fresh) setWb(fresh)
        } catch (e) {
          setSaveFail(e.message)
        } finally {
          setWbBusy('')
        }
      }
      const addWb = async () => {
    const keys = String(wbKey ?? '').trim()
    const text = String(wbFact ?? '').trim()
    if (!keys || !text) return
    setWbBusy('add')
    try {
      await jpost('/worldbook/add', { keys, text })
      flashSaved()
      setWbKey('')
      setWbFact('')
      const fresh = await jget('/worldbook').catch(() => null)
      if (fresh) setWb(fresh)
    } catch (e) {
      setSaveFail(e?.message ?? e)
    } finally {
      setWbBusy('')
    }
  }

  const clearWb = async () => {
        if (wbBusy) return
        setWbBusy('clear')
        try {
          await jpost('/worldbook/clear', {})
          flashSaved()
          const fresh = await jget('/worldbook').catch(() => null)
          if (fresh) setWb(fresh)
        } catch (e) {
          setSaveFail(e.message)
        } finally {
          setWbBusy('')
        }
      }

      // 改完就生效：任何一项变了，停手 700ms 就写盘（连点加减号也只写一次）。
      const cfgSig = JSON.stringify(buildConfig())
      useEffect(() => {
        if (!state) return
        if (baselinePending.current) { baselinePending.current = false; lastSaved.current = cfgSig; return }
        if (cfgSig === lastSaved.current) return
        const bad = badNumber()
        if (bad) { setSaveFail(`「${bad}」这个数不在允许范围里，所以没有写进去。`); return }
        const t = setTimeout(async () => {
          try {
            const r = await jpost('/config', buildConfig())
            lastSaved.current = cfgSig
            // 服务端丢掉了几个「这台机器上不存在」的名字（2026-10-31 issue #14）：
            //   · 把 cleaned 名单收回来，否则下一次整表提交又带着它、每次都白丢一遍；
            //   · 名字说出来，别让用户以为自己设的还在。
            //   · 只改「已存名单」，不动输入框里的草稿——他可能正在那儿打字。
            const gone = Array.isArray(r?.droppedTools) ? r.droppedTools.filter(Boolean) : []
            if (gone.length) {
              const kept = Array.isArray(r?.config?.tools?.allow) ? r.config.tools.allow.map(String) : []
              setToolsAllowSaved(kept)
              setDroppedTools(gone)
            }
            flashSaved()
          } catch (e) { setSaveFail(e.message) }
        }, 700)
        return () => clearTimeout(t)
      }, [cfgSig, state])

      const saveTools = async () => {
        setBusy('tools'); setToolsSaveNote(''); setToolsSaveErr('')
        try {
          let known = toolsKnown
          let own = toolsOwnLayer
          // 2026-10-29：每次保存都问一次宿主，顺带拿回 own 层名单。
          // 以前只在 known 为空时问，于是「哪些名字收窄挡不住」永远是空的。
          try {
            const r = await jget('/tools')
            const names = Array.isArray(r?.known) ? r.known : null
            if (names && names.length) { known = names; setToolsKnown(names) }
            own = Array.isArray(r?.ownLayer) ? r.ownLayer : []
            setToolsOwnLayer(own)
          } catch { /* 拿不到就沿用旧名单，只查拼写 */ }
          const check = checkToolNames(toolsAllowText, known)
          if (!check.ok) {
            setToolsSaveErr(`这些名字不对：${check.unknown.join('、')}。没保存。`)
            return
          }
          // 名单没拿到（她还没在本进程里开过会话，或宿主换了版本）时，只查了拼写——
          // 这点必须说出来，否则用户以为「过了校验」就等于「名字一定存在」。
          const onlyShape = !known || !known.length
          const before = toolsAllowSaved.length
          // strictTools：这是用户刚在输入框里敲完点的「保存」，坏名字要当场拦下来。
          // 页面自动保存走的是另一条（不带这个标记）：那边丢掉坏名字、其余照存，
          // 因为回传的是盘上已有的旧名单，用户没在编辑它（2026-10-31 issue #14）。
          await jpost('/config', { tools: { restrict: Boolean(toolsRestrict), allow: check.names }, strictTools: true })
          setToolsAllowSaved(check.names)
          await load()
          const delta = check.names.length - before
          if (!check.names.length) setToolsSaveNote('存好了。重启之后她只剩自己那几件工具。')
          else if (delta > 0) setToolsSaveNote(`存好了。重启之后她会多看见 ${delta} 个工具（名单一共 ${check.names.length} 个）。`)
          else if (delta < 0) setToolsSaveNote(`存好了。重启之后她会少看见 ${-delta} 个工具（名单一共 ${check.names.length} 个）。`)
          else setToolsSaveNote(`存好了。名单没变，还是 ${check.names.length} 个。`)
          const ownPicked = check.names.filter((n) => own.includes(n))
          if (ownPicked.length) {
            setToolsSaveNote((n) => `${n} 其中 ${ownPicked.join('、')} 是她本来就看得见的（插件把她自己的工具注册进她那一层，收窄挡不住）：加进白名单只是让兜底守卫放行它。`)
          }
          if (onlyShape && check.names.length) {
            setToolsSaveNote((n) => `${n} 这次只核对了拼写——她还没开过会话，宿主那边还给不出工具名单。名字必须一字不差。`)
          }
        } catch (e) {
          setToolsSaveErr(e.message)
        } finally { setBusy('') }
      }

      /**
       * B 站登录。
       * cookie 只上行不下行——输入框永远是空的，存过之后只显示「已保存」。
       * 2026-11-06：主人身份不再靠手填 uid 认——扫码存下来的就是她自己的号。
       */
      const saveOwnerCard = async () => {
        if (!owCookie.trim()) { setOwNote('先把 cookie 贴进来。'); return }
        setBusy('owner'); setOwNote('')
        try {
          const r = await jpost('/owner', { cookie: owCookie.trim() })
          setOwNote(r.note || (r.ok ? '存下了。' : '没存上。'))
          setOwCookie('')
          await load()
        } catch (e) { setOwNote(e.message) } finally { setBusy('') }
      }

      const testOwner = async () => {
        setBusy('owtest'); setOwNote('')
        try {
          const r = await jpost('/owner', { test: true })
          setOwNote(r.note || (r.ok ? '可以说话。' : '还不行。'))
          // 2026-10-27：测试只认「这份 cookie 登的是谁」。
          // 2026-11-06：不再回填任何主人格子——主人身份就是登录账号本身。
          await load()
        } catch (e) { setOwNote(e.message) } finally { setBusy('') }
      }

      // 本机测试版专用（2026-10-26，用户 m00928）：绕过「今天该不该醒」，直接叫她去刷 B 站。
      // 存在意义就是验证「她到底能不能刷」——所以不做配额判断、也不看上网时段。
      // 正式版不渲染这个按钮（服务端 /state 的 dev 由 `.dev` 文件决定）。
      const browseNow = async () => {
        setBusy('wake-browse'); setNote('')
        try {
          const r = await jpost('/wake?focus=browse')
          setNote(r.ok ? '叫醒她了，这一轮她会去看 B 站首页。刷新一下能看到她的新会话。' : `没叫：${r.why || ''}`)
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      const wake = async () => {
        setBusy('wake'); setNote('')
        try {
          const r = await jpost('/wake')
          setNote(r.ok ? `已叫醒（${r.template}）` : `没叫：${r.why || ''}`)
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // ---- P3-1：跟她说一句话 ----
      const send = async () => {
        const t = sayText.trim()
        if (!t) return
        setBusy('say'); setNote(''); setSaid([])
        try {
          const r = await jpost('/say', { text: t })
          setSaid(r.said || [])
          setSayText('')
          setNote(r.said?.length ? '' : (r.note || '她这次没说话。'))
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // ---- R3：裁决她提上来的那张申请 ----
      // 批准会立刻重写身份文档，她下一次开口就看得见"这件事现在可以了"。
      const decide = async (verdict) => {
        setBusy('decide')
        setErr('')
        try {
          const r = await jpost('/decide', { verdict })
          if (r && r.error) throw new Error(r.error)
          await load()
        } catch (e) {
          setErr(e.message || String(e))
        } finally { setBusy('') }
      }

      // ---- P3-2：信箱已读 ----
      const markInbox = async () => {
        setBusy('inbox')
        try { await jpost('/inbox'); await load() } catch (e) { setErr(e.message) } finally { setBusy('') }
      }

      // ---- P4：把她放回第一天 ----
      // 两步：先读"将要封存什么"给他看，再要求他按第二次（真按钮）。
      // 不做 undo —— 但旧数据是**改名封存**，不是删，所以真后悔了还能从
      // 同级目录的 dsh-roost-backups/reset-* 里整包搬回来。
      const askReset = async () => {
        setBusy('reset-ask'); setNote('')
        try {
          const info = await jget('/reset')
          setResetInfo(info)
          setResetAsk(true)
        } catch (e) { setErr(e.message) } finally { setBusy('') }
      }
      const doReset = async () => {
        setBusy('reset'); setNote('')
        try {
          const r = await jpost('/reset', { confirm: 'reset' })
          setResetAsk(false)
          const head = r.movedTo ? `已重开。旧的都在：${r.movedTo}` : (r.note || '已重开。')
          // 单行：这个 note 用 <pre class="ok"> 渲染，换行会撑出一块绿色告示，不如一句话说清。
          // 2026-10-26（m01426 真机反馈）：重置会把新会话建出来，也会顺手叫一声，但**侧栏仍然看不见**——
          // 宿主的 sessionVisible 规则是「空白会话只有成为当前会话才显示」，而插件用 API 建的会话永远
          // 不会成为 current。实测只有用户自己点一次「叫醒她」才会出现。所以提示以这一步为准，
          // 不再承诺「侧栏已经冒出」。
          const tail = r.freshError
            ? ` 新会话没建出来：${r.freshError}`
            : (r.retiredError
              ? ` 旧会话没收干净：${r.retiredError}。点一下「叫醒她」，她开一次口，侧栏里才看得见新会话。`
              : ' 侧栏这会儿还看不到她——点一下上面的「叫醒她」，她开一次口，「跟她说话」才会出现在侧栏里。')
          setNote(`${head}${tail}`)
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // 会话被用户归档之后，插件不再自动重开（0.6.8）。必须有个明说的入口，
      // 否则「收起来」就真的变成「再也回不去」。它只建新会话，不动任何文件。
      const doRebuild = async () => {
        setBusy('rebuild'); setNote('')
        try {
          const r = await jpost('/home/rebuild', { confirm: 'rebuild' })
          if (!r.ok) setNote(`没搭成：${r.error || r.note || ''}`)
          else if (r.woke) setNote('搭好了，也叫了她一声——侧栏里等她说出第一句就会出现。')
          else setNote('搭好了。点一下上面的「现在叫醒她」，她开一次口，侧栏里才看得见这条会话。')
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // 换一条会话（2026-11-06，设计 §四「会话健康」）：屋子还在，只是这条
      // 聊不动了（连续两次没送进去，或上下文已经太长）。旧的改名留档，原话
      // 搬几句到新的；事件流、日记、记忆都不动。
      const doRotate = async () => {
        if (!window.confirm('换一条新会话？旧的会改名留在侧栏里，说过的话搬几句过去。')) return
        setBusy('rotate'); setNote('')
        try {
          const r = await jpost('/home/rotate', { confirm: 'rotate' })
          setNote(r.ok ? '换好了。下一句话会落在新会话里。' : `没换成：${r.error || ''}`)
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      if (err && !state) {
        return h('div', { className: 'dfish' },
          h('h2', null, NAMES.nav),
          h('p', { className: 'sub' }, '读不到状态。'),
          h('pre', { className: 'err' }, err))
      }

      const s = state
      const kv = (pairs) => h('div', { className: 'kv' },
        pairs.filter(Boolean).flatMap(([k, v]) => [h('b', { key: 'k' + k }, k), h('span', { key: 'v' + k }, v)]))

      // 时段行（2026-10-23 加）：三个时段用同样的控件，省得三处各写一遍还对不齐。
      // type=time 在浏览器里自带时间选择器；跨零点（22:00→02:00）是允许的，由服务端判定。
      const timeRow = (label, from, to, setFrom, setTo, hint) =>
        h('label', null, label,
          h('input', { type: 'time', value: from, onChange: (e) => setFrom(e.target.value) }),
          h('span', { className: 'dim' }, '到'),
          h('input', { type: 'time', value: to, onChange: (e) => setTo(e.target.value) }),
          hint ? h('span', { className: 'dim' }, hint) : null)

      // ---- 表单控件（2026-10-23 重做）----
      // 只用 React.createElement，不引任何依赖：这一节跑在宿主的客户端沙箱里。
      function Toggle(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('button', {
            type: 'button',
            className: 'sw' + (o.on ? ' on' : ''),
            role: 'switch',
            'aria-checked': o.on ? 'true' : 'false',
            onClick: () => o.onChange(!o.on),
          }, h('span', { className: 'knob' })))
      }
      function Num(o) {
        const cur = Number(o.value || 0)
        const step = o.step || 1
        // 空串/非数字（比如把框清空）不当成 0，落到下限；否则会显示 「NaN」。
        const clamp = (n) => {
          const v = Number(n)
          const base = Number.isFinite(v) ? v : o.min
          return String(Math.min(o.max, Math.max(o.min, base)))
        }
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('div', { className: 'row', style: { gap: '6px' } },
            h('button', { className: 'step', onClick: () => o.onChange(clamp(cur - step)) }, '−'),
            h('input', {
              type: 'number', min: o.min, max: o.max, step, value: o.value,
              onChange: (e) => o.onChange(e.target.value),
              // 2026-10-24: 打字不受 input 的 min/max 约束（浏览器只当校验提示），
              // 离开输入框时按上下限收敛一次，免得界面显示 9999、保存后又被服务端改成上限。
              onBlur: (e) => o.onChange(clamp(e.target.value)),
            }),
            h('button', { className: 'step', onClick: () => o.onChange(clamp(cur + step)) }, '+'),
            o.unit ? h('span', { className: 'dim' }, o.unit) : null))
      }
      function Sel(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('select', { value: String(o.value), onChange: (e) => o.onChange(e.target.value) },
            ...o.options.map((v) => h('option', { key: String(v), value: String(v) },
              o.fmt ? o.fmt(v) : String(v)))))
      }
      function Text(o) {
        return h('div', { className: 'fld', style: o.wide ? { gridColumn: '1 / -1' } : undefined },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('input', { type: 'text', value: o.value, placeholder: o.placeholder,
            onChange: (e) => o.onChange(e.target.value) }))
      }
      function TimeRange(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('div', { className: 'row', style: { gap: '6px' } },
            h('input', { type: 'time', value: o.from, onChange: (e) => o.onFrom(e.target.value) }),
            h('span', { className: 'dim' }, '到'),
            h('input', { type: 'time', value: o.to, onChange: (e) => o.onTo(e.target.value) })))
      }

      // 工具面：把限制的理由写给用户看，给一个总开关，另留一处额外放行口。
      // 2026-10-24 起这条限制是真的（restrict 37→8，另有一道 guard 兜底），
      // 所以界面上的说法从「还没打通」改成「已经做到」——配置不许撒谎。
      // 工具面（2026-11-06，设计 §四 插件页）：两块——收窄总开关，和一张能搜能加减的工具表。
      // 表里只写「它是干什么的」，不写「她该不该用」；要不要放行由人决定，判断不在这里。
      // 说明从宿主 registry 取（2026-11-07，A27）：注册时怎么写的就怎么显示。
      // 取不到就只说来源，不替它编一句——以前那张写死的表没覆盖到的名字
      // 会显示「宿主按会话给的」，那是猜的。
      const toolDescriptions = (state?.tools?.descriptions && typeof state.tools.descriptions === 'object')
        ? state.tools.descriptions
        : {}
      const toolsList = Array.isArray(state?.tools?.known) ? state.tools.known : []
      const toolsOwn = new Set(Array.isArray(state?.tools?.own) ? state.tools.own : [])
      const toolsAllowSet = new Set((toolsAllowSaved ?? []).map(String))
      const toolsQuery = toolQuery.trim().toLowerCase()
      const toolsRows = toolsList
        .filter((n) => !toolsQuery || String(n).toLowerCase().includes(toolsQuery))
        .map((name) => {
          const on = toolsAllowSet.has(name)
          const own = toolsOwn.has(name)
          const desc = typeof toolDescriptions[name] === 'string' ? toolDescriptions[name].trim() : ''
          // 有说明说说明；没有说明只说来源。两条都不许写成「宿主按会话给的」那种猜测。
          const hint = desc || (own ? '来源：她自己那一层注册的' : '来源：宿主或别的插件注册的')
          return h('div', {
            key: name,
            style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '5px 0', borderTop: '1px solid rgba(127,127,127,.12)' },
          },
          h('span', { style: { fontFamily: 'monospace', fontSize: '12.5px', minWidth: '160px' } }, name),
          h('span', { className: 'dim', style: { flex: '1' }, title: desc || hint },
            hint),
          h('span', { className: 'tag', style: { flex: '0 0 auto' } }, on ? '在手' : own ? '收窄挡不住' : '未放行'),
          h('button', {
            type: 'button',
            className: 'btn',
            style: { flex: '0 0 auto' },
            onClick: () => {
              const next = on
                ? (toolsAllowSaved ?? []).filter((n) => String(n) !== name)
                : [...(toolsAllowSaved ?? []), name]
              setToolsAllowSaved(next)
              setToolsAllowText(next.join(', '))
              setToolsSaveNote('')
              setToolsSaveErr('')
            },
          }, on ? '移出' : '加进来'))
        })
      const toolsCard = h('div', { className: 'card' },
        h('h3', null, '工具面'),
        h('div', { className: 'dim' },
          '工具定义每轮都要占上下文，放得越多，留给她自己想的余量越少。默认只给她本来就需要的那几样。',
          '收窄只影响和她的对话，不影响你自己的窗口。关掉收窄之后她能看见宿主的全部标准工具——改动要重启才生效。',
          '想让她在 QQ 上说话，装一个社区现成的 QQ 桥接插件（比如 qq-bridge），再把 qq_send_message, qq_get_unread_messages, qq_reply 加进表里。本插件不内置 QQ 协议。'),
        h('p', {
          className: 'hint',
          style: {
            margin: '10px 0 0',
            padding: '8px 10px',
            border: '.5px solid var(--dsw-alias-border-l2)',
            borderRadius: '8px',
          },
        },
        '不要把通用文件与命令工具加进来（read / write / edit / glob / grep / bash / run_code 这类）。它们不是按目录授权的：一放行，她就能读到自己的身份文档、配置和状态，等于绕过「不能读自己的数值与设定」；写入类还能绕过「不能改自己」。要看某个项目的源码，放行 web_fetch 让她从 GitHub 读，或者单独做一个只读的小工具。'),
        h('div', { style: { marginTop: '10px' } }, Toggle({
          label: '工具面收窄',
          hint: '关掉之后能看到 DSH 给的全部标准工具，工具定义会占掉每轮的一部分上下文。改动要重启才生效。',
          on: toolsRestrict,
          onChange: setToolsRestrict,
        })),
        h('div', { style: { marginTop: '14px', marginBottom: '6px', fontWeight: 600 } }, '工具表'),
        h('p', { className: 'hint', style: { margin: '0 0 8px' } },
          '名字来自宿主此刻的 registry，拼错的名字存不进去。「收窄挡不住」是注册在她自己作用域里的工具（ops_*、team_* 之类）——她本来就看得见，加进来只是让兜底守卫放行。'),
        h('div', { className: 'row', style: { gap: '8px', marginBottom: '8px' } },
          h('input', {
            type: 'text',
            value: toolQuery,
            placeholder: '搜工具名…',
            onChange: (e) => setToolQuery(e.target.value),
          }),
          h('span', { className: 'dim', style: { flex: '0 0 auto' } }, `${toolsRows.length} / ${toolsList.length}`)),
        !toolsList.length
          ? h('p', { className: 'empty' }, '宿主还没报过工具名。等她的会话起来一次，或者重启 DSH 再回来。')
          : (toolsRows.length ? h('div', null, toolsRows) : h('p', { className: 'empty' }, '没有匹配的名字。')),
        h('div', { className: 'row', style: { gap: '8px', marginTop: '10px' } },
          h('button', {
            type: 'button',
            onClick: saveTools,
            disabled: busy === 'tools',
            style: { flex: 'none', whiteSpace: 'nowrap' },
          }, busy === 'tools' ? '检查中…' : '保存'),
          h('span', { className: 'dim' }, '白名单只做加法：她自己的工具永远在，这里的名字是额外放行的。')),
        toolsSaveErr
          ? h('div', { style: { color: 'var(--dsw-alias-label-error, #d93f0b)', fontSize: '12.5px', marginTop: '6px' } }, toolsSaveErr)
          : null,
        toolsSaveNote
          ? h('div', { className: 'dim', style: { marginTop: '6px' } }, toolsSaveNote)
          : null)

      // 重置卡片单独提出来：它是唯一一个有破坏性的 ui，塞在那一长串 return 里
      // 很容易少/多一个括号（已经踩过：node --check 直接 SyntaxError）。
      // 会话被收起来时单独给一张卡：不藏在「重置」里，免得用户以为只能靠重开一局解决。
      const archivedCard = String(state?.home?.status ?? '') === 'archived'
        ? h('div', { className: 'card full' },
            h('h3', null, '会话归档'),
            h('div', { className: 'dim' },
              '你在侧栏把「跟她说话」归档了。从 0.6.8 起，插件不会自己偷偷再开一局——'
              + '收起来就该是收起来。要一局新的，点下面这个；状态、日记、记忆都不动。'),
            h('div', { className: 'dim' },
              '如果你只是把侧栏里的归档取消了，那不用点这里：下一次叫醒（或重启）就会自己认回来（0.6.29 起）。'),
            h('div', { className: 'row' },
              h('button', { onClick: doRebuild, disabled: !!busy },
                busy === 'rebuild' ? '搭屋中…' : '重新搭一间')))
        : null

      // 这个家在别处也开着（2026-10-29 m02162）：两个实例同时指向同一个 root 时，
      // 后进来的这边只读、不建会话。得让用户看见原因，否则他只会觉得「她又不见了」。
      // A17：不再单独开一张卡——收进数据页的「换家留痕」，那一条回答的是同一个问题：
      // 她现在住的这个家，是不是你以为的那个。
      const homeBlocked = state?.home?.blocked === true

      // 宿主兼容（2026-10-30 m02961）：宿主没提供 userQuestions 服务时降级，不报错。
      // 0.7.5 把它写进 inject 后，缺少该服务的宿主在 import 阶段就把插件整个跳过了（一行日志都不留）。
      // 0.8.1 改成运行时探测：装得进来，只是「她在会话里问你」这条路关着——必须说明白，不然像坏了。
      const compatCard = state?.compat?.userQuestions === false
        ? h('div', { className: 'card full' },
            h('h3', null, '这个宿主没提供「会话里问你」'),
            h('div', { className: 'dim' },
              '当前宿主里没有 userQuestions 这个服务：可能是版本旧，也可能是它没被装上。'
              + '插件照常跑，其它功能不受影响；只有她想在对话里直接问你（要不要带东西回家、解锁申请）时问不出去，她会改用留言。'),
            h('div', { className: 'dim' },
              '想恢复这条路：把 DSH 升到最新版再试。升级 DSH 不会动插件的数据目录，也不会动 cordis.patch.yml 里给插件配的 root。'))
        : null

      // 安装与宿主版本（A30）：升级自检与 DSH 版本下限合成一张。
      // 两件事都在回答「装进去的到底是不是我在改的这一份」，分开两张卡只会让人
      // 各看一半。只在真的对不上时出现：读不到宿主版本（桌面版装在 app.asar 里）
      // 不算问题，skipped 也不算。
      const upgradeBad = state?.upgrade?.stale === true
      const hostBad = state?.host && state.host.status !== 'supported' && state.host.status !== 'unknown'
      const installCard = (upgradeBad || hostBad)
        ? h('div', { className: 'card full' },
            h('h3', null, '安装与宿主版本'),
            upgradeBad
              ? h('div', null,
                  h('h4', null, state.upgrade.older ? '源目录里那份比正在跑的旧' : '升级没有真正装进去'),
                  h('div', { className: 'dim' }, state.upgrade.why || '版本对不上。'),
                  h('div', { className: 'dim' },
                    'DSH 加载的是 node_modules\\dsh-roost 里的副本，不是 profile 里写的那条源目录。'
                    + '只覆盖源目录，跑起来的还是旧的：没有报错、也没有日志，因为新代码根本没执行。'),
                  h('div', { className: 'dim' },
                    '修法：关掉 DSH → 在 profile 目录跑 pnpm install --force（或者删掉 node_modules\\dsh-roost）→ 再启动。'),
                  state.upgrade.sourcePath
                    ? h('div', { className: 'dim' }, `源目录：${state.upgrade.sourcePath}`)
                    : null)
              : null,
            hostBad
              ? h('div', null,
                  h('h4', null, state.host.status === 'older' ? '这个 DSH 版本比插件要求的还旧' : '这个 DSH 版本比插件认识的还新'),
                  h('div', { className: 'dim' },
                    `插件声明的范围：${state.host.range || '（未声明）'}；这台机器上是 ${state.host.version || '（读不到）'}。`),
                  h('div', { className: 'dim' },
                    state.host.status === 'older'
                      ? '旧版本里可能缺一些接口，出问题时先升级 DSH 再看。插件不会因此拒绝启动。'
                      : '新版本可能改了接口。插件照常跑，但这一组合没测过；出问题请把日志发我。'))
              : null)
        : null

      const resetCard = h('div', { className: 'card full' },
        h('h3', null, '从头开始'),
        h('div', { className: 'dim' },
          '这跟上面那张「重新搭一间」不是一回事：那个只换一条对话，数据一条不动；这个是真的从头开始。'),
        h('div', { className: 'dim' },
          '旧的一切不会删——整个状态库会被改名搬到同级的 dsh-roost-backups 里，想找回来整包搬回去就行。',
          '重开后是第一天，会重新从「你刚开始存在」开始。',
          '侧栏「她的家」里那些旧对话会被移进「已归档」，工作区留着；点完会开一条新会话，但要再点一下「叫醒她」，她开一次口，侧栏里才看得见（文件同样不删）。'),
        resetInfo ? h('div', { className: 'dim' },
          `现在有：事件 ${resetInfo.events} 条、日记 ${resetInfo.diaries} 天、报告 ${resetInfo.reports} 天。`) : null,
        h('div', { className: 'row' },
          !resetAsk
            ? h('button', { onClick: askReset, disabled: !!busy },
                busy === 'reset-ask' ? '读取中…' : '从头开始…')
            : h('span', null,
                h('span', { className: 'dim' }, '确定吗？'),
                h('button', { onClick: doReset, disabled: busy === 'reset' },
                  busy === 'reset' ? '搬走中…' : '确定，从头开始'),
                h('button', { onClick: () => { setResetAsk(false); setNote('没动。') } }, '算了'))))

      // 状态条与今天的时间线（2026-10-23 加）。全部来自宿主写下的 meta + 配置 + 时钟，
      // 她不参与，也不因此多跑任何一次模型。
      //
      // 2026-10-24：叫醒按钮从页签栏挪到这里，放在卡片右上角。
      // 页签栏是「切换看哪一页」的地方，混一个会真的触发动作的按钮，
      // 既容易误触，也不符合那一栏的语义。左边说状态、右边说「叫醒」，
      // 位置本身就说明了它是针对「现在这个状态」的操作。
      const phaseColor = { asleep: '#8a8a8a', waiting: '#b8860b', 'awake-idle': '#d97706', browsing: '#2563eb', talking: '#16a34a', writing: '#7c3aed', offline: '#9ca3af' }
      // 只有本机测试版（`.dev` 文件）才出现。判据来自服务端 /state 的 dev，
      // 不是前端猜的——正式版里这个字段恒为 false，按钮连节点都不生成。
      const browseBtn = state?.dev
        ? h('button', {
            className: 'ghost',
            onClick: browseNow,
            disabled: busy === 'wake-browse',
            style: { flex: '0 0 auto' },
            title: '测试用：绕过「今天该不该醒」，直接叫她去看一眼 B 站首页。',
          }, busy === 'wake-browse' ? '正在刷…' : '让她去刷 B 站')
        : null
      const wakeBtn = h('button', {
        className: 'ghost',
        onClick: wake,
        disabled: busy === 'wake',
        style: { flex: '0 0 auto' },
      }, busy === 'wake' ? '叫醒中…' : '现在叫醒她')
      // 2026-10-24：这张卡**始终渲染**。之前整块挂在 `st ? … : null` 上，状态还没读到时
      // 连「叫醒」按钮一起消失——一旦读取失败就没有入口，等于把人锁在门外。
      // 状态未知时说「读取中」，只有拿到状态才说「今天还没有动静」。
      // 头像（2026-10-24 用户 m03751）：插件包里**不带任何头像图片**。
      // 图片来源 `<数据文件夹>/avatar.<ext>`，没有就只画一个空圈 + 「鱼」字。
      // 为什么不内置一张好看的图：那张原图是画师原创角色，二创开放 ≠ 可再分发，
      // 打进包等于随插件分发别人的美术作品（见 docs/B-技术契约.md §41）。
      const avatarBox = h('div', {
        title: avatarPresent
          ? (`当前头像 ${avatarBytes} 字节。点「换头像」换一张。`)
          : '还没有头像。点「换头像」自己传一张（png / jpg / webp / gif，2MB 以内）。',
        style: {
          position: 'relative', width: '46px', height: '46px', borderRadius: '50%',
          flex: '0 0 auto', overflow: 'hidden', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(127,127,127,0.14)', color: '#9ca3af', fontSize: '17px',
        },
      },
        h('span', null, '鱼'),
        h('img', {
          src: API + '/avatar' + (avatarV ? `?v=${avatarV}` : ''),
          alt: '头像',
          onError: (e) => { e.currentTarget.style.display = 'none' },
          onLoad: (e) => { e.currentTarget.style.display = 'block' },
          style: { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', objectFit: 'cover' },
        }))

      const pickAvatar = (e) => {
        const f = e.target && e.target.files && e.target.files[0]
        if (e.target) e.target.value = ''
        if (!f) return
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.type)) {
          setAvatarNote('只支持 png / jpg / webp / gif。')
          return
        }
        if (f.size > 2 * 1024 * 1024) {
          setAvatarNote(`这张 ${Math.round(f.size / 1024)}KB，超过 2MB 上限。`)
          return
        }
        setAvatarBusy(true); setAvatarNote('')
        const reader = new FileReader()
        reader.onload = async () => {
          try {
            const r = await jpost('/avatar', { data: String(reader.result || ''), mime: f.type })
            if (r && r.ok) {
              setAvatarPresent(true)
              setAvatarBytes(Number(r.bytes) || 0)
              setAvatarV(Date.now())
              setAvatarNote('换好了。')
            } else {
              setAvatarNote(`没存上：${(r && (r.why || r.error)) || '再试一次'}`)
            }
          } catch (err) {
            setAvatarNote(`没存上：${err && err.message ? err.message : err}`)
          } finally {
            setAvatarBusy(false)
          }
        }
        reader.onerror = () => { setAvatarBusy(false); setAvatarNote('这个文件读不出来。') }
        reader.readAsDataURL(f)
      }

      const removeAvatarNow = async () => {
        setAvatarBusy(true); setAvatarNote('')
        try {
          await jpost('/avatar', { remove: true })
          setAvatarPresent(false)
          setAvatarBytes(0)
          setAvatarV(Date.now())
          setAvatarNote('已经去掉了。')
        } catch (err) {
          setAvatarNote(`没去掉：${err && err.message ? err.message : err}`)
        } finally {
          setAvatarBusy(false)
        }
      }

      const avatarCtl = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('label', { className: 'ghost', style: { cursor: 'pointer', fontSize: '12px' } },
          avatarBusy ? '上传中…' : '换头像',
          h('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            style: { display: 'none' },
            onChange: pickAvatar,
          })),
        avatarPresent
          ? h('button', { className: 'ghost', style: { fontSize: '12px' }, onClick: removeAvatarNow, disabled: avatarBusy }, '移除头像')
          : null,
        avatarNote ? h('span', { className: 'dim', style: { fontSize: '12px' } }, avatarNote) : null)

      const statusStrip = h('div', { className: 'card full' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
          avatarBox,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0', flex: '1 1 auto' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: st ? (phaseColor[st.phase] || '#9ca3af') : '#9ca3af', flex: '0 0 auto' } }),
              h('b', null, st ? st.label : '状态读取中…'),
              st && st.detail ? h('span', { className: 'dim' }, st.detail) : null),
            avatarCtl),
          browseBtn,
          wakeBtn),
        st
          ? (Array.isArray(st.timeline) && st.timeline.length
              ? h('div', { className: 'dim', style: { marginTop: '6px', fontSize: '12px', lineHeight: '1.75' } },
                  ...st.timeline.map((t, i) => h('div', { key: 'tl' + i }, t.text)))
              : h('div', { className: 'dim', style: { marginTop: '6px' } }, '今天还没有动静。'))
          : null)
      // ================================================================
      // 设置界面 2.0（2026-10-24 重做）
      //
      // 分组原则换了：上一版按「控件属不属于同一类」分（生长/上网/说话/数据），
      // 这一版按「这属于她生活里的哪一块」分——状态 / 成长 / 住所 / 上网 /
      // 记忆 / 插件 / 原理 / 数据。
      //
      // 两条硬规则（都是上一版踩过坑换来的）：
      //   1. **没有「全部」页**（用户 2026-10-24 要求删掉）。每个设置项必须归到
      //      某一页里，不许有哪一项只活在一个「万能页」上。
      //   2. **页签只用于聚焦，不用于隐藏**。删掉「全部」之后，每一页自己就得是
      //      完整的——不能出现「这一项要点两次才找得到」。
      //
      // 文案规则：
      //   · 每个分组标题下面一句人话，说清这一组管什么，不列字段清单；
      //   · 看不懂的词把定义放进 title（鼠标停上去就能看），不塞进正文占三行；
      //   · 面向用户的字符串里**不出现「她/他」**（test/p5.test.mjs 有硬断言）。
      // ================================================================

      // 2026-11-06（0.1.0 重建）：页签按「她的一天」排，不按配置分类。
      // 今天在最前、也是默认页——先看见她今天怎么过的，再决定要不要动环境参数。
      // 「记忆」不再单独一页：上下文与记忆条数并进「成长」，「记忆体检」并进「数据」。
      const TABS = [
        ['today', '今天'],
        ['now', '状态'],
        ['grow', '成长'],
        ['home', '住所'],
        ['social', '社会'],
        ['bili', '上网'],
        ['channels', '渠道'],
        ['env', '插件'],
        ['principle', '原理'],
        ['data', '数据'],
        ['feedback', '反馈'],
      ]

      // 只有这几个页签里的东西是「改完就写盘」的。没有设置项的页签（状态 / 住所 / 原理 / 数据）
      // 不显示那句提示；「插件」也不显示——工具面收窄要重启才生效，白名单要手动保存（2026-10-24 用户要求）。
      const AUTO_SAVE_TABS = new Set(['grow', 'bili'])

      const TAB_HELP = {
        today: '今天：醒了几次、做了什么、变了什么，手边有什么。只读，不放设置。',
        now: '现在是什么状态、走了多远、在守什么规矩，以及你不在的时候发生了什么。',
        grow: '怎么长大：时间尺度、每天经历多少、日记、隔几天回头想一次。改这些只会让她变快变慢，不会改变她是什么样。',
        home: '住在哪：工作区、会话、身份文件、日记、她留下的小纸条，以及一键自检。',
        bili: '上网：能不能刷 B 站、刷抖音、看多少、要不要看画面、避开哪些内容，以及 B 站登录。',
        channels: '渠道：QQ 怎么接、她能在哪些群开口，以及她现在认得谁。这里没有「她是什么样」的设置——那些只能长出来。',
        env: '插件：别的插件能往她上下文里塞什么工具，以及为什么默认只放她自己那几个。',
        principle: '原理：两张图讲清她怎么长大、记忆怎么被筛；每条设计从哪条理论来，以及这一套能用在什么场景。',
        data: '数据：都存在哪、每日报告、运行日志，以及重置（有破坏性的操作放在这一页最下面）。',
        feedback: '反馈：找开发者、进交流群。插件有问题、有想要的功能，都可以说。',
        social: '社会：她在外面（群聊、评论）学到的「怎么处世」，以及她自己有没有开门。开不开只能她决定——这一页只有看，没有按钮。',
      }

      // 阶段与门：写清楚，因为「下一个成长瓶颈」这几个字原来没人看得懂。
      // 四行措辞是用户在设置页上亲手写的（2026-10-24），已固化进源码，别再改回短的。
      // 四个阶段：文字跟三道瓶颈的进度实时走（设计 §四），不再手写死「两次推翻」。
      const gateNow = (name) => {
        const g = (s?.gates ?? []).find((x) => x.name === name)
        return g ? `${g.have}/${g.need}` : '…'
      }
      const STAGE_HELP = [
        '四个阶段按天推进，但每个瓶颈要自己突破。',
        `1 信任 · 先从所见所闻里形成一条自己拿着的判断（现在 ${gateNow('信任')}）`,
        `2 自主 · 明确拒绝过两次，说不出口就不算（现在 ${gateNow('自主')}）`,
        `3 主动 · 推翻或修正过两次自己的判断；让步最多只顶一次（现在 ${gateNow('胜任')}）`,
        '4 整合 · 前三个瓶颈都过了，之后才开始谈立场。',
      ].join('\n')
      const GATE_HELP = {
        trust: '信任：先从所见所闻里形成一条自己的判断——一条愿意被推翻的「我猜…」。',
        autonomy: '自主：得真的拒绝过两次——不是嘴上说不要，是明确不执行某件事。',
        competence: '主动：得两次推翻自己先前的判断，形成新的正确认知，不是光换个说法。',
      }
      // 「下一个成长瓶颈」原来直接印 stageGate.pending —— 那是 trust / autonomy / competence，
      // 用户看见的是英文（2026-10-24：「competence 是什么」）。宿主给的是技术名，
      // 显示层必须翻成人话；没收录的名字原样显示，绝不显示 undefined。
      const GATE_NAME = { trust: '信任', autonomy: '自主', competence: '主动' }
      // 2026-10-26 改（用户 m05785 / m05868）：原来这里写「越接近 1 越好」，那是错的。
      // 这三个数不是考卷分数，是体检值，各有各的两端：
      //   稳定 = 抽掉几条她还在拿着的判断，她还是不是她。太低说明那些判断只是记账，
      //          太高说明她整个人都压在少数几条上，少一条就是另一个人。
      //   一致 = 前后说法打不打架。高到 1.00 也可能是她一直没长新东西。
      //   新鲜 = 有没有一直在长新东西。
      // 2026-10-27 改（用户 m06107「这三个参数分成三行显示，现在排成一行有点拥挤」）：
      // 原来三个值挤在一条 rowTip 的值里，界面上是一长串；拆成三行，各自带自己的说明。
      // 「判断漂移」这个名字留在上方的副标题上，免得三行看起来像三个互不相干的数。
      const QUALITY_TITLE = '判断漂移（三个诊断值，不是分数）'
      const QUALITY_HELP = '这三个数都是 0 到 1 的体检值，不是越高越好：'
        + '稳定太低说明那些判断只是记账，太高说明她整个人压在这几条上；'
        + '一致高到 1.00 也可能是她一直没长新东西；'
        + '新鲜看她有没有一直在长新东西。'
        + '样本不够时这里会写一句话，而不是硬给一个 0.00。'
      const STABILITY_HELP = '少几条她信的事，她还是不是她。太低 = 那些判断只是记账、抽掉也不影响她；'
        + '太高 = 她整个人都压在少数几条上，少一条就是另一个人。'
      const CONSISTENCY_HELP = '她前后说法打不打架。跨阶段的话越多这个数越可信；'
        + '一句都没得比的时候会写「还没有跨阶段的话可比」。'
      const NOVELTY_HELP = '有没有一直在长新东西：最近七天说的话里，有多少句是以前没出现过的。'

      // 渠道健康（2026-11-06）：只报「多久以前」，不报 socket 状态——
      // 账本还热说明刚才还通过话；停了就停在旧时间上，这本身就是信息。
      const agoText = (iso) => {
        if (!iso) return '还没有'
        const ms = typeof iso === 'number' ? Date.now() - iso : Date.now() - Date.parse(iso)
        if (!Number.isFinite(ms)) return '还没有'
        if (ms < 60_000) return '刚刚'
        const m = Math.floor(ms / 60_000)
        if (m < 60) return `${m} 分钟前`
        const h = Math.floor(m / 60)
        if (h < 24) return `${h} 小时前`
        return `${Math.floor(h / 24)} 天前`
      }

      // 页签栏**只放页签**（2026-10-24）。
      // 原来这一行还挂着「现在叫醒她」和「保存」两个按钮，都被挪走了：
      //   · 叫醒 → 状态卡右上角，因为它是针对「现在这个状态」的动作；
      //   · 保存 → 删掉，因为每个设置页底部本来就有「保存改动」，
      //     顶上再放一个同样的按钮，只会让人猜「这两个是不是不一样」。
      const tabBar = h('div', { className: 'tabs' },
        ...TABS.map(([id, name]) => h('button', {
          key: id,
          className: 'tab' + (tab === id ? ' on' : ''),
          title: TAB_HELP[id] || '',
          onClick: () => setTab(id),
        }, name)),
      )

      // 一页里的一组设置。title 之外还可以给 note（这一组整体的一句话）。
      const group = (title, note, ...items) => h('div', { className: 'card' },
        h('h3', null, title),
        note ? h('p', { className: 'hint', style: { marginBottom: '10px' } }, note) : null,
        ...items)
      // 长内容（清单、事件流、信箱）横跨整行：内容多、又窄又高，两列反而更难读。
      const groupFull = (title, note, ...items) => h('div', { className: 'card full' },
        h('h3', null, title),
        note ? h('p', { className: 'hint', style: { marginBottom: '10px' } }, note) : null,
        ...items)

      // 一行「名称 — 值」，tip 存在时在值后面挂一个可悬停的 ⓘ。
      // 用它代替纯 kv：那一版用户看到「下一道门」和「稳定 0.87」都不知道在说什么。
      const rowTip = (k, v, tip) => h('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '13px', marginBottom: '5px' },
      },
        h('span', { style: { opacity: 0.65, flex: '0 0 auto', minWidth: '84px' } }, k),
        h('span', { style: { flex: '1' } }, v,
          tip ? h('span', { title: tip, style: { opacity: 0.45, marginLeft: '5px', cursor: 'help' } }, 'ⓘ') : null))

      // 2026-10-24（用户）：底部「保存改动」整组删掉。原来每个页签都挂一颗，
      // 让人以为必须先点；住所页根本没有设置项也挂着一颗。现在改完即存，
      // 没有设置的页签自然什么都不需要。

      // 数据文件夹路径一律由服务端 /paths 现算（用户 m03440）。
      // 原来这里按 workspace 目录名以 home 结尾去反推根目录、再用反斜杠拼子路径：
      // 目录一改名就推错，而且反斜杠是 Windows 假设。客户端不该重复实现服务端的事实。

      const copyPath = async (p) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(p)
            setNote('已复制到剪贴板。粘到资源管理器地址栏回车就能打开。')
          } else {
            setNote('这个环境不让写剪贴板，复制失败。')
          }
        } catch {
          setNote('这个环境不让写剪贴板，复制失败。')
        }
      }

      // 导出报告：纯前端拼一个 markdown 文件下载，不新开任何服务端路由。
      const downloadReport = () => {
        const md = reports?.md || ''
        if (!md) { setNote('还没有报告正文可导出。先点「每日报告」取一份。'); return }
        if (typeof document === 'undefined' || typeof Blob === 'undefined') { setNote('这个环境不支持下载。'); return }
        try {
          const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `报告-${reports.date || 'latest'}.md`
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 4000)
          setNote(`已导出 ${a.download}`)
        } catch (e) { setErr(e.message) }
      }


      // ---------------------------- 现在 ----------------------------
      // 三道瓶颈的进度：只用「已有/需要」，不给分数。
      const gatesByName = Object.fromEntries((s?.gates ?? []).map((g) => [g.name, g]))
      const gateOf = (name) => gatesByName[name] ?? { have: 0, need: 1 }

      const inboxCard = groupFull('她写的小纸条',
        '特意留给你的话。某种意义上代表她当前的状态，可能含有关键信息。',
        h('div', { className: 'row', style: { marginBottom: '8px' } },
          inbox && inbox.unread ? h('span', { className: 'badge', title: '有话留给你' }, `未读 ${inbox.unread}`) : null),
        !inbox ? h('p', { className: 'empty' }, '读取中…')
          : !inbox.rows.length ? h('p', { className: 'empty' }, '还没有留话。她想起你的时候会留一句。')
          : h('div', null,
              h('div', { className: 'row', style: { marginBottom: '8px' } },
                h('button', { onClick: markInbox, disabled: busy === 'inbox' || !inbox.unread },
                  inbox.unread ? '都看过了' : '已全部看过'),
                h('span', { className: 'dim' }, `共 ${inbox.total} 张 · 未读 ${inbox.unread} 张 · 也存了一份 ~/.dsh-roost/inbox.md`)),
              inbox.rows.slice(0, 20).map((r) => h('div', { key: r.id, style: { marginTop: '10px' } },
                h('p', { className: 'dim' },
                  `${String(r.ts || '').slice(0, 16).replace('T', ' ')}${r.unread ? ' · 未读' : ''}`),
                h('div', { className: 'said' }, esc(r.text))))),
      )

      // 她找你（2026-11-06，设计 §四）：原住所页的「她的请求」与「她写的小纸条」合成一张卡。
      // 两件事都是「她想让你知道 / 想问你」，所以放在状态页，不占住所。
      const sheSeekCard = groupFull('她找你',
        '她留下的话、想问你的事，都在这里。答不答、怎么答，还是你的事。',
        group('她的请求',
          '她有事想征求你同意的时候，会弹一张卡。这里能看到问过什么、你怎么答的；没答的可以在这里补答。一天最多一次，一周最多三次。',
          !asks ? h('p', { className: 'empty' }, '读取中…')
            : (() => {
                const pend = Array.isArray(asks.pending) ? asks.pending : []
                const items = (Array.isArray(asks.items) ? asks.items : []).slice().reverse()
                const wordOf = (a) => {
                  if (a.pending) return '还没答'
                  if (a.verdict === 'approve') return '可以'
                  if (a.verdict === 'reject') return '这次不行'
                  if (a.verdict === 'later') return '以后再说'
                  return ''
                }
                return h('div', null,
                  askMsg ? h('p', { className: 'hint' }, askMsg) : null,
                  pend.length
                    ? h('div', null,
                        h('p', { className: 'dim' }, '还没答的'),
                        ...pend.map((a) => h('div', { className: 'said', key: a.id },
                          esc(a.question),
                          h('div', { className: 'row', style: { marginTop: '6px' } },
                            ...(a.options?.length ? a.options : ['可以', '这次不行']).map((label, i) =>
                              h('button', {
                                key: `${a.id}-${i}`,
                                onClick: () => answerAsk(a.id, i === 0 ? 'approve' : i === 1 ? 'reject' : 'later'),
                              }, label)),
                            h('button', { className: 'ghost', onClick: () => answerAsk(a.id, 'later') }, '以后再说')))))
                    : h('p', { className: 'empty' }, '现在没有等你答的。'),
                  items.length
                    ? h('div', { style: { marginTop: '12px' } },
                        h('p', { className: 'dim' }, '最近的'),
                        ...items.slice(0, 8).map((a) => h('div', { className: 'said', key: a.id },
                          esc(a.question),
                          '　',
                          h('span', { className: 'tag' }, wordOf(a)))))
                    : null)
              })()),
        inboxCard)

      const nowPage = h('div', { className: 'page' },
        statusStrip,
        // 名字（2026-11-07）：说明放在状态页最上面——名字不是设置项，是对话里长出来的，
        // 用户得知道去哪儿改，不然侧栏叫「她」的时候会以为坏了。
        s ? h('p', { className: 'hint', style: { margin: '0 0 8px' } },
          s.herName
            ? `她叫「${s.herName}」——这是从你们对话里认出来的，不是设置项。想改名，在私聊或这里说一句「以后你就叫……」，侧栏的屋子名和会话名会跟着改。`
            : '她还没有名字，界面里先用「她」代称。名字不是设置项：在私聊或这里说一句「以后你就叫……」，这里和侧栏的屋子名就会跟着改。') : null,
        // 2026-11-02：天数与阶段只在最上面那行说一次（那一行所有页签都看得见）。
        // 这里原来又列了一遍「已过天数」「当前阶段」，同一屏出现两次同样的数字，
        // 用户 m02666 要求去掉重复项。这两个数的解释挂在标题行的 title 上即可。
        s ? group('状态',
          '这些数字都是宿主从她的事件流里算出来的，她看不见自己这些数。',
          rowTip('下一个成长瓶颈', s.pendingGate ? (GATE_NAME[s.pendingGate] || s.pendingGate) : '已走完', GATE_HELP[s.pendingGate] || '四个瓶颈都过了。'),
          rowTip('最近的判断', `${s.beliefCount} 条${s.solidCount ? `（其中 ${s.solidCount} 条记得很牢）` : ''}`, '她还在拿着的判断条数。更早的没丢，折进「更早以前」。记得很牢的是被反复提起或被反复检验过的。'),
          // 2026-10-24（P0）：她认知矛盾的两句话。只报事实，不给裁决按钮——
          // 哪句对她得她自己定；这里放个"选哪句"，就变成用户在替她长人格。
          s.tension
            ? rowTip('认知矛盾', `${s.tension.count} 处`, `「${s.tension.a}」和「${s.tension.b}」不能同时算数。她还没想清楚，可以直接问她。`)
            : rowTip('认知矛盾', '没有', '她说过的话之间，暂时没发现互相矛盾的地方。'),
          // 2026-10-24（P1 第三块）：疤。他顶回来或因此难过、而她后来还是让了的那次拒绝。
          // 只报"几件没想通"，不给"愈合"按钮——想通是她自己写一条 revise 的事。
          s.scarCount
            // 用「那个人」而不是「他」：用她的人可能是女性（2026-10-31 用户确认）。
            ? rowTip('没想通的事', `${s.scarCount} 件`, '那个人顶回来、或者因此难过之后，你后来还是让了的那几次。她没有忘，也没算成"已经过去了"。')
            : rowTip('没想通的事', '没有', '还没有哪次拒绝让她事后反悔。'),
          (s.stanceCount ?? 0) > 0
            ? rowTip('立场', `${s.stanceCount} 条`, '立场是在四个阶段都走完之后才开始产生的：喜欢什么、绝不做哪几件事。每条都有代价——要么栽过一次，要么同一件事她反复提起过。')
            : s.stanceReady
              ? rowTip('立场', '0 条', '完成整合，但暂未形成自己的立场。')
              : rowTip('立场', '还没开始', '要等四个阶段（信任 / 自主 / 主动 / 整合）都走完，立场才开始产生。'),
          rowTip('最近的称呼', s.name ? s.name : '还没想好', '她自己决定怎么称呼你。这个不是设置项，改不了。'),
          rowTip('冷落', s.absenceDays > 0 ? `${s.absenceDays} 天` : '没有', '你多久没说话了。超过门槛她会记下「你不在」。'),
          // 2026-11-06：把「互动计数」拆成两道——门进度是「还差什么才能往下走」，
          // 流水是「这一路都发生过什么」。混在一起时，数字看着像评分。
          rowTip('三道瓶颈', `信任 ${gateOf('信任').have}/${gateOf('信任').need} · 自主 ${gateOf('自主').have}/${gateOf('自主').need} · 胜任 ${gateOf('胜任').have}/${gateOf('胜任').need}`,
            '信任=她手上有一条自己拿着的判断；自主=她明确拒绝过两次；胜任=她推翻或修正过两次自己的判断（让步最多顶一次）。过了门，第二天才换阶段。'),
          rowTip('流水', `说 ${s.counts.utterance} · 改口 ${s.counts.revise} · 拒绝 ${s.counts.refusal} · 让步 ${s.counts.conceded ?? 0}${s.counts.concededPublic ? `（当众 ${s.counts.concededPublic}）` : ''} · 重聚 ${s.counts.reunion}`, '这些只是发生过多少次，不是分数。说=她写过几句自己的判断（含留话）；改口=按照规则推翻历史认知并指明改的是哪条；拒绝=她明确登记拒绝过什么；让步=她收回或认错过几次；重聚=久别之后她自己写下的感受。'),
          rowTip('渠道', s.qq ? (s.qq.enabled
            ? `QQ · 收到 ${agoText(s.qq.lastIn)} · 发出 ${agoText(s.qq.lastOut)}`
            : 'QQ 关着') : '没有开渠道',
            '只看账本上最近一次收到和发出是什么时候，不代表桥现在连着。她想说话却发不出去，这里会停在旧时间上。'),
          s.quality ? rowTip('判断漂移',
            `稳定 ${qStability(s.quality.stability)} · 一致 ${qConsistency(s.quality.consistency)} · 新鲜 ${qNovelty(s.quality.novelty)}`,
            `${QUALITY_TITLE}。${QUALITY_HELP} 稳定=抽掉几条判断后她还是不是她；一致=她前后的话对不对得上；新鲜=她还在不在用新的说法。`) : null) : null,

        // ---- 规则（R3，2026-10-24） ----
        // 这一块**只读 + 裁决**：没有新建、没有编辑。
        // 规则不是设置项——能在这里改规则，就等于能在这里改她。
        rules ? group('规则约束',
          '四层：物理层（代码保证，不进提示词）、契约层（不许把关系变成分数）、起点层（一开始是谁）、成长层（可以自己申请）。'
            + (rules.offersOn === false ? '成长层的申请通道现在关着（已有的不会撤销）。' : ''),
          rules.pending ? h('div', {
            style: {
              border: '1px solid rgba(127,127,127,.35)',
              borderRadius: '8px',
              padding: '10px 12px',
              marginBottom: '10px',
            },
          },
            h('p', { style: { margin: '0 0 6px' } }, `她提了一个申请：${(rules.pending.why || '').slice(0, 160)}`),
            h('div', { className: 'row', style: { gap: '8px' } },
              h('button', { className: 'btn', onClick: () => decide('approve') }, '可以'),
              h('button', { className: 'btn', onClick: () => decide('reject') }, '这次不行'),
            ),
          )
          // 没有待裁决的申请就**什么都不渲染**（2026-10-24 用户提出）：
          // 原来这里常驻一句「目前没有待处理的申请」，等于在规则卡里放一个空待办，
          // 看久了会训练人忽略这张卡。通道关着这件事并进卡片说明行，不单独占一行。
          : null,
          ...(rules.layers || []).map((L) => h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 600 } }, `${L.name}${L.mutable ? '（可以长）' : '（不会变）'}`),
            h('div', { style: { opacity: 0.75, fontSize: '12px', marginTop: '2px' } }, L.note),
            ...L.rules.map((r) => {
              const st2 = (rules.status || []).find((x) => x.id === r.id)
              const tail = st2?.active ? ' · 已经可以了' : (st2?.ready ? ' · 条件够了，等她开口' : '')
              return h('div', { style: { fontSize: '12px', marginTop: '4px' } },
                `· ${r.title}${r.inPrompt ? '' : '（不进提示词）'}${tail}`)
            }),
          ))) : null,

        // ---- 你不在的时候 ----
        away && away.days >= 1 && !away.quiet
          ? group('你不在的时候',
              '不推送，回来了就在这里告诉你错过了什么。',
              h('div', { className: 'kv' },
                h('b', null, '醒了'), h('span', null, `${away.wakes} 次`),
                // 2026-10-30：原来这里只有「看了 N 条」，数的是刷站记账——
                // 那是"翻到过"，不是"看过画面"。两件事分开说，别让她被冤枉。
                h('b', null, '看过画面'), h('span', null, `${away.watched ?? 0} 条`),
                h('b', null, '翻到过'), h('span', null, `${away.videos} 条`),
                h('b', null, '说了'), h('span', null, `${away.said} 句`),
                h('b', null, '日记'), h('span', null, away.diaries ? `${away.diaries} 篇` : '没写')),
              h('p', { className: 'hint' }, '日记只报篇数——内容给不给你看，还是那个开关的事。'))
          : null,
        sheSeekCard)

      // ---------------------------- 生长 ----------------------------
      const growPage = h('div', { className: 'page' },
        groupFull('四个阶段与三道瓶颈',
          '按天推进的部分只是时间尺度；真正决定走到哪一步的，是自己做过的事。',
          h('div', { style: { fontSize: '13px', lineHeight: '1.9', opacity: 0.85 } },
            ...STAGE_HELP.split('\n').map((line, i) => h('div', { key: 'sh' + i }, line)))),
        group('成长节奏设置',

          '这几个数决定「她用多少天走完四个阶段」。调大只是把速度变慢，不影响流程。',
          h('div', { className: 'grid2' },
            Num({ label: '多久走完四个阶段（阶段天数尺子）', value: stageSpanDaysUi, onChange: setStageSpanDaysUi, min: 7, max: 180, unit: '天',
              hint: '它是阶段天数的尺子，不是「最多只能活这么多天」。调大只是把速度放慢，不影响流程；每个阶段什么时候到，还是看她自己做没做到。' }),
            Sel({ label: '每天最多主动醒来', value: wakes, onChange: setWakes, options: [0, 1, 2, 3, 4],
              fmt: (v) => (Number(v) === 0 ? '0 次 · 只有你找她时才在' : `${v} 次`),
              hint: '醒来 = 自己启动过一段时间。次数多不等于成长速度快和效果好，次数过多每次唤醒时间会变短' }),
            TimeRange({ label: '每天几点醒', from: wakeFrom, to: wakeTo, onFrom: setWakeFrom, onTo: setWakeTo,
              hint: '只在这个时段里自己醒。跨零点也可以（比如 22:00 到 02:00）。' }),
            Num({ label: '她一轮最多写多少字', value: replyChars, onChange: setReplyChars, min: 0, max: 2000, unit: '字',
              hint: '0 = 不限，提示词里完全不提长度，长短由她自己决定。填了就对随后的对话生效。' }))),
        group('每日事件设置',
          '这些只是上限，不是任务。系统随机递来的事件是「由头」——让她有个契机自己想一想，不保证每天都有。',
          h('div', { className: 'grid2' },
            Sel({ label: '每天最多推几条成长事件', value: eventsPerDay, onChange: setEventsPerDay, options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 条 · 不主动推' : `${v} 条`),
              hint: '上限，不是配额。0 条不会变傻，只是那天没有由头。' }),
            Sel({ label: '会向你进行几次提问', value: questionsPerDay, onChange: setQuestionsPerDay, options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 条 · 从不主动问' : `${v} 条`),
              hint: '问多了会退化成问答机器。建议不超过成长事件数的一半。' }),
            Num({ label: '你多久不出现算冷落', value: absent, onChange: setAbsent, min: 1, max: 30, unit: '天',
              hint: '超过这么多天没说话，她会记下「你不在」。' }))),
        // 主动说话（0.8.1 本机实验）：只有 .dev 下才出现。频率是上限，不是任务——
        // 说不说由她自己判断（见 lib/proactive.js）。2026-11-06（设计 §四）：删掉总开关，
        // 只留 1–6 的上限；minIdleHours 内部默认约 3 小时，不放界面。
        state?.dev === true ? group('主动说话（本机实验）',
          '她想说话的时候可以自己开口，不是被提醒推着说。这里调的是「最多说几次」——上限不是任务，说不说由她自己判断。',
          h('div', { className: 'grid2' },
            Sel({ label: '一天最多几次', value: proactiveMax,
              onChange: (v) => { setProactiveMax(v); patchProactive({ enabled: true, maxPerDay: Number(v) }) },
              options: [1, 2, 3, 4, 5, 6],
              fmt: (v) => `最多 ${v} 次`,
              hint: '上限不是任务。到了上限只是不能再开新的空手回合，第二天照常。' }))) : null,
        group('日记',
          '她每天会写日记。打开下面那个开关，你就能看。',
          h('div', { className: 'grid2' },
            Toggle({ label: '写日记', on: diaryEnabled,
              onChange: (v) => { setDiaryEnabled(v); patchDiary({ enabled: v }) },
              hint: '关掉后不再写新的，已经写好的不会删。' }),
            Toggle({ label: '让我看日记', on: diaryVisible,
              onChange: (v) => { setDiaryVisible(v); patchDiary({ visible: v }) },
              hint: '打开即时生效，之前错过的日记看不到，只能看到以后的日记，关闭的话就是盲盒体验' }),
            Sel({ label: '日记留多久', value: diaryKeep,
              onChange: (v) => { setDiaryKeep(v); patchDiary({ keepDays: Number(v) }) },
              options: [0, 30, 90, 365, 3650],
              fmt: (v) => (Number(v) === 0 ? '永久保留' : `${v} 天`),
              hint: '超期的日记按天清掉，不占地方。想看历史就选永久。' }))),
        group('深度思考与学习',
          '隔几天她会自己把最近的碎片压成一段自述（我之前……我曾经……），形成初始认知。并非总结报告。',
          h('div', { className: 'grid2' },
            Num({ label: '每几天回头想一次', value: sleepEvery, onChange: setSleepEvery, min: 0, max: 60, unit: '天',
              hint: '0 = 不主动想。想的时候复用一次晚间唤醒，不额外多跑一次模型。' }),
            Num({ label: '总共留几条自述', value: sleepKeep, onChange: setSleepKeep, min: 0, max: 100, unit: '条',
              hint: '超出后最早的折进「更早以前」，不删。' })),
          h('p', { className: 'dim', style: { marginTop: '6px' } },
            mem?.sleep?.last
              ? `上次压：${String(mem.sleep.last).slice(0, 10)}${mem.sleep.everyDays > 0 ? ` · 下次约 ${mem.sleep.everyDays} 天后` : ''}`
              : '还没压过。')),
        group('上下文',
          '一个侧栏会话聊到几百轮，上下文必然撑爆——不是变慢，是每轮都为几十万字付费，最后直接失败。',
          h('div', { className: 'grid2' },
            Num({ label: '聊满多少轮换新会话', value: rotateAfter, onChange: setRotateAfter, min: 0, max: 500, unit: '轮',
              hint: '请在不断的循环中，找到能引发本质变化的唯一解。0 = 永不换。上下文占满后会将当前已形成的核心认知和初始信息，作为提示词带到新会话。' }),
            Num({ label: '单次上下文限制（身份文档多少字）', value: docBudget, onChange: setDocBudget, min: 600, max: 4000, step: 100, unit: '字',
              hint: '超了按照规则遗忘部分认知/经历；「初始人格」和四条禁令不会遗忘。根据经历不同，部分认知可能会变成永久记忆不再遗忘。' }))),

        // ---- 记忆（原「背了多少东西」） ----
        // 全是客观计数：多少字、占预算几成、多少条被挤掉。
        // 刻意不出现任何"打分"型指标（那属于 N2 禁止的量化评价）。
        group('记忆',
          '当前上下文占用量，查看哪些变为「记不太清」的「久远回忆」。',
          h('div', { className: 'grid2', style: { marginBottom: '10px' } },
            Num({ label: '每轮对话认知记忆条数', value: beliefsShown, onChange: setBeliefsShown, min: 1, max: 8, unit: '条',
              hint: '调整的是她能记住多少自己的定论/判断/信念。数值越大记得越多，更不容易遗忘，但是要消耗更多token，默认推荐3.' }),),
          !mem ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
                h('div', { className: 'row', style: { alignItems: 'center', gap: '10px' } },
                  h('div', { className: 'bar', style: { flex: '1', height: '8px', background: 'rgba(127,127,127,.25)', borderRadius: '4px', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        width: `${Math.round((mem.selfDoc?.usedRatio ?? 0) * 100)}%`,
                        height: '100%',
                        background: (mem.selfDoc?.usedRatio ?? 0) > 0.95 ? '#c0562f' : '#4a7',
                      },
                    })),
                  h('span', { className: 'dim' },
                    `${mem.selfDoc?.chars ?? 0} / ${mem.selfDoc?.budget ?? 0} 字`)),
                h('div', { style: { fontSize: '12px', lineHeight: '1.9', marginTop: '8px', opacity: 0.85 } },
                  h('div', null, `· 判断：最显著的 ${mem.sections?.beliefsShown ?? 0} 条在眼前，${mem.sections?.beliefsFolded ?? 0} 条折成一行`),
                  // 2026-10-24（P0）：遗忘从"按时间截断"改成"按显著性"，
                  // 并新增两类事实——固化的条数、她认知矛盾的处数。
                  h('div', null, `· 记得很牢 ${mem.sections?.solid ?? 0} 条 · 认知矛盾 ${mem.sections?.tensions ?? 0} 处`),
                  mem.sections?.tensionFirst
                    ? h('div', { className: 'dim' }, `　「${mem.sections.tensionFirst.a}」／「${mem.sections.tensionFirst.b}」`)
                    : null,
                  // 「被推翻」→「认知重构」、「拒绝过」→「勇于拒绝」（2026-10-24 用户改的字）；
                  // 「想改自己」整条删掉（用户：感觉没有意义）。数还在后端，只是不再显示。
                  h('div', null, `· 认知重构 ${mem.sections?.refuted ?? 0} · 勇于拒绝 ${mem.sections?.refused ?? mem.sections?.refusals ?? 0}`),
                  h('div', null, `· 立场 ${mem.sections?.stanceCount ?? 0} 条${(mem.sections?.stanceCount ?? 0) ? `（不做 ${mem.sections?.stanceNevers ?? 0} · 喜欢 ${mem.sections?.stanceLikes ?? 0}）` : ''}`),
                  // 评论区里别人的话（2026-10-24，用户 m02454）：读到 ≠ 认同。
                  // 只有"她也这么说过"才算认下——那一条本来就已经算在判断里了，这里不重复计数。
                  h('div', null, `· 读到别人的说法 ${mem.sections?.voices ?? 0} 条${(mem.sections?.voicesEchoed ?? 0) > 0
                    ? `（其中 ${mem.sections.voicesEchoed} 条她后来自己也这么说）`
                    : ''}`),
                  mem.sections?.voiceLast
                    ? h('div', { className: 'dim' }, `　最近读到：「${mem.sections.voiceLast.text}」${mem.sections.voiceLast.echoed ? '（她认下了）' : ''}`)
                    : null,
                  h('div', null, `· 记下的事：${mem.events ?? 0} 条 · 日记 ${mem.diaries ?? 0} 篇`),
                  h('div', null, `· 这条会话：${mem.session?.rotateAfter > 0
                    ? `${mem.session?.turns ?? 0} / ${mem.session.rotateAfter} 轮，满了自动换新会话`
                    : '不自动换'}`),
                  h('div', null, `· 回头想：${(mem.sleep?.everyDays ?? 0) > 0
                    ? `每 ${mem.sleep.everyDays} 天一次${mem.sleep.last ? `，上次 ${mem.sleep.last}` : ''}`
                    : '不主动想'}`)),
                (mem.selfDoc?.dropped || []).length
                  ? h('p', { className: 'dim', style: { marginTop: '6px' } },
                      `这一段正在被预算挤掉：${mem.selfDoc.dropped.join('、')}。想把它们放回来，把「单次上下文限制」调大。`)
                  : null,
                h('p', { className: 'dim', style: { marginTop: '8px' } },
                  '记忆深刻的认知详细记录；普通认知只有一句话，超出上下文的不重要记忆被折叠，被模糊（不是完全消失，只是可能记不太清）。被反复提起、或被反复检验过的会固定下来（记得很牢）——固定只代表她忘不掉，不代表那句是对的。'),
                h('p', { className: 'dim', style: { marginTop: '6px' } },
                  '为什么这样做？1.节省token成本2.全量记忆等于提示词污染/强调，会让人格的改变无从发生3.在遗忘发生时，什么能够留下来才是更显珍贵的。'))),

        // 正文从住所页挪来（2026-11-06）：设置留在上面，内容在这里翻。
        group('她写的日记',
          '她每天写的日记。只在上面那个「让我看日记」打开时才给你看，一天一页，多天时可以翻。',
          !diary ? h('p', { className: 'empty' }, '读取中…')
            : !diary.enabled ? h('p', { className: 'empty' }, '没在写日记。')
            : !diary.visible ? h('p', { className: 'empty' },
                `已写 ${(diary.lockedDates || []).length} 天，但设置里是不给你看。`)
            : !diaryDates.length ? h('p', { className: 'empty' }, '还没写')
            : h('div', null,
                diaryDates.length > 1
                  ? h('div', { className: 'row pager' },
                      h('button', {
                        className: 'ghost',
                        disabled: diaryIdx >= diaryDates.length - 1,
                        onClick: () => setDiaryDay(diaryIdx + 1),
                      }, '← 更早'),
                      h('span', { className: 'dim' }, `${diaryCur}　${diaryIdx + 1} / ${diaryDates.length}`),
                      h('button', {
                        className: 'ghost',
                        disabled: diaryIdx <= 0,
                        onClick: () => setDiaryDay(diaryIdx - 1),
                      }, '更晚 →'))
                  : h('p', { className: 'dim' }, diaryCur),
                diaryCache.current[diaryCur] === undefined
                  ? h('p', { className: 'empty' }, '读取中…')
                  : h('pre', null, esc(diaryCache.current[diaryCur])))),
        groupFull('她知道的事（世界书）',
          '这是知识，不是人格：她住哪、公司在几楼、你们养过什么猫——这些都可以写。写「她是一个温柔的人」不行。导入 SillyTavern 的世界书，她说话时会按关键词取几条带上。',
          !wb ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
              h('p', { className: 'dim' }, `目前 ${wb.stats?.count ?? 0} 条，启用 ${wb.stats?.enabled ?? 0} 条，共 ${wb.stats?.chars ?? 0} 字。`),
              h('div', { className: 'row', style: { gap: '8px', marginTop: '6px', flexWrap: 'wrap' } },
                h('input', {
                  type: 'text',
                  value: wbKey,
                  placeholder: '触发词：提到这些词时她想起这条',
                  onChange: (e) => setWbKey(e.target.value),
                  style: { flex: '0 0 220px' },
                }),
                h('input', {
                  type: 'text',
                  value: wbFact,
                  placeholder: '一句事实：公司三楼靠窗、猫叫豆子',
                  onChange: (e) => setWbFact(e.target.value),
                  style: { flex: '1 1 320px' },
                }),
                h('button', {
                  type: 'button',
                  disabled: wbBusy === 'add' || !String(wbKey ?? '').trim() || !String(wbFact ?? '').trim(),
                  onClick: () => { void addWb() },
                }, wbBusy === 'add' ? '添加中…' : '加一条')),
              h('textarea', {
                value: wbText,
                rows: 4,
                placeholder: '把世界书的 JSON 粘在这里（SillyTavern 导出的 lorebook，或 [{ "key": [...], "content": "…" }] 数组）',
                onChange: (e) => setWbText(e.target.value),
                style: { width: '100%', marginTop: '6px' },
              }),
              h('div', { className: 'row', style: { gap: '8px', marginTop: '6px' } },
                h('button', {
                  type: 'button',
                  disabled: wbBusy === 'import' || !String(wbText ?? '').trim(),
                  onClick: () => { void importWb() },
                }, wbBusy === 'import' ? '导入中…' : '导入'),
                h('button', {
                  type: 'button',
                  disabled: wbBusy === 'clear' || !(wb.stats?.count ?? 0),
                  onClick: () => { void clearWb() },
                }, '清空')),
              (wb.entries ?? []).length
                ? h('div', { style: { marginTop: '8px' } },
                  ...(wb.entries ?? []).slice(0, 8).map((e) => h('div', { key: e.id, className: 'dim', style: { marginBottom: '3px' } },
                    `${(e.keys ?? []).join(' / ')} — ${String(e.text ?? '').slice(0, 40)}…`)))
                : h('p', { className: 'empty' }, '还是空的。'))),
        )

      // ---------------------------- 住所 ----------------------------
      // 这一页回答的是「东西都在哪」，不是「怎么调她」。
      // 请求事件：在住所页补答（弹卡超时之后仍能答；答过的不再改）。
      async function answerAsk(id, verdict) {
        try {
          const r = await jpost('/ask', { action: 'answer', askId: id, verdict })
          setAsks(await jget('/ask'))
          if (r?.ok) setAskMsg('答好了。')
          else setAskMsg(String(r?.why || '没答上。'))
        } catch (e) {
          setAskMsg(`没答上：${e.message}`)
        }
      }

      const homePage = h('div', { className: 'page' },
        group('她住在哪',
          '侧栏里新增工作区和新增会话，就是她的房间。',
          !home ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
                rowTip('工作区', home.workspace?.ok ? '已建好' : '没建起来（宿主没有 workspaceRegistry）',
                  '侧栏里叫「她的家」那个工作区。'),
                rowTip('会话', home.session?.ok ? '「跟她说话」那条' : '没建起来，下面有备用框',
                  '每天醒来说的话都落在这条会话里。满了会自动换新的，旧的改名留档。'),
                rowTip('身份文件', home.selfDoc?.exists ? `${home.selfDoc.bytes} 字节` : '还没有',
                  '身份通过 system prompt 送给她，不进对话历史；这里是它的落盘副本。'),
                rowTip('身份文件预算', mem?.selfDoc
                  ? `${mem.selfDoc.chars ?? 0} / ${mem.selfDoc.budget ?? 0} 字（${Math.round((mem.selfDoc.usedRatio ?? 0) * 100)}%）`
                  : '读取中…',
                  '超过预算时会把次要的段落挤掉——挤掉的只是这份副本，记忆还在事件流里，她翻得到。'),
                // 会话健康（2026-11-06，设计 §四）：连续两次没送进去会自动换会话；
                // 这里给人看的是「现在还正不正常」，以及一个手动换的入口。
                rowTip('会话健康',
                  home.session?.ok
                    ? ((home.session.failStreak ?? 0) >= 2
                      ? `连着 ${home.session.failStreak} 次没送进去；再失败一次就自动换会话`
                      : (home.session.failStreak ?? 0) === 1
                        ? '上一条没送进去，再失败一次就自动换会话'
                        : (home.session.lastFailAt ? '上一次没送进去，已经恢复' : '正常'))
                    : '这条会话没接上',
                  home.session?.ok
                    ? `这条会话 ${home.session.turns ?? 0} 轮${home.session.rotateAfter > 0 ? ` / ${home.session.rotateAfter} 轮后自动换` : ''}${home.session.rotatedAt ? ` · 上次换会话 ${String(home.session.rotatedAt).slice(0, 10)}` : ''}${home.session.lastFailAt ? ` · 上次没送进去 ${String(home.session.lastFailAt).slice(0, 16).replace('T', ' ')}` : ''}`
                    : '会话没建起来，下面的备用框还能说话。'),
                home.session?.ok
                  ? h('div', { className: 'row', style: { marginTop: '10px' } },
                      h('button', {
                        type: 'button',
                        className: 'ghost',
                        disabled: busy === 'rotate',
                        onClick: doRotate,
                      }, busy === 'rotate' ? '正在换…' : '换一条新会话'),
                      h('span', { className: 'dim' }, '聊不动了才用。旧会话改名留在侧栏里。'))
                  : null,
                home.session?.ok ? null : group('备用说话入口',
                  '侧栏里没找到那条对话，所以这里留一个能说话的框。',
                  h('div', { className: 'form' },
                    h('textarea', {
                      value: sayText,
                      placeholder: '说点什么。她会按自己的方式回——也可能不回。',
                      onChange: (e) => setSayText(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
                      },
                    }),
                    h('div', { className: 'row' },
                      h('button', { onClick: send, disabled: busy === 'say' || !sayText.trim() },
                        busy === 'say' ? '等她想想…' : '说给她'),
                      h('span', { className: 'dim' }, 'Ctrl+Enter 发送。'))),
                  said.length
                    ? h('div', { style: { marginTop: '10px' } },
                        h('p', { className: 'dim' }, '她刚刚说的'),
                        ...said.map((x) => h('div', { className: 'said', key: x.id }, esc(x.text))))
                    : null))),

        )

      // ---------------------------- 上网 ----------------------------
      // 视频观看历史分页（2026-10-28 用户 m00416；当晚按用户反馈改成「随量自适应」）：
      // 0.6.6 之前是「按天分组、每页三天」——一天刷 10 条、查 3 天就是 30 条挤在一屏。
      // 现在**按条翻页**，并且每页条数不是一个死数字，而是按「一天实际刷几条」分档：
      //   一共 ≤ 8 条 → 一页全放下，连翻页条都不出（别让人看到「第 1 / 1 页」这种噪音）；
      //   日均 > 20 条 → 6 条/页；> 10 → 8 条；> 5 → 10 条；其余 12 条。
      // 也就是刷得越密、每页越短：重度用户一屏不会顶到十几条，轻度用户又不用为翻页而翻页。
      const HIST_PAGE_MAX = 12
      const histFlat = (hist?.groups || []).flatMap((g) =>
        (g.items || []).map((it) => ({ ...it, date: g.date })))
      const histDayCount = (hist?.groups || []).length
      const histTotal = histFlat.length
      const histPerDay = histDayCount ? histTotal / histDayCount : 0
      const histPageSize = histTotal === 0 ? HIST_PAGE_MAX
        : histTotal <= 8 ? histTotal
          : histPerDay > 20 ? 6
            : histPerDay > 10 ? 8
              : histPerDay > 5 ? 10
                : HIST_PAGE_MAX
      const histPages = Math.max(1, Math.ceil(histTotal / histPageSize))
      const histAt = Math.min(histPage, histPages - 1)
      const histSlice = histFlat.slice(histAt * histPageSize, histAt * histPageSize + histPageSize)
      const histPager = histPages > 1
        ? h('div', { className: 'row' },
          h('button', { disabled: histAt <= 0, onClick: () => setHistPage(histAt - 1) }, '较新'),
          h('span', { className: 'dim' }, `第 ${histAt + 1} / ${histPages} 页 · 一页 ${histPageSize} 条`),
          h('button', { disabled: histAt >= histPages - 1, onClick: () => setHistPage(histAt + 1) }, '更早'))
        : null

      // 带提交时机的输入框：打字过程中不提交；离开输入框、按回车、或点「保存」时才写一次。
      // 2026-11-02（用户 m02861）：原来只有 onBlur，填完直接重启就丢了。「保存」按钮是给那种情况的。
      const commitInput = (label, hint, value, onCommit, opts = {}) => {
        const fire = (el) => {
          const next = String(el?.value ?? '').trim()
          if (next !== String(value ?? '')) onCommit(next)
        }
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, label),
            hint ? h('span', { className: 'fhint' }, hint) : null),
          h('div', { className: 'row', style: { gap: '8px', alignItems: 'center' } },
            h('input', {
              type: opts.password ? 'password' : 'text',
              key: `${label}:${value}`,
              defaultValue: value,
              placeholder: opts.placeholder ?? '',
              autoComplete: 'off',
              style: { flex: '1' },
              onBlur: (e) => fire(e.target),
              onKeyDown: (e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                fire(e.target)
                e.target.blur()
              },
            }),
            h('button', {
              type: 'button',
              className: 'btn',
              title: '写进配置文件',
              onClick: (e) => fire(e.currentTarget.parentElement.querySelector('input')),
            }, '保存')))
      }

      const biliPage = h('div', { className: 'page' },
        // 登录（2026-11-06）：从渠道页搬回这里。她自己上网用的是这个号，不是「渠道」——
        // 渠道只剩 QQ，B 站是材料。
        group('B 站登录',
          '她刷视频、看画面用的是这个号，建议放一个小号。扫码是最省事的；扫不了再手动贴 cookie。',
          h('div', { className: 'dim', style: { marginBottom: '8px' } },
            ow?.hasCookie
              ? `已登录${ow?.account?.name ? `：${ow.account.name}${ow.account.mid ? `（uid ${ow.account.mid}）` : ''}` : '（还没认过账号，点下面测一下）'}${ow.hasCsrf ? '' : '；少了 bili_jct，不能发评论'}。`
              : '还没登录。'),
          h('div', { className: 'row', style: { gap: '8px', alignItems: 'center' } },
            h('button', {
              type: 'button',
              disabled: qr?.status === 'loading',
              onClick: () => { void startQr() },
            }, qr?.status === 'loading' ? '正在要二维码…' : qr?.done ? '重新要一张' : '扫码登录'),
            qr?.note ? h('span', { className: 'dim' }, qr.note) : null),
          qr?.svg
            ? h('div', { style: { marginTop: '8px', display: 'flex', gap: '12px', alignItems: 'flex-start' } },
              h('img', {
                src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`,
                width: 180, height: 180, alt: 'B 站登录二维码',
                style: { background: '#fff', borderRadius: '6px' },
              }),
              h('div', { className: 'dim' },
                qr.status === 'scanned' ? '扫到了，等你在手机上点确认。' : '用手机 B 站扫这张码。',
                h('div', null, '二维码两分钟内有效；过期就重新要一张。'),
                h('div', null, '登的是哪个号，回来这里就能看到。')))
            : null,
          h('details', { style: { marginTop: '8px' } },
            h('summary', { className: 'dim', style: { cursor: 'pointer' } }, '扫码不行？手动贴一段 cookie（旧办法）'),
            h('div', { style: { marginTop: '8px' } },
              h('textarea', {
                rows: 3,
                value: owCookie,
                placeholder: 'SESSDATA=...; bili_jct=...',
                onChange: (e) => setOwCookie(e.target.value),
              }),
              h('div', { className: 'hint', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } },
                String(ow?.hint ?? '').split('\n').map((line, i) => h('div', { key: i }, line))),
              h('div', { className: 'row', style: { marginTop: '8px' } },
                h('button', { className: 'btn', onClick: saveOwnerCard, disabled: busy === 'owner' },
                  busy === 'owner' ? '保存中…' : '保存 cookie'),
                h('button', { className: 'btn', onClick: testOwner, disabled: busy === 'owtest' },
                  busy === 'owtest' ? '测试中…' : '测一下这个 cookie'),
                owNote ? h('span', { className: 'dim' }, owNote) : null)))),
        group('能不能上网',
          '关掉之后 B 站、抖音一起停，连她手里的浏览工具也不再放行；醒来、说话、写日记照旧。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许她上网（总闸）', on: browseOn, onChange: setBrowseOn,
              hint: '这是材料层的总开关，连同浏览类工具一起关。关了就只看你递给她的东西。' }),
            TimeRange({ label: '上网时间段（只拦逛）', from: browseFrom, to: browseTo, onFrom: setBrowseFrom, onTo: setBrowseTo,
              hint: '只拦逛首页、排行、推荐流这类闲逛。你递进来的链接、她主动去看某一条，不受这个时段限制。' }))),
        group('频率设置',
          '只能修改环境参数——至于看什么内容，由她决定。',
          h('div', { className: 'grid2' },
            Sel({ label: '每天最多刷几次（B 站 + 抖音）', value: browsePerDay,
              onChange: (v) => { setBrowsePerDay(Number(v)); setDyBrowsePerDay(Number(v)); patchDyBrowsing({ perDay: Number(v) }) },
              options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 次 · 从不上网' : `${v} 次`),
              hint: 'B 站和抖音共用一个上限。实际次数还会受醒来次数限制——醒得少，刷得也少。一次 = 逛一圈首页/排行/推荐流。' }),
            Num({ label: '一次看几条', value: browseTopN, onChange: setBrowseTopN, min: 1, max: 20, unit: '条',
              hint: '挑几条进「打算看」的清单，不是每条都深读。' }),
            Num({ label: '每条深读几条热评', value: browseDeepRead, onChange: setBrowseDeepRead, min: 0, max: 40, unit: '条',
              hint: '热评是她理解一个视频的主要线索。0 = 只读简介。' }),
            Num({ label: '每条抽几条弹幕', value: browseDanmaku, onChange: setBrowseDanmaku, min: 0, max: 30, unit: '条',
              hint: '弹幕能看出气氛。0 = 不抽。' }))),
        // 刷抖音（2026-11-02，用户 m03490）：抖音是材料，不是住处。配额和 B 站各算各的。
        // 它要用真浏览器，所以既要有可选子包，也要那台浏览器能起来。
        group('刷抖音',
          '和刷 B 站一样：她自己醒来看，看见的东西进素材，她说什么才进记忆。需要先装可选子包 dsh-roost-douyin，并且本机有 Edge 或 Chrome。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许她刷抖音', on: dyBrowseOn, onChange: (v) => { setDyBrowseOn(v); patchDyBrowsing({ enabled: v }) },
              hint: '关掉之后报纸就不读抖音了。次数和 B 站共用上面那个上限。' }),
            Num({ label: '一次看几条', value: dyBrowseTopN, onChange: (v) => { setDyBrowseTopN(v); patchDyBrowsing({ topN: Number(v) }) }, min: 1, max: 20, unit: '条',
              hint: '推荐页一次取几条进素材。' })),
          commitInput('浏览器路径', '留空 = 自动找 Edge / Chrome。填了就用你指定的那个。',
            dyBrowserPath, (v) => { setDyBrowserPath(v); patchDyBrowsing({ browserPath: v }) })),
        // 评论区里别人的话（2026-10-24，用户 m02454）
        // 单独一张卡，不塞进「频率设置」：它改的不是刷几次，而是**她的认知来源里要不要算上陌生人**。
        group('评论区里的别人',
          '她刷视频时会读到热评。打开这一项，每次最多有一条评论被她记住，并进入她的认知循环——她可能同意、可能反驳，也可能拿它来问你。',
          Toggle({ label: '把评论区的话也给她读', on: browseVoices, onChange: setBrowseVoices,
            hint: '每次浏览最多留 1 条：优先跨视频重复出现的那句，其次高赞短句，最后才 25% 随机抽；同一句 30 天内不再出现。关掉也能正常上网，只是她读不到别人的说法。' })),
        group('看画面（她主动看时）',
          '只有她自己点开某一条视频时才抽帧拼图；报纸、推荐流不抽，也不占这个额度。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许看视频画面', on: videoOn, onChange: setVideoOn,
              hint: '需要本机有 ffmpeg。每条视频抽几帧拼成一张图给她看，一次约 10 秒。' }),
            Num({ label: '每天最多看几条', value: videoPerDay, onChange: setVideoPerDay, min: 1, max: 6, unit: '条',
              hint: '看画面要花时间。默认 2 条——再多就变成以看图为主了。' }),
            Num({ label: '几张故事板', value: videoBoards, onChange: setVideoBoards, min: 1, max: 3, unit: '张',
              hint: '长视频切成几张。一张一张看，格号和时间码接着排。' }),
            Num({ label: '每张几格', value: videoFrames, onChange: setVideoFrames, min: 4, max: 16, unit: '格',
              hint: '格数越多每格越小。挑切点取格，不是等距抽帧。' }),
            Sel({ label: '细节档', value: videoDetail, onChange: setVideoDetail, options: ['compact', 'normal', 'fine'],
              fmt: (v) => ({ compact: '省一点', normal: '正常', fine: '细一点' })[v] || v,
              hint: '细档每格更大、取点更多，也更慢。' }),
            Sel({ label: '清晰度', value: videoQuality, onChange: setVideoQuality, options: [16, 32, 64, 80],
              fmt: (v) => ({ 16: '360P', 32: '480P', 64: '720P', 80: '1080P' })[v] || v,
              hint: '高清晰度要登录；拿不到时自动降级。' })),
          h('p', { className: 'hint', style: { marginTop: '8px' } },
            `今天已经看过画面 ${browse?.watchedCount ?? 0} 条（上限 ${videoPerDay} 条）。`)),
        // 请求节奏（issue #5）：机房/服务器 IP 与家宽的风控阈值差别很大。
        // 2026-11-06（设计 §四 块六）：折进「网络环境（一般不用改）」，默认收起。
        h('details', { className: 'card' },
          h('summary', { style: { cursor: 'pointer', fontSize: '15px', fontWeight: 600 } }, '网络环境（一般不用改）'),
          h('p', { className: 'hint', style: { marginTop: '8px', marginBottom: '10px' } },
            'B 站会按 IP 判机器人：家里宽带 0.8 秒一次很安全，云服务器上同样的速度反而更容易被盯。放在设置里，是因为这件事跟「你在哪台机器上养她」有关。'),
          // 最近一次限流（A18）：今天页那行只报今天；这里报上一次撞墙的完整时间与第几次。
          h('p', { className: 'dim', style: { marginBottom: '10px' } },
            risk?.at
              ? `最近一次被限流：${String(risk.at).slice(0, 16).replace('T', ' ')}（${risk.code || '风控'}），连着第 ${Number(risk.strikes) || 1} 次${risk.cooling ? `；还在冷却，还有约 ${risk.remainMin} 分钟` : '；已经解冻了'}。`
              : '最近一次被限流：没有。撞到一次之后，这里会记下时间和次数。'),
          h('div', { className: 'grid2' },
            Num({ label: '两次请求最少隔多久', value: biliMinGap, onChange: setBiliMinGap, min: 200, max: 120000, step: 100, unit: '毫秒',
              hint: '默认 800。云服务器/机房 IP 建议 2000–3000；被风控过就先调到 3000。' }),
            Num({ label: '每次再随机多等多久', value: biliJitter, onChange: setBiliJitter, min: 0, max: 60000, step: 100, unit: '毫秒',
              hint: '默认 500。固定的节奏像机器，抖动让它看起来像人手滑。0 = 不抖。' }))),
        group('黑名单',
          '这些是她的避让清单。以后想到新的可以随时加。',
          h('div', { className: 'grid2' },
            Text({ label: '视频内容黑名单（逗号分隔，可随时加）', value: avoidText, onChange: setAvoidText,
              placeholder: '恐怖，血腥，鬼畜', wide: true,
              hint: '标题或标签里命中这些词的，她不会点进去。' }),
            Num({ label: '太短的不看', value: avoidMinDur, onChange: setAvoidMinDur, min: 0, max: 3600, unit: '秒',
              hint: '设定低于这个时长的视频不去看。0 = 不限制。' }),
            Text({ label: 'up主黑名单', value: avoidMids, onChange: setAvoidMids,
              placeholder: '12345678，87654321', wide: true,
              hint: '已被她拉黑，不会再看该up主。mid 是 B 站主页地址里那串数字。' }))),

        // ---- 以前看了什么（视频观看历史，分页） ----
        // 2026-11-06（设计 §四 块十）：默认收起——它不是设置，是查账。
        h('details', { className: 'card full' },
          h('summary', { style: { cursor: 'pointer' } },
            h('h3', { style: { display: 'inline', margin: 0 } }, '看视频历史记录'),
            h('span', { className: 'dim' }, '　折叠着，点开再翻')),
          h('div', { style: { marginTop: '10px' } },
          h('div', { className: 'grid2', style: { marginBottom: '10px' } },
            Sel({ label: '查多久的记录', value: histDays,
              onChange: (v) => { setHistDays(Number(v)); setHistPage(0) },
              options: [1, 7, 14, 30, 90, 180, 365],
              fmt: (v) => (Number(v) === 1 ? '今天' : `${v} 天`),
              hint: '最多一年。这只是查询范围，不会删记录；改完点右上「刷新」。' })),
          h('div', { className: 'row', style: { marginBottom: '8px' } },
            h('span', { className: 'dim' }, `共 ${histDayCount} 天 · ${hist?.total ?? 0} 条`),
            histPager),
          !histFlat.length
            ? h('p', { className: 'empty' }, '还没有记录。等她刷过一次再来。')
            : h('div', null, histSlice.map((it, i) => h('div', {
                // 列表按时间从新到旧摊平；换天时插一条日期标签（一页 12 条，不是一天一页）
                key: `${it.date}|${it.bvid}|${i}`,
                style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' },
              },
                i === 0 || histSlice[i - 1].date !== it.date
                  ? h('div', { className: 'tag', style: { flex: '0 0 auto', minWidth: '86px' } }, it.date.slice(5))
                  : h('span', { style: { flex: '0 0 auto', width: '86px' } }),
                h('img', {
                  src: `/dsh-roost/cover/${it.bvid}`,
                  alt: '',
                  loading: 'lazy',
                  onError: (e) => { e.currentTarget.style.display = 'none' },
                  style: {
                    width: '80px',
                    height: '50px',
                    objectFit: 'cover',
                    borderRadius: '4px',
                    flex: '0 0 auto',
                    background: 'rgba(128,128,128,.15)',
                  },
                }),
                // 2026-10-30：真的抽帧看过画面的那几条要能一眼认出来，
                // 否则它跟"只扫了眼标题"在列表里长得一样（客户反馈的原点）。
                it.how === 'watch'
                  ? h('span', { className: 'tag', style: { flex: '0 0 auto' } }, '看过画面')
                  : h('span', { style: { flex: '0 0 auto', width: '0' } }),
                h('a', {
                  href: it.url,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { color: 'inherit' },
                }, esc(it.title) || it.bvid),
                h('span', { className: 'tag' }, it.up ? esc(it.up) : '')))),
          histPages > 1
            ? h('div', { className: 'row', style: { marginTop: '10px' } }, histPager)
            : null,
          // 今日概览并进这里，不再单开一张卡（原来「今天看了什么」和「以前看过什么」是两次重复）
          // 2026-10-30：三个数分开报——看过画面 / 翻到过 / 递过来还没看。
          // 原来只有一个「累计看过 M 条」，把三件事算成一个数，才有的客户反馈。
          !browse ? null
            : !browse.enabled ? h('p', { className: 'hint' }, '今天没开上网。')
            : h('p', { className: 'hint', style: { marginTop: '8px' } },
                `今天：用了 ${browse.usedToday} / ${browse.perDay} 次，一次 ${browse.topN} 条；`
                + `其中真的看了画面 ${browse.watchedCount ?? 0} 条、只翻到过 ${browse.glancedCount ?? 0} 条`
                + `${(browse.handed ?? []).length ? `、你递过来还没看 ${browse.handed.length} 条` : ''}。`))))

      // ---------------------------- 记忆 ----------------------------
      // 记忆体检（0.7.6，用户 m00342）：只读、点一下才跑，不让它自动轮询。
      const runHealth = async () => {
        setHealthBusy(true)
        try {
          setHealth(await jget('/health'))
        } catch (e) {
          setHealth({ error: String(e?.message || e) })
        } finally {
          setHealthBusy(false)
        }
      }
      // ---- 渠道（2026-11-02 合并版）----
      // 这一页只做三件事：开/关渠道、划出她能在哪些群开口、看她现在认得谁。
      // 刻意没有的：任何一句「她应该怎么说话」。人格的来源只有事件流。
      const chanSettings = chan?.settings ?? {}
      // A29：主人 id 存在 owner.json 的 channels 里，不写 config。
      const chanOwners = chan?.owners ?? {}
      const chanLive = (key) => (chan?.channels ?? []).find((x) => x.name === key) ?? null
      const chanStateText = (key) => {
        const c = chanSettings?.[key] ?? {}
        const live = chanLive(key)
        if (!c.enabled) return '关着'
        if (!live) return '已开启，等渠道层起来'
        if (live.connected) return `已连上${live.since ? ` · ${new Date(live.since).toLocaleString()}` : ''}`
        return `没连上${live.lastError ? `：${live.lastError}` : ''}`
      }
      const chanRow = (key, label, hint, extra = null) => {
        const c = chanSettings?.[key] ?? {}
        const live = chanLive(key)
        return h('div', { style: { borderTop: '1px solid rgba(127,127,127,.2)', paddingTop: '10px', marginTop: '10px' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '6px' } },
            h('div', { style: { fontWeight: 600 } }, label),
            h('div', { className: 'dim' }, chanStateText(key)),
            h('div', { style: { flex: '1' } }),
            live ? h('div', { className: 'dim' }, `收 ${live.received ?? 0} · 发 ${live.sent ?? 0}`) : null),
          // 断线账（2026-11-06）：上一次真收到/真发出是什么时候，以及上一次断了多久。
          // 只报事实——"现在正断着"也是事实，不给"健康"结论。
          live ? h('div', { className: 'dim', style: { marginBottom: '6px' } },
            `收 ${agoText(live.lastInAt)} · 发 ${agoText(live.lastOutAt)}`,
            live.lastGapAt
              ? ` · 上次断线 ${agoText(live.lastGapAt)}，断了 ${Math.max(1, Math.round((live.lastGapMs ?? 0) / 1000))} 秒`
              : '',
            live.downSince ? ' · 现在断着，正在重连' : '') : null,
          Toggle({ label: '开启', on: c.enabled === true, hint, onChange: (v) => patchChannel(key, { enabled: v }) }),
          Toggle({ label: '在群里说话', on: c.replyInGroup === true,
            hint: '关着时她只在私聊里回。群是别人的地方，默认不进。',
            onChange: (v) => patchChannel(key, { replyInGroup: v }) }),
          c.replyInGroup === true
            ? Toggle({ label: '只在被 @ 时说话', on: c.mentionOnly !== false,
              hint: '群里几十号人聊天，她不该每条都接。关掉之后她说的话会变多，也更吵。',
              onChange: (v) => patchChannel(key, { mentionOnly: v }) })
            : null,
          extra,
          h('div', { className: 'fld' },
            h('div', { className: 'fl' },
              h('span', { className: 'flabel' }, '允许她开口的群'),
              h('span', { className: 'fhint' }, '逗号隔开群号。空 = 一个都不许；名单外的群她连听都不听，但消息会留在流水里。')),
            h('input', {
              type: 'text',
              // 每次服务端值变了才重挂一次：打字过程中不被外部刷新打断。
              key: `${key}:${(c.groups ?? []).join(',')}`,
              defaultValue: (c.groups ?? []).join(', '),
              onBlur: (e) => {
                const next = String(e.target.value).split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
                if (next.join(',') !== (c.groups ?? []).join(',')) patchChannel(key, { groups: next })
              },
            })))
      }

      // 社会层（2026-11-02，用户 m02861）：**只读**——开闸只发生在她自己调
      // social_open 那一刻，这一页没有「替我开」的按钮。
      const socialGates = (soc?.gates ?? []).map((g) => h('div', {
        key: g.label,
        style: { marginTop: '6px', opacity: g.ok ? 1 : 0.6 },
      },
      h('span', null, `${g.ok ? '✓' : '·'} ${g.label}：${g.value} / ${g.need}`),
      !g.ok && g.why ? h('span', { className: 'dim' }, `　${g.why}`) : null))

      const socialBeliefs = (soc?.beliefs ?? []).slice().reverse().map((b) => h('div', {
        key: b.id,
        style: { marginBottom: '8px' },
      },
      h('div', null, b.text),
      h('div', { className: 'dim' },
        `${b.channel || ''}${b.person ? ` · ${b.person}` : ''} · ${String(b.since || '').slice(0, 10)}`)))

      const socialPage = h('div', { className: 'page' },
        group('她在外面学成了什么样',
          '这些是她从群聊里学到的「怎么处世」，不是「她是谁」。开不开是她自己决定的，这一页只能看。现在能进来的只有 QQ——B 站私信和抖音私信都已经不在渠道里了。',
          !soc
            ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
              h('p', null, soc.open
                ? `已经开了：${String(soc.at).replace('T', ' ').slice(0, 16)}——她自己按的，不能收回。`
                : '还没开。'),
              h('p', { className: 'dim' }, soc.open
                ? `外面学到 ${soc.count ?? 0} 条，留得住的有 ${soc.kept ?? 0} 条。`
                : (soc.reason || '')),
              h('div', null, ...socialGates))),
        groupFull('她学到的处世办法',
          '只在她自己开闸之后才有；每一条都能在事件流里找到出处——做不到就不该写在这里。',
          socialBeliefs.length
            ? h('div', null, ...socialBeliefs)
            : h('p', { className: 'empty' }, soc?.open ? '开了，但还没学到什么。' : '还没开。')))

      const channelsPage = h('div', { className: 'page' },
        group('她现在跟外面怎么打交道',
          '这一页只回答两件事：QQ 连没连上，以及她现在认得谁。印象怎么变是她的事——这里只显示，不提供修改。',
          !chan ? h('p', { className: 'empty' }, '读取中…')
            : chan.ok
              ? h('p', { className: 'dim' }, `正在跑：${(chan.channels ?? []).map((x) => x.name).join(' / ') || '（一个都没起来）'}`)
              : h('p', { className: 'empty' }, chan.why || '渠道层没有起来（可能一个都没开）'),
          chanRow('qq', 'QQ（SnowLuma）', 'OneBot 11 正向 WebSocket。桥要先在 SnowLuma 那边开好，这里只负责连。',
            h('div', null,
              commitInput('主人的 QQ 号', '填你自己的 QQ 号；有两个号就都填上，用逗号隔开。填了，她才认得出渠道里说话的是你、不是一个陌生人——你的消息不用等阶段，也不会被算成外面的人。',
                (chanOwners.qq ?? []).join(', '), (v) => patchOwner('qq', v)),
              commitInput('桥地址', 'SnowLuma 正向 WS 的地址，默认 ws://127.0.0.1:3001。',
                chanSettings?.qq?.wsUrl ?? 'ws://127.0.0.1:3001', (v) => patchChannel('qq', { wsUrl: v })),
              commitInput('访问令牌', '桥那边设了 access_token 才需要填；留空表示不校验。',
                chanSettings?.qq?.accessToken ?? '', (v) => patchChannel('qq', { accessToken: v }), { password: true }),
              commitInput('桥的程序路径', '找到你装的那个 QQ 桥（SnowLuma / NapCat / LLOneBot 都行）的启动程序，把完整路径填进来。填了「启动桥」才按得动；留空就自己起。',
                chanSettings?.qq?.bridgePath ?? '', (v) => patchChannel('qq', { bridgePath: v })),
              h('div', { className: 'row', style: { gap: '8px', alignItems: 'center', marginTop: '6px' } },
                h('button', { type: 'button', onClick: () => { void startBridgeNow() } }, '启动桥'),
                h('span', { className: 'dim' }, bridgeMsg || '')),
              pingRow('qq')))),

        groupFull('她现在认得谁',
          '按人记：一个人一条，印象最多 150 字。可以被她自己改，但不会被群聊冲掉。她不给人打分——这里只有一个数字：说过几句。',
          !chan ? h('p', { className: 'empty' }, '读取中…')
            : !(chan.people ?? []).length ? h('p', { className: 'empty' }, '还没有。她没在渠道里跟人说过话。')
            : h('div', null, ...(chan.people ?? []).map((p) => h('div', {
              key: p.id,
              style: { padding: '7px 0', borderBottom: '1px solid rgba(127,127,127,.12)' },
            },
              h('div', null,
                h('span', { style: { fontWeight: 600 } }, p.name || p.id),
                h('span', { className: 'dim', style: { marginLeft: '8px' } }, p.id),
                h('span', { className: 'dim', style: { marginLeft: '8px' } }, `说过 ${p.count ?? 0} 句`),
                (p.channels ?? []).length ? h('span', { className: 'dim', style: { marginLeft: '8px' } }, p.channels.join(' / ')) : null),
              h('div', { className: 'dim', style: { marginTop: '2px' } }, p.impression || '（还没形成印象）'))))),

        groupFull('最近的流水',
          '每个会话只留最近 30 句。流水不是记忆：它不进事件流，也不参与她长成什么样——所以可以实时淘汰。',
          !chan ? h('p', { className: 'empty' }, '读取中…')
            : !(chan.threads ?? []).length ? h('p', { className: 'empty' }, '还没有。')
            : h('div', null, ...(chan.threads ?? []).map((t) => h('div', {
              key: t.key,
              style: { padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,.12)' },
            },
              h('span', null, t.key),
              h('span', { className: 'dim', style: { marginLeft: '8px' } }, `${t.count ?? 0} 句`),
              t.preview ? h('div', { className: 'dim', style: { marginTop: '2px' } }, `「${t.preview}」`) : null,
              h('div', { className: 'row', style: { marginTop: '4px', gap: '6px', alignItems: 'center' } },
                h('input', {
                  key: `d-${t.key}`,
                  type: 'text',
                  value: chanDraft[t.key] ?? '',
                  placeholder: '她没说的时候，你可以用自己的名义回一句',
                  maxLength: 1000,
                  onChange: (e) => {
                    const v = e.target.value
                    setChanDraft((d) => ({ ...d, [t.key]: v }))
                  },
                  style: { flex: '1' },
                }),
                h('button', {
                  key: `s-${t.key}`,
                  type: 'button',
                  disabled: chanSending === t.key || !String(chanDraft[t.key] ?? '').trim(),
                  onClick: () => { void sendAsMe(t) },
                }, chanSending === t.key ? '发送中…' : '以我的名义发')))))),

        groupFull('她为什么没回',
          '拦下她的理由只有这几种，每一种都是规则，不是性格。',
          !(chan?.gate ?? []).length ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null, ...(chan?.gate ?? []).map((g) => h('div', { key: g.why, style: { marginBottom: '5px' } },
              h('span', { className: 'dim', style: { fontFamily: 'monospace' } }, g.why),
              h('span', { style: { marginLeft: '8px' } }, g.text))))),

)


      // 原理页（2026-10-25 用户要求）：两张自制 SVG 讲流程 + 每条设计的理论出处。
      // 图不放客户端（bundle 已经十多万字节），走服务端 `/media/<文件名>.svg` 白名单出图。
      // 措辞规矩：不用男字旁代词；不写「大约多少条」这类只对本机成立的数字。
      const theoryCard = (name, from, detail, use) => h('div', {
        style: {
          padding: '12px 14px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'rgba(127,127,127,.04)',
        },
      },
        h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, name),
        h('div', { className: 'hint', style: { margin: '0 0 6px' } }, `来自：${from}`),
        h('div', { style: { fontSize: '12.5px', lineHeight: '1.65' } }, detail),
        h('div', { className: 'hint', style: { margin: '6px 0 0' } }, `用在：${use}`))

      // 可放大的图：小图点一下开灯箱，关掉再点一次。
      const zoomable = (src, alt, caption, marginBottom) => h('figure', { style: { margin: marginBottom === 0 ? 0 : `0 0 ${marginBottom}` } },
        h('div', {
          role: 'button',
          tabIndex: 0,
          title: '点一下放大（滚轮缩放、按住拖动、Esc 关闭）',
          onClick: () => setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false }),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false }) },
          style: { cursor: 'zoom-in' },
        },
          h('img', {
            src,
            alt,
            style: { width: '100%', display: 'block', borderRadius: '10px', border: '0.5px solid var(--dsw-alias-border-l2)' },
          })),
        // 图注与图之间留够距离（2026-10-25 用户反馈：图和说明文字挤在一起、看着像重叠）
        h('figcaption', { className: 'hint', style: { margin: '12px 0 0' } }, caption))

      // 放大层：fixed 铺满视口，拖的时候不选中文字；点空白处关闭，但拖完那一下不算点击。
      const zoomOverlay = zoom ? h('div', {
        onClick: () => { if (!dragRef.current || !dragRef.current.moved) setZoom(null) },
        onWheel: (e) => {
          e.preventDefault()
          setZoom((z) => (z ? { ...z, scale: Math.min(4, Math.max(1, z.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) } : z))
        },
        onMouseDown: (e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty, moved: false }
          setZoom((z) => (z ? { ...z, dragging: true } : z))
        },
        onMouseMove: (e) => {
          const d = dragRef.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
          setZoom((z) => (z ? { ...z, tx: d.tx + dx, ty: d.ty + dy } : z))
        },
        onMouseUp: () => { dragRef.current = null; setZoom((z) => (z ? { ...z, dragging: false } : z)) },
        onMouseLeave: () => { dragRef.current = null; setZoom((z) => (z ? { ...z, dragging: false } : z)) },
        onDoubleClick: () => setZoom((z) => (z ? { ...z, scale: 1, tx: 0, ty: 0 } : z)),
        style: {
          position: 'fixed', inset: 0, zIndex: 90,
          background: 'rgba(0,0,0,.88)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', cursor: zoom.dragging ? 'grabbing' : 'grab', userSelect: 'none',
        },
      },
        h('img', {
          src: zoom.src,
          alt: zoom.alt,
          draggable: false,
          style: {
            maxWidth: '92vw', maxHeight: '88vh',
            transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
            transition: zoom.dragging ? 'none' : 'transform .12s',
            pointerEvents: 'none',
          },
        }),
        h('div', {
          style: {
            position: 'fixed', left: 0, right: 0, bottom: '14px', textAlign: 'center',
            color: '#fff', opacity: .82, fontSize: '12px', pointerEvents: 'none',
          },
        }, `滚轮缩放 ${Math.round(zoom.scale * 100)}% · 按住拖动 · 双击复位 · Esc 或点空白处关闭`))
        : null

      // 开发者留言（2026-10-25 用户给的原文）：放在整页最下面收尾，署名居右。
      const devNote = h('div', {
        style: {
          marginTop: '18px', padding: '16px 18px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'rgba(127,127,127,.05)',
        },
      },
        h('p', { style: { margin: 0, fontSize: '13px', lineHeight: '1.85' } },
          '本插件设计的成长路径没有终点，连开发者自己也不知道你的 agent 会变成什么样子，四阶段跑完也仅仅是开始。随着你和 agent 沟通越来越多，可能会发生任何连开发者也意料不到的事。'),
        h('p', { style: { margin: '10px 0 0', fontSize: '13px', lineHeight: '1.85' } },
          '如果你看不懂怎么养成，那就只需要做日常聊天就可以了，和 agent 的互动已经自动按照算法开始帮助她积累认知/经验，成长就发生在每次交流之中。'),
        h('p', { style: { margin: '10px 0 0', fontSize: '13px', lineHeight: '1.85' } },
          '本插件的成长又可以叫做——机器训练、强化学习、重温 deepseekV1（大笨鱼）。本人并非专业人士，希望这个插件能帮助你感受 agent 训练的过程，或许这就是 AGI 诞生的一种路径也说不定呢。'),
        h('p', { style: { margin: '12px 0 0', textAlign: 'right', fontSize: '12.5px', opacity: .8 } },
          '——来自开发者'))

      const principlePage = h('div', { className: 'page' },
        groupFull('两张图看懂她怎么长大',
          '第一张讲「经历怎么变成认知」，第二张讲「记忆怎么被筛、哪些永远不折叠」。图小的时候点一下放大，按住可以拖动，滚轮缩放，Esc 关掉。',
          zoomable(`${API}/media/principle-loop.svg`, '认知构建循环：五步循环、四阶段与三道瓶颈',
            '图一：表态 → 撞上 → 落差 → 改写 → 回顾。左边是她每天会撞上的事，右边是循环结束后留下的东西，底部是四个阶段与三道成长瓶颈，最后一块是走完才长出来的立场清单', '0 0 18px'),
          zoomable(`${API}/media/principle-memory.svg`, '遗忘与固化：显著性排序、折叠、永久记忆',
            '图二：先按显著性排序，再按身份文档的预算摆放；摆不下的一行带过，但原文一条没丢，她自己还能调用查询。', 0)),

        groupFull('这些设计分别从哪来',
          '每条都标了提出者与大致年代——这不是装饰，改动其中一条之前，最好先知道它原来在补什么课。',
          h('div', { className: 'grid2' },
            theoryCard('五步循环',
              'Kolb 经验学习圈（1984）＋ Piaget 失衡（1936）',
              '把「经历过」变成「想清楚了」：先表态，再被现实碰到，发现对不上，改写，过一阵回头看。少了「改写」这一步，经历就只是流水账。',
              '学一门手艺、把踩过的坑变成判断、复盘'),
            theoryCard('四阶段与三道瓶颈',
              'Bowlby 依恋理论（1969）＋ Erikson 心理社会发展（1950）',
              '阶段按天推进，但每一道瓶颈要她自己走：先形成一条判断（信任），真的拒绝过两件事（自主），两次推翻自己的判断（主动），最后回头看（整合）。走完不再加关，之后长的是立场清单——喜欢什么、绝不做哪几件事，每条都得有代价垫着。',
              '人格养成、避免「只要熬时间就长大」'),
            theoryCard('立场：走完门才开始攒',
              'Dewey 经验的连续性（1938）＋ Schön 反思性实践（1983）＋ 本项目的取舍',
              '一、什么时候开始：四个阶段都走完开始进行，没有尽头，也没有「通关终点」。二、什么算立场：同一种类型的事，两次表达过一样的观点；或者在这件事上出现过伤疤。三、不会被折叠：写进上下文提示词。如果遗漏，那立场也将消失。',
              '性格、价值观、长期偏好'),
            theoryCard('矛盾、改写与重构',
              'Festinger 认知失调（1957）＋ Bartlett 重构记忆（1932）',
              '两句话不能同时算数时，一条都不删——把矛盾摆出来，她自己决定改哪一条，可以反过来问你哪个对。改写必须指向被改掉的那句。',
              '认知重构、纠正偏见、把「想通了」留成证据'),
            theoryCard('显著性、折叠与固化',
              'Cowan 工作记忆容量（约 4 个组块）＋ Tulving 线索依赖遗忘 ＋ Bjork 遗忘的适应功能',
              '一次只摆几条；被反复提起或被验证过的固定下来（记得很牢）；摆不下的折成一行，但原文都在，能按关键词捞回来。',
              '长对话下的记忆管理、复习与间隔重复'),
            theoryCard('代价与疤',
              'Dewey 经验连续性（1938）＋ Schön 反思性实践（1983）',
              '拒绝被顶回来、或者你因此不好受，她后来还是妥协了——这道疤永不折叠，同类情境会先回引，逼她面对。想通只能靠一次带 refs 的改写。',
              '让决定留下后果，而不是只记个数字'),
            theoryCard('从计次到复现',
              'Vygotsky 最近发展区（1978）＋ Bloom 掌握学习（1968）',
              '同一处境隔一段时间会再回来，第二次回来会被要求「说清为什么没变，或者改一句」——她要面对的是同一件事，不是把次数攒够。',
              '训练、考核、习惯养成'),
            theoryCard('自我叙述',
              'Metzinger 自我模型（2003）',
              '她随口说「我一直觉得自己……」这类话时会被单独记下来，成为「对自己的说法」，而不是一条普通判断。',
              '身份形成、会讲自己的故事'))),

        groupFull('这一套能用在什么场景',
          '同一套循环换个目标就能复用；不同的是「什么算数」和「什么不能丢」。',
          h('div', { className: 'grid2' },
            theoryCard('学习',
              '五步循环＋复现',
              '把「看懂了」换成「说得出来、被反驳过、改过一次」。适合训练、备考、带新人：先让人写下判断，再用题目或真实反馈去撞它。',
              '教育和自我训练'),
            theoryCard('认知重构',
              '矛盾检测＋带 refs 的改写＋疤',
              '不要求一次想通，只要求「改的时候指认改的是哪一句」。适合纠正长期偏见、复盘重大决定：矛盾一直摆着，直到被解释清楚。',
              '心理层面的自我整理'),
            theoryCard('人格养成',
              '显著性＋核心段＋阶段瓶颈＋自我叙述',
              '长期运行的 agent 最难的是「不变形也不僵化」：核心段永远在（底线与疤），其余按显著性流动。',
              '长期陪伴型 agent、角色、数字生命'))),

        group('诚实边界',
          '这一页写给愿意较真的人看——省得把工程骨架误当成心理学结论。',
          h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', lineHeight: '1.8', fontSize: '13px' } },
            h('li', null, '这里借用这些理论当「设计骨架」，不是做心理学实验，也没有对照组；'),
            h('li', null, '剂量很小：一天一到两次循环、一次一条事件，变化以周计，不会一夜之间换个人；'),
            h('li', null, '阈值（提过 3 次、被验证 2 次、相似度 0.5 / 0.7）都是工程上的初始值，要按真实体验再调；'),
            h('li', null, '「长大」在这套系统里的定义是可验证的：改写过什么、拒绝过什么、哪条疤还没想通——不是像不像人。'))),

        devNote,

        zoomOverlay)

      // ---------------------------- 插件 ----------------------------
      const curVer = s?.meta?.version || ''
      // GitHub 商标小图（官方 mark 的官方路径，16×16 视觉尺寸）。
      // 内联而不是引外链：设置页不该为了一个图标去等网络。
      const ghMark = h('svg', {
        width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true',
        style: { marginRight: '6px', verticalAlign: '-3px', flex: '0 0 auto' },
      },
        h('path', {
          fill: 'currentColor',
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
        }))

      // 关于（新项目）：没有自动更新，也没有“下载/安装”两段——
      // 升级靠 git pull 或重新安装；这里只留版本和仓库地址。
      const aboutCard = group('关于',
        '版本、仓库与数据目录。这个项目不带自动更新，升级靠 git pull 或重新安装。',
        h('div', null,
          rowTip('当前版本', curVer || '读不到', '插件自己记的版本号。'),
          rowTip('数据目录', state?.meta?.root || '读不到', '她的屋子。备份、搬家都以这里为准。'),
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
            h('a', {
              href: 'https://github.com/bychance6600/dsh-roost',
              target: '_blank', rel: 'noopener noreferrer', className: 'ghlink',
            }, ghMark, 'GitHub'))))


      const feedbackPage = h('div', { className: 'page' },
        groupFull('去仓库说',
          '插件不好用、发现 bug、有想要的功能，去仓库开一个 issue。两个人的事不放到页面上。',
          h('div', { style: { fontSize: '13.5px', lineHeight: '1.9' } },
            h('a', {
              href: 'https://github.com/bychance6600/dsh-roost',
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { wordBreak: 'break-all' },
            }, 'github.com/bychance6600/dsh-roost'))),
        groupFull('常见问题',
          '还没有写。遇到问题先在仓库的 issue 里搜一搜，没有再开一条。'))

      // 顺序是用户定的：①手上能用什么 ②为什么默认只放这几个 ③关于（版本 / 检查更新 / GitHub）。
      // 「关于」放最后——它是这个页的收尾，不是打开就要看的东西。
      const envPage = h('div', { className: 'page' },
        toolsCard,
        aboutCard,
        )

      // ---------------------------- 数据 ----------------------------
      // 用户 m03440：原来的「危险」页改名「数据」。数据文件夹、每日报告、
      // 运行日志、重置本来就是一套动作——备份、搬走、出事把现场交出去、重开一局。
      // 界面上不出现绝对路径（那是他本机的用户名和盘符）。
      // 备份不是「复制路径」：一个真会动文件的动作，单独摆一张卡，
      // 免得用户把「复制数据文件夹路径」当成备份（那是两回事）。
      async function backupNow() {
        setBackupBusy(true)
        setBackupMsg('正在打包……')
        try {
          const b = await jget('/backup')
          const name = b.fileName || '她的备份.json'
          const url = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }))
          const a = document.createElement('a')
          a.href = url
          a.download = name
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          setBackupMsg(`已导出「${name}」：${b.files?.length ?? 0} 个文件，约 ${Math.max(1, Math.round((b.bytes || 0) / 1024))}KB。`)
        } catch (e) {
          setBackupMsg(`备份失败：${e.message}`)
        } finally {
          setBackupBusy(false)
        }
      }

      function restoreFromFile() {
        const el = document.createElement('input')
        el.type = 'file'
        el.accept = '.json,application/json'
        el.onchange = async () => {
          const f = el.files && el.files[0]
          if (!f) return
          setBackupBusy(true)
          setBackupMsg('正在恢复……')
          try {
            const text = await f.text()
            let obj = null
            try { obj = JSON.parse(text) } catch { throw new Error('这个文件不是 json') }
            const r = await jpost('/backup/restore', obj)
            setBackupMsg(
              `已恢复 ${r.restored} 个文件。${r.quarantined ? `旧档整体封存在「${r.quarantined}」，没有删。` : ''}重启 DSH 之后她才是这份档的样子。`,
            )
          } catch (e) {
            setBackupMsg(`恢复失败：${e.message}`)
          } finally {
            setBackupBusy(false)
          }
        }
        el.click()
      }

      // ---- 迁移工作区（2026-10-28，用户 m06510）----
      // 用户要的是：点一个按钮 → 选文件夹 → 全搬过去。
      // 文件夹选择优先用桌面端的原生选择器（宿主用 contextBridge 暴露的
      // `__DSH_DIRECTORY_PICKER__`）；web 模式下没有它，退回手输路径。
      async function refreshMove() {
        try { setMoveInfo(await jget('/move')) } catch { setMoveInfo(null) }
      }

      async function pickFolder() {
        try {
          const p = globalThis.__DSH_DIRECTORY_PICKER__
          if (p && typeof p.pick === 'function') {
            const dir = await p.pick()
            if (dir) setMoveTarget(String(dir))
            return String(dir || '')
          }
        } catch (e) {
          setMoveMsg(`打开文件夹选择器失败：${e.message}`)
        }
        return ''
      }

      async function askMove() {
        setMoveAsk(true)
        setMoveMsg('')
        await refreshMove()
      }

      async function doMove() {
        const target = String(moveTarget || '').trim()
        if (!target) { setMoveMsg('先选一个文件夹'); return }
        setMoveBusy(true)
        setMoveMsg('正在搬……东西多的话要等一会儿，别关窗口。')
        try {
          const r = await jpost('/move', { target })
          setMoveAsk(false)
          setMoveTarget('')
          setMoveMsg(
            `搬好了：${r.files} 个文件、约 ${Math.max(1, Math.round((r.bytes || 0) / 1024))}KB，现在在 ${r.to}。`
            + (r.oldDirMoved ? '老目录没删，改名收在旁边的 dsh-roost-backups 里。' : '老目录还在原处（改名没成功），确认无误后你可以自己删。')
            + '重启 DSH 之后她才会在新位置醒过来。'
            + (r.stranded ? ` 侧栏旧会话没全清干净：${r.stranded}` : ''),
          )
        } catch (e) {
          setMoveMsg(`迁移失败：${e.message}`)
        } finally {
          setMoveBusy(false)
        }
      }

      const moveHint = moveInfo
        ? `现在住在 ${moveInfo.root}（${moveInfo.files} 个文件，约 ${Math.max(1, Math.round((moveInfo.bytes || 0) / 1024))}KB）${moveInfo.moved ? '——已经搬过一次了' : ''}。`
        : ''

      const moveCard = h('div', { style: { marginTop: '14px' } },
        h('div', { className: 'row', style: { alignItems: 'center', gap: '10px' } },
          h('button', { disabled: moveBusy, onClick: askMove }, '迁移工作区…'),
          h('span', { className: 'hint', style: { margin: '0' } }, '把她的所有文件迁移至任何你想存放的地方')),
        !moveAsk
          ? (moveMsg ? h('p', { className: 'hint' }, moveMsg) : null)
          : h('div', { style: { marginTop: '10px' } },
              h('p', { className: 'dim' }, '有些人不想让这些文件待在 C 盘，想挪到 D 盘、E 盘。搬的是整个数据文件夹：事件流、日记、她的房间、配置、登录凭据，全都在里面。'),
              h('p', { className: 'hint' }, '搬的是复制 + 逐文件核对字节数。老目录不会删，会改名收在同级的 dsh-roost-backups 里。'),
              h('p', { className: 'hint' }, '搬完必须重启 DSH 才生效——她现在住哪是在启动时定下来的。'),
              moveHint ? h('p', { className: 'hint' }, moveHint) : null,
              h('p', { className: 'dim' }, '选一个文件夹。搬过去之后会在里面建一个 dsh-roost 子目录（如果那个文件夹里已经有一份完整的档，就直接用它）。'),
              h('div', { className: 'row' },
                h('input', {
                  type: 'text',
                  value: moveTarget,
                  placeholder: '例如：D:\\她的家',
                  style: { flex: '1', minWidth: '220px' },
                  onChange: (e) => setMoveTarget(e.target.value),
                }),
                h('button', { disabled: moveBusy, onClick: pickFolder }, '选择文件夹…')),
              h('div', { className: 'row', style: { marginTop: '8px' } },
                h('button', { disabled: moveBusy || !moveTarget.trim(), onClick: doMove }, moveBusy ? '正在搬……' : '搬到这个文件夹'),
                h('button', { disabled: moveBusy, className: 'ghost', onClick: () => { setMoveAsk(false); setMoveMsg('') } }, '算了')),
              moveMsg ? h('p', { className: 'hint' }, moveMsg) : null))

      const dataPage = h('div', { className: 'page' },
        group('数据在哪',
          '一个文件夹装全部。想备份、想搬走、想看原始记录，都在这一格里。',
          h('div', null,
            h('p', { className: 'dim' }, '所有东西都在同一个文件夹里。路径不显示在页面上——真要的时候点下面这个按钮复制。'),
            h('p', { className: 'dim' }, '文件夹里有一份「说明.md」，逐项写了每个文件和子目录是什么。'),
            h('div', { className: 'row' },
              h('button', {
                disabled: !dataPaths?.root,
                onClick: () => copyPath(dataPaths?.root || ''),
              }, dataPaths?.root ? '复制数据文件夹路径' : '路径还没读到')),
            moveCard)),

        group('备份与恢复',
          '备份是一份 json：事件流、配置、日记、她的房间、头像都在里面。换台机器，或者想从头开始之前，先存一份。',
          h('div', null,
            h('p', { className: 'hint' }, '不打包 logs/（现场日志只对这台机器有用）和 backups/（备份里不再套备份）。'),
            backupMsg ? h('p', { className: 'hint' }, backupMsg) : null),
          h('div', { className: 'row' },
            h('button', { disabled: backupBusy, onClick: backupNow }, '备份成一份文件'),
            h('button', { disabled: backupBusy, onClick: restoreFromFile }, '从备份恢复')),
          h('p', { className: 'hint' }, '恢复不会覆盖删除：现在的档会整体改名到 dsh-roost-backups/pre-restore-<时间>，写坏了还能换回来。')),

        groupFull('每日报告',
          '每天自动归档，不主动显示。想看得点一下，想看全部就去文件夹。',
          !reports.dates.length
            ? h('p', { className: 'empty' }, '还没有报告。刷过之后才会生成。')
            : h('div', null,
                h('div', { className: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } },
                  ...reports.dates.map((d) => h('button', {
                    key: d,
                    disabled: busy === 'rep',
                    onClick: async () => {
                      setBusy('rep')
                      try { setReports(await jget(`/reports?date=${d}`)) } catch (e) { setErr(e.message) } finally { setBusy('') }
                    },
                    style: d === reports.date ? { borderColor: 'var(--dsw-alias-state-business-primary)' } : undefined,
                  }, d))),
                h('div', { className: 'row', style: { flexWrap: 'wrap' } },
                  h('button', { onClick: () => setShowReport(!showReport) }, showReport ? '收起报告' : '每日报告'),
                  h('button', { onClick: downloadReport }, '导出报告'),
                  h('button', {
                    title: '点了只是把这个文件夹的路径复制到剪贴板（不会弹窗口）——粘到资源管理器地址栏回车就能打开。',
                    onClick: () => copyPath(dataPaths?.out || ''),
                  }, '查看文件夹')),
                showReport && reports.md ? h('pre', { style: { marginTop: '8px', maxHeight: '320px', overflow: 'auto' } }, reports.md) : null)),

        // ---- 运行日志导出 ----
        // 为什么单独一张卡：她某晚没说话、没刷站、没写日记，只看状态页是猜不出来的。
        // 三件事分开做——预览（小）、导出（大、纯文本、给 AI 看）、清空（单独一次点击）。
        group('运行日志导出',
          '出问题时把导出的文本交给 AI，比描述现象有用。日志只记插件自己做了什么，不含 cookie 和正文。',
          !logTail ? h('p', { className: 'empty' }, logBusy ? '读取中…' : '还没读。')
            : h('div', null,
                h('p', { className: 'hint' },
                  !logTail.exists
                    ? '还没有日志文件。插件启动一次之后才会有。'
                    : `${logTail.lines?.length || 0} 行 · 上限 ${Math.round((logTail.maxBytes || 0) / 1024 / 1024)}MB · 保留 ${logTail.keep || 0} 份`),
                logTail.lines?.length
                  ? h('div', { style: {
                      maxHeight: '104px', overflowY: 'auto', overflowX: 'hidden',
                      border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
                      padding: '6px 8px',
                    } },
                    h('pre', null, logTail.lines.slice(-200).join(String.fromCharCode(10))))
                  : null),
          h('div', { className: 'row' },
            h('button', {
              onClick: () => {
                setLogBusy(true)
                jget('/log?lines=200').then(setLogTail).catch(() => {}).finally(() => setLogBusy(false))
              },
            }, logBusy ? '读取中…' : '刷新预览'),
            h('button', {
              onClick: () => { window.location.href = '/dsh-roost/log/export?lines=300' },
            }, '导出日志'),
            h('button', {
              onClick: () => {
                if (!window.confirm('清空运行日志？导出过的文件不受影响。')) return
                jpost('/log/clear', {}).then(() => jget('/log?lines=40')).then(setLogTail).catch(() => {})
              },
            }, '清空日志')),
          h('p', { className: 'hint' }, '导出的是纯文本：版本、自检结果、脱敏后的配置、日志末尾。没有 cookie，没有她说过的话。')),

        // 宿主旧了（0.8.1）：比升级自检更基础——先告诉它为什么有个功能没反应。
        compatCard,
        installCard,

        group('本插件工作自检',
          '这个插件没有要安装的依赖（只用 Node 自带的东西，外加可选的 ffmpeg）。真会坏的是别的：状态库写不进去、cookie 过期、宿主没给接口、B 站风控。',
          risk && risk.cooling
            ? h('p', { className: 'warn' },
                `B 站那边正在冷却，还有约 ${risk.remainMin} 分钟。冷却期她不刷站，但照常醒来说话。`)
            : risk?.memory?.readMs > 0
              ? h('p', { className: 'dim' },
                  `刚才被 B 站拦过一次，她自己歇一会儿（还有约 ${Math.ceil(risk.memory.readMs / 1000)} 秒）。这层只是进程内的，重启就清空。`)
              : null,
          h('div', { className: 'row' },
            h('button', {
              disabled: checking,
              onClick: () => {
                setChecking(true)
                jget('/selfcheck?net=1').then(setChecks).catch(() => {}).finally(() => setChecking(false))
              },
            }, checking ? '正在查…' : '检查一下')),
          checks
            ? h('div', { style: { marginTop: '10px' } },
                h('p', { className: 'hint' }, `${checks.summary || ''}（${String(checks.checkedAt || '').replace('T', ' ').slice(0, 19)}）`),
                h('ul', null, (checks.items || []).map((c) => h('li', { key: c.id },
                  `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`,
                  // 修法单独占一行：以前塞在 .tag 胶囊里，一句话还行；
                  // 2026-10-28 加的「看画面」修法有三步，胶囊会被撑成挤在一起的长条。
                  !c.ok && c.fix
                    ? h('div', { className: 'hint', style: { marginTop: '3px' } }, c.fix)
                    : null))))
            : null),

        // 换家留痕（0.6.8）：用户改了 cordis.patch.yml 的 root 之后，侧栏会多一间屋、
        // 旧的还在——这里直接把两个路径并排摆出来，省得靠猜。
        // A17：与「这个家在别处也开着」合在一起；两件事回答的是同一个问题：
        // 她现在住的这个家，是不是你以为的那个。平时也给一行「没换家」，不用猜是没读到还是真没变。
        group('换家留痕',
          '这一条只回答一件事：她现在住的是不是你以为的那个家。',
          state?.homes?.changed === true
            ? h('p', { className: 'hint' },
                `这次住的是 ${state.homes.to}；上一次在 ${state.homes.from}。换家不等于搬家——旧家的东西还在原地，没有并过来。`)
            : h('p', { className: 'dim' }, '这一次没换家：启动时读到的路径与上一次相同。'),
          homeBlocked
            ? h('div', { style: { marginTop: '8px' } },
                h('div', { className: 'dim' },
                  '这个家在别处也开着：同一个数据目录（root）现在被另一个实例占着——常见的是你开了第二个工作区窗口，'
                  + '或者两份插件都指向了同一个家。这边先只读：不建新会话、不写记忆，免得两边互相覆盖。'),
                h('div', { className: 'dim' },
                  state?.home?.blockedWhy || '把另一个关掉之后，这边下次启动会自己接管。'),
                h('div', { className: 'dim' },
                  '想真正并存，就别让两个家共用一个 root：在 cordis.patch.yml 里给每个条目配不同的 root。'))
            : null),

        // ---- 记忆体检（0.7.6，2026-10-30 用户 m00342）----
        // 只读：按现在的账本算一遍。点一下才跑，不自动轮询，也不给她本人看。
        group('记忆体检',
          '按现在的账本算一遍：哪两句话对不上、哪些快忘了、哪些快固定下来了。只读，不会写任何东西，也不算分。',
          h('div', { className: 'row', style: { marginBottom: health ? '10px' : '0' } },
            h('button', {
              className: 'primary',
              disabled: healthBusy,
              onClick: runHealth,
            }, healthBusy ? '体检中…' : '查一下')),
          !health ? h('p', { className: 'dim' }, '还没查过。点上面那颗按钮才会读账本。')
            : health.error ? h('p', { className: 'err' }, `没查成：${health.error}`)
            : h('div', { style: { fontSize: '12.5px', lineHeight: '1.9' } },
                h('div', null, `· ${health.events ?? 0} 条记录，跨 ${health.days ?? 0} 天；判断 ${health.beliefs ?? 0} 条，记得很牢 ${health.solid ?? 0} 条`),
                health.empty
                  ? h('p', { className: 'dim', style: { margin: '4px 0 0' } }, '还太早：等她说出第一条判断，这里才有东西可看。')
                  : null,
                (health.tensions ?? []).length
                  ? h('div', { style: { marginTop: '4px' } }, `· 两句话对不上 ${health.tensions.length} 处`)
                  : null,
                ...(health.tensions ?? []).map((t) => h('div', { className: 'dim', key: `${t.a}|${t.b}` }, `　「${t.a}」／「${t.b}」`)),
                (health.stale ?? []).length
                  ? h('div', { style: { marginTop: '4px' } }, `· 快被忘掉的 ${health.stale.length} 条（${health.staleDays ?? 21} 天以上没再提起）`)
                  : null,
                ...(health.stale ?? []).map((s, i) => h('div', { className: 'dim', key: `s${i}` },
                  `　「${s.text}」${s.days != null ? ` · ${s.days} 天前` : ''}`)),
                (health.nearSolid ?? []).length
                  ? h('div', { style: { marginTop: '4px' } }, `· 快固定下来的 ${health.nearSolid.length} 条`)
                  : null,
                ...(health.nearSolid ?? []).map((n, i) => h('div', { className: 'dim', key: `n${i}` },
                  `　「${n.text}」 · 被提起 ${n.mentions} 次，被检验 ${n.verified} 次`)),
                (health.byType ?? []).length
                  ? h('div', { className: 'dim', style: { marginTop: '6px' } },
                      `记录构成：${health.byType.map((b) => `${b.type} ${b.count}`).join(' · ')}`)
                  : null,
                h('p', { className: 'dim', style: { marginTop: '8px' } },
                  '体检只看账本，不评价对错。两句话对不上不是错误——都可能是她当时真心这么想；快忘掉也不代表不重要，只是还没被反复提起或检验。')),
        ),

        archivedCard,

        resetCard)

      useEffect(() => {
        let stop = false
        setTodayErr('')
        const url = '/today' + (todayDate ? `?date=${encodeURIComponent(todayDate)}` : '')
        jget(url).then((r) => { if (!stop) setTodayData(r) }).catch((e) => { if (!stop) setTodayErr(String(e?.message || e)) })
        return () => { stop = true }
      }, [tab, todayDate])

      const KIND = { wake: '醒', sleep: '睡', said: '开口', watched: '看过画面', opened: '点开', read: '读到', revised: '改口', quiet: '没醒', failed: '叫醒失败', note: '日记' }
      const hhmm = (ts) => { const d = new Date(Number(ts) || ts); return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5) }
      const dayBtn = (label, offset) => {
        const d = new Date(); d.setDate(d.getDate() - offset)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        return h('button', { key, onClick: () => setTodayDate(offset === 0 ? '' : key) }, label)
      }
      const todayPage = h('div', null,
        h('div', { className: 'row', style: { marginBottom: '8px' } }, dayBtn('今天', 0), dayBtn('昨天', 1), dayBtn('前天', 2)),
        todayErr ? h('pre', { className: 'err' }, todayErr) : null,
        !todayData ? h('p', { className: 'dim' }, '读取中…') : h('div', null,
          // ① 一行现状：第几天 · 阶段 · 今天醒了几次 · 现在在哪 · 最近一句。
          h('div', { className: 'card' },
            h('div', null, `第 ${todayData.summary.day} 天 · ${todayData.summary.stageName} · 醒了 ${todayData.summary.wakes} 次 · 现在在 ${todayData.summary.lastChannel || '宿主会话'}`),
            h('div', { className: 'dim', style: { marginTop: '4px' } },
              todayData.summary.lastSaidAt ? `最近一句 ${hhmm(todayData.summary.lastSaidAt)}` : '今天还没开口')),
          // ② 时间线：每条一行，原文默认收起（点开才看全文）。
          h('h3', { style: { margin: '14px 0 6px' } }, '今天的时间线'),
          todayData.timeline.length
            ? h('div', null, todayData.timeline.map((x) => h('details', { key: `${x.at}-${x.kind}-${x.text.slice(0, 12)}`, style: { margin: '2px 0' } },
                h('summary', { style: { cursor: 'pointer' } },
                  h('span', { className: 'dim', style: { width: '46px', display: 'inline-block' } }, hhmm(x.at)),
                  h('span', { style: { width: '54px', display: 'inline-block' } }, KIND[x.kind] || x.kind),
                  x.channel ? h('span', { className: 'dim', style: { marginRight: '6px' } }, x.channel) : null,
                  h('span', null, x.text.length > 40 ? `${x.text.slice(0, 40)}…` : x.text)),
                h('div', { className: 'said', style: { marginTop: '4px', whiteSpace: 'pre-wrap' } }, x.text))))
            : h('p', { className: 'dim' }, '这一天没有记录。'),
          // ③ 今天变了什么：新学会 / 改了口 / 被推翻，各最多 3 条。
          h('h3', { style: { margin: '14px 0 6px' } }, '今天变了什么'),
          (() => {
            const ch = todayData.changes || {}
            const learned = Array.isArray(ch.learnedTexts) ? ch.learnedTexts : []
            const revised = Array.isArray(ch.revised) ? ch.revised : []
            const refuted = Array.isArray(ch.refuted) ? ch.refuted : []
            if (!learned.length && !revised.length && !refuted.length) return h('p', { className: 'dim' }, '还没变。')
            const part = (label, rows) => rows.length
              ? h('div', { style: { marginTop: '6px' } },
                  h('div', { className: 'dim' }, label),
                  h('ul', null, rows.slice(0, 3).map((x, i) => h('li', { key: `${label}${i}` }, x))))
              : null
            return h('div', null,
              h('div', { className: 'dim' }, `开口 ${Number(ch.learned) || 0} 次`),
              part('新学会', learned),
              part('改了口', revised),
              part('被推翻', refuted))
          })(),
          // ④ 手边：工具 · 身份文档预算 · 渠道连接 · 最近一次限流。
          h('h3', { style: { margin: '14px 0 6px' } }, '手边'),
          h('div', null, `工具 ${todayData.hands.tools} 个${todayData.hands.restrict ? '（已收窄）' : ''} · ${todayData.hands.qq ? 'QQ 在' : 'QQ 没开'}`),
          todayData.hands.docBudget ? h('div', { className: 'dim' }, `身份文档 ${todayData.hands.docBudget.used}/${todayData.hands.docBudget.budget} 字`) : null,
          todayData.hands.risk && (todayData.hands.risk.cooling || todayData.hands.risk.at)
            ? h('div', { className: 'dim' },
                todayData.hands.risk.cooling
                  ? `最近一次限流：还在冷却，还有 ${todayData.hands.risk.remainMin} 分钟（${todayData.hands.risk.code || '风控'}）`
                  : `最近一次限流：${String(todayData.hands.risk.at).slice(0, 16).replace('T', ' ')}（已解冻）`)
            : h('div', { className: 'dim' }, '最近一次限流：没有')))


      const showTab = (id) => tab === id


      return h('div', { className: 'dfish', ref: (el) => { topEl = el } },
        h('h2', null, NAMES.nav),
        // 天数 / 阶段 / 事件条数只在说一次（用户 m02666：状态页里又列了一遍，重复）。
        // 解释改挂在这一行的 title 上——鼠标停一下就能看，不占版面。
        h('p', {
          className: 'sub',
          title: s
            ? `第几天 / 四个阶段天数是从第一天算起的自然日，调大会让她走得更慢。阶段是四个瓶颈走到哪了。事件只算她真实经历的那些；另有 ${s.counts?.meta ?? 0} 条记账、${s.counts?.noise ?? 0} 条噪声不算。`
            : '第几天 / 四个阶段天数是从第一天算起的自然日。事件只算她真实经历的那些。',
        }, s ? `第 ${s.day} / ${s.stageSpanDays} 天 · ${s.stageName} · 事件 ${s.counts.real ?? s.counts.total} 条` : '读取中…'),
        err ? h('pre', { className: 'err' }, err) : null,
        note ? h('pre', { className: 'ok' }, note) : null,
        // 保存回执只是确认「存到了」，不占页签里的说明位（2026-10-29 用户）。
        autoNote ? h('p', { className: 'ok', style: { margin: '0 0 8px' } }, autoNote) : null,
        // 保存时被跳过的工具名（2026-10-31 issue #14）：和失败框分开——
        // 设置**存下去了**，只是名单里少了几个名字。悄悄少一个是更大的问题，所以必须说出来。
        droppedTools.length
          ? h('div', { className: 'card', style: { margin: '0 0 10px', borderLeft: '3px solid currentColor' } },
              h('div', null, `白名单里有 ${droppedTools.length} 个名字在这台机器上不存在，已经跳过：${droppedTools.join('、')}`),
              h('div', { className: 'dim', style: { marginTop: '4px' } }, '其它设置都存进去了。这些名字可能是以前装的插件留下的，也可能是拼错了。'),
              h('div', { className: 'row', style: { marginTop: '6px' } },
                h('button', {
                  onClick: () => {
                    // 名单里已经没有被丢掉的名字了（服务端存的就是干净那份），
                    // 这里只是把输入框草稿里可能还留着的字一起抹掉，然后收起这条提示。
                    const gone = new Set(droppedTools.map((n) => String(n)))
                    const keep = parseToolNames(toolsAllowText).filter((n) => !gone.has(n))
                    setToolsAllowText(keep.join(', '))
                    setDroppedTools([])
                  },
                }, '从名单里清掉这些名字'),
                h('button', { style: { marginLeft: '8px' }, onClick: () => setDroppedTools([]) }, '知道了')))
          : null,
        // 保存失败是一个要处理的状态，不是提示：一句人话先说清「不是你填错了」，
        // 技术信息另起一行留给开发者，自己点掉。放在页签栏上方，不混进设置项里。
        saveFail
          ? h('div', { className: 'err', style: { margin: '0 0 10px' } },
              h('div', null, '这一项没存上。不是你填错了——已经保存的内容没丢，调整之后再改一次就会重试；实在不行重启应用看看。'),
              h('div', { className: 'dim', style: { marginTop: '4px' } }, `技术信息：${saveFail}`),
              h('div', { className: 'row', style: { marginTop: '6px' } },
                h('button', { onClick: () => setSaveFail('') }, '知道了')))
          : null,

        tabBar,
        AUTO_SAVE_TABS.has(tab) ? h('p', { className: 'hint', style: { margin: '0 0 8px' } }, '这里的改动改完就生效，不需要点保存。') : null,

        showTab('today') ? todayPage : null,
        showTab('now') ? nowPage : null,
        showTab('grow') ? growPage : null,
        showTab('home') ? homePage : null,
        showTab('bili') ? biliPage : null,
        showTab('social') ? socialPage : null,
        showTab('channels') ? channelsPage : null,
        showTab('env') ? envPage : null,
        showTab('principle') ? principlePage : null,
        showTab('data') ? dataPage : null,
        showTab('feedback') ? feedbackPage : null,
      )
    }


    // ---------------------------------------------------------------- 挂载
    const inject = ['slots']
    const NAMES = { nav: '她' }

    // 侧栏那个「她」是宿主在打开设置时渲染的，比这一节里的 /state 早一步。
    // 只在这一节里改 NAMES.nav 已经晚了：导航条那边不会跟着重渲染（2026-11-07 真机截图）。
    // 所以插件一挂上就先问一次名字，等用户点开设置，label() 读到的就是她现在的名字。
    function prefetchNavName() {
      try {
        const saved = localStorage.getItem('dsh-roost:name')
        if (saved) NAMES.nav = saved
      } catch { /* 无痕模式没有 localStorage */ }
      try {
        fetch(API + '/state', { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!j || !j.herName) return
            NAMES.nav = String(j.herName)
            try { localStorage.setItem('dsh-roost:name', NAMES.nav) } catch { /* 存不了就算了 */ }
          })
          .catch(() => {})
      } catch {
        /* 拿不到名字就用「她」，不影响别的 */
      }
    }

    function apply(ctx) {
      prefetchNavName()
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: NS, order: 7, label: () => NAMES.nav },
              FishSection,
            ),
            'dsh-roost: settings section',
          ),
        'dsh-roost: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.FishSection = FishSection
    return module.exports
  },
})
