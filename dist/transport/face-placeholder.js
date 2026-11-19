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
 * 复用扩展那套 ``{dataRoot}/.qqbot-extensions/qq-faces.json``（187 个，格式 ``{名字: [charCode, …]}``）——
 * 那是 QQ 私有协议的控制字符（``0x14`` + face id），``String.fromCharCode(...)`` 拼出来就是真表情。
 *
 * **不内置副本**：一是 5.6KB 没必要抄一遍，二是用户在扩展里改了名字/加了表情，这里能跟着生效。
 * 文件不存在（没装那扩展）→ 整个彩蛋静默跳过，不影响任何正文。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** `【表情: 狂笑】` / `【表情：狂笑】` */
const PLACEHOLDER_RE = /【表情[:：]\s*([^】]{1,24}?)】/g;
/** dataRoot → 缓存。一个进程里通常只有一个 dataRoot，多实例时也能分开。 */
const cache = new Map();
function loadMap(dataRoot) {
    if (!dataRoot)
        return new Map();
    const file = join(dataRoot, '.qqbot-extensions', 'qq-faces.json');
    let mtime = 0;
    try {
        mtime = statSync(file).mtimeMs;
    }
    catch {
        // 没这个文件（没装 /face 扩展）→ 空表，彩蛋不生效
        cache.set(dataRoot, { mtime: -1, map: new Map() });
        return new Map();
    }
    const hit = cache.get(dataRoot);
    if (hit && hit.mtime === mtime)
        return hit.map;
    const map = new Map();
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
        // 文件坏了 → 当空表，不影响正文
    }
    cache.set(dataRoot, { mtime, map });
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
//# sourceMappingURL=face-placeholder.js.map