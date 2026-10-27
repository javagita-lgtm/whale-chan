/**
 * 语音触发词与文本提取。
 */

import { describe, expect, it } from 'vitest';
import { detectSpeechLang, extractSpeechText, wantsSpeech } from '../src/core/tts.js';

describe('语音触发词', () => {
  it('识别常见说法', () => {
    expect(wantsSpeech('说一句你好')).toBe(true);
    expect(wantsSpeech('念一下这段话')).toBe(true);
    expect(wantsSpeech('用语音说你好')).toBe(true);
    expect(wantsSpeech('用日语说一句求求你了')).toBe(true);
    expect(wantsSpeech('用英语念一下hello')).toBe(true);
    expect(wantsSpeech('来一句语音')).toBe(true);
    expect(wantsSpeech('语音说一句晚安')).toBe(true);
    expect(wantsSpeech('读一遍')).toBe(true);
  });

  it('普通聊天不触发', () => {
    expect(wantsSpeech('今天好累啊')).toBe(false);
    expect(wantsSpeech('哈哈哈')).toBe(false);
    expect(wantsSpeech('你在说什么')).toBe(false);
  });

  it('太短不触发', () => {
    expect(wantsSpeech('说')).toBe(false);
  });
});

describe('提取朗读文本', () => {
  it('去掉「说一句」前缀', () => {
    expect(extractSpeechText('说一句你好呀')).toBe('你好呀');
    expect(extractSpeechText('念一下这段话')).toBe('这段话');
  });

  it('去掉「用语音说」前缀', () => {
    expect(extractSpeechText('用语音说晚安')).toBe('晚安');
  });

  it('去掉 @ 标记', () => {
    expect(extractSpeechText('[艾特你] 说一句你好')).toBe('你好');
  });

  it('保留完整句子', () => {
    const r = extractSpeechText('说一句今天天气真不错，适合出去走走。');
    expect(r).toContain('今天天气真不错');
  });

  it('剥掉语言指令和引号', () => {
    expect(extractSpeechText('用日语说一句求求你了')).toBe('求求你了');
    expect(extractSpeechText('用日语说一句「求求你了」')).toBe('求求你了');
    expect(extractSpeechText('用英语念一下thank you')).toBe('thank you');
  });
});

describe('语言意图识别', () => {
  it('识别日语/英语/粤语/韩语', () => {
    expect(detectSpeechLang('用日语说一句求求你了')).toBe('ja');
    expect(detectSpeechLang('用日文念一下')).toBe('ja');
    expect(detectSpeechLang('用英语说hello')).toBe('en');
    expect(detectSpeechLang('用粤语讲一句')).toBe('yue');
    expect(detectSpeechLang('用韩语说你好')).toBe('ko');
  });

  it('没提语言时返回 null（交给适配层自动判断）', () => {
    expect(detectSpeechLang('说一句你好')).toBeNull();
    expect(detectSpeechLang('念一下这段话')).toBeNull();
  });
});
