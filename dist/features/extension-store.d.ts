import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.js';
/** 扩展命令目录名(相对 cwd) */
export declare const EXT_COMMANDS_SUBDIR: string;
/** 扩展工具目录名(相对 cwd) */
export declare const EXT_TOOLS_SUBDIR: string;
/** botplay 自定义事件目录名(相对数据根; 2026-10-05 第三套扩展) */
export declare const EXT_BOTPLAY_SUBDIR: string;
/**
 * 启动钩子目录名(相对数据根; 2026-10-12 第四套扩展)。
 * 与前几套的区别: 钩子**不需要任何人触发** —— 插件启动(apply)时自动跑一次。
 * 引擎在 features/ext-hooks.ts(本文件只提供目录常量, 免得两边各写一份字符串写歪)。
 */
export declare const EXT_HOOKS_SUBDIR: string;
/**
 * 入站中间件目录名(相对数据根; 2026-10-12 第五套扩展)。
 * 与前几套的区别: 入站扩展**每条消息都跑一遍**, 且能读到/改写 ctx.state.mention、
 * 甚至不调 next() 把这条整条拦掉 —— 它是"影响入站"的扩展点。
 * 引擎在 features/ext-inbound.ts(本文件只提供目录常量, 免得两边各写一份字符串写歪)。
 */
export declare const EXT_INBOUND_SUBDIR: string;
/**
 * 扫描并加载扩展命令目录下的全部命令。
 * fail-soft: 单个文件坏/抛错只记日志, 不影响其它扩展与插件本体。
 */
export declare function loadExtensionCommands(cwd: string | undefined, logger: Logger): Promise<SlashCommand[]>;
/** 扩展目录路径(cwd 不存在时 undefined; dock/工具展示用) */
export declare function extensionCommandsDir(cwd: string | undefined): string;
/** 扩展工具目录路径(dock/工具展示用) */
export declare function extensionToolsDir(cwd: string | undefined): string;
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
    onInteraction?: (ctx: Record<string, unknown>, info: {
        cardId: string;
        buttonId: string;
        buttonLabel: string;
        clickedBefore: boolean;
        event: unknown;
    }) => Promise<unknown> | unknown;
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
/** 扫描并加载扩展工具目录(P4.2; 由 channel-tools 在注册时调用) */
export declare function loadExtensionTools(cwd: string | undefined, logger: Logger): Promise<ExtensionToolDef[]>;
/** botplay 自定义事件模块目录(相对数据根) */
export declare function botplayExtensionsDir(dataRoot: string): string;
/**
 * 文件名安全校验(防 `../` 逃逸出扩展目录):
 * 只允许"纯文件名", 不允许任何路径分隔符(Windows 反斜杠也算)。
 * 说明: 允许子目录会带来逃逸面, 而主人的使用场景(一个事件一个模块)根本不需要子目录。
 */
export declare function safeBotplayFileName(file: string): string | null;
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
export declare function loadBotplayExtensionModule(dataRoot: string, file: string, logger: Logger): Promise<{
    ok: true;
    loaded: LoadedBotplayModule;
} | {
    ok: false;
    error: string;
    path: string;
}>;
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
export declare function seedExampleTools(dataRoot: string, logger: Logger): number;
//# sourceMappingURL=extension-store.d.ts.map