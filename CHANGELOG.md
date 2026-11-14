## 1.12.32 (2026-11-14)

### 🔴 修复：扩展能力包里 `sender` 被展开，原型方法全丢

组装扩展工具的能力包时写的是：

```js
sender: { ...sess.ch.sender, openid }     // ← 错
```

`sess.ch.sender` 是 `QQBotSender` 的**实例**，`sendMedia / sendMarkdown / sendTuwenCard /
recallLast` 这些方法都在**原型**上。对象展开只复制**自有属性** ⇒ 方法一个都带不过去
⇒ 能力包里 `deps.sender?.sendMedia` 是 `undefined` ⇒ 所有扩展的
`env.voice / env.image / env.media / env.markdown` **静默返回 false**。

**实测症状**（主人报的）：`dskit_tts` 合成成功，却提示"发送失败（文件还在）"。
同一个文件用内置 `send_media` 工具能正常发 —— 因为那条路用的是 `ch.sender.sendMedia(...)`（原对象，没展开）。
`bili_share` 的 `env.card` 其实也一直是坏的，它能发出卡片全靠后面 `env.api` 直连 HTTP 兜回来。

修法：**同原型的新对象 + 自有属性 + openid**

```js
Object.assign(Object.create(Object.getPrototypeOf(raw)), raw, { openid })
```

方法在、`env.sender.openid` 也在，所有走能力包发消息的扩展一起修好。

### 修复：扩展工具的签名缓存不认「改实现」

签名只比 `name/description/schema/expose`，改 `tools/*.mjs` 的实现而 schema 没动时签名不变
⇒ 走「未变化，跳过重复注册」⇒ `tools_reload` 之后跑的还是旧模块。
现在 `extension-store` 加载时带出 `def.mtime`，签名把它算进去。

（这两处都是 `deepseek-kit` 上架过程中踩出来的，详见市场 PR。）

## 1.12.31 (2026-11-14)

### 扩展市场：DeepSeek 全家桶已上架 ✅

`deepseek-kit` 正式上架插件市场（`zaofan-make/dsh-qqbot-plugins`，PR #18），
五个工具全部实测通过：搜索带引用、读链接、PDF 三页 OCR 全中、TTS 合成 288KB wav、
ASR 把它转回文字（6.0s）。同时把 `volcengintts`（火山方舟 TTS）同步到最新版。

### 修复：条件可见性改用宿主的 `register(def, { when })`

上一版（1.12.30）自创的 `enabled` 钩子在**注册时刻**求值，需要猜"当前会话是谁"，实测
`agent` 与 `provider` 经常是空 ⇒ 判定恒 false ⇒ 工具全被隐藏。

宿主 0.2.2+ 本来就有对应能力：

- `register(definition, { when })` 是**步骤级**条件，每步算一次，入参
  `{ agent, modelSelection, signal }` —— `modelSelection.provider/model` 就是这一步真实用的路由
- 返回 false 会**同时**从「描述」「PTC 绑定」「执行集合」三处移除；抛错 = 步骤准备失败
- 配套 `resolve()` 产出 `ResolvedToolSet`，宿主把它传给本次组装与执行批次

实现：能力探测 `typeof ctx.tools.resolve === 'function'` — 有就把扩展的 `enabled`
**归一**成 `when`（`provider` 直接取 `modelSelection.provider`），**扩展侧签名不变**；
没有则保留旧的"注册时判一次"路径（peer 下限仍是 `dsh-tools >= 0.1.1-rc.2`）。
判据抛错一律放行 —— 宁可多看见一个工具，也不能让一个判据把整步弄炸。

### 修复：`run(args, env)` 的 env 是残的

`enabled` 的 env 有 `dataRoot` / `provider`，`run` 的 env 只有
`{cwd, manager, sender, replyTarget, exec, ctx, logger}` ⇒ 同一个扩展在"判可见性"和
"真执行"两处拿到相反答案（有 Key 却判没 Key）。现在补齐 `dataRoot` / `agent` / `provider`。

### 修复：签名缓存不认「改实现」

签名只比 `name/description/schema/expose` —— 改了 `tools/*.mjs` 的实现而 schema 没动时
签名一模一样 ⇒ 走「未变化，跳过重复注册」⇒ **`tools_reload` 之后跑的还是旧模块**，
热刷形同虚设。现在 `extension-store` 加载时带出 `def.mtime`，签名把它算进去。

### 其他

- `dsh.engines.dsh` 声明提到 `>=0.2.0-rc.2`（市场卡片展示用；加载拦截看 peerDependencies，
  那边全是不设上界的 `>=`，新旧宿主都能装）
- 有 `when` 时不再为 `enabled` 放弃签名缓存，省掉每回合"先拆后建"，工具表零抖动

## 1.12.30 (2026-11-14)

### 新：扩展工具支持「条件可见」（`enabled` 钩子）

有些扩展工具依赖外部 API Key —— 没配就**不该出现在工具表里**（而不是"看得见、一调就报错"）。

- `ExtensionToolDef` 新增可选 `enabled(env) => boolean | Promise<boolean>`：注册前求值，
  返回 false 就**不注册**，并回收它上次注册的那份
- `env` 给到 `{ ctx, manager, dataRoot, logger }`；不声明 `enabled` 的扩展行为完全不变
- 注册本来就走"按会话 + 热刷"路径，所以这就是**热开关**：配置改完下一轮生效，不用重启

### 新：扩展包 `deepseek-kit`（DeepSeek 全家桶应用 API）

把官方 2026-11-13 发布的全家桶接成一套工具（扩展包形态，可上架插件市场）：

| 工具/扩展 | 能力 |
|---|---|
| `dskit_search` | 服务端联网搜索：`thinking=true` 走深度思考搜索（多步 search / open_page / find_in_page），`images=` 按图搜索，回答带引用 |
| `dskit_readurl` | 阅读链接（最多 10 个 URL） |
| `dskit_ocr` | PDF/Word/PPT/图片 → 文字，可带版面坐标；长文档落盘、只回前几页 |
| `dskit_asr` | 本地音频 → 文字（16bit WAV / Ogg Opus） |
| `dskit_tts` | `[语音合成]` 标记说明 + 试听 + 只存文件 |
| 出站扩展 | 正文写 `[语音合成]…[/语音合成]` → 合成真语音消息（自带设置页 schema） |

- 工具统一前缀 `dskit_`，避免与 `web_search` / `bing_search` 等撞名
- **没填 API Key、或当前 provider 不是 DeepSeek 官方时，这些工具对 AI 完全不可见**
- 设置页字段：apiKey / baseUrl / model / 五个能力开关 / TTS 音色与格式 / 搜索默认是否开深度思考

## 1.12.29 (2026-11-14)

### 修：机器人名带方括号时，私聊头像 markdown 整段失效

机器人名叫 `[lv1魅魔]鲸鱼娘（万能ai）` 时，拼出来的头像是：

```
![[lv1魅魔]鲸鱼娘（万能ai） #50px #50px](http://thirdqq.qlogo.cn/...)
```

`![alt](url)` 的 alt 里出现半角 `]` 就提前闭合 ⇒ 整段原样显示成文本，图出不来（主人 00:45 实测）。

- 新增 `src/shared/md-alt.ts` 的 `mdAltSafe()`：alt 里的半角 `[` `]` → 全角 `【】`（全角不参与语法解析，名字还能认），
  顺带压平换行与连续空白
- `bot-avatar.ts`（机器人头像）与 `md-media-rewrite.ts`（模型写的图片语法重写）都改用它

## 1.12.28 (2026-11-13)

### 修：dock 聊天页认不出带群名片的发送者壳（整行漏进正文）

`settings-host.js` 里解析入站标签的两处正则是 `[^\]\n:]`（**排除冒号**），
新格式 `[做早饭(群昵称:这是昵称) #111310s]` 一带冒号就匹配不到 ⇒ 整行当正文显示，
同时 `[图片聚合]` 被当成发送者名（screenshot）。

- 新增 `chatParseSenderTag()` / `chatSenderLabel()`：统一解析 4 种历史形态
  （纯昵称 / `#短号` / `(openid)` / `(群昵称:xxx)`），尾部的短号与 openid 先剥再判，
  含冒号的兜底判据挪到名片解析**之后**（否则新格式又被排除）
- `chatSplitHistoryBlock()` 与 `chatPolishOne()` 改为调用它；`RE_MARKER_WORD` 补 `图片聚合` / `图片已省略` / `消息号`
- 老会话里的旧格式消息照旧能解析

### 新：群名片（`member_nickname`）**只追加显示**，不替换 `senderName`

官方 11-13 起群消息 `author` 里带了 `member_nickname`（本群名片）与 `member_role`。
但群友小传按 `senderName` 落盘、**用用户名检索**，台账 / `id_lookup` / `@昵称` 解析也都吃同一口径 ——
`senderName` 一换，历史数据全错位。所以只改**显示**：

- 入站标签：名片与账号名不同 → `[做早饭(群昵称:这是昵称) #111310r]`
- 名片为空 / 与账号名相同 → 不加后缀（零额外 token）
- 账号名拿不到（空 / 就是 openid）→ 直接用名片
- `#短号` 位置与格式不变（`[rf:短号]` 引用、`id_lookup` 反查都靠它）
- 新增 `withMemberNick()` / `memberNickOf()`（`inbound.ts`）；单测补到 10 条
  （`src/transport/inbound-tag.test.ts`，含名片相同/为空/账号名缺失四种分支）

已知未做：群历史行仍显示账号名；`avatar` 带签名会过期故未接；
`member_role` 权限分级已记入手册 §11.41，等后续优化。

### 修（顺带）：过时单测

`inbound-tag.test.ts` 里"私聊不带发送者标签"那条是 2026-10-30 之前的口径，
与现行实现（私聊带 `[昵称 #短号]`）冲突、一直是红的；按现状改正并补"拿不到名字才退回消息号"。

## 1.12.27 (2026-11-13)

### 修：图库扩展名按真实字节定（issue #47）—— 否则 `read_image` 报 `IMAGE_TYPE_MISMATCH`

宿主 DSH 0.2.2-rc.2 的 `dsh-attachment-local` 开始按签名严格校验声明类型
（`detected.mediaType !== declaredMediaType` ⇒ `IMAGE_TYPE_MISMATCH`），而声明类型**只看扩展名**。
QQ 下发的 `content_type` 与图片 URL 后缀双向都可能说谎 ⇒ 文件名说谎的图直接读不出来。

- `sticker-store.ts`：新增 `extFromMagic()`；`capture()` / `importLocalFile()` 的扩展名改为
  **魔数优先**，`content_type` / URL / 源文件名只作兜底（原来 `isImageBuffer()` 已经判过真实类型，结果却被丢了）
- 新增 `healExtensionMismatches()`（构造时自动跑）：四层目录（candidate / library / negative / trash）
  按魔数改名并**回写 index.json 的 `ext`**（不回写的话 `pathOf()` 会指向改名前那个不存在的路径）；
  目标已存在时只回写不覆盖
- `image-aggregate.ts` 的 `mediaTypeOf()`：先读文件头 12 字节，后缀只做兜底（避免把图库路径喂给宿主时二次命中）
- 本机实测：3474 张图里 **25 张**扩展名与真实字节不符（jpg↔png↔webp↔gif 都有）

### 修：私聊里新加的命令必须重启才生效（命令分发机制）

群里 `/tools-reload` 回执显示「/whoami 加载成功」，私聊发 `/whoami` 却直接进了 AI。

机制真相：
- 群聊走插件**自建分发** —— 每次现查 `cmdMap`，热刷即时生效；
- 私聊被 `kind !== 'group' → next()` 让给 SDK 的 `slashCommand` 中间件，
  而它的 registry 是**创建时一次性**灌入 `options.commands` 的（`slash-command.js:71-73`）；
  本插件当初只取了 `.middleware`，把 SDK 明明提供的 `register()/unregister()` **丢了**
  ⇒ 热刷出来的新命令，私聊永远不认识，只能重启宿主。

修法：自建分发放开 c2c（`kind0 !== 'group' && kind0 !== 'c2c' → next()`），
私聊也实时读 `cmdMap`、`handlerArg` 带齐 caps；SDK 那层只兜底 `autoHelp` 的 `/help`。
⚠️ 自建分发没有 SDK 的 `cmd.scope` 检查（现有命令都没声明 scope），以后要加 scope 需补这里。

### 修：私聊昵称改用官方下发的 `author.username`

QQ 官方 2026-11-13 起在 C2C 事件里下发 `author.username`（连带 `author.avatar`，带签名参数会过期），
但官方 api-v2 文档尚未同步（192 页零变化），且 `@tencent-connect/qqbot-nodejs` 的 C2C 分支
只取了 `user_openid`、没取 `username`（好消息：它保留了 `raw: ev`）。

- `inbound.ts` 的 `handleInbound` 顶部：**优先读 `msg.raw.author.username`** 填 `senderName`；
  台账反查（`c2c-name.ts`，按 openid 匹配群成员台账）**降为兜底**，只在官方没给时使用。
- 群聊不动 —— SDK 的群分支本来就是 `senderName: ev.author.username`。
- 手册 §11.33 补两条：① `/tools-reload` 热刷对 **c2c 命令无效**（必须重启宿主）；
  ② 官方下发昵称/头像的来龙去脉与本模块的新职责。

## 1.12.26 (2026-11-13)

### 修：「主人 web 直发」标记从「按回合」改成「按条」

主人从 DSH web 界面直接打的字，本该在正文开头带上 `【主人在 DSH 宿主界面直接发送】`，
但从 11-13 起大量丢失（`{dataRoot}/.qqbot/web-direct.log` 断档）。

- **根因**：判定是**回合级**的 —— `record.turnOrigin === 'qq'` 就整回合跳过。
  群里一刷屏，主人的 web 消息和群友消息被收进同一个回合 ⇒ 主人那几条一起被跳过。
- **修法**：改成**按条**判宿主的 `user-rpc` 变体 ——
  `source.kind === 'user' && typeof source.rpcId === 'string'`。
  web/桌面界面提交必带 `rpcId`（+ `clientTimeZone`）；QQ 入站与插件注入全是裸 `{kind:'user'}`
  或自己的 kind ⇒ 不会被误标。官方插件（`dsh-client-file-upload` / `dsh-experimental-auto-review` /
  `dsh-time-context`）用的正是同一判据。
- 落盘日志改成「真加了才写」，并带条数：`已加标记 n=2 session=…`
  （旧版无论加没加都写一行，肉眼分不清"加上了"和"进了分支但一条没加"）。
- `turnOrigin` 保留 —— `outbound` 的 `webTurnSilent` 还在用它。
- 详见手册 §11.40。

## 1.12.25 (2026-11-13)

### 新：内存自检 `/memcheck`（宿主 OOM 崩过一次）

宿主崩在 `Ineffective mark-compacts near heap limit`（堆涨到 3.4GB，GC 压不动），
崩之前没有任何证据。补一个探针：

- 插件侧新增 `src/features/mem-stats.ts`：bootstrap 把快照函数挂到 `globalThis[Symbol.for('im-qqbot.memstats')]`
  （O(1) 读数：进程内存、活跃会话数、图片路径缓存条数）
- 命令 `examples/ext-commands/memcheck.mjs`：
  - `/memcheck` → 进程 rss/heapUsed/heapTotal/external、堆上限与已用百分比、插件缓存条数、
    以及**记忆插件的向量配置**（provider / 维度 / 是否 GPU）与语义索引体积
  - `/memcheck top` → 额外列出**事件数最多的 5 个会话**（事件数≈上下文体积，找"哪个会话在涨"）

## 1.12.24 (2026-11-13)

### 性能：前端轮询降频（主人实测「上传图片时对话框转圈」）

`client/qqbot-settings.js` 里有几个**常驻**定时器，上传/重渲染期间会和主线程抢时间：

| 轮询 | 原来 | 现在 |
| --- | --- | --- |
| 审批/提问 | **每 2 秒** × 2 个请求 | **10 秒**，页面不可见跳过，上次未回跳过 |
| 入群红点 | 10 秒 | **30 秒**，不可见跳过 |
| 表情包列表自动刷新 | 6 秒 | **15 秒**，不可见跳过 |

### 修：`/会话列表` 不再扫盘（改用 `workspaceRegistry`）

宿主的 `sessionPersistence.list()` **没有归档/深度过滤**（0.2.2 源码签名只有 `{signal}`），
每次枚举磁盘全部会话（本机 1697 个，其中 1435 个是子代理）⇒ 首次要等好几秒。

现在改成读 **`kernel.get('workspaceRegistry')`**：它启动时就把 header 索引进内存，
`.list()` 直接给出 11 个工作区 + 每个的 `record.sessionIds`（合计 262），
另有 `archivedSessionIds`（226）可用来剔除归档 —— 和宿主 UI 那颗「隐藏已归档」同一份数据。

顺带：`sessionTitle.get()` 要传 **Session 对象**（传 id 会抛 `session.snapshotEvents is not a function`），
用它取标题比扫 `log` 更全；旧路径保留作兜底。

### 新增：`examples/ext-commands/dshapi.mjs`

宿主服务探测命令 `/dshapi [title|stats|market|present|cwd|quotes|ckpt|batch|ws]`，
用来确认某个宿主服务在当前版本是否可用、形状如何（写扩展前先跑一下，省得猜名字）。

## 1.12.23 (2026-11-13)

### 新：只读工具标记 `isConcurrencySafe`（借 DSH 0.2.2 的并行批处理）

宿主 `tools/batch` 会把同一 step 内的工具调用分类：**并发安全的进有界滚动池并行跑**，
其余（exclusive）当屏障串行。判据就是工具定义上的 `isConcurrencySafe(args) => boolean`。

我们原来一个都没标（等于全部串行）。现在给纯只读的 6 个标上：

`list_stickers` / `sticker_stats` / `sticker_untagged` / `session_list` / `group_join_requests` / `target_group`

效果：模型一次发多个查询类调用时，这些会**并行执行**，结果仍按调用顺序返回。
写操作（发送/撤回/禁言/群发/定时）保持默认（串行），不放宽。

## 1.12.22 (2026-11-12)

### 性能：三处小优化（都不改行为）

1. **`image-url-ledger` 压缩只读尾部**
   原来超过 1.5MB 就 `readFileSync` 整份再全量去重；现在按 `MAX_ENTRIES * 4` 行估算一个字节窗口，
   用 `openSync/readSync` 只读尾部（≤4MB，且丢掉被截断的半行），拿不到才退回整份读。
   台账只保留最新 1000 条，头部那几 MB 本来就要被扔掉，读它纯属浪费。
2. **标记扫描加上限（`clampForMarkerScan`）**
   `markers.ts` 那几个函数（找 `[rf:]` / `[引用:]` / `[语音合成]` 等）都是线性扫描/正则，
   每条消息都跑。现在超过 2 万字只保留头尾各 1 万字再扫 —— 标记只可能出现在首尾，
   结果不变，但**彻底避开"有人贴几万字长文"导致的单次几十毫秒阻塞**。
3. **`OutboundBuffer` 堆积告警**
   flush 是串行的，发送慢时新增量会堆在缓冲里。加一条 20 万字阈值告警（**不丢内容**），
   便于事后从日志判断"是不是堆积了"。背压交给 AI 侧的流式输出，传输层不做丢弃。

## 1.12.21 (2026-11-12)

### 性能 / 数据完整性：iOS 式「原子写 + 少排序」（外部 AI 审查启发）

看了 MaiBot PR #2395 的 CodeRabbit 审查（那套思路源自本项目的 `c2c-name`），把同类隐患自查了一遍：

1. **`image-url-ledger` 压缩改成 `tmp + rename` 原子写**
   原来是直接覆盖：中途被杀/断电会留下半个文件，下次读只解析出一部分，
   「图库 id → QQ 链接」的兜底台账静默丢一批。同分区 rename 是原子的。
2. **`chat-ledger` 压缩时不再全表 `sort`**
   读取方一律按 `ts` 自己排，jsonl 物理顺序无语义要求；Map 插入顺序已稳定，
   省掉每 200 次追加一次的 O(n log n)。

其余同步写盘（`msg-history` / `people-memo` / `prefs-store` 等）都是**低频或 append-only**，
不在每条消息的热路径上，本次不动。

## 1.12.20 (2026-11-11)

### 🔴 修：人格编辑器「保存」会把整份 cordis.patch.yml 覆盖掉（issue #46）

**症状**：设置页 →「账号与预设」→ 人格 → 点保存后，`cordis.patch.yml` 变成一段人设纯文本，
1011 行 / 42KB → 15 行 / 1.2KB，所有 loader 条目（各实例、preset、其它插件）全部消失。
当前进程还能跑（patch 是启动时读的），但**下次重启直接起不来**。

**根因**：`settings-host.js` 的 `writePresetPersona()` 最后一行写盘用的是 **函数参数 `text`（新人设正文）**，
不是前面辛苦拼出来的 `out`（完整 patch）。同文件 `copyPresetDecl()` 里那行 `quoteNumericIds(text)` 看起来一样，
但那里的 `text` 是累积后的完整 patch —— 两处含义完全不同，极易误判。

**修复**：
- 写盘改成 `quoteNumericIds(out)`
- 新增 `guardPatchWrite()` **写盘前自检**：新内容必须仍是顶层 YAML 数组，且**包含旧文件里所有的顶层 `id`**；
  不满足就不写、返回错误（备份文件仍保留，可手动回滚）
- 备份文件名保持 `.bak-persona-<ts>`，报错文案里直接给出备份路径

感谢 **@firefly1376** 提供的完整定位与根因分析。

## 1.12.19 (2026-11-11)

### 修：纯 web 会话不再被注入 QQ 小传

主人追问：「纯 web 会话，和 QQ 没有绑定的，也被注入了小传？」

确实 —— 1.12.16 为了让「QQ 会话在 web 里直发」也能拿到小传，兜底条件写成了「没有入站候选就取 owners[0]」，
结果**连纯 web 会话一起覆盖了**。

小传是**QQ 群里的记忆**，不该漫到跟 QQ 无关的会话里去。现在的规则：

| 情形 | 注入？ |
| --- | --- |
| QQ 群/私聊消息 | ✅ 按发言者 |
| QQ 绑定会话 + web 直发 | ✅ 按主人 |
| **纯 web 会话** | ❌ **默认不注入** |

要给纯 web 会话也注入，开设置项 **`peopleMemoInWeb`**（默认 `false`）。

## 1.12.18 (2026-11-11)

### 修：`ctx.reply()` 去掉限频

1.12.17 给 `ctx.reply` 加了「每扩展每分钟最多 3 条」的硬限频 —— **主人否了**：

> 可以有审计，但别护栏啊，这断绝了其余用户的自由性。

已移除。`ctx.reply` 现在只剩两条约束：

- **审计**：每次回话记 `action: 'reply'`（署名哪个扩展），出事查得到
- **走正常出站**：引用 / 分段 / 限速（QQ 侧的分块节流）照旧

至于发多少条、什么时候发 —— **由扩展作者自己负责**。

## 1.12.17 (2026-11-11)

### 扩展接口四项增强（外部作者反馈驱动）

1. **`ctx.reply(text)`（入站）** —— 入站扩展终于能"直接回一句"。
   走正常出站（引用/分段/限速照旧），但限频 **每扩展每分钟 3 条**、每次落审计、
   不唤醒 AI、不进会话历史。
2. **`ctx.sessionId`（入站）** —— 以前拿不到本会话 id（只有出站链有 `session.header.id`）。
3. **`onSent(result)`（出站）** —— 消息真正发完之后回执：`{ok, text, failedBlocks, error, killed}`，
   以前扩展只能看到"链内抛错"，看不到 transport 结果。
4. **`list_stickers` 默认精简** —— 返回带 `id`，`desc` 默认截 60 字（`verbose: true` 给完整版）。

契约文档同步补了三节。

## 1.12.16 (2026-11-11)

### 修：QQ 会话「web 直发」回合拿不到小传

1.12.15 把"非 QQ 会话"收得太死 —— 兜底条件写成 `!memoPick && !recMemo`，
把「**QQ 绑定的会话 + 在 web 界面直接打字**」这一整类漏掉了（有 `recMemo` ⇒ 不走兜底，
但 web 回合又没有入站候选 ⇒ 两头落空）。

现在只要**没有入站候选**就按主人兜底：`if (!memoPick) 取 owners[0] 的小传`。
覆盖三种：QQ 群消息（按发言者）/ QQ 会话+web 直发（按主人）/ 纯 web 会话（按主人）。

### 文档

- README：许可证段**移到文末**（不再占据开头），开头新增一条能力亮点
  「记得住每一个群友」—— 小传八栏、纯文本可读、按话题契合度自动挑 1~2 行注入、
  已注入的不重复、上下文清空后会重新想起来。

## 1.12.15 (2026-11-11)

### 修：群友小传（people_memo）注入整个失效

三个坑连环，最终表现是"只在新会话第一轮注入过一次，之后再也不出现"：

1. **串群**：待注入的小传是**模块级单变量**，A 群算好的会被 B 群的 pre-step 取走
   ⇒ 本群看到别人小传、那个群反而没有。改成 `Map<sessionKey, …>` 按会话隔离。
2. **24 小时门限**：原来「每人每群 24h 只注一次」，上下文一清空就永远想不起来。
   **去掉时间门**，判据只认「这一行现在是否在上下文里」。
3. **共用群守则的 body（主犯）**：小传被拼进群守则那条 `body`，而群守则只要注过一次，
   之后每轮都 `skipGroupRules = true` ⇒ **整块被丢弃，小传跟着一起没了**。
   现在小传是**独立注入块**（`source.kind='qqbot:people-memo'`），自己判自己的重。

### 新：web 界面直发 QQ 会话时，正文开头加标记

在 DSH 里打开 **QQ 绑定的会话**、直接在输入框打字时，正文会被加上
`【主人在 DSH 宿主界面直接发送】`：

- 只改**本条**待发消息的 **text 块**（图片/文件/语音/引用一律不碰）
- 不走 system prompt（那会常驻，之后每轮都会被误判成"当前这条是主人直发"）
- **纯 web 会话（自定义 agent 预设）一个字节都不动**
- 判定顺序全在内存：`findByAgent(活跃记录)` → `model-prefs.sessionIds 反查` → 都不是 = 不碰
- 回合来源用 `record.turnOrigin`（QQ 入站置 `'qq'`，`turn/end` 清空）

### 新：web 会话也注入小传（按主人）

非 QQ 会话里能打字的只有主人，所以直接取 `groupAdmin.owners[0]` 的小传，
用当前消息当 query 挑最相关的 1~2 行。

### 文档

新增 `docs/MAINTAINER-NOTES.md`（维护手册，3496 行）：踩坑台账 + 部署/发布纪律。
**不随 npm 包发布**（未加入 `package.json` 的 `files`），只在仓库里给维护者看。
其中新增 §11.39：**上下文注入必须一条一块，绝不共用 body**。

## 1.12.14 (2026-11-10)

### 文档修正：B′ 可以换许可证，只是不能换成 GPL/AGPL

v1.12.13 的 `LICENSE-ADDENDUM.md` 写成“不授权 B′ 换用其它许可证”，**说过头了**。

AFL-3.0 **§1(c)** 原文就允许：衍生作品可 *"under any license of your choice that does not contradict
the terms and conditions ... in this Academic Free License"*。

所以准确表述是：

- ✅ B′ 可以换成 **MIT / Apache-2.0 / BSD / 闭源商业许可** —— 这些与 AFL 不冲突，**§1(c) 直接授权，不需要我们额外许可**
- ❌ 但**不能换成 GPL-2.0/3.0、AGPL-3.0** —— copyleft 条款与 AFL 冲突，落进 §1(c) 的 "contradict" 被排除

README 里那句“不能换成 GPL”也一并改准（补上“但可以换 MIT/Apache/闭源”）。

## 1.12.13 (2026-11-08)

### 许可证变更：MIT → Academic Free License 3.0（AFL-3.0）

- `LICENSE` 换成 AFL-3.0 **官方全文**；`package.json` → `"license": "AFL-3.0"`
- 新增 [`LICENSE-ADDENDUM.md`](./LICENSE-ADDENDUM.md)：**额外许可 + 边界说明**
  - 通过公开扩展接口接入、未修改本体的**插件不是衍生作品**，可自选任何许可证（含 GPL/AGPL）
  - 独立程序（插件、启动前改源码的 M）可作为**聚合体**一起分发
  - **额外许可**：M 在启动前修改本体源码的**修改行为本身**不违反 AFL
  - **边界**：修改产物 B′ 若对外分发，须保留版权与"已修改"声明，且**不得以 GPL 分发**
  - 明确提示：本豁免**不替代**插件作者在 GPL 下的义务
- 新增 [`NOTICE`](./NOTICE)：上游腾讯 MIT 代码、LGPL 运行时依赖（lamejs-fixed / sharp）、历史贡献者
- ⚠️ v1.12.12 及更早的 **MIT 授权永久有效、不可撤回**；AFL 只约束 v1.12.13 起的新版本

### 修：实例 id 裸写数字会把 YAML 写坏（dsh-market #1071）

实例 id 是用户填的，填 `1` 就会写出 `- id: 1` → js-yaml 解析成 **number** →
下游（插件市场等）对 id 调 `.split()` 抛 TypeError，现象是"已安装列表空白 + 400 空 body + 零日志"。

- 写入：`yqLoose()` —— 像标识符的（`im-qqbot`、`im-qqbot-2`）原样写，其余一律加引号（`'1'`、`'账号A'`）
- 读取：`isBotHead` / `botIdOf` / insert 扫描全部先 `unq()` 去引号，避免带引号导致 `/^im-qqbot/` 判不出来
- 自愈：`quoteNumericIds()` 在每次写 patch 前把历史遗留的裸数字 id 补上引号（幂等）

### 文档：扩展契约补 `env.manager`

`docs/extension-contract.md` 新增一节，列出 10 个**受支持的稳定接口**
（`findBySessionId` / `findByAgent` / `findByPeer` / `getSessionRecord` / `getEffectiveModel` /
`setModelOverride` / `listAvailableModels` / `listReasoningEfforts` / `listSessions` / `injectToPeer`），
并明确警告：**扩展只依赖 `env`，不要 `import` 插件的 `dist/`**。

## 1.12.12 (2026-11-08)

### 切模型支持「思考强度」，并与宿主界面双向同步

**两步选择**：QQ 里点模型按钮后不再直接切换，而是弹出第二张卡选思考强度
（`off / low / high / max`，档位优先问宿主 `llm.reasoningEfforts()`）。
卡片点选、`/bot-model provider/model` 两条路都走这一步；
想一步到位也可以 `/bot-model provider/model high`。
「默认(跳过)」= 用模型默认档，**不等于关闭思考**。

**双向同步**（issue #42）

- **宿主 → 插件**：在 DSH 输入框右下角切换模型/强度后，下一轮 pre-step 会把
  `agent.model.current()` 的 provider/model/**reasoningEffort** 写进 `model-prefs.json`。
  ⚠️ 宿主**没有**"模型已切换"事件可订阅，所以用每轮一次的对象比较实现，开销可忽略。
- **插件 → 宿主**：走 `model.select({ ...cur, provider, model, reasoningEffort })`，
  宿主界面会立刻跟着变（实测主人电脑上的 UI 同步变化）。

### 修掉的三处（都是实测踩出来的）

1. **同模型早退漏写强度**：`applyModelRoute` 原来只比 provider/model，
   只改强度时直接 return ⇒ 宿主没变、下一轮又按宿主把偏好改回去，表现为"怎么切都弹回 low"。
2. **两边互相覆盖**：加"宿主变化哨兵"（记住上次看到的 `provider/model/effort`）——
   宿主没变化就**绝不回写偏好**，从结构上打断拉锯。
3. **卡片显示与实际错位**：`getEffectiveModel` 现在优先读 `agent.model.current()`（新宿主），
   读不到再看 `options`（旧宿主），最后才回落 prefs。

### 合并的社区 PR（本版一并发布）

- **#43**（by **kinokn**）：UI Settings 改由宿主提供 —— 删掉 `@deepseek-ai/dsh-client-ui-settings`
  的依赖与锁文件记录（保留 `ui-slots`），避免 profile 重装时把旧版 0.1.7 又装回来。附客户端注册/设置路由回归测试。
- **#44**（by **kinokn**）：`IdleEvictor` 的 interval 加 `unref()` —— 修「短命令跑完进程不退」
  （`dsh web --help` 打印完卡住，Web Helper 一直等）。附进程自然退出的回归测试。
- **#45**（by **kinokn**）：fork 出来的子会话补 `attachSessionToWorkspaceWithRetry()` ——
  修「新会话/切模型后子会话掉到 Ungrouped」。

> 上一版 v1.12.11 还合并了 **#41**（by **Chaos-Paradox**）：兼容 DSH Desktop `mainView` 会话识别 + 悬浮球否定缓存过期。

### 其他

- **同模型同强度 → 不 fork**：以前点一次就白开一个新会话，现在只回一句"当前已经是 XXX"
- **只改强度 → 也不 fork**：强度随请求下发，直接改活动 agent 的选择即可

## 1.12.11 (2026-11-08)

### 「智能判断」与「分段压缩」改为可共存

原先面板上是三选一，但这两项本来就不冲突：
一个负责"整段压缩/丢弃"，一个只切"上回合之后"的尾巴。
现在把它们**框在一起**（可同时勾选），**整个方框与「按条数保留」互斥** ——
勾了按条数就自动取消方框内两项，反之亦然。

### 兼容 DSH Desktop 的会话识别（#41，by Chaos-Paradox）

- DSH Desktop `0.2.1-rc.5` 用 `sessions.list.byId[*].retainedBy.mainView` 标记当前会话，
  客户端以前只读 `snapshot.current`，会回退到过期的 localStorage 会话 ⇒
  悬浮球、面板目标、扩展工作区 cwd 识别错误。现在统一走一个 `sessionIdFromSnapshot()`。
- 悬浮球对"同一会话未命中"的否定结果加了 **2 秒过期**，启动阶段一次未命中不再导致永久隐藏。
- 加请求序号，快速 A→B→A 切换时丢弃过期回包。
- 新增 8 项回归测试（直接跑发布版浏览器 bundle 里的函数）。

## 1.12.10 (2026-11-07)

### 修：历史图片省略误伤 web 上传的图

v1.12.9 用 `attachmentId` 判断"这张图是不是我们自己聚合的"，
但 dsh 的附件 id 是**内容寻址**的（`sha256:<hash>`），同一 id 可能被不同途径引用 ——
结果主人在 web 界面手动上传的图也被当成"我们的"给压掉了。

改成认**我们自己写的那行说明文字**（`[图片聚合]` / `（↑ xxx 发的图）`）：
只有我们注入的图块后面才会跟着这句，其他来源不可能有 ⇒ 不再误伤。
`aggregate-ids.json` 台账保留，仅作诊断，不再参与判定。

### 修：插话不触发「自定义小提醒」

插话（回合进行中插入的消息）走的是 `agent.inject`，**不经过 `handleInbound`**，
而 `applyInjectRules` 只挂在后者里 —— 所以插话里的关键词/图片/链接规则一次都不会执行。
现在 `interjectBatch` 拼完文本后会补跑一遍规则（拿这一批最后一条消息当判定样本）。

## 1.12.9 (2026-11-07)

### 历史图片不再重发（省 token、保速度）

dsh 每轮都会把整段会话历史发给模型，图片一旦进会话就会被**每轮重传**——
会话越聊越慢，图片攒到十几张时 TTFT 能飙到几分钟。

现在每轮第一步会把**本插件自己聚合出来的图**在历史里换成文字占位
（`[图片已省略 image/jpeg #xxxxxxxx]`），**同一条消息的文字全部保留**；
只保留「本回合新来的那几张图」。

- **严格只清理自己的**：聚合/单张注入时把 `attachmentId` 记进台账
  `{dataRoot}/.qqbot/aggregate-ids.json`，清理只按名单匹配 ——
  别的插件/功能塞的图片**一律不动**
- 走宿主认可的四事件协议（`compaction/start → summary → replace → end`），不算乱改历史
- 开关 `imageOffload`，默认开

### 媒体发送：补上"被动失败 → 转主动"

文本（`sendMarkdown`）一直有这层降级，图片/语音/视频/**文件** 的 `sendMedia` 没有：
带着过期 msgId 直接失败，文件就静默丢了。现在两条通道行为一致。

### 排障可见性

- 媒体两跳都失败时，写一条 `sendMedia(kind) 被动+主动都失败 … 被动err=… | 主动err=…` 到 diag
- 扩展发送失败的真实原因写进 `{dataRoot}/.qqbot/ext-deliver.log`
  （`send()` 依旧只返回 boolean，老扩展不受影响）

## 1.12.8 (2026-11-07)

### 违规提示：给出"两条路"，不再只逼着改内容

原来的提示只写"换个说法重发"，结果是 AI 会死磕同一段内容、反复改写，越改越偏还多跑几轮。
现在明确给两条路：

> `[系统通知] 刚才那段正文被 QQ 判「内容违规」，没发出去。别原样重试，两条路选一条：① 换个说法（改内容）；② 换个发送方式（压缩 / 加密成压缩包 / 转成 txt 文件发）。`

短内容改措辞，长内容打包/转文件 —— 由 AI 自己按情况定。

## 1.12.7 (2026-11-07)

### 正文被平台判「内容违规」时，立刻告诉 AI 并让它重写

以前违规只进日志，AI 毫不知情 —— 它以为已经说出去了，会继续基于那句话往下聊。

现在：
- 每块正文发送失败都会被接住（**以前一抛异常整段就中断，后面的正文全丢**）
- 错误里带「内容违规」时，**同一回合只提醒一次**，往上下文注入一行极短提示：
  `[系统通知] 刚才那段正文被 QQ 判「内容违规」，没发出去。换个说法重发，别原样再试。`
- 注入通道用宿主的 **`steer()`**（`next-step` + `wakeup:true`）：
  回合还开着就下个 step 读到，回合已结束就当场开新回合 —— 真正做到"立马重写"
- **不复述被拒内容**：写长文被拒时，把上千字再贴一遍纯属浪费 token

## 1.12.6 (2026-11-07)

### 修复：长时间后正文发不到 QQ（工具消息却正常）

**现象**（主人实测）：出站模式=适配主动，隔 4 小时重启 dsh，只在 web 界面说话 ——
工具消息能到 QQ，**正文却一条都到不了**。

**根因**：正文走的是**流式通道**（`StreamingWriter`），它在构造那一刻就把 `record.replyTarget`
冻住了，而那个对象里带着入站消息的 `msg_id`，之后**再也不重算**，于是绕过了
"适配主动"里 `resolveTarget` 的 5 分钟判定 ⇒ 拿几小时前的 `msg_id` 去**被动回复**，
QQ 直接丢弃；工具消息走主动通道（不带 msg_id），所以照常到达。
短时间重启能到，是因为 msg_id 还在有效期内。

**修复**：流式通道支持 `resolveTarget` 解析器，开流前**现算目标** ——
过期的 msg_id 会被去掉、转主动发送。

## 1.12.5 (2026-11-06)

### 分段压缩：按价值分保命 + 占位文案瘦身

- 新增设置项 **价值分 ≥ X 的也保留**（0=关闭）：复用入站时本地小模型算出的价值分，
  分数够高的消息**即使排在"最近 N 条"之外也留下**。实测：N=3、门槛 0.78，
  十条消息里 0.99 和 0.79 两条保住了。
- 保留集合 = 最近 N 条 ∪ 分数 ≥ 门槛的 ∪ @/forceWake 的；剩余部分切成连续段**倒着逐段压**
- 只压 `user/message`，不碰 assistant/tool ⇒ 不破坏 tool 配对
- 占位文本从 30 来字的长句改成 `〔已省略 7 条〕`（带条数，几乎不占 token）

配置：`contextless.segmentScoreMin`（0~1，0=关闭）。

## 1.12.4 (2026-11-06)

### 无上下文模式新增「分段压缩」（保住 prefix cache）

消息照常入站（评分/小传/好感/图库/唤醒判断全不动），只在**回合第一步**
把「上回合结束 → 本回合开始」这段里多余的消息压成一行占位，更早的历史一个字不动。

- 边界 = **最后一条 `assistant/message` 之后**，每次现算（不记账，重启也不怕）
- 窗口内保留最后 N 条，更旧的压成一个占位节点；数不够就跳过，等消息攒够
- **@ 我 / 扩展 `forceWake` 的消息永不压**
- 走宿主官方 compaction 四事件协议，**不调模型**
- 前缀稳定 ⇒ 服务商 prefix cache 照样命中

与「按条数保留」「智能判断」三者互斥，面板单选。

配置：`contextless` 存储新增 `segment` / `segmentKeep`。

修掉的一个坑：最初用"自记的边界"，第一次跑时它指向 surface 开头 ⇒ 从第 1 个节点起扫，
撞上一条很老的 @ 就被保护挡住，只替换了两三个旧节点等于白跑。改成现算后实测：
连发 10 条、N=3 → 上下文只剩 8、9、10（`已压缩 7 条历史记录`）。

## 1.12.3 (2026-11-06)

### 图片聚合（issue #40）

群友连着发图时，把这段时间收到的图**竖向拼成一张长图**，随那条唤醒消息**一起**进上下文。

- 环形缓冲：最新排最下、最旧排最上；上限可配（1~8，默认 4）
- 只有当前模型**显式声明 `image` 输入**才聚合，纯文本模型直接跳过
- **已聚合过的图不重复进上下文**（`sentPaths` 名单，缓冲被挤出后也不会回来）
- 单张不拼接，直接原图入库（省一次转码）
- 插话（回合中插入的消息）里的图片也进缓冲，下次唤醒随长图进来
- 拼图异步进行，任何环节失败都**不影响消息收发**；jimp 动态 import，没装就静默不可用

修掉的三处实测问题：

1. QQ 会把连发的多张图并成**一条**入站消息，`msg.attachments` 只带最后一张，
   前面几张只剩 `[图片: 路径]` 躺在 history 里 —— 现在从历史补录，否则永远只拼到 1 张
2. 插话路径不经过 `handleInbound`，那里的图片原本会整个丢掉 —— 现在也入缓冲
3. 说明文字挪到图片块**之后**（原来紧贴用户发言，看着像用户自己说的）

新增文件：`src/features/image-aggregate.ts`；设置项：`imageAggregate.enabled` / `imageAggregate.max`。

## [1.10.14] - 2026-10-20

## 1.10.22 (2026-10-22)

### 修复 issue #14 / #15（生成式安装 / 多 profile 下“找不到 cordis.patch.yml”“一直连不上”）

换了一条**不碰保存链路**的实现方式：

`index.ts` 启动时从宿主拿 `ctx.get("profileContext")`，把结果**回写成环境变量**：

```js
process.env.DSH_PROFILE = pc.name;        // -> "web"
process.env.DSH_PROFILE_DIR = pc.dir;     // -> C:\Users\<u>\.dsh\profiles\web
```

因为 `resolveProfileRoot()` 与 `resolveProfileName()` 的**第一优先级本来就是读这两个环境变量**，
所以 `settings-host.js` 一行逻辑都不用改（已回滚到 1.10.16 原版），
却能在生成式安装（`.generations/live/...`）与多 profile 并存（`desktop-safe-mode` 抢位）时命中正确 profile。

宿主没有 `profileContext`（老版本）时静默跳过，行为与之前完全一致。

### 说明
- 上一版（1.10.18-1.10.20）曾直接改 `settings-host.js` 的 profile 推断，引入过 TDZ 与类型问题，
  导致保存请求挂起；那些改动已全部回滚，本版只动启动期的一次性写入。

## 1.10.21 (2026-10-22)

### 修复（设置页“卡在保存中” + 扫码自动保存不生效）

1) **卡在「保存中…」**：账号保存函数为了支持“扫码后自动保存”加了 `listOverride` 参数，
   而保存按钮仍是 `onClick: save` —— React 会把 **MouseEvent** 当第一个参数传进来，
   于是 `listOverride.filter(...)` 抛 TypeError，`busy` 永远停在 save，界面无限转圈。
   改为只接受数组（`Array.isArray`），其余一律回落到当前 `insts`。

2) **扫码自动保存不生效**：`autoSaveAfterBind` 里先 `setBusy("")` 再 `save(list)`，
   但 React state 是异步的，`save()` 开头 `if (busy) return` 读到的还是旧值 ⇒ 直接 return。
   改为 `save(list, true)` 走 force 分支，绕过 busy 检查。

3) **settings-host.js 回滚到 1.10.16 原版**：先前为接入宿主 `profileContext` 改动了
   `resolveProfileRoot` / 惰性求值等，引入了 TDZ 与类型问题，导致保存请求挂起。
   该文件整体退回已验证可用的版本；`index.ts` / `shared/utils.ts` 里的注入保留
   （只写 globalThis，不参与保存链路，未来可用）。

### 保留
- 定时任务以 `source.kind = subagent-settled` 注入，前端渲染成「子任务状态更新」系统卡片。

## 1.10.20 (2026-10-22)

### 修复（issue #14 / #15：生成式安装下凭据写错 profile，表现为「一直连不上」）

实测证据（用诊断扩展工具在真机打到宿主）：

    env.ctx.get("profileContext")  ->  { name: "web",
                                        dir: "C:\\Users\\<user>\\.dsh\\profiles\\web",
                                        patchPath: "...\\cordis.patch.yml", ... }
    process.env.DSH_PROFILE        ->  不存在（宿主从来不传这个环境变量）
    argv                           ->  node.exe ...\\@deepseek-ai\\dsh\\lib\\bin.js web

- 优先使用宿主 profileContext：index.ts 启动时取 name / dir / patchPath 写进 globalThis；
  resolveProfileName()（读写凭据用）与 settings-host.js 的 resolveProfileRoot()（面板写凭据用）
  都先读它，读不到才回落原有推断链（环境变量 -> 代码位置 -> 目录扫描）。
- 根因回顾：面板侧原来按「profiles 目录里第一个有 cordis.patch.yml 的」选 profile，
  readdirSync 字母序让 desktop-safe-mode 抢在 web 前面，于是凭据写进了没在运行的 profile。
- 启动误报「安装不完整」：URL.pathname 不解码，路径含空格变成 %20，existsSync 必然 false；
  改用 fileURLToPath。

## 1.10.19 (2026-10-22)

### 改进（issue #14 建议 1）
· **优先用宿主提供的 profileContext，不再靠路径推断**：index.ts 启动时取 ctx.get("profileContext") 的 name/dir 写进 globalThis，
  resolveProfileName() 与 settings-host.js 的 resolveProfileRoot() 都先读它，读不到才回落原有推断链；宿主没该服务时行为不变。

## 1.10.18 (2026-10-22)

### 修复（GitHub #15「一直显示连接中」，由用户 Asthestarsfalll 定位）
· **面板把凭据写进了没在运行的 profile**： 的  扫描时「第一个有 cordis.patch.yml 的就用」，
  而  是字母序（ 排在  前）⇒ 凭据写进 desktop-safe-mode，真正在跑的 web profile 读不到 → 一直连不上。
  改为**两轮扫描：先只认装了本插件的 profile**，都没有才退回 patch 判据。
· **启动误报「安装不完整」**： 不解码，路径含空格时变成 ， 必然 false。改用 。

## 1.10.17 (2026-10-22)

### 新增
· **定时任务走「任务消息」通道**：会话自定任务到点注入时带 `source.kind='subagent-settled'`，
  DSH 前端渲染成「子任务状态更新」系统卡片，不再伪装成用户发言。
· **扫码绑定后自动保存**：手机 QQ 扫码拿到 AppID/AppSecret 后自动写入配置并启动实例，
  不用再手动点「保存」（失败会明确提示可手动保存）。

### 修复
· 面板「群已失效」误判：台账（groups.json / known-chats）只是本地缓存，查不到 openid ≠ 群不存在，
  不再据此标红并显示「已失效」。
· 清理 `scheduler.ts` / `inbound.ts` 里对定时任务无效的 source 改动（真正的注入点在 `injectToPeer`）。

## 1.10.16 (2026-10-22)

### 修复
· 去掉注入提示与 README 里对私有扩展工具 send_md 的提及（用户环境没有该工具）。

## 1.10.15 (2026-10-22)

### 新增
· **正文图组**：回复正文里写 markdown 图片（`![说明 #宽px #高px](本地路径)`），前端渲染、QQ 端原样转发；
  本地路径自动上传成 `qqbot-media` 引用，自动补真实宽高，配额满 100 张自动删最早。多行即图组（小剧场/分镜）。
· `qq_material` 内置工具：素材上传 / 列表 / 删除（对应官方 `/v2/media-images/*`）。
· `@全体成员`：`<qqbot-at-everyone />`（botplay 里也可用 `atAll()`）。

### 修复
· **扩展工具拿不到 QQ 通道**：`env.qq` 只给 `expose:'all'` 的工具，普通扩展应使用 `env.manager.groupAdmin.apiCall`，
  且必须 `bind(groupAdmin)`（内部依赖 `this`）。`send_md` 已按此修正，可在卡片里直接写本地图。
· **`context_*` 三工具在未开无上下文模式时仍可见**：`restrict` 只认全局层名字 → 改用 `ctx.root` 注册；
  `restrict()` 返回的是函数，释放必须函数优先（`.dispose?.()` 会静默失效）。
· 出站自动传图取不到句柄：`managersOf()` 里的 manager 没有 `groupAdmin`，改用会话自己的 `manager`。

### 新增
- **出站流式真正可用**（对齐上游 `tencent-connect/dsh-qqbot` commit `c8b9158`）：改为监听宿主**瞬态通道** `agent/assistant-stream`，
  只消费 `start` / `chunk(text-delta)` 两类帧，其余（reasoning / tool-call / finish / end）一律忽略；用 `attemptId` 跟踪 ——
  LLM 重试时**改写同一条流式消息**，而不是追加第二条。
  - 背景（上游原话）：老的 durable `assistant/chunk` 在宿主 agent-loop 重构后**不再产生**，只监听它 = 流式永远收不到帧、
    回复只能整块发。我们此前同样只监听 `assistant/chunk`，所以 `StreamingWriter` 一直是死代码。
  - 该事件按 agent 作用域派发，根作用域监听必须带 `{ global: true }`，帧到达后自行按 `agent.id` 路由到对应会话缓冲。
  - 改动：`transport/events.ts` 新增 `parseStreamFrame`（纯函数、非法输入返回 undefined）；
    `transport/outbound.ts` 新增 `OutboundRouter.routeStreamFrame`，并由 `createOutboundHandler` 的返回值透出；
    `gateway/bootstrap.ts` 挂 `ctx.on('agent/assistant-stream', handler, { global: true })`。
  - 老的 durable `assistant/chunk` 分支保留（现已不会触发），当保险。


## [1.10.13] - 2026-10-20

### 修复
- **生成式安装（dsh-market / DSH Desktop）下「添加账号」保存失败，报「找不到 cordis.patch.yml(仅 web profile 支持)」（GitHub issue #14）**：
  `settings-host.js` 的 `resolveProfileRoot()` 只会「包根上溯 3 级」，直装时恰好等于 profile 根；
  市场装法下拿到的是 `profiles/.generations/live/<pkg>`。兜底又写死 `~/.dsh/profiles`，
  而 Desktop 的 `DSH_HOME` 在 `%APPDATA%\dsh-desktop\harness`，扫不到 → `PATCH_FILE` 指向不存在的文件。
  现在按四级定位：**`DSH_PROFILE_DIR`/`DSH_PROFILE_ROOT` 环境变量 → 代码位置 → 向上找 `.generations` 取其父目录为 profiles 根 → 扫 `$DSH_HOME/profiles` 与 `~/.dsh/profiles`**；
  扫描时优先认「目录里真有 `cordis.patch.yml`」的 profile。
  连带修好 `resolveProfileName()`：此前它跟着推错，导致设置落到 `qqbot-settings/_default/` 而不是 `.../<profile>/`。
- **入群审批：申请群就是 hub 群时只「注记不唤醒」**：`safeAppendUserMessage` 只把申请写进会话，不叫醒 AI，
  要等下次有人说话才被带进上下文 —— 表现为「hub 群里完全收不到提醒」。现在 `isHub` 分支里若 `pollJoinRequests.wakeGroup` 为真，
  会再 `wakeSessionAgent(hub 会话)` 一次。（1.10.12 补的是「hub 失效时唤醒申请群」，这次补齐 hub 群自身。）


## [1.10.12] - 2026-10-20

### 新增
- **`recall_keywords` 工具**：让 AI 自己维护「命中即撤回（可顺带禁言）」的关键词，不用碰面板。
  `action`: `list` / `add` / `remove` / `set` / `clear`；`words` 多个用逗号/顿号/换行分隔；
  另可一起改 `muteSeconds`（命中后禁言秒数）与 `enable`（开关自动撤回）。改完立刻生效。

### 修复
- **入群审批「唤醒普通群 AI」被误包在"群管会话注入成功"分支里**（`src/features/group-join-request.ts`）：
  `hubR === 'ok'` 才走 `wakeGroup`，一旦 hub 未设/失效（如重新保存群管设置后 `hubSessionId` 指向的会话没了），
  整条"唤醒申请所在群 AI"的路径就消失 —— 表现是「重新保存群管设置后，入群申请不再进 AI 上下文」、
  只剩 QQ 里一条静态提醒。已补无 hub 兜底：hub 不成功也 `findByPeer`/`getOrCreate` 申请群会话并唤醒它。
- **自动撤回的关键词改为"盘上优先"**：`readAutoRecallFromDiskMw(config) ?? config.groupAdmin?.autoRecall`。
  面板改完立刻生效，不再依赖 settings 热更是否落到闭包里的 config（此前会出现"面板已保存、收消息仍按旧规则"）。
- 删掉 `handleInbound` 里那份"只撤不拦"的重复自动撤回（它在 debounce 之后，既拦不住也容易与中间件重复发请求）。


## [1.10.11] - 2026-10-20

### 新增
- **群消息撤回（三个工具）**：`group_recall`（撤某人最近一条 / 群里最近一条 / 指定 message_id）、
  `group_msg_search`（按关键词 / 类型搜台账，含机器人自己发的）、`group_recall_batch`（批量撤 + 可选批量禁言）。
  机器人是群管理员时可撤回**普通成员**的消息，官方窗口 2 分钟（`group_recall_batch` 就是为此而生）。
  `gid` 是**可选**的：不传=当前会话所在的群；要操作别的群（机器人也是那个群管理员）才传。
- **自动撤回**（`groupAdmin.autoRecall`）：命中关键词或附件类型（文本/图片/语音/视频/文件）时**立刻撤回**，不走 AI。
  `mode=keep` 只撤消息、`mode=drop` 连 AI 都收不到；`muteSeconds` 顺带禁言、`dryRun` 演练只看日志。
  ★ 挂载点是 **debounce 之前**的中间件 —— 写在 `bot.on('message')` 会被 debounce 吃掉，写在 `handleInbound` 又要等派发、早过 2 分钟窗口（两种都实测踩过）。
- **消息历史台账**：`{dataRoot}/.qqbot/msg-history/<group_群号|c2c_对方>/<YYYY-MM-DD>.jsonl` ——
  一会话一个目录、一天一个文件、默认保留 7 天（启动时 + 每 200 次写清理过期文件）；
  入站（handleInbound）与出站（pushSent）都记，行内含 `message_id` / 发送者 / 昵称 / 类型 / 正文摘要 / 时间 / 是否机器人。
  每个群目录里会生成 `<群名>.txt`、根目录生成 `_索引.txt`，方便人工辨认（群名从 `.qqbot/groups.json` 取，改名会自动重建）。
- 设置面板新增「🔨 锤子 → ♻️ 自动撤回」子标签：启用、命中后模式、关键词多行、附件类型、顺带禁言秒数、演练、保存即时生效。

### 修复
- 「自动撤回」页的保存**复用了群组设置的保存逻辑**，会把本页不存在的字段（如「群管理」开关）用 state 旧值一起提交，
  表现为「保存自动撤回之后群管理被关掉、群工具全部报非群会话」；已改为 `saveAutoRecallOnly()`，只 patch `autoRecall`。
- 群管理工具的默认群解析：优先用**会话自己的 `peerId`**（入站群 openid），不再被"最近一次出站目标"带偏；
  找不到群会话记录时，依次回退 `manageGroup` / "最近有消息写入的群目录"。
- settings 热更新可能没落到 `handleInbound` 闭包里的 config（实测"面板已保存、收消息却当没规则"）：
  自动撤回读取加兜底 —— `config.autoRecall ?? 直接读 ~/.dsh/qqbot-settings/<profile>/<ns>.json`。

### 文档 / 脚本
- **升级 dsh 0.2.1-rc.2 后 `{{cwd}}` 会让整轮直接失败**（`unknown prompt variable "{{cwd}}" ... registered variables: provider, model`）：
  新版系统提示词走严格插值，只注册 `provider` / `model`，工作目录改由「工作目录服务」以运行时上下文注入。
  组装阶段就抛错 ⇒ **模型请求根本发不出去**，表现是「本轮运行失败」而不是模型回话失败。
  - README / README_EN 新增 FAQ 条目：官方内置预设没事，出问题的是**从旧模板复制出来的自建预设** ——
    `prefix` / `suffix` 里还留着 `当前工作目录 {{cwd}}` 或 `Your working directory is {{cwd}}.`，删掉那半句即可（保留 `{{model}}`）。
  - 新增 **`scripts/fix-preset-cwd.mjs`**：只清理用户自带 `cordis.patch.yml` 里 `preset-<name>` 块的 persona 明文与模板注释，
    默认只处理挂 QQ 工具的预设（块含 `im-qqbot`，或名字出现在 im-qqbot 的 `preset:` 配置里）；
    幂等、`--dry-run`、写前自动备份、`suffix:` 删空补 `''`（避免 YAML 变 null）。
    用法：`node scripts/fix-preset-cwd.mjs --dry-run` / `--scan` / `--file <path>` / `--all`。

## [1.10.10] - 2026-10-17

### 新增
- **第六套扩展点「出站扩展」**（`{dataRoot}/.qqbot-extensions/outbound/*.mjs`，`src/features/ext-outbound.ts`）：
  与**入站扩展**严格对称 —— 入站管"消息**进来**时改它/杀它"，出站管"消息**出去**时改它/杀它/**补发媒体**"。
  只扫直接子文件、按文件名升序、放宽 `.js/.mjs/.cjs`；失败只 warn 不影响正文；连续 5 次抛错自动熔断
  （`resetOutboundBreaker()` 复位）。
  - `ctx.target` = `{ scope, peerId, msgId? }`（被动回复靠它自带的 `msgId`）、`ctx.turnId`/`ctx.chunkIndex`/`ctx.isLastChunk`、
    `ctx.rewrite()`/`ctx.annihilate()`、`ctx.sendMedia()`/`ctx.send()`（**先被动后主动**）、`ctx.note()`。
  - **`ctx.phase`**：`'send'` = 正文**发送前**（挂载点在 `sendRichOutbound` 入口，只做改写/消灭）；
    `'turnEnd'` = **回合真正结束**（挂载点在 `outbound.ts` 的 `turn/end`，`flush()` 之后）——
    此处 `ctx.text` 就是该回合**权威的最后一块正文**。一段回复会被拆成多个正文块，
    **配图只放 `'turnEnd'`**，否则第一段根本不是最后一块（真机实测抓到）。
  - **`ctx.background(fn)`**：重活（选图/算分/发媒体）**丢后台、绝不 await**，正文该多快就多快。
    出站链与正文**唯一的联系就是"读一眼正文写了什么"**。反面教材：曾在链上同步扫全库 1892 张图
    ⇒ 打满 `sendRichOutbound` 的 3 秒硬超时 ⇒ **连正文都发不出去**。
  - 对外 API `globalThis[Symbol.for('im-qqbot.outbound')]`：`send/sendMedia/last/active`（+ `embed/embedAvailable`）。
  - 示范与文档：`examples/ext-outbound/sticker-semantic.mjs`、**`examples/ext-outbound/README.md`**（新增）。
- **「自动配表情包」示范**（`examples/ext-outbound/sticker-semantic.mjs`，配工具 `examples/ext-tools/sticker_auto.mjs`）：
  取**本回合最后一段正文**当查询串，两阶段召回选图 —— 阶段1 随机抽 300 张收集其 `tags`（几百个关键词），
  用本地小模型 `bge-small-zh`（缺失自动退化字符 bigram）给关键词打分并过**存在性闸门**
  （`均值 + 1.2*标准差`）+ **绝对地板**（两个 scorer 分数量级差 10 倍 ⇒ `FLOOR_EMBED`/`FLOOR_BIGRAM` 分两套）；
  阶段2 拿选中关键词**回全库精确搜**（零模型开销）随机取一张，走 `ctx.sendMedia()` 独立通道补发。
  - ★ **隔离设置**：只对**点名的群/私聊**生效（`.qqbot-extensions/data/sticker-semantic-scope.json`，
    `whitelist` + 空名单 = **谁都不发**，`mode:"all"` 才全局；读不到/读坏了都从"不发"一侧失败）。
    工具动作：`sticker_auto {action:'scope-add'|'scope-remove'|'scope-list'|'scope-mode'|'scope-clear'}`。
  - 自带诊断日志 `.qqbot-extensions/data/sticker-semantic-diag.log`（每步留痕，因为出站扩展的失败全是静默的）。

### 修复
- **合并 `origin/main` 后 `qq-user-questions.ts` 编译失败（TS2345）**：`record.replyTarget` 的声明处
  写成 `scope: string`，透传给 `sendMarkdownWithKeyboard` 时报错。改用 `ReplyTarget['scope']`
  （`scope` 是 `ChatScope` 联合类型，不能退化成 `string`）。
- **私聊（c2c）相关修复与文档**（PR #13 / `c9f13f6` / `e94e8b1` 等，本次一并发布）：
  私聊卡片 `type=2`、抢答补发改用带 `msgId` 的 `record.replyTarget`（走被动通道）、
  私聊不再把 openid 当 `gid` 用、价值评分等群专有链路在 c2c 显式放开、日志路径按 dataRoot 拼。
  ⚠️ 投票结束要恢复唤醒 AI（`POLL_WAKE_AI` 别设 false）。

## [1.10.9] - 2026-10-16

### 文档
- **「群守则」区块的说明文案改清楚**（`client/qqbot-settings.js`）：原来说"每轮回复都会带上的一段提醒(所有 QQ 群都生效, **不碰你的人格设定**)"，
  后半句容易读成"在这里写了也没用"。现在明确写成：**这里也能直接写人设／性格要求，改完点下方「保存」立刻生效，不用去改 `cordis.patch.yml`**
  （想整体换人格仍可在下面的「Agent 预设」里换 preset）；并保留"清空 = 不主动发图"这条原有用途。
  - 注：该说明在前端是**纯文本渲染**，所以文案里不能用 Markdown 的 `**`（会原样显示星号），强调一律用中文引号「」。

## [1.10.8] - 2026-10-16

### 修复
- **`dedupeYamlKeys` 会误删 profile patch 的键行 ⇒ 所有会话 resume 失败**（`settings-host.js`，issue #11 / @tyjianxianyu 报告，本机已复现）：
  - **症状**：设置页保存一次账号，`cordis.patch.yml` 被**静默删掉几行**（YAML 仍合法，语义已坏）。
    删掉 `subagent-model-selection-settings` 的 `model:` 行后，该 entry 校验报
    `subagent model selection requires non-empty provider and model ids` ⇒ 服务不注册 ⇒
    **全部会话 resume 失败**。
  - **根因 1（致命）**：**行首 `-` 的列表项不压栈**。`- provider: buddy` 的每个 item 本是独立节点，
    原实现直接跳过 ⇒ 其子键（`model: A`）挂到**上一个 item 的父级** ⇒ 两个 item 的同名子键
    拿到同一签名 ⇒ 前一个被当成"重复键"删掉。实测：`allowedModels` 两项的 `model:` 2 个 → 1 个。
  - **根因 2（隐蔽）**：**键名正则禁止冒号**。`([^\s:][^:]*?)` 在第一个冒号处就切 ⇒ `include:aaa:`
    的键被读成 `include` ⇒ 父路径错、子键被误删（不报错，只是 auto-capture 拿不到数据源）。
  - **修法**：列表项用递增序号压栈（`-[1]`/`-[2]`…，计数器**放在循环外**）；键名正则放开为
    `(\S.*?):(\s|$)`。新增 4 个单测（键名含冒号 / 列表项 / 列表项内真重复键 / 多层嵌套列表项）。
  - **验证**：两个最小复现均"一行不删"；**线上真实 `cordis.patch.yml` 2102 行 → 2102 行、逐字节不变**。
  - 注：PR #9（判重作用域改"父键路径 + 键名"）已合入，本次修的是它之后仍漏的另两种形状。
- **插话模式下群友发的图/文件看不到链接**（`src/gateway/debounce.ts` 的 `attachmentNote`）：
  - **症状**：插话注入的入站消息里，群友发的图片只显示 `[愤怒的小鸟] (无文字内容)`，
    模型完全看不到附件。
  - **根因**：该函数读的是 `a.type`，而 QQ 网关原始附件字段是 **`content_type`（snake_case）**
    （见 `src/types.ts` 的 `RawAttachment`，注释明写"snake_case 字段，来自 QQ 网关 C2C_MESSAGE_CREATE"）
    ⇒ 取到空串 ⇒ 所有类型分支都进不去 ⇒ 附件描述为空 ⇒ 正文回落成 `(无文字内容)`。
  - **修法**：三读 `content_type ?? contentType ?? type`；并补上本来就丢链接的两处 ——
    `video` 原来只输出 `[视频]`、`file` 原来只有文件名，现在都带 URL；另加"认不出的类型也把
    原始类型 + 链接带出去"的兜底，不再静默丢。

## [1.10.7] - 2026-10-15

### 修复
- **QQ 转发（子会话 → 群）在 msg_id 过期后会静默丢内容**（`examples/ext-tools/lib/session_watch_lib.mjs`）：
  - 真因：`fwd.replyTarget` 里钉着**绑定那一刻的 msgId**，而 QQ 被动回复的 `msg_id` **会过期**
    （实测报 `API Error: 回复消息msg_id已过期`），markdown 与纯文本两条降级链**都**因此失败，
    内容无声丢失；新建盯梢 msgId 新鲜所以看不出问题。
  - 现在按"适配主动"处理（与 `outbound.ts` 的 `ADAPTIVE_MAX_PASSIVE` 同口径）：
    ① 每次转发前**刷新** target 为最新注入的 `replyTarget`；
    ② 同一 msgId **数到 4 条**就主动转主动（摘掉 msgId），不等它失败；
    ③ 真失败（过期/超限）⇒ **摘掉 msgId 重发**兜底（会耗主动配额，但优于丢消息）。
- **转发失败不再静默**：新增 `{数据根}/.qqbot-extensions/data/session-watch-diag.log` ——
  每回合**无条件**记一行 `turn-end mode/texts/errs/textLen/seen`，转发 `ok/skip/fail` 全落盘。
  此前 `forwardToQq` 三个条件任一不满足就 `return ''`，日志里一个字都没有，真机上无从定位。

### 新增
- **二档「引用回流」彻底隔绝**（`examples/ext-inbound/no-wake-on-child-quote.mjs`）：
  只要这条消息**引用的是子会话转发**（`【子会话 xxx】`），就在早挂点**整条消灭**
  （不进群历史、不进父上下文、不占群冷却），并**自己投递给被引消息所属的子会话**
  （消息被消灭后，原路径的 `user/message` 钩子永远不会发生，不自己投就等于消息凭空消失）。
  - 开关：`ANNIHILATE_ANY_CHILD_QUOTE`；带 `[s:xxx]` **路由标记**的消息**让路**给
    `route-isolate`（由它消灭 + 投递），避免双投。
  - ⚠️ 消灭必须写成 `ctx.annihilate(...)` **然后照常 `return next()`** ——
    省掉 next 会触发引擎"扩展既没调 next、又没成功消灭就替它放行"的兜底，等于没消灭。

### 文档
- 三层热更新的对应关系（踩过才写下的）：
  - `tools/`、`commands/` 下的文件 → `tools_reload` 即可；
  - **`tools/lib/*.mjs` → 必须调 `session_watch action=rehydrate`**（`list` 不触发 `installHook`，
    新代码不会接管）；
  - `hooks/` 下的钩子 → 启动期加载，**必须重启宿主**。

## [1.10.6] - 2026-10-15

### 修复
- **在服务器 / 非桌面环境下装不上插件**：修掉两处依赖声明，pnpm 默认配置下即可一次装成。
  - `peerDependenciesMeta` 里 5 个 `@deepseek-ai/*` 原本写成 `"optional": false`，语义是
    **要求 pnpm 必须自动安装**这些 peer；而它们的依赖链里有 `dsh-scope`、`dsh-system-prompt`
    这类**在公开 npm 上已不存在 `0.1.x` 版本**的内部包（只剩 `0.0.1-rc.1` 与 `0.2.x`），
    一解析就报 `ERR_PNPM_NO_MATCHING_VERSION`，导致整次安装失败。改为 `optional: true` 后
    pnpm 不再自动安装它们（运行时有宿主提供），安装恢复正常。
  - `@huggingface/transformers` 从 `dependencies` 移到 `optionalDependencies`：它的传递依赖
    `onnxruntime-node` 的安装脚本在部分网络环境下会失败
    （`Failed to download build list. HTTP status code = 302`），原先**一次失败就让 pnpm
    退出码 1、整次安装作废**；放进 optional 后语义变成"尽力安装、失败不阻塞"，而代码里本来
    就只在一处动态 `import`、且带程序兜底（小模型不可用时自动降级）。
  - 实测（Ubuntu 云服务器 + Node 22.23.2 + pnpm 9.15.9 + 默认 pnpm 配置）：
    修复前 `NOT_INSTALLED` 且卡死；修复后 **3.5 秒装成、退出码 0**。

### 文档
- 部署到服务器 / 公网时，另有两条**环境侧**注意事项（不是插件能修的，记录备查）：
  1. dsh 调用 pnpm 时**不传 `-w`**，而 profile 是 pnpm workspace root ⇒ 会弹出
     "是否加到 workspace root"的交互询问，而它 stdin 是空设备 ⇒ **静默卡死**
     （进程 0 CPU、零输出）。部署环境需先执行
     `pnpm config set ignore-workspace-root-check true`。
  2. Node 建议用**最新的 22.x**：dsh 0.2.1-alpha.1 在 Node **22.11** 上会零输出、
     退出码 0 静默退出（`--trace-uncaught` 也抓不到），升到 22.23 立即正常。

## [1.10.5] - 2026-10-14

### 新增
- **二档「路由彻底隔绝」**：新增入站扩展示例 `examples/ext-inbound/route-isolate.mjs` ——
  群里带 `[s:xxx]` 的路由消息，若目标会话是**二档**绑定，就在**早挂点**用 `annihilate()` 从父会话
  上下文里彻底移除（不进群历史、不进上下文、不占冷却），并由扩展**自己完成投递**（消息被消灭后
  `user/message` 事件不会再发生，原来那条投递路径不会跑）。⇒ 二档的语义从此是**双向隔绝**。
  安全阀：id 解析不到 / `annihilate` 被拒 / 非二档 ⇒ 一律放行不吞，绝不吞掉一条投不出去的消息。
- **入站扩展：`annihilate({ ownerAck: true })`** —— 唯一能消灭「主人消息」的显式通道。
  默认白名单一个字没改（主人消息永不被吞）；扩展声明"内容已另行投递到别处"时才放行，并落审计
  `ok-owner-ack` + 一条 warn，只解开**这一条**、熔断等保护照旧。老版本不认识该字段 ⇒ 自动退回旧行为。
- **父会话跟着「QQ 对象」走**：盯梢不再只认绑定时写死的会话 id，而是维护
  `QQ对象(scope:peerId) → 最近为该对象发言的会话` 的映射，回灌前按对象解析、失败才回落旧 id。
  ⇒ 在 QQ 里发 `/bot-new` 换会话后，**回灌自动跟到新会话**（老记录在"父会话下次发言"时自愈补上）。
  `session_watch action=list` 新增 `peerKey` / `effectiveParentShortId` 两列。

### 修复
- **重启后「转发 QQ」静默失效**：`fwd = { sender, replyTarget }` 是内存态、重启必丢，而兜底路径
  "父会话发言时从 root 取 sender"实测拿不到 ⇒ 只有盯梢工具被调用过才会注入，于是重启后
  `session_watch action=list` 全是 `QQ转发=未就绪`，子会话说了话只进不了群。
  现在把 `rememberFwd` 挂到**入站链**上（每条群消息刷新一次）⇒ 重启后父会话随口说一句即自动恢复；
  列表也会如实显示 `QQ转发=未就绪/就绪`。

### 文档
- `examples/ext-inbound/README.md` 新增 `ownerAck` 一节（含"消灭之后照样要 `return next()`"这个坑）。
- `docs/USER-GUIDE.md` 补「跨会话路由与二档双向隔绝」「父会话跟着 QQ 对象走」两节。
- 维护手册新增 §11.23：入站扩展三连坑（正文字段 / 两道白名单 / 诊断必须落盘）+ fwd 重启丢失的根治。

## [1.10.4] - 2026-10-14

### 修复 · `/会话列表` 选了工作区就报「这个向导已经过期了」（向导状态**跨模块实例**丢失）

- **现象**：卡正常发出来、工作区也列得出来，一点字母按钮就回「这个向导已经过期了」。
  诊断日志里同时出现两行互相矛盾的信息：
  `[paint] … 表=2`（命令侧**写进去过**）与 `[onInteraction] … 命中=false keys=[]`（回调侧**看到的是空表**）。
- **真因**：插件对 `ext-commands` 有**两条独立加载路径**（斜杠命令注册 / 卡片回调查表），
  `tools_reload` 只热刷其中一条 ⇒ **同一个文件被实例化成两份模块**，
  各自持有自己的 `W` / `KERNEL` / `CTX_CACHE`：
  命令侧实例把状态写进它自己的 `W`（seq 正常递增，看着一切正常），
  回调侧实例的 `W` 永远是空的 ⇒ 一点就"过期"。
  （`/子会话` 没暴露是因为它自上次宿主重启后没被改过 —— 两条路径拿到的是同一个实例。）
- **修法**（凡是**回调侧要用**的东西都不再只放模块变量）：
  1. **`globalThis` 符号槽**（`publishShared` / `adoptShared`）—— handler 把
     `kernel / sender / replyTarget / parentId / dataRoot` 推进去，回调侧先 `adoptShared` 再干活；
  2. **向导状态落盘**（`.qqbot/session-list-wizard.json`，带 `expireAt`、最多留 20 张）——
     `paint()` 里 `await saveState()`，回调侧 `W` 未命中时 `loadState()` 兜底，选完/取消就删；
  3. 父会话 id 改从**向导状态里存的那份**取（回调侧自己的 `CTX_CACHE` 必然是空的）；
  4. 模块变量降级为"本地缓存"，只做加速、不做唯一来源。
- **验证**（headless 双实例自检，用两个不同 `?v=` 各 import 一次命令模块，正是真机场景）：
  实例 A 走 handler 发卡（`会话列表-1-…`，workspace，8 个候选）→ **实例 B（`W` 全空）**点 `p0`
  ⇒ **不再报过期**，状态推进到 `session` 并列出 **80** 个候选（含 `🟢 带标题的在线会话` 等）。
- **附带**：`onInteraction` 的日志补了 `kernel=??`，以后同类问题一眼看出是"实例分裂"还是"真过期"。

## [1.10.3] - 2026-10-14

### 新增 · 通用路由：正文里带 `[s:会话id]`，这条消息就投给那个会话

- **怎么写**：群里任何一条消息，只要**正文**里有 `[s:8位短id]`（也认 `【会话 完整id】`），
  就会被投递进那个会话；**标记自动剥掉**，对方看到的是干净正文。
- **和「引用回流」的分工**（一"回"一"去"，别混）：
  - **引用回流**（v1.10.2）= **回** —— 必须**引用子会话发的那条转发消息**，靠行首 `【子会话 xxxx】` 认路；
  - **通用路由**（本版）= **去** —— **任意会话**都行，**不用先绑过、不用是子会话**，只认正文里的 id。
- **顺带能把附件送过去**：`attachmentsOf(ev)` 会把这条消息带的**图片/文件**一并作为附件投进去
  ⇒ 「先引用一张图，再补一行 `[s:xxxxxxxx]`」就能把图路由给对方。
- **忙 / 闲**：目标**正在跑 → 插话**（`inject`，不另起一轮）；**空闲 → 唤醒**（`followup`）。
- **前提**：目标会话**必须是活着的**（宿主里有它的 agent），否则**静默跳过**，绝不猜、也绝不新建。
- 短 id → 完整 id 的解析：**先查 live**，查不到再**扫盘**（`findSessionOnDisk`，比对原始名与
  `shortSessionId(name)` 两种形态 —— 子会话目录名是 `session-<uuid>`，只比裸 id 会全落空）。

### 新增 · `/会话列表` 命令（三步向导选任意会话 + 一行可复制的路由模板）

- **三步**（每页 20 个，点字母选，可翻页 / 取消）：
  1. **工作区** —— 显示**真实文件夹路径** + 该区会话数，多的在前；
  2. **该区会话** —— `🟢/⚪ 标题 · 短id · 创建时间`（🟢=正在跑，⚪=已休眠，**都能绑**）；
  3. **回灌档位** —— 一档 / 二档 / 三档（含义同 `/子会话`）。
- **收尾吐出模板** `[s:xxxxxxxx] 在这里写你要发给这个会话的内容` —— 复制、改后半句、发群即达。
- **不必是子会话**：`register()` 的 `childSessionId` 本来就是"任意会话 id"，休眠的会被唤醒。
- 别名：`/sessionlist`、`/sessions`。

### 修复 · 会话列表**不再解压 `.zstd`**，改问宿主服务（快且不卡）

- 宿主 `.jsonl.zstd` 是**多帧压缩**，`zstdDecompressSync` 与 `createZstdDecompress` **都只解第一帧**
  且**不抛错** ⇒ 多帧兜底永远触发不了、标题永远读不出来。**改走宿主服务**：
  `kernel.get('sessionPersistence').list()` 拿**全部会话 + 真实 `cwd`**（实测 1062 条）；
  `kernel.get('sessions').list()` 拿 live 会话，标题在每项的 **`log` 里倒着找 `session/title` 事件的
  `data.title`**（实测 14 个 live 会话全部取到）。
- 两条实测坑写进注释：① **`sessionTitle.get()` 在本版宿主是坏的**（抛
  `session.snapshotEvents is not a function`）；② **`kernel.ctx` / `kernel.caps` 是 cordis getter，
  未 inject 时读取即抛**（`cannot get property "ctx" without inject`）—— 取服务只写 `kernel.get(name)`，
  兜底分支必须逐个 `try`。
- **已知边界**：宿主**不给已结束的会话存标题** ⇒ 那些只能显示短 id + 创建时间；
  live（有标题）的排在列表最前。

### 文档

- `docs/USER-GUIDE.md`：新增 **「会话列表 · `/会话列表`」** 与 **「通用路由 · 正文里带 `[s:会话id]`」** 两节，
  含三步说明、`🟢/⚪` 图例、"只有 live 才有标题"的边界、以及和「引用回流」的区别。
- 维护手册新增 **§11.22** —— 宿主会话/标题的取法对照表 + **三条死路**（`sessionTitle` 坏、
  持久化 header 没 title、cordis getter 读取即抛）+ id 两种写法的归一化。

## [1.10.2] - 2026-10-13

### 修复 · 重启后「QQ 转发」静默失效（连带引用回流认不到路）

- **根因**：`fwd = { sender, replyTarget }` **不可序列化**（`sender` 是 live 的 bot 对象）⇒ 启动恢复的名单里
  它只能是 `null` ⇒ `forwardToQq` 首句 `if (!fwd?.sender || !fwd?.replyTarget || !body) return ''` 直接返回。
  症状是"**一个根因、两个**"：**回灌照常进父会话，但不再转发到 QQ**；而转发一断，群里就没有那条
  带行首 `【子会话 xxxx】` 的转发消息 ⇒ **引用回流也认不到路**（`OWNER_RE` 匹配不上）。
- **修法**：① `session_watch` 工具每次被调用时把 `env.sender` / `env.replyTarget` **注入共享位**（`rememberFwd`）
  —— **工具 env 一定有这两样，而插件根 ctx 上实测拿不到**（这是第一次尝试失败的原因）；
  ② `hydrateFwd()` **优先读这个共享位**（再退回 root.bot）；③ **`rehydrate()` 顺手对每条盯梢补一次**
  ⇒ **跑一次 `session_watch action=rehydrate` 就全恢复**（不必重启，也不用等父会话发言）。

### 新增 · `session_watch action=rehydrate`

- 调用它 = **读回落盘名单 + 重装回灌监听器（`installHook`）**，顺带补回 QQ 转发能力。
- 意义：`tools/lib/*.mjs` 是按 mtime 版本化加载的，**新代码只有在 `installHook()` 被调用时才接管运行中的
  监听器** —— 此前改完 lib 必须重启宿主才生效，现在 `tools_reload` 后跑一次它即可。
- 也认 `重载` / `刷新`。

### 文档

- `docs/USER-GUIDE.md`：新增 **「引用回流」** 一节 —— 怎么用（引用那条转发消息即可）、它收到什么载荷、
  **忙→插话 / 闲→唤醒** 两种处理、只认行首归属短 id 且**当场解析不依赖台账**、
  **前提是子会话必须活着**（没活着静默跳过），以及用 `session_watch list` 的 `最近被引用` 验证。

## [1.10.1] - 2026-10-13

### 文档 · 把 v1.10.0 的能力补进契约与用户手册（v1.10.0 发得急，文档没跟上）

- `docs/extension-contract.md`：能力表新增 **`env.peerSessionId`** —— 本 QQ 会话对应的 **DSH 会话 id**
  （= `session/event` 里那个 `session.id`，**不是 `agent.id`**）；跨会话回灌 / 引用回流判"父会话"用的就是它，
  v1.10.0 起命令与按钮回调侧都能拿到。
- `docs/USER-GUIDE.md`：跨会话一节补上 **`/子会话` 命令**的完整用法（"不要会话名、第一段就是要说的话、
  其余参数自动摘词或走卡片向导"）、**三种回灌档位**（一档末段回灌+转 QQ / 二档只转 QQ / 三档进父不唤醒），
  以及 **"重启不丢"**（名单落盘 + 启动钩子自动读回并重装监听器）。
- **代码与 v1.10.0 完全一致**，只差这两份文档（同版本号不能重发，故出 1.10.1）。

## [1.10.0] - 2026-10-13

### 新增 · 跨会话工具链：持久化 + 启动自恢复

- **盯梢名单真正落盘**：`{数据根}/.qqbot-extensions/tools/data/session-watch-watching.json`
  （与 `vote.json` 同一个 data 目录）。此前 `setStateFile()` **全项目无人调用** ⇒ `stateFileOf()` 恒为空
  ⇒ `persist()` 里 `if (!file) return` 直接空转 ⇒ **名单从来没落过盘**，重启必丢。现已补默认路径兜底。
- **启动钩子自动恢复**：`examples/ext-hooks/session-watch-hook.mjs` 在启动时调 `rehydrate()` ——
  读回名单 **+ 重装 `session/event` 监听器**（监听器是内存态、重启必丢，只能靠启动重装）。
- **命令能力包新增 `peerSessionId`**：命令/回调侧以前**拿不到"本会话的 DSH 会话 id"**，而回灌钩子
  判"父会话"用的正是 `session/event` 里的 `session.id`（**不是 `agent.id`**）—— 于是 `register()`
  因缺 `parentAgentId` 直接返回「未挂」。现在 `capsForCmd` 会带上 `manager.sessionIdFor(scope, peerId)`
  （带派生兜底，总有值）。
- **新增第五套示例铺设**：`examples/ext-commands/` → `.qqbot-extensions/commands/`
  （跨会话 `/子会话` 卡片向导；纪律同前：**只补不存在**，绝不覆盖用户改过的同名文件）。
- **修正富媒体提示词**：原文把"两端加英文方括号"写成括号注释，模型极易漏掉方括号
  （漏了=富媒体不生效，还会把裸标记当正文发出去）⇒ 改成硬约束 + 带方括号的完整示例。

### 示例更新（只动跨会话那一套）

- `examples/ext-tools/lib/session_watch_lib.mjs`（17KB → 36KB：存档为真源 + `ensureLoaded()` + `rehydrate()`）
- `examples/ext-tools/` 新增 `session_children.mjs`；同步 `session_create` / `session_watch` /
  `sessions_list` / `session_send`
- `examples/ext-hooks/session-watch-hook.mjs` 重写为真正的"启动恢复"钩子

## [1.9.3] - 2026-10-12

### 修复 · 新契约文档没进 npm 包

- v1.9.2 补的 `docs/extension-contract.md`（面向插件新用户的完整扩展契约）**不在 `files` 白名单里**，
  于是 **npm 上那份包里没有它** —— 而 `README.md` 正好指向 `./docs/extension-contract.md`，
  在 npm 页面点过去会 404。已加进 `files`。
- 1.9.2 已发布、同版本号不能重发，故出 1.9.3；**代码与 1.9.2 完全一致**，只差这一个文件。
## [1.9.2] - 2026-10-12

### 变更 · 扩展能力面**对齐**：入站扩展拿到统一能力包（主人定）

- **入站扩展（第五套）以前是"二等公民"**：只有一套私有小 ctx，`docs/USER-GUIDE.md` 契约里那
  13 项能力（`store` / `api()` / `markdown` / `at` / `user` / `owners` / `peer` / `kernel` …
  **以及 `appendSilent`**）**一项都没给**。现在**直接复用 `makeExtCaps`**，与另外四套同一份实现。
- **`appendSilent` 就是"静默进上下文"**：契约里本来就有，不必新造；入站侧由此也能"内容静默进上下文、不唤醒"。
- **入站操控那一组也进了包**（`ctx.caps.inbound`）：`annihilate` / `rewrite` / `forceWake` / `decide` /
  `silentInto` / `muteUser` 系列 / `message` 只读视图 / `kv`。**只有入站扩展拿得到**（其余四套是
  `undefined` —— 那是语义不是缺失，因为只有它跑在"一条消息正在进站"的时刻）。
- ⚠️ **唯一同名冲突（有意为之）**：`text`。入站侧 `ctx.text` 仍是"当前正文"（读），
  发文本走命名空间 `ctx.caps.text(...)`。
- 挂载点补喂统一能力包要的输入（sender / replyTarget / appSecret / apiCall / kernel / resolveAgent），
  全部**只补不覆盖**、构造失败只告警一次、拿不到依赖优雅降级 —— 入站主链绝不被它拖断。

### 文档

- `docs/USER-GUIDE.md` §「统一能力包」：**从"三套"改到"五套"**（补上 `hooks/` 与 `inbound/`），
  新增「入站操控」一节（含逐项说明、同名冲突、热路径警告）。

### 测试

- 新增 7 项"对齐证据"：断言统一能力包成员、入站专属动作不被覆盖、`text` 冲突按约定解、
  缺依赖时优雅降级、`caps.inbound` 齐全且与 ctx 平铺的读同一份现场、别的四套拿不到这一组。
## [1.9.1] - 2026-10-12

### 修复 · 入站扩展示例不再"自己跑起来"，也不再往用户数据目录写无关文件

- **示例不再整套自动铺**：`examples/ext-inbound/` 里**只有 `no-wake-on-child-quote.mjs` 会铺到**
  `{dataRoot}/.qqbot-extensions/inbound/` —— 它只在"引用一条子会话转发消息"时改一下 @ 判定，
  不改内容、不写状态、不动手（配套：`copyExampleTree` 支持**顶层文件名白名单**）。
  `class-advisor.mjs` 这种**会真删消息、真封人**的示例**不自动铺**，要自己拷过去 ——
  示例是给人看和抄的，不该在用户没读过它之前就自己跑起来。
- **`class-advisor` 默认只观察不动手**：新增 `DRY_RUN = true` 总闸（带运行时开关 `setLive()`）。
  装上先往日志打"本来会做什么"，确认规则符合预期再改 `false`。**装上不等于放权。**
- **修掉一处"每来一条群消息就写一次盘"**：`class-advisor` 的刷屏计数原本用 `ctx.kv` 落盘，
  而该函数对**每一条**入站消息都会被调到 ⇒ 每条群消息同步写一次状态文件。30 秒的窗口没必要持久化，
  已改为进程内内存计数，**这条路径不再碰磁盘**。

### 文档

- `examples/ext-inbound/README.md`：标明哪个示例会自动铺、哪个要自己拷；各自会往哪写什么。

## [1.9.0] - 2026-10-12

### 新增 · 第五套用户扩展「入站中间件」

- 目录 `{dataRoot}/.qqbot-extensions/inbound/*.mjs`：与插件内部 `bot.use(mw)` **同一签名**，
  每条入站消息都过一遍（区别于 `hooks/` 的"启动跑一次"）。
- **两个挂点**：`onInbound(ctx,next)` 早（引用解析之后、**记群历史之前**）／
  `onDecide(ctx,next)` 或 `export default` 晚（@门控之后，语义与旧契约一致）。
- **四个动作**：`ctx.annihilate()`（消灭：不进历史/不进上下文/不占冷却）、
  `ctx.rewrite()`（改写，早挂点下历史也改）、`ctx.forceWake()`（跳过 @门控/价值评分/群冷却）、
  `ctx.decide({mention})`（覆盖 @ 判定）。
- **用户维禁言**：`ctx.muteUser/unmuteUser/isMuted/mutedUsers`，名单持久化到
  `{dataRoot}/.qqbot-extensions/inbound/.state/<扩展名>.json`（带期限、过期惰性清理、坏文件不崩）。
- **四条保命件**：白名单最高优先（主人不可被静默）、强唤醒优先于静默、熔断（单扩展静默占比过高自动停手）、
  审计 + 可撤销（每次动作追加 `audit.jsonl`，带轮转）。
- **示例**：`examples/ext-inbound/class-advisor.mjs`（辅导员四件事，**默认只观察不动手**，
  看完日志再改 `DRY_RUN = false`）、`no-wake-on-child-quote.mjs`（引用子会话转发不算 @）。

### 修复 · 延迟聚合里「@ 判定只升不降」导致入站扩展改不动 wasMentioned

- `debounce` 从群历史 store 重建聚合窗口时用 `if (e.wasMentioned) hit.wasMentioned = true`（只升不降），
  会把入站扩展压下去的 `false` 顶回 `true` —— 静默 3 秒后照样强制唤醒。
  改为**以窗口条目（链上实时判定）为准**：`hit.wasMentioned = e.wasMentioned === true`。
- 真 @ 时两者同源同值，**无回归**；只有被入站扩展显式压掉的那种才会分歧。

## [1.8.9] - 2026-10-12

> 新增**启动钩子（ext-hooks）扩展点** —— 第四套用户扩展：`hooks/*.mjs` 在插件启动时**自动跑一次**，不需要任何人调用。

### ✨ 新增

- **启动钩子扩展点**（`{dataRoot}/.qqbot-extensions/hooks/*.mjs`）。
  前三套扩展都要"有人触发"才跑：`commands/` 等用户敲命令、`tools/` 等 LLM 调用、`botplay/` 等人点卡片；
  但恢复上次没跑完的长期任务、注册监听、起定时器、预取数据这些事**没人触发也得跑**。
  于是加第四套：插件启动（`apply` 链路）时扫描 `hooks/` 并**逐个执行一次**。

  - **模块契约**（三种写法都认）：
    ```js
    export async function run(env) { … }                 // ① 具名导出
    export default { name, run(env), dispose(env) }      // ② 对象默认导出
    export default async (env) => { … }                  // ③ 裸函数默认导出
    ```
    `run` 必需（async 可以）；`dispose` 可选 —— 插件卸载 / 宿主退出 / 保存连接设置后重建网关时调用。
  - **`env`** = `{ ctx, logger, dataRoot, config, registerDispose, pluginVersion, hookFile, caps, store }`：
    `ctx` 是插件 cordis Context；`caps`/`store` 与 tools/commands 是**同一套能力包**
    （`store` 落 `hooks/data/<文件名>.json`）。
  - **健壮性（硬要求，实现见 `src/features/ext-hooks.ts`）**：
    ① 单钩子独立 try/catch —— 抛错**绝不影响插件启动、也不影响其它钩子**，只记警告并继续；
    ② 单钩子 **30s 超时**保护 —— 异步钩子拖不死启动（超时只告警并放行；**不会真的杀掉代码**，
       长任务请用定时器/后台异步）；
    ③ `hooks/` 目录**缺失或为空完全安静**（不报错、不打日志）；
    ④ 每个钩子的名字与结果（成功 / 失败 / 超时 / 跳过）都记账并写日志。
  - **扫描约定**与 `tools/` 一致：只看 `hooks/` 根下的 `*.mjs/.js/.cjs`，**子目录不扫描**；
    cache-bust 用文件 mtime（沿用 `fileVersion` 纪律，别改回时间戳 —— 那会导致 ESM 模块表长跑吃内存）。
  - **示例**：新增 `examples/ext-hooks/`（`hello-hook.mjs` 最小可跑日志型；
    `session-watch-hook.mjs` 演示"注册 `ctx.on` 监听 + 定时器 + dispose 清理"，
    含 run/dispose 竞态的兜底写法）；`seedExampleTools()` 现在**也把示例铺到**
    `{dataRoot}/.qqbot-extensions/hooks/`（同样**只补不覆盖**；因为铺设在跑钩子之前，
    **首次安装当次启动**就能跑到示例钩子）。
  - **清理**：`bootstrapGateway` 的 dispose 链路（插件卸载 / 宿主退出 / 重建网关）会调用钩子登记的
    `registerDispose(fn)` 与导出的 `dispose()`，**逆序执行**、单个清理失败只告警。
  - **文档**：`README.md` / `README_EN.md` 各加「启动钩子」一节；`docs/USER-GUIDE.md` 目录结构补
    `hooks/` 并加契约小节；`docs/botplay-contract.md` 补一句同级的 `tools/`、`hooks/` 归属。
  - **测试**：新增 `src/features/ext-hooks.test.ts`（15 项：目录安静性、三种导出写法、env 契约、
    子目录不扫描、抛错隔离、超时放行、dispose 逆序与容错）。
  - ⚠️ 启动钩子**只在启动时跑一次，没有热重载** —— 改完要重启插件/宿主才生效。

## [1.8.8] - 2026-10-12

> 修「设置页保存了凭据/预设，却**永远不重连**」—— 只有新建实例那一次会连上。

### 🐛 修复

- **保存连接相关设置后不重建网关**（主人 2026-10-12 实测反馈："貌似只有新建机器人实例并保存的时候才有连接"）。
  根因是 `src/index.ts` 里 `tryStartGateway()` 的"只启动一次"守卫：

  ```js
  let gatewayStarted = false;
  const tryStartGateway = async () => { if (gatewayStarted) return; /* … */ };
  ```

  它只覆盖了「首次安装 → 填凭据」这一条路（那时 `gatewayStarted` 还是 false）；
  **已有实例改 appId / appSecret / preset / cwd 时，事件进来了、配置也热更新了，但网关不会被重建**
  ⇒ 只能重启宿主。

  而 `src/config.ts` 顶部原本期望的是另一条路：appId/appSecret **故意不标 volatile**，
  让宿主"配置变化 → 重新挂载插件 → 重建 bot"来重连。但本插件为躲开 2026-09-24 那个
  "写 patch → 宿主热更新 → 再写"的自反馈死循环，早已改成**只写自有存储、不碰宿主配置**
  ⇒ remount 那条路**根本不会触发**。两条路都断了，于是"保存即生效"只剩配置层、没有连接层。

  - `bootstrapGateway()` 新增可选 `hooks.onDisposer`：把「拆卸本次网关」的函数交出去
    （与交给 `im-qqbot.lifecycle` 的是**同一个**，并加了**幂等守卫** —— 两条路都可能触发）。
  - `src/index.ts` 的 `qqbot/settings-changed` 监听改为：先取**连接相关字段快照**
    （`appId` / `appSecret` / `preset` / `cwd` / `disabled` / `settingsNs` / `dataRoot`），
    合并新设置后**若快照变了** → `await gatewayDispose()` 拆旧 → 复位守卫 → 重新 `bootstrapGateway()`。
  - 日志会明说走了哪条路：`连接相关设置已变化 → 重建网关（先拆后建）`，便于排查。
  - 纯展示类设置（行为间隔、出站模式、贴纸开关…）**不触发重建**，避免每保存一次就断线重连。

### 🧪 回归

- `npm run build` + `npm run check:package` 通过；`vitest run` **179 项通过**
  （`classify-accuracy` 依赖本地小模型，环境不具备时不参与）。

## [1.8.7] - 2026-10-12

> 修「设置按 profile 隔离**根本没生效**」，并把**跨会话工具四件套**收进扩展示例。

### 🐛 修复

- **profile 名读不到 ⇒ 永远落 `_default`**：v1.8.4 起设置路径是 `qqbot-settings/<profile>/<ns>.json`，
  但 profile 名取自 `process.env.DSH_PROFILE` —— 而宿主**不会**把这个变量放进自己的环境：
  DSH 是通过 `ctx.get('profileContext').name` 提供 profile 名的，`DSH_PROFILE` 只在**每次 shell / 工具调用**
  时由 harness 临时注入（见 `@deepseek-ai/dsh-shell-env`：`values[DSH_PROFILE_KEY] = profile.name`，
  且该命名空间"每次调用重建、ambient `DSH_*` 会被丢弃"）。于是插件在宿主进程里读**永远是空**
  ⇒ 一直写 `_default/`，"web 与 desktop 各写各的"形同虚设。
  实测证据：`qqbot-settings/_default/<ns>.writer.json` 里记的是 `"profile": "unknown"`，
  连带**写入者指纹（`NS_CONFLICT` 拦截）永久失效** —— 越是需要它拦的场景，它越不工作。
  - `src/index.ts` 与包根 `settings-host.js`（两处**必须同步**，规则写在 `ns-guard.ts` 注释里）
    改用新的 `resolveProfileName()`：① `DSH_PROFILE` 环境变量 → ② **代码位置**
    （包根上溯到 `node_modules` 的父目录 = profile 根）→ ③ 宿主扫描兜底 → 都拿不到才落 `_default`。
  - ② **优先于扫描**是故意的：`~/.dsh/profiles/` 下可能**多个** profile 都装着本插件，
    `scanDshProfiles()` 只返回 readdir 顺序里的第一个，未必是当前这份安装。
  - 目录名要当 profile 名，判据是其**父目录名为 `profiles`** —— 挡住源码 checkout 目录，
    否则开发态会把仓库目录名当成 profile 名、写出一个莫名其妙的设置子目录。

### ✨ 新增

- **扩展示例：跨会话四件套** —— `examples/ext-tools/` 新增 `session_create.mjs` / `session_send.mjs` /
  `session_watch.mjs` / `sessions_list.mjs`（含 `lib/preset_resolve.mjs`、`lib/session_watch_lib.mjs`）。
  演示「让一个会话**开**另一个会话、把消息**投**过去、再把结果**收**回来」，并附三条踩坑经验：
  ① 别手拼消息对象（用 `agent.inject` / `agent.followup`）；② 投递前先 resume（非 live 会话 `append` 会**静默丢弃**）；
  ③ 可见性靠 `expose` 控（`'all'` 全局可见，其他值只在 QQ 会话注册）。

### 🔧 其它

- `seedExampleTools()` 改为**递归**铺设：示例可能带 `lib/` 子目录（**不参与工具扫描**，放那里安全），
  非递归会只搬主文件、给用户留下 import 不到库的残废示例。纪律不变：**只补不存在**、绝不覆盖用户文件。
- 清理仓库里既有的发布红线残留（见开发维护手册 §3）：`ns-guard.test.ts` 里的真实 AppID，
  以及 README / USER-GUIDE / 源码注释中若干人格昵称。

### 🧪 回归

- `vitest run`：**179 项通过**（`classify-accuracy` 依赖本地小模型，环境不具备时会超时，
  不计入本次改动）。
- `npm run build` + `npm run check:package`（单包自含校验）通过。

## [1.8.6] - 2026-10-12

> 扩展命令与扩展工具**能力对齐**：命令侧终于拿得到 sender / agent / kernel；热重载也覆盖扩展命令了。

### 🐛 修复

- **扩展命令的 caps 好值被跳过**（探针实测驱动）：合并能力包时判据是 `if (!(k in handlerArg))`，
  只问"有没有这个键"，而中间件 ctx 里 `sender` / `agent` 这类键**存在但值为 undefined**
  ⇒ caps 里的好值全被跳过。命令 ctx 实测 `hasSender=false` / `hasAgent=false`，而同一个 caps
  在工具侧是好的 —— 这就是"扩展工具能开 MC 双向通道、`/mclink` 却装不上钩子"的根因。
  判据改为「**值为 undefined 才补**」。

### ✨ 新增

- **扩展命令热重载**：`/tools-reload` 与 `tools_reload` 现在把 `.qqbot-extensions/commands` 与
  `tools` 一起重扫，改扩展命令不再需要重启插件。
  - 新增 `src/features/ext-reload.ts`（模块级注册表，解耦 SessionManager 与 gateway 层）；
  - `middleware-setup` 把命令表构建抽成 `rebuildCommandTable()`，首次启动与热重载走**同一条路**；
    `cmdList` / `cmdMap` 保持同一引用只换内容（有对象捕获了 `commands: cmdList`）；
  - `SessionManager.reloadAllChannelTools()` 顺带重载命令，回执多一行「扩展命令: N 个已重载 → /xxx」，
    且放在"有没有活动会话"判断之前 —— 没有会话时命令也能刷。
  - 回归：`src/features/ext-reload.test.ts`（4 项）。
## [1.8.4] - 2026-10-11

> 把"不同 profile 互相覆盖配置"从"拦住"升级成"根本不共用"：**设置文件按 profile 隔离**。

### ✨ 优化

- **设置/凭据按 profile 隔离**：路径从 `{DSH_HOME}/qqbot-settings/<ns>.json` 改为
  `{DSH_HOME}/qqbot-settings/<profile>/<ns>.json`（profile 取 `DSH_PROFILE`，拿不到时落 `_default`）。
  web 与 desktop 从此各写各的，**同一个 settingsNs 也不再互相覆盖** —— 不必再手工给其中一个改 ns。
  - **读**：新路径优先 → 老路径兜底，老配置不丢；
  - **写**：一律写新路径 —— 读取已兜底到老文件，所以**首次保存即"自动搬家"**（老内容 + 本次改动）；
  - 老文件**保留不动**作备份；万一拿不到 profile 名（退化回共用行为），仍由 1.8.3 的写入者指纹兜住、不静默覆盖。
- 配套回归：`ns-guard.test.ts` 增加 4 条路径用例（同 ns 不同 profile 是两份文件、老路径单列用于兜底、缺 profile 落 `_default`、
  ns/profile 非法字符一律替换以防路径逃逸），该文件合计 12 条。
## [1.8.3] - 2026-10-11

> 修一个"看不见但会互相覆盖"的坑：**两个 profile 用同一个 settingsNs**（web + desktop 各挂一个实例）时，
> 两边写的是同一份设置文件 `{DSH_HOME}/qqbot-settings/<ns>.json` —— 谁最后保存谁生效。

### 🐛 修复

- **web 与 desktop 的凭据/配置会互相覆盖**（实测：web 的 appId/preset/cwd 被 desktop 顶替，随后同一 appId
  只保留一条 QQ 连接、后连的顶掉先连的 → 表现成"突然收不到消息"）：`settingsNs` 是**全局唯一**的设置槽名，
  设置文件路径里没有 profile 维度，而插件原先没有任何冲突提示。现在两侧都加防护：
  - **启动自检**（新增 `src/features/ns-guard.ts`，纯只读、不阻断启动）：扫 `profiles/*/cordis.patch.yml`，
    发现同一 ns 还被**别的** profile 挂载（整行 `disabled: true` 的不算）就打出完整告警 —— 谁和谁共用、
    后果是什么（凭据被换 / cwd 一变数据根与群守则跟着变 / 两个 profile 互顶连接）、以及两种修法。
  - **写入者指纹**：设置槽旁记一份 `<ns>.writer.json`（记"这个槽是哪个 profile 在写"）。若该槽已被别的
    profile 写过、而本实例在另一个 profile → 保存直接 **409 NS_CONFLICT** 并附修法，**不再静默覆盖**；
    `GET /api/qqbot-settings/read` 同时返回 `writerProfile` / `nsConflict`，设置页能直接看到。
    确实要让本 profile 接管：删掉 `<ns>.writer.json` 再保存即可。
- 配套回归 `src/features/ns-guard.test.ts`（8 条）：insert 嵌套形态、整行 disabled 不算占用、没写 settingsNs 落默认槽、
  目录不存在不抛错、告警文案必须含判据与修法。
## [1.8.2] - 2026-10-11

> 引用体验补丁 + 一个能直接用的扩展示例。

### 🐛 修复

- **引用一条多行长消息时，AI 只看到首行**（被"只取最外层一句"的清洗顺带剁掉）：
  `slimQuoteText` 原来无条件取 `lines[0]` —— 它本意是砍 QQ 的**嵌套引用链**（`[关联消息] --- 第1条 ---`），
  却把**普通多行正文**一起剁了。更糟的是下游 60 字闸门拿到的是被剁过的短文本，判"未超长"后**静默通过**，
  既不打「已缓存」提示、也没法用 `quote_view` 取回 —— 等于安静地丢信息。
  现在分两种情况：**模板串**仍只取最外层一句；**普通文本整段保留多行**，限长照旧交给 60 字闸门
  （超长即截断 + 缓存 + 提示）。配套补了一条回归用例（多行整段保留 / 空行收敛 / 行内空白压平）。

### ✨ 新增

- **扩展示例 `examples/ext-tools/bing_search.mjs`**（随 v1.8.0 起的新用户"见面礼"自动铺到扩展目录）：
  用 Bing 搜网页，返回 标题 + 链接 + 摘要 + 来源域名。三个可复用的点 —— 查询词卫生（剥掉"是什么"这类长尾巴）、
  相关性自检不过关就回退（加引号 → 只搜最长核心词，并在结果里注明）、结果带域名与同域限流。
  默认 `expose:'all'`（全会话可用），删掉该行即只在 QQ 会话可见；示例 README 同步补了一节说明。
## [1.8.1] - 2026-10-10

> 1.8.0 之后的收尾补丁：把「跨通道」这套写进四份用户文档，补两处说明/诊断，并修掉一个"同一工具注册两份"的浪费。

### 🐛 修复

- **工具改成 `expose:'all'` 后，同一个工具会注册两份**（同一份 schema 两次进上下文 ⇒ 白占 token）：
  热替换只按**新名字**去找旧注册，于是旧的原名（会话级那份）残留在内存里，与新的 `原名__人设ID`（全局那份）并存。
  现在注册循环遇到 `expose:'all'` 会**先回收原名再跳过**；反向场景（去掉 `expose` 后"全局那份"残留）需重启才清，已记入手册。
- **`reply_gate` 的说明补上最关键的一句**：传 `reply:false` 之后看到的 `tool call aborted` **正是「静默成功」本身**
  （本工具就是靠中断输出实现的），不是工具坏了、也不用重试；并明确警告
  **别为了"想安静"去动出站模式**（那会影响后续所有回合）。起因：模型把它误判成故障，改去切换出站模式绕远路。

### ✨ 优化

- **`sendText` 增加被动窗口诊断**：发送前记一条 `send window=Y/N + rec=Y/N`（含 sessionKey），
  用于定位"这一次为什么走了主动通道"。实测：冷群没有被动窗口 ⇒ 必然走主动，符合设计预期。

### 📄 文档（四份全同步）

- `README.md` / `README_EN.md` / `docs/USER-GUIDE.md` / `examples/ext-tools/README.md`
  新增「扩展工具跨通道（`expose:'all'`）」：开关用法、注册名带人设 id、
  ⚠️ **工具名只允许 `[a-zA-Z0-9_-]`**（`@` 会让 LLM API 整轮拒绝）、`env.qq` 账号包字段、
  「被动优先 → 主动兜底」、**被动窗口只在有活跃消息的会话成立**、启动**自动铺示例**（只补不覆盖）；
- 维护手册新增 **§4.6 扩展工具与跨通道**（含"工具没出现"的六步排查顺序）；
- 维护手册 **§1 新铁律第 9 条**：凡"报错/中止属于**有意设计**"的工具，必须在 description 里写明"看到 X 就是成功"。


## [1.8.0] - 2026-10-10

> **扩展工具跨通道**：声明 `expose: 'all'` 的工具会对**所有会话**（含 web / 终端等非 QQ 通道）可见，
> 注册名自动带**人设 id**（`qq_send__whale-girl`）标明归属；执行时注入 `env.qq`（账号包），
> 非 QQ 会话也能把消息发进指定的群 / 私聊。另：新用户装上即得可跑的示例，不用手动搬。

### ✨ 扩展工具"暴露给全部会话"

- **声明式**：工具文件里写 `export default { name: 'xxx', expose: 'all', … }` 即全通道可见；
  **不写就完全维持原状**（只在 QQ 会话有上下文）—— 向后兼容，现有工具一个都不用改。
- **注册名带归属**：`<name>__<人设id>`（例：`qq_send__whale-girl`），多实例/多人设时一眼分清是谁家的。
  ⚠️ 分隔符**只能用 `[a-zA-Z0-9_-]`** —— `@` 之类会被 LLM API 拒（`Invalid 'tools[N].name'`）；
  现在**注册前会校验，非法名一律不注册并留痕**，不会再让一个坏名字把每轮请求带崩。
- **`env.qq` 账号包**（只注入给 `expose:'all'` 的工具）：
  `preset / appId / appSecret / owners / groups[] / c2c[] / sender / sendText·sendMarkdown·sendImage / apiCall`
  —— 非 QQ 会话据此"隔通道指挥 QQ"。
- **发送"被动优先"**：`env.qq.sendText()` 先查**目标会话最近的 msgId**、带上它发（被动回复，不吃主动配额、
  QQ 也不吞）；失败（msg_id 过期／被动配额用尽／没有窗口）自动**去掉 msgId 重发**（主动兜底）。
- **启动即注册**：不再依赖"收到 QQ 消息才注册"（QQ 不活跃也照样就绪）—— 启动后立即注册 + 短重试。

### ✨ 新用户"见面礼"：自动铺扩展示例

- 插件启动时把本包自带的示例铺到数据跟下：
  · `examples/ext-tools/*.mjs` → `{dataRoot}/.qqbot-extensions/tools/`
  · `examples/botplay/*.mjs` → `{dataRoot}/.qqbot-extensions/botplay/`
  工作目录里生成 `dshqqbot/` 之后**不用自己搬**，装上就有能跑的工具与卡片示例。
  **只补不覆盖**（同名文件一律不动 ⇒ 也就不会重复搬）、失败静默、绝不影响启动。
- 仓库示例里的 **`qq_send.mjs`** 是"**查对象 ＋ 发单条 ＋ 连发多条**"三合一
  （原 `send_texts.mjs` 已并入它，不再单列）：
  · `action:"list"` 查已知群/私聊；`action:"send"` 发消息，目标可用 openid，也可用**群名/昵称**；
  · 连发给 `texts:[…]` 或 `text`+`count`，默认每条间隔 600ms 防 QQ 吞消息；
  · ⛔ 按名字命中多个**绝不猜**，只回候选清单；✅ 返回据实（成功/失败条数都报）。

### 🐛 修复 / 优化

- **工具名合法性闸门**：注册前校验 `^[a-zA-Z0-9_-]+，非法名一律不注册。
- **剪枝覆盖非 QQ 会话**：`context_memo/compact/drop` 与 `qq_group_admin` 在非 QQ 通道的会话里
  **完全不出现**（零 token 占位）；QQ 会话仍按「无上下文模式」开关决定可见性。
- **日志纪律**：新增诊断一律走统一底座（受设置页 ⑤「诊断日志落盘」控制、默认关、2MB 自动轮转），
  **不再有"无条件写自有文件"的日志**。


## [1.7.10] - 2026-10-10

> 设置页一次"治本"的重做：**配置即数据**（一份 Schema 驱动 渲染/默认值/提交）＋ **只提交 diff**，
> 顺手修掉一个从上线起就存在的"能选不能存"bug；搜索拆成 **上=精确 / 下=模糊(语义)**。

### 🔧 修复

- **🔴 ⑥「提问卡片」的等待方式其实一直存不下去**：`questionsMode` 从引入起**没进过 `/update` 的 patch**
  （旧 `doSave()` 手写全量字段清单，漏抄了它）—— 面板上能选"后台提问／阻塞等待"，一保存就没了。
  本次 schema 化后自动修好。

### ✨ 设置页：配置即数据 ＋ 只提交 diff

- **一份 `FGROUPS` 定义驱动三件事**：渲染（`renderControl` / `FieldRow`）、默认值回落（`fieldVal`）、
  提交（`buildPatch`）。旧版同一个字段要在**三处**手写（读时 normalize、存时全量 patch、渲染），
  漏一处就是「勾了却存不下去」—— 本文件历史注释里反复出现的就是这个病。
  - 字段键：`k`(点分路径，须与主包 `config.ts` 键名一致) / `t`(bool·num·str·area·radio·list·note·custom) /
    `label`·`hint` / `def`(只在渲染时回落、**不写进 cfg** ⇒ diff 才是真实改动) / `kw`(语义搜索关键词) /
    `sec`(单位换算) / `options` / `render(ctx)`。
- **保存只提交"变化了的顶层 key"**：没碰过的字段（含本页不编辑的 `schedule` 等）一个字节都不动；
  host 端 `mergeDeepOne()` 是深合并，只发一部分是安全的。（旧版全量提交 ⇒ 漏抄的字段会被顶掉。）
- **草稿态可见**：顶部常驻「✓ 已同步 / ● 有未保存改动(n)」＋保存按钮带待提交项数；
  无改动时点保存会**明确回一句**（旧版按钮 `disabled`、点了毫无反应，反馈文字还藏在页面最底部）。

### 🔍 搜索：上=精确，下=模糊（语义）

- **精确**（上栏）：字面命中 名称／说明／键名。
- **模糊·语义**（下栏）：**纯程序、零依赖、离线即时、零 token** —— 字符 bigram ＋ IDF 加权余弦，
  文档 = `label×2 + kw×2 + hint + 键名`；命中字段按相似度排序、行尾显示「N% 匹配」。
  实测样例：`回复太慢`→回复间隔、`图刷屏`→表情包限制、`踢人`→群管理、`排查日志`→诊断日志、
  `进群申请`→入群申请提醒、`私聊回复`→私聊间隔。

### 🎨 其它界面整理

- 分区序号拉直为 **①~⑨**（去掉历史增补的 ⓪ 与 ③.5）；
- 每个分区变成可折叠卡片，顶部一排导航 chip（点击平滑滚到对应分区）；
- 长说明默认折成一行「ⓘ 说明(点开)」，分组介绍超长也折成一行 ＋ 展开。

### 📄 文档

- 维护手册新增 **§4.5 UI 维护**（三块 UI 在哪 / `FGROUPS` 契约 / 为什么只提交 diff / 搜索算法 / 改 UI 纪律）；
- §1 铁律 8 补 2026-10-10 细化：动态挂载改「**注册不动 ＋ 按会话实时剪枝**」
  （必须用插件根 `ctx.get('tools')` 注册；用 `agentCtx` 注册会让 `restrict` 剪空）。

## [1.7.9] - 2026-10-09

> 一次"该稳的别抖"的收尾：三个上下文工具改成 **注册一次 ＋ 按会话剪枝可见性**，
> 并让同一回合里的重复插话提示 **逐次缩短**（省 token）。

### 🔧 修复 / 优化

- **🔴 「无上下文模式」明明开着，AI 却以为没开（回合第一轮那三个工具被误卸）**：
  旧实现里 `ctxSmartOn` 初值 `false`，且只在 `findByAgent()` 反查成功时才被赋值，
  可后面**无条件**拿它去挂/卸工具 —— 回合 **第一个 step** 反查落空（agent↔record 映射尚未登记、
  或换了 agent 实例）就被判成"该会话不该有" ⇒ `context_memo/compact/drop` **被卸掉** ⇒
  那一轮 AI 既调不到压缩，还会从"工具不在"反推出"这个会话没开无上下文模式"；后面 step 反查成功又挂回来 = 抖动。
  现加两道兜底：**反查兜底**（`findByAgent` 落空就用同一次 pre-step 里 `findBySessionId` 拿到的 key）
  ＋ **未知不动**（真拿不到会话 key 就保持现状 —— 绝不因为"读不到"而卸工具）。
- **三个上下文工具改为「全局注册一次 ＋ per-scope 裁剪可见性」，不再每步动工具表**：
  旧做法在 pre-step 里"先注销、再重新注册"，于是**每一步都动一次工具表** → 宿主每步都发
  「工具已更新 · 移除/新增」（还进上下文，纯烧 token），多会话并存时更是"你挂我卸"来回抖。
  现拆成两半：① `ensureContextToolsGlobal()` —— 用 **插件根 ctx** 全局注册那三个工具（永不注销、幂等）；
  ② `restrictContextTools()` —— 每个会话只声明"我要不要看得到它"，`ctx.tools.restrict({deny})` 是
  **per-scope** 的（只作用于调用方那一个 agent 作用域）；状态没变就一根手指都不动（不产生任何变更通知）。
  ⇒ 没开「无上下文模式 ＋ 智能判断」的会话 **连工具名都看不到**（零 token），开了的会话正常继承；
  面板一改开关 → 下一次 pre-step（下一回合 / 下一步）即生效。
  ⚠️ 两个坑（均实测踩到，改代码前先读注释）：① 注册必须用 **插件根 ctx** 的 `ctx.get('tools')`
  —— apply 的 inject 列表里没有 `tools`，直接读 `ctx.tools` 会被宿主拒；
  而改用 `agentCtx` 注册 = 变成"该作用域自己注册的工具"，`restrict` 按文档**只过滤继承来的**，
  剪枝会永远打空（trace 原话：`restrict 失败: names unknown global tools "context_memo",...`）。
  ② 幂等句柄存 `globalThis`（跨热刷新仍有效），不存模块级变量。
- **同一回合里第二次以后的"插话提示"逐次缩短**（省 token）：
  上一版每条插话都重复同一句完整提示，同回合插 3 次就白烧 3 遍 —— 而"这是什么 ＋ 先做完当前任务"
  的语义第一句就立住了。现在分三档：第一次完整、第二次只提醒"又插进来了"、第三次及以后只留
  「[插话] 又有新消息」；计数写在会话记录上（`interjectSeq`，**注入成功才 +1**），回合结束（`turn/end`）清零。

### 📄 文档

- 开发维护手册 §1 铁律 8 由"动态挂载能力一律幂等刷新"细化为"**注册不动 ＋ 按会话实时剪枝**"。

## [1.7.8] - 2026-10-09

> 两个真 bug 的修复（一个会让**宿主整个退出**，一个会让**某个会话彻底发不出消息**）
> ＋ 一次社区贡献合并 ＋ 仓库迁移后的链接更新。

### 🐛 修复

- **🔴 群里点一下审批卡片，整个 dsh 进程退出**
  （症状：点「允许」后终端报 `[dsh-auto-memory] unhandledRejection guard #1` → `process exit code=1`）：
  `qq-approval` 的结算回执写成 `void this.sender.sendMarkdown(...)` 配**同步** `try/catch` ——
  同步 try **抓不到 Promise 的拒绝**。而这条回执属于"主动消息"，QQ 常回
  `主动消息失败，无权限`（超出互动窗口 / 未开通主动推送），于是 rejection 无人接管，
  被宿主的 unhandledRejection 守卫判为致命 ⇒ 直接退出进程。
  现给 Promise 挂 `.catch`（发不出去只记一行 warn）。已全项目扫过其余"发射即忘"的发送调用，仅此一处漏网。
- **🔴 崩溃重启后"那个会话再也发不出消息"（要新开会话才恢复）**：
  `passive` 模式下所有出站都带"被动回复 ID"（msgId）；msgId 一旦失效
  （过期 / 被动回复配额用尽 / 崩溃重启残留的陈旧 id），原实现**直接抛错** ⇒
  出站链路只记一行日志 ⇒ 消息静默丢失 ⇒ 整个会话像哑了。
  现在会自动**去掉 msgId 转主动重发一次**；顺带把**所有出站失败落盘**到
  `~/.dsh/qqbot-send-diag.log`，以后遇到这类问题可以直接查日志、不用猜。
- **扩展工具点按钮后"通知 AI"其实没送到**（回执却宣称已通知）：
  `bootstrap` 为交互链路组装 caps 时**漏传 `agent`**（`caps.appendWake` 依赖 `agent.followup`）
  ⇒ 静默 `return false`。现补 `manager.findByPeer(scope, peerId)?.agent`；
  `examples/ext-tools/vote.mjs` 的回执也改为**据实**（失败就明说"通知 AI 没成功"）。

### 🧩 社区贡献

- 合并 **@fqscfqj** 的 #9：`settings-host.js` 的 `dedupeYamlKeys()` 改为**按映射作用域**判重。
  原实现按 `(条目 id, 缩进长度, 键名)` 判重，而"同一缩进"**不等于**"同一个映射"——
  两个并列子映射只要共用键名（权限预设的 `sandbox`/`approval`、cline-pass 的 `perModel`），
  前一个的键就会被整段删掉；删完 YAML 仍合法、dsh 照常启动，但那行配置在宿主各插件自己的
  schema 校验里失败、**被静默跳过**（权限预设不注册、面板 404），触发点是"设置页保存一次账号"。
  现按父键路径判重（与 YAML 自身 `duplicated mapping key` 语义一致），并附 159 行回归测试。感谢！

### 🔧 其它

- **仓库迁移**：用户名与仓库地址变更后，所有内置链接（`package.json` / `README` / `README_EN`）
  已更新为新地址；旧地址由 GitHub 自动重定向一段时间。

## [1.7.7] - 2026-10-08

> 1.7.6 的一个「假成功」修补：扩展工具按钮点下去之后，**通知 AI 其实没送达**。

### 🐛 修复

- **扩展工具 `onInteraction` 里的 `appendWake` 静默失效**
  （症状：点投票卡片的「✋ 结束投票」后，回执写着"已通知 AI"，但 AI 的上下文里什么都没有）：
  `bootstrap` 为交互链路组装 caps 时**漏传 `agent`**，而 `caps.appendWake` 依赖
  `agent.followup` 才能唤醒 ⇒ 直接 `return false`，又被 fail-soft 吞掉。
  现补 `agent: manager.findByPeer(scope, peerId)?.agent`（与扩展工具 `run()` 那条链路对齐）。
- **回执不再"嘴硬"**：`examples/ext-tools/vote.mjs` 的 `finish()` 现在返回 `woke` 标志，
  通知失败时回执明说「⚠️ 但通知 AI 没成功，可以让她用 status 自查」，不再一律宣称"已通知"。
- **🔴 点审批卡片会让宿主进程整个退出**（症状：群里点一下「允许」，终端报
  `[dsh-auto-memory] unhandledRejection guard #1` → `[dsh-auto-memory] process exit code=1`，dsh 重启）：
  `qq-approval` 的结算回执写成了 `void this.sender.sendMarkdown(...)` 配**同步** `try/catch` ——
  同步 try **抓不到 Promise 的拒绝**。而这条审批回执属于"主动消息"，QQ 常回
  `主动消息失败，无权限`（超出互动窗口 / 未开通主动推送），于是 rejection 无人接管，
  被宿主的 unhandledRejection 守卫判为致命 → 直接退出进程。
  现改为给 Promise 挂 `.catch`（发不出去只记一行 warn，绝不影响裁决）。
  已全项目扫描其余"发射即忘"的发送调用（outbound 的 passive 收尾、channel-tools 的后台大文件、
  提问卡片的抢答提示）—— 它们本来就带了 rejection 处理，只有这一处漏网。

### 📌 教训

**fail-soft 的布尔返回值必须被 caller 检查、并反映到用户可见的文案里。**
否则"失败被吞掉 + 文案宣称成功" = 假成功，比直接报错更难查 —— 本次就是主人从群里的回执一眼看出来的。

## [1.7.6] - 2026-10-08

> 一个能力补齐（**扩展工具也能收按钮回调**）+ 两个"关不干净 / 只改一半"的老 bug，
> 外加一个能直接跑的**群投票示例工具**。

### ✨ 新功能

- **扩展工具也能收「按钮回调」了**（`ext:` 前缀 + 卡片注册表）：
  以前扩展工具发的 `type=1` 按钮**点了没人认**（事件落回兜底，也拿不到点击者身份）。
  现在三步即可：① 发卡前 `env.registerInteractionCard({ cardId, buttonIds, expireAt })` 登记；
  ② 按钮 `data` 写 `ext:<工具名>:<卡id>:<按钮id>`（`action.type=1`）；
  ③ 模块导出 `onInteraction(ctx, info)` —— 点击者身份在 `ctx.performer = { openid, isOwner }`，
  返回非空字符串即作为回执发给点击者。注册表落 `{dataRoot}/.qqbot/ext-tool-cards.json`
  （原子写、过期自动清、**写失败不影响发卡**）。
  新增 `src/features/ext-tool-cards.ts` 与 `src/features/ext-tool-interaction.ts`；
  `ExtCapabilities` 增 `registerInteractionCard`；交互分发串在 botplay 与裸卡兜底之间插入一条。
- **示例工具 `examples/ext-tools/vote.mjs`（群投票，随包分发）**：
  可多选（同一按钮每人限一次）、中途加选项（补发新卡、旧卡仍可用）、多投票并存（V1/V2…）、
  卡片最后一行自带「✋ 结束投票」按钮、结束结算（群里公示 + 唤醒通知 AI）、`minutes` 定时结束、
  `action=status` 查票数；中途回执只回一行，完整票数只在结束时给。

### 🐛 修复

- **审批白名单只生效一半**（症状：主人点卡片 / 发 `/approve` 都被回"你无权处理这项权限申请"）：
  `groupAdmin.owners` 此前只进了"发卡时的可点名单"，而两处真正裁决（按钮回调、`/approve`）
  仍只认"发起者本人" ⇒ 界面上点得动、服务端拒绝。现统一走
  `allowedDeciders() = 发起者 ∪ owners`，并各加一行 warn 诊断日志（presser/sender 尾号 + 名单）。
- **三个上下文工具"没开也有"**：`channel-tools` 的 apply 里曾写死 `syncContextTools(ctx, true)`，
  把 `context_compact / context_drop / context_memo` **无条件注册进插件作用域**，
  而真正按会话开关裁决的 pre-step 作用在 **agent 作用域** ⇒ "关则注销"够不到 ⇒ 未开启的会话也能调用。
  现改为 `false`（完全交给 pre-step 按会话裁决）。
- **指令型按钮拿不到点击者**：`runButtonCommand()` 的 `senderId` 原为**写死空串**，
  签到/按人统计这类场景做不了；现补点击者 openid（`CardCommandExecutor` 加可选第三参，card-callback 内透传）。

### ✅ 验证

- `tsc` 零错误 + `check-package` 通过；
- 线上实测：审批卡片按钮与 `/approve` 可放行、未开无上下文模式的会话不再出现那三个工具、
  投票示例"发卡 → 点击（多选）→ 结束按钮结算 → AI 收到播报"全链路跑通。

## [1.7.5] - 2026-10-07

> 两个"让聊天更顺"的改动：**忙时消息可选插话**（不再一律排队等她回完）、
> **提问卡片默认后台化**（她问完能接着聊，答案自动送回来）；另把两处啰嗦的系统提示砍到一行。

### ✨ 新功能

- **忙时消息「排队 / 插话」可设置**（`behavior.debounce.busySendMode`，默认 `queue` = 保持原行为）：
  她正在思考/输出时群友发来的消息，照旧先按静默秒数/条数聚合，但不再只能"攒着等这轮回合结束" ——
  切到「插话发送」后，聚合好的这批会用宿主 `send(msg,'next-step',wakeup:false)` 通道
  **插进当前回合的下一个轮次边界**（不唤醒、不拆 tool_calls），她本轮的下一次推理就读得到。
  设置页：「QQ 机器人 → ① 多久回一次消息 → 延迟聚合」。
  每次插话带一句极短提示（`[插话] …先做完当前任务, 再按需回应。`）防止她被带偏、改掉手里的活；
  注入能力缺失/抛错时自动回落原排队逻辑，消息不丢。
- **提问卡片默认「后台提问」**（`questionsMode`，默认 `async`，可切回 `blocking` = 旧行为）：
  以前 `ask_user_question` 会把她**整条回合挂住**等对方作答；现在卡片一发出就返回，
  **她能继续和群友聊天/干活**，对方答完后答案变成一条
  `[提问卡片·回执] 「问题」→ 答案` 送回会话 —— 她正忙就插进当前回合，闲着就被唤醒处理；
  超时/取消也会回一条"超时未答"，答案不会静默消失。
- 设置页新增「⑥ 提问卡片(她问人时要不要在旁边干等)」radio。

### ⚡ 优化

- **系统提示瘦身**：插话提示 110+ 字 → 一行；排队模式的聚合提示 140+ 字 → 一行
  （这两句每次都要进上下文，纯省 token）。
- **仓库清理**：移出 111 个本地备份（`*.bak-*`，约 11.1 MB）、删除 `.vs/` 缓存与两个误入库的旧 tarball；
  `.gitignore` 补 `*.tgz` 规则。

### ✅ 验证

- `tsc` 零错误 + `check-package` 通过；
- 线上实测：后台提问全链路跑通（占位返回 → 自由回答 → 回执送达 → 空闲唤醒）；
  插话模式实测能在同一回合的轮次之间读到群友新消息。

## [1.7.4] - 2026-10-06

### 🐛 修复

- **新建会话挂不上工作区（attach 竞态）**：宿主的 `attachSession` **不信任调用方传的 cwd** ——
  它自己去读**磁盘上的会话头**校验（`dsh-workspace/lib/index.js:111-129`：活会话 → 缓存 → 扫存储），
  取不到就抛 `cannot validate session '…': session persistence holds no such session`。
  而插件是在 `agents.create()` 之后**立刻**调用的 ⇒ 那一刻会话头**还没落盘** ⇒ 抛错被 catch 吞掉
  ⇒ 会话不在任何工作区 ⇒ 侧边栏落「**未分组**」，要等下次被消息触发（resume 路径）才补挂上。
  - **实测证据**：同一段代码**有的挂上、有的没挂** —— 466 个会话里 `67bec37c` 挂了、
    `3baae867` / `5f4ad7c2` / `920d0e2c` 没挂。
  - **修法**：改为**退避重试**（`0 / 300 / 900 / 2000 / 5000 ms`，成功即停，全程 fail-soft）；
    最终失败留一行 warn + 一条诊断（开 `diagLog` 后可在 `qqbot-archive.log` 看到 `attach-failed`）。
    headless 没 registry 时直接跳过，不空跑五轮。

> 本版同时包含 **1.7.3**（诊断日志收口）与 **1.7.2**（打包白名单修复 + botplay 示例）的全部内容。
## [1.7.3] - 2026-10-06

> **还债版**：把散落各处的诊断日志收成一个底座 —— 以前它们**没有上限**，
> 实测一份 `contextless-trace.log` 涨到了 **24 MB**。

### 🐛 修复

- **诊断日志零上限**（严重）：`features/contextless-store.ts` 的 `traceContextless()`
  **完全没有上限**，而且同一条内容会往**三个地方**各写一份（`~/.dsh/`、系统 temp、数据根），
  并且**每行都往终端 `console.error`** 刷屏；另有 `channel-tools.ts` 里**两处代码写同一个文件**。
  实测系统 temp 里那份已涨到 **24 MB**。
- **新增统一底座 `src/shared/diag.ts`**，全插件诊断日志**只走它**：
  1. **默认关** —— 关着时**零 I/O**（用户机器上不产垃圾）
  2. **单文件上限 2 MB + 自动轮转**（`xxx.log` → `xxx.log.1`，只留 1 份旧档）
  3. **只写一个位置**：`{DSH_HOME|~/.dsh}/<名字>.log`（不再往 temp/数据根各撒一份）
  4. 写失败静默吞掉，**绝不影响主链**
- **7 处诊断写入全部收口**：`contextless-trace`（两处重复 → 合一）、`qqbot-ext-diag`、
  `botplay-diag`、`qq-approval-diag`、`qqbot-archive`；各自散装的上限/路径逻辑一并删除
  （比如 `extDiag` 自己那套"超 2MB 截断留尾部 512KB"）。

### ✨ 新功能

- **配置项 `diagLog`（默认关）+ 设置面板开关**：
  「QQ 机器人 → 设置 → **③.5 诊断日志(排查用)**」一个勾选框 ——
  开=把排查用的诊断日志写进 `{DSH_HOME|~/.dsh}/*.log`；平时关着（会持续占盘）。
  也可用环境变量 `DSH_QQBOT_DIAG=1` 临时打开（不想改配置时用）。

### ✅ 验证

- `tsc` 零错误 + `check-package` 通过；
- **diag 底座冒烟测试 7/7**：默认关零 I/O / 开启才写 / 超上限自动轮转 / 只留 1 份旧档 /
  `diagClean` 可清；
- 已清理历史垃圾约 **24 MB**。
## [1.7.2] - 2026-10-06

> 补齐 1.7.1 的**两处打包缺陷**，再给写扩展的人配一个**能直接跑的示例**。

### ✨ 新功能

- **自带 botplay 示例模块**：`examples/botplay/checkin-stats.mjs`（+ `README.md`）——
  复制到 `{数据根}/.qqbot-extensions/botplay/` 就能跑。它演示四个最容易踩的坑：
  1. ★ **按钮级权限只能自己在 `onClick` 里判** —— 事件 `perm` 是**整张卡片**一个，
     做不到"按钮 1 谁都能点、按钮 2 只有主人能点"
  2. **别动不动重发整张卡**（刷屏 + 撞 QQ 发卡限频）；只有真要刷新按钮状态才 `card().dirty = true`
  3. **状态要按 `ctx.cardId` 分轮存** —— 同一个模块实例被多张卡片共享，不按轮存会串名单
  4. **`ctx.appendWake` 要用在刀刃上**（烧 token），只在真正出结果的那一刻调
  已随包分发（见 `files`）。

### 🐛 修复

- **`docs/host-services.md` 没被打进 npm 包**（严重）：`package.json` 的 `files` 是 npm 的**白名单**，
  漏列 ⇒ **1.7.1 的 npm 包里其实没有这份《宿主服务清单》**；而《用户手册》里又引用了它
  ⇒ 装包用户会点到**死链**。现已把 `docs/host-services.md` 与 `examples` 一并补入 `files`。
- **`docs/botplay-contract.md` 尾部混进了 4 行 HTTP 响应头**
  （`content-type` / `content-length` / `cache-controlno-store` / `accept-rangesbytes`）——
  每次点面板「🤖 让 AI 写」都会把它拼进提示词发给 AI。已删。

### 📖 文档

- botplay 契约文本新增：指向 `examples/botplay/` 的说明 + 上面那三个坑的提醒。

### ✅ 验证

- `tsc` 零错误 + `check-package` 通过；
- **`npm pack --dry-run` 复核**：`docs/host-services.md`（5.0 kB）与 `examples/botplay/*`
  两个文件**均已在包内**（共 457 files）。

## [1.7.1] - 2026-10-06

> 1.7.0 把三套扩展的**成品能力**拉平了；这一版补上**"遥控器"**和一把**说明书**。

### ✨ 新功能

- **`kernel`（内核句柄 = 插件自己的 cordis `ctx`）三套齐**：
  - 扩展工具 `tools/` → `env.ctx`（本来就有）
  - **自定义命令 `commands/` → `env.ctx`（新增）**
  - **botplay 卡片 `botplay/` → `ctx.kernel`（新增）**
    —— 命名区别的原因：卡片那个对象自己就叫 `ctx`，所以遥控器放 `ctx.kernel` 上（避免 `ctx.ctx`）。

  拿到它就能做**成品能力做不到的事**：`ctx.get('sessions')` 读/建会话、`ctx.tools.register()`
  给 AI 加工具、`ctx.webServer.register()` 开 HTTP 路由、`ctx.on('session/event')` 订阅宿主事件、
  `ctx.compaction.compactNow()` 压缩上下文……

- **`env.restart()` —— 宿主自重启**：直接**复用内置 `/bot-restart` 的实现**（`selfRestart()`），
  它已经填平了所有坑：自动识别启动命令、**强制补 `--no-open`**（不然每次重启都弹浏览器）、
  重启助手写系统 tmpdir（避开中文路径）、detached+unref（宿主被杀照样能拉起）。
  - **默认仅主人可触发**（`requireOwner: true`）—— 防止 AI 被群友一句话钓去重启机器人；
  - **要放开一行就行**：`env.restart({ requireOwner: false })`（你的机器你做主）；
  - 每次触发都**留痕**（谁触发的、是不是主人），出问题能查。

### 📖 文档

- **新增 [`docs/host-services.md`](./docs/host-services.md)：宿主服务清单** ——
  **59 个真实服务名**（从 dsh 源码里 harvest 的 `ctx.get("…")`，不是猜的），
  按用途分类 + 上手例子 + 「成品能力 vs 遥控器」的选择建议。
  ⇒ 光给遥控器不给说明书等于没给，这是这一版的重点之一。
- 《用户手册》能力表补 `kernel` / `restart` 两行 + 指向服务清单。

### ✅ 验证

- `tsc` 零错误 + 包自检通过；
- **能力包冒烟测试 50/50 通过**（新增 kernel 透传、restart 的**主人放行 / 群友拒绝 /
  拒绝时不调用实现 / `requireOwner:false` 放开 / 无身份拒绝**）。
  ⚠️ `restart` 的"放行"分支用**注入接缝**验证 —— 真跑它会 spawn 助手去 kill 宿主进程，
  测试里绝不能真调。

## [1.7.0] - 2026-10-06

> 这一版是**给写扩展的人用的**：把「三套用户扩展」的能力面拉平，
> 以后别人给你的鲸鱼写扩展，不用再自己接生。

### ✨ 新功能

- **统一扩展能力包 `env`（`src/features/ext-capabilities.ts`）**：
  `commands/`（自定义斜杠命令）、`tools/`（自定义 QQ 工具）、`botplay/`（卡片事件模块）
  **三套扩展现在拿到同一套成品能力**（此前严重不均：卡片是精装版，工具只有裸 sender，
  命令只有一个消息 ctx —— 以至于为发一张 markdown 就得专门写个工具）。
  平铺在 `env` 上（也在 `env.caps` 命名空间里）：

  | 能力 | 用法 |
  |---|---|
  | 发文本 / markdown / 带按钮 markdown | `env.text()` / `env.markdown()` / `env.markdownCard(md, kb)` |
  | 发图 / 语音 / 视频 / 文件 / 任意媒体 | `env.image(src)` / `env.voice()` / `env.video()` / `env.file()` / `env.media(kind, src)` |
  | @人 | `env.at(openid)` |
  | **官方 API 调用** | `env.api(path, {method, body})` —— ★ **自带 token 与 2h 缓存，不依赖 `groupAdmin` 开关** |
  | **钥匙** | `env.appId` / `env.appSecret`（想自己换 token 调任意接口时用） |
  | **持久化** | `env.store.load()` / `env.store.save(obj)` —— 落 `{数据根}/.qqbot-extensions/{tools\|commands}/data/`，**升级插件不丢** |
  | 进上下文 | `env.appendSilent(text)` / `env.appendWake(text)` |
  | 身份 | `env.user.openid/name/isOwner`、`env.owners`、`env.peer` |
  | 日志 | `env.log(...)` |

- **botplay 卡片 ctx 补齐**：`text` / `media` / `voice` / `video` / `file` / `markdownCard`
  （此前只有 `emit`/`markdown`/`image`）—— 三套扩展的发送能力从此一致。

### 🛡️ 安全

- **`appendSilent` 内置表面守卫**：全新会话（还没跑过任何回合、人设尚未落盘）里静默追加
  会**写废整份会话日志**（见 1.6.9 的事故）。所以这条能力**不安全时直接返回 `false`、绝不写入**；
  想往这种会话里送内容请用 `appendWake`（走正常回合，dsh 会先补人设，天然安全）。
- **全部能力优雅降级**：拿不到依赖时返回 `false` / 结构化错误，**绝不抛错**打断用户的扩展。

### ✅ 验证

- `tsc` 零错误 + 包自检通过。
- **能力包冒烟测试 40/40 通过**（发送路由 / @人 / 持久化落盘回读 / API 注入与无凭证报错 /
  上下文守卫（新会话必拒、老会话放行）/ 全量优雅降级）。

### 📖 文档

- 《用户手册》新增「★ 统一能力包（v1.7.0+）」小节（含能力表与 `appendSilent` 安全红线）。

## [1.6.9] - 2026-10-06

> **修一个会「写废整份会话日志」的事故** —— 静默入库（不唤醒 AI 的那几条路径）
> 遇到**全新会话**时，会把 `user/message` 写成 surface 的第一个节点，人设从此再也补不进去。

### 🐛 修复

- **静默 append 会写废新会话的日志**（严重；实测已废掉 13 个会话，且当天仍在新增）：
  dsh 的 v4 会话格式要求 `system/message`（人设）**必须是 surface 的第一个节点**
  —— 只有"追加时 surface 还空着"的那一次才会被记为 `protectedHead`。
  而本插件的「静默入库」路径**不唤醒 AI** ⇒ 会话里还没有任何回合 ⇒ 人设还没落。
  此时把 `user/message` 追加进去，它就占了头把交椅；**之后**这条会话第一次被真正唤醒、
  dsh 补写人设时当场抛 `system/message requires a protected first surface head`
  ⇒ **整份日志报废**（用户看到「历史加载失败 / stored log is corrupt」），
  而且该会话连**工作区也挂不上**（读不出 Header）⇒ 侧边栏落「未分组」。
  - **新增 `src/session/surface-guard.ts`**：`canSilentlyAppend(session)` ——
    **只有当 surface 的第一个节点是 `system/message` 时才允许静默 append**。
    两条判据：① `session.surface.nodes`（最权威）② 回落扫 `session.log` 找第一个 surface 类型事件。
    **fail-closed**：拿不准就不写。
  - **接入全部静默入口**：价值评分拦截（`transport/inbound.ts`）、`nothink`（同文件）、
    群事件汇总（`features/group-hub.ts`）、卡片 `append_silent`（`features/botplay.ts`）、
    `/inject`（`commands/inject.ts`）、`/outmode`（`commands/outmode.ts`）。
  - **跳过时内容不丢**：下次真人消息唤醒时由 `[历史]` 段带入正文；
    `group-hub` 则自动落到宿主 `agent.inject()`（回合内安全排队、不唤醒）。
  - **验证**：拿 466 个真实会话日志回放守卫 —— **13/13 已废档全部拦住、0 漏放**；
    被拦的都是「人设尚未落盘」的会话（含从未跑过回合的新档）。
  - 存量的 13 个已废会话**不修**（主人 2026-10-06 定），只堵源头。

## [1.6.8] - 2026-10-05

> 这一版是 **Web 侧边栏的「会话自动重排」**：QQ 里一有动静，对应会话自己爬到最上面 ——
> 冷掉的会话被它越过，置顶的永不动。顺带修掉两个"哑巴"故障，和一个卡了很久的隐蔽 bug。

### ✨ 新功能

- **Web 会话列表自动重排**（宿主端 + 浏览器端）：
  - 判据：QQ 消息入站到某个 web 会话、且 AI **真的产出了**（宿主 `session/event` 的 `assistant/message`）。
  - 规则：从列表头往下数 n 个仍「**热**」的会话（对话间隔 < **10 分钟**），把目标插到第 n+1 位；
    第 1 个就冷掉（n=0）⇒ 直接插第 1 位。**置顶一律算热、位置绝不动。** n 自动扫描得出，无需配置。
  - ★ **事件驱动，不轮询**：宿主订阅会话事件、命中才推一条 SSE
    （`/api/qqbot-settings/workspace/watch`）；没开页面 ⇒ 服务端零开销；
    宿主没完全起来 ⇒ 连不上 SSE ⇒ **天然不排序**（安全约束靠链路本身达成）。
  - 同组里**折叠的分组**不参与（DOM 里没渲染就不动它）。

### 🐛 修复

- **会话重排在生产环境完全没反应** —— 两个独立成因，都踩到了：
  1. **SSE 订阅集合被拆成两份**：`/workspace/watch` 当时用裸 `ctx.webServer.register` 注册，而路由按 path
     去重是**模块级**的 —— 多 bot 实例（`im-qqbot-2` / `im-qqbot-3` 各 `apply` 一次）下，SSE handler 与
     debug/test 端点落在**不同实例的闭包**里：浏览器把连接加进 A 的集合、debug 读的却是 B 的集合
     ⇒ `watchers` 永远 0，推送全发给空集合。改为 `globalThis` 单例中枢（订阅集合/状态/注册/事件绑定都只做一次）。
  2. **只写 `localStorage` 是没用的**：侧边栏顺序的唯一真源是**内存 store**，持久化是**单向**的
     （启动读一次 + store 变化时往下写，**没有 `storage` 事件监听**）⇒ 我们 `setItem` 既不触发重渲染，
     又会在下一次任何 store 操作（折叠分组 / 换排序方式 / 置顶）后被**整份覆盖回去**。
     改为走用户的真实入口：**派发原生 HTML5 拖拽**（`dragstart` → `dragover` → `drop` → `dragend`），
     交给宿主自己的 `drag.start/hover/drop` 去改内存 store ⇒ 立刻重渲染 + 自动持久化。
- **重排方向反了**：数「热」会话时会把目标自己跳过、继续往后数 ⇒ 目标（本已第一）反被插到热块**末尾**往下掉。
  改为**一碰到目标就停**（已在热块内 ⇒ 不动，天然幂等）。
- **面板每 2s 轮询 list** 导致 `broadcast-tasks.json` 被无意义反复写盘（改为按需）。
- **表情包回收站只进不出**：加上限（默认 **800**）并物理清理最旧的（曾堆到 4000 张）；
  `index.json` 一并清理已不存在的图片记录。

### 📖 文档

- README 增补「会话自动重排」小节 + 实拍截图。
- 《用户手册》《dsh-qqbot 开发维护手册》同步更新（多实例闭包、`localStorage ≠ store` 两条大坑）。

## [1.6.7] - 2026-10-05

> 这一版的核心是 **botplay 自定义事件**：把互动卡片从"点按钮回一句固定文本"，
> 升级成"**由 AI 写的 JS 模块**"—— 于是它能自己维护状态、自己判权限、自己发消息、
> 甚至**把 AI 叫起来**（`ctx.appendWake`）。

### ✨ 新功能

- **botplay 自定义事件**：事件 JSON 加 `file` 字段即变自定义事件；模块放 `{dataRoot}/.qqbot-extensions/botplay/`
  （**升级/重装插件不覆盖**）。钩子：`onInit` / `onClick` / `onTick`(占位未调用) / `onExpire` / `onDispose`。
- **模块 ctx 能力**：
  - `card()` 读写卡片正文与按钮（`dirty` 才重发）
  - `emit` / `markdown` / `image` 自己发消息，`at()` @ 人
  - `store.load/save` 自有状态（落盘、升级不丢）
  - `getMember` / `clickCount` / `user.isOwner` / `owners` 查询与权限
  - **`appendSilent` / `appendWake`** —— 静默进 AI 上下文 / **唤醒 AI 回合**
  - **`api(path, {method, body})`** —— 带 token 的通用官方 API 调用（框架代拿 token + 缓存）
  - **`appId` / `appSecret`** —— ★ 直接把"钥匙"给模块：卡片是代码，能自己换 token 调任意官方接口
- **「🤖 让 AI 写」**：面板输入大白话需求 → 自动把「你的需求 + 官方文档链接 + 契约 + 环境信息（appId/主人 openid）」
  发进当前会话，AI 按契约写模块并登记事件。
- **面板**：选中自定义事件时不再显示编辑表单，改为「模块路径 / 存在与否 / 修改时间 / 导出钩子 /
  🔄 重载模块 / 📄 查看源码 / 📁 复制路径 / 红字报错」。
- **契约外置**：`docs/botplay-contract.md`（纯文本、可版本管理、可直接改，改完重启生效）。
- **新增《QQ机器人API-v2-底层调用参考》**：49 个官方接口的原始 HTTP 写法、参数与响应字段、
  **开放状态速查**（哪些能用、哪些内邀/11253）。

### 🐛 修复

- **dock 聊天「打开时停在最旧消息」**：`Number(null) === 0` 把"没传 afterSeq"误判成 `afterSeq=0`，
  ⇒ 走**正扫**从 seq=1 捞起 ⇒ 永远显示最早那批。改为先判参数是否真的存在。
- **贴底不可靠**：改 rAF 轮询内容高度（原来 ResizeObserver 观测的是固定高度的容器，回调永不触发）；
  并按**真实滚动方向**判断"用户在翻历史"（原来靠 wheel/touch/keydown 判定，误触发后就不再贴底）。
- **新增「↓ 最新」按钮**：不在底部时浮现，点一下回最新并拉新消息。
- **示例模块两处**：点签到不再重发整张卡（避免刷屏与发卡限频）；状态按 `cardId` 分轮（重开一轮不再串上一轮名单）。
- **C 盘日志**：`extDiag` 加 2MB 上限（曾长到 28.4MB）；删除"验收后忘记删"的 `chatRawDiag`（曾 5.5MB）。
- **兼容 dsh 0.2.x**：放宽 `dsh-tools` 的 peer 上界（`^0.1.x` ⇒ `>=0.1.1-rc.2`）。
## [1.6.6] - 2026-10-04

### 📖 文档

- **README 新增「官方 Bot 方案 vs onbot / NapCat 等第三方协议端」对比章节**（中文 README 与英文 README_EN 同步）
  - 从 7 个维度对比：登录方式（填 AppID/AppSecret，**不扫码、不登录你的真人号**）／账号安全（**不碰个人号，无封号风险**）／
    稳定性（官方接口腾讯维护）／资源占用（纯 HTTP+WebSocket，无协议端常驻）／**低配与手机部署**（安卓 Termux、树莓派、
    1核1G 小机器都能跑）／隐私（无中间人）／功能范围
  - **坦诚标注官方方案的短板**：明确写出"功能受官方开放范围限制"（如**踢人接口官方未开放**），
    并说清本插件的补法（🔨 锤子面板用你自己的号走群官网接口）

## [1.6.5] - 2026-10-04

### 🐛 修复（磁盘占用 —— 不再往 C 盘拉垃圾）

- **`qqbot-ext-diag.log` 会无限增长**：扩展工具注册诊断原来是无脑 append、**无上限无轮转**，
  实测在用户 C 盘长到了 **28.4 MB** → 现在**超过 2 MB 自动截断、只保留尾部 512 KB**：诊断还在，垃圾没了
- **删除 `chatRawDiag` 临时诊断**：settings-host 里 2026-09-10 加的调试代码（把含媒体标记的入站原文写进
  `~/.dsh/qqbot-chat-raw.jsonl`），注释里明明写着"主人验收通过后删除"，结果一直忘了删 —— 实测已攒到 **5.5 MB** → 已删除
- **历史遗留文件说明**：`qqbot-quote-diag.jsonl` / `qqbot-rules-diag.log` 是早期版本留下的（代码早已移除，只剩文件），
  可以直接删；本版起不再产生新的同类垃圾
- 实测效果：用户 `~/.dsh` 根目录腾出 **34.91 MB**，剩下与 QQ 机器人相关的只剩两个几 KB 的小日志

## [1.6.4] - 2026-10-04

### 🐛 修复（兼容 dsh 0.2.x）

- **适配 dsh 0.2.x**：dsh **0.2.1-alpha.1** 起新增 **peerDependencies 兼容性检查** —— 插件的 peer 声明
  不满足宿主提供的包版本时会被**直接跳过/禁用**（终端打印 `dsh: skipping profile bundle "xxx"` 或
  `dsh: disabling profile plugin row "xxx"`），而不是给个警告了事。
  - 踩坑点：本插件的 `@deepseek-ai/dsh-tools` 原写 `^0.1.1-rc.2`，语义是 `>=0.1.1-rc.2 <0.2.0`；
    而 0.2.1 提供的是 `0.2.1-alpha.1` ⇒ **被判不兼容、整个插件不加载**
  - 修法：改为 **`>=0.1.1-rc.2`**（去掉上界），同时兼容 0.1.x 与 0.2.x
- 其余 peer（`dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-settings` / `cordis`）原本就是无上界或 `*`，无需改动
- 顺带核实：本插件**没有**订阅 `agent/session-start`（该钩子在 0.2.1 已被移除），群守则与上下文注入走的是
  `agent/pre-step`，不受影响

## [1.6.3] - 2026-10-03

### 🐛 修复（踢人面板「读取失败 / 出不了二维码」）

修掉「🔨 锤子 → 👢 踢人」页面的四个真 bug：

- **入口页选错**：`qun.qq.com` 的登录面板是 **iframe**，二维码和快捷登录头像都在 iframe 里，
  外层 `document` 查不到 ⇒ 被误判成"这个页面上没有二维码元素"。现在拆成两个页：`qun.qq.com` 只用于
  判断"是否已登录"，需要人登录时跳转到 xlogin 面板页（二维码/头像都在它自己的主文档里）
- **跳转逻辑被包在 `if (saved)` 里**：没有凭据文件时整段跳过 ⇒ 页面留在 `qun.qq.com`，**永远出不了二维码** ⇒ 已挪出
- **凭据验证接口不可靠**：原先用 `qunwelcome/myinfo` 验证，明明能正常拉群列表却一直被判定"无效" ⇒
  改用 `get_group_list`（群里所有功能都依赖它，它通了才算真通）
- **`code=21` 反复出现**：残留进程清理用的是**异步** spawn，没等它跑完就重试 ⇒ 改为同步等待，
  并且在启动浏览器**之前**就做一次清理
- 另：面板 `/qun/status` 的 `valid` 不再靠"群列表有没有数据"来猜，改用真实接口验证，凭据失效时如实报告

## [1.6.2] - 2026-10-02

### ✨ 新功能

- **🔨 锤子面板**（dock 面板里原来的「🔇 禁言」改名，下面分两个子页）
  - **🔇 禁言**：走官方接口（原有能力不变）
  - **👢 踢人**：官方至今**未开放踢人接口** ⇒ 改用**你自己的 QQ 号**走群官网接口把这块补齐 ——
    支持扫码登录、可管理的群列表、**群成员搜索**（填 uin = 服务端精确查、秒回；填昵称 = 全量拉取后本地过滤）、
    踢人前有确认框（踢人不可逆）
- **免扫码登录**：扫码一次后凭据存进 `{dataRoot}/qun-cookie.json`，之后自动**静默重登**（不弹窗、不用再扫）；
  `skey` 约 1 天过期，但过期后的重登同样是静默的。本机开着 QQ 客户端时，登录页会直接给出你的头像，点一下就登
- **登录态与 AI 共享**：面板与 AI 读写**同一份凭据** —— 面板登录后可以直接跟 AI 说"把群里那个 X 踢了"；
  反过来 AI 登录过，面板打开就已经是登录状态（不需要额外同步逻辑）
- **AI 侧新增 `qq_group_admin` 工具**：`status` / `login` / `groups` / `members` / `kick`
  （其中 `kick` 必须带 `confirmed=true`，否则只回复"请先跟主人核对群和人"）

### 📖 文档

- README 新增「🔨 锤子面板：禁言 / 踢人」章节与截图；用户手册、开发维护手册同步更新

## [1.6.1] - 2026-10-02

### 🐛 修复（1.6.0 的冒烟修）

- **修：插件起不来 —— `channel-tools` 的 `inject` 里加了宿主未提供的 `systemPrompt`**
  - 症状：面板显示「加载失败 / `qqbot-channel-tools: never started`」，且**群守则、群友小传、智能提示、工具刷新全部失效**
  - 原因：cordis 会一直等待未提供的服务 ⇒ 该 entry 永不启动 ⇒ 所有钩子未注册
  - 修法：还原为 `export const inject = ['tools']`（`systemPrompt` 那条通道已废弃，提示现并入群守则 body 走 pre-step）
- **回滚：移除「按安卓环境自动纠正 `cwd`」的那套逻辑**（`path-utils.ts` / `nsForCwd` 双边规范化 / 保存时更正）
  - 原因：运行时改动 `config.cwd` 会打断 `nsForCwd` 的匹配，导致 pre-step 第一道闸早退
  - Android 路径问题（#7）**另案处理**，本版先保证稳定
- 修：`path-utils` 里误用 `require`（ESM 环境）—— 相关文件已移除

### ✅ 本版保留的能力（无上下文模式 · 智能判断）

- 三个上下文工具：`context_memo` / `context_compact` / `context_drop`（按会话动态挂载，面板一改下回合生效）
- 每轮「⚠️ 话题判断 · 每轮必做」提示 + AI 自己的备忘（并入群守则通道，共用去重 ⇒ 不累积）
- 面板：无上下文模式互斥单选（按条数 / 智能判断）+ **备忘条数上限**可设置（默认 20，超出丢最旧）
- 提示词要求 AI **必须写精简**（每条 <100 字）

## [1.6.0] - 2026-10-02

### ✨ 新功能

- **无上下文模式 · 智能判断（AI 自主压缩/丢弃）**
  - 三个新工具（仅在「无上下文模式 + 智能判断」开启时出现）：
    - `context_memo` —— AI 自己的备忘（list / append / edit / delete / clear）
    - `context_compact` —— **登记**压缩：压掉旧历史、保留最近几条（下一回合执行）
    - `context_drop` —— **登记**丢弃全部历史（下一回合执行）
  - 每轮注入「⚠️ 话题判断 · 每轮必做」提示 + AI 自己的备忘，**要求写精简**
  - 工具按**会话**动态挂载：面板一改，下一回合就出现/消失，**无需重启**
  - 固定条数与智能判断**互斥**，面板做成单选并给出差异说明
  - 备忘存**独立文件**（`{dataRoot}/.qqbot/context-memo/`），压缩永远碰不到它

- 面板：无上下文模式改为「按条数保留 / 智能判断」互斥单选

### 🐛 修复

- **手机（Android/POSIX）环境：`cwd` 写成反斜杠相对路径 ⇒ 会话创建必失败，且失败被静默吞掉**（issue #7）
  - 新增 `shared/path-utils.ts`：统一路径规范化（反斜杠→正斜杠、相对→绝对、非 Windows 平台明确拒绝盘符路径）
  - `SessionManager` 初始化时对 `cwd` / `dataRoot` 就地规范化，避免生成畸形目录

- **备忘条数上限可配置**（`contextMemoMaxItems`，默认 20）；超出**自动丢最旧**，不再无限增加
- 修：工具挂载在 agent 重建后会丢失（`apply` 不重跑）⇒ 改为模块级定义 + 每回合幂等刷新
- 修：`agent/pre-step` 注入在每次工具往返都会追加一份（份数线性增长）⇒ 改为并入群守则通道、共用其去重
- 修：私聊（c2c）会话在面板保存无上下文设置时报「未命中 QQ 会话」
- 修：`contextless-store.loadFrom` 漏读 `smart` 字段（配置里的开关读不出来）
- 修：工具回执文案在没有 note 时谎称「要点已存进你的备忘」
- 修：备忘/pending 文件名含冒号（Windows 非法字符）导致写入静默失败
- 修：`findByAgent` 增加按 `session.id` 兜底匹配（宿主传入的 agent 可能不是同一对象）

# Changelog

本文件从产品视角记录 dsh-qqbot 的重要更新，聚焦用户可感知的变化。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [1.5.31] - 2026-10-01

### 修复
- **引用消息：内容、图片、归属全线修正**（本版主体）
  - **引用块不会再消失**：以前对方引用**纯图片/纯表情**时整块引用会不见；现在会明确写出被引用的是什么。
  - **被引用的图片会给本地路径**：QQ 引用图片往往只给一个占位（`[image]` / 空表情标签），
    现在会 ① 从本机图库 + 落盘台账反查 ② 查不到就**当场把图下载到本地**
    （`{dataRoot}/.qqbot/referenced/`）→ AI 能直接读图。
  - **引用内容只留"他真正引用的那一句"**：QQ 给的是嵌套模板串
    （`=== 消息 1 === [消息内容] … [消息类型] 引用消息 [关联消息] --- 第1条 --- …`），
    现在剥壳后只取最外层那句，不再把整串噪声喂给模型（以前还会被当成"五百多字长引用"截断）。
  - **引用块不会再挂到别人头上**：修掉「当前消息的引用被拼进相邻上一条消息」——
    批量派发时选错了"当前消息"，且引用没有按消息 id 绑定。
  - **`[当前]` 标记不再重复**：以前引用块和消息体各带一个，引用块看起来像"在当前消息之外"。
- **别人 @ 别人时不再显示 32 位 openid**：改从群成员台账换成 `@昵称`（查不到退化成 `@短id`），
  当前消息与群历史行都生效 —— 顺带省 token（`<@07B470BDA5052489D2D0532C2CC2A2EB>` 35 字符 → `@难崩` 3 字符）。
- **群时间戳同分钟内只注入一次**：以前同一分钟连发几轮会堆出多行一模一样的时间头，纯浪费 token。
- **dock 聊天界面**
  - 固定通道规则等运行时注入（`<system-reminder>`）不再混进聊天记录。
  - 不再冒出叫「引」的人 —— 块标记（`[引]` / `[/引]`）不再被当成昵称。
  - 当前消息的引用不再挂到上一个人头上（段落切分把 `[引]` 并进了上一条历史消息）。
  - **滚轮向下滚一次就增量刷新**：只把新消息接在列表下方，**不重绘、不闪、不跳滚动位置**；
    没有新消息时一个字节都不动。
  - 打开聊天页稳定停在最新（气泡图懒加载时"贴底"只贴到半截，现在会随之补贴）。
  - 历史行／多行正文／引用内容加**缩进**，一眼能看出"哪几行属于同一条消息、哪句是引来的"；
    标记体系不变，**旧会话照常解析**。

### 新增
- **扩展工具可访问宿主能力**：`.qqbot-extensions/tools/*.mjs` 的 `env` 增加 `ctx`（宿主上下文）
  与 `logger`，扩展可以自助调用宿主服务（例如 `ctx.compaction.compactNow` 压缩上下文）。
- 引用**表情**消息时转成可读的 `【表情: 微笑】`（不再是 `<faceType=…>` 原始标签），
  并会尝试从标签里挖出图片线索。

## [1.5.30] - 2026-10-01

### 修复
- **dock 聊天界面里混进整段系统提示词**（气泡里冒出 `<system-reminder>` + 【@ 人的方法】等规则文本）
  会话里的 `user/message` **不只承载真人发言** —— 插件的运行时注入走的也是它：
  固定通道规则 + 群守则（`source.kind = qqbot:group-rules`）、QQ 审批提醒（`plugin:qqbot-approval`）、
  上下文压缩检查点（`compact-checkpoint`）等。而聊天视图原来只挡了 `kind === 'plugin'`
  （还是会话格式 V4 已废弃的写法）→ 这些"不是对方说的话"被当成聊天记录渲染了出来。
  → 按 `source.kind` 前缀拦截（`plugin:*` / `qqbot:*` / `compact-checkpoint`），
  并用 `<system-reminder>` 内容特征兜底；真人消息（`kind = user`）不受影响。
- **聊天记录里发送者显示成「历史」，结尾挂着 `[/历史]`，图片显示成本机绝对路径**
  根因只有一行：历史打包的判定拿**整段正文**去套"整行 == `[历史]`"的正则 → **永远不命中**，
  于是历史分段逻辑形同虚设，整段历史被当成"一条普通消息"解析 ——
  第一个方括号 `[历史]` 被当成昵称壳（发送者与头像跟着错），`[/历史]` 作为正文留下，
  `[昵称] [图片: D:\…\x.gif]` 整行当文本（**把本机绝对路径写进了气泡**）。
  → 改为**逐行**判定。同批加固：老结束标记 `[Chat history ends]`（**没有斜杠**）也能识别、
  标记匹配大小写不敏感、`[图片: <含空格的本机路径>]` 能正确取出、媒体标记残留只显示文件名。
- **引用消息在聊天界面显示成裸 `[引用]`，被引用的原文丢失**
  引用块在聊天视图最早的实现里就被折叠成了 `[引用]`，此后前端才加的引用气泡样式
  （左边框 + 灰底）从未被触发 —— 折叠后原文就没了。
  → 引用块**保留原文**交给前端渲染成引用气泡（超过 300 字截断），
  且引用标记不再被误当成发送者。
- 群名取不到时不再显示 `(未选群)`（有 gid 就显示 gid 前段，避免误以为没选目标）。

### 新增
- **扩展工具可以访问宿主能力**：`.qqbot-extensions/tools/*.mjs` 里 `execute(args, exec)` 的 `env`
  现在多两项 —— `ctx`（宿主上下文）与 `logger`。以前扩展只能拿到
  `{cwd, manager, sender, replyTarget, exec}`，**碰不到任何宿主服务**；
  现在可以自助调用宿主能力（例如 `ctx.compaction.compactNow(agent, signal, id)` 压缩上下文，
  再把要保留的话拼回上下文）。
  安全边界：与内置工具**同等权限**（同源于插件自身 ctx），且只对**本机自写的扩展工具**生效。

## [1.5.28] - 2026-10-01

### 修复
- **安卓上 dock 悬浮球完全拖不动**（桌面/网页正常）
  拖动原先只绑了 **鼠标事件** `mousedown / mousemove / mouseup` ——
  触摸屏按住手指**不会触发 `mousemove`**（浏览器只在轻点时合成 `click`），
  所以在 [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) 这类安卓 WebView 里，球按下去毫无反应。
  → 全部改用 **Pointer Events**（`pointerdown / pointermove / pointerup / pointercancel`）：
  **鼠标 / 触摸 / 触控笔一套通吃**，桌面行为完全不变。
  配套加固：
    · `touch-action:none` —— 不让浏览器把拖动误当页面滚动手势
    · `setPointerCapture` —— 手指滑出球体范围也不丢事件
    · `pointercancel` —— 触摸被系统打断（来电/手势）也能正确收尾并落盘位置
    · 面板头部拖动同样改 Pointer Events（展开态也能用手指拖）
- **拖完松手会顺手把面板打开**
  拖拽结束与 `click` 之间没有屏蔽窗 → 拖完一松手面板就弹出来。
  → 增加 350ms 屏蔽窗（`lastDragEndedAt`），拖拽后不再误触发开/关面板。

### 说明
- 本版同时包含 1.5.27 的**窄屏适配**（tab 横向滚动、面板贴边、输入框 16px 防缩放、
  全屏态吸顶+安全区、悬浮球缩小），桌面端仍完全不受影响（媒体查询只在 ≤560px 生效）。

## [1.5.27] - 2026-10-01

### 修复
- **dock 面板在手机竖屏下不可用（tab 被挤成竖排、展开即占满屏）**
  配合 [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) 在安卓上跑时暴露：
  1. **tab 栏没有横向滚动** —— 7 个页签（群组管理/聊天/入群审批/禁言/出站/群发/单会话设置）
     在 ~390px 的窄视口里被压到最小宽度，中文按字换行 → **竖排**，几乎没法点。
     → `.dk-tab` 改为 `overflow-x:auto` + 隐藏滚动条，按钮 `white-space:nowrap; flex:0 0 auto`，
     窄屏下永远**横向滑动**、绝不换行。
  2. **窄屏缺少整体适配** —— 新增 `@media (max-width:560px)` 覆盖：
     · 面板贴边（`left/right:8px`、`max-width: calc(100vw - 16px)`），不再压满屏
     · 压缩头部/正文内边距、页签与按钮字号（13px → 12px），留给内容更多空间
     · 输入框字号提到 **16px**（避免移动端浏览器聚焦时自动放大页面）
     · 列表高度放宽到 46vh；每行间距加大，**更适合手指点击**
  3. **全屏态**（`⛶` 按钮）在手机上补：页签**吸顶**、底部留 `env(safe-area-inset-bottom)` 安全区。
  4. **悬浮球**在窄屏缩到 46px、离边更远（更好按、不挡内容）。

### 兼容性
- 桌面端（>560px）**完全不受影响** —— 新规则只在窄屏媒体查询内生效，原有样式一行未改。

## [1.5.26] - 2026-10-01

### 变更
- **`engines.dsh` 改为范围式声明**：`0.1.5-rc.2 || 0.1.6-alpha.2 || 0.1.7-rc.1 || … || 0.2.0-rc.2`
  → **`>=0.1.5-rc.2`**
  原来用枚举列出"已知可用版本"，宿主每发一个新版就要手动补一行，一忘就被判
  `installation rejected: Plugin @zaofan/dsh-qqbot@x.y.z is incompatible`
  （issue #5 就是这么来的）。改用范围后，宿主再发新版也不会误拒。
  依据：本插件只依赖 `cordis` / `dsh-settings` / 客户端 `slots`·`sessions`，
  这几项在 0.1.5 → 0.2.0 之间一次都没有破坏过。

### 文档
- **README（中/英）新增「📱 手机部署」亮点与章节**
  推荐社区的 [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（dsh 安卓壳 APK：
  WebView UI + 内嵌 Termux 运行时快照，解压即跑）——
  把 dsh 与本插件一起装进手机，就是一台**随身 7×24 在线**的 QQ 机器人，不必为挂机常开电脑。
  同时写明安卓上必须打开的两个开关：
  ① 智能回复里勾「程序兜底（不依赖小模型）」（手机通常无 ONNX 运行时，走字符 n-gram 字面相似）
  ② 系统电池里允许后台运行 / 加入省电白名单（否则息屏即被杀进程）

## [1.5.25] - 2026-09-30

### 改进
- **白名单（`群管理基础设置 → 允许操作的主人 openid`）拥有「无限抢答权」**
  上一版（1.5.24）的抢答按钮是"先到先得、抢到即锁"—— 一旦被群友抢走，
  主人也只能看着。现改为**分级**：

  | 谁 | 抢答规则 |
  |---|---|
  | **白名单主人**（`groupAdmin.owners`）| **不限次数**：任何时候都能抢，包括从已抢到的人手里**夺回**；回执为 `👑 <@他>（主人）接管了回答权…` |
  | **其他人** | 严格"先到先得、抢到即锁"；已被抢走再点只收到"手慢了～已经被 <@某人> 抢到啦" |

  判据取 `SessionManager.adminOwners()`（读 `config.groupAdmin.owners`），
  与审批卡片的"可点主人"、群管理工具的"允许操作的主人"**同一份名单**，
  配置一处即三处同时生效。

## [1.5.24] - 2026-09-30

### 新功能
- **提问卡片新增「🙋 我来回答」抢答按钮**（主人定）
  卡片最上面多一个按钮：**所有人都能点，只能抢一次** —— 谁先点，回答权就**转移给谁**
  （内部把该问题的 `ownerId` 改写为点击者，并**补发一张绑他的新卡片**，
  因为 QQ 按钮的 permission 是发送时烘焙的、已发出的卡片改不了）。
  - 第一个人点 → 回执「✅ <@他> 抢到了回答权，请点下面的选项，或直接发 /答 A」
  - 第二个人再点 → 只收到「手慢了～已经被 <@某人> 抢到啦」，不会误答
  - 原 owner 之后点选项/发文字 → 被拒（判据改成**实时读 ownerId**，不再用发送时的快照）
  - 仅在**单个问题**时附带（多问题时按钮行会挤掉选项；一张卡最多 5 行）
  - 用途：机器人把问题问错人 / 被问的人不在 / 想"谁先看到谁答"

### 文档
- **固定上下文新增「提问卡片·指定回答者」规则**（每个 QQ 会话无条件注入）：
  调用 `ask_user_question` 时要指定"只有某人能回答"，必须在该问题的 header/question 里写
  `<@对方的32位openid>`；只写 `<@昵称>` 仅在"该昵称在群成员台账里唯一命中"（台账 = 在群里发过言的人）
  时才生效，否则退化成全员可点。并说明抢答按钮的存在。

## [1.5.23] - 2026-09-30

### 修复（🔴 智能回复"静默无分"的真根因）
- **`@huggingface/transformers` 是"隐式依赖"——代码用了却没声明**
  本地小模型（`bge-small-zh`）靠 `await import('@huggingface/transformers')` 推理，
  但这个包**从未写进 `dependencies`** —— 只靠它"碰巧被 hoist 到 profile 上层"才能跑。
  一旦环境不同（pnpm 严格模式 / profile 重装 / 依赖提升位置变化 / 单独安装本插件），
  `import` 直接抛错 → `failedAt` 进入 60 秒退避 → **此后所有评分静默变成 `undefined`**：
  面板上只剩"门槛 0.70"和"无分"条目（`value-scores.jsonl` 里连 `score` 字段都没有），
  看起来就像"模型坏了 / 评分功能失效"。
  → 已加入 `dependencies`：`@huggingface/transformers@^4.3.0`。
- **顺带补齐另外两个隐式依赖**
  - `@deepseek-ai/dsh-settings` → `peerDependencies`（宿主服务，与 dsh-llm/dsh-session/dsh-tools 同类）
  - `vitest` → `devDependencies`（误留在运行时依赖里）

### 体验
- **`/local-model/status` 增加 `embStatus`**（嵌入器真实状态，含 `reason`）
  以前模型加载失败时，失败原因只写在 dsh 终端的 `logger.warn` 里，**面板完全看不到**，
  用户只能看到"评分不出现"。现在状态接口会把"待加载 / 已就绪 / 失败原因"一并返回，
  面板可明确提示，不再静默。

### 排查提示（写进手册）
模型"看起来坏了"时，按顺序核对：
1. `~/.dsh/models/bge-small-zh` 四个文件是否齐（`checkModelAssets`）
2. `@huggingface/transformers` 是否可解析（从 `dist/features` 为基准）
3. `/local-model/status` 的 `embStatus.reason` 是什么
4. 都是好的但仍无分 → 进程内 `failedAt` 退避中，**重启 dsh** 即恢复

## [1.5.22] - 2026-09-30

### 适配
- **放宽 `engines.dsh`，支持 dsh 0.2.0 系列**
  原声明为 `0.1.5-rc.2 || 0.1.6-alpha.2 || 0.1.7-rc.1`，缺 `0.1.7-rc.2` 与 `0.2.0` 系列。
  dsh 0.2.0-rc.2 起**强化了插件"不兼容"提示**，装在 0.2.0 上会被告知不兼容。
  → 现改为 `0.1.5-rc.2 || 0.1.6-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2`。
- **兼容性核对**（0.2.0 的变更对本插件的影响）：
  - 「自动化任务改由可选插件包提供」→ **不受影响**：本插件用**自有 scheduler**
    （`{dataRoot}/.qqbot/schedule-state.json`），不依赖宿主 automation。
  - 「工作过程展示默认值调整」→ 纯 UI 偏好，不涉及 API。
  - 「第三方模型目录升级 pi-ai 0.87.1，移除部分旧模型 ID」→ **用户侧**若在智能回复里
    选过被移除的模型，需在面板重选一次。
  - 本插件只依赖 `cordis` / `dsh-settings` / 客户端 `slots`·`sessions`，这些在 0.2.0 未破坏。

## [1.5.21] - 2026-09-30

### 修复（"从 patch 读配置而不是从自有存储读"的同类问题：彻底根治）
- **`nsBot()` 不返回 `cfg`，导致一大批接口拿到的数据根永远是空**
  下游有大量 `bot.cfg.dataRoot` / `bot.cfg.localModel` 写法
  （`export.xlsx`、`value-samples`、`value-scores`、`affinity`、`attitude`、`group/accounts`、
  `localModelDirOf` …），但 `nsBot()` 原先只返回 `{id, appId, appSecret, cwd, ns}` ——
  **根本没有 `cfg` 字段** → 那些地方读到的恒为 `undefined` →
  数据根算空、模型目录找不到（图库/导出/计分/群管理全受影响）。
  → `nsBot()` 现在带上**合并自有存储后的 `cfg`**（并补上推导出的 `dataRoot`）。
- **`mergeOwnIntoCfg()` 漏了 `localModel`**
  `localModel` 同样是"面板保存写自有存储"的字段，漏合并 →
  `/local-model/status` 与 `localModelDirOf` 读的是 patch 默认值 →
  **一打开面板就把 `lexicalFallback` 同步成 `false`（并重置嵌入器）→ 评分立刻全部变成"无分"**。
  → 已补进合并白名单（自定义字段也一并保留）。

### 说明
- 与 1.5.16 / 1.5.20 属**同一类根因**（"保存写自有存储、读取只读 patch"的不对称）。
  至此桥内所有"取账号配置"的入口都统一走 `mergeOwnIntoCfg()` / `nsBot()` 的合并值。

## [1.5.20] - 2026-09-30

### 修复
- **打开设置面板会把「智能回复评分」关掉**
  状态路由原先结合宿主 `settings` 服务的值判断兜底开关，
  而宿主侧的值在"面板刚打开/尚未落盘"时可能是空或旧值 → 判定为"关" →
  本已开启的评分被关掉。
  → 改为**只以插件自有 settings 为准**（`readOwnSettings`），
  宿主 settings 仅作读取兜底，不再反向影响状态判定。

## [1.5.19] - 2026-09-29

### 新功能
- **「程序兜底」向量（字符 n-gram）** —— 让**安卓 / 无 ONNX 环境**也能用智能回复评分。
  本地小模型（ONNX）不可用时，自动改用无依赖的字符 n-gram + 亚线性 TF 向量
  （`词面相似`，衡量字面重合而非语义），接口与 ONNX 嵌入器一致，可无缝替换。
  新增 `src/features/lexical-embed.ts`。
- **兜底开关三处同步**（启动 / 桥事件 / settings 服务）—— 此前不打开设置面板就不生效。

### 修复
- **`text_break` / `reply_gate` 的 render 返回空文本 → 空 tool_result → DeepSeek 400**
  这类"只用来打断/闸门、不产出内容"的工具返回空串时，会向上游发一个空 tool_result，
  DeepSeek 侧直接 400。现改为返回一个最小占位文本。
- **设置页保存漏写 `imageHint` / `messageReference`** —— 面板上勾了却存不下去。
- **`local-embed` 失败后的 60 秒空窗**：模型失败过且兜底已开时，跳过重试直接走兜底。

### 其他
- `inbound`：`textNoScore` 判据改用 `msg.content`（语义等价、更少依赖），并补齐 TS 源。
- `inbound`：观察期内"纯文字未算出分"也记一行（标无分），避免误以为评分没工作。
- 补修 `lexical-embed.ts` 在 `noUncheckedIndexedAccess` 下的 4 处类型错误（否则 `tsc` 编译不过、发布链会失败）。

## [1.5.18] - 2026-09-29

### 修复（**全新安装必崩**的致命问题）
- **全新实例下 dock 位置记忆的空指针会拖垮整个 Web UI**
  现象：全新安装本插件后，dsh web 只剩一句 `Failed to load plugins`
  （`web boot: 1 entry did not activate / @zaofan/dsh-qqbot: failed`），
  **设置页与侧栏全部消失，且每次启动必现**。
  根因：`startQqDock()` 读位置记忆时 `pos` 初值为 `null`（只有 localStorage 里
  已有 `qqs-dock-pos` 时才会被赋成对象），随后 `pos.x` / `pos.y` 被无保护读取 →
  `TypeError: Cannot read properties of null (reading 'x')`。
  `apply()` 裸调 `startQqDock()` → 异常冒泡 → cordis 把这条 client fiber 判 `FAILED` →
  dsh 0.1.7 的客户端启动审计把"任一 client entry 未激活"视为致命 → **整页退化**。
  → 1.5.10 加位置 clamp 时只处理了"坐标在屏幕外"，漏了 `pos === null`；
  作者机器不复现，是因为其 localStorage 里早就有 `qqs-dock-pos`（拖过球）。
  **修复**：① 读完后若 `pos` 非对象则回落 `{}`（守卫空值/损坏值）；
  ② `apply()` 内的「设置页注册 / 审批浮层 / dock」三处改为**逐段降级**（`safe()`），
  单个环节异常只打 `warn`，不再连坐整页。
  验证：dsh 0.1.7-rc.2 + Android 应用分身全新实例 —— 修复前打开即失败，修复后界面正常、🛡 悬浮球正常挂载。

## [1.5.17] - 2026-09-28

### 修复
- **切换工作区/会话后重开 dock 面板，评分模式等设置全部显示成默认值（只记录 / 门槛 0.5）**
  dock 在"反查当前会话属于哪个 QQ 实例"失败时，会回落到实例列表的**第一个**。
  而插件 bundle 自动注入的**幽灵实例** `im-qqbot`（凭据是占位符 `__FROM_ENV__`）
  排在列表最前，它的 `disabled` 是 `false`（只是**没有 appId**），所以过滤 `!disabled` 拦不住它。
  于是面板去读这个空实例的配置 → 全部回落成 schema 默认值，**看着像"主人设的都被重置了"**。
  → 过滤条件改为 `!disabled && appId`（只保留真实例），回落目标也只会是真实例。

## [1.5.16] - 2026-09-28

### 修复
- **改「Agent 预设(人格)」/「工作目录」后界面仍显示旧值（看起来"没改成"）**
  1.5.14/1.5.15 引入的合并逻辑方向搞反了：写成"patch 优先、自有存储其次"。
  但**自有存储才是用户在设置页保存的最新值**，patch 是历史遗留旧值 —— 于是：
    · 改人格后界面仍显示旧人格（实际已生效，只是显示不对）
    · `nsBot()` 用旧的 appSecret/cwd → **用错凭据连不上（掉线）**、群管理与图库走错路径
  → 全部改为 **自有存储优先**，与 `/read` 接口的做法一致
  （`Object.assign({}, base.value, own)` —— own 覆盖 base）。
  涉及：`mergeOwnIntoCfg()`、`nsBot()`、`/accounts` 回显。

### ⚠️ 排查提示
若某账号同时存在"自有存储值"与"patch 旧值"，以**自有存储**为准。
patch 里的旧 `preset`/`cwd`/`appSecret` 不再影响运行与显示。

## [1.5.15] - 2026-09-28

### 修复
- **在设置页填好 AppID/AppSecret 后不会自动连接**（必须重启 dsh）
  为保证"没凭据也能打开设置面板"，`apply()` 现在在无凭据时会装好面板就正常结束
  （不再整段 `return`）。但 `bootstrapGateway()` 原本只在 `apply()` 里调用一次 ——
  于是用户之后在设置页填好凭据，配置对象虽已热更新，**网关却从未启动**，
  表现为"填了密码却不会自动重连"。
  → 现在 `settings-changed` 监听里会检测"凭据从无到有"，**自动启动网关**（无需重启），
  并在日志打印 `检测到凭据已就绪，开始启动网关… / 网关已启动`。
  失败时允许下次重试（`gatewayStarted` 会重置）。

## [1.5.14] - 2026-09-28

### 修复
- **账号设置里填了「工作目录 cwd」，保存后又变空**（同样影响「Agent 预设」）
  自 2026-09-24 起，已有账号的 `appId` / `appSecret` / `preset` / `cwd` 只写**插件自有存储**、
  不再写 profile patch（为避免"多条目 insert 时块边界跨到隔壁"把 YAML 写歪）。
  但**回显路径只读 patch** → 界面上填过的值保存后就显示为空 ❌
  → 现改为回显时**合并自有存储**（patch 优先，其次自有存储），与写路径对称。
  随之修正同源的：`preset` 回显、`appId` 回显、`hasSecret` 判定、`disabled` 判定。

- **同类问题根治：账号配置"只写自有存储、读取只读 patch"的不对称**
  除上面那条 `cwd` 回显外，桥里还有多处**只读 patch** 取账号配置（`nsBot()`、`/session-lookup`、
  `/group/join-summary`），导致用户存进自有存储的 `appId` / `appSecret` / `cwd` 读不到：
    - `nsBot()` 返回 `null` → 群管理 / 图库 / 无上下文 / Excel 导出**全部走错路径**
      （症状：报"找不到该账号实例(请先在账号页配置 appId/appSecret)"、图库与定时目录消失）
  → 新增 `mergeOwnIntoCfg()` 统一合并（patch 优先，其次自有存储），上述入口全部改用它。

### 变更（让"填 GitHub 地址安装"开箱可用）
- **把构建产物 `dist/` 提交进仓库**：此前仓库不提交 dist，从 git 直装只有源码，
  而新版 pnpm 默认禁止 git 依赖执行构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）
  → 装出来没有 dist → 插件加载失败。现在 dist 随仓库分发，git 直装即可用。
- **移除 `prepare` 脚本**：它正是触发上述 pnpm 拦截的原因；dist 已入库，无需安装时构建。

## [1.5.13] - 2026-09-28

> 三个"会让插件**完全加载不起来**"的硬故障修复。

### 修复
- **插件永久加载失败（语法级错误）**
  为"从 GitHub 直装缺 dist"新增的包入口守卫 `entry.js` 里多写了一句
  `export { default } from './dist/index.js'` —— 而 `dist/index.js` 并没有 default 导出，
  于是抛
  `SyntaxError: The requested module './dist/index.js' does not provide an export named 'default'`，
  **整个插件 import 失败**（宿主只打印 `failed to import`，看不出真因）。
  → 已删除该行。

- **服务未就绪时插件永久 pending（前端整页不渲染）**
  装载设置面板桥时用了 `ctx.inject(deps, cb)` —— cordis 会让**当前插件 fiber 一起等**这些服务。
  如果宿主尚未注册 `settings` / `webServer`（全新 profile 常见），插件自身就永久 pending，
  宿主判定 `1 required plugin did not activate`，**连带整个 Web UI 都不渲染**
  （只剩一句 Failed to load plugins）。
  → 改为 **apply 先正常返回（插件立即激活）**，再用 `setTimeout` 延后 inject 装桥。

- **依赖声明会破坏宿主生态**
  曾把 `@deepseek-ai/dsh-llm` / `dsh-session` / `dsh-tools` 放进 `dependencies` ——
  pnpm 会装出与宿主不匹配的版本（实测装了 `0.1.0-rc.8` 而宿主是 `0.1.7-rc.1`），
  反而**把宿主自己的官方插件搞挂**（`image-offload` 报 `ctx.sessions.registerMessageProjection is not a function`）。
  → 这三个回到 `peerDependencies`（必须由宿主提供）。
  只保留两个纯工具/客户端依赖：`@deepseek-ai/schemastery`（配置解析）、
  `@deepseek-ai/dsh-client-ui-slots` / `dsh-client-ui-settings`（前端半边声明要用）。

### 其他
- 新增包入口守卫 `entry.js` + apply 阶段安装自检：包不完整时直接打印**原因与解决办法**，
  不再只丢一句 `failed to import`。
- `.npmignore` 增加 `*.bak*`（此前 19 个本地备份被误打进包，约 2MB）；删除仓库里 85 个 `.bak`。
- `prepare` 脚本（pnpm 从 git 依赖安装时自动编译）。
- README 安装章节：把「**必须装到 web profile**」提为醒目警告。

### ⚠️ 安装位置提醒
本插件的前端设置面板只在 **`web` profile**（即 `dsh web` 使用的 profile）里生效。
装到其它 profile 会得到一个**没有设置面板的裸环境** —— dock 球与「QQ 机器人」设置页都不会出现。
正常使用 `dsh web` 的用户无需关心这点（默认就是 web）。


## [1.5.12] - 2026-09-28

> 修两处"点了审批没反应 / 点了就失败"的问题。

### 修复
- **审批点了就失败（dsh 会话格式 V4 不兼容）**：
  `qq-approval` 的注入消息用了 `source.kind = 'plugin'`，而 dsh V4 明确拒绝该值
  （`SessionFormatError: format v4 message requires a producer-owned source kind`）。
  症状：在 web 或 QQ 点「批准 / 拒绝」后**本轮直接运行失败**。
  现改为官方给第三方插件的 producer kind —— `plugin:qqbot-approval`，并去掉已淘汰的 `plugin` 字段。
- **群里发起的审批，主人点不动按钮**：
  审批卡片的 `permission.specify_user_ids` 原来只放"发起者本人"，
  于是**别人发起的审批，主人无法批准**（点了没反应）。
  现改为 **发起者 + 主人白名单（`groupAdmin.owners`）**，并新增 `SessionManager.adminOwners()` 读取白名单。
  > 提示：白名单在「设置 → QQ 机器人 → 允许操作的主人 openid（逗号分隔，可留空=不校验）」里填写。

### 说明
- `1.5.11` 已包含：无上下文模式（按会话）、智能回复退避重试、会话损坏修复、压缩频率修复。
- `1.5.10` 已包含：dock 悬浮球 `dsh.client` 声明修复、悬浮球位置 clamp、`model-prefs` 落盘与膨胀修复。

## [1.5.11] - 2026-09-28

> 新增「无上下文模式」；修 4 个"静默失效/写坏数据"的问题。

### 新增
- **无上下文模式（按会话开启，省 token）**：dock 面板「⚙ 单会话设置 → 🚫 无上下文」里对某个会话开启后，
  该会话**每轮只带「最近 N 条对话 + 系统规则」**，更早的历史会被折叠掉。实现走 **dsh 原生的 surface
  replace（shadow）机制**（与 dsh 自带 compaction 同一套协议）：
  - **零额外 LLM 调用**（自带 compaction 需要生成摘要；这里用一句固定替身文本）
  - **web 记录照旧保留**，只多一行「上下文已压缩」折叠标记（不是删除历史）
  - **每回合只压一次**（`agent/pre-step` 每个 step 都触发，这里只取首个 step）
  - 全局开关：`contextlessMode` / `contextlessWindow`

### 修复
- **智能回复失效**（评分只剩图片、文字消息不再产生分数）：
  `local-embed` 原来是"**一次加载失败就永久关闭**"，之后所有评分静默返回 undefined，只能重启进程恢复。
  现改为 **失败后 60 秒退避，退避结束自动重试**；并在面板「🔄 重新检测」时**强制重置**（新增
  `POST /api/qqbot-settings/local-model/reset`）。
- **会话日志损坏（SessionFormatError）** —— 两个致命点：
  - `compaction/start` / `compaction/end` 的 `turn` 必须与**当前打开的回合**一致；之前传 `null`，
    在回合开着时写会直接让会话被判 corrupt（`does not match the open turn`）。
  - 压缩范围**绝不从 surface node0 开始** —— 它是"受保护的 head"（通常是 `system/message`），
    被替换后会报 `system/message requires a protected first surface head`。
- **压缩过于频繁**：`agent/pre-step` 是**每个 step** 都触发，之前一个回合里「思考→工具→再思考」会连压多次
  （表现为一段里冒出好几条「上下文已压缩」）；现在只在**回合的第一个 step** 压。
- **无上下文模式在"全局开关"下不生效**：原判断要求 `sessionKey` 反查成功，而 web 会话反查为空时整段被跳过。
- **开关落盘失败 / 多实例互相覆盖**：`contextless-store` 在 storePath 为空时 `persist()` 会静默 return
  （面板显示"已保存"但磁盘上没有）；且多个账号实例共用一个模块级路径会互相覆盖。现加兜底 + 按 key 归属分文件写回。

### 说明
- `1.5.10` 已包含：dock 悬浮球 `dsh.client` 声明修复、悬浮球位置 clamp、`model-prefs` 落盘与膨胀修复。

## [1.5.10] - 2026-09-27

> 修 4 个"会打到普通用户"的问题，其中前两个直接影响能否看到/使用插件的 Web 界面。

### 修复
- **dsh 0.1.7 下 dock 悬浮球不显示（影响所有用户）**：
  客户端模块的加载条件（`dsh-client-modules`）要求 `dsh.client` 声明里给出依赖或立即加载标记；
  原来只有 `{"platform":"web","inject":[]}`，**空 inject 且无 `immediately`** 时该模块不会被排进前端的加载图
  → 页面上永远看不到 `🛡` 悬浮球（连报错都没有）。
  现改为 `{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-slots"],"immediately":true}`。
- **悬浮球被拖到屏幕外后永久消失（用户很难自救）**：
  拖拽过程**有**边界限制，但**读取上次位置时没有** —— 窗口变小 / 换显示器后，
  `localStorage['qqs-dock-pos']` 里的旧坐标落在可视区外，球就再也点不到了。
  现读取时同样 clamp 到可视区（旧坐标会被自动拉回）。
- **`model-prefs.json` 落在 C 盘用户目录**：该文件此前硬编码 `~/.dsh-qqbot/`，
  没跟随 `DSH_HOME`/`dataRoot`（其他数据都在 dataRoot）。现改为 `{dataRoot}/.qqbot/model-prefs.json`，
  并在启动时**自动迁移**老文件（原文件改名 `.migrated` 留档）。
- **`model-prefs.json` 只增不减**：`overrides` 的 key 是 `会话键@会话ID`，
  每次新建会话（`/new`、cwd/preset 变更、重启后未 resume）都会多一条，而旧会话的条目永远没人清。
  现新增**孤儿清理**（sessionId 已不是该会话最新值时删除）+ **每表 300 条上限**。

### 说明
- `1.5.9` 已包含：设置保存改插件自有存储（深合并）、图片本地路径修复（预检顺序 + fileid 稳定键）、
  历史图片不再折叠成 `[图片]`、写 patch 前去重、README 两条 FAQ。
## [1.5.9] - 2026-09-24

> 修一批"静默失效"型 bug：不报错、但功能悄悄没了。都跟 0.1.7 适配期的配置合并与图片链路有关。

### 修复
- **自有存储改为深合并（重要）**：此前用 `Object.assign` 浅合并「自有存储」与 profile 配置，
  一旦某字段在自有存储里是**空对象**（如 `sticker: {}`），会把 patch 里该字段的整块配置**顶掉**
  → `config.sticker.collectEnabled` 变 `undefined` → **图片自动下载静默停摆**。
  （症状：最后一张自动下载的图停在某时刻，之后入站图片只剩 QQ 长 URL。）
  现改为递归合并 `mergeDeep`，空对象不再覆盖默认值。
- **当前消息的图片拿不到本地路径（两处）**：
  - ① **执行顺序**：原代码「先 `assembleAgentBody` 拼消息、后做图片预检并 `rememberImagePath`」
    → Layer4 查缓存时永远是空的，当前消息只能回退 QQ 长 URL（**历史消息反而正常**，因为缓存下一条才生效）。
    现在**在拼消息之前**先补一次预检。
  - ② **缓存 key 不稳**：QQ 同一张图每次推送的 URL（`rkey`）**连 `fileid` 尾段都会变**
    （实测两次推送的公共前缀仅 **41 字符**），只按完整 URL 缓存必然 miss。
    现在 `image-path-cache` 增加 **fileid 前 40 字符**稳定键，命中即返回本地路径。
- **历史图片不再被折叠成 `[图片]`**：匹配不到本地图时**保留 QQ 原始链接**
  （宁可多花些 token，也别让模型对着 4 个字符干瞪眼；本地命中仍优先，那条路更省 token）。
- `image-url-ledger` 的 fileid 前缀索引从 48 调整为 **40**（按实测公共前缀）。

### 文档
- README 新增两条 FAQ：
  - **「自有存储的空对象陷阱」**（为什么不要留 `{}`，以及怎么恢复默认）
  - **「升级后自定义配置（群守则 / 注入规则）被默认值顶掉，怎么找回」**
    （宿主把旧 `~/.dsh/settings.yaml` 留档为 `settings.yaml.imported`，原件在里面）
## [1.5.8] - 2026-09-24

> 这一版把「设置页保存」从**改写 profile 的 `cordis.patch.yml`** 整体搬到**插件自有存储**，
> 顺手修掉了 0.1.7 适配期暴露的一连串问题。

### 重构
- **设置保存在插件自有存储**：`{DSH_HOME}/qqbot-settings/<实例>.json`，**不再写 `cordis.patch.yml`**。
  - 不会再触发宿主热更新（曾因「写 patch → 宿主热提交 → 插件重新 apply → 再写配置」形成**自反馈死循环**，把 dsh 启动刷死、无限弹二维码）
  - JSON 天生保类型（不再出现 `appId` 被写成裸数字、`owners` 空数组被写成空串导致 schema 校验失败）
  - 支持新增键（`groupAdmin.pollJoinRequests` 这类嵌套新字段以前写不进去）
  - **用户无需再手改任何配置文件**（可视化的初衷）
- 读取路径：profile patch 的值 + 自有存储覆盖；插件启动时同样以自有存储为准，
  保存后桥 `emit('qqbot/settings-changed')` → 插件热更新内存配置。

### 修复
- **去掉启动自动扫码**：凭据缺失时只打印提示。自动扫码会「写配置文件 → 触发宿主热更新 → 重新 apply → 凭据仍缺失 → 再扫码」形成死循环；
  需要扫码请到 Web「账号与预设」走交互式流程（可随时取消，不会自转）。
- **修 `accounts/save` 写错条目**：`- insert:` 下挂多个条目时块边界会跨到隔壁——曾把机器人凭据写进 `mcp-chrome`、
  并给其他条目追加重复键。现在已有账号的 `appId/appSecret/preset/cwd` **只写自有存储**（`disabled` 是宿主 entry 属性，仍写 patch）。
- **新增写前去重 `dedupeYamlKeys()`**：杜绝重复键把宿主 YAML 严格解析写崩
  （`YAMLException: duplicated mapping key` → dsh 完全启动不了）。
- **设置页读取兜底改为递归解析** profile patch（支持嵌套对象 / 数组 / `!!js`），
  修复 `groupAdmin` 等嵌套配置读不回来、导致「勾选保存后又跳回去」。
- **脱敏占位符不再回写**：`__REDACTED__` 一律视为「未修改」，修掉「保存时把真 `appSecret` 覆盖成打码值」的事故。

### 新增
- dock「群组设置」面板新增 **「实时入群事件(需平台开通·重启生效)」** 开关（对应 `groupAdmin.watchJoinRequests`），
  不必再去主设置区的「群管理基础设置」里找。
  - ⚠️ 该事件需先在 QQ 开放平台开通；未开通时打开会导致机器人连不上（Identify 被拒 4914/4915）。
- `scripts/dedupe-patch.ps1`：一键清理 `cordis.patch.yml` 里的重复键（默认 dry-run，`-Apply` 才写，自动备份）。
- README FAQ：0.1.6 → 0.1.7 升级后**自定义群守则可能被默认值顶掉**的排查与找回方法。
## [1.5.7] - 2026-09-24

### 修复（在 dsh 0.1.7 下恢复设置页与预设管理）

dsh **0.1.7** 重构了设置机制（移除了 `ctx.settings.installSection`，改为「从 profile 里插件条目的 config schema 推导」），并把 Agent 预设从「目录文件」改成「**profile 配置里的声明行**」。本版让插件的**设置页**与**预设管理**在这套新机制下重新可用。

- **修复设置页「读取失败: {}」**：宿主 `describe()` 里不再返回本实例的命名空间（插件按设计静默降级）→ `viewOf()` 增加兜底：**直接读 profile 的 `cordis.patch.yml` 里该 entry 的 `config`**（块级提取，跳过 `!!js` 与嵌套块，secret 字段按宿主口径打码）。保存时对"兜底视图"跳过乐观锁（`revision: -1`），避免必报 `SETTINGS_CONFLICT`。
- **人格编辑器恢复可用**（`/presets/files`、`/presets/file`）：0.1.7 下预设声明在 profile patch 里，插件改为对 `persona` 插件的 `config.prefix` 提供「**虚拟人设文件**」读写。
  - 同时支持**块标量**（`prefix: |-` 多行）与**行内标量**（`prefix: 一句话`）；行内写法保存时自动升级为块标量，多行人设也能存。
  - **逐字节保真**：纯空白行原样透传；换行符**逐行保留**（patch 可能 LF/CRLF 混用，统一 eol 会改掉别处字节）。实测多个预设"读出 → 原样写回"完全一致。
  - 每次写入前自动备份整个 patch。
- **复制预设 / 从标准新建恢复**（`/presets/copy`、`/presets/new`）：
  - patch 里已有的预设 → **原块整段复制**（字节保真），只改写顶层 `id` / `config.id` / `config.name` 三处；
  - **宿主内置预设**（`standard` / `ptc` / `minimal` / `cordis`，它们不在用户 patch 里）→ 用宿主的 **`agentPresets.readDocument(id)`** 读出组成再生成声明。
- **新建/复制后自动刷新列表**：成功后立即刷新 + 1.2 秒后再刷新一次（宿主 HMR 重载 patch 需要一点时间），避免"提示已生成、列表里却看不到"。
- **提示语更新**：不再提示"打开文件夹"（0.1.7 已无预设目录），改为引导用「人格」按钮编辑正文。

> 已知限制：「打开预设文件夹」在 0.1.7 下无法支持（官方注册表既无目录、也无写接口）；「删除预设」尚未实现；人设写在**外部 `.mjs`** 的预设，人格编辑器暂不覆盖。

## [1.5.6] - 2026-09-23

### 变更（适配 dsh 0.1.7 的「声明式预设」）

dsh **0.1.7** 把 Agent 预设从「目录里的 yml 文件」换成了「profile 配置里的声明行」：由 `@deepseek-ai/dsh-agent-preset-registry` + 每预设一行 `@deepseek-ai/dsh-agent-preset` 构成。官方明确**注册表不扫描目录、不接受 preset 路径、也没有任何接口接受 YAML 写回**（新增/覆盖只能写 profile 的 bundle 补丁）。本版把插件的预设能力改成**双模式探测**：新版走服务、旧版照旧，两边都不崩。

- **预设列表双模式（`GET /presets`）**：dsh 0.1.7+ 改走宿主 **`agentPresets.list()`**（新版没有目录，扫目录只会得到空列表）；≤0.1.6 仍回落扫目录。返回体新增 `mode: "registry" | "dir"`，新版下 `root` 为 `null`。
- **写操作给明确指引**：`/presets/copy`、`/presets/new`、`/presets/open`、`/presets/files`、`/presets/file` 在新版下一律返回 **501 + 可操作的中文说明**（指引在 profile 的 `cordis.patch.yml` 里用 `- insert:` 声明 `@deepseek-ai/dsh-agent-preset`，或走创造模式生成 bundle），而不是静默失败或只报"预设不存在"。
- **跟随 `DSH_HOME`**：`PRESET_ROOT` 与 profile 定位（`scanDshProfiles`）此前硬编码 `~/.dsh`，现**优先读环境变量 `DSH_HOME`**，与宿主保持一致（多环境/测试隔离不再串目录）。
- **预设挂载链路无需改动**：`agentPresets.resolve/mount/defaultId` 在 0.1.7 中签名不变，插件（`session-manager`）原本就走这条，继续可用。
- **实测**：在独立 `DSH_HOME` 下用 **dsh 0.1.7-rc.1** 验证 —— 插件正常加载并初始化、声明式预设可被 profile 补丁 `- insert:` 声明并生效、无版本兼容拦截。`dsh.engines.dsh` 相应追加 `0.1.7-rc.1`。

> 已知未覆盖：新版下**"复制/新建预设"暂未实现写入**（需把预设组合序列化成 entry-list YAML 写入 profile 补丁，风险较高，留待后续版本；当前给出明确指引而非静默失败）。

## [1.5.5] - 2026-09-18

### 变更（适配 dsh 0.1.6）

- **逐条核对 dsh 0.1.6-alpha.1 / alpha.2 的破坏性变更**，结论是本插件**无需结构性改造**：插件实际使用的宿主接口在新版中全部保留且签名一致 —— `ctx.on('session/event')`、`ctx.on('agent/pre-step')`、`ctx.tools.register(def): () => void`、`session.surface.nodes`、`ctx.inject(...)`、`ctx.systemPrompt.context()`。官方新增的 `agent/created` 仅用于替代 `agent/session-start`（本插件未订阅后者），故不受影响。

- **默认模型兜底更新**：0.1.6 把 `deepseek-v4-flash` / `deepseek-v4-flash-vision` 移出了**默认模型列表**。插件最后一层兜底由 `deepseek-official/deepseek-v4-flash` 改为 `deepseek-official/deepseek-flash`（与 `settings.yaml` 里 `agent-default-model` 同值）；用户显式配置的 provider/model 优先级不变，仅"什么都没配"时的保险值变化。`/bot-model` 帮助文案与用户手册示例同步更新。

- **弃用接口标注**：`session-manager` 中「群守则去重」的会话历史只读遍历，按官方措辞标注 `eventAt / snapshotEvents / ownEvents` 自 0.1.6 起 `@deprecated`（"既有逻辑可暂不迁移，禁止新增调用"），保留实现并注释后续迁移方向（surface 投影 / 异步事件流）。判空写法保证旧宿主上同样安全。

- **运行时卸载（reload）复核**：0.1.6 新增插件管理页，支持实时启用/禁用与运行时卸载，官方要求插件自查加载/卸载逻辑。已复核本插件三条路径均干净：① `bootstrapGateway` 经 `ctx.effect(..., 'im-qqbot.lifecycle')` 注册清理（停 schedule ticker、停 botplay 清扫器、dispose 审批/提问控制器、`manager.disposeAll()`、`bot.stop()`）；② 设置 host 桥的路由走 `ctx.effect(() => ctx.webServer.register(...))`；③ 通道工具用 `ctx.tools.register` 的 disposer（挂在插件 ctx 上随销毁回收，模块级 WeakMap 仅用于热刷时的同名替换）。

- **客户端兼容**：设置页对宿主 `sessions` / `slots` 一直是多层防御式读取（`ctx.sessions` → `ctx.get('sessions')` → `localStorage['dsh.sessions.current']` 兜底；`slots` 缺失只告警不抛错），0.1.6 的客户端 Session / slot 调整不会让面板崩溃。

## [1.5.4] - 2026-09-15

### 修复
- **长时间运行内存持续增长直至崩溃（严重）**：扩展工具加载器用「时间戳 query」绕 ESM 模块缓存（`pathToFileURL(abs).href + '?t=' + Date.now()`），**每次调用都生成全新 URL**。Node 的 ESM 模块注册表对每个 URL 是永久强引用，旧模块实例**永远无法被 GC**；而通道工具是**每条消息都全量注册**一次 → 实测累计触发近 3000 次、单进程 1.5 小时涨到 4GB，触发 `FATAL ERROR: Reached heap limit`（GC 日志里 Mark-Compact 一次只能回收 7MB，全是模块强引用）。现改为按**文件 mtime** 取版本号：文件未改动 → URL 相同 → 复用已缓存模块；改动后 mtime 变化 → 自动加载新版本，热刷语义不变。`hotReloadChannelTools()` 里同一手法一并修掉。实测同运行时长（14 分钟）内存 **1277MB → 711MB**。

- **聚合消息里「历史中 @ 了 bot」不算点名**：延迟聚合时 `state.history` 由 debounce 自行构造，条目上只补了文本标注 `(@you)`，**没有携带结构化的「这条 @ 过 bot」标记**，下游评分链路识别不出"窗口里有人 @ 了她" → 低分时照样被拦，表现为「明明 @ 了却不回话」。现在 `mentioned` 标记随条目一路贯通（debounce → inbound），**被点名者一律豁免分数门控，@ 必回**。

## [1.5.3] - 2026-09-15

### 变更（省 token）
- **入站块标记换成中文短标记**: `[Quoted message begins]…[ends]` → `[引]…[/引]`、`[Current message]` → `[当前]`、`[Chat history begins]/[ends]` → `[历史]/[/历史]`，时间行去掉"当前时间"四字 → `[2026-09-15 周二 11:06]`。实测**每条省 ~14 token**（同文本仅换标记：198→112 字符 / input 149→135）；用中文而非 `<q>` 这类 ASCII，是因为省得一样多而**语义自解释**，不必再花 token 在 system prompt 里教它。标记常量集中到 `src/transport/markers.ts`。
- **没被 @ 的群消息标签只给昵称**: `[昵称 #短号]`（原来无论有没有 @ 都塞 32 位 openid，每行白烧 20+ token）；被 @ 时才给 `[昵称 (openid) #短号]`。短号两边都保留——它是引用标记（`[rf:xxxx]`）也是 `id_lookup` 反查 openid 的入口。

### 修复
- **「没被 @ 就扣分」是错的**：改成 **@ 了别人才扣分**（`OTHER_MENTION_PENALTY`）。没人 @ 她恰恰是她该主动接话的常态，按那个口径扣分等于把她训成"等点名才说话"。
- **打分文本里带 @ 标记会把分数带偏**：样例是 `@bot xxx`、入站是 `<@openid> xxx`，两者的最大共同特征成了"这条 @ 了她" → 实测「<@xx> 不知道」拿 **1.00 分**。现在样例与查询都先剥 @ 标记（`stripMentionForScore`）。
- **改扩展工具后 `tools_reload` 不生效**：dsh 的 registry 对重名直接拒绝，热刷历来只能"新增"工具。现在收下 `register()` 返回的 disposer，热刷会先注销自己上次注册的那份再注册新的 → **同名工具也能热替换**，改扩展工具不用再重启宿主。

## [1.5.2] - 2026-09-15

### 新增
- **附件唤醒开关(按类型)**: 「🧠 智能回复」页新增 `🖼图片 / 🎬视频 / 🎤语音 / 📎文件` 四个勾选 —— 勾上 = 该类附件**不管分数**都唤醒她; 没勾 = 交给评分判(没文字就没分 → 不唤醒)。默认只放行图片, 其余三类交给评分, 避免"随手丢个文件就把她叫出来"。

### 修复
- **视频 / 文件 / 语音不再"免费通行"**: 入站收 QQ 多媒体链接时原来用宽匹配一把捞(只要带多媒体就当"带图"放行), 于是纯视频、纯文件也能跳过评分直接唤醒 → 现在按 `content_type` 精确分四类分别判定。
- **语音转文字现在参与评分**: 转写文本原来只进对话上下文、不进打分文本, 语音消息的分数恒为"无" → 已合并进评分文本, 语音能正常判分了。
- **聚合层"等不到回合结束"会卡住**: 群里上一回合长时间不结束时, 攒着的消息会一直不刷 → 超过 3 分钟强制放行, 并记一条 warn 日志便于定位。
- **面板「附件唤醒」勾选"保存后又跳回"**: 渲染源只读宿主状态接口, 而该接口读不到实例配置(字段一律回退默认值), 配置其实早已写对 → 改为**直读设置配置为准**、状态接口仅兜底; 并在保存成功后立刻回填本地缓存再重绘。
- **熟识度表里「好感度」列显示成 `—`**: 该列按人**左连接**好感度, 而接口默认只返回排行榜前 8 名 → 排第 9 的人永远 join 不到(看着像 0)。现在面板请求全量(接口新增 `all=1`), 原有排行语义不变。

## [1.5.1] - 2026-09-14

### 修复
- 判定门槛收紧(倾向/情绪 margin)、英文语料治理、接梗与主动承担类关键词补强; 面板显示修复; 日志文件滚动上限。

## [1.5.0] - 2026-09-14

### 新增
- **好感度 / 熟识度系统**: 按人记录她对你"熟不熟 + 什么态度", 面板多列展示(熟识度 / 好感度 / 这次变化 / 活跃度), 支持一键**导出 Excel** 分享。
- 聚合消息按「价值 × 好感」加权平均判定; 判定样本库重写。

## [1.4.6] - 2026-09-13

### 变更
- **面板改名: 「本地小模型」→「智能回复」**（dock「⚙ 单会话设置 → 🧠 智能回复」、设置页文案、README 中英、参考文档同步）—— "本地小模型"是实现细节, "智能回复"才是用户视角: 她先用本机小模型判断这条值不值得回。
- **面板内置「检测 + 一键下载」模型**: 🧠 智能回复页打开即**自动检测**, 状态直白 —— `✅ 已就绪 · 22.9MB` / `⚠️ 未安装(缺 N 个文件) —— 点右边「⬇️ 下载模型」即可`; 按钮 `🔄 重新检测` + `⬇️ 下载模型(自动)`(宿主 `local-model/status` / `local-model/download` 路由, 多镜像兜底, 约 23MB)。

### 修复
- **一键下载/文档里的模型仓库地址写错**: 脚本与 README(中/英) 直链原本写 `BAAI/bge-small-zh-v1.5`, 但 **onnx 量化权重只在 Xenova 转换版**里(官方 BAAI 仓库**没有 `onnx/` 目录**, 照着下必 404) → 全部改为 `Xenova/bge-small-zh-v1.5`(onnx/model_quantized.onnx), 并把脚本文件清单补齐为 **4 个**(与宿主下载路由一致, 否则面板会一直报"缺 1 个文件")。
- **README_EN 补齐**: 英文文档补上「Smart reply (local small model)」整章(一条命令 / 手动三文件 / 粘给 AI 的指令 / 三种模式与边界 / 评分记录字段)。

## [1.4.5] - 2026-09-13

### 新增
- **本地小模型「价值评分」——低分闲聊不唤醒, 直接省 token**: 群消息先由**跑在本机的** bge-small-zh-v1.5(ONNX 量化 ≈ 23MB, CPU 毫秒级) 打分, 低于门槛且**没被 @** 的闲聊**不唤醒 AI**(消息仍进上下文, 不丢)。三种模式: `off` 不评分 / `log` 只记录(观察期) / `block` 低分不唤醒。
  - **会话级覆盖**: dock「⚙ 单会话设置」可按群单独设模式/门槛/开关, 存 `settings.yaml` 的 `localModel.overrides`。
  - 被 @ 的永远放行; **带图消息一律放行**(群友发图多半是给她看的, 拦掉最亏)。
  - 记录 `{dataRoot}/.qqbot/value-scores.jsonl`(含 `score/worth/gate/min/conf/mention/img/lib/agg/top`), 面板「最近评分」可直读, 也能让 AI 自己读来做样例库维护。
  - **一键下载模型**: `node scripts/download-model.mjs`(国内自动走 hf-mirror 镜像, 带体积校验)。README 新增「本地小模型」专章: 一条命令 / 手动三文件 / **直接粘给 AI 的指令**。
- **图片入站改给「本地路径」**: 入站消息里的图片不再塞又长又会过期的 QQ 链接, 而给**本地文件路径**(收藏插件已把图落盘) → AI 读图**不用再下载一次**, 上下文也短一截。下载没成功/没落盘时**自动回退**成原链接。
- **图片 → QQ 链接台账(兜底)**: 新增 `{表情包}/image-url-ledger.jsonl`(追加写, 上限 **1000 条**, 只记图片) 记录「图库 id → 当时的 QQ 链接」。本地文件被候选区滚动清理、搬层或删掉时, 界面还能拿这条链接把图显示出来。
- **dock 聊天界面图片兼容三种来源**: `http(s)` 链接 / 本机路径 / 图库链接(`sticker-img?id=`)。本机文件**搬层后**(candidate→library) 会按图库 id 自动解析到**当前真实路径**; 万一还是失败, 前端按「QQ 链接 → 图库 id」顺序兜底重试。

### 变更
- **回复冷却"没产生回复就还回去"**: 冷却的目的就是省 token —— 现在只有**真正唤醒过**(花了 token)才消耗冷却; 被价值评分拦在唤醒之前的那次, 会把刚戳的冷却**回滚**(否则一条低分闲聊会白让群里静默 90 秒)。
- **日志安静化(用户视角)**: 模型解析的诊断输出默认**静默**(排障时设 `DSH_QQBOT_DEBUG=1` 打开); 每消息级的热路径日志降为 debug 级, 普通用户控制台不再被刷屏。

### 修复
- **价值评分拦截 fail-open**: 原实现把"拦下"的 `return` 写在 `if (会话可 append)` **里面** → append 能力缺失/抛异常时会**悄悄继续往下走照样唤醒**(等于默认放行)。现在**先判定拦截、再尽力 append**, 无论 append 成败都拦下, 日志给出 `appended=` 结果。
- **`localModel` 未进 live 同步**: 面板/设置页保存的评分模式、门槛、会话级覆盖**只写进了配置文件, 从不同步进运行时** → 表现为"改成了 block 却还是照旧回话, 必须重启"。现已纳入 live 同步, **保存即时生效**。
- **图库已有图的消息被误拦**: 纯图本来判不了分不拦, 但"库里已有"的图会借库标签产出低分(实测 0.022) → 被当低分闲聊拦掉。现在**带图一律不拦**。
- **dock 聊天里本机路径的图不显示**: 附件行目标是本机路径时, 宿主侧媒体抽取只认 `http(s)` → 图片被当文本丢掉。现按类型转成同源直出 URL(`raw-media`), 图片/视频/语音/文件都能正常渲染。
- **内置读图提示文案过时**: 图片已改成给本地路径, 提示却还写"把 URL 传给识图工具" → 改为"把地址(本地路径; 下载失败时是链接)交给视觉工具"。

## [1.4.1] - 2026-09-13

### 新增
- **引用消息(默认开, 可在设置关闭)**: AI 现在能像真人一样"引用"别人的某条消息再回复。
  - **入站带短消息号**: 每条消息都带一个短号(形如 `#0913a` = 月日 + 流水号, 约 1-2 token); 别人引用某条消息时, **被引用原文**会一并进上下文(`[Quoted message begins] … [Quoted message ends]` 块)。
  - **出站写 `[rf:短号]`**: AI 在回复正文里写 `[rf:0913a]`, 这条回复就以**引用形式**发出 —— 对方能看到"引用了他的消息"的气泡; 标记本身不显示。
  - **短号台账**: 完整 msg_id(60+ 字符)不再进上下文, 由本地台账 `{dataRoot}/.qqbot/msg-index/{群|私聊}/refs.json` 做索引 —— 短号 ≈ 1-2 token(原长号 ~20+ token), 长群聊每轮省下大量 token。台账**按会话分文件夹**, 每份上限 **500 条**(FIFO 淘汰最旧), 记录 短号 ↔ 完整 msg_id + 时间 + 发送者昵称(排查方便), 人也能直接打开看。
  - **web 悬浮球聊天界面**: 引用消息渲染成引用气泡样式(左边框 + `↩` 灰底), 不再是糊成一坨的长文本。
  - 开关: 设置面板 ③ 区块「引用消息」。关掉 = 不登记台账、不注入短号、不注入引用指令。

### 修复
- **passive 模式下引用不生效**: 出站目标有两条构造路径(「逐块目标」= passive 收尾正文块>5 时最后一块转主动 / 「自适应目标」), 原实现只在后者叠加引用 → passive 模式下 `[rf:]` 标签被剔除、引用却没附上(表现为"消息发出去了但没有引用气泡")。已统一走 `withRef()` 叠加, **所有**路径都带引用。
- **引用发送丢失被动 msg_id**: 早期实现为发引用而去掉被动回复 `msg_id`(变成纯主动消息, 群里易被静默拦、也没有回复上下文)。现改为 `msg_id` 与 `message_reference` **并存**(官方 SDK 与文档均支持)。

## [1.4.0] - 2026-09-12

### 新增
- **`id_lookup` 工具 —— 按昵称/群名查 openid**: 想主动 @ 一个没 @ 过你的人、或按名字禁言时, 用它拿 id。数据源 = 群注册表(群名→群 openid) + 本地群成员台账(在群里发过言 / 申请过入群的人); 输出直接给 `昵称 openid  在: 群A, 群B` 格式。⚠️ **从没发过言、没申请过入群的人查不到**(官方群成员列表接口未开放, 返回 11253)。
- **斜杠命令可"把合成消息塞进聚合窗口"唤醒 AI**: 扩展命令返回 `{ wake: { content, senderName? } }` 即可 —— 插件把这条消息塞进**与真人消息同一个聚合窗口**(人多时自动合并成一回合, 不浪费 token); 聚合关闭时退化为立即唤醒。已用于 `/资源` 未命中时自动唤醒去找。
- **`imageHint` 开关(默认开)**: 关掉后不再注入"把 URL 传给识图工具"那条**内置兜底提示** —— 模型自己能读图时可以关它。设置面板 ③ 区块有对应复选框。

### 变更
- **`group_mute_member` 支持批量**: 参数由 `member_openid` 改为 **`member_openids`(数组, 单次最多 20 人)**, 一次调用禁言/解除多人; 容错直接贴 `<@openid>`; 超 20 会提示分批。
  - ⚠️ 实测坑: 官方 `restrict_chat_setting` 的 `members` **一次只能带 1 个成员**(带多个报 `50015013`), 而**解除(del) 支持一次带多个** → 已按 op 区分: 禁言逐条发、解除一次发完。
- **`group_mute_member` / `group_mute_state` 支持跨群**: 新增可选 `gid`(不填 = 当前会话群 / 配置的 `manageGroup`)。
- **入站群历史行不再带 openid**: 只有**被 @ 的那条**显示 `[昵称 (openid)]`, 其余只显示 `[昵称]` —— 长群聊每轮省下大量 32 位 ID。

### 修复
- **同一聚合窗口里的第二条合成消息被吞**: 合成消息的 messageId 必为空, 而窗口内合并去重是按 messageId 比对 → 第二条会被当成"重复"丢弃。已改为**空 id 不参与去重**。
- **多实例抢答(会话被路由到别的工作区)**: `injectSynthetic` 的注册表是模块级, 而多个机器人实例跑在同一进程、共享同一份模块 → A 实例的合成消息会被 B 实例的窗口接走(会话建到 B 的工作区)。已加 **owner 校验**(只接自己那实例的请求)。
- **历史行的空括号**: senderId 为空时不再渲染成 `[资源助手 ()]`, 只显示 `[资源助手]`。
## [1.3.0] - 2026-09-12

### 新增
- **`group_join_auto` 工具: 按关键词自动审批入群申请**: 你说一句"自动审批, 关键词=早饭", AI 调它执行 —— **官方待审列表里验证消息命中任一关键词的直接放行, 未命中的直接拒绝**(`rejectUnmatched:false` = 只放行不清场; `dry_run:true` = 只预览不执行)。拒绝理由中性(默认"答非所问", 不写暗号/答案), 拒绝不可逆。
  - ⚠️ 数据源是**官方待审列表**, 不是本地事件流水(那份含已处理记录, 照着批会全报错); 同一人重复申请**去重后按最新一条判** → 换个暗号重新申请就能过, 旧记录不会误伤。
  - 安全边界: 该工具**仅在主人明确要求时**使用, 平时的入群审批依旧是"汇报 → 等主人拍板"。

### 变更 (省 token 专项)
- **群历史不再带 openid**: 注入上下文的群消息历史改 `[昵称] 内容`, **只有被 @ 的那条**带 `[昵称 (openid)]` —— 长群聊每轮省掉大量 32 位 ID。
- **列表类工具输出瘦身 + 去重**: `group_join_requests` 默认只给 5 条(支持 `page`/`limit` 翻页)且同一人**只留最新申请**; `session_list` 默认"群名 + openid 尾号 4 位"(`full=true` 才给完整 openid); `list_stickers` 默认 5→3 条; `broadcast_send` / `target_group` 目标超过 5 个时只列前 5 + "…还有 N 个"。
- **分组数据双端合并**: 面板从 host 拉分组时, 由原来的"host 有数据就整体覆盖本地"改为**按 id 合并并集**(host 打底 + 本地独有的组保留 + 同 id 取成员多的一份) —— 本地刚建好、还没同步成功的分组不会再被冲掉。

### 修复
- **入群申请本地流水无限增长**: `join-pending.json` 加 1 天 TTL(`PENDING_TTL_MS = 24h`), 读写时都跑一次清理 —— 实测一份 87 条 / 47KB 的流水缩到 4 条 / 2.3KB。
- **debounce 调试日志默认关闭**: 排查官方帧序用的 `.qqbot/debounce-dbg.log` 曾涨到 3.8MB; 现在**默认不写**, 需要时设环境变量 `DSH_QQBOT_DEBOUNCE_DBG=1` 才记录。
## [1.2.0] - 2026-09-12

### 新增
- **`broadcast_send` 工具: AI 一键群发**: 同一段内容一次发到多个 QQ 群/私聊, `targets` 直接写**分组名 / 群名 / 群备注 / openid** 都行(名字有歧义时只列候选, 不猜着发)。走插件原有的**广播队列**(串行逐目标 + 失败指数退避重试 + 2 分钟撤回窗口), 与 dock「📤 群发 · 广播」面板**同一份任务**; 默认直接发送(`dry_run=true` 才预览), 返回逐目标结果(含 `message_id`), `action="recall"` 可 2 分钟内撤回、`action="status"` 查进度。
- **`target_group` 工具: 分组管理**: list / create / rename / delete / add / remove, 读写的正是 dock「📇 群组管理 → 🗂 分组」那份数据(`{dataRoot}/.qqbot/target-groups.json`) —— **AI 与主人共用同一份分组**: 主人在面板里分好组, AI 直接"发给群友"就能群发; 反过来 AI 建/改的组, 主人刷新面板即可见。
- **出站模式新增 `detail`(详细主动)**: 聊天行为与"适配主动"完全一致, 但**额外把 AI 的工具调用与工具结果也推到 QQ**(`🔧 工具调用` 按 1.2s 窗口聚合成一条), 用来在手机上看进度。`/outmode detail` 或 dock「⚙️ 出站」可切, 消息会明显变多, 看完记得切回。
- **提问卡片的文字兜底 `/答`**: 提问卡片发出后, 按钮点不动/想自己打字时用 —— `/答 A`(选第1个)、`/答 1 3`(多选)、`/答 #2 B`(多个提问时指定第2问)、`/答 你的话`(不是选项的文字 → 作为自由回答原样转给 AI)。同时: 卡片按钮带 `A.`/`B.` 字母前缀、正文列全选项; 一次问多个问题改为**依次发卡**(此前 QQ 完全收不到); 选项超过 5 个时按钮只放前 5 个, 其余用 `/答 字母` 选。
- **`/资源` 检索支持简/繁/日文汉字互搜**: 关键词自动扩展成 简体 / 繁体(`狀態異常`) / 日文新字体(`状態異常`) 三种写法一起匹配 —— **输入简体也能命中库里用繁体或日文原名收录的条目**; 未命中时把变体写法回给 AI 让它联网逐个搜。(依赖 `opencc-js`, 装在扩展目录, 非插件依赖)

### 修复
- **撤回消息报 11001**: 撤回接口路径写错(打了不存在的 `/v2/messages/{id}`)。正确按场景分: 群聊 `DELETE /v2/groups/{群openid}/messages/{id}`、单聊 `DELETE /v2/users/{用户openid}/messages/{id}`。群发撤回(dock 按钮 / `broadcast_send action=recall`)因此一直失败。
- **dock 群发"点了没反馈"**: 提示函数一直在找 `#dk-bc-hint`, 而面板从未渲染该元素 —— 成功/失败提示全落空(消息其实已发出)。已补提示行, 且确认群发后**自动切到「📢 广播」子页**(任务列表只在那页渲染)。
- **群发看不到撤回按钮**: 原来的撤回挂在任务卡片的目标明细里, 只在「📢 广播」页加载; 现新增 **「↩ 撤回勾选项最近消息」**(选目标页/广播页都有) —— 勾好目标点一下, **不需要 task_id**, 服务端自己找该目标最新一条已发消息撤回。
- **群名/分组名解析读错注册表**: `manager.cwd` 是**工作目录**、`manager.dataRoot` 才是**数据根**, 之前用错导致读到旧位置的过时群名(新群整个查不到), 广播任务也落到工作目录的 `.qqbot` 里(dock 看不到)。已全部改走 `dataRoot`, 并补齐三处漏用 `dataRootOf` 的模块(群事件 hub / 入群申请 / 申请轮询)。
- **错误信息人话化**: 错误码表补消息发送类 15 个(如 `304103`/`40034005` 被动回复过期 → "改主动消息或让群里先有人说话"; `304036` 无 Markdown 模板权限 → 改纯文本), 并加**关键词兜底** —— 官方返回非数字码时按"被动回复超限 / 频控 / 过期 / markdown"四类给可执行建议(此前"被动回复时间或次数超过限制"只能看到裸报错)。
- **`session_wake` 批量模式误报 `missing required property "text"`**: 顶层 `text` 由必填改为可选(用 `batch` 时每项自带 text 即可), 报错里补了示例提示。

### 变更
- **数据根默认值(通用设计)**: 未配置 `dataRoot` 时**默认**落到 `{cwd}/dshqqbot`, 不再把 `.qqbot / 表情包 / .qqbot-extensions / botplay-events.json / schedule-state.json` 直接倒进工作目录 —— **任何用户的工作目录都能保持干净**; 老数据首次启动自动迁入(同盘 rename 瞬时), 想保留旧行为显式配 `dataRoot: <cwd>` 即可。
- **群发节流**: 后台推进 5s/条 → **1.5s/条**(≈40 条/分钟)。官方主动消息频控: Bot 维度 企业认证 60/qpm、未认证 30/qpm, 单关系(同一个群) 20/qpm、每群每天最多 1000 条 —— 原来的 5s(12 条/分钟)只用掉 1/5 额度。AI 侧 `broadcast_send` 同步推进同样加 1.5s 间隔(此前无间隔)。
- **工具描述瘦身 + 最小示例**: `session_wake` / `broadcast_send` / `target_group` 的描述压到"一句话 + 1~3 行示例"(示例能省掉一整轮试错), 其余长描述后续按同一策略逐步精简。

## [1.1.7] - 2026-09-11

### 文档
- **README 补全「扩展契约」(给 AI 看的两节)**: 明确 ① 卡片正文由 **AI 直接写 markdown**, 本插件**没有模板引擎**(模板就是模型); ② AI 可**自己写** `.qqbot-extensions/{tools,commands}/` 下的工具与斜杠命令, 且扩展位于**账号数据目录、升级/重装插件不会覆盖**; ③ 工具 `run(args, env)` 的 `env.sender` + `env.replyTarget` 就是内置 `send_media` 的发送器 → **工具能自己发 markdown 卡/图片/语音/文件**, "取数据→拼卡→发送"一个工具闭环; ④ 生效方式与坑(新工具 `/tools-reload`; **同名工具改内容会被注册表跳过 → 换名或重启**; 命令需重启); ⑤ 能力边界: 扩展**无法注册按钮回调**(须走 botplay 事件 / dock 卡片编辑器)。README_EN 同步更新。

## [1.1.6] - 2026-09-11

### 变更
- **补全 npm 包元数据**(纯元数据, 代码零改动): 新增 `repository` / `homepage` / `bugs` 指向 GitHub 仓库 —— npm 包页侧边栏从此有回仓库/回 issue 的链接(此前三项皆空, 双向导流白丢); `keywords` 由 5 个扩到 10 个(`dsh-plugin`、`qq-bot`、`chatbot`、`ai-agent`、`llm` 等), 利于 npm 搜索与插件目录收录。

## [1.1.5] - 2026-09-11

### 新增
- **归档会话自动回家(触发式反归档)**: 被误点「归档」藏起来的 QQ 会话, **下次在 QQ 里被消息触发时**自动从归档集合里摘出、回到侧边栏可见(走宿主同一条持久化链, 热刷新, 不用重启)。你主动归档的其它会话不受影响。诊断: `/api/qqbot-settings/_debug` 的 `workspaceAttach` 计数 + `~/.dsh/qqbot-archive.log`。

### 修复
- **`/bot-new` 支持弃档重开**: 会话在磁盘上损坏(历史加载失败)时, 此前会回「当前没有活跃会话, 无需开新」而无路可走; 现改为轮换全新 sessionId 直接另起新档(坏档文件保留不删), 可在 QQ 上直接弃掉炸掉的会话。`/new`(不带参)与 `/new <人格>` 同步。
- **群守则注入写坏会话**: `agent/pre-step` 注入的群守则 user/message 缺 `id`, 运行时能落盘、重启恢复时校验失败 → 会话报 `lacks an identified message` 直接打不开。已补 `randomUUID()`。
- **群守则热更新**: 现读 `settings.yaml` 对应实例的 `groupPrompt`(绕过缓存), 面板改完即时生效。

### 变更
- 移除群守则注入的临时诊断探针(不再写 `~/.dsh/qqbot-rules-diag.log` 与启动期 console 探针)。

## [1.1.4] - 2026-09-11

### 新增
- **入群申请双通道**: QQ 实时事件=【入群申请】消息注记(静默 append 不唤醒, AI 下回合自然看到); 轮询兜底=【审批轮询】系统提醒(唤醒 AI 起来处理)。
- **群组管理四个独立开关(dock 设置)**: 唤醒AI(唤醒群管会话) / 注入群管会话(web 注记) / 通知普通群(申请所在群 web 注记) / 唤醒普通群AI(唤醒申请所在群 AI); 事件与轮询两条链路都生效, 互不干扰。
- **入站 @bot 长 id 清洗**: 入站消息里 bot 自身 openid 自动转短标记 `@bot`(省 token), 出站 @ 人不受影响。
- **web 改模型持久化**: Web 设置改模型重启不回退(QQ 侧 override 优先); `/model` 只列出当前服务商模型。

### 修复
- **多实例单例 bug(B/C 类)**: 表情包库/定时任务/表情闸门/历史缓冲按实例(settingsNs)隔离, 不再串库。
- **模型服务解析**: model-resolver getService 改先 `ctx.get()` 再属性访问(父链查找), 官方模型正常进列表。
- **入群通知链路**: notifyGroupHub 补宿主三级 fallback(QQ 会话表 → 宿主 registry → 宿主 resume), hub 注入成功不再 fallback 普通群; 事件驱动链路按「通知普通群/唤醒普通群AI」开关通知申请所在群; 事件持久化去重防重启重推双条。
- **notifyGroup 默认值修正**: 配置默认改为 false(与注释一致, 默认不打扰普通群)。

## [1.0.1] - 2026-09-09

### 修复
- **「用户代你发送」不再插队拆散 LLM 回合**(web 会话注入安全): 此前 dock 代发/后台通知往会话 append 模拟用户消息时, 若 LLM 正回合活跃(思考/流式/工具调用), 消息可能被插进 tool_calls↔tool_result 中间, 导致下一轮组包报 `INVALID_REQUEST insufficient tool messages` 写坏会话。
  - 所有往会话 append 用户消息的路径统一改为**等回合结束再写入**(先 `agent.whenIdle()` 等回合空闲, 60s 超时兜底), 与 QQ 插件入站排队逻辑同款, 不再跳过丢消息。
  - 覆盖: dock 群发/私聊代发、媒体代发、大文件后台任务通知、botplay 静默记录、nothink 入站记录、入群申请通知。
- **dock 聊天可连续发送多条**: 代发「记入上下文」改为**异步入队**(per-peer 队列上限 200、空即清理、whenIdle 事件驱动不空转、回合卡死时保留队列稍后重试), 请求立即返回, 不再因等待回合结束而把发送请求挂起。

## [0.9.9] - 2026-09-08

### 新增
- **权限档位切换 `/perm`**(别名 `/permission`/`/权限`): QQ 里直接切宿主 sandbox 档(只读/工作区写/全权), 支持中文参数与简写, 即时生效(经 permissionPresets 服务)。
- **人格切换 `/new <preset>` + `/presets`**: QQ 里按会话 fork 开新档切换 preset(会话级记住, 重启恢复), 旧会话存档可回看。
- **botplay Phase2**:
  - `jump_url` 跳转按钮落地(官方 action.type=0, dock 填 URL 即发跳转卡)。
  - **指令型按钮** `command`: 点击后 host 直接执行斜杠命令(不经 AI 文本), dock 行为选「执行命令」填命令名即可。
  - `/botplay` 无参改为**事件目录卡**: 每页最多 4 事件按钮(点击直接触发)+ 上一页/下一页翻页, 免打字。
  - **事件快照版本化**: 发卡时固化按钮/权限, 配置热改不影响已发卡; 过期卡 60s 自动清理。
- 审批卡片直接印验证码(不再只提示不给码; /approve CODE 放行保留)。

### 修复
- /bot-new 假实现: 与 /bot-reset 相同(只 remove)→ 重构为真 fork(旧会话存档可回看)。
- cwd 配置变更生效(上游 issue #43): 会话级 cwd 指纹; 活跃会话变更时 fork 热迁移继承历史。

## [0.9.8] - 2026-09-08

### 新增
- **用户扩展注册表(Phase 4)**: 用户/AI 可在账号 cwd 的 `.qqbot-extensions/` 写自定义内容, 升级插件不覆盖:
  - `.qqbot-extensions/commands/` → 自定义**斜杠命令**(重启后生效, `/hello` 示例)
  - `.qqbot-extensions/tools/` → 自定义 **QQ 通道工具**(AI 可调; `/tools-reload` 或 AI 调 `tools_reload` 热刷即可用, `roll_dice` 示例)
- AI 工具 `tools_reload`: AI 写完扩展工具后可自助热刷注册(等价 `/tools-reload`, 不再依赖主人手发)。
- `/bot-restart` 自动带 `--no-open`: 重启不再弹 web 浏览器标签页。
- README/README_EN 新增「用户扩展」教程(含给 AI 的书写要点)。

### 修复
- 扩展加载 Windows 路径转 file:// URL(直接 import 绝对路径失败)。
- 扩展工具入参 schema 可选参数不能带 `required:false`(dsh defineTool 规范), 文档已注明。
- 扩展工具注册 cwd 解析加全局桥兜底(热刷路径 agent ctx 可能无 qqChannel)。

## [0.9.7] - 2026-09-08

### 新增
- **botplay 互动事件装配器(Phase 1 MVP)**: dock 悬浮球新增「🎮 互动事件」页, 可视化装配"事件+按钮+行为+LLM影响三档", 保存即热更; QQ 群用 `/botplay` 列出事件、`/botplay 事件名` 触发发卡。
  - 按钮行为: reply_text(点击后 bot 直接回指定文本, 不打扰 AI) / jump_url(预留) / callback(仅结算)。
  - LLM 三档: `no_append`(纯 bot 行为 AI 不知情) / `append_silent`(记进上下文不唤醒, 下条真人消息 AI 自然看到) / `append_wake`(记录并唤醒 AI 立刻回应)。
  - 事件级防刷: maxClicks(总点击次数) + expireSec(有效期); 权限: all / triggerer(仅触发者本人) / owner / users。
  - 内置演示事件: 「签到」(no_append)与「今日运势」(append_wake, 点击后唤醒 AI 并带点击人昵称)。
  - 交互回调点击人身份注入: 从聊天台账反查昵称(群成员/私聊对象表), 唤醒文本带「昵称(openid)」。
  - 修复: 宿主重启后点击按钮无反应(会话 record 不在内存, 静默 miss)→ append 前自动 getOrCreate 恢复会话; interaction 回调加落盘诊断日志(~/.dsh/botplay-diag.log)。
- `/bot-restart` 命令: 通用自重启 dsh 宿主(动态识别 node/启动参数, 杀旧+自动拉起, 约4秒)。

### 变更
- `outbound_mode` 工具切换成功后 bot 直发确认消息(绕过出站路由, 即使切到 silent/被动主人也能收到切换通知)。

## [0.9.6] - 2026-09-07

### 修复
- 系统时间提示只加在「LLM 回合中 defer 攒批」的聚合: debounce 窗口记 turnDeferred, 仅因回合忙(turnActive)被 defer 过的窗口派发时才带 aggregated 提示; 原版等用户连发完综合回的普通聚合不再误加提示。

## [0.9.5] - 2026-09-07

### 变更
- nothink(完全不思考)语义修正: QQ 入站不再直接吞掉, 而是组装成完整上下文以 user/message append 进会话(不唤醒 LLM); 下次 web/真人唤醒时 AI 能看到完整聊天记录。
- 回合中消息聚合(主人定): LLM 回合进行中(record.turnActive)QQ 新消息全部攒进 debounce 窗口不派发, turn/end 后整批按时间序入站一次(60s 超时兜底防卡死)——避免每条消息各触发一次思考浪费 token。
- 聚合投递带系统提示: 标注这些消息发生在 AI 上一次回复之前(思考/输出期间群友所发, 非对 AI 回复的回应), 防止 dsh 队列特性让 AI 误判消息时间顺序。
- /outmode 切换后 append 模拟用户消息(不唤醒)通知 AI 模式变更; nothink 时斜杠命令放行(逃生通道)。

## [0.9.4] - 2026-09-07

### 变更
- 出站模式扩为四档: adaptive 适配主动(默认) / passive 被动 / silent 完全不出站(照常思考但不发) / nothink 完全不思考(QQ入站不唤醒LLM, 消息仅记录, web对话仍可见群聊上下文)。
- 安全边界: nothink 仅设置页可配(AI 工具禁止自切防锁死); 新增 /outmode 斜杠命令(SDK直通不经LLM)可随时切换/唤醒。
- 新增 AI 工具 outbound_mode: AI 自己可切 adaptive/passive/silent, 热更新并同步 dock/设置面板(settings 持久化)。
- 修复: dock ⚙️出站页保存 revision 冲突(保存前重读最新版本+冲突自动重试); 设置页 load/patch/回填支持 silent/nothink 不丢字段。

## [0.9.3] - 2026-09-07

### 变更
- 出站方式改「适配主动」(默认): 收到真人消息后5分钟内、对同一条消息前5次回复带引用(被动), 第6条起自动转主动(去msg_id,防QQ回复上限吞连发); 无近期真人消息(定时/后台/代发)直接主动。旧 active 值自动归一为 adaptive。
- 设置①区与悬浮球 dock 新增「⚙️ 出站」页: 适配主动/被动 一键切换, 保存即热更新(无需重启)。
- 修复: 设置面板此前未真正读写 outboundMode(保存会丢), 现 load/patch/回填三处补齐。

## [0.9.2] - 2026-09-07

### 新功能
- 设置①区新增「出站方式」开关: 主动(不带回复 msg_id, 连发不受限, 默认) / 被动(带 msg_id 回复); 保存即时热更。

## [0.9.1] - 2026-09-07

### 修复
- text_break 连发只显示前 4~5 条的根因: 同一回合多条回复都带同一 msg_id(回复同一消息), QQ 对回复同一条消息限次数 → 群回合第 2 条起自动去掉 msg_id 转主动发送(同面板), 首条仍被动回复。

## [0.9.0] - 2026-09-07

### 修复
- 出站文本分块之间加 500ms 限速(QQ 同会话极短时间连发多条会被吞/乱序); 配合 0.8.9 纯文本降级, 连发消息 QQ 端更稳。

## [0.8.9] - 2026-09-07

### 优化
- 出站消息纯文本降级: 内容无 markdown 语法/@标签 → 走纯文本通道(msg_type:0), 避开富媒体频控; 含样式/@提及仍用 markdown。

## [0.8.8] - 2026-09-07

### 修复
- / 真正打断: 直接 cancel 当前 peer 活跃回合(此前只消费消息不停止生成)。

## [0.8.7] - 2026-09-07

### 修复
- 斜杠命令层前移到群冷却之前: 冷却窗口内的命令不再被吞(延迟聚合对 / 命令本就直放行); bot-stop 放行后直达 concurrencyGuard 打断链路。

## [0.8.6] - 2026-09-07

### 修复
- 群聊斜杠命令不再要求 @bot(SDK 硬限制导致直发 /cmd 变文本): 自定义前置解析, 群内直接  等即可执行; stop/bot-stop 保留原打断链路。

## [0.8.5] - 2026-09-07

### 更新
- QQ 会话命令支持  简写(与  同功能: 查看/切换模型)。

## [0.8.4] - 2026-09-07

### 更新
- 注入上下文写清: 提问卡片可在 question/header 里直接写 <@openid> 显式指定作答人(任意 AI 按此写法即生效)。

## [0.8.3] - 2026-09-07

### 更新
- 提问卡片支持在 header/question 文本里直接写 <@openid> 显式指定作答人(优先级高于历史消息点名解析)。

## [0.8.2] - 2026-09-07

### 更新
- 注入上下文写清提问卡片「可指定作答人」: 点名(<@对方openid>)即绑定被问者权限, 不点名默认给当前对话者。

## [0.8.1] - 2026-09-07

### 修复
- QQ 提问卡片权限绑定被问者: 解析最近真人消息的被点名者/发送者, 群友点按钮不再提示无权限操作。

## [0.8.0] - 2026-09-07

### 新功能
- **悬浮球 💬 聊天视图(dock)**: 选群/私聊看与机器人的 QQ 会话记录——QQ 风格气泡(头像/群友左白/bot 右蓝)、图片/视频/文件/语音消息分别渲染(图可放大灯箱、视频可播、文件卡片可下载、语音带播放条), 上滚分页加载更早, 剥注入/工具/历史打包噪音, 群延迟打包自动拆成多条。
- **聊天与发送合一**: dock 聊天窗底部内置输入栏; bbcode [MEDIA:图片|路径/链接] 支持本机路径与网络图/文件, 📷插图/📎文件按钮与拖拽/粘贴自动包裹; 发送可写「用户代发」上下文; 发送中防连点+进度反馈。
- **本机媒体直看直听**: 粘贴本机绝对路径图/音频/视频在 dock 直接预览; QQ SILK 语音纯 JS(silk-wasm+lamejs)转 mp3 播放, 零系统依赖。
- **大文件发送**: dock 文件选择流式上传(≤300MB)+ 本地 ≥5MB 自动后台分片发送, 完成写回后台任务通知; 机器人侧大文件同样后台化。
- **预设人格编辑器**: Web 设置②区 ✏️ 人格按钮, 浏览/编辑已开账号预设文件(presets/files API)。

### 修复
- dock 放大图后不再误收起面板; 展开态可拖面板(双击头部复位); 新增全屏按钮(⛶, 上下栏固定仅消息滚动)。
- QQ 消息解码: 图片/语音/视频/文件按扩展名与上下文归类渲染, 重复 URL 取最精确类型; 系统注入/历史标记过滤。

## [0.7.0] - 2026-09-06

### 新功能
- 悬浮球用户代发可写模拟用户消息上下文(「用户代你发送」, 不唤醒不开回合); 回合活跃安全闸+会话自动恢复。
- QQ 远程提问按钮卡片(ask_user_question); 远程审批 Web 双通道结算。
- 设置面板: appSecret 掩码回显+空值保留; 账号页工作区选择器。

## [0.6.0] - 2026-09-06

### 新功能
- 悬浮球 dock 群管理台: 以机器人发消息(群/私聊)/入群申请审批/禁言/登记群; 入群申请红点轮询。
- 群管理后台: 入群申请事件实时订阅+待办落盘、禁言回读验证、群成员本地台账; 官方能力门控提示。

## [0.5.0] - 2026-09-05

### 新功能
- **延迟聚合回复**：解决"用户连发 N 句、机器人只回第一句"——收到消息后先攒一小会儿（默认：说话者停口 3 秒，或窗口攒满 10 条），把连发的内容按顺序合并成一次综合回复；与原有群冷却互不冲突（普通消息的防刷屏节奏保留，@ 消息可即时触发）。
- **逐条发送工具 `text_break`**：想逐字/逐句说话或把长话拆成多条连发时，把内容拆成文本块、块间调用它即可——对方会看到一条条蹦出来的消息。零查询、近零 token 消耗。注意：单轮最多 5 条，超出会被 QQ 平台拦截。
- **可配置**：延迟聚合总开关、静默秒数、攒条上限、@ 是否也走延迟，均可在 Web 设置面板「① 多久回一次消息」里调整，保存即时生效（live 热更）。

### 体验优化
- **修复快速连发时的消息顺序错乱**：消息处理严格按 QQ 官方推送顺序串行进行；聚合回复里的历史消息统一按服务器时间戳排序，不再出现"先发的反而排在后面"。
- **长连发消息不再丢失**：被群冷却压住的消息会继续累计，冷却结束后整批按真实顺序补上，AI 一次看到完整上下文。
- 窗口内被 @ 的消息会在上下文中带 `(@you)` 标注，AI 不会漏掉点名（是否回复仍由 AI 按自身守则判断，插件保持通用）。

### 内部
- 入站消息链加入"串行闸"，规避 SDK 并发派发导致的处理顺序抖动。
- 延迟聚合与群冷却融合为同一套状态机（窗口保留续攒 + 冷却到点整批派发）。
- 官方 api-v2 文档本地镜像（191 页），开发查字段无需翻网页。

## [0.4.0] - 2026-08-16

### 新功能

- **扫码链接**：二维码显示异常时，可直接点击终端输出的链接，在浏览器中完成扫码。

### 体验优化

- 支持 Windows 平台自动保存扫码凭据（此前会因路径问题失效）。
- 凭据自动保存失败时，会明确引导手动配置，不再静默丢失已有配置。

### 文档

- 新增扫码示意图与升级引导。

## [0.3.0] - 2026-08-15

### 新功能

- **文件理解**：给机器人发送文件，它会自动下载并理解文件内容，支持解压、读取、分析等操作。
- **流式回复**：回复内容实时逐段显示，无需等待全部生成，体验更流畅自然。
- **过程可见**：机器人执行任务（运行命令、读写文件）时，用户可以看到它在做什么，不再是一个"黑盒"。
- **出错提示**：任务异常结束时，机器人会明确告知错误原因，不再出现"半截回复"或"毫无反应"。

### 体验优化

- 群聊中正确显示发言者昵称，不再显示一串看不懂的字符。
- 群聊回复后自动清理历史上下文，避免多轮对话相互干扰。
- 语音消息识别后只保留文字，不再附带无效链接。
- 机器人现在会"真正动手"了：面对「下载、解压、安装」这类请求，会用工具实际执行，而不是只复述操作步骤。

### 问题修复

- 修复机器人无法读写文件的问题（此前工作目录配置错误）。
- 修复流式回复中可能出现的重复内容、分片过少等显示问题。

## [0.1.0] - 2026-08-14

### 新功能

- **首个版本**：QQ 机器人接入 AI 助手，支持私聊与群聊对话。
- **模型切换**：支持切换不同的 AI 模型。
- **常用指令**：内置帮助、状态查询、会话管理等指令。
- **扫码绑定**：首次使用扫码即可完成机器人绑定，配置简单。

### 问题修复

- 修复配置解析问题。



