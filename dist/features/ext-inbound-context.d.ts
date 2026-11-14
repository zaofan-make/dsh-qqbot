/**
 * ext-inbound-context.ts — 挂到中间件 `ctx` 上的「动作 API」（2026-10-12）
 *
 * 用户看到的全部能力就是这些（`examples/ext-inbound/README.md` 里的表与此一一对应）：
 *
 * ```js
 * // ── 消息维（早挂点 onInbound 用）──
 * ctx.annihilate({ reason })      // 消灭这条：不进历史 / 不进上下文 / 不占冷却（内部=不 next）
 * ctx.rewrite({ text, reason })   // 替换文本（必须在记群历史之前生效 ⇒ 早挂点）
 * ctx.forceWake({ reason })       // 强制入站：跳过价值评分 / @门控 / 冷却等"值不值得回"的判断
 * // ── 消息维（晚挂点 onDecide 用）──
 * ctx.decide({ mention: 'ignore' | 'force', reason })
 * // ── 消息维（两个挂点都能用）──
 * ctx.silentInto(text?)           // ★静默进上下文：内容进当前会话的 AI 上下文，**不唤醒**
 * // ── 用户维（两个挂点都能用）──
 * ctx.muteUser({ id?, minutes, reason })   // id 缺省 = 当前发送者；写进持久名单
 * ctx.unmuteUser({ id? })
 * ctx.isMuted(id?) / ctx.mutedUsers()      // 读名单（带剩余时间）
 * // ── 通用 ──
 * ctx.text / ctx.scope / ctx.sender / ctx.senderName / ctx.isOwner / ctx.groupId / ctx.mentions
 * ctx.quoted({ text, fromSelf }) / ctx.platform({ mentioned })
 * ctx.logger / ctx.dataRoot
 * ctx.kv.get(key) / ctx.kv.set(key, value)
 * ```
 *
 * ── `silentInto` 为什么必须存在（与 `annihilate` 的分工）────────────────────
 * `annihilate` 的语义是"**不调 next()**"⇒ 这条消息在链上被彻底拦掉，**后面组装上下文的那一步
 * 根本看不到它** —— 内容是"消失"，不是"安静地留下"。可有些场景要的恰恰是后者：
 * "这条别叫醒她，但内容得让她下次跑的时候看得到"（例：群里被引用的子会话转发、只报数的日志流）。
 * 于是补一个**注入**动作：`silentInto` 把正文塞进当前会话的 AI 上下文，不唤醒、不进群历史、
 * 不占冷却；她空闲时它就**静静躺在收件箱里**，等下一次真有回合跑起来时自然出现。
 *
 * ── 它走哪条通路（**硬要求，别改**）────────────────────────────────────────
 * 只走宿主的 `agent.inject(...)`（dsh 底层 `send(msg,'next-step',wakeup:false)`）：
 * 排队到下个 step 组包、**不拆 `tool_calls ↔ tool/result` 配对**、忙闲皆安全。
 * ⚠️ **绝不用 `session.append` / `caps.appendSilent` 硬写会话** —— 那条路绕过回合边界，
 * 落在"LLM 已回 tool_calls、工具还在执行"的中途就会把配对拆散 ⇒ 下一轮请求非法 ⇒
 * QQ 侧「本轮异常结束」。这道雷 `mc_chat` 的 daemon 早先踩过（它源码注释里写着
 * "tick 一律只走宿主的 agent.inject"），别再踩第二次。
 * 组消息这件事本身复用插件既有入口：`createUserMessage`（与 `features/group-hub.ts` 的
 * `safeAppendUserMessage`、`gateway/debounce.ts` 的插话、`commands/inject.ts` 同款形状），
 * 而不是自己拼一个 `{ role: 'user', … }` 裸对象；正文缺省值也复用 `shared/mention-clean.ts`
 * 的 `replaceBotMention`（把 `@她` 的 32 位 id 换成短标记 `@bot`，与正常入站的清洗同款）。
 *
 * 拿不到 agent（该会话还没建立 / 嵌入方没给解析器）或注入抛错 ⇒ **只告警 + 返回 false**，
 * 绝不抛到链上；审计里记 `failed-no-agent` / `failed-inject`，一眼能看出"没注进去"。
 *
 * ── 四条保命纪律（主人点名）───────────────────────────────────────────────
 *  ① **白名单最高优先**：主人/owner（`config.groupAdmin.owners`）**永不可被消灭/禁言** ——
 *     扩展对 owner 调 `annihilate` 会被**拒绝执行**并记一条 warn（消息照常放行）；`muteUser(owner)` 同理。
 *     ⚠️ **`silentInto` 不受这条限制**（有意为之，别"顺手"加上）：白名单挡的是"主人的消息被吞掉"，
 *     而静默注入**内容是进上下文的**，不存在"被吞"的风险 —— 只是换了个不叫醒她的入口。
 *     它仍然要**落审计**（可回看"谁在什么时候塞了什么"）并**计入熔断**（见 ③），
 *     所以"主人消息被扩展大规模改道"这件事依然看得见、也依然刹得住。
 *  ② **强唤醒优先于静默**：本模块只保证 `forceWake` **不被别的动作抵消**（`annihilate` 除外——
 *     那是"整条不进站"，两者本就互斥，谁先发生谁生效）；**顺序由扩展自己排**，
 *     文档里写明"求助关键词判断要写在黑名单判断之前"。
 *  ③ **熔断**：破坏性动作（消灭/静默）密度异常 ⇒ 停用该扩展的破坏性动作（消息照常放行）+ 告警。
 *     统计与阈值在 `ext-inbound-state.ts`；这里只负责"问一句、记账、拒绝"。
 *  ④ **审计 + 可撤销**：每个动作落一行 `audit.jsonl`（**文本摘要要截断**）；`muteUser` 能用
 *     `unmuteUser` 解掉。
 *
 * ── 铁律：**任何动作都绝不抛到链上** ────────────────────────────────────────
 * 每个动作整体包在 try/catch 里，出错只 `warn` 并返回 false；ctx 上的属性一律
 * `Object.defineProperty(..., { enumerable: false })` —— 不参与 `{...ctx}` 展开、
 * 不会被 JSON.stringify 抓走（内部命令层就是靠展开 ctx 组 handler 参数的，别去污染它）。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.js';
import { type ExtInboundCaps } from './ext-capabilities.js';
/** 运行环境（由挂载点/运行器传进来） */
export interface ExtRunEnv {
    /** 数据根：状态文件、审计都落它下面 */
    dataRoot: string;
    /** 主人 openid 白名单（`config.groupAdmin.owners`） */
    owners: string[];
    /** 插件 logger（动作告警用） */
    logger: Logger;
    /** 当前 bot 的 appId（`ctx.platform.mentioned` 的内容兜底扫描要用，与 SDK mentionGate 同款判据） */
    appId?: string;
    /**
     * ★ `silentInto` 用：把"**这条消息所属会话**的宿主 agent"解析出来。
     *
     * 为什么不在这里自己找：agent 在 `SessionManager` 里（挂载点持有它），本模块只拿到 `ctx`。
     * 挂载点（`gateway/middleware-setup.ts`）用 `manager.findByPeer(scope, peerId)` 实现它 ——
     * 与 `commands/inject.ts` 取"当前会话 agent"是同一口径（会话 id 由 `scope + peerId` 确定性派生，
     * 所以"这条消息将去哪"与"解析到的 agent"必然是同一个）。
     *
     * 拿不到（会话还没建立 / 嵌入方没传）⇒ 返回 undefined，`silentInto` 只告警、不注入。
     */
    resolveAgent?: (ctx: MiddlewareContext) => unknown;
    /** 当前会话的发送器（发消息 / 发富媒体用）。没有 = 发送类能力不可用 */
    sender?: unknown;
    /** 当前这条消息的回复目标（被动回复优先，缺了退主动发送） */
    replyTarget?: unknown;
    /** bot 密钥（`api()` 自建 token 兜底用；给了 apiCall 就优先用 apiCall） */
    appSecret?: string;
    /** 带 token 的官方 API 调用（挂载点从 `manager.groupAdmin.apiCall` 取） */
    apiCall?: unknown;
    /** 插件自己的 cordis Context —— 统一能力包里的 `kernel`（"遥控器"） */
    kernel?: unknown;
}
/** `silentInto` 的结果码（审计的 `result` 与 `ctx.extState.silentInto` 共用这一套词） */
export type SilentIntoResult = 
/** 本次真的注入成功 */
'ok'
/** 之前已经注入过（幂等命中，本次没重复塞） */
 | 'ok-duplicate'
/** 文本空/全空白 ⇒ 不注入（别往上下文里塞空消息） */
 | 'refused-empty'
/** 参数不合法（非字符串、也非 `{ text }`）⇒ 不注入（绝不 `String(未知对象)` 塞进去） */
 | 'refused-invalid'
/** 熔断中：该扩展的破坏性动作被停用（`silentInto` 也算在内） */
 | 'refused-breaker'
/** 拿不到宿主 agent（会话还没建立 / 环境没给解析器） */
 | 'failed-no-agent'
/** `agent.inject` 抛错 */
 | 'failed-inject';
/** 一条消息、一个中间件 ctx 对应的一份扩展会话（早/晚两个挂点共享同一份） */
export interface ExtCtxSession {
    env: ExtRunEnv;
    /** 当前在跑哪个挂点：早 `inbound` / 晚 `decide` */
    phase: 'inbound' | 'decide';
    /** 当前正在执行的扩展（动作归属、审计署名、熔断统计都认它） */
    current?: {
        file: string;
        name: string;
        path?: string;
    };
    /** 已请求消灭（读它的地方是运行器的 next 包装：置位后再调 next() 也不会往下走） */
    annihilate?: {
        reason?: string;
    };
    /**
     * 请求过消灭但**被拒**（白名单 / 熔断 / 挂点不允许）。
     *
     * 为什么必须记下来：扩展最常见的写法是
     * ```js
     * if (该消灭) { ctx.annihilate({ reason }); return; }   // 只调动作，不调 next
     * ```
     * 一旦 annihilate 被拒，`return` 仍然会让链停在这一层 —— 等于"插件拒绝了，消息还是被吞了"。
     * 所以运行器看到这个标记时会**替扩展放行**（白名单最高优先 / 熔断后只放行）。
     */
    annihilateRefused?: {
        reason: string;
    };
    /** 已请求强制入站 */
    forceWake?: {
        reason?: string;
    };
    /** 已覆盖 @ 判定 */
    decide?: {
        mention: 'ignore' | 'force';
        reason?: string;
    };
    /**
     * ★ 本消息的静默注入状态（`silentInto`）。
     *
     * **幂等**：`injected === true` 之后，本 ctx（= 这**一条**消息）再调多少次 `silentInto` 都不会
     * 重复塞（早/晚两个挂点共用同一份会话 ⇒ 跨挂点也只塞一次）。
     * 只有**成功**才置 `injected`：失败（拿不到 agent / 熔断 / 空文本）不留痕 ——
     * 晚挂点若那时才拿到 agent，仍然可以再试一次。
     */
    silentInto?: {
        injected: boolean;
        result: SilentIntoResult;
        chars: number;
    };
    /** 本消息里 rewrite 过几次（诊断） */
    rewriteCount: number;
    /** 本消息里破坏性动作成功过几次（熔断统计看增量） */
    destructiveCount: number;
    /** 参与记账去重：同一个扩展在同一条消息上（早+晚）只记一次参与 */
    noted: Set<string>;
    /** 已告警过的提示（一次性，防刷屏） */
    warned: Set<string>;
}
/** 取（必要时建）某个 ctx 的扩展会话，并把动作 API 挂上去（幂等） */
export declare function ensureExtSession(ctx: MiddlewareContext, env: ExtRunEnv, current?: {
    file: string;
    name: string;
    path?: string;
}): ExtCtxSession;
/** 只读会话（没挂过则 undefined） */
export declare function sessionOf(ctx: MiddlewareContext): ExtCtxSession | undefined;
/**
 * 进入某个扩展的执行：设置归属 + 挂点，返回会话。
 * 调用方（运行器）负责在用完之后吞掉异常 —— 本模块的动作自己不会抛。
 */
export declare function enterExtension(ctx: MiddlewareContext, env: ExtRunEnv, ext: {
    file: string;
    name: string;
    path?: string;
}, phase: 'inbound' | 'decide'): ExtCtxSession;
export declare function inboundCapsOf(ctx: MiddlewareContext, s: ExtCtxSession): ExtInboundCaps;
//# sourceMappingURL=ext-inbound-context.d.ts.map