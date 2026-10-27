/**
 * 配置加载：所有配置从环境变量读取，密钥不落代码。
 *
 * 使用 Node 24 内置的 process.loadEnvFile（存在 .env 时自动加载），
 * 不引入 dotenv 依赖。缺省值保证「对齐 NapCat 默认配置即可跑通」。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LlmConfig {
  /** OpenAI 兼容接口的 base URL，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  /** API Key；为空时进入离线模式（只回显、不调模型） */
  apiKey: string;
  /** 模型名，默认 deepseek 4.1 flash */
  model: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 温度 */
  temperature: number;
  /** 单次回复最大 token 数 */
  maxTokens: number;
  /** 可重试错误的最大重试次数（0 表示不重试） */
  maxRetries: number;
  /** 重试基础退避（毫秒），实际按 2^n 指数增长并叠加抖动 */
  retryBaseDelayMs: number;
}

export interface OneBotConfig {
  /** OneBot v11 正向 WebSocket 地址（NapCat 默认 ws://127.0.0.1:3001） */
  wsUrl: string;
  /** 访问令牌，对应 NapCat 的 token 配置；为空表示不校验 */
  accessToken: string;
  /** 重连初始退避（毫秒） */
  reconnectMinMs: number;
  /** 重连最大退避（毫秒） */
  reconnectMaxMs: number;
}

export interface BotConfig {
  /** 机器人自身的 QQ 号，用于防自激与 @ 判定 */
  selfId: string;
  /** 回复前模拟的「正在输入」延迟上限（毫秒），0 表示不延迟 */
  typingDelayMaxMs: number;
  /** 单条消息最大字符数，超出则分片发送（QQ 单条约 2000 字符上限） */
  maxMessageChars: number;
  /** 同一会话两张表情包之间的最小间隔（毫秒），防刷屏 */
  stickerCooldownMs: number;
  /** 表情包发送概率（0~1），模型给出提示后还要过这道闸 */
  stickerRate: number;
}

export interface TriggerConfig {
  /** 群聊中需要 @ 机器人才回复 */
  requireAtInGroup: boolean;
  /** 每个群最小回复间隔（毫秒），防刷屏 */
  groupCooldownMs: number;
}

/**
 * 主动插话配置（默认关闭）。
 *
 * 采用「攒一批再判断」而不是「每条消息掷骰子」：
 * 前者调用次数与判断轮次挂钩，后者会随群消息量线性上涨。
 */
export interface InterjectConfig {
  /** 全局开关 */
  enabled: boolean;
  /** 显式允许插话的群号白名单；范围模式为 allowlist 时只有这些群生效 */
  allowGroups: string[];
  /** 范围：allowlist 仅白名单群；all 所有群 */
  scope: 'allowlist' | 'all';
  /** 攒够多少条消息后判断一次 */
  minMessages: number;
  /** 首条消息最多等多久后强制判断（毫秒） */
  maxWaitMs: number;
  /** 两轮插话之间的冷却（毫秒） */
  cooldownMs: number;
  /** 每群每小时最多插话次数，0 不限 */
  maxPerHour: number;
  /** 模型判断「该接」后的最终概率闸 */
  rate: number;
  /**
   * 判断时喂给模型的消息条数。
   * 实测同一段对话：3 条 → 模型说不接，15 条 → 模型说接。
   * 上下文太窄会把连贯话题切碎，导致判断趋于保守。
   */
  contextWidth: number;
}

export interface ContextConfig {
  /** 带入上下文的最近消息条数 */
  maxHistoryMessages: number;
  /** 上下文只保留最近多少分钟的对话 */
  historyWindowMinutes: number;
  /** 发送给模型的上下文字符上限（粗粒度保护，防止超长） */
  maxContextChars: number;
}

export interface VisionConfig {
  /** 是否启用图片识别（多模态） */
  enabled: boolean;
  /** 单条消息最多识别几张图 */
  maxImages: number;
}

/** 链接阅读与联网搜索。 */
export interface WebConfig {
  /** 是否允许打开用户发的链接 */
  linkEnabled: boolean;
  /** 单条消息最多抓几个链接 */
  maxLinks: number;
  /** 每个链接注入提示词的字符上限（超出截断） */
  maxCharsPerPage: number;
  /** 是否允许联网搜索 */
  searchEnabled: boolean;
  /** 搜索结果条数 */
  searchCount: number;
  /** 抓取/搜索超时（毫秒） */
  timeoutMs: number;
  /** 是否启用 B 站视频理解（弹幕+评论） */
  biliEnabled: boolean;
  /** 最多取多少条弹幕进提示词 */
  biliMaxDanmaku: number;
  /** 最多取多少条评论 */
  biliMaxComments: number;
  /** 是否启用 B 站深读（抽帧 + 转写） */
  biliDeepRead: boolean;
  /** 弹幕少于多少条时触发抽帧 */
  biliSparseThreshold: number;
  /** 抽帧最多几张 */
  biliMaxFrames: number;
  /** 视频短于多少秒才允许转写 */
  biliAsrMaxSeconds: number;
  /** 转写用的本地模型 */
  biliAsrModel: string;
  /** 本地 whisper 的 python 解释器 */
  biliAsrPython: string;
  /** 本地 whisper 的 transcribe.py */
  biliAsrScript: string;
  /** ffmpeg 路径 */
  ffmpegPath: string;
}

/** 本地语音合成（Style-Bert-VITS2 + RikkaBotan 中文萌系音色）。 */
export interface TtsConfig {
  /** 总开关 */
  enabled: boolean;
  /** TTS 服务地址 */
  baseUrl: string;
  /** 合成超时（毫秒） */
  timeoutMs: number;
  /** 单次最多朗读多少字（太长的语音在群里没人听） */
  maxChars: number;
}

export interface ImageGenConfig {
  /** 总开关 */
  enabled: boolean;
  /** ComfyUI 地址 */
  baseUrl: string;
  /** ComfyUI 输出目录（用于直接读文件发图） */
  outputDir: string;
  /** 默认 checkpoint */
  checkpoint: string;
  /** 生成超时（毫秒） */
  timeoutMs: number;
  /** 群聊里是否拦截 NSFW */
  blockNsfw: boolean;
  /** 闲置多少分钟自动卸载模型（0 = 不卸载） */
  idleUnloadMinutes: number;
}

/** 唱歌（SVC 翻唱 + 曲库）。 */
export interface SingConfig {
  /** 总开关 */
  enabled: boolean;
  /** 曲库配置路径（相对项目根） */
  libraryFile: string;
  /** 实时生成用哪个音色（用户没指定时） */
  defaultVoice: string;
  /** 生成超时（毫秒）；SVC 一首 4 分钟的歌要 3~5 分钟 */
  timeoutMs: number;
  /** 单次最长生成多少秒的音频（0 = 不限制） */
  maxSeconds: number;
  /** 片段模式最长多少秒（默认 45） */
  clipSeconds: number;
  /** 发完音频后是否追一句招呼 */
  afterword: boolean;
  /** 完整版生成后是否写入曲库 */
  saveToLibrary: boolean;
}

export interface AppConfig {
  llm: LlmConfig;
  onebot: OneBotConfig;
  bot: BotConfig;
  trigger: TriggerConfig;
  interject: InterjectConfig;
  context: ContextConfig;
  vision: VisionConfig;
  web: WebConfig;
  imageGen: ImageGenConfig;
  tts: TtsConfig;
  sing: SingConfig;
  /** 数据目录（SQLite 与日志） */
  dataDir: string;
  /** 人设文件路径（YAML/JSON 皆可，此处按 JSON 解析以零依赖） */
  personaFile: string;
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function envStr(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** 读取 .env（若存在）。失败不致命，配置仍可取系统环境变量。 */
export function loadEnvFile(cwd = process.cwd()): void {
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    console.warn(`[config] 加载 .env 失败：${(error as Error).message}`);
  }
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  loadEnvFile(cwd);
  const logLevelRaw = envStr('LOG_LEVEL', 'info').toLowerCase();
  const logLevel = (['debug', 'info', 'warn', 'error'] as const).includes(
    logLevelRaw as AppConfig['logLevel'],
  )
    ? (logLevelRaw as AppConfig['logLevel'])
    : 'info';

  return {
    llm: {
      baseUrl: envStr('LLM_BASE_URL', 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
      apiKey: envStr('LLM_API_KEY'),
      model: envStr('LLM_MODEL', 'deepseek-flash'),
      timeoutMs: envInt('LLM_TIMEOUT_MS', 60_000),
      temperature: envFloat('LLM_TEMPERATURE', 0.9),
      maxTokens: envInt('LLM_MAX_TOKENS', 512),
      maxRetries: envInt('LLM_MAX_RETRIES', 2),
      retryBaseDelayMs: envInt('LLM_RETRY_BASE_DELAY_MS', 800),
    },
    onebot: {
      wsUrl: envStr('ONEBOT_WS_URL', 'ws://127.0.0.1:3001'),
      accessToken: envStr('ONEBOT_ACCESS_TOKEN'),
      reconnectMinMs: envInt('ONEBOT_RECONNECT_MIN_MS', 1_000),
      reconnectMaxMs: envInt('ONEBOT_RECONNECT_MAX_MS', 30_000),
    },
    bot: {
      selfId: envStr('BOT_SELF_ID'),
      typingDelayMaxMs: envInt('BOT_TYPING_DELAY_MAX_MS', 0),
      maxMessageChars: envInt('BOT_MAX_MESSAGE_CHARS', 1500),
      stickerCooldownMs: envInt('BOT_STICKER_COOLDOWN_MS', 180_000),
      stickerRate: envFloat('BOT_STICKER_RATE', 1.0),
    },
    trigger: {
      requireAtInGroup: envBool('TRIGGER_REQUIRE_AT_IN_GROUP', true),
      groupCooldownMs: envInt('TRIGGER_GROUP_COOLDOWN_MS', 3_000),
    },
    interject: {
      enabled: envBool('INTERJECT_ENABLED', false),
      scope: envStr('INTERJECT_SCOPE', 'allowlist') === 'all' ? 'all' : 'allowlist',
      allowGroups: envStr('INTERJECT_GROUPS')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      minMessages: envInt('INTERJECT_MIN_MESSAGES', 8),
      maxWaitMs: envInt('INTERJECT_MAX_WAIT_MS', 180_000),
      cooldownMs: envInt('INTERJECT_COOLDOWN_MS', 600_000),
      maxPerHour: envInt('INTERJECT_MAX_PER_HOUR', 4),
      rate: envFloat('INTERJECT_RATE', 1.0),
      contextWidth: envInt('INTERJECT_CONTEXT_WIDTH', 15),
    },
    context: {
      maxHistoryMessages: envInt('CONTEXT_MAX_HISTORY_MESSAGES', 20),
      historyWindowMinutes: envInt('CONTEXT_HISTORY_WINDOW_MINUTES', 120),
      maxContextChars: envInt('CONTEXT_MAX_CHARS', 6_000),
    },
    vision: {
      enabled: envBool('VISION_ENABLED', true),
      maxImages: envInt('VISION_MAX_IMAGES', 2),
    },
    web: {
      linkEnabled: envBool('WEB_LINK_ENABLED', true),
      maxLinks: envInt('WEB_MAX_LINKS', 2),
      maxCharsPerPage: envInt('WEB_MAX_CHARS_PER_PAGE', 3000),
      searchEnabled: envBool('WEB_SEARCH_ENABLED', true),
      searchCount: envInt('WEB_SEARCH_COUNT', 5),
      timeoutMs: envInt('WEB_TIMEOUT_MS', 20_000),
      biliEnabled: envBool('BILI_ENABLED', true),
      biliMaxDanmaku: envInt('BILI_MAX_DANMAKU', 120),
      biliMaxComments: envInt('BILI_MAX_COMMENTS', 8),
      biliDeepRead: envBool('BILI_DEEP_READ', true),
      biliSparseThreshold: envInt('BILI_SPARSE_THRESHOLD', 30),
      biliMaxFrames: envInt('BILI_MAX_FRAMES', 12),
      biliAsrMaxSeconds: envInt('BILI_ASR_MAX_SECONDS', 600),
      biliAsrModel: envStr('BILI_ASR_MODEL', 'small'),
      biliAsrPython: envStr('BILI_ASR_PYTHON', 'D:\\VideoTranscribe\\venv\\Scripts\\python.exe'),
      biliAsrScript: envStr('BILI_ASR_SCRIPT', 'D:\\VideoTranscribe\\transcribe.py'),
      ffmpegPath: envStr('FFMPEG_PATH', 'ffmpeg'),
    },
    imageGen: {
      enabled: envBool('IMAGE_GEN_ENABLED', false),
      baseUrl: envStr('IMAGE_BASE_URL', 'http://127.0.0.1:8188'),
      outputDir: envStr('COMFY_OUTPUT_DIR', 'E:\\comfyUI\\output'),
      checkpoint: envStr('IMAGE_CHECKPOINT', 'dreamshaper_8.safetensors'),
      timeoutMs: envInt('IMAGE_TIMEOUT_MS', 120_000),
      blockNsfw: envBool('IMAGE_BLOCK_NSFW', true),
      idleUnloadMinutes: envInt('IMAGE_IDLE_UNLOAD_MIN', 10),
    },
    tts: {
      enabled: envBool('TTS_ENABLED', false),
      baseUrl: envStr('TTS_BASE_URL', 'http://127.0.0.1:5050'),
      timeoutMs: envInt('TTS_TIMEOUT_MS', 120_000),
      maxChars: envInt('TTS_MAX_CHARS', 120),
    },
    sing: {
      enabled: envBool('SING_ENABLED', true),
      libraryFile: envStr('SING_LIBRARY_FILE', 'config/songs.json'),
      defaultVoice: envStr('SING_DEFAULT_VOICE', 'soyo'),
      timeoutMs: envInt('SING_TIMEOUT_MS', 600_000),
      maxSeconds: envInt('SING_MAX_SECONDS', 300),
      clipSeconds: envInt('SING_CLIP_SECONDS', 45),
      afterword: envBool('SING_AFTERWORD', true),
      saveToLibrary: envBool('SING_SAVE_TO_LIBRARY', true),
    },
    dataDir: resolve(cwd, envStr('DATA_DIR', 'data')),
    personaFile: resolve(cwd, envStr('PERSONA_FILE', 'config/persona.json')),
    logLevel,
  };
}
