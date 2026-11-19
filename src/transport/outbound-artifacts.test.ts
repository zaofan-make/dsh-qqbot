/**
 * issue #72 / #73 的**集成**测试 —— 断言 outbound.ts 真的接上了那两个纯函数。
 *
 * 为什么必须有这一层：`strip-artifacts.test.ts` / `turn-error.test.ts` 只证明**纯函数对**。
 * 如果哪天有人把那两段接入代码挪走/改坏，纯函数测试依然全绿，线上却已经漏了。
 * （2026-11-19 子代理审查就是因为缺这层，只能靠临时用例才发现缓冲路径绕过清洗。）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QQBotSender } from './outbound-buffer.js';
import { createOutboundHandler } from './outbound.js';
import { resetOutboundBreaker } from '../features/ext-outbound.js';
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { Logger } from '../types.js';

vi.mock('../features/four-source.js', () => ({
  noteTurnSignals: vi.fn(), applyTurnAttitude: vi.fn(), extractInnerText: () => '',
}));
vi.mock('../features/thinking-log.js', () => ({ noteThinking: vi.fn() }));
vi.mock('./tool-presenter.js', () => ({ formatToolResult: () => '工具结果\n第二行' }));

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

let root: string;
let sent: Array<{ text: string }>;
let bot: QQBotSender;

const target = { scope: 'group' as const, targetId: 'gid', msgId: 'm1' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetOutboundBreaker();
  root = mkdtempSync(join(tmpdir(), 'outbound-artifacts-'));
  sent = [];
  bot = {
    sendMarkdown: vi.fn(async (_to: unknown, text: string) => { sent.push({ text }); }),
    sendMedia: vi.fn(async () => undefined),
    recallByIndex: vi.fn(async () => true),
  } as unknown as QQBotSender;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await vi.runAllTimersAsync();
  await vi.dynamicImportSettled();
}

function makeHandler(extra: Record<string, unknown> = {}) {
  const record = {
    sessionKey: 'group:gid', replyTarget: { ...target }, lastInboundAt: Date.now(),
    agent: { steer: vi.fn() }, turnStartAt: Date.now(), turnOrigin: 'qq',
  } as unknown as SessionRecord;
  const config = {
    dataRoot: root, streaming: false, textChunkLimit: 4500,
    outboundMode: 'adaptive', showToolResults: false, ...extra,
  } as unknown as Record<string, unknown>;
  const handler = createOutboundHandler(
    { findBySessionId: () => record, findByPeer: () => record } as unknown as SessionManager,
    bot,
    config as never,
    logger,
  );
  const emit = (type: string, data: Record<string, unknown>) => handler({ header: { id: 'session' } }, { type, data });
  const reply = (text: string) => emit('assistant/message', { message: { content: [{ type: 'text', text }] } });
  return { record, config, emit, reply };
}

const allText = () => sent.map((s) => s.text).join('\n');

describe('issue #72 · 出站清洗真的接上了', () => {
  it('开关打开时，模型正文里的时间头被洗掉', async () => {
    const h = makeHandler({ stripTimeHead: true, stripFacePlaceholder: true });
    h.reply('[2026-11-19 周四 09:52]\n啊呜');
    await settle();
    expect(allText()).toContain('啊呜');
    expect(allText()).not.toContain('2026-11-19');
  });

  it('默认关（不配置）→ 时间头原样发出去（与旧版逐字一致）', async () => {
    const h = makeHandler();
    h.reply('[2026-11-19 周四 09:52]\n啊呜');
    await settle();
    expect(allText()).toContain('2026-11-19');
  });

  it('【表情: XX】开关打开时被洗掉', async () => {
    const h = makeHandler({ stripTimeHead: true, stripFacePlaceholder: true });
    h.reply('哈哈哈【表情: 狂笑】');
    await settle();
    expect(allText()).toContain('哈哈哈');
    expect(allText()).not.toContain('【表情');
  });

  it('非模型正文（回合报错）里的时间戳**不**被洗（只治 assistant/message）', async () => {
    const h = makeHandler({ stripTimeHead: true, stripFacePlaceholder: true, turnErrorMode: 'notify' });
    // 报错走 send(..., 'turn/end')，不是 assistant/message ⇒ 不该被清洗。
    // 这类文本里的时间戳是**真实内容**（上游错误原文），削掉会让排查失去线索。
    h.emit('turn/end', {
      reason: { kind: 'error', error: { code: 'ETIMEDOUT', message: '上游超时 [2026-11-19 09:52] heartbeat lost' } },
    });
    await settle();
    expect(allText()).toContain('2026-11-19');
  });
});

describe('issue #73 · 回合异常四档真的接上了', () => {
  const boom = () => ({ kind: 'error', error: { code: 'INVALID_REQUEST', message: '400: {"code":10013}' } });

  it('notify（默认）→ 原文进群', async () => {
    const h = makeHandler();
    h.emit('turn/end', { reason: boom() });
    await settle();
    expect(allText()).toContain('本轮异常结束');
    expect(allText()).toContain('400');
  });

  it('silent → 一条都不发', async () => {
    const h = makeHandler({ turnErrorMode: 'silent' });
    h.emit('turn/end', { reason: boom() });
    await settle();
    expect(allText()).not.toContain('本轮异常结束');
  });

  it('friendly → 发人话，且**日志里有原文**（审查发现的漏记）', async () => {
    const h = makeHandler({ turnErrorMode: 'friendly' });
    h.emit('turn/end', { reason: boom() });
    await settle();
    expect(allText()).toContain('卡住了');
    expect(allText()).not.toContain('INVALID_REQUEST');
    // 细节必须进日志，否则开了 friendly 反而查不到是哪个 400
    const warned = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(' ');
    expect(warned).toContain('INVALID_REQUEST');
  });

  it('regex 命中 → 静默；没命中 → 照常发', async () => {
    const hit = makeHandler({ turnErrorMode: 'regex', turnErrorSilentPattern: '400' });
    hit.emit('turn/end', { reason: boom() });
    await settle();
    expect(allText()).not.toContain('本轮异常结束');

    sent.length = 0;
    const miss = makeHandler({ turnErrorMode: 'regex', turnErrorSilentPattern: '内容违规' });
    miss.emit('turn/end', { reason: boom() });
    await settle();
    expect(allText()).toContain('本轮异常结束');
  });
});
