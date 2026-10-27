/**
 * 端到端集成测试：
 *   假 OneBot 服务端 ←WebSocket→ OneBotClient → 适配器 → 管线 → 假 LLM HTTP 服务
 *
 * 覆盖：连接、@ 触发、去重、防自激、冷却、上下文拼接、发送格式、断线重连前的容错。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeOneBotServer } from './fake-onebot/server.js';
import { OneBotClient } from '../src/adapters/onebot/client.js';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.js';
import { MessagePipeline } from '../src/core/pipeline.js';
import { MemoryStore } from '../src/core/memory.js';
import { PersonaStore, FALLBACK_PERSONA } from '../src/core/persona.js';
import { LlmClient } from '../src/core/llm.js';
import { createLogger } from '../src/core/logger.js';
import type { AppConfig } from '../src/config.js';

const logger = createLogger('e2e');

interface CapturedRequest {
  body: { model: string; messages: Array<{ role: string; content: string }> };
}

function startFakeLlm(reply = '我这挺好的呀'): Promise<{ server: Server; port: number; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? (addr.port as number) : 0;
      resolve({ server, port, requests });
    });
  });
}

function mkConfig(llmPort: number, overrides: Partial<AppConfig['trigger']> = {}): AppConfig {
  return {
    llm: {
      baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 5_000,
      temperature: 0.9,
      maxTokens: 256,
      maxRetries: 0,
      retryBaseDelayMs: 10,
    },
    onebot: {
      wsUrl: '',
      accessToken: '',
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
    },
    bot: {
      selfId: '10000',
      typingDelayMaxMs: 0,
      maxMessageChars: 1500,
      stickerCooldownMs: 0,
      stickerRate: 1,
    },
    trigger: {
      requireAtInGroup: true,
      groupCooldownMs: 0,
      ...overrides,
    },
    interject: {
      enabled: false,
      scope: 'allowlist',
      allowGroups: [],
      minMessages: 8,
      maxWaitMs: 180_000,
      cooldownMs: 600_000,
      maxPerHour: 4,
      rate: 1,
    },
    context: { maxHistoryMessages: 20, historyWindowMinutes: 120, maxContextChars: 4000 },
    vision: { enabled: false, maxImages: 2 },
    dataDir: '',
    personaFile: '',
    logLevel: 'error',
  };
}

let dataDir: string;
let fakeOneBot: FakeOneBotServer;
let fakeLlm: { server: Server; port: number; requests: CapturedRequest[] };
let client: OneBotClient;
let store: MemoryStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wc-e2e-'));
  store = new MemoryStore(dataDir, logger);
});

afterEach(async () => {
  client?.stop();
  await fakeOneBot?.stop();
  await new Promise<void>((r) => (fakeLlm ? fakeLlm.server.close(() => r()) : r()));
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function setup(config: AppConfig, reply = '我这挺好的呀') {
  fakeLlm = await startFakeLlm(reply);
  config.llm.baseUrl = `http://127.0.0.1:${fakeLlm.port}/v1`;

  fakeOneBot = new FakeOneBotServer({ port: 0 });
  const port = await fakeOneBot.start();
  config.onebot.wsUrl = `ws://127.0.0.1:${port}`;

  client = new OneBotClient({
    wsUrl: config.onebot.wsUrl,
    accessToken: '',
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    logger,
  });

  const adapter = new OneBotAdapter({ client, logger, selfId: config.bot.selfId });
  const llm = new LlmClient(config.llm, logger);
  const personas = {
    get: () => FALLBACK_PERSONA,
  } as unknown as PersonaStore;

  const pipeline = new MessagePipeline({
    config,
    adapter,
    llm,
    store,
    personas,
    logger,
    botName: FALLBACK_PERSONA.name,
  });

  client.onEvent = (event) => {
    void (async () => { const internal = await adapter.handleEvent(event); if (internal) await pipeline.handle(internal); })();
  };

  const ready = new Promise<void>((resolve) => {
    client.onConnected = () => resolve();
  });
  client.start();
  await ready;

  return { pipeline, adapter };
}

describe('端到端链路', () => {
  it('收到 @ 群消息后调用模型并发送群消息', async () => {
    const { pipeline } = await setup(mkConfig(0));

    fakeOneBot.pushGroupMessage({
      messageId: 1,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '在吗',
      atBot: true,
    });

    const sends = await fakeOneBot.waitForSends(1);
    expect(sends[0]?.action).toBe('send_group_msg');
    expect(sends[0]?.params['group_id']).toBe(777);
    expect(JSON.stringify(sends[0]?.params['message'])).toContain('我这挺好的呀');

    // 送给模型的提示词里应包含人设；当前消息出现在「需要你回应的消息」段落，不重复进历史
    const req = fakeLlm.requests[0];
    expect(req?.body.model).toBe('test-model');
    expect(req?.body.messages[0]?.role).toBe('system');
    expect(req?.body.messages[0]?.content).toContain(FALLBACK_PERSONA.name);
    expect(req?.body.messages[1]?.content).toContain('【需要你回应的消息】\n小明: 在吗');
    expect(pipeline.getStats().replied).toBe(1);
  });

  it('未 @ 的群消息不触发模型调用', async () => {
    await setup(mkConfig(0));
    fakeOneBot.pushGroupMessage({
      messageId: 2,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '随便聊聊',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(fakeOneBot.calls.filter((c) => c.action.startsWith('send_'))).toHaveLength(0);
    expect(fakeLlm.requests).toHaveLength(0);
  });

  it('平台重复推送同一 message_id 只回复一次', async () => {
    await setup(mkConfig(0));
    const push = () =>
      fakeOneBot.pushGroupMessage({
        messageId: 3,
        groupId: 777,
        userId: 1001,
        nickname: '小明',
        text: '重复消息',
        atBot: true,
      });
    push();
    push();
    const sends = await fakeOneBot.waitForSends(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(fakeOneBot.calls.filter((c) => c.action.startsWith('send_'))).toHaveLength(sends.length);
    expect(fakeLlm.requests).toHaveLength(1);
  });

  it('机器人自己的消息不会触发回复（防自激）', async () => {
    await setup(mkConfig(0));
    fakeOneBot.push({
      post_type: 'message',
      message_type: 'group',
      message_id: 4,
      group_id: 777,
      user_id: 10000,
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '我自己' } }],
      raw_message: '我自己',
      sender: { user_id: 10000, nickname: '鲸鱼酱' },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(fakeOneBot.calls.filter((c) => c.action.startsWith('send_'))).toHaveLength(0);
  });

  it('私聊直接回复', async () => {
    await setup(mkConfig(0));
    fakeOneBot.push({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 5,
      user_id: 1001,
      message: [{ type: 'text', data: { text: '你好' } }],
      raw_message: '你好',
      sender: { user_id: 1001, nickname: '小明' },
    });
    const sends = await fakeOneBot.waitForSends(1);
    expect(sends[0]?.action).toBe('send_private_msg');
    expect(sends[0]?.params['user_id']).toBe(1001);
  });

  it('上下文中包含之前的对话', async () => {
    await setup(mkConfig(0));
    fakeOneBot.pushGroupMessage({
      messageId: 6,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '今天好热',
    });
    await new Promise((r) => setTimeout(r, 200));
    fakeOneBot.pushGroupMessage({
      messageId: 7,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '你说是不是',
      atBot: true,
    });
    await fakeOneBot.waitForSends(1);
    const userPrompt = fakeLlm.requests[0]?.body.messages[1]?.content ?? '';
    // 前一条未 @ 的闲聊应作为背景出现在历史里；当前这条只在「需要你回应」段出现
    expect(userPrompt).toContain('小明: 今天好热');
    expect(userPrompt).toContain('【需要你回应的消息】\n小明: 你说是不是');
  });

  it('冷却期内同一群的第二条 @ 不再回复', async () => {
    await setup(mkConfig(0, { groupCooldownMs: 60_000 }));
    fakeOneBot.pushGroupMessage({
      messageId: 8,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '第一句',
      atBot: true,
    });
    await fakeOneBot.waitForSends(1);
    fakeOneBot.pushGroupMessage({
      messageId: 9,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '第二句',
      atBot: true,
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(fakeOneBot.calls.filter((c) => c.action.startsWith('send_'))).toHaveLength(1);
  });

  it('模型服务异常时发送兜底话术而不是崩溃', async () => {
    const config = mkConfig(0);
    config.llm.baseUrl = 'http://127.0.0.1:1/v1'; // 必定连接失败
    fakeOneBot = new FakeOneBotServer({ port: 0 });
    const port = await fakeOneBot.start();
    config.onebot.wsUrl = `ws://127.0.0.1:${port}`;

    client = new OneBotClient({
      wsUrl: config.onebot.wsUrl,
      accessToken: '',
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
      logger,
    });
    const adapter = new OneBotAdapter({ client, logger, selfId: '10000' });
    const pipeline = new MessagePipeline({
      config,
      adapter,
      llm: new LlmClient(config.llm, logger),
      store,
      personas: { get: () => FALLBACK_PERSONA } as unknown as PersonaStore,
      logger,
      botName: '鲸鱼酱',
    });
    client.onEvent = (e) => {
      void (async () => { const internal = await adapter.handleEvent(e); if (internal) await pipeline.handle(internal); })();
    };
    await new Promise<void>((resolve) => {
      client.onConnected = () => resolve();
      client.start();
    });

    fakeOneBot.pushGroupMessage({
      messageId: 10,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '在吗',
      atBot: true,
    });
    const sends = await fakeOneBot.waitForSends(1);
    expect(JSON.stringify(sends[0]?.params['message'])).toContain('卡了一下');
    expect(pipeline.getStats().failed).toBe(1);
  });

  it('OneBot 拒绝发送时管线记录失败而不抛到进程', async () => {
    fakeLlm = await startFakeLlm();
    fakeOneBot = new FakeOneBotServer({ port: 0, failActions: ['send_group_msg'] });
    const port = await fakeOneBot.start();
    const config = mkConfig(0);
    config.llm.baseUrl = `http://127.0.0.1:${fakeLlm.port}/v1`;
    config.onebot.wsUrl = `ws://127.0.0.1:${port}`;

    client = new OneBotClient({
      wsUrl: config.onebot.wsUrl,
      accessToken: '',
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
      logger,
    });
    const adapter = new OneBotAdapter({ client, logger, selfId: '10000' });
    const pipeline = new MessagePipeline({
      config,
      adapter,
      llm: new LlmClient(config.llm, logger),
      store,
      personas: { get: () => FALLBACK_PERSONA } as unknown as PersonaStore,
      logger,
      botName: '鲸鱼酱',
    });
    client.onEvent = (e) => {
      void (async () => { const internal = await adapter.handleEvent(e); if (internal) await pipeline.handle(internal); })();
    };
    await new Promise<void>((resolve) => {
      client.onConnected = () => resolve();
      client.start();
    });

    fakeOneBot.pushGroupMessage({
      messageId: 11,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '在吗',
      atBot: true,
    });
    await new Promise((r) => setTimeout(r, 600));
    // 发送调用确实发生了、但被服务端标记 failed；管线不应因此抛出
    expect(fakeOneBot.calls.some((c) => c.action === 'send_group_msg')).toBe(true);
    expect(pipeline.getStats().replied).toBe(0);
  });
});
