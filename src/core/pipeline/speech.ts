/**
 * 唱歌与语音合成。
 *
 * 从 pipeline.ts 抽出。两者都涉及「把文本变成音频发出去」，
 * 但触发路径不同：
 *   - trySing：用户点歌 → 曲库直发 / 实时生成
 *   - trySpeak：用户要求朗读 → TTS 合成
 *   - speakReply：回复本身值得配语音（视频深读类）→ TTS 合成
 */

import type { MessageEvent } from '../types.js';
import type { Logger } from '../logger.js';
import {
  detectEmotion,
  detectSpeechLang,
  extractSpeechText,
  wantsSpeech,
  type TtsClient,
} from '../tts.js';
import { detectSingMode, extractSingVoice, extractSongName, wantsMusic } from '../singer.js';
import type { PipelineContext } from './context.js';
import type { LlmClient } from '../llm.js';
import type { Intent } from '../router.js';

/**
 * 把要朗读的文本翻成目标语言。
 *
 * 为什么需要：用户说「用日语说一句求求你了」，
 * 意图是【这句中文的日语说法】，不是把「求求你了」四个汉字念出来。
 * 直接念汉字会被 TTS 用中文音素合成，听起来完全不是日语。
 */
export async function translateForSpeech(
  llm: LlmClient,
  text: string,
  lang: 'ja' | 'en' | 'ko' | 'yue' | 'zh',
  logger: Logger,
): Promise<string | null> {
  const nameMap = { ja: '日语', en: '英语', ko: '韩语', yue: '粤语', zh: '中文' } as const;
  try {
    const res = await llm.complete([
      {
        role: 'system',
        content:
          `把用户给的中文翻译成${nameMap[lang]}。\n` +
          '只输出译文本身，不要解释、不要罗马音、不要引号、不要标点以外的任何内容。\n' +
          '译文要口语化、自然，长度尽量接近原文。',
      },
      { role: 'user', content: text },
    ]);
    const out = res.content.trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
    return out.length > 0 ? out : null;
  } catch (error) {
    logger.info('语音翻译失败，退回原文', { message: (error as Error).message.slice(0, 100) });
    return null;
  }
}

/**
 * 命中唱歌/听歌触发词时发音频。
 *
 * 三种模式：
 *   original — 只听原唱，直接放原曲（不翻唱）
 *   clip     — 唱片段（默认，最快）
 *   full     — 唱整首（慢，完成后入库供以后秒回）
 *
 * 发完都会追加一句招呼，避免"扔个文件就走"的机械感。
 *
 * @returns true 表示已处理
 */
export async function trySing(
  ctx: PipelineContext,
  event: MessageEvent,
  logger: Logger,
  intent?: Intent,
): Promise<boolean> {
  const { config, singer, adapter, stats } = ctx;
  if (!config.sing?.enabled || !singer) return false;

  // 优先用上层传来的语义路由结果（function calling 判定）；
  // 没传（老调用方）才退回正则，保证兼容。
  const byIntent = intent?.kind === 'play_song';
  if (!byIntent && !wantsMusic(event.text)) return false;

  // 歌名：语义路由给的更准（已经去掉了「放」「想听」这类修饰）
  const title = intent?.kind === 'play_song' ? intent.title : undefined;
  const voice = extractSingVoice(event.text);

  // 模式映射：intent 的 mode 只有 original/sing 两种语义，
  // 而 SingMode 还有 clip/full 的区分（翻唱片段 vs 整首）。
  // 「sing」还要再看用户有没有说「完整/整首」。
  const singMode: 'clip' | 'full' | 'original' =
    intent?.kind === 'play_song'
      ? intent.mode === 'original'
        ? 'original'
        : /(完整|全部|整首|全曲|整个|从头到尾|full)/.test(event.text)
          ? 'full'
          : 'clip'
      : detectSingMode(event.text);

  logger.info('触发唱歌', {
    scene: event.scene,
    mode: singMode,
    title: title ?? '(从原句提取)',
    text: event.text.slice(0, 40),
    voice: voice ?? 'default',
    via: intent?.via ?? 'regex',
  });

  // 有准确歌名时替换掉原句里的杂词，避免 Singer 再去猜。
  //
  // 【关键】必须把 mode 显式传下去：
  //   拼成「唱X」会让 singer.handle 内部的 detectSingMode 看到「唱」
  //   就判成 clip，把路由判好的 original 丢掉 —— 用户明明说「听原唱」
  //   结果机器人去翻唱了。这个 bug 实际发生过。
  const singText = title ? `唱${title}` : event.text;
  const result = await singer.handle({ text: singText, voice, mode: singMode });

  switch (result.kind) {
    // ---- 曲库成品 ----
    case 'preset': {
      try {
        await adapter.sendRecord(event.scene, event.peerId, result.file);
        stats.replied++;
        logger.info('曲库歌曲已发送', {
          title: result.title,
          voice: result.voice,
          durationSec: result.durationSec,
        });
        await sayAfter(ctx, event, logger, 'sing', result.title, result.voice);
      } catch (error) {
        logger.info('发送歌曲失败', { message: (error as Error).message.slice(0, 120) });
      }
      return true;
    }

    // ---- 原唱 ----
    case 'original': {
      try {
        await adapter.sendRecord(event.scene, event.peerId, result.file);
        stats.replied++;
        logger.info('原唱已发送', { title: result.title });
        await sayAfter(ctx, event, logger, 'original', result.title, '');
      } catch (error) {
        logger.info('发送原唱失败', { message: (error as Error).message.slice(0, 120) });
      }
      return true;
    }

    // ---- 需要生成 ----
    case 'generating': {
      const songName = extractSongName(event.text);
      const exact = result.title.trim().toLowerCase() === songName.trim().toLowerCase();
      const shownTitle = exact ? result.title : songName;

      let tip: string;
      if (result.mode === 'original') {
        tip = `去拿「${shownTitle}」的原唱，稍等～`;
      } else if (result.mode === 'full') {
        tip = `要唱「${shownTitle}」完整的（${result.voice} 音色），这首得几分钟，唱好发你～`;
      } else {
        tip = `唱「${shownTitle}」的片段（${result.voice} 音色），稍等一小会儿～`;
      }

      try {
        await adapter.sendText(event.scene, event.peerId, tip);
      } catch {
        /* 发不出去就算了 */
      }

      // 交给后台队列（真正的生成在这儿发生）
      if (ctx.jobs) {
        ctx.jobs.enqueue({
          mode: result.mode,
          title: result.title,
          songName,
          voice: result.voice,
          searchId: result.searchId,
          scene: event.scene,
          peerId: event.peerId,
        });
        logger.info('唱歌任务已入队', {
          title: result.title,
          voice: result.voice,
          mode: result.mode,
          searchId: result.searchId,
        });
      } else {
        logger.warn('唱歌队列未启用，任务被丢弃', { title: result.title });
      }
      return true;
    }

    case 'notfound': {
      const names = singer.library.map((s) => s.title);
      const hint = names.length > 0 ? `\n现在会唱：${names.join('、')}` : '';

      // 原唱模式下文案不同——不能说"我不会唱"，那样很奇怪
      const msg =
        singMode === 'original'
          ? result.query.length > 0
            ? `找不到「${result.query}」的原唱欸`
            : '想听哪首？'
          : result.query.length > 0
            ? `「${result.query}」我不会唱欸`
            : '要听哪首？';

      try {
        await adapter.sendText(event.scene, event.peerId, msg + hint);
        stats.replied++;
      } catch {
        /* ignore */
      }
      return true;
    }

    case 'disabled':
      return false;

    case 'error': {
      try {
        await adapter.sendText(event.scene, event.peerId, result.message);
      } catch {
        /* ignore */
      }
      return true;
    }
  }
}

/**
 * 发完音频后追一句招呼。
 *
 * 为什么需要：只发一个语音文件就结束，用户会觉得"冷漠"。
 * 补一句话让交互完整（"唱得怎么样"、"听完记得说感想"）。
 * 失败不影响主流程。
 */
export async function sayAfter(
  ctx: PipelineContext,
  event: MessageEvent,
  logger: Logger,
  kind: 'sing' | 'original',
  title: string,
  voice: string,
): Promise<void> {
  const { adapter, config } = ctx;
  if (config.sing?.afterword === false) return;

  // 简单轮换，避免每次都是同一句
  const pools = {
    sing: [
      `「${title}」唱完啦～怎么样，还听得下去吗`,
      `唱好了！${voice} 的嗓子还行吧`,
      `「${title}」来了，听完给个评价呗`,
    ],
    original: [
      `「${title}」放完了～原唱还是好听`,
      `听完啦，这首真的不错`,
      `「${title}」播完了，要不要我也唱一版`,
    ],
  };
  const pool = pools[kind];
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;

  // 加一点延迟，避免和语音同时到达（QQ 里会挤在一起）
  await new Promise((r) => setTimeout(r, 1200));

  try {
    await adapter.sendText(event.scene, event.peerId, pick);
    logger.info('已发完结语', { kind, title });
  } catch (error) {
    logger.info('发结语失败', { message: (error as Error).message.slice(0, 100) });
  }
}

/**
 * 命中语音触发词时合成语音并发送。
 * @returns true 表示已处理
 */
export async function trySpeak(
  ctx: PipelineContext,
  event: MessageEvent,
  logger: Logger,
  intent?: Intent,
): Promise<boolean> {
  const { config, tts, adapter, llm, stats, store, botName } = ctx;
  if (!config.tts?.enabled || !tts) return false;

  // 语义路由判定「要语音」时不看正则；反之仍需正则兜底
  const byIntent = intent?.kind === 'speak';
  if (!byIntent && !wantsSpeech(event.text)) return false;

  // intent 里带了要念的内容时优先用（模型已经提干净了）
  const fromIntent = intent?.kind === 'speak' ? (intent.text ?? '') : '';
  let content = fromIntent.length > 0 ? fromIntent : extractSpeechText(event.text);
  if (content.length === 0) return false;

  // 语言指令：「用日语说一句求求你了」→ 要的是这句的日语说法，不是念汉字
  const wantLang = detectSpeechLang(event.text);
  if (wantLang && wantLang !== 'zh' && llm.enabled) {
    const translated = await translateForSpeech(llm, content, wantLang, logger);
    if (translated) {
      logger.info('语音文本已翻译', {
        to: wantLang,
        from: content.slice(0, 20),
        toText: translated.slice(0, 40),
      });
      content = translated;
    }
  }

  // 太长就在句子边界截断，别发一条两分钟的语音
  const maxChars = config.tts.maxChars ?? 120;
  if (content.length > maxChars) {
    const cut = content.slice(0, maxChars);
    const lastPunct = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('！'),
      cut.lastIndexOf('？'),
      cut.lastIndexOf('。'),
      cut.lastIndexOf('!'),
      cut.lastIndexOf('?'),
    );
    content = lastPunct > maxChars * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
  }

  // 情绪指令：「愤怒的说一句」→ 挑对应情绪的参考音频
  // GPT-SoVITS 没有情绪参数，情绪完全来自参考音频（实测同一句话，
  // 兴奋参考 F0 381Hz、失落 287Hz，差异明显）
  const wantEmotion = detectEmotion(event.text);

  logger.info('触发语音合成', {
    scene: event.scene,
    chars: content.length,
    lang: wantLang ?? 'auto',
    emotion: wantEmotion ?? 'default',
    text: content.slice(0, 40),
  });

  const result = await tts.synthesize(content, undefined, wantEmotion ?? undefined);
  if (!result) {
    try {
      await adapter.sendText(event.scene, event.peerId, '嗓子哑了，等会儿再说');
      stats.replied++;
    } catch {
      /* 发不出去就算了 */
    }
    return true;
  }

  try {
    await adapter.sendRecord(event.scene, event.peerId, result.filePath);
    stats.replied++;
    logger.info('语音已发送', { file: result.filePath, durationSec: result.durationSec });

    store.appendMessage(event.platform, {
      scene: event.scene,
      peerId: event.peerId,
      userId: botName,
      nickname: botName,
      text: `（发了条语音：${content.slice(0, 30)}）`,
      mentionsBot: false,
      fromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    logger.info('语音发送失败', { message: (error as Error).message.slice(0, 150) });
  }
  return true;
}

/**
 * 把一条已发出的文字回复再朗读一遍发语音。
 *
 * 用途：视频深读这类回复信息量大，用户既要看文字也要听语音。
 * 与 trySpeak 的区别：trySpeak 是「用户要求语音」；
 * 这里是「回复本身值得配语音」。
 */
export async function speakReply(
  ctx: PipelineContext,
  event: MessageEvent,
  text: string,
  logger: Logger,
): Promise<void> {
  const { config, tts, adapter } = ctx;
  if (!config.tts?.enabled || !tts) return;

  // 朗读文本要清洗：去掉表情包标记、markdown、括号动作描写，
  // 否则会把「（甩尾巴）」这种也念出来。
  const clean = text
    .replace(/\[表情包[^\]]*\]/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/（[^）]{0,20}）/g, '')
    .replace(/\([^)]{0,20}\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length < 4) {
    logger.debug('朗读文本过短，跳过语音版');
    return;
  }

  // 太长就截断（语音太长没人听）
  const maxChars = config.tts.maxChars ?? 120;
  const cut =
    clean.length > maxChars
      ? (() => {
          const seg = clean.slice(0, maxChars);
          const p = Math.max(seg.lastIndexOf('。'), seg.lastIndexOf('！'), seg.lastIndexOf('？'));
          return p > maxChars * 0.5 ? seg.slice(0, p + 1) : seg;
        })()
      : clean;

  const result = await tts.synthesize(cut);
  if (!result) {
    logger.info('语音版合成失败（文字版已发出，不影响）');
    return;
  }

  try {
    await adapter.sendRecord(event.scene, event.peerId, result.filePath);
    logger.info('语音版已发送', { chars: cut.length, durationSec: result.durationSec });
  } catch (error) {
    logger.info('语音版发送失败', { message: (error as Error).message.slice(0, 120) });
  }
}
