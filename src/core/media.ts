/**
 * B 站媒体处理：下载视频流、抽帧、下载音频、本地 ASR 转写。
 *
 * 三件事各自的取舍：
 *
 * 1. 下载视频流而不是网页
 *    网页只有标题，视频流才有画面。选 480p H.264：够看清画面和字幕，
 *    体积小（106 秒仅 0.83MB），且 H.264 兼容性最好，ffmpeg 不用额外解码器。
 *
 * 2. 抽帧而不是逐帧分析
 *    模型按图计费，逐帧不可能。按时长自适应间隔 + 帧数硬上限，
 *    保证长视频不会把 token 打爆。
 *
 * 3. ASR 走本机已有的 faster-whisper
 *    复用 D:\VideoTranscribe 的 venv 和模型（large-v3 + small 已下载），
 *    不重新装、不联网上传，音频不出本机。
 *
 * 失败处理：任何一步失败都返回 null / 空数组，绝不让调用方崩掉。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from './logger.js';

const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
} as const;

/** 一帧提取结果。 */
export interface Frame {
  /** 时间点（秒） */
  time: number;
  /** 图片的 base64 data URL，可直接送多模态模型 */
  dataUrl: string;
  bytes: number;
}

export interface TranscribeResult {
  /** 带时间戳的文本行 */
  lines: string[];
  /** 纯文本（已合并分段） */
  text: string;
  /** 音频时长（秒） */
  duration: number;
  /** 转写耗时（秒） */
  elapsedSec: number;
  model: string;
}

export interface MediaOptions {
  logger: Logger;
  /** ffmpeg 可执行文件 */
  ffmpegPath: string;
  /** 本地 whisper 的 python 解释器 */
  pythonPath: string;
  /** transcribe.py 路径 */
  transcribeScript: string;
  /** 模型名（small / large-v3） */
  asrModel: string;
  /** 下载超时 */
  timeoutMs: number;
}

/** 一次下载的目标（音频或视频）。 */
interface StreamCandidate {
  url: string;
  bandwidth: number;
  codecs?: string;
  width?: number;
  height?: number;
}

/**
 * 按视频时长决定抽帧间隔与帧数。
 *
 * 原则：短视频抽密一点（看得清），长视频抽稀一点（控成本），
 * 但帧数永远不超过上限，否则 token 会失控。
 */
export function planFrames(durationSec: number, maxFrames = 12): { interval: number; count: number } {
  const dur = Math.max(1, durationSec);
  // 目标帧数：短片逐秒密采，长片至少覆盖首尾
  const idealInterval =
    dur <= 60 ? 6 :
    dur <= 180 ? 12 :
    dur <= 600 ? 30 :
    dur <= 1800 ? 60 :
    120;

  let count = Math.ceil(dur / idealInterval);
  let interval = idealInterval;

  if (count > maxFrames) {
    count = maxFrames;
    interval = Math.ceil(dur / maxFrames);
  }
  return { interval, count };
}

/** 把毫秒超时包一层，避免子进程挂死。 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`超时（${ms}ms）`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 建目录，带重试。
 *
 * 为什么需要：实测偶发 EPERM（火绒 HIPS 的 sysdiag 驱动会短暂拦截
 * 程序创建目录的行为，尤其在新进程首次 spawn 子进程时）。
 * 同一条命令连跑 4 次里成功 4 次，说明是瞬时的，退避重试即可。
 */
function mkdirWithRetry(dir: string, attempts = 4): void {
  let lastError: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      mkdirSync(dir, { recursive: true });
      return;
    } catch (error) {
      lastError = error as Error;
      const code = (error as NodeJS.ErrnoException).code;
      // 只有权限/占用类错误值得重试；其他错误（如路径非法）重试没用
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOENT') {
        throw error;
      }
      // 同步退避：50ms、100ms、200ms
      const waitMs = 50 * 2 ** i;
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        // 同步忙等，因为调用方是同步上下文
      }
    }
  }
  throw lastError ?? new Error(`无法创建目录：${dir}`);
}

export class BiliMedia {
  constructor(private readonly options: MediaOptions) {}

  get asrAvailable(): boolean {
    return existsSync(this.options.pythonPath) && existsSync(this.options.transcribeScript);
  }

  get ffmpegAvailable(): boolean {
    const p = this.options.ffmpegPath;
    if (!p) return false;
    // 可以是绝对路径，也可以只是 "ffmpeg"（走 PATH）。
    // 前者用 existsSync 判断，后者无法预判，交给 spawn 时如果找不到会抛 ENOENT。
    if (p.includes('\\') || p.includes('/')) return existsSync(p);
    return true;
  }

  /**
   * 下载视频流并抽帧。
   *
   * @param playurl DASH 流信息（由 bilibili.ts 提供）
   * @param durationSec 视频时长，用于规划抽帧
   * @param maxFrames 帧数上限
   */
  async extractFrames(
    videoUrl: string,
    durationSec: number,
    maxFrames = 12,
  ): Promise<Frame[]> {
    if (!this.ffmpegAvailable) {
      this.options.logger.info('缺少 ffmpeg，跳过抽帧', { path: this.options.ffmpegPath });
      return [];
    }

    const workDir = join(tmpdir(), `wc-frames-${Date.now()}`);
    const videoPath = join(workDir, 'video.m4s');
    const frameDir = join(workDir, 'frames');

    try {
      mkdirWithRetry(frameDir);

      // 1) 下载视频流
      const size = await this.download(videoUrl, videoPath);
      if (size === 0) return [];
      this.options.logger.info('视频流下载完成', { mb: +(size / 1024 / 1024).toFixed(2) });

      // 2) 按规划抽帧
      const plan = planFrames(durationSec, maxFrames);
      const fps = `1/${plan.interval}`;
      await this.runFfmpeg([
        '-y',
        '-i', videoPath,
        // fps=1/N 表示每 N 秒一帧；scale 限制宽度，避免超大图浪费 token
        '-vf', `fps=${fps},scale=640:-2`,
        '-q:v', '4',
        join(frameDir, 'f%04d.jpg'),
      ]);

      const files = readdirSync(frameDir).filter((f) => f.endsWith('.jpg')).sort();
      if (files.length === 0) {
        this.options.logger.info('抽帧结果为空');
        return [];
      }

      // 3) 转成 data URL
      const frames: Frame[] = [];
      for (let i = 0; i < files.length; i++) {
        const buf = readFileSync(join(frameDir, files[i] as string));
        // 第 i 帧对应抽帧后的时间点
        const time = Math.min(durationSec, i * plan.interval);
        frames.push({
          time,
          dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
          bytes: buf.length,
        });
      }

      this.options.logger.info('抽帧完成', {
        count: frames.length,
        interval: plan.interval,
        totalKB: Math.round(frames.reduce((s, f) => s + f.bytes, 0) / 1024),
      });
      return frames;
    } catch (error) {
      this.options.logger.info('抽帧失败', { message: (error as Error).message.slice(0, 160) });
      return [];
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /**
   * 下载音频并用本地 whisper 转写。
   *
   * 音轨选最低码率：ASR 对音质要求不高，最低码率文件最小、下载最快，
   * 也让 25MB 上限能覆盖更长的视频（44kbps 可覆盖 75 分钟）。
   */
  async transcribeAudio(
    audioUrl: string,
    durationSec: number,
    signal?: AbortSignal,
  ): Promise<TranscribeResult | null> {
    if (!this.asrAvailable) {
      this.options.logger.info('本地 ASR 不可用', {
        python: this.options.pythonPath,
        script: this.options.transcribeScript,
      });
      return null;
    }

    const workDir = join(tmpdir(), `wc-asr-${Date.now()}`);
    // 输入文件名唯一化：transcribe.py 会用输入文件名去 work/wav 下建缓存，
    // 名字固定成 audio 的话多任务会互相覆盖，也没法精确清理自己的产物。
    const stem = `wc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const audioPath = join(workDir, `${stem}.m4a`);
    const outDir = join(workDir, 'out');

    try {
      mkdirWithRetry(outDir);

      const size = await this.download(audioUrl, audioPath);
      if (size === 0) return null;
      this.options.logger.info('音轨下载完成', { mb: +(size / 1024 / 1024).toFixed(2) });

      const startedAt = Date.now();
      const out = await this.runTranscribe(audioPath, outDir, signal);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

      // transcribe.py 输出 <stem>.ts.txt（带时间戳）和 <stem>.txt
      const tsFile = join(outDir, `${stem}.ts.txt`);
      const txtFile = join(outDir, `${stem}.txt`);

      if (!existsSync(txtFile)) {
        this.options.logger.info('转写未产出文本', { stdout: out.slice(-300) });
        return null;
      }

      const text = readFileSync(txtFile, 'utf8').trim();
      const lines = existsSync(tsFile)
        ? readFileSync(tsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
        : [];

      if (text.length === 0) {
        this.options.logger.info('转写结果为空（可能视频无语音）');
        return null;
      }

      this.options.logger.info('转写完成', {
        chars: text.length,
        segments: lines.length,
        elapsedSec,
        speedup: durationSec > 0 ? `${(durationSec / Math.max(1, elapsedSec)).toFixed(1)}x` : 'n/a',
      });

      return {
        lines,
        text,
        duration: durationSec,
        elapsedSec,
        model: this.options.asrModel,
      };
    } catch (error) {
      this.options.logger.info('转写失败', { message: (error as Error).message.slice(0, 160) });
      return null;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      this.cleanTranscribeCache(stem);
    }
  }

  /**
   * 清理 transcribe.py 自己的缓存目录。
   *
   * 它会把音频解成 16k wav 存到 <脚本目录>/work/wav/，不随我的临时目录一起删。
   * 现在输入文件名带唯一后缀，所以能精确删掉本次的产物。
   * 另外顺手清理一小时前的孤儿文件（进程崩溃时 finally 没跑到）。
   *
   * 只碰 wc 前缀的文件，不碰用户手动拖进去转录的其他文件。
   */
  private cleanTranscribeCache(stem?: string): void {
    try {
      const scriptDir = this.options.transcribeScript.replace(/[\\/][^\\/]+$/, '');
      const wavDir = join(scriptDir, 'work', 'wav');
      if (!existsSync(wavDir)) return;

      const now = Date.now();
      for (const name of readdirSync(wavDir)) {
        // 只清理我们生成的（wc 前缀 + .16k.wav）
        if (!/^wc[0-9a-z]+(\.[^.]+)*\.16k\.wav$/i.test(name)) continue;
        const full = join(wavDir, name);
        try {
          // 本次的产物直接删；其他 wc 文件超过 1 小时算孤儿
          const isMine = stem ? name.startsWith(`${stem}.`) : false;
          const ageMs = now - statSync(full).mtimeMs;
          if (isMine || ageMs > 3_600_000) rmSync(full, { force: true });
        } catch {
          /* 单个文件失败不影响其他 */
        }
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  /** 下载到本地文件，返回字节数；失败返回 0。 */
  private async download(url: string, dest: string): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: BILI_HEADERS,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import('node:fs');
      writeFileSync(dest, buf);
      return buf.length;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`下载超时（${this.options.timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private runFfmpeg(args: string[]): Promise<string> {
    return withTimeout(
      new Promise<string>((resolve, reject) => {
        const child = spawn(this.options.ffmpegPath, args, { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
          // ffmpeg 抽帧成功也常返回非 0（比如只有 warning），以产物存在为准
          if (code === 0 || stderr.includes('frame=')) resolve(stderr);
          else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-200)}`));
        });
      }),
      60_000,
      () => {
        /* 子进程由 close 事件清理 */
      },
    );
  }

  private runTranscribe(audioPath: string, outDir: string, signal?: AbortSignal): Promise<string> {
    const args = [
      this.options.transcribeScript,
      audioPath,
      '--model', this.options.asrModel,
      '--lang', 'zh',
      '--format', 'all',
      '--outdir', outDir,
    ];

    return withTimeout(
      new Promise<string>((resolve, reject) => {
        const child = spawn(this.options.pythonPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        signal?.addEventListener('abort', () => child.kill(), { once: true });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`transcribe.py 退出码 ${code}：${(stderr || stdout).slice(-300)}`));
        });
      }),
      // GPU 转写：large-v3 约 3.5x 实时，给足余量
      600_000,
      () => {
        /* 超时后 close 仍会触发，由 catch 兜底 */
      },
    );
  }
}

/** 从 playurl 响应里挑出音频/视频流。 */
export function pickStreams(payload: {
  data?: {
    dash?: {
      audio?: Array<{ baseUrl?: string; base_url?: string; bandwidth?: number; codecs?: string; mimeType?: string }>;
      video?: Array<{
        baseUrl?: string;
        base_url?: string;
        bandwidth?: number;
        codecs?: string;
        width?: number;
        height?: number;
        id?: number;
      }>;
    };
  };
}): { audio: StreamCandidate | null; video: StreamCandidate | null } {
  const dash = payload.data?.dash;
  if (!dash) return { audio: null, video: null };

  const audioList = (dash.audio ?? [])
    .map((a) => ({
      url: a.baseUrl ?? a.base_url ?? '',
      bandwidth: a.bandwidth ?? 0,
      codecs: a.codecs,
    }))
    .filter((a) => a.url.length > 0)
    // 选最低码率：体积最小，ASR 够用
    .sort((a, b) => a.bandwidth - b.bandwidth);

  const videoList = (dash.video ?? [])
    .map((v) => ({
      url: v.baseUrl ?? v.base_url ?? '',
      bandwidth: v.bandwidth ?? 0,
      codecs: v.codecs,
      width: v.width,
      height: v.height,
    }))
    .filter((v) => v.url.length > 0)
    // 优先 H.264（兼容性最好），再在同类里选 480p 左右体积最小的
    .sort((a, b) => {
      const aAvc = /avc1/i.test(a.codecs ?? '') ? 0 : 1;
      const bAvc = /avc1/i.test(b.codecs ?? '') ? 0 : 1;
      if (aAvc !== bAvc) return aAvc - bAvc;
      const aPix = (a.width ?? 0) * (a.height ?? 0);
      const bPix = (b.width ?? 0) * (b.height ?? 0);
      // 480p 优先：既看得清又不浪费下行
      const aScore = Math.abs(aPix - 852 * 480);
      const bScore = Math.abs(bPix - 852 * 480);
      if (aScore !== bScore) return aScore - bScore;
      return a.bandwidth - b.bandwidth;
    });

  return {
    audio: audioList[0] ?? null,
    video: videoList[0] ?? null,
  };
}

/** 把抽帧结果渲染成提示词块（配合多模态内容块使用）。 */
export function renderFramesNote(frames: Frame[], durationSec: number): string {
  if (frames.length === 0) return '';
  const total = Math.max(1, Math.round(durationSec));
  return [
    `【视频画面】以下 ${frames.length} 张图是从这个 ${total} 秒视频里按时间顺序抽的帧，`,
    '你可以直接看到画面内容（包括画面里的文字、界面、代码等）。',
    '请结合画面描述视频在做什么；看不清的地方就说看不清，不要编。',
  ].join('');
}

/** 把转写结果渲染成提示词块。 */
export function renderTranscript(result: TranscribeResult): string {
  const mins = Math.round(result.duration / 60);
  const body = result.lines.length > 0
    ? result.lines.slice(0, 400).join('\n')
    : result.text;

  return [
    `【视频台词】以下是这个 ${mins} 分钟视频的语音转写（本地转写，可能有少量错字）：`,
    body,
    '【台词结束】',
    '这部分是视频里真实说出的话，可信度高于弹幕猜测。',
  ].join('\n');
}

