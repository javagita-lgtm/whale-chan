/**
 * 唱歌：触发词识别 + 曲库匹配 + 按需生成。
 *
 * 两条路径：
 *   1. 命中预置曲库且没指定音色 → 直接发成品（秒回）
 *   2. 指定了音色 / 曲库没有 → 走 music API 搜歌 + SVC 生成（几分钟）
 *
 * 为什么预置成品优先：
 *   SVC 生成一首 4 分钟的歌要 3~5 分钟，群里等这么久体验很差。
 *   常用的歌预先做好，绝大多数请求就能秒回。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.js';
import type { MusicClient } from './music.js';

/** 预置曲库的一条。 */
export interface SongEntry {
  /** 唯一 ID，也是用户说的歌名关键词 */
  id: string;
  /** 显示名 */
  title: string;
  /** 成品音频路径（mp3/wav） */
  file: string;
  /** 这条成品用的音色 */
  voice: string;
  /** 别名（用户可能用不同叫法） */
  aliases?: string[];
  /** 时长（秒），用于提示 */
  durationSec?: number;
}

/** 一次唱歌请求。 */
export interface SingRequest {
  /** 用户原话 */
  text: string;
  /** 想听的音色（空 = 用曲库默认） */
  voice?: string;
  /**
   * 显式指定处理模式（可选）。
   *
   * 【为什么需要】语义路由（function calling）已经判断出 mode 了，
   * 但如果只把歌名拼回 text 传进来，`handle()` 内部会**重新跑
   * detectSingMode()**，把 `original` 丢掉。
   *
   * 实测 bug：用户说「我想听《This game》…原唱」，
   * 路由给出 mode=original（正确），但拼成「唱This game」后，
   * detectSingMode 看到「唱」就判成 clip —— 于是去翻唱了。
   *
   * 传了这个字段就以它为准，不再重新判断。
   */
  mode?: 'clip' | 'full' | 'original';
}

/** 处理模式。 */
export type SingMode =
  /** 只唱片段（默认，快） */
  | 'clip'
  /** 唱整首（慢，完成后入库） */
  | 'full'
  /** 只听原唱，不翻唱 */
  | 'original';

export type SingResult =
  | { kind: 'preset'; file: string; title: string; voice: string; durationSec?: number }
  | { kind: 'original'; file: string; title: string; durationSec?: number }
  | { kind: 'generating'; title: string; voice: string; searchId: string; mode: SingMode }
  | { kind: 'notfound'; query: string }
  | { kind: 'error'; message: string }
  | { kind: 'disabled' };

/**
 * 唱歌触发词。
 *
 * 踩过的坑（每一个都是真实漏判/误判）：
 *   「唱《春日影》」——书名号直接跟在「唱」后面，最初要求中间必须有「一首」。
 *   「用soyo唱春日影」——前面有音色指定，`^` 锚定匹配不到。
 *   「唱完整的春日影」——「唱」后跟的是"完整的"而不是量词。
 *   「我不想唱歌」——含「唱歌」但意思相反，要排除。
 */
/**
 * 唱歌触发词。
 *
 * 踩过的坑（每一个都是真实漏判/误判）：
 *   「唱《春日影》」——书名号直接跟在「唱」后面，最初要求中间必须有「一首」。
 *   「用soyo唱春日影」——前面有音色指定，`^` 锚定匹配不到。
 *   「唱完整的春日影」——「唱」后跟的是"完整的"而不是量词。
 *   「我不想唱歌」——含「唱歌」但意思相反。
 *   「来一段春日影原唱」——修「唱完整的」时把量词写成可选，
 *     导致只要出现「唱」字就匹配，把「原唱」也算进去了。
 *   「唱届かない恋」——**「唱」后直接跟歌名**（没有量词、没有书名号），
 *     这是最常见的形式，必须支持。
 *
 * 最终形态：「唱」后必须是以下之一
 *   1. 直接跟内容（歌名/书名号/引号）——排除「唱原唱」「唱不」
 *   2. 量词（一首/一曲）
 *   3. 修饰词（歌/一下/完整/全部/整首…）
 *
 * 【2026-11-02 修复】「唱」后面允许空格：
 *   之前「唱 This game」不匹配（要求紧跟字母），
 *   但中英混写时用户普遍会加空格。现在 唱\s* 兼容。
 */
const SING_PATTERN =
  /唱(?![原不别没])\s*([《「『“"‘'\[a-zA-Z\u3040-\u30ff\u4e00-\u9fff])|唱\s*(一?[首曲个])|唱\s*(歌|一下|完整|全部|整首|全曲|整个)的?|[唱来]一?首|来一首|点歌|(用|拿)\s*\S{2,12}\s*(的)?(音色|声音|声线)?\s*唱/;

/**
 * 否定的说法要排除（「我不想唱歌」「别唱了」）。
 */
const NEGATIVE_PATTERN = /(不想|不要|别|不用|不必|讨厌).{0,4}(唱|听|放)/;

/**
 * 「来一段/来点 + 原唱」也算听原唱。
 *
 * 为什么单独处理：`来一段` 不含「首」，所以 SING_PATTERN 不命中；
 * 但句子里又出现了「原唱」——这是明确的听歌意图。
 */
const ORIGINAL_HINT = /(原唱|原版|原曲|原声)/;


/** 是否要唱歌（不含「只听原唱」）。 */
export function wantsSing(text: string): boolean {
  const t = text.replace(/\[艾特你\]/g, '').trim();
  if (t.length < 3) return false;
  if (NEGATIVE_PATTERN.test(t)) return false;
  return SING_PATTERN.test(t);
}

/**
 * 「想听原唱」的意图。
 *
 * 用户说「我想听春日影」「放一下春日影」——不要翻唱，直接放原曲。
 * 这类话里通常没有「唱」字，所以要和 SING_PATTERN 分开判断。
 *
 * 【2026-11-02 修复】之前漏掉了「放 + 直接接歌名/书名号」这个最常见的形式，
 * 实测这些都触发不了：
 *   放《This game》      放一首 This game     放首歌
 *   放这首歌听听          放《X》作者名这首歌
 * 用户最自然的说法反而全废了，所以补上。
 *
 * 但「放 + 任意字」太宽：实测把「放寒假」「放学」「放假」「放心」
 * 「放屁」「放大」全误判成放歌了。所以下面用 FAKE_FANG 先排除。
 */
const FAKE_FANG =
  /^放\s*(假|学|晴|松|心|大|屁|开|置|弃|任|宽|手|低|血|电|射|慢|快|任|眼|声|歌的?时候)/;

const LISTEN_PATTERN = new RegExp(
  [
    // 原有：想听 / 要听 / 放一下 / 放个 / 播放 / 原唱 / 原版
    '(想听|要听|放一?下|放个|播放|来一段?原|原唱|原版)',
    // 听一下 / 听一遍 / 听一首
    '|听(一?[下遍]|一?首)',
    // 放 + 书名号/引号：放《X》、放「X」、放"X"
    '|放\\s*[《「『“"\'\\[]',
    // 放一首/放个/放只 + 内容
    '|放\\s*(一?首|个|只)',
    // 放 + 任意歌名（排除"放这/放那/放什么"等指代词）
    '|放\\s*(?![这那什怎哪])[^\\s，。！？,.!?]{1,20}',
    // 「这首歌」指向（配合上文曲名）
    '|放(这|那)首歌',
  ].join(''),
);

/** 是否要「听原唱」。 */
export function wantsOriginal(text: string): boolean {
  const t = text.replace(/\[艾特你\]/g, '').trim();
  if (t.length < 3) return false;
  if (NEGATIVE_PATTERN.test(t)) return false;
  // 「放假/放学/放心/放大」这类不是放歌
  if (FAKE_FANG.test(t)) return false;
  // 明确说了「唱」的一律走翻唱（「唱完整版」也算）
  if (SING_PATTERN.test(t)) return false;
  // 「原唱/原版」是强信号
  if (ORIGINAL_HINT.test(t)) return true;
  return LISTEN_PATTERN.test(t);
}

/**
 * 识别是「唱片段」还是「唱整首」，以及「只听原唱」。
 *
 * 优先级（很重要）：
 *   1. 明确的「唱」→ 翻唱分支（clip / full）
 *   2. 「完整/全部/整首」→ full（即使句子里有「听」也算翻唱，
 *      因为"我要听完整版春日影"的意图是要整首翻唱）
 *   3. 只有「听/放」没有「唱」→ original
 *   4. 其他 → clip
 */
export function detectSingMode(text: string): SingMode {
  const t = text.replace(/\[艾特你\]/g, '').trim();

  const isSing = SING_PATTERN.test(t);
  const isFull = /(完整|全部|整首|全曲|整个|从头到尾|full)/.test(t);

  // 「唱」优先
  if (isSing) return isFull ? 'full' : 'clip';

  // 没「唱」但说了「完整」——仍然是要整首（隐含翻唱）
  if (isFull) return 'full';

  // 纯「听/放」
  if (LISTEN_PATTERN.test(t)) return 'original';

  return 'clip';
}

/** 是否与唱歌/听歌相关（唱歌 或 听原唱）。 */
export function wantsMusic(text: string): boolean {
  return wantsSing(text) || wantsOriginal(text);
}

/**
 * 从用户话里提取歌名。
 *
 * 「唱《春日影》」→ 春日影
 * 「唱一首春日影」→ 春日影
 * 「唱完整的春日影」→ 春日影
 * 「用soyo唱春日影」→ 春日影
 * 「我想听春日影」→ 春日影
 */
export function extractSongName(raw: string): string {
  let t = raw.replace(/\[艾特你\]/g, '').replace(/@\d+/g, '').trim();

  // 1. 去掉音色指定
  t = t.replace(/(用|拿)\s*[a-zA-Z\u4e00-\u9fa5]{2,10}\s*(的)?(音色|声音|声线)?\s*(唱|来)/g, '');

  // 2. 去掉「想听/要听/放一下/播放」这类听歌前缀
  t = t.replace(/^(我)?(也)?(想|要)(听|听一下|听一遍)\s*/, '');
  t = t.replace(/^(放|播)(一?下|一?个|放)?\s*/, '');
  t = t.replace(/^(来|给)(一?段|一?点)?\s*/, '');

  // 3. 去掉「完整/全部/整首」这类修饰
  t = t.replace(/(完整的?|全部的?|整首|全曲|整个|从头到尾|完整版|原唱|原版)/g, '');

  // 4. 去唱歌触发词
  t = t
    .replace(/^(你)?(能不能|可以|帮我|给我)?\s*/, '')
    .replace(/^(给我)?(唱|来)(一?[首曲个])?(歌|一下)?\s*/, '')
    .replace(/^(一?[首曲])?\s*/, '')
    .replace(/^点歌\s*/, '')
    .replace(/^[，,：:\s]+/, '')
    .trim();

  // 5. 去掉书名号/引号
  t = t.replace(/^[《「『“"']+/, '').replace(/[》」』”"']+$/, '').trim();

  // 6. 去掉残留的「的」和空白
  t = t.replace(/^的\s*/, '').replace(/^[，,：:\s]+/, '').trim();

  return t;
}

/** 从用户话里提取指定音色。 */
export function extractSingVoice(raw: string): string | undefined {
  const t = raw.replace(/\[艾特你\]/g, '').trim();
  // 「用 soyo 唱」「用 anon 的音色唱」
  const m = /(?:用|拿)\s*([a-zA-Z]{2,12})\s*(?:的)?(?:音色|声音|声线)?\s*(?:唱|来)/i.exec(t);
  if (m && m[1]) return m[1].toLowerCase();
  return undefined;
}

export interface SingerOptions {
  logger: Logger;
  music: MusicClient;
  /** 预置曲库 */
  songs: SongEntry[];
  /** 是否启用 */
  enabled: boolean;
  /** 音频输出目录 */
  workDir: string;
  /** 用户没指定音色时用哪个 */
  defaultVoice: string;
}

export class Singer {
  constructor(private readonly options: SingerOptions) {}

  /** 当前曲库。 */
  get library(): SongEntry[] {
    return this.options.songs;
  }

  /**
   * 处理一次唱歌请求。
   *
   * 三种模式：
   *   original — 只听原唱（不翻唱），直接放原曲
   *   clip     — 唱片段（默认，快）
   *   full     — 唱整首（慢，完成后入库）
   *
   * 这里只做「决策」，不执行长时间的 SVC；生成交给调用方异步处理。
   */
  async handle(req: SingRequest): Promise<SingResult> {
    const { logger, music, enabled } = this.options;
    if (!enabled) return { kind: 'disabled' };

    // 调用方显式给了 mode 就以它为准（语义路由比正则准），
    // 否则才从原句里猜。见 SingRequest.mode 的注释。
    const mode = req.mode ?? detectSingMode(req.text);
    const songName = extractSongName(req.text);

    // ---- 模式 1：只听原唱 ----
    if (mode === 'original') {
      if (songName.length === 0) return { kind: 'notfound', query: '' };

      const cached = this.findOriginal(songName);
      if (cached) {
        logger.info('命中原唱缓存', { file: cached });
        return { kind: 'original', file: cached, title: songName };
      }

      const hits = await music.search(songName, { count: 5 });
      const relevant = hits.filter((h) => isRelevant(songName, h.name));
      if (relevant.length === 0) {
        logger.info('原唱无结果', { query: songName });
        return { kind: 'notfound', query: songName };
      }

      const hit = relevant[0]!;
      logger.info('需下载原唱', { song: hit.name, id: hit.id });
      // 用 generating 的形态交给调用方下载，mode 标 original
      return {
        kind: 'generating',
        title: hit.name,
        voice: '',
        searchId: hit.id,
        mode: 'original',
      };
    }

    // ---- 模式 2/3：翻唱 ----
    if (songName.length === 0) return { kind: 'notfound', query: '' };

    const preset = this.matchLibrary(songName);
    const wantVoice = req.voice?.toLowerCase();
    const voice = wantVoice ?? preset?.voice ?? this.options.defaultVoice;

    // 曲库命中且音色一致 → 直接发（片段和整首都走这条，只要成品够长）
    if (preset && (!wantVoice || wantVoice === preset.voice.toLowerCase())) {
      if (!existsSync(preset.file)) {
        logger.info('曲库文件不存在', { id: preset.id, file: preset.file });
        return { kind: 'error', message: `曲库里的「${preset.title}」找不到文件` };
      }
      // 只有成品足够长才满足「唱完整」
      const longEnough = (preset.durationSec ?? 0) >= 100;
      if (mode === 'clip' || longEnough) {
        logger.info('命中预置曲库', { id: preset.id, voice: preset.voice, mode });
        return {
          kind: 'preset',
          file: preset.file,
          title: preset.title,
          voice: preset.voice,
          durationSec: preset.durationSec,
        };
      }
      logger.info('曲库成品太短，需生成完整版', {
        title: preset.title,
        dur: preset.durationSec,
      });
    } else if (preset && wantVoice && wantVoice !== preset.voice.toLowerCase()) {
      logger.info('指定音色与曲库不同，需重新生成', {
        song: preset.title,
        want: wantVoice,
        preset: preset.voice,
      });
    }

    // 曲库没有（或要换音色）→ 查 music API
    const hits = await music.search(songName, { count: 3 });

    // 音乐 API 的模糊匹配很差：搜「不存在的歌xyz」会返回一堆无关结果。
    // 所以必须自己校验歌名相关性，否则会给用户报错误的歌名。
    const relevant = hits.filter((h) => isRelevant(songName, h.name));
    if (relevant.length === 0) {
      logger.info('音乐接口无相关结果', { query: songName, got: hits.length });
      return { kind: 'notfound', query: songName };
    }

    const hit = relevant[0]!;
    logger.info('需要实时生成', { song: hit.name, id: hit.id, voice, mode });
    return {
      kind: 'generating',
      title: hit.name,
      voice,
      searchId: hit.id,
      mode,
    };
  }

  /** 找已下载的原唱缓存。 */
  findOriginal(songName: string): string | undefined {
    const dir = join(this.options.workDir, 'originals');
    if (!existsSync(dir)) return undefined;
    const q = songName.trim().toLowerCase();
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        const stem = f.replace(/\.(mp3|wav|m4a|flac)$/i, '').toLowerCase();
        if (stem === q || stem.includes(q) || q.includes(stem)) {
          return join(dir, f);
        }
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  /** 在曲库里找歌（支持别名 + 包含匹配）。 */
  matchLibrary(query: string): SongEntry | undefined {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return undefined;

    // 精确匹配
    for (const s of this.options.songs) {
      if (s.id.toLowerCase() === q || s.title.toLowerCase() === q) return s;
      if (s.aliases?.some((a) => a.toLowerCase() === q)) return s;
    }

    // 包含匹配（用户说「春日影」而曲库叫「春日影 (MyGO ver.)」）
    for (const s of this.options.songs) {
      const names = [s.id, s.title, ...(s.aliases ?? [])].map((x) => x.toLowerCase());
      if (names.some((n) => n.includes(q) || q.includes(n))) return s;
    }

    return undefined;
  }
}

/**
 * 判断搜索结果是否与查询相关。
 *
 * 音乐 API 的模糊匹配极宽松——搜「不存在的歌xyz」会返回标题叫「不存在的」的歌。
 * 规则（从严）：
 *   - 完全相等 → 相关
 *   - 标题包含查询 → 相关（查询是歌名的子串，如「春日」→「春日影」）
 *   - 查询包含标题 → 只在标题不太短时算相关
 *     （否则「不存在的歌xyz」包含「不存在的」也会被误判）
 *   - 其他 → 不相关
 */
export function isRelevant(query: string, title: string): boolean {
  const q = query.trim().toLowerCase();
  const t = title.trim().toLowerCase();
  if (q.length === 0 || t.length === 0) return false;
  if (q === t) return true;

  // 标题是查询的子串：只有标题足够长（>=4）才算
  // 「不存在的歌xyz」包含「不存在的」(4字) 仍会误判，
  // 但再加长会让「诗超绊」这类 3 字歌名失效。折中取 4，
  // 并在 pipeline 里对 generating 结果不做强承诺（只说"在唱了"）。
  if (q.includes(t)) return t.length >= 4;

  // 查询是标题的子串：正常情况（用户只记得部分歌名）
  if (t.includes(q)) return q.length >= 2;

  return false;
}

/** 从 JSON 加载曲库配置。 */export function loadSongLibrary(path: string): SongEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return (raw as SongEntry[]).filter(
      (s) => typeof s.id === 'string' && typeof s.file === 'string',
    );
  } catch {
    return [];
  }
}

/** 把曲库渲染成一句话（用于提示用户）。 */
export function renderLibrary(songs: SongEntry[]): string {
  if (songs.length === 0) return '现在还没有会唱的歌';
  const names = songs.slice(0, 6).map((s) => s.title);
  return `会唱：${names.join('、')}${songs.length > 6 ? ' 等' : ''}`;
}

/** 组装默认曲库路径（相对项目根）。 */
export function defaultLibraryPath(root: string): string {
  return join(root, 'config', 'songs.json');
}
