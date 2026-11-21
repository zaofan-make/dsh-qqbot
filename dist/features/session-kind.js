/**
 * session-kind.ts —— 「当前是什么渠道 + 对方/群叫什么」（issue #79，2026-11-21）
 *
 * 问题：私聊消息注入格式（`[昵称 #ref]: "正文"`）与群聊几乎同构，插件全程没有
 * 任何"这是私聊/群聊"的显式标注 ⇒ 模型只能靠猜，实测把私聊判成群聊（按群规矩回复）。
 *
 * 名字来源（主人 2026-11-21 定：**直接走官方 API，不读台账**）：
 *   · 群聊：`GET /v2/groups/{group_openid}/info` → `group_name`
 *     （`api/group-admin.ts` 已有 `getGroupInfo`；30 QPM、需白名单权限，11253 = 无权限）
 *   · 私聊：`GET /v2/users/{user_openid}/info` → `username`
 *     （2026-11-17 官方新增的 `getUserInfo`，唯一一条还开着的"拿名字"的路）
 * 两者都**缓存 + 后台预取**：注入是同步回调，绝不能在回合里等网络；
 * 拿不到就只写"群聊/私聊"，不编名字。
 *
 * 注入方式：由 `session-manager` 以**独立 user/message 事件**注入
 * （`source.kind = 'qqbot:session-kind'`；带 `qqbot:` 前缀是维护手册 §11.21 的硬要求，
 * 否则 dock 聊天视图会把注入内容当成对方说的话）。不拼进真实用户消息的 content。
 */
/** 群名缓存：gid → name */
const groupNameCache = new Map();
/** 使用者昵称缓存：openid → name（来自入站 senderName 或 getUserInfo） */
const userNameCache = new Map();
/** 在途请求（避免同一目标并发打点） */
const inflight = new Set();
/** 成功缓存 30 分钟（群名/用户名很少变）；失败只缓存 60 秒，别把一次失败钉死 */
const TTL_OK_MS = 30 * 60 * 1000;
const TTL_FAIL_MS = 60 * 1000;
function fresh(hit) {
    if (!hit)
        return undefined;
    return Date.now() - hit.at > (hit.name ? TTL_OK_MS : TTL_FAIL_MS) ? undefined : hit;
}
/** 同步读群名缓存（注入时用）：未命中返回空串 */
export function cachedGroupName(gid) {
    return fresh(groupNameCache.get(String(gid || '')))?.name || '';
}
/** 同步读使用者昵称缓存（注入时用） */
export function cachedUserName(openid) {
    return fresh(userNameCache.get(String(openid || '')))?.name || '';
}
/** 记下入站消息自带的昵称（私聊 `senderName`、群名片），比 API 快且免费 */
export function rememberUserName(openid, name) {
    const id = String(openid || '').trim();
    const nm = String(name || '').trim();
    if (!id || !nm)
        return;
    const old = fresh(userNameCache.get(id));
    // 已有更好/同等的值就不覆盖；只有空或过期才更新
    if (old && old.name)
        return;
    userNameCache.set(id, { name: nm, at: Date.now() });
}
/** 手动写入群名（别处已经拿到时用，例如群名接口的调用方） */
export function rememberGroupName(gid, name) {
    const id = String(gid || '').trim();
    if (!id)
        return;
    groupNameCache.set(id, { name: String(name || '').trim(), at: Date.now() });
}
/**
 * 后台拉群名并缓存（**不阻塞**当前回合）。没有缓存时，这一轮注入只能写"群名未取到"，
 * 下一轮就有了。失败也写空串（短 TTL），免得对着没权限的群每轮打接口。
 */
export function prefetchGroupName(client, gid) {
    const id = String(gid || '').trim();
    if (!id || cachedGroupName(id) || inflight.has('g:' + id))
        return;
    if (!client || typeof client.getGroupInfo !== 'function')
        return;
    inflight.add('g:' + id);
    void (async () => {
        let name = '';
        try {
            const r = await client.getGroupInfo(id);
            if (r && r.ok !== false)
                name = String(r.data?.group_name ?? '').trim();
        }
        catch {
            name = '';
        }
        finally {
            groupNameCache.set(id, { name, at: Date.now() });
            inflight.delete('g:' + id);
        }
    })();
}
/** 后台拉用户名并缓存；已有入站昵称时直接跳过（省一次接口调用） */
export function prefetchUserName(client, openid) {
    const id = String(openid || '').trim();
    if (!id || cachedUserName(id) || inflight.has('u:' + id))
        return;
    if (!client || typeof client.getUserInfo !== 'function')
        return;
    inflight.add('u:' + id);
    void (async () => {
        let name = '';
        try {
            const r = await client.getUserInfo(id);
            if (r && r.ok !== false)
                name = String(r.data?.username ?? '').trim();
        }
        catch {
            name = '';
        }
        finally {
            userNameCache.set(id, { name, at: Date.now() });
            inflight.delete('u:' + id);
        }
    })();
}
/**
 * 描述当前会话的渠道与名字（**同步**：只用缓存，绝不在回合里等网络）。
 *
 * @param scope    `group` / `c2c`
 * @param peerId   群 openid / 用户 openid
 * @param peerName 入站消息自带的昵称（私聊 senderName / 群名片），优先级高于缓存
 */
export function describeSessionKind(scope, peerId, peerName) {
    const kind = String(scope) === 'c2c' ? 'c2c' : 'group';
    const pid = String(peerId || '');
    if (kind === 'group')
        return { kind, name: cachedGroupName(pid), peerId: pid };
    const inline = String(peerName || '').trim();
    return { kind, name: inline || cachedUserName(pid), peerId: pid };
}
/** 注入正文里 openid 只给尾号：够核对，省 token */
function tail(id) {
    const s = String(id || '');
    return s.length > 8 ? s.slice(-8) : s;
}
/**
 * 拼注入正文（调用方包进 `<system-reminder>`，放进**独立**的 user/message 事件）。
 *
 * 只陈述事实 + 一句用途提醒，不写"请按群规矩回复"这种指令 ——
 * 宿主实测：框架文本容易被模型当成模板复述出来。
 */
export function buildSessionKindHint(info) {
    const NL = String.fromCharCode(10);
    if (info.kind === 'group') {
        const namePart = info.name ? `群名「${info.name}」` : '群名未取到';
        return `[当前会话] 渠道=QQ 群聊 · ${namePart} · 群 openid 尾号 ${tail(info.peerId)}`
            + NL
            + '这是群聊：发言会被群里所有人看到，别按私聊口吻假设。';
    }
    const namePart = info.name ? `对方「${info.name}」` : '对方昵称未取到';
    return `[当前会话] 渠道=QQ 私聊 · ${namePart} · 用户 openid 尾号 ${tail(info.peerId)}`
        + NL
        + '这是私聊：只有对方看得到，不等于群里有人围观。';
}
//# sourceMappingURL=session-kind.js.map