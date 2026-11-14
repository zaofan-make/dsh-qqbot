/**
 * extension-store.ts — 用户扩展注册表(Phase 4 P4.1, 2026-09-08)
 *
 * 目的: 让用户/AI 能写【自定义斜杠命令】存在【插件包之外】的扩展目录,
 * 插件 npm 升级只换"引擎"(node_modules), 扩展目录永不覆盖 —— 用户资产与代码分离。
 *
 * 扩展目录(每账号独立, 与表情包/定时同理念): {config.cwd}/.qqbot-extensions/commands/*.js
 * 扩展文件格式(ESM, 与 SDK SlashCommand 对齐):
 *   export default {
 *     name: 'hello',                    // 或 name: ['hello','hi'](别名)
 *     description: '打招呼',
 *     usage: '/hello [名字]',
 *     handler: (ctx) => '你好呀~',       // 返回 string 或 {kind:'noop'}
 *   };
 *
 * 加载策略: 启动时同步列目录 + 逐个动态 import(fail-soft: 坏文件跳过不拖垮插件);
 * 注册接点: middleware-setup 把 loadExtensionCommands() 结果并入 buildCommandList →
 * 群聊前置解析 cmdMap + SDK slash 都覆盖 → /命令 重启后即用(宿主有 /bot-restart 一键重启)。
 * 热刷(不重启)留给 P4.2 dock 管理 UI。
 */
import { readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { absCwdOf } from '../util/abs-path.js';
import { scanExtFiles } from './ext-packs.js';
import { join, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.js';

/** 扩展命令目录名(相对 cwd) */
export const EXT_COMMANDS_SUBDIR = join('.qqbot-extensions', 'commands');
/** 扩展工具目录名(相对 cwd) */
export const EXT_TOOLS_SUBDIR = join('.qqbot-extensions', 'tools');
/** botplay 自定义事件目录名(相对数据根; 2026-10-05 第三套扩展) */
export const EXT_BOTPLAY_SUBDIR = join('.qqbot-extensions', 'botplay');
/**
 * 启动钩子目录名(相对数据根; 2026-10-12 第四套扩展)。
 * 与前几套的区别: 钩子**不需要任何人触发** —— 插件启动(apply)时自动跑一次。
 * 引擎在 features/ext-hooks.ts(本文件只提供目录常量, 免得两边各写一份字符串写歪)。
 */
export const EXT_HOOKS_SUBDIR = join('.qqbot-extensions', 'hooks');
/**
 * 入站中间件目录名(相对数据根; 2026-10-12 第五套扩展)。
 * 与前几套的区别: 入站扩展**每条消息都跑一遍**, 且能读到/改写 ctx.state.mention、
 * 甚至不调 next() 把这条整条拦掉 —— 它是"影响入站"的扩展点。
 * 引擎在 features/ext-inbound.ts(本文件只提供目录常量, 免得两边各写一份字符串写歪)。
 */
export const EXT_INBOUND_SUBDIR = join('.qqbot-extensions', 'inbound');

/** 扩展文件允许的扩展名 */
const ALLOWED_EXT = new Set(['.js', '.mjs', '.cjs']);

/**
 * 扩展文件版本号(取文件 mtime)。
 * 2026-09-15 修复内存泄漏: 原用时间戳 query 做 cache-bust, 每次调用都生成全新 URL,
 * Node 的 ESM 模块注册表(ModuleMap)对每个 URL 永久强引用, 旧模块实例无法被 GC ——
 * 长时间运行(每次消息 mount / hotReload)会持续吃内存直至 OOM。
 * 改为按 mtime: 文件未改动 → URL 相同 → 复用缓存模块; 改动后自动加载新版本。
 */
function fileVersion(p: string): string {
  try {
    return String(Math.floor(statSync(p).mtimeMs));
  } catch {
    // ★★ 2026-11-14 修：**绝不能返回 Date.now()** —— 这正是上面注释明令禁止的做法。
    //   文件在扫描后/import 前消失（或 ACL 拒绝）时每次拿到新 URL
    //   ⇒ ESM ModuleMap 永久强引用旧模块 ⇒ 长跑内存单调上涨。
    return '0';
  }
}

/** 归一化为 SDK SlashCommand: 支持 default 导出 或 具名 name/handler */
function normalizeModule(mod: unknown, file: string, logger: Logger): SlashCommand | null {
  try {
    const m = (mod as { default?: unknown })?.default ?? mod;
    const obj = m as {
      name?: string | string[];
      aliases?: string[];
      description?: string;
      usage?: string;
      handler?: (ctx: never) => unknown;
      authorized?: (ctx: never) => boolean | string;
      /** ★ 2026-10-13：命令也能收「卡片按钮回调」（与扩展工具同一套 ext: 派发） */
      onInteraction?: (ctx: never, info: never) => unknown;
    };
    if (!obj || typeof obj !== 'object') {
      logger.warn(`[ext] ${file}: 导出不是对象, 跳过`);
      return null;
    }
    const names = Array.isArray(obj.name) ? obj.name : [obj.name ?? ''];
    const finalNames = [...names, ...(Array.isArray(obj.aliases) ? obj.aliases : [])].filter(Boolean);
    if (finalNames.length === 0 || typeof obj.handler !== 'function') {
      logger.warn(`[ext] ${file}: 缺 name 或 handler, 跳过`);
      return null;
    }
    // 官方 SDK 的 SlashCommand 没有 onInteraction 字段 ⇒ 用**交叉类型**挂上去（不改第三方）。
    // 这样「扩展命令」也能像「扩展工具」那样收 `ext:<名字>:<卡id>:<按钮id>` 按钮回调。
    const cmd: SlashCommand & { onInteraction?: (ctx: never, info: never) => unknown; __file?: string } = {
      name: finalNames.length > 1 ? finalNames : finalNames[0]!,
      description: String(obj.description ?? '自定义扩展命令'),
      handler: obj.handler as never,
      // 2026-10-24：记住来源文件，供执行时把「该扩展自己的设置」塞进 ctx.config
      __file: file,
    };
    if (obj.usage) cmd.usage = obj.usage;
    if (typeof obj.authorized === 'function') cmd.authorized = obj.authorized as never;
    if (typeof obj.onInteraction === 'function') cmd.onInteraction = obj.onInteraction;
    return cmd;
  } catch (err) {
    logger.warn(`[ext] ${file}: 归一化失败 ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 扫描并加载扩展命令目录下的全部命令。
 * fail-soft: 单个文件坏/抛错只记日志, 不影响其它扩展与插件本体。
 */
export async function loadExtensionCommands(cwd: string | undefined, logger: Logger): Promise<SlashCommand[]> {
  // ★ 2026-10-24：内置 commands 目录 + 所有扩展包的 commands/
  const base = cwd || process.cwd();
  const hits = scanExtFiles(base, 'commands', ALLOWED_EXT);
  const out: SlashCommand[] = [];
  for (const hit of hits) {
    const f = hit.name;
    const abs = hit.abs;
    try {
      // Windows 绝对路径必须转 file:// URL 再动态 import(版本号=mtime, 见 fileVersion)
      const url = pathToFileURL(abs).href + `?v=${fileVersion(abs)}`;
      const mod = await import(url);
      const cmd = normalizeModule(mod, f, logger);
      if (cmd) {
        out.push(cmd);
        logger.info(`[ext] 已加载扩展命令: ${f} → /${Array.isArray(cmd.name) ? cmd.name.join('|') : cmd.name}`);
      }
    } catch (err) {
      logger.warn(`[ext] ${f} 加载失败(已跳过, 不影响其它): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** 扩展目录路径(cwd 不存在时 undefined; dock/工具展示用) */
export function extensionCommandsDir(cwd: string | undefined): string {
  // ★ 2026-11-14 修：与下面 extensionToolsDir 统一做绝对化 —— 相对 cwd 时若直接 join，
  //   面板/xistsSync 会按 process.cwd() 解析，指向一个实际不存在的位置。
  return cwd ? join(absCwdOf(cwd) || cwd, EXT_COMMANDS_SUBDIR) : join(process.cwd(), EXT_COMMANDS_SUBDIR);
}

/** 扩展工具目录路径(dock/工具展示用) */
export function extensionToolsDir(cwd: string | undefined): string {
  return cwd ? join(absCwdOf(cwd) || cwd, EXT_TOOLS_SUBDIR) : join(process.cwd(), EXT_TOOLS_SUBDIR);
}

// ── 扩展工具(P4.2) ─────────────────────────────────────────────
// 扩展文件格式(ESM, 与 dsh tool 形状对齐, 见 README/示例):
//   export default {
//     name: 'echo_text',
//     description: '把用户文本原样返回(演示)',
//     inputSchema: { text: { type: 'string', required: true, description: '要回显的文本' } },
//     async run(args, env) {          // env: { cwd, manager, sender, replyTarget, logger, ... }
//       return { ok: true, msg: args.text };
//     },
//   };
// run 返回值统一 { ok, msg, data? }; 抛错会被外层捕获转 { ok:false, msg }。

/** 归一化后的扩展工具定义 */
export interface ExtensionToolDef {
  file: string;
  name: string;
  description: string;
  /**
   * 源文件 mtime（2026-11-14 加）。**给注册处的签名缓存用** ——
   * 只比 name/description/schema 的话，"改了实现没改 schema"热刷不生效。
   */
  mtime?: number;
  inputSchema: Record<string, unknown>;
  /** 执行体: 参数 schema 由调用方校验, run 直接收已校验 args + env */
  run: (args: Record<string, unknown>, env: Record<string, unknown>) => Promise<unknown> | unknown;
  /**
   * 按钮回调钩子（2026-10-08 新增，**可选导出**）：本工具发出去的卡片按钮被点击时，
   * 插件把事件派发到这里（分发链见 features/ext-tool-interaction.ts，注册表见 ext-tool-cards.ts）。
   *
   * 契约：
   * ```js
   * export default {
   *   name: 'vote', run() {…},
   *   async onInteraction(ctx, info) {
   *     // ctx.performer: { openid, name, isOwner }  ← 点击者身份
   *     // info: { cardId, buttonId, buttonLabel, clickedBefore, event }
   *     return '已记票 ✅';   // 非空字符串 → 作为回执发给点击者
   *   },
   * };
   * ```
   * 不导出它 = 不接收交互（点击落到原有兜底，最终只 ack）。
   */
  onInteraction?: (
    ctx: Record<string, unknown>,
    info: { cardId: string; buttonId: string; buttonLabel: string; clickedBefore: boolean; event: unknown },
  ) => Promise<unknown> | unknown;
  /**
   * 暴露范围（2026-10-10 主人定）：让扩展工具能**跨通道**用。
   *
   * - 不写 / 'qq'：完全维持旧行为 —— 只在 QQ 会话里能拿到 manager/sender。
   * - 'all'：注册名自动带**人设 id**（`<name>@<preset>`，如 `send_texts@whale`）标明归属，
   *   并在执行时注入 `env.qq`（该人设实例的"QQ 账号包"：
   *   appId / appSecret / owners / groups[] / c2c[] / sender / sendText·sendMarkdown·sendImage / apiCall）——
   *   于是 **web、终端等非 QQ 通道的会话**也能把消息发进指定的群或私聊。
   *
   * ⚠️ 账号参数只交给本机 `.qqbot-extensions/tools/*.mjs`（= 主人自己写的代码），与内置工具同权限。
   */
  expose?: 'qq' | 'all';
  /**
   * 条件可见（2026-11-14，主人要求「没配 API 就不让 AI 看见这些工具」）：
   * 注册前调用，返回 false ⇒ **不注册**（AI 完全看不见，不是"看得见但报错"）。
   * 不声明 = 永远可见，与老扩展完全兼容。
   *
   * 为什么这就是"热开关"：注册是按会话走的（mountChannelTools），
   * 新会话 / `/tools-reload` 都会重新求值，所以配置一改，下一轮就生效。
   * env = { agent, config, manager, dataRoot, logger }。
   */
  enabled?: (env: Record<string, unknown>) => boolean | Promise<boolean>;
}

function normalizeToolModule(mod: unknown, file: string, logger: Logger): ExtensionToolDef | null {
  try {
    const m = (mod as { default?: unknown })?.default ?? mod;
    const obj = m as {
      name?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      parameters?: Record<string, unknown>;
      run?: (args: Record<string, unknown>, env: Record<string, unknown>) => unknown;
      onInteraction?: ExtensionToolDef['onInteraction'];
      expose?: unknown;
      enabled?: unknown;
    };
    const name = String(obj?.name ?? '').trim();
    if (!name || typeof obj?.run !== 'function') {
      logger.warn(`[ext-tool] ${file}: 缺 name 或 run, 跳过`);
      return null;
    }
    const onInteraction = typeof obj?.onInteraction === 'function' ? obj.onInteraction : undefined;
    return {
      file,
      name,
      description: String(obj.description ?? '用户扩展工具'),
      inputSchema: obj.inputSchema ?? obj.parameters ?? {},
      run: obj.run,
      // 有才挂：让"不接收交互的工具"与老版本行为完全一致
      ...(onInteraction ? { onInteraction } : {}),
      // 同上：不声明 expose 的工具，行为与老版本一模一样
      ...(obj?.expose === 'all' ? { expose: 'all' as const } : {}),
      // 条件可见（2026-11-14）：不声明 = 永远可见
      ...(typeof obj?.enabled === 'function' ? { enabled: obj.enabled as ExtensionToolDef['enabled'] } : {}),
    };
  } catch (err) {
    logger.warn(`[ext-tool] ${file}: 归一化失败 ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 扫描并加载扩展工具目录(P4.2; 由 channel-tools 在注册时调用) */
export async function loadExtensionTools(cwd: string | undefined, logger: Logger): Promise<ExtensionToolDef[]> {
  // ★ 2026-10-24：内置 tools 目录 + 所有扩展包的 tools/（cwd 实参 = 插件数据根 dataRoot）
  const base = cwd || process.cwd();
  const hits = scanExtFiles(base, 'tools', ALLOWED_EXT);
  const out: ExtensionToolDef[] = [];
  for (const hit of hits) {
    const f = hit.name;
    const abs = hit.abs;
    try {
      const url = pathToFileURL(abs).href + `?v=${fileVersion(abs)}`;
      const mod = await import(url);
      const def = normalizeToolModule(mod, f, logger);
      if (def) {
        // ★ 2026-11-14：把**源文件 mtime** 一起带出去。
        //   起因（主人实测）：改了 `tools/xxx.mjs` 的实现（schema/描述都没变），
        //   `tools_reload` 之后照旧报旧代码的错 —— 因为 channel-tools 的签名缓存只比
        //   name/description/schema，这四样没变 ⇒ "未变化，跳过重复注册" ⇒ 新模块永远进不来。
        //   带出 mtime 后，签名能感知"实现变了"，热刷才真的热。
        def.mtime = Math.floor(statSync(abs).mtimeMs);
        out.push(def);
        logger.info(`[ext-tool] 已加载扩展工具: ${f} → ${def.name} (m=${def.mtime})`);
      }
    } catch (err) {
      logger.warn(`[ext-tool] ${f} 加载失败(已跳过): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ── botplay 自定义事件模块(2026-10-05) ─────────────────────────────────
// 契约与 ctx 能力见 features/botplay-ext.ts 头部注释; 这里只负责"按文件名加载一个模块"。
// 与上面两套扩展的两点不同(为什么不能直接复用 loadExtensionTools):
//   ① 扫描根是**数据根**(dataRoot)不是 agent cwd —— botplay 事件本身就是 dataRoot 下的文件;
//   ② 是"按需单文件加载"(事件 JSON 的 file 字段点名), 而且**必须能把错误带回去给面板**,
//      所以这里不做 fail-soft 吞错: 抛出/返回 error 由调用方(botplay 控制器)决定降级方式。

/** botplay 自定义事件模块目录(相对数据根) */
export function botplayExtensionsDir(dataRoot: string): string {
  return join(dataRoot, EXT_BOTPLAY_SUBDIR);
}

/**
 * 文件名安全校验(防 `../` 逃逸出扩展目录):
 * 只允许"纯文件名", 不允许任何路径分隔符(Windows 反斜杠也算)。
 * 说明: 允许子目录会带来逃逸面, 而主人的使用场景(一个事件一个模块)根本不需要子目录。
 */
export function safeBotplayFileName(file: string): string | null {
  const f = String(file ?? '').trim();
  if (!f) return null;
  if (f.includes('/') || f.includes('\\') || f.includes('..')) return null;
  if (!/^[A-Za-z0-9._@-]+$/.test(f)) return null;
  if (!ALLOWED_EXT.has(extname(f).toLowerCase())) return null;
  return f;
}

/**
 * 归一化后的 botplay 模块(结构形状与 botplay-ext.ts 的 BotplayExtModule 一致)。
 * ⚠️ 这里**故意不 import BotplayExtModule**: 两个模块互相 import 会让"谁先定义"变得微妙,
 *   而这里只需要"是不是函数"这个结构信息 —— 用 unknown 形参最宽, 交给调用方(botplay.ts)
 *   转成 BotplayExtModule(那边才有真正的 ctx 类型), 避免 any/never 打架。
 */
export interface BotplayModuleShape {
  name?: string;
  onInit?: (...args: never[]) => unknown;
  onClick?: (ctx: never, info: never) => unknown;
  onTick?: (ctx: never) => unknown;
  onExpire?: (ctx: never) => unknown;
  onDispose?: (ctx: never) => unknown;
}

/** 校验模块至少导出了一个钩子(全空的模块必然是写错了, 早点报错比静默不响应好) */
const BOTPLAY_HOOKS = ['onInit', 'onClick', 'onTick', 'onExpire', 'onDispose'] as const;

function normalizeBotplayModule(mod: unknown): { mod: BotplayModuleShape; name: string } | { error: string } {
  const m = ((mod as { default?: unknown })?.default ?? mod) as BotplayModuleShape | undefined;
  if (!m || typeof m !== 'object') return { error: '模块没有 default 导出对象(应 export default { onInit, onClick, … })' };
  const hooks = BOTPLAY_HOOKS.filter((h) => typeof (m as Record<string, unknown>)[h] === 'function');
  if (hooks.length === 0) {
    return { error: `模块没有导出任何钩子(至少要有 ${BOTPLAY_HOOKS.join(' / ')} 之一)` };
  }
  return { mod: m, name: String(m.name ?? '').trim() };
}

/** 加载结果(带来源信息, 供面板/诊断展示) */
export interface LoadedBotplayModule {
  file: string;
  /** 绝对路径 */
  path: string;
  /** mtime(ms): 热重载判据 + 面板"最后修改时间" */
  mtime: number;
  name: string;
  mod: BotplayModuleShape;
}

/**
 * 加载(或热重载)一个 botplay 自定义事件模块。
 *
 * 热重载靠 `?v=<mtime>` 做 cache-bust —— 与 extension-store 的 fileVersion 同款
 * (⚠️ 别改回时间戳: 每次新 URL 会让 Node ESM ModuleMap 永久强引用旧模块, 长跑吃内存直至 OOM,
 *  2026-09-15 那次扩展工具内存泄漏就是这个坑)。
 */
export async function loadBotplayExtensionModule(
  dataRoot: string,
  file: string,
  logger: Logger,
): Promise<{ ok: true; loaded: LoadedBotplayModule } | { ok: false; error: string; path: string }> {
  const safe = safeBotplayFileName(file);
  const dir = botplayExtensionsDir(dataRoot);
  if (!safe) {
    return { ok: false, error: `文件名不安全/扩展名不支持: ${file}(只允许 .mjs/.js/.cjs 的纯文件名)`, path: join(dir, String(file ?? '')) };
  }
  const abs = join(dir, safe);
  let mtime = 0;
  try {
    mtime = statSync(abs).mtimeMs;
  } catch (err) {
    return {
      ok: false,
      error: `模块文件不存在或读不到: ${abs}(${err instanceof Error ? err.message : String(err)})`,
      path: abs,
    };
  }
  try {
    const url = pathToFileURL(abs).href + `?v=${fileVersion(abs)}`;
    const raw = await import(url);
    const norm = normalizeBotplayModule(raw);
    if ('error' in norm) return { ok: false, error: `${safe}: ${norm.error}`, path: abs };
    logger.info(`[botplay-ext] 已加载模块: ${safe} (mtime=${Math.floor(mtime)})`);
    return {
      ok: true,
      loaded: {
        file: safe,
        path: abs,
        mtime: Math.floor(mtime),
        name: norm.name || safe.replace(/\.(mjs?|cjs)$/i, ''),
        mod: norm.mod,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[botplay-ext] ${safe} 加载失败: ${msg}`);
    return { ok: false, error: `${safe}: ${msg}`, path: abs };
  }
}


/**
 * 首次运行"送个见面礼"：把本包自带的扩展示例（`examples/ext-tools/*.mjs`）
 * 铺到用户的扩展目录 `{dataRoot}/.qqbot-extensions/tools/`。
 *
 * 场景（2026-10-10 主人定）：新用户装上插件、工作目录里生成 `dshqqbot/` 之后，
 * **不用自己手动搬示例** —— 插件启动时自动铺一份可跑的工具示例进去。
 *
 * ⚠️ 三条纪律：
 *   ① **只补不存在**的文件，绝不覆盖用户改过/写过的同名文件；
 *   ② 失败静默（示例只是见面礼，绝不能影响插件启动）；
 *   ③ 返回本次铺设的数量（便于日志/诊断）。
 */
export function seedExampleTools(dataRoot: string, logger: Logger): number {
  let n = 0;
  try {
    // 项目里**所有**扩展示例都要送（2026-10-10 主人定）：工具示例 + botplay 卡片示例
    // 2026-10-12 追加第三套：启动钩子示例（examples/ext-hooks/ → .qqbot-extensions/hooks/）。
    //   与 seed 同一时机铺设 ⇒ **首次安装当次启动就能跑到示例钩子**（不用重启宿主）。
    // 2026-10-12 追加第五套：入站中间件示例（examples/ext-inbound/ → .qqbot-extensions/inbound/）。
    //   ⚠️ 2026-10-12 主人定：**这一套只铺"最无害的那个"** —— 见下面第三个元素（文件名白名单）。
    //   理由：入站扩展能影响**每一条**消息（消灭/改写/禁言），自动铺一个"会真动手"的规则到用户目录
    //   等于替他做决定、还会往他数据目录里写状态文件。示例是给人**看和抄**的，不该自己跑起来。
    const sets: Array<[string, string, string[]?]> = [
      ['../../examples/ext-tools/', join(dataRoot, EXT_TOOLS_SUBDIR)],
      ['../../examples/botplay/', join(dataRoot, EXT_BOTPLAY_SUBDIR)],
      ['../../examples/ext-hooks/', join(dataRoot, EXT_HOOKS_SUBDIR)],
      // 2026-10-13 追加：跨会话**命令**示例（`/子会话` 卡片向导）。
      //   纪律同前：copyExampleTree **只补不存在**，绝不覆盖用户改过的同名命令。
      //   它 import `../tools/session_create.mjs`（同批铺进 tools/），所以两者必须一起发版。
      ['../../examples/ext-commands/', join(dataRoot, EXT_COMMANDS_SUBDIR)],
      //   只铺这一个：它只在"引用一条子会话转发消息"时改一下 @ 判定，不改内容、不写状态、不动手。
      ['../../examples/ext-inbound/', join(dataRoot, EXT_INBOUND_SUBDIR), ['no-wake-on-child-quote.mjs']],
      // ⚠️ 注意：`examples/ext-ui/` **不走这里** —— 它要分两个源铺
      //   （slot=settings → profile 级、slot=dock → 数据根），
      //   由 features/ext-ui-seed.ts 的 installExtUi() 单独处理，见 apply()。
    ];
    // 2026-10-12：改成**递归**铺设（原来 readdirSync 只取直接子文件）。
    //   起因：跨会话工具示例（session_create / session_watch）把可变逻辑放在 `lib/*.mjs` 子目录里
    //   （按 mtime 版本化加载），非递归就只搬主文件、`lib/` 不跟着走 → 用户拿到的是 import 不到库的残废示例。
    //   `lib/` 这类子目录**不参与工具扫描**（扫描只看 tools/ 根下的直接子文件），所以铺进去是安全的。
    for (const [rel, dstDir, allow] of sets) {
      try {
        const srcDir = fileURLToPath(new URL(rel, import.meta.url));
        if (!existsSync(srcDir)) continue;
        n += copyExampleTree(srcDir, dstDir, allow);
      } catch { /* 单套失败继续下一套 */ }
    }
    if (n > 0) logger.info?.(`[ext-tools] 已自动铺 ${n} 个扩展示例（tools + botplay + hooks + inbound）`);
  } catch (err) {
    logger.debug?.('[ext-tools] 示例铺设跳过: ' + (err instanceof Error ? err.message : String(err)));
  }
  return n;
}

/**
 * 递归把一个示例目录铺到目标目录，返回本次真正复制的文件数。
 *
 * 纪律与 `seedExampleTools` 一致：**只补不存在**（绝不覆盖用户改过/写过的同名文件）、
 * 任何一步失败都只跳过那一个文件，绝不抛出（示例只是见面礼，不能影响插件启动）。
 *
 * `allowFiles`（可选）：**顶层文件名白名单** —— 只搬名单里的文件，其余跳过。
 * 用于"这一套示例里只有某个是安全的"的场合（见 `seedExampleTools` 里 inbound 那条注释）。
 * 子目录（`lib/` 之类）不受白名单限制，照旧整棵搬。
 */
function copyExampleTree(srcDir: string, dstDir: string, allowFiles?: string[]): number {
  let n = 0;
  try { mkdirSync(dstDir, { recursive: true }); } catch { return 0; }
  const entries = (() => {
    try { return readdirSync(srcDir, { withFileTypes: true }); } catch { return []; }
  })();
  for (const ent of entries) {
    const src = join(srcDir, ent.name);
    const dst = join(dstDir, ent.name);
    if (ent.isDirectory()) {
      n += copyExampleTree(src, dst);          // 子目录（如 lib/）一并搬
      continue;
    }
    if (allowFiles && !allowFiles.includes(ent.name)) continue;   // ★ 顶层白名单：不在名单里就不搬
    if (!ALLOWED_EXT.has(extname(ent.name).toLowerCase())) continue;
    if (existsSync(dst)) continue;             // ★ 不覆盖用户已有的（也就不会重复搬）
    try { copyFileSync(src, dst); n += 1; } catch { /* 单个失败继续 */ }
  }
  return n;
}
