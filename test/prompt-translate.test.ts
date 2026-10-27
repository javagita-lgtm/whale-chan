/**
 * 提示词翻译与画风增强。
 *
 * 重点验证：画风识别、风格词追加、负向词、tag 清洗。
 */

import { describe, expect, it } from 'vitest';
import {
  composeNegative,
  composePrompt,
  detectStyle,
  sanitizeTags,
} from '../src/core/prompt-translate.js';

describe('画风识别', () => {
  it('默认二次元（机器人人设是二次元）', () => {
    expect(detectStyle('画个猫')).toBe('anime');
    expect(detectStyle('画个可爱的女孩')).toBe('anime');
  });

  it('明确说二次元/动漫', () => {
    expect(detectStyle('画个二次元少女')).toBe('anime');
    expect(detectStyle('动漫风格的角色')).toBe('anime');
  });

  it('要求写实时切换', () => {
    expect(detectStyle('画个写实的猫')).toBe('realistic');
    expect(detectStyle('要真实的照片感')).toBe('realistic');
    expect(detectStyle('做个 3d 渲染')).toBe('realistic');
  });

  it('saber 这类角色默认二次元', () => {
    expect(detectStyle('生成一张saber的图')).toBe('anime');
    expect(detectStyle('接近原版风格的saber图')).toBe('anime');
  });
});

describe('风格词追加', () => {
  it('二次元只加最轻的倾向词（固定种子 A/B 实测：强干预会压掉阴影）', () => {
    const p = composePrompt('masterpiece, 1girl', 'anime');
    expect(p).toContain('anime coloring');
    // 这几个词会把画面压成平涂，实测导致脸发紫、衣服无阴影
    expect(p).not.toContain('flat color');
    expect(p).not.toContain('cel shading');
    expect(p).not.toContain('clean lineart');
  });

  it('必须带背景与光影词（砍掉会导致背景失控成满屏纯色）', () => {
    const p = composePrompt('masterpiece, 1girl', 'anime');
    expect(p).toContain('simple background');
    expect(p).toContain('soft lighting');
  });

  it('auto 画风也补背景光影（否则模型自由发挥）', () => {
    const p = composePrompt('masterpiece, 1girl', 'auto');
    expect(p).toContain('simple background');
    expect(p).toContain('soft lighting');
  });

  it('写实追加照片词', () => {
    const p = composePrompt('masterpiece, 1girl', 'realistic');
    expect(p).toContain('photorealistic');
  });

  it('不重复追加已有的词', () => {
    const p = composePrompt('masterpiece, anime coloring, 1girl', 'anime');
    const count = (p.match(/anime coloring/gi) ?? []).length;
    expect(count).toBe(1);
  });

  it('auto 画风仍补背景光影，确保构图可控', () => {
    const p = composePrompt('masterpiece, 1girl', 'auto');
    expect(p).toContain('simple background');
    expect(p).toContain('soft lighting');
  });
});

describe('负向提示词', () => {
  it('二次元要排除 3D 和平涂词', () => {
    const n = composeNegative('anime');
    expect(n).toContain('3d');
    expect(n).toContain('flat color');
    expect(n).toContain('washed out');
  });

  it('写实要排除动漫', () => {
    const n = composeNegative('realistic');
    expect(n).toContain('anime');
    expect(n).toContain('cartoon');
  });

  it('基础负向词始终存在', () => {
    for (const style of ['anime', 'realistic', 'auto'] as const) {
      expect(composeNegative(style)).toContain('worst quality');
      expect(composeNegative(style)).toContain('bad anatomy');
    }
  });

  it('可追加用户自定义负向词', () => {
    const n = composeNegative('anime', 'blurry');
    expect(n).toContain('blurry');
  });
});

describe('tag 清洗（回归）', () => {
  it('去 markdown 与中文', () => {
    expect(sanitizeTags('```\nmasterpiece, 1girl, 蓝发\n```')).toBe('masterpiece, 1girl');
  });

  it('规范逗号', () => {
    expect(sanitizeTags('a,b ,  c')).toBe('a, b, c');
  });
});
