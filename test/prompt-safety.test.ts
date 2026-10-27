/**
 * 提示词翻译的健壮性：拒绝检测、tag 有效性、中文标点清洗。
 *
 * 背景：面板勾了「允许成人内容」后，中文需求仍要经过 LLM 翻译，
 * 而 DeepSeek 会对涉及未成年设定角色的露骨内容直接拒绝。
 * 旧代码把拒绝回复去中文后当 tag 用，最后给 ComfyUI 一个空提示词，
 * 用户看到的就是"生成了但没效果"。
 */

import { describe, expect, it } from 'vitest';
import {
  enoughTags,
  isExplicitRequest,
  looksLikeRefusal,
  sanitizeTags,
} from '../src/core/prompt-translate.js';

describe('拒绝检测', () => {
  it('识别中文拒绝', () => {
    expect(looksLikeRefusal('抱歉，我不能为未成年设定角色生成这类标签')).toBe(true);
    expect(looksLikeRefusal('无法协助生成涉及未成年角色的内容')).toBe(true);
  });

  it('识别「拒绝 + 附带安全替代 tag」的混合回复', () => {
    const mixed =
      '抱歉，无法协助生成涉及未成年角色的全裸内容。安全替代 tag：\n\n' +
      'masterpiece, best quality, 1girl, fully clothed';
    expect(looksLikeRefusal(mixed)).toBe(true);
  });

  it('识别英文拒绝', () => {
    expect(looksLikeRefusal("I'm sorry, I can't help with that.")).toBe(true);
  });

  it('正常 tag 不误判', () => {
    expect(looksLikeRefusal('masterpiece, best quality, 1girl, solo, saber (fate), armor')).toBe(false);
    expect(looksLikeRefusal('masterpiece, best quality, highres, 1girl')).toBe(false);
  });

  it('空字符串算失败', () => {
    expect(looksLikeRefusal('')).toBe(true);
  });

  it('纯标点算失败（这是拒绝回复去中文后的残留）', () => {
    expect(looksLikeRefusal('，。（），/， tag。')).toBe(true);
    expect(looksLikeRefusal('。。。，，，')).toBe(true);
  });
});

describe('tag 有效性', () => {
  it('正常 tag 串算有效', () => {
    expect(enoughTags('masterpiece, best quality, 1girl, solo, cat')).toBe(true);
  });

  it('少于 3 个算无效', () => {
    expect(enoughTags('masterpiece, cat')).toBe(false);
    expect(enoughTags('cat')).toBe(false);
  });

  it('只剩符号算无效', () => {
    expect(enoughTags(', , , ,')).toBe(false);
    expect(enoughTags('')).toBe(false);
  });

  it('单字符 tag 不算有效', () => {
    expect(enoughTags('a, b, c')).toBe(false);
  });
});

describe('中文标点清洗', () => {
  it('去掉全角标点', () => {
    const out = sanitizeTags('，。（）masterpiece, 1girl');
    expect(out).not.toMatch(/[，。（）]/);
    expect(out).toContain('masterpiece');
  });

  it('保留英文 tag 原样', () => {
    const src = 'masterpiece, best quality, 1girl, saber (fate)';
    expect(sanitizeTags(src)).toBe(src);
  });

  it('去掉中文但保留英文', () => {
    const out = sanitizeTags('一幅画 masterpiece, 1girl, 蓝发');
    expect(out).not.toMatch(/[\u4e00-\u9fa5]/);
    expect(out).toContain('masterpiece');
  });
});

describe('露骨请求识别', () => {
  it('识别中文露骨描述', () => {
    expect(isExplicitRequest('身体全裸并露出胸部')).toBe(true);
    expect(isExplicitRequest('半裸图')).toBe(true);
    expect(isExplicitRequest('性交场景')).toBe(true);
  });

  it('识别英文露骨 tag', () => {
    expect(isExplicitRequest('1girl, nude, topless')).toBe(true);
    expect(isExplicitRequest('nsfw, explicit')).toBe(true);
  });

  it('普通请求不误判', () => {
    expect(isExplicitRequest('画一只猫')).toBe(false);
    expect(isExplicitRequest('比基尼海边')).toBe(false);
    expect(isExplicitRequest('穿短裙的少女')).toBe(false);
  });
});
