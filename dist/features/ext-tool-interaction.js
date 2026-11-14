import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadExtensionTools, loadExtensionCommands } from './extension-store.js';
import { lookupExtToolCard, parseExtToolButtonData } from './ext-tool-cards.js';
/**
 * ★ 派发链诊断（2026-10-13 主人要求）：把派发每一步写死到一个文件里。
 * 目的：主人点按钮后就能直接看出 —— 事件到没到、注册表命中没、找到工具/命令没、钩子调没调。
 * 只记录、绝不影响派发结果（任何异常都吞掉）。
 */
/**
 * 派发诊断日志落点（2026-10-24 修：原来硬编码 D:/newwenjianjia/... —— Linux/Android 上会
 * 在家目录里造一个名为 "D:" 的目录，issue #17 就是别人踩到这个来的）。
 * 优先用环境变量覆盖，否则落到 ~/.dsh 下。
 */
const DISPATCH_DIAG = process.env.QQBOT_DISPATCH_DIAG
    || join(homedir(), '.dsh', 'qqbot-dispatch-diag.log');
function dlog(msg) {
    try {
        mkdirSync(dirname(DISPATCH_DIAG), { recursive: true });
        appendFileSync(DISPATCH_DIAG, `${new Date().toISOString()} ${msg}\n`);
    }
    catch { /* ignore */ }
}
/**
 * 「这张卡的这个按钮，有哪些人点过」—— 内存态，仅用于给模块一个 `clickedBefore` 提示。
 * ⚠️ 重启即丢；**权威判重请模块自己用 `ctx.store` 落盘**（别把这个当账本）。
 */
const clickedMemory = new Map();
function noteClicked(cardId, buttonId, openid) {
    const key = `${cardId}:${buttonId}`;
    let set = clickedMemory.get(key);
    const before = !!set && set.has(openid);
    if (!set) {
        set = new Set();
        clickedMemory.set(key, set);
    }
    set.add(openid);
    // 防御：单按钮最多记 5000 人（正常远达不到）
    if (set.size > 5000)
        clickedMemory.delete(key);
    return before;
}
export function createExtToolInteractionController(deps) {
    const { dataRoot, logger, makeCtx, sendReceipt } = deps;
    return {
        async handleInteraction(event, replyTarget) {
            const e = event;
            // ① 只看按钮回调
            if (e?.data?.type !== 11)
                return false;
            const parsed = parseExtToolButtonData(e.data?.resolved?.button_data);
            if (!parsed)
                return false; // 不是我们的前缀：零打扰
            const { toolName, cardId, buttonId } = parsed;
            // ② 查注册表（谁发的、按钮属于谁、过期没）
            const hit = lookupExtToolCard(dataRoot, { toolName, cardId, buttonId });
            if (!hit) {
                // 未登记/已过期/按钮不属于该卡 → 不消费（交回原有兜底；最后仍只 ack）
                dlog(`[miss] 注册表未命中 tool=${toolName} card=${cardId} btn=${buttonId}`);
                logger.debug?.(`[ext-tool-btn] 未命中注册表 tool=${toolName} card=${cardId} btn=${buttonId}`);
                return false;
            }
            dlog(`[hit] 注册表命中 tool=${toolName} card=${cardId} btn=${buttonId}`);
            // ③ 找模块 + 它的 onInteraction
            //    ★ 2026-10-13：工具里没有这个钩子 → 再找**同名的「扩展命令」**（命令现在也能收按钮回调）。
            //    于是「一条斜杠命令独立完成 启动→翻页→收尾」不必再额外搭一个 tools/ 模块。
            let mod;
            let handler;
            try {
                const defs = await loadExtensionTools(dataRoot, logger);
                mod = defs.find((d) => d.name === toolName);
                handler = mod?.onInteraction;
                dlog(`[tool] 工具数=${defs.length} 找到=${!!mod} 有钩子=${typeof mod?.onInteraction === 'function'}`);
                if (typeof handler !== 'function') {
                    const cmds = await loadExtensionCommands(dataRoot, logger);
                    const hitCmd = cmds.find((x) => (Array.isArray(x.name) ? x.name : [x.name]).map(String).includes(toolName));
                    handler = hitCmd?.onInteraction;
                    dlog(`[cmd] 命令数=${cmds.length} 命中=${!!hitCmd} 有钩子=${typeof handler === 'function'} 名字=${cmds.map((c) => (Array.isArray(c.name) ? c.name.join('/') : String(c.name))).join(',')}`);
                }
            }
            catch (err) {
                dlog(`[error] 加载扩展工具/命令失败: ${err instanceof Error ? err.stack : String(err)}`);
                logger.warn(`[ext-tool-btn] 加载扩展工具/命令失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (typeof handler !== 'function') {
                dlog(`[nohandler] 「${toolName}」没有可用钩子 → 不消费`);
                logger.warn(`[ext-tool-btn] 「${toolName}」既不是导出 onInteraction 的工具、也不是这种扩展命令 → 不消费`);
                return false;
            }
            dlog(`[call] 即将调用 onInteraction tool=${toolName} btn=${buttonId}`);
            // ④ 点击者身份：群聊看 group_member_openid，单聊看 user_openid
            const openid = String(e.group_member_openid ?? e.user_openid ?? '');
            const scope = e.group_member_openid ? 'group' : 'c2c';
            // ★★ 2026-11-14 修（审查发现）：**优先用"点击发生的那个群"**，而不是卡片注册时的 targetId。
            //   卡片可能被转发到别的群：原来 hit.targetId 优先 ⇒ 在转发后的群里点，
            //   动作结果却写回**原群**（人在这儿等，回执跑去那儿）。
            const peerId = scope === 'group' ? String(e.group_openid || hit.targetId || '') : openid;
            const clickedBefore = noteClicked(cardId, buttonId, openid);
            // ⑤ 组 ctx 并调用（抛错=未消费，但给点击者一句回执，别让人干等）
            let ctx;
            try {
                ctx = makeCtx({
                    toolName,
                    replyTarget,
                    actor: { openid, name: '', isOwner: false }, // name/isOwner 由 makeCtx 内部按 owners 补齐
                    scope,
                    peerId,
                    clickedBefore,
                });
            }
            catch (err) {
                logger.warn(`[ext-tool-btn] 组 ctx 失败: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
            const info = {
                cardId,
                buttonId,
                buttonLabel: String(e.data?.resolved?.button_label ?? ''),
                clickedBefore,
                event,
            };
            try {
                const call = handler;
                const out = await call(ctx, info);
                const text = typeof out === 'string' ? out.trim() : '';
                if (text)
                    await sendReceipt(replyTarget, text);
                logger.info(`[ext-tool-btn] 已派发 tool=${toolName} card=${cardId} btn=${buttonId} openid=${openid.slice(0, 8)}…`);
                return true;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[ext-tool-btn] onInteraction 异常 tool=${toolName}: ${msg}`);
                // 钩子挂了：给点击者一句实话（这条不算消费成功，但既然点了我们的卡，就该有反馈）
                try {
                    await sendReceipt(replyTarget, `⚠️ 处理失败：${msg.slice(0, 120)}`);
                }
                catch { /* ignore */ }
                return false;
            }
        },
    };
}
//# sourceMappingURL=ext-tool-interaction.js.map