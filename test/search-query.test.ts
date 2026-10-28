/** 验证搜索词提取：引用块必须被剥掉。 */

import { describe, expect, it, vi } from 'vitest';
import { buildSearchQuery } from '../src/core/pipeline/enrichers.js';
import type { PipelineContext } from '../src/core/pipeline/context.js';

function ctxWithLLM(reply: string): PipelineContext {
  return {
    llm: {
      enabled: true,
      complete: vi.fn().mockResolvedValue({ content: reply }),
    },
  } as unknown as PipelineContext;
}

const logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as never;

describe('搜索词提取', () => {
  it('剥掉引用块（用户自己说的话才是搜索目标）', async () => {
    const text =
      '[引用 鲸鱼娘：等下，这图右下角写着2026年10月27日？现在就被截图传出来了] 胡塞打沙特是不是真的';
    const ctx = ctxWithLLM('胡塞 沙特 冲突');

    const q = await buildSearchQuery(ctx, text, [], logger);

    // 关键词里不能出现引用内容的碎片
    expect(q).not.toContain('鲸鱼娘');
    expect(q).not.toContain('2026年10月27日');
    expect(q).not.toContain('截图');
    expect(q.length).toBeGreaterThan(0);
  });

  it('引用块里的 ] 不会截断错误', async () => {
    const text =
      '[引用 某人：这句话里有[方括号]和一些内容] 这图是真的吗';
    const ctx = ctxWithLLM('图片 真伪验证');

    const q = await buildSearchQuery(ctx, text, [], logger);
    expect(q).not.toContain('[引用');
    expect(q).not.toContain('方括号');
  });

  it('只引用不说话时，用引用内容兜底', async () => {
    const text = '[引用 某人：胡塞武装袭击沙特石油设施]';
    const ctx = ctxWithLLM('胡塞 沙特');

    const q = await buildSearchQuery(ctx, text, [], logger);
    expect(q.length).toBeGreaterThan(0);
    // 兜底时应该包含引用里的实质内容
    expect(q).toContain('胡塞');
  });

  it('普通提问不受影响', async () => {
    const ctx = ctxWithLLM('不该被调用');
    const q = await buildSearchQuery(ctx, '今天天气怎么样', [], logger);
    expect(q).toBe('今天天气怎么样');
  });

  it('有代词时把引用内容喂给 LLM 当上下文', async () => {
    const text = '[引用 小明：杨少华去世了] 他爹还在吗';
    const complete = vi.fn().mockResolvedValue({ content: '杨少华' });
    const ctx = { llm: { enabled: true, complete } } as unknown as PipelineContext;

    const q = await buildSearchQuery(ctx, text, [], logger);

    expect(complete).toHaveBeenCalled();
    const msgs = complete.mock.calls[0]?.[0] as Array<{ content: string }>;
    // 引用内容应该出现在 prompt 里（作为背景），而不是搜索词
    expect(msgs[1]?.content).toContain('杨少华');
    expect(q).toBe('杨少华');
  });
});
