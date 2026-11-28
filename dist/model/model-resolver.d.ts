import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
import type { ModelRoute, ModelEntry } from './types.js';
export declare class ModelResolver {
    private readonly ctx;
    private readonly config;
    private readonly logger?;
    private readonly prefs;
    private readonly settings;
    constructor(ctx: Context, config: ImQQBotConfig, logger?: Logger | undefined);
    /**
     * 获取指定 sessionKey 的有效模型路由（create 用）
     *
     * 优先级：会话级偏好(sessionKey@sessionId) > config 显式指定 > settings.yaml > 宿主服务
     * ⚠️ 2026-09-11 主人定: 模型偏好改为「绑定会话(sessionId)」而非「绑定聊天 id(peer)」——
     *    新会话/新群不再继承旧偏好(此前 peer 级 override 导致新会话也默认火山)。
     *    sessionId 缺省时兼容旧 peer 级读取(回退/单会话用)。
     */
    getEffectiveRoute(sessionKey: string, sessionId?: string): ModelRoute | undefined;
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
    getResumeRoute(sessionKey: string, sessionId?: string): ModelRoute | undefined;
    /**
     * 设置会话级模型偏好并持久化到隔离文件
     * (2026-09-11: key 从 peer 级改为 sessionKey@sessionId, 模型偏好跟随会话)
     */
    setOverride(sessionKey: string, sessionId: string | undefined, route: ModelRoute): void;
    /**
     * 清除会话级模型偏好并持久化
     */
    clearOverride(sessionKey: string, sessionId?: string): void;
    /**
     * 是否存在指定会话的模型偏好
     */
    hasOverride(sessionKey: string, sessionId?: string): boolean;
    /**
     * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
     */
    /** 反查：DSH 会话 id → qqbot sessionKey（内存 Map，不读盘；2026-11-11） */
    findKeyBySessionId(sessionId: string): string | undefined;
    /**
     * 反查（含派生兜底）。普通建档的会话**没有** `sessionIds` 映射，只能靠派生 id 认出来 ——
     * 详见 `PrefsStore.findKeyBySessionIdOrDerived` 的注释。
     *
     * `preferredAppId`：同一 sid 可能挂着多个 key（换号后旧 key 仍在），优先返回这个 appId 的。
     */
    findKeyBySessionIdOrDerived(sessionId: string, preferredAppId?: string): string | undefined;
    getSessionId(sessionKey: string): string | undefined;
    /**
     * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
     */
    setSessionId(sessionKey: string, sessionId: string): void;
    /**
     * 清除指定 sessionKey 的 sessionId 记录
     */
    clearSessionId(sessionKey: string): void;
    /** 读会话配置指纹(cwd/preset; issue #43: 判断配置是否变更) */
    getSessionCfg(sessionKey: string): import('./prefs-store.js').SessionCfgFingerprint | undefined;
    /** 记会话配置指纹 */
    setSessionCfg(sessionKey: string, cfg: import('./prefs-store.js').SessionCfgFingerprint): void;
    /** 清会话配置指纹(重置会话时连带) */
    clearSessionCfg(sessionKey: string): void;
    /** 读会话 preset 覆盖(/new <preset> 指定) */
    getSessionPreset(sessionKey: string): string | undefined;
    /** 记会话 preset 覆盖 */
    setSessionPreset(sessionKey: string, preset: string): void;
    /** 清会话 preset 覆盖 */
    clearSessionPreset(sessionKey: string): void;
    /**
     * 解析默认模型路由（不含 per-peer 偏好）
     *
     * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
     * 最终兜底 deepseek-official/deepseek-flash，确保 {{model}} 变量始终有值。
     */
    resolveDefault(): ModelRoute;
    /**
     * 列出所有可用模型
     * ⚠️ 2026-09-11 主人要求: 合并「宿主 llm 服务的模型目录」(官方 deepseek-flash/V41 等)
     *    + settings.yaml llm-pi-ai.providers(火山/豆包) —— 之前只读 settings, 官方模型永远不在列表。
     *    宿主 llm.listModels 是异步的, 因此本方法改为 async。
     */
    listModels(): Promise<ModelEntry[]>;
    /**
     * 列出可用 provider 名称
     */
    listProviders(): string[];
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
    private withEffort;
    /** `provider/model` → 该模型支持的档位 id（由 `resolveModelInfo` 填充）。 */
    private modelCaps;
    /** 正在拉的 key → Promise（去重，防同一模型并发多次请求）。 */
    private capsInflight;
    /** 拉一次某模型支持的思考档位。失败/拿不到 ⇒ 记空数组（= 一律不传档位）。 */
    private loadEffortCaps;
    /** 2026-09-11: 模型偏好绑定会话 —— key = sessionKey@sessionId; 无 sessionId 时回退 peer 级(旧数据/单会话) */
    private overrideKey;
    private readFromHost;
    /** 统一的 Cordis 服务访问
     *  ⚠️ 2026-09-11: 先走 ctx.get(name)(cordis 标准, 父链查找, 子 scope 可拿宿主服务);
     *     原实现先属性访问 ctxAny[name] —— cordis Service getter 在作用域外可能抛错/undefined,
     *     导致 llm 服务拿不到, /model 列表只剩 settings 模型(火山/豆包, 官方模型缺失)。 */
    private getService;
}
//# sourceMappingURL=model-resolver.d.ts.map