/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { QQBot, type ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import { FULL_INTENTS } from '@tencent-connect/qqbot-nodejs/protocol';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { SessionManager, type DshAgentRegistry } from '../session/index.js';
import { handleInbound, createOutboundHandler } from '../transport/index.js';
import { parseStreamFrame } from '../transport/events.js';
import { setMaterialTargetFactory, rewriteLocalMarkdownImages, lastMediaRewrite } from '../features/md-media-rewrite.js';
import type { ToolsRegistryLike } from '../transport/tool-presenter.js';
import type { QQBotSender } from '../transport/outbound-buffer.js';
import { buildUserAgent } from '../shared/index.js';
import type { ImQQBotConfig, BotplayEventConfig } from '../config.js';
import type { Logger } from '../types.js';
import { setupMiddlewares } from './middleware-setup.js';
import { configureDiag, diagWrite } from '../shared/diag.js';
import { dataRootOf, migrateLegacyData, stickerDirOf } from './data-root.js';
import { configureStickerStore } from '../features/sticker-store.js';
import { initStickerGate, bindStickerGates, flushStickerGate, getStickerGate, StickerGateDenied } from '../features/sticker-gate.js';
import { startScheduler } from '../features/scheduler.js';
import { startJoinRequestPolling } from '../features/poll-join-requests.js';
import { configureScheduleStore, getScheduleStore } from '../features/schedule-store.js';
import { initContextlessStore, traceContextless, describeStorePath } from '../features/contextless-store.js';
import { rememberInbound, rememberSelf } from '../features/msg-recent.js';
import { initMsgHistory, appendMsgHistory } from '../features/msg-history.js';
import { setChannelBridge } from '../channel-tools.js';
import { QqApprovalController, setApprovalDispatch, makeApprovalListener, registerApprovalController } from '../features/qq-approval.js';
import { QqUserQuestionsController, registerQuestionController } from '../features/qq-user-questions.js';
import { handleGroupJoinRequestEvent } from '../features/group-join-request.js';
import { handleGroupMemberAddEvent, handleGroupAddRobotEvent } from '../features/group-hub.js';
import { registerSessionManager, setBotOnline } from '../features/session-registry.js';
import { BotplayController, registerBotplayController, setBotplayTriggerImpl, setBotplayCatalogImpl } from '../features/botplay.js';
import { createCardCallbackController } from '../features/card-callback.js';
import { createExtToolInteractionController } from '../features/ext-tool-interaction.js';
import { makeExtCaps } from '../features/ext-capabilities.js';
import { readBotplayEvents } from '../features/botplay-store.js';
import { PresetSwitcherController, setPresetCardImpl } from '../features/preset-switcher.js';
import { buildCommandList } from '../commands/index.js';
import { SettingsReader } from '../model/settings-reader.js';

/** 从 interaction 事件推出"回复目标"(回执发到按钮所在群/私聊)。scope 由事件 chat_type/scene 推断 */
function replyTargetOfInteraction(
  event: unknown,
  _ctx: unknown,
  _manager: SessionManager,
): { scope: 'group' | 'c2c'; targetId: string; msgId?: string } {
  const e = event as {
    scene?: string; chat_type?: number; group_openid?: string; group_member_openid?: string; user_openid?: string;
  };
  if (e?.group_openid) return { scope: 'group', targetId: e.group_openid };
  if (e?.user_openid) return { scope: 'c2c', targetId: e.user_openid };
  // 兜底: 群聊 member_openid 只能推群, 但没有 group_openid 无法构造 → 空 target(上层会忽略)
  return { scope: (e?.chat_type === 1 || e?.scene === 'group') ? 'group' : 'c2c', targetId: e?.group_member_openid ?? '' };
}

/**
 * `bootstrapGateway` 的可选钩子（2026-10-12 新增）。
 *
 * 起因：设置页保存凭据后**本应"自动重连"**，但 `src/index.ts` 里那个 `tryStartGateway()`
 * 带"只启动一次"的守卫（`gatewayStarted`）—— 已有实例改 appId/appSecret 时它直接 return，
 * 于是表现成"只有新建实例并保存才会连上"（主人 2026-10-12 实测反馈）。
 *
 * 这里把「拆卸本次网关」的函数交出去，让调用方能在**连接相关字段变化**时先拆后建。
 * 与交给 `im-qqbot.lifecycle` 的是同一个函数，且做了幂等守卫 —— 重复调用只生效一次。
 */
export interface GatewayBootstrapHooks {
  onDisposer?: (dispose: () => Promise<void>) => void;
}

export async function bootstrapGateway(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
  hooks?: GatewayBootstrapHooks,
): Promise<void> {
  const manager = new SessionManager(ctx, agents, config, logger);
  // 2026-10-22: 账号包要用机器人 token 通道（素材上传），这里把凭据放全局供 pack 读取
  try {
    (globalThis as unknown as { __qqbotAppCred?: { appId: string; appSecret: string } }).__qqbotAppCred = {
      appId: String((config as { appId?: string }).appId ?? ''),
      appSecret: String((config as { appSecret?: string }).appSecret ?? ''),
    };
  } catch { /* ignore */ }
  // 2026-10-21: 出站自动传图用 —— 给 md-media-rewrite 一个拿得到 token 的句柄
  try {
    setMaterialTargetFactory(() => {
      // 2026-10-30: 素材上传不依赖群管理开关，groupAdmin 没有就回落 mediaApi
      const c = manager.groupAdmin ?? manager.mediaApi;
      return c ? { apiCall: c.apiCall.bind(c) } : undefined;
    });
  } catch { /* ignore */ }
  // 实例标识(settingsNs), 全 bootstrap 共用: 注册表按 ns 隔离(B类修复 2026-09-11)
  const myNs = (config as { settingsNs?: string }).settingsNs?.trim() || 'im-qqbot';
  // ★ 2026-10-06 诊断日志总开关（默认关）：开了才写 {DSH_HOME|~/.dsh}/*.log。
  //   以前各功能各写各的、零上限（contextless-trace 涨到 25MB），现在统一走 shared/diag.ts。
  //   也可用环境变量 DSH_QQBOT_DIAG=1 临时打开。
  try { configureDiag({ enabled: (config as { diagLog?: boolean }).diagLog === true }); } catch { /* ignore */ }
  // ── dataRoot 启动迁移: 若配置了 dataRoot(如 cwd/dshqqbot), 先把 cwd 下的旧数据目录
  //    搬进去(幂等, 不覆盖); 必须在任何数据目录初始化/写入之前执行。──
  migrateLegacyData(config, logger);
  // QQ 远程审批控制器(enableApprovals 时创建; 定义在 sender 就绪后, 此处先声明供入站回调引用)
  let approvalController: QqApprovalController | undefined;
  let questionController: QqUserQuestionsController | undefined;
  // botplay 互动事件控制器(事件配置 live 现读 config.botplayEvents; 定义在 sender 就绪后)
  let botplayController: BotplayController | undefined;
  /** 自定义卡片(📝 卡片编辑器)按钮回调兜底处理器; 见 features/card-callback.ts */
  let cardCallbackController: ReturnType<typeof createCardCallbackController> | undefined;
  // 扩展工具按钮回调(2026-10-08): data 前缀 `ext:` → 派发给该工具的 onInteraction
  let extToolInteractionController: ReturnType<typeof createExtToolInteractionController> | undefined;

  // ── 表情包图库单例预初始化(防目录分裂) ──
  // ⚠️ 单例时序坑：谁先 getStickerStore 谁定路径。必须在启动早期按数据根
  //    初始化，否则 list_stickers(无参)会以 process.cwd 建错目录(线上踩坑:C盘幽灵库)。
  const stickerDataDir = stickerDirOf(config);
  const stickerStore = configureStickerStore(stickerDataDir, logger, myNs);
  // 启动维护: 清理损坏/空文件 + 物理清除超30天回收站条目
  try {
    const broken = stickerStore.cleanupBroken();
    // 回收站上限（2026-10-05）：启动时顺手清一次，把历史堆积的旧 trash 收口
    try {
      const trashed = stickerStore.cleanupTrash(800);
      if (trashed > 0) logger.info?.(`[sticker] 回收站超限，已物理清理 ${trashed} 张旧图`);
    } catch { /* ignore */ }
    const purged = stickerStore.purgeTrashed();
    if (broken > 0 || purged > 0) logger.info(`[sticker] 启动维护: 清损坏${broken} 清回收站${purged}`);
  } catch { /* ignore */ }
  logger.info(`[sticker] 图库目录: ${stickerDataDir}`);
  // ⚠️ 2026-09-13 **撤下**「启动后台回填 dHash」: 它会在**启动路径上**调 sharp/libvips ——
  //    实测宿主启动时刷 GLib-GObject-CRITICAL("...property 'space' of type 'VipsInterpretation'"),
  //    并把 dsh 拖到启动不了。改为: dHash **只在真正需要判重时(图片消息预检)惰性计算**,
  //    任何失败都只算"判不了", 绝不进入启动路径; 老库回填改由独立脚本按需跑。

  // ── 表情包发送闸门单例预初始化(P1): 与图库同 dataDir, 绑定 live config getter ──
  // 配置现读(getter 每次判定取 config.sticker.gates), Web 设置热更新即时生效。
  initStickerGate(stickerDataDir, logger, myNs);
  bindStickerGates(() => config.sticker.gates);
  const stickerGate = getStickerGate(stickerDataDir, logger, myNs);

  // ── 会话自设定时任务单例预初始化(schedule_timer 工具用) ──
  // 落盘 {cwd}/.qqbot/timers.json; 与图库同策略: 启动早期按 config.cwd 定路径防分裂。
  const scheduleDataDir = join(dataRootOf(config), '.qqbot');
  configureScheduleStore(scheduleDataDir, logger, myNs);

  // ── 无上下文模式(2026-09-27): 会话级开关存 {dataRoot}/.qqbot/contextless.json ──
  //   开启后该会话每轮丢掉历史(只带 @ 前 N 条 + 系统规则), 大幅省 token。
  try {
    const _dr = dataRootOf(config);
    initContextlessStore(_dr);
    traceContextless('bootstrap 初始化: dataRoot=' + _dr + ' → store文件=' + describeStorePath());
  } catch (e) { traceContextless('bootstrap 初始化失败: ' + (e instanceof Error ? e.message : String(e))); }

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  // 启动期合并 settings.yaml 的 groupAdmin(Web 可视化设置那份):
  // QQBot 构造时 intents 一次性读取 config.groupAdmin; 而 settings 服务注入是异步的,
  // 晚于 gateway 构造 → 仅靠 settings 同步拿不到值, 曾导致 watchJoinRequests 改完不生效
  // (2026-09-09 复盘: 只能改 cordis.patch.yml 绕坑)。这里启动时直接读文件, 让
  // Web 设置(存 settings.yaml)重启即生效, 无需手改 yml —— 通用且时序安全。
  try {
    const reader = new SettingsReader();
    const ga = reader.readGroupAdmin((config as { settingsNs?: string }).settingsNs?.trim() || 'im-qqbot');
    if (ga) {
      config.groupAdmin = { ...(config.groupAdmin ?? {}), ...ga } as typeof config.groupAdmin;
      logger.info(`[im-qqbot] 启动合并 settings.yaml groupAdmin: ${JSON.stringify(config.groupAdmin)}`);
    }
  } catch (err) {
    logger.warn?.(`[im-qqbot] settings.yaml groupAdmin 合并跳过: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 入群申请事件(GROUP_JOIN_REQUEST)订阅: intent GROUP_MEMBER_EVENT = 1<<24, SDK 默认 FULL_INTENTS 不含它。
  // ⚠️ 只在"群管理开启 + watchJoinRequests"时扩展 intents(Identify 携带未授权 intent 可能被拒连 4914/4915);
  //    该值在 gateway 连接建立时确定 → 修改 config 后需重启才生效(非 live)。
  const watchJoinRequests = !!config.groupAdmin?.enabled && !!config.groupAdmin?.watchJoinRequests;
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    userAgent,
    ...(watchJoinRequests ? { intents: FULL_INTENTS | (1 << 24) } : {}),
    // 调试隔离时可用 QQBOT_DEBUG_CONSOLE=1 让 QQBot 日志直出 stdout，便于定位
    logger: process.env.QQBOT_DEBUG_CONSOLE ? (console as typeof logger) : logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})${watchJoinRequests ? ' [watchJoinRequests: GROUP_MEMBER_EVENT 已订阅]' : ''}`);

  // ── 中间件链 ──
  await setupMiddlewares(bot, config, manager, logger, ctx);
  // 2026-10-20: 消息历史台账（落盘、按会话一个文件）
  initMsgHistory(dataRootOf(config));

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    // 2026-10-20 主人需求: 先判消息类型 + 记进「最近 2 分钟」内存缓冲（不落盘）
    let inKind: 'text' | 'image' | 'voice' | 'video' | 'file' = 'text';
    let inText = '';
    try {
      const anyMsg = msg as { content?: string; attachments?: Array<{ content_type?: string; type?: string }> };
      const atts = anyMsg.attachments ?? [];
      const ct = (a: { content_type?: string; type?: string }): string => String(a.content_type ?? a.type ?? '');
      inKind = atts.length === 0
        ? 'text'
        : atts.some((a) => /image/i.test(ct(a))) ? 'image'
          : atts.some((a) => /audio|voice|silk/i.test(ct(a))) ? 'voice'
            : atts.some((a) => /video/i.test(ct(a))) ? 'video'
              : 'file';
      inText = inKind === 'text' ? String(anyMsg.content ?? '') : `[${inKind}]`;
      const rScope: 'group' | 'c2c' = String((msg as { groupOpenid?: string }).groupOpenid ?? '') !== '' ? 'group' : 'c2c';
      const rPeer = rScope === 'group' ? (msg.groupOpenid ?? msg.senderId ?? '') : (msg.senderId ?? '');
      rememberInbound(rScope, String(rPeer ?? ''), {
        msgId: String(msg.messageId ?? ''),
        senderId: String(msg.senderId ?? ''),
        senderName: String((msg as { senderName?: string }).senderName ?? msg.senderId ?? ''),
        at: Date.now(),
        text: inText,
        kind: inKind,
      });
    } catch { /* 缓冲失败不影响主流程 */ }

    // 自动撤回（2026-10-20 主人定）: 命中关键词/附件类型 → **立刻撤回**（不等 AI）。
    // ★ 位置说明: 这里已经是**中间件链 + 入站扩展全部跑完之后**，所以 mode='drop' 只决定
    //   "这条消息要不要进 agent"，不改变扩展收到的 ctx、也不改扩展执行顺序 —— 不破坏扩展契约。
    let autoDropped = false;
    try {
      const ar = (config as {
        autoRecall?: {
          enabled?: boolean; mode?: 'keep' | 'drop'; keywords?: string[];
          kinds?: string[]; muteSeconds?: number; dryRun?: boolean;
        };
      }).autoRecall;
      const msgId = String(msg.messageId ?? '');
      if (ar?.enabled === true && String((msg as { groupOpenid?: string }).groupOpenid ?? '') !== '' && msgId !== '') {
        const kws = (ar.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
        const kinds = (ar.kinds ?? []).map(String);
        const textLower = String((msg as { content?: string }).content ?? '').toLowerCase();
        const hitKw = kws.find((k) => textLower.includes(k.toLowerCase()));
        const hitKind = kinds.includes(inKind);
        if (hitKw !== undefined || hitKind) {
          const gid = String(msg.groupOpenid ?? '');
          const ga = manager.groupAdmin;
          const dry = ar.dryRun === true;
          logger.info(`auto-recall hit: gid=…${gid.slice(-4)} kind=${inKind} kw=${hitKw ?? '-'} dry=${dry} mode=${ar.mode ?? 'keep'}`);
          if (!dry && ga && gid) {
            void ga.recallMessage(gid, msgId, 'group').catch(() => undefined);
            const secs = Math.max(0, Math.round(Number(ar.muteSeconds) || 0));
            const sid = String(msg.senderId ?? '');
            if (secs > 0 && /^[0-9A-Za-z]{32}$/u.test(sid)) {
              const pad = (n: number): string => String(n).padStart(2, '0');
              const ex = new Date(Date.now() + secs * 1000);
              const rfc = `${ex.getFullYear()}-${pad(ex.getMonth() + 1)}-${pad(ex.getDate())}T${pad(ex.getHours())}:${pad(ex.getMinutes())}:${pad(ex.getSeconds())}+08:00`;
              void ga.setMemberMute(gid, sid, rfc).catch(() => undefined);
            }
          }
          if ((ar.mode ?? 'keep') === 'drop') autoDropped = true;
        }
      }
    } catch (err) {
      logger.warn(`auto-recall error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (autoDropped) {
      logger.debug('auto-recall drop: 该消息不进 agent（扩展已执行完）');
      return;
    }
    // QQ 远程审批: /approve|/deny CODE 最先拦截(消费后不再进 agent/普通聊天)
    if (approvalController) {
      const scope: 'c2c' | 'group' = msg.kind === 'group' ? 'group' : 'c2c';
      const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
      try {
        const consumed = await approvalController.handleInbound(msg as never, {
          scope, targetId: peerId, msgId: msg.messageId,
        });
        if (consumed) return;
      } catch (err) {
        logger.warn(`approval inbound error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // QQ 远程提问的**文字兜底**(2026-09-11 主人定): 有待答提问时, 发起者发来的文字也算回答 ——
    // 字母/序号/选项原文 → 选中选项(支持多选); 其它文字 → 作为自由回答(custom)透传给 AI。
    // 没有待答提问时该方法立即返回 false, 零副作用(消息照常进 agent)。
    if (questionController) {
      const qScope: 'c2c' | 'group' = msg.kind === 'group' ? 'group' : 'c2c';
      const qPeerId = qScope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
      try {
        const consumed = await questionController.handleInbound(msg as never, {
          scope: qScope, targetId: qPeerId, msgId: msg.messageId,
        });
        if (consumed) return;
      } catch (err) {
        logger.warn(`question inbound error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(msg, manager, config, logger, mCtx.state);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  // 获取 tools 服务（工具结果结构化展示，参考 dsh-TUI presentResult），可选
  let toolsRegistry: ToolsRegistryLike | undefined;
  try {
    toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined;
  } catch {
    toolsRegistry = undefined;
  }

  // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）
  // 记录 bot 发给每个 peer 的最近消息历史，供 agent [RECALL(:N)] 按序号撤回自身消息。
  const HISTORY_LIMIT = 10;
  const sentByPeer = new Map<string, { target: ReplyTarget; id: string }[]>();
  const keyOf = (t: { scope: string; targetId: string }) => `${t.scope}:${t.targetId}`;
  const pushSent = (
    target: ReplyTarget,
    id: string | undefined,
    text?: string,
    kind?: 'text' | 'image' | 'voice' | 'video' | 'file',
  ): void => {
    if (!id) return;
    const k = keyOf(target);
    let arr = sentByPeer.get(k);
    if (!arr) { arr = []; sentByPeer.set(k, arr); }
    arr.unshift({ target, id }); // 最新在前
    if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT;
    // 2026-10-20 主人需求: 机器人自己发的消息也进 msg-recent 缓冲,
    // 这样「自动撤回/按关键词搜索消息」也能覆盖自己发的。
    try {
      const sc: 'group' | 'c2c' = String(target.scope ?? 'group') === 'c2c' ? 'c2c' : 'group';
      rememberSelf(sc, String(target.targetId ?? ''), { msgId: id, text, kind: kind ?? 'text' });
      appendMsgHistory(sc, String(target.targetId ?? ''), { id, s: 'self', n: '机器人', t: Date.now(), k: kind ?? 'text', x: text ?? '', me: true });
    } catch { /* 记不了不影响发送 */ }
  };
  const doRecall = async (target: ReplyTarget, index: number): Promise<boolean> => {
    const arr = sentByPeer.get(keyOf(target));
    if (!arr) return false;
    const item = arr[index - 1];
    if (!item) return false;
    try {
      await bot.recallMessage(item.target, item.id);
      arr.splice(index - 1, 1);
      if (!arr.length) sentByPeer.delete(keyOf(target));
      return true;
    } catch (err) {
      logger.error(`recall(${index}) failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  // 出站富媒体降级判定: 内容无 markdown 语法(且无 @提及/qqbot 标签)→ 走纯文本通道(msg_type:0),
  // 避开 QQ 对 markdown 富媒体的严格频控(实测连发 5 条 markdown 后静默被拦)。
  const hasMarkdownSyntax = (text: string): boolean => {
    const t = String(text || '');
    return (
      /<@[A-Za-z0-9]+>|<qqbot-at-user|<qqbot-at-everyone|<emoji:|<#/.test(t) ||
      t.includes('```') || t.includes('`') ||
      /(^|\n)\s*(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)/.test(t) ||
      /\*\*[^*]+\*\*/.test(t) ||
      /\[([^\]\n]+)\]\(https?:[^)\n]+\)/.test(t) ||
      /~~[^~\n]+~~/.test(t)
    );
  };

  const sender: QQBotSender = {
    sendMarkdown: async (target, content) => {
      try {
        let rawText = String(content || '');
        // 2026-10-21: markdown 通道也要自动传本地图 ——
        //   扩展工具 send_md / 卡片 / sendText 都直接走这个 sender.sendMarkdown，
        //   绕过了 OutboundRouter.send() 里的那次重写，所以这里必须再来一次。
        if (rawText.indexOf('![') >= 0) {
          try {
            const ga = manager.groupAdmin ?? manager.mediaApi;
            if (ga) rawText = await rewriteLocalMarkdownImages(rawText, { apiCall: ga.apiCall.bind(ga) } as never);
            // 2026-10-21（主人定）：markdown 卡片通道里，本地图没传成功就**不发送**这条（正文不受影响，正文走 send()）
            {
              const rw = lastMediaRewrite();
              if (rw && Number(rw.failed || 0) > 0) {
                throw new Error('图上传失败 ' + rw.failed + '/' + rw.matched + '，本条未发送');
              }
            }
          } catch { /* 失败保留原样 */ }
        }
        // 引用消息(2026-09-13 主人定): AI 写 [rf:短号] → 台账查表还原 msg_id, 出站带 message_reference 以"引用"形式发出
        const refId = target.referenceMessageId;
        if (refId) {
          // 保留 target(含 msgId 被动回复)+ 加引用 —— SDK send(): body.msg_id 与 body.message_reference 并存,
          // 2026-09-13 修: 之前用 tgtNoMsg 去 msgId 变纯主动, 主动消息易被 QQ 静默拦, 主人测试看不到引用
          const hasMd = hasMarkdownSyntax(rawText);
          const refBody = hasMd
            ? { target, msgType: 2 as const, markdown: { content: rawText }, messageReference: { message_id: refId } }
            : { target, msgType: 0 as const, content: rawText, messageReference: { message_id: refId } };
          try {
            const resp = (await bot.send(refBody as never)) as { id?: string } | undefined;
            pushSent(target, resp?.id, rawText);
            return resp;
          } catch (refErr) {
            logger.warn(`引用消息发送失败, 降级为普通发送: ${refErr instanceof Error ? refErr.message : String(refErr)}`);
            // fallthrough: 去掉引用, 走原有发送路径
          }
        }
        // 纯文本降级: 无 markdown 语法/@标签 → 直接纯文本通道, 省富媒体额度与频控
        if (!hasMarkdownSyntax(rawText)) {
          const respT = (await bot.sendText(target, rawText)) as { id?: string } | undefined;
          pushSent(target, respT?.id, rawText);
          return respT;
        }
        const resp = (await bot.sendMarkdown(target, content)) as { id?: string } | undefined;
        pushSent(target, resp?.id, rawText);
        return resp;
      } catch (err) {
        const firstErr = err instanceof Error ? err.message : String(err);
        // 出站失败落盘（2026-10-08 加）：以后"某个会话发不出消息"能直接查这条日志，不用靠猜。
        diagWrite(
          'qqbot-send-diag',
          `[${new Date().toISOString()}] sendMarkdown 失败: scope=${target.scope} target=${String(target.targetId ?? '').slice(0, 12)}… msgId=${target.msgId ? `…${String(target.msgId).slice(-8)}` : '(无)'} err=${firstErr}`,
        );

        // ── ① 被动回复(msgId) 被拒 → **去掉 msgId 转主动重试一次** ──────────────────
        //   ⚠️ 2026-10-08 修（主人实测：崩溃重启后"那个会话再也发不出消息，得新开会话才行"）：
        //     passive 模式下**所有**出站都带 msgId（见 outbound.ts 的 effectiveTarget），
        //     msgId 一旦失效（过期 / 被动回复配额用尽 / 崩溃重启残留的陈旧 id），
        //     原来这里**直接 throw** ⇒ outbound 只记一行日志 ⇒ 消息静默丢失 ⇒ 整个会话像哑了。
        //     转主动只多花一点主动额度，远好过彻底发不出去；成败都落盘，便于事后溯源。
        if (target.msgId) {
          try {
            const act = { scope: target.scope, targetId: target.targetId } as typeof target;
            const r0 = (await bot.sendMarkdown(act, content)) as { id?: string } | undefined;
            pushSent(act, r0?.id);
            logger.warn(`被动回复被拒(msgId 失效) → 已去掉 msgId 转主动发送成功: ${firstErr}`);
            diagWrite('qqbot-send-diag', `[${new Date().toISOString()}] 已降级为主动发送成功 target=${String(target.targetId ?? '').slice(0, 12)}…`);
            return r0;
          } catch (errA) {
            const secondErr = errA instanceof Error ? errA.message : String(errA);
            logger.error(`被动回复被拒且转主动也失败: 被动轮=${firstErr} / 主动轮=${secondErr}`);
            diagWrite('qqbot-send-diag', `[${new Date().toISOString()}] 转主动仍失败 target=${String(target.targetId ?? '').slice(0, 12)}… err=${secondErr}`);
            throw errA;
          }
        }

        // ── ② 纯主动(无 msgId) → 原有降级链: markdown → 纯文本 → c2c is_wakeup ──
        {
          // ⚠️ 清洗仅针对 markdown 语法字符; QQ at 标签必须原样保留——
          // 实测(2026-09-06): 高亮 @ 用 `<@openid>`(无斜杠)或 `<qqbot-at-user id="openid" />`;
          // 剥掉 '>' 会把标签弄残 → QQ 不渲染。这里先把两类 at 标签暂存, 清洗完再恢复。
          const plain = String(content || '')
            .replace(/<qqbot-at-user\s+id="([A-Za-z0-9]+)"\s*\/>/g, '\u0001ATQ:$1\u0001')
            .replace(/<@([A-Za-z0-9]+)>/g, '\u0001ATA:$1\u0001')
            .replace(/[#*`_~>]/g, '')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\u0001ATQ:([A-Za-z0-9]+)\u0001/g, '<qqbot-at-user id="$1" />')
            .replace(/\u0001ATA:([A-Za-z0-9]+)\u0001/g, '<@$1>')
            .trim();
          if (plain) {
            try {
              const r2 = (await bot.sendText(target, plain)) as { id?: string } | undefined;
              pushSent(target, r2?.id);
              logger.warn(`主动推送 markdown 被拒, 已降级纯文本发送: ${firstErr}`);
              return r2;
            } catch (err2) {
              if (target.scope === 'c2c') {
                try {
                  const r3 = (await bot.sendWakeup(target, plain)) as { id?: string } | undefined;
                  pushSent(target, r3?.id);
                  logger.warn(`主动纯文本被拒, 已降级 is_wakeup 召回通道: ${err2 instanceof Error ? err2.message : String(err2)}`);
                  return r3;
                } catch (err3) {
                  logger.error(`主动推送三通道全拒: md=${firstErr} / text=${err2 instanceof Error ? err2.message : String(err2)} / wakeup=${err3 instanceof Error ? err3.message : String(err3)}`);
                  throw err3;
                }
              }
              logger.error(`主动推送两通道被拒: md=${firstErr} / text=${err2 instanceof Error ? err2.message : String(err2)}`);
              throw err2;
            }
          }
        }
        throw err;
      }
    },
    // 官方 20261021：图文卡片 msg_type=8（群聊/单聊都支持）
    // ⚠️ 2026-10-29 实测踩坑：SDK 的 bot.send() 只白名单了
    //   msg_id/msg_type/content/markdown/ark/embed/media/keyboard/messageReference/**extra**
    //   —— **没有 card**！直接传 { card } 会被静默丢弃，body 只剩 msg_type=8 ⇒ 卡片渲染成纯文本。
    //   正解：走 extra 透传（SDK 里 ）。
    sendTuwenCard: async (target, card) => {
      const resp = (await bot.send({ target, msgType: 8, extra: { card } } as never)) as { id?: string } | undefined;
      pushSent(target, resp?.id);
      return resp;
    },
    sendMarkdownWithKeyboard: async (target, content, keyboard) => {
      // 卡片按钮(审批/提问): bot.send 显式 msg_type=2 + keyboard。
      // 失败直接抛(不静默降级)——由调用方决定文本兜底, 避免"卡片+文本码"双发。
      const resp = (await bot.send(
        { target, msgType: 2, markdown: { content }, keyboard: keyboard as never },
      )) as { id?: string } | undefined;
      pushSent(target, resp?.id);
      return resp;
    },
    openStream: (target) => bot.openStream({
      target: {
        scope: target.scope,
        targetId: target.targetId,
        msgId: target.msgId as string,
      },
    }),
    sendMedia: async (target, kind, source) => {
      // ── P1 表情包闸门(唯一咽喉, [MEDIA]标记 与 send_media 工具都汇于此) ──
      // 只对"库内图片的主动发送"生效; URL/非库路径/语音视频文件放行。
      let gateHit = false;
      if (kind === 'image' && source.localPath) {
        const groupId = target.scope === 'group' ? target.targetId : undefined;
        const verdict = stickerGate.checkMedia({ groupId, kind, localPath: source.localPath });
        if (!verdict.allowed) {
          throw new StickerGateDenied(verdict.reason ?? '被闸门拦截');
        }
        gateHit = verdict.isSticker && !!groupId;
      }
      const srcOpt = source.url
        ? { url: source.url }
        : source.localPath
          ? { localPath: source.localPath }
          : {};
      let out: { message?: { id?: string } } | undefined;
      if (kind === 'image') out = await bot.sendImage(target, srcOpt);
      else if (kind === 'video') out = await bot.sendVideo(target, srcOpt);
      else if (kind === 'voice') out = await bot.sendVoice(target, srcOpt);
      else out = await bot.sendFile(target, srcOpt);
      const id = out?.message?.id;
      pushSent(target, id);
      // 发送成功后才记录(失败不占预算/去重); 库内图且群内才算表情包发送
      if (gateHit && id !== undefined && source.localPath) {
        try {
          stickerGate.noteSent(target.scope === 'group' ? target.targetId : undefined, source.localPath);
        } catch { /* 记录失败不影响发送 */ }
      }
      return { id };
    },
    recallLast: (target) => doRecall(target, 1),
    recallByIndex: (target, index) => doRecall(target, index),
    // c2c 主动召回(官方 is_wakeup:true; 群聊调用会抛, 由调用方保证只用于 c2c)
    sendC2cWakeup: (target, content) => bot.sendWakeup(target, content),
  };

  // 把发送能力注入 SessionManager，供 QQ 会话 provide qqChannel 服务给通道工具
  manager.installChannelSender(sender);
  // 全局桥: 通道工具 execute 的兜底解析(不依赖 setup/provide, 防重启后 setup 未跑)
  setChannelBridge({ manager, sender });

  // ── 群事件(M2 群组管理器 + P2.5): rawEvent 分发 ──
  //  · GROUP_JOIN_REQUEST / GROUP_MEMBER_ADD: intent GROUP_MEMBER_EVENT(1<<24), 需 watchJoinRequests 已扩 intents;
  //  · GROUP_ADD_ROBOT: intent GROUP_AND_C2C_EVENT(1<<25, SDK FULL_INTENTS 基础订阅即收)。
  // 同一 bot 仅一个群管理实例; 事件带 group_openid, 天然按群路由。
  bot.on('rawEvent', (rawCtx: { eventType?: string; data?: unknown }) => {
    const et = rawCtx.eventType;
    if (et === 'GROUP_JOIN_REQUEST') {
      logger.info(`[group-join] rawEvent GROUP_JOIN_REQUEST 到达`);
      void handleGroupJoinRequestEvent(rawCtx.data, { sender, config, logger, manager }).catch((err: unknown) => {
        logger.error(`[group-join] 事件处理异常: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    if (et === 'GROUP_MEMBER_ADD') {
      logger.info(`[group-hub] rawEvent GROUP_MEMBER_ADD 到达`);
      void handleGroupMemberAddEvent(rawCtx.data, { config, logger, manager }).catch((err: unknown) => {
        logger.error(`[group-hub] member_add 处理异常: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    if (et === 'GROUP_ADD_ROBOT') {
      logger.info(`[group-hub] rawEvent GROUP_ADD_ROBOT 到达`);
      void handleGroupAddRobotEvent(rawCtx.data, { config, logger, manager }).catch((err: unknown) => {
        logger.error(`[group-hub] add_robot 处理异常: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });

  // ── QQ 远程审批: ACP 模式接入(专家考古实证, 见 qq-approval.ts 头注) ──
  // ①dispatch: ownership(只处理本 bot 的 agent)+ enableApprovals 闸门;
  // ②监听: 注册在插件 apply ctx, 用 {prepend:true} 插到链首(抢在宿主 GUI 转发器 dsh-api-remotes 之前)。
  approvalController = new QqApprovalController(manager, sender, logger, () => config.approvalTimeoutMs);
  // 注册进 ns 注册表(Web 审批浮层经 settings-host 同源路由读写); ns 取 settingsNs 与 index.ts 一致(myNs 见顶部)
  registerApprovalController(myNs, approvalController);
  registerSessionManager(myNs, manager);
  // ⚠️ 2026-09-11 多实例修复: dispatch 不再走模块级单例(会被多实例覆盖) —— 直接把本实例的
  //    处理逻辑作为 handler 传入 makeApprovalListener(闭包捕获本实例 manager/controller)。
  const myApprovalHandler = ((request: unknown, next: () => Promise<string>) => {
    const diagA = (line: string) => { try { (globalThis as Record<string, unknown>).qqApprovalDiag = ((globalThis as Record<string, unknown>).qqApprovalDiag || []); ((globalThis as Record<string, unknown>).qqApprovalDiag as string[]).push('[' + new Date().toISOString() + '] ' + line); } catch { /* 忽略 */ } };
    diagA('dispatch enter enable=' + config.enableApprovals);
    if (!config.enableApprovals) { diagA('dispatch next: disabled'); return next(); }
    const reqAgent = (request as { agent?: unknown }).agent;
    const rec = reqAgent ? manager.findByAgent(reqAgent as never) : undefined;
    diagA('dispatch find=' + (rec ? 'hit(' + rec.scope + ')' : 'miss'));
    if (!reqAgent || !rec) return next(); // 非本 bot agent → 放行给 GUI/ACP
    diagA('dispatch -> request()');
    return approvalController!.request(request as never, next as never);
  }) as never;
  setApprovalDispatch(myNs, myApprovalHandler as never);
  // 挂到宿主根 ctx(与 Web GUI 审批转发器同层)并 prepend 插链首 —— 保证本 bot 的审批先被 QQ 通道接管
  const approvalCtx = (((ctx as unknown as { root?: { ctx?: unknown } | unknown }).root) || ctx) as unknown as {
    on(event: string, handler: (...args: unknown[]) => unknown, config?: { prepend?: boolean }): void;
  };
  approvalCtx.on('approval/request', makeApprovalListener(myApprovalHandler as never) as never, { prepend: true });

  // ── expose:'all' 的扩展工具：**启动即注册**（2026-10-10 主人定）────────────
  //  ⚠️ 之前它只挂在 agent/pre-step 上（那是"每个 QQ 会话每步"才触发）⇒
  //     QQ 不活跃时永远注册不上（主人原话："不能 qq 不活跃也注册吗" —— 对）。
  //  现在：插件启动就注册一次，并每 5 秒重试（最多 12 次，约 1 分钟）兜住"实例/扩展目录稍后才就绪"。
  //  用动态 import 避免与 channel-tools 的循环依赖；函数内部自己 `ctx.root ?? ctx`，幂等 + 节流。
  //  工具名 = `<name>__<人设id>`（分隔符只能是 [a-zA-Z0-9_-]，`@` 会被 LLM API 拒 —— 见 channel-tools 注释）。
  void (async () => {
    for (let i = 0; i < 12; i++) {
      try {
        const ct = await import('../channel-tools.js');
        ct.ensureExtToolsGlobal(ctx);
      } catch { /* 单次失败继续重试 */ }
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();
  logger.info('[im-qqbot] expose:all 扩展工具：启动即注册（含重试）已启动');

  // ── 首次运行"见面礼"：把本包自带的扩展示例铺到用户的扩展目录（2026-10-10 主人定）──
  //   用户的工作目录里生成 `dshqqbot/` 之后，不用自己手动搬示例 ——
  //   插件启动就把 examples/ext-tools/*.mjs 补进 `{dataRoot}/.qqbot-extensions/tools/`。
  //   ⚠️ 只补不覆盖（用户改过的同名文件一律不动），失败静默，绝不影响启动。
  void (async () => {
    try {
      const es = await import('../features/extension-store.js');
      const n = es.seedExampleTools(dataRootOf(config), logger);
      if (n > 0) {
        logger.info(`[im-qqbot] 已自动铺设 ${n} 个扩展示例`);
        // ★ 2026-10-27 修（主人实测：3 号机 /扩展示例 不生效、/唤醒 正常）：
        //   扩展命令是**插件启动时**扫描的，而示例是**启动之后**才铺进来的
        //   ⇒ 新文件不被注册，表现为"文件明明在，命令却当普通文本进了上下文"。
        //   所以铺完当场重载一次命令。reloadExtCommands 没装好时返回 {error}，
        //   不抛错、不影响启动（最多需要下次重启才认）。
        try {
          const rl = await import('../features/ext-reload.js');
          const r = await rl.reloadExtCommands();
          if (r && typeof r === 'object' && 'error' in r) {
            logger.debug?.('[im-qqbot] 铺完重载命令未生效: ' + String((r as { error: string }).error));
          } else {
            logger.info('[im-qqbot] 铺完已重载扩展命令: ' + JSON.stringify(r));
          }
        } catch { /* 重载失败不致命 */ }
      }
    } catch { /* 静默 */ }
  })();

  // ── 启动钩子（ext-hooks，第四套扩展；2026-10-12）────────────────────────────
  //   `{dataRoot}/.qqbot-extensions/hooks/*.mjs` 里的模块在**插件启动时自动跑一次**
  //   （不需要任何调用方触发）—— 用途：恢复上次没跑完的长期任务、注册监听、起定时器、预取数据。
  //
  //   ⚠️ 三条硬纪律（实现都在 features/ext-hooks.ts，这里只负责接线）：
  //     ① 单钩子独立 try/catch ⇒ 抛错绝不影响插件启动、也不影响其它钩子；
  //     ② 单钩子 30s 超时 ⇒ 异步钩子不会把启动拖死（超时只告警并放行）；
  //     ③ 目录缺失/为空完全安静 ⇒ 不报错、不打日志。
  //   放在 seedExampleTools 之后 ⇒ **首次安装当次启动**就能跑到刚铺进去的示例钩子（不用重启宿主）。
  //   与 seed 同为 fire-and-forget：不阻塞启动、永不抛出。
  void (async () => {
    try {
      const hooks = await import('../features/ext-hooks.js');
      // ── 2026-10-13：把“钩子能让 AI 开口”的能力接上 ────────────────────
      //   钩子没有“当前消息”，所以它只能点名目标会话：wakeTo(scope, peerId, text)。
      //   实现 = 同 appendWake 那条路（agent.followup + createUserMessage）——
      //   走**正常回合**（dsh 会先补人设），不是旁路注入，也不经过模板。
      //   peerId → agent 由本实例的 manager 解析：天然只作用于**本机器人**，
      //   多机器人各自 bootstrap 一次 ⇒ 各自的钩子只会唤自己名下的会话。
      // 2026-10-25：改用 manager.injectToPeer() —— 这就是"往某会话塞一条新消息、
      //   AI 带上下文处理并回复到 QQ"的正规入口（session-manager 里已有），
      //   不必自己 findByPeer + createUserMessage 拼一遍（那条路在 record.agent 形态变化时会静默失效）。
      const wakeTo = async (scope: string, peerId: string, text: string): Promise<boolean> => {
        try {
          return await manager.injectToPeer(scope as never, peerId, text, 'user');
        } catch (err) {
          logger.warn?.(`[im-qqbot] wakeTo 失败(已忽略): ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      };
      const r = await hooks.runStartupHooks({
        dataRoot: dataRootOf(config),
        logger,
        ctx,
        config,
        // 与 bot 实例同一份凭证/白名单：钩子不必再让用户手填一份
        appId: config.appId,
        appSecret: config.appSecret,
        owners: ((config.groupAdmin as { owners?: unknown })?.owners as unknown[] | undefined)?.map(String) ?? [],
        wakeTo,
      });
      if (r.total > 0) {
        logger.info(`[im-qqbot] 启动钩子: ${r.total} 个（成功 ${r.ok} / 失败 ${r.failed} / 超时 ${r.timedOut}）`);
      }
    } catch (err) {
      // 引擎内部已经永不抛出；真走到这里说明连 import 都失败了 —— 仍只告警
      logger.warn?.(`[im-qqbot] 启动钩子装载异常(已忽略, 不影响插件启动): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  logger.info(`[im-qqbot] QQ 远程审批接线就绪(${config.enableApprovals ? '已启用' : '默认关闭, Web 设置可热开'})`);

  // ── QQ 远程提问(按钮卡片版): ask_user_question → QQ 卡片按钮 ──
  // 宿主 user-questions/request 是 Agent 作用域 waterfall(同 approval), Web UI 答案器
  // 在宿主引导期注册 → 本监听同样 {prepend:true} 抢链首。enableQuestions 默认开(与审批独立开关)。
  const enableUserQuestions = config.enableUserQuestions !== false;
  questionController = new QqUserQuestionsController(
    manager, sender, logger,
    () => config.approvalTimeoutMs || 120000,
    // 提问工作方式(现读/live 热更): 'async'=后台(默认, 卡片发出即返回, 不卡回合) / 'blocking'=旧行为
    () => (config.questionsMode === 'blocking' ? 'blocking' : 'async'),
    // openid → 昵称：延迟求值（botplayController 在本段之后才创建）
    (target, openid) => {
      try { return botplayController?.memberName(target, openid) || ''; } catch { return ''; }
    },

  );
  registerQuestionController(myNs, questionController);
  (ctx as unknown as {
    on(event: string, handler: (...args: unknown[]) => unknown, config?: { prepend?: boolean }): void;
  }).on('user-questions/request', (async (request: unknown, next: () => Promise<unknown>) => {
    if (!enableUserQuestions) return next();
    const reqAgent = (request as { agent?: unknown }).agent;
    if (!reqAgent || !manager.findByAgent(reqAgent as never)) return next(); // 非本 bot agent → GUI 兜底
    try {
      return await questionController!.request(request as never, next as never);
    } catch (err) {
      logger.warn(`[qq-questions] request 异常: ${err instanceof Error ? err.message : String(err)}`);
      return next();
    }
  }) as never, { prepend: true });
  logger.info(`[im-qqbot] QQ 远程提问接线就绪(${enableUserQuestions ? '启用' : '关闭'})`);

  // ── botplay 互动事件装配器(2026-09-08, Phase1 MVP) ──
  // 事件配置真相源 = {dataRoot}/botplay-events.json (2026-09-10 M4.3 起, 控制器现读支持热更)。
  // ⚠️ 修复: 启动时把文件内容回填 config.botplayEvents —— 命令层/其他消费者仍读该字段,
  //    而 settings 层自迁移后已被清空(空数组), 若不回填会导致 /botplay 查不到任何事件。
  try {
    const seeded = readBotplayEvents(dataRootOf(config), () => (Array.isArray(config.botplayEvents) ? config.botplayEvents : []));
    if (Array.isArray(seeded) && seeded.length > 0) {
      (config as { botplayEvents?: BotplayEventConfig[] }).botplayEvents = seeded;
      logger.info(`[im-qqbot] botplay 事件已从文件装载: ${seeded.length} 个`);
    }
  } catch (err) {
    logger.warn?.(`[im-qqbot] botplay 事件文件装载失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  // /botplay 命令 → triggerBotplay 模块级注册表 → 这里实现(带 sender/manager)发卡。
  botplayController = new BotplayController(
    manager,
    sender,
    logger,
    // 事件配置从 {dataRoot}/.qqbot/botplay-events.json 现读(2026-09-10 M4.3 独立存储,
    // 自动迁移 settings 旧数据; 文件缺失回退 settings 现值)
    () => readBotplayEvents(dataRootOf(config), () => (Array.isArray(config.botplayEvents) ? config.botplayEvents : [])),
    () => (Array.isArray(config.groupAdmin?.owners) ? config.groupAdmin.owners : []),
    () => stickerDataDir,
    // 数据根(2026-10-05): botplay 自定义事件模块放 {dataRoot}/.qqbot-extensions/botplay/
    // ⚠️ 必须与事件文件同源(dataRootOf), 否则面板报的路径与实际加载的不是一处, 主人改错文件还找不到原因
    () => dataRootOf(config),
  );
  registerBotplayController(myNs, botplayController);
  // ★ 内核句柄：把插件 ctx 交给 botplay（卡片 ctx.kernel / 与扩展工具·命令对齐）
  botplayController.setKernel(ctx);
  // 昵称兜底(2026-10-05 主人定: "兜底的时候用 api，其余的时候用台账"):
  //   台账/会话壳都查不到时, 后台调官方「获取群成员信息」接口拿 username。
  //   ⚠️ 该接口官方标注「内邀接入中」(11253=无权限) ⇒ 失败静默、只记一行日志。
  //   借 manager.groupAdmin(懒建; groupAdmin.enabled=false 时为 undefined ⇒ 自动跳过)。
  botplayController.setGroupAdminGetter(() => manager.groupAdmin);
  // 卡片(= .mjs 代码)需要"钥匙"而不是"被包好的能力": 直接把 appId/appSecret 给它,
  // 它就能自己换 access_token 调任意官方 API(查成员/发消息/上传媒体/禁言…)。
  botplayController.setCredentialsGetter(() => ({
    appId: String(config.appId ?? ''),
    appSecret: String(config.appSecret ?? ''),
  }));
  setBotplayTriggerImpl(myNs, (target, eventId, triggererId) => botplayController!.trigger(target, eventId, triggererId));
  setBotplayCatalogImpl(myNs, (target, page) => botplayController!.sendCatalog(target, page));
  // 预设切换卡片(2026-09-10): /preset 无参发按钮卡, 点击热切人格(仿 botplay 翻页)
  const presetSwitcher = new PresetSwitcherController(manager, sender, logger);
  setPresetCardImpl(myNs, (target, scope, peerId, page) => presetSwitcher.sendCard(target, scope, peerId, page ?? 0));
  // 指令型按钮(Phase2): 点击后执行斜杠命令(不经 AI)。复用 buildCommandList 的 handler,
  // 模拟一个最小命令 ctx(command 名称/空参 + 消息壳), 返回 handler 结果文本。
  // 指令型按钮(Phase2): 点击后执行斜杠命令(不经 AI)。复用 buildCommandList 的 handler,
  // 模拟一个最小命令 ctx(command 名称/空参 + 消息壳), 返回 handler 结果文本。
  // ⚠️ 2026-09-10: 抽成具名函数 —— botplay 卡片(bp:) 与「📝 卡片」编辑器发的自定义卡(bpk:)
  //    共用同一条命令执行链路(见 features/card-callback.ts)。
  // ⚠️ 2026-10-08 修：`senderId` 原为**写死空串** ⇒ 指令型按钮执行时拿不到"谁点的"
  //    （签到、按人统计这类场景全部做不了）。交互事件里本来就有点击者 openid
  //    （`group_member_openid` / `user_openid`），这里补成可选第三参 `actorOpenid`。
  const runButtonCommand = async (cmdName: string, target: ReplyTarget, actorOpenid?: string): Promise<string> => {
    const cmdList = buildCommandList({ manager, config });
    const cmd = cmdList.find((c) => (Array.isArray(c.name) ? c.name : [c.name]).map(String).includes(cmdName));
    if (!cmd) return `未知指令「${cmdName}」(指令型按钮可用的: ${cmdList.filter((c) => !(c as { hidden?: boolean }).hidden).map((c) => (Array.isArray(c.name) ? c.name[0] : c.name)).join(', ')})`;
    const fakeCtx = {
      message: { kind: target.scope === 'group' ? 'group' : 'c2c', senderId: String(actorOpenid ?? ''), groupOpenid: target.scope === 'group' ? target.targetId : undefined },
      replyTarget: target,
      command: { name: cmdName, args: [], raw: '' },
      // 2026-10-25 兼容别名：与 middleware-setup 保持一致（按钮触发的命令没有参数）
      args: '',
      rawArgs: '',
      // 部分命令(如 /bot-help)直接经 cmdCtx.bot.sendMarkdown 分段发消息 → 桥到真实 sender
      bot: { sendMarkdown: async (t: unknown, c: string) => sender.sendMarkdown((t as Parameters<typeof sender.sendMarkdown>[0]) || target, c) },
    } as never;
    const result = await cmd.handler(fakeCtx as never);
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
      const r = result as { kind?: string; content?: string };
      if (r.kind === 'text' && r.content) return r.content;
    }
    return '';
  };
  botplayController.setCommandExecutor(runButtonCommand);

  // 自定义卡片按钮回调(2026-09-10 主人要求: 卡片按钮支持「回文本 / 跳链接 / 执行命令」)。
  // 「📝 卡片」编辑器发的卡是裸卡、没有 botplay 事件挂靠 → 由本控制器兜底处理点击
  // (host 发卡时把按钮动作写进 {dataRoot}/.qqbot/card-callbacks.json, data 前缀 bpk:)。
  cardCallbackController = createCardCallbackController({
    dataRoot: dataRootOf(config),
    sendText: async (target, text) => { await sender.sendMarkdown((target as Parameters<typeof sender.sendMarkdown>[0]) || target, text); },
    commandExecutor: (cmdName, target, actorOpenid) => runButtonCommand(cmdName, target as ReplyTarget, actorOpenid),
    logger,
  });

  // ── 扩展工具按钮回调（2026-10-08 新增）──────────────────────────────
  //   让 `{dataRoot}/.qqbot-extensions/tools/*.mjs` 发出的
  //   `ext:<工具名>:<卡id>:<按钮id>` 回调按钮，能被派发给该工具的 `onInteraction(ctx, info)`
  //   （卡片注册表 features/ext-tool-cards.ts；工具契约 extension-store.ts 的 ExtensionToolDef）。
  //   ctx 用 makeExtCaps **现场组装** —— 保证"点按钮时拿到的能力"与"run() 时拿到的能力"同一套。
  extToolInteractionController = createExtToolInteractionController({
    dataRoot: dataRootOf(config),
    logger,
    makeCtx: ({ toolName, replyTarget, actor, scope, peerId, clickedBefore }) => {
      const owners = Array.isArray(config.groupAdmin?.owners) ? config.groupAdmin.owners.map(String) : [];
      const caps = makeExtCaps({
        dataRoot: dataRootOf(config),
        logger,
        appId: String(config.appId ?? ''),
        appSecret: String(config.appSecret ?? ''),
        sender: sender as never,
        replyTarget,
        scope,
        peerId,
        actorOpenid: actor.openid,
        selfName: toolName,
        owners,
        kind: 'tools',
        // ⚠️ 2026-10-08 补（主人实测：回执说"已通知 AI"，AI 那边什么都没收到）：
        //   caps.appendWake 靠 **该会话的 agent.followup** 才能唤醒；漏传时它会静默 return false
        //   （fail-soft 恰好把失败吞掉）⇒ 症状就是"嘴上说通知了、上下文里啥也没有"。
        //   与 channel-tools 里给扩展工具 run() 的 env 保持一致（那边本来就传了 agent）。
        agent: (manager.findByPeer(scope === 'group' ? 'group' : 'c2c', peerId)?.agent ?? undefined) as never,
      }) as unknown as Record<string, unknown>;
      // 点击者身份（与 botplay 同口径：owners 白名单判 isOwner）
      // name 暂留空（事件里只有 openid）；需要昵称的模块可自行查群成员台账
      caps['performer'] = { openid: actor.openid, name: '', isOwner: !!actor.openid && owners.includes(actor.openid) };
      caps['clickedBefore'] = clickedBefore; // 内存态提示；权威判重请用 caps.store 落盘
      return caps;
    },
    sendReceipt: async (target, text) => {
      try { await sender.sendMarkdown((target as Parameters<typeof sender.sendMarkdown>[0]) || target, text); } catch { /* ignore */ }
    },
  });
  logger.info('[im-qqbot] botplay 互动事件接线就绪(/botplay 触发发卡, dock🎮装配, 保存即热更; 指令型按钮已接命令层)');

  // ── 按钮回调(INTERACTION_CREATE, type=11): 审批/提问卡片共用分发 ──
  // SDK 事件: bot.on('interaction', (ctx, event) => …); 需 PUT /interactions/{id} 回应防 loading。
  if (typeof (bot as unknown as { on: (e: string, h: unknown) => void }).on === 'function') {
    (bot as unknown as { on: (e: string, h: (...a: unknown[]) => void) => void }).on('interaction', (async (ctx: unknown, event: unknown) => {
      const ev = event as { id?: string; data?: { type?: number; resolved?: { button_data?: string } } };
      // 诊断落盘(排查按钮回调是否到达; ~/.dsh/botplay-diag.log)
      try {
        const line = `[${new Date().toISOString()}] interaction id=${ev?.id ?? '?'} type=${ev?.data?.type ?? '?'} btn=${ev?.data?.resolved?.button_data ?? '(none)'} group_member=${(event as { group_member_openid?: string }).group_member_openid ?? ''} user=${(event as { user_openid?: string }).user_openid ?? ''}`;
        diagWrite('botplay-diag', line);
      } catch { /* 诊断失败忽略 */ }
      if (ev?.data?.type !== 11) return; // 只处理消息按钮回调
      const target = replyTargetOfInteraction(ev, ctx, manager);
      let consumed = false;
      try {
        if (presetSwitcher) {
          const scope = target.scope === 'group' ? 'group' : 'c2c';
          consumed = await presetSwitcher.handleInteraction(ev, target, scope, target.targetId);
        }
        if (!consumed && approvalController) consumed = await approvalController.handleInteraction(ev, target);
        if (!consumed && questionController) consumed = await questionController.handleInteraction(ev, target);
        if (!consumed && botplayController) consumed = await botplayController.handleInteraction(ev, target);
        // 扩展工具按钮(2026-10-08): data=ext:<工具名>:<卡id>:<按钮id> → 派发给该工具的 onInteraction
        if (!consumed && extToolInteractionController) consumed = await extToolInteractionController.handleInteraction(ev, target);
        // 自定义卡片(📝 卡片编辑器发的裸卡, data=bpk:<cardId>:<btnId>)兜底:
        // 查 {dataRoot}/.qqbot/card-callbacks.json → 回文本 / 执行命令 / 跳转提示
        if (!consumed && cardCallbackController) consumed = await cardCallbackController.handleInteraction(ev, target);
      } catch (err) {
        logger.warn(`[qq-interaction] 处理异常: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 回应 loading(无论是否消费都要 ack; 防客户端一直转圈)
      try {
        await (bot as unknown as { acknowledgeInteraction(id: string): Promise<void> }).acknowledgeInteraction(ev.id ?? '');
      } catch { /* ack 失败不致命 */ }
    }) as never);
    logger.info('[im-qqbot] interaction(按钮回调)分发就绪');
  }

  const outboundHandler = createOutboundHandler(manager, sender, config, logger, toolsRegistry);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outboundHandler as (...args: unknown[]) => void);

  // ── 出站流式：agent/assistant-stream（瞬态帧，不落 session log） ──
  //   2026-10-20 对齐上游 c8b9158：老的 durable `assistant/chunk` 宿主早就不发了，
  //   只监听它 = 流式永远收不到帧。该事件按 agent 作用域派发，根作用域必须 { global: true }。
  (ctx as unknown as {
    on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void;
  }).on(
    'agent/assistant-stream',
    (payload: unknown) => {
      const parsed = parseStreamFrame(payload);
      if (parsed !== undefined) outboundHandler.routeStreamFrame(parsed.agentId, parsed.delta);
    },
    { global: true },
  );

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
    setBotOnline(myNs, false);
    // 2026-10-25：连接失败也落盘 —— "控制台以前有 Bot ready 现在没有了"必须能事后查。
    try { diagWrite('qqbot-boot-diag', `bot error ns=${String(myNs)} appId=${String(config.appId)} err=${err instanceof Error ? err.message : String(err)}`); } catch { /* 忽略 */ }
  });

  bot.on('resumed', () => {
    setBotOnline(myNs, true);
    try { diagWrite('qqbot-boot-diag', `bot resumed ns=${String(myNs)} appId=${String(config.appId)}`); } catch { /* 忽略 */ }
  });

  bot.on('ready', () => {
    setBotOnline(myNs, true);
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
    try { diagWrite('qqbot-boot-diag', `bot ready ns=${String(myNs)} appId=${String(config.appId)}`); } catch { /* 忽略 */ }
  });

  // ── 生命周期 ──
  let stopScheduler: (() => void) | undefined;
  let stopJoinPoll: (() => void) | undefined;
  // 会话自设定时任务(schedule-store 系, schedule_timer 工具创建)
  let scheduleTicker: ReturnType<typeof setInterval> | undefined;
  const scheduleInFlight = new Set<string>();
  const scheduleMissed = new Map<string, number>();
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      try { diagWrite('qqbot-boot-diag', `starting bot ns=${String(myNs)} appId=${String(config.appId)} secretTail=${String(config.appSecret).slice(-4)}`); } catch { /* 忽略 */ }
      bot.start().catch((err: unknown) => {
        logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
        try { diagWrite('qqbot-boot-diag', `bot start failed ns=${String(myNs)} appId=${String(config.appId)} err=${err instanceof Error ? err.message : String(err)}`); } catch { /* 忽略 */ }
      });

      // M3 定时唤醒调度器(与 bot 同生命周期; 任务到点 followup → 回复经出站链路主动推送)
      stopScheduler = startScheduler(manager, config, logger);

      // 入群申请轮询(2026-09-09 主人定, 事件驱动兜底): 定时拉各群审批列表,
      // 有新增就唤醒 LLM 提醒主人; live config 控制(Web 设置热更, 无需重启)。
      stopJoinPoll = startJoinRequestPolling(manager, config, logger);

      // 会话自设定时任务 ticker(30s): due → injectToPeer 注入原会话 → 成功 markDone;
      // 失败(会话不在)连续≥3次自动停用; once 到期滞留 >24h 清理防堆积。
      const tickSchedule = (): void => {
        try {
          const store = getScheduleStore(scheduleDataDir);
          const now = Date.now();
          for (const job of store.list()) {
            if (job.kind === 'once' && job.dueAt !== undefined && now - job.dueAt > 24 * 3600_000) {
              store.remove(job.id);
              scheduleInFlight.delete(job.id);
              scheduleMissed.delete(job.id);
              logger.warn(`[schedule] 一次性任务过期清理 id=${job.id}`);
            }
          }
          for (const job of store.due(now)) {
            if (scheduleInFlight.has(job.id)) continue;
            scheduleInFlight.add(job.id);
            void (async () => {
              try {
                const ok = await manager.injectToPeer(job.scope, job.peerId, `[定时任务] ${job.prompt}`, 'subagent-settled');
                if (ok) {
                  scheduleMissed.delete(job.id);
                  store.markDone(job.id);
                  logger.info(`[schedule] 触发 ok job=${job.id} kind=${job.kind} → ${job.scope}:${job.peerId}`);
                } else {
                  const n = (scheduleMissed.get(job.id) ?? 0) + 1;
                  if (n >= 3) {
                    scheduleMissed.delete(job.id);
                    store.setEnabled(job.id, false);
                    logger.warn(`[schedule] job=${job.id} 连续${n}次会话不在/注入失败, 已自动停用(可在设置重新启用)`);
                  } else {
                    scheduleMissed.set(job.id, n);
                    logger.warn(`[schedule] job=${job.id} 会话不在/注入失败 第${n}次, 下轮重试`);
                  }
                }
              } catch (err) {
                logger.warn?.(`[schedule] 触发异常 job=${job.id}: ${err instanceof Error ? err.message : String(err)}`);
              } finally {
                scheduleInFlight.delete(job.id);
              }
            })();
          }
        } catch (err) {
          logger.warn?.(`[schedule] tick 异常: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      // 会话自设定时 ticker: 5s 粒度(原 30s → 一次性任务延迟上限 30s 太大, 主人实测 11:35 任务 11:36 才发;
  // 任务量小 store 内存读, 5s 开销可忽略) → 延迟压到 ≤5s。
  scheduleTicker = setInterval(tickSchedule, 5_000);
      scheduleTicker.unref?.();
      logger.info(`[schedule] ticker 启动 (30s, dataDir=${scheduleDataDir})`);

      // botplay 过期卡定期清理(Phase2): 60s 扫一次, 防内存积压(卡默认最长 600s 存活)
      const botplaySweeper = setInterval(() => {
        try { botplayController?.sweepExpired(); } catch { /* ignore */ }
      }, 60_000);
      botplaySweeper.unref?.();

      // 2026-10-12：拆成**幂等的 dispose**。它现在有两条调用路径：
      //   ① cordis 作用域销毁（把返回值交给 'im-qqbot.lifecycle'）
      //   ② 保存了「连接相关设置」后的"先拆后建"（index.ts 通过 hooks.onDisposer 拿到它）
      // 幂等守卫是必需的：两条路都可能触发，重复 dispose 会把 manager/bot 拆两次。
      let disposed = false;
      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        logger.info('Shutting down');
        registerApprovalController(myNs, undefined);
        registerQuestionController(myNs, undefined);
        registerBotplayController(myNs, undefined);
        setBotplayTriggerImpl(myNs, undefined);
        setBotplayCatalogImpl(myNs, undefined);
        registerSessionManager(myNs, undefined);
        approvalController?.dispose();
        questionController?.dispose();
        botplayController?.clear();
        stopScheduler?.();
        stopJoinPoll?.();
        if (scheduleTicker) { clearInterval(scheduleTicker); scheduleTicker = undefined; }
        clearInterval(botplaySweeper);
        flushStickerGate();
        // ── 启动钩子（ext-hooks）：卸载 / 宿主退出 / 保存连接设置后重建网关时清理本实例登记项 ──
        //    钩子可能在启动时注册了监听、定时器、订阅 —— 不清理就会在重建网关时不断累积（历史上踩过这个坑）。
        //    引擎内部逐个 try/catch + 逆序执行，单个清理失败只告警，绝不阻断其余拆卸步骤。
        try {
          const hooks = await import('../features/ext-hooks.js');
          await hooks.disposeStartupHooks(logger);
        } catch (err) {
          logger.warn?.(`[ext-hook] 清理启动钩子异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── 入站中间件扩展（ext-inbound，第五套扩展；2026-10-12）──────────────────────
        //    与启动钩子同一时机：卸载 / 宿主退出 / 保存连接设置后重建网关时，
        //    调各扩展可选导出的 dispose()，并把热重载入口摘掉（否则它会指向已经死掉的实例）。
        //    引擎内部逆序 + 逐个 try/catch，单个失败只告警，绝不阻断其余拆卸步骤。
        try {
          const inbound = await import('../features/ext-inbound.js');
          await inbound.disposeInboundExtensions(logger);
        } catch (err) {
          logger.warn?.(`[ext-inbound] 清理入站扩展异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
        await manager.disposeAll();
        bot.stop();
      };
      try { hooks?.onDisposer?.(dispose); } catch (e) { logger.warn?.(`bootstrap hooks.onDisposer 失败: ${e instanceof Error ? e.message : String(e)}`); }
      return dispose;
    }, 'im-qqbot.lifecycle');
}
