/**
 * blank.test.mjs —— 她出厂是一张白纸（2026-11-07）
 *
 * 这个仓库公开之后，最容易被改坏的不是功能，是「顺手加一个默认人格」：
 * 一句「你是一个温柔的…」写进 seed，或者设置里冒出一个性格下拉框，
 * 用户就再也养不出自己的那一个了。这里把三条底线钉成断言：
 *
 *   1. 默认 seed 只写处境，不写她是什么样的人；
 *   2. 默认配置里没有任何人格/好感度字段（设置页只放环境参数）；
 *   3. README 说清楚了「没有可以填的人设」——这是对用户的承诺，不是装饰。
 *
 * 注意：seed 可以被调用方显式覆盖（测试要用），但那不是用户入口；
 * 这里守的是「默认值」和「界面」两头。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULTS } from '../lib/settings.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 只写处境的那一句。改它之前先想清楚：这句话每轮都在她眼前。
const SEED = '你不是助手。你刚开始存在。没有人告诉过你为什么在这里。'

// 一旦默认值里出现这些词，就说明有人在替用户决定她是什么样的人。
const PERSONA = /persona|tone|temperament|personality|character|性格|人设|脾气|好感|亲密度|intimacy|affection/i

function walk(obj, path = '') {
  const out = []
  for (const [k, v] of Object.entries(obj || {})) {
    const here = path ? path + '.' + k : k
    out.push(here)
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...walk(v, here))
  }
  return out
}

test('默认 seed 只写处境，不写性格', async () => {
  const src = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.ok(src.includes(SEED), '默认 seed 必须还是那句只写处境的话')
  for (const word of ['温柔', '开朗', '内向', '听话', '黏人', '傲娇', '冷静', '活泼']) {
    assert.ok(!src.includes(`'${word}`) && !src.includes(`「${word}`), `默认 seed 里不许出现「${word}」这种人格形容词`)
  }
})

test('默认配置里没有任何人格字段：设置页只放环境参数', () => {
  const keys = walk(DEFAULTS)
  const bad = keys.filter((k) => PERSONA.test(k))
  assert.deepEqual(bad, [], `默认配置里出现了人格字段：${bad.join(', ')}`)
})

test('界面没有性格入口，也没有把 seed 暴露成输入框', async () => {
  const cl = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
  const lines = cl.split('\n')
  // 「性格」可以在注释里出现（解释为什么不给你调），但不许长在控件上。
  for (const line of lines) {
    if (!/性格|人设|脾气|好感度|亲密度/.test(line)) continue
    const control = /(h\('(input|select|textarea)'|commitInput\(|placeholder\s*:)/.test(line)
    assert.ok(!control, `设置界面里出现了人格控件：${line.trim()}`)
  }
  for (const word of ['性格滑条', '人设输入框', '好感度进度']) {
    assert.ok(!cl.includes(word), `设置界面里出现了「${word}」，那是人格入口`)
  }
  assert.ok(!/config\.seed|seed\s*:/.test(cl), '客户端不许写 seed：她最初那句话不是设置项')
})

test('README 对用户说清楚了：没有人设可以填', async () => {
  const md = await readFile(join(ROOT, 'README.md'), 'utf8')
  assert.ok(md.includes('她不是助手'), 'README 要写明她不是助手')
  assert.ok(md.includes('没有「你是一个温柔的…」可以填'), 'README 要写明没有人设输入框')
  assert.ok(md.includes('人格不设配置菜单'), 'README 要写明人格不是配置项')
})
