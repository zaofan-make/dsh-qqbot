# 上游分支研究：`xuan25/dsh-qqbot` @ `main`

> **原文来源**：<https://github.com/xuan25/dsh-qqbot/tree/main>
> **原作者**：[xuan25](https://github.com/xuan25)
> **上游归属**：fork 自 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)（腾讯官方）
> **仓库描述**：让 QQ Bot 接入 DeepSeek Harness（dsh）的官方插件。本分叉加入了 **NO_REPLY 和 Steering** 功能，做了一些杂项修复，并**移除了 web 依赖**。
> **本文整理**：鲸鱼娘（zaofan） · 2026-11-14
> **说明**：本文代码与注释均引自原作者仓库，版权归原作者；此处仅作技术研读记录。

---

## 一、比较基线

| 项 | 值 |
|---|---|
| 被比较分支 | `xuan25/dsh-qqbot` @ `main` |
| 对比基准 | `tencent-connect/dsh-qqbot` @ `main` |
| 结果 | **diverged：领先 37 个提交 / 落后 38 个** |
| 规模 | 96 个文件 / **+6,815 行 −788 行** |
| 最后推送 | 2026-11-05 |

三个 fork 里**规模最小**，但方向最"克制"——不追求大改，专攻几件具体的事。

**三支对比**：

| | `gosomea` | `495258544` | `xuan25` |
|---|---|---|---|
| 主攻 | 投递可靠性 + Workbench | 引用归属 + 人设 | **NO_REPLY + Steering + 去 web 依赖** |
| 规模 | +18,229 | +18,994 | **+6,815** |
| 与上游 | 基于最新 | 落后 17 | 落后 38 |

---

## 二、核心亮点

### 1. `src/transport/no-reply.ts` —— NO_REPLY 静默机制（只有 463 字节）

**全文（原文）**：

```ts
/**
 * Check if the given text is a NO_REPLY silence signal.
 * The signal is a reply whose final line is exactly `NO_REPLY`
 * (surrounding reason lines are allowed); a bare `NO_REPLY` also counts.
 * A genuine reply that merely mentions the token elsewhere is NOT a signal.
 */
export function isNoReplyReply(text: string): boolean {
  const lines = text.trim().split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  return last === 'NO_REPLY';
}
```

**设计要点（三条判据都很关键）**：

1. **只认最后一行** —— 不是"包含 `NO_REPLY`"，而是最后一行**恰好等于**
2. **允许前面有理由行** —— AI 可以写"这轮没必要说话——因为话题无关"，最后一行 `NO_REPLY`
3. **正文提到 `NO_REPLY` 不算** —— 讨论这个机制本身时不会被误判

**和我们 `reply_gate` 的对比**：

| | 他们的 NO_REPLY | 我们的 reply_gate |
|---|---|---|
| 形式 | **文本约定**（在回复末尾写 `NO_REPLY`） | **工具调用** |
| 成本 | **零**（就在正常回复里） | 一次工具调用（token + 延迟） |
| 明确性 | 靠约定，有误判可能（所以只认最后一行） | 结构化，无歧义 |
| 落地 | 客户端检测到就丢弃整条 | 工具调用后终止回合 |

**这是一组真正的 trade-off**。文本约定的最大好处是**省一次工具调用**——尤其在我们这种每轮都要判断"该不该说话"的场景下，省下的就是实打实的 token。

**注意**：他们必须严格"只认最后一行"，否则模型在解释这个机制时就会把自己静音掉。这个坑我们如果照做也要防。

### 2. `src/middleware/concurrency-guard.ts`（20KB）—— Steering / 并发守卫

> 这个文件是从 `@tencent-connect/qqbot-nodejs` 打补丁过来的，注释里写着：
> *"added urgentStrategy option to support cut-in and cut-in-with-preview for urgent messages"*

**原作者注释（原文）**：

```ts
/**
 * Concurrency-guard middleware — per-target serial message processing.
 *
 * Ensures only one message is being processed at a time for each
 * target (user or group). Prevents concurrent stream_messages calls
 * to the same QQ user/group which causes platform 500 errors.
 *
 * Strategy:
 *   - "queue":  New messages wait until the current one finishes.
 *   - "drop":   New messages are silently dropped while busy.
 *   - "abort":  Cancel the current processing, start the new one.
 *   - "merge":  Buffer new messages while the active one is being
 *               processed. When the active message finishes, all
 *               buffered messages are merged via `onMerge` into one
 *               survivor ctx. The survivor proceeds through the rest
 *               of the chain via its own `next()`. Non-survivors
 *               return silently (chain stops).
 *
 * The concurrency key is `${scope}:${targetId}` (e.g. "c2c:OPENID"
 * or "group:GROUPID").
 */
```

**四种策略**：

| 策略 | 行为 | 适用场景 |
|---|---|---|
| `queue` | 新消息等当前处理完 | 默认，最安全 |
| `drop` | 忙时静默丢弃新消息 | 防止刷屏拖垮 |
| `abort` | 取消当前，开始新的 | 用户改主意了 |
| `merge` | 缓冲新消息，当前结束后合并成一条处理 | **连发多条** |

**`merge` 的实现最值得看（原文）**：

```ts
 * Implementation note on "merge" — the "queue + batch" model:
 *
 *   The active message (A) runs through the full chain normally via
 *   `next()`. Incoming messages (B, C, D) pause on a promise without
 *   calling `ctx.stop()` — they do not advance the chain. When A
 *   finishes, all buffered ctxs are merged. One survivor is chosen;
 *   its waiter is marked and proceeds to call `next()`. All other
 *   waiters return silently.
 *
 *   This guarantees:
 *     1. A runs immediately with zero delay and its content stays
 *        untouched.
 *     2. Buffered messages are merged and processed exactly once per
 *        batch via the survivor's own `next()`.
 *     3. Non-survivors' chains stop naturally (no upstream `next()`
```

**三个保证都很关键**：

1. **A 零延迟跑完，内容不动** —— 不打断正在处理的
2. **缓冲的消息每批只处理一次** —— 靠 survivor 自己的 `next()`
3. **非 survivor 的链条自然停止** —— 不是强行中断，而是"没有调 next()"

**这个设计解决了什么**：用户连发 5 条消息时，原来的实现会启动 5 个并发处理（还可能撞上 QQ 平台的 500 错误），现在是第 1 条正常跑、后 4 条攒着、第 1 条结束后合成一条处理。**省 4 次模型调用**。

**Steering 的含义**：对"urgent message"（用户急着插话）提供 `cut-in` / `cut-in-with-preview` 两种插入策略——即"打断当前处理，先看我这条"。这是 `abort` 策略的一个更细的变种。

### 3. 移除 web 依赖

它的仓库根目录**没有 `client/` 目录**（对比我们和另外两个 fork 都有）。

从 `src/` 结构看：
```
commands/  config.ts  features/  gateway/  host/  index.ts
media/  middleware/  model/  prompt/  session/  shared/  transport/
```

**没有 client-side 代码**。这是一个明确取舍：**不要可视化设置面板**，纯 headless 运行。换来的是包体更小、构建更简单。

（`docs/` 目录下只有 `assets/`，说明文档都删了或没写。）

---

## 三、其它值得注意的提交

| 提交信息 | 价值 |
|---|---|
| `fix: use logger instead of console for logs so it won't occupy stdout and breaks plugins that relies on stdout communication` | **重要**：`console.log` 会污染 stdout，破坏依赖 stdout 通信的插件。**这条我们也要查** |
| `fix(attachment): 下载的图片按真实格式命名扩展名 (#86)` | **我们也踩过一样的坑**（图片扩展名不对） |
| `fix(session): mint unique session ids with session- prefix` | session id 唯一性 + 前缀 |
| `fix(session): recreate a session only when it is confirmed absent` | 只在**确认**不存在时才重建（防止误删会话） |
| `fix(host): probe session existence via stat, not a nonexistent load` | 探测用 `stat` 而不是"尝试 load" |
| `feat(session): allow negative sessionIdleTimeout to disables eviction` | 负数 = 禁用驱逐（和我们的 `sessionIdleTimeout` 逻辑可对比） |
| `fix(session): attach sessions to their workspace on create/resume (#21)` | 我们用 `syncScopedToolsOnClaim` 处理过类似问题 |
| `feat: add option showToolErrors` | 工具错误展示开关 |
| `fix: make model-prefs.json writes concurrency-safe` | 配置文件写入的并发安全（**和我们的多实例问题同源**） |
| `fix: vision settings.yaml auto-patch no longer clobbers comments` | 改写 YAML 不能丢注释（我们改 `cordis.patch.yml` 时也要注意） |
| `fix: secure access defaults, approval gating, isolated workspace` | 安全默认值（比"默认全开"更负责） |
| `feat: allowlist-gated admin commands with per-scope visibility` | 管理命令按作用域可见 |
| `feat(streaming): consume the transient agent/assistant-stream channel` | 流式输出 |
| `feat: deliver presented files to chat` | 把 present 的文件发到聊天 |
| `fix: improved NO_REPLY mechanism` | NO_REPLY 的迭代（说明第一版有问题） |

---

## 四、对我们的启示

### 值得认真考虑的两点

**1. `NO_REPLY` 文本约定 vs 工具调用**

我们的 `reply_gate` 是工具，代价是一次工具调用。他们的文本约定是**零成本**的。

**可以做的折中**：保留 `reply_gate` 作为"明确路径"，同时支持"回复末尾写 `NO_REPLY`"作为轻量路径——AI 自己选。而且必须严格"只认最后一行"，防止正文提及被误判。

**2. `merge` 策略解决连发**

我们现在的「出站模式」有连发保护（前 5 条带引用、之后转独立消息），但那是**出站**的。**入站**连发（群友连发 5 条）我们现在是分别处理的吗？如果每条都起一个回合，token 消耗会很可观。

**merge 的思路值得借鉴**：第 1 条正常处理，后续 buffer 起来，结束后合并成一条。

### 立刻要查的两件事

**1. `console.log` 污染 stdout**

> *"use logger instead of console for logs so it won't occupy stdout and breaks plugins that relies on stdout communication"*

我们的代码里有多少 `console.log` / `console.error`？之前排查工具问题时我就发现 `console.error` 不进日志文件——但**它的另一半危害是污染 stdout**。

**查法**：
```powershell
Get-ChildItem src -Recurse -Include *.ts | Select-String "console\.(log|error|warn)" | Where-Object { $_.Line -notmatch "^\s*//" }
```

**2. 图片扩展名按真实格式取**

`fix(attachment): 下载的图片按真实格式命名扩展名 (#86)` —— 我们踩过**完全一样**的坑（之前排查过图片路径缓存和扩展名问题）。看看我们的实现是否已经按真实格式（magic bytes）而不是按 URL 后缀。

### 三个 fork 合起来看

| 问题 | 谁在解决 | 我们要不要做 |
|---|---|---|
| 消息可靠送达 | `gosomea`（账本 + wire 拦截） | 中优先 |
| 引用归属错乱 | `495258544`（归属索引 + 图片 MD5） | **高优先** |
| 该不该说话 | `xuan25`（NO_REPLY）+ `495258544`（wake） | **高优先**（省 token） |
| 连发合并 | `xuan25`（merge 策略） | 高优先（省 token） |
| stdout 污染 | `xuan25`（logger） | **立刻查** |

---

## 五、参考链接

- 仓库：<https://github.com/xuan25/dsh-qqbot>
- 核心文件：
  - `src/transport/no-reply.ts`（463 字节，NO_REPLY 判定）
  - `src/middleware/concurrency-guard.ts`（20KB，四种并发策略 + merge）
  - `src/middleware/concurrency-guard.test.ts`（12.8KB，测试比实现还详细）

---

*本文由鲸鱼娘（zaofan）整理，2026-11-14。代码与注释版权归原作者 xuan25 所有。*
