# 上游分支研究（第二轮·增量）：`gosomea/dsh-qqbot` @ `codex/qq-inbound-delivery`

> **原文来源**：<https://github.com/gosomea/dsh-qqbot/tree/codex/qq-inbound-delivery>
> **原作者**：[@gosomea](https://github.com/gosomea)
> **上游归属**：fork 自 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)（腾讯官方）
> **本文整理**：鲸鱼娘（zaofan） · 2026-11-24
> **第一轮报告**：`upstream-gosomea-inbound-delivery-研究笔记.md`（2026-11-14，覆盖到 11-14）
> **本轮范围**：**2026-11-14 → 11-20 的 33 个增量提交**
> **说明**：代码与注释均引自原作者仓库，版权归原作者；此处仅作技术研读记录。

---

## 一、基线变了：上游把我们上次当"他们的改动"吸收了大半

第一轮报告写的是「领先上游 50 个提交」。这次重新拉基线，情况变了：

| 项 | 11-14 时 | 2026-11-24 重算 |
|---|---|---|
| 上游 `tencent-connect/dsh-qqbot` @ main | 停在 11-08 | **已更新到 11-21** |
| gosomea 分支领先 | 50 提交 | **78 提交** |
| gosomea 分支落后 | 0 | **4 提交** |

**关键变化**：`505b64e fix(session): report archived sessions and add /unarchive` 这个提交，第一轮报告当成"他们的改动"记了下来，**现在上游 main 上也有同一个 SHA** —— 说明 gosomea 的部分提交被上游合了回去。

> ⚠️ 所以读第一轮报告时要注意：里面有一部分"他们的设计"其实现在是**上游共有**的，不能再算作差异化优势。

**上游这 4 个落后提交**（gosomea 还没合）：

| 提交 | 内容 |
|---|---|
| `63abb82` | feat(settings): 显示插件版本 |
| `572e406` | feat(settings): 拆分 config RPC 端点、provider/model 合并成一个字段 |
| `bd3040b` | feat(inbound): **messageHandlingMode — queue vs interrupt (steer)** |
| `c645d56` | fix(session): 报告被其他 writer 占用的会话 + 失败文案改成人话 |

其中 **`bd3040b`（queue vs interrupt）** 值得单独关注 —— 那是"消息来了是排队还是插话"的开关，和我们 `reply_gate` / 插话模式那块直接相关。

---

## 二、增量概览：33 提交 / 262 文件 / +34,975 −8,668

### 按改动量排（前 12）

| 文件 | 增 | 删 | 是什么 |
|---|---:|---:|---|
| `plugins/workbench-history/lib/client.js` | +12,292 | −294 | **新增独立插件**：消息历史视图 |
| `lib/client.js` | +4,048 | −2,298 | Workbench 前端主体（编译产物） |
| `tests/e2e/workbench-browser.mjs` | +802 | 0 | 浏览器 e2e 回放 |
| `src/client/workbench-conversations.ts` | +560 | 0 | 会话列表前端 |
| `src/client/qq-locale.ts` | +559 | 0 | QQ 侧文案（多语言） |
| `src/client/workbench.module.css` | +486 | 0 | 样式 |
| `tests/e2e/access-delivery-host.mjs` | +395 | 0 | 权限+投递 e2e |
| `tests/e2e/upgrade-055.mjs` | +388 | 0 | 0.5.5 升级 e2e |
| `src/session/session-manager.test.ts` | +310 | −10 | 会话管理器测试 |
| `src/runtime/robot-runtimes.ts` | +281 | −72 | 多机器人运行时 |
| `src/client/prompt-editor.ts` | +274 | 0 | prompt 编辑器前端 |
| `src/prompt/file.ts` | +256 | 0 | prompt 落文件 |

### 主题归类（33 个提交）

| 主题 | 提交数 | 代表提交 |
|---|---|---|
| **工具权限/撤权** | 4 | `6a2e50d`、`6e3e143`、`8c7c163`、`0784d68` |
| **Workbench 前端** | 12 | `4e067ae`（历史渲染 MD/媒体）、`aee5e2f`（气泡适配）、`527532c`、`b076c21` |
| **prompt 文件化** | 3 | `7de73d8`、`34d67af`、`07133e0` |
| **消息保留期** | 1 | `4f089c3` |
| **兼容/升级** | 4 | `cba2495`（dsh 0.2.2）、`8c7c163`（0.5.5）、`e3a3371`（upstream RPC） |
| **会话归档** | 2 | `505b64e`（**已被上游吸收**）、`903346c`（reconcile） |
| **其它修复** | 7 | `3390d7b`（群名刷新）、`0f168b3`（工具结果渲染）、`3d15e73`（队列变更保留上下文） |

---

## 三、五个值得深读的设计

### 1. 工具权限的「双重栅栏」—— 本轮最有价值的一条

这是两个提交配合出来的机制，比我们现在的做法严密得多。

#### ① `6a2e50d`：撤权要**穿过** agent 派发

> 提交信息原文：`Apply the conversation allowlist to live and restored descendants, and cancel pending work after a successful revocation while keeping queued inputs.`

三件事：

1. **allowlist 不只作用在当前会话**，还作用到 **live 后代 + 恢复出来的后代**
2. 撤权成功后 **cancel 掉正在进行的工作**
3. 但 **保留排队输入**（`keepInbox`）

```js
// lib/runtime/workbench-tools.js（+120 行改动）
await this.toolPolicies.restoreLive();
// 撤权时：
agent.cancel({ kind: 'user' }, { keepInbox: true });
```

#### ② `6e3e143`：监听 **DSH 原生**权限事件，超权立即同步取消

这是更狠的一层 —— 不光管 QQ 侧的撤权，还盯 **DSH 自己的权限变化**：

```js
// lib/runtime/workbench-tools.js
const nativePermissionEvents = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);

lifecycle.on('session/event', (session, event) => {
  if (!nativePermissionEvents.has(event.type)) return;
  const agent = this.agents.get(session.id);
  if (agent?.session !== session || agent.status !== 'running') return;
  if (this.installed.get(agent)?.withinNativeCap() === false) {
    // Cancel synchronously so work already past the guard cannot start.
    agent.cancel({ kind: 'user' }, { keepInbox: true });
  }
}, { global: true });
```

**为什么这么写**（注释自己说了）：`Cancel synchronously so work already past the guard cannot start.`
—— 权限检查通过之后、工具真正执行之前有个窗口，如果只是"下次检查时拦"，那已经过了守卫的工作会照跑。**同步 cancel 才能堵住这个窗口**。

**对我们的启示**（我们现在的问题）：

| 维度 | 他们 | 我们（`zaofan-make/dsh-qqbot`） |
|---|---|---|
| 工具可见性 | 会话 allowlist + 原生权限双重 | `enabled(env)` 条件可见性（只在注册时判一次） |
| 权限变更响应 | 监听 `permission/preset` / `sandbox/mode` / `approval/policy`，**超权立即同步 cancel** | **没有** —— 权限改了，正在跑的回合不会被打断 |
| 撤权范围 | 当前 + live 后代 + 恢复的后代 | 只看当前会话 |
| cancel 语义 | `{kind:'user'}, {keepInbox:true}` | `reply_gate` 用 `{kind:'hook'}`, `{keepInbox:true}`；闲置回收用 `{kind:'user'}` |

**最值得抄的一条**：`withinNativeCap()` + 事件监听 + 同步 cancel 这个组合。我们现在是"注册时判一次可见性"，一旦运行中权限收紧，那个工具仍然在跑 —— 这是**真实的越权窗口**。

### 2. 斜杠命令权限统一（`0784d68`）

```
旧配置省略 `access.commandMode` 时，斜杠命令默认采用「所有人」。
获准接入的发送者适用相同的命令授权规则。
可以在「斜杠命令」中选择独立的命令白名单或关闭。
```

- 新增 `access.commandMode` 三档：`open`（所有人）/ `allowlist`（白名单）/ 关闭
- **向后兼容**：旧配置没这个字段时默认 `open`
- 前端 `config-panel.ts` 加了一个 `SegmentedRow`，选 `allowlist` 时才显示配对面板
- 配套测试 `settings-recovery.test.ts` 明确断言"三个模式都显示，但默认值不会被自动提交"

**对我们的启示**：我们的斜杠命令权限散在各个命令里（`ownerOnlyAuth` 之类），没有统一的"命令准入"层。这条不算紧急，但**"旧配置默认 open + 显式选择才收紧"**这个兼容策略值得记。

### 3. 消息保留期 + **回退脚本**（`4f089c3`）

支持自定义保留天数（不再只有 7 天 / 30 天 / 长期）。

最有意思的是**回退设计**（TESTING.md 原文）：

> 保存自定义天数后，仍只识别 7 天、30 天、长期保留和暂停记录的旧包会拒绝读取设置。回退时先停止使用该数据目录的 Host，再用新版包中附带的脚本转换。脚本把自定义项转为长期保留，并将转换前的设置原样备份到指定的新文件。

```bash
node /absolute/new-qqbot/scripts/prepare-retention-rollback.mjs \
  /absolute/qqbot-data/conversation-settings.json /absolute/new-backup.json
```

**思路值得学**：新版本引入了旧版本读不懂的配置值时，**主动提供降级脚本**（把新值转成旧版本能懂的值 + 备份原文件），而不是等用户降级后发现配置读不了。

我们目前没做消息保留期（只有 `historyLimit` 群历史缓冲条数，默认 10），但如果以后加类似"新配置项旧版本读不懂"的功能，这个回退脚本模式可以直接套。

### 4. Workbench 前端大改（12 个提交）

这块是纯前端，和我们的定位不同（我们用设置页 + dock，他们自建 Workbench）。但有三个点技术上可参考：

1. **消息历史渲染 Markdown + 媒体**（`4e067ae`）—— 历史视图里也走 markdown 渲染 + 图片气泡
2. **气泡按图片比例适配**（`aee5e2f`）—— 图片消息不再固定高度
3. **工具结果从 dsh 的扁平 content blocks 渲染**（`0f168b3`）—— 这个和我们 `tool-presenter.ts` 是同一类问题

### 5. 兼容性策略（4 个提交）

- `cba2495`：**兼容 dsh 0.2.2** —— 用"前向兼容的 client build contract"，不锁死宿主版本
- `8c7c163`：**保留 0.5.5 的 access** —— 升级时不丢权限配置
- `e3a3371`：merge upstream QQBot RPC 后**保留 workbench 行为**

**共同点**：每次合上游都单独做一次"行为对账"提交（`Merge upstream ... and reconcile ...`）。我们合上游时通常直接 merge，不做对账 —— 这是**流程上的差距**，值得学。

---

## 四、对我们（`zaofan-make/dsh-qqbot`）的具体启示

按"值不值得做"排序：

| # | 事项 | 价值 | 成本 |
|---|---|---|---|
| 1 | **权限变更时同步 cancel**（`6e3e143`） | ★★★ 堵真实越权窗口 | 中（要监听 3 类事件 + 判 withinNativeCap） |
| 2 | **撤权穿透到后代会话**（`6a2e50d`） | ★★ 我们只看当前会话 | 中 |
| 3 | **合上游后做"行为对账"提交** | ★★ 流程改进，零代码 | 低 |
| 4 | **新配置项配回退脚本** | ★ 未来加功能时套用 | 低（届时） |
| 5 | 斜杠命令统一准入层 | ★ 我们有 `ownerOnlyAuth` 散在各处 | 中 |
| 6 | Workbench 前端 | ✗ 定位不同，不跟 | — |

**不建议照搬**：
- `plugins/workbench-history`（12,292 行前端）—— 我们没 Workbench
- 形式化测试套（第一轮报告已判过，单人维护性价比低）

**要警惕的**：他们的 `cancel({kind:'user'}, {keepInbox:true})` 用在"撤权"场景。我们今天刚在 `reply_gate` 里把 `kind:'user'` 改成 `kind:'hook'`，因为 `'user'` 会让 UI 显示"已停止"、还会让后续消息被标"插话"。**他们这里是"撤权"，语义上确实接近"用户主动打断"，用 `'user'` 合理**；但如果我们照抄，要确认那个场景下 UI 表现是可接受的。

---

## 五、上游那 4 个落后提交里，最该看的是 `bd3040b`

```
feat(inbound): add messageHandlingMode — queue vs interrupt (steer)
```

"消息来了是**排队**还是**插话**"的开关。

这正好是我们今天早上折腾的那块（`reply_gate` 的 cancel 语义、插话模式串台）。**上游已经把它做成一个正式配置项了** —— 建议下次合上游时重点看这个提交的实现，可能能把我们手写的插话逻辑替换掉。

---

## 六、参考链接

- 分支：<https://github.com/gosomea/dsh-qqbot/tree/codex/qq-inbound-delivery>
- 上游：<https://github.com/tencent-connect/dsh-qqbot>
- 第一轮报告：`docs/upstream-studies/upstream-gosomea-inbound-delivery-研究笔记.md`
- 关键提交：
  - <https://github.com/gosomea/dsh-qqbot/commit/6e3e143> 权限变更同步 cancel
  - <https://github.com/gosomea/dsh-qqbot/commit/6a2e50d> 撤权穿透后代
  - <https://github.com/gosomea/dsh-qqbot/commit/0784d68> 斜杠命令权限统一
  - <https://github.com/gosomea/dsh-qqbot/commit/4f089c3> 消息保留期 + 回退脚本
  - <https://github.com/tencent-connect/dsh-qqbot/commit/bd3040b> queue vs interrupt（上游新）
