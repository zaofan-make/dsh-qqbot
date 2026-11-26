import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * sticker-capture 队列行为的回归测试（审核 R3 补）
 *
 * 守两件事：
 *   1. **并发上限**：`MAX_INFLIGHT = 3`，一次塞 10 张也不能超发（原来并发满就直接丢，
 *      现在改成排队 —— 排队之后"不超发"这件事只能靠 pump 保证，必须测住）。
 *   2. **抛错不卡死**：某张下载抛错时 `inflight` 要能正确回退，
 *      否则计数永久占满，后面所有图再也下不动（静默哑掉）。
 */

const captureImpl = vi.fn();
const pathOfImpl = vi.fn(() => 'D:/sticker/lib/candidate/x.jpg');

vi.mock('../features/sticker-store.js', () => ({
  getStickerStore: () => ({
    capture: captureImpl,
    pathOf: pathOfImpl,
    cleanupCandidates: () => undefined,
    cleanupTrash: () => undefined,
    purgeTrashed: () => undefined,
    setDescTags: () => undefined,
  }),
}));
vi.mock('../gateway/data-root.js', () => ({ stickerDirOf: () => 'D:/sticker' }));
vi.mock('../features/sticker-tagger.js', () => ({ autoTagImage: async () => undefined }));
vi.mock('../features/image-path-cache.js', () => ({ rememberImagePath: () => undefined }));
vi.mock('../features/image-url-ledger.js', () => ({ recordImageUrl: () => undefined }));

/** 每个测试都重新 import，拿到干净的模块级队列/inflight */
async function loadFresh() {
  vi.resetModules();
  return await import('./sticker-capture.js');
}

/** 造一个带 n 张图的中间件 ctx */
function makeCtx(imageCount: number) {
  return {
    message: {
      kind: 'group',
      groupOpenid: 'G1',
      senderId: 'U1',
      senderName: '张三',
      content: '',
      attachments: Array.from({ length: imageCount }, (_, i) => ({
        content_type: 'image/jpeg',
        url: `https://multimedia.nt.qq.com.cn/download?fileid=FILE${i}`,
        filename: `a${i}.jpg`,
      })),
    },
  } as never;
}

const CONFIG = {
  sticker: { collectEnabled: true, fullDownload: true, autoTagEnabled: false },
} as never;
const LOGGER = { debug: () => undefined, info: () => undefined, warn: () => undefined } as never;

beforeEach(() => {
  captureImpl.mockReset();
  pathOfImpl.mockReset();
  pathOfImpl.mockReturnValue('D:/sticker/lib/candidate/x.jpg');
});

describe('stickerCapture 队列', () => {
  it('一次 10 张也不并发超过 3（MAX_INFLIGHT）', async () => {
    const { stickerCapture } = await loadFresh();

    let concurrent = 0;
    let peak = 0;
    captureImpl.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
      return { status: 'new', id: 'x' };
    });

    const mw = stickerCapture(CONFIG, LOGGER);
    await mw(makeCtx(10), async () => undefined);

    // 主链已返回，后台还在跑 —— 等它排干
    await new Promise((r) => setTimeout(r, 300));

    expect(peak).toBeLessThanOrEqual(3);
    expect(captureImpl).toHaveBeenCalledTimes(10); // 10 张都下过（不是只下 3 张）
  });

  it('某张抛错后计数回退，后面的图仍能继续下（不卡死在满并发）', async () => {
    const { stickerCapture } = await loadFresh();

    let n = 0;
    captureImpl.mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 5));
      return { status: 'new', id: 'x' };
    });

    const mw = stickerCapture(CONFIG, LOGGER);
    await mw(makeCtx(8), async () => undefined);
    await new Promise((r) => setTimeout(r, 300));

    // 8 张全都进过 capture（抛错那张不算卡死）
    expect(captureImpl).toHaveBeenCalledTimes(8);
  });

  it('fullDownload=false 时退回老行为：只收前 3 张', async () => {
    const { stickerCapture } = await loadFresh();
    captureImpl.mockResolvedValue({ status: 'new', id: 'x' });

    const cfg = { sticker: { collectEnabled: true, fullDownload: false, autoTagEnabled: false } } as never;
    const mw = stickerCapture(cfg, LOGGER);
    await mw(makeCtx(10), async () => undefined);
    await new Promise((r) => setTimeout(r, 200));

    expect(captureImpl).toHaveBeenCalledTimes(3);
  });

  it('collectEnabled=false 时一张都不碰', async () => {
    const { stickerCapture } = await loadFresh();
    captureImpl.mockResolvedValue({ status: 'new', id: 'x' });

    const cfg = { sticker: { collectEnabled: false, fullDownload: true, autoTagEnabled: false } } as never;
    const mw = stickerCapture(cfg, LOGGER);
    await mw(makeCtx(5), async () => undefined);
    await new Promise((r) => setTimeout(r, 100));

    expect(captureImpl).not.toHaveBeenCalled();
  });
});
