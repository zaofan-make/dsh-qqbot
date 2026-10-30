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
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
import type { ModelRoute, ModelEntry } from './types.js';
import { PrefsStore } from './prefs-store.js';
import { dataRootOf } from '../gateway/data-root.js';
import { SettingsReader } from './settings-reader.js';

export class ModelResolver {
  private readonly prefs: PrefsStore;
  private readonly settings: SettingsReader;

  constructor(
    private readonly ctx: Context,
    private readonly config: ImQQBotConfig,
    private readonly logger?: Logger,
  ) {
    // 偏好文件跟着 dataRoot 走（{dataRoot}/.qqbot/model-prefs.json），不再孤零零丢在 C 盘家目录
    this.prefs = new PrefsStore(
      config.debug ? (msg) => this.logger?.debug(msg) : undefined,
      (() => { try { return join(dataRootOf(config), '.qqbot'); } catch { return undefined; } })(),
      // ★ 2026-10-31（同步上游 e49dadf）：读写失败必须**可见**（warn）。
      //   旧版只走 debugLog（默认关）⇒ 偏好文件写失败完全静默，
      //   表现就是"QQ 里上下文莫名其妙丢了"，而且没有任何线索可查。
      (msg) => this.logger?.warn(`im-qqbot: ${msg}`),
    );
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
  getEffectiveRoute(sessionKey: string, sessionId?: string): ModelRoute | undefined {
    return this.prefs.getOverride(this.overrideKey(sessionKey, sessionId)) ?? this.resolveDefault();
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
  getResumeRoute(sessionKey: string, sessionId?: string): ModelRoute | undefined {
    const override = this.prefs.getOverride(this.overrideKey(sessionKey, sessionId));
    if (override) return override;

    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    return this.resolveDefault();
  }

  /**
   * 设置会话级模型偏好并持久化到隔离文件
   * (2026-09-11: key 从 peer 级改为 sessionKey@sessionId, 模型偏好跟随会话)
   */
  setOverride(sessionKey: string, sessionId: string | undefined, route: ModelRoute): void {
    this.prefs.setOverride(this.overrideKey(sessionKey, sessionId), route);
  }

  /**
   * 清除会话级模型偏好并持久化
   */
  clearOverride(sessionKey: string, sessionId?: string): void {
    this.prefs.clearOverride(this.overrideKey(sessionKey, sessionId));
  }

  /**
   * 是否存在指定会话的模型偏好
   */
  hasOverride(sessionKey: string, sessionId?: string): boolean {
    return this.prefs.hasOverride(this.overrideKey(sessionKey, sessionId));
  }

  /**
   * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
   */
  getSessionId(sessionKey: string): string | undefined {
    return this.prefs.getSessionId(sessionKey);
  }

  /**
   * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
   */
  setSessionId(sessionKey: string, sessionId: string): void {
    this.prefs.setSessionId(sessionKey, sessionId);
  }

  /**
   * 清除指定 sessionKey 的 sessionId 记录
   */
  clearSessionId(sessionKey: string): void {
    this.prefs.clearSessionId(sessionKey);
  }

  /** 读会话配置指纹(cwd/preset; issue #43: 判断配置是否变更) */
  getSessionCfg(sessionKey: string): import('./prefs-store.js').SessionCfgFingerprint | undefined {
    return this.prefs.getSessionCfg(sessionKey);
  }

  /** 记会话配置指纹 */
  setSessionCfg(sessionKey: string, cfg: import('./prefs-store.js').SessionCfgFingerprint): void {
    this.prefs.setSessionCfg(sessionKey, cfg);
  }

  /** 清会话配置指纹(重置会话时连带) */
  clearSessionCfg(sessionKey: string): void {
    this.prefs.clearSessionCfg(sessionKey);
  }

  /** 读会话 preset 覆盖(/new <preset> 指定) */
  getSessionPreset(sessionKey: string): string | undefined {
    return this.prefs.getSessionPreset(sessionKey);
  }

  /** 记会话 preset 覆盖 */
  setSessionPreset(sessionKey: string, preset: string): void {
    this.prefs.setSessionPreset(sessionKey, preset);
  }

  /** 清会话 preset 覆盖 */
  clearSessionPreset(sessionKey: string): void {
    this.prefs.clearSessionPreset(sessionKey);
  }

  /**
   * 解析默认模型路由（不含 per-peer 偏好）
   *
   * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
   * 最终兜底 deepseek-official/deepseek-flash，确保 {{model}} 变量始终有值。
   */
  resolveDefault(): ModelRoute {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    const fromSettings = this.settings.readDefaultRoute();
    if (fromSettings) return fromSettings;

    const fromHost = this.readFromHost();
    if (fromHost) return fromHost;

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
  async listModels(): Promise<ModelEntry[]> {
    const models: ModelEntry[] = [];

    // ① 宿主 llm 服务的模型目录(deepseek-official 等内置 provider 的模型)
    try {
      const llm = this.getService('llm') as
        | { listProviders(): Promise<unknown> | unknown; listModels(provider: string): Promise<readonly unknown[]> }
        | undefined;

      dbg(`[model] listModels: llm=${llm ? 'found' : 'MISSING'} listProviders=${typeof llm?.listProviders} listModels=${typeof (llm as { listModels?: unknown } | undefined)?.listModels}`);
      if (llm && typeof llm.listProviders === 'function') {
        const providers = await llm.listProviders();
        dbg(`[model] listProviders -> ${Array.isArray(providers) ? providers.length + ' 个' : typeof providers}`);
        if (Array.isArray(providers)) {
          for (const p of providers) {
            const pid = typeof p === 'string' ? p : (p as { id?: string })?.id;
            if (!pid) continue;
            try {
              if (typeof llm.listModels !== 'function') continue;
              const ms = await llm.listModels(pid);
              dbg(`[model] provider=${pid} models=${Array.isArray(ms) ? ms.length : '非数组'}`);
              if (!Array.isArray(ms)) continue;
              for (const m of ms) {
                const mid = (m as { id?: string })?.id;
                if (!mid) continue;
                models.push({ provider: pid, id: mid, name: (m as { name?: string })?.name || undefined });
              }
            } catch (err) {
              dbg(`[model] provider=${pid} listModels 异常: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    } catch (err) {
      dbg(`[model] 宿主 llm 服务异常: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ② settings.yaml llm-pi-ai.providers(火山/豆包等, 去重)
    for (const m of this.settings.readModels()) {
      if (!models.some((x) => x.provider === m.provider && x.id === m.id)) models.push(m);
    }

    dbg(`[model] listModels 合计 ${models.length} 个`);
    return models;
  }

  /**
   * 列出可用 provider 名称
   */
  listProviders(): string[] {
    try {
      const llm = this.getService('llm') as
        | { listProviders(): Array<{ id: string; name: string }> | string[] }
        | undefined;

      if (llm && typeof llm.listProviders === 'function') {
        const providers = llm.listProviders();
        if (providers.length > 0) {
          const first = providers[0];
          if (typeof first === 'string') return providers as string[];
          return (providers as Array<{ id: string; name: string }>).map((p) => p.id);
        }
      }
    } catch {
      // 忽略
    }

    return this.settings.readProviders();
  }

  // ── 私有方法 ──

  /** 2026-09-11: 模型偏好绑定会话 —— key = sessionKey@sessionId; 无 sessionId 时回退 peer 级(旧数据/单会话) */
  private overrideKey(sessionKey: string, sessionId?: string): string {
    return sessionId ? `${sessionKey}@${sessionId}` : sessionKey;
  }

  private readFromHost(): ModelRoute | undefined {
    try {
      const agentDefaultModel = this.getService('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } }
        | undefined;

      if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
        const selection = agentDefaultModel.currentSelection();
        if (selection?.provider && selection?.model) {
          return { provider: selection.provider, model: selection.model };
        }
      }
    } catch (err) {
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
  private getService(name: string): unknown {
    const ctxAny = this.ctx as unknown as Record<string, unknown>;
    if (typeof ctxAny.get === 'function') {
      try {
        const viaGet = (ctxAny.get as (key: string) => unknown)(name);
        if (viaGet !== undefined && viaGet !== null) return viaGet;
      } catch { /* fallthrough 属性访问 */ }
    }
    try {
      return ctxAny[name];
    } catch {
      return undefined;
    }
  }
}

// ── 诊断输出(2026-09-13 主人要求): **默认静默** —— 插件用户不需要这些调试噪音,
//    排障时设环境变量 DSH_QQBOT_DEBUG=1 即可全部打出来。
function dbg(msg: string): void {
  if (process.env.DSH_QQBOT_DEBUG) console.log(msg);
}
