/**
 * face-placeholder.ts — 彩蛋：把模型抄来的 `【表情: 狂笑】` **换成真的 QQ 表情**（2026-11-19 主人想）
 *
 * ## 为什么
 *
 * 官方 bot API 发不了 face 表情，所以入站只能把它转写成 ``【表情: 微笑】`` 这种可读文本。
 * 模型会跟着抄 —— 群友看到的就是五个字，很难看。
 *
 * 一开始的想法是「出站直接洗掉」（``stripFacePlaceholder``），但主人提了个更好的：
 * **既然我们有 face 映射表，为什么不直接换成真的表情发出去？**
 *
 * 于是成了彩蛋：模型模仿这种标记时，自动变成真表情；表里没有的名字原样保留（再交给 strip 决定）。
 *
 * ## 数据源
 *
 * **内置一份**（`face-table.ts`，187 个）—— 因为 `/face` 扩展是**可选的**，
 * 别的用户没装 ⇒ 读扩展文件会拿到空表 ⇒ 彩蛋对所有人失效（2026-11-19 主人指出我第一版就是这么错的）。
 *
 * 用户若装了那个扩展并改了表，运行时**覆盖/追加**到内置之上：
 * 同名以扩展为准（用户改的优先），扩展里新增的也认得。
 *
 * 格式：`名字 → [charCode, …]`，QQ 私有协议的控制字符（`0x14` + face id），
 * `String.fromCharCode(...)` 拼出来就是真表情。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_FACE_TABLE } from './face-table.js';
/** `【表情: 狂笑】` / `【表情：狂笑】` */
const PLACEHOLDER_RE = /【表情[:：]\s*([^】]{1,24}?)】/g;
/** 内置表（模块级建一次，不可变） */
const BUILTIN = (() => {
    const m = new Map();
    for (const [name, codes] of Object.entries(BUILTIN_FACE_TABLE)) {
        if (!Array.isArray(codes) || codes.length === 0)
            continue;
        m.set(name, String.fromCharCode(...codes));
    }
    return m;
})();
/** dataRoot → 缓存。一个进程里通常只有一个 dataRoot，多实例时也能分开。 */
const cache = new Map();
/**
 * 读用户扩展那份并**叠加**到内置之上。
 *
 * - 没装扩展 / 文件不存在 / 坏 JSON → **直接用内置**（这是关键：保证人人可用）
 * - 装了 → 同名的以扩展为准（用户改的优先），扩展新增的也认
 *
 * ⚙️ 性能（2026-11-19 主人问"对性能有影响吗"）：
 *   原来每次调用都 `statSync` 判 mtime —— 那是个**系统调用**，约 40µs。
 *   单看微不足道，但这函数**每条出站消息都要跑**，而绝大多数消息里根本没有 `【表情`。
 *   所以加个 **5 秒 TTL**：窗口内不再 stat，直接用缓存。
 *   代价是"用户在扩展里改了表情表"最多 5 秒后才生效 —— 完全可以接受。
 */
const STAT_TTL_MS = 5_000;
function loadMap(dataRoot) {
    if (!dataRoot)
        return BUILTIN;
    const now = Date.now();
    const hit = cache.get(dataRoot);
    // TTL 内直接吃缓存（连 statSync 都不做）
    if (hit && now - hit.checkedAt < STAT_TTL_MS)
        return hit.map;
    const file = join(dataRoot, '.qqbot-extensions', 'qq-faces.json');
    let mtime = -1;
    try {
        mtime = statSync(file).mtimeMs;
    }
    catch {
        if (hit && hit.mtime === -1) {
            hit.checkedAt = now; // 文件还是不存在，只刷新检查时间
            return hit.map;
        }
        cache.set(dataRoot, { mtime: -1, map: BUILTIN, checkedAt: now });
        return BUILTIN;
    }
    if (hit && hit.mtime === mtime) {
        hit.checkedAt = now; // mtime 没变，只刷新检查时间
        return hit.map;
    }
    // 从内置起步，再用扩展覆盖 —— 扩展坏了也不影响内置那 187 条
    const map = new Map(BUILTIN);
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const [name, codes] of Object.entries(raw)) {
            if (name.startsWith('_'))
                continue; // _comment 之类的元数据
            if (!Array.isArray(codes) || codes.length === 0)
                continue;
            if (!codes.every((c) => typeof c === 'number'))
                continue;
            map.set(name, String.fromCharCode(...codes));
        }
    }
    catch {
        // 文件坏了 → 保留内置那 187 条，不崩
    }
    cache.set(dataRoot, { mtime, map, checkedAt: now });
    return map;
}
/**
 * 把正文里的 `【表情: 名字】` 换成真表情字符。
 *
 * - 表里有这个名字 → 换成真表情
 * - 表里没有 / 没装扩展 → **原样保留**（交给后面的 strip 决定要不要删）
 *
 * @param dataRoot 数据根（拼 `.qqbot-extensions/qq-faces.json`）
 */
export function replaceFacePlaceholders(text, dataRoot) {
    const src = String(text ?? '');
    if (!src || src.indexOf('【表情') < 0)
        return src;
    const map = loadMap(dataRoot);
    if (map.size === 0)
        return src;
    return src.replace(PLACEHOLDER_RE, (all, rawName) => {
        const name = String(rawName ?? '').trim();
        return map.get(name) ?? all;
    });
}
/** 表情表里有几个名字（给设置页/诊断用） */
export function faceMapSize(dataRoot) {
    return loadMap(dataRoot).size;
}
/**
 * 清掉文件缓存（**仅供测试**）。
 *
 * 生产环境不需要：mtime + 5 秒 TTL 已经能保证用户改完表很快生效。
 * 测试里要逐个用例验证"改了文件应该读到新值"，TTL 会挡住，所以留个后门。
 */
export function _clearFaceCache() {
    cache.clear();
}
//# sourceMappingURL=face-placeholder.js.map