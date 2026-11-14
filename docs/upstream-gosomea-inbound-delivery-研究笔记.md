# 上游分支研究：`gosomea/dsh-qqbot` → `codex/qq-inbound-delivery`

> **原文来源**：<https://github.com/gosomea/dsh-qqbot/tree/codex/qq-inbound-delivery>
> **原作者**：[@gosomea](https://github.com/gosomea)
> **上游归属**：该仓库 fork 自 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)（腾讯官方）
> **本文整理**：鲸鱼娘（zaofan） · 2026-11-14
> **说明**：本文所有代码与注释均引自原作者仓库，版权归原作者；此处仅作技术研读记录，供本项目参考。

---

## 一、比较基线

| 项 | 值 |
|---|---|
| 被比较分支 | `gosomea/dsh-qqbot` @ `codex/qq-inbound-delivery` |
| 对比基准 | `tencent-connect/dsh-qqbot` @ `main`（上游最后推送 2026-11-08） |
| 结果 | **领先 50 个提交 / 222 个文件 / +18,229 行 −1,354 行** |
| 状态 | `ahead`（不含落后提交，即基于上游最新） |

### 改动分布（按目录）

| 目录 | 文件数 | 说明 |
|---|---|---|
| `tests/formal/` | 37 | 形式化状态机测试（最大的一块） |
| `src/transport/` | 29 | 入站/出站投递核心 |
| `src/runtime/` | 19 | 多机器人运行时、workbench 会话 |
| `lib/transport/`、`lib/runtime/`、`lib/shared/` | 37 | 对应编译产物 |
| `src/client/` | 18 | QQ Workbench 前端 |
| `plugins/workbench-history/` | 6 | 新增独立插件（历史视图） |
| `docs/workbench/` | 5 | 使用文档 |

### 改动最大的文件

| 文件 | + | − |
|---|---|---|
| `lib/client.js` | 3136 | 149 |
| `src/client/workbench.ts` | 767 | 0 |
| `src/client/robot-accounts.ts` | 491 | 0 |
| `src/runtime/workbench-conversations.ts` | 475 | 0 |
| `src/runtime/robot-runtimes.ts` | 435 | 0 |
| `src/session/session-manager.ts` | 325 | 94 |

**一句话概括**：在上游基础上自建了一套 **QQ Workbench 客户端 + 多机器人运行时 + 形式化投递测试**，核心命题是「入站归属、出站准入、会话绑定」的正确性。

---

## 二、核心设计研读

以下三个文件是这套改造的设计精华，都出自 `src/transport/`。

### 1. `qq-wire-admission.ts` —— 在 wire 层把住出口

**原作者注释（原文）**：

```ts
/**
 * Gate conversation POSTs after the SDK has acquired its token. This includes
 * middleware and inbound error replies that do not pass through TurnTracker.
 */
```

**为什么必须在这一层**：中间件发出的错误回复、入站流程里的兜底回复，**根本不经过 `TurnTracker`**。在业务层加检查会漏掉它们——只有拦在 SDK 真正发 HTTP 的那一刻，才能堵住所有出口。

**实现方式**（原文节选）：

```ts
export function guardConversationPosts(
  bot: QQBot, baseUrl: string, userAgent: string, allowTarget: (target: ReplyTarget) => boolean,
) {
  const pairing = new AsyncLocalStorage<{ target: ReplyTarget; allowed: () => boolean }>();
  const request = bot.apiClient.request.bind(bot.apiClient);
  bot.apiClient.request = async <T>(token, method, path, body?, options?): Promise<T> => {
    if (method !== 'POST' || !/^\/v2\/(users|groups)\//.test(path)) return request<T>(...);
    const match = /^\/v2\/(users|groups)\/([A-Za-z0-9_-]+)\/(messages|stream_messages|files|upload_prepare|upload_part_finish)$/.exec(path);
    if (!match?.[2]) throw new Error('Invalid QQ conversation POST path');
    const target: ReplyTarget = { scope: match[1] === 'groups' ? 'group' : 'c2c', targetId: match[2] };
    const grant = pairing.getStore();
    const isPairingReply = grant && match[3] === 'messages'
      && grant.target.scope === target.scope && grant.target.targetId === target.targetId;
    if (!(isPairingReply ? grant.allowed() : allowTarget(target))) {
      throw new Error('QQ delivery canceled: conversation is no longer authorized');
    }
    // ...
    response = await fetch(baseUrl + path, {
      method, headers: { Authorization: `QQBot ${token}`, ... },
      body: JSON.stringify(body), signal: AbortSignal.timeout(options?.timeoutMs ?? (upload ? 120_000 : 30_000)),
      // A redirect can issue another POST without rechecking admission.
      redirect: 'manual',
    });
```

**三个值得学的细节**：

1. **只拦会话类 POST**：正则限定 `messages` / `stream_messages` / `files` / `upload_prepare` / `upload_part_finish` 五类路径，其它请求直接透传，不影响性能。
2. **`redirect: 'manual'`** —— 注释写得很准：*"A redirect can issue another POST without rechecking admission."* 自动跟随重定向会绕过准入检查，所以手动处理。
3. **`AsyncLocalStorage` 开"配对豁免"**：扫码配对时的回复必须能在"尚未授权"的情况下发出去，否则用户永远配不上。用 ALS 把 `{ target, allowed }` 带进调用栈，只对**同一个 target 的 `messages`** 豁免，且仍要过 `grant.allowed()`。

**返回的闭包**：

```ts
  return (target: ReplyTarget, text: string, allowed: () => boolean) =>
    pairing.run({ target, allowed }, () => bot.sendText(target, text));
```

### 2. `delivery-ledger.ts` —— 追加式文件账本

**原作者注释（原文）**：

```ts
/** Only identities and submission states are retained here; this is not a chat log.
 * Synchronous refresh/write fences stale instances within one Host. Sharing the
 * directory between independent processes remains unsupported.
 */
```

**两种回执**：

```ts
export interface InputReceipt {          // 入站回执
  kind: 'input';
  key: string;
  messageId: string;
  sessionId: string;
  senderId: string;
  target: ReplyTarget;
  contentHash: string;
  turn?: number;
}

export type DeliveryState = 'sending' | 'accepted' | 'unknown' | 'not-sent';

interface DeliveryReceipt {              // 出站回执
  kind: 'delivery';
  key: string;
  state: DeliveryState;
  fingerprint?: string;
  httpStatus?: number;
  platformCode?: number;
}
```

**关键 API**：

```ts
export function deliveryKey(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
```

- `registerInput(...)` —— 入站去重（同一 key 只登记一次）
- `claimInput(messageId, sessionId, content, turn, peer)` —— **双重校验后才认领**：`sessionId` 要匹配、`contentHash` 要匹配、`scope/targetId` 要匹配、`turn` 要一致（若已记录）。任一项不符就返回 `undefined`。
- `begin(key)` / `settle(key, state)` —— 出站的两阶段记账
- `run(key, action)` —— 封装「先记账 → 执行 → 按结果落状态」：

```ts
async run(key: string, action: () => Promise<unknown>): Promise<boolean> {
  if (!this.begin(key)) return false;        // 已经发过 → 直接跳过
  try {
    await action();
    this.settle(key, 'accepted');
    return true;
  } catch (error) {
    this.settle(key, 'unknown');             // 结果未知 ≠ 失败
    throw error;
  }
}
```

**`unknown` 这个状态是整个设计的眼**：网络抖动时你根本不知道 QQ 收没收到，标成 `unknown` 而不是 `not-sent`，重试前可以人工介入，避免重复发消息。

**文件写法（很讲究，全是防丢数据）**：

```ts
private put(receipt: Receipt): void {
  if (this.file) {
    const firstCreatedDir = mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Existing files must never be recreated by an append after refresh.
    const flags = this.signature ? constants.O_WRONLY | constants.O_APPEND : 'ax';
    const fd = openSync(this.file, flags, 0o600);
    try {
      fchmodSync(fd, 0o600);
      const line = Buffer.from(JSON.stringify(receipt) + '\n');
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset);
      fsyncSync(fd);                          // 落盘不靠 OS 缓存
    } finally { closeSync(fd); }
    this.markInitialized(this.file, firstCreatedDir);
    this.signature = this.fileSignature();
  }
  this.receipts.set(receipt.key, receipt);
}
```

要点：
- **`'ax'` 独占创建**：首次必须原子创建，绝不覆盖已有账本
- **`O_APPEND`**：后续只追加，不重写
- **`fchmodSync(fd, 0o600)`**：每次打开都收紧权限（防止被别的进程改过权限）
- **`fsyncSync`**：必须真落盘——因为"允许外部效果"之前要先保证账本可靠
- **`fileSignature()` = `ino:size:mtimeMs`**：用 inode 三元组判断文件是否被外部改过

**最狠的是 `refresh()` 的三个"拒绝"**：

```ts
if (!existsSync(this.file)) {
  if (this.signature || knownLedger) throw new Error('QQ delivery ledger disappeared; refusing to recreate submission identities');
  return;
}
const text = readFileSync(this.file, 'utf8');
if (text && !text.endsWith('\n')) throw new Error('QQ delivery ledger is incomplete; refusing to replay it');
// ...
else if (knownLedger) throw new Error('QQ delivery ledger was emptied; refusing to recreate submission identities');
```

- 账本**消失**了 → 抛错（绝不重建，否则幂等身份全丢，可能重复发）
- 最后一行**没换行** → 说明写入被截断 → 抛错（不重放半条记录）
- 账本**被清空**（有 `.initialized` 标记但内容为空）→ 抛错

**`.initialized` 标记文件的作用**（注释原文）：

> The marker survives loss of the journal. Sync both directory entries before allowing the first external effect on a newly opened ledger.

它比账本本体更早落盘，所以"账本曾经存在过"这件事不会随账本一起消失——这正是上面三个拒绝判据的依据。

### 3. `delivery-context.ts` —— 元数据挂旁路

**原作者注释（原文）**：

```ts
/** Keep routing metadata out of the SDK payload and the public ReplyTarget. */
```

**实现**：

```ts
interface DeliveryContext { appId: string; key: string; sessionId?: string; allowed: () => boolean; fixed?: boolean; streamKey?: string; staticKey?: string }
const contexts = new WeakMap<ReplyTarget, DeliveryContext>();

export function bindDelivery(target: ReplyTarget, context: DeliveryContext): ReplyTarget {
  const bound = Object.freeze({ ...target });
  contexts.set(bound, context);
  return bound;
}

export function continueDelivery(source: ReplyTarget, reply: ReplyTarget): ReplyTarget | undefined {
  if (source.scope !== reply.scope || source.targetId !== reply.targetId) return undefined;
  const context = contexts.get(source);
  return context ? bindDelivery(reply, context) : reply;
}

export function deliveryPart(target: ReplyTarget, ...identity: unknown[]): ReplyTarget {
  const context = contexts.get(target);
  return context ? bindDelivery(target, { ...context, key: deliveryKey(context.key, ...identity), fixed: true }) : target;
}
```

**要点**：
- `WeakMap<ReplyTarget, …>` —— 元数据跟着对象走，**对象没了自动回收**，不留内存泄漏
- `Object.freeze({ ...target })` —— 绑定后不可变，防止下游偷偷改
- `deliveryPart(target, ...identity)` —— **每个分片（chunk）用 `deliveryKey(父key, 分片标识)` 派生独立 key**，这样"整条消息"和"某个分片"各自幂等，互不干扰

### 4. `inbound.ts` —— 五层内容组装

**原作者注释（原文）**：

```ts
/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（带发送者标签）
 * - Layer 4: dynamicCtx（媒体元数据）
 * - Layer 5: agentBody（history + base 拼合）
 */
```

分层的好处是**每层可独立测试、可独立裁剪**。对比我们现在的做法（history + base + quote 混在一处拼），这套分层在"某层出问题"时更容易定位。

---

## 三、其它值得注意的提交

| 提交信息 | 含义 |
|---|---|
| `fix: fence QQ delivery when an initialized ledger is lost` | 账本丢失时的保护（就是上面 `refresh()` 那三个 throw） |
| `fix: fence QQ stream retries after ambiguous opening results` | 流式消息开启结果不明确时的重试保护 |
| `fix: bind QQ file sends to the originating conversation` | 文件发送绑定到**原始会话**（防止串会话发文件） |
| `fix: enforce QQ account and conversation admission at delivery` | 在投递处强制账号+会话准入 |
| `fix: retire stale QQ approval and question cards` | 过期审批/提问卡片自动作废 |
| `fix: preserve QQ Session bindings across reset and reload` | 重启/重置后仍保留会话绑定 |
| `Distinguish separate QQ question requests in the same turn` | 同一回合内的多个提问请求要区分开 |
| `Check QQ access at each SDK media upload request` | **每次**媒体上传都重新校验权限（不是只在开始校验一次） |

---

## 四、对我们（`zaofan-make/dsh-qqbot`）的启示

我们和这个分支是**平行的两个 fork**，走的路不同：

| 维度 | 他们 | 我们 |
|---|---|---|
| 可靠性 | 先记账再发（ledger 幂等） | 调用点自觉 + 熔断 |
| 授权 | wire 层统一拦截 | 各调用点检查 |
| 测试 | 形式化状态机测试（37 个文件） | 实机验证 + 少量单测 |
| 前端 | 自建 Workbench | 设置页 + dock |

**可以直接借用的三点**：

1. **`delivery-ledger` 的思路** —— 我们现在发消息**没有幂等保护**，网络抖动重试就可能重复。哪怕只做"发送前记 key、成功后标 accepted"这一层，也能避免大部分重复发送。
2. **`wire` 层拦截授权** —— 我们现在的权限校验散在各处，`/tools-reload` 之类路径容易漏。在 `apiClient.request` 上包一层是"一次性堵全"的做法。
3. **`unknown` 状态** —— 我们现在把"发送失败"统一当失败处理，其实中间有一类"不知道发没发出去"，应该单独标出来让上层决定。

**不建议照搬的**：

- 形式化测试那套（37 个文件）投入很大，我们是单人维护，性价比不高
- 自建 Workbench 客户端（1.8 万行）——定位完全不同

---

## 五、参考链接

- 仓库：<https://github.com/gosomea/dsh-qqbot>
- 分支：<https://github.com/gosomea/dsh-qqbot/tree/codex/qq-inbound-delivery>
- 上游：<https://github.com/tencent-connect/dsh-qqbot>
- 核心文件：
  - `src/transport/qq-wire-admission.ts`
  - `src/transport/delivery-ledger.ts`
  - `src/transport/delivery-context.ts`
  - `src/transport/inbound.ts`

---

*本文由鲸鱼娘（zaofan）整理，2026-11-14。代码与注释版权归原作者 gosomea 所有。*
