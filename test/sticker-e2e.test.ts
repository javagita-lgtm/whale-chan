/**
 * 表情包链路测试。
 *
 * 重点覆盖真实踩过的坑：
 *   - NapCat 收到相对路径的 file 字段会返回 retcode=1200，
 *     适配器必须把路径转成绝对路径再发。
 *   - 模型选择的编号必须真实存在才发图，否则静默跳过。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FakeOneBotServer } from './fake-onebot/server.js';
import { OneBotClient } from '../src/adapters/onebot/client.js';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.js';
import { MessagePipeline } from '../src/core/pipeline.js';
import { MemoryStore } from '../src/core/memory.js';
import { PersonaStore, FALLBACK_PERSONA } from '../src/core/persona.js';
import { LlmClient } from '../src/core/llm.js';
import { StickerIndex } from '../src/core/stickers.js';
import { createLogger } from '../src/core/logger.js';
import type { AppConfig } from '../src/config.js';

const logger = createLogger('sticker-e2e');

let dataDir: string;
let fakeOneBot: FakeOneBotServer;
let llmServer: Server | null = null;
let client: OneBotClient;
let store: MemoryStore;
let stickerDb: DatabaseSync;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wc-sticker-'));
  store = new MemoryStore(dataDir, logger);
  stickerDb = new DatabaseSync(join(dataDir, 'whale-chan.sqlite'));
  stickerDb.exec(`CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY, title TEXT, file TEXT, source TEXT, enabled INTEGER, created_at INTEGER);
                  CREATE TABLE IF NOT EXISTS sticker_gram (g TEXT, sticker_id TEXT);
                  CREATE INDEX IF NOT EXISTS idx_gram ON sticker_gram (g);`);
});

afterEach(async () => {
  client?.stop();
  await fakeOneBot?.stop();
  if (llmServer) await new Promise<void>((r) => llmServer?.close(() => r()));
  stickerDb?.close();
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 轮询等待条件成立。用于等异步副作用（如统计累加），避免固定 sleep 或过早断言。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function seedStickers(): StickerIndex {
  const ins = stickerDb.prepare(
    'INSERT INTO stickers (id,title,file,source,enabled,created_at) VALUES (?,?,?,?,1,?)',
  );
  // 故意存相对路径，验证适配器会转绝对
  ins.run('029', 'DeepSeek鲸娘『死掉了』累到宕机表情包', 'data/stickers/jpg/029.jpg', 'test', Date.now());
  ins.run('077', 'DeepSeek娘『没吃饱喵委屈』表情包', 'data/stickers/jpg/077.jpg', 'test', Date.now());
  return new StickerIndex(stickerDb);
}

/** 假 LLM：按固定内容回复，用于控制模型是否输出 sticker 指令。 */
function startLlm(content: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? (addr.port as number) : 0;
      llmServer = server;
      resolveP({ server, port });
    });
  });
}

function mkConfig(port: number): AppConfig {
  return {
    llm: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
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
    vision: { enabled: false, maxImages: 2 },
    dataDir,
    personaFile: '',
    logLevel: 'error',
  };
}

async function setup(llmContent: string, stickers: StickerIndex | null) {
  const llm = await startLlm(llmContent);
  const cfg = mkConfig(llm.port);

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
    stickers,
    stickerRate: 1,
  });

  client.onEvent = (e) => {
    void (async () => { const internal = await adapter.handleEvent(e); if (internal) await pipeline.handle(internal); })();
  };
  await new Promise<void>((r) => {
    client.onConnected = () => r();
    client.start();
  });
  return { pipeline, adapter, cfg };
}

describe('表情包链路', () => {
  it('模型给出有效编号时发送图片，且路径转成绝对路径', async () => {
    const stickers = seedStickers();
    const { pipeline } = await setup('好累啊，我先躺了\n<!--sticker: 029-->', stickers);

    fakeOneBot.pushGroupMessage({
      messageId: 1,
      groupId: 999,
      userId: 1001,
      nickname: '小明',
      text: '今天好累',
      atBot: true,
    });

    // 等两条发送：先是文字，再是图片
    const sends = await fakeOneBot.waitForSends(2, 8000);
    const imageSend = sends.find((s) =>
      Array.isArray(s.params['message']) &&
      (s.params['message'] as Array<{ type: string }>).some((seg) => seg.type === 'image'),
    );
    expect(imageSend).toBeDefined();

    const seg = (imageSend?.params['message'] as Array<{ type: string; data: { file: string } }>)
      .find((s) => s.type === 'image');
    expect(seg).toBeDefined();
    // 关键断言：必须是绝对路径，否则 NapCat 会返回 retcode=1200
    expect(isAbsolute(seg?.data.file ?? '')).toBe(true);
    expect(seg?.data.file).toBe(resolve('data/stickers/jpg/029.jpg'));

    // 统计计数在发送完成之后才累加，属于异步竞态：
    // waitForSends 返回的那一刻 stats.stickers 可能还是 0，
    // 所以这里轮询等待，而不是直接断言（否则偶发失败）。
    await waitFor(() => pipeline.getStats().stickers === 1, 3000);
    expect(pipeline.getStats().stickers).toBe(1);
  });

  it('模型给出不存在的编号时不发图', async () => {
    const stickers = seedStickers();
    const { pipeline } = await setup('好的\n<!--sticker: 9999-->', stickers);

    fakeOneBot.pushGroupMessage({
      messageId: 2,
      groupId: 999,
      userId: 1001,
      nickname: '小明',
      text: '随便说点',
      atBot: true,
    });

    await fakeOneBot.waitForSends(1, 5000);
    await new Promise((r) => setTimeout(r, 500));
    expect(pipeline.getStats().stickers).toBe(0);
    const imageSends = fakeOneBot.calls.filter(
      (c) =>
        Array.isArray(c.params['message']) &&
        (c.params['message'] as Array<{ type: string }>).some((s) => s.type === 'image'),
    );
    expect(imageSends).toHaveLength(0);
  });

  it('模型没有给表述情包时不发图', async () => {
    const stickers = seedStickers();
    const { pipeline } = await setup('就是普通聊天', stickers);

    fakeOneBot.pushGroupMessage({
      messageId: 3,
      groupId: 999,
      userId: 1001,
      nickname: '小明',
      text: '你好',
      atBot: true,
    });
    await fakeOneBot.waitForSends(1, 5000);
    await new Promise((r) => setTimeout(r, 400));
    expect(pipeline.getStats().stickers).toBe(0);
  });

  it('图库为空时不发图也不报错', async () => {
    // 不塞任何数据
    const stickers = new StickerIndex(stickerDb);
    const { pipeline } = await setup('好累\n<!--sticker: 029-->', stickers);

    fakeOneBot.pushGroupMessage({
      messageId: 4,
      groupId: 999,
      userId: 1001,
      nickname: '小明',
      text: '今天好累',
      atBot: true,
    });
    await fakeOneBot.waitForSends(1, 5000);
    await new Promise((r) => setTimeout(r, 400));
    expect(pipeline.getStats().stickers).toBe(0);
  });

  it('表情包注释不会污染文字回复', async () => {
    const stickers = seedStickers();
    await setup('好累啊，我先躺了\n<!--sticker: 029-->', stickers);

    fakeOneBot.pushGroupMessage({
      messageId: 5,
      groupId: 999,
      userId: 1001,
      nickname: '小明',
      text: '今天好累',
      atBot: true,
    });
    const sends = await fakeOneBot.waitForSends(2, 8000);
    const textSend = sends.find((s) =>
      Array.isArray(s.params['message']) &&
      (s.params['message'] as Array<{ type: string }>).every((seg) => seg.type === 'text'),
    );
    const text = (textSend?.params['message'] as Array<{ data: { text: string } }>)
      .map((s) => s.data.text)
      .join('');
    expect(text).toBe('好累啊，我先躺了');
    expect(text).not.toContain('sticker');
  });
});
