/**
 * 内部统一消息模型。
 *
 * 设计要点：适配层负责把各平台（OneBot v11、未来的企微回调）的原生事件
 * 转换成这里的 MessageEvent。业务层只认识这一套结构，因此换平台只需换适配器。
 */

/** 消息片段（已从 CQ 码 / 逐段数组归一化）。 */
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'at'; qq: string }
  | { type: 'image'; url?: string; fileId?: string }
  | { type: 'face'; id: string }
  | { type: 'reply'; messageId: string }
  /**
   * 分享卡片（QQ 小程序 / 链接卡片）。
   * 这类消息的正文在 json 段的 meta 里，原始 text 段往往为空，
   * 不解析的话模型只能看到一个占位符。
   */
  | {
      type: 'share';
      title: string;
      url?: string;
      desc?: string;
      source?: string;
      /**
       * 卡片缩略图 URL。
       *
       * 为什么需要：小红书这类站点正文被风控挡住时，
       * 分享卡片里的封面图是唯一能看到的画面信息，可以喂给多模态模型读。
       */
      imageUrl?: string;
    }
  | { type: 'other'; rawType: string };

export type MessageScene = 'group' | 'private';

export interface SenderInfo {
  userId: string;
  nickname: string;
  /** 群名片（群消息里有，私聊为空） */
  card?: string;
}

export interface MessageEvent {
  /** 平台侧唯一 ID，用于幂等去重 */
  messageId: string;
  /** 内部事件 ID（适配层生成，便于链路追踪） */
  eventId: string;
  scene: MessageScene;
  /** 群号或私聊对端 QQ 号 */
  peerId: string;
  /** 群名称（群消息才有） */
  peerName?: string;
  /** 发送者 */
  sender: SenderInfo;
  segments: MessageSegment[];
  /** 纯文本视图，已去掉 @ 自身、CQ 码与多余空白 */
  text: string;
  /** 是否 @ 了机器人 */
  mentionsBot: boolean;
  /** 是否为机器人自己发的消息 */
  fromSelf: boolean;
  /** 平台时间戳（秒） */
  timestamp: number;
  /** 平台名，用于多适配器并存 */
  platform: string;
  /**
   * 被引用消息里的图片 URL。
   *
   * 为什么单独一个字段：引用一条看图消息说「这是啥」，
   * 图片的 URL 在被引用的那条里，不在本条 segments 里。
   * 不单独拿出来，视觉模型就看不到图。
   */
  quotedImageUrls?: string[];
  /** 被引用消息的原文（已含发送者），用于日志与排查 */
  quotedText?: string;
}

/** 适配器上报给业务层的能力接口。 */
export interface ChatAdapter {
  readonly platform: string;
  /** 发送纯文本 */
  sendText(scene: MessageScene, peerId: string, text: string): Promise<void>;
  /** 发送图片（URL / 本地路径 / base64） */
  sendImage(scene: MessageScene, peerId: string, image: string): Promise<void>;
  /** 发送语音（本地音频路径；适配层负责转码） */
  sendRecord(scene: MessageScene, peerId: string, audioPath: string): Promise<void>;
}
