/**
 * /bot-restart — 通用自重启 dsh 宿主(2026-09-08, 主人定: 通用插件能力)
 *
 * 通用性: 不依赖任何硬编码路径/外部脚本 —— 动态自发现:
 *  - process.execPath = node 可执行文件; process.argv.slice(1) = 宿主启动参数(如 bin.js web);
 *  - 中间"重启助手"脚本写入系统 tmpdir(无中文路径坑), 用同一 node 解释器 detached 运行;
 *  - 助手: 延迟→杀当前宿主进程(process.kill)→等端口释放→按原命令重新 spawn 宿主(detached, unref)。
 * 跨平台(win/mac/linux), 任何机器装了本插件即可用 /bot-restart(或兼容的 /bot-exit)。
 *
 * ★★ 2026-11-03（issue #38，作者 Chaos-Paradox 给的现场非常扎实）：
 *   **桌面版（DSH Desktop / Electron 外壳 + host 子进程）里绝不能走这条路**。
 *   为什么（社区几份调研互相印证）：
 *     · host 与 Electron 主进程之间的 IPC 是一张**封闭白名单**
 *       （`dsh-desktop-host` 的 `process.on('message')` 只认
 *         `shutdown` / `quit-inspection` / `update-tasks`），
 *       发出白名单外的消息会被主进程直接 SIGTERM ⇒ **插件够不到外壳**，调不了 app.relaunch()；
 *     · 主进程把 host 的**任何主动退出**判为失败（`dsh desktop host stopped` /
 *       `acknowledged an unrequested shutdown`）⇒ 弹崩溃恢复对话框；
 *     · 而我们这条 detached 路径会把「替代 Host」拉成**脱离 GUI 的孤儿进程**
 *       （父进程变成 PID 1 / 独立控制台），同一 desktop profile 下越积越多，
 *       还会让桌面端退不干净 —— 正是 issue #38 的现场。
 *   ⇒ 检测到 Desktop 就**拒绝执行并说清楚**，让用户从 App 退出重开（或改插件后用官方 HMR 重载）。
 *     CLI / `dsh web` 行为完全不变。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * 当前是否跑在 DSH 桌面版（Electron 外壳托管的 host）。
 *
 * 判据（任一命中即认定，宁严勿松——误判成 web 会导致孤儿 Host）：
 *  - argv 里出现 `dsh-desktop-host`（桌面版的 host 入口，见 issue #38 的进程表）
 *  - 环境变量带 Electron / 桌面标识（`ELECTRON_RUN_AS_NODE` 是 Electron 用 node 跑脚本时的标准标记）
 */
export function isDesktopHost() {
    try {
        const argvLine = process.argv.join(' ').toLowerCase();
        if (argvLine.includes('dsh-desktop-host'))
            return true;
        const env = process.env;
        if (env.ELECTRON_RUN_AS_NODE === '1' || env.ELECTRON_RUN_AS_NODE === 'true')
            return true;
        if (env.DSH_DESKTOP === '1' || env.DSH_DESKTOP === 'true')
            return true;
        if (env.DSH_RUNTIME === 'desktop')
            return true;
        return false;
    }
    catch {
        return false;
    }
}
/** 桌面版统一回执（别只说"失败"，要把"为什么"和"怎么"讲清楚） */
export function desktopRefusalText() {
    return [
        '⚠️ 检测到 **DSH 桌面版**，本鲸不能自己重启 —— 这条命令会脱离桌面主进程拉起一个孤儿 Host，',
        '   造成「桌面端退不干净 / 同一 profile 里多份 Host」的问题（issue #38）。',
        '',
        '请改用：',
        '  · **从 App 菜单退出，再重新打开**（这是桌面版唯一干净的重启方式）',
        '  · 只是改了插件代码、没换包版本 → 可以用官方 **HMR 重载内核**（设置页/重载插件），不必重启进程',
    ].join('\n');
}
/**
 * 触发自重启: 生成独立重启助手并脱手运行(当前宿主被杀也能继续拉起新宿主)。
 * 桌面版直接返回 false（调用方负责给出 `desktopRefusalText()` 的说明）。
 */
export function selfRestart(delayMs = 1600, killWaitMs = 2000) {
    if (isDesktopHost()) {
        console.warn('[bot-restart] 检测到桌面版宿主，拒绝 detached 自重启（issue #38）');
        return false;
    }
    try {
        const exe = process.execPath; // node 路径(动态)
        // 宿主启动参数(动态, 如 [bin.js, 'web'])——自重启强制带 --no-open:
        // 后台重启不再弹浏览器标签页(dsh web 启动默认开浏览器; 主人 2026-09-08 定)。
        const args = [...process.argv.slice(1)];
        if (!args.includes('--no-open'))
            args.push('--no-open');
        const pid = process.pid; // 当前宿主 PID(自己)
        const cwd = process.cwd();
        // 重启助手(独立 node 进程): 延迟 → 杀宿主 → 等 → 按原命令拉起新宿主
        const helper = [
            "const { spawn } = require('child_process');",
            `const pid = ${JSON.stringify(pid)};`,
            `const exe = ${JSON.stringify(exe)};`,
            `const args = ${JSON.stringify(args)};`,
            `const cwd = ${JSON.stringify(cwd)};`,
            'setTimeout(() => {',
            '  try { process.kill(pid, \'SIGTERM\'); } catch {}',
            `  setTimeout(() => {`,
            '    try {',
            '      const c = spawn(exe, args, { detached: true, stdio: \'ignore\', cwd });',
            '      c.unref();',
            '      try { require(\'fs\').unlinkSync(__filename); } catch {}',
            '    } catch (e) { console.error(\'[restart-helper] spawn fail\', e); }',
            `  }, ${killWaitMs});`,
            `}, ${delayMs});`,
        ].join('\n');
        const tmpFile = join(tmpdir(), `dsh-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
        writeFileSync(tmpFile, helper, 'utf8');
        // detached + unref: 重启助手脱离宿主独立存活, 宿主被杀它继续执行
        const child = spawn(exe, [tmpFile], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        // 宿主若被杀, 助手自己清理 tmp; 这里再兜底一个延迟删除(助手若已删则忽略)
        setTimeout(() => { try {
            rmSync(tmpFile, { force: true });
        }
        catch { /* 已删 */ } }, delayMs + killWaitMs + 8000).unref?.();
        return true;
    }
    catch (err) {
        console.error('[bot-restart] 触发失败: ' + (err instanceof Error ? err.message : String(err)));
        return false;
    }
}
export function botRestartCommand() {
    return {
        name: 'bot-restart',
        description: '通用自重启 dsh 宿主(CLI/web 有效; 桌面版不支持, 会提示从 App 重启)',
        handler: async () => {
            if (isDesktopHost())
                return desktopRefusalText();
            const ok = selfRestart();
            return ok
                ? '🔁 dsh web 即将自重启(约4秒, 期间短暂离线)。重启完成后我会回来报到~'
                : '❌ 自重启触发失败(看宿主日志)';
        },
    };
}
/** /bot-exit 旧命令兼容: 同样走自重启(杀+拉一条龙)；桌面版同样拒绝 */
export function botExitCommand() {
    return {
        name: 'bot-exit',
        description: '结束并自重启 dsh 宿主(兼容别名, 同 /bot-restart; 桌面版请从 App 退出)',
        handler: async () => {
            if (isDesktopHost())
                return desktopRefusalText();
            const ok = selfRestart();
            return ok
                ? '👋 即将自重启(约4秒)。此命令已升级为 /bot-restart 同款(动态识别, 杀+自动拉起)。'
                : '❌ 自重启触发失败';
        },
    };
}
//# sourceMappingURL=exit.js.map