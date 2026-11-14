/**
 * ext-tool-cards.ts — 扩展工具「按钮卡片」注册表（2026-10-08 新增）
 *
 * 为什么需要它
 *   扩展工具（`{dataRoot}/.qqbot-extensions/tools/*.mjs`）以前只能发 `type=0` 跳转按钮或
 *   `type=2` 指令按钮 —— 想"点一下就计一票"没有通道。回调按钮（`type=1`）点击后事件确实会进插件
 *   （`INTERACTION_CREATE`），但插件手里只有 `button_data` 里那串
 *   `ext:<toolName>:<cardId>:<buttonId>`，**必须查表**才能确认：
 *   ①这张卡确实是某个扩展工具发的 ②这个按钮确实属于它 ③还没过期。
 *   本模块就是那张表：`{dataRoot}/.qqbot/ext-tool-cards.json`。
 *
 * 形状
 *   ```json
 *   { "version": 1,
 *     "cards": [ { "toolName": "vote", "cardId": "v123", "buttonIds": ["b1","b2"],
 *                  "scope": "group", "targetId": "<group_openid>",
 *                  "createdAt": 1789000000000, "expireAt": 1789604800000 } ] }
 *   ```
 *
 * 纪律（照维护手册铁律）
 *   · **写失败绝不影响发卡** —— 注册是"尽力而为"的旁路，调用方全程 fail-soft；
 *   · 过期条目在**每次写入时**顺手清一次（不另开定时器，免得留生命周期尾巴）；
 *   · 原子替换（tmp → rename）：避免半截 JSON 被另一个实例读到；
 *   · 本层只做"登记 / 查询"，**不做权限判断**（谁能点、点了算不算，是模块自己的事）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** 按钮 data 前缀（与 `bp:` / `bpk:` / `bpc:` 并列，互不冲突） */
export const EXT_TOOL_CARD_PREFIX = 'ext:';
/** 注册表文件（相对数据根） */
export const EXT_TOOL_CARD_FILE = join('.qqbot', 'ext-tool-cards.json');
/** 默认有效期 7 天（工具的卡片通常就是"这一次投票/签到"用） */
export const EXT_TOOL_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 标识符里不允许出现分隔符/空白 —— 前缀解析靠它保证可逆 */
const SAFE_ID = /^[A-Za-z0-9._@-]{1,64}$/;
function cardFilePath(dataRoot) {
    return join(dataRoot, EXT_TOOL_CARD_FILE);
}
function readTable(dataRoot) {
    try {
        const j = JSON.parse(readFileSync(cardFilePath(dataRoot), 'utf8'));
        return Array.isArray(j?.cards) ? j.cards.filter((c) => !!c && typeof c === 'object') : [];
    }
    catch {
        return [];
    }
}
function writeTable(dataRoot, cards) {
    try {
        const file = cardFilePath(dataRoot);
        mkdirSync(dirname(file), { recursive: true });
        // ★★ 2026-11-14 修（审查发现）：固定 .tmp 名 —— 两次发卡/按钮回调并发写时，
        //   A 的 tmp 会被 B 覆盖，A 的 rename 可能拿到半个文件或 ENOENT（被 catch 吞成 false，
        //   表现是「这张卡点了没反应」）。改成带 pid + 随机后缀的唯一 tmp 名。
        const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
        // ★★ 2026-11-14（CodeRabbit）：**write 和 rename 要在同一个清理保护内** ——
        //   writeFileSync 因磁盘满/配额失败时可能留下空文件或半截内容，而它原来在 try 之外，
        //   异常直接进外层 catch，rmSync 不会执行；加上每次都是新文件名，重复失败会累积残留。
        try {
            writeFileSync(tmp, JSON.stringify({ version: 1, cards }, null, 2), 'utf8');
            renameSync(tmp, file);
        }
        catch (e) {
            try {
                rmSync(tmp, { force: true });
            }
            catch { /* ignore */ }
            throw e;
        }
        return true;
    }
    catch {
        // 写失败不算错：发卡照发，只是这张卡的按钮点了没人认（落到原兜底，最终只 ack）
        return false;
    }
}
/** 清掉过期/残缺记录 */
function purgeExpired(cards, now = Date.now()) {
    return cards.filter((c) => {
        const exp = Number(c?.expireAt);
        return Number.isFinite(exp) && exp > now && typeof c.toolName === 'string' && c.toolName !== '';
    });
}
/**
 * 登记一张"带回调按钮"的卡片（由 `caps.registerInteractionCard` 调用）。
 * @returns true=已落盘；false=参数不合法/写失败（**调用方忽略即可**，发卡不受影响）
 */
export function registerExtToolCard(dataRoot, input) {
    try {
        const toolName = String(input?.toolName ?? '').trim();
        const cardId = String(input?.cardId ?? '').trim();
        const buttonIds = (Array.isArray(input?.buttonIds) ? input.buttonIds : []).map((x) => String(x ?? '').trim()).filter(Boolean);
        if (!dataRoot || !SAFE_ID.test(toolName) || !SAFE_ID.test(cardId) || buttonIds.length === 0)
            return false;
        if (buttonIds.some((b) => !SAFE_ID.test(b)))
            return false;
        const now = Date.now();
        const ttl = Number(input?.ttlMs) > 0 ? Number(input.ttlMs) : EXT_TOOL_CARD_TTL_MS;
        const cards = purgeExpired(readTable(dataRoot), now).filter((c) => !(c.toolName === toolName && c.cardId === cardId));
        cards.push({
            toolName,
            cardId,
            buttonIds,
            scope: String(input?.scope ?? ''),
            targetId: String(input?.targetId ?? ''),
            createdAt: now,
            expireAt: now + ttl,
        });
        // 防御：表别无限涨（正常也就几十张）
        const trimmed = cards.length > 500 ? cards.slice(cards.length - 500) : cards;
        return writeTable(dataRoot, trimmed);
    }
    catch {
        return false;
    }
}
/**
 * 查"这个按钮属于哪张卡"（分发控制器用）。
 * @returns 命中记录（含 buttonId）；未命中 / 已过期 / 按钮不属于该卡 → null
 */
export function lookupExtToolCard(dataRoot, input) {
    try {
        const toolName = String(input?.toolName ?? '').trim();
        const cardId = String(input?.cardId ?? '').trim();
        const buttonId = String(input?.buttonId ?? '').trim();
        if (!toolName || !cardId || !buttonId)
            return null;
        const now = Date.now();
        for (const c of readTable(dataRoot)) {
            if (c.toolName !== toolName || c.cardId !== cardId)
                continue;
            const exp = Number(c.expireAt);
            if (!Number.isFinite(exp) || exp <= now)
                return null;
            if (!Array.isArray(c.buttonIds) || !c.buttonIds.includes(buttonId))
                return null;
            return { ...c, buttonId };
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * 解析按钮 data：`ext:<toolName>:<cardId>:<buttonId>`。
 * ⚠️ 只看前缀 —— 不是 `ext:` 立刻返回 null（分发链据此"零打扰"地放过）。
 */
export function parseExtToolButtonData(data) {
    const s = String(data ?? '');
    if (!s.startsWith(EXT_TOOL_CARD_PREFIX))
        return null;
    const parts = s.slice(EXT_TOOL_CARD_PREFIX.length).split(':');
    if (parts.length !== 3)
        return null;
    const toolName = String(parts[0] ?? '').trim();
    const cardId = String(parts[1] ?? '').trim();
    const buttonId = String(parts[2] ?? '').trim();
    if (!toolName || !cardId || !buttonId)
        return null;
    return { toolName, cardId, buttonId };
}
/** 拼按钮 data（供示例/文档复用；工具自己拼也行，格式必须一致） */
export function extToolButtonData(toolName, cardId, buttonId) {
    return `${EXT_TOOL_CARD_PREFIX}${toolName}:${cardId}:${buttonId}`;
}
//# sourceMappingURL=ext-tool-cards.js.map