/**
 * 多模态（图片识别）测试。
 *
 * 覆盖：
 *   - 有图时 user 消息变成多模态内容块
 *   - 无图时保持纯文本，不引入多余结构
 *   - 图片下载失败时优雅降级为纯文本
 *   - VISION_ENABLED=false 时完全不下载图片
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { FakeOneBotServer } from './fake-onebot/server.js';
import { OneBotClient } from '../src/adapters/onebot/client.js';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.js';
import { MessagePipeline } from '../src/core/pipeline.js';
import { MemoryStore } from '../src/core/memory.js';
import { PersonaStore, FALLBACK_PERSONA } from '../src/core/persona.js';
import { LlmClient } from '../src/core/llm.js';
import { createLogger } from '../src/core/logger.js';
import type { AppConfig } from '../src/config.js';

const logger = createLogger('vision-e2e');

let dataDir: string;
let fakeOneBot: FakeOneBotServer;
let llmServer: Server | null = null;
let imgServer: Server | null = null;
let client: OneBotClient;
let store: MemoryStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wc-vision-'));
  store = new MemoryStore(dataDir, logger);
});

afterEach(async () => {
  client?.stop();
  await fakeOneBot?.stop();
  if (llmServer) await new Promise<void>((r) => llmServer?.close(() => r()));
  if (imgServer) await new Promise<void>((r) => imgServer?.close(() => r()));
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 启动一个会记录请求体的假 LLM。 */
function startLlm(): Promise<{ port: number; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '我看到图了，挺可爱的' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? (addr.port as number) : 0;
      llmServer = server;
      resolve({ port, bodies });
    });
  });
}

/** 启动一个提供真实 JPEG 的假图片服务器。 */
async function startImageServer(): Promise<{ port: number; hits: () => number }> {
  let count = 0;
  const jpeg = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .jpeg()
    .toBuffer();

  const server = createServer((_req, res) => {
    count++;
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
    res.end(jpeg);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? (addr.port as number) : 0;
      imgServer = server;
      resolve({ port, hits: () => count });
    });
  });
}

function mkConfig(llmPort: number, visionEnabled: boolean): AppConfig {
  return {
    llm: {
      baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      apiKey: 'k',
      model: 'm',
      timeoutMs: 5000,
      temperature: 0.9,
      maxTokens: 512,
      maxRetries: 0,
      retryBaseDelayMs: 10,
    },
    onebot: { wsUrl: '', accessToken: '', reconnectMinMs: 50, reconnectMaxMs: 200 },
    bot: {
      selfId: '10000',
      typingDelayMaxMs: 0,
      maxMessageChars: 1500,
      stickerCooldownMs: 0,
      stickerRate: 1,
    },
    trigger: { requireAtInGroup: true, groupCooldownMs: 0 },
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
    vision: { enabled: visionEnabled, maxImages: 2 },
    dataDir,
    personaFile: '',
    logLevel: 'error',
  };
}

async function setup(llmPort: number, wsPort: number, visionEnabled: boolean) {
  const cfg = mkConfig(llmPort, visionEnabled);
  cfg.onebot.wsUrl = `ws://127.0.0.1:${wsPort}`;

  client = new OneBotClient({
    wsUrl: cfg.onebot.wsUrl,
    accessToken: '',
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    logger,
  });
  const adapter = new OneBotAdapter({ client, logger, selfId: '10000' });
  const pipeline = new MessagePipeline({
    config: cfg,
    adapter,
    llm: new LlmClient(cfg.llm, logger),
    store,
    personas: { get: () => FALLBACK_PERSONA } as unknown as PersonaStore,
    logger,
    botName: '鲸鱼酱',
    stickers: null,
    stickerRate: 1,
  });
  client.onEvent = (e) => {
    void (async () => { const internal = await adapter.handleEvent(e); if (internal) await pipeline.handle(internal); })();
  };
  await new Promise<void>((r) => {
    client.onConnected = () => r();
    client.start();
  });
  return { pipeline };
}

describe('多模态图片识别', () => {
  it('消息带图时，user 消息变成多模态内容块', async () => {
    const llm = await startLlm();
    const img = await startImageServer();
    fakeOneBot = new FakeOneBotServer({ port: 0 });
    const wsPort = await fakeOneBot.start();
    await setup(llm.port, wsPort, true);

    fakeOneBot.pushGroupMessage({
      messageId: 1,
      groupId: 1,
      userId: 1001,
      nickname: '小明',
      text: '看这个',
      atBot: true,
      imageUrl: `http://127.0.0.1:${img.port}/a.jpg`,
    });

    await fakeOneBot.waitForSends(1, 8000);
    const body = llm.bodies[0] as { messages: Array<{ role: string; content: unknown }> };
    const user = body.messages[1] as { content: Array<{ type: string; image_url?: { url: string } }> };
    expect(Array.isArray(user.content)).toBe(true);
    const imageParts = user.content.filter((p) => p.type === 'image_url');
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(img.hits()).toBeGreaterThan(0);
  });

  it('无图消息保持纯文本结构', async () => {
    const llm = await startLlm();
    fakeOneBot = new FakeOneBotServer({ port: 0 });
    const wsPort = await fakeOneBot.start();
    await setup(llm.port, wsPort, true);

    fakeOneBot.pushGroupMessage({
      messageId: 2,
      groupId: 1,
      userId: 1001,
      nickname: '小明',
      text: '没有图',
      atBot: true,
    });

    await fakeOneBot.waitForSends(1, 8000);
    const body = llm.bodies[0] as { messages: Array<{ content: unknown }> };
    expect(typeof body.messages[1]?.content).toBe('string');
  });

  it('开关关闭时完全不去下载图片', async () => {
    const llm = await startLlm();
    const img = await startImageServer();
    fakeOneBot = new FakeOneBotServer({ port: 0 });
    const wsPort = await fakeOneBot.start();
    await setup(llm.port, wsPort, false);

    fakeOneBot.pushGroupMessage({
      messageId: 3,
      groupId: 1,
      userId: 1001,
      nickname: '小明',
      text: '看图',
      atBot: true,
      imageUrl: `http://127.0.0.1:${img.port}/a.jpg`,
    });

    await fakeOneBot.waitForSends(1, 8000);
    expect(img.hits()).toBe(0);
    const body = llm.bodies[0] as { messages: Array<{ content: unknown }> };
    expect(typeof body.messages[1]?.content).toBe('string');
  });

  it('图片地址不可达时降级为纯文本，不影响回复', async () => {
    const llm = await startLlm();
    fakeOneBot = new FakeOneBotServer({ port: 0 });
    const wsPort = await fakeOneBot.start();
    await setup(llm.port, wsPort, true);

    fakeOneBot.pushGroupMessage({
      messageId: 4,
      groupId: 1,
      userId: 1001,
      nickname: '小明',
      text: '坏图',
      atBot: true,
      imageUrl: 'http://127.0.0.1:1/nope.jpg',
    });

    const sends = await fakeOneBot.waitForSends(1, 8000);
    // 仍然正常回复
    expect(JSON.stringify(sends[0]?.params['message'])).toContain('我看到图了');
    const body = llm.bodies[0] as { messages: Array<{ content: unknown }> };
    expect(typeof body.messages[1]?.content).toBe('string');
  });
});
