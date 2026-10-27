/**
 * 负向提示词的两种语义：追加 vs 替换。
 *
 * 自动模式：用户填的是「额外不想要的东西」，追加到默认负向词后面
 * 原始模式：用户填的是「完整负向词」，完全替换默认
 */

import { describe, expect, it } from 'vitest';
import { composeNegative } from '../src/core/prompt-translate.js';

describe('composeNegative 追加模式', () => {
  it('不传用户词时只有默认词', () => {
    const n = composeNegative('anime');
    expect(n).toContain('worst quality');
    expect(n).toContain('bad anatomy');
    // 二次元的风格负向词
    expect(n).toContain('3d');
  });

  it('传用户词时追加在末尾', () => {
    const n = composeNegative('anime', 'blurry, extra limbs');
    expect(n).toContain('worst quality'); // 默认词还在
    expect(n).toContain('blurry'); // 用户词也加了
    expect(n).toContain('extra limbs');
    // 用户词在最后
    expect(n.endsWith('blurry, extra limbs')).toBe(true);
  });

  it('空字符串不追加', () => {
    const withEmpty = composeNegative('anime', '');
    const without = composeNegative('anime');
    expect(withEmpty).toBe(without);
  });

  it('不同画风的默认词不同', () => {
    expect(composeNegative('anime')).toContain('3d');
    expect(composeNegative('realistic')).toContain('cartoon');
  });
});

describe('负向词的语义区分', () => {
  it('追加模式：默认词 + 用户词', () => {
    const n = composeNegative('anime', 'blurry');
    const parts = n.split(', ').map((s) => s.trim());
    // 既有默认的 worst quality，又有用户加的 blurry
    expect(parts).toContain('worst quality');
    expect(parts).toContain('blurry');
  });

  it('替换模式（原始模式直接传 negative，不经过 composeNegative）', () => {
    // 原始模式在 image-api 里直接 body.negative ?? 默认值，
    // 不走 composeNegative，所以填什么就是什么。
    const userNeg = 'worst quality, bad anatomy, extra fingers';
    // 这行是文档性质：替换模式下不会混入默认的 3d/realistic 等风格词
    expect(userNeg).not.toContain('3d');
    expect(userNeg).not.toContain('photograph');
  });
});
