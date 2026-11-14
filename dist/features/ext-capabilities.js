/**
 * ext-capabilities.ts — 给「用户扩展」用的统一能力包（2026-10-06）
 *
 * ── 为什么有这个东西 ───────────────────────────────────────────────
 * 插件有三套用户扩展：`commands/`（自定义斜杠命令）、`tools/`（自定义 QQ 工具）、
 * `botplay/`（卡片事件模块）。三套的能力面原本**严重不均**：
 *
 *   · botplay 卡片：`card()` / `emit` / `markdown` / `image` / `at` / `store` /
 *     `api()` / **`appId`+`appSecret`** / `appendWake` —— 精装版
 *   · 扩展工具  ：只有裸 `{cwd, manager, sender, replyTarget, exec, ctx, logger}`
 *                 —— 想发张卡得自己 `sender.sendMarkdown(target, text)`，
 *                    以至于主人不得不专门写一个 `send_md.mjs` 来干这一件事
 *   · 自定义命令：**最窄**，只有一个消息 ctx
 *
 * 本模块把「大家都该有」的那部分做成**一套**，三处注入同一个面：
 * 让**第三方作者**写扩展时不用再自己接生。
 *
 * ── 拿到什么（写扩展时直接 `env.xxx` / `caps.xxx`）───────────────────
 *   发送： text(s) / markdown(s) / markdownCard(s) / image(src) / voice(src) /
 *          video(src) / file(src) / media(kind, src) / at(openid)
 *   官方 API： appId / appSecret / api(path, {method, body})
 *              —— ★ 自带 token 与 2 小时缓存，**不依赖 groupAdmin 开关**
 *   持久化： store.load() / store.save(obj)   （落数据根，插件升级不丢）
 *   上下文： appendSilent(text) / appendWake(text)   ← 见下面「安全」
 *   身份：  user.{openid,name,isOwner} / owners / peer.{scope,peerId}
 *   杂项：  log(...)
 *
 * ── ★ 安全：appendSilent 必须过表面守卫 ─────────────────────────────
 * dsh 的 v4 会话格式要求 `system/message`（人设）是 surface 的**第一个节点**
 * （见 `session/surface-guard.ts` 的事故记录）。全新会话里人设还没落，
 * 此时静默 append 会**把整份会话日志写废**。
 * ⇒ 本模块的 `appendSilent` **一律先过 `canSilentlyAppend()`**，不安全就**拒绝执行**
 *   并返回 false（内容不丢：调用方可以改走 `appendWake`）。
 *   `appendWake` 走的是正常回合（dsh 会先补人设），所以**天然安全**。
 *
 * ── 设计取舍 ───────────────────────────────────────────────────
 * 不直接复用 `botplay-ext.ts` 的 `makeExtContext()`：那个 ctx 带 `card()` /
 * `clickCount` / `reloadSelf` 等**卡片专属**成员，给工具/命令用只会让作者困惑。
 * 这里只做「三套共有」的那一层，实现上仍是同一批底层原语（sender / session / token）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { registerExtToolCard } from './ext-tool-cards.js';
import { dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { canSilentlyAppend } from '../session/surface-guard.js';
import { selfRestart } from '../commands/exit.js';
// ── 自带 token 管理（不依赖 groupAdmin 开关，第三方用户也能用）──────────────
//   key = appId；value = { token, expireAt }。token 官方有效期 ~7200s，这里按 60s 余量提前过期。
const tokenCache = new Map();
async function fetchAccessToken(appId, appSecret) {
    if (!appId || !appSecret)
        return '';
    const hit = tokenCache.get(appId);
    if (hit && Date.now() < hit.expireAt)
        return hit.token;
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
    });
    const data = (await res.json());
    const token = String(data?.access_token ?? '');
    if (!token)
        throw new Error('拿 access_token 失败(检查 appId/appSecret)');
    const ttl = Number(data?.expires_in ?? 7200);
    tokenCache.set(appId, { token, expireAt: Date.now() + Math.max(60, ttl - 60) * 1000 });
    return token;
}
/** 「url 或本地路径」→ 媒体源对象（第三方作者常直接传字符串） */
function toMediaSource(src) {
    if (typeof src === 'string') {
        return /^https?:\/\//i.test(src) ? { url: src } : { localPath: src };
    }
    return src ?? {};
}
/**
 * 造一份扩展能力包。**永远不会抛**：拿不到的依赖 → 对应能力返回 false / 空值。
 *
 * @param deps - 见 {@link ExtCapsDeps}
 * @returns 能力包（见 {@link ExtCapabilities}）
 */
export function makeExtCaps(deps) {
    const logger = deps.logger;
    // ★★ 2026-11-14 修（审查发现）：selfName 必须**惰性求值**。
    //   能力包在"扩展进入之前"就构造好了，那时 deps.selfName 还是上一条消息的值/空值
    //   ⇒ 固化下来会让**所有扩展共用同一个 store 文件**（实测：两个入站扩展互相覆盖数据）。
    const selfNow = () => String(deps.selfName ?? 'ext');
    const kind = String(deps.kind ?? 'ext');
    const owners = Array.isArray(deps.owners) ? deps.owners.map(String) : [];
    const appId = String(deps.appId ?? '');
    const appSecret = String(deps.appSecret ?? '');
    const actorOpenid = String(deps.actorOpenid ?? '');
    const storeDir = deps.dataRoot ? join(deps.dataRoot, '.qqbot-extensions', kind, 'data') : '';
    /** store 文件路径 —— **惰性**：每次读写都按当前的 selfName 算（agent 可能还没进扩展） */
    const storePath = () => {
        const s = selfNow().replace(/\.(mjs?|cjs|js)$/i, '');
        return storeDir ? join(storeDir, `${s}.json`) : '';
    };
    const warn = (what, err) => {
        try {
            logger?.warn?.(`[ext-caps] ${selfNow()} ${what} 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        catch { /* 日志失败忽略 */ }
    };
    /**
     * 发送失败时把**真实原因**留一份给扩展自己看（2026-11-07 主人要求）。
     *
     * 背景：`send()` 失败只返回 false，真实错误只进 logger.warn ——
     *   宿主 diag 开关默认关的时候，扩展日志里就只剩一个 `false`，
     *   排查"文件为什么没发出去"完全没有线索（实测踩到）。
     * 这里额外往 `{dataRoot}/.qqbot/ext-deliver.log` 追加一行（**不改返回类型**，
     *   扩展仍按 boolean 判断；老扩展零影响）。
     * 文件按 2MB 轮转一份 .1，避免无限增长。
     */
    const noteDeliver = (what, ok, err) => {
        try {
            const root = String(deps.dataRoot ?? '');
            if (!root)
                return;
            const dir = join(root, '.qqbot');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, 'ext-deliver.log');
            try {
                if (statSync(file).size > 2 * 1024 * 1024)
                    renameSync(file, `${file}.1`);
            }
            catch { /* 文件不存在/读不到都无所谓 */ }
            const msg = err === undefined ? '' : ` err=${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
            appendFileSync(file, `[${new Date().toISOString()}] ${selfNow()} ${what} ok=${ok}${msg}
`, 'utf8');
        }
        catch { /* 观测失败绝不影响发送 */ }
    };
    const send = async (what, fn) => {
        // ★ 2026-11-14 修（审查发现）：成功路径**不要**落盘。
        //   noteDeliver 每次成功都 mkdirSync+statSync+appendFileSync，而发送是热路径 ——
        //   一个扩展连发 10 张图就是 10 次同步写盘，全在 await 之前串行。
        //   留痕的意义只在失败：成功时静默即可。
        try {
            await fn();
            return true;
        }
        catch (err) {
            warn(what, err);
            noteDeliver(what, false, err);
            return false;
        }
    };
    return {
        // 2026-10-25：把当前执行者 openid 也暴露出来（此前只在内部用于算 user.isOwner，
        // 扩展侧读 caps.actorOpenid 一直是 undefined，与 actorOpenid 这个已文档化的 deps 字段不对称）。
        actorOpenid: actorOpenid || undefined,
        appId,
        appSecret,
        // ★ 2026-10-16：把**数据根**也暴露出来。
        //   原因：`store` 是"每个扩展自己一份"（storeFile 按 selfName 分），
        //   而扩展之间要**共享一小份状态**时（例：`sticker_auto` 工具写开关、
        //   `outbound/sticker-semantic.mjs` 读同一个开关）需要一个**两边都算得出来的固定路径**。
        //   无 dataRoot 时是空串 —— 扩展自己判空降级，不要拿它拼相对路径写盘。
        dataRoot: String(deps.dataRoot ?? ''),
        // ── @人 ────────────────────────────────────────────────────────
        at: (id) => `<@${String(id ?? '')}>`,
        // ── 发送 ───────────────────────────────────────────────────────
        text: (s) => {
            const t = String(s ?? '');
            // ⚠️ 用 trim 判"空"，但发出去的仍是原文（不裁剪内容语义）
            if (!t.trim() || !deps.sender?.sendText)
                return Promise.resolve(false);
            return send('text', () => deps.sender.sendText(deps.replyTarget, t));
        },
        markdown: (s) => {
            const t = String(s ?? '');
            if (!t.trim() || !deps.sender?.sendMarkdown)
                return Promise.resolve(false);
            return send('markdown', () => deps.sender.sendMarkdown(deps.replyTarget, t));
        },
        markdownCard: (s, keyboard) => {
            const t = String(s ?? '');
            if (!t.trim())
                return Promise.resolve(false);
            if (deps.sender?.sendMarkdownWithKeyboard) {
                return send('markdownCard', () => deps.sender.sendMarkdownWithKeyboard(deps.replyTarget, t, keyboard));
            }
            if (deps.sender?.sendMarkdown)
                return send('markdownCard→markdown', () => deps.sender.sendMarkdown(deps.replyTarget, t));
            return Promise.resolve(false);
        },
        card: async (payload) => {
            const p = (payload && typeof payload === 'object' ? payload : {});
            const title = String(p.title ?? '').trim().slice(0, 50);
            const url = String(p.url ?? '').trim();
            if (!title || !url)
                return false;
            const description = (String(p.description ?? '').trim() || title).slice(0, 200);
            const pic_url = String(p.pic_url ?? '').trim();
            const body = { type: 'tuwen', content: { title, description, url, pic_url } };
            if (deps.sender?.sendTuwenCard) {
                const ok = await send('card', () => deps.sender.sendTuwenCard(deps.replyTarget, body));
                if (ok)
                    return true;
            }
            // 降级：markdown + 封面
            if (deps.sender?.sendMarkdown) {
                const md = `**${title}**\n\n${description}\n\n${pic_url ? `![](${pic_url})\n\n` : ''}${url}`;
                return send('card→markdown', () => deps.sender.sendMarkdown(deps.replyTarget, md));
            }
            return false;
        },
        media: (k, source) => {
            if (!deps.sender?.sendMedia) {
                // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
                //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
                //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
                noteDeliver('media', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
                return Promise.resolve(false);
            }
            return send(`media(${k})`, () => deps.sender.sendMedia(deps.replyTarget, k, toMediaSource(source)));
        },
        image: (source) => {
            if (!deps.sender?.sendMedia) {
                // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
                //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
                //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
                noteDeliver('image', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
                return Promise.resolve(false);
            }
            return send('image', () => deps.sender.sendMedia(deps.replyTarget, 'image', toMediaSource(source)));
        },
        voice: (source) => {
            if (!deps.sender?.sendMedia) {
                // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
                //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
                //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
                noteDeliver('voice', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
                return Promise.resolve(false);
            }
            return send('voice', () => deps.sender.sendMedia(deps.replyTarget, 'voice', toMediaSource(source)));
        },
        video: (source) => {
            if (!deps.sender?.sendMedia) {
                // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
                //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
                //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
                noteDeliver('video', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
                return Promise.resolve(false);
            }
            return send('video', () => deps.sender.sendMedia(deps.replyTarget, 'video', toMediaSource(source)));
        },
        file: (source) => {
            if (!deps.sender?.sendMedia) {
                // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
                //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
                //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
                noteDeliver('file', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
                return Promise.resolve(false);
            }
            return send('file', () => deps.sender.sendMedia(deps.replyTarget, 'file', toMediaSource(source)));
        },
        // ── 官方 API（自带 token；注入了 apiCall 就优先用注入的）──────────
        api: async (path, opts) => {
            const method = (opts?.method ?? 'GET');
            const p = String(path ?? '');
            if (!p)
                return { ok: false, err: { code: 'BAD_PATH', human: 'path 不能为空' } };
            if (typeof deps.apiCall === 'function') {
                try {
                    return await deps.apiCall(method, p, opts?.body);
                }
                catch (err) {
                    warn('api(injected)', err);
                }
            }
            try {
                const token = await fetchAccessToken(appId, appSecret);
                if (!token)
                    return { ok: false, err: { code: 'NO_CREDENTIALS', human: '未配置 appId/appSecret' } };
                const res = await fetch(`https://api.bot.qq.com${p.startsWith('/') ? p : `/${p}`}`, {
                    method,
                    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
                    ...(opts?.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
                });
                const text = await res.text();
                let data = text;
                try {
                    data = JSON.parse(text);
                }
                catch { /* 非 JSON 原样返回 */ }
                if (!res.ok)
                    return { ok: false, err: { code: String(res.status), human: `HTTP ${res.status}: ${text.slice(0, 200)}` } };
                return { ok: true, data };
            }
            catch (err) {
                return { ok: false, err: { code: 'THROW', human: err instanceof Error ? err.message : String(err) } };
            }
        },
        // ── 持久化（落数据根，插件升级/重装不丢）─────────────────────────
        store: {
            // ★ 2026-11-14（CodeRabbit）：load/save 是动态求值，path 却被构造时固化 —— 改成 getter
            get path() { return storePath(); },
            load() {
                if (!storePath())
                    return undefined;
                try {
                    if (!existsSync(storePath()))
                        return undefined;
                    return JSON.parse(readFileSync(storePath(), 'utf8'));
                }
                catch (err) {
                    warn('store.load', err);
                    return undefined;
                }
            },
            save(value) {
                if (!storePath())
                    return false;
                try {
                    mkdirSync(dirname(storePath()), { recursive: true });
                    writeFileSync(storePath(), JSON.stringify(value ?? null, null, 2), 'utf8');
                    return true;
                }
                catch (err) {
                    warn('store.save', err);
                    return false;
                }
            },
        },
        // ── 回调按钮卡片登记（2026-10-08 新增）──────────────────────────
        //   工具发卡时调一下，把 cardId / buttonIds 登记进
        //   `{dataRoot}/.qqbot/ext-tool-cards.json` —— 点击事件到达时插件靠它认领
        //   （分发链见 features/ext-tool-interaction.ts）。
        //   ⚠️ 纯旁路：登记失败**不影响发卡**（卡照发，只是按钮点了落回原兜底、最终只 ack）。
        registerInteractionCard: (input) => {
            try {
                if (!deps.dataRoot)
                    return false;
                const cardId = String(input?.cardId ?? '').trim();
                const buttonIds = (Array.isArray(input?.buttonIds) ? input.buttonIds : [])
                    .map((x) => String(x ?? '').trim())
                    .filter(Boolean);
                if (!cardId || buttonIds.length === 0)
                    return false;
                const expireAt = Number(input?.expireAt);
                const ttlMs = Number.isFinite(expireAt) && expireAt > Date.now() ? expireAt - Date.now() : undefined;
                return registerExtToolCard(deps.dataRoot, {
                    toolName: selfNow(),
                    cardId,
                    buttonIds,
                    scope: String(deps.scope ?? ''),
                    targetId: String(deps.peerId ?? ''),
                    ...(ttlMs === undefined ? {} : { ttlMs }),
                });
            }
            catch (err) {
                warn('registerInteractionCard', err);
                return false;
            }
        },
        // ── 上下文（★ appendSilent 必须过表面守卫）───────────────────────
        appendSilent: async (text) => {
            const t = String(text ?? '').trim();
            if (!t)
                return false;
            const session = deps.agent?.session;
            if (!session || typeof session.append !== 'function')
                return false;
            if (!canSilentlyAppend(session)) {
                try {
                    logger?.debug?.('[ext-caps] appendSilent 被拒：该会话人设尚未落盘(surface 首节点不是 system/message)，硬写会报废会话日志');
                }
                catch { /* ignore */ }
                return false;
            }
            try {
                session.append('user/message', createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user' } }), { surfaceOp: 'append' });
                return true;
            }
            catch (err) {
                warn('appendSilent', err);
                return false;
            }
        },
        appendWake: async (text) => {
            const t = String(text ?? '').trim();
            if (!t)
                return false;
            const agent = deps.agent;
            // 走正常回合：dsh 会先补人设 → 天然安全，不需要表面守卫
            if (agent && typeof agent.followup === 'function') {
                try {
                    agent.followup(createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user' } }));
                    return true;
                }
                catch (err) {
                    warn('appendWake', err);
                    return false;
                }
            }
            // 没有 followup 能力 ⇒ 退回静默 append（仍受守卫保护）
            return false;
        },
        /**
         * ★ 2026-11-05（主人定）：把**当前回合**标记为 QQ 回合。
         *
         * 为什么需要：扩展作者可能不用 `caps.wakeTo()`，而是**直接调宿主底层 API**注入消息
         * （`agent.send` / `agent.inject` / `session.append`）—— 那条路径插件感知不到，
         * 于是这一回合被判成「web 回合」，`webTurnSilent` 一开就把回复也静默了。
         * 在注入**之前**调一次本方法，这一回合的正文就照常出站（`turn/end` 自动清）。
         */
        markQqTurn: async (opts) => {
            try {
                const sc = String(deps.scope ?? '').trim();
                const pid = String(deps.peerId ?? '').trim();
                if (!sc || !pid) {
                    warn('markQqTurn', new Error('缺少 scope/peerId'));
                    return false;
                }
                const reg = await import('./session-registry.js').catch(() => undefined);
                if (!reg)
                    return false;
                const m = reg.findManagerByPeer(sc, pid);
                const rec = m?.findByPeer(sc, pid);
                if (!rec) {
                    warn('markQqTurn', new Error('该会话没有活跃记录'));
                    return false;
                }
                rec.turnOrigin = 'qq';
                rec.interjectLifted = false;
                try {
                    logger?.debug?.('[ext-caps] markQqTurn: 本回合标记为 QQ 来源' + (opts?.reason ? ' (' + opts.reason + ')' : ''));
                }
                catch { /* ignore */ }
                return true;
            }
            catch (err) {
                warn('markQqTurn', err);
                return false;
            }
        },
        /**
         * ★ 按会话标识唤醒：钩子没有"当前消息"，必须显式点名目标。
         *   真正把 `peerId → agent` 解析出来的是宿主注入的 `deps.wakeTo`（见 gateway/bootstrap.ts）；
         *   这里只做参数清洗 + 兜底，永远不抛错。
         */
        wakeTo: async (scope, peerId, text) => {
            const t = String(text ?? '').trim();
            const sc = String(scope ?? '').trim();
            const pid = String(peerId ?? '').trim();
            if (!t || !sc || !pid)
                return false;
            // ① 宿主显式注入的优先（目前只有 hooks / commands 两处注入）
            const fn = deps.wakeTo;
            if (typeof fn === 'function') {
                try {
                    if ((await fn(sc, pid, t)) === true)
                        return true;
                }
                catch (err) {
                    warn('wakeTo(deps)', err);
                }
            }
            // ② 兜底：自己按 peer 找 manager 再注入 —— 与 session_wake 工具同一条路。
            //    ⚠️ 2026-10-25 事故：caps 有六个构造方（tools/commands/hooks/botplay/inbound/outbound），
            //    逐个注入 deps.wakeTo 必然漏（实测 tools 与 commands 都漏了），于是扩展拿到一个
            //    "是函数、但恒返回 false"的 wakeTo，回执还误导成"没找到会话"。
            //    session-registry 是进程内 SessionManager 的唯一真源（settings-host 也用它），
            //    问它最可靠：findManagerByPeer(scope, peerId) → manager.injectToPeer(...)（内部 agent.followup）。
            try {
                const reg = await import('./session-registry.js');
                let m = reg.findManagerByPeer(sc, pid);
                if (!m) {
                    // ★ 2026-10-25（主人实测）：不只是宿主重启，**空闲一段时间没动静后会话也会被回收**，
                    //   活跃表里就没有这条了 → 召回永远失败。所以这里要能自己按 peer 重建会话再注入。
                    //   用 getOrCreateByPeerWeb：它内部 manager.getOrCreate(..., {scope,targetId})，
                    //   语义是"不开回合、只保证 session log 存在"，正是这种场景要的。
                    //   ⚠️ 只在**唯一实例**时自动重建：openid 按 bot 应用隔离，多实例下乱建会落到错号上，
                    //      那种情况宁可返回 false 让调用方（伴随扩展）走兜底文案。
                    const nss = (reg.listManagerNs?.() ?? []);
                    if (nss.length !== 1)
                        return false;
                    const onlyNs = nss[0];
                    if (!onlyNs)
                        return false;
                    try {
                        await reg.getOrCreateByPeerWeb(onlyNs, sc, pid, pid);
                    }
                    catch (err) {
                        warn('wakeTo(create)', err);
                    }
                    m = reg.findManagerByPeer(sc, pid);
                }
                if (!m)
                    return false;
                return (await m.injectToPeer(sc, pid, t, 'user')) === true;
            }
            catch (err) {
                warn('wakeTo(registry)', err);
                return false;
            }
        },
        canAppendSilent: () => canSilentlyAppend(deps.agent?.session),
        // ── 身份 ───────────────────────────────────────────────────────
        user: {
            openid: actorOpenid,
            name: String(deps.actorName ?? ''),
            isOwner: actorOpenid !== '' && owners.includes(actorOpenid),
        },
        owners,
        peer: { scope: String(deps.scope ?? ''), peerId: String(deps.peerId ?? '') },
        /** ★ 回灌钩子要的「父会话 id」（= `session/event` 的 `session.id`，不是 agent.id） */
        peerSessionId: String(deps.peerSessionId ?? ''),
        log: (...args) => {
            try {
                logger?.info?.(`[ext:${selfNow()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
            }
            catch { /* ignore */ }
        },
        // ── 内核句柄（遥控器）────────────────────────────────────────────
        kernel: deps.kernel,
        /**
         * 注册自己的 HTTP 路由（2026-10-26）
         *
         * 为什么需要：扩展想用自己的存储（SQLite / 自有 json / 任意目录），
         * 就得有办法把数据交给自己的 UI 卡片。卡片跑在浏览器里，只能走 HTTP。
         *
         * 用法（hooks / tools 里）：
         *   env.registerRoute('GET', '/rows', async ({ query }) => myDb.all(...));
         *   env.registerRoute('POST', '/add', async ({ body }) => { ...; return { ok: true }; });
         *
         * 卡片里：
         *   qqbotExt.api('/rows').then(r => r.data);
         *
         * 实现说明：
         *   · 实际请求走 /api/ext/dispatch?id=<extId>&p=<path>，由 settings-host 派发；
         *   · 返回 { ok:false, ... } 原样透传，其它值包成 { ok:true, data }；
         *   · method 传 '*' 表示任意方法都收；
         *   · 注册表放 globalThis.__qqbotExtRoutes —— settings-host 与扩展是两张模块图，
         *     只有全局变量能跨过去。
         */
        registerRoute: (method, path, handler, idHint) => {
            try {
                const g = globalThis;
                if (!g.__qqbotExtRoutes)
                    g.__qqbotExtRoutes = new Map();
                // ★★ 2026-11-14 修（审查发现：这个接口**从来没成功注册过**）：
                //   原来只从 deps.extId / idHint 取，而全仓库没有任何构造方传 deps.extId，
                //   文档示例也不传 idHint ⇒ extId 恒为空 ⇒ 静默 return false，前端 404 且无日志。
                //   现在回落到扩展自己的 selfName（扩展在 run 里调用时它已经有值），
                //   并把非法字符洗成下划线（settings-host 的 SAFE_ID 只认 [A-Za-z0-9_-]）。
                const rawId = String(deps.extId || idHint || selfNow() || '').trim();
                // ★★ 2026-11-14（CodeRabbit）：必须与宿主派发端的 extCfgSafeId **逐字一致**——
                //   那边是「只删非法字符、保留首尾下划线」，我原来「替换成 _ 且去首尾下划线」⇒
                //   注册键与派发键对不上 ⇒ 注册返回 true、派发却查不到处理器。
                const extId = rawId.replace(/[^A-Za-z0-9_-]/g, '');
                if (!extId) {
                    logger?.warn?.('[ext-caps] registerRoute 没有可用的扩展 id（selfName/extId/idHint 全空或被清洗成空），路由未注册');
                    // ★ 失败路径一律留痕（扩展作者看不到 logger）
                    noteDeliver('registerRoute', false, new Error('没有可用的扩展 id，路由未注册：' + JSON.stringify(rawId)));
                    return false;
                }
                const m = String(method || 'GET').toUpperCase();
                const p = String(path || '/').trim() || '/';
                g.__qqbotExtRoutes.set(extId + '|' + m + '|' + p, handler);
                return true;
            }
            catch {
                return false;
            }
        },
        // ── 入站操控（只有"手上有消息"的那一套会给值）────────────────────
        //    2026-10-12 主人定：这一组也要进能力包 —— 契约是「一套包、五套扩展」，
        //    不能只写公共部分、把入站那一块留在包外面。
        ...(deps.inbound ? { inbound: deps.inbound } : {}),
        // ── 宿主自重启（复用内置 /bot-restart 的实现，别自己 spawn）──────
        restart: (opts) => {
            const requireOwner = opts?.requireOwner !== false; // 默认：仅主人
            const isOwner = actorOpenid !== '' && owners.includes(actorOpenid);
            if (requireOwner && !isOwner) {
                try {
                    logger?.warn?.(`[ext-caps] ${selfNow()} restart 被拒：仅主人可触发（想放开就传 { requireOwner: false }）`);
                }
                catch { /* ignore */ }
                return false;
            }
            try {
                logger?.warn?.(`[ext-caps] ${selfNow()} 触发了宿主自重启（owner=${isOwner} actor=${actorOpenid || '(未知)'}）`);
            }
            catch { /* ignore */ }
            return (deps.restartImpl ?? selfRestart)(opts?.delayMs);
        },
    };
}
//# sourceMappingURL=ext-capabilities.js.map