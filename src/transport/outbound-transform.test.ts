import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureOutboundExtensions, loadOutboundExtensions, resetOutboundBreaker, runOutboundChain, runOutboundTurnEnd,
  type OutboundMiddleware, type OutboundSentResult, type OutboundTransform, type RunOutboundOptions,
} from '../features/ext-outbound.js';
import { sendRichOutbound, type QQBotSender } from './outbound-buffer.js';
import { createOutboundHandler } from './outbound.js';
import type { ImQQBotConfig } from '../config.js';
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { Logger, ReplyTarget } from '../types.js';

vi.mock('../features/four-source.js', () => ({
  noteTurnSignals: vi.fn(), applyTurnAttitude: vi.fn(), extractInnerText: () => '',
}));
vi.mock('../features/thinking-log.js', () => ({ noteThinking: vi.fn() }));
vi.mock('./tool-presenter.js', () => ({ formatToolResult: () => '工具结果\n第二行' }));

const fixtureKey = Symbol.for('qqbot.test.outbound-transform');
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const target: ReplyTarget = { scope: 'group', targetId: 'peer', msgId: 'incoming' };
let root: string;
let receipts: OutboundSentResult[];
let sent: Array<{ target: ReplyTarget; text: string; at: number }>;
let bot: QQBotSender;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetOutboundBreaker();
  root = mkdtempSync(join(tmpdir(), 'outbound-transform-'));
  receipts = [];
  sent = [];
  bot = {
    sendMarkdown: vi.fn(async (to: ReplyTarget, text: string) => { sent.push({ target: to, text, at: Date.now() }); }),
    sendMedia: vi.fn(async () => undefined),
    recallByIndex: vi.fn(async () => true),
  } as unknown as QQBotSender;
  configureOutboundExtensions({ dataRoot: root, logger, owner: bot });
  options.sender = bot;
});

afterEach(async () => {
  await loadOutboundExtensions({ dataRoot: join(root, 'empty'), logger });
  Reflect.deleteProperty(globalThis, fixtureKey);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

async function install(...middlewares: OutboundMiddleware[]) {
  Reflect.set(globalThis, fixtureKey, { middlewares, receipts });
  const dir = join(root, '.qqbot-extensions/outbound');
  mkdirSync(dir, { recursive: true });
  middlewares.forEach((_middleware, index) => {
    writeFileSync(join(dir, `${index}.mjs`), `
      const fixture = globalThis[Symbol.for('qqbot.test.outbound-transform')];
      export default (ctx, next) => fixture.middlewares[${index}](ctx, next);
      ${index === 0 ? 'export const onSent = (result) => fixture.receipts.push(result);' : ''}
    `);
  });
  expect((await loadOutboundExtensions({ dataRoot: root, logger })).total).toBe(middlewares.length);
}

const splitLines: OutboundTransform = (message) => message.text.split('\n').map((text) => ({ ...message, text }));
const splitter: OutboundMiddleware = (ctx, next) => { ctx.transform(splitLines); return next(); };
const options: RunOutboundOptions = { source: 'assistant/message', logger };

function send(text: string, to = target, limit = 4500, onError?: (err: unknown, text: string) => void) {
  return sendRichOutbound(bot, to, text, limit, undefined, logger.error, undefined, undefined, undefined, undefined, onError, options);
}

async function settle() {
  await vi.dynamicImportSettled();
  await vi.runAllTimersAsync();
  await vi.dynamicImportSettled();
}

function router(mode: 'adaptive' | 'passive' = 'adaptive') {
  const record = {
    sessionKey: 'group:peer', replyTarget: { ...target }, lastInboundAt: Date.now(),
    agent: { steer: vi.fn() }, turnStartAt: Date.now(),
  } as unknown as SessionRecord;
  const config = { dataRoot: root, streaming: false, textChunkLimit: 4500, outboundMode: mode, showToolResults: true } as ImQQBotConfig;
  const handler = createOutboundHandler({ findBySessionId: () => record } as unknown as SessionManager, bot, config, logger);
  const emit = (type: string, data: Record<string, unknown>) => handler({ header: { id: 'session' } }, { type, data });
  const reply = (text: string) => emit('assistant/message', { message: { content: [{ type: 'text', text }] } });
  return { record, config, emit, reply };
}

describe('onOutbound 内容变换契约', () => {
  it('等待所有 rewrite 完成，再依次执行零/一/多条变换', async () => {
    await install(
      splitter,
      async (ctx, next) => { await next(); ctx.rewrite('第一行\n第二行'); },
      (ctx, next) => { ctx.transform((message) => message.text === '第二行' ? null : { ...message, text: `${message.text}！` }); return next(); },
    );
    const result = await runOutboundChain('原文', options);
    expect(result.text).toBe('第一行\n第二行');
    expect(result.messages).toEqual([{ text: '第一行！', kind: 'text', source: 'assistant/message' }]);
  });

  it('annihilate 优先，已登记的变换不执行', async () => {
    const transform = vi.fn(splitLines);
    await install(
      (ctx, next) => { ctx.transform(transform); return next(); },
      (ctx) => { ctx.annihilate('blocked'); },
    );
    const result = await runOutboundChain('甲\n乙', options);
    expect(result.killed).toBe(true);
    expect(result.messages).toBeUndefined();
    expect(transform).not.toHaveBeenCalled();
  });

  it('turnEnd 阶段拒绝登记，不产生第二批正文', async () => {
    const accepted: boolean[] = [];
    await install((ctx, next) => { accepted.push(ctx.transform(splitLines)); return next(); });
    expect((await runOutboundTurnEnd('甲\n乙', options)).messages).toBeUndefined();
    expect(accepted).toEqual([false]);
  });

  it('await next 后登记的变换仍归属当前扩展，抛错时整批回退并继续后续变换', async () => {
    await install(
      async (ctx, next) => {
        await next();
        ctx.transform((message) => {
          if (message.text === '乙') throw new Error('transform failed');
          return { ...message, text: '不能部分提交' };
        });
        ctx.transform((message) => ({ ...message, text: `${message.text}！` }));
      },
      splitter,
    );
    expect((await runOutboundChain('甲\n乙', options)).messages?.map((message) => message.text)).toEqual(['甲！', '乙！']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ext-outbound] 0 内容变换失败'));
  });

  it('非文本 kind 可以参与变换，修改后的 kind 和 source 传递给后续变换', async () => {
    await install(
      (ctx, next) => { ctx.transform((message) => ({ ...message, text: `${message.kind}:改写后`, kind: 'other', source: 'tool/result' })); return next(); },
      (ctx, next) => { ctx.transform((message) => ({ ...message, text: `${message.kind}:${message.text}` })); return next(); },
    );
    const result = await runOutboundChain('原文', { ...options, kind: 'media' });
    expect(result.messages).toEqual([{ text: 'other:media:改写后', kind: 'other', source: 'tool/result' }]);
  });

  it('宿主未标记类型时仍将完整协议文本交给插件', async () => {
    const text = '[rf:12345]\n正文\n[MEDIA:image|image.png]\n[RECALL]';
    const transform = vi.fn<OutboundTransform>((message) => ({ ...message, text: '插件处理后' }));
    await install((ctx, next) => { ctx.transform(transform); return next(); });
    const result = await runOutboundChain(text, options);
    expect(result.text).toBe(text);
    expect(transform).toHaveBeenCalledWith({ text, kind: 'text', source: 'assistant/message' });
    expect(result.messages).toEqual([{ text: '插件处理后', kind: 'text', source: 'assistant/message' }]);
  });
});

describe('宿主执行变换后的发送', () => {
  it('逐条发送并保留间隔，只执行一次中间件并汇总一次 onSent', async () => {
    const middleware = vi.fn(splitter);
    await install(middleware);
    const operation = send('甲\n乙\n丙');
    await settle();
    await operation;
    expect(sent.map((message) => message.text)).toEqual(['甲', '乙', '丙']);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(500);
    expect(sent[2]!.at - sent[1]!.at).toBeGreaterThanOrEqual(500);
    expect(middleware).toHaveBeenCalledOnce();
    expect(receipts).toEqual([expect.objectContaining({ ok: true, text: '甲\n乙\n丙', failedBlocks: 0, killed: false })]);
  });

  it('同一目标排队，不同目标独立发送', async () => {
    await install(splitter);
    const operations = [send('甲1\n甲2'), send('乙1\n乙2'), send('其他群', { ...target, targetId: 'other' })];
    await settle();
    await Promise.all(operations);
    expect(sent.filter((message) => message.target.targetId === 'peer').map((message) => message.text)).toEqual(['甲1', '甲2', '乙1', '乙2']);
    expect(sent.find((message) => message.text === '乙1')!.at - sent.find((message) => message.text === '甲2')!.at).toBeGreaterThanOrEqual(500);
    expect(sent.find((message) => message.text === '其他群')!.at).toBeLessThan(sent.find((message) => message.text === '甲2')!.at);
  });

  it('第一个发送异常退出后也能释放队列', async () => {
    await install(splitter);
    vi.mocked(bot.recallByIndex).mockRejectedValueOnce(new Error('recall failed'));
    const first = send('[RECALL]').catch((error: Error) => error.message);
    const second = send('后续正文');
    await settle();
    expect(await first).toBe('recall failed');
    await second;
    expect(sent.map((message) => message.text)).toEqual(['后续正文']);
  });

  it.each([null, []])('返回 %s 过滤消息后不发送，仍提供一次回执', async (output) => {
    await install((ctx, next) => { ctx.transform(() => output); return next(); });
    const operation = send('原文');
    await settle();
    await operation;
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({ ok: false, text: '', failedBlocks: 0, killed: false })]);
  });

  it.each([false, true])('混合媒体正文按是否变换选择分块计数（transform=%s）', async (transform) => {
    await install((ctx, next) => { if (transform) ctx.transform((message) => message); return next(); });
    const chunkTarget = vi.fn(() => target);
    const operation = sendRichOutbound(
      bot, target, 'aaaa\nbbbb\n[MEDIA:image|https://example.com/image.png]\ncccc\ndddd', 5, undefined,
      logger.error, undefined, chunkTarget, undefined, undefined, undefined, options,
    );
    await settle();
    await operation;
    expect(sent.map((message) => message.text)).toEqual(['aaaa', 'bbbb', 'cccc', 'dddd']);
    expect(bot.sendMedia).toHaveBeenCalledExactlyOnceWith(target, 'image', { url: 'https://example.com/image.png' });
    expect(chunkTarget.mock.calls).toEqual(transform ? [[0, 4], [1, 4], [2, 4], [3, 4]] : [[0, 2], [1, 2], [0, 2], [1, 2]]);
  });

  it('未登记变换时沿用原有纯媒体过滤行为', async () => {
    await install((_ctx, next) => next());
    const operation = send('[MEDIA:image|https://example.com/image.png]');
    await settle();
    await operation;
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
    expect(bot.sendMedia).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it('纯媒体变换结果发送成功后提供成功回执', async () => {
    await install((ctx, next) => {
      ctx.transform((message) => ({ ...message, text: '[MEDIA:image|https://example.com/image.png]', kind: 'media' }));
      return next();
    });
    const operation = send('原文');
    await settle();
    await operation;
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
    expect(bot.sendMedia).toHaveBeenCalledExactlyOnceWith(target, 'image', { url: 'https://example.com/image.png' });
    expect(receipts).toEqual([expect.objectContaining({ ok: true, failedBlocks: 0, killed: false })]);
  });

  it('媒体发送失败计入回执，后续变换结果仍可发送', async () => {
    await install((ctx, next) => {
      ctx.transform((message) => [
        { ...message, text: '[MEDIA:image|https://example.com/image.png]', kind: 'media' },
        { ...message, text: '后续正文' },
      ]);
      return next();
    });
    vi.mocked(bot.sendMedia).mockRejectedValueOnce(new Error('媒体发送失败'));
    const onError = vi.fn();
    const operation = send('原文', target, 4500, onError);
    await settle();
    await operation;
    expect(bot.sendMedia).toHaveBeenCalledOnce();
    expect(sent.map((message) => message.text)).toEqual(['后续正文']);
    expect(onError).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({ ok: false, failedBlocks: 1, error: '媒体发送失败' })]);
  });

  it('表情包闸门跳过媒体不记为发送失败', async () => {
    await install(splitter);
    vi.mocked(bot.sendMedia).mockRejectedValueOnce(Object.assign(new Error('预算已用完'), { name: 'StickerGateDenied' }));
    const operation = send('[MEDIA:image|https://example.com/image.png]\n后续正文');
    await settle();
    await operation;
    expect(sent.map((message) => message.text)).toEqual(['后续正文']);
    expect(receipts).toEqual([expect.objectContaining({ ok: true, failedBlocks: 0 })]);
  });

  it.each([false, true])('每条变换结果独立解析引用，引用不影响其他消息（chunkTarget=%s）', async (useChunkTarget) => {
    await install((ctx, next) => {
      ctx.transform((message) => [
        { ...message, text: '[rf:first]\n甲\n[MEDIA:image|https://example.com/image.png]' },
        { ...message, text: '[rf:second]\n乙' },
        { ...message, text: '丙' },
      ]);
      return next();
    });
    const refLookup = vi.fn((index: string) => `ROBOT1.0_${index}`);
    const chunkTarget = useChunkTarget ? vi.fn(() => target) : undefined;
    const operation = sendRichOutbound(
      bot, target, '原文', 4500, undefined, logger.error, () => target, chunkTarget,
      undefined, refLookup, undefined, options,
    );
    await settle();
    await operation;
    expect(refLookup.mock.calls).toEqual([['first'], ['second']]);
    expect(sent.map((message) => message.text)).toEqual(['甲', '乙', '丙']);
    expect(sent.map((message) => message.target.referenceMessageId)).toEqual(['ROBOT1.0_first', 'ROBOT1.0_second', undefined]);
    expect(bot.sendMedia).toHaveBeenCalledWith(
      { ...target, referenceMessageId: 'ROBOT1.0_first' }, 'image', { url: 'https://example.com/image.png' },
    );
    if (chunkTarget) expect(chunkTarget.mock.calls).toEqual([[0, 3], [1, 3], [2, 3]]);
    expect(receipts).toHaveLength(1);
  });

  it('按变换结果顺序执行撤回，保留每条消息的控制指令', async () => {
    await install((ctx, next) => {
      ctx.transform((message) => ['甲', '[RECALL]', '乙', '[RECALL:2]\n末'].map((text) => ({ ...message, text })));
      return next();
    });
    const actions: string[] = [];
    vi.mocked(bot.sendMarkdown).mockImplementation(async (_to, text) => { actions.push(`send:${text}`); });
    vi.mocked(bot.recallByIndex).mockImplementation(async (_to, index) => { actions.push(`recall:${index}`); return true; });
    const operation = send('原文');
    await settle();
    await operation;
    expect(actions).toEqual(['send:甲', 'recall:1', 'send:乙', 'recall:2', 'send:末']);
    expect(receipts).toEqual([expect.objectContaining({ ok: true, failedBlocks: 0 })]);
  });

  it('单条纯撤回未命中时继续处理后续变换结果', async () => {
    await install((ctx, next) => {
      ctx.transform((message) => ['[RECALL]', '后续正文'].map((text) => ({ ...message, text })));
      return next();
    });
    vi.mocked(bot.recallByIndex).mockResolvedValue(false);
    const operation = send('原文');
    await settle();
    await operation;
    expect(bot.recallByIndex).toHaveBeenCalledExactlyOnceWith(target, 1);
    expect(sent.map((message) => message.text)).toEqual(['后续正文']);
    expect(logger.error).toHaveBeenCalledWith('im-qqbot: [RECALL] 无可撤回消息或已超时');
    expect(receipts).toEqual([expect.objectContaining({ ok: true })]);
  });

  it('正文发送失败仍通知 AI、继续后续发送，并汇总失败回执', async () => {
    await install(splitter);
    vi.mocked(bot.sendMarkdown).mockRejectedValueOnce(new Error('内容违规'));
    const h = router();
    h.reply('甲\n乙');
    await settle();
    expect(vi.mocked(bot.sendMarkdown).mock.calls.map((call) => call[1])).toEqual(['甲', '乙']);
    expect((h.record.agent as unknown as { steer: unknown }).steer).toHaveBeenCalledOnce();
    expect(sent.map((message) => message.text)).toEqual(['乙']);
    expect(receipts).toEqual([expect.objectContaining({ ok: false, failedBlocks: 1, error: '内容违规' })]);
  });

  it('扩展超时后只发原文，迟到的变换不产生额外发送', async () => {
    let resume!: () => void;
    await install(async (ctx, next) => {
      await new Promise<void>((resolve) => { resume = resolve; });
      ctx.transform(splitLines);
      return next();
    });
    const operation = send('甲\n乙');
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(8000);
    await operation;
    resume();
    await settle();
    expect(sent.map((message) => message.text)).toEqual(['甲\n乙']);
  });

  it.each(['adaptive', 'passive'] as const)('%s 模式按整批计算配额，第六条转主动', async (mode) => {
    await install(splitter);
    router(mode).reply('甲\n乙\n丙\n丁\n戊\n己');
    await settle();
    expect(sent).toHaveLength(6);
    expect(sent.slice(0, 5).every((message) => message.target.msgId === 'incoming')).toBe(true);
    expect(sent[5]!.target.msgId).toBeUndefined();
  });

  it('每次发送前重新取目标，群友插话后使用新的被动回复 id', async () => {
    await install(splitter);
    const h = router();
    const original = vi.mocked(bot.sendMarkdown).getMockImplementation()!;
    vi.mocked(bot.sendMarkdown).mockImplementation(async (to, text) => {
      await original(to, text);
      if (text === '甲') h.record.replyTarget = { ...target, msgId: 'new-incoming' };
    });
    h.reply('甲\n乙');
    await settle();
    expect(sent.map((message) => message.target.msgId)).toEqual(['incoming', 'new-incoming']);
  });

  it.each([false, true])('回合结束等待直接/缓冲正文发完，后续回合快照独立（buffer=%s）', async (buffered) => {
    const ended: Array<{ text: string; sent: number }> = [];
    await install((ctx, next) => {
      if (ctx.phase === 'turnEnd') ended.push({ text: ctx.text, sent: sent.length });
      else ctx.transform(splitLines);
      return next();
    });
    const h = router();
    if (buffered) h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '甲\n乙' } });
    h.reply('甲\n乙');
    h.emit('turn/end', { reason: { kind: 'completed' } });
    await vi.dynamicImportSettled();
    expect(ended).toEqual([]);
    h.reply('下一回合');
    await settle();
    expect(ended).toEqual([{ text: '甲\n乙', sent: 2 }]);
    h.emit('turn/end', { reason: { kind: 'completed' } });
    await settle();
    expect(ended[1]).toEqual({ text: '下一回合', sent: 3 });
  });

  it('仅剩缓冲增量时，回合结束也会发送并调用收尾钩子', async () => {
    const ended = vi.fn();
    await install((ctx, next) => {
      if (ctx.phase === 'turnEnd') ended(ctx.text);
      else ctx.transform(splitLines);
      return next();
    });
    const h = router();
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '甲\n乙' } });
    h.emit('turn/end', { reason: { kind: 'completed' } });
    await settle();
    expect(sent.map((message) => message.text)).toEqual(['甲', '乙']);
    expect(ended).toHaveBeenCalledWith('甲\n乙');
  });

  it('按来源限定 AI 正文，工具结果保持原样', async () => {
    await install((ctx, next) => {
      if (ctx.source === 'assistant/message') ctx.transform(splitLines);
      return next();
    });
    const h = router();
    h.reply('甲\n乙');
    h.emit('tool/call', { callId: 'call', name: 'read_file', arguments: '{}' });
    h.emit('tool/result', { message: { source: { callId: 'call' } } });
    await settle();
    expect(sent.map((message) => message.text)).toEqual(['甲', '乙', '工具结果\n第二行']);
  });
});
