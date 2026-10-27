/**
 * 语音触发词收紧 + 视频深读双输出。
 *
 * 背景（2026-10-27 真群故障）：
 *   用户发「详细的说一下这个视频」，机器人没读视频，
 *   反而把用户这句话念了一遍发成语音。
 *
 * 两个 bug：
 *   1. SPEAK_PATTERN 太宽松：「详细的说一下这个视频」命中了 `(说|念|读|讲)`
 *   2. ASR 触发词漏了：「详细的说一下这个视频」没命中 wantsAudio
 */

import { describe, expect, it } from 'vitest';
import { extractSpeechText, wantsSpeech } from '../src/core/tts.js';

describe('语音触发词收紧（防误触发）', () => {
  it('要求解释类不触发语音', () => {
    // 这些是「让人解释」，不是「让人念出来」
    expect(wantsSpeech('详细的说一下这个视频')).toBe(false);
    expect(wantsSpeech('详细说一下这个视频')).toBe(false);
    expect(wantsSpeech('给我说一下天气')).toBe(false);
    expect(wantsSpeech('讲一下原理')).toBe(false);
    expect(wantsSpeech('念一遍这首诗')).toBe(false);
    expect(wantsSpeech('读一下这段代码')).toBe(false);
    expect(wantsSpeech('读一下这个函数')).toBe(false);
    expect(wantsSpeech('解释一下')).toBe(false);
  });

  it('视频相关提问不触发语音', () => {
    expect(wantsSpeech('这个视频说了什么')).toBe(false);
    expect(wantsSpeech('这个视频好看吗')).toBe(false);
    expect(wantsSpeech('看一下画面')).toBe(false);
  });

  it('明确要语音的仍然触发', () => {
    expect(wantsSpeech('说一句你好')).toBe(true);
    expect(wantsSpeech('念一下这段话')).toBe(true);
    expect(wantsSpeech('用语音说你好')).toBe(true);
    expect(wantsSpeech('念给我听')).toBe(true);
  });

  it('语言 + 情绪组合仍触发', () => {
    expect(wantsSpeech('用日语说一句求求你了')).toBe(true);
    expect(wantsSpeech('用日语愤怒的说一句为什么要弹春日影')).toBe(true);
    expect(wantsSpeech('用温柔的语气念一段')).toBe(true);
  });

  it('提取内容正确', () => {
    expect(extractSpeechText('用日语愤怒的说一句为什么要弹春日影')).toBe('为什么要弹春日影');
    expect(extractSpeechText('说一句你好')).toBe('你好');
  });
});

describe('视频深读触发词（wantsAudio 逻辑复刻）', () => {
  // 与 pipeline.ts 里的正则保持一致
  const wantsAudio = (userText: string): boolean =>
    /(说|讲|念|听|读)(了|一下|下)?(什么|啥|啥内容|一下|声音|内容)/.test(userText) ||
    /(台词|原话|口播|旁白|语音|声音)/.test(userText) ||
    /不看弹幕|不只看弹幕|看下听|听一下|听下/.test(userText) ||
    /(详细|具体|展开|仔细|完整)(地|的)?\s*(说|讲|介绍|描述|说说|讲讲|说一下|讲一下|介绍下)/.test(userText) ||
    /(到底|究竟)\s*(说|讲|聊)(了)?(什么|啥)/.test(userText) ||
    /视频.{0,4}(内容|讲|说)/.test(userText);

  it('截图里那句现在能触发 ASR', () => {
    expect(wantsAudio('详细的说一下这个视频')).toBe(true);
    expect(wantsAudio('详细说一下这个视频')).toBe(true);
  });

  it('原有触发词仍然有效', () => {
    expect(wantsAudio('视频里说了什么')).toBe(true);
    expect(wantsAudio('听一下')).toBe(true);
    expect(wantsAudio('视频台词')).toBe(true);
    expect(wantsAudio('不只看弹幕')).toBe(true);
  });

  it('补充的触发词', () => {
    expect(wantsAudio('到底讲了什么')).toBe(true);
    expect(wantsAudio('具体介绍一下')).toBe(true);
    expect(wantsAudio('视频内容是什么')).toBe(true);
  });

  it('无关消息不触发', () => {
    expect(wantsAudio('今天好累')).toBe(false);
    expect(wantsAudio('这个视频好看吗')).toBe(false);
  });
});
