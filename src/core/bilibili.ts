/**
 * B 站视频信息提取（匿名，无需登录）。
 *
 * 为什么不下载视频/音频：
 *   群里聊天讲究即时性，下音轨 + ASR 要等「视频时长 × 0.4」，
 *   30 分钟视频得等 12 分钟，群里早就冷场了。
 *
 * 为什么用弹幕：
 *   弹幕是观众对画面的实时反应，包含了台词、玩梗、名场面的时间点。
 *   实测一条 3 分钟 MV 有 1200 条弹幕，信息密度足够聊起来。
 *   而且完全匿名可取，零成本、零风险。
 *
 * 数据来源（全部公开接口，不需要 Cookie）：
 *   /x/web-interface/view   元数据（标题/UP/时长/播放/简介）
 *   /x/v1/dm/list.so        弹幕 XML
 *   /x/v2/reply             热门评论
 */

import type { Logger } from './logger.js';

const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
} as const;

/** 从 URL 里解析出视频标识。支持 BV 号、av 号、b23.tv 短链。 */
export interface BiliTarget {
  kind: 'bvid' | 'aid';
  value: string;
  /** 原始链接 */
  url: string;
}

/** 判断是否是 B 站视频链接（不含重定向解析）。 */
export function isBilibiliVideoUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'b23.tv' || host.endsWith('.b23.tv')) return true;
  if (!host.endsWith('bilibili.com')) return false;
  return /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.test(u.pathname);
}

/** 从 URL 直接解析 BV/av 号（不含短链）。 */
export function parseBiliUrl(url: string): BiliTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /\/video\/(BV[0-9A-Za-z]{10}|av(\d+))/i.exec(u.pathname);
  if (!m) return null;
  const raw = m[1] as string;
  if (/^BV/i.test(raw)) {
    return { kind: 'bvid', value: raw, url };
  }
  return { kind: 'aid', value: (m[2] as string), url };
}

/** 视频元数据。 */
export interface BiliMeta {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  owner: string;
  /** 时长（秒） */
  duration: number;
  /** 播放量 */
  view: number;
  /** 点赞 */
  like: number;
  /** 简介（已截断） */
  desc: string;
  /** 分区名 */
  tname: string;
}

/** 单条弹幕。 */
export interface DanmakuItem {
  /** 出现时间（秒） */
  time: number;
  text: string;
}

export interface BiliComment {
  user: string;
  text: string;
  like: number;
}

export interface BiliVideoInfo {
  meta: BiliMeta;
  danmaku: DanmakuItem[];
  comments: BiliComment[];
  /** 弹幕原始总数（筛选前） */
  danmakuTotal: number;
}
export interface BilibiliOptions {
  logger: Logger;
  timeoutMs?: number;
  /** 最多取多少条弹幕进提示词 */
  maxDanmaku?: number;
  /** 最多取多少条评论 */
  maxComments?: number;
}

export class BilibiliClient {
  private readonly timeoutMs: number;
  private readonly maxDanmaku: number;
  private readonly maxComments: number;

  constructor(private readonly options: BilibiliOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxDanmaku = options.maxDanmaku ?? 120;
    this.maxComments = options.maxComments ?? 8;
  }

  /**
   * 跟随 b23.tv 短链拿到真实地址。
   * 短链是 302 重定向，用 HEAD 跟随后读最终 URL。
   */
  async resolveShortUrl(url: string): Promise<string> {
    if (!/b23\.tv/i.test(url)) return url;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': BILI_HEADERS['User-Agent'] },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.url || url;
    } catch (error) {
      this.options.logger.info('b23 短链解析失败', {
        url,
        message: (error as Error).message.slice(0, 100),
      });
      return url;
    }
  }

  /**
   * 抓取视频信息（元数据 + 弹幕 + 评论）。
   * 元数据失败返回 null；弹幕/评论失败只记日志，不影响整体。
   */
  async fetchVideo(url: string): Promise<BiliVideoInfo | null> {
    const resolved = await this.resolveShortUrl(url);
    const target = parseBiliUrl(resolved);
    if (!target) {
      this.options.logger.info('无法从链接解析出视频号', { url });
      return null;
    }

    const meta = await this.fetchMeta(target);
    if (!meta) return null;

    const [danmaku, comments] = await Promise.all([
      this.fetchDanmaku(meta.cid),
      this.fetchComments(meta.aid),
    ]);

    return {
      meta,
      danmaku: this.pickDanmaku(danmaku),
      comments,
      danmakuTotal: danmaku.length,
    };
  }

  private async fetchMeta(target: BiliTarget): Promise<BiliMeta | null> {
    const q = target.kind === 'bvid' ? `bvid=${target.value}` : `aid=${target.value}`;
    try {
      const json = await this.getJson<{
        code: number;
        message: string;
        data?: {
          bvid?: string;
          aid?: number;
          cid?: number;
          title?: string;
          owner?: { name?: string };
          duration?: number;
          stat?: { view?: number; like?: number };
          desc?: string;
          tname?: string;
          pages?: Array<{ cid?: number }>;
        };
      }>(`https://api.bilibili.com/x/web-interface/view?${q}`);

      if (json.code !== 0 || !json.data) {
        this.options.logger.info('B站视频信息获取失败', {
          code: json.code,
          message: json.message,
          target: target.value,
        });
        return null;
      }

      const d = json.data;
      // 分P视频取第一 P 的 cid
      const cid = d.cid ?? d.pages?.[0]?.cid ?? 0;
      if (!cid) {
        this.options.logger.info('视频缺少 cid，无法取弹幕', { target: target.value });
        return null;
      }

      return {
        bvid: d.bvid ?? '',
        aid: d.aid ?? 0,
        cid,
        title: (d.title ?? '').trim(),
        owner: (d.owner?.name ?? '').trim(),
        duration: d.duration ?? 0,
        view: d.stat?.view ?? 0,
        like: d.stat?.like ?? 0,
        desc: (d.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        tname: (d.tname ?? '').trim(),
      };
    } catch (error) {
      this.options.logger.info('B站元数据请求异常', {
        message: (error as Error).message.slice(0, 120),
      });
      return null;
    }
  }

  /** 拉弹幕。返回全部（未筛选），失败返回空数组。 */
  private async fetchDanmaku(cid: number): Promise<DanmakuItem[]> {
    try {
      const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
        headers: BILI_HEADERS,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return [];
      const xml = await res.text();

      // <d p="时间,模式,字号,颜色,...">文本</d>
      const out: DanmakuItem[] = [];
      const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        const p = m[1] as string;
        const raw = m[2] as string;
        const time = Number.parseFloat(p.split(',')[0] ?? '');
        if (!Number.isFinite(time)) continue;
        const text = decodeXmlEntities(raw).trim();
        if (text.length === 0) continue;
        out.push({ time, text });
      }
      return out;
    } catch (error) {
      this.options.logger.info('弹幕获取失败', {
        message: (error as Error).message.slice(0, 120),
      });
      return [];
    }
  }

  /** 拉热门评论（按热度排序）。 */
  private async fetchComments(aid: number): Promise<BiliComment[]> {
    if (!aid) return [];
    try {
      const json = await this.getJson<{
        code: number;
        data?: {
          replies?: Array<{
            like?: number;
            member?: { uname?: string };
            content?: { message?: string };
          }>;
        };
      }>(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${this.maxComments}`);

      if (json.code !== 0 || !json.data?.replies) return [];
      return json.data.replies
        .map((r) => ({
          user: (r.member?.uname ?? '').trim(),
          text: (r.content?.message ?? '').replace(/\s+/g, ' ').trim(),
          like: r.like ?? 0,
        }))
        .filter((c) => c.text.length > 0)
        .slice(0, this.maxComments);
    } catch {
      return [];
    }
  }

  /**
   * 从全部弹幕里挑出最有信息量的若干条。
   *
   * 为什么不能全给：1200 条塞进提示词会挤爆上下文，而且大部分是
   * 「哈哈哈」「1」「awsl」这种噪音。
   *
   * 策略：
   *   1. 去掉纯符号/单字/纯数字的噪音
   *   2. 按文本去重（重复刷屏折叠，保留首次出现）
   *   3. 按时间分段均匀采样，保证覆盖整段视频
   *   4. 优先保留较长的弹幕（信息量更大）
   */
  private pickDanmaku(all: DanmakuItem[]): DanmakuItem[] {
    const seen = new Set<string>();
    const cleaned: DanmakuItem[] = [];

    for (const d of all) {
      const text = d.text.trim();
      if (text.length === 0) continue;
      // 噪音过滤：纯标点、纯数字、单字、过短的情绪词
      if (/^[\d\s.,!?，。！？、~～]+$/.test(text)) continue;
      if (text.length < 2) continue;
      if (/^(哈+|啊+|哦+|额+|1+|6+|awsl|草|顶|打卡)$/i.test(text)) continue;

      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({ time: d.time, text });
    }

    if (cleaned.length <= this.maxDanmaku) return cleaned;

    // 按时间分桶，每桶取一条最长的（信息量最大），保证覆盖全片
    const buckets = this.maxDanmaku;
    const lastTime = cleaned[cleaned.length - 1]?.time ?? 0;
    const span = Math.max(lastTime, 1) / buckets;
    const picked: DanmakuItem[] = [];

    for (let i = 0; i < buckets; i++) {
      const from = i * span;
      const to = (i + 1) * span;
      const inBucket = cleaned.filter((d) => d.time >= from && d.time < to);
      if (inBucket.length === 0) continue;
      // 桶内取最长的，长度相同取靠前的
      let best = inBucket[0] as DanmakuItem;
      for (const d of inBucket) {
        if (d.text.length > best.text.length) best = d;
      }
      picked.push(best);
    }
    return picked;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: BILI_HEADERS,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

/** playurl 解析结果（供 media.ts 用）。 */
export interface BiliStreams {
  audioUrl: string | null;
  videoUrl: string | null;
  audioBandwidth: number;
  videoHeight: number;
}

/**
 * 取视频/音频流地址。
 *
 * 需要单独调用（不是每次都要），所以和 fetchVideo 分开：
 * 只抓弹幕时不必多打一次 playurl。
 */
export async function fetchStreams(
  cid: number,
  bvid: string,
  timeoutMs = 15_000,
): Promise<BiliStreams> {
  const empty: BiliStreams = { audioUrl: null, videoUrl: null, audioBandwidth: 0, videoHeight: 0 };
  try {
    // fnval=16 请求 DASH 格式（才能拿到分离的音/视频流）
    const url =
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${cid}&fnval=16&qn=64&fourk=0`;
    const res = await fetch(url, {
      headers: BILI_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return empty;
    const json = (await res.json()) as {
      code: number;
      data?: {
        dash?: {
          audio?: Array<{ baseUrl?: string; base_url?: string; bandwidth?: number }>;
          video?: Array<{
            baseUrl?: string;
            base_url?: string;
            bandwidth?: number;
            codecs?: string;
            width?: number;
            height?: number;
          }>;
        };
      };
    };
    if (json.code !== 0 || !json.data?.dash) return empty;

    const dash = json.data.dash;

    // 音频取最低码率：体积最小，ASR 够用
    const audio = (dash.audio ?? [])
      .map((a) => ({ url: a.baseUrl ?? a.base_url ?? '', bandwidth: a.bandwidth ?? 0 }))
      .filter((a) => a.url)
      .sort((a, b) => a.bandwidth - b.bandwidth)[0];

    // 视频优先 H.264 + 接近 480p
    const video = (dash.video ?? [])
      .map((v) => ({
        url: v.baseUrl ?? v.base_url ?? '',
        bandwidth: v.bandwidth ?? 0,
        codecs: v.codecs ?? '',
        height: v.height ?? 0,
        width: v.width ?? 0,
      }))
      .filter((v) => v.url)
      .sort((a, b) => {
        const aAvc = /avc1/i.test(a.codecs) ? 0 : 1;
        const bAvc = /avc1/i.test(b.codecs) ? 0 : 1;
        if (aAvc !== bAvc) return aAvc - bAvc;
        const aScore = Math.abs(a.width * a.height - 852 * 480);
        const bScore = Math.abs(b.width * b.height - 852 * 480);
        if (aScore !== bScore) return aScore - bScore;
        return a.bandwidth - b.bandwidth;
      })[0];

    return {
      audioUrl: audio?.url ?? null,
      videoUrl: video?.url ?? null,
      audioBandwidth: audio?.bandwidth ?? 0,
      videoHeight: video?.height ?? 0,
    };
  } catch {
    return empty;
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** 把秒数格式化成 mm:ss。 */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 把视频信息渲染成给模型看的上下文块。 */
export function renderBiliVideo(info: BiliVideoInfo): string {
  const { meta, danmaku, comments, danmakuTotal } = info;
  const durMin = Math.round(meta.duration / 60);

  const lines: string[] = [
    '【对方分享了一个 B 站视频，以下是你抓到的公开信息】',
    '',
    `标题：${meta.title}`,
    `UP 主：${meta.owner}　时长：${durMin} 分钟　分区：${meta.tname}`,
    `播放：${formatCount(meta.view)}　点赞：${formatCount(meta.like)}`,
  ];

  if (meta.desc) {
    lines.push(`简介：${meta.desc}`);
  }

  lines.push('');

  if (danmaku.length > 0) {
    lines.push(
      `观众弹幕（共 ${danmakuTotal} 条，以下按时间顺序摘取 ${danmaku.length} 条有代表性的）：`,
    );
    for (const d of danmaku) {
      lines.push(`  [${formatTime(d.time)}] ${d.text}`);
    }
  } else {
    lines.push('弹幕：这个视频没有弹幕。');
  }

  if (comments.length > 0) {
    lines.push('');
    lines.push('热门评论：');
    for (const c of comments) {
      lines.push(`  ${c.user}（${formatCount(c.like)} 赞）：${c.text}`);
    }
  }

  lines.push('');
  lines.push(
    '【说明】以上是弹幕和评论，**不是视频画面本身**。' +
      '你能从中推断视频大概讲了什么、观众什么反应，但你没看过画面。' +
      '可以热情地聊，但不要声称"我看了这个视频"或描述具体画面；' +
      '如果弹幕信息不足以判断内容，就诚实说只看到大家在刷什么。',
  );

  return lines.join('\n');
}

function formatCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  return String(n);
}
