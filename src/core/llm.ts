/**
 * OpenAI 兼容的 Chat Completions 客户端。
 *
 * 为什么不用官方 SDK：只需要一个 POST 端点，手写可控制在 200 行内，
 * 且能精确控制超时、重试与错误信息，避免 SDK 版本行为不可控。
 *
 * 重试策略：仅对「可重试错误」重试——网络异常、408、429、5xx。
 * 认证失败（401/403）、参数错误（400/404）立即抛出，不做无意义重试。
 */

import type { Logger } from '../core/logger.js';
import type { LlmConfig } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本，或多模态内容块（文本 + 图片） */
  content: string | ContentPart[];
}

/** 多模态内容块：OpenAI 兼容的 vision 格式。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface CompletionResult {
  content: string;
  /**
   * 模型请求调用的工具（function calling）。
   *
   * 为什么需要：以前用 16 个正则函数判断「用户想干什么」，
   * 每条说法都得补一个 pattern，漏一个就整条功能失效
   * （实测「放《This game》」因为正则没覆盖而完全不放歌）。
   * 改成让模型自己语义判断，一次 API 调用同时拿到意图 + 参数。
   */
  toolCalls?: ToolCall[];
  /** 输入 token 数（若接口返回 usage） */
  promptTokens?: number;
  /** 输出 token 数 */
  completionTokens?: number;
  /** 本次是否为降级/模拟回复 */
  degraded: boolean;
  /** 实际发送的尝试次数（含首次） */
  attempts: number;
}

/** 模型请求的一次工具调用。 */
export interface ToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象（解析失败时为 {}） */
  args: Record<string, unknown>;
  /** 原始 JSON 字符串，排查用 */
  rawArgs: string;
}

/** 工具定义（OpenAI 兼容格式）。 */
export interface ToolDef {
  name: string;
  /**
   * 触发时机说明。**这一段写得越具体，模型命中率越高。**
   * 实测：只写「放歌」时模型经常不调用；
   * 写成「当用户想听某首歌、想放歌、想播放音乐…包括「放XX」「来点XX的BGM」等说法」
   * 之后 4/4 刁钻说法全部命中。
   */
  description: string;
  /** JSON Schema（type: object） */
  parameters: Record<string, unknown>;
}

/** 一次补全的可选项。 */
export interface CompleteOptions {
  /** 可调用的工具列表 */
  tools?: ToolDef[];
  /** 'auto' = 模型自己决定；'none' = 禁用；指定名称 = 强制 */
  toolChoice?: 'auto' | 'none' | { name: string };
  /** 覆盖默认 temperature */
  temperature?: number;
  /** 覆盖默认 maxTokens */
  maxTokens?: number;
}

/** 可重试的 HTTP 状态码。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly logger: Logger,
  ) {}

  /** 是否配置了可用 Key。 */
  get enabled(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  /**
   * 发起一次非流式补全（内含重试）。失败时抛出 LlmError，由调用方决定降级。
   */
  async complete(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<CompletionResult> {
    if (!this.enabled) {
      throw new LlmError('未配置 LLM_API_KEY');
    }

    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastError: Error = new LlmError('未知错误');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.requestOnce(messages, options);
        return { ...result, attempts: attempt };
      } catch (error) {
        lastError = error as Error;
        const retryable =
          error instanceof LlmError ? error.retryable : isNetworkError(error as Error);
        if (!retryable || attempt === maxAttempts) {
          if (retryable) {
            this.logger.error('LLM 重试耗尽', { attempts: attempt, message: lastError.message });
          }
          throw lastError;
        }
        // 优先遵循服务端 Retry-After，其次指数退避 + 抖动
        const backoff = (error as LlmError & { retryAfterMs?: number }).retryAfterMs
          ?? Math.min(this.config.retryBaseDelayMs * 2 ** (attempt - 1), 8_000);
        const jitter = Math.floor(Math.random() * 250);
        this.logger.warn('LLM 调用失败，准备重试', {
          attempt,
          maxAttempts,
          waitMs: backoff + jitter,
          message: lastError.message,
        });
        await sleep(backoff + jitter);
      }
    }
    throw lastError;
  }

  private async requestOnce(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<Omit<CompletionResult, 'attempts'>> {
    const url = `${this.config.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: false,
    };

    // 有工具就带上。注意：不支持 tools 的模型会返回 400，
    // 这里不额外探测——项目里只配 DeepSeek，实测支持。
    if (options.tools && options.tools.length > 0) {
      body['tools'] = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body['tool_choice'] =
        typeof options.toolChoice === 'string'
          ? options.toolChoice
          : options.toolChoice
            ? { type: 'function', function: { name: options.toolChoice.name } }
            : 'auto';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryable = RETRYABLE_STATUS.has(response.status);
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const err = new LlmError(
          `LLM HTTP ${response.status}：${text.slice(0, 300)}`,
          response.status,
          retryable,
        ) as LlmError & { retryAfterMs?: number };
        if (retryAfter !== undefined) err.retryAfterMs = retryAfter;
        throw err;
      }

      const json = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? '';

      // 解析工具调用。
      // 注意：有些模型返回 tool_calls 时 content 是空字符串，
      // 所以下面「content 为空就报错」的判断必须放在解析之后、且排除有 tool_calls 的情况。
      const rawToolCalls = choice?.message?.tool_calls ?? [];
      const toolCalls: ToolCall[] = rawToolCalls
        .filter((tc) => tc?.function?.name)
        .map((tc, i) => {
          const raw = tc.function?.arguments ?? '{}';
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            // 模型偶尔给出非法 JSON，不阻断流程——调用方可以用 rawArgs 自己兜
          }
          return {
            id: tc.id ?? `call_${i}`,
            name: tc.function?.name ?? '',
            args,
            rawArgs: raw,
          };
        });

      // 有工具调用就不要求正文
      if (toolCalls.length > 0) {
        return {
          content,
          toolCalls,
          promptTokens: json.usage?.prompt_tokens,
          completionTokens: json.usage?.completion_tokens,
          degraded: false,
        };
      }

      if (content.trim() === '') {
        const reasoning = choice?.message?.reasoning_content ?? '';
        const truncated = choice?.finish_reason === 'length';
        // 推理模型（如 deepseek-flash）会先输出思维链消耗 token；
        // 若 max_tokens 太小，思维链吃光预算，content 就是空的。
        // 这属于配置问题，重试无意义——直接给出可操作的诊断。
        if (reasoning.length > 0 && truncated) {
          throw new LlmError(
            `模型把 ${this.config.maxTokens} 个 token 全部用于思考（reasoning_tokens），未产出正文。` +
              `请调大 LLM_MAX_TOKENS（建议 ≥1024）。`,
            undefined,
            false,
          );
        }
        if (truncated) {
          throw new LlmError(
            `模型输出被 max_tokens（${this.config.maxTokens}）截断且无正文，请调大 LLM_MAX_TOKENS。`,
            undefined,
            false,
          );
        }
        // 其余空内容多为上游限流或内容过滤误伤，可重试
        throw new LlmError('LLM 返回空内容', undefined, true);
      }

      const reasoningTokens = (json.usage as Record<string, unknown> | undefined)?.[
        'completion_tokens_details'
      ] as Record<string, unknown> | undefined;
      this.logger.debug('LLM 调用完成', {
        model: this.config.model,
        ms: Date.now() - startedAt,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        reasoningTokens: reasoningTokens?.['reasoning_tokens'],
      });
      return {
        content,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        degraded: false,
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new LlmError(`LLM 请求超时（${this.config.timeoutMs}ms）`, undefined, true);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch 层网络错误（连接失败、DNS、socket 断开）应重试。 */
function isNetworkError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const message = error.message ?? '';
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    /fetch failed|socket hang up|network/i.test(message)
  );
}

/** 解析 Retry-After：支持秒数与 HTTP 日期两种格式。 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
