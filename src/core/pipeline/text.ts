/**
 * 会话级串行队列与文本工具。
 *
 * 从原 pipeline.ts 底部抽出来的纯函数，零依赖，方便单独测试。
 */

/** 简单的 Promise 串行队列，按 key 隔离。 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);

    return previous
      .then(task)
      .finally(() => {
        release();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
  }

  /** 当前排队中的 key 数量，用于诊断。 */
  get size(): number {
    return this.tails.size;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把长文本按平台上限分片。
 *
 * 在窗口内从后往前找自然断点（换行 > 句号 > 逗号），
 * 避免把一句话切成两半。
 */
export function splitMessage(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const pattern of [/\n(?![\s\S]*\n)/, /[。！？!?…]/, /[，,；;、\s]/]) {
      const idx = window.search(pattern);
      if (idx > limit * 0.4) {
        cut = idx + 1;
        break;
      }
    }
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
