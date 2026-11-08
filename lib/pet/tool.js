/**
 * pet/tool.js —— pet_act：她主动让身体动一下
 *
 * 2026-11-08（m09369）：**不进 FISH_TOOLS**。它是常驻白名单，selfcheck 会逐项核对；
 * 宠物关着的时候每次正常安装都会报「少一个工具」。所以只在 pet 打开时
 * 由 index.js 通过 registerToolRestrict 的 extra 追加。
 *
 * 2026-11-08 17:50 协调板：动作表从角色包的 pet.json 现读，不再写死。
 * 这份 schema 在工具注册时定死，所以换了角色包要重启才生效。
 */

import { toJsonSchema } from '../toolschema.js'
import { BUILTIN_ACTIONS, actionLabel, safeActionName } from './actions.js'

/** 内置动作：测试和回落都用这一份。 */
export const PET_ACTIONS = BUILTIN_ACTIONS

/** 描述里最多列这么多个；再多就只靠 enum，免得工具说明吃掉上下文。 */
const SHOW_MAX = 20

/**
 * @param {object} ctx 宿主上下文
 * @param {{sendAct:(action:string, why:string)=>boolean, enabled:()=>boolean,
 *          actions?:string[], labels?:Record<string,string>}} deps
 */
export function registerPetAct(ctx, deps = {}) {
  const sendAct = typeof deps.sendAct === 'function' ? deps.sendAct : () => false
  const enabled = typeof deps.enabled === 'function' ? deps.enabled : () => false
  const custom = Array.isArray(deps.actions)
    ? [...new Set(deps.actions.map((x) => String(x).trim()).filter(safeActionName))]
    : []
  const actions = custom.length ? custom : [...PET_ACTIONS]
  const labels = deps.labels && typeof deps.labels === 'object' ? deps.labels : {}
  const shown = actions.slice(0, SHOW_MAX).map((a) => `${a} ${actionLabel(a, labels)}`)
  const more = actions.length > SHOW_MAX ? `等 ${actions.length} 个` : ''
  const off = ctx.tools.register({
    name: 'pet_act',
    description: [
      '让身体动一下。这是身体语言，不代替说话；说话时也可以同时调它。',
      '可用的动作：',
      `${shown.join(' / ')}${more ? ` / ${more}` : ''}。`,
      'why 可以写一句为什么，也可以不写。动作表换了角色包要重启才更新。',
    ].join(' '),
    // 必须 toJsonSchema：简写 DSL 或手写的 schema 直接发出去会被宿主/ provider 拒。
    // 2026-11-08 真机：手写的标准形态被宿主报
    //   tool "pet_act" parameters must be lossless JSON before schema projection
    // 并连带整批工具不可用（同一轮里连 ops_* 都报 cannot resolve availability）。
    // 照 lib/capture.js:76-78 的写法过一遍转换器。
    parameters: toJsonSchema({
      action: {
        type: 'string',
        required: true,
        enum: actions,
        description: '要做的动作',
      },
      why: { type: 'string', required: false, description: '为什么动（可不填）' },
    }),
    // 2026-11-08 真机：宿主现在要求每个工具声明 output。
    // 形状照 lib/capture.js:113-136；render 必须返回 ContentBlock 数组，
    // 签名是 (args, value)，返回单个字符串会被当成 content.some is not a function。
    // 回执只写机器状态，不写她能顺着复述的句子。
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['ok', 'note'],
      },
      render: (_args, out) => [
        { type: 'text', text: out?.ok ? '[动了]' : `[没动：${String(out?.note ?? '没送出去')}]` },
      ],
    },
    async execute(args) {
      if (!enabled()) return { ok: false, note: '桌宠没开。' }
      const action = String(args?.action ?? '').trim()
      if (!actions.includes(action)) {
        const few = actions.slice(0, 6).join('、')
        return { ok: false, note: `没有这个动作：${action || '（空）'}。手边有：${few}。` }
      }
      const why = String(args?.why ?? '').trim().slice(0, 120)
      const ok = sendAct(action, why)
      return ok
        ? { ok: true, note: actionLabel(action, labels) || '动了一下' }
        : { ok: false, note: '桌宠没连上，动作没送出去。' }
    },
  })
  return () => { try { off?.() } catch { /* ignore */ } }
}
