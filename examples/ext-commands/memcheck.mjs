/**
 * memcheck.mjs —— 内存自检（2026-11-13 主人要求）
 *
 * 用法：
 *   /memcheck            看本进程内存 + 插件各缓存条数 + 记忆插件的向量配置
 *   /memcheck top        额外列出最大的 5 个会话事件数（找"哪个会话在涨"）
 *
 * 背景：宿主 OOM 崩过一次（`Ineffective mark-compacts near heap limit`，堆 3.4GB），
 * 崩之前没有任何证据。这个命令就是给"崩之前留证"用的。
 *
 * 实现：插件在 bootstrap 里把采集器挂到
 *   `globalThis[Symbol.for('im-qqbot.memstats')]`
 * 命令跑在同一进程，直接读；没挂上就退化成只报 `process.memoryUsage()`。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MEM_KEY = Symbol.for('im-qqbot.memstats');

function mb(n) {
  const v = Number(n) || 0;
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

function kernelOf(ctx) {
  const c = ctx ?? {};
  for (const v of [c?.caps?.kernel, c?.kernel]) if (v) return v;
  return null;
}

function svcOf(ctx, name) {
  const k = kernelOf(ctx);
  if (!k) return null;
  try { if (typeof k.get === 'function') { const v = k.get(name); if (v) return v; } } catch { /* ignore */ }
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

/** 记忆插件的向量配置（第三方 @a9i5k4/dsh-auto-memory 等）：有就是在跑本地模型 */
function memoryPluginInfo() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
  const out = [];
  const cfg = join(home, 'memory', 'semantic', 'embedding-config.json');
  try {
    if (existsSync(cfg)) {
      const j = JSON.parse(readFileSync(cfg, 'utf8'));
      out.push(`向量配置: provider=${j.provider ?? '?'} dim=${j.dimension ?? '?'} gpu=${j.gpu ?? '?'}`);
      out.push(`  模型: ${String(j.modelDir ?? '')}/${String(j.onnxFile ?? '')}`);
    } else {
      out.push('向量配置: 无（可能只跑词法）');
    }
  } catch (e) {
    out.push('向量配置读取失败: ' + (e && e.message));
  }
  try {
    const dir = join(home, 'memory', 'semantic');
    if (existsSync(dir)) {
      let total = 0, files = 0;
      for (const f of readdirSync(dir)) {
        try { const st = statSync(join(dir, f)); if (st.isFile()) { total += st.size; files++; } } catch { /* ignore */ }
      }
      out.push(`语义索引: ${files} 个文件 / ${mb(total)}`);
    }
  } catch { /* ignore */ }
  return out;
}

function sessionTop(ctx, n = 5) {
  const ss = svcOf(ctx, 'sessions');
  const rows = [];
  if (ss && typeof ss.list === 'function') {
    let arr = [];
    try { arr = ss.list() || []; } catch { arr = []; }
    for (const it of arr) {
      const events = Array.isArray(it?.log) ? it.log.length : 0;
      rows.push({ id: String(it?.id ?? '').slice(0, 8), events });
    }
  }
  rows.sort((a, b) => b.events - a.events);
  return rows.slice(0, n);
}

export default {
  name: ['memcheck', 'mem'],
  description: '内存自检：进程内存 / 插件缓存条数 / 记忆插件向量配置 / 事件最多的会话',
  usage: '/memcheck [top]',
  handler: (ctx) => {
    const L = [];
    const m = process.memoryUsage();
    const L0 = [];
    const S = globalThis[MEM_KEY];
    let snap = null;
    if (typeof S === 'function') { try { snap = S(); } catch { snap = null; } }
    const pick = (k, d) => (snap && snap[k] != null ? snap[k] : d);

    L.push('🧠 内存自检');
    L.push(`进程: rss=${mb(m.rss)} | heapUsed=${mb(m.heapUsed)} / heapTotal=${mb(m.heapTotal)} | external=${mb(m.external)}`);
    if (snap) {
      L.push(`插件: 活跃会话 ${pick('sessions', '?')} 个 | 图片路径缓存 ${pick('imagePathCache', '?')} 条`);
    } else {
      L.push('插件: 采集器未挂上（旧版本 or 未重启）—— 只报进程级数字');
    }

    // Node 默认老生代上限（约 4GB）；给出"还剩多少"比看绝对数更直观
    try {
      const heapLimit = (require('node:v8').getHeapStatistics().heap_size_limit) || 0;
      if (heapLimit) {
        const pct = ((m.heapUsed / heapLimit) * 100).toFixed(1);
        L.push(`堆上限: ${mb(heapLimit)} | 已用 ${pct}%`);
      }
    } catch { /* ESM 下 require 不可用，忽略 */ }

    L.push('');
    for (const line of memoryPluginInfo()) L.push(line);

    if (String(ctx?.command?.raw ?? '').trim().toLowerCase() === 'top') {
      L.push('');
      L.push('事件最多的会话（事件数≈上下文体积）:');
      for (const r of sessionTop(ctx, 5)) L.push(`  ${r.id} → ${r.events} 条`);
    } else {
      L.push('');
      L.push('想看哪个会话最大：/memcheck top');
    }
    return L.join('\n').slice(0, 3000);
  },
};
