import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerPath } from './chat-ledger.js';
const managers = new Map();
/** 读某实例的群注册表 groups.json(cwd/.qqbot/groups.json); 失败返回 undefined */
function readJSONRegistry(cwd) {
    try {
        const raw = readFileSync(join(cwd || process.cwd(), '.qqbot', 'groups.json'), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
export function registerSessionManager(ns, m) {
    if (m)
        managers.set(ns, m);
    else
        managers.delete(ns);
}
/** 遍历所有实例, 按 web sessionId 精确反查会话记录(唯一可靠源: record.sessionId 含 fork 后的 randomUUID) */
export function findSessionBySessionIdWeb(sessionId) {
    const out = [];
    for (const [ns, m] of managers) {
        try {
            const r = m.findBySessionId(sessionId);
            if (r) {
                out.push({
                    ns,
                    sessionId: r.sessionId,
                    scope: r.scope,
                    peerId: r.peerId,
                    senderId: r.senderId,
                    agentPreset: r.agentPreset,
                    lastActivity: typeof r.lastActivity === 'number'
                        ? r.lastActivity
                        : 0,
                });
            }
        }
        catch { /* 单实例异常跳过 */ }
    }
    return out;
}
/** 按 ns+scope+peerId 找会话记录(线B: 用户代发后把消息 append 进该会话) */
export function findRecordByPeerWeb(ns, scope, peerId) {
    const m = managers.get(ns);
    if (!m)
        return undefined;
    try {
        const r = m.findByPeer(scope, peerId);
        if (!r)
            return undefined;
        return {
            ns,
            sessionId: r.sessionId,
            scope: r.scope,
            peerId: r.peerId,
            senderId: r.senderId,
            agent: r.agent,
        };
    }
    catch {
        return undefined;
    }
}
/**
 * 遍历**所有**实例(ns)，找出「有该 peer 活跃会话」的记录。
 *
 * 2026-10-04 新增（主人实测：dock 聊天页只显示到几天前的最旧消息）：
 *   findRecordByPeerWeb 需要调用方给对 ns；一旦 ns 指到别的实例（多 bot 场景常见），
 *   拿到的就是那个实例里的**过期会话记录** ⇒ 聊天记录停在很久以前。
 *   这里提供跨实例兜底，由调用方按 seq 取「最新的那个」。
 */
export function listPeerRecordsWeb(scope, peerId) {
    const out = [];
    for (const [ns, m] of managers) {
        try {
            const r = m.findByPeer(scope, peerId);
            if (!r)
                continue;
            const ag = r.agent;
            const sess = ag && (ag.session || (ag.ctx && ag.ctx.session));
            const seq = sess && typeof sess.seq === "number" ? sess.seq : -1;
            out.push({ ns, sessionId: r.sessionId, scope: r.scope, peerId: r.peerId, senderId: r.senderId, agent: r.agent, seq });
        }
        catch { /* ignore */ }
    }
    return out;
}
/** 活跃表 miss(会话被回收/未建立)时恢复/重建会话 —— 与入群申请通知/定时任务同款 getOrCreate(不开回合, 只保证 log 存在) */
export async function getOrCreateByPeerWeb(ns, scope, peerId, senderId = 'master') {
    const m = managers.get(ns);
    if (!m || typeof m.getOrCreate !== 'function')
        return undefined;
    try {
        const r = await m.getOrCreate(scope, peerId, senderId, { scope, targetId: peerId });
        if (!r)
            return undefined;
        return {
            ns,
            sessionId: r.sessionId,
            scope: r.scope,
            peerId: r.peerId,
            senderId: r.senderId,
            agent: r.agent,
        };
    }
    catch {
        return undefined;
    }
}
const botOnline = new Map();
/** 标记某实例在线状态(bootstrap bot ready/error/resumed 事件驱动) */
export function setBotOnline(ns, on) {
    if (on)
        botOnline.set(ns, true);
    else
        botOnline.delete(ns);
}
/** 某实例是否在线(未注册/未知 = false) */
export function isBotOnline(ns) {
    return botOnline.get(ns) === true;
}
/** 是否已注册某 ns(诊断用) */
export function hasManager(ns) {
    return managers.has(ns);
}
/** 按实例 ns 精确取 manager（2026-11-06：预热不能靠 findManagerByPeer，会串到别的实例） */
export function getManagerByNs(ns) {
    return managers.get(ns);
}
export function listManagerNs() {
    return [...managers.keys()];
}
/** 全部已注册 manager(通用插件: 跨实例枚举/寻址用, 同一 ESM 实例无 realm 隔离) */
export function managersOf() {
    return [...managers.values()];
}
/** 按 scope+peer 找目标实例的 manager(先活跃表; 再按群注册表/c2c台账归属匹配; 最后回退任意一个已注册) */
export function findManagerByPeer(scope, peerId) {
    // ① 活跃会话表精确命中
    for (const m of managers.values()) {
        try {
            if (m.findByPeer(scope, peerId))
                return m;
        }
        catch { /* 单实例异常跳过 */ }
    }
    // ② 群注册表归属匹配(会话未创建时: 该群在哪个实例的 groups.json 里就是哪个实例)
    if (scope === 'group' && peerId) {
        for (const m of managers.values()) {
            try {
                const reg = readJSONRegistry(m.cwd);
                if (reg && Object.prototype.hasOwnProperty.call(reg, peerId))
                    return m;
            }
            catch { /* 单实例异常跳过 */ }
        }
    }
    // ②' c2c 台账归属匹配(2026-09-10 主人定): openid 按 bot 应用(appId)隔离,
    //    同一 QQ 用户在不同 bot 下 openid 不同。会话未创建时, 用"谁的台账见过这个
    //    c2c openid"定归属 → 找到正确的实例才能用对的 appId 发送(否则官方报资源不存在)。
    //    台账 = {dataDir}/known-chats.jsonl(chat-ledger append), dock 私聊对象同源。
    if (scope === 'c2c' && peerId) {
        for (const m of managers.values()) {
            try {
                const raw = readFileSync(ledgerPath(m.stickerDataDir), 'utf8');
                let hit = false;
                for (const l of raw.split('\n')) {
                    const t = l.trim();
                    if (!t)
                        continue;
                    try {
                        const o = JSON.parse(t);
                        if (o?.scope === 'c2c' && o.id === peerId) {
                            hit = true;
                            break;
                        }
                    }
                    catch { /* 坏行跳过 */ }
                }
                if (hit)
                    return m;
            }
            catch { /* 无台账/读失败则跳过 */ }
        }
    }
    // ③ 回退第一个已注册
    return managers.values().next().value;
}
/** 按 sessionId 找目标实例的 manager(活跃表精确命中) */
export function findManagerBySessionId(sessionId) {
    for (const m of managers.values()) {
        try {
            if (m.findBySessionId(sessionId) || m.findHostAgent(sessionId))
                return m;
        }
        catch { /* 单实例异常跳过 */ }
    }
    return undefined;
}
//# sourceMappingURL=session-registry.js.map