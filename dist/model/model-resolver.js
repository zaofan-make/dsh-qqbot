/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析当前生效的默认模型路由
 *   2. 列出可用 providers 和模型
 *   3. 管理 per-peer 的模型偏好（委托 PrefsStore）
 *
 * 优先级（从高到低）：
 *   per-peer 偏好（~/.dsh-qqbot/model-prefs.json）
 *   > config 显式指定（cordis.yml 的 provider/model）
 *   > settings.yaml 的 agent-default-model（只读，作为默认兜底）
 *   > 宿主 agentDefaultModel 服务
 */
import { join } from 'node:path';
import { PrefsStore } from './prefs-store.js';
import { dataRootOf } from '../gateway/data-root.js';
import { SettingsReader } from './settings-reader.js';
export class ModelResolver {
    ctx;
    config;
    logger;
    prefs;
    settings;
    constructor(ctx, config, logger) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        // 偏好文件跟着 dataRoot 走（{dataRoot}/.qqbot/model-prefs.json），不再孤零零丢在 C 盘家目录
        this.prefs = new PrefsStore(config.debug ? (msg) => this.logger?.debug(msg) : undefined, (() => { try {
            return join(dataRootOf(config), '.qqbot');
        }
        catch {
            return undefined;
        } })(), 
        // ★ 2026-10-31（同步上游 e49dadf）：读写失败必须**可见**（warn）。
        //   旧版只走 debugLog（默认关）⇒ 偏好文件写失败完全静默，
        //   表现就是"QQ 里上下文莫名其妙丢了"，而且没有任何线索可查。
        (msg) => this.logger?.warn(`im-qqbot: ${msg}`));
        this.settings = new SettingsReader();
    }
    /**
     * 获取指定 sessionKey 的有效模型路由（create 用）
     *
     * 优先级：会话级偏好(sessionKey@sessionId) > config 显式指定 > settings.yaml > 宿主服务
     * ⚠️ 2026-09-11 主人定: 模型偏好改为「绑定会话(sessionId)」而非「绑定聊天 id(peer)」——
     *    新会话/新群不再继承旧偏好(此前 peer 级 override 导致新会话也默认火山)。
     *    sessionId 缺省时兼容旧 peer 级读取(回退/单会话用)。
     */
    getEffectiveRoute(sessionKey, sessionId) {
        const route = this.prefs.getOverride(this.overrideKey(sessionKey, sessionId)) ?? this.resolveDefault();
        return route ? this.withEffort(route) : undefined;
    }
    /**
     * 获取 resume 时覆盖 session 的模型路由
     *
     * 优先级：会话级偏好 > cordis.yml 显式配置 > 默认链（settings.yaml > host）
     *
     * 注意：不能像 dsh-TUI 那样返回 undefined 让 session 沿用 requestHeader。
     * dsh-TUI 靠 installModelSelection 从 session.requestHeader 恢复 {{model}}，
     * 而我们未装 installModelSelection，system-prompt 的 {{model}} 变量直接读
     * agent.options.model（agent-loop index.ts:352）——若无值会抛
     * "prompt variable {{model}} has no value for this assembly"。
     * 因此这里兜底到默认链，确保 agent.options.model 始终有值。
     */
    getResumeRoute(sessionKey, sessionId) {
        const override = this.prefs.getOverride(this.overrideKey(sessionKey, sessionId));
        if (override)
            return this.withEffort(override);
        if (this.config.provider && this.config.model) {
            return this.withEffort({ provider: this.config.provider, model: this.config.model });
        }
        const route = this.resolveDefault();
        return route ? this.withEffort(route) : undefined;
    }
    /**
     * 设置会话级模型偏好并持久化到隔离文件
     * (2026-09-11: key 从 peer 级改为 sessionKey@sessionId, 模型偏好跟随会话)
     */
    setOverride(sessionKey, sessionId, route) {
        this.prefs.setOverride(this.overrideKey(sessionKey, sessionId), route);
    }
    /**
     * 清除会话级模型偏好并持久化
     */
    clearOverride(sessionKey, sessionId) {
        this.prefs.clearOverride(this.overrideKey(sessionKey, sessionId));
    }
    /**
     * 是否存在指定会话的模型偏好
     */
    hasOverride(sessionKey, sessionId) {
        return this.prefs.hasOverride(this.overrideKey(sessionKey, sessionId));
    }
    /**
     * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
     */
    /** 反查：DSH 会话 id → qqbot sessionKey（内存 Map，不读盘；2026-11-11） */
    findKeyBySessionId(sessionId) {
        return this.prefs.findKeyBySessionId(sessionId);
    }
    /**
     * 反查（含派生兜底）。普通建档的会话**没有** `sessionIds` 映射，只能靠派生 id 认出来 ——
     * 详见 `PrefsStore.findKeyBySessionIdOrDerived` 的注释。
     *
     * `preferredAppId`：同一 sid 可能挂着多个 key（换号后旧 key 仍在），优先返回这个 appId 的。
     */
    findKeyBySessionIdOrDerived(sessionId, preferredAppId) {
        return this.prefs.findKeyBySessionIdOrDerived(sessionId, preferredAppId);
    }
    getSessionId(sessionKey) {
        return this.prefs.getSessionId(sessionKey);
    }
    /**
     * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
     */
    setSessionId(sessionKey, sessionId) {
        this.prefs.setSessionId(sessionKey, sessionId);
    }
    /**
     * 清除指定 sessionKey 的 sessionId 记录
     */
    clearSessionId(sessionKey) {
        this.prefs.clearSessionId(sessionKey);
    }
    /** 读会话配置指纹(cwd/preset; issue #43: 判断配置是否变更) */
    getSessionCfg(sessionKey) {
        return this.prefs.getSessionCfg(sessionKey);
    }
    /** 记会话配置指纹 */
    setSessionCfg(sessionKey, cfg) {
        this.prefs.setSessionCfg(sessionKey, cfg);
    }
    /** 清会话配置指纹(重置会话时连带) */
    clearSessionCfg(sessionKey) {
        this.prefs.clearSessionCfg(sessionKey);
    }
    /** 读会话 preset 覆盖(/new <preset> 指定) */
    getSessionPreset(sessionKey) {
        return this.prefs.getSessionPreset(sessionKey);
    }
    /** 记会话 preset 覆盖 */
    setSessionPreset(sessionKey, preset) {
        this.prefs.setSessionPreset(sessionKey, preset);
    }
    /** 清会话 preset 覆盖 */
    clearSessionPreset(sessionKey) {
        this.prefs.clearSessionPreset(sessionKey);
    }
    /**
     * 解析默认模型路由（不含 per-peer 偏好）
     *
     * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
     * 最终兜底 deepseek-official/deepseek-flash，确保 {{model}} 变量始终有值。
     */
    resolveDefault() {
        if (this.config.provider && this.config.model) {
            return { provider: this.config.provider, model: this.config.model };
        }
        const fromSettings = this.settings.readDefaultRoute();
        if (fromSettings)
            return fromSettings;
        const fromHost = this.readFromHost();
        if (fromHost)
            return fromHost;
        // ⚠️ 2026-09-18 适配 dsh 0.1.6：官方默认模型列表已移除 V4 Flash / V4 Flash Vision Exp，
        //    兜底改用现行默认 `deepseek-flash`（与 settings.yaml 的 agent-default-model 同值），
        //    避免兜底指向一个已不在默认目录里的模型（真人配置优先，此处仅最后一层保险）。
        return { provider: 'deepseek-official', model: 'deepseek-flash' };
    }
    /**
     * 列出所有可用模型
     * ⚠️ 2026-09-11 主人要求: 合并「宿主 llm 服务的模型目录」(官方 deepseek-flash/V41 等)
     *    + settings.yaml llm-pi-ai.providers(火山/豆包) —— 之前只读 settings, 官方模型永远不在列表。
     *    宿主 llm.listModels 是异步的, 因此本方法改为 async。
     */
    async listModels() {
        const models = [];
        // ① 宿主 llm 服务的模型目录(deepseek-official 等内置 provider 的模型)
        try {
            const llm = this.getService('llm');
            dbg(`[model] listModels: llm=${llm ? 'found' : 'MISSING'} listProviders=${typeof llm?.listProviders} listModels=${typeof llm?.listModels}`);
            if (llm && typeof llm.listProviders === 'function') {
                const providers = await llm.listProviders();
                dbg(`[model] listProviders -> ${Array.isArray(providers) ? providers.length + ' 个' : typeof providers}`);
                if (Array.isArray(providers)) {
                    for (const p of providers) {
                        const pid = typeof p === 'string' ? p : p?.id;
                        if (!pid)
                            continue;
                        try {
                            if (typeof llm.listModels !== 'function')
                                continue;
                            const ms = await llm.listModels(pid);
                            dbg(`[model] provider=${pid} models=${Array.isArray(ms) ? ms.length : '非数组'}`);
                            if (!Array.isArray(ms))
                                continue;
                            for (const m of ms) {
                                const mid = m?.id;
                                if (!mid)
                                    continue;
                                models.push({ provider: pid, id: mid, name: m?.name || undefined });
                            }
                        }
                        catch (err) {
                            dbg(`[model] provider=${pid} listModels 异常: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                }
            }
        }
        catch (err) {
            dbg(`[model] 宿主 llm 服务异常: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ② settings.yaml llm-pi-ai.providers(火山/豆包等, 去重)
        for (const m of this.settings.readModels()) {
            if (!models.some((x) => x.provider === m.provider && x.id === m.id))
                models.push(m);
        }
        dbg(`[model] listModels 合计 ${models.length} 个`);
        return models;
    }
    /**
     * 列出可用 provider 名称
     */
    listProviders() {
        try {
            const llm = this.getService('llm');
            if (llm && typeof llm.listProviders === 'function') {
                const providers = llm.listProviders();
                if (providers.length > 0) {
                    const first = providers[0];
                    if (typeof first === 'string')
                        return providers;
                    return providers.map((p) => p.id);
                }
            }
        }
        catch {
            // 忽略
        }
        return this.settings.readProviders();
    }
    // ── 私有方法 ──
    /**
     * 思考强度的**校验与挑选**（缺档补、已存档但模型不认的丢掉）。
     *
     * 数据源：宿主门面的 `llm.resolveModelInfo(provider, model)` → `info.reasoning.efforts[].id`。
     * ⚠️ **不是** `listModels()` —— 门面的 `listModels` 会重建白名单对象（只留
     * `provider/id/name/inputModalities/badge…`），`reasoningEfforts` 那类字段到不了我们手里。
     * 这条坑踩过一整版（1.13.38 第一稿：改了等于没改）。
     *
     * 三种情况：
     *   ① **还不知道**（缓存空）⇒ 触发一次异步拉取，**本回合不传 effort**（宁可没档位，也别报错）；
     *   ② **知道**、路由没带档 ⇒ 按该模型支持的挑（medium → low → high → max → 任一非 off）；
     *   ③ **知道**、路由带了档但该模型不支持 ⇒ **丢掉**（1.13.36 写进 model-prefs 的
     *      `effort:'medium'` 就是靠这一条止血的；不校验的话那句
     *      `does not support reasoning effort "medium"` 会永远跟着用户）。
     */
    /**
     * **写路径**用的清洗：先 `await` 一次能力缓存，再按它校验 / 补档。
     *
     * ⚠️ 为什么写路径也要（CodeRabbit 2026-11-29 · 严重）：
     *   `/bot-model provider/model medium` 这类**用户显式指定**的档位，原来直接落进
     *   `setOverride` / `applyModelRoute` / `forkCurrentSession`，**绕过了所有校验** ⇒
     *   一句不支持的档位就能把宿主喂坏（`does not support reasoning effort "medium"` 原样复现）。
     *   读路径（`getEffectiveRoute`）早就过 `withEffort` 了，写路径没有 —— 这个不对称最要命，
     *   因为"用户手打"恰恰是最常见的入口。
     */
    async sanitizeRouteAsync(route) {
        try {
            await this.loadEffortCaps(route.provider, route.model);
        }
        catch { /* 拿不到按空处理 */ }
        return this.withEffort(route);
    }
    withEffort(route) {
        const key = `${route.provider}/${route.model}`;
        const rec = this.modelCaps.get(key);
        const fresh = !!rec && Date.now() - rec.at < ModelResolver.CAPS_TTL_MS;
        if (!fresh) {
            // ① 还不知道 / 已过期：拉一次（去重），本回合先不传。
            //    过期但旧值还在时**不沿用** —— 宿主可能刚改过能力声明（CodeRabbit 2026-11-29），
            //    沿用旧值就可能又把它不认的档位塞回去。
            void this.loadEffortCaps(route.provider, route.model);
            return route.effort ? { ...route, effort: undefined } : route;
        }
        const caps = rec.levels;
        if (caps.length === 0) {
            // 该模型不支持思考（或拿不到能力信息）⇒ 任何档位都不传
            return route.effort ? { ...route, effort: undefined } : route;
        }
        if (!route.effort) {
            // ② 缺档：挑一个它支持的。**优先 medium，其次 low**（low 比 high 便宜，
            //    用户的意图是"让它思考"，不是"让它最贵"）
            const picked = ['medium', 'low', 'high', 'max'].find((x) => caps.includes(x))
                ?? caps.find((x) => x !== 'off');
            return picked ? { ...route, effort: picked } : route;
        }
        // ③ 已存档位：不支持就丢掉
        return caps.includes(route.effort) ? route : { ...route, effort: undefined };
    }
    /** 思考档位缓存的存活时间 —— 过期后重拉（宿主能力声明可能在运行期变，CodeRabbit 2026-11-29）。 */
    static CAPS_TTL_MS = 5 * 60_000;
    /** `provider/model` → 支持的档位 id + 拉取时间（由 `resolveModelInfo` 填充）。 */
    modelCaps = new Map();
    /** 正在拉的 key → Promise（去重，防同一模型并发多次请求）。 */
    capsInflight = new Map();
    /**
     * 拉一次某模型支持的思考档位。
     *
     * ⚠️ 三个细节都是踩出来的：
     *   ① **整条记录替换**（不是"有就跳过"）—— 宿主后来把某模型改成"不支持思考"时，
     *      旧档位必须被覆盖掉，否则会继续按老能力补档；
     *   ② **失败也记时间戳**（`levels: []`）—— TTL 到期自动重试，不会"一次失败永久卡死"，
     *      也不会在失败瞬间被热路径反复重拉；
     *   ③ **`capsInflight` 的清理必须挂在外面**（见下面注释），否则早退分支会让它永久泄漏。
     */
    loadEffortCaps(provider, model) {
        const key = `${provider}/${model}`;
        const rec = this.modelCaps.get(key);
        if (rec && Date.now() - rec.at < ModelResolver.CAPS_TTL_MS)
            return Promise.resolve();
        const inflight = this.capsInflight.get(key);
        if (inflight)
            return inflight;
        // ⚠️ **不要在 async IIFE 内部写 `finally { delete }`**（CodeRabbit 2026-11-29 · 严重）：
        //   若 body 在第一个 `await` 之前就返回（比如宿主没有 resolveModelInfo 那条早退），
        //   `finally` 会先于下面的 `set` 执行 ⇒ delete 是空操作 ⇒ 然后才 set 一个**早已 resolve 的 promise**
        //   ⇒ 它永久占着 `capsInflight`，此后该模型**再也不会重拉**（TTL 等于失效），
        //   而且 `modelCaps` 里那条记录永不刷新 ⇒ 该模型整个进程生命周期内一律不传档位，且**无任何日志**。
        //   用 `.finally()` 挂在外面：回调是微任务，一定在 `set` 之后执行。
        const task = this.doLoadCaps(key, provider, model).finally(() => {
            if (this.capsInflight.get(key) === task)
                this.capsInflight.delete(key);
        });
        this.capsInflight.set(key, task);
        return task;
    }
    async doLoadCaps(key, provider, model) {
        try {
            const llm = this.getService('llm');
            if (!llm || typeof llm.resolveModelInfo !== 'function') {
                this.modelCaps.set(key, { levels: [], at: Date.now() });
                this.logger?.debug?.('[effort] 宿主没有 resolveModelInfo ⇒ 一律不传思考档位');
                return;
            }
            const info = await llm.resolveModelInfo(provider, model);
            const efforts = info
                ?.reasoning?.efforts;
            const ids = Array.isArray(efforts)
                ? efforts.map((e) => String(e?.id ?? '')).filter(Boolean)
                : [];
            this.modelCaps.set(key, { levels: ids, at: Date.now() });
            this.logger?.debug?.(`[effort] ${key} 支持的档位: ${JSON.stringify(ids)}`);
        }
        catch {
            // 拿不到：记空 + 时间戳（TTL 到期自动重试），比"猜一个可能错的"安全
            this.modelCaps.set(key, { levels: [], at: Date.now() });
            this.logger?.debug?.(`[effort] ${key} 能力查询失败，按"不支持档位"处理（TTL 后会重试）`);
        }
    }
    /** 2026-09-11: 模型偏好绑定会话 —— key = sessionKey@sessionId; 无 sessionId 时回退 peer 级(旧数据/单会话) */
    overrideKey(sessionKey, sessionId) {
        return sessionId ? `${sessionKey}@${sessionId}` : sessionKey;
    }
    readFromHost() {
        try {
            const agentDefaultModel = this.getService('agentDefaultModel');
            if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
                const selection = agentDefaultModel.currentSelection();
                if (selection?.provider && selection?.model) {
                    return { provider: selection.provider, model: selection.model };
                }
            }
        }
        catch (err) {
            if (this.config.debug) {
                this.logger?.debug(`ModelResolver: host service failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return undefined;
    }
    /** 统一的 Cordis 服务访问
     *  ⚠️ 2026-09-11: 先走 ctx.get(name)(cordis 标准, 父链查找, 子 scope 可拿宿主服务);
     *     原实现先属性访问 ctxAny[name] —— cordis Service getter 在作用域外可能抛错/undefined,
     *     导致 llm 服务拿不到, /model 列表只剩 settings 模型(火山/豆包, 官方模型缺失)。 */
    getService(name) {
        const ctxAny = this.ctx;
        if (typeof ctxAny.get === 'function') {
            try {
                const viaGet = ctxAny.get(name);
                if (viaGet !== undefined && viaGet !== null)
                    return viaGet;
            }
            catch { /* fallthrough 属性访问 */ }
        }
        try {
            return ctxAny[name];
        }
        catch {
            return undefined;
        }
    }
}
// ── 诊断输出(2026-09-13 主人要求): **默认静默** —— 插件用户不需要这些调试噪音,
//    排障时设环境变量 DSH_QQBOT_DEBUG=1 即可全部打出来。
function dbg(msg) {
    if (process.env.DSH_QQBOT_DEBUG)
        console.log(msg);
}
//# sourceMappingURL=model-resolver.js.map