/**
 * channel-tools.ts — QQ 通道工具插件(send_media / recall_message)
 *
 * 标准 dsh-tool 插件：由 dsh-qqbot 在 QQ 会话的 setup 事务内(agentCtx)装载，
 * 因此只对 QQ 会话可见；任意 preset 走 QQ 都会带上；web 会话不经过 setup → 没有。
 *
 * 铁律：@deepseek-ai/dsh-tools 只经 peerDependencies 由宿主解析，本文件不得被
 * 复制进共享 node_modules，也不得在 dependencies 里自带 dsh-tools(避免双包)。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { uploadMarkdownImage, listMarkdownImages, deleteMarkdownImage } from './features/md-media.js';
import { setMaterialTargetFactory } from './features/md-media-rewrite.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dataRootOf } from './gateway/data-root.js';
import { homedir } from 'node:os';
import { getStickerStore } from './features/sticker-store.js';
import { autoTagImage } from './features/sticker-tagger.js';
import { isStickerGateDenied } from './features/sticker-gate.js';
import { getScheduleStore } from './features/schedule-store.js';
import { switchOutboundMode } from './features/outbound-mode-switch.js';
import { loadExtensionTools } from './features/extension-store.js';
import { diagWrite } from './shared/diag.js';
import { makeExtCaps } from './features/ext-capabilities.js';
import { verifyHuman, groupRegistryPath } from './api/group-admin.js';
import { readGroupMembers } from './features/chat-ledger.js';
import { readMsgHistory, latestMsgHistory, historyDebug, latestGroupId } from './features/msg-history.js';
import * as broadcastQueue from './features/broadcast.js';
import { wakeSessionAgent, safeAppendUserMessage } from './features/group-hub.js';
import { managersOf, findManagerByPeer, findManagerBySessionId } from './features/session-registry.js';
// botplay 自定义事件(2026-10-05): 面板出口转发(status/reload) —— host 半边只能经本文件拿到 controller
import { botplayExtStatus as botplayExtStatusOf, reloadBotplayExt as reloadBotplayExtOf } from './features/botplay.js';
import { handleInbound } from './transport/inbound.js';
import { getQuote } from './features/quote-cache.js';
import { appendMemoLine, deleteMemo, listMemos, readMemo } from './features/people-memo.js';
import { loadQunCookie, saveQunCookie, qunLoginStart, qunLoginPoll, qunLoginPending, qunGroups, qunResolveGc, qunMembers, qunKick, } from './features/qun-admin.js';
import { qunBrowserLoginStart, qunBrowserLoginWait, qunLoginSessionAlive, } from './features/qun-login.js';
import { appendMemo as appendContextMemo, clearMemo as clearContextMemo, deleteMemo as deleteContextMemo, editMemo as editContextMemo, listMemo as listContextMemo, } from './features/context-memo.js';
/** 诊断日志路径: 默认关闭; 需要排查时设环境变量 QQBOT_DIAG_FILE 指向日志文件 */
const DIAG_FILE = process.env.QQBOT_DIAG_FILE || '';
/** 大文件异步发送阈值: 本地文件 >= 5MB 时走后台任务(SDK 分片上传耗时, 避免阻塞 LLM 回合) */
const FILE_ASYNC_MIN = 5 * 1024 * 1024;
/** 等回合空闲的最长时间(ms); 与 QQ 入站 debounce 排队/group-hub safeAppend 同款语义 */
const TURN_WAIT_MS = 60_000;
let bgSeq = 0;
function fmtMB(n) { return (n / 1048576).toFixed(1) + 'MB'; }
/** 从 exec 取 logger(ctx.logger), 拿不到用 console 兜底(类型兼容 Logger) */
function loggerLike(exec) {
    try {
        const a = exec.agent;
        if (a?.ctx?.logger)
            return a.ctx.logger;
    }
    catch { /* 忽略 */ }
    const c = console;
    return {
        info: (m, ...args) => c.info(m, ...args),
        warn: (m, ...args) => c.warn(m, ...args),
        error: (m, ...args) => c.error(m, ...args),
        debug: (m, ...args) => c.debug(m, ...args),
    };
}
/**
 * 把后台任务结果作为 user/message 写回会话(不唤醒, 与入群申请通知同款; 失败静默)。
 * 🔒 回合安全(主人硬约束 2026-09-09): LLM 回合进行中严禁 session.append(拆散 tool_calls 坏记录),
 *    先 agent.whenIdle() 等回合结束再写(与 QQ 入站 debounce 排队同款); 无 whenIdle/超时放弃。
 */
async function notifySession(agent, text) {
    try {
        const a = agent;
        const session = a?.session;
        if (!session || typeof session.append !== 'function')
            return;
        if (typeof a.whenIdle === 'function') {
            try {
                await Promise.race([a.whenIdle(), new Promise((r) => setTimeout(r, TURN_WAIT_MS))]);
            }
            catch { /* whenIdle 超时/异常 → 放弃写回(不坏记录) */ }
        }
        session.append('user/message', {
            id: 'bg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text: text }],
            source: { kind: 'user' },
        }, { surfaceOp: 'append' });
    }
    catch { /* 通知失败不影响发送结果 */ }
}
function diag(line) {
    if (!DIAG_FILE)
        return;
    try {
        appendFileSync(DIAG_FILE, `${new Date().toISOString()} ${line}\n`);
    }
    catch { /* ignore */ }
}
/**
 * 扩展工具注册诊断（排查"扩展没进工具列表"用）。
 *
 * ⚠️ 2026-10-04 修补：原来是**无脑 append、无上限无轮转** —— 实测在用户 C 盘长到了 **28.4 MB** ✗
 *   现在超过 2 MB 就先截断、只留尾部 512 KB 再追加：诊断还在，垃圾没了。
 */
function extDiag(line) {
    // ★ 2026-10-06 收口：改走统一诊断底座（默认关 / 2MB 上限 / 自动轮转）。
    diagWrite('qqbot-ext-diag', line);
}
export const name = 'qqbot-channel-tools';
// ⚠️ 2026-10-02 事故：曾在此加 "systemPrompt" —— 但**宿主未提供该服务**，cordis 会一直等它，
//   插件报 "never started" ⇒ 所有钩子永不注册 ⇒ 群守则/小传/智能提示/工具刷新全部失效。
//   那条 systemPrompt 通道已废弃（提示现并入群守则 body 走 pre-step），故只声明 tools。
export const inject = ['tools'];
/**
 * 运行时按当前执行 agent 解析 qqChannel service。
 * 解析顺序: ①exec.agent.ctx.get('qqChannel')(agent ctx, setup 时 provide);
 * ②全局桥 channelBridge(bootstrap 直接注入 manager+sender)——不依赖 setup/provide,
 *   防止 setup 未执行/竞态导致"不是 QQ 会话"误判(线上踩坑: 重启后 setup 未跑到)。
 */
let channelBridges = [];
/** 全局懒扫节流（2026-10-10）：ensureExtToolsGlobal 挂在"每 step 都触发"的钩子上，别每次都扫盘 */
let lastExtGlobAt = 0;
/**
 * expose:'all' 全局注册的**专用诊断**（2026-10-10 排查用）。
 * ⚠️ 无条件写：不走 diagWrite/diagLog 那套（那套默认关，害我以为"没跑"，其实是"没记"）。
 * 行程：~/.dsh/qqbot-extglob.log —— 定位完可整段删。
 */
function extGlobDiag(line) {
    // ★ 2026-10-10 主人提醒（人家的疏忽）：**不该再有"无条件写自有文件"的日志** ——
    //   别的用户不需要它，而且没有轮转会一直吃盘（1.7.3 就为这个还过债）。
    //   现在改走统一诊断底座：受设置页 ⑤「诊断日志落盘」开关控制（**默认关**）、2MB 自动轮转、只留 1 份旧档。
    //   ⇒ 需要排查时把那个开关打开即可，平时一个字节都不写。
    diagWrite('qqbot-extglob', line);
}
/** 工作区标识兜底：cwd 末级目录名（清洗后）。仅在实例没配 preset 时使用 */
function workspaceTagOf(cwd) {
    const base = String(cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const asciiOnly = base.replace(/[^A-Za-z0-9_-]+/g, '');
    if (asciiOnly.length >= 2)
        return asciiOnly.toLowerCase().slice(0, 24);
    let hsh = 0;
    const srcT = String(cwd ?? base);
    for (let i = 0; i < srcT.length; i++)
        hsh = (hsh * 31 + srcT.charCodeAt(i)) | 0;
    return 'ws' + Math.abs(hsh).toString(36).slice(0, 6);
}
/** 某实例的标识：优先**人设 id**（config.preset），没配才回落工作区目录名 */
export function instanceTagOfManager(m) {
    const cfg = m?.config;
    const p = String(cfg?.preset ?? '').trim();
    return p || workspaceTagOf(m?.cwd);
}
/** 按标识找人设实例的通道桥（先查全局桥，再退会话注册表） */
function findChannelByTag(tag) {
    if (!tag)
        return undefined;
    for (const b of channelBridges) {
        if (b?.manager && instanceTagOfManager(b.manager) === tag)
            return { manager: b.manager, sender: b.sender };
    }
    try {
        for (const m of managersOf()) {
            if (instanceTagOfManager(m) === tag) {
                const b = channelBridges.find((x) => x.manager === m);
                return { manager: m, sender: b?.sender };
            }
        }
    }
    catch { /* ignore */ }
    return undefined;
}
/**
 * 构造"人设 / 工作区的 QQ 账号包"（expose:'all' 专用；非 QQ 会话的唯一入口）。
 * @param tag       人设 id（如 whale）
 * @param dataRoot  插件数据根（群台账在这里）
 */
// 2026-10-21: 出站自动传图需要 groupAdmin 句柄；取**任一**桥（不依赖当前会话）
setMaterialTargetFactory(() => {
    try {
        // 2026-10-21 修：channelBridges 实测是空的（同文件 204 行注释也写了），要用 managersOf()
        for (const m of managersOf()) {
            const cc = m.groupAdmin;
            if (cc)
                return { apiCall: cc.apiCall.bind(cc) };
        }
    }
    catch { /* ignore */ }
    return undefined;
});
function buildWorkspaceQqPack(tag, dataRoot) {
    const hit = findChannelByTag(tag);
    if (!hit)
        return undefined;
    const mgr = hit.manager;
    // ⚠️ 2026-10-10：**别从桥里拿 sender** —— channelBridges 未必被填充（实测是空的），
    //   真正的 sender 在 manager 上：installChannelSender() → this.channelSender。
    const mgrSender = mgr?.channelSender;
    extGlobDiag('pack tag=' + tag + ' bridgeSender=' + (hit.sender ? 'Y' : 'N') + ' mgrSender=' + (mgrSender ? 'Y' : 'N'));
    const sender = (hit.sender ?? mgrSender);
    const root = String(mgr?.dataRoot ?? dataRoot ?? '');
    const toTarget = (scope, id) => ({
        scope: scope === 'c2c' ? 'c2c' : 'group', targetId: id,
    });
    // 已知聊天目标 = 群注册表(groups.json) ＋ 各实例活跃会话；同一目标按"最新者胜"
    const known = new Map();
    const add = (scope, id, name, lastAt = 0) => {
        if (!id)
            return;
        const key = scope + ':' + id;
        const cur = known.get(key);
        if (!cur) {
            known.set(key, { scope, id, name, lastAt });
            return;
        }
        if (lastAt > cur.lastAt) {
            cur.lastAt = lastAt;
            if (name)
                cur.name = name;
            return;
        }
        if (!cur.name && name)
            cur.name = name;
    };
    try {
        const reg = JSON.parse(readFileSync(groupRegistryPath(root), 'utf8'));
        for (const [gid, v] of Object.entries(reg ?? {}))
            add('group', gid, String(v?.name ?? ''), Number(v?.lastAt ?? 0));
    }
    catch { /* 没有注册表就跳过 */ }
    try {
        for (const m of managersOf()) {
            try {
                for (const s of (m.listSessions?.() ?? [])) {
                    // ⚠️ listSessions() 只给 scope/peerId（没有 name）→ 群名靠 groups.json 注册表补
                    add(s.scope === 'c2c' ? 'c2c' : 'group', String(s.peerId ?? ''), '');
                }
            }
            catch { /* 单个实例失败无妨 */ }
        }
    }
    catch { /* ignore */ }
    const all = [...known.values()].sort((a, b) => b.lastAt - a.lastAt);
    return {
        preset: String(mgr?.config?.preset ?? tag),
        tag,
        cwd: String(mgr?.cwd ?? ''),
        dataRoot: root,
        appId: mgr?.config?.appId,
        appSecret: mgr?.config?.appSecret,
        owners: mgr?.config?.owners ?? [],
        groups: all.filter((x) => x.scope === 'group').slice(0, 200).map((x) => ({ gid: x.id, name: x.name, lastAt: x.lastAt })),
        c2c: all.filter((x) => x.scope === 'c2c').slice(0, 200).map((x) => ({ openid: x.id, name: x.name, lastAt: x.lastAt })),
        sender,
        /**
         * 发文本到指定目标：sendText('group', openid, '文本') / sendText('c2c', openid, '文本')
         * ★ 2026-10-10 主人定：先走被动通道（带会话的最近 msgId），失败自动转主动。
         *   ① 查目标会话最近一条入站消息的 msgId
         *      （manager.getSessionRecord(scope, peerId).replyTarget.msgId，每次入站都会刷新）
         *      ⇒ 带上它发 = 被动回复（不消耗主动消息配额、QQ 也不吞）；
         *   ② 没有窗口 / msg_id 已过期 / 被动配额用尽 ⇒ 去掉 msgId 重发 = 主动（QQ 允许的兜底）。
         *   返回据实；两条路径都有诊断留痕（~/.dsh/qqbot-extglob.log）。
         */
        sendText: async (scope, id, text) => {
            if (!id)
                return false;
            const snd = sender;
            if (!snd)
                return false;
            const target = toTarget(scope, id);
            let passiveMsgId = '';
            try {
                const rec = mgr?.getSessionRecord?.(target.scope, id);
                passiveMsgId = String(rec?.replyTarget?.msgId ?? '');
                // 诊断（2026-10-10）：被动窗口到底有没有 —— 排查"为何走了主动通道"用
                try {
                    extGlobDiag('send window=' + (passiveMsgId ? ('Y/' + passiveMsgId.slice(0, 10)) : 'N') + ' rec=' + (rec ? 'Y' : 'N') + ' key=' + String(rec && rec.sessionKey || '') + ' -> ' + target.scope + ':' + id.slice(0, 12));
                }
                catch { /* ignore */ }
            }
            catch { /* ignore */ }
            if (passiveMsgId && typeof snd.sendMarkdown === 'function') {
                try {
                    await snd.sendMarkdown({ ...target, msgId: passiveMsgId }, String(text));
                    extGlobDiag('send PASSIVE ok -> ' + target.scope + ':' + id);
                    return true;
                }
                catch (e) {
                    extGlobDiag('send PASSIVE fail, 转主动 -> ' + target.scope + ':' + id + ' :: ' + ((e instanceof Error ? e.message : String(e)) || '').slice(0, 140));
                }
            }
            try {
                if (typeof snd.sendText === 'function') {
                    await snd.sendText(target, String(text));
                    extGlobDiag('send ACTIVE ok -> ' + target.scope + ':' + id);
                    return true;
                }
                if (typeof snd.sendMarkdown === 'function') {
                    await snd.sendMarkdown(target, String(text));
                    extGlobDiag('send ACTIVE ok(md) -> ' + target.scope + ':' + id);
                    return true;
                }
            }
            catch (e) {
                extGlobDiag('send ACTIVE fail -> ' + target.scope + ':' + id + ' :: ' + ((e instanceof Error ? e.message : String(e)) || '').slice(0, 140));
                return false;
            }
            return false;
        },
        sendMarkdown: (scope, id, md) => (typeof sender?.sendMarkdown === 'function' && id ? Promise.resolve(sender.sendMarkdown(toTarget(scope, id), String(md))).then(() => true).catch(() => false) : Promise.resolve(false)),
        sendImage: (scope, id, src) => (typeof sender?.sendMedia === 'function' && id ? Promise.resolve(sender.sendMedia(toTarget(scope, id), 'image', src)).then(() => true).catch(() => false) : Promise.resolve(false)),
        // 2026-10-22（主人定）：素材上传等本来**不需要群管理权限** —— 这里直接用机器人自己的
        //   access_token 通道（与 api/group-admin.ts 同源），不再借 groupAdmin，也不依赖本实例是否启用群管理。
        apiCall: (() => {
            const cred = globalThis.__qqbotAppCred;
            const appId = String(mgr?.config?.appId || cred?.appId || '');
            const appSecret = String(mgr?.config?.appSecret || cred?.appSecret || '');
            if (!appId || !appSecret)
                return undefined;
            const g = globalThis;
            if (!g.__qqbotBotToken)
                g.__qqbotBotToken = new Map();
            const cache = g.__qqbotBotToken;
            const token = async () => {
                const hit = cache.get(appId);
                if (hit && Date.now() < hit.at)
                    return hit.t;
                try {
                    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ appId, clientSecret: appSecret }),
                    });
                    const j = (await res.json());
                    if (!j.access_token)
                        return undefined;
                    cache.set(appId, { t: j.access_token, at: Date.now() + ((j.expires_in ?? 7200) - 60) * 1000 });
                    return j.access_token;
                }
                catch {
                    return undefined;
                }
            };
            return async (method, path, body) => {
                const tk = await token();
                if (!tk)
                    return { ok: false, err: { code: 'no-token', human: '取不到 access_token（appId/appSecret 缺失或网络失败）' } };
                try {
                    const res = await fetch('https://api.sgroup.qq.com' + path, {
                        method,
                        headers: { Authorization: 'QQBot ' + tk, 'content-type': 'application/json' },
                        body: body === undefined ? undefined : JSON.stringify(body),
                    });
                    const text = await res.text();
                    let data = {};
                    try {
                        data = text ? JSON.parse(text) : {};
                    }
                    catch {
                        data = { raw: text };
                    }
                    return { ok: res.ok, data, err: res.ok ? undefined : { code: res.status, human: text.slice(0, 200) } };
                }
                catch (e) {
                    return { ok: false, err: { code: 'net', human: e?.message ?? String(e) } };
                }
            };
        })(),
    };
}
/** 全局「智能判断」开关（由 session-manager 初始化时注入；照 setChannelBridge 同款做法） */
let ctxSmartGlobal = false;
export function setContextlessSmartGlobal(v) { ctxSmartGlobal = v === true; }
function getContextlessSmartGlobal() { return ctxSmartGlobal; }
/** 无上下文·智能判断：取当前会话的 dataRoot + sessionKey */
async function resolveCtxMemoEnv(exec) {
    // ★ 优先用注册时记住的会话坐标（工具里的 exec.agent 与 pre-step 的 agent 是两个不同对象，反查常失败）
    //   ⚠️ 必须要求 sessionKey 非空：备忘/压缩都按会话分文件存，空 key 会让所有会话串到同一份。
    const cached = ctxEnvOf(exec);
    if (cached && cached.sessionKey)
        return cached;
    try {
        const got = findSessionRec(channelOf(exec), exec);
        const dataRoot = got?.ch?.manager?.config?.dataRoot;
        const sessionKey = got?.rec?.sessionKey;
        if (!dataRoot || !sessionKey)
            return undefined;
        return { dataRoot: String(dataRoot), sessionKey: String(sessionKey) };
    }
    catch {
        return undefined;
    }
}
/**
 * 只要 dataRoot 的场景（QQ 群管理工具）。
 * pre-step 里 sessionKey 经常是**空**的（实测 [ctxtool-env] sk= 为空），
 * 所以这里不能像备忘那样要求 sessionKey —— 群管理只跟数据目录有关，与会话无关。
 */
async function resolveCtxDataRoot(exec) {
    const cached = ctxEnvOf(exec);
    if (cached && cached.dataRoot)
        return cached.dataRoot;
    try {
        const got = findSessionRec(channelOf(exec), exec);
        const dataRoot = got?.ch?.manager?.config?.dataRoot;
        if (dataRoot)
            return String(dataRoot);
    }
    catch { /* ignore */ }
    return undefined;
}
/** 登记文件路径（工具只登记，真正压缩在下一回合 pre-step） */
function ctxPendingPath(dataRoot, sessionKey) {
    // ⚠️ 同上：不能保留冒号（Windows 文件名禁用 `:`，会导致 pending 写不进/读不到）
    const safe = String(sessionKey).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
    return join(dataRoot, '.qqbot', 'pending-compact', safe + '.json');
}
function writeContextPending(dataRoot, sessionKey, o) {
    try {
        mkdirSync(dirname(ctxPendingPath(dataRoot, sessionKey)), { recursive: true });
        writeFileSync(ctxPendingPath(dataRoot, sessionKey), JSON.stringify(o), 'utf8');
    }
    catch { /* ignore */ }
}
/** 读登记（session-manager 的 pre-step 用） */
export function readContextPending(dataRoot, sessionKey) {
    try {
        return JSON.parse(readFileSync(ctxPendingPath(dataRoot, sessionKey), 'utf8'));
    }
    catch {
        return undefined;
    }
}
export function clearContextPending(dataRoot, sessionKey) {
    try {
        rmSync(ctxPendingPath(dataRoot, sessionKey), { force: true });
    }
    catch { /* ignore */ }
}
export function setChannelBridge(b) {
    if (!b)
        return;
    const i = channelBridges.findIndex((x) => x.manager === b.manager);
    if (i >= 0)
        channelBridges[i] = b;
    else
        channelBridges.push(b);
}
function channelOf(exec) {
    try {
        const agent = exec.agent;
        const ctx = agent?.ctx;
        if (ctx) {
            const ch = ctx.get('qqChannel');
            if (ch)
                return ch;
            diag('channelOf: agent.ctx 无 qqChannel, 尝试全局桥');
        }
        else {
            diag(`channelOf: 无 agent.ctx (agent=${typeof agent}${agent ? ` keys=${Object.keys(agent).slice(0, 8).join(',')}` : ''})`);
        }
    }
    catch (e) {
        diag(`channelOf: ctx.get 异常 ${e instanceof Error ? e.message : String(e)}, 尝试全局桥`);
    }
    // ⚠️ C类修复(2026-09-11): 多实例下不能直接回退 channelBridges[0](可能是别的实例的桥)。
    //    先按 exec.agent 精确匹配所属实例的桥(不会张冠李戴), 匹配不到才回退第一个。
    if (exec.agent) {
        for (const b of channelBridges) {
            try {
                if (b.manager?.findByAgent(exec.agent))
                    return b;
            }
            catch { /* ignore */ }
        }
    }
    if (channelBridges.length) {
        diag('channelOf: 走全局桥成功');
        return channelBridges[0];
    }
    return undefined;
}
/**
 * 解析"当前执行 agent → 会话 + 通道"(多账号/热更新后 agent 引用可能跨实例或换新对象):
 * ① ctx 通道的 manager 按引用/id 找(findByAgent 已含 id 兜底); ② 找不到→遍历所有实例桥再找。
 */
function findSessionRec(ch, exec) {
    const tryOne = (c) => {
        if (!c?.manager || !exec.agent)
            return undefined;
        const rec = c.manager.findByAgent(exec.agent);
        return rec ? { ch: c, rec } : undefined;
    };
    if (ch) {
        const r = tryOne(ch);
        if (r)
            return r;
    }
    for (const b of channelBridges) {
        if (b === ch)
            continue;
        const r = tryOne(b);
        if (r)
            return r;
    }
    return undefined;
}
/**
 * 按当前执行 agent 会话归属的账号实例取图库/定时 store(多账号: 各实例 cwd 各库)。
 * 解析优先级: ① findSessionRec(undefined, exec) —— 遍历全部实例桥、按 exec.agent 精确匹配 record
 *             (不会张冠李戴; 旧代码 findSessionRec(channelOf(exec),…) 在 agent 未命中时会错落 primary);
 *            ② channelOf(exec) —— agent.ctx 的 qqChannel(本实例通道), 退而求其次;
 *            ③ 回退 primary 单例库。
 */
function stickerStoreOf(exec) {
    try {
        const s = findSessionRec(undefined, exec);
        if (s) {
            diag(`stickerStoreOf: 按 agent 命中实例 dir=${s.ch.manager.stickerDataDir}`);
            return getStickerStore(s.ch.manager.stickerDataDir);
        }
        const ch = channelOf(exec);
        if (ch) {
            diag(`stickerStoreOf: 走 agent.ctx 通道 dir=${ch.manager.stickerDataDir}`);
            return getStickerStore(ch.manager.stickerDataDir);
        }
    }
    catch (e) {
        diag(`stickerStoreOf: 解析异常 ${e instanceof Error ? e.message : String(e)}`);
    }
    // 回退 primary(2026-09-11 B类: 尽力按 exec 所属实例 ns 取, 避免串到别的实例的库)
    let ns;
    try {
        const s2 = findSessionRec(undefined, exec);
        ns = s2?.ch.manager.settingsNs;
    }
    catch { /* ignore */ }
    diag(`stickerStoreOf: 回退 primary${ns ? ` ns=${ns}` : ''}`);
    return getStickerStore(undefined, undefined, ns);
}
/** 装载本插件时把 qqChannel 一并注入(由 dsh-qqbot setup 提供) */
export async function apply(ctx) {
    const toolsAny = ctx.tools;
    diag(`apply 调用: tools=${typeof toolsAny} register=${typeof toolsAny?.register} ctxKeys=${Object.keys(ctx).slice(0, 12).join(',')}`);
    const sendMediaTool = defineTool({
        name: 'send_media',
        description: '在当前 QQ 会话给对方发送富媒体(图片/语音/视频/文件)。kind=image|voice|video|file；source=本地文件绝对路径 或 http(s) 网址。',
        parameters: {
            kind: { type: 'string', required: true, enum: ['image', 'voice', 'video', 'file'], description: '媒体类型' },
            source: { type: 'string', required: true, description: '本地绝对路径或 http(s) 网址' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [
                { type: 'text', text: v.ok ? '已发送' : `发送失败: ${v.msg}` },
            ],
        },
        async execute(args, exec) {
            const _sess = findSessionRec(channelOf(exec), exec);
            if (!_sess)
                return { ok: false, msg: '未找到当前 QQ 会话(通道未就绪), 请稍后重试' };
            const ch = _sess.ch;
            const rec = _sess.rec;
            try {
                const srcOpt = /^https?:\/\//i.test(args.source)
                    ? { url: args.source }
                    : { localPath: args.source };
                // 本地大文件(>=5MB): 走后台任务——SDK 自动分片上传(prepare->parts->complete)耗时较长,
                // 工具立即返回不阻塞回合; 完成后/失败把系统消息写回会话, LLM 下轮自然知晓。
                if (srcOpt.localPath && typeof srcOpt.localPath === 'string') {
                    let big = false;
                    try {
                        big = statSync(srcOpt.localPath).size >= FILE_ASYNC_MIN;
                    }
                    catch {
                        big = false;
                    }
                    if (big && typeof srcOpt.localPath === 'string') {
                        const lp = srcOpt.localPath;
                        const st = statSync(lp);
                        const fname = (lp.split(String.fromCharCode(92)).pop() || '').split('/').pop() || 'file';
                        const seq = ++bgSeq;
                        const agent = rec.agent;
                        void ch.sender.sendMedia(rec.replyTarget, args.kind, { localPath: lp })
                            .then(async (r) => {
                            await notifySession(agent, '[系统] 后台任务 #' + seq + ' 完成：已发送 ' + fname + '(' + fmtMB(st.size) + ')。');
                            if (r && r.id) {
                                try {
                                    const store = getStickerStore(ch.manager.stickerDataDir);
                                    const sid = lookupId(store, lp);
                                    if (sid)
                                        store.markUsed(sid);
                                }
                                catch { /* 统计失败不影响发送 */ }
                            }
                            diag('bgSend #' + seq + ' ok ' + fname);
                        })
                            .catch(async (e) => {
                            const msg = e instanceof Error ? e.message : String(e);
                            await notifySession(agent, '[系统] 后台任务 #' + seq + ' 失败：' + msg + '（未发送完成, 可重试或改用小文件）');
                            diag('bgSend #' + seq + ' fail ' + fname + ': ' + msg);
                        });
                        return { ok: true, msg: '📤 大文件 ' + fname + '(' + fmtMB(st.size) + ') 已提交后台任务 #' + seq + '——分片上传耗时较长, 完成/失败后会有系统消息通知' };
                    }
                }
                const r = await ch.sender.sendMedia(rec.replyTarget, args.kind, srcOpt);
                // 发送成功且是图库里的本地图 → 标记"用过"(升正式区, 不入滚动清理)
                if (r?.id && srcOpt.localPath) {
                    try {
                        const store = getStickerStore(ch.manager.stickerDataDir);
                        const sid = lookupId(store, srcOpt.localPath);
                        if (sid)
                            store.markUsed(sid);
                    }
                    catch { /* 统计失败不影响发送 */ }
                }
                return { ok: true, msg: r?.id ? String(r.id) : '' };
            }
            catch (e) {
                // 表情包闸门拒绝: 明确告知"不要重试", 避免 LLM 换图/反复尝试刷闸
                if (isStickerGateDenied(e)) {
                    return { ok: false, msg: `表情包闸门拦截, 本轮不再尝试发图: ${e.message.replace(/^\[sticker-gate\]\s*/, '')}` };
                }
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const recallTool = defineTool({
        name: 'recall_message',
        description: '撤回本机器人最近发给当前 QQ 会话的消息。index 缺省 1(=最近一条)，2=倒数第 2 条，以此类推。',
        parameters: {
            index: { type: 'integer', description: '要撤的倒数第几条(默认1)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [
                { type: 'text', text: v.ok ? '已撤回' : `撤回失败: ${v.msg}` },
            ],
        },
        async execute(args, exec) {
            const _sess = findSessionRec(channelOf(exec), exec);
            if (!_sess)
                return { ok: false, msg: '未找到当前 QQ 会话(通道未就绪), 请稍后重试' };
            const ch = _sess.ch;
            const rec = _sess.rec;
            const rawIdx = args.index;
            const idx = rawIdx == null || !Number.isFinite(rawIdx) ? 1 : rawIdx;
            try {
                const ok = await ch.sender.recallByIndex(rec.replyTarget, idx);
                return ok ? { ok: true, msg: '' } : { ok: false, msg: `第${idx}条无可撤回消息或已超时` };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const listStickersTool = defineTool({
        name: 'list_stickers',
        description: '(聊天加分项,气氛对就大胆用!)按情绪关键词搜本地表情包库, 挑最贴切的一张用 send_media(kind=image, source=路径) 发出去(一次最多一张); 实在查不到贴切的才回纯文字。',
        parameters: {
            query: { type: 'string', description: '语义关键词(可空=最近收藏; 匹配标签与描述)' },
            tag: { type: 'string', description: '标签过滤(可空)' },
            limit: { type: 'integer', description: '返回条数 1~20(默认 3)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    msg: { type: 'string', required: true },
                    items: {
                        type: 'array', required: true,
                        items: {
                            type: 'object', additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                tags: { type: 'array', required: true, items: { type: 'string' } },
                                desc: { type: 'string', required: true },
                                used: { type: 'integer', required: true },
                                formal: { type: 'boolean', required: true },
                                src: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_a, v) => {
                if (!v.ok)
                    return [{ type: 'text', text: `查询失败: ${v.msg}` }];
                if (v.items.length === 0) {
                    return [{ type: 'text', text: '表情包库中无匹配,不建议发图,只回文字即可' }];
                }
                return v.items.map((it, i) => ({
                    type: 'text',
                    text: `${i + 1}. [${it.tags.length > 0 ? it.tags.join('/') : '未打标'}] 用过${it.used}次${it.desc ? `\n   描述: ${it.desc.slice(0, 120)}` : ''}\n   → ${it.path}`,
                }));
            },
        },
        async execute(args, exec) {
            try {
                const store = stickerStoreOf(exec);
                const limitRaw = args.limit;
                // 默认 3 条(2026-09-12 token 瘦身: 每条含描述+路径, 5 条≈白烧几十 token, 3 条足够挑图)
                const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.floor(limitRaw ?? 3))) : 3;
                const hits = store.search({
                    q: args.query ?? '',
                    tag: args.tag ?? '',
                    limit,
                });
                return {
                    ok: true,
                    msg: '',
                    items: hits.map(h => ({
                        path: h.path,
                        tags: h.tags,
                        desc: h.desc ?? '',
                        used: h.useCount,
                        formal: h.layer === 'library',
                        src: h.sourceGroup ?? '',
                    })),
                };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e), items: [] };
            }
        },
    });
    /** 按 path / id 前缀 / 来源URL 定位条目(list_stickers 的 path、或群消息里那张图的 URL 都行) */
    const lookupId = (store, ref) => {
        const r = (ref ?? '').trim();
        if (!r)
            return undefined;
        const direct = store.get(r);
        if (direct)
            return direct.id;
        if (/^https?:\/\//i.test(r)) {
            const byUrl = store.findBySourceUrl(r);
            if (byUrl)
                return byUrl.id;
        }
        if (r.includes('\\') || r.includes('/')) {
            const hit = store.search({ q: '', limit: 200, includeTrash: true }).find((h) => h.path === r);
            if (hit)
                return hit.id;
        }
        for (const it of store.search({ q: '', limit: 200, includeTrash: true })) {
            if (it.id.startsWith(r))
                return it.id;
        }
        return undefined;
    };
    const tagStickerTool = defineTool({
        name: 'sticker_tag',
        description: '(主动维护)看到值得留的图就收藏+打标(群友发的有梗/好图, 不管这轮发不发): tags=逗号分隔中文短标签(如 爆笑,元气), desc=一句"画面+情绪+适用场合"; 缺标签的图(见 sticker_untagged)也用它补。想省视觉额度可传 vision=false(只对已在库的图打标)。',
        parameters: {
            sticker: { type: 'string', required: true, description: '图片URL 或 本地绝对路径(也可传 list_stickers 返回的路径)' },
            tags: { type: 'string', description: '逗号分隔中文标签,如 开心,元气,打招呼' },
            desc: { type: 'string', description: '一句中文详细描述(画面+情绪+适合场合)' },
            vision: { type: 'boolean', description: '图不在库时是否先识图生成草稿,默认true' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            try {
                const a = args;
                const store = stickerStoreOf(exec);
                const sticker = (a.sticker ?? '').trim();
                if (!sticker)
                    return { ok: false, msg: 'sticker 不能为空' };
                const userTags = (a.tags ?? '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
                const userDesc = (a.desc ?? '').trim() || undefined;
                if (!userTags.length && !userDesc && a.vision === false) {
                    return { ok: false, msg: 'tags/desc 至少给一个(或允许 vision 识图生成草稿)' };
                }
                let id = lookupId(store, sticker);
                let created = false;
                if (!id) {
                    if (/^https?:\/\//i.test(sticker)) {
                        const r = await store.capture(sticker, { sourceUrl: sticker }, undefined);
                        if (r.status === 'error')
                            return { ok: false, msg: `下载收藏失败: ${r.error}` };
                        id = r.id;
                        created = r.status === 'new';
                    }
                    else if (existsSync(sticker)) {
                        const r = await store.importLocalFile(sticker); // 2026-09-13 起 async(内部要算感知哈希 dHash)
                        if (r.status === 'error')
                            return { ok: false, msg: `导入失败: ${r.error}` };
                        id = r.id;
                        created = r.status === 'new';
                    }
                    else {
                        return { ok: false, msg: '找不到这张图(图不在库里,且给的不是有效URL/路径)' };
                    }
                }
                const userHas = userTags.length > 0 || !!userDesc;
                if (!created) {
                    // 已在库: 给了内容→部分更新; 没给内容→不覆盖现有, 仅当该图本来空(待整理)才识图补
                    const meta = store.get(id);
                    if (userHas) {
                        store.setDescTags(id, userTags.length ? userTags : undefined, userDesc);
                        store.promote(id); // 主动打标=认可这张图 → 升正式区, 不入自动滚动清理
                        return { ok: true, msg: '已更新标签/描述 ✓(并标记为收藏保留)' };
                    }
                    if (meta?.needsDescribe && a.vision !== false) {
                        try {
                            const p = store.pathOf(id);
                            if (p) {
                                const draft = await autoTagImage(p, '');
                                if (draft) {
                                    store.setDescTags(id, draft.tags, draft.desc);
                                    return { ok: true, msg: `该图原无标签/描述,已识图补标: [${draft.tags.join('/')}]` };
                                }
                            }
                        }
                        catch { /* 草稿失败则提示用户手填 */ }
                        return { ok: true, msg: '该图原无标签/描述,识图失败,请传 tags/desc 手动补' };
                    }
                    const cur = store.get(id);
                    return {
                        ok: true,
                        msg: `该图已在库里(标签: ${(cur?.tags ?? []).join('/') || '无'}${cur?.desc ? `; 描述: ${cur.desc.slice(0, 60)}` : ''})。想改请传 tags/desc`,
                    };
                }
                // 新收藏: 识图草稿(默认) + 用户内容覆盖
                let t = userTags.length ? userTags : undefined;
                let d = userDesc;
                const needDraft = !t && !d;
                if (needDraft && a.vision !== false) {
                    try {
                        const p = store.pathOf(id);
                        if (p) {
                            const draft = await autoTagImage(p, '');
                            if (draft) {
                                t = draft.tags;
                                d = draft.desc;
                            }
                        }
                    }
                    catch { /* 草稿失败则留待整理 */ }
                }
                if (t || d)
                    store.setDescTags(id, t, d);
                store.promote(id); // 主动收藏 → 正式区(不参与自动滚动清理)
                const tagsShown = (t ?? []).join('/') || '无';
                return { ok: true, msg: `已收藏并打标 [${tagsShown}]` };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const deleteStickerTool = defineTool({
        name: 'sticker_delete',
        description: '把表情包库里的某张图送进回收站(30天后自动清,期间可用 sticker_restore 找回)。当这张图不合适/不想要/发出去被嫌弃时用。sticker=那张图的本地路径(来自 list_stickers)或群图URL。',
        parameters: {
            sticker: { type: 'string', required: true, description: '要操作的图: list_stickers 查到的本地路径 / 或当时群消息里那张图的图片URL' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? '已送回收站(30天内可找回)' : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            try {
                const store = stickerStoreOf(exec);
                const id = lookupId(store, args.sticker ?? '');
                if (!id)
                    return { ok: false, msg: '找不到这张图(请先用 list_stickers 拿到准确 path)' };
                store.markTrash(id);
                return { ok: true, msg: '' };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const restoreStickerTool = defineTool({
        name: 'sticker_restore',
        description: '从回收站找回一张图(取消删除)。sticker=回收站里那张图的路径或URL。',
        parameters: {
            sticker: { type: 'string', required: true, description: '回收站中那张图的路径或URL' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? '已找回 ✓' : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            try {
                const store = stickerStoreOf(exec);
                const id = lookupId(store, args.sticker ?? '');
                if (!id)
                    return { ok: false, msg: '找不到(请确认在回收站且路径准确)' };
                store.restore(id);
                return { ok: true, msg: '' };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const statsStickerTool = defineTool({
        name: 'sticker_stats',
        description: '查看表情包库概况(总数/各分区/未打标数/占用)。想了解库存或准备整理时用: 若"未打标"数大于0, 接着用 sticker_untagged 翻出未整理图并 sticker_tag 补标, 保持弹药库好用。',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.msg }],
        },
        async execute(_args, exec) {
            try {
                const s = stickerStoreOf(exec).stats();
                const mb = (s.totalBytes / 1024 / 1024).toFixed(1);
                return {
                    ok: true,
                    msg: `表情包库: 共${s.total}张(候选${s.candidate}/正式${s.library}/回收站${s.trash}/负${s.negative}), 未打标${s.untagged}张, 占用${mb}MB`,
                };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const untaggedStickerTool = defineTool({
        name: 'sticker_untagged',
        description: '(日常整理巡检,AI应主动做)列出表情包库里还没整理完的图(缺标签或缺介绍)。群里没活/或想维护图库时先调它(也可先 sticker_stats 看有没有未打标), 发现有图就逐张用 sticker_tag 补标签和一句描述; 库越干净, list_stickers 搜图越准。参数 a: 1=全部(候选+收藏) 2=只看收藏(正式文件夹)。可选 limit(每批条数, 默认20, 上限100)、offset(跳过前N条, 翻页用)。',
        parameters: {
            a: { type: 'integer', enum: [1, 2], required: true, description: '1=查全部 2=只查收藏文件夹(正式)' },
            limit: { type: 'integer', description: '每批返回条数(1-100, 默认20)' },
            offset: { type: 'integer', description: '跳过前 N 条(翻页用, 默认0)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.msg }],
        },
        async execute(args, exec) {
            try {
                const store = stickerStoreOf(exec);
                const onlyLibrary = args.a === 2;
                const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 20)));
                const offset = Math.max(0, Math.floor(args.offset ?? 0));
                // untagged 查询语义=标签与介绍都空; 这里要"缺任一即算未整理", 故全量取回后过滤
                const all = store.queryAll({ layer: onlyLibrary ? 'library' : undefined, q: undefined, untagged: false, includeTrash: false });
                const miss = all.filter((it) => it.layer !== 'negative' && ((!it.tags || it.tags.length === 0) || !it.desc));
                const total = miss.length;
                const end = Math.min(total, offset + limit);
                const page = miss.slice(offset, end);
                const lines = page.map((it, i) => {
                    const lackTag = !it.tags || it.tags.length === 0;
                    const lackDesc = !it.desc;
                    const lack = lackTag && lackDesc ? '缺标签+介绍' : lackTag ? '缺标签' : '缺介绍';
                    return `${offset + i + 1}. [${it.layer === 'library' ? '收藏' : '候选'}] ${lack} ${it.path || ''}`;
                });
                const scopeTxt = onlyLibrary ? '收藏文件夹' : '全部(候选+收藏)';
                const more = total > end ? `\n(还有 ${total - end} 张, 想看更多请传 offset=${end} 继续翻页)` : '';
                return {
                    ok: true,
                    msg: total === 0
                        ? `🎉 ${scopeTxt}里的图都整理好了(都带标签和介绍)`
                        : `未整理完的图(${scopeTxt}): 共 ${total} 张, 显示第 ${offset + 1}-${end} 张:\n${lines.join('\n')}${more}\n想补的用 sticker_tag 打标/写介绍(图路径就是上面返回的)。`,
                };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const scheduleTimerTool = defineTool({
        name: 'schedule_timer',
        description: '给自己(当前 QQ 会话)安排定时任务: 到点后系统会把 prompt 作为新消息注入本会话, 你会带着上下文处理并回复到 QQ。kind=once(一次性, 默认)或 daily(每天固定时刻)。once 用 seconds(N 秒后, ≥30) 或 atTime(今天 HH:MM, 已过则明天); daily 必填 atTime(HH:MM)。seconds 与 atTime 至少给一个。同一会话同一时刻的每日任务不要重复建。',
        parameters: {
            kind: { type: 'string', enum: ['once', 'daily'], description: 'once=一次性(默认); daily=每天固定时刻' },
            seconds: { type: 'integer', description: '多少秒后触发(仅 once; ≥30)' },
            atTime: { type: 'string', description: '几点几分 24h 制 HH:MM(如 08:30; once 且无 seconds 时=今天该点已过则明天; daily 必填)' },
            prompt: { type: 'string', required: true, description: '到点后注入本会话的提示内容(≤800字), 写清要你做什么' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `定时失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const _sess = findSessionRec(channelOf(exec), exec);
            if (!_sess)
                return { ok: false, msg: '未找到当前 QQ 会话(通道未就绪), 请稍后重试' };
            const ch = _sess.ch;
            const rec = _sess.rec;
            try {
                const store = getScheduleStore(ch.manager.scheduleDataDir);
                const r = store.add({
                    kind: args.kind ?? undefined,
                    scope: rec.scope,
                    peerId: rec.peerId,
                    seconds: args.seconds,
                    atTime: args.atTime,
                    prompt: args.prompt,
                });
                if (!r.ok || !r.id)
                    return { ok: false, msg: r.error ?? '创建失败' };
                const job = store.get(r.id);
                let whenDesc = '';
                if (job) {
                    if (job.kind === 'daily') {
                        whenDesc = `每天 ${job.atTime}`;
                    }
                    else {
                        const nf = store.nextFireAt(job);
                        whenDesc = nf ? new Date(nf).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '稍后';
                    }
                }
                return { ok: true, msg: `✅ 已创建${job?.kind === 'daily' ? '每日' : '一次性'}定时任务(id=${r.id}, ${whenDesc}触发)。到点我会自动收到提示并处理。可用 schedule_cancel 查看/取消。` };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    const scheduleCancelTool = defineTool({
        name: 'schedule_cancel',
        description: '取消/删除当前会话的定时任务。不带 id 调用会列出本会话全部定时任务(id+时间+内容)供挑选; 带 id 则删除该任务。',
        parameters: {
            id: { type: 'string', description: '要删除的任务 id(不填=列出本会话所有定时任务)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.msg }],
        },
        async execute(args, exec) {
            const _sess = findSessionRec(channelOf(exec), exec);
            if (!_sess)
                return { ok: false, msg: '未找到当前 QQ 会话(通道未就绪), 请稍后重试' };
            const ch = _sess.ch;
            const rec = _sess.rec;
            const store = getScheduleStore(ch.manager.scheduleDataDir);
            if (!args.id) {
                const mine = store.list().filter(j => j.scope === rec.scope && j.peerId === rec.peerId);
                if (mine.length === 0)
                    return { ok: true, msg: '本会话暂无定时任务。' };
                const lines = mine.map(j => {
                    const when = j.kind === 'daily'
                        ? `每天 ${j.atTime}`
                        : j.dueAt
                            ? new Date(j.dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
                            : '';
                    return `- id=${j.id} ${j.kind === 'daily' ? '每日' : '一次性'} ${when}${j.enabled ? '' : ' [已停用]'} | ${(j.prompt ?? '').slice(0, 60)}`;
                });
                return { ok: true, msg: `本会话定时任务共 ${mine.length} 条:\n${lines.join('\n')}\n要删除哪条, 请带对应 id 再调用 schedule_cancel。` };
            }
            const job = store.get(args.id);
            if (!job || job.scope !== rec.scope || job.peerId !== rec.peerId) {
                return { ok: false, msg: `任务 ${args.id} 不存在或不属于本会话` };
            }
            store.remove(args.id);
            return { ok: true, msg: `🗑️ 已删除定时任务 ${args.id}` };
        },
    });
    // text_break: 专用"打断正文"工具(2026-09-05, 主人定) —— 零副作用、零查询、近零 token。
    // 机制: 把回复正文拆成多个文本块、块间调用本工具, QQ 端就会把每块作为独立一条消息发出
    // (工具调用 = 天然断点)。本工具不做事: 输入任意(留空即可), 返回空, 仅用于中断文本流。
    // ⚠️ 数量不限制: 连发条数由「出站方式」控制(适配主动默认=同一条入站消息前5条被动回复、
    //   第6条起自动转主动), 工具本身无 5 条限制; 5 条上限是旧「被动回复同一 msg」的 QQ 限制, 已由适配主动解决。
    const textBreakTool = defineTool({
        name: 'text_break',
        description: '打断正文实现"逐条发送": 想逐字/逐句卖萌或把长话拆成多条连发时, 把内容拆成几个文本块, 每块之间调用一次本工具(参数随便填个占位值即可), 对方就会收到分割的多条消息。工具本身无任何副作用, 不会发东西。拆多少条都行, 没有 5 条限制(连发保护由出站方式自动处理: 前5条带引用、之后自动转独立消息, 不会被吞)。',
        parameters: {
            next: { type: 'string', required: true, description: '占位参数: 随便填一个值(如 "." 或下一段内容), 工具不读它, 只用于打断文本流' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true } },
            },
            // ⚠️ 2026-09-30 修: render 空文本 → 空 tool_result → DeepSeek 400 INVALID_REQUEST
            render: () => [{ type: 'text', text: '·' }],
        },
        async execute() {
            return { ok: true }; // 纯打断, 无实质结果
        },
    });
    // reply_gate: 回复闸门(实验, 2026-09-05, 主人设想: 让 AI"自主判定要不要回", 判定不吃瓜时由宿主硬终止回合,
    // 实现"真·静默吃瓜"。机制参考 dsh-task-control: agent.cancel({kind:'user'},{keepInbox:true}) 立即切断当前回合输出)。
    // ⚠️ 描述只讲"什么时候该用它"和两个分支的效果, 不给具体场景规则(写死规则会导致静默率过高)。
    const replyGateTool = defineTool({
        name: 'reply_gate',
        // ★ 2026-10-29（主人定，纠正旧语义）：这是**"闭嘴"开关，不是"开口"开关**。
        //   旧描述写「开始回复前先调用它」，但实测模型根本不会每轮都调（该回的轮次它直接回了）——
        //   说明"每轮都要调用"既做不到、也不必要；真正必须的是**每轮都要判断**。
        //   ⇒ 描述改成「判断要回就直接回、不用调；判断不该说话才调用」，顺带消掉 issue #28 的结构问题：
        //     回复路径上不再多一条工具回执，上下文末尾仍是群友那句话。
        description: '回复闸门（**只在你不回复时**才调用）: 每轮先自己判断"这一轮该不该说话"——判断要回，就**直接回复**，不要调用本工具; 判断这一轮不该说话(没@你、话题与你无关、没必要插嘴)，就调用它传 reply:false，本回合立即静默终止，你不会再输出任何内容(这条消息就像没发生过)。默认行为是"正常回复"，所以不调用它 = 照常说话。' +
            '\n✅ **收到 reply:false 后，你会看到一条 `tool call aborted` 之类的"报错" —— 那正是「静默成功」本身**（本工具就是靠中断输出实现的，设计如此），不是工具坏了、也不是调用失败。看到它请直接收手，什么都不用做、也不用重试。' +
            '\n⛔ **不要为了"想安静"去动别的开关**（例如把出站模式切成 silent/静默）：那会影响**后续所有回合**，而你要的只是"这一轮别说话"。要静默，只走本工具。' +
            '\n⚠️ 传 reply:false 后**不要再调用任何工具**(包括记笔记、记喜好、发表情包): 本回合已经关闭, 那些调用会被直接中止 —— 想记录的话, 留到下一次开口的回合里做。',
        parameters: {
            reply: { type: 'boolean', required: true, description: 'false=静默终止本回合(不再输出任何内容); true=正常继续(一般用不到 —— 想说话就直接说, 不必调本工具)' },
            reason: { type: 'string', required: true, description: '为什么这一轮不说话, 如"未@且话题无关" / "只是别人在聊天" / "已经问过她了"' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    stopped: { type: 'boolean', required: true },
                },
            },
            render: (_a, v) => [
                { type: 'text', text: v.stopped
                        ? '(已静默: 本回合终止, 不再回复)'
                        // ★ 2026-10-29（issue #28）：原来是「(继续回复)」—— 括号舞台提示体，天然被读成"接着演"，
                        //   而闸门把回合劈成两段后，待回的那条消息已被挤到上下文中间，末尾只剩这句提示 ⇒
                        //   模型最省力的行为就是**续写聊天记录 / 代写群友台词**。这里把输出契约直接写进回执。
                        : '(闸门已开：只写你自己这一条要发的话 —— 不要替群友写台词、不要输出 [昵称] 形式的对话行、不要续写后面的对话)' },
            ],
        },
        async execute(args, exec) {
            if (args.reply === false) {
                try {
                    const agent = exec.agent;
                    if (agent && typeof agent.cancel === 'function') {
                        agent.cancel({ kind: 'user' }, { keepInbox: true });
                    }
                }
                catch {
                    /* cancel 抛错也按静默处理 */
                }
                return { ok: true, stopped: true };
            }
            return { ok: true, stopped: false };
        },
    });
    // outbound_mode: 出站模式开关(2026-09-07, 主人定) —— 让 AI 自己决定三档(不含 nothink!)
    // ⚠️ 安全边界: nothink(完全不思考)禁止 AI 自切(防锁死, 主人只能在设置页配; 唤醒走 /outmode 斜杠)。
    // 切换走 outbound-mode-switch 注册表 → live 热生效 + settings 持久化 → dock/设置一致。
    const outboundModeTool = defineTool({
        name: 'outbound_mode',
        description: '出站模式开关(自己决定, 热更新不用重启): adaptive=适配主动(默认: 真人消息前5条带引用、连发自动转独立消息不被QQ吞); detail=详细主动(聊天同 adaptive, 额外把工具调用/工具结果也推到QQ —— 主人要看进度时用, 消息会变多, 用完切回); passive=被动(始终回最后一条, 连发约4~5条后被QQ吞); silent=完全不出站(照常思考但不发, 潜水观察)。nothink 那档只能主人在设置页配。' +
            '\n怎么选: 正常聊天/被@→adaptive · 主人要看工具进度→detail · 想保持引用感→passive · 判断不该在群里说话→silent',
        parameters: {
            mode: { type: 'string', required: true, enum: ['adaptive', 'detail', 'passive', 'silent'], description: '目标模式: adaptive(默认推荐) / detail(详细主动: 连工具调用一起推) / passive / silent' },
            reason: { type: 'string', required: true, description: '为什么切到这档(简短理由)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true }, mode: { type: 'string', required: true } },
            },
            render: (_a, v) => [
                { type: 'text', text: v.ok ? `(出站模式 → ${v.mode})` : `切换失败: ${v.msg}` },
            ],
        },
        async execute(args, exec) {
            if (args.mode !== 'adaptive' && args.mode !== 'detail' && args.mode !== 'passive' && args.mode !== 'silent') {
                return { ok: false, msg: '只允许 adaptive/detail/passive/silent(nothink 需主人在设置页配置)', mode: String(args.mode ?? '') };
            }
            // 多实例修复(2026-09-11): 按当前会话所属实例(ns)切换 —— 原全局单例 writer 会被多实例覆盖,
            // 导致切到别的实例的 config(dock 显示与实际不符)。
            let ns;
            try {
                const _sess0 = findSessionRec(channelOf(exec), exec);
                ns = _sess0?.ch.manager.settingsNs;
            }
            catch { /* 解析失败则交给 switchOutboundMode 单实例兜底 */ }
            const r = await switchOutboundMode(args.mode, ns);
            if (!r.ok)
                return { ok: false, msg: r.msg, mode: r.mode };
            // 切换成功后用 bot 直发确认消息(绕过出站路由): 即使切到 silent(不出站)/被动,
            // 主人也一定能收到"模式已切换"的通知(与 send_media 同款工具直发通道, 不受 outboundMode 拦截)。
            const MODE_LABEL = {
                adaptive: '适配主动(推荐默认): 真人消息前5条带引用回你, 连发自动转独立消息',
                detail: '详细主动: 聊天同适配主动, 额外把工具调用/工具结果也推给你(看进度用)',
                passive: '被动: 始终回复你那条(连发约4~5条后被QQ吞)',
                silent: '完全不出站: 照常思考但这条回复不发出(潜水观察用; web上仍可对话)',
            };
            try {
                const _sess = findSessionRec(channelOf(exec), exec);
                if (_sess) {
                    const confirm = `⇄ 出站模式已切换: **${r.mode}**\n${MODE_LABEL[r.mode] ?? ''}\n(由 outbound_mode 工具切换, bot 直发确认)`;
                    await _sess.ch.sender.sendMarkdown(_sess.rec.replyTarget, confirm);
                }
            }
            catch (err) {
                diag(`outbound_mode 确认消息直发失败: ${err instanceof Error ? err.message : String(err)}`);
            }
            return { ok: true, msg: r.msg, mode: r.mode };
        },
    });
    // ── QQ 群管理工具组(2026-09-05, P2; 依赖 config.groupAdmin.enabled + 机器人=群管理员) ──
    // 危险写操作(审批/禁言)仅按主人指示执行(工具描述写死约束); owners 白名单接入留待后续,
    // 官方未开放能力(踢人/成员列表)由 client FEATURE_GATES 返回人话, 不在本层重复。
    // 目标群解析(2026-09-05 主人定): QQ 群会话 → 当前群; web/非群会话 → config.groupAdmin.manageGroup
    // ("对话里管一个群"不依赖会话形态; 多群管理走设置 UI⑥ P3)。
    // ⚠️ 升级 0.1.2-rc.1 后补强(2026-09-05): web 直连 agent 可能不在 SessionManager 会话表里,
    //    findSessionRec 失败 → 旧逻辑直接 return undefined, manageGroup 兜底形同虚设。
    //    改为: 找不到会话也回退到全局桥 manager(groupAdmin.enabled 且 manageGroup 非空即可用)。
    function groupAdminOf(exec) {
        try {
            const s = findSessionRec(channelOf(exec), exec);
            if (s) {
                const client = s.ch.manager.groupAdmin;
                if (!client)
                    return undefined;
                // 2026-10-20 修(主人定)：群工具**不该让人传 gid** —— 默认就该是"当前会话所在的群"。
                //   优先用会话自己的 peerId（= 入站 group openid，最可靠）；
                //   replyTarget 只是"最近一次出站目标"，发过一次别的群就会被带歪（实测踩过）。
                const peer = String(s.rec.peerId ?? '').trim();
                const t = s.rec.replyTarget;
                const gid = peer
                    || (t && t.scope === 'group' ? t.targetId : undefined)
                    || s.ch.manager.manageGroup
                    || undefined;
                return { client, gid };
            }
            // 会话表无此 agent(web 直连等): 遍历全局桥, 找第一个"群管理开启 + 配了 manageGroup"的实例
            for (const b of channelBridges) {
                try {
                    const client = b.manager.groupAdmin;
                    if (!client)
                        continue;
                    const mg = b.manager.manageGroup;
                    if (mg)
                        return { client, gid: mg };
                }
                catch { /* 跳过坏桥 */ }
            }
            return undefined;
        }
        catch {
            return undefined;
        }
    }
    const listJoinRequestsTool = defineTool({
        name: 'group_join_requests',
        description: '群管理(读): 看待审批入群申请(**默认只给本页 5 条**, 用 page 翻页; 同一人重复申请只留最新)。传 gid 可查指定群, 不填=当前群/manageGroup。仅主人要求时调用; 需开启"QQ群管理"且机器人为群管理员。跨群审批请显式带 gid。' +
            '\n示例: {gid:"<群openid>"} · {gid:"<群openid>", page:2} · {limit:20 看全}',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(可选)。不填=当前会话群或 manageGroup' },
            page: { type: 'integer', description: '第几页(默认 1)' },
            limit: { type: 'integer', description: '本页条数 1~20(默认 5; 要一次看全可传 20)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启(设置→QQ群管理)或非群会话' };
            const gid = args.gid || ga.gid;
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid, 无法确定目标群' };
            const r = await ga.client.listJoinRequests(gid);
            if (!r.ok)
                return { ok: false, msg: r.err.human };
            // 补群名(官方 info 接口, 失败不阻断)
            let gname = '';
            try {
                const gi = await ga.client.getGroupInfo(gid);
                if (gi.ok && gi.data?.group_name)
                    gname = gi.data.group_name;
            }
            catch { /* 群名失败不影响 */ }
            const raw = r.data.list;
            if (raw.length === 0)
                return { ok: true, msg: `当前没有待审批的入群申请 ✓(群 ${gname ? `「${gname}」` : ''}${gid})` };
            // 去重(2026-09-12 主人要求): 同一人反复申请只留**最新**一条 —— 官方列表按时间倒序, 故首次出现即最新
            const seen = new Set();
            const list = raw.filter((j) => {
                const key = String(j.member_openid ?? '');
                if (key === '' || seen.has(key))
                    return false;
                seen.add(key);
                return true;
            });
            // 分页(2026-09-12 token 瘦身): 默认只回 5 条, 其余用 page 翻
            const lim = Math.max(1, Math.min(20, Math.round(Number(args.limit)) || 5));
            const totalPages = Math.max(1, Math.ceil(list.length / lim));
            const page = Math.min(Math.max(1, Math.round(Number(args.page)) || 1), totalPages);
            const start = (page - 1) * lim;
            const slice = list.slice(start, start + lim);
            const head = `入群申请 共 ${raw.length} 条(去重后 ${list.length} 条 · 第 ${page}/${totalPages} 页 · 每页 ${lim} 条) 群 ${gname ? `「${gname}」` : ''}${gid}:`;
            const lines = slice.map((j, i) => `${start + i + 1}. ${j.username ?? '?'} (${j.member_openid}) 来源:${j.apply_source ?? '?'} 验证:${verifyHuman(j.verify_info) || '-'}${j.risk_tips ? ` ⚠️${j.risk_tips}` : ''}`);
            const more = list.length > start + slice.length ? `\n（还有 ${list.length - start - slice.length} 条 → 再调本工具传 page=${page + 1}）` : '';
            return { ok: true, msg: `${head}\n${lines.join('\n')}${more}` };
        },
    });
    const approveJoinTool = defineTool({
        name: 'group_approve_join',
        description: '群管理(写,危险): 审批入群申请(approve 放行 / decline 拒绝可带理由), 支持批量 member_openids。仅主人明确要求时调用; 调用前先用 group_join_requests 核对申请人。⚠️跨群审批务必显式传 gid(不传=当前会话所在群, 会批错群)。' +
            '\n示例: {gid:"<群openid>", member_openids:["<id1>","<id2>"], op:"approve", reason:"-"} · 拒绝: op:"decline", reason:"答非所问"',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(可选)。不填=当前会话群或 manageGroup; 填了则审批指定群的申请' },
            member_openids: { type: 'array', description: '批量审批: 申请人 member_openid 数组(来自 group_join_requests), 一次批多人' },
            member_openid: { type: 'string', description: '单个申请人 member_openid(批量时可不填)' },
            op: { type: 'string', required: true, enum: ['approve', 'decline'], description: 'approve 放行 / decline 拒绝' },
            reason: { type: 'string', required: true, description: '拒绝理由(decline 时填; approve 或不需要可填 "-")' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启或非群会话' };
            const gid = args.gid || ga.gid;
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid' };
            const targets = Array.isArray(args.member_openids) && args.member_openids.length
                ? args.member_openids
                : (args.member_openid ? [args.member_openid] : []);
            if (targets.length === 0)
                return { ok: false, msg: '请提供要审批的 member_openid(可多个)' };
            // join_request_id 官方审批必填(缺省报 40103007): 先拉列表按 member_openid 匹配自动补上
            const listR = await ga.client.listJoinRequests(gid);
            if (!listR.ok)
                return { ok: false, msg: listR.err.human };
            const list = listR.data.list ?? [];
            const results = [];
            let failed = 0;
            for (const midRaw of targets) {
                const mid = String(midRaw);
                const found = list.find((j) => j.member_openid === mid);
                const r = await ga.client.approveJoinRequest(gid, mid, args.op, {
                    ...(found ? { join_request_id: String(found.join_request_id ?? '') } : {}),
                    ...(args.op === 'decline' && String(args.reason ?? '') && String(args.reason) !== '-'
                        ? { reject_reason: String(args.reason) }
                        : {}),
                });
                if (r.ok) {
                    results.push(`${String(mid).slice(0, 10)}… ${args.op === 'approve' ? '✅放行' : '已拒绝'}${found ? `(${String(found.username ?? '')})` : ''}`);
                }
                else {
                    failed++;
                    results.push(`${String(mid).slice(0, 10)}… ❌ ${r.err.human}`);
                }
            }
            if (failed === 0) {
                return { ok: true, msg: `${args.op === 'approve' ? '✅ 已全部放行' : '已全部拒绝'} ${targets.length} 人:\n${results.join('\n')}` };
            }
            return { ok: failed === targets.length ? false : true, msg: `${targets.length - failed}/${targets.length} 成功:\n${results.join('\n')}` };
        },
    });
    /**
     * 入群申请「自动审批」(2026-09-12 主人要求): 给一组关键词 —— **验证消息命中的程序直接放行, 不命中的直接拒绝**。
     * ⚠️ 基于**官方待审列表**(`join_request_list`), **不是**本地 pending 流水 —— 后者含已处理/重复事件, 照着批会报错。
     * ⚠️ 拒绝不可逆: 默认直接执行(主人风格), 想先看结果传 `dry_run=true`。
     * 拒绝理由一律中性(默认"答非所问"), **绝不写暗号/答案/内部判据**。
     */
    const autoApproveJoinTool = defineTool({
        name: 'group_join_auto',
        description: '群管理(写,危险,**仅主人明确要求时调用**): 按关键词批量审批入群申请 —— 验证消息**命中任一关键词的放行**, 其余直接拒绝。基于官方待审列表(不含本地历史流水)。拒绝不可逆; 想先看结果传 dry_run=true。' +
            '\n示例: {gid:"<群openid>", keywords:["早饭"], rejectReason:"答非所问"} · 只放行不拒: {..., rejectUnmatched:false} · 预览: {..., dry_run:true}',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(**可选**：不填=当前会话所在的群；跨群操作才传)' },
            keywords: { type: 'array', items: { type: 'string' }, required: true, description: '放行关键词(任一命中即放行; 不区分大小写)' },
            rejectUnmatched: { type: 'boolean', description: 'true(默认)=未命中的一律拒绝; false=只放行命中的, 其余不动' },
            rejectReason: { type: 'string', description: '拒绝理由(默认"答非所问"; 不要写暗号/答案)' },
            dry_run: { type: 'boolean', description: 'true=只返回"将放行/拒绝哪些人", 不执行' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启(设置→QQ群管理)或非群会话' };
            const gid = String(args.gid || ga.gid || '');
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid, 无法确定目标群' };
            const kws = (Array.isArray(args.keywords) ? args.keywords : [])
                .map((k) => String(k).trim().toLowerCase())
                .filter(Boolean);
            if (kws.length === 0)
                return { ok: false, msg: 'keywords 至少给一个(放行关键词)' };
            const r = await ga.client.listJoinRequests(gid);
            if (!r.ok)
                return { ok: false, msg: r.err.human };
            const raw = r.data.list;
            if (raw.length === 0)
                return { ok: true, msg: '当前没有待审批的入群申请 ✓(无需自动审批)' };
            // 同一人重复申请只留最新(官方列表按时间倒序 → 首次出现即最新)
            const seen = new Set();
            const list = raw.filter((j) => {
                const k = String(j.member_openid ?? '');
                if (k === '' || seen.has(k))
                    return false;
                seen.add(k);
                return true;
            });
            const hitList = [];
            const missList = [];
            for (const j of list) {
                const text = verifyHuman(j.verify_info).toLowerCase();
                (kws.some((k) => text.includes(k)) ? hitList : missList).push(j);
            }
            const rejectUnmatched = args.rejectUnmatched !== false;
            const nameOf = (j) => `${j.username ?? '?'}(…${String(j.member_openid).slice(-4)})`;
            if (args.dry_run === true) {
                return {
                    ok: true,
                    msg: `【dry-run, 未执行】待审 ${list.length} 条(去重后):\n` +
                        `将放行 ${hitList.length} 人: ${hitList.slice(0, 5).map(nameOf).join('、') || '(无)'}\n` +
                        `将拒绝 ${rejectUnmatched ? missList.length : 0} 人: ${rejectUnmatched ? (missList.slice(0, 5).map(nameOf).join('、') || '(无)') : '(已关闭)'}`,
                };
            }
            let okA = 0;
            let failA = 0;
            let okD = 0;
            let failD = 0;
            const errs = [];
            for (const j of hitList) {
                const rr = await ga.client.approveJoinRequest(gid, String(j.member_openid), 'approve', {
                    join_request_id: String(j.join_request_id ?? ''),
                });
                if (rr.ok)
                    okA++;
                else {
                    failA++;
                    errs.push(`${nameOf(j)} 放行失败: ${rr.err.human}`);
                }
            }
            if (rejectUnmatched) {
                const reason = String(args.rejectReason ?? '').trim() || '答非所问';
                for (const j of missList) {
                    const rr = await ga.client.approveJoinRequest(gid, String(j.member_openid), 'decline', {
                        join_request_id: String(j.join_request_id ?? ''),
                        reject_reason: reason,
                    });
                    if (rr.ok)
                        okD++;
                    else {
                        failD++;
                        errs.push(`${nameOf(j)} 拒绝失败: ${rr.err.human}`);
                    }
                }
            }
            return {
                ok: true,
                msg: [
                    `✅ 自动审批完成: 放行 ${okA}/${hitList.length}${rejectUnmatched ? ` · 拒绝 ${okD}/${missList.length}` : ''}(待审共 ${list.length} 条)`,
                    hitList.length ? `放行: ${hitList.slice(0, 5).map(nameOf).join('、')}${hitList.length > 5 ? ` …等 ${hitList.length} 人` : ''}` : '',
                    rejectUnmatched && missList.length ? `拒绝: ${missList.slice(0, 5).map(nameOf).join('、')}${missList.length > 5 ? ` …等 ${missList.length} 人` : ''}` : '',
                    errs.length ? `⚠️ 失败 ${failA + failD} 条: ${errs.slice(0, 3).join('; ')}` : '',
                ].filter(Boolean).join('\n'),
            };
        },
    });
    const sessionListTool = defineTool({
        name: 'session_list',
        description: '会话(读): 列出全部活跃会话(范围/peer/群名/活跃时间), 用于跨会话寻址。**默认 peer/sender 只给尾号**(省 token); 需要完整 openid 时传 full=true。',
        parameters: {
            full: { type: 'boolean', description: 'true=给完整 openid; 默认 false(只给尾号, 寻址用群名/备注即可)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const full = args?.full === true;
            const lines = [];
            // 遍历全部已注册实例(module 级注册表, 重启后仍可枚举; 不依赖 channelBridges)
            const managers = managersOf();
            if (managers.length === 0) {
                const ch = channelOf(exec);
                const manager = ch?.manager;
                if (manager)
                    managers.push(manager);
            }
            if (managers.length === 0)
                return { ok: false, msg: '找不到会话管理器实例(无已注册实例)' };
            let n = 0;
            for (const manager of managers) {
                const list = manager.listSessions();
                const ns = manager.settingsNs;
                // 群名映射(注册表 {cwd}/.qqbot/groups.json: gid → {name}) —— 让 AI 能用"群名"寻址, 不必抄 openid
                // 群名取自**数据根**注册表({dataRoot}/.qqbot/groups.json, 本机=cwd\dshqqbot\.qqbot) —— 2026-09-12 修正:
                // 以前用 manager.cwd(=**工作目录** <工作目录>) 读, 拿到的是旧位置那份, 群名过时
                // (「群C」显示成「AI（旧备注）」)、新群(群B)整个缺席。
                let reg = {};
                try {
                    reg = JSON.parse(readFileSync(groupRegistryPath(manager.dataRoot), 'utf8'));
                }
                catch {
                    reg = {};
                }
                for (const s of list) {
                    n++;
                    const label = s.scope === 'group' && reg[s.peerId]?.name ? ` "${reg[s.peerId].name}"` : '';
                    // 2026-09-12 token 瘦身(主人定): **默认只给 peer/sender 尾号** —— 完整 32 位 openid 每行 20+ token,
                    // 而寻址用"群名/备注"就够(broadcast_send / target_group 都支持按名解析); 要完整 id 传 full=true。
                    const peerShown = full ? s.peerId : '…' + String(s.peerId).slice(-4);
                    const senderShown = full ? s.senderId : '…' + String(s.senderId).slice(-4);
                    lines.push(`${n}. [${s.scope}]${ns !== 'im-qqbot' ? `(${ns})` : ''} peer=${peerShown}${label} sender=${senderShown} id=${s.sessionId}${s.agentPreset ? ` (${s.agentPreset})` : ''} 活跃=${new Date(s.lastActivity).toLocaleTimeString()}`);
                }
                // 潜在会话: 群注册表里的群可能还没 getOrCreate(无活跃记录), 但 sessionId 可确定性算出
                try {
                    const ids = new Set(list.map((s) => s.sessionId));
                    for (const gid of Object.keys(reg ?? {})) {
                        const sid = manager.sessionIdFor('group', gid);
                        if (!ids.has(sid))
                            lines.push(`[潜在群] ${reg[gid]?.name ?? ''} peer=${gid} id=${sid} 活跃=未创建`);
                    }
                }
                catch { /* 注册表异常则跳过 */ }
            }
            if (lines.length === 0)
                return { ok: true, msg: '当前无活跃会话, 也无已注册群' };
            return { ok: true, msg: `会话 ${lines.length} 个:\n${lines.join('\n')}` };
        },
    });
    /**
     * 群发目标解析(2026-09-12): 完整 openid 直接用; 否则按**群名/备注**模糊匹配
     * (注册表 {cwd}/.qqbot/groups.json + 各实例活跃会话)。命中 0 个或多个 → 只回候选清单,
     * **绝不猜着发**(这是"默认不 dry-run"还能安全的原因)。
     */
    function resolveBroadcastTargets(rawTargets, root) {
        const isOpenid = (s) => /^[A-Za-z0-9_-]{20,40}$/.test(s);
        // 合并多份 groups.json：同一目标**按 lastAt 最新者胜**。
        // ⚠️ 2026-09-12 实测踩到：旧位置的注册表(`{cwd}/.qqbot/groups.json`)还在、名字是过时的 ——
        // 同一个群在旧文件里叫「AI（旧备注）」，在 dataRoot 那份里才叫「群C」；
        // 而「群B」只存在于 dataRoot 那份里，只读旧文件就完全查不到。
        const known = new Map();
        const add = (scope, peerId, name, lastAt = 0) => {
            const k = `${scope}:${peerId}`;
            const cur = known.get(k);
            if (!cur) {
                known.set(k, { scope, peerId, name, lastAt });
                return;
            }
            if (lastAt > cur.lastAt) {
                cur.lastAt = lastAt;
                if (name)
                    cur.name = name;
                return;
            }
            if (!cur.name && name)
                cur.name = name;
        };
        const readReg = (dir) => {
            try {
                const reg = JSON.parse(readFileSync(groupRegistryPath(dir), 'utf8'));
                for (const [gid, v] of Object.entries(reg ?? {}))
                    add('group', gid, String(v?.name ?? ''), Number(v?.lastAt ?? 0));
            }
            catch { /* 该目录没有注册表则跳过 */ }
        };
        const managers = managersOf();
        const dirs = new Set();
        // 只认**数据根**：manager.dataRoot = dataRootOf(config) = config.dataRoot(=cwd\dshqqbot) ——
        // 数据目录早就定好了, 不该再去 cwd 捞旧注册表(2026-09-12 主人指正: 就是 cwd\dshqqbot, 别绕)。
        for (const m of managers)
            dirs.add(m.dataRoot);
        dirs.add(root);
        for (const d of dirs)
            readReg(d);
        // 🗂 自定义分组(dock「📇 群组管理 → 🗂 分组」; 2026-09-12 起由浏览器搬到 host) → **与主人共用同一份**:
        // 主人在面板上点几下分的组, AI 直接写分组名就能群发。结构: [{ id, name, members:['group:xxx'|'c2c:yyy'] }]
        const targetGroups = new Map();
        for (const d of dirs) {
            try {
                const o = JSON.parse(readFileSync(join(d, '.qqbot', 'target-groups.json'), 'utf8'));
                for (const g of (Array.isArray(o?.groups) ? o.groups : [])) {
                    if (g?.name && Array.isArray(g.members) && g.members.length > 0)
                        targetGroups.set(String(g.name), g.members.map(String));
                }
            }
            catch { /* 该数据根没有分组文件则跳过 */ }
        }
        for (const m of managers) {
            try {
                for (const s of m.listSessions())
                    add(s.scope, s.peerId, '');
            }
            catch { /* ignore */ }
        }
        const all = [...known.values()];
        const targets = [];
        for (const raw of rawTargets) {
            // ① 分组名(优先于群名): "群友" 或 "分组:群友" → 展开成组内全部目标(与 dock 同一份分组数据)
            const gname = raw.replace(/^分组[:：]\s*/u, '');
            const members = targetGroups.get(raw) ?? targetGroups.get(gname);
            if (members) {
                for (const m of members) {
                    const mm = /^(group|c2c):(.+)$/i.exec(m);
                    if (!mm)
                        continue;
                    const scope = mm[1].toLowerCase() === 'c2c' ? 'c2c' : 'group';
                    const peerId = mm[2].trim();
                    const hit = all.find((x) => x.scope === scope && x.peerId === peerId);
                    targets.push({ scope, peerId, ...(hit?.name ? { name: hit.name } : {}) });
                }
                continue;
            }
            const prefixed = /^(group|c2c):(.+)$/i.exec(raw);
            if (prefixed) {
                const scope = prefixed[1].toLowerCase() === 'c2c' ? 'c2c' : 'group';
                const peerId = prefixed[2].trim();
                const hit = all.find((x) => x.scope === scope && x.peerId === peerId);
                targets.push({ scope, peerId, ...(hit?.name ? { name: hit.name } : {}) });
                continue;
            }
            if (isOpenid(raw)) {
                const hit = all.find((x) => x.peerId === raw);
                targets.push({ scope: hit?.scope ?? 'group', peerId: raw, ...(hit?.name ? { name: hit.name } : {}) });
                continue;
            }
            const kw = raw.toLowerCase();
            const hits = [...new Map(all.filter((x) => x.name && x.name.toLowerCase().includes(kw)).map((h) => [h.peerId, h])).values()];
            if (hits.length === 1) {
                const h = hits[0];
                targets.push({ scope: h.scope, peerId: h.peerId, ...(h.name ? { name: h.name } : {}) });
            }
            else if (hits.length === 0) {
                const list = all.filter((x) => x.name).map((x) => `· ${x.name} — ${x.peerId}`).join('\n');
                return { targets: [], error: `没找到叫「${raw}」的群/私聊。已知目标:\n${list || '(暂无带备注的目标, 请用完整 openid)'}\n\n请用上面的名字或完整 openid 再调一次。` };
            }
            else {
                const list = hits.map((x) => `· ${x.name} — ${x.peerId}`).join('\n');
                return { targets: [], error: `「${raw}」匹配到多个目标, 请指定一个:\n${list}` };
            }
        }
        return { targets: [...new Map(targets.map((t) => [`${t.scope}:${t.peerId}`, t])).values()] };
    }
    /** 群发任务 → 人话摘要(逐目标状态 + message_id + 失败原因 + 撤回提示) */
    function fmtBroadcastTask(t, fallbackId) {
        if (!t)
            return `任务不存在(可能已被清理); task_id=${fallbackId ?? '(未给)'}`;
        // 2026-09-12 token 瘦身: 逐目标明细最多列 5 个(超出只报数量), 免得一次群发 20 个目标把结果灌爆上下文
        const shownTargets = t.targets.slice(0, 5);
        const rows = shownTargets.map((tg) => {
            const r = t.results[tg.peerId];
            const who = tg.name ? `${tg.name}(${tg.peerId})` : tg.peerId;
            if (!r)
                return `· ${who} ⏳ 待发`;
            if (r.ok)
                return `· ${who} ✅ message_id=${r.message_id ?? '(无)'}`;
            return `· ${who} ❌ ${r.err ?? '失败'}(已重试 ${t.retries[tg.peerId] ?? 0} 次)`;
        });
        if (t.targets.length > shownTargets.length)
            rows.push(`…还有 ${t.targets.length - shownTargets.length} 个目标(省略)`);
        const okN = t.targets.filter((tg) => t.results[tg.peerId]?.ok).length;
        const done = t.state === 'done' || t.state === 'partial_failed' || t.state === 'cancelled';
        const head = done
            ? `群发${t.state === 'done' ? '完成' : t.state === 'cancelled' ? '已取消' : '部分失败'}: ${okN}/${t.targets.length} 成功 task_id=${t.task_id}`
            : `群发进行中(${t.state}): ${okN}/${t.targets.length} 已成功 task_id=${t.task_id} —— 后台队列会继续推进, 稍后用 action="status" 查`;
        return [
            head,
            ...rows,
            okN > 0 ? `（2 分钟内可撤回：action="recall", task_id="${t.task_id}", targets=[要撤的目标]）` : '',
        ].filter(Boolean).join('\n');
    }
    /**
     * 群发工具(2026-09-12 主人要求): 把插件现成的**广播队列**(features/broadcast.ts)接给 agent。
     * 设计(主人定): **默认直接发**, 不做 dry-run 预览 —— 主人当场指挥、自己就是发起人, 多一轮确认纯属烧 token;
     *   只有"按群名解析"命中 0 个/多个候选时才回一轮(那是必要信息, 不猜着发);
     *   护栏 = 工具描述写死"仅主人明确要求时调用" + **2 分钟撤回窗口**(返回 task_id 与 message_id)。
     * 白拿的队列能力: 串行逐目标、失败指数退避重试 3 次、任务落盘 {dataRoot}/.qqbot/broadcast-tasks.json、与 dock 面板同一份任务。
     * ⚠️ 不支持文件/图片群发(QQ 上传接口按群隔离 + 占主动消息配额), 资源请在正文放链接。
     */
    const broadcastSendTool = defineTool({
        name: 'broadcast_send',
        description: '群发(写,高影响,**仅主人明确要求时调用**): 同一段内容一次发到多个 QQ 群/私聊, 走插件广播队列(串行+失败重试, 与 dock「📤 群发 · 广播」同一份任务, 2 分钟内可逐目标撤回)。targets 写**分组名/群名或备注**或完整 openid; 名字有歧义时只列候选让你确认, 不猜着发。默认直接发送(dry_run=true 才预览)。不支持发文件/图片 —— 资源把链接写进正文。' +
            '\n最小示例(照抄改值):\n' +
            '· 发分组 {targets:["群友"], text:"早上好呀各位～"}\n' +
            '· 发指定群 {targets:["群A","群B"], text:"公告:…"}\n' +
            '· 撤回/查进度 {action:"recall", task_id:"bc-xxx", targets:["群友"]} / {action:"status", task_id:"bc-xxx"}',
        parameters: {
            targets: { type: 'array', items: { type: 'string' }, required: true, description: '目标: 分组名(如"群友") / 群名或群备注(模糊匹配) / 完整 openid(32位) / "group:xxx" / "c2c:xxx"' },
            text: { type: 'string', description: '群发内容(text ≤2000 字 / markdown ≤8000 字); 链接直接写在里面' },
            type: { type: 'string', enum: ['text', 'markdown'], description: '默认 text(纯文本最稳); markdown 需模板权限(已开通)' },
            dry_run: { type: 'boolean', description: 'true=只预览"发给谁+内容"; 默认 false 直接发' },
            action: { type: 'string', enum: ['send', 'recall', 'status'], description: '默认 send; recall=撤回(需 task_id+targets, 2 分钟内); status=查进度' },
            task_id: { type: 'string', description: 'recall/status 用的任务 id(从发送结果里拿)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const a = args;
            const ga = groupAdminOf(exec);
            const ch = channelOf(exec);
            // ⚠️ 数据根 ≠ 工作目录: manager.dataRoot = dataRootOf(config)(本机=<cwd>\AI\dshqqbot),
            // 而 manager.cwd = config.cwd(本机=<cwd>\AI)。2026-09-12 主人实测发现我一开始写成了 cwd,
            // 结果广播任务落到 AI\.qqbot\(旧位置), dock 在 dshqqbot\.qqbot\ 里根本看不到。
            const root = ch?.manager?.dataRoot ?? managersOf()[0]?.dataRoot ?? managersOf()[0]?.cwd;
            if (!root)
                return { ok: false, msg: '找不到数据根(无已注册实例)' };
            if (!ga)
                return { ok: false, msg: '群管理未开启(设置页→QQ群管理): 群发要走官方接口, 需要机器人凭据' };
            const action = String(a.action ?? 'send');
            const rawTargets = Array.isArray(a.targets) ? a.targets.map((t) => String(t).trim()).filter(Boolean) : [];
            if (rawTargets.length === 0)
                return { ok: false, msg: 'targets 至少给一个(群名或 openid)' };
            if (action === 'status') {
                const t = a.task_id ? broadcastQueue.getTask(root, String(a.task_id)) : undefined;
                if (!t)
                    return { ok: false, msg: '没找到该任务(或没传 task_id)' };
                return { ok: true, msg: fmtBroadcastTask(t) };
            }
            const resolved = resolveBroadcastTargets(rawTargets, root);
            if (resolved.error)
                return { ok: false, msg: resolved.error };
            if (action === 'recall') {
                const taskId = String(a.task_id ?? '');
                if (!taskId)
                    return { ok: false, msg: 'recall 需要 task_id(从发送结果里拿)' };
                const out = [];
                for (const tg of resolved.targets) {
                    const r = await broadcastQueue.recallTaskMessage(root, taskId, tg.peerId, ga.client);
                    out.push(`${r.ok ? '✅ 已撤回' : '❌ 撤回失败'} ${tg.name ?? ''}(${tg.peerId})${r.err ? ' — ' + r.err : ''}`);
                }
                return { ok: true, msg: out.join('\n') };
            }
            // ── send ──
            const text = String(a.text ?? '');
            const type = a.type === 'markdown' ? 'markdown' : 'text';
            const limit = type === 'markdown' ? 8000 : 2000;
            if (!text.trim())
                return { ok: false, msg: 'text 必填(要群发的内容)' };
            if (text.length > limit)
                return { ok: false, msg: `内容过长: ${text.length} 字(${type} 上限 ${limit} 字)` };
            if (resolved.targets.length > 20)
                return { ok: false, msg: `目标太多(${resolved.targets.length} 个), 单次最多 20 个` };
            if (a.dry_run === true) {
                return {
                    ok: true,
                    msg: `【dry-run, 未发送】将发到 ${resolved.targets.length} 个目标:\n` +
                        resolved.targets.slice(0, 5).map((t) => `· ${t.name ?? '(无备注)'}`).join('\n') +
                        (resolved.targets.length > 5 ? `\n…还有 ${resolved.targets.length - 5} 个(省略)` : '') +
                        `\n\n内容(${type}, ${text.length} 字):\n${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`,
                };
            }
            const task = broadcastQueue.createTask(root, { type, content: text, targets: resolved.targets, created_by: 'agent' });
            broadcastQueue.confirmTask(root, task.task_id);
            // 同步推进: 每次一个目标, 最多等 ~20 秒; 目标多/网络慢时交给 host 的定时器继续, 用 action=status 查。
            // 目标之间隔 1.5s —— 群发是**主动消息**, 官方频控 Bot 维度 60/qpm(认证)/30/qpm(未认证),
            // 留余量给被动回复与别的推送(原来无间隔, 目标一多会瞬时打满额度)。
            const STEP_MS = 1500;
            const deadline = Date.now() + 20_000;
            let cur = broadcastQueue.getTask(root, task.task_id);
            while (cur && (cur.state === 'queued' || cur.state === 'sending') && Date.now() < deadline) {
                cur = await broadcastQueue.advanceTask(root, task.task_id, ga.client);
                if (cur && (cur.state === 'queued' || cur.state === 'sending') && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
                }
            }
            return { ok: true, msg: fmtBroadcastTask(cur, task.task_id) };
        },
    });
    /**
     * 目标分组管理(2026-09-12 主人要求"AI 也要能编辑分组"):
     * 读写的就是 dock「📇 群组管理 → 🗂 分组」那份 host 数据({dataRoot}/.qqbot/target-groups.json),
     * 所以 AI 建/改的分组主人刷新面板就能看到; 反过来主人分的组, AI 直接拿来群发(targets 写分组名)。
     */
    const targetGroupTool = defineTool({
        name: 'target_group',
        description: '目标分组管理(与 dock「📇 群组管理 → 🗂 分组」共用同一份数据, 改完主人刷新面板就能看到): 查看/新建/改名/删除分组, 或把目标加进/移出分组。建好后 broadcast_send 的 targets 直接写**分组名**即可群发。改动类动作仅主人明确要求时调用; 重名/找不到会明确报错。' +
            '\n最小示例: {action:"list"} · {action:"create", name:"开发群"} · {action:"add", name:"群友", targets:["群A"]} · {action:"remove", name:"群友", targets:["群B"]}',
        parameters: {
            action: { type: 'string', enum: ['list', 'create', 'rename', 'delete', 'add', 'remove'], required: true, description: 'list=查看全部分组 / create=新建 / rename=改名 / delete=删除 / add=把 targets 加进分组 / remove=把 targets 移出分组' },
            name: { type: 'string', description: '分组名(除 list 外必填)' },
            new_name: { type: 'string', description: 'rename 时的新分组名' },
            targets: { type: 'array', items: { type: 'string' }, description: 'add/remove 的目标(群名/群备注/完整 openid/分组名 均可, 写法同 broadcast_send)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const a = args;
            const ch = channelOf(exec);
            const root = ch?.manager?.dataRoot ?? managersOf()[0]?.dataRoot ?? managersOf()[0]?.cwd;
            if (!root)
                return { ok: false, msg: '找不到数据根(无已注册实例)' };
            const file = join(root, '.qqbot', 'target-groups.json');
            const read = () => {
                try {
                    const o = JSON.parse(readFileSync(file, 'utf8'));
                    return Array.isArray(o?.groups) ? o.groups : [];
                }
                catch {
                    return [];
                }
            };
            const save = (groups) => {
                try {
                    mkdirSync(join(root, '.qqbot'), { recursive: true });
                    writeFileSync(file, JSON.stringify({ groups }, null, 1), 'utf8');
                }
                catch { /* 落盘失败: 内存结果照常返回, 主人可重试 */ }
            };
            const fmt = (g) => {
                const ms = g.members ?? [];
                const tail = ms.slice(0, 6).map((m) => '…' + String(m).replace(/^[a-z]+:/i, '').slice(-4)).join(', ');
                return `· ${g.name}(${ms.length})${ms.length ? ' — ' + tail + (ms.length > 6 ? ' …' : '') : ''}`;
            };
            const action = String(a.action ?? 'list');
            const name = String(a.name ?? '').trim();
            let groups = read();
            if (action === 'list') {
                if (groups.length === 0)
                    return { ok: true, msg: '当前没有任何分组(dock「📇 群组管理 → 🗂 分组」可新建, 也可以让我建)' };
                return { ok: true, msg: `分组 ${groups.length} 个:\n${groups.map(fmt).join('\n')}` };
            }
            if (name === '')
                return { ok: false, msg: `${action} 需要 name(分组名)` };
            const idx = groups.findIndex((g) => String(g.name ?? '') === name);
            if (action === 'create') {
                if (idx >= 0)
                    return { ok: false, msg: `分组「${name}」已经存在了` };
                groups.push({ id: 'tg-' + Date.now().toString(36), name, members: [] });
                save(groups);
                return { ok: true, msg: `✅ 已新建分组「${name}」(空组) —— 可以用 action=add 加目标, 或让主人在面板勾选加入` };
            }
            if (idx < 0)
                return { ok: false, msg: `找不到分组「${name}」。现有: ${groups.map((g) => g.name).join('、') || '(无)'}` };
            if (action === 'rename') {
                const nn = String(a.new_name ?? '').trim();
                if (nn === '')
                    return { ok: false, msg: 'rename 需要 new_name' };
                if (groups.some((g) => String(g.name ?? '') === nn))
                    return { ok: false, msg: `已经有个分组叫「${nn}」了` };
                groups[idx].name = nn;
                save(groups);
                return { ok: true, msg: `✅ 分组「${name}」已改名为「${nn}」` };
            }
            if (action === 'delete') {
                const n = (groups[idx].members ?? []).length;
                groups = groups.filter((_, i) => i !== idx);
                save(groups);
                return { ok: true, msg: `✅ 已删除分组「${name}」(${n} 个成员; 只是取消分组, 不影响这些群/人本身)` };
            }
            if (action === 'add' || action === 'remove') {
                const rawTargets = Array.isArray(a.targets) ? a.targets.map((t) => String(t).trim()).filter(Boolean) : [];
                if (rawTargets.length === 0)
                    return { ok: false, msg: `${action} 需要 targets(至少一个)` };
                const resolved = resolveBroadcastTargets(rawTargets, root);
                if (resolved.error)
                    return { ok: false, msg: resolved.error };
                const cur = new Set(groups[idx].members ?? []);
                const before = cur.size;
                for (const t of resolved.targets) {
                    const k = `${t.scope}:${t.peerId}`;
                    if (action === 'add')
                        cur.add(k);
                    else
                        cur.delete(k);
                }
                groups[idx].members = [...cur];
                save(groups);
                const delta = action === 'add' ? cur.size - before : before - cur.size;
                return {
                    ok: true,
                    msg: `✅ 分组「${name}」${action === 'add' ? '加入' : '移出'} ${delta} 个目标, 现共 ${cur.size} 个${delta < resolved.targets.length ? '(重复的已跳过)' : ''}\n${resolved.targets.slice(0, 5).map((t) => '· ' + (t.name || t.peerId)).join('\n')}${resolved.targets.length > 5 ? `\n…还有 ${resolved.targets.length - 5} 个(省略)` : ''}`,
                };
            }
            return { ok: false, msg: `未知 action: ${action}` };
        },
    });
    /** 发到目标 QQ 群/私聊: 若给了 media 先发图(用目标 manager 归属的 sender), 再发带来源文本; 无 sender 则 groupAdmin 文本兜底 */
    async function sendQQWithMedia(manager, scope, peer, body, media, exec) {
        const ch = channelBridges.find((b) => b.manager === manager);
        const sent = [];
        if (media) {
            if (ch?.sender) {
                try {
                    const src = /^https?:\/\//i.test(media) ? { url: media } : { localPath: media };
                    await ch.sender.sendMedia({ scope, targetId: peer }, 'image', src);
                    sent.push('🖼️图');
                }
                catch {
                    sent.push('⚠️发图失败');
                }
            }
            else {
                sent.push('⚠️无发送通道');
            }
        }
        const ga = groupAdminOf(exec);
        if (ga) {
            if (scope === 'c2c') {
                // c2c 主动推送必须走官方 is_wakeup 召回通道(30天窗), 自建 REST sendC2cText 无 is_wakeup
                // → 被动回复窗口外不投递(web LLM 已唤醒但 QQ 收不到, 2026-09-10 主人实测 bug)。
                // 优先 ch.sender.sendC2cWakeup(SDK sendWakeup); 无 sender 才退自建 REST。
                if (ch?.sender && typeof ch.sender.sendC2cWakeup === 'function') {
                    try {
                        await ch.sender.sendC2cWakeup({ scope, targetId: peer }, body);
                        sent.push('📨已发到QQ 私聊');
                    }
                    catch (err) {
                        sent.push(`⚠️QQ私聊发送失败: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                else {
                    const sr = await ga.client.sendC2cText(peer, body);
                    sent.push(sr.ok ? '📨已发到QQ 私聊(降级)' : `⚠️QQ发送失败: ${sr.err.human}`);
                }
            }
            else {
                const sr = await ga.client.sendGroupText(peer, body);
                sent.push(sr.ok ? '📨已发到QQ 群' : `⚠️QQ发送失败: ${sr.err.human}`);
            }
        }
        else {
            sent.push('⚠️群管理未开启');
        }
        return `；${sent.join(' ')}`;
    }
    const sessionWakeTool = defineTool({
        name: 'session_wake',
        description: '跨会话(写,谨慎,**仅主人明确要求时调用**): 向指定会话发一条消息。mode=wake(默认)唤醒对方 LLM; mode=append 只写上下文不唤醒(省 token 的喇叭模式)。同时经 QQ 通道把消息发到该会话绑定的群/私聊。目标用 session_id(见 session_list) 或 peer_id+scope。' +
            '\n最小示例(照抄改值):\n' +
            '· 唤醒单发 {session_id:"<uuid>", text:"帮我看下这个"}\n' +
            '· 跨群喇叭不唤醒 {peer_id:"<群openid>", scope:"group", text:"公告:…", mode:"append"}\n' +
            '· 批量(每项自带 text) {batch:[{peer_id:"<g1>",scope:"group",text:"A"},{peer_id:"<g2>",scope:"group",text:"B",media:"D:/pic.png"}]} ← 用 batch 时**不要再传顶层 text**',
        parameters: {
            session_id: { type: 'string', description: '目标会话 id(完整 sessionId, 来自 session_list)' },
            peer_id: { type: 'string', description: '或按 peer 寻址: 群 openid/私聊 openid(需带 scope)' },
            scope: { type: 'string', enum: ['group', 'c2c'], description: 'peer_id 寻址时的范围(group=群 / c2c=私聊)' },
            text: { type: 'string', description: '要发送的消息内容(单发必填; 用 batch 时**不要**传这个, 每项自带 text)' },
            mode: { type: 'string', enum: ['wake', 'append'], description: 'wake=唤醒 LLM 开回合(默认); append=只追加上下文不唤醒(省 token, 喇叭模式)' },
            send_qq: { type: 'boolean', description: '是否同时发到绑定的 QQ 群/私聊(给人看, 默认 true)。false=只处理 LLM 侧不走 QQ 通道' },
            media: { type: 'string', description: '跨群发图: 图片本地路径或 http(s) URL, 随消息发到目标群(需 send_qq=true)' },
            batch: { type: 'array', description: '批量模式(2026-09-10): 一次向多个会话各发不同文本。每项: {session_id 或 peer_id+scope, text, mode?, send_qq?, media?}。单发参数与 batch 二选一, batch 优先。', items: {
                    type: 'object', additionalProperties: false, properties: {
                        session_id: { type: 'string', description: '目标会话 id' },
                        peer_id: { type: 'string', description: '或 peer 寻址: 群/私聊 openid' },
                        scope: { type: 'string', enum: ['group', 'c2c'], description: 'peer 寻址范围' },
                        text: { type: 'string', required: true, description: '该会话要发的消息内容' },
                        mode: { type: 'string', enum: ['wake', 'append'], description: '默认 wake' },
                        send_qq: { type: 'boolean', description: '默认 true' },
                        media: { type: 'string', description: '该会话随消息发的图片' },
                    },
                } },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            // 来源标注(便于对方直接会话): 优先当前执行 agent 的 id(=会话 id); 再取当前会话记录;
            // 再回退 groupAdmin 的 hub 会话; 最后 'web'
            const from = (() => {
                try {
                    const aid = exec.agent?.id;
                    if (typeof aid === 'string' && aid.length >= 8)
                        return aid.slice(0, 8) + '…';
                    const ch0 = channelOf(exec);
                    const src = findSessionRec(ch0, exec);
                    if (src?.rec?.sessionId)
                        return src.rec.sessionId.slice(0, 8) + '…';
                }
                catch { /* 忽略 */ }
                return 'web';
            })();
            const map = {
                ok: '✅ 已发送并唤醒',
                'no-session': `❌ 会话不存在: 目标会话不在任何已注册实例中(或已重建/换绑)`,
                'no-followup': '❌ 该会话 agent 不支持 followup 唤醒',
                'no-append': '❌ 该会话 agent 不支持上下文追加',
                'no-agent': '❌ 找不到目标会话 agent',
                busy: '⏳ 目标会话正忙(回合进行中且无安全注入通道)',
                fail: '❌ 处理异常',
            };
            /** 单条发送(单发与 batch 共用): one={session_id?|peer_id?+scope?, text, mode?, send_qq?, media?} */
            const sendOne = async (one) => {
                const text = String(one.text || '');
                if (!text)
                    return '❌ 缺少 text —— 单发请传顶层 text; 用 batch 时**每项自带 text**(顶层 text 不必传, 传了也不算错)。最小示例见本工具描述';
                const body = `【来自会话 ${from}】\n${text}${one.media ? `\n[附带图片: ${one.media}]` : ''}`;
                const sid = String(one.session_id || '');
                if (sid) {
                    // ① session_id 寻址: module 级注册表跨全部实例精确命中(重启后仍可查)
                    const manager = findManagerBySessionId(sid);
                    if (!manager)
                        return `❌ 会话不存在: ${sid.slice(0, 8)}…(不在任何已注册实例)`;
                    const mode = String(one.mode || 'wake');
                    let r;
                    if (mode === 'append') {
                        const rec0 = manager.findBySessionId(sid);
                        const targetAgent = rec0?.agent
                            ?? manager.findHostAgent(sid)?.agent
                            ?? (await manager.resumeHostAgent(sid).catch(() => undefined))?.agent;
                        if (!targetAgent)
                            r = 'no-session';
                        else
                            r = await safeAppendUserMessage(targetAgent, body, loggerLike(exec));
                    }
                    else {
                        r = await wakeSessionAgent(manager, sid, loggerLike(exec), body);
                    }
                    let extra = '';
                    if (one.send_qq !== false) {
                        // 目标 peer: ⚠️ 不能只问 findManagerBySessionId 返回的 manager——它可能经 findHostAgent 命中
                        // 错误实例(宿主 registry 全局), 导致 rec=undefined → 静默不发(2026-09-10 04:35 实测)。
                        let qScope;
                        let qPeer = '';
                        let ownerManager;
                        for (const m of managersOf()) {
                            try {
                                const r2 = m.findBySessionId(sid);
                                if (r2) {
                                    ownerManager = m;
                                    qScope = r2.scope;
                                    qPeer = r2.peerId;
                                    break;
                                }
                            }
                            catch { /* 单实例异常跳过 */ }
                        }
                        if (!ownerManager) {
                            for (const m of managersOf()) {
                                try {
                                    const raw = readFileSync(groupRegistryPath(m.cwd), 'utf8');
                                    const reg = JSON.parse(raw);
                                    for (const gid of Object.keys(reg ?? {})) {
                                        if (m.sessionIdFor('group', gid) === sid) {
                                            ownerManager = m;
                                            qScope = 'group';
                                            qPeer = gid;
                                            break;
                                        }
                                    }
                                    if (ownerManager)
                                        break;
                                }
                                catch { /* 无注册表则跳过 */ }
                            }
                        }
                        if (ownerManager && qScope && qPeer) {
                            extra = await sendQQWithMedia(ownerManager, qScope, qPeer, body, String(one.media || ''), exec);
                        }
                        else {
                            const diag = `未找到目标会话的 QQ peer(findBySessionId 与群注册表均 miss, sid=${sid.slice(0, 8)}…)`;
                            try {
                                loggerLike(exec).warn(`[session_wake] ${diag}`);
                            }
                            catch { /* */ }
                            extra = `；⚠️${diag}`;
                        }
                    }
                    return `${map[r] ?? r} (${sid.slice(0, 8)}…)${extra}`;
                }
                // ② peer 寻址
                const peer = String(one.peer_id || '');
                const sc = String(one.scope || '');
                if (!peer || !sc)
                    return '请给 session_id, 或 scope+peer_id';
                let manager = findManagerByPeer(sc, peer);
                if (!manager) {
                    const curCh = channelOf(exec);
                    if (curCh?.manager && curCh.manager.findByPeer(sc, peer))
                        manager = curCh.manager;
                    else if (curCh?.manager)
                        manager = curCh.manager;
                }
                if (!manager)
                    return '找不到会话管理器实例(无已注册实例)';
                let rec = manager.findByPeer(sc, peer);
                if (!rec) {
                    if (sc === 'c2c') {
                        return `❌ 未找到该私聊对象的真实会话(${peer.slice(0, 8)}…): 请先让对方主动私聊本 bot 一次(dock「💬聊天」里能直接发), 或用 session_id 寻址。原因: openid 按 bot 应用隔离, 乱建会话会发到错误实例`;
                    }
                    rec = await manager.getOrCreate(sc, peer, 'master', { scope: sc, targetId: peer });
                    if (!rec)
                        return `会话创建失败: ${sc} ${peer.slice(0, 8)}…`;
                }
                const sid2 = rec.sessionId;
                const mode2 = String(one.mode || 'wake');
                let r;
                if (mode2 === 'append') {
                    r = rec.agent
                        ? await safeAppendUserMessage(rec.agent, body, loggerLike(exec))
                        : 'no-session';
                }
                else {
                    r = await wakeSessionAgent(manager, sid2, loggerLike(exec), body);
                }
                let extra = '';
                if (one.send_qq !== false) {
                    extra = await sendQQWithMedia(manager, sc, peer, body, String(one.media || ''), exec);
                }
                return `${map[r] ?? r} (${sid2.slice(0, 8)}…)${extra}`;
            };
            // batch 优先(2026-09-10 主人: 多参数=一次多个会话各发不同文本)
            if (Array.isArray(args.batch) && args.batch.length > 0) {
                const results = [];
                for (const item of args.batch) {
                    if (!item || typeof item !== 'object') {
                        results.push('❌ batch 项无效');
                        continue;
                    }
                    try {
                        results.push(await sendOne(item));
                    }
                    catch (e) {
                        results.push(`❌ 发送异常: ${String(e?.message || e)}`);
                    }
                }
                return { ok: results.every((x) => x.startsWith('✅')), msg: `批量 ${results.length} 条:\n` + results.map((x, i) => `${i + 1}. ${x}`).join('\n') };
            }
            const oneR = await sendOne(args);
            return { ok: oneR.startsWith('✅'), msg: oneR };
        },
    });
    const muteStateTool = defineTool({
        name: 'group_mute_state',
        description: '群管理(读): 查看当前群禁言状态(全员模式 + 正在禁言中的成员及到期时间)。仅主人要求时调用。',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(**可选**：不填=当前会话所在的群；跨群操作才传)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启或非群会话' };
            const gid = String(args.gid ?? '').trim() || ga.gid || latestGroupId();
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid, 无法确定目标群' };
            const r = await ga.client.getMuteState(gid);
            if (!r.ok)
                return { ok: false, msg: r.err.human };
            const mode = r.data.global_rule?.mode ?? 'none';
            const members = r.data.members ?? [];
            const lines = members.map((m) => `${m.username ?? String(m.member_openid).slice(0, 10)}… 禁言至 ${m.mute_expire_at ?? '?'}`);
            return { ok: true, msg: `全员禁言: ${mode === 'always' ? '开启' : mode === 'schedule' ? '定时' : '关闭'}\n禁言中 ${members.length} 人:\n${lines.length ? lines.join('\n') : '(无)'}` };
        },
    });
    /**
     * 撤回群消息（2026-10-20 主人需求）: 官方允许**群管理员撤回普通成员的消息**（窗口 2 分钟）。
     * msgId 来源 = 入站时记进 msg-recent 的内存缓冲（bootstrap），这里按「成员 / 最近一条」取。
     * 不新增落盘台账；缓冲只保留最近 2 分钟（容量上限 50 条），重启即清空。
     */
    const groupRecallTool = defineTool({
        name: 'group_recall',
        description: '群管理(写,危险): 撤回群消息(机器人是群管理员时可撤**普通成员**的消息; 官方窗口 2 分钟)。'
            + '\nmember=按成员 openid 撤其最近一条; 不传 member=撤群里最近一条; 也可直接给 msg_id。'
            + '\nmsgId 来自入站内存缓冲(只记最近 2 分钟/50 条, 重启清空)。仅主人明确要求时调用。'
            + '\n示例: {member:"<openid>"} / {msg_id:"ROBOT1.0_xxx"}',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(**可选**：不填=当前会话所在的群；只有要操作别的群(机器人也是那个群的管理员)时才传)' },
            member: { type: 'string', description: '成员 openid(可选): 撤该成员最近一条' },
            msg_id: { type: 'string', description: '直接指定 message_id(可选, 优先于 member)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启或非群会话' };
            const gid = String(args.gid ?? '').trim() || ga.gid || latestGroupId();
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid, 无法确定目标群' };
            let msgId = String(args.msg_id ?? '').trim();
            let who = '';
            if (msgId === '') {
                const member = String(args.member ?? '').trim();
                const rec = latestMsgHistory('group', gid, { senderId: member || undefined, withinMs: 120_000 });
                if (!rec) {
                    return {
                        ok: false,
                        msg: member
                            ? '没找到该成员 2 分钟内的消息（msgId 只存在内存缓冲里，重启会清空；也可能超时了）'
                            : '群里 2 分钟内没有记录到可撤回的消息',
                    };
                }
                msgId = rec.id;
                who = rec.n || rec.s;
            }
            const r = await ga.client.recallMessage(gid, msgId, 'group');
            if (!r.ok)
                return { ok: false, msg: r.err.human };
            return { ok: true, msg: `✅ 已撤回${who ? ` ${who} 的` : ''}消息（msg_id=${msgId.slice(0, 18)}…）` };
        },
    });
    /**
     * 消息搜索（2026-10-20 主人需求）: 在「最近 2 分钟消息缓冲」里搜消息（**包含机器人自己发的**）。
     * 返回的 msg_id 可直接喂给 group_recall_batch。
     */
    const msgSearchTool = defineTool({
        name: 'group_msg_search',
        description: '群管理(读): 在最近 2 分钟的消息缓冲里按关键词/类型搜消息（**含机器人自己发的**），返回 msg_id 供 group_recall_batch 批量撤回。'
            + '\n缓冲不落盘、重启清空，只覆盖最近 2 分钟（官方撤回窗口）。',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(**可选**：不填=当前会话所在的群；只有要操作别的群(机器人也是那个群的管理员)时才传)' },
            keyword: { type: 'string', description: '关键词(子串匹配正文; 不填=不筛)' },
            kind: { type: 'string', enum: ['text', 'image', 'voice', 'video', 'file'], description: '消息类型筛选(可选)' },
            from_self: { type: 'boolean', description: 'true=只搜机器人自己发的; false=只搜别人发的; 不填=都搜' },
            limit: { type: 'integer', description: '最多返回条数(默认 20, 上限 50)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启或非群会话' };
            const gid = String(args.gid ?? '').trim() || ga.gid || latestGroupId();
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid' };
            const list = readMsgHistory('group', gid, {
                keyword: args.keyword ? String(args.keyword) : undefined,
                kind: (args.kind ? String(args.kind) : undefined),
                fromSelf: typeof args.from_self === 'boolean' ? args.from_self : undefined,
                limit: Number(args.limit) || 20,
            });
            if (list.length === 0)
                return { ok: true, msg: '台账里没有命中的消息（默认只查最近 2 小时）。' + historyDebug('group', gid) };
            const lines = list.map((m, i) => `${i + 1}. ${m.me ? '🤖' : '👤'}${m.n || m.s} [${m.k ?? 'text'}] ${m.x || '(无正文)'}｜id=${String(m.id).slice(0, 16)}…｜${new Date(m.t).toLocaleTimeString('zh-CN')}`);
            return {
                ok: true,
                msg: `命中 ${list.length} 条（默认最近 2 小时）:\n${lines.join('\n')}\n→ 用 group_recall_batch 传 msg_ids 批量撤回（也可以直接给它 keyword/kind 让它自己挑）`,
            };
        },
    });
    /**
     * 批量撤回 + 可选批量禁言（2026-10-20 主人需求）
     */
    /**
     * 自动撤回关键词管理（2026-10-20 主人要求：让 AI 自己维护"命中即撤/禁言"的关键词）。
     * 直接读写当前 profile 的 settings json，改完 live 生效（中间件读的是盘上兜底）。
     */
    const recallKeywordsTool = defineTool({
        name: 'recall_keywords',
        description: '自动撤回关键词管理(写): 查看/添加/删除「命中即撤回(可顺带禁言)」的关键词。全局规则(不分群)。' +
            '\naction: list(默认) / add(追加) / remove(删除) / set(整体替换) / clear(清空)' +
            '\nwords: 关键词, 多个用逗号/顿号/换行分隔' +
            '\nmuteSeconds/enable: 可选, 一起改「命中后禁言秒数」和「是否启用」；不传就不动' +
            '\n改完立刻生效(live)，不需要重启。',
        parameters: {
            action: { type: 'string', description: 'list / add / remove / set / clear', enum: ['list', 'add', 'remove', 'set', 'clear'] },
            words: { type: 'string', description: '关键词(多个用逗号/顿号/换行分隔)' },
            muteSeconds: { type: 'integer', description: '可选: 命中后顺带禁言秒数(0=不禁言); 不传则不改' },
            enable: { type: 'boolean', description: '可选: 同时开启/关闭自动撤回; 不传则不改' },
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, msg: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } },
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? String(v.msg || '') : `失败: ${String(v.msg || '')}` }],
        },
        execute: async (args) => {
            try {
                const prof = process.env.DSH_PROFILE || 'web';
                const base = join(homedir(), '.dsh', 'qqbot-settings', prof);
                let file = join(base, 'im-qqbot-2.json');
                if (!existsSync(file)) {
                    const cands = existsSync(base) ? readdirSync(base).filter((f) => /^im-qqbot-.*\.json$/.test(f)) : [];
                    if (cands.length === 0)
                        return { ok: false, msg: '找不到设置文件: ' + base, keywords: [] };
                    cands.sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs);
                    file = join(base, String(cands[0]));
                }
                const raw = JSON.parse(readFileSync(file, 'utf8'));
                const ga = (raw.groupAdmin = (raw.groupAdmin || {}));
                const ar = (ga.autoRecall = Object.assign({ enabled: false, mode: 'keep', keywords: [], kinds: [], muteSeconds: 0, dryRun: false }, (ga.autoRecall || {})));
                let list = Array.isArray(ar.keywords) ? ar.keywords.map(String) : [];
                const action = String(args.action || 'list');
                const words = String(args.words || '').split(/[,，、\r\n]+/u).map((x) => x.trim()).filter(Boolean);
                if (action === 'add') {
                    if (words.length === 0)
                        return { ok: false, msg: 'add 需要 words', keywords: list };
                    const set = new Set(list);
                    for (const w of words)
                        set.add(w);
                    list = Array.from(set);
                }
                else if (action === 'remove') {
                    if (words.length === 0)
                        return { ok: false, msg: 'remove 需要 words', keywords: list };
                    const rm = new Set(words);
                    list = list.filter((w) => !rm.has(w));
                }
                else if (action === 'set') {
                    list = words;
                }
                else if (action === 'clear') {
                    list = [];
                }
                ar.keywords = list;
                if (typeof args.muteSeconds === 'number')
                    ar.muteSeconds = Math.max(0, Math.round(args.muteSeconds));
                if (typeof args.enable === 'boolean')
                    ar.enabled = args.enable;
                writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
                const head = action === 'list' ? '当前关键词' : '已更新';
                return {
                    ok: true,
                    msg: head + '(' + list.length + ' 个, 启用=' + String(ar.enabled === true) + ', 禁言=' + String(ar.muteSeconds || 0) + 's): ' + (list.join(' / ') || '(空)'),
                    keywords: list,
                };
            }
            catch (e) {
                return { ok: false, msg: '操作失败: ' + (e instanceof Error ? e.message : String(e)), keywords: [] };
            }
        },
    });
    /** 踢人（2026-10-20：平台已开放「移除群成员」，主人实测授权后加的写工具） */
    const kickMemberTool = defineTool({
        name: 'group_kick',
        description: '群管理(写,危险): 把成员移出群(踢人)，可批量 ≤20。需机器人是群管理员、且平台后台勾选了「移除群成员」。**仅主人明确要求时调用**。不填 gid = 当前会话所在的群。',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(可选; 不填=当前会话所在的群)' },
            member_openids: { type: 'array', items: { type: 'string' }, description: '要移出的成员 openid(≤20 个)' },
            add_to_blacklist: { type: 'boolean', description: '同时加入成员黑名单(默认 false)' },
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, msg: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_a, v) => [
                { type: 'text', text: v.ok ? String(v.msg || '') : '失败: ' + String(v.msg || '') },
            ],
        },
        execute: async (args, exec) => {
            try {
                const ga = groupAdminOf(exec);
                if (!ga)
                    return { ok: false, msg: '群管理未开启或非群会话' };
                const gid = String(args.gid ?? '').trim() || ga.gid || latestGroupId();
                if (!gid)
                    return { ok: false, msg: '当前不是群会话且未指定 gid' };
                const ids = (Array.isArray(args.member_openids) ? args.member_openids : [])
                    .map((x) => String(x).trim())
                    .filter(Boolean)
                    .slice(0, 20);
                if (ids.length === 0)
                    return { ok: false, msg: 'member_openids 为空' };
                // ApiResult 失败结构是 { ok:false, err:{ code, human } }
                const r = (await ga.client.removeMembers(gid, ids, args.add_to_blacklist === true));
                if (r?.ok !== true) {
                    const code = String(r?.err?.code || '');
                    const human = String(r?.err?.human || '');
                    return {
                        ok: false,
                        msg: '踢人失败: ' + (human || code || '(平台无返回)') + (code ? ' [code=' + code + ']' : '') +
                            '（常见原因: 平台未勾选该权限 / 机器人非管理员 / 对方是群主或管理员）',
                    };
                }
                const failN = Array.isArray(r.data?.add_to_member_blacklist_fail_openids)
                    ? r.data.add_to_member_blacklist_fail_openids.length
                    : 0;
                return {
                    ok: true,
                    msg: '✅ 已提交移出 ' + ids.length + ' 人' + (failN > 0 ? '；加黑名单失败 ' + failN + ' 人' : ''),
                };
            }
            catch (e) {
                return { ok: false, msg: '踢人异常: ' + (e instanceof Error ? e.message : String(e)) };
            }
        },
    });
    /** 素材管理（2026-10-21 新接口 /v2/media-images/*：本地图 → qqbot-media:// 引用串） */
    function anyAdminOf(exec) {
        try {
            const s = findSessionRec(channelOf(exec), exec);
            const client = s?.ch?.manager?.groupAdmin;
            const root = String(s?.ch?.manager?.config?.dataRoot ?? '');
            if (client)
                return { client, dataRoot: root };
            for (const b of channelBridges) {
                try {
                    const c = b.manager.groupAdmin;
                    if (c)
                        return { client: c, dataRoot: String(b.manager.config?.dataRoot ?? '') };
                }
                catch { /* 跳过坏桥 */ }
            }
            return undefined;
        }
        catch {
            return undefined;
        }
    }
    const materialTool = defineTool({
        name: 'qq_material',
        description: 'QQ 素材管理(Markdown 图片): 把**本地图片**传到 QQ 平台换 qqbot-media:// 引用串，可直接写进 markdown 消息（不再需要公网图床）。限制: 单张 ≤10MB、png/jpeg/gif/webp、单机器人最多 100 张、图片滑动过期 90 天(每次被引用顺延)。action=upload 传图 / list 看已传列表 / delete 删除释放配额。',
        parameters: {
            action: { type: 'string', enum: ['upload', 'list', 'delete'], description: '默认 upload' },
            image: { type: 'string', description: 'upload: 本地图片绝对路径' },
            image_id: { type: 'string', description: 'delete: 图片 ID（list 里能看到）' },
            cursor: { type: 'string', description: 'list: 翻页游标（首页不传）' },
        },
        output: {
            schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, msg: { type: 'string' }, url: { type: 'string' }, markdown: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: String(v.msg || (v.ok ? 'ok' : '失败')) }],
        },
        execute: async (args, exec) => {
            const mat = anyAdminOf(exec);
            if (!mat)
                return { ok: false, msg: '拿不到机器人实例（没有已连接的本）' };
            const target = { apiCall: mat.client.apiCall.bind(mat.client) };
            const action = String(args.action ?? 'upload').trim() || 'upload';
            if (action === 'upload') {
                const r = await uploadMarkdownImage(target, String(args.image ?? '').trim());
                if (!r.ok)
                    return { ok: false, msg: '上传失败: ' + String(r.msg || '') };
                const name = String(args.image ?? '').split(/[\\/]/).pop() || 'image';
                const dim = r.width && r.height ? ' #' + r.width + 'px #' + r.height + 'px' : '';
                const markdown = '![' + name + dim + '](' + String(r.url) + ')';
                const head = (r.cached ? '✅ 命中本地缓存，未重复上传' : '✅ 已上传')
                    + '（' + Math.round((r.bytes ?? 0) / 1024) + 'KB'
                    + (r.width ? '，' + r.width + '×' + r.height : '') + '）';
                return { ok: true, url: String(r.url), markdown, msg: head + '\n' + markdown };
            }
            if (action === 'list') {
                const r = await listMarkdownImages(target, String(args.cursor ?? ''));
                if (!r.ok)
                    return { ok: false, msg: '查询失败: ' + String(r.msg || '') };
                const d = (r.data ?? {});
                const list = Array.isArray(d.images) ? d.images : [];
                const lines = list.slice(0, 20).map((x, i) => {
                    const exp = x.expires_at ? ' | 到期 ' + new Date(Number(x.expires_at) * 1000).toISOString().slice(0, 10) : '';
                    return i + 1 + '. ' + String(x.file_name || '?') + ' | ' + String(x.image_id || '') + exp;
                });
                const more = d.next_cursor ? '（还有下一页，cursor=' + d.next_cursor + '）' : '';
                return {
                    ok: true,
                    msg: '共 ' + String(d.total ?? list.length) + ' 张' + more + (lines.length ? '\n' + lines.join('\n') : '\n（列表为空）'),
                };
            }
            if (action === 'delete') {
                const id = String(args.image_id ?? '').trim();
                if (!id)
                    return { ok: false, msg: 'delete 需要 image_id' };
                const r = await deleteMarkdownImage(target, id);
                return r.ok
                    ? { ok: true, msg: '✅ 已删除 ' + id + '（配额已释放；已发出的消息不受影响）' }
                    : { ok: false, msg: '删除失败: ' + String(r.msg || '') };
            }
            return { ok: false, msg: '未知 action: ' + action + '（可选 upload / list / delete）' };
        },
    });
    const recallBatchTool = defineTool({
        name: 'group_recall_batch',
        description: '群管理(写,危险): 批量撤回消息 + 可选批量禁言发送者。'
            + '\n① msg_ids 直接给要撤的 id 列表; 或 ② 留空并给 keyword/kind，让它从 2 分钟缓冲里自己挑(最多 20 条)。'
            + '\nmute_seconds>0 → 对涉及的**普通成员**批量禁言(机器人自己发的会跳过)。'
            + '\ndry_run=true 只回显要撤哪些、不执行。仅主人明确要求时调用。',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(**可选**：不填=当前会话所在的群；只有要操作别的群(机器人也是那个群的管理员)时才传)' },
            msg_ids: { type: 'array', items: { type: 'string' }, description: '要撤的 message_id 列表(可空: 空则按 keyword/kind 从缓冲挑)' },
            keyword: { type: 'string', description: '按关键词挑(与 msg_ids 二选一)' },
            kind: { type: 'string', enum: ['text', 'image', 'voice', 'video', 'file'], description: '按类型挑(可选)' },
            mute_seconds: { type: 'integer', description: '同时禁言发送者的秒数(0/不填=不禁言)' },
            dry_run: { type: 'boolean', description: 'true=只列出、不执行' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启或非群会话' };
            const gid = String(args.gid ?? '').trim() || ga.gid || latestGroupId();
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid' };
            const brief = (m) => `${m.me ? '🤖' : '👤'}${m.n || m.s} [${m.k ?? 'text'}] ${(m.x ?? '').slice(0, 24)}`;
            let ids = (Array.isArray(args.msg_ids) ? args.msg_ids : []).map((v) => String(v).trim()).filter(Boolean);
            let picked = [];
            if (ids.length === 0) {
                picked = readMsgHistory('group', gid, {
                    keyword: args.keyword ? String(args.keyword) : undefined,
                    kind: (args.kind ? String(args.kind) : undefined),
                    limit: 20,
                }).map((r) => ({ me: r.me, s: r.s, n: r.n, k: r.k, x: r.x, msgId: r.id }));
                ids = picked.map((p) => p.msgId);
            }
            else {
                const all = readMsgHistory('group', gid, { withinMs: 120_000, limit: 200 }).map((r) => ({ me: r.me, s: r.s, n: r.n, k: r.k, x: r.x, msgId: r.id }));
                picked = all.filter((p) => ids.includes(p.msgId));
            }
            ids = ids.slice(0, 20);
            if (ids.length === 0)
                return { ok: false, msg: '没有要撤的消息（台账只查最近 2 分钟窗口，或关键词没命中）' };
            if (args.dry_run === true) {
                return {
                    ok: true,
                    msg: `[dry-run] 将撤回 ${ids.length} 条:\n${picked.slice(0, 20).map((p, i) => `${i + 1}. ${brief(p)}`).join('\n') || ids.join('\n')}`
                        + (Number(args.mute_seconds) > 0 ? `\n并禁言涉及成员 ${Number(args.mute_seconds)} 秒` : ''),
                };
            }
            let ok = 0;
            const errs = [];
            for (const id of ids) {
                const r = await ga.client.recallMessage(gid, id, 'group');
                if (r.ok)
                    ok++;
                else
                    errs.push(`…${id.slice(-6)}: ${r.err.human}`);
                await new Promise((res) => setTimeout(res, 80));
            }
            let muteNote = '';
            const secs = Math.max(0, Math.round(Number(args.mute_seconds) || 0));
            if (secs > 0 && picked.length > 0) {
                const senders = [...new Set(picked.filter((p) => !p.me && /^[0-9A-Za-z]{32}$/u.test(p.s)).map((p) => p.s))].slice(0, 20);
                if (senders.length > 0) {
                    const pad = (n) => String(n).padStart(2, '0');
                    const ex = new Date(Date.now() + secs * 1000);
                    const rfc = `${ex.getFullYear()}-${pad(ex.getMonth() + 1)}-${pad(ex.getDate())}T${pad(ex.getHours())}:${pad(ex.getMinutes())}:${pad(ex.getSeconds())}+08:00`;
                    let mOk = 0;
                    for (const sid of senders) {
                        const mr = await ga.client.setMemberMute(gid, sid, rfc);
                        if (mr.ok)
                            mOk++;
                        await new Promise((res) => setTimeout(res, 120));
                    }
                    muteNote = `\n禁言: ${mOk}/${senders.length} 人成功(${secs} 秒)`;
                }
            }
            const head = `✅ 撤回 ${ok}/${ids.length} 条`;
            const failNote = errs.length ? `\n失败:\n${errs.slice(0, 5).join('\n')}` : '';
            return { ok: ok > 0, msg: `${head}${muteNote}${failNote}` };
        },
    });
    const muteMemberTool = defineTool({
        name: 'group_mute_member',
        description: '群管理(写,危险): 禁言/解除群成员(**可批量, 单次最多 20 人**)。action=mute 禁言(seconds 秒, 默认600); unmute=解除。只能禁普通成员(群主/管理员禁不了)。' +
            '\n想按昵称禁言先用 id_lookup 拿 openid; 仅主人明确要求时调用。' +
            '\n示例: {member_openids:["<openid>"], action:"mute", seconds:600}',
        parameters: {
            gid: { type: 'string', description: '目标群 openid(**可选**：不填=当前会话所在的群；跨群操作才传)' },
            member_openids: { type: 'array', items: { type: 'string' }, required: true, description: '目标成员 openid 数组(只禁 1 个也传数组; ≤20 个; 可先用 id_lookup 按昵称查)' },
            action: { type: 'string', required: true, enum: ['mute', 'unmute'], description: 'mute 禁言 / unmute 解除' },
            seconds: { type: 'number', required: true, description: '禁言秒数(mute 时; 不需要可填 600)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args, exec) {
            const ga = groupAdminOf(exec);
            if (!ga)
                return { ok: false, msg: '群管理未开启或非群会话' };
            const gid = String(args.gid ?? '').trim() || ga.gid || latestGroupId();
            if (!gid)
                return { ok: false, msg: '当前不是群会话且未指定 gid, 无法确定目标群' };
            const secs = Math.max(1, Math.min(30 * 86400, Math.round(Number(args.seconds ?? 600))));
            const pad = (n) => String(n).padStart(2, '0');
            const expire = args.action === 'mute' ? new Date(Date.now() + secs * 1000) : null;
            const rfc = expire
                ? `${expire.getFullYear()}-${pad(expire.getMonth() + 1)}-${pad(expire.getDate())}T${pad(expire.getHours())}:${pad(expire.getMinutes())}:${pad(expire.getSeconds())}+08:00`
                : null;
            const all = (Array.isArray(args.member_openids) ? args.member_openids : [])
                .map((v) => String(v).trim()).filter(Boolean)
                .map((v) => (v.startsWith('<@') && v.endsWith('>') ? v.slice(2, -1) : v)) // 容错: 直接贴 <@openid> 也认
                .filter((v, i, arr) => arr.indexOf(v) === i);
            if (all.length === 0)
                return { ok: false, msg: 'member_openids 至少给一个 openid' };
            const ids = all.slice(0, 20); // 官方单次 ≤20 人
            let okCount = 0;
            const errs = [];
            for (const id of ids) {
                const rr = await ga.client.setMemberMute(gid, id, rfc);
                if (rr.ok)
                    okCount++;
                else
                    errs.push(`…${id.slice(-4)}: ${rr.err.human}`);
                if (ids.length > 1)
                    await new Promise((res) => setTimeout(res, 120)); // 略停, 别撞频控
            }
            if (okCount === 0)
                return { ok: false, msg: errs[0] ?? '禁言失败' };
            const over = all.length > 20 ? ` (超出 20 人的 ${all.length - 20} 个已忽略, 请分两次)` : '';
            const failNote = errs.length ? ` · 失败 ${errs.length} 人(${errs.slice(0, 3).join('; ')})` : '';
            return {
                ok: true,
                msg: args.action === 'mute'
                    ? `✅ 已禁言 ${okCount}/${ids.length} 人, ${Math.round(secs / 60)} 分钟后自动解除${failNote}${over}`
                    : `✅ 已解除禁言 ${okCount}/${ids.length} 人${failNote}${over}`,
            };
        },
    });
    /**
     * 昵称/群名 → openid(2026-09-12 主人要求) —— AI 想**主动 @ 一个没 @ 过她的人**、或按名字禁言时,
     * 必须先拿到 openid 才能写出 `<@openid>`。官方「群成员列表」未开放(调用得 11253),
     * 所以数据源是: ①本地群成员台账 `{dataRoot}/表情包/group-members.jsonl`(在群里发过言的人 + 入群申请写入的人)
     * ②群注册表 groups.json(群名 → 群 openid)。
     * ⚠️ 从没发过言、没申请过入群的人查不到 —— 官方不给名单导致的硬限制, 不是 bug。
     */
    const idLookupTool = defineTool({
        name: 'id_lookup',
        description: '按**昵称/群名**查 openid(主动 @ 人、禁言、跨群发消息前用它拿 id)。**支持一次查多个名字**。' +
            '\n数据源: 群注册表(群名) + 本地群成员台账(在群里发过言/申请过入群的人)。' +
            '\n⚠️ 从没发过言、没申请过入群的人查不到(官方群成员列表接口未开放)。' +
            '\n示例: {names:["小云","阿水"]} · {names:["小云"], gid:"<群openid>"} · {names:["测试群"], kind:"group"}',
        parameters: {
            names: { type: 'array', items: { type: 'string' }, required: true, description: '一个或多个昵称/群名片段(最多 10 个; 单个也传数组; 空格分隔=多词全命中)' },
            gid: { type: 'string', description: '限定某个群的成员(可选; 不填=查全部已知群)' },
            kind: { type: 'string', enum: ['member', 'group', 'all'], description: 'member=只查人(默认) / group=只查群 / all=都查' },
            limit: { type: 'number', description: '**每个**名字最多返回几条(1~10, 默认 3)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(args) {
            const raw = Array.isArray(args.names) ? args.names : (args.names ?? args.name);
            const kws = (Array.isArray(raw) ? raw : [raw])
                .map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean).slice(0, 10);
            if (kws.length === 0)
                return { ok: false, msg: 'names 至少给一个昵称' };
            const wantGid = String(args.gid ?? '').trim();
            const kind = String(args.kind ?? 'member');
            const limit = Math.max(1, Math.min(10, Math.round(Number(args.limit ?? 3))));
            const roots = new Set();
            for (const m of managersOf())
                roots.add(m.dataRoot);
            // 群注册表(gid → 群名/最近活跃): 多个 dataRoot 聚合, lastAt 新者胜
            const groups = new Map();
            for (const root of roots) {
                try {
                    const reg = JSON.parse(readFileSync(groupRegistryPath(root), 'utf8'));
                    for (const [gid, v] of Object.entries(reg ?? {})) {
                        const name = String(v?.name ?? '');
                        const lastAt = Number(v?.lastAt ?? 0);
                        const cur = groups.get(gid);
                        if (!cur || lastAt > cur.lastAt)
                            groups.set(gid, { name: name || cur?.name || '', lastAt });
                    }
                }
                catch { /* 该 root 没有注册表 */ }
            }
            // 台账只读一次(按词重复读纯浪费), 按 openid 合并群列表
            const people = new Map();
            if (kind !== 'group') {
                for (const root of roots) {
                    try {
                        for (const m of readGroupMembers(join(root, '表情包'), wantGid || undefined)) {
                            const cur = people.get(m.mid);
                            if (!cur) {
                                people.set(m.mid, { name: m.name ?? '', gids: new Set([m.gid]), lastSeen: m.lastSeen, count: m.count });
                                continue;
                            }
                            cur.gids.add(m.gid);
                            if (m.lastSeen > cur.lastSeen) {
                                cur.lastSeen = m.lastSeen;
                                if (m.name)
                                    cur.name = m.name;
                            }
                            cur.count += m.count;
                        }
                    }
                    catch { /* 无台账则跳过 */ }
                }
            }
            const gName = (gid) => groups.get(gid)?.name || `群…${gid.slice(-4)}`;
            const out = [];
            for (const kw of kws) {
                let hit = 0;
                if (kind !== 'group') {
                    const matched = [...people.entries()]
                        .filter(([, v]) => v.name.toLowerCase().includes(kw))
                        .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
                        .slice(0, limit);
                    for (const [mid, v] of matched) {
                        out.push(`${v.name} ${mid}  在: ${[...v.gids].map(gName).join(', ')}`);
                        hit++;
                    }
                }
                if (kind !== 'member') {
                    for (const [gid, v] of groups) {
                        if (hit >= limit)
                            break;
                        if (!v.name.toLowerCase().includes(kw))
                            continue;
                        out.push(`群 ${v.name} ${gid}`);
                        hit++;
                    }
                }
                if (hit === 0)
                    out.push(`${kw} → 没查到(台账只记发过言 / 申请过入群的人)`);
            }
            return { ok: true, msg: out.join('\n') };
        },
    });
    // tools_reload: 热刷新 QQ 通道工具(2026-09-08, 主人建议)——AI 自己写完扩展工具后,
    // 调本工具即可让新扩展注册进当前会话(等价于 /tools-reload 斜杠), 不再依赖主人手发。
    const toolsReloadTool = defineTool({
        name: 'tools_reload',
        description: '热刷新 QQ 通道工具与扩展命令: 重新扫描扩展目录(.qqbot-extensions 的 tools 与 commands)并重载内置工具。写完/更新扩展工具或扩展命令后调用一次, 下条消息即可用新工具(等价于 /tools-reload)。开发/装配用, 平时不需要调。',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
        },
        async execute(_args, exec) {
            const sess = findSessionRec(channelOf(exec), exec);
            if (!sess)
                return { ok: false, msg: '未找到当前 QQ 会话(通道未就绪), 请稍后重试' };
            try {
                const summary = await sess.ch.manager.reloadAllChannelTools();
                return { ok: true, msg: summary };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    // quote_view: 查看引用内容(2026-09-13 主人定, 省 token) ——
    //   引用原文超过 60 字时, 入站上下文只给**前 60 字**, 全文落在
    //   `{dataRoot}/.qqbot/quote-cache.json`(**每会话最多 10 条**), 需要时用本工具取完整原文。
    //   ⚠️ 工具描述**刻意写四个字**(主人要求): 描述进 system prompt, 越短越省。
    const quoteViewTool = defineTool({
        name: 'quote_view',
        description: '查看引用内容',
        parameters: {
            idx: { type: 'integer', description: '引用编号(默认最新一条)' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    msg: { type: 'string', required: true },
                    text: { type: 'string' },
                },
            },
            render: (_a, v) => [
                { type: 'text', text: v.ok ? (v.text || '') : `查询失败: ${v.msg}` },
            ],
        },
        async execute(args, exec) {
            try {
                const s = findSessionRec(channelOf(exec), exec);
                const mgr = s?.ch?.manager;
                const rec = s?.rec;
                const dataRoot = String(mgr?.dataRoot || '');
                if (!dataRoot || !rec?.scope || !rec?.peerId)
                    return { ok: false, msg: '未找到当前 QQ 会话' };
                const rawIdx = args.idx;
                const idx = typeof rawIdx === 'number' && Number.isFinite(rawIdx) ? rawIdx : undefined;
                const e = getQuote(dataRoot, `${rec.scope}:${rec.peerId}`, idx);
                if (!e)
                    return { ok: false, msg: '没有缓存的引用(短引用不缓存; 或这条引用是更早的、已被 10 条上限挤掉)' };
                return { ok: true, msg: `引用#${e.id}`, text: `引用#${e.id}${e.sender ? `（${e.sender}）` : ''}: ${e.text}` };
            }
            catch (err) {
                return { ok: false, msg: err instanceof Error ? err.message : String(err) };
            }
        },
    });
    // people_memo: 群友小传（2026-09-13 主人定）—— 文字版好感度的本体。
    //   记一行(同一人一天最多一条) / 查看 / 删除（群里一句"别记人家"就删）。描述刻意写短。
    const peopleMemoTool = defineTool({
        name: 'people_memo',
        description: '群友小传: 记一行/查看/删除。当群友说出自己的喜好/经历/身份等"旁人能复述的事实"时, 顺手记一条(同一人一天最多 3 条); 想归到八栏就带前缀, 如"喜好：最近在玩XX"(不带前缀则进记事区); 只写事实, 不写评价与猜测',
        parameters: {
            who: { type: 'string', required: true, description: '群友昵称或 openid' },
            line: { type: 'string', description: '要记的一行; 不传=只看' },
            del: { type: 'boolean', description: 'true=删掉这个人的小传' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.msg }],
        },
        async execute(args, exec) {
            try {
                const a = args;
                const s = findSessionRec(channelOf(exec), exec);
                const mgr = s?.ch?.manager;
                const rec = s?.rec;
                const dataRoot = String(mgr?.dataRoot || '');
                if (!dataRoot)
                    return { ok: false, msg: '未找到当前会话的数据根' };
                // who → openid: 优先在群成员台账里按昵称找
                let key = String(a.who || '').trim();
                if (!/^[0-9A-Fa-f]{16,}$/.test(key) && rec?.scope === 'group' && rec.peerId) {
                    try {
                        const dataDir = join(dataRoot, '表情包');
                        const mems = readGroupMembers(dataDir, rec.peerId) || [];
                        const hit = mems.find((m) => m && m.name === key) || mems.find((m) => m && typeof m.name === 'string' && m.name.includes(key));
                        if (hit && hit.mid)
                            key = hit.mid;
                    }
                    catch { /* 用昵称兜底当 key */ }
                }
                if (a.del) {
                    const r = deleteMemo(dataRoot, key);
                    return { ok: r.ok, msg: r.ok ? '好, 已经把 ' + a.who + ' 那份小传删掉了, 以后也不记他' : r.msg };
                }
                if (a.line) {
                    const r = appendMemoLine(dataRoot, key, a.line, { name: a.who, force: false });
                    return { ok: r.ok, msg: r.ok ? '记下了: ' + a.line.slice(0, 60) : r.msg };
                }
                const cur = readMemo(dataRoot, key);
                if (cur)
                    return { ok: true, msg: cur.slice(0, 1200) };
                const all = listMemos(dataRoot);
                return { ok: true, msg: '还没有 ' + a.who + ' 的小传。现有 ' + all.length + ' 份: ' + all.slice(0, 8).map((x) => x.key).join(', ') };
            }
            catch (e) {
                return { ok: false, msg: e instanceof Error ? e.message : String(e) };
            }
        },
    });
    // 逐个注册并记录结果(便于线上定位是哪个工具失败)
    // 供 syncContextTools 动态挂载用（apply 早于 pre-step，填好即可）
    // ⚠️ 2026-10-07 修（主人实测："明明没开无上下文模式，也冒出 context_compact / context_drop /
    //   context_memo 三个工具"）：
    //   这里原来写死 `syncContextTools(ctx, true)` ⇒ 把三个上下文工具**无条件**注册进了**插件作用域**；
    //   而真正按会话开关裁决的是 pre-step 那次（作用在 **agent 作用域**）—— **两次是不同对象**，
    //   所以"开则保持、关则注销"压根够不到 apply 这一份 ⇒ **没开的会话也能调用**（与设计
    //   "只在「无上下文模式+智能判断」开启时出现"冲突）。
    //   现在传 false：插件作用域不再预注册这三个工具（②段的 QQ 群管理工具照旧挂，语义不变），
    //   三者完全交给 pre-step 按会话裁决 —— 开了的会话照挂，没开的会话真的没有。
    //   ⛔ 别再改回 true：那等于给所有会话开后门。
    //   代价：插件作用域不再"提前"备一份，开启的会话若在极早期回合看不到工具，等下一个 step
    //   （pre-step 每个 step 都跑）即出现 —— 比"人人都有"划算得多。
    // ⚠️ 2026-10-09 **第二次修正**（实测抓到；主人定的"注册不动 + 实时剪枝"要落地必须这样）：
    //   ⛔ **不要在这里注册那三个上下文工具** —— 本函数是"每会话"被调用的
    //      （session-manager 传进来的是 **agentCtx**），在这儿 register 等于注册进**该 agent 作用域**；
    //      而 `restrict({deny})` 按宿主文档**只过滤"继承来的"（全局层 + 祖先层）工具，
    //      管不到本作用域自己注册的** ⇒ 剪枝永远打空
    //      （trace 原话：`restrict 失败: names unknown global tools "context_memo","context_compact","context_drop"`）。
    //   ✅ 全局注册统一交给 session-manager 的 pre-step 用**插件根 ctx** 做：
    //      `ensureContextToolsGlobal(this.ctx)` —— 它内部用 `ctx.get('tools')` 取服务，绕开 inject 限制。
    //   这里只保留下面 ②段"QQ 群管理工具"的按会话注册（那本来就是会话级工具）。
    const toolDefs = [
        { name: 'send_media', tool: sendMediaTool },
        { name: 'recall_message', tool: recallTool },
        { name: 'text_break', tool: textBreakTool },
        { name: 'quote_view', tool: quoteViewTool },
        { name: 'people_memo', tool: peopleMemoTool },
        // 无上下文模式·智能判断专用（全局开关 config.contextlessSmart 开启时才出现）
        ...(getContextlessSmartGlobal() === true
            ? []
            : []),
        { name: 'tools_reload', tool: toolsReloadTool },
        { name: 'reply_gate', tool: replyGateTool },
        { name: 'outbound_mode', tool: outboundModeTool },
        { name: 'group_join_requests', tool: listJoinRequestsTool },
        { name: 'group_approve_join', tool: approveJoinTool },
        { name: 'group_join_auto', tool: autoApproveJoinTool },
        { name: 'group_mute_state', tool: muteStateTool },
        { name: 'group_mute_member', tool: muteMemberTool },
        { name: 'group_recall', tool: groupRecallTool },
        { name: 'group_msg_search', tool: msgSearchTool },
        { name: 'group_recall_batch', tool: recallBatchTool },
        { name: 'recall_keywords', tool: recallKeywordsTool },
        { name: 'group_kick', tool: kickMemberTool },
        { name: 'qq_material', tool: materialTool },
        { name: 'id_lookup', tool: idLookupTool },
        { name: 'session_list', tool: sessionListTool },
        { name: 'session_wake', tool: sessionWakeTool },
        { name: 'broadcast_send', tool: broadcastSendTool },
        { name: 'target_group', tool: targetGroupTool },
        { name: 'list_stickers', tool: listStickersTool },
        { name: 'sticker_tag', tool: tagStickerTool },
        { name: 'sticker_delete', tool: deleteStickerTool },
        { name: 'sticker_restore', tool: restoreStickerTool },
        { name: 'sticker_stats', tool: statsStickerTool },
        { name: 'sticker_untagged', tool: untaggedStickerTool },
        { name: 'schedule_timer', tool: scheduleTimerTool },
        { name: 'schedule_cancel', tool: scheduleCancelTool },
    ];
    for (const t of toolDefs) {
        try {
            ctx.tools.register(t.tool);
            ctx.logger?.info?.(`[channel-tools] 已注册: ${t.name}`);
            diag(`注册成功: ${t.name}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // 重复注册(already registered)= 幂等全量重跑的正常现象, 静默跳过不刷日志
            if (/already registered/i.test(msg)) {
                diag(`注册幂等跳过(已存在): ${t.name}`);
                continue;
            }
            ctx.logger?.warn?.(`[channel-tools] 注册失败 ${t.name}: ${msg}`);
            diag(`注册失败: ${t.name} → ${msg}`);
        }
    }
    // ══════════════════════════════════════════════════════════════════════════
    // expose:'all' 支撑（2026-10-10 主人定）—— 扩展工具的"跨通道"能力
    // ══════════════════════════════════════════════════════════════════════════
    // 背景：扩展工具的执行体一直靠 `findSessionRec(当前 agent)` 拿 manager/sender，
    //   而这条链**只在 QQ 会话里成立** —— 在 web / 终端会话里调用，manager 是空的，
    //   工具就变成空壳（拿不到 appId，也发不出消息）。
    // 做法：工具文件里声明 `expose: 'all'` 之后 ——
    //   ① 注册名带上**人设 id**（`<name>@<preset>`，如 `send_texts@whale`）标明归属；
    //   ② 执行时注入 `env.qq` = 该人设实例的"QQ 账号包"：
    //      { preset, appId, appSecret, owners, groups[], c2c[], sender,
    //        sendText / sendMarkdown / sendImage, apiCall }
    //      ⇒ 非 QQ 会话也能把消息发进**指定的群 / 私聊**。
    // 不声明 expose 的工具**行为完全不变**（向后兼容）。
    // ⚠️ 安全性：这些参数只交给本机 `.qqbot-extensions/tools/*.mjs`（主人自己写的代码），
    //    与内置工具同权限；别把它当成"对外暴露的口子"。
    // ── P4.2 用户扩展工具: 扫描 {cwd}/.qqbot-extensions/tools/ 并注册 ──
    // 扩展文件 run(args, env) 可拿: { cwd, manager, sender, replyTarget, logger }
    // (调用方 session-manager 已 await mountChannelTools, 此处 await 加载不影响时序)。
    try {
        const qqCh = (() => {
            try {
                return ctx.get?.('qqChannel');
            }
            catch {
                return undefined;
            }
        })();
        // 扫描根解析: 扩展目录挂在插件数据根(dataRoot=config.dataRoot||cwd), 与工作区其他文件分离。
        //  ①agent ctx qqChannel; ②全局桥(热刷/自愈路径 ctx 可能无 qqChannel); ③ctx.cwd; ④进程 cwd
        const bridgeCh = channelBridges.length ? channelBridges[channelBridges.length - 1] : undefined;
        const extRoot = qqCh?.manager?.dataRoot
            || bridgeCh?.manager?.dataRoot
            || qqCh?.manager?.cwd
            || bridgeCh?.manager?.cwd
            || ctx.cwd
            || process.cwd();
        const workCwd = qqCh?.manager?.cwd
            || bridgeCh?.manager?.cwd
            || ctx.cwd
            || process.cwd();
        const defs = await loadExtensionTools(extRoot, (ctx.logger ?? console));
        extDiag(`apply extRoot=${extRoot} defs=${defs.length} qqCh=${!!qqCh} bridge=${!!bridgeCh}`);
        // ── 同名扩展工具「热替换」(2026-09-15 主人踩坑后加) ──────────────────────
        //  症状: 改**已有**扩展工具的逻辑 → tools_reload 报"完成"，但跑的还是旧实现
        //        （dsh 的 registry 对重名直接抛 'already registered'，这里只能 catch 跳过）。
        //  根因: 上一版只"新增"，没有回收入口。而 `ctx.tools.register()` 其实**返回 disposer**
        //        （dsh-tools 的 `register(definition): () => void`）→ 先 dispose 旧的再注册新的即可。
        //  ⚠️ disposer 不能存在模块变量里: 热刷是用 `?hot=<ts>` 重新 import 本模块的，
        //     新模块的模块级 Map 是空的、认不出上次注册的东西 → 必须存在 **globalThis 上的
        //     WeakMap(ctx)** 才跨模块实例可见（也顺带不污染 ctx 对象）。
        //  安全边界: 只 dispose"我们自己注册过、且名字对得上"的工具；别人注册的同名工具照旧走
        //     原来的 catch 跳过分支（行为不变）。
        const disposeStore = (() => {
            const g = globalThis;
            const KEY = Symbol.for('im-qqbot.extToolDisposers');
            let store = g[KEY];
            if (!store) {
                store = new WeakMap();
                g[KEY] = store;
            }
            return store;
        })();
        const myDisposers = (() => {
            const k = ctx;
            let m = disposeStore.get(k);
            if (!m) {
                m = new Map();
                disposeStore.set(k, m);
            }
            return m;
        })();
        for (const def of defs) {
            // ★ expose:'all' 的工具**不在这里注册** —— 交给 ensureExtToolsGlobal 挂到插件根
            //   （只有挂到那一层，web / 终端等非 QQ 会话才继承得到；在这儿重复注册的话，
            //    QQ 会话会同时看到「带后缀」和「不带后缀」两套工具）
            // ★ 2026-10-10 修（主人实测抓到）：工具可能被改成 expose:'all'（或改回）⇒
            //   注册名会在「原名 ↔ 原名__人设ID」之间切换。旧名字那份**必须回收**，
            //   否则会同时存在两份同样的工具（同一份 schema 进上下文两次 ⇒ 白占 token）。
            if (def.expose === 'all') {
                const stale = myDisposers.get(def.name);
                if (stale) {
                    try {
                        stale();
                    }
                    catch { /* 旧句柄已失效 */ }
                    myDisposers.delete(def.name);
                    extDiag('回收旧注册(该工具已改为 expose:all): ' + def.name);
                }
                continue;
            }
            try {
                // 注：expose:'all' 的工具已在循环开头 continue（它们由 ensureExtToolsGlobal 全局注册）。
                //     走到这里的都是"只服务 QQ 会话"的工具 ⇒ 名字保持原名，不带 @人设id
                const scopedName = def.name;
                // ⚠️ 兜底闸门（同上）：扩展工具作者若写了中文名，这里直接不注册 —— 别把整条链路带崩
                if (!/^[a-zA-Z0-9_-]+$/.test(scopedName)) {
                    extDiag('跳过非法工具名(中文等): ' + scopedName);
                    continue;
                }
                // 同一个 ctx 再来一遍（热刷）= 更新已有工具：先摘掉我们自己上次注册的那份
                const prev = myDisposers.get(scopedName);
                if (prev) {
                    try {
                        prev();
                    }
                    catch { /* 旧句柄已失效，忽略 */ }
                    myDisposers.delete(scopedName);
                    extDiag(`热替换: 先注销旧 ${def.name}`);
                }
                const tool = defineTool({
                    name: scopedName,
                    description: def.description + ' (用户扩展工具)',
                    parameters: def.inputSchema,
                    output: {
                        schema: {
                            type: 'object', additionalProperties: false,
                            properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
                        },
                        render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : `失败: ${v.msg}` }],
                    },
                    async execute(args, exec) {
                        const sess = findSessionRec(channelOf(exec), exec);
                        const env = {
                            cwd: workCwd, // 注入给扩展工具的工作目录保持 agent cwd(扫描根已用数据根)
                            manager: sess?.ch.manager,
                            sender: sess?.ch.sender,
                            replyTarget: sess?.rec.replyTarget,
                            exec,
                            // ⚠️ 2026-10-01 加：把宿主 ctx 与方法暴露给扩展工具。
                            //   起因（主人需求）：想让扩展工具**自助**调用宿主的上下文压缩
                            //   （`ctx.compaction.compactNow(agent, signal, cmdId)`，用法见 dsh-command-compact），
                            //   并在压缩后把"想说的话"拼回上下文。原来 env 只有
                            //   {cwd, manager, sender, replyTarget, exec}，扩展工具拿不到任何宿主服务，
                            //   只能做"纯本地/纯发消息"的事。
                            //   安全性：与内置工具同等权限（同源于插件自身的 ctx），
                            //   且只对本机文件系统里的 .qqbot-extensions/tools/*.mjs 生效 —— 即"主人自己写的代码"。
                            ctx,
                            logger: ctx.logger,
                        };
                        // ★ 2026-10-06 统一能力包（见 features/ext-capabilities.ts）：
                        //   把「发消息 / 官方 API / 持久化 / 上下文 / 身份」这套**成品能力**也交给扩展工具，
                        //   免得作者为了发一张 markdown 还得专门写一个工具（历史上的 send_md.mjs 就是这个）。
                        //   ⚠️ 只补不覆盖：cwd/manager/sender/replyTarget/exec/ctx/logger 保持原样。
                        try {
                            const mgr = (sess?.ch.manager ?? qqCh?.manager ?? bridgeCh?.manager);
                            const recAny = sess?.rec;
                            const ga = mgr?.groupAdmin;
                            const caps = makeExtCaps({
                                dataRoot: extRoot,
                                logger: ctx.logger,
                                appId: mgr?.config?.appId,
                                appSecret: mgr?.config?.appSecret,
                                owners: (Array.isArray(mgr?.config?.groupAdmin?.owners)
                                    ? mgr.config.groupAdmin.owners.map(String)
                                    : []),
                                // 2026-10-25：按 docs/extension-contract.md §2 补齐 user / peer 命名空间（见下方），
                                //   并额外给一个**顶层 isOwner 布尔值** —— 这是最省事的判据，
                                //   扩展直接 `if (!env.isOwner) return` 即可，不必自己比对 owners 数组。
                                // 2026-10-25：扩展可能从 env.config.appId/appSecret 自取凭证换 token
                                config: { appId: mgr?.config?.appId, appSecret: mgr?.config?.appSecret },
                                isOwner: (Array.isArray(mgr?.config?.owners)
                                    && !!recAny?.senderId
                                    && mgr.config.owners.map(String).includes(String(recAny.senderId))),
                                senderOpenid: recAny?.senderId,
                                userOpenid: recAny?.senderId,
                                openid: recAny?.senderId,
                                // sender 合并而非覆盖：保留原字段（别的扩展可能读 name/card 等）
                                // 额外带上 openid —— 部分扩展按 `ctx.sender.openid` 找发送者
                                sender: ({
                                    ...((sess?.ch.sender && typeof sess.ch.sender === 'object') ? sess.ch.sender : {}),
                                    openid: recAny?.senderId,
                                }),
                                // ★ 2026-10-25：补齐 docs/extension-contract.md §2 承诺的命名空间
                                //   文档写的是 `env.user.openid/name/isOwner` 与 `env.peer.scope/peerId`，
                                //   但实现一直没给 —— 文档声明「本文写的就是当前真实实现」，
                                //   于是照文档写的扩展拿到 undefined（proactive-companion 就栽在这）。
                                user: {
                                    openid: recAny?.senderId,
                                    name: ((sess?.ch.sender && typeof sess.ch.sender === 'object')
                                        ? sess.ch.sender.name
                                        : undefined),
                                    isOwner: (Array.isArray(mgr?.config?.owners)
                                        && !!recAny?.senderId
                                        && mgr.config.owners.map(String).includes(String(recAny.senderId))),
                                },
                                peer: {
                                    scope: recAny?.scope,
                                    peerId: recAny?.peerId,
                                },
                                replyTarget: (recAny?.replyTarget ?? sess?.rec.replyTarget),
                                agent: recAny?.agent,
                                scope: recAny?.scope,
                                peerId: recAny?.peerId,
                                actorOpenid: recAny?.senderId,
                                apiCall: typeof ga?.apiCall === 'function'
                                    ? ((mm, p, b) => ga.apiCall(mm, p, b))
                                    : undefined,
                                selfName: def.name,
                                kind: 'tools',
                                // ★ 内核句柄：把插件的 cordis ctx 原样交给扩展（"遥控器"）
                                kernel: ctx,
                            });
                            for (const [k, v] of Object.entries(caps))
                                if (!(k in env))
                                    env[k] = v;
                            env.caps = caps;
                            // 注：expose:'all' 的工具带 env.qq 的那份在 ensureExtToolsGlobal 里全局注册
                            //     （非 QQ 会话只有继承到那一份才能用），这里不再重复注入。
                        }
                        catch (err) {
                            extDiag(`能力包构造失败(不影响工具本身): ${err instanceof Error ? err.message : String(err)}`);
                        }
                        try {
                            const r = await def.run(args, env);
                            if (r && typeof r === 'object') {
                                // 2026-10-25 兼容三种写法：{ok,msg} / {ok,message} / 裸对象（如 get 直接返回查询结果）
                                //   之前只认 r.msg，导致作者写 {ok:true, message:'已开启'} 也显示成 "已完成: done"，
                                //   而 get 分支返回裸对象时 r.ok 是 undefined → 显示成 "失败: done"。
                                const rr = r;
                                const okFlag = typeof rr.ok === 'boolean' ? rr.ok : !rr.error;
                                const text = rr.msg ?? rr.message ?? rr.error ?? 'done';
                                return { ok: okFlag, msg: String(text) };
                            }
                            return { ok: true, msg: r === undefined || r === null ? 'done' : String(r) };
                        }
                        catch (err) {
                            return { ok: false, msg: err instanceof Error ? err.message : String(err) };
                        }
                    },
                });
                const dispose = ctx.tools.register(tool);
                // 收下 disposer —— 下次(热刷/重装配)靠它做同名替换，不然只能重启宿主
                if (typeof dispose === 'function')
                    myDisposers.set(scopedName, dispose);
                ctx.logger?.info?.(`[channel-tools] 已注册扩展工具: ${scopedName}`);
                diag(`扩展工具注册成功: ${def.name}`);
                extDiag(`注册成功: ${def.name}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (/already registered/i.test(msg)) {
                    extDiag(`already registered: ${def.name}`);
                    continue;
                }
                ctx.logger?.warn?.(`[channel-tools] 扩展工具注册失败 ${def.name}: ${msg}`);
                diag(`扩展工具注册失败: ${def.name} → ${msg}`);
                extDiag(`注册失败: ${def.name} → ${msg}`);
            }
        }
        // ★ 2026-10-24（主人实测驱动）：回收「本轮没扫到」的旧工具。
        //   原实现只在 for(def of defs) 里按名字替换 —— 停用/删除的扩展**不在 defs 里**，
        //   于是它上次注册的 disposer 永远躺在 myDisposers 里不被调用 ⇒ 工具残留在 AI 侧，
        //   表现就是"能热启动、不能热关闭"。这里循环结束后统一比对，多余的统统 dispose。
        try {
            const current = new Set(defs.map((d) => d.name));
            for (const [name, dispose] of [...myDisposers]) {
                if (current.has(name))
                    continue;
                try {
                    dispose();
                }
                catch { /* 旧句柄已失效 */ }
                myDisposers.delete(name);
                extDiag('回收停用/删除的扩展工具: ' + name);
            }
        }
        catch { /* 清理失败不影响主流程 */ }
    }
    catch (err) {
        ctx.logger?.warn?.(`[channel-tools] 扩展工具加载异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
        extDiag(`加载异常: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * host 面板用(2026-09-13 主人要的「让ai写」按钮):
 * **照抄定时任务的做法** —— 伪造一条消息直接调 handleInbound 唤醒该群/私聊的 AI 回合
 * (见 features/scheduler.ts fireTask: 与 SDK 消息同形, messageId 空 → 出站自动走主动推送;
 *  senderName 用中性名、不打假 (@you), 防污染主人交互记忆)。
 *
 * 为什么不复用高层轮子: wakeSessionAgent 要先配"群组管理器会话"; injectSynthetic 是塞聚合窗口(要等人停口);
 *  而面板按钮要的是**立刻触发** —— 与"定时任务到点必须触发回合"同理, 直调 handleInbound 最贴合。
 *
 * host 半边(settings-host.js) 通过 import('@zaofan/dsh-qqbot/channel-tools') 调用(manager 只在插件侧)。
 */
export async function askAiToWriteSamples(ns, scope, peerId) {
    const root = (() => {
        try {
            const managers = managersOf();
            const nsOf = (m) => String(m?.settingsNs ?? '');
            const mgr = managers.find((m) => nsOf(m) === ns) ?? managers[0];
            return String(mgr?.dataRoot ?? '');
        }
        catch {
            return '';
        }
    })();
    const prompt = [
        '【样例库维护】主人点了面板上的「让ai写(有聊天记录最好)」, 请你来维护本地小模型的"开口标准"样例库。',
        `· 样例库(你要写的): ${root}/.qqbot/value-samples.jsonl —— 一行一条 {"m":"群消息文本","y":1} / y=0; 1=你会想接话, 0=你不会理`,
        `· 评分记录(你来读): ${root}/.qqbot/value-scores.jsonl —— 一行一行 JSON, 字段: text=消息原文, score=本地小模型给的分, worth=是否判值得接, min=本会话门槛, gate=当时生效的模式(block=低分不唤醒/log=只记录不拦), conf=置信度(越接近1越有把握), mention=是否被@, top=最近邻样例, agg=聚合条数`,
        '做法: ①读评分记录最近 100~200 条(用文件工具) ②挑出标注可疑的 —— 尤其 conf<0.5(地图上没这类样本)、mention=true 却 worth=false(被点名却没打算回)、内容与分数明显不符的',
        '③对照真人群聊语境, 提炼 20~40 条新样例 ④用文件工具把它们**追加**写入样例库(不要覆盖整库) ⑤回报加了几条、都补了哪类。',
        '样例写法(一行一条 JSON): {"m":"消息文本","y":1或0} —— y=1 她会想接话(提问/求助/@她/她接得住的梗) / y=0 她不会理(群友互聊/短应答/表情)。',
    ].join('\n');
    return askAiToWriteFakeMsg(ns, scope, peerId, '样例库维护', prompt);
}
/**
 * 「伪造一条用户消息 → 直调 handleInbound 唤醒该会话 AI」的共用实现(2026-10-05 抽出来)。
 *
 * 原实现只服务"让ai写样例库"; botplay 自定义事件也要同一条路(面板「🤖 让 AI 写」),
 * 于是把可复用的骨架抽到这里, 只有 senderName/正文不同 —— 两处行为完全一致, 少一套要维护的语义。
 *
 * 细节(继承自 2026-09-13 的样例库版本, 不要改):
 *   · messageId 留空 → 出站自动走**主动推送**(不受 5 条被动回复限制);
 *   · senderName 用中性名、正文不打假 (@you) → 防污染主人交互记忆;
 *   · 与定时任务 fireTask 同姿势(伪造消息唤醒回合), 而不是塞聚合窗口(那个要等人停口)。
 */
export async function askAiToWriteFakeMsg(ns, scope, peerId, senderName, prompt) {
    try {
        const managers = managersOf();
        if (managers.length === 0)
            return { ok: false, msg: '还没有活跃的机器人实例' };
        const nsOf = (m) => String(m?.settingsNs ?? '');
        const mgr = managers.find((m) => nsOf(m) === ns) ?? managers[0];
        if (!mgr)
            return { ok: false, msg: '找不到该机器人实例' };
        if (!peerId)
            return { ok: false, msg: '请先在面板上方选一个群/私聊目标' };
        const cfg = mgr.config;
        if (!cfg)
            return { ok: false, msg: '该实例配置未就绪' };
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const fakeMsg = {
            kind: scope,
            senderId: scope === 'c2c' ? peerId : 'master',
            senderName: String(senderName || '面板任务'),
            content: `[面板任务 ${ts}] ${prompt}`,
            messageId: '',
            timestamp: now.toISOString(),
            groupOpenid: scope === 'group' ? peerId : undefined,
            msgType: 0,
            attachments: undefined,
        };
        const noop = () => { };
        const logger = { info: noop, warn: noop, debug: noop, error: noop };
        await handleInbound(fakeMsg, mgr, cfg, logger, undefined);
        return { ok: true, msg: `已伪造一条消息唤醒 ${scope === 'group' ? '群' : '私聊'} …${peerId.slice(-6)} 的 AI 回合, 稍等她回复 ✧` };
    }
    catch (e) {
        return { ok: false, msg: `异常: ${e instanceof Error ? e.message : String(e)}` };
    }
}
// ── botplay 自定义事件: 面板出口(2026-10-05) ────────────────────────────────
// host 半边(settings-host.js)只能 `import('@zaofan/dsh-qqbot/channel-tools')`, 拿不到 manager/controller;
// 所以自定义事件相关的三件事(模块状态 / 热重载 / 让AI写)都在这里做转发, 与 askAiToWriteSamples
// 「桥只负责递话、实现留在插件侧」同一姿势。
/**
 * 面板用: 某实例的自定义事件模块状态(路径/是否存在/mtime/hooks/加载错误)。
 * 未注册实例返回 [] (面板显示"未就绪", 不报错)。
 */
export function botplayExtStatus(ns) {
    return botplayExtStatusOf(ns);
}
/** 面板「🔄 重载模块」用: 热重载指定模块(空=全部); 不重启宿主 */
export function reloadBotplayExt(ns, file) {
    return reloadBotplayExtOf(ns, file);
}
/**
 * 「让 AI 写」自定义事件: 把拼好的提示词当作**用户消息**唤醒该群/私聊的 AI 回合。
 *
 * 为什么不能用函数参数把提示词传进来: host 半边是**另一份模块实例**(它 import 的是 dist 里的同一份
 * 文件, 但跨模块传函数/大对象容易撞上"参数必须是纯数据"的边界, 也难排查)。
 * 于是照抄 settings-host 里"写样例库"的既有做法 —— 用 setXxxPrompt 先递数据, 再调无参入口。
 *
 * ⚠️ 提示词由 host 现拼(需求原文 + 接口文档索引摘录 + 契约 + 环境信息), 这里只负责"送进去"。
 */
let botplayWritePrompt = '';
export function setBotplayWritePrompt(text) {
    botplayWritePrompt = String(text ?? '');
}
/**
 * 「让 AI 写」自定义事件: 把拼好的提示词当作**用户消息**唤醒该群/私聊的 AI 回合。
 *
 * 提示词由 host 现拼(需求原文 + 官方文档链接 + 自定义事件契约 + 环境信息 + 要求), 这里只负责"送进去"。
 * 参考资料给的是**官方文档链接**(不随包塞本地镜像) —— 理由见 settings-host.js 的 apiV2DocLinks 注释。
 */
export async function askAiToWriteBotplayEvent(ns, scope, peerId) {
    const prompt = botplayWritePrompt;
    if (!prompt.trim())
        return { ok: false, msg: '内部错误: 写作请求内容为空(请重试)' };
    // 借用既有的"伪造一条用户消息唤醒 AI"链路(与「让ai写样例库」完全同一条路, 不新开渠道)
    return askAiToWriteFakeMsg(ns, scope, peerId, 'botplay自定义事件', prompt);
}
/** 每个 agentCtx 已注册的上下文工具 disposer（WeakMap：多会话互不影响） */
const ctxToolDisposers = new WeakMap();
/** 三个上下文工具定义（在 apply() 里赋值 —— 那里才拿得到 defineTool 的产物） */
var contextMemoTool = defineTool({
    name: 'context_memo',
    description: '查看/追加/修改/删除/清空「你自己的备忘」。备忘存在独立文件里，压缩或丢弃历史时**永远不会被丢**；'
        + '用来长期留着跨话题需要记住的事（对方偏好、未完成的事、之前聊过什么）。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['list', 'append', 'edit', 'delete', 'clear'],
            description: 'list=查看全部 / append=追加一条 / edit=改某条 / delete=删某条 / clear=全清',
        },
        text: { type: 'string', description: 'append/edit 时的内容（要留下的要点）' },
        id: { type: 'string', description: 'edit/delete 时的条目 id（先 list 拿到）' },
    },
    output: {
        schema: {
            type: 'object',
            additionalProperties: true,
            properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
        },
        render: (_a, v) => [{ type: 'text', text: String(v?.msg ?? '') }],
    },
    async execute(args, exec) {
        const r = await resolveCtxMemoEnv(exec);
        if (!r)
            return { ok: false, msg: '未找到当前会话，无法读写备忘' };
        const a = (args ?? {});
        const action = String(a.action || 'list');
        try {
            if (action === 'list') {
                const items = listContextMemo(r.dataRoot, r.sessionKey);
                return {
                    ok: true,
                    msg: items.length ? items.map((x) => '[' + x.id + '] ' + x.text).join('\n') : '(备忘是空的)',
                };
            }
            if (action === 'append') {
                const it = appendContextMemo(r.dataRoot, r.sessionKey, String(a.text || ''));
                return it ? { ok: true, msg: '已追加备忘 [' + it.id + ']' } : { ok: false, msg: 'text 不能为空' };
            }
            if (action === 'edit') {
                const ok = editContextMemo(r.dataRoot, r.sessionKey, String(a.id || ''), String(a.text || ''));
                return { ok, msg: ok ? '已修改 [' + String(a.id) + ']' : '没找到该 id，或 text 为空' };
            }
            if (action === 'delete') {
                const ok = deleteContextMemo(r.dataRoot, r.sessionKey, String(a.id || ''));
                return { ok, msg: ok ? '已删除 [' + String(a.id) + ']' : '没找到该 id' };
            }
            if (action === 'clear') {
                const cnt = clearContextMemo(r.dataRoot, r.sessionKey);
                return { ok: true, msg: '已清空 ' + cnt + ' 条' };
            }
            return { ok: false, msg: '未知 action' };
        }
        catch (e) {
            return { ok: false, msg: String(e?.message ?? e) };
        }
    },
});
var contextCompactTool = defineTool({
    name: 'context_compact',
    description: '压缩本会话的上下文：把旧历史压掉、只留最近几条，真正释放 token。'
        + '本工具只**登记**，会在下一个回合开始时执行（回合内无法直接压）。'
        + 'note 参数用来写「压缩后仍然需要记住的要点」——它存进你的备忘，压缩碰不到。',
    parameters: {
        note: { type: 'string', description: '要点：压缩后仍需要记住的信息（会存进备忘）' },
        keep: { type: 'number', description: '保留最近几条消息（默认 3；0 = 全清）' },
    },
    output: {
        schema: {
            type: 'object',
            additionalProperties: true,
            properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
        },
        render: (_a, v) => [{ type: 'text', text: String(v?.msg ?? '') }],
    },
    async execute(args, exec) {
        const r = await resolveCtxMemoEnv(exec);
        if (!r)
            return { ok: false, msg: '未找到当前会话' };
        const a = (args ?? {});
        if (a.note)
            appendContextMemo(r.dataRoot, r.sessionKey, String(a.note));
        writeContextPending(r.dataRoot, r.sessionKey, { mode: 'compact', keep: Number(a.keep) || 3, at: Date.now() });
        return { ok: true, msg: '已登记压缩：下一个回合开始时执行'
                + (a.note ? '（要点已存进你的备忘）' : '（本次没写要点；若压缩后有需要记住的，请带上 note）') };
    },
});
var contextDropTool = defineTool({
    name: 'context_drop',
    description: '丢弃本会话的历史上下文（只留下你自己写的备忘）。话题彻底结束、不再需要原文时用它。'
        + '本工具只**登记**，会在下一个回合开始时执行（回合内无法直接压）。'
        + '调用前请用 note 参数写下要点——它存进你的备忘，丢弃碰不到。',
    parameters: {
        note: { type: 'string', description: '要点：丢弃后仍需要记住的信息（会存进备忘）' },
    },
    output: {
        schema: {
            type: 'object',
            additionalProperties: true,
            properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
        },
        render: (_a, v) => [{ type: 'text', text: String(v?.msg ?? '') }],
    },
    async execute(args, exec) {
        const r = await resolveCtxMemoEnv(exec);
        if (!r)
            return { ok: false, msg: '未找到当前会话' };
        const a = (args ?? {});
        if (a.note)
            appendContextMemo(r.dataRoot, r.sessionKey, String(a.note));
        writeContextPending(r.dataRoot, r.sessionKey, { mode: 'drop', keep: 0, at: Date.now() });
        return { ok: true, msg: '已登记丢弃：下一个回合开始时执行'
                + (a.note ? '（要点已存进你的备忘）' : '（本次没写要点；丢弃后这些历史就找不回来了，建议带 note）') };
    },
});
/**
 * QQ 群管理工具 —— 用主人自己的 QQ 号管理「我创建 / 我管理」的群。
 * 纯 HTTP（qun.qq.com 的 qun_mgr 接口），**不需要浏览器**，新用户装完插件自己扫码就能用。
 * 不受「无上下文」开关影响，永远挂在会话上。
 */
var qunAdminTool = defineTool({
    name: 'qq_group_admin',
    description: '用主人自己的 QQ 号管理群（我创建/我管理的群）：登录、看群列表、查群成员、踢人。'
        + '登录用 action=login —— 会自动开一个隐藏的浏览器去「点头像授权」，有 QQ 登录态时**免扫码直接登**；'
        + '若这台机器上还没有 QQ 登录态，它会出一张二维码，你立刻用 send_media 发给主人扫，再调 action=status 等结果（一次最多等 20 秒，没等到再调）。'
        + '⚠️ 踢人前必须先跟主人确认「哪个群、哪个人」，确认无误后才带 confirmed=true 调用；绝不自己决定踢谁。',
    parameters: {
        action: {
            type: 'string',
            required: true,
            enum: ['status', 'login', 'groups', 'members', 'kick'],
            description: 'status=登录状态/继续等扫码 / login=出二维码 / groups=群列表 / members=查成员 / kick=踢人',
        },
        group: { type: 'string', description: '群号或群名（members/kick 必填；群名支持模糊匹配）' },
        keyword: { type: 'string', description: 'members 用：uin（精确查）或昵称片段' },
        uins: { type: 'string', description: 'kick 用：要踢的 uin，多个用逗号分隔' },
        confirmed: { type: 'boolean', description: 'kick 用：主人已明确同意踢这些人时才传 true' },
    },
    output: {
        schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
                ok: { type: 'boolean', required: true },
                msg: { type: 'string', required: true },
            },
        },
        render: (_a, v) => [{ type: 'text', text: String(v?.msg ?? '') }],
    },
    async execute(args, exec) {
        // 群管理只认数据目录（不要 sessionKey —— pre-step 里它经常是空的）
        const dataRoot = await resolveCtxDataRoot(exec);
        if (!dataRoot)
            return { ok: false, msg: '没找到会话的数据目录，无法读写 QQ 登录凭据' };
        const a = (args ?? {});
        const action = String(a.action || 'status');
        try {
            // ── 登录状态 / 继续等扫码 ──
            if (action === 'status') {
                // ① 浏览器会话还在等（免扫码那条路）→ 先问它
                if (qunLoginSessionAlive(dataRoot)) {
                    const w = await qunBrowserLoginWait(dataRoot, 20000);
                    if (w.cookie) {
                        saveQunCookie(dataRoot, { ...w.cookie, at: Date.now() });
                        return { ok: true, msg: `登录成功（浏览器头像授权），uin=${w.cookie.uin}。可以直接 groups / members / kick 了。` };
                    }
                    return { ok: w.ok, msg: w.msg };
                }
                const c = loadQunCookie(dataRoot);
                if (c && !qunLoginPending(dataRoot)) {
                    return { ok: true, msg: `已登录：uin=${c.uin}（凭据可用）。可以直接 groups / members / kick。` };
                }
                if (qunLoginPending(dataRoot)) {
                    const p = await qunLoginPoll(dataRoot, 20000);
                    if (p.done)
                        return { ok: true, msg: p.msg };
                    return { ok: p.ok, msg: p.msg + '（还没确认就再调一次 status；二维码 3 分钟有效）' };
                }
                return { ok: false, msg: '还没登录。请调 action=login。' };
            }
            // ── 登录：① 先静默无头试（有登录态/有头像就零打扰完成）；② 要扫码就把二维码送上 dsh 网页 ──
            if (action === 'login') {
                const b = await qunBrowserLoginStart(dataRoot, { headless: true });
                if (b.cookie) {
                    saveQunCookie(dataRoot, { ...b.cookie, at: Date.now() });
                    return {
                        ok: true,
                        msg: `免扫码登录成功（静默点头像授权，全程没弹窗口），uin=${b.cookie.uin}。可以直接用 groups / members / kick 了。`,
                    };
                }
                // ⚠️ 需要人扫码时**不要试图弹浏览器窗口**：实测宿主 spawn 的浏览器窗口根本到不了用户桌面
                //   （headless=False 也一样，进程查不到任何可见窗口）。也别发图 —— 用户在手机上收到图
                //   扫不了自己的屏幕。最稳的做法：**直接给出二维码的本地文件路径**，用户在自己电脑上打开它扫。
                if (b.qrPath) {
                    return {
                        ok: true,
                        msg: '需要扫一次码。二维码已经生成到本地文件：\n'
                            + '  ' + b.qrPath + '\n'
                            + '请在**电脑上打开这张图片**（双击它、或用看图软件），然后用手机 QQ 的「扫一扫」，'
                            + '**摄像头对着电脑屏幕**扫 —— 腾讯只认摄像头，用相册或长按识别会被拒绝。'
                            + '扫完调 action=status 等结果。',
                    };
                }
                // ③ 浏览器这条路不通（没装/起不来）→ 退回纯网络二维码（也是同一个本地文件路径）
                const s = await qunLoginStart(dataRoot);
                if (!s.ok || !s.qrPath)
                    return { ok: false, msg: '登录失败：' + b.msg + ' ／ ' + s.msg };
                return {
                    ok: true,
                    msg: '（浏览器方式不可用，已改用纯网络二维码）二维码已生成到本地文件：\n'
                        + '  ' + s.qrPath + '\n'
                        + '在电脑上打开这张图，用手机 QQ 摄像头对着屏幕扫，然后调 action=status 等结果。',
                };
            }
            // 以下都要已登录
            if (!loadQunCookie(dataRoot)) {
                return { ok: false, msg: '还没登录 QQ。先调 action=login 出二维码（再用 send_media 发给主人扫）。' };
            }
            // ── 群列表 ──
            if (action === 'groups') {
                const gs = await qunGroups(dataRoot);
                if (!gs.length)
                    return { ok: true, msg: '我名下没有「我创建/我管理」的群。' };
                return {
                    ok: true,
                    msg: `共 ${gs.length} 个群（群号\t群名\t身份）：\n` + gs.map((g) => `${g.gc}\t${g.gn}\t[${g.role}]`).join('\n'),
                };
            }
            // ── 查成员 ──
            if (action === 'members') {
                const res = await qunResolveGc(dataRoot, String(a.group || ''));
                if (!res.ok)
                    return { ok: false, msg: res.msg };
                const kw = String(a.keyword || '').trim();
                const m = await qunMembers(dataRoot, res.gc, kw || undefined);
                const head = `群 ${res.gc}${res.gn ? '(' + res.gn + ')' : ''} 共 ${m.count ?? '?'} 人`
                    + (kw ? `，命中 ${m.members.length} 人` : `，本次取回 ${m.members.length} 人`) + (m.note || '') + '：';
                const show = m.members.slice(0, 80);
                const body = show.map((x) => `${x.uin}\t${x.nick}`).join('\n');
                const tail = m.members.length > show.length ? `\n…（还有 ${m.members.length - show.length} 人，建议加 keyword 精确查）` : '';
                return { ok: true, msg: m.members.length ? head + '\n' + body + tail : head + '\n(无匹配)' };
            }
            // ── 踢人 ──
            if (action === 'kick') {
                const list = String(a.uins || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
                if (!list.length)
                    return { ok: false, msg: '请给要踢的 uin（uins 参数，多个用逗号分隔）' };
                if (a.confirmed !== true) {
                    return { ok: false, msg: `还没确认：准备踢 ${list.join('、')}。请先跟主人核对「群 + 人」，主人明确同意后再带 confirmed=true 调用。` };
                }
                const res = await qunResolveGc(dataRoot, String(a.group || ''));
                if (!res.ok)
                    return { ok: false, msg: res.msg };
                const rs = await qunKick(dataRoot, res.gc, list);
                const okCnt = rs.filter((x) => x.ec === 0).length;
                return {
                    ok: okCnt > 0,
                    msg: `群 ${res.gc}${res.gn ? '(' + res.gn + ')' : ''} 踢人结果（成功 ${okCnt}/${rs.length}）：\n`
                        + rs.map((x) => `${x.uin}\t${x.ec === 0 ? '✅' : '❌'} ${x.msg}`).join('\n'),
                };
            }
            return { ok: false, msg: '未知 action：' + action };
        }
        catch (e) {
            const msg = String(e?.message ?? e);
            if (msg.includes('NOT_LOGGED_IN'))
                return { ok: false, msg: '登录已失效，请重新调 action=login 出二维码。' };
            return { ok: false, msg: '出错：' + msg.slice(0, 200) };
        }
    },
});
// 模块级直接拿（不依赖 apply —— apply 只在会话首建时跑，agent 重建后不会重跑）
//   注意：三个工具定义在同文件下方（var 声明，有提升），故这里用取值函数避免 TDZ。
/**
 * 智能提示的运行时文本（照小传的 pending 模式）：
 *   session-manager 在 pre-step 里拼好 → 塞进来；index.ts 注册的 systemPrompt.context 只负责读。
 *   ⚠️ 注册必须发生在**主插件的 ctx** 上（见 index.ts 小传那段）—— 注册在 agentCtx 上会随 agent 重建丢失。
 */
let ctxSmartTextPending = '';
export function setCtxSmartText(t) { ctxSmartTextPending = String(t || ''); if (ctxSmartTextPending)
    console.log('[spctx-set] 已塞入 ' + ctxSmartTextPending.length + ' 字'); }
export function getCtxSmartText() { if (!ctxSmartTextPending)
    console.log('[spctx-get] 读时为空'); return ctxSmartTextPending; }
let CTX_TOOLS_REF = [];
/** 惰性取三件套（首次调用时求值，那时定义已就绪） */
function ctxToolsRef() {
    if (CTX_TOOLS_REF.length === 0) {
        try {
            CTX_TOOLS_REF = [contextMemoTool, contextCompactTool, contextDropTool];
        }
        catch { /* ignore */ }
    }
    return CTX_TOOLS_REF;
}
let QUN_TOOLS_REF = [];
/** 惰性取 QQ 群管理工具（不分开关，永远挂） */
function qunAdminRef() {
    if (QUN_TOOLS_REF.length === 0) {
        try {
            QUN_TOOLS_REF = [qunAdminTool];
        }
        catch { /* ignore */ }
    }
    return QUN_TOOLS_REF;
}
const ctxEnvMap = new WeakMap();
/** 工具执行时取会话坐标：优先用注册时记下的（最准），取不到再回退反查 */
function ctxEnvOf(exec) {
    try {
        const c = exec?.agent?.ctx;
        if (c && typeof c === 'object') {
            const hit = ctxEnvMap.get(c);
            if (hit && hit.dataRoot && hit.sessionKey)
                return hit;
        }
    }
    catch { /* fallthrough */ }
    return undefined;
}
/** 工具挂载诊断：直接追加到 ~/.dsh/contextless-trace.log（与 session-manager 的 trace 同一文件）
 *  为什么要它：插件工具层（注册/挂载）以前完全没法验证，只能靠猜。有了这行，重启后一眼就能看出
 *  「群管理工具有没有真的挂上去、dataRoot 传的是什么」。 */
function traceToolReg(line) {
    try {
        const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
        if (!home)
            return;
        diagWrite('contextless-trace', line); // ★ 收口：与 contextless-store 共用同一个底座，不再各写各的
    }
    catch { /* ignore */ }
}
/**
 * 按会话开关**动态**注册/注销三个上下文工具（context_memo / context_compact / context_drop）。
 * 由 session-manager 在每个回合的 pre-step 里调用（拿 rec.agentCtx）。
 * 这样面板一改开关，**下一回合就生效**，不需要重启，也没有"apply 时读全局变量"的时序竞态。
 */
export function syncContextTools(agentCtx, shouldHave, env, reminderText) {
    void reminderText; // 保留签名（提示文本改由主 ctx 的 systemPrompt.context 提供，见 index.ts）
    if (!agentCtx || typeof agentCtx !== 'object')
        return;
    const ctxObj = agentCtx;
    const key = agentCtx;
    try {
        // ① 先记会话坐标（每次 pre-step 都刷新；这是工具执行时唯一的可靠来源）
        //   ⚠️ 只要 dataRoot 就够了：pre-step 里 sessionKey 经常为空（实测 sk= 空），
        //     但群管理工具只要数据目录；备忘类工具由 resolveCtxMemoEnv 自己要求 sessionKey 非空。
        if (env && env.dataRoot) {
            ctxEnvMap.set(key, { dataRoot: String(env.dataRoot), sessionKey: String(env.sessionKey ?? '') });
        }
        const cur = ctxToolDisposers.get(key);
        // ⚠️ 2026-10-02：不能靠"缓存里已注册"就跳过 —— agent/ctx 一变，实际工具表就作废了，
        //   而缓存还记着"注册过" ⇒ 永久挂不上（实测：工具表里没有 context_*，但日志显示 syncTools 在跑）。
        //   改为每次都"先注销旧、再重新注册"，幂等刷新，代价极小。
        if (cur) {
            for (const d of cur) {
                try {
                    d();
                }
                catch { /* ignore */ }
            }
            ctxToolDisposers.delete(key);
        }
        const reg = ctxObj.tools?.register;
        if (typeof reg !== 'function')
            return;
        const ds = [];
        // ① 三个上下文工具：只在「无上下文·智能判断」开启时挂
        if (shouldHave) {
            for (const t of ctxToolsRef()) {
                try {
                    const d = reg.call(ctxObj.tools, t);
                    if (typeof d === 'function')
                        ds.push(d);
                }
                catch { /* 单个工具注册失败不影响其他 */ }
            }
        }
        // ② QQ 群管理工具：QQ 通道的会话都挂。
        //   注：syncContextTools 本来就**只在 QQ 会话**里被调用（web/终端会话不经过这里），
        //   所以不存在"污染其它会话"的问题。2026-10-02 曾误加"只挂私聊"限制，主人指出多余，已撤销。
        for (const t of qunAdminRef()) {
            try {
                const d = reg.call(ctxObj.tools, t);
                if (typeof d === 'function')
                    ds.push(d);
            }
            catch { /* ignore */ }
        }
        if (ds.length)
            ctxToolDisposers.set(key, ds);
        traceToolReg(`[ctxtool-reg] shouldHave=${shouldHave} 挂载=${ds.length} 件 dataRoot=${String(env?.dataRoot ?? '')} sk=${String(env?.sessionKey ?? '')}`);
    }
    catch (e) {
        // fail-soft：工具挂载失败绝不影响会话；但必须留下证据
        traceToolReg('[ctxtool-reg] 异常: ' + String(e?.message ?? e).slice(0, 160));
    }
}
// ══════════════════════════════════════════════════════════════════════════
// 2026-10-09 架构微调（主人定）：**注册不动 + 按会话实时剪枝可见性**
// ══════════════════════════════════════════════════════════════════════════
// 旧做法是 pre-step 每步都 `syncContextTools()`：内部"先注销、再重新注册"，
// 于是**每一步都动一次工具表** → 宿主每步都发"工具已更新 · 移除/新增"（还进上下文，纯烧 token），
// 多会话并存时更是"你挂我卸"来回抖。
//
// 主人的判断是对的：不该用"注册/注销"表达"这个会话要不要有"，而该
// **注册只做一次，可见性按会话实时剪枝** —— 宿主正好提供了这个接口：
// `ctx.tools.restrict({ allow | deny })`，**per-scope**（只作用于调用方那一个 agent 作用域），
// 且"只过滤**继承**来的工具（全局层+祖先层），不动该作用域自己注册的"。
//
// 于是现在的分工：
//   · {@link ensureContextToolsGlobal} —— 全局注册一次（永不注销），幂等；
//   · {@link restrictContextTools}   —— 每个会话每次 pre-step 声明"我要不要看得到那三个"，
//                                      状态没变就一根手指都不动（不产生任何变更通知）。
// =========================================================================
/** 三个上下文工具的名字（restrict 用；必须与 ctxToolsRef() 里的 name 完全一致） */
/** 需要"按会话剪枝"的工具名（restrict 用）。
 *  ⚠️ 2026-10-10：`qq_group_admin` 也在这里 —— 它跟 context_* 一样是**QQ 通道专属**，
 *  全局注册后若不在非 QQ 会话里 deny 掉，会白占每个会话的 token（主人要求剪枝覆盖非 QQ 会话）。 */
const CTX_TOOL_NAMES = ['context_memo', 'context_compact', 'context_drop', 'qq_group_admin'];
/** 本轮扫描到的「可领取」扩展工具（full 名 → 条目） */
const extToolIndex = new Map();
/** 已领取到某个会话作用域的工具（agentCtx → full → disposer）—— metaMode 下用 */
const extGranted = new WeakMap();
/**
 * 「默认全剪枝 + 按需放开」的授予集合（2026-10-28，主人定）。
 *
 * 目标形态：`expose:'all'` 的工具**始终全局注册**（注册表不动、不抖），
 * 但每个会话**默认被 deny 掉全部**（模型清单里连名字都看不到 = 零 token），
 * 只有 `gain_qq_tools.enable` 过的名字才从 deny 名单里拿掉。
 *
 * 复用的是仓库里已有的 `tools.restrict({ deny })` + `liftRestriction`（见 restrictContextTools 注释），
 * 不新造机制。
 */
const extGrantSet = new WeakMap();
const extRestrictState2 = new WeakMap();
/** 见过的会话作用域 → 它的 selfTag（扫描完成后要按新索引**重放一次**剪枝） */
const extSeenCtx = new Map();
/** 按当前会话的「已领取集合」重设一次剪枝（幂等：deny 名单没变就不动） */
export function applyExtToolVisibility(agentCtx, selfTag) {
    try {
        const ctx = agentCtx;
        if (!ctx || typeof ctx !== 'object')
            return;
        // ⚠️ 2026-10-28（主人实测：enable 一个 standard 后，自己实例那 4 个被移除）：
        //   gain_qq_tools 内部调本函数时**不传 selfTag**，原来会把 ownSuffix 算成空串 ⇒
        //   连带把本实例自己的那份也 deny 掉。现在：不传就**沿用上次记住的 tag**。
        const prevTag = extSeenCtx.get(ctx) ?? '';
        const tag = selfTag !== undefined ? String(selfTag) : prevTag;
        extSeenCtx.set(ctx, tag);
        const all = [...extToolIndex.keys()];
        if (!all.length)
            return; // 还没扫到东西：先不动（别把不该剪的剪了）
        // ⚠️ 2026-10-28（主人纠正）：开关**不是**"关=不剪枝、全可见"。
        //   关掉元工具 = "按需取用"这条通道整个关掉 ⇒ 别人实例 expose 的工具**永远不可见**
        //   （没有 gain 入口，也就不该偷偷放出来）。所以无论开关开/关，都照常剪：
        //     · 自己实例那份（xxx__本tag）：始终放开
        //     · 别人那份：始终 deny；开关开着时可通过 gain_qq_tools 临时放开
        // ★ 2026-10-28（主人实测：关了元工具，之前领取的工具还在）：开关关掉时
        //   **忽略并清空领取记录** —— 通道一关，别人的工具就该彻底消失，不能靠残留的 granted 续命。
        const metaOnNow = globalThis.__qqbotExtMetaOn !== false;
        if (!metaOnNow)
            extGrantSet.delete(ctx);
        const granted = metaOnNow ? (extGrantSet.get(ctx) || new Set()) : new Set();
        // ★ 2026-10-28（主人直觉）：**本实例自己的那份默认放开** —— 在 whale-girl 的会话里，
        //   `bing_search__whale-girl` 本来就该看得见；别人的实例、以及自己没暴露的工具才要 gain 领取。
        const ownSuffix = tag ? ('__' + tag) : '';
        const deny = all.filter((n) => !granted.has(n) && !(ownSuffix && n.endsWith(ownSuffix)));
        const sig = (metaOnNow ? '1' : '0') + '|' + deny.join(',');
        const st = extRestrictState2.get(ctx);
        if (st && st.sig === sig)
            return;
        if (st?.dispose)
            liftRestriction(st.dispose);
        const toolsObj = toolsOfScope(ctx);
        const restrict = toolsObj?.restrict;
        if (typeof restrict !== 'function') {
            traceToolReg('[ext-vis] 剪枝失败: 拿不到 tools.restrict');
            return;
        }
        if (!deny.length) {
            extRestrictState2.set(ctx, { sig });
            return;
        }
        const d = restrict.call(toolsObj, { deny });
        const dispose = typeof d === 'function' ? d : undefined;
        extRestrictState2.set(ctx, { sig, dispose });
        traceToolReg('[ext-vis] deny=' + deny.length + ' 件 已领取=' + granted.size);
    }
    catch (e) {
        traceToolReg('[ext-vis] 异常: ' + String(e?.message ?? e).slice(0, 140));
    }
}
const GAIN_TOOL_NAME = 'gain_qq_tools';
/** 取当前调用方的 agent ctx（enable 的目标作用域） */
function agentCtxOf(exec) {
    try {
        const c = exec?.agent?.ctx;
        return c && typeof c === 'object' ? c : undefined;
    }
    catch {
        return undefined;
    }
}
/** 把一个扩展工具定义包成 dsh 工具（与全局注册同款；抽出来给 enable 复用） */
function buildExtTool(ent, globalCtx, logger) {
    return defineTool({
        name: ent.full,
        description: String(ent.def.description ?? '') + ' (用户扩展工具 · ' + ent.tag + ')',
        parameters: (ent.def.inputSchema ?? { type: 'object', properties: {} }),
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : ('失败: ' + v.msg) }],
        },
        async execute(args, exec) {
            let pack;
            try {
                pack = buildWorkspaceQqPack(ent.tag, ent.inst.dataRoot);
            }
            catch {
                pack = undefined;
            }
            const env = {
                cwd: ent.inst.cwd || ent.inst.dataRoot,
                exec,
                ctx: globalCtx,
                logger,
                qq: pack,
            };
            try {
                const sess = findSessionRec(channelOf(exec), exec);
                if (sess) {
                    env.manager = sess.ch.manager;
                    env.sender = sess.ch.sender;
                    env.replyTarget = sess.rec.replyTarget;
                }
                else if (pack) {
                    env.sender = pack.sender;
                }
            }
            catch { /* ignore */ }
            try {
                const r = await ent.def.run(args, env);
                if (r && typeof r === 'object')
                    return { ok: r.ok === true, msg: String(r.msg ?? 'done') };
                return { ok: true, msg: r === undefined || r === null ? 'done' : String(r) };
            }
            catch (err) {
                return { ok: false, msg: err instanceof Error ? err.message : String(err) };
            }
        },
    });
}
/** 元工具本体（全局注册一次） */
/**
 * 读「可领取清单」：每个实例各自在自己 dataRoot 下写了
 * `{dataRoot}/.qqbot/ext-tools-index.json`（只列自己的 expose:'all' 工具），
 * 这里把所有实例的合并成一份（按 full 去重）。
 *
 * ★ 2026-10-30（主人方案）：清单文件是"跨实例领取"的完整名单来源 —— 内存索引只在
 * 本进程扫过之后才有，而清单在启动扫描时就落盘了，进程重启/别的工作区也能读。
 */
function readExtIndexFile() {
    const seen = new Set();
    const out = [];
    try {
        for (const m of managersOf()) {
            const dr = String(m?.dataRoot ?? '').trim();
            if (!dr)
                continue;
            const f = join(dr, '.qqbot', 'ext-tools-index.json');
            if (!existsSync(f))
                continue;
            let arr = [];
            try {
                const j = JSON.parse(readFileSync(f, 'utf8'));
                arr = Array.isArray(j?.tools) ? j.tools : [];
            }
            catch {
                continue;
            }
            for (const x of arr) {
                const o = (x ?? {});
                const full = String(o.full ?? '').trim();
                if (!full || seen.has(full))
                    continue;
                seen.add(full);
                out.push({
                    full,
                    tag: String(o.tag ?? ''),
                    baseName: String(o.baseName ?? ''),
                    description: String(o.description ?? ''),
                    dataRoot: o.dataRoot ? String(o.dataRoot) : dr,
                    cwd: o.cwd ? String(o.cwd) : undefined,
                });
            }
        }
    }
    catch { /* ignore */ }
    return out;
}
function makeGainTool(globalCtx, logger) {
    return defineTool({
        name: GAIN_TOOL_NAME,
        description: '按需取用「QQ 实例的扩展工具」：先 list / search 看有哪些（只回名字+一句话），'
            + '再 enable 把某个装进当前会话，之后就能调用它（非 QQ 会话想往 QQ 发消息、读会话时用）。'
            + 'disable 可卸下。',
        // ⚠️ 2026-10-28（引擎控制台实录）：defineTool 的 parameters 要的是**扁平字段表**，
        //   ；写成 JSON Schema（type/properties/required）
        //   会被判 "unsupported JSON schema: parameters.type must be a value schema object" ⇒ 注册直接失败。
        parameters: {
            action: { type: 'string', required: true, enum: ['list', 'search', 'enable', 'disable'], description: 'list=列出全部 / search=按关键词搜 / enable=装到当前会话 / disable=卸下' },
            query: { type: 'string', description: 'search 用：关键词（匹配工具名与描述）' },
            tool: { type: 'string', description: 'enable/disable 用：工具名，可用逗号或空格**批量**（如 qq_send__whale-girl,bing_search__standard；先 list 查）' },
            tag: { type: 'string', description: '可选：只看某个实例（tag）' },
            limit: { type: 'integer', description: 'list/search 返回条数 1~50（默认 20）' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : ('失败: ' + v.msg) }],
        },
        async execute(args, exec) {
            const action = String(args?.action ?? 'list');
            const q = String(args?.query ?? '').trim().toLowerCase();
            const wantTools = String(args?.tool ?? '').trim()
                .split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
            const wantTag = String(args?.tag ?? '').trim();
            const limRaw = Number(args?.limit);
            const lim = Math.max(1, Math.min(50, Number.isFinite(limRaw) && limRaw > 0 ? Math.trunc(limRaw) : 20));
            // ★ 2026-10-30：清单文件优先（每实例各一份，合并看）；内存索引兜底
            const fileRows = readExtIndexFile();
            const srcRows = fileRows.length
                ? fileRows
                : [...extToolIndex.values()].map((e) => ({
                    full: e.full, tag: e.tag, baseName: e.baseName,
                    description: String(e.description || ''),
                    dataRoot: e.inst?.dataRoot,
                    cwd: e.inst?.cwd,
                }));
            // ★ 2026-10-30（主人定）：**机器人自己的会话不用领自己的工具**（插件 ctx 注册的本来就可见），
            //   所以这里把"当前会话所属实例"的 tag 过滤掉；非 QQ 会话拿不到 tag ⇒ 不过滤。
            let selfTagOfCaller = '';
            try {
                const sess0 = findSessionRec(channelOf(exec), exec);
                const mgr0 = sess0?.ch?.manager;
                if (mgr0)
                    selfTagOfCaller = instanceTagOfManager(mgr0);
            }
            catch { /* ignore */ }
            const rows = srcRows
                .filter((e) => !selfTagOfCaller || e.tag !== selfTagOfCaller)
                .filter((e) => (!wantTag || e.tag === wantTag));
            try {
                if (action === 'list' || action === 'search') {
                    const hit = action === 'search'
                        ? rows.filter((e) => !q || e.full.toLowerCase().includes(q) || String(e.description).toLowerCase().includes(q))
                        : rows;
                    if (!hit.length)
                        return { ok: true, msg: rows.length ? '没有匹配的工具（换关键词试试）' : '当前没有可领取的扩展工具' };
                    const shown = hit.slice(0, lim);
                    const lines = shown.map((e) => e.full + '  —  ' + String(e.description || '').slice(0, 90)).join('\n');
                    const more = hit.length > shown.length
                        ? ('\n……（共 ' + hit.length + ' 个，已显示前 ' + shown.length + ' 个；加 limit 或 search 缩小）')
                        : '';
                    return { ok: true, msg: '可领取的扩展工具 ' + hit.length + ' 个（enable 时 tool 写全名，可逗号批量）:\n' + lines + more };
                }
                if (action === 'enable') {
                    if (!wantTools.length)
                        return { ok: false, msg: 'tool 必填（先 action=list 查名字）' };
                    const actx = agentCtxOf(exec);
                    if (!actx)
                        return { ok: false, msg: '拿不到当前会话作用域（本工具只能在会话内使用）' };
                    let gset = extGrantSet.get(actx);
                    if (!gset) {
                        gset = new Set();
                        extGrantSet.set(actx, gset);
                    }
                    const toolsObj = toolsOfScope(actx);
                    const regFn = toolsObj?.register;
                    let mm = extGranted.get(actx);
                    if (!mm) {
                        mm = new Map();
                        extGranted.set(actx, mm);
                    }
                    const okList = [];
                    const badList = [];
                    for (const name of wantTools) {
                        // 2026-10-30：内存索引优先；没有就用清单文件里的条目（buildExtTool 需要 ExtToolEntry 形状，
                        //   文件条目缺 def/inst，这里只做"有现成索引就用"的判断，文件条目走下面的兜底注册）。
                        const ent = extToolIndex.get(name) || rows.find((e) => e.baseName === name && extToolIndex.has(e.full)) || undefined;
                        if (!ent) {
                            badList.push(name);
                            continue;
                        }
                        gset.add(ent.full);
                        // 兜底：按需取用模式下工具未全局注册，得真注册一次
                        if (!mm.has(ent.full) && toolsObj && typeof regFn === 'function') {
                            try {
                                const d = regFn.call(toolsObj, buildExtTool(ent, globalCtx, logger));
                                if (typeof d === 'function')
                                    mm.set(ent.full, d);
                            }
                            catch { /* 已全局注册时覆盖同名，失败无妨 */ }
                        }
                        okList.push(ent.full);
                    }
                    applyExtToolVisibility(actx);
                    const head = okList.length ? ('已放开 ' + okList.length + ' 个：' + okList.join(', ')) : '没有放开任何工具';
                    const tail = badList.length ? ('；找不到：' + badList.join(', ')) : '';
                    return { ok: badList.length === 0, msg: head + tail + '（本会话可见；换会话要重新 enable）' };
                }
                if (action === 'disable') {
                    const actx = agentCtxOf(exec);
                    if (actx) {
                        const gset = extGrantSet.get(actx);
                        if (!gset || !gset.size)
                            return { ok: true, msg: '当前会话没有领取过扩展工具' };
                        // ★ 2026-10-31 修（主人实测：disable 之后工具**仍然能调用**）：
                        //   原来只 `gset.delete` + `applyExtToolVisibility`（deny 剪枝），
                        //   但 enable 时是**真注册**过一份的（extGranted 里存着 disposer），不撤销就还在注册表里，
                        //   模型拿着旧 schema 一调照样跑通。这里把 disposer 一起调掉。
                        const dropOne = (full) => {
                            const dm = extGranted.get(actx);
                            const d = dm?.get(full);
                            if (d) {
                                try {
                                    d();
                                }
                                catch { /* ignore */ }
                                dm.delete(full);
                            }
                        };
                        if (!wantTools.length) {
                            const dm = extGranted.get(actx);
                            if (dm) {
                                for (const [, d] of dm) {
                                    try {
                                        d();
                                    }
                                    catch { /* ignore */ }
                                }
                                dm.clear();
                            }
                            gset.clear();
                            applyExtToolVisibility(actx);
                            return { ok: true, msg: '已收回本会话领取的全部扩展工具（已注销注册）' };
                        }
                        const done = [];
                        const miss = [];
                        for (const name of wantTools) {
                            // 2026-10-30：内存索引优先；没有就用清单文件里的条目（buildExtTool 需要 ExtToolEntry 形状，
                            //   文件条目缺 def/inst，这里只做"有现成索引就用"的判断，文件条目走下面的兜底注册）。
                            const ent = extToolIndex.get(name) || rows.find((e) => e.baseName === name && extToolIndex.has(e.full)) || undefined;
                            const full = ent ? ent.full : name;
                            if (gset.delete(full)) {
                                dropOne(full);
                                done.push(full);
                            }
                            else
                                miss.push(name);
                        }
                        applyExtToolVisibility(actx);
                        return {
                            ok: miss.length === 0,
                            msg: (done.length ? '已收回 ' + done.length + ' 个：' + done.join(', ') : '没有收回任何工具')
                                + (miss.length ? ('；未领取：' + miss.join(', ')) : ''),
                        };
                    }
                    const m = extGranted.get(actx);
                    if (!m || !m.size)
                        return { ok: true, msg: '当前会话没有领取过扩展工具' };
                    const target = wantTools[0] ?? '';
                    if (target) {
                        const d = m.get(target);
                        if (!d)
                            return { ok: false, msg: '当前会话没装: ' + target };
                        try {
                            d();
                        }
                        catch { /* ignore */ }
                        m.delete(target);
                        return { ok: true, msg: '已卸下：' + target };
                    }
                    for (const [k, d] of m) {
                        try {
                            d();
                        }
                        catch { /* ignore */ }
                        void k;
                    }
                    m.clear();
                    return { ok: true, msg: '已卸下本会话领取的全部扩展工具' };
                }
                return { ok: false, msg: '未知 action: ' + action };
            }
            catch (e) {
                return { ok: false, msg: (e instanceof Error ? e.message : String(e)) };
            }
        },
    });
}
/** 全局注册/注销元工具（幂等；on=false 时**真注销**，对应设置页的热关闭） */
function ensureGainToolGlobal(globalCtx, logger, on = true) {
    try {
        const g = globalThis;
        // ★ 2026-10-28（主人 + issue 反馈）：**热关闭** —— 开关关掉时元工具必须真的消失，
        //   否则「非 QQ 会话零 QQ 工具」这条做不到（还会白占几十 token）。
        if (!on) {
            if (typeof g.__qqbotGainToolReg === 'function') {
                try {
                    g.__qqbotGainToolReg();
                }
                catch { /* ignore */ }
                g.__qqbotGainToolReg = undefined;
                logger?.info?.('[channel-tools] 已注销元工具 ' + GAIN_TOOL_NAME);
            }
            return;
        }
        if (g.__qqbotGainToolReg)
            return;
        const rootCtx = ((globalCtx?.root) ?? globalCtx);
        const gctx = rootCtx;
        let toolsObj;
        try {
            toolsObj = gctx.get?.('tools');
        }
        catch { /* ignore */ }
        if (!toolsObj || typeof toolsObj.register !== 'function')
            return;
        const d = toolsObj.register.call(toolsObj, makeGainTool(globalCtx, logger));
        if (typeof d === 'function')
            g.__qqbotGainToolReg = d;
        gctx.logger?.info?.('[channel-tools] 已注册元工具 ' + GAIN_TOOL_NAME);
    }
    catch (e) {
        // ⚠️ 2026-10-28：这里原来静默 catch ⇒ "开了开关却连元工具都没有"，完全查不出原因。
        const msg = e instanceof Error ? e.message : String(e);
        try {
            console.error('[channel-tools] 元工具注册失败: ' + msg);
        }
        catch { /* ignore */ }
    }
}
/**
 * 读**某个实例**的「扩展工具按需取用」勾选状态（2026-10-30 主人要求按实例生效）。
 * 顺序：`{dataRoot}/.qqbot/ext-meta-tool.json`（面板保存写的）→ 该实例 config.extMetaTool。
 */
function extMetaOnOfInstance(dataRoot, mgrConfig) {
    const dr = String(dataRoot ?? '').trim();
    if (dr) {
        try {
            const f = join(dr, '.qqbot', 'ext-meta-tool.json');
            if (existsSync(f)) {
                const o = JSON.parse(readFileSync(f, 'utf8'));
                if (typeof o?.on === 'boolean')
                    return o.on;
            }
        }
        catch { /* ignore */ }
    }
    return mgrConfig?.extMetaTool === true;
}
export function ensureExtToolsGlobal(globalCtx, agentCtxForApply, selfTagOfThisInstance) {
    // 2026-10-31：selfTagOfThisInstance 暂不参与注册决策（隔离靠 applyExtToolVisibility 的 deny），
    //   保留签名是为了不破坏调用点。
    void selfTagOfThisInstance;
    // 节流：本函数挂在 agent/pre-step（**每个 step** 都触发）—— 15 秒内不重复扫盘；
    // 幂等保证：即便节流窗口外重复进入，已注册的 name@tag 也会被跳过。
    extGlobDiag('enter ctxType=' + (globalCtx === null ? 'null' : typeof globalCtx));
    const nowMs = Date.now();
    if (nowMs - lastExtGlobAt < 15000)
        return;
    lastExtGlobAt = nowMs;
    extGlobDiag('pass-throttle');
    void (async () => {
        try {
            if (!globalCtx || typeof globalCtx !== 'object')
                return;
            // ★★ 2026-10-31（主人纠正 2 次）：**和普通扩展工具完全一样**——用**插件 ctx** 注册，
            //   不取 `ctx.root`。普通工具走 `ctx.tools.register`（见本文件下面的 register），
            //   注册落在插件作用域 ⇒ 只有 QQ 会话（插件的子 agent）继承得到，非 QQ 会话天然看不见。
            //   我之前搞错的地方：**取 tools 服务用了 `ctx.get('tools')`** —— 那是"服务查找"，
            //   会向上拿到**根层**的服务实例 ⇒ 注册等于挂到全局（这才是泄漏 + restrict 认不出的真正原因）。
            //   现在两处都对齐普通工具：ctx = 插件 ctx，服务 = `ctx.tools`（属性，绑定本作用域）。
            const rootCtx = globalCtx;
            extGlobDiag('scope=plugin-ctx（同普通扩展工具）');
            const gctx = rootCtx;
            let toolsObj;
            // ⚠️ 必须**优先 `ctx.tools`（属性访问，绑定本作用域）**；
            //    只在拿不到时才退回 `get('tools')`（那是向上查找到的根服务，注册会落到全局）。
            try {
                toolsObj = gctx.tools;
            }
            catch { /* 未 inject 会抛 */ }
            if (!toolsObj || typeof toolsObj.register !== 'function') {
                try {
                    toolsObj = gctx.get?.('tools');
                }
                catch { /* ignore */ }
            }
            if (!toolsObj || typeof toolsObj.register !== 'function') {
                extGlobDiag('FAIL 拿不到 tools 服务');
                extDiag('[extglob] 拿不到 tools 服务, 跳过');
                return;
            }
            // 2026-10-28：元工具**先注册**，且不依赖"有没有实例"——
            //   上一版放在扫描末尾，若中途 early-return 就永远注册不上（实测：开了按需取用却连元工具都没有）。
            // ★ 2026-10-30（主人定）：**任一启动中的实例勾选了，就全局注册 gain_qq_tools**；
            //   而"能领哪些工具"由**勾选实例的并集**决定（见 scanTargets）。
            //   逐实例读：{dataRoot}/.qqbot/ext-meta-tool.json → 该实例 config.extMetaTool。
            const metaOn = (() => {
                try {
                    for (const m of managersOf()) {
                        const mm = m;
                        if (extMetaOnOfInstance(String(mm.dataRoot ?? ''), mm.config))
                            return true;
                    }
                }
                catch { /* ignore */ }
                // 进程级热标记（设置页刚保存、还没落盘的瞬间）
                try {
                    const live = globalThis.__qqbotExtMetaTool;
                    if (typeof live === 'boolean')
                        return live;
                }
                catch { /* ignore */ }
                return false;
            })();
            // ★ 2026-10-28（主人急）：**无条件注册元工具** —— 它是个极轻的入口，本来就不该被任何开关挡住。
            //   "开了按需取用却连 gain_qq_tools 都看不到" 这种状态毫无意义：要么两个都有，要么两个都没有。
            ensureGainToolGlobal(globalCtx, gctx.logger, metaOn);
            // 实例清单：每个账号实例注册一份（tag = 人设 id）
            const insts = [];
            try {
                for (const m of managersOf()) {
                    const mm = m;
                    const tag = instanceTagOfManager(mm);
                    if (!tag)
                        continue;
                    // ★ 2026-10-31 修（主人实测：勾了三号却列不出东西）：
                    //   以前要求 `mm.dataRoot` 非空才收 —— 而**没显式配 dataRoot 的实例**（如 standard）
                    //   dataRoot 是空串，于是它整个被排除，它的扩展目录压根没被扫。
                    //   这里按插件口径兜底算：config.dataRoot || {absCwd(cwd)/process.cwd()}/dshqqbot。
                    let dr = String(mm.dataRoot ?? '').trim();
                    if (!dr) {
                        try {
                            dr = dataRootOf(mm.config);
                        }
                        catch {
                            dr = '';
                        }
                    }
                    if (!dr)
                        continue;
                    insts.push({ tag, dataRoot: dr, cwd: String(mm.cwd ?? mm.config?.cwd ?? '') });
                }
            }
            catch { /* ignore */ }
            extGlobDiag('instances=' + insts.length + ' :: ' + insts.map((x) => x.tag).join(','));
            if (!insts.length) {
                extGlobDiag('FAIL 暂无实例');
                extDiag('[extglob] 暂无实例, 跳过');
                return;
            }
            const g = globalThis;
            if (!g.__qqbotExtToolsGlobal)
                g.__qqbotExtToolsGlobal = new Map();
            const reg = g.__qqbotExtToolsGlobal;
            // 开关（默认开 = 按需取用）：关掉后回到"扩展工具全部全局注册"的旧行为
            // 2026-10-28（主人实测纠正）：默认**保持旧行为**（全部 expose:'all' 全局注册）。
            //   原因：第一版把默认值设成"按需取用"，结果元工具没注册上 => 所有会话一个扩展工具都没有
            //   （主人截图："怎么你改一下代码把自己的扩展工具都给不注册了"）。
            //   ⇒ 现在只有显式打开 extMetaTool 才进按需取用，默认一切照旧。
            const metaMode = metaOn; // 与上面同一个口径（含 live 标记）
            extToolIndex.clear();
            globalThis.__qqbotExtMetaOn = metaMode;
            extGlobDiag('metaMode=' + String(metaMode));
            // ── 阶段 1：扫描，**只填索引**（不注册）────────────────────────────
            // ★ 2026-10-30（主人定）：**只扫勾了「扩展工具按需取用」的实例**。
            //   没勾的实例，它扩展目录里的 expose:'all' 工具不进清单、也不能被领取
            //   （它自己的 QQ 会话里照样看得到 —— 那是插件 ctx 注册的，跟本开关无关）。
            const scanTargets = insts.filter((x) => extMetaOnOfInstance(x.dataRoot));
            extGlobDiag('scanTargets=' + scanTargets.length + '/' + insts.length);
            for (const inst of scanTargets) {
                let defs = [];
                try {
                    defs = await loadExtensionTools(inst.dataRoot, (gctx.logger ?? console));
                }
                catch {
                    defs = [];
                }
                const exposed = defs.filter((d) => d.expose === 'all');
                extGlobDiag('inst=' + inst.tag + ' defs=' + defs.length + ' exposeAll=' + exposed.length);
                for (const def of exposed) {
                    // ⚠️ 工具名只允许 [a-zA-Z0-9_-]（LLM API 硬约束，2026-10-10 事故）
                    const full = def.name + '__' + inst.tag;
                    if (!/^[a-zA-Z0-9_-]+$/.test(full)) {
                        extGlobDiag('SKIP illegal global name: ' + full);
                        continue;
                    }
                    extToolIndex.set(full, {
                        full, tag: inst.tag, baseName: def.name,
                        description: String(def.description ?? ''),
                        def: def, inst,
                    });
                }
            }
            // ★ 2026-10-30（主人方案）：把「可领取清单」落成文件 `{dataRoot}/.qqbot/ext-tools-index.json`。
            //   用途：gain_qq_tools 的 list/search 读它（跨实例领取时不必等内存索引）；
            //   **不改变注册行为** —— expose:'all' 的工具照旧按普通扩展工具的方式注册（全局 + 逐会话剪枝），
            //   清单只是额外产物。
            // ★ 2026-10-30（主人方案）：**每个实例各自落一份清单**到自己 dataRoot 下的
            //   `.qqbot/ext-tools-index.json`，只列**自己 tag** 的工具（就是它自己扩展目录里
            //   expose:'all' 的那些）。gain_qq_tools 读取时会把所有实例的清单合并起来看，
            //   这样"跨实例领取"才有完整名单。
            //   内容与注册行为无关（注册仍按普通扩展工具的方式走）。
            for (const inst of insts) {
                if (!inst || !inst.dataRoot)
                    continue;
                try {
                    const f = join(inst.dataRoot, '.qqbot', 'ext-tools-index.json');
                    const mine = [...extToolIndex.values()].filter((e) => e.tag === inst.tag);
                    const payload = {
                        updatedAt: new Date().toISOString(),
                        instance: inst.tag,
                        dataRoot: inst.dataRoot,
                        note: 'expose:all 扩展工具清单（本实例；供 gain_qq_tools 查询与热注册）',
                        tools: mine.map((e) => ({
                            full: e.full,
                            tag: e.tag,
                            baseName: e.baseName,
                            description: String(e.description || '').slice(0, 200),
                            dataRoot: e.inst?.dataRoot,
                            cwd: e.inst?.cwd,
                        })),
                    };
                    mkdirSync(dirname(f), { recursive: true });
                    writeFileSync(f, JSON.stringify(payload, null, 2), 'utf8');
                    extGlobDiag('清单已落盘: ' + f + ' (' + payload.tools.length + ' 件, ' + inst.tag + ')');
                }
                catch (e) {
                    extGlobDiag('清单落盘失败(' + inst.tag + '): ' + ((e instanceof Error ? e.message : String(e)) || '').slice(0, 120));
                }
            }
            // ── 阶段 2：**先剪枝**（此时索引已完整）──────────────────────────
            //   ★ 2026-10-28（主人抓到抖动："新增 7 个 → 下个 step 又移除 7 个"）：
            //   以前是「循环里边扫描边注册」⇒ 注册发生时 deny 名单还不完整 ⇒ 模型先看到一步、下一步才被剪掉。
            //   现在顺序固定为 **扫描 → 剪枝 → 注册**：注册落地时 deny 已经就位，模型永远看不到那一步。
            for (const [c, tg] of extSeenCtx)
                applyExtToolVisibility(c, tg);
            // ── 阶段 3：全局注册 —— **始终注册**（注册表 != 可见性；可见由 deny 控制）。
            //   ⚠️ 2026-10-28 修：原来按需取用模式下跳过注册，结果连"自己实例那份"都调不到
            //   （deny 只能隐藏，不能凭空造出工具）。
            if (true) {
                // ★★ 2026-10-31（主人纠正）：**每个插件实例只注册自己实例的工具**。
                //   以前是把 extToolIndex 里**所有实例**的工具都注册到本实例的插件 ctx ⇒
                //   别的实例的工具也进了自己的会话，只能再靠 deny 遮（正是"先新增又移除"的来源）。
                //   现在：自己的那份直接注册（插件 ctx，只对自己 QQ 会话可见）；
                //   别人的只进清单文件，由 gain_qq_tools.enable **现场注册**。这样根本不需要 deny。
                for (const ent of extToolIndex.values()) {
                    if (reg.has(ent.full))
                        continue;
                    const def = ent.def;
                    const inst = ent.inst;
                    const full = ent.full;
                    try {
                        const tool = defineTool({
                            name: full,
                            description: String(def.description ?? '') + ' (用户扩展工具 · ' + inst.tag + ')',
                            parameters: def.inputSchema,
                            output: {
                                schema: {
                                    type: 'object', additionalProperties: false,
                                    properties: { ok: { type: 'boolean', required: true }, msg: { type: 'string', required: true } },
                                },
                                render: (_a, v) => [{ type: 'text', text: v.ok ? v.msg : ('失败: ' + v.msg) }],
                            },
                            async execute(args, exec) {
                                let pack;
                                try {
                                    pack = buildWorkspaceQqPack(inst.tag, inst.dataRoot);
                                }
                                catch {
                                    pack = undefined;
                                }
                                const env = {
                                    cwd: inst.cwd || inst.dataRoot,
                                    exec,
                                    ctx: globalCtx,
                                    logger: gctx.logger,
                                    qq: pack,
                                };
                                try {
                                    const sess = findSessionRec(channelOf(exec), exec);
                                    if (sess) {
                                        env.manager = sess.ch.manager;
                                        env.sender = sess.ch.sender;
                                        env.replyTarget = sess.rec.replyTarget;
                                    }
                                    else if (pack) {
                                        env.sender = pack.sender;
                                    }
                                }
                                catch { /* ignore */ }
                                try {
                                    const r = await def.run(args, env);
                                    if (r && typeof r === 'object')
                                        return { ok: r.ok === true, msg: String(r.msg ?? 'done') };
                                    return { ok: true, msg: r === undefined || r === null ? 'done' : String(r) };
                                }
                                catch (err) {
                                    return { ok: false, msg: err instanceof Error ? err.message : String(err) };
                                }
                            },
                        });
                        const d = toolsObj.register.call(toolsObj, tool);
                        if (typeof d === 'function')
                            reg.set(full, d);
                        extGlobDiag('OK registered ' + full);
                    }
                    catch (e) {
                        extGlobDiag('FAIL register ' + full + ' :: ' + ((e instanceof Error ? e.message : String(e)) || '').slice(0, 200));
                    }
                }
            }
            // ★ 2026-10-31 修抖动：注册发生在上面（此时 deny 还没算），模型本 step 会先看到
            //   "新增 N 个"，下一轮 apply 才 deny → "又移除 N 个"（主人截图里就是这个）。
            //   这里在**同一轮**对触发这次扫描的 agent ctx 再跑一遍剪枝，让注册与 deny 一次落定。
            try {
                if (agentCtxForApply)
                    applyExtToolVisibility(agentCtxForApply);
            }
            catch { /* ignore */ }
            extGlobDiag('index=' + extToolIndex.size + ' 可领取');
        }
        catch (e) {
            extGlobDiag('EXCEPTION ' + ((e instanceof Error ? e.message : String(e)) || '').slice(0, 200));
            extDiag('[extglob] 异常: ' + ((e instanceof Error ? e.message : String(e)) || '').slice(0, 160));
        }
    })();
}
export function ensureContextToolsGlobal(globalCtx) {
    // 2026-10-21 修（trace 实证）：restrict 报 "names unknown global tools" => 我们注册的层不是「全局层」。
    //   cordis 的 ctx.root 才是根作用域；拿不到就退回传入值（行为不变）。
    const rootOfGlobal = (globalCtx.root ?? globalCtx);
    if (rootOfGlobal !== globalCtx)
        traceToolReg('[ctxtool-reg] 用 root ctx 注册（不同于传入的 ctx）');
    try {
        if (!globalCtx || typeof globalCtx !== 'object')
            return;
        // ⚠️ 2026-10-09 修（实测抓到）：apply 的注入列表是 `["settings","webServer"]`，**没有 `tools`** ⇒
        //   直接读 `ctx.tools` 会被宿主拒（`cannot get property "tools" without inject`），异常被 catch 吞掉，
        //   表现就是"全局注册压根没发生"（trace 里只有别的报错、没有"全局注册 N 件"）。
        //   正解：**用 cordis 的运行时取服务 `ctx.get('tools')`**（不需要 inject 声明）——
        //   本插件别处也是这个姿势（见 ext-capabilities 给扩展工具的 kernel 文档：`ctx.get('tools')`）。
        const ctxObj = rootOfGlobal;
        let toolsObj;
        try {
            toolsObj = ctxObj.tools;
        }
        catch { /* 未声明 inject 时会抛 —— 忽略，下面改走 get */ }
        if (!toolsObj || typeof toolsObj.register !== 'function') {
            try {
                toolsObj = ctxObj.get?.('tools');
            }
            catch { /* ignore */ }
        }
        const reg = toolsObj?.register;
        if (!toolsObj || typeof reg !== 'function') {
            traceToolReg('[ctxtool-reg] 全局注册跳过: 拿不到 tools 服务（ctx.tools 被拒 且 ctx.get("tools") 为空）');
            return;
        }
        const g = globalThis;
        if (Array.isArray(g.__qqbotCtxToolsGlobal) && g.__qqbotCtxToolsGlobal.length > 0)
            return;
        const ds = [];
        for (const t of [...ctxToolsRef(), ...qunAdminRef()]) {
            try {
                const d = reg.call(toolsObj, t);
                if (typeof d === 'function')
                    ds.push(d);
            }
            catch { /* 单个失败不影响其它 */ }
        }
        g.__qqbotCtxToolsGlobal = ds;
        traceToolReg(`[ctxtool-reg] 全局注册 ${ds.length} 件（永不注销；可见性改由 per-scope restrict 控制）`);
    }
    catch (e) {
        traceToolReg('[ctxtool-reg] 全局注册异常: ' + String(e?.message ?? e).slice(0, 160));
    }
}
/** 每个 agent 作用域当前的可见性状态（幂等用：状态没变就不动） */
const ctxRestrictState = new WeakMap();
/** 释放 restriction 的唯一正确姿势（2026-10-21，抄 dsh-computer-use/internal/schema-visibility.mjs）：
 *  cordis 的 `ctx.effect(fn)` 返回的是**函数**（`Disposable<T> = () => T`），
 *  对函数调 `.dispose?.()` 会**静默变成空操作** —— 限制挂上去、再也没摘下来。
 *  所以函数优先，`.dispose()` 只作兼容。
 */
function liftRestriction(disposable) {
    if (typeof disposable === 'function') {
        try {
            disposable();
        }
        catch { /* ignore */ }
        return;
    }
    const d = disposable;
    if (d && typeof d.dispose === 'function') {
        try {
            d.dispose();
        }
        catch { /* ignore */ }
    }
}
/** 取某作用域的 tools 服务：`ctx.tools` 在未声明 inject 时会抛，退化到 cordis 运行时 `ctx.get('tools')`。 */
function toolsOfScope(agentCtx) {
    const c = agentCtx;
    try {
        const t = c?.tools;
        if (t && typeof t === 'object')
            return t;
    }
    catch { /* 未 inject 时读 ctx.tools 会抛 */ }
    try {
        const t = c?.get?.('tools');
        if (t && typeof t === 'object')
            return t;
    }
    catch { /* ignore */ }
    return undefined;
}
/**
 * 按会话**实时剪枝**三个上下文工具的可见性（2026-10-09 起；2026-10-21 按 `dsh-computer-use` 的实测修）。
 *
 * 语义：**开了「无上下文模式 + 智能判断」**的会话 → 看得见那三个工具；
 * 否则该会话**连工具名都看不到**（模型清单里没有 = 零 token），而**注册表纹丝不动**。
 * 面板一改开关 → 下一次 pre-step（下一回合 / 下一 step）即生效。
 *
 * 2026-10-21 修两处（对齐 `dsh-plugins/dsh-computer-use/internal/schema-visibility.mjs`）：
 *   ① `ctx.tools` 在未 inject 时会抛 ⇒ 必须退化到 `ctx.get('tools')`，否则"剪枝"整段被 catch 吞掉；
 *   ② `restrict()` 的返回值是**函数**，释放必须走 {@link liftRestriction}。
 * 幂等：同一作用域状态没变化就直接 return，不重复设/撤 restriction（避免无谓变更通知与抖动）。
 */
/**
 * 扩展工具启停：用 per-scope restrict 剪枝（2026-10-24）
 *
 * 为什么不能只靠"扫描时跳过"：
 *   hotReloadChannelTools 的实现是 **重新 apply**（只注册新工具），
 *   而工具注册表按名字覆盖 —— **停用的工具因为这次没注册，就留在原地不动**。
 *   所以"关掉开关"对 AI 侧无效，必须显式让它不可见。
 *
 * DSH 自己的做法就是这个（见 session-manager 里 ensureContextToolsGlobal 那段注释）：
 *   工具全局注册一次、永不注销，再用 ctx.tools.restrict({ deny }) 按会话剪枝。
 *   我们照抄：停用的扩展工具名进 deny 列表。
 *
 * 幂等：restrict 返回 dispose；每次 apply 先撤销上一次的，再按当前 disabled 重挂。
 */
// ══════════════════════════════════════════════════════════════════════════
// 2026-10-28（主人定，对应 issue #26）：上下文/群管理工具改为**按 QQ 会话注册**
// ══════════════════════════════════════════════════════════════════════════
// 旧做法（2026-10-09 起）：「插件根作用域全局注册一次 + pre-step 逐会话 restrict deny」。
//   · 当初改成全局，是为了避开"每步先注销再重注册 → 工具表反复变动 → 宿主每步发
//     「工具已更新·移除/新增」"的抖动（那批通知还进上下文，纯烧 token）。
//   · 代价是：① 第一次 pre-step 之前，无关工作区的会话也能看到这四个名字；
//             ② `restrict` 只过滤**继承来的**工具，全局层本身就是泄漏源，剪枝只是事后补救。
//
// 现在照 `mountChannelTools` 的路子（**per-agent register**），配一个幂等状态机：
//   · 状态没变 → 一根手指都不动（不产生任何变更通知，同样不抖）；
//   · 状态变了 → 先撤旧的、再按新状态注册（面板一改开关，下一 step 生效）。
// 非 QQ 会话根本不经过这里 ⇒ 天生看不到，零窗口期、零 token。
const ctxScopeState = new WeakMap();
/**
 * 按会话同步「上下文压缩三件套 + QQ 群管理」的**注册状态**（幂等）。
 *
 * @param agentCtx 该 QQ 会话的 agent 作用域（`record.agentCtx` 或 `agent.ctx`）
 * @param opts.ctxTools   要不要 context_memo / context_compact / context_drop（跟「无上下文·智能判断」开关）
 * @param opts.groupAdmin 要不要 qq_group_admin（跟 groupAdmin.enabled）
 * @param opts.dataRoot   会话坐标（工具执行时反查数据根用）
 * @param opts.sessionKey 会话坐标（备忘类工具要求非空）
 *
 * 失败策略：拿不到 `tools.register` 或注册抛错时**不记状态**（写 `__retry`），下一次 pre-step 重试；
 * 绝不影响会话主流程。
 */
export function syncChannelScopedTools(agentCtx, opts) {
    try {
        if (!agentCtx || typeof agentCtx !== 'object')
            return;
        const key = agentCtx;
        // 会话坐标每次都刷新（工具执行时靠它定位数据根/会话）
        if (opts.dataRoot) {
            ctxEnvMap.set(key, { dataRoot: String(opts.dataRoot), sessionKey: String(opts.sessionKey ?? '') });
        }
        const sig = `${opts.ctxTools ? '1' : '0'}${opts.groupAdmin ? '1' : '0'}`;
        const st = ctxScopeState.get(key);
        if (st && st.sig === sig)
            return; // 状态一致 → 不动（这是"不抖"的关键）
        const toolsObj = toolsOfScope(agentCtx);
        const reg = toolsObj?.register;
        if (!toolsObj || typeof reg !== 'function') {
            traceToolReg('[scoped-tool] 拿不到 tools.register，跳过（下次再试）');
            return;
        }
        // 先撤旧的（换开关后不能叠加）
        if (st)
            for (const d of st.disposers) {
                try {
                    d();
                }
                catch { /* ignore */ }
            }
        const want = [
            ...(opts.ctxTools ? ctxToolsRef() : []),
            ...(opts.groupAdmin ? qunAdminRef() : []),
        ];
        const disposers = [];
        for (const t of want) {
            try {
                const d = reg.call(toolsObj, t);
                if (typeof d === 'function')
                    disposers.push(d);
            }
            catch { /* 单个工具失败不影响其它 */ }
        }
        // 全成功才认这个 sig；否则标 __retry，下一 step 重来
        const okAll = disposers.length === want.length;
        ctxScopeState.set(key, { sig: okAll ? sig : `__retry-${sig}`, disposers });
        traceToolReg(`[scoped-tool] 按会话注册 ctx=${opts.ctxTools ? 1 : 0} groupAdmin=${opts.groupAdmin ? 1 : 0}`
            + ` want=${want.length} ok=${disposers.length}`
            + ` dataRoot=${String(opts.dataRoot ?? '')} sk=${String(opts.sessionKey ?? '')}`);
    }
    catch (e) {
        traceToolReg('[scoped-tool] 异常: ' + String(e?.message ?? e).slice(0, 160));
    }
}
let __extRestrictDispose;
export function applyExtDisabledRestrict(agentCtx, dataRoot, extToolNames) {
    try {
        // 先把上一次的剪枝撤掉（否则换开关后会叠加）
        if (__extRestrictDispose) {
            __extRestrictDispose();
            __extRestrictDispose = undefined;
        }
        if (!agentCtx || !dataRoot || extToolNames.length === 0)
            return;
        const toolsObj = toolsOfScope(agentCtx);
        const restrict = toolsObj?.restrict;
        if (typeof restrict !== 'function')
            return;
        // 读「已停用」集合，与每个扩展工具的真实路径比对，得出要 deny 的名字
        let disabled = new Set();
        try {
            const mod = require('../features/ext-packs.js');
            if (typeof mod.readDisabledKeys === 'function')
                disabled = mod.readDisabledKeys(dataRoot);
        }
        catch { /* 拿不到就当全启用 */ }
        if (disabled.size === 0)
            return;
        // extToolNames 里我们放的是 "toolName\u0000absPath"
        const deny = [];
        const norm = (p) => String(p).split('\\').join('/');
        const root = norm(dataRoot);
        for (const entry of extToolNames) {
            const [name, abs] = entry.split('\u0000');
            if (!name || !abs)
                continue;
            const rel = norm(abs);
            const key = rel.indexOf(root + '/') === 0 ? rel.slice(root.length + 1) : rel;
            if (disabled.has(key))
                deny.push(name);
        }
        if (deny.length === 0)
            return;
        const d = restrict.call(toolsObj, { deny });
        if (typeof d === 'function')
            __extRestrictDispose = d;
        else if (d && typeof d.dispose === 'function') {
            const dd = d;
            __extRestrictDispose = () => { dd.dispose(); };
        }
    }
    catch { /* 剪枝失败不影响主流程：工具会多留一个，但不是致命错 */ }
}
export function restrictContextTools(agentCtx, shouldHave, env) {
    try {
        if (!agentCtx || typeof agentCtx !== 'object')
            return;
        const key = agentCtx;
        // 会话坐标每次都刷新（工具执行时靠它定位数据根/会话）
        if (env && env.dataRoot) {
            ctxEnvMap.set(key, { dataRoot: String(env.dataRoot), sessionKey: String(env.sessionKey ?? '') });
        }
        const st = ctxRestrictState.get(key);
        if (st && st.shouldHave === shouldHave)
            return; // ← 状态一致：不动（这是"不抖"的关键）
        if (st?.dispose)
            liftRestriction(st.dispose);
        let dispose;
        if (!shouldHave) {
            const toolsObj = toolsOfScope(agentCtx);
            const restrict = toolsObj?.restrict;
            if (typeof restrict !== 'function') {
                traceToolReg('[ctxtool-reg] 剪枝失败: 拿不到 tools.restrict（ctx.tools 与 ctx.get("tools") 都取不到）');
                ctxRestrictState.set(key, { shouldHave });
                return;
            }
            try {
                const d = restrict.call(toolsObj, { deny: [...CTX_TOOL_NAMES] });
                if (typeof d === 'function')
                    dispose = d;
                else if (d && typeof d.dispose === 'function') {
                    const dd = d;
                    dispose = () => { dd.dispose(); };
                }
                traceToolReg('[ctxtool-reg] 剪枝已挂 deny=' + CTX_TOOL_NAMES.join(',') + ' 返回形态=' + (typeof d));
            }
            catch (e) {
                traceToolReg('[ctxtool-reg] restrict 抛错: ' + String(e?.message ?? e).slice(0, 160));
            }
        }
        ctxRestrictState.set(key, dispose ? { shouldHave, dispose } : { shouldHave });
        traceToolReg(`[ctxtool-reg] ${shouldHave ? '放开(本会话继承全局三个工具)' : '剪枝(本会话看不到三个工具)'}`
            + ` dispose=${dispose ? '有' : '无'} dataRoot=${String(env?.dataRoot ?? '')} sk=${String(env?.sessionKey ?? '')}`);
    }
    catch (e) {
        traceToolReg('[ctxtool-reg] 剪枝异常: ' + String(e?.message ?? e).slice(0, 160));
    }
}
//# sourceMappingURL=channel-tools.js.map