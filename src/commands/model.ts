/**
 * 模型命令：/bot-model — 查看或切换模型
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { CommandDeps } from './types.js';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.js';
import { sendModelCard } from '../features/model-switcher.js';
import { resolveCommandTarget } from '../features/botplay.js';

export function modelCommand({ manager, config }: CommandDeps): SlashCommand {
  return {
    name: 'bot-model',
    description: '查看或切换模型（用法: /bot-model [provider/model]）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();

      // ── 无参数：先发**模型选择卡片**（2026-10-30 主人要求：点按钮选，比甩一坨列表清楚）
      if (!args) {
        const ns = String((config as { settingsNs?: string }).settingsNs ?? '').trim() || 'im-qqbot';
        try {
          const { target } = resolveCommandTarget(cmdCtx as never);
          if (target && target.targetId) return sendModelCard(ns, target, scope as 'group' | 'c2c', peerId, 0);
        } catch { /* 拿不到 target 就退回下面的文本列表 */ }
      }

      // 无参数（卡片发不出去时）兜底：显示当前模型 + 可用模型列表
      if (!args) {
        const current = manager.getEffectiveModel(scope, peerId);
        const all = await manager.listAvailableModels();
        // 2026-09-11 主人要求: 只显示当前服务商(provider)的模型 —— 点按钮只传模型名,
        // provider 继承当前路由, 列表混杂其他服务商反而误导。
        const models = current?.provider ? all.filter((m) => m.provider === current.provider) : all;

        // 当前模型展示：优先用别名（name），找不到别名时回退到 provider/model id
        let currentDisplay = '宿主默认配置';
        if (current) {
          const matched = models.find((m) => m.provider === current.provider && m.id === current.model);
          currentDisplay = matched?.name ?? `${current.provider}/${current.model}`;
        }

        const lines: string[] = [
          '### 🤖 模型配置',
          '',
          `**当前模型:** ${currentDisplay}`,
        ];

        if (models.length > 0) {
          lines.push('', '**可用模型（点击切换）:**');
          for (const m of models) {
            const modelPath = `${m.provider}/${m.id}`;
            const displayName = m.name ? `${m.name}` : modelPath;
            lines.push(`<qqbot-cmd-input text="/bot-model ${modelPath}" show="/bot-model ${displayName}"/>`);
          }
        }

        lines.push('', '手动指定: `/bot-model provider/model`');

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      // 解析 provider/model 格式
      let provider: string;
      let model: string;

      if (args.includes('/')) {
        const parts = args.split('/');
        provider = parts[0] ?? '';
        model = parts.slice(1).join('/');
      } else {
        // 仅指定 model 名，provider 从当前路由继承
        const current = manager.getEffectiveModel(scope, peerId);
        provider = current?.provider ?? 'deepseek-official';
        model = args;
      }

      if (!provider || !model) {
        return '用法: /bot-model provider/model\n示例: /bot-model deepseek-official/deepseek-flash';
      }

      // ★ 2026-10-30 修（主人原话：「参数不对，指的是没有对应的模型，以前没输入错误参数也能换模型，
      //   但实际上 api 报错」）—— 现在**先校验模型是否存在**，对不上就发选择卡片，别再假装切换成功。
      const available = await manager.listAvailableModels();
      const hit = available.find((m) => m.provider === provider && (m.id === model || m.name === model));
      if (!hit) {
        const ns = String((config as { settingsNs?: string }).settingsNs ?? '').trim() || 'im-qqbot';
        const near = available
          .filter((m) => m.provider === provider || m.id === model)
          .slice(0, 3)
          .map((m) => `${m.provider}/${m.id}`)
          .join('、');
        let cardMsg = '';
        try {
          const { target } = resolveCommandTarget(cmdCtx as never);
          if (target && target.targetId) cardMsg = await sendModelCard(ns, target, scope as 'group' | 'c2c', peerId, 0);
        } catch { /* ignore */ }
        const tip = near ? `\n你是不是想用: ${near}` : '';
        return `⚠️ 没有这个模型: ${provider}/${model}${tip}\n${cardMsg || '可用 /bot-model 不带参数查看全部可选模型'}`;
      }

      await manager.setModelOverride(scope, peerId, { provider, model: hit.id });
      return `✅ 模型已切换: ${provider}/${model}\n立即生效，对话上下文保留。`;
    },
  };
}

/** /model 简写别名: 复用 /bot-model 同一 handler */
export function modelAliasCommand(deps: CommandDeps): SlashCommand {
  const base = modelCommand(deps);
  return { name: 'model', description: '查看或切换模型(简写, 同 /bot-model)', handler: base.handler };
}

