/**
 * 主动插话：观察未 @ 的群消息，攒够一批再调模型判断要不要接话。
 *
 * 从 pipeline.ts 抽出。原来它依赖 `this.observer` 和 `this.stats`，
 * 现在 observer 由调用方（MessagePipeline）持有并传进来。
 *
 * 成本控制：
 *   - 未达阈值前完全不调模型
 *   - 判断用极小的提示词（只给最近这批消息），要求输出 JSON
 *   - 冷却 + 每小时上限 + 概率闸三段限流
 */

import type { MessageEvent } from '../types.js';
import type { Logger } from '../logger.js';
import {
  checkInterjectGate,
  recordInterject,
  DEFAULT_POLICY,
  type InterjectObserver,
} from '../interject.js';
import { buildInterjectMessages, parseInterjectVerdict } from '../interject-prompt.js';
import type { PipelineContext } from './context.js';

/**
 * 记录一条未 @ 的群消息；到达判断时机时才调一次模型决定要不要接。
 *
 * @returns 需要判断时返回攒下的这批消息；否则返回 null
 */
export function observeForInterject(
  ctx: PipelineContext,
  observer: InterjectObserver,
  event: MessageEvent,
  logger: Logger,
): MessageEvent[] | null {
  const { config, store } = ctx;
  const policy = config.interject;

  // 全局关闭 / 不在白名单 → 不记录，零开销
  if (!policy.enabled) return null;
  if (policy.scope === 'allowlist' && !policy.allowGroups.includes(event.peerId)) return null;

  // InterjectConfig 与 InterjectPolicy 字段一致，直接复用，避免两处手工同步
  const reached = observer.observe(event, policy);
  if (!reached) {
    logger.debug('插话观察中', {
      peerId: event.peerId,
      pending: observer.pending(event.platform, event.peerId),
      need: policy.minMessages,
    });
    return null;
  }

  const batch = observer.take(event.platform, event.peerId);
  if (!batch || batch.events.length === 0) return null;

  // 节流检查：不通过就直接丢掉这批，不浪费调用
  const gate = checkInterjectGate(store, event, policy);
  if (!gate.allow) {
    logger.debug('主动插话被节流拦下', { reason: gate.reason, peerId: event.peerId });
    return null;
  }

  return batch.events;
}

/**
 * 调用模型判断是否插话。
 *
 * @returns 要接话时返回触发用的消息；不接返回 null
 */
export async function decideInterject(
  ctx: PipelineContext,
  event: MessageEvent,
  batch: MessageEvent[],
  logger: Logger,
): Promise<MessageEvent | null> {
  const { config, llm, store, personas, botName } = ctx;
  if (!llm.enabled) return null;

  const persona = personas.get(undefined, event.peerId);

  // 关键：只用攒下的这批消息判断，上下文往往不足（实测 3 条时模型倾向保守说"不接"）。
  // 所以从记忆库补足到 contextWidth 条，让模型看到完整话题脉络。
  // contextWidth 缺省时回退到默认 15（旧配置文件/测试里可能没有这个字段）
  const width = Math.max(3, Number(config.interject.contextWidth) || DEFAULT_POLICY.contextWidth);
  const recent = store.recentMessages(
    event.platform,
    event.scene,
    event.peerId,
    width,
    Date.now() - config.context.historyWindowMinutes * 60_000,
  );

  // 记忆库里的更全，优先用；不足时退回攒批内容
  const context: MessageEvent[] =
    recent.length > batch.length
      ? recent.map((m, i) => {
          // recentMessages 返回的是存储行，不是完整 MessageEvent，
          // 这里补齐内部模型需要的 eventId / segments 字段
          const text = (m.text ?? '').trim();
          return {
            platform: event.platform,
            scene: event.scene,
            peerId: event.peerId,
            messageId: '',
            eventId: `interject:${event.peerId}:${m.timestamp}:${i}`,
            sender: { userId: m.userId, nickname: m.nickname },
            segments: [{ type: 'text' as const, text }],
            text: text || '（非文字内容）',
            mentionsBot: m.mentionsBot,
            fromSelf: m.fromSelf,
            timestamp: m.timestamp || Math.floor(Date.now() / 1000),
          };
        })
      : batch;

  const messages = buildInterjectMessages(context, botName, persona.name);

  logger.info('开始判断是否主动插话', {
    peerId: event.peerId,
    batchSize: batch.length,
    contextSize: context.length,
  });
  const result = await llm.complete(messages);
  const verdict = parseInterjectVerdict(result.content);

  if (!verdict.speak) {
    // 记下模型的原话，方便排查"为什么总是不接"
    logger.info('判断结果：不插话', {
      peerId: event.peerId,
      contextSize: context.length,
      raw: result.content.slice(0, 120),
    });
    return null;
  }

  logger.info('判断结果：插话', { peerId: event.peerId, opener: verdict.opener });
  recordInterject(store, event);
  ctx.stats.interjected++;

  // 用批里最后一条消息作为「当前消息」，走正常的回复生成
  return batch[batch.length - 1] as MessageEvent;
}
