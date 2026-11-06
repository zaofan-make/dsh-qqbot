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
import { Jimp } from 'jimp';
import { existsSync } from 'node:fs';
/** 单格宽度（px）：够看清梗，又不至于把长图撑爆 */
const TILE_W = 400;
/** 长图总高上限（px）：超了就从**最旧**的开始丢 */
const TOTAL_H = 2400;
/** 会话 → 环形缓冲 */
const buffers = new Map();
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
    if (items.length < 2)
        return undefined; // 只有一张没必要拼
    if (!probeImageInput || !saveImage)
        return undefined;
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
    logger?.debug?.(`[图片聚合] 已拼 ${stitched.used.length} 张 → ${stitched.width}x${stitched.height}`);
    return [
        { type: 'text', text: senderLegend(stitched.used) },
        { type: 'image', attachment: saved.attachment },
    ];
}
//# sourceMappingURL=image-aggregate.js.map