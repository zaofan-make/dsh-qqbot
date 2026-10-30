const DENIED = '⚠️ 这个命令只有主人能用。';
/** 取主人白名单（去空、字符串化） */
export function ownerListOf(config) {
    const raw = config?.groupAdmin?.owners;
    if (!Array.isArray(raw))
        return [];
    return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}
/**
 * 构造 `authorized` 回调。
 * @param config 插件配置（读 groupAdmin.owners）
 * @param logger 拒绝时留痕（真机上排查"为什么他被拒了"）
 */
export function ownerOnlyAuth(config, logger) {
    return (ctx) => {
        const owners = ownerListOf(config);
        // 名单为空 ⇒ 没配过，放行（见文件头注释里的取舍）
        if (owners.length === 0)
            return true;
        const sender = String(ctx?.message?.senderId ?? '').trim();
        if (!sender) {
            logger?.warn?.('[cmd-auth] 拒绝：拿不到 senderId（身份缺失，fail-closed）');
            return DENIED;
        }
        if (owners.includes(sender))
            return true;
        logger?.warn?.(`[cmd-auth] 拒绝：sender=${sender.slice(0, 8)}… 不在主人白名单（${owners.length} 个）`);
        return DENIED;
    };
}
/** 给一个 SlashCommand 套上"仅主人"，返回新对象（不改原对象） */
export function withOwnerOnly(cmd, config, logger) {
    return { ...cmd, authorized: ownerOnlyAuth(config, logger) };
}
//# sourceMappingURL=auth.js.map