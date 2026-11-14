/**
 * 出站模式命令：/outmode — 查看/切换四档模式(逃生通道, 2026-09-07)
 *
 * 四档: adaptive=适配主动(默认) / passive=被动 / silent=完全不出站 / nothink=完全不思考。
 * ⚠️ 此命令走 SDK 斜杠直通不经 LLM —— 即使机器人处于 nothink(不思考)也能被主人唤醒:
 *    `/outmode adaptive` 一条即可切回。命令层允许切到 nothink(主人逃生/主动休眠都行),
 *    但 channel-tools 的 AI 工具 outbound_mode 禁止写入 nothink(防机器人自锁)。
 *
 * 切换实现走 outbound-mode-switch 注册表(index.ts 注册): 改 live config 立即热生效 +
 * settings 持久化 → dock/设置面板与 live 三方一致。
 *
 * 切换后通知 AI(回合安全, 2026-09-09 主人定/修复):
 *   斜杠命令不经 LLM → AI 不知道模式被切。用宿主的 agent.inject 注入一条
 *   "模式已切换" 消息(不唤醒)。⚠️ 必须在 AI 回合结束后注入:
 *   回合中(assistant tool_calls 未结算)往会话塞消息会把 tool_calls 与其 tool 结果
 *   拆开 → 下次请求 INVALID_REQUEST(insufficient tool messages)。
 *   做法: 先回执给主人, 后台 await agent.whenIdle()(回合结束)后再 inject ——
 *   与 QQ 入站"回合中攒消息、turn/end 后整批进上下文"同一安全语义。
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { CommandDeps } from './types.js';
import { normalizeOutboundMode, switchOutboundMode } from '../features/outbound-mode-switch.js';
import type { ImQQBotConfig } from '../config.js';
import { getScopePeer } from '../shared/index.js';
import { skipSilentAppend } from '../session/surface-guard.js';

const LABEL: Record<string, string> = {
  adaptive: '适配主动(默认): 收到真人消息前5条带引用回你, 之后自动转独立消息',
  detail: '详细主动(2026-09-11 新增): 和适配主动一样聊天, 但额外把 AI 的工具调用/工具结果也推到 QQ(能看进度, 消息会变多)',
  passive: '被动: 始终回复你那条(连发约4~5条后被QQ吞)',
  silent: '完全不出站: 照常思考但不向QQ发任何回复(web可对话)',
  nothink: '完全不思考: QQ入站不唤醒AI, 仅记录上下文(web对话仍可看到群聊)',
};

function currentOf(config: ImQQBotConfig): string {
  return normalizeOutboundMode(config.outboundMode);
}

/** 回合结束后注入"模式已切换"(fire-and-forget; 命令先回执不等回合) */
async function noteModeChange(manager: CommandDeps['manager'], cmdCtx: unknown, mode: string): Promise<void> {
  try {
    const { scope, peerId } = getScopePeer(cmdCtx as never);
    const record = manager.findByPeer(scope, peerId);
    const agent = record?.agent as
      | ({ whenIdle?: () => Promise<void>; inject?: (m: unknown) => void } & {
          session?: { append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown };
        })
      | undefined;
    if (!agent) return;
    const text = `[主人切换了出站模式] 现在: ${mode} — ${LABEL[mode] ?? ''}`;
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    const doInject = (): void => {
      if (typeof agent.inject === 'function') {
        agent.inject(msg); // 宿主回合安全注入: 不唤醒, 排到下个 step 组包
        return;
      }
      const sess = agent.session;
      // ★ 2026-10-06: 人设未落盘 ⇒ 不能静默 append（会把会话日志写废，见 session/surface-guard.ts）
      if (sess && typeof sess.append === 'function' && !skipSilentAppend(agent, undefined, 'outmode')) {
        sess.append('user/message', msg, { surfaceOp: 'append' });
      }
    };
    // 等当前回合结束再注入(回合空闲时 whenIdle 立即返回)
    await (typeof agent.whenIdle === 'function' ? agent.whenIdle().catch(() => undefined) : Promise.resolve());
    doInject();
  } catch {
    /* 通知失败不影响切换本身 */
  }
}

export function outModeCommand({ manager, config }: CommandDeps): SlashCommand {
  return {
    name: 'outmode',
    description: '查看/切换出站模式(用法: /outmode [adaptive|detail|passive|silent|nothink])',
    handler: async (cmdCtx) => {
      const args = String((cmdCtx.command?.raw ?? '').trim());
      const cur = currentOf(config);
      if (!args) {
        const lines = ['### ⇄ 出站模式', '', `**当前: ${cur}**`, '', '可用模式(直接发 `/outmode 模式名` 切换, 立即生效):'];
        for (const key of ['adaptive', 'detail', 'passive', 'silent', 'nothink']) {
          lines.push(`- **${key}** — ${LABEL[key]}`);
        }
        return lines.join('\n');
      }
      // ★★ 2026-11-14 修（审查发现）：**非法参数原来会被静默归一成 adaptive**。
      //   打 /outmode pasive（拼错）或 /outmode 静默 → 静默切到 adaptive（原设置被改掉），
      //   回执还写着'已切换: adaptive' —— 主人以为在被动模式，实际开始主动连发。
      //   现在：不认识就直接拒绝，**不改配置**。
      const rawMode = String(args).toLowerCase().trim();
      const VALID_MODES = ['adaptive', 'detail', 'passive', 'silent', 'nothink'] as const;
      if (!(VALID_MODES as readonly string[]).includes(rawMode)) {
        return '未知的出站模式: **' + args + '**（未做任何修改）\n可用: ' + VALID_MODES.join(' / ');
      }
      const want = normalizeOutboundMode(rawMode);
      // 多实例修复(2026-09-11): 带当前实例 ns —— 原全局单例 writer 会被多实例互相覆盖,
      // /outmode 在本实例会话执行却切到别的实例的 config(dock 显示与实际不符, nothink 不生效)。
      const ns = (String(config.settingsNs ?? '').trim() || 'im-qqbot');
      const r = await switchOutboundMode(want, ns);
      if (r.ok) {
        // 先回执; 后台等回合结束再通知 AI(回合安全, 不拆 tool_calls)
        void noteModeChange(manager, cmdCtx, r.mode);
      }
      return r.ok ? `✅ 出站模式已切换: **${r.mode}**\n${LABEL[r.mode] ?? ''}` : `切换失败: ${r.msg}`;
    },
  };
}
