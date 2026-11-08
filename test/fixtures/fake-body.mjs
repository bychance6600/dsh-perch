/**
 * test/fixtures/fake-body.mjs —— 假桌宠，不 spawn 进程
 *
 * 2026-11-08（m09369）：这台机器上真 spawn 会 EPERM。bridge 只认注入的
 * readable / writable，所以测试用一对 PassThrough 把协议跑通。
 */

import { PassThrough } from 'node:stream'

/**
 * @param {{pet?:string, helloDelayMs?:number, silent?:boolean}} o
 */
export function fakeBody(o = {}) {
  const fromBody = new PassThrough()
  const toBody = new PassThrough()
  const lines = []
  const body = {
    readable: fromBody,
    writable: toBody,
    sent: lines,
    /** 模拟 body 说 hello。 */
    hello({ v = 1, pet = o.pet ?? '假桌宠' } = {}) {
      fromBody.write(JSON.stringify({ t: 'hello', v, body: '0.0.0', pet }) + '\n')
    },
    say(id, text) {
      fromBody.write(JSON.stringify({ t: 'say', id, seq: 0, text, final: true }) + '\n')
    },
    input(id, text) {
      fromBody.write(JSON.stringify({ t: 'input', id, text }) + '\n')
    },
    poke(x, y) {
      fromBody.write(JSON.stringify({ t: 'poke', x, y }) + '\n')
    },
    ack(id) {
      fromBody.write(JSON.stringify({ t: 'ack', id }) + '\n')
    },
    bye() {
      fromBody.write(JSON.stringify({ t: 'bye' }) + '\n')
    },
    /** 读 roost 发过来的一行（没就返回 null）。 */
    read() {
      while (toBody.readableLength) {
        const chunk = toBody.read()
        if (!chunk) break
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) lines.push(line.trim())
        }
      }
      return lines.length ? JSON.parse(lines.shift()) : null
    },
    async readAsync() {
      const got = body.read()
      if (got) return got
      return await new Promise((resolve) => {
        const onData = () => {
          toBody.off('data', onData)
          resolve(body.read())
        }
        toBody.on('data', onData)
      })
    },
    end() { fromBody.end() },
  }
  return body
}
