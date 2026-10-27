/**
 * 唱歌触发词 + 歌名/音色提取 + 曲库匹配。
 *
 * 这些都是纯函数，不碰网络，适合单测。
 */

import { describe, expect, it } from 'vitest';
import {
  extractSingVoice,
  extractSongName,
  renderLibrary,
  wantsSing,
  type SongEntry,
} from '../src/core/singer.js';
import { parseLrc, formatHit } from '../src/core/music.js';

describe('唱歌触发词', () => {
  it('识别常见说法', () => {
    expect(wantsSing('唱《春日影》')).toBe(true);
    expect(wantsSing('唱一首春日影')).toBe(true);
    expect(wantsSing('唱一下春日影')).toBe(true);
    expect(wantsSing('来首歌')).toBe(true);
    expect(wantsSing('点歌 春日影')).toBe(true);
    expect(wantsSing('用soyo唱春日影')).toBe(true);
    expect(wantsSing('来一首春日影')).toBe(true);
  });

  it('普通聊天不触发', () => {
    expect(wantsSing('今天好累')).toBe(false);
    expect(wantsSing('这个视频说了什么')).toBe(false);
    expect(wantsSing('说一句你好')).toBe(false);
  });

  it('太短不触发', () => {
    expect(wantsSing('唱')).toBe(false);
  });
});

describe('歌名提取', () => {
  it('去掉书名号', () => {
    expect(extractSongName('唱《春日影》')).toBe('春日影');
    expect(extractSongName('唱「春日影」')).toBe('春日影');
  });

  it('去掉触发词', () => {
    expect(extractSongName('唱一首春日影')).toBe('春日影');
    expect(extractSongName('点歌 春日影')).toBe('春日影');
    expect(extractSongName('唱一下春日影')).toBe('春日影');
  });

  it('去掉音色指定', () => {
    expect(extractSongName('用soyo唱春日影')).toBe('春日影');
  });

  it('去掉 @ 标记', () => {
    expect(extractSongName('[艾特你] 唱一首春日影')).toBe('春日影');
  });
});

describe('音色提取', () => {
  it('识别「用xxx唱」', () => {
    expect(extractSingVoice('用soyo唱春日影')).toBe('soyo');
    expect(extractSingVoice('用Anon唱春日影')).toBe('anon');
    expect(extractSingVoice('用 tomori 的音色唱')).toBe('tomori');
  });

  it('没指定时返回 undefined', () => {
    expect(extractSingVoice('唱一首春日影')).toBeUndefined();
    expect(extractSingVoice('来首歌')).toBeUndefined();
  });
});

describe('LRC 解析', () => {
  it('解析基本行', () => {
    const r = parseLrc('[00:15.045]悴んだ心\n[00:19.371]世界で');
    expect(r.length).toBe(2);
    expect(r[0]?.time).toBeCloseTo(15.045, 2);
    expect(r[0]?.text).toBe('悴んだ心');
    expect(r[1]?.time).toBeCloseTo(19.371, 2);
  });

  it('一行多个时间标签会展开', () => {
    const r = parseLrc('[01:03.421][01:30.500]重复行');
    expect(r.length).toBe(2);
    expect(r[0]?.time).toBeCloseTo(63.421, 2);
    expect(r[1]?.time).toBeCloseTo(90.5, 2);
    expect(r[0]?.text).toBe('重复行');
  });

  it('忽略元信息行', () => {
    const r = parseLrc('[ar:歌手]\n[ti:标题]\n[00:01.000]正文');
    expect(r.length).toBe(1);
    expect(r[0]?.text).toBe('正文');
  });

  it('结果按时间排序', () => {
    const r = parseLrc('[00:30.000]后\n[00:10.000]前');
    expect(r[0]?.text).toBe('前');
    expect(r[1]?.text).toBe('后');
  });

  it('空歌词返回空数组', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc('没有时间标签的文本')).toEqual([]);
  });
});

describe('歌曲标题格式化', () => {
  it('有歌手时拼接', () => {
    const hit = { id: '1', name: '春日影', artists: ['CRYCHIC'], album: '', source: 'netease' as const };
    expect(formatHit(hit)).toBe('春日影 — CRYCHIC');
  });

  it('无歌手时只有歌名', () => {
    const hit = { id: '1', name: '春日影', artists: [], album: '', source: 'netease' as const };
    expect(formatHit(hit)).toBe('春日影');
  });
});

describe('曲库渲染', () => {
  const songs: SongEntry[] = [
    { id: '春日影', title: '春日影', file: '/a.mp3', voice: 'soyo' },
    { id: '诗超绊', title: '诗超绊', file: '/b.mp3', voice: 'tomori' },
  ];

  it('列出歌名', () => {
    const s = renderLibrary(songs);
    expect(s).toContain('春日影');
    expect(s).toContain('诗超绊');
  });

  it('空曲库给提示', () => {
    expect(renderLibrary([])).toContain('还没有');
  });
});
