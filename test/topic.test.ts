/**
 * 话题检测与字数上限测试。
 *
 * 背景：闲聊要短，技术问题要说清楚。字数上限随话题浮动，
 * 这两种场景必须都覆盖到，且不能误判（把闲聊当成技术问题会变啰嗦）。
 */

import { describe, expect, it } from 'vitest';
import { isTechnicalTopic, resolveReplyLimit } from '../src/core/topic.js';

describe('技术话题检测', () => {
  it('识别编程语言与工具', () => {
    expect(isTechnicalTopic('这个 typescript 类型怎么写')).toBe(true);
    expect(isTechnicalTopic('docker 起不来怎么办')).toBe(true);
    expect(isTechnicalTopic('git rebase 和 merge 有什么区别')).toBe(true);
  });

  it('识别 AI / 大模型话题', () => {
    expect(isTechnicalTopic('deepseek 的 api 怎么调用')).toBe(true);
    expect(isTechnicalTopic('prompt 该怎么写才好')).toBe(true);
  });

  it('识别排障表达', () => {
    expect(isTechnicalTopic('报错了：NullPointerException')).toBe(true);
    expect(isTechnicalTopic('服务崩溃了怎么看日志')).toBe(true);
  });

  it('识别请教类表达', () => {
    expect(isTechnicalTopic('这个算法的时间复杂度是多少')).toBe(true);
    expect(isTechnicalTopic('能帮我看看这段代码吗')).toBe(true);
  });

  it('闲聊不误判为技术话题', () => {
    expect(isTechnicalTopic('今天好热啊')).toBe(false);
    expect(isTechnicalTopic('我吃饭去了')).toBe(false);
    expect(isTechnicalTopic('好累，想睡觉')).toBe(false);
    expect(isTechnicalTopic('周末去哪玩')).toBe(false);
  });

  it('空字符串不算技术话题', () => {
    expect(isTechnicalTopic('')).toBe(false);
    expect(isTechnicalTopic('   ')).toBe(false);
  });

  it('中英混合也能识别', () => {
    expect(isTechnicalTopic('这个 bug 我查了一下午')).toBe(true);
  });
});

describe('回复字数上限', () => {
  it('闲聊用基础上限', () => {
    expect(resolveReplyLimit(120, 300, ['今天好热啊'])).toBe(120);
  });

  it('技术话题放宽到 tech 上限', () => {
    expect(resolveReplyLimit(120, 300, ['python 的装饰器怎么用'])).toBe(300);
  });

  it('上下文里出现技术词也算', () => {
    const texts = ['刚才那个 api 报错了', '嗯嗯']; // 取最近 3 条
    expect(resolveReplyLimit(120, 300, texts)).toBe(300);
  });

  it('未配置 tech 上限时回退到 max(基础, 300)', () => {
    expect(resolveReplyLimit(120, undefined, ['报错了怎么办'])).toBe(300);
    expect(resolveReplyLimit(500, undefined, ['报错了怎么办'])).toBe(500);
  });

  it('基础上限缺省为 120', () => {
    expect(resolveReplyLimit(undefined, 300, ['闲聊'])).toBe(120);
  });

  it('未配置 tech 上限时取 max(基础, 300)', () => {
    // 基础 200 → 技术场景 300（不会因为基础值小就把长回答砍短）
    expect(resolveReplyLimit(200, undefined, ['算法复杂度'])).toBe(300);
  });

  it('技术上限低于基础时以基础为准，不被截短', () => {
    // 显式配了 tech=150 但基础是 400：技术场景仍应给足 400
    expect(resolveReplyLimit(400, 150, ['这段代码怎么改'])).toBe(400);
  });
});
