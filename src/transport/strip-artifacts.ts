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

/** 行首时间头：`[YYYY-MM-DD 周四 HH:MM]` 或 `[HH:MM]`（必须含 HH:MM） */
const TIME_HEAD_RE = /^[ \t]*(?:\[\d{4}-\d{2}-\d{2}[^\]\n]{0,16}?\d{1,2}:\d{2}\]|\[\d{1,2}:\d{2}(?::\d{2})?\])[ \t]*/gm;

/**
 * 独占一行的时间头 —— 连**换行一起**吃掉，否则删完会留一串空行。
 *
 * 模型披的头通常是 `\n\n[时间]\n\n\n\n正文` 这种（issue #72 的实证样本），
 * 只删标记不删换行，正文前面就多出三个空行，看着还是脏。
 */
const TIME_HEAD_WHOLE_LINE_RE = /^[ \t]*(?:\[\d{4}-\d{2}-\d{2}[^\]\n]{0,16}?\d{1,2}:\d{2}\]|\[\d{1,2}:\d{2}(?::\d{2})?\])[ \t]*\r?\n/gm;

/** 表情占位符：`【表情: 微笑】` / `【表情：狂笑】` */
const FACE_PLACEHOLDER_RE = /【表情[:：]\s*[^】]{1,24}】/g;

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
export function stripOutboundArtifacts(text: string, cfg: StripArtifactsConfig | undefined): string {
  let out = String(text ?? '');
  if (!out) return out;

  if (cfg?.stripTimeHead === true) {
    // 顺序要紧：先吃"独占一行"的（连换行），再去掉"行首但后面还有正文"的。
    // 反过来的话，前一种会先被削成空行，再删标记就没东西可删了。
    out = out.replace(TIME_HEAD_WHOLE_LINE_RE, '');
    out = out.replace(TIME_HEAD_RE, '');
  }
  if (cfg?.stripFacePlaceholder === true) {
    // 占位符被当成整段内容时，连同它前后多余的空格一起收掉
    // 轻8（2026-11-19 审查）：直接删会留双空格（`你好 【表情: 微笑】 呀` → `你好  呀`）。
    //   删的时候把**紧贴占位符**的横向空白一起吃掉，再补一个空格占位 ——
    //   这样句中断开的地方仍然有分隔，又不会留一串空格。
    out = out.replace(FACE_PLACEHOLDER_RE, '\u0000').replace(/[ \t]*\u0000[ \t]*/g, ' ');
    out = out.replace(/\u0000/g, ' ');
  }

  if (out === text) return text;   // 没改动就原样返回，避免无谓的 trim 副作用
  // 只在真的清洗过时才收拾首尾 —— 中间的空行/缩进属于用户内容，不动。
  // 用 trim 而不是只收空行：删掉行首/行尾的占位符后可能留下一个孤零零的空格
  // （`【表情: 微笑】你好` → ` 你好`），那是删除残留，不是用户排版的缩进。
  return out.replace(/^(?:[ \t]*\r?\n)+/, '').trim();
}
