/**
 * 机器人能力工具集（function calling 定义）。
 *
 * ## 为什么要做这个
 *
 * 改造前有 16 个正则函数在做意图判断（`wantsSing` / `wantsImage` /
 * `looksLikeSearchIntent` …），每种说法都要补一个 pattern。
 * 实测踩到的洞：
 *   - 「放《This game》」→ 不触发放歌（漏了「放《」）
 *   - 「来点虎纹鲨鱼的BGM」→ 不触发
 *   - 「这首《X》我想听原版」→ 不触发
 *   - 「有首歌叫 X，放来听听」→ 不触发
 * 用户最自然的说法反而全废。
 *
 * 改成让模型语义判断后，上面 4 个刁钻说法 **4/4 全部正确命中**，
 * 而且一次 API 调用同时拿到意图和参数（曲名、模式）。
 *
 * ## 设计原则
 *
 * 1. **description 写触发场景，不要只写功能**
 *    实测只写「放歌」时模型经常不调用；
 *    写成「当用户想听某首歌、想放歌…包括「放XX」「来点XX的BGM」等说法」
 *    之后命中率明显提升。
 * 2. **参数尽量少**，必填项就一个，可选参数给 enum 约束
 * 3. **正则保留为兜底** —— 模型有概率该调不调，不能全指望它
 */

import type { ToolDef } from './llm.js';

/** 放歌 / 唱歌。 */
export const PLAY_SONG_TOOL: ToolDef = {
  name: 'play_song',
  description:
    '播放音乐或用角色音色翻唱一首歌。'
    + '【只在用户明确表达"想听某首歌"时才调用】。'
    + '可以调用的场景：'
    + '①用户点名了歌名并要听（「放《X》」「放一首 X」「想听 X」「来点 X」）；'
    + '②用户让机器人唱某首歌（「唱 X」「你来唱 X」）；'
    + '③用户说「放首歌」「随便放点音乐」这种没有具体歌名的泛请求；'
    + '④用户回答了上一轮问的"想听什么歌"（如「就那个吧」「鸟之诗」）。'
    + '\n【绝对不要调用的情况——这是最容易犯的错】：'
    + '×用户问视频/文章/图片/链接讲了什么（「这个视频说了什么」「详细讲讲」）→ 这是内容理解，不是听歌；'
    + '×用户问某首歌的信息（「X 是谁唱的」「X 是哪部番的」）→ 这是问答；'
    + '×用户聊天、提问、讨论任何话题；'
    + '×历史对话里出现过歌名，但当前这句没有要听的意思——**不要从历史里抓歌名**。'
    + '\n判断标准：当前这句话里，用户有没有"想听"或"想唱"的意图？没有就不要调用。',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          '歌曲名称（不带书名号）。'
          + '必须是**用户本句明确说出的歌名**。'
          + '如果用户没说歌名（如「放首歌」），留空。'
          + '绝对不要从历史对话里推断歌名。',
      },
      artist: {
        type: 'string',
        description: '歌手名（可选，用户本句提到时才填）',
      },
      mode: {
        type: 'string',
        enum: ['original', 'sing'],
        description:
          'original = 播放原唱（用户说「听」「放」「原版」「原唱」时选这个）；'
          + 'sing = 用角色音色翻唱（用户说「唱」「你来唱」时选这个）。'
          + '用户没说清楚时默认 original。',
      },
    },
    required: [],
  },
};

/** 生图。 */
export const GENERATE_IMAGE_TOOL: ToolDef = {
  name: 'generate_image',
  description:
    '生成一张图片。'
    + '当用户想画图、想要一张图、想生成插画/壁纸/头像/海报时调用。'
    + '包括这些说法：「画一张 X」「画个 X」「生成 X 的图」「来一张 X」'
    + '「帮我画 X」「X 的插画」。'
    + '注意：如果用户是在讨论绘画、问画风、问画家，不要调用。',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '画面描述（中文即可，保留用户说的主体、风格、构图、光线等细节）',
      },
      // 预留：参考图生图（姿势/服装/脸部）。
      // 暂不开放给模型——pipeline 还没接通参考图传递链路，
      // 现在给模型这个参数，它会填一个实际用不上的路径，反而误导。
      // 接通后在这里加 reference 字段即可（见 image-gen.ts 的 refImages 注释）。
    },
    required: ['prompt'],
  },
};

/** 联网搜索。 */
export const WEB_SEARCH_TOOL: ToolDef = {
  name: 'web_search',
  description:
    '联网搜索最新信息。'
    + '当用户问需要实时/最新资料的问题时调用：新闻、股价、天气、'
    + '最近发生的事、某个东西的最新版本、需要核实的事实。'
    + '也包括这些说法：「查一下 X」「搜搜 X」「X 是什么情况」「X 靠谱吗」'
    + '「帮我辟个谣」「有这回事吗」「再查查」。'
    + '注意：常识问题、闲聊、不需要实时信息的问题不要调用。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词。精简成核心词，不要带「帮我查」这类指令词。',
      },
      freshness: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year', 'any'],
        description: '时效要求。用户说「最新」「今天」用 day；没提就用 any。',
      },
    },
    required: ['query'],
  },
};

/** 语音回复。 */
export const SPEAK_TOOL: ToolDef = {
  name: 'speak',
  description:
    '用语音（TTS）回复，而不是纯文字。'
    + '当用户明确要求听声音时调用：说「说给我听」「念出来」「用语音回」'
    + '「读一下」「我想听你说话」。'
    + '注意：普通对话不要调用——默认就是文字回复，只有用户明确要语音才用。',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要朗读的内容。不填则朗读本次回复正文。',
      },
      emotion: {
        type: 'string',
        enum: ['happy', 'sad', 'angry', 'gentle', 'normal'],
        description: '情绪（可选，影响语气）',
      },
    },
    required: [],
  },
};

/** 全部工具。顺序即展示顺序，影响模型注意力，把高频的放前面。 */
export const ALL_TOOLS: ToolDef[] = [
  PLAY_SONG_TOOL,
  GENERATE_IMAGE_TOOL,
  WEB_SEARCH_TOOL,
  SPEAK_TOOL,
];

/** 按名称查工具。 */
export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
