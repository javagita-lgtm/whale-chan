/**
 * Whale-chan 入口。
 *
 * 装配顺序：配置 → 日志 → 存储 → 人设 → LLM → OneBot 客户端 → 适配器 → 管线。
 * 进程收到 SIGINT/SIGTERM 时优雅退出。
 */

import { loadConfig } from './config.js';
import { createLogger, setLogLevel } from './core/logger.js';
import { MemoryStore } from './core/memory.js';
import { PersonaStore } from './core/persona.js';
import { LlmClient } from './core/llm.js';
import { MessagePipeline } from './core/pipeline.js';
import { StickerIndex } from './core/stickers.js';
import { WebTools } from './core/web.js';
import { BilibiliClient } from './core/bilibili.js';
import { BiliMedia } from './core/media.js';
import { ComfyClient } from './core/comfy.js';
import { ImageGenerator } from './core/image-gen.js';
import { TtsClient } from './core/tts.js';
import { MusicClient } from './core/music.js';
import { Singer, loadSongLibrary } from './core/singer.js';
import { SingJobQueue } from './core/sing-queue.js';
import { GeminiPainter } from './core/gemini.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { OneBotClient } from './adapters/onebot/client.js';
import { OneBotAdapter } from './adapters/onebot/adapter.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const logger = createLogger('main');

  const llmReady = config.llm.apiKey.trim().length > 0;
  logger.info(`Whale-chan v${VERSION} 启动`, {
    llm: llmReady ? '已配置' : '未配置（离线模式）',
    model: config.llm.model,
    ws: config.onebot.wsUrl,
  });

  const store = new MemoryStore(config.dataDir, createLogger('memory'));
  const personas = new PersonaStore(config.personaFile, createLogger('persona'));
  const llm = new LlmClient(config.llm, createLogger('llm'));

  // 表情包索引：与记忆共用同一个 SQLite 文件
  const stickerDb = new DatabaseSync(join(config.dataDir, 'whale-chan.sqlite'));
  const stickers = new StickerIndex(stickerDb);
  const stickerCount = stickers.count();
  if (stickerCount > 0) {
    logger.info('表情包图库已加载', { count: stickerCount });
  } else {
    logger.warn('表情包图库为空，请先运行 pnpm stickers:fetch');
  }

  // 链接阅读与联网搜索：复用模型接口的 Key（DeepSeek 的 Search/Fetch 归同一账号）
  const web = new WebTools({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl.replace(/\/v1\/?$/, ''),
    timeoutMs: config.web.timeoutMs,
    logger: createLogger('web'),
  });
  if (config.web.linkEnabled || config.web.searchEnabled) {
    logger.info('网页能力已启用', {
      读链接: config.web.linkEnabled,
      联网搜索: config.web.searchEnabled,
    });
  }

  // B 站视频理解：走弹幕+评论通道（匿名可用，不需要登录）
  const bili = new BilibiliClient({
    logger: createLogger('bili'),
    timeoutMs: config.web.timeoutMs,
    maxDanmaku: config.web.biliMaxDanmaku,
    maxComments: config.web.biliMaxComments,
  });
  if (config.web.biliEnabled) {
    logger.info('B站视频理解已启用', {
      弹幕上限: config.web.biliMaxDanmaku,
      评论上限: config.web.biliMaxComments,
    });
  }

  // B 站深读：抽帧看画面 + 本地 whisper 转写台词
  const media = new BiliMedia({
    logger: createLogger('media'),
    ffmpegPath: config.web.ffmpegPath,
    pythonPath: config.web.biliAsrPython,
    transcribeScript: config.web.biliAsrScript,
    asrModel: config.web.biliAsrModel,
    timeoutMs: config.web.timeoutMs,
  });
  if (config.web.biliDeepRead) {
    logger.info('B站深读已启用', {
      抽帧: media.ffmpegAvailable,
      转写: media.asrAvailable,
      转写模型: config.web.biliAsrModel,
    });
  }

  // 本地生图（ComfyUI）
  const comfy = new ComfyClient({
    baseUrl: config.imageGen.baseUrl,
    outputDir: config.imageGen.outputDir,
    defaultCheckpoint: config.imageGen.checkpoint,
    logger: createLogger('comfy'),
  });
  // Gemini 生图（可选）：走本地适配层，云端算力，显存 ~0，且无可见水印
  const gemini = config.imageGen.gemini.enabled
    ? new GeminiPainter({
        logger: createLogger('gemini'),
        baseUrl: config.imageGen.gemini.baseUrl,
        timeoutMs: config.imageGen.gemini.timeoutMs,
        enabled: true,
      })
    : null;

  const imageGen = new ImageGenerator({
    logger: createLogger('image'),
    llm,
    comfy,
    enabled: config.imageGen.enabled,
    blockNsfw: config.imageGen.blockNsfw,
    timeoutMs: config.imageGen.timeoutMs,
    gemini,
    prefer: config.imageGen.prefer,
  });

  if (gemini) {
    void gemini
      .ping()
      .then((online) => {
        if (online) {
          logger.info('Gemini 生图已就绪（云端算力，显存 ~0，无可见水印）', {
            适配层: config.imageGen.gemini.baseUrl,
          });
        } else {
          logger.warn('Gemini 生图不可用：适配层没起来或没有 cookie', {
            适配层: config.imageGen.gemini.baseUrl,
            提示: '先跑 scripts/gemini_server.py',
          });
        }
      })
      .catch(() => {
        logger.warn('Gemini 生图探活失败');
      });
  }

  // 本地语音合成（Style-Bert-VITS2 + RikkaBotan 中文萌系音色）
  const tts = new TtsClient({
    baseUrl: config.tts.baseUrl,
    timeoutMs: config.tts.timeoutMs,
    logger: createLogger('tts'),
  });
  if (config.tts.enabled) {
    void tts
      .ping()
      .then((online) => {
        if (online) logger.info('语音合成服务已就绪', { url: config.tts.baseUrl, 音色: 'RikkaBotan 中文萌系' });
        else logger.warn('语音合成服务未响应（TTS 服务未启动）', { url: config.tts.baseUrl });
      })
      .catch(() => {
        logger.warn('语音合成服务探活失败', { url: config.tts.baseUrl });
      });
  }

  // 唱歌（预置曲库 + SVC 实时生成）
  const music = new MusicClient({ logger: createLogger('music') });
  const songs = loadSongLibrary(join(process.cwd(), config.sing.libraryFile));
  const singer = new Singer({
    logger: createLogger('singer'),
    music,
    songs,
    enabled: config.sing.enabled,
    workDir: join(process.cwd(), 'data', 'songs'),
    defaultVoice: config.sing.defaultVoice,
  });
  if (config.sing.enabled) {
    logger.info('唱歌功能已启用', {
      曲库: songs.length,
      默认音色: config.sing.defaultVoice,
      曲目: songs.map((s) => s.title).join('、') || '（空）',
    });
  }

  if (config.imageGen.enabled) {
    // 启动时的探活是「尽力而为」：ComfyUI 由 watchdog 单独拉起，
    // 通常比机器人晚 2~3 分钟。所以探活失败是正常的，
    // 但之前 .then 没有 .catch，异常会被静默吞掉，
    // 日志里什么都没有，容易误判成"生图没启用"。
    void comfy
      .ping()
      .then((online) => {
        if (online) {
          logger.info('生图服务已就绪', {
            url: config.imageGen.baseUrl,
            模型: config.imageGen.checkpoint,
          });
        } else {
          logger.debug('生图服务暂未响应（ComfyUI 可能还在启动），调用时会重试', {
            url: config.imageGen.baseUrl,
          });
        }
      })
      .catch((error: unknown) => {
        logger.debug('生图服务探活失败', {
          message: (error as Error).message.slice(0, 100),
        });
      });

    // 闲置自动卸载显存：模型常驻要占 3.3GB，长期没人画图就还给显卡。
    // 只调 /free 卸载模型，不动服务进程——下次出图重新加载（多 2~3 秒）。
    const idleMin = config.imageGen.idleUnloadMinutes;
    if (idleMin > 0) {
      let lastActivity = Date.now();
      const timer = setInterval(() => {
        const idleMs = Date.now() - lastActivity;
        if (imageGen.isBusy) {
          lastActivity = Date.now();
          return;
        }
        if (idleMs > idleMin * 60_000) {
          void comfy.free(true).then((ok) => {
            if (ok) logger.info('闲置超时，已释放生图显存', { idleMinutes: idleMin });
          });
          // 重置计时，避免每轮都发一次
          lastActivity = Date.now();
        }
      }, 60_000);
      timer.unref();
    }
  }

  const client = new OneBotClient({
    wsUrl: config.onebot.wsUrl,
    accessToken: config.onebot.accessToken,
    reconnectMinMs: config.onebot.reconnectMinMs,
    reconnectMaxMs: config.onebot.reconnectMaxMs,
    logger: createLogger('onebot'),
  });

  const adapter = new OneBotAdapter({
    client,
    logger: createLogger('onebot'),
    selfId: config.bot.selfId,
  });

  // 唱歌任务队列（SVC 生成要几分钟，必须异步）
  const singWorkDir = join(process.cwd(), 'data', 'songs');
  const jobs = new SingJobQueue({
    logger: createLogger('sing-queue'),
    music,
    adapter,
    workDir: singWorkDir,
    pythonPath: 'E:\\svc-venv\\Scripts\\python.exe',
    scriptPath: join(process.cwd(), 'scripts', 'make_cover.py'),
    clipSeconds: config.sing.clipSeconds,
    fullSeconds: config.sing.maxSeconds,
    saveToLibrary: config.sing.saveToLibrary,
    libraryFile: join(process.cwd(), config.sing.libraryFile),
    afterword: async (job) => {
      // 生成完也打招呼（和曲库直接发保持一致的体验）
      if (!config.sing.afterword) return;
      await new Promise((r) => setTimeout(r, 1200));
      const pool =
        job.mode === 'original'
          ? ['原唱放完了～', `「${job.title}」听完了，好听吧`]
          : [
              `「${job.title}」唱好啦～${job.voice} 的嗓子还行吧`,
              `唱完了！听完给个评价呗`,
            ];
      const pick = pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;
      try {
        await adapter.sendText(job.scene, job.peerId, pick);
      } catch {
        /* ignore */
      }
    },
  });
  if (config.sing.enabled) jobs.start();

  const pipeline = new MessagePipeline({
    config,
    adapter,
    llm,
    store,
    personas,
    logger: createLogger('pipeline'),
    botName: personas.get().name,
    offlineReply: (event) =>
      `（离线模式）收到来自 ${event.sender.nickname || event.sender.userId} 的消息：「${event.text.replace(/\[艾特你\]/g, '').trim()}」`,
    stickers,
    stickerRate: config.bot.stickerRate,
    web,
    bili,
    media,
    imageGen,
    tts,
    singer,
    jobs,
  });

  client.onEvent = (event) => {
    // handleEvent 现在是 async（要调 get_msg 补全引用消息），这里不阻塞事件循环。
    // 串行处理靠 pipeline 内部的队列，并发 await 不影响顺序。
    void (async () => {
      try {
        const internal = await adapter.handleEvent(event);
        if (internal) await pipeline.handle(internal);
      } catch (error) {
        logger.error('事件处理失败', { message: (error as Error).message.slice(0, 150) });
      }
    })();
  };

  client.onConnected = () => {
    void (async () => {
      try {
        const info = await adapter.getLoginInfo();
        logger.info('登录身份确认', { userId: info.user_id, nickname: info.nickname });
        if (config.bot.selfId && String(info.user_id) !== config.bot.selfId) {
          logger.warn('BOT_SELF_ID 与 OneBot 实际登录账号不一致', {
            expected: config.bot.selfId,
            actual: info.user_id,
          });
        }
      } catch (error) {
        logger.warn('获取登录信息失败', { message: (error as Error).message });
      }
    })();
  };

  client.onDisconnected = (reason) => {
    logger.warn('与 OneBot 的连接断开', { reason });
  };

  client.start();

  // 定时清理去重表
  const pruneTimer = setInterval(() => {
    const removed = store.pruneSeen();
    if (removed > 0) logger.debug('已清理去重记录', { removed });
  }, 3600_000);
  pruneTimer.unref();

  const shutdown = (signal: string): void => {
    logger.info('收到退出信号，正在关闭', { signal, stats: pipeline.getStats() });
    client.stop();
    store.close();
    setTimeout(() => process.exit(0), 200);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常', { message: error.message, stack: error.stack });
  });
}

main().catch((error: unknown) => {
  createLogger('main').error('启动失败', {
    message: (error as Error).message,
    stack: (error as Error).stack,
  });
  process.exit(1);
});
