/**
 * 工作流构建：放大链路。
 *
 * 只测节点拼装（纯函数），不真的调 ComfyUI。
 */

import { describe, expect, it } from 'vitest';
import { ComfyClient } from '../src/core/comfy.js';
import { createLogger } from '../src/core/logger.js';

/** 用私有方法构建工作流（测试用）。 */
function build(options: Record<string, unknown>): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const client = new ComfyClient({ logger: createLogger('t') });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any).buildWorkflow({
    prompt: 'masterpiece, 1girl',
    width: 512,
    height: 512,
    ...options,
  });
}

describe('基础工作流', () => {
  it('不含放大时只有 7 个节点', () => {
    const wf = build({});
    expect(Object.keys(wf).sort()).toEqual(['3', '4', '5', '6', '7', '8', '9']);
    expect(wf['9']?.class_type).toBe('SaveImage');
    // 保存的是 VAEDecode 的直接输出
    expect(wf['9']?.inputs['images']).toEqual(['8', 0]);
  });

  it('v-pred 会插入 ModelSamplingDiscrete', () => {
    const wf = build({ vPred: true });
    expect(wf['10']?.class_type).toBe('ModelSamplingDiscrete');
    expect(wf['10']?.inputs['sampling']).toBe('v_prediction');
    // KSampler 的 model 指向节点 10
    expect(wf['3']?.inputs['model']).toEqual(['10', 0]);
  });

  it('非 v-pred 时 KSampler 直接吃 checkpoint', () => {
    const wf = build({});
    expect(wf['3']?.inputs['model']).toEqual(['4', 0]);
  });
});

describe('放大链路', () => {
  it('加放大时插入 UpscaleModelLoader 和 ImageUpscaleWithModel', () => {
    const wf = build({ upscaleModel: '4x-UltraSharp.pth' });
    expect(wf['11']?.class_type).toBe('UpscaleModelLoader');
    expect(wf['11']?.inputs['model_name']).toBe('4x-UltraSharp.pth');
    expect(wf['12']?.class_type).toBe('ImageUpscaleWithModel');
    // 输入来自 VAEDecode
    expect(wf['12']?.inputs['image']).toEqual(['8', 0]);
    // 保存的是放大后的
    expect(wf['9']?.inputs['images']).toEqual(['12', 0]);
  });

  it('指定 upscaleTo 时加 ImageScale 缩回目标尺寸', () => {
    const wf = build({ upscaleModel: '4x-UltraSharp.pth', upscaleTo: 2048 });
    expect(wf['13']?.class_type).toBe('ImageScale');
    expect(wf['13']?.inputs['width']).toBe(2048);
    expect(wf['13']?.inputs['height']).toBe(2048);
    expect(wf['13']?.inputs['upscale_method']).toBe('lanczos');
    // 保存的是缩放后的
    expect(wf['9']?.inputs['images']).toEqual(['13', 0]);
  });

  it('不指定 upscaleTo 时保存放大原图（4x）', () => {
    const wf = build({ upscaleModel: '4x-UltraSharp.pth' });
    expect(wf['13']).toBeUndefined();
    expect(wf['9']?.inputs['images']).toEqual(['12', 0]);
  });

  it('放大与 v-pred 可以共存', () => {
    const wf = build({ vPred: true, upscaleModel: 'RealESRGAN_x4plus_anime_6B.pth', upscaleTo: 2048 });
    expect(wf['10']?.class_type).toBe('ModelSamplingDiscrete');
    expect(wf['11']?.class_type).toBe('UpscaleModelLoader');
    expect(wf['12']?.class_type).toBe('ImageUpscaleWithModel');
    expect(wf['13']?.class_type).toBe('ImageScale');
    expect(wf['3']?.inputs['model']).toEqual(['10', 0]);
  });

  it('空字符串的 upscaleModel 视为不放大', () => {
    const wf = build({ upscaleModel: '' });
    expect(wf['11']).toBeUndefined();
    expect(wf['9']?.inputs['images']).toEqual(['8', 0]);
  });
});
