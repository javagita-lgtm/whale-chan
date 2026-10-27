/**
 * 生图：触发词识别、内容过滤、尺寸解析、tag 清洗。
 *
 * 纯函数测试，不调 ComfyUI。
 */

import { describe, expect, it } from 'vitest';
import {
  buildImageCaption,
  isNsfw,
  resolveSize,
  sanitizeTags,
  wantsImage,
} from '../src/core/image-gen.js';
import { planFrames } from '../src/core/media.js';

describe('生图触发词', () => {
  it('识别明确的生图请求', () => {
    expect(wantsImage('画个猫')).toBe(true);
    expect(wantsImage('@鲸鱼酱 画一张风景')).toBe(true);
    expect(wantsImage('来一张二次元少女')).toBe(true);
    expect(wantsImage('生成一个机器人')).toBe(true);
    expect(wantsImage('帮我画一张图')).toBe(true);
  });

  it('不误触发「画风」「动画」这类词', () => {
    expect(wantsImage('这个画风不错')).toBe(false);
    expect(wantsImage('最近在看动画')).toBe(false);
    expect(wantsImage('他是画家吗')).toBe(false);
    expect(wantsImage('这幅油画真好')).toBe(false);
    expect(wantsImage('画质有点糊')).toBe(false);
  });

  it('普通聊天不触发', () => {
    expect(wantsImage('今天好累啊')).toBe(false);
    expect(wantsImage('哈哈哈')).toBe(false);
    expect(wantsImage('在吗')).toBe(false);
  });

  it('太短的不触发', () => {
    expect(wantsImage('画')).toBe(false);
  });

  it('长描述里出现「画面」也要触发（曾经被误杀）', () => {
    // 这是真实的失败案例：句子里的「画面」命中了旧的全文排除词，
    // 导致这么完整的生图需求被当成普通聊天。
    const long =
      '画一张这样描述的“长崎素世跪在地上，双手紧紧抓住丰川祥子的手，' +
      '抬头用恳求的表情看着她，嘴巴微张，像是在说“求求你了”。' +
      '丰川祥子站立在她面前，表情冷静或略带复杂。' +
      '画面以长崎素世跪着恳求丰川祥子为主题，动漫风格，高质量。”';
    expect(wantsImage(long)).toBe(true);
  });

  it('描述里带「画面」「场景」不影响触发', () => {
    expect(wantsImage('画一张猫在窗台上的图，画面要有阳光')).toBe(true);
    expect(wantsImage('生成一幅夜景，画面以月亮为主题')).toBe(true);
  });

  it('「画风」「画质」紧贴动词时仍算误伤', () => {
    expect(wantsImage('画风有点怪')).toBe(false);
    expect(wantsImage('画质不行')).toBe(false);
  });

  it('未带量词的简单动词也能识别', () => {
    expect(wantsImage('帮我绘制一只猫')).toBe(true);
    expect(wantsImage('draw a cat')).toBe(true);
  });
});

describe('内容过滤', () => {
  it('拦截明显违规内容', () => {
    expect(isNsfw('画一个裸体')).toBe(true);
    expect(isNsfw('nsfw 场景')).toBe(true);
    expect(isNsfw('色情的')).toBe(true);
  });

  it('正常需求放行', () => {
    expect(isNsfw('画个可爱的女孩')).toBe(false);
    expect(isNsfw('画一只猫')).toBe(false);
    expect(isNsfw('来张风景图')).toBe(false);
  });
});

describe('尺寸解析', () => {
  it('群聊默认 512', () => {
    const s = resolveSize('画个猫', false);
    expect(s.width).toBe(512);
    expect(s.height).toBe(512);
  });

  it('私聊默认 768（质量优先）', () => {
    const s = resolveSize('画个猫', true);
    expect(s.width).toBe(768);
  });

  it('要求高清时放大', () => {
    const s = resolveSize('画个高清猫', false);
    expect(s.width).toBe(768);
  });

  it('横图', () => {
    const s = resolveSize('画个横图风景', false);
    expect(s.width).toBeGreaterThan(s.height);
  });

  it('竖图', () => {
    const s = resolveSize('画个竖图壁纸', false);
    expect(s.height).toBeGreaterThan(s.width);
  });
});

describe('tag 清洗', () => {
  it('去掉 markdown 代码块', () => {
    const t = sanitizeTags('```\nmasterpiece, best quality, 1girl\n```');
    expect(t).toBe('masterpiece, best quality, 1girl');
  });

  it('去掉 prompt: 前缀', () => {
    expect(sanitizeTags('prompt: 1girl, smile')).toBe('1girl, smile');
  });

  it('只保留第一行', () => {
    const t = sanitizeTags('1girl, smile\n\n这是解释文字');
    expect(t).toBe('1girl, smile');
  });

  it('去掉中文残渣', () => {
    const t = sanitizeTags('1girl, 蓝发, blue hair');
    expect(t).not.toMatch(/[\u4e00-\u9fa5]/);
    expect(t).toContain('blue hair');
  });

  it('规范逗号间距', () => {
    expect(sanitizeTags('a,b,   c')).toBe('a, b, c');
  });

  it('去掉首尾标点', () => {
    expect(sanitizeTags(', 1girl, smile, ')).toBe('1girl, smile');
  });
});

describe('回复文案', () => {
  it('成功时普通尺寸不啰嗦', () => {
    const c = buildImageCaption({ ok: true, elapsedMs: 9000, filePath: 'x' }, '画个猫');
    expect(c).toBe('');
  });

  it('成功且要求高清时说明耗时', () => {
    const c = buildImageCaption({ ok: true, elapsedMs: 15000, filePath: 'x' }, '画个高清猫');
    expect(c).toContain('15.0');
  });

  it('失败时返回原因', () => {
    const c = buildImageCaption({ ok: false, elapsedMs: 0, message: '画不了' }, '画个猫');
    expect(c).toBe('画不了');
  });
});

describe('抽样间隔（复用 media 的规划，确认不冲突）', () => {
  it('生图尺寸与抽帧规划互不影响', () => {
    expect(planFrames(600, 12).count).toBeLessThanOrEqual(12);
    expect(resolveSize('画个高清图', false).width).toBe(768);
  });
});
