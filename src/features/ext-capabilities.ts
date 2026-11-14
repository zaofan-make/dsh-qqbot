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
import type { Logger } from '../types.js';
import { canSilentlyAppend } from '../session/surface-guard.js';
import { selfRestart } from '../commands/exit.js';

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
    content: { title: string; description: string; url: string; pic_url: string };
  }) => Promise<unknown>;
}

/** 官方 API 调用结果（与 GroupAdminClient.apiCall 同形） */
export type ExtApiResult =
  | { ok: true; data: unknown }
  | { ok: false; err: { code: string; human: string } };

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
  agent?: { session?: unknown; followup?: (msg: unknown) => unknown } | undefined;
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
  /** 扩展名（store 文件名 / 日志前缀） */
  selfName?: string;
  // ── 2026-10-25：按 docs/extension-contract.md §2 承诺补齐的命名空间 ──
  //   文档写的是 `env.user.openid/name/isOwner`、`env.peer.scope/peerId`，
  //   但类型和实现一直没给 —— 照文档写的扩展（如 proactive-companion 的
  //   isOwnerContext）拿到 undefined，导致"仅主人可用"恒定拒绝。
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
  config?: { appId?: string; appSecret?: string; [k: string]: unknown };
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
  annihilate(opts?: { reason?: string; ownerAck?: boolean }): boolean;
  /** 改写正文（早挂点连群历史一起改） */
  rewrite(opts?: { text?: string; reason?: string }): boolean;
  /** 强制入站：跳过 @门控 / 价值评分 / 群冷却（不等于"她一定会说话"） */
  forceWake(opts?: { reason?: string }): boolean;
  /** 覆盖 @ 判定（晚挂点；早挂点会被拒绝 + 告警） */
  decide(opts?: { mention?: 'ignore' | 'force'; reason?: string }): boolean;
  /** 静默进上下文：内容进 AI 上下文、**不唤醒**（走宿主 agent.inject，不拆 tool 配对） */
  silentInto(text?: string | { text?: string; reason?: string }): boolean;
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
  reply(text?: string | { text?: string }): Promise<boolean>;
  /** 这条消息所属的 DSH 会话 id（2026-11-11 新增；以前入站 ctx 拿不到） */
  readonly sessionId: string;
  /** 用户维禁言（名单持久化、带期限、过期惰性清理） */
  /** 禁言：成功返回名单条目（{id,until,reason,by}；until=0 表示永久），失败返回 false（原因见审计） */
  muteUser(opts?: { id?: string; minutes?: number; reason?: string; by?: string }): unknown;
  unmuteUser(opts?: { id?: string }): boolean;
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
    quoted: { text: string; id?: string; fromSelf?: boolean } | undefined;
    platform: { mentioned: boolean };
  };
  /** 该扩展自己的持久化（与禁言名单同一个文件） */
  kv: { get(key: string): unknown; set(key: string, value: unknown): boolean };
}

export interface ExtCapabilities {
  /** 当前执行者 openid（群聊=author.member_openid，单聊=author.user_openid） */
  actorOpenid?: string;
  appId: string;
  appSecret: string;
  /** ★ 2026-10-16：数据根（扩展之间共享一小份状态时用它拼固定路径；空串=拿不到，别拿它拼相对路径写盘） */
  dataRoot: string;
  at(id: string): string;
  text(s: string): Promise<boolean>;
  markdown(s: string): Promise<boolean>;
  markdownCard(s: string, keyboard?: unknown): Promise<boolean>;
  /**
   * 发**图文卡片**（官方 msg_type=8；2026-10-29 封装）。
   * `env.card({ title, description, url, pic_url })` —— title ≤50 / description ≤200 / url、pic_url 必 https ≤1024。
   * 卡片发不出去时**自动降级**成「markdown + 封面图」。
   */
  card(payload: { title: string; description?: string; url: string; pic_url?: string }): Promise<boolean>;
  media(kind: ExtMediaKind, source: ExtMediaSource): Promise<boolean>;
  image(source: ExtMediaSource | string): Promise<boolean>;
  voice(source: ExtMediaSource | string): Promise<boolean>;
  video(source: ExtMediaSource | string): Promise<boolean>;
  file(source: ExtMediaSource | string): Promise<boolean>;
  api(path: string, opts?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown }): Promise<ExtApiResult>;
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
  registerInteractionCard(input: { cardId: string; buttonIds: string[]; expireAt?: number }): boolean;
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
  markQqTurn(opts?: { reason?: string }): Promise<boolean>;
  canAppendSilent(): boolean;
  user: { openid: string; name: string; isOwner: boolean };
  owners: string[];
  peer: { scope: string; peerId: string };
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
  restart(opts?: { requireOwner?: boolean; delayMs?: number }): boolean;
}

// ── 自带 token 管理（不依赖 groupAdmin 开关，第三方用户也能用）──────────────
//   key = appId；value = { token, expireAt }。token 官方有效期 ~7200s，这里按 60s 余量提前过期。
const tokenCache = new Map<string, { token: string; expireAt: number }>();

async function fetchAccessToken(appId: string, appSecret: string): Promise<string> {
  if (!appId || !appSecret) return '';
  const hit = tokenCache.get(appId);
  if (hit && Date.now() < hit.expireAt) return hit.token;
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number | string };
  const token = String(data?.access_token ?? '');
  if (!token) throw new Error('拿 access_token 失败(检查 appId/appSecret)');
  const ttl = Number(data?.expires_in ?? 7200);
  tokenCache.set(appId, { token, expireAt: Date.now() + Math.max(60, ttl - 60) * 1000 });
  return token;
}

/** 「url 或本地路径」→ 媒体源对象（第三方作者常直接传字符串） */
function toMediaSource(src: ExtMediaSource | string): ExtMediaSource {
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
export function makeExtCaps(deps: ExtCapsDeps): ExtCapabilities {
  const logger = deps.logger;
  // ★★ 2026-11-14 修（审查发现）：selfName 必须**惰性求值**。
  //   能力包在"扩展进入之前"就构造好了，那时 deps.selfName 还是上一条消息的值/空值
  //   ⇒ 固化下来会让**所有扩展共用同一个 store 文件**（实测：两个入站扩展互相覆盖数据）。
  const selfNow = (): string => String(deps.selfName ?? 'ext');
  const kind = String(deps.kind ?? 'ext');
  const owners = Array.isArray(deps.owners) ? deps.owners.map(String) : [];
  const appId = String(deps.appId ?? '');
  const appSecret = String(deps.appSecret ?? '');
  const actorOpenid = String(deps.actorOpenid ?? '');

  const storeDir = deps.dataRoot ? join(deps.dataRoot, '.qqbot-extensions', kind, 'data') : '';
  /** store 文件路径 —— **惰性**：每次读写都按当前的 selfName 算（agent 可能还没进扩展） */
  const storePath = (): string => {
    const s = selfNow().replace(/\.(mjs?|cjs|js)$/i, '');
    return storeDir ? join(storeDir, `${s}.json`) : '';
  };

  const warn = (what: string, err: unknown): void => {
    try {
      logger?.warn?.(`[ext-caps] ${selfNow()} ${what} 失败: ${err instanceof Error ? err.message : String(err)}`);
    } catch { /* 日志失败忽略 */ }
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
  const noteDeliver = (what: string, ok: boolean, err?: unknown): void => {
    try {
      const root = String(deps.dataRoot ?? '');
      if (!root) return;
      const dir = join(root, '.qqbot');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'ext-deliver.log');
      try {
        if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
      } catch { /* 文件不存在/读不到都无所谓 */ }
      const msg = err === undefined ? '' : ` err=${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
      appendFileSync(file, `[${new Date().toISOString()}] ${selfNow()} ${what} ok=${ok}${msg}
`, 'utf8');
    } catch { /* 观测失败绝不影响发送 */ }
  };

  const send = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    // ★ 2026-11-14 修（审查发现）：成功路径**不要**落盘。
    //   noteDeliver 每次成功都 mkdirSync+statSync+appendFileSync，而发送是热路径 ——
    //   一个扩展连发 10 张图就是 10 次同步写盘，全在 await 之前串行。
    //   留痕的意义只在失败：成功时静默即可。
    try { await fn(); return true; } catch (err) {
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
    at: (id: string) => `<@${String(id ?? '')}>`,

    // ── 发送 ───────────────────────────────────────────────────────
    text: (s: string) => {
      const t = String(s ?? '');
      // ⚠️ 用 trim 判"空"，但发出去的仍是原文（不裁剪内容语义）
      if (!t.trim() || !deps.sender?.sendText) return Promise.resolve(false);
      return send('text', () => deps.sender!.sendText!(deps.replyTarget, t));
    },
    markdown: (s: string) => {
      const t = String(s ?? '');
      if (!t.trim() || !deps.sender?.sendMarkdown) return Promise.resolve(false);
      return send('markdown', () => deps.sender!.sendMarkdown!(deps.replyTarget, t));
    },
    markdownCard: (s: string, keyboard?: unknown) => {
      const t = String(s ?? '');
      if (!t.trim()) return Promise.resolve(false);
      if (deps.sender?.sendMarkdownWithKeyboard) {
        return send('markdownCard', () => deps.sender!.sendMarkdownWithKeyboard!(deps.replyTarget, t, keyboard));
      }
      if (deps.sender?.sendMarkdown) return send('markdownCard→markdown', () => deps.sender!.sendMarkdown!(deps.replyTarget, t));
      return Promise.resolve(false);
    },
    card: async (payload: { title: string; description?: string; url: string; pic_url?: string }) => {
      const p = (payload && typeof payload === 'object' ? payload : {}) as { title?: unknown; description?: unknown; url?: unknown; pic_url?: unknown };
      const title = String(p.title ?? '').trim().slice(0, 50);
      const url = String(p.url ?? '').trim();
      if (!title || !url) return false;
      const description = (String(p.description ?? '').trim() || title).slice(0, 200);
      const pic_url = String(p.pic_url ?? '').trim();
      const body = { type: 'tuwen' as const, content: { title, description, url, pic_url } };
      if (deps.sender?.sendTuwenCard) {
        const ok = await send('card', () => deps.sender!.sendTuwenCard!(deps.replyTarget, body));
        if (ok) return true;
      }
      // 降级：markdown + 封面
      if (deps.sender?.sendMarkdown) {
        const md = `**${title}**\n\n${description}\n\n${pic_url ? `![](${pic_url})\n\n` : ''}${url}`;
        return send('card→markdown', () => deps.sender!.sendMarkdown!(deps.replyTarget, md));
      }
      return false;
    },
    media: (k: ExtMediaKind, source: ExtMediaSource) => {
      if (!deps.sender?.sendMedia) {
        // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
        //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
        //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
        noteDeliver('media', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
        return Promise.resolve(false);
      }
      return send(`media(${k})`, () => deps.sender!.sendMedia!(deps.replyTarget, k, toMediaSource(source)));
    },
    image: (source) => {
      if (!deps.sender?.sendMedia) {
        // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
        //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
        //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
        noteDeliver('image', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
        return Promise.resolve(false);
      }
      return send('image', () => deps.sender!.sendMedia!(deps.replyTarget, 'image', toMediaSource(source)));
    },
    voice: (source) => {
      if (!deps.sender?.sendMedia) {
        // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
        //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
        //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
        noteDeliver('voice', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
        return Promise.resolve(false);
      }
      return send('voice', () => deps.sender!.sendMedia!(deps.replyTarget, 'voice', toMediaSource(source)));
    },
    video: (source) => {
      if (!deps.sender?.sendMedia) {
        // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
        //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
        //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
        noteDeliver('video', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
        return Promise.resolve(false);
      }
      return send('video', () => deps.sender!.sendMedia!(deps.replyTarget, 'video', toMediaSource(source)));
    },
    file: (source) => {
      if (!deps.sender?.sendMedia) {
        // ★ 2026-11-14（CodeRabbit 指出的排查盲区）：这条**原来直接返回 false、而且不留任何记录**。
        //   实测：扩展报"发送失败"，而 ext-deliver.log 里一条都没有 —— 根本无从下手。
        //   现在把"没有通道"这个原因也记进去（`sender` 是空壳通常意味着 findSessionRec 没命中会话）。
        noteDeliver('file', false, new Error('没有发送通道：deps.sender.sendMedia 不可用（会话记录没找到？）'));
        return Promise.resolve(false);
      }
      return send('file', () => deps.sender!.sendMedia!(deps.replyTarget, 'file', toMediaSource(source)));
    },

    // ── 官方 API（自带 token；注入了 apiCall 就优先用注入的）──────────
    api: async (path, opts) => {
      const method = (opts?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
      const p = String(path ?? '');
      if (!p) return { ok: false, err: { code: 'BAD_PATH', human: 'path 不能为空' } };
      if (typeof deps.apiCall === 'function') {
        try { return await deps.apiCall(method, p, opts?.body); } catch (err) { warn('api(injected)', err); }
      }
      try {
        const token = await fetchAccessToken(appId, appSecret);
        if (!token) return { ok: false, err: { code: 'NO_CREDENTIALS', human: '未配置 appId/appSecret' } };
        const res = await fetch(`https://api.bot.qq.com${p.startsWith('/') ? p : `/${p}`}`, {
          method,
          headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
          ...(opts?.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        });
        const text = await res.text();
        let data: unknown = text;
        try { data = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
        if (!res.ok) return { ok: false, err: { code: String(res.status), human: `HTTP ${res.status}: ${text.slice(0, 200)}` } };
        return { ok: true, data };
      } catch (err) {
        return { ok: false, err: { code: 'THROW', human: err instanceof Error ? err.message : String(err) } };
      }
    },

    // ── 持久化（落数据根，插件升级/重装不丢）─────────────────────────
    store: {
      // ★ 2026-11-14（CodeRabbit）：load/save 是动态求值，path 却被构造时固化 —— 改成 getter
      get path() { return storePath(); },
      load<T = unknown>(): T | undefined {
        if (!storePath()) return undefined;
        try {
          if (!existsSync(storePath())) return undefined;
          return JSON.parse(readFileSync(storePath(), 'utf8')) as T;
        } catch (err) { warn('store.load', err); return undefined; }
      },
      save(value: unknown): boolean {
        if (!storePath()) return false;
        try {
          mkdirSync(dirname(storePath()), { recursive: true });
          writeFileSync(storePath(), JSON.stringify(value ?? null, null, 2), 'utf8');
          return true;
        } catch (err) { warn('store.save', err); return false; }
      },
    },

    // ── 回调按钮卡片登记（2026-10-08 新增）──────────────────────────
    //   工具发卡时调一下，把 cardId / buttonIds 登记进
    //   `{dataRoot}/.qqbot/ext-tool-cards.json` —— 点击事件到达时插件靠它认领
    //   （分发链见 features/ext-tool-interaction.ts）。
    //   ⚠️ 纯旁路：登记失败**不影响发卡**（卡照发，只是按钮点了落回原兜底、最终只 ack）。
    registerInteractionCard: (input) => {
      try {
        if (!deps.dataRoot) return false;
        const cardId = String(input?.cardId ?? '').trim();
        const buttonIds = (Array.isArray(input?.buttonIds) ? input.buttonIds : [])
          .map((x) => String(x ?? '').trim())
          .filter(Boolean);
        if (!cardId || buttonIds.length === 0) return false;
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
      } catch (err) {
        warn('registerInteractionCard', err);
        return false;
      }
    },

    // ── 上下文（★ appendSilent 必须过表面守卫）───────────────────────
    appendSilent: async (text: string): Promise<boolean> => {
      const t = String(text ?? '').trim();
      if (!t) return false;
      const session = deps.agent?.session as { append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown } | undefined;
      if (!session || typeof session.append !== 'function') return false;
      if (!canSilentlyAppend(session)) {
        try {
          logger?.debug?.('[ext-caps] appendSilent 被拒：该会话人设尚未落盘(surface 首节点不是 system/message)，硬写会报废会话日志');
        } catch { /* ignore */ }
        return false;
      }
      try {
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user' } }), { surfaceOp: 'append' });
        return true;
      } catch (err) { warn('appendSilent', err); return false; }
    },
    appendWake: async (text: string): Promise<boolean> => {
      const t = String(text ?? '').trim();
      if (!t) return false;
      const agent = deps.agent;
      // 走正常回合：dsh 会先补人设 → 天然安全，不需要表面守卫
      if (agent && typeof agent.followup === 'function') {
        try {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: t }], source: { kind: 'user' } }));
          return true;
        } catch (err) { warn('appendWake', err); return false; }
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
    markQqTurn: async (opts?: { reason?: string }): Promise<boolean> => {
      try {
        const sc = String(deps.scope ?? '').trim();
        const pid = String(deps.peerId ?? '').trim();
        if (!sc || !pid) { warn('markQqTurn', new Error('缺少 scope/peerId')); return false; }
        const reg = await import('./session-registry.js').catch(() => undefined);
        if (!reg) return false;
        const m = reg.findManagerByPeer(sc as never, pid);
        const rec = m?.findByPeer(sc as never, pid) as
          | { turnOrigin?: 'qq' | 'external'; interjectLifted?: boolean }
          | undefined;
        if (!rec) { warn('markQqTurn', new Error('该会话没有活跃记录')); return false; }
        rec.turnOrigin = 'qq';
        rec.interjectLifted = false;
        try {
          logger?.debug?.('[ext-caps] markQqTurn: 本回合标记为 QQ 来源' + (opts?.reason ? ' (' + opts.reason + ')' : ''));
        } catch { /* ignore */ }
        return true;
      } catch (err) { warn('markQqTurn', err); return false; }
    },
    /**
     * ★ 按会话标识唤醒：钩子没有"当前消息"，必须显式点名目标。
     *   真正把 `peerId → agent` 解析出来的是宿主注入的 `deps.wakeTo`（见 gateway/bootstrap.ts）；
     *   这里只做参数清洗 + 兜底，永远不抛错。
     */
    wakeTo: async (scope: string, peerId: string, text: string): Promise<boolean> => {
      const t = String(text ?? '').trim();
      const sc = String(scope ?? '').trim();
      const pid = String(peerId ?? '').trim();
      if (!t || !sc || !pid) return false;

      // ① 宿主显式注入的优先（目前只有 hooks / commands 两处注入）
      const fn = deps.wakeTo;
      if (typeof fn === 'function') {
        try { if ((await fn(sc, pid, t)) === true) return true; } catch (err) { warn('wakeTo(deps)', err); }
      }

      // ② 兜底：自己按 peer 找 manager 再注入 —— 与 session_wake 工具同一条路。
      //    ⚠️ 2026-10-25 事故：caps 有六个构造方（tools/commands/hooks/botplay/inbound/outbound），
      //    逐个注入 deps.wakeTo 必然漏（实测 tools 与 commands 都漏了），于是扩展拿到一个
      //    "是函数、但恒返回 false"的 wakeTo，回执还误导成"没找到会话"。
      //    session-registry 是进程内 SessionManager 的唯一真源（settings-host 也用它），
      //    问它最可靠：findManagerByPeer(scope, peerId) → manager.injectToPeer(...)（内部 agent.followup）。
      try {
        const reg = await import('./session-registry.js');
        let m = reg.findManagerByPeer(sc as never, pid);

        if (!m) {
          // ★ 2026-10-25（主人实测）：不只是宿主重启，**空闲一段时间没动静后会话也会被回收**，
          //   活跃表里就没有这条了 → 召回永远失败。所以这里要能自己按 peer 重建会话再注入。
          //   用 getOrCreateByPeerWeb：它内部 manager.getOrCreate(..., {scope,targetId})，
          //   语义是"不开回合、只保证 session log 存在"，正是这种场景要的。
          //   ⚠️ 只在**唯一实例**时自动重建：openid 按 bot 应用隔离，多实例下乱建会落到错号上，
          //      那种情况宁可返回 false 让调用方（伴随扩展）走兜底文案。
          const nss = (reg.listManagerNs?.() ?? []) as string[];
          if (nss.length !== 1) return false;
          const onlyNs = nss[0];
          if (!onlyNs) return false;
          try {
            await reg.getOrCreateByPeerWeb(onlyNs, sc as never, pid, pid);
          } catch (err) { warn('wakeTo(create)', err); }
          m = reg.findManagerByPeer(sc as never, pid);
        }

        if (!m) return false;
        return (await m.injectToPeer(sc as never, pid, t, 'user')) === true;
      } catch (err) { warn('wakeTo(registry)', err); return false; }
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

    log: (...args: unknown[]) => {
      try { logger?.info?.(`[ext:${selfNow()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`); }
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
    registerRoute: (method: string, path: string, handler: (c: unknown) => unknown, idHint?: string): boolean => {
      try {
        const g = globalThis as unknown as { __qqbotExtRoutes?: Map<string, unknown> };
        if (!g.__qqbotExtRoutes) g.__qqbotExtRoutes = new Map<string, unknown>();
        // ★★ 2026-11-14 修（审查发现：这个接口**从来没成功注册过**）：
        //   原来只从 deps.extId / idHint 取，而全仓库没有任何构造方传 deps.extId，
        //   文档示例也不传 idHint ⇒ extId 恒为空 ⇒ 静默 return false，前端 404 且无日志。
        //   现在回落到扩展自己的 selfName（扩展在 run 里调用时它已经有值），
        //   并把非法字符洗成下划线（settings-host 的 SAFE_ID 只认 [A-Za-z0-9_-]）。
        const rawId = String((deps as { extId?: string }).extId || idHint || selfNow() || '').trim();
        // ★★ 2026-11-14（CodeRabbit）：必须与宿主派发端的 extCfgSafeId **逐字一致**——
        //   那边是「只删非法字符、保留首尾下划线」，我原来「替换成 _ 且去首尾下划线」⇒
        //   注册键与派发键对不上 ⇒ 注册返回 true、派发却查不到处理器。
        const extId = rawId.replace(/[^A-Za-z0-9_-]/g, '');
        if (!extId) {
          // ★ 2026-11-14（CodeRabbit）：logger 调用本身要隔离 —— 它一抛，下面的 noteDeliver 就永远执行不到
          try { logger?.warn?.('[ext-caps] registerRoute 没有可用的扩展 id（selfName/extId/idHint 全空或被清洗成空），路由未注册'); } catch { /* ignore */ }
          noteDeliver('registerRoute', false, new Error('没有可用的扩展 id，路由未注册：' + JSON.stringify(rawId)));
          return false;
        }
        const m = String(method || 'GET').toUpperCase();
        const p = String(path || '/').trim() || '/';
        g.__qqbotExtRoutes.set(extId + '|' + m + '|' + p, handler);
        return true;
      } catch (err) {
        // ★ 2026-11-14（CodeRabbit）：注册异常也要留痕，别只回一个 false
        noteDeliver('registerRoute', false, err);
        return false;
      }
    },

    // ── 入站操控（只有"手上有消息"的那一套会给值）────────────────────
    //    2026-10-12 主人定：这一组也要进能力包 —— 契约是「一套包、五套扩展」，
    //    不能只写公共部分、把入站那一块留在包外面。
    ...(deps.inbound ? { inbound: deps.inbound } : {}),

    // ── 宿主自重启（复用内置 /bot-restart 的实现，别自己 spawn）──────
    restart: (opts?: { requireOwner?: boolean; delayMs?: number }): boolean => {
      const requireOwner = opts?.requireOwner !== false;   // 默认：仅主人
      const isOwner = actorOpenid !== '' && owners.includes(actorOpenid);
      if (requireOwner && !isOwner) {
        try { logger?.warn?.(`[ext-caps] ${selfNow()} restart 被拒：仅主人可触发（想放开就传 { requireOwner: false }）`); }
        catch { /* ignore */ }
        return false;
      }
      try {
        logger?.warn?.(`[ext-caps] ${selfNow()} 触发了宿主自重启（owner=${isOwner} actor=${actorOpenid || '(未知)'}）`);
      } catch { /* ignore */ }
      return (deps.restartImpl ?? selfRestart)(opts?.delayMs);
    },
  };
}
