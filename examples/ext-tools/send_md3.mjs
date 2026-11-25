/**
 * 扩展工具: send_md — markdown 富媒体通道(msg_type=2)
 *
 * 2026-10-22（主人口径）：**上传与改写全在扩展里做，不动插件源码**。
 *   正文写法：`![说明 #宽px #高px](本地绝对路径)`（尺寸可省）
 *   流程：扫本地图 → 读文件 → prepare → PUT 直传 → complete → 换成 QQ 图片引用 → 发卡
 *   · 任何一张传不上去 → **整条不发**
 *   · 全成功 → 回执报"上传 N/N 张" + 实际发送文本（自证用）
 *
 * 依赖：`env.qq.groupAdmin.apiCall`（账号包已暴露的群管理 API 通道）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const IMG_RE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^()\s]+))(?:\s+"[^"]*")?\s*\)/g;

function isLocalPath(p) {
  if (!p) return false;
  if (/^(https?:|qqbot-media:|data:)/i.test(p)) return false;
  if (/^file:\/\//i.test(p)) return true;
  return /^[A-Za-z]:[\/]/.test(p) || p.startsWith('/');
}

function stripFileUrl(p) {
  if (!/^file:\/\//i.test(p)) return p;
  const s = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ''));
  return /^\/[A-Za-z]:\//.test(s) ? s.slice(1) : s;
}

const CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const mk = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8L' && buf.length > 25) {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch { /* ignore */ }
  return { width: 0, height: 0 };
}

/** 用 globalThis.__qqbotAppCred 自建机器人 API 通道（不依赖 env.qq） */
async function botApi() {
  const cred = globalThis.__qqbotAppCred;
  if (!cred || !cred.appId || !cred.appSecret) return undefined;
  const g = globalThis;
  if (!g.__sendMdToken) g.__sendMdToken = { t: '', exp: 0 };
  const cache = g.__sendMdToken;
  const now = Date.now();
  if (cache.t && cache.exp > now) return makeApi(cache.t);
  try {
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: cred.appId, clientSecret: cred.appSecret }),
    });
    if (!res.ok) { globalThis.__sendMdTokenErr = 'HTTP ' + res.status; return undefined; }
    const j = await res.json();
    if (!j.access_token) { globalThis.__sendMdTokenErr = 'no-access_token: ' + JSON.stringify(j).slice(0, 120); return undefined; }
    cache.t = j.access_token;
    cache.exp = now + ((j.expires_in || 7200) - 60) * 1000;
    return makeApi(cache.t);
  } catch (e) { globalThis.__sendMdTokenErr = String(e && e.message || e); return undefined; }
}

function makeApi(token) {
  return async (method, path, body) => {
    try {
      const res = await fetch('https://api.sgroup.qq.com' + path, {
        method,
        headers: { Authorization: 'QQBot ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      return { ok: res.ok, data, err: res.ok ? undefined : { code: res.status, human: text.slice(0, 200) } };
    } catch (e) { return { ok: false, err: { human: String(e && e.message || e) } }; }
  };
}
async function uploadOne(api, localPath) {
  if (!existsSync(localPath)) return { ok: false, msg: '文件不存在' };
  const buf = readFileSync(localPath);
  if (!buf.length) return { ok: false, msg: '空文件' };
  if (buf.length > 10 * 1024 * 1024) return { ok: false, msg: '超过 10MB' };
  const ext = (localPath.split('.').pop() || '').toLowerCase();
  const contentType = CT[ext];
  if (!contentType) return { ok: false, msg: '只支持 png/jpeg/gif/webp: ' + ext };

  const md5 = createHash('md5').update(buf).digest('hex');
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const fileName = localPath.split(/[\/]/).pop() || ('image.' + ext);

  const r1 = await api('POST', '/v2/media-images/prepare', { file_name: fileName, file_size: buf.length, content_type: contentType, md5, sha1 });
  if (!r1 || r1.ok !== true) return { ok: false, msg: 'prepare 失败: ' + JSON.stringify(r1 && r1.err || '').slice(0, 160) };
  const d1 = r1.data || {};
  const uploadId = d1.upload_id;
  const putUrl = d1.presigned_url;
  if (!uploadId || !putUrl) return { ok: false, msg: 'prepare 缺字段: ' + JSON.stringify(d1).slice(0, 160) };

  try {
    const put = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: buf });
    if (!put.ok) return { ok: false, msg: 'PUT 失败 HTTP ' + put.status };
  } catch (e) {
    return { ok: false, msg: 'PUT 异常: ' + (e && e.message ? e.message : String(e)) };
  }

  const r3 = await api('POST', '/v2/media-images/complete', { upload_id: uploadId, md5 });
  if (!r3 || r3.ok !== true) return { ok: false, msg: 'complete 失败: ' + JSON.stringify(r3 && r3.err || '').slice(0, 160) };
  const d3 = r3.data || {};
  if (!d3.url) return { ok: false, msg: 'complete 缺 url: ' + JSON.stringify(d3).slice(0, 160) };

  const size = imageSize(buf);
  return { ok: true, url: String(d3.url), width: size.width, height: size.height };
}

export default {
  name: 'send_md3',
  description: "用 markdown 富媒体卡片发消息，正文里的本地图片自动上传。",
  inputSchema: {
    text: { type: 'string', required: true, description: 'markdown 正文（图片可写 ![说明 #宽px #高px](D:/path/x.jpg)）' },
    force: { type: 'boolean', description: 'true=强制走卡片通道(msg_type=2)' },
    buttons: {
      type: 'string',
      description: '可选：内联按钮，格式 "标签|链接,标签|链接"（最多 25 个，自动 5 个一行；只接受 http(s) 链接）',
    },
  },
  run: async (args, env) => {
    const text = String((args && args.text) || '');
    if (!text.trim()) return { ok: false, msg: 'text 为空, 没东西可发' };
    const sender = env && env.sender;
    const target = env && env.replyTarget;
    if (!sender || !target) return { ok: false, msg: '当前会话发送器未就绪(请在 QQ 会话里调用本工具)' };

    const hits = [];
    IMG_RE.lastIndex = 0;
    let m;
    while ((m = IMG_RE.exec(text)) !== null) {
      const alt = String(m[1] || '');
      const raw = String(m[2] || m[3] || '').trim();
      if (isLocalPath(raw)) hits.push({ raw: m[0], alt: alt, path: stripFileUrl(raw) });
    }

    let out = text;
    if (hits.length) {
      const qq = env && env.qq;
      // ① 插件给的 env.qq.apiCall ② 自建：用 globalThis.__qqbotAppCred 取 token
      // 契约（源码 2761 行）：run(args, env) 可拿 { cwd, manager, sender, replyTarget, logger }
      //   → **env.manager 才是正文用的那个句柄**（env.qq 只给 expose:all 的工具）
      const mgr = env && env.manager;
      const ga = mgr && mgr.groupAdmin;
      let api = (ga && typeof ga.apiCall === 'function') ? ga.apiCall.bind(ga) : undefined;
      if (typeof api !== 'function' && qq && typeof qq.apiCall === 'function') api = qq.apiCall;
      if (typeof api !== 'function') api = await botApi();
      if (typeof api !== 'function') {
        // 降级：没有上传通道时，用现成的 sendImage 把图单独发出去，卡片里去掉图片语法
        const sendImage = qq && qq.sendImage;
        if (typeof sendImage === "function") {
          const notes = [];
          for (const h of hits) {
            try { await sendImage("group", String(target.targetId || ""), h.path); notes.push(h.path.split(/[\/]/).pop()); } catch { /* ignore */ }
          }
          const stripped = text.replace(IMG_RE, "").trim();
          if (stripped) await sender.sendMarkdown(target, stripped);
          return { ok: true, msg: "🖼 降级发送：" + notes.length + "/" + hits.length + " 张图已单独发出（卡片内不含图）+ 文字卡片" };
        }
        const dbg = "qqKeys=" + Object.keys(qq || {}).join(",") + " | apiCall=" + typeof (qq && qq.apiCall) + " | sendImage=" + typeof (qq && qq.sendImage) + " | cred=" + JSON.stringify(globalThis.__qqbotAppCred || null) + " | tokenErr=" + String(globalThis.__sendMdTokenErr || '-');
        return { ok: false, msg: "❌ 未发送：拿不到上传通道（" + dbg + "）—— 本卡含 " + hits.length + " 张本地图" };
      }
      const lines = [];
      for (const h of hits) {
        let up;
        try { up = await uploadOne(api, h.path); } catch (e) { up = { ok: false, msg: '异常: ' + (e && e.message ? e.message : String(e)) }; }
        if (!up || up.ok !== true) {
          return { ok: false, msg: '❌ 未发送：' + (h.path.split(/[\/]/).pop() || h.path) + ' 上传失败（' + ((up && up.msg) || '未知') + '）' };
        }
        const note = h.alt.replace(/#\s*\d+\s*px/gi, '').trim() || (h.path.split(/[\/]/).pop() || 'image');
        const dim = up.width && up.height ? ' #' + up.width + 'px #' + up.height + 'px' : '';
        out = out.split(h.raw).join('![' + note + dim + '](' + up.url + ')');
        lines.push(note + ' -> ' + String(up.url).slice(0, 44));
      }
      globalThis.__sendMdLast = lines;
    }

    const wantForce = !!(args && (args.force === true || String(args.force) === 'true'));
    // ★ 2026-11-20（主人实测纠错）：LaTeX **只有 msg_type=2 才渲染**。
    //   而 sender.sendMarkdown 内部有一条"无 md 语法 → sendText(msg_type=0)"的降级
    //   （gateway/bootstrap.ts 的 hasMarkdownSyntax）⇒ 纯公式正文会被降成纯文本、显示成源码。
    //   本工具是"专门发 markdown"的通道，出现成对 $ 时**自动**走直发 msg_type=2 的分支
    //   （sender.sendMarkdownWithKeyboard 是 bot.send 显式 msgType:2，不经过降级）。
    const hasLatex = (() => {
      const t = String(out || '').replace(/\\\$/g, '');
      const block = /\$\$([\s\S]{0,4000}?)\$\$/.exec(t);
      const inline = /\$([^$\n]{0,2000})\$/.exec(t);
      // 内容必须含非空白字符（`$ $` / `$$ $$` 不算，CodeRabbit #76 第2条）
      return (!!block && /\S/.test(block[1])) || (!!inline && /\S/.test(inline[1]));
    })();
    // ★ 2026-11-24（主人要求）：支持内联按钮。用**跳转按钮**（action.type=0）——
    //   不需要卡表登记、不需要扩展收回调，点了直接开链接，最省事也最安全。
    //   ⚠️ QQ 硬限制：总行数 ≤ 5、每行 ≤ 5 个；超了会被拒且静默退化成纯文本。
    let keyboard;
    try {
      // 支持两种写法：字符串 "标签|链接,标签|链接"（主）/ 数组 [{label,url}]（兼容）
      const src = args && args.buttons;
      const raw = Array.isArray(src)
        ? src
        : String(src || '')
            .split(',')
            .map((s) => {
              const idx = s.indexOf('|');
              return idx < 0 ? null : { label: s.slice(0, idx), url: s.slice(idx + 1) };
            })
            .filter(Boolean);
      const items = raw
        .map((b) => ({
          label: String((b && b.label) || '').trim().slice(0, 18),
          url: String((b && b.url) || '').trim(),
        }))
        .filter((b) => b.label && /^https?:\/\//i.test(b.url))
        .slice(0, 25);   // 5 行 × 5 个
      if (items.length) {
        // 跳转按钮（type 0）：点了直接开链接，不需要卡表/回调
        const btns = items.map((b, i) => ({
          id: 'btn-' + i,
          render_data: { label: b.label, visited_label: '已打开', style: 1 },
          action: { type: 0, permission: { type: 2 }, data: b.url, unsupport_tips: '请在支持的客户端点击' },
        }));
        const rows = [];
        for (let i = 0; i < btns.length; i += 2) rows.push({ buttons: btns.slice(i, i + 2) });
        keyboard = { content: { rows: rows.slice(0, 5) } };
      }
    } catch {
      keyboard = undefined;   // 构造失败就当没有，绝不阻断正文
    }

    // ★ 2026-11-24 实测结论：**带 keyboard 走 SDK 的 sendMarkdownWithKeyboard 会被 QQ 拒**
    //   （「请求协议解析失败」，type 0/1、各种 id/permission 组合都试过）。
    //   而 /按钮测试 命令用 caps.api 直接 POST 同样的 body 是**成功**的 ⇒ 改走 api。
    if (keyboard && typeof env.api === 'function') {
      const gid = String((env.message && env.message.groupOpenid) || (env.peer && env.peer.peerId) || '');
      const uid = String((env.user && env.user.openid) || '');
      const path = gid ? '/v2/groups/' + gid + '/messages' : '/v2/users/' + uid + '/messages';
      const body = { msg_type: 2, markdown: { content: out }, keyboard, ...(gid ? {} : { content: out }) };
      let r;
      try {
        r = await env.api(path, { method: 'POST', body });
      } catch (e) {
        return { ok: false, msg: '❌ 未发送：' + (e && e.message ? e.message : String(e)) };
      }
      if (!r || r.ok === false) {
        return { ok: false, msg: '❌ 未发送：' + JSON.stringify(r && r.err ? r.err : r).slice(0, 300) };
      }
      const btnNote0 = '\n🔘 内联按钮 ' + keyboard.content.rows.reduce((n, row) => n + row.buttons.length, 0) + ' 个';
      return { ok: true, msg: '已用 markdown+按钮通道发出（caps.api）' + btnNote0 + '\n实际发送: ' + out.slice(0, 200) };
    }

    try {
      if (keyboard && typeof sender.sendMarkdownWithKeyboard === 'function') {
        await sender.sendMarkdownWithKeyboard(target, out, keyboard);
      } else if ((wantForce || hasLatex) && typeof sender.sendMarkdownWithKeyboard === 'function') {
        await sender.sendMarkdownWithKeyboard(target, out, undefined);
      } else {
        await sender.sendMarkdown(target, out);
      }
    } catch (e) {
      return { ok: false, msg: '❌ 未发送：' + (e && e.message ? e.message : String(e)) };
    }

    let extra = '';
    if (hits.length) {
      extra = '\n🖼 已上传 ' + hits.length + '/' + hits.length + ' 张本地图 → QQ 图片引用\n' + (globalThis.__sendMdLast || []).join('\n');
    }
    const btnNote = keyboard ? '\n🔘 内联按钮 ' + keyboard.content.rows.reduce((n, r) => n + r.buttons.length, 0) + ' 个' : '';
    return { ok: true, msg: '已用 markdown 通道发出(含 md 语法时走 msg_type=2)' + extra + btnNote + '\n实际发送: ' + out.slice(0, 260) };
  },
};
