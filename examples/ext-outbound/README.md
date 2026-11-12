# 出站扩展（第六套扩展点：`outbound/`）

> 与 **入站扩展** 严格对称：
> 入站管「消息**进来**时改它 / 杀它」，出站管「消息**出去**时改它 / 杀它 / **补发媒体**」。

## 装哪儿

```
{数据根}/.qqbot-extensions/outbound/*.mjs      ← 只扫**直接子文件**，按文件名升序
```

放好之后 `/tools-reload`（回执里会打印「出站扩展: N 个」）。改文件即热重载，**不用重启宿主**。

## 最小形状

```js
export const name = 'my-outbound';

export default async function onOutbound(ctx, next) {
  // …改 / 杀 / 补发…
  return next();
}
// 也支持 export async function onOutbound(ctx, next) {}
```

`ctx` 上的关键字段：

| 字段 | 说明 |
| --- | --- |
| `ctx.text` | 本条出站正文（只读；要改请用 `ctx.rewrite()`） |
| `ctx.kind` | `'text' \| 'markdown' \| 'media' \| 'card' \| 'forward' \| 'other'` |
| `ctx.source` | `'assistant/message' \| 'tool/call' \| 'tool/result' \| 'turn/end' \| 'unknown'` |
| `ctx.target` | `{ scope, peerId, msgId? }` —— **被动回复靠它自带的 msgId** |
| `ctx.turnId` / `ctx.chunkIndex` / `ctx.isLastChunk` | 回合内定位 |
| **`ctx.phase`** | `'send'` = 正文**发送前**；`'turnEnd'` = **回合真正结束** |
| `ctx.rewrite(t)` / `ctx.annihilate(why)` | 改写 / 消灭本条出站 |
| `ctx.sendMedia({path\|url,text?})` / `ctx.send(text)` | 额外补发（**先被动、失败/超限自动转主动**） |
| `ctx.background(fn)` | ★ **丢后台**：不 await、不阻塞正文（见下） |
| `ctx.note(msg)` | 审计/诊断一行（最坏丢日志，绝不抛） |

另有与前五套同款的统一能力：`emit / markdown / image / media / store / identity / api / kernel / appendSilent / appendWake / logger`。

## ★ 两条铁律（都是真机踩出来的）

### 1. 一段回复会被拆成多个正文块 ⇒ **配图只放 `phase === 'turnEnd'`**

一段「正文 → 工具调用 → 正文」的回复，每段都各走一次出站链。在 `'send'` 阶段配图，
**第一段根本不是回合最后一块**，于是要么不配、要么配两张。

`'turnEnd'` 阶段由 `transport/outbound.ts` 的 `turn/end`（`flush()` 之后）触发，
此时 `ctx.text` 就是该回合**权威的最后一块正文**，而且正文早发完了 —— 慢活随便干。

### 2. 重活必须 `ctx.background()`，**绝不能 await**

> 「图片自动发送的进程压根就不该和正文有关，唯一有关的只是从出站消息里读取到底是什么内容。」

出站链与正文**唯一的联系是"读一眼正文写了什么"**。选图、算分、编码向量、发图这些
一律丢后台，然后**立刻 `next()` 放行**：

```js
export default async function onOutbound(ctx, next) {
  if (ctx.phase !== 'turnEnd') return next();          // ① 只认回合结束
  const safeNext = typeof next === 'function' ? next : () => undefined;
  if (typeof ctx.background === 'function') {
    ctx.background(() => pickAndSend(ctx));            // ② 重活丢后台
    return safeNext();                                 // ③ 立刻放行正文
  }
  return pickAndSend(ctx);                             // 老宿主兜底
}
```

⚠️ 后台跑时 `next` 是 `undefined`，而业务函数里到处是早期 `return next()`
⇒ 必须传一个 **安全 next**（实测踩过 `next is not a function`）。
⚠️ 反面教材：曾在链上**同步**扫全库 1892 张图 + 首次向量编码（十几~几十秒），
结果把 `sendRichOutbound` 的 3 秒硬超时打满 ⇒ **连正文都发不出去**（QQ 里什么都没有）。

## 示范：`sticker-semantic.mjs`（按正文自动配表情包）

拷到 `outbound/sticker-semantic.mjs` 即生效。它做两阶段召回：

1. **阶段1**：随机抽 `POOL`(=300) 张 → 收集这些图的 `tags`（几百个关键词）→
   用**本地小模型**（`bge-small-zh`，没有就退化成字符 bigram）给 query 打关键词分
   → 选出最贴的那个关键词。
   另加**存在性闸门**：最高分要过 `均值 + GATE_K*标准差`，并过绝对地板
   （`FLOOR_EMBED`/`FLOOR_BIGRAM` —— **两个算法的分数量级差 10 倍，必须分两套**）。
2. **阶段2**：拿选中的关键词**回全库精确搜**（`tags.includes`，零模型开销）→ 随机取一张发出。

query 取**末句**（一段话常混着寒暄/技术/情绪，整段进向量会被平均掉）；
`msgText`（群友原话）**不进向量**、只用于「梗命中」加分。

### 它的两级开关

| 级别 | 文件 / 工具 | 缺省 |
| --- | --- | --- |
| 总开关（全局） | `data/auto-sticker.json`（工具 `sticker_auto`） | **开** |
| **隔离（白名单）** | `data/sticker-semantic-scope.json` | **whitelist + 空名单 = 谁都不发** |

```json
// data/sticker-semantic-scope.json
{ "mode": "whitelist", "targets": ["group:<群openid>", "c2c:<用户openid>"] }
```

匹配用 `<scope>:<目标id>`，也接受**只写裸 openid**（手写方便）；
`mode: "all"` 才恢复「所有目标都生效」。
**读不到 / 读坏了都从"不发"这一侧失败** —— 隔离的东西宁可哑火，不能漏发。

用工具管理（实现见 `examples/ext-tools/sticker_auto.mjs`）：

```
sticker_auto {action:'status'}                        // 总开关 + 名单
sticker_auto {action:'scope-add', target:'group:<群openid>', label:'群名'}
sticker_auto {action:'scope-remove', target:'group:<群openid>'}
sticker_auto {action:'scope-mode', mode:'whitelist'|'all'}
```

### 排障

失败**全是静默的**（异常被吞、找不到文件就 return），所以它自带一行式诊断日志：

```
{数据根}/.qqbot-extensions/data/sticker-semantic-diag.log
```

每步都留痕：`skip:scope` / `skip:cooldown` / `stage1` / `skip:below-floor` /
`skip:not-salient` / `stage2` / `sent` / `send-failed` / `error`。
`CONFIG.FORCE = true` 是**故意留的排障开关**：跳过所有判断、无条件发库里第一张 ——
用来区分「出站链压根没被调用」和「链通了但选图逻辑不发」。

## 通过全局 API 给别的扩展用

```js
const ob = globalThis[Symbol.for('im-qqbot.outbound')];
ob.send('文本');  ob.sendMedia({ path });  ob.last();  ob.active();
// 本插件自留：ob.embed(query, passages) / ob.embedAvailable()（本地小模型，用于给关键词打分）
```

## 熔断

同一个扩展**连续 5 次抛错**会被停用（不拖累其它扩展和正文），
`resetOutboundBreaker(name?)` 复位；`listOutboundExtensions()` / `outboundActive()` / `lastOutboundCtx()` 供自检。
