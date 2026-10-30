/**
 * 预设切换卡片(2026-09-10): /preset 无参时发一张带按钮的卡片,
 * 每个可选人格一个按钮, 点击即热切换(宿主 agentPresets.recompose)。
 *
 * 交互设计仿 botplay 目录卡翻页(参考 features/botplay.ts catalogKeyboard):
 *   - 每行 2 个按钮, 最多 4 行 = 8 个/页, 第 5 行留翻页导航(◀上一页/下一页▶);
 *   - 按钮 data = `ps:<page>:<idx>`(page=页码, idx=该页内序号);
 *   - interaction 回调(INTERACTION_CREATE type=11)解析后直接调 manager.switchPreset。
 */
import type { QQBotSender } from '../transport/outbound-buffer.js';
import type { SessionManager } from '../session/session-manager.js';

/** 按钮回调数据前缀 */
const BTN_PREFIX = 'ps:';
/** 每页行数(第5行留给翻页导航, 对齐 QQ 按钮最多5行) */
const MAX_ROWS = 4;
/** 每行按钮数 */
const COLS = 2;
/** 每页预设数 */
const PER_PAGE = MAX_ROWS * COLS;

// ── 模块级注册表(bootstrap 接线; 命令层经它发卡片, 仿 botplay 范式) ──

type PresetCardImpl = (
  target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0],
  scope: 'group' | 'c2c',
  peerId: string,
  page?: number,
) => Promise<string>;

/** ⚠️ 2026-09-11 多实例修复: 原模块级单例会被多个实例互相覆盖(和 outbound writer/botplay 同款 bug,
 *  实测 /preset 无参发卡失败/发到别的实例)。改为按 ns 注册表。 */
const presetCardImpls = new Map<string, PresetCardImpl>();

/** bootstrap 接线: 注入真实实现(按实例 ns) */
export function setPresetCardImpl(ns: string, impl: PresetCardImpl | undefined): void {
  if (impl) presetCardImpls.set(ns, impl);
  else presetCardImpls.delete(ns);
}

/** 命令层调用: 发预设选择卡片(带当前实例 ns) */
export async function sendPresetCard(
  ns: string,
  target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0],
  scope: 'group' | 'c2c',
  peerId: string,
  page = 0,
): Promise<string> {
  const impl = presetCardImpls.get(ns);
  if (!impl) {
    if (presetCardImpls.size === 1) return (presetCardImpls.values().next().value as PresetCardImpl)(target, scope, peerId, page);
    return '预设切换卡片未就绪(宿主未接线), 可用 /presets 查看、/preset <id> 切换';
  }
  return impl(target, scope, peerId, page);
}

/**
 * 解析 preset 按钮数据: `ps:<page>:<idx>` → {page, idx}; 非本卡片按钮返回 null。
 * prev/next 为翻页导航(同前缀, idx 用字符串区分)。
 */
export function parsePresetButton(data: string | undefined): { page: number; idx: number } | 'prev' | 'next' | null {
  if (!data || !data.startsWith(BTN_PREFIX)) return null;
  const rest = data.slice(BTN_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 2) return null;
  const [pageStr, key] = parts;
  const page = Number(pageStr);
  if (!Number.isInteger(page) || page < 0) return null;
  if (key === 'prev' || key === 'next') return key;
  const idx = Number(key);
  return Number.isInteger(idx) && idx >= 0 ? { page, idx } : null;
}

/** 从按钮 data 提取页码(翻页导航用; 无效返回 0) */
function pageOfData(data: string | undefined): number {
  if (!data || !data.startsWith(BTN_PREFIX)) return 0;
  const page = Number(data.slice(BTN_PREFIX.length).split(':')[0]);
  return Number.isInteger(page) && page >= 0 ? page : 0;
}

/** 构造预设选择卡片 keyboard(仿 botplay catalogKeyboard: 每行2个 + 翻页行) */
function presetKeyboard(page: number, presets: Array<{ id: string; name?: string }>, currentId?: string) {
  const pages = Math.max(1, Math.ceil(presets.length / PER_PAGE));
  const safePage = Math.min(page, pages - 1);
  const start = safePage * PER_PAGE;
  const pagePresets = presets.slice(start, start + PER_PAGE);

  const btn = (label: string, key: string, style: number) => ({
    id: `${BTN_PREFIX}${safePage}:${key}`,
    render_data: {
      label: String(label).slice(0, 24),
      visited_label: String(label).slice(0, 24),
      style,
    },
    action: {
      type: 1,
      permission: { type: 2 }, // 群聊谁都可见可点(切人格不是敏感操作)
      data: `${BTN_PREFIX}${safePage}:${key}`,
      unsupport_tips: '请直接回复 /preset <id>',
    },
  });

  const rows: Array<{ buttons: unknown[] }> = [];
  // 预设按钮: 每行 COLS 个, 最多 MAX_ROWS 行(第5行留给翻页导航 → 合计≤5行)
  for (let i = 0; i < pagePresets.length && rows.length < MAX_ROWS; i += COLS) {
    const rowIdx = i; // 页面内起点序号
    rows.push({
      buttons: pagePresets.slice(i, i + COLS).map((p, j) =>
        btn(p.name || p.id, String(rowIdx + j), p.id === currentId ? 1 : 0)
      ),
    });
  }
  // 翻页行: 上一页 + 下一页(仿 botplay; 页码显示在 markdown 文本里)
  const navBtns: Array<ReturnType<typeof btn>> = [];
  if (safePage > 0) navBtns.push(btn('◀ 上一页', 'prev', 0));
  if (safePage < pages - 1) navBtns.push(btn('下一页 ▶', 'next', 0));
  if (navBtns.length > 0) rows.push({ buttons: navBtns });
  return { content: { rows } };
}

export class PresetSwitcherController {
  constructor(
    private readonly manager: SessionManager,
    private readonly sender: QQBotSender,
    private readonly logger: { info?: (m: string) => void; warn?: (m: string) => void },
    /**
     * 主人白名单（config.groupAdmin.owners）。
     *
     * ★ 2026-10-30 补（主人小号实测报的洞）：
     *   「我怎么点击切换人格，照样生效了，人格卡片发出来，点击按钮没有做 openid 校验」
     *   —— 以前只有 model 卡片校验了点击者，preset 卡片**谁点都算**，
     *   于是群里任何人（哪怕只是转发的卡）都能把主人切好的人格再切回去。
     *   切人格 = 改 AI 行为，属于管理动作，同样只能白名单点。
     */
    private readonly owners: () => string[] = () => [],
  ) {}

  /** 点击者是否有权（名单为空 ⇒ 交给命令侧那套"去配置"提示，这里不额外拦） */
  private clickerAllowed(ev: { group_member_openid?: string; user_openid?: string }): { ok: boolean; who: string } {
    const who = String(ev?.group_member_openid ?? ev?.user_openid ?? '').trim();
    const list = this.owners().map((x) => String(x ?? '').trim()).filter(Boolean);
    if (list.length === 0) return { ok: true, who };
    return { ok: !!who && list.includes(who), who };
  }

  /** 发预设选择卡片(某页)。返回给人看的摘要文本(命令 handler 用)。 */
  async sendCard(
    target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0],
    scope: 'group' | 'c2c',
    peerId: string,
    page = 0,
  ): Promise<string> {
    const list = await this.manager.listPresets();
    const available = list.filter((p) => !p.broken);
    if (available.length === 0) return '宿主暂未提供 agent preset(或未挂载 agentPresets 服务)';
    const current = this.manager.getEffectivePreset(scope, peerId);

    const pages = Math.max(1, Math.ceil(available.length / PER_PAGE));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    const start = safePage * PER_PAGE;
    const shown = available.slice(start, start + PER_PAGE);

    const lines = [
      '### 🧬 热切换人格',
      '',
      `**当前:** ${current ?? '宿主默认'}`,
      '',
      ...shown.map((p) => `- ${p.name || p.id}${p.id === current ? ' ⭐' : ''}`),
      '',
      pages > 1 ? `第 ${safePage + 1}/${pages} 页 · 点按钮立即切换(共 ${available.length} 个)` : `点按钮立即切换(共 ${available.length} 个)`,
      '',
      '对话历史保留, 即时生效。',
    ];
    const content = lines.join('\n');
    try {
      await this.sender.sendMarkdownWithKeyboard(target, content, presetKeyboard(safePage, available, current));
      return `✅ 已发出人格切换卡片(第 ${safePage + 1}/${pages} 页)`;
    } catch (err) {
      this.logger.warn?.(`[preset-switcher] 卡片发送失败: ${err instanceof Error ? err.message : String(err)}`);
      return `⚠️ 卡片发送失败, 请直接 /preset <id> 切换`;
    }
  }

  /** interaction 回调: 解析 ps:<page>:<idx|prev|next> → 切换或翻页。@returns true=已消费 */
  async handleInteraction(
    event: unknown,
    target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0],
    scope: 'group' | 'c2c',
    peerId: string,
  ): Promise<boolean> {
    const e = event as {
      data?: { type?: number; resolved?: { button_data?: string } };
      group_member_openid?: string;
      user_openid?: string;
    };
    if (e?.data?.type !== 11) return false;
    const parsed = parsePresetButton(e.data.resolved?.button_data);
    if (parsed === null) return false;

    // ★ 2026-10-30：切人格是管理动作，只认白名单点击者（与 model 卡同一口径）
    const gate = this.clickerAllowed(e);
    if (!gate.ok) {
      this.logger.warn?.(`[preset-switcher] 按钮被拒（非白名单点击者）: ${gate.who.slice(0, 8)}…`);
      try { await this.sender.sendMarkdown(target, '⚠️ 切人格只有主人能点哦。'); } catch { /* ignore */ }
      return true;
    }

    try {
      const list = await this.manager.listPresets();
      const available = list.filter((p) => !p.broken);
      const pages = Math.max(1, Math.ceil(available.length / PER_PAGE));

      // 翻页导航: 按钮 data 里 page 字段 = 当前页
      if (parsed === 'prev') {
        const cur = pageOfData(e.data.resolved?.button_data);
        await this.sendCard(target, scope, peerId, Math.max(0, cur - 1));
        return true;
      }
      if (parsed === 'next') {
        const cur = pageOfData(e.data.resolved?.button_data);
        await this.sendCard(target, scope, peerId, Math.min(cur + 1, pages - 1));
        return true;
      }

      const pageStart = parsed.page * PER_PAGE;
      const pick = available[pageStart + parsed.idx];
      if (!pick) {
        await this.sender.sendMarkdown(target, '这个预设已不存在, 请重新发 /preset 刷新卡片~');
        return true;
      }
      const r = await this.manager.switchPreset(scope, peerId, pick.id);
      if (r === 'ok') {
        const label = pick.name ? `${pick.name}(${pick.id})` : pick.id;
        await this.sender.sendMarkdown(target, `✅ 已热切换人格为「${label}」，对话历史保留，即时生效！`);
      } else {
        await this.sender.sendMarkdown(target, `⚠️ 切换「${pick.id}」失败(${r}), 可试 /new <id> 开新档`);
      }
      return true;
    } catch (err) {
      this.logger.warn?.(`[preset-switcher] 回调处理异常: ${err instanceof Error ? err.message : String(err)}`);
      await this.sender.sendMarkdown(target, '⚠️ 切换异常, 请重试或 /preset <id> 手动切换');
      return true;
    }
  }
}
