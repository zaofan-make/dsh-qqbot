/**
 * warm-sessions.ts — 启动预热已知 QQ 会话（issue #39 问题 1）
 *
 * ## 为什么需要
 *
 * 1.11.13 起扩展工具改成**按 agent 作用域注册**（`applyExtToolVisibility`），
 * 触发点只有 `agent/inbox/claimed` 与 `agent/pre-step` —— 都要求**有回合**。
 *
 * 于是冷启动后：会话记录还在、但没产生过回合 ⇒ 那些工具从来没注册过 ⇒
 * 打开该会话看到的是**没有扩展工具**，必须往群里发一条消息、跑完一个回合才恢复。
 * 无人值守/纯定时任务的场景等于永久失效。
 *
 * ## 做法
 *
 * 启动完成（网关起来）后，读 `{dataRoot}/.qqbot/model-prefs.json` 的 `sessionIds`
 * （形如 `qqbot:<appId>:group:<group_openid>` → `<sessionId>`），对每个 peer：
 *
 *   1. `manager.getOrCreate(scope, peerId, …)` —— **只建 record，不开回合**
 *   2. 拿到 `record.agentCtx` 后**主动**调一次 `applyExtToolVisibility(agentCtx, tag)`
 *
 * 这样不用等任何入站消息，工具就在清单里了。
 *
 * ## 为什么要有开关 / 上限
 *
 * 每个预热都会**真的创建一个 agent 实例**（内存 + 启动耗时）。重度用户可能有几十个群，
 * 全量预热会拖慢启动，所以：
 *   · 设置项 `warmSessionsOnStart`（默认 **true**）
 *   · `warmMaxSessions`（默认 **12**）—— 超出按「最近用过的优先」截断
 *   · 失败静默（单个会话出错不影响启动，也不影响其它会话）
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** 诊断：写进 ~/.dsh/contextless-trace.log（与插件其它诊断同一个文件，便于一起看） */
function traceWarm(line) {
    try {
        const home = process.env['HOME'] || process.env['USERPROFILE'] || homedir();
        if (!home)
            return;
        const dir = join(home, '.dsh');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'contextless-trace.log'), `${new Date().toISOString()} [warm] ${line}
`, 'utf8');
    }
    catch { /* ignore */ }
}
/**
 * 从 sessionKey 里解析 scope/peerId。
 *
 * key 的形态不统一：可能是 `group:<gid>`、`c2c:<openid>`，
 * 也可能是 `qqbot:<appId>:group:<gid>`（issue #39 的实测形态）。
 * 统一按**最后一个** `group:` / `c2c:` 定位。
 */
export function parseSessionKey(key) {
    const parts = String(key || '').split('@');
    const k = String(parts[0] ?? '');
    const m = /(?:^|:)(group|c2c):(.+)$/.exec(k);
    if (!m)
        return undefined;
    const peerId = String(m[2] || '').trim();
    if (!peerId)
        return undefined;
    return { scope: m[1], peerId };
}
/** 读 model-prefs.json，列出已知的 QQ 会话（解析不出 scope 的跳过） */
export function listKnownTargets(dataRoot) {
    try {
        const raw = readFileSync(join(dataRoot, '.qqbot', 'model-prefs.json'), 'utf8');
        const prefs = JSON.parse(raw);
        const ids = prefs && prefs.sessionIds;
        if (!ids || typeof ids !== 'object')
            return [];
        const out = [];
        const seen = new Set();
        for (const [key, sid] of Object.entries(ids)) {
            if (!sid)
                continue;
            const p = parseSessionKey(key);
            if (!p)
                continue;
            const dedup = p.scope + ':' + p.peerId;
            if (seen.has(dedup))
                continue;
            seen.add(dedup);
            out.push({ scope: p.scope, peerId: p.peerId, sessionKey: String(key) });
        }
        return out;
    }
    catch {
        return [];
    }
}
/**
 * 预热：给每个已知会话建出 record 并注册扩展工具。
 *
 * @param deps.getOrCreate  `manager.getOrCreate` 的封装（只建 record，不开回合）
 * @param deps.register     `(agentCtx, tag) => void`，通常是 `applyExtToolVisibility`
 * @param deps.tag          本实例的扩展 tag（空 = 不注册，直接跳过）
 */
export async function warmSessions(opts) {
    const { dataRoot, tag, maxSessions, logger, getOrCreate, register } = opts;
    const result = { total: 0, warmed: 0, failed: 0 };
    if (!tag) {
        traceWarm(`跳过：tag 为空 dataRoot=${dataRoot}`);
        return result;
    }
    const all = listKnownTargets(dataRoot);
    result.total = all.length;
    traceWarm(`开始 dataRoot=${dataRoot} tag=${tag} 已知=${all.length} 上限=${maxSessions}`);
    if (all.length === 0)
        return result;
    const limit = Math.max(0, Math.floor(maxSessions));
    const targets = limit > 0 ? all.slice(0, limit) : all;
    for (const t of targets) {
        try {
            const rec = await getOrCreate(t.scope, t.peerId);
            if (!rec) {
                result.failed += 1;
                traceWarm(`✗ ${t.scope}:${t.peerId.slice(0, 8)} getOrCreate 返回空`);
                continue;
            }
            if (!rec.agentCtx) {
                result.failed += 1;
                traceWarm(`✗ ${t.scope}:${t.peerId.slice(0, 8)} 无 agentCtx（setup 未完成）`);
                continue;
            }
            register(rec.agentCtx, tag);
            result.warmed += 1;
            traceWarm(`✓ ${t.scope}:${t.peerId.slice(0, 8)} 已注册`);
        }
        catch (err) {
            result.failed += 1;
            traceWarm(`✗ ${t.scope}:${t.peerId.slice(0, 8)} 异常 ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    traceWarm(`结束 ${result.warmed}/${targets.length} 成功（共 ${result.total} 已知，失败 ${result.failed}）`);
    logger?.info?.(`[warm] 启动预热：${result.warmed}/${targets.length} 个会话已就绪（共 ${result.total} 个已知会话，失败 ${result.failed}）`);
    return result;
}
//# sourceMappingURL=warm-sessions.js.map