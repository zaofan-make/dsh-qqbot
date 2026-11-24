/**
 * 按钮测试.mjs — `/按钮测试` 斜杠命令（带按钮卡片 + 一次性回调）
 *
 * ★ 2026-11-24 主人需求（原话）：
 *   「写一个斜杠命令，弹一个按钮卡片，按第一次，qq发消息显示这个是谁点的，
 *     再点一次，显示你好，然后消灭回调，第三次点就没用了」
 *
 * 状态机（按 cardId 存盘，跨"命令侧/回调侧两个模块实例"也能认出来）：
 *   step 0  → 点第一次：回「是 <openid>（昵称）点的」，step 改成 1
 *   step 1  → 点第二次：回「你好」，step 改成 2，**同时消灭回调**（卡表移除 + 状态删除）
 *   step ≥2 → 走不到这里：卡表里已经没有这张卡，插件不会派发（第三次点 = 没反应）
 *
 * ⚠️ 从 `/会话列表` 抄来的四条硬经验（都踩过，别再犯）：
 *   1. 按钮 id **绝不能带冒号** —— 插件把 button_data 拆成 `ext:<工具名>:<卡id>:<按钮id>`，
 *      要求恰好 3 段；带冒号会 split 出 4 段被静默丢弃（现象：点了只弹"操作成功"）。
 *   2. `TOOL` 必须与**文件名**、`name[0]` 三者一致，否则插件查表查不到。
 *   3. 命令侧 `ctx.caps` 有值，**回调侧的 ctx 是把能力平铺在自身**（没有 caps 键）
 *      ⇒ 一律写 `ctx?.caps ?? ctx`。
 *   4. QQ 内联键盘：总行数 ≤ 5、每行 ≤ 5 按钮，超了直接被拒（还会静默退化成纯文本）。
 */

const TOOL = '按钮测试';                 // ★ 必须与文件名一致
const CARD_EXPIRE_MS = 10 * 60_000;      // 卡表里保留多久
const STATE_EXPIRE_MS = 10 * 60_000;     // 状态文件里保留多久

const cn = (v) => (v === undefined || v === null ? '' : String(v));
const short = (s, n) => {
  const t = cn(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** dataRoot：命令侧从 caps，回调侧可能平铺 */
function dataRootOf(ctx) {
  const c = ctx?.caps ?? ctx ?? {};
  return cn(c.dataRoot || ctx?.dataRoot || '');
}

/** 状态文件（按 cardId 存 step） */
function stateFileOf(ctx) {
  const root = dataRootOf(ctx);
  return root ? `${root}/.qqbot/btn-test-state.json` : '';
}

async function readStates(ctx) {
  try {
    const { readFileSync } = await import('node:fs');
    const all = JSON.parse(readFileSync(stateFileOf(ctx), 'utf8'));
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

async function writeStates(ctx, all) {
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const f = stateFileOf(ctx);
    if (!f) return false;
    const now = Date.now();
    for (const k of Object.keys(all)) if (Number(all[k]?.expireAt ?? 0) < now) delete all[k];
    const keys = Object.keys(all);
    if (keys.length > 30) for (const k of keys.slice(0, keys.length - 30)) delete all[k];
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(all, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** 卡表：插件靠它决定"这个按钮事件归谁"，删掉 = 后续点击不再派发 */
function cardTableFile(ctx) {
  const root = dataRootOf(ctx);
  return root ? `${root}/.qqbot/ext-tool-cards.json` : '';
}

async function regCard(ctx, cardId, buttonIds) {
  const f = cardTableFile(ctx);
  if (!f) return false;
  try {
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    let table = { version: 1, cards: [] };
    try {
      table = JSON.parse(readFileSync(f, 'utf8')) ?? table;
    } catch {
      /* 首次或坏文件 */
    }
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
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(table, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** ★ 消灭回调：把这张卡从卡表里删掉 —— 之后点击插件不会再派发 */
async function killCard(ctx, cardId) {
  const f = cardTableFile(ctx);
  if (!f) return false;
  try {
    const { readFileSync, writeFileSync } = await import('node:fs');
    let table = { version: 1, cards: [] };
    try {
      table = JSON.parse(readFileSync(f, 'utf8')) ?? table;
    } catch {
      return false;
    }
    if (!Array.isArray(table.cards)) return false;
    const before = table.cards.length;
    table.cards = table.cards.filter((c) => !(c?.toolName === TOOL && c?.cardId === cardId));
    if (table.cards.length === before) return false;
    writeFileSync(f, JSON.stringify(table, null, 2));
    return true;
  } catch {
    return false;
  }
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
      rows: rows.map((r) => ({
        buttons: r.map((b) => ({ ...b, action: { ...b.action, data: `ext:${TOOL}:${cardId}:${b.id}` } })),
      })),
    },
  };
}

/**
 * 发卡（markdown + 按钮键盘）；四级兜底。
 * 返回 'kb' = 带按钮发出去了 / 'text' = 退化成纯文本（按钮没了）/ 'fail' = 什么都没发出去
 */
let LAST_ERR = '';
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
      if (r && r.ok !== false) {
        LAST_ERR = '';
        return 'kb';
      }
      LAST_ERR = cn(r?.err?.human ?? r?.err?.message ?? r?.err?.code ?? 'ok=false');
    } catch (e) {
      LAST_ERR = cn(e?.message ?? e);
    }
  }
  try {
    if (keyboard && typeof caps.markdownCard === 'function') {
      const r2 = await caps.markdownCard(text, keyboard);
      if (r2) return 'kb';
    }
  } catch {
    /* ignore */
  }
  try {
    if (keyboard && typeof ctx?.sender?.sendMarkdownWithKeyboard === 'function') {
      await ctx.sender.sendMarkdownWithKeyboard(ctx.replyTarget, text, keyboard);
      return 'kb';
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof caps.markdown === 'function' && (await caps.markdown(text))) return 'text';
  } catch {
    /* ignore */
  }
  return 'fail';
}

let seq = 0;

export default {
  name: ['按钮测试', 'btntest'],
  description: '弹一张带按钮的卡片：点第一次显示是谁点的，点第二次说你好并让这张卡失效',
  usage: '/按钮测试',

  async handler(ctx) {
    const cardId = `${TOOL}-${++seq}-${Date.now().toString(36)}`;
    const kb = keyboardOf([[btn('go', '点我试试', 1)]], cardId);

    const text = [
      '### 🔘 按钮测试',
      '',
      '这张卡只有 **两次** 有效点击：',
      '',
      '- 第一次：告诉你**是谁**点的',
      '- 第二次：说声「你好」，然后这张卡就**彻底失效**',
      '',
      '> 失效之后再点，不会有任何反应 —— 那正是"消灭回调"生效了。',
    ].join('\n');

    const mode = await sendCard(ctx, text, kb);

    // 登记卡表（插件靠它决定按钮事件归谁）
    const allIds = ['go'];
    try {
      const caps = ctx?.caps ?? ctx ?? {};
      if (typeof caps.registerInteractionCard === 'function') {
        caps.registerInteractionCard({ cardId, buttonIds: allIds, expireAt: Date.now() + CARD_EXPIRE_MS });
      }
    } catch {
      /* ignore */
    }
    await regCard(ctx, cardId, allIds);

    // 状态落盘（回调侧可能是另一个模块实例）
    const all = await readStates(ctx);
    all[cardId] = { step: 0, createdAt: Date.now(), expireAt: Date.now() + STATE_EXPIRE_MS };
    await writeStates(ctx, all);

    if (mode !== 'kb') {
      return mode === 'text'
        ? `按钮没发出去（QQ 拒了键盘：${short(LAST_ERR, 60) || '未知'}），只能纯文本显示`
        : '卡片完全没发出去（当前环境可能不支持富文本卡片）';
    }
    return '';
  },

  async onInteraction(ctx, info) {
    const cardId = cn(info?.cardId);
    const bid = cn(info?.buttonId);

    // ★ 点击者身份：**扩展命令的回调 ctx 用 performer，不是 actor**
    //   （2026-11-24 真机实测：ctx 顶层键里有 performer，actor 是 null；
    //     performer = { openid, name, isOwner }，isOwner 已按 owners 算好。
    //     再兜底一次 event.group_member_openid —— QQ 的 type=11 事件里它是有的）
    const perf = (ctx?.performer ?? ctx?.caps?.performer ?? {}) || {};
    const ev = (info?.event ?? {}) || {};
    const openid = cn(perf.openid) || cn(ev.group_member_openid) || cn(ev.user_openid);
    const name = cn(perf.name);
    const isOwner = perf.isOwner === true;

    const all = await readStates(ctx);
    const st = all[cardId];

    // 状态没了（已用过 / 已过期）—— 理论上卡表也已删，走不到这里；留着兜底
    if (!st) return '这张卡已经失效啦～ 重新发一次 /按钮测试 吧';

    if (bid !== 'go') return '';

    const who = openid
      ? `${openid}${name ? `（${name}）` : ''}${isOwner ? ' 👑' : ''}`
      : '（拿不到 openid，可能是匿名/系统事件）';

    // ── 第一次点：告诉他"是谁点的" + 把所有可用字段打出来（诊断用）──
    if (Number(st.step ?? 0) === 0) {
      st.step = 1;
      st.firstBy = openid;
      all[cardId] = st;
      await writeStates(ctx, all);

      // 拿得到就直接说"是谁"；拿不到才打诊断（避免每次点都刷一屏）
      if (openid) {
        const label = name || `${openid.slice(0, 8)}…`;
        return `👉 是 ${label}${isOwner ? ' 👑（主人）' : ''} 点的\n\nopenid：\`${openid}\``;
      }
      const evKeys = Object.keys(ev).sort();
      const L = [];
      L.push('⚠️ 拿不到 openid —— 把下面这段发给我');
      L.push('');
      L.push('**ctx 顶层键**：' + (Object.keys(ctx ?? {}).sort().join(', ') || '(空)'));
      L.push('performer = ' + JSON.stringify(perf));
      L.push('event 顶层键：' + (evKeys.join(', ') || '(空)'));
      L.push('event.group_member_openid = ' + String(ev.group_member_openid));
      L.push('event.user_openid = ' + String(ev.user_openid));
      return L.join('\n');
    }

    // ── 第二次点：说你好，然后**消灭回调** ──
    if (Number(st.step ?? 0) === 1) {
      // 先删状态、再删卡表 —— 顺序无所谓，但两个都要删干净
      delete all[cardId];
      await writeStates(ctx, all);
      const killed = await killCard(ctx, cardId);
      return [
        `你好呀 ${name || (openid ? openid.slice(0, 8) + '…' : '朋友')} 👋`,
        '',
        killed ? '这张卡的回调已经**消灭**了 —— 再点不会有任何反应。' : '（卡表没删成功，但状态已清，再点会提示失效）',
      ].join('\n');
    }

    // 兜底：step 异常
    delete all[cardId];
    await writeStates(ctx, all);
    await killCard(ctx, cardId);
    return '这张卡已经用完了～';
  },
};
