/**
 * pet/tool.js —— pet_act：她主动让身体动一下
 *
 * 2026-11-08（m09369）：**不进 FISH_TOOLS**。它是常驻白名单，selfcheck 会逐项核对；
 * 宠物关着的时候每次正常安装都会报「少一个工具」。所以只在 pet 打开时
 * 由 index.js 通过 registerToolRestrict 的 extra 追加。
 */

export const PET_ACTIONS = Object.freeze(['nod', 'shake', 'bounce', 'shy', 'laugh', 'stretch', 'sleep', 'wake', 'quiet', 'loud'])

const ACTION_TEXT = {
  nod: '点了点头',
  shake: '摇了摇头',
  bounce: '跳了一下',
  shy: '有点不好意思',
  laugh: '笑了一下',
  stretch: '伸了个懒腰',
  sleep: '去睡了',
  wake: '醒了',
  quiet: '安静下来',
  loud: '出了点声',
}

/**
 * @param {object} ctx 宿主上下文
 * @param {{sendAct:(action:string, why:string)=>boolean, enabled:()=>boolean}} deps
 */
export function registerPetAct(ctx, deps = {}) {
  const sendAct = typeof deps.sendAct === 'function' ? deps.sendAct : () => false
  const enabled = typeof deps.enabled === 'function' ? deps.enabled : () => false
  const off = ctx.tools.register({
    name: 'pet_act',
    description: [
      '让身体动一下。这是身体语言，不代替说话；说话时也可以同时调它。',
      '可用的动作：',
      'nod 点头 / shake 摇头 / bounce 跳一下 / shy 不好意思 / laugh 笑 /',
      'stretch 伸懒腰 / sleep 去睡了 / wake 醒了 / quiet 安静 / loud 出声。',
      'why 可以写一句为什么，也可以不写。',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...PET_ACTIONS], description: '要做的动作' },
        why: { type: 'string', description: '为什么动（可不填）' },
      },
      required: ['action'],
    },
    async execute(args) {
      if (!enabled()) return { ok: false, note: '桌宠没开。' }
      const action = String(args?.action ?? '').trim()
      if (!PET_ACTIONS.includes(action)) {
        return { ok: false, note: `没有这个动作：${action || '（空）'}。` }
      }
      const why = String(args?.why ?? '').trim().slice(0, 120)
      const ok = sendAct(action, why)
      return ok
        ? { ok: true, note: ACTION_TEXT[action] ?? '动了一下' }
        : { ok: false, note: '桌宠没连上，动作没送出去。' }
    },
  })
  return () => { try { off?.() } catch { /* ignore */ } }
}
