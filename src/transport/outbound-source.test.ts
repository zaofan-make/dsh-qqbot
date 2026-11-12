import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutboundHandler } from './outbound.js';
import { configureOutboundExtensions, loadOutboundExtensions, registerOutboundOwner, type OutboundCtx } from '../features/ext-outbound.js';
import { sendRichOutbound, type QQBotSender } from './outbound-buffer.js';
import type { ImQQBotConfig } from '../config.js';
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { Logger } from '../types.js';

vi.mock('../features/four-source.js', () => ({
  noteTurnSignals: vi.fn(), applyTurnAttitude: vi.fn(), extractInnerText: () => '',
}));
vi.mock('../features/thinking-log.js', () => ({ noteThinking: vi.fn() }));
vi.mock('./tool-presenter.js', () => ({ formatToolResult: () => '工具结果\n第二行' }));

const inspectKey = Symbol.for('qqbot.test.transport-metadata');
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
let root: string;
let seen: Array<Pick<OutboundCtx, 'source' | 'phase' | 'text'>>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'transport-metadata-'));
  configureOutboundExtensions({ dataRoot: root, logger });
  seen = [];
  Reflect.set(globalThis, inspectKey, (ctx: OutboundCtx) => {
    seen.push({ source: ctx.source, phase: ctx.phase, text: ctx.text });
  });
  const dir = join(root, '.qqbot-extensions/outbound');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inspect.mjs'), 'export default (ctx, next) => { globalThis[Symbol.for("qqbot.test.transport-metadata")](ctx); return next(); };');
  expect((await loadOutboundExtensions({ dataRoot: root, logger })).total).toBe(1);
});

afterEach(async () => {
  await loadOutboundExtensions({ dataRoot: join(root, 'empty'), logger });
  Reflect.deleteProperty(globalThis, inspectKey);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function setup(streaming = false, scope: 'group' | 'c2c' = 'group') {
  const bot = {
    sendMarkdown: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
    openStream: vi.fn(() => ({ update: vi.fn(async () => undefined), complete: vi.fn(async () => undefined) })),
  } as unknown as QQBotSender;
  registerOutboundOwner(root, bot);
  const record = {
    sessionKey: `${scope}:peer`, replyTarget: { scope, targetId: 'peer', msgId: 'inbound' },
    lastInboundAt: Date.now(), agent: {},
  } as unknown as SessionRecord;
  const config = { dataRoot: root, streaming, textChunkLimit: 4500, outboundMode: 'detail', showToolResults: true } as ImQQBotConfig;
  const handler = createOutboundHandler({ findBySessionId: () => record } as unknown as SessionManager, bot, config, logger);
  const emit = (type: string, data: Record<string, unknown>) => handler({ header: { id: 'session' } }, { type, data });
  const reply = (text: string) => emit('assistant/message', { message: { content: [{ type: 'text', text }] } });
  return { bot, record, emit, reply };
}

async function settle() {
  await vi.dynamicImportSettled();
  await vi.runAllTimersAsync();
  await vi.dynamicImportSettled();
  expect(logger.error).not.toHaveBeenCalled();
}

describe('发送入口的来源透传', () => {
  it('完整正文标记为 assistant/message', async () => {
    setup().reply('你好');
    await settle();
    expect(seen).toEqual([expect.objectContaining({ source: 'assistant/message', phase: 'send' })]);
  });

  it('缓冲区静态发送沿用完整正文来源', async () => {
    const h = setup();
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '**重点**' } });
    h.reply('**重点**');
    await settle();
    expect(seen).toEqual([expect.objectContaining({ source: 'assistant/message' })]);
  });

  it('成功的私聊流式发送不新增扩展调用', async () => {
    const h = setup(true, 'c2c');
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '你好' } });
    h.reply('你好');
    await settle();
    expect(h.bot.openStream).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  it('私聊流式失败后，静态降级仍标记完整正文来源', async () => {
    const h = setup(true, 'c2c');
    vi.mocked(h.bot.openStream).mockImplementation(() => { throw new Error('no stream'); });
    h.emit('assistant/chunk', { chunk: { type: 'text-delta', text: '你好' } });
    h.reply('你好');
    await settle();
    expect(seen).toEqual([expect.objectContaining({ source: 'assistant/message' })]);
  });

  it('工具调用和工具结果分别标记原事件名', async () => {
    const h = setup();
    h.emit('tool/call', { callId: 'call', name: 'read_file', arguments: '{}' });
    h.emit('tool/result', { message: { source: { callId: 'call' } } });
    await settle();
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tool/call' }),
      expect.objectContaining({ source: 'tool/result' }),
    ]));
  });

  it('异常结束提示标记为 turn/end', async () => {
    const h = setup();
    h.emit('turn/end', { reason: { kind: 'error', error: { code: 'FAILED', message: 'failure' } } });
    await settle();
    expect(seen).toEqual([expect.objectContaining({ source: 'turn/end' })]);
  });

  it('回合结束配图钩子保留最后一块正文的来源', async () => {
    const h = setup();
    h.reply('最后一块正文');
    await settle();
    h.emit('turn/end', {});
    await settle();
    expect(seen).toEqual([
      expect.objectContaining({ source: 'assistant/message', phase: 'send' }),
      expect.objectContaining({ source: 'assistant/message', phase: 'turnEnd', text: '最后一块正文' }),
    ]);
  });

  it('旧发送调用没有来源时使用 unknown', async () => {
    const h = setup();
    await sendRichOutbound(h.bot, h.record.replyTarget, '**旧调用**', 4500, undefined);
    expect(seen).toEqual([expect.objectContaining({ source: 'unknown' })]);
  });
});
