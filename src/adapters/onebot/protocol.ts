/**
 * OneBot v11 事件类型定义（只覆盖本机器人用到的部分）。
 * 参考：https://github.com/botuniverse/onebot-11
 */

import type { RawSegment } from './segments.js';

export interface OneBotSender {
  user_id?: number;
  nickname?: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface OneBotGroupMessageEvent {
  post_type: 'message';
  message_type: 'group';
  time: number;
  self_id: number;
  group_id: number;
  user_id: number;
  message_id: number | string;
  message: RawSegment[] | string;
  raw_message: string;
  font?: number;
  sender: OneBotSender;
  anonymous?: unknown;
}

export interface OneBotPrivateMessageEvent {
  post_type: 'message';
  message_type: 'private';
  sub_type: 'friend' | 'group' | 'other';
  time: number;
  self_id: number;
  user_id: number;
  message_id: number | string;
  message: RawSegment[] | string;
  raw_message: string;
  sender: OneBotSender;
}

export type OneBotMessageEvent = OneBotGroupMessageEvent | OneBotPrivateMessageEvent;

export interface OneBotMetaEvent {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  time: number;
  self_id: number;
  sub_type?: string;
}

export interface OneBotNoticeEvent {
  post_type: 'notice';
  notice_type: string;
  time: number;
  self_id: number;
  [key: string]: unknown;
}

export interface OneBotRequestEvent {
  post_type: 'request';
  request_type: string;
  time: number;
  self_id: number;
  [key: string]: unknown;
}

export type OneBotEvent =
  | OneBotMessageEvent
  | OneBotMetaEvent
  | OneBotNoticeEvent
  | OneBotRequestEvent;

/** OneBot API 响应。 */
export interface OneBotResponse<T = unknown> {
  status: 'ok' | 'failed' | 'async';
  retcode: number;
  data: T;
  echo?: string;
}

export function isMessageEvent(event: OneBotEvent): event is OneBotMessageEvent {
  return event.post_type === 'message';
}
