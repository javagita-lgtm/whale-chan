/**
 * 情绪识别单测。
 *
 * 背景：GPT-SoVITS 没有情绪参数，情绪完全由参考音频决定。
 * 所以要先把用户说的情绪识别出来，再去参考音频库里挑对应的那段。
 */

import { describe, expect, it } from 'vitest';
import {
  detectEmotion,
  detectSpeechLang,
  extractSpeechText,
  wantsSpeech,
} from '../src/core/tts.js';

describe('情绪识别', () => {
  it('识别愤怒', () => {
    expect(detectEmotion('用日语愤怒的说一句为什么要弹春日影')).toBe('angry');
    expect(detectEmotion('用生气的语气说')).toBe('angry');
    expect(detectEmotion('发火地说一句')).toBe('angry');
  });

  it('识别开心', () => {
    expect(detectEmotion('开心地说一句早上好')).toBe('happy');
    expect(detectEmotion('用兴奋的语气')).toBe('happy');
  });

  it('识别悲伤', () => {
    expect(detectEmotion('难过地说一句')).toBe('sad');
    expect(detectEmotion('用失落的语气')).toBe('sad');
  });

  it('识别惊讶', () => {
    expect(detectEmotion('惊讶地说一句')).toBe('surprise');
    expect(detectEmotion('震惊地说')).toBe('surprise');
  });

  it('识别害羞', () => {
    expect(detectEmotion('害羞地说一句')).toBe('shy');
  });

  it('识别平静', () => {
    expect(detectEmotion('温柔地说一句')).toBe('calm');
  });

  it('没提情绪时返回 null', () => {
    expect(detectEmotion('说一句你好')).toBeNull();
    expect(detectEmotion('用日语说一句求求你了')).toBeNull();
  });
});

describe('情绪 + 语言 + 内容 同时解析', () => {
  it('愤怒 + 日语', () => {
    const t = '用日语愤怒的说一句为什么要弹春日影';
    expect(wantsSpeech(t)).toBe(true);
    expect(detectSpeechLang(t)).toBe('ja');
    expect(detectEmotion(t)).toBe('angry');
    expect(extractSpeechText(t)).toBe('为什么要弹春日影');
  });

  it('开心 + 日语', () => {
    const t = '用日语开心地说一句早上好';
    expect(wantsSpeech(t)).toBe(true);
    expect(detectSpeechLang(t)).toBe('ja');
    expect(detectEmotion(t)).toBe('happy');
    expect(extractSpeechText(t)).toBe('早上好');
  });

  it('只有情绪没有语言', () => {
    const t = '用生气的语气说一句你好';
    expect(wantsSpeech(t)).toBe(true);
    expect(detectSpeechLang(t)).toBeNull();
    expect(detectEmotion(t)).toBe('angry');
    expect(extractSpeechText(t)).toBe('你好');
  });
});
