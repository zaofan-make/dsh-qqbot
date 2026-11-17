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
import { type SegmentSnapshot } from './segment-ledger.js';
import type { Logger } from '../types.js';
/** 媒体类型（与 sender.sendMedia 的 kind 对齐） */
export type ExtMediaKind = 'image' | 'voice' | 'video' | 'file';
/** 媒体源：URL 或本机绝对路径（二选一） */
export interface ExtMediaSource {
    url?: string;
    localPath?: string;
}
/** 宿主 sender 里我们用到的子集（全部 duck-typing + 缺失即降级） */
export interface ExtSenderLike {
    sendText?: (target: unknown, text: string) => Promise<unknown>;
    sendMarkdown?: (target: unknown, content: string) => Promise<unknown>;
    sendMarkdownWithKeyboard?: (target: unknown, content: string, keyboard?: unknown) => Promise<unknown>;
    sendMedia?: (target: unknown, kind: string, source: ExtMediaSource) => Promise<unknown>;
    /** 图文卡片（官方 msg_type=8）；没有就由 env.card 自动降级成 markdown */
    sendTuwenCard?: (target: unknown, card: {
        type: 'tuwen';
        content: {
            title: string;
            description: string;
            url: string;
            pic_url: string;
        };
    }) => Promise<unknown>;
}
/** 官方 API 调用结果（与 GroupAdminClient.apiCall 同形） */
export type ExtApiResult = {
    ok: true;
    data: unknown;
} | {
    ok: false;
    err: {
        code: string;
        human: string;
    };
};
/** 构造能力包的依赖（能给的都给，给不了的自动降级为「调用返回 false」） */
export interface ExtCapsDeps {
    /** 数据根（store 落盘用）。空 = store 不可用 */
    dataRoot?: string;
    logger?: Logger;
    /** bot 凭证（api / appId / appSecret 用） */
    appId?: string;
    appSecret?: string;
    /** 主人 openid 列表（user.isOwner / owners） */
    owners?: string[];
    /** 当前会话的发送器与目标（没有 = 发送类能力不可用） */
    sender?: ExtSenderLike;
    replyTarget?: unknown;
    /** 当前会话的 agent（appendSilent / appendWake 用） */
    agent?: {
        session?: unknown;
        followup?: (msg: unknown) => unknown;
    } | undefined;
    /**
     * ★ **按会话标识唤醒 AI**（钩子专用）。`wakeTo(scope, peerId, text)`：
     *   `scope` = `"group" | "c2c"`；`peerId` = 群 openid / 用户 openid。
     *
     * 为什么钩子需要它：钩子没有"当前消息"，拿不到"回谁"，只能**显式点名**目标
     * （通常来自钩子自己的配置文件）。实现走 `agent.followup(createUserMessage(...))` ——
     * 与 `appendWake` 同一条路，是**正常回合**（dsh 会先补人设），不是旁路注入。
     */
    wakeTo?: (scope: string, peerId: string, text: string) => Promise<boolean>;
    /** 当前会话标识 + 称呼（peer / user 展示用） */
    scope?: string;
    peerId?: string;
    /**
     * 本会话的 **DSH 会话 id**（= `manager.sessionIdFor(scope, peerId)`）。
     * ★ 2026-10-13 加：回灌钩子（`session_watch_lib` 的 `parentEntryOf`）匹配的是
     *   `session/event` 里那个 `session.id`，**不是 `agent.id`**；
     *   命令侧原先连"会话 id"都拿不到 ⇒ 回灌钩子永远挂不上（现象：建完显示「回灌 → 未挂」）。
     */
    peerSessionId?: string;
    /** 触发者（命令的发送者 / 工具的调用会话所属人） */
    actorOpenid?: string;
    actorName?: string;
    /** 带 token 的官方 API 调用（注入了就优先用它，否则用本模块自带的 token 管理） */
    apiCall?: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<ExtApiResult>;
    /**
     * 踢人（2026-11-17 加，主人要求"踢人暴露给扩展"）
     *
     * 内部走 `GroupAdminClient.removeMembers`（官方 2026-11-16 起「批量移除」已正式开放）。
     * 帮你处理好这几件麻烦事：
     *   · **不用扫码**（用机器人自己的 appId/appSecret 换 token）
     *   · 一次 ≤20 个，超了在这里拦下
     *   · 失败时 `msg` 已经是人话（`40103011`/`40103012` 会直接告诉你"去哪个开关开"）
     *
     * ⚠️ **只认 openid，不认 QQ 号** —— 官方「拉群成员列表」还在内邀中，
     *    所以别指望用它查名单；要名单/QQ 号请走网页版（`/api/qqbot-settings/qun/members`）。
     *
     * @example
     * ```js
     * const r = await env.kick({ openids: [someOpenid] });
     * if (!r.ok) return `踢不动: ${r.msg}`;
     * ```
     */
    kick?: (opts: {
        /** 目标群 openid；不传 = 当前会话所在的群 */
        gid?: string;
        /** 要移除的成员 openid（≤20） */
        openids: string[];
        /** 可选，同时拉黑（⚠️ 官方文档 2026-11-16 已删该字段，服务端还认、随时可能失效） */
        blacklist?: boolean;
    }) => Promise<{
        ok: boolean;
        msg: string;
    }>;
    /** 扩展名（store 文件名 / 日志前缀） */
    selfName?: string;
    /** 当前发言者身份（文档 §2「身份」承诺的字段） */
    user?: {
        openid?: string;
        name?: string;
        /** 是否主人（已比对 owners 白名单，扩展不用自己算） */
        isOwner?: boolean;
    };
    /** 当前会话标识（文档 §2「身份」承诺的字段） */
    peer?: {
        scope?: string;
        peerId?: string;
    };
    /** 宿主注入的通用配置（含 bot 的 appId/appSecret；扩展可自取凭证换 token） */
    config?: {
        appId?: string;
        appSecret?: string;
        [k: string]: unknown;
    };
    /** 便捷布尔：等价于 user.isOwner（顶层，最省事的判据） */
    isOwner?: boolean;
    /** 发送者 openid 的平铺别名（部分扩展按这些名字找身份） */
    senderOpenid?: string;
    userOpenid?: string;
    openid?: string;
    /** 扩展种类：tools / commands（决定 store 落在哪个子目录） */
    kind?: string;
    /**
     * ★ 插件 ctx（"遥控器"）—— 见 {@link ExtCapabilities.kernel}。
     * 由调用方把插件的 cordis Context 原样传进来；不传 = 没有这个能力。
     */
    kernel?: unknown;
    /** ★ 入站操控（只有入站扩展能提供；见 {@link ExtInboundCaps}） */
    inbound?: ExtInboundCaps;
    /**
     * 自重启实现（仅供测试注入；生产走内置 `selfRestart`）。
     * ⚠️ 真跑它会 spawn 一个助手去 kill 宿主进程 —— 测试里**必须**用这个接缝替换。
     */
    restartImpl?: (delayMs?: number) => boolean;
}
/** 能力包对外形状（写扩展时看到的就是这个） */
/**
 * ★ **入站操控**（2026-10-12 主人定：并入统一能力包）。
 *
 * 为什么单独成组、而且是**可选**的：这几项只有在"手上有一条正在进站的消息"时才有意义 ——
 * 也就是**入站扩展**（第五套，挂点 onInbound / onDecide）手里。其余四套（工具/命令/
 * 卡片/钩子）大多在"消息早就进完了"的时候才跑，给它们一个空壳只会误导。
 *
 * 于是契约写成：**一套包，五套扩展**；包的公共部分人人都有，
 * 这一组"有值就说明你现在正握着一条消息的处置权"。
 *
 * ⚠️ 三条语义（与入站扩展文档一致，改动前先读 `examples/ext-inbound/README.md`）：
 *   ① annihilate = **不调 next()**：这条不进群历史、不进上下文、不占冷却；
 *   ② rewrite 在早挂点会**连群历史一起改**；
 *   ③ silentInto = 内容**静默进上下文**（不唤醒），与 annihilate 是"消失"vs"安静留下"的区别。
 */
export interface ExtInboundCaps {
    /**
     * 消灭这条消息（早挂点；晚挂点会被拒绝 + 告警）。
     *
     * ★ **`ownerAck`（2026-10-14 新增，唯一能吞主人消息的通道）**
     *   默认情况下**主人的消息永不可被消灭**（白名单最高优先），`annihilate` 会直接返回 false。
     *   但有一类场景是**主人自己的意图**：例如"二档路由隔绝"—— 主人明确要求把带路由标记的
     *   消息投递到别的会话、**且不要留在本会话上下文里**。这时扩展可传 `ownerAck: true`
     *   声明"这条我已经另行投递走了，请允许对主人生效"。
     *
     *   三条纪律：
     *     ① 只在"你确实已经把内容投递到别处"时传，否则主人的话会凭空消失；
     *     ② 用了它**一定落审计**（`result: 'ok-owner-ack'`），事后可查"哪条主人的消息被谁吞了、为什么"；
     *     ③ 它只解开**这一条**的白名单，不影响熔断等其它保护。
     */
    annihilate(opts?: {
        reason?: string;
        ownerAck?: boolean;
    }): boolean;
    /** 改写正文（早挂点连群历史一起改） */
    rewrite(opts?: {
        text?: string;
        reason?: string;
    }): boolean;
    /** 强制入站：跳过 @门控 / 价值评分 / 群冷却（不等于"她一定会说话"） */
    forceWake(opts?: {
        reason?: string;
    }): boolean;
    /** 覆盖 @ 判定（晚挂点；早挂点会被拒绝 + 告警） */
    decide(opts?: {
        mention?: 'ignore' | 'force';
        reason?: string;
    }): boolean;
    /** 静默进上下文：内容进 AI 上下文、**不唤醒**（走宿主 agent.inject，不拆 tool 配对） */
    silentInto(text?: string | {
        text?: string;
        reason?: string;
    }): boolean;
    /**
     * **直接回一句**（2026-11-11 新增；走正常出站，不唤醒 AI、不进会话历史）。
     *
     * 以前入站扩展只能「改写 / 消灭 / 静默注入」，想在收到消息的当下回一句只能做成命令。
     * 现在给这条通道，但有四道约束：
     *   ① 走 `sender.sendMarkdown` + 本条的 replyTarget（引用/分段/限速照旧）；
     *   ② 每次回话**落审计**（署名哪个扩展），出事可查；
     *   ③ 它只是"插件替你说了一句"，模型不会以为自己说过。
     * **不做限频**（2026-11-11 主人定：扩展的自由度不该被替用户砍掉）。
     * @returns true=已发出；false=被限频/环境没接线/发送失败
     */
    reply(text?: string | {
        text?: string;
    }): Promise<boolean>;
    /** 这条消息所属的 DSH 会话 id（2026-11-11 新增；以前入站 ctx 拿不到） */
    readonly sessionId: string;
    /** 用户维禁言（名单持久化、带期限、过期惰性清理） */
    /** 禁言：成功返回名单条目（{id,until,reason,by}；until=0 表示永久），失败返回 false（原因见审计） */
    muteUser(opts?: {
        id?: string;
        minutes?: number;
        reason?: string;
        by?: string;
    }): unknown;
    unmuteUser(opts?: {
        id?: string;
    }): boolean;
    /** 查禁言：null = 没被禁言；否则返回名单条目（过期项惰性清理） */
    isMuted(id?: string): unknown;
    mutedUsers(): unknown[];
    /** 这条消息的只读视图（读的时候现算，不是快照） */
    message: {
        text: string;
        sender: string;
        senderName: string;
        scope: 'group' | 'c2c';
        groupId: string;
        isOwner: boolean;
        mentions: unknown[];
        quoted: {
            text: string;
            id?: string;
            fromSelf?: boolean;
        } | undefined;
        platform: {
            mentioned: boolean;
        };
    };
    /** 该扩展自己的持久化（与禁言名单同一个文件） */
    kv: {
        get(key: string): unknown;
        set(key: string, value: unknown): boolean;
    };
}
export interface ExtCapabilities {
    /** 当前执行者 openid（群聊=author.member_openid，单聊=author.user_openid） */
    actorOpenid?: string;
    appId: string;
    appSecret: string;
    /** ★ 2026-10-16：数据根（扩展之间共享一小份状态时用它拼固定路径；空串=拿不到，别拿它拼相对路径写盘） */
    dataRoot: string;
    /**
     * 踢人（2026-11-17 加，主人要求"踢人暴露给扩展"）
     *
     * 官方 2026-11-16 起「批量移除群成员」已正式开放，扩展可直接调。
     *   · **不用扫码**（用机器人自己的 appId/appSecret 换 token）
     *   · 一次 ≤20 个，超了在这里拦下
     *   · 失败时 `msg` 已是人话（`40103011`/`40103012` 直接告诉你"去哪个开关开"）
     *
     * ⚠️ **只认 openid，不认 QQ 号** —— 官方「拉群成员列表」还在内邀中，
     *    别指望用它查名单；要名单/QQ 号走网页版那条路。
     *
     * @example
     * ```js
     * const r = await env.caps.kick({ openids: [someOpenid] });
     * if (!r.ok) return `踢不动: ${r.msg}`;
     * ```
     */
    kick?: (opts: {
        /** 目标群 openid；不传 = 当前会话所在的群 */
        gid?: string;
        /** 要移除的成员 openid（≤20） */
        openids: string[];
        /** 可选，同时拉黑（⚠️ 官方文档 2026-11-16 已删该字段，服务端还认、随时可能失效） */
        blacklist?: boolean;
    }) => Promise<{
        ok: boolean;
        msg: string;
    }>;
    /**
     * **上一段消息的快照**（2026-11-17 主人定，给扩展作者用）。
     *
     * 「一段」= 上一次唤醒到现在这段。为什么不能自己查：
     *   · 宿主的 `user/message` 的 `source` 只有 `{ kind: 'user' }`，append 之后 senderId 就没了；
     *   · 防抖窗口虽有 senderId，但 flush 完就销毁，且只覆盖"还没派发的"；
     *   · 落盘台账（msg-history）能查，但要读文件，每回合扫全段太慢。
     *   ⇒ 插件在**入站那一刻**记一笔（`segment-ledger`），唤醒时定格成快照。
     *
     * 返回（没快照时 `undefined`）：
     * ```js
     * {
     *   items: [{ id, s, n, t, k, x, me }],  // ← 与 msg-history.HistoryRec 完全同款
     *   hasOwner: boolean,     // 这段里主人说过话吗
     *   ownerCount: number,    // 主人说了几条
     *   total: number,         // 这段一共几条
     *   wokeByOwner: boolean,  // 这次是不是主人叫醒的
     *   wokeBy: string,        // 触发唤醒那条的 message_id
     *   capturedAt: number,
     * }
     * ```
     */
    prevSegment(): SegmentSnapshot | undefined;
    at(id: string): string;
    text(s: string): Promise<boolean>;
    markdown(s: string): Promise<boolean>;
    markdownCard(s: string, keyboard?: unknown): Promise<boolean>;
    /**
     * 发**图文卡片**（官方 msg_type=8；2026-10-29 封装）。
     * `env.card({ title, description, url, pic_url })` —— title ≤50 / description ≤200 / url、pic_url 必 https ≤1024。
     * 卡片发不出去时**自动降级**成「markdown + 封面图」。
     */
    card(payload: {
        title: string;
        description?: string;
        url: string;
        pic_url?: string;
    }): Promise<boolean>;
    media(kind: ExtMediaKind, source: ExtMediaSource): Promise<boolean>;
    image(source: ExtMediaSource | string): Promise<boolean>;
    voice(source: ExtMediaSource | string): Promise<boolean>;
    video(source: ExtMediaSource | string): Promise<boolean>;
    file(source: ExtMediaSource | string): Promise<boolean>;
    api(path: string, opts?: {
        method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        body?: unknown;
    }): Promise<ExtApiResult>;
    store: {
        load<T = unknown>(): T | undefined;
        save(value: unknown): boolean;
        path: string;
    };
    /**
     * ★ 登记本工具发出的「回调按钮卡片」（2026-10-08 新增，见 features/ext-tool-cards.ts）。
     *
     * 为什么必须登记：按钮 data 形如 `ext:<工具名>:<卡id>:<按钮id>`，插件收到点击后
     * **要能在注册表里查到这张卡** 才会把事件派发给本工具的 `onInteraction`。
     * 不登记 = 卡照发，但按钮点了没人认（落回原兜底，最终只 ack）。
     *
     * ```js
     * const cardId = 'v' + Date.now().toString(36);
     * env.registerInteractionCard({ cardId, buttonIds: ['yes', 'no'], expireAt: Date.now() + 86400_000 });
     * await env.markdownCard('要投「A」吗？', { content: { rows: [ { buttons: [
     *   { id: 'b1', render_data: { label: '投 A', visited_label: '已投 A', style: 1 },
     *     action: { type: 1, permission: { type: 2 },
     *               data: 'ext:vote:' + cardId + ':yes' } } ] } ] } });
     * ```
     *
     * @param input.cardId 卡 id（必须与按钮 data 里的第二段**完全一致**）
     * @param input.buttonIds 这张卡上所有回调按钮的 id（漏一个 → 那个按钮点了没人认）
     * @param input.expireAt 可选绝对过期时间(ms)；缺省 7 天（投票/签到建议 1~3 天）
     * @returns 是否登记成功；**失败也不影响发卡**（纯旁路）
     */
    registerInteractionCard(input: {
        cardId: string;
        buttonIds: string[];
        expireAt?: number;
    }): boolean;
    appendSilent(text: string): Promise<boolean>;
    appendWake(text: string): Promise<boolean>;
    /**
     * ★ **唤指定会话的 AI**（钩子 / 定时任务专用）。
     * @param scope `"group"` 群 / `"c2c"` 私聊
     * @param peerId 群 openid 或 用户 openid
     * @param text 要"当成用户说的话"注入的正文（走正常回合，dsh 会先补人设）
     * @returns 已投递 = true；目标会话不存在 / 宿主没接这能力 = false（不抛错）
     */
    wakeTo(scope: string, peerId: string, text: string): Promise<boolean>;
    /**
     * 把**当前回合**标记为 QQ 回合（2026-11-05 主人定，配合设置项 `webTurnSilent`）。
     *
     * 什么时候需要：你不用 `caps.wakeTo()`、而是**直接调宿主底层 API**注入消息
     * （`agent.send` / `agent.inject` / `session.append` …）—— 那条路径插件感知不到，
     * 于是这一回合会被判成「web 回合」，`webTurnSilent` 一开就把回复也静默了。
     *
     * 用法：**在注入之前**调一次即可，之后这一回合的正文照常发 QQ，`turn/end` 自动清。
     * 返回 `false` = 拿不到当前会话记录（说明不是在 QQ 会话上下文里调的）。
     */
    markQqTurn(opts?: {
        reason?: string;
    }): Promise<boolean>;
    canAppendSilent(): boolean;
    user: {
        openid: string;
        name: string;
        isOwner: boolean;
    };
    owners: string[];
    peer: {
        scope: string;
        peerId: string;
    };
    /** ★ 回灌钩子要的「父会话 id」（= `session/event` 的 `session.id`，不是 agent.id） */
    peerSessionId: string;
    log(...args: unknown[]): void;
    /**
     * ★ **内核句柄（"遥控器"）**= 本插件自己的 cordis Context（`ctx`）。
     *
     * 拿到它就能做**受控能力包做不到的事**：
     * ```js
     * const ctx = env.kernel;
     * ctx.get('sessions')                 // 读/建会话
     * ctx.get('tools')                    // 工具注册表
     * ctx.compaction.compactNow(a, s, id) // 调宿主的上下文压缩
     * ctx.on('session/event', fn)         // 订阅宿主事件
     * ctx.webServer.register({ path, handler })  // 开一个 HTTP 路由
     * ```
     *
     * ⚠️ **三条代价（用之前先读）**：
     * 1. **跟随宿主版本**：`ctx` 的形状由 dsh 决定，宿主升级可能让这段代码失效 ——
     *    所以「成品能力」才是主路，`kernel` 是**逃生舱**。
     * 2. **注册要自己收尾**：`ctx.tools.register()` / `ctx.on()` / `ctx.webServer.register()`
     *    都返回 disposer；不 dispose 的话，热重载会**不断累积**（本插件自己也踩过这个坑，
     *    见维护手册铁律 8：disposer 要存到跨模块实例可见的地方）。
     * 3. **全权限**：它等价于"把遥控器交出去"。这是**你自己机器上、你自己写的代码**，
     *    所以本来就是你的权利 —— 但别把它转手给不信任的代码。
     */
    kernel: unknown;
    /** 注册自己的 HTTP 路由（2026-10-26）—— 让扩展用自有存储 + 自己的 UI 卡片 */
    registerRoute?: (method: string, path: string, handler: (c: unknown) => unknown, idHint?: string) => boolean;
    /**
     * ★ **入站操控**（见 {@link ExtInboundCaps}）：**只有入站扩展（第五套）手里有值** ——
     * 只有它在"一条消息正在进站"的时刻跑。别的四套拿它会是 undefined，这不是缺失，是语义。
     * 平铺在 ctx 上的同款动作（ctx.annihilate 等）与这里是**同一份实现**，不是两套。
     */
    inbound?: ExtInboundCaps;
    /**
     * 触发宿主自重启（等价于内置的 `/bot-restart`）。
     *
     * 实现直接复用插件自己的 `selfRestart()` —— 它已经填平了所有坑
     * （动态识别启动命令、**强制补 `--no-open`**、助手写系统 tmpdir 避开中文路径、
     * detached+unref 保证宿主被杀后照样能拉起）。**别自己 spawn，很容易写错。**
     *
     * @param opts.requireOwner - 默认 `true`：只有主人（`env.user.isOwner`）触发才生效，
     *   防止 AI 被群友一句话钓去重启机器人。**你自己的场景要谁都能重启，就传 `false`。**
     * @param opts.delayMs - 延迟多久开始（默认 1600ms，给回执留时间）
     * @returns 是否已触发（不代表重启成功，只代表助手已脱手启动）
     */
    restart(opts?: {
        requireOwner?: boolean;
        delayMs?: number;
    }): boolean;
}
/**
 * 造一份扩展能力包。**永远不会抛**：拿不到的依赖 → 对应能力返回 false / 空值。
 *
 * @param deps - 见 {@link ExtCapsDeps}
 * @returns 能力包（见 {@link ExtCapabilities}）
 */
export declare function makeExtCaps(deps: ExtCapsDeps): ExtCapabilities;
//# sourceMappingURL=ext-capabilities.d.ts.map