/**
 * image-path-surface.ts — 把 **已进上下文** 的 QQ 图片 URL 换成本地路径（2026-11-26 主人要求）
 *
 * 背景：图片下载是后台 fire-and-forget，消息组装时可能还没下完，于是上下文里留的是
 *   `https://multimedia.nt.qq.com.cn/download?fileid=…&rkey=…` 这种又长又会过期的临时链接。
 *   等下载完了再想补，就必须改 **session 里已经写下的消息**。
 *
 * ## 改历史上下文的正规姿势（参考 dsh-context-shaping / zeranhub）
 *
 *   一条带 `surfaceOp` 的 append 就够了，**不需要 compaction 四事件**：
 *
 *   ```js
 *   session.append(type, data, {
 *     surfaceOp: { op: 'replace', startSeq, endSeq },
 *     sourceEventSeqs: shadowedSeqs,
 *   })
 *   ```
 *
 *   · `startSeq` / `endSeq` 就是 **seq 本身**（相等时只替换一个节点）
 *     ⚠️ 字段名按宿主版本变：运行时 0.2.2-rc.3 用 `startSeq/endSeq`，
 *        较新的源码仓库改成了 `start/end`。本仓库跟随运行时。
 *   · `sourceEventSeqs` 必须列全被遮蔽的 seq（宿主 `assertProvenance` 校验）
 *   · 被替换的 seq **必须还在当前 surface 上**（`surface.nodes.indexOf(seq) !== -1`），
 *     已被替换过的再换会抛错
 *
 *   ⚠️ 宿主对字段名**严格校验**（`isReplaceOp`）：键集合必须与版本完全匹配，多一个少一个都 invalid。
 *      · 运行时 dsh-session@0.2.2-rc.3（本轮实测）→ `{ op, startSeq, endSeq }`
 *      · 仓库 devDependency 0.1.0-rc.6 与新源码仓库 → `{ op, start, end }`
 *      两者互斥，且写错只留一条 debug 日志（静默失效）。
 *      ⇒ 本文件用 {@link appendReplaceOne} **运行时自适应**：先试 rc.3 写法，被拒再试旧写法。
 *        不依赖"宿主恰好是哪个版本"，也不依赖锁文件（锁文件是编译用的 devDependency，不是运行时）。
 *
 * ## 处理范围（2026-11-26 主人定）
 *
 *   **只处理尾部**：上一个回合结束（最后一条 `assistant/message`）之后、下一个回合开始前的
 *   那几条消息。历史深处的旧链接不动 —— 那些多半已经被 offload 压成文字占位，
 *   而且改它们只会在会话日志里堆更多事件。
 *
 * ## 开关
 *
 *   `config.imagePathSurface`，默认 **false**。开启后每次 pre-step 跑一次；
 *   缓存里有本地路径的才换，没有的原样留着（回退 QQ 链接）。
 */
import { lookupImagePath } from './image-path-cache.js';
/** 只认 QQ 图片下载链接（别的 URL 一律不碰，避免误伤正文里的普通链接） */
/**
 * QQ 图片 URL 的匹配式。
 *
 * ⚠️ 2026-11-26（审核 M1）：原写法 `[^\s)]` 只排除空白和半角右括号，**没排除 `]`**。
 *   而本仓库图片占位的真实格式就是 `[图片: <url>]`（见 gateway/debounce.ts 的
 *   `[图片: ${local ?? url}]`），于是替换会把 `]` 一起吃掉，紧跟其后的正文也被吞 ——
 *   改完比不改更糟。字符类补上 `] > } " '` 与中文标点，与 image-offload 的
 *   `/\[图片:\s*https?:\/\/[^\]]*\]/` 口径对齐。
 */
/**
 * ⚠️ N4（复审）：光收窄字符类会**丢掉域名限定** —— 原实现只认 QQ 图片域名，
 *   注释也写着「别的 URL 一律不碰」。若放宽成「任何 https 链接」，
 *   `hasQqImageUrl` 的门槛消失、`rewriteContent` 会对正文里每个链接都查缓存，
 *   而 `lookupImagePath` 的 stableKey 只看 `fileid` 参数前 40 字符 —— 可能误命中别人的缓存条目。
 *   所以字符类与域名限定**两个都要**。
 */
const URL_BODY = String.raw `[^\s)\]}>"'，。；！？、【】（）《》]*`;
const QQ_IMAGE_URL_RE = new RegExp(
// ⚠️ 2026-11-26（CodeRabbit PR #93）：主机必须**紧贴**在 `https://` 之后。
//   之前写成 'https://' + URL_BODY + '(?:domain)'，而 URL_BODY 允许 `/` 和 `.`，
//   于是 `https://example.com/multimedia.nt.qq.com.cn/download?fileid=ABC` 也会命中；
//   而 lookupImagePath 的 stableKey 只看 fileid 前 40 字符 → 非 QQ 链接可能被换成本地路径。
'https://(?:multimedia\\.nt\\.qq\\.com\\.cn|qq\\.com)/download' + URL_BODY, 'g');
/** 这条消息的文本块里有没有 QQ 图片 URL */
function hasQqImageUrl(content) {
    if (!Array.isArray(content))
        return false;
    return content.some((b) => {
        if (b?.type !== 'text' || typeof b.text !== 'string')
            return false;
        QQ_IMAGE_URL_RE.lastIndex = 0;
        return QQ_IMAGE_URL_RE.test(b.text);
    });
}
/** 把一条消息里能命中的 QQ 图片 URL 换成本地路径；没换成就返回 null */
function rewriteContent(content) {
    if (!Array.isArray(content))
        return null;
    let replaced = 0;
    let changed = false;
    const blocks = content.map((b) => {
        if (b?.type !== 'text' || typeof b.text !== 'string')
            return b;
        QQ_IMAGE_URL_RE.lastIndex = 0;
        if (!QQ_IMAGE_URL_RE.test(b.text))
            return b;
        let blockChanged = false;
        QQ_IMAGE_URL_RE.lastIndex = 0;
        const nextText = b.text.replace(QQ_IMAGE_URL_RE, (u) => {
            const local = lookupImagePath(u);
            if (!local)
                return u;
            replaced += 1;
            blockChanged = true;
            return local;
        });
        QQ_IMAGE_URL_RE.lastIndex = 0;
        if (!blockChanged)
            return b;
        changed = true;
        return { ...b, text: nextText };
    });
    return changed ? { blocks, replaced } : null;
}
/**
 * 追加一条「替换单个 surface 节点」的消息，**自动适配宿主版本的字段名**。
 *
 * 为什么需要自适应（CodeRabbit PR #93 提出的核心风险）：
 *   · 运行时 @deepseek-ai/dsh-session@0.2.2-rc.3 → `isReplaceOp` 要求 `{ op, startSeq, endSeq }`
 *   · 仓库 devDependency 0.1.0-rc.6（以及更早的版本）     → 要求 `{ op, start, end }`
 *   两者**严格 3 键校验**，多一个键都 invalid；而且写错不会崩，只会被 catch 吞成 debug 日志 ——
 *   静默失效，最难查。
 *
 * 插件运行时用的是**宿主提供**的那份（peerDependency），与仓库 devDependency 无关。
 * 但为了不依赖"宿主恰好是哪个版本"，这里直接试：先按 rc.3 的写法，被拒再按旧写法。
 *
 * 试错是安全的：宿主在 `validateSurfaceMetadata` 阶段就同步抛错，**日志不会被写入**，
 * 所以第一次失败不会留下任何痕迹。
 *
 * 只对「字段名不认」这一种错误回退；其他错误（如 seq 已不在 surface 上）照常抛 ——
 * 不要用一个宽泛的 catch 掩盖真问题。
 */
function appendReplaceOne(sess, seq, data) {
    const append = sess.append;
    try {
        append('user/message', data, {
            surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
        });
        return;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/invalid replace surfaceOp/i.test(msg))
            throw e;
    }
    // 旧版写法（0.1.0-rc.6 及更早）
    append('user/message', data, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
    });
}
/**
 * 用 surfaceOp replace 把 session 尾部消息里的 QQ 图片 URL 替换成本地路径。
 *
 * @param agent 目标会话的 agent
 * @param logger 日志
 * @param turn 当前轮次号（仅用于日志；surfaceOp 本身不需要）
 * @param opts 范围控制
 * @returns 实际替换掉的 URL 个数
 */
export async function replaceImagePathsInSurface(agent, logger, turn, opts) {
    const sess = agent?.session;
    if (!sess || typeof sess.eventAt !== 'function' || typeof sess.append !== 'function')
        return 0;
    const nodes = sess.surface?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2)
        return 0;
    // 起点：默认只扫尾部（最后一条 assistant/message 之后）
    // ⚠️ 2026-11-26（审核 S3）：新会话还没说过话时 surface 上没有 assistant/message，
    //   若把 start 留在 nodes.length，循环一次都不跑 ⇒「新会话首批图永远不被处理」。
    //   找不到边界就退回 1（跳过索引 0 的 system 节点），整段都算"本回合新来的"。
    const scope = opts?.scope ?? 'tail';
    let start = 1;
    if (scope === 'tail') {
        let found = false;
        for (let i = nodes.length - 1; i >= 1; i -= 1) {
            const sq = nodes[i];
            if (sq === undefined)
                continue;
            const ev = sess.eventAt(sq);
            if (ev && ev.type === 'assistant/message') {
                start = i + 1;
                found = true;
                break;
            }
        }
        if (!found)
            start = 1;
    }
    const maxMessages = Math.max(1, Math.min(24, opts?.maxMessages ?? 8));
    // 用进来那一刻的 surface 快照遍历：append 会让 nodes 变长/变位，
    // 直接按索引走容易读到刚插进去的替换事件（审核 S4）。
    const snapshot = [...nodes];
    let totalReplaced = 0;
    let messagesTouched = 0;
    // 从后往前：最新的消息最可能是"刚下载完、正等着换成路径"的那条
    for (let i = snapshot.length - 1; i >= start; i -= 1) {
        if (messagesTouched >= maxMessages)
            break;
        const seq = snapshot[i];
        if (seq === undefined)
            continue;
        const ev = sess.eventAt(seq);
        if (!ev || ev.type !== 'user/message')
            continue;
        const content = ev.data?.content;
        if (!Array.isArray(content) || !hasQqImageUrl(content))
            continue;
        const rewritten = rewriteContent(content);
        if (!rewritten)
            continue;
        try {
            appendReplaceOne(sess, seq, {
                ...ev.data,
                content: rewritten.blocks,
            });
            totalReplaced += rewritten.replaced;
            messagesTouched += 1;
        }
        catch (e) {
            logger?.debug?.(`[img-path-surface] 替换 seq=${seq} 失败: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (totalReplaced > 0) {
        logger?.info?.(`[img-path-surface] 已把 ${totalReplaced} 个图片 URL 换成本地路径（${messagesTouched} 条消息，turn=${String(turn ?? '?')}）`);
    }
    return totalReplaced;
}
//# sourceMappingURL=image-path-surface.js.map