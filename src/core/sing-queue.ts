/**
 * 唱歌任务队列。
 *
 * 为什么需要：SVC 生成一首 4 分钟的歌要 3~5 分钟，
 * 不能阻塞消息处理（否则机器人整个卡住）。
 *
 * 设计：
 *   - 串行执行（GPU 只有一块，并发会 OOM）
 *   - 任务落盘持久化（进程重启后能恢复未完成任务）
 *   - 完成后发音频 + 打招呼
 *   - 完整版生成后自动写入曲库，以后秒回
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Logger } from './logger.js';
import type { ChatAdapter, MessageScene } from './types.js';
import type { MusicClient } from './music.js';
import type { SingMode } from './singer.js';

export interface SingJob {
  id: string;
  mode: SingMode;
  /** 搜索到的准确歌名 */
  title: string;
  /** 用户说的名字 */
  songName: string;
  voice: string;
  searchId: string;
  scene: MessageScene;
  peerId: string;
  /** 创建时间（毫秒） */
  createdAt: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
}

export interface JobQueueOptions {
  logger: Logger;
  music: MusicClient;
  adapter: ChatAdapter;
  /** 工作目录（放下载的原曲、生成的翻唱、任务状态） */
  workDir: string;
  /** Python 解释器（跑 make_cover.py 用 svc-venv） */
  pythonPath: string;
  /** make_cover.py 路径 */
  scriptPath: string;
  /** 片段最长多少秒 */
  clipSeconds: number;
  /** 完整版最长多少秒（0 = 不限） */
  fullSeconds: number;
  /** 生成后是否写入曲库 */
  saveToLibrary: boolean;
  /** 曲库配置路径 */
  libraryFile: string;
  /** 发完音频后的结语钩子 */
  afterword?: (job: SingJob) => Promise<void>;
}

export class SingJobQueue {
  private jobs: SingJob[] = [];
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: JobQueueOptions) {
    const { workDir } = options;
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
    this.load();
  }

  /** 当前队列（只读）。 */
  get list(): readonly SingJob[] {
    return this.jobs;
  }

  /** 加一个任务。 */
  enqueue(input: Omit<SingJob, 'id' | 'createdAt' | 'status'>): string {
    const id = `sing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const job: SingJob = {
      ...input,
      id,
      createdAt: Date.now(),
      status: 'pending',
    };
    this.jobs.push(job);
    this.save();
    this.options.logger.info('唱歌任务入队', {
      id,
      mode: job.mode,
      title: job.title,
      voice: job.voice,
    });
    this.kick();
    return id;
  }

  /** 启动轮询（可选，enqueue 时也会自动 kick）。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), 5000);
    this.timer.unref?.();
    this.kick();
  }

  /** 停止轮询。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 尝试启动下一个任务。 */
  private kick(): void {
    if (this.running) return;
    const next = this.jobs.find((j) => j.status === 'pending');
    if (!next) return;

    this.running = true;
    next.status = 'running';
    this.save();

    void this.run(next)
      .catch((error: unknown) => {
        next.status = 'failed';
        next.error = (error as Error).message.slice(0, 300);
        this.options.logger.error('唱歌任务失败', {
          id: next.id,
          title: next.title,
          message: next.error,
        });
      })
      .finally(() => {
        this.running = false;
        this.save();
        // 立刻尝试下一个
        setTimeout(() => this.kick(), 1000);
      });
  }

  /** 执行一个任务。 */
  private async run(job: SingJob): Promise<void> {
    const { logger, music, adapter, workDir, clipSeconds, fullSeconds } = this.options;

    // 1. 取播放地址
    const urlRes = await music.getUrl(job.searchId, { br: 320 });
    if (!urlRes) throw new Error('取不到播放地址（可能是版权限制）');

    // 2. 下载原曲
    const origDir = join(workDir, 'originals');
    if (!existsSync(origDir)) mkdirSync(origDir, { recursive: true });
    const safeName = job.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const origPath = join(origDir, `${safeName}.mp3`);

    if (!existsSync(origPath)) {
      const ok = await music.download(urlRes.url, origPath);
      if (!ok) throw new Error('下载原曲失败');
    }
    logger.info('原曲已就绪', { title: job.title, path: origPath });

    // 3. 只听原唱 → 直接发
    if (job.mode === 'original') {
      const toSend = this.shrinkIfBig(origPath, job);
      await adapter.sendRecord(job.scene, job.peerId, toSend);
      logger.info('原唱已发送', { title: job.title });
      await this.options.afterword?.(job);
      job.status = 'done';
      return;
    }

    // 4. 翻唱 → 跑 make_cover.py
    const maxSec = job.mode === 'full' ? fullSeconds : clipSeconds;
    const outDir = join(workDir, 'covers');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${safeName}-${job.voice}.mp3`);

    await this.runCover(job, origPath, outPath, maxSec);

    if (!existsSync(outPath)) throw new Error('生成失败，输出文件不存在');

    // 5. 发送
    const toSend = this.shrinkIfBig(outPath, job);
    await adapter.sendRecord(job.scene, job.peerId, toSend);
    logger.info('翻唱已发送', { title: job.title, voice: job.voice, mode: job.mode });

    // 6. 完整版写入曲库
    if (job.mode === 'full' && this.options.saveToLibrary) {
      this.addToLibrary(job, outPath);
    }

    // 7. 招呼
    await this.options.afterword?.(job);
    job.status = 'done';
  }

  /**
   * 文件太大就压成 128k mp3 再发。
   *
   * 为什么：实测 11.79 MB 的原曲，NapCat 转码+上传要 16.4 秒，
   * 超过默认超时；而且 QQ 语音对大文件处理很慢。
   * 压到 3~4 MB 后基本 5 秒内完成。
   */
  private shrinkIfBig(file: string, job: SingJob): string {
    try {
      const mb = statSync(file).size / 1024 / 1024;
      if (mb <= 6) return file;

      const small = join(dirname(file), `${job.id}-small.mp3`);
      execFileSync(
        'ffmpeg',
        ['-y', '-hide_banner', '-loglevel', 'error',
         '-i', file, '-b:a', '128k', '-ar', '24000', '-ac', '1', small],
        { timeout: 120_000 },
      );
      const smallMb = statSync(small).size / 1024 / 1024;
      this.options.logger.info('音频已压缩', {
        from: Math.round(mb * 10) / 10,
        to: Math.round(smallMb * 10) / 10,
      });
      return small;
    } catch (error) {
      this.options.logger.info('压缩失败，发原文件', {
        message: (error as Error).message.slice(0, 100),
      });
      return file;
    }
  }

  /** 调用 make_cover.py。 */
  private runCover(job: SingJob, input: string, output: string, maxSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        this.options.scriptPath,
        '--input', input,
        '--voice', job.voice,
        '--out', output,
        '--job-id', job.id,
      ];
      if (maxSeconds > 0) args.push('--max-seconds', String(maxSeconds));

      const proc = spawn(this.options.pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let lastErr = '';
      proc.stdout?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.startsWith('@@PROGRESS ')) continue;
          try {
            const p = JSON.parse(line.slice(11)) as Record<string, unknown>;
            this.options.logger.info('生成进度', { id: job.id, ...p });
            if (p['stage'] === 'error') lastErr = String(p['message'] ?? '');
          } catch {
            /* 忽略解析失败 */
          }
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const t = d.toString('utf8').trim();
        if (t.length > 0) lastErr = t.slice(-400);
      });

      proc.on('error', (e) => reject(e));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`生成脚本退出码 ${code}: ${lastErr}`));
      });
    });
  }

  /** 把完整版写进曲库配置。 */
  private addToLibrary(job: SingJob, file: string): void {
    const path = this.options.libraryFile;
    try {
      let list: Array<Record<string, unknown>> = [];
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (Array.isArray(raw)) list = raw as Array<Record<string, unknown>>;
      }

      // 已存在同歌同音色就更新
      const idx = list.findIndex(
        (s) =>
          String(s['id'] ?? '') === job.title &&
          String(s['voice'] ?? '') === job.voice,
      );
      const entry = {
        id: job.title,
        title: job.title,
        file,
        voice: job.voice,
        durationSec: this.probeDuration(file),
      };

      if (idx >= 0) list[idx] = entry;
      else list.push(entry);

      writeFileSync(path, JSON.stringify(list, null, 2), 'utf8');
      this.options.logger.info('已写入曲库', { title: job.title, voice: job.voice });
    } catch (error) {
      this.options.logger.info('写曲库失败', {
        message: (error as Error).message.slice(0, 120),
      });
    }
  }

  /** 读音频时长（用 ffprobe）。 */
  private probeDuration(file: string): number {
    try {
      const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
      ]).toString().trim();
      return Math.round(Number(out));
    } catch {
      return 0;
    }
  }

  /** 持久化任务状态。 */
  private save(): void {
    try {
      const p = join(this.options.workDir, 'jobs.json');
      // 只留最近 50 条，避免文件无限增长
      const recent = this.jobs.slice(-50);
      writeFileSync(p, JSON.stringify(recent, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  /** 载入任务状态。 */
  private load(): void {
    try {
      const p = join(this.options.workDir, 'jobs.json');
      if (!existsSync(p)) return;
      const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return;
      this.jobs = (raw as SingJob[]).map((j) => ({
        ...j,
        // 重启时把"执行中"的标记回退成待执行（可能被中断了）
        status: j.status === 'running' ? 'pending' : j.status,
      }));
    } catch {
      /* ignore */
    }
  }
}
