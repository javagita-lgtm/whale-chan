/**
 * 小红书笔记读取。
 *
 * 【核心洞察，实测得出】
 *
 * 小红书的分享链接里带 `xsec_token` 参数，那是**有效凭证**：
 *   带 token 请求 → 返回完整笔记页（含正文 desc、视频 masterUrl、图集）
 *   去掉 token   → 被风控跳到 /404?error_code=300031
 *
 * 所以「小红书抓不到」这个前提是错的——只要别把 query 参数洗掉。
 *
 * 拿到视频直链后，抽帧和转写完全复用 B站 那套（BiliMedia），
 * 因为它们只认 URL，不认域名。
 *
 * 已知限制：
 *   - token 有时效，过期后仍会 404（这时如实告诉用户）
 *   - 只支持笔记页，不支持用户主页/搜索页
 *   - 不做登录、不碰签名算法
 */

import type { Logger } from './logger.js';
import type { BiliMedia, Frame, TranscribeResult } from './media.js';

/** 小红书笔记页抓取结果。 */
export interface XhsNote {
  /** 笔记 ID */
  noteId: string;
  /** 标题（卡片标题，不是 og:title 那个带站名的） */
  title: string;
  /** 正文（desc 字段） */
  desc: string;
  /** 作者昵称 */
  author?: string;
  /** 视频直链（视频笔记才有） */
  videoUrl?: string;
  /** 图集图片直链（图文笔记才有） */
  imageUrls: string[];
  /** 视频时长（秒），拿不到则为 0 */
  durationSec: number;
}

/** 该 URL 是否小红书笔记。 */
export function isXhsNoteUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)xiaohongshu\.com$/i.test(u.hostname)) return false;
    return /\/(discovery\/item|explore)\/[0-9a-f]{16,}/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** 从 URL 里取笔记 ID。 */
export function parseXhsNoteId(url: string): string | null {
  try {
    const u = new URL(url);
    const m = /\/(?:discovery\/item|explore)\/([0-9a-f]{16,})/i.exec(u.pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 抓取小红书笔记页并解析。
 *
 * @returns 解析成功返回笔记；被风控/失效/无 token 时返回带 reason 的对象
 */
export async function fetchXhsNote(
  url: string,
  logger: Logger,
  timeoutMs = 20_000,
): Promise<{ note: XhsNote | null; reason?: string }> {
  const noteId = parseXhsNoteId(url);
  if (!noteId) return { note: null, reason: '不是笔记链接' };

  // 关键：不能剥掉 query。xsec_token 就在里面。
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { note: null, reason: `请求失败：${(error as Error).message.slice(0, 80)}` };
  }

  if (!res.ok) return { note: null, reason: `HTTP ${res.status}` };

  // 被风控跳转到 /404?error_code=...&error_msg=...
  if (/\/(404|error)(\?|$)/i.test(res.url)) {
    const m = /[?&]error_msg=([^&]+)/.exec(res.url);
    const msg = m?.[1] ? safeDecode(m[1]) : '笔记无法访问';
    logger.info('小红书笔记被拦截', { url: url.slice(0, 80), msg });
    return {
      note: null,
      reason: `小红书拒绝了这次访问（${msg}）。通常是分享链接里的 xsec_token 过期了`,
    };
  }

  // 被跳转到登录页。
  // 实测：同一个 token 第一次能拿到完整内容，之后连续请求都会跳 /login，
  // 说明小红书对访问频率做了限制（不是 token 格式问题）。
  if (/\/login(\?|$)/i.test(res.url)) {
    logger.info('小红书要求登录', { url: url.slice(0, 80) });
    return {
      note: null,
      reason:
        '小红书要求登录后才能查看（连续抓取会被限制）。' +
        '把笔记截图或正文发我，我能读图',
    };
  }

  const html = await res.text();

  // 登录页/风控页的特征：一定没有 noteDetailMap，且含登录文案
  if (html.includes('noteDetailMap') === false && /请登录|扫码登录|login/i.test(html.slice(0, 5000))) {
    logger.info('小红书返回登录页', { url: url.slice(0, 80) });
    return { note: null, reason: '小红书要求登录（触发风控），拿不到笔记内容' };
  }

  // 正文：优先从 __INITIAL_STATE__ 的 note 节点取
  const desc =
    matchJsonString(html, '"desc"') ??
    matchJsonString(html, '"noteDesc"') ??
    '';

  // 标题
  const rawTitle =
    matchJsonString(html, '"title"') ??
    (/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
  const title = rawTitle.replace(/\s*-\s*小红书\s*$/, '').trim();

  // 视频直链：masterUrl 是 \u002F 转义的双引号字符串，先反转义
  let videoUrl = matchJsonString(html, '"masterUrl"');
  if (videoUrl) videoUrl = unescapeSlash(videoUrl);
  if (!videoUrl) {
    // 兜底：直接找 mp4 链接
    const m = /https?:\\?\/\\?\/[^"'\\ ]+\.mp4[^"'\\ ]*/.exec(html);
    if (m) videoUrl = m[0].replace(/\\\//g, '/');
  }
  // 去掉任何 \u002F 残留
  if (videoUrl) videoUrl = videoUrl.replace(/\\u002F/gi, '/');

  // 图集
  const imageUrls: string[] = [];
  for (const m of html.matchAll(/"urlDefault"\s*:\s*"([^"]+)"/g)) {
    const u = unescapeSlash(m[1] ?? '').replace(/\\u002F/gi, '/');
    if (/^https?:\/\//i.test(u) && !imageUrls.includes(u)) imageUrls.push(u);
    if (imageUrls.length >= 6) break;
  }

  // 作者
  const author = matchJsonString(html, '"nickname"');

  // 时长（毫秒或秒都可能，统一折算成秒）
  let durationSec = 0;
  const dm = /"(?:duration|videoDuration)"\s*:\s*(\d+(?:\.\d+)?)/.exec(html);
  if (dm?.[1]) {
    const v = Number(dm[1]);
    durationSec = v > 1000 ? Math.round(v / 1000) : Math.round(v);
  }

  if (!desc && !videoUrl && imageUrls.length === 0) {
    return { note: null, reason: '页面里没找到正文或媒体地址' };
  }

  logger.info('小红书笔记解析成功', {
    noteId,
    hasVideo: Boolean(videoUrl),
    images: imageUrls.length,
    descChars: desc.length,
  });

  return {
    note: {
      noteId,
      title: title || desc.slice(0, 30),
      desc,
      author,
      videoUrl,
      imageUrls,
      durationSec,
    },
  };
}

/** 取第一个 `"key":"value"` 的 value（处理转义引号）。 */
function matchJsonString(html: string, key: string): string | undefined {
  const re = new RegExp(`${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,4000})"`);
  const m = re.exec(html);
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function unescapeSlash(s: string): string {
  return s.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 渲染小红书笔记给模型看的文本块。 */
export function renderXhsNote(
  note: XhsNote,
  frames: Frame[],
  transcript: TranscribeResult | null,
): string {
  const lines: string[] = ['【小红书笔记】'];
  if (note.title) lines.push(`标题：${note.title}`);
  if (note.author) lines.push(`作者：${note.author}`);
  if (note.desc) lines.push(`正文：${note.desc}`);
  if (note.durationSec > 0) lines.push(`视频时长：${note.durationSec} 秒`);

  if (transcript && transcript.text.trim().length > 0) {
    lines.push(`\n【视频语音转写（${transcript.lines.length} 行，共 ${transcript.text.length} 字）】`);
    lines.push(transcript.text.trim());
  } else if (note.videoUrl) {
    lines.push('\n（这条笔记有视频，但语音没转出来，只能参考上面的正文）');
  }

  if (frames.length > 0) {
    lines.push(`\n【视频画面】已抽取 ${frames.length} 帧，见随附图片。`);
  }

  if (note.imageUrls.length > 0 && !note.videoUrl) {
    lines.push(`\n【图集】共 ${note.imageUrls.length} 张图，已随消息附带。`);
  }

  return lines.join('\n');
}
