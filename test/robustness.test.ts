/**
 * 健壮性测试：重试策略、消息分片、超时与退避。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { splitMessage } from '../src/core/pipeline.js';
import { LlmClient } from '../src/core/llm.js';
import { createLogger } from '../src/core/logger.js';
import type { LlmConfig } from '../src/config.js';

const logger = createLogger('test');

function mkLlmConfig(port: number, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'k',
    model: 'm',
    timeoutMs: 2_000,
    temperature: 0.9,
    maxTokens: 64,
    maxRetries: 2,
    retryBaseDelayMs: 10,
    ...overrides,
  };
}

interface ScriptedServer {
  server: Server;
  port: number;
  hits: () => number;
}

/** 按脚本依次返回状态码，最后重复最后一个。 */
function startScriptedServer(script: number[]): Promise<ScriptedServer> {
  let count = 0;
  const server = createServer((_req, res) => {
    const status = script[Math.min(count, script.length - 1)] ?? 200;
    count++;
    if (status === 200) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '好的' } }] }));
    } else {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? (addr.port as number) : 0;
      resolve({ server, port, hits: () => count });
    });
  });
}

let current: ScriptedServer | null = null;

afterEach(async () => {
  if (current) {
    await new Promise<void>((r) => current?.server.close(() => r()));
    current = null;
  }
});

describe('LLM 重试', () => {
  it('429 后重试成功', async () => {
    current = await startScriptedServer([429, 200]);
    const client = new LlmClient(mkLlmConfig(current.port), logger);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('好的');
    expect(result.attempts).toBe(2);
    expect(current.hits()).toBe(2);
  });

  it('5xx 连续失败则重试耗尽后抛出', async () => {
    current = await startScriptedServer([503]);
    const client = new LlmClient(mkLlmConfig(current.port, { maxRetries: 2 }), logger);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/503/);
    expect(current.hits()).toBe(3); // 首次 + 2 次重试
  });

  it('401 不做无意义重试', async () => {
    current = await startScriptedServer([401]);
    const client = new LlmClient(mkLlmConfig(current.port), logger);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/401/);
    expect(current.hits()).toBe(1);
  });

  it('400 参数错误不重试', async () => {
    current = await startScriptedServer([400]);
    const client = new LlmClient(mkLlmConfig(current.port), logger);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/400/);
    expect(current.hits()).toBe(1);
  });

  it('429 且带 Retry-After 时遵循服务端建议的等待', async () => {
    let count = 0;
    const server = createServer((_req, res) => {
      count++;
      if (count === 1) {
        res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' });
        res.end('{}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr !== null ? (addr.port as number) : 0);
      });
    });
    const client = new LlmClient(mkLlmConfig(port), logger);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('ok');
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('连接失败被判定为可重试', async () => {
    const client = new LlmClient(mkLlmConfig(1, { maxRetries: 1 }), logger);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });

  it('未配置 Key 时给出明确错误', async () => {
    const client = new LlmClient(mkLlmConfig(1, { apiKey: '' }), logger);
    expect(client.enabled).toBe(false);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/LLM_API_KEY/);
  });

  // 回归：推理模型把 token 全花在 reasoning 上导致 content 为空，
  // 旧实现会当成可重试错误白白重试，却不告诉用户真正原因。
  it('推理模型耗尽 token 时给出可操作的诊断且不重试', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: '', reasoning_content: '思考中……' },
              finish_reason: 'length',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 100 },
        }),
      );
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr !== null ? (addr.port as number) : 0);
      });
    });
    let hits = 0;
    server.on('request', () => hits++);

    const client = new LlmClient(mkLlmConfig(port, { maxTokens: 100, maxRetries: 3 }), logger);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/LLM_MAX_TOKENS/);
    expect(hits).toBe(1); // 配置类错误不应重试
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('消息分片', () => {
  it('短消息不切分', () => {
    expect(splitMessage('你好', 100)).toEqual(['你好']);
  });

  it('超长消息切分且总内容不丢失', () => {
    const text = '这是一句话。'.repeat(50); // 300 字
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    // 拼接后（去掉切分处空白）应与原文一致
    expect(chunks.join('')).toBe(text);
  });

  it('优先在句末标点处断开', () => {
    const text = '第一句很长很长很长。第二句也很长很长很长。第三句。';
    const chunks = splitMessage(text, 20);
    expect(chunks[0]?.endsWith('。')).toBe(true);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
  });

  it('没有自然断点时硬切，不丢字符', () => {
    const text = 'a'.repeat(50);
    const chunks = splitMessage(text, 20);
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe(text);
  });

  it('中文无空格长句也能切', () => {
    const text = '啊'.repeat(250) + '完';
    const chunks = splitMessage(text, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});
