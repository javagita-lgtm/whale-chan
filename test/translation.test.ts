/**
 * 翻译必须完整。
 *
 * 真实故障（2026-10-29）：用户说「翻译一下这段话」，
 * 机器人翻到一半就停了。
 *
 * 根因：翻译请求匹配不到 recap（总结）/ detail（详细），
 * 落到 chat 档（120 字），sanitizeReply 硬截断。
 */

import { describe, expect, it } from 'vitest';
import {
  resolveReplyLimitWithRecap,
  wantsTranslation,
} from '../src/core/topic.js';

const BASE = 120;
const TECH = 300;
const RECAP = 600;
const DETAIL = 1500;

function resolve(text: string) {
  return resolveReplyLimitWithRecap(BASE, TECH, RECAP, [text], DETAIL);
}

describe('翻译意图识别', () => {
  it('常见说法', () => {
    expect(wantsTranslation('翻译一下这段话')).toBe(true);
    expect(wantsTranslation('帮我翻译成英文')).toBe(true);
    expect(wantsTranslation('这段日语翻成中文')).toBe(true);
    expect(wantsTranslation('译为英语')).toBe(true);
    expect(wantsTranslation('译成中文')).toBe(true);
    expect(wantsTranslation('translate this')).toBe(true);
    expect(wantsTranslation('中译英')).toBe(true);
    expect(wantsTranslation('日译中')).toBe(true);
  });

  it('普通聊天不触发', () => {
    expect(wantsTranslation('今天天气真好')).toBe(false);
    expect(wantsTranslation('总结一下这个视频')).toBe(false);
    expect(wantsTranslation('这是什么意思')).toBe(false);
  });
});

describe('翻译档位', () => {
  it('基本翻译走 translate 档', () => {
    const r = resolve('翻译一下这段话');
    expect(r.kind).toBe('translate');
    expect(r.limit).toBeGreaterThanOrEqual(2000);
  });

  it('翻译上限远大于 chat', () => {
    const t = resolve('帮我翻译成英文');
    const c = resolve('今天天气真好');
    expect(t.limit).toBeGreaterThan(c.limit * 10);
  });

  it('翻译优先于 recap', () => {
    // 「翻译一下这个视频的内容」既有翻译又有 recap 词
    const r = resolve('翻译一下这个视频的内容');
    expect(r.kind).toBe('translate');
  });

  it('翻译优先于 detail', () => {
    const r = resolve('详细翻译这段，不要省略');
    expect(r.kind).toBe('translate');
  });

  it('长原文也能容纳', () => {
    const long =
      '翻译一下这段话：今天天气真好，我和朋友一起去了公园，看到很多人在散步，' +
      '还有小孩在放风筝，感觉非常惬意，这样的日子真是难得，希望以后还能经常出来走走。' +
      '公园里的樱花开得正好，粉色的花瓣随风飘落，落在湖面上像一层薄薄的雪。' +
      '我们在湖边的长椅上坐了很久，聊了很多过去的事情，不知不觉天就黑了。';
    const r = resolve(long);
    expect(r.kind).toBe('translate');
    // 这段约 130 字，翻译成英文可能 300+ 字符
    expect(r.limit).toBeGreaterThan(long.length * 3);
  });
});

describe('其他档位不受影响', () => {
  it('闲聊还是 120', () => {
    expect(resolve('今天天气真好')).toEqual({ limit: BASE, kind: 'chat' });
  });

  it('技术问题 300', () => {
    const r = resolve('Python 的 GIL 是什么原理');
    expect(r.kind).toBe('tech');
    expect(r.limit).toBe(TECH);
  });

  it('总结 600', () => {
    const r = resolve('总结一下这个视频说了什么');
    expect(r.kind).toBe('recap');
    expect(r.limit).toBe(RECAP);
  });

  it('详细模式 1500', () => {
    const r = resolve('详细说说这个原理');
    expect(r.kind).toBe('detail');
    expect(r.limit).toBe(DETAIL);
  });
});

describe('历史也参与判断', () => {
  it('本条没提翻译、上文提了也算', () => {
    const r = resolveReplyLimitWithRecap(
      BASE,
      TECH,
      RECAP,
      ['继续', '翻译一下这段话'],
      DETAIL,
    );
    expect(r.kind).toBe('translate');
  });
});
