const DENIED = '⚠️ 这个命令只有主人能用。';
/** 没配置白名单时的引导文案（要求用户去哪填） */
const NOT_CONFIGURED = '⚠️ 还没配置「允许操作的主人 openid」，所以这条管理命令暂时不能用。\n'
    + '① 先发 **/bot-me** 拿到你自己在本机器人下的 OpenID（直接复制那串）\n'
    + '② 到 **设置 → QQ 机器人 → 设置 → 群管理基础设置 →「允许操作的主人 openid」** 里填上'
    + '（多个用逗号分隔），保存后重试。\n'
    + '💡 每个机器人实例的 openid 不一样（同一个 QQ 号对不同 appId 的 openid 不同），'
    + '多实例要分别配置。';
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
        // 名单为空 ⇒ 没配过：拒绝 + 告诉用户去哪儿配（不默默放行，也不只丢一句"无权限"）
        if (owners.length === 0) {
            logger?.warn?.('[cmd-auth] 拒绝：主人白名单为空（groupAdmin.owners 未配置）');
            return NOT_CONFIGURED;
        }
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