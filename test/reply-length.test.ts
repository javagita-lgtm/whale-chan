/**
 * 字数上限随任务类型调整。
 *
 * 背景：视频总结被截在 120 字，句子断在半截。
 * 根因是字数上限只有「闲聊 / 技术」两档，没有「内容交代」这一档。
 */

import { describe, expect, it } from 'vitest';
import { needsRecap, resolveReplyLimitWithRecap } from '../src/core/topic.js';

describe('内容交代场景识别', () => {
  it('视频/文章总结类要识别出来', () => {
    expect(needsRecap('视频里说了什么？')).toBe(true);
    expect(needsRecap('这个视频讲了啥')).toBe(true);
    expect(needsRecap('总结一下这个链接')).toBe(true);
    expect(needsRecap('这文章说了什么')).toBe(true);
    expect(needsRecap('帮我概括下要点')).toBe(true);
  });

  it('普通闲聊不算', () => {
    expect(needsRecap('今天好累啊')).toBe(false);
    expect(needsRecap('哈哈哈')).toBe(false);
    expect(needsRecap('早安')).toBe(false);
  });

  it('技术问题归技术，不算内容交代', () => {
    expect(needsRecap('docker 容器启动就退出怎么办')).toBe(false);
  });
});

describe('字数上限分档', () => {
  it('闲聊用基础值', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['今天好累啊']);
    expect(r.kind).toBe('chat');
    expect(r.limit).toBe(120);
  });

  it('技术问题用技术值', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['docker 启动就退出怎么办']);
    expect(r.kind).toBe('tech');
    expect(r.limit).toBe(300);
  });

  it('内容交代用最宽的那档', () => {
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['视频里说了什么？']);
    expect(r.kind).toBe('recap');
    expect(r.limit).toBe(600);
  });

  it('内容交代优先级高于技术（两者都命中时取更宽的）', () => {
    // 「这个技术视频讲了什么」同时命中技术词和内容词
    const r = resolveReplyLimitWithRecap(120, 300, 600, ['这个技术视频讲了什么']);
    expect(r.kind).toBe('recap');
    expect(r.limit).toBe(600);
  });

  it('阈值可自定义', () => {
    const r = resolveReplyLimitWithRecap(150, 400, 1000, ['视频讲了什么']);
    expect(r.limit).toBe(1000);
  });

  it('recap 缺省时不低于技术档', () => {
    const r = resolveReplyLimitWithRecap(120, 300, undefined, ['视频讲了什么']);
    expect(r.limit).toBeGreaterThanOrEqual(300);
  });

  it('基础值调高后各档都不会反而更短', () => {
    const r = resolveReplyLimitWithRecap(500, 300, 600, ['今天不错']);
    expect(r.limit).toBeGreaterThanOrEqual(500);
  });

  it('全部缺省时用安全默认值', () => {
    const r = resolveReplyLimitWithRecap(undefined, undefined, undefined, ['视频讲了什么']);
    expect(r.limit).toBeGreaterThanOrEqual(600);
  });
});
