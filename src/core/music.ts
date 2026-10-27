/**
 * 音乐 API 客户端（music-api.gdstudio.xyz）。
 *
 * 用途：给唱歌功能提供「曲库」能力——搜歌、拿音频、拿歌词。
 *
 * 接口（全部实测可用，2026-10-27）：
 *   types=search   name=关键词  → 歌曲列表（id / name / artist / album）
 *   types=url      id=歌曲id    → 播放地址（mp3，最高 320kbps）
 *   types=lyric    id=歌曲id    → 歌词（LRC 格式，带时间轴）
 *   types=pic      id=封面id    → 封面图
 *   types=playlist id=歌单id    → 歌单详情
 *
 * 注意：
 *   - 下载得到的 url 是网易 CDN 直链，实测 13 MB/s
 *   - 歌词是 LRC 格式（[mm:ss.xxx] 行），对 SVS/MIDI 对齐有用
 *   - 这是第三方聚合接口，可用性不保证，需要超时和降级
 */

import type { Logger } from './logger.js';

const BASE = 'https://music-api.gdstudio.xyz/api.php';

/** 支持的音源。 */
export type MusicSource = 'netease' | 'tencent' | 'kugou' | 'baidu' | 'kuwo' | 'migu';

export interface MusicHit {
  id: string;
  name: string;
  artists: string[];
  album: string;
  /** 封面 id（用于 types=pic） */
  picId?: string;
  source: MusicSource;
}

export interface MusicUrlResult {
  url: string;
  /** 码率 kbps */
  br: number;
  /** 字节数 */
  size: number;
}

export interface LyricLine {
  /** 起始时间（秒） */
  time: number;
  text: string;
}

export interface MusicClientOptions {
  logger: Logger;
  timeoutMs?: number;
}

export class MusicClient {
  constructor(private readonly options: MusicClientOptions) {}

  private get timeout(): number {
    return this.options.timeoutMs ?? 20_000;
  }

  /** 搜歌。 */
  async search(keyword: string, opts?: { source?: MusicSource; count?: number }): Promise<MusicHit[]> {
    const source = opts?.source ?? 'netease';
    const count = opts?.count ?? 5;
    const raw = await this.request({
      types: 'search',
      source,
      name: keyword,
      count: String(count),
      pages: '1',
    });
    if (!Array.isArray(raw)) return [];

    return (raw as Array<Record<string, unknown>>).map((r) => ({
      id: String(r['id'] ?? ''),
      name: String(r['name'] ?? ''),
      artists: Array.isArray(r['artist']) ? (r['artist'] as string[]) : [],
      album: String(r['album'] ?? ''),
      picId: r['pic_id'] ? String(r['pic_id']) : undefined,
      source: String(r['source'] ?? source) as MusicSource,
    }));
  }

  /** 取播放地址。 */
  async getUrl(id: string, opts?: { source?: MusicSource; br?: number }): Promise<MusicUrlResult | null> {
    const raw = await this.request({
      types: 'url',
      source: opts?.source ?? 'netease',
      id,
      br: String(opts?.br ?? 320),
    });
    if (!raw || typeof raw !== 'object') return null;
    const j = raw as Record<string, unknown>;
    const url = typeof j['url'] === 'string' ? j['url'] : '';
    if (url.length === 0) return null;

    return {
      url,
      br: Number(j['br'] ?? 0),
      size: Number(j['size'] ?? 0),
    };
  }

  /** 取歌词（解析成带时间轴的行）。 */
  async getLyric(id: string, opts?: { source?: MusicSource }): Promise<LyricLine[]> {
    const raw = await this.request({
      types: 'lyric',
      source: opts?.source ?? 'netease',
      id,
    });
    if (!raw || typeof raw !== 'object') return [];
    const lrc = (raw as Record<string, unknown>)['lyric'];
    if (typeof lrc !== 'string') return [];
    return parseLrc(lrc);
  }

  /** 取封面地址。 */
  async getCover(picId: string, size = 300): Promise<string | null> {
    const raw = await this.request({ types: 'pic', source: 'netease', id: picId, size: String(size) });
    if (!raw || typeof raw !== 'object') return null;
    const u = (raw as Record<string, unknown>)['url'];
    return typeof u === 'string' ? u : null;
  }

  /** 下载音频到本地。 */
  async download(url: string, destPath: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(180_000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) {
        this.options.logger.info('音乐下载失败', { status: res.status });
        return false;
      }
      const { writeFileSync } = await import('node:fs');
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(destPath, buf);
      this.options.logger.info('音乐下载完成', {
        mb: Math.round((buf.length / 1024 / 1024) * 10) / 10,
        path: destPath,
      });
      return true;
    } catch (error) {
      this.options.logger.info('音乐下载异常', { message: (error as Error).message.slice(0, 120) });
      return false;
    }
  }

  /** 底层请求。 */
  private async request(params: Record<string, string>): Promise<unknown> {
    const q = new URLSearchParams(params);
    const url = `${BASE}?${q.toString()}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeout),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) {
        this.options.logger.info('音乐接口异常', { status: res.status, types: params['types'] });
        return null;
      }
      const text = await res.text();
      if (text.trim().length === 0) return null;
      return JSON.parse(text) as unknown;
    } catch (error) {
      this.options.logger.info('音乐接口请求失败', {
        types: params['types'],
        message: (error as Error).message.slice(0, 120),
      });
      return null;
    }
  }
}

/**
 * 解析 LRC 歌词。
 *
 * 格式：[00:15.045]悴んだ心 ふるえる眼差し
 * 一行可能带多个时间标签，要全部展开。
 */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  const lineRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  for (const line of lrc.split(/\r?\n/)) {
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    lineRe.lastIndex = 0;
    while ((m = lineRe.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0;
      stamps.push(min * 60 + sec + frac);
    }
    if (stamps.length === 0) continue;

    const text = line.replace(lineRe, '').trim();
    if (text.length === 0) continue;

    for (const t of stamps) {
      out.push({ time: t, text });
    }
  }

  return out.sort((a, b) => a.time - b.time);
}

/** 把歌曲名+歌手拼成可读标题。 */
export function formatHit(hit: MusicHit): string {
  const artist = hit.artists.join(' / ');
  return artist.length > 0 ? `${hit.name} — ${artist}` : hit.name;
}
