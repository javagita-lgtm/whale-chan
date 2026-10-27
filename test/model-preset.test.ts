/**
 * 模型选择与预设参数。
 *
 * 重点验证：SD1.5 与 SDXL v-pred 的参数不能混用。
 */

import { describe, expect, it } from 'vitest';
import { MODEL_PRESETS, pickPreset, resolveSizeForPreset } from '../src/core/image-gen.js';

describe('模型预设', () => {
  it('SD1.5 用 karras', () => {
    expect(MODEL_PRESETS.sd15.scheduler).toBe('karras');
    expect(MODEL_PRESETS.sd15.vPred).toBe(false);
  });

  it('SDXL v-pred 标记正确', () => {
    expect(MODEL_PRESETS.sdxl_anime.vPred).toBe(true);
    expect(MODEL_PRESETS.sdxl_anime.checkpoint).toContain('NoobAI');
  });

  it('SDXL 用 euler+normal（karras 会出纯色块）', () => {
    expect(MODEL_PRESETS.sdxl_anime.sampler).toBe('euler');
    expect(MODEL_PRESETS.sdxl_anime.scheduler).toBe('normal');
  });

  it('SDXL 的 CFG 低于 SD1.5（v-pred 特性）', () => {
    expect(MODEL_PRESETS.sdxl_anime.cfg).toBeLessThan(MODEL_PRESETS.sd15.cfg);
  });
});

describe('模型选择', () => {
  it('默认走 SDXL（人设是二次元，写实底模出图不对）', () => {
    expect(pickPreset('画个猫', false).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
    expect(pickPreset('画个风景', false).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
  });

  it('回归：含「二次元的XX」但没有括号写法也要走 SDXL', () => {
    // 真实失败案例：这句被判成日常需求走了 SD1.5，出来是写实脸
    const t = '[回复][艾特你] 重画，画一张二次元的saber穿着OL装的下班打卡图';
    expect(pickPreset(t, false).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
  });

  it('要求高清时用 SDXL', () => {
    expect(pickPreset('画个高清猫', false).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
    expect(pickPreset('画个大图', false).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
  });

  it('明确要求快速时降级到 SD1.5', () => {
    expect(pickPreset('快速画个草稿', false).checkpoint).toBe(MODEL_PRESETS.sd15.checkpoint);
    expect(pickPreset('随便画个东西', false).checkpoint).toBe(MODEL_PRESETS.sd15.checkpoint);
    expect(pickPreset('先预览一下', false).checkpoint).toBe(MODEL_PRESETS.sd15.checkpoint);
  });

  it('私聊提角色用 SDXL', () => {
    expect(pickPreset('生成一张saber的图', true).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
  });

  it('私聊默认也是 SDXL', () => {
    expect(pickPreset('画个猫', true).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
  });

  it('带作品括号的角色名走 SDXL', () => {
    expect(pickPreset('saber (fate)', false).checkpoint).toBe(MODEL_PRESETS.sdxl_anime.checkpoint);
  });
});

describe('尺寸按模型基准', () => {
  it('SD1.5 基准 512', () => {
    expect(resolveSizeForPreset('画个猫', 512).width).toBe(512);
  });

  it('SDXL 基准 832', () => {
    expect(resolveSizeForPreset('画个猫', 832).width).toBe(832);
  });

  it('SDXL 不会因为「高清」继续放大', () => {
    expect(resolveSizeForPreset('画个高清猫', 832).width).toBe(832);
  });

  it('SD1.5 遇高清升到 768', () => {
    expect(resolveSizeForPreset('画个高清猫', 512).width).toBe(768);
  });

  it('尺寸按 8 对齐（SD 要求）', () => {
    const s = resolveSizeForPreset('画个竖图', 832);
    expect(s.height % 8).toBe(0);
    expect(s.width % 8).toBe(0);
  });

  it('竖图高度大于宽度', () => {
    const s = resolveSizeForPreset('画个竖图壁纸', 832);
    expect(s.height).toBeGreaterThan(s.width);
  });
});
