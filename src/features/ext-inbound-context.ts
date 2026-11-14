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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.js';
import { lastBotReplyOf } from './bot-reply-memo.js';
// ★ 统一能力包（2026-10-12 主人定「能力面对齐」）：入站扩展与另外四套共用同一份能力实现，
//   见 `decorate()` 里那段「★★ 能力面对齐 ★★」；别再给入站侧另造一套平行 API。
import { makeExtCaps, type ExtInboundCaps } from './ext-capabilities.js';
import { replaceBotMention, type MentionLike } from '../shared/mention-clean.js';
import {
  appendAudit,
  checkDestructiveAllowed,
  isMuted as stateIsMuted,
  mutedUsers as stateMutedUsers,
  muteUser as stateMuteUser,
  noteDestructive,
  readExtState,
  unmuteUser as stateUnmuteUser,
  writeExtState,
  type ExtMute,
  type ExtMuteView,
} from './ext-inbound-state.js';

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

  // ── ★ 2026-10-12 主人定「能力面对齐」：给统一能力包（makeExtCaps）用的输入 ──
  //    入站扩展必须和另外四套（自定义命令 / 扩展工具 / botplay 卡片 / 启动钩子）
  //    拿到**同一套**能力包，见 `docs/USER-GUIDE.md` §「统一能力包」。
  //    这几个字段由挂载点（gateway/middleware-setup.ts）喂进来；缺哪个，对应能力
  //    就优雅降级（契约写明"拿不到依赖返回 false，不抛"），不会影响入站主链。
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
  | 'ok'
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
  current?: { file: string; name: string };
  /** 已请求消灭（读它的地方是运行器的 next 包装：置位后再调 next() 也不会往下走） */
  annihilate?: { reason?: string };
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
  annihilateRefused?: { reason: string };
  /** 已请求强制入站 */
  forceWake?: { reason?: string };
  /** 已覆盖 @ 判定 */
  decide?: { mention: 'ignore' | 'force'; reason?: string };
  /**
   * ★ 本消息的静默注入状态（`silentInto`）。
   *
   * **幂等**：`injected === true` 之后，本 ctx（= 这**一条**消息）再调多少次 `silentInto` 都不会
   * 重复塞（早/晚两个挂点共用同一份会话 ⇒ 跨挂点也只塞一次）。
   * 只有**成功**才置 `injected`：失败（拿不到 agent / 熔断 / 空文本）不留痕 ——
   * 晚挂点若那时才拿到 agent，仍然可以再试一次。
   */
  silentInto?: { injected: boolean; result: SilentIntoResult; chars: number };
  /** 本消息里 rewrite 过几次（诊断） */
  rewriteCount: number;
  /** 本消息里破坏性动作成功过几次（熔断统计看增量） */
  destructiveCount: number;
  /** 参与记账去重：同一个扩展在同一条消息上（早+晚）只记一次参与 */
  noted: Set<string>;
  /** 已告警过的提示（一次性，防刷屏） */
  warned: Set<string>;
}

const SESSIONS = new WeakMap<object, ExtCtxSession>();

/** 取（必要时建）某个 ctx 的扩展会话，并把动作 API 挂上去（幂等） */
export function ensureExtSession(
  ctx: MiddlewareContext,
  env: ExtRunEnv,
  current?: { file: string; name: string },
): ExtCtxSession {
  const key = ctx as unknown as object;
  let s = SESSIONS.get(key);
  if (!s) {
    s = {
      env,
      // ★ 2026-11-14：创建时就带归属，别等 enterExtension（decorate 期间 store 路径要用）
      current,
      phase: 'inbound',
      rewriteCount: 0,
      destructiveCount: 0,
      noted: new Set<string>(),
      warned: new Set<string>(),
    };
    SESSIONS.set(key, s);
    decorate(ctx, s);
  } else {
    // 同一个 ctx 可能先后经过两个挂点：只补缺的环境字段（appId / resolveAgent 可能后到）
    if (!s.env.dataRoot && env.dataRoot) s.env.dataRoot = env.dataRoot;
    if (env.appId && !s.env.appId) s.env.appId = env.appId;
    if (!s.env.owners.length && env.owners.length) s.env.owners = env.owners;
    if (env.resolveAgent && !s.env.resolveAgent) s.env.resolveAgent = env.resolveAgent;
  }
  return s;
}

/** 只读会话（没挂过则 undefined） */
export function sessionOf(ctx: MiddlewareContext): ExtCtxSession | undefined {
  return SESSIONS.get(ctx as unknown as object);
}

/**
 * 进入某个扩展的执行：设置归属 + 挂点，返回会话。
 * 调用方（运行器）负责在用完之后吞掉异常 —— 本模块的动作自己不会抛。
 */
export function enterExtension(
  ctx: MiddlewareContext,
  env: ExtRunEnv,
  ext: { file: string; name: string },
  phase: 'inbound' | 'decide',
): ExtCtxSession {
  const cur = { file: ext.file, name: ext.name };
  const s = ensureExtSession(ctx, env, cur);
  s.current = cur;
  s.phase = phase;
  return s;
}

// ══════════════════════════════════════════════════════════════
// 小工具：告警 / 审计 / 字段读取
// ══════════════════════════════════════════════════════════════

/** 扩展展示名（日志/审计署名）：没有 current 时兜一个匿名 */
function who(s: ExtCtxSession): string {
  return s.current?.name || s.current?.file || '(匿名扩展)';
}

/** 告警（带扩展名；日志接口缺 warn 时静默） */
function warn(s: ExtCtxSession, msg: string): void {
  try { s.env.logger?.warn?.(`[ext-inbound:${who(s)}] ${msg}`); } catch { /* ignore */ }
}

/** 同一句提示只告警一次（群消息多，别刷屏；改文件热重载后自然重置） */
function warnOnce(s: ExtCtxSession, key: string, msg: string): void {
  if (s.warned.has(key)) return;
  s.warned.add(key);
  warn(s, msg);
}

/**
 * 数据根可用性检查。
 * ⚠️ dataRoot 为空时，**名单 / kv / 审计一律降级为空操作** —— 否则 `join('', '.qqbot-extensions', …)`
 *    会按相对路径在当前工作目录里造目录写文件（测试或嵌入方没传 dataRoot 时就会发生）。
 */
function rootOk(s: ExtCtxSession): boolean {
  if (s.env.dataRoot) return true;
  warnOnce(s, 'no-dataroot', '运行环境没给 dataRoot → 禁言名单 / kv / 审计本次全部降级为空操作（不写盘）');
  return false;
}

/** 写审计（署名当前扩展；**永不抛出**） */
function audit(s: ExtCtxSession, entry: Parameters<typeof appendAudit>[1]): void {
  try {
    if (!rootOk(s)) return;
    appendAudit(s.env.dataRoot, { file: s.current?.file, name: s.current?.name, ...entry });
  } catch { /* ignore */ }
}

/** 当前发送者 openid */
function senderOf(ctx: MiddlewareContext): string {
  try { return String((ctx.message as { senderId?: unknown } | undefined)?.senderId ?? ''); } catch { return ''; }
}

/** 当前消息文本 */
function textOf(ctx: MiddlewareContext): string {
  try { return String((ctx.message as { content?: unknown } | undefined)?.content ?? ''); } catch { return ''; }
}

/** 是否主人（白名单判定：与 botplay/ext-caps 同口径 —— config.groupAdmin.owners 里有没有这个 openid） */
function ownerOf(s: ExtCtxSession, id: string): boolean {
  return id !== '' && s.env.owners.includes(id);
}

/** 与 SDK mentionGate 同款三选一判据（本扩展点在门控之前，读不到 ctx.state.mention，只能自己判） */
function platformMentioned(ctx: MiddlewareContext, appId: string | undefined): boolean {
  try {
    const m = ctx.message as unknown as {
      rawEventType?: unknown;
      mentions?: Array<{ is_you?: boolean }> | undefined;
      content?: unknown;
    };
    if (String(m?.rawEventType ?? '') === 'GROUP_AT_MESSAGE_CREATE') return true;
    if (Array.isArray(m?.mentions) && m.mentions.some((x) => x?.is_you === true)) return true;
    return detectMentionInContent(String(m?.content ?? ''), appId);
  } catch {
    return false;
  }
}

/** 内容里是否含 `<@{appId}>` / `<@!{appId}>`（与 media-history / SDK mention-gate 同一份判据） */
function detectMentionInContent(content: string, appId: string | undefined): boolean {
  const id = String(appId ?? '');
  if (!content || !id) return false;
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.includes(`<@${safe}>`) || content.includes(`<@!${safe}>`);
}

/** 可调用 + 带属性的对象（契约里 `ctx.quoted({text,fromSelf})` 两种读法都支持） */
function callableWith<T extends object>(make: () => T): (() => T) & T {
  const f = ((): T => make()) as (() => T) & T;
  try { Object.assign(f, make()); } catch { /* ignore */ }
  return f;
}

/** 被引用的原文（`ctx.state.quote` 是 SDK quoteRef 赋的，别自己解析引用） */
function quotedOf(ctx: MiddlewareContext): { text: string; fromSelf: boolean; id: string } {
  try {
    const q = (ctx.state as { quote?: { text?: unknown; entry?: { senderId?: unknown } } } | undefined)?.quote;
    const text = String(q?.text ?? '');
    // 被引那条消息的发送者 openid（SDK quoteRef 在 store 命中时给的 entry.senderId）。
    // 用途：辅导员类扩展"回复某人再下令 → 对**被回复的那个人**动手"。
    // ⚠️ 拿不到（引用的是没见过的消息 / 走 msg_elements 解析）时是空串，自己判空。
    const id = String(q?.entry?.senderId ?? '');
    if (!text) return { text: '', fromSelf: false, id };
    // fromSelf 是**尽力而为**的启发式：插件没记住 bot 自己的 openid，
    // 但 transport/outbound-buffer 会把"她刚说的那句"记进 bot-reply-memo（10 分钟内有效），
    // 两者文本对得上（含被平台截断的前缀情形）就认为"引的是她自己那条"。
    const key = ctx.message.kind === 'group'
      ? String((ctx.message as { groupOpenid?: unknown }).groupOpenid ?? '')
      : String((ctx.message as { senderId?: unknown }).senderId ?? '');
    const last = lastBotReplyOf(key);
    if (!last) return { text, fromSelf: false, id };
    const a = last.text.trim();
    const b = text.trim();
    const hit = a !== '' && b !== '' && (a === b || b.startsWith(a) || a.startsWith(b));
    return { text, fromSelf: hit, id };
  } catch {
    return { text: '', fromSelf: false, id: '' };
  }
}

// ══════════════════════════════════════════════════════════════
// 动作实现
// ══════════════════════════════════════════════════════════════

/** 消灭：只置标记 —— 真正"不往下走"由运行器的 next 包装执行（置位后再调 next() 也无效） */
function annihilate(ctx: MiddlewareContext, s: ExtCtxSession, opts?: { reason?: string; ownerAck?: boolean }): boolean {
  try {
    const reason = typeof opts?.reason === 'string' ? opts.reason : undefined;
    /**
     * ★ 2026-10-14 新增：**`ownerAck`**（主人定："那就把主人的消息也消灭"）。
     *
     * 背景：白名单写着"主人的消息永不可被消灭"，下面第 ② 条会直接 `return false` ——
     * 这很对，但有一类是**主人自己的意图**：比如"二档路由隔绝"（带 `[s:xxx]` 的消息已经被
     * 扩展投递到别的会话、明确要求不要再留在本会话上下文里）。那时扩展可传 `ownerAck: true`
     * 声明"我已经把它送走了"，本函数就放行这一次。
     *
     * 三条纪律：① 只在"确实另行投递过"时用，否则主人的话凭空消失；
     *          ② 用了**一定落审计** `ok-owner-ack`，事后可查；
     *          ③ 只解开**这一条**的白名单，熔断等其它保护一律照旧。
     */
    const ownerAck = opts?.ownerAck === true;
    // ① 挂点检查：晚挂点已经记过群历史了，"消灭=不进历史"在那一步做不到
    if (s.phase !== 'inbound') {
      warn(s, 'annihilate 只在早挂点 onInbound 有效（晚挂点 already 记过群历史；想拦掉这条就直接不调 next()）');
      audit(s, { action: 'annihilate', reason, result: 'refused-late-hook' });
      s.annihilateRefused = { reason: 'annihilate 只在早挂点 onInbound 有效' };
      return false;
    }
    // ② 白名单最高优先：主人永不可被消灭
    const sender = senderOf(ctx);
    const senderIsOwner = ownerOf(s, sender);
    if (senderIsOwner && !ownerAck) {
      warn(s, `拒绝消灭：发送者 ${sender} 在主人口令白名单里（白名单最高优先，本条照常放行）`);
      audit(s, { action: 'annihilate', target: sender, reason, result: 'refused-owner' });
      s.annihilateRefused = { reason: '发送者是主人（白名单最高优先）' };
      return false;
    }
    if (senderIsOwner && ownerAck) {
      warn(s, 'ownerAck 生效：主人的消息被消灭（' + (reason ?? '未给原因')
        + '）—— 扩展已声明「内容已另行处置」');
    }
    // ③ 熔断
    const gate = checkDestructiveAllowed(s.current?.file ?? '');
    if (!gate.ok) {
      warn(s, `熔断中，annihilate 被拒（${gate.reason}）—— 本条消息照常放行`);
      audit(s, { action: 'annihilate', target: sender, reason, result: 'refused-breaker' });
      s.annihilateRefused = { reason: `熔断：${gate.reason}` };
      return false;
    }
    s.annihilate = reason ? { reason } : {};
    s.destructiveCount += 1;
    noteDestructive(s.current?.file ?? '');
    audit(s, { action: 'annihilate', target: sender, reason, text: textOf(ctx), result: ownerAck ? 'ok-owner-ack' : 'ok' });
    return true;
  } catch (err) {
    warn(s, `annihilate 异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 改写文本：直接改 `ctx.message.content`（早挂点在记历史之前 ⇒ 群历史里也是改后的文本） */
function rewrite(ctx: MiddlewareContext, s: ExtCtxSession, opts?: { text?: string; reason?: string }): boolean {
  try {
    const raw = opts?.text;
    if (typeof raw !== 'string') {
      warn(s, 'rewrite 需要 { text: "改写后的文本" }（收到非字符串，已忽略）');
      audit(s, { action: 'rewrite', result: 'refused-invalid' });
      return false;
    }
    const before = textOf(ctx);
    (ctx.message as { content?: string }).content = raw;
    s.rewriteCount += 1;
    audit(s, {
      action: 'rewrite',
      target: senderOf(ctx),
      reason: typeof opts?.reason === 'string' ? opts.reason : undefined,
      text: `→ ${raw}`,
      result: s.phase === 'inbound' ? 'ok' : 'ok-late-hook(群历史里仍是原文)',
    });
    // 改写前后都记一笔（debug 级）：排查"到底改没改"最直接
    try {
      s.env.logger?.debug?.(`[ext-inbound:${who(s)}] rewrite: "${before.slice(0, 30)}" → "${raw.slice(0, 30)}"`);
    } catch { /* ignore */ }
    return true;
  } catch (err) {
    warn(s, `rewrite 异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── ★ silentInto：静默进上下文（2026-10-12 新增；两个挂点都能用）──────────────

/**
 * 缺省正文 = **当前这条入站消息洗过之后的正文**。
 *
 * "洗过"在这里有两层，都是复用插件现成的东西，不另造一套：
 *   ① `rewrite()` 之后的 `ctx.message.content`（早挂点里扩展自己刚改的那版）；
 *   ② 再把"@她"的 32 位长 id 换成短标记 `@bot` —— 复用 `shared/mention-clean.ts` 的
 *      `replaceBotMention`，与"记群历史 / 进上下文"那条正常通路**同一份判据**
 *      （见 `middleware/media-history.ts` 与 `transport/inbound.ts` 的调用点）。
 *      不洗的话，群里每条被 @ 的消息都会往上下文里灌一截 32 位 hex（白烧 token）。
 */
function defaultSilentText(ctx: MiddlewareContext, s: ExtCtxSession): string {
  const mentions = (ctx.message as { mentions?: MentionLike[] } | undefined)?.mentions;
  return replaceBotMention(textOf(ctx), mentions ?? null, platformMentioned(ctx, s.env.appId));
}

/**
 * `silentInto` 的参数归一化。三种收法（其余一律拒，避免 `String(未知对象)` 塞进上下文）：
 *   · 不传 / `null`            → 当前正文（见 {@link defaultSilentText}）
 *   · `'文本'`                 → 直接用（主人点名的签名就是 `ctx.silentInto(text?)`）
 *   · `{ text?, reason? }`     → 便捷写法：可以只给 `reason`（正文仍取当前正文）方便审计溯源
 * 返回 `null` = 形状不合法。
 */
function parseSilentArg(
  ctx: MiddlewareContext,
  s: ExtCtxSession,
  arg: unknown,
): { text: string; reason?: string } | null {
  if (arg === undefined || arg === null) return { text: defaultSilentText(ctx, s) };
  if (typeof arg === 'string') return { text: arg };
  if (typeof arg === 'object' && !Array.isArray(arg)) {
    const o = arg as { text?: unknown; reason?: unknown };
    if (o.text !== undefined && typeof o.text !== 'string') return null;   // { text: 123 } 这类不收
    const reason = typeof o.reason === 'string' && o.reason ? o.reason : undefined;
    if (o.text === undefined && reason === undefined) return null;          // 空对象 {} 也拒
    return {
      text: typeof o.text === 'string' ? o.text : defaultSilentText(ctx, s),
      ...(reason ? { reason } : {}),
    };
  }
  return null;
}

/** 问运行环境要 agent（解析器自己抛错也当"拿不到"，绝不外抛） */
function resolveAgentOf(ctx: MiddlewareContext, s: ExtCtxSession): unknown {
  const resolve = s.env.resolveAgent;
  if (typeof resolve !== 'function') return undefined;
  try {
    return resolve(ctx);
  } catch {
    return undefined;
  }
}

/**
 * ★ `ctx.silentInto(text?)` —— **把这条消息静默放进当前会话的 AI 上下文，不唤醒**。
 *
 * 与 `annihilate` 的分工：
 *   · `annihilate` = "不调 next()" ⇒ 链断在这里，**内容是消失的**（后面组装上下文的那步看不到它）；
 *   · `silentInto` = 内容**塞进收件箱**（`agent.inject`，`next-step` / `wakeup:false`）⇒
 *     她空闲时它就静静躺着，**等下一次真有回合跑起来时自然出现**；同时扩展若 `return`（不调 next），
 *     那条消息本身仍不进群历史 / 不占冷却 / 不过评分 —— "内容留下，但不叫醒"。
 *
 * 参数：见 {@link parseSilentArg}。返回值：
 *   · `true`  = **内容已经在上下文里了**（本次注入成功；或之前已经注入过 —— 幂等命中，没重复塞）；
 *   · `false` = **没注入成功**（空文本 / 参数不合法 / 熔断 / 拿不到 agent / inject 抛错）——
 *     具体原因看日志的 warn 与审计里的 `result`（`refused-*` / `failed-*`）。
 *
 * ⚠️ **拿不到 agent 时不会"替你把消息放行"**：引擎的兜底放行只认 `annihilate` 被拒与"发送者是主人"。
 *    所以推荐写法是**自己判返回值**，失败时走正常链路（示例见 `examples/ext-inbound/README.md`）：
 *    ```js
 *    if (!ctx.silentInto()) return next();   // 没注进去就别把这条也吞了
 *    return;                                 // 注进去了：这条到此为止（不叫醒）
 *    ```
 *
 * ⚠️ 白名单：**主人（owners）的消息允许被 `silentInto`**（内容仍进上下文，不存在"被吞"的风险），
 *    但要**落审计**、并**计入熔断**（见文件头 ① 的说明）。这条不受 `annihilate` 的白名单限制。
 */
function silentInto(ctx: MiddlewareContext, s: ExtCtxSession, arg?: unknown): boolean {
  let body = '';
  let reason: string | undefined;
  try {
    // ① 参数归一化（形状不合法直接拒：绝不把未知对象 String() 之后塞进上下文）
    const parsed = parseSilentArg(ctx, s, arg);
    if (parsed === null) {
      warn(s, 'silentInto 只认 ctx.silentInto() / ctx.silentInto("文本") / ctx.silentInto({ text, reason })；' +
        '收到别的形状，本次不注入');
      audit(s, { action: 'silentInto', target: senderOf(ctx), result: 'refused-invalid' });
      return false;
    }
    body = parsed.text.trim();
    reason = parsed.reason;

    // ② 空文本不注入（别往上下文里塞空消息）
    if (!body) {
      warn(s, 'silentInto 拿到空文本（这条没有正文，或者你传了空白）⇒ 不注入');
      audit(s, { action: 'silentInto', target: senderOf(ctx), reason, result: 'refused-empty' });
      return false;
    }

    // ③ 幂等：同一条消息只注入一次（早/晚挂点共用一份会话 ⇒ 跨挂点也只塞一次）
    if (s.silentInto?.injected) {
      audit(s, { action: 'silentInto', target: senderOf(ctx), reason, text: body, result: 'ok-duplicate' });
      return true;   // 内容是**在**上下文里的（先前那次已成功），所以这里算成功
    }

    // ④ 熔断：silentInto 计入"破坏性动作"（它同样能大规模改变会话内容），超阈值与 annihilate 一起停
    const gate = checkDestructiveAllowed(s.current?.file ?? '');
    if (!gate.ok) {
      warn(s, `熔断中，silentInto 被拒（${gate.reason}）—— 没注入成功；` +
        '要稳妥请自己判返回值（`if (!ctx.silentInto()) return next()`）');
      audit(s, { action: 'silentInto', target: senderOf(ctx), reason, text: body, result: 'refused-breaker' });
      return false;
    }

    // ⑤ 拿 agent（拿不到只告警：该会话还没建立是常见情形，不算扩展写错）
    const agent = resolveAgentOf(ctx, s);
    const inject = (agent as { inject?: unknown } | undefined)?.inject;
    if (typeof inject !== 'function') {
      warnOnce(
        s, 'silent-no-agent',
        'silentInto 拿不到宿主 agent（该会话还没建立？）或它没有 inject() ⇒ 本条没进上下文。' +
        '注意：这里**不会**替你放行这条消息 —— 若你接着 return 且不调 next()，它就真的既不进上下文也不进历史了',
      );
      audit(s, { action: 'silentInto', target: senderOf(ctx), reason, text: body, result: 'failed-no-agent' });
      return false;
    }

    // ⑥ 注入：**只走宿主的 agent.inject**（next-step / wakeup:false，不拆 tool_calls）；
    //    消息形状复用 createUserMessage（与 group-hub / debounce / commands/inject 同款），
    //    绝不 session.append / caps.appendSilent 硬写。
    const msg = createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } });
    (inject as (m: unknown) => void).call(agent, msg);

    s.silentInto = { injected: true, result: 'ok', chars: body.length };
    s.destructiveCount += 1;                    // 熔断统计认它（与 annihilate/muteUser 同一本账）
    noteDestructive(s.current?.file ?? '');
    audit(s, { action: 'silentInto', target: senderOf(ctx), reason, text: body, result: 'ok' });
    return true;
  } catch (err) {
    warn(s, `silentInto 注入失败(已忽略, 未抛到链上): ${err instanceof Error ? err.message : String(err)}`);
    try {
      audit(s, { action: 'silentInto', target: senderOf(ctx), reason, text: body, result: 'failed-inject' });
    } catch { /* audit 自身永不抛，这里只是保险 */ }
    return false;
  }
}

/** 强制入站：写 `ctx.state.qqInboundForceWake` —— 门控/评分/冷却三处都认这个标记 */
function forceWake(ctx: MiddlewareContext, s: ExtCtxSession, opts?: { reason?: string }): boolean {
  try {
    const reason = typeof opts?.reason === 'string' ? opts.reason : undefined;
    const st = ctx.state as Record<string, unknown>;
    st.qqInboundForceWake = true;
    if (reason) st.qqInboundForceWakeReason = reason;
    s.forceWake = reason ? { reason } : {};
    audit(s, {
      action: 'forceWake',
      target: senderOf(ctx),
      reason,
      text: textOf(ctx),
      result: s.phase === 'inbound' ? 'ok' : 'ok-late-hook(门控已过，只免评分/冷却)',
    });
    return true;
  } catch (err) {
    warn(s, `forceWake 异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 覆盖 @ 判定（晚挂点专用：`ctx.state.mention` 是 mentionGate 刚写的） */
function decide(ctx: MiddlewareContext, s: ExtCtxSession, opts?: { mention?: string; reason?: string }): boolean {
  try {
    const mode = opts?.mention === 'force' ? 'force' : opts?.mention === 'ignore' ? 'ignore' : undefined;
    const reason = typeof opts?.reason === 'string' ? opts.reason : undefined;
    if (!mode) {
      warn(s, "decide 需要 { mention: 'ignore' | 'force' }（收到别的值，已忽略）");
      audit(s, { action: 'decide', reason, result: 'refused-invalid' });
      return false;
    }
    if (s.phase !== 'decide') {
      warn(s, 'decide 只在晚挂点 onDecide 有效（早挂点在 mentionGate 之前，ctx.state.mention 还没写出来）');
      audit(s, { action: 'decide', reason, result: 'refused-early-hook' });
      return false;
    }
    const st = ctx.state as { mention?: { wasMentioned?: boolean } | undefined };
    const want = mode === 'force';
    if (st.mention && typeof st.mention === 'object') st.mention.wasMentioned = want;
    else st.mention = { wasMentioned: want };
    s.decide = reason ? { mention: mode, reason } : { mention: mode };
    audit(s, {
      action: 'decide',
      target: senderOf(ctx),
      reason,
      text: `mention=${mode}`,
      result: 'ok',
    });
    return true;
  } catch (err) {
    warn(s, `decide 异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 禁言：写持久名单（`minutes <= 0` = 永久）。白名单与熔断同样拦在前面 */
function muteUser(
  ctx: MiddlewareContext,
  s: ExtCtxSession,
  opts?: { id?: string; minutes?: number; reason?: string; by?: string },
): ExtMute | false {
  try {
    const id = String(opts?.id ?? senderOf(ctx) ?? '').trim();
    const reason = typeof opts?.reason === 'string' ? opts.reason : undefined;
    if (!id) {
      warn(s, 'muteUser 需要 { id }（缺省 = 当前发送者；这条两个都没拿到，已忽略）');
      audit(s, { action: 'muteUser', reason, result: 'refused-invalid' });
      return false;
    }
    if (ownerOf(s, id)) {
      warn(s, `拒绝禁言：${id} 在主人口令白名单里（白名单最高优先）`);
      audit(s, { action: 'muteUser', target: id, reason, result: 'refused-owner' });
      return false;
    }
    const gate = checkDestructiveAllowed(s.current?.file ?? '');
    if (!gate.ok) {
      warn(s, `熔断中，muteUser 被拒（${gate.reason}）`);
      audit(s, { action: 'muteUser', target: id, reason, result: 'refused-breaker' });
      return false;
    }
    if (!rootOk(s)) return false;
    const minutes = Number(opts?.minutes);
    const entry = stateMuteUser(s.env.dataRoot, s.current?.file ?? '(unknown)', {
      id,
      minutes: Number.isFinite(minutes) ? minutes : 0,
      ...(reason ? { reason } : {}),
      by: typeof opts?.by === 'string' && opts.by ? opts.by : who(s),
    });
    if (!entry) {
      warn(s, `muteUser 写名单失败（数据根不可写？）: ${id}`);
      audit(s, { action: 'muteUser', target: id, reason, result: 'failed-write' });
      return false;
    }
    s.destructiveCount += 1;
    noteDestructive(s.current?.file ?? '');
    audit(s, {
      action: 'muteUser',
      target: id,
      reason,
      text: entry.until === 0 ? '永久' : `至 ${new Date(entry.until).toISOString()}`,
      result: 'ok',
    });
    return entry;
  } catch (err) {
    warn(s, `muteUser 异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 解禁（可撤销通道） */
function unmuteUser(ctx: MiddlewareContext, s: ExtCtxSession, opts?: { id?: string }): boolean {
  try {
    const id = String(opts?.id ?? senderOf(ctx) ?? '').trim();
    if (!id || !rootOk(s)) return false;
    const ok = stateUnmuteUser(s.env.dataRoot, s.current?.file ?? '(unknown)', id);
    audit(s, { action: 'unmuteUser', target: id, result: ok ? 'ok' : 'not-found' });
    return ok;
  } catch (err) {
    warn(s, `unmuteUser 异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 查一条是否被禁言（只读，不写审计） */
function isMuted(ctx: MiddlewareContext, s: ExtCtxSession, id?: string): ExtMuteView | null {
  try {
    const key = String(id ?? senderOf(ctx) ?? '').trim();
    if (!key || !rootOk(s)) return null;
    return stateIsMuted(s.env.dataRoot, s.current?.file ?? '(unknown)', key);
  } catch {
    return null;
  }
}

/** 读整份名单（只读，不写审计） */
function mutedUsers(_ctx: MiddlewareContext, s: ExtCtxSession): ExtMuteView[] {
  try {
    if (!rootOk(s)) return [];
    return stateMutedUsers(s.env.dataRoot, s.current?.file ?? '(unknown)');
  } catch {
    return [];
  }
}

/** kv 读（只读，不写审计） */
function kvGet(_ctx: MiddlewareContext, s: ExtCtxSession, key: string): unknown {
  try {
    if (!rootOk(s)) return undefined;
    return readExtState(s.env.dataRoot, s.current?.file ?? '(unknown)').kv[String(key)];
  } catch {
    return undefined;
  }
}

/** kv 写；`value === undefined` 等价删除该键（JSON 里会消失） */
function kvSet(_ctx: MiddlewareContext, s: ExtCtxSession, key: string, value: unknown): boolean {
  try {
    if (!rootOk(s)) return false;
    const file = s.current?.file ?? '(unknown)';
    const st = readExtState(s.env.dataRoot, file);
    st.kv[String(key)] = value;
    return writeExtState(s.env.dataRoot, file, st);
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// 挂到 ctx 上
// ══════════════════════════════════════════════════════════════

/** 定义不可枚举属性（不参与展开/序列化）；失败静默（绝不影响消息链） */
function def(target: object, key: string, desc: PropertyDescriptor): void {
  try {
    Object.defineProperty(target, key, { enumerable: false, configurable: true, ...desc });
  } catch { /* ignore */ }
}

/**
 * 把动作 API 挂到 ctx 上（每个 ctx 只挂一次）。
 * ⚠️ 一律**不可枚举**：middleware-setup 的命令层会 `{...ctx}` 组 handler 参数，
 *    可枚举的话会把这些动作/取值器一起复制过去（还可能覆盖扩展命令自己的 caps）。
 */
/**
 * ★ 把「入站操控」这一组**打包**（2026-10-12 主人定：它也要进统一能力包）。
 *
 * 和上面那些 def 在 ctx 上的是**同一份实现**（不是两套）：这里只是换个入口交出去，
 * 好让契约写成「一套包、五套扩展」——包里的 `inbound` 组"有值"就等于"你现在正握着
 * 一条消息的处置权"。别的四套拿它会是 undefined，那是语义，不是缺失。
 */
// ────────────────────────────────────────────────────────────────
// ctx.reply —— 入站扩展"直接回一句"（2026-11-11 新增）
// ────────────────────────────────────────────────────────────────
/**
 * 为什么之前没有：入站挂点在**命令/模型之前**，给"能发消息"等于给每条入站一次主动发信。
 * 现在放开，只保留三点（**不做限频** —— 2026-11-11 主人定：不能替用户省掉自由度）：
 *   ① **走正常出站**（`sender.sendMarkdown` + 本条的 replyTarget）—— 引用/分段/限速全部照旧；
 *   ② **审计**：每次回话都记 `action: 'reply'`（署名哪个扩展），出事查得到；
 *   ③ **不唤醒 AI、不进会话历史**：它只是"替插件说了一句"，模型不会以为自己说过。
 */
async function reply(_ctx: MiddlewareContext, s: ExtCtxSession, text?: unknown): Promise<boolean> {
  const t = typeof text === 'string' ? text : String((text as { text?: unknown } | undefined)?.text ?? '');
  if (!t.trim()) return false;
  const sender = s.env.sender as { sendMarkdown?: (target: unknown, text: string) => Promise<unknown> } | undefined;
  const target = s.env.replyTarget;
  if (!sender || typeof sender.sendMarkdown !== 'function' || !target) {
    warnOnce(s, 'reply-no-sender', 'ctx.reply 不可用：运行环境没给 sender/replyTarget（嵌入方未接线），本条已忽略');
    return false;
  }
  try {
    await sender.sendMarkdown(target, t.slice(0, 2000));
    audit(s, { action: 'reply', reason: t.slice(0, 80) } as never);
    return true;
  } catch (err) {
    warn(s, `ctx.reply 发送失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 当前这条消息所属的 DSH 会话 id（入站 ctx 以前拿不到，只能从出站链的 header 里找） */
function sessionIdOf(ctx: MiddlewareContext, s: ExtCtxSession): string {
  try {
    if (!s.env.resolveAgent) return '';
    const a = s.env.resolveAgent(ctx) as { session?: { id?: unknown } } | undefined;
    return String(a?.session?.id ?? '');
  } catch { return ''; }
}

export function inboundCapsOf(ctx: MiddlewareContext, s: ExtCtxSession): ExtInboundCaps {
  return {
    annihilate: (o) => annihilate(ctx, s, o),
    rewrite: (o) => rewrite(ctx, s, o),
    forceWake: (o) => forceWake(ctx, s, o),
    decide: (o) => decide(ctx, s, o),
    silentInto: (t) => silentInto(ctx, s, t),
    reply: (t) => reply(ctx, s, t),
    get sessionId() { return sessionIdOf(ctx, s); },
    muteUser: (o) => muteUser(ctx, s, o),
    unmuteUser: (o) => unmuteUser(ctx, s, o),
    isMuted: (id) => isMuted(ctx, s, id),
    mutedUsers: () => mutedUsers(ctx, s),
    message: {
      get text() { return textOf(ctx); },
      get sender() { return senderOf(ctx); },
      get senderName() { return String((ctx.message as { senderName?: unknown }).senderName ?? ''); },
      get scope() { return (ctx.message.kind === 'group' ? 'group' : 'c2c') as 'group' | 'c2c'; },
      get groupId() { return String((ctx.message as { groupOpenid?: unknown }).groupOpenid ?? ''); },
      get isOwner() { return ownerOf(s, senderOf(ctx)); },
      get mentions() { return ((ctx.message as { mentions?: unknown }).mentions ?? []) as unknown[]; },
      get quoted() { return quotedOf(ctx); },
      get platform() { return { mentioned: platformMentioned(ctx, s.env.appId) }; },
    },
    kv: {
      get: (key) => kvGet(ctx, s, key),
      set: (key, value) => kvSet(ctx, s, key, value),
    },
  };
}
function decorate(ctx: MiddlewareContext, s: ExtCtxSession): void {
  const c = ctx as unknown as Record<string, unknown>;

  // ── 动作（消息维）──
  def(c, 'annihilate', { value: (opts?: { reason?: string }) => annihilate(ctx, s, opts) });
  def(c, 'rewrite', { value: (opts?: { text?: string; reason?: string }) => rewrite(ctx, s, opts) });
  def(c, 'forceWake', { value: (opts?: { reason?: string }) => forceWake(ctx, s, opts) });
  def(c, 'decide', { value: (opts?: { mention?: string; reason?: string }) => decide(ctx, s, opts) });
  // ★ 静默进上下文：`ctx.silentInto()` / `ctx.silentInto('文本')` / `ctx.silentInto({ text, reason })`
  //   两个挂点都能调；同一条消息只注入一次（幂等，见 silentInto 的注释）
  def(c, 'silentInto', { value: (text?: unknown) => silentInto(ctx, s, text) });
  // 2026-11-11：入站扩展"直接回一句"（限频 + 审计 + 走正常出站）
  def(c, 'reply', { value: (text?: unknown) => reply(ctx, s, text) });
  def(c, 'sessionId', { get: () => sessionIdOf(ctx, s) });

  // ── 动作（用户维）──
  def(c, 'muteUser', { value: (opts?: { id?: string; minutes?: number; reason?: string; by?: string }) => muteUser(ctx, s, opts) });
  def(c, 'unmuteUser', { value: (opts?: { id?: string }) => unmuteUser(ctx, s, opts) });
  def(c, 'isMuted', { value: (id?: string) => isMuted(ctx, s, id) });
  def(c, 'mutedUsers', { value: () => mutedUsers(ctx, s) });

  // ── 通用取值（读的时候现算，不缓存快照）──
  // text：读 = 当前文本；写 = 直接改 ctx.message.content（等价于 unsafely 改写，审计请用 rewrite）
  def(c, 'text', {
    get: () => textOf(ctx),
    set: (v: unknown) => { (ctx.message as { content?: string }).content = String(v ?? ''); },
  });
  def(c, 'scope', { get: () => (ctx.message.kind === 'group' ? 'group' : 'c2c') });
  def(c, 'sender', { get: () => senderOf(ctx) });
  def(c, 'senderName', { get: () => String((ctx.message as { senderName?: unknown }).senderName ?? '') });
  def(c, 'isOwner', { get: () => ownerOf(s, senderOf(ctx)) });
  def(c, 'groupId', { get: () => String((ctx.message as { groupOpenid?: unknown }).groupOpenid ?? '') });
  def(c, 'mentions', { get: () => ((ctx.message as { mentions?: unknown }).mentions ?? []) });
  def(c, 'quoted', { get: () => callableWith(() => quotedOf(ctx)) });
  def(c, 'platform', {
    get: () => callableWith(() => ({ mentioned: platformMentioned(ctx, s.env.appId) })),
  });
  def(c, 'logger', { get: () => s.env.logger });
  def(c, 'dataRoot', { get: () => s.env.dataRoot });

  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-12 主人定：**能力面对齐** ★★
  //
  // 入站扩展（第五套）必须和另外四套 —— 自定义命令 / 扩展工具 / botplay 卡片 /
  // 启动钩子 —— 拿到**同一套**能力包。依据是 `docs/USER-GUIDE.md` 的
  // §「★ 统一能力包（v1.7.0+）：三套扩展能力面对齐」，原文一句话：
  // 「写扩展时**不用再自己接生**」。
  //
  // 为什么这条对齐是**必须**的（而不是"锦上添花"）：
  //   · 那套包里本来就有 **`appendSilent`**（= "进上下文（静默）、不唤醒"）——
  //     入站侧想要的"消灭消息但内容静默进上下文"，**契约里早就有了**；
  //     没对齐才会以为要另造一个注入动作。**接上它，而不是再造一份。**
  //   · 还有 `store`（升级不丢的持久化）、`api()`（自带 token 打官方接口）、
  //     `user/owners/peer`（身份）、`kernel`（遥控器）等等 —— 五套之间不该有"二等公民"。
  //
  // 三条纪律（第 ① 条照抄命令层 2026-10-12 那次实测修复的口径）：
  //   ① **只补不覆盖**：判据是"值为 undefined 才补"，不是"有没有这个键" ——
  //      中间件 ctx 上不少键**存在但值是 undefined**，只问键名会把好值全跳过；
  //   ② 一律**不可枚举**（`def` 已保证）：命令层会 `{...ctx}` 组 handler 参数，可枚举会串味；
  //   ③ 构造失败**只告警一次**，绝不抛：能力包拿不到 = 那几项优雅降级（契约写明不抛），
  //      不能让入站主链因为"能力包没造出来"而断掉。
  //
  // ⚠️ **唯一一处同名冲突（有意为之，别"顺手"改）**：`text`。
  //    · 其他四套：`env.text('...')` = **发一条纯文本消息**；
  //    · 入站（这里）：`ctx.text` = **当前这条入站消息的正文**（getter）。
  //    入站侧这个读法先占了名字，而且改写/判断全靠它，所以**保留入站语义**；
  //    想在入站扩展里发文本，走命名空间：`ctx.caps.text('...')`。
  //    其余能力都平铺在 ctx 上（`ctx.markdown` / `ctx.appendSilent` / `ctx.store` …）。
  // ══════════════════════════════════════════════════════════════════════════
  try {
    const mc = ctx.message as { kind?: string; groupOpenid?: string; senderId?: string; senderName?: string };
    const isGroup = mc?.kind === 'group';
    const caps = makeExtCaps({
      dataRoot: s.env.dataRoot,
      logger: s.env.logger,
      appId: s.env.appId,
      appSecret: s.env.appSecret,
      owners: s.env.owners,
      sender: s.env.sender as never,
      replyTarget: s.env.replyTarget,
      agent: (s.env.resolveAgent ? s.env.resolveAgent(ctx) : undefined) as never,
      scope: isGroup ? 'group' : 'c2c',
      peerId: String((isGroup ? mc?.groupOpenid : mc?.senderId) ?? ''),
      actorOpenid: senderOf(ctx),
      actorName: String(mc?.senderName ?? ''),
      apiCall: s.env.apiCall as never,
      // ★★ 2026-11-14 修（审查发现）：selfName **不能在这里固化**。
      //   decorate() 在 ensureExtSession 里执行，而归属(s.current)要到 enterExtension
      //   (第 232 行) 才设置 —— 固化的话每条消息都是 (匿名扩展)，所有入站扩展
      //   的 ctx.store 会落到同一个文件互相覆盖。改成下面循环之后用 getter 挂。
      kind: 'inbound',
      kernel: s.env.kernel,
      inbound: inboundCapsOf(ctx, s),   // ★ 入站操控这一组也进包
    });
    def(c, 'caps', { value: caps });   // 命名空间：ctx.caps.text(...) 等
    for (const [k, v] of Object.entries(caps)) {
      if (v === undefined) continue;
      if (!(k in c) || c[k] === undefined) def(c, k, { value: v });
    }
    // ★★ 2026-11-14：selfName 单独挂成 getter（每次读按当前扩展求值，不能被 value 固化）
    try {
      const selfGet = (): string => who(s);
      Object.defineProperty(caps, 'selfName', { get: selfGet, enumerable: true, configurable: true });
      Object.defineProperty(c, 'selfName', { get: selfGet, enumerable: true, configurable: true });
    } catch { /* 挂不上就退回 undefined，不致命 */ }
  } catch (err) {
    warnOnce(s, 'caps', '统一能力包未接上（入站专属动作不受影响）：' + (err instanceof Error ? err.message : String(err)));
  }

  // ── 每个扩展自己的持久化（与禁言名单同一个文件）──
  def(c, 'kv', {
    get: () => ({
      get: (key: string) => kvGet(ctx, s, key),
      set: (key: string, value: unknown) => kvSet(ctx, s, key, value),
    }),
  });

  // ── 内部诊断（也给用户看：这些动作到底生效没有）──
  def(c, 'extState', {
    get: () => ({
      phase: s.phase,
      extension: s.current?.name ?? '',
      annihilated: s.annihilate !== undefined,
      forceWake: s.forceWake !== undefined,
      mentionOverride: s.decide?.mention,
      rewrites: s.rewriteCount,
      destructive: s.destructiveCount,
    }),
  });
}
