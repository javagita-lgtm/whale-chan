/**
 * OneBot v11 适配器：把 OneBot 事件翻译成内部 MessageEvent，
 * 并实现 ChatAdapter 的发送能力。
 */

import type { ChatAdapter, MessageEvent, MessageScene } from '../../core/types.js';
import type { Logger } from '../../core/logger.js';
import { resolve } from 'node:path';
import { imageSegment, parseCQCodes, renderPlainText, textSegment, toInternalSegments } from './segments.js';
import type { RawSegment } from './segments.js';
import type {
  OneBotClient,
} from './client.js';
import type {
  OneBotEvent,
  OneBotGroupMessageEvent,
  OneBotMessageEvent,
  OneBotPrivateMessageEvent,
} from './protocol.js';
import { isMessageEvent } from './protocol.js';

export interface OneBotAdapterOptions {
  client: OneBotClient;
  logger: Logger;
  /** 机器人自身 QQ；若为 0 则从事件 self_id 自动学习 */
  selfId: string;
}

let eventSeq = 0;

export class OneBotAdapter implements ChatAdapter {
  readonly platform = 'qq';

  private knownSelfId: string;

  constructor(private readonly options: OneBotAdapterOptions) {
    this.knownSelfId = options.selfId;
  }

  get selfId(): string {
    return this.knownSelfId;
  }

  /**
   * 处理原始事件，返回解析后的内部事件；非消息事件返回 null。
   *
   * 改成 async 是为了补全引用消息（要调 get_msg 拉被引用的那条）。
   * 调用方是 `client.onEvent`，它本身不 await，所以用 void 处理即可。
   */
  async handleEvent(event: OneBotEvent): Promise<MessageEvent | null> {
    if (!isMessageEvent(event)) return null;
    const parsed = this.parseMessageEvent(event);
    // 有引用段就补全内容，失败不影响主流程
    return this.enrichQuoted(parsed);
  }

  private parseMessageEvent(event: OneBotMessageEvent): MessageEvent {
    const selfId = String(event.self_id);
    if (this.knownSelfId === '') this.knownSelfId = selfId;

    const rawSegments: RawSegment[] = Array.isArray(event.message)
      ? (event.message as RawSegment[])
      : parseCQCodes(typeof event.message === 'string' ? event.message : event.raw_message ?? '');

    const segments = toInternalSegments(rawSegments);
    const mentionsBot = segments.some((s) => s.type === 'at' && s.qq === this.knownSelfId);
    const text = renderPlainText(segments, this.knownSelfId);

    // 有非文本段时记一条，排查"为什么机器人看不到卡片内容"这类问题全靠它
    const odd = rawSegments.filter((s) => s.type !== 'text' && s.type !== 'at' && s.type !== 'face');
    if (odd.length > 0) {
      this.options.logger.debug('消息含非文本段', {
        types: odd.map((s) => s.type),
        // 卡片类数据可能几百字符，截断保留结构
        sample: JSON.stringify(odd[0]?.data ?? {}).slice(0, 500),
        rendered: text.slice(0, 120),
      });
    }

    const scene: MessageScene = event.message_type === 'group' ? 'group' : 'private';

    let peerId: string;
    let peerName: string | undefined;
    if (event.message_type === 'group') {
      const g = event as OneBotGroupMessageEvent;
      peerId = String(g.group_id);
    } else {
      const p = event as OneBotPrivateMessageEvent;
      peerId = String(p.user_id);
      peerName = p.sender?.nickname;
    }

    const sender = {
      userId: String(event.user_id),
      nickname: event.sender?.nickname ?? '',
      card: event.sender?.card,
    };

    return {
      messageId: String(event.message_id),
      eventId: `qq-${Date.now()}-${eventSeq++}`,
      scene,
      peerId,
      peerName,
      sender,
      segments,
      text,
      mentionsBot,
      fromSelf: sender.userId === this.knownSelfId,
      timestamp: event.time,
      platform: this.platform,
    };
  }

  /**
   * 补全引用消息的内容。
   *
   * 为什么需要：OneBot 的 reply 段只有 message_id，
   * 被引用消息的正文根本不在事件里。之前渲染成 `[回复]` 占位符，
   * 模型看到的就是「[回复]你看看这个」——完全不知道在引用什么。
   *
   * 实测用户场景：「我引用一条消息说『你看看这个』」，机器人回
   * 「你让我看啥，我这边啥也没收到」，体验很差。
   *
   * 这里用 get_msg 主动拉一次被引用的消息，拼进 text 里。
   * 拉取失败不影响主流程（只保留占位符）。
   */
  private async enrichQuoted(event: MessageEvent): Promise<MessageEvent> {
    const replySeg = event.segments.find((s) => s.type === 'reply');
    if (!replySeg || replySeg.type !== 'reply' || !replySeg.messageId) return event;

    try {
      const quoted = await this.options.client.callApi<{
        message?: RawSegment[] | string;
        sender?: { nickname?: string; card?: string };
        raw_message?: string;
      }>('get_msg', { message_id: Number(replySeg.messageId) }, 8000);

      if (!quoted) return event;

      const rawSegs: RawSegment[] = Array.isArray(quoted.message)
        ? (quoted.message as RawSegment[])
        : parseCQCodes(
            typeof quoted.message === 'string' ? quoted.message : quoted.raw_message ?? '',
          );

      const innerSegs = toInternalSegments(rawSegs);
      const inner = renderPlainText(innerSegs, this.knownSelfId).trim();
      if (inner.length === 0) return event;

      // 被引用消息里的图片要单独拿出来——它们不在本条 segments 里，
      // 不提取的话用户引用一张图问"这是啥"，视觉模型根本看不到图。
      const quotedImageUrls = innerSegs
        .filter((s): s is { type: 'image'; url?: string; fileId?: string } => s.type === 'image')
        .map((s) => s.url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0)
        .slice(0, 2);

      const who = quoted.sender?.card || quoted.sender?.nickname || '';
      const prefix = who ? `[引用 ${who}：` : '[引用：';
      // 引用内容截断到 300 字，避免一条长文吃掉上下文
      const snippet = inner.length > 300 ? `${inner.slice(0, 300)}…` : inner;
      const quotedLine = `${prefix}${snippet}]`;

      // 把占位符 [回复] 换成真正的引用内容
      const text = event.text.replace('[回复]', quotedLine);

      this.options.logger.info('已补全引用消息', {
        messageId: replySeg.messageId,
        quotedChars: inner.length,
        quotedImages: quotedImageUrls.length,
      });

      return { ...event, text, quotedImageUrls, quotedText: quotedLine };
    } catch (error) {
      // 拉不到就算了：可能是很久以前的消息，或者机器人不在当时的会话里
      this.options.logger.info('引用消息拉取失败', {
        messageId: replySeg.messageId,
        message: (error as Error).message.slice(0, 100),
      });
      return event;
    }
  }

  async sendText(scene: MessageScene, peerId: string, text: string): Promise<void> {
    const action = scene === 'group' ? 'send_group_msg' : 'send_private_msg';
    const key = scene === 'group' ? 'group_id' : 'user_id';
    await this.options.client.callApi(action, {
      [key]: Number(peerId),
      message: [textSegment(text)],
    });
    this.options.logger.debug('已发送文本', { scene, peerId, length: text.length });
  }

  async sendImage(scene: MessageScene, peerId: string, image: string): Promise<void> {
    const action = scene === 'group' ? 'send_group_msg' : 'send_private_msg';
    const key = scene === 'group' ? 'group_id' : 'user_id';

    // NapCat 解析 file 字段时以自身进程目录为基准，相对路径会报 retcode=1200；
    // 统一转成绝对路径（Windows 反斜杠），确保任何工作目录下都能找到文件。
    const resolved = resolve(image);

    await this.options.client.callApi(action, {
      [key]: Number(peerId),
      message: [imageSegment(resolved)],
    });
    this.options.logger.debug('已发送图片', { scene, peerId, path: resolved });
  }

  /**
   * 发送语音。
   *
   * NapCat 收到 record 段会自动把 wav/mp3 转成 SILK_V3，
   * 不需要我们处理 QQ 的私有编码。实测 6~42 秒音频都正常。
   */
  async sendRecord(scene: MessageScene, peerId: string, audioPath: string): Promise<void> {
    const action = scene === 'group' ? 'send_group_msg' : 'send_private_msg';
    const key = scene === 'group' ? 'group_id' : 'user_id';
    const resolved = resolve(audioPath);

    await this.options.client.callApi(action, {
      [key]: Number(peerId),
      message: [{ type: 'record', data: { file: resolved } }],
    });
    this.options.logger.debug('已发送语音', { scene, peerId, path: resolved });
  }

  /** 供 /ping 之类的诊断使用。 */
  async getStatus(): Promise<unknown> {
    return await this.options.client.callApi('get_status');
  }

  async getLoginInfo(): Promise<{ user_id: number; nickname: string }> {
    return await this.options.client.callApi<{ user_id: number; nickname: string }>('get_login_info');
  }
}
