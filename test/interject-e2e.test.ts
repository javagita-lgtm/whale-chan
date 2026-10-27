/**
 * 主动插话端到端测试。
 *
 * 最关键的一条：**未达阈值前绝不能调模型**（这是成本控制的核心承诺）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
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

const logger = createLogger('interject-e2e');

let dataDir: string;
let fakeOneBot: FakeOneBotServer;
let llmServer: Server | null = null;
let client: OneBotClient;
let store: MemoryStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wc-ij-e2e-'));
  store = new MemoryStore(dataDir, logger);
});

afterEach(async () => {
  client?.stop();
  await fakeOneBot?.stop();
  if (llmServer) await new Promise<void>((r) => llmServer?.close(() => r()));
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * 假 LLM：按调用序号轮换回复。
 * 第一次调用（插话判断）返回 speak:true，第二次（生成回复）返回正文。
 */
function startLlm(judge: string, reply = '我也热得不行'): Promise<{ port: number; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      const msgs = body['messages'] as Array<{ content: unknown }>;
      const sys = String(msgs?.[0]?.content ?? '');
      // 插话判断请求的特征：system 里包含「要不要主动接一句话」
      const isJudge = sys.includes('主动接一句话');
      const content = isJudge ? judge : reply;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
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

function mkConfig(llmPort: number, opts: {
  enabled: boolean;
  minMessages: number;
  allowGroups?: string[];
  scope?: 'allowlist' | 'all';
}): AppConfig {
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
      enabled: opts.enabled,
      scope: opts.scope ?? 'allowlist',
      allowGroups: opts.allowGroups ?? ['777'],
      minMessages: opts.minMessages,
      maxWaitMs: 60_000,
      cooldownMs: 600_000,
      maxPerHour: 10,
      rate: 1,
    },
    context: { maxHistoryMessages: 20, historyWindowMinutes: 120, maxContextChars: 4000 },
    vision: { enabled: false, maxImages: 2 },
    dataDir,
    personaFile: '',
    logLevel: 'error',
  };
}

async function setup(cfg: AppConfig) {
  fakeOneBot = new FakeOneBotServer({ port: 0 });
  const port = await fakeOneBot.start();
  cfg.onebot.wsUrl = `ws://127.0.0.1:${port}`;

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

let msgSeq = 1;
function pushChat(peerId = 777, text = '聊天'): void {
  fakeOneBot.pushGroupMessage({
    messageId: msgSeq++,
    groupId: Number(peerId),
    userId: 1001,
    nickname: '小明',
    text,
  });
}

describe('主动插话端到端', () => {
  it('未达阈值时完全不调用模型', async () => {
    const llm = await startLlm('{"speak": true}');
    await setup(mkConfig(llm.port, { enabled: true, minMessages: 5 }));

    // 只推 3 条，未达阈值
    pushChat(777, '今天好热');
    pushChat(777, '是啊');
    pushChat(777, '快化了');
    await new Promise((r) => setTimeout(r, 800));

    expect(llm.bodies).toHaveLength(0);
    expect(fakeOneBot.calls.filter((c) => c.action.startsWith('send_'))).toHaveLength(0);
  });

  it('达到阈值且判断为要接时，发出消息', async () => {
    const llm = await startLlm('{"speak": true, "opener": "我也热死了"}', '我也热死了啊');
    await setup(mkConfig(llm.port, { enabled: true, minMessages: 3 }));

    pushChat(777, '今天好热');
    pushChat(777, '是啊');
    pushChat(777, '快化了');

    const sends = await fakeOneBot.waitForSends(1, 8000);
    expect(JSON.stringify(sends[0]?.params['message'])).toContain('我也热死了');
    // 两次调用：一次判断 + 一次生成
    expect(llm.bodies.length).toBeGreaterThanOrEqual(2);
  });

  it('判断为不接时不发消息', async () => {
    const llm = await startLlm('{"speak": false}');
    await setup(mkConfig(llm.port, { enabled: true, minMessages: 3 }));

    pushChat(777, '我到了');
    pushChat(777, '嗯');
    pushChat(777, '好');

    await new Promise((r) => setTimeout(r, 1200));
    expect(fakeOneBot.calls.filter((c) => c.action.startsWith('send_'))).toHaveLength(0);
    // 只调了判断，没有生成回复
    expect(llm.bodies).toHaveLength(1);
  });

  it('全局关闭时连观察都不做', async () => {
    const llm = await startLlm('{"speak": true}');
    await setup(mkConfig(llm.port, { enabled: false, minMessages: 2 }));

    for (let i = 0; i < 5; i++) pushChat(777, `消息${i}`);
    await new Promise((r) => setTimeout(r, 800));

    expect(llm.bodies).toHaveLength(0);
  });

  it('不在白名单的群不插话', async () => {
    const llm = await startLlm('{"speak": true}');
    await setup(mkConfig(llm.port, { enabled: true, minMessages: 2, allowGroups: ['777'] }));

    // 群 888 不在白名单
    for (let i = 0; i < 5; i++) pushChat(888, `消息${i}`);
    await new Promise((r) => setTimeout(r, 800));

    expect(llm.bodies).toHaveLength(0);
  });

  it('@ 机器人时走正常回复，不触发插话判断', async () => {
    const llm = await startLlm('{"speak": true}');
    await setup(mkConfig(llm.port, { enabled: true, minMessages: 2 }));

    fakeOneBot.pushGroupMessage({
      messageId: msgSeq++,
      groupId: 777,
      userId: 1001,
      nickname: '小明',
      text: '在吗',
      atBot: true,
    });

    const sends = await fakeOneBot.waitForSends(1, 8000);
    expect(JSON.stringify(sends[0]?.params['message'])).toContain('热');
    // 只有一次生成调用，没有判断调用
    const judgeCalls = llm.bodies.filter((b) => {
      const msgs = b['messages'] as Array<{ content: unknown }>;
      return String(msgs?.[0]?.content ?? '').includes('主动接一句话');
    });
    expect(judgeCalls).toHaveLength(0);
  });
});
