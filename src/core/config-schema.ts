/**
 * 配置项元数据。
 *
 * 这一份 schema 同时驱动三件事：
 *   1. Web 配置界面的渲染（分组、类型、默认值、说明）
 *   2. 保存时的类型与范围校验
 *   3. `pnpm config:doc` 生成的说明文档
 *
 * 加新配置项时：先在这里登记，再在 config.ts 里读取即可。
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'secret' | 'list';

export interface FieldSpec {
  /** 环境变量名 */
  key: string;
  /** 界面显示名 */
  label: string;
  type: FieldType;
  /** 默认值（字符串形式，与 .env 一致） */
  default?: string;
  /** 数值范围（type=number 时生效） */
  min?: number;
  max?: number;
  /** 一句话说明 */
  help: string;
  /** 可选值（给定后界面渲染为下拉） */
  options?: string[];
  /** 需要重启才生效（大部分配置是启动时读取的） */
  requiresRestart?: boolean;
}

export interface SectionSpec {
  title: string;
  description: string;
  fields: FieldSpec[];
}

export const CONFIG_SCHEMA: SectionSpec[] = [
  {
    title: '模型',
    description: '决定机器人用哪个模型、怎么调。改完需要重启机器人。',
    fields: [
      {
        key: 'LLM_BASE_URL',
        label: 'API 地址',
        type: 'string',
        default: 'https://api.deepseek.com/v1',
        help: 'OpenAI 兼容端点。DeepSeek 官方为 https://api.deepseek.com/v1',
        requiresRestart: true,
      },
      {
        key: 'LLM_API_KEY',
        label: 'API Key',
        type: 'secret',
        help: '密钥。留空则进入离线模式（只回显，不调模型）',
        requiresRestart: true,
      },
      {
        key: 'LLM_MODEL',
        label: '模型 ID',
        type: 'string',
        default: 'deepseek-flash',
        help: '必须是服务商支持的准确 ID。DeepSeek 官方可用 deepseek-flash / deepseek-v4-pro',
        requiresRestart: true,
      },
      {
        key: 'LLM_MAX_TOKENS',
        label: '单次最大输出 token',
        type: 'number',
        default: '2048',
        min: 256,
        max: 8192,
        help: '推理模型会先花 token 思考，设太小会导致回复为空。推荐 1024~2048',
        requiresRestart: true,
      },
      {
        key: 'LLM_TEMPERATURE',
        label: '温度',
        type: 'number',
        default: '0.9',
        min: 0,
        max: 2,
        help: '越高越发散。群聊推荐 0.8~1.0',
        requiresRestart: true,
      },
      {
        key: 'LLM_TIMEOUT_MS',
        label: '请求超时（毫秒）',
        type: 'number',
        default: '60000',
        min: 5000,
        max: 300000,
        help: '单次模型请求的最长等待时间',
        requiresRestart: true,
      },
      {
        key: 'LLM_MAX_RETRIES',
        label: '重试次数',
        type: 'number',
        default: '2',
        min: 0,
        max: 5,
        help: '429/5xx/网络错误的重试次数。401/400 这类不会重试',
        requiresRestart: true,
      },
      {
        key: 'LLM_RETRY_BASE_DELAY_MS',
        label: '重试基础退避（毫秒）',
        type: 'number',
        default: '800',
        min: 100,
        max: 10000,
        help: '按 2 的幂次递增，并叠加随机抖动',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '连接（OneBot / NapCat）',
    description: '机器人与 QQ 协议端之间的连接参数。',
    fields: [
      {
        key: 'ONEBOT_WS_URL',
        label: 'WebSocket 地址',
        type: 'string',
        default: 'ws://127.0.0.1:3001',
        help: 'NapCat 里配置的「WebSocket 服务器」地址',
        requiresRestart: true,
      },
      {
        key: 'ONEBOT_ACCESS_TOKEN',
        label: '访问令牌',
        type: 'secret',
        help: '需与 NapCat 里配置的 Token 一致；留空表示不校验',
        requiresRestart: true,
      },
      {
        key: 'BOT_SELF_ID',
        label: '机器人 QQ 号',
        type: 'string',
        default: '',
        help: '用于防自激和 @ 判定。留空会从事件里自动学习',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '回复行为',
    description: '控制机器人怎么说话、说多少、什么时候说。',
    fields: [
      {
        key: 'TRIGGER_REQUIRE_AT_IN_GROUP',
        label: '群聊必须 @ 才回复',
        type: 'boolean',
        default: 'true',
        help: '关闭后未 @ 的消息也会走插话流程（由下一节控制）',
        requiresRestart: true,
      },
      {
        key: 'TRIGGER_GROUP_COOLDOWN_MS',
        label: '同群最小回复间隔（毫秒）',
        type: 'number',
        default: '3000',
        min: 0,
        max: 600000,
        help: '防止刷屏。0 表示不限制',
        requiresRestart: true,
      },
      {
        key: 'BOT_MAX_MESSAGE_CHARS',
        label: '单条消息字数上限',
        type: 'number',
        default: '1500',
        min: 200,
        max: 4000,
        help: '超过则自动分片发送。QQ 单条约 2000 字上限',
        requiresRestart: true,
      },
      {
        key: 'BOT_TYPING_DELAY_MAX_MS',
        label: '打字延迟上限（毫秒）',
        type: 'number',
        default: '0',
        min: 0,
        max: 10000,
        help: '回复前随机停顿，模拟真人打字。0 表示不延迟',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '主动插话',
    description: '无人 @ 时自己接话。会显著增加 token 消耗，默认关闭。',
    fields: [
      {
        key: 'INTERJECT_ENABLED',
        label: '启用主动插话',
        type: 'boolean',
        default: 'false',
        help: '开启后，未 @ 的消息会攒批判断一次要不要接',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_SCOPE',
        label: '生效范围',
        type: 'string',
        default: 'allowlist',
        options: ['allowlist', 'all'],
        help: 'allowlist=只在下方的群生效；all=所有群',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_GROUPS',
        label: '允许插话的群号',
        type: 'list',
        default: '',
        help: '逗号分隔的群号，例如 100000001,987654321',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_MIN_MESSAGES',
        label: '攒多少条判断一次',
        type: 'number',
        default: '8',
        min: 2,
        max: 50,
        help: '触发频率。太小会频繁判断（费 token），太大会接话很迟',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_CONTEXT_WIDTH',
        label: '判断时看多少条上下文',
        type: 'number',
        default: '15',
        min: 3,
        max: 40,
        help: '比"攒多少条"更影响判断质量：只看 3 条会把话题切碎，模型倾向保守地说不接',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_MAX_WAIT_MS',
        label: '最长等待（毫秒）',
        type: 'number',
        default: '180000',
        min: 10000,
        max: 3600000,
        help: '攒不够条数时，等这么久也会判断一次',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_COOLDOWN_MS',
        label: '插话冷却（毫秒）',
        type: 'number',
        default: '600000',
        min: 0,
        max: 7200000,
        help: '两轮插话之间的最小间隔，默认 10 分钟',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_MAX_PER_HOUR',
        label: '每小时上限',
        type: 'number',
        default: '4',
        min: 0,
        max: 60,
        help: '每群每小时最多插话几次，0 表示不限',
        requiresRestart: true,
      },
      {
        key: 'INTERJECT_RATE',
        label: '最终概率',
        type: 'number',
        default: '1',
        min: 0,
        max: 1,
        help: '模型判断「该接」后，再按此概率决定是否真的接',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '表情包',
    description: '图库与发图相关。需先运行 pnpm stickers:fetch 建库。',
    fields: [
      {
        key: 'BOT_STICKER_RATE',
        label: '发图概率',
        type: 'number',
        default: '1',
        min: 0,
        max: 1,
        help: '模型选定图片后，按此概率决定是否真的发送。1 表示只要选了就发',
        requiresRestart: true,
      },
      {
        key: 'BOT_STICKER_COOLDOWN_MS',
        label: '发图冷却（毫秒）',
        type: 'number',
        default: '180000',
        min: 0,
        max: 3600000,
        help: '同一会话两表情包之间的最小间隔，默认 3 分钟',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '图片识别',
    description: '多模态能力。需要模型支持 vision（deepseek-flash 支持，deepseek-v4-pro 不支持）。',
    fields: [
      {
        key: 'VISION_ENABLED',
        label: '启用图片识别',
        type: 'boolean',
        default: 'true',
        help: '开启后机器人能看懂对方发的图片',
        requiresRestart: true,
      },
      {
        key: 'VISION_MAX_IMAGES',
        label: '单条最多识别几张',
        type: 'number',
        default: '2',
        min: 1,
        max: 9,
        help: '越多越贵，一般 1~2 张够用',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '网页与搜索',
    description:
      '让机器人能打开你发的链接、也能自己联网查资料。' +
      '底层用 DeepSeek 官方 Search/Fetch 接口，按次计费（每千次 5 元），失败不计费。',
    fields: [
      {
        key: 'WEB_LINK_ENABLED',
        label: '允许打开链接',
        type: 'boolean',
        default: 'true',
        help: '消息里带 http(s) 链接时，抓取网页正文给模型看',
        requiresRestart: true,
      },
      {
        key: 'WEB_MAX_LINKS',
        label: '单条最多看几个链接',
        type: 'number',
        default: '2',
        min: 1,
        max: 5,
        help: '每个链接都是一次 Fetch 计费，别设太大',
        requiresRestart: true,
      },
      {
        key: 'WEB_MAX_CHARS_PER_PAGE',
        label: '每个网页最多取多少字',
        type: 'number',
        default: '3000',
        min: 500,
        max: 20000,
        help: '正文会截断到这个长度再喂给模型，太长会挤占上下文',
        requiresRestart: true,
      },
      {
        key: 'WEB_SEARCH_ENABLED',
        label: '允许联网搜索',
        type: 'boolean',
        default: 'true',
        help: '识别到「查一下 / 最新消息 / 多少钱」这类意图时自动搜索',
        requiresRestart: true,
      },
      {
        key: 'WEB_SEARCH_COUNT',
        label: '搜索取几条结果',
        type: 'number',
        default: '5',
        min: 1,
        max: 20,
        help: '条数不影响单次计费，但越多越占上下文',
        requiresRestart: true,
      },
      {
        key: 'WEB_TIMEOUT_MS',
        label: '抓取超时（毫秒）',
        type: 'number',
        default: '20000',
        min: 3000,
        max: 60000,
        help: '超时就放弃这批资料，照常回复',
        requiresRestart: true,
      },
      {
        key: 'BILI_ENABLED',
        label: 'B站视频理解',
        type: 'boolean',
        default: 'true',
        help: '发 B 站链接时抓弹幕和评论，让模型据此聊视频内容（匿名可用，无需登录）',
        requiresRestart: true,
      },
      {
        key: 'BILI_MAX_DANMAKU',
        label: '最多取多少条弹幕',
        type: 'number',
        default: '120',
        min: 20,
        max: 400,
        help: '按时间均匀采样，只挑信息量大的。太多会挤占上下文',
        requiresRestart: true,
      },
      {
        key: 'BILI_MAX_COMMENTS',
        label: '最多取多少条评论',
        type: 'number',
        default: '8',
        min: 0,
        max: 30,
        help: '按热度排序取前几条，0 表示不要评论',
        requiresRestart: true,
      },
      {
        key: 'BILI_DEEP_READ',
        label: 'B站深读（抽帧+转写）',
        type: 'boolean',
        default: 'true',
        help: '弹幕不够时下载视频抽帧看画面，或转写台词。需要本机 ffmpeg 和 whisper',
        requiresRestart: true,
      },
      {
        key: 'BILI_SPARSE_THRESHOLD',
        label: '弹幕少于多少条才抽帧',
        type: 'number',
        default: '30',
        min: 0,
        max: 500,
        help: '热门视频弹幕够用就秒回，只有冷门视频才值得多花十几秒看画面',
        requiresRestart: true,
      },
      {
        key: 'BILI_MAX_FRAMES',
        label: '抽帧最多几张',
        type: 'number',
        default: '12',
        min: 3,
        max: 30,
        help: '每张约 300~500 token，太多会挤占上下文',
        requiresRestart: true,
      },
      {
        key: 'BILI_ASR_MAX_SECONDS',
        label: '转写只做多短的视频（秒）',
        type: 'number',
        default: '600',
        min: 60,
        max: 7200,
        help: '长视频 GPU 转写太慢，群里等不起。600 秒 = 10 分钟',
        requiresRestart: true,
      },
      {
        key: 'BILI_ASR_MODEL',
        label: '转写模型',
        type: 'string',
        default: 'small',
        help: 'small 约 20 倍实时（推荐）；large-v3 更准但只有 3.5 倍',
        requiresRestart: true,
      },
      {
        key: 'BILI_ASR_PYTHON',
        label: 'whisper python 路径',
        type: 'string',
        default: 'D:\\VideoTranscribe\\venv\\Scripts\\python.exe',
        help: '本地 whisper 环境的解释器',
        requiresRestart: true,
      },
      {
        key: 'BILI_ASR_SCRIPT',
        label: 'transcribe.py 路径',
        type: 'string',
        default: 'D:\\VideoTranscribe\\transcribe.py',
        help: '转写脚本',
        requiresRestart: true,
      },
      {
        key: 'FFMPEG_PATH',
        label: 'ffmpeg 路径',
        type: 'string',
        default: 'ffmpeg',
        help: '抽帧用。填 ffmpeg 表示走 PATH',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '上下文',
    description: '机器人能记住多少聊天内容。',
    fields: [
      {
        key: 'CONTEXT_MAX_HISTORY_MESSAGES',
        label: '带入上下文的消息条数',
        type: 'number',
        default: '20',
        min: 0,
        max: 100,
        help: '越多越连贯，但也越贵',
        requiresRestart: true,
      },
      {
        key: 'CONTEXT_HISTORY_WINDOW_MINUTES',
        label: '时间窗口（分钟）',
        type: 'number',
        default: '120',
        min: 5,
        max: 1440,
        help: '只取这段时间内的消息',
        requiresRestart: true,
      },
      {
        key: 'CONTEXT_MAX_CHARS',
        label: '上下文字符上限',
        type: 'number',
        default: '6000',
        min: 500,
        max: 20000,
        help: '超过则从最早的消息开始丢弃',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '其他',
    description: '数据目录、日志等杂项。',
    fields: [
      {
        key: 'LOG_LEVEL',
        label: '日志级别',
        type: 'string',
        default: 'info',
        options: ['debug', 'info', 'warn', 'error'],
        help: 'debug 会输出大量细节，排查问题用',
        requiresRestart: true,
      },
      {
        key: 'DATA_DIR',
        label: '数据目录',
        type: 'string',
        default: 'data',
        help: 'SQLite 与表情包存放位置',
        requiresRestart: true,
      },
      {
        key: 'PERSONA_FILE',
        label: '人设文件',
        type: 'string',
        default: 'config/persona.json',
        help: '人设配置路径',
        requiresRestart: true,
      },
    ],
  },
  {
    title: '本地生图',
    description:
      '用本机 ComfyUI 出图，完全免费、不联网。' +
      '说「画个xxx」就会生成。512×512 约 9 秒，模型常驻占 3.3GB 显存。',
    fields: [
      {
        key: 'IMAGE_GEN_ENABLED',
        label: '启用生图',
        type: 'boolean',
        default: 'false',
        help: '开启后群里说「画个xxx」会生成图片',
        requiresRestart: true,
      },
      {
        key: 'IMAGE_BASE_URL',
        label: 'ComfyUI 地址',
        type: 'string',
        default: 'http://127.0.0.1:8188',
        help: '本地 ComfyUI 的 HTTP 接口地址',
        requiresRestart: true,
      },
      {
        key: 'IMAGE_CHECKPOINT',
        label: '默认模型',
        type: 'string',
        default: 'dreamshaper_8.safetensors',
        help: 'checkpoints 目录下的文件名',
        requiresRestart: true,
      },
      {
        key: 'COMFY_OUTPUT_DIR',
        label: 'ComfyUI 输出目录',
        type: 'string',
        default: 'E:\\comfyUI\\output',
        help: '生成的图片存放在这，机器人直接读文件发送',
        requiresRestart: true,
      },
      {
        key: 'IMAGE_TIMEOUT_MS',
        label: '生成超时（毫秒）',
        type: 'number',
        default: '120000',
        min: 30000,
        max: 300000,
        help: '超过这个时间就放弃，避免卡死',
        requiresRestart: true,
      },
      {
        key: 'IMAGE_BLOCK_NSFW',
        label: '群聊拦截露骨内容',
        type: 'boolean',
        default: 'true',
        help: 'QQ 群图片有审核，违规会封号。私聊不受此限制',
        requiresRestart: true,
      },
      {
        key: 'IMAGE_IDLE_UNLOAD_MIN',
        label: '闲置多少分钟释放显存',
        type: 'number',
        default: '10',
        min: 0,
        max: 120,
        help: '0 表示不释放。模型常驻占 3.3GB，闲置释放后降回 1.1GB',
        requiresRestart: true,
      },
    ],
  },
];

/** 按 key 查字段定义。 */
export function findField(key: string): FieldSpec | undefined {
  for (const section of CONFIG_SCHEMA) {
    const f = section.fields.find((x) => x.key === key);
    if (f) return f;
  }
  return undefined;
}
