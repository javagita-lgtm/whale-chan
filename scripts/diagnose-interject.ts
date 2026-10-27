/**
 * 诊断「主动插话判断」为什么全是「不插话」。
 *
 * 直接调用真实模型，跑同一套 buildInterjectMessages，
 * 打印原始返回，判断问题在提示词、模型，还是解析环节。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInterjectMessages, parseInterjectVerdict } from '../src/core/interject-prompt.js';

const ROOT = process.cwd();
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s+|\s+$/g, ''))
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const baseUrl = env['LLM_BASE_URL'];
const apiKey = env['LLM_API_KEY'];
const model = env['LLM_MODEL'];

interface Ev {
  sender: { userId: string; nickname: string };
  text: string;
  peerId: string;
}

function mkBatch(items: Array<[string, string]>): Ev[] {
  return items.map(([nick, text]) => ({
    sender: { userId: nick, nickname: nick },
    text,
    peerId: '100000001',
  }));
}

// 三组不同"热度"的群聊，观察模型判断是否随内容变化
const cases: Array<{ name: string; items: Array<[string, string]> }> = [
  {
    name: 'A 闲聊有明显切口（本该接）',
    items: [
      ['Hans Deemo', '今天好累啊'],
      ['九土中横', '累就早点睡呗'],
      ['Hans Deemo', '睡不着，脑子里全是代码'],
    ],
  },
  {
    name: 'B 别人私聊性质（本该不接）',
    items: [
      ['Hans Deemo', '你那个快递到了吗'],
      ['九土中横', '到了，放门口了'],
      ['Hans Deemo', '行'],
    ],
  },
  {
    name: 'C 技术话题（本该接）',
    items: [
      ['Hans Deemo', 'docker 容器启动就退出'],
      ['九土中横', '看下 docker logs'],
      ['Hans Deemo', '日志啥也没有，退出码 0'],
    ],
  },
];

async function callModel(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.9 }),
  });
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: unknown;
  };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.choices?.[0]?.message?.content ?? '';
}

const messages = buildInterjectMessages(mkBatch(cases[0]!.items) as never, '鲸鱼酱', '鲸鱼酱');

console.log('=== 实际发送给模型的 system prompt ===');
console.log(messages[0]!.content);
console.log('\n=== user 部分 ===');
console.log(messages[1]!.content);
console.log('\n=== 三组内容的模型返回 ===');

for (const c of cases) {
  const msgs = buildInterjectMessages(mkBatch(c.items) as never, '鲸鱼酱', '鲸鱼酱');
  try {
    const raw = await callModel(msgs as never);
    const verdict = parseInterjectVerdict(raw);
    console.log(`\n--- ${c.name}`);
    console.log(`原始返回: ${JSON.stringify(raw).slice(0, 300)}`);
    console.log(`解析结果: speak=${verdict.speak}${verdict.opener ? ` opener=${verdict.opener}` : ''}`);
  } catch (e) {
    console.log(`\n--- ${c.name}\n调用失败: ${(e as Error).message}`);
  }
}
