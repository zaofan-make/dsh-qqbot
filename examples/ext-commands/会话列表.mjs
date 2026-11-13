import { fileURLToPath } from 'node:url';
/**
 * 会话列表.mjs — `/会话列表` 斜杠命令（扩展命令第五套）
 *
 * ★ 2026-10-14 主人需求（原话）：
 *   「再做个 /会话列表 的斜杠命令：先列出工作区选项 → 选了以后再列出会话列表选项（一页不要太多）
 *     → 再列出回灌模式。选择会话后可以**绑定任何已有会话**，不一定要建立的子会话，能钩子勾住并回灌吗？
 *     选择成功后，往 qq 发送一条消息模板，该模板的开头包含了会话 id，只要用户复制这条模板、
 *     修改发送就可以将这段话路由到对应会话 —— 这样就可以引用别的内容发送给路由的会话了（比如图片）」
 *
 * 所以本命令干三件事：
 *   ① 三步向导：**工作区 → 该工作区的会话 → 回灌模式**；
 *   ② 选完**绑上回灌钩子**（`register()` 的 childSessionId 本就认任意会话，不限"建出来的子会话"）；
 *   ③ 往 QQ 发一条**可复制的模板**，开头带会话 id ⇒ 复制改内容即可路由到那个会话。
 *
 * 路由靠 `tools/lib/session_watch_lib.mjs` 的**通用路由**（正文里出现 `[s:短id]` 或 `【会话 id】` 就投递）。
 *
 * ⚠️ 从 `/子会话` 抄来的四条硬经验（都踩过）：
 *   1. `paint()` 里**必须**做三件事：登记插件卡表、**命令侧自写注册表**、`W.set(cardId, st)`。
 *      （paint 每次换新 cardId，只在 handler/翻页处登记会漏 ⇒ 选完一屏就报"向导已过期"）
 *   2. 按钮 id **绝不能带冒号**：插件把 button_data 拆成 `ext:<工具名>:<卡id>:<按钮id>`，
 *      要求**恰好 3 段**，带冒号会 split 出 4 段被静默丢弃（现象：点了只弹"操作成功"）。
 *   3. 命令侧 `ctx.caps` 有值、**按钮回调的 ctx 是把能力平铺在自身**（没有 caps 键）
 *      ⇒ 一律写 `ctx?.caps ?? ctx`。
 *   4. `keyboardOf` / `regCardSelf` 里的**工具名必须与本文件一致**，否则插件查表查不到。
 *   5. ★★ **别信"handler 与 onInteraction 是同一个模块实例"**（2026-10-14 真机踩中，见文件头
 *      `SLOT` 注释）：插件对 `ext-commands` 是**两条独立加载路径**，`tools_reload` 只热刷其中一条
 *      ⇒ 同一个文件被实例化成**两份模块**、各持自己的 `W`。
 *      现象：发卡正常（命令侧 `表=2/3`），一点按钮就回「这个向导已经过期了」（回调侧 `keys=[]`）。
 *      对策：回调侧要用的一切（kernel / sender / replyTarget / 父会话 id / 向导状态）
 *      一律走 **`globalThis` 符号槽（`publishShared`/`adoptShared`）+ 磁盘（`saveState`/`loadState`）**，
 *      模块变量只当本地缓存。
 */
/**
 * ★★ 一页几个选项 = 由 **QQ 内联键盘的硬上限**倒推出来的，不是随便定的（2026-10-14 真机踩中）
 *
 * QQ 官方对内联键盘的限制：**总行数 ≤ 5**、每行 ≤ 5 个按钮。
 * 超了会被直接拒绝，原话见诊断日志：
 *   `HTTP 400: {"message":"请求错误，内联键盘行/列超限","code":40034029}`
 * 更坑的是：tier① 被拒后会**静默退化成纯文本兜底** —— 现象就是主人反馈的
 * 「文字发出来了，按钮选项消失」。
 *
 * 所以布局固定为 **5 行**：
 *   第 1~3 行 = 选项（**一页最多 15 个**）
 *   第 4 行   = 翻页（◀ 上一页 / 下一页 ▶），没得翻时放一个占位按钮
 *   第 5 行   = 取消
 * （2026-10-14 之前是 PAGE=20 ⇒ 4 行选项 + 2 行尾巴 = **6 行** ⇒ 必然被拒。）
 */
const PAGE = 15;
const OPT_ROWS = 3;                       // 选项最多 3 行（3×5 = 15）
const MAX_KB_ROWS = 5;                    // QQ 内联键盘总行数硬上限
const LETTERS = 'ABCDEFGHIJKLMNO';        // 15 个
const CARD_EXPIRE_MS = 10 * 60_000;
const MAX_PAGE_MS = 30 * 60_000;
const TOOL = '会话列表';                   // ★ 必须与文件名/注册名一致

const STEPS = ['workspace', 'session', 'mode'];
const STEP_CN = {
  workspace: '工作区',
  session: '会话',
  mode: '回灌模式',
};

/** 向导状态表（cardId → state） */
const W = new Map();
let seq = 0;

/** 字符串兜底 */
function cn(v) { return v === undefined || v === null ? '' : String(v); }
function short(s, n) { const t = cn(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

/** 诊断日志（沿用 /子会话 的做法：写死路径，排查"点了没反应"最有用） */
// ★ 2026-10-24 修复（issue #17）: 诊断日志原来写死 Windows 路径(D:/…) —— Linux/容器上会被
//   当成相对路径，在家目录里生成一个叫 "D:" 的畸形目录。日志跟本文件走，跨平台都不会丢。
const DIAG_FILE = fileURLToPath(new URL('../data/会话列表-diag.log', import.meta.url));
async function diag(msg) {
  try {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(DIAG_FILE), { recursive: true });
    await appendFile(DIAG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 诊断失败绝不影响主流程 */ }
}

/** 扩展数据根（与 /子会话 同口径） */
function dataRootOf(ctx) {
  try {
    const caps = ctx?.caps ?? ctx ?? {};
    const p = caps?.paths ?? {};
    const cand = p.dataRoot ?? caps.dataRoot ?? ctx?.dataRoot ?? '';
    if (cand) return String(cand);
  } catch { /* ignore */ }
  return 'D:/newwenjianjia/aiwork/鲸鱼娘/dshqqbot';
}

/**
 * ★★ 跨模块实例的共享位 —— 2026-10-14 真机 bug 修复（「选了工作区就报向导已过期」）
 *
 * 现象：`/会话列表` 正常发卡、点按钮却回「这个向导已经过期了」，
 *   诊断日志里 `[onInteraction] card=… 命中=false keys=[]`（状态表是**空**的），
 *   而同一条日志里 `[paint] … 表=2 / 表=3`（命令侧写进去过）⇒ **两边的 W 不是同一个 Map**。
 *
 * 真因：插件对 `ext-commands` 是**两条独立加载路径**（斜杠命令注册 / 卡片回调查表），
 *   `tools_reload` 只热刷其中一条 ⇒ **同一个文件被实例化成两份模块**，
 *   各自持有自己的 `W` / `KERNEL` / `CTX_CACHE`：
 *     · 命令侧实例：paint 写自己的 W（seq 正常递增）—— 看起来一切正常；
 *     · 回调侧实例：W 永远空 ⇒ 一点就"过期"。
 *
 * ⇒ 凡是**回调侧要用**的东西（kernel / sender / replyTarget / 父会话 id / 向导状态）
 *   **都不能只放模块变量**，必须落到 ① `globalThis` 符号槽（同进程跨实例可见）
 *   或 ② 磁盘（跨实例、甚至跨重启都可见）。
 */
const SLOT = Symbol.for('dsh-qqbot.session-list.shared');
function shared() {
  try { return globalThis[SLOT] ?? (globalThis[SLOT] = {}); } catch { return {}; }
}
function publishShared(patch) { try { Object.assign(shared(), patch ?? {}); } catch { /* ignore */ } }

/** 向导状态的磁盘副本（回调侧实例用来"认出"命令侧实例发的卡） */
function stateFileOf(ctx) {
  const root = cn(shared().dataRoot) || dataRootOf(ctx);
  return `${root}/.qqbot/session-list-wizard.json`;
}

async function saveState(ctx, cardId, st) {
  try {
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const f = stateFileOf(ctx);
    let all = {};
    try { all = JSON.parse(readFileSync(f, 'utf8')) ?? {}; } catch { /* 首次或坏文件 */ }
    const now = Date.now();
    for (const k of Object.keys(all)) if (Number(all[k]?.expireAt ?? 0) < now) delete all[k];
    all[cardId] = { ...st, expireAt: now + CARD_EXPIRE_MS };
    const keys = Object.keys(all);
    if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete all[k];
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(all));
    return true;
  } catch { return false; }
}

async function loadState(ctx, cardId) {
  try {
    const { readFileSync } = await import('node:fs');
    const all = JSON.parse(readFileSync(stateFileOf(ctx), 'utf8')) ?? {};
    const st = all[cardId];
    if (!st || Number(st.expireAt ?? 0) < Date.now()) return null;
    return st;
  } catch { return null; }
}

async function dropState(ctx, cardId) {
  try {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const all = JSON.parse(readFileSync(stateFileOf(ctx), 'utf8')) ?? {};
    if (all[cardId]) { delete all[cardId]; writeFileSync(stateFileOf(ctx), JSON.stringify(all)); }
  } catch { /* ignore */ }
}

/** 回调侧补齐"命令侧才知道"的上下文（同进程共享位优先，其次回调 ctx 自带的 kernel） */
function adoptShared(ctx) {
  const s = shared();
  KERNEL = KERNEL ?? s.kernel ?? ctx?.kernel ?? ctx?.caps?.kernel ?? null;
  CTX_CACHE.sender = CTX_CACHE.sender ?? s.sender ?? null;
  CTX_CACHE.replyTarget = CTX_CACHE.replyTarget ?? s.replyTarget ?? null;
  CTX_CACHE.agentId = CTX_CACHE.agentId || cn(s.parentId);
  CTX_CACHE.sessionId = CTX_CACHE.sessionId || cn(s.parentId);
}

/** 命令侧自写卡表（不依赖插件是否注入 registerInteractionCard） */
async function regCardSelf(ctx, cardId, buttonIds) {
  const root = dataRootOf(ctx);
  if (!root) return false;
  try {
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const file = join(root, '.qqbot', 'ext-tool-cards.json');
    let table = { version: 1, cards: [] };
    try { table = JSON.parse(readFileSync(file, 'utf8')) ?? table; } catch { /* 首次或坏文件 */ }
    if (!Array.isArray(table.cards)) table.cards = [];
    const mc = ctx?.message ?? {};
    const rt = ctx?.replyTarget ?? {};
    const pe = ctx?.peer ?? {};
    const scope = cn(rt.scope || ctx?.scope || pe.scope || mc.kind || ((mc.groupOpenid || pe.groupId || pe.peerId) ? 'group' : 'c2c'));
    const targetId = cn(mc.groupOpenid || rt.targetId || pe.groupId || pe.groupOpenid || pe.peerId || pe.id || mc.senderId);
    const now = Date.now();
    table.cards = table.cards.filter((c) => Number(c?.expireAt ?? 0) > now && !(c?.toolName === TOOL && c?.cardId === cardId));
    table.cards.push({ toolName: TOOL, cardId, buttonIds, scope, targetId, createdAt: now, expireAt: now + CARD_EXPIRE_MS });
    if (table.cards.length > 200) table.cards = table.cards.slice(-200);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(table, null, 2));
    return true;
  } catch { return false; }
}

/** 发卡（markdown + 按钮键盘）；四级兜底，与 /子会话 同款。
 *  ★ 返回值要说实话（2026-10-14 修）：`'kb'`=带按钮发出去了 / `'text'`=**退化成纯文本**（按钮没了）
 *  / `'fail'`=什么都没发出去。之前只会返回 true/false，**退化被当成成功**，
 *  于是"文字出来了、按钮消失"这种事故在日志里显示 `发出=ok`，白排查半天。 */
let LAST_SEND_ERR = '';
async function sendCard(ctx, text, keyboard) {
  const caps = ctx?.caps ?? ctx ?? {};
  const mc = ctx?.message ?? {};
  const rt = ctx?.replyTarget ?? {};
  const pe = ctx?.peer ?? {};
  const scope = cn(rt.scope || ctx?.scope || pe.scope || mc.kind || ((mc.groupOpenid || pe.groupId || pe.peerId) ? 'group' : 'c2c'));
  const gid = cn(mc.groupOpenid || rt.targetId || rt.openid || rt.id || pe.groupId || pe.groupOpenid || (scope === 'group' ? (pe.peerId || pe.id) : '') || '');
  const uid = cn(mc.senderId || rt.openid || rt.id || pe.openid || pe.userId || '');
  const api = caps.api;
  if (keyboard && typeof api === 'function' && (gid || uid)) {
    const path = gid ? `/v2/groups/${gid}/messages` : `/v2/users/${uid}/messages`;
    const body = { msg_type: 2, markdown: { content: text }, keyboard, ...(gid ? {} : { content: text }) };
    try {
      const r = await api(path, { method: 'POST', body });
      void diag(`[sendCard] ①api=${JSON.stringify(r ?? null).slice(0, 200)}`);
      if (r && r.ok !== false) { LAST_SEND_ERR = ''; return 'kb'; }
      LAST_SEND_ERR = cn(r?.err?.human ?? r?.err?.message ?? r?.err?.code ?? 'ok=false');
    } catch (e) { LAST_SEND_ERR = cn(e?.message ?? e); void diag(`[sendCard] ①抛错=${short(e?.message ?? e, 200)}`); }
  }
  try {
    if (keyboard && typeof caps.markdownCard === 'function') {
      const r2 = await caps.markdownCard(text, keyboard);
      if (r2) return 'kb';
    }
  } catch { /* ignore */ }
  try {
    if (keyboard && typeof ctx?.sender?.sendMarkdownWithKeyboard === 'function') {
      await ctx.sender.sendMarkdownWithKeyboard(ctx.replyTarget, text, keyboard);
      return 'kb';
    }
  } catch { /* ignore */ }
  try { if (typeof caps.markdown === 'function' && (await caps.markdown(text))) return 'text'; } catch { /* ignore */ }
  return 'fail';
}

/** 按钮（id 不能带冒号） */
function btn(id, label, style = 1) {
  return {
    id,
    render_data: { label: short(label, 18), visited_label: short(label, 18), style },
    action: { type: 1, permission: { type: 2 }, data: id, unsupport_tips: '请升级QQ客户端后重试' },
  };
}

/** 拼 QQ inline_keyboard；★ 工具名必须是本命令 */
function keyboardOf(rows, cardId) {
  return {
    content: {
      rows: rows.map((r) => ({ buttons: r.map((b) => ({ ...b, action: { ...b.action, data: `ext:${TOOL}:${cardId}:${b.id}` } })) })),
    },
  };
}

/** 加载回灌库（按 mtime 版本化，改完 lib 热刷即生效） */
async function loadLib() {
  const url = new URL(`../tools/lib/session_watch_lib.mjs?v=${Date.now()}`, import.meta.url);
  return await import(url.href);
}

/**
 * 把工作区转义目录名**还原成真实路径**（主人 2026-10-14 要求「显示真实文件夹名字」）。
 *
 * 宿主规则（实测推导，见 `~/.dsh/sessions/`）：
 *   · 整体被 `--` 包起来，首尾各去掉一层；
 *   · **`-` = 路径分隔符**（`\`）；
 *   · **`~XXXX` = 一个 UTF-16 码元**（中文/特殊字符都这么转义）；
 *   · 开头的**单字母 + `-`** 是盘符（如 `D-` ⇒ `D:`）。
 * 例：`--D-newwenjianjia-aiwork-~9CB8~9C7C~5A18--` ⇒ `D:\newwenjianjia\aiwork\鲸鱼娘`
 *
 * ⚠️ 已知不可逆点：原路径里若本来就有 `-`，会被同样当成分隔符（宿主转义时没有区分手段）。
 */
function wsPath(dir) {
  const t = cn(dir).replace(/^--/, '').replace(/--$/, '');
  const parts = [];
  let cur = '';
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '-') { parts.push(cur); cur = ''; i += 1; continue; }
    const m = /^~([0-9A-Fa-f]{4})/.exec(t.slice(i, i + 5));
    if (m) { cur += String.fromCharCode(parseInt(m[1], 16)); i += 5; continue; }
    cur += ch;
    i += 1;
  }
  parts.push(cur);
  const segs = parts.filter((p) => p !== '');
  if (segs.length && /^[A-Za-z]$/.test(segs[0])) segs[0] = `${segs[0]}:`;
  return segs.join('\\');
}

/** 卡片上显示用：太长时保留**尾部**（尾部才是能分辨的那几级） */
function wsDisplay(dir, max = 52) {
  const full = wsPath(dir);
  if (full.length <= max) return full;
  return '…' + full.slice(-(max - 1));
}

// ── 候选值：**优先问宿主服务**（工作区=会话的 cwd，会话=sessionPersistence.list()，
//    标题=sessionTitle.get()），拿不到才回退扫盘。主人 2026-10-14 定：
//    「一定要解析会话吗？不能从 web 界面里拿吗？就像会话排序一样」。──────

const OPT_CACHE = new Map();
const OPT_TTL_MS = 60 * 1000;         // 候选缓存：60 秒（新会话能及时冒出来）
/** 全量会话列表缓存（60s）：sessionPersistence.list() 扫盘很慢，别每次向导都重扫 */
const ALL_CACHE = new Map();
const TTL_CACHE = new Map();          // 标题缓存（带时间戳，5 分钟过期）
const TITLE_TTL_MS = 5 * 60 * 1000;
let KERNEL = null;
const CTX_CACHE = { sender: null, replyTarget: null, agentId: '', sessionId: '' };

/** 取宿主服务容器（cordis ctx）：handler 里缓存过就直接用，否则依次看 caps.kernel / kernel */
function kernelOf(ctx) {
  if (KERNEL) return KERNEL;
  const c = ctx ?? {};
  for (const v of [c?.caps?.kernel, c?.kernel]) if (v) return v;
  return null;
}

/**
 * 从容器里取服务：`kernel.get(name)` 是主路。
 *
 * ⚠️ 踩过的坑（2026-10-14 实测报错 `cannot get property "ctx" without inject`）：
 *   cordis Context 上的 `ctx` / `caps` 等属性是 **getter**，未 inject 时**读取即抛**。
 *   所以**绝不能**把它们放进数组字面量里"顺手取一下" —— 必须逐个包 try。
 */
function svcOf(ctx, name) {
  const k = kernelOf(ctx);
  if (!k) return null;
  try {
    if (typeof k.get === 'function') {
      const v = k.get(name);
      if (v) return v;
    }
  } catch { /* ignore */ }
  for (const key of ['root', 'ctx', 'caps']) {
    try {
      const c = k[key];
      if (!c) continue;
      const v = typeof c.get === 'function' ? c.get(name) : c[name];
      if (v) return v;
    } catch { /* ignore */ }
  }
  return null;
}

/** 会话 id 归一：宿主持久化里带 `session-` 前缀，实时 agent id 不带 —— 两种都留一手 */
function bareId(id) { const s = cn(id); return s.startsWith('session-') ? s.slice('session-'.length) : s; }
function fullId(id) { const s = cn(id); return s.startsWith('session-') ? s : `session-${s}`; }

/**
 * 宿主里**全部**会话（含已结束的）。返回 [{id, cwd, createdAt, sizeBytes}]；
 * 拿不到服务时返回 null，调用方回退扫盘。
 */
/**
 * 会话索引的**磁盘缓存**（10 分钟）：
 * 宿主的 `sessionPersistence.list()` 每次都要扫全盘（本机 1697 个），
 * 而且**没有过滤选项**（0.2.2 源码确认：options 只有 signal）。
 * 所以首次扫完就落盘，后续向导/翻页直接读，跨重启也有效。
 */
const SESSION_INDEX_TTL_MS = 10 * 60 * 1000;
let SESSION_INDEX_FILE = '';

function sessionIndexFile() {
  if (SESSION_INDEX_FILE) return SESSION_INDEX_FILE;
  try {
    const dr = String((typeof CTX_CACHE !== 'undefined' && CTX_CACHE && CTX_CACHE.dataRoot) || '');
    if (dr) SESSION_INDEX_FILE = join(dr, '.qqbot', 'session-index-cache.json');
  } catch { /* ignore */ }
  return SESSION_INDEX_FILE;
}

function readSessionIndexCache() {
  try {
    const f = sessionIndexFile();
    if (!f) return null;
    if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j || !Array.isArray(j.items)) return null;
    if (Date.now() - Number(j.at || 0) > SESSION_INDEX_TTL_MS) return null;
    return j.items;
  } catch { return null; }
}

function writeSessionIndexCache(items) {
  try {
    const f = sessionIndexFile();
    if (!f) return;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ at: Date.now(), items }), 'utf8');
  } catch { /* 缓存失败不影响主流程 */ }
}

/**
 * ⭐ 2026-11-13 主线路：从 `workspaceRegistry` 读（宿主界面「隐藏已归档」用的就是它）。
 *
 * 为什么换成它：`sessionPersistence.list()` 每次都要枚举磁盘上全部会话（本机 1697 个，含子代理），
 * 而 `workspaceRegistry` 在**启动时就把 header 索引进内存**，并维护 registry 级 `archivedSessionIds`。
 * 实测：11 个工作区 `sessionIds` 合计 **262**（对比 1697），且拿取是**同步内存操作**。
 *
 * 返回 [{ path, title, ids }]，ids 已**剔除归档**。
 */
function regWorkspaces(ctx) {
  const reg = svcOf(ctx, 'workspaceRegistry');
  if (!reg || typeof reg.list !== 'function') return null;
  let archived = [];
  try { archived = reg.archivedSessionIds || []; } catch { /* ignore */ }
  const arch = new Set(Array.isArray(archived) ? archived.map((x) => String(x)) : []);
  let list = [];
  try { list = reg.list() || []; } catch { return null; }
  const out = [];
  for (const w of list) {
    let rec = null;
    try { rec = w.record || null; } catch { /* ignore */ }
    let ids = [];
    try { ids = Array.isArray(w.sessionIds) ? w.sessionIds.slice() : []; } catch { /* ignore */ }
    const path = String(rec?.path ?? '');
    const title = String(rec?.title ?? '') || path;
    const live = ids.filter((id) => !arch.has(String(id)));
    out.push({ path, title, ids: live, archivedCount: ids.length - live.length });
  }
  return { list: out, archived: arch.size };
}

async function listAllSessions(ctx) {
  // ★ 2026-11-13（主人："1359 个？好慢"）：`sessionPersistence.list()` 会把**磁盘上所有会话**
  //   枚举出来（含**子代理会话**和归档），一千多个时首次要等好几秒。
  //   这里做两件事：① 结果整体缓存 60s（向导翻页/重试不再重扫）；② 把 delegationDepth 带出来供上层过滤。
  const CACHE_KEY = 'allSessions';
  const cacheHit = ALL_CACHE.get(CACHE_KEY);
  if (cacheHit && Date.now() - cacheHit.at < 60_000) return cacheHit.v;
  // ★ 2026-11-13（主人："还是慢"）：`sessionPersistence.list()` **没有"只列未归档"的选项**
  //   （签名只有 `{signal}`，我们查过 0.2.2 源码）。它每次都要枚举磁盘上全部会话
  //   （本机 1697 个，含子代理/归档）⇒ 首次必然几秒。
  //   所以改成**磁盘缓存**：10 分钟内直接读缓存，跨进程重启也有效；过期才重扫一次。
  const diskHit = readSessionIndexCache();
  if (diskHit) return diskHit;
  const sp = svcOf(ctx, 'sessionPersistence');
  if (!sp || typeof sp.list !== 'function') {
    void diag(`[svc] 拿不到 sessionPersistence（kernel=${!!kernelOf(ctx)} sp=${!!sp}）`);
    return null;
  }
  try {
    const r = await sp.list();
    const arr = Array.isArray(r) ? r : (r && typeof r === 'object' ? Object.values(r) : []);
    const out = arr.map((it) => {
      const h = it?.header ?? {};
      return {
        id: cn(h.id ?? it?.sessionId ?? it?.id),
        cwd: cn(h.cwd ?? it?.cwd),
        createdAt: Number(h.createdAt ?? it?.createdAt ?? 0) || 0,
        sizeBytes: Number(it?.sizeBytes ?? 0) || 0,
        // 子代理会话：delegationDepth > 0（顶层会话没有这个字段或为 0）
        depth: Number(h.delegationDepth ?? it?.delegationDepth ?? 0) || 0,
      };
    }).filter((x) => x.id);
    if (out.length === 0) return null;
    ALL_CACHE.set(CACHE_KEY, { at: Date.now(), v: out });
    writeSessionIndexCache(out);
    return out;
  } catch (e) {
    void diag(`[svc] sessionPersistence.list 抛错=${short(e?.message ?? e, 160)}`);
    return null;
  }
}

/**
 * live（正在跑）会话表：bare id → {title, cwd}。
 *
 * ★ 标题的唯一可靠来源（2026-10-14 实测定案）：
 *   `sessions.list()` 每一项的 `log`（内存事件数组）里，**最后一个 `session/title` 事件的
 *   `data.title`**。实测 14 个 live 会话全部取到标题（"做早饭会话问候""早饭群"…）。
 *
 * ⚠️ 两条死路（别再试）：
 *   ① `sessionTitle.get(id)` 在本版宿主**是坏的** —— 抛 `session.snapshotEvents is not a function`；
 *   ② `sessionPersistence.list()` 的 `header` 里**根本没有 title 字段**
 *      （只有 version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset）。
 *   ⇒ 已结束（非 live）的会话**拿不到标题**，只能显示短 id + 创建时间。
 */
async function liveMap(ctx) {
  const hit = TTL_CACHE.get('live');
  if (hit && Date.now() - hit.at < 15 * 1000) return hit.v;
  const out = new Map();
  let titleSvc = null;
  try { titleSvc = svcOf(ctx, 'sessionTitle'); } catch { /* ignore */ }
  const ss = svcOf(ctx, 'sessions');
  if (ss && typeof ss.list === 'function') {
    try {
      const r = await ss.list();
      const arr = Array.isArray(r) ? r : (r && typeof r === 'object' ? Object.values(r) : []);
      for (const o of arr) {
        const id = bareId(o?.id ?? o?.sessionId ?? '');
        if (!id) continue;
        let title = '';
        // ★ 2026-11-13 更新（实测）：`sessionTitle.get()` **没坏** —— 它要的是 **Session 对象**，
        //   传 id 字符串才会抛 "session.snapshotEvents is not a function"。
        //   传对象后能直接拿到标题，且**比扫 log 更全**（log 里只有 "被生成过" 的会话才有 session/title 事件）。
        if (titleSvc) {
          try {
            const r = titleSvc.get(o);
            if (r && typeof r.title === 'string' && r.title) title = r.title;
          } catch { /* 回退扫 log */ }
        }
        if (!title) {
          const lg = o?.log;
          if (Array.isArray(lg)) {
            for (let i = lg.length - 1; i >= 0; i--) {
              if (String(lg[i]?.type ?? '') === 'session/title') {
                const t = lg[i]?.data?.title;
                if (typeof t === 'string' && t) { title = t; break; }
              }
            }
          }
        }
        out.set(id, { title, cwd: cn(o?.header?.cwd ?? '') });
      }
    } catch (e) { void diag(`[svc] sessions.list 抛错=${short(e?.message ?? e, 160)}`); }
  }
  TTL_CACHE.set('live', { at: Date.now(), v: out });
  return out;
}

/** 会话数 / 工作区数 摘要（卡片顶部显示，让人一眼知道规模） */
let LAST_SCOPE = '';

async function optionsOf(ctx, step, st) {
  const key = step === 'session' ? `session::${st.picked.workspace?.value ?? ''}` : step;
  const hit = OPT_CACHE.get(key);
  if (hit && Date.now() - hit.at < OPT_TTL_MS) return hit.v;
  const out = await optionsOfRaw(ctx, step, st);
  if (Array.isArray(out) && out.length > 0) OPT_CACHE.set(key, { at: Date.now(), v: out });
  return out;
}

async function optionsOfRaw(ctx, step, st) {
  try {
    const lib = await loadLib();
    if (step === 'workspace') {
      // ⭐ 先走 registry（内存，瞬间）；拿不到才退回扫盘
      const reg = regWorkspaces(ctx);
      if (reg && reg.list.length > 0) {
        const list = reg.list
          .filter((w) => w.ids.length > 0)
          .sort((a, b) => b.ids.length - a.ids.length);
        LAST_SCOPE = `注册表 ${list.length} 个工作区 / 未归档会话 ${list.reduce((n, w) => n + w.ids.length, 0)} 个（另已归档 ${reg.archived} 个）`;
        void diag(`[opts] workspace 走 registry：${LAST_SCOPE}`);
        return list.map((w) => ({ value: w.path, label: `${wsDisplay(w.path)}  · ${w.ids.length} 个` }));
      }
      const all = await listAllSessions(ctx);
      if (all) {
        // ★ 只数**顶层会话**：子代理会话（depth>0）不该出现在"工作区有多少会话"里
        const top = all.filter((x) => !x.depth);
        const cnt = new Map();
        for (const s of top) if (s.cwd) cnt.set(s.cwd, (cnt.get(s.cwd) ?? 0) + 1);
        const list = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
        LAST_SCOPE = `宿主 ${top.length} 个会话（另有子代理 ${all.length - top.length} 个，未列出）/ ${list.length} 个工作区`;
        void diag(`[opts] workspace 走宿主：${LAST_SCOPE}`);
        return list.map(([cwd, n]) => ({ value: cwd, label: `${wsDisplay(cwd)}  · ${n} 个` }));
      }
      const dirs = lib.listWorkspaceDirs();
      LAST_SCOPE = `扫盘 ${dirs.length} 个工作区（宿主服务不可用）`;
      void diag(`[opts] workspace 回退扫盘：${dirs.length} 个`);
      return dirs.map((d) => ({ value: d, label: wsDisplay(wsPath(d)) }));
    }
    if (step === 'session') {
      const ws = st.picked.workspace?.value ?? '';
      const live = await liveMap(ctx);
      // ⭐ 同样先走 registry：该工作区的 sessionIds 已在内存里（且已剔除归档）
      const reg = regWorkspaces(ctx);
      const rw = reg?.list.find((w) => w.path === ws);
      if (reg && rw) {
        const ids = rw.ids.slice();
        // 有标题的（live）排前面，其余按 id 稳定排序
        const score = (id) => (live.get(bareId(id))?.title ? 1 : 0);
        ids.sort((a, b) => (score(b) - score(a)) || String(a).localeCompare(String(b)));
        const shown = ids.slice(0, 80);
        const named = ids.filter((id) => live.get(bareId(id))?.title).length;
        LAST_SCOPE = `${ids.length} 个未归档会话（${named} 个在线有名；该区归档 ${rw.archivedCount} 个已隐藏）`;
        void diag(`[opts] session 走 registry ws=${ws} 命中 ${ids.length}，有名 ${named}`);
        return shown.map((id) => {
          const info = live.get(bareId(id));
          const t = info?.title ?? '';
          const tag = info ? '🟢' : '⚪';
          const id8 = bareId(id).slice(0, 8);
          const head = t ? short(t, 24) : id8;
          return { value: id, label: `${tag} ${head}${t ? ` · ${id8}` : ''}` };
        });
      }
      const all = await listAllSessions(ctx);
      if (all) {
        const seen = new Set();
        const mine = all.filter((s) => {
          const b = bareId(s.id);
          if (seen.has(b)) return false;
          seen.add(b);
          return !ws || s.cwd === ws;
        });
        // 排序：**能叫出名字的（live 有标题）排最前** → 再按创建时间新在前。
        // 理由：已结束的会话宿主里没有标题（见 liveMap 注释），只能靠时间认。
        const score = (s) => (live.get(bareId(s.id))?.title ? 1 : 0);
        mine.sort((a, b) => (score(b) - score(a)) || (b.createdAt - a.createdAt));
        const shown = mine.slice(0, 80);
        const named = mine.filter((s) => live.get(bareId(s.id))?.title).length;
        LAST_SCOPE = `${mine.length} 个会话（${named} 个在线有名）`;
        void diag(`[opts] session 走宿主 ws=${ws} 命中 ${mine.length}，有名 ${named}，取前 ${shown.length}`);
        return shown.map((s) => {
          const info = live.get(bareId(s.id));
          const t = info?.title ?? '';
          const when = s.createdAt
            ? new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '—';
          const tag = info ? '🟢' : '⚪';
          const id8 = bareId(s.id).slice(0, 8);
          const head = t ? short(t, 24) : id8;
          return { value: s.id, label: `${tag} ${head}${t ? ` · ${id8}` : ''} · ${when}` };
        });
      }
      const dirs = lib.listSessionDirs(ws || undefined);
      void diag(`[opts] session 回退扫盘 ws=${ws} 得到 ${dirs.length} 个`);
      return dirs.map((s) => {
        const when = s.mtime ? new Date(s.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const isSub = s.id.startsWith('session-') ? '子会话 ' : '';
        return { value: s.id, label: `${s.short}  ${isSub}${when}` };
      });
    }
    if (step === 'mode') {
      return [
        { value: 1, label: '一档 · 末段回灌 + 转发到 QQ（默认）' },
        { value: 2, label: '二档 · 全部正文 + 报错 只转 QQ（不进父上下文）' },
        { value: 3, label: '三档 · 进父上下文但不唤醒 + 转 QQ' },
      ];
    }
  } catch (e) { void diag(`[opts] ${step} 抛错=${short(e?.message ?? e, 160)}`); }
  return [];
}

// ── 卡片渲染 ────────────────────────────────────────────────────────────

function cardText(st) {
  const L = [];
  L.push(`### 🗂 会话列表 · 第 ${st.stepIdx + 1}/${STEPS.length} 步：${STEP_CN[st.step]}`);
  L.push('');
  for (const k of STEPS) {
    const v = st.picked[k];
    if (k === 'session') {
      L.push(`- ${STEP_CN[k]}：${v ? `${short(v.label, 40)}（${short(v.value, 20)}）` : '（待选）'}`);
    } else {
      L.push(`- ${STEP_CN[k]}：${v ? v.label : '（待选）'}`);
    }
  }
  L.push('');
  if (LAST_SCOPE && st.step !== 'mode') L.push(`> ${LAST_SCOPE}`);
  if (st.step === 'session') L.push('> 🟢=正在跑　⚪=已休眠（都能绑，休眠的会被唤醒）');
  L.push('');
  if (st.error) L.push(`⚠️ ${st.error}`, '');
  const opts = st.options;
  if (!opts.length) {
    L.push('这一步没扫到候选 —— 换个工作区试试，或直接说一声让本鲸手工绑。');
  } else {
    const total = Math.max(1, Math.ceil(opts.length / PAGE));
    L.push(`第 ${st.page + 1}/${total} 页（点字母选中）：`);
    for (let i = 0; i < PAGE; i++) {
      const idx = st.page * PAGE + i;
      if (idx >= opts.length) break;
      L.push(`**${LETTERS[i]}**. ${short(opts[idx].label, 46)}`);
    }
  }
  return L.join('\n');
}

function cardKeyboard(st) {
  const rows = [];
  const opts = st.options;
  const start = st.page * PAGE;
  const cur = opts.slice(start, start + PAGE);
  for (let r = 0; r * 5 < cur.length && r < OPT_ROWS; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      const i = r * 5 + c;
      if (i >= cur.length) break;
      row.push(btn(`p${start + i}`, LETTERS[i]));
    }
    if (row.length) rows.push(row);
  }
  const nav = [];
  if (st.page > 0) nav.push(btn('prev', '◀ 上一页', 1));
  if (start + PAGE < opts.length) nav.push(btn('next', '下一页 ▶', 1));
  rows.push(nav.length ? nav : [btn('noop', '·', 1)]);
  rows.push([btn('cancel', '取消', 4)]);
  // ★ 保底：QQ 只收 ≤5 行；真超了就砍尾巴（正常布局下正好 5 行，走不到这里）
  while (rows.length > MAX_KB_ROWS) rows.splice(rows.length - 2, 1);
  return keyboardOf(rows, st.cardId);
}

/** 发/重发当前步骤的卡（★ 三件事全在这里做） */
async function paint(ctx, st) {
  st.options = await optionsOf(ctx, st.step, st);
  if (st.page * PAGE >= st.options.length) st.page = Math.max(0, Math.ceil(st.options.length / PAGE) - 1);
  st.error = '';
  st.cardId = `${TOOL}-${++seq}-${Date.now().toString(36)}`;
  const kb = cardKeyboard(st);
  const mode = await sendCard(ctx, cardText(st), kb);
  const ok = mode === 'kb';
  const caps = ctx?.caps ?? ctx ?? {};
  const allIds = [...st.options.map((_, i) => `p${i}`), 'prev', 'next', 'cancel', 'noop'];
  try {
    if (typeof caps.registerInteractionCard === 'function') {
      caps.registerInteractionCard({ cardId: st.cardId, buttonIds: allIds, expireAt: Date.now() + CARD_EXPIRE_MS });
    }
  } catch { /* ignore */ }
  try { await regCardSelf(ctx, st.cardId, allIds); } catch { /* ignore */ }
  W.set(st.cardId, st);
  if (W.size > 30) {
    for (const k of [...W.keys()].slice(0, W.size - 30)) if (k !== st.cardId) W.delete(k);
  }
  publishShared({ dataRoot: dataRootOf(ctx) });
  try { await saveState(ctx, st.cardId, st); } catch { /* ignore */ }   // ★ 落盘：回调侧可能是**另一个模块实例**
  void diag(`[paint] step=${st.step} page=${st.page} 选项=${st.options.length} 发出=${mode}${LAST_SEND_ERR ? ' err=' + short(LAST_SEND_ERR, 80) : ''} 表=${W.size}`);
  if (mode !== 'kb') {
    st.error = mode === 'text'
      ? `按钮没发出去（QQ 拒了键盘：${short(LAST_SEND_ERR, 50) || '未知'}），这一步只能纯文本显示`
      : '卡片完全没发出去（当前环境可能不支持富文本卡片）';
  }
  return ok;
}

/**
 * 全部选完 → **绑上回灌钩子** + **发可复制模板**。
 * 「绑定任何已有会话」这件事本身不需要新能力：`register()` 的 childSessionId 就是"任意会话 id"。
 */
async function bindNow(ctx, st) {
  adoptShared(ctx);
  const lib = await loadLib();
  const root = kernelOf(ctx);
  const sess = st.picked.session ?? {};
  const ws = st.picked.workspace?.value ?? '';
  const mode = Number(st.picked.mode?.value ?? 1);
  // ★ 父会话 id 优先取**命令侧存进向导状态**的那份：回调侧可能是另一个模块实例，
  //   它自己的 CTX_CACHE 是空的（详见文件头 SLOT 注释）。
  const parentId = cn(st.parentId) || CTX_CACHE.agentId || CTX_CACHE.sessionId || '';
  const sender = CTX_CACHE.sender ?? shared().sender ?? null;
  const replyTarget = CTX_CACHE.replyTarget ?? shared().replyTarget ?? null;
  void diag(`[bind] root=${!!root} parent=${parentId || '-'} child=${short(sess.value, 40)} mode=${mode} fwd=${!!sender && !!replyTarget}`);

  if (!root || typeof root.on !== 'function') {
    return { text: `⚠️ 拿不到宿主 ctx（需要权限包里的 kernel），这次没绑上。\n会话 id：\`${short(sess.value, 40)}\`` };
  }
  let result = '未挂（未知原因）';
  try {
    result = await lib.register(root, {
      parentAgentId: parentId,
      childSessionId: sess.value,
      label: short(sess.label, 40),
      mode,
      sender,
      replyTarget,
      name: short(sess.label, 40),
      workspace: wsPath(ws),
    });
  } catch (e) {
    result = '绑定抛错：' + short(e?.message ?? e, 120);
  }

  const sid = sess.value.startsWith('session-') ? sess.value.slice('session-'.length) : sess.value;
  const key = sid.slice(0, 8);
  const modeCn = mode === 2 ? '二档' : (mode === 3 ? '三档' : '一档');
  const L = [];
  L.push('### ✅ 已选定');
  L.push('');
  L.push(`- 会话：\`${short(sess.value, 44)}\``);
  L.push(`- 工作区：${wsPath(ws)}`);
  L.push(`- 回灌：**${modeCn}** · ${short(result, 60)}`);
  L.push('');
  L.push('**复制下面这行**，把文字改成你要发的内容就能路由给它（图片/引用也可以一起发）：');
  L.push('');
  L.push(`\`[s:${key}]\` 在这里写你要发给这个会话的内容`);
  L.push('');
  L.push('> 直接发这句就行；本鲸会把标记剥掉、把内容投递进那个会话。');
  return { text: L.join('\n') };
}

/** 推进到下一步（或收尾） */
async function advance(ctx, st) {
  while (st.stepIdx < STEPS.length && st.picked[STEPS[st.stepIdx]]) st.stepIdx += 1;
  if (st.stepIdx >= STEPS.length) {
    W.delete(st.cardId);
    void dropState(ctx, st.cardId);
    const r = await bindNow(ctx, st);
    try { const caps = ctx?.caps ?? ctx ?? {}; if (typeof caps.markdown === 'function') { await caps.markdown(r.text); return ''; } } catch { /* ignore */ }
    return r.text;
  }
  st.step = STEPS[st.stepIdx];
  st.page = 0;
  st.error = '';
  await paint(ctx, st);
  return '';
}

export default {
  name: ['会话列表', 'sessionlist', 'sessions'],
  description: '三步向导（工作区 → 该区会话 → 回灌模式）绑定任意已有会话，并给出可复制的路由模板',
  usage: '/会话列表',

  async handler(ctx) {
    KERNEL = ctx?.caps?.kernel ?? ctx?.kernel ?? KERNEL;
    CTX_CACHE.sender = ctx?.sender ?? ctx?.caps?.sender ?? CTX_CACHE.sender;
    CTX_CACHE.replyTarget = ctx?.replyTarget ?? ctx?.caps?.replyTarget ?? CTX_CACHE.replyTarget;
    try {
      const caps = ctx?.caps ?? {};
      const psid = String(caps.peerSessionId ?? '');
      if (psid) { CTX_CACHE.agentId = psid; CTX_CACHE.sessionId = psid; }
      if (!CTX_CACHE.sender) CTX_CACHE.sender = ctx?.bot ?? caps.sender ?? null;
      // ★ 把回调侧要用的一切**推给共享位**（回调可能是另一个模块实例，见文件头 SLOT 注释）
      publishShared({
        kernel: KERNEL,
        sender: CTX_CACHE.sender,
        replyTarget: CTX_CACHE.replyTarget,
        parentId: CTX_CACHE.agentId || CTX_CACHE.sessionId || '',
        dataRoot: dataRootOf(ctx),
      });
      void diag(`[handler] kernel=${!!KERNEL} sender=${!!CTX_CACHE.sender} rt=${!!CTX_CACHE.replyTarget} peerSessionId=${psid || '-'}`);
    } catch { /* ignore */ }

    const st = {
      picked: {},
      stepIdx: 0,
      step: STEPS[0],
      page: 0,
      options: [],
      cardId: '',
      error: '',
      parentId: CTX_CACHE.agentId || CTX_CACHE.sessionId || '',
      startedAt: Date.now(),
    };
    W.set('pending', st);
    await paint(ctx, st);
    W.delete('pending');
    W.set(st.cardId, st);
    return '';
  },

  async onInteraction(ctx, info) {
    const cardId = cn(info?.cardId);
    const bid = cn(info?.buttonId);
    adoptShared(ctx);
    let st = W.get(cardId);
    if (!st) {
      // ★ 命令侧与回调侧可能是**两个模块实例**（各自的 W 是空的）⇒ 回落到磁盘状态
      st = await loadState(ctx, cardId);
      if (st) W.set(cardId, st);
    }
    void diag(`[onInteraction] card=${cardId} btn=${bid} 命中=${!!st} keys=[${[...W.keys()].join(',')}] kernel=${!!kernelOf(ctx)}`);
    if (!st) return '这个向导已经过期了，重新发一次 /会话列表 吧～';
    if (st.startedAt && Date.now() - st.startedAt > MAX_PAGE_MS) { W.delete(cardId); void dropState(ctx, cardId); return '向导放太久了，重新发一次吧～'; }
    st.startedAt = st.startedAt ?? Date.now();

    if (bid === 'cancel') { W.delete(cardId); void dropState(ctx, cardId); return '已取消，没有绑定任何会话。'; }
    if (bid === 'noop') return '';
    if (bid === 'prev' || bid === 'next') {
      st.page = Math.max(0, st.page + (bid === 'next' ? 1 : -1));
      const ok = await paint(ctx, st);
      W.delete(cardId);
      W.set(st.cardId, st);
      void dropState(ctx, cardId);
      return ok ? `已翻到第 ${st.page + 1} 页 ✅（新卡片在上面）` : `翻页失败（第 ${st.page + 1} 页）`;
    }
    if (/^p\d+$/.test(bid)) {
      const idx = Number(bid.slice(1));
      const opt = st.options[idx];
      if (!opt) return '这个选项没了，翻一页再选～';
      st.picked[st.step] = opt;
      st.stepIdx += 1;
      void dropState(ctx, cardId);
      const done = await advance(ctx, st);
      return done || '';
    }
    return '';
  },
};
