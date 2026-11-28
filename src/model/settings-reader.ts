/**
 * SettingsReader — settings.yaml 只读解析
 *
 * 从 {DSH_HOME|~/.dsh}/settings.yaml 中读取模型配置信息。
 * 只读，不修改 settings.yaml。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDshHome } from '../shared/utils.js';
import yaml from 'js-yaml';
import type { ModelRoute, ModelEntry } from './types.js';

/** settings.yaml 中的 provider 配置结构 */
interface SettingsProviderConfig {
  models?: Array<{ id?: string; name?: string }>;
  [key: string]: unknown;
}

/** settings.yaml 的 llm-pi-ai 段结构 */
interface LlmPiAiSettings {
  providers?: Record<string, SettingsProviderConfig>;
}

export class SettingsReader {
  /** settings.yaml 缓存 */
  private settingsCache: Record<string, unknown> | null | undefined;

  /**
   * 从 settings.yaml 的 agent-default-model 字段读取默认模型路由
   */
  readDefaultRoute(): ModelRoute | undefined {
    const settings = this.loadSettings();
    if (!settings) return undefined;

    const defaultModel = settings['agent-default-model'] as
      | { provider?: string; model?: string }
      | undefined;

    if (defaultModel?.provider && defaultModel?.model) {
      return { provider: defaultModel.provider, model: defaultModel.model };
    }
    return undefined;
  }

  /**
   * 列出 settings.yaml 中配置的所有模型
   */
  readModels(): ModelEntry[] {
    const settings = this.loadSettings();
    if (!settings) return [];

    const models: ModelEntry[] = [];
    const llmPiAi = settings['llm-pi-ai'] as LlmPiAiSettings | undefined;

    if (llmPiAi?.providers) {
      for (const [providerName, providerConfig] of Object.entries(llmPiAi.providers)) {
        if (Array.isArray(providerConfig?.models)) {
          for (const m of providerConfig.models) {
            if (m.id) {
              models.push({ provider: providerName, id: m.id, name: m.name || undefined });
            }
          }
        }
      }
    }

    return models;
  }

  /**
   * 列出 settings.yaml 中配置的 provider 名称
   */
  readProviders(): string[] {
    const settings = this.loadSettings();
    const llmPiAi = settings?.['llm-pi-ai'] as LlmPiAiSettings | undefined;
    return llmPiAi?.providers ? Object.keys(llmPiAi.providers) : [];
  }

  /**
   * 从 settings.yaml 的 <ns> 段读取 groupAdmin 配置。
   * 解决"QQBot 构造时 intents 一次性读取"的时序坑: settings 服务的 Web 可视化配置
   * (写 settings.yaml)是异步注入, 晚于 gateway 构造 → 启动期读文件才能在构造前拿到值。
   * 返回 undefined = settings.yaml 无该 ns 或 ns 无 groupAdmin。
   */
  readGroupAdmin(ns: string): Record<string, unknown> | undefined {
    const settings = this.loadSettings();
    if (!settings) return undefined;
    const nsBlock = settings[ns] as Record<string, unknown> | undefined;
    const ga = nsBlock?.groupAdmin as Record<string, unknown> | undefined;
    return ga && typeof ga === 'object' ? ga : undefined;
  }

  /**
   * 从 settings.yaml 的 <ns> 段读取群守则 groupPrompt(热更新用)。
   * fresh=true 时绕过缓存现读磁盘(每次 system prompt 渲染调用, 使 Web 改完即时生效);
   * 返回 undefined = 无该 ns / 无 groupPrompt / 空串。
   */
  readGroupPrompt(ns: string, fresh = false): string | undefined {
    const settings = this.loadSettings(fresh);
    if (!settings) return undefined;
    const nsBlock = settings[ns] as Record<string, unknown> | undefined;
    const gp = nsBlock?.groupPrompt;
    return typeof gp === 'string' && gp.trim() ? gp.trim() : undefined;
  }

  private loadSettings(fresh = false): Record<string, unknown> | null {
    if (!fresh && this.settingsCache !== undefined) return this.settingsCache;

    try {
      const settingsPath = resolve(resolveDshHome(), 'settings.yaml');
      if (!existsSync(settingsPath)) {
        this.settingsCache = null;
        return null;
      }
      const content = readFileSync(settingsPath, 'utf8');
      this.settingsCache = yaml.load(content) as Record<string, unknown> | null;
      return this.settingsCache;
    } catch {
      this.settingsCache = null;
      return null;
    }
  }
}
