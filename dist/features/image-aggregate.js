/**
 * 图片聚合（issue #40）—— 把"这段时间里收到的几张图"拼成**一张长图**，
 * 随**那条真正唤醒 AI 的消息**一起送进上下文（不是各发各的）。
 *
 * 主人定的规矩（2026-11-06）：
 *  1. 设置里能开关、能设聚合数量（默认 4，最多 8）。
 *  2. 环形缓冲按**到达顺序**：最新的排最下面，最旧的排最上面。
 *  3. **已经聚合过的图片不再聚合**（`sent` 标记）—— 否则同一张图会反复烧 token。
 *  4. 只有当前模型**声明了 image 输入**才走这条；纯文本模型直接跳过（省 token 也免得报错）。
 *  5. 拼接是**异步**的，失败就当没有聚合，绝不阻断入站主链。
 *
 * 设计取舍（主人问过"多图快会不会太耗 token"→ 选长图）：
 *   长图 = 一块 ImageBlock，比 N 块省得多；发送者名字**不画在图上**（省得接中文字体），
 *   改为随图附一句文字说明，模型照样知道每格是谁发的。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let jimpMod;
async function loadJimp() {
    if (jimpMod)
        return jimpMod;
    try {
        jimpMod = (await import('jimp'));
        return jimpMod;
    }
    catch {
        return undefined;
    }
}
/** 单格宽度（px）：够看清梗，又不至于把长图撑爆 */
const TILE_W = 400;
/** 长图总高上限（px）：超了就从**最旧**的开始丢 */
const TOTAL_H = 2400;
/** 会话 → 环形缓冲 */
const buffers = new Map();
/**
 * 会话 → 已经聚合过的图片路径（有上限，只留最近的几十条）。
 *
 * ⚠️ 为什么光靠缓冲里的 `sent` 不够：缓冲满了会把最旧的挤出去，可那张图还在"历史"里 ——
 *   下次从历史里补录时就会被当成新图再拼一遍。主人明确定过"已聚合过的不重复聚合"，
 *   所以这里额外记一份"拼过就别再来"的名单。
 */
const sentPaths = new Map();
const SENT_KEEP = 64;
/** 本插件**自己聚合出来**的附件 id（只认这些，别误伤别的插件/功能的图） */
const OUR_ATTACH = new Set();
let ourAttachFile = '';
const OUR_ATTACH_KEEP = 2000;
/** 装配期调用：把我们产出的附件 id 台账绑到数据根上（跨重启也认得） */
export function initAggregateRegistry(dataRoot) {
    try {
        if (!dataRoot)
            return;
        ourAttachFile = join(dataRoot, '.qqbot', 'aggregate-ids.json');
        if (!existsSync(ourAttachFile))
            return;
        const arr = JSON.parse(readFileSync(ourAttachFile, 'utf8'));
        if (Array.isArray(arr))
            for (const id of arr)
                if (typeof id === 'string' && id)
                    OUR_ATTACH.add(id);
    }
    catch { /* 台账坏了就当空 */ }
}
/** 登记一个"我们做的"图片附件 */
export function noteOurAttachment(id) {
    try {
        const v = String(id ?? '');
        if (!v)
            return;
        OUR_ATTACH.add(v);
        if (OUR_ATTACH.size > OUR_ATTACH_KEEP) {
            const drop = OUR_ATTACH.size - OUR_ATTACH_KEEP;
            let n = 0;
            for (const k of OUR_ATTACH) {
                if (n >= drop)
                    break;
                OUR_ATTACH.delete(k);
                n += 1;
            }
        }
        if (ourAttachFile) {
            try {
                writeFileSync(ourAttachFile, JSON.stringify([...OUR_ATTACH]), 'utf8');
            }
            catch { /* ignore */ }
        }
    }
    catch { /* ignore */ }
}
/** 这个附件是不是"我们自己拼/发"的图 */
export function isOurAttachment(id) {
    const v = String(id ?? '');
    return !!v && OUR_ATTACH.has(v);
}
let probeImageInput;
let saveImage;
/** bootstrap 装配期注入（每次启动覆盖一次，幂等） */
export function setImageAggregateHooks(hooks) {
    if (hooks.probeImageInput)
        probeImageInput = hooks.probeImageInput;
    if (hooks.saveImage)
        saveImage = hooks.saveImage;
}
/** 取某会话的缓冲（没有就建） */
function bufferOf(key) {
    let arr = buffers.get(key);
    if (!arr) {
        arr = [];
        buffers.set(key, arr);
    }
    return arr;
}
/**
 * 把一条消息里的图片塞进环形缓冲。
 *
 * @param key 会话键（`group:<gid>` / `c2c:<openid>`）
 * @param path 本地图片路径
 * @param sender 发送者显示名
 * @param max 环形缓冲上限（1~8）
 * @returns 缓冲后的条数（0 = 没进去，比如路径不存在/重复）
 */
export function pushAggImage(key, path, sender, max) {
    if (!path || !existsSync(path))
        return 0;
    if (sentPaths.get(key)?.includes(path))
        return bufferOf(key).length; // 拼过的别再进来
    const cap = Math.max(1, Math.min(8, Math.floor(max) || 4));
    const arr = bufferOf(key);
    // 同一张图（同路径）只留一份——重新发一次同图没意义，还会让长图里出现重复格
    if (arr.some((i) => i.path === path))
        return arr.length;
    arr.push({ path, sender: sender || '某人', at: Date.now(), sent: false });
    // 超上限：丢**最旧**的（数组头）
    while (arr.length > cap)
        arr.shift();
    return arr.length;
}
/** 看某个会话还欠着哪些没聚合的图（按到达顺序，旧 → 新） */
export function pendingAggImages(key) {
    return bufferOf(key).filter((i) => !i.sent);
}
/** 把这几张标成"已聚合"，之后不再重复进长图 */
export function markAggSent(items) {
    for (const i of items)
        i.sent = true;
}
/** 记住这些路径已经拼过（缓冲被挤出去以后也照样不让它们回来） */
export function rememberAggSentPaths(key, paths) {
    if (paths.length === 0)
        return;
    const list = sentPaths.get(key) ?? [];
    for (const p of paths)
        if (!list.includes(p))
            list.push(p);
    while (list.length > SENT_KEEP)
        list.shift();
    sentPaths.set(key, list);
}
/** 清空某会话的缓冲（重启/清屏用；正常流程不调） */
export function clearAggImages(key) {
    buffers.delete(key);
}
/**
 * 把若干张图**垂直拼成一张长图**（旧在上、新在下）。
 *
 * @param items 已按到达顺序排好的图片（旧 → 新）
 * @returns JPEG 字节 + 尺寸；全部读失败时返回 undefined
 */
export async function stitchAggImages(items) {
    if (items.length === 0)
        return undefined;
    const jimp = await loadJimp();
    if (!jimp)
        return undefined;
    const { Jimp } = jimp;
    const loaded = [];
    for (const it of items) {
        try {
            if (!existsSync(it.path))
                continue;
            const img = await Jimp.read(it.path);
            // 统一成 TILE_W 宽（等比），保证每格左右对齐
            const w = img.bitmap.width;
            const h = img.bitmap.height;
            if (w <= 0 || h <= 0)
                continue;
            if (w !== TILE_W)
                img.resize({ w: TILE_W, h: Math.max(1, Math.round((h * TILE_W) / w)) });
            loaded.push({ img, src: it });
        }
        catch {
            /* 单张读不了就跳过，不影响其它格 */
        }
    }
    if (loaded.length === 0)
        return undefined;
    // 超高就从**最旧**那头丢（保持"最新的总在"）
    let used = loaded;
    let total = used.reduce((s, x) => s + x.img.bitmap.height, 0);
    while (total > TOTAL_H && used.length > 1) {
        total -= used[0].img.bitmap.height;
        used = used.slice(1);
    }
    // 只剩一张还超高 → 等比压到上限
    if (total > TOTAL_H) {
        const only = used[0];
        const scale = TOTAL_H / total;
        only.img.resize({ w: Math.max(1, Math.round(only.img.bitmap.width * scale)), h: Math.max(1, Math.round(only.img.bitmap.height * scale)) });
        total = only.img.bitmap.height;
    }
    const canvas = new Jimp({ width: TILE_W, height: total, color: 0xffffffff });
    let y = 0;
    for (const { img } of used) {
        canvas.composite(img, 0, y);
        y += img.bitmap.height;
    }
    const buf = await canvas.getBuffer('image/jpeg', { quality: 82 });
    return { data: new Uint8Array(buf), width: TILE_W, height: total, used: used.map((u) => u.src) };
}
/** 拼一句说明：哪几格是谁发的 */
function senderLegend(items) {
    const parts = items.map((it, idx) => `第${idx + 1}格 ${it.sender}`);
    return `[图片聚合] 这 ${items.length} 张图按时间从旧到新竖向拼在一起（最上面最旧）：${parts.join('；')}。`;
}
/**
 * 真正干活的那一步：**当前模型支持读图**时，把没聚合过的图拼成一张长图，
 * 返回要追加进消息的 content blocks（一条文字说明 + 一块 ImageBlock）。
 *
 * 任何一环不满足（没图 / 非多模态 / 只有 1 张 / 拼接失败 / 存档失败）都返回 undefined，
 * 调用方原样发原消息即可 —— 本功能**永远不该**让消息发不出去。
 *
 * @param key 会话键
 * @param agent 当前会话 agent（探测模型能力用）
 * @param logger 日志
 */
export async function buildAggregateBlocks(key, agent, logger) {
    const items = pendingAggImages(key);
    if (items.length === 0)
        return undefined;
    if (!probeImageInput || !saveImage) {
        logger?.debug?.('[图片聚合] 宿主钩子没注入（没重启 dsh？），跳过');
        return undefined;
    }
    let capable;
    try {
        capable = await probeImageInput(agent);
    }
    catch (e) {
        logger?.debug?.(`[图片聚合] 模型能力探测失败，跳过: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
    }
    if (capable !== true) {
        logger?.debug?.('[图片聚合] 当前模型不声明 image 输入，跳过（纯文本模型不做聚合）');
        return undefined;
    }
    // ── 只有 1 张：直接原图入库，不拼 ──
    //   为什么不拼：拼一张等于白转一次码（多一次 JPEG 损失 + 多耗时），没有任何收益。
    //   但仍然要入 ImageBlock —— "收到图就要让模型真的看到图"才是这个功能的初衷。
    if (items.length === 1) {
        const one = items[0];
        try {
            const buf = readFileSync(one.path);
            if (buf.length === 0)
                return undefined;
            const mt = mediaTypeOf(one.path);
            const saved = await saveImage(new Uint8Array(buf), mt);
            if (!saved || !saved.attachment)
                return undefined;
            markAggSent([one]);
            rememberAggSentPaths(key, [one.path]);
            logger?.debug?.(`[图片聚合] 单张直接注入: ${one.path}`);
            // 顺序讲究（主人 2026-11-06 定）：**图片块在前、说明文字在后** ——
            //   反过来的话那段说明会紧贴在用户发言后面，看着像"用户自己说了这句话"。
            return [
                { type: 'image', attachment: saved.attachment },
                { type: 'text', text: `（↑ ${one.sender} 发的图）` },
            ];
        }
        catch (e) {
            logger?.warn?.(`[图片聚合] 单张注入失败: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    }
    const stitched = await stitchAggImages(items);
    if (!stitched)
        return undefined;
    let saved;
    try {
        saved = await saveImage(stitched.data, 'image/jpeg');
    }
    catch (e) {
        logger?.warn?.(`[图片聚合] 存图失败，跳过: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
    }
    if (!saved || !saved.attachment)
        return undefined;
    markAggSent(stitched.used);
    rememberAggSentPaths(key, stitched.used.map((u) => u.path));
    logger?.debug?.(`[图片聚合] 已拼 ${stitched.used.length} 张 → ${stitched.width}x${stitched.height}`);
    return [
        { type: 'image', attachment: saved.attachment },
        { type: 'text', text: senderLegend(stitched.used) },
    ];
}
/** 按扩展名猜媒体类型（宿主只收这四种） */
function mediaTypeOf(path) {
    const p = path.toLowerCase();
    if (p.endsWith('.png'))
        return 'image/png';
    if (p.endsWith('.webp'))
        return 'image/webp';
    if (p.endsWith('.gif'))
        return 'image/gif';
    return 'image/jpeg';
}
//# sourceMappingURL=image-aggregate.js.map