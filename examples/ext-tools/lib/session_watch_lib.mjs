/**
 * session_watch_lib.mjs — 「回合结束回灌」的共用实现（放在 tools/lib/ 下，不被当工具扫描）
 *
 * 口径**照抄 qqbot 的 passive 收尾**（src/transport/outbound.ts:80-211）：
 *   · 回合内累积 `assistant/message` 的正文（= 它的 noteGenerated(sessionKey, msgId, text)）
 *   · `turn/end` 时结算（它的注释原文：「assistant/message 用完即清，turn/end 兜底清」）
 *   · 取**最后一个正文块**的文本（它收尾时也是"把最后一块复制一份"）
 *
 * ★ 2026-10-12 主人定案（回灌模式三档 + 转发到 QQ + 引用回流）：
 *   **一档（mode=1，默认）**：只把**末段正文**回灌给父会话（原行为），**同时**转发到父会话所在的 QQ。
 *   **二档（mode=2）**：本回合的**所有正文块 + 报错**都转发到 QQ，但**不进父会话上下文**。
 *   **三档（mode=3）**：所有正文 + 报错**进**父会话上下文（**只插话、不唤醒**），同时也转发到 QQ。
 *
 * ★ 转发到 QQ 的三条口径：
 *   ① **行首归属**：每条转发消息的第一行是 `【子会话 xxxx】`（xxxx=会话短 id）。
 *      它**短且在最前**是硬要求 —— QQ 入站引用块只带被引原文**前 60 字**（inbound 的 QUOTE_KEEP），
 *      归属跑出这 60 字就再也认不出来了（见下面的"引用回流"）。
 *   ② **markdown + 失败降级**：直接走 `sender.sendMarkdown(replyTarget, text)` ——
 *      插件自带的 markdown→纯文本降级链（`send_md` 工具用的就是它），失败再退回 `sender.sendText`。
 *   ③ **被动优先**：`replyTarget` 自带该会话最近的 `msgId`，带它发即"被动回复"
 *      （不吃主动配额、QQ 也不吞）；插件侧在被动失败时会自动去掉 msgId 转主动。
 *      ⚠️ 这两件事都在**插件**里做好了，本库直接用 `sender` + `replyTarget` 即可，不重复造。
 *
 * ★ 引用回流（主人 2026-10-12 明确口径：**靠行首会话信息判断，不依赖台账**）：
 *   群里有人**引用**那条转发消息时，入站引用块会把被引原文的前 60 字带进来，
 *   归属行就在里面 ⇒ 本库从入站 user 消息里正则认出 `【子会话 xxxx】`
 *   → 把这条引用的原文**插话**给对应子会话（忙时 inject、空闲 followup）。
 *   **不需要 QQ 的 msg_id**，也**不需要维护任何 msg_id→会话 的映射表**。
 *   短 id → 完整会话 id 是**当场**在会话注册表里查的（见 resolveShortId）。
 *
 * 本库只做三件事：挂监听、结算回灌/转发、认引用回流。
 *
 * ★ 2026-10-12 定案（主人）：回灌**模拟用户消息**（source.kind='user'）+ **唤醒**父会话（一档）。
 *   `followup` 就是 `inject` 的唤醒档（inject=next-step 不唤醒；followup=next-turn 唤醒），
 *   所以"注入 + 唤醒"用 followup。
 *   原因（实测结论）：`inject` 落 `agent/inbox/spliced **target=next-step**` —— 排队到下次组包、
 *   **不产生回合**，因此既没有 turn 触发节点、**UI 上也什么都没有**。
 *   而 `followup` 落 `target=next-turn` ⇒ 产生回合 ⇒ 被渲染成 `TurnTriggerNodeView`（那个「白框」）。
 *   代价：回灌会**唤醒父会话跑一轮**（烧 token），故正文里加了一行"无需回复"提示。
 *   → 三档（mode=3）要的是"进上下文但**不唤醒**"，所以那一档**强制走 inject**。
 *
 * ⚠️ 回灌消息的形状**必须**对齐宿主「子会话结算通知」（createSettlementMessage）：
 *   { id, role:'user', content:[摘要行, 结尾正文引导语, ...正文块],
 *     source:{ kind:'subagent-settled', form:'notice', summary, senderSessionId } }
 *
 * ⚠️ 注入前必须过 isInjectableMessage() 自检（fail-closed）。宿主的顺序是
 *   **先 append 落盘、后读 `msg.source.kind`**：形状不合法时坏记录已经写进
 *   `agent/inbox/spliced.data.inserted[]`，之后投影抛错 —— 会话文件从此无法加载。
 *   事故实例：会话 9643a885 的 seq 4222 曾被写成 `inserted: ["<字符串>"]`。
 *
 * 用法：
 *   import { register } from './lib/session_watch_lib.mjs';
 *   await register(root, { parentAgentId, childSessionId, label, mode, sender, replyTarget });
 */
/**
 * 版本标记：供调用方打印，用来确认**热刷后加载到的到底是哪一版**。
 * 改动本文件时顺手把这个号 +1（或换日期），排查"改了不生效"时一眼就能看出来。
 */
export const __LIB_VERSION__ = 'lib-v14-20261014-通用路由+扫盘解析+会话列表+父会话跟QQ对象走+二档路由隔绝';

// ── ★ 2026-10-13 持久化改造（主人指示：**以本地存档为准，别只靠内存**）──────────────
//   本文件的风格是"用到时动态 import"；这里用**顶层 await** 一次性取到同步版 fs，
//   后面的 ensureLoaded()（同步读存档）才能被同步函数（如 listWatching）直接调用。
const { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

/**
 * 盯梢名单。**放在 globalThis 上**，不是模块局部变量。
 *
 * 原因：`tools/lib/` 的 import 带了 `?v=<mtime>` 版本号（为让热刷生效），
 * 于是每改一次本文件就会产生一个**新的模块实例**。若名单是模块局部的，
 * 改一次 lib 就把已登记的盯梢对象全丢了。放 globalThis 上跨实例共享。
 */
const WATCHING_KEY = Symbol.for('dsh-qqbot.session-watch.watching');
/**
 * ★ 2026-10-13：**扩展工具侧注入的 sender/replyTarget**（跨模块实例共享）。
 *   工具 env 里**一定有**这两样（扩展工具 env = `{cwd, manager, sender, replyTarget, exec, ctx, logger}`），
 *   而插件根 ctx（handler 拿到的 root）上实测**拿不到** sender ⇒ 单靠 root 补不回 QQ 转发。
 *   所以让扩展工具每次被调用时顺手写进来，handler 侧再读它去补 fwd。
 */
const FWD_KEY = Symbol.for('dsh-qqbot.session-watch.fwd');

/**
 * 供扩展工具调用：把本次 env 的 sender/replyTarget 交给回灌库。
 * 调一次之后，回灌库在"父会话发言"时就能把 QQ 转发能力补回来（重启后尤其需要）。
 * @returns {boolean} 是否记住
 */
export function rememberFwd(sender, replyTarget) {
  try {
    if (sender && replyTarget) {
      globalThis[FWD_KEY] = { sender, replyTarget };
      return true;
    }
    return false;
  } catch { return false; }
}
const watching = (globalThis[WATCHING_KEY] ??= new Map()); // childSessionId -> entry

/**
 * ★★ 2026-10-14：**父会话跟着「QQ 对象」走**（主人定：绑的应该是 QQ 对象，不是那一刻的会话 id）
 *
 * 病根：原来 `parentAgentId` 是绑定时写死的 session id，回灌直接 `agents.get(那个 id)`。
 *   在 QQ 里发 `/bot-new` 会**新开一个会话**（新 id），名单里那条记录却还指着旧会话
 *   ⇒ 回灌继续落进旧会话；而"转发到 QQ"那一路用的是 openid、照旧正常 ⇒ 表面上完全看不出错。
 *
 * 修法（不需要插件内部 API）：记一张 `peerKey = scope:peerId`（QQ 对象）→ **最近一次为该对象发言的
 *   会话 id** 的表；回灌前先按 peerKey 取最新会话，取不到才回落到写死的旧 id。
 *   `/bot-new` 之后该对象的下一条消息必然落到新会话 ⇒ 这张表立刻学到新 id ⇒ 回灌自动跟过去。
 *
 * 自愈：老记录（没有 peerKey）在"它的父会话下一次发言"时自动补上 peerKey —— 与 fwd 补回同一套路数。
 */
const PEER_KEY = Symbol.for('dsh-qqbot.session-watch.peerLatest');
const peerLatest = (globalThis[PEER_KEY] ??= new Map()); // peerKey -> sessionId

/** 从**会话对象**里取 QQ 对象键（scope:peerId）。刻意不用 `o.id` —— 那是会话 id，不是 peer */
function peerKeyOfSession(s) {
  try {
    if (!s) return '';
    const peerId = String(s.peerId ?? s.groupOpenid ?? s.groupId ?? '');
    if (!peerId) return '';
    const scope = String(s.scope ?? s.peerScope ?? '') || 'group';
    return scope + ':' + peerId;
  } catch { return ''; }
}

/** 从 **replyTarget / peer 视图**里取 QQ 对象键 */
function peerKeyOfTarget(rt) {
  try {
    if (!rt) return '';
    const id = String(rt.peerId ?? rt.targetId ?? rt.groupOpenid ?? rt.openid ?? rt.groupId ?? rt.id ?? '');
    if (!id) return '';
    const scope = String(rt.scope ?? rt.kind ?? '') || 'group';
    return scope + ':' + id;
  } catch { return ''; }
}

/** 学到"这个 QQ 对象最近在哪个会话里说话"，顺手给老盯梢补 peerKey（自愈） */
export function notePeerSeen(session, sid) {
  try {
    const pk = peerKeyOfSession(session);
    if (!pk || !sid) return false;
    let changed = peerLatest.get(pk) !== sid;
    if (changed) peerLatest.set(pk, sid);
    for (const w of watching.values()) {
      if (!w.peerKey && w.parentAgentId === sid) { w.peerKey = pk; changed = true; }
    }
    if (changed) void persist();   // 落盘失败静默，不影响监听
    return changed;
  } catch { return false; }
}

/** 回灌该投给谁：优先"该 QQ 对象当前所在的会话"，其次绑定时写死的父会话（老行为） */
function resolveParentId(w) {
  try {
    const pk = String(w?.peerKey ?? '');
    const latest = pk ? String(peerLatest.get(pk) ?? '') : '';
    return latest || String(w?.parentAgentId ?? '');
  } catch { return String(w?.parentAgentId ?? ''); }
}

/**
 * 默认存档路径：`{dataRoot}/.qqbot-extensions/tools/data/session-watch-watching.json`
 * （**与 `vote.json` 同一个 data 目录** —— 对齐既有约定：扩展各类的存档都放
 *   `{数据根}/.qqbot-extensions/<类型>/data/<名字>.json`）。
 * 本文件在 `.../tools/lib/` ⇒ `../data/` 正好是 `tools/data/`。
 * 为什么要兜底：`setStateFile()` 此前**全项目无人调用** ⇒ `stateFileOf()` 恒为 '' ⇒
 *   `persist()` 里 `if (!file) return` 直接空转 ⇒ **名单从来没落过盘**（重启自然恢复不了）。
 */
const DEFAULT_STATE_FILE = (() => {
  try { return fileURLToPath(new URL('../data/session-watch-watching.json', import.meta.url)); }
  catch { return ''; }
})();

let loadedOnce = false;

/**
 * ★ 持久化读回（主人 2026-10-13 指示：**以本地存档为准，不要只靠内存**）。
 * 幂等：只从文件读一次；此后内存是运行期缓存，所有写操作都会 persist() 回文件。
 * 同步实现 ⇒ 可被 listWatching() / handler() 这类同步路径直接调用。
 * @returns 读回后内存里的条目数
 */
export function ensureLoaded() {
  if (loadedOnce) return watching.size;
  loadedOnce = true;
  try {
    const file = stateFileOf();
    if (!file) return watching.size;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const rows = Array.isArray(j?.rows) ? j.rows : [];
    // ★ 2026-10-14：读回"QQ 对象 → 最近发言会话"表（父会话跟着 QQ 对象走的依据）
    try { for (const [k, v] of Object.entries(j?.peers ?? {})) if (k && v) peerLatest.set(String(k), String(v)); } catch { /* ignore */ }
    for (const r of rows) {
      const child = String(r?.child ?? '').trim();
      const parent = String(r?.parent ?? '').trim();
      if (!child || !parent) continue;
      if (watching.has(child)) continue;
      watching.set(child, {
        parentAgentId: parent,
        label: String(r?.label ?? ''),
        mode: Number(r?.mode) === 2 ? 2 : (Number(r?.mode) === 3 ? 3 : 1),
        shortId: shortSessionId(child),
        name: String(r?.name ?? r?.label ?? ''),
        preset: String(r?.preset ?? ''),
        workspace: String(r?.workspace ?? ''),
        peerName: String(r?.peerName ?? ''),
        peerKey: String(r?.peerKey ?? ''),
        // ⚠️ 重启后拿不到 sender/replyTarget ⇒ 先恢复"回灌父会话"，
        //    QQ 转发等下次 register（或主人重挂）时补上 ⇒ 这里如实置空、不假装就绪。
        fwd: null,
        lastText: '', texts: [], errors: [], seen: 0, firedAt: 0, lastForwarded: '',
      });
    }
  } catch { /* 读不到就当空名单 */ }
  return watching.size;
}

/**
 * ★ 启动恢复（给启动钩子用）：读回存档 + **重装监听器**。
 * 名单以文件为准；而监听器（`root.on('session/event')`）是内存态、重启必丢 ⇒ 只能靠这里重装。
 */
export async function rehydrate(root) {
  const n = ensureLoaded();
  try { installHook(root); } catch { /* 装不上就只恢复名单 */ }
  // ★ 2026-10-13：顺手把 QQ 转发能力也补上 —— 只要 `session_watch` 工具刚把 sender/replyTarget
  //   注入过（rememberFwd），这里就能立刻补回，**不必等父会话下一次发言**。
  let fwdFixed = 0;
  try {
    for (const [, w] of watching) if (hydrateFwd(w, root, null)) fwdFixed += 1;
  } catch { /* ignore */ }
  return { restored: n, hooked, fwdFixed };
}

/**
 * 盯梢名单落盘（2026-10-12 新增）。
 *
 * 为什么要：名单原本只在内存里，**dsh 一重启，之前 attach 的盯梢全没了**。
 * 落盘后由启动钩子（`.qqbot-extensions/hooks/`）在宿主启动时读回来重新登记 ——
 * 这正是主人要的"让用户写一些在运行 dsh 时启动的东西"的第一个用例。
 */
const STATE_KEY = Symbol.for('dsh-qqbot.session-watch.stateFile');
// ★ 兜底默认路径：没人调 setStateFile() 时也能落盘/读回（见上面 DEFAULT_STATE_FILE 的说明）
const stateFileOf = () => String(globalThis[STATE_KEY] || DEFAULT_STATE_FILE || '');

/** 记下状态文件路径（由 register 的调用方给；没给就不落盘） */
export function setStateFile(p) {
  try { globalThis[STATE_KEY] = String(p || ''); } catch { /* ignore */ }
}

/** 把当前名单落盘（静默失败：落不了盘只影响"重启后自动恢复"，不影响回灌本身） */
async function persist() {
  const file = stateFileOf();
  if (!file) return;
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(file), { recursive: true });
    const rows = [...watching.entries()].map(([child, w]) => ({
      child,
      parent: w.parentAgentId,
      label: w.label ?? '',
      name: w.name ?? '',
      preset: w.preset ?? '',
      workspace: w.workspace ?? '',
      mode: w.mode ?? 1,
      peerName: w.peerName ?? '',
      peerKey: w.peerKey ?? '',
    }));
    // ★ 2026-10-14：把"QQ 对象 → 最近发言会话"表一起落盘（父会话跟着 QQ 对象走的依据）
    const peers = {};
    for (const [k, v] of peerLatest.entries()) if (k && v) peers[k] = v;
    writeFileSync(file, JSON.stringify({ v: 1, at: Date.now(), rows, peers }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** 读回落盘的名单（给启动钩子用；返回原始行数组） */
export async function loadPersisted() {
  const file = stateFileOf();
  if (!file) return [];
  try {
    const { readFileSync } = await import('node:fs');
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(j?.rows) ? j.rows : [];
  } catch { return []; }
}

/** 回灌钩子总开关。false = 正常挂 `session/event` 监听。 */
const HOOK_DISABLED = false;

/** 监听只装一次（跨模块实例去重）；handler 指针让新实例能立刻接管旧监听。 */
const HOOK_KEY = Symbol.for('dsh-qqbot.session-watch.hook');
const HANDLER_KEY = Symbol.for('dsh-qqbot.session-watch.handler');
let hooked = false;

/**
 * turn/end 的 data.reason → 人话。
 * 口径来自 webui 的两条文案（dsh-client-ui-chat/lib/client.js）：
 *   "message.turnProcess.worked" = 已完成   ← 正常跑完
 *   "message.stopped"            = 已停止   ← 被停止/中断
 * 宿主在 index.js:912 把 event.data.reason 记进 inflight.endReason，webui 据此显示。
 */
function reasonText(reason) {
  const r = String(reason ?? '').toLowerCase();
  if (!r) return '结束';
  if (/stop|abort|cancel|interrupt|halt/.test(r)) return '已停止';
  if (/complet|done|finish|success|ok/.test(r)) return '已完成';
  if (/error|fail/.test(r)) return '出错';
  return r; // 未知取值就原样带出来，便于以后补映射
}

/**
 * `notice` 摘要行的长度上限，与宿主 `dsh-llm` 的 CONTEXT_SUMMARY_MAX_CHARS 保持一致。
 * 宿主原文注释：producer 的一行说明会写进持久日志，所以要限长。
 */
const CONTEXT_SUMMARY_MAX_CHARS = 120;

/** 把摘要行压到上限内（超出用省略号），口径照抄宿主 dsh-llm 的 boundContextSummary()。 */
function boundContextSummary(summary) {
  const t = String(summary ?? '');
  return t.length <= CONTEXT_SUMMARY_MAX_CHARS ? t : `${t.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * 取会话短 id 用于显示。
 * ⚠️ 子会话 id 形如 `session-f147236a-…`，直接 slice(0,8) 只会得到无意义的 `session-`。
 * 所以先剥掉 `session-` 前缀再截断。
 */
export function shortSessionId(id) {
  const s = String(id ?? '');
  return (s.startsWith('session-') ? s.slice(8) : s).slice(0, 8);
}

/**
 * 行首归属标记（2026-10-12 主人定：除了短 id，还要**会话名 / 预设名 / 工作区**）。
 *
 * ⚠️ 排版有硬约束：QQ 入站引用块只带被引原文**前 60 字**，而引用回流就靠这一行认路。
 *   所以顺序是**路由键打头、其余信息跟在后面** —— 即使后面被截掉，`【子会话 xxxx` 也稳稳留在前 15 字内。
 *   路由键后面的 `】` **不保证存在**（可能正好被截断），因此解析正则**不要求右括号**。
 *
 * 例：`【子会话 87c87c3b · 回灌转发自测 · standard · 鲸鱼娘】`（约 40 字，安全）
 */
export function ownerLine(parts) {
  const p = (typeof parts === 'string') ? { shortId: parts } : (parts ?? {});
  const seg = [`【子会话 ${String(p.shortId ?? '').slice(0, 8)}`];
  for (const v of [p.name, p.preset, p.workspace]) {
    const s = String(v ?? '').trim();
    if (s) seg.push(s.replace(/[·】\n]/g, ' ').slice(0, 24));   // 别让分隔符/换行混进来
  }
  return seg.join(' · ') + '】';
}

/**
 * 认出归属标记（引用回流的路由键）。
 * **故意不要求右括号** —— 引用块只带前 60 字，归属行尾可能被截掉。
 * 同时容忍中间的空格与全角/半角差异。
 */
const OWNER_RE = /【\s*子会话\s*([0-9a-fA-F]{4,12})/;

/** 从一段文本里抽归属短 id（找不到返回 ''） */
export function parseOwner(text) {
  const m = OWNER_RE.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 短 id → 完整会话 id。**当场查**，不依赖任何持久台账（主人 2026-10-12 明确口径）。
 * 会话注册表的 API 形状随版本变，这里逐种试，全部失败就返回 ''。
 */
// ── ★ 2026-10-14 主人需求：**通用路由**（正文里带会话 id ⇒ 投递到那个会话）─────────────
/**
 * 认两种写法（**不要求行首**，写在句子中间也认）：
 *   `[s:xxxxxxxx]`       ← 推荐；短 id（uuid 前 8 位）或完整 uuid 都行
 *   `【会话 xxxxxxxx】`   ← 兼容"直接复制模板再改"
 *
 * 与 `routeQuoteBack`（引用回流）的分工：
 *   · `routeQuoteBack` 只认 `【子会话 xxxx】`，且**必须是已盯梢条目的父会话在说话** —— 语义是"回"；
 *   · 本组函数认**任意 id**、**不需要绑定**、也不用先盯梢 —— 语义是"去"。
 */
// ★ 2026-11-18：**同时认全角方括号**。
//   插件 1.13.16 起把消息正文里"形似发送者标签"的方括号降级成全角（防提示词注入伪造），
//   `[s:6df40d2a]` 一度被一起转义成 `［s:6df40d2a］` ⇒ 路由永远匹配不到。
//   插件侧已把转义判定收窄（只转带 openid/群昵称/短号特征的），这里再放宽一层做双保险。
const ROUTE_RE = /(?:[\[［]s:|【\s*会话\s*)([0-9a-zA-Z][0-9a-zA-Z-]{2,63})\s*[\]］]?】?/;

/** 从正文里抽路由目标 key（返回 '' = 这不是一条路由消息） */
export function parseRouteKey(text) {
  const m = ROUTE_RE.exec(String(text ?? ''));
  return m ? m[1] : '';
}

/** 剥掉路由标记 —— 送进目标会话的是"去掉标记后的正文" */
export function stripRouteMark(text) {
  return String(text ?? '')
    .replace(new RegExp(ROUTE_RE.source, 'g'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** `~/.dsh/sessions` 根目录（Windows 用 USERPROFILE，其余用 HOME） */
function sessionsRootDir() {
  const home = String(process.env.USERPROFILE || process.env.HOME || '').trim();
  return home ? join(home, '.dsh', 'sessions') : '';
}

/**
 * **扫盘**把短 id 解析成完整会话 id —— **不依赖对方是否 live**（这是"任何已有会话"的关键）。
 * 目录形状：`~/.dsh/sessions/<工作区转义名>/<uuid>/`。
 * @returns {{id: string, workspace: string}} 找不到时 id 为 ''
 */
export function findSessionOnDisk(key) {
  const want = String(key ?? '').toLowerCase().trim();
  if (!want) return { id: '', workspace: '' };
  // 已经是完整 uuid ⇒ 直接认
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(want)) {
    return { id: want, workspace: '' };
  }
  if (want.length < 4) return { id: '', workspace: '' };
  const root = sessionsRootDir();
  if (!root) return { id: '', workspace: '' };
  try {
    for (const ws of readdirSync(root)) {
      let entries = [];
      try { entries = readdirSync(join(root, ws)); } catch { continue; }
      for (const d of entries) {
        const raw = String(d).toLowerCase();
        // ⚠️ 会话目录名**可能带前缀**（子会话是 `session-<uuid>`）⇒ 两边都过 shortSessionId 再比，
        //    否则像 `cf871e99` 这种短 id 会解析失败（本轮实测踩到）。
        const sh = shortSessionId(String(d)).toLowerCase();
        if (sh.startsWith(want) || raw.startsWith(want)) return { id: String(d), workspace: String(ws) };
      }
    }
  } catch { /* ignore */ }
  return { id: '', workspace: '' };
}

/**
 * 列会话目录（按 mtime 从新到旧）—— 给「/会话列表」命令用。
 * @param {string} [workspaceDir] 传了就只列该工作区；不传列全部
 */
export function listSessionDirs(workspaceDir) {
  const root = sessionsRootDir();
  if (!root) return [];
  const out = [];
  const pushWs = (ws) => {
    const wsDir = join(root, ws);
    let entries = [];
    try { entries = readdirSync(wsDir); } catch { return; }
    for (const d of entries) {
      const dir = join(wsDir, d);
      let mtime = 0;
      try { mtime = statSync(dir).mtimeMs; } catch { /* ignore */ }
      out.push({ id: String(d), short: shortSessionId(String(d)), workspace: String(ws), mtime });
    }
  };
  try {
    if (workspaceDir) pushWs(workspaceDir);
    else for (const ws of readdirSync(root)) pushWs(ws);
  } catch { /* ignore */ }
  return out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

/** 列出 `~/.dsh/sessions` 下的工作区转义目录名（给向导第一步用） */
export function listWorkspaceDirs() {
  const root = sessionsRootDir();
  if (!root) return [];
  try { return readdirSync(root).filter((d) => !String(d).startsWith('.')); } catch { return []; }
}

export function resolveShortId(root, short) {
  const want = String(short ?? '').toLowerCase();
  if (!want) return '';
  const hit = (id) => {
    const s = String(id ?? '');
    return s && shortSessionId(s).toLowerCase().startsWith(want) ? s : '';
  };
  try {
    // ① 最快的一条：agents 服务上按 id 前缀找（若提供了 list）
    const svc = (k) => { try { return root?.get?.(k); } catch { return undefined; } };
    for (const key of ['sessions', 'agents']) {
      const s = svc(key);
      if (!s) continue;
      const bags = [];
      if (typeof s.list === 'function') { try { bags.push(s.list()); } catch { /* ignore */ } }
      if (typeof s.values === 'function') { try { bags.push([...s.values()]); } catch { /* ignore */ } }
      if (typeof s.all === 'function') { try { bags.push(s.all()); } catch { /* ignore */ } }
      if (Array.isArray(s)) bags.push(s);
      for (const bag of bags) {
        const arr = Array.isArray(bag) ? bag : (bag && typeof bag === 'object' ? Object.values(bag) : []);
        for (const it of arr) {
          const id = String(it?.id ?? it?.sessionId ?? it ?? '');
          const got = hit(id);
          if (got) return got;
        }
      }
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * 把 `turn/end` 的 reason 归一成字符串。
 *
 * ⚠️ 2026-10-12 实测：`event.data.reason` **不是字符串而是对象**，形如
 *   `{kind:'completed'}` 或 `{kind:'aborted', reason:{kind:'user'}}`。
 * 旧代码直接 `String(reason)` ⇒ 摘要行里出现 `回合[object object]（reason=[object Object]）`。
 * 本函数优先取最外层的 `kind`，没有就下钻内层 `reason`，都不是才退回 String()。
 */
export function reasonKind(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.kind === 'string' && value.kind) return value.kind;
    if (value.reason !== undefined && value.reason !== value) return reasonKind(value.reason);
    if (typeof value.status === 'string' && value.status) return value.status;
    if (typeof value.stopReason === 'string' && value.stopReason) return value.stopReason;
  }
  return String(value);
}

/**
 * 把各种可能的 content 形状压成纯文本。
 *
 * ★ 2026-10-12 修（主人实测）：**只取 `type === 'text'` 的正文块**。
 *   早先的过滤条件是 `x.type === 'text' || typeof x.text === 'string'` ——
 *   而 **reasoning（思考）块同样带 `.text` 字符串**，于是思考被一起并进来，
 *   回灌的"结尾正文"里冒出一整段英文思考（子会话 3bee83ac 那次实测）。
 *   reasoning / tool-call 等块一律丢弃。
 */
function asText(c) {
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
      .map((x) => String(x.text))
      .join('\n')
      .trim();
  }
  if (c && typeof c === 'object') {
    if (c.type === 'reasoning') return '';          // 思考块不算正文
    if (typeof c.text === 'string') return String(c.text).trim();
    if (Array.isArray(c.blocks)) return asText(c.blocks);  // 有些版本正文藏在 blocks 里
  }
  return '';
}

/** 从事件里尽力抽正文（assistant/message 的形状随版本变，逐层试） */
function textOf(ev) {
  const cands = [
    ev?.data?.message?.content,
    ev?.data?.content,
    ev?.message?.content,
    ev?.data?.text,
    ev?.text,
    ev?.data?.message?.text,
  ];
  for (const c of cands) {
    const t = asText(c);
    if (t) return t;
  }
  return '';
}

/** 兜底：直接从会话实例取"最后一条助手消息"的正文 */
function lastAssistantText(root, sid) {
  try {
    const sess = root.get('sessions')?.get?.(sid);
    const msgs = sess?.deriveMessages?.() ?? [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      const role = String(m?.role ?? m?.type ?? '');
      if (role.includes('assistant')) {
        const t = asText(m?.content);
        if (t) return t;
      }
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * 注入前的形状自检（fail-closed）。
 *
 * 复刻宿主 v4 的准入条件（dsh-session-persistence-jsonl/lib/worker.cjs）：
 *   ① `agent/inbox/spliced` 的 `inserted[]` 每项必须 `isSessionFormatJsonObject`；
 *   ② 每项的 `source` 必须是对象、`kind` 为非空字符串、且 !== 'plugin'
 *      （源码原文：`format v4 message requires a producer-owned source kind`）。
 *
 * 为什么必须自检而不是交给 inject()：宿主是**先 append 落盘、后读 source.kind** 的顺序。
 * 传进非对象时，坏记录已经写进 `inserted[]`，之后投影抛错 —— 文件从此无法加载。
 * 事故实例：会话 9643a885 的 seq 4222 被写成 `inserted: ["<字符串>"]`，整个会话读不出来。
 */
export function isInjectableMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  if (typeof m.role !== 'string' || !m.role) return false;
  if (!Array.isArray(m.content) || m.content.length === 0) return false;
  const src = m.source;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return false;
  if (typeof src.kind !== 'string' || !src.kind || src.kind === 'plugin') return false;
  return true;
}

/** 造一条纯文本 user 消息（供 inject / followup 用；形状已过 isInjectableMessage） */
function userText(text) {
  return {
    id: (globalThis.crypto?.randomUUID?.() ?? ('inj-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8))),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'user' },
  };
}

/**
 * 构造一条「子会话结算通知」形状的回灌消息（纯函数，便于单测）。
 *
 * 形状**对齐宿主** dsh-subagent/lib/index.js 的 `createSettlementMessage()`：
 *   source : { kind:'subagent-settled', form:'notice', summary, senderSessionId }
 *   content: [ 摘要行, 结尾正文引导语, ...正文块 ]，role 由 createUserMessage 固定为 'user'
 *
 * 采用宿主形状的三个理由：
 *   ① kind 是宿主自有的 producer-owned 值，不再冒充真人 user 发言；
 *   ② senderSessionId 明确归属到具体子会话，UI 侧归进**子任务**那条通道而不是混进
 *      用户真实发言流里 —— 这与上一轮「回灌插错位置」是同一类隐患；
 *   ③ summary 与宿主同口径（dsh-llm CONTEXT_SUMMARY_MAX_CHARS = 120）。
 *
 * @param {{sessionId?: string, label?: string, rawReason?: string, text?: string}} input
 * @returns 可直接交给 agent.inject() 的完整消息对象
 */
export function buildSettlementNotice(input = {}) {
  const sid = String(input.sessionId ?? '');
  const label = String(input.label ?? '');
  const rawReason = String(input.rawReason ?? '');
  const stage = reasonText(rawReason);
  const summary = boundContextSummary(
    `子会话${label ? '「' + label + '」' : ''} ${shortSessionId(sid)}… 回合${stage}` +
    `${rawReason && rawReason !== stage ? '（reason=' + rawReason + '）' : ''}`,
  );
  return {
    id: (globalThis.crypto?.randomUUID?.() ?? ('inj-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8))),
    role: 'user',
    content: [
      // ★ 主人 2026-10-12 定：模拟用户消息的**首行直接给出源会话 id**（完整 id）。
      { type: 'text', text: '【来自会话 ' + sid + '】' },
      { type: 'text', text: summary },
      { type: 'text', text: '它的结尾正文：' },
      { type: 'text', text: String(input.text ?? '') },
      { type: 'text', text: '（这是子会话的自动回灌，父会话无需回复。）' },
    ],
    // ★ 2026-10-12 主人定案：回灌**一律模拟用户消息**（source.kind='user'），
    //   不再伪装成子会话结算通知 / 系统消息 / 开发者消息。
    source: { kind: 'user' },
  };
}

// ─────────────────────────── 转发到 QQ ───────────────────────────

/**
 * 往「父会话所在的 QQ」发一条消息。
 *
 * 链路（**全部复用插件已有的能力**，本库不自己重写降级/被动逻辑）：
 *   · `sender.sendMarkdown(replyTarget, text)` —— replyTarget 自带最近 msgId ⇒ 被动回复；
 *     插件的 sendMarkdown 自带 markdown → 纯文本的降级链。
 *   · 失败再退 `sender.sendText(replyTarget, text)`（纯文本兜底）。
 *
 * @returns 人话结果（'' = 没配 sender，静默不发）
 */
async function forwardToQq(entry, text) {
  const fwd = entry?.fwd;
  const body = String(text ?? '').trim();
  // ★ 2026-10-15：**不再静默**。之前三个条件任一不满足就 `return ''`，日志里一个字都没有，
  //   "重启后那段时间子会话内容悄悄没转发"因此无从定位（主人实测踩到）。
  if (!fwd?.sender || !fwd?.replyTarget || !body) {
    void swDiag('forward-skip short=' + String(entry?.shortId ?? '?')
      + ' fwd=' + (fwd ? 'obj' : String(fwd))
      + ' sender=' + !!fwd?.sender + ' replyTarget=' + !!fwd?.replyTarget
      + ' bodyLen=' + body.length);
    return '';
  }
  const target = fwd.replyTarget;

  /**
   * ★★ 2026-10-15：**摘掉 msgId 的"主动版" target** ★★
   *   实测真凶：`fwd.replyTarget` 里钉着**绑定那一刻的 msgId**（为走"被动回复"），
   *   而 QQ 的被动回复 **msg_id 会过期** ⇒ 老盯梢（如 bee798c0）发送时报
   *   `API Error: 回复消息msg_id已过期`，markdown/纯文本两条降级链**都**因此失败，
   *   内容静默丢失。新建的盯梢 msgId 新鲜 ⇒ 正常。
   *   ⇒ 发送失败时摘掉 msgId 再发一次 = 转"主动发送"（会耗主动配额，但总比丢消息好）。
   */
  const activeTarget = (() => {
    try {
      if (!target || typeof target !== 'object') return null;
      const t = { ...target };
      let touched = false;
      for (const k of ['msgId', 'msg_id', 'messageId', 'referenceMessageId']) {
        if (k in t) { delete t[k]; touched = true; }
      }
      return touched ? t : null;
    } catch { return null; }
  })();

  /**
   * ★ 2026-10-15 主人定：**同一 msgId 用满 4 条就直接转主动**（不等它失败）。
   *   被动回复有两条硬限制：①同一 msg_id 最多 ~4-5 条；②msg_id 会过期。
   *   插件的 outbound.ts 对"AI 正文"有 ADAPTIVE_MAX_PASSIVE=5 的同类计数，但**转发这条路没有**，
   *   所以这里自己数：同一 msgId 发到第 4 条起就摘掉它走主动。
   */
  const _midOf = (t) => String(t?.msgId ?? t?.msg_id ?? t?.messageId ?? '');
  const passiveMid = _midOf(target);
  const counts = (entry.__fwdPassiveCounts ??= new Map());
  const used = passiveMid ? (counts.get(passiveMid) ?? 0) : 0;
  const PASSIVE_LIMIT = 4;
  const skipPassive = !passiveMid || used >= PASSIVE_LIMIT;
  if (skipPassive) {
    void swDiag('forward-passive-skip short=' + String(entry?.shortId ?? '?')
      + ' mid=' + (passiveMid ? passiveMid.slice(0, 12) : '-') + ' used=' + used);
  }

  const trySend = async (tg) => {
    try {
      if (typeof fwd.sender.sendMarkdown === 'function') {
        await fwd.sender.sendMarkdown(tg, body);
        return 'md';
      }
    } catch (e) {
      const em = String(e?.message ?? e);
      try {
        if (typeof fwd.sender.sendText === 'function') {
          await fwd.sender.sendText(tg, body);
          return 'text';
        }
      } catch (e2) { throw new Error(em + ' | text:' + String(e2?.message ?? e2)); }
      throw new Error(em);
    }
    try {
      if (typeof fwd.sender.sendText === 'function') {
        await fwd.sender.sendText(tg, body);
        return 'text';
      }
    } catch (e) { throw new Error(String(e?.message ?? e)); }
    return '';
  };

  // ① 先按原样（被动回复，省主动配额）
  try {
    // ★ 同一 msgId 用满 4 条 ⇒ 直接跳过被动、走下面的主动分支（不再等它失败）
    if (skipPassive) throw new Error('skip-passive: mid=' + (passiveMid || '-') + ' used=' + used);
    const how = await trySend(target);
    if (how) {
      if (passiveMid) counts.set(passiveMid, used + 1);
      void swDiag('forward-ok(' + how + ') short=' + String(entry?.shortId ?? '?') + ' len=' + body.length
        + ' passive=' + (passiveMid ? passiveMid.slice(0, 12) + '#' + (used + 1) : '-'));
      return how;
    }
  } catch (e1) {
    void swDiag('forward-passive-fail short=' + String(entry?.shortId ?? '?')
      + ' err=' + String(e1?.message ?? e1));
    // ② 失败 ⇒ 摘掉 msgId 重发（主动）。这是"msg_id 过期"的正解。
    if (activeTarget) {
      try {
        const how2 = await trySend(activeTarget);
        if (how2) {
          void swDiag('forward-ok-active(' + how2 + ') short=' + String(entry?.shortId ?? '?')
            + ' len=' + body.length + '（被动失败后转主动）');
          return how2 + '-active';
        }
      } catch (e2) {
        void swDiag('forward-active-fail short=' + String(entry?.shortId ?? '?')
          + ' err=' + String(e2?.message ?? e2));
      }
    } else {
      void swDiag('forward-active-skip short=' + String(entry?.shortId ?? '?')
        + '（target 上没有 msgId 可摘，或 target 形状异常）');
    }
  }
  void swDiag('forward-fail short=' + String(entry?.shortId ?? '?') + ' senderKeys='
    + (fwd?.sender ? Object.keys(fwd.sender).slice(0, 10).join(',') : '-'));
  return '';
}

/**
 * ★ 2026-10-15：诊断**落盘**。route-isolate 文件头留过教训：
 *   "一开始只往 logger 写，而**从来没人注入过 logger** ⇒ 真机上完全静默、无法定位。"
 *   本库涉及"转发到 QQ"，静默一次就是一条内容永久丢失，必须能事后追。
 */
// ★ 2026-10-24 修复（issue #17）: 原来写死 Windows 路径(D:/…) —— Linux/容器/手机上会被当成
//   相对路径，在家目录里生成一个叫 "D:" 的畸形目录，日志全丢。改成跟着本文件走。
const SW_DIAG_FILE = fileURLToPath(new URL('../../data/session-watch-diag.log', import.meta.url));

async function swDiag(line) {
  try {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(SW_DIAG_FILE), { recursive: true });
    await appendFile(SW_DIAG_FILE, new Date().toISOString() + ' ' + line + '\n');
  } catch { /* 诊断失败不影响主链 */ }
}

/**
 * 转发到 QQ 之前，把「只给插件自己看的标记」洗掉（主人 2026-10-12 要求："剥掉 @"）。
 *
 * 为什么必须洗：子会话继承的是同一个人设，所以它写正文时会带上本插件的出站约定标记。
 * 而我们是用 `sender.sendMarkdown()` **直发**的，插件那层出站解析并不参与 ⇒ 这些标记会
 * 原样变成裸文本出现在群里。实测踩到的两条：
 *   · `[rf:1012ad]`  —— 引用标记，本来是给插件出站解析用的，转发后就是一行看不懂的裸文本；
 *   · `<@E9020753…>` —— **QQ 提及语法，会真的在群里 @ 到人**（子会话回主人一句就被 @ 一下）。
 * 只洗这三类，别的（正文、换行、markdown）一律不动。
 */
export function sanitizeForQq(text) {
  return String(text ?? '')
    .replace(/\[\s*rf\s*:[^\]]*\]/gi, '')      // [rf:1012ad] 引用标记
    .replace(/<@[^>\s]{2,}>/g, '')             // <@openid> 提及语法（会真 @ 到人）
    .replace(/^\s*@[^\s@]{1,24}\s+/gm, '')     // 行首零散的 @某人（只吃行首那一下）
    .replace(/[ \t]{2,}/g, ' ')                // 洗掉留下的多余空格
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 给转发消息套上行首归属（**路由键在最前**，会话名/预设/工作区跟在后面，引用回流就靠它认路） */
function withOwner(entry, text) {
  return ownerLine({
    shortId: entry?.shortId,
    name: entry?.name,
    preset: entry?.preset,
    workspace: entry?.workspace,
  }) + '\n' + sanitizeForQq(text);
}

// ─────────────────────────── 事件处理 ───────────────────────────

/** 该会话是不是某个盯梢对象的父会话（引用回流只从父会话的入站消息里认） */
function parentEntryOf(sid) {
  for (const [, w] of watching) if (w.parentAgentId === sid) return w;
  return null;
}

/**
 * 引用回流：入站消息里认出 `【子会话 xxxx】` → 把这段引用**插话**给对应子会话。
 *
 * 主人 2026-10-12 口径：**只靠行首的会话信息判断，不依赖台账**。
 * 短 id → 完整 id 用 resolveShortId 当场查；查不到就静默放弃（绝不猜）。
 */
/**
 * ★ 2026-10-14 主人需求：**通用路由** —— 把群里这条消息投递给"正文里点名的那个会话"。
 *
 * 流程：解析 key → 找会话（**先 live、后扫盘**）→ 投递（忙 `inject` 插话 / 闲 `followup` 唤醒）。
 * 与 `routeQuoteBack` 的区别：**不限"已盯梢"、不限"父会话在说话"、认任意 id**。
 *
 * ★ 附件（2026-10-14 补）：QQ 里**引用图片/文件**时，图**不在正文里** —— 它在入站事件的
 *   `attachments`（`{contentType,url,filename,asrText}`，见插件 `transport/inbound.ts`）。
 *   只取文本会把图丢掉，所以这里额外把附件 URL/语音转写一并拼进载荷。
 * @returns {Promise<{ok: boolean, reason: string, id?: string, workspace?: string, atts?: number}>}
 */
/**
 * ★ 对外导出（2026-10-14）：入站扩展要**在钩子之前**自己投递 —— 因为"二档路由隔绝"会把这条消息
 * 在早挂点就 annihilate 掉，一旦消灭成功，`session/event` 的 `user/message` 就永远不会发生，
 * 原来那条投递路径（本文件里的监听器）根本不会跑。所以投递逻辑必须能被扩展直接调。
 */
export async function routeToSession(root, text, ev) {
  try {
    const key = parseRouteKey(text);
    if (!key) return { ok: false, reason: 'no-key' };
    const body = stripRouteMark(text);
    // ① 先问宿主（快，只认 live）
    let fullId = resolveShortId(root, key);
    let workspace = '';
    // ② live 查不到 ⇒ **扫盘**（"任何已有会话"就靠这一步）
    if (!fullId) {
      const disk = findSessionOnDisk(key);
      fullId = disk.id;
      workspace = disk.workspace;
    }
    if (!fullId) return { ok: false, reason: 'not-found', id: key };
    const agents = (() => { try { return root?.get?.('agents'); } catch { return null; } })();
    let target = (() => { try { return agents?.get?.(fullId) ?? null; } catch { return null; } })();
    // ③ 没活着 ⇒ 试着唤醒（宿主 agents.resume；拿不到就算了，绝不硬造 agent）
    if (!target && agents && typeof agents.resume === 'function') {
      try { target = await agents.resume(fullId); } catch { /* ignore */ }
    }
    if (!target) return { ok: false, reason: 'not-live', id: fullId, workspace };
    // ④ 附件（图片/文件的 URL、语音转写）—— 引用图片时图就在这里
    const atts = attachmentsOf(ev);
    if (!body && !atts.length) return { ok: false, reason: 'empty-body', id: fullId, workspace };
    const lines = ['【群里有人把这条消息路由给你】'];
    if (body) lines.push(body);
    if (atts.length) {
      lines.push('');
      lines.push('（随消息一起来的附件：）');
      for (const a of atts) {
        const kind = String(a?.contentType ?? '');
        const url = String(a?.url ?? '');
        const name = String(a?.filename ?? '');
        const asr = String(a?.asrText ?? '');
        const tag = /image/i.test(kind) ? '图片' : (/video/i.test(kind) ? '视频' : (/audio|voice/i.test(kind) ? '语音' : (/file|application/i.test(kind) ? '文件' : '附件')));
        let line = `- ${tag}`;
        if (name) line += `：${name}`;
        if (url) line += `\n  ${url}`;
        if (asr) line += `\n  （语音转写）${asr}`;
        lines.push(line);
      }
    }
    lines.push('（这是跨会话路由，按需回应即可。）');
    const msg = userText(lines.join('\n'));
    if (!isInjectableMessage(msg)) return { ok: false, reason: 'bad-shape', id: fullId, workspace };
    const busy = (() => {
      try {
        const st = String(target.status ?? target.phase ?? '');
        return st !== '' && st !== 'idle';
      } catch { return false; }
    })();
    if (busy) await target.inject(msg);
    else await target.followup(msg);
    return { ok: true, reason: busy ? 'inject' : 'followup', id: fullId, workspace, atts: atts.length };
  } catch (e) {
    return { ok: false, reason: 'error:' + (e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * 从入站事件里挖附件（多路兜底，形状照插件 `transport/inbound.ts` 的 `RawAttachment`）。
 * 只保留有 url / asrText 的项，避免塞一堆空对象过去。
 */
export function attachmentsOf(ev) {
  const cands = [
    ev?.data?.message?.attachments,
    ev?.data?.attachments,
    ev?.message?.attachments,
    ev?.attachments,
  ];
  for (const c of cands) {
    if (!Array.isArray(c) || c.length === 0) continue;
    const out = [];
    for (const a of c) {
      if (!a || typeof a !== 'object') continue;
      const url = String(a.url ?? a.URL ?? '').trim();
      const asr = String(a.asrText ?? a.asr_text ?? '').trim();
      if (!url && !asr) continue;
      out.push({
        contentType: String(a.contentType ?? a.content_type ?? ''),
        url,
        filename: String(a.filename ?? a.fileName ?? ''),
        asrText: asr,
      });
    }
    if (out.length) return out;
  }
  return [];
}

async function routeQuoteBack(root, inboundText) {
  const short = parseOwner(inboundText);
  if (!short) return;
  const childId = resolveShortId(root, short);
  if (!childId) return;
  const agents = root.get('agents');
  const child = agents?.get?.(childId) ?? null;
  if (!child) return; // 子会话不在（不 live）→ 静默跳过
  const payload =
    '【群里有人引用了你发到 QQ 的那段输出】\n' +
    String(inboundText ?? '').trim() +
    '\n（这是群里的引用互动，按需回应即可。）';
  const msg = userText(payload);
  if (!isInjectableMessage(msg)) return;
  try {
    const busy = (() => {
      try {
        const st = String(child.status ?? child.phase ?? '');
        return st !== '' && st !== 'idle';
      } catch { return false; }
    })();
    if (busy) await child.inject(msg);      // 忙 → 插话（不唤醒、不排队）
    else await child.followup(msg);         // 空闲 → 唤醒它来处理
    const w = watching.get(childId);
    if (w) w.quotedAt = Date.now();
  } catch { /* 监听里绝不抛 */ }
}

/**
 * ★ 2026-10-13 补：**重启后把 QQ 转发能力补回来**。
 *
 * 背景：`fwd`（sender + replyTarget）**不可序列化**（sender 是 live 的 bot 对象），
 *   所以启动恢复的名单里 `fwd` 只能是 null。现象就是"一个根因、两个症状"：
 *     · 回灌照常进父会话，但 **不再转发到 QQ**；
 *     · 群里因此没有那条带「【子会话 xxxx】」行首的转发消息 ⇒ **引用回流也认不到路**（OWNER_RE 匹配不上）。
 *
 * 修法：**父会话一发言**（user/message 事件）就把 fwd 补回来 —— sender 取插件的 bot，
 *   replyTarget 从 session / root 上尽力凑。补上后当场可用；下次重启会再丢，但父会话一说话又补上，
 *   因此只在"父会话长期静默"时转发会缺，实际影响很小。
 * @returns {boolean} 是否可用
 */
function hydrateFwd(entry, root, session) {
  try {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.fwd?.sender && entry.fwd?.replyTarget) return true;
    // ★ 2026-10-13：**优先用"扩展工具侧注入"的 sender/replyTarget** —— 工具 env 里一定有这两样
    //   （`session_watch.mjs` 每次被调用都会把它们挂到 globalThis[FWD_KEY]）。
    //   实测 `root`（插件根 ctx）上拿不到 sender ⇒ 只靠 root 是补不回来的。
    const injected = globalThis[FWD_KEY] ?? null;
    const sender = injected?.sender ?? (root && (root.bot ?? root.sender)) ?? null;
    const s = session ?? {};
    const scope = String(s.scope ?? s.peerScope ?? '') || (s.peerId ? 'group' : '');
    const peerId = String(s.peerId ?? s.peer ?? s.groupOpenid ?? '');
    const replyTarget =
      injected?.replyTarget ??
      s.replyTarget ??
      (root && (root.replyTarget ?? root.lastReplyTarget)) ??
      (scope && peerId ? { scope, peerId } : null);
    if (!sender || !replyTarget) {
      try {
        root?.logger?.warn?.(
          `[ext-hook:session-watch] hydrateFwd 补不上：sender=${!!sender} replyTarget=${!!replyTarget}` +
          ` injected=${!!injected} rootKeys=[${root ? Object.keys(root).slice(0, 16).join(',') : '-'}]` +
          ` sessionKeys=[${Object.keys(s).slice(0, 16).join(',')}]`,
        );
      } catch { /* ignore */ }
      return false;
    }
    entry.fwd = { sender, replyTarget };
    try { root?.logger?.info?.('[ext-hook:session-watch] 已补回 QQ 转发能力（sender + replyTarget）'); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

async function handler(root, session, event) {
  try {
    const sid = String(session?.id ?? session?.sessionId ?? '');
    if (!sid) return;
    const type = String(event?.type ?? '');

    // ── 引用回流：只关心**入站 user 消息**，且只在"某个盯梢对象的父会话"里认 ──
    if (type === 'user/message') {
      // ★ 2026-10-14：先学"这个 QQ 对象最近在哪个会话说话"（父会话跟着 QQ 对象走的依据）。
      //   必须放在路由分支**之前** —— 否则主人只发路由消息时，这张表永远学不到东西。
      notePeerSeen(session, sid);
      const t = textOf(event);
      // ★ 2026-10-14：**通用路由优先** —— 正文里出现会话 id（`[s:xxx]` / `【会话 xxx】`）就直接投给
      //   那个会话。**不限已盯梢、不限是不是父会话**（主人要的"任何已有会话都能被点名"）。
      if (t && parseRouteKey(t)) {
        const r = await routeToSession(root, t, event);
        try {
          root?.logger?.info?.(
            `[ext-hook:session-watch] 路由 ${r.ok ? '✅' : '✗'} ${r.reason}` +
            (r.id ? ` → ${shortSessionId(r.id)}…${r.workspace ? `(${r.workspace})` : ''}` : '') +
            (r.atts ? ` 附件${r.atts}个` : ''),
          );
        } catch { /* ignore */ }
        return;
      }
      const pe = parentEntryOf(sid);
      if (pe) {
        // ★ 2026-10-13：父会话一发言，就把重启后丢失的 QQ 转发能力补回来。
        //   转发一断，群里就没有带「【子会话 xxxx】」行首的转发消息 ⇒ 引用回流也认不到路。
        hydrateFwd(pe, root, session);
        if (t && OWNER_RE.test(t)) await routeQuoteBack(root, t);
      }
      return;
    }

    const w = watching.get(sid);
    if (!w) return;

    // 累积（对应 qqbot 的 noteGenerated）
    if (type === 'assistant/message') {
      const t = textOf(event);
      if (t) {
        w.lastText = t;
        // 二/三档要"所有正文"：按块收，重复的丢弃
        if (Array.isArray(w.texts)) { if (w.texts[w.texts.length - 1] !== t) w.texts.push(t); }
      }
      return;
    }
    // 报错也收（二/三档要一起转发）
    if (/error/i.test(type)) {
      const t = textOf(event) || String(event?.data?.message ?? event?.message ?? '').trim();
      if (t && Array.isArray(w.errors)) w.errors.push(t);
      return;
    }
    if (type !== 'turn/end') return;

    // 结算：优先用累积到的那一段；没有再从会话实例兜底取
    let text = w.lastText;
    w.lastText = ''; // ★ 取走即清空：否则"只有工具调用、没有正文"的回合会重复回灌上一回合的正文
    if (!text) text = lastAssistantText(root, sid);
    w.seen = (w.seen ?? 0) + 1;
    const rawReason = reasonKind(event?.data?.reason ?? event?.data?.status ?? event?.data?.stopReason);
    w.lastReason = rawReason;

    // 本回合收集物（二/三档用），取走即清
    const allTexts = Array.isArray(w.texts) ? w.texts.slice() : [];
    const errors = Array.isArray(w.errors) ? w.errors.slice() : [];
    w.texts = [];
    w.errors = [];
    const mode = Number(w.mode) === 2 ? 2 : (Number(w.mode) === 3 ? 3 : 1);

    // ★★ 2026-10-15：**每回合无条件落盘一行** ★★
    //   实测踩到：bee798c0 重启后"不转发"，而日志里连 forward-skip 都没有 ⇒ 说明它压根没
    //   走到 forwardToQq（`toForward` 为空、for 循环没进）。要区分"没收到正文事件"和"收到但被过滤"，
    //   只能在 turn/end 这里把手上有什么如实记下来。
    void swDiag('turn-end short=' + String(w.shortId ?? '?')
      + ' mode=' + mode + ' rawMode=' + JSON.stringify(w.mode)
      + ' texts=' + allTexts.length + ' errs=' + errors.length
      + ' textLen=' + String(text ?? '').length
      + ' seen=' + w.seen + ' reason=' + String(rawReason ?? '-'));

    // ── 转发到 QQ ──────────────────────────────────────────────
    // 一档：只转末段；二/三档：所有正文 + 报错
    const toForward = mode === 1
      ? (text ? [text] : [])
      : [...allTexts, ...(errors.length ? ['⚠️ 报错：\n' + errors.join('\n')] : [])];
    // ★★ 2026-10-15 主人定：转发前**先刷新 target + 数被动条数**，别钉死绑定时的 msgId ★★
    //   被动回复（带 msg_id）有两条硬限制：①同一 msg_id 最多回 ~4-5 条；②msg_id 会过期。
    //   踩到的实例：老盯梢 bee798c0 的 replyTarget 里钉着很久以前的 msgId ⇒ 发送报
    //   `回复消息msg_id已过期`，md/文本两条链全挂、内容静默丢失。
    //   口径（与插件 outbound.ts 的 ADAPTIVE_MAX_PASSIVE=5 对齐）：
    //     · 每次转发前，把 fwd.replyTarget 刷新成**最新注入**的那份（带最新 msgId）；
    //     · 同一 msgId 数着用，**到 4 条**就主动转主动（摘掉 msgId），不再等它失败；
    //     · 真失败（过期/超限/其它）⇒ forwardToQq 里还有一层"摘 msgId 重发"兜底。
    if (toForward.length > 0) {
      const injected = globalThis[FWD_KEY] ?? null;
      if (injected?.sender && injected?.replyTarget) {
        w.fwd = { sender: injected.sender, replyTarget: injected.replyTarget };
      } else if (!w.fwd?.sender || !w.fwd?.replyTarget) {
        const hadFwd = !!w.fwd;
        const ok = hydrateFwd(w, root, session);
        void swDiag('pre-forward hydrate short=' + String(w.shortId ?? '?')
          + ' hadFwd=' + hadFwd + ' ok=' + ok + ' mode=' + mode);
      }
    }
    for (const piece of toForward) {
      const body = withOwner(w, piece);
      // 去重：同一条内容不重复转发
      if (body === w.lastForwarded) continue;
      const how = await forwardToQq(w, body);
      if (how) w.lastForwarded = body;
    }

    // ── 回灌进父会话上下文（二档**不进**）──────────────────────
    if (mode === 2) return;
    if (!text) return; // 空回合（只有工具调用/无正文）→ 不回灌
    // ★ 去重：兜底路径可能又取到"上一次已经灌过"的那段正文，内容相同就不再灌第二遍
    if (text === w.lastSent) return;
    w.lastSent = text;

    const agents = root.get('agents');
    // ★ 2026-10-14：**父会话跟着 QQ 对象走** —— 该 QQ 对象当前所在的会话优先（/bot-new 之后自动跟过去），
    //   没学到才回落到绑定时写死的那个 id（老行为，向后兼容）。
    const parentId = resolveParentId(w);
    const parent = agents?.get?.(parentId) ?? null;
    if (!parent) return; // 父不在（不 live）→ 静默跳过，不制造错误

    const candidate = buildSettlementNotice({ sessionId: sid, label: w.label, rawReason, text });
    if (!isInjectableMessage(candidate)) return; // 自检不过 → 宁可这次不回灌
    try {
      // ★ 2026-10-12 定案（照抄 qqbot 插件的入站模式 —— dist/features/qq-user-questions.js:646）：
      //     「忙时插话、空闲唤醒」
      //   ★ 三档（mode=3）主人要求"进上下文但**不唤醒**" ⇒ 无论忙闲都走 inject。
      const busy = (() => {
        try {
          const st = String(parent.status ?? parent.phase ?? '');
          return st !== '' && st !== 'idle';
        } catch { return false; }
      })();
      if (mode === 3 || busy) await parent.inject(candidate);   // 插话（不唤醒、不排队、不进输入框）
      else await parent.followup(candidate);                    // 空闲 → 唤醒
      w.firedAt = Date.now();
    } catch { /* 注入失败 → 静默；监听里绝不抛，免得影响宿主事件链 */ }
  } catch { /* 监听里绝不抛，免得影响宿主事件链 */ }
}

function installHook(root) {
  if (HOOK_DISABLED) return;

  // ① 把「当前实例的 handler」发布到 globalThis：已装好的那个监听会转发到最新实例，
  //    所以改完 lib 热刷后新代码立刻接管，不必重挂监听。
  globalThis[HANDLER_KEY] = (session, event) => { void handler(root, session, event); };

  // ② 监听全局只装一次。lib 带 mtime 版本号加载，改一次就换一个模块实例；
  //    若各实例各自 root.on 一遍，同一个 turn/end 会被回灌多次。
  if (globalThis[HOOK_KEY]) { hooked = true; return; }
  try {
    // 与 qqbot 的 mc_tell 同款：挂在插件根 ctx 上，事件回调 (session, event)。
    // 注意：回调里通过 globalThis 取 handler，永远调用最新那一版。
    root.on('session/event', (session, event) => {
      const h = globalThis[HANDLER_KEY];
      if (typeof h === 'function') h(session, event);
    });
    globalThis[HOOK_KEY] = true;
    hooked = true;
  } catch { hooked = false; }
}

/**
 * 登记一个"要盯着的子会话"。
 *
 * @param {object} opts
 *   · parentAgentId  父会话 id（必填）
 *   · childSessionId 子会话 id（必填）
 *   · label          标签（可选）
 *   · name           会话名（可选；归属行显示用，缺省取 label）
 *   · preset         预设名（可选；归属行显示用）
 *   · workspace      工作区（可选；归属行显示用，建议传目录名而非全路径）
 *   · mode           1=只回灌末段+转末段（默认） 2=只转所有正文+报错（不进父上下文） 3=进父上下文(不唤醒)+全转
 *   · sender         父会话的 sender（可选；给了才转发 QQ）
 *   · replyTarget    父会话所在的 QQ 目标（可选；自带最近 msgId ⇒ 被动优先）
 *   · peerName       父会话所在群/私聊的名字（可选，只用于显示）
 * @returns 人话描述（挂成功/失败原因），不抛错。
 */
export async function register(root, opts = {}) {
  const parentAgentId = String(opts.parentAgentId ?? '').trim();
  const childSessionId = String(opts.childSessionId ?? '').trim();
  const label = String(opts.label ?? '').trim();
  const mode = Number(opts.mode) === 2 ? 2 : (Number(opts.mode) === 3 ? 3 : 1);
  if (!parentAgentId || !childSessionId) return '未挂（缺 parentAgentId 或 childSessionId）';
  if (!root || typeof root.on !== 'function') return '未挂（root 不支持 .on）';
  installHook(root);
  if (HOOK_DISABLED) return '未挂（回灌钩子当前被 HOOK_DISABLED 主动关闭，属预期；恢复见 installHook 注释）';
  if (!hooked) return '未挂（root.on 抛错）';
  const fwd = (opts.sender && opts.replyTarget) ? { sender: opts.sender, replyTarget: opts.replyTarget } : null;
  // ★ 2026-10-14：记下这条盯梢属于哪个 **QQ 对象**（scope:peerId）—— 父会话要跟着它走。
  //   优先级：调用方显式给的 peerKey ＞ replyTarget 里能抠出来的 ＞ 空（空则退回写死的 parentAgentId）。
  const pk = String(opts.peerKey ?? '').trim() || peerKeyOfTarget(opts.replyTarget);
  watching.set(childSessionId, {
    parentAgentId,
    label,
    mode,
    shortId: shortSessionId(childSessionId),
    /** 归属行用的三件套（主人 2026-10-12 定：会话名 / 预设名 / 工作区） */
    name: String(opts.name ?? opts.label ?? '').trim(),
    preset: String(opts.preset ?? '').trim(),
    workspace: String(opts.workspace ?? '').trim(),
    peerName: String(opts.peerName ?? ''),
    peerKey: pk,
    fwd,
    lastText: '',
    texts: [],
    errors: [],
    seen: 0,
    firedAt: 0,
    lastForwarded: '',
  });
  // 绑定时先按"当时那个会话"给这张表起步；**只在没记录时写**，别把已经学到的新会话覆盖回旧的。
  if (pk && parentAgentId && !peerLatest.has(pk)) peerLatest.set(pk, parentAgentId);
  await persist();
  const modeText = mode === 2 ? '二档(全部正文+报错→QQ，不进父上下文)'
    : mode === 3 ? '三档(进父上下文但不唤醒 + 全转QQ)'
      : '一档(末段回灌父会话 + 同转QQ)';
  return `已挂（子=${shortSessionId(childSessionId)}… → 父=${shortSessionId(parentAgentId)}…；${modeText}${fwd ? '；QQ 转发就绪' : '；⚠️ 没拿到 sender/replyTarget，QQ 转发不可用'}）`;
}

/** 改档位（已挂的盯梢可随时改） */
export async function setMode(childSessionId, mode) {
  const w = watching.get(String(childSessionId ?? ''));
  if (!w) return '没找到这个盯梢（先用 session_watch list 看）';
  w.mode = Number(mode) === 2 ? 2 : (Number(mode) === 3 ? 3 : 1);
  await persist();
  return `已改为 ${w.mode} 档`;
}

/** 取消盯梢 */
export async function unregister(childSessionId) {
  const ok = watching.delete(String(childSessionId ?? ''));
  if (ok) await persist();
  return ok ? '已取消盯梢' : '没找到这个盯梢';
}

/** 给别的工具（如 session_watch 状态查询）读当前盯着的清单 */
/**
 * ★ 某个路由短 id 对应的**回灌挡位**（读内存名单；没绑过返回 0）。
 *
 * 入站扩展用它判断"这条路由消息要不要在父上下文里彻底消失"：
 *   挡位 2（二档）= 双向隔绝 —— 子会话的正文只去 QQ、**不进父上下文**（原有语义），
 *   那么反向也一样：**用户发进群的路由消息也不该落进父上下文**（2026-10-14 主人定）。
 * 没绑过的（纯通用路由）返回 0 ⇒ **不进隔绝**，保持原样投递 + 照常进上下文。
 */
export function modeOfRoute(key) {
  try {
    ensureLoaded();
    const k = String(key ?? '').trim();
    if (!k) return 0;
    for (const [sid, w] of watching.entries()) {
      const short = shortSessionId(sid);           // 例：fc871e99
      if (short === k || sid === k || sid === `session-${k}`) return Number(w?.mode ?? 1) || 1;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * 供工具/命令展示：这条盯梢**当前**会把回灌投给谁（= 跟着 QQ 对象动态解析之后的结果）。
 * 与 `parentAgentId`（绑定时写死的那个）不同：发过 `/bot-new` 之后这两个会不一样。
 */
export function effectiveParentOf(childSessionId) {
  ensureLoaded();
  const w = watching.get(String(childSessionId ?? ''));
  return w ? resolveParentId(w) : '';
}

export function listWatching() {  ensureLoaded();   // ★ 先保证存档已读回内存（重启后第一次调它就能看到完整名单）
  return [...watching.entries()].map(([sid, w]) => ({
    childSessionId: sid,
    shortId: shortSessionId(sid),
    parentAgentId: w.parentAgentId,
    parentShortId: shortSessionId(w.parentAgentId),
    /** QQ 对象键（scope:peerId）；父会话会跟着它动态解析 */
    peerKey: w.peerKey ?? '',
    /** 当前实际会投给的父会话（发过 /bot-new 后会与 parentAgentId 不同） */
    effectiveParentShortId: shortSessionId(resolveParentId(w)),
    label: w.label,
    mode: w.mode ?? 1,
    /** 归属行三件套（会随转发消息发到 QQ） */
    name: w.name ?? '',
    preset: w.preset ?? '',
    workspace: w.workspace ?? '',
    peerName: w.peerName ?? '',
    qqReady: !!w.fwd,
    hasText: !!w.lastText,
    turnsSeen: w.seen ?? 0,
    lastFiredAt: w.firedAt ?? 0,
    quotedAt: w.quotedAt ?? 0,
  }));
}
