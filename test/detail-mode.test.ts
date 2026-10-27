/**
 * 「详细」模式的字数分档。
 *
 * 背景：用户说「详细说说这个视频」时，旧逻辑只按 recap 档（600 字）输出，
 * 装不下"总结 + 细节 + 分析"三段结构，结果要么截断要么只讲一部分。
 */

import { describe, expect, it } from 'vitest';
import { needsRecap, resolveReplyLimitWithRecap, wantsDetail } from '../src/core/topic.js';

describe('详细模式识别', () => {
  it('识别「详细」「完整」「展开」等要求', () => {
    expect(wantsDetail('详细说说这个视频讲了什么')).toBe(true);
    expect(wantsDetail('要完整，不能漏')).toBe(true);
    expect(wantsDetail('展开讲讲')).toBe(true);
    expect(wantsDetail('具体分析一下')).toBe(true);
    expect(wantsDetail('尽量多讲点细节')).toBe(true);
    expect(wantsDetail('不要省略任何内容')).toBe(true);
  });

  it('普通提问不算详细', () => {
    expect(wantsDetail('这个视频说了什么')).toBe(false);
    expect(wantsDetail('画个猫')).toBe(false);
    expect(wantsDetail('今天好累')).toBe(false);
  });
});

describe('字数分档', () => {
  it('闲聊 120', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['今天好累'], 1500);
    expect(r.kind).toBe('chat');
    expect(r.limit).toBe(120);
  });

  it('技术 300', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['docker 启动失败怎么办'], 1500);
    expect(r.kind).toBe('tech');
    expect(r.limit).toBe(300);
  });

  it('内容交代 600', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['这个视频说了什么'], 1500);
    expect(r.kind).toBe('recap');
    expect(r.limit).toBe(600);
  });

  it('详细模式 1500', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['详细说说这个视频讲了什么'], 1500);
    expect(r.kind).toBe('detail');
    expect(r.limit).toBe(1500);
  });

  it('详细模式优先级最高', () => {
    // 「详细讲讲这个技术问题」同时命中 tech 和 detail，应该按 detail
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['详细讲讲这个技术问题了，要完整'], 1500);
    expect(r.kind).toBe('detail');
  });

  it('detailChars 缺省时至少 1500', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['详细说说'], undefined);
    expect(r.limit).toBeGreaterThanOrEqual(1500);
  });

  it('自定义 detailChars 生效', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['详细说说'], 3000);
    expect(r.limit).toBe(3000);
  });

  it('各档不会低于基础值', () => {
    const r = resolveReplyLimitWithRecap(800, 300, 600, ['详细说说'], 1500);
    expect(r.limit).toBeGreaterThanOrEqual(800);
  });
});

describe('recap 与 detail 的关系', () => {
  it('详细模式包含 recap 的场景', () => {
    const text = '详细说说这个视频讲了什么';
    expect(needsRecap(text)).toBe(true);
    expect(wantsDetail(text)).toBe(true);
    // detail 优先
    const r = resolveReplyLimitWithRecap(120, 300, 600, [text], 1500);
    expect(r.kind).toBe('detail');
  });

  it('只说视频不讲详细 → recap', () => {
    const text = '这个视频讲了什么';
    expect(needsRecap(text)).toBe(true);
    expect(wantsDetail(text)).toBe(false);
    const r = resolveReplyLimitWithRecap(120, 300, 600, [text], 1500);
    expect(r.kind).toBe('recap');
  });
});
