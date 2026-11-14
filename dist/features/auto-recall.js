/**
 * 自动撤回配置的**唯一解析入口**。
 *
 * 为什么需要它（2026-11-14，CodeRabbit 复审指出）：
 *   `middleware-setup.ts` 和 `gateway/bootstrap.ts` **各读各的** ——
 *   前者走"磁盘优先"（面板刚存的值），后者只读闭包里的 `config.groupAdmin.autoRecall`（可能还是旧值）。
 *   后果：面板把 `dryRun` 改成 true 之后，中间件那条按磁盘放行（不 return），
 *   消息继续流到 bootstrap —— bootstrap 按**闭包里的 dryRun=false** 判定 ⇒ **照样真撤回 + 禁言**。
 *   演练模式等于失效，而且两处都静默。
 *
 * 所以：**同一份已解析的配置，必须同时决定"放不放行"和"撤不撤回"**。
 *
 * 顺带解决另一条（审查台账 #13）：原来每条群消息都 `readFileSync + JSON.parse`，
 * 位置还在 debounce **之前**，直接阻塞整条入站链。这里加 1 秒 TTL 缓存。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** 磁盘快照缓存（TTL 1s）：同一条消息链上两处调用只会读一次盘 */
let cache = {
    key: '',
    at: 0,
    value: undefined,
};
const TTL_MS = 1000;
/** 设置文件路径：与 settings 落盘位置一致（`~/.dsh/qqbot-settings/<profile>/<ns>.json`） */
function settingsFileOf(cfg) {
    const c = cfg;
    const prof = process.env.DSH_PROFILE || 'web';
    // ★★ 2026-11-14（CodeRabbit 抓到）：默认命名空间必须与**写入方**一致。
    //   src/index.ts:172/213 的默认是 'im-qqbot'（主账号），这里我照抄旧代码写成了
    //   'im-qqbot-2' ⇒ 主实例（settingsNs 未设置）会去读**别人的** im-qqbot-2.json：
    //   读不到 → 回退闭包（面板设置不生效）；读得到 → 直接用另一台机器人的撤回/禁言规则。
    const ns = String(c?.settingsNs || c?.ns || 'im-qqbot').trim();
    return join(homedir(), '.dsh', 'qqbot-settings', prof, `${ns}.json`);
}
/**
 * 解析自动撤回配置：**磁盘（面板值）优先 → 闭包兜底**。
 *
 * 注意：磁盘读失败（文件不存在 / JSON 坏）时退回闭包值，这是**故意**的 ——
 * 读不到盘不该让自动撤回整体失效。这与"实例归属解析必须 fail-closed"是两回事：
 * 这里兜的是同一实例内的两份配置副本，不是另一个实例的状态。
 */
export function resolveAutoRecall(cfg) {
    const closure = cfg
        ?.groupAdmin?.autoRecall;
    const file = settingsFileOf(cfg);
    const now = Date.now();
    if (cache.key === file && now - cache.at < TTL_MS) {
        return cache.value ?? closure;
    }
    let disk;
    try {
        const j = JSON.parse(readFileSync(file, 'utf8'));
        disk = j?.groupAdmin?.autoRecall;
    }
    catch {
        disk = undefined;
    }
    cache = { key: file, at: now, value: disk };
    return disk ?? closure;
}
/** 测试用：清缓存 */
export function __resetAutoRecallCache() {
    cache = { key: '', at: 0, value: undefined };
}
//# sourceMappingURL=auto-recall.js.map