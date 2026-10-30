/**
 * 模型切换卡片(2026-10-30)：`/model`、`/bot-model` 不带参数**或参数不是已存在的模型**时，
 * 发一张带按钮的卡片让主人点选，而不是回一行干巴巴的"用法: /xxx provider/model"。
 *
 * 结构完全照 `features/preset-switcher.ts`（主人要求"参考扩展命令/子会话"那套）：
 *   · 每行 2 个按钮、最多 4 行 = 8 个/页，第 5 行留给翻页导航（QQ 按钮最多 5 行）
 *   · 按钮 data = `mdl:<page>:<idx>`
 *   · interaction（INTERACTION_CREATE type=11）解析后直接调 manager.setModelOverride
 *
 * ⚠️ 为什么要做这个（主人原话）：
 *   「参数不对，指的是没有对应的模型，以前没输入错误参数也能"换模型"，但实际上 api 报错」
 *   —— 以前 `setModelOverride` 不校验模型存不存在，传个瞎写的 model 也回"✅ 已切换"，
 *   直到下一句话真的去调 API 才炸。现在改成：**校验不通过就发卡片**，让用户点真实的模型。
 */
import type { QQBotSender } from '../transport/outbound-buffer.js';
import type { SessionManager } from '../session/session-manager.js';

/** 按钮回调数据前缀 */
const BTN_PREFIX = 'mdl:';
/**
 * 布局照 `/子会话` 的模型选择卡（主人 2026-10-30 指定参考）：
 *   每行 **5 个**，最多 **4 行**选项（=20 个/页），第 5 行留给翻页导航；
 *   按钮上显示**字母**（A/B/C…），列表正文里 `**A**. 模型名` 一一对应。
 *   这样一页能塞下 20 个模型，比原先每行 2 个省一半翻页。
 */
const MAX_ROWS = 4;
const COLS = 5;
const PER_PAGE = MAX_ROWS * COLS;
/** 按钮字母（与正文列表对应） */
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'];

type ModelCardImpl = (
  target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0],
  scope: 'group' | 'c2c',
  peerId: string,
  page?: number,
) => Promise<string>;

/** 按 ns 注册（多实例：不能只用模块级单例，否则实例间互相覆盖 —— preset-switcher 踩过） */
const modelCardImpls = new Map<string, ModelCardImpl>();

export function setModelCardImpl(ns: string, impl: ModelCardImpl | undefined): void {
  if (impl) modelCardImpls.set(ns, impl);
  else modelCardImpls.delete(ns);
}

/** 命令层调用：发模型选择卡片 */
export async function sendModelCard(
  ns: string,
  target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0],
  scope: 'group' | 'c2c',
  peerId: string,
  page = 0,
): Promise<string> {
  const impl = modelCardImpls.get(ns);
  if (!impl) {
    if (modelCardImpls.size === 1) return (modelCardImpls.values().next().value as ModelCardImpl)(target, scope, peerId, page);
    return '模型选择卡片未就绪（宿主未接线），可用 /model 手动指定 provider/model';
  }
  return impl(target, scope, peerId, page);
}

/** 解析按钮 data：`mdl:<page>:<idx|prev|next>` */
export function parseModelButton(data: string | undefined): { page: number; idx: number } | 'prev' | 'next' | null {
  if (!data || !data.startsWith(BTN_PREFIX)) return null;
  const parts = data.slice(BTN_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  const page = Number(parts[0]);
  if (!Number.isInteger(page) || page < 0) return null;
  const [, key] = parts;
  if (key === 'prev' || key === 'next') return key;
  const idx = Number(key);
  return Number.isInteger(idx) && idx >= 0 ? { page, idx } : null;
}

function pageOfData(data: string | undefined): number {
  if (!data || !data.startsWith(BTN_PREFIX)) return 0;
  const page = Number(data.slice(BTN_PREFIX.length).split(':')[0]);
  return Number.isInteger(page) && page >= 0 ? page : 0;
}

/** 构造键盘（每行 2 个 + 翻页行） */
function modelKeyboard(
  page: number,
  models: Array<{ provider: string; id: string; name?: string }>,
  current?: { provider: string; model: string },
) {
  const pages = Math.max(1, Math.ceil(models.length / PER_PAGE));
  const safePage = Math.min(page, pages - 1);
  const start = safePage * PER_PAGE;
  const shown = models.slice(start, start + PER_PAGE);

  const btn = (label: string, key: string, style: number) => ({
    id: `${BTN_PREFIX}${safePage}:${key}`,
    render_data: {
      label: String(label).slice(0, 24),
      visited_label: String(label).slice(0, 24),
      style,
    },
    action: {
      type: 1,
      // ⚠️ 2026-10-30：模型切换是管理动作 ⇒ 按钮只对**指定用户**可见可点
      //   （permission.type=2 表示"仅指定用户"；这里仍按群里所有人都能看见渲染，
      //     真正的门控在命令侧 authorized + 下面 handleInteraction 里的白名单校验）
      permission: { type: 2 },
      data: `${BTN_PREFIX}${safePage}:${key}`,
      unsupport_tips: '请直接回复 /model provider/model',
    },
  });

  const rows: Array<{ buttons: unknown[] }> = [];
  for (let i = 0; i < shown.length && rows.length < MAX_ROWS; i += COLS) {
    rows.push({
      buttons: shown.slice(i, i + COLS).map((m, j) => {
        const isCur = !!current && current.provider === m.provider && current.model === m.id;
        // 按钮文字用字母（模型名太长会挤成省略号，正文里有对照表）
        return btn(LETTERS[i + j] ?? String(i + j), String(i + j), isCur ? 1 : 0);
      }),
    });
  }
  const nav: Array<ReturnType<typeof btn>> = [];
  if (safePage > 0) nav.push(btn('◀ 上一页', 'prev', 0));
  if (safePage < pages - 1) nav.push(btn('下一页 ▶', 'next', 0));
  if (nav.length) rows.push({ buttons: nav });
  return { content: { rows } };
}

export class ModelSwitcherController {
  /**
   * 取**全部**服务商的模型，按 provider 分组排序（照 `/子会话` 的做法）。
   *
   * 2026-10-30 主人要求：「其余服务商的也要显示出来啊，包括翻页功能」
   *   —— 以前这里 `filter(m => m.provider === current.provider)`，只能看到当前那一家。
   */
  private async allModels(): Promise<Array<{ provider: string; id: string; name?: string }>> {
    const all = await this.manager.listAvailableModels();
    // 先按 provider 聚在一起（同名模型跨 provider 时，靠分组标题区分）
    return [...all].sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
  }

  constructor(
    private readonly manager: SessionManager,
    private readonly sender: QQBotSender,
    private readonly logger: { info?: (m: string) => void; warn?: (m: string) => void },
    /** 主人白名单（config.groupAdmin.owners）。按钮点击也要校验 —— 卡片可能被转发给别人 */
    private readonly owners: () => string[] = () => [],
  ) {}

  /** 点击者是否有权（白名单为空 ⇒ 放行到"提示去配置"那一步，与命令侧一致） */
  private clickerAllowed(ev: { group_member_openid?: string; user_openid?: string }): { ok: boolean; who: string } {
    const who = String(ev?.group_member_openid ?? ev?.user_openid ?? '').trim();
    const list = this.owners().map((x) => String(x ?? '').trim()).filter(Boolean);
    if (list.length === 0) return { ok: true, who };       // 没配名单：交给命令侧那套提示
    return { ok: !!who && list.includes(who), who };
  }

  /** 发模型选择卡片（某页）。返回给人看的摘要文本。 */
  async sendCard(
    target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0],
    scope: 'group' | 'c2c',
    peerId: string,
    page = 0,
  ): Promise<string> {
    const current = this.manager.getEffectiveModel(scope, peerId);
    const models = await this.allModels();
    if (models.length === 0) return '宿主没提供可用模型列表，请用 /bot-model provider/model 手动指定';

    const pages = Math.max(1, Math.ceil(models.length / PER_PAGE));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    const start = safePage * PER_PAGE;
    const shown = models.slice(start, start + PER_PAGE);

    const curLabel = (() => {
      if (!current) return '宿主默认配置';
      return `${current.provider}/${current.model}`;
    })();

    const lines = [
      '### 🤖 切换模型',
      '',
      `**当前:** ${curLabel}`,
      '',
      // 按 provider 分段显示（同 /子会话）：provider 不进按钮文字，只在正文做小标题
      ...(() => {
        const out: string[] = [];
        let lastGroup = '';
        shown.forEach((m, i) => {
          if (m.provider !== lastGroup) {
            out.push('', `**── ${m.provider} ──**`);
            lastGroup = m.provider;
          }
          const isCur = !!current && current.provider === m.provider && current.model === m.id;
          // 2026-10-30 主人补充：「服务商也要显示出来」—— 每条都带上 provider，
          //   翻页把分组切断时也能一眼看出是哪家（前面还有 ── provider ── 小标题）
          out.push(`**${LETTERS[i] ?? i + 1}**. ${m.name || m.id} · \`${m.provider}\`${isCur ? ' ⭐' : ''}`);
        });
        return out;
      })(),
      '',
      pages > 1 ? `第 ${safePage + 1}/${pages} 页 · 点按钮立即切换（共 ${models.length} 个）` : `点按钮立即切换（共 ${models.length} 个）`,
      '',
      '⚠️ 刚才的参数没匹配到任何已存在的模型，避免切到一个会报错的 id，所以改发这张卡。',
    ];
    try {
      await this.sender.sendMarkdownWithKeyboard(target, lines.join('\n'), modelKeyboard(safePage, models, current));
      return `✅ 已发出模型切换卡片（第 ${safePage + 1}/${pages} 页）`;
    } catch (err) {
      this.logger.warn?.(`[model-switcher] 卡片发送失败: ${err instanceof Error ? err.message : String(err)}`);
      return '⚠️ 卡片发送失败，请直接用 /bot-model provider/model 指定';
    }
  }

  /** interaction 回调：`mdl:<page>:<idx|prev|next>`。@returns true=已消费 */
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
    const parsed = parseModelButton(e.data.resolved?.button_data);
    if (parsed === null) return false;

    // ★ 2026-10-30 主人要求「选择模型同样只能白名单」：卡片可能被转发，不能只看"谁发的卡"
    const gate = this.clickerAllowed(e);
    if (!gate.ok) {
      this.logger.warn?.(`[model-switcher] 按钮被拒（非白名单点击者）: ${gate.who.slice(0, 8)}…`);
      try { await this.sender.sendMarkdown(target, '⚠️ 切模型只有主人能点哦。'); } catch { /* ignore */ }
      return true;
    }

    try {
      const models = await this.allModels();
      const pages = Math.max(1, Math.ceil(models.length / PER_PAGE));

      if (parsed === 'prev') {
        await this.sendCard(target, scope, peerId, Math.max(0, pageOfData(e.data.resolved?.button_data) - 1));
        return true;
      }
      if (parsed === 'next') {
        await this.sendCard(target, scope, peerId, Math.min(pageOfData(e.data.resolved?.button_data) + 1, pages - 1));
        return true;
      }

      const pick = models[parsed.page * PER_PAGE + parsed.idx];
      if (!pick) {
        await this.sender.sendMarkdown(target, '这个模型已不在列表里了，重新发 /model 刷一下卡片~');
        return true;
      }
      await this.manager.setModelOverride(scope, peerId, { provider: pick.provider, model: pick.id });
      await this.sender.sendMarkdown(
        target,
        `✅ 模型已切换: ${pick.name || pick.provider + '/' + pick.id}\n立即生效，对话上下文保留。`,
      );
      return true;
    } catch (err) {
      this.logger.warn?.(`[model-switcher] 回调异常: ${err instanceof Error ? err.message : String(err)}`);
      await this.sender.sendMarkdown(target, '⚠️ 切换异常，请重试或 /bot-model provider/model 手动切换');
      return true;
    }
  }
}
