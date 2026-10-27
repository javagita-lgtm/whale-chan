/**
 * 本地配置界面服务。
 *
 * 用途：不用手改 .env 和人设 JSON，在浏览器里改完点保存。
 *
 * 安全约定：
 *   - 只监听 127.0.0.1，外部无法访问；
 *   - 密钥类字段**不回传明文**，前端只看到「已设置」；
 *   - 保存时校验类型与范围，非法值拒绝写入；
 *   - 写 .env 用原子替换，避免写坏文件。
 *
 * 启动：pnpm config（默认 http://127.0.0.1:8787）
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA } from '../core/config-schema.js';
import {
  readEnv,
  writeEnv,
  toPublicValues,
  validateValues,
} from '../core/env-file.js';
import { handleControlApi } from './control-api.js';
import { handleImageApi } from './image-api.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.CONFIG_PORT ?? 8787);
const ROOT = process.cwd();

/** 读取请求体（限制大小）。 */
async function readBody(req: IncomingMessage, limit = 1024 * 512): Promise<string> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ---------------- 人设读写 ---------------- */

interface PersonaShape {
  id: string;
  name: string;
  systemPrompt: string;
  replyMaxChars?: number;
  replyTechMaxChars?: number;
  allowInterject?: boolean;
}

interface PersonaFileShape {
  defaultPersonaId: string;
  personas: PersonaShape[];
  groupBindings?: Record<string, string>;
}

function personaPath(): string {
  const env = readEnv(ROOT);
  return join(ROOT, env['PERSONA_FILE'] ?? 'config/persona.json');
}

function readPersonaFile(): PersonaFileShape {
  const p = personaPath();
  if (!existsSync(p)) {
    return { defaultPersonaId: 'whale', personas: [], groupBindings: {} };
  }
  return JSON.parse(readFileSync(p, 'utf8')) as PersonaFileShape;
}

function writePersonaFile(data: PersonaFileShape): void {
  const p = personaPath();
  writeFileSync(`${p}.tmp`, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(`${p}.tmp`, p);
}

/* ---------------- 页面 ---------------- */

function renderPage(): string {
  return readFileSync(join(ROOT, 'src', 'web', 'config.html'), 'utf8');
}

/* ---------------- 服务 ---------------- */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const parsed = new URL(url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    html(res, renderPage());
    return;
  }

  // 控制面板接口（状态 / 启停 / 日志 / 音色）交给独立模块
  if (parsed.pathname.startsWith('/api/status') ||
      parsed.pathname.startsWith('/api/control') ||
      parsed.pathname.startsWith('/api/voices') ||
      parsed.pathname.startsWith('/api/logs')) {
    const handled = await handleControlApi(req, res, parsed);
    if (handled) return;
  }

  // 生图接口（生成 / 取图 / 历史 / 释放显存）
  if (parsed.pathname.startsWith('/api/image/')) {
    const handled = await handleImageApi(req, res, parsed, ROOT);
    if (handled) return;
  }

  // 配置 schema + 当前值
  if (req.method === 'GET' && url === '/api/config') {
    const env = readEnv(ROOT);
    json(res, 200, {
      schema: CONFIG_SCHEMA,
      values: toPublicValues(env),
      restartHint: '修改后需重启机器人（pnpm start 或关闭当前进程重新启动）才会生效',
    });
    return;
  }

  // 保存配置
  if (req.method === 'POST' && url === '/api/config') {
    let payload: { values?: Record<string, unknown> };
    try {
      payload = JSON.parse(await readBody(req)) as typeof payload;
    } catch {
      json(res, 400, { ok: false, error: '请求格式错误' });
      return;
    }

    const { cleaned, errors } = validateValues(payload.values ?? {});
    if (errors.length > 0) {
      json(res, 422, { ok: false, errors });
      return;
    }

    // 与现有值合并：密钥占位保持原值，未提交的键保留
    const current = readEnv(ROOT);
    const merged: Record<string, string> = { ...current, ...cleaned };
    writeEnv(merged, ROOT);
    json(res, 200, { ok: true, saved: Object.keys(cleaned).length });
    return;
  }

  // 人设
  if (req.method === 'GET' && url === '/api/persona') {
    try {
      json(res, 200, { ok: true, data: readPersonaFile() });
    } catch (error) {
      json(res, 500, { ok: false, error: (error as Error).message });
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/persona') {
    let payload: { data?: PersonaFileShape };
    try {
      payload = JSON.parse(await readBody(req)) as typeof payload;
    } catch {
      json(res, 400, { ok: false, error: '请求格式错误' });
      return;
    }
    const data = payload.data;
    if (!data || !Array.isArray(data.personas)) {
      json(res, 400, { ok: false, error: '人设数据格式错误' });
      return;
    }
    // 基础校验
    for (const p of data.personas) {
      if (!p.id || !p.name || typeof p.systemPrompt !== 'string') {
        json(res, 422, { ok: false, error: '每个人设必须有 id、name、systemPrompt' });
        return;
      }
    }
    try {
      writePersonaFile(data);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 500, { ok: false, error: (error as Error).message });
    }
    return;
  }

  json(res, 404, { ok: false, error: 'Not Found' });
}

export function startConfigServer(): void {
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(error) });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  配置界面已启动：http://${HOST}:${PORT}\n`);
    console.log('  只监听本机，外部无法访问。Ctrl+C 退出。\n');
  });
}
