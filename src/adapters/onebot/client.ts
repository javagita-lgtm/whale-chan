/**
 * OneBot v11 正向 WebSocket 客户端。
 *
 * 工作方式：
 *   1. 主动连接 NapCat 暴露的 WS 地址（NapCat 配置里勾选「WebSocket 服务」）；
 *   2. 收到事件 JSON，交给 onEvent 回调；
 *   3. 调用 API 时发送 {"action": "...", "params": {...}, "echo": "..."}，
 *      以 echo 作为关联键匹配响应，带超时；
 *   4. 断线自动指数退避重连。
 *
 * 为什么用正向 WS 而不是反向 WS：机器人主动连 NapCat 更符合运维直觉
 * （只开一个 127.0.0.1 端口，不需要给 NapCat 配回调地址），且多实例隔离简单。
 */

import { WebSocket } from 'ws';
import { statSync } from 'node:fs';
import type { Logger } from '../../core/logger.js';
import type { OneBotEvent, OneBotResponse } from './protocol.js';

export interface OneBotClientOptions {
  wsUrl: string;
  accessToken: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  logger: Logger;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class OneBotClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByUser = false;
  private echoSeq = 0;
  private state: ConnectionState = 'disconnected';
  private selfIdLog = '';
  /** 最近一次连接是否因鉴权失败断开 */
  private authFailed = false;

  constructor(private readonly options: OneBotClientOptions) {
    this.reconnectDelay = options.reconnectMinMs;
  }

  /** 当前连接状态。 */
  getState(): ConnectionState {
    return this.state;
  }

  /** 事件回调；由外部赋值。 */
  onEvent: ((event: OneBotEvent) => void) | null = null;
  /** 连接建立回调。 */
  onConnected: (() => void) | null = null;
  /** 连接断开回调。 */
  onDisconnected: (reason: string) => void = () => undefined;

  /** 建立连接并开始自动重连。 */
  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  /** 主动关闭，不再重连。 */
  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('客户端已停止'));
    }
    this.pending.clear();
    this.ws?.close(1000, 'client shutdown');
    this.ws = null;
    this.setState('disconnected');
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.logger.debug(`连接状态 → ${next}`);
  }

  private connect(): void {
    if (this.closedByUser) return;
    this.setState('connecting');

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers['Authorization'] = `Bearer ${this.options.accessToken}`;
    }

    const ws = new WebSocket(this.options.wsUrl, { headers });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = this.options.reconnectMinMs;
      this.authFailed = false;
      this.setState('connected');
      this.options.logger.info('已连接 OneBot v11', { url: this.options.wsUrl });
      this.onConnected?.();
    });

    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      this.handleFrame(text);
    });

    ws.on('error', (error: Error & { code?: string }) => {
      // ws 在握手阶段拿到 401/403 会以 unexpected-response 形式报错
      if (/unexpected server response:\s*(401|403)/i.test(error.message)) {
        this.authFailed = true;
        this.options.logger.error(
          'OneBot 鉴权失败（401/403）：请检查 ONEBOT_ACCESS_TOKEN 是否与 NapCat 的 Token 一致',
          { url: this.options.wsUrl },
        );
        return;
      }
      this.options.logger.warn('WebSocket 错误', { message: error.message, code: error.code });
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const detail = reason.toString('utf8');
      this.ws = null;
      this.setState('disconnected');
      this.failAllPending(new Error(`连接已关闭（${code}）`));
      if (!this.closedByUser) {
        this.options.logger.warn('连接断开，准备重连', { code, reason: detail });
        this.onDisconnected(`${code} ${detail}`.trim());
        this.scheduleReconnect(`${code} ${detail}`.trim());
      }
    });
  }

  private scheduleReconnect(lastError?: string): void {
    if (this.reconnectTimer || this.closedByUser) return;
    // 认证失败重连再快也没用：放大退避到上限，避免疯狂打日志刷屏
    const base = this.authFailed ? this.options.reconnectMaxMs : this.reconnectDelay;
    // 抖动：避免多实例同时重连形成尖峰
    const jitter = Math.floor(Math.random() * (base * 0.2));
    const delay = base + jitter;
    this.options.logger.info(`将在 ${delay}ms 后重连`, {
      authFailed: this.authFailed,
      lastError,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    if (!this.authFailed) {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMaxMs);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleFrame(text: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.options.logger.warn('收到非 JSON 帧，已忽略', { preview: text.slice(0, 120) });
      return;
    }

    const obj = payload as Record<string, unknown>;

    // 响应帧：有 echo 且没有 post_type
    if (typeof obj['echo'] === 'string' && !('post_type' in obj)) {
      const echo = obj['echo'] as string;
      const pending = this.pending.get(echo);
      if (!pending) return;
      this.pending.delete(echo);
      clearTimeout(pending.timer);
      const response = payload as OneBotResponse;
      if (response.status === 'ok') {
        pending.resolve(response.data);
      } else {
        pending.reject(
          new Error(`OneBot API 调用失败：status=${response.status} retcode=${response.retcode}`),
        );
      }
      return;
    }

    // 事件帧
    if ('post_type' in obj) {
      const event = payload as OneBotEvent;
      if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
        this.selfIdLog = String((event as { self_id?: number }).self_id ?? '');
        this.options.logger.info('OneBot 生命周期事件', {
          sub_type: (event as { sub_type?: string }).sub_type,
          self_id: this.selfIdLog,
        });
      }
      try {
        this.onEvent?.(event);
      } catch (error) {
        this.options.logger.error('事件处理抛出异常', { message: (error as Error).message });
      }
      return;
    }

    this.options.logger.debug('未识别的帧', { preview: text.slice(0, 120) });
  }

  /**
   * 调用 OneBot API。
   *
   * @param action API 名，例如 send_group_msg
   * @param params 参数
   * @param timeoutMs 超时；不传时按消息体大小自动推算
   */
  async callApi<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`OneBot 未连接，无法调用 ${action}`);
    }

    // 发送音频/视频时 NapCat 要把文件转码并上传，
    // 固定 15 秒不够（实测 11.8MB 的 mp3 会超时）。
    // 按消息体里 file 字段的路径大小推算超时。
    const timeout = timeoutMs ?? this.estimateTimeout(params);

    const echo = `wc_${Date.now()}_${this.echoSeq++}`;
    const frame = JSON.stringify({ action, params, echo });

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API 超时（${timeout}ms）：${action}`));
      }, timeout);

      this.pending.set(echo, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.ws?.send(frame);
      } catch (error) {
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  /**
   * 按消息体大小推算超时。
   *
   * 背景：2026-10-27 实测发 11.8MB 的 mp3 时，NapCat 光转码+上传就超过 15 秒，
   * 固定超时会导致「歌曲其实发出去了，但这边报失败」。
   *
   * 规则：基础 15 秒 + 每 MB 加 3 秒，上限 5 分钟。
   */
  private estimateTimeout(params: Record<string, unknown>): number {
    const baseMs = 15_000;
    const perMbMs = 3_000;
    const maxMs = 300_000;

    let bytes = 0;
    const message = params['message'];
    if (Array.isArray(message)) {
      for (const seg of message) {
        const data = (seg as { data?: { file?: unknown } }).data;
        const file = data?.file;
        if (typeof file !== 'string' || file.length === 0) continue;
        // 只统计本地存在的文件（URL / base64 跳过）
        try {
          bytes += statSync(file).size;
        } catch {
          /* 不是本地文件 */
        }
      }
    }

    const mb = bytes / 1024 / 1024;
    return Math.min(maxMs, Math.round(baseMs + mb * perMbMs));
  }
}
