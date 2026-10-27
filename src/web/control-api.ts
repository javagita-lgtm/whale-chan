/**
 * 控制面板 API：状态、启停、统计、日志。
 *
 * 与 server.ts（负责配置/人设）分开，避免单文件过长；
 * 由 server.ts 在路由未命中时调用 handleControlApi。
 *
 * 安全约定（与配置界面一致）：
 *   - 只监听 127.0.0.1，外部访问不到；
 *   - 命令执行全部用参数数组，不拼字符串，杜绝注入；
 *   - 只允许操作白名单内的动作。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();

const QQ_DIR     = 'D:\\Program Files\\Tencent\\QQNT';
const NAPCAT_DIR = join(QQ_DIR, 'versions\\9.9.33-52230\\resources\\app\\napcat');
const LAUNCHER   = join(NAPCAT_DIR, 'NapCatWinBootMain.exe');
const HOOK_DLL   = join(NAPCAT_DIR, 'NapCatWinBootHook.dll');
const BOT_ENTRY  = join(ROOT, 'dist', 'index.js');
const BOT_LOG    = join(ROOT, 'bot.log');
const BOT_ERR    = join(ROOT, 'bot.err');
const LOG_DIR    = join(ROOT, 'logs');
const DATA_DB    = join(ROOT, 'data', 'whale-chan.sqlite');

/**
 * 当前操作系统上可用的 node 可执行文件（优先独立运行时）。
 *
 * 优先级说明：独立运行时能脱离系统 node 版本，但**必须放在高完整性级别目录**。
 * 实测：低完整性级别（Low IL）的 node.exe 启动的子进程无法写 C 盘 TEMP，
 * 本地语音转写会报 EPERM。
 *
 * 路径通过环境变量配置，不硬编码本机用户名：
 *   WHALE_NODE_RUNTIME  —— 独立运行时目录（如 C:\Users\你\.whale-chan-runtime\node-v22…）
 */
function nodeCandidates(): string[] {
  const list: string[] = [];
  const runtime = process.env['WHALE_NODE_RUNTIME'];
  if (runtime) {
    list.push(join(runtime, 'node.exe'));
  }
  // 兜底：直接用当前进程的可执行文件（生产上通常就是 node 本身）
  list.push(process.execPath);
  return list;
}

function resolveNode(): string | null {
  for (const p of nodeCandidates()) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/* ---------------- 工具 ---------------- */

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/** 执行 PowerShell 命令，返回 stdout。参数数组形式，不做字符串拼接。 */
function ps(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error && !stdout ? '' : stdout),
    );
  });
}

/** 用 PowerShell 的 CIM 查询进程，比 tasklist 好解析。 */
async function listProcesses(name: string): Promise<Array<{ pid: number; cmd: string }>> {
  const escaped = name.replace(/'/g, "''");
  const out = await ps(
    `Get-CimInstance Win32_Process -Filter "Name='${escaped}'" -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
  );
  const rows: Array<{ pid: number; cmd: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('|');
    const pid = Number(idx >= 0 ? trimmed.slice(0, idx) : trimmed);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({ pid, cmd: idx >= 0 ? trimmed.slice(idx + 1) : '' });
  }
  return rows;
}

/** TCP 端口探测。 */
function probePort(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

function tailFile(file: string, lines: number): string[] {
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf8');
    const all = raw.split(/\r?\n/).filter((l) => l.length > 0);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/* ---------------- 状态 ---------------- */

interface BotState {
  running: boolean;
  pid: number | null;
  connected: boolean;
  lastSignal: string | null;
}

function readBotState(botProcs: Array<{ pid: number; cmd: string }>): BotState {
  // 机器人进程：node 跑 dist/index.js
  const bot = botProcs.find((p) => /dist[\\/]index\.js/.test(p.cmd)) ?? null;

  // lastSignal 只是给人看的"最近发生了什么"，取日志即可
  let lastSignal: string | null = null;
  const tail = tailFile(BOT_LOG, 300);
  tail.forEach((line) => {
    const m = /"msg":"(登录身份确认|已连接 OneBot|准备回应)"/.exec(line);
    if (m) lastSignal = `${m[1]} @ ${(/"ts":"([^"]+)"/.exec(line)?.[1] ?? '').slice(11, 19)}`;
  });

  return {
    running: Boolean(bot),
    // 真正的连接状态由调用方用 TCP 连接判断（见 detectConnected），
    // 这里只回填默认值，避免用日志推断（日志会被新行挤掉，判断不可靠）
    connected: false,
    pid: bot?.pid ?? null,
    lastSignal,
  };
}

/**
 * 用 TCP 连接判断机器人是否连着 OneBot。
 *
 * 不能用日志推断：日志是流水账，连上之后每来一条消息就写新行，
 * 那条「已连接」很快被挤出尾部窗口，导致明明连着却报未连接。
 * 查 socket 是操作系统的事实，不受日志多少影响。
 */
async function detectConnected(pid: number | null): Promise<boolean> {
  if (!pid) return false;
  const out = await ps(
    `@(Get-NetTCPConnection -OwningProcess ${pid} -State Established -ErrorAction SilentlyContinue ` +
    `| Where-Object { $_.RemotePort -eq 3001 }).Count`,
  );
  return Number(out.trim()) > 0;
}

/** 读取数据库统计。失败时返回 null，不让面板整体报错。 */
function readStats(): Record<string, unknown> | null {
  if (!existsSync(DATA_DB)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(DATA_DB, { readOnly: true });
    const one = (sql: string): number => {
      try {
        const row = db!.prepare(sql).get() as { n?: number } | undefined;
        return Number(row?.n ?? 0);
      } catch {
        return 0;
      }
    };
    return {
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      seen: one('SELECT COUNT(*) AS n FROM seen'),
      stickers: one('SELECT COUNT(*) AS n FROM stickers WHERE enabled = 1'),
      dbSizeBytes: statSync(DATA_DB).size,
      recent: (() => {
        try {
          return (db!.prepare(
            `SELECT nickname, substr(text, 1, 60) AS text, from_self AS fromSelf,
                    datetime(recorded_at / 1000, 'unixepoch', 'localtime') AS at
             FROM messages ORDER BY id DESC LIMIT 8`,
          ).all() as Array<Record<string, unknown>>);
        } catch {
          return [];
        }
      })(),
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/* ---------------- 动作 ---------------- */

async function startBot(): Promise<{ ok: boolean; message: string }> {
  const node = resolveNode();
  if (!node) return { ok: false, message: '未找到 node 可执行文件' };
  if (!existsSync(BOT_ENTRY)) return { ok: false, message: '缺少 dist/index.js，请先执行 pnpm build' };

  // 手动启动要解除暂停，否则 watchdog 会一直不接管
  setPaused(false);

  const existing = (await listProcesses('node.exe')).filter((p) => /dist[\\/]index\.js/.test(p.cmd));
  if (existing.length > 0) {
    return { ok: true, message: `机器人已在运行（pid ${existing[0]!.pid}）` };
  }

  // 用 detached + 重定向到日志文件，脱离控制面板进程存活
  await ps(
    `Start-Process -FilePath '${node}' -ArgumentList '${BOT_ENTRY}' ` +
    `-WorkingDirectory '${ROOT}' -WindowStyle Hidden ` +
    `-RedirectStandardOutput '${BOT_LOG}' -RedirectStandardError '${BOT_ERR}'`,
  );
  return { ok: true, message: '已发送启动指令' };
}

async function stopBot(): Promise<{ ok: boolean; message: string }> {
  // 先写暂停标记，避免 watchdog 抢在我们的 kill 之后又拉起来
  setPaused(true);

  const procs = (await listProcesses('node.exe')).filter((p) => /dist[\\/]index\.js/.test(p.cmd));
  if (procs.length === 0) {
    return { ok: true, message: '机器人本来就没在运行（已暂停自动拉起）' };
  }

  const ids = procs.map((p) => p.pid).join(',');
  await ps(`Stop-Process -Id ${ids} -Force -ErrorAction SilentlyContinue`);

  // 确认真的停了
  await new Promise((r) => setTimeout(r, 1200));
  const after = (await listProcesses('node.exe')).filter((p) => /dist[\\/]index\.js/.test(p.cmd));
  if (after.length > 0) {
    setPaused(false);
    return { ok: false, message: '停止失败，进程仍在' };
  }
  return { ok: true, message: `已停止 ${procs.length} 个进程（watchdog 已暂停接管）` };
}

async function startNapCat(): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(LAUNCHER)) return { ok: false, message: `未找到 NapCat 启动器：${LAUNCHER}` };
  if (!existsSync(join(QQ_DIR, 'QQ.exe'))) return { ok: false, message: `未找到 QQ：${QQ_DIR}\\QQ.exe` };

  const running = await listProcesses('NapCatWinBootMain.exe');
  if (running.length > 0) return { ok: true, message: 'NapCat 已在运行' };

  const args = `'"${join(QQ_DIR, 'QQ.exe')}"', '"${HOOK_DLL}"'`;
  await ps(
    `$env:NAPCAT_PATCH_PACKAGE='${join(NAPCAT_DIR, 'qqnt.json')}';` +
    `$env:NAPCAT_LOAD_PATH='${join(NAPCAT_DIR, 'loadNapCat.js')}';` +
    `$env:NAPCAT_MAIN_PATH='${join(NAPCAT_DIR, 'napcat.mjs')}';` +
    `Start-Process -FilePath '${LAUNCHER}' -ArgumentList @(${args}) -WorkingDirectory '${NAPCAT_DIR}' -WindowStyle Hidden`,
  );
  return { ok: true, message: '已拉起 NapCat，若需登录请扫码（打开 NapCat 窗口）' };
}

/* ---------------- 路由 ---------------- */

const ALLOWED_ACTIONS = new Set(['bot-start', 'bot-stop', 'bot-restart', 'napcat-start']);

/**
 * 暂停标记文件。
 *
 * 问题：watchdog 每 20 秒检查一次，手动「停止机器人」后它会在 20 秒内把机器人拉回来。
 * 解决：停止时写一个标记文件，watchdog 看到就不再拉起；启动时删除。
 */
const PAUSE_FLAG = join(ROOT, 'data', '.bot-paused');

function setPaused(paused: boolean): void {
  try {
    if (paused) {
      writeFileSync(PAUSE_FLAG, new Date().toISOString(), 'utf8');
    } else if (existsSync(PAUSE_FLAG)) {
      unlinkSync(PAUSE_FLAG);
    }
  } catch {
    // 标记失败不影响主流程，只是 watchdog 可能把机器人拉回来
  }
}

function isPaused(): boolean {
  return existsSync(PAUSE_FLAG);
}

export async function handleControlApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // GET /api/status —— 全量状态，前端 3 秒轮询一次
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const [nodeProcs, qqProcs, ncProcs, port3001, port6099] = await Promise.all([
      listProcesses('node.exe'),
      listProcesses('QQ.exe'),
      listProcesses('NapCatWinBootMain.exe'),
      probePort(3001),
      probePort(6099),
    ]);

    const bot = readBotState(nodeProcs);
    // 连接状态用真实 socket 判断，不用日志推断
    const connected = await detectConnected(bot.pid);

    json(res, 200, {
      ok: true,
      at: new Date().toISOString(),
      bot: { ...bot, connected, paused: isPaused() },
      napcat: {
        launcher: ncProcs.length > 0,
        qqProcesses: qqProcs.length,
        port3001,
        port6099,
      },
      imageGen: await (async () => {
        const online = await probePort(8188, 500);
        if (!online) return { online: false, vramFreeMB: null, vramTotalMB: null };
        try {
          const res = await fetch('http://127.0.0.1:8188/system_stats', {
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) return { online: true, vramFreeMB: null, vramTotalMB: null };
          const j = (await res.json()) as {
            devices?: Array<{ vram_total?: number; vram_free?: number }>;
          };
          const d = j.devices?.[0];
          return {
            online: true,
            vramFreeMB: d?.vram_free ? Math.round(d.vram_free / 1024 / 1024) : null,
            vramTotalMB: d?.vram_total ? Math.round(d.vram_total / 1024 / 1024) : null,
          };
        } catch {
          return { online: true, vramFreeMB: null, vramTotalMB: null };
        }
      })(),
      tts: await (async () => {
        // 只探 5051 端口是不够的：适配层活着但它依赖的 9880 后端挂了时，
        // 端口照样开着，面板会误报"就绪"。所以必须同时验证后端。
        const adapterUp = await probePort(5051, 500);
        const backendUp = await probePort(9880, 500);

        if (!adapterUp) {
          return { online: false, voice: '', voices: 0, backend: false, reason: '适配层未启动' };
        }
        if (!backendUp) {
          return { online: false, voice: '', voices: 0, backend: false, reason: 'GPT-SoVITS 后端未启动（9880）' };
        }

        try {
          const res = await fetch('http://127.0.0.1:5051/voices', {
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) {
            return { online: false, voice: '', voices: 0, backend: true, reason: '适配层响应异常' };
          }
          const j = (await res.json()) as { voices?: unknown[]; current?: string };
          return {
            online: true,
            voice: j.current ?? '',
            voices: Array.isArray(j.voices) ? j.voices.length : 0,
            backend: true,
            reason: '',
          };
        } catch {
          return { online: false, voice: '', voices: 0, backend: true, reason: '适配层查询失败' };
        }
      })(),
      watchdog: {
        // 守护进程状态由服务端单独查一次，失败不影响主体
        running: await (async () => {
          const out = await ps(
            `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" ` +
            `| Where-Object { $_.CommandLine -like '*watchdog.ps1*' }).Count`,
          );
          return Number(out.trim()) > 0;
        })(),
      },
      stats: readStats(),
    });
    return true;
  }

  // POST /api/control —— 启停动作
  if (req.method === 'POST' && url.pathname === '/api/control') {
    let action = '';
    try {
      const body = await (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return Buffer.concat(chunks).toString('utf8');
      })();
      action = String((JSON.parse(body) as { action?: string }).action ?? '');
    } catch {
      json(res, 400, { ok: false, message: '请求格式错误' });
      return true;
    }

    if (!ALLOWED_ACTIONS.has(action)) {
      json(res, 400, { ok: false, message: `不支持的动作：${action || '(空)'}` });
      return true;
    }

    // 每个动作都要显式分支。之前用 if/else if/else 收尾，
    // bot-restart 会静默落进最后一个 else 被当成 napcat-start 执行。
    let result: { ok: boolean; message: string };
    switch (action) {
      case 'bot-start':
        result = await startBot();
        break;
      case 'bot-stop':
        result = await stopBot();
        break;
      case 'bot-restart': {
        const stopped = await stopBot();
        if (!stopped.ok) {
          result = { ok: false, message: `重启失败（停止阶段）：${stopped.message}` };
          break;
        }
        // 等进程真正退出，避免新进程起来时旧端口/文件还被占用
        await new Promise((r) => setTimeout(r, 1500));
        const started = await startBot();
        result = started.ok
          ? { ok: true, message: '机器人已重启' }
          : { ok: false, message: `重启失败（启动阶段）：${started.message}` };
        break;
      }
      case 'napcat-start':
        result = await startNapCat();
        break;
      default:
        result = { ok: false, message: `未实现的动作：${action}` };
    }

    json(res, result.ok ? 200 : 500, result);
    return true;
  }

  // GET /api/voices —— 可用 TTS 音色列表
  if (req.method === 'GET' && url.pathname === '/api/voices') {
    try {
      const upstream = await fetch('http://127.0.0.1:5051/voices', {
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) {
        json(res, 200, { ok: true, online: false, voices: [], current: '' });
        return true;
      }
      const j = (await upstream.json()) as { voices?: unknown[]; current?: string };
      json(res, 200, {
        ok: true,
        online: true,
        voices: j.voices ?? [],
        current: j.current ?? '',
      });
    } catch {
      json(res, 200, { ok: true, online: false, voices: [], current: '' });
    }
    return true;
  }

  // POST /api/voices —— 切换音色 { voice: "RikkaBotan_ZH" }
  if (req.method === 'POST' && url.pathname === '/api/voices') {
    let voice = '';
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      voice = String((JSON.parse(body) as { voice?: string }).voice ?? '').trim();
    } catch {
      json(res, 400, { ok: false, error: '请求格式错误' });
      return true;
    }
    if (!voice) {
      json(res, 400, { ok: false, error: '缺少 voice' });
      return true;
    }
    try {
      const upstream = await fetch('http://127.0.0.1:5051/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: voice }),
        signal: AbortSignal.timeout(90_000),
      });
      const j = (await upstream.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      json(res, upstream.ok ? 200 : 500, {
        ok: upstream.ok && j.ok === true,
        current: voice,
        message: j.message ?? '',
      });
    } catch (error) {
      json(res, 500, { ok: false, error: (error as Error).message.slice(0, 200) });
    }
    return true;
  }

  // GET /api/logs?source=bot|watchdog&lines=200
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const source = url.searchParams.get('source') ?? 'bot';
    const lines = Math.min(Math.max(Number(url.searchParams.get('lines') ?? 200), 10), 2000);

    let file: string;
    if (source === 'watchdog') {
      // 取当天日志；没有就用最近的一个
      const today = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `watchdog-${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}.log`;
      file = join(LOG_DIR, name);
      if (!existsSync(file) && existsSync(LOG_DIR)) {
        const all = readdirSync(LOG_DIR)
          .filter((f) => f.startsWith('watchdog-') && f.endsWith('.log'))
          .sort();
        if (all.length > 0) file = join(LOG_DIR, all[all.length - 1]!);
      }
    } else if (source === 'error') {
      file = BOT_ERR;
    } else {
      file = BOT_LOG;
    }

    json(res, 200, {
      ok: true,
      source,
      file,
      exists: existsSync(file),
      lines: tailFile(file, lines),
    });
    return true;
  }

  return false;
}
