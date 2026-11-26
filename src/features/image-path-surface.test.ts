import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * image-path-surface 的回归测试（2026-11-26，审核 S11「零测试覆盖」补）
 *
 * 重点守两件事：
 *   1. **正则保真**（M1）：真实入站格式是 `[图片: <url>]`，替换时**不能吞掉 `]`、
 *      也不能吞掉紧跟其后的正文**。这条曾经写错过：`[^\s)]` 会把 `]` 一起吃掉。
 *   2. **surfaceOp 参数构造**（M3/S9）：运行时 dsh-session@0.2.2-rc.3 认的是
 *      `{ op:'replace', startSeq, endSeq }`，且 `sourceEventSeqs` 必须列全被遮蔽的 seq。
 */

const mockLookup = vi.fn<(url: string) => string | undefined>();
vi.mock('./image-path-cache.js', () => ({
  lookupImagePath: (url: string) => mockLookup(url),
}));

const { replaceImagePathsInSurface } = await import('./image-path-surface.js');

const QQ_URL = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=ABC&rkey=XYZ';
const LOCAL = 'D:/sticker/lib/candidate/abc123.jpg';

interface FakeEvent {
  type: string;
  seq: number;
  data?: { content?: Array<{ type: string; text?: string }> };
}

interface FakeSession {
  surface: { nodes: number[] };
  eventAt: (seq: number) => FakeEvent | undefined;
  append: (type: string, data: unknown, opts?: unknown) => { seq: number };
}

/** 造一个最小 session：nodes = [system, userA]，userA 带一段含 URL 的文本 */
function makeSession(userText: string): {
  sess: FakeSession;
  appended: Array<{ type: string; data: any; opts: any }>;
  nodes: number[];
} {
  const events = new Map<number, FakeEvent>();
  const nodes = [0, 1];
  events.set(0, { type: 'system', seq: 0 });
  events.set(1, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: userText }] } });
  const appended: Array<{ type: string; data: any; opts: any }> = [];
  let nextSeq = 2;
  const sess: FakeSession = {
    surface: { nodes },
    eventAt: (seq) => events.get(seq),
    append: (type, data, opts) => {
      appended.push({ type, data, opts });
      const seq = nextSeq++;
      return { seq };
    },
  };
  return { sess, appended, nodes };
}

beforeEach(() => {
  mockLookup.mockReset();
});

describe('replaceImagePathsInSurface', () => {
  it('把 [图片: <url>] 换成本地路径，且保留 ] 与后面的正文（M1 回归）', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const { sess, appended } = makeSession(`看图 [图片: ${QQ_URL}] 好看吗`);

    const n = await replaceImagePathsInSurface({ session: sess } as never, undefined, 1);

    expect(n).toBe(1);
    expect(appended).toHaveLength(1);
    const text = appended[0]!.data.content[0].text as string;
    // 关键：URL 换成路径，但 ] 和「 好看吗」必须原样保留
    expect(text).toBe(`看图 [图片: ${LOCAL}] 好看吗`);
    expect(text).toContain('] 好看吗');
  });

  it('裸 URL 后面跟中文标点时，不吞标点与后文（M1 回归）', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const { sess, appended } = makeSession(`看图 ${QQ_URL}，然后呢`);

    await replaceImagePathsInSurface({ session: sess } as never, undefined, 1);

    const text = appended[0]!.data.content[0].text as string;
    expect(text).toBe(`看图 ${LOCAL}，然后呢`);
  });

  it('surfaceOp 用运行时的 startSeq/endSeq 形状，且 sourceEventSeqs 列全（M3/S9）', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const { sess, appended } = makeSession(`[图片: ${QQ_URL}]`);

    await replaceImagePathsInSurface({ session: sess } as never, undefined, 7);

    const opts = appended[0]!.opts as { surfaceOp: Record<string, unknown>; sourceEventSeqs: number[] };
    // 宿主 isReplaceOp 要求恰好 3 个键 —— 多一个少一个都 invalid
    expect(Object.keys(opts.surfaceOp).sort()).toEqual(['endSeq', 'op', 'startSeq']);
    expect(opts.surfaceOp).toEqual({ op: 'replace', startSeq: 1, endSeq: 1 });
    // 被遮蔽的 seq 必须列全
    expect(opts.sourceEventSeqs).toEqual([1]);
  });

  it('旧版宿主（认 start/end 不认 startSeq/endSeq）时自动回退，仍然替换成功', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const events = new Map<number, { type: string; seq: number; data?: any }>();
    events.set(0, { type: 'system', seq: 0 });
    events.set(1, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: `[图片: ${QQ_URL}]` }] } });

    const okShape: any[] = [];
    let attempts = 0;
    const sess = {
      surface: { nodes: [0, 1] },
      eventAt: (seq: number) => events.get(seq),
      append: (type: string, data: any, opts: any) => {
        attempts += 1;
        // 模拟 0.1.0-rc.6：只认 { op, start, end }，其他形状抛 invalid
        const keys = Object.keys(opts.surfaceOp ?? {}).sort().join(',');
        if (keys !== 'end,op,start') {
          throw new Error('session event "user/message" carries an invalid replace surfaceOp');
        }
        okShape.push(opts);
        return { seq: 99 };
      },
    };

    const n = await replaceImagePathsInSurface({ session: sess } as never, undefined, 1);

    expect(n).toBe(1);            // 回退之后仍然替换成功
    expect(attempts).toBe(2);     // 先试 rc.3 写法失败，再试旧写法成功
    expect(okShape[0].surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 });
  });

  it('非字段名错误（如 seq 已不在 surface）不回退，直接抛给上层 catch', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const events = new Map<number, { type: string; seq: number; data?: any }>();
    events.set(0, { type: 'system', seq: 0 });
    events.set(1, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: `[图片: ${QQ_URL}]` }] } });

    let attempts = 0;
    const sess = {
      surface: { nodes: [0, 1] },
      eventAt: (seq: number) => events.get(seq),
      append: () => {
        attempts += 1;
        throw new Error('start seq 1 not found in surface');
      },
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const n = await replaceImagePathsInSurface({ session: sess } as never, logger as never, 1);

    expect(n).toBe(0);
    expect(attempts).toBe(1);     // 只试一次，没有盲目回退
  });

  it('普通链接不该被替换（N4 反向断言：只认 QQ 图片域名）', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const { sess, appended } = makeSession(
      '看这个 https://example.com/a.png 和这个 https://x.com/?fileid=ABC123 谢谢',
    );

    const n = await replaceImagePathsInSurface({ session: sess } as never, undefined, 1);

    // 域名不匹配 ⇒ 一眼都不看，不查缓存、不追加事件
    expect(n).toBe(0);
    expect(appended).toHaveLength(0);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('缓存没命中（还没下完）时不替换、不追加事件', async () => {
    mockLookup.mockReturnValue(undefined);
    const { sess, appended } = makeSession(`[图片: ${QQ_URL}]`);

    const n = await replaceImagePathsInSurface({ session: sess } as never, undefined, 1);

    expect(n).toBe(0);
    expect(appended).toHaveLength(0);
  });

  it('没有 assistant/message 的新会话也要处理（S3 回归：不能一次都不跑）', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const { sess, appended } = makeSession(`[图片: ${QQ_URL}]`);

    const n = await replaceImagePathsInSurface({ session: sess } as never, undefined, 1, { scope: 'tail' });

    expect(n).toBe(1);
    expect(appended).toHaveLength(1);
  });

  it('append 抛错时只记日志，不往外抛（不影响主链）', async () => {
    mockLookup.mockReturnValue(LOCAL);
    const events = new Map<number, FakeEvent>();
    events.set(0, { type: 'system', seq: 0 });
    events.set(1, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: `[图片: ${QQ_URL}]` }] } });
    const sess: FakeSession = {
      surface: { nodes: [0, 1] },
      eventAt: (seq) => events.get(seq),
      append: () => {
        throw new Error('invalid replace surfaceOp');
      },
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await expect(
      replaceImagePathsInSurface({ session: sess } as never, logger as never, 1),
    ).resolves.toBe(0);
  });
});
