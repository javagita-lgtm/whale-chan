/**
 * 小红书笔记 URL 识别与解析规则。
 *
 * 背景（2026-10-26 实测）：
 *   分享链接带 xsec_token 时**第一次**能拿到完整笔记页（含 masterUrl 视频直链），
 *   之后连续请求会被跳转到 /login 或 /404。
 *   所以「能不能抓」取决于 token 状态，必须如实告诉用户而不是猜内容。
 */

import { describe, expect, it } from 'vitest';
import { isXhsNoteUrl, parseXhsNoteId } from '../src/core/xiaohongshu.js';

describe('小红书笔记 URL 识别', () => {
  it('识别 discovery/item 格式', () => {
    expect(
      isXhsNoteUrl('https://www.xiaohongshu.com/discovery/item/6adc281f000000002c0165f9'),
    ).toBe(true);
  });

  it('识别 explore 格式', () => {
    expect(isXhsNoteUrl('https://www.xiaohongshu.com/explore/6adc281f000000002c0165f9')).toBe(true);
  });

  it('带 query 参数也能识别', () => {
    expect(
      isXhsNoteUrl(
        'https://www.xiaohongshu.com/discovery/item/6adc281f000000002c0165f9?xsec_token=ABC&type=video',
      ),
    ).toBe(true);
  });

  it('别的站点不误判', () => {
    expect(isXhsNoteUrl('https://www.bilibili.com/video/BV1cj8c6jE7f')).toBe(false);
    expect(isXhsNoteUrl('https://www.zhihu.com/question/123')).toBe(false);
    expect(isXhsNoteUrl('https://example.com/discovery/item/abc')).toBe(false);
  });

  it('小红书非笔记页不误判', () => {
    expect(isXhsNoteUrl('https://www.xiaohongshu.com/user/profile/abc')).toBe(false);
    expect(isXhsNoteUrl('https://www.xiaohongshu.com/explore')).toBe(false);
  });

  it('非法 URL 返回 false 而不抛错', () => {
    expect(isXhsNoteUrl('not-a-url')).toBe(false);
    expect(isXhsNoteUrl('')).toBe(false);
  });
});

describe('笔记 ID 提取', () => {
  it('从 discovery/item 提取', () => {
    expect(
      parseXhsNoteId('https://www.xiaohongshu.com/discovery/item/6adc281f000000002c0165f9'),
    ).toBe('6adc281f000000002c0165f9');
  });

  it('从 explore 提取', () => {
    expect(parseXhsNoteId('https://www.xiaohongshu.com/explore/6adc281f000000002c0165f9')).toBe(
      '6adc281f000000002c0165f9',
    );
  });

  it('带参数也能提取', () => {
    expect(
      parseXhsNoteId(
        'https://www.xiaohongshu.com/discovery/item/6adc281f000000002c0165f9?xsec_token=X',
      ),
    ).toBe('6adc281f000000002c0165f9');
  });

  it('非笔记页返回 null', () => {
    expect(parseXhsNoteId('https://www.xiaohongshu.com/explore')).toBeNull();
    expect(parseXhsNoteId('not-a-url')).toBeNull();
  });

  it('ID 太短不认（避免误匹配）', () => {
    expect(parseXhsNoteId('https://www.xiaohongshu.com/explore/abc')).toBeNull();
  });
});
