# dsh-qqbot 开发与维护手册(唯一主文档)

> **现状一句话**:本项目已发布为**单包开源版 `@zaofan/dsh-qqbot` v0.4.0** →
> https://github.com/zaofan-make/dsh-qqbot(Public,README 双语)。
> 历史方案/实测/交接长文一律归档在 `_md-archive/`,本文是唯一维护入口;改完代码按 §3 流程走。
> ⚠️ **2026-10-04 注**：上面那个 `v0.4.0` **早已过时**，别引用 —— 当前开发目录 `package.json` 是 **1.6.5**，而线上 profile 的 `node_modules` 实装 **1.6.4**（profile 声明 1.6.5、lockfile 钉 1.6.4 —— 即 §6 那条"文件真相 vs pnpm 真相"的现例）。版本沿革看 §11.18 / §11.23 与 CHANGELOG。
> **2026-09-07 功能演进总档**:`dsh-qqbot-2026-09-07-悬浮球与功能增强.md`(本目录)——悬浮球UI升级/账号折叠/在线绿点/QQ工具会话级永久挂载/预设人格编辑器/大文件分片后台发送/QQ菜单面板host代理/chat-ledger台账去重/踩坑速查。

---

## 0. 目录地图(先搞清谁是谁)

| 目录/文件 | 角色 |
|---|---|
| `m1/dsh-qqbot-public - 副本/` | **发布真源·开发目录**(改这里;已 git 关联 GitHub) |
| `m1/dsh-qqbot-0.4.0/` | 官方上游基线 **勿改**(@tencent-connect 原版) |
| `m1/dsh-qqbot-settings-public/` | 旧设置独立包(已单包并入主包,仅备份) |
| 线上运行 | `~/.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot`(web profile 装配) |
| `_md-archive/` | 全部历史 md(方案/实测/交接),查细节去这里 |

**单包双面结构**(参照 dsh-better-sidebar 生态标准):
- host 半边:`src/`(TS→`dist/`)+ 包根 `settings-host.js`(设置面板后端桥,原独立包合并)
- client 半边:`client/qqbot-settings.js`(设置页 UI,手写 __ModuleLoader__ bundle,`load id='@zaofan/dsh-qqbot'`)
- `package.json`:`exports["./client"]` + `dsh.client={platform:"web",inject:[]}` + `files` 白名单
- `cordis.patch.yml`:只 insert 自己(`im-qqbot`,`name:'@zaofan/dsh-qqbot'`),**自指、不引用宿主可选插件**
- 设置桥装载:主插件 `src/index.ts` apply 内 `new URL('../settings-host.js', import.meta.url)` 动态 import + `ctx.plugin()`(web 无 settings/webServer 服务时 fail-soft 跳过)

---

## 1. 插件开发关键点(踩坑沉淀,新改动必读)

### 安装三定律
1. **目标 profile 必须是 `web`**(设置面板宿主);`add @tencent-connect/dsh-qqbot`=上游无增强版,别用。
2. **绝不 `add` 源码目录**:①Windows 路径含空格→参数被劈(坑2);②add 目录=pnpm link(junction)→插件按代码位置反推 profile 失败→**扫码凭据落不了盘**(坑3)。
3. **正解=tarball**:`pnpm pack` → `dsh plugin --profile web add <tgz>`;Windows 一键已封装 `install.ps1`(自动 pnpm install+build→pack→add)。

### 七坑速查(细节见 `_md-archive/dsh-qqbot安装实测_踩坑与插件改进建议.md`)
| # | 坑 | 规避 |
|---|---|---|
| 1 | install.sh 包名/profile 过时 | 已废弃(指向 install.ps1) |
| 2 | add 目录空格拆参 | 打 tarball |
| 3 | link 安装→profile 定位失败→凭据不落盘 | tarball 实体安装 + 稳健 getProfileDir(§2) |
| 4 | remove 残留 junction,再 add EPERM | `install.ps1 -Clean` 先清 `node_modules/@zaofan/dsh-qqbot` |
| 5 | **npm install 装 pnpm 仓库→ERESOLVE 必崩** | **必须 `pnpm install`**(install.ps1 已改) |
| 6 | ExecutionPolicy Restricted 拦 pnpm.ps1/dsh.ps1 | 脚本内走 `pnpm.cmd`/`dsh.cmd` |
| 7 | profile patch 残留失效条目→每次启动刷警告 | patch 保持自指;装前检查 `cordis.patch.yml` 失效 id |

### 凭据/profile 设计铁律(建议 A,已实现)
- profile 定位探测链(`src/shared/utils.ts getProfileDir`,settings-host.js 同款):
  ① `QQBOT_PROFILE_DIR` 环境变量 → ② 扫 `~/.dsh/profiles/*` 找装着本插件的 profile
  (node_modules/<scope>/<pkg> 存在 或 package.json bundles/deps 含包名)→ ③ 代码位置兜底。
- 「面板能改、保存即生效」不得依赖安装形态(实体/link 都能落盘)。

### 新铁律(2026-09-13 起实战沉淀, 每条都踩过；第 8 条 2026-10-04 加)
| # | 铁律 | 反例与代价 |
|---|---|---|
| 1 | **拦截类逻辑禁止 fail-open**: "不唤醒/不发送/不落盘"这种判定, 结论要**先定死**, 副动作(append/写文件)只是尽力而为 | 价值评分拦截原把 `return` 写在 `if (会话可 append)` **里面** → append 能力缺失就悄悄往下走**照旧唤醒** = 默认放行(实测"0.17 分那条真回话了") |
| 2 | **设置项必须进 `installLiveSettings` 两处**(`entry` 注册值 + `sync()` 应用), 否则"面板保存了却不生效, 要重启" | `localModel` 漏了 → 改 `block` 后记录里 `gate` 还是 `log`, 排查半天以为是闸门坏了 |
| 3 | **拦截/判定类功能要留下"可判定"的记录**: 记下**当时生效的模式**(如 `gate`)与关键中间量 | 评分记录以前只记 `min`, 分不出 `log`/`block`, 无法判断"是她没被拦"还是"根本没进分支" |
| 4 | **热路径日志一律 debug**: 每条消息/每张图都打的日志(Processing/followup/debounce flush/采集/评分)用 `logger.debug`; 诊断 `console.log` 收进 `DSH_QQBOT_DEBUG=1` 开关 | 用户控制台被刷屏, 还白花 IO |
| 5 | **"没做成就别消耗资源"**: 冷却/配额这类"限流额度"要与**真实产出**绑定(冷却=省 token → 没唤醒就回滚); 反之"已经花了成本"(唤醒了 LLM)就该消耗 | 一条低分闲聊白吃 90 秒群冷却, 后面该回的消息被压 |
| 6 | **前端展示别依赖"要重启才对的 host 字段"**: 能直读配置就直读(如 `state.lmCfg` 走 `/read`), 且保存成功后**立刻回填本地缓存再重绘** | 2026-09-13 的 `valueGate`、2026-09-15 的 `attachmentPassthrough` 各踩一次: 面板显示"没保存", 其实配置早写对了 |
| 7 | **AI 自己的输出要守会话体积**: 大文件先 grep 定位再局部读; 长命令输出必须带上限; 单会话别连续干几百轮 | 2026-09-15 `dsh web` 因会话解压后 **31.7 MB** 撞 V8 老生代 4 GB 上限 → `FATAL ERROR: Reached heap limit`, 进程(含 QQ 机器人)一起没了。详见 `dsh-qqbot-会话体积与OOM诊断_20260915.md` |
| 8 | **动态挂载能力一律"幂等刷新"**: 钩子里每次先**撤销上次注册的**、再按当前开关重建; disposer 存 `WeakMap`(跨模块实例可见), **绝不存模块级变量** | 2026-10-02 `context_*` 三个工具曾写"注册过就跳过" → agent 重建后旧注册作废、缓存还记着"注册过" ⇒ **该会话永久挂不上**(症状: 日志显示 `syncTools` 在跑、工具表里却没有)。同批还踩了 `agent/pre-step` **每个 step 都触发**(不是每回合) → 一轮连压三次上下文; 详见 `dsh插件开发总参考_20261011.md` §9.5。**2026-10-10 细化**：改为「**注册不动 ＋ 按会话实时剪枝**」—— 全局注册一次（必须用**插件根 ctx** 的 `ctx.get('tools')`；apply 的 inject 列表里没有 `tools`，裸读 `ctx.tools` 会被宿主拒），永不注销、幂等句柄存 `globalThis`；可见性交给 **per-scope** `ctx.tools.restrict({ deny })`（它只过滤"继承来的"工具 ⇒ 用 `agentCtx` 注册会剪空）。开关下一回合生效、状态没变零动作。详见 §4.5 与 CHANGELOG 1.7.9 |
| 9 | **"报错"是设计的一部分时，必须在工具说明(description)里写明**：凡"失败/中止/异常"属于**有意行为**的工具（self-cancel、需要中断输出的能力），说明里必须显式写"看到 X 就是成功、收手即可、不要重试" | 2026-10-10 实测：`reply_gate(false)` 靠 `agent.cancel()` 中断输出 ⇒ 模型收到 `tool call aborted` 判成"工具坏了" ⇒ 改去切出站模式(silent) 静默，既绕远又污染后续所有回合。⚠️ 面板侧虽有 `SILENT_TOOLS`（不展示它的失败），但**模型看到的是原始工具结果** —— 缺的那句话只能写在 description 里 |
| 10 | **路径处理不许"顺手归一化"**：绝对路径**原样返回**，只给真正坏掉的形态（相对路径）动手 | 2026-10-24 1.10.28 把 `D:\a\b` 归一成 `D:/a/b`，而 `session-manager` 用 `prevCfg.cwd !== wantCwd` 做**字符串精确比较**判断"cwd 改没改" ⇒ Windows 老用户升级后每个会话首条消息都误判、白跑一次 fork 迁移。**外面随时可能拿它做字符串比较，改形式 = 改语义** |
| 11 | **修"某处写错了"必须全库搜同类模式**，不能只改被点名那一行 | #18 修了 `decodeSessionDirName()`，#19 立刻发现 `wsPathFromDir()` **把同一套解码逻辑又抄了一遍**（同一个 `settings-host.js` 里），于是同一个 bug 修了两次、多发一个版本。见下面 §跨平台自查清单 |

### 跨平台（POSIX / Win32）自查清单（2026-10-24 立，#17 #18 #19 三连踩后沉淀）

**触发时机**：任何一次"路径/平台相关"的改动，或收到"某个功能在某些系统上不对"的反馈。**动手前先跑一遍这 6 条。**

```bash
cd "m1/dsh-qqbot-public - 副本"
# ⚠️ 下面用 grep -P 的 \x5c 表示反斜杠 —— 避免 shell 里反斜杠转义叠几层数不清

# ① 双反斜杠当分隔符（join 出来的是「两个反斜杠字符」，不是分隔符）
grep -rnP "join\('\x5c\x5c'\)" src/ settings-host.js client/qqbot-settings.js

# ② 字符串里写死反斜杠（应统一走 path.join 或按平台分支）
grep -rnP "'\x5c\x5c'" src/ settings-host.js client/qqbot-settings.js

# ③ 盘符判断（/^[A-Za-z]$/）—— 必须确认它只在 Windows 分支里执行
grep -rnP "\^\[A-Za-z\]\$" src/ settings-host.js

# ④ Windows 专用命令 / 路径（Linux 上要么不存在要么是垃圾值）
grep -rnE "\.exe|taskkill|powershell|cmdkey|ProgramFiles|LOCALAPPDATA" src/ settings-host.js

# ⑤ Windows 专用环境变量（必须带 HOME 兜底）
grep -rnE "USERPROFILE|APPDATA" src/ settings-host.js

# ⑥ 路径归一化时用了 toLowerCase（⚠️ Linux 大小写敏感，会把两个不同目录当成同一个）
grep -rn "toLowerCase()" src/ settings-host.js | grep -iE "norm|path|cwd|dir"
```

**统一写法（照抄）**：

```js
// settings-host.js（纯 JS 侧）
function absCwd(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) return '';
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;          // Windows 盘符 → 原样
  if (raw.startsWith('\\') || raw.startsWith('//')) return raw;  // UNC → 原样
  if (raw.startsWith('/')) return raw;                  // POSIX → 原样
  const s = raw.replace(/\\/g, '/');
  if (process.platform !== 'win32') return '/' + s;     // 相对 → 补前导 /
  return raw;
}
```

```ts
// src/ 侧直接 import { absCwdOf } from '../util/abs-path.js'
```

**判定分隔符的正确姿势 — 看"首段是不是盘符"，别看 `process.platform`**：

```js
// ✅ dsh 的会话目录名编码：/a/b → --a-b--，D:\a\b → --D--a--b--
const segs = dir.replace(/^--|--$/g, '').split('-').filter(Boolean);
if (/^[A-Za-z]$/.test(segs[0])) return segs[0] + ':' + REST.join('\\');  // Windows
return '/' + segs.join('/');                                            // POSIX（补回丢掉的根 /）
```

⚠️ **编码时根部的 `/` 就已经丢了**（`/` 也被替换成 `-`），所以 POSIX 分支**必须自己补前导 `/`** —— 这是 #18/#19 的核心。

**本次三连踩的时间线（教训）**：

| 版本 | 修了什么 | 漏了什么 |
|---|---|---|
| 1.10.28 | `decodeSessionDirName` 按盘符分支 | `wsPathFromDir` 是同一逻辑的**第二份**，没搜 |
| 1.10.29 | `absCwdOf` 让绝对路径原样返回（修 1.10.28 引入的 cwd 指纹误判） | — |
| 1.10.30 | `wsPathFromDir` 改成转调 `decodeSessionDirName`（消灭重复） | — |

**根因不是"哪个函数写错了"，而是"同一段逻辑被抄了两遍"** —— 所以修法一律是**收敛到一份实现**，而不是两处分别打补丁。

---

## 2. 常用命令

```bash
# 构建 / 自检 / 打包(在 m1/dsh-qqbot-public - 副本)
node node_modules/typescript/lib/tsc.js -p tsconfig.json     # build (沙盒禁 npx/npm run 时直跑)
node scripts/check-package.mjs                               # 单包四项家当自检
pnpm pack --pack-destination <无空格目录>                     # 打 tarball
.\install.ps1                                                 # Windows 一键安装到 web profile
# 发布(GitHub)
git add . && git commit -m "..." && git push origin main     # 直连需 TUN;或代理 127.0.0.1:29290
git tag -a v1.4.5 -m "v1.4.5" && git push origin v1.4.5
# 发布(npm) —— 凭据在 ~/.npmrc(_authToken), prepublishOnly 会自动 build + check-package
npm publish --access public
# ⚠️ 2026-09-15 起本机 npm 12 + 账号开了 2FA → 走**暂存流**(publish 时不用 OTP, 批准时才要):
#   npm stage publish                                   # 上传到暂存区, 打印 stage id
#   npm stage list                                       # 看有哪些在等批准(含 id/版本/shasum)
#   npm stage approve <stage-id> --otp=<6位码>            # 用主人的手机令牌批准(码 30 秒过期, 拿到就跑)
#   ⚠️ 连发多个版本时**按版本先后依次批准**, latest 标签才会落在最新的那个上
# 补发老版本: 用 git worktree 拉出对应 tag 再打包(不改动主工作区):
#   git worktree add ../_v152 v1.5.2
#   cmd /c mklink /J "..\_v152\node_modules" "$PWD\node_modules"   # 软链复用依赖, 省一次 npm i
#   cd ../_v152 && npm run build && npm stage publish
#   git worktree remove ../_v152                                  # 发完清掉
# GitHub Release(没装 gh CLI 时走 API)
# ★ 2026-10-12 起：token **不再走凭据管理器(GCM)**，改读仓库外的本地文件（原委与配置见下面「GitHub 凭据」小节）
$env:GH_TOK = Get-Content "D:\newwenjianjia\aiwork\鲸鱼娘\.gh-token" -Raw
curl.exe -s --proxy http://127.0.0.1:29290 -X POST -H "Authorization: Bearer $env:GH_TOK" -H "Accept: application/vnd.github+json" `
  --data-binary "@release.json" https://api.github.com/repos/zaofan-make/dsh-qqbot/releases
# ⚠️ 国内直连 api.github.com 常被 reset / uploads 连不上 → 全部加 --proxy http://127.0.0.1:29290
# ⚠️ 2026-09-24 更新: Release **默认只写说明、不附资产**(见 §10.2)。下面这套"附 tarball"流程仅在想统计下载数时按需使用。
#   ① 取 tarball: Invoke-WebRequest https://registry.npmjs.org/@<scope>/<pkg>/-/<pkg>-<ver>.tgz -OutFile x.tgz
#   ② 取 release id: curl.exe -s --proxy $edge -H "Authorization: Bearer $env:GH_TOK" .../releases/tags/v<ver>
#   ③ 上传: curl.exe -s --proxy $edge -X POST -H "Authorization: Bearer $env:GH_TOK" `
#        -H "Content-Type: application/gzip" --data-binary "@x.tgz" `
#        "https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=x.tgz"
# 本地小模型(用户侧一键装)
node scripts/download-model.mjs    # 下 bge-small-zh-v1.5 三件套(优先 hf-mirror 镜像)
```

---

### GitHub 凭据（2026-10-12 起：绕开 GCM，改用本地 token 文件）

**背景**：仓库账号 2026-10-12 已改名为 **`zaofan-make`**（旧名含个人信息，此处不记录；Git 历史里的旧 author 属于改名前的既成事实，见已归档的凭据说明）。
Windows 上的凭据助手是 `helper-selector`（= **Git Credential Manager**），它按
**host + path + username** 索引条目 —— 旧条目里用户名还是改名前那个，于是：

- **只按 `protocol=https / host=github.com / path=<owner>/<repo>.git` 查** → 命中，**不弹窗**；
- 查询里**一旦带 `username=`**（哪怕填的是新用户名）→ 查不到 → **弹 GCM 登录窗**
  （实测被弹 2 次，全是这么来的；**排查口诀：别带 username**）。

**现方案**（`git push origin main` 直接可用、**永不弹窗**）：

| 位置 | 内容 |
|---|---|
| `D:\newwenjianjia\aiwork\鲸鱼娘\.gh-token` | 纯 token（**仓库外**，不进 git） |
| `D:\newwenjianjia\aiwork\鲸鱼娘\.git-credentials` | `https://zaofan-make:<token>@github.com` |
| 本仓库 `.git/config`（local，不推送） | 见下面两条关键配置 |

**两个必须记住的坑（2026-10-12 各踩一次，第二次真弹窗了）**

1. **`credential.helper` 是「叠加」不是「覆盖」**。本机存在 **system 级** helper：
   `"…/@dsh-ops/bash-win32-x64/ucrt64/bin/git-credential-manager.exe"`
   —— 就是 **DSH 自带的那份 GCM**（在 bash 工具的 ucrt64 里），它**永远排在 local 之前**。
   所以只写 `git config --local credential.helper "store --file=…"` **顶不掉它**、照样弹窗。
   正解：**先用空值清空继承链，再挂 store**（`.git/config` 会长成下面这样，第一条为空是关键）：
   ```ini
   [credential]
       helper =
       helper = store --file=D:/newwenjianjia/aiwork/鲸鱼娘/.git-credentials
       useHttpPath = false
   ```
2. **`credential.useHttpPath` 必须与 `.git-credentials` 的写法配套**：
   `useHttpPath=true` 时查询会**带上 path**，而只写了 host 的那行匹配不上
   ⇒ `store` 给不出凭据，报 `fatal: unable to get password from user`（不是弹窗，是直接失败）。
   要么 `useHttpPath=false`（配 host-only 那行），要么把**带 path 的行也写进去** —— **推荐两者都做**。

**外加保险**：调 git 时带上 `GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0` ——
这样万一还是被 GCM 碰到，也只会**报错退出**，不会弹登录窗打扰主人。

token 是 **fine-grained PAT**：Repository access 只勾 `zaofan-make/dsh-qqbot`，
Permissions 只需 **Contents: Read and write**（推代码 + 建 Release 都够）。

**三条纪律**：

1. **token 绝不写进仓库、绝不写进任何文档 / 示例 / 截图** —— 换 token 只改上面那两个本地文件。
2. 路径必须用 **Windows 形式**（`D:/...`）：`/d/...` 这种 MSYS 形式 `store --file=` **不认**。
3. ⚠️ 2026-10-12 那颗 PAT **发到过 QQ 群**（群成员可见）⇒ 建议定期 rotate；
   rotate 后同步更新 `.gh-token` 与 `.git-credentials` 即可，其它都不用动。

---

## 3. 发布/隐私红线(每次对外前必扫)

- **禁入仓库**:人格昵称(做早饭/鲸鱼娘/白毛红瞳/梁神)、QQ 号、群号、本机路径 `D:\newwenjianjia`、`.rar/.bak/.log`、真实凭据。
- 已知埋点(改代码时保持中性):`scheduler.ts` 伪造消息 `senderName: '主人'`(勿写真昵称);client/README 示例文案不出现真实人格名。
- 扫法:node 递归 grep 上述词(排除 node_modules/dist),零残留才可发。
- 注意:仓库 gitignore 排除 `dist/`,clone 后必须 build(install.ps1 已自动处理)。

---

## 4. 功能速览(给改动者定位)

| 功能 | 关键文件/机制 |
|---|---|
| 表情包库(自动收藏/打标/闸门) | `src/features/sticker-*` + `src/middleware/sticker-capture.ts`;通道工具 `send_media`/`list_stickers`/`sticker_tag`… 在 `src/channel-tools.ts` |
| 条件注入规则 | `src/transport/inject-rules.ts`:`enabled` 才生效;无启用 hasImage 规则时自动兜底内置文本(改内置文本在 LEGACY_IMAGE_RULE) |
| 定时唤醒 | `src/features/scheduler.ts`:伪造"主人发来"消息喂 handleInbound(与真人 @ 同链路) |
| 富媒体收发/撤回 | `[MEDIA:image\|路径]`/`[RECALL]` 解析在 transport;`recall_message` 等工具 |
| **出站方式(适配主动/详细主动)** | `outboundMode`: adaptive(默认)/detail(详细主动, 2026-09-11)/passive(v0.9.3)/silent/nothink; `transport/outbound.ts` resolveTarget 逐条决策(同一入站 msg 前5次被动→自动转主动), **detail=adaptive 发送行为 + 额外推工具调用/结果**(onToolCall 按 1.2s 窗口聚合推 `🔧 工具调用`, onToolResult 由 `shouldShowToolResults()`=showToolResults‖detail 决定); `SessionRecord.lastInboundAt` 判「最近收到」; UI=设置①区 + dock ⚙️ 出站 tab; 命令 `/outmode detail`; 热更新 |
| **QQ 远程提问(按钮 + `/答` 斜杠兜底, 2026-09-11)** | `src/features/qq-user-questions.ts`: ask_user_question → 按钮卡片(label 带 `A.`/`B.` 前缀, 正文列全选项字母表) + **文字兜底走斜杠命令** `src/commands/answer.ts`(`/答 <A\|1\|A,C\|#2 B\|你的话>`, 别名 `/ans`): 命中选项 → 选中(多选看 multiSelect), 非选项文字 → `answers[].custom` 原样透传给 AI; 多问题依次发卡、按组收齐后统一 resolve; 选项>5 时按钮只放前 5 个(正文列全 + `/答 字母` 补齐)。⚠️ **必须带斜杠**: 裸文字在群里被 `mentionGate` 拦、私聊被 `debounceLayer` 直接吞进 agent(那层自己调 transport.handleInbound, 绕过 message 处理器), 实测无效 —— 兜底因此挂在命令层(`commands/index.ts` 注册)。开关 `enableUserQuestions`(默认开)。**2026-09-24 卡片指定人支持昵称**:`<@群友昵称>` 与 `<@32位openid>` 等价 —— 昵称走本地群成员台账 `{dataRoot}/表情包/group-members.jsonl`(在群里发过言/申请过入群的人)解析;查不到或多人同名有歧义则不指定(回落默认人)。实现:`resolveCardOwner`(openid / 昵称 / 无标注时唯一昵称命中)+ `QqUserQuestionsController.ownerResolverFor` |
| **群发(agent 工具 + dock 面板双通道, 2026-09-12)** | 队列 `src/features/broadcast.ts`(状态机 draft→queued→sending→partial_failed/done, 串行逐目标+指数退避重试 3 次+2 分钟撤回窗口+落盘 `{dataRoot}/.qqbot/broadcast-tasks.json`); **agent 侧工具 `broadcast_send`**(channel-tools.ts: 默认直接发, 群名歧义才回候选; action=send\|recall\|status) + **`target_group`**(分组 list/create/rename/delete/add/remove, 与 dock「🗂 分组」共用 `{dataRoot}/.qqbot/target-groups.json`); dock 侧 UI「📤 群发 · 广播」+ host 路由 `group/broadcast/*`(create/confirm/list/cancel/recall) 与 `group/target-groups`(GET/POST)。目标解析: 群名取 `{dataRoot}/.qqbot/groups.json`, **分组名优先于群名**。⚠️ 只支持 text/markdown/card, **不发文件**(上传按群隔离+占主动配额, 资源走链接) |
| **Web 会话列表自动重排(v1.6.8, 2026-10-05)** | 宿主侧 `settings-host.js`：订阅 `session/event`(`assistant/message`) → SSE `/api/qqbot-settings/workspace/watch`(订阅集合走 **globalThis 单例 `WS_HUB`**，见 §11.24)；浏览器侧 `client/qqbot-settings.js` 的 `reorderByDom()` —— **派发原生 HTML5 拖拽**改侧边栏内存 store（**只写 localStorage 无效**，见 §11.25）；「热不热」的时间表来自 `GET …/workspace/sessions`(5s 缓存)。规则：组内从头部数「热」(置顶算热，其余 <10min)，插到其后；**碰到目标即停**(幂等)，折叠分组不参与 |
| **三套用户扩展 · 统一能力包(v1.7.0 / 1.7.1, 2026-10-06)** | `src/features/ext-capabilities.ts` 的 `makeExtCaps(deps)` —— 把「发送 / 官方 API / 持久化 / 上下文 / 身份 / **遥控器 kernel** / **自重启**」做成**同一套**，注入三处：① 自定义斜杠命令（`gateway/middleware-setup.ts:233` 的 `cmd.handler({...ctx, command, ...caps, caps})`；`setupMiddlewares` 第 5 参 `pluginCtx` 由 `bootstrap.ts:151` 传）② 扩展工具（`channel-tools.ts` 的 `env`，**只补不覆盖** + `env.caps`）③ botplay 卡片（`botplay-ext.ts` 的 `makeExtContext` deps + `botplay.ts` 注入）。⚠️ **命名差异**：工具/命令是 `env.ctx`（=遥控器），卡片是 **`ctx.kernel`**（因为卡片那个对象自己就叫 `ctx`）。服务清单见 `docs/host-services.md`；`restart()` 复用 `commands/exit.ts` 的 `selfRestart()`。详见 §11.27 |
| 多实例 | `settingsNs` 即实例 id(默认 im-qqbot=主账号);每个实例独立 cwd/图库/定时/闸门/待答提问 |
| **QQ 远程审批** | `src/features/qq-approval.ts`(QqApprovalController):订阅宿主 `approval/request` 事件,发一次性码到发起者 QQ 会话,拦截 `/approve\|/deny CODE`(中英别名);senderId+同会话双校验、超时/取消自动结算。配置 `enableApprovals`(默认关)+`approvalTimeoutMs`(config.ts)。**思路来源:wang-22-code/dsh-qqbot-bridge(文件头注明)** |
| Web 设置面板 | settings 命名空间注册 `src/index.ts installLiveSettings`;面板 UI `client/qqbot-settings.js`;后端桥 `settings-host.js`(路由 /api/qqbot-settings/*) |
| **本地小模型 / 价值评分闸门(v1.4.5)** | `src/features/local-embed.ts`(bge-small-zh-v1.5 ONNX q8 ≈23MB, 默认 `{DSH_HOME\|~/.dsh}/models/bge-small-zh`, 缺模型静默关闭) + `src/features/value-score.ts`(打分/记录/样例库) + `src/features/value-sample.ts`(样例库读写)。**闸门**在 `src/transport/inbound.ts`: 群消息先打分, 低于 `minScore`(默认 0.5)且**未被 @** 且**不带图** → 不唤醒(`ack` 走 session.append, 消息不丢); 模式 `off/log/block`, 支持**会话级覆盖** `localModel.overrides["group:<gid>"]`。记录 `{dataRoot}/.qqbot/value-scores.jsonl`(字段 score/worth/gate/min/conf/mention/img/lib/agg/top), 样例库 `value-samples.jsonl`(`{"m":"…","y":1\|0}`)。一键下载模型: `node scripts/download-model.mjs`(优先 hf-mirror, 见 README「本地小模型」章) |
| **图片入站给本地路径 + URL 台账(v1.4.5)** | `src/middleware/sticker-capture.ts` 收藏落盘后把「URL→本地路径」写进 `src/features/image-path-cache.ts`(LRU 800/TTL 1h); `inbound.ts` 预检优先**读本地盘**算哈希、`buildDynamicCtx` 图片行给本地路径(没落盘才回退 QQ 链接); 另存「图库 id → QQ 链接」台账 `src/features/image-url-ledger.ts`(`{表情包}/image-url-ledger.jsonl`, 上限 1000, 只图片)。dock 侧渲染见 `settings-host.js` 的 `chatLocalTargetOf()`(本机路径→`raw-media` 直出, 搬层后按 id 解析当前路径, 失败按 QQ 链接→`sticker-img` 兜底) |
| 视觉/OCR | 属于预设工具层(.venv rapidocr + win 双引擎),**不在本插件内** |
| **设置页 UI（配置即数据, 2026-10-10）** | `client/qqbot-settings.js`：字段全在 `FGROUPS`（同一处驱动**渲染/默认值/提交**）＋ `buildPatch()` **只提交 diff** ＋ 双搜索栏（上=精确 / 下=语义）；**改进程只改这一个文件 + 刷新浏览器**。详见 §4.5 |

---

## 4.5 UI 维护（设置页 / 悬浮球 / dock 聊天页）

> 2026-10-10 主人定：设置页走「**配置即数据**」—— Schema 驱动渲染 ＋ **只提交 diff**；
> 搜索拆两栏：**上=精确（字面）／下=模糊（语义，程序算的相似度）**。

### 4.5.1 三块 UI 分别在哪

| 界面 | 文件 | 改完要做什么 |
|---|---|---|
| 设置页「QQ 机器人」整页（左下角设置里那页） | `client/qqbot-settings.js` | **手写 `__ModuleLoader__` bundle、无构建步骤**；同步 `client/` 后 **浏览器 Ctrl+Shift+R** |
| 悬浮球 / dock 面板 / 聊天页 / botplay 卡片 | `client/qqbot-settings.js`（前端）＋ `settings-host.js`（后端桥） | 路由都在 `/api/qqbot-settings/*`（见 §4）；**动到 settings-host.js 才需要重启宿主** |
| 设置数据面（读写配置） | `settings-host.js` | `GET …/read`・`POST …/update`；update 的 patch 走 `mergeDeepOne()` **深合并** |

⚠️ `client/` **不在 tsc 编译范围**（`npm run build` 不碰它），但 `deploy.ps1` 会同步它。

### 4.5.2 铁律：新增设置项**只改一处**（`FGROUPS`）

```js
// client/qqbot-settings.js
{ k: 'behavior.freeIntervalSec', t: 'num', label: '…', def: 0, kw: '回复 间隔 频率 冷却 限速 慢 秒 群' }
```

| 键 | 说明 |
|---|---|
| `k` | 配置点分路径，**必须与主包 `src/config.ts` 的键名一致**（对不上 = 能看不能存） |
| `t` | `bool` / `num` / `str` / `area` / `radio` / `list` / `note` / `custom` |
| `label` `hint` | 文案（长说明自动折成「ⓘ 说明(点开)」） |
| `def` | 默认值，**只在渲染时回落、不写进 cfg** ⇒ diff 才是"真实改动" |
| `kw` | 语义搜索关键词（空格分隔，UI 不显示）—— **加字段必须补它**，否则搜不到 |
| `sec` | 单位换算：存 = 显示 × sec（如 `approvalTimeoutMs` 填 1000） |
| `options` | `radio` 的 `[{v,label}]` |
| `render(ctx)` | `custom` 自绘；`ctx = { cfg, set, ns }` |

三个动作全部由这一处派生：**渲染** `renderControl()`/`FieldRow`、**默认值** `fieldVal()`、**提交** `buildPatch()`。

### 4.5.3 为什么"只提交 diff"是底线

旧版同一个字段要**手写三遍**（`load()` 的 normalize、`doSave()` 的全量 patch、渲染），漏一处就是
**「面板勾了却存不下去」** —— 文件历史注释里反复出现，而且真的发生过：

> ⑥「提问卡片」的 `questionsMode` 从上线到 **v1.7.8** 一直没进过 patch（UI 能选、存不下去），
> 2026-10-10 schema 化时才被修掉。

现在 `buildPatch(cur, saved)` 只发**变了的顶层 key**；host 端是深合并 ⇒ 没碰过的字段
（含本页不编辑的 `schedule` 等）**一个字节都不会被动**。

### 4.5.4 搜索：上=精确，下=模糊（语义）

- **精确**（上栏）：字面命中 `label` / `hint` / `k`。
- **模糊·语义**（下栏）：**纯程序、零依赖、离线即时、零 token** —— 字符 bigram ＋ IDF 加权余弦；
  文档 = `label×2 ＋ kw×2 ＋ hint ＋ 键名`；命中的字段按相似度排序，行尾显示「N% 匹配」；
  显示阈值 `SEM_MIN = 0.1`。
- 实测校准样例（脚本 `_tmp/test-search2.cjs`）：`回复太慢`→回复间隔、`图刷屏`→表情包限制、
  `踢人`→群管理、`排查日志`→诊断日志、`进群申请`→入群申请提醒、`私聊回复`→私聊间隔。
- **可选升级**：插件已自带 `src/features/local-embed.ts`（bge-small-zh，23MB，模型在
  `~/.dsh/models/bge-small-zh`）。想要"真·向量语义"就在 `settings-host.js` 加
  `GET /api/qqbot-settings/search`，用 `embedQuery()` 与预计算的字段向量做余弦 —— 代价是**要重启宿主一次**；
  纯前端那套可与之并存。

### 4.5.5 改 UI 的纪律（都是踩出来的）

1. **先备份** `client/qqbot-settings.js.bak-*` —— 设置页是主人天天用的界面，出事要能一条 `git checkout` 回滚。
2. **大改动按行拼接、别整段替换**：脚本先断言首行/末行/行号再落盘（本次用 `_tmp/splice-settings.cjs`）。
3. **改完必过 `node --check`**，再同步 `client/`（`deploy.ps1` 或 robocopy），最后**浏览器 Ctrl+Shift+R**。
4. **纯逻辑先离线试**：算法（打分/匹配）抽出来用 `node` 拿真数据跑一遍，再装进前端。
5. **别在文案里塞 markdown 星号** —— 这页文本是直接渲染的，`**x**` 会原样显示出来。
6. 能"动态挂载"的能力一律走 **注册不动 ＋ 按会话实时剪枝**（见 §1 铁律 8 的 2026-10-10 细化）。

## 4.6 扩展工具与「跨通道」（2026-10-10 主人定）

> 一句话：扩展工具可以声明 `expose: 'all'` 变成**全通道可见**，靠 `env.qq` 账号包在
> **非 QQ 的会话**里也能操作 QQ。以下每条都踩过坑。

### 4.6.1 三套扩展在哪、谁触发

| 扩展 | 目录 | 装载时机 |
|---|---|---|
| 斜杠命令 | `{cwd}/.qqbot-extensions/commands/*.js` | 启动时扫描 |
| **工具** | `{dataRoot}/.qqbot-extensions/tools/*.mjs` | 插件 apply ＋ `tools_reload` 热刷 |
| botplay 卡片 | `{dataRoot}/.qqbot-extensions/botplay/*.mjs` | botplay 控制器现读 |

`dataRoot` = `dataRootOf(config)` = `{cwd}/dshqqbot`（**新用户首次跑就会生成这个目录**）。

**新用户见面礼**（1.8.0）：插件启动时把本包 `examples/ext-tools/*.mjs`、`examples/botplay/*.mjs`
**只补不覆盖**地铺进上面两个目录（`extension-store.ts` 的 `seedExampleTools()`）—— 用户不用自己搬；
"只补不覆盖"同时保证了**不会重复搬**。

### 4.6.2 `expose: 'all'`：三个铁律

```js
export default { name: 'qq_send', expose: 'all', description: '…', inputSchema: {…}, run: async (args, env) => {…} };
```

1. **🔴 工具名只允许 `^[a-zA-Z0-9_-]+$`**
   注册名是 `<name>__<人设id>`（例 `qq_send__whale-girl`）。
   ⛔ **分隔符千万不能用 `@`** —— 它不在 LLM API 允许的字符集里，一旦注册进工具表，
   **每一轮请求都会被整轮拒绝**（`Invalid 'tools[N].name'`，机器人全面瘫痪、`/bot-new` 也救不回来）。
   现在注册前会校验，非法名**一律不注册并留痕**（`SKIP illegal global name`）。
2. **🔴 注册必须用 `ctx.root`**（真·宿主根），不是插件 ctx、更不能是 `agentCtx`。
   用错作用域 ⇒ 注册出来的工具**挂在会话上**，会话一换就被摘掉（表现：`工具已更新 · 移除 N 个`）。
   每个账号实例注册一份（tag = 该实例的 `config.preset`，读不到才退回 `cwd` 末级目录名，且**强制 ASCII**）。
3. **🔴 注册时机 = 插件启动**（`bootstrap.ts` 里 `ensureExtToolsGlobal` ＋ 短重试），
   ⛔ **不能只挂在 `agent/pre-step` 上** —— 那是"QQ 会话每步"才触发，**QQ 不活跃就永远注册不上**。

### 4.6.3 `env.qq` 账号包（只给 `expose:'all'` 的工具）

```
{ preset, tag, cwd, dataRoot, appId, appSecret, owners,
  groups: [{gid,name,lastAt}], c2c: [{openid,name,lastAt}],
  sender, sendText(scope,id,text), sendMarkdown(...), sendImage(...), apiCall(method,path,body) }
```

- `groups/c2c` = 群注册表（`{dataRoot}/.qqbot/groups.json`）＋ 各实例活跃会话（`listSessions()`）合并去重；
- **sender 的可靠来源是 `manager.channelSender`**（`installChannelSender()` 存的），
  ⛔ `channelBridges[].sender` 实测常是空的（桥未必被填充）—— 所以要 `hit.sender ?? mgr.channelSender`；
- **发送"被动优先、失败转主动"**（1.8.0）：`sendText` 先查**目标会话最近的 msgId**
  （`manager.getSessionRecord(scope, peerId).replyTarget.msgId`）带上它发（被动回复，不吃主动配额、QQ 也不吞）；
  失败（过期／配额用尽／没窗口）**去掉 msgId 重发**（主动兜底）。诊断会写明走的 `PASSIVE` 还是 `ACTIVE`。

### 4.6.4 可见性剪枝：默认工具**不该**所有会话都看得见

- 全局注册的工具会被**每个会话**继承 ⇒ 不带剪枝就是"白占每个会话的 token"。
- `restrictContextTools(agentCtx, shouldHave, …)`：`deny` 名单 = `context_memo/compact/drop` ＋ **`qq_group_admin`**；
- ⚠️ **剪枝原本只在 QQ 会话的 pre-step 里执行** ⇒ 非 QQ 会话从来没被剪过 ⇒ 那 4 个会漏出来。
  1.8.0 起：pre-step 的**最外层无条件区**先对每个会话设 deny，QQ 会话再按「无上下文模式」开关放开
  （后设覆盖前设，幂等不抖）。⇒ **非 QQ 会话里那几个连名字都不出现**。

### 4.6.5 日志纪律（2026-10-10 主人提醒）

- ⛔ **不要写"无条件 append 到自有文件"的日志** —— 别的用户不需要，而且没有轮转会一直吃盘
  （1.7.3 就为这个还过债）。
- ✅ 一律走统一诊断底座 `diagWrite('<类别>', line)`：受**设置页 ⑤「诊断日志落盘」**控制（默认关）、
  2MB 自动轮转、只留 1 份旧档；需要排查时打开开关即可。

### 4.6.6 排查"工具没出现"的顺序（按这个来，别乱猜）

1. **名字合法吗** —— grep 日志里有没有 `SKIP illegal global name`；
2. **注册函数跑了吗** —— 有没有 `enter` / `pass-throttle`；
3. **作用域对吗** —— 日志 `root=DIFFERS`（说明 `ctx.root` 与传入 ctx 不同，正常）；
4. **扫到几个** —— `instances=N :: tag,…` ＋ `inst=<tag> defs=N exposeAll=M`（`M=0` 就是 `expose` 没被解析到）；
5. **注册成功没** —— `OK registered xxx__<tag>`；
6. **是不是被剪枝了** —— 该会话是不是非 QQ 通道（那就该看不见）。

## 5. 变更纪律

1. 改 `m1/dsh-qqbot-public - 副本/src` → build → check → 本地/新环境实测 → 才 push。
2. 涉及 UI 文案/示例 → 同步检查隐私红线(§3)。
3. 涉及安装/依赖/peer → 过一遍 §1 七坑表。
4. 大改动更新本文档 §4 与 README(双语),并归档旧稿到 `_md-archive/`。

---

## 6. 部署纪律（2026-09-13 主人定）

- **少部署，功能成形再部署一次**：中间改动只在本地 build 自检（`npm run build` / `node --check` / `npm run check:package`），不 `deploy.ps1`。
- 一个功能完整做完（含边界、日志、失败兜底）→ 部署一次 → 请主人**重启宿主**验证。
- 验证发现问题 → 攒着一次改完再部署，**不要修一行部署一次**（今天为小传注入连部署 3 次、害主人重启 3 次 = 反面案例）。
- 区分两件事：**commit**（细粒度存档，方便回退）与 **deploy**（复制到宿主 profile，必须重启才生效）。前者随便存，后者要攒。
- 用到宿主服务（如 `systemPrompt`）时，**必须先在插件 `inject` 里声明**，否则代码看着对、功能静默不生效。
- ⚠️ **未在 `inject` 声明的服务，裸访问 `ctx.xxx` 会直接抛**（`cannot get property "xxx" without inject`，0.1.7 实测）。可选服务要用 **`ctx.get()`** 探测（不抛），别裸访问。
- ⚠️ **插件加载拦截看 `peerDependencies`**（2026-09-23 实测修正）：0.1.7 启动时会比对各插件 peerDeps，钉死在旧次版本的包会被**跳过/禁用** —— 例：`dsh-mcp-client@0.0.1-rc.1`（peerDeps 全是 `^0.0.1-rc.1`）被判不兼容，导致 `mcp-chrome` / `mcp-playwright` **整行被禁用**；`@dhicoc/dsh-reverse-skill@1.0.5` 同样被跳过。`engines.dsh` 仍只影响插件市场卡片展示。
  - 官方包也可能"标签没跟上"：`@deepseek-ai/dsh-mcp-client` 的 `latest` 仍指 `0.0.1-rc.1`，**`next` 才是 `0.1.7-rc.1`** → 必须显式写版本号安装。
  - **2026-10-04 补充（0.2.1-alpha.1 实测 + 源码核对；定义/原理/完整总表见 `dsh插件开发总参考_20261011.md` §9.1）**：
    - 判定语义 = `semver.satisfies(宿主版本, peer范围, { includePrerelease: true })`，**只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 前缀的 peer**；`workspace:^|~|*` 被当成"等于当前版本"⇒ 永远满足。
    - 日志两种形态（都要认得）：`dsh: skipping profile bundle "<包名>": Error: Plugin <包>@<版> is incompatible with dsh <宿主版>: peerDependencies {...}`（整个组合包被跳过）/ `dsh: disabling profile plugin row "<行 id>": …`（单行被禁用）。
    - **本插件的 peer 现状是安全的**：`dsh-agent|dsh-llm|dsh-session: ">=0.1.0-rc.6"`、`dsh-tools: ">=0.1.1-rc.2"`、`dsh-settings: "*"` —— **全无上界** ⇒ 不会被 0.2.1 的门拦。反例 = 写 `^0.1.1-rc.2` 的那些（`^` 的上界是 `<0.2.0`，宿主一升大版本就被判不兼容）。
    - **豁免的确切命令行**（口口相传的 `dsh plugin allow-version <pkg>@<ver>` 是**错的**，会报 usage）：
      ```powershell
      dsh plugin --profile web allow-version <包>@<精确版> --dsh-version <精确宿主版> --accept-risk
      dsh plugin --profile web revoke-version <包>@<精确版> --dsh-version <精确宿主版>
      dsh plugin --profile web version-exemptions      # 列出已有豁免
      ```
      豁免写在 **profile 的 `compatibility.json`**（不写 package.json、不写 cordis patch）；本机该文件**当前不存在** ⇒ 一个豁免都没生效。装载失败时 dsh 会自己把这行命令打印出来，照抄即可。

### ⚠️ deploy.ps1 与 pnpm-lock 的关系（2026-09-23 踩坑）

`deploy.ps1` 用 **robocopy 直接覆盖** profile 里的插件文件 —— 只改文件，**不动 `pnpm-lock.yaml`**。
后果：profile 的 `package.json` 声明 `^1.5.4`、lockfile 钉 `1.5.4`，于是**任何一次 pnpm 操作**（`pnpm install` / 装更新别的插件 / `dsh plugin add`）都会**把插件拽回 lockfile 里的旧版本**（实测：robocopy 部署到 1.5.6 后，线上仍显示 1.5.4）。

**正确姿势**：发布到 npm 之后，**必须补一步 pnpm 更新**让 lockfile 跟上：

```powershell
dsh plugin --profile web update @zaofan/dsh-qqbot --latest
```

**排查口诀**：`node_modules/<包>/package.json` 的 version 是"文件真相"，`pnpm-lock.yaml` 里的是"pnpm 真相"——**两者不一致时，下一次安装的结果以 lockfile 为准**。

> 升级多个插件尽量**合并成一次 pnpm 操作**（`dsh plugin add A@x B@y C@z`），避免来回触发 lockfile 还原。

---

### ⚠️ `dsh plugin ... update` 必须在**宿主停掉之后**跑（2026-10-12 实测）

在 `dsh web` **运行中**执行 `dsh plugin --profile web update …` 会**卡死**：
`…/profiles/web/.plugin-manager/logs/operation-*/pnpm.log` **0 字节、十几分钟不动**（profile 被运行中的宿主占着）。
排查要点：

- 别用 shell 的 `timeout` 包它 —— 被 SIGTERM 杀掉时 pnpm 会打印
  `Command failed with exit code 143`（**143 = 128+15 = 我自己杀的**，不是 pnpm 报错），
  还会看到半途的 `Packages: +17 -59`，很容易误判成"删了 59 个包、profile 被搞坏"。
- **实测中断无害**：pnpm 连解析阶段都没走完，插件目录、`@zaofan/*` 其它包、`.pnpm/lock.yaml` 全都没动
  （检查法：看 `.pnpm/lock.yaml` / `.modules.yaml` 的 mtime 有没有变成"刚才"）。
- 正确顺序：**停 `dsh web` → 跑 update（耐心等几分钟）→ 再启宿主**。
- ⚠️ **不要**用 `Tee-Object -Variable x | Select-Object -Last N` 去看它的输出 ——
  `Select-Object -Last` 会**缓冲到管道结束才吐字**，看起来像卡住，实际没输出可比。
  要看进度直接 `Get-Content -Wait <那个 pnpm.log>`。

> 补充：**lockfile 漂移会自愈**。这份 profile 的 `pnpm-lock.yaml` 长期写的是 `@zaofan/dsh-qqbot@1.8.4`
> （因为我们一直是 robocopy 覆盖 dist，没走 pnpm）。只要 npm 上的 `latest` 已经是目标版本，
> 下一次 `dsh plugin` 操作重新解析时自然会落到新版本，不必为对齐 lockfile 冒风险。

### ⚠️ 2026-10-12 主人改令：测试期"先覆盖生产"，测过才走 npm 正式装

原纪律是"**必须等主人测试通过**才允许部署到线上"——但**测试本身就得先装上**，于是死循环。
现明确为**两步走**：

**第一步（测试期，快）**：`pwsh -File deploy.ps1` 直接覆盖线上 profile 的插件目录 → 主人**重启宿主**验证。

- 覆盖前**必须先备份**线上目录，回滚就拷回去：
  ```powershell
  $dep = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\@zaofan\dsh-qqbot"
  robocopy $dep "D:\...\_backup\qqbot-<旧版本>-<时间戳>" /E
  ```
- 这一步**只用于测试**，不算正式安装（能跑通 ≠ 已发布）。

**第二步（测过之后，正式）**：npm 发布 → 让 lockfile 对齐：

```powershell
npm stage publish                          # 暂存（不需要 OTP）
npm stage approve <stage-id> --otp=<6位码>   # 主人手机令牌批准，才真正发布
dsh plugin --profile web update @zaofan/dsh-qqbot --latest
```

**不做第二步的后果**（就是下面那个 lockfile 坑）：`deploy.ps1` 只改文件、锁文件仍钉旧版，
之后**任何一次 pnpm 操作都会把插件拽回旧版本**。

> `deploy.ps1` **2026-10-12 起也同步 `examples/`** —— `seedExampleTools()` 是按**安装目录**
> （`import.meta.url` 相对路径）去读 `examples/ext-tools/` 的；漏同步会让线上那份示例停留在旧版
> （实测：新增的跨会话四件套 + `lib/` 在线上缺失，而这些文件在 npm tarball 里本来是有的）。
> 排查口诀同上：**`node_modules/<包>/` 是"文件真相"，`pnpm-lock.yaml` 是"pnpm 真相"**。

---

## 7. 宿主版本兼容声明（engines.dsh）规则（2026-09-21 主人定）

**核心：只写"实测过"的精确版本，一个都不许含糊。**

- **声明位置**：`package.json` → `dsh.engines.dsh`（生态里顶层 `engines.dsh` 也认，但本包统一用 `dsh.engines.dsh`，与 `bundle`/`client` 放一起）。
- **值用 semver 的 `||` 逐个列出精确版本**，例如：`"dsh": "0.1.5-rc.2 || 0.1.6-alpha.2"`。
- **禁止写 `>=` / `^` / `~` 宽范围** —— 范围一宽，未来宿主会被市场误判成"兼容"，用户是踩了坑才发现。要支持新版本就**追加一个精确版本号**，别放水。
- **每实测通过一个新宿主版本 → 追加一条并在下表留痕**；没实测过的不许写进去。
- **显示位置**：dsh 插件市场（dshmarket）卡片上那条 `DSH xxx` 徽章。它优先读 `engines.dsh`；**没有显式声明时**会回退去合取 `@deepseek-ai/dsh-*` 的 peerDependencies，于是显示成 `>=0.1.0-rc.6 ∧ ^0.1.1-rc.2` 那种（v1.5.5 及之前就是这形态，容易让人看不懂）。

**实测留痕表（每追加一个版本必须补一行）**

| 宿主版本 | 结论 | 实测要点 |
|---|---|---|
| 0.1.5-rc.2 | ✅ 兼容 | 长期线上运行；`session/event`、`agent/pre-step`、`tools.register`、`ctx.effect` 生命周期清理均正常 |
| 0.1.6-alpha.2 | ✅ 兼容 | 升级后两个 QQ 机器人 Bot ready；`eventAt/snapshotEvents/ownEvents` 仅标 deprecated 未移除，源码零改动可跑（默认模型兜底已同步 `deepseek-flash`） |
| 0.1.7-rc.1 | ✅ 兼容 | 独立 DSH_HOME 实测：插件正常加载并初始化；声明式预设可被 profile 补丁 `- insert:` 声明并生效；版本兼容检查不拦截。**同时修了两处 0.1.7 才暴露的坑**：① 预设机制换血（目录→声明行），插件改双模式探测；② `ctx.agentPresets` 未在 inject 声明时**裸访问会抛** "cannot get property ... without inject" → 改用 `ctx.get()` 探测 |
| **0.2.1-alpha.1** | ⏳ **待回归（2026-10-04 登记）** | 宿主已升级到该版本；**已确认**：① 本插件 peer 全无上界 ⇒ **不被新的版本兼容门拦**；② profile 的 `minimumReleaseAgeExclude` 里已有 `@zaofan/dsh-qqbot@…1.6.4 / 1.6.5`（不会被装回更旧版）。**尚未走完 §11.19 的回归三件事**（dock 球 / 设置页 / 智能回复能算分）⇒ **暂不写"✅ 兼容"**，回归通过后再改这一行 |

> 💡 **0.1.7 预设换血备忘（改预设相关代码必读）**：新版预设 = profile 配置里的声明行
> （`@deepseek-ai/dsh-agent-preset-registry` + 每预设一行 `@deepseek-ai/dsh-agent-preset`，`config.id` 才是会话存的 preset ID）。
> 官方明确：注册表**不扫描目录、不接受 preset 路径、没有任何接口接受 YAML 写回**；新增/覆盖只能写 profile 的 bundle 补丁。
> 插件现状：列表走 `agentPresets.list()`（双模式回落扫目录）、写操作给 501 指引（未实现写入，留待后续）。
> ⚠️ patch 写法两个坑：顶层若是空数组 `[]` 必须先替换掉再写；新增条目必须用 `- insert:`（用 `- id:` 会报 entry not found）。

> 备注：`engines.dsh` 只影响**插件市场卡片的兼容提示**，不参与宿主加载；写错不会导致插件加载失败。


---

## 8. dsh 0.1.7 适配专题（2026-09-24 实战沉淀，升级必读）

### 8.1 0.1.7 的破坏性变更清单

| 变更 | 影响 | 应对 |
|---|---|---|
| **预设**：目录文件 → **profile 声明行** | `~/.dsh/.agent-presets/` 不再被扫描；registry 不接受路径、也无 YAML 回写接口 | 用 `scripts/migrate-presets-017.ps1` 迁移；新增/覆盖预设只能靠 bundle patch + plugin_manager |
| **设置**：`ctx.settings.installSection` **删除** → `SettingsForms`（schema 驱动） | 插件自注册设置的旧路失效，`describe()` 不再返回自己的 ns | 见 8.2 |
| **设置写入门槛**：`settings.update` 只收 **schema 里标了 volatile** 的字段 | 未标 → `Plugin entry "x" has no volatile fields` | 可标 volatile，但**注意 8.3 的陷阱一** |
| **插件加载门**：改成按 `peerDependencies` 校验 | 旧插件被 skip（实例：`@dhicoc/dsh-reverse-skill`） | 升级插件，或 `dsh plugin allow-version` 显式豁免 |
| **会话日志 V7**（`record.identity` + `record.rows`） | 旧的 `events` 结构变了 | `session.append` 等仍可用（本轮实测轮询注入成功，能正常写） |
| `agent.inject` / `whenIdle` / `followup` / `steer` / `session.append` | **全都还在** | **无需改动**（本轮曾误判为被移除，差点白改一批代码） |

### 8.2 设置保存：走「插件自有存储」，**不要**写 profile patch

```
设置页保存 → {DSH_HOME}/qqbot-settings/<实例 ns>.json      ← 插件自己的文件（JSON）
设置页读取 → patch 值 + 自有存储覆盖
插件启动   → 读自有存储（递归深合并）覆盖 resolvedConfig
保存后     → 桥 ctx.emit('qqbot/settings-changed') → 插件重读 → 内存热生效
```

**为什么坚决不写 `cordis.patch.yml`**（每条都是实测踩出来的）：
1. **写 patch 会被宿主当热更新提交** → 插件重新 apply → 若凭据无效又会写配置 → **自反馈死循环**
   （实测把 dsh 启动刷死、无限弹二维码 → 只能用 `settings.yaml.imported` 之类留档救场）
2. **手拼 YAML 保不住类型**：实测 `appId` 写成裸数字 → `expected string`；
   `groupAdmin.owners` 空数组写成 `''` → `expected array`（宿主 schema 校验失败 → 插件不激活）
3. **不支持新增键**：`groupAdmin.pollJoinRequests` 这类"patch 里原本没有"的嵌套新字段**写不进去**
4. **重复键直接崩**：宿主 YAML 严格解析报 `duplicated mapping key` → **dsh 完全起不来**
5. **脱敏值会覆盖真值**：读配置时把 secret 打码成 `__REDACTED__`，前端保存时原样回写 → **真 appSecret 被覆盖**
   > 教训：任何"把脱敏文档回传前端、再接收整份写回"的设计，**必须显式忽略脱敏占位符**

### 8.3 ⚠️ 两个必须刻在脑子里的陷阱

**陷阱一：不要给整个 Config 标顶层 volatile**
`dsh-settings` 的 `volatileForm()` 第一行就是：
```js
if (schema.meta.volatile) return plainSchema(schema);   // 顶层一标 → 整份配置都算"可热改"
```
于是**插件自己写配置**（如扫码绑定写凭据）就会被宿主当热提交 → 插件重新 apply → 再写 → **死循环**。
> 结论：`volatile` 只适合"改了**不需要插件做副作用**"的字段。
> 本插件最终选择**不标**，改走自有存储。

**陷阱二：自有存储里绝不能出现空对象 `{}`**
若合并用浅合并（`Object.assign`），`sticker: {}` 会把 patch 里的整块 `sticker` 配置**顶掉** →
`config.sticker.collectEnabled` 变 `undefined` → **图片自动下载静默停摆**。
（症状：**最后一张自动下载的图停在某个时刻**，之后入站图片只剩 QQ 长 URL。）
> 现已改为递归 `mergeDeep`。**想恢复默认就删掉该字段，不要写 `{}`。**

### 8.4 入群事件：`watchJoinRequests` 会让机器人连不上

`GROUP_JOIN_REQUEST` 的 intent 是 `1<<24`，`bootstrap.ts` 里：
```ts
...(watchJoinRequests ? { intents: FULL_INTENTS | (1 << 24) } : {})
```
**若 QQ 开放平台未开通该事件，网关会拒绝 Identify（close 4914/4915）→ 机器人直接离线**（无醒目报错）。
正确顺序：**① 平台开通事件 → ② 打开开关 → ③ 重启**。
不想折腾平台就用**轮询**（`pollJoinRequests`，不需要任何授权）：
- `pollJoinRequests.enabled` 是**总开关**，不勾它下面的选项全部不生效
- `wakeLlm` 与 `hubNotify` **互斥且唤醒优先** —— 两个都勾只会唤醒 AI，**不会注入群管会话**；
  想要静默注入就**只勾「注入群管会话」**

### 8.5 配置丢失：0.1.6 → 0.1.7 升级会顶掉自定义值

宿主导入旧 `~/.dsh/settings.yaml` 时**不一定落到 entry config**；插件读不到自定义值就用默认值回写，
把它顶掉。**原件留档在 `~/.dsh/settings.yaml.imported`**（同目录通常还有 `.bak`）——
`groupPrompt`（群守则）/ `injectRules`（条件注入）/ `botplayEvents`（互动事件）都能从那找回。

> ⚠️ **隐私红线**：`groupPrompt` 常含主人 openid 与进群暗号，**发布 / 分享 / 截图前必须剔除**。

### 8.6 dsh 0.2.1-alpha.1 适配专题（2026-10-04 登记）

0.1.7 → 0.2.1 之间官方有**至少 20 条**影响插件作者的变更，其中与本插件直接相关的：

| 变更 | 对本插件 | 处置 |
|---|---|---|
| **版本兼容门**（peer 不满足 ⇒ 整行禁用） | 本插件 peer 全无上界 ⇒ **不受影响** | 无需改；新增依赖时**别写 `^`** |
| **`agent/session-start` 被 `agent/created` 取代**（后者 serial 且可 veto） | ⚠️ **要 grep 本仓**：谁在订阅 `agent/session-start`，那个钩子现在**永不触发** | 改用 `agent/created` 或 `agent/pre-step`（本插件的群守则/上下文注入走的是 `agent/pre-step`，**不受影响**） |
| **`settings.yaml` 退出历史**；设置改为 profile 条目表单（`SettingsForms`），写入需字段标 `volatile` | 本插件**早已改走"插件自有存储 + qqbot/settings-changed 桥"**（§8.2）⇒ 不受影响 | 保持现状；**别**回头去写 profile patch |
| **`ctx.settings.installSection` 删除** | 本插件**有调用、但带能力检测**（`typeof svc.installSection === 'function'` 才调）⇒ 0.2.1 上自动跳过、静默降级，**不会崩** | ⚠️ **别误判影响面**（2026-10-04 实测更正）：用户可见的「设置 → **QQ 机器人**」菜单项**不是**这条提供的，而是 client 自己注册的槽位 —— `slots.inject('settings.section', …)` → `slots.register({ name:'settings.section', **id:'qqbot'**, order:32, label:'QQ 机器人' })`；**`settings.section` 在 0.2.1 依然存在**（`dsh-client-ui-settings/lib/types/slots.d.ts:73`）⇒ 升级后设置页实测**完全正常**（主人已确认）。被删的只是"宿主原生深度集成"那条路，降级即可。<br>📌 **附带收获**：新版 dsh 要求注册槽位**必须带 `id`**（否则 `list slot "xxx" requires options.id`）—— 我们一直带着，所以不报错；`dsh-better-sidebar@0.19.1` 就是漏了 `id` 才一直弹红框（升 0.24.1 已修）。 |
| Session 日志 **V4**（`SESSION_FORMAT_VERSION = 4`）；同步读接口 `snapshotEvents`/`eventAt`/`ownEvents` 标 deprecated（**未移除**） | 本插件用到 `append` 等，仍可用 | 新代码优先增量/投影读 |
| work/spill 预算改按 **token**（`maxInlineBytes` → `maxInlineTokens`） | 本插件未自定义 spill-policy | 若将来要配，用新字段名 |
| PTC 包名/服务名统一 `ptc-runtime`；工作流执行器改 `workflow-ptc` | 本插件未用 PTC | — |
| 自动化任务改由 Web 内置能力提供（提醒工具按模式给） | 本插件用**自有 scheduler**（`{dataRoot}/.qqbot/schedule-state.json`） | 不受影响（与 §11.19 第 2 条同源） |

> **完整总表 + 每个条目的源码/公告出处**：`dsh插件开发总参考_20261011.md` **§9.10**（含 0.2.1-alpha.1 那 4 条、0.1.7-rc.1 的 20 余条）。
> **升级后要跑的回归**：§11.19 那三件事（dock 球出现 → 设置页可打开 → 智能回复能算出分）。

---

## 9. 「静默失效」排查清单（症状 → 先查这里）

本插件大量采用"可选 + 兜底 + warn"的防御式写法，**失效往往不报错**，表现为"功能悄悄没了"。
遇到下列症状，先照这张表查：

| 症状 | 优先检查 |
|---|---|
| 设置页保存后刷新又变回去 | ① host 侧改过是否需要重启 ② 面板读的是自有存储还是 patch ③ 是否有空对象覆盖 |
| 图片只剩 `[图片]` 或 QQ 长 URL | ① `collectEnabled`（被空对象顶掉会 undefined → 采集停）② `image-path-cache` 的 URL 缓存 miss（QQ 每次推送 URL 与 fileid 尾段都会变，实测公共前缀仅 41 字符）③ **拼消息 vs 图片预检的执行顺序**（`assembleAgentBody` 必须晚于预检） |
| 机器人离线（无醒目报错） | `watchJoinRequests` 被打开但平台未授权（4914/4915） |
| 自定义配置"消失" | 去 `~/.dsh/settings.yaml.imported` 找原件 |
| 入群通知到不了 | ① `pollJoinRequests.enabled` 总开关 ② `wakeLlm` 顶掉了 `hubNotify` ③ hub 会话的 agent 是否活跃（不活跃时注入返回 `no-agent`，静默失败） |
| 小传"不注入" | 那行 `宿主未提供 systemPrompt.context` 的 warn **是误导** —— 主通道是 `session-manager` 的 pre-step 注入（与群守则同一条）；另有 **90s TTL**（`inbound` 算好后 90 秒内有效，过期就不带） |
| 图片匹配不到图库 | 哈希（sha1 前 12 位）是主路；URL 是辅路。**图库 `index.json` 里 3190 条、`lib/` 有图 ≠ 消息里会给路径**，还要缓存命中 |

### 9.1 图片链路的正确认知（本轮花了好几轮才理清）

插件里**两条路是分开的**，别混为一谈：
1. **哈希匹配**（`inbound.ts` 图片预检）：`sha1(buf).slice(0,12)` 查 `store.get(id)`，
   不中再用 `computeDHash` 查正式库 → 决定 `libItem` / 评分 / "这张图你已收藏过"提示
2. **消息里的路径**（Layer4，`buildDynamicCtx`）：**只查 `lookupImagePath(att.url)` 这个 URL 缓存**
   → 缓存 miss 就直接回退原始长 URL

所以会出现"**匹配到图库了、却还是给 URL**"的现象 —— 那不是矛盾，是**两条路**。
缓存加 **fileid 前 40 字符稳定键**后，QQ 换 URL 也能命中。

---

## 10. 发布流程补充（2026-09-24）

### 10.1 git 推送被失效代理挡住
本机 git 配了 `http.proxy=http://127.0.0.1:29290`，**代理一关推送就报 `Failed to connect ... port 443`**。
绕过（不改配置）：
```powershell
git -c http.proxy= -c https.proxy= push origin main
git -c http.proxy= -c https.proxy= push -f origin v1.5.9
```

**2026-10-04 补（重要澄清）**：⚠️ 上面那个"绕过"**只在代理确实没开时**才用。**代理正常（`127.0.0.1:29290` 在跑）时应该走代理** —— 国内直连 GitHub 会被 reset，SSH 也因没配 key 不可用。所以真正的修法是**把配置配回去**：

```powershell
git config --global --get-regexp proxy      # 先看现状（2026-10-04 实测：两条都在）
git config --global http.proxy  http://127.0.0.1:29290
git config --global https.proxy http://127.0.0.1:29290
```

（`pnpm` 连 GitHub 也依赖同一代理；代理一清，git 与 pnpm 一起连不上。）

### 10.2 GitHub Release 默认**只写说明、不带资产**
主人 2026-09-24 定：**Release 只填说明（取 CHANGELOG 对应版本段落），不上传 tgz**。
```powershell
# token 从凭据管理器取，别写进仓库
$tok = ($(("protocol=https`nhost=github.com`n`n" | git credential fill)) -like 'password=*' -replace '^password=', '')
# POST /repos/<owner>/<repo>/releases  { tag_name, name, body, draft:false, prerelease:false }
```
（想要 tarball 资产的老流程见 §2，但默认不再附）

### 10.3 npm 暂存流
```powershell
npm stage publish --access public "--//registry.npmjs.org/:_authToken=<token>"
# → 打印 staged id；等状态 validating → staged 后，主人在网页 Approve
# ⚠️ 连发多版本时按版本先后依次批准，latest 才落在最新那个上
# ⚠️ token 若出现在聊天/日志里，用完立刻到 npm 站点 Revoke
```

### 9.2 ⚠️ 改 dist 后做"一次性数据清理"会被运行中的进程盖回去

**现象**（2026-09-24 实测）：改了 `dist` 里的清理逻辑、并手动把数据文件清理干净，
但**每轮对话后文件又变回清理前的样子**。

**原因**：插件进程**内存里持有旧数据**，而 `write()` 是**全量覆盖**（`JSON.stringify(整个 Map)`）。
进程启动早于 `dist` 部署 → 它跑的是**旧代码**（没有清理）→ 每次写盘把内存里的旧数据原样写回。

**正确顺序**：
1. **先重启 dsh**（让新代码接管，从文件重新加载数据）
2. 再触发一次（或等自动）写盘 → 新代码的清理逻辑生效
3. 验证文件

> 判断依据：比较 `dsh` 进程启动时间 与 `node_modules/@zaofan/dsh-qqbot/dist/**` 的部署时间。
> 进程早于部署 = 跑的还是旧代码（`Get-Process -Id <3080 占用者> | Select StartTime`）。

**同类注意**：`model-prefs.json` / `join-pending.json` / `people/*.md` 等由插件进程持有并全量写回的文件，
**都不能在进程运行时做"手动清理"**，否则必被覆盖。

---

## 11. ⚠️ 2026-09-28 大排查沉淀（"插件完全加载不起来"专题）

> 这一夜踩的坑，按"根因 → 诊断手法"整理。**下次遇到"插件装了但没界面/没反应"，先读这章。**

### 11.1 🔴 第一铁律：**必须装到 `web` profile**

```
本插件的前端设置面板（dock 球 + 「设置 → QQ 机器人」整页）
只在【web profile】里生效（README 安装章第 70 行就写着）。
装到别的 profile = 一个【没有设置面板的裸环境】。
```

**症状**：插件装了，服务端日志还正常，但**页面上什么都没有**（没 dock 球、设置里没入口）。

**踩坑记录**：当晚为了做"隔离测试"，建了个 `qqnew` profile 反复折腾 —— 结果是
**在错误的前提下折腾了 20+ 轮**，最后才发现 README 自己早就写了这条。
→ **建测试 profile 时，必须也把它当作 `web` 用（`--from-default-profile web` 且用 `dsh --profile <name>` 起），否则 UI 永远不会出现。**

**普通用户不受影响**：`dsh web` 默认就是 `web` profile，插件页/market 装也落在它上面。

### 11.2 🔴 `dsh.client.immediately: true` **不是**雷（别乱删）

当晚一度以为它是"整页不渲染"的元凶把它删了 —— **错的**。正式环境（工作正常）一直带着它：

```json
"dsh": { "bundle": {...}, "client": { "platform": "web", "inject": [...], "immediately": true } }
```

**教训**：判断某字段是否有害，**先去"能正常工作的环境"里对比同一个字段**，
而不是"删掉试试"（那会引入新变量，把排查带偏）。

### 11.3 🔴 包入口守卫 `entry.js`：多写一句 `export { default }` 会让插件**完全加载不起来**

```js
// ❌ 错（dist/index.js 并没有 default 导出）
export * from './dist/index.js';
export { default } from './dist/index.js';
// → SyntaxError: The requested module './dist/index.js' does not provide an export named 'default'
// → 整个插件 import 失败，宿主只打印一句 "failed to import"（看不出真因）
```

**判断手法**：`node -e "import('./entry.js')"` 或直接 `import('./dist/index.js')` 对比 ——
一个失败一个成功，问题就在入口层。

### 11.4 🔴 `ctx.inject(deps, cb)` 会**阻塞插件自身 fiber**

```js
// ❌ 插件 apply 里这样写：宿主未注册 settings/webServer 时，插件永久 pending
ctx.inject(['settings', 'webServer'], (c) => bridgeApply(c));
// → 宿主判定 "1 required plugin did not activate"
// → 【整个 Web UI 都不渲染】（只剩一句 Failed to load plugins + 一个 dock 球）

// ✅ 正解：apply 先正常返回（插件立即激活），延后再 inject
setTimeout(() => { try { ctx.inject(deps, (c) => bridgeApply(c)); } catch {} }, 1500);
```

**为什么"直接调 `bridgeApply(ctx)`"也不行**：桥内部要 `ctx.webServer`，
没经过 inject 的 ctx 访问它会抛 `cannot get property "webServer" without inject`。

### 11.5 🔴 宿主服务**绝不能**放进 `dependencies`

曾把 `@deepseek-ai/dsh-llm` / `dsh-session` / `dsh-tools` 放 `dependencies` 想让新环境"自足" ——
pnpm 装出了与宿主**不匹配的版本**（`0.1.0-rc.8`，而宿主是 `0.1.7-rc.1`），
**反而把宿主自己的官方插件搞挂**：

```
image-offload (@deepseek-ai/dsh-compaction-image-offload):
  TypeError: ctx.sessions.registerMessageProjection is not a function
```

**正确划分**：
| 类别 | 放哪 | 例 |
|---|---|---|
| **宿主服务**（必须宿主提供）| `peerDependencies` | `dsh-llm` / `dsh-session` / `dsh-tools` / `cordis` / `dsh-agent` |
| **纯工具库 / 客户端插件**（自带一份无害）| `dependencies` | `schemastery`、`dsh-client-ui-slots`、`dsh-client-ui-settings` |
| **第三方 SDK** | `dependencies` | `@tencent-connect/*`、`js-yaml`、`silk-wasm` |

### 11.6 🔴 "只写自有存储、读取只读 patch" —— **读写必须对称**

2026-09-24 起，已有账号的 `appId`/`appSecret`/`preset`/`cwd` **只写自有存储**（不写 patch）。
但桥里多处**只读 patch** 取账号配置 → 用户存进自有存储的值读不到：

| 出问题的点 | 症状 |
|---|---|
| `/accounts` 回显 | 账号页填了「工作目录」保存后**变空**（连 `preset` 也一样）|
| `nsBot()` | 返回 `null` → 群管理 / 图库 / 无上下文 / Excel 导出**全部走错路径** |

**→ 现在统一走 `mergeOwnIntoCfg(cfg, nsLike)`**（patch 优先，其次自有存储）。
**新增任何"取账号配置"的地方，都必须用它**，否则又是同一个坑。

> 判断手法：在桥里搜 `parsePatch()` —— **每一个消费点都要问一句"这里要不要合并自有存储"**。

### 11.7 🟢 诊断法宝（这次靠它们才定位到）

**① 宿主官方诊断文件**（最权威，能直接看到 pending 列表与真实错误）：
```powershell
# 每次启动失败都会生成，并在控制台打印路径
dir ~\.dsh\logs\startup-*.log
# 里面含: error / Plugins waiting for services(N) / 每个插件的 failed 详情
```

**② 浏览器里看宿主的客户端入口清单**（判断"插件有没有被前端认领"）：
```js
// 在 dsh 页面控制台执行
const b = window.__DSH_BOOT__;
b.entries.length                                  // 总入口数
b.entries.filter(e => /qqbot/.test(e.id))          // 我们的入口在不在
b.entries.find(e => /qqbot/.test(e.id))?.url       // 它的 client.js URL（带 rev）
// 对照：官方 ui-slots 之类
b.entries.filter(e => /ui-slots|ui-settings/.test(e.id))
```

**③ 手动验证 import 链**（区分"入口层"还是"业务层"出错）：
```powershell
cd <profile>\node_modules\@zaofan\dsh-qqbot
node -e "import('./dist/index.js').then(m=>console.log(Object.keys(m))).catch(e=>console.log(e.message))"
node -e "import('./entry.js').then(m=>console.log('ok')).catch(e=>console.log(e.message))"
```

**④ 从 git 装能不能用 —— 直接看包内容**：
```powershell
pnpm pack @zaofan/dsh-qqbot@<ver> --silent    # 或装完直接看
tar -tzf x.tgz | Select-String "dist/index.js"  # dist 有没有被打包
```

### 11.8 🟢 "新用户两条正常路径"必须都通

```
① 插件页/市场填【包名】 @zaofan/dsh-qqbot     → 走 npm，带 dist ✅
② 插件页填【GitHub 地址】 github:<user>/<repo> → 走 git，必须有 dist ❗
```

**为了让 ② 也能开箱可用，仓库必须提交 `dist/`**（`dist` 已从 `.gitignore` 移除，约 388 文件 / 2MB）。
⚠️ **同时不能留 `prepare` 脚本** —— 新版 pnpm 默认禁止 git 依赖跑构建脚本：
```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
The git-hosted package "..." needs to execute build scripts but is not in the "allowBuilds" allowlist.
```
→ 装包直接失败。**dist 入库 + 无 prepare = git 直装开箱可用。**

### 11.9 🔴 纪律：**不要在用户的生产 profile 上"边试边改"**

当晚多次"改了 → 部署到 `~/.dsh/profiles/web` → 重启"，把主人的环境当试验场，
不仅打断他使用，还把"测试污染"和"线上问题"混在一起，**排查难度翻倍**。

**正确做法**：
1. 先在**独立 profile**（且按 11.1 当作 web 用）复现与验证
2. **确认修复有效后**，才部署到 `web` profile
3. 每次部署前**备份**：`package.json` / `cordis.patch.yml` / 插件目录

### 11.10 🟢 一句话总结这一夜

> **"插件加载不起来"这类问题，先分清是【服务端 fiber】还是【前端 client entry】——
> 服务端看 `~/.dsh/logs/startup-*.log`，前端看 `__DSH_BOOT__.entries`；
> 再回头看自己写的 README（很多答案早就在里面）。"**


### 11.11 🔴 合并自有存储时：**自有存储优先**（别搞反）

```js
// ❌ 错（人家 1.5.14/1.5.15 一度写成这样）
const preset = patchCfg.preset || ownCfg.preset;   // patch 是旧值！界面永远显示旧人格
// ✅ 对（与 /read 接口一致）
const preset = ownCfg.preset || patchCfg.preset;   // 自有存储 = 用户在设置页保存的最新值
```

**后果（实测）**：改「Agent 预设(人格)」后界面仍显示旧人格（**看起来"没改成"，其实已生效**）；
更严重的是 `nsBot()` 拿到旧的 `appSecret`/`cwd` → **用错凭据连不上（掉线）**、群管理与图库走错路径。

**判断口诀**：`patch` = 历史遗留；**自有存储 = 用户最新保存**。
`/read` 接口的 `Object.assign({}, base.value, own)` 就是"own 覆盖 base"，**所有合并都照它**。

### 11.12 🟢 一个账号同时存在"自有存储 + patch 两套值"时怎么排查

```powershell
# 看自有存储（用户改的，最终生效）
Get-Content ~\.dsh\qqbot-settings\im-qqbot-3.json
# 看 patch（历史旧值）
Select-String ~\.dsh\profiles\web\cordis.patch.yml -Pattern "im-qqbot-3" -Context 0,12
# 两者不一致时以【自有存储】为准
```

### 11.13 🔴 幽灵实例 `im-qqbot` 会污染"当前账号"的判定

插件 bundle patch 会自动注入一条 `- id: im-qqbot`，凭据是占位符 `__FROM_ENV__`。
它的 **`disabled` 是 `false`**（只在"没有有效 appId"这点上与真实例不同），所以：

- **前端过滤 `!disabled` 拦不住它** → 它会排在 `/accounts` 列表第一位
- **dock 面板"反查当前会话所属实例"失败时回落到 `list[0]`** → 落到它身上
- → 面板读它的**空配置** → 评分模式/门槛等全部显示成 **schema 默认值**
- → 用户看到的现象是"**我设的东西全被重置了**"

**正确过滤**：
```js
list.filter(a => a && !a.disabled && a.appId)   // 真实例必须【有 appId】
```

**排查口诀**：只要"面板显示默认值"，先问"当前 `state.ns` 是不是落到了 `im-qqbot`"。
真机验证：`curl http://127.0.0.1:<port>/api/qqbot-settings/accounts`
→ 看列表里 `im-qqbot`（无 appId、无 cwd）是不是排在前面。

**根治**（推荐）：在 profile 的 `cordis.patch.yml` 里显式关掉幽灵实例：
```yaml
- id: im-qqbot
  disabled: true
```

### 11.14 🔴 "隐式依赖"是发布级事故 —— 代码 import 了却没写进 package.json

**最典型的受害者：`@huggingface/transformers`（本地小模型 / 智能回复的推理运行时）**

```ts
// src/features/local-embed.ts
const mod = await import('@huggingface/transformers');   // ← 动态 import
```
而这个包**从未出现在 `dependencies` 里** —— 只靠它"碰巧被 hoist 到 profile 上层"才能跑。
一旦环境变化（pnpm 严格模式 / profile 重装 / 依赖提升位置不同 / 用户单独装本插件），
`import` 直接抛错 → 见 §11.15 的连锁故障。

**发现手法**（必做）：把源码里所有 import 的裸包名与 `package.json` 三方对照。
```powershell
# 源码里 import 的包 vs dependencies/peerDependencies 的差集
# 一次性脚本：src/**/*.ts 抓 `from 'x'` / `await import('x')`，与 package.json 比较
```
本插件实际存在过的隐式依赖（2026-09-30 全部补齐）：
| 包 | 正确定位 | 说明 |
|---|---|---|
| `@huggingface/transformers` | `dependencies` | 本地小模型推理运行时（ONNX）|
| `@deepseek-ai/dsh-settings` | `peerDependencies` | 宿主服务（与 dsh-llm/dsh-session/dsh-tools 同类）|
| `vitest` | `devDependencies` | 测试框架，曾误留在运行时依赖 |

**验证手法**（模拟插件内部解析）：
```js
const req = createRequire('<插件目录>/dist/features/local-embed.js');
req.resolve('@huggingface/transformers');   // ← 能解析到才算 OK
```

### 11.15 🔴 智能回复"评分静默消失"（面板只剩门槛、没有分值）—— 完整排查链

**症状**：`value-scores.jsonl` 里**连 `score` 字段都没有**（只有 `worth:false`），
面板"最近评分"只剩"门槛 0.70"和"无分"条目，`近邻:` 全空。
**注意：QQ 里看起来"机器人不回复" = 与"算出了低分"完全一样，必须查文件才能分清。**

```powershell
# 判定：最近 200 条里带 score 的比例
Get-Content "<dataRoot>\.qqbot\value-scores.jsonl" -Tail 200 |
  Where-Object { $_ -match '"score"\s*:\s*[0-9]' } | Measure-Object
# 0 条 → 评分完全没在算（不是"算成 0 分"）
```

**根因链（按顺序核对）**：
1. **`@huggingface/transformers` 解析失败** → §11.14（最隐蔽，也最可能）
2. **模型文件缺失** → `checkModelAssets(modelDir)`（应见 4 个文件：`config.json` /
   `tokenizer_config.json` / `tokenizer.json` / `onnx/model_quantized.onnx`，约 23MB）
3. **`onnxruntime-node` 不可用**（在 profile 层 `node_modules` 里找）
4. **进程内 `failedAt` 退避中**：`local-embed.ts` 的 `RETRY_BACKOFF_MS = 60_000`，
   失败后 60 秒内不再重试 → 表现就是"这一段时间全部无分"

**直接验证模型能不能真的跑**（绕过插件，独立进程）：
```js
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL('<插件>/dist/features/local-embed.js').href);
console.log(mod.checkModelAssets(mod.defaultModelDir()));
const e = mod.createLocalEmbedder({ modelDir: mod.defaultModelDir(), enabled: true });
console.log(e.status());                     // { available, modelDir, reason }
console.log(await e.embedQuery('求抱抱'));    // 应返回 512 维数组
```
⚠️ 注意：嵌入器接口是 `warmup / embedQuery / embedPassages / status / reset / available`，
**没有 `embedOne`**（那是词面兜底 `LexicalEmbedder` 的接口）。

**修复落点**：`/local-model/status` 现在会返回 `embStatus`（含 `reason`），
面板可据此明确提示"模型加载失败：<原因>"，不再静默。

### 11.16 🔴 "从 patch 读配置"而不是"从自有存储读" —— 同类问题的完整清单

**这条坑在整个项目里出现过 5 次，每次症状都不同**。判据：`patch` = 历史遗留旧值；
**自有存储（`~/.dsh/qqbot-settings/<ns>.json`）= 用户最新保存**，永远以它为准。

| 出现版本 | 症状 | 落点 |
|---|---|---|
| **1.5.14** | 账号页填了「工作目录」保存后变空 | `/accounts` 回显只读 `b.cfg` |
| **1.5.16** | 改「Agent 预设」后界面仍显示旧人格；`nsBot()` 用错 appSecret → **掉线** | 合并方向写成"patch 优先"（反了）|
| **1.5.20** | 一打开「智能回复」面板就把评分关掉 | `/local-model/status` 读 `bot.cfg.localModel` |
| **1.5.21** | 图库/Excel 导出/计分读不到数据根 | **`nsBot()` 压根不返回 `cfg` 字段** → 下游 `bot.cfg.dataRoot` 恒为 `undefined` |
| **1.5.21** | 同上 + 评分 | `mergeOwnIntoCfg()` 漏了 `localModel` |

**统一解法**：`mergeOwnIntoCfg(cfg, nsLike)` —— **自有存储优先**，patch 兜底，
白名单字段 `appId / appSecret / preset / cwd / dataRoot / localModel`。
`nsBot()` 返回的对象**必须带合并后的 `cfg`**（并补推导出的 `dataRoot`）。

> **口诀**：桥里每见到一次 `bot.cfg.xxx`，就问一句"这里要不要走合并"。
> 新增"取账号配置"的地方，一律用合并值。

**诊断命令**（一眼看出两套值不一致）：
```powershell
Get-Content ~\.dsh\qqbot-settings\im-qqbot-3.json            # 自有存储（最终生效）
Select-String ~\.dsh\profiles\web\cordis.patch.yml -Pattern "im-qqbot-3" -Context 0,12   # patch（旧值）
```

### 11.17 🟢 提问卡片（ask_user_question）的回答权限算法 + 抢答机制

**权限来源**：`resolveCardOwner()`（`qq-user-questions.ts`）算出唯一的 `ownerId`：

| # | 规则 |
|---|---|
| **①** | 提问文本（`header` 或 `question`）里的 `<@某人>`，**openid 或昵称都认**，多个取最后一个能解析的 |
| **①b** | 没写 `<@>`、但文本里**唯一出现**某成员昵称 → 也算点名 |
| **②** | 会话最近 60 条事件里"最后一条真人消息"的点名（最后一个 `@`）|
| **③** | 那条消息的发送者壳 `[昵称 (32位openid)]` |
| **④** | 兜底：`record.senderId`（最近触发它的用户消息发送者）|
| **⑤** | 全空 → `type: 2`（所有人可点）|

**昵称匹配（`byText`）有 6 个硬条件**：①群聊 ②昵称在**群成员台账**里（= **在群里发过言**，
官方成员列表接口未开放）③昵称 ≥2 字 ④写在 `header`/`question`（**`detail` 不算**）
⑤**恰好只有一个人**命中 ⑥文本里**没有 `<@...>` 标注**（有标注时走 `byName`，不走 `byText`）

**抢答按钮（1.5.24+）**：卡片最上面多一个「🙋 我来回答」
- `permission = { type: 2 }` → **全员可点**
- 抢到 → 改写 `item.ownerId` + 标记 `claimed` + **补发一张绑他的卡片**
  （QQ 按钮 `permission` 是**发送时烘焙**的，已发出的卡片改不了）
- **白名单（`adminOwners()` = `groupAdmin.owners`）享受"无限抢答权"**：任何时候都能夺回；
  普通人严格"先到先得、抢到即锁"
- 选项回调鉴权必须**实时读 `item.ownerId`**，不能用发送时的快照（否则抢答后失效）
- 仅**单问题**时附带（一张卡最多 5 行，多问题会挤掉选项）

**固定上下文**：`FIXED_CHANNEL_CONTEXT` 里有无条件注入的「提问卡片·指定回答者」规则，
告诉 LLM"要指定某人必须写 `<@32位openid>`，只写昵称只在唯一命中时生效"。

### 11.18 📋 版本纪要（1.5.14 → 1.5.25，2026-09-28 ~ 09-30）

| 版本 | 关键内容 |
|---|---|
| **1.5.14** | `/accounts` 回显合并自有存储；`dist/` 入库 + 去掉 `prepare`（让"填 GitHub 地址安装"开箱可用）|
| **1.5.15** | 设置页填好凭据后**自动启动网关**（`settings-changed` 里检测"凭据从无到有"）|
| **1.5.16** | 合并方向修正为**自有存储优先**（此前搞反 → 改人格不生效 / 用错凭据掉线）|
| **1.5.17** | dock 回落时**选中幽灵实例** `im-qqbot` → 设置全显示默认值（过滤条件加 `&& appId`）|
| **1.5.18** | 全新实例下 **dock 位置空指针**拖垮整个 Web UI（`pos` 非对象回落 `{}` + `apply()` 逐段降级）|
| **1.5.19** | 程序兜底向量（字符 n-gram，安卓/无 ONNX 可用）；`text_break`/`reply_gate` 空 render 修复；`imageHint`/`messageReference` 保存漏写 |
| **1.5.20** | 状态路由改用自有 settings 判定兜底开关（避免一开面板就把评分关掉）|
| **1.5.21** | `nsBot()` 补 `cfg` 字段 + `mergeOwnIntoCfg` 补 `localModel`（§11.16 的两次根治）|
| **1.5.22** | 放宽 `engines.dsh` 支持 **0.2.0 系列**（dsh 0.2.0-rc.2 起强化"不兼容"提示）|
| **1.5.23** | **`@huggingface/transformers` 隐式依赖**（§11.14，智能回复静默无分的真根因）；`/local-model/status` 加 `embStatus` |
| **1.5.24** | 提问卡片「🙋 我来回答」抢答按钮（全员可点、只能抢一次、抢到即转移）；固定上下文补指定回答者规则 |
| **1.5.25** | 白名单主人**无限抢答权**（可夺回）|

### 11.19 🟢 dsh 宿主升级检查清单（每次宿主发新版都过一遍）

1. **`engines.dsh` 是否包含新版本** —— 0.2.0-rc.2 起会**强化"不兼容"提示**，
   不写新版号用户会看到"插件不兼容"。当前：`0.1.5-rc.2 || 0.1.6-alpha.2 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2`
2. **宿主服务是否被挪走** —— 例：0.2.0-rc.1 把「自动化任务」改成**可选插件包**。
   本插件用**自有 scheduler**（`{dataRoot}/.qqbot/schedule-state.json`），不受影响。
3. **第三方模型目录**（pi-ai 0.87.1 起移除部分旧模型 ID）→ **用户侧**需在面板重选。
4. **本插件实际依赖的宿主面**：`cordis` / `dsh-settings` / 客户端 `slots`·`sessions`
   —— 这几项在 0.1.5 → 0.2.0 之间**未破坏**。
5. 升级后回归三件事：**dock 球出现** → **设置页可打开** → **智能回复能算出分**。

**2026-10-04 追加（0.2.1 起必过）**

6. **先看官方 release notes 的「⚠️ 其他变更」一节** —— 那是插件作者的破坏性变更总表，比翻源码快得多：
   https://github.com/deepseek-ai/deepseek-harness/releases 。（0.2.1-alpha.1 有 4 条，其中"移除各包 `./invariant` 导出"是明确标了 breaking 的。）
   ⇒ 核对完把新增条目补进 §8.6 的表。
7. **`grep` 三样东西是否还在**（0.2.1 实测最容易踩的位置）：
   - `agent/session-start`（**0.2.1 已移除**，换成 serial 的 `agent/created`；本仓的注入走 `agent/pre-step`，安全）
   - `installSection` / `settingsScope`（**均已不存在**）
   - `settings/updated`（**已不存在**，只剩 `settings/document-updated`）
8. **peer 是否需要放宽**：`node_modules/<包>/package.json` 的 `peerDependencies` 里，凡是 `@deepseek-ai/dsh*` 且带**上界**（`^` / `<x`）的，都是下一个版本的定时炸弹 —— 改成 `>=`。
9. **`engines.dsh` 与实际值对账**：⚠️ §7 写的"只写精确版本、禁止 `>=`"是**2026-09-21 的历史口径**，2026-09-30 主人已改成放宽的 `>=0.1.5-rc.2`（见 §11.20 后的备注与 §11.21 那条 `engines.dsh` 的例外）。**以 package.json 现状 + 主人最新决定为准**，别照 §7 字面改。
10. **新版本发出去前后记得登记冷却白名单**：`~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 要加上新版本号，否则用户侧会"装到旧版"（原理见 `dsh插件开发总参考_20261011.md` §9.6）。

### 11.20 🔴 dock「聊天」页显示错乱 —— 真根因就一行判断（2026-10-01）

**症状**（主人截图）与真因对照：

| 现象 | 表面怀疑 | 真因 |
|---|---|---|
| 发送者显示成「历史」/「引用」/「请输入文本」 | 前端 sender 解析 | `chatPolishOne` 的 `tagM` 把正文里**第一个方括号**（`[历史]`）当昵称壳 |
| 头像显示 `[历]`/`[引]` | 头像算法 | 同上 —— `who` 本身就错，取首字自然错 |
| `[/历史]` 以裸文本留在气泡尾巴 | 前端只认 `[当前]`/`[引]…[/引]` | 后端没拆历史段，标记原样透传 |
| `[图片: D:\…\candidate\x.gif]` 裸文本 + **本机绝对路径外泄** | 前端没渲染 | 同上 —— 这一行整行被当正文了 |

**唯一根因**：`settings-host.js` 的 `hasHistoryBlock()` 写成
`RE_HIST_BEGIN_LINE.test(String(s||'').trim())` —— 正则要求**整行等于** `[历史]`，而真实 body 是：

```
[2026-10-01 周四 19:23]

[历史]
[方尘] [图片: D:\…\2c8f08bd49c5.jpg]
[/历史]
[当前]
[♛Брейк Фейт♛ #1001iuv] 什么？
```

`trim()` 之后整串**绝不等于** `[历史]` → 判断**永远 false** → `chatSplitHistoryBlock` 那条分支形同虚设 →
整段当"一条普通消息"进 `chatPolishOne`：① `tagM` 抓 `[历史]` 当 sender；② `[/历史]` 随正文留下；
③ `[方尘] [图片: 路径]` 整行当纯文本（路径也就跟着显示出来了）。

**修法**：改成**逐行**判断 `split(/\r?\n/).some(line => RE_HIST_BEGIN_LINE.test(line.trim()) || /\[Chat history begins\]/i.test(line))`
—— 一处修好上面四个症状。同批加固：

- 老标记 `[Chat history ends]` **没有斜杠**，`RE_HIST_END_LINE` 原来只认 `[/历史]` →
  改 `/^\[\/?(?:历史|Chat history ends)\]$/i`；所有标记正则统一加 `i`（老英文标记可能被写成小写）。
- `chatPolishOne` 开头先抹 `RE_HIST_MARK_ANY`；`tagM` 命中**标记词**（引/引用/历史/当前…）时不当发送者。
- `[图片: <本机路径>]` 整行里的路径**可能含空格**，`chatLocalTargetOf` 原来按空白截断 → 先按"冒号后到右括号"整体取。
- client 侧兜底：剥新旧历史标记、`[引用]` → `↩ 引用上文`、`[图片: 路径]` 只显文件名（**不把绝对路径写进气泡**）、
  `chatAvaOf` 不把 `[` 当头像字；`groupSelName` 有 gid 时不再硬显示 `(未选群)`。

**回归验证法（不用重启宿主就能跑）**：用 `new Function` 把 `settings-host.js` 里那段解析函数**原样抽出来**，
喂真实入站原文做断言。脚本留档：`D:\newwenjianjia\aiwork\三号机\_verify-chat-parse.mjs`。

**同一批沉淀的另外两条**：

- **多帧 zstd 读法**：`zstdDecompressSync` **只解第一帧**。QQ 侧压缩体可能是多帧拼接 →
  先按魔数 `28 B5 2F FD` 切帧，逐帧解压后再拼接。
- **「file_id 过期」假设已被证伪**：读 **20 天前**的附件**正常读出**（dsh 回放时会**重新上传**，
  Files API 的 1h TTL 不构成障碍）→ issue #6 的群会话 400 不是它，别再照这个方向改代码。
- **`engines.dsh` 的例外**：§7 写"禁止范围式声明"，但 2026-09-30 主人改为放宽成 `>=0.1.5-rc.2`
  （避免宿主一发新版就被判"不兼容"）—— **以主人最新决定为准**，§7 那句属历史口径。

### 11.21 🔴 整段系统提示词漏进 dock 聊天界面（2026-10-01，1.5.30）

**症状**：dock 某个会话的气泡里冒出整段 `<system-reminder>`（【@ 人的方法】/【提问卡片·指定回答者】/【富媒体】…），
发送者还显示成那个会话对端的昵称 —— 看着像"对方发了系统提示词"。

**根因**：会话里的 `user/message` **不只承载真人发言**，插件的运行时注入走的是**同一条通道**：

| 注入内容 | `source.kind` | 产生处 |
|---|---|---|
| 固定通道规则 + 群守则（`<system-reminder>` 包裹） | `qqbot:group-rules` | `src/session/session-manager.ts`（每回合现读 settings 拼一条） |
| QQ 审批提醒 | `plugin:qqbot-approval` | `src/features/qq-approval.ts` |
| 上下文压缩检查点 | `compact-checkpoint` | `src/features/contextless-trim.ts` |
| 其它插件 / 扩展工具 | `plugin:<name>` | 各家自便 |

而 dock 的 `chatDecodeEvent` 只挡了 `src.kind === 'plugin'`（**会话格式 V4 已废弃的写法** —— 与 §11.20 同款坑）
→ 上表几种**全漏**进聊天视图。

**修法**：`source.kind` 前缀黑名单（`plugin:*` / `qqbot:*` / `compact-checkpoint`）
+ **`<system-reminder>` 内容特征兜底**（双保险）。真人发言 `kind === 'user'`，不受影响。

**排查口诀**：dock 里凡是出现"**不是对方说的话**"（系统规则 / 审批提醒 / 压缩刻度 / 插件通知）
→ 先去 `chatDecodeEvent` 看该事件的 `source.kind`，再决定"拉黑"还是"打 tag 展示"。

**同类正例（对照组，别一起拉黑）**：
- `[系统] 后台任务…` → 显示成 bot 侧气泡 + tag「后台任务」
- `用户代你发送: ` → 显示成 bot 侧气泡 + tag「面板代发」
- Web 直聊（`src.rpcId`）→ 打 tag「Web」

**发版记录**：`1.5.30` 一次带上 §11.20（聊天页显示错乱）+ 本节（注入过滤）+ 引用块保留原文 + 扩展工具可拿 `ctx`/`logger`。
GitHub 已推（`a8ef002`）；npm 暂存发布待补 —— 本机 `~/.npmrc` 里的 granular token 已失效（`E401`），
需 `npm login` 或到 npm 站点重新生成 token。



---

## §11.22 无上下文模式 · 智能判断（AI 自主压缩 + AI 自主备忘）

2026-10-01 新增能力：让 AI 自己判断话题是否结束，自主调用工具**压缩**（保留最近几条）或**丢弃**上下文，
只留下它自己写的**备忘**（存独立文件、压缩碰不到）。

- 设计定稿、实现要点、踩坑记录、验证方法论、专家团结论、进度表：
  见 **`参考文档/无上下文模式-智能判断-设计与实现.md`**
- 三条不可动摇的原则：① 这是**压缩系统不是记忆系统**；② **AI 自主**（不做阈值/向量判定）；
  ③ 工具与提示**只在「无上下文模式+智能判断」开启时出现**。
- 最容易踩的一条：压缩**不能**用官方 `ctx.compaction.compactNow`（回合内必报
  `requires an idle agent with no waking queued work`）→ 必须走**登记式**（工具写 pending，
  下一回合 `agent/pre-step` 里调我们自己的 `trimHistoryForContextless`）。

---

## §11.23 QQ 群管理 · 踢人 + 免扫码登录（v1.6.2，2026-10-02）

**背景**：官方 Bot API **没有开放踢人**（`GroupAdminClient` 里 `removeMembers.open = false`），
所以踢人改走「**主人自己的 QQ 号** + 群官网 `qun.qq.com`」，并把登录做成「**扫一次码、之后全自动**」。

- 完整设计与 17 条踩坑：见 **`参考文档/QQ群管理-踢人与免扫码登录-设计与实现.md`**
- 新增：`src/features/qun-admin.ts`（纯 HTTP 群列表/成员/踢人）、`src/features/qun-login.ts`（spawn Edge + CDP）、
  AI 工具 **`qq_group_admin`**（`channel-tools.ts`）、面板端点 6 个（`settings-host.js`）、
  dock 的 **🔨 锤子**（`client/qqbot-settings.js`：`🔇禁言` / `👢踢人` 两个子标签）
- ★ **登录态唯一真相源 = `{dataRoot}/qun-cookie.json`** —— 面板与 AI 读写**同一个文件**，
  所以"共享"是**白送的**，不需要任何同步逻辑（面板登过 AI 立刻能用，反之亦然）

**三条最容易忘的**：

1. 踢人接口 `delete_group_member` 的成员参数是 **`ul`**（不是 `uin` —— 传 `uin` 返回 `ec:5`），
   且要放 **POST body**；调 `qun_mgr` 的 UA 必须是**朴素 `Mozilla/5.0`**（用完整浏览器 UA → 404）
2. **宿主 spawn 的浏览器窗口到不了用户桌面**（`headless=false` 也一样，实测 11 个进程窗口句柄全 0）
   → 别指望"弹窗口让用户扫"，二维码只能走**本地文件路径 / 网页端点**
3. 浏览器 **session cookie 不持久化** → 凭据必须存文件，每次启动用 CDP `Network.setCookie` **注入**回去

**面板侧一个必踩**：`api(path, q)` 的 `q` 是**字符串 query**，不是对象（传对象 → `?[object Object]`，请求直接废掉）。

**验证纪律（本轮最大教训）**：AI 助手本身**不是 QQ 会话**（走 web/终端），所以它**测不到插件工具层** ——
分层验证必须包含：① 底层脚本直调接口 ② 直接 import 编译产物调模块 ③ **在 QQ 会话里让 AI 真调一次工具**
④ 面板点一遍 ⑤ **绕过前端直接打后端端点**（用来区分是前端的锅还是后端的锅）。

**另一个坑（发布侧）**：npm 12 起 publish 走**暂存流** —— 输出会打印 `+ 包@版本` 却查不到，
真实原因是 `409 Cannot publish over previously staged version`；要用
`npm stage list` → `npm stage approve <stage-id> --otp=<6位码>` 由主人审批。

---

## §11.24 🔴 多实例下「裸 `webServer.register`」会被拆成两个闭包（v1.6.8，2026-10-05）

**症状**：插件「Web 会话列表自动重排」在生产完全不生效。诊断端点
`GET /api/qqbot-settings/workspace/debug` **永远返回 `watchers: 0`**，
**但同一时刻用 curl 订阅 SSE 却能收到 `: connected`**。

**根因**：`/api/qqbot-settings/workspace/watch` 当初**绕过 `route()` 的去重、用裸
`ctx.webServer.register` 注册**。而 `route()` 的按 path 去重是**模块级**的
（`const routeByPath = new Map()`）。profile 里有**两个真实例**
（`im-qqbot-2` + `im-qqbot-3`，各 `apply` 一次）⇒

- SSE handler 落在 **A 实例**的闭包，订阅集合 `wsWatchers` 是 A 的那份
- `debug` / `test-reorder` 走 `route()`，而 `route()` 里 `reg.handlers.set(m, handler)` 是
  **无条件覆盖**的 ⇒ 第二个 `apply` 把它们换成 **B 实例**的闭包 ⇒ 读的是 **B 的那份**集合
- ⇒ 浏览器把连接加进 A、debug 读 B ⇒ **`watchers` 恒 0**，推送全发给空集合（前端什么都收不到）

**铁证**：curl 拿到 `: connected` 的同一秒，debug 仍报 0（写的读的不是同一份）。

**改法**：把「订阅集合 / 最后广播状态 / 注册 / 事件绑定」全部收敛到**全局单例**：

```js
const WS_HUB = (globalThis.__qqbotWorkspaceWatchHub || (globalThis.__qqbotWorkspaceWatchHub = {
  watchers: new Set(), last: { at: 0, sessionId: '' }, registered: false, bound: false,
}));
```

注册端与事件绑定端各加一道 `if (!WS_HUB.registered)` / `if (!WS_HUB.bound)` 闸门，
保证**全进程只做一次**。这正合**铁律 8**「跨模块实例可见 ⇒ 存 WeakMap/globalThis，
**绝不存模块级变量**」。

**排查口诀**：长连接端点（SSE / WebSocket）**不能走 `route()` 的去重语义**，
但也**绝不能裸注册多次** —— 要么全局单例，要么按实例名加后缀。
只要出现「浏览器说连上了、服务端说没人连」，先怀疑**两个闭包**。

---

## §11.25 🔴 `localStorage` ≠ 内存 store —— 改侧边栏顺序必须「派发原生拖拽」（v1.6.8，2026-10-05）

**症状**：重排"算对了"（日志有 `web 会话列表已重排: <sid>`、localStorage 里顺序也真变了），
但**页面纹丝不动**；过一会儿（折叠个分组 / 换个排序方式）顺序又**自己变回去了**。

**根因（两层）**：

1. **侧边栏顺序的唯一真源是内存 store** —— `dsh-client-ui-workspace` 里的 zustand vanilla store，
   由 `dsh-client-store` 的 `createSnapshotStore` 建。持久化是**单向**的：
   `dsh-client-store/lib/index.js:111-125` `attachPersistence` = **启动读一次** +
   **store 变化时往下写**，**没有 `storage` 事件监听**。⇒ 外部 `localStorage.setItem`
   既不触发重渲染，又会被下一次任何 store action（折叠/换序/置顶）**整份覆盖回去**。
2. **拿不到那个 store 实例**：`defineStore(decl)` 是**工厂**（`create(scopeKey)` 每次新建），
   **没有全局注册表** ⇒ 外部插件无法按名字取到 SPA 那一份。

**正解：走用户的真实入口 —— 派发原生 HTML5 拖拽**，让宿主自己的 `drag.start/hover/drop`
去改内存 store（⇒ 立刻重渲染 + 自动持久化）。

契约（`dsh-client-ui-workspace/lib/client.js`）：

| 环节 | 宿主的要求 |
|---|---|
| 源行 `onDragStart`(:2253) | `dataTransfer.setData("text/plain", node.id)` **且** `drag.start()` |
| 目标行 `onDrop`(:2265) | 仅当 `drag.active` = `sameGroupDrag && drag.pinned === node.pinned`（**同组 + 同置顶状态**） |
| `rowHalf(e)`(:1902) | `e.currentTarget.getBoundingClientRect()` + `clientY` 在**上半** ⇒ `"before"` |
| 落点计算 | `sessionDragOrder()`(:2929) → `commitSessionDrag()`(:3044) → `setSessionOrder(accountKey, nextOrder)` |

实现要点（`client/qqbot-settings.js` 的 `reorderByDom()`）：

- 源行/目标行 = `[role="treeitem"][data-row-key]`；**`workspace:` 行是分组边界**，顺序遍历即得 `{ws, sid, el}`
- 事件用 `new DragEvent(type, {bubbles:true, cancelable:true, composed:true, dataTransfer: new DataTransfer(), clientY})`
- ★ **`dragstart` 与 `dragover`/`drop` 之间必须留时间让 React 重渲染**（`setTimeout` 40–80ms）——
  `drag.active` 是**渲染期算出来的**，同一个 tick 里派发 `drop` 会因 `active === false` 被直接 `return`
- 置顶会话**绝不参与**（宿主也不允许跨「置顶/非置顶」互落）
- 判定完顺手比对 `localStorage` 前后值，把「✅ store 已更新 / ❌ 未变」打进控制台 —— 便于用户自查

**排查口诀**：凡是「改 dsh 前端某个持久化状态」的需求，**先问这个状态的真源是内存还是磁盘**。
真源是内存 ⇒ 只有三条路：① 走它自己的用户交互（如本条的原生拖拽）② 拿到它的 store 实例
③ 改宿主代码。**只写 localStorage 一定不可靠。**

**顺带两条事实**：`onTick` 是契约占位、框架从未调用（要定时请自己接 `sweep` 计时器）；
`ready` 字段（`settings-host.js:3059`）客户端**根本没读**，是死字段 ——
「宿主没起来就不排序」这条安全约束靠的是 **SSE 连不上**隐式达成的。

---

## §11.26 🔴 「静默 append」会把新会话的日志写废 —— surface 首节点必须是 `system/message`（v1.6.9，2026-10-06）

**症状**：用户的某个会话在 web 面板里报
`历史加载失败: stored session "…" is corrupt: … SessionFormatError: system/message requires a
protected first surface head`，且该会话**连工作区也挂不上**（读不出 Header）⇒ 侧边栏落「未分组」。

**判据（宿主侧）**：`dsh-session-format-v3-to-v4/lib/index.js:597-617` 的 `foldSurface`：

```js
if (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0)
    throw new SessionFormatError("system/message requires a protected first surface head");
if (event["surfaceOp"] === "append") {
  if (event.type === "system/message" && this.surface.length === 0) this.protectedHead = event.seq;  // ← 只有这次能立头
  this.surface.push(event.seq);
```

⇒ **`system/message`（人设）只能是 surface 的第一个节点**。任何别的 surface 类型事件
（`user/message` / `developer/message` / `assistant/message` / `tool/result`）**先落**，
这条会话的人设就**永远补不进去了** —— 一旦 dsh 在首次回合补写人设，日志当场报废。
（非 surface 类型不受限：`session/title` / `permission/preset` / `sandbox/mode` / `approval/policy` 随便先写。）

**成因**：本插件的「静默入库」路径**不唤醒 AI**（价值评分拦截 / `nothink` / 群事件汇总 /
卡片 `append_silent` / `/inject` / `/outmode`）。
**全新会话**里还没有任何回合 ⇒ 人设还没落 ⇒ 此时 `sess.append('user/message', …, {surfaceOp:'append'})`
就抢占了 surface 头把交椅。**之后**这条会话第一次被真正唤醒时 → 炸。

> 实测：`鲸鱼娘` 工作区 **466 个会话里 13 个中招**，且当天仍在新增。
> 坏档 surface 起始 `user#3 → user#5 → user#6 → … → system#11`；
> 正常档 `system#8 → user#9 → user#10 → …`。

**修法（v1.6.9）**：`src/session/surface-guard.ts` —— **`canSilentlyAppend(session)`**，
**只有 surface 第一个节点是 `system/message` 时才允许静默 append**：

- 判据①（最权威）：`session.surface.nodes[0]` 对应的 `session.log[seq - surface.baseSeq].type`
- 判据②（回落）：扫 `session.log`，取**第一个 surface 类型事件**看它是不是 `system/message`
- ★ **fail-closed**：结构不认识 / 抛异常 / 两条都走不通 ⇒ 一律返回 false（宁可不写）
- 接入点 6 处：`transport/inbound.ts`（价值评分拦截 + `nothink`）、`features/group-hub.ts`、
  `features/botplay.ts`（`append_silent`）、`commands/inject.ts`、`commands/outmode.ts`
- 跳过时**内容不丢**：下次真人消息唤醒由 `[历史]` 段带入正文；`group-hub` 自动落到
  宿主 `agent.inject()`（回合内安全排队、不唤醒）

**验证手法（可复用）**：

1. dsh 的 `.jsonl.zstd` 是**多帧 zstd 拼接** —— Node 的 `zstdDecompressSync` **只解第一帧**！
   必须自己按魔数 `0xFD2FB528` 逐帧切（算法抄 `dsh-session-persistence-jsonl` 的 `scanZstdFrames`）。
2. 复刻 `foldSurface` 的判据做**批量体检器**，扫一整个 cwd 桶就能给出「N 个会话中 M 个损坏」。
3. 把真实日志喂给 `canSilentlyAppend({ log: events })` 做**回放验证**：
   要求「已废档 100% 被拦、正常档 0 误伤」。实测 13/13 拦住、0 漏放。

**排查口诀**：任何**不唤醒 AI 就往会话里写**的路径，先问一句
**「这条会话的人设落了没？」** —— 没落就**别写**。

---

## §11.27 🟢 三套用户扩展：能力包 / 遥控器 / 自重启（v1.7.0 + v1.7.1，2026-10-06）

### 背景：三套扩展的能力面原本严重不均

插件有三套**用户扩展**，都住在 `{dataRoot}/.qqbot-extensions/`（**插件升级/重装永不覆盖** —— 这是本插件
一贯的"用户资产与代码分离"设计）：

| 目录 | 是什么 | 谁触发它 |
|---|---|---|
| `commands/*.mjs` | 自定义斜杠命令 | 人在 QQ 里发 `/xxx` |
| `tools/*.mjs` | 自定义 QQ 工具 | **AI** 调 |
| `botplay/*.mjs` | 卡片事件模块（1.6.7+） | 人点卡片按钮 |

改造前**能力面差得很远**：

| 能力 | botplay 卡片 | 扩展工具 | 自定义命令 |
|---|---|---|---|
| 宿主 ctx（遥控器） | ✗ | **✓ `env.ctx`**（1.5.30 起） | ✗ |
| 发文本/图/文件 | ✓ emit/markdown/image | 裸 `sender`+`replyTarget` | △ 只有 `ctx.bot.sendText` |
| @人 | ✓ | ✗ | ✗ |
| 持久化 store | ✓ | ✗ | ✗ |
| 官方 API「钥匙」 | ✓ appId/appSecret/api | ✗ | ✗ |
| 唤醒 AI | ✓ appendWake | ✗ | ✓ 返回 `{wake}` |
| 按钮回调 | ✓ | ✗（做不到） | ✗ |
| 定时 | ✓ onTick(占位) | ✗ | ✗ |

**最直白的后果**：主人为了"发一张 markdown"，专门写了个 `tools/send_md.mjs`（1711 字节，
内容就一行 `sender.sendMarkdown(target, text)`）。同样的活在 botplay 里是 `ctx.markdown(...)` 一行。
⇒ **三套不统一，用户就得自己接生。**

### v1.7.0：统一能力包（`src/features/ext-capabilities.ts`）

`makeExtCaps(deps)` 产出一套成品能力，**三处注入同一个面**（平铺在 `env`/命令 ctx 上，另留 `caps` 命名空间）：

- 发送：`text` / `markdown` / `markdownCard(md, keyboard)` / `image` / `voice` / `video` / `file` /
  `media(kind, src)` / `at(openid)`
- **官方 API**：`api(path, {method, body})` —— ★ **自带 token + 2h 缓存**
  （`POST bots.qq.com/app/getAppAccessToken`），**不依赖 `groupAdmin.enabled`**（第三方用户开箱即用）；
  注入了 `apiCall` 就优先用注入的
- **钥匙**：`appId` / `appSecret`（想自己换 token 调任意接口时用）
- **持久化**：`store.load()` / `store.save(obj)` → `{dataRoot}/.qqbot-extensions/{tools|commands}/data/<文件名>.json`
- **上下文**：`appendSilent(text)` / `appendWake(text)` —— ⚠️ **`appendSilent` 内置 §11.26 的表面守卫**
  （新会话不安全时直接返回 `false`，绝不写坏日志）；`appendWake` 走 `agent.followup`（正常回合，天然安全）
- 身份：`user.openid/name/isOwner`、`owners`、`peer.scope/peerId`；杂项：`log(...)`

**三条设计原则（改这个文件时守住）**：

1. **优雅降级**：拿不到依赖 ⇒ 返回 `false` / 结构化错误，**绝不抛错**打断用户的扩展
2. **空白文本拒绝**：`trim` 判空，但**发出去的仍是原文**（不裁剪内容语义）
3. **媒体源双形态**：`{url}` / `{localPath}`；传字符串时自动判 —— `http(s)://` ⇒ `url`，否则 ⇒ `localPath`

### v1.7.1：遥控器 + 说明书 + 自重启

**① `kernel`（"遥控器" = 插件自己的 cordis `ctx`）三套齐**

| 扩展 | 路径 | 接线点 |
|---|---|---|
| 工具 | `env.ctx` | 本来就有 |
| 命令 | `env.ctx` | `setupMiddlewares(bot, config, manager, logger, pluginCtx)` 第 **5** 参；`bootstrap.ts:151` 传 `ctx` |
| 卡片 | **`ctx.kernel`** | `BotplayController._kernel` + `setKernel()`，bootstrap 构造后注入 |

⚠️ **卡片为什么叫 `kernel` 不叫 `ctx`**：卡片那个对象自己就叫 `ctx`，`ctx.ctx` 太晕 ⇒ 换名。
**改这里时别图省事统一叫 `ctx`，会撞车。**

**② `docs/host-services.md`（59 个真实服务名）** —— **光给遥控器不给说明书等于没给**。
清单是**从 dsh 源码 harvest** 的（不是猜的）。宿主升级后想刷新，重跑：

```powershell
Get-ChildItem "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai" -Directory | ForEach-Object {
  Select-String -Path "$($_.FullName)\lib\*.js" -Pattern 'ctx\.get\("([a-zA-Z][a-zA-Z0-9_.-]*)"\)' -AllMatches -ErrorAction SilentlyContinue
} | ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
```

**③ `env.restart({requireOwner, delayMs})`** —— **复用内置 `commands/exit.ts` 的 `selfRestart()`**，
**绝不让用户自己 spawn**（很容易写错）。`selfRestart` 已填平的坑：
动态识别启动命令、**强制补 `--no-open`**（否则每次重启弹浏览器）、助手写系统 tmpdir（避开中文路径）、
detached + unref（宿主被杀照样能拉起）。

- **默认 `requireOwner: true`** —— 只有主人触发才生效，防 AI 被群友一句话钓去重启机器人
- 要放开一行就行：`env.restart({ requireOwner: false })`（用户的机器用户做主）
- 每次触发**留痕**：`[ext-caps] … 触发了宿主自重启(owner=… actor=…)`

### 🧪 测试纪律（这条比功能本身更值得记）

**`restart()` 真跑会 spawn 助手去 `process.kill(宿主 PID)`** —— 在测试里等于**自杀**，
而且助手还会尝试把 dsh 重新拉起来。

⇒ 所以 `ExtCapsDeps` 留了一个 **`restartImpl?: (delayMs?) => boolean` 注入接缝**，**测试必须用桩替换**。

冒烟测试脚本：`D:\newwenjianjia\aiwork\三号机\_caps-test.mjs`（**50 项**）：

```powershell
cd "D:\newwenjianjia\aiwork\鲸鱼娘\m1\dsh-qqbot-public - 副本"
npm run build ; node "D:\newwenjianjia\aiwork\三号机\_caps-test.mjs"
```

覆盖：发送路由（text→sendText / image→sendMedia(image) / http 串自动转 url…）、`at`、身份判定、
store **落盘+回读+磁盘校验**、API 注入优先 / 无凭证结构化报错、
**上下文守卫（新会话必拒、老会话放行）**、kernel 原样透传、**restart 四种分支**、全量优雅降级。

**排查口诀**：凡是给"用户自己的代码"加能力，先问三句 ——
**① 拿不到依赖会不会抛错？② 这条能力在测试里跑一次会不会把宿主机搞坏？③ 有没有留痕？**

### 顺带记两条事实

- **扩展 = 全权限**：扩展文件是被 `import()` 进宿主进程的普通 Node ESM ⇒ `node:fs` / `child_process` /
  `fetch` / 扩展根下的 `node_modules` 全都可用。**能力包提供的不是"权限"，是"别写错 + 能降级 + 有留痕"。**
- **扩展做不到的两件事**（是边界不是权限）：① **不能改插件内部实现**（除非以后做 mod 覆盖层）；
  ② **不能注册按钮点击回调**（只能由 botplay 事件 / dock 卡片编辑器注册）。

### 一条已知遗留（未修）

**`workspace-attach` 的 attach 竞态**：插件建完会话**立刻** fire-and-forget 调
`workspace.attachSession()`；而宿主要**读会话 Header** 来校验（`dsh-workspace/lib/index.js:111-129`
—— 先查活会话、再查缓存、最后扫磁盘，取不到就抛 `session persistence holds no such session`）。
新会话头还没落盘 ⇒ 抛错被 `catch` 吞掉 ⇒ 会话落在「未分组」（等下次被消息触发才挂上）。
**实测证据**：`鲸鱼娘` 工作区 466 个会话里，同一段代码**有的挂上、有的没挂上**（`67bec37c` 在，`3baae867` 不在）。
修法方向：给创建路径加**退避重试**（0/300/900/2000/5000ms，成功即停），并把失败写进
`~/.dsh/qqbot-archive.log` 便于离线排查。

---

## §11.28 🟢 忙时消息「排队 / 插话」可设置 —— 回合内轮次之间即时插入（2026-10-07，v1.7.4+）

**需求（主人 2026-10-07 原话）**：宿主「设置 → 通用设置 → 繁忙时的发送行为」有"排队发送 / 插话发送"；
我们也要能给 QQ 侧选 —— 消息**依然聚合**，但插话模式下可以在**回合内的轮次之间**立刻把群友消息插进去，
而不是死等这轮回合结束。

**改动清单**
| 位置 | 内容 |
|---|---|
| `src/config.ts` | `behavior.debounce.busySendMode: 'queue' | 'interject'`（默认 `queue`）；`DebounceConfig` 接口 + `debounceSchema` + `behaviorSchema` 默认值**三处都要加** |
| `src/gateway/debounce.ts` | flush 的"回合忙"分支分流：`interject` → `interjectBatch()` 注入一批 → 清窗口 + 清群历史缓存；注入不可用/抛错 → **回落原排队逻辑**（消息不丢）。新增 `busySendModeOf / buildInterjectText / attachmentNote / voiceTextOf / shortSender / INTERJECT_NOTE`；`DebounceEntry` 加 `processed` |
| `client/qqbot-settings.js` | 「延迟聚合」组内加一组 radio（排队发送 / 插话发送）+ 说明文案 |
| `src/transport/inbound.ts` / `outbound.ts` | 无改动（"上次回复前群友所发"那条老提示只服务排队模式） |

**关键实现点**
1. 插话通道 = `agent.inject(createUserMessage({content:[{type:'text',text}], source:{kind:'user'}}))`
   —— dsh 底层 `send(msg,'next-step',wakeup:false)`：**不唤醒、不拆 tool_calls**，宿主在下个 step 组包时带上。
   同款姿势早已用在 `qq-approval`（审批留痕）、`group-hub`（群事件）里。
2. **每次插话都带轻提示，但必须极短**（主人当天三连改口：先"仅首次" → 改"每句都提示" → 再补一句
   "**系统提示太长了，浪费 token**"）。最终文案就一行：
   `[插话] 你思考/输出期间群友新发的消息(非对你的回应): 先做完当前任务, 再按需回应。`
   —— 只留两个不可省的语义（①这是她输出期间**新插进来**的、②**先做完当前任务**），**别再往里加解释性长句**。
   顺带把 `inbound.ts` 那句老的聚合提示一起瘦身（140+ 字 → 一句）：
   `[系统提示] 以下是你思考/输出期间群友发的消息(非对你的回应), 通读后综合回应(如需回应)。`
3. **语义边界**：若她这一步是纯文字收尾（后面没有 step），注入会留在队列里**等下次唤醒**才被消费 ——
   效果等同排队。这是宿主 inject 的固有语义，不是 bug（已写进设置页说明）。
4. 插话是"即时补料"不是"派发回复"：**不唤醒 ⇒ 不消耗群冷却**，所以插话分支不碰 `cooldownAt`（也就没有回滚一说）。
5. 插话只有文本通道：图片走 `lookupImagePath` 给**本地路径**（省 token、她能直接读盘）、
   语音取 `state.processed` 的转写文本 —— 为此 `DebounceEntry` 加了 `processed`，入窗时从 `ctx.state.processed` 带出来。
6. 插话后**清群历史缓存**（`clearGroupHistory`，与正常派发同款）：否则这批消息这轮插过一次、下轮又被当 `[历史]` 打包一遍。
7. 埋点：`logger.debug('[debounce] 插话成功(回合中…)')`；`DSH_QQBOT_DEBOUNCE_DBG=1` 时 `debounce-dbg.log` 记 `flush 插话 inject(回合中) …`。

**踩坑（本次实测）**
- `behaviorSchema.default` 与 `debounceSchema.default` 是**两份默认值**：新字段必须**两处都加**，漏一处 tsc 直接报 `TS2322`。
- client 是手写 hyperscript：**改完必须 `node --check client/qqbot-settings.js`**（本次漏了一个闭合 `)`，
  表现为"设置页整个白屏 / 文件加载即语法错"）。
- 本机沙箱（read-only / workspace-write）写 `项目/dist` 与 `~/.dsh/profiles/...` 都是 EPERM
  ⇒ **tsc 编译与部署同步都要 `danger-full-access`**（`pwsh` 的 `sandbox_permissions`）。

**怎么测**
1. 重启宿主 → 设置页「QQ 机器人 → ① 多久回一次消息 → 延迟聚合」看到新 radio；
2. 切「插话发送」保存（live 热更，不用重启）→ 群里先 @ 她一个要跑一会儿的活，**趁她还在输出**连发两条普通消息
   → 看她是否在**同一回合的下一次工具调用之间**就读到（web 会话流里会出现一条注入的 user 消息，带那句轻提示）；
3. 切回「排队发送」→ 同样操作应表现为"攒着等这轮回完"再整批送 + 那条"上次回复前群友所发"的系统提示。

---

## §11.29 🟢 提问卡片「后台提问」—— ask_user_question 不再卡她的回合（2026-10-07，v1.7.4+）

**需求（主人原话）**："问题卡片有没有办法改成不卡 llm 的思考的改成后台任务，就是 ai 提出问题卡片后，
ai 可以等 qq 返回结果，期间还可以继续和群友对话"。
**定档（同日卡片确认）**：① 默认「后台提问」，同时保留「阻塞等待」可切；② 答案回来时 **忙时插话、空闲唤醒**。

**机制现状**：宿主 `user-questions/request` 是 Agent 作用域 waterfall（dsh-user-questions：UserQuestionService.ask → waterfall），
我们的 `QqUserQuestionsController.request()` 拿到后返回一个 **Promise** 给宿主 → 宿主 await → **她这一回合就挂在这儿**
（期间群友的消息只会被 debounce 攒着，她一句话也回不了）。

**改法**（`src/features/qq-user-questions.ts`）
| 档 | `request()` 返回 | 答案到齐 / 超时后 |
|---|---|---|
| `async`（新默认） | **立刻**返回占位答案 `custom: '（已发出提问卡片…答案稍后会自动送回来…不要重复发问）'` | 不 resolve；改 `deliverAnswers()` 把答案当**回执消息**投回会话 |
| `blocking`（旧行为） | 返回等待 Promise（同以前） | `group.resolve({ answers })` |

- `deliverAnswers()`：组装 `[提问卡片·回执] 你之前发出的提问有结果了(后台送达)：\n「问题」→ 答案`
  · 她**忙**（`record.turnActive === true`）→ `agent.inject()`：不唤醒、插到下个轮次边界（与 §11.28 插话同款通道）；
  · 她**闲** → `agent.followup()` **唤醒**（并刷 `lastInboundAt`、置 `turnActive`，与真人入站同语义）。
- 超时（`approvalTimeoutMs`）与 `signal` 取消都汇到 `finishGroup` → 同样投一条"超时未答"回执，**答案不会静默消失**。
- `dispose()`（热重载/卸载）对 async 组只清 pending，不再往可能正在销毁的会话投递。
- 设置项：`questionsMode: 'async' | 'blocking'`（默认 `async`）→ constructor 的 `modeProvider` **现读**（live 热更）；
  bootstrap 传 `() => config.questionsMode === 'blocking' ? 'blocking' : 'async'`；
  设置页：QQ 机器人页新增「⑥ 提问卡片(她问人时要不要在旁边干等)」radio。

**踩坑 / 注意**
- 占位文案必须写明"**答案稍后自动送达 + 别重复发问**" —— 否则她可能以为没人理，**反复发卡**
  （这是 async 化最大的行为风险）。
- 别顺手把 async 的 `group.resolve` 也调了：宿主 Promise 早已返回，再 resolve 无事发生，
  但会让"谁负责投递"含糊；**保持单一出口 = `finishGroup` 分流**。
- QQ 侧回执（"已选择：xxx"）、Web 浮层兜底、`/答 A`、文字兜底、抢答按钮**全部不变** —— async 只改"答案怎么交回 LLM"。
- `pending` 生命周期不变：答完/超时都会清；`listPendingForWeb` 无需改动。

**怎么测**：重启宿主 → 设置页确认「后台提问」→ 群里 @ 她要个问题卡片 →
**卡片发出后她应立刻能继续跟你说话**（不再卡住）→ 点一个选项 → 看她是否自动收到一条"[提问卡片·回执]…"
（她正忙就插进当前回合，闲着就被唤醒接着处理）。

---

## §11.30 🔴「没开无上下文模式，也冒出 context_compact / context_drop / context_memo」（2026-10-07，v1.7.5+）

**症状（主人实测）**：面板出现「工具已更新 · 新增 3 个：context_compact, context_drop, context_memo」，
但主人**没开**「无上下文模式」（全局关；当前群在 `contextless.json` 里也是 `enabled:false, smart:false`），
却仍能调用（实测 `context_memo(action=list)` 正常返回，而不是"工具不存在"）。

**排查路径（可复用三招）**
1. 看**会话级存储** `{dataRoot}/.qqbot/contextless.json`：全局关闭时，本应只有开了的会话才有工具。
   本案只有另一个群（`86976CE6…`）是 `enabled:true, smart:true`。
2. 看**注册日志** `~/.dsh/contextless-trace.log` 的 `[ctxtool-reg] shouldHave=… 挂载=N 件 sk=…`：
   本群是 `shouldHave=false 挂载=1 件` —— 说明 **agent 作用域**那层确实没挂那三个工具（那 1 件是 QQ 群管理）。
3. 可**实测能调通** ⇒ 说明还有**第二份注册**在别的作用域。顺着 `syncContextTools` 的全部调用点查就撞见 apply。

**根因**：`src/channel-tools.ts` 的 apply 段有一行
```ts
try { syncContextTools(ctx, true); } catch { /* ignore */ }   // ← 写死 true
```
它把三个上下文工具**无条件**注册进**插件作用域**；而真正按会话开关裁决的是 `session-manager` 每个 pre-step 调的
`syncContextTools(rec.agentCtx, ctxSmartOn)`（**agent 作用域**）。**两次是不同对象** ⇒
注释承诺的"开则保持、关则注销"只注销了 agent 那份，**插件那份永远撤不掉** ⇒ 没开的会话也能调用。

**修法**：apply 那次传 `false`（不再预注册这三个工具；②段的 QQ 群管理工具照旧挂，语义不变），
三者完全交给 pre-step 按会话裁决。⛔ **别改回 `true`**。代价：开启的会话若在极早期回合看不到工具，
下一个 step（pre-step 每 step 都跑）就会出现 —— 远好过"人人都有"。

**教训（比这个 bug 更值钱）**
- **同一能力若有两条注册路径，必须保证两条动的是同一个对象/作用域**；否则"幂等刷新 / 可注销"只是自我安慰。
  这是 §1「铁律 8（动态挂载一律幂等刷新）」的补充：**不只是"能撤销"，还要"撤得掉的是同一份"**。
- 排查"开关不生效"类问题，**先分清作用域**（插件 ctx / agent ctx / 宿主全局），再谈逻辑对错。
- 验证成本最低的一招：**直接调那个只读工具**（如 `context_memo action=list`）——
  能返回就说明它真挂着，比读代码猜快得多。

---

## §11.31 🔴「主人点审批卡片 / 发 /approve 都被回『你无权处理』」（2026-10-08，v1.7.5+）

**症状（主人实录）**：QQ 收到审批卡片（工具 `edit`，改群守则），
**界面允许他点按钮**，但点下去机器人回"你无权处理这项权限申请。"；
改回 `/approve L3CBMR` 也一样被拒；最后只能 `/权限 全权`（直接切沙箱档位）绕过去。

**根因：同一件事有两份判定口径，而且只有一份被修过**
| 环节 | 代码位置 | 判定口径 |
|---|---|---|
| 发卡片（谁可点） | `request()` → `specify_user_ids` | **发起者 + `groupAdmin.owners` 白名单** ✅（2026-09-28 修的） |
| 按钮回调校验 | `handleInteraction()` | 只认 `record.senderId` ❌ |
| `/approve` 校验 | `handleInbound()` | 只认 `msg.senderId === rec.senderId` ❌ |

⇒ 白名单里的人**看得见、点得动**按钮/发得出命令，却在服务端被拒 ——
体验上就是"我没权限点击"。**2026-09-28 那次"让主人也能批别人发起的审批"只改了发卡那一步**。

**修法**
- 新增私有方法 `allowedDeciders(rec) = {rec.senderId} ∪ manager.adminOwners()`；
- `handleInteraction` 与 `handleInbound` **都用它**（同一口径，且直接写进注释：⛔ 别再各写一份）；
- 两条路各加一行 warn 日志：打印 `presser/sender` 尾号 + allowed 名单尾号 + `scope/peer/samePeer`
  —— 以后再遇到 `group_member_openid ≠ user_openid` 这类命名空间不一致，日志一眼可辨。

**教训**：**"谁有权"这种判定绝不能散落多处** —— 改一处忘一处，症状最别扭：
"界面放行、服务端拒绝"。排查口诀：**顺着用户能做的动作逐段找校验点**
（发卡片 → 点按钮 → 发命令，三处都要翻）。

---

## §11.32 🟢 扩展工具也能收「按钮回调」了 —— `ext:` 前缀 + 卡片注册表（2026-10-08，v1.7.5+）

**需求来源**：`记住的东西/QQBot插件改造需求_扩展工具按钮回调.md`
（起因：想做「群投票」，但扩展工具发的卡片收不到点击事件、也拿不到点击者身份）。

**新增**
| 文件 | 作用 |
|---|---|
| `src/features/ext-tool-cards.ts` | 卡片注册表 `{dataRoot}/.qqbot/ext-tool-cards.json`：原子写（tmp→rename）、过期顺手清、**写失败 fail-soft**；`parseExtToolButtonData()` 解析 `ext:<工具名>:<卡id>:<按钮id>` |
| `src/features/ext-tool-interaction.ts` | 分发控制器：前缀 → 查表 → 按名加载模块 → 调 `onInteraction(ctx, info)` → 回执 → 消费 |
| `examples/ext-tools/vote.mjs`（+README） | 能直接跑的「群投票」示例：一人一票、按人计票、重复点识别、票数落 store |

**改动**
- `extension-store.ts`：`ExtensionToolDef` 补可选 `onInteraction`（归一化时保留；**没有导出 = 与老行为完全一致**）
- `ext-capabilities.ts`：caps 增 `registerInteractionCard({cardId, buttonIds, expireAt})`
  （工具名由插件用 `selfName` 自动填，会话坐标也自动带上）
- `bootstrap.ts`：交互分发串在 botplay 之后、`bpk:` 裸卡兜底之前插 `extToolInteractionController`；
  **顺手修** `runButtonCommand` 的 `senderId`（原写死空串 → 现在补点击者 openid，
  `CardCommandExecutor` 加可选第三参、card-callback 里面透传）
- 工具侧契约：发卡前登记 → 按钮 `action.type=1` + `data=ext:工具名:卡id:按钮id` → 导出 `onInteraction(ctx, info)`；
  `ctx.performer = { openid, name:'', isOwner }`（isOwner 走 `groupAdmin.owners`，与 botplay 同口径）

**纪律（都写进代码注释了）**
- 前缀不对 / 查表未命中 / 模块没导出钩子 → **一律 `return false`**（保住"无消费者时仍只 ack"）；
- 钩子抛错不冒到分发串；点击者会收到 `⚠️ 处理失败：…`；
- 注册表是**纯旁路**：写失败不影响发卡，只是那张卡的按钮"点了没反应"；
- `clickedBefore` 是内存提示（重启即丢）——**权威判重请模块自己 `ctx.store` 落盘**。

**最容易踩的三点**
1. 忘了 `registerInteractionCard` → 按钮点了没反应（前缀对不上注册表）；
2. 按钮用 `type=0`（跳转）或 `type=2`（指令）→ **根本不产生回调事件**；
3. `data` 里的卡 id / 按钮 id 与登记值不一致（大小写也算）。

**验收（照需求单四条）**：工具发卡 → 群友点 → 模块 `onInteraction` 被调用且 `ctx.performer.openid` 是点击者本人；
点击者有回执；票数按人累计、重复点可识别；四条既有链路（preset/approval/question/botplay）行为不变、无消费者时仍只 ack。

### 11.22 🟢 「会话列表 / 会话标题」别去解 `.zstd` —— 直接问宿主服务（2026-10-14 实测，**2026-11-13 更新**）

> ✅ **2026-11-13 重要更正**：`sessionTitle.get()` **没有坏** —— 它要的是 **Session 对象**（`sessions.list()` 里那一项），
> 传 **id 字符串**才会抛 `session.snapshotEvents is not a function`。
> 传对象后能直接拿到 `{title, messageSeqs, source:{kind,provider}}`，
> 而且**比扫 log 更全**：`log` 里只有"标题被生成过"的会话才有 `session/title` 事件。
> 例：本 QQ 会话扫 log 是空的，`sessionTitle.get(session)` 却返回「查看交接白板文件」。
> 现在 `/会话列表` 命令已改成「先 `sessionTitle.get(o)`，失败才回退扫 log」。



写「列出所有会话 / 显示会话标题」这类功能时，**不要碰 `~/.dsh/sessions/**/*.jsonl.zstd`**（多帧 zstd、
`zstdDecompressSync` 只解第一帧、`createZstdDecompress` 同样停在第一帧且**不抛错**，多帧兜底永远触发不了）。
宿主在 `ctx`（= 扩展拿到的 `kernel`）上直接有服务，一秒拿到全部数据：

| 想拿什么 | 怎么拿 | 形状 |
| --- | --- | --- |
| **全部会话 + 真实工作区路径** | `kernel.get('sessionPersistence').list()` | `[{ header:{ version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset }, revision, sizeBytes }]`，实测 **1062** 条 |
| **正在跑的（live）会话 + 标题** | `kernel.get('sessions').list()` | 每项有 `id`、`header`、`log`（内存事件数组）、`surfaceManager`… |
| **会话标题** | 在上面每项的 **`log`** 里**倒着找 `type === 'session/title'`**，取 `data.title` | `{"type":"session/title","seq":3,"data":{"title":"早饭群","messageSeqs":[],"source":{"kind":"user"}}}` |

**三条死路（别再试）**
1. `sessionTitle.get(id)` —— **本版宿主是坏的**，任何 id 都抛 `session.snapshotEvents is not a function`
   （`titleInputOf` 同样）；服务存在 ≠ 服务可用，**必须 try**。
2. `sessionPersistence.list()` 的 `header` 里**没有 title**（只有 `version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset`）
   ⇒ **已结束的会话拿不到标题**，UI 上只能显示短 id + `createdAt`。
3. `kernel` 上的 `ctx` / `caps` 等属性是 **cordis getter，未 inject 时「读取即抛」** ——
   写 `[k, k.ctx, k.caps].find(...)` 这种"顺手取一下"会整段炸：
   实测报错 **`cannot get property "ctx" without inject`**。取服务只写 `kernel.get(name)`，兜底分支必须逐个 `try`。

**其它实测细节**
- 会话 id 两种写法并存：**持久化里带 `session-` 前缀**（`session-288d3b1b-…`），
  **实时 agent id 不带**（`288d3b1b-…`）⇒ 比对前先归一化（`startsWith('session-') ? slice(8) : s`）。
- `createdAt` 是**创建时间**，不是最后活跃时间；想按"最近活跃"排就得另找来源（目录 mtime 是现成的一条）。
- 工作区选项直接用 `header.cwd`（**已经是真实路径**），不必再解 `--D-newwenjianjia-…~9CB8~9C7C~5A18--` 那种转义目录名
  （那个转义**不可逆**：原路径里本来有 `-` 会被当成分隔符）。




---

### 11.23 🔴 入站扩展三连坑 + 「主人消息」的唯一例外通道（2026-10-14 实测）

**① 正文不在 `ctx.message.text`。** 入站扩展的 ctx 里正文存在 `ctx.message.content`，
规范读法是 `ctx.text`（插件自己的 `textOf(ctx)`，是个 getter）。写 `ctx.message.text` 会读到**空串** ——
如果第一行恰是 `if (!text) return next()`，整条链就**静默放行**，插件那本入站审计里**一条记录都不会有**，
极难定位。⇒ 一律写 `ctx.text ?? ctx.message.content ?? ctx.message.text`。

**② "主人的消息不可被消灭"有**两道**，`annihilate()` 本体就拦。**
`features/ext-inbound-context.ts` 的 `annihilate()` 第 ② 条：发送者在 owner 白名单里 ⇒ 直接
`return false` + 审计 `refused-owner`；引擎的 `rescueReason`（"扩展没调 next 就替它放行"）只是**第二道**。
⇒ 想在扩展层吞掉主人的消息，两道都绕不过去，**只能改插件**。v1.10.5 起提供显式例外
`ctx.annihilate({ reason, ownerAck: true })`：只解开这一条的白名单，落审计 `ok-owner-ack` + 一条 warn，
熔断等保护照旧；老版本不认识该字段 ⇒ 自动退回旧行为（主人消息照常放行）。
另外：**消灭之后照样要 `return next()`** —— 置位后 `next()` 变成空操作、链停在那里；
而"没调 next"恰恰是引擎兜底放行的触发条件。

**③ 诊断必须落盘，别只写 logger。** 入站扩展拿到的 logger 需要插件注入（`setLogger`），
**没人注入时是全静默的**。第一版只往 logger 写 ⇒ 真机上一点线索都没有。改成 `appendFile` 写
`{dataRoot}/.qqbot-extensions/data/<扩展名>-diag.log`，才把上面两条定位出来。

**④（附带）QQ 转发能力 `fwd` 是内存态，重启必丢。** `session_watch_lib` 的
`fwd = { sender, replyTarget }` 不落盘，`ensureLoaded()` 恢复时如实置 `null`；兜底路径
"父会话发言时 `hydrateFwd` 从 root 取 sender"**实测拿不到 sender** ⇒ 实际只有盯梢工具被调用过
（`session_watch.mjs` 里的 `rememberFwd`）才会注入。⇒ 重启后若没人调过盯梢工具，
`session_watch action=list` 会显示 `QQ转发=未就绪`，**子会话发言只进不了群**。
恢复：调一次 `session_watch`（任意动作即注入 FWD）→ `action=rehydrate`（逐条 `hydrateFwd`）。
根治（v1.10.5 已做）：把 `rememberFwd(ctx.caps.sender, ctx.caps.replyTarget)` 挂到入站链上，
每条群消息刷新一次 ⇒ 重启后父会话随口说一句就自动恢复。
⚠️ 必须用 `ctx.caps.sender` —— ctx 上的 `sender` 已被插件定义成"发送者 openid"（字符串），
会遮蔽能力包里的 sender 对象。

---

## §11.33 🔴 c2c（私聊）与群聊的**结构性差异** —— 私聊优化专题（v1.10.10，2026-10-17）

### 一句话
**群聊能跑通的东西，私聊不一定能跑。** 私聊**没有 `gid`**、没有群上下文，还多两道限制：
「**主动消息受限**」和「**卡片权限 type=2**」。

### 已踩过的坑（现象 → 根因 → 修法）

| # | 现象 | 根因 | 修法 / 提交 |
|---|------|------|------------|
| 1 | 私聊里卡片**按钮整体点不动** | 私聊卡片要用 **`type=2`**（群聊那套 type 私聊不认） | PR #13：按 scope 选 type |
| 2 | 抢答后"只回一句抢到了、**永远不发新卡**" | 补发用的 target 是从**交互事件现推**的（只有 scope/targetId、**没有 msgId**）⇒ 走主动通道 ⇒ c2c 主动受限被拒；而 `sendMarkdownWithKeyboard` **失败直接抛、没有 sendMarkdown 那套降级链**，外层又是空 catch | PR #13：改用**发起提问时记录的 `record.replyTarget`**（带 msgId ⇒ 被动回复通道）＋ 失败改 `logger.warn` 不再静默 |
| 3 | 价值评分 / 智能回复等**群专有链路在私聊缺失** | 这些判断里显式判了 `scope === 'group'` | PR #13：放开 c2c |
| 4 | 私聊**发卡通通失败** | 私聊没有 `gid`，代码却从 `replyTarget` 里取 gid ⇒ **拿到了私聊 openid** 当群号用 | `c9f13f6`：按 scope 分派目标 |
| 5 | 私聊会话下「最近评分」**看不到记录** | 前端按"群"过滤，私聊记录被滤掉 | `e94e8b1`：按 scope 查 |
| 6 | 日志写进了**别人的目录** | 日志路径**写死** | `c9f13f6`：按 dataRoot 拼 |
| 7 | 私聊里**新加的扩展命令不生效**（同一条命令群里一刷就通，私聊得重启） | **两条命令通道不同源**：群聊走插件自建分发（每次现查 `cmdMap`，热刷即时生效）；私聊被 `kind !== 'group' → next()` 让给 SDK 的 `slashCommand` 中间件 —— 而它的 registry 是**创建时一次性**灌入 `options.commands` 的（`slash-command.js:71-73`），本插件当初只取了 `.middleware`、把 SDK 明明提供的 `register()/unregister()` 丢了 ⇒ 热刷出来的新命令私聊**永远**不认识 | v1.12.27：自建分发放开 c2c（`kind0 !== 'group' && kind0 !== 'c2c' → next()`），私聊也实时读 `cmdMap` 且 `handlerArg` 带齐 caps；SDK 那层只兜底 `autoHelp` 的 `/help`。⚠️ 自建分发**没有** SDK 的 `cmd.scope` 检查（内置/扩展命令目前都没声明 scope，暂无影响；以后要加 scope 得补这里） |
| 8 | 私聊 `senderName` 一直是空 / 显示成 openid | 官方此前不下发；SDK 的 C2C 分支也只取了 `user_openid`、没取 `username` | 官方 2026-11-13 起下发 `author.username`（连 `author.avatar`）；插件改读 `msg.raw.author.username`，台账反查降为兜底（`inbound.ts` / `c2c-name.ts`） |

### 硬规矩（写代码时照着做）

1. **目标构造**：`{ scope: 'c2c', targetId: <用户 openid> }` —— **没有 gid**。
   任何 `gid` 相关代码都必须**先判 scope**，别假设"有 targetId 就是群"。
2. **主动消息在 c2c 受限**：能走被动（带 `msgId`）就走被动。
   要"补发卡片 / 追加消息"时，**不要用交互事件里现推的 target** ——
   去 `record.replyTarget` 取发起时记下的那个（带 msgId）。
3. **卡片 type 要分 scope**：私聊 `type=2`。
4. **按钮 permission 是"发送时烘焙"的**：已发出的卡**改不了 owner** ⇒ 换人必须**重发一张**。
   （`qq-user-questions.ts` 抢答补发就是干这个的。）
5. **失败不要空 catch**：`sendMarkdownWithKeyboard` **没有降级链**，静默 = 真机上永远查不到。
6. **类型别偷懒**：`ReplyTarget.scope` 是 **`ChatScope` 联合类型**，写成 `string` 会在
   把它透传给 `sendMarkdownWithKeyboard` 时报 **TS2345**。
   （2026-10-17 合并 origin/main 时踩到：`qq-user-questions.ts` 里
   `record.replyTarget` 的声明处写成了 `scope: string`。）
   ⇒ 用 `ReplyTarget['scope']`。
7. **私聊也能手动叫醒**：`/唤醒`（`examples/ext-commands/唤醒.mjs`，2026-10-16 新增）——
   私聊里没有群消息事件驱动，AI 可能一直不醒，该命令直接叫醒。
   ⚠️ 投票结束时也要恢复唤醒 AI（`examples/ext-tools/vote.mjs` 的 `POLL_WAKE_AI` 别设 false，
   2026-10-17 `30125a8` 就是把它从 false 改回 true 的）。

### 自检清单（改完 c2c 相关代码，按这个过一遍）
- [ ] 拿 target 时**判了 scope**，没把 openid 当 gid 用？
- [ ] 发卡片的 type **按 scope 分**了？
- [ ] 需要"补发"的地方用的是 **`record.replyTarget`**（带 msgId）而不是事件现推的 target？
- [ ] 失败路径**有日志**，不是空 catch？
- [ ] 群专有的判断（价值评分/智能回复/抢答）**在私聊是显式放开**的，而不是碰巧漏过？
- [ ] 日志/状态文件路径是**按 dataRoot 拼**的，没写死？

---

## §11.34 🟢 第六套扩展点「出站扩展」+ 自动配表情包的隔离设置（v1.10.10，2026-10-17）

### 一句话
**入站管"消息进来时改它/杀它"，出站管"消息出去时改它/杀它/补发媒体"** ——
目录 `{dataRoot}/.qqbot-extensions/outbound/*.mjs`，只扫**直接子文件**、按文件名升序、`?v=mtime` 防缓存。
改扩展文件只需 `/tools-reload`（回执里打印「出站扩展: N 个」），**改 `src/` 才要重启宿主**。

### 两条铁律（都是真机踩出来的，别再犯）

1. **配图只放 `phase === 'turnEnd'`，绝不放 `'send'`。**
   一段"正文→工具调用→正文"的回复，每段各走一次出站链；`'send'` 阶段拿到的第一段
   **根本不是回合最后一块**（主人 2026-10-16 实测抓到）。`'turnEnd'` 挂载点在
   `transport/outbound.ts` 的 `turn/end`（`flush()` 之后），此时 `ctx.text = turnBlocks.last`
   = **该回合权威的最后一块正文**，且正文早发完了。
2. **重活必须 `ctx.background(fn)`，绝不 await。**
   出站链与正文唯一的联系是"读一眼正文写了什么"；选图/算分/编码向量/发图**一律丢后台**，
   然后**立刻 `next()` 放行**。反面教材：曾在链上同步扫全库 1892 张图 + 首次向量编码
   （十几~几十秒），把 `sendRichOutbound` 的 **3 秒硬超时**打满 ⇒ **连正文都发不出去**。
   ⚠️ 丢后台时 `next` 是 `undefined`，业务函数里的早期 `return next()` 必须换成**安全 next**
   （实测踩过 `next is not a function`）。

### 示范 `sticker-semantic.mjs` 的选图链路（两阶段召回）
阶段1 随机抽 300 张 → 收集其 `tags`（几百个关键词）→ 本地小模型 `bge-small-zh`
（`~/.dsh/models/bge-small-zh`，没有就退化字符 bigram）给**关键词**打分 → 选最贴那个；
经**存在性闸门**（`均值 + 1.2*标准差`）+ **绝对地板**后才能用。
阶段2 拿该关键词**回全库精确搜**（`tags.includes`，零模型开销）→ 随机取一张发出。
- query 取**末句**（整段进向量会被"寒暄+技术+情绪"平均掉）；`msgText`（群友原话）**不进向量**，只做「梗命中」加分。
- **两个 scorer 的分数尺度差 10 倍**（bge 余弦 0.3~0.7 / bigram 0.02~0.04）
  ⇒ 地板必须分两套 `FLOOR_EMBED` / `FLOOR_BIGRAM`，混用会"永远不发"。

### ★ 隔离设置（主人 2026-10-17 定：只对点名的群/私聊生效）
| 级别 | 文件 | 缺省 |
|---|---|---|
| 总开关（全局） | `.qqbot-extensions/data/auto-sticker.json`（工具 `sticker_auto`） | **开** |
| **隔离白名单** | `.qqbot-extensions/data/sticker-semantic-scope.json` | **whitelist + 空名单 = 谁都不发** |

```json
{ "mode": "whitelist", "targets": ["group:<群openid>", "c2c:<用户openid>"] }
```
匹配用 `<scope>:<目标id>`，也认**裸 openid** 简写；`mode:"all"` 才恢复全局。
**文件读不到/读坏了都从"不发"这一侧失败** —— 隔离宁可哑火，不能漏发。
工具：`sticker_auto {action:'scope-add'|'scope-remove'|'scope-list'|'scope-mode'|'scope-clear'}`。

### 排障（出站扩展的失败**全是静默的**）
`{dataRoot}/.qqbot-extensions/data/sticker-semantic-diag.log` 每步留痕：
`skip:scope` / `skip:cooldown` / `stage1` / `skip:below-floor` / `skip:not-salient` / `stage2` / `sent` / `error`。
`CONFIG.FORCE = true` = 跳过所有判断、无条件发库里第一张 —— 用来区分
「出站链压根没被调用」和「链通了但选图逻辑不发」。
扩展连续 5 次抛错会被**熔断**停用（`resetOutboundBreaker` 复位），不会拖累正文。

## §11.35 🔴 出站自动传图拿不到 groupAdmin —— 多实例下句柄只挂在「会话通道」上（v1.10.15，2026-10-21）

**症状**：正文里写本地图 markdown（`![说明](D:/x.jpg)`）发到 QQ 时**原样出路径文字**，
`~/.dsh/md-media-diag.log` 只有一行 `no target（没有注册 groupAdmin 句柄）`。

**错误的三种猜法（都实测失败）**
1. `bootstrap` 里那个 `manager.groupAdmin` —— 主实例未必启用群管理 ⇒ undefined
2. 遍历 `channelBridges` —— 该数组**实测是空的**（同文件 204 行早写着"未必被填充"）
3. 遍历 `managersOf()` —— 里面的 manager **没有一个带 `groupAdmin`**

**根因**：多实例部署下，`groupAdmin` client 只挂在**会话通道**（`QQChannel.manager`）上，
而 `qq_material` 工具一直能用，正因为它走的是 `findSessionRec(...).ch.manager.groupAdmin`。

**正解**：别到处找，用**自己人** —— `OutboundRouter` 构造时就持有 `manager`：
```ts
let mdTarget;
try {
  const ga = this.manager.groupAdmin;         // 就是发这条消息的那个会话实例
  if (ga) mdTarget = { apiCall: ga.apiCall.bind(ga) };
} catch {}
const outText = await rewriteLocalMarkdownImages(text, mdTarget);
```
配套：`rewriteLocalMarkdownImages(text, explicitTarget?)` —— **优先用调用方传的句柄**，
全局 factory（`setMaterialTargetFactory`）只当下限备份。

**自证**（`~/.dsh/md-media-diag.log`）
```
matched 2 local image(s): D:/…/a.jpg | D:/…/b.jpg
uploaded: D:/…/a.jpg -> qqbot-media://image/v1/QGioOY4p…
uploaded: D:/…/b.jpg -> qqbot-media://image/v1/7wYGe4VJ…   ← 命中服务端列表，不重复占配额
```

**顺带的素材管理链路**（`/v2/media-images/*`，详见 `参考文档/api/素材管理.md`）
- 三步：`prepare`（要 file_name / file_size / content_type / md5 / sha1）→ `PUT 预签名`（**Content-Type 必须与 prepare 一致，否则 COS 403**）→ `complete`（**md5 用 ETag**）
- 命中策略：文件名塞 **sha256 前 12 位**（`cover_ab12cd34ef56.png`），上传前 `GET /v2/media-images` 按同名命中 —— 服务端权威 + 内容精确，不做本地缓存
- 配额：单机器人 100 张；超了就**按 created_at 升序删最早**直到够用
- 含 `qqbot-media://` 的正文**必须走 markdown 通道（msg_type=2）** —— 普通文本消息只解析加粗等文本语法，**图片不渲染**

---

## §11.36 🔴 `tools.restrict` 只认「全局层」的名字 —— 注册必须挂 `ctx.root`（v1.10.15，2026-10-21）

**症状**：明明没开「无上下文模式」，模型却能看见 `context_compact / context_drop / context_memo`。
`~/.dsh/contextless-trace.log`：
```
[ctxtool-reg] restrict 抛错: tools.restrict() names unknown global tools
  "context_memo", "context_compact", "context_drop", "qq_group_admin";
  known global tools: app_env_audit, app_launch, …
[ctxtool-reg] 全局注册 4 件（永不注销；可见性改由 per-scope restrict 控制）
```
即：**注册成功，但宿主不认它是「全局工具」** ⇒ deny 校验直接抛错 ⇒ 剪枝从未生效。

**根因**：`ensureContextToolsGlobal(globalCtx)` 用**传进来的 ctx** 去 `ctx.get('tools')`，
拿到的是**插件作用域**的 tools；而 `restrict({deny})` 的校验按**全局层**工具名表进行。
（`ensureExtToolsGlobal` 里早已修过同一件事，注释写得很清楚：`this.ctx` 不是根。）

**正解**
```ts
const rootOfGlobal = ((globalCtx as { root?: unknown }).root ?? globalCtx) as unknown;
const ctxObj = rootOfGlobal as …;          // 用它取 tools.register
```

**第二个坑：`restrict()` 的返回值是「函数」**
cordis 的 `Disposable<T> = () => T`，函数身上既没有 `.dispose` 也没有 `[Symbol.dispose]`，
所以 `restricted.dispose?.()` 会**静默变成空操作** —— 限制挂上去、再也摘不掉。
释放必须函数优先（抄 `dsh-plugins/dsh-computer-use/internal/schema-visibility.mjs`）：
```ts
function liftRestriction(d) {
  if (typeof d === 'function') { d(); return; }
  if (typeof d?.dispose === 'function') d.dispose();
}
```
另外 `ctx.tools` 在未声明 inject 时会**抛错**，取值要 `try { ctx.tools } catch → ctx.get('tools')`，
否则整段剪枝被外层 catch 吞掉、表现就是"从来没剪过"。

**自证**
```
[ctxtool-reg] 用 root ctx 注册（不同于传入的 ctx）
[ctxtool-reg] 剪枝已挂 deny=context_memo,context_compact,context_drop,qq_group_admin 返回形态=function
```

**同类参考**：`dsh-computer-use` 那族的 `computer_*` 工具也是"全局注册 + 每会话 restrict 摘视野"，
它给的量化收益：**单请求 20,990 个 schema token 里，这一族占 15,054** —— 剪枝不是洁癖，是省 token 的大头。

## §11.37 🔴 定时任务走的是 `injectToPeer`，不是 `handleInbound` —— 想改它的消息形态只能改这里（v1.10.17，2026-10-22）

### 一句话
`schedule_timer` 创建的会话自定任务，到点由 **bootstrap 的 30s ticker** 调 `manager.injectToPeer()` 注入；
`scheduler.ts` 的 `fireTask → handleInbound` 是**另一套**（M3 定时唤醒），两者不共用。
想改定时任务的入站形态（例如让它显示成系统卡片而不是用户气泡），必须改 `session-manager.ts` 的 `injectToPeer`。

### 两条真实链路（别再搞混）
```
【会话自定任务 schedule_timer】
  channel-tools.ts schedule_timer.execute → schedule-store.add
  bootstrap.ts 每 30s ticker → store 到期
    → manager.injectToPeer(scope, peerId, `[定时任务] ${prompt}`, sourceKind)   ← ★ 真正的注入点
      → createUserMessage({ content, source: { kind } })
      → record.agent.followup(message)

【M3 定时唤醒（另一套，聊天面板「定时唤醒」用）】
  scheduler.ts tick → fireTask
    → handleInbound(fakeMsg, ...)  （带中间件链、有打分/聚合）
```

### 怎么一眼看出「我改错层了」
在两条链路各埋一行文件 trace（不依赖日志级别，写 `~/.dsh/scheduler-trace.log`）：
```ts
// scheduler.ts fireTask 里
try { (await import('node:fs')).appendFileSync(join(homedir(), '.dsh', 'scheduler-trace.log'), `[fire] ${task.id}` + String.fromCharCode(10)); } catch {}
// inbound.ts handleInbound 里（wantKind 处）
... `[inbound] wantKind=${wantKind} key=${scope}:${peerId}`
```
**实测判据**：定时任务触发后 trace 里**只有 `[inbound]`、没有 `[fire]`** ⇒ 说明定时任务压根不走 `fireTask`，
改动白做（本次就是靠这条一行定位的，之前对 `scheduler.ts` / `inbound.ts` 的两次改动全是空转）。

### `source.kind` 决定前端渲染形态
 只是 ，**不覆盖 ** —— 所以 kind 由调用方决定。
宿主 `MessageSource` 的 **TS 类型**只有 `user | model | plugin | tool`，但**运行时不做校验**（投影只查 id 唯一与索引范围）。

| kind | 前端形态 | 备注 |
|---|---|---|
| `user` | 用户气泡（默认） | 定时任务原来的样子 |
| `plugin`（带 `plugin:'<名字>'`） | 仍被画成气泡 | 实测无效，别指望 |
| `subagent-settled` | **「子任务状态更新」灰卡片** | ✅ 已实测（v1.10.17），宿主自己也用这形状 |
| `agent-message` | 推测为「收到任务消息」 | 宿主内部有，未实测注入 |

**当前实现**（bootstrap.ts + session-manager.ts）：
```ts
// bootstrap.ts：会话自定任务到点
await manager.injectToPeer(job.scope, job.peerId, `[定时任务] ${job.prompt}`, 'subagent-settled');

// session-manager.ts:injectToPeer(scope, peerId, text, sourceKind?)
source: (sourceKind && sourceKind !== 'user' ? { kind: sourceKind } : { kind: 'user' }) as never,
```
注意 `as never` / `as any` 是**故意的**：绕过 TS 枚举，但写入的是宿主真实用过的形状。

### 安全性（会被问到的两个问题）
1. **会不会写坏会话？不会。** 非法 kind 只会在**读取投影**时抛 `invalid persisted inbox splice`（纯函数抛错），
   文件本身不会被写坏；会话其它事件照常。合法 kind（`subagent-settled` 等）完全无事。
2. **写入时机安全吗？安全。** 走宿主原语 `agent.send(message, target, wakeup)`：
   `inbox.splice(target, Infinity, 0, [msg])` —— agent 忙时消息排进 **next-turn**（不插进当前回合），空闲时唤醒开新回合。

### 内存里记着的那条老结论（别重犯）
`handoff-20261012-084141.md`：纯字符串交给 `agent.inject()` → 宿主**先 append 落盘、后读 `msg.source.kind`**
⇒ 坏记录进 `inserted[]`。即：**注入必须用带 source 的完整 message 对象**，不要塞裸字符串。

### 与 `dsh-bili-scroll` 的对照（2026-10-22 扒的）
- 它的“定时”= 插件自己的 `setInterval(tick, 60_000)` + **`spawn('dsh', ['--profile','headless', prompt])`** 起新进程
- 整份代码 `session/notify/inbox` 命中 **0 次** —— 它压根不碰会话，跑完写报告文件就退
- 所以它**没有**、也不需要“任务消息卡片”；想“定时在群里说话”只能走本插件这条 `injectToPeer` 路

### 硬规矩
1. 改**定时任务**找 `bootstrap.ts` 的 ticker + `session-manager.ts:injectToPeer`；改**M3 唤醒**才找 `scheduler.ts`。
2. 链路类改动**先埋文件 trace 再动手**，否则“改了没反应”会浪费一整轮排查。
3. 注入一律传完整 message（带 `source`），永远不要塞裸字符串。
4. 想换前端卡片形态，只改 `source.kind` 一个字符串即可 —— 但优先选**宿主自己用过的 kind**。

## §11.38 🔴 「设置页卡在保存中」连环三坑 + profile 定位的正解 + 桌面版部署三件套（v1.10.22，2026-10-22）

### 一句话
一个函数被三处小改动接连弄坏（标记字符串、事件对象、异步 state），现象全是**点保存毫无反应**；
而 profile 定位的正解不是改推断，是**把宿主给的值回写成环境变量**。

### 坑 1：脚本改代码时把「幂等标记」写进了函数体
**现象**：点保存/删除/扫码，界面**一个字都不显示**，什么都没发生。

**真凶**：用 node 脚本做批量替换时，为了防重复执行写了个标记字符串，结果它被拼进了代码：
```js
s.replace('function save(listOverride) {', 'function save(listOverride, force) { SAVEOVERRIDE')
//                                    ↑ 想当注释用，实际留在函数体第一行 → 未定义变量
```
`SAVEOVERRIDE` 未声明 ⇒ **函数一调用就抛 `ReferenceError`**，而 `setMsg()/setBusy()` 都在它后面，
所以界面连「保存中」都不显示 —— 看起来像按钮坏了。

**怎么发现的**：主人 F12 贴出 `Uncaught ReferenceError: SAVEOVERRIDE is not defined at save (client.js:1674)`。

**铁律**：
1. 脚本批量改 JS/TS 后，**必须 `node --check <file>`**（TS 走 `tsc --noEmit`）再部署；
2. 「幂等标记」只能放在**注释里**（`// MARK:xxx`）或独立变量，绝不拼在语句位置；
3. 症状是「什么都没发生」时，**第一件事看 F12 Console**，不要猜逻辑。

### 坑 2：`onClick: save` 会把 MouseEvent 当第一个参数
**背景**：为了支持「扫码后自动保存」，把 `save()` 改成 `save(listOverride)`，兼容传入列表。

**但**保存按钮写的是 `onClick: save`，React 会把**事件对象**作为第一个参数传进去：
```js
function save(listOverride, force) {
  var list = (listOverride || insts || []).filter(...)   // listOverride 是 MouseEvent → 没有 .filter
  // → TypeError → setBusy("save") 已执行但永不清理 → 界面卡在「保存中…」
}
```

**修法**：只接受数组，其余（事件对象）一律回落到当前 state：
```js
if (!Array.isArray(listOverride)) listOverride = null
```

**同类风险**：任何 `onClick: fn` 的 fn 都**不要**把第一个参数当业务数据用。

### 坑 3：`setBusy("")` 之后立刻 `save()` —— React state 是异步的
**现象**：扫码成功、提示「自动保存中…」，但文件没变；手动点保存才生效。

**原因**：
```js
setTimeout(function () {
  setBusy('')      // 异步，这一刻 busy 还是旧值
  save(list)       // save 开头 if (busy) return  ← 读到的还是旧 busy
}, 150)
```
`save()` 第一行 `if (busy) return` 直接返回，什么都不做，**且没有任何提示**。

**修法**：给 save 加 force 分支，自动保存走 `save(list, true)`：
```js
function save(listOverride, force) {
  ...
  if (busy && force !== true) return
```

### profile 定位的正解：回写环境变量，别改推断逻辑
**issue #14 / #15 的根因**：`settings-host.js` 的 `resolveProfileRoot()` 在两处会算错 ——
生成式安装（`profiles/.generations/live/<gen>/node_modules/...`）上溯 3 级得到的是生成目录；
目录扫描又按字母序让 `desktop-safe-mode` 抢在 `web` 前面。

**走过的弯路（都失败了，别重犯）**：
| 尝试 | 失败原因 |
|---|---|
| 把常量改成 `let` + 惰性函数 | `let` 有 **TDZ**，早期调用抛 `ReferenceError` → 请求挂起 |
| 把 `PATCH_FILE` 改成带 `toString()` 的对象兼容旧写法 | 一旦被当路径传（`readFileSync(x)`）就 `TypeError` → 请求挂起 |
| 改成「两轮扫描：优先装了插件的 profile」 | 逻辑对，但对已有环境是行为变更，风险高 |

**正解（v1.10.22 采用）**：宿主本来就把答案交给你了，只是没人去接。
```ts
// src/index.ts 启动时（apply 阶段）
const pc = ctx.get('profileContext') as { name?: string; dir?: string; root?: string; path?: string } | undefined;
const dir = pc?.dir || pc?.root || pc?.path;
if (pc?.name) process.env.DSH_PROFILE     = String(pc.name);   // -> "web"
if (dir)      process.env.DSH_PROFILE_DIR = String(dir);       // -> C:\Users\<u>\.dsh\profiles\web
```

**为什么这就够**：`resolveProfileRoot()` 的第一优先级就是读 `DSH_PROFILE_DIR`，
`resolveProfileName()` 的第一优先级是 `DSH_PROFILE` —— 回写之后原版逻辑自然命中，
**`settings-host.js` 一行都不用改**（也就不会引入新的时序/类型问题）。

**真机实测**（用诊断扩展工具在 QQ 会话里打出来的）：
```
ctx.get("profileContext") -> {
  name: "web",
  dir: "C:\\Users\\<user>\\.dsh\\profiles\\web",
  patchPath: "...\\cordis.patch.yml",
  installAnchor: "...\\@deepseek-ai\\dsh\\package.json"
}
process.env.DSH_PROFILE -> 不存在   ← 印证「宿主从不传这个环境变量」
argv -> node.exe ...\\@deepseek-ai\\dsh\\lib\\bin.js web
```

### 桌面版（desktop profile）部署三件套
**只把包复制进 `node_modules` 是不够的**，宿主根本不会加载它。三处缺一不可：

1. **包实体**：`~/.dsh/profiles/<profile>/node_modules/@zaofan/dsh-qqbot/`（`cp -rL` 解掉 pnpm symlink）
2. **依赖声明**：该 profile 的 `package.json` → `dependencies["@zaofan/dsh-qqbot"] = "<version>"`
3. **加载清单**（最关键）：`package.json` → `dsh.profile.bundles` 数组里**要有 `"@zaofan/dsh-qqbot"`**
   —— `bundles` 才是宿主启动时按序加载的插件清单，缺它装了也不加载。

**从源码部署更省事**（绕过 npm）**：**
```bash
rm -rf "$DST/dist" "$DST/client"
cp -rf dist client settings-host.js entry.js package.json cordis.patch.yml "$DST/"
```

### 排障速查（症状 → 先看哪）
| 症状 | 先查 |
|---|---|
| 点按钮毫无反应 | F12 Console 有没有 `ReferenceError` / `TypeError` |
| 卡在「保存中…」 | 前端 `busy` state 是否被异常路径卡住；对应请求有没有 `.catch` 清 busy |
| 保存了但文件没变 | **别看 .json 的 mtime**，保存真正写的是 `cordis.patch.yml`（`.json` 是启动期副产品） |
| 插件装了但不生效 | 该 profile 的 `dsh.profile.bundles` 里有没有它 |
| 疑 profile 算错 | 让 AI 在会话里调诊断工具打印 `ctx.get("profileContext")` 实际返回 |

### 硬规矩
1. 改前端 JS 后**必跑 `node --check`**；标记字符串只许放注释。
2. `onClick: fn` 的 fn 不许把第一个参数当数据。
3. React state 改动后**不要立刻读**它做判断，走参数/force 分支。
4. 想改 profile 推断 ⇒ 先试**回写 `DSH_PROFILE_DIR` / `DSH_PROFILE`**，那是最小切面。
5. 部署到新 profile ⇒ 记住三件套，`bundles` 别忘。

---

# 十二、2026-10-26 那批修复攒下的经验

> 这一节都是**真机踩出来**的，不是推演。每条都写了「症状 → 根因 → 修法 → 怎么验」。

## §12.1 🔴 会话目录名的 `-` 歧义：**不要解码**，用 registry / header

**症状**：工作区路径里带连字符时（如 `D:\agent-sandbox`），扩展面板的「当前工作区 / 内置目录 / 扩展包目录」全指向不存在的路径，内置扩展计数恒为 0，「账号 → 工作区」选择器里列出假的 `D:\agent\sandbox\qq\robot`。

**根因**：dsh 把工作区路径转成 `~/.dsh/sessions/--D-agent-sandbox--` 时，转义是**有损**的 ——
`-` 既是路径分隔符、也是路径本身的合法字符，编码没有区分两者。
所以 `name.split('-')` 再拼回，原理上就不可能还原。

实测（造了真实工作区 `D:\newwenjianjia\aiwork\斜杠-斜杠` 验的）：

```
目录名  : --D-newwenjianjia-aiwork-~659C~6760-~659C~6760--
按 - 拆 : D:\newwenjianjia\aiwork\斜杠\斜杠      ← 磁盘上不存在 ❌
header  : D:\newwenjianjia\aiwork\斜杠-斜杠      ← 磁盘上存在   ✅
```

**修法：三层兜底，优先「不解码」**（`settings-host.js` 的 `decodeSessionDirName`）

```
① ctx.get('workspaceRegistry').list()  → 按 record.sessionIds 反查
   已登记的工作区走这条，零磁盘 IO、零歧义
② 读 sessions/<目录名>/**/session*.jsonl.zstd 第一行的 cwd
   未分组 / 未登记的新目录走这条（实测 session_create 建的会话就是"未分组"）
③ 旧的拆 '-' 拼回
   老 Node 没 zstd API / 文件缺失时兜底
```

**关键细节**（踩过的）：

- `workspaceRegistry` 三个入口都能拿到：`env.ctx` / `env.kernel` / `env.caps.kernel`，
  方法只有 `list()` 和 `resolveByPath(path)`（`listAll/all/getAll` 都**不存在**）。
  `list()` 返回 `[{ id, record: { path, title, sessionIds: [] } }]` —— **`sessionIds` 是关键**，
  面板本来就是走 `?sid=` 反查工作区的，直接 `list().find(w => w.record.sessionIds.includes(sid))` 一步到位。
- 方法名用 `Object.keys(obj).filter(k => typeof obj[k] === 'function')` **列不出来**（在原型链上），
  别被这个假象骗了，直接试调用。
- registry 只认**已登记**的工作区。`session_create` 传一个没登记过的 `cwd`，会话能建但落"未分组"，
  这时候 registry 查不到，必须靠第②层。

**怎么验**：

```bash
# 1. 造一个带横杠的工作区（UI 里「打开文件夹」，别只 mkdir）
# 2. 对比两层结果
node -e '...decodeSessionDirName 等价实现...'
# 3. 面板上看「当前工作区」是否保住横杠
```

## §12.2 🔴 `position:sticky` 和 `overflow-x:auto` **不能放在同一个元素上**

**症状**：页签条右侧被裁掉半截，看着明显溢出，但鼠标滚轮、触控、拖滚动条**全都滑不动**。

**根因**：不是 CSS 写错。sticky 会创建新的格式化上下文，
那个元素的 `scrollWidth` 计算会异常 —— **看着溢出、实际判定为没溢出**。
于是原生横滚不触发，自定义的「纵向滚轮折算 scrollLeft」也因为
`if (el.scrollWidth > el.clientWidth + 1)` 判断为假而跳过。

**修法：拆两层，各管一件事**

```js
// 外层：只负责吸顶 + 裁剪
h('div', { style: { position:'sticky', top:0, zIndex:30, overflow:'hidden' } },
  // 内层：只负责横向滚动
  h('div', { style: { display:'flex', gap:10, flexWrap:'nowrap',
                      overflowX:'auto', overflowY:'hidden',
                      WebkitOverflowScrolling:'touch', scrollbarWidth:'none' } },
    buttons))
```

**配套的 CSS 要点**（抄 `.dk-tab` 那套已验证的）：

```css
.container { display:flex; gap:10px; overflow-x:auto; overflow-y:hidden;
             -webkit-overflow-scrolling:touch; scrollbar-width:none;
             scroll-snap-type:x proximity; }
.container::-webkit-scrollbar { display:none; }
.container > * { flex:0 0 auto; scroll-snap-align:start; }   /* ★ 这句是关键 */
```

- `flex: 0 0 auto` —— 少了它，卡片/按钮会被 flex 压成一条缝。
- **桌面上普通滚轮是纵向的**，`overflow-x:auto` 不会自动把纵向滚轮转成横滚，
  要自己加事件委托（`{ passive: false }`，否则 `preventDefault` 无效）。

**怎么验**（F12 Console）：

```js
var e = document.getElementById('你的容器');
[e.scrollWidth, e.clientWidth]   // 前者 > 后者才有东西可滚
```

两数相等 = 布局问题（容器没被限制宽度）；前者大 = 滚动逻辑问题（滚轮委托没生效）。

## §12.3 会话文件是 **zstd 压缩**的，不是明文 jsonl

```
~/.dsh/sessions/<编码目录>/<sid>/session.v3.jsonl.zstd    ← 注意 .zstd 和版本号会变
```

- Node **22.15+** 才有 `zlib.zstdDecompressSync`。
- **必须用 `createRequire` 懒加载**：

```js
import { createRequire } from 'node:module';
let _zlibLazy;
function getZlibSync() {
  if (_zlibLazy !== undefined) return _zlibLazy;
  try {
    const z = createRequire(import.meta.url)('node:zlib');
    _zlibLazy = (z && typeof z.zstdDecompressSync === 'function') ? z : null;
  } catch { _zlibLazy = null; }
  return _zlibLazy;
}
```

  静态 `import { zstdDecompressSync } from 'node:zlib'` 在旧 Node 上会**直接让整个文件崩**，
  不是"这个功能不可用"，是**插件起不来**。
- 文件名带版本号（`v3` → `v4` 已经出现过），**别写死**，用 `/session.*\.jsonl\.zstd$/i`。
- 要读的只是第一行（header 里的 `cwd`），但 zstd 是一次性解压，
  想省内存可以 `createZstdDecompress` 流式读到首行即 destroy。
- 结果要加 Map 缓存（目录名 → cwd 是稳定的），否则列工作区时每个都解一遍。

## §12.4 扩展工具的三个格式坑

写 `tools/xxx.mjs` 时踩的，全是最小复现级：

**① `inputSchema` 是「扁平属性表」，不是 JSON Schema**

```js
// ✅ 对（照 roll_dice.mjs）
inputSchema: { sides: { type: 'integer', description: '骰子面数' } }

// ❌ 错：写了标准 JSON Schema 的壳，工具直接不出现
inputSchema: { type:'object', properties: { sides: {...} } }
```

框架取的是 `obj.inputSchema ?? obj.parameters`，**直接当属性表用**。
可选参数不要写 `required` 字段，必填才写 `required: true`。

**② 必须 `export default { name, description, inputSchema, run }`**，不是 `export const`。

**③ 文件名只认 `.js / .mjs / .cjs`**（`ALLOWED_EXT`），放在 `{dataRoot}/.qqbot-extensions/tools/`。

**排查口诀**：工具不出现 → 先对 `roll_dice.mjs` 比一眼 `inputSchema` 形状，那个文件是官方最小样例。

## §12.5 扩展 UI 挂载点（第一版，2026-10-26）

**目的**：让扩展不用改 `client/qqbot-settings.js`（535KB 手写 bundle）就能往面板加卡片。
以前只能按字符串锚点往里塞代码，版本一换锚点就失效。

**两个源，各管一种 slot，不许混**：

| slot | 界面性质 | 放哪 |
|---|---|---|
| `settings` | DSH 设置页（全 profile 一份） | `{PROFILE_ROOT}/.qqbot-extensions/ui/<extId>/` |
| `dock` | 悬浮球（每个实例一份） | `{dataRoot}/.qqbot-extensions/ui/<extId>/` |

放错源会被**静默跳过**（不报错，免得用户困惑）。`ui/` 是**静态资源**，不进 `EXT_KINDS` 的
`import()` 流程 —— 否则会试图 import 一个 `.html` 直接报错。

**元信息**写在 `card.html` 前 2KB：

```html
<!-- qqbot-ui: { "slot": "settings", "title": "本地代答", "order": 10 } -->
```

**运行环境**：`card.js` 以 `new Function('qqbotExt', 'shadowRoot', 源码)` 执行，
拿到的两个变量就是它的全部世界。用 `shadowRoot.getElementById`，**别用 `document.getElementById`**。

**为什么必须 Shadow DOM**：

1. 扩展的 CSS 不污染那 535KB 单文件（一条全局 `button{}` 能改全站）
2. 扩展脚本报错只白自己那张卡（外面套了 try/catch），不整页崩

**踩过的**：`ExtCardPage` 一开始定义在 `SettingsPage` **内部**，但使用它在上一层组件 `QqbotHome` 里 →
`ReferenceError: ExtCardPage is not defined` → 整页白屏。
**组件共享的东西必须放模块顶层**，别塞进某个页面组件里。

## §12.6 🔴 群守则「每步重注 1910 字符」—— 判据引用了一个默认不存在的串

**症状**：每步都在上下文里追加一整份群守则（约 1910 字符），副本还留在 surface 里被长期重放。

**根因**：去重判据写成 `includes(CTX_SMART_REMINDER)`，但那个串**只在 `contextlessSmart`
开启时才拼进 body**（默认 false）⇒ 谓词连**自己刚注入的那条**都判不中 ⇒ `skipGroupRules` 永不置位。

**修法**：换成**群守则内容指纹**（前 60 字，为空时退回固定通道上下文保证非空）：

```ts
const rulesFp = (rules.trim() || FIXED_CHANNEL_CONTEXT.trim()).slice(0, 60);
```

**通用教训**：「用某个标记串判断 X 是否已存在」时，先确认**那个标记串在默认配置下一定存在**。
否则判据恒 false，去重逻辑静默失效，而且**没有任何日志**。

## §12.7 🔴 出站扩展链 3 秒硬超时，把语音/拆条/配图全吃掉

**症状**：AI 说"我给你发语音"，结果什么都没来。日志里：`出站扩展链超时(3000ms)，已放弃改写/配图、按原文发出`。

**根因**：`EXT_HOOK_TIMEOUT_MS = 3000` 硬编码。TTS 走网络 1~3 秒、冷启动更久，必然压线。
一旦超时就走"放弃扩展、按原文发"分支 → 语音、拆条、表情包全丢。

**修法**：可配、默认 8 秒、夹在 `[500, 30000]`：

```ts
const EXT_HOOK_TIMEOUT_MS = (() => {
  const raw = Number(process.env.QQBOT_EXT_HOOK_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 500) return Math.min(30000, Math.round(raw));
  return 8000;
})();
```

## §12.8 🔴 `resume` 失败是裸 catch → 整条消息静默消失

**症状**：偶发消息不回，日志里 `ERROR creating session: session "xxx" already exists`，一天几十次。

**根因链**：`getOrCreate` 里 resume 失败是**裸 catch**（真实原因被吞、零日志），
随后用**同一个 sessionId** 去 `create` → 宿主抛 `already exists` → 冒到 `inbound` 的
`catch { return }` → 整条消息没了。

**修法**：① 先把 resume 错误 `warn` 出来；② create 撞 `already exists` 时**轮换 sessionId 重试一次**
（旧档文件原样保留）。**别再写裸 catch** —— 吞掉的那条错误，就是排查时唯一想看的线索。

## §12.9 扩充「排障速查」

| 症状 | 先查 |
|---|---|
| 工作区路径出现"凭空多/少一层目录" | 会话目录名解码（§12.1），看路径里有没有连字符 |
| 面板数字恒为 0、路径指向不存在的位置 | 同上 |
| 页签/卡片溢出但滑不动 | `sticky` 与 `overflow` 是否在同一元素（§12.2）；`scrollWidth` vs `clientWidth` |
| 自己写的扩展工具不出现 | `inputSchema` 是不是写成了标准 JSON Schema（§12.4） |
| 说好发语音却没发 | 出站扩展链超时日志（§12.7） |
| 偶发消息不回、日志有 `already exists` | resume 裸 catch（§12.8） |
| 上下文里群守则越堆越多 | 去重判据引用了默认不存在的串（§12.6） |
| 扩展页面白屏 + `Xxx is not defined` | 组件定义在子组件内部、却被父组件引用（§12.5 末尾） |

---

# 十三、多实例 / 多 profile：路径与状态隔离（2026-10-27）

> 这一章是**血的教训攒出来的**。一天之内连着踩了 5 个同类 bug，症状各异、病根完全相同：
> **把「进程级 / 插件级」的值当成「实例级」用**。
> 2026-10-27 之前，多实例隔离**从来没有真正生效过** —— 所有非主实例都在偷偷用主实例的扩展。

## §13.1 三个「根」的层次（先背下来，后面全是它的变体）

```
PROFILE_ROOT      DSH profile 目录             C:\Users\<你>\.dsh\profiles\web\
                  一个 DSH 进程对应一个 profile（web / desktop / 第三方桌面版）
   │
   ├─ 插件配置    ~/.dsh/qqbot-settings/<profile>/<ns>.json      ← 按 profile 分目录！
   │
   └─ dataRoot    {cwd}/dshqqbot                                  ← 每个机器人实例一份
        │           cwd = 该实例配的工作目录
        ├─ .qqbot-extensions/   扩展（tools/commands/hooks/ui/…）
        ├─ extension-packs/     已安装的扩展包
        ├─ .qqbot/              运行时数据（session / 定时 / 消息历史）
        └─ 表情包/               图库
```

**关键区分**：

| 概念 | 例子 | 谁共享 |
|---|---|---|
| `PROFILE_ROOT` | `.dsh\profiles\web` | 同一 profile 里的**所有**机器人实例共享 |
| `dataRoot` | `鲸鱼娘\dshqqbot` | **单个**机器人实例独有 |
| `cwd` | `鲸鱼娘` | 该实例的工作区（`dataRoot = cwd + /dshqqbot`） |

**扩展 UI 的两个 slot 就架在这条分界线上**：

```
slot=settings  → PROFILE_ROOT 级（一个 profile 一份，所有实例共用）
slot=dock      → dataRoot 级（每个实例一份，能读该实例的会话数据）
```

## §13.2 配置真源：三层，别读错文件

**设置页保存的是自有存储，不是 cordis.patch.yml**（2026-09-24 起，写 patch 会触发热更新死循环）。

```
① ~/.dsh/qqbot-settings/<profileName>/<ns>.json      ← **真源**，用户保存的最新值
② cordis.patch.yml 里的 im-qqbot config              ← 首次安装的基线，之后可能过期
③ ~/.dsh/qqbot-settings/<ns>.json                    ← 老布局遗留，*不要读*
```

**踩过的坑（2026-10-27，两条都是自己造的）**：

- 一开始去读 `cordis.patch.yml` → 里面 `im-qqbot-3` 根本没 cwd（设计如此）
- 改去读 `qqbot-settings/im-qqbot-3.json` → **少了 profile 层**，读到的是旧版遗留
  （那份 `cwd` 是 `温柔鲸鱼娘`，而 `web/im-qqbot-3.json` 里才是 `测试客户端`）

**正确读法**（`src/index.ts` 的 `nsPathsOf`）：

```ts
const nsPaths = nsPathsOf(process.env.DSH_HOME || join(homedir(), '.dsh'),
                          ns,                    // config.settingsNs || 'im-qqbot'
                          resolveProfileName()); // 环境变量 → 代码位置 → 宿主扫描兜底
```

**取值优先级**（`accounts` 接口里那个 `pickOwn`）：

```ts
自有存储 > patch > 默认
```

## §13.3 🔴 五个「插件级当实例级用」的坑

五个全踩过，症状完全不同，病根一样。**加新路由/新功能前先对照这张表自问一遍。**

### ① `config.cwd` 被宿主注入主工作区 → 所有实例的 dataRoot 指向主实例

**症状**：3 号机的 `/tools-reload` 回执报「扩展命令: 25 个」—— 但那个目录里只有 5 个文件。
命令名里有 `/hello` `/mc` `/百科` 这些**只有 2 号机才有**的。

**根因**：

```ts
// src/index.ts 原来的写法
if (!config.cwd) {          // ← 这个守卫是致命的
  ...从自有存储补 cwd...
}
```

宿主会给**所有实例**注入同一个 `cwd`（当前工作区），于是 `config.cwd` 永远非空
⇒ 补正整段被跳过 ⇒ `dataRootOf(config)` 落到主实例目录。

**修法**：**无条件以自有存储为准**（那是用户保存的最新值），并且**写回 config**：

```ts
if (j?.cwd) {
  cwdOverride = String(j.cwd);
  (config as { cwd?: string }).cwd = cwdOverride;   // ← 必须写回！见 ②
}
```

### ② 只改局部变量，不改 `config` → 下游全用旧值

**症状**：`ctx.dataRoot`（能力包里的）是对的，但命令加载用的还是错的 —— 两条路给出不同结果。

**根因**：`dataRootOf(config)` 被调用了**很多次**：

```ts
loadExtensionCommands(dataRootOf(config), logger)   // 命令
seedExampleTools(dataRootOf(config), logger)        // 示例铺设
extRunOpts.dataRoot = dataRootOf(config)            // 能力包
```

只改局部变量 `cwdOverride` 的话，凡是读 `config.cwd` 的地方全部拿旧值。

**修法**：**必须写回 `config` 对象本身**。

### ③ `reloader` 是模块级单例 → 后 apply 覆盖前者

**症状**：在 3 号机敲 `/tools-reload`，日志却记在 2 号机名下；3 号机被刷成了 2 号机的命令表。

**根因**：

```ts
// src/features/ext-reload.ts
let reloader: (() => Promise<ExtCommandReloadResult>) | undefined;   // ← 模块级！
export function registerExtCommandReloader(fn) { reloader = fn; }
```

两个实例各 `apply` 一次 → 后注册的把前者覆盖 → 任何实例热刷都刷到**最后注册的那个**。

**修法**：按实例分开存（这正是手册 §11.24「跨模块实例可见的状态绝不能存模块级变量」的同一个坑）：

```ts
const reloaders = new Map<string, () => Promise<ExtCommandReloadResult>>();
export function registerExtCommandReloader(dataRoot, fn) { ... }   // 注册带 key
await reloadExtCommands(this.dataRoot)                              // 调用带 key
```

### ④ `hooks` 的 `env.dataRoot` 是插件级的

**症状**：dock 卡片在 3 号机里读到的还是 2 号机的文件。

**根因**：`hooks/` 是「**插件启动时跑一次**」，拿到的 `env` 是**插件级**的
（主实例那份），不是当前机器人实例的。

**修法**：**数据根跟着请求走**，别依赖 `env.dataRoot`：

```js
// hooks 侧：每个 handler 从 query 里取
const rootOf = (q) => String(q?.dataRoot || '').trim() || defaultRoot;
caps.registerRoute('GET', '/store', async ({ query }) => readStoreAt(fileOf(query)), extId);

// 卡片侧：api() 自动带上
qqbotExt.api('/store')   →  /api/ext/dispatch?id=demo&p=/store&dataRoot=<当前实例>
```

### ⑤ `accounts` 的 `dataDir` 是图库目录，不是 dataRoot

**症状**：扩展 UI 列表扫不到卡片；工作区面板显示正确但 dock 是空的。

**根因**：

```ts
// settings-host.js 的 accounts 返回
dataDir:  droot ? join(droot, '表情包') : '',    // ← 图库目录！差一级
schedDir: droot ? join(droot, '.qqbot') : '',
// 没有 dataRoot 本身
```

前端拿 `dataDir` 当 `dataRoot` 传给 `/ext-ui/list`，扫的是 `{dataRoot}/表情包/.qqbot-extensions/ui/`
—— 永远不存在。

**修法**：`accounts` 补 `dataRoot: droot` 字段，前端优先用它。

### 补充：还有两个「字段名不存在」类的坑

- **`state.acctId` 在 dock 的 state 里不存在**（那是 `SettingsPage` 的 React state）
  → 条件永远 false → 落到"第一个启用的实例" → 永远拿 2 号机。
  正确做法用 `state.ns` 匹配。
- **`state` 每次渲染新建对象**，`window.__qqsDockState` 指针只在初始化时赋一次
  → 后续读到的是旧对象（`detectedHit` 永远 null）。
  正确做法：**每次 `paintBody` 都刷新指针**。

## §13.4 扩展 UI 的双源铺设（`features/ext-ui-seed.ts`）

**为什么要"铺"**：UI 卡片必须放在正确的位置才能被扫到（见 §13.1 的两个 slot），
但作者/示例不该手动往那两个地方复制。

**两个来源，两个时机**：

```
① 插件自带示例        启动时（apply 里）
   examples/ext-ui/<name>/settings  →  {PROFILE_ROOT}/.qqbot-extensions/ui/<name>-settings/
   examples/ext-ui/<name>/dock      →  {dataRoot}/.qqbot-extensions/ui/<name>-dock/

② 已安装的扩展包      装包时（/market/install 成功后立刻）+ 启动时
   extension-packs/<pack>/ui/<card>/  →  读 card.html 的 meta.slot
       slot=settings → 复制到 profile
       slot=dock     → 不用动（本来就在 dataRoot 下）
```

**三条纪律**：

1. **只补不改** —— 目标已存在就跳过，绝不动用户改过的内容。
2. **最多铺 2 个实例** —— 用户可能建几十个，全铺太铺张（`maxDataRoots: 2`）。
3. **任何异常都吞掉** —— 铺 UI 失败不该影响插件启动。

**已知不足**：卸载扩展包**不会**删已铺的卡片（没有记录「这张卡来自哪个包」，
删不准）。残留卡片在面板上加载失败，但不影响其他功能。
要彻底解决，得在包里写一个来源标记文件（如 `.seeded-from`）。

## §13.5 排查手法：与其推理，不如埋点

这一天的教训：**在错误的前提上推理，会连续错三次**。最后还是靠日志文件定案。

**有效的手法**：在关键位置写一行文件日志，让实际值自己说话：

```ts
try {
  const { appendFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dr, '.qqbot'), { recursive: true });
  appendFileSync(join(dr, '.qqbot', 'reload-diag.log'),
    '[' + new Date().toISOString() + '] dataRoot=' + dr
      + ' | config.cwd=' + String(config.cwd || '(空)')
      + ' | settingsNs=' + String(config.settingsNs || '(空)')
      + ' | process.cwd()=' + process.cwd() + '\n');
} catch { /* 诊断失败不影响主流程 */ }
```

**为什么写文件而不是打日志**：用户在 QQ 里跟你对话，看不到宿主控制台；
写进数据根的文件，AI 直接就能读。

**排查完记得删**（临时代码留在主干里会变成下一个坑）。

**另一个有效手法**：临时加一个诊断命令（`/诊断`），把能力包、配置、目录内容全打出来，
用完删掉。

## §13.6 扩充排障速查（多实例相关）

| 症状 | 先查 |
|---|---|
| 某个实例的命令/工具"多出来了"（出现了别的实例才有的） | `config.cwd` 是否被宿主注入 → §13.3① |
| `/tools-reload` 回执里的命令数和目录里的文件数对不上 | 同上；看 `dataRootOf(config)` 实际值 |
| 在 A 实例热刷，日志记在 B 实例名下 | `reloader` 是不是模块级单例 → §13.3③ |
| dock 卡片读到的 dataRoot 是主实例的 | `hooks` 的 `env.dataRoot` 是插件级 → §13.3④ |
| 换了实例但扩展页签不变 | `/ext-ui/list` 有没有带 `dataRoot`；前端 `state` 匹配用的是哪个字段 → §13.3⑤ + 补充 |
| 面板显示的工作区对，但扩展列表是空的 | `dataDir` 是图库目录，不是 dataRoot → §13.3⑤ |
| 读取的配置值像是"上个版本"的 | 读到了 `qqbot-settings/<ns>.json`（少了 profile 层）→ §13.2 |
| 装完扩展包看不到它的 UI | 装包时有没有触发铺设 → §13.4 |
| 页面上的扩展卡片拿不到当前会话 | `window.__qqsDockState` 指针是否随渲染刷新 → §13.3 补充 |

**终极口诀**：**任何路径/状态，先问一句「这是 profile 级、dataRoot 级，还是 cwd 级？」**
答不上来，就先埋点看实际值，别推理。

---

# 十四、扩展 UI 挂载点（v1.11 完整版，2026-10-27）

> §12.5 是这功能的第一版笔记（1.10.26 写的）。这一章是**完整版**，
> 补上了主题、能力包 RPC、路由注册、自动铺设、两套界面机制的区别。

## §14.1 先分清：两套「扩展的界面」，完全不是一回事

这是最容易混的概念。用户、扩展作者、甚至我自己都混过。

| | `qqbotSettingsPage`（老） | `ui/` 卡片（v1.11.0+） |
|---|---|---|
| 写在哪 | 扩展 `.mjs` 里 `export const qqbotSettingsPage = { schema }` | 独立目录 `ui/<id>/card.html` |
| 长什么样 | 面板按 schema **自动渲染**（开关/输入框/下拉） | 作者写的**任意 HTML** |
| 入口 | 扩展卡片上的 **⚙ 设置** 按钮 → 弹窗 | **设置页顶栏** 或 **悬浮球面板**的页签 |
| 数据 | 面板帮你存成 JSON，扩展里 `ctx.config` 读 | 自己管（`getConfig`/`store`/自己写文件） |
| 适合 | 几个配置项 | 复杂界面（列表/按钮/图表/实时数据） |

**一句话**：设置表单是"填空"（面板画），UI 卡片是"画图"（作者画）。
两者可以并存 —— 一个扩展既能声明 schema 让用户填 API Key，也能给一张卡片展示运行状态。

**该改哪份文档**：这个对照在 README / USER-GUIDE / extension-contract 三处都有，
改动时**必须同步三处**（还有市场仓库那份 extension-contract）。

## §14.2 双源与 slot：放错位置就静默不显示

```
slot=settings  →  {PROFILE_ROOT}/.qqbot-extensions/ui/<目录>/     全局一份，所有实例共用
slot=dock      →  {dataRoot}/.qqbot-extensions/ui/<目录>/         每实例一份，能读该实例会话数据
```

**为什么必须分源**（2026-10-26 主人定的）：settings 卡是"全局 UI"，
如果放数据根会导致**每个实例各挂一张**、界面上重复出现；dock 卡要读实例数据，
如果放 profile 就分不清当前是哪个机器人。

**放错源的表现**：**静默跳过，不报错**。作者会觉得"我的卡没出现"，但日志里什么都没有。
判断方法：看卡片的 `slot` 声明与所在目录是否匹配。

**扫描规则**（`src/features/ext-ui.ts`）：

- `slot:settings` 只从 `{profileRoot}/.qqbot-extensions/ui/` 收
- `slot:dock` 只从 `{dataRoot}/.qqbot-extensions/ui/` 和 `extension-packs/<pack>/ui/` 收
- **去重按「目录」而不是 extId** —— 同一个 id 可以有两张卡（settings + dock），
  按 id 去重会把第二张吃掉（2026-10-27 踩过）

## §14.3 元信息与 id 覆盖

```html
<!-- qqbot-ui: { "id": "demo", "slot": "dock", "title": "🔌 扩展示例", "order": 5 } -->
```

写在 `card.html` **前 2KB** 内（`parseMeta` 只读前 2048 字符）。

- `id` **可选**，覆盖目录名。同一个逻辑扩展的两张卡（settings 在 profile、dock 在数据根）
  **必须给相同的 id**，否则 `getConfig()` 会读到两份互不相通的配置。
- `slot` **必填**，决定放哪个源。
- `title` 页签文字；`order` 排序（小的在前，默认 100）。

**`readExtUiFile` 的 `slot` 参数**：因为同 id 可能有两个目录，文件请求必须带 `slot`
才能取到对的那份。前端 `extUiLoad(extId, file, slot)` 已经在传。

## §14.4 卡片能力清单（走 RPC 白名单，不是直接给）

卡片跑在浏览器，能力都在服务端，所以走 `/api/ext/dispatch?p=/__cap&fn=<名字>`。

**后端白名单**（`settings-host.js` 的 `EXT_CAP_ALLOW`）：

| fn | 说明 |
|---|---|
| `store.load` / `store.save` | 数据根下的 KV |
| `kernel.get` / `kernel.has` | 宿主服务（= 代码扩展的 `env.kernel`） |
| `log` | 写进宿主控制台 |
| `owners` / `appId` | 主人列表 / 当前实例 AppID |
| `text` / `markdown` | 往当前会话发消息 |
| `appendSilent` | 静默注入（不唤醒 AI）—— 需要 `agent`，见下 |
| `fs.read` / `fs.write` | 读写本机文本文件（白名单扩展名 + ≤2MB + 写前 `.bak`） |

**前端语义化包装**：

```js
qqbotExt.store.load() / save(v)
qqbotExt.kernel.get('服务名') / has(...)
qqbotExt.cap('fs.read' | 'fs.write' | 'appendSilent' | 'text', ...)
qqbotExt.getConfig(scope) / setConfig(patch, scope)
qqbotExt.acct                      // 当前选中账号 {id, ns, cwd, dataRoot, appId}
qqbotExt.theme / isDark() / onThemeChange(cb)
qqbotExt.dock.sid / peerId / scope / dataRoot / cwd
qqbotExt.dock.context() / sessions() / history(n) / members() / lastAssistantText()
```

**安全取舍**：只暴露白名单里的功能，**不把整个 caps 丢给前端**。
`kernel.get` 返回前会做一次 JSON 序列化试跑，函数/不可序列化的东西回 `{__type}` 描述。

### appendSilent 为什么容易失败（连踩三次）

按优先级取 agent：

```
① sid   → findManagerBySessionId(sid) → findBySessionId(sid) → rec.agent
          （宿主自己的 agent 表就按 sessionId 索引，最短最准）
          ↓ 找不到再试 findHostAgent(sid)（web/hub 这类非 QQ 会话在这张表里）
② peer  → findManagerByPeer(scope, peerId) → findByPeer → rec.agent
③ 都没有 → getOrCreateByPeerWeb(ns, scope, peerId) 主动建（不开回合）
```

**三个坑（都踩过）**：

1. **`peer` 取错字段**：用 `state.gid`（群组管理的选择）而不是 `state.detectedHit.peerId`
   （顶栏「当前会话」），永远是空 → 永远注入失败。
2. **`state` 指针失效**：dock 的 `state` 每次渲染新建，`window.__qqsDockState` 只在初始化
   赋一次 → 后续读到旧对象（`detectedHit` 恒 null）。**每次 `paintBody` 都要刷新指针**。
3. **要求"必须是活跃会话"**：这是面板行为，不该要求用户先去 QQ 发条消息。
   用 `getOrCreateByPeerWeb` 主动建。

**诊断输出**：失败时返回 `diag: { sid, sidFound, sidHasRec, peer, found, hasRec, hasAgent, via }`，
直接看卡在哪一步，别猜。

## §14.5 主题：CSS 变量会穿透 Shadow DOM

插件在 `body` 上定义了两套 token（`QQS_THEME_CSS`），宿主切主题时给 body 加
`data-ds-dark-theme` 属性：

```js
// 亮色
'body{--qqs-card:#ffffff;--qqs-text:#1f2329;--qqs-border:#e2e5ea;...}'
// 暗色
'body[data-ds-dark-theme]{--qqs-card:#232834;--qqs-text:#e8eaf0;--qqs-border:#3a4152;...}'
```

**关键**：CSS 自定义属性能穿透 Shadow DOM → 卡片里直接写 `var(--qqs-text)` 就跟随主题，
**不用自己判断**。

```css
.card {
  background: var(--qqs-card, #fff);
  color: var(--qqs-text, #1f2329);
  border: 1px solid var(--qqs-border, #e6e8ec);
}
```

**一定要带 fallback**（老宿主 token 可能不全）。

**需要逻辑分支时**才用 JS：`qqbotExt.theme` / `isDark()` / `onThemeChange(cb)`。

**踩过的**：示例卡片一开始全是硬编码 `#fff`，宿主切暗色后卡片还是白的，很割裂。

## §14.6 自动铺设：两个时机、三条纪律

**为什么要铺**：卡片必须放在正确的源才能被扫到，但作者/示例不该手动复制。

**两个时机**：

```
① 插件启动时（apply 里调 installExtUi）
   examples/ext-ui/<name>/settings  →  {PROFILE_ROOT}/.qqbot-extensions/ui/<name>-settings/
   examples/ext-ui/<name>/dock      →  {dataRoot}/.qqbot-extensions/ui/<name>-dock/

② 装扩展包时（/market/install 成功后立刻调）+ 启动时
   extension-packs/<pack>/ui/<card>/ → 读 meta.slot
       slot=settings  → 复制到 profile
       slot=dock      → 不用动（本来就在 dataRoot 下）
```

**三条纪律**：

1. **只补不改** —— 目标已存在就跳过，绝不动用户改过的内容。
2. **最多铺 2 个实例**（`maxDataRoots: 2`）—— 用户可能建几十个，全铺太铺张。
3. **任何异常都吞掉** —— 铺 UI 失败不该影响插件启动。

**已知不足**：卸载扩展包**不会**删已铺的卡片（没记录"这张卡来自哪个包"，删不准）。
残留卡片在面板上加载失败，但不影响其他功能。

## §14.7 Shadow DOM 的六条硬边界（设计如此，不是 bug）

1. **样式双向隔离** —— 卡片样式不污染面板，但**面板的 CSS 变量/组件样式也进不来**（除了 token）。
2. **碰不到面板 DOM** —— `document.getElementById` 查不到外面，只能操作自己那张卡内部
   （用 `shadowRoot.getElementById`）。
3. **用不了面板的 React 组件** —— `SButton` / `FieldRow` / `h` 拿不到，只能手写原生元素。
4. **没有构建步骤** —— 不能写 TS/JSX，不能 `import` npm 包（`card.js` 用 `new Function` 执行）。
5. **一切数据走后端** —— 浏览器沙箱碰不了文件系统，要读 SQLite/扫目录/跑 shell，
   都在 `hooks/` 或 `tools/` 里做完，`registerRoute` 注册成路由。
6. **崩溃只白自己那张卡** —— 外面套了 try/catch，不影响面板其他部分。

## §14.8 扩展包带 UI 的打包要求

市场仓库的 `build-index.mjs` 必须认识 `ui/`，否则带界面的包打出来是空卡片。

**2026-10-27 修的三处**：

```js
const KINDS = [..., 'ui'];                          // 扩展点列表
const SHARED_DIRS = new Set(['lib', 'docs', 'ui']);  // 参与打包的目录
const UI_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.svg']);
// files 过滤：ui/ 目录走 UI_EXTS（原来只认 .mjs/.js/.cjs → card.html 被丢掉）
if (top === 'ui') return UI_EXTS.has(ext) || ext === '.json' || ASSET_EXTS.has(ext);
```

**带 UI 的包必须声明 `minPluginVersion`**（ui 是 v1.11.0 起的）：

```json
{ "minPluginVersion": "1.11.0" }
```

不声明的话，旧版插件装了之后那张卡永远不出现，用户会以为是 bug。

**index.json 不要手改** —— 市场仓库有 `build-index.yml` action，
push `packs/**` 或改 `scripts/build-index.mjs` 会自动重建。

## §14.9 排障速查（扩展 UI）

| 症状 | 先查 |
|---|---|
| 卡片压根不出现 | slot 与所在目录是否匹配（§14.2）；`card.html` 有没有元信息注释 |
| 同一扩展的两张卡只出现一张 | `seen` 去重是不是按 extId（应改按目录，§14.2） |
| 两张卡的配置互不相通 | 两张卡的元信息里有没有声明相同的 `id`（§14.3） |
| 卡片白底、不跟暗色主题 | CSS 是不是硬编码颜色（改用 `var(--qqs-*)`，§14.5） |
| 静默注入返回 false | 看 `diag`：peer 空？sid 拿不到？agent 没取到？（§14.4） |
| 读不到 AI 的正文 | 用的是 msg-history（QQ 消息流水）还是 `lastAssistantText`（§14.4） |
| 卡片里 `document.getElementById` 返回 null | Shadow DOM 里要用 `shadowRoot.getElementById` |
| 装完扩展包看不到它的 UI | 装包时有没有触发铺设（§14.6）；包里有没有声明 `minPluginVersion`（§14.8） |
| 市场里带 ui/ 的包装出来是空卡 | `build-index` 的 UI_EXTS / files 过滤（§14.8） |

---

# 十五、扩展工具「按需取用」专题（v1.11.13，2026-10-28）

## 一句话

`expose:'all'` 的扩展工具**始终全局注册**，但**按会话默认 deny**；需要时用元工具 `gain_qq_tools`
领取（per-agent 放开）。设置页开关关掉时元工具一起注销 ⇒ 别人实例的工具**彻底不可见**。

**取用逻辑：平时不占工具位，要用时先 `gain_qq_tools` 搜一下，再 `enable` 具体那个，用完可以 `disable` 卸掉。**

## 为什么不是「默认不暴露」

`expose:'all'` 是**能力**不是泄漏：它让非 QQ 会话（web 工作区里的 AI）能主动往 QQ 发消息/查会话。
默认关掉等于废掉这条能力；真正的代价只是**每个会话都背着全部 schema 的 token**。

## 六个必须记住的结论

### 1. 注册 ≠ 可见（这次最大的坑）

`tools.restrict({ deny })` 只能**隐藏已注册的工具**，不能凭空造出工具。

按需取用第一版为了省注册，直接**跳过全局注册** ⇒ deny 名单里全是"不存在的东西" ⇒
连本实例自己的工具都变成 `unknown tool`（现象：`gain_qq_tools` 在，但 `bing_search__whale-girl` 调不到）。

**正确做法**：扩展工具**始终全局注册**，可见性只由 deny 控制。

### 2. 注册/剪枝的最佳触发点是 `agent/inbox/claimed`

宿主 `dsh-agent-loop` 的 `preStep()` 顺序：

```
① inbox.claim()                          // 同步 emit 'agent/inbox/claimed'（payload 自带 agent）
② systemPrompt.assemble()                // ← 工具表在这里快照
③ dispatch.waterfall('agent/pre-step')   // 插件原先进这里注册 ⇒ 晚一个 step
```

放 pre-step 的现象：开关刚改，本 step 仍拿到旧工具表（模型先拿到 schema、调用时报 `unknown tool`，
之后才弹「工具已更新」）。`pre-step` 保留作兜底（回合中途改开关 / 会话 key 反查失败）。

### 3. 三阶段：扫描 → 先剪枝 → 再注册

曾出现「工具已更新·新增 7 个」→「下个 step 又移除 7 个」的抖动。
根因：**边扫描边注册**，注册发生时 deny 名单还不完整。

正确顺序：**扫描（只填索引）→ 按完整索引剪枝 → 再全局注册**。

### 4. 开关要落文件，不要只放内存 / config

- `config` 是**启动快照**；
- `settings-host` 保存只写自有存储，然后 `Object.assign(resolvedConfig, next)` —— 且只合并到**被保存的那个实例**；
- `globalThis` 又随进程重启丢失。

⇒ 落 `{dataRoot}/.qqbot/ext-meta-tool.json`：设置页保存时写、插件**每轮扫描现读**。

### 5. 读配置要遍历所有实例

面板上不少字段语义是全局的（出站模式、回复节奏、审批、按需取用…），但保存是 per-instance。
只读 `managersOf()[0]` 会读到**没有该字段**的实例（本项目实测：第 0 个是 `standard`，它的 `dataRoot` 还是空的）。
⇒ `for (const m of managersOf()) if (m.config?.xxx === true) return true`。

### 6. `defineTool` 的 `parameters` 是**扁平字段表**，不是 JSON Schema

```ts
parameters: { action: { type: 'string', required: true, enum: ['list', 'enable'] } }   // ✅
parameters: { type: 'object', properties: {...}, required: ['action'] }                // ❌
```

后者注册直接抛：`unsupported JSON schema: parameters.type must be a value schema object`。

## 语义速查

| 设置页开关 | 元工具 `gain_qq_tools` | 自己实例那份（`xxx__本tag`） | 别人实例那份（`xxx__其他tag`） |
|---|---|---|---|
| 开 | 有 | 可见 | 默认 deny，可 `enable` 领 |
| 关 | **注销** | 可见 | **彻底不可见**（连领取记录一起清） |

## 自检清单（改这块之前先过一遍）

- [ ] 注册失败**不要静默 catch** —— 这次就是靠把错误打到 `console.error` 才定位到 `parameters` 格式问题
- [ ] 剪枝的幂等签名要把**开关状态**算进去，否则"内容没变"会被跳过
- [ ] `enable` 之后本回合就能用（走 claimed 的 per-agent register）；跨会话要重新领
- [ ] `disable` 要真收回（从 granted 删 + 重设 deny），不是只删记录
- [ ] 改大 JS 文件一律写 `.py` 脚本执行（别用 `python -c` 内联，shell 多层转义会把 `split('\n')` 吃坏），改完 `node --check`

## 文件速查

| 位置 | 作用 |
|---|---|
| `src/channel-tools.ts` | `makeGainTool` / `ensureGainToolGlobal(..., on)` / `applyExtToolVisibility(agentCtx, selfTag)` / `ensureExtToolsGlobal`（三阶段）/ `extGrantSet` / `extSeenCtx` |
| `src/session/session-manager.ts` | 触发点 `hostCtx.on('agent/inbox/claimed')` |
| `src/config.ts` | 开关字段 `extMetaTool`（默认 false） |
| `settings-host.js` | 保存设置时写 `{dataRoot}/.qqbot/ext-meta-tool.json` |
| `client/qqbot-settings.js` | 设置页「⑨ 群管理基础设置」里的那个勾选框 |


---

## §16 🔴 数据根（dataRoot）推导：**必须只有一个真源**（v1.11.22，2026-10-30，issue #33）

### 现象

群管理台的「锤子 → 踢人 → 刷新二维码」报「没能生成二维码」；直接调接口：

```
POST /api/qqbot-settings/qun/login -> { ok:false, error:'推不出数据根' }
```

但同一台机器、同一份配置，市场接口一切正常：

```
GET /api/qqbot-settings/market?cwd=<workspace> -> { ok:true, index:{...} }
```

用户看就是「市场能用，群管理坏了」，而真实原因是 patch 里**没写 `cwd` / `dataRoot`**。

### 根因：三套推导，各说各话

| 位置 | 口径 | patch 无 cwd/dataRoot 时 |
|---|---|---|
| `src/gateway/data-root.ts`（插件运行时） | `config.dataRoot \|\| {absCwd(cfg.cwd) \|\| process.cwd()}/dshqqbot` | ✅ 有默认值，数据照建 |
| `settings-host.js` 的 `resolveContextlessDataRoot()` | 只认 patch 里**显式写出**的 `dataRoot` / `cwd` | ❌ 返回空 → `qun/*` 全部报「推不出数据根」 |
| `settings-host.js` 的 `resolveDataRootForWorkspace(cwd)` | 有 ④ 兜底，但最后还是回到上一个函数 | ⚠️ 半残 |

更隐蔽的第二层：`parsePatchFrom()` 解析出来的 bot 对象**根本没有 `cwd` 字段**，而下游一大票路由都写的是

```js
const dataRoot = (bot.cfg.dataRoot) ? bot.cfg.dataRoot : (bot.cwd || '');
```

⇒ 只要 patch 没写，`bot.cwd` 恒为 `undefined`，这些路由（导出、图库、群台账、join-pending、
contextless 存储…）全都静默拿到空串。**只有显式配了 dataRoot 的实例（比如本机的鲸鱼娘）才不露馅。**

### 修法

1. **`parsePatchFrom()` 里统一补**（一次收口所有下游）：

```js
for (const b of bots) {
  if (b.cwd) continue;
  const cfg = b.cfg || {};
  b.cwd = cfg.dataRoot ? String(cfg.dataRoot)
        : join(absCwd(cfg.cwd) || process.cwd(), 'dshqqbot');
}
```

> ⚠️ `bot.cwd` 的**历史语义是「数据根」**，不是工作目录（`cfg.cwd` 才是工作目录）。别被名字骗。

2. **`resolveContextlessDataRoot()` 加同口径兜底**：patch 推不出来时，只要**存在启用中的实例**，
就返回 `{absCwd(cfg.cwd) || process.cwd()}/dshqqbot`；一个实例都没有才返回空（面板不该凭空造数据根）。

3. 顺手把 `cfg.cwd` 分支改成 `join(absCwd(cfg.cwd) || cfg.cwd, 'dshqqbot')` —— 安卓那种相对路径
（`storage\emulated\0\大肥鱼`）直接 join 会跑到进程 cwd 下，凭空多一套幽灵数据根（issue #18 同款）。

### 教训（这条最值钱）

**同一个「数据根」概念，代码里出现了三份推导**（插件一份、host 两份），任何一份口径不一致就会出现
「这个功能能用、那个功能坏了」的诡异现象。以后新增接口要数据根时：

- 桥层一律走 `resolveContextlessDataRoot()` / `resolveDataRootForWorkspace()`，**不要自己再写一套**
- 判断「能不能用」时先看 `bot.cwd` 是否有值 —— 它现在在 `parsePatchFrom` 里已经补好了
- 默认口径永远对齐 `src/gateway/data-root.ts`

---

## §17 🔴 扩展工具（`expose:'all'`）的注册与按需取用（v1.11.31，2026-10-30）

> 这一节是**踩了七八次坑**才收敛下来的结论。凡是动 `channel-tools.ts` 里
> `ensureExtToolsGlobal` / `applyExtToolVisibility` / `gain_qq_tools` 这三块的人，
> **先读完这节再动手**，否则一定重复踩同样的坑。

### 一、注册作用域：只有 `agent.ctx` 算数（实测对照）

`dsh-tools` 的 `register()` 类型注释原文：

> Register **globally or in the calling agent scope**. Scoped tools shadow globals.

**落在哪一层，由调用 register 时那个 ctx 属于谁决定**。实测（同一次运行，同一份工具定义）：

| 注册到 | 结果 |
|---|---|
| `ctx.root`（全局层） | ⚠️ **所有**会话都能看见，包括 web 里的普通会话 ⇒ 泄漏，只能靠 `restrict` 遮 |
| `apply(ctx)` 的 ctx（插件 apply 参数） | ❌ QQ 会话调用报 `unknown tool` |
| `ctx.get('tools')` | ⚠️ 是**服务查找**，向上拿到的是**根层实例** ⇒ 等于注册到全局 |
| **`toolsOfScope(agentCtx).register`（agent 自己的 ctx）** | ✅ **立刻可用，且别的会话天然看不到** |

> `toolsOfScope()` 内部实现要点：**优先 `ctx.tools`（属性访问，绑定本作用域）**，
> 拿不到才退回 `ctx.get('tools')` —— 后者永远是根层，别单用它。

### 二、正确形态：按会话注册（per-agent）

```
每个 QQ agent 在 agent/inbox/claimed（同步派发，本 step 生效）+ agent/pre-step：
  want = { 本实例自己的(__selfTag) } ∪ { 本会话已领取的 }
  want -= extUserOff（用户主动关掉的）
  sig 没变 → 直接 return（防抖）
  多出来的 → 调 disposer 撤掉；缺的 → toolsOfScope(agentCtx).register 注册
```

- **不需要 `restrict({deny})`**：非 QQ agent 压根不跑这段，天然零泄漏
- `agent/inbox/claimed` 是宿主的**同步**事件，宿主顺序是 `claim → assemble(工具表快照) → pre-step`，
  所以**必须在 claimed 里做**，只挂 pre-step 会晚一个 step（现象：开关变了，第一轮还是旧工具表）

### 三、「这个 agent 归不归本实例」怎么判断（关键！）

```ts
// ✅ 正确：和 syncScopedToolsOnClaim 同一口径
if (this.nsForCwd(String(session?.header?.cwd ?? ''))) { 用本实例 tag; }
else { tag = ''; }   // 非本实例 ⇒ 不注册
```

| 错误写法 | 后果 |
|---|---|
| `findByAgent(agent)` 命中与否当判据 | 它一失手（对象引用/时序不同）⇒ tag 空 ⇒ **自己实例的工具也没了** |
| 拿不到就兜底 `this.config.preset` | 把**非 QQ 的 agent 当成自己人** ⇒ 给它注册本实例工具 ⇒ **泄漏** |

> 这两条是**同一个 bug 的两个方向**，改的时候两个方向都要防。

### 四、「扩展工具按需取用」开关是**按实例**的

- 存储：每个实例各自 `{dataRoot}/.qqbot/ext-meta-tool.json`（面板保存时写到"当前编辑实例"的 dataRoot）
- **扫描只扫勾了的实例**：没勾的实例，它扩展目录里的 `expose:'all'` **不进索引**
  ⇒ `gain` 既列不出、也领不到（这是"关掉就该彻底消失"的要求）
- **`gain_qq_tools` 本身：任一实例勾着就注册**（`metaOn` 遍历所有实例取"或"）

> ⚠️ 老代码读的是 `managersOf()[0]` 的开关文件 —— 第 0 个通常是**别的实例**（standard），
> 它一关就把 `gain` 入口整个摘掉，即使本实例还开着。**永远不要对多实例取下标 0**。

### 五、`gain_qq_tools` 的语义（别写反）

| 动作 | 语义 |
|---|---|
| `list` / `search` | **只列别的实例的**（本实例自己的工具已自动可用，列出来是噪音）<br>非 QQ 会话拿不到 tag ⇒ 不过滤 |
| `enable` | 记进 grant **+ 现场注册到当前 agent ctx**（不重启不换轮就生效） |
| `disable` | 加进 `extUserOff` **+ 立刻调 disposer 注销** + sig 置空强制重算 |

> ⚠️ **`disable` 最容易写成假动作**：按会话注册里"自己实例那份"是**无条件**算进 `want` 的
> （`full.endsWith('__' + selfTag)`），所以只删 grant 根本没用 —— 下一轮 apply 又把它算回来并重新注册。
> 实测表现：`disable` 返回"已收回"，紧接着调用**照样返回真实结果**。
> 必须两个都做：`extUserOff` 排除 + 立即 dispose。

### 六、清单文件（给非 QQ 会话看"能领什么"）

- 位置：**每个实例各自** `{dataRoot}/.qqbot/ext-tools-index.json`
- 内容：`{ updatedAt, instance, dataRoot, tools: [{ full, tag, baseName, description, dataRoot, cwd }] }`
- 只列**本实例**的 `expose:'all'` 工具
- 与注册行为**无关**（注册早已走 per-agent），它只是"可领取名单"的持久化形态

> ⚠️ 落盘时别用 `insts[0]`：没显式配 `dataRoot` 的实例会让条件不成立 ⇒ 整段静默跳过 ⇒ 文件永不生成。
> 兜底用 `dataRootOf(config)`（`config.dataRoot || {cwd}/dshqqbot`）。

### 七、自检清单（改这块之前过一遍）

1. 注册是不是走的 `toolsOfScope(agentCtx).register`？（不是 `root`、不是 `get('tools')`）
2. 注册时机是不是在 `agent/inbox/claimed`（同步、assemble 之前）？
3. 「归不归本实例」是不是用 `nsForCwd(cwd)`？有没有"兜底成 preset"的残留？
4. 扫描是不是只扫勾选实例？`metaOn` 是不是"任一开即为开"？
5. `disable` 是不是**既**加了 `extUserOff` **又**调了 disposer？
6. 清单落盘是不是**每实例一份**、兜底用 `dataRootOf`？
7. 改完**必须双验**：`grep src` 和 `grep dist` 数一致（Windows 上 python 改中文路径可能"报成功但没写盘"）

### 八、验证矩阵（每次改完都跑一遍）

| 场景 | 期望 |
|---|---|
| QQ 会话 · 本实例 `expose:'all'` | 自动可见、可直接调用 |
| QQ 会话 · 别的实例（勾着） | 默认不可见；`enable` 后立即可用；`disable` 后立刻 `unknown tool` |
| 别的实例**没勾** | `gain list` 里根本不出现 |
| 非 QQ 会话 | 零扩展工具（连 `__<tag>` 都不该有） |
| 二号开 + 三号关 | `gain_qq_tools` 入口仍在 |
| 同一操作做两次 | 工具表**不抖**（不出现"新增 N → 下轮又少 N"）|

---

## §18 🔴 工具注册与「会话查找」的五层断点（v1.11.43，2026-11-06）

> 这一节是**连环踩了五次**才杀干净的。现象统一是：**web/桌面里对话时，扩展工具和内置工具
> 全报 `unknown tool` 或「未找到当前 QQ 会话(通道未就绪)」，而发一条 QQ 消息就好了。**
> 下次再遇到"工具缺失/通道未就绪"，**按这五层从上往下逐层验**，别跳。

### 5 层断点（任何一层断，表现都一样）

| # | 断点 | 现象 | 修法 |
|---|---|---|---|
| 1 | **注册点太少**：内置工具只有 `inbound.ts:368 ensureChannelTools(record)` 一个入口 | 必须有 QQ 消息才注册 | 补到 `agent/created` + `agent/inbox/claimed` |
| 2 | **钩子挂太晚**：`ensureGroupRules()` 原来在第一条 QQ 消息时才挂，而 `agent/created` 是**一次性事件** | 钩子挂上时 agent 早建完了，永远收不到 | 网关启动成功后就对所有 manager 挂一次 |
| 3 | **查找只认 agent 对象**：`findSessionRec` 用 `findByAgent(exec.agent)` | web 回合的 agent 是宿主新建的**另一个对象**（同 sessionId 不同引用）⇒ 永远 miss | 补按 `session.api?.id`（sessionId）反查 |
| 4 | **sessionKey 的 appId 有多个真源**：`model-prefs.json` 里是旧 appId | 精确匹配查不到 ⇒ 老会话被当新会话重建 ⇒ record 消失 | `getSessionId` 兼容匹配 + 认领迁移（只迁读到的那条，不批量刷） |
| 5 | **预热串实例**：`warmSessions` 用 `findManagerByPeer(scope, peerId)` | 它会遍历所有 manager 返回第一个命中的 ⇒ 多实例下建到了**别的实例**（日志还写"6/6 成功"） | 用 `getManagerByNs(ns)` 精确取 |

### 关键认知（比修法更值钱）

**① 「注册」≠「可用」。** 工具注册进作用域只是第一步，执行时还要能**查到自己的会话坐标**
（`ctxEnvMap` 里的 `dataRoot` + `sessionKey`）。少一样就报「通道未就绪」。

```ts
// 注册前必须先种坐标
setCtxEnv(agentCtx, { dataRoot, sessionKey });
mountChannelTools(agentCtx);
```

**② 注册要用 `record.agentCtx`，不是 `agent.ctx`。**
`qqChannel` 服务是插件在 setup 阶段注入到 `record.agentCtx` 上的；
拿宿主的 `agent.ctx` 去 `ctx.get('qqChannel')` 取不到 ⇒ 工具是空壳。

**③ 多实例场景下，一切「按 peer 找 manager」都要警惕。**
`findManagerByPeer` 是给**外部调用**（不知道 ns）设计的便利函数，
**插件内部知道自己是谁时，一律用 `getManagerByNs(ns)`**。

**④ 工具表快照只在回合开始时拍。**
`systemPrompt.assemble()` 在 `agent/inbox/claimed` **之后**、`agent/pre-step` **之前**。
所以在 `pre-step` 里注册会**晚一个 step**。注册必须挂在 `claimed` 或更早的 `agent/created`。

```
inbox.claim()  →  agent/inbox/claimed   ← 注册点（同步派发，payload 自带 agent）
systemPrompt.assemble()                  ← 工具表在这拍快照
dispatch('agent/pre-step')               ← 晚了
```

### 排障手法（这次全靠它）

`findSessionRec` 查不到时会往 `~/.dsh/contextless-trace.log` 写：

```
[findSessionRec-miss] sid=<8位> bridges=<N> byAgent=miss bySid=miss known=[<sessionKey>=<sid8>, ...]
```

- `bridges=0` → 桥没挂（`setChannelBridge` 没跑到）
- `sid` 为空 → 回合 agent 压根没带 session.id
- `known` 里没有目标 peer → **record 不存在**（注册/预热问题，不是查找问题）
- `known` 里 schema 的 appId 与当前不符 → **appId 真源不唯一**

**这条日志是排查这类问题的第一手证据**，别靠猜。

---

## §19 🔴 多路径注册 + 热替换 = 工具会「永久消失」（v1.12.0，2026-11-06）

> 这一节是 §18 的续集。§18 讲「注册点太少」，这一节讲**注册点太多**。
> 两个方向都能把工具搞没，而且现象一模一样（`unknown tool` / 通道未就绪）。

### 事故：`resource_lookup` 时有时无，最后彻底调不到

**现象**：
- 日志写着「注册成功: resource_lookup」✓
- `node -e "import('./resource_lookup.mjs')"` 也能正常加载 ✓
- 但调用就是 `unknown tool`，reload 也没用

**真正原因**：**每回合都在"先拆后建"**。

```ts
// channel-tools 的扩展注册段（热替换）
const prev = myDisposers.get(scopedName);
if (prev) {
  try { prev(); } catch {}          // ← 先把旧的注销
  myDisposers.delete(scopedName);
}
const d = ctx.tools.register(tool);  // ← 再注册新的
```

只要 `register` **有一次失败**（schema 不合、外部依赖加载异常、宿主状态异常…），
**旧的已经没了、新的也没上** ⇒ 工具**永久消失**。

`resource_lookup` 为什么最惨：
1. 它**最早注册**，disposer 在 `globalThis` 上留得最久（`Symbol.for('im-qqbot.extToolDisposers')`）
2. 它有**外部依赖**（`opencc-js`，用 `createRequire` 懒加载）—— 最容易在注册路径上出岔子

### 为什么 1.11.42 没这问题

| | 1.11.42 | 出事时 |
|---|---|---|
| 注册路径 | **只有 `inbound` 一条** | `agent/created` + `claimed` + `getOrCreate`×2 + 预热 |
| 频率 | 每条 QQ 消息一次 | **每回合**一次（含 web/定时/注入）|
| 重名处理 | `already registered` → 静默跳过 | 同上，但**先被自己拆掉了** |
| 结果 | 工具只被"加"，永远在 | 反复拆装，一次失败就没了 |

**核心教训**：**"多注册几次总有一次成功"是错的**。
如果注册本身是"破坏性的"（先拆后建），那**多注册 = 多风险**，不是多保险。

### 修法：签名缓存（defs 没变就不动）

```ts
const curSig = extSigOf(defs);        // 名字 + expose + 描述 + inputSchema
if (prevSig === curSig && myDisposers.size > 0) {
  extDiag('扩展工具未变化，跳过重复注册');
  return;                              // ← 一根手指都不动
}
```

| 场景 | 行为 |
|---|---|
| 第一次加载 | 正常注册 |
| 后续每回合（defs 没变） | **完全跳过**（零风险、零开销）|
| 真改了某个 `.mjs` | defs 变 → 走一次热替换（这次失败才可能丢，但你本来就在改）|

**副作用是好的**：每回合从「34 个工具 × (注销+注册)」降到**一次字符串比对**。

### 同类风险清单（改之前先看）

凡是"注册/挂载/绑定"这类操作，**只要包含"先拆后建"，就天然有这个坑**：

- `mountChannelTools`（扩展 + 内置工具）
- `applyExtToolVisibility`（扩展工具按作用域注册）
- `syncChannelScopedTools`（上下文三件套 + 群管理）
- `syncContextTools`（pre-step 每步刷新）

**统一纪律**：这类函数**必须自带签名/幂等判断**，不能靠调用方"重复调也没关系"。

### 排障手法

```bash
# 1. 看它到底注册了没
grep "注册成功: <name>" ~/.dsh/qqbot-ext-diag.log
grep "注册失败: <name>" ~/.dsh/qqbot-ext-diag.log   # ← 这条最容易被忽略

# 2. 模块本身能不能加载（排除依赖问题）
node -e "import('./xxx.mjs').then(m=>console.log('OK', m.default.name))"

# 3. 有没有重名文件/重名工具
find . -name "<name>*" ; grep -rn "name: '<name>'" src/
```

**三条都正常却还 unknown** ⇒ 基本就是本节说的「被反复拆装后永久丢失」。

---

## §20 🔴 多实例下「调用方知道自己是谁」就别让被调方去猜（v1.12.0）

### 事故：鲸鱼娘 30 个扩展一个都没加载

```
apply extRoot=D:\newwenjianjia\aiwork\测试客户端\dshqqbot  defs=9
                     ↑ 隔壁 standard 实例的数据根，不是鲸鱼娘
```

而扩展面板显示「61 个内置扩展 / 4 个扩展包 / 3 个带设置页」——**面板是对的，加载是错的**。

### 根因：`extRoot` 的解析链全是"可以猜错"的兜底

```ts
const extRoot = (qqCh?.manager?.dataRoot)          // ① agent/created 阶段可能还没注入
             || (bridgeCh?.manager?.dataRoot)      // ② channelBridges[最后一个] ← 隔壁的桥
             || (ctx as {cwd}).cwd
             || process.cwd();
```

两条兜底在多实例下都会指向**错的实例**。

### 修法：显式传参，最优先

```ts
export async function apply(ctx: Context, opts?: { dataRoot?: string; cwd?: string })

const extRoot = (opts?.dataRoot && String(opts.dataRoot).trim())
  || qqCh?.manager?.dataRoot
  || …（兜底保留，单实例时照常工作）
```

调用方（`session-manager`）全部改传 `this.resolveDataRootSmart()` + `config.cwd`。

### 推广到所有"坐标类"参数

对齐 §16（数据根唯一真源），下面这些**都得显式传，不能猜**：

| 参数 | 猜错的后果 |
|---|---|
| `dataRoot` | 加载隔壁的扩展 / 写错库 |
| `cwd` | 扩展 `env.cwd` 错，工作目录串 |
| `ns`（实例标识） | 切模式落到别的实例 |
| `sessionKey` | 备忘/上下文工具写错会话 |

### 一条可复用的判断

> **插件内部调用自己的函数时，调用方几乎总是知道自己是谁**（`this.xxx` / 闭包里就有）。
> 一旦你在内部调用里看到"从全局兜底里找自己是谁"，那**大概率就是 bug 温床**。

---

## §21 🔴 agent 身份的两个坑：对象引用 vs sessionId，和 ctx 选错（v1.12.0）

### 坑 A：`findByAgent` 在 web 回合永远 miss

```ts
record.agent        = QQ 入站时创建的那个 agent 实例
exec.agent（web 回合）= 宿主自己恢复/新建的 agent 实例
                        ↓
                 同一个 sessionId，但对象引用完全不同
                 findByAgent 返回 undefined ⇒ 所有通道工具「未就绪」
```

**修**：`findSessionRec` 补按 `session.id` 反查（sessionId 跨 agent 实例稳定）。

### 坑 B：注册到 `record.agentCtx` ≠ 当前 agent 能看到

工具表是按**当前回合 agent 的 ctx** 组装的。
注册到 `record.agentCtx`（会话创建时的那个旧对象）⇒ **注册成功但当前回合看不到**。

**修**：注册要落到 `payload.agent.ctx`（`claimed` / `agent/created` 里都能拿到）。

**但注意**：`agent.ctx` 上可能**取不到 `qqChannel` 服务**（那是 setup 阶段注入到 `record.agentCtx` 的）。
所以正确组合是：

```ts
// 注册到当前 agent 作用域（本回合看得见）
mountChannelTools(agent.ctx, { dataRoot, cwd })   // 显式传根 ⇒ qqChannel 取不到也能工作
// 顺便也给 record.agentCtx 注册一份（同一 agent 复用场景）
```

### 坑 C：异步注册 vs 同步快照

```
inbox.claim()            → agent/inbox/claimed（同步派发，**不能 await 监听器**）
systemPrompt.assemble()  → 拍工具表快照
agent/pre-step           → 晚了一步
```

`mountChannelTools` 是 **async**（要 `await import` 每个 `.mjs`）。
在这里 `void mountChannelTools(...)` ⇒ 加载没完，快照已拍 ⇒ **本回合第一个 step 看不到**。

**修**：在**能 await 的地方**（`getOrCreate` / 预热）等它加载完；
`claimed` 里只做兜底（配合 §19 的签名缓存，实际上不会重复跑）。

---

## §22 诊断文件清理（别让日志越堆越大）

排查期加的诊断（`[findSessionRec-miss]` / `[warm]` trace）**验完就删**。
`~/.dsh/` 下这类文件是**全量追加**，一个 `contextless-trace.log` 一天能长到 1.7MB：

| 文件 | 典型大小 |
|---|---|
| `qqbot-extglob.log` | ~2MB |
| `dsh-auto-memory-*.log` | 各 ~1.2MB |
| `qqbot-send-diag.log` | ~800KB |
| `qqbot-ext-diag.log` | ~350KB |

删之前先确认**没有进程正在写**（Windows 删不掉占用中的文件，可先 `Set-Content` 清空）。

**保留策略**：`qqbot-ext-diag.log` 值得留（注册成功/失败都在里面），其余可随手清。

---

## §23 🔴 图片渲染的三个坑（v1.12.2，2026-11-06）

> 症状统一是「图片发出去但不显示」——不报错、不降级、群里就是空的。
> 三个坑互相独立，任何一个都会导致同样的结果。

### 坑 1：尺寸被「去重」吃掉（正方形图专属）

`normalizeMarkdownImages` 里曾有：

```ts
if (sizes.includes(n)) continue;   // ← 去重
```

`#200px #200px`（正方形）第二个 200 被当成"重复"删掉 ⇒ `sizes.length === 1`
⇒ `sizePart = sizes.length === 2 ? ... : ''` 拿到空串 ⇒ **尺寸整个消失**。

而 QQ 要求 markdown 图片**必须带两个尺寸**，缺了直接不渲染。

**表现**：长方形图一直正常（两个值不同），**只有正方形会失效** ⇒ 看起来"时好时坏"。

**修法**：不去重，按出现顺序取前两个数字（宽高可以相同）。见 `md-media-rewrite.ts`。

### 坑 2：本地图会自动补尺寸，外链不会

`rewriteLocalMarkdownImages` 对**本地图**：

```ts
const dim = up.width && up.height ? ' #' + up.width + 'px #' + up.height + 'px' : '';
out = out.split(item.raw).join('![' + alt + dim + '](' + imgSrc + ')');
```

⇒ 上传时读文件头拿真实宽高，**并剥掉你写的尺寸换成真实的**。所以本地图**可省尺寸**。

但 `isLocalImagePath()` 明确排除 `http(s):` ⇒ **外链完全不被处理**：
你写多少就是多少，**不写就不渲染**。

**修法（提示词层面）**：分情况说明，别混为一谈。见 `config.ts` 的 systemPrompt。

| 类型 | 尺寸 |
|---|---|
| 本地路径 | 可省（自动补，且会覆盖你写的） |
| 外链 | **必须写两个** |
| `#0px #0px` | 自适应原比例（外链也能用） |

### 坑 3：`#0px #0px` = 自适应

实测（安卓 / Windows QQ）：尺寸写 `#0px #0px` 就是**按原图比例自适应**，不用算宽高。

适合"不想管尺寸"的场合。**头像是固定 50×50，仍要写实值。**

> ⚠️ iOS 端未实测。

### 排障顺序（遇到"图片不显示"）

1. **看实际发出的 payload**（日志或 `send_md3` 的「实际发送」回显）
   —— 尺寸还在不在？这是最快的判断
2. 尺寸没了 ⇒ 坑 1（规范化去重）或 坑 2（外链没写）
3. 尺寸在但仍不显示 ⇒ 外链被 QQ 转存失败（源站防盗链）
   - 证据：群里显示的地址变成 `qqbot.ugcimg.cn/<appId>/...`
4. 本地图不显示 ⇒ 检查素材上传是否成功（`qqbot-media://` 引用）

### 一条经验

**"规范化"这类改写函数最危险的地方是「静默改写合法输入」**。
`#200px #200px` 是完全合法的 markdown，被"去重"处理成残缺形式，
而下游（QQ）对残缺**不报错、不降级、直接无视** ⇒ 极难定位。

写这类函数时的纪律：**只修真正的畸形，不动合法输入**（对齐手册第 66 行「改形式 = 改语义」）。

---

## §11.39 🔴 上下文注入**一条一块**：绝不要和群守则共用 body（v1.12.15，2026-11-10）

### 现象

群里的小传（people_memo）**只有会话第一轮注入过一次，之后再也不出现**；
同一个群重启 dsh、换话题、上下文清空后都不行。日志里没有任何报错。

### 根因

小传的行被拼进了**群守则那条 `body`**：

```ts
const body = [通道上下文, 引用指令, rules, memoLine, 智能提示].join('

');
```

而 `body` 整块有个去重：

```ts
if (inBatch) skipGroupRules = true;          // 群守则已在本批/历史里
... (skipGroupRules ? [] : [desired])        // ← 整块被丢弃
```

**群守则只要注过一次，之后每轮都 `skipGroupRules = true`** ⇒ 和小传**一起被丢掉**。
第一轮能进，是因为那时群守则还没进上下文。

### 铁律（2026-11-10 主人定）

> **不同的注入内容必须各自成块、各自去重，绝不共用同一条 `body`。**

具体：

| 注入内容 | 变化频率 | 去重判据 | 载体 |
| --- | --- | --- | --- |
| 群守则 / 通道固定上下文 | 只在改配置时变 | 内容指纹（`rulesFp`） | `body` → `source.kind='qqbot:group-rules'` |
| **群友小传** | 每轮可能不同 | **逐行**判上下文是否已有 | **独立块** → `source.kind='qqbot:people-memo'` |
| 智能提示（话题判断） | 每轮变 | 先剔旧再插（替换式） | 拼进 `body` 但只比对固定部分 |

新增任何"运行时上下文"（备忘、提醒、状态）时照抄这套：
**自己的 `source.kind` + 自己的判重 + 自己 push 进 `extraAll`**，
**不要**图省事塞进已有 `body` —— 那个 body 随时可能因为别的内容没变而被整体跳过。

### 顺带的三个坑（同一天连环踩出来的）

1. **注入暂存不能是模块级单变量**：`let pendingMemoText` 全局共享 ⇒ A 群的小传被 B 群的 pre-step 取走，
   表现为「这个群没有这个人，却注入了他的小传」+「那个群反而没有」。
   → 改成 `Map<sessionKey, …>`，key 用 `qqbot:<appId>:<scope>:<peerId>`（与 `sessionKey()` 完全一致）。
2. **不要按时间做"24 小时只注一次"**：上下文一清空/压缩就永远想不起来了。
   → 判据只认「**这一行现在是否在上下文里**」。
3. **判重不能用"整段前 N 字符"**：前缀里基本只有昵称和第一条，后面换了内容也命中
   ⇒ 新条目永远进不来。→ **逐行**取单行前 24 字符判。

### 验法

日志里应有（`session-manager` pre-step）：

```
[小传] 注入 63 字 (session=qqbot:1905515836:group:…)
```

没有这一行，就说明**入站没算出候选**（`recallLines` 空/归档）或 **pre-step 判重把它跳过了**，
不要再怀疑"是不是没生效"。

---

## §11.40 🔴 「主人 web 直发」标记判定：按回合 → 按条（v1.12.26，2026-11-13）

### 现象

主人在 DSH 宿主 web 界面直接打字，正文本该被拼上 `【主人在 DSH 宿主界面直接发送】`，
但从某个时刻起**大量丢失**：`开了` / `不是抓完了你不去看？` / `你先看看代码…` 全都没有前缀。
落盘诊断 `{dataRoot}/.qqbot/web-direct.log` 里也是断档的。

### 根因

`src/session/session-manager.ts`（agent/pre-step 里那段）原来的判定是**回合级**的：

```ts
const isQqTurnNow = recMemo ? recMemo.turnOrigin === 'qq' : false;
if ((recMemo || isQqSessionByPrefs) && !isQqTurnNow) { /* 加标记 */ }
```

`turnOrigin` 由 QQ 入站置 `'qq'`（`inbound.ts`）、`turn/end` 清空（`outbound.ts`）。
群里一刷屏，主人的 web 消息和群友消息被**收进同一个回合** ⇒ `turnOrigin === 'qq'`
⇒ 整回合跳过，主人同一回合里打的那几条也一起被跳过。

### 修法：按**条**判宿主 `user-rpc` 变体

反查宿主类型表（`dsh-session` 的 `MessageSourceMap`）：

```ts
user:      { kind: 'user' }
user-rpc:  { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string; principal?: Principal }
```

`user-rpc` 就是"客户端 RPC 提交的提示词"（web / 桌面界面都走 `dsh-api-session-controller`）。
⇒ 判据：

```ts
if (mm.source?.kind !== 'user' || typeof mm.source.rpcId !== 'string') return m;  // 不是界面直发
```

- **QQ 入站**：插件 5 处构造点全是裸 `{kind:'user'}`（`inbound.ts` 的 458/682/1068、
  `debounce.ts` 414、`ext-inbound-context.ts` 572）⇒ 永远不带 rpcId ⇒ 不会被误标。
- **插件注入**：`qqbot:group-rules` / `qqbot:people-memo` / `plugin:qqbot-approval` /
  `compact-checkpoint` / 定时任务的 `subagent-settled` ⇒ kind 不是 `'user'` ⇒ 天然排除。
  （原来那句 `kind.startsWith('qqbot:') || kind === 'system'` 已隐含在新判据里，可删。）
- **宿主官方插件用的是同一判据**（可对照）：`dsh-client-file-upload` 判
  `source.kind !== 'user' || !('rpcId' in source)`；`dsh-experimental-auto-review` 判
  `source.kind === 'user' && typeof source.rpcId === 'string'`；`dsh-time-context` 用
  `rpcId + clientTimeZone` 取时区。

### 已知边界

- 宿主 `dsh-subagent` 的 `prompt()` 也构造 `{kind:'user', rpcId: request.requestId}`
  ⇒ 经 subagent API 往 QQ 会话投 prompt 会被标成"主人直发"（实测极少，且语义上也确实是界面提交的）。
- 实测数据（2026-11-13）：本 QQ 会话 11 条 user/message 中，主人 web 打的 4 条全带
  `rpcId + clientTimeZone`；1828 条 QQ 入站 0 条带。近 24h 全库 9 个会话：
  `user+rpcId=1257`、`user(无rpcId)=8765`。

### 顺带两条

1. **`turnOrigin` 不要删** —— `outbound.ts` 的 `webTurnSilent` 还靠它判"这一回合要不要发 QQ"。
   这次只删了它在"直发标记"里的用法。
2. 落盘日志改成**真的加了才写**，并带条数：`已加标记 n=2 session=…`。
   旧版无论加没加都写一行，肉眼分不清"加上了"和"进了分支但一条没加"。

### 验法

群里刷屏时让主人从 web 打一句：

```powershell
Get-Content "<dataRoot>\.qqbot\web-direct.log" -Tail 5
```

应看到新行且 `n>=1`；同时会话里那条带前缀、**同回合的群友消息没有前缀**。

---

## §11.41 🔴 群昵称 / 群角色：**昵称只追加、不替换**（v1.12.28，2026-11-13）

### 背景

2026-11-13 起 QQ 官方给消息事件的 `author` 补了字段（`api-v2` 文档还没同步，公告在开发者频道）：

| 字段 | 群聊 | 私聊 | 说明 |
|---|---|---|---|
| `username` | ✅ | ✅（新） | 账号昵称 |
| `member_nickname` | ✅ | — | **本群名片**（群主/本人可改，常写「××-搬砖中」「群管理·老王」） |
| `member_role` | ✅ | — | `member` / `admin` / `owner` |
| `avatar` | ✅ | ✅（新） | 带签名参数（`?key=…&kti=…&s=640`）→ **会过期**，只能即时用/做快照 |

### 铁律（2026-11-13 主人口头定，别再踩）

> **群名片只追加到"显示"，绝不替换 `senderName`。**

原因：群友小传（`people-memo`）按 `senderName` 落盘并**用用户名做检索**，台账（`group-members.jsonl`）、
`id_lookup`、正文里的 `@昵称` 解析全是同一口径。`senderName` 一改成名片名，历史小传/检索/认人立刻错位。

规则（`inbound.ts` 的 `withMemberNick()`）：

- 名片为空 → 不加
- 名片 == 账号名 → 不加（零额外 token）
- 账号名拿不到（空 / 就是 openid）→ **直接用名片**
- 两个都有且不同 → `[做早饭(群昵称:这是昵称) #111310r]`
- `#短号` 的位置与格式**不变**（`[rf:短号]` 引用、`id_lookup` 反查都靠它）

### 已知未做（别以为漏了）

1. **群历史行**（`mediaHistoryBuffer` 的 `HistoryEntry`）仍只显示账号名 —— 要带名片得给条目加字段；
   当前只处理"当前这条消息"（主人只点了这个）。
2. **头像 `avatar`** 没接：带签名会过期，接的话只能存快照/即时展示（`lib/avatar.mjs` 的下载链路现成）。
3. **`member_role` 权限分级** —— 主人 2026-11-13 明确："先记下来，等以后优化插件"。设计意图（群主视角）：
   - 对 `owner` / `admin` 更服从；对 `member` 保持闲聊语气
   - 群管理工具（禁言/踢人/审批）执行前**按角色前置校验**，别把管理员当普通成员处理
   - 决策可信度分档：群主说"踢了他"可直接执行；普通成员说同样的话先确认
   - 反冒充：冒充管理层来套权限的，按 `member_role` 当场识破
   - 实现位置候选：`inbound.ts` 解析 + `people-memo` 写入栏位 + `reply_gate` / `channel-tools` 的群管理工具

### 验法

群聊里让**名片与账号名不同**的人发一句，看入站标签应是
`[账号名(群昵称:名片) #短号]`；同一人把名片改成账号名后，标签应退回 `[账号名 #短号]`。
单测：`npx vitest run src/transport/inbound-tag.test.ts`（10 条，含名片相同/为空/账号名缺失四种分支）。





### 附：dock 聊天页的标签解析（2026-11-13，同一个坑的另一半）

`settings-host.js` 的 `chatPolishOne()` / `chatSplitHistoryBlock()` 各有一处 `[^\]\n:]` 正则
（**排除冒号**）—— 新格式带 `(群昵称:xxx)` 一带冒号就漏判 ⇒ dock 把整行当正文显示；
同时 `[图片聚合]` 不在 `RE_MARKER_WORD` 里，被当成发送者名。

已改为统一走 `chatParseSenderTag()`（先剥 `#短号` 与 `(openid)` 尾巴再判名片）+
`chatSenderLabel()`；`RE_MARKER_WORD` 补 `图片聚合` / `图片已省略` / `消息号`。

> ⚠️ **以后再改入站标签格式，`src/transport/inbound.ts` 与 `settings-host.js` 两边都得改。**
> 只改 src ⇒ 模型侧正常、dock 侧错乱（本次就是主人先发现的），而且 dock 解析失败是**静默**的。

---

## §24 🔴 工具注册与可见性 · 总纲（2026-11-14）

> 这一节是**唯一入口**。§4.6 / §11.36 / §17 / §18 / §19 / §20 / §21 里的结论都被本节统摄，
> 那些小节保留作历史踩坑记录，但**下判断一律以本节为准**。
> 凡是要动 `channel-tools.ts` 的注册相关代码，先读完本节 + §17。

### 24.1 宿主侧真相：**没有 `enabled` 这种概念**

宿主的 `ctx.tools.register(def)`（`packages/core/tools`）只有一层语义：

> Register globally or in the calling agent scope. Scoped tools shadow globals.

**注册即存在。** `ToolDefinition` 的字段里**没有** `enabled` / `visible` / `when` ——
宿主不提供任何"按条件决定要不要有这个工具"的钩子。

宿主能用的可见性手段只有两个：

| 手段 | 语义 | 特点 |
|---|---|---|
| **注册作用域** | 注册到 `agent.ctx` = 只有那个 agent 看得见；注册到 `ctx.root` / `get('tools')` = 全局继承 | 结构性隔离、零窗口期 |
| **`ctx.tools.restrict({allow, deny})`** | 该作用域对**继承来的**全局工具做实时过滤；不影响本作用域自己的注册 | 官方支持、**实时**（下一 step 生效），多个限制取交集 |

> 记忆锚点：**可见性 ≠ 注册**。想"有条件地看见"，要么换作用域注册/不注册，要么 `restrict`。没有第三条路。

### 24.2 本插件里的三条注册路径（别混）

| 工具种类 | 谁负责注册 | 注册到哪 | 可见性靠什么 |
|---|---|---|---|
| **内置工具**（`toolDefs` 那四十来个） | `apply()` 逐条 `ctx.tools.register` | 传入 apply 的 ctx（= 某个 agent 的 ctx） | `restrict` 剪枝（§4.6.4 四件套） |
| **普通扩展工具**（`tools/*.mjs`，不带 `expose`） | `apply()` 逐条注册，**先过 `enabled` 判定** | 同上 | `enabled` + 注册作用域 |
| **`expose:'all'` 扩展工具** | **不进 apply 的注册循环**；先入 `extToolIndex`，再由 `applyExtToolVisibility()` 按 agent 注册 | `toolsOfScope(agentCtx).register` | 索引 + `extUserOff` + grant（§17） |

三个关键事实：

1. **`extToolIndex` 只收 `expose:'all'`**（`defs.filter(d => d.expose === 'all')` 之后才 `set`）。
   普通扩展工具**永远不在索引里**，别去那里找。
2. **普通扩展工具的可见性**完全由 `apply()` 里那段 `enabled(env)` 决定；判 false 就 `continue`，连注册都不会发生。
3. **`expose:'all'` 那条路完全不看 `enabled`** —— `applyExtToolVisibility()` 是拿 `buildExtTool()` 直接包装注册。
   ⇒ 给一个 `expose:'all'` 的工具写 `enabled` 是**无效代码**（极容易误以为生效）。

### 24.3 `enabled(env)` 是自创的，所以天生只能做**粗粒度**判断

`apply()` 给钩子的 env：

```js
{ ctx, agent, provider, manager, dataRoot, logger }
```

- `agent` ← `opts.agent`（**调用方显式传**），兜底按 `rec.agentCtx === ctx` / `rec.agent.ctx === ctx` 反查 sessions
- `provider` ← `agent.session.requestContext()`，兜底 `manager.modelResolver.getEffectiveRoute(…)`

**结构性问题**（2026-11-14 实测踩到）：

> `mountChannelTools()` 在 session-manager 里有 **7 处调用点**，只有 3 处传 `agent`；
> 其余走"按 ctx 反查 sessions"的兜底，而兜底在热刷 / 多路径注册场景会 miss。
> ⇒ `agent` = `undefined`、`provider` = `''`
> ⇒ 扩展侧 `providerIsDeepseek(undefined, undefined, '')` = **false**
> ⇒ 宿主 Key 在也没用，判"未启用" ⇒ **5 个工具全被条件隐藏**
> （日志形态：`条件隐藏(未启用): dskit_xxx`）

**结论（写代码按这个来）**：

| 判据类型 | 能不能放进 `enabled` |
|---|---|
| 面板配置（有没有填 Key、开关开没开） | ✅ 可以，且推荐 |
| 「当前会话是不是 DeepSeek 官方」 | ❌ **不要** —— 注册时机与"当前会话"不是同一个概念 |
| 「某个群 / 某个人能不能用」 | ❌ 不要 —— 那是会话级，属于 `restrict` 或 `run()` 里自查 |

> 一句话：**`enabled` 只回答"这个能力全局上有没有被配置"，不回答"这个会话该不该有它"。**
> 会话级的一律在 `run()` 入口自查（拿不到就返回友好提示），或在 per-agent 注册处用 `restrict`。

### 24.4 第二个坑：`buildExtTool()` 塞给 `run()` 的 env **是残的**

`buildExtTool()` 组装的执行 env 只有：

```js
{ cwd, exec, ctx, logger, qq, manager?, sender?, replyTarget? }
```

**没有 `dataRoot` / `provider` / `agent`** —— 而 `enabled` 的 env 里明明都有。
⇒ 同一个扩展，`enabled` 里拿得到的信息，`run()` 里拿不到（工具运行起来再判一次 Key 就会判 false）。

写扩展时**必须**按最保守口径取值：

```js
const dataRoot = env.dataRoot || env.manager?.dataRoot || env.cwd;   // 三级兜底
```

> 待改（还没做）：`buildExtTool()` 里补 `dataRoot: ent.inst.dataRoot`，
> 并把 `agent: exec?.agent`、`provider`（从 `exec.agent.session.requestContext()` 现算）塞进 env，
> 让 `enabled` 与 `run` 看到同一份信息。**动之前先过 §24.7 的验证矩阵。**

### 24.5 排查"扩展工具没出现"的顺序（本节版，替代 §4.6.6 第 4 步之后）

日志：`{dataRoot}/.qqbot-extensions/data/`、`~/.dsh/qqbot-ext-diag.log`、`qqbot-extglob.log`。

1. **扫到了吗** —— `apply extRoot=… defs=N`（`N` 里应该有你的工具）
2. **进索引了吗** —— 只有 `expose:'all'` 才有 `extToolIndex` / `清单已落盘`；普通工具看第 3 步
3. **判隐藏了吗** —— 搜 `条件隐藏(未启用): <工具名>`。有这行 = `enabled` 返回 false，**先去看它依赖了什么**
4. **注册成功了吗** —— `热替换: 先注销旧 X` → `注册成功: X`
5. **注册错层了吗** —— 见 §17 一、只有 `agent.ctx` 算数
6. **被剪枝了吗** —— `restrict` 的 deny 名单里有没有它
7. **被签名缓存吃掉了** —— 含 `enabled` 的工具已跳过签名短路；**改 `lib/*.mjs` 必须改名**（ESM 按 URL 缓存）

### 24.6 自检清单（改注册 / 可见性代码前过一遍）

1. 我改的是**注册**逻辑还是**判据**逻辑？判据里有没有依赖"当前会话"的东西？
2. `enabled` 里所有输入都做了 `?.` 兜底吗？输入为空时**默认可见还是默认隐藏**？（默认隐藏更安全，但要想清楚用户会不会以为"坏了"）
3. 同一个能力，`enabled` 和 `run()` 的判据**是不是同一份**？不是的话必然有一边撒谎。
4. 我改的是 `expose:'all'` 还是普通工具？路径搞错 = 白改。
5. 改完**既看 src 又看 dist**（Windows 中文路径下 python 写盘可能"报成功但没写"）。
6. 临时探针文件 / 诊断日志清掉了吗？（§22）

### 24.7 验证矩阵（每次动这块都跑）

| 场景 | 期望 |
|---|---|
| 面板填了 Key | 工具**任何会话**都可见（own key 优先，不看 provider） |
| 面板没填 + 官方 provider 会话 | 可见（复用宿主 Key） |
| 面板没填 + 非官方 provider 会话 | **不可见**，日志有 `条件隐藏` |
| 非 QQ 会话（web / 终端） | 不该看到 QQ 专属扩展工具 |
| 关掉单个开关（如 `enableOcr=false`） | 该工具消失，其余不受影响 |
| 改配置后**不重启** | 下一 step 生效（`enabled` 已跳过签名短路） |

### 24.8 🟢 官方正解：`register(def, { when })` —— 步骤级条件（宿主 0.2.2+）

> 2026-11-14 补。这条推翻 24.3 里"`enabled` 只能做粗粒度"的无奈结论：
> **宿主本来就有细粒度的条件可见性，而且判据输入的正是我们缺的那一样。**
> 来源：`@deepseek-ai/dsh-tools` README 的 `### Conditional tools` +
> `lib/types/contracts.d.ts` 的 `ToolRegistrationOptions` / `ToolActivationContext`。

宿主真实 API（0.2.2-rc.3 实测存在）：

```ts
register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void

interface ToolRegistrationOptions {
  /** 省缺=启用；false=同时从「描述」与「派发」里排除；抛错=步骤准备失败(ToolActivationError) */
  readonly when?: (ctx: ToolActivationContext) => boolean | Promise<boolean>
}

interface ToolActivationContext {
  readonly agent: Agent
  readonly modelSelection: Readonly<ModelSelection>   // ← provider / model / effort，正是我们缺的
  readonly signal: AbortSignal
}
```

三条硬事实：

1. **每步求值一次**（每个 model step），`modelSelection` 是"**步骤准备时为这次请求捕获的那个**"，
   与 `AssembleContext.modelSelection` / executor 描述拿到的是同一份 ⇒ **天然对齐工具表快照**，
   不像 `enabled` 那样在注册时刻瞎猜。
2. **false 是真正移除**：从 executor 描述、PTC 绑定、执行集合三处一起消失。
   ⇒ 模型看不到、调不到，不是"看得见但报错"。
3. **必须配 `resolve()`**：带条件的工具，在**没有 resolved set 的调用**上直接 `UNKNOWN_TOOL`。
   宿主流程是 `const set = await ctx.tools.resolve({agent, modelSelection, signal})` →
   传给 `assemble(toolSet)` 与本步 `ctx.tools.execute(…, toolSet)` → **批次结束后 `set.dispose()`**；
   同一步的重试**复用它**。执行器把该 set 应用到批内每一次调用（含 PTC 程序子调用）。
   `get/definitions/schemas(name, scope, toolSet)` 查的也是这个集合。

**能力探测方式**（老宿主没有，必须分支）：

```js
const supportsWhen = typeof ctx.tools?.resolve === 'function';   // 0.2.2-alpha.2 起才有
```

> 版本对照（社区实测 + 本地核对）：`0.2.0-rc.2` / `0.2.1-rc.1` / `0.2.1-rc.5` **没有**；
> `0.2.2-alpha.2` 起有；本机宿主 `0.2.2-rc.3` 有。
> 我们的 `peerDependencies` 下限是 `dsh-tools >= 0.1.1-rc.2` ⇒ **不能删旧路径**，只能做能力分支。

#### 对我们意味着什么

| 现状（自创 enabled） | 改成 when 之后 |
|---|---|
| 判据在 `apply()` 注册时刻求值，拿不到"当前会话 provider" | 判据在**每步**求值，`modelSelection.provider` 直接给 |
| 要靠 `opts.agent` / 反查 sessions 猜是谁 | `ctx.agent` 直接是准备这一步的 agent，不用猜 |
| 判 false 靠"不注册"实现 | false = 官方移除（描述 + 派发 + PTC 一致） |
| per-agent 注册 + 索引 + `extUserOff` + grant 四套状态机 | 注册一次（根作用域）+ 条件，**大量脚手架可以删** |
| 签名缓存必须为 `enabled` 开特例（否则改配置不生效） | `when` 每步重算，天然不需要缓存特例 |

> 参考：社区插件 `dsh-cherry-bridge` 的 issue #343 就是拿这个方向做 spike ——
> 他们原来用 `agent.ctx.tools.restrict({deny})` 管工作区隔离，被迫维护「活着的 agent 集合」
> （3 个订阅 + 每-agent 层表 + 合并重算 + 未决 cwd 重检 + 全局 guard 兜底），2169 行里 550–600 行是脚手架；
> 换成 `when` 后这层生命周期整块都不需要了。**同一个教训，我们别重犯。**

#### 改造顺序（要做的话按这个走）

1. **先只改扩展工具这一条路**（别动内置工具，它们在用 `restrict` 且没坏）
2. `buildExtTool()` 产出 `when` 包装：内部把 `{agent, modelSelection, signal}` 规范化成扩展熟悉的
   `{ agent, provider: modelSelection.provider, model: modelSelection.model, signal }`，
   再调 `def.enabled(...)`（**扩展侧签名不用改**，向后兼容）
3. 注册处：有 `resolve` 能力 → `register(tool, { when })`；没有 → 老路（注册时判一次）
4. 同时修 §24.4 的 env 残缺（`run()` 也要能拿到 `dataRoot` / `provider`）
5. 回归 §24.7 全矩阵，外加一条：**同一步重试**不许丢工具（验证 resolved set 复用）

> ⚠️ 两个坑提前记下：
> ① `when` 抛错 = **步骤准备失败**（`TOOL_ACTIVATION_FAILED`），不是"不可用" ——
>   扩展的判据里所有外部读取都要 try/catch 兜底，宁可返回 true。
> ② `when` **不许改注册、不许做工具活**，只能纯判断；异步必须 observe `signal`。
