/**
 * OneBot v11 消息段与 CQ 码互转。
 *
 * OneBot v11 有两种格式：
 *   - array 格式：post_format=array（推荐），消息是结构化数组；
 *   - string 格式：post_format=string，消息是 CQ 码字符串，例如
 *     "你好[CQ:at,qq=123] 看这个[CQ:image,file=xxx.jpg]"
 *
 * 本模块同时支持两种，并统一输出内部 MessageSegment[]。
 */

import type { MessageSegment } from '../../core/types.js';

/** OneBot v11 原始消息段（array 格式）。 */
export interface RawSegment {
  type: string;
  data?: Record<string, unknown>;
}

/** 转义 CQ 码中的特殊字符。 */
export function escapeCQ(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

/** 反转义 CQ 码。 */
export function unescapeCQ(text: string): string {
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/**
 * 解析 CQ 码字符串为原始消息段数组。
 * 非 CQ 片段合并为 text 段，保持原文顺序。
 */
export function parseCQCodes(raw: string): RawSegment[] {
  const segments: RawSegment[] = [];
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string): void => {
    if (chunk.length === 0) return;
    const text = unescapeCQ(chunk);
    if (text.length > 0) segments.push({ type: 'text', data: { text } });
  };

  while ((match = re.exec(raw)) !== null) {
    pushText(raw.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    const data: Record<string, unknown> = {};
    const paramStr = match[2] ?? '';
    if (paramStr.length > 1) {
      for (const pair of paramStr.slice(1).split(',')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const key = pair.slice(0, eq);
        const value = unescapeCQ(pair.slice(eq + 1));
        if (key) data[key] = value;
      }
    }
    segments.push({ type: match[1] ?? 'unknown', data });
  }
  pushText(raw.slice(lastIndex));
  return segments;
}

/** 把原始消息段数组转换为内部统一消息段。 */
export function toInternalSegments(raw: RawSegment[]): MessageSegment[] {
  const out: MessageSegment[] = [];
  for (const seg of raw) {
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text': {
        const text = String(data['text'] ?? '');
        if (text.length > 0) out.push({ type: 'text', text });
        break;
      }
      case 'at': {
        out.push({ type: 'at', qq: String(data['qq'] ?? '') });
        break;
      }
      case 'image': {
        const url = typeof data['url'] === 'string' ? data['url'] : undefined;
        const fileId = typeof data['file'] === 'string' ? data['file'] : undefined;
        out.push({ type: 'image', url, fileId });
        break;
      }
      case 'face': {
        out.push({ type: 'face', id: String(data['id'] ?? '') });
        break;
      }
      case 'reply': {
        out.push({ type: 'reply', messageId: String(data['id'] ?? '') });
        break;
      }
      case 'json':
      case 'xml': {
        // QQ 分享卡片（小程序 / 图文链接）走这里。
        // 不解析的话正文会退化成 "[json]" 占位符，模型完全不知道分享的是什么。
        const share = parseShareCard(seg.type, data);
        if (share) out.push(share);
        else out.push({ type: 'other', rawType: seg.type });
        break;
      }
      default: {
        out.push({ type: 'other', rawType: seg.type });
        break;
      }
    }
  }
  return out;
}

/**
 * 解析 QQ 分享卡片。
 *
 * OneBot v11 里这类消息有两种载体：
 *   - json 段：{"data": "<一段 JSON 字符串>"}，内部结构各家不一
 *   - xml 段：{"data": "<xml>...<title>..</title>..<url>..</url></xml>"}
 *
 * 卡片里最常见的可用信息是：标题、跳转链接、描述、来源。
 * B 站分享卡会带 qqdocurl / jumpUrl（b23.tv 短链），这才是能真正去抓的那条。
 */
export function parseShareCard(
  kind: 'json' | 'xml',
  data: Record<string, unknown>,
): MessageSegment | null {
  const raw = typeof data['data'] === 'string' ? data['data'] : '';
  if (raw.trim().length === 0) return null;

  if (kind === 'xml') {
    const title = firstTag(raw, 'title');
    const url = firstTag(raw, 'url') ?? firstTag(raw, 'brief');
    const desc = firstTag(raw, 'summary');
    const source = firstTag(raw, 'sourcename');
    // 缩略图：QQ 卡片里常叫 thumburl / thumbURL / cover
    const imageUrl =
      firstTag(raw, 'thumburl') ?? firstTag(raw, 'thumbURL') ?? firstTag(raw, 'cover');
    if (!title && !url) return null;
    return {
      type: 'share',
      title: title ?? (url ? '（分享的链接）' : ''),
      url: url && /^https?:\/\//i.test(url) ? url : undefined,
      desc,
      source,
      imageUrl: imageUrl && /^https?:\/\//i.test(imageUrl) ? imageUrl : undefined,
    };
  }

  // json：可能已经是对象，也可能是字符串
  let obj: unknown = raw;
  try {
    obj = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const title = deepString(obj, ['title', 'prompt', 'desc']);
  const desc = deepString(obj, ['desc', 'summary', 'description']);
  const source = deepString(obj, ['app', 'source', 'sourcename']);

  // 链接优先找专用字段；找不到再从标题/描述里抠。
  // QQ 有些卡片把「标题 + 链接」拼在一个字段里，只查 url 字段会漏。
  const url = deepUrl(obj) ?? extractFirstUrl(title) ?? extractFirstUrl(desc);

  // 缩略图：小程序卡片里多为 preview / thumburl / cover / imageUrl
  const rawImage = deepString(obj, [
    'preview',
    'thumburl',
    'thumbUrl',
    'thumbURL',
    'cover',
    'coverUrl',
    'imageUrl',
    'picUrl',
  ]);
  const imageUrl =
    rawImage && /^https?:\/\//i.test(rawImage)
      ? rawImage
      : (extractFirstUrl(rawImage) ?? undefined);

  if (!title && !url) return null;
  // 题目里常带「【标题】链接」这种冗余，交给后续清洗
  return {
    type: 'share',
    title: title ?? '（分享的卡片）',
    url,
    desc: desc && desc !== title ? desc : undefined,
    source,
    imageUrl,
  };
}

/** 从任意文本里抠出第一个 http(s) 链接。 */
function extractFirstUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /https?:\/\/[^\s"'<>）)】]+/i.exec(text);
  if (!m) return undefined;
  // 去掉尾部常见标点
  return m[0].replace(/[.,;:!?)\]'"】，。、；：！？】]+$/u, '');
}

/** 取第一个 <tag> 的文本内容。 */
function firstTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return undefined;
  return decodeXml(m[1] ?? '').trim() || undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 在嵌套对象里找第一个匹配 key 的字符串值。 */
function deepString(node: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6 || node === null || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = deepString(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** 找卡片里的跳转链接，优先 qqdocurl / jumpUrl 这类真正可抓的地址。 */
function deepUrl(node: unknown, depth = 0): string | undefined {
  const preferred = ['qqdocurl', 'jumpUrl', 'jump_url', 'url', 'link'];
  const found = deepString(node, preferred, depth);
  if (!found) return undefined;
  // 只接受 http(s)，过滤掉 tencent 内部的 scheme
  if (!/^https?:\/\//i.test(found)) return undefined;
  // 有些卡片把标题和链接拼在一起，取最后一段 http 开头的内容
  const m = /https?:\/\/[^\s"'<>]+/i.exec(found);
  return m ? m[0] : undefined;
}

/**
 * 把内部消息段渲染为纯文本视图，用于喂给模型与日志。
 *
 * @param segments 内部消息段
 * @param selfId 机器人自身 QQ；@ 自身会被替换为 [艾特你] 标记，
 *               其他 @ 渲染为 @昵称 形式（有昵称时）或 @QQ。
 */
export function renderPlainText(segments: MessageSegment[], selfId: string): string {
  const parts: string[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        parts.push(seg.text);
        break;
      case 'at':
        parts.push(seg.qq === selfId ? '[艾特你]' : `@${seg.qq}`);
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'reply':
        parts.push('[回复]');
        break;
      case 'share':
        // 卡片要渲染成标题 + 链接，模型才知道对方分享了什么。
        // 有封面图时补一句提示，让模型知道"另有图可看"（图会以多模态形式单独送）。
        parts.push(
          seg.url
            ? `[分享]${seg.title} ${seg.url}`
            : `[分享]${seg.title}`,
        );
        if (seg.imageUrl) parts.push('（卡片带封面图）');
        break;
      case 'other':
        parts.push(`[${seg.rawType}]`);
        break;
    }
  }
  return parts.join('').replace(/[ \t]+/g, ' ').trim();
}

/** 构造 OneBot array 格式的文本消息段。 */
export function textSegment(text: string): RawSegment {
  return { type: 'text', data: { text } };
}

/** 构造 OneBot array 格式的 @ 消息段。 */
export function atSegment(qq: string): RawSegment {
  return { type: 'at', data: { qq } };
}

/** 构造 OneBot array 格式的图片消息段。 */
export function imageSegment(file: string): RawSegment {
  return { type: 'image', data: { file } };
}
