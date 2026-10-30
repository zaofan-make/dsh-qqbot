/**
 * 杂项命令：/ping /version /stop
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import { readFileSync } from 'node:fs';
import type { CommandDeps } from './types.js';

/**
 * 读包内 package.json 的真实版本号(2026-09-11 修: 原实现硬编码 "v0.1.0" 一路没改, 版本显示骗人)。
 * dist/commands/misc.js → ../../package.json 即包根。
 */
function pkgVersion(): string {
  try {
    const p = new URL('../../package.json', import.meta.url);
    return String(JSON.parse(readFileSync(p, 'utf8')).version ?? 'unknown');
  } catch { return 'unknown'; }
}

/** /bot-ping — 测试当前 dsh 与 QQ 连接的网络延迟(对齐上游 0.5.0) */
export function pingCommand(): SlashCommand {
  return {
    name: 'bot-ping',
    description: '测试当前 dsh 与 QQ 连接的网络延迟',
    usage: [
      '/bot-ping',
      '',
      '测试 dsh 主机与 QQ 服务器之间的网络延迟。',
      '返回网络传输耗时和插件处理耗时。',
    ].join('\n'),
    handler: (ctx) => {
      const now = Date.now();
      const ts = ctx.message.timestamp;
      const eventTime = ts ? new Date(ts).getTime() : NaN;
      if (Number.isNaN(eventTime)) {
        return '✅ pong!';
      }
      const totalMs = now - eventTime;
      const qqToPlugin = ctx.receivedAt - eventTime;
      const pluginProcess = now - ctx.receivedAt;
      return [
        '✅ pong！',
        `⏱ 延迟: ${totalMs}ms`,
        `  ├ 网络传输: ${qqToPlugin}ms`,
        `  └ 插件处理: ${pluginProcess}ms`,
      ].join('\n');
    },
  };
}

/** /bot-version — 查看版本信息 */
export function versionCommand({ manager }: CommandDeps): SlashCommand {
  return {
    name: 'bot-version',
    description: '查看版本信息',
    handler: () => {
      const current = manager.getEffectiveModel('c2c', '');
      const modelInfo = current ? `${current.provider}/${current.model}` : '宿主默认';
      return `dsh-qqbot v${pkgVersion()} | model: ${modelInfo}`;
    },
  };
}

/**
 * /bot-me — 查看**你自己在「这个机器人」视角下的 openid**（2026-10-30，对齐上游 96ad70a9）
 *
 * 为什么有用（主人原话）：
 *   「群友可以获取自己对于那个机器人的 openid，并在群聊里显示，以便告诉机器人的主人添加白名单」
 *
 * ⚠️ 关键认知：openid 是**按 appId 隔离**的 —— 同一个 QQ 号，对不同机器人实例的 openid **不同**。
 *   所以这里特意带上「机器人 AppID」，主人配白名单时就知道该填到哪个实例上。
 *
 * 不限制白名单：它只是查自己的 id，无害（和 /presets 同理）。
 */
export function meCommand({ config }: CommandDeps): SlashCommand {
  return {
    name: 'bot-me',
    description: '查看你在这个机器人视角下的 OpenID（配白名单要用）',
    handler: async (cmdCtx) => {
      const msg = (cmdCtx as { message?: { senderId?: string; senderName?: string; groupOpenid?: string; kind?: string } }).message;
      const senderId = String(msg?.senderId ?? '').trim() || 'unknown';
      const appId = String((config as { appId?: string }).appId ?? '').trim() || '?';
      const isGroup = String(msg?.kind ?? '') === 'group';

      // 2026-10-30 主人：「用户无法便捷的复制粘贴」⇒ openid 单独占一行、不加反引号/加粗，
      //   长按就能整行选中（QQ 里代码块反而不好选）。
      const lines = [
        '🆔 你在本机器人视角下的身份',
        '',
        '你的 OpenID（长按这行复制）：',
        senderId,
        '',
        '机器人 AppID：',
        appId,
      ];
      if (isGroup && msg?.groupOpenid) {
        lines.push('', '本群 OpenID（长按这行复制）：', String(msg.groupOpenid));
      }
      lines.push(
        '',
        '怎么用：把这串 OpenID 发给机器人主人，让他加到「允许操作的主人 openid」里',
        '（设置 → QQ 机器人 → 设置 → 群管理基础设置），保存后就能用管理命令了。',
        '',
        '💡 同一个 QQ 号对不同的机器人（不同 AppID）openid 是不一样的，按 AppID 对应填。',
      );
      return lines.join('\n');
    },
  };
}

/** /bot-stop — 中止当前生成（隐藏） */
export function stopCommand(): SlashCommand {
  return {
    name: 'bot-stop',
    description: '中止当前生成',
    hidden: true,
    handler: () => ({ kind: 'noop' as const }),
  };
}

/** /tools-reload — 热刷新 QQ 通道工具与扩展命令(开发用, 2026-09-05): 新增工具即时生效, 无需重启宿主 */
export function toolsReloadCommand({ manager }: CommandDeps): SlashCommand {
  return {
    name: 'tools-reload',
    description: '热刷新 QQ 通道工具与扩展命令(开发用: 新工具无需重启即可用; 已有工具改动仍需重启)',
    hidden: true,
    handler: async () => manager.reloadAllChannelTools(),
  };
}
