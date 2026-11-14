/**
 * dsh-im-qqbot — QQ Bot IM channel plugin for deepseek-harness
 *
 * Cordis 插件入口。将 QQ 消息平台作为 dsh 的前端协议驱动。
 * 网关组装（中间件编排 + 事件 + 出站 + 生命周期）见 src/gateway/。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, EditableConfigSchema, type EditableConfig, type ImQQBotConfig } from './config.js';
import { bootstrapGateway } from './gateway/index.js';
import type { DshAgentRegistry } from './session/index.js';
import { getProfileDir, resolveEnv, resolveProfileName } from './shared/index.js';
import { warmSessions } from './features/warm-sessions.js';
import { applyExtToolVisibility } from './channel-tools.js';
import { describeNsConflict, nsPathsOf, scanNsOwners } from './features/ns-guard.js';
void getProfileDir;
import { runQrSetup, persistCredentialsToProfile } from './setup.js';
import { diagWrite } from './shared/diag.js';

// 2026-09-24 关闭"启动自动扫码"后，这些符号保留给设置页路径使用；此处显式引用避免 TS 未使用报错。
void runQrSetup; void persistCredentialsToProfile;
import type { Logger } from './types.js';
import { setOutboundModeWriter } from './features/outbound-mode-switch.js';
import { setLexicalFallback } from './features/local-embed.js';

// ⚠️ @deepseek-ai/dsh-settings 的"注册 Web 可视化设置"入口在 harness 各版本间有差异：
//   - rc.2 及更早：模块顶层具名导出 installSettingsSection(ctx, ns, schema, entry, hooks)
//   - alpha / 0.1.2 线：改为 ctx.settings 服务，方法 installSection(ctx, ns, schema, entry, hooks)
// 直接 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'` 是"静态具名导入"，
// 一旦运行库没有该具名导出，模块一加载就抛 SyntaxError，会拖垮整棵插件树（dsh 都起不来）。
// 因此这里不静态导入，而在运行时动态探测两条路径，缺一条也能优雅降级（见 installLiveSettings）。

// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
// ⚠️ 2026-09-13(主人验到注入没生效才发现): 用 ctx.systemPrompt.context() 注册运行时上下文贡献**必须**在此声明依赖,
//    否则 ctx.systemPrompt 拿不到 → 注册会走“宿主未提供”兜底, 小传注入等于没接上。
export const inject = ['agents', 'systemPrompt'];
export const Config = ConfigSchema;

export type { ImQQBotConfig } from './config.js';

// ── 插件主体 ──
export async function apply(ctx: Context, config: ImQQBotConfig): Promise<void> {
  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const logger: Logger = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;

  // ── 扩展 UI 自动铺设（2026-10-27 主人要求）─────────────────────────────
  //   为什么要在启动时做：
  //     · slot=settings 的卡片必须落在 {PROFILE_ROOT}/.qqbot-extensions/ui/
  //     · slot=dock 的卡片必须落在 {dataRoot}/.qqbot-extensions/ui/
  //   但作者/示例不该手动往这两处复制。这里把两件事自动做掉：
  //     ① 插件自带的 examples/ext-ui/<name>/{settings,dock}  → 铺到两个源
  //     ② 已装扩展包 extension-packs/<pack>/ui/ 里 slot=settings → 铺到 profile
  //   **只补不改**：目标已存在就跳过，绝不动用户改过的内容。
  //   任何异常都吞掉 —— 铺 UI 失败不该影响插件启动。
  try {
    const { installExtUi } = await import('./features/ext-ui-seed.js');
    const { dataRootOf } = await import('./gateway/data-root.js');
    const { fileURLToPath } = await import('node:url');
    const dr = dataRootOf(config);
    // ★ 2026-10-27 修：不能只读环境变量 —— 这段代码在 apply **最开头**跑，
    //   而 DSH_PROFILE_DIR 是后面 profileContext 那段才回写的，此刻还是空。
    //   所以直接从宿主服务取，取不到再退环境变量。
    let pr = String(process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE_ROOT || '').trim();
    if (!pr) {
      try {
        const pc = (ctx as unknown as { get?: (n: string) => unknown }).get?.('profileContext') as
          | { name?: string; dir?: string; root?: string; path?: string }
          | undefined;
        pr = String(pc?.dir || pc?.root || pc?.path || '').trim();
      } catch { /* 老宿没有这个服务 */ }
    }
    let examplesDir = '';
    try {
      examplesDir = fileURLToPath(new URL('../examples/ext-ui', import.meta.url));
    } catch { examplesDir = ''; }
    // 收集其他实例的数据根 —— 只取前几个（主人要求：铺前 2 个实例即可，
    // 用户可能建几十个实例，全铺太铺张）。来源是设置页自己落盘的
    // ~/.dsh/qqbot-settings/<ns>.json（里面有各实例的 cwd）。
    const extras: string[] = [];
    try {
      const { readdirSync, readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      // ★ 2026-10-27 修（主人指出）：设置按 **profile 分层**！
      //   真源是 ~/.dsh/qqbot-settings/<profileName>/<ns>.json，
      //   根目录下那几个 *.json 是旧版遗留，读了会拿到过期的 cwd/appId。
      //   （实测：根目录 im-qqbot-3.json 的 cwd=温柔鲸鱼娘、appId=1905554998，
      //     而 web/ 下那份才是 cwd=测试客户端、appId=1905708994 —— 面板显示后者。）
      const { basename: baseNameOf } = await import('node:path');
      const profileName = pr ? baseNameOf(pr) : '';
      // ★ 多 profile 隔离（维护手册有写）：每个 profile 的插件只读**自己那份**配置，
      //   web 读 qqbot-settings/web/、desktop 读 qqbot-settings/desktop/，
      //   第三方桌面版读它自己的 profile 名。
      //   拿不到 profile 名时**不读任何额外实例** —— 宁可少铺，也不要跨 profile 乱读
      //   （根目录下那几个 *.json 是旧版遗留，内容可能是过期的）。
      const settingsDir = profileName ? join(homedir(), '.dsh', 'qqbot-settings', profileName) : '';
      if (settingsDir && existsSync(settingsDir)) {
        const files = readdirSync(settingsDir).filter((f) => f.endsWith('.json')).slice(0, 6);
        for (const f of files) {
          try {
            const j = JSON.parse(readFileSync(join(settingsDir, f), 'utf8')) as { cwd?: string; dataRoot?: string };
            if (j?.dataRoot) extras.push(String(j.dataRoot));
            else if (j?.cwd) extras.push(join(String(j.cwd), 'dshqqbot'));
          } catch { /* 单个文件坏了不影响其他 */ }
        }
      }
    } catch { /* 读不到就只铺当前实例 */ }
    const seeded = installExtUi({ dataRoot: dr, profileRoot: pr, examplesDir, extraDataRoots: extras, maxDataRoots: 2 });
    if (seeded.installed.length > 0) {
      logger.info?.('[ext-ui] 已自动铺设 ' + seeded.installed.length + ' 张卡片：' + seeded.installed.join(', '));
    }
    if (seeded.errors.length > 0) {
      logger.warn?.('[ext-ui] 铺设时出错：' + seeded.errors.join('; '));
    }
  } catch (e) {
    logger.warn?.('[ext-ui] 自动铺设跳过：' + (e instanceof Error ? e.message : String(e)));
  }

  // ── 2026-10-22（issue #14 建议 1）：**用宿主给的 profileContext，别靠路径推断** ──
  //   宿主通过服务把"我是哪个 profile"告诉我们；拿得到就用它，拿不到（老版本宿主没有该服务）
  //   才回落 resolveProfileName() 的路径推断（DSH_PROFILE → 代码位置 → 扫描）。
  try {
    const pc = (ctx as unknown as { get?: (n: string) => unknown }).get?.('profileContext') as
      | { name?: string; dir?: string; root?: string; path?: string }
      | undefined;
    if (pc) {
      const g = globalThis as unknown as { __dshProfileContext?: typeof pc };
      g.__dshProfileContext = pc;
      if (pc.name) (globalThis as unknown as { __dshProfileName?: string }).__dshProfileName = pc.name;
      const dir = pc.dir || pc.root || pc.path;
      // ★ 把宿主给的值回写成环境变量 —— resolveProfileRoot()/resolveProfileName() 的**第一优先级**
      //   就是这两个环境变量，所以不用改 settings-host.js 任何一行逻辑（issue #14/#15）。
      //   已确认此前的保存故障与它无关（真因是前端脚本误写 SAVEOVERRIDE 标记）。
      try {
        if (pc.name) process.env.DSH_PROFILE = String(pc.name);
        if (dir) process.env.DSH_PROFILE_DIR = String(dir);
      } catch { /* 环境变量只读时忽略 */ }

      if (dir) (globalThis as unknown as { __dshProfileDir?: string }).__dshProfileDir = dir;
      logger.debug?.('[profile] 来自宿主 profileContext: name=' + (pc.name || '?') + ' dir=' + (dir || '?'));
    }
  } catch { /* 老宿主没有该服务：静默回落 */ }

  // __INSTALL_SELFCHECK__ 安装完整性自检（2026-09-28）
  //   entry.js（包入口）已拦住"缺 dist"；这里补查"import 成功但功能不全"
  //   （缺前端 / 缺配置桥 / 缺 patch —— 常见于"从 GitHub 直装但没跑构建"）。
  try {
    // 2026-10-22 修(GitHub issue #15)：URL.pathname 不解码，路径含空格时变成 %20，
    //   existsSync 必然 false ⇒ 误报"安装不完整"。改走 fileURLToPath。
    const here = fileURLToPath(new URL('.', import.meta.url));   // → .../dist/
    const pkgRoot = here.replace(/[\\/]dist[\\/]?$/, '');
    const expect = ['client/qqbot-settings.js', 'settings-host.js', 'cordis.patch.yml'];
    const miss = expect.filter((r) => !existsSync(pkgRoot + '/' + r));
    if (miss.length > 0) {
      logger.warn('');
      logger.warn('  ⚠️  dsh-qqbot 安装不完整：缺少 ' + miss.join(', '));
      logger.warn('      插件主功能可用，但设置面板 / 配置桥可能不工作。');
      logger.warn('      建议改用 npm 发布版安装（自带全部文件，无需构建）：');
      logger.warn('        pnpm add @zaofan/dsh-qqbot');
      logger.warn('      （安装目录: ' + pkgRoot + '）');
      logger.warn('');
    }
  } catch { /* 自检失败不影响启动 */ }



  // 多账号实例身份: settingsNs 承担"实例 id"(账号页保存时写入, 默认 im-qqbot=主账号)。
  const ns = (config.settingsNs ?? '').trim() || 'im-qqbot';
  const isMain = ns === 'im-qqbot';
  void isMain;

  // ── 账号实例化: appId/appSecret/cwd/preset 都做 env 兜底(2026-09-08, 响应上游 issue #43) ──
  // 背景: cordis.patch.yml 的 im-qqbot config 里 cwd/preset 可能未被 dsh 框架完整传入 apply()
  // (上游 tencent-connect/dsh-qqbot issue #43), appId/appSecret 靠 QQBOT_APPID/SECRET 兜底才"看似正常"。
  // 这里给 cwd/preset 同样提供 env 兜底: 优先 patch 传入值 → 环境变量 → 留空(走进程 cwd/全局默认)。
  // ⚠️ 不做硬编码默认(上游用户在 dist 里写死 /mnt/... 不可移植), env 兜底通用且可覆盖。
  let appId = resolveEnv(config.appId, 'QQBOT_APPID');
  let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');
  // ★★ 2026-10-27 重要修复（主人实测：3 号机加载了 2 号机的 25 个命令）：
  //   cordis.patch.yml 里**不写** cwd（2026-09-24 起 cwd 只落自有存储），于是这里
  //   config.cwd 是空的 → 落到 QQBOT_CWD 环境变量 → 那是**进程级**的、指向主实例
  //   ⇒ 所有非主实例的 dataRoot 都会指到主实例目录，扩展（tools/commands/hooks/
  //   inbound/outbound/botplay）全部串号，多实例隔离从来没生效过。
  //   修：cwd 缺失时先按 settingsNs 去**自有存储**读（那才是用户保存的最新值），
  //   再退环境变量，最后才留空。
  let cwdOverride = resolveEnv(config.cwd ?? '', 'QQBOT_CWD') || undefined;
  // ★★ 2026-10-27：这里**不能**加 `if (!config.cwd)` 守卫！
  //   宿主会给所有实例注入同一个 cwd（当前工作区，如 鲸鱼娘），
  //   于是 config.cwd 永远非空 ⇒ 补正被整体跳过 ⇒ 3 号机仍用 2 号机的目录。
  //   自有存储才是用户保存的最新值，**无条件以它为准**。
  if (true) {
    try {
      const { readFileSync: rf, existsSync: ex } = await import('node:fs');
      const { join: jn } = await import('node:path');
      const { homedir: hd } = await import('node:os');
      // profile 名：环境变量（早于此段已回写）→ 宿主服务 → 留空
      let profName = String(process.env.DSH_PROFILE_NAME || '').trim();
      if (!profName) {
        try {
          const pc0 = (ctx as unknown as { get?: (n: string) => unknown }).get?.('profileContext') as
            | { name?: string; dir?: string; root?: string } | undefined;
          profName = String(pc0?.name || '').trim();
          if (!profName && (pc0?.dir || pc0?.root)) {
            const d = String(pc0.dir || pc0.root);
            profName = d.replace(/[\/]+$/, '').split(/[\/]/).pop() || '';
          }
        } catch { /* 老宿主 */ }
      }
      const ns = String((config as { settingsNs?: string }).settingsNs || 'im-qqbot').trim();
      if (profName && ns) {
        const f = jn(hd(), '.dsh', 'qqbot-settings', profName, ns + '.json');
        if (ex(f)) {
          const j = JSON.parse(rf(f, 'utf8')) as { cwd?: string; dataRoot?: string };
          // dataRoot 优先（显式配过就用它，插件侧另有 dataRootOf 会读 config.dataRoot）
          // ★★ 必须写回 config，不能只改局部变量 cwdOverride！
          //   dataRootOf(config)、loadExtensionCommands(dataRootOf(config))、
          //   seedExampleTools(dataRootOf(config)) 全都读 config ——
          //   只改局部变量的话这些地方照样落到 process.cwd()（宿主在用户主目录启动），
          //   实测表现就是「ctx.dataRoot 对了，命令却还是加载了主实例那 25 个」。
          if (j?.dataRoot) (config as { dataRoot?: string }).dataRoot = String(j.dataRoot);
          if (j?.cwd) {
            cwdOverride = String(j.cwd);
            (config as { cwd?: string }).cwd = cwdOverride;
          }
        }
      }
    } catch { /* 读不到就按原逻辑 */ }
  }
  const presetOverride = resolveEnv(config.preset ?? '', 'QQBOT_PRESET') || undefined;

  // ── 凭据检查（⚠️ 2026-09-28 重要改动：不再"缺凭据就整个 return"）──
  //   原来缺凭据直接 return，会连带跳过【设置面板 host 桥】的装载，后果是新用户装完插件打开 dsh：
  //     · /api/qqbot-settings/* 全部 404
  //     · 前端 entry 激活失败 → 页面报 "1 entry did not activate"
  //     · 根本走不到「扫码绑定」—— 连填凭据的界面都打不开。
  //   现在改为：**设置面板照常装载**（settings + host 桥），只把【网关启动】留到凭据检查之后。
  //   新用户路径：装插件 → 打开 dsh → 设置页「QQ 机器人」→ 填 AppID/Secret 或点「扫码绑定」
  //   → 凭据写入 → 热更新 → 本次 apply 有凭据 → 自动连上。
  //   仍然**不自动弹二维码**（保持 2026-09-24 的死循环修复：扫码只在用户主动点击时发生）。
  const hasCred = !!appId && !!appSecret;
  if (!hasCred) {
    // ⚠️ 2026-09-24 主人要求：**启动时不再自动弹二维码**。
    //    原因：自动扫码会 persistCredentialsToProfile() 写 profile patch → 触发 dsh 热更新
    //    → 插件重新 apply → 凭据仍缺失 → 再扫码，形成死循环（实测把宿主启动刷死）。
    //    现在一律只提示；需要扫码时去 Web「账号与预设」点「扫码绑定」（那条路径是交互式的，不会自转）。
    logger.warn(`实例 ${ns}: 尚未配置 appId/appSecret —— 机器人暂不连接 QQ，但设置面板已就绪。`);
    logger.warn('  · 请在 dsh 设置页「QQ 机器人」里填写 AppID/AppSecret，或点「扫码绑定」；');
    logger.warn('  · 凭据保存后会热生效，本实例自动连接（无需重启）。');
  }

  const resolvedConfig: ImQQBotConfig = {
    ...config,
    appId,
    appSecret,
    // cwd/preset: patch 值优先, env 兜底(QQBOT_CWD / QQBOT_PRESET), 都没有则留原值(进程 cwd/全局默认)
    ...(cwdOverride ? { cwd: cwdOverride } : {}),
    ...(presetOverride ? { preset: presetOverride } : {}),
  };

  // ── 插件自有设置存储（2026-09-24）──
  // 设置页保存**不再写 profile 的 cordis.patch.yml**：写 patch 会被宿主当热更新提交 →
  // 插件重新 apply → 凭据无效时再写 → 自反馈闭环（实测把 dsh 启动刷死、无限弹二维码）。
  // 现在写到 {DSH_HOME}/qqbot-settings/<ns>.json；插件在此读取并覆盖 patch 值，
  // 并监听桥发出的变更事件实现**热生效**（不写宿主配置 → 不触发任何热更新）。
  // 2026-10-11 起**按 profile 隔离**（路径规则见 features/ns-guard.ts 的 nsPathsOf）：
  //   新布局 {DSH_HOME}/qqbot-settings/<profile>/<ns>.json —— web 与 desktop 各一份，同一个 ns 也不再互相覆盖；
  //   读：新路径优先 → 老路径兜底（老数据不丢）；写：settings-host.js 一侧一律写新路径（首次保存即"自动搬家"）。
  // 2026-10-12 修：profile 名**不能只读 `process.env.DSH_PROFILE`** —— 宿主不会把 profile 名放进自己的
  //   环境（DSH 走 `ctx.get('profileContext').name`，DSH_PROFILE 只在每次 shell/工具调用时临时注入），
  //   于是这里永远拿到空 → 永远落 `_default/`，"web 与 desktop 各写各的"形同虚设。
  //   改用 `resolveProfileName()`（环境变量 → 代码位置 → 宿主扫描兜底，细节见 src/shared/utils.ts）。
  const nsPaths = nsPathsOf(process.env.DSH_HOME || join(homedir(), '.dsh'), String(ns), resolveProfileName());
  const ownSettingsFile = nsPaths.file;
  const readOwnSettings = (): Record<string, unknown> => {
    try {
      const f = existsSync(ownSettingsFile)
        ? ownSettingsFile
        : (existsSync(nsPaths.legacyFile) ? nsPaths.legacyFile : ''); // 老布局兜底
      if (!f) return {};
      const o = JSON.parse(readFileSync(f, 'utf8'));
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  };
  /**
   * 深合并（一层递归）—— ⚠️ 不能再用浅合并 Object.assign！
   * 事故(2026-09-24)：自有存储里若出现空对象(如 sticker: {})，浅合并会把 patch 里的整个
   * sticker 配置覆盖成空 → config.sticker.collectEnabled 变 undefined → **图片自动下载停摆**
   * （症状：最后一张自动下载的图停在某时刻，之后入站图片只剩 QQ 长 URL）。
   * 深合并只在真有子键时才覆盖，空对象顶不掉默认值。
   */
  const mergeDeep = (base: unknown, over: unknown): unknown => {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
    const b = (base && typeof base === 'object' && !Array.isArray(base)) ? (base as Record<string, unknown>) : {};
    const out: Record<string, unknown> = Object.assign({}, b);
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      if (v === undefined) continue;
      const cur = out[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
        out[k] = mergeDeep(cur, v) as Record<string, unknown>;
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  const ownSettings = readOwnSettings();
  if (Object.keys(ownSettings).length) {
    Object.assign(resolvedConfig as unknown as Record<string, unknown>, mergeDeep(resolvedConfig, ownSettings) as Record<string, unknown>);
    logger.info(`已加载插件自有设置(${Object.keys(ownSettings).length} 项): ${ownSettingsFile}`);
  }

  // ── 2026-10-25：把「这次实例到底用了哪套凭据」落盘 ────────────────────────
  //   起因：白天反复出现"设置页保存成功后机器人仍连不上 / 密码像是被换回 cordis.patch.yml 旧值"，
  //   而现有日志只有"连不上"，看不出是①读错了 profile 的设置文件、②宿主没重启还拿着旧值、
  //   还是③同一个 appId 被另一个 profile/实例顶掉。
  //   这里只写 appId 与 secret 的**末 4 位**（绝不写明文），配合文件名就能一眼对上是哪份配置。
  //   输出受 diagLog 开关控制（默认关，零开销），文件：{DSH_HOME}/qqbot-boot-diag.log
  try {
    let profName = '';
    try { profName = resolveProfileName(); } catch { profName = ''; }
    diagWrite(
      'qqbot-boot-diag',
      `ns=${String(ns)} appId=${String(appId)} secretTail=${String(appSecret).slice(-4)} len=${String(appSecret).length}`
      + ` ownKeys=${Object.keys(ownSettings).length} file=${ownSettingsFile} hasCred=${hasCred} profile=${profName || '(空)'}`,
    );
    // ★ issue #21：secret 被掩码污染时要显式告警，而不是等反复鉴权失败（100016）才有人查。
    //   真实 QQ 机器人 secret 是 32 位字母数字；写成 8 个星号说明被 /read 的掩码写回过了。
    try {
      const sc = String(appSecret || "");
      if (sc && /^[*•●＊]+$/.test(sc)) {
        logger.warn(`[qqbot] ⚠ appSecret 疑似被掩码污染 (ns=${ns}, 值="${sc}")，鉴权必然 100016。请到账号设置页重新填写真实 secret。`);
        diagWrite("qqbot-boot-diag", `ALERT ns=${String(ns)} appSecret 是掩码串（${sc.length} 个字符），需要重新填写`);
      } else if (sc && sc.length !== 32) {
        diagWrite("qqbot-boot-diag", `WARN ns=${String(ns)} appSecret 长度 ${sc.length}（正常 32 位），留意是否为异常值`);
      }
    } catch { /* 告警失败不影响启动 */ }
  } catch { /* 诊断失败绝不影响启动 */ }

  // ── 2026-10-11 新增：settingsNs 冲突自检（判据与修法见 features/ns-guard.ts 顶部注释）──
  // ns 是"全局唯一"的设置槽名，而设置文件路径 {DSH_HOME}/qqbot-settings/<ns>.json 里**没有 profile 维度**：
  // 两个 profile 各挂一个实例却填了同一个 ns 时，两边共用一份文件 → 谁最后保存谁生效，凭据/preset/cwd
  // 一起被换掉（实测：web 的配置被 desktop 覆盖、QQ 连接被顶掉后收不到消息）。
  // 这里只做**只读探测 + 告警**：不改任何 profile 文件、也不阻断启动。
  try {
    const nsHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const myProfile = resolveProfileName();
    const owners = scanNsOwners(nsHome, ns);
    const others = owners.filter((p) => p !== myProfile);
    if (others.length) {
      // 拿得到 profile 名 = 隔离生效（v1.8.4 起设置文件按 profile 隔离）→ 只是提示；拿不到才是真风险 → warn
      const msg = describeNsConflict({ ns, owners, myProfile, settingsFile: ownSettingsFile, isolated: !!myProfile });
      if (myProfile) logger.info(msg); else logger.warn(msg);
    } else if (owners.length) {
      logger.info(`settingsNs 自检通过：设置槽 "${ns}" 只被 profile "${owners[0]}" 挂载`);
    }
  } catch (e) {
    logger.warn(`settingsNs 自检跳过（不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
  }
  // ⚠️ 2026-09-28 修：监听里除了热更新配置，还要处理"从无凭据 → 有凭据"的自动启动网关。
  //   背景：bootstrapGateway 只在 apply() 里跑一次。用户首次安装时没有凭据，
  //   插件只是"装好设置面板"就结束了（见下方 hasCred 分支）→ 此后在设置页填好凭据，
  //   配置对象虽然更新了，但**网关从未启动** → 表现就是"填了密码却不会自动重连"（必须重启）。
  //   现在：一旦检测到凭据从无到有，就自动启动一次网关。
  let gatewayStarted = false;
  /** 拆卸当前网关（由 bootstrapGateway 经 hooks 交回；**幂等**，与 cordis 生命周期共用同一个函数） */
  let gatewayDispose: (() => Promise<void>) | undefined;
  /**
   * **与连接相关的字段** —— 其中任何一个变了都必须「先拆后建」，光热更新配置是不会重连的。
   *
   * 判据来自 `src/config.ts` 顶部注释：appId/appSecret 故意**不标 volatile**，期望靠宿主
   * "配置变了 → 重新挂载插件 → 重建 bot"来重连。但本插件为了躲开 2026-09-24 那个
   * "写 patch → 宿主热更新 → 再写"的自反馈死循环，改成了**只写自有存储、不碰宿主配置**
   * ⇒ remount 永不触发。于是只剩下面这条自补的「保存即重连」路径。
   */
  const CONN_KEYS = ['appId', 'appSecret', 'preset', 'cwd', 'disabled', 'settingsNs', 'dataRoot'] as const;
  const connSnapshot = (): string => {
    const cur = resolvedConfig as unknown as Record<string, unknown>;
    return CONN_KEYS.map((k) => `${k}=${String(cur[k] ?? '')}`).join('\u0001');
  };
  const tryStartGateway = async (): Promise<void> => {
    if (gatewayStarted) return;
    const cur = resolvedConfig as unknown as Record<string, unknown>;
    const id = String(cur.appId ?? '');
    const sec = String(cur.appSecret ?? '');
    if (!id || !sec) return;
    gatewayStarted = true;
    try {
      logger.info(`实例 ${ns}: 检测到凭据已就绪，开始启动网关…`);
      await bootstrapGateway(ctx, agents, resolvedConfig, logger, {
        // 拿到"拆卸本次网关"的函数 —— 保存了连接相关设置后要靠它先拆后建（否则永不重连）
        onDisposer: (d) => { gatewayDispose = d; },
      });
      logger.info(`实例 ${ns}: 网关已启动（凭据热更新生效，无需重启）`);
      // ★★ 2026-11-06（主人："任何开启会话的消息也该直接注册"）：**把宿主钩子提前到启动时挂**。
      //   原来 `ensureGroupRules()` 只在**第一条 QQ 消息入站**时才挂钩子（inbound.ts:380），
      //   而 `agent/created` 是**一次性事件** —— 等挂上时 agent 早就建完了，
      //   永远收不到 ⇒ agent/created 那条注册路径形同虚设（实测：重启后仍要发消息才有工具）。
      //   这里在网关起来后立刻挂一次（`ensureGroupRules` 幂等，参数本来就没用到）。
      try {
        const reg0 = await import('./features/session-registry.js');
        for (const m0 of reg0.managersOf()) {
          void (m0 as unknown as { ensureGroupRules?: (r: unknown) => Promise<void> })
            .ensureGroupRules?.(undefined)?.catch?.(() => {});
        }
      } catch { /* 挂载失败不影响启动 */ }
      // ★★ 2026-11-05（issue #39 问题 1）：**启动预热已知 QQ 会话**。
      //   1.11.13 起扩展工具按 agent 作用域注册，触发点是 agent/inbox/claimed 与
      //   agent/pre-step —— 都要求"有回合"。冷启动后空闲会话从来没注册过，
      //   于是工具清单里没有那些扩展工具，必须等一条入站消息跑完回合才恢复。
      //   这里在网关起来后**主动**把已知会话建出来并注册一遍（不开回合）。
      //   丢后台跑：预热慢一点无所谓，绝不能拖住启动。
      void (async () => {
        try {
          const cfg = resolvedConfig as unknown as { warmSessionsOnStart?: boolean; warmMaxSessions?: number };
          if (cfg.warmSessionsOnStart === false) return;
          // manager 按实例注册在 session-registry 里（`registerSessionManager(ns, m)`）。
          // 预热时**每个 target 单独解析**更稳：并发/多实例下 ns→manager 的映射可能还没建立，
          // 而 `findManagerByPeer` 会先查活跃表、再按群注册表/台账归属匹配、最后回退。
          const reg = await import('./features/session-registry.js');
          const dataRoot0 = String(
            (resolvedConfig as unknown as { dataRoot?: string }).dataRoot
            || join(String((resolvedConfig as unknown as { cwd?: string }).cwd || process.cwd()), 'dshqqbot'),
          );
          const tag0 = String((resolvedConfig as unknown as { preset?: string }).preset || '').trim();
          await warmSessions({
            dataRoot: dataRoot0,
            tag: tag0,
            maxSessions: Number(cfg.warmMaxSessions ?? 12),
            logger,
            getOrCreate: async (scope, peerId) => {
              // ★★ 2026-11-06（trace 实证：预热把 6 个会话建到了**别的实例**）：
              //   原来用 `findManagerByPeer(scope, peerId)` —— 它会遍历所有 manager、
              //   按活跃表/群注册表命中的**第一个**返回，多实例下极可能拿到另一个实例的 manager
              //   ⇒ 会话建到了错的数据根，本实例的 sessions 表里依然没有。
              //   必须按**本实例 ns** 精确取。
              const mm = reg.getManagerByNs(ns) as unknown as {
                getOrCreate?: (s: string, p: string, sender: string, rt: unknown) => Promise<{ agentCtx?: unknown } | undefined>;
              } | undefined;
              if (!mm || typeof mm.getOrCreate !== 'function') return undefined;
              return await mm.getOrCreate(scope, peerId, '', { scope, targetId: peerId });
            },
            register: (agentCtx, tag) => applyExtToolVisibility(agentCtx, tag),
          });
        } catch (err) {
          logger.debug?.(`实例 ${ns}: 会话预热失败(不影响启动): ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    } catch (err) {
      gatewayStarted = false;   // 失败则允许下次重试
      logger.warn?.(`实例 ${ns}: 凭据热更新后启动网关失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // 程序兜底(2026-09-30): 启动时按配置同步一次(否则不打开设置面板的进程永远不会启用兜底)
  setLexicalFallback(((resolvedConfig as unknown as { localModel?: { lexicalFallback?: boolean } }).localModel?.lexicalFallback) === true);
  try {
    (ctx as unknown as { on: (ev: string, fn: (ns?: string) => void) => void }).on('qqbot/settings-changed', (changedNs?: string) => {
      if (changedNs && changedNs !== ns) return;
      void (async () => {
        const before = connSnapshot();
        const next = readOwnSettings();
        Object.assign(resolvedConfig as unknown as Record<string, unknown>, mergeDeep(resolvedConfig, next) as Record<string, unknown>);
        logger.info(`设置已热更新(${ns}): ${Object.keys(next).length} 项`);
        setLexicalFallback(((resolvedConfig as unknown as { localModel?: { lexicalFallback?: boolean } }).localModel?.lexicalFallback) === true);   // 兜底开关热生效
        // ★ 2026-10-12：**连接相关字段变了就拆旧建新**。
        //   不加这步的话，下面的 tryStartGateway() 会被 `gatewayStarted` 守卫直接挡回
        //   ⇒ 表现成"改了 appSecret/preset 却永远不重连，非得重启宿主"（主人 2026-10-12 实测反馈：
        //   只有新建实例并保存那一次才会连上）。日志会明说走了哪条路，便于排查。
        if (gatewayStarted && connSnapshot() !== before) {
          logger.info(`实例 ${ns}: 连接相关设置已变化 → 重建网关（先拆后建）`);
          try { await gatewayDispose?.(); } catch (e) {
            logger.warn?.(`实例 ${ns}: 拆旧网关失败（仍继续尝试新建，避免卡死）: ${e instanceof Error ? e.message : String(e)}`);
          }
          gatewayDispose = undefined;
          gatewayStarted = false;   // 放行 tryStartGateway，让它重新 bootstrap
        }
        await tryStartGateway();   // ← 若刚从"无凭据"变成"有凭据"，自动把网关拉起来
      })();
    });
  } catch { /* 事件系统不可用 → 退化为重启生效 */ }

  // ── Web 可视化设置: 注册 im-qqbot settings 命名空间(可编辑子集, live 生效) ──
  // 用户层存 ~/.dsh/settings.yaml; 变更经 watch 原地覆盖 resolvedConfig 对应字段,
  // 下游消费点(middleware/inbound)每次读取 config → 热生效。settings 服务缺失则跳过(纯 yml 模式)。
  try {
    await installLiveSettings(ctx, resolvedConfig, logger, ns);
  } catch (err) {
    logger.warn?.(`im-qqbot: settings 注册跳过: ${err instanceof Error ? err.message : String(err)}`);
  }


  // ── 设置面板 host 桥(单包自含, 原 dsh-qqbot-settings 独立包合并而来) ──
  // ⚠️ 2026-09-10 关键修复: 原用 ctx.plugin({name, inject, apply}) 装载 —— 在 dsh 环境下
  //    桥的 apply 从未被调用(实测 ~/.dsh/qqbot-bridge-diag.log 不生成, 所有
  //    /api/qqbot-settings/* 全 404, 前端设置页报 "not found" is not valid JSON)。
  //    原因: cordis Service 必须声明式注入(同 2026-09-04 那次 ctx.settings 直读拿不到的坑),
  //    改为 dsh 官方姿势 ctx.inject(deps, cb) —— 官方样板 dsh-bash-local / dsh-agent-default-model
  //    均写作 ctx.inject(["settings"], (settingsCtx) => {...})。
  //    agentPresets 不再作为等待依赖(桥内对该服务已有判空降级), 避免宿主未提供时永久不 apply。
  try {
    const bridgeUrl = new URL('../settings-host.js', import.meta.url).href;
    const bridgeMod = (await import(bridgeUrl)) as {
      name?: string; inject?: string[]; apply?: (ctx: Context) => unknown;
    };
    if (bridgeMod && typeof bridgeMod.apply === 'function') {
      const declared = Array.isArray(bridgeMod.inject) ? bridgeMod.inject : [];
      const required = declared.filter((s) => s !== 'agentPresets');
      const deps = required.length > 0 ? required : ['settings', 'webServer'];
      // ⚠️⚠️ 2026-09-28 关键修复：**不要用 ctx.inject 等依赖**。
      //   原因：cordis 的 ctx.inject(deps, cb) 会把 cb 挂成一个【子 fiber】并让【当前插件】
      //   一起等待这些服务 —— 一旦宿主没有提供（或尚未注册）settings / webServer，
      //   插件自身就永久 pending，宿主判定 "1 required plugin did not activate"，
      //   连带【整个 Web UI 都不渲染】（只剩一句错误 + 一个 dock 球）。
      //   实测：全新 profile 装本插件必然复现；老环境因为服务早就绪所以看不出来。
      //   现在改为：服务已就绪就立即装桥；没就绪则监听服务注册事件，**绝不阻塞插件自身激活**。
      const mountBridge = (c: Context): void => {
        try {
          bridgeMod.apply!(c);
          logger.info(`[im-qqbot] settings host 桥已 apply(deps=${deps.join('+')})`);
        } catch (err) {
          logger.warn?.(`im-qqbot: settings host 桥 apply 异常: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      // ⚠️⚠️ 2026-09-28 最终方案（两次踩坑后的结论）：
      //   · 直接 mountBridge(ctx) 不行 —— 桥的 apply 内部要 `ctx.webServer`，
      //     而没经过 inject 的 ctx 访问它会抛 "cannot get property \"webServer\" without inject"。
      //   · 用 ctx.inject(deps, cb) 又不行 —— 它会让**插件自身 fiber 一起等依赖**，
      //     宿主在服务就绪前就判 "1 required plugin did not activate"，
      //     【整个 Web UI 都不渲染】（只剩一句错误 + 一个 dock 球）。
      //   → 解法：**apply 先正常返回（插件立即激活成功）**，
      //     再用 setTimeout 延后到宿主服务注册完成，此时才做 ctx.inject（不再影响已完成的激活）。
      const doInjectLater = (): void => {
        try {
          ctx.inject(deps, (serverCtx: Context) => mountBridge(serverCtx));
        } catch (err) {
        }
      };
      // 用较短的定时器即可：宿主通常同一轮就把服务注册完
      try { setTimeout(doInjectLater, 1500); } catch { doInjectLater(); }
      logger.info(`[im-qqbot] settings host 桥已排程(延后 inject, deps=${deps.join('+')})`);
    } else {
      logger.warn('[im-qqbot] settings-host.js 缺少 apply, 桥跳过');
    }
  } catch (err) {
    logger.warn?.(`im-qqbot: settings host 桥装载跳过: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 群友小传 → 注册为**运行时上下文贡献**(dsh systemPrompt.context, 与 @a9i5k4/dsh-auto-memory 同款姿势):
  //   user-role 快照挂在历史尾部, system prompt 本体保持字节级稳定 → 前缀缓存全程命中, 不被打穿。
  try {
    const sp = (ctx as unknown as { systemPrompt?: { context?: (c: { name: string; order: number; text: (a: unknown) => string }) => () => void } }).systemPrompt;
    if (sp && typeof sp.context === 'function') {
      // 2026-11-10: 小传改由 pre-step 按会话注入（sp.context 在现宿主上不生效且会串会话），这里移除。
      logger.info('[im-qqbot] 群友小传已注册为运行时上下文贡献');
    } else {
      logger.warn('[im-qqbot] 宿主未提供 systemPrompt.context —— 小传注入退化为不注入');
    }
  } catch (err) {
    logger.warn(`[im-qqbot] 小传上下文注册失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 没有凭据 → 保留设置面板即可，不启动网关（不连 QQ、不注册入站）
  //   此时已注册 settings-changed 监听：用户填好凭据保存后会自动启动网关（无需重启）。
  if (!hasCred) {
    logger.info(`实例 ${ns}: 暂无凭据 —— 设置面板已就绪，填好凭据保存后会自动连接（无需重启）。`);
    return;
  }

  await tryStartGateway();
}

/** 把 settings 用户层合并进 live 运行时配置(原地字段替换; schema 解析值含默认, 可整体覆盖) */
async function installLiveSettings(ctx: Context, live: ImQQBotConfig, logger: Logger, nsOverride?: string): Promise<void> {
  const ns = nsOverride || (live.settingsNs ?? '').trim() || 'im-qqbot';
  const entry: EditableConfig = {
    dataRoot: live.dataRoot,
    behavior: live.behavior,
    sticker: {
      gates: live.sticker.gates,
      autoTagEnabled: live.sticker.autoTagEnabled,
      visionCli: live.sticker.visionCli,
    },
    injectRules: live.injectRules,
    imageHint: live.imageHint,
    // ⚠️ 2026-09-13 补(主人实测: "面板把评分模式改成 block 了, 但记录里 gate 还是 log"):
    //   本地小模型这块**原来没进 live 同步** → 面板/设置页保存后要重启宿主才生效。
    //   功效: 价值评分模式(off/log/block)、门槛、单会话 overrides 现在改完即时生效。
    localModel: live.localModel,
    groupPrompt: live.groupPrompt,
    schedule: live.schedule,
    groupAdmin: live.groupAdmin,
    enableApprovals: live.enableApprovals,
    approvalTimeoutMs: live.approvalTimeoutMs,
    outboundMode: live.outboundMode,
    botplayEvents: Array.isArray(live.botplayEvents) ? live.botplayEvents : [],
  };
  let source: () => EditableConfig = () => entry;
  const sync = (): void => {
    try {
      const next = source();
      if (!next) return;
      if (next.behavior) live.behavior = next.behavior;
      if (next.sticker) live.sticker = { ...live.sticker, ...next.sticker };
      if (typeof next.dataRoot === 'string') live.dataRoot = next.dataRoot; // 数据根(重启后 bootstrap 迁移/落盘用它)
      if (Array.isArray(next.injectRules)) live.injectRules = next.injectRules;
      if (typeof next.imageHint === 'boolean') live.imageHint = next.imageHint;
      // ★★ 2026-11-14 修（审查发现）：`EditableConfigSchema` 里这几个字段**面板能改但 sync 没同步** ——
      //   保存后旧值一直生效，只有重启才变。逐项补齐（与 schema 对齐）。
      if (typeof next.imageOffload === 'boolean') live.imageOffload = next.imageOffload;
      if (next.imageAggregate && typeof next.imageAggregate === 'object') live.imageAggregate = next.imageAggregate;
      if (typeof next.messageReference === 'boolean') live.messageReference = next.messageReference;
      if (typeof next.extMetaTool === 'boolean') live.extMetaTool = next.extMetaTool;
      if (typeof next.webTurnSilent === 'boolean') live.webTurnSilent = next.webTurnSilent;
      // 本地小模型: 整块替换(面板发的是完整对象; overrides 也在里面) —— 改了就地生效, 不用重启
      if (next.localModel && typeof next.localModel === 'object') live.localModel = next.localModel;
      setLexicalFallback(((live as { localModel?: { lexicalFallback?: boolean } }).localModel?.lexicalFallback) === true);   // 兜底开关热生效(settings 服务路径)
      if (typeof next.groupPrompt === 'string') live.groupPrompt = next.groupPrompt;
      if (next.schedule) live.schedule = next.schedule;
      if (next.groupAdmin) live.groupAdmin = next.groupAdmin;
      if (typeof next.enableApprovals === 'boolean') live.enableApprovals = next.enableApprovals;
      if (typeof next.approvalTimeoutMs === 'number') live.approvalTimeoutMs = next.approvalTimeoutMs;
      // 出站模式: adaptive=适配主动(默认; active 旧值归一 adaptive); detail=详细主动(adaptive + 工具调用/结果推送); passive=全被动; silent=不出站; nothink=不思考(仅设置页)
      if (next.outboundMode === 'adaptive' || next.outboundMode === 'detail' || next.outboundMode === 'passive' || next.outboundMode === 'silent' || next.outboundMode === 'nothink') live.outboundMode = next.outboundMode;
      else if (next.outboundMode === 'active') live.outboundMode = 'adaptive';
      // botplay 事件: 真相源已迁到 {dataRoot}/botplay-events.json(2026-09-10 M4.3);
      // ⚠️ 仅当 settings 提供了**非空**数组时才覆盖 live, 否则空数组会把文件装载的事件清掉
      //    (实测症状: dock 保存后 /botplay 报"还没有装配任何互动事件")。
      if (Array.isArray(next.botplayEvents) && next.botplayEvents.length > 0) live.botplayEvents = next.botplayEvents;
      logger.info('[im-qqbot] 设置已同步(live): dataRoot/behavior/sticker/injectRules/imageHint/imageOffload/imageAggregate/messageReference/extMetaTool/webTurnSilent/localModel/groupPrompt/schedule/groupAdmin/approvals/botplayEvents');
    } catch (err) {
      logger.warn?.(`im-qqbot: 设置同步失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const hooks = {
    setSource: (s: () => EditableConfig): void => { source = s; sync(); },
    onChange: (): void => sync(),
  };
  const installed = await registerSettingsSection(ctx, ns, EditableConfigSchema, entry, hooks, logger);
  if (installed) {
    logger.info(`[im-qqbot:${ns}] settings 命名空间已注册 (${ns})`);
  }

  // 出站模式切换 writer(2026-09-07; 2026-09-11 多实例修复): 命令/工具调 switchOutboundMode → 这里执行
  // ①live.outboundMode 原地改(与 bootstrap/router 同引用, 立即热生效);
  // ②尽力经 settings 服务 update 持久化 —— dock/设置面板与 live 同一数据源, 三方一致(重启不丢)。
  // ⚠️ 按 ns 注册: 多实例(多个实例)各自 apply 时不能共用一个 writer,
  //    否则切换会落到最后注册的那个实例(config 改错对象, dock 显示与实测不符)。修复于 2026-09-11。
  /**
   * ★ 2026-11-05（主人实测 bug）：`/outmode` 与 `outbound_mode` 工具切换后，**面板仍显示旧模式**。
   *   根因：这条路径只改了 `live`（内存），`svc.update()` 要么拿不到 settings 服务、要么抛错，
   *   两种情况都只留内存 ⇒ 磁盘上的 `outboundMode` 没变 ⇒ dock 面板读文件就显示旧值（三方不一致）。
   *
   *   这里加一层兜底：**直接按 settings-host 同一套路径规则写文件**
   *   （`{DSH_HOME}/qqbot-settings/{profile}/{ns}.json`，profile 取 apply 回写的 DSH_PROFILE）。
   *   读 → 只改 outboundMode → 写回，其它字段原样保留。返回是否写成功。
   */
  const writeOutboundModeFile = (nsKey: string, mode: string): boolean => {
    try {
      const dshHome = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
      const prof = String(resolveProfileName() || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || '_default';
      const safeNs = String(nsKey || 'im-qqbot').replace(/[^A-Za-z0-9_-]/g, '_') || 'im-qqbot';
      const dir = join(dshHome, 'qqbot-settings', prof);
      const f = join(dir, safeNs + '.json');
      mkdirSync(dir, { recursive: true });
      let cur: Record<string, unknown> = {};
      try {
        const raw = readFileSync(f, 'utf8');
        const o = JSON.parse(raw) as unknown;
        if (o && typeof o === 'object') cur = o as Record<string, unknown>;
      } catch { /* 首次/损坏 → 空对象起步 */ }
      cur.outboundMode = mode;
      writeFileSync(f, JSON.stringify(cur, null, 2), 'utf8');
      logger.info?.(`im-qqbot: 出站模式已写入 settings 文件 ${f} → ${mode}`);
      return true;
    } catch (err) {
      logger.warn?.(`im-qqbot: 出站模式写 settings 文件失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  setOutboundModeWriter(ns, async (mode) => {
    live.outboundMode = mode;
    let persisted = false;
    const svc = getSettingsService();
    if (svc && typeof (svc as { update?: unknown }).update === 'function') {
      try {
        await (svc as { update: (ns: string, patch: unknown, rev?: unknown) => Promise<unknown> }).update(ns, { outboundMode: mode });
        persisted = true;
      } catch (err) {
        logger.warn?.(`im-qqbot: 出站模式 settings.update 失败，改用直写文件: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // ★ 兜底：settings 服务拿不到 / update 抛错 → 直接写配置文件，保证面板与 live 一致
    if (!persisted) persisted = writeOutboundModeFile(ns, mode);
    return { ok: true, msg: '已切换: ' + mode + (persisted ? '' : '（⚠️ 配置文件写入失败，重启后会回退）'), mode };
  });
}

/** settings 服务引用(registerSettingsSection 注入时保存; 无 settings 服务时为 undefined) */
let _settingsSvc: unknown;
function captureSettingsService(svc: unknown): void { _settingsSvc = svc; }
export function getSettingsService(): unknown { return _settingsSvc; }

/**
 * 版本自适应注册。两条路径语义等价：
 *   1) 新版(alpha / dsh-settings 0.1.2 线): ctx.inject(['settings'], sc => sc.settings.installSection(ctx, ns, schema, entry, hooks))
 *      —— 官方样板(dsh-bash-local 等): 服务经 cordis 声明式注入, 直读 ctx.settings / ctx.get 拿不到!
 *   2) 旧版(rc.2): @deepseek-ai/dsh-settings 的 installSettingsSection(ctx, ns, schema, entry, hooks)
 * 优先新版(harness 自带服务)；旧版包在时兜底；都不可用则返回 false(纯 yml 模式, 不中断插件)。
 */
async function registerSettingsSection(
  ctx: Context,
  ns: string,
  schema: unknown,
  entry: unknown,
  hooks: unknown,
  logger: Logger,
): Promise<boolean> {
  // 1) 新版: ctx.inject(['settings'], …) 声明式注入(官方用法)
  const injectable = ctx as unknown as { inject?: (names: string[], cb: (sc: unknown) => void) => void };
  if (typeof injectable.inject === 'function') {
    try {
      injectable.inject(['settings'], (settingsCtx) => {
        try {
          const svc = (settingsCtx as { settings?: { installSection?: (...args: unknown[]) => unknown } }).settings;
          if (svc && typeof svc.installSection === 'function') {
            captureSettingsService(svc);
            svc.installSection(ctx, ns, schema, entry, hooks);
            logger.info(`[im-qqbot:${ns}] settings 命名空间已注册 (${ns})`);
            return;
          }
        } catch (err) {
          logger.warn?.(`im-qqbot: settings 注入注册失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        void legacyRegister(ctx, ns, schema, entry, hooks, logger);
      });
      // inject 回调若为同步执行且已尝试, 视为已处理; 无法探测是否成功, 交由回调日志确认。
      return true;
    } catch { /* inject 不可用则走下方 legacy */ }
  }
  return legacyRegister(ctx, ns, schema, entry, hooks, logger);
}

/** 旧版 @deepseek-ai/dsh-settings 具名导出(运行时动态探测, 避免静态导入拖垮启动) */
async function legacyRegister(ctx: Context, ns: string, schema: unknown, entry: unknown, hooks: unknown, logger: Logger): Promise<boolean> {
  try {
    const mod = (await import('@deepseek-ai/dsh-settings')) as {
      installSettingsSection?: (...args: unknown[]) => unknown;
      settingsNamespace?: (value: string) => unknown;
    };
    if (typeof mod.installSettingsSection === 'function') {
      const brandedNs = typeof mod.settingsNamespace === 'function' ? mod.settingsNamespace(ns) : ns;
      mod.installSettingsSection(ctx, brandedNs, schema, entry, hooks);
      logger.info(`[im-qqbot:${ns}] settings 命名空间已注册(legacy) (${String(brandedNs)})`);
      return true;
    }
  } catch (err) {
    logger.warn?.(`im-qqbot: 旧版 dsh-settings 探测失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  logger.warn?.('im-qqbot: 当前 harness 未暴露可用的 settings 注册 API，跳过可视化设置(仍可用纯 yml/补丁配置)。');
  return false;
}

