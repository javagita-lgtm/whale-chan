/**
 * 链接阅读 / 联网搜索 / B站 与小红书深读。
 *
 * 从 pipeline.ts 抽出来的最大一块（约 440 行）。
 * 原来的 `enrichWithWeb` / `readBilibili` / `readXhsNote` / `buildSearchQuery`
 * 都挂在 MessagePipeline 上，靠 `this.deps` 和 `this.lastDeepReadAt` 取数据。
 *
 * 现在改为纯函数：接收 context，返回渲染好的文本块与图片。
 * 唯一需要写回状态的地方（标记深读）走 ctx.markDeepRead()。
 */

import type { MessageEvent } from '../types.js';
import type { Logger } from '../logger.js';
import {
  extractUrls,
  looksLikeSearchIntent,
  renderFetchedPages,
  renderSearchHits,
} from '../web.js';
import {
  fetchStreams,
  isBilibiliVideoUrl,
  renderBiliVideo,
} from '../bilibili.js';
import { renderFramesNote, renderTranscript, type Frame, type TranscribeResult } from '../media.js';
import { fetchXhsNote, isXhsNoteUrl, renderXhsNote } from '../xiaohongshu.js';
import type { PipelineContext } from './context.js';
import { extractImageFacts, looksLikeFactCheck, renderImageFacts } from './fact-check.js';

/** 富化结果：文本块 + 需要一并送给多模态模型的图片。 */
export interface EnrichResult {
  pageBlocks: string[];
  searchBlock: string;
  frameDataUrls: string[];
}

export function emptyEnrich(): EnrichResult {
  return { pageBlocks: [], searchBlock: '', frameDataUrls: [] };
}

/**
 * 指代上文的说法：用户在这条消息里引用之前发过的东西。
 *
 * 【2026-10-26 修正】原来只认「上面/刚才/之前 + 视频/链接」这类组合，
 * 实测用户说的是「看一下这里链接里的内容，总结一下」——
 * 「这里」不在词表里，导致链接继承完全失效，机器人直接说"打不开"。
 */
const RECENT_REF_PATTERN =
  /(上面|上边|刚才|刚刚|之前|前面|那个|这条|这则|这个|这里|这边|该|刚发|上一条|楼上)[^。！？\n]{0,10}(视频|链接|卡片|文章|内容|帖子|图|分享|url|地址)/i;

/**
 * 主入口：按优先级尝试各类内容源。
 *
 * 策略：
 *   - B站视频 → 弹幕+评论（秒回），再按需补画面/台词
 *   - 小红书笔记 → 拿视频直链复用抽帧+转写
 *   - 其他链接 → 抓网页正文
 *   - 没有链接但像在问"查一下/最新消息" → 搜索
 *   - 任一环节失败都不影响回复，只是没有额外资料
 */
export async function enrichWithWeb(
  ctx: PipelineContext,
  event: MessageEvent,
  logger: Logger,
  history: Array<{ nickname: string; text: string }> = [],
  imageDataUrls: string[] = [],
): Promise<EnrichResult> {
  const { config, web, bili, media } = ctx;
  if (!web || !web.enabled) return emptyEnrich();

  const text = event.text;

  // 1) 链接阅读
  if (config.web.linkEnabled) {
    let urls = extractUrls(text, config.web.maxLinks);

    // 本条消息没有链接，但用户说「上面那个/刚才发的」→ 回看最近历史找链接。
    // 真实场景：群里先把卡片单独发出来（不 @ 机器人，不触发回应），
    // 隔一会儿再 @ 问"上面卡片里的视频说了什么"，这时本条消息里只有文字。
    if (urls.length === 0 && RECENT_REF_PATTERN.test(text)) {
      const inherited = findRecentLink(ctx, event);
      if (inherited) {
        logger.info('本条无链接，沿用最近历史里的链接', { url: inherited.slice(0, 80) });
        urls = [inherited];
      }
    }

    if (urls.length > 0) {
      // 1a) B 站视频优先走弹幕通道。
      // 实测抓视频页只有标题和播放量（播放器是 JS 渲染的），
      // 而弹幕有上千条观众反应，信息密度完全不同。
      if (config.web.biliEnabled && bili) {
        const biliUrl = urls.find((u) => isBilibiliVideoUrl(u));
        if (biliUrl) {
          const enriched = await readBilibili(ctx, biliUrl, text, logger);
          if (enriched) return enriched;
          logger.info('B站信息抓取失败，回退到抓网页');
        }
      }

      // 1a-2) 小红书笔记：能拿到视频直链时就复用 B站 的抽帧+转写。
      // 关键洞察：分享链接里带的 xsec_token 是有效凭证，
      // 带上它请求能返回完整笔记页（含 masterUrl 视频直链），
      // 去掉 token 反而会被风控跳到 404。
      if (config.web.biliEnabled && media) {
        const xhsUrl = urls.find((u) => isXhsNoteUrl(u));
        if (xhsUrl) {
          const enriched = await readXhsNote(ctx, xhsUrl, text, logger);
          if (enriched) return enriched;
          logger.info('小红书笔记读取失败，回退到抓网页');
        }
      }

      // 1b) 普通链接走 Fetch
      logger.info('检测到链接，开始抓取', { count: urls.length });
      const settled = await Promise.allSettled(
        urls.map((u) => web.fetchPage(u, config.web.maxCharsPerPage)),
      );
      const pages = settled
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof web.fetchPage>>> =>
          r.status === 'fulfilled' && r.value !== null,
        )
        .map((r) => r.value!);
      if (pages.length > 0) {
        return { ...emptyEnrich(), pageBlocks: [renderFetchedPages(pages)] };
      }
      logger.info('链接全部抓取失败，按无链接处理', { count: urls.length });
      return emptyEnrich();
    }
  }

  // 2) 图片事实核查：发了图 + 质疑真假 → 先读图抽事实，再拿这些事实去搜
  //
  // 【2026-10-28 真实故障】用户发「国防部长带100亿现金飞德黑兰」的截图问真假，
  // 机器人完全没看图，只聊文字，然后说"正规媒体没报道，八成是编的"。
  // 结论碰巧对，但没有任何依据：图里的信源署名、日期、排版破绽全没分析。
  //
  // 更根本的问题：模型权重训练截止时间较早，很多事它本来就不"知道"，
  // 所以不能靠"我没搜到"来推断真假，必须真的看图 + 真的搜。
  if (config.web.searchEnabled && imageDataUrls.length > 0 && looksLikeFactCheck(text)) {
    const facts = await extractImageFacts(ctx, imageDataUrls, text, logger);
    if (facts) {
      const hits = await web.search(facts.searchTerms, config.web.searchCount);
      logger.info('图片核查搜索完成', {
        query: facts.searchTerms.slice(0, 50),
        hits: hits.length,
      });
      return {
        ...emptyEnrich(),
        pageBlocks: [renderImageFacts(facts)],
        searchBlock: hits.length > 0 ? renderSearchHits(hits, facts.searchTerms) : '',
      };
    }
    logger.info('图片核查失败，退回普通搜索');
  }

  // 3) 联网搜索（只在有明确搜索意图时触发，避免每句话都花一次请求）
  if (config.web.searchEnabled && looksLikeSearchIntent(text)) {
    // 用 LLM 提炼搜索词，而不是直接把整句话丢给搜索引擎。
    //
    // 【2026-10-27 真实故障】用户问「他爹还在吗」，
    // 直接拿这句话去搜，返回的全是「给爸爸上香」「孩子他爸」这类无关内容，
    // 机器人据此说"没证据证明杨少华去世"。
    // 根因：没做指代消解。"他爹"在上下文里指杨少华，搜索引擎不知道。
    const query = await buildSearchQuery(ctx, text, history, logger);
    if (query.length >= 2) {
      logger.info('检测到搜索意图', { query: query.slice(0, 40) });
      const hits = await web.search(query, config.web.searchCount);
      if (hits.length > 0) {
        return { ...emptyEnrich(), searchBlock: renderSearchHits(hits, query) };
      }
    }
  }

  return emptyEnrich();
}

/**
 * 读一个 B 站视频：弹幕评论打底，按需补画面和台词。
 *
 * 分层设计的原因：三层信息的成本差好几个数量级
 *   弹幕评论：1 秒、几乎零成本
 *   抽帧：10~25 秒、几千 token
 *   转写：GPU 3.5~20 倍实时、占用显卡
 * 所以默认只取最便宜的一层，够不够用由触发条件判断。
 */
export async function readBilibili(
  ctx: PipelineContext,
  url: string,
  userText: string,
  logger: Logger,
): Promise<EnrichResult | null> {
  const { config, bili, media } = ctx;
  if (!bili) return null;

  logger.info('检测到 B 站视频，走弹幕通道', { url: url.slice(0, 80) });
  const info = await bili.fetchVideo(url);
  if (!info) return null;

  logger.info('B站信息抓取成功', {
    title: info.meta.title.slice(0, 30),
    danmaku选取: info.danmaku.length,
    danmaku总数: info.danmakuTotal,
    comments: info.comments.length,
    duration: info.meta.duration,
  });

  const blocks: string[] = [renderBiliVideo(info)];
  let frameDataUrls: string[] = [];

  if (!media || !config.web.biliDeepRead) {
    return { pageBlocks: blocks, searchBlock: '', frameDataUrls };
  }

  // 只有弹幕太少的视频才值得花十几秒看画面：
  // 热门视频弹幕已经够聊了，用户不想等。
  const wantsVisual = /(看|瞧|瞅)(一下)?(画面|视频)|画面里|画了啥|长什么样|演了啥|啥画面/.test(userText);
  const sparseDanmaku = info.danmaku.length < config.web.biliSparseThreshold;
  const shouldFrames = (sparseDanmaku || wantsVisual) && media.ffmpegAvailable;

  // 转写触发词要覆盖用户实际说法：说了什么 / 听一下 / 声音 / 讲的内容…
  // 【2026-10-27 补充】用户说「详细的说一下这个视频」时也没触发：
  // 虽然「说一下」被第一条命中，但 `(什么|啥|一下|声音|内容)` 要求出现在
  // 「说/讲」之后紧跟的位置，而这里是「说一下这个视频」——中间夹了宾语。
  const wantsAudio =
    /(说|讲|念|听|读)(了|一下|下)?(什么|啥|啥内容|一下|声音|内容)/.test(userText) ||
    /(台词|原话|口播|旁白|语音|声音)/.test(userText) ||
    /不看弹幕|不只看弹幕|看下听|听一下|听下/.test(userText) ||
    /(详细|具体|展开|仔细|完整)(地|的)?\s*(说|讲|介绍|描述|说说|讲讲|说一下|讲一下|介绍下)/.test(userText) ||
    /(到底|究竟)\s*(说|讲|聊)(了)?(什么|啥)/.test(userText) ||
    /视频.{0,4}(内容|讲|说)/.test(userText);
  const shortVideo = info.meta.duration <= config.web.biliAsrMaxSeconds;
  const shouldTranscribe = wantsAudio && media.asrAvailable && shortVideo;

  if (!shouldFrames && !shouldTranscribe) {
    logger.info('弹幕信息充足，跳过深读', {
      danmaku: info.danmaku.length,
      threshold: config.web.biliSparseThreshold,
    });
    return { pageBlocks: blocks, searchBlock: '', frameDataUrls };
  }

  // 取流地址（一次请求，抽帧和转写共用）
  const streams = await fetchStreams(info.meta.cid, info.meta.bvid, config.web.timeoutMs);

  if (shouldFrames && streams.videoUrl) {
    logger.info('触发抽帧', {
      原因: wantsVisual ? '用户要求看画面' : '弹幕太少',
      danmaku: info.danmaku.length,
    });
    const frames: Frame[] = await media.extractFrames(
      streams.videoUrl,
      info.meta.duration,
      config.web.biliMaxFrames,
    );
    if (frames.length > 0) {
      frameDataUrls = frames.map((f) => f.dataUrl);
      blocks.push(renderFramesNote(frames, info.meta.duration));
    }
  }

  if (shouldTranscribe && streams.audioUrl) {
    logger.info('触发语音转写', { duration: info.meta.duration, model: config.web.biliAsrModel });
    const transcript: TranscribeResult | null = await media.transcribeAudio(
      streams.audioUrl,
      info.meta.duration,
    );
    if (transcript) {
      blocks.push(renderTranscript(transcript));
      // 标记「本次做了深读」，回复时额外发一份语音版
      ctx.markDeepRead();
    } else {
      // 转写失败了。要告诉模型"本来想听但没听到"，
      // 否则它会以为自己只是没这能力，回复"我听不到声音"，误导用户。
      logger.info('转写未成功，告知模型');
      blocks.push(
        [
          '【转写说明】',
          '你本来要听这个视频的语音内容，但这次转写没有成功（可能是本地转写服务繁忙）。',
          '回答时请如实说"这次没能把语音转出来"，不要说"我看不了视频/我没这能力"，',
          '因为这是临时故障，不是功能缺失。',
        ].join('\n'),
      );
    }
  }

  return { pageBlocks: blocks, searchBlock: '', frameDataUrls };
}

/**
 * 读小红书笔记：拿到视频直链就复用 B站 的抽帧 + 转写。
 *
 * 关键点：分享链接里的 xsec_token 是有效凭证，带 query 请求才能拿到完整笔记页。
 * 一旦拿到 masterUrl，抽帧和转写的代码和 B站 完全一样——
 * media.extractFrames / transcribeAudio 只认 URL，不认域名。
 */
export async function readXhsNote(
  ctx: PipelineContext,
  url: string,
  userText: string,
  logger: Logger,
): Promise<EnrichResult | null> {
  const { config, media } = ctx;
  logger.info('检测到小红书笔记，尝试抓取', { url: url.slice(0, 80) });

  const { note, reason } = await fetchXhsNote(url, logger, config.web.timeoutMs);
  if (!note) {
    // 抓不到就说清楚原因（token 过期 / 风控），不要让模型瞎猜
    logger.info('小红书笔记读取失败', { reason });
    return {
      pageBlocks: [
        [
          '【小红书笔记读取失败】',
          `原因：${reason ?? '未知'}`,
          '回答时如实说明"小红书这条我打不开"，并说明原因，',
          '可以基于标题推测大概在讲什么，但要标明是推测。',
        ].join('\n'),
      ],
      searchBlock: '',
      frameDataUrls: [],
    };
  }

  let frames: Frame[] = [];
  let transcript: TranscribeResult | null = null;

  if (note.videoUrl && media && config.web.biliDeepRead) {
    // 时长未知时给个保守估计，避免抽帧间隔算错
    const duration = note.durationSec > 0 ? note.durationSec : 60;

    if (media.ffmpegAvailable) {
      logger.info('小红书视频抽帧', { duration, maxFrames: config.web.biliMaxFrames });
      frames = await media.extractFrames(note.videoUrl, duration, config.web.biliMaxFrames);
    }

    // 转写：短视频或用户明确要听才做（转写比抽帧慢得多）
    const wantsAudio =
      /(说|讲|念|听|读)(了|一下|下)?(什么|啥|啥内容|一下|声音|内容)/.test(userText) ||
      /(台词|原话|口播|旁白|语音|声音)/.test(userText) ||
      /(总结|概括|详细|完整|展开)/.test(userText);
    const shortVideo = duration <= config.web.biliAsrMaxSeconds;

    if (wantsAudio && shortVideo && media.asrAvailable) {
      logger.info('小红书视频转写', { duration, model: config.web.biliAsrModel });
      transcript = await media.transcribeAudio(note.videoUrl, duration);
      if (transcript) ctx.markDeepRead();
    }
  }

  const blocks = [renderXhsNote(note, frames, transcript)];
  const frameDataUrls = frames.map((f) => f.dataUrl);

  logger.info('小红书笔记处理完成', {
    title: note.title.slice(0, 30),
    frames: frames.length,
    transcribed: Boolean(transcript),
  });

  return { pageBlocks: blocks, searchBlock: '', frameDataUrls };
}

/**
 * 把用户的问题炼成搜索关键词，重点是**消解代词**。
 *
 * 为什么不能直接搜原句：
 *   用户说「他爹还在吗」，直接搜会返回「给爸爸上香」这类无关结果。
 *   而搜「杨少华」时 10 条全是他的去世报道。
 *
 * 【2026-10-28 真实故障】
 *   用户引用了一条长消息问「胡塞打沙特是不是真的」，
 *   搜索词变成了「[引用 鲸鱼娘：等下，这图右下角写着2026年10月27日…」，
 *   搜出来全是无关内容，机器人因此说"正规媒体没报道，八成是编的"。
 *   根因：引用内容（最多 300 字）被当成搜索词的一部分。
 *
 * 设计：
 *   - **先剥掉引用块**，引用内容只作为「理解上下文」的素材，不进搜索词
 *   - 带最近 5 条上下文，让模型知道"他爹"指谁
 *   - 只输出关键词，不给解释
 *   - LLM 不可用或失败时退回原句（保证总能搜）
 */
export async function buildSearchQuery(
  ctx: PipelineContext,
  text: string,
  history: Array<{ nickname: string; text: string }>,
  logger: Logger,
): Promise<string> {
  const { llm } = ctx;

  // 1) 剥掉引用块，单独存起来当上下文用
  //    格式：[引用 昵称：内容]  或  [引用：内容]
  //    内容里可能出现 ] ，所以用非贪婪 + 贪婪兜底两种策略
  const quotedBlocks: string[] = [];
  let cleaned = text.replace(/\[引用[^\]]*\]/g, (m) => {
    quotedBlocks.push(m.slice(1, -1));
    return ' ';
  });
  // 兜底：引用内容里含 ] 时上面的正则只吃掉一部分，再扫一次残余
  if (/\[引用/.test(cleaned)) {
    cleaned = cleaned.replace(/\[引用[\s\S]*$/, (m) => {
      quotedBlocks.push(m.slice(1));
      return ' ';
    });
  }

  cleaned = cleaned
    .replace(/\[艾特你\]/g, '')
    .replace(/\[回复\]/g, '')
    .replace(/\[分享\][^\s]*/g, '')
    .replace(/@\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 用户自己说的话为空（例如只引用不说话）→ 用引用内容兜底搜
  if (cleaned.length === 0) {
    const q = quotedBlocks.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    logger.info('提问为空，改用引用内容搜索', { query: q.slice(0, 40) });
    return q;
  }

  if (!llm.enabled) return cleaned.slice(0, 120);

  // 只有出现代词/模糊指代时才值得花一次 LLM 调用
  const needsResolve = /(他|她|它|这个|那个|这人|那位|上面|刚才|前者|后者)/.test(cleaned);
  if (!needsResolve) {
    logger.debug('搜索词无指代，直接用原句', { query: cleaned.slice(0, 40) });
    return cleaned.slice(0, 120);
  }

  // 上下文：引用内容 + 最近几条聊天
  const ctxParts: string[] = [];
  if (quotedBlocks.length > 0) {
    ctxParts.push(`【被引用的消息】${quotedBlocks.join(' ').slice(0, 300)}`);
  }
  const recent = history
    .slice(-5)
    .map((h) => `${h.nickname}：${h.text.slice(0, 80)}`)
    .join('\n');
  if (recent.length > 0) ctxParts.push(`【最近聊天】\n${recent}`);

  try {
    const res = await llm.complete([
      {
        role: 'system',
        content:
          '你是搜索关键词提炼器。把用户的问题改写成 1~3 个搜索关键词。' +
          '必须消解代词：根据上文把「他爹/这个/那个/他/她」换成具体的人名或事物名。' +
          '只输出关键词本身，用空格分隔，不要解释、不要引号、不要标点。' +
          '注意：被引用的消息只是背景，不要把它当成搜索目标。',
      },
      {
        role: 'user',
        content: `${ctxParts.join('\n\n') || '（无上文）'}\n\n【用户问题】${cleaned}\n【关键词】`,
      },
    ]);

    const q = res.content
      .trim()
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/\n[\s\S]*$/, '')
      .slice(0, 120);

    if (q.length >= 2 && !/抱歉|无法|不能/.test(q)) {
      if (q !== cleaned.slice(0, 120)) {
        logger.info('搜索词已消解指代', {
          原句: cleaned.slice(0, 40),
          关键词: q.slice(0, 40),
        });
      }
      return q;
    }
  } catch (error) {
    logger.info('搜索词提炼失败，用原句', {
      message: (error as Error).message.slice(0, 80),
    });
  }
  return cleaned.slice(0, 120);
}

/**
 * 从最近历史里找一条链接（用于「上面那个视频」这种指代）。
 *
 * 时间窗 15 分钟 / 20 条：真实使用里"先发卡片刻一会儿再问"经常超过 5 分钟。
 */
export function findRecentLink(ctx: PipelineContext, event: MessageEvent): string | null {
  try {
    const since = Date.now() - 15 * 60_000;
    const recent = ctx.store.recentMessages(
      event.platform,
      event.scene,
      event.peerId,
      20,
      since,
    );
    // 从新到旧找，取最近一条带链接的
    for (let i = recent.length - 1; i >= 0; i--) {
      const t = recent[i]?.text ?? '';
      const found = extractUrls(t, 1);
      if (found.length > 0) return found[0] as string;
    }
  } catch {
    /* 找不到就算了 */
  }
  return null;
}
