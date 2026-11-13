/**
 * 入站消息标签形状回归（2026-09-15 主人复查"没 @ 的只显示昵称呢?"后加）。
 *
 * 口径（与群历史行一致，见 inbound.ts Layer 3 注释）：
 *   没被 @  → `[昵称 #短号] 正文`
 *   被 @ 了 → `[昵称 (openid) #短号] 正文 (@you)`
 *   短号两边都留 —— 引用标记 + id_lookup 反查 openid 的入口，不能省。
 *   私聊：**带** `[昵称 #短号] 正文`（2026-10-30 主人要求"私聊也要知道在跟谁说话"）；
 *         名字取不到时才退回 `[消息号: 短号]` 一行。
 *   群名片：只在"与账号名不同"时追加 `(群昵称:xxx)`，其余一律不加 ——
 *         senderName 本身不变（群友小传/台账/检索都按账号名）。
 *
 * ⚠️ 这里一律用**虚构昵称/虚构 id**（对外红线：真实昵称与 openid 禁入仓库）。
 */
import { describe, expect, it } from 'vitest';
import { buildUserMessage } from './inbound.js';

const ID = 'FB3FB5B8A7B65973682C3CFEEEEFB14A';
const NICK = '路人乙';
const CARD = '这是名片';

describe('buildUserMessage — 群聊发送者标签', () => {
  it('没被 @：只给昵称 + 短号，不给 openid', () => {
    expect(buildUserMessage('最近有啥好玩的', '', ID, NICK, true, false, '0915u4'))
      .toBe(`[${NICK} #0915u4] 最近有啥好玩的`);
  });

  it('被 @ 了：带上 openid（要回 @ 他）+ 正文后 (@you)，短号照旧', () => {
    expect(buildUserMessage('看这张图', '', ID, NICK, true, true, '0915u4'))
      .toBe(`[${NICK} (${ID}) #0915u4] 看这张图 (@you)`);
  });

  it('没有短号时（引用功能关）: 退化成纯昵称 / 昵称+openid', () => {
    expect(buildUserMessage('在吗', '', ID, NICK, true, false, '')).toBe(`[${NICK}] 在吗`);
    expect(buildUserMessage('在吗', '', ID, NICK, true, true, ''))
      .toBe(`[${NICK} (${ID})] 在吗 (@you)`);
  });

  it('群名片与账号名不同 → 追加显示，短号/结构不变', () => {
    expect(buildUserMessage('在吗', '', ID, NICK, true, false, '0915u4', CARD))
      .toBe(`[${NICK}(群昵称:${CARD}) #0915u4] 在吗`);
  });

  it('群名片与账号名相同 → 不加后缀（零额外噪声）', () => {
    expect(buildUserMessage('在吗', '', ID, NICK, true, false, '0915u4', NICK))
      .toBe(`[${NICK} #0915u4] 在吗`);
  });

  it('群名片为空 → 不加后缀', () => {
    expect(buildUserMessage('在吗', '', ID, NICK, true, false, '0915u4', ''))
      .toBe(`[${NICK} #0915u4] 在吗`);
  });

  it('账号名拿不到 → 直接用群名片', () => {
    expect(buildUserMessage('在吗', '', ID, undefined, true, false, '0915u4', CARD))
      .toBe(`[${CARD} #0915u4] 在吗`);
  });

  it('私聊带发送者标签（2026-10-30 起）', () => {
    expect(buildUserMessage('帮我写个脚本', '', ID, NICK, false, false, '0915u4'))
      .toBe(`[${NICK} #0915u4] 帮我写个脚本`);
  });

  it('私聊拿不到名字时才退回消息号一行', () => {
    expect(buildUserMessage('帮我写个脚本', '', ID, undefined, false, false, '0915u4'))
      .toBe('[消息号: 0915u4]\n帮我写个脚本');
  });

  it('引用块照样拼在最前面', () => {
    const quote = '[引]\n原来那句\n[/引]\n[当前]\n';
    expect(buildUserMessage('这句是回的', quote, ID, NICK, true, false, '0915u4'))
      .toBe(`${quote}[${NICK} #0915u4] 这句是回的`);
  });
});
