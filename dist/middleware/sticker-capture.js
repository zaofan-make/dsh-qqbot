import { stickerDirOf } from '../gateway/data-root.js';
import { getStickerStore } from '../features/sticker-store.js';
import { autoTagImage } from '../features/sticker-tagger.js';
import { rememberImagePath } from '../features/image-path-cache.js';
import { recordImageUrl } from '../features/image-url-ledger.js';
/** 同进程并发下载上限，防止群图轰炸时打爆连接 */
let inflight = 0;
const MAX_INFLIGHT = 3;
/** 候选区软上限(2026-09-13 主人定: 300 → 500) —— 超出的最久未见条目滚进回收站 */
const MAX_CANDIDATES = 500;
/**
 * 回收站条数上限（2026-10-05 主人要求）：trash 层超过它就按"进回收站时间"从旧到新真删。
 * 之前回收站无上限，一路涨到 4000 张 —— 它是"软删除的缓冲"，不该当永久仓库。
 * 想保留更多就调大这个数；想更狠就调小。
 */
const MAX_TRASH = 800;
/**
 * 收藏开关关闭时，单条消息里最多顺手收几张（老行为，保留）。
 * 开关打开时走队列、不再按条数截断。
 */
const MAX_PER_MSG = 3;
/** 待下载队列上限 —— 群图轰炸时兜底，超出丢最旧的（它们下次还会再发） */
const MAX_QUEUE = 80;
/** 图片 URL 是否可收藏（仅 https + 看似 QQ 图片下载链接） */
function isCollectableImage(url) {
    return !!url && /^https:\/\//i.test(url) && /multimedia|qq\.com|download/i.test(url);
}
/**
 * 类型粗筛：SDK 的 content_type 是 MIME(如 image/jpeg —— 已实测不是 'image')。
 * 明确非图片(音/视频)的排除；未知/缺失交给 store 的魔数校验兜底(非图不入库)。
 */
function isNonImageContentType(ct) {
    if (!ct)
        return false;
    const t = ct.toLowerCase();
    return t.startsWith('audio/') || t.startsWith('video/') || t === 'voice';
}
const queue = [];
/** 真正执行一次收藏（落盘 + 记住本地路径）；返回本地路径（失败返回 undefined） */
async function captureOne(job) {
    const { url, contentType, senderId, senderName, sourceGroup, msgText, stickerDir, config, logger } = job;
    const store = getStickerStore(stickerDir, logger);
    let resolved;
    try {
        resolved = await store.capture(url, { sourceGroup, senderId, senderName, msgText, sourceUrl: url }, contentType);
    }
    catch (err) {
        // ★ 2026-11-26：从 debug 提到 info —— 下载失败/超限以前完全静默，
        //   表现成"这张图压根没下载"，主人排查了半天。热路径日志该收敛，
        //   但"这张图没进来"属于必须能看见的事件。
        logger.info(`[sticker] 采集失败（这张图不会进库）: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
    if (!resolved.id) {
        if (resolved.status === 'error')
            logger.info(`[sticker] 采集失败: ${resolved.error}`);
        return undefined;
    }
    // 台账兜底(2026-09-13 主人要求, 只图片): 记「图库 id → 这条 QQ 链接」——
    //   本地文件日后被清理/搬层/删掉时, dock 还能拿这条链接把图显示出来。上限 1000 条。
    recordImageUrl(stickerDir, resolved.id, url);
    const localPath = store.pathOf(resolved.id);
    if (localPath)
        rememberImagePath(url, localPath);
    if (resolved.status === 'new') {
        logger.debug(`[sticker] captured #${resolved.id} → ${localPath ?? '(path?)'}`);
        // 候选区软上限 + 回收站物理清理（纯本地操作，同步做完很快）
        try {
            store.cleanupCandidates(MAX_CANDIDATES);
        }
        catch { /* ignore */ }
        try {
            store.cleanupTrash(MAX_TRASH);
        }
        catch { /* ignore */ } // 回收站超限 → 旧的物理删
        try {
            store.purgeTrashed();
        }
        catch { /* ignore */ }
        // 后台自动打标(可配视觉CLI 生成 tags+desc; 无可用引擎则保持 needsDescribe 待 agent 视觉补)
        if (localPath && config.sticker.autoTagEnabled !== false) {
            void (async () => {
                try {
                    const tag = await autoTagImage(localPath, config.sticker.visionCli ?? '', logger);
                    if (tag) {
                        store.setDescTags(resolved.id, tag.tags, tag.desc);
                        logger.debug(`[sticker] 自动打标 #${resolved.id}: tags=${tag.tags.join('/') || '(启发)'} desc=${tag.desc.slice(0, 40)}…`);
                    }
                }
                catch (err) {
                    logger.debug(`[sticker] autotag error: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
        }
    }
    else {
        logger.debug(`[sticker] dup #${resolved.id} (已在库, 只刷新 lastSeenAt)`);
    }
    return localPath;
}
/** 从队列里取活干，直到并发打满或队列空 */
function pump() {
    while (inflight < MAX_INFLIGHT && queue.length > 0) {
        const job = queue.shift();
        inflight += 1;
        void captureOne(job)
            .catch(() => undefined)
            .finally(() => {
            inflight -= 1;
            pump(); // 腾出并发位就继续排干（即使当前没有新消息进来）
        });
    }
}
/** 入队（队列满了丢最旧的 —— 那张图下次再发还会被收） */
function enqueue(job) {
    if (queue.length >= MAX_QUEUE) {
        const dropped = queue.shift();
        if (dropped) {
            job.logger.debug(`[sticker] 队列已满(${MAX_QUEUE})，丢弃最旧的待下载: ${dropped.url.slice(0, 60)}…`);
        }
    }
    queue.push(job);
    pump();
}
export function stickerCapture(config, logger) {
    return async (ctx, next) => {
        // 先"发起"下载（不等它完成），再走主链 —— 保证被后续截断(未@被门控吞)也照样收藏。
        // ⚠️ 2026-09-13 主人定稿：主链**0 等待**，落盘后路径才异步补进 image-path-cache，
        //   所以这条消息未必用得上本地路径(检索不到就回退 QQ 链接) —— 这是刻意取舍：宁可用链接也不拖入站。
        if (config.sticker.collectEnabled) {
            try {
                const msg = ctx.message;
                // content_type 是 MIME(image/jpeg 等)，不能 == 'image'（踩坑修正）
                const all = (msg.attachments ?? [])
                    .filter(a => isCollectableImage(a.url) && !isNonImageContentType(a.content_type));
                // ★ 2026-11-26：开关打开 → 全部入队；关闭 → 只收前 MAX_PER_MSG 张（老行为）
                const picked = config.sticker.fullDownload === false ? all.slice(0, MAX_PER_MSG) : all;
                if (picked.length > 0) {
                    const isGroup = ctx.message.kind === 'group';
                    const snapshot = {
                        // ★ CodeRabbit PR #93：目录在**入队时**定下来，worker 不再看 live config
                        stickerDir: stickerDirOf(config),
                        senderId: msg.senderId,
                        senderName: msg.senderName,
                        sourceGroup: isGroup ? msg.groupOpenid : undefined,
                        msgText: (msg.content ?? '').trim().slice(0, 120) || undefined,
                        config,
                        logger,
                    };
                    for (const img of picked) {
                        enqueue({ url: img.url, contentType: img.content_type, ...snapshot });
                    }
                    if (picked.length > MAX_PER_MSG) {
                        logger.debug(`[sticker] 已入队 ${picked.length} 张(全部下载模式)，主链不等待`);
                    }
                }
            }
            catch {
                // 收藏调度失败不影响主链
            }
        }
        await next();
    };
}
//# sourceMappingURL=sticker-capture.js.map