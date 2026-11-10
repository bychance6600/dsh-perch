/**
 * 可选子包的加载器（2026-11-02）
 *
 * 「可选装」不靠开关，靠**装没装**：没装子包时 `import()` 抛
 * `ERR_MODULE_NOT_FOUND`，这里吞掉并返回 null，主包照常启动、整条渠道消失。
 * 这样用户不会因为少装一个包看到红色报错。
 *
 * 两个找法（2026-11-03 补第二个）：
 * 1. `dsh-perch-douyin` —— 单独 npm 装了，或 profile 里 link 过；
 * 2. `../../packages/dsh-perch-douyin/index.js` —— 从 GitHub / 压缩包整包下载时，
 *    子包就在仓库里。没有第二个的话，非 npm 安装的人会以为「抖音没做」。
 */

const CANDIDATES = [
  'dsh-perch-douyin',
  '../../packages/dsh-perch-douyin/index.js',
]

let cached = null

/**
 * 子包的整份导出。抖音适配器要的是传输层（`createCdpTransport`）与推荐流
 * （`browseFeed`），不是聊天适配器。
 * 只缓存成功的那一份；找不到就返回 null，下次还能再试。
 */
export async function loadSubModule() {
  if (cached) return cached
  for (const spec of CANDIDATES) {
    try {
      cached = await import(spec)
      return cached
    } catch (err) {
      // 只有「找不到」可以继续试下一个；语法错、导出错要让它显形，否则永远静默
      if (String(err?.code ?? '') === 'ERR_MODULE_NOT_FOUND') continue
      throw err
    }
  }
  return null
}

/** 用于日志与 `status()`：只报「哪份代码在用」，不报绝对路径。 */
export const SUB_CANDIDATES = CANDIDATES

export default { loadSubModule, SUB_CANDIDATES }
