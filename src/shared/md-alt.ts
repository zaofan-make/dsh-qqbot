/**
 * Markdown 图片 alt 的安全化（2026-11-13 主人实测：机器人名带方括号 → 私聊头像整段失效）
 *
 * 现象：机器人名叫 `[lv1魅魔]鲸鱼娘（万能ai）`，拼出来的头像是
 *   `![[lv1魅魔]鲸鱼娘（万能ai） #50px #50px](http://thirdqq.qlogo.cn/...)`
 * 解析器在 alt 里遇到第一个 `]` 就认为 alt 结束 ⇒ 整段原样显示成文本，图不出来。
 *
 * 修法：把半角 `[` `]` 换成全角 `【】`（全角不参与语法解析），名字还能认；
 * 顺带把换行/连续空白压平（alt 里换行同样会断）。
 */
export function mdAltSafe(name: string | undefined | null, fallback = '机器人'): string {
  const t = String(name ?? '')
    .replace(/\[/g, '【')
    .replace(/\]/g, '】')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t || fallback;
}
