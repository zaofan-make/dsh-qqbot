/**
 * dshapi.mjs —— 探测宿主 0.2.2 新服务是否可用（2026-11-13 主人要求）
 *
 * 用法：
 *   /dshapi            概览：8 个目标服务「有没有 + 形状」
 *   /dshapi title      会话标题（session-title）
 *   /dshapi stats      会话统计（session-stats）
 *   /dshapi market     插件市场/更新判定（pluginManager.listBundles）
 *   /dshapi present    工具呈现（agent-tool-presentation）
 *   /dshapi cwd        工具工作目录（tool-working-directory）
 *   /dshapi quotes     引用呈现（message-quotes）
 *   /dshapi ckpt       检查点策略（session-checkpoint-policy）
 *   /dshapi batch      工具批处理（tools 服务的并行线索）
 *
 * 设计约束（都是踩坑来的）：
 *   · cordis 的 `ctx` / `caps` 是 getter，未 inject 时**读取即抛** → 一切包 try，绝不放进数组字面量顺手取
 *   · 命令走独立通道（不激活回合），所以这能干净地反映「不问 AI 时能拿到什么」
 *   · 输出控制长度（QQ 单条消息有上限），每项最多几行
 */

const TARGETS = {
  title: ['sessionTitle', 'sessionTitles', 'session-title'],
  stats: ['sessionStats', 'session-stats', 'sessionProjections', 'stats'],
  market: ['pluginManager', 'pluginMarket', 'plugin-market'],
  present: ['agentToolPresentation', 'toolPresentation', 'toolPresentationSelector'],
  cwd: ['toolWorkingDirectory', 'workingDirectory'],
  quotes: ['messageQuotes', 'sessionMessageQuotes', 'messageQuote', 'quotes'],
  ckpt: ['sessionCheckpointPolicy', 'checkpointPolicy', 'checkpoint', 'sessionDurability'],
  batch: ['tools', 'toolRuntime'],
  ws: ['workspaceRegistry', 'workspaces'],
};

let KERNEL = null;

function kernelOf(ctx) {
  if (KERNEL) return KERNEL;
  const c = ctx ?? {};
  for (const v of [c?.caps?.kernel, c?.kernel]) if (v) return v;
  return null;
}

/** 安全取服务：逐个 try，绝不把 getter 放进数组字面量 */
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

/** 第一次取到的服务（多个候选名里挑一个） */
function pick(ctx, names) {
  for (const n of names) {
    const v = svcOf(ctx, n);
    if (v) return { name: n, svc: v };
  }
  return null;
}

function shape(v) {
  if (v == null) return '空';
  if (typeof v !== 'object') return typeof v;
  try {
    const keys = Object.keys(v).slice(0, 10);
    const fns = keys.filter((k) => { try { return typeof v[k] === 'function' } catch { return false } });
    return '{' + keys.join(',') + '}' + (fns.length ? ` 可调用:${fns.slice(0, 6).join('/')}` : '');
  } catch (e) {
    return '不可读(' + (e && e.message ? e.message : String(e)) + ')';
  }
}

/* ───────── 各子项 ───────── */

function probeTitle(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.title);
  L.push('【session-title】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有这个服务（可能是 0.2.2 之后才有，或名字不同）'));
  if (s) L.push('  形状: ' + shape(s.svc));

  // 关键验证：已结束/历史会话能不能拿到标题
  const sessions = svcOf(ctx, 'sessions');
  if (!sessions || typeof sessions.list !== 'function') {
    L.push('  ⚠️ 拿不到 sessions 服务，无法列表');
    return L;
  }
  let list = [];
  try { list = sessions.list() || []; } catch (e) { L.push('  sessions.list() 抛错: ' + (e && e.message)); return L; }
  // 本会话 id：命令侧能拿到的都试一遍（不同版本挂在不同位置）
  let myId = '';
  for (const v of [ctx?.sessionId, ctx?.peerSessionId, ctx?.caps?.sessionId, ctx?.agentId, ctx?.caps?.agentId, ctx?.message?.sessionId]) {
    if (typeof v === 'string' && v) { myId = v; break }
  }
  L.push(`  sessions.list() 共 ${list.length} 个 | 本会话 id=${myId ? myId.slice(0, 12) + '…' : '拿不到'}`);
  // 本会话单独查
  if (myId) {
    const me = list.find((it) => String(it?.id || '') === myId);
    if (!me) L.push('  ⚠️ list 里没有本会话（可能已回收/不在当前 profile）');
    else {
      let t = '';
      try { t = String(me?.header?.title ?? me?.title ?? '') } catch { /* ignore */ }
      if (!t) {
        try {
          const log = me?.log || [];
          for (let i = log.length - 1; i >= 0 && i > log.length - 200; i--) {
            if (log[i]?.type === 'session/title') { t = String(log[i]?.data?.title || ''); break }
          }
        } catch { /* ignore */ }
      }
      L.push(`  ★ 本会话标题: ${t || '（空 —— 还没生成）'}`);
      // 试标题服务本身
      // ⚠️ 2026-11-13 实测：`sessionTitle.get(id字符串)` 会抛
      //   "session.snapshotEvents is not a function" —— 说明它要的是 **Session 对象**，不是 id。
      //   所以这里**两种都试**：先传 sessions.list() 里的那个对象，再传 id（对比报错）。
      try {
        const a = s.svc;
        for (const fnName of ['get', 'of', 'title', 'current', 'read']) {
          if (typeof a?.[fnName] !== 'function') continue;
          try {
            const r = a[fnName](me);
            L.push(`  ${fnName}(Session对象) = ${JSON.stringify(r ?? null).slice(0, 100)}`);
          } catch (e) {
            L.push(`  ${fnName}(Session对象) 抛错: ${e && e.message}`);
          }
        }
      } catch { /* ignore */ }
      // 配置与当前 work 状态（能不能生成标题就看这里）
      try {
        const cfg = s.svc?.config;
        L.push('  config: ' + JSON.stringify(cfg ?? null).slice(0, 200));
      } catch (e) { L.push('  读 config 抛错: ' + (e && e.message)); }
      try {
        const work = s.svc?.work;
        L.push('  work: ' + (typeof work === 'object' ? JSON.stringify(Object.keys(work || {})).slice(0, 120) : typeof work));
      } catch { /* ignore */ }
    }
  }
  const withTitle = [];
  for (const it of list.slice(0, 40)) {
    let t = '';
    try { t = String(it?.header?.title ?? it?.title ?? '') } catch { /* ignore */ }
    if (!t) {
      // 老办法：翻 log 找 session/title
      try {
        const log = it?.log || [];
        for (let i = log.length - 1; i >= 0 && i > log.length - 60; i--) {
          if (log[i]?.type === 'session/title') { t = String(log[i]?.data?.title || ''); break }
        }
      } catch { /* ignore */ }
    }
    if (t) withTitle.push({ id: String(it?.id || '').slice(0, 8), t, live: !!it?.surfaceManager });
  }
  L.push(`  能取到标题的: ${withTitle.length} 个`);
  for (const x of withTitle.slice(0, 8)) L.push(`    ${x.live ? '[live]' : '[存档]'} ${x.id} → ${x.t.slice(0, 24)}`);
  const archivedWithTitle = withTitle.filter((x) => !x.live).length;
  L.push(archivedWithTitle > 0
    ? `  ✅ 存档会话也能拿到标题（${archivedWithTitle} 个）→ 手册 §11.22 那条可以改`
    : '  ⚠️ 存档会话仍拿不到标题 → 手册 §11.22 依然成立');
  return L;
}

function probeStats(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.stats);
  L.push('【session-stats】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (!s) return L;
  L.push('  形状: ' + shape(s.svc));
  try {
    const keys = Object.keys(s.svc || {});
    L.push('  键: ' + keys.slice(0, 12).join(','));
    for (const k of keys.slice(0, 6)) {
      try { if (typeof s.svc[k] === 'function') L.push(`    ${k}() 可调用`); } catch { /* ignore */ }
    }
  } catch (e) { L.push('  读取失败: ' + (e && e.message)); }
  return L;
}

function probeMarket(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.market);
  L.push('【pluginManager / market】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (!s) return L;
  L.push('  形状: ' + shape(s.svc));
  let bundles = [];
  try {
    const r = s.svc.listBundles?.();
    bundles = Array.isArray(r) ? r : (r?.bundles || []);
  } catch (e) { L.push('  listBundles() 抛错: ' + (e && e.message)); return L; }
  L.push(`  listBundles() = ${bundles.length} 个`);
  if (bundles.length) {
    const sample = bundles.slice(0, 6);
    for (const b of sample) {
      const upd = 'update' in (b || {}) ? b.update : ('updatable' in (b || {}) ? '(旧字段 updatable=' + b.updatable + ')' : '?');
      const nm = String(b?.name || b?.id || b?.spec || '?').slice(0, 40);
      L.push(`    ${nm} → update=${JSON.stringify(upd)}`);
    }
    const hasNew = sample.some((b) => 'update' in (b || {}));
    L.push(hasNew ? '  ✅ 已是新字段 update（可用来做「有新版本」提示）' : '  ⚠️ 还是旧字段 updatable');
  }
  return L;
}

function probePresent(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.present);
  L.push('【agent-tool-presentation】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (s) L.push('  形状: ' + shape(s.svc));
  return L;
}

function probeCwd(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.cwd);
  L.push('【tool-working-directory】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (s) L.push('  形状: ' + shape(s.svc));
  return L;
}

function probeQuotes(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.quotes);
  L.push('【message-quotes】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (s) L.push('  形状: ' + shape(s.svc));
  return L;
}

function probeCkpt(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.ckpt);
  L.push('【session-checkpoint-policy】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (s) L.push('  形状: ' + shape(s.svc));
  return L;
}

function probeBatch(ctx) {
  const L = [];
  const s = pick(ctx, TARGETS.batch);
  L.push('【tools（批处理线索）】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (!s) return L;
  L.push('  形状: ' + shape(s.svc));
  let defs = [];
  try {
    const r = s.svc.list?.() ?? s.svc.all?.() ?? s.svc.definitions?.();
    defs = Array.isArray(r) ? r : [];
  } catch { /* ignore */ }
  if (defs.length) {
    L.push(`  当前注册工具 ${defs.length} 个`);
    const one = defs[0] || {};
    const keys = Object.keys(one).slice(0, 12);
    L.push('  单个工具定义键: ' + keys.join(','));
    const par = defs.filter((d) => ['executionMode', 'parallel', 'exclusive', 'mode'].some((k) => k in (d || {}))).length;
    L.push(par > 0 ? `  ✅ ${par} 个工具带执行模式字段（并行分类就靠它）` : '  ℹ️ 工具定义里没有执行模式字段 → 并行分类在宿主内部（batch.ts），扩展无感');
  } else {
    L.push('  （拿不到工具清单：list()/all() 都没有或抛错）');
  }
  return L;
}

/**
 * workspaceRegistry —— **宿主 UI 那颗「筛选会话 / 隐藏已归档」就是它**（2026-11-13 查到）。
 * 它启动时把 header 全量索引进内存，并维护 registry 级的 `archivedSessionIds`。
 * 所以「列会话」不该再去 `sessionPersistence.list()` 扫盘 —— 直接问它。
 */
function probeWs(ctx) {
  const L = [];
  const s = pick(ctx, ['workspaceRegistry', 'workspaces', 'workspace']);
  L.push('【workspaceRegistry】' + (s ? `✅ kernel.get('${s.name}')` : '❌ 没有'));
  if (!s) return L;
  const a = s.svc;
  try { L.push('  形状: ' + shape(a)); } catch { /* ignore */ }
  try {
    const ids = a.archivedSessionIds;
    L.push('  archivedSessionIds: ' + (Array.isArray(ids) ? `${ids.length} 个` : typeof ids));
  } catch (e) { L.push('  读 archivedSessionIds 抛错: ' + (e && e.message)); }
  try {
    const pinned = a.pinnedSessionIds;
    L.push('  pinnedSessionIds: ' + (Array.isArray(pinned) ? `${pinned.length} 个` : typeof pinned));
  } catch { /* ignore */ }
  let list = [];
  try { list = a.list() || []; } catch (e) { L.push('  list() 抛错: ' + (e && e.message)); return L; }
  L.push(`  list() = ${list.length} 个工作区`);
  // 看一个工作区的形状 + 有没有直接给会话 header
  const one = list[0];
  if (one) {
    // 2026-11-13：重点看 `record`（工作区记录）里有没有会话元数据（标题/时间），
    // 以及 sessionIds 是不是原型上的 getter —— 决定我们能不能完全不再扫盘。
    try { L.push('  首个工作区 record: ' + JSON.stringify(one.record ?? null).slice(0, 300)); } catch { /* ignore */ }
    try {
      const ids = one.sessionIds;
      L.push('  sessionIds 类型=' + (Array.isArray(ids) ? `数组(${ids.length})` : typeof ids) + ' | 前 3: ' + JSON.stringify((ids || []).slice(0, 3)));
    } catch (e) { L.push('  读 sessionIds 抛错: ' + (e && e.message)); }
    try {
      const total = list.reduce((n, w) => n + ((w.sessionIds || []).length), 0);
      L.push(`  全部工作区 sessionIds 合计 = ${total}（对比 sessionPersistence 的 1697）`);
    } catch { /* ignore */ }
    try { L.push('  单个工作区键: ' + Object.keys(one).slice(0, 10).join(',')); } catch { /* ignore */ }
    for (const k of ['sessions', 'sessionIds', 'headers', 'sessionHeaders']) {
      try {
        const v = one[k];
        if (v == null) continue;
        L.push(`    ${k} = ${Array.isArray(v) ? v.length + ' 项' : typeof v}`);
        if (Array.isArray(v) && v.length) {
          const it = v[0];
          L.push('      首项: ' + (typeof it === 'string' ? it.slice(0, 12) : JSON.stringify(Object.keys(it || {})).slice(0, 120)));
        }
      } catch { /* ignore */ }
    }
  }
  return L;
}

const SUBS = {
  title: probeTitle, stats: probeStats, market: probeMarket, present: probePresent,
  cwd: probeCwd, quotes: probeQuotes, ckpt: probeCkpt, batch: probeBatch, ws: probeWs,
};

function overview(ctx) {
  KERNEL = KERNEL ?? kernelOf(ctx);
  const L = ['【DSH 0.2.2 新服务探测】kernel=' + (KERNEL ? '✅' : '❌')];
  for (const [key, names] of Object.entries(TARGETS)) {
    const hit = pick(ctx, names);
    L.push(`  ${key.padEnd(8)} ${hit ? '✅ ' + hit.name : '❌ 无（试过 ' + names.join('/') + '）'}`);
  }
  L.push('');
  L.push('细看：/dshapi title | stats | market | present | cwd | quotes | ckpt | batch');
  return L;
}

export default {
  name: ['dshapi', 'dsh-api'],
  description: '探测 DSH 0.2.2 新服务（标题/统计/市场/呈现/工作目录/引用/检查点/批处理）',
  usage: '/dshapi [title|stats|market|present|cwd|quotes|ckpt|batch]',
  handler: (ctx) => {
    KERNEL = KERNEL ?? kernelOf(ctx);
    const arg = String(ctx?.command?.raw ?? '').trim().toLowerCase();
    const fn = SUBS[arg];
    try {
      const lines = fn ? fn(ctx) : overview(ctx);
      return lines.join('\n').slice(0, 3500);
    } catch (e) {
      return '探测失败: ' + (e && e.message ? e.message : String(e));
    }
  },
};
