/**
 * 唱歌三模式 + 结语逻辑的单测。
 *
 * 需求对应：
 *   「唱春日影」        → clip（片段）
 *   「唱完整的春日影」  → full（整首）
 *   「我想听春日影」    → original（原唱，不翻唱）
 */

import { describe, expect, it } from 'vitest';
import {
  detectSingMode,
  wantsMusic,
  wantsOriginal,
  wantsSing,
} from '../src/core/singer.js';

describe('三种模式', () => {
  it('默认是片段', () => {
    expect(detectSingMode('唱《春日影》')).toBe('clip');
    expect(detectSingMode('唱一首春日影')).toBe('clip');
    expect(detectSingMode('来首歌')).toBe('clip');
    expect(detectSingMode('用soyo唱春日影')).toBe('clip');
  });

  it('明确说完整才走 full', () => {
    expect(detectSingMode('唱完整的春日影')).toBe('full');
    expect(detectSingMode('唱整首春日影')).toBe('full');
    expect(detectSingMode('唱春日影全部')).toBe('full');
    expect(detectSingMode('我要听完整版春日影')).toBe('full');
    expect(detectSingMode('春日影整首来一遍')).toBe('full');
  });

  it('想听原唱走 original', () => {
    expect(detectSingMode('我想听春日影')).toBe('original');
    expect(detectSingMode('放一下春日影')).toBe('original');
    expect(detectSingMode('播放春日影')).toBe('original');
    expect(detectSingMode('来一段春日影原唱')).toBe('original');
    expect(detectSingMode('想听一下春日影')).toBe('original');
  });

  it('说了「唱」就不算听原唱', () => {
    expect(detectSingMode('唱春日影')).toBe('clip');
    expect(wantsOriginal('唱春日影')).toBe(false);
    expect(wantsOriginal('唱完整版春日影')).toBe(false);
  });
});

describe('触发判定', () => {
  it('唱的触发', () => {
    expect(wantsSing('唱一首春日影')).toBe(true);
    expect(wantsSing('我想听春日影')).toBe(false);
  });

  it('听的触发 wantsOriginal', () => {
    expect(wantsOriginal('我想听春日影')).toBe(true);
    expect(wantsOriginal('放一下春日影')).toBe(true);
  });

  it('wantsMusic 覆盖两者', () => {
    expect(wantsMusic('唱一首春日影')).toBe(true);
    expect(wantsMusic('我想听春日影')).toBe(true);
    expect(wantsMusic('今天天气不错')).toBe(false);
  });

  it('太短不触发', () => {
    expect(wantsMusic('听')).toBe(false);
    expect(wantsMusic('唱')).toBe(false);
  });
});
