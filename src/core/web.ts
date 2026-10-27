/**
 * 链接阅读与联网搜索。
 *
 * 依赖 DeepSeek 官方的两个只读接口（与模型接口共用同一把 Key）：
 *   POST /v1/tools/fetch   抓单个网页 → Markdown
 *   POST /v1/tools/search  按 query 搜索 → 结构化结果
 *
 * 设计取舍：
 *   - 不做浏览器渲染：Fetch 返回的是服务端已提取的正文，JS 重的网站会拿不到内容，
 *     这是能力边界，明确写进日志而不是假装成功。
 *   - 有缓存：同一条链接/同一个 query 在短时间被多人重复发时不重复计费。
 *   - 有预算：正文超过上限就截断，避免一条长文吃掉整个上下文。
 *   - 失败不阻断：拿不到内容时照常回复，只是没有网页内容可参考。
 *   - **有兜底**：DeepSeek fetch 失败时直接用 HTTP 抓一次，解析 og:* / <title>。
 *     实测小红书、部分公众号文章在 DeepSeek 那边返回 404，
 *     但自己抓 HTML 至少能拿到标题和分享摘要。
 */

import type { Logger } from './logger.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** 抓兜底 HTML 时用的 UA（很多站点会给无 UA 的请求返回空壳）。 */
const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 从文本里提取 http(s) 链接。末尾标点不算链接的一部分。 */
export function extractUrls(text: string, limit = 3): string[] {
  const re = /https?:\/\/[^\s<>"'）)\]】，。、；：！？]+/gi;
  const found = text.match(re) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    // 去掉尾部可能被误吞的标点
    const url = raw.replace(/[.,;:!?)\]'"），。、；：！？】」』]+$/u, '');
    if (!url || out.includes(url)) continue;
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 判断抓回来的是不是错误页/失效页。
 *
 * 为什么必须判：很多站点对失效内容会返回 200 + 一个「页面不见了」的壳页，
 * 如果不拦就会把这句话当成正文喂给模型，模型再一本正经地"总结"这句话。
 *
 * @returns 命中原因；没命中返回 null
 */
export function detectErrorPage(html: string, finalUrl?: string): string | null {
  // URL 层面优先取具体原因：小红书会跳到 /404?error_code=...&error_msg=...
  // 先读 error_msg，比笼统的「URL 指向错误页」更有用
  if (finalUrl) {
    const m = /[?&]error_msg=([^&]+)/.exec(finalUrl);
    if (m?.[1]) {
      let msg = m[1];
      try {
        msg = decodeURIComponent(msg);
      } catch {
        /* 保留原文 */
      }
      if (msg.trim().length > 0) return `站点报错：${msg.slice(0, 60)}`;
    }
    if (/\/(404|error|notfound|not-found)(\?|$)/i.test(finalUrl)) {
      return 'URL 指向错误页';
    }
  }

  // 内容层面：只扫头部，避免正文里偶然提到"已删除"就误判
  const head = html.slice(0, 4000);
  const PATTERNS: Array<[RegExp, string]> = [
    [/页面不见了|页面不存在|内容不存在|笔记.{0,4}(无法|不存在)|已被删除|内容已失效/i, '页面已被删除或失效'],
    [/你访问的页面|该页面无法访问|找不到该页面|this page (could not be found|doesn'?t exist)/i, '页面无法访问'],
    [/请登录|登录后查看|扫码登录|需要登录/i, '需要登录'],
    [/访问频繁|访问过于频繁|请求过于频繁|操作频繁|rate limit|too many requests/i, '访问受限'],
  ];
  for (const [re, reason] of PATTERNS) {
    if (re.test(head)) return reason;
  }
  return null;
}

/** 从 HTML 里提取的分享元信息。 */
export interface OpenGraphMeta {
  title?: string;
  description?: string;
  siteName?: string;
  keywords?: string;
}

/**
 * 从 HTML 里解析 og:* / twitter:* / <title> / <meta name=description>。
 *
 * 优先 og: 系列（微信、QQ、小红书等分享卡片都用这套），
 * 没有就退回 twitter: 和普通 meta。
 */
export function extractOpenGraph(html: string): OpenGraphMeta {
  const pick = (patterns: RegExp[]): string | undefined => {
    for (const re of patterns) {
      const m = re.exec(html);
      const v = m?.[1]?.trim();
      if (v && v.length > 0) return decodeEntities(v);
    }
    return undefined;
  };

  // attribute 顺序两种都要照顾：property 在前 / content 在前
  const meta = (key: string): RegExp[] => [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'),
  ];

  return {
    title: pick([...meta('og:title'), ...meta('twitter:title'), /<title[^>]*>([^<]*)<\/title>/i]),
    description: pick([
      ...meta('og:description'),
      ...meta('twitter:description'),
      ...meta('description'),
    ]),
    siteName: pick([...meta('og:site_name'), ...meta('application-name')]),
    keywords: pick(meta('keywords')),
  };
}

/** 解码常见 HTML 实体（小红书/知乎的标题里经常有）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** 该 URL 是否值得抓取（跳过明显无内容的资源）。 */export function isReadableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;

  // 图片/媒体/压缩包等二进制资源没有可读正文
  const binaryExt = /\.(jpe?g|png|gif|webp|bmp|svg|ico|mp4|m4a|mp3|wav|webm|mkv|avi|mov|zip|rar|7z|tar|gz|pdf|exe|msi|apk|dmg|iso)$/i;
  if (binaryExt.test(parsed.pathname)) return false;
  return true;
}

/** 抓取结果。 */
export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  /** 内容是否被截断（原始正文超过预算） */
  truncated: boolean;
}

/** 搜索结果条目（精简后只保留注入提示词的部分）。 */
export interface SearchHit {
  title: string;
  url: string;
  summary: string;
  date?: string | null;
  /** 来源站点名（如「中国新闻网」），接口返回 site_name */
  site?: string;
}

export interface WebToolsOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  logger: Logger;
}

export class WebTools {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly cacheTtlMs = 10 * 60_000;

  constructor(private readonly options: WebToolsOptions) {
    // baseUrl 归一化：本类内部的路径已经带 /v1（`/v1/tools/search`），
    // 所以 baseUrl 只需要 origin。
    //
    // 【2026-10-27 真实 bug】.env 里写的是 `https://api.deepseek.com/v1`，
    // 直接拼接会变成 `/v1/v1/tools/search` → 404，联网搜索**从来没成功过**。
    // LLM 客户端没这个问题，因为它拼的是 `/chat/completions`，正好接上。
    //
    // 这里统一剥掉尾部多余的 `/v1`，两种写法都能用。
    let base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    base = base.replace(/\/v1$/i, '');
    this.baseUrl = base;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  get enabled(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  /**
   * 抓取单个网页。
   * 成功返回正文（已按 maxChars 截断）；失败返回 null 并记录原因。
   */
  async fetchPage(url: string, maxChars = 4000): Promise<FetchedPage | null> {
    if (!this.enabled) return null;
    if (!isReadableUrl(url)) {
      this.options.logger.debug('跳过不可读链接', { url });
      return null;
    }

    const cacheKey = `fetch:${url}:${maxChars}`;
    const cached = this.readCache<FetchedPage>(cacheKey);
    if (cached) return cached;

    try {
      const json = await this.post<{ title?: string; content?: string }>('/v1/tools/fetch', { url });
      const raw = (json.content ?? '').trim();
      if (raw.length === 0) {
        this.options.logger.info('链接无可用正文', { url });
        return null;
      }

      const truncated = raw.length > maxChars;
      const page: FetchedPage = {
        url,
        title: (json.title ?? '').trim() || url,
        content: truncated ? `${raw.slice(0, maxChars)}…（正文过长已截断）` : raw,
        truncated,
      };
      this.writeCache(cacheKey, page);
      this.options.logger.info('链接抓取成功', {
        url,
        title: page.title.slice(0, 40),
        chars: raw.length,
        truncated,
      });
      return page;
    } catch (error) {
      // 404 是常见情况（站点拒绝、需要登录、JS 渲染），不当作错误刷日志
      this.options.logger.info('链接抓取失败', {
        url,
        message: (error as Error).message.slice(0, 160),
      });

      // 兜底：自己抓一次 HTML，至少拿 og:title / og:description
      const fallback = await this.fetchMetaFallback(url);
      if (fallback) {
        this.writeCache(cacheKey, fallback);
        return fallback;
      }
      return null;
    }
  }

  /**
   * DeepSeek fetch 失败时的兜底：直接 HTTP 抓 HTML，解析 og 标签。
   *
   * 为什么值得做：小红书、部分需要登录的站点，DeepSeek 那边直接 404，
   * 但我们自己带浏览器 UA 抓能拿到 `<meta property="og:title">` 和
   * `og:description`——这正是分享卡片上显示的那段话。
   *
   * 拿不到就返回 null，不编造内容。
   */
  private async fetchMetaFallback(url: string): Promise<FetchedPage | null> {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': FALLBACK_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.options.logger.info('兜底抓取失败', { url, status: res.status });
        return null;
      }
      const html = await res.text();

      // 先判断是不是错误页/失效页。
      // 实测小红书失效笔记会 302 到 /404?error_code=300031&error_msg=当前笔记暂时无法浏览，
      // 标题是「小红书 - 你访问的页面不见了」——如果不拦，会把这句话当成内容喂给模型。
      const errReason = detectErrorPage(html, res.url);
      if (errReason) {
        this.options.logger.info('兜底抓取命中错误页', { url, reason: errReason });
        return null;
      }

      const meta = extractOpenGraph(html);
      if (!meta.title && !meta.description) {
        this.options.logger.info('兜底抓取无 og 信息', { url, bytes: html.length });
        return null;
      }

      // 把标题和摘要拼成可读正文，明确标注这是"摘要"而非全文
      const lines: string[] = [];
      if (meta.title) lines.push(`标题：${meta.title}`);
      if (meta.siteName) lines.push(`来源：${meta.siteName}`);
      if (meta.description) lines.push(`摘要：${meta.description}`);
      if (meta.keywords) lines.push(`关键词：${meta.keywords}`);
      lines.push('（以上为页面抓到的分享摘要，正文需要登录或用浏览器渲染才能拿到）');

      this.options.logger.info('兜底抓取成功（仅有摘要）', {
        url,
        title: meta.title?.slice(0, 40),
      });

      return {
        url,
        title: meta.title || url,
        content: lines.join('\n'),
        truncated: false,
      };
    } catch (error) {
      this.options.logger.info('兜底抓取异常', {
        url,
        message: (error as Error).message.slice(0, 120),
      });
      return null;
    }
  }

  /**
   * 联网搜索。
   * @param query 搜索词
   * @param count 返回条数（1~50）
   */
  async search(query: string, count = 5): Promise<SearchHit[]> {
    if (!this.enabled) return [];
    const q = query.trim();
    if (q.length === 0) return [];

    const cacheKey = `search:${q}:${count}`;
    const cached = this.readCache<SearchHit[]>(cacheKey);
    if (cached) return cached;

    try {
      const json = await this.post<{
        results?: Array<{
          title?: string;
          url?: string;
          summary?: string;
          snippet?: string;
          date?: string | null;
          site_name?: string;
          site_icon?: string;
        }>;
      }>('/v1/tools/search', { query: q, count, need_content: false });

      const hits: SearchHit[] = (json.results ?? [])
        .map((r) => ({
          title: (r.title ?? '').trim(),
          url: (r.url ?? '').trim(),
          // summary 通常 600~800 字，比 snippet 更适合给模型读
          summary: (r.summary ?? r.snippet ?? '').trim(),
          date: r.date ?? null,
          // 站点名：接口返回的是 site_name，之前漏了这个字段
          site: (r.site_name ?? '').trim() || undefined,
        }))
        .filter((h) => h.title.length > 0 && h.url.length > 0)
        .slice(0, count);

      this.writeCache(cacheKey, hits);
      this.options.logger.info('联网搜索完成', { query: q.slice(0, 40), hits: hits.length });
      return hits;
    } catch (error) {
      this.options.logger.info('联网搜索失败', {
        query: q.slice(0, 40),
        message: (error as Error).message.slice(0, 160),
      });
      return [];
    }
  }

  private readCache<T>(key: string): T | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return hit.value as T;
  }

  private writeCache(key: string, value: unknown): void {
    // 简单容量控制：超过 200 条就清掉最早的一半
    if (this.cache.size > 200) {
      const keys = [...this.cache.keys()].slice(0, 100);
      for (const k of keys) this.cache.delete(k);
    }
    this.cache.set(key, { at: Date.now(), value });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let detail = text.slice(0, 200);
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保持原始文本
        }
        throw new Error(`HTTP ${response.status}：${detail}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`请求超时（${this.timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 判断用户是否在要求「查一下 / 搜一下」而不是只想聊天。
 *
 * 为什么用关键词而不是再调一次模型：判断插话时的教训是——
 * 能零成本的判断就别花 token。这里只做粗筛，
 * 真正的取舍交给模型（拿到搜索结果后它自己决定要不要用）。
 */
const SEARCH_INTENT_PATTERNS: RegExp[] = [
  /搜(一下|一搜|搜看|索)/,
  /查(一下|一查|查看)/,
  /帮我(查|搜|找)/,
  /(最新|最近|今天|现在|目前).{0,6}(新闻|消息|情况|价格|进展|动态)/,
  /(多少钱|什么价|涨了|跌了|怎么样)的?.{0,4}$/,
  /(是谁|是什么|什么时候|在哪里|为什么).{0,8}(吗|呢|？|\?)/,
  /(有|有没有).{0,8}(推荐|介绍)/,
];

/** 粗略判断文本是否带有搜索意图。 */
export function looksLikeSearchIntent(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  // 带链接的消息通常是要"看这个"而不是"搜这个"，不触发搜索
  if (/https?:\/\//i.test(t)) return false;
  return SEARCH_INTENT_PATTERNS.some((re) => re.test(t));
}

/**
 * 把搜索结果渲染成给模型看的上下文块。
 * 只保留标题/摘要/来源，不带正文（正文按需再 fetch，省流量）。
 */
export function renderSearchHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h, i) => {
    const parts = [`[${i + 1}] ${h.title}`];
    if (h.site) parts.push(` · ${h.site}`);
    if (h.date) parts.push(`（${h.date.slice(0, 10)}）`);
    parts.push(`\n    来源：${h.url}`);
    if (h.summary) parts.push(`\n    摘要：${h.summary}`);
    return parts.join('');
  });
  return [
    `【联网搜索结果】关键词：${query}`,
    ...lines,
    '【结果结束】',
    '这些是刚搜到的实时资料。请结合它们回答，不要编造搜索结果里没有的信息；',
    '如果结果与问题无关，就直说没查到有用的，不要硬凑。',
  ].join('\n');
}

/** 把抓取到的网页渲染成给模型看的上下文块。 */
export function renderFetchedPages(pages: FetchedPage[]): string {
  if (pages.length === 0) return '';
  const blocks = pages.map((p, i) => {
    return [
      `[网页 ${i + 1}] ${p.title}`,
      `地址：${p.url}`,
      '正文：',
      p.content,
    ].join('\n');
  });
  return [
    '【对方发的链接，已代你打开】',
    ...blocks,
    '【链接内容结束】',
    '请基于上面的网页内容回应。若是视频/音频页面而只拿到了标题简介，',
    '就诚实说明你看不到画面，只根据标题和信息聊，不要假装看过。',
  ].join('\n\n');
}
