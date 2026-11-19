/**
 * strip-artifacts.ts — 出站清洗：剔掉**上下文渲染痕迹**（issue #72）
 *
 * ## 为什么需要
 *
 * 入站侧为了"时间感知"和"表情可读化"做了两件事，而它们的产物会被模型**照抄**：
 *
 *   · 每回合第一条消息盖行首时间头 `[2026-11-19 周四 09:52]`
 *   · QQ face 表情转写成 `【表情: 微笑】`（官方 API 发不了 face）
 *
 * 模型把这些当成了"群消息的标准格式"，出站时自己披一个 —— 而且**它意识不到**
 * （issue #72 实证：assistant reasoning 里只规划了内容，输出时自动加上
 *  `\n\n[2026-11-19 周四 11:05]\n\n\n\n啊呜`）。
 *
 * ⚠️ 写群守则压不住：`groupPrompt` 每会话只注入一次，而上下文里每条 user 消息
 *    都带时间头（几十个"示范"）+ assistant 自带头的历史持续自我强化，单次提醒打不过 pattern。
 *
 * 所以只能在**出站侧**做结构级 strip —— 这是最后一道可靠的关。
 *
 * ## 判据
 *
 * 时间头**必须含 `HH:MM` 才删**：`[2026-11-19 更新版已发]` 这种正常引用不能误伤。
 */
export interface StripArtifactsConfig {
    stripTimeHead?: boolean;
    stripFacePlaceholder?: boolean;
}
/**
 * 清洗一段将要发出去的正文。
 *
 * ⚠️ **两个开关默认都关**（2026-11-19 主人定）：默认行为与旧版逐字一致，
 *    用户觉得碍眼时自己去面板勾上。安全类默认收紧、清洗类默认放开 ——
 *    后者改的是用户看得见的内容，不该替所有人做决定。
 *
 * @returns 清洗后的文本。**可能为空串**（整段只剩时间行/占位符）—— 调用方据此决定丢不丢这条。
 */
export declare function stripOutboundArtifacts(text: string, cfg: StripArtifactsConfig | undefined): string;
//# sourceMappingURL=strip-artifacts.d.ts.map