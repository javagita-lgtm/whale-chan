/**
 * B 站媒体处理：抽帧规划、流选择、渲染。
 *
 * 纯函数测试，不实际下载/转写。
 */

import { describe, expect, it } from 'vitest';
import { BiliMedia, pickStreams, planFrames, renderFramesNote, renderTranscript } from '../src/core/media.js';
import { createLogger } from '../src/core/logger.js';

const logger = createLogger('media-test');

describe('抽帧规划', () => {
  it('短视频抽密一些', () => {
    const p = planFrames(30, 12);
    expect(p.interval).toBe(6);
    expect(p.count).toBeLessThanOrEqual(12);
  });

  it('3 分钟视频：帧数受限后间隔放大到 15 秒', () => {
    const p = planFrames(180, 12);
    // 180/12 = 15 秒一帧，正好 12 帧
    expect(p.interval).toBe(15);
    expect(p.count).toBe(12);
  });

  it('10 分钟视频：间隔放大到 50 秒', () => {
    const p = planFrames(600, 12);
    expect(p.interval).toBe(50);
    expect(p.count).toBe(12);
  });

  it('30 分钟视频不超过帧数上限', () => {
    const p = planFrames(1800, 12);
    expect(p.count).toBeLessThanOrEqual(12);
    expect(p.interval).toBeGreaterThanOrEqual(60);
  });

  it('2 小时视频也不会爆', () => {
    const p = planFrames(7200, 12);
    expect(p.count).toBeLessThanOrEqual(12);
  });

  it('帧数上限可调', () => {
    expect(planFrames(600, 6).count).toBeLessThanOrEqual(6);
    expect(planFrames(600, 30).count).toBeLessThanOrEqual(30);
  });

  it('零时长不出错', () => {
    const p = planFrames(0, 12);
    expect(p.count).toBeGreaterThan(0);
    expect(Number.isFinite(p.interval)).toBe(true);
  });
});

describe('流选择', () => {
  it('音频选最低码率（省流量，ASR 够用）', () => {
    const r = pickStreams({
      data: {
        dash: {
          audio: [
            { baseUrl: 'a-high', bandwidth: 200_000 },
            { baseUrl: 'a-low', bandwidth: 44_000 },
            { baseUrl: 'a-mid', bandwidth: 100_000 },
          ],
        },
      },
    });
    expect(r.audio?.url).toBe('a-low');
  });

  it('视频优先 H.264', () => {
    const r = pickStreams({
      data: {
        dash: {
          video: [
            { baseUrl: 'v-hevc', bandwidth: 1000, codecs: 'hvc1.1.6.L120', width: 852, height: 480 },
            { baseUrl: 'v-avc', bandwidth: 2000, codecs: 'avc1.640033', width: 852, height: 480 },
          ],
        },
      },
    });
    expect(r.video?.url).toBe('v-avc');
  });

  it('同类编码优先接近 480p', () => {
    const r = pickStreams({
      data: {
        dash: {
          video: [
            { baseUrl: 'v-1080', bandwidth: 5000, codecs: 'avc1', width: 1920, height: 1080 },
            { baseUrl: 'v-480', bandwidth: 800, codecs: 'avc1', width: 852, height: 480 },
            { baseUrl: 'v-360', bandwidth: 400, codecs: 'avc1', width: 640, height: 360 },
          ],
        },
      },
    });
    expect(r.video?.url).toBe('v-480');
  });

  it('没有 dash 时返回空', () => {
    const r = pickStreams({ data: {} });
    expect(r.audio).toBeNull();
    expect(r.video).toBeNull();
  });

  it('兼容 base_url 下划线写法', () => {
    const r = pickStreams({
      data: { dash: { audio: [{ base_url: 'snake', bandwidth: 1000 }] } },
    });
    expect(r.audio?.url).toBe('snake');
  });
});

describe('渲染', () => {
  it('抽帧说明包含帧数与时长', () => {
    const note = renderFramesNote(
      [
        { time: 0, dataUrl: 'data:x', bytes: 100 },
        { time: 15, dataUrl: 'data:y', bytes: 100 },
      ],
      120,
    );
    expect(note).toContain('2 张');
    expect(note).toContain('120 秒');
    expect(note).toContain('看不清');
  });

  it('空帧返回空字符串', () => {
    expect(renderFramesNote([], 100)).toBe('');
  });

  it('台词块包含内容与可信度说明', () => {
    const text = renderTranscript({
      lines: ['[00:01 - 00:05] 这是第一句', '[00:05 - 00:09] 这是第二句'],
      text: '这是第一句 这是第二句',
      duration: 600,
      elapsedSec: 30,
      model: 'small',
    });
    expect(text).toContain('10 分钟');
    expect(text).toContain('这是第一句');
    expect(text).toContain('可信度高于弹幕');
  });
});

describe('可用性探测', () => {
  it('ffmpeg 填纯命令名时不预判为不可用', () => {
    const m = new BiliMedia({
      logger,
      ffmpegPath: 'ffmpeg',
      pythonPath: 'D:\\nope\\python.exe',
      transcribeScript: 'D:\\nope\\t.py',
      asrModel: 'small',
      timeoutMs: 1000,
    });
    expect(m.ffmpegAvailable).toBe(true);
    expect(m.asrAvailable).toBe(false);
  });

  it('绝对路径不存在时判定不可用', () => {
    const m = new BiliMedia({
      logger,
      ffmpegPath: 'D:\\definitely\\not\\exist\\ffmpeg.exe',
      pythonPath: 'D:\\nope\\python.exe',
      transcribeScript: 'D:\\nope\\t.py',
      asrModel: 'small',
      timeoutMs: 1000,
    });
    expect(m.ffmpegAvailable).toBe(false);
  });
});
