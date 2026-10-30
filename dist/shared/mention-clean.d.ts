/**
 * 入站 @bot 长 id 清洗(2026-09-11 主人要求省 token):
 * QQ 群消息里 @bot 时, content 会带 `<@botOpenid>`(32 位 hex 的 bot openid),
 * 原样喂 LLM 每条都耗一截 token(当前消息 + 历史折叠都带)。
 * 策略:
 *  ① 从 mentions 数组(is_you === true)拿 bot 自身 id → 精确替换成短标记 `@bot`;
 *  ② 无 mentions 元数据且 wasMentioned 时, 若 content 里恰好只有 1 个 @ 标记
 *     (群聊 @bot 消息通常只 @ 自己) → 兜底替换成 `@bot`;
 *  ③ 多个 @ 标记且无法区分 → 不动(避免误伤 @ 其他群友, 那些有语义)。
 * 只清入站, 出站 AI 回复里的 <@对方openid>(用于 @ 人)原样保留。
 */
export interface MentionLike {
    id?: string;
    is_you?: boolean;
    is_bot?: boolean;
}
/**
 * 剥掉**行首连续的 @ 标记**（`<@openid>` / `<@!openid>`），用于斜杠命令识别。
 *
 * ★ 2026-10-31（issue #36 + 群友实测截图）：
 *   群里 @ 机器人后，入站 content 是 `<@botOpenid> /preset` —— **@ 标记在正文最前面**。
 *   而所有 `startsWith('/')` 的判断都发生在剥 @ 之前 ⇒ 命令被当成普通聊天交给 AI。
 *   反过来，`/preset whale-girl @bot` 这种"命令在前、@ 在后"的写法，参数里也会残留
 *   `<@openid>` ⇒ 人格名匹配失败（报"找不到人格「whale-girl @鲸鱼娘（万能ai）」"）。
 *
 * 所以两处都要剥，但**剥的位置不同**：
 *   - 行首：用本函数（`^` 锚定 + 只剥开头的连续 @，绝不误伤正文里的普通 @ 文本）
 *   - 参数内：命令参数解析时单独 strip（见 stripMentions）
 */
export declare function stripLeadingMentions(text: string | undefined | null): string;
/** 剥掉**任意位置**的 @ 标记（用于命令参数，如人格 id 后面跟的 @） */
export declare function stripMentions(text: string | undefined | null): string;
export declare function replaceBotMention(content: string | undefined | null, mentions?: MentionLike[] | null, wasMentioned?: boolean): string;
/**
 * 这条消息 @ 的是**别人**（不是她）吗？
 *
 * 2026-09-15 主人修正过一次语义："**不是**没人@她的时候降低评分, 是**有人@别人**的时候降低评分"。
 *   · 没被 @ ≠ 不该回话 —— 那恰恰是她该主动挑话插的常态，扣分会把她变成"等点名才说话"；
 *   · 真正该扣的是"这句 @ 的是别人"：那轮对话的方向是那个人，她基本不该插嘴。
 *
 * 为什么用 QQ 的 mentions 元数据而不是正文里的 `@某某` 字样：
 *   正文里 @ 别人的标记形式不固定，而 mentions 是平台给的权威列表。
 *   ⚠️ 两个平台细节：① 她被 @ 时（GROUP_AT_MESSAGE_CREATE）QQ 的 mentions **不含 bot 自身**，
 *   所以要先看 wasMentioned；② 没被 @ 时（GROUP_MESSAGE_CREATE）mentions = 这条 @ 的全部人。
 */
export declare function mentionsOthers(mentions: MentionLike[] | null | undefined, wasMentioned: boolean): boolean;
//# sourceMappingURL=mention-clean.d.ts.map