/**
 * 本地 TTS（Style-Bert-VITS2 + RikkaBotan 中文萌系音色）。
 *
 * 为什么走子进程而不是直接调 Python 库：
 *   1. SBV2 锁 torch<2.4 + numpy<2，和主程序的 torch 2.11 + numpy 2 冲突
 *   2. 模型加载要 16 秒，子进程每次重新加载太慢
 *   3. 所以走「常驻 HTTP 服务」模式：Python 侧起一个 Flask/FastAPI，
 *      Node 侧 POST 文本拿 wav
 *
 * 本文件是 Node 侧的客户端。
 */

import type { Logger } from './logger.js';

export interface TtsOptions {
  /** TTS 服务地址 */
  baseUrl: string;
  /** 超时毫秒 */
  timeoutMs: number;
  logger: Logger;
}

export interface TtsResult {
  /** 生成的 wav 本地路径 */
  filePath: string;
  /** 音频时长（秒） */
  durationSec: number;
  /** 耗时毫秒 */
  elapsedMs: number;
  /** 实际使用的情绪（服务端可能降级到相近情绪） */
  emotion?: string;
}

/** 一个可用音色。 */
export interface TtsVoice {
  /** 目录名，作为 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 主模型文件名 */
  file: string;
  /** 语言（zh / ja / unknown） */
  language: string;
}

export class TtsClient {
  constructor(private readonly options: TtsOptions) {}

  /** 服务是否在线。 */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.options.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 列出可用音色。 */
  async listVoices(): Promise<{ voices: TtsVoice[]; current: string }> {
    try {
      const res = await fetch(`${this.options.baseUrl}/voices`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { voices: [], current: '' };
      return (await res.json()) as { voices: TtsVoice[]; current: string };
    } catch {
      return { voices: [], current: '' };
    }
  }

  /** 切换音色（让服务端预加载，之后合成更快）。 */
  async setVoice(voiceId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.options.baseUrl}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: voiceId }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return false;
      const j = (await res.json()) as { ok?: boolean };
      return j.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * 合成语音。
   *
   * @param text 要朗读的文本
   * @param voice 音色 ID（不传则用服务端当前音色）
   * @returns 生成的 wav 路径；失败返回 null
   */
  async synthesize(
    text: string,
    voice?: string,
    emotion?: string,
  ): Promise<TtsResult | null> {
    const startedAt = Date.now();
    const { logger, baseUrl, timeoutMs } = this.options;

    try {
      const payload: Record<string, string> = { text };
      if (voice) payload['voice'] = voice;
      if (emotion) payload['emotion'] = emotion;

      const res = await fetch(`${baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        logger.info('TTS 合成失败', { status: res.status, detail: detail.slice(0, 200) });
        return null;
      }

      const j = (await res.json()) as {
        ok?: boolean;
        path?: string;
        duration?: number;
        emotion?: string;
        message?: string;
      };

      if (!j.ok || !j.path) {
        logger.info('TTS 返回异常', { detail: JSON.stringify(j).slice(0, 200) });
        return null;
      }

      const elapsedMs = Date.now() - startedAt;
      logger.info('TTS 合成完成', {
        chars: text.length,
        durationSec: j.duration,
        elapsedMs,
      });

      return {
        filePath: j.path,
        durationSec: j.duration ?? 0,
        elapsedMs,
        emotion: j.emotion,
      };
    } catch (error) {
      logger.info('TTS 请求异常', { message: (error as Error).message.slice(0, 150) });
      return null;
    }
  }
}

/**
 * 语音触发词。
 *
 * 【2026-10-27 收紧】之前「详细的说一下这个视频」会误触发，
 * 把用户自己的话念一遍发出去（真群里发生过）。
 * 根因：`(说|念|读|讲)` 前面没要求任何前置标记，
 * 只要句子里出现「说一下」就命中。
 *
 * 现在只认这几类明确意图：
 *   1. 用<语言/情绪>说…      用日语说 / 生气地说 / 用温柔的语气念
 *   2. 说<量词>…             说一句 / 念一段 / 读一下（必须句首）
 *   3. 来/发 语音            来一句语音 / 发条语音
 *   4. 语音/声音/声线 + 说念读讲
 *   5. 念给我听 / 读给我听
 */
const SPEAK_PATTERN = new RegExp(
  [
    '(用|拿)\\s*(日语|日文|日本语|英语|英文|中文|汉语|粤语|韩语)?\\s*',
    '(愤怒|生气|恼怒|开心|高兴|兴奋|激动|悲伤|难过|失落|沮丧|惊讶|害羞|平静|温柔)?\\s*',
    '的?[地的]?\\s*(语气|声调|腔调)?\\s*(说|念|读|讲)',
    '|^(愤怒|生气|恼怒|开心|高兴|兴奋|激动|悲伤|难过|失落|沮丧|惊讶|害羞|平静|温柔)?\\s*',
    '的?[地的]?\\s*(语气|声调|腔调)?\\s*(说|念|读|讲)',
    '|^(说|念|读|讲)一?[句段遍]',
    '|^(来|发)(一?[句段条])?\\s*语音',
    '|(语音|声音|声线)\\s*(说|念|读|讲)',
    '|念给我听|读给我听|说给我听',
  ].join(''),
);

/**
 * 明确排除：这些是「让人解释/讲解」，不是「让人念出来」。
 *
 * 例：「讲一下原理」「念一遍这首诗」「读一下这段代码」
 *     ——用户想要的是理解，不是音频。
 */
const EXPLAIN_NOT_SPEAK =
  /^(讲|说|念|读)(一下|一遍|一段)?\s*(原理|道理|逻辑|代码|源码|算法|原因|区别|意思|思路|实现|机制|这首诗|课文|题目|题|这段代码|这些代码|这个函数|这段逻辑)/;

/**
 * 是否要发语音。
 *
 * 注意：必须先剥掉 [艾特你] / [分享] 这类渲染标记，
 * 否则 ^ 锚定的正则永远匹配不上（实测踩过：群里 @ 机器人时文本以 [艾特你] 开头）。
 */
export function wantsSpeech(text: string): boolean {
  const t = stripMarks(text);
  if (t.length < 3) return false;
  // 先排除「让人解释」的说法，再判触发词
  if (EXPLAIN_NOT_SPEAK.test(t)) return false;
  return SPEAK_PATTERN.test(t);
}

/** 剥掉适配层渲染的方括号标记（[艾特你] / [回复] / [分享]xxx 等）。 */
function stripMarks(raw: string): string {
  return raw
    .replace(/\[艾特你\]/g, '')
    .replace(/\[回复\]/g, '')
    .replace(/\[分享\][^\s]*/g, '')
    .replace(/@\d+/g, '')
    .trim();
}

/**
 * 语言指令：「用日语说」「用英语念」。
 *
 * 为什么要单独抽出来：
 *   用户说「用日语说一句求求你了」时，他想要的是【这句中文的日语说法】，
 *   而不是把「求求你了」这四个汉字念出来。
 *   所以这里识别出语言意图，交给 LLM 翻译，再把译文送 TTS。
 */
const LANG_HINT = /(用|拿|说|念|读)?\s*(日语|日文|日本语|英语|英文|中文|汉语|粤语|韩语)\s*(说|念|读|讲|来|发)?/;

export type SpeechLang = 'ja' | 'en' | 'zh' | 'yue' | 'ko';

/** 语音情绪。 */
export type SpeechEmotion = 'happy' | 'sad' | 'angry' | 'surprise' | 'shy' | 'calm';

/**
 * 情绪词表。
 *
 * 为什么要做：GPT-SoVITS 本身没有情绪参数，
 * 情绪完全由「参考音频」决定（实测同一句话，兴奋参考 F0 381Hz、失落 287Hz）。
 * 所以做法是：识别用户说的情绪，去参考音频库里挑对应情绪的那段。
 */
const EMOTION_WORDS: Array<{ emo: SpeechEmotion; re: RegExp }> = [
  { emo: 'angry', re: /(愤怒|生气|恼怒|发火|暴躁|凶|angry)/ },
  { emo: 'happy', re: /(开心|高兴|兴奋|快乐|欢快|激动|开心地|happy)/ },
  { emo: 'sad', re: /(悲伤|难过|失落|沮丧|哭|委屈|sad)/ },
  { emo: 'surprise', re: /(惊讶|吃惊|震惊|意外|wow|surprise)/ },
  { emo: 'shy', re: /(害羞|娇羞|羞答答|腼腆|shy)/ },
  { emo: 'calm', re: /(平静|温柔|轻声|悄悄| calmly)/ },
];

/** 从用户话里识别情绪。 */
export function detectEmotion(text: string): SpeechEmotion | null {
  const t = stripMarks(text);
  for (const { emo, re } of EMOTION_WORDS) {
    if (re.test(t)) return emo;
  }
  return null;
}

/**
 * 剥掉语言词和情绪词，剩下的才是要朗读的内容。
 *
 * 例：「用日语愤怒的说一句为什么要弹春日影」
 *     → 语言 ja、情绪 angry、内容「为什么要弹春日影」
 */
export function extractEmotionPhrase(text: string): string {
  return stripMarks(text)
    .replace(/(用|拿)?(日语|日文|日本语|英语|英文|中文|汉语|粤语|韩语)/g, '')
    .replace(/(愤怒|生气|恼怒|发火|暴躁|开心|高兴|兴奋|快乐|欢快|激动|悲伤|难过|失落|沮丧|委屈|惊讶|吃惊|震惊|害羞|娇羞|腼腆|平静|温柔|轻声|悄悄)的?/g, '')
    .replace(/[的地]?(语气|声调|声音|腔调)/g, '')
    .trim();
}

/** 从用户话里识别语言意图。 */
export function detectSpeechLang(text: string): SpeechLang | null {
  const m = LANG_HINT.exec(stripMarks(text));
  if (!m) return null;
  const w = m[2] ?? '';
  if (/日语|日文|日本语/.test(w)) return 'ja';
  if (/英语|英文/.test(w)) return 'en';
  if (/粤语/.test(w)) return 'yue';
  if (/韩语/.test(w)) return 'ko';
  return 'zh';
}

/** 从用户话里抠出要朗读的内容。 */
export function extractSpeechText(raw: string): string {
  let t = extractEmotionPhrase(raw);

  // 去掉触发词前缀
  t = t
    .replace(/^(你)?(能不能|可以|帮我|给我)?\s*/, '')
    .replace(/^(用|拿)?\s*/, '')
    .replace(/^(语音|声音|声线)?\s*/, '')
    .replace(/^[的地]\s*/, '')
    .replace(/^(说|念|读|讲)(一句|一段|一遍|一下|个)?\s*/, '')
    .replace(/^(来|发)(一句|一段|一条)?\s*语音\s*(说)?\s*/, '')
    .replace(/^[，,：:\s]+/, '')
    .replace(/^的\s*/, '')
    .trim();

  // 去掉包裹的引号（「」『』“”）
  t = t.replace(/^[「『“"']+/, '').replace(/[」』”"']+$/, '').trim();

  return t;
}
