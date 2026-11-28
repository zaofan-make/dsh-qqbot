/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { randomUUID } from 'node:crypto';
import { deriveSessionIdFromKey } from '../shared/utils.js';
import { rootOf } from '../shared/root-ctx.js';
import { absCwdOf } from '../util/abs-path.js';
import { describeExtCommandReload, describeExtInboundReload, describeExtOutboundReload, reloadExtCommands, reloadExtInbound, reloadExtOutbound } from '../features/ext-reload.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { FIXED_CHANNEL_CONTEXT, REFERENCE_CONTEXT } from '../config.js';
import { LATEX_HINT_BLOCK } from '../config.js';
import { describeSessionKind, buildSessionKindHint } from '../features/session-kind.js';
import { takePendingMemo, recallLines } from '../features/people-memo.js';
import { isContextlessActive, contextlessSmartOf, contextlessMemoMaxOf, contextlessWindowOf, getContextless, listContextless, describeStorePath } from '../features/contextless-store.js';
import { contextlessSegmentOf, contextlessSegmentKeepOf, contextlessSegmentScoreMinOf } from '../features/contextless-store.js';
import { getSegmentScore } from '../features/segment-score.js';
import { offloadHistoryImages } from '../features/image-offload.js';
// ★ 2026-11-26：把已进上下文的 QQ 图片链接换成本地路径（surfaceOp replace，只动尾部）
import { replaceImagePathsInSurface } from '../features/image-path-surface.js';
// ★ 2026-11-26：pre-step 兜底把 QQ 图片 URL 换成本地路径（后台下载完的在回合开始那一刻生效）
import { lookupImagePath } from '../features/image-path-cache.js';
import { trimHistoryForContextless } from '../features/contextless-trim.js';
import { memoForInject, setMemoMaxItems } from '../features/context-memo.js';
import { traceContextless } from '../features/contextless-store.js';
import { dataRootOf, stickerDirOf } from '../gateway/data-root.js';
import { SettingsReader } from '../model/settings-reader.js';
import { ModelResolver } from '../model/model-resolver.js';
import { DEFAULT_REASONING_EFFORT } from '../model/types.js';
import { IdleEvictor } from './idle-evictor.js';
import { markTurnAborted } from '../gateway/debounce.js';
import { apply as mountChannelTools, readContextPending, clearContextPending, syncChannelScopedTools, ensureExtToolsGlobal, applyExtToolVisibility, instanceTagOfManager, setCtxEnv } from '../channel-tools.js';
import { createGroupAdmin } from '../api/group-admin.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveSessionDurably, attachSessionToWorkspaceWithRetry, unarchiveSession } from './workspace-attach.js';
/** 通道工具注册诊断: 默认关闭; 设环境变量 QQBOT_DIAG_FILE 启用 */
const SM_DIAG_FILE = process.env.QQBOT_DIAG_FILE || '';
function diagSm(line) {
    if (!SM_DIAG_FILE)
        return;
    try {
        appendFileSync(SM_DIAG_FILE, `${new Date().toISOString()} [sm] ${line}\n`);
    }
    catch { /* ignore */ }
}
/** agent ctx 上"通道工具已装载"标记(幂等/自愈用) */
/** 智能判断模式的「每轮必做」提示（2026-10-01 主人审过的措辞） */
const CTX_SMART_REMINDER = [
    '【⚠️ 话题判断 · 每轮必做，且必须给出结论】',
    '本会话开着「无上下文模式 · 智能判断」——历史会随每一轮一起送出，**每多带一轮就是在白花主人的钱**。',
    '',
    '**每轮回复前，必须做这件事**：判断当前话题是否已经结束（或对方明显换话题了）。',
    '判断完**立刻动手**，不要想着「再观察一下」：',
    '',
    '  · 话题还在继续 → 不动作（这是唯一可以不动作的情况）',
    '  · 话题已结束 / 明显换向 → **立刻处理**：',
    '      · 这段历史以后用不上 → 调 context_drop',
    '      · 以后还可能用到 → 调 context_compact（keep 默认 3）',
    '      · **犹豫不决时 → 默认 context_compact**（压缩比丢弃安全；要点能写进 note）',
    '',
    '**调之前先写 note**（一句话把这段的要害写下来）——它存进你的备忘，压缩/丢弃都碰不到它。',
    '  ⚠️ note 必须精简：一句话、别超 100 字；写完确认旧的那条已删（备忘有条数上限，超了丢最旧）。',
    '  ⚠️ 不要把「日常寒暄、重复确认、已经写在备忘里的内容」再写一遍。',
    '  · context_memo 只用来看/改/删已有的备忘，**别拿它当随手记的笔记本**。',
    '',
    '**判断标准（拿不准时照这个来）**：',
    '  · 已经聊了 5 轮以上、且中间没有新信息进来 → 可以压',
    '  · 对方换了话题、或开始聊一件跟前面无关的事 → 可以丢',
    '  · 只是「聊得挺热」但内容重复、没有新增结论 → **一样可以压**（热不等于有用）',
].join('\n');
const CTX_TOOLS_READY = Symbol('qqbotChannelToolsReady');
export class SessionManager {
    ctx;
    agents;
    config;
    logger;
    sessions = new Map();
    evictor;
    modelResolver;
    /** QQ 通道发送能力(由 bootstrap 注入)；仅作为 qqChannel service 暴露给通道工具，不在此注册工具 */
    channelSender;
    /** 最近一次 setup 收到的 agent ctx(工具自愈用；getOrCreate 完成后读走并清空) */
    lastSetupCtx;
    /** 群守则热更新: 每次 system prompt 渲染现读 settings.yaml(SettingsReader fresh 模式) */
    liveSettingsReader;
    /** 注入 QQ 通道发送能力(供通道工具)；bootstrap 调用 */
    /**
     * 取本实例的**真发送器**（bootstrap 里那个 QQBotSender：sendMedia / sendTuwenCard /
     * recallLast 全套都在）。
     *
     * 2026-10-30 加：扩展命令以前拿到的 `sender` 是中间件 ctx 上的 SDK bot（只有
     * sendText / sendMarkdown），于是命令侧 `env.image()` / `env.card()` 全部静默返回 false
     * —— 现象就是「/头像 会注入文字、但图发不出来」。这里把真 sender 暴露出去，
     * capsForCmd 优先用它。
     */
    get sender() {
        return this.channelSender;
    }
    installChannelSender(sender) {
        this.channelSender = sender;
    }
    /**
     * 最近一次"建会话"失败的原始错误（2026-10-24 加，issue #18）。
     * 起因：create 抛的错只在 logger 里留一行，命令层统一回「请稍后再试」，
     * 手机上完全没法自助排查（cwd 相对路径就是这么被藏住的）。
     */
    lastCreateError = '';
    /** 本实例工作目录(多账号独立; 缺省进程 cwd) */
    get cwd() {
        return absCwdOf(this.config.cwd) || process.cwd();
    }
    /** 插件数据根(表情包/.qqbot/扩展统一挂其下; config.dataRoot 缺省=cwd) */
    get dataRoot() {
        return dataRootOf(this.config);
    }
    /** 本实例图库目录(多账号: 每实例数据根独立; config.sticker.dataDir 可覆盖) */
    get stickerDataDir() {
        return stickerDirOf(this.config);
    }
    /** 本实例定时任务目录(多账号: 每实例数据根独立) */
    get scheduleDataDir() {
        return join(dataRootOf(this.config), '.qqbot');
    }
    /** 本实例群管理客户端(懒建; groupAdmin.enabled=false 时 undefined) */
    get groupAdmin() {
        if (!this.config.groupAdmin?.enabled)
            return undefined;
        if (!this._groupAdmin) {
            this._groupAdmin = createGroupAdmin({ appId: this.config.appId, appSecret: this.config.appSecret });
        }
        return this._groupAdmin;
    }
    _groupAdmin;
    /**
     * 素材上传专用的轻量客户端（2026-10-30）：
     *   md-media 只借它的 apiCall 走 `/v2/media-images` 传图，与「群管理功能开不开」无关。
     *   以前直接复用 groupAdmin，而 groupAdmin.enabled=false 时那个 getter 恒返回 undefined，
     *   于是本地图 markdown 永远不改写，正文把 `![说明](D:\...\x.jpg)` 原样当文本发给群友。
     */
    get mediaApi() {
        if (!this._mediaApi) {
            try {
                this._mediaApi = createGroupAdmin({ appId: this.config.appId, appSecret: this.config.appSecret });
            }
            catch {
                return undefined;
            }
        }
        return this._mediaApi;
    }
    _mediaApi;
    /** 对话内默认管理群(web/非群会话时群工具用它; 空=未配置) */
    get manageGroup() {
        return this.config.groupAdmin?.manageGroup ?? '';
    }
    /** 当前出站模式(adaptive/passive/silent/nothink; 命令与 channel 工具读它显示当前值) */
    get outboundMode() {
        return this.config.outboundMode || 'adaptive';
    }
    /** 实例 settingsNs(多账号实例 id; 无则默认 im-qqbot) */
    get settingsNs() {
        return (this.config.settingsNs ?? '').trim() || 'im-qqbot';
    }
    constructor(ctx, agents, config, logger) {
        this.ctx = ctx;
        this.agents = agents;
        this.config = config;
        this.logger = logger;
        this.modelResolver = new ModelResolver(ctx, config, logger);
        this.evictor = new IdleEvictor(this.sessions, config.sessionIdleTimeout, (key, record) => {
            this.logger.info(`evicting idle session: key=${key}`);
            this.sessions.delete(key);
            record.agent.cancel({ kind: 'user' });
            void record.handle.dispose().catch(() => { });
        });
        // 2026-09-11 主人定: 被归档的 QQ 会话在**被消息触发时**自动拉回可见(见 workspace-attach.ts)。
        // 这里不装任何守卫/拦截/定时器 —— 纯触发式, 落点在 getOrCreate 的两条路径上:
        //   ① 命中已有活跃记录 → unarchiveSession(); ② 新建/恢复 → attachSessionToWorkspace()。
    }
    /**
     * 动态获取 sessions 服务（fork 能力，可选）
     */
    getSessionsService() {
        try {
            return this.ctx.get('sessions');
        }
        catch {
            return undefined;
        }
    }
    // ── 模型相关（委托给 ModelResolver） ──
    /**
     * 可选的**思考强度**档位（2026-11-08）。
     * 优先问宿主 `llm.reasoningEfforts?.()`；拿不到就给常见几档（deepseek 适配器是 off/low/high/max）。
     * ⚠️ 只是"可选项"，真正支不支持由 provider/模型自己决定 —— 传错档位适配器会报错，所以尽量用宿主给的。
     */
    async listReasoningEfforts() {
        try {
            const llm = this.ctx.get('llm');
            const got = llm && typeof llm.reasoningEfforts === 'function' ? await llm.reasoningEfforts() : undefined;
            if (Array.isArray(got) && got.length > 0)
                return got.map((x) => String(x));
        }
        catch { /* 宿主没有就回落 */ }
        return ['off', 'low', 'high', 'max'];
    }
    getEffectiveModel(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const rec = this.sessions.get(key);
        // 2026-09-11: 优先读宿主 agent 实际生效模型 —— web 会话级模型设置会改宿主
        // agent.options.provider/model(推理真用那个); 探测失败(fail-soft)回落配置链。
        if (rec?.agent) {
            // ★ 2026-11-08：新宿主把当前选择放在 `agent.model.current()`（方法），
            //   旧宿主才是 `agent.options.provider/model`。两边都读，否则会出现
            //   "卡片显示旧 prefs / 实际宿主用的是另一个模型" 的错位。
            try {
                const m = rec.agent.model;
                const cur = m && typeof m.current === 'function'
                    ? m.current()
                    : undefined;
                if (cur?.provider && cur?.model) {
                    return {
                        provider: cur.provider,
                        model: cur.model,
                        ...(typeof cur.reasoningEffort === 'string' ? { effort: cur.reasoningEffort } : {}),
                    };
                }
            }
            catch { /* fail-soft */ }
            try {
                const o = rec.agent.options;
                if (o?.provider && o?.model)
                    return { provider: o.provider, model: o.model };
            }
            catch { /* fail-soft */ }
        }
        // 2026-09-11: 模型偏好绑定会话 —— 取当前会话的 sessionId 查 override
        const sid = rec?.sessionId ?? this.currentSessionId(key);
        return this.modelResolver.getEffectiveRoute(key, sid);
    }
    /**
     * 切换模型（fork + 重建，对齐 dsh-TUI 的 switchModel）
     * ⚠️ 2026-09-11 主人定: 模型偏好改为绑定会话(sessionId)——override 存到 fork 后的
     *    新会话 id, 使新会话/新档不再继承 peer 级旧偏好(修复"新建会话默认火山")。
     */
    async setModelOverride(scope, peerId, route) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        if (!record) {
            // 无活跃会话：挂到当前/派生 sessionId(下次 create/resume 会命中)
            const sid = this.currentSessionId(key);
            this.modelResolver.setOverride(key, sid, route);
            this.logger.info(`model pref saved (no active session): key=${key} sid=${sid} → ${route.provider}/${route.model}`);
            return;
        }
        // ★ 2026-11-08：**同模型同强度 → 什么都不用做**（原来会白 fork 一个新会话）。
        //   仅"思考强度"变化也不 fork —— 强度是随请求下发的，改活动 agent 的选择即可。
        const cur = this.getEffectiveModel(scope, peerId);
        if (cur && cur.provider === route.provider && cur.model === route.model) {
            const sameEffort = (cur.effort ?? '') === (route.effort ?? '');
            if (sameEffort) {
                this.logger.info(`model pref unchanged: key=${key} → ${route.provider}/${route.model}${route.effort ? ` effort=${route.effort}` : ''}`);
                return;
            }
            try {
                this.applyModelRoute(record.agent, route, 'effort-only');
            }
            catch { /* fail-soft：拿不到 agent 就走下面的 fork */ }
            this.modelResolver.setOverride(key, record.sessionId, route);
            this.logger.info(`model effort updated (no fork): key=${key} effort=${route.effort}`);
            return;
        }
        // fork 旧会话历史作为 seed → 子会话保留上下文继续聊(换模型不丢记忆)
        await this.forkCurrentSession(key, record, route, true);
        // fork 后 record.sessionId = childId；override 挂到新会话(会话级绑定)
        this.modelResolver.setOverride(key, record.sessionId, route);
        this.logger.info(`model pref saved (forked): key=${key} sid=${record.sessionId} → ${route.provider}/${route.model}`);
    }
    /**
     * 开新会话(2026-09-08 修 /bot-new 假实现; 同日加 preset 切换):
     * 当前会话 fork 成 childId(旧会话存档为 parent, 磁盘记录仍在可回看),
     * 用同模型建新 agent 替换活跃记录。inherit=true 继承旧对话上下文(切模型用);
     * false = 全新空档(不继承旧上下文, 旧会话存档可回看)。
     * presetId 给定时: 记录该会话的 preset 覆盖并用于新档(如 /new code 切人格);
     * 不传则沿用当前生效 preset(config 或之前会话覆盖)。
     * 无活跃记录(会话损坏/重启后没聊过)时不再失败: 轮换 sessionId 直接另起新档。
     * @returns 'forked'=从当前会话 fork 出新档 | 'rotated'=无活跃记录另起全新档 | 'failed'=创建失败
     */
    async startNewSession(scope, peerId, inherit = false, presetId, fallback) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        // 2026-09-11 主人反馈「炸了的会话在 QQ 上没法弃号重开」:
        // 会话在磁盘上损坏(历史加载失败)时内存里没有活跃记录, 原实现在此直接 return false →
        // QQ 侧 /bot-new 只会回「当前没有活跃会话, 无需开新」, 主人无路可走。
        // 现改为: 轮换 sessionId 直接另起新档(坏档文件原样保留在磁盘, 不删也不修)。
        if (!record) {
            if (presetId) {
                try {
                    this.modelResolver.setSessionPreset(key, presetId);
                }
                catch { /* ignore */ }
            }
            const replyTarget = fallback?.replyTarget ?? { scope, targetId: peerId };
            try {
                await this.getOrCreate(scope, peerId, fallback?.senderId ?? '', replyTarget, { forceNew: true });
                this.logger.info(`startNewSession: 无活跃记录 → 已另起新档 key=${key}${presetId ? ` preset=${presetId}` : ''}`);
                return 'rotated';
            }
            catch (err) {
                this.lastCreateError = err instanceof Error ? err.message : String(err);
                this.logger.warn(`startNewSession(rotated) failed: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
                return 'failed';
            }
        }
        // preset 覆盖: 显式给出则落盘(重启后恢复同 preset)
        if (presetId) {
            try {
                this.modelResolver.setSessionPreset(key, presetId);
            }
            catch { /* ignore */ }
        }
        // ⚠️ 2026-09-14 修（主人报「一用 /bot-new，所有会话的模型都变成某个 web 会话的了」）：
        //   原来这里取 `getEffectiveRoute` —— 它只看「插件 override / 配置默认链」，
        //   **不读会话实际在用的模型**。会话的模型若是在宿主侧设的（web 上选的，落在 agent.options），
        //   override 里什么都没有 → fork 时掉进 `resolveDefault()`，
        //   而 resolveDefault 读的是宿主**当前默认选择**(agentDefaultModel.currentSelection()) ——
        //   表现就是"所有会话都换成了某一个会话的模型"。改成优先读实际生效模型(getEffectiveModel)。
        const route = this.getEffectiveModel(scope, peerId)
            ?? this.modelResolver.getEffectiveRoute(key, record.sessionId);
        await this.forkCurrentSession(key, record, route, inherit);
        // 顺手记进 override（绑到 fork 后的新 sessionId）—— 不然下次 fork / 重启还会掉回默认
        if (route) {
            try {
                this.modelResolver.setOverride(key, record.sessionId, route);
            }
            catch { /* ignore */ }
        }
        return 'forked';
    }
    /** 当前会话生效 preset: 会话覆盖(/new 指定) > config.preset */
    effectivePreset(key) {
        const override = this.modelResolver.getSessionPreset(key);
        return override || this.config.preset;
    }
    /** 当前会话实际生效的人格(展示用): 会话记录 agentPreset(已挂载) > effectivePreset */
    getEffectivePreset(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        return record?.agentPreset || this.effectivePreset(key);
    }
    /**
     * 热切换预设(2026-09-10 主人确认: 设置页就是这么热切的):
     * 直接调宿主 agentPresets.recompose(agent.ctx, id) —— 重绑 agent 的 scope 父级
     * 到目标 preset 的 standing mount, 立即生效、不丢会话历史、不 fork。
     * 这是宿主「账号和预设」设置页同款通道(实测语气即变)。
     * @returns 'ok' | 'no-session' | 'no-preset' | 'recompose-failed'
     */
    async switchPreset(scope, peerId, presetId) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        if (!record)
            return 'no-session';
        if (!(await this.hasPreset(presetId)))
            return 'no-preset';
        const agentCtx = record.agent?.ctx;
        if (!agentCtx)
            return 'recompose-failed';
        try {
            const presets = this.ctx.get('agentPresets');
            if (!presets || typeof presets.recompose !== 'function') {
                this.logger.warn(`switchPreset: 宿主未提供 agentPresets.recompose, 回退 fork 通道`);
                return 'recompose-failed';
            }
            await presets.recompose(agentCtx, presetId);
            // 记录会话 preset 覆盖(重启后恢复同人格; 与 /new 一致)
            try {
                this.modelResolver.setSessionPreset(key, presetId);
            }
            catch { /* ignore */ }
            // 更新 record 上的 agentPreset 展示字段(会话状态/日志用)
            record.agentPreset = presetId;
            this.logger.info(`switchPreset ok: key=${key} → preset=${presetId} (host recompose, 热切不丢历史)`);
            return 'ok';
        }
        catch (err) {
            this.logger.warn(`switchPreset failed: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
            return 'recompose-failed';
        }
    }
    /** 列出宿主可用 agent presets(供 /presets 命令; 失败返回空) */
    async listPresets() {
        try {
            const presets = this.ctx.get('agentPresets');
            if (!presets || typeof presets.list !== 'function')
                return [];
            return await presets.list();
        }
        catch {
            return [];
        }
    }
    /** 校验 preset id 是否存在(供 /new <id>; 未知/损坏返回 false) */
    async hasPreset(id) {
        const list = await this.listPresets();
        return list.some((p) => p.id === id && !p.broken);
    }
    // ── 宿主权限档位(permissionPresets)桥接(2026-09-08, QQ 里切权限) ──
    permissionPresetsService() {
        try {
            return this.ctx.get('permissionPresets');
        }
        catch {
            return undefined;
        }
    }
    /** 列出宿主权限档(如 workspace-write / danger-full-access / read-only) */
    async listPermissionPresets() {
        const svc = this.permissionPresetsService();
        if (!svc || !Array.isArray(svc.names) || typeof svc.optionOf !== 'function')
            return [];
        return svc.names.map((n) => svc.optionOf(n));
    }
    /** 当前会话权限档名 */
    currentPermissionPreset(scope, peerId) {
        const svc = this.permissionPresetsService();
        if (!svc || typeof svc.current !== 'function')
            return '';
        const rec = this.sessions.get(this.sessionKey(scope, peerId));
        if (!rec)
            return '';
        try {
            return svc.current(rec.agent.session);
        }
        catch {
            return '';
        }
    }
    /** 切权限档: 校验名字 → svc.set(session, name) */
    async switchPermissionPreset(scope, peerId, name) {
        const svc = this.permissionPresetsService();
        if (!svc || typeof svc.set !== 'function') {
            return { ok: false, msg: '宿主未提供 permissionPresets 服务(需装配 dsh-permission-presets)' };
        }
        const list = await this.listPermissionPresets();
        const hit = list.find((p) => p.value === name);
        if (!hit) {
            const lines = [`未知权限档「${name}」— 可用:`];
            for (const p of list)
                lines.push(`- ${p.value}${p.name && p.name !== p.value ? `(${p.name})` : ''}${p.description ? ` — ${p.description}` : ''}`);
            return { ok: false, msg: lines.join('\n') };
        }
        const rec = this.sessions.get(this.sessionKey(scope, peerId));
        if (!rec)
            return { ok: false, msg: '当前没有活跃会话, 请先聊一句再切' };
        try {
            svc.set(rec.agent.session, name);
            this.logger.info(`[permission] 权限档 → ${name} (${scope}:${peerId})`);
            return { ok: true, msg: `✅ 权限档已切换: **${hit.name ?? name}**${hit.description ? `\n${hit.description}` : ''}` };
        }
        catch (err) {
            return { ok: false, msg: `切换失败: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    /** fork 当前会话 → 新 childId; inherit=true 用旧历史做 seed(切模型), false 全新空档; 失败降级 dispose */
    async forkCurrentSession(key, record, route, inherit) {
        const sessionsService = this.getSessionsService();
        if (!sessionsService) {
            this.logger.warn(`fork unavailable, fallback to dispose: key=${key}`);
            this.sessions.delete(key);
            record.agent.cancel({ kind: 'user' });
            await record.handle.dispose().catch(() => { });
            return;
        }
        let seed;
        if (inherit) {
            try {
                seed = sessionsService.fork(record.agent.session).events;
            }
            catch (err) {
                this.logger.warn(`fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
                this.sessions.delete(key);
                record.agent.cancel({ kind: 'user' });
                await record.handle.dispose().catch(() => { });
                return;
            }
        }
        const childId = SessionId(randomUUID());
        const composed = await this.composePreset(this.effectivePreset(key));
        const created = await this.agents.create({
            sessionId: childId,
            ...(seed ? { seed } : {}),
            meta: {
                cwd: absCwdOf(this.config.cwd) || process.cwd(),
                parentSession: record.sessionId,
                ...(seed ? { seedLength: seed.length } : {}),
                ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
            },
            ...(route ? { agentOptions: this.toAgentOptions(route) } : {}),
            ...(composed.setup ? { setup: composed.setup } : {}),
        });
        this.modelResolver.setSessionId(key, childId);
        // ★ 2026-11-15（CodeRabbit）：**在 await 之后、替换记录之前**读旧 id。
        //   原来放在函数最开头 —— 但 `forkCurrentSession` 前面有 `agents.create` 这个 await，
        //   两个重叠的 fork 会在 await 前都读到同一个 A：后一个把前一个创建的 B 顶掉时，
        //   B 永远没被归档。放到这里，每次替换都能归档"当前实际被替换的那个"。
        const preForkSessionId = String(record.sessionId ?? '');
        const oldHandle = record.handle;
        record.sessionId = childId;
        record.agent = created.agent;
        record.handle = created;
        record.agentPreset = composed.agentPreset;
        record.lastActivity = Date.now();
        // ★★ 2026-11-25：/bot-new 换 agent 也不经 claimed/pre-step ⇒ 补一次 scoped 注册。
        try {
            this.syncScopedToolsOnClaim(created.agent);
        }
        catch { /* ignore */ }
        void oldHandle.dispose().catch(() => { });
        void attachSessionToWorkspaceWithRetry(this.ctx, this.config.cwd, childId, this.logger, {
            // 这个 childId 已经被下一次 fork/new 取代的话，别再挂、更别反归档（会撤销别人的自动归档）
            //
            // ★ 2026-11-15（CodeRabbit 第二轮）：**必须看 this.sessions 里的活动记录**，
            //   不能用 `currentSessionId(key)` —— resolver 的 sessionId 映射会被
            //   `clearModelOverride` 清掉（那时活动记录还活着），清掉后 currentSessionId
            //   回落成派生 id，就会把这个**仍在用的会话**误判成过期：挂载重试被中止、
            //   已完成挂载的也会跳过反归档。
            isStale: () => {
                const rec = this.sessions.get(key);
                if (!rec)
                    return true; // 记录没了 = 确实失效
                return String(rec.sessionId ?? '') !== childId;
            },
        });
        // ★ 2026-11-15（群友提的补丁）：新档建好后，把**被取代的旧档**收进「已归档」，
        //   侧边栏不再堆僵尸档。fail-soft + 幂等（见 archiveSessionDurably 注释）；
        //   开关 `archiveOnNewSession` 默认开，关掉就恢复原行为。
        if (preForkSessionId && preForkSessionId !== childId && this.config.archiveOnNewSession !== false) {
            void archiveSessionDurably(this.ctx, preForkSessionId, this.logger);
        }
        this.logger.info(`forked session: key=${key} → ${childId} ${seed ? '(继承历史)' : '(全新空档, 旧会话存档为 parent)'} route=${route ? `${route.provider}/${route.model}` : 'session-own'}`);
    }
    clearModelOverride(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const rec = this.sessions.get(key);
        const sid = rec?.sessionId ?? this.currentSessionId(key);
        this.modelResolver.clearOverride(key, sid);
        this.modelResolver.clearSessionId(key);
    }
    async listAvailableModels() {
        return this.modelResolver.listModels();
    }
    listProviders() {
        return this.modelResolver.listProviders();
    }
    // ── 会话状态 / 统计 ──
    getSessionRecord(scope, peerId) {
        return this.sessions.get(this.sessionKey(scope, peerId));
    }
    getStatus(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const route = this.getEffectiveModel(scope, peerId);
        return {
            active: !!record,
            sessionId: record?.sessionId,
            provider: route?.provider,
            model: route?.model,
            preset: record?.agentPreset,
            lastActivity: record?.lastActivity,
            messageCount: this.countMessages(record),
        };
    }
    getTokenUsage(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const events = record?.agent.session.events;
        if (!events)
            return stats;
        for (const event of events) {
            if (event.type !== 'assistant/message' || !event.usage)
                continue;
            stats.input += event.usage.input ?? 0;
            stats.output += event.usage.output ?? 0;
            stats.cacheRead += event.usage.cacheRead ?? 0;
            stats.cacheWrite += event.usage.cacheWrite ?? 0;
        }
        return stats;
    }
    exportMarkdown(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        if (!record)
            return '';
        const events = record.agent.session.events;
        if (!events || events.length === 0)
            return '';
        const lines = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];
        for (const event of events) {
            if (event.type === 'user/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 用户\n\n${text}\n`);
            }
            else if (event.type === 'assistant/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 助手\n\n${text}\n`);
            }
        }
        return lines.join('\n');
    }
    countMessages(record) {
        const events = record?.agent.session.events;
        if (!events)
            return 0;
        let count = 0;
        for (const event of events) {
            if (event.type === 'user/message' || event.type === 'assistant/message') {
                count += 1;
            }
        }
        return count;
    }
    // ── Session 生命周期管理 ──
    sessionKey(scope, peerId) {
        return `qqbot:${this.config.appId}:${scope}:${peerId}`;
    }
    /**
     * 由 DSH 会话 id 反查**本实例**的 QQ sessionKey（严格校验 appId 归属）。
     *
     * ⚠️ 为什么不直接用 `modelResolver.findKeyBySessionIdOrDerived()` 的裸结果
     *   （CodeRabbit 2026-11-28 · Major）：
     *   `model-prefs.json` 是**全实例共享**的一份文件（`~/.dsh-qqbot/` 或 `$DSH_HOME` 下）。
     *   多开实例时里面同时躺着**别的实例**的 key，而**同一个群里两个 bot 的 `scope:peerId`
     *   完全一样、只有 appId 不同** ⇒ 光比对尾巴根本分不出是谁的。
     *   偏偏这个 sk 会被拿去给 agent 挂/摘通道工具（`syncScopedToolsOnClaim`）——
     *   那就是在**改别人 agent ctx 上的注册**（实例 B 的 groupAdmin 关着，就能把实例 A
     *   已注册的 `qq_group_admin` 撤掉；B 的上下文工具开关也会盖掉 A 的状态）。
     *   所以必须在拿到 key 之后按 appId 卡一道，而不是把「反查命中」当成「归属确认」。
     *
     * 换号 / 迁移（历史 key 是旧 appId 前缀）：**优先挑当前 appId 的那条**（把 `cur` 传给反查，
     *   见方法体注释）。只有当文件里**只剩旧 appId 的 key** 时才不接受 —— 那种情况退化成旧行为
     *   （判不出是 QQ 会话），不会误伤到别人的 agent。
     *   ⚠️ appId 只区分"不同 bot 号"：**同号多开**（同一凭据复制两个 profile 且共享 dataRoot）
     *   仍需要靠 dataRoot 隔离，这一道校验帮不上忙。
     *
     * @returns sessionKey；`''` 表示"不是本实例的会话"或"查不到"
     */
    sessionKeyOfSession(sid) {
        const cur = String(this.config.appId ?? '');
        let sk = '';
        // ★ **必须把 cur 传下去**（复审 R5）：同一个 sid 可能同时挂着「旧 appId 的 key」和
        //   「当前 appId 的 key」—— 换号后 `getSessionId` 的认领迁移会为新的写一条、**旧的保留不删**。
        //   反查若只取"第一个命中"，就永远拿到旧 appId 那条，再被下面这道校验拒掉
        //   ⇒ 换过号的用户会**永久**认不出自己的 QQ 会话（不是窗口性的，旧 key 只能等 300 条淘汰）。
        try {
            sk = String(this.modelResolver.findKeyBySessionIdOrDerived(sid, cur) ?? '');
        }
        catch {
            return '';
        }
        if (!sk)
            return '';
        const m = /^qqbot:([^:]*):(?:group|c2c):/.exec(sk);
        if (!m)
            return '';
        // 没配 appId 的部署（本地自测）无从校验 ⇒ 放行，否则整个功能都废掉
        if (!cur)
            return sk;
        if (String(m[1] ?? '') === cur)
            return sk;
        // 走到这里只剩两种可能：① 别的实例的 key（多开共用同一份 model-prefs.json）；
        // ② 换号后本实例在文件里**只**剩旧 appId 的 key。两种都按"不是本实例"处理（fail-closed）。
        this.logger?.debug?.(`[session-key] 忽略非本实例 appId 的 key: ${sk} (本实例=${cur})`);
        return '';
    }
    /**
     * 这个会话是不是**别的实例**的 QQ 会话（反查到了 key，但 appId 不属于本实例）。
     *
     * ⚠️ 必须和「反查不到」区分开（CodeRabbit 2026-11-28 · Major）：
     *   - **反查不到** → 未绑定的纯 web 会话，走**全局** contextless 设置（原行为，保留）；
     *   - **别的实例的** → **一律不处理**，否则会拿本实例的全局窗口去裁剪别人的历史（不可逆）。
     *   两者合并成同一个空串就会出这个事故。
     *
     * 换号场景不会误判：`findKeyBySessionIdOrDerived(sid, cur)` 会**优先返回本实例 appId 的那条**，
     * 只要存在就命中，走不到"判成别人的"这一步。
     */
    isForeignSession(sid) {
        const cur = String(this.config.appId ?? '');
        if (!cur)
            return false; // 没配 appId → 无从判断，按原行为走
        const want = String(sid ?? '').trim();
        if (!want)
            return false;
        let sk = '';
        try {
            sk = String(this.modelResolver.findKeyBySessionIdOrDerived(want, cur) ?? '');
        }
        catch {
            return false;
        }
        if (!sk)
            return false; // 查不到 = 未绑定，不是"别人的"
        const m = /^qqbot:([^:]*):(?:group|c2c):/.exec(sk);
        if (!m)
            return false;
        return String(m[1] ?? '') !== cur;
    }
    deriveSessionId(sessionKey) {
        // ★ 2026-11-28：公式与 `prefs-store` 的**反查**（`findKeyBySessionIdOrDerived`）共用一份
        //   （`shared/utils` 的 `deriveSessionIdFromKey`）—— 两边必须算得一模一样，
        //   否则普通建档的 QQ 会话永远反查不到。
        return deriveSessionIdFromKey(sessionKey);
    }
    currentSessionId(sessionKey) {
        return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
    }
    async composePreset(presetId) {
        let presets;
        try {
            presets = this.ctx.get('agentPresets');
        }
        catch {
            // agentPresets 服务未注入，降级跳过
        }
        // 通道级装配(与 preset 无关)：QQ 会话创建时 provide qqChannel 供通道工具 execute 解析。
        // 工具永久挂载(2026-09-06 主人定): QQ 会话创建/恢复的 setup 事务内一律把 channel-tools 注册到
        //   agentCtx(own 层, 幂等) → 新会话即刻带工具、重启 resume 也带; 不再依赖 preset 声明
        //   (任意预设走 QQ 都可用, preset 文件零改动; 账号页预设过滤已放开)。
        //   standing 层若与 preset 自带装配并存, channel-tools 内部幂等跳过重复, 无副作用。
        //   安全: setup 只由 QQ 会话管理器(getOrCreate/create/resume)执行, 纯 web 会话不经过 → 不挂。
        const provideChannel = this.channelSender === undefined
            ? undefined
            : (agentCtx) => {
                this.lastSetupCtx = agentCtx;
                try {
                    agentCtx.provide?.('qqChannel', {
                        manager: this,
                        sender: this.channelSender,
                    });
                }
                catch { /* ignore */ }
            };
        const registerOnAgentCtx = this.channelSender === undefined
            ? undefined
            : async (agentCtx) => {
                if (agentCtx[CTX_TOOLS_READY] === true) {
                    diagSm('agentCtx 注册跳过(已装载过)');
                    return;
                }
                try {
                    await mountChannelTools(agentCtx, { dataRoot: this.resolveDataRootSmart(), cwd: String(this.config.cwd ?? ''), config: this.config });
                    agentCtx[CTX_TOOLS_READY] = true;
                    this.logger.info('im-qqbot: 通道工具已注册到 agentCtx(send_media/recall_message/list_stickers)');
                    diagSm('agentCtx 注册完成(mountChannelTools 正常返回)');
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.warn?.(`im-qqbot: 装载通道工具失败(跳过): ${msg}`);
                    diagSm(`agentCtx 注册异常: ${msg}`);
                }
            };
        const channelSetup = (agentCtx) => (async () => {
            provideChannel?.(agentCtx);
            // 守则/身份 context 注册已移至 ensureGroupRules(每次消息自愈钩子, 幂等)。
            // QQ 工具: setup 事务(create/resume 都执行)内无条件注册到 agentCtx own 层(幂等)——
            // 有 presets 也注册(此前只 provide、留给 preset 装配; 2026-09-06 改为永久挂载)。
            await registerOnAgentCtx?.(agentCtx);
        })();
        if (!presets)
            return channelSetup ? { setup: channelSetup } : {};
        try {
            const resolved = await presets.resolve(presetId);
            const resolvedId = resolved.id;
            return {
                agentPreset: resolvedId,
                setup: async (agentCtx) => {
                    await presets.mount(agentCtx, resolvedId);
                    if (channelSetup)
                        await channelSetup(agentCtx);
                },
            };
        }
        catch (err) {
            this.logger.warn(`im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`);
            return channelSetup ? { setup: channelSetup } : {};
        }
    }
    /** 获取或恢复或创建会话（get → resume → create） */
    async getOrCreate(scope, peerId, senderId, replyTarget, opts) {
        const key = this.sessionKey(scope, peerId);
        const wantCwd = absCwdOf(this.config.cwd) || process.cwd();
        const prevCfg = this.modelResolver.getSessionCfg(key);
        // ── cwd 指纹校验(2026-09-08, 响应上游 issue #43: cwd 改了要能换会话) ──
        // 背景: sessionId 由 sessionKey 确定性派生, 与 cwd 无关 → 改 cwd 后 resume 仍命中旧 cwd 会话。
        // ⚠️ 只比 cwd 不比 preset: preset 有热更新通道(dock 人格编辑器保存即热更), 改 preset 不应扔会话历史。
        // 变更处理:
        //   ① 活跃会话在内存 → fork 继承历史 + 新 cwd 建新档(对话无缝迁移, 旧档存档可回看)= 热迁移
        //   ② 无活跃会话(重启后首条消息)→ 无法 fork 旧会话(不在内存), 清记录走 create 用新 cwd(旧文件保留可回看)
        if (prevCfg && (prevCfg.cwd ?? '') !== wantCwd) {
            const active = this.sessions.get(key);
            if (active) {
                this.logger.info(`getOrCreate: cwd 已变更, fork 热迁移(继承历史): key=${key} old=${prevCfg.cwd ?? '(未记录)'} new=${wantCwd}`);
                // forkCurrentSession 内部用 this.config.cwd(新值)建子会话并继承历史 seed;
                // fork 后 active 记录的 sessionId/agent 已被替换为新档, 直接补 target 返回即可。
                // ⚠️ 2026-09-14 同款修复：模型要跟"会话实际在用的"走，不能取默认链（否则热迁移也会换模型）
                const route = this.getEffectiveModel(scope, peerId)
                    ?? this.modelResolver.getEffectiveRoute(key, active.sessionId);
                await this.forkCurrentSession(key, active, route, true);
                active.replyTarget = replyTarget;
                active.lastActivity = Date.now();
                return active;
            }
            this.logger.info(`getOrCreate: cwd 已变更且无活跃会话, 弃旧开新: key=${key} old=${prevCfg.cwd ?? '(未记录)'} new=${wantCwd}(旧会话文件保留)`);
            this.modelResolver.clearSessionId(key);
            this.modelResolver.clearSessionCfg(key);
        }
        const existing = this.sessions.get(key);
        if (existing) {
            existing.replyTarget = replyTarget;
            existing.lastActivity = Date.now();
            // 会话已存在且配置一致 → 指纹刷新为当前值(防止误判)
            try {
                this.modelResolver.setSessionCfg(key, { cwd: wantCwd });
            }
            catch { /* ignore */ }
            // 2026-09-11 主人定「触发会话时反归档」: 这条消息把该会话激活了 → 顺带把它从归档里拉回可见。
            // (主人主动归档的会话保持归档, 只有真的被消息用到才回来; 幂等 + fail-soft, 不阻塞主链)
            void unarchiveSession(this.ctx, existing.sessionId, this.logger);
            // ★★ 2026-11-06（主人实测：重启后**第一个 step** 里 vote 仍 unknown）：
            //   这里的 `return existing` 是**早返回** —— 上一版只在新会话创建路径（末尾）await 了
            //   `mountChannelTools`，而重启后会话是从磁盘恢复的（走这条复用路径），
            //   于是彻底跳过了注册 ⇒ 第一个 step 又是空的。
            //   两条路径都要 await 加载完，才能保证"会话一存在，扩展就已注册"。
            try {
                if (existing.agentCtx) {
                    await mountChannelTools(existing.agentCtx, {
                        dataRoot: this.resolveDataRootSmart(),
                        config: this.config,
                        cwd: String(this.config.cwd ?? ''),
                        agent: existing.agent,
                    });
                }
            }
            catch { /* 加载失败不影响复用会话 */ }
            return existing;
        }
        // 2026-09-11 主人反馈「炸了的会话在 QQ 上没法弃号重开」: 磁盘会话损坏(历史加载失败)时
        // resume 必失败, 且 sessionId 是 sessionKey 确定性派生的(重试还是同一个坏档)。
        // forceNew → 先把本 peer 的 sessionId 轮换成全新随机 id(断开坏档, 旧档文件原样保留),
        // 后面走标准创建链: resume 命中不到 → 落到 create, 得到干净新档; 下次入站也 resume 新档。
        // ★ 2026-11-15：轮换前先把**旧 sessionId**记下来 —— 新档**建成功后**才归档它
        //   （CodeRabbit：原来在这里就归档，若后面 resume/create 全失败、startNewSession 返回 failed，
        //     旧档已经被藏起来了，而实际上没有任何新档取代它 ⇒ 得等创建成功再归档）
        const preRotate = String(this.currentSessionId(key) ?? '');
        if (opts?.forceNew) {
            const rotated = SessionId(randomUUID());
            try {
                this.modelResolver.setSessionId(key, rotated);
            }
            catch { /* ignore */ }
            try {
                this.modelResolver.setSessionCfg(key, { cwd: wantCwd });
            }
            catch { /* ignore */ }
            this.logger.info(`getOrCreate(forceNew): 弃档重开 key=${key} new=${rotated}`);
        }
        // 2026-09-11: 先定 sessionId, 再按「会话级」查模型路由 —— 新会话(sessionId 无 override)回落全局默认
        const sessionId = SessionId(this.currentSessionId(key));
        const route = this.modelResolver.getEffectiveRoute(key, sessionId);
        this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);
        let agent;
        let handle;
        let agentPreset;
        const live = this.agents.get(sessionId);
        if (live) {
            agent = live;
            this.logger.info(`reusing live agent: key=${key}`);
            // 2026-09-11 主人反馈修正: 「web 上改了模型, 重启后不应回退」。
            // live agent 通常带宿主/ web 设置的模型(会话持久化恢复) → **无 QQ override 时尊重它**,
            // 避免 QQ 默认路由(官方)把 web 设置覆盖回退。
            // 仅当 QQ 侧 /bot-model 明确设过 override 时, 才用 QQ 设置覆盖(QQ 优先, 双向持久)。
            if (this.modelResolver.hasOverride(key, sessionId)) {
                this.applyModelRoute(agent, route, 'live-override');
            }
        }
        else {
            // preset 只解析一次：resume/create 共用同一组合(会话覆盖 > config), 避免重复 resolve/mount 目录
            const composed = await this.composePreset(this.effectivePreset(key));
            agentPreset = composed.agentPreset;
            try {
                const resumeRoute = this.modelResolver.getResumeRoute(key, sessionId);
                const resumed = await this.agents.resume({
                    resumeSessionId: sessionId,
                    ...(resumeRoute ? { agentOptions: this.toAgentOptions(resumeRoute) } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = resumed.agent;
                handle = resumed;
                // ★ 2026-11-27：resume 沿用会话档案里记录的 header（那时还没写 reasoningEffort），
                //   agentOptions 只对**新建**会话生效 ⇒ 已存在的会话恢复出来仍是 thinking:disabled。
                //   这里显式再下发一次强度（实测：22:07–22:08 那批旧会话就是因此一直没有思考）。
                this.applyModelRoute(agent, resumeRoute ?? route, 'resume-effort');
                this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
                // 更新配置指纹(会话已存在且配置一致 → 指纹刷新为当前值)
                try {
                    this.modelResolver.setSessionCfg(key, { cwd: wantCwd });
                }
                catch { /* ignore */ }
            }
            catch (resumeErr) {
                // ★ 2026-10-26 修（外部作者 wuwo1979 用真机日志定位）：
                //   原来这里是**裸 catch** —— resume 的真实失败原因被吞掉，一行日志都不留，
                //   然后用**同一个 sessionId** 去 create。若该 id 在宿主 store 里已存在，
                //   create 抛 `session "xxx" already exists` → 冒到 inbound 的 catch → **整条消息消失**
                //   （他的 harness.log 里一天出现约 50 次）。
                //   改为：① 先把 resume 错误 warn 出来；② create 撞 already exists 时轮换 sessionId 再试一次。
                const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
                this.logger.warn(`resume 失败(改走 create): key=${key} sessionId=${sessionId} err=${resumeMsg}`);
                try {
                    const created = await this.agents.create({
                        sessionId,
                        meta: {
                            cwd: absCwdOf(this.config.cwd) || process.cwd(),
                            ...(agentPreset ? { agentPreset } : {}),
                        },
                        ...(route ? { agentOptions: this.toAgentOptions(route) } : {}),
                        ...(composed.setup ? { setup: composed.setup } : {}),
                    });
                    agent = created.agent;
                    // ★ 2026-11-27：agentOptions 之外再显式写一次强度（新宿主按 agent.model.select 走每轮下发）
                    this.applyModelRoute(agent, route, 'create-effort');
                    handle = created;
                    this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
                    // 记录配置指纹(create 用当前 cwd/preset; 下次配置变更据此弃旧开新)
                    try {
                        this.modelResolver.setSessionCfg(key, { cwd: wantCwd });
                    }
                    catch { /* ignore */ }
                }
                catch (createErr) {
                    const createMsg = createErr instanceof Error ? createErr.message : String(createErr);
                    // create 撞上"该 id 已存在" → 轮换一个新 id 重试一次（旧档文件原样保留，消息不再丢）
                    if (!/already exists/i.test(createMsg))
                        throw createErr;
                    const rotated = SessionId(randomUUID());
                    this.logger.warn(`create 撞已存在 → 轮换 sessionId 重试: ${sessionId} → ${rotated}`);
                    try {
                        this.modelResolver.setSessionId(key, rotated);
                    }
                    catch { /* ignore */ }
                    try {
                        this.modelResolver.setSessionCfg(key, { cwd: wantCwd });
                    }
                    catch { /* ignore */ }
                    const created2 = await this.agents.create({
                        sessionId: rotated,
                        meta: {
                            cwd: absCwdOf(this.config.cwd) || process.cwd(),
                            ...(agentPreset ? { agentPreset } : {}),
                        },
                        ...(route ? { agentOptions: this.toAgentOptions(route) } : {}),
                        ...(composed.setup ? { setup: composed.setup } : {}),
                    });
                    agent = created2.agent;
                    this.applyModelRoute(agent, route, 'create-effort');
                    handle = created2;
                    this.logger.info(`created new session(轮换后): key=${key} sessionId=${rotated} preset=${agentPreset ?? 'none'}`);
                    try {
                        this.modelResolver.setSessionCfg(key, { cwd: wantCwd });
                    }
                    catch { /* ignore */ }
                }
            }
        }
        // ★ 2026-11-15（CodeRabbit）：**新档确实建成功了，这时才归档旧档**。
        //   放在 forceNew 分支里原来是"先归档再创建"——若 resume/create 全失败，
        //   旧档已经被藏起来，而实际没有任何新档取代它。
        if (opts?.forceNew && preRotate && this.config.archiveOnNewSession !== false) {
            void archiveSessionDurably(this.ctx, preRotate, this.logger);
        }
        const record = {
            sessionKey: key,
            sessionId,
            agent,
            handle: handle ?? { agent, dispose: async () => { } },
            replyTarget,
            scope,
            peerId,
            senderId,
            lastActivity: Date.now(),
            agentPreset,
            // 自愈用：setup 若正常跑到 channelSetup，此处拿到 agent ctx 且标记已装载
            agentCtx: this.lastSetupCtx,
            channelToolsReady: this.lastSetupCtx?.[CTX_TOOLS_READY] === true,
        };
        this.lastSetupCtx = undefined;
        this.sessions.set(key, record);
        // 修复侧边栏归属(上游 PR #21 移植): 创建/恢复会话后挂到 cwd 对应工作区分组,
        // 防刷新后落 Ungrouped。幂等 + fail-soft(内部全吞), fire-and-forget 不阻塞主链。
        void attachSessionToWorkspaceWithRetry(this.ctx, this.config.cwd, sessionId, this.logger, {
            // 同上：以活动记录为准，不看 resolver 映射（会被 clearModelOverride 清掉）
            isStale: () => {
                const rec = this.sessions.get(key);
                if (!rec)
                    return true;
                return String(rec.sessionId ?? '') !== sessionId;
            },
        });
        // ★★ 2026-11-05（issue #39 问题 1 的**真正根治点**，主人追问"为什么非得在 QQ 里说话才注册"）：
        //   扩展工具的注册原来只挂在 `agent/inbox/claimed` 与 `agent/pre-step` 两个钩子上 ——
        //   它们都是**回合事件**。于是会话说"创建了、但没跑过回合"时（冷启动后的空闲会话），
        //   工具清单里空空如也；必须等一条入站消息跑完一个回合才恢复。
        //
        //   但注册所需的 `agentCtx` 在**会话创建完成时就已经有了**（`this.lastSetupCtx`），
        //   跟回合没有任何关系 ⇒ 这里就地注册一次，让"会话存在"就等于"工具就绪"。
        //   幂等：`applyExtToolVisibility` 内部有签名比对，重复调用是零动作。
        try {
            const selfTag0 = instanceTagOfManager(this);
            if (selfTag0)
                applyExtToolVisibility(record.agentCtx, selfTag0);
            // ★★ 2026-11-06（主人实测：第一个 step 里 vote 仍 unknown，第二个 step 才有）：
            //   `mountChannelTools` 是 **async**（要 await loadExtensionTools 动态 import 每个 .mjs），
            //   而宿主时序是 claim → **assemble（拍工具表快照）** → pre-step。
            //   之前各处都是 `void mountChannelTools(...)`（不等待）⇒ 扩展还没加载完，
            //   快照已经拍好了 ⇒ **本回合第一个 step 看不到**，要等下一个 step 重新组包才出现。
            //   这里在会话创建（async 上下文）里**真的 await**，让"会话建好"就等于"扩展已注册完"。
            if (record.agentCtx) {
                await mountChannelTools(record.agentCtx, {
                    dataRoot: this.resolveDataRootSmart(),
                    cwd: String(this.config.cwd ?? ''),
                    agent: record.agent,
                    // ★ 审核 P0-3：漏了这个 ⇒ 新建会话时 opts.config 是 undefined
                    //   ⇒ toolVisible 三个分支全 miss ⇒ 32 个工具（含 10 个群治理）全部重新注册。
                    //   这条路径是「每个新会话」的必经之路，不是边角。
                    config: this.config,
                });
            }
            // ★★ 2026-11-25（/bot-new 之后 context_* 三件套消失、重启才好）：mountChannelTools 只挂内置工具，
            //   不碰 context_compact/drop/memo —— 那三个原先只在 agent/inbox/claimed 注册，
            //   而"建会话"不是消息 claim ⇒ 事件不触发 ⇒ 工具永远不挂到重启。这里同点位补一次。
            try {
                this.syncScopedToolsOnClaim(record.agent);
            }
            catch { /* 失败不影响建会话 */ }
        }
        catch { /* 注册失败不影响建会话 */ }
        return record;
    }
    /**
     * 2026-09-11: 把 QQ 侧 override 路由应用到 agent.options。
     * 仅当 QQ 侧 /bot-model 明确设过 override 时调用(QQ 设置优先, 持久生效);
     * 无 override 时**不覆盖** —— 尊重宿主/ web 设置的模型(重启后不回退)。
     */
    /**
     * 给一个活的 agent 应用模型路由。
     *
     * ★★ 2026-10-31（对照 DSH v0.2.1-alpha.4 起的官方升级指南 `session-model-selection`）：
     *   新宿主把"选模型"做成了 agent 上**受控的引用** `agent.model`（`ModelSelectionRef`）：
     *     · `current`   —— 下一步进 prompt 组装时用的选择
     *     · `assembled` —— 本步已快照的选择
     *   宿主通过 `installModelSelection()` 挂 `system-prompt/assemble` / `agent/request` /
     *   `agent/pre-step` 三个监听器，用这两个字段决定真正的 provider/model。
     *   而 `agent/request` **不再允许插件改路由** —— 也就是说直接改 `agent.options` 在
     *   新宿主上会**静默失效**（用户以为切了模型，其实还是旧的）。
     *
     * 所以这里按能力分三级降级，新旧宿主都能跑：
     *   ① 有 `agent.model.current`（新宿主）→ 写它（走宿主受控通道）
     *   ② 否则有 `agent.options`（旧宿主）→ 维持原行为，直接改 options
     *   ③ 都没有 → 记一条 warn，别静默
     */
    /**
     * **反向同步**：宿主界面（输入框右下角）切了模型后，把 QQ 侧偏好也改成那个。
     *
     * 2026-11-08 主人要求：「一旦发生当前会话切换模型的事件，model-prefs.json 也跟着变」。
     * 宿主**没有**现成的"模型已切换"事件可订阅（只有每轮的 `request/header` 事件），
     * 所以这里在每轮第一步做一次**极轻的比较**：读 `agent.model.current()`，
     * 与偏好里存的（或当前路由）不一致 ⇒ 说明是用户刚在界面上切的，采纳它。
     *
     * @returns 是否发生了采纳（用于日志）
     */
    /**
     * 「上一次看到的宿主模型选择」——用来判断**宿主是否真的变了**。
     *
     * 2026-11-08 主人点破的关键：QQ 侧写偏好 + 宿主侧 pre-step 采纳，这两条路会**互相覆盖**。
     * 单靠"和偏好比"不够：我们刚把偏好写成 high、宿主还没生效（或反过来），就会来回打。
     * 加这个哨兵后规则变成：**只有宿主的当前选择与上次看到的不同，才采纳** ——
     * 宿主没动过就绝不回写偏好评，天然打断拉锯。
     */
    lastHostModel = new Map();
    adoptHostModel(scope, peerId, agent) {
        try {
            const a = agent;
            const cur = a?.model && typeof a.model.current === 'function'
                ? a.model.current()
                : undefined;
            if (!cur?.provider || !cur?.model)
                return false;
            // ⚠️ 必须和**偏好文件里存的**比，不能和 getEffectiveModel() 比 ——
            //   后者自己就会读 model.current()，两边永远相等 ⇒ 永远不采纳（第一版就这么写错的）。
            const key = this.sessionKey(scope, peerId);
            const rec = this.sessions.get(key);
            const sid = rec?.sessionId ?? this.currentSessionId(key);
            const stored = this.modelResolver.getEffectiveRoute(key, sid);
            const hostEffort = typeof cur.reasoningEffort === 'string' ? cur.reasoningEffort : undefined;
            // ★ 只认"宿主变了"：与上次看到的一致 → 说明不是用户在界面上切的，直接不动（防拉锯）
            const hostKey = `${cur.provider}/${cur.model}/${hostEffort ?? ''}`;
            const lastSeen = this.lastHostModel.get(key);
            if (lastSeen === hostKey)
                return false;
            this.lastHostModel.set(key, hostKey);
            const sameRoute = !!stored && stored.provider === cur.provider && stored.model === cur.model;
            const effectiveEffort = hostEffort ?? stored?.effort ?? DEFAULT_REASONING_EFFORT;
            const sameEffort = (stored?.effort ?? '') === effectiveEffort;
            if (sameRoute && sameEffort)
                return false;
            const route = {
                provider: cur.provider,
                model: cur.model,
                // ★ 2026-11-27 修：宿主**没带**思考强度时，不能把已存的强度抹掉 ——
                //   原来这里写成 ...(hostEffort ? { effort: hostEffort } : {})，于是 model-prefs.json 里
                //   手工写好的 effort=medium 会被宿主的一次无档位选择清空，下一轮又是 thinking:disabled。
                effort: effectiveEffort,
            };
            // 直接写偏好：**不能走 setModelOverride** —— 它现在"同模型同强度就 return"（防白 fork），
            //   而这里正是要把宿主的新值落盘（含 effort 变化），所以绕过去，只写存储。
            this.modelResolver.setOverride(key, sid, route);
            this.logger.info(`[model-sync] 采纳宿主界面选择: ${cur.provider}/${cur.model}${hostEffort ? ` effort=${hostEffort}` : ''}`
                + `（原: ${stored ? `${stored.provider}/${stored.model}${stored.effort ? ` effort=${stored.effort}` : ''}` : '无'}）`);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 把内部模型路由转成宿主认识的 agentOptions。
     *
     * 宿主的 agentOptions 只有 provider/model/reasoningEffort 三个字段（见 dsh-api-session-controller 的
     * agentOptions()）。原来这里把内部路由 `{ provider, model, effort }` 直接当 agentOptions 传，
     * effort 被宿主丢掉 ⇒ 宿主按"没开思考"建会话，第一轮 body 就是 thinking:{type:'disabled'}。
     * 本地 27B 在无思考档位时会把 reply_gate 当成"开口开关"连传 reply:false，整轮被 hook 取消，
     * 用户看到的是满屏 tool call aborted 且一个字不回（2026-11-27 实测）。缺档时补默认档。
     */
    toAgentOptions(route) {
        return {
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.effort ?? DEFAULT_REASONING_EFFORT,
        };
    }
    applyModelRoute(agent, route, label) {
        if (!route)
            return;
        const a = agent;
        // ① 新宿主：AgentModel 实例（**方法**，不是属性！）
        //   ⚠️⚠️ 2026-11-03 事故：之前写成 `ref.current = {...}` —— 而 `current` 是个**方法**
        //   （`current(): ModelSelection | undefined`），把它覆盖成普通对象之后，
        //   宿主每轮调 `this.model.current()` 就炸：`this.model.current is not a function`，
        //   整个会话「本轮运行失败」。正确用法是 `current()` 读 + `select(sel)` 写。
        try {
            const m = a.model;
            if (m && typeof m.current === 'function' && typeof m.select === 'function') {
                const cur = m.current();
                // ★ 2026-11-08 修：这里原来只看 provider/model —— 同模型只改**思考强度**时直接 return，
                //   强度根本没写进宿主 ⇒ 下一轮 adoptHostModel 又按宿主的旧强度把偏好改回去（主人实测：切 high 又变回 low）。
                const effectiveEffort = route.effort ?? DEFAULT_REASONING_EFFORT;
                const sameEffort = (cur?.reasoningEffort ?? '') === effectiveEffort;
                if (cur?.provider === route.provider && cur?.model === route.model && sameEffort)
                    return;
                // 保留宿主可能存在的其它字段（reasoningEffort 等），只换 provider/model
                // 2026-11-08：模型路由里带思考强度就一起写进去（宿主 ModelSelection 支持 reasoningEffort）
                m.select({
                    ...(cur ?? {}),
                    provider: route.provider,
                    model: route.model,
                    reasoningEffort: effectiveEffort,
                });
                this.logger.info(`getOrCreate: ${label} 模型覆盖(agent.model.select) ${cur?.provider ?? '?'}/${cur?.model ?? '?'} -> ${route.provider}/${route.model}`);
                return;
            }
        }
        catch (err) {
            this.logger.warn(`getOrCreate: ${label} agent.model 选择失败，回落 options: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ② 旧宿主：直接改 options（原行为）
        const liveOpts = a.options;
        if (!liveOpts) {
            // ③ 两条路都没有 —— 别静默：这类失败在用户侧表现为"切了没反应"，极难排查
            this.logger.warn(`getOrCreate: ${label} 无法应用模型路由（agent 既无 model 也无 options）: ${route.provider}/${route.model}`);
            return;
        }
        if (liveOpts.provider !== route.provider || liveOpts.model !== route.model) {
            agent.options = {
                ...liveOpts,
                provider: route.provider,
                model: route.model,
            };
            this.logger.info(`getOrCreate: ${label} 模型覆盖(options) ${liveOpts.provider}/${liveOpts.model} -> ${route.provider}/${route.model}`);
        }
    }
    /**
     * 通道工具自愈 + 固化(2026-09-05 升级): 每次消息都全量幂等注册 channel-tools(静态 import,
     * 进程加载的就是最新 dist) → 重启后"恢复"会话的第一条消息也会自动把 reply_gate 等正式工具
     * 全部注册上,**工具永久固化, 重启不再需要 /tools-reload**(热刷只留给进程内"新增"工具的即时生效)。
     * 已注册工具重复注册会被 channel-tools 内部静默跳过(already registered), 无副作用无噪音。
     */
    async ensureChannelTools(record) {
        if (!this.channelSender)
            return;
        const agentCtx = (record.agent?.ctx ?? record.agentCtx);
        if (!agentCtx) {
            diagSm('ensureChannelTools: 跳过(无 agentCtx, setup 未执行到)');
            return;
        }
        try {
            await mountChannelTools(agentCtx, { dataRoot: this.resolveDataRootSmart(), cwd: String(this.config.cwd ?? ''), config: this.config });
            agentCtx[CTX_TOOLS_READY] = true;
            record.channelToolsReady = true;
            diagSm('ensureChannelTools: 全量幂等注册完成');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn?.(`im-qqbot: 工具自愈注册失败: ${msg}`);
            diagSm(`ensureChannelTools: 失败 ${msg}`);
        }
    }
    /**
     * 工具热刷新(2026-09-05, 主人定 A 方案): cache-bust 动态重载最新 dist 的 channel-tools
     * 并注册到给定 agentCtx。DSH 工具表每步现收集 → 新工具**下一轮立即对 LLM 可见**, 无需重启宿主。
     * 说明: 新增工具即时生效; 与已有工具同名的注册会被 channel-tools 内部 try/catch 跳过(保留旧实现),
     *       想更新已有工具逻辑仍需正式重启(或临时换新工具名)。
     */
    /**
     * qqChannel 上下文自愈(2026-09-05): 重启后"恢复"的会话不跑 setup → agent.ctx 上没有
     * qqChannel → 通道工具路由不到本实例(channelOf 失败 → 图库/定时落到别的实例或 C 盘幽灵库)。
     * 每次消息补一次 provide(幂等: 已是本实例就跳过)。用 record.agent.ctx(恒有)。
     */
    async ensureChannelContext(record) {
        try {
            const agentCtx = record.agent?.ctx ?? record.agentCtx;
            if (!agentCtx || !this.channelSender)
                return;
            const anyCtx = agentCtx;
            const existing = anyCtx.get?.('qqChannel');
            if (existing && existing.manager === this)
                return; // 已是本实例
            anyCtx.provide?.('qqChannel', { manager: this, sender: this.channelSender });
            this.logger.info('im-qqbot: qqChannel 上下文自愈 provide(本实例)');
            diagSm('ensureChannelContext: provide qqChannel(本实例)');
        }
        catch (err) {
            diagSm(`ensureChannelContext: 失败 ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async hotReloadChannelTools(agentCtx) {
        const url = new URL('../channel-tools.js', import.meta.url);
        // 2026-09-15 修复内存泄漏: 原用 hot=Date.now() 每次生成全新 URL,
        // channel-tools 及其整条依赖链会永久留在 ESM 模块注册表(强引用, 永不 GC)。
        // 改为按文件 mtime: dist 未更新 → URL 不变 → 复用缓存模块; 升级后 mtime 变化自动加载新代码。
        let hotVer = '';
        try {
            hotVer = String(Math.floor(statSync(fileURLToPath(url)).mtimeMs));
        }
        catch {
            hotVer = String(Date.now());
        }
        url.searchParams.set('hot', hotVer);
        const mod = (await import(url.href));
        const applyFn = (mod.apply ?? mountChannelTools);
        await applyFn(agentCtx, { dataRoot: this.resolveDataRootSmart(), cwd: String(this.config.cwd ?? ''), config: this.config });
        this.logger.info('im-qqbot: 通道工具热刷新完成(新工具已注册到 agentCtx)');
        diagSm('hotReloadChannelTools: 完成');
    }
    /** 对所有活会话的 agentCtx 执行一次工具热刷新。返回给人看的摘要文本。 */
    async reloadAllChannelTools() {
        const seen = new Set();
        const targets = [];
        for (const rec of this.sessions.values()) {
            const agentCtx = (rec.agent?.ctx ?? rec.agentCtx);
            if (agentCtx && !seen.has(agentCtx)) {
                seen.add(agentCtx);
                targets.push(agentCtx);
            }
        }
        // 2026-10-12 主人定：命令表也要一起热重载（此前扩展命令改了必须重启插件才生效）。
        //   放在"有没有活动会话"判断**之前** —— 没有任何会话时，命令照样能刷。
        // ★ 2026-10-27：传本实例的 dataRoot —— 否则会刷到别的实例的命令表
        const cmdLine = describeExtCommandReload(await reloadExtCommands(this.dataRoot));
        // 2026-10-12 追加：入站中间件扩展（`.qqbot-extensions/inbound/*.mjs`）同一时机一起重扫。
        //   挂载点是个"现读可变列表"的代理，重扫只是换内容 ⇒ **不重启即生效**，不用另加一条热刷入口。
        const inboundLine = describeExtInboundReload(await reloadExtInbound());
        // 2026-10-16 追加：**出站**中间件扩展（`.qqbot-extensions/outbound/*.mjs`）同一时机一起重扫。
        //   链读的是模块级 `loaded` 列表 ⇒ 重扫只是换内容，**不重启即生效**，不用另加热刷入口。
        const outboundLine = describeExtOutboundReload(await reloadExtOutbound());
        const extLines = `${cmdLine}\n${inboundLine}\n${outboundLine}`;
        if (targets.length === 0) {
            return `当前没有活动会话可热刷(先随便发条消息让会话跑起来, 再试 /tools-reload)\n${extLines}`;
        }
        let ok = 0;
        let fail = 0;
        for (const c of targets) {
            try {
                await this.hotReloadChannelTools(c);
                ok++;
            }
            catch (err) {
                fail++;
                this.logger.warn?.(`im-qqbot: 热刷新失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return `✅ 工具热刷新完成: ${ok} 个会话成功${fail > 0 ? `, ${fail} 个失败(见日志)` : ''}。新工具下一条消息即可用。\n${extLines}`;
    }
    /** 数据根（pre-step 与 inbox/claimed 共用一份算法 —— 差一级就会一处写、一处读）。 */
    resolveDataRootSmart() {
        const direct = String(this.config.dataRoot ?? '').trim();
        if (direct)
            return direct;
        try {
            const storeFile = describeStorePath(); // {dataRoot}/.qqbot/contextless.json
            const m = /^(.*)[\\/]\.qqbot[\\/][^\\/]+$/.exec(String(storeFile ?? ''));
            if (m && m[1])
                return m[1];
        }
        catch { /* ignore */ }
        return String(this.config.cwd ?? '');
    }
    /**
     * ★ 2026-10-28：把「按会话注册 4 个工具」提前到**回合开始**。
     *
     * 主人实测：关掉无上下文模式后，回合**第一个 step** 模型仍拿到旧工具表 → 调 context_memo 报
     * `unknown tool`，之后才出现「工具已更新·移除 3 个」。根因是宿主的 step 顺序（dsh-agent-loop
     * lib/index.js 的 preStep）：
     *   ① inbox.claim()             ← emit 'agent/inbox/claimed'（**同步**派发，payload 自带 agent）
     *   ② systemPrompt.assemble()   ← 工具表在这里**快照**
     *   ③ dispatch.waterfall('agent/pre-step') ← 我们原来在这里注册 ⇒ 晚了一步
     * ⇒ 在 claimed 时同步一次注册表，本 step 的请求就能用上新表；
     *   pre-step 里那次照旧保留（turn 内中途改开关 / 会话 key 反查失败时的兜底）。
     * ⚠️ 只做同步动作（emit 不 await 监听器）；任何异常静默，绝不能影响入站主链。
     */
    syncScopedToolsOnClaim(agent) {
        const a = agent;
        if (!a) {
            traceContextless('[ctxtool-claim] skip: agent 为空');
            return;
        }
        // 只碰本实例的 agent（cwd 分流：别的 bot 实例的会话工具集不归我们管）
        const cwdC0 = String(a.session?.header?.cwd ?? '');
        if (!this.nsForCwd(cwdC0)) {
            traceContextless('[ctxtool-claim] skip: cwd 不属本实例 cwd=' + cwdC0);
            return;
        }
        const rec = this.findByAgent(agent);
        // ★ CodeRabbit 2026-11-25（Major）：**当前 agent 的 ctx 优先**。
        //   forkCurrentSession 换了 record.agent / record.handle，但**没换 record.agentCtx** ——
        //   原来这段优先读 rec.agentCtx ⇒ 工具全注册到**已被替换的旧上下文**上，新 agent 看不到。
        //   顺序与同文件里其它几处（a.ctx 优先）保持一致；没有 ctx 的 agent 仍回退 rec.agentCtx。
        const ctxOfTool = a.ctx ?? rec?.agentCtx;
        if (!ctxOfTool) {
            traceContextless('[ctxtool-claim] skip: 拿不到 agentCtx/agent.ctx rec=' + String(Boolean(rec)));
            return;
        }
        let sk = String(rec?.sessionKey ?? '').trim();
        if (!sk) {
            const sid = String(a.session?.id ?? '');
            if (sid)
                sk = String(this.findBySessionId(sid)?.sessionKey ?? '');
            // ★ CodeRabbit 2026-11-25（Major）：宿主**恢复**出来的 QQ 会话（resumeHostAgent 走
            //   agents.resume，不写 this.sessions）在 findByAgent / findBySessionId 眼里都不存在
            //   ⇒ 这里曾直接跳过注册。持久化的 sessionId→sessionKey 映射（model-prefs）是唯一兜底。
            if (!sk && sid)
                sk = this.sessionKeyOfSession(sid);
        }
        if (!sk) {
            traceContextless('[ctxtool-claim] skip: 拿不到 sessionKey rec=' + String(Boolean(rec)) + ' sid=' + String(a.session?.id ?? ''));
            return;
        } // 未知 = 不动
        const smart = isContextlessActive(sk, this.config.contextlessMode)
            && contextlessSmartOf(sk, this.config.contextlessSmart);
        syncChannelScopedTools(ctxOfTool, {
            ctxTools: smart,
            groupAdmin: this.config.groupAdmin?.enabled === true,
            config: this.config,
            dataRoot: this.resolveDataRootSmart(),
            sessionKey: sk,
        });
        traceContextless('[ctxtool-claim] 回合开始同步 ctx=' + String(smart) + ' sk=' + sk);
    }
    /** cwd 分流(通用, 不写死实例名): 只对本实例配置的 cwd 匹配的 agent 注入本实例群守则。
     *  每个实例在 patch 里配自己的 cwd + settingsNs, 即自动分流;
     *  其他实例/项目(web、别的 cwd)的 agent 一律不注入, 避免群守则污染非本 bot 会话。 */
    nsForCwd(cwd) {
        // ★ CodeRabbit 2026-11-25：会话 header.cwd 是 absCwdOf() 写进去的，配置侧也必须用同一规则
        //   —— 否则配置为相对路径（如 storage/emulated/0/bot）时两侧永远不相等，本实例的会话被误判成别人的，
        //   工具静默不注册。配置为绝对路径时 absCwdOf 原样返回，行为不变。
        const selfCwd = String(absCwdOf(this.config.cwd) ?? '').trim().replace(/[\/]+$/, '');
        const ns = String(this.config.settingsNs ?? '').trim() || 'im-qqbot';
        if (!selfCwd)
            return ns; // 未配 cwd → 对本实例所有 agent 注入(保守)
        const norm = String(cwd ?? '').replace(/[\/]+$/, '');
        if (norm === selfCwd || norm.startsWith(selfCwd + '/') || norm.startsWith(selfCwd + '\\'))
            return ns;
        return '';
    }
    /** 群守则热更新: 现读 settings.yaml 对应 ns 的 groupPrompt; 读失败仅回退本实例 ns 的内存 config。 */
    readLiveGroupPromptForNs(ns) {
        try {
            const reader = (this.liveSettingsReader ??= new SettingsReader());
            const gp = reader.readGroupPrompt(ns, true);
            if (gp)
                return gp;
        }
        catch { /* 读失败回退内存 */ }
        const selfNs = String(this.config.settingsNs ?? '').trim() || 'im-qqbot';
        return ns === selfNs ? (this.config.groupPrompt?.trim() || '') : '';
    }
    /**
     * 群守则/固定规则 pre-step 直注(幂等): 每次消息入站调用, 全局只装一次注入器。
     *
     * 2026-09-11 考古定稿(参考 deepseek-harness/packages/context/agent-instructions):
     *  - dsh 0.1.5 的 persona 是 complete section → assemble 只保留 persona,
     *    运行时注册的 section 全被丢弃(system/message 只有人设, 实证);
     *  - context() 快照链路(assemble → RuntimeContextProjection.project)实际不记录;
     *  - 官方 agent-instructions 用 ctx.on('agent/pre-step') 把带来源 user/message
     *    折入 decision.messages(紧随 claimed batch 之后) → 直接进模型请求, 绕开 assemble。
     *
     * 本实现:
     *  - 宿主根 ctx 监听 agent/pre-step; cwd 分流(只对本实例 config.cwd 匹配的 agent 注入本实例群守则);
     *  - 每回合现读 settings.yaml(热更新); 固定通道规则 + 群守则 拼成一条 <system-reminder> user/message;
     *  - 去重靠 KV cache: 本次 messages 或会话 surface 已有同 ns+同内容 → 不重复注入;
     *    热更新内容变化 → 注入新版(历史保留旧版, 后续回合靠新版 KV cache)。
     */
    async ensureGroupRules(_record) {
        // issue #64: cordis ≥ 4.0.0-rc.12 移除了 ctx.root，读它直接抛错；
        // 原来这处被 `?.catch?.(()=>{})` 吞掉 ⇒ 群守则/工具表注入**静默失效**。统一走 rootOf()。
        const hostCtx = rootOf(this.ctx);
        if (!hostCtx?.on || this.__rulesMounted)
            return;
        this.__rulesMounted = true;
        // ★ 2026-10-28：**回合开始前的工具表同步点**。宿主顺序是 claim → assemble（快照工具表）→ pre-step，
        //   所以只在 pre-step 里注册会晚一步（实测：开关关掉后第一个 step 仍拿到旧工具表，调用报 unknown tool）。
        //   claimed 是**同步**派发且 payload 自带 agent ⇒ 在这里同步注册表，本 step 立刻生效。
        // ★★ 2026-11-06（主人："别只在启动时判，任何开启会话的消息也该直接注册——自动化就是这样"）：
        //   `agent/created` 是**所有会话诞生的唯一收敛点** —— QQ 消息建会话、web 界面点开旧会话、
        //   宿主恢复、子代理派生…… 都会经过它。在这里注册一次，就把「会话存在 ⇒ 工具就绪」
        //   从"只覆盖插件自己建的会话"扩到"任何途径出现的会话"。
        //   注意：此时 agent 的 setup 可能还没完全跑完，`agent.ctx` 也许拿不到 tools 服务 ——
        //   `applyExtToolVisibility` 内部 fail-soft，失败不要紧：下面的 claimed / pre-step 仍会兜底重试。
        hostCtx.on('agent/created', (payload) => {
            try {
                const ag = payload?.agent;
                if (!ag)
                    return;
                // cwd 分流：只给"属于本实例工作区"的 agent 注册（web 普通会话拿空 tag ⇒ 不注册，零泄漏）
                const cwdC = String(ag.session?.header?.cwd ?? '');
                if (!this.nsForCwd(cwdC))
                    return;
                const tagC = instanceTagOfManager(this);
                // ★ 2026-11-06：内置工具（mountChannelTools）也在这里注册一次 —— 与扩展工具同待遇。
                //   幂等：重名 already registered 被内部静默跳过，和 inbound / claimed 两条路不冲突。
                // ★★ 2026-11-06（主人实测：resource_lookup 突然调不到）：
                //   **这里不再调 `mountChannelTools`**。
                //   原因：agent/created 阶段 `ctx.get('qqChannel')` 往往还没注入，于是 `extRoot`
                //   一路回退到 `channelBridges[最后一个]` → **别的实例的数据根**（实测是「测试客户端」），
                //   而那边根本没有 resource_lookup.mjs ⇒ 加载的是错误的一批，
                //   还和 claimed / inbound 那条**正确**的路径在同一 ctx 上互相覆盖。
                //   现在本钩子只负责**扩展工具**（纯内存操作，不碰磁盘扫描，安全）；
                //   内置工具（含 .mjs 加载）统一交给 claimed + inbound —— 那两条能拿到正确 ctx。
                if (!tagC)
                    return;
                applyExtToolVisibility(ag.ctx, tagC);
                // ★★ 2026-11-25：任何途径诞生的会话都该工具就绪 —— 这里也补一次 context_* 注册（幂等）。
                try {
                    this.syncScopedToolsOnClaim(ag);
                }
                catch { /* ignore */ }
            }
            catch { /* 注册失败不影响建 agent */ }
        });
        hostCtx.on('agent/inbox/claimed', (payload) => {
            const agent0 = payload?.agent;
            // ★ 2026-10-28（主人抓到）：扩展工具的注册 + 剪枝也放这里 —— 宿主是
            //   claim → assemble(工具表快照) → pre-step，放在 pre-step 会**晚一个 step**
            //   （现象：自己的工具"新增了一个 step，下个 step 又移除"）。
            // 兜底（主路径已挪到 agent/inbox/claimed；这里只防 claimed 未触发的极端情况）
            try {
                ensureExtToolsGlobal(this.ctx);
            }
            catch { /* ignore */ }
            try {
                // ★★ 2026-10-31（主人实测：关掉三号后，连二号自己的工具也没了）——
                //   判断"这个 agent 归不归本实例"不能只看 `findByAgent` 是否命中（对象引用/时序不同就可能失手，
                //   于是 tag 成空 ⇒ 本应注册的也被跳过 ⇒ 自己的工具消失）。
                //   统一用 `nsForCwd(session.header.cwd)` 做 cwd 分流（与 syncScopedToolsOnClaim 同一口径）：
                //     · cwd 落在本实例 cwd 下 → 本实例的 QQ 会话 ⇒ 用本实例 tag 注册自己的工具
                //     · 否则（web 普通会话等）  → tag 留空 ⇒ applyExtToolVisibility 不注册（零泄漏）
                const a0 = agent0;
                const cwd0 = String(a0?.session?.header?.cwd ?? '');
                let selfTag0 = '';
                if (this.nsForCwd(cwd0)) {
                    try {
                        const rec0 = this.findByAgent(agent0);
                        const mgr0 = rec0?.ch?.manager;
                        selfTag0 = mgr0 ? instanceTagOfManager(mgr0) : String(this.config.preset ?? '').trim();
                    }
                    catch {
                        selfTag0 = String(this.config.preset ?? '').trim();
                    }
                }
                applyExtToolVisibility(agent0?.ctx, selfTag0);
            }
            catch { /* ignore */ }
            try {
                this.syncScopedToolsOnClaim(agent0);
            }
            catch { /* ignore */ }
            // ★★ 2026-11-06（主人："web 回合拿不到 outbound_mode 等内置工具，不利于自动化"）：
            //   内置工具（toolDefs：outbound_mode / reply_gate / send_media / quote_view / group_* …）
            //   原来**只有** `inbound.ts:368` 的 `ensureChannelTools(record)` 一个注册点 ——
            //   也就是"必须有一条 QQ 消息入站"才会注册。
            //   而它们和扩展工具一样是 per-agent 的（`mountChannelTools(agentCtx)`）⇒
            //   web/桌面发起的回合、其它自动化注入的回合，全都看不到这批工具。
            //   这里在 claimed（早于 assemble 快照）补一次：mountChannelTools 内部是幂等的
            //   （重名 already registered 静默跳过），所以和 inbound 那条路不冲突。
            try {
                const agC = agent0;
                const cwdC = String(agent0?.session?.header?.cwd ?? '');
                // ★ 2026-11-06（重启后 send_media 仍报「未找到当前 QQ 会话(通道未就绪)」）：
                //   关键是**用哪个 ctx 注册**。`qqChannel` 服务是插件在 setup 阶段注入到
                //   **record.agentCtx** 上的；拿 `agent.ctx` 去 `ctx.get('qqChannel')` 很可能取不到
                //   ⇒ 工具虽在，执行时 `findSessionRec` 找不到通道 ⇒ 「通道未就绪」。
                //   所以优先用 record.agentCtx（与 inbound 老路完全一致），拿不到才回退 agent.ctx。
                const recC = this.findByAgent(agent0);
                // ★★ 2026-11-06（主人实测：好几个回合了 vote 还是 unknown）：
                //   **必须注册到 `agent0.ctx`（当前回合 agent 的作用域）**，而不是 record.agentCtx。
                //   因为工具表是按**当前 agent 的 ctx** 组装的：注册到 record 那个旧对象上，
                //   本回合的 agent 根本看不到（web/桌面回合尤其如此 —— 宿主会新建 agent 对象）。
                //   之前为了"能拿到 qqChannel"改用了 record.agentCtx，结果注册成功但用不了。
                //   正解：注册到当前 ctx + **显式传 dataRoot**（qqChannel 解析有兜底，靠 dataRoot 就够了）；
                //   record.agentCtx 那份也顺手注册一遍，覆盖"同一 agent 复用"的场景。
                const ctxC = agC?.ctx;
                if (ctxC && this.nsForCwd(cwdC)) {
                    setCtxEnv(ctxC, { dataRoot: this.resolveDataRootSmart(), sessionKey: String(recC?.sessionKey ?? '') });
                    // 当前回合作用域：这是本回合快照会读的那份，必须同步完成（await 不行，这里是同步派发）
                    void mountChannelTools(ctxC, { dataRoot: this.resolveDataRootSmart(), cwd: String(this.config.cwd ?? ''), config: this.config });
                    if (recC?.agentCtx && recC.agentCtx !== ctxC) {
                        void mountChannelTools(recC.agentCtx, { dataRoot: this.resolveDataRootSmart(), cwd: String(this.config.cwd ?? ''), config: this.config });
                    }
                }
            }
            catch { /* ignore */ }
        });
        hostCtx.on('agent/pre-step', async (payload, next) => {
            // ★ 2026-10-10 主人要的"暴露给全部会话"：把 expose:'all' 的扩展工具挂到**插件根作用域**。
            //   ⚠️ 必须放在**最外层、无条件**执行 —— 它跟"无上下文模式"无关，任何会话的每一步都该保证注册到位。
            //   （人家最初把它塞进了下面的条件分支 ⇒ 条件不满足就永不执行 ⇒ 工具谁都看不到，连自己都看不见。）
            //   函数内部：15s 节流 + 幂等（已注册的 name@tag 直接跳过）+ fail-soft（出错静默）。
            //   2026-10-31：把当前 agent ctx 传进去 —— 扫描末尾会在**同一轮**跑 apply 剪枝，避免"先新增又移除"。
            try {
                ensureExtToolsGlobal(this.ctx);
            }
            catch { /* ignore */ }
            // ★ 2026-10-28：扩展工具按会话注册 —— 每个会话按「自己实例 + 已领取」注册一遍。
            //   ⚠️ 2026-10-31 修（主人实测：非 QQ 会话又能看到 expose:'all' 工具了）：
            //      `findByAgent` **没命中**（= 这个 agent 不属于本 QQ 实例，例如 web 里的普通会话）时，
            //      以前会兜底成 `this.config.preset`（本实例的 tag）⇒ 于是给**非 QQ agent**
            //      注册了 whale-girl 的工具 ⇒ 泄漏。现在：拿不到 tag 就传空，applyExtToolVisibility
            //      见到空 tag 直接不注册（非 QQ 会话零扩展工具）。
            try {
                // 与 claimed 同一口径：用 cwd 分流判断"归不归本实例"，拿不到就传空（不注册）。
                const agentP = payload?.agent;
                const aP = agentP;
                const cwdP = String(aP?.session?.header?.cwd ?? '');
                let selfTagP = '';
                if (this.nsForCwd(cwdP)) {
                    try {
                        const recP = agentP ? this.findByAgent(agentP) : undefined;
                        selfTagP = recP?.ch?.manager ? instanceTagOfManager(recP.ch.manager) : String(this.config.preset ?? '').trim();
                    }
                    catch {
                        selfTagP = String(this.config.preset ?? '').trim();
                    }
                }
                applyExtToolVisibility(agentP?.ctx, selfTagP);
            }
            catch { /* ignore */ }
            // ★ 2026-10-28：原来这里对**每个会话**无条件 `restrictContextTools(ctx, false)` 兜底 deny
            //   （全局注册时代的补救）。现在那四个工具改成**按 QQ 会话注册**了 ——
            //   非 QQ 会话天生看不到，也就不需要这条 deny；再调 restrain 反而会报
            //   "names unknown global tools"（全局层已经没有它们了）。整段删除。
            // ctxSmartOn 提到回调最外层（固定 trim 让位 + 后面的消费/注入都要用）
            let ctxSmartOn = false;
            // ⚠️ 2026-10-09：同一 pre-step 里有两个 try 块，后面"动态挂/卸三个上下文工具"那块
            //   需要本会话的 sessionKey 做反查兜底 —— 而 sk0 只活在前一个 try 块内，故这里提到外层存一份
            //   （反查不到就保持空串，调用方按"未知 = 不动"处理，绝不因为读不到而卸工具）。
            let skForTool = '';
            const _isCtxSmartMsg = (m) => {
                try {
                    const src = m?.source;
                    return src?.kind === 'qqbot:ctx-smart';
                }
                catch {
                    return false;
                }
            };
            const _stripOldCtxSmart = (arr) => arr.filter((m) => !_isCtxSmartMsg(m));
            const decision = await next();
            try {
                const p = payload;
                const agent = p?.agent;
                // ⚠️ 当前轮次号（compaction 事件必须与它一致，见 contextless-trim 的 turn 参数注释）
                const currentTurn = Number(p?.turn);
                // ⚠️ 2026-09-27：agent/pre-step 是【每个 step】都触发的！人家原来无条件压缩，
                //   结果一个回合里"思考→工具→再思考"会连压好几次（主人截图：一段里三条"上下文已压缩"）。
                //   这里只在【回合的第一个 step】做，与"回合开始前压缩一次"的预期一致。
                const currentStep = Number(p?.step);
                const cwd = String(agent?.session?.header?.cwd ?? '');
                const ns = this.nsForCwd(cwd);
                if (!ns)
                    return decision; // 非本 bot agent, 不注入
                const dec = decision;
                // ★ 2026-10-10：本步若是 aborted/interrupted（点"停止生成" / 闸门 self-cancel / 崩溃恢复），
                //   给该会话打个"刚被中止"点 ⇒ 之后插进来的消息不再被误标成 "[插话]…" 前缀（见 debounce.ts）
                if (dec?.kind === 'aborted' || dec?.kind === 'interrupted') {
                    try {
                        markTurnAborted(String(agent?.session?.id ?? ''));
                    }
                    catch { /* ignore */ }
                }
                if (dec?.kind !== 'enter' || !Array.isArray(dec.messages))
                    return decision;
                // ── 无上下文模式(2026-09-27)：登记"本回合结束后省略历史" ──
                //   ⚠️ 必须放在**群守则去重早退之前**：下面那段早退靠"surface 里已有同 ns 同内容"命中
                //      （群守则内容不变的连续回合必然命中），若登记排在它后面就**永远执行不到**，
                //      而且因为历史一直没被清、早退会一直命中 → 死锁。（2026-09-27 群聊AI排查发现）
                // ── 无上下文模式(2026-09-27 主人定)：开启后该会话每轮省略历史 ──
                //   ⚠️ 这里只做"登记"：真正清历史必须走 surface replace（shadow），而且**要等回合空闲**
                //      （插件硬约束：回合中 append 会坏记录）。所以 fire-and-forget 交给 whenIdle 后执行。
                //   ⚠️ 绝不能在 pre-step 里裁 decision.messages —— 那是"本步从收件箱取出的新消息"（见 runtime-types），
                //      裁了就等于把用户刚发的话删掉（曾实测：模型只收到 system-reminder 后空转 abort）。
                try {
                    const sid0 = String(agent?.session?.id ?? '');
                    let sk0 = '';
                    if (sid0) {
                        // ⚠️ 2026-09-27 修正：SessionRecord 的字段是 **sessionKey**（types.ts:82），
                        //    之前写成 rec.key → 永远 undefined → 登记被静默跳过（表现为"开关读到了却完全没动作"）。
                        const rec0 = this.findBySessionId(sid0);
                        sk0 = String(rec0?.sessionKey ?? '');
                        if (!sk0)
                            for (const [k, r] of this.sessions) {
                                if (r?.sessionId === sid0) {
                                    sk0 = k;
                                    break;
                                }
                            }
                        // ★★ 2026-11-25（CodeRabbit Major）：**宿主恢复出来的会话**（resumeHostAgent 走 agents.resume，
                        //   不写 this.sessions）在前两条反查里都查不到 ⇒ sk0 为空 ⇒ 下面 ctxKey0 退化成 '__global__'
                        //   ⇒ segOn0/ctxSmartOn 全 false ⇒ 1733 行的**固定窗口裁剪抢跑**（把本回合尾巴裁掉、
                        //   写入 lastTrimmedTurn）⇒ 等 1819 行才通过持久映射恢复 sessionKey 时，
                        //   1852 行的 trimHistoryForContextless 撞"同回合防重复"返回 false ⇒ pending 永远不执行。
                        //   所以必须**在这里**（所有裁剪分派之前）就用持久映射兜底 —— 否则补消费端也改不了执行顺序。
                        if (!sk0) {
                            sk0 = this.sessionKeyOfSession(sid0);
                            if (sk0)
                                traceContextless('[ctxsmart] sk0 持久映射兜底: ' + sk0);
                            // ★★ 2026-11-28（CodeRabbit Major）：**「别的实例的会话」和「未绑定会话」绝不能合并成同一个空串**。
                            //   反查确实查到了 key、只是 appId 不属于本实例 ⇒ 那是一个**别的实例正在用的 QQ 会话**，
                            //   而本实例的 pre-step 照样会收到它（两个实例同 cwd 时）。
                            //   此时若按"未绑定"处理：`ctxKey0` 会退化成 `'__global__'` → 用**本实例的全局设置**
                            //   走进 `trimHistoryForContextless` ⇒ 拿本实例的窗口条数去裁**别人会话**的历史（不可逆）。
                            //   改之前反查能拿到对方 key、恰好被对方的智能模式挡住；本 PR 收紧判据后才暴露。
                            //   正确做法：整段跳过 —— 别人的会话，一个字都不碰。
                            if (this.isForeignSession(sid0)) {
                                traceContextless('[ctxsmart] 外实例会话, 跳过本实例 pre-step: sid=' + sid0);
                                return decision;
                            }
                        }
                        skForTool = sk0; // 存到外层，供"上下文工具挂/卸"那块兜底用
                    }
                    try {
                        traceContextless('pre-step 登记检查: sid=' + sid0 + ' sk=' + (sk0 || '(反查为空)')
                            + ' globalMode=' + String(this.config.contextlessMode)
                            + ' | store文件=' + describeStorePath()
                            + ' | 该会话读到=' + JSON.stringify(getContextless(sk0))
                            + ' | 全表=' + JSON.stringify(listContextless()));
                    }
                    catch (traceErr) {
                        traceContextless('trace 自身异常: ' + (traceErr instanceof Error ? traceErr.message : String(traceErr)));
                    }
                    // ⚠️ 2026-09-27 修：全局模式（contextlessMode: true）不能依赖 sessionKey 反查成功。
                    //   实测 trace：web 会话的 sk=(反查为空)，原写法 `if (sk0 && …)` 直接跳过 →
                    //   "全局开关明明开着却一条都没压"。现在 sk0 为空时用一个占位 key 走全局判定
                    //   （isContextlessActive 在 globalEnabled===true 时直接返回 true）。
                    // ★ 提前算：会话级「智能判断」开关（固定 N 条 trim 要用它让位）
                    try {
                        // ★ 2026-11-25：优先用上面算好的 sk0（已含持久映射兜底），
                        //   否则恢复的会话这里又退回 findByAgent ⇒ ctxSmartOn 仍为 false，固定窗口照样抢跑。
                        const sk0b = this.findByAgent(agent)?.sessionKey || sk0;
                        if (sk0b) {
                            setMemoMaxItems(contextlessMemoMaxOf(sk0b) ?? this.config.contextMemoMaxItems ?? 20);
                            ctxSmartOn = isContextlessActive(sk0b, this.config.contextlessMode)
                                && contextlessSmartOf(sk0b, this.config.contextlessSmart);
                        }
                        traceContextless('[ctxsmart] sk=' + String(sk0b) + ' enabled=' + String(sk0b ? isContextlessActive(sk0b, this.config.contextlessMode) : 'n/a') + ' smart=' + String(sk0b ? contextlessSmartOf(sk0b, this.config.contextlessSmart) : 'n/a') + ' cfgSmart=' + String(this.config.contextlessSmart) + ' => on=' + String(ctxSmartOn));
                    }
                    catch (e) {
                        traceContextless('[ctxsmart] 异常: ' + String(e));
                    }
                    const ctxKey0 = sk0 || '__global__';
                    // ⚠️ 2026-10-01：智能判断开启时，固定 N 条**让位**（否则两条路同时压 —— 实测"界面显示已压缩 11 条"）
                    // ★ 2026-11-06 分段压缩：与 window / smart 互斥（三者选一）
                    let segOn0 = false;
                    try {
                        segOn0 = isContextlessActive(ctxKey0, this.config.contextlessMode) && contextlessSegmentOf(sk0);
                    }
                    catch { /* ignore */ }
                    // ★★ 2026-11-25（主人实测 + 微积分指出）：**智能判断与分段压缩同开时，AI 登记的
                    //   compact/drop 下一回合不生效**。原因是执行顺序：分段压缩先跑、把"上回合结束→本回合开始"
                    //   那段压成占位节点；等下面消费 pending 时，那段里"消息数 <= keep+1"直接 return false，
                    //   什么都删不掉 —— 但 pending 照样被 clear，工具回执还说"下一回合执行"，等于骗人。
                    //   pending 是 AI 明确要求的全量操作，优先级高于"压本轮尾巴"：有 pending 就跳过本轮分段压缩。
                    let pendingAhead = null;
                    try {
                        const skP = String(sk0 || this.findByAgent(agent)?.sessionKey || "");
                        const drP = this.resolveDataRootSmart();
                        // ★ 2026-11-28：带上当前会话 id —— pending 按 sessionKey 存，而**历史会话**的 id
                        //   仍能经派生反查映射回同一个 key ⇒ 不带 id 比对的话，打开历史会话会误消费当前会话的请求。
                        if (skP && drP)
                            pendingAhead = readContextPending(drP, skP, sid0);
                        if (pendingAhead)
                            traceContextless("[ctxorder] 本轮有 pending(" + String(pendingAhead.mode) + ") → 跳过分段压缩，交给下面消费");
                    }
                    catch { /* ignore */ }
                    // ★ 2026-11-25（CodeRabbit Major）：跳过分段压缩的条件必须和"本轮**真的能消费** pending"一致。
                    //   否则：上一回合登记了 compact、随后**关掉智能模式**但保留分段压缩 ⇒ pendingAhead 一直在，
                    //   而下面的消费分支要求 ctxSmartOn 为真 ⇒ 既不执行也不清除 ⇒ **分段压缩被永久跳过**。
                    //   正确口径：只有"有 pending **且** 智能模式开着（能消费）"才让位。
                    const willConsumePending = !!pendingAhead && ctxSmartOn;
                    if (pendingAhead && !ctxSmartOn) {
                        traceContextless('[ctxorder] 有 pending 但智能模式已关 ⇒ 消费不了，照常跑分段压缩（pending 留着）');
                    }
                    if (segOn0 && !willConsumePending) {
                        // ── 分段压缩：只压「上回合结束 → 本回合开始」这一段，更早的前缀一个字都不动 ──
                        //    为什么这么做：dsh 每轮把整段上下文发出去，前缀不变才有缓存；只动尾巴才不会把缓存打掉。
                        try {
                            if (!Number.isFinite(currentStep) || currentStep <= 1) {
                                const sessSeg = agent?.session;
                                const nodesSeg = sessSeg?.surface?.nodes;
                                if (sessSeg && Array.isArray(nodesSeg) && nodesSeg.length > 2) {
                                    const keepSeg = contextlessSegmentKeepOf(sk0);
                                    // ★ 2026-11-06 主人实测纠正：边界**不能靠自记的位置**（第一次跑时它不是"上回合结束"，
                                    //   而是 surface 开头 ⇒ 会从第 1 个节点开始扫，撞上一条很老的 @ 就被保护挡住，等于白跑）。
                                    //   正解：边界 = **最后一条 assistant/message 之后** —— 那正好就是"上回合结束"。
                                    //   每次都现算，天然自愈，也不怕重启丢状态。
                                    let boundary = 1;
                                    for (let i = nodesSeg.length - 1; i >= 1; i--) {
                                        const sq = nodesSeg[i];
                                        if (sq === undefined)
                                            continue;
                                        const ev = sessSeg.eventAt?.(sq);
                                        if (ev && ev.type === 'assistant/message') {
                                            boundary = i + 1;
                                            break;
                                        }
                                    }
                                    // 受保护：@ 我 的入站消息永不压（扩展 forceWake 同理，内容里带标记）
                                    const protect = new Set();
                                    const from = Math.max(1, Math.min(boundary, nodesSeg.length));
                                    for (let i = from; i < nodesSeg.length; i++) {
                                        const sq = nodesSeg[i];
                                        if (sq === undefined)
                                            continue;
                                        const ev = sessSeg.eventAt?.(sq);
                                        if (!ev || ev.type !== 'user/message')
                                            continue;
                                        const txt = JSON.stringify(ev.data ?? '');
                                        if (txt.includes('(@you)') || txt.includes('"@you"'))
                                            protect.add(sq);
                                    }
                                    if (boundary < nodesSeg.length) {
                                        // ── 先算"要留住哪些"：最近 keep 条 + （可选）价值分 ≥ 门槛的 + 受保护的 ──
                                        const keepIdx = new Set();
                                        let kept = 0;
                                        for (let k = nodesSeg.length - 1; k >= boundary && kept < keepSeg; k--) {
                                            const sq = nodesSeg[k];
                                            const ev = sq === undefined ? undefined : sessSeg.eventAt?.(sq);
                                            if (!ev || String(ev.type) !== 'user/message')
                                                continue;
                                            keepIdx.add(k);
                                            kept += 1;
                                        }
                                        // ★ 2026-11-06 主人定：价值分保命 —— 分数够高的消息，就算排在 N 条之外也留着
                                        const scoreMin = contextlessSegmentScoreMinOf(sk0);
                                        let savedByScore = 0;
                                        if (typeof scoreMin === 'number' && scoreMin > 0) {
                                            for (let i = boundary; i < nodesSeg.length; i++) {
                                                const sq = nodesSeg[i];
                                                if (sq === undefined || keepIdx.has(i))
                                                    continue;
                                                const ev = sessSeg.eventAt?.(sq);
                                                if (!ev || ev.type !== 'user/message')
                                                    continue;
                                                const sc = getSegmentScore(sessSeg, sq);
                                                if (typeof sc === 'number' && sc >= scoreMin) {
                                                    keepIdx.add(i);
                                                    savedByScore += 1;
                                                }
                                            }
                                        }
                                        for (const sq of protect) {
                                            const idx = nodesSeg.indexOf(sq);
                                            if (idx >= boundary)
                                                keepIdx.add(idx);
                                        }
                                        // ── 剩下的切成"连续段"（只压 user/message，不碰 assistant/tool，天然不破坏配对）──
                                        const runs = [];
                                        let cur;
                                        for (let i = boundary; i < nodesSeg.length; i++) {
                                            const sq = nodesSeg[i];
                                            const ev = sq === undefined ? undefined : sessSeg.eventAt?.(sq);
                                            const droppable = !keepIdx.has(i) && !!ev && String(ev.type) === 'user/message';
                                            if (!droppable) {
                                                if (cur) {
                                                    runs.push(cur);
                                                    cur = undefined;
                                                }
                                                continue;
                                            }
                                            cur = cur ? { startIdx: cur.startIdx, endIdx: i } : { startIdx: i, endIdx: i };
                                        }
                                        if (cur)
                                            runs.push(cur);
                                        // ⚠️ **倒着压**：后面的段先压，前面段的下标才不会失效
                                        let okCount = 0;
                                        for (const r of runs.slice().sort((a, b) => b.startIdx - a.startIdx)) {
                                            // eslint-disable-next-line no-await-in-loop
                                            const okRun = await trimHistoryForContextless(agent, keepSeg, this.logger, (() => { try {
                                                return this.ctx;
                                            }
                                            catch {
                                                return undefined;
                                            } })(), Number.isFinite(currentTurn) ? currentTurn : undefined, { forceRange: r, allowRepeat: true, protectSeqs: protect });
                                            if (okRun)
                                                okCount += 1;
                                        }
                                        this.logger?.debug?.('[contextless] 分段压缩: 段数=' + runs.length + ' 成功=' + okCount
                                            + ' (boundary=' + boundary + ', keep=' + keepSeg + ', 按分保命=' + savedByScore
                                            + ', 门槛=' + String(scoreMin) + ', 受保护=' + protect.size + ')');
                                    }
                                    else {
                                        this.logger?.debug?.('[contextless] 分段压缩: 上回合之后没有新消息，跳过');
                                    }
                                }
                            }
                        }
                        catch (e) {
                            this.logger?.debug?.('[contextless] 分段压缩异常(已忽略): ' + (e instanceof Error ? e.message : String(e)));
                        }
                    }
                    // ── 反向同步：宿主界面切了模型 → 跟着改偏好（2026-11-08 主人要求）──
                    try {
                        if (!Number.isFinite(currentStep) || currentStep <= 1) {
                            const recSync = this.findByAgent(agent);
                            if (recSync?.scope && recSync.peerId)
                                this.adoptHostModel(recSync.scope, recSync.peerId, agent);
                        }
                    }
                    catch (e) {
                        this.logger?.debug?.('[model-sync] 异常(已忽略): ' + (e instanceof Error ? e.message : String(e)));
                    }
                    // ── 已进上下文的图片链接 → 本地路径（2026-11-26 主人要求，默认关）──
                    //   图片是后台下载的，组装时可能还没下完，上下文里就留下了 QQ 临时长链接。
                    //   这里用 surfaceOp replace 只改**尾部**（上一回合结束之后那几条），改完永久生效。
                    try {
                        if (this.config.imagePathSurface === true && (!Number.isFinite(currentStep) || currentStep <= 1)) {
                            const n = await replaceImagePathsInSurface(agent, this.logger, Number.isFinite(currentTurn) ? currentTurn : undefined, { scope: 'tail' });
                            if (n > 0)
                                this.logger?.info?.(`[img-path-surface] 本轮改写 ${n} 个图片链接`);
                        }
                    }
                    catch (e) {
                        this.logger?.debug?.('[img-path-surface] 异常(已忽略): ' + (e instanceof Error ? e.message : String(e)));
                    }
                    // ── 历史图片不重发（2026-11-07 主人定）──
                    //   每轮第一步：把**本插件聚合出来**的图片在历史里换成文字占位，
                    //   只保留「本回合新来的那几张」。别的插件/功能塞的图一律不动。
                    try {
                        if (this.config.imageOffload !== false && (!Number.isFinite(currentStep) || currentStep <= 1)) {
                            const n = await offloadHistoryImages(agent, this.logger, Number.isFinite(currentTurn) ? currentTurn : undefined);
                            if (n > 0)
                                this.logger?.info?.(`[img-offload] 本轮已省略 ${n} 张历史图片`);
                        }
                    }
                    catch (e) {
                        this.logger?.debug?.('[img-offload] 异常(已忽略): ' + (e instanceof Error ? e.message : String(e)));
                    }
                    if (!ctxSmartOn && !segOn0 && isContextlessActive(ctxKey0, this.config.contextlessMode)) {
                        const win0 = contextlessWindowOf(sk0, this.config.contextlessWindow ?? 5);
                        this.logger?.info?.('[contextless] 登记: 会话 ' + sk0 + ' 开启中, 带 @ 前 ' + win0 + ' 条 → 本轮内清理');
                        // ⚠️ 2026-09-27 照宿主做法：dsh-compaction-basic 自己就是在 agent/pre-step 里
                        //    `compactIfNeeded → compactRegion({ owner: 'current-turn' })` —— 即"回合开着时"追加事件。
                        //    人家先前把清理放到 whenIdle() 之后（回合已结束），方向就错了；现在直接在本步执行。
                        // 只在回合的第一个 step 压缩（pre-step 每 step 都触发，否则一轮压多次）
                        if (!Number.isFinite(currentStep) || currentStep <= 1) {
                            await trimHistoryForContextless(agent, win0, this.logger, (() => { try {
                                return this.ctx;
                            }
                            catch {
                                return undefined;
                            } })(), 
                            // turn 必须是当前打开的轮次号：compaction/start 与 compaction/end 要与它一致，
                            // 否则会话日志会以 SessionFormatError 写坏（实测把两个群的会话都写崩过）。
                            Number.isFinite(currentTurn) ? currentTurn : undefined);
                        }
                        else {
                            traceContextless('跳过: 非首个 step (step=' + currentStep + ', turn=' + currentTurn + ')');
                        }
                    }
                }
                catch (e) {
                    traceContextless('pre-step 登记异常: ' + (e instanceof Error ? e.message : String(e)));
                    this.logger?.debug?.('[contextless] 登记异常(已忽略): ' + (e instanceof Error ? e.message : String(e)));
                }
                // 数据根：优先 config.dataRoot；否则从 contextless-store 反推（它 bootstrap 时绑的就是真实 dataRoot）——
                // ⚠️ 不能用 config.cwd 兜底：实测 cwd=\...\测试 而真实 dataRoot=\...\测试\dshqqbot，差一级会导致 pending 写一处读另一处。
                const dataRootSmart = this.resolveDataRootSmart(); // 数据根（提前声明：下面多处用）
                // ── 按**会话**开关动态挂载/卸载三个上下文工具（照测试插件做法：面板改了下一回合就生效）──
                //   ⚠️ 2026-10-09 修（主人实测："开无上下文模式后，回合第一轮那三个工具被移除，AI 还以为是没开"）：
                //     旧实现的两个坑叠加 ——
                //       ① `ctxSmartOn` 初值 false，且只在 `findByAgent(agent)` 反查成功时才被赋值；
                //       ② 下面却**无条件**拿 `ctxSmartOn` 去 sync ⇒ 回合**第一个 step** 反查常落空
                //          （agent↔record 映射尚未登记 / 换了 agent 实例）时，被误判成"该会话不该有工具"
                //          ⇒ sync(false) 把 context_compact/drop/memo **卸掉** ⇒ AI 那一轮调不了压缩，
                //          还会从"工具不在"反推出"这个会话没开无上下文模式"。后面 step 反查成功又挂回来 ⇒ 抖动。
                //     现在两处兜底：**反查兜底**（findByAgent 落空就用上面 findBySessionId 得到的 sk0）
                //     ＋ **未知不动**（真拿不到会话 key 就保持现状 —— 绝不因为"读不到"而卸工具）。
                try {
                    const recTool = agent ? this.findByAgent(agent) : undefined;
                    // ⚠️ 2026-10-01：rec.agentCtx 可能是空的（SessionRecord 注释："setup 竞态失败时可能缺"），
                    //   而 agent.ctx 更可靠（本文件里就有 exec.agent.ctx.get('qqChannel') 的现成用法）。
                    const fromRec = recTool?.agentCtx;
                    const fromAgent = agent?.ctx;
                    const ctxOfTool = fromRec ?? fromAgent;
                    const skTool = String(recTool?.sessionKey ?? '').trim() || skForTool;
                    const smartKnown = !!skTool; // 拿不到 key = "还不知道"，不是"不该有"
                    const smartForTool = smartKnown
                        ? (isContextlessActive(skTool, this.config.contextlessMode) && contextlessSmartOf(skTool, this.config.contextlessSmart))
                        : ctxSmartOn;
                    ctxSmartOn = smartForTool; // 与后面的 pending 消费/注入共用同一口径
                    traceContextless('[ctxtool] on=' + String(smartForTool) + ' known=' + String(smartKnown)
                        + ' fromRec=' + String(Boolean(fromRec)) + ' fromAgent=' + String(Boolean(fromAgent))
                        + ' sk=' + (skTool || '(未知)'));
                    // ── 2026-10-28 改造（主人定，issue #26）：**按 QQ 会话注册**，不再全局注册 + deny 剪枝 ──
                    //   旧路子（10-09 起）是"插件根全局注册一次 + 每会话 restrict deny"：
                    //     · 优点是注册表不动、不抖；代价是第一次 pre-step 之前无关工作区也会看到这四个名字，
                    //       而且 restrict 只过滤"继承来的"工具 —— 全局层本身就是泄漏源。
                    //   现在换成 per-agent 注册（与 mountChannelTools 注册 send_media 等同一条路）：
                    //     · 非 QQ 会话根本不经过这里 ⇒ 天生看不到（零窗口期、零 token）；
                    //     · `syncChannelScopedTools` 自带幂等状态机：状态没变就不碰注册表（同样不抖），
                    //       开关一变下一 step 就重新注册（热开关保留）。
                    //   ⚠️ 提示文本那半段没动：仍旧在上面按同一个 smartForTool 拼进群守则 body。
                    if (ctxOfTool && smartKnown) {
                        syncChannelScopedTools(ctxOfTool, {
                            ctxTools: smartForTool,
                            // 群管理工具跟 groupAdmin.enabled 走（此前被绑在 smart 开关上，语义不对）
                            groupAdmin: this.config.groupAdmin?.enabled === true,
                            // ★ 复审 A（必须）：这条 pre-step 路径漏了 config，而 claim 路径有
                            //   ⇒ 两条路径算出不同的 sig（qunVisible 一个 '0' 一个 '1'）
                            //   ⇒ 同一回合内每 step 都撤销+重注册工具表
                            //   ⇒ 宿主每步发「工具已更新·移除/新增」（还进上下文，纯烧 token）。
                            //   这恰好是 ctxScopeState 存在的理由，别把它重新激活。
                            config: this.config,
                            dataRoot: dataRootSmart,
                            sessionKey: skTool,
                        });
                    }
                    else if (!smartKnown)
                        traceContextless('[ctxtool] 会话 key 未知 → 保持现状(不动注册表)');
                    else
                        traceContextless('[ctxtool] 两个来源都拿不到 ctx，跳过');
                    traceContextless('[ctxtool-env] dataRoot=' + String(dataRootSmart) + ' sk=' + skTool);
                }
                catch (e) {
                    traceContextless('[ctxtool] 动态挂载异常: ' + String(e));
                }
                // ── 智能判断：消费 AI 登记的压缩/丢弃（工具只登记，真正执行在这里）──
                //    与上面的「固定 N 条 trim」互斥：智能模式开启时，固定窗口让位给 AI 自主决定。
                try {
                    const recSmart = agent ? this.findByAgent(agent) : undefined;
                    let skSmart = recSmart?.sessionKey;
                    // ★ CodeRabbit 2026-11-25（Major）：**消费端要和注册端用同一个会话键**。
                    //   宿主恢复出来的 QQ 会话没有 findByAgent 记录；注册端已经能用持久映射取到 key、
                    //   把请求写进该 key 的 pending 文件，但原来这里仍只用 rec.sessionKey ⇒ 对这种会话
                    //   skSmart 恒空 ⇒ 下面的条件不成立 ⇒ **pending 永远不执行**（工具却回"下一回合执行"）。
                    //   有活跃记录时仍以记录为准；没有映射的会话保持现状。
                    if (!skSmart) {
                        try {
                            const sidSmart = String(agent?.session?.id ?? '');
                            if (sidSmart)
                                skSmart = this.sessionKeyOfSession(sidSmart) || undefined;
                        }
                        catch { /* ignore */ }
                    }
                    try {
                        traceContextless('[ctxsmart-diag2] sk=' + String(skSmart) + ' on=' + String(ctxSmartOn));
                    }
                    catch { /* ignore */ }
                    if (skSmart) {
                        ctxSmartOn = isContextlessActive(skSmart, this.config.contextlessMode)
                            && contextlessSmartOf(skSmart, this.config.contextlessSmart);
                    }
                    // ★ CodeRabbit：**重启/回收后 `findByAgent` 全空 ⇒ ctxSmartOn 恒 false**，
                    //   智能提示与自己的备忘都注不进去（连下面那段反查都没机会执行）。
                    //   补一次 model-prefs 反查（与后面 `_kindKey` 同口径），有活跃记录时仍以记录为准。
                    if (!ctxSmartOn) {
                        try {
                            const sidNow = String(agent?.session?.id ?? '');
                            const keyNow = sidNow ? this.sessionKeyOfSession(sidNow) : '';
                            if (keyNow) {
                                ctxSmartOn = isContextlessActive(keyNow, this.config.contextlessMode)
                                    && contextlessSmartOf(keyNow, this.config.contextlessSmart);
                                traceContextless('[ctxsmart] 反查兜底 key=' + keyNow + ' => on=' + String(ctxSmartOn));
                            }
                        }
                        catch { /* ignore */ }
                    }
                    if (ctxSmartOn && skSmart && dataRootSmart && (!Number.isFinite(currentStep) || currentStep <= 1)) {
                        const req = readContextPending(dataRootSmart, skSmart, String(agent?.session?.id ?? ''));
                        if (req) {
                            const keep = req.mode === 'drop' ? 0 : (Number(req.keep) || 3);
                            const done = await trimHistoryForContextless(agent, keep, this.logger, (() => { try {
                                return this.ctx;
                            }
                            catch {
                                return undefined;
                            } })(), Number.isFinite(currentTurn) ? currentTurn : undefined);
                            // ★★ 2026-11-25：trimHistoryForContextless **返回 false 表示"什么都没删"**
                            //   （节点数不足 / 消息数 <= keep+1 / 受保护节点挡在最前）。原来不看返回值就 clear，
                            //   AI 那边看到"已登记"、历史却没动，且请求被吞掉再也不重试。
                            //   现在：没删成就**保留 pending**（下一回合还会再试），并把原因记进日志。
                            if (done) {
                                clearContextPending(dataRootSmart, skSmart);
                                this.logger?.info?.('[contextless] 已执行 AI 登记的 ' + String(req.mode) + '（keep=' + keep + ', session=' + skSmart + '）');
                            }
                            else {
                                this.logger?.warn?.('[contextless] AI 登记的 ' + String(req.mode) + ' 本轮没能生效（可删内容不足），保留 pending 下回合重试: session=' + skSmart);
                                traceContextless('[ctxsmart] pending 未生效，保留: mode=' + String(req.mode) + ' keep=' + keep);
                            }
                        }
                    }
                }
                catch (e) {
                    this.logger?.debug?.('[contextless] 消费 pending 异常(已忽略): ' + (e instanceof Error ? e.message : String(e)));
                }
                const rules = this.readLiveGroupPromptForNs(ns);
                // 引用消息指令(2026-09-13 主人定): 开关关闭时不注入
                const refCtx = this.config.messageReference === false ? '' : REFERENCE_CONTEXT;
                // 群友小传(2026-09-13 主人定): 复用这条**已验证**的 pre-step 注入通道 ——
                //   ctx.systemPrompt.context() 那条在新宿主上没生效(无日志), 走这里最稳(群守则就是这么注入的)。
                //   TTL 90s: inbound 算好的那一行过期就自动不再注入。
                // ⚠️ 2026-11-10 修：小传按会话隔离 —— 只取**本会话**那一条，否则会串群
                const recMemo = agent ? this.findByAgent(agent) : undefined;
                const memoKey = recMemo?.sessionKey ?? '';
                let memoLine = '';
                // ★ 2026-11-10 主人指正：**逐行判重**，不是拿整段的前 40 字符当指纹 ——
                //   那样"后面新想起来的条目"会被前缀误判成"已注入过"，永远进不来。
                let memoPick = memoKey ? takePendingMemo(memoKey) : undefined;
                // ★ 2026-11-11 主人定：**web（非 QQ）会话也要注入小传** —— 那种会话里能打字的只有主人，
                //   所以直接取主人白名单的**第一位**（owners 可能有多个，第一个就是主人本人）。
                //   QQ 会话走入站算好的候选（按发言者），web 会话走这里（按主人）。
                // ★ 2026-11-11 修：**QQ 会话里从 web 直发的回合**也要有兜底 ——
                //   那种回合没有入站候选（`memoPick` 为空），但说话的是主人 ⇒ 同样按 `owners[0]` 取。
                //   原来条件写成 `!memoPick && !recMemo`，把"QQ 会话 + web 直发"整类漏掉了。
                // ★ 2026-11-11 主人追问「纯 web 会话怎么也注入小传」——
                //   小传是**QQ 群里的记忆**，不该漫到跟 QQ 无关的会话里去。
                //   默认只在「QQ 绑定会话」（含在 web 界面打开的 QQ 会话）注入；
                //   真要给纯 web 会话也注入，开设置项 `peopleMemoInWeb`（默认 false）。
                // ★★ 2026-11-28（CodeRabbit 审核 #97）：**判据必须扛得住进程重启**。
                //   原来只有两条，都不持久：
                //     ① `recMemo`（`findByAgent`）只查 `this.sessions` —— **纯内存 Map，重启即空**；
                //     ② `findKeyBySessionId` 只查 `sessionIds` 映射 —— 而**普通建档路径根本不写这条映射**
                //        （全库只有 fork / forceNew / create 失败轮换三处写）。
                //   **实测本机 model-prefs.json：8 个 QQ 会话（sessionCfg）只有 6 条映射**，缺的两个群
                //   重启后在 web 里打开就会被判成"非 QQ" ⇒ 群守则 / 智能提示 / 备忘 / LaTeX 一并丢失
                //   （它们在 1.13.30 之前对 QQ 会话是**无条件注入**的，所以这是回归）。
                //   改用 `findKeyBySessionIdOrDerived()`：映射查不到时，再拿 `sessionCfg` 的每个 key
                //   算派生 id 比一遍（`sessionCfg` 的写入点全在 QQ 的 getOrCreate 路径上，纯 web 进不去）。
                //   两路合计覆盖 8/8；派生算出的两个 id 在 `~/.dsh/sessions/` 下都找到了真实会话目录。
                const isQqBoundSession = !!recMemo || (() => {
                    try {
                        const sid0 = String(agent?.session?.id ?? '');
                        return !!sid0 && !!this.sessionKeyOfSession(sid0);
                    }
                    catch {
                        return false;
                    }
                })();
                const allowWebMemo = this.config.peopleMemoInWeb === true;
                if (!memoPick && (!isQqBoundSession && !allowWebMemo)) {
                    // 纯 web 会话 + 没开开关 → 不注入，直接跳过
                }
                else if (!memoPick) {
                    try {
                        const owners = Array.isArray(this.config.groupAdmin?.owners)
                            ? (this.config.groupAdmin.owners)
                            : [];
                        const ownerId = String(owners[0] ?? '').trim();
                        if (ownerId) {
                            // 用本批最新一条用户文本当检索 query（按话题挑最相关的 1~2 行）
                            let q = '';
                            for (let k = dec.messages.length - 1; k >= 0; k--) {
                                const mm = dec.messages[k];
                                if (mm?.role !== 'user')
                                    continue;
                                const t = String(mm.content?.[0]?.text ?? '');
                                if (t && !/^<(system-reminder|system)/.test(t)) {
                                    q = t.slice(0, 200);
                                    break;
                                }
                            }
                            const r = await recallLines(dataRootOf(this.config), ownerId, q, undefined, 2);
                            if (r.lines.length > 0) {
                                memoPick = { name: '主人', lines: r.lines.map((l) => l.replace(/^-\s*/, '')) };
                            }
                        }
                    }
                    catch { /* web 侧小传失败不影响主链 */ }
                }
                if (memoPick && memoPick.lines.length > 0) {
                    let seenText = '';
                    try {
                        seenText = dec.messages.map((m) => String(m?.content?.[0]?.text ?? '')).join('\n');
                        if (agent?.session?.surface?.nodes && agent.session.eventAt) {
                            for (const seq of agent.session.surface.nodes) {
                                const ev = agent.session.eventAt(seq);
                                if (ev?.type === 'user/message')
                                    seenText += '\n' + String(ev.data?.content?.[0]?.text ?? '');
                            }
                        }
                    }
                    catch { /* 扫描失败 → 视为都没见过，宁可多注一次 */ }
                    // 每一行单独判：这一行已经在上下文里了就不再带；没见过的带上
                    const fresh = memoPick.lines.filter((l) => {
                        const probe = l.slice(0, 24); // 单行指纹（比整段前缀可靠得多）
                        return probe.length > 0 && !seenText.includes(probe);
                    });
                    if (fresh.length > 0) {
                        memoLine = `[人家记得的 ${memoPick.name}: ${fresh.join(' / ')}]`;
                    }
                }
                // ── 智能判断模式：提示 + 备忘（单独算一段，**不受群守则体是否为空影响**）──
                //    ⚠️ 原来是挂在 `if (!body) return decision;` 之后的 —— 群守则体为空时直接早退，
                //       注入根本没机会执行（2026-10-01 实测：AI 反馈"没有任何一条要求我判断是不是同一个话题"）。
                let ctxSmartText = '';
                let selfMemoText = '';
                let selfMemoKey = '';
                /** 备忘**读取是否成功**（CodeRabbit：区分「读到空」=用户清空 与 「读失败」=不能作废现有备忘） */
                let selfMemoOk = false;
                try {
                    // ⚠️ 2026-10-01：靠「这个 turn 注过没有」去重 —— 原来用 step<=1 判，实测仍会一回合注两份
                    //   （宿主每 step 都触发，且 currentStep 未必从 1 递增）。
                    // ★ 终版判据：本批 messages 里已有「话题判断」块就不再注 ——
                    //   同一回合内 step2 的 messages 必然带着 step1 注入的那份，因此一定拦得住（比按 turn 可靠）。
                    // ★★★ 2026-10-01 最终解：**替换式注入** —— 不赌任何时序判据，改为"每次注之前先剔掉旧的同类块"，
                    //   这样无论宿主触发多少次（实测每次工具往返都触发），上下文里恒定只有 1 份。
                    //
                    // ★★ 2026-11-21 主人指出：备忘原来**和群守则拼在同一条 body 里**，而那条的去重只比群守则指纹
                    //   ⇒ 群守则不变时，备忘改了也**永远不会重新注入**（模型看到的始终是最老那份备忘）。
                    //   现在拆开：固定提示继续跟 body 走；**备忘独立成块**（`qqbot:self-memo`），自己判自己的重。
                    if (ctxSmartOn && dataRootSmart) {
                        const recM = agent ? this.findByAgent(agent) : undefined;
                        let skM = recM?.sessionKey;
                        if (!skM) {
                            // 重启/回收后 findByAgent 查不到宿主恢复的会话 ⇒ 用 model-prefs 反查（同会话类型注入那套）
                            try {
                                const sidNow = String(agent?.session?.id ?? '');
                                skM = sidNow ? this.sessionKeyOfSession(sidNow) : '';
                            }
                            catch { /* ignore */ }
                        }
                        if (skM) {
                            selfMemoKey = skM;
                            const mr = memoForInject(dataRootSmart, skM);
                            selfMemoOk = mr.ok;
                            const memo = mr.text.trim();
                            if (CTX_SMART_REMINDER)
                                ctxSmartText = '<system-reminder>\n' + CTX_SMART_REMINDER + '\n</system-reminder>';
                            if (memo)
                                selfMemoText = memo;
                        }
                    }
                }
                catch (e) {
                    this.logger?.debug?.('[contextless] 组装智能提示异常(已忽略): ' + (e instanceof Error ? e.message : String(e)));
                }
                // ★ 2026-10-26 修（性能 bug，外部作者 wuwo1979 实测上报）：
                //   去重指纹原来用 CTX_SMART_REMINDER，但该串**只在 contextlessSmart 开启时才进 body**
                //   （默认 false）⇒ 谓词连"自己刚注入的那条"都判不中 ⇒ skipGroupRules 永不置位
                //   ⇒ 每个 pre-step 都重注整段群守则(~1910 字符)，副本作为 user/message 留在 surface
                //   里被长期重放，每步都在白烧 token。
                //   改用**群守则内容指纹**判重：内容没变就不再注；群守则改了会自动重注一次。
                const rulesFp = (rules.trim() || FIXED_CHANNEL_CONTEXT.trim()).slice(0, 60);
                let skipGroupRules = false; // 群守则已在上下文里 → 只跳过它，不影响智能提示注入
                // ★ 2026-10-01 正解：把「话题判断 + 备忘」拼进群守则这条 body —— 与它**共用同一套去重**
                //   （下面的 inBatch + surface 历史比对）。人家先前的独立注入靠 step/turn/时间窗判重，
                //   在"同回合多次请求"下全部失效（surface 要回合结束才提交），实测份数 2→3→5 只增不减。
                // ★ 2026-10-02（主人定）：把智能提示当成**第二个群守则** —— 拼进 body、共用它的去重。
                //   备忘会逐轮变化，所以下面的去重只比对固定部分（CTX_SMART_REMINDER），不受备忘影响。
                // ⚠️ 2026-11-10 修：memoLine **不能拼进 body** —— body 会被"群守则已在上下文里"的去重整体跳过
                //   （skipGroupRules），于是小传从此再也注不进去。小传单独成块，自己判自己的重。
                const body = [FIXED_CHANNEL_CONTEXT.trim(), refCtx.trim(), rules.trim()].filter(Boolean).join('\n\n');
                if (!body)
                    return decision;
                const text = `<system-reminder>\n${body}\n</system-reminder>`;
                const desired = {
                    role: 'user',
                    id: randomUUID(),
                    content: [{ type: 'text', text }],
                    source: { kind: 'qqbot:group-rules', form: 'instructions', ns },
                };
                // 去重(靠 KV cache): 本次 messages 已含同 ns+同内容 → 不重复
                const inBatch = dec.messages.some((m) => {
                    const mm = m;
                    // ⚠️ 只比对固定部分（备忘会变），否则每轮都被判成'新内容'而重复注入
                    return mm?.source?.kind === 'qqbot:group-rules' && mm.source.ns === ns
                        && String(mm.content?.[0]?.text ?? '').includes(rulesFp);
                });
                // ⚠️ dsh 0.1.6 起 `eventAt / snapshotEvents / ownEvents` 被标记 @deprecated（官方措辞：
                //    "既有逻辑可暂不迁移，但不允许新增调用"）。此处是 2026-09 就存在的**既有只读遍历**，
                //    故按官方说明保留；后续若要迁移，方向是 surface 投影 / 异步事件流。
                //    判空写法保证在旧宿主(无 eventAt)上也安全降级。
                if (!inBatch && agent?.session?.surface?.nodes && agent.session.eventAt) {
                    // 会话 surface 历史已有同 ns+同内容 → 靠 KV cache, 不重复注入
                    for (const seq of agent.session.surface.nodes) {
                        const ev = agent.session.eventAt(seq);
                        if (ev?.type === 'user/message'
                            && ev.data?.source?.kind === 'qqbot:group-rules'
                            && ev.data.source.ns === ns
                            && String(ev.data.content?.[0]?.text ?? '').includes(rulesFp)) {
                            // ⚠️ 2026-10-01：原来这里直接 return decision —— 但群守则每轮都在，
                            //   于是从第二回合起整轮注入都被吞掉（智能提示也跟着丢，实测"话题判断"事件恒为 0）。
                            //   改为：只跳过群守则这一条，继续往下走（ctxSmartText 照常注入）。
                            skipGroupRules = true;
                            break;
                        }
                    }
                }
                if (inBatch)
                    skipGroupRules = true; // 同上：只跳过群守则那条
                // ⚠️ 2026-09-27 撤除：「无上下文模式」不能在这个钩子里实现 —— 这里 payload/decision 的 messages 是
                //   "本步从收件箱取出的新消息"（见 dsh-agent runtime-types: "messages removed from the inbox for this step"），
                //   不是"发给模型的完整上下文"。在此裁剪只会把用户刚发的话删掉（实测：模型只收到 system-reminder 后空转 abort）。
                //   "清历史"的正确机制是会话 surface 的 shadow/compaction（见 dsh-compaction-basic 的 shadowedSeqs），
                //   待按该机制另行实现。
                // ★ 2026-11-11 主人定：**非 QQ 会话（在 DSH 宿主里直接打字）**要在正文开头拼一句说明，
                //   让模型一眼看出"这条是主人在宿主界面亲自发的"，而不是 QQ 里转进来的。
                //   为什么不放 system prompt：那条会**常驻**，之后所有回合都会被误当成"当前这条是主人直发"。
                //   这里只改**本条待发的用户消息**（一次性），只动 text 块；图片/文件/语音一律不碰。
                //   去重：已经带标记的不再重复拼（万一同一 message 被多次经过）。
                // ★ 2026-11-13 主人改：**判定从「按回合」改成「按条」**。
                //   旧实现看 `record.turnOrigin`（QQ 入站置 'qq'、turn/end 清空）⇒ 主人 web 打的那条只要和
                //   群友消息被收进同一回合，整回合就被跳过、标记全丢（11-13 实测大量丢失，见 §11.40）。
                //   新判据 = 宿主「用户 RPC 提示词」的正式字段：`source.kind === 'user' && typeof source.rpcId === 'string'`
                //   （web/桌面界面输入由 dsh-api-session-controller 构造，必带 rpcId + clientTimeZone，宿主类型表里
                //     叫 'user-rpc' 变体；QQ 入站 / 插件注入 / agent.inject 全是裸 {kind:'user'} 或自己的 kind ⇒ 不会命中）。
                //   ⚠️ turnOrigin 本身别删 —— outbound 的 webTurnSilent 还在用它。
                // ★ 2026-11-11 主人纠正：**只给「QQ 绑定的会话」加标记** ——
                //   纯 web 会话（agent preset 自己开的、不属于任何 QQ peer）跟插件没关系，绝不能改它的正文。
                // ★★ 2026-11-28：这里原来另算了一份 `isQqSessionByPrefs`（recMemo 为空时再反查一次），
                //   代数上**恒等**于 `isQqBoundSession` —— 那个判据已经扛重启（见上面的
                //   `findKeyBySessionIdOrDerived`），所以直接复用，避免同一语义两份逻辑
                //   以后改一处忘另一处（铁律 11 的同一类问题，只是反向：能合就别留副本）。
                // ★ 2026-11-26（主人方案）：**pre-step 兜底** —— 把本步新消息里的 QQ 图片 URL 换成本地路径。
                //   为什么在这里：图片下载是后台 fire-and-forget（不阻塞入站），消息组装时可能还没下完；
                //   而 `dec.messages` 是「本步从收件箱取出的新消息」，正是**上下文已就位、回合正要开始**的那一刻。
                //   在这儿查 image-path-cache，下完几张就换几张，没下完的原样留着（回退 QQ 链接）。
                //   ⚠️ 2026-11-26（审核 S8 更正）：这段改写**会进 session** —— 宿主 agent-loop 的 step()
                //   会把 decision.messages 逐条 `session.append('user/message', …, {surfaceOp:'append'})`。
                //   所以是"一次性改写并落库"，不是"只改副本"。副作用：本地路径日后若被图片回收删掉，
                //   原 QQ 链接已不可恢复 —— 这也是它虽不带开关、仍要尽量收窄范围的原因。
                try {
                    let imgReplaced = 0;
                    // 防御：只扫前 24 条（`dec.messages` 正常只有 1~3 条；真遇到大批量也不至于卡住热路径）
                    const IMG_SCAN_MAX = 24;
                    let scanLeft = IMG_SCAN_MAX;
                    dec.messages = dec.messages.map((m) => {
                        if (scanLeft-- <= 0)
                            return m;
                        const mm = m;
                        if (!mm || mm.role !== 'user' || !Array.isArray(mm.content))
                            return m;
                        let msgChanged = false;
                        const nc = mm.content.map((c) => {
                            if (!c || c.type !== 'text' || typeof c.text !== 'string')
                                return c;
                            // 只碰含 QQ 图片下载链接的文本块，其他内容一律不动
                            if (!/multimedia\.nt\.qq\.com\.cn|qq\.com\/download/i.test(c.text))
                                return c;
                            let blockChanged = false;
                            // ⚠️ 字符类必须排除 `]`/`>`/中文标点：本仓库图片占位是 `[图片: <url>]`，
                            //   用 `[^\s)]` 会把 `]` 与紧跟的正文一起吃掉（审核 M1）。
                            // CodeRabbit PR #93：外层只判断「整段里有没有 QQ 图片域名」，但下面这个回调会对块里
                            // **每个** https 链接调 lookupImagePath，而它的 stableKey 只看 fileid 前 40 字符
                            // → 普通链接可能误命中缓存。所以回调内先校验主机，非 QQ 图片链接原样返回。
                            const isQqImageUrl = (x) => /^https:\/\/(?:multimedia\.nt\.qq\.com\.cn|qq\.com)\/download/i.test(x);
                            const replacedText = c.text.replace(/https:\/\/[^\s)\]}>"'，。；！？、【】（）《》]+/g, (u) => {
                                if (!isQqImageUrl(u))
                                    return u;
                                const local = lookupImagePath(u);
                                if (!local)
                                    return u;
                                imgReplaced++;
                                blockChanged = true;
                                return local;
                            });
                            if (!blockChanged)
                                return c;
                            msgChanged = true;
                            return { ...c, text: replacedText };
                        });
                        return msgChanged ? { ...mm, content: nc } : m;
                    });
                    if (imgReplaced > 0) {
                        this.logger?.debug?.(`[img-path] pre-step 替换 ${imgReplaced} 个图片 URL → 本地路径`);
                    }
                }
                catch { /* 替换失败不影响本步 */ }
                if (isQqBoundSession) {
                    const DIRECT_MARK = '【主人在 DSH 宿主界面直接发送】';
                    let marked = 0;
                    try {
                        dec.messages = dec.messages.map((m) => {
                            const mm = m;
                            if (!mm || mm.role !== 'user')
                                return m;
                            // ★ 只认「界面直发」：宿主 user-rpc 变体（kind=user ＋ rpcId 字符串）。
                            //   QQ 入站 / 群守则 / 小传 / 提问回执 / 定时任务注入 都不是这个形状 ⇒ 一律不动。
                            if (mm.source?.kind !== 'user' || typeof mm.source.rpcId !== 'string')
                                return m;
                            if (!Array.isArray(mm.content))
                                return m;
                            const i = mm.content.findIndex((c) => c?.type === 'text' && typeof c.text === 'string' && !c.text.startsWith(DIRECT_MARK));
                            if (i < 0)
                                return m;
                            const nc = mm.content.slice();
                            const base = nc[i] ?? { type: 'text' };
                            nc[i] = { ...base, text: `${DIRECT_MARK}${String(base.text ?? '')}` };
                            marked++;
                            return { ...mm, content: nc };
                        });
                        if (marked > 0) {
                            const sidNow = String(agent?.session?.id ?? '?');
                            this.logger?.info?.(`[web-direct] 已给 ${marked} 条界面直发消息加"主人直发"标记 (session=${sidNow})`);
                            // 落盘一份，便于主人肉眼确认（日志窗口里不一定看得到）
                            try {
                                const { appendFileSync, mkdirSync } = await import('node:fs');
                                const dir = join(dataRootOf(this.config), '.qqbot');
                                mkdirSync(dir, { recursive: true });
                                appendFileSync(join(dir, 'web-direct.log'), `${new Date().toISOString()} 已加标记 n=${marked} session=${sidNow}
`, 'utf8');
                            }
                            catch { /* ignore */ }
                        }
                    }
                    catch { /* 改写失败不影响主链 */ }
                }
                // 先剔掉本批里已有的同类块（注入块会进事件、逐轮累积 ⇒ 用替换而不是追加）
                const _baseMsgs = _stripOldCtxSmart(dec.messages);
                // at 是按原数组算的：剔除后重新定位插入点（紧跟 claimed 之后）
                const _claimedSet = new Set(Array.isArray(p.messages) ? p.messages : []);
                let _at2 = 0;
                for (let k = _baseMsgs.length - 1; k >= 0; k--) {
                    if (_claimedSet.has(_baseMsgs[k])) {
                        _at2 = k + 1;
                        break;
                    }
                }
                const extraAll = [];
                // 小传：独立注入块（自己的 source kind + 自己的去重；不受群守则跳过影响）
                if (memoLine) {
                    extraAll.push({
                        role: 'user',
                        id: randomUUID(),
                        content: [{ type: 'text', text: `<system-reminder>` + String.fromCharCode(10) + memoLine + String.fromCharCode(10) + `</system-reminder>` }],
                        source: { kind: 'qqbot:people-memo', form: 'instructions', ns },
                    });
                    this.logger?.info?.(`[小传] 注入 ${memoLine.length} 字 (session=${recMemo?.sessionKey ?? '?'})`);
                }
                // ★ CodeRabbit：**智能模式指令独立成块**（`qqbot:ctx-smart`）。
                //   原来它拼在群守则 body 里、共用 `rulesFp` 判重 ⇒ 群守则没变时（智能模式刚打开、
                //   或重启后恢复的会话）`skipGroupRules` 会把整条 body 丢掉 ⇒ 话题判断/压缩要求永远缺失。
                // ★★ 2026-11-27（主人指出）：**「无上下文模式·智能判断」也是 QQ 会话专用的** ——
                //   它讲的是"群聊消息量大、历史会随每轮送出、白烧钱"，判据也是"聊了 5 轮以上/对方换话题"
                //   这种群聊场景。非 QQ 会话（在 DSH 宿主界面里对话）没有这个问题，
                //   注进只会平白多一段 system-reminder。
                if (isQqBoundSession && ctxSmartOn && ctxSmartText) {
                    const SMART_KIND = 'qqbot:ctx-smart';
                    const smartFp = CTX_SMART_REMINDER.slice(0, 40);
                    // ★ CodeRabbit：判重要看**剔旧之后**的 `_baseMsgs` —— `_stripOldCtxSmart` 已经把本批里的旧智能块删掉了，
                    //   若还拿原始 `dec.messages` 判，就会误以为"本批已有"而不再补注，最终消息里反而没有这条提示。
                    const _smartInBatch = _baseMsgs.some((m) => {
                        const mm = m;
                        return mm?.source?.kind === SMART_KIND && String(mm.content?.[0]?.text ?? '').includes(smartFp);
                    });
                    let _smartInSurface = false;
                    if (!_smartInBatch && agent?.session?.surface?.nodes && agent.session.eventAt) {
                        for (const seq of agent.session.surface.nodes) {
                            const ev = agent.session.eventAt(seq);
                            if (ev?.type !== 'user/message' || ev.data?.source?.kind !== SMART_KIND)
                                continue;
                            const c = ev.data?.content;
                            const txt = typeof c === 'string'
                                ? c
                                : Array.isArray(c)
                                    ? c.map((b) => String(b?.text ?? '')).join(String.fromCharCode(10))
                                    : '';
                            if (txt.includes(smartFp)) {
                                _smartInSurface = true;
                                break;
                            }
                        }
                    }
                    if (!_smartInBatch && !_smartInSurface) {
                        extraAll.push({
                            role: 'user',
                            id: randomUUID(),
                            content: [{ type: 'text', text: `<system-reminder>` + String.fromCharCode(10) + CTX_SMART_REMINDER + String.fromCharCode(10) + `</system-reminder>` }],
                            source: { kind: SMART_KIND, form: 'instructions', ns },
                        });
                    }
                }
                // ★ 2026-11-21（主人定）：**自己的备忘独立注入、独立判重**。
                //   原来和群守则共用一条 body（去重只比群守则指纹）⇒ 群守则不变时，备忘改了也**永远不会重注**，
                //   模型看到的始终是最老那份。现在按"上下文里最后一条备忘块是否已含当前备忘文本"判重：
                //   变了就补注一条（旧版留在历史里，新块写明"以此为准"）。
                if (isQqBoundSession && selfMemoText) {
                    const MEMO_KIND = 'qqbot:self-memo';
                    const _memoInBatch = dec.messages.some((m) => {
                        const mm = m;
                        return mm?.source?.kind === MEMO_KIND && String(mm.content?.[0]?.text ?? '').includes(selfMemoText);
                    });
                    let _lastMemo = '';
                    if (!_memoInBatch && agent?.session?.surface?.nodes && agent.session.eventAt) {
                        for (const seq of agent.session.surface.nodes) {
                            const ev = agent.session.eventAt(seq);
                            if (ev?.type !== 'user/message' || ev.data?.source?.kind !== MEMO_KIND)
                                continue;
                            const c = ev.data?.content;
                            _lastMemo = typeof c === 'string'
                                ? c
                                : Array.isArray(c)
                                    ? c.map((b) => String(b?.text ?? '')).join(String.fromCharCode(10))
                                    : '';
                        }
                    }
                    if (!_memoInBatch && !_lastMemo.includes(selfMemoText)) {
                        extraAll.push({
                            role: 'user',
                            id: randomUUID(),
                            content: [{
                                    type: 'text',
                                    text: `<system-reminder>`
                                        + String.fromCharCode(10)
                                        + '〔你自己的备忘 · 最新版（之前若有旧版，一律以这条为准）〕'
                                        + String.fromCharCode(10)
                                        + selfMemoText
                                        + String.fromCharCode(10)
                                        + `</system-reminder>`,
                                }],
                            source: { kind: MEMO_KIND, form: 'instructions', ns },
                        });
                        this.logger?.info?.(`[备忘] 注入最新版 ${selfMemoText.length} 字`);
                    }
                }
                else if (ctxSmartOn && selfMemoKey && selfMemoOk) {
                    // ★ CodeRabbit：备忘被清空（用户用 context_memo 删光了）⇒ 历史里旧块还写着「以这条为准」，
                    //   模型会继续把已删内容当备忘。这里补注一条「清空」状态；且只在**确实读到空**时补
                    //   （未启用 / 读取失败时 selfMemoKey 为空，走不到这里，绝不覆盖有效备忘）。
                    const MEMO_KIND = 'qqbot:self-memo';
                    let _lastMemoEmpty = '';
                    if (agent?.session?.surface?.nodes && agent.session.eventAt) {
                        for (const seq of agent.session.surface.nodes) {
                            const ev = agent.session.eventAt(seq);
                            if (ev?.type !== 'user/message' || ev.data?.source?.kind !== MEMO_KIND)
                                continue;
                            const c = ev.data?.content;
                            _lastMemoEmpty = typeof c === 'string'
                                ? c
                                : Array.isArray(c)
                                    ? c.map((b) => String(b?.text ?? '')).join(String.fromCharCode(10))
                                    : '';
                        }
                    }
                    if (_lastMemoEmpty && !_lastMemoEmpty.includes('备忘已清空')) {
                        extraAll.push({
                            role: 'user',
                            id: randomUUID(),
                            content: [{
                                    type: 'text',
                                    text: `<system-reminder>` + String.fromCharCode(10)
                                        + '〔你的备忘已清空：上下文里之前列出的备忘条目全部作废，不要再当作当前备忘使用。〕'
                                        + String.fromCharCode(10) + `</system-reminder>`,
                                }],
                            source: { kind: MEMO_KIND, form: 'instructions', ns },
                        });
                        this.logger?.info?.('[备忘] 已清空 → 注入作废标记');
                    }
                }
                // ★ 2026-11-20：**数学公式提示独立成块**（维护手册 §11.39 铁律：自己的 kind + 自己的判重）。
                //   不拼进群守则 body —— 那样开关切换时指纹判断容易漏，而且和群守则耦合。
                //   内容固定（182 字符），用"查有没有就不注"的去重（见下面的两步判断）。
                // ⚠️ 2026-11-20 主人实测：**每轮都在重复注入**。
                //   我一开始只查 dec.messages（本批），漏了 surface 历史 ⇒ 判断永远 false。
                //   **照抄群守则的两步去重**（L1932-1955 同款）：
                //     ① 本批 dec.messages 里有没有
                //     ② session surface 历史里有没有（agent.session.eventAt 遍历）
                const _hintInBatch = dec.messages.some((m) => m?.source?.kind === 'qqbot:latex-hint');
                let _hintInSurface = false;
                if (!_hintInBatch && agent?.session?.surface?.nodes && agent.session.eventAt) {
                    for (const seq of agent.session.surface.nodes) {
                        const ev = agent.session.eventAt(seq);
                        if (ev?.type === 'user/message' && ev.data?.source?.kind === 'qqbot:latex-hint') {
                            _hintInSurface = true;
                            break;
                        }
                    }
                }
                // ⚠️ 2026-11-20 审查（第二轮）：**归属校验只能管这一段，不能提前 return 整个回调**。
                //   findByAgent 只查 this.sessions，而 resumeHostAgent 不写这个表 ——
                //   重启/回收后从 Web 打开的 QQ 会话在它眼里是 undefined。
                //   要是放在函数开头提前 return，小传注入 / peopleMemoInWeb / contextlessMode 全都不执行了。
                // ★ 2026-11-28（复审 Y5）：原来这里还要 `_ownedByMe = !!findByAgent(agent)`，
                //   而它对**本 PR 要修的那个场景（重启后从 web 打开的 QQ 会话）恒为 false** ⇒
                //   四道门里有一道永远不开，latex 提示照样注不进去。`isQqBoundSession` 已扛重启、
                //   是它的上位判据 ⇒ 直接去掉 `_ownedByMe`（否则只修好三样、第四样漏掉）。
                if (isQqBoundSession && this.config.latexHint === true && !_hintInBatch && !_hintInSurface) {
                    extraAll.push({
                        role: 'user',
                        id: randomUUID(),
                        content: [{ type: 'text', text: `<system-reminder>` + String.fromCharCode(10) + LATEX_HINT_BLOCK + String.fromCharCode(10) + `</system-reminder>` }],
                        source: { kind: 'qqbot:latex-hint', form: 'instructions', ns },
                    });
                    this.logger?.debug?.('[latexHint] 注入数学公式提示');
                }
                // ★ 2026-11-21（issue #79）：**会话类型标注** —— 独立事件 + 自己的 source.kind。
                //   私聊与群聊的注入格式几乎同构，模型只能靠猜（实测把私聊判成群聊、按群规矩回复）。
                //   群名/昵称走官方 API（`session-kind.ts` 里带缓存 + 后台预取，注入本身同步不等网络）。
                //   ⚠️ source.kind 必须带 `qqbot:` 前缀（维护手册 §11.21：否则 dock 会把注入当成对方发言）。
                //
                //   ★★ 2026-11-21 主人实测「重启后没重新注入」：**不能依赖 `_ownedByMe`/`recMemo`** ——
                //      `findByAgent` 只查 this.sessions，重启/回收后从宿主恢复的 QQ 会话在它眼里是 undefined，
                //      于是这条注入会被整块跳过（group-rules 那套有同样隐患，但它另有 model-prefs 兜底）。
                //      这里改用 **sessionKey 反查**（model-prefs 的 sessionIds，纯内存），从 key 里解析 scope/peerId。
                const _kindKey = (() => {
                    if (recMemo?.sessionKey)
                        return String(recMemo.sessionKey);
                    try {
                        const sidNow = String(agent?.session?.id ?? '');
                        return sidNow ? this.sessionKeyOfSession(sidNow) : '';
                    }
                    catch {
                        return '';
                    }
                })();
                const _kindParts = (() => {
                    const m = /^qqbot:[^:]+:(group|c2c):(.+)$/.exec(_kindKey);
                    if (!m)
                        return undefined;
                    const peer = String(m[2] ?? '').replace(/@[0-9a-f-]{8,}$/i, '');
                    return peer ? { scope: String(m[1] ?? 'group'), peerId: peer } : undefined;
                })();
                if (this.config.sessionKindHint !== false && _kindParts) {
                    const KIND = 'qqbot:session-kind';
                    const info = describeSessionKind(dataRootOf(this.config), String(this.config.appId ?? ''), _kindParts.scope, _kindParts.peerId, recMemo ? recMemo.peerName : undefined);
                    const _kindInBatch = dec.messages.some((m) => m?.source?.kind === KIND);
                    // ★ 名字是**后来**才从 API 拿到的，首次注入往往是"群名未取到"。
                    //   所以判重不只看"有没有注入过"，还要看**有没有注入过带名字的版本**：
                    //   现在拿到名字了就再补一条（之后不再重复）。
                    // ★ CodeRabbit：判重只看**最新一条**会话类型提示。
                    //   名字变来变去（甲 → 乙 → 甲）时，扫任意一条命中会让"最新的乙"继续留在上下文里，
                    //   模型看到的群名就是过期的。所以扫完全部，留下最后一条的文本再比。
                    let _lastHintText = '';
                    if (agent?.session?.surface?.nodes && agent.session.eventAt) {
                        for (const seq of agent.session.surface.nodes) {
                            const ev = agent.session.eventAt(seq);
                            if (ev?.type !== 'user/message' || ev.data?.source?.kind !== KIND)
                                continue;
                            const c = ev.data?.content;
                            _lastHintText = typeof c === 'string'
                                ? c
                                : Array.isArray(c)
                                    ? c.map((b) => String(b?.text ?? '')).join(String.fromCharCode(10))
                                    : '';
                        }
                    }
                    const need = info.name ? !_lastHintText.includes(info.name) : _lastHintText === '';
                    if (!_kindInBatch && need) {
                        extraAll.push({
                            role: 'user',
                            id: randomUUID(),
                            content: [{ type: 'text', text: `<system-reminder>` + String.fromCharCode(10) + buildSessionKindHint(info) + String.fromCharCode(10) + `</system-reminder>` }],
                            source: { kind: KIND, form: 'instructions', ns },
                        });
                        this.logger?.info?.(`[会话类型] 注入 kind=${info.kind}${info.name ? ` name=「${info.name}」` : ' name=(未取到)'} key=${_kindKey}`);
                    }
                }
                // ★★ 2026-11-27（主人在 `game` 工作区的会话里发现整段群守则被注入）：
                //   `body` 里那三样 ——
                //     · FIXED_CHANNEL_CONTEXT（@人语法 / 富媒体标记 / 引用写法）
                //     · refCtx（引用消息指令）
                //     · rules（群守则）
                //   **全是 QQ 会话专有的**。注进非 QQ 工作区的会话里，模型根本用不上，
                //   而且这一步要多烧约 1900 字（每个 step 都在）。
                //   ⚠️ 不能在这里提前 `return decision` —— 后面还有「会话类型」注入等步骤要走完，
                //   提前 return 会把它们一起吞掉。所以只把这一条 desired 从插入列表里去掉。
                //   （2026-11-28 更正：原注释说「ctxSmartText 在 web 会话里同样需要」—— 它现在也
                //     gate 成 QQ-only 了，那句理由已不成立；但那三样仍不能提前 return。）
                //   判据用 `isQqBoundSession`（已扛重启的版本）。
                const wantGroupRules = isQqBoundSession && !skipGroupRules;
                if (!wantGroupRules) {
                    // ★ 2026-11-28（审核建议）：**"跳过"必须留下可判定的记录** —— 否则「按预期没注入」
                    //   和「坏了」在日志里长得一模一样，没法验收。热路径（每 step 一次）⇒ debug（铁律 4），
                    //   开 `DSH_QQBOT_DEBUG=1` 可见。
                    this.logger?.debug?.(`[inject-gate] 跳过群守则: qq=${isQqBoundSession} skip=${skipGroupRules} sid=${String(agent?.session?.id ?? '?').slice(0, 8)}`);
                }
                const entered = [..._baseMsgs.slice(0, _at2), ...(wantGroupRules ? [desired] : []), ...extraAll, ..._baseMsgs.slice(_at2)];
                return { ...dec, messages: entered };
            }
            catch {
                return decision;
            }
        });
    }
    /**
     * 主人 openid 白名单（config.groupAdmin.owners）。
     * 用于 QQ 审批卡片"谁可以点"的名单：发起者 + 这些主人。
     * @returns 非空字符串数组（配置缺失/异常时返回空数组）
     */
    adminOwners() {
        try {
            const list = this.config?.groupAdmin?.owners;
            return Array.isArray(list) ? list.map((x) => String(x)).filter((x) => x.length > 0) : [];
        }
        catch {
            return [];
        }
    }
    findBySessionId(sessionId) {
        for (const record of this.sessions.values()) {
            if (record.sessionId === sessionId)
                return record;
        }
        return undefined;
    }
    /** 查宿主全局 agent registry(进程内存活 agent, 含 web/hub 等非 QQ 会话): 跨会话唤醒兜底 */
    findHostAgent(sessionId) {
        try {
            const agent = this.agents.get(sessionId);
            return agent ? { agent } : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * 宿主持久化恢复会话(重启后唤起): 进程内无活 agent 时, 用宿主 registry.resume 把
     * 持久化会话拉回内存(与 getOrCreate 的 resume 路径同源)。web/hub 会话也能这样唤起。
     * @returns agent 或 undefined(会话不存在/恢复失败)
     */
    async resumeHostAgent(sessionId) {
        try {
            const agent = this.agents.get(sessionId);
            if (agent)
                return { agent };
            const handle = await this.agents.resume({
                resumeSessionId: sessionId,
            }).catch(() => undefined);
            if (!handle)
                return undefined;
            this.logger.info(`resumeHostAgent: session=${sessionId.slice(0, 8)}… ok`);
            return { agent: handle.agent };
        }
        catch (err) {
            this.logger.warn?.(`resumeHostAgent: ${sessionId.slice(0, 8)}… ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }
    /** 列出本 bot 全部活跃会话(通用插件能力: 供 session_list/跨会话唤醒等按 id 寻址) */
    listSessions() {
        const out = [];
        for (const record of this.sessions.values()) {
            out.push({
                sessionId: record.sessionId,
                scope: record.scope,
                peerId: record.peerId,
                senderId: record.senderId,
                lastActivity: record.lastActivity,
                agentPreset: record.agentPreset,
            });
        }
        return out;
    }
    /** 按 scope+peerId 解析 sessionId(与 getOrCreate 完全一致: 存在则用记录值, 否则确定性派生) */
    sessionIdFor(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const rec = this.sessions.get(key);
        if (rec)
            return rec.sessionId;
        return SessionId(this.currentSessionId(key));
    }
    findByAgent(agent) {
        try {
            const _aid = String(agent?.id ?? '-');
            const _sid = String(agent?.session?.id ?? '-');
            const _recs = [...this.sessions.values()].map((r) => String(r.sessionKey) + '|sid=' + String(r.sessionId) + '|aid=' + String(r.agent?.id ?? '-') + '|rsid=' + String(r.agent?.session?.id ?? '-'));
            const _hit = [...this.sessions.values()].filter((r) => r.agent === agent).length;
            traceContextless('[fba-diag] aid=' + _aid + ' sid=' + _sid + ' 记录数=' + this.sessions.size + ' 引用命中=' + _hit + ' 记录明细=' + _recs.join(' ; '));
        }
        catch (e) { /* ignore */ }
        for (const record of this.sessions.values()) {
            if (record.agent === agent)
                return record;
        }
        // 兜底: 宿主可能给工具传入同会话的另一个 agent 实例(热更新/多实例后引用不一致), 但 id 稳定
        const aid = agent?.id;
        if (aid !== undefined) {
            for (const record of this.sessions.values()) {
                if (record.agent.id === aid)
                    return record;
            }
        }
        // ★ 2026-10-01 第三层兜底：按 session.id 匹配。
        //   实测（3099 隔离环境）工具执行时拿到的 agent，引用与 id 都与记录里的对不上
        //   （宿主可能传的是"同会话的另一个 agent 实例"），但 session.id 是稳定的。
        const sid = String(agent?.session?.id ?? '');
        if (sid) {
            for (const record of this.sessions.values()) {
                if (String(record.sessionId) === sid)
                    return record;
                const rsid = String(record.agent?.session?.id ?? '');
                if (rsid && rsid === sid)
                    return record;
            }
        }
        return undefined;
    }
    /** 按会话键找活跃会话(group/c2c); 无则 undefined(会话被回收/未建立) */
    findByPeer(scope, peerId) {
        return this.sessions.get(this.sessionKey(scope, peerId));
    }
    /**
     * 定时/主动注入: 向某会话塞一条新消息(像收到新消息, AI 带上下文处理并回复到 QQ)。
     * 会话当前不在(被回收/未建立)→ 返回 false, 由调用方决定(计数/跳过)。
     */
    async injectToPeer(scope, peerId, text, sourceKind) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        if (!record)
            return false;
        try {
            const message = createUserMessage({
                content: [{ type: 'text', text }],
                source: (sourceKind && sourceKind !== 'user' ? { kind: sourceKind } : { kind: 'user' }),
            });
            record.agent.followup(message);
            record.lastActivity = Date.now();
            // ★★ 2026-11-05（主人要求：扩展契约也要能打 QQ 标记）：
            //   `injectToPeer` **不走 handleInbound**，所以原来不会置 `turnOrigin` ⇒ 被当成
            //   "web 回合"，`webTurnSilent` 一开就把它的回复也静默掉了。
            //   而本方法的**全部调用方**都是 QQ 侧语义（定时任务 ticker、botplay 按钮回调、
            //   session_wake、命令注入、扩展 `caps.wakeTo`）—— 它们代表"QQ 那边有人在等"，
            //   所以这里统一标记成 QQ 回合（扩展想要"只进上下文不唤醒"请用 appendSilent / silentInto）。
            record.turnOrigin = 'qq';
            record.interjectLifted = false;
            record.turnStartAt = Date.now();
            this.logger.info(`injectToPeer: ${key} ok`);
            return true;
        }
        catch (err) {
            this.logger.warn?.(`injectToPeer failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    async remove(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        if (!record)
            return;
        this.sessions.delete(key);
        this.modelResolver.clearSessionId(key);
        record.agent.cancel({ kind: 'user' });
        await record.handle.dispose().catch(() => { });
        this.logger.info(`session removed: key=${key}`);
    }
    async disposeAll() {
        this.evictor.dispose();
        const records = [...this.sessions.values()];
        this.sessions.clear();
        for (const record of records) {
            record.agent.cancel({ kind: 'user' });
        }
        await Promise.allSettled(records.map((r) => r.handle.dispose()));
        this.logger.info(`all sessions disposed (count=${records.length})`);
    }
    get size() {
        return this.sessions.size;
    }
}
/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(message) {
    const blocks = message?.content;
    if (!blocks || !Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text' && block.text) {
            parts.push(block.text);
        }
    }
    return parts.join('\n').trim();
}
//# sourceMappingURL=session-manager.js.map