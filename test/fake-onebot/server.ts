/**
 * 假 OneBot v11 服务端（仅测试/本地联调用）。
 *
 * 模拟 NapCat 的正向 WebSocket 服务端：
 *   1. 接受机器人连接；
 *   2. 提供 push(event) 向机器人推送事件；
 *   3. 记录机器人发来的 API 调用并回 ok；
 *   4. 可注入延迟/失败，用于测超时与容错。
 *
 * 单独运行可做手工联调：
 *   pnpm fake-onebot            # 监听 3101
 *   再另开终端 LOG_LEVEL=debug ONEBOT_WS_URL=ws://127.0.0.1:3101 pnpm dev
 *   按回车向机器人推一条「@机器人」的群消息。
 */

import { WebSocketServer, type WebSocket } from 'ws';

export interface RecordedCall {
  action: string;
  params: Record<string, unknown>;
}

export interface FakeOneBotOptions {
  port: number;
  /** 每次 API 调用的额外延迟 */
  apiDelayMs?: number;
  /** 让指定 action 返回 failed */
  failActions?: string[];
}

export class FakeOneBotServer {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  readonly calls: RecordedCall[] = [];
  /**
   * 预置的历史消息，供 get_msg 返回。
   * key = message_id，value = OneBot get_msg 的 data 结构。
   */
  readonly messageStore = new Map<number, Record<string, unknown>>();
  private port = 0;

  constructor(private readonly options: FakeOneBotOptions) {}

  async start(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.options.port, host: '127.0.0.1' });
      this.wss = wss;
      wss.on('listening', () => {
        const addr = wss.address();
        this.port = typeof addr === 'object' && addr !== null ? (addr.port as number) : this.options.port;
        resolve(this.port);
      });
      wss.on('error', reject);
      wss.on('connection', (socket) => {
        this.socket = socket;
        socket.on('close', () => {
          if (this.socket === socket) this.socket = null;
        });
        socket.on('message', (raw) => {
          const frame = JSON.parse(raw.toString('utf8')) as {
            action: string;
            params: Record<string, unknown>;
            echo: string;
          };
          void this.handleCall(socket, frame);
        });
      });
    });
  }

  private async handleCall(
    socket: WebSocket,
    frame: { action: string; params: Record<string, unknown>; echo: string },
  ): Promise<void> {
    this.calls.push({ action: frame.action, params: frame.params });
    if (this.options.apiDelayMs) {
      await new Promise((r) => setTimeout(r, this.options.apiDelayMs));
    }
    const shouldFail = this.options.failActions?.includes(frame.action) ?? false;

    if (frame.action === 'get_login_info') {
      socket.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: { user_id: 10000, nickname: '鲸鱼酱' },
          echo: frame.echo,
        }),
      );
      return;
    }

    // get_msg：按 message_id 返回预置的历史消息（用于测试引用补全）
    if (frame.action === 'get_msg') {
      const id = Number(frame.params['message_id']);
      const preset = this.messageStore.get(id);
      if (!preset) {
        socket.send(
          JSON.stringify({ status: 'failed', retcode: 100, data: null, echo: frame.echo }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: preset,
          echo: frame.echo,
        }),
      );
      return;
    }
    if (shouldFail) {
      socket.send(
        JSON.stringify({ status: 'failed', retcode: 100, data: null, echo: frame.echo }),
      );
      return;
    }
    socket.send(
      JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: { message_id: Math.floor(Math.random() * 1e6) },
        echo: frame.echo,
      }),
    );
  }

  /** 向机器人推送一个事件。 */
  push(event: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('机器人尚未连接');
    }
    this.socket.send(JSON.stringify({ self_id: 10000, time: Math.floor(Date.now() / 1000), ...event }));
  }

  /** 构造一条群消息事件的便捷方法。 */
  pushGroupMessage(options: {
    messageId: number;
    groupId: number;
    userId: number;
    nickname: string;
    text: string;
    atBot?: boolean;
    imageUrl?: string;
    /**
     * 额外消息段，用于构造卡片（json/xml）这类特殊消息。
     * 传了就完全替代默认的 text 段，便于精确控制测试输入。
     */
    segments?: Array<{ type: string; data: Record<string, unknown> }>;
  }): void {
    let message: Array<{ type: string; data: Record<string, unknown> }>;
    if (options.segments) {
      message = options.segments;
    } else {
      message = [];
      if (options.atBot) message.push({ type: 'at', data: { qq: '10000' } });
      if (options.text) message.push({ type: 'text', data: { text: options.text } });
      if (options.imageUrl) message.push({ type: 'image', data: { file: 'x.jpg', url: options.imageUrl } });
    }

    this.push({
      post_type: 'message',
      message_type: 'group',
      message_id: options.messageId,
      group_id: options.groupId,
      user_id: options.userId,
      message,
      raw_message: options.text,
      sender: { user_id: options.userId, nickname: options.nickname },
    });
  }

  /** 等待机器人建立连接。 */
  async waitForConnection(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.socket && this.socket.readyState === this.socket.OPEN) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('等待机器人连接超时');
  }

  /** 等待机器人发送指定数量的 send_* 调用。 */
  async waitForSends(count: number, timeoutMs = 5_000): Promise<RecordedCall[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sends = this.calls.filter((c) => c.action.startsWith('send_'));
      if (sends.length >= count) return sends;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `等待 ${count} 条发送超时，实际 ${this.calls.filter((c) => c.action.startsWith('send_')).length} 条`,
    );
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
    this.socket = null;
  }

  get actualPort(): number {
    return this.port;
  }
}

/* 直接运行时的手工联调入口 */
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/fake-onebot/server.ts');
if (isMain) {
  const port = Number(process.env.FAKE_PORT ?? 3101);
  const server = new FakeOneBotServer({ port });
  await server.start();
  console.log(`[fake-onebot] 监听 ws://127.0.0.1:${port}（等待机器人连接）`);
  let seq = 1;
  console.log('[fake-onebot] 按回车推送一条 @机器人 的群消息，输入 q 退出');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    const line = chunk.trim();
    if (line === 'q') {
      await server.stop();
      process.exit(0);
    }
    try {
      server.pushGroupMessage({
        messageId: seq++,
        groupId: 123456789,
        userId: 1001,
        nickname: '小明',
        text: '在吗，今天天气怎么样',
        atBot: true,
      });
      console.log('[fake-onebot] 已推送群消息');
    } catch (error) {
      console.log(`[fake-onebot] 推送失败：${(error as Error).message}`);
    }
  });
}
