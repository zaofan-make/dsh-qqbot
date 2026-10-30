/** 从盘上直接读 autoRecall（settings 热更不落到闭包 config 时的兜底，2026-10-20） */
function readAutoRecallFromDiskMw(cfg: unknown): { enabled?: boolean; mode?: string; keywords?: string[]; muteSeconds?: number; dryRun?: boolean } | undefined {
  try {
    const c = cfg as { settingsNs?: string; ns?: string };
    const prof = process.env.DSH_PROFILE || 'web';
    const ns = String(c?.settingsNs || c?.ns || 'im-qqbot-2');
    const f = homedir() + '/.dsh/qqbot-settings/' + prof + '/' + ns + '.json';
    const j = JSON.parse(readFileSync(f, 'utf8')) as { groupAdmin?: { autoRecall?: { enabled?: boolean; mode?: string; keywords?: string[]; muteSeconds?: number; dryRun?: boolean } } };
    return j?.groupAdmin?.autoRecall;
  } catch { return undefined; }
}
/**
 * SDK 中间件编排
 *
 * 根据插件配置组装 SDK 内置中间件链（洋葱模型）。
 * 中间件负责过滤与上下文富化；最终消息统一由 bot.on('message') 处理转发。
 */
import type { QQBot, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  errorHandler,
  messageFilter,
  accessPolicy,
  mentionGate,
  contentSanitizer,
  slashCommand,
  concurrencyGuard,
  typingIndicator,
  quoteRef,
  envelopeFormatter,
} from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.js';
import { dataRootOf, stickerDirOf } from './data-root.js';
import type { SessionManager } from '../session/index.js';
import type { Logger } from '../types.js';
import { buildCommandList } from '../commands/index.js';
import { attachmentProcessor } from '../middleware/attachment.js';
import { mediaHistoryBuffer } from '../middleware/media-history.js';
import { prefetchQuoteImages } from '../transport/quote-images.js';
import { stickerCapture } from '../middleware/sticker-capture.js';
import { getHistoryStore, historyGroupKey } from '../features/history-store.js';
import { loadExtensionCommands } from '../features/extension-store.js';
import { registerExtCommandReloader, registerExtInboundReloader, type ExtCommandReloadResult } from '../features/ext-reload.js';
// ★ 2026-10-16 出站扩展（第六套扩展点）：配置 + 首次装载 + 给其他扩展用的"出站操控器"
import { configureOutboundExtensions, installOutboundApi, reloadOutboundExtensions } from '../features/ext-outbound.js';
import {
  loadInboundExtensions,
  runEarlyInboundExtensions,
  runInboundExtensions,
  type ExtRunOptions,
  type InboundExtension,
  type InboundLoadResult,
} from '../features/ext-inbound.js';
import { makeExtCaps } from '../features/ext-capabilities.js';
import { stickerActivityRecorder } from '../features/sticker-gate.js';
import { chatLedgerRecorder } from '../features/chat-ledger.js';
import { debounceLayer, injectSynthetic } from './debounce.js';
import { faceTagResolver } from '../features/face-tags.js';

export async function setupMiddlewares(
  bot: QQBot,
  config: ImQQBotConfig,
  manager: SessionManager,
  logger: Logger,
  /** ★ 插件的 cordis ctx —— 传给自定义命令当"内核句柄"（env.ctx），见 ext-capabilities.ts */
  pluginCtx?: unknown,
): Promise<void> {
  // ★ 2026-10-24：把「整体热重载」挂到 globalThis，供 settings-host.js（面板后端）借用。
  //   面板的启停开关要立即生效就得调 manager.reloadAllChannelTools()，
  //   但 settings-host 是旁路桥、拿不到 manager；这里手里就有，登记一下最省事。
  //   重启后 setupMiddlewares 会重跑，注册表自然重建 —— 不用持久化。
  //   key 用 dataRoot，多 bot 各存各的。
  try {
    const g = globalThis as unknown as { __qqbotReloaders?: Map<string, () => Promise<string>> };
    g.__qqbotReloaders ||= new Map();
    const dr = (manager as unknown as { dataRoot?: string }).dataRoot || '';
    g.__qqbotReloaders.set(dr, () => manager.reloadAllChannelTools());
    // ★ 2026-10-27：把 manager 本身也登记 —— 设置面板的扩展 UI 卡片要「往当前会话
    //   静默注入一条消息（不唤醒 AI）」，那就得能按 peer 找到该会话的 agent。
    //   settings-host 是旁路桥、拿不到 manager，只能从这里取。
    try {
      const gm = globalThis as unknown as { __qqbotManagers?: Map<string, unknown> };
      gm.__qqbotManagers ||= new Map();
      gm.__qqbotManagers.set(dr, manager);
    } catch { /* ignore */ }
  } catch { /* 挂不上不影响主流程 */ }

  // 0. 用户扩展命令(P4.1): 加载插件包外扩展目录的命令, 并入下方 cmdList/slash,
  //    群聊前置解析 cmdMap 与 SDK slash 双通道自然覆盖 → /扩展命令 重启后即用。
  // ⚠️ 2026-10-12 主人定：命令表改为**可重建**。此前扩展命令只在启动时扫一次，
  //    改 `.qqbot-extensions/commands/*.js` 必须重启插件；现在与扩展工具一视同仁支持热重载
  //    （热刷入口 SessionManager.reloadAllChannelTools → reloadExtCommands，见 features/ext-reload.ts）。
  //    注意 cmdList / cmdMap 都**保持同一引用、只换内容** —— 它们还会被下面的对象捕获(如 commands: cmdList)。
  // ── 命令表提前构建(2026-09-08): 供"历史缓冲跳过命令消息"(命令不进 AI 上下文) + 第8步命令执行复用 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmdList: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmdMap = new Map<string, any>();
  /** 重扫扩展目录 + 重建命令表；首次启动与热重载走同一条路，避免两套逻辑漂移 */
  const rebuildCommandTable = async (): Promise<ExtCommandReloadResult> => {
    const ext = await loadExtensionCommands(dataRootOf(config), logger);
    const all = [...buildCommandList({ manager, config }), ...ext];
    cmdList.length = 0;
    cmdList.push(...all);
    cmdMap.clear();
    for (const c of all) {
      const names = Array.isArray(c.name) ? c.name : [c.name];
      for (const n of names) cmdMap.set(String(n).toLowerCase(), c);
    }
    const names = Array.from(new Set(ext.flatMap((c) => (Array.isArray(c.name) ? c.name : [c.name])).map(String)));
    if (names.length > 0) {
      logger.info(`[im-qqbot] 用户扩展命令已加载: ${names.length} 个 → ${names.map((n) => '/' + n).join(', ')}`);
    }
    return { names };
  };
  await rebuildCommandTable();
  // 注册给热重载入口：工具热刷时顺带重扫扩展命令（解耦见 features/ext-reload.ts）
  // ★ 2026-10-27：按本实例的 dataRoot 注册（多实例各存各的，不再互相覆盖）
  registerExtCommandReloader(dataRootOf(config), rebuildCommandTable);
  /** 斜杠开头且命中真实命令(含 stop/bot-stop)→ 返回命令名小写; 未知命令/纯文本 → null(放行) */
  const knownCmdName = (content: string | undefined): string | null => {
    const t = String(content ?? '').trim();
    if (!t || !t.startsWith('/')) return null;
    const cleaned = t.replace(/<@!?[^>]+>\s*/g, '').trim();
    if (!cleaned.startsWith('/')) return null;
    const m = /^(\S+)/.exec(cleaned.slice(1));
    if (!m) return null;
    const name = String(m[1]).toLowerCase();
    if (name === 'stop' || name === 'bot-stop') return name;
    return cmdMap.has(name) ? name : null;
  };
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 1.2 表情标签名字解析(本地实现, 2026-09-06): 必须挂在**最顶层**(任何历史/缓冲之前)——
  //     mediaHistoryBuffer(第4步)会把 content 原文存进群历史, AI 上下文读的是历史里的文本,
  //     若解析放后面, 历史里存的就是 <faceType=...> 原文, AI 永远看不到名字。
  //     这里把 <faceType=N,faceId="X",ext="b64"> / [<face,id=N/>] 转成【表情: 名字】:
  //     ext.text 优先(官方名字最准), 空则按 faceId 查 QQ 经典表情名表(0=微笑…160+),
  //     SDK contentSanitizer(parseFaceTags) 只解 ext.text, text 空会丢 faceId → 本层先吃掉标签。
  bot.use(faceTagResolver());

  // 1.5 消息串行闸(本地手改, 2026-09-05)：
  //     SDK 收帧处 `void Promise.resolve(onMessage(...))` 不等待 → 快速连发时多条消息的
  //     中间件链并发执行、在各 await 处交错 → 到达下游(历史缓冲/debounce/派发)的顺序
  //     ≠ 官方推送顺序(即真实发送序)。这里把每条消息的整条下游链排队串行:
  //     前一条消息处理完才放行下一条, 恢复官方帧序。零 SDK 改动, 只作用于本 bot 实例。
  //     ⚠️ 本地手改功能, 同步纪律同群冷却中间件。
  // ── 群普通消息"上次派发时刻"(冷却中间件与 debounce 融合层共享) ──
  const lastDispatchAt = new Map<string, number>(); // groupOpenid -> 上次普通派发时间(ms)
  let inboundTail: Promise<void> = Promise.resolve();
  bot.use(async (_ctx: MiddlewareContext, next: () => Promise<void>) => {
    const run = inboundTail.then(() => next());
    inboundTail = run.catch(() => undefined) as Promise<void>;
    await run;
  });

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 3. 访问控制（白名单/开放/禁用）
  bot.use(accessPolicy({
    c2c: {
      mode: config.access.c2cMode,
      allow: config.access.c2cAllow.length > 0 ? config.access.c2cAllow : ['*'],
    },
    group: {
      mode: config.access.groupMode,
      allow: config.access.groupAllow.length > 0 ? config.access.groupAllow : ['*'],
    },
    onBlock: (_mCtx, reason) => {
      if (config.debug) {
        logger.debug(`Access blocked: ${reason}`);
      }
    },
  }));

  // 3.9. 引用消息解析（记录每条消息 + 解析被引用原文）
  //   ⚠️ 2026-10-01 **前移**（原在第 11 步）: 群历史缓冲在第 4 步, 而它记 content 时要读
  //   `ctx.state.quote` —— 顺序反了的话这里永远是 undefined, 历史行里就永远没有 `[引]…[/引]`,
  //   聚合打包给 AI 时"他引用了什么"整段丢失(主人实测: 当前消息有、历史里没有)。
  bot.use(quoteRef({
    maxSize: 500,
    preferMsgElements: true,
  }));

  // 3.95. 用户「入站中间件」扩展点（第五套扩展，2026-10-12）—— ★早挂点 onInbound ★
  //   `{dataRoot}/.qqbot-extensions/inbound/*.mjs` 里导出的 `onInbound` 挂**这里**：
  //   **quoteRef 之后、记群历史（下一步）之前** —— 四个动作里三个只有这个位置做得到：
  //     · 消灭 annihilate："链停在这里" ⇒ 群历史不记、上下文不进、冷却不占；
  //     · 改写 rewrite：群历史缓冲读的就是 `ctx.message.content`，这里改才来得及（历史里就是改后文本）；
  //     · 强制入站 forceWake：写 `ctx.state.qqInboundForceWake`，供紧随其后的 mentionGate（见第 5 步的
  //       resolveConfig）与后面的 debounce/价值评分放行；
  //     · 查禁言名单：名单必须在"值不值得回 / @ 没 @ / 冷却到没到"之前生效 —— 也只能在最早处查。
  //   ⚠️ 这里**读不到** `ctx.state.mention`（那是后面 mentionGate 赋的值）；要判"这条有没有 @ 她"
  //      请用 `ctx.platform.mentioned`（与 SDK mentionGate 同款三选一判据）。
  //   引擎在 features/ext-inbound.ts：单扩展独立 try/catch（抛错只告警并继续 next()，绝不因用户脚本坏了
  //   就吞掉入站消息）、next() 幂等且一定被 await、目录缺失/为空完全安静、动作永不抛到链上。
  //   这里挂的是**代理**（现读 inboundExts），所以热重载只换内容、不用重挂中间件（见下方 registerExtInboundReloader）。
  const inboundExts: InboundExtension[] = [];
  /**
   * 入站扩展的运行环境：状态文件/审计落 dataRoot；owners 用于"白名单最高优先"；appId 给 platform 判定。
   *
   * ★ 2026-10-12 主人定「能力面对齐」：这里同时把**统一能力包**（`features/ext-capabilities.ts`）
   *   要的输入喂进去 —— 入站扩展必须和另外四套（自定义命令 / 扩展工具 / botplay 卡片 / 启动钩子）
   *   拿到同一套能力（`store` / `api()` / `markdown` / `appendSilent` / `user` / `kernel` …），
   *   依据见 `docs/USER-GUIDE.md` §「统一能力包」。**发送器与回复目标在 ctx 上**（每个会话不同），
   *   所以这个工厂收一个可选的 ctx；缺它时发送类能力优雅降级（返回 false），不会影响入站主链。
   */
  const extRunOpts = (ctx?: {
    message?: { kind?: string; groupOpenid?: string; senderId?: string };
    bot?: unknown;
    replyTarget?: unknown;
  }): ExtRunOptions => ({
    dataRoot: dataRootOf(config),
    owners: (config.groupAdmin?.owners ?? []).map(String),
    appId: config.appId,
    // ── 以下为统一能力包与 silentInto 的输入 ──
    sender: ctx?.bot,
    replyTarget: ctx?.replyTarget,
    appSecret: config.appSecret,
    apiCall: (manager.groupAdmin as { apiCall?: unknown } | undefined)?.apiCall,
    kernel: pluginCtx,
    // 「这条消息所属会话的宿主 agent」：与命令层 / commands/inject.ts **同一口径**
    // （会话 id 由 scope + peerId 确定性派生 ⇒ "这条消息将去哪" 与 "解析到的 agent" 必然是同一个）
    resolveAgent: (c: { message?: { kind?: string; groupOpenid?: string; senderId?: string } }) => {
      try {
        const mc = c.message as { kind?: string; groupOpenid?: string; senderId?: string } | undefined;
        const isG = mc?.kind === 'group';
        const pid = String((isG ? mc?.groupOpenid : mc?.senderId) ?? '');
        if (!pid) return undefined;
        return manager.findByPeer((isG ? 'group' : 'c2c') as never, pid)?.agent;
      } catch { return undefined; }
    },
  });
  /** 重扫入站扩展目录并原地换掉生效列表；首次启动与热重载走同一条路，避免两套逻辑漂移 */
  const reloadInboundExtensions = async (): Promise<InboundLoadResult> => {
    const r = await loadInboundExtensions({ dataRoot: dataRootOf(config), logger });
    inboundExts.length = 0;
    inboundExts.push(...r.extensions);
    return r;
  };
  await reloadInboundExtensions();
  // 注册给热重载入口：工具热刷（/tools-reload、tools_reload）时顺带重扫入站扩展 → **不重启也生效**
  registerExtInboundReloader(async () => {
    const r = await reloadInboundExtensions();
    return { count: r.total, names: r.extensions.map((e) => e.name) };
  });

  // ── 出站扩展（第六套扩展点，2026-10-16 主人定）──────────────────────────────
  //   `{dataRoot}/.qqbot-extensions/outbound/*.mjs` 由 transport/outbound-buffer 的
  //   `sendRichOutbound` 在**发送前**调 `runOutboundChain` 生效（改正文 / 消灭这条 / 补发媒体）。
  //   这里只做两件事：① 把 dataRoot+logger 配置进去（之后热刷可直接重扫，不必再注册回调）；
  //   ② 首次装载 + 装"出站操控器"（`globalThis[Symbol.for('im-qqbot.outbound')]`）供**其他扩展**调用。
  try {
    configureOutboundExtensions({ dataRoot: dataRootOf(config), logger });
    installOutboundApi();
    const ro = await reloadOutboundExtensions();
    if (ro.total > 0) {
      logger.info(`[ext-outbound] 启动装载 ${ro.total} 个出站扩展: ${ro.extensions.map((e) => e.name).join(', ')}`);
    }
  } catch (err) {
    // 出站扩展装载失败**绝不影响出站**：链在没装到扩展时就是直通
    logger.warn(`[ext-outbound] 启动装载失败(不影响出站): ${err instanceof Error ? err.message : String(err)}`);
  }
  bot.use(async (ctx, next) => {
    await runEarlyInboundExtensions(inboundExts, ctx, next, logger, extRunOpts(ctx));
  });

  // 3.95. 被引用图片**预取**（2026-10-01 主人要求"尽可能转换成本地路径"）：
  //   有人引用一张图问"这是啥"时，那张图我们可能从没收藏过 → 缓存/图库都查不到，
  //   引用块只能回退 QQ 长链接(带 rkey、还会过期, AI 读不了)。
  //   这里在**拼上下文之前**先把被引用的图片下载落盘并记好 URL→本地路径，
  //   后面同步的引用块（当前消息 + 历史行）就都能给出本地路径了。
  bot.use(async (ctx, next) => {
    try {
      const q = (ctx.state as { quote?: Parameters<typeof prefetchQuoteImages>[0] }).quote;
      await prefetchQuoteImages(q, dataRootOf(config), logger);
    } catch { /* 预取失败不影响主链 */ }
    await next();
  });

  // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
  //    store 按 appId 独立(getHistoryStore(config.appId)), groupKey 带 appId 前缀, 供回复后清空
  //    ⚠️ 用增强版 mediaHistoryBuffer(本地手改，替代 SDK historyBuffer)：
  //       记历史时把带 URL 的附件折叠进 content，冷却期群友发的图/媒体在历史里也带链接
  bot.use(mediaHistoryBuffer({
    limit: config.historyLimit,
    store: getHistoryStore(config.appId),
    recordOnSkip: true,
    groupKey: (ctx) => {
      const gid = ctx.message.groupOpenid;
      if (ctx.message.kind !== 'group' || !gid) return undefined;
      return historyGroupKey(config.appId, gid);
    },
    // 斜杠命令不入 AI 历史(命令由下方命令层执行, 无需当聊天喂给 AI)
    skipWhen: (ctx) => knownCmdName((ctx.message as { content?: string }).content) !== null,
    // 2026-09-15: 本中间件在 mentionGate **之前**, 读不到 ctx.state.mention(那正是 mentionGate 赋的值)
    //   → 改由本中间件自己判定"这条 @ 了她", appId 用于内容兜底扫描 <@{appId}>。见 media-history.ts。
    appId: config.appId,
    stickerDir: stickerDirOf(config),
  }));

  // 4.5. 表情包自动收藏（P0）：群图片 → 本地图库（fire-and-forget，不阻塞主链）
  bot.use(stickerCapture(config, logger));

  // 4.6. 表情包闸门活性计数（P1）：记录所有群消息时间戳 → RingBuffer，供"热闹才发"判定。
  //     ⚠️ 必须在 mentionGate(第5步) 之前：未@消息被门控截断也照样计数。
  //     多账号: 每实例传自己 dataDir(各号各闸门状态)。
  bot.use(stickerActivityRecorder(stickerDirOf(config)));

  // 4.7. 聊天台账（M3）：记录机器人见过的群/私聊(带昵称) → known-chats.jsonl，
  //     供 Web ④区定时唤醒"点选聊天对象"(不用抄 openid)。也在 mentionGate 之前。
  const ledgerDataDir = stickerDirOf(config);
  bot.use(chatLedgerRecorder(ledgerDataDir));

  // 5. 群聊 @bot 门控
  bot.use(mentionGate({
    requireMentionInGroup: config.requireMention,
    // ★ 2026-10-12：入站扩展的 `forceWake` 必须能**跳过 @ 门控**（"强唤醒优先"落到门控这一层）。
    //   为什么用 resolveConfig：SDK 里 `dynamic?.requireMentionInGroup` 是**最高优先**的入参
    //   （它被当成 resolvePolicy 的 explicit 参数，压过静态选项与 ctx.state.policy），
    //   而没被 forceWake 时这里返回空对象 → 判定与原来**逐字一致**（零回归）。
    //   语义：置了 forceWake ⇒ 这一条按"无需 @"放行（wasMentioned 仍如实为 false，不伪造 (@you)）。
    resolveConfig: (ctx) => (ctx.state as { qqInboundForceWake?: unknown }).qqInboundForceWake === true
      ? { requireMentionInGroup: false }
      : {},
  }));

  // 5.5 用户「入站中间件」扩展点（第五套扩展，2026-10-12）—— ★晚挂点（默认导出 / onDecide）★
  //     早挂点（onInbound）挂在第 3.95 步（记群历史之前），装载/热重载与运行环境都在那里一次办好；
  //     这里只挂**晚**挂点，位置与语义与 2026-10-12 起的旧契约**完全一致**：
  //     ① 读 `ctx.state.mention`（mentionGate 刚赋的判定）② **改写**它（把 wasMentioned 压成 false
  //     = 这条不按 @ 处理）③ 不调 next() 把这条**整条拦掉**（注意：群历史此时已经记过了，
  //     真"消灭"要用早挂点的 `ctx.annihilate()`）。
  //     ⚠️ 挂载位置是**硬要求，别挪**：
  //        · 必须在 mentionGate **之后** —— 否则读不到 `ctx.state.mention`（那正是门控写的）；
  //        · 必须在 contentSanitizer / debounce **之前** —— 否则改了不算数：debounce 的窗口条目读的就是
  //          这里改过的 `ctx.state.mention.wasMentioned`，再往后（inbound/评分/唤醒）已经决定完了。
  bot.use(async (ctx, next) => {
    await runInboundExtensions(inboundExts, ctx, next, logger, extRunOpts(ctx));
  });

  // 6. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({
    parseFaceTags: true,
  }));

  // 6.6 延迟聚合(debounce)融合层(本地手改, 2026-09-05)：在群冷却**之前**拦截。
  //     消息(群普通/@ + 私聊)先进 per-peer 窗口攒着(不进冷却中间件), 最近说话者停口 X 秒
  //     或攒满 Y 条 → 尝试派发一次: 群普通受 60s 冷却约束(未过则窗口保留继续等, 到点整批
  //     按服务器时间序综合回, 不再出现"current 早于 history"的倒序); @ 消息无视冷却随时派发。
  //     debounce.enabled=false 或 @ 秒回(mentionDelayed=false)/斜杠命令 → 直放行, 交下方群冷却中间件
  //     与既有链路处理(原 60s 冷却语义完整保留)。配置 config.behavior.debounce(live 热更)。
  //     ⚠️ 本地手改功能, 同步纪律同下方群冷却中间件。
  // 自动撤回（2026-10-20 主人定）★ 必须挂在 debounce **之前**：
  //   debounce 会攒窗口、延后派发，等到 handleInbound 时早过了 2 分钟撤回窗口（实测：消息都没进入站日志）。
  //   命中且 mode=drop 时直接不 next()（吞掉，后续/AI 都收不到）；keep 则撤完继续。
  bot.use(async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    try {
      const m = (ctx as { message?: { messageId?: string; groupOpenid?: string; content?: string; senderId?: string } }).message;
      const ar = readAutoRecallFromDiskMw(config) ?? (config as { groupAdmin?: { autoRecall?: { enabled?: boolean; mode?: string; keywords?: string[]; muteSeconds?: number; dryRun?: boolean } } })
        .groupAdmin?.autoRecall;
      if (m && ar?.enabled === true && m.messageId && m.groupOpenid) {
        const kws = (ar.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
        const lower = String(m.content ?? "").toLowerCase();
        const hit = kws.some((k) => lower.includes(k.toLowerCase()));
        if (hit) {
          const ga = manager.groupAdmin;
          if (ar.dryRun !== true && ga) {
            void ga.recallMessage(String(m.groupOpenid), String(m.messageId), "group").catch(() => undefined);
            const secs = Math.max(0, Math.round(Number(ar.muteSeconds) || 0));
            const sid = String(m.senderId ?? "");
            if (secs > 0 && /^[0-9A-Za-z]{32}$/u.test(sid)) {
              const p2 = (n: number): string => String(n).padStart(2, "0");
              const ex = new Date(Date.now() + secs * 1000);
              const rfc = `${ex.getFullYear()}-${p2(ex.getMonth() + 1)}-${p2(ex.getDate())}T${p2(ex.getHours())}:${p2(ex.getMinutes())}:${p2(ex.getSeconds())}+08:00`;
              void ga.setMemberMute(String(m.groupOpenid), sid, rfc).catch(() => undefined);
            }
          }
          logger.info("auto-recall(mw) hit: " + String(m.content ?? "").slice(0, 20) + " drop=" + String(ar.mode === "drop"));
          if (ar.mode === "drop") return;
        }
      }
    } catch (e) {
      logger.warn("auto-recall(mw) error: " + (e instanceof Error ? e.message : String(e)));
    }
    return next();
  });
  bot.use(debounceLayer(config, manager, logger, lastDispatchAt));

  // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
  //    基础命令 + 用户扩展命令(P4.1)已在上方合并为 cmdList/cmdMap(同时供历史缓冲跳过命令);
  //    群聊放开"必须 @bot"限制(SDK 硬性要求 @ 才触发, 导致直发 /cmd 变文本):
  //    前置解析已知命令(除 stop/bot-stop——保留给下方 concurrencyGuard 的 urgent 打断链路)。类型宽松以适配 SDK ctx。
  const sendCmdResult = async (ctx: any, result: unknown): Promise<void> => {
    if (result === undefined || result === null) return;
    if (typeof result === 'string') { if (result) await ctx.bot?.sendText(ctx.replyTarget, result); return; }
    if (typeof result === 'object') {
      const r = result as { kind?: string; content?: string };
      if (r.kind === 'text' && r.content) await ctx.bot?.sendText(ctx.replyTarget, r.content);
    }
  };
  bot.use(async (ctx: any, next: () => Promise<void>) => {
    if (ctx.message?.kind !== 'group') return next(); // 私聊 SDK 已支持
    const content = String(ctx.message?.content ?? '').trim();
    if (!content || !content.startsWith('/')) return next();
    const cleaned = content.replace(/<@!?[^>]+>\s*/g, '').trim();
    if (!cleaned.startsWith('/')) return next();
    const body = cleaned.slice(1);
    const m = /^(\S+)(?:\s+(.*))?$/.exec(body);
    if (!m) return next();
    const name = String(m[1]).toLowerCase();
    if (name === 'stop' || name === 'bot-stop') {
      // 真正打断: cancel 当前 peer 的活跃回合(不只是消费消息)
      try {
        const isGroup = ctx.message?.kind === 'group';
        const scope = isGroup ? 'group' : 'c2c';
        const peerId = isGroup ? ctx.message.groupOpenid : ctx.message.senderId;
        const rec = peerId ? manager.findByPeer(scope as never, peerId) : undefined;
        if (rec && rec.agent && typeof rec.agent.cancel === 'function') {
          rec.agent.cancel({ kind: 'user' });
          try { await ctx.bot?.sendText(ctx.replyTarget, '⏹ 已停止当前生成'); } catch { /* ignore */ }
        } else {
          try { await ctx.bot?.sendText(ctx.replyTarget, '当前没有在生成的回合'); } catch { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      if (typeof ctx.stop === 'function') { ctx.stop('command:' + name); return; }
    }
    const cmd = cmdMap.get(name);
    if (!cmd) return next(); // 未知命令放行
    const parsed = { name, args: m[2] ? String(m[2]).split(/\s+/) : [], raw: m[2] ?? '' };
    if (ctx.state) ctx.state.command = parsed;
    // ★ 2026-10-06 统一能力包（见 features/ext-capabilities.ts）：
    //   自定义命令以前**能力面最窄**（只有一个消息 ctx），现在补上「发消息 / 官方 API /
    //   持久化 / 上下文 / 身份」。只补不覆盖；构造失败不影响命令本身的执行。
    const capsForCmd = (() => {
      try {
        // ★ 2026-10-25 修：按 QQ 官方事件体结构取发送者。
        //   官方文档（参考文档/qqbot-api-v2-docs-20261020/html/autogen__event__group_at_message_create.html）写明：
        //     | author | User | 发送者（member_openid 有值）|
        //     User = { id, username, bot, union_openid, user_openid, member_openid }
        //   群聊取 author.member_openid，单聊取 author.user_openid，兜底 author.id。
        //   之前读的是自造的 mc.senderId —— 那个字段根本不存在，永远是空，
        //   于是命令侧拿不到发送者 → isOwner 恒 false → /companion 一直说"仅主人可用"。
        const mc = ctx.message as {
          kind?: string;
          groupOpenid?: string;
          group_openid?: string;
          senderId?: string;
          author?: { id?: string; username?: string; member_openid?: string; user_openid?: string };
        } | undefined;
        const isG = mc?.kind === 'group';
        const sc = isG ? 'group' : 'c2c';
        const actorOpenid = String(
          mc?.author?.member_openid
          ?? mc?.author?.user_openid
          ?? mc?.author?.id
          ?? mc?.senderId
          ?? ''
        );
        const pid = String((isG ? (mc?.groupOpenid ?? mc?.group_openid) : actorOpenid) ?? '');
        const rec = pid ? manager.findByPeer(sc as never, pid) : undefined;
        const ga = manager.groupAdmin;
        return makeExtCaps({
          dataRoot: dataRootOf(config),
          logger,
          // ★ 2026-10-25：命令侧也必须能"点名唤醒"，否则 caps.wakeTo 恒返回 false。
          //   之前只有钩子侧（ext-hooks.ts）注入了 deps.wakeTo，命令调的 /companion test
          //   永远走"唤醒没送达"分支 —— makeExtCaps 总会给出 wakeTo 函数（所以"能力在"），
          //   但它内部读不到 deps.wakeTo 就直接 return false（所以"没送达"）。
          //   真身用 manager.injectToPeer()：它的语义就是"往某会话塞一条新消息，
          //   AI 带上下文处理并回复到 QQ"，与 appendWake 同一条路，只是目标由 (scope,peerId) 显式指定。
          wakeTo: (scope2: string, peerId2: string, text2: string) =>
            manager.injectToPeer(scope2 as never, peerId2, text2, 'user'),
          appId: (config as { appId?: string }).appId,
          appSecret: (config as { appSecret?: string }).appSecret,
          // 2026-10-25 修：主人白名单在 config.groupAdmin.owners，不是 config.owners
          //   （与 bootstrap.ts:778 botplay 侧同口径，那边一直是对的）
          owners: (Array.isArray((config as { groupAdmin?: { owners?: string[] } }).groupAdmin?.owners)
            ? (config as { groupAdmin?: { owners?: string[] } }).groupAdmin!.owners!.map(String)
            : []),
          // 命令侧能拿到的发送器就是中间件 ctx 上的 bot（至少有 sendText / sendMarkdown）；
          // 缺什么能力，对应的 env.xxx 会优雅地返回 false，而不是抛错。
          // 2026-10-30：优先用 manager 的真 QQBotSender（含 sendMedia / sendTuwenCard），
          //   否则退回中间件 ctx.bot（SDK 实例，只有 sendText / sendMarkdown）——
          //   用后者时命令侧 env.image()/env.card() 全是 false（"/头像 图发不出来"就是这么来的）。
          sender: ((manager as unknown as { sender?: unknown }).sender ?? (ctx as { bot?: unknown }).bot) as never,
          replyTarget: (ctx as { replyTarget?: unknown }).replyTarget,
          agent: (rec as { agent?: unknown } | undefined)?.agent as never,
          // ★ 2026-10-13 加：**本会话的 DSH 会话 id** —— 回灌钩子要的正是它。
          //   钩子（.qqbot-extensions/tools/lib/session_watch_lib.mjs:563）的匹配口径是
          //   `session.id`（session/event 里那个 session 的 id），**不是 agent.id**；
          //   而命令侧原本连"会话 id"都拿不到 ⇒ 回灌钩子永远挂不上（现象：建完显示「回灌 → 未挂」）。
          //   sessionIdFor() 自带派生兜底，所以这里总有值。
          peerSessionId: pid ? manager.sessionIdFor(sc as never, pid) : '',
          scope: sc,
          peerId: pid,
          actorOpenid,
          apiCall: ga && typeof ga.apiCall === 'function'
            ? ((mm: 'GET' | 'POST' | 'PATCH' | 'DELETE', p: string, b?: unknown) => ga.apiCall(mm, p, b)) as never
            : undefined,
          selfName: name,
          kind: 'commands',
          // ★ 内核句柄（遥控器）：与扩展工具对齐 —— 命令也能 ctx.get/ctx.on/ctx.tools.register
          kernel: pluginCtx,
        });
      } catch { return undefined; }
    })();
    const handlerArg: Record<string, unknown> = {
      ...ctx,
      command: parsed,
      // ── 2026-10-25 兼容别名：`ctx.args` / `ctx.rawArgs` ──────────────────
      //   起因：proactive-companion 这类扩展命令按 `ctx.args || ctx.rawArgs` 取参数
      //   （它们以为框架给的是字符串），实测都拿到 undefined → 子命令全部失效、
      //   永远走默认的 status 分支。
      //   与其让每个作者都改成 ctx.command.raw，不如我们把别名补上：
      //   值统一是「命令名之后、未切分的原始字符串」，与 ctx.command.raw 同源。
      //   （我们自己的命令一律走 ctx.command.args / .raw，不受影响）
      args: parsed.raw,
      rawArgs: parsed.raw,
    };
    // ★ 2026-10-25：补齐 docs/extension-contract.md §2 承诺的 user / peer 命名空间
    //   文档写的是 `env.user.openid/name/isOwner`、`env.peer.scope/peerId`，
    //   命令侧原本只有顶层 `caps.actorOpenid` 这类字段 —— 对不上，作者照文档写必然拿到 undefined。
    //   （这里不新增私有别名，只把文档承诺的那两个对象补出来；旧字段照旧保留。）
    {
      const c = capsForCmd as { actorOpenid?: string; scope?: string; peerId?: string; owners?: string[] } | undefined;
      const who = c?.actorOpenid ? String(c.actorOpenid) : '';
      const ownerList = Array.isArray(c?.owners) ? c!.owners!.map(String) : [];
      handlerArg.user = {
        openid: who || undefined,
        name: (ctx as { senderName?: string; message?: { senderName?: string } })?.senderName
          ?? (ctx as { message?: { senderName?: string } })?.message?.senderName,
        isOwner: Boolean(who && ownerList.includes(who)),
      };
      handlerArg.peer = {
        scope: c?.scope,
        peerId: c?.peerId,
      };
      // 作者生态里还有一批按顶层名字找身份的写法（isOwnerContext 的候选列表），一并给到；
      // 值同源，不引入新语义。
      handlerArg.senderOpenid = who || undefined;
      handlerArg.userOpenid = who || undefined;
      handlerArg.openid = who || undefined;
      handlerArg.owners = ownerList;
    }
    // ★ 2026-10-24：把「该扩展自己的设置」塞进来（面板里填的值），扩展用 ctx.config 读
    try {
      const cmdFile = (cmd as unknown as { __file?: string }).__file;
      const dr = (manager as unknown as { dataRoot?: string }).dataRoot
        || (ctx as unknown as { cwd?: string }).cwd
        || '';
      if (cmdFile && dr) {
        const { readExtConfig } = await import('../features/ext-config.js');
        // 2026-10-25：bot 凭证也塞进 config —— 扩展生态（proactive-companion 的
        //   lib/transport.mjs credentials()）从 env.config.appId/appSecret 读凭证自己换 token，
        //   而宿主的 config 本来是「扩展自己的设置」，两者对不上就报 NO_CREDENTIALS。
        handlerArg.config = {
          ...(readExtConfig(dr, cmdFile) as Record<string, unknown>),
          appId: (config as { appId?: string }).appId,
          appSecret: (config as { appSecret?: string }).appSecret,
          owners: (Array.isArray((config as { groupAdmin?: { owners?: string[] } }).groupAdmin?.owners)
            ? (config as { groupAdmin?: { owners?: string[] } }).groupAdmin!.owners!.map(String)
            : []),
        };
        handlerArg.__file = cmdFile;
      }
    } catch { handlerArg.config = {}; }
    if (capsForCmd) {
      // ⚠️ 2026-10-12 修（探针实测驱动）：原判据 `!(k in handlerArg)` 只问"有没有这个键"，
      //   而中间件 ctx 里 sender / agent 这类键**存在但值是 undefined**，于是 caps 里的好值
      //   全被跳过 —— 命令 ctx 顶层 hasSender=false / hasAgent=false，可同一个 caps 在工具侧
      //   却是好的。扩展工具拿得到的能力，扩展命令也必须拿得到：改成"值为 undefined 才补"。
      for (const [k, v] of Object.entries(capsForCmd)) {
        if (v === undefined) continue;
        if (!(k in handlerArg) || handlerArg[k] === undefined) handlerArg[k] = v;
      }
      handlerArg.caps = capsForCmd;
    }
    try {
      const result = await cmd.handler(handlerArg as never);
      // 扩展命令可返回 { wake: { content, senderName? } } → 请把一条合成消息交给聚合层唤醒 AI
      // (2026-09-12: /资源 未命中用; 与真人消息同窗口聚合, 人多不会各开一回合)
      try {
        const wk = (result as { wake?: { content?: string; senderName?: string } } | null)?.wake;
        const wText = typeof wk?.content === 'string' ? wk.content.trim() : '';
        if (wText) {
          const m0 = (ctx.message ?? {}) as Record<string, unknown>;
          const k0 = String(m0.kind ?? '');
          const pid = k0 === 'group' ? String(m0.groupOpenid ?? m0.senderId ?? '') : String(m0.senderId ?? '');
          if ((k0 === 'group' || k0 === 'c2c') && pid) {
            const ok = injectSynthetic(k0 as 'group' | 'c2c', pid, wText, { senderName: wk?.senderName }, manager);
            ctx.log?.info?.(`[qqbot-cmd] ${name} wake → ${ok ? '已交聚合层' : '无可用聚合实例'}`);
          }
        }
      } catch { /* wake 失败不影响命令本身 */ }
      await sendCmdResult(ctx, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log?.error?.('[qqbot-cmd] handler "' + name + '" threw: ' + msg);
      try { await ctx.bot?.sendText(ctx.replyTarget, '命令出错: ' + msg); } catch { /* ignore */ }
    }
    if (typeof ctx.stop === 'function') { ctx.stop('command:' + name); return; }
  });
  const slash = slashCommand({
    autoHelp: true,
    commands: cmdList,
  });
  bot.use(slash.middleware);  // 7. 回复冷却调度(配置化, 替代写死 REPLY_COOLDOWN_MS=60000)：照常接收并记录所有群消息
  //    (mediaHistoryBuffer 已在上方记录), 但每群按 config.behavior 间隔才真正派发一次给 AI。
  //    注: debounce 开启时群消息被其拦截, 此中间件仅兜底 debounce 直放行的消息(命令/@秒回/功能关闭)。
  //    ⚠️ 本地手改功能（曾被重编译冲掉），改完务必保持 src 与部署 dist 同步。
  //    ⚠️ 每次调用现读 config.behavior(勿外层解构)——支持 Web settings live 热更新。
  bot.use(async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    // 私聊/无群号：不纳入调度，直接放行
    if (ctx.message.kind !== 'group' || !ctx.message.groupOpenid) {
      return next();
    }
    const { freeIntervalSec, mentionIntervalSec } = config.behavior;
    const gid = ctx.message.groupOpenid;
    const wasMentioned = ctx.state.mention?.wasMentioned === true;
    const intervalSec = wasMentioned ? mentionIntervalSec : freeIntervalSec;
    // 适用间隔=0：不冷却直接放行(@立即回；无@放行后是否到 AI 由 requireMention 门控决定)
    if (intervalSec <= 0) {
      return next();
    }
    const now = Date.now();
    const prev = lastDispatchAt.get(gid);
    const last = prev ?? 0;
    if (now - last < intervalSec * 1000) {
      // 冷却期内：消息已被 mediaHistoryBuffer 记进群历史，本次不派发 → 不调 next()
      return;
    }
    // 冷却结束：派发当前消息。用独立的 batchDispatch 标记，让下游把累积的群历史一起打包
    //（不伪装成 @you，避免出现假 (@you) 标签误导 AI）
    lastDispatchAt.set(gid, now);
    // ⚠️ 2026-09-13(主人要求): 冷却应当"**真产生回复**才算消耗" —— 派发只是试一下,
    //    下游可能因为价值评分低分而**不唤醒**(那就没有回复), 这种不该白吃一枚冷却。
    //    于是把"还回去"的回调挂到 state, 下游判定"本次没回复"时调一次即可。
    ctx.state.qqCooldownRollback = {
      prev,
      restore: () => { if (prev === undefined) lastDispatchAt.delete(gid); else lastDispatchAt.set(gid, prev); },
    };
    ctx.state.batchDispatch = true;
    return next();
  });



  // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
    urgentPredicate: (mCtx: MiddlewareContext) => {
      return (mCtx.message.content ?? '').trim() === '/bot-stop';
    },
  }));

  // 10. C2C 输入状态指示
  bot.use(typingIndicator());

  // 11. 引用消息解析 —— ⚠️ 2026-10-01 已**前移到第 3.9 步**（必须在群历史缓冲之前,
  //     否则 mediaHistoryBuffer 读不到 ctx.state.quote → 历史里的引用块永远是空的）。

  // 11.5. 附件下载（file 附件下载到本地，供 @提及 / 工具访问）
  bot.use(attachmentProcessor(config, logger));

  // 12. 上下文组装（将 history + quote + sender 组成 envelope）
  bot.use(envelopeFormatter({
    historyLimit: config.historyLimit,
    includeQuote: true,
    includeSender: true,
  }));
}
