/**
 * B 站视频理解：URL 解析、弹幕筛选、上下文渲染。
 *
 * 纯函数测试，不联网。
 */

import { describe, expect, it } from 'vitest';
import {
  BilibiliClient,
  formatTime,
  isBilibiliVideoUrl,
  parseBiliUrl,
  renderBiliVideo,
  type BiliVideoInfo,
} from '../src/core/bilibili.js';
import { createLogger } from '../src/core/logger.js';

const logger = createLogger('bili-test');

describe('B 站链接识别', () => {
  it('识别标准 BV 链接', () => {
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7')).toBe(true);
    expect(isBilibiliVideoUrl('https://bilibili.com/video/BV1GJ411x7h7')).toBe(true);
  });

  it('识别带参数的链接', () => {
    expect(
      isBilibiliVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=1&t=30&spm_id_from=333'),
    ).toBe(true);
  });

  it('识别 av 号', () => {
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/av170001')).toBe(true);
  });

  it('识别 b23.tv 短链', () => {
    expect(isBilibiliVideoUrl('https://b23.tv/abc1234')).toBe(true);
    expect(isBilibiliVideoUrl('https://b23.tv/BV1GJ411x7h7')).toBe(true);
  });

  it('非视频页不算（番剧、专栏、空间）', () => {
    expect(isBilibiliVideoUrl('https://www.bilibili.com/bangumi/play/ep123')).toBe(false);
    expect(isBilibiliVideoUrl('https://www.bilibili.com/read/cv123')).toBe(false);
    expect(isBilibiliVideoUrl('https://space.bilibili.com/123')).toBe(false);
  });

  it('其他站点不算', () => {
    expect(isBilibiliVideoUrl('https://www.youtube.com/watch?v=x')).toBe(false);
    expect(isBilibiliVideoUrl('https://example.com/video/BV1GJ411x7h7')).toBe(false);
  });

  it('伪造域名不算（bilibili.com.evil.com）', () => {
    expect(isBilibiliVideoUrl('https://bilibili.com.evil.com/video/BV1GJ411x7h7')).toBe(false);
  });
});

describe('BV/av 解析', () => {
  it('解析 BV 号', () => {
    const t = parseBiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7');
    expect(t).toEqual({ kind: 'bvid', value: 'BV1GJ411x7h7', url: expect.any(String) });
  });

  it('解析 av 号', () => {
    const t = parseBiliUrl('https://www.bilibili.com/video/av170001');
    expect(t?.kind).toBe('aid');
    expect(t?.value).toBe('170001');
  });

  it('无视频号返回 null', () => {
    expect(parseBiliUrl('https://www.bilibili.com/')).toBeNull();
    expect(parseBiliUrl('不是链接')).toBeNull();
  });
});

describe('时间格式化', () => {
  it('秒转 mm:ss', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(75)).toBe('01:15');
    expect(formatTime(213)).toBe('03:33');
    expect(formatTime(3661)).toBe('61:01');
  });

  it('负数与小数不出错', () => {
    expect(formatTime(-5)).toBe('00:00');
    expect(formatTime(9.9)).toBe('00:09');
  });
});

describe('弹幕筛选', () => {
  const makeClient = () =>
    new BilibiliClient({ logger, maxDanmaku: 10, maxComments: 3 });

  // pickDanmaku 是私有的，通过 fetchVideo 不方便测，
  // 这里用任何手段拿到它：直接调私有方法（TS 允许在测试里 as any）
  const pick = (client: BilibiliClient, items: Array<{ time: number; text: string }>) =>
    (client as unknown as { pickDanmaku: (x: unknown) => unknown }).pickDanmaku(items) as Array<{
      time: number;
      text: string;
    }>;

  it('过滤纯数字和纯符号', () => {
    const client = makeClient();
    const out = pick(client, [
      { time: 1, text: '1' },
      { time: 2, text: '123' },
      { time: 3, text: '!!!' },
      { time: 4, text: '这个视频真不错' },
    ]);
    expect(out.map((d) => d.text)).toEqual(['这个视频真不错']);
  });

  it('过滤单字和常见情绪噪音', () => {
    const client = makeClient();
    const out = pick(client, [
      { time: 1, text: '草' },
      { time: 2, text: '哈哈哈哈' },
      { time: 3, text: '6666' },
      { time: 4, text: 'awsl' },
      { time: 5, text: '这段旋律太上头了' },
    ]);
    expect(out.map((d) => d.text)).toEqual(['这段旋律太上头了']);
  });

  it('重复弹幕只保留第一次', () => {
    const client = makeClient();
    const out = pick(client, [
      { time: 1, text: '好听' },
      { time: 2, text: '好听' },
      { time: 3, text: '好听' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.time).toBe(1);
  });

  it('超过上限时按时间分桶，保证覆盖全片', () => {
    const client = makeClient(); // maxDanmaku = 10
    const items = Array.from({ length: 100 }, (_, i) => ({
      time: i,
      text: `弹幕内容第${i}条测试文本`,
    }));
    const out = pick(client, items);
    expect(out.length).toBeLessThanOrEqual(10);
    // 采样应覆盖时间轴的两端，而不是只取开头
    expect(out[0]!.time).toBeLessThan(20);
    expect(out[out.length - 1]!.time).toBeGreaterThan(80);
  });

  it('数量在上限内时全部保留', () => {
    const client = makeClient();
    const items = Array.from({ length: 5 }, (_, i) => ({ time: i, text: `第${i}条弹幕` }));
    expect(pick(client, items)).toHaveLength(5);
  });
});

describe('提示词渲染', () => {
  const info: BiliVideoInfo = {
    meta: {
      bvid: 'BV1GJ411x7h7',
      aid: 80433022,
      cid: 137649199,
      title: '【官方 MV】Never Gonna Give You Up',
      owner: 'Rick Astley',
      duration: 213,
      view: 2_959_000,
      like: 1_285_000,
      desc: '经典老歌',
      tname: '音乐',
    },
    danmaku: [
      { time: 0.6, text: '我是一万个点赞，正在反复横跳' },
      { time: 35.4, text: 'I just wanna tell you how I am feeling' },
    ],
    comments: [{ user: '老咸鱼A', text: '坏消息：被骗了 好消息：真好听', like: 769167 }],
    danmakuTotal: 1200,
  };

  it('包含标题、UP主、时长', () => {
    const text = renderBiliVideo(info);
    expect(text).toContain('Never Gonna Give You Up');
    expect(text).toContain('Rick Astley');
    // 213 秒 = 3.55 分钟，四舍五入为 4
    expect(text).toContain('4 分钟');
  });

  it('包含弹幕总数与时间戳', () => {
    const text = renderBiliVideo(info);
    expect(text).toContain('1200');
    expect(text).toContain('[00:00]');
    expect(text).toContain('[00:35]');
    expect(text).toContain('反复横跳');
  });

  it('包含热门评论与点赞数', () => {
    const text = renderBiliVideo(info);
    expect(text).toContain('老咸鱼A');
    expect(text).toContain('真好听');
    expect(text).toContain('76.9 万');
  });

  it('明确声明「没看过画面」，防止模型假装看过', () => {
    const text = renderBiliVideo(info);
    expect(text).toContain('不是视频画面本身');
    expect(text).toContain('不要声称');
  });

  it('无弹幕时如实说明', () => {
    const text = renderBiliVideo({ ...info, danmaku: [], danmakuTotal: 0 });
    expect(text).toContain('没有弹幕');
  });

  it('播放量格式化：万/亿', () => {
    const t1 = renderBiliVideo({ ...info, meta: { ...info.meta, view: 2_959_000 } });
    expect(t1).toContain('295.9 万');
    const t2 = renderBiliVideo({ ...info, meta: { ...info.meta, view: 150_000_000 } });
    expect(t2).toContain('1.5 亿');
  });
});
