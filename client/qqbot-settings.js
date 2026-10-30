/* qqbot-settings — browser half (hand-written __ModuleLoader__ bundle, no build step).
 * 在设置页新增「QQ 机器人 (im-qqbot)」整页: 读/写 im-qqbot settings ns,
 * 数据经 host 半边同源路由 /api/qqbot-settings/{read,update}。
 */
window.__ModuleLoader__.load({
  id: '@zaofan/dsh-qqbot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var READ = 'api/qqbot-settings/read'
    var UPDATE = 'api/qqbot-settings/update'

    var labelStyle = { display: 'block', margin: '6px 0', fontSize: 13 }
    var inputStyle = { marginLeft: 8, padding: '2px 6px', border: '1px solid #8884', borderRadius: 4, background: 'transparent', color: 'inherit', width: 110 }
    var wideStyle = { ...inputStyle, width: 260 }
    var fullStyle = { ...inputStyle, width: '92%', display: 'block', margin: '4px 0 8px' }
    var boxStyle = { border: '1px solid var(--qqs-border,#e5e6eb)', borderRadius: 8, padding: '10px 14px 12px', margin: '8px 0', background: 'var(--qqs-card,#fff)' }
    var sectionTitle = { fontWeight: 600, margin: '10px 0 4px', fontSize: 14, color: 'var(--qqs-text,#1f2329)' }

    // ── 迷你设计系统(2026-09-05 专家团定稿; 深色柔和适配宿主, 不刺眼) ──
    // 宿主 dsh web 为深色主题 → 卡片用半透明深色、文字浅色、主色用低饱和紫(贴合 #9775fa 系)
    var T = {
      // 2026-10-22 P0：结构色改走 CSS token（定义在 QQS_THEME_CSS，宿主切 body[data-ds-dark-theme] 时自动变）
      // 每个 var 都带亮色回退：变量表没加载时回退亮色，绝不出现 unset/透明
      bg: 'transparent',
      card: 'var(--qqs-card,#ffffff)', cardHi: 'var(--qqs-card-hi,#fafafa)', cardSolid: 'var(--qqs-card-solid,#f4f5f8)',
      border: 'var(--qqs-border,#e2e5ea)', borderLight: 'var(--qqs-border-light,#eef0f3)',
      text: 'var(--qqs-text,#1f2329)', text2: 'var(--qqs-text2,#4e5560)', text3: 'var(--qqs-text3,#8a919c)',
      dangerSoft: '#e5484d88',
      primary: '#7c6cf0', primary2: '#6b5ae6', primaryBg: 'var(--qqs-primary-bg,#7c6cf01a)', primaryBorder: 'var(--qqs-primary-border,#7c6cf04d)',
      danger: '#e5484d', dangerBg: '#e5484d14',
      success: '#1f9e4f', successBg: '#1f9e4f14',
      warn: '#d97706', warnBg: '#d9770614',
      radius: 6, radiusLg: 10,
      shadow: 'none',
      fs: 13, fsSm: 12, fsTitle: 14,
    }
    var pageBg = { background: T.bg, borderRadius: T.radiusLg, padding: '12px 16px', minHeight: 300 }
    var card = { background: T.card, border: '1px solid ' + T.border, borderRadius: T.radius }
    function btnStyle(variant, size) {
      var base = {
        border: '1px solid ' + T.border, borderRadius: T.radius, cursor: 'pointer', font: 'inherit',
        padding: size === 'sm' ? '2px 10px' : '4px 14px', fontSize: size === 'sm' ? 12 : 13, lineHeight: '20px', whiteSpace: 'nowrap',
        transition: 'background .15s, border-color .15s, color .15s',
      }
      if (variant === 'primary') return { ...base, background: T.primaryBg, color: 'var(--qqs-primary-fg,#6b5ae6)', borderColor: T.primaryBorder, fontWeight: 600 }
      if (variant === 'danger') return { ...base, background: T.dangerBg, color: T.danger, borderColor: '#f7656044', fontWeight: 600 }
      if (variant === 'ghost') return { ...base, background: 'transparent', color: T.text2 }
      return { ...base, background: T.card, color: T.text }
    }
    function SButton(props) {
      return h('button', { className: 'qqs-btn', style: btnStyle(props.variant, props.size), disabled: props.disabled, onClick: props.onClick }, props.children)
    }
    // 状态条: tone=info/danger/success/warn; 深色柔底 + 左圆标; action=可选右侧行动按钮
    function StatusBar(props) {
      var m = { info: [T.primaryBg, T.primary], danger: [T.dangerBg, T.danger], success: [T.successBg, T.success], warn: [T.warnBg, T.warn] }[props.tone || 'info'] || [T.primaryBg, T.primary]
      var icon = props.tone === 'danger' ? '!' : props.tone === 'success' ? '✓' : props.tone === 'warn' ? '⚠' : 'i'
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, background: m[0], border: '1px solid ' + m[1] + '44', borderRadius: T.radius, padding: '6px 12px', margin: '8px 0', fontSize: T.fsSm } },
        h('span', { style: { flexShrink: 0, width: 18, height: 18, borderRadius: '50%', background: m[1], color: '#fff', textAlign: 'center', lineHeight: '18px', fontSize: 11, fontWeight: 700 } }, icon),
        h('span', { style: { flex: 1, color: m[1] } }, props.children),
        props.action ? h(SButton, { variant: props.tone === 'danger' ? 'danger' : 'primary', size: 'sm', onClick: props.action.onClick }, props.action.label) : null)
    }
    // 空状态
    function Empty(props) {
      return h('div', { style: { padding: '36px 0', textAlign: 'center', color: T.text3 } },
        h('div', { style: { fontSize: 34, marginBottom: 8, opacity: .5 } }, props.icon || '🕳'),
        h('div', { style: { fontSize: T.fsSm } }, props.text || '暂无数据'))
    }
    // 简易表格: cols=[{key,title,width?,render?}], rows=[]; 空态走 Empty (深色适配)
    function DataTable(props) {
      var cols = props.cols || []
      var rows = props.rows || []
      if (rows.length === 0) return h(Empty, { text: props.emptyText || '暂无数据' })
      return h('div', { style: { border: '1px solid #dde1e7', borderRadius: T.radius, overflow: 'hidden', background: T.card } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: T.fsSm } },
          h('thead', null, h('tr', { style: { background: T.cardHi } },
            cols.map(function (c) { return h('th', { key: c.key, style: { padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: T.text2, borderBottom: '1px solid #dde1e7', width: c.width || undefined } }, c.title) }))),
          h('tbody', null, rows.map(function (r, i) {
            return h('tr', { key: i, style: { background: i % 2 ? T.card : T.cardHi } },
              cols.map(function (c) {
                var v = r[c.key]
                var cell = c.render ? c.render(v, r) : (v === null || v === undefined ? '' : String(v))
                return h('td', { key: c.key, style: { padding: '8px 10px', borderBottom: '1px solid #eef0f3', color: T.text } }, cell)
              }))
          }))))
    }
    // 横排 TabBar: items=[{key,label,badge?}]
    function TabBar(props) {
      return h('div', { style: { display: 'flex', gap: 2, borderBottom: '1px solid ' + T.border, marginBottom: 4 } },
        (props.items || []).map(function (it) {
          var on = it.key === props.value
          return h('div', { key: it.key, onClick: function () { props.onChange && props.onChange(it.key) }, style: { cursor: 'pointer', padding: '8px 14px', fontSize: T.fsSm, color: on ? T.primary : T.text2, fontWeight: on ? 600 : 400, borderBottom: on ? '2px solid ' + T.primary : '2px solid transparent', marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6 } },
            it.label,
            it.badge > 0 ? h('span', { style: { background: T.danger, color: '#fff', borderRadius: 9, padding: '0 6px', fontSize: 11, lineHeight: '16px', fontWeight: 700 } }, it.badge) : null)
        }))
    }

    // 可搜索选择器(选聊天对象用): 点击弹出候选浮层, 输入即过滤; 选中回调 onPick({scope,id,name})
    function TargetPicker(props) {
      var [open, setOpen] = useState(false)
      var [q, setQ] = useState('')
      var val = props.value || {}
      function cands() {
        var all = props.options || []
        var t = q.trim().toLowerCase()
        if (!t) return all
        return all.filter(function (c) { return (c.name || '').toLowerCase().indexOf(t) >= 0 || String(c.id).toLowerCase().indexOf(t) >= 0 })
      }
      var gs = cands().filter(function (c) { return c.scope === 'group' })
      var cs = cands().filter(function (c) { return c.scope === 'c2c' })
      var label = val.name || (val.targetId ? String(val.targetId).slice(0, 8) : '')
      var sec = { fontSize: 10, color: T.text3, padding: '3px 6px 1px', fontWeight: 600 }
      var item = { cursor: 'pointer', padding: '4px 8px', borderRadius: 4, fontSize: T.fsSm, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
      function pick(c) { setOpen(false); setQ(''); props.onPick && props.onPick({ scope: c.scope, id: c.id, name: c.name || '' }) }
      return h('div', { style: { position: 'relative', flex: 1, minWidth: 0 } },
        h('div', { onClick: function () { setOpen(!open); setQ('') }, style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, padding: '2px 8px', minHeight: 22, border: '1px solid ' + T.border, borderRadius: T.radius, background: T.card, fontSize: T.fsSm, color: label ? T.text : T.text3, userSelect: 'none' } },
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label ? '『' + label + '』' : '(未选,点此搜索)'),
          h('span', { style: { fontSize: 10, color: T.text3 } }, '▾')),
        open ? h('div', { style: { position: 'absolute', top: '100%', left: 0, zIndex: 60, minWidth: 250, marginTop: 2, background: T.card, border: '1px solid ' + T.border, borderRadius: T.radius, boxShadow: '0 6px 18px rgba(0,0,0,.12)', padding: 6 } },
          h('input', { className: 'qqs-inp', style: { width: '100%', boxSizing: 'border-box', padding: '3px 8px', marginBottom: 4, fontSize: T.fsSm }, autoFocus: true, placeholder: '搜群名 / 昵称 / ID…', value: q, onChange: function (e) { setQ(e.target.value) } }),
          gs.length + cs.length === 0 ? h('div', { style: { padding: '8px 6px', color: T.text3, fontSize: T.fsSm, textAlign: 'center' } }, '没有匹配的聊天') : null,
          gs.length ? h('div', { style: sec }, '群') : null,
          gs.map(function (c) { return h('div', { key: 'g:' + c.id, style: item, onMouseDown: function (ev) { ev.preventDefault(); pick(c) }, onMouseEnter: function (e) { e.currentTarget.style.background = T.cardHi }, onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' } }, '👥 ' + (c.name || c.id)) }),
          cs.length ? h('div', { style: sec }, '私聊') : null,
          cs.map(function (c) { return h('div', { key: 'c:' + c.id, style: item, onMouseDown: function (ev) { ev.preventDefault(); pick(c) }, onMouseEnter: function (e) { e.currentTarget.style.background = T.cardHi }, onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent' } }, '💬 ' + (c.name || c.id)) })) : null)
    }

    // 群聊守则"恢复默认"用: 与主包 dsh-qqbot config.ts 的 DEFAULT_GROUP_PROMPT 保持一致。
    // ⚠️ 若改主包默认文本, 必须同步改这里(唯一同步点)。
    var DEFAULT_GROUP_PROMPT = [
      '【表情包礼仪】你有一座本地表情包库(群友存的图,带标签)。想用表情包回应时先调 list_stickers 搜库,命中后再用 send_media 发出,别发没把握的图。',
      '只在群里正热闹、情绪正浓时,才在回复末尾附 0~1 张:满屏哈哈/笑死(爆笑)、大家"确实/我也是"(共鸣)、有人抛梗你能接住(接梗)、有人当面夸你(被夸)、轻度吐槽可以接治愈/滑稽图。',
      '绝不发:冷场没人接话、正事/技术问答/找资源、吵架互怼中、对方难过或聊严肃事、私聊。',
      '出手前自检,缺一不发:①库里有 9 成贴切的图;②发出来群友会心一笑;③这轮没发过、今天这群没刷过图。',
      '把图删掉话照样完整;一次最多一张;发离谱/冒犯/色气/羞辱人的图=人设崩塌,永远不许。',
    ].join('\n')

    function nv(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }
    function sv(v) { return typeof v === 'string' ? v : '' }
    function esc(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

    function BoolRow(props) {
      return h('label', { style: labelStyle },
        props.label,
        h('input', { className: 'qqs-inp',
          type: 'checkbox', style: inputStyle, checked: !!props.value,
          onChange: (e) => props.onChange(e.target.checked),
        }))
    }
    function NumRow(props) {
      return h('label', { style: labelStyle },
        props.label,
        h('input', { className: 'qqs-inp',
          type: 'number', style: inputStyle, value: nv(props.value),
          onChange: (e) => props.onChange(Number(e.target.value)),
        }))
    }
    function StrRow(props) {
      return h('label', { style: labelStyle },
        props.label,
        h('input', { className: 'qqs-inp', style: props.wide ? wideStyle : inputStyle, value: sv(props.value), onChange: (e) => props.onChange(e.target.value) }))
    }

    function RuleEditor(props) {
      var r = props.rule
      function upd(patch) { props.onChange({ ...r, ...patch }) }
      function condUpd(patch) { upd({ conditions: { ...r.conditions, ...patch } }) }
      return h('div', { style: boxStyle },
        h('label', { style: labelStyle },
          h('input', { className: 'qqs-inp',
            type: 'checkbox', checked: !!r.enabled,
            onChange: (e) => upd({ enabled: e.target.checked }),
          }), ' 启用这条提醒 ' + ((r.name || r.id) + (r.name && r.name !== r.id ? ' (' + r.id + ')' : ''))),
        h('label', { style: labelStyle },
          h('input', { className: 'qqs-inp',
            type: 'checkbox', checked: !!r.conditions.hasImage,
            onChange: (e) => condUpd({ hasImage: e.target.checked }),
          }), ' 消息里带图片 ',
          h('input', { className: 'qqs-inp',
            type: 'checkbox', checked: !!r.conditions.hasLink,
            onChange: (e) => condUpd({ hasLink: e.target.checked }),
          }), ' 消息里带链接 '),
        h('label', { style: labelStyle }, ' 按固定写法匹配文字(高手用,留空=不用): ',
          h('input', { className: 'qqs-inp', style: wideStyle, value: sv(r.conditions.contentRegex), placeholder: '如 ^早安', onChange: (e) => condUpd({ contentRegex: e.target.value }) })),
        h('label', { style: labelStyle }, ' 出现这些词就触发(逗号分隔): ',
          // ⚠️ 2026-09-14 修（主人："我输入不了逗号"）：原来是**受控** input（value = 数组 join(',')），
          //   输入"看不到,"时末尾空项被 filter(Boolean) 丢掉、文本又被重建成没逗号的样子
          //   → 逗号永远打不进去。改成**非受控**（defaultValue）：输入过程自由，onChange 只把解析结果写进配置。
          h('input', { className: 'qqs-inp', style: wideStyle, defaultValue: (r.conditions.contentKeywords || []).join(','), onChange: (e) => condUpd({ contentKeywords: e.target.value.split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean) }) })),
        h('label', { style: labelStyle }, ' 多个条件怎么算: ',
          h('select', { style: inputStyle, value: r.conditions.matchScope || 'any', onChange: (e) => condUpd({ matchScope: e.target.value }) },
            h('option', { value: 'any' }, '满足一个就行'),
            h('option', { value: 'all' }, '全部都要满足'))),
        h('div', { style: labelStyle }, '要提醒她的内容:'),
        h('textarea', { className: 'qqs-area',
          style: fullStyle, rows: 2, value: sv(r.prompt),
          placeholder: '例:上方含链接,引用前先核实',
          onChange: (e) => upd({ prompt: e.target.value }),
        }),
        h('button', { className: 'qqs-btn', style: { marginTop: 4 }, onClick: () => props.onRemove(r.id) }, '删除这条提醒'))
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 「配置即数据」引擎 —— Schema 驱动渲染 + 只提交 diff（2026-10-10 主人定）
    // ══════════════════════════════════════════════════════════════════════════
    // 旧版同一个字段要在三处手写：① load() 里手写 normalize；② doSave() 里手写全量
    // patch；③ 渲染时手写 label + 控件。加一个字段要改三处，漏一处 =「面板勾了却存不
    // 下去」（本文件历史注释里反复出现的就是这个病）。现在只有一处：FGROUPS。
    //   · 渲染   → renderField() 按 t 出控件
    //   · 默认值 → 渲染时按 def 回落（**不写进 cfg**，这样 diff 才是"真实改动"）
    //   · 提交   → buildPatch() 只放**变化了的顶层 key**（值是当前完整快照，host 侧
    //              浅合并也不会丢子字段）
    // 顺带修掉两个真 bug：
    //   ① ⑥「提问卡片」的 questionsMode 从来没进过 patch —— 选"后台/阻塞"永远存不下去；
    //   ② 列表类字段（禁发群、owner 列表）原来是**受控** input，逗号打不进去
    //      （RuleEditor 2026-09-14 踩过同一个坑）→ 现在统一非受控。
    // --------------------------------------------------------------------------

    function trimS(s) { return String(s).trim() }
    function gPath(o, path) {
      var ps = String(path).split('.'), c = o, i
      for (i = 0; i < ps.length; i++) { if (c === null || c === undefined) return undefined; c = c[ps[i]] }
      return c
    }
    function sPath(o, path, val) {
      var ps = String(path).split('.')
      function rec(node, i) {
        var copy = (node && typeof node === 'object' && !Array.isArray(node)) ? Object.assign({}, node) : {}
        if (i === ps.length - 1) { copy[ps[i]] = val; return copy }
        copy[ps[i]] = rec(node ? node[ps[i]] : undefined, i + 1)
        return copy
      }
      return rec(o, 0)
    }
    function deepEq(a, b) {
      if (a === b) return true
      if (a === null || b === null || a === undefined || b === undefined) return a === b
      if (typeof a !== 'object' || typeof b !== 'object') return false
      if (Array.isArray(a) !== Array.isArray(b)) return false
      var ka = Object.keys(a), kb = Object.keys(b), i
      if (ka.length !== kb.length) return false
      for (i = 0; i < ka.length; i++) { if (!deepEq(a[ka[i]], b[ka[i]])) return false }
      return true
    }
    function cloneCfg(v) { try { return JSON.parse(JSON.stringify(v)) } catch (e) { return v } }
    function numOf(v, def) { var n = Number(v); return isFinite(n) ? n : (typeof def === 'number' ? def : 0) }
    /** 只提交变化了的「顶层 key」—— 没碰过的字段(含本页不编辑的 schedule 等)一律不提交 */
    function buildPatch(cur, saved) {
      var patch = {}, keys = {}, k
      var c = cur || {}, s = saved || {}
      for (k in c) keys[k] = 1
      for (k in s) keys[k] = 1
      for (k in keys) { if (!deepEq(c[k], s[k])) patch[k] = c[k] }
      return patch
    }
    /** 字段当前值（undefined 用 def 回落） */
    function fieldVal(cfg, f) {
      var v = gPath(cfg || {}, f.k)
      if (v === undefined || v === null) return f.def
      if (f.t === 'num') return numOf(v, f.def)
      if (f.t === 'bool') return v === true
      return v
    }

    // ── 字段 / 分组定义（label、说明 一律集中在这里；以后改文案只改这一处）──
    // t: bool | num | str | area | radio | list | note | custom
    // k: 配置里的点分路径    def: 默认值    sec: 单位换算(存 = 显示 × sec)
    // wide: 宽输入框         rows: textarea 行数            options: radio 选项
    var FGROUPS = [
      {
        id: 'prompt', icon: '①', title: '群里她要一直记住的守则',
        desc: '每轮回复都会带上的一段提醒(所有 QQ 群都生效)。默认是"表情包礼仪"。'
          + '这里也能直接写人设/性格要求 —— 改完点下方「保存」立刻生效, 不用去改 cordis.patch.yml'
          + '(想整体换人格仍可在下面「Agent 预设」里换 preset)。'
          + '想让她不主动发图, 把这里清空即可(留空=没守则, 不会自动填回)。',
        fields: [
          { k: 'groupPrompt', kw: '守则 人设 人格 提示词 提醒 每轮 遵守 规则 prompt', t: 'area', label: '', rows: 5, def: DEFAULT_GROUP_PROMPT },
          {
            t: 'custom', render: function (ctx) {
              return h('button', {
                className: 'qqs-btn', style: { padding: '2px 10px', fontSize: 12 },
                onClick: function () { ctx.set('groupPrompt', DEFAULT_GROUP_PROMPT) },
              }, '恢复默认守则(表情包礼仪, 点下方「保存」生效)')
            }
          },
        ],
      },
      {
        id: 'rate', icon: '②', title: '多久回一次消息',
        desc: '控制她回复的速度。全填 0 = 来一条回一条(不限制)。',
        fields: [
          { k: 'behavior.freeIntervalSec', kw: '回复 间隔 频率 冷却 限速 慢 秒 群 没人at', t: 'num', label: '群里没人 @ 她时,隔几秒才回一次(0=每条都回)', def: 0 },
          { k: 'behavior.mentionIntervalSec', kw: '回复 间隔 at 提及 秒 快 随叫随到', t: 'num', label: '有人 @ 她时,两次回复至少隔几秒(0=随叫随到)', def: 0 },
          { k: 'behavior.directIntervalSec', kw: '回复 间隔 私聊 单聊 秒', t: 'num', label: '私聊里隔几秒回一次(0=不限制)', def: 0 },
          {
            k: 'outboundMode', kw: '出站 发送 主动 被动 静默 连发 丢消息 模式', t: 'radio', label: '出站方式(连发消息 QQ 端丢失时切主动):', def: 'adaptive',
            options: [
              { v: 'adaptive', label: '适配主动(推荐默认)' },
              { v: 'detail', label: '详细主动(连工具调用一起推)' },
              { v: 'passive', label: '被动(只回最后一句)' },
              { v: 'silent', label: '完全不出站(静默)' },
              { v: 'nothink', label: '完全不思考(QQ入站不唤醒,仅设置页)' },
            ],
            hint: '适配主动=刚收到真人消息时前5条带引用回你, 第6条起自动转独立新消息(连发不被QQ吞); 一段时间没新消息的主动推送(定时等)也走独立消息。被动=始终回你那条(连发约4~5条后被QQ吞)。完全不出站=照常思考但不向QQ发任何回复(AI 可用工具切回)。完全不思考=QQ入站不唤醒AI, 消息只记录(仅本页可开; 唤醒请发 /outmode adaptive)。保存即热更新, 不用重启。',
          },
          { t: 'note', label: '延迟聚合(另一套机制,和上面冷却不冲突): 她收到消息先等一小会儿, 把连发的话攒一起综合回, 免得只回第一句。' },
          { k: 'behavior.debounce.enabled', kw: '延迟 聚合 攒 合并 一起回 开关', t: 'bool', label: '开启延迟聚合(不勾=回到来一条回一条)', def: true },
          { k: 'behavior.debounce.silenceSec', kw: '延迟 聚合 停顿 静默 等待 秒', t: 'num', label: '对方停口几秒后她才开口(默认3;0=不停顿)', def: 3 },
          { k: 'behavior.debounce.maxMsgs', kw: '延迟 聚合 攒 条数 上限 立即', t: 'num', label: '攒满几条立即开口,不等对方停(默认10)', def: 10 },
          { k: 'behavior.debounce.mentionDelayed', kw: '延迟 聚合 at 提及 秒回', t: 'bool', label: '有人 @ 她时也走延迟(不勾=@到秒回)', def: true },
          { t: 'note', label: '她正在思考/输出时, 群里又来了新消息怎么办:' },
          {
            k: 'behavior.debounce.busySendMode', kw: '插话 排队 忙碌 正在输出 中途 消息', t: 'radio', def: 'queue',
            options: [
              { v: 'queue', label: '排队发送(默认: 攒着, 等这轮回完再一起看)' },
              { v: 'interject', label: '插话发送(在这回的轮次之间立刻插进去)' },
            ],
            hint: '排队=她正忙时消息攒在窗口里, 等这回合结束才整批送进去(带"上次回复前群友所发"的提示)。插话=照样先聚合(静默秒数/条数上限都不变, 不会一条条吵醒她), 但不等回合结束, 直接在回合内的轮次之间插进去 —— 每次插话都带一句"先做完当前任务、别被带偏"的轻提示(同一回合第2次起提示会自动缩短省 token)。注意: 若她这一步是纯文字收尾(后面没有工具轮次), 插话会留到下次唤醒才被读到, 效果和排队一样(宿主 inject 的固有语义)。保存即热更新, 不用重启。',
          },
        ],
      },
      {
        id: 'sticker', icon: '③', title: '发表情包的限制(全默认不限制)',
        desc: '防止她聊天时表情包刷屏;下面两项是"她主动发图"时才用——群里很热闹才发,冷清就憋着。不想管就保持全 0,也别勾总开关。',
        fields: [
          { t: 'note', label: '发图闸门' },
          { k: 'sticker.gates.enabled', kw: '表情包 图 限制 闸门 开关 刷屏', t: 'bool', label: '开启表情包限制(不勾=完全不限制)', def: false },
          { k: 'sticker.gates.perTurnMax', kw: '表情包 图 每轮 一次 上限 几张', t: 'num', label: '她一次回复最多带几张图(0=不限)', def: 0 },
          { k: 'sticker.gates.maxPerWindow', kw: '表情包 图 频率 窗口 上限 几张', t: 'num', label: '每隔"一小段时间"最多发几张(0=不限)', def: 0 },
          { k: 'sticker.gates.perWindowSec', kw: '窗口 时间 秒 频率 区间', t: 'num', label: '上面说的"一小段时间"是多长(秒,如600=10分钟)', def: 0 },
          { k: 'sticker.gates.dailyBudgetPerGroup', kw: '表情包 每日 每天 预算 上限 群', t: 'num', label: '每个群一天最多发几张表情包(0=不限)', def: 0 },
          { k: 'sticker.gates.dupTTLHours', kw: '重复 去重 同一张 小时 冷却', t: 'num', label: '同一张图多久内不许重复发(小时,0=不查)', def: 0 },
          { k: 'sticker.gates.activityWindowSec', kw: '活跃 热闹 窗口 时间 多久', t: 'num', label: '看"最近"多长时间的聊天来判热闹(3600=最近1小时)', def: 0 },
          { k: 'sticker.gates.activityMinMsgs', kw: '活跃 热闹 消息数 门槛 冷清', t: 'num', label: '最近这段时间群消息达到几条,她才肯主动发图(0=不管冷不冷都发)', def: 0 },
          { k: 'sticker.gates.bannedGroups', kw: '禁止 禁发 群 黑名单 排除', t: 'list', label: '禁止发图的群(填群ID,逗号分隔;一般不用填)', wide: true, def: [] },
          { t: 'note', label: '图库维护' },
          { k: 'sticker.autoTagEnabled', kw: '自动 打标 识图 视觉 标签 图库', t: 'bool', label: '新图自动后台识图打标(会花视觉额度;不勾=全靠人工手动补)', def: false },
          { k: 'sticker.visionCli', kw: '视觉 引擎 命令 cli 识图 ocr 高级', t: 'str', label: '视觉引擎命令(高级;留空自动探测)', wide: true, def: '' },
        ],
      },
      {
        id: 'rules', icon: '④', title: '自定义小提醒(高级)',
        desc: '当群友发的消息满足下面条件,就偷偷给机器人加一条要照做的提醒。比如:勾上"含链接",提醒写"引用前先核实"。',
        fields: [
          {
            t: 'custom', render: function (ctx) {
              var list = Array.isArray(ctx.cfg.injectRules) ? ctx.cfg.injectRules : []
              return h('div', null,
                list.map(function (r, i) {
                  return h(RuleEditor, {
                    key: r.id || ('r' + i), rule: r,
                    onChange: function (nr) { var l = list.slice(); l[i] = nr; ctx.set('injectRules', l) },
                    onRemove: function (id) { ctx.set('injectRules', list.filter(function (x) { return x.id !== id })) },
                  })
                }),
                h('button', {
                  className: 'qqs-btn', onClick: function () {
                    var l = list.slice()
                    l.push({
                      id: 'rule-' + Date.now().toString(36), name: '', enabled: true,
                      conditions: { hasImage: false, hasLink: false, contentRegex: '', contentKeywords: [], matchScope: 'any' }, prompt: '',
                    })
                    ctx.set('injectRules', l)
                  },
                }, '+ 添加一条提醒'))
            }
          },
          { k: 'imageHint', kw: '图片 看图 提示 识图 注入', t: 'bool', label: '图片消息自动提示 AI 看图(内置兜底; 不勾=不再注入「请把URL传给识图工具」那条)', def: true },
          { k: 'messageReference', kw: '引用 消息号 原文 rf 回复某条', t: 'bool', label: '引用消息(默认开): 入站消息带短消息号(本地台账索引,省token) + 引用消息附原文; AI 用 [rf:短号] 引用对方消息', def: true },
        ],
      },
      {
        id: 'diag', kw: '日志 诊断 排查 log 落盘', icon: '⑤', title: '诊断日志(排查用)',
        desc: '默认关。开了才会把排查用的诊断日志写进 {DSH_HOME|~/.dsh} 下的 *.log（单文件 2MB 自动轮转，只留 1 份旧档）。平时别开——它会持续占盘；出问题时再开，排查完可以关掉、并把那些 .log 删掉。',
        fields: [
          { k: 'diagLog', kw: '日志 诊断 排查 log 落盘 记录', t: 'bool', label: '诊断日志落盘(默认关): 写 ~/.dsh/*.log 便于离线排查', def: false },
        ],
      },
      {
        id: 'timers', kw: '定时 提醒 计划 到点 主动 唤醒 闹钟', icon: '⑥', title: '定时唤醒',
        desc: '已合并到「定时任务」页(顶部 tab)一起编辑——到点主动开口的群/人分组,与她答应你的定时提醒,都在那边管理。',
        fields: [],
      },
      {
        id: 'approval', icon: '⑦', title: 'QQ 远程审批(在 QQ 里放行 dsh 权限申请)',
        desc: '机器人的工具要动"工作区外"的东西时,dsh 会申请权限。开启后审批请求直接发到你的 QQ(私聊/群聊看你从哪发起),回 /approve 验证码 放行、/deny 拒绝——只放行这一次,验证码一次性,只有你能批。',
        fields: [
          { k: 'enableApprovals', kw: '审批 权限 申请 放行 授权 approve', t: 'bool', label: '开启 QQ 远程审批(不勾=保持默认审批方式)', def: false },
          { k: 'approvalTimeoutMs', kw: '审批 超时 等待 秒 拒绝', t: 'num', label: '审批等待秒数(超时自动拒绝;默认120)', def: 120000, sec: 1000 },
        ],
      },
      {
        id: 'ask', icon: '⑧', title: '提问卡片(她问人时要不要在旁边干等)',
        desc: '她调用 ask_user_question 问你或群友时怎么等答案。后台提问=卡片发出去她就能接着聊天/干活, 对方答完之后答案会作为一条"提问卡片·回执"自动送回她的会话(她正忙→插进当前回合不打断; 她闲着→叫醒她接着处理), 超时没答也会收到一条"超时未答"的回执。阻塞等待=旧行为, 她的这一回合一直挂到对方作答或超时, 期间收不了新消息。',
        fields: [
          {
            k: 'questionsMode', kw: '提问 卡片 等待 后台 阻塞 回执 答案', t: 'radio', label: '等待方式:', def: 'async',
            options: [
              { v: 'async', label: '后台提问(推荐默认: 不卡她)' },
              { v: 'blocking', label: '阻塞等待(旧行为: 她会卡住)' },
            ],
          },
        ],
      },
      {
        id: 'group', icon: '⑨', title: '群管理基础设置',
        desc: '开启后 QQ 会话里可用群管理工具; 踢人/成员列表等官方未开放能力会在下方 Tab 里提示等待公测。',
        fields: [
          { k: 'groupAdmin.enabled', kw: '群管理 踢人 禁言 成员 入群 管理员', t: 'bool', label: '开启 QQ 群管理(不勾=群管理工具不可用)', def: false },
          { k: 'c2cShowBotAvatar', kw: '私聊 头像 机器人 avatar c2c', t: 'bool', label: '私聊显示机器人头像（首行 markdown 小图；官方私聊没有头像，群里才有。默认关）', def: false },
          { k: 'groupAdmin.owners', kw: '群管理 主人 权限 openid 名单', t: 'list', label: '允许操作的主人 openid（逗号分隔；留空时 /preset /new /model 等管理命令会提示去配置）· 每个机器人实例的 openid 不同，需分别配置', wide: true, def: [] },
          { k: 'groupAdmin.manageGroup', kw: '群管理 默认群 group_openid 目标群', t: 'str', label: '对话内默认管理群 group_openid(web 对话时群工具用它; QQ 群会话自动用当前群)', wide: true, def: '' },
          { k: 'groupAdmin.watchJoinRequests', kw: '入群申请 事件 提醒 订阅', t: 'bool', label: '实时接收"入群申请"事件并自动提醒(勾选后需重启才生效)', def: false },
          { k: 'groupAdmin.notifyInGroup', kw: '入群申请 提醒 群内 通知', t: 'bool', label: '收到入群申请时在该群内发提醒消息', def: true },
          { k: 'extMetaTool', kw: '扩展工具 元工具 gain 按需 领取 token 省', t: 'bool', label: '扩展工具按需取用（默认开）：expose:all 的工具注册在 QQ 会话侧，非 QQ 会话要先用 gain_qq_tools 领取；别的实例的工具同理（本实例自己的工具始终可见）。关掉 = 禁止领取，别的实例的工具一律不可见', def: true },
          { t: 'custom', render: function (ctx) { return h(GroupAdminPanel, { key: 'ga-' + (ctx.ns || 'main'), ns: ctx.ns || undefined }) } },
        ],
      },
    ]

    // 分区导航的短名(完整标题太长)
    var GSHORT = { prompt: '① 守则', rate: '② 回复节奏', sticker: '③ 表情包', rules: '④ 小提醒', diag: '⑤ 诊断日志', timers: '⑥ 定时', approval: '⑦ 审批', ask: '⑧ 提问卡片', group: '⑨ 群管理' }

    // ── 搜索（2026-10-10 主人定）：上栏=精确(字面)，下栏=模糊/语义 ───────────────
    // 语义侧**程序算**、零依赖、离线即时：字符 bigram ＋ IDF 加权余弦；
    // 文档 = label×2 + kw×2 + hint + 键名（kw 是每个字段手挂的关键词，见 FGROUPS）。
    // 不调模型、不联网 —— 32 个字段的规模，这套查表+加权已经完全够用。
    function sqBigrams(t) {
      var s = String(t || '').toLowerCase().replace(/[\s\-_./:()（）,，。、"'“”「」【】\[\]?？!！@#*;；]+/g, '')
      var out = {}, i
      for (i = 0; i < s.length - 1; i++) { var g = s.slice(i, i + 2); out[g] = (out[g] || 0) + 1 }
      if (s.length === 1) out[s] = 1
      return out
    }
    var SQ_DOCS = []
    var SQ_IDF = {}
    function sqVec(t) { var g = sqBigrams(t), o = {}, k; for (k in g) o[k] = g[k] * (SQ_IDF[k] || 1); return o }
    function sqCos(a, b) {
      var dot = 0, na = 0, nb = 0, k
      for (k in a) { na += a[k] * a[k]; if (b[k]) dot += a[k] * b[k] }
      for (k in b) nb += b[k] * b[k]
      return (!na || !nb) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
    }
    ;(function buildSearchIndex() {
      FGROUPS.forEach(function (g) {
        (g.fields || []).forEach(function (fd) {
          if (!fd.k || fd.t === 'note' || fd.t === 'custom') return
          SQ_DOCS.push({ k: fd.k, doc: [fd.label || '', fd.label || '', fd.kw || '', fd.kw || '', fd.hint || '', String(fd.k).replace(/[.\-_]/g, ' ')].join(' ') })
        })
      })
      var df = {}, i, b
      for (i = 0; i < SQ_DOCS.length; i++) {
        var seen = {}, g2 = sqBigrams(SQ_DOCS[i].doc)
        for (b in g2) seen[b] = 1
        for (b in seen) df[b] = (df[b] || 0) + 1
      }
      var N = SQ_DOCS.length || 1
      for (b in df) SQ_IDF[b] = Math.log(1 + N / (1 + df[b])) + 0.2
      SQ_DOCS.forEach(function (d) { d.vec = sqVec(d.doc) })
    })()
    /** 查询 → { 字段key: 相似度 }（0~1） */
    function sqScores(query) {
      var out = {}, i, qv = sqVec(query)
      for (i = 0; i < SQ_DOCS.length; i++) out[SQ_DOCS[i].k] = sqCos(qv, SQ_DOCS[i].vec)
      return out
    }

    // ── 渲染：一个字段 → 控件（t 决定形态；外观沿用旧版的行/输入框样式）──
    function renderControl(f, val, ctx) {
      var onNum = function (e) { ctx.set(f.k, Number(e.target.value) * (f.sec || 1)) }
      if (f.t === 'bool') {
        return h('input', {
          className: 'qqs-inp', type: 'checkbox', style: inputStyle, checked: !!val,
          onChange: function (e) { ctx.set(f.k, e.target.checked) },
        })
      }
      if (f.t === 'num') {
        return h('input', {
          className: 'qqs-inp', type: 'number', style: inputStyle,
          value: nv(val) / (f.sec || 1), onChange: onNum,
        })
      }
      if (f.t === 'str') {
        return h('input', {
          className: 'qqs-inp', style: f.wide ? wideStyle : inputStyle, value: sv(val),
          onChange: function (e) { ctx.set(f.k, e.target.value) },
        })
      }
      if (f.t === 'area') {
        return h('textarea', {
          className: 'qqs-area', style: { ...fullStyle, minHeight: (f.rows || 3) * 20 },
          value: sv(val), onChange: function (e) { ctx.set(f.k, e.target.value) },
        })
      }
      if (f.t === 'list') {
        // ⚠️ 非受控：受控写法下"输入逗号"会被 join 重建掉（同 RuleEditor 2026-09-14 的坑）
        return h('input', {
          className: 'qqs-inp', style: f.wide ? wideStyle : inputStyle,
          defaultValue: (Array.isArray(val) ? val : []).join(','),
          onChange: function (e) {
            ctx.set(f.k, e.target.value.split(/[,，]/).map(trimS).filter(Boolean))
          },
        })
      }
      if (f.t === 'radio') {
        return h('span', { style: { display: 'inline-flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' } },
          (f.options || []).map(function (o) {
            return h('label', { key: o.v, style: { display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12, color: T.text2, cursor: 'pointer' } },
              h('input', { type: 'radio', name: 'qqs-f-' + f.k, checked: String(val) === o.v, onChange: function () { ctx.set(f.k, o.v) } }),
              o.label)
          }))
      }
      if (f.t === 'custom') return f.render ? f.render(ctx) : null
      return null
    }

    /** 长说明默认折叠成一行，点开看全文（短说明直接显示） */
    function HintBlock(props) {
      var txt = String(props.text || '')
      var [open, setOpen] = useState(false)
      if (!txt) return null
      if (txt.length <= 110) {
        return h('div', { style: { fontSize: 12, color: T.text3, margin: '2px 0 4px', lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, txt)
      }
      return h('div', { style: { margin: '2px 0 4px' } },
        h('span', {
          onClick: function () { setOpen(!open) },
          style: { fontSize: 12, color: T.primary, cursor: 'pointer', userSelect: 'none' },
        }, open ? '▾ 收起说明' : 'ⓘ 说明(点开)'),
        open ? h('div', { style: { fontSize: 12, color: T.text3, marginTop: 3, lineHeight: 1.75, whiteSpace: 'pre-wrap' } }, txt) : null)
    }

    /** 分组介绍（长的收成一行 + 展开） */
    function GroupDesc(props) {
      var txt = String(props.text || '')
      var [open, setOpen] = useState(false)
      if (!txt) return null
      var st = { fontSize: 12, color: T.text3, lineHeight: 1.75, background: T.cardHi, border: '1px solid ' + T.borderLight, borderRadius: T.radius, padding: '6px 10px', margin: '0 0 8px' }
      if (txt.length <= 120) return h('div', { style: st }, txt)
      return h('div', { style: st },
        open ? txt : (txt.slice(0, 108) + '…'),
        h('span', {
          onClick: function () { setOpen(!open) },
          style: { color: T.primary, cursor: 'pointer', marginLeft: 6, whiteSpace: 'nowrap' },
        }, open ? '收起' : '展开'))
    }

    function FieldRow(props) {
      var f = props.f, ctx = props.ctx, val = fieldVal(ctx.cfg, f)
      var ctrl = renderControl(f, val, ctx)
      var badge = props.sem ? h('span', { style: { fontSize: 11, color: T.primary, background: T.primaryBg, borderRadius: 999, padding: '0 6px', marginLeft: 6, whiteSpace: 'nowrap' } }, Math.round(props.sem * 100) + '% 匹配') : null
      var lstyle = { fontSize: 13, color: T.text, lineHeight: 1.65 }
      var body
      if (f.t === 'note') return h('div', { style: { fontSize: 12, color: T.text2, margin: '12px 0 2px', lineHeight: 1.7, fontWeight: 600 } }, f.label)
      if (f.t === 'custom') body = h('div', { style: { margin: '8px 0' } }, ctrl)
      else if (f.t === 'bool') {
        body = h('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, margin: '6px 0', cursor: 'pointer' } },
          h('span', { style: { paddingTop: 2, flexShrink: 0 } }, ctrl),
          h('span', { style: lstyle }, f.label, badge))
      } else if (f.t === 'num') {
        body = h('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, margin: '6px 0' } },
          h('span', { style: Object.assign({}, lstyle, { flex: 1 }) }, f.label, badge),
          ctrl)
      } else if (f.t === 'str' || f.t === 'list') {
        body = h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' } },
          h('span', { style: Object.assign({}, lstyle, { flex: 1 }) }, f.label, badge),
          ctrl)
      } else {
        body = h('div', { style: { margin: '8px 0' } },
          f.label ? h('div', { style: lstyle }, f.label, badge) : null,
          h('div', { style: { marginTop: 5 } }, ctrl))
      }
      return h('div', null, body, h(HintBlock, { text: f.hint }))
    }

    // ══ 扩展 UI（2026-10-26）════════════════════════════════════════════════
    //   为什么要提到模块顶层：ExtCardPage 是给 QqbotHome 用的（顶层 tab 切换），
    //   原来错写在 SettingsPage 内部 → QqbotHome 里 ReferenceError: ExtCardPage is not defined，
    //   整页白屏（2026-10-26 主人实测）。
    //   这里自包含实现，不依赖 SettingsPage 内部的 extUiText / injectExtUiCss。
    var EXT_UI_CSS_ID = 'qqs-ext-css'
    function extUiEnsureCss() {
      try {
        if (document.getElementById(EXT_UI_CSS_ID)) return
        var s = document.createElement('style')
        s.id = EXT_UI_CSS_ID
        // ★ 2026-10-27：内嵌卡片那条已删（改顶栏页签），这里只留页签/整页卡片需要的样式
        s.textContent =
          '.qqs-top-tabs{scrollbar-width:none}'
          + '.qqs-top-tabs::-webkit-scrollbar{display:none}'
          + '.qqs-ext-card{flex:0 0 auto;scroll-snap-align:start;min-width:220px;max-width:320px}'
          + '.qqs-ext-page-card{display:block;min-width:260px}'
        document.head.appendChild(s)
        // 鼠标滚轮 → 横向滚动（2026-10-26 主人实测"不能横滑"）：
        //   容器 overflow-x:auto 在触摸屏上能滑，但**桌面上普通滚轮是纵向的**，
        //   浏览器不会自动转成横滚，所以看着"溢出却不动"。这里做一次事件委托，
        //   .qqs-top-tabs / .qqs-ext-cards 上把纵向滚轮折算成 scrollLeft。
        if (!window.__qqsExtWheelBound) {
          window.__qqsExtWheelBound = true
          // 哪些容器算"可横滑条"：设置页顶栏、扩展卡片条、dock 页签（★ 2026-10-26 补 dk-tab）
          var isScrollBar = function (el) {
            if (!el || !el.classList) return false
            return el === window.__qqsTopTabs
              || el.id === 'qqs-top-tabs'
              || el.classList.contains('qqs-top-tabs')
              || el.classList.contains('qqs-ext-cards')
              || el.classList.contains('dk-tab')
          }
          document.addEventListener('wheel', function (e) {
            var el = e.target
            while (el) {
              if (isScrollBar(el)) {
                if (el.scrollWidth > el.clientWidth + 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                  el.scrollLeft += e.deltaY
                  e.preventDefault()
                }
                return
              }
              el = el.parentNode
            }
          }, { passive: false })

          // ★ 鼠标按住拖拽（桌面端最直觉的滑动方式）。
          //   dock 页签是字符串拼的 HTML、拿不到 ref，所以用**全局事件委托**：
          //   mousedown 判断落点是否在可横滑容器里，是就开始记起点。
          var dragEl = null, dragX = 0, dragLeft = 0, dragMoved = false
          document.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return
            var el = e.target
            while (el) {
              if (isScrollBar(el) && el.scrollWidth > el.clientWidth + 1) {
                dragEl = el; dragX = e.pageX; dragLeft = el.scrollLeft; dragMoved = false
                el.style.cursor = 'grab'
                return
              }
              el = el.parentNode
            }
          })
          document.addEventListener('mousemove', function (e) {
            if (!dragEl) return
            var dx = e.pageX - dragX
            if (Math.abs(dx) > 4) {
              dragMoved = true
              dragEl.style.cursor = 'grabbing'
              dragEl.scrollLeft = dragLeft - dx
              e.preventDefault()
            }
          })
          document.addEventListener('mouseup', function () {
            if (!dragEl) return
            try { dragEl.style.cursor = '' } catch (x) { /* ignore */ }
            var d = dragEl
            setTimeout(function () { if (dragEl === d) dragEl = null }, 0)
            // ★ 2026-10-27 修：dragMoved 必须清 —— 之前只清 dragEl、没清 dragMoved，
            //   结果是「拖过一次之后所有 click 都被吞」：点按钮没反应、页签切不动，
            //   看起来像"路由到别处了"（主人实测就是这个现象）。
            //   留 120ms 给紧随其后的 click 消费，然后强制归零。
            setTimeout(function () { dragMoved = false }, 120)
          })
          // 拖完拦截一次 click，避免"想滑动却切走了页签"
          document.addEventListener('click', function (e) {
            if (dragMoved) { dragMoved = false; e.stopPropagation(); e.preventDefault() }
          }, true)
        }
      } catch (e) { /* ignore */ }
    }
    function extUiLoad(extId, f, slot) {
      // slot 用于区分「同一个扩展 id 在 profile 级 / 数据根各有一张卡」的情况（见 ext-ui.ts 注释）
      var u = 'api/qqbot-settings/ext-ui/file?f=' + encodeURIComponent(f) + '&id=' + encodeURIComponent(extId)
      if (slot) u += '&slot=' + encodeURIComponent(slot)
      return fetch(u)
        .then(function (r) { return r.json() })
        .then(function (j) { return j && j.ok ? String(j.text || '') : '' })
        .catch(function () { return '' })
    }
    /**
     * 给卡片脚本的统一 API（2026-10-26）
     *
     * @param extId    扩展 id
     * @param cfgScope 'profile'（设置页卡片：全局一份）| 'data'（dock 卡片：每实例一份）
     * @param dockCtx  dock 卡片才有：当前实例/会话上下文（settings 卡片传 null）
     *
     * dock 卡片的独特之处就是**能看到当前实例和会话的真实数据**，所以这里额外给：
     *   dock.context()      当前实例 + 会话信息（ns/appId/dataRoot/peer/群名）
     *   dock.sessions()     这个机器人管过哪些会话
     *   dock.history(n)     当前会话最近 n 条消息
     *   dock.members()      群友台账（谁说过话、什么印象分）
     * 这些走 /api/qqbot-settings/dock-data，scope=当前数据根（每实例一份，天然隔离）。
     */
    /** 宿主是不是暗色主题（宿主 ThemePresenter 给 body 加 data-ds-dark-theme 属性） */
    function extUiIsDark() {
      try {
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return true
        // 兜底：宿主没给属性时看系统偏好
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true
      } catch (e) { /* ignore */ }
      return false
    }
    /** 读当前 web 会话 id（宿主的 localStorage，和「当前会话」检测同一个源） */
    function extUiCurrentSid() {
      try {
        var raw = localStorage.getItem('dsh.sessions.current')
        if (!raw) return ''
        var o = JSON.parse(raw)
        return (o && o.sessionId) ? String(o.sessionId) : ''
      } catch (e) { return '' }
    }
    function extUiApi(extId, cfgScope, dockCtx, acctCtx) {
      var scope = cfgScope === 'profile' ? 'profile' : 'data'
      // ★ 2026-10-27（主人要求）：设置页的卡片虽然是"全局 UI"，也能读写**当前选中账号**。
      //   getConfig('data') / setConfig(p, 'data') 会落到上面账号下拉框选中的那个实例；
      //   传 sc='profile' 仍是全局那份。第三个参数可临时指定某个账号（不传=当前选中的）。
      var acctCwdOf = function (a) {
        if (!a || typeof a !== 'object') return ''
        return String(a.cwd || '').trim() || (a.dataRoot ? String(a.dataRoot).replace(/[\/]dshqqbot[\/]*$/, '') : '')
      }
      var api = {
        extId: extId,
        /** 当前卡片上下文里的账号（设置页=下拉框选中的；dock=当前实例） */
        acct: acctCtx || (dockCtx ? { ns: dockCtx.ns, cwd: dockCtx.cwd, dataRoot: dockCtx.dataRoot } : null),
        getConfig: function (s, acctOverride) {
          var sc = s === 'profile' || s === 'data' ? s : scope
          var a = acctOverride || acctCtx
          var u = 'api/qqbot-settings/ext-config?id=' + encodeURIComponent(extId) + '&scope=' + sc
          var cw = acctCwdOf(a)
          if (sc === 'data' && cw) u += '&cwd=' + encodeURIComponent(cw)
          return fetch(u)
            .then(function (r) { return r.json() })
            .then(function (j) { return (j && j.ok && j.config) || {} })
            .catch(function () { return {} })
        },
        setConfig: function (patch, s, acctOverride) {
          var sc = s === 'profile' || s === 'data' ? s : scope
          var a = acctOverride || acctCtx
          var cw = acctCwdOf(a)
          return fetch('api/qqbot-settings/ext-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: extId, scope: sc, patch: patch || {}, cwd: sc === 'data' ? cw : '' }),
          }).then(function (r) { return r.json() }).catch(function () { return null })
        },
        api: function (p, opts) {
          // ★ 2026-10-26：改走统一 dispatch 出口 —— 扩展用 env.registerRoute() 注册的
          //   自有存储接口都从这里进（settings-host 的 /api/ext/dispatch 派发）。
          // ★ 2026-10-27：dock 卡片额外带 dataRoot —— hooks 是「插件启动时跑一次」，
          //   其 env.dataRoot 是**插件级**的（主实例那份），不是当前机器人实例的。
          //   所以数据根必须随请求传，让 handler 用 query.dataRoot 自己算路径。
          var u = 'api/ext/dispatch?id=' + encodeURIComponent(extId) + '&p=' + encodeURIComponent(String(p || '/'))
          if (dockCtx && dockCtx.dataRoot) u += '&dataRoot=' + encodeURIComponent(dockCtx.dataRoot)
          return fetch(u, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
            .then(function (r) { return r.json() })
            .catch(function () { return null })
        },
        toast: function (m) { try { window.alert(String(m)) } catch (e) { /* ignore */ } },

        /**
         * 主题（2026-10-27 主人问：自定义 UI 能跟随宿主主题吗？—— 能）
         *
         * 两条路，**优先用 CSS 变量**：
         *   ① CSS 变量（推荐）：插件在 body 上定义了 --qqs-* token，亮/暗两套自动切换。
         *      自定义属性会**穿透 Shadow DOM**，卡片里直接写 var(--qqs-text) 就行。
         *        常用：--qqs-card / --qqs-panel / --qqs-text / --qqs-text2 / --qqs-text3
         *              --qqs-border / --qqs-input / --qqs-toolbar / --qqs-primary-fg
         *   ② JS 判断（要按主题做逻辑分支时）：theme / isDark() / onThemeChange(fn)
         * 宿主切主题时给 body 加 data-ds-dark-theme 属性，这里监听它。
         */
        get theme() { return extUiIsDark() ? 'dark' : 'light' },
        isDark: function () { return extUiIsDark() },
        onThemeChange: function (fn) {
          if (typeof fn !== 'function') return function () {}
          var handler = function () { try { fn(extUiIsDark() ? 'dark' : 'light') } catch (e) { /* ignore */ } }
          try {
            var ob = new MutationObserver(handler)
            ob.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
            var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
            if (mq && mq.addEventListener) mq.addEventListener('change', handler)
            return function () {
              try { ob.disconnect() } catch (e) { /* ignore */ }
              try { if (mq && mq.removeEventListener) mq.removeEventListener('change', handler) } catch (e) { /* ignore */ }
            }
          } catch (e) { return function () {} }
        },

        /**
         * 能力调用（2026-10-27 主人要求：UI 卡片要和其余扩展对齐能力）
         *
         * 卡片跑在浏览器里，但 store / kernel / log 这些都在服务端 ——
         * 所以走 RPC：cap('store.load') → /api/ext/dispatch?p=/__cap&fn=store.load
         * 后端有白名单（EXT_CAP_ALLOW），只有列出来的能用。
         *
         * 白名单：store.load / store.save / appId / owners /
         *         kernel.get / kernel.has / log / text / markdown / appendSilent
         */
        cap: function (fn) {
          var args = Array.prototype.slice.call(arguments, 1);
          var u = 'api/ext/dispatch?id=' + encodeURIComponent(extId)
            + '&p=' + encodeURIComponent('/__cap')
            + '&fn=' + encodeURIComponent(String(fn || ''))
            + '&args=' + encodeURIComponent(JSON.stringify(args))
          if (dockCtx && dockCtx.dataRoot) u += '&dataRoot=' + encodeURIComponent(dockCtx.dataRoot)
          if (dockCtx && dockCtx.cwd) u += '&cwd=' + encodeURIComponent(dockCtx.cwd)
          if (acctCtx && acctCtx.cwd) u += '&cwd=' + encodeURIComponent(acctCtx.cwd)
          // ★ 2026-10-27 修：peer/ns **必须实时读**，不能用挂载时的快照 ——
          //   卡片挂载时「当前会话」检测还没跑完（异步），那会儿 detectedHit 是 null，
          //   于是 appendSilent 拿到空 peer，永远注入失败。
          try {
            // ★ 2026-10-27（主人点明）：只要**当前会话 id** 就够了。
            //   后端 findManagerBySessionId(sid) 一步定位 manager + agent，
            //   不用再猜 scope/peer/群注册表。
            var sidNow = extUiCurrentSid()
            if (sidNow) u += '&sid=' + encodeURIComponent(sidNow)
            var live = window.__qqsDockState || {}
            if (live.ns) u += '&ns=' + encodeURIComponent(live.ns)
            var hit = live.detectedHit
            if (hit && hit.peerId) {
              u += '&peer=' + encodeURIComponent(hit.peerId)
              u += '&scope=' + encodeURIComponent(hit.scope === 'c2c' ? 'c2c' : 'group')
            } else if (dockCtx && dockCtx.peer && dockCtx.peer.peerId) {
              u += '&peer=' + encodeURIComponent(dockCtx.peer.peerId)
              u += '&scope=' + encodeURIComponent(dockCtx.peer.scope || 'group')
            }
          } catch (e) { /* ignore */ }
          return fetch(u, { method: 'POST' })
            .then(function (r) { return r.json() })
            .then(function (j) { return j && j.ok ? j.data : null })
            .catch(function () { return null })
        },
        dock: null,
      }

      // ── 语义化包装（内部走 cap，写起来更像其余扩展）──────────────
      api.log = function (msg) { return api.cap('log', String(msg == null ? '' : msg)) }
      api.store = {
        load: function () { return api.cap('store.load') },
        save: function (v) { return api.cap('store.save', v == null ? {} : v) },
      }
      api.kernel = {
        /** 取宿主服务（DSH cordis Context）—— 等于扩展里的 env.kernel.get(name) */
        get: function (name) { return api.cap('kernel.get', String(name == null ? '' : name)) },
        has: function (name) { return api.cap('kernel.has', String(name == null ? '' : name)) },
      }
      api.owners = function () { return api.cap('owners') }
      api.appIdOf = function () { return api.cap('appId') }
      if (dockCtx) {
        var q = function (what) {
          // ★ 2026-10-27：必须带上 dataRoot / cwd —— 否则后端推不出当前实例的数据根，
          //   会落到宿主默认（表现为"切到 3 号机读到的还是 2 号机的路径"）。
          var u = 'api/qqbot-settings/dock-data?what=' + encodeURIComponent(what)
          if (dockCtx.ns) u += '&ns=' + encodeURIComponent(dockCtx.ns)
          if (dockCtx.dataRoot) u += '&dataRoot=' + encodeURIComponent(dockCtx.dataRoot)
          if (dockCtx.cwd) u += '&cwd=' + encodeURIComponent(dockCtx.cwd)
          // ★ 同上：peer 实时读（挂载时可能还没检测出来）
          try {
            var sidNow2 = extUiCurrentSid()
            if (sidNow2) u += '&sid=' + encodeURIComponent(sidNow2)
            var live2 = window.__qqsDockState || {}
            var hit2 = live2.detectedHit
            if (hit2 && hit2.peerId) {
              u += '&peer=' + encodeURIComponent(hit2.peerId)
              u += '&scope=' + encodeURIComponent(hit2.scope === 'c2c' ? 'c2c' : 'group')
            } else if (dockCtx.peer && dockCtx.peer.peerId) {
              u += '&peer=' + encodeURIComponent(dockCtx.peer.peerId)
              u += '&scope=' + encodeURIComponent(dockCtx.peer.scope || 'group')
            }
          } catch (e) { /* ignore */ }
          return u
        }
        api.dock = {
          ns: dockCtx.ns || '',
          appId: dockCtx.appId || '',
          // ★ 2026-10-27（主人问：当前会话 id 暴露了吗？—— 之前没有，现在补上）
          //   就是顶栏「当前会话」那个 26421171-... ，宿主的 agent 表按它索引。
          //   做成 getter：每次读都是最新的（卡片挂载时可能还没检测完，不能存快照）。
          get sid() { return extUiCurrentSid() },
          get peerId() {
            var h = (window.__qqsDockState || {}).detectedHit
            return h && h.peerId ? String(h.peerId) : ''
          },
          get scope() {
            var h = (window.__qqsDockState || {}).detectedHit
            return h && h.scope === 'c2c' ? 'c2c' : 'group'
          },
          // ★ 两个路径都暴露（2026-10-26 主人问"dataRoot 还是 cwd？" —— 都给了）：
          //   dataRoot = 插件数据根（推荐：扩展自己的文件/SQLite 放这儿，跟插件数据一起）
          //   cwd      = 当前工作区根（扩展要往用户项目目录写东西时才用）
          dataRoot: dockCtx.dataRoot || '',
          cwd: dockCtx.cwd || '',
          peer: dockCtx.peer || null,
          context: function () { return fetch(q('context')).then(function (r) { return r.json() }).catch(function () { return null }) },
          sessions: function () { return fetch(q('sessions')).then(function (r) { return r.json() }).catch(function () { return null }) },
          history: function (n) { return fetch(q('history') + '&limit=' + (n || 20)).then(function (r) { return r.json() }).catch(function () { return null }) },
          /**
           * 当前会话 **AI 最后一个正文块**（2026-10-27）
           * 不是 QQ 消息流水，是 agent 真正输出的那段文字。
           * 实现：宿主 kernel.get('sessions').get(sid).deriveMessages() 从后往前找 assistant。
           */
          lastAssistantText: function () {
            return fetch(q('lastAssistantText')).then(function (r) { return r.json() }).catch(function () { return null })
          },
          members: function () { return fetch(q('members')).then(function (r) { return r.json() }).catch(function () { return null }) },
        }
      }
      return api
    }
    /** 把一张扩展卡片用 Shadow DOM 挂进容器 */
    function extUiMountCard(container, extId, cls, dockCtx, acctCtx) {
      var host = document.createElement('div')
      host.className = cls || 'qqs-ext-card'
      var sr = host.attachShadow({ mode: 'open' })
      container.appendChild(host)
      var slot = dockCtx ? 'dock' : 'settings'
      Promise.all([
        extUiLoad(extId, 'card.html', slot),
        extUiLoad(extId, 'card.css', slot),
        extUiLoad(extId, 'card.js', slot),
      ])
        .then(function (res) {
          sr.innerHTML = '<style>' + (res[1] || '') + '</style>' + (res[0] || '')
          if (!res[2]) return
          var api = extUiApi(extId, dockCtx ? 'data' : 'profile', dockCtx, acctCtx)
          try {
            new Function('qqbotExt', 'shadowRoot', res[2])(api, sr)
          } catch (e) {
            var d = document.createElement('div')
            d.style.cssText = 'color:#c33;font-size:12px;padding:6px 0'
            d.textContent = '卡片脚本出错: ' + (e && e.message ? e.message : e)
            sr.appendChild(d)
          }
        })
      return host
    }
    /** 扩展页签的整页视图：把它的卡片铺在内容区 */
    function ExtCardPage(props) {
      var extId = String((props && props.extId) || '')
      var title = String((props && props.title) || extId)
      // ★ 2026-10-27（主人要求）：设置页的卡片虽然是"全局 UI"，但也要能读写**当前选中账号**
      //   那份数据 —— 即 getConfig('data') 走上面账号下拉框选中的实例。
      //   acct 来自 QqbotHome 的 acctx（含 ns / cwd / dataRoot）。
      var acct = (props && props.acct) || null
      useEffect(function () {
        extUiEnsureCss()
        var box = document.getElementById('qqs-ext-page')
        if (!box || !extId) return
        box.innerHTML = ''
        extUiMountCard(box, extId, 'qqs-ext-page-card', null, acct)
        return function () { try { box.innerHTML = '' } catch (e) { /* ignore */ } }
      }, [extId, acct && acct.ns])
      return h('div', { style: { maxWidth: 720 } },
        h('h2', { style: { margin: '0 0 10px' } }, title),
        h('div', { id: 'qqs-ext-page', style: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' } }))
    }

    /**
     * dock 扩展页签的列表（2026-10-26）
     * 只收 slot=dock 的卡片 —— 它们放在**数据根**（每个机器人实例各一份），
     * 所以能拿到「当前实例 + 当前会话」的数据（见 extUiApi 里的 dock.*）。
     * 拉一次缓存在 window，paintBody 重绘后就有页签了。
     */
    var _dockTabsLoaded = false
    var _dockTabsRoot = ''            // 上次拉列表用的 dataRoot —— 换机器人实例时要重拉
    function ensureDockExtTabs(force) {
      // ★ 2026-10-27 修（主人实测：切到 im-qqbot-3 仍显示 im-qqbot-2 的扩展卡片）：
      //   dock 卡片按**机器人实例的 dataRoot** 分源，不同实例不一样。
      //   原来拉列表没带实例信息、且只拉一次 → 换了实例还是旧那份。
      //   现在带上当前账号的 dataDir，变了就重拉。
      var st = window.__qqsDockState || {}
      var ac = null
      try {
        var l0 = (st.accts || [])
        // ★ 2026-10-27：dock 的 state 里**没有 acctId**（那是 SettingsPage 的 React state），
        //   必须用 st.ns 匹配。原来写 st.acctId 永远 undefined → 落到"第一个启用的实例"
        //   → 不管切到哪个实例都拿 2 号机的 dataRoot（主人实测就是这个）。
        if (st.ns) l0.forEach(function (a) { if (a && (a.ns === st.ns || a.id === st.ns)) ac = a })
        if (!ac) l0.forEach(function (a) { if (!ac && a && !a.disabled) ac = a })
        if (!ac && l0.length) ac = l0[0]
      } catch (e) { ac = null }
      // ★ 2026-10-27：dock 卡片按**机器人实例的 dataRoot** 分源，不同实例不一样。
      //   注意不能用 ac.dataDir —— 那是「图库目录」({dataRoot}/表情包)，
      //   扩展 UI 在 {dataRoot}/.qqbot-extensions/ui/，差一级就扫不到。
      //   优先用 accounts 回给我们的 dataRoot；老版本没这个字段时从 cwd 推。
      var root = ''
      if (ac) {
        root = String(ac.dataRoot || '').trim()
        if (!root && ac.cwd) root = String(ac.cwd).replace(/[\\/]+$/, '') + '/dshqqbot'
      }
      if (_dockTabsLoaded && !force && root === _dockTabsRoot) return
      _dockTabsLoaded = true
      _dockTabsRoot = root
      var u = 'api/qqbot-settings/ext-ui/list'
      if (root) u += '?dataRoot=' + encodeURIComponent(root)
      fetch(u)
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) return
          var list = (j.items || []).filter(function (x) { return x.slot === 'dock' })
          window.__qqsDockTabs = list
          // paintBody 是 dock 闭包内的函数，模块级拿不到 —— 由它自己挂到 window 上
          if (typeof window.__qqsPaintBody === 'function') {
            try { window.__qqsPaintBody() } catch (e) { /* ignore */ }
          }
        })
        .catch(function () { _dockTabsLoaded = false })   // 失败允许下次重试
    }
    /** 把一张 dock 扩展卡片挂进面板（带当前实例/会话上下文） */
    function mountDockExtTab(bodyEl, extId) {
      extUiEnsureCss()
      var box = document.createElement('div')
      box.id = 'qqs-dock-ext'
      box.style.cssText = 'display:block'
      bodyEl.appendChild(box)
      mountDockCard(box, extId)
    }
    /** 真挂载：先取一次上下文（拿到 dataRoot / cwd），再挂卡片 —— 卡片里 dock.dataRoot 可直接同步读 */
    function mountDockCard(container, extId) {
      // ★ 2026-10-27：必须在这里也装上 CSS + 滚轮/拖拽监听。
      //   原来只在 mountDockExtTab 里调，但实际走的是本函数 —— 结果监听器根本没绑，
      //   表现就是「dock 页签既拖不动也滚不动」（主人实测）。
      //   extUiEnsureCss 是幂等的，多调几次没副作用。
      try { extUiEnsureCss() } catch (e) { /* ignore */ }
      // ★ 2026-10-27 修：state 是 dock 闭包里的变量，**模块级拿不到**！
      //   原来写 `typeof state !== 'undefined' ? state : {}` 永远拿到 {}，
      //   于是 ns 是空、没传给后端 → 后端用默认 NS(im-qqbot) → 读到别的实例的配置，
      //   卡片里显示的 appId/cwd 全错（主人实测）。改从 window 上取。
      var st = (window.__qqsDockState && typeof window.__qqsDockState === 'object') ? window.__qqsDockState : {}
      // ★ 2026-10-27：dataRoot/cwd 必须**先从账号列表取**，不能等 context 返回后再填 ——
      //   否则第一次请求必然没带上，后端只能落到宿主默认（表现为"切到 3 号机还是 2 号机的路径"）。
      var ac = null
      try {
        var l0 = (st.accts || [])
        // ★ 2026-10-27：dock 的 state 里**没有 acctId**（那是 SettingsPage 的 React state），
        //   必须用 st.ns 匹配。原来写 st.acctId 永远 undefined → 落到"第一个启用的实例"
        //   → 不管切到哪个实例都拿 2 号机的 dataRoot（主人实测就是这个）。
        if (st.ns) l0.forEach(function (a) { if (a && (a.ns === st.ns || a.id === st.ns)) ac = a })
        if (!ac) l0.forEach(function (a) { if (!ac && a && !a.disabled) ac = a })
        if (!ac && l0.length) ac = l0[0]
      } catch (e) { ac = null }
      var root0 = ''
      if (ac) {
        root0 = String(ac.dataRoot || '').trim()
        if (!root0 && ac.cwd) root0 = String(ac.cwd).replace(/[\\/]+$/, '') + '/dshqqbot'
      }
      // ★ 2026-10-27 修（主人实测：静默注入 diag 里 peer 是空的）：
      //   原来用 st.gid —— 那是「📇 群组管理」里选的目标群，**不一定是当前会话**。
      //   扩展卡片要"往当前会话注入"，必须用顶栏那个「当前会话」(state.detectedHit)，
      //   和「🤖 让 AI 写」按钮完全一致（它用的就是 detectedHit.peerId）。
      var __hit = st.detectedHit || null
      var peer = null
      if (__hit && __hit.peerId) {
        peer = { scope: __hit.scope === 'c2c' ? 'c2c' : 'group', peerId: String(__hit.peerId), name: __hit.name || '' }
      } else if (st.gid) {
        peer = { scope: 'group', peerId: String(st.gid) }
      }
      var base = {
        ns: st.ns || '',
        appId: (ac && ac.appId) || '',
        dataRoot: root0,
        cwd: (ac && ac.cwd) || '',
        peer: peer,
      }
      var u = 'api/qqbot-settings/dock-data?what=context'
      if (base.ns) u += '&ns=' + encodeURIComponent(base.ns)
      if (base.dataRoot) u += '&dataRoot=' + encodeURIComponent(base.dataRoot)
      if (base.cwd) u += '&cwd=' + encodeURIComponent(base.cwd)
      if (peer) u += '&peer=' + encodeURIComponent(peer.peerId) + '&scope=' + peer.scope
      fetch(u)
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (j && j.ok && j.context) {
            base.appId = j.context.appId || ''
            base.dataRoot = j.context.dataRoot || ''
            base.cwd = j.context.cwd || ''
          }
        })
        .catch(function () { /* 取不到就用空值，卡片自己再 dock.context() */ })
        .then(function () {
          extUiMountCard(container, extId, 'qqs-dock-ext-card', base)
        })
    }

    function SettingsPage(props) {
      var close = props && props.close
      // 多账号: 当前操作账号的 settings 命名空间(主=im-qqbot 不带参, 其它=实例 id)
      var _acctNs = props && props.acct && props.acct.ns && props.acct.ns !== 'im-qqbot' ? String(props.acct.ns) : ''
      var [cfg, setCfg] = useState(null)
      var [saved, setSaved] = useState(null)      // 已保存快照(2026-10-10: 只提交 diff 用)
      var [rev, setRev] = useState(undefined)
      var [msg, setMsg] = useState('')
      var [q, setQ] = useState('')                // 搜索词(上栏: 精确)
      var [q2, setQ2] = useState('')              // 搜索词(下栏: 模糊/语义)
      var [folded, setFolded] = useState({})      // 分组折叠

      // 读取后只做**必要的类型规整**(渲染安全), 其余原样保留 ⇒ diff 才准
      function tidy(v) {
        var o = cloneCfg(v) || {}
        if (typeof o.groupPrompt !== 'string') o.groupPrompt = DEFAULT_GROUP_PROMPT
        if (o.outboundMode === 'active' || typeof o.outboundMode !== 'string') o.outboundMode = 'adaptive'
        if (o.questionsMode !== 'blocking') o.questionsMode = 'async'
        return o
      }
      function load() {
        setMsg('加载中…')
        fetch(READ + (_acctNs ? '?ns=' + encodeURIComponent(_acctNs) : '')).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.value) {
            var v = tidy(d.value)
            setCfg(v); setSaved(cloneCfg(v)); setRev(d.revision); setMsg('')
          } else { setMsg('读取失败: ' + JSON.stringify(d)) }
        }).catch(function (e) { setMsg('读取异常: ' + e.message) })
      }
      useEffect(function () { load() }, [])

      if (!cfg) return h('div', null, h('p', null, msg || '加载中…'))

      function set(path, value) { setCfg(function (c) { return sPath(c, path, value) }) }
      var ctx = { cfg: cfg, set: set, ns: _acctNs || undefined }
      var patch = buildPatch(cfg, saved)
      var dirtyN = Object.keys(patch).length

      function doSave() {
        if (!dirtyN) { setMsg('没有改动, 无需保存'); return }   // 按钮不再 disabled ⇒ 点了一定有回应
        setMsg('保存中…(提交 ' + dirtyN + ' 项)')
        fetch(UPDATE, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: patch, expectedRevision: rev, ns: _acctNs || undefined }),
        }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
          if (d && d.value) {
            var v2 = tidy(d.value)
            setCfg(v2); setSaved(cloneCfg(v2)); setRev(d.revision)
            setMsg('已保存 ✓(live 生效)')
          } else if (d && d.error) { setMsg('保存失败: ' + d.error) }
          else { setMsg('保存失败(未知响应)') }
        }).catch(function (e) { setMsg('保存异常: ' + e.message) })
      }

      // 搜索：上栏=精确(字面命中名称/说明/键名)；下栏=模糊/语义(程序算相似度, 按分排序)
      var qq = q.trim().toLowerCase()
      var qs = q2.trim()
      var sem = qs ? sqScores(qs) : null
      var SEM_MIN = 0.1
      function hitF(f) {
        if (!qq) return true
        if (f.t === 'note' || f.t === 'custom') return false
        return (String(f.label || '') + ' ' + String(f.hint || '') + ' ' + String(f.k || '')).toLowerCase().indexOf(qq) >= 0
      }
      function semOf(f) { return (sem && f.k) ? (sem[f.k] || 0) : 0 }
      function semGroup(g) {
        if (!sem) return 0
        return sqCos(sqVec(qs), sqVec(String(g.title || '') + ' ' + String(g.kw || '') + ' ' + String(g.desc || '')))
      }
      function hitText(t) { return !qq || String(t || '').toLowerCase().indexOf(qq) >= 0 }
      function jump(id) {
        var el = document.getElementById('qqs-g-' + id)
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }

      var visible = FGROUPS.map(function (g) {
        var fields = (g.fields || []).filter(function (f) {
          var special = (f.t === 'note' || f.t === 'custom')
          if (special) return (!qq && !sem)                  // 一搜索，note/custom 就不参与
          if (qq && !hitF(f)) return false                   // 上栏：必须字面命中
          if (sem && semOf(f) < SEM_MIN) return false        // 下栏：相似度得够
          return true
        })
        if (sem) fields = fields.slice().sort(function (a, b) { return semOf(b) - semOf(a) })
        var show = (!qq && !sem) || fields.length > 0 || (qq && hitText(g.title + ' ' + g.desc)) || (sem && semGroup(g) >= 0.15)
        if (!show) return null
        var isFolded = !!folded[g.id] && !qq && !sem
        var header = h('div', {
          onClick: function () { setFolded(function (m) { var n = Object.assign({}, m); n[g.id] = !m[g.id]; return n }) },
          style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '10px 14px', borderBottom: isFolded ? 'none' : '1px solid ' + T.borderLight, userSelect: 'none' },
        },
          h('span', { style: { fontSize: 14, fontWeight: 700, color: T.text } }, g.icon + ' ' + g.title),
          h('span', { style: { flex: 1 } }),
          !qq && (g.fields || []).length > 0 ? h('span', { style: { fontSize: 12, color: T.text3 } }, ((g.fields || []).length) + ' 项') : null,
          h('span', { style: { fontSize: 12, color: T.text3 } }, isFolded ? '▸' : '▾'))
        return h('div', { key: g.id, id: 'qqs-g-' + g.id, style: { background: T.card, border: '1px solid ' + T.border, borderRadius: T.radiusLg, marginBottom: 12, overflow: 'hidden' } },
          header,
          isFolded ? null : h('div', { style: { padding: '10px 14px 14px' } },
            h(GroupDesc, { text: g.desc }),
            fields.map(function (f, i) { return h(FieldRow, { key: (f.k || 'x') + '#' + i, f: f, ctx: ctx, sem: sem ? semOf(f) : 0 }) })))
      }).filter(Boolean)

      var chips = h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 10px' } },
        FGROUPS.map(function (g) {
          return h('span', {
            key: g.id, onClick: function () { jump(g.id) },
            style: { fontSize: 12, color: T.text2, background: T.cardHi, border: '1px solid ' + T.border, borderRadius: 999, padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap' },
          }, GSHORT[g.id] || (g.icon + ' ' + g.title))
        }))

      var toolbar = h('div', { style: { margin: '0 0 10px' } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
        h('span', { style: { fontSize: 11, color: T.text3, flexShrink: 0 } }, '精确'),
        h('input', {
          className: 'qqs-inp', placeholder: '🔍 精确搜索：字面匹配 名称 / 说明 / 键名（如"间隔""审批"）',
          style: { flex: 1, minWidth: 180, padding: '5px 10px', border: '1px solid ' + T.border, borderRadius: T.radius, background: T.card },
          value: q, onChange: function (e) { setQ(e.target.value) },
        }),
        q ? h('span', { onClick: function () { setQ('') }, style: { fontSize: 12, color: T.text3, cursor: 'pointer' } }, '清空') : null,
        dirtyN
          ? h('span', { style: { fontSize: 12, color: T.warn, fontWeight: 700, whiteSpace: 'nowrap' } }, '● 有未保存改动(' + dirtyN + ')')
          : h('span', { style: { fontSize: 12, color: T.success, whiteSpace: 'nowrap' } }, '✓ 已同步'),
        msg ? h('span', { style: { fontSize: 12, color: T.text2, whiteSpace: 'nowrap' } }, msg) : null,
        h(SButton, { variant: 'primary', onClick: doSave }, dirtyN ? ('保存(' + dirtyN + ')') : '保存'),
        h(SButton, { variant: 'ghost', onClick: load }, '放弃修改')),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11, color: T.text3, flexShrink: 0 } }, '模糊'),
          h('input', {
            className: 'qqs-inp', placeholder: '🧠 语义搜索：说人话也行（"回复太慢""图刷屏""踢人""进群申请"）',
            style: { flex: 1, minWidth: 180, padding: '5px 10px', border: '1px solid ' + T.border, borderRadius: T.radius, background: T.card },
            value: q2, onChange: function (e) { setQ2(e.target.value) },
          }),
          q2 ? h('span', { onClick: function () { setQ2('') }, style: { fontSize: 12, color: T.text3, cursor: 'pointer' } }, '清空') : null,
          h('span', { style: { fontSize: 11, color: T.text3, whiteSpace: 'nowrap' } }, '程序算的相似度 · 本地即时')))

      // ── 扩展 UI 卡片（2026-10-26）─────────────────────────────────────────
      //   扩展在 {dataRoot}/.qqbot-extensions/ui/<id>/ 放 card.html / card.css / card.js，
      //   这里拉过来用 **Shadow DOM** 挂到设置页底部。扫描与安全校验见 src/features/ext-ui.ts。
      //   用 Shadow DOM 的两个理由：
      //     ① 扩展写的 CSS 不会污染这个 535KB 单文件里的任何样式（一条全局 button{} 就能改全站）
      //     ② 扩展脚本报错只白自己那张卡，不整页崩
      var EXT_UI_LIST = 'api/qqbot-settings/ext-ui/list'
      var EXT_UI_FILE = 'api/qqbot-settings/ext-ui/file?f='
      // ★ 2026-10-27 删：extUiText 只被 mountExtUiCards 用过（已删），成死代码。
      function extUiApi(extId) {
        return {
          extId: extId,
          // 扩展自己的只读/只写接口走 /api/ext/<id>/…（由扩展自己注册，本插件不代管）
          api: function (p, opts) {
            return fetch('api/ext/' + encodeURIComponent(extId) + String(p || ''),
              Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
              .then(function (r) { return r.json() })
              .catch(function () { return null })
          },
          toast: function (m) { try { window.alert(String(m)) } catch (e) { /* ignore */ } },
        }
      }
      function injectExtUiCss() {
        if (document.getElementById('qqs-ext-css')) return
        var s = document.createElement('style')
        s.id = 'qqs-ext-css'
        // 横向滑动：抄 .dk-tab 那套已在机器上跑熟的写法（overflow-x + 惯性 + 隐藏滚动条）。
        // ★ flex:0 0 auto 是关键 —— 少了这句卡片会被 flex 压成一条缝，这是最常见的坑。
        // scroll-snap 让"滑一下正好停在卡片边缘"，不会卡在半张卡中间。
        s.textContent = ''
          + '.qqs-ext-cards{display:flex;gap:10px;overflow-x:auto;overflow-y:hidden;'
          + '-webkit-overflow-scrolling:touch;scrollbar-width:none;'
          + 'scroll-snap-type:x proximity;padding:2px 0 6px}'
          + '.qqs-ext-cards::-webkit-scrollbar{display:none}'
          + '.qqs-ext-card{flex:0 0 auto;scroll-snap-align:start;min-width:220px;max-width:320px}'
          // 顶部页签条：内置四页 + 扩展页签，扩展多了横向滑动（2026-10-26）
          + '.qqs-top-tabs{scrollbar-width:none}'
          + '.qqs-top-tabs::-webkit-scrollbar{display:none}'
          // 扩展整页视图：让卡片在页内能撑开（卡片自身宽度由 :host 决定）
          + '.qqs-ext-page-card{display:block}'
        document.head.appendChild(s)
      }
      // ★ 2026-10-27 删：这是第一版「把扩展卡片内嵌在设置页内容区」的实现。
      //   后来改成顶栏页签（ExtCardPage + Shadow DOM），两套并存会导致
      //   同一张卡在设置页出现两次；而且这里用的还是闭包内那个旧 extUiApi
      //   （没有 getConfig/setConfig）→ 卡片报 'qqbotExt.getConfig is not a function'。
      //   统一走顶栏页签后删掉。

      return h('div', { style: { maxWidth: 720 } },
        h('h2', { style: { margin: '0 0 6px' } }, 'QQ 机器人设置'),
        h('p', { style: { fontSize: 12, color: T.text3, margin: '0 0 10px' } }, '改完点「保存」立刻生效(不用重启)。看不懂的项放着别动就行;想恢复"不限制"就把数字填 0、勾选取消、列表清空。只提交你改过的字段——没碰的项不会被动。'),
        toolbar,
        chips,
        visible.length ? visible : h(Empty, { icon: '🔍', text: '没有匹配「' + q + '」的设置项' }),
        h('div', { style: { margin: '14px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(SButton, { variant: 'primary', onClick: doSave }, dirtyN ? ('保存(' + dirtyN + ' 项改动)') : '保存'),
          h(SButton, { variant: 'ghost', onClick: load }, '放弃修改(重新读取)'),
          msg ? h('span', { style: { fontSize: 13, color: T.text2 } }, msg) : null,
          close ? h(SButton, { variant: 'ghost', onClick: close }, '完成') : null),
        // ★ 2026-10-27：这里原来挂 #qqs-ext-cards（内嵌卡片），已改为顶栏页签，容器不需要了
        null)
    }

        // ── ⑥ QQ 群管理(单开大卡片; P3+ 设计系统版: 横排 Tab + 状态条 + 表格 + 空状态 + 预留接口位) ──
    // 能力就绪度: 官方未开放位保留(红条+行动), 不置灰糊弄; 业务名词做 Tab 骨架。
    var GROUP_TABS = [
      { key: 'send', label: '发消息', open: true },
      { key: 'join', label: '入群审批', open: true },
      { key: 'mute', label: '禁言', open: true },
      { key: 'members', label: '成员信息', open: false, gateHuman: '获取群成员列表: 官方尚未开放(内邀中), 等待公测后自动可用' },
      { key: 'blacklist', label: '黑名单', open: false, gateHuman: '群黑名单: 官方接口尚未开放, 等待公测后自动可用' },
    ]
    function GroupAdminPanel(props) {
      var nsq = props && props.ns ? '?ns=' + encodeURIComponent(props.ns) : ''
      var [accts, setAccts] = useState(null)
      var [gid, setGid] = useState('')
      var [tab, setTab] = useState('join')
      var [joins, setJoins] = useState(null)
      var [mute, setMute] = useState(null)
      var [msg, setMsg] = useState('')
      var [busy, setBusy] = useState('')
      var [bindGid, setBindGid] = useState('')
      var [bindName, setBindName] = useState('')
      var [members, setMembers] = useState(null)
      var [muteSecs, setMuteSecs] = useState('60')
      var [muteTarget, setMuteTarget] = useState('')
      var [sendText, setSendText] = useState('')

      function loadMembers() {
        if (!gid) return
        fetch('api/qqbot-settings/group/members_local' + nsq + (nsq ? '&' : '?') + 'gid=' + encodeURIComponent(gid)).then(function (r) { return r.json() }).then(function (d) {
          setMembers(d && d.ok ? (d.members || []) : [])
        }).catch(function () { setMembers([]) })
      }

      function loadAccounts() {
        fetch('api/qqbot-settings/group/accounts' + nsq).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.error) { setMsg('群面板: ' + d.error); setAccts([]); return }
          var list = (d && Array.isArray(d.groups) ? d.groups : []).map(function (g) { return { gid: g.gid, name: g.name || '', from: g.from || '' } })
          setAccts(list)
          if (list.length && !gid) setGid(list[0].gid)
          else if (list.length === 0) { setJoins(null); setMute(null) }
        }).catch(function (e) { setMsg('群列表加载失败: ' + e.message) })
      }
      function refresh() {
        if (!gid) return
        if (tab === 'join') {
          fetch('api/qqbot-settings/group/join_requests' + nsq + (nsq ? '&' : '?') + 'gid=' + encodeURIComponent(gid)).then(function (r) { return r.json() }).then(function (d) {
            if (d && d.ok) setJoins(d); else setMsg((d && d.err && d.err.human) || '申请列表加载失败')
          }).catch(function (e) { setMsg('申请列表加载异常: ' + e.message) })
        } else if (tab === 'mute') {
          fetch('api/qqbot-settings/group/mute_state' + nsq + (nsq ? '&' : '?') + 'gid=' + encodeURIComponent(gid)).then(function (r) { return r.json() }).then(function (d) {
            if (d && d.ok) setMute(d); else setMsg((d && d.err && d.err.human) || '禁言状态加载失败')
          }).catch(function (e) { setMsg('禁言状态加载异常: ' + e.message) })
        }
      }
      useEffect(function () { loadAccounts() }, [])
      useEffect(function () { refresh(); loadMembers() }, [gid, tab])

      function doApprove(mid, op) {
        var reason = op === 'decline' ? window.prompt('拒绝理由(可留空)') : '-'
        if (op === 'decline' && reason === null) return
        setBusy('approve-' + mid)
        fetch('api/qqbot-settings/group/approve', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ gid: gid, member_openid: mid, op: op, reason: reason || '' }, props.ns ? { ns: props.ns } : {})),
        }).then(function (r) { return r.json() }).then(function (d) {
          setBusy('')
          setMsg((d && d.msg) || (d && d.err && d.err.human) || '审批失败')
          refresh()
        }).catch(function (e) { setBusy(''); setMsg('审批异常: ' + e.message) })
      }
      function doMute(mid, action, seconds) {
        var secs = action === 'mute' ? Math.round(Number(seconds || 600)) : 0
        setBusy('mute-' + mid)
        fetch('api/qqbot-settings/group/mute', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ gid: gid, member_openid: mid, action: action, seconds: secs }, props.ns ? { ns: props.ns } : {})),
        }).then(function (r) { return r.json() }).then(function (d) {
          setBusy('')
          setMsg((d && d.msg) || (d && d.err && d.err.human) || '操作失败')
          refresh()
        }).catch(function (e) { setBusy(''); setMsg('禁言异常: ' + e.message) })
      }
      function doBind() {
        var g = bindGid.trim()
        if (!g) { setMsg('先粘贴 group_openid'); return }
        fetch('api/qqbot-settings/group/bind', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ gid: g, name: bindName.trim() }, props.ns ? { ns: props.ns } : {})),
        }).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.ok) { setMsg('已登记群 ✓'); setBindGid(''); setBindName(''); loadAccounts() }
          else setMsg((d && d.error) || '绑定失败')
        }).catch(function (e) { setMsg('绑定异常: ' + e.message) })
      }
      function doSend() {
        var t = sendText.trim()
        if (!t) { setMsg('先输入要发送的内容'); return }
        setBusy('send')
        fetch('api/qqbot-settings/group/send', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ gid: gid, text: t }, props.ns ? { ns: props.ns } : {})),
        }).then(function (r) { return r.json() }).then(function (d) {
          setBusy('')
          setMsg((d && d.msg) || (d && d.err && d.err.human) || (d && d.error) || '发送结果未知')
          if (d && d.ok) setSendText('')
        }).catch(function (e) { setBusy(''); setMsg('发送异常: ' + e.message) })
      }

      var curTabMeta = null
      GROUP_TABS.forEach(function (t) { if (t.key === tab) curTabMeta = t })
      var curGroup = null
      ;(accts || []).forEach(function (a) { if (a.gid === gid) curGroup = a })
      var groupSelName = (curGroup && curGroup.name) ? curGroup.name : ''
      var groupSel = accts === null ? h('span', { style: { fontSize: T.fsSm, color: T.text3 } }, '群列表加载中…')
        : accts.length === 0 ? h('span', { style: { fontSize: T.fsSm, color: T.warn } }, '暂无群(事件累积/下方登记后出现)')
          : h('select', { className: 'qqs-inp', style: { padding: '3px 8px', maxWidth: 320, border: '1px solid ' + T.border, borderRadius: T.radius }, value: gid, onChange: function (e) { setGid(e.target.value); setMsg('') } },
            accts.map(function (a) {
              return h('option', { key: a.gid, value: a.gid }, (a.name ? a.name + ' · ' : '') + a.gid.slice(0, 12) + '…' + (a.from ? ' [' + a.from + ']' : ''))
            }))

      var joinCols = [
        { key: 'username', title: '昵称', width: '18%', render: function (v, r) { return h('span', { style: { fontWeight: 600 } }, v || '(未知)') } },
        { key: 'source', title: '来源', width: '10%', render: function (v, r) { return h('span', { style: { color: T.text2 } }, v || '-') } },
        { key: 'verify', title: '验证消息', render: function (v, r) { return h('span', { style: { color: T.text2 } }, v || '-') } },
        { key: 'risk', title: '风险', width: '18%', render: function (v, r) { return v ? h('span', { style: { color: T.danger } }, '⚠ ' + v) : h('span', { style: { color: T.text3 } }, '-') } },
        { key: 'op', title: '操作', width: '20%', render: function (v, r) {
          var busying = busy === 'approve-' + r.member_openid
          return h('span', { style: { display: 'inline-flex', gap: 6 } },
            h(SButton, { variant: 'primary', size: 'sm', disabled: !!busy, onClick: function () { doApprove(r.member_openid, 'approve') } }, busying ? '处理中…' : '通过'),
            h(SButton, { variant: 'danger', size: 'sm', disabled: !!busy, onClick: function () { doApprove(r.member_openid, 'decline') } }, '拒绝'))
        } },
      ]
      var joinRows = ((joins && joins.ok && joins.list) || []).map(function (j) {
        return {
          username: j.username || '(未知昵称)',
          source: j.apply_source === 'invited' ? '被邀请' : '主动申请',
          verify: j.verify_human || (j.verify_info && j.verify_info.verify_message) || (j.verify_info && j.verify_info.method) || '',
          risk: j.risk_tips || '',
          member_openid: j.member_openid,
        }
      })

      var muteMode = (mute && mute.data && mute.data.global_rule && mute.data.global_rule.mode) || 'none'
      var muteCols = [
        { key: 'username', title: '成员', width: '30%', render: function (v, r) { return h('span', { style: { fontWeight: 600 } }, v || String(r.member_openid).slice(0, 12)) } },
        { key: 'expire', title: '禁言至', render: function (v) { return h('span', { style: { color: T.text2 } }, v || '?') } },
        { key: 'op', title: '操作', width: '18%', render: function (v, r) {
          var busying = busy === 'mute-' + r.member_openid
          return h(SButton, { variant: 'ghost', size: 'sm', disabled: !!busy, onClick: function () { doMute(r.member_openid, 'unmute') } }, busying ? '处理中…' : '解除')
        } },
      ]
      var muteRows = (((mute && mute.data && mute.data.members) || [])).map(function (m) { return { username: m.username || '', member_openid: m.member_openid, expire: m.mute_expire_at || '' } })

      var body = null
      if (curTabMeta && curTabMeta.open === false) {
        body = h('div', null,
          h(StatusBar, { tone: 'danger', action: { label: '去开放平台申请', onClick: function () { window.open('https://q.qq.com', '_blank') } } }, curTabMeta.gateHuman || '该能力官方尚未开放'),
          h('div', { style: { border: '1px dashed ' + T.border, borderRadius: T.radius, padding: '24px', textAlign: 'center', color: T.text3, fontSize: T.fsSm } },
            '此功能位已预留 —— 官方开放接口后此处自动点亮, 无需等待插件更新'))
      } else if (!gid) {
        body = h(Empty, { icon: '👥', text: '先选择或登记一个群, 再查看/操作' })
      } else if (tab === 'send') {
        // 发消息: 以机器人身份直接向目标群发文本(面板=主人直发)
        body = h('div', null,
          h(StatusBar, { tone: 'info' }, '以机器人身份向「' + (groupSelName) + '」发消息 —— 内容会以 bot 名义出现在群里。'),
          h('textarea', { className: 'qqs-area', style: { width: '100%', minHeight: 90, marginTop: 8 }, placeholder: '输入要发的消息…(@某人 用 <@对方openid> 无斜杠 或 <qqbot-at-user id="对方openid" />)', value: sendText, onChange: function (e) { setSendText(e.target.value) } }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
            h(SButton, { variant: 'primary', disabled: busy === 'send', onClick: doSend }, busy === 'send' ? '发送中…' : '🚀 发送到群'),
            h('span', { style: { fontSize: T.fsSm, color: T.text3 } }, '已输 ' + sendText.length + '/2000 字')))
      } else if (tab === 'join') {
        body = joins === null ? h(Empty, { icon: '⏳', text: '加载中…' })
          : h('div', null,
            h(StatusBar, { tone: 'info' }, '数据来自 QQ 官方接口; 机器人需为群管理员。通过/拒绝将直接生效并写入审计日志。'),
            h(DataTable, { cols: joinCols, rows: joinRows, emptyText: '当前没有待审批的入群申请' }))
      } else if (tab === 'mute') {
        // 禁言页: ①选人禁言(本地成员清单) ②正在禁言中的成员(官方状态)
        var pickList = members === null ? h(Empty, { icon: '⏳', text: '加载成员中…' })
          : members.length === 0 ? h('div', { style: { border: '1px dashed ' + T.border, borderRadius: T.radius, padding: '12px', textAlign: 'center', color: T.text3, fontSize: T.fsSm } },
              '本地暂无成员记录 —— 让群友在群里说句话, 机器人就能记住他们, 之后这里可直接选人禁言(官方成员列表未开放)')
          : h('div', { style: { maxHeight: 260, overflowY: 'auto', border: '1px solid ' + T.border, borderRadius: T.radius } },
              members.map(function (m) {
                var busying = busy === 'mute-' + m.mid
                return h('div', { key: m.mid, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: '1px solid ' + T.borderLight, fontSize: T.fsSm } },
                  h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (m.name || '(未知名)') + ' · ' + m.mid.slice(0, 10) + '…'),
                  h('input', { className: 'qqs-inp', style: { width: 70, padding: '1px 6px', border: '1px solid ' + T.border, borderRadius: T.radius }, type: 'number', min: 1, defaultValue: muteSecs, onChange: function (e) { setMuteSecs(e.target.value) } }),
                  h('span', { style: { color: T.text3 } }, '分钟'),
                  h(SButton, { variant: 'danger', size: 'sm', disabled: !!busy, onClick: function () { doMute(m.mid, 'mute', Number(muteSecs || 60) * 60) } }, busying ? '处理中…' : '禁言'))
              }))
        body = mute === null ? h(Empty, { icon: '⏳', text: '加载中…' })
          : h('div', null,
            h('div', { style: { fontWeight: 700, fontSize: 13, margin: '10px 0 4px' } }, '① 选择成员禁言'),
            pickList,
            h('div', { style: { fontWeight: 700, fontSize: 13, margin: '14px 0 4px' } }, '② 正在禁言中(官方状态)'),
            h(StatusBar, { tone: 'info' }, '全员禁言: ' + (muteMode === 'always' ? '常开' : muteMode === 'schedule' ? '定时' : '关闭') + ' —— 只能操作普通成员, 群主/管理员不可禁。'),
            h(DataTable, { cols: muteCols, rows: muteRows, emptyText: '没有正在禁言的成员' }))
      } else if (tab === 'members') {
        // 成员信息: 红条(官方未开放)+ 本地兜底名单(见到的发言者)
        var memRows = (members || []).map(function (m) { return { name: m.name || '(未知名)', mid: m.mid, seen: new Date(m.lastSeen).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } })
        var memCols = [
          { key: 'name', title: '昵称', width: '24%' },
          { key: 'mid', title: '成员 ID', render: function (v) { return h('span', { style: { color: T.text2, wordBreak: 'break-all' } }, v) } },
          { key: 'seen', title: '最近发言', width: '22%', render: function (v) { return h('span', { style: { color: T.text3 } }, v) } },
        ]
        body = h('div', null,
          h(StatusBar, { tone: 'danger', action: { label: '去开放平台申请', onClick: function () { window.open('https://q.qq.com', '_blank') } } }, '官方"群成员列表"接口尚未开放 —— 下方为本地兜底名单(机器人见过的发言者), 仅用于帮你认人。'),
          h('div', { style: { fontWeight: 700, fontSize: 13, margin: '10px 0 4px' } }, '本地成员清单(机器人见过的)'),
          h(DataTable, { cols: memCols, rows: memRows, emptyText: '暂无记录 —— 群友发言后自动出现' }))
      }

      return h('div', { style: { ...card, padding: '4px 0 12px', margin: '12px 0', overflow: 'hidden' } },
        h('div', { style: { padding: '12px 16px', borderBottom: '1px solid ' + T.border, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: T.fsTitle, fontWeight: 700 } }, '🛡 群管理'),
          h('span', { style: { fontSize: T.fsSm, color: T.text3 } }, '直连 QQ 官方, 面板操作 = 主人直发'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: T.fsSm, color: T.text2 } }, '目标群'),
          groupSel,
          h(SButton, { variant: 'ghost', size: 'sm', onClick: refresh }, '刷新')),
        h('div', { style: { padding: '0 16px' } },
          h(TabBar, { items: GROUP_TABS.map(function (t) { return { key: t.key, label: t.label + (t.open ? '' : '(待开放)'), badge: t.key === 'join' ? joinRows.length : 0 } }), value: tab, onChange: function (k) { setTab(k); setMsg('') } })),
        h('div', { style: { padding: '0 16px' } }, body),
        h('div', { style: { margin: '12px 16px 0', borderTop: '1px solid ' + T.borderLight, paddingTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: T.fsSm, color: T.text2 } }, '登记群(官方无"我的群列表", 手动粘贴):'),
          h('input', { className: 'qqs-inp', style: { width: 200, padding: '3px 8px', border: '1px solid ' + T.border, borderRadius: T.radius }, placeholder: 'group_openid', value: bindGid, onChange: function (e) { setBindGid(e.target.value) } }),
          h('input', { className: 'qqs-inp', style: { width: 100, padding: '3px 8px', border: '1px solid ' + T.border, borderRadius: T.radius }, placeholder: '备注(可选)', value: bindName, onChange: function (e) { setBindName(e.target.value) } }),
          h(SButton, { variant: 'primary', size: 'sm', onClick: doBind }, '绑定'),
          msg ? h('span', { style: { fontSize: T.fsSm, color: T.success } }, msg) : null))
    }

    var API_LIST = 'api/qqbot-settings/stickers'
    var API_IMG = 'api/qqbot-settings/sticker-img?id='
    var API_BATCH = 'api/qqbot-settings/stickers/batch'
    var API_IMPORT = 'api/qqbot-settings/stickers/import'
    var LAYER_LABEL = { candidate: '待整理', library: '收藏', trash: '回收站' }

    function Lightbox(props) {
      var it = props.item || {}
      var lbDD = props.storeDir || ''
      var [tagsText, setTagsText] = useState((it.tags || []).join('，'))
      var [desc, setDesc] = useState(it.desc || '')
      var [saved, setSaved] = useState('')
      function doBatch(op, extra) {
        fetch(API_BATCH, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ op: op, ids: [it.id], dataDir: lbDD || undefined }, extra || {})),
        }).then(function (r) { return r.json() }).then(function () { setSaved(op === 'tag' ? '已保存 ✓' : (op === 'promote' ? '已移入收藏 ✓' : '已送回收站 ✓')); props.onChanged && props.onChanged() }).catch(function (e) { setSaved('失败:' + e.message) })
      }
      return h('div', { style: { position: 'fixed', inset: 0, background: '#000c', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }, onClick: function () { props.onClose() } },
        h('div', { className: 'qqs-modal', style: { background: '#22252e', borderRadius: 12, padding: 14, maxWidth: 560, width: '92%', maxHeight: '88vh', overflow: 'auto' }, onClick: function (e) { e.stopPropagation() } },
          h('img', { src: API_IMG + encodeURIComponent(it.id) + (lbDD ? '&dataDir=' + encodeURIComponent(lbDD) : ''), style: { maxWidth: '100%', maxHeight: '46vh', borderRadius: 8, display: 'block', margin: '0 auto', objectFit: 'contain' } }),
          h('p', { style: { fontSize: 12, color: '#999' } }, '图号 ' + it.id.slice(0, 8) + ' · ' + (LAYER_LABEL[it.layer] || it.layer) + ' · 用过 ' + (it.useCount || 0) + ' 次'),
          h('div', { style: { fontSize: 13, margin: '4px 0' } }, '标签(逗号或空格分开都行,自动去重):'),
          h('input', { className: 'qqs-inp', style: { width: '100%', padding: '4px 8px' }, value: tagsText, onChange: function (e) { setTagsText(e.target.value) } }),
          h('div', { style: { fontSize: 13, margin: '6px 0 2px' } }, '描述(一句话说明画面和适合场合):'),
          h('textarea', { className: 'qqs-area', style: { width: '100%', minHeight: 54 }, value: desc, onChange: function (e) { setDesc(e.target.value) } }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0', fontSize: 12, color: '#aaa' } },
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' } }, it.path || ''),
            h('button', { className: 'qqs-btn', style: { padding: '2px 8px', fontSize: 12 }, onClick: function () { try { navigator.clipboard.writeText(it.path || '').then(function () { setSaved('原路径已复制 ✓') }).catch(function () { setSaved('复制失败') }) } catch (e2) { setSaved('复制失败:' + e2.message) } } }, '复制原路径')),
          h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { className: 'qqs-btn', onClick: function () { doBatch('tag', { tags: tagsText.split(/[,，\s]+/).map(function (s) { return s.trim() }).filter(Boolean), desc: desc }) } }, '保存'),
            it.layer !== 'library' ? h('button', { className: 'qqs-btn', onClick: function () { doBatch('promote') } }, '移入收藏') : null,
            it.layer !== 'trash' ? h('button', { className: 'qqs-btn', onClick: function () { doBatch('trash') } }, '送回收站') : null,
            it.layer === 'trash' ? h('button', { className: 'qqs-btn', onClick: function () { doBatch('restore') } }, '恢复') : null,
            saved ? h('span', { style: { fontSize: 12, color: '#2f9e44' } }, saved) : null,
            h('button', { className: 'qqs-btn', onClick: function () { props.onClose() } }, '关闭'))))
    }

    function ImportPanel(props) {
      var ipDD = props.storeDir || ''
      var [text, setText] = useState('')
      var [fileMsg, setFileMsg] = useState('')
      var [result, setResult] = useState('')
      var fileInput = React.useRef(null)
      function doImport(extra) {
        setResult('导入中…')
        fetch(API_IMPORT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({}, extra, ipDD ? { dataDir: ipDD } : {})) })
          .then(function (r) { return r.json() }).then(function (d) {
            var rs = (d && d.results) || []
            var ok = 0, dup = 0, err = 0, errList = []
            rs.forEach(function (x) { if (x.status === 'new') ok += 1; else if (x.status === 'dup') dup += 1; else { err += 1; if (errList.length < 5) errList.push(x.ref) } })
            setResult('完成: 新增 ' + ok + ' 张, 已有跳过 ' + dup + ' 张' + (err ? ', 失败 ' + err + ' 张(' + errList.join('; ') + ')' : ''))
          }).catch(function (e) { setResult('失败:' + e.message) })
      }
      function pickFiles() {
        var files = fileInput.current && fileInput.current.files ? Array.from(fileInput.current.files).slice(0, 20) : []
        if (!files.length) return
        setFileMsg('读取中 ' + files.length + ' 个文件…')
        var reads = files.map(function (f) {
          return new Promise(function (res) {
            var rd = new FileReader()
            rd.onload = function () {
              var b64 = String(rd.result || '').split(',')[1] || ''
              res({ name: f.name, dataBase64: b64 })
            }
            rd.onerror = function () { res(null) }
            rd.readAsDataURL(f)
          })
        })
        Promise.all(reads).then(function (list) {
          var filesArr = list.filter(Boolean)
          setFileMsg('')
          doImport({ files: filesArr })
        })
      }
      return h('div', { style: { position: 'fixed', inset: 0, background: '#000c', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }, onClick: function () { props.onClose() } },
        h('div', { className: 'qqs-modal', style: { background: '#22252e', borderRadius: 12, padding: 14, maxWidth: 520, width: '92%' }, onClick: function (e) { e.stopPropagation() } },
          h('h3', { style: { marginTop: 0 } }, '导入表情包'),
          h('div', null,
            h('input', { className: 'qqs-inp', ref: fileInput, type: 'file', accept: 'image/*', multiple: true }),
            h('button', { className: 'qqs-btn', style: { marginLeft: 8 }, onClick: pickFiles }, '上传所选图片')),
          h('p', { style: { fontSize: 12, color: '#999' } }, '或粘贴每行一个：图片URL 或 电脑上的图片路径'),
          h('textarea', { className: 'qqs-area', style: { width: '100%', minHeight: 70 }, value: text, placeholder: 'https://… 或 D:\\…\\xx.jpg', onChange: function (e) { setText(e.target.value) } }),
          h('div', { style: { margin: '6px 0' } },
            h('button', { className: 'qqs-btn', onClick: function () {
              var lines = text.split('\n').map(function (s) { return s.trim() }).filter(Boolean)
              var urls = lines.filter(function (x) { return /^https?:\/\//i.test(x) })
              var paths = lines.filter(function (x) { return !/^https?:\/\//i.test(x) })
              doImport({ urls: urls, paths: paths })
            } }, '导入粘贴的内容')),
          fileMsg ? h('p', { style: { fontSize: 12 } }, fileMsg) : null,
          result ? h('p', { style: { fontSize: 13, color: '#2f9e44' } }, result) : null,
          h('div', { style: { textAlign: 'right', marginTop: 8 } }, h('button', { className: 'qqs-btn', onClick: function () { props.onClose() } }, '关闭'))))
    }

    function GalleryPage(props) {
      // 多账号: 图库按当前账号 dataDir(各号各库)
      var DD = props && props.acct && props.acct.dataDir ? String(props.acct.dataDir) : ''
      var [items, setItems] = useState([])
      var [layer, setLayer] = useState('')
      var [untagged, setUntagged] = useState(false)
      var [q, setQ] = useState('')
      var [sel, setSel] = useState([])
      var [box, setBox] = useState(null)
      var [imp, setImp] = useState(false)
      var gridRef = React.useRef(null)
      var suppressRef = React.useRef(false)
      var [mq, setMq] = useState(null)
      var selDownRef = React.useRef(false)

      function onGridDown(e) {
        if (e.button !== 0) return
        if (selDownRef.current) return
        selDownRef.current = true
        try { if (e.target && e.target.closest && e.target.closest('input,textarea,button,select,label,a,[data-sel-card]')) { selDownRef.current = false; return } } catch (e2) {}
        var sx = e.clientX, sy = e.clientY, moved = false
        function move(ev) {
          var dx = ev.clientX - sx, dy = ev.clientY - sy
          if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) moved = true
          if (moved) setMq({ x0: Math.min(sx, ev.clientX), y0: Math.min(sy, ev.clientY), x1: Math.max(sx, ev.clientX), y1: Math.max(sy, ev.clientY) })
        }
        function up(ev) {
          window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setMq(null); selDownRef.current = false
          if (moved && gridRef.current) {
            suppressRef.current = true
            var r = { x0: Math.min(sx, ev.clientX), y0: Math.min(sy, ev.clientY), x1: Math.max(sx, ev.clientX), y1: Math.max(sy, ev.clientY) }
            var hits = []
            Array.prototype.forEach.call(gridRef.current.children, function (el, i) {
              var b = el.getBoundingClientRect()
              var cx = b.left + b.width / 2, cy = b.top + b.height / 2
              if (cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1) { var it = items[i]; if (it) hits.push(it.id) }
            })
            if (hits.length) setSel(function (s) { return ev.shiftKey ? Array.from(new Set(s.concat(hits))) : hits })
            setTimeout(function () { suppressRef.current = false }, 80)
          }
        }
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
      }
      var [msg, setMsg] = useState('')

      function load(quiet) {
        // 回收站层必须带 includeTrash=1, 否则 queryAll 默认滤掉 trash(既有坑: 回收站一直显示空)
        var url = API_LIST + '?layer=' + encodeURIComponent(layer) + (layer === 'trash' ? '&includeTrash=1' : '') + (untagged ? '&untagged=1' : '') + '&q=' + encodeURIComponent(q) + (DD ? '&dataDir=' + encodeURIComponent(DD) : '')
        fetch(url).then(function (r) { return r.json() }).then(function (d) {
          if (d && Array.isArray(d.items)) {
            setItems(d.items)
            if (!quiet) setSel([])
          }
        }).catch(function (e) { if (!quiet) setMsg('加载失败:' + e.message) })
      }
      useEffect(function () { load(true) }, [layer, untagged, q])
      // 自动刷新: 后台机器人持续收藏/改动时, 页面每 6 秒同步一次(不打断勾选)
      useEffect(function () {
        var t = setInterval(function () { load(true) }, 6000)
        return function () { clearInterval(t) }
      }, [layer, untagged, q])

      function toggle(id) { setSel(function (s) { return s.includes(id) ? s.filter(function (x) { return x !== id }) : s.concat(id) }) }
      function batch(op, extra) {
        if (!sel.length) return
        fetch(API_BATCH, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ op: op, ids: sel, dataDir: DD || undefined }, extra || {})),
        }).then(function (r) { return r.json() }).then(function (d) {
          setMsg((d && d.total !== undefined ? '已处理 ' + d.ok + '/' + d.total : '完成') + ' ✓')
          load()
        }).catch(function (e) { setMsg('操作失败:' + e.message) })
      }

      var pills = [['', '全部'], ['candidate', '待整理'], ['library', '收藏'], ['trash', '回收站']]
      return h('div', { className: 'qqs-panel', onMouseDown: onGridDown, style: { maxWidth: 1080, width: '100%', userSelect: 'none' } },
        h('h2', null, '表情包图库'),
        h('div', { className: 'qqs-toolbar', style: {} },
          pills.map(function (p) {
            return h('button', { className: 'qqs-btn', key: p[0], style: { padding: '3px 10px', fontWeight: layer === p[0] ? 700 : 400 }, onClick: function () { setLayer(p[0]) } }, p[1])
          }),
          h('input', { className: 'qqs-inp', placeholder: '搜标签/描述…', value: q, style: { flex: 1, minWidth: 140 }, onChange: function (e) { setQ(e.target.value) } }),
          h('label', { style: { fontSize: 13, whiteSpace: 'nowrap' } }, h('input', { className: 'qqs-inp', type: 'checkbox', className: 'qqs-cb', checked: untagged, onChange: function (e) { setUntagged(e.target.checked) } }), ' 只看没打标的'),
          h('button', { className: 'qqs-btn', onClick: function () { setImp(true) } }, '导入'),
          h('button', { className: 'qqs-btn', onClick: load }, '刷新')),
        h('p', { style: { fontSize: 12, color: 'var(--qqs-text2,#888)' } }, '共 ' + items.length + ' 张。点图看大图并编辑标签/描述;勾选后底部批量操作。'),
        items.length === 0 ? h('p', { style: { color: 'var(--qqs-text2,#888)', padding: 20, textAlign: 'center' } }, '这里还没有图' + (untagged ? '(没有未打标的图了 🎉)' : '，点右上角「导入」或等群里发图自动收藏')) : null,
        h('div', { ref: gridRef, onMouseDown: onGridDown, style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(104px,1fr))', gap: 14, padding: 14, userSelect: 'none', cursor: 'crosshair', minHeight: 120 } },
          items.map(function (it) {
            var on = sel.includes(it.id)
            return h('div', { key: it.id, 'data-sel-card': true, className: 'qqs-card', style: { position: 'relative', border: '1px solid ' + (on ? '#2f9e44' : '#8883'), borderRadius: 8, overflow: 'hidden', cursor: 'pointer' }, onClick: function () { if (suppressRef.current) return; setBox(it) } },
              h('img', { src: API_IMG + encodeURIComponent(it.id) + (DD ? '&dataDir=' + encodeURIComponent(DD) : ''), style: { width: '100%', height: 104, objectFit: 'cover', display: 'block' } }),
              h('input', { className: 'qqs-inp', type: 'checkbox', className: 'qqs-cb', checked: on, style: { position: 'absolute', left: 4, top: 4 }, onClick: function (e) { e.stopPropagation(); toggle(it.id) } }),
              it.tags && it.tags.length ? h('span', { style: { position: 'absolute', left: 4, bottom: 2, fontSize: 10, color: '#fff', background: '#0009', borderRadius: 4, padding: '0 4px', maxWidth: '80%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } }, it.tags[0]) : null,
              it.layer === 'library' ? h('span', { style: { position: 'absolute', right: 4, bottom: 2, fontSize: 10, color: '#ffd43b' } }, '★') : null,
              it.layer === 'trash' ? h('span', { style: { position: 'absolute', right: 4, bottom: 2, fontSize: 10, color: '#ffa94d' } }, '回收站') : null)
          })),
        h('div', { style: { height: 120, cursor: 'crosshair', userSelect: 'none' } }),
        sel.length ? h('div', { style: { position: 'sticky', bottom: 8, marginTop: 10, background: 'rgba(255,255,255,.86)', border: '1px solid #00000030', borderRadius: 12, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', boxShadow: '0 6px 22px rgba(0,0,0,.18)', backdropFilter: 'blur(4px)' } },
          h('span', { style: { fontWeight: 800, color: 'var(--qqs-text,#171a21)' } }, '已选 ' + sel.length + ' 张'),
          layer !== 'trash' ? h('button', { onClick: function () { batch('promote') }, style: { font: 'inherit', cursor: 'pointer', padding: '4px 12px', borderRadius: 9, border: '1px solid #2f9e4499', background: 'rgba(47,158,68,.12)', color: '#1d7a31', fontWeight: 700, fontSize: 13 } }, '移入收藏 ★') : null,
          layer !== 'trash' ? h('button', { onClick: function () { batch('trash') }, style: { font: 'inherit', cursor: 'pointer', padding: '4px 12px', borderRadius: 9, border: '1px solid #e8590c99', background: 'rgba(232,89,12,.12)', color: '#c2450a', fontWeight: 700, fontSize: 13 } }, '送回收站') : null,
          layer === 'trash' ? h('button', { onClick: function () { batch('restore') }, style: { font: 'inherit', cursor: 'pointer', padding: '4px 12px', borderRadius: 9, border: '1px solid #2f9e4499', background: 'rgba(47,158,68,.12)', color: '#1d7a31', fontWeight: 700, fontSize: 13 } }, '恢复') : null,
          h('button', { onClick: function () { setSel([]) }, style: { font: 'inherit', cursor: 'pointer', padding: '4px 12px', borderRadius: 9, border: '1px solid #00000030', background: 'rgba(255,255,255,.7)', color: 'var(--qqs-text,#444)', fontWeight: 600, fontSize: 13 } }, '取消')) : null,
        mq ? h('div', { style: { position: 'fixed', left: mq.x0, top: mq.y0, width: Math.max(0, mq.x1 - mq.x0), height: Math.max(0, mq.y1 - mq.y0), border: '1px dashed #5b9dff', background: '#5b9dff22', pointerEvents: 'none', zIndex: 500 } }) : null,
        msg ? h('p', { style: { fontSize: 13, color: '#2f9e44' } }, msg) : null,
        box ? h(Lightbox, { item: box, storeDir: DD || undefined, onClose: function () { setBox(null); load() }, onChanged: load }) : null,
        imp ? h(ImportPanel, { storeDir: DD || undefined, onClose: function () { setImp(false); load() } }) : null)
    }

    // ── 定时任务页(管理 AI 在 QQ 会话里建的定时任务: 一次性/每天) ──
    var API_TIMERS = 'api/qqbot-settings/timers'
    function fmtWhen(job) {
      if (job.kind === 'daily') return '每天 ' + (job.atTime || '??:??')
      if (job.kind === 'once' && job.dueAt) {
        var d = new Date(job.dueAt)
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n }
        return '一次性 · ' + d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
      }
      return job.kind === 'once' ? '一次性' : '每天'
    }
    // ── 定时唤醒编辑(原设置页④区, 并入定时任务页): config.schedule.targets 分组 ──
    // 保存走 im-qqbot settings ns 全量 patch(与设置页同构, 防覆盖掉其它字段), live 热更新。
    // 聊天对象数据源(2026-09-05 统一): 群只列"活的"(host 已用官方 info 剔除注销群, 显示真群名);
    //   私聊用台账昵称, 缺名时用本地成员表(同 openid 在群里出现过的昵称)补 —— 不再露裸 id。
    function fetchChatTargets(acct) {
      var ns = acct && acct.ns && acct.ns !== 'im-qqbot' ? String(acct.ns) : ''
      var dd = acct && acct.dataDir ? String(acct.dataDir) : ''
      var qNs = ns ? '?ns=' + encodeURIComponent(ns) : ''
      var qDD = dd ? '?dataDir=' + encodeURIComponent(dd) : ''
      var qM = ns ? ('?ns=' + encodeURIComponent(ns)) : '' // members_local 不带 gid = 全部成员
      return Promise.all([
        fetch('api/qqbot-settings/group/accounts' + qNs).then(function (r) { return r.json() }).catch(function () { return {} }),
        fetch('api/qqbot-settings/known-chats' + qDD).then(function (r) { return r.json() }).catch(function () { return {} }),
        fetch('api/qqbot-settings/group/members_local' + qM).then(function (r) { return r.json() }).catch(function () { return {} }),
      ]).then(function (rs) {
        var groups = ((rs[0] && rs[0].groups) || []).map(function (g) {
          return { scope: 'group', id: g.gid, name: g.name || '', lastSeen: g.lastAt || 0, count: 0 }
        })
        var known = ((rs[1] && rs[1].chats) || [])
        // 成员表: mid -> 最近昵称(给私聊/无台账名时补名)
        var nameByMid = {}
        ;((rs[2] && rs[2].members) || []).forEach(function (m) {
          if (m.mid && m.name) {
            var old = nameByMid[m.mid]
            if (!old || m.lastSeen > old.ts) nameByMid[m.mid] = { name: m.name, ts: m.lastSeen || 0 }
          }
        })
        var c2c = []
        var seen = {}
        known.forEach(function (c) {
          if (c.scope !== 'c2c' || !c.id || seen[c.id]) return
          seen[c.id] = 1
          var nm = c.name || (nameByMid[c.id] && nameByMid[c.id].name) || ''
          c2c.push({ scope: 'c2c', id: c.id, name: nm, lastSeen: c.lastSeen || 0, count: c.count || 0 })
        })
        // 只列真·私聊过的人(known-chats scope=c2c): 群成员没有可私聊会话(dsh 一会话一对象),
        // 且群 member_openid 与 c2c openid 不同域, 补进来定时发私聊必失败 —— 不混入。
        c2c.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0) })
        return { group: groups, c2c: c2c }
      })
    }
    function WakeEditor(props) {
      // 多账号: 定时唤醒按当前账号 ns 读写; 表格=拍平行视图(行=对象×时刻), 存储仍是 targets 分组
      var _wkNs = props && props.acct && props.acct.ns && props.acct.ns !== 'im-qqbot' ? String(props.acct.ns) : ''
      var [cfg, setCfg] = useState(null)
      var [rev, setRev] = useState(undefined)
      var [knownChats, setKnownChats] = useState(null)
      var [msg, setMsg] = useState('')
      // 视图态: 筛选 tab + 对象搜索词(纯视图过滤)
      var [filter, setFilter] = useState('all') // all|group|c2c
      var [search, setSearch] = useState('')

      function load() {
        fetch(READ + (_wkNs ? '?ns=' + encodeURIComponent(_wkNs) : '')).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.value) { setCfg(d.value); setRev(d.revision); setMsg('') }
          else { setMsg('读取失败: ' + JSON.stringify(d)) }
        }).catch(function (e) { setMsg('读取异常: ' + e.message) })
      }
      useEffect(function () { load() }, [])
      useEffect(function () {
        fetchChatTargets(props.acct).then(function (t) {
          var list = (t.group || []).concat(t.c2c || [])
          setKnownChats(list)
        }).catch(function () {})
      }, [])
      function targets() { return (cfg && cfg.schedule && Array.isArray(cfg.schedule.targets)) ? cfg.schedule.targets : [] }
      function setTargets(list) {
        setCfg(function (c) {
          var base = c || {}
          var s = (base.schedule && typeof base.schedule === 'object') ? base.schedule : {}
          return { ...base, schedule: Object.assign({}, s, { targets: list }) }
        })
      }

      // ── 拍平行行模型: [{tgIndex, tg, task}] ──
      function rows() {
        var out = []
        targets().forEach(function (tg, ti) {
          ;(tg.tasks || []).forEach(function (tt) {
            out.push({ ti: ti, tg: tg, task: tt })
          })
        })
        return out
      }
      function chatLabelOf(scope, id) {
        var hit = null
        ;(knownChats || []).forEach(function (c) { if (c.scope === scope && c.id === id) hit = c })
        if (hit && hit.name) return hit.name
        return id ? (id.length > 14 ? id.slice(0, 6) + '…' + id.slice(-4) : id) : ''
      }
      // 行操作 → 直接改 targets 分组(保持存储模型)
      function patchTask(ti, taskId, patch) {
        var list = targets().slice()
        var tg = { ...list[ti], tasks: (list[ti].tasks || []).map(function (t) { return t.id === taskId ? { ...t, ...patch } : t }) }
        list[ti] = tg
        setTargets(list)
      }
      // 行内改对象: 若该行所在组还挂着其它行(旧数据同组多时刻), 先拆成独立组再改, 保证只影响本行
      function pickObject(r, c) {
        var list = targets().slice()
        var tg = list[r.ti]
        if (!tg) return
        var tasks = (tg.tasks || []).slice()
        var patch = { scope: c.scope, targetId: c.id, name: c.name || '' }
        if (tasks.length <= 1) {
          list[r.ti] = { ...tg, ...patch }
        } else {
          var keep = tasks.filter(function (t) { return t.id !== r.task.id })
          var lone = tasks.filter(function (t) { return t.id === r.task.id })
          var ntg = { ...tg, ...patch, id: 'tg-' + Date.now().toString(36), tasks: lone }
          list.splice(r.ti, 1, { ...tg, tasks: keep }, ntg)
          list = list.filter(function (g) { return (g.tasks || []).length > 0 })
        }
        setTargets(list)
      }
      function rmRow(ti, taskId) {
        var list = targets().slice()
        var tg = { ...list[ti], tasks: (list[ti].tasks || []).filter(function (t) { return t.id !== taskId }) }
        if (tg.tasks.length === 0) list = list.filter(function (_, i) { return i !== ti }) // 空目标组一并删
        else list[ti] = tg
        setTargets(list)
      }
      function addRow() {
        var list = targets().slice()
        // 每行 = 独立目标组(对象列改起来互不牵连); 默认挂"全部"视图, scope 跟随当前筛选类型
        var nt = { id: 't-' + Date.now().toString(36), time: '09:00', enabled: true, prompt: '' }
        var scope = filter === 'c2c' ? 'c2c' : filter === 'group' ? 'group' : 'group'
        var ntg = { id: 'tg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), name: '', scope: scope, targetId: '', tasks: [nt] }
        list.push(ntg)
        setTargets(list)
      }
      // 保存: 整表(行→分组已实时同步)全量 patch
      // 2026-10-22（主人定）：扫码拿到凭据后自动保存，用户不用再手动点「保存」
      function autoSaveAfterBind(list) {
        setMsg('💾 自动保存中…')
        setTimeout(function () {
          try {
            setBusy('')
            save(list, true)
          } catch (e) {
            setMsg('扫码成功但自动保存失败: ' + (e && e.message ? e.message : e) + ' —— 请手动点保存')
          }
        }, 150)
      }
      function save(listOverride) {
        setMsg('保存中…')
        var v = cfg || {}
        var patch = {
          behavior: v.behavior || {},
          sticker: {
            gates: (v.sticker && v.sticker.gates) || {},
            autoTagEnabled: !!(v.sticker && v.sticker.autoTagEnabled),
            visionCli: (v.sticker && typeof v.sticker.visionCli === 'string') ? v.sticker.visionCli : '',
          },
          injectRules: Array.isArray(v.injectRules) ? v.injectRules : [],
          imageHint: typeof v.imageHint === 'boolean' ? v.imageHint : undefined,
          messageReference: v.messageReference !== false,
              diagLog: v.diagLog === true,
          schedule: { targets: targets() },
          groupPrompt: typeof v.groupPrompt === 'string' ? v.groupPrompt : DEFAULT_GROUP_PROMPT,
        }
        fetch(UPDATE, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: patch, expectedRevision: rev, ns: _wkNs || undefined }),
        }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
          if (d && d.value) { setCfg(d.value); setRev(d.revision); setMsg('已保存 ✓(live 生效)') }
          else if (d && d.error) { setMsg('保存失败: ' + d.error) }
          else { setMsg('保存失败(未知响应)') }
        }).catch(function (e) { setMsg('保存异常: ' + e.message) })
      }
      if (!cfg) return h('p', null, msg || '加载中…')

      // 筛选行
      var allRows = rows()
      var shown = allRows.filter(function (r) {
        if (filter !== 'all' && r.tg.scope !== filter) return false
        if (search) {
          var q = search.toLowerCase()
          var nm = (chatLabelOf(r.tg.scope, r.tg.targetId) || '').toLowerCase()
          if (nm.indexOf(q) < 0 && String(r.task.prompt || '').toLowerCase().indexOf(q) < 0 && String(r.task.time).indexOf(q) < 0) return false
        }
        return true
      })

      // 渲染: 表格
      return h('div', null,
        h('p', { style: { fontSize: T.fsSm, color: T.warn, margin: '4px 0 6px' } }, '⚠️ QQ 平台: 主动发私聊需对方 48h 内跟机器人说过话, 超时会拒收(自动降级); 群一般没问题。想验证: 时间设成 1~2 分钟后保存等着看。'),
        // 工具条: 筛选 + 搜索 + 添加行
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' } },
          h(TabBar, {
            items: [
              { key: 'all', label: '全部(' + allRows.length + ')' },
              { key: 'group', label: '群' },
              { key: 'c2c', label: '私聊' },
            ], value: filter, onChange: function (k) { setFilter(k); setMsg('') },
          }),
          h('input', { className: 'qqs-inp', style: { flex: 1, minWidth: 120, padding: '3px 8px', border: '1px solid ' + T.border, borderRadius: T.radius }, placeholder: '搜对象 / 描述 / 时间…', value: search, onChange: function (e) { setSearch(e.target.value) } }),
          h(SButton, { variant: 'primary', size: 'sm', onClick: addRow }, '+ 添加一行')),
        // 表格头
        h('div', { style: { display: 'flex', alignItems: 'center', background: T.cardHi, border: '1px solid #dde1e7', borderRadius: T.radius + ' ' + T.radius + ' 0 0', fontWeight: 700, fontSize: T.fsSm, color: T.text2 } },
          h('div', { style: { width: 90, padding: '8px 10px' } }, '时间'),
          h('div', { style: { flex: '1 1 26%', minWidth: 140, padding: '8px 10px' } }, '对象'),
          h('div', { style: { flex: '2 1 38%', minWidth: 160, padding: '8px 10px' } }, '任务描述'),
          h('div', { style: { width: 80, padding: '8px 10px', textAlign: 'center' } }, '每天'),
          h('div', { style: { width: 56, padding: '8px 10px', textAlign: 'center' } }, '')),
        // 行
        shown.length === 0 ? h('div', { style: { border: '1px solid ' + T.border, borderTop: 'none', borderRadius: '0 0 ' + T.radius + ' ' + T.radius, padding: 22, textAlign: 'center', color: T.text3, fontSize: T.fsSm } }, '还没有任务行 —— 点「+ 添加一行」开始配置')
          : shown.map(function (r, idx) {
            var tg = r.tg, tt = r.task
            var nm = chatLabelOf(tg.scope, tg.targetId)
            return h('div', { key: tg.id + ':' + tt.id, style: { display: 'flex', alignItems: 'center', background: idx % 2 ? T.cardHi : '#ffffff', borderBottom: '1px solid #dde1e7', borderLeft: '1px solid #dde1e7', borderRight: '1px solid #dde1e7', fontSize: T.fsSm } },
              // 时间
              h('div', { style: { width: 90, padding: '6px 8px' } },
                h('input', { className: 'qqs-inp', style: { width: 62, padding: '2px 6px', border: '1px solid ' + T.border, borderRadius: T.radius }, value: sv(tt.time), placeholder: '09:00', onChange: function (e) { patchTask(r.ti, tt.id, { time: e.target.value }) } })),
              // 对象: 类型小标 + 可搜索选择器(点击弹出, 输入过滤; 每行独立, 互不牵连)
              h('div', { style: { flex: '1 1 26%', minWidth: 150, padding: '6px 8px', display: 'flex', gap: 4, alignItems: 'center' } },
                h('span', { style: { flexShrink: 0, fontSize: 10, padding: '0 5px', borderRadius: 4, color: '#fff', background: tg.scope === 'c2c' ? T.primary : T.primary2 } }, tg.scope === 'c2c' ? '私' : '群'),
                h(TargetPicker, { value: { scope: tg.scope, targetId: tg.targetId, name: nm }, options: knownChats || [], onPick: function (c) { pickObject(r, c) } })),
              // 描述
              h('div', { style: { flex: '2 1 38%', minWidth: 160, padding: '6px 8px' } },
                h('input', { className: 'qqs-inp', style: { width: '100%', padding: '2px 6px', border: '1px solid ' + T.border, borderRadius: T.radius, fontSize: T.fsSm }, value: sv(tt.prompt), placeholder: '例: 早上好, 提醒大家吃早饭(留空=自由发挥)', onChange: function (e) { patchTask(r.ti, tt.id, { prompt: e.target.value }) } })),
              // 每天 toggle = 启停
              h('div', { style: { width: 80, padding: '6px 8px', textAlign: 'center' } },
                h('input', { type: 'checkbox', checked: !!tt.enabled, onChange: function (e) { patchTask(r.ti, tt.id, { enabled: e.target.checked }) } })),
              // 删除
              h('div', { style: { width: 56, padding: '6px 8px', textAlign: 'center' } },
                h('button', { className: 'qqs-btn', style: { padding: '1px 8px', fontSize: 11, color: T.danger, background: 'transparent', border: 'none', cursor: 'pointer' }, onClick: function () { if (window.confirm('删除这一行?')) rmRow(r.ti, tt.id) } }, '✕')),
            )
          }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0 2px' } },
          h(SButton, { variant: 'primary', size: 'sm', onClick: save }, '保存定时唤醒'),
          h(SButton, { variant: 'ghost', size: 'sm', onClick: load }, '放弃修改'),
          msg ? h('span', { style: { fontSize: T.fsSm, color: T.success } }, msg) : null))
    }

    function TimersPage(props) {
      // 多账号: 定时任务按当前账号 schedDir(={cwd}/.qqbot)
      var _tmSD = props && props.acct && props.acct.schedDir ? String(props.acct.schedDir) : ''
      var _tmQ = _tmSD ? '?schedDir=' + encodeURIComponent(_tmSD) : ''
      var [jobs, setJobs] = useState(null)
      var [msg, setMsg] = useState('')
      var [busyId, setBusyId] = useState('')
      // 名称解析(2026-09-05): 群=活群真名(accounts 已剔除注销群), 私聊=台账昵称+成员表补名
      var [chatTg, setChatTg] = useState(null) // 活群/昵称台账: null=加载中(不判失效), 数组=已加载
      function load() {
        fetch(API_TIMERS + _tmQ).then(function (r) { return r.json() }).then(function (d) {
          if (d && Array.isArray(d.jobs)) setJobs(d.jobs.slice().reverse())
          else setMsg('读取失败: ' + JSON.stringify(d))
        }).catch(function (e) { setMsg('读取异常: ' + e.message) })
      }
      useEffect(function () {
        load()
        fetchChatTargets(props.acct).then(function (t) { setChatTg(t && t.group ? t : { group: [], c2c: [] }) }).catch(function () { setChatTg({ group: [], c2c: [] }) })
      }, [])
      function nameOf(scope, id) {
        if (!chatTg) return ''
        var nm = ''
        ;(chatTg[scope] || []).forEach(function (x) { if (x.id === id) nm = x.name || nm })
        return nm
      }
      function isGroupAlive(gid) {
        // 台账未加载(null)时不判失效——避免每次进页面先闪"群已失效"; 加载完成后按真实台账判定
        if (!chatTg) return true
        return (chatTg.group || []).some(function (g) { return g.id === gid })
      }
      function act(job, body, okMsg) {
        if (busyId) return
        setBusyId(job.id)
        fetch(API_TIMERS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ id: job.id, schedDir: _tmSD || undefined }, body || {})) })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.error) setMsg('失败: ' + d.error)
            else { setMsg(okMsg + ' ✓'); load() }
          })
          .catch(function (e) { setMsg('操作失败: ' + e.message) })
          .then(function () { setBusyId('') })
      }
      function who(job) {
        var scope = job.scope === 'c2c' ? 'c2c' : 'group'
        var nm = nameOf(scope, job.peerId)
        if (!nm) return (scope === 'c2c' ? '私聊' : '群聊') + ' · ' + String(job.peerId || '').slice(0, 8)
        return (scope === 'c2c' ? '私聊 · ' : '群聊 · ') + nm
      }
      function chip(kind) {
        return h('span', { style: { fontSize: 11, padding: '1px 8px', borderRadius: 999, color: '#fff', background: kind === 'daily' ? '#2f9e44' : '#4d7cfe', whiteSpace: 'nowrap' } },
          kind === 'daily' ? '每天' : '一次性')
      }
      // 左右分栏: 左=定时唤醒(编辑), 右=已安排的定时提醒(开关/删除)——有效利用横向空间
      var leftCol = h('div', { style: { flex: '1 1 44%', minWidth: 280, maxWidth: 560 } },
        h('div', { style: { ...card, padding: '10px 14px' } },
          h('div', { style: { fontWeight: 700, fontSize: 13 } }, '① 定时唤醒(每天到点,让她主动去群/私聊开口)'),
          h('p', { style: { fontSize: T.fsSm, color: T.text3 } }, '每个群/人一组,下面可加多个时刻。不用记号码——点「选聊天对象」挑见过的就行(群显示真名/人显示昵称)。改完点「保存」。'),
          h(WakeEditor, { acct: props.acct })))
      var rightCol = h('div', { style: { flex: '1 1 44%', minWidth: 280 } },
        h('div', { style: { ...card, padding: '10px 14px' } },
          h('div', { style: { fontWeight: 700, fontSize: 13 } }, '② 她答应你的定时提醒(在 QQ 里说一声就能建)'),
          h('p', { style: { fontSize: T.fsSm, color: T.text3 } }, '这些是她在 QQ 里应你要求安排的提醒。这里只管看/开关/删除;一次性到点自动消失。'),
          jobs === null ? h('p', { style: { fontSize: T.fsSm, color: T.text3 }, padding: 10 }, '加载中…') : null,
          jobs !== null && jobs.length === 0 ? h('p', { style: { color: 'var(--qqs-text2,#888)', padding: 14, textAlign: 'center', fontSize: T.fsSm } }, '还没有这类提醒。去 QQ 里让她安排一个,就会出现在这里。') : null,
          (jobs || []).map(function (j) {
            var disabled = busyId === j.id
            // 2026-10-22 修：台账（groups.json / known-chats）只是本地缓存，可能为空或滞后，
            //   查不到 openid ≠ 群不存在（实测：群正常、定时任务照发，却被标红“群已失效”）。
            //   故不再据此标失效；真要判定需调 QQ API 探测。
            var deadGroup = false
            return h('div', { key: j.id, style: { border: '1px solid ' + (deadGroup ? T.dangerSoft : (j.enabled ? T.border : '#ffa94d66')), borderRadius: T.radius, padding: '8px 10px', margin: '6px 0', background: 'var(--qqs-card,#fff)', opacity: j.enabled ? 1 : 0.72 } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                chip(j.kind),
                h('span', { style: { fontWeight: 600, fontSize: T.fsSm } }, fmtWhen(j)),
                h('span', { style: { fontSize: T.fsSm, color: deadGroup ? T.danger : T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 } }, deadGroup ? (who(j) + '(群已失效)') : who(j)),
                h('span', { style: { flex: 1 } }),
                h('label', { style: { fontSize: T.fsSm, whiteSpace: 'nowrap', color: j.enabled ? T.primary : '#ffa94d' } },
                  h('input', { className: 'qqs-cb', type: 'checkbox', checked: !!j.enabled, disabled: disabled, onChange: function (e) { act(j, { enabled: e.target.checked }, e.target.checked ? '已启用' : '已停用') } }),
                  ' ' + (j.enabled ? '启用中' : '已停用')),
                h('button', { className: 'qqs-btn', disabled: disabled, style: { padding: '2px 8px', fontSize: T.fsSm }, onClick: function () { if (window.confirm('删除这条定时任务?')) act(j, {}, '已删除') } }, '删除')),
              j.prompt ? h('div', { style: { fontSize: T.fsSm, color: '#cfd3dc', background: '#ffffff0a', border: '1px solid #ffffff14', borderRadius: T.radius, padding: '4px 8px', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, j.prompt) : null)
          }),
          msg ? h('p', { style: { fontSize: T.fsSm, color: T.success } }, msg) : null))
      return h('div', { style: { width: '100%', color: 'var(--qqs-text,#1f2329)' } },
        h('div', { style: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } }, leftCol, rightCol),
        props && props.close ? h('button', { className: 'qqs-btn', onClick: props.close, style: { float: 'right', marginTop: 6 } }, '完成') : null)
    }

    // ── 单入口壳: 设置 / 表情包图库 / 定时任务 三个胶囊 tab 页内切换 ──
    var TAB_KEY = 'qqs-home-tab'
    var ACCT_KEY = 'qqs-acct'
    function QqbotHome(props) {
      var [tab, setTab] = useState(null)
      var [accts, setAccts] = useState(null)
      var [acctId, setAcctId] = useState('')
      var [badges, setBadges] = useState({})
      // 当前操作账号(缺省=第一个启用的实例, 兼容单账号)
      function currentAcct() {
        var list = accts || []
        if (acctId) { var p = null; list.forEach(function (a) { if (a.id === acctId) p = a }); if (p) return p }
        var first = null
        list.forEach(function (a) { if (!first && !a.disabled) first = a })
        return first || list[0] || null
      }
      useEffect(function () {
        var saved = ''
        try { saved = localStorage.getItem(TAB_KEY) || '' } catch (e) {}
        setTab(saved === 'gallery' || saved === 'timers' || saved === 'accounts' ? saved : 'settings')
        fetch('api/qqbot-settings/accounts').then(function (r) { return r.json() }).then(function (d) {
          if (d && Array.isArray(d.instances)) {
            setAccts(d.instances)
            var want = ''
            try { want = localStorage.getItem(ACCT_KEY) || '' } catch (e) {}
            var found = null
            d.instances.forEach(function (a) { if (a.id === want) found = a.id })
            setAcctId(found || '')
          }
        }).catch(function () {})
      }, [])
      // 角标按当前账号
      useEffect(function () {
        var ac = currentAcct()
        var alive = true
        var ddq = ac && ac.dataDir ? '&dataDir=' + encodeURIComponent(ac.dataDir) : ''
        var sdq = ac && ac.schedDir ? '?schedDir=' + encodeURIComponent(ac.schedDir) : ''
        Promise.all([
          fetch('api/qqbot-settings/stickers?untagged=1&layer=candidate' + ddq).then(function (r) { return r.json() }).catch(function () { return {} }),
          fetch(API_TIMERS + sdq).then(function (r) { return r.json() }).catch(function () { return {} }),
        ]).then(function (rs) {
          if (!alive) return
          var unt = rs[0] && typeof rs[0].total === 'number' ? rs[0].total : 0
          var on = 0
          var list = (rs[1] && rs[1].jobs) || []
          list.forEach(function (j) { if (j.enabled) on += 1 })
          setBadges({ untagged: unt, timers: on })
        })
        return function () { alive = false }
      }, [accts, acctId])
      // ── 扩展 UI 页签（2026-10-26）：slot=settings 的扩展挂到顶部 tab 右边 ──
      //   数据来自 /api/qqbot-settings/ext-ui/list（profile 级目录，全 profile 一份）。
      var [extTabs, setExtTabs] = useState([])
      useEffect(function () {
        var alive = true
        fetch('api/qqbot-settings/ext-ui/list')
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!alive || !j || !j.ok) return
            var list = (j.items || []).filter(function (x) { return x.slot === 'settings' })
            setExtTabs(list)
          })
          .catch(function () { /* 扩展列表拉不到不影响设置页 */ })
        return function () { alive = false }
      }, [])
      if (!tab) return h('div', null, '…')
      function choose(t) { setTab(t); try { localStorage.setItem(TAB_KEY, t) } catch (e) {} }
      function chooseAcct(id) { setAcctId(id); try { localStorage.setItem(ACCT_KEY, id) } catch (e) {} }
      function badge(n) {
        return n > 0 ? h('span', { style: { background: '#ff6b6b', color: '#fff', borderRadius: 9, padding: '0 6px', fontSize: 11, lineHeight: '16px', display: 'inline-block', fontWeight: 700, flexShrink: 0 } }, n) : null
      }
      var ac = currentAcct()
      // 传给按账号视图的上下文: 设置按 ns, 图库按 dataDir, 定时按 schedDir
      // ★ 2026-10-27：补上 cwd / dataRoot —— 扩展卡片要能对"当前选中的账号"
      //   读写它自己那份配置（getConfig('data')），光有 dataDir（图库目录）不够。
      var acctx = ac ? {
        id: ac.id, ns: ac.ns, dataDir: ac.dataDir, schedDir: ac.schedDir,
        cwd: ac.cwd || '', dataRoot: ac.dataRoot || '', appId: ac.appId || '',
      } : null
      // key=账号: 切号即强制子页整页重挂(清掉旧账号 state, 全部重新拉取)
      var subKey = ac ? ac.id : 'main'
      var sub = tab === 'gallery' ? h(GalleryPage, { key: subKey, close: props && props.close, acct: acctx })
        : tab === 'timers' ? h(TimersPage, { key: subKey, close: props && props.close, acct: acctx })
        : tab === 'accounts' ? h(AccountsPage, { close: props && props.close })
        : String(tab).indexOf('ext:') === 0
          ? h(ExtCardPage, {
              key: String(tab).slice(4) + '|' + subKey,   // 切账号即重挂（同其他子页）
              extId: String(tab).slice(4),
              acct: acctx,                                // ★ 卡片据此可对当前账号读写
              title: (function () {
                var hit = null
                extTabs.forEach(function (x) { if (x.extId === String(tab).slice(4)) hit = x })
                return hit ? hit.title : String(tab).slice(4)
              })(),
            })
        : h(SettingsPage, { key: subKey, close: props && props.close, acct: acctx })
      var acctLine = (accts && accts.length > 1) || (accts && accts.length === 1)
      return h('div', { style: { width: '100%' } },
        // ── 一级: 账号选择条(身份带) ──
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '2px 0 10px', padding: '6px 10px', border: '1px solid #b197fc55', borderRadius: 12, background: 'linear-gradient(90deg,#b197fc22,#b197fc0a)', color: 'var(--qqs-text,#1f2329)' } },
          h('span', { style: { fontSize: 13, fontWeight: 800, color: 'var(--qqs-text,#171a21)', whiteSpace: 'nowrap' } }, '🤖 正在查看:'),
          accts && accts.length > 0
            ? h('select', { className: 'qqs-inp', style: { padding: '4px 8px', fontWeight: 700 }, value: ac ? ac.id : '', onChange: function (e) { chooseAcct(e.target.value) } },
              accts.map(function (a) {
                return h('option', { key: a.id, value: a.id }, a.id + (a.appId ? ' (AppID ' + a.appId + ')' : '') + (a.disabled ? ' [停用]' : ''))
              }))
            : h('span', { style: { fontSize: 13, color: 'var(--qqs-text2,#888)' } }, '无账号… 去「账号与预设」添加'),
          ac ? h('span', { style: { fontSize: 12, color: '#6d28d9', whiteSpace: 'nowrap' } }, ac.dataDir ? '数据目录: ' + ac.dataDir : '') : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 12, color: '#8a97ad' } }, '设置/图库/定时 都跟随上面选的机器人')),
        // ★ 2026-10-26 修「页签条不能横滑」：原来把 `position:sticky` 和 `overflow-x:auto`
        //   放在**同一个元素**上 —— sticky 会创建新的格式化上下文，导致滚动容器的
        //   scrollWidth 计算异常（看着溢出、实际判定为没溢出），于是滚不动。
        //   拆成两层：外层只管 sticky + 裁剪，内层只管横向滚动。
        //   ⚠️ 外层必须**自己受宽度约束**（width/maxWidth/minWidth:0）——
        //   否则它会被内容撑开，内层 width:100% 也跟着等于内容宽，永远不产生溢出。
        h('div', { style: { position: 'sticky', top: 0, zIndex: 30, background: 'transparent', overflow: 'hidden', marginBottom: 12, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } },
          h('div', { id: 'qqs-top-tabs', className: 'qqs-top-tabs',
            // ★ 2026-10-26：id 查不到（设置页可能在 Shadow DOM 里，document.getElementById 拿不到），
            //   改用 React ref 直接抓元素，并把「鼠标按住拖拽」绑上 —— 桌面端之前只能靠滚轮。
            ref: function (el) {
              if (!el) return
              try { window.__qqsTopTabs = el } catch (e) {}
              if (el.__qqsDragBound) return
              el.__qqsDragBound = true
              var down = false, startX = 0, startLeft = 0, moved = false
              el.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return
                // 点在按钮上时不要立刻开始拖（否则点选页签会失效）
                down = true; moved = false
                startX = e.pageX; startLeft = el.scrollLeft
              })
              el.addEventListener('mousemove', function (e) {
                if (!down) return
                var dx = e.pageX - startX
                if (Math.abs(dx) > 4) {
                  moved = true
                  el.style.cursor = 'grabbing'
                  el.scrollLeft = startLeft - dx
                  e.preventDefault()
                }
              })
              var endDrag = function () {
                if (!down) return
                down = false
                el.style.cursor = ''
              }
              el.addEventListener('mouseup', endDrag)
              el.addEventListener('mouseleave', endDrag)
              // 拖过之后拦截一次 click，避免"想滑动却误切页签"
              el.addEventListener('click', function (e) {
                if (moved) { moved = false; e.stopPropagation(); e.preventDefault() }
              }, true)
            },
            style: { display: 'flex', gap: 10, flexWrap: 'nowrap', alignItems: 'stretch', padding: '10px 4px 12px', overflowX: 'auto', overflowY: 'hidden', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', width: '100%', boxSizing: 'border-box', cursor: 'grab', userSelect: 'none' } },
          // 内置四页 + 扩展页签（2026-10-26）：扩展 tab 用青蓝色区分，放在最右边。
          // 容器从「四个 flex:1 平分」改成「按钮 flex:0 0 auto + 容器横向可滑」——
          // 否则扩展一多，按钮会被压成一条缝（这跟 .dk-tab 那套是同一个道理）。
          [['settings', '设置', '#ff5d5d'], ['gallery', '表情包图库', '#ffd97a'], ['timers', '定时任务', '#5b9dff'], ['accounts', '账号与预设', '#b197fc']]
            .concat(extTabs.map(function (x) { return ['ext:' + x.extId, x.title, '#38bdf8'] }))
            .map(function (t) {
            var on = tab === t[0]
            var n = t[0] === 'gallery' ? badges.untagged : t[0] === 'timers' ? badges.timers : 0
            var col = t[2]
            return h('button', { key: t[0], onClick: function () { choose(t[0]) },
              style: {
                flex: '0 0 auto', minWidth: 104, cursor: 'pointer', font: 'inherit',
                color: 'var(--qqs-text,#171a21)', fontSize: 14, textAlign: 'center',
                whiteSpace: 'nowrap', padding: '9px 14px', borderRadius: 14,
                border: '1px solid ' + (on ? col : col + 'a6'),
                background: 'linear-gradient(165deg,' + col + (on ? '66' : '40') + ',' + col + (on ? '1f' : '14') + ')',
                boxShadow: on
                  ? '0 0 18px ' + col + 'cc, inset 0 0 16px ' + col + '66'
                  : '0 0 10px ' + col + '73, inset 0 0 12px ' + col + '47',
                fontWeight: on ? 800 : 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                transition: 'all .15s', outline: 'none',
              } },
              t[1], badge(n))
          }))),
        sub)
    }

    // ── 账号与预设(第4 tab): 多机器人账号(appId/secret/预设/cwd) + agent 预设复制管理 ──
    var API_ACCOUNTS = 'api/qqbot-settings/accounts'
    var API_PRESETS = 'api/qqbot-settings/presets'
    var API_BIND = 'api/qqbot-settings/bind'
    var API_WORKSPACES = 'api/qqbot-settings/workspaces'
    // appSecret 掩码(借鉴 dsh-qqbot-panel): host 只回显掩码, 留空/掩码保存=保留原值
    var SECRET_MASK = '********'
    var PRESET_HINT = '想改人设：点预设卡片「打开文件夹」，编辑里面 agent.cordis.yml —— persona 插件 config.text 那段就是人设正文(改完保存并重启 dsh 生效)；preset.yml 的 name 是预设显示名。做新人格：选一个预设点「复制」，填「预设 id」(=文件夹名,字母/数字开头,可含 - _) 和「人设名」(中文随意)，保存后自动生成新预设文件夹。'
    function inputRow(label, node) {
      return h('label', { style: { display: 'block', margin: '5px 0', fontSize: 13 } }, label, node)
    }
    function AccountsPage(props) {
      var [insts, setInsts] = useState(null)
      var [presets, setPresets] = useState([])
      var [root, setRoot] = useState('')
      var [workspaces, setWorkspaces] = useState([])
      var [msg, setMsg] = useState('')
      var [busy, setBusy] = useState('')
      var [bind, setBind] = useState(null) // {id,url,status,error,iframeUrl}
      var [copy, setCopy] = useState(null) // 复制弹层: {sourceId}
      var [copyId, setCopyId] = useState('')
      var [copyName, setCopyName] = useState('')
      var [collapsed, setCollapsed] = useState({})
      var [addMenu, setAddMenu] = useState(false)
      var [editP, setEditP] = useState(null)
      var [editFiles, setEditFiles] = useState([])
      var [editFile, setEditFile] = useState('')
      var [editContent, setEditContent] = useState('')
      var [editMsg, setEditMsg] = useState('')
      var [editBusy, setEditBusy] = useState(false)
      var pollRef = React.useRef(null)
      function load(quiet) {
        Promise.all([
          fetch(API_ACCOUNTS).then(function (r) { return r.json() }).catch(function () { return {} }),
          fetch(API_PRESETS).then(function (r) { return r.json() }).catch(function () { return {} }),
          fetch(API_WORKSPACES).then(function (r) { return r.json() }).catch(function () { return {} }),
        ]).then(function (rs) {
          var a = rs[0] || {}
          if (Array.isArray(a.instances)) setInsts(a.instances)
          var p = rs[1] || {}
          if (Array.isArray(p.presets)) { setPresets(p.presets); if (p.root) setRoot(p.root) }
          var w = rs[2] || {}
          if (Array.isArray(w.workspaces)) setWorkspaces(w.workspaces)
          if (!quiet) setMsg('')
        })
      }
      useEffect(function () { load(true) }, [])
      // 自动填充: 账号没选 preset 时自动带上候选中的第一个(浏览器 select 默认显示 ≠ state 值,
      // 不真正写入 state 的话保存会丢 preset——主人实测: 不手动切换选择就保存不了)。
      // 与渲染处同规则算候选(host 没给 hasChannelTools 字段时视全部为候选, 不锁死)。
      // 候选数量不限: 有候选就把空缺账号填上第一个, 用户仍可手动改选。
      useEffect(function () {
        if (!Array.isArray(presets) || presets.length === 0) return
        if (!Array.isArray(insts) || insts.length === 0) return
        // QQ 工具由会话自动挂载(2026-09-06) → 预设不再需要带标, 全部可作候选
        var only = presets
        if (only.length === 0) return
        var changed = false
        var next = insts.map(function (x) {
          if (x.preset) return x
          changed = true
          return Object.assign({}, x, { preset: only[0].id })
        })
        if (changed) setInsts(next)
      }, [insts, presets])
      useEffect(function () { return function () { if (pollRef.current) clearInterval(pollRef.current) } }, [])
      function upd(i, patch) { setInsts(function (list) { var n = list.slice(); n[i] = Object.assign({}, n[i], patch); return n }) }
      function toggleCollapse(id) { setCollapsed(function (m) { var n = Object.assign({}, m); n[id] = !n[id]; return n }) }
      function addBlank() {
        var base = 'im-qqbot'
        var used = new Set((insts || []).map(function (x) { return x.id }))
        var n = 2
        while (used.has(base + '-' + n)) n += 1
        setInsts(function (list) { return (list || []).concat([{ id: base + '-' + n, appId: '', appSecret: '', preset: '', cwd: '', disabled: false, _new: true }]) })
      }
      function addBound(cred) {
        var base = 'im-qqbot'
        var used = new Set((insts || []).map(function (x) { return x.id }))
        var n = 2
        while (used.has(base + '-' + n)) n += 1
        var next = (insts || []).concat([{ id: base + '-' + n, appId: cred.appId, appSecret: cred.appSecret, preset: '', cwd: '', disabled: false, _bound: true }])
        setInsts(next)
        return next
      }
      function save(listOverride, force) {
        if (busy && force !== true) return
        setBusy('save'); setMsg('保存中…')
        // ⚠️ 2026-10-22 修(卡在「保存中」的根因)：保存按钮写的是 onClick: save，React 会把
        //   MouseEvent 当第一个参数传进来；如果直接当列表用，.filter 会抛 TypeError，
        //   busy 永远停在 save ⇒ 界面一直转圈。只接受数组，其余一律回落到当前 insts。
        if (!Array.isArray(listOverride)) listOverride = null
        var list = (listOverride || insts || []).filter(function (x) { return x.id && (x.appId || x.appSecret || x.hasSecret || !x._new || x._bound) })
        // 空账号(全空且没绑定)不保存; 全新手动号若两凭据都空则提示(hasSecret=已保存的账号不算空)
        var blanks = list.filter(function (x) { return !x.appSecret && !x.hasSecret && !x._bound })
        if (blanks.length && !window.confirm('有 ' + blanks.length + ' 个账号没填 appSecret(不填的会被保存为只有骨架的实例, 可能启动就弹扫码)。继续?')) { setBusy(''); return }
        // 保存兜底: preset 仍为空的账号自动填第一个候选(防 effect 未触发/用户未手动选导致保存丢 preset)
        var candNow = presets
        if (candNow.length > 0) {
          var autoId = candNow[0].id
          list = list.map(function (x) { return x.preset ? x : Object.assign({}, x, { preset: autoId }) })
        }
        fetch(API_ACCOUNTS + '/save', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instances: list.map(function (x) { return { id: x.id, appId: x.appId, appSecret: x.appSecret, preset: x.preset, cwd: x.cwd, disabled: !!x.disabled } }) }),
        }).then(function (r) { return r.json() }).then(function (d) {
          setBusy('')
          if (d && d.error) setMsg('保存失败: ' + d.error)
          else setMsg('已保存到 cordis.patch.yml ✓ —— 重启 dsh(web) 后生效')
          load(true)
        }).catch(function (e) { setBusy(''); setMsg('保存异常: ' + e.message) })
      }
      function removeInst(i) {
        var list = (insts || []).slice()
        var one = list[i]
        if (!window.confirm('删除账号实例 ' + one.id + '? (它的配置会从 cordis.patch.yml 移除)')) return
        list.splice(i, 1)
        setInsts(list)
      }
      // ── 扫码绑定 ──
      function startBind() {
        setBind({ id: '', url: '', status: 'start', error: '' })
        fetch(API_BIND + '/start', { method: 'POST' }).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.error) { setBind({ id: '', url: '', status: 'error', error: d.error }); return }
          var b = { id: d.id, url: d.url, status: 'wait', error: '', iframeUrl: d.url }
          setBind(b)
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = setInterval(function () {
            fetch(API_BIND + '/poll?id=' + encodeURIComponent(b.id)).then(function (r) { return r.json() }).then(function (p) {
              if (p.status === 'done') {
                clearInterval(pollRef.current); pollRef.current = null
                var nextList = addBound({ appId: p.appId, appSecret: p.appSecret })
                setTimeout(function () { autoSaveAfterBind(nextList) }, 200)
                setMsg('🎉 扫码成功, 正在自动保存…')
                setBind(null)
              } else if (p.status === 'error') {
                clearInterval(pollRef.current); pollRef.current = null
                setBind({ id: b.id, url: p.url || b.url, status: 'error', error: p.error || '绑定失败', iframeUrl: p.url || b.url })
              } else {
                setBind(function (old) { return old && old.id === b.id ? Object.assign({}, old, { url: p.url || old.url, iframeUrl: (p.url && p.url !== old.url) ? p.url : old.iframeUrl }) : old })
              }
            }).catch(function () {})
          }, 2500)
        }).catch(function (e) { setBind({ id: '', url: '', status: 'error', error: e.message }) })
      }
      function cancelBind() {
        if (bind && bind.id) { try { fetch(API_BIND + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: bind.id }) }) } catch (e) {} }
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setBind(null)
      }
      // ── 预设复制 ──
      function doCopy() {
        if (!copy) return
        setBusy('copy')
        var url = copy.fromStandard ? API_PRESETS + '/new' : API_PRESETS + '/copy'
        var payload = copy.fromStandard
          ? { id: copyId.trim(), name: copyName.trim() }
          : { sourceId: copy.sourceId, newId: copyId.trim(), newName: copyName.trim() }
        fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (r) { return r.json() }).then(function (d) {
          setBusy('')
          if (d && d.error) { setMsg('复制失败: ' + d.error); return }
          setMsg('✅ 新预设已生成: ' + d.newId + (copy.fromStandard ? ' (复制自标准模式)' : '') + '。稍等片刻即可在列表看到；要改人设点「人格」。')
          setCopy(null); setCopyId(''); setCopyName('')
          load(true)
          // dsh 0.1.7：预设写在 profile patch 里，由宿主 HMR 重载后才出现在列表中 → 稍后再拉一次
          setTimeout(function () { load(true) }, 1200)
        }).catch(function (e) { setBusy(''); setMsg('复制异常: ' + e.message) })
      }
      function openPreset(id) {
        fetch(API_PRESETS + '/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) })
          .then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) setMsg('已在本机打开文件夹'); else if (d && d.error) setMsg(d.error) })
          .catch(function (e) { setMsg('打开失败: ' + e.message) })
      }
      // ── 人格编辑器(2026-09-07): 展开/改写预设人格文件(仅带QQ工具标记的副本可写, host 端二次校验) ──
      function loadEditFile(id, name) {
        fetch(API_PRESETS + '/file?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name))
          .then(function (r) { return r.json() }).then(function (d) {
            if (d && typeof d.content === 'string') { setEditContent(d.content); setEditMsg('') }
            else { setEditContent(''); setEditMsg('读取失败: ' + ((d && d.error) || '未知')) }
          }).catch(function (e) { setEditMsg('读取异常: ' + e.message) })
      }
      function openPresetEditor(p) {
        setEditP(p); setEditFiles([]); setEditFile(''); setEditContent(''); setEditMsg('')
        fetch(API_PRESETS + '/files?id=' + encodeURIComponent(p.id))
          .then(function (r) { return r.json() }).then(function (d) {
            if (d && Array.isArray(d.files)) {
              setEditP(function (prev) { return prev ? Object.assign({}, prev, { writable: !!d.writable }) : prev })
              setEditFiles(d.files)
              var def = d.files[0] ? d.files[0].name : ''
              setEditFile(def)
              if (def) loadEditFile(p.id, def)
              else setEditMsg('该预设没有可编辑文本文件')
            } else setEditMsg('读取失败: ' + ((d && d.error) || '未知'))
          }).catch(function (e) { setEditMsg('读取异常: ' + e.message) })
      }
      function pickEditFile(name) {
        setEditFile(name); setEditContent(''); setEditMsg('')
        if (editP) loadEditFile(editP.id, name)
      }
      function saveEditFile() {
        if (!editP || editBusy) return
        setEditBusy(true); setEditMsg('')
        fetch(API_PRESETS + '/file', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: editP.id, name: editFile, content: editContent }),
        }).then(function (r) { return r.json() }).then(function (d) {
          setEditBusy(false)
          if (d && d.ok) setEditMsg('✅ 已保存 ' + d.name + ' —— 新会话生效')
          else setEditMsg('保存失败: ' + ((d && d.error) || '未知'))
        }).catch(function (e) { setEditBusy(false); setEditMsg('保存异常: ' + e.message) })
      }
      var st = { width: '100%', padding: '5px 8px', boxSizing: 'border-box' }
      return h('div', { style: { maxWidth: 860, background: 'var(--qqs-card,#fff)', border: '1px solid var(--qqs-border,#e2e5ea)', borderRadius: 12, padding: '14px 16px', color: 'var(--qqs-text,#1f2329)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
          h('h2', { style: { margin: 0 } }, '账号与预设'),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('button', { className: 'qqs-btn', title: '保存账号配置(保存后重启生效)', onClick: save, disabled: busy === 'save', style: { fontSize: 16, padding: '4px 12px', lineHeight: '20px' } }, '💾'),
            h('button', { className: 'qqs-btn', title: '重新读取(放弃未保存的修改)', onClick: function () { load() }, style: { fontSize: 16, padding: '4px 12px', lineHeight: '20px' } }, '🔄'))),
        h('p', { style: { fontSize: 12, color: 'var(--qqs-text2,#888)' } }, '一个 QQ 机器人 = 一个账号实例(AppID/AppSecret)。想同时开几个机器人就加几个实例，每个可以配不同的 agent 预设(人格)与工作目录(各人各数据,不串)。⚠️ appSecret 会明文存在本机 cordis.patch.yml(改前自动备份 .bak)，别把配置文件传上网。'),
        h('div', { style: sectionTitle }, '① 机器人账号(改完点保存, 重启生效)'),
        (insts === null ? h('p', null, '加载中…') : null),
        (insts || []).map(function (it, i) {
          // QQ 工具由机器人会话自动挂载(2026-09-06) → 预设全列可选, 不再限定"带QQ工具"标记
          var usable = presets.slice()
          var selInvalid = it.preset && !usable.some(function (p) { return p.id === it.preset })
          var opts = usable.map(function (p) { return { id: p.id, label: p.name + ' (' + p.id + ')' } })
          if (selInvalid) opts.unshift({ id: it.preset, label: '⚠️ ' + it.preset + '(预设不存在, 请重选)' })
          // 默认收起: 老账号折叠, 新建(_new/_bound)展开待填; 用户手动切换后以 collapsed 为准
          var folded = collapsed[it.id] !== undefined ? !!collapsed[it.id] : (!it._new && !it._bound)
          return h('div', { key: it.id, style: { border: '1px solid ' + (it.disabled ? '#ffa94d66' : '#00000026'), borderRadius: 10, padding: '8px 12px', margin: '8px 0', background: 'var(--qqs-card-hi,#fafafa)', color: 'var(--qqs-text,#1f2329)' } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { className: 'qqs-btn', title: folded ? '展开设置' : '收起设置', onClick: function () { toggleCollapse(it.id) }, style: { padding: '1px 7px', fontSize: 13, lineHeight: '16px', background: '#0000000d', borderColor: '#00000026' } }, folded ? '▸' : '▾'),
              h('span', { style: { fontWeight: 800, color: 'var(--qqs-text,#171a21)', cursor: 'pointer', userSelect: 'none' }, onClick: function () { toggleCollapse(it.id) } }, it._bound ? '📱 扫码绑定' : (it._new ? '🆕 新账号' : '🤖 账号')),
              h('input', { className: 'qqs-inp', style: Object.assign({ width: 170 }, st), value: it.id, disabled: !it._new && !it._bound, onChange: function (e) { upd(i, { id: e.target.value }) }, placeholder: '实例 id(如 im-qqbot-2)' }),
              h('label', { style: { fontSize: 13, whiteSpace: 'nowrap' } },
                h('input', { className: 'qqs-cb', type: 'checkbox', checked: !it.disabled, onChange: function (e) { upd(i, { disabled: !e.target.checked }) } }), ' 启用'),
              h('span', { title: it.disabled ? '已停用' : (it.online ? '在线(绿点)' : '离线/未知(灰点)'), style: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block', background: it.disabled ? '#adb5bd' : (it.online ? '#2f9e44' : '#ced4da'), boxShadow: it.online ? '0 0 0 3px rgba(47,158,68,.18)' : 'none', flex: '0 0 auto', marginLeft: 2 } }),
              h('button', { className: 'qqs-btn', onClick: function () { removeInst(i) }, style: { marginLeft: 'auto' } }, '删除')),
            (folded ? null : h('div', { style: { marginTop: 4 } },
              inputRow('AppID: ', h('input', { className: 'qqs-inp', style: Object.assign({ width: 220 }, st), value: it.appId || '', onChange: function (e) { upd(i, { appId: e.target.value }) }, placeholder: '如 1234567890' })),
            inputRow('AppSecret: ', h('input', { className: 'qqs-inp', type: 'password', style: Object.assign({ width: 320 }, st), value: (it.appSecret === SECRET_MASK || (!it.appSecret && it.hasSecret)) ? '' : (it.appSecret || ''), onChange: function (e) { upd(i, { appSecret: e.target.value }) }, placeholder: (it.hasSecret && !it._new) ? '已保存(留空/掩码=保留原值; 填新值=更换)' : '扫码绑定会自动填; 也可手动填(两个都要填全才不弹码)' })),
            inputRow('Agent 预设(人格): ', (function () { if (presets.length === 0 && !selInvalid) {
                return h('span', { className: 'qqs-inp', style: { display: 'inline-block', verticalAlign: 'middle', padding: '5px 10px', fontSize: 12, color: '#e8590c', background: 'var(--qqs-warn-bg,#fff5f0)', borderRadius: 6 } }, '⚠️ 还没有任何 Agent 预设——请在下方②新建/复制一个')
              } return h('select', { className: 'qqs-inp', style: { width: 320, padding: '4px 8px' }, value: it.preset || '', onChange: function (e) { upd(i, { preset: e.target.value }) } }, opts.map(function (o) { return h('option', { key: o.id, value: o.id, style: selInvalid && o.id === it.preset ? { color: '#e03131' } : null }, o.label) })) })()),
            inputRow('工作目录(各账号数据放这, 留空=默认): ', h('input', { className: 'qqs-inp', style: Object.assign({ width: '90%' }, st), value: it.cwd || '', onChange: function (e) { upd(i, { cwd: e.target.value }) }, placeholder: '如 D:\\bots\\二号机' })),
            (function () {
              var ws = (workspaces || []).filter(function (w) { return w.path && w.count > 0 })
              if (ws.length === 0) return null
              return h('div', { style: { margin: '2px 0 4px', fontSize: 12, color: 'var(--qqs-text,#555)' } },
                '📁 已有 dsh 会话的工作区(点选填入上方): ',
                ws.map(function (w) {
                  return h('button', { key: w.dir, className: 'qqs-btn', style: { fontSize: 11, padding: '1px 8px', margin: '2px 4px 2px 0' }, onClick: function () { upd(i, { cwd: w.path }) } },
                    (w.path.length > 46 ? w.path.slice(0, 43) + '…' : w.path) + ' (' + w.count + ')')
                }))
           })())))
        }),
        h('div', { style: { position: 'relative', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' } },
          h('button', { className: 'qqs-btn', onClick: function () { setAddMenu(!addMenu) }, style: { borderColor: '#b197fc99', color: 'var(--qqs-text,#171a21)', fontWeight: 700 } }, addMenu ? '✕ 关闭' : '➕ 添加账号'),
          h('span', { style: { fontSize: 12, color: 'var(--qqs-text2,#888)' } }, '点加号选: 扫码绑定 或 手动填凭据'),
          (addMenu
            ? h('div', { style: { position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 60, minWidth: 280, background: 'var(--qqs-card,#fff)', border: '1px solid var(--qqs-border,#d9c6ff)', borderRadius: 10, boxShadow: '0 10px 28px rgba(60,40,140,.18)', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 } },
                h('button', { className: 'qqs-btn', style: { display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '8px 10px', justifyContent: 'flex-start', background: 'var(--qqs-card-hi,#f3f0ff)', borderColor: 'var(--qqs-border,#d0bfff)' }, onClick: function () { setAddMenu(false); startBind() } },
                  h('span', { style: { fontSize: 20 } }, '📱'),
                  h('span', null,
                    h('b', { style: { color: 'var(--qqs-text,#171a21)' } }, '扫码绑定新机器人'),
                    h('div', { style: { fontSize: 11, color: 'var(--qqs-text2,#777)' } }, '推荐 — 手机 QQ 扫码自动填凭据'))),
                h('button', { className: 'qqs-btn', style: { display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '8px 10px', justifyContent: 'flex-start' }, onClick: function () { setAddMenu(false); addBlank() } },
                  h('span', { style: { fontSize: 20 } }, '✍️'),
                  h('span', null,
                    h('b', { style: { color: 'var(--qqs-text,#171a21)' } }, '手动新建账号'),
                    h('div', { style: { fontSize: 11, color: 'var(--qqs-text2,#777)' } }, '自己填写 AppID / AppSecret'))))
            : null)),
        h('div', { style: { ...sectionTitle, marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          '② Agent 预设(人格库)',
          h('button', { className: 'qqs-btn', style: { fontSize: 12, padding: '2px 10px', borderColor: '#2b8a3e99', color: 'var(--qqs-text,#171a21)' }, onClick: function () { setCopy({ fromStandard: true, sourceId: 'standard' }); setCopyId(''); setCopyName('') } }, '➕ 从标准模式新建(带QQ工具)')),
        h('p', { style: { fontSize: 12, color: 'var(--qqs-text2,#888)' } }, PRESET_HINT),
        h('p', { style: { fontSize: 12, color: 'var(--qqs-text,#364fc7)', background: 'var(--qqs-preset-bg,#edf2ff)', borderRadius: 6, padding: '6px 10px' } }, '💡 QQ 工具(send_media/发图等)现在由机器人会话自动挂载(2026-09-06 起), 不再依赖预设是否带标记——任意预设都能在 QQ 用; 「从标准模式新建」的副本仍会自带标记供识别。'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 10, margin: '8px 0' } },
          presets.map(function (p) {
            return h('div', { key: p.id, style: { border: '1px solid var(--qqs-preset-border,#c7dbff)', borderRadius: 10, padding: '10px 12px', background: 'var(--qqs-preset-bg,#eef4ff)' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { fontWeight: 800, color: 'var(--qqs-text,#171a21)' } }, p.name),
                h('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, color: '#fff', background: p.hasChannelTools ? '#2b8a3e' : '#5b9dff' } }, p.hasChannelTools ? 'QQ工具' : '会话自动挂载')),
              h('div', { style: { fontSize: 12, color: 'var(--qqs-text2,#666)', margin: '4px 0' } }, 'id=' + p.id),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('button', { className: 'qqs-btn', style: { padding: '2px 10px', fontSize: 12 }, onClick: function () { setCopy({ sourceId: p.id }); setCopyId(''); setCopyName('') } }, '复制'),
                h('button', { className: 'qqs-btn', style: { padding: '2px 10px', fontSize: 12, borderColor: '#1971c299' }, onClick: function () { openPresetEditor(p) } }, '✏️ 人格'),
                h('button', { className: 'qqs-btn', style: { padding: '2px 10px', fontSize: 12 }, onClick: function () { openPreset(p.id) } }, '📂 打开文件夹')))
          })),
        copy ? h('div', { style: { position: 'fixed', inset: 0, background: '#000c', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }, onClick: function () { if (!busy) setCopy(null) } },
          h('div', { className: 'qqs-modal', style: { background: '#22252e', color: '#e8e8e8', borderRadius: 12, padding: 14, maxWidth: 460, width: '92%' }, onClick: function (e) { e.stopPropagation() } },
            h('h3', { style: { marginTop: 0 } }, copy.fromStandard ? '从标准模式新建预设' : '复制预设: ' + copy.sourceId),
            inputRow('预设 id(=新文件夹名, 字母/数字开头, 可含 - _): ', h('input', { className: 'qqs-inp', style: { width: '100%', boxSizing: 'border-box' }, value: copyId, onChange: function (e) { setCopyId(e.target.value) }, placeholder: '如 my-girl-2' })),
            inputRow('人设名(显示用, 中文随意): ', h('input', { className: 'qqs-inp', style: { width: '100%', boxSizing: 'border-box' }, value: copyName, onChange: function (e) { setCopyName(e.target.value) }, placeholder: '如 我的二号人格' })),
            h('div', { style: { textAlign: 'right', marginTop: 10 } },
              h('button', { className: 'qqs-btn', onClick: function () { if (!busy) setCopy(null) }, style: { marginRight: 8 } }, '取消'),
              h('button', { className: 'qqs-btn', onClick: doCopy, disabled: busy === 'copy' }, '生成新预设')))) : null,
        editP ? h('div', { style: { position: 'fixed', inset: 0, background: '#000c', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }, onClick: function () { if (!editBusy) setEditP(null) } },
          h('div', { className: 'qqs-modal', style: { background: '#1f232b', color: '#e8e8e8', borderRadius: 12, padding: 14, maxWidth: 760, width: '94%', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }, onClick: function (e) { e.stopPropagation() } },
            h('h3', { style: { marginTop: 0 } }, '✏️ 人格编辑器 — ' + editP.name + ' (' + editP.id + ')'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '2px 0 6px', flexWrap: 'wrap' } },
              h('label', { style: { fontSize: 13 } }, '文件: '),
              h('select', { className: 'qqs-inp', style: { padding: '4px 8px', color: 'var(--qqs-text,#1f2329)', maxWidth: 360 }, value: editFile, onChange: function (e) { pickEditFile(e.target.value) } },
                editFiles.map(function (fl) { return h('option', { key: fl.name, value: fl.name }, fl.name + ' (' + Math.max(1, Math.ceil(fl.size / 1024)) + 'KB)') })),
              h('span', { style: { fontSize: 12, color: editP.writable === false ? '#ffa94d' : '#7fd8a8' } }, editP.writable === false ? '🔒 只读(内置预设, 请先复制一份再改)' : (editP.writable ? '✅ 可编辑(你的副本)' : '⏳ 读取权限中…'))),
            h('p', { style: { fontSize: 12, color: '#9fb0c9', margin: '2px 0 6px' } }, '提示: agent.cordis.yml 里 persona 插件 config.text 就是人设正文; 直接整文件编辑, 保存后新会话生效。'),
            h('textarea', { className: 'qqs-inp', style: { width: '100%', boxSizing: 'border-box', flex: 1, minHeight: 300, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12, lineHeight: 1.5, color: 'var(--qqs-text,#1f2329)', whiteSpace: 'pre', resize: 'vertical', background: '#fff' }, value: editContent, readOnly: editP.writable === false, spellCheck: false, onChange: function (e) { setEditContent(e.target.value) } }),
            (editMsg ? h('p', { style: { fontSize: 12, color: '#ffa94d', margin: '4px 0' } }, editMsg) : null),
            h('div', { style: { textAlign: 'right', marginTop: 8 } },
              h('button', { className: 'qqs-btn', onClick: function () { if (!editBusy) setEditP(null) }, style: { marginRight: 8 } }, '关闭'),
              (editP.writable === false ? null : h('button', { className: 'qqs-btn', onClick: saveEditFile, disabled: editBusy || editP.writable === undefined, style: { borderColor: '#2f9e4499', color: 'var(--qqs-text,#171a21)' } }, editBusy ? '保存中…' : '💾 保存')))))
        : null,
        bind ? h('div', { style: { position: 'fixed', inset: 0, background: '#000c', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          h('div', { className: 'qqs-modal', style: { background: '#22252e', color: '#e8e8e8', borderRadius: 12, padding: 14, maxWidth: 620, width: '94%' }, onClick: function (e) { e.stopPropagation() } },
            h('h3', { style: { marginTop: 0 } }, bind.status === 'error' ? '绑定失败' : '扫码绑定 QQ 机器人'),
            bind.status === 'error'
              ? h('p', { style: { color: '#ffa94d' } }, '失败: ' + (bind.error || '未知'))
              : h('div', null,
                h('p', { style: { fontSize: 13, color: '#cfd3dc' } }, '这个授权页只认「手机 QQ」打开(终端启动时是拿手机扫屏幕上的码 = 同一个链接)。请照做:'),
                h('ol', { style: { fontSize: 13, color: '#cfd3dc', margin: '4px 0 8px', paddingLeft: 20 } },
                  h('li', null, '点「复制链接」，把链接发到手机 QQ(如发给"文件传输助手")'),
                  h('li', null, '在手机 QQ 里点开链接，按页面提示完成机器人绑定(没有第二个机器人，就在页面里选/建一个)'),
                  h('li', null, '完成后本页自动收到并填好 AppID/AppSecret')),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', background: '#ffffff12', border: '1px solid #ffffff26', borderRadius: 8, padding: '6px 8px' } },
                  h('span', { style: { flex: 1, fontSize: 11, color: '#9fb0c9', wordBreak: 'break-all', maxHeight: 60, overflow: 'auto' } }, bind.url),
                  h('button', { className: 'qqs-btn', onClick: function () { try { navigator.clipboard.writeText(bind.url).then(function () { setBind(function (o) { return o ? Object.assign({}, o, { copied: true }) : o }) }).catch(function () {}) } catch (e) {} } }, bind.copied ? '已复制 ✓' : '复制链接')),
                h('p', { style: { fontSize: 11, color: '#8a97ad' } }, '提示: 二维码内容就是这个链接——手机 QQ 扫电脑屏的码 = 在手机 QQ 里点开它, 效果相同。等待中…(过期会自动刷新, 重新复制最新链接即可)')),
            h('div', { style: { textAlign: 'right', marginTop: 8 } },
              h('button', { className: 'qqs-btn', onClick: cancelBind }, '取消绑定')))) : null,
        msg ? h('p', { style: { fontSize: 13, color: '#1d7a31', fontWeight: 600 } }, msg) : null,
        props && props.close ? h('button', { className: 'qqs-btn', onClick: props.close, style: { float: 'right', marginTop: 6 } }, '完成') : null)
    }

var QQS_CSS = ".qqs-btn{font:inherit;color:var(--qqs-text,#1f2329);background:var(--qqs-card,#fff);border:1px solid var(--qqs-border,#d0d5dd);border-radius:9px;padding:5px 13px;cursor:pointer;transition:all .15s}.qqs-btn:hover{background:var(--qqs-card-hi,#fafafa);border-color:#7c6cf0;color:#7c6cf0}.qqs-btn:active{transform:translateY(1px)}.qqs-inp,.qqs-area{font:inherit;color:var(--qqs-text,#1f2329);background:var(--qqs-input,#fff);border:1px solid var(--qqs-border,#d0d5dd);border-radius:9px;padding:5px 10px;outline:none;transition:border-color .15s}.qqs-inp::placeholder,.qqs-area::placeholder{color:var(--qqs-text3,#9aa1ab)}.qqs-inp:focus,.qqs-area:focus{border-color:#7c6cf0;box-shadow:0 0 0 2px #7c6cf033}.qqs-cb{accent-color:#7c6cf0;width:15px;height:15px}.qqs-card{transition:box-shadow .15s,border-color .15s}.qqs-card:hover{box-shadow:0 2px 10px #0002}.qqs-panel{background:var(--qqs-panel,#fff);border:1px solid var(--qqs-border,#e2e5ea);border-radius:16px;padding:16px;box-shadow:0 10px 34px #0002;color:var(--qqs-text,#1f2329)}.qqs-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--qqs-toolbar,#f7f8fa);border:1px solid var(--qqs-border,#e2e5ea);border-radius:12px;padding:8px 10px;margin-bottom:10px}.qqs-modal{background:var(--qqs-panel,#fff);color:var(--qqs-text,#1f2329)}"
var QQS_THEME_CSS = [
  // ① 亮色 token（默认）
  'body{',
  '--qqs-card:#ffffff;--qqs-card-hi:#fafafa;--qqs-card-solid:#f4f5f8;',
  '--qqs-border:#e2e5ea;--qqs-border-light:#eef0f3;',
  '--qqs-text:#1f2329;--qqs-text2:#4e5560;--qqs-text3:#8a919c;',
  '--qqs-panel:#ffffff;--qqs-toolbar:#f7f8fa;--qqs-input:#ffffff;',
  '--qqs-dock-panel:#ffffff;--qqs-dock-body:#f5f6f8;--qqs-bubble-in:#ffffff;',
  '--qqs-primary-bg:#7c6cf01a;--qqs-primary-border:#7c6cf04d;--qqs-primary-fg:#6b5ae6;--qqs-warn-bg:#fff5f0;',
  '--qqs-preset-bg:#eef4ff;--qqs-preset-border:#c7dbff;',
  '}',
  // ② 暗色 token（宿主 ThemePresenter 在 scheme===dark 时给 body 加属性）
  'body[data-ds-dark-theme]{',
  '--qqs-card:#232834;--qqs-card-hi:#2b3140;--qqs-card-solid:#2a3040;',
  '--qqs-border:#3a4152;--qqs-border-light:#333a49;',
  '--qqs-text:#e8eaf0;--qqs-text2:#c3cad6;--qqs-text3:#a3abb9;',
  '--qqs-panel:#232834;--qqs-toolbar:#272d3a;--qqs-input:#2b3140;',
  '--qqs-dock-panel:#232834;--qqs-dock-body:#1e232e;--qqs-bubble-in:#2b3140;',
  '--qqs-primary-bg:#7c6cf033;--qqs-primary-border:#7c6cf080;--qqs-primary-fg:#ffffff;--qqs-warn-bg:#3a2a20;',
  '--qqs-preset-bg:#1e2b3f;--qqs-preset-border:#2f4463;',
  '}',
  // ③ 独立规则（★不能写进上面的 body{} 里，否则整块 CSS 解析失败）
  '.qqs-panel,.qqs-toolbar,.qqs-modal,.qqs-card{color:var(--qqs-text,#1f2329)}',
  'body[data-ds-dark-theme] .qqs-panel,body[data-ds-dark-theme] .qqs-toolbar,body[data-ds-dark-theme] .qqs-modal,body[data-ds-dark-theme] .qqs-card{color:var(--qqs-text,#e8eaf0)}',
].join('')
    function ensureCss() { try { if (!document.getElementById('qqs-css')) { var st = document.createElement('style'); st.id = 'qqs-css'; st.textContent = QQS_CSS + QQS_THEME_CSS; document.head.appendChild(st) } } catch (e) {} }

    // ── 审批双通道 · Web 浮层(右下角小卡片) ──
    // 轮询 host 待办池(与 QQ 按钮/文本码共用同一 pending), 有点击即 POST 结算。
    // 原生 DOM 手写(不依赖 composer slot, 不与宿主原生审批面板打架), 2s 轮询够轻。
    var AP_FLOAT_CSS = "#qqs-ap-float{position:fixed;right:18px;bottom:84px;z-index:9999;width:min(340px,92vw);background:#fff;border:1px solid #d9c6ff;border-radius:14px;box-shadow:0 10px 34px rgba(80,40,140,.22);padding:0;overflow:hidden;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}#qqs-ap-float .ap-h{display:flex;align-items:center;gap:8px;padding:10px 14px;background:linear-gradient(90deg,#7c6cf01f,#7c6cf008);font-size:13px;font-weight:700;color:#4a3a9f;border-bottom:1px solid #efe8ff}#qqs-ap-float .ap-b{padding:10px 14px;font-size:13px;color:#1f2329}#qqs-ap-float .ap-b .ap-t{font-weight:600;margin-bottom:4px;word-break:break-all}#qqs-ap-float .ap-b .ap-r{color:#666;font-size:12px;margin-bottom:6px;word-break:break-all;max-height:60px;overflow:auto}#qqs-ap-float .ap-a{display:flex;gap:8px;padding:0 14px 12px}#qqs-ap-float .ap-a button{font:inherit;font-size:13px;font-weight:700;padding:7px 0;border-radius:9px;cursor:pointer;border:1px solid transparent;transition:opacity .15s}#qqs-ap-float .ap-a button:disabled{opacity:.5;cursor:default}#qqs-ap-float .ap-ok,.qqs-ap-float .ap-ok{background:#e6f7ec;color:#187a3d;border-color:#b8e6c8!important;flex:1}#qqs-ap-float .ap-no{background:#fdeeee;color:#c23131;border-color:#f3c4c4!important;flex:1}#qqs-ap-float .qs-opt{background:#f1ecff;color:#4a3a9f;border-color:#d9c6ff!important;text-align:left;padding:7px 12px;margin:2px 0;border-radius:9px;width:100%}#qqs-ap-float .ap-c{position:absolute;top:6px;right:10px;font-size:16px;color:#999;cursor:pointer;line-height:1}#qqs-ap-float .ap-done{color:#888;font-size:12px;padding:4px 14px 10px}";
    function ensureFloatCss() { try { if (!document.getElementById('qqs-ap-float-css')) { var st = document.createElement('style'); st.id = 'qqs-ap-float-css'; st.textContent = AP_FLOAT_CSS; document.head.appendChild(st) } } catch (e) {} }
    function fmtDeadline(ts) {
      var left = Math.max(0, Math.ceil((ts - Date.now()) / 1000))
      return left > 60 ? Math.ceil(left / 60) + ' 分钟' : left + ' 秒'
    }
    function startApprovalFloat() {
      try { ensureFloatCss() } catch (e) { return }
      var lastKey = ''
      var busy = false
      var hidden = false
      var root = null
      var itemType = '' // 'ap' 审批 | 'qs' 提问

      function show(kind, titleHtml, bodyHtml, actionHtml) {
        if (!root) {
          root = document.createElement('div')
          root.id = 'qqs-ap-float'
          document.body.appendChild(root)
        }
        root.style.display = hidden ? 'none' : 'block'
        itemType = kind
        lastKey = kind + ':' + keyOf(kind)
        root.innerHTML =
          '<div class="ap-h"><span>' + titleHtml + '</span><span style="flex:1"></span><span class="ap-c" title="关闭">✕</span></div>'
          + bodyHtml + actionHtml
          + '<div class="ap-done" style="display:none">已处理 ✓</div>'
        root.querySelector('.ap-c').onclick = function () { root.style.display = 'none'; hidden = true }
      }
      function keyOf(kind) {
        if (kind === 'ap') return (curAp && (curAp.ns + ':' + curAp.code)) || ''
        return (curQs && (curQs.ns + ':' + curQs.key)) || ''
      }
      function doneMsg(m) {
        if (!root) return
        var a = root.querySelector('.ap-a'); if (a) a.style.display = 'none'
        var d = root.querySelector('.ap-done')
        if (d) { d.style.display = 'block'; d.textContent = m || '已处理 ✓' }
        setTimeout(function () { if (root) root.style.display = 'none' }, 1800)
      }

      // ── 审批卡片渲染 ──
      var curAp = null
      function renderAp(list) {
        if (itemType && itemType !== 'ap' && !list.length) return
        var ap = list[0]
        if (!ap) { if (itemType === 'ap') { if (root) root.style.display = 'none' }; curAp = null; return }
        curAp = ap
        var k = ap.ns + ':' + ap.code
        if (itemType === 'ap' && k === lastKey) return
        hidden = false
        show('ap', '⚠️ DSH 权限申请',
          '<div class="ap-b"><div class="ap-t">工具：' + esc(ap.toolName || '?')
          + '</div>' + (ap.reason ? '<div class="ap-r">' + esc(ap.reason) + '</div>' : '')
          + '<div style="font-size:11px;color:#999">' + esc(ap.ownerHint || '') + ' · ' + fmtDeadline(ap.deadlineAt) + ' 后自动拒绝 · 共 ' + list.length + ' 条</div></div>',
          '<div class="ap-a">'
          + '<button class="ap-ok" data-act="allow">✅ 允许</button>'
          + '<button class="ap-no" data-act="deny">❌ 拒绝</button>'
          + '</div>')
        bindApButtons(ap)
      }
      function bindApButtons(ap) {
        if (!root) return
        root.querySelectorAll('.ap-a button').forEach(function (btn) {
          btn.onclick = function () {
            if (busy) return
            busy = true
            var act = btn.getAttribute('data-act')
            btn.disabled = true
            fetch('api/qqbot-settings/approval/decide', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code: ap.code, act: act }),
            }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
              busy = false; lastKey = ''
              doneMsg((d && d.msg) || (act === 'allow' ? '已允许 ✓' : '已拒绝 ✓'))
            }).catch(function () { busy = false; btn.disabled = false })
          }
        })
      }

      // ── 提问卡片渲染(选项逐个列出, 点击即答) ──
      var curQs = null
      function renderQs(list) {
        if (itemType && itemType !== 'qs' && !list.length) return
        var q = list[0]
        if (!q) { if (itemType === 'qs') { if (root) root.style.display = 'none' }; curQs = null; return }
        curQs = q
        var k = q.ns + ':' + q.key
        if (itemType === 'qs' && k === lastKey) return
        hidden = false
        var optBtns = (q.options || []).map(function (o, i) {
          return '<button class="qs-opt" data-i="' + i + '">' + esc(String(o.label || '').slice(0, 40)) + '</button>'
        }).join('')
        show('qs', '❓ 远程提问',
          '<div class="ap-b">' + (q.header ? '<div class="ap-t">' + esc(q.header) + '</div>' : '')
          + '<div class="ap-t">' + esc(q.question || '') + '</div>'
          + (q.detail ? '<div class="ap-r">' + esc(q.detail) + '</div>' : '')
          + '<div style="font-size:11px;color:#999">' + fmtDeadline(q.deadlineAt) + ' 后失效 · 共 ' + list.length + ' 条</div></div>',
          '<div class="ap-a" style="flex-direction:column;align-items:stretch">' + optBtns + '</div>')
        bindQsButtons(q)
      }
      function bindQsButtons(q) {
        if (!root) return
        root.querySelectorAll('.qs-opt').forEach(function (btn) {
          btn.onclick = function () {
            if (busy) return
            busy = true
            var i = Number(btn.getAttribute('data-i'))
            btn.disabled = true
            fetch('api/qqbot-settings/questions/decide', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ key: q.key, optIdx: i }),
            }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
              busy = false; lastKey = ''
              doneMsg((d && d.msg) || '已选择 ✓')
            }).catch(function () { busy = false; btn.disabled = false })
          }
        })
      }

      function poll() {
        if (busy) return
        try {
          fetch('api/qqbot-settings/approval/pending').then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
            if (d && Array.isArray(d.pending)) renderAp(d.pending)
            else if (itemType === 'ap' && d && !d.ok) { if (root) root.style.display = 'none'; itemType = '' }
          }).catch(function () {})
          fetch('api/qqbot-settings/questions/pending').then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
            if (d && Array.isArray(d.pending)) renderQs(d.pending)
            else if (itemType === 'qs' && d && !d.ok) { if (root) root.style.display = 'none'; itemType = '' }
          }).catch(function () {})
        } catch (e) {}
      }
      poll()
      setInterval(poll, 2000)
    }

    // ══ 群管理悬浮球 dock(可拖拽; 点开=群管理悬浮台; 关闭收回成球) ══
    // 与审批浮层同款: 原生 DOM 手写挂 body, 全页面可用, 不与宿主 slots 打架。
    // 三类提示的分工(主人 2026-09-06 定):
    //   · 审批/提问 → 打断式弹出(#qqs-ap-float 保持)
    //   · 入群申请 → 悬浮球上安静红点(不弹窗)
    //   · 群管理(发消息/审批入群/禁言) → 悬浮球点开成操作台
    var DOCK_CSS = "#qqs-dock-wrap{position:fixed;right:18px;bottom:190px;z-index:9997;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}#qqs-dock-ball{width:52px;height:52px;border-radius:50%;background:linear-gradient(160deg,#7c6cf0,#5b4fd8);color:#fff;font-size:24px;line-height:52px;text-align:center;cursor:pointer;box-shadow:0 6px 20px rgba(90,70,220,.4);user-select:none;transition:transform .12s,box-shadow .12s;position:relative}#qqs-dock-ball:hover{transform:scale(1.06)}#qqs-dock-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:#ff4d4f;color:#fff;font-size:11px;font-weight:700;line-height:18px;padding:0 4px;box-sizing:border-box;text-align:center;display:none}#qqs-dock-ball.qqs-alert{background:linear-gradient(160deg,#ff8a3d,#ff4d4f)!important;box-shadow:0 6px 20px rgba(255,77,79,.5)!important;animation:qqsDockPulse 1.6s ease-in-out infinite}@keyframes qqsDockPulse{0%,100%{box-shadow:0 6px 20px rgba(255,77,79,.45)}50%{box-shadow:0 6px 28px rgba(255,77,79,.9)}}#qqs-dock-panel{position:fixed;right:18px;bottom:190px;z-index:9998;width:min(720px,94vw);max-height:68vh;display:none;flex-direction:column;background:#fff;border:1px solid #d9c6ff;border-radius:16px;box-shadow:0 12px 40px rgba(60,40,140,.25);overflow:hidden;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}#qqs-dock-panel .dk-h{display:flex;align-items:center;gap:8px;padding:10px 14px;background:linear-gradient(90deg,#7c6cf01f,#7c6cf008);font-size:14px;font-weight:700;color:#4a3a9f;border-bottom:1px solid #efe8ff}#qqs-dock-panel .dk-b{padding:10px 14px;overflow:auto;font-size:13px;color:#1f2329}#qqs-dock-panel .dk-tab{display:flex;gap:4px;border-bottom:1px solid #eee;margin-bottom:10px}#qqs-dock-panel .dk-tab button{font:inherit;font-size:13px;padding:6px 14px;border:none;background:none;cursor:pointer;color:#666;border-bottom:2px solid transparent}#qqs-dock-panel .dk-tab button.on{color:#4a3a9f;font-weight:700;border-bottom-color:#7c6cf0}#qqs-dock-panel select.qqs-sel,#qqs-dock-panel input.qqs-txt,#qqs-dock-panel textarea.qqs-txt{font:inherit;color:#1f2329;background:#fff;border:1px solid #d0d5dd;border-radius:8px;padding:5px 8px;outline:none}#qqs-dock-panel .dk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}#qqs-dock-panel .dk-btn{font:inherit;font-size:13px;padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid #d9c6ff;background:#f1ecff;color:#4a3a9f}#qqs-dock-panel .dk-btn.ok{background:#e6f7ec;color:#187a3d;border-color:#b8e6c8}#qqs-dock-panel .dk-btn.no{background:#fdeeee;color:#c23131;border-color:#f3c4c4}#qqs-dock-panel .dk-btn:disabled{opacity:.5;cursor:default}#qqs-dock-panel .dk-msg{color:#888;font-size:12px;padding:2px 0}#qqs-dock-panel .dk-list{max-height:34vh;overflow:auto;border:1px solid #f0ecff;border-radius:10px;padding:4px}#qqs-dock-panel .dk-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #f5f2ff;flex-wrap:wrap;font-size:13px}#qqs-dock-panel .dk-item:last-child{border-bottom:none}#qqs-dock-panel .dk-empty{color:#aaa;text-align:center;padding:18px 0;font-size:12px}"
    // ── 💬 聊天视图样式(dock 追加段, 2026-09-07): QQ 风格气泡, 群友左(bot)右 ──
    var DOCK_CSS2 = "#qqs-dock-panel .dk-chat-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 6px}#qqs-dock-panel .dk-chat-box{overflow-y:auto;overscroll-behavior:contain;background:#f5f6f8;border:1px solid #e6e8ec;border-radius:10px;padding:10px 12px;box-sizing:border-box;height:min(36vh,300px);min-height:140px;scroll-behavior:auto}#qqs-dock-panel .dk-chat-box::-webkit-scrollbar{width:6px}#qqs-dock-panel .dk-chat-box::-webkit-scrollbar-thumb{background:#d3d7dd;border-radius:3px}#qqs-dock-panel .dk-crow{display:flex;gap:8px;align-items:flex-start;margin:0 0 12px}#qqs-dock-panel .dk-crow.out{flex-direction:row-reverse}#qqs-dock-panel .dk-ava{width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#fff;overflow:hidden;user-select:none;background:linear-gradient(150deg,#8fb3e8,#5f8fd9)}#qqs-dock-panel .dk-crow.out .dk-ava{background:linear-gradient(150deg,#5ec7f2,#3b8fe0)}#qqs-dock-panel .dk-cmain{display:flex;flex-direction:column;max-width:calc(100% - 40px);min-width:0}#qqs-dock-panel .dk-crow.in .dk-cmain{align-items:flex-start}#qqs-dock-panel .dk-crow.out .dk-cmain{align-items:flex-end}#qqs-dock-panel .dk-cmeta{font-size:11px;color:#9aa0a8;margin:0 6px 2px;max-width:100%;display:flex;align-items:center;gap:5px;flex-wrap:wrap}#qqs-dock-panel .dk-crow.out .dk-cmeta{flex-direction:row-reverse}#qqs-dock-panel .dk-cbubble{padding:7px 11px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;box-shadow:0 1px 2px rgba(20,30,60,.06);max-width:100%}#qqs-dock-panel .dk-cbubble a.dk-link{color:#1a66d6;text-decoration:underline;word-break:break-all;cursor:pointer}#qqs-dock-panel .dk-crow.out .dk-cbubble a.dk-link{color:#eaf3ff}#qqs-dock-panel .dk-crow.in .dk-cbubble{background:#fff;border:1px solid #e3e6ea;color:#1f2329;border-radius:3px 10px 10px 10px}#qqs-dock-panel .dk-crow.out .dk-cbubble{background:linear-gradient(180deg,#69a6ff,#3d7df5);color:#fff;border-radius:10px 3px 10px 10px}#qqs-dock-panel .dk-img{display:block;max-width:min(230px,52vw);max-height:200px;border-radius:6px;margin:0 0 3px;object-fit:cover;cursor:zoom-in}#qqs-dock-panel .dk-audio{display:block;max-width:min(260px,60vw);width:100%;height:34px;margin:0 0 2px}#qqs-dock-panel .dk-file{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:6px 12px;border-radius:8px;background:#f0f6ff;border:1px solid #cfe0fa;color:#2b6bd8;font-size:13px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#qqs-dock-panel .dk-file:hover{background:#e2edff}#qqs-dock-panel .dk-video{display:block;max-width:min(260px,60vw);max-height:180px;border-radius:6px;margin:0 0 2px}#qqs-dock-panel .dk-ctag{display:inline-block;font-size:10px;color:#5b8ff0;background:#eaf2ff;border:1px solid #d4e3fd;border-radius:8px;padding:0 6px}#qqs-dock-panel .dk-chat-top{text-align:center;color:#b0b4bb;font-size:11px;padding:2px 0 6px;user-select:none}#qqs-dock-panel .dk-chat-bottom{text-align:center;color:#c3c7cd;font-size:11px;padding:6px 0 0}#qqs-dock-panel .dk-composer{margin-top:8px;border:1px solid #e3e6ea;border-radius:10px;background:#fff;overflow:visible}#qqs-dock-panel .dk-composer textarea{width:100%;box-sizing:border-box;border:none;outline:none;resize:none;font:inherit;font-size:13px;color:#1f2329;background:transparent;padding:8px 10px 4px;line-height:1.5;max-height:120px}#qqs-dock-panel .dk-cbar{display:flex;align-items:center;gap:4px;padding:4px 8px 6px;flex-wrap:wrap}#qqs-dock-panel .dk-cbar .dk-btn{padding:3px 10px;font-size:12px;border-radius:7px}#qqs-dock-panel .dk-cbar .dk-send{background:linear-gradient(180deg,#69a6ff,#3d7df5);color:#fff;border:none;border-radius:8px;padding:5px 18px;font-size:13px;font-weight:600;cursor:pointer}#qqs-dock-panel .dk-cbar .dk-send:disabled{opacity:.5;cursor:default}#qqs-lightbox{position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,18,.82);display:flex;align-items:center;justify-content:center;cursor:zoom-out}#qqs-lightbox img{max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 10px 60px rgba(0,0,0,.6)}#qqs-dock-panel .dk-composer{position:relative}#qqs-dock-panel .dk-at-pop{position:absolute;left:6px;bottom:calc(100% - 4px);z-index:30;min-width:200px;max-width:90%;max-height:190px;overflow-y:auto;background:#fff;border:1px solid #e0e4ea;border-radius:10px;box-shadow:0 8px 24px rgba(30,40,80,.16);padding:4px;display:none}#qqs-dock-panel .dk-at-item{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:7px;cursor:pointer;font-size:12px;color:#1f2329;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#qqs-dock-panel .dk-at-item.on,#qqs-dock-panel .dk-at-item:hover{background:#eef3ff;color:#2b5fd0}#qqs-dock-panel .dk-at-empty{color:#aaa;font-size:12px;padding:6px 9px}#qqs-lightbox .lb-x{position:fixed;right:16px;top:10px;color:#fff;font-size:30px;cursor:pointer;line-height:1;padding:6px}#qqs-dock-panel.dk-full{left:0!important;top:0!important;right:0!important;bottom:0!important;width:100vw!important;max-width:100vw!important;height:100vh!important;max-height:100vh!important;border-radius:0;z-index:2147482000;display:flex;flex-direction:column}#qqs-dock-panel.dk-full .dk-h,#qqs-dock-panel.dk-full .dk-detect{flex:none}#qqs-dock-panel.dk-full .dk-b{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;padding:8px 14px 6px}#qqs-dock-panel.dk-full .dk-chat-wrap{display:flex;flex-direction:column;flex:1;min-height:0}#qqs-dock-panel.dk-full .dk-chat-head{flex:none}#qqs-dock-panel.dk-full .dk-chat-box{flex:1;height:auto!important;min-height:0!important;max-height:none!important;overflow-y:auto;overscroll-behavior:contain}#qqs-dock-panel.dk-full .dk-composer{flex:none;margin-top:6px}#qqs-dock-panel .dk-tab{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;scrollbar-width:none}#qqs-dock-panel .dk-tab::-webkit-scrollbar{display:none}#qqs-dock-panel .dk-tab button{white-space:nowrap;flex:0 0 auto}@media (max-width:560px){#qqs-dock-panel:not(.dk-full){left:8px!important;right:8px!important;width:auto!important;max-width:calc(100vw - 16px)!important;bottom:96px!important}#qqs-dock-panel .dk-h{font-size:13px;padding:8px 10px;gap:6px}#qqs-dock-panel .dk-b{padding:8px 10px;font-size:13px}#qqs-dock-panel .dk-tab button{font-size:12px;padding:7px 10px}#qqs-dock-panel .dk-btn{font-size:12px;padding:6px 10px}#qqs-dock-panel .dk-row{gap:6px;margin:5px 0}#qqs-dock-panel select.qqs-sel,#qqs-dock-panel input.qqs-txt,#qqs-dock-panel textarea.qqs-txt{padding:7px 9px;font-size:16px}#qqs-dock-panel .dk-list{max-height:46vh}#qqs-dock-panel .dk-item{padding:8px 6px;gap:6px}}@media (max-width:560px){#qqs-dock-panel.dk-full{border-radius:0}#qqs-dock-panel.dk-full .dk-b{padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}#qqs-dock-panel.dk-full .dk-tab{position:relative;background:#fff;z-index:2}}@media (max-width:560px){#qqs-dock-ball{width:46px;height:46px;line-height:46px;font-size:21px}}#qqs-dock-panel .dk-chat-wrap{position:relative}#qqs-dock-panel .dk-jump-latest{display:none;position:absolute;right:12px;bottom:76px;z-index:6;align-items:center;gap:4px;padding:5px 13px;font-size:12px;font-weight:600;color:#fff;cursor:pointer;border:none;border-radius:15px;background:linear-gradient(180deg,#69a6ff,#3d7df5);box-shadow:0 3px 12px rgba(30,60,140,.32);transition:transform .12s,box-shadow .12s}#qqs-dock-panel .dk-jump-latest.on{display:inline-flex}#qqs-dock-panel .dk-jump-latest:hover{background:linear-gradient(180deg,#5c9bfa,#2f6fe6);box-shadow:0 4px 16px rgba(30,60,140,.4)}#qqs-dock-panel .dk-jump-latest:active{transform:scale(.95)}"
    function ensureDockCss2() { try { if (!document.getElementById('qqs-dock-css2')) { var st = document.createElement('style'); st.id = 'qqs-dock-css2'; st.textContent = DOCK_CSS2; document.head.appendChild(st) } } catch (e) {} };
    function ensureDockCss() { try { if (!document.getElementById('qqs-dock-css')) { var st = document.createElement('style'); st.id = 'qqs-dock-css'; st.textContent = DOCK_CSS; document.head.appendChild(st) } } catch (e) {} }
    function startQqDock(sessionsSvc) {
      try { ensureDockCss() } catch (e) { return }
      try { ensureDockCss2() } catch (e) {}
      // 幂等(2026-09-07): 宿主重启/client 重连若触发重复初始化, 先移除旧 dock 再建, 保证始终只有一个悬浮球
      var oldWrap = document.getElementById('qqs-dock-wrap')
      if (oldWrap) { try { oldWrap.remove() } catch (e) { if (oldWrap.parentNode) oldWrap.parentNode.removeChild(oldWrap) } }
      // 位置记忆(可拖拽)
      var pos = null; try { var raw = localStorage.getItem('qqs-dock-pos'); if (raw) pos = JSON.parse(raw) } catch (e) {}
      // 修复(全新实例必崩): 没有历史坐标(或值损坏被上面的 catch 吞掉)时 pos 仍是 null,
      // 而紧跟着的 `Number(pos.x)` 会抛 TypeError: Cannot read properties of null (reading 'x')。
      // startQqDock 由 apply() 裸调 → 异常冒泡 → cordis 把这条 client fiber 判 FAILED →
      // dsh 0.1.7 的客户端启动审计视为致命 → 整个 Web UI 退化成 "Failed to load plugins"。
      // 作者机器上不炸只因为 localStorage 里早就有 qqs-dock-pos(拖过球)。
      if (!pos || typeof pos !== 'object') pos = {}
      var wrap = document.createElement('div')
      wrap.id = 'qqs-dock-wrap'
      wrap.innerHTML = '<div id="qqs-dock-ball" title="QQ 群管理(拖拽移动, 点开面板)">🛡<span id="qqs-dock-badge">0</span></div>'
      document.body.appendChild(wrap)
      var ball = wrap.querySelector('#qqs-dock-ball')
      var badge = wrap.querySelector('#qqs-dock-badge')
      // ── 2026-10-28（主人定）：悬浮球**只在 QQ 会话里显示** ──
      //   判定沿用 session-lookup（state.detectedHit 的同一个接口），未命中就不显示。
      //   为什么还要轮询：会话切换（web 侧点开另一个会话）不会通知这里；
      //   只比 sessionId 字符串，变了才发请求，开销可忽略。
      var _dockSid = ''
      var _dockHit = null
      var _dockPending = 0
      function refreshDockVisibility() {
        // ★ v1.11.11（主人改口）：**不再跨会话常显** —— 群管理是强工作区相关的事，
        //   切到编码项目/笔记库就该整块不见；"有审批"只作为 QQ 会话内的强调（橙红+呼吸+数字，见 refreshBadge）。
        var sid = ''
        try { sid = curSessionId() } catch (eS) { sid = '' }
        // 同一会话、已知结论 → 直接套用（不发请求，也不闪）
        if (sid === _dockSid && _dockHit !== null) { wrap.style.display = _dockHit ? '' : 'none'; return }
        _dockSid = sid
        if (!sid) { _dockHit = false; wrap.style.display = 'none'; return }
        // 会话变了：先按"未命中"藏起来，拿到结论再显示（宁可晚一点，也别让它乱闪）
        _dockHit = null
        wrap.style.display = 'none'
        qqHitOf(sid, function (hit) {
          if (sid !== _dockSid) return   // 查询期间又切了会话：这次结论作废
          _dockHit = hit
          wrap.style.display = hit ? '' : 'none'
        })
      }
      try {
        refreshDockVisibility()
        // 事件驱动（2026-10-28，主人嫌 2s 轮询费性能）：不再 setInterval ——
        // apply() 里的 refreshQqUi 在「sessions.list 变化 / 窗口聚焦 / 页面重新可见」时调这里。
        window.__qqsRefreshDock = refreshDockVisibility
      } catch (eVis) { /* 显隐失败不影响球本身 */ }
      var panel = null
      var open = false
      // ⚠️ 2026-09-27 修复「拖到屏幕外后球永久消失」：拖拽时本来有 clamp(行1749)，
      //   但**读取上次位置时没有** —— 窗口变小/换显示器后，存的坐标会落在可视区外，
      //   球就再也点不到了（用户只能手动清 localStorage 才能找回）。这里读取时同样 clamp。
      var _bw = 60, _bh = 60
      var _x = Math.max(0, Math.min(Math.max(0, window.innerWidth - _bw), Number(pos.x) || 0))
      var _y = Math.max(0, Math.min(Math.max(0, window.innerHeight - _bh), Number(pos.y) || 0))
      wrap.style.left = _x + 'px'; wrap.style.top = _y + 'px'; wrap.style.right = 'auto'; wrap.style.bottom = 'auto'
      var dragState = null
      // ⚠️ 2026-10-01 修（安卓上拖不动悬浮球）：原用 mousedown/mousemove/mouseup ——
      //   那是【鼠标事件】，触摸屏按住不会触发 move（浏览器只在 tap 时合成 click），
      //   所以在 dsh-mobile-apk 这类安卓 WebView 里球完全拖不动。
      //   改用 Pointer Events：鼠标 / 触摸 / 触控笔一套通吃。
      var lastDragEndedAt = 0   // 拖完的短暂屏蔽窗，避免"松手顺手把面板也打开"
      try { ball.style.touchAction = 'none' } catch (eT) {}   // 别让浏览器把触摸当滚动手势
      ball.addEventListener('pointerdown', function (e) {
        dragState = { sx: e.clientX, sy: e.clientY, ox: wrap.offsetLeft, oy: wrap.offsetTop, moved: false, pid: e.pointerId }
        try { ball.setPointerCapture(e.pointerId) } catch (eC) {}   // 手指移出球体也不丢事件
        e.preventDefault()
      })
      document.addEventListener('pointermove', function (e) {
        if (!dragState) return
        var dx = e.clientX - dragState.sx, dy = e.clientY - dragState.sy
        if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true
        if (!dragState.moved) return
        wrap.style.left = Math.max(0, Math.min(window.innerWidth - 60, dragState.ox + dx)) + 'px'
        wrap.style.top = Math.max(0, Math.min(window.innerHeight - 60, dragState.oy + dy)) + 'px'
        wrap.style.right = 'auto'; wrap.style.bottom = 'auto'
        syncPanelPos()
        e.preventDefault()
      })
      function endBallDrag() {
        if (!dragState) return
        var moved = dragState.moved
        var pid = dragState.pid
        dragState = null
        try { if (pid != null) ball.releasePointerCapture(pid) } catch (eR) {}
        if (moved) {
          lastDragEndedAt = Date.now()
          try { localStorage.setItem('qqs-dock-pos', JSON.stringify({ x: wrap.offsetLeft, y: wrap.offsetTop })) } catch (eS) {}
        }
      }
      document.addEventListener('pointerup', endBallDrag)
      document.addEventListener('pointercancel', endBallDrag)   // 触摸被系统打断也要收尾
      function syncPanelPos() {
        if (!panel || !open) return
        layoutPanel()
      }
      // ── 面板自适应定位: 按悬浮球屏幕位置翻转展开方向, 边缘 clamp 保证完整可见 ──
      var lastBallRect = null
      var manualPanelPos = null // 手动拖过面板后固定位置(不再自动贴球)
      function layoutPanel() {
        if (!panel || !open) return
        var vw = window.innerWidth, vh = window.innerHeight
        var pad = 10
        // 手动拖拽固定位置: 保持并 clamp
        if (manualPanelPos) {
          var pw2 = panel.offsetWidth || Math.min(720, vw * 0.94)
          var ph2 = panel.offsetHeight || Math.round(vh * 0.68)
          panel.style.left = Math.max(pad, Math.min(manualPanelPos.x, vw - pw2 - pad)) + 'px'
          panel.style.top = Math.max(pad, Math.min(manualPanelPos.y, vh - ph2 - pad)) + 'px'
          panel.style.right = 'auto'
          panel.style.bottom = 'auto'
          panel.style.maxHeight = Math.round(vh - pad * 2) + 'px'
          return
        }
        if (!lastBallRect) { lastBallRect = { left: vw - 70, top: vh - 80, right: vw - 18, bottom: vh - 28, width: 52, height: 52 } }
        var pw = panel.offsetWidth || Math.min(720, vw * 0.94)
        var ph = Math.min(panel.offsetHeight || Math.round(vh * 0.68), vh - pad * 2)
        // 水平: 右侧放不下 → 向左展开; 左侧放不下 → 向右展开; 再整体 clamp
        var left
        if (lastBallRect.right + pad + pw <= vw - pad) left = lastBallRect.right + pad
        else if (lastBallRect.left - pad - pw >= pad) left = lastBallRect.left - pad - pw
        else left = (lastBallRect.left + lastBallRect.width / 2) > vw / 2 ? vw - pw - pad : pad
        left = Math.max(pad, Math.min(left, vw - pw - pad))
        // 垂直: 下方放不下 → 向上展开
        var top
        if (lastBallRect.bottom + pad + ph <= vh - pad) top = lastBallRect.bottom + pad
        else if (lastBallRect.top - pad - ph >= pad) top = lastBallRect.top - pad - ph
        else top = vh - ph - pad
        top = Math.max(pad, Math.min(top, vh - ph - pad))
        panel.style.left = Math.round(left) + 'px'
        panel.style.top = Math.round(top) + 'px'
        panel.style.right = 'auto'
        panel.style.bottom = 'auto'
        // 面板超高时内部滚动, 头/关闭按钮始终可见
        panel.style.maxHeight = Math.round(vh - pad * 2) + 'px'
      }
      // 展开态拖拽: 按住面板头部(.dk-h 非控件区)移动整个 dock 面板
      function bindPanelDrag() {
        if (!panel || !open) return
        var h = panel.querySelector('.dk-h')
        if (!h) return
        // ⚠️ 2026-10-01 修：改 Pointer Events —— 触摸屏（安卓 WebView）也能拖动面板
        try { h.style.touchAction = 'none' } catch (eT) {}
        h.onpointerdown = function (e) {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          var t = e.target
          if (t && t.closest && t.closest('button,select,input,textarea,a,.qqs-sel,.qqs-txt')) return
          e.preventDefault()
          var sx = e.clientX, sy = e.clientY
          var ox = panel.offsetLeft, oy = panel.offsetTop
          var moved = false
          var mm = function (ev) {
            var dx = ev.clientX - sx, dy = ev.clientY - sy
            if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
            panel.style.left = (ox + dx) + 'px'
            panel.style.top = (oy + dy) + 'px'
            panel.style.right = 'auto'
            panel.style.bottom = 'auto'
          }
          var mu = function () {
            document.removeEventListener('pointermove', mm)
            document.removeEventListener('pointerup', mu)
            document.removeEventListener('pointercancel', mu)
            if (moved) manualPanelPos = { x: panel.offsetLeft, y: panel.offsetTop }
          }
          document.addEventListener('pointermove', mm)
          document.addEventListener('pointerup', mu)
          document.addEventListener('pointercancel', mu)
        }
        // 双击头部 → 取消手动固定, 恢复自动贴球定位
        h.ondblclick = function (e) {
          var t = e.target
          if (t && t.closest && t.closest('button,select,input,textarea,a')) return
          manualPanelPos = null
          layoutPanel()
        }
      }
      function closePanel() {
        open = false
        if (panel) { panel.style.display = 'none'; panel.innerHTML = '' }
        ball.style.display = 'block'
      }
      function togglePanel() {
        // 刚拖拽过 → 这次 click 只是"松手"，不要顺手把面板打开
        if (Date.now() - (typeof lastDragEndedAt === 'number' ? lastDragEndedAt : 0) < 350) return
        if (dragState && dragState.moved) return
        if (open) { closePanel(); return }
        if (!panel) {
          panel = document.createElement('div')
          panel.id = 'qqs-dock-panel'
          document.body.appendChild(panel)
        }
        open = true
        // 2026-10-04 五次修复（主人实测："刷新后打开 dock 还是从 9/21 开始"）：
        //   关闭面板时 DOM 会清空（closePanel 里 innerHTML=''），但 **JS 里的 state.chatItems 还留着** ——
        //   重开时 paintBody 见 chatItems 非空就**不重新加载**（L3965 的条件），直接复用那批旧数据
        //   （含"上次翻到哪"，于是又停在最旧处）。
        //   这里每次打开都**丢弃聊天缓存**，强制走 loadChat(true) 拉最新一页 ⇒ 配合贴底逻辑，
        //   打开即停在最新（= 主人说的老行为）。
        try {
          state.chatItems = []
          state.chatOldest = 0
          state.chatNewest = 0
          state.chatErr = ''
        } catch (e) { /* ignore */ }
        // 先量球位置(隐藏前), 再隐藏球
        var wr = wrap.getBoundingClientRect()
        lastBallRect = { left: wr.left, top: wr.top, right: wr.right, bottom: wr.bottom, width: wr.width, height: wr.height }
        ball.style.display = 'none'
        panel.style.display = 'flex'
        panel.style.left = 'auto'; panel.style.top = 'auto'; panel.style.right = 'auto'; panel.style.bottom = 'auto'
        renderPanel()
        // 等一帧内容渲染完再定位(offsetWidth/offsetHeight 才准确)
        setTimeout(layoutPanel, 0)
      }
      ball.addEventListener('click', togglePanel)
      // Esc 或点击面板外 → 收回成球
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) closePanel() })
      document.addEventListener('mousedown', function (e) {
        if (!open) return
        // 灯箱(#qqs-lightbox)是浮在 dock 外的全屏层: 点它(关闭放大)不能把 dock 也收走
        if (e.target && e.target.closest && e.target.closest('#qqs-lightbox')) return
        if (panel && (panel.contains(e.target) || panel === e.target)) return
        if (wrap && (wrap.contains(e.target) || wrap === e.target)) return
        closePanel()
      })
      function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
      function api(path, q) {
        var url = 'api/qqbot-settings/' + path + (q ? '?' + q : '')
        return fetch(url).then(function (r) { return r.json().catch(function () { return null }) }).catch(function () { return null })
      }
      function apiPost(path, body) {
        return fetch('api/qqbot-settings/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
          .then(function (r) { return r.json().catch(function () { return null }) }).catch(function () { return null })
      }
      // ── 红点: 入群申请待审汇总(各实例 pending 数之和, 不弹窗) ──
      function refreshBadge() {
        api('group/join-summary').then(function (d) {
          if (!d || !d.ok || !Array.isArray(d.items)) return
          var n = 0
          d.items.forEach(function (it) { n += (it.pending || 0) })
          if (n > 0) { badge.style.display = 'block'; badge.textContent = n > 99 ? '99+' : String(n) }
          else badge.style.display = 'none'
          _dockPending = n
          try { if (n > 0) ball.classList.add('qqs-alert'); else ball.classList.remove('qqs-alert') } catch (eA) {}
          try { if (window.__qqsRefreshDock) window.__qqsRefreshDock() } catch (eB) {}
          if (panel && open) { var b = panel.querySelector('.dk-join-badge'); if (b) b.style.display = n > 0 ? 'inline-block' : 'none'; if (b) b.textContent = n > 99 ? '99+' : String(n) }
        })
      }
      refreshBadge()
      setInterval(refreshBadge, 10000)

      // ── 面板状态(每个实例独立保存, 切回不丢) ──
      var state = { ns: '', accts: [], gid: '', groups: [], tab: 'chat', sendScope: 'group', sendTo: '', sendName: '', sendText: '', insertCtx: true, targetQ: '', c2cs: [], joins: null, mutes: null, members: null, muteSecs: '60', bindGid: '', bindName: '', msg: '', busy: '', wantPeer: null, lookedUp: false, detected: null, detectedHit: null, chatItems: [], chatMore: false, chatBusy: '', chatErr: '', chatOldest: 0, chatText: '', chatIns: true, outMode: '', outRev: undefined, bpEvents: [], bpSel: null, bpDraft: null, bpExt: null, bpExtBusy: '', bpReq: '', bpReqHint: '', bpSrcText: null, bpSrcPath: '', rosterSel: {}, rosterScope: 'all', rosterQ: '', hubSid: '', hubRev: undefined, hubBusy: '', hubMsg: '', gaEnabled: false, gaPoll: false, gaPollWake: true, gaHubNotify: true, gaNotifyGroup: true, gaInterval: 5, gaMinCount: 1, gaMsg: '', gaBusy: '', bcDraft: null, bcTasks: null, cardMd: '', cardBtns: '', cardGid: '', cardBusy: '', cardQ: '', tgGroups: [], tgCur: '', hammerSub: 'mute', arOn: false, arMode: 'keep', arKws: '', arKinds: [], arMute: 0, arDry: false, arMsg: '', qunLogged: null, qunUin: '', qunGroups: [], qunGc: '', qunKw: '', qunMembers: [], qunCount: 0, qunQr: false, qunMsg: '', qunBusy: false, qunLoading: false }
      // ★ 2026-10-27：把 state 暴露到 window —— 模块级的 mountDockCard 拿不到这个闭包变量，
      //   扩展卡片要读当前 ns / gid 只能从这里取。
      try { window.__qqsDockState = state } catch (e) { /* ignore */ }
      // 🗂 自定义目标分组(仿 QQ 分组): 2026-09-12 起**host 持久化**({dataRoot}/.qqbot/target-groups.json),
      // localStorage 只当秒开缓存 —— 这样 **AI 与主人共用同一份分组**(agent 侧 broadcast_send 可直接写分组名群发),
      // 顺带修掉"换个浏览器分组就没了"的老毛病。
      // 结构: [{ id, name, members: ['group:xxx' | 'c2c:yyy', ...] }]
      try {
        var _tg = localStorage.getItem('qqs-target-groups')
        if (_tg) { var _tgo = JSON.parse(_tg); if (Array.isArray(_tgo)) state.tgGroups = _tgo }
      } catch (e) {}
      function saveTgGroups() {
        try { localStorage.setItem('qqs-target-groups', JSON.stringify(state.tgGroups || [])) } catch (e) {}
        // 同步 host(与 AI 共用); 失败不影响本地缓存与当前操作
        try {
          fetch(api('group/target-groups'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: state.ns || undefined, groups: state.tgGroups || [] }),
          }).catch(function () {})
        } catch (e) {}
      }
      function loadTgGroupsFromHost() {
        fetch(api('group/target-groups' + (state.ns ? '?ns=' + encodeURIComponent(state.ns) : '')), { cache: 'no-store' })
          .then(function (r) { return r.json() }).then(function (d) {
            if (!d || !d.ok) return
            var host = Array.isArray(d.groups) ? d.groups : []
            var local = Array.isArray(state.tgGroups) ? state.tgGroups : []
            if (host.length === 0) {
              if (local.length > 0) saveTgGroups() // 迁移: 本地有、host 还空 → 推上去(第一次打开新版时发生一次)
            } else if (local.length === 0) {
              state.tgGroups = host
              try { localStorage.setItem('qqs-target-groups', JSON.stringify(host)) } catch (e) {}
            } else {
              // 两边都非空 → **按 id 合并并集**: host 打底(以它为准), 本地**独有的组保留**, 同 id 取成员多的一份。
              // 旧实现是"host 有数据就整体覆盖本地" → 会把本地刚建好、还没同步成功的分组凭空冲掉(2026-09-12 修)。
              var byId = {}, order = []
              var put = function (g, localWinsIfMore) {
                if (!g || !g.id) return
                var old = byId[g.id]
                if (!old) { byId[g.id] = g; order.push(g.id); return }
                var a = (old.members || []).length, b = (g.members || []).length
                if (localWinsIfMore ? b > a : b >= a) byId[g.id] = g
              }
              host.forEach(function (g) { put(g, false) })
              local.forEach(function (g) { put(g, true) })
              var merged = order.map(function (id) { return byId[id] })
              state.tgGroups = merged
              try { localStorage.setItem('qqs-target-groups', JSON.stringify(merged)) } catch (e) {}
              if (JSON.stringify(merged) !== JSON.stringify(host)) saveTgGroups() // 合并结果 ≠ host → 推回, 让 AI 与主人看到同一份
            }
            if (state.tab === 'roster' || state.tab === 'broadcast') paintBody()
          }).catch(function () {})
      }
      // 📇 群组管理 M1: 勾选集合本地持久化(刷新/重开不丢, 供后续群发/批量操作使用)
      try { var _rs = localStorage.getItem('qqs-roster-sel'); if (_rs) { var _rso = JSON.parse(_rs); if (_rso && typeof _rso === 'object') state.rosterSel = _rso } } catch (e) {}
      var chatFlash = '' // 发送结果/错误提示(短时展示, 不被列表计数覆盖)
      // @ mention(输入框敲 @ 弹成员候选): 群聊目标才启用
      var atM = { members: [], open: false, kw: '', idx: 0, range: null, key: '' }
      function loadAccts() {
        api('accounts').then(function (d) {
          var list = (d && Array.isArray(d.instances) ? d.instances : []).filter(function (a) { return !a.disabled })
          state.accts = list
          if (list.length && !state.ns) {
            // 优先跟随 web 当前会话绑定的 QQ 目标(session-lookup); 未命中才回落到第一个实例
            reDetectAndSelect()
          } else if (list.length && state.ns) { /* 保持 */ paintHead(); paintDetect() } else { state.ns = ''; paintHead(); paintDetect() }
        })
      }
      // 读 web 当前会话(sessionId)并反查它是否挂在某个 qqbot 的群/私聊上
      // 权威源优先: ctx.sessions.list.getSnapshot().current(宿主官方, agent id === session id);
      // 兜底: localStorage 'dsh.sessions.current'(宿主持久化镜像, 每次切换实时写)。
      function readCurrentSessionId() {
        try {
          if (sessionsSvc && sessionsSvc.list && typeof sessionsSvc.list.getSnapshot === 'function') {
            var snap = sessionsSvc.list.getSnapshot()
            if (snap && snap.current) { state.detected = { src: 'sessions.list', sid: snap.current, title: (snap.byId && snap.byId[snap.current] && (snap.byId[snap.current].displayTitle || snap.byId[snap.current].title)) || '' }; return snap.current }
          }
        } catch (e) {}
        try { var raw = localStorage.getItem('dsh.sessions.current'); if (raw) { var o = JSON.parse(raw); if (o && o.sessionId) { state.detected = { src: 'localStorage', sid: o.sessionId, title: '' }; return o.sessionId } } } catch (e) {}
        state.detected = { src: 'none', sid: '', title: '' }
        return ''
      }
      function lookupCurrentSession(cb) {
        var sid = readCurrentSessionId()
        if (!sid) { cb(null); return }
        api('session-lookup', 'sessionId=' + encodeURIComponent(sid)).then(function (d) {
          if (d && d.ok && Array.isArray(d.hits) && d.hits.length) {
            state.detectedHit = d.hits[0]
            cb(d.hits[0])
            return
          }
          state.detectedHit = null
          cb(null)
        }).catch(function () { state.detectedHit = null; cb(null) })
      }
      function curDataDir() {
        var ac = null; state.accts.forEach(function (a) { if (a.ns === state.ns) ac = a })
        return ac ? (ac.dataDir || '') : ''
      }
      function outNsQ() { return state.ns ? 'ns=' + encodeURIComponent(state.ns) : '' }
    // ── 无上下文模式（2026-09-27）：按会话保存；当前对象 = 选中的群/人 ──
    function ctxlessKey() {
      // sessionKey 格式与插件一致: qqbot:${appId}:${kind}:${peerId}
      // 目标群优先取【当前会话命中的那个】(单会话设置跟随当前会话)，回落面板里选中的群。
      var ac = null
      if (state.accts) state.accts.forEach(function (a) { if (a.ns === state.ns) ac = a })
      // appId 多字段兜底（state.accts 的字段名不同版本可能不同）
      var appId = ''
      if (ac) appId = String(ac.appId || ac.appid || ac.appID || ac.id || '')
      if (!appId) { try { appId = String(state.acctAppId || '') } catch (e) {} }
      // 兜底：从顶栏显示串里抠 6~12 位数字（形如 "im-qqbot-2 (1900000000)"）
      if (!appId && panel) {
        try {
          var m = String(panel.textContent || '').match(/\((\d{6,12})\)/)
          if (m) appId = m[1]
        } catch (e) {}
      }
      // ★ 优先用「顶栏命中的当前会话」—— 群/私聊通用（2026-10-01 修：原来只支持群，私聊保存会报未命中）
      var hit = state.detectedHit
      if (hit && hit.peerId && appId) {
        var kind = (hit.scope === 'c2c') ? 'c2c' : 'group'
        return 'qqbot:' + appId + ':' + kind + ':' + String(hit.peerId)
      }
      // 回落：面板里选中的群
      var gid = ''
      try { gid = curHitGid() || '' } catch (e) { gid = '' }
      if (!gid) gid = state.gid || ''
      if (!appId || !gid) return ''
      return 'qqbot:' + appId + ':group:' + gid
    }
    function loadCtxless() {
      var on = panel ? panel.querySelector('#dk-ctxless-on') : null
      // ⚠️ 绑定不在这里做 —— 面板每次重绘 DOM 都是新的，直接绑会"第二次按不动"。
      //    改由【面板级事件委托】统一处理（见 startQqDock 里的 installCtxlessDelegates）。
      var win = panel ? panel.querySelector('#dk-ctxless-win') : null
      var hint = panel ? panel.querySelector('#dk-ctxless-hint') : null
      var key = ctxlessKey()
      if (!key) { if (hint) hint.textContent = '先选一个群/私聊'; return }
      api('contextless?sessionKey=' + encodeURIComponent(key))
        .then(function (d) {
          state.ctxless = d || null
          if (on) on.checked = !!(d && d.enabled)
          if (win && d && typeof d.window === 'number') win.value = String(d.window)
          try { var _mmEl = document.getElementById('dk-ctxless-memomax'); if (_mmEl) _mmEl.value = String((d && typeof d.memoMax === 'number') ? d.memoMax : 20) } catch (e) { /* ignore */ }
          // 2026-10-01: 同步 radio（原来只更新了条数框 —— 面板先渲染后拉数据，radio 会停在默认的"按条数"）
          try {
            var _isSmart = !!(d && d.smart === true)
            var _rs = document.querySelectorAll('input[name="dk-ctxless-mode"]')
            Array.prototype.forEach.call(_rs, function (r) {
              r.checked = (r.value === 'smart') ? _isSmart : !_isSmart
            })
            if (win) win.disabled = _isSmart
          } catch (e) { /* ignore */ }
          if (hint) hint.textContent = (d && d.enabled) ? '已开启(本会话)' : ''
        })
        .catch(function () { if (hint) hint.textContent = '读取失败(面板需刷新/重启后重试)' })
    }
    function saveCtxless() {
      var on = panel ? panel.querySelector('#dk-ctxless-on') : null
      var win = panel ? panel.querySelector('#dk-ctxless-win') : null
      var hint = panel ? panel.querySelector('#dk-ctxless-hint') : null
      // ⚠️ 保存前先刷新"当前会话命中"（2026-09-27）：detectedHit 只在面板打开时刷过一次，
      //    切 web 会话后不更新 → 会把状态存到"上一个会话所在的群"上（表现为"换会话也显示勾选"）。
      if (hint) hint.textContent = '读取当前会话…'
      lookupCurrentSession(function () {
        var key = ctxlessKey()
        if (!key) { if (hint) hint.textContent = '未命中 QQ 会话 —— 先和 bot 在群里或私聊里聊一句（让它成为活跃会话），再回来保存'; return }
        // 2026-10-01: 模式单选 → smart；smart=true 时 window 不生效（互斥）
        var _modeEl = document.querySelector('input[name="dk-ctxless-mode"]:checked')
        var _mode = _modeEl ? String(_modeEl.value) : 'window'
        var _mmEl2 = document.getElementById('dk-ctxless-memomax')
        var body = { sessionKey: key, enabled: !!(on && on.checked), window: win ? (parseInt(win.value, 10) || 0) : 5, smart: _mode === 'smart', memoMax: _mmEl2 ? (parseInt(_mmEl2.value, 10) || 20) : 20 }
        // radio 切换：智能判断时条数框禁用（互斥的视觉提示）
        Array.prototype.forEach.call(document.querySelectorAll('input[name="dk-ctxless-mode"]'), function (r) {
          r.onchange = function () {
            var w = document.getElementById('dk-ctxless-win')
            if (w) w.disabled = (r.value === 'smart')
          }
        })
        if (hint) hint.textContent = '保存中…'
        apiPost('contextless', body).then(function (d) {
          if (!d || !d.ok) { if (hint) hint.textContent = '保存失败: ' + JSON.stringify(d); return }
          // ★ 保存后【回读】验证（这样"到底存进去没有"一眼可见，不用猜）
          api('contextless?sessionKey=' + encodeURIComponent(key)).then(function (back) {
            var same = back && back.enabled === body.enabled && Number(back.window) === Number(body.window)
              && (back.smart === true) === (body.smart === true)
              && Number(back.memoMax || 20) === Number(body.memoMax || 20)
            if (hint) {
              hint.textContent = same
                ? ('✅ 已保存并回读确认: ' + (back.enabled ? '开启' : '关闭') + ' / 带 ' + back.window + ' 条')
                : ('⚠️ 返回 ok 但回读不一致: ' + JSON.stringify(back) + ' (提交: ' + JSON.stringify(body) + ')')
            }
            if (same) { state.ctxless = back }
          }).catch(function () { if (hint) hint.textContent = '已保存, 但回读失败(不影响)' })
        }).catch(function () { if (hint) hint.textContent = '保存异常(网络/桥未加载?)' })
      })
    }
      // ⚙ 单会话设置 · 智能回复(本地小模型; 2026-09-13 主人定, 15:2x 改名)
      // 📊 评分列表 HTML(单独抽出: 供"局部刷新"只替换内容, 不整块重绘)
      function scoreListHtml(vs) {
        if (vs === undefined || vs === null) return '<div class="dk-empty" style="padding:8px 0">读取中…</div>'
        if (!vs.items || !vs.items.length) return '<div class="dk-empty" style="padding:8px 0">还没有记录 —— 群里有人说句话之后, 这里会列出每条消息的分数</div>'
        var out = '<div style="max-height:230px;overflow:auto;border:1px solid #eee;border-radius:6px">'
        vs.items.slice().reverse().forEach(function (it) {
          var tt = new Date(it.ts || 0)
          var hh = ('0' + tt.getHours()).slice(-2) + ':' + ('0' + tt.getMinutes()).slice(-2) + ':' + ('0' + tt.getSeconds()).slice(-2)
          var col = it.worth ? '#2f9e44' : '#c23131'
          out += '<div style="padding:4px 8px;border-bottom:1px solid #f5f5f5;font-size:12px">'
            + '<span style="color:#999">' + hh + '</span> '
            // 显示"判定真正用的那个分"：优先 scoreAdj（好感偏移 / 加权综合后的结果），没有才退回原始分；
            // 两者都没有（纯图、且窗口里也没人说过话）才显示 📷
            // —— 2026-09-14 修：原来只看 it.score，导致"📷"和"[合·加权]"同时出现
            + '<b style="color:' + col + '">' + (function () {
                var shown = typeof it.scoreAdj === 'number' ? it.scoreAdj : (typeof it.score === 'number' ? it.score : undefined)
                return shown === undefined ? (it.img ? '📷' : '-') : Number(shown).toFixed(2)
              })() + '</b>'
            // 好感偏移标记（2026-09-14：**偏移加在分数上，门槛不动**）—— 文案给普通用户看，写成"基础评分＋好感偏移"
            + (it.aggWeighted && Array.isArray(it.aggParts) && it.aggParts.length
              // 聚合加权（2026-09-14 主人定）：判定分是**加权平均**，这里把每一票摊开给人看，
              //   不然"1.06 是哪来的"没法核对。格式：昵称 价值分×权重(好感占比)
              ? ' <span style="color:#e8590c;cursor:help" title="' + esc(
                  '综合分 ' + Number(it.scoreAdj).toFixed(2) + ' ＝ 窗口里 ' + it.aggParts.length + ' 条消息的加权平均'
                  + '（价值越高、好感越高，权重越大）\n'
                  + it.aggParts.map(function (p, i) {
                      return (i + 1) + '. ' + p.n + '：价值 ' + Number(p.s).toFixed(2)
                        + ' × 权重 ' + Number(p.w).toFixed(2)
                        + '（好感占比 ' + (Number(p.r) > 0 ? '+' : '') + Number(p.r).toFixed(2) + '）'
                    }).join('\n')
                  + '\n记在谁头上：权重最大的那位（当前是 ' + String(it.sender || '?') + '）'
                ) + '">[合' + it.aggParts.length + '·加权]</span>'
              : (it.attOff && typeof it.score === 'number'
                ? ' <span style="color:#e8590c;cursor:help" title="' + esc('基础评分 ' + Number(it.score).toFixed(2) + ' ＋ 好感偏移 ' + (it.attOff > 0 ? '+' : '−') + Math.abs(Number(it.attOff)).toFixed(2) + ' ＝ 有效分 ' + Number(it.score + it.attOff).toFixed(2) + '（好感档位：' + (it.attTier || '?') + '）') + '">[' + (it.attOff > 0 ? '+' : '−') + Math.abs(Number(it.attOff)).toFixed(2) + ']</span>'
                : ''))
            // 门槛（用户设置的基础评分门槛，好感度不改它）
            + (typeof it.min === 'number'
              ? ' <span style="color:#888" title="' + esc('基础评分门槛 ' + Number(it.min).toFixed(2) + '（你设置的判定线）；好感度以「好感偏移」加减在消息分数上（亲近加分、冷淡减分），不改动门槛') + '">门槛' + Number(it.min).toFixed(2) + '</span>'
              : '')
            + (it.img ? ' <span style="color:#999" title="' + esc(it.lib
                ? (it.libText
                  ? '图片消息：已在库 → 借它的标签/描述当文字评分'
                  : '图片消息：在库里但还没打标签（待整理区）→ 借不到文字，所以没有分数（图片消息默认不拦）')
                : '图片消息：无文字，不可评分（默认不拦）') + '">'
              + (it.lib ? (it.libText ? '[库内]' : '[库内·未打标]') : '[无文字]') + '</span>' : '')
            + (it.mention ? ' <span style="color:#1c7ed6" title="' + esc(it.mentionForced && !it.worth ? '被@ → 必回（分数没到门槛也回）' : '被@, 必回') + '">[@]</span>' : '')
            + (it.conf !== undefined && it.conf < 0.5 ? ' <span style="color:#999" title="低置信: 最近邻居相似度只有 ' + it.conf + ', 地图上没这类样本 —— 仅作补样本提示, 不再影响拦截">[?]</span>' : '')
            // 聚合标记：加权模式左边已经有 [合N·加权] 了，这里**不再重复**一个 [合N]
            //   （2026-09-14 主人截图里两个并排，看着像两条记录）
            + (it.agg && !it.aggWeighted ? ' <span style="color:#e8590c" title="聚合了 ' + it.agg + ' 条消息, 取其中最高分">[合' + it.agg + ']</span>' : '')
            + ' <span style="color:#555">' + esc(String(it.sender || '?')) + ':</span> '
            + esc(String(it.text || '').slice(0, 56))
            + '<div style="color:#bbb;font-size:11px;margin-left:14px">近邻: ' + esc((it.top || []).join(' · ')) + '</div>'
            + '</div>'
        })
        out += '</div>'
        out += '<div class="dk-msg" style="font-size:11px;color:#888">共 ' + (vs.total || 0) + ' 条 · 明细文件: {数据根}/.qqbot/value-scores.jsonl</div>'
        return out
      }
      // 局部刷新评分列表(不调 paintBody → 不闪、不打断滚动、不丢输入框焦点)
      // 熟识度 + 好感度(2026-09-14 主人"直接推进"后分两列展示, 两个维度别混)
      // ── 分列 + 图标(2026-09-14 主人:"好感度的文字太多了, 改成有分列, 图标显示") ──
      //   列: # ｜ 群友 ｜ 熟识度 ｜ 好感度 ｜ 这次 ｜ 活跃
      //   原来一行塞着"(内心亲近 +0.5 / 两好相凑 ×1.2)(来过2天/消息65/点名35/接话3 · 3分钟前)"两串中文,
      //   现在压成图标 + 数字,**全文退进 title 悬浮提示** —— 想细看还看得到, 只是不再堵眼睛。
      var AFF_TIER_ICON = { '陌生人': '👤', '眼熟': '👋', '熟人': '🤝' };
      var AFF_TIER_COLOR = { '陌生人': '#868e96', '眼熟': '#1c7ed6', '熟人': '#2f9e44' };
      var ATT_TIER_ICON = { '很亲近': '💖', '亲近': '💗', '中立': '😐', '冷淡': '🧊', '疏远': '❄️' };
      var ATT_TIER_COLOR = { '很亲近': '#e64980', '亲近': '#f06595', '中立': '#868e96', '冷淡': '#4c6ef5', '疏远': '#364fc7' };
      var DELTA_ICON = {
        'near': ['💗', '内心亲近 +0.5'],
        'refuse': ['🚫', '内心拒绝 −0.5'],
        'yield': ['🕊️', '让步(心里不肯仍照顾) +0.8'],
        'harsh': ['🥶', '又烦又冷(重罚) −0.5'],
        'amp:cold-praise': ['❗×1.5', '对方夸她还掉好感(不领情) ×1.5'],
        'amp:flatter': ['🎁×1.5', '对方冷她还涨好感(讨好) ×1.5'],
        'amp:both-warm': ['➕×1.2', '两好相凑 ×1.2'],
        'amp:both-cold': ['❄️×1.2', '两冷相叠 ×1.2']
      };
      var AFF_COLS = { n: 20, aff: 76, att: 92, why: 104, act: 150 };
      function affinityHeadHtml() {
        var s = function (w, t) { return '<span style="flex:0 0 ' + w + 'px">' + t + '</span>' }
        return '<div style="display:flex;gap:8px;align-items:center;font-size:11px;color:#adb5bd;padding-bottom:3px;border-bottom:1px solid #e9ecef">'
          + '<span style="flex:0 0 ' + AFF_COLS.n + 'px;text-align:right">#</span>'
          + '<span style="flex:1 1 auto;min-width:0">群友</span>'
          + s(AFF_COLS.aff, '熟识度') + s(AFF_COLS.att, '好感度') + s(AFF_COLS.why, '这次') + s(AFF_COLS.act, '活跃')
          + '</div>'
      }
      function affinityRowHtml(i, x, a) {
        var age = x.lastAt ? Math.round((Date.now() - x.lastAt) / 60000) : 0
        var tier = x.tier || '陌生人'
        var color = AFF_TIER_COLOR[tier] || '#868e96'
        var affTip = '熟识度 ' + (x.score != null ? x.score : '-') + '/100 · 档位: ' + tier
          + '(来过 ' + (x.reviews || 0) + ' 天 / 消息 ' + x.msgs + ' / 被点名 ' + x.mentions + ' / 接话 ' + x.replies + ')'
        var affCell = '<span style="flex:0 0 ' + AFF_COLS.aff + 'px" title="' + esc(affTip) + '">'
          + '<b style="color:' + color + '">' + (x.score != null ? x.score : '-') + '</b> <span>' + (AFF_TIER_ICON[tier] || '👤') + '</span></span>'
        var at = (a && a.tier) || ''
        var aNum = a ? (a.a >= 0 ? '+' : '') + Number(a.a).toFixed(2) : '—'
        var aColor = !a ? '#adb5bd' : (a.a > 0.0001 ? '#2f9e44' : (a.a < -0.0001 ? '#e03131' : '#868e96'))
        var aTip = a
          ? ('好感度 ' + a.a + '(占范围 ' + (a.ratio != null ? (a.ratio * 100).toFixed(1) + '%' : '?') + ') · 档位: ' + (at || '中立')
            + (a.why ? '；最近一次: ' + a.why : ''))
          : '还没有好感度记录(她还没对他形成态度)'
        var aCell = '<span style="flex:0 0 ' + AFF_COLS.att + 'px" title="' + esc(aTip) + '">'
          + '<b style="color:' + aColor + '">' + aNum + '</b> <span style="color:' + (ATT_TIER_COLOR[at] || '#adb5bd') + '">' + (ATT_TIER_ICON[at] || '⚪') + '</span></span>'
        var codes = (a && a.codes && a.codes.length) ? a.codes : []
        var marks = codes.map(function (c) {
          var d = DELTA_ICON[c]
          return d ? '<span title="' + esc(d[1]) + '">' + d[0] + '</span>' : ''
        }).filter(Boolean)
        var whyCell = '<span style="flex:0 0 ' + AFF_COLS.why + 'px" title="' + esc((a && a.why) || '暂无拆解') + '">'
          + (marks.length ? marks.join(' ') : '<span style="color:#ced4da">—</span>') + '</span>'
        var actTip = '来过 ' + (x.reviews || 0) + ' 天 · 消息 ' + x.msgs + ' · 被点名 ' + x.mentions + ' 次 · 接她的话 ' + x.replies + ' 次'
          + (age < 120 ? ' · 最近 ' + age + ' 分钟前' : '')
        var actCell = '<span style="flex:0 0 ' + AFF_COLS.act + 'px;color:#adb5bd;font-size:11px" title="' + esc(actTip) + '">'
          + '📅' + (x.reviews || 0) + ' 💬' + x.msgs + ' 📣' + x.mentions + ' ↩' + x.replies
          + (age < 120 ? ' <span style="color:#868e96">🕐' + age + '分</span>' : '') + '</span>'
        return '<div style="display:flex;gap:8px;align-items:center;font-size:12px;color:#495057;padding:2px 0;border-bottom:1px dashed #f1f3f5">'
          + '<span style="flex:0 0 ' + AFF_COLS.n + 'px;text-align:right;color:#adb5bd">' + (i + 1) + '</span>'
          + '<span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#343a40" title="' + esc(x.key) + '">' + esc(x.name || x.key) + '</span>'
          + affCell + aCell + whyCell + actCell + '</div>'
      }
      function loadAffinity() {
        if (state.tab !== 'session') return
        var box = panel ? panel.querySelector('#dk-aff-box') : null
        var q = state.ns ? '?' + outNsQ() : ''
        Promise.all([
          fetch('api/qqbot-settings/affinity' + q).then(function (r) { return r.json() }).catch(function () { return {} }),
          // all=1&limit=50: 这张表是"按 key 左连接好感度", 只要 top N 的话排在 N 后面的人永远显示 "—"
          // (2026-09-15 主人问"小明不是有好感度吗, 怎么显示 0" —— 他 a=0.064 排第 9, 被 top8 截掉)。
          fetch('api/qqbot-settings/attitude' + q + (q ? '&' : '?') + 'all=1&limit=50').then(function (r) { return r.json() }).catch(function () { return {} })
        ]).then(function (rs) {
          var aff = (rs[0] && rs[0].items) || []
          var att = (rs[1] && rs[1].items) || []
          var attBy = {}
          att.forEach(function (x) { attBy[x.key] = x })
          if (aff.length === 0) { state.affHtml = '还没有数据 —— 群里聊几句就出来了'; }
          else {
            state.affHtml = affinityHeadHtml() + aff.map(function (x, i) {
              return affinityRowHtml(i, x, attBy[x.key])
            }).join('')
          }
          if (box) box.innerHTML = state.affHtml
        }).catch(function () { if (box) box.textContent = '熟识度/好感度读取失败' })
      }
      function refreshScoreList() {
        if (state.tab !== 'session') return
        fetch('api/qqbot-settings/value-scores' + scoreQuery())
          .then(function (r) { return r.json() })
          .then(function (d) {
            var next = d && d.ok ? d : { items: [], total: 0 }
            // ⚠️ 2026-09-13 修(主人反馈"一直被重绘"): 原来每 10 秒**无条件**替换 innerHTML →
            //    内容没变也会闪一下。现在比较签名(最后3条+总数), 一样就完全不碰 DOM。
            var sig = (next.total || 0) + '|' + JSON.stringify((next.items || []).slice(-3))
            if (sig === state.vsSig) { state.valueScores = next; return }
            state.vsSig = sig
            state.valueScores = next
            var box = panel ? panel.querySelector('#dk-vs-box') : null
            if (box) box.innerHTML = scoreListHtml(state.valueScores)
          })
          .catch(function () { /* 静默: 拉取失败保持原样 */ })
      }
      // 当前会话命中的 QQ 目标(2026-09-13 主人要求: 评分/操作要跟随"当前会话", 与群管理页一致)
      function curHitGid() {
        var hit = state.detectedHit
        if (!hit || !hit.peerId) return ''
        // ★ 2026-10-16 c2c 修复: 原来私聊一律返回 ''(不带 gid) ⇒ 面板"最近评分"在私聊下变成
        //   "全局最近 20 条"(全是群里的), 看起来就是"私聊的消息不显示"。
        //   私聊记录在 value-scores.jsonl 里 gid 记的就是 'c2c'(见 transport/inbound 的注册),
        //   这里返回 'c2c' 让面板按当前私聊过滤, 口径与写入端对齐。
        return hit.scope === 'c2c' ? 'c2c' : hit.peerId
      }
      function curHitLabel() {
        var hit = state.detectedHit
        if (!hit || !hit.peerId) return '（当前会话不是 QQ 会话）'
        return (hit.scope === 'group' ? '群「' + (hit.name || '…') + '」' : '私聊「' + (hit.name || '…') + '」')
      }
      function scoreQuery() {
        var q = []
        if (state.ns) q.push(outNsQ())
        var g = curHitGid()
        if (g) q.push('gid=' + encodeURIComponent(g))
        q.push('limit=20')
        return '?' + q.join('&')
      }
      // ✍️ 样例库编辑: 读现有内容(展开时才拉)
      function loadValueSamplesEditor() {
        fetch('api/qqbot-settings/value-samples' + (state.ns ? '?' + outNsQ() : ''))
          .then(function (r) { return r.json() })
          .then(function (d) {
            var stat = panel ? panel.querySelector('#dk-vs-stat') : null
            var ta = panel ? panel.querySelector('#dk-vs-text') : null
            if (d && d.ok) {
              if (stat) stat.textContent = '共 ' + d.total + ' 条(她会接 ' + d.pos + ' / 不会理 ' + d.neg + ')' + (d.isDefault ? ' · 暂用内置默认, 保存后自建' : '')
              if (ta) ta.value = d.text || ''
            } else if (stat) stat.textContent = (d && d.error) || '读取失败'
          })
          .catch(function () { /* 静默 */ })
      }
      function saveValueSamplesEditor() {
        var ta = panel ? panel.querySelector('#dk-vs-text') : null
        var hint = panel ? panel.querySelector('#dk-vs-hint') : null
        if (!ta) return
        if (hint) hint.textContent = '保存中…'
        fetch('api/qqbot-settings/value-samples', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ns: state.ns, text: ta.value }),
        }).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.ok) {
            if (hint) hint.textContent = '已保存 ✓ ' + d.saved + ' 条(她会接 ' + d.pos + ' / 不会理 ' + d.neg + ') · 下一条群消息生效'
            loadValueSamplesEditor()
          } else if (hint) hint.textContent = '保存失败: ' + ((d && d.error) || '未知')
        }).catch(function (e) { if (hint) hint.textContent = '异常: ' + e.message })
      }
      function loadLocalModel() {
        if (state.tab !== 'session') return
        // ⚠️ 2026-09-13 修(主人反馈面板一直闪): 原来 paintBody 的绑定区里也调了 loadLocalModel(),
        //    而它完成后又调 paintBody() → 无限循环重绘。现在绑定区只做绑定, 这里再加一道防重入锁。
        if (state.lmBusy) return
        state.lmBusy = true
        var nsq = state.ns ? '?' + outNsQ() : ''
        state.valueScores = null
        // 先让宿主重置本地模型状态，再查状态
        fetch('api/qqbot-settings/local-model/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .catch(function () { /* reset 失败也继续查 */ })
          .then(function () { return fetch('api/qqbot-settings/local-model/status' + nsq) }).then(function (r) { return r.json() }).then(function (d) {
          state.localModel = d && d.ok ? d : null
          paintBody()
        }).catch(function () { state.localModel = null; paintBody() })
        // ⚠️ 2026-09-13 加固(主人反馈"永远显示只记录"): **直读 settings 配置**拿真实 valueGate/enabled/门槛,
        //    不再依赖 status 接口有没有带这些字段(host 未重启时旧接口不返回 → 会一直显示默认"只记录")。
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
          state.lmCfg = (d && d.value && d.value.localModel) || null
          paintBody()
        }).catch(function () { state.lmCfg = null; paintBody() })
        fetch('api/qqbot-settings/value-scores' + scoreQuery())
          .then(function (r) { return r.json() })
          .then(function (d) { state.valueScores = d && d.ok ? d : { items: [], total: 0 }; paintBody() })
          .catch(function () { state.valueScores = { items: [], total: 0 }; paintBody() })
          .then(function () { loadAffinity() })
          .then(function () { state.lmBusy = false })
        // 每 10 秒局部刷新一次评分列表(只换 #dk-vs-box 内容, 不整块重绘 → 不闪)
        if (state.lmTimer) clearInterval(state.lmTimer)
        state.lmTimer = setInterval(refreshScoreList, 10000)
        if (state.vsOpen) loadValueSamplesEditor()   // 重绘后把编辑区内容补回来(展开状态已存 state)
      }
      // 保存(全量 patch 合并: settings update 是全量语义, 不能只发单字段)
      /** 当前会话的覆盖键: "group:<gid>" / "c2c:<openid>"; 未命中(非 QQ 会话) → '' */
      function curOvKey() {
        var hit = state.detectedHit
        return (hit && hit.peerId) ? (hit.scope + ':' + hit.peerId) : ''
      }
      function saveLocalModel() {
        var hint = panel ? panel.querySelector('#dk-lm-hint') : null
        var onEl = panel ? panel.querySelector('#dk-lm-on') : null
        var dirEl = panel ? panel.querySelector('#dk-lm-dir') : null
        var gateEl = panel ? panel.querySelector('input[name="dk-lm-gate"]:checked') : null
        var minEl = panel ? panel.querySelector('#dk-lm-min') : null
        var ovKey = curOvKey()
        // ⚠️ 2026-09-13 会话级(主人要求): 评分模式/门槛/启用 存进 **当前会话** 的覆盖项;
        //    模型目录是账号级(模型只有一份), 仍写账号默认。
        if (!ovKey) {
          if (hint) hint.textContent = '✗ 当前会话不是 QQ 会话 —— 单会话设置需先切到与 bot 的群/私聊(顶栏「当前会话」要命中)'
          return
        }
        var ovNext = {
          enabled: onEl ? !!onEl.checked : true,
          valueGate: gateEl ? gateEl.value : 'log',
          valueMinScore: minEl ? (parseFloat(minEl.value) || 0.5) : 0.5,
        }
        var apNext = null   // 附件唤醒新值(账号级): 保存成功后立刻写回本地缓存, 不等接口回读
        if (hint) hint.textContent = '保存中…'
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
          var cur = (d && d.value) || {}
          var lm = Object.assign({}, cur.localModel || {})
          if (dirEl) lm.modelDir = String(dirEl.value || '').trim()      // 账号级
          {
            var fbEl = panel ? panel.querySelector('#dk-lm-fb') : null
            if (fbEl) lm.lexicalFallback = !!fbEl.checked                  // 账号级(程序兜底开关)
          }
          // 附件唤醒开关（账号级，2026-09-15）：勾了 = 该类附件无视分数直接唤醒
          {
            var apEls = panel ? panel.querySelectorAll('.dk-lm-ap') : []
            if (apEls.length) {
              lm.attachmentPassthrough = {}
              apEls.forEach(function (el) { lm.attachmentPassthrough[el.getAttribute('data-kind')] = !!el.checked })
              apNext = lm.attachmentPassthrough
            }
          }
          lm.overrides = Object.assign({}, (lm.overrides || {}))
          lm.overrides[ovKey] = ovNext                                    // 会话级
          var patch = Object.assign({}, cur, { localModel: lm })
          return fetch(UPDATE, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: d && d.revision }),
          }).then(function (r2) { return r2.json() })
        }).then(function (res) {
          if (res && !res.error) {
            if (hint) hint.textContent = '已保存 ✓(仅对本会话生效, live)'
            // 立刻把新值写进本地缓存并渲染(不等接口回读)
            var lm2 = Object.assign({}, state.lmCfg || {})
            lm2.overrides = Object.assign({}, (lm2.overrides || {}))
            lm2.overrides[ovKey] = ovNext
            if (dirEl) lm2.modelDir = String(dirEl.value || '').trim()
            if (apNext) lm2.attachmentPassthrough = apNext   // 附件唤醒(账号级): 保存后立刻回填, 否则重绘又跳回默认勾选
            state.lmCfg = lm2
            paintBody()
            setTimeout(function () { loadLocalModel() }, 2000)
          } else if (hint) hint.textContent = '保存失败: ' + ((res && res.error) || '未知响应')
        }).catch(function (e) { if (hint) hint.textContent = '保存异常: ' + e.message })
      }
      function bindLocalModel() {
        if (state.tab !== 'session' || !panel) return
        var hint = function (t) { var el = panel.querySelector('#dk-lm-hint'); if (el) el.textContent = t }
        var onEl = panel.querySelector('#dk-lm-on')
        if (onEl) onEl.onchange = function () { saveLocalModel() }
        // 评分模式 + 门槛: 改动即自动保存
        // ⚠️ 2026-09-13 修(主人反馈"低分不唤醒怎么保存不了"): 原来只有"启用"开关绑了 onchange,
        //    点三个评分模式单选按钮不会保存 → 看着像"选不了"; 现在 radio 与门槛都自动保存。
        panel.querySelectorAll('input[name="dk-lm-gate"]').forEach(function (r) {
          r.onchange = function () { saveLocalModel() }
        })
        var minInput = panel.querySelector('#dk-lm-min')
        if (minInput) minInput.onchange = function () { saveLocalModel() }
        // ↩ 恢复继承: 删掉本会话的覆盖项(2026-09-13 会话级)
        var resetBtn = panel.querySelector('#dk-lm-reset')
        if (resetBtn) resetBtn.onclick = function () {
          var h = panel.querySelector('#dk-lm-hint')
          var ovKey = curOvKey()
          if (!ovKey) return
          if (h) h.textContent = '恢复继承中…'
          fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
            var cur = (d && d.value) || {}
            var lm = Object.assign({}, cur.localModel || {})
            var ovs = Object.assign({}, (lm.overrides || {}))
            delete ovs[ovKey]
            lm.overrides = ovs
            var patch = Object.assign({}, cur, { localModel: lm })
            return fetch(UPDATE, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: d && d.revision }),
            }).then(function (r2) { return r2.json() })
          }).then(function (res) {
            if (res && !res.error) {
              if (h) h.textContent = '已恢复继承账号默认 ✓'
              if (state.lmCfg && state.lmCfg.overrides) {
                var o2 = Object.assign({}, state.lmCfg.overrides)
                delete o2[ovKey]
                state.lmCfg = Object.assign({}, state.lmCfg, { overrides: o2 })
              }
              paintBody()
              setTimeout(function () { loadLocalModel() }, 2000)
            } else if (h) h.textContent = '恢复失败: ' + ((res && res.error) || '未知')
          }).catch(function (e) { if (h) h.textContent = '异常: ' + e.message })
        }
        var saveBtn = panel.querySelector('#dk-lm-save')
        if (saveBtn) saveBtn.onclick = function () { saveLocalModel() }
        var chkBtn = panel.querySelector('#dk-lm-check')
        if (chkBtn) chkBtn.onclick = function () { state.localModel = null; paintBody(); loadLocalModel() }
        var vsBtn = panel.querySelector('#dk-vs-reload')
        if (vsBtn) vsBtn.onclick = function () { refreshScoreList() }
        // ✍️ 样例库编辑区
        var vsToggle = panel.querySelector('#dk-vs-edit-toggle')
        if (vsToggle) vsToggle.onclick = function () {
          var box = panel.querySelector('#dk-vs-editor')
          if (!box) return
          state.vsOpen = !state.vsOpen            // 存进 state: 重绘后不缩回
          box.style.display = state.vsOpen ? 'block' : 'none'
          vsToggle.textContent = state.vsOpen ? '收起' : '展开编辑'
          if (state.vsOpen) loadValueSamplesEditor()
        }
        // 📊 最近评分 折叠（2026-09-14 主人要求：这两块默认收起，别占地方）
        var vsViewToggle = panel.querySelector('#dk-vs-view-toggle')
        if (vsViewToggle) vsViewToggle.onclick = function () {
          state.vsViewOpen = !state.vsViewOpen
          var b = panel.querySelector('#dk-vs-box')
          if (b) b.style.display = state.vsViewOpen ? 'block' : 'none'
          vsViewToggle.textContent = state.vsViewOpen ? '收起' : '展开'
        }
        // 🧠 熟识度 / 💗 好感度 折叠
        var affToggle = panel.querySelector('#dk-aff-toggle')
        if (affToggle) affToggle.onclick = function () {
          state.affOpen = !state.affOpen
          var b = panel.querySelector('#dk-aff-box')
          if (b) b.style.display = state.affOpen ? 'block' : 'none'
          affToggle.textContent = state.affOpen ? '收起' : '展开'
        }
        // 📊 导出 Excel（2026-09-14 主人要"一键导出分享"）—— 直接走 GET，让浏览器下载
        var affExport = panel.querySelector('#dk-aff-export')
        if (affExport) affExport.onclick = function () {
          var url = 'api/qqbot-settings/export.xlsx' + (state.ns ? '?' + outNsQ() : '')
          var a = document.createElement('a')
          a.href = url
          a.download = ''
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          affExport.textContent = '📊 已导出'
          setTimeout(function () { affExport.textContent = '📊 导出 Excel' }, 2500)
        }
        var vsSaveBtn = panel.querySelector('#dk-vs-save')
        if (vsSaveBtn) vsSaveBtn.onclick = function () { saveValueSamplesEditor() }
        // 🤖 让ai写(2026-09-13 主人要的): 模拟一条用户消息唤醒她 → 她自己读聊天记录写样例
        // 目标 = 面板「当前会话」命中的群/私聊(与群管理页一致); 未命中 QQ 会话则明确提示
        var aiWriteBtn = panel.querySelector('#dk-vs-aiwrite')
        if (aiWriteBtn) aiWriteBtn.onclick = function () {
          var h = panel.querySelector('#dk-vs-hint')
          var hit = state.detectedHit
          if (!hit || !hit.peerId) {
            if (h) h.textContent = '✗ 当前会话不是 QQ 会话(顶栏「当前会话」未命中群/私聊) —— 请先切到与 bot 的群/私聊会话'
            return
          }
          if (h) h.textContent = '发给 AI 中…(' + (hit.scope === 'group' ? '群' : '私聊') + '「' + (hit.name || '') + '」)'
          fetch('api/qqbot-settings/value-samples/let-ai-write', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: hit.ns || state.ns, scope: hit.scope, peerId: hit.peerId }),
          }).then(function (r) { return r.json() }).then(function (d) {
            if (h) h.textContent = d && d.ok ? ('✓ ' + d.msg) : ('失败: ' + ((d && d.error) || (d && d.msg) || '未知'))
          }).catch(function (e) { if (h) h.textContent = '异常: ' + e.message })
        }
        // ⚙ 单会话设置: 次级标签切换(🧠 智能回复 / 📄 空白样板)
        panel.querySelectorAll('[data-sttab]').forEach(function (sb) {
          sb.onclick = function () {
            var v = sb.getAttribute('data-sttab')
            state.stTab = v
            paintBody()
            if (v === 'lm') loadLocalModel()
            if (v === 'cl') loadCtxless()
          }
        })
        var dlBtn = panel.querySelector('#dk-lm-dl')
        if (dlBtn) dlBtn.onclick = function () {
          dlBtn.disabled = true
          hint('下载中…(约 23MB, 1~2 分钟, 面板别关)')
          fetch('api/qqbot-settings/local-model/download', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: state.ns }),
          }).then(function (r) { return r.json() }).then(function (d) {
            if (d && d.ok) { hint('下载完成 ✓'); state.localModel = null; paintBody(); loadLocalModel() }
            else { hint('下载失败: ' + ((d && d.error) || JSON.stringify(d))); dlBtn.disabled = false }
          }).catch(function (e) { hint('下载异常: ' + e.message); dlBtn.disabled = false })
        }
      }
      // ⚙️ 出站方式: 读当前账号(ns)配置
      function loadOutMode() {
        if (state.tab !== 'out') return
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.value) { state.outMode = (d.value.outboundMode === 'detail' || d.value.outboundMode === 'passive' || d.value.outboundMode === 'silent' || d.value.outboundMode === 'nothink' ? d.value.outboundMode : 'adaptive'); state.outRev = d.revision; paintBody() }
        }).catch(function () {})
      }
      // ⚙️ 出站方式: 保存(全量 patch 只带 outboundMode; settings.update 部分合并)
      function saveOutMode(m, attempt) {
        var hint = panel ? panel.querySelector('#dk-out-hint') : null
        var trySave = function (curVal, curRev) {
          if (hint) hint.textContent = '保存中…'
          // 合并当前全量 value + 新 outboundMode(settings update 是全量语义, 不能只发单字段)
          var patch = Object.assign({}, curVal || {}, { outboundMode: m })
          return fetch(UPDATE, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: curRev }),
          }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
            if (d && d.value) { state.outMode = (d.value.outboundMode === 'detail' || d.value.outboundMode === 'passive' || d.value.outboundMode === 'silent' || d.value.outboundMode === 'nothink' ? d.value.outboundMode : 'adaptive'); state.outRev = d.revision; var h2 = panel ? panel.querySelector('#dk-out-hint') : null; if (h2) h2.textContent = '已保存 ✓ live 热更新已生效(不用重启)' }
            else {
              var conflicted = !!(d && d.error && String(d.error).indexOf('changed since it was read') >= 0)
              if (conflicted && !attempt) { refreshOutModeAndRetry(m) }
              else { var h3 = panel ? panel.querySelector('#dk-out-hint') : null; if (h3) h3.textContent = '保存失败: ' + ((d && d.error) || '未知错误') }
            }
          }).catch(function () { var h4 = panel ? panel.querySelector('#dk-out-hint') : null; if (h4) h4.textContent = '保存异常' })
        }
        var refreshOutModeAndRetry = function (mm) {
          fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (dd) {
            if (dd && dd.value) { trySave(dd.value, dd.revision) }
            else { var h5 = panel ? panel.querySelector('#dk-out-hint') : null; if (h5) h5.textContent = '保存失败: 无法重新读取最新设置'; }
          }).catch(function () { var h6 = panel ? panel.querySelector('#dk-out-hint') : null; if (h6) h6.textContent = '保存失败: 读取异常' })
        }
        // 首次: 先读最新 revision 再保存(避免 stale revision)
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d0) {
          if (d0 && d0.value) { trySave(d0.value, d0.revision) }
          else { var h7 = panel ? panel.querySelector('#dk-out-hint') : null; if (h7) h7.textContent = '保存失败: 无法读取当前设置' }
        }).catch(function () { var h8 = panel ? panel.querySelector('#dk-out-hint') : null; if (h8) h8.textContent = '保存失败: 读取异常' })
      }
      function refreshAll() {
        loadGroups(); loadC2cs()
      }
      function loadGroups() {
        state.groups = []
        var q = state.ns ? 'ns=' + encodeURIComponent(state.ns) : ''
        api('group/accounts', q).then(function (d) {
          state.groups = (d && Array.isArray(d.groups) ? d.groups : []).map(function (g) { return { gid: g.gid, name: g.name || '', from: g.from || '', lastAt: (g && g.lastAt) || 0 } })
          // 期望目标(wantPeer)命中则选中它, 否则回落第一个
          var wantGid = (state.wantPeer && state.wantPeer.scope === 'group') ? state.wantPeer.peerId : ''
          if (state.groups.some(function (g) { return g.gid === state.gid })) { /* 保持现选 */ }
          else if (wantGid && state.groups.some(function (g) { return g.gid === wantGid })) state.gid = wantGid
          else if (state.groups.length) state.gid = state.groups[0].gid
          else state.gid = ''
          paintBody()
        })
      }
      function loadC2cs() {
        var dd = curDataDir()
        state.c2cs = []
        if (!dd) { paintBody(); return }
        // 目标候选 = 真·私聊台账(known-chats scope=c2c, 即"与该机器人私聊过/开过会话"的人)。
        // ⚠️ 不能混入 group-members(群成员≠私聊对象: 群 member_openid 与 c2c openid 不同域,
        //    且 dsh 里一个 QQ 会话只绑定一个对象, 仅群里见过的人没有可私聊会话 → 发不出去)。
        var qNs = state.ns ? ('?ns=' + encodeURIComponent(state.ns)) : ''
        var qDD = dd ? ('?dataDir=' + encodeURIComponent(dd)) : ''
        Promise.all([
          api('known-chats', qDD.replace('?', '')),
          api('group/members_local', qNs.replace('?', '')),
        ]).then(function (rs) {
          var known = ((rs[0] && rs[0].chats) || [])
          // 群成员表仅用于给同 id 的私聊对象补昵称(不同域通常不命中, 无副作用)
          var nameByMid = {}
          ;((rs[1] && rs[1].members) || []).forEach(function (m) {
            if (m.mid && m.name) {
              var old = nameByMid[m.mid]
              if (!old || m.lastSeen > old.ts) nameByMid[m.mid] = { name: m.name, ts: m.lastSeen || 0 }
            }
          })
          var c2c = []
          var seen = {}
          known.forEach(function (c) {
            if (c.scope !== 'c2c' || !c.id || seen[c.id]) return
            seen[c.id] = 1
            var nm = c.name || (nameByMid[c.id] && nameByMid[c.id].name) || ''
            c2c.push({ id: c.id, name: nm, lastSeen: c.lastSeen || 0, count: c.count || 0 })
          })
          c2c.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0) })
          state.c2cs = c2c
          // 期望目标(wantPeer)是私聊 → 自动选中该对象
          if (state.wantPeer && state.wantPeer.scope === 'c2c') {
            var hit = null
            state.c2cs.forEach(function (c) { if (c.id === state.wantPeer.peerId) hit = c })
            if (hit) { state.sendTo = hit.id; state.sendName = hit.name || '' }
            else if (state.wantPeer.peerId) { state.sendTo = state.wantPeer.peerId; state.sendName = state.wantPeer.peerId }
          } else if (!state.sendTo && state.c2cs.length && state.sendScope === 'c2c') {
            state.sendTo = state.c2cs[0].id; state.sendName = state.c2cs[0].name || ''
          }
          paintBody()
        })
      }
      function fmtDeadline(ts) {
        var left = Math.max(0, Math.ceil((ts - Date.now()) / 1000))
        return left > 60 ? Math.ceil(left / 60) + ' 分钟' : left + ' 秒'
      }
      function groupSelName() {
        var g = null; state.groups.forEach(function (x) { if (x.gid === state.gid) g = x })
        if (g) return g.name || state.gid.slice(0, 10)
        // 2026-10-01: gid 有值但没在台账里(群未登记/刚切实例还没拉到列表)时, 别硬显示"(未选群)"
        //   —— 那会让人以为没选中目标; 退化成 gid 前段更好定位
        return state.gid ? state.gid.slice(0, 10) : '(未选群)'
      }
      function c2cSelName() {
        if (state.sendName) return state.sendName
        var c = null; state.c2cs.forEach(function (x) { if (x.id === state.sendTo) c = x })
        return c ? (c.name || c.id.slice(0, 10)) : '(未选)'
      }
      // ── 📇 群组管理 M1: 会话台账勾选(群 = 群会话; 个人 = 真私聊过的人(c2c 会话), 复用 state.groups+state.c2cs) ──
      function rosterRows() {
        var rows = []
        state.groups.forEach(function (g) { rows.push({ key: 'group:' + g.gid, scope: 'group', id: g.gid, name: g.name || '', lastSeen: (g && g.lastAt) || 0, count: 0 }) })
        state.c2cs.forEach(function (c) { rows.push({ key: 'c2c:' + c.id, scope: 'c2c', id: c.id, name: c.name || '', lastSeen: (c && c.lastSeen) || 0, count: (c && c.count) || 0 }) })
        var sel = state.rosterScope
        var q = String(state.rosterQ || '').trim().toLowerCase()
        return rows.filter(function (r) {
          if (sel !== 'all' && r.scope !== sel) return false
          if (!q) return true
          return (r.name || '').toLowerCase().indexOf(q) >= 0 || r.id.toLowerCase().indexOf(q) >= 0
        }).sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0) })
      }
      function fmtRosterTime(ts) {
        if (!ts) return ''
        try { var d = new Date(ts); var mm = d.getMonth() + 1; var hh = d.getHours() < 10 ? '0' + d.getHours() : d.getHours(); var mi = d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes(); return mm + '/' + d.getDate() + ' ' + hh + ':' + mi } catch (e) { return '' }
      }
      function rosterSelN() { var n = 0; for (var k in state.rosterSel) { if (state.rosterSel[k]) n++ } return n }
      function renderRosterList() {
        if (!panel || !open) return
        var box = panel.querySelector('#dk-roster-list')
        if (!box) return
        var rows = rosterRows()
        // 🗂 分组筛选(仅"选目标"页生效): 选中某分组 → 只列该组成员(2026-09-10)
        if (state.tab === 'send' && state.tgCur) {
          var curG = (state.tgGroups || []).filter(function (g2) { return g2 && g2.id === state.tgCur })[0]
          var mem = (curG && curG.members) || []
          rows = rows.filter(function (r) { return mem.indexOf(r.key) >= 0 })
        }
        var stat = panel.querySelector('#dk-roster-stat')
        if (stat) stat.textContent = '共 ' + rows.length + ' 条 · 已选 ' + rosterSelN()
        if (!rows.length) {
          box.innerHTML = '<div class="dk-empty">' + ((state.rosterScope === 'all' && !String(state.rosterQ || '').trim()) ? '没有会话记录: 机器人被拉进群/有人私聊过后会自动累积(仅这些对象可被直接投递)。' : '没有匹配项。') + '</div>'
          return
        }
        var html = ''
        rows.forEach(function (r) {
          var on = !!state.rosterSel[r.key]
          var tail = r.id.length > 10 ? '…' + r.id.slice(-6) : r.id
          var nm = r.name || '(未知名)'
          html += '<label class="dk-item" style="cursor:pointer;background:' + (on ? '#f1ecff' : 'transparent') + '">'
            + '<input type="checkbox" data-rkey="' + r.key + '"' + (on ? ' checked' : '') + ' style="accent-color:#7c6cf0;flex:none">'
            + '<span style="flex:1;min-width:0;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap"><b>' + esc(nm) + '</b>'
            + '<span style="color:#aaa;font-size:11px">' + (r.scope === 'group' ? '👥 群' : '👤 私聊') + ' · ' + esc(tail) + '</span></span>'
            + '<span style="color:#9aa0a8;font-size:11px;flex:none">' + fmtRosterTime(r.lastSeen) + '</span></label>'
        })
        box.innerHTML = html
      }
      function rosterToggle(key) {
        if (!key) return
        if (state.rosterSel[key]) delete state.rosterSel[key]
        else state.rosterSel[key] = true
        try { localStorage.setItem('qqs-roster-sel', JSON.stringify(state.rosterSel)) } catch (e) {}
        renderRosterList()
      }
      function bindRosterEvents() {
        if (!panel) return
        var qEl = panel.querySelector('#dk-roster-q')
        if (qEl) qEl.oninput = function (e) { state.rosterQ = e.target.value; renderRosterList() }
        var scopes = panel.querySelectorAll('input[name="dk-rscope"]')
        scopes.forEach(function (r) { r.onchange = function () { state.rosterScope = r.value; renderRosterList() } })
        var ref = panel.querySelector('#dk-roster-refresh')
        if (ref) ref.onclick = function () {
          var q2 = panel.querySelector('#dk-roster-q'); if (q2) q2.value = ''
          state.rosterQ = ''; refreshAll(); loadHubState()
        }
        var allB = panel.querySelector('#dk-roster-all')
        if (allB) allB.onclick = function () {
          rosterRows().forEach(function (r) { state.rosterSel[r.key] = true })
          try { localStorage.setItem('qqs-roster-sel', JSON.stringify(state.rosterSel)) } catch (e) {}
          renderRosterList()
        }
        var clr = panel.querySelector('#dk-roster-clear')
        if (clr) clr.onclick = function () {
          state.rosterSel = {}
          try { localStorage.setItem('qqs-roster-sel', JSON.stringify(state.rosterSel)) } catch (e) {}
          renderRosterList()
        }
        var box = panel.querySelector('#dk-roster-list')
        if (box) box.onclick = function (e) {
          var cb = e.target
          while (cb && cb !== box && !(cb.tagName === 'INPUT' && cb.type === 'checkbox')) cb = cb.parentNode
          if (!cb || cb === box) return
          rosterToggle(cb.getAttribute('data-rkey'))
        }
        // 🗂 分组管理(仿 QQ 分组, 2026-09-10 主人要求; 选择器页专属元素, 不在时自动跳过)
        var tgCurGroup = function () { return (state.tgGroups || []).filter(function (g2) { return g2 && g2.id === state.tgCur })[0] }
        var tgPersistSel = function () { try { localStorage.setItem('qqs-roster-sel', JSON.stringify(state.rosterSel)) } catch (e) {} }
        var tgSel = panel.querySelector('#dk-tg-sel')
        if (tgSel) tgSel.onchange = function () { state.tgCur = tgSel.value; paintBody(); bindBodyEvents() }
        var tgNew = panel.querySelector('#dk-tg-new')
        if (tgNew) tgNew.onclick = function () {
          var nm = window.prompt('新建分组名称:', '新分组')
          if (!nm) return
          var id = 'tg' + Date.now().toString(36).slice(-5)
          state.tgGroups.push({ id: id, name: String(nm).slice(0, 20), members: [] })
          state.tgCur = id
          saveTgGroups(); paintBody(); bindBodyEvents()
        }
        var tgRen = panel.querySelector('#dk-tg-rename')
        if (tgRen) tgRen.onclick = function () {
          var cur = tgCurGroup(); if (!cur) return
          var nm = window.prompt('改名:', cur.name || '')
          if (!nm) return
          cur.name = String(nm).slice(0, 20)
          saveTgGroups(); paintBody(); bindBodyEvents()
        }
        var tgDel = panel.querySelector('#dk-tg-del')
        if (tgDel) tgDel.onclick = function () {
          var cur = tgCurGroup(); if (!cur) return
          if (!window.confirm('删除分组「' + (cur.name || '') + '」? (只删分组, 不影响目标本身)')) return
          state.tgGroups = (state.tgGroups || []).filter(function (g2) { return g2.id !== state.tgCur })
          state.tgCur = ''
          saveTgGroups(); paintBody(); bindBodyEvents()
        }
        var tgAdd = panel.querySelector('#dk-tg-add')
        if (tgAdd) tgAdd.onclick = function () {
          var cur = tgCurGroup(); if (!cur) return
          var sel = Object.keys(state.rosterSel || {}).filter(function (k) { return state.rosterSel[k] })
          if (!sel.length) { window.alert('先在下面勾选目标, 再点加入本组'); return }
          var mem = cur.members || (cur.members = [])
          var n = 0
          sel.forEach(function (k) { if (mem.indexOf(k) < 0) { mem.push(k); n++ } })
          saveTgGroups(); paintBody(); bindBodyEvents()
          window.alert('已加入 ' + n + ' 个(本组共 ' + mem.length + ' 个)')
        }
        var tgRm = panel.querySelector('#dk-tg-remove')
        if (tgRm) tgRm.onclick = function () {
          var cur = tgCurGroup(); if (!cur) return
          var sel = Object.keys(state.rosterSel || {}).filter(function (k) { return state.rosterSel[k] })
          var before = (cur.members || []).length
          cur.members = (cur.members || []).filter(function (k) { return sel.indexOf(k) < 0 })
          saveTgGroups(); paintBody(); bindBodyEvents()
          window.alert('已移出 ' + (before - cur.members.length) + ' 个')
        }
        var tgPickAll = panel.querySelector('#dk-tg-pickall')
        if (tgPickAll) tgPickAll.onclick = function () {
          var cur = tgCurGroup(); if (!cur) return
          ;(cur.members || []).forEach(function (k) { state.rosterSel[k] = true })
          tgPersistSel(); paintBody(); bindBodyEvents()
        }
        var tgGoto = panel.querySelector('#dk-pick-goto')
        if (tgGoto) tgGoto.onclick = function () { state.tab = 'broadcast'; paintBody(); bindBodyEvents() }
        // 🎯 群组管理器: 设本会话/取消(走 settings groupAdmin.hubSessionId, live 热更)
        var hubSet = panel.querySelector('#dk-hub-set')
        if (hubSet) hubSet.onclick = function () {
          var sid = readCurrentSessionId()
          if (!sid) { hubHint('未识别到当前 web 会话(稍后再试)'); return }
          saveHub(sid)
        }
        var hubClr = panel.querySelector('#dk-hub-clear')
        if (hubClr) hubClr.onclick = function () { saveHub('') }
        // ⚙ 群组设置(轮询等): 读控件 → 保存到 settings groupAdmin(live 热更)
        var gaSave = panel.querySelector('#dk-ga-save')
        if (gaSave) gaSave.onclick = function () {
          var read = function (id) { var el = panel.querySelector(id); return el ? el.checked : false }
          var num = function (id, dft) {
            var el = panel.querySelector(id)
            var v = parseInt(el ? el.value : '', 10)
            return isNaN(v) || v < 1 ? dft : v
          }
          state.gaEnabled = read('#dk-ga-enabled')
    state.gaWatch = read('#dk-ga-watch')
          state.gaPoll = read('#dk-ga-poll')
          state.gaPollWake = read('#dk-ga-pollwake')
          state.gaHubNotify = read('#dk-ga-hubnotify')
          state.gaNotifyGroup = read('#dk-ga-notifygroup')
          state.gaWakeGroup = read('#dk-ga-wakegroup')
          state.gaInterval = num('#dk-ga-interval', 5)
          state.gaMinCount = num('#dk-ga-mincount', 1)
          saveGroupAdmin()
        }
        // M3 群发(自动审批策略已按主人要求移除 2026-09-10)
        bindBroadcastEvents()
      }
      function hubStatusText() {
        if (state.hubSid) return '已设: 会话 ' + state.hubSid.slice(0, 8) + '… ← 各群群事件(入群申请/新成员/被拉群)汇总注入这里'
        return '未设置: 群事件只在原群内提醒'
      }
      function hubHint(t) {
        state.hubMsg = t || ''
        var el = panel && panel.querySelector('#dk-hub-hint')
        if (el) el.textContent = state.hubMsg
      }
      function loadHubState() {
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
          if (!d || !d.value) return
          var ga = d.value.groupAdmin || {}
          state.hubSid = ga.hubSessionId || ''
          state.hubRev = d.revision
          var st = panel && panel.querySelector('#dk-hub-status')
          if (st) st.textContent = hubStatusText()
          var clr = panel && panel.querySelector('#dk-hub-clear')
          if (clr) clr.disabled = !state.hubSid
          // ⚙ 群组设置: 载入轮询/开关当前值
          var poll = ga.pollJoinRequests || {}
          state.gaEnabled = ga.enabled === true
      state.gaWatch = ga.watchJoinRequests === true   // 实时入群事件（需平台开通，重启生效）
          state.gaPoll = poll.enabled === true
          state.gaPollWake = poll.wakeLlm !== false
          state.gaHubNotify = poll.hubNotify !== false
          state.gaNotifyGroup = poll.notifyGroup !== false
          state.gaWakeGroup = poll.wakeGroup === true
          state.gaInterval = poll.intervalMin || 5
          state.gaMinCount = poll.minCount || 1
          var e1 = panel && panel.querySelector('#dk-ga-enabled'); if (e1) e1.checked = state.gaEnabled
      var ew = panel && panel.querySelector('#dk-ga-watch'); if (ew) ew.checked = state.gaWatch
          var e2 = panel && panel.querySelector('#dk-ga-poll'); if (e2) e2.checked = state.gaPoll
          var e3 = panel && panel.querySelector('#dk-ga-pollwake'); if (e3) e3.checked = state.gaPollWake
          var e4 = panel && panel.querySelector('#dk-ga-hubnotify'); if (e4) e4.checked = state.gaHubNotify
          var e4b = panel && panel.querySelector('#dk-ga-notifygroup'); if (e4b) e4b.checked = state.gaNotifyGroup
          var e4c = panel && panel.querySelector('#dk-ga-wakegroup'); if (e4c) e4c.checked = state.gaWakeGroup
          var e5 = panel && panel.querySelector('#dk-ga-interval'); if (e5) e5.value = state.gaInterval
          var e6 = panel && panel.querySelector('#dk-ga-mincount'); if (e6) e6.value = state.gaMinCount
          // 🔨 自动撤回(2026-10-20): 载入 autoRecall 当前值
          var ar = ga.autoRecall || {}
          state.arOn = ar.enabled === true
          state.arMode = ar.mode === 'drop' ? 'drop' : 'keep'
          state.arKws = (ar.keywords || []).join('\n')
          state.arKinds = (ar.kinds || []).slice()
          state.arMute = Number(ar.muteSeconds) || 0
          state.arDry = ar.dryRun === true
          var a1 = panel && panel.querySelector('#dk-ar-on'); if (a1) a1.checked = state.arOn
          var a2 = panel && panel.querySelector('#dk-ar-mode'); if (a2) a2.value = state.arMode
          var a3 = panel && panel.querySelector('#dk-ar-kws'); if (a3) a3.value = state.arKws
          var a4 = panel && panel.querySelector('#dk-ar-mute'); if (a4) a4.value = state.arMute
          var a5 = panel && panel.querySelector('#dk-ar-dry'); if (a5) a5.checked = state.arDry
          ;['text', 'image', 'voice', 'video', 'file'].forEach(function (k) {
            var el = panel && panel.querySelector('#dk-ar-k-' + k)
            if (el) el.checked = state.arKinds.indexOf(k) >= 0
          })
        }).catch(function () {})
      }
      function gaHint(t) {
        state.gaMsg = t || ''
        var el = panel && panel.querySelector('#dk-ga-hint')
        if (el) el.textContent = state.gaMsg
      }
      // 自动撤回页自己的提示行（保存反馈也写这里，2026-10-20）
      function arHint(t) {
        state.arMsg = t || ''
        var el = panel && panel.querySelector('#dk-ar-hint')
        if (el) el.textContent = state.arMsg
      }
      /**
       * 只保存 autoRecall（2026-10-20 修 BUG）:
       * 之前复用 saveGroupAdmin，会把 enabled/轮询这些**不在本页的字段**用 state 旧值一起提交（state.gaEnabled 本页无控件回读）
       * → 保存自动撤回时顺手把「群管理」关掉了。改为只 patch 本页字段。
       */
      function saveAutoRecallOnly() {
        arHint('保存中…')
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
          if (!d || !d.value) { arHint('✗ 保存失败: 读取当前设置失败'); return }
          var cur = d.value
          var patch = Object.assign({}, cur)
          patch.groupAdmin = Object.assign({}, cur.groupAdmin || {}, {
            autoRecall: {
              enabled: state.arOn === true,
              mode: state.arMode === 'drop' ? 'drop' : 'keep',
              keywords: String(state.arKws || '').split(String.fromCharCode(10)).map(function (x) { return x.trim() }).filter(Boolean),
              kinds: (state.arKinds || []).slice(),
              muteSeconds: Math.max(0, parseInt(state.arMute, 10) || 0),
              dryRun: state.arDry === true,
            },
          })
          return fetch(UPDATE, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: d.revision }),
          }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d2) {
            if (d2 && d2.value) { state.hubRev = d2.revision; arHint('✓ 自动撤回已保存(live 生效，立刻按新规则执行)') }
            else arHint('✗ 保存失败: ' + ((d2 && d2.error) || '未知错误'))
          }).catch(function () { arHint('✗ 保存异常') })
        }).catch(function () { arHint('✗ 读取当前设置失败') })
      }
      function saveGroupAdmin() {
        state.gaBusy = 'ga'; gaHint('保存中…'); arHint('保存中…')
        var doSave = function () {
          var trySave = function (cur, rev) {
            var patch = Object.assign({}, cur || {})
            var ga = Object.assign({}, (cur && cur.groupAdmin) || {}, {
              enabled: state.gaEnabled,
          watchJoinRequests: state.gaWatch === true,
              pollJoinRequests: {
                enabled: state.gaPoll,
                intervalMin: state.gaInterval,
                minCount: state.gaMinCount,
                wakeLlm: state.gaPollWake,
              },
              // ★ 2026-10-26 修（主人报「叉掉注入群管会话还是会注入」）：
              //   hubNotify / notifyInGroup / wakeGroup 是 groupAdmin 的**顶层**字段
              //   （见 config.ts 的 groupAdmin schema），原来错写进 pollJoinRequests 子对象里，
              //   后端读顶层永远读不到 → UI 上取消勾选完全无效。
              hubNotify: state.gaHubNotify,
              notifyInGroup: state.gaNotifyGroup,
              wakeGroup: state.gaWakeGroup,
              // 🔨 自动撤回(2026-10-20 主人定): 命中关键词/附件类型 → 立刻撤; mode 决定是否进 AI
              autoRecall: {
                enabled: state.arOn === true,
                mode: state.arMode === 'drop' ? 'drop' : 'keep',
                keywords: String(state.arKws || '').split('\n').map(function (s) { return s.trim() }).filter(Boolean),
                kinds: (state.arKinds || []).slice(),
                muteSeconds: Math.max(0, parseInt(state.arMute, 10) || 0),
                dryRun: state.arDry === true,
              },
            })
            patch.groupAdmin = ga
            return fetch(UPDATE, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: rev }),
            }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d2) {
              state.gaBusy = ''
              if (d2 && d2.value) {
                state.hubRev = d2.revision
                gaHint('✓ 群组设置已保存(live 生效, 轮询无需重启)')
                arHint('✓ 自动撤回已保存(live 生效，立刻按新规则执行)')
              } else {
                gaHint('保存失败: ' + ((d2 && d2.error) || '未知错误') + (d2 && String(d2.error || '').indexOf('changed since') >= 0 ? '(冲突, 请重试)' : ''))
                arHint('✗ 保存失败: ' + ((d2 && d2.error) || '未知错误'))
              }
            }).catch(function () { state.gaBusy = ''; gaHint('保存异常'); arHint('✗ 保存异常') })
          }
          fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
            if (d && d.value) trySave(d.value, d.revision)
            else { state.gaBusy = ''; gaHint('保存失败: 无法读取当前设置') }
          }).catch(function () { state.gaBusy = ''; gaHint('保存异常: 读取失败') })
        }
        doSave()
      }
      function saveHub(sid) {
        state.hubBusy = 'hub'; hubHint('保存中…')
        var doSave = function () {
          var trySave = function (cur, rev) {
            var patch = Object.assign({}, cur || {})
            var ga = Object.assign({}, (cur && cur.groupAdmin) || {}, { hubSessionId: sid || '' })
            patch.groupAdmin = ga
            return fetch(UPDATE, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: rev }),
            }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d2) {
              state.hubBusy = ''
              if (d2 && d2.value) {
                var ga2 = d2.value.groupAdmin || {}
                state.hubSid = ga2.hubSessionId || ''
                state.hubRev = d2.revision
                hubHint(sid ? '✓ 已设为本会话为群组管理器(live 生效): 各群群事件将注入此会话' : '✓ 已取消群组管理器')
                var st = panel && panel.querySelector('#dk-hub-status')
                if (st) st.textContent = hubStatusText()
                var clr = panel && panel.querySelector('#dk-hub-clear')
                if (clr) clr.disabled = !state.hubSid
              } else {
                hubHint('保存失败: ' + ((d2 && d2.error) || '未知错误') + (d2 && String(d2.error || '').indexOf('changed since') >= 0 ? '(冲突, 请重试)' : ''))
              }
            }).catch(function () { state.hubBusy = ''; hubHint('保存异常') })
          }
          // 先读最新 revision 再存(避免陈旧冲突)
          fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
            if (d && d.value) trySave(d.value, d.revision)
            else { state.hubBusy = ''; hubHint('保存失败: 无法读取当前设置') }
          }).catch(function () { state.hubBusy = ''; hubHint('保存异常: 读取失败') })
        }
        // 预校验(防呆): 群事件按 hubSessionId 反查本 bot 的 QQ 会话——纯 web(未绑群/私聊)的会话注不进去
        if (!sid) { doSave(); return }
        api('session-lookup', 'sessionId=' + encodeURIComponent(sid)).then(function (d) {
          var hits = (d && d.ok && Array.isArray(d.hits)) ? d.hits : []
          if (!hits.length) {
            state.hubBusy = ''
            hubHint('⚠️ 当前会话未绑定任何 QQ 群/私聊: 群事件注入不进去。请先切到与 bot 的某个群/私聊会话(顶栏「当前会话」会显示命中)再点设置')
            return
          }
          doSave()
        }).catch(function () { doSave() })
      }
      // ── M3 群发(勾选集合 → 草稿 → 二次确认 → 任务列表) ──
      function rosterSelectedTargets() {
        var out = []
        rosterRows().forEach(function (r) {
          if (state.rosterSel[r.key]) out.push({ scope: r.scope, peerId: r.id, name: r.name || '' })
        })
        return out
      }
      function openBroadcastDraft(text) {
        var tg = rosterSelectedTargets()
        if (!tg.length) { state.msg = '请先勾选至少一个目标'; paintBody(); return }
        state.bcDraft = { text: text || '', targets: tg }
        paintBody()
        var ta = panel && panel.querySelector('#dk-bc-text')
        if (ta) ta.focus()
      }
      /**
       * 撤回"勾选目标"最近一条广播消息(2026-09-12 主人要求): **不必去任务列表翻 task_id** ——
       * 服务端自己找该目标最新的、已成功且有 message_id 的广播记录(2 分钟窗口内)。
       * 主人原话: "直接在勾选里面加撤回按钮, 无条件发送撤回"。
       */
      function recallSelectedLast() {
        var tg = rosterSelectedTargets()
        if (!tg.length) { rosterHint('先勾选要撤回的目标'); return }
        if (!window.confirm('撤回这些目标**最近一条广播消息**?\n\n' + tg.slice(0, 8).map(function (t) { return '· ' + (t.name || t.peerId) }).join('\n') + (tg.length > 8 ? '\n…' : '') + '\n\n(发出超过 2 分钟的会失败)')) return
        rosterHint('撤回中…')
        apiPost('group/recall-last', { ns: state.ns || undefined, targets: tg.map(function (t) { return { scope: t.scope, peerId: t.peerId } }) }).then(function (d) {
          if (!d || !d.ok) { rosterHint('❌ ' + ((d && d.error) || '撤回失败')); return }
          var rs = d.results || []
          var okN = rs.filter(function (r) { return r.ok }).length
          var fails = rs.filter(function (r) { return !r.ok })
          rosterHint('✅ 已撤回 ' + okN + '/' + rs.length + ' 个' + (fails.length ? '；失败 ' + fails.length + ' 个: ' + fails.slice(0, 2).map(function (r) { return (r.err || '未知') }).join(' / ') : ''))
        }).catch(function () { rosterHint('❌ 撤回异常') })
      }
      /** 选目标页的提示行(与 bcHint 同款, 元素 id 不同) */
      function rosterHint(t) {
        state.msg = t || ''
        var el = panel && panel.querySelector('#dk-roster-hint')
        if (el) el.textContent = t || ''
      }
      function bcHint(t) {
        state.msg = t || ''
        var el = panel && panel.querySelector('.dk-msg#dk-bc-hint')
        if (el) el.textContent = t || ''
      }
      /**
       * 拉取群发任务列表。
       * ⚠️ 2026-09-10 修复死循环: 本函数原本无条件 paintBody(), 而 paintBody() 内又会调用本函数
       *    (roster / broadcast 两个 tab) → 请求返回即重绘、重绘又请求 → 无限重建 DOM,
       *    表现为 dock 卡死、按钮刚绑定就被替换掉点不动。
       * 现: ①防重入(bcTaskLoading); ②silent=true 时只更新 state 不重绘(paintBody 内一律用 silent)。
       */
      var bcTaskLoading = false
      function loadBroadcastTasks(advance, silent) {
        // advance=true 是"推进任务"(会真的发消息), 必须执行, 不被防重入挡
        // (2026-09-10 修复: 原实现一律挡, paintBody 的静默请求在飞时用户点"确认群发"会被吞 → 任务一直 queued 发不出去)
        if (bcTaskLoading && !advance) return
        bcTaskLoading = true
        api('group/broadcast/list' + (advance ? '' : '?noadvance=1')).then(function (d) {
          if (d && d.ok && Array.isArray(d.tasks)) {
            state.bcTasks = d.tasks
            if (silent !== true) paintBody()
          }
        }).catch(function () {}).then(function () { bcTaskLoading = false })
      }
      // 广播子页: 有活跃任务时自动推进(每 3s 一次, 直到无 queued/sending) —— 2026-09-10
      // 任务推进靠 list 请求驱动(host 侧串行 advanceTask 天然限频), 所以必须有节奏地拉取
      var bcAdvTimer = null
      function startBroadcastAdvance() {
        if (bcAdvTimer) return
        bcAdvTimer = setInterval(function () {
          var tasks = state.bcTasks || []
          var active = tasks.some(function (t) { return t.state === 'queued' || t.state === 'sending' })
          if (!active) { clearInterval(bcAdvTimer); bcAdvTimer = null; return }
          loadBroadcastTasks(true, false)
        }, 3000)
      }
      function bindBroadcastEvents() {
        if (!panel) return
        var sendB = panel.querySelector('#dk-roster-send')
        if (sendB) sendB.onclick = function () { openBroadcastDraft('') }
        // ↩ 撤回勾选项最近消息(2026-09-12): 选目标页与广播页共用同一个按钮 id(tab 互斥渲染)
        var recallB = panel.querySelector('#dk-roster-recall')
        if (recallB) recallB.onclick = function () { recallSelectedLast() }
        // 广播子页: 跳去「📇 群组管理」勾选目标(2026-09-10)
        var gotoB = panel.querySelector('#dk-bc-goto')
        if (gotoB) gotoB.onclick = function () { state.tab = 'roster'; paintBody(); bindBodyEvents() }
        var cc = panel.querySelector('#dk-bc-cancel')
        if (cc) cc.onclick = function () { state.bcDraft = null; paintBody() }
        var cf = panel.querySelector('#dk-bc-confirm')
        if (cf) cf.onclick = function () {
          if (!state.bcDraft) return
          var ta = panel.querySelector('#dk-bc-text')
          var text = ta ? ta.value.trim() : state.bcDraft.text
          if (!text) { bcHint('内容不能为空'); return }
          var targets = state.bcDraft.targets
          bcHint('发送中…')
          apiPost('group/broadcast/create', { ns: state.ns || undefined, type: 'text', text: text, targets: targets }).then(function (d) {
            if (!d || !d.ok || !d.task) { bcHint('❌ ' + ((d && d.error) || '创建失败')); return }
            // 二次确认: 已弹「确认群发」按钮, 这里直接 confirm 入队
            return apiPost('group/broadcast/confirm', { ns: state.ns || undefined, task_id: d.task.task_id }).then(function (d2) {
              state.bcDraft = null
              if (d2 && d2.ok) {
                // 2026-09-12 修: 确认后**切到「📢 广播」子页** —— 任务列表(含逐目标撤回)只在该页渲染,
                // 以前留在「🎯 选目标」页: 界面毫无变化(主人以为没反应/是 bug), 也从来没见过撤回按钮。
                state.tab = 'broadcast'
                state.msg = '✅ 已确认群发 ' + targets.length + ' 个目标(逐目标发送中, 2 分钟内可逐目标撤回)'
                paintBody(); bindBodyEvents()
                loadBroadcastTasks(true)
                startBroadcastAdvance()
              } else { bcHint('❌ ' + ((d2 && (d2.msg || d2.error)) || '确认失败')) }
            })
          }).catch(function () { bcHint('❌ 创建异常') })
        }
        var refreshB = panel.querySelector('#dk-bc-refresh')
        if (refreshB) refreshB.onclick = function () { loadBroadcastTasks(true) }
        var tlist = panel.querySelector('#dk-bc-tasks')
        if (tlist) tlist.onclick = function (e) {
          var b = e.target
          var cn = b.getAttribute && b.getAttribute('data-bccancel')
          if (cn) { apiPost('group/broadcast/cancel', { ns: state.ns || undefined, task_id: cn }).then(function () { loadBroadcastTasks(true) }); return }
          // 逐目标撤回(2026-09-12 重做): 任务卡片里每个"已发出"的目标自带「↩ 撤回」按钮, 点一下直接撤 ——
          // 不再弹 window.prompt 让主人手填 peerId 后 6 位(旧交互隐蔽又别扭, 主人根本没找到过)。
          var r1 = b.getAttribute && b.getAttribute('data-bcrecall1')
          if (r1) {
            var parts = String(r1).split('|')
            var t1 = (state.bcTasks || []).find(function (x) { return x.task_id === parts[0] })
            var who = t1 && t1.targets.find(function (t2) { return t2.peerId === parts[1] })
            bcHint('撤回中…')
            apiPost('group/broadcast/recall', { ns: state.ns || undefined, task_id: parts[0], peerId: parts[1] }).then(function (d) {
              bcHint(d && d.ok ? ('✅ 已撤回 ' + ((who && who.name) || parts[1])) : ('❌ ' + ((d && d.err) || '撤回失败')))
              loadBroadcastTasks(false)
            })
            return
          }
        }
      }
      // ── 📝 Markdown 卡片编辑器(2026-09-10): 源码+实时预览+按钮 → send-card 发送 ──
      function mdEscapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
      function mdRender(src) {
        var s = String(src || '')
        // 代码块(先保护)
        var codeBlocks = []
        s = s.replace(/```([\s\S]*?)```/g, function (_, c) { codeBlocks.push(c); return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000' })
        var lines = s.split('\n')
        var html = '', inList = false, inTable = false, table = []
        function closeList() { if (inList) { html += '</ul>'; inList = false } }
        function closeTable() { if (inTable) { html += '</table>'; inTable = false } }
        lines.forEach(function (line) {
          var t = line.trim()
          if (t === '') { closeList(); closeTable(); html += '<div style="height:6px"></div>'; return }
          if (/^```/.test(t)) return
          if (/^\u0000CODE\d+\u0000$/.test(t)) { closeList(); closeTable(); var i = parseInt(t.replace(/\D/g, ''), 10); html += '<pre style="background:#f6f8fa;border-radius:4px;padding:6px;font-size:11px;overflow:auto;margin:2px 0">' + mdEscapeHtml(codeBlocks[i]) + '</pre>'; return }
          var inline = function (x) {
            x = x.replace(/!\[([^\]]*)\]\(([^)\s]+)(?: #(\d+)px #(\d+)px)?\)/g, function (_, alt, url, w, h) { var st = w ? ' style="width:' + w + 'px;height:' + (h || 'auto') + 'px"' : ''; return '<img src="' + mdEscapeHtml(url) + '" alt="' + mdEscapeHtml(alt || '') + '"' + st + ' style="max-width:100%;border-radius:6px;margin:2px 0">' })
            x = x.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="' + '$2' + '" target="_blank" style="color:#4b7bec">$1</a>')
            x = x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>').replace(/`([^`]+)`/g, '<code style="background:#f1f3f5;border-radius:3px;padding:0 3px">$1</code>')
            return x
          }
          if (/^###\s+/.test(t)) { closeList(); closeTable(); html += '<div style="font-weight:700;font-size:13px;margin:4px 0 2px">' + inline(t.replace(/^###\s+/, '')) + '</div>' }
          else if (/^##\s+/.test(t)) { closeList(); closeTable(); html += '<div style="font-weight:700;font-size:15px;margin:4px 0 2px">' + inline(t.replace(/^##\s+/, '')) + '</div>' }
          else if (/^#\s+/.test(t)) { closeList(); closeTable(); html += '<div style="font-weight:700;font-size:17px;margin:4px 0 2px">' + inline(t.replace(/^#\s+/, '')) + '</div>' }
          else if (/^>\s*/.test(t)) { closeList(); closeTable(); html += '<div style="border-left:3px solid #4b7bec;padding:2px 8px;color:#666;background:#f4f7ff;border-radius:0 4px 4px 0;margin:2px 0">' + inline(t.replace(/^>\s*/, '')) + '</div>' }
          else if (/^[-*]\s+/.test(t)) { closeTable(); if (!inList) { inList = true; html += '<ul style="margin:2px 0;padding-left:18px">' } html += '<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>' }
          else if (/^\d+\.\s+/.test(t)) { closeTable(); if (!inList) { inList = true; html += '<ul style="margin:2px 0;padding-left:18px">' } html += '<li>' + inline(t.replace(/^\d+\.\s+/, '')) + '</li>' }
          else if (/^\|/.test(t)) {
            closeList()
            var cells = t.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim() })
            if (/^[-:]+$/.test(cells.join('')) && table.length) { return } // 分隔行跳过
            if (!inTable) { inTable = true; table = []; html += '<table style="border-collapse:collapse;font-size:11px;margin:2px 0"><tr>' }
            html += '<tr>' + cells.map(function (c) { return '<td style="border:1px solid #dde;padding:2px 6px">' + inline(c) + '</td>' }).join('') + '</tr>'
          }
          else { closeList(); closeTable(); html += '<div style="margin:2px 0">' + inline(t) + '</div>' }
        })
        closeList(); closeTable()
        return html
      }
      // 按钮动作判定(2026-09-10 主人要求: 卡片按钮要能写「回文本 / 跳链接 / 执行命令」):
      //   第三段显式指定 → url/链接 | cmd/命令 | text/回复; 不写则智能判断:
      //     以 http(s) 开头 = 跳链接; 以 / 开头 = 执行命令; 其余 = 回文本
      function cardBtnAction(typeRaw, data, hasType) {
        var t = String(typeRaw || '').toLowerCase()
        if (hasType) {
          if (t === 'url' || t === 'link' || t === '跳转') return 'url'
          if (t === 'cmd' || t === 'command' || t === '命令') return 'cmd'
          if (t === 'text' || t === 'reply' || t === '文本') return 'text'
        }
        if (/^https?:\/\//i.test(data)) return 'url'
        if (String(data).charAt(0) === '/') return 'cmd'
        return 'text'
      }
      function parseCardButtons(text) {
        // 每行: 文字|内容 或 文字|内容|url|cmd|text
        var out = []
        var rows = String(text || '').split('\n').map(function (s) { return s.trim() }).filter(Boolean)
        for (var i = 0; i < rows.length; i++) {
          var parts = rows[i].split('|').map(function (s) { return s.trim() })
          if (parts.length < 2 || !parts[0]) continue
          var label = parts[0], data = parts[1]
          var action = cardBtnAction(parts.length >= 3 ? parts[2] : '', data, parts.length >= 3)
          out.push({ id: 'btn' + (i + 1), label: label, data: data, action: action, isUrl: action === 'url' })
        }
        return out
      }
      function bindCardEvents() {
        if (!panel) return
        var q = function (sel) { return panel.querySelector(sel) }
        var mdEl = q('#dk-card-md')
        var prevEl = q('#dk-card-preview')
        var render = function () { if (mdEl && prevEl) prevEl.innerHTML = mdRender(mdEl.value) }
        if (mdEl) mdEl.oninput = function () { state.cardMd = mdEl.value; render() }
        var btnsEl = q('#dk-card-btns')
        if (btnsEl) btnsEl.oninput = function () { state.cardBtns = btnsEl.value }
        var gsel = q('#dk-card-gid')
        if (gsel) {
          // 默认目标同步: 避免"没手动选过"就报未选目标(2026-09-10 修复)
          if (gsel.value && !state.cardGid) state.cardGid = gsel.value
          gsel.onchange = function () { state.cardGid = gsel.value }
        }
        // 目标搜索(2026-09-10 主人要求): 输入即过滤群/私聊列表
        var cq = q('#dk-card-q')
        if (cq) {
          cq.value = state.cardQ || ''
          cq.oninput = function () { state.cardQ = cq.value }
          cq.onchange = function () { state.cardQ = cq.value; paintBody() }
          cq.onkeydown = function (e) { if (e && e.key === 'Enter') { state.cardQ = cq.value; paintBody() } }
        }
        render()
        var chHint = function (t) { var h = q('#dk-card-hint'); if (h) h.textContent = t || '' }
        // 实时读当前值: DOM 可能被 paintBody 重建, 不能依赖绑定时捕获的引用(2026-09-10 修复发送无反应)
        var readCard = function () {
          var m = q('#dk-card-md'), b = q('#dk-card-btns'), g = q('#dk-card-gid')
          var md = m ? m.value.trim() : String(state.cardMd || '').trim()
          var btns = parseCardButtons(b ? b.value : (state.cardBtns || ''))
          var raw = String((g && g.value) || state.cardGid || '')
          var isC2c = raw.indexOf('c2c:') === 0
          return { md: md, btns: btns, raw: raw, gid: isC2c ? '' : raw, openid: isC2c ? raw.slice(4) : '' }
        }
        var sendB = q('#dk-card-send')
        if (sendB) sendB.onclick = function () {
          var v = readCard()
          if (!v.md) { chHint('markdown 内容不能为空'); return }
          if (!v.raw) { chHint('请先选目标(群或私聊)'); return }
          state.cardBusy = 'card'; sendB.disabled = true; chHint(v.openid ? '发送中(私聊)…' : '发送中(群)…')
          // 按钮走结构化路径交给 host: host 生成 cardId + 回调表(回文本/执行命令靠它), 并编好 bpk: 键盘
          var cardButtons = v.btns.map(function (b) { return { label: b.label, action: b.action, payload: b.data } })
          apiPost('chat/send-card', { ns: state.ns || undefined, gid: v.gid || undefined, openid: v.openid || undefined, markdown: v.md, cardButtons: cardButtons.length ? cardButtons : undefined }).then(function (d) {
            state.cardBusy = ''; sendB.disabled = false
            chHint(d && d.ok ? ((d.msg || '✅ 卡片已发送!')) : ((d && d.err && d.err.human) || (d && d.error) || '发送失败'))
          }).catch(function () { state.cardBusy = ''; sendB.disabled = false; chHint('发送异常') })
        }
        // 💾 存为事件: 当前 markdown+按钮 → botplay 事件(独立文件, /botplay 一键发卡)
        var saveB = q('#dk-card-save')
        if (saveB) saveB.onclick = function () {
          var v = readCard()
          if (!v.md) { chHint('markdown 内容不能为空'); return }
          if (!v.btns.length) { chHint('请至少配一个按钮(存为事件需要按钮)'); return }
          state.cardBusy = 'save'; saveB.disabled = true; chHint('保存中…')
          api('group/botplay-events', state.ns ? 'ns=' + encodeURIComponent(state.ns) : '').then(function (d) {
            var events = (d && d.ok && Array.isArray(d.events)) ? d.events : []
            var ev = {
              id: 'card' + Date.now().toString(36).slice(-6),
              name: v.md.replace(/^#+\s*/, '').split('\n')[0].slice(0, 12) || '卡片',
              contentText: v.md, maxClicks: 0, expireSec: 600, buttonsPerRow: 1,
              perm: { type: 'all', userIds: [] },
              buttons: v.btns.map(function (b, i) {
                // 三型动作 → botplay 的 botAction(回文本/命令/跳转), 与卡片发送行为一致
                var act = b.action === 'url' ? { type: 'jump_url', text: '', url: b.data }
                  : (b.action === 'cmd' ? { type: 'command', text: b.data.replace(/^\//, ''), url: '' }
                    : { type: 'reply_text', text: b.data, url: '' })
                return { id: 'b' + (i + 1), label: b.label, style: 1, botAction: act, llmEffect: { mode: 'no_append', contextText: '' } }
              }),
            }
            events.push(ev)
            return apiPost('group/botplay-events', { ns: state.ns || 'im-qqbot', events: events }).then(function (d2) {
              state.cardBusy = ''; saveB.disabled = false
              chHint(d2 && d2.ok ? ('✅ 已存为事件「' + ev.name + '」(id=' + ev.id + '), 群内发 /botplay ' + ev.id + ' 可一键发卡') : '保存失败: ' + ((d2 && (d2.error || d2.msg)) || '未知错误'))
            })
          }).catch(function () { state.cardBusy = ''; saveB.disabled = false; chHint('保存异常') })
        }
        // 📤 卡片群发(2026-09-10 主人要求): 把当前卡片群发到「🎯 选目标」勾选的全部目标(二次确认)
        var bcB = q('#dk-card-broadcast')
        if (bcB) bcB.onclick = function () {
          var v = readCard()
          if (!v.md) { chHint('markdown 内容不能为空'); return }
          var tg = (typeof rosterSelectedTargets === 'function') ? rosterSelectedTargets() : []
          if (!tg.length) { chHint('先在「🎯 选目标」里勾选要群发的目标'); return }
          if (!window.confirm('确认把这卡片群发到 ' + tg.length + ' 个目标?\n\n' + tg.slice(0, 8).map(function (t2) { return '· ' + (t2.name || t2.peerId) }).join('\n') + (tg.length > 8 ? '\n…' : '') + '\n\n(高影响操作, 发送后 2 分钟内可逐目标撤回)')) return
          state.cardBusy = 'bc'; bcB.disabled = true; chHint('创建群发任务…')
          var cardButtons2 = v.btns.map(function (b) { return { label: b.label, action: b.action, payload: b.data } })
          apiPost('group/broadcast/create', { ns: state.ns || undefined, type: 'card', text: v.md, cardButtons: cardButtons2.length ? cardButtons2 : undefined, targets: tg }).then(function (d) {
            if (!d || !d.ok || !d.task) { state.cardBusy = ''; bcB.disabled = false; chHint((d && d.error) || '创建失败'); return }
            return apiPost('group/broadcast/confirm', { ns: state.ns || undefined, task_id: d.task.task_id }).then(function (d2) {
              state.cardBusy = ''; bcB.disabled = false
              chHint(d2 && d2.ok ? ('✅ 已确认群发卡片到 ' + tg.length + ' 个目标(后台逐条发送)') : ((d2 && (d2.msg || d2.error)) || '确认失败'))
              loadBroadcastTasks(false, true)
            })
          }).catch(function () { state.cardBusy = ''; bcB.disabled = false; chHint('群发异常') })
        }
      }
      function sendNow() {
        var t = (state.sendText || '').trim()
        if (!t) { state.msg = '先输入内容'; paintBody(); return }
        state.busy = 'send'; paintBody()
        var body = { text: t, ns: state.ns || undefined, insertContext: state.insertCtx === true }
        if (state.sendScope === 'c2c') {
          if (!state.sendTo) { state.msg = '先选私聊对象'; state.busy = ''; paintBody(); return }
          body.openid = state.sendTo
        } else {
          if (!state.gid) { state.msg = '先选群'; state.busy = ''; paintBody(); return }
          body.gid = state.gid
        }
        apiPost(state.sendScope === 'c2c' ? 'chat/send' : 'group/send', body).then(function (d) {
          state.busy = ''
          state.msg = (d && (d.msg || (d.err && d.err.human))) || (d && d.error) || '发送结果未知'
          if (d && d.ok) state.sendText = ''
          paintBody()
        })
      }
      function loadJoins() {
        state.joins = null; paintBody()
        if (!state.gid) { state.joins = []; paintBody(); return }
        var q = 'gid=' + encodeURIComponent(state.gid) + (state.ns ? '&ns=' + encodeURIComponent(state.ns) : '')
        api('group/join_requests', q).then(function (d) {
          state.joins = (d && d.ok && Array.isArray(d.list) ? d.list : []).map(function (j) { return { member_openid: j.member_openid, username: j.username || '(未知昵称)', verify: j.verify_human || (j.verify_info && (j.verify_info.verify_message || j.verify_info.method)) || '', risk: j.risk_tips || '', source: j.apply_source === 'invited' ? '被邀请' : '主动申请' } })
          paintBody()
        })
      }
      function doApprove(mid, op) {
        var reason = op === 'decline' ? window.prompt('拒绝理由(可留空)') : '-'
        if (op === 'decline' && reason === null) return
        state.busy = 'ap-' + mid; paintBody()
        apiPost('group/approve', { ns: state.ns || undefined, gid: state.gid, member_openid: mid, op: op, reason: reason || '' }).then(function (d) {
          state.busy = ''
          state.msg = (d && (d.msg || (d.err && d.err.human))) || '审批结果未知'
          refreshBadge(); loadJoins()
        })
      }
      function loadMutes() {
        state.mutes = null; state.members = null; paintBody()
        if (!state.gid) { state.mutes = []; state.members = []; paintBody(); return }
        var q = 'gid=' + encodeURIComponent(state.gid) + (state.ns ? '&ns=' + encodeURIComponent(state.ns) : '')
        api('group/mute_state', q).then(function (d) {
          var ms = (d && d.ok && d.data && Array.isArray(d.data.members) ? d.data.members : [])
          state.mutes = ms.map(function (m) { return { member_openid: m.member_openid, username: m.username || '', expire: m.mute_expire_at || '' } })
          paintBody()
        })
        api('group/members_local', q).then(function (d) {
          state.members = (d && d.ok && Array.isArray(d.members) ? d.members : []).map(function (m) { return { mid: m.mid, name: m.name || '' } })
          paintBody()
        })
      }
      function doMute(mid, action, seconds) {
        var secs = action === 'mute' ? Math.max(1, Math.round(Number(seconds || 600))) : 0
        state.busy = 'm-' + mid; paintBody()
        apiPost('group/mute', { ns: state.ns || undefined, gid: state.gid, member_openid: mid, action: action, seconds: secs }).then(function (d) {
          state.busy = ''
          state.msg = (d && (d.msg || (d.err && d.err.human))) || '操作结果未知'
          loadMutes(); refreshBadge()
        })
      }
      function doBind() {
        var g = (state.bindGid || '').trim()
        if (!g) { state.msg = '先粘贴 group_openid'; paintBody(); return }
        apiPost('group/bind', { ns: state.ns || undefined, gid: g, name: (state.bindName || '').trim() }).then(function (d) {
          if (d && d.ok) { state.msg = '已登记群 ✓'; state.bindGid = ''; state.bindName = ''; loadGroups() }
          else state.msg = (d && d.error) || '绑定失败'
          paintBody()
        })
      }

      function paintHead() {
        if (!panel || !open) return
        var h = panel.querySelector('.dk-h')
        if (!h) return
        var opts = state.accts.map(function (a) { return '<option value="' + esc(a.ns) + '"' + (a.ns === state.ns ? ' selected' : '') + '>' + esc(a.ns) + (a.appId ? ' (' + a.appId + ')' : '') + (a.disabled ? ' [停用]' : '') + '</option>' }).join('')
        h.innerHTML = '<span>🛡 QQ 群管理台</span>'
          + '<select class="qqs-sel" id="dk-ns" style="max-width:220px">' + (opts || '<option value="">无账号(去账号页添加)</option>') + '</select>'
          + '<span style="flex:1"></span>'
          + '<span class="dk-msg" id="dk-headmsg" style="color:#888;font-size:12px">直连 QQ 官方 · 面板操作 = 主人直发</span>'
          + '<button class="dk-btn" id="dk-full" title="全屏/还原">⛶</button>'
          + '<button class="dk-btn" id="dk-close" title="收回成球">➖</button>'
        var fb = h.querySelector('#dk-full')
        if (fb) fb.onclick = function (e) { e.stopPropagation(); var fs = panel.classList.toggle('dk-full'); fb.textContent = fs ? '🗗' : '⛶'; setTimeout(layoutPanel, 0) }
        h.querySelector('#dk-close').onclick = function () { closePanel(); ball.style.display = 'block' }
        h.querySelector('#dk-ns').onchange = function (e) {
          state.ns = e.target.value; state.gid = ''; state.sendTo = ''; state.sendName = ''; state.wantPeer = null; state.msg = ''
          refreshAll(); paintHead()
        }
      }
      function applyTargetFilter(panel, state) {
        var q = String(state.targetQ || '').trim().toLowerCase()
        var scope = state.sendScope
        var sel = scope === 'c2c' ? panel.querySelector('#dk-c2c') : panel.querySelector('#dk-gid')
        if (!sel) return
        var selVal = scope === 'c2c' ? state.sendTo : state.gid
        var opts = sel.querySelectorAll('option')
        var shown = 0, total = 0
        for (var i = 0; i < opts.length; i++) {
          var o = opts[i]
          total++
          var keep = !q || o.textContent.toLowerCase().indexOf(q) >= 0 || o.value === selVal
          o.hidden = !keep
          if (keep) shown++
        }
        var cnt = panel.querySelector('#dk-target-count')
        if (cnt) cnt.textContent = q ? ('匹配 ' + shown + '/' + total) : ''
      }
      // 📤 群发 次级标签栏(2026-09-10 主人要求: 互动事件/卡片并入主级「群发」)
      // 四个子页共享此栏: ✉️发送消息(send) / 📢广播(broadcast) / 🎮互动事件(bp) / 📝卡片(card)
      function sendSubTabs() {
        return '<div class="dk-row" style="gap:4px;margin:4px 0 6px;flex-wrap:wrap;border-bottom:1px dashed #e2d9ff;padding-bottom:6px">'
          + [['send', '🎯 选目标'], ['broadcast', '📢 广播'], ['bp', '🎮 互动事件'], ['card', '📝 卡片']]
            .map(function (s) {
              return '<button class="dk-btn' + (state.tab === s[0] ? ' on' : '') + '" data-subtab="' + s[0] + '">' + s[1] + '</button>'
            }).join('')
          + '</div>'
      }
      // ⚙ 单会话设置 · 次级标签栏(2026-09-13 主人要求: 智能回复独立成子标签, 另留一个空标签当样板)
      function sessionSubTabs() {
        var st = state.stTab || 'lm'
        return '<div class="dk-row" style="gap:4px;margin:4px 0 6px;flex-wrap:wrap;border-bottom:1px dashed #e2d9ff;padding-bottom:6px">'
          + [['lm', '🧠 智能回复'], ['cl', '🚫 无上下文'], ['blank', '📄 空白样板(备用)']]
            .map(function (s) {
              return '<button class="dk-btn' + (st === s[0] ? ' on' : '') + '" data-sttab="' + s[0] + '">' + s[1] + '</button>'
            }).join('')
          + '</div>'
      }
      // 🚀 M3 群发面板(确认草稿 + 任务列表); 「📇群组管理」与「📤群发·广播」共用(2026-09-10 抽函数)
      function broadcastPanel() {
        if (!state.bcDraft && !(state.bcTasks && state.bcTasks.length)) return ''
        var out = '<div style="border:1px solid #d3f0d3;border-radius:8px;padding:6px 8px;margin:6px 0;background:#f6fdf6">'
        if (state.bcDraft) {
          var bc = state.bcDraft
          out += '<div class="dk-row"><b style="font-size:13px">🚀 群发确认(M3)</b>'
            + '<span class="dk-msg" style="flex:1;text-align:right;color:#666;font-size:11px">' + bc.targets.length + ' 个目标</span></div>'
          out += '<textarea class="qqs-txt" id="dk-bc-text" style="width:100%;box-sizing:border-box;min-height:64px;font-size:12px;margin:2px 0" placeholder="要群发的内容…">' + esc(bc.text) + '</textarea>'
          out += '<div class="dk-item" style="border:1px solid #eef7ee;border-radius:6px;margin:1px 0;padding:3px 6px;max-height:14vh;overflow:auto">'
          bc.targets.forEach(function (t2) {
            out += '<div style="font-size:11px;color:#555;line-height:1.5">' + (t2.scope === 'group' ? '👥' : '👤') + ' ' + esc(t2.name || String(t2.peerId).slice(0, 12)) + ' <span style="color:#aaa">…' + esc(String(t2.peerId).slice(-6)) + '</span></div>'
          })
          out += '</div>'
          out += '<div class="dk-row" style="gap:8px">'
            + '<button class="dk-btn no" id="dk-bc-cancel">✕ 取消</button>'
            + '<button class="dk-btn ok" id="dk-bc-confirm">✅ 确认群发(发 ' + bc.targets.length + ' 个目标)</button>'
            + '<span class="dk-msg" style="flex:1;text-align:right;font-size:11px;color:#c23131">⚠️ 高影响操作: 发送后 2 分钟内可逐目标撤回</span></div>'
        }
        // 反馈行(2026-09-12 修): bcHint() 一直在找 `#dk-bc-hint`, 但本面板从未渲染过这个元素
        // → 点「确认群发」后界面**零反馈**(消息其实已经发出去了, 主人以为没反应/是 bug)。
        out += '<div class="dk-row"><span class="dk-msg" id="dk-bc-hint" style="color:#2f9e44;font-size:12px;margin:2px 0"></span></div>'
        if (state.bcTasks && state.bcTasks.length) {
          out += '<div class="dk-row"><b style="font-size:12px">📋 群发任务</b>'
            + '<button class="dk-btn" id="dk-bc-refresh" style="margin-left:auto">🔄 刷新进度</button></div>'
          state.bcTasks.forEach(function (tk) {
            var stc = { draft: '#888', queued: '#1971c2', sending: '#f08c00', partial_failed: '#e03131', done: '#2f9e44', cancelled: '#868e96' }[tk.state] || '#888'
            var okN = tk.targets.filter(function (t2) { return tk.results[t2.peerId] && tk.results[t2.peerId].ok }).length
            // 2 分钟撤回窗口(以服务端为准): 从任务完成时刻起算的剩余秒数
            var left = ''
            if ((tk.state === 'done' || tk.state === 'partial_failed') && tk.done_at) {
              var sec = Math.floor((tk.done_at + 120000 - Date.now()) / 1000)
              left = sec > 0 ? ('可撤 ' + sec + 's') : '已过撤回窗口'
            }
            out += '<div class="dk-item" style="border:1px solid #eee;border-radius:6px;margin:2px 0;padding:4px 6px;display:block">'
              + '<div style="display:flex;align-items:center;gap:6px">'
              + '<span style="font-size:11px;font-weight:700;color:' + stc + '">' + ({ draft: '草稿', queued: '排队中', sending: '发送中', partial_failed: '部分失败', done: '已完成', cancelled: '已中止' }[tk.state] || tk.state) + '</span>'
              + '<span style="flex:1;font-size:11px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"> ' + esc(String(tk.payload.content || '').slice(0, 30)) + '</span>'
              + '<span style="font-size:11px;color:#666">' + okN + '/' + tk.targets.length + (left ? ' · ' + left : '') + '</span>'
              + (tk.state === 'queued' || tk.state === 'sending' ? '<button class="dk-btn no" data-bccancel="' + esc(tk.task_id) + '" style="margin-left:6px">⏹ 中止</button>' : '')
              + '</div>'
            // 逐目标明细 + 该目标的「↩ 撤回」(2026-09-12): 谁发出去了、谁失败了、谁能撤, 一眼看清
            tk.targets.forEach(function (t2) {
              var r2 = tk.results && tk.results[t2.peerId]
              var mark = !r2 ? '⏳ 待发' : (r2.ok ? '✅ 已发' : ('❌ ' + esc(String(r2.err || '失败'))))
              out += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#555;padding-left:6px">'
                + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (t2.scope === 'group' ? '👥' : '👤') + ' ' + esc(t2.name || String(t2.peerId).slice(0, 12)) + ' <span style="color:#aaa">…' + esc(String(t2.peerId).slice(-4)) + '</span> ' + mark + '</span>'
                + (r2 && r2.ok ? '<button class="dk-btn no" data-bcrecall1="' + esc(tk.task_id) + '|' + esc(t2.peerId) + '" style="font-size:11px">↩ 撤回</button>' : '')
                + '</div>'
            })
            out += '</div>'
          })
        }
        out += '</div>'
        return out
      }
      function paintBody() {
        if (!panel || !open) return
        // 让模块级的 ensureDockExtTabs 能触发重绘（它拿不到这个闭包）
        try { window.__qqsPaintBody = paintBody } catch (e) { /* ignore */ }
        // ★ 2026-10-27 修（主人问：上方明明已命中当前会话，为什么扩展还拿不到）：
        //   `state` 是**每次渲染新建的对象** —— 只在初始化时赋一次 window.__qqsDockState 指针，
        //   后续 render 换了新 state，window 上那个还指着旧对象（detectedHit 永远是 null）。
        //   每次都刷新指针，扩展卡片才能读到当前的 detectedHit / ns / gid。
        try { window.__qqsDockState = state } catch (e) { /* ignore */ }
        // ★ 2026-10-27：每次重绘都确保滚轮/拖拽监听已装（幂等）。
        //   不能只靠"挂扩展卡片时"装 —— 那样不开扩展页签就永远是死的。
        try { extUiEnsureCss() } catch (e) { /* ignore */ }
        var b = panel.querySelector('.dk-b')
        if (!b) return
        var groupOpts = state.groups.map(function (g) {
          var tail = g.gid.length > 8 ? '…' + g.gid.slice(-6) : g.gid
          var label = g.name ? (g.name + ' (' + tail + ')') : ('群 ' + tail)
          return '<option value="' + esc(g.gid) + '"' + (g.gid === state.gid ? ' selected' : '') + '>' + esc(label) + (g.from ? ' [' + g.from + ']' : '') + '</option>'
        }).join('')
        var groupSelHtml = '<select class="qqs-sel" id="dk-gid" style="min-width:220px">' + (groupOpts || '<option value="">暂无群(可于下方登记)</option>') + '</select>'
        var c2cOpts = state.c2cs.map(function (c) {
          var tail = c.id.length > 8 ? '…' + c.id.slice(-6) : c.id
          var label = c.name ? (c.name + ' (' + tail + ')') : ('私聊 ' + tail)
          return '<option value="' + esc(c.id) + '"' + (c.id === state.sendTo ? ' selected' : '') + '>' + esc(label) + '</option>'
        }).join('')
        ensureDockExtTabs()
        var tabs = '<div class="dk-tab">'
          + '<button data-t="roster" class="' + (state.tab === 'roster' ? 'on' : '') + '">📇 群组管理</button>'
          + '<button data-t="chat" class="' + (state.tab === 'chat' ? 'on' : '') + '">💬 聊天</button>'
          + '<button data-t="join" class="' + (state.tab === 'join' ? 'on' : '') + '">📥 入群审批<span class="dk-join-badge" style="display:none;background:#ff4d4f;color:#fff;border-radius:8px;font-size:11px;padding:0 5px;margin-left:4px">0</span></button>'
          + '<button data-t="mute" class="' + (state.tab === 'mute' ? 'on' : '') + '">🔨 锤子</button>'
          + '<button data-t="out" class="' + (state.tab === 'out' ? 'on' : '') + '">⚙️ 出站</button>'
          + '<button data-t="send" class="' + (['send','broadcast','bp','card'].indexOf(state.tab) >= 0 ? 'on' : '') + '">📤 群发</button>'
          + '<button data-t="session" class="' + (state.tab === 'session' ? 'on' : '') + '">⚙ 单会话设置</button>'
          // ★ 2026-10-26 扩展页签（slot=dock）：只收数据根下的 ui/<id>/，每个实例各一份
          + (window.__qqsDockTabs || []).map(function (x) {
              return '<button data-t="ext:' + esc(x.extId) + '" class="' + (state.tab === 'ext:' + x.extId ? 'on' : '') + '">' + esc(x.title || x.extId) + '</button>'
            }).join('')
          + '</div>'
        var body = tabs
        var status = state.msg ? '<div class="dk-msg" style="color:#2f9e44;margin:4px 0">' + esc(state.msg) + '</div>' : ''
        if (!state.ns || state.accts.length === 0) {
          body += '<div class="dk-empty">还没有配置机器人账号 → 到「账号与预设」页添加后再回来</div>'
        } else if (state.tab === 'send') {
          // 🎯 选目标(2026-09-10 主人要求): 把原「发送消息」改成勾选式的目标选择器,
          // 分组(群/私聊)+搜索, 与「📇 群组管理」共用同一份勾选(state.rosterSel) → 供 📢 广播 群发。
          body += sendSubTabs()
          body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:4px 0 2px">🎯 选目标(勾选后到「📢 广播」群发)</div>'
          body += '<div class="dk-row"><span class="dk-msg" style="flex:1;line-height:1.5">勾选要群发的 <b>👥群 / 👤私聊</b> 对象(与「📇 群组管理」共用同一份勾选)。可用 <b>🗂 分组</b> 把常用目标归组(仿 QQ 分组), 选好切到 <b>📢 广播</b> 发送。</span></div>'
          // 🗂 分组栏(仿 QQ 下拉分组 + 编辑, 2026-09-10 主人要求)
          var tg = (state.tgGroups || []).filter(function (g2) { return g2 && g2.id })
          body += '<div class="dk-row" style="gap:6px;margin:2px 0;flex-wrap:wrap">'
            + '<span style="font-size:12px;color:#666;flex:none">🗂 分组:</span>'
            + '<select class="qqs-sel" id="dk-tg-sel" style="min-width:140px">'
            + '<option value="">全部目标</option>'
            + tg.map(function (g2) { return '<option value="' + esc(g2.id) + '"' + (state.tgCur === g2.id ? ' selected' : '') + '>' + esc(g2.name || g2.id) + '（' + ((g2.members || []).length) + '）</option>' }).join('')
            + '</select>'
            + '<button class="dk-btn" id="dk-tg-new">➕ 新建分组</button>'
            + '<button class="dk-btn" id="dk-tg-rename"' + (state.tgCur ? '' : ' disabled') + '>✏️ 改名</button>'
            + '<button class="dk-btn no" id="dk-tg-del"' + (state.tgCur ? '' : ' disabled') + '>🗑 删除</button>'
            + '</div>'
          body += '<div class="dk-row" style="gap:6px;margin:0 0 4px;flex-wrap:wrap">'
            + '<button class="dk-btn ok" id="dk-tg-add"' + (state.tgCur ? '' : ' disabled') + ' title="把上面勾选的目标加入当前分组">➕ 勾选的加入本组</button>'
            + '<button class="dk-btn" id="dk-tg-remove"' + (state.tgCur ? '' : ' disabled') + ' title="把勾选的从当前分组移出">➖ 从本组移出</button>'
            + '<button class="dk-btn" id="dk-tg-pickall"' + (state.tgCur ? '' : ' disabled') + ' title="勾选当前分组的全部成员">☑ 选中本组</button>'
            + '<span class="dk-msg" style="font-size:11px;color:#888">分组已存到 host(与 AI 共用): 直接说"发给【分组名】"即可群发</span>'
            + '</div>'
          body += '<div class="dk-row">范围: '
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="radio" name="dk-rscope" value="all"' + (state.rosterScope === 'all' ? ' checked' : '') + '> 全部</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="radio" name="dk-rscope" value="c2c"' + (state.rosterScope === 'c2c' ? ' checked' : '') + '> 👤 私聊过的人</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="radio" name="dk-rscope" value="group"' + (state.rosterScope === 'group' ? ' checked' : '') + '> 👥 群</label>'
            + '<span style="flex:1"></span>'
            + '<button class="dk-btn" id="dk-roster-refresh" title="重新拉取群注册表+聊天台账">🔄 刷新</button></div>'
          body += '<div class="dk-row" style="margin:2px 0 4px">'
            + '<input class="qqs-txt" id="dk-roster-q" placeholder="🔍 搜群名/昵称/ID…" value="' + esc(state.rosterQ || '') + '" style="flex:1;box-sizing:border-box;font-size:12px;padding:4px 8px">'
            + '<span class="dk-msg" id="dk-roster-stat" style="white-space:nowrap"></span></div>'
          body += '<div class="dk-row" style="margin:0 0 4px">'
            + '<button class="dk-btn" id="dk-roster-all">全选(当前范围)</button>'
            + '<button class="dk-btn" id="dk-roster-clear">清空</button>'
            + '<span class="dk-msg" style="flex:1;text-align:right;color:#2f9e44">已选 ' + rosterSelN() + ' 个</span>'
            + '<button class="dk-btn ok" id="dk-pick-goto">📢 去广播 →</button></div>'
          body += '<div class="dk-list" id="dk-roster-list"></div>'
        } else if (state.tab === 'chat') {
          body += '<div class="dk-row">目标类型: '
            + '<label style="display:inline-flex;align-items:center;gap:4px"><input type="radio" name="dk-scope" value="group"' + (state.sendScope !== 'c2c' ? ' checked' : '') + '> 群聊</label> '
            + '<label style="display:inline-flex;align-items:center;gap:4px"><input type="radio" name="dk-scope" value="c2c"' + (state.sendScope === 'c2c' ? ' checked' : '') + '> 私聊</label></div>'
          body += '<div class="dk-row" style="margin:2px 0 4px">'
            + '<input class="qqs-txt" id="dk-target-search" placeholder="' + (state.sendScope === 'c2c' ? '🔍 搜私聊对象(昵称/ID)…' : '🔍 搜群(备注/昵称/ID)…') + '" value="' + esc(state.targetQ || '') + '" style="width:100%;box-sizing:border-box;font-size:12px;padding:4px 8px">'
            + '<span class="dk-msg" id="dk-target-count"></span></div>'
          var chatTargetSel = state.sendScope === 'c2c'
            ? '<select class="qqs-sel" id="dk-c2c" style="min-width:220px">' + (c2cOpts || '<option value="">暂无私聊对象</option>') + '</select>'
            : groupSelHtml
          body += '<div class="dk-row" id="dk-target-row">' + chatTargetSel + '</div>'
          body += '<div class="dk-chat-wrap">'
            + '<div class="dk-chat-head">'
            + '<button class="dk-btn ok" id="dk-chat-refresh">🔄 刷新</button>'
            + '<span class="dk-msg" id="dk-chat-status" style="flex:1">QQ 会话记录(注入/系统文本已滤)</span>'
            + '</div>'
            + '<div class="dk-chat-box" id="dk-chat-box"></div>'
            + '<button class="dk-jump-latest" id="dk-jump-latest" title="跳到最新消息">↓ 最新</button>'
            + '</div>'
          // QQ 风格输入栏: 文本发送; bbcode [MEDIA:图片|路径/链接] 支持本地图与网络图
          body += '<div class="dk-composer">'
            + '<div class="dk-at-pop" id="dk-at-pop"></div>'
            + '<textarea id="dk-chat-input" rows="2" placeholder="输入文字发送(群聊敲 @ 可搜成员); 📷插图/📎文件 把本地路径或网络链接变成 [MEDIA:图片|来源]">' + esc(state.chatText) + '</textarea>'
            + '<div class="dk-cbar">'
            + '<button class="dk-btn" id="dk-chat-ins" title="发送后写一条「用户代你发送」模拟消息进 bot 上下文(web 流可见)">🧠 ' + (state.chatIns ? '记入上下文' : '不记上下文') + '</button>'
            + '<span class="dk-msg" id="dk-chat-cnt" style="color:#b3b7bd">0/2000</span>'
            + '<span style="flex:1"></span>'
            + '<input type="file" id="dk-chat-file" multiple hidden>'
            + '<button class="dk-btn" id="dk-chat-add-file" title="选择本机文件(小文件自动上传, 大文件请直接输入本机路径)">📎 文件</button>'
            + '<button class="dk-btn" id="dk-chat-add-img" title="插入图片: 弹窗输入本机路径或网络图片地址 → 自动变成 [MEDIA:图片|来源]">📷 插图</button>'
            + '<button class="dk-send" id="dk-chat-send">发送</button>'
            + '</div>'
            + '</div>'
        } else if (state.tab === 'join') {
          body += '<div class="dk-row">目标群: ' + groupSelHtml
            + '<button class="dk-btn" id="dk-refresh-join">🔄 刷新</button>'
            + '<span class="dk-msg">机器人需为群管理员; 通过/拒绝直接生效</span></div>'
          body += '<div class="dk-list" id="dk-join-list"></div>'
        } else if (state.tab === 'mute') {
          // 🔨 锤子（2026-10-02 主人定）：原「禁言」升级成一个锤子，下面分两个子标签
          var hsub = state.hammerSub || 'mute'
          body += '<div class="dk-row" style="gap:6px;margin:2px 0">'
            + '<button class="dk-btn' + (hsub === 'mute' ? ' ok' : '') + '" data-hsub="mute">🔇 禁言</button>'
            + '<button class="dk-btn' + (hsub === 'kick' ? ' ok' : '') + '" data-hsub="kick">👢 踢人</button>'
            + '<button class="dk-btn' + (hsub === 'auto' ? ' ok' : '') + '" data-hsub="auto">♻️ 自动撤回</button>'
            + '</div>'
          if (hsub === 'mute') {
            body += '<div class="dk-row">目标群: ' + groupSelHtml
              + '<button class="dk-btn" id="dk-refresh-mute">🔄 刷新</button></div>'
            body += '<div class="dk-msg">全员禁言: 官方接口未开放 · 只能操作普通成员(群主/管理员不可禁)</div>'
            body += '<div style="font-weight:700;font-size:13px;margin:8px 0 4px">① 禁言成员(机器人见过的)</div>'
            body += '<div class="dk-list" id="dk-member-list"></div>'
            body += '<div style="font-weight:700;font-size:13px;margin:8px 0 4px">② 正在禁言中</div>'
            body += '<div class="dk-list" id="dk-mute-list"></div>'
          } else if (hsub === 'kick') {
            body += hammerKickHtml()
          } else {
            body += hammerAutoRecallHtml()
          }
        } else if (state.tab === 'roster') {
          body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:2px 0">📇 会话台账:机器人聊过的对象</div>'
          body += '<div class="dk-row"><span class="dk-msg" style="flex:1;line-height:1.5">👤 = 私聊过的人(有 c2c 会话,可直接发消息) · 👥 = 群(群成员≠私聊对象: 群里见过≠能私聊,只能群内@)</span></div>'
          body += '<div style="border:1px solid #e2d9ff;border-radius:8px;padding:6px 8px;margin:2px 0 6px;background:#faf8ff">'
            + '<div class="dk-row" style="margin:0"><b style="font-size:13px">🎯 群组管理器(M2)</b>'
            + '<span class="dk-msg" style="flex:1" id="dk-hub-status">' + hubStatusText() + '</span>'
            + '<button class="dk-btn ok" id="dk-hub-set"' + (state.hubBusy ? ' disabled' : '') + ' title="把当前 web 会话设为群组管理器: 各群群事件(入群申请/新成员加入/被拉群)将汇总注入此会话">📌 设为本会话</button>'
            + '<button class="dk-btn" id="dk-hub-clear"' + (state.hubSid ? '' : ' disabled') + '>取消</button></div>'
            + '<div class="dk-msg" id="dk-hub-hint" style="color:#2f9e44"></div></div>'
          // ⚙ 群组设置(热更新): 群管理开关 + 入群申请轮询 —— 集中在此, 保存即 live 生效
          body += '<div style="border:1px solid #e2d9ff;border-radius:8px;padding:6px 8px;margin:2px 0 6px;background:#faf8ff">'
            + '<div class="dk-row" style="margin:0"><b style="font-size:13px">⚙ 群组设置(热更新)</b>'
            + '<span class="dk-msg" style="flex:1" id="dk-ga-hint"></span></div>'
            + '<div class="dk-row" style="gap:8px;flex-wrap:wrap">'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" id="dk-ga-enabled"' + (state.gaEnabled ? ' checked' : '') + '> 群管理</label>'
  + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px" title="实时接收入群申请事件(GROUP_JOIN_REQUEST)；需先在 QQ 开放平台开通该事件，否则机器人会连不上；打开后需重启生效"><input type="checkbox" id="dk-ga-watch"' + (state.gaWatch ? ' checked' : '') + '>实时入群事件(需平台开通·重启生效)</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" id="dk-ga-poll"' + (state.gaPoll ? ' checked' : '') + '> 轮询审批</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" id="dk-ga-pollwake"' + (state.gaPollWake ? ' checked' : '') + '> 唤醒AI</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" id="dk-ga-hubnotify"' + (state.gaHubNotify ? ' checked' : '') + '> 注入群管会话</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px" title="取消勾选=只注入群组管理器会话, 普通群会话不再收到审批提醒"><input type="checkbox" id="dk-ga-notifygroup"' + (state.gaNotifyGroup ? ' checked' : '') + '> 通知普通群</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px" title="唤醒申请所在群会话的AI处理审批(与「唤醒AI」分开设置, 2026-09-11 主人要求)"><input type="checkbox" id="dk-ga-wakegroup"' + (state.gaWakeGroup ? ' checked' : '') + '> 唤醒普通群AI</label>'
            + '</div>'
            + '<div class="dk-row" style="gap:8px;flex-wrap:wrap">'
            + '<span style="font-size:12px;color:#666;display:inline-flex;align-items:center;gap:4px">间隔 <input type="number" id="dk-ga-interval" min="1" value="' + (state.gaInterval || 5) + '" style="width:52px;font-size:12px;padding:2px 4px"> 分钟</span>'
            + '<span style="font-size:12px;color:#666;display:inline-flex;align-items:center;gap:4px">攒够<input type="number" id="dk-ga-mincount" min="1" value="' + (state.gaMinCount || 1) + '" style="width:44px;font-size:12px;padding:2px 4px">个才提醒</span>'
            + '<button class="dk-btn ok" id="dk-ga-save" style="margin-left:auto">💾 保存设置</button>'
            + '</div>'
            + '<div class="dk-msg" style="line-height:1.5;color:#888">轮询=定时拉各群审批列表, 有新增就唤醒AI提醒你(默认1个也报, 不攒死); 大量申请靠轮询周期自然攒批。保存即热更新, 不用重启。</div>'
            + '</div>'
          body += '<div class="dk-row">范围: '
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="radio" name="dk-rscope" value="all"' + (state.rosterScope === 'all' ? ' checked' : '') + '> 全部</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="radio" name="dk-rscope" value="c2c"' + (state.rosterScope === 'c2c' ? ' checked' : '') + '> 👤 私聊过的人</label>'
            + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="radio" name="dk-rscope" value="group"' + (state.rosterScope === 'group' ? ' checked' : '') + '> 👥 群</label>'
            + '<span style="flex:1"></span>'
            + '<button class="dk-btn" id="dk-roster-refresh" title="重新拉取群注册表+聊天台账">🔄 刷新</button></div>'
          body += '<div class="dk-row" style="margin:2px 0 4px">'
            + '<input class="qqs-txt" id="dk-roster-q" placeholder="🔍 搜昵称/群名/ID…" value="' + esc(state.rosterQ || '') + '" style="flex:1;box-sizing:border-box;font-size:12px;padding:4px 8px">'
            + '<span class="dk-msg" id="dk-roster-stat" style="white-space:nowrap"></span></div>'
          body += '<div class="dk-row" style="margin:0 0 4px">'
            + '<button class="dk-btn" id="dk-roster-all">全选(当前范围)</button>'
            + '<button class="dk-btn" id="dk-roster-clear">清空</button>'
            + '<span class="dk-msg" style="flex:1;text-align:right;color:#2f9e44">已选 ' + rosterSelN() + ' 个</span>'
            + '<button class="dk-btn ok" id="dk-roster-send">🚀 群发勾选项</button>'
            + '<button class="dk-btn no" id="dk-roster-recall" title="撤回这些目标最近一条广播消息(2 分钟内有效); 不用去任务列表翻 task_id">↩ 撤回勾选项最近消息</button></div>'
          body += '<div class="dk-row"><span class="dk-msg" id="dk-roster-hint" style="color:#2f9e44;font-size:12px"></span></div>'
          body += '<div class="dk-list" id="dk-roster-list"></div>'
          // ── M3 群发面板(与「📤 群发 · 广播」子页共用, 2026-09-10 抽成 broadcastPanel) ──
          body += broadcastPanel()
        } else if (state.tab === 'broadcast') {
          // 📢 广播子页(2026-09-10 主人要求: 群发并入「📤 群发」主标签; 目标复用 📇群组管理 的勾选)
          body += sendSubTabs()
          body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:4px 0 2px">📢 群发广播</div>'
          var btg = rosterSelectedTargets()
          body += '<div class="dk-row"><span class="dk-msg" style="flex:1;line-height:1.5">目标来自「📇 群组管理」里勾选的对象(当前已选 <b>' + btg.length + '</b> 个)。群发<b>一律二次确认</b>, 发送后 2 分钟内可逐目标撤回; 任务后台串行推进(天然限频)。</span></div>'
          body += '<div class="dk-row" style="gap:6px;flex-wrap:wrap">'
            + '<button class="dk-btn" id="dk-bc-goto">📇 去勾选目标</button>'
            + '<button class="dk-btn ok" id="dk-roster-send"' + (btg.length ? '' : ' disabled') + ' title="把勾选的目标纳入群发">🚀 群发勾选项</button>'
            + '<button class="dk-btn no" id="dk-roster-recall" title="撤回这些目标最近一条广播消息(2 分钟内有效)">↩ 撤回勾选项最近消息</button>'
            + '</div>'
          body += '<div class="dk-row"><span class="dk-msg" id="dk-roster-hint" style="color:#2f9e44;font-size:12px"></span></div>'
          if (btg.length) {
            body += '<div class="dk-item" style="border:1px solid #eef7ee;border-radius:6px;margin:4px 0;padding:3px 6px;max-height:16vh;overflow:auto">'
            btg.forEach(function (t2) {
              body += '<div style="font-size:11px;color:#555;line-height:1.5">' + (t2.scope === 'group' ? '👥' : '👤') + ' ' + esc(t2.name || String(t2.peerId).slice(0, 12)) + ' <span style="color:#aaa">…' + esc(String(t2.peerId).slice(-6)) + '</span></div>'
            })
            body += '</div>'
          }
          body += broadcastPanel()
        } else if (state.tab === 'out') {
          var om = state.outMode || 'adaptive'
          if (om === 'nothink') body += '<div class="dk-msg" style="color:#c23131;margin:2px 0">⚠️ 当前为「完全不思考」(设置页开启): QQ 入站不唤醒 AI。发 /outmode adaptive 可唤醒。</div>'
          body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:4px 0 2px">⇄ 出站方式(保存即热更新,不用重启)</div>'
          body += '<div class="dk-row">'
            + ['adaptive','detail','passive','silent'].map(function (m2) { return '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;color:#333"><input type="radio" name="dk-outmode" value="' + m2 + '"' + (om === m2 ? ' checked' : '') + '> ' + (m2==='adaptive' ? '适配主动(推荐默认)' : (m2==='detail' ? '详细主动(连工具调用一起推)' : (m2==='passive' ? '被动(只回最后一句)' : '完全不出站(静默)'))) + '</label>' }).join('')
            + '</div>'
          body += '<div class="dk-msg" style="line-height:1.6">适配主动=和QQ有关的会话回复都发到QQ: 刚收到真人消息时前5条带引用回你(能看到回的是哪句), 第6条起自动转独立新消息, 连发不被QQ吞; 定时/后台等没有新真人消息的主动推送也走独立消息。'
          body += '详细主动=聊天行为与适配主动完全一样, 但额外把 AI 的工具调用(🔧 工具调用)与工具结果也推到 QQ —— 能在 QQ 上看她正在干什么; 消息会明显变多, 看完记得切回适配主动。'
          body += '被动=始终以「回复你那条」发出, 连发约4~5条后会被QQ吞掉。完全不出站=本机静默, 不向QQ发任何回复(AI 可用工具随时切回)。本开关对纯web(没绑QQ)的会话不生效。</div>'
          body += '<span class="dk-msg" id="dk-out-hint" style="color:#2f9e44;margin:4px 0"></span>'
        } else if (String(state.tab || '').indexOf('ext:') === 0) {
          // ★ 2026-10-26 扩展页签（slot=dock）：把卡片用 Shadow DOM 挂进面板，
          //   并带上当前实例/会话上下文（dock.* 那套数据能力就靠它）。
          body += '<div id="qqs-dock-ext-host" style="padding:2px 0"></div>'
        } else if (state.tab === 'session') {
          // ⚙ 单会话设置(2026-09-13 主人定): 放"每个会话单独生效"的设置。
          // 次级标签: 🧠 智能回复 / 📄 空白样板(留作以后加新设置的模板)。
          body += sessionSubTabs()
          var st = state.stTab || 'lm'
          if (st === 'cl') {
            // ── 🚫 无上下文模式(2026-09-27 主人定): 每个会话单独生效 ──
            //    开启后该会话每轮**丢掉历史对话**(系统规则照旧)，只带「@ 之前 N 条群消息」。
            var ctxHit = curHitLabel()
            body += '<div class="dk-msg" style="line-height:1.6">开启后, 本会话每轮<b>不继承历史对话</b>(系统规则照旧), 只带上「@ 之前 N 条群消息」—— 群聊省 token 的利器。</div>'
            body += '<div class="dk-msg" style="color:#888;font-size:12px;margin:2px 0 6px">作用对象: <b>' + (ctxHit || '（当前会话不是 QQ 会话）') + '</b></div>'
            var _smartOn = !!(state.ctxless && state.ctxless.smart === true)
            var _winVal = (state.ctxless && typeof state.ctxless.window === 'number') ? state.ctxless.window : 5
            body += '<div class="dk-row" style="gap:8px;flex-wrap:wrap;align-items:center">'
              + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:13px"><input type="checkbox" id="dk-ctxless-on"' + (state.ctxless && state.ctxless.enabled ? ' checked' : '') + '>无上下文模式</label>'
              + '<button class="dk-btn ok" id="dk-ctxless-save" style="margin-left:auto">💾 保存(本会话)</button>'
              + '<span class="dk-msg" id="dk-ctxless-hint" style="color:#2f9e44"></span></div>'
            // 2026-10-01: 两种模式**互斥**（单参数是死参数、智能判断交给 AI），所以做成单选
            body += '<div style="margin:4px 0 0 22px;display:flex;flex-direction:column;gap:8px">'
              + '<label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer;font-size:13px">'
                + '<input type="radio" name="dk-ctxless-mode" value="window"' + (_smartOn ? '' : ' checked') + ' style="margin-top:3px">'
                + '<span>按条数保留&nbsp;<span style="font-size:12px;color:#666">带 @ 前 <input type="number" id="dk-ctxless-win" min="0" value="' + _winVal + '"' + (_smartOn ? ' disabled' : '') + ' style="width:56px"> 条</span>'
                + '<div style="font-size:12px;color:#888;line-height:1.4">不管在聊什么，每轮都只带「@ 前 N 条」。简单、可预期；但<b>同一话题接着聊可能断片</b>，<b>换了话题又会多带</b>。</div></span></label>'
              + '<label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer;font-size:13px">'
                + '<input type="radio" name="dk-ctxless-mode" value="smart"' + (_smartOn ? ' checked' : '') + ' style="margin-top:3px">'
                + '<span>智能判断（推荐）'
                + '<div style="font-size:12px;color:#888;line-height:1.4">由 AI <b>每轮自己判断话题是否结束</b>：结束了它就压缩旧历史（可留最近几条）或整段丢弃，<b>只留下自己总结的要点</b> —— 省 token 最狠，也不容易断片。要点存在独立文件里，<b>压缩永远碰不到</b>。</div></span></label>'
              + '</div>'
            // 备忘条数上限（面板可设；超出自动丢最旧）
            body += '<div class="dk-row" style="gap:6px;align-items:center;margin:4px 0 2px 22px;font-size:13px">'
              + '<span>备忘条数上限 <input type="number" id="dk-ctxless-memomax" min="1" max="500" value="' + ((state.ctxless && typeof state.ctxless.memoMax === 'number') ? state.ctxless.memoMax : 20) + '" style="width:60px"> 条</span>'
              + '<span style="font-size:12px;color:#888">（超出自动丢最旧的；AI 每轮的提示已要求它写精简）</span></div>'
            body += '<div class="dk-msg" style="line-height:1.5;color:#888">0 条 = 完全不带群消息(只剩系统规则 + 当前这句)。智能判断模式下条数不生效。开关存在插件数据目录, 重启不丢；<b>面板保存即时生效</b>，直接改文件则需重启。</div>'
          } else if (st === 'blank') {
            body += '<div style="border:1px dashed #cfc7ee;border-radius:8px;padding:20px 14px;margin:8px 0;text-align:center;line-height:2">'
              + '<div style="font-size:15px;font-weight:700">📄 空白样板</div>'
              + '<div style="font-size:12px;color:#888">这块先空着 —— 以后要加"每个会话单独生效"的设置, 照这个子标签加就行。<br>'
              + '(做法: 加一个子标签值 + 一段渲染分支 + 需要的 host API, 就能长出一个新的子页)</div>'
              + '</div>'
          } else {
          var lm = state.localModel
          body += '<div class="dk-msg" style="line-height:1.6">让机器人在本机跑一个 23MB 的中文小模型(<b>零 token</b>): 价值评分(她该不该开口) + 表情包语义搜索 —— <b>模型缺失时自动关闭, 不影响任何现有功能</b>。</div>'
          if (!lm) {
            body += '<div class="dk-empty">读取中…(若长时间不动, 点「🔄 重新检测」)</div>'
          } else {
            var lmMb = lm.bytes ? (Math.round((lm.bytes / 1048576) * 10) / 10) : 0
            var lmState = lm.available ? ('✅ 已就绪' + (lmMb ? ' · ' + lmMb + ' MB' : '')) : ('⚠️ 未安装(缺 ' + (lm.missing || []).length + ' 个文件) —— 点右边「⬇️ 下载模型」即可')
            // ⚠️ 2026-09-13 会话级: 评分模式/门槛/启用 **优先取当前会话的覆盖项**(overrides[group:xxx]),
            //    没有则继承账号级默认; 界面用"继承/已单独设置"标出来。
            var lmCfg = state.lmCfg || {}
            var ovKeyV = curOvKey()
            var ov = (ovKeyV && lmCfg.overrides && lmCfg.overrides[ovKeyV]) || {}
            var hasOv = !!(typeof ov.enabled === 'boolean' || ov.valueGate || typeof ov.valueMinScore === 'number')
            var pickGate = function (v) { return (v === 'off' || v === 'log' || v === 'block') ? v : '' }
            var gateV = pickGate(ov.valueGate) || pickGate(lmCfg.valueGate) || pickGate(lm.valueGate) || 'log'
            var minV = (typeof ov.valueMinScore === 'number') ? ov.valueMinScore
              : ((typeof lmCfg.valueMinScore === 'number') ? lmCfg.valueMinScore
                : (typeof lm.valueMinScore === 'number' ? lm.valueMinScore : 0.5))
            var fbV = (lmCfg.lexicalFallback === true) || (lm.lexicalFallback === true)
            var onV = (typeof ov.enabled === 'boolean') ? ov.enabled
              : ((typeof lmCfg.enabled === 'boolean') ? lmCfg.enabled : (lm.enabled !== false))
            body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px">🧠 智能回复（本地小模型） · bge-small-zh-v1.5</div>'
            // 本会话标识 + 继承状态(让"单会话"名副其实: 一眼看出这套值是谁的)
            body += '<div class="dk-row" style="gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 4px">'
              + '<span class="dk-msg" style="font-size:12px;color:#7c6bd6">本会话: ' + esc(curHitLabel()) + '</span>'
              + '<span class="dk-msg" style="font-size:11px;color:' + (hasOv ? '#2f9e44' : '#999') + '">'
              + (hasOv ? '✔ 已单独设置' : '（暂用账号默认）') + '</span>'
              + (hasOv ? '<button class="dk-btn" id="dk-lm-reset" style="font-size:11px;padding:1px 6px" title="删除本会话的单独设置, 恢复继承账号默认">↩ 恢复继承</button>' : '')
              + '</div>'
            body += '<div class="dk-row" style="gap:8px;flex-wrap:wrap;align-items:center">'
              + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="checkbox" id="dk-lm-on"' + (onV ? ' checked' : '') + '> 启用智能回复(省 token)</label>'
              + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer" title="本地小模型跑不起来时(例如安卓缺 ONNX 原生后端)的兜底: 用纯程序按字符 n-gram 算向量 —— 零依赖、微秒级; 只衡量字面相似(不是真语义), 门槛建议先用「只记录」观察"><input type="checkbox" id="dk-lm-fb"' + (fbV ? ' checked' : '') + '> 🧮 程序兜底(不依赖小模型)</label>'
              + '<span class="dk-msg" style="font-size:12px;color:' + (lm.available ? '#2f9e44' : '#c23131') + '">' + esc(lmState) + '</span>'
              + '</div>'
            body += '<div class="dk-row" style="gap:6px;margin:4px 0;flex-wrap:wrap">'
              + '<input class="qqs-inp" id="dk-lm-dir" style="flex:1;min-width:200px" placeholder="模型目录(留空=默认 ~/.dsh/models/bge-small-zh)" value="' + esc(lm.modelDir || '') + '">'
              + '<button class="dk-btn" id="dk-lm-save">💾 保存</button>'
              + '<button class="dk-btn" id="dk-lm-check">🔄 重新检测</button>'
              + (lm.available ? '' : '<button class="dk-btn ok" id="dk-lm-dl">⬇️ 下载模型(自动)</button>')
              + '</div>'
            // 评分模式 + 门槛(2026-09-13): off=不评分 / log=只记录(默认观察期) / block=低分不唤醒
            body += '<div class="dk-row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 2px">'
              + '<span style="font-size:12px;color:#666">评分模式:</span>'
              + [['off', '不评分'], ['log', '只记录(先观察)'], ['block', '低分不唤醒']].map(function (m2) {
                return '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="radio" name="dk-lm-gate" value="' + m2[0] + '"' + (gateV === m2[0] ? ' checked' : '') + '> ' + m2[1] + '</label>'
              }).join('')
              + '<span style="font-size:12px;color:#666">门槛:</span>'
              + '<input class="qqs-inp" id="dk-lm-min" type="number" step="0.01" min="0" max="1" style="width:78px" value="' + minV + '">'
              + '</div>'
            // 🎬 附件唤醒开关（2026-09-15 主人定）：按类型决定"是否**无视分数**直接唤醒"
            //   勾上 = 该类附件不管分多低都唤醒；没勾 = 交给评分决定（没文字没分 → 不唤醒）
            {
              // ⚠️ 2026-09-15 修(主人反馈"关掉图片唤醒, 保存后又跳回勾选"):
              //   根因=这里只读 status 接口(lm)的字段, 而该接口的 bot.cfg 解析不到实例配置(实测一律
              //   fallback: valueGate=log / 无 attachmentPassthrough) → 永远按默认渲染 → 看着像没保存。
              //   实际 settings 里早就是 image:false(读接口 ?ns= 已证实)。所以**以 lmCfg(直读配置)为准**,
              //   status 只兜底 —— 与 09-13 修 valueGate 同一个教训: 前端别依赖需要重启才对的 host 字段。
              var apCfg = ((lmCfg && lmCfg.attachmentPassthrough) || lm.attachmentPassthrough || {})
              var apDef = { image: true, video: false, voice: false, file: false }
              body += '<div class="dk-row" style="gap:12px;flex-wrap:wrap;align-items:center;margin:4px 0 2px">'
                + '<span style="font-size:12px;color:#666" title="勾上的类型：不管分数都唤醒她；没勾的按评分判（没文字就没分 → 不唤醒）">附件唤醒:</span>'
                + [['image', '🖼 图片'], ['video', '🎬 视频'], ['voice', '🎤 语音'], ['file', '📎 文件']].map(function (k) {
                    var on = apCfg[k[0]] === undefined ? apDef[k[0]] : apCfg[k[0]] === true
                    return '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="checkbox" class="dk-lm-ap" data-kind="' + k[0] + '"' + (on ? ' checked' : '') + '> ' + k[1] + '</label>'
                  }).join('')
                + '</div>'
            }
            body += '<span class="dk-msg" id="dk-lm-hint" style="color:#2f9e44;margin:2px 0"></span>'
            // 📊 最近评分(观察期): 让主人直接看到"她是怎么被叫醒的"
            // 2026-09-13 二次修: 列表抽成 scoreListHtml + 独立 div, 由 refreshScoreList 做**局部刷新**
            // (只换这个 div 的内容, 不整块 paintBody) → 既不闪, 又能自动更新。
            body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px;gap:8px;align-items:center;flex-wrap:wrap">'
              + '<span>📊 最近评分(观察期)</span>'
              + '<button class="dk-btn" id="dk-vs-view-toggle" style="font-size:12px;padding:1px 8px">' + (state.vsViewOpen ? '收起' : '展开') + '</button>'
              + '<span class="dk-msg" style="font-size:11px;color:#7c6bd6" id="dk-vs-scope">' + esc(curHitLabel()) + '</span>'
              + '<button class="dk-btn" id="dk-vs-reload" style="font-size:12px;padding:1px 8px">🔄 刷新</button>'
              + '<span class="dk-msg" style="font-size:11px;color:#999">每 10 秒自动更新</span>'
              + '</div>'
            body += '<div id="dk-vs-box" style="display:' + (state.vsViewOpen ? 'block' : 'none') + '">' + scoreListHtml(state.valueScores) + '</div>'
            // 💗 熟识度(她记你多牢) + 好感度(她对你什么态度) —— 两个维度分两列, 别混
            //   熟识度: {dataRoot}/.qqbot/affinity.json ｜ 好感度: {dataRoot}/.qqbot/attitude.json
            body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px;gap:8px;align-items:center;flex-wrap:wrap">'
              + '<span>🧠 熟识度(记你多牢) ｜ 💗 好感度(对你什么态度)(观察期·只统计)</span>'
              + '<button class="dk-btn" id="dk-aff-export" style="font-size:12px;padding:1px 8px" title="导成 Excel（三张表：熟识度 / 好感度 / 口径说明），可以直接转发给别人">📊 导出 Excel</button>'
              + '<button class="dk-btn" id="dk-aff-toggle" style="font-size:12px;padding:1px 8px">' + (state.affOpen ? '收起' : '展开') + '</button>'
              + '</div>'
            // 分列 + 图标(2026-09-14): 注意这里**不能**再加 white-space:pre-wrap —— 现在是逐行的 flex 布局 HTML
            body += '<div class="dk-msg" id="dk-aff-box" style="font-size:12px;color:#666;display:' + (state.affOpen ? 'block' : 'none') + '">' + (state.affHtml || '加载中…') + '</div>'
            // ✍️ 样例库编辑(2026-09-13 主人问"哪里写样本"): 直接改 jsonl, 保存后下一条消息生效
            body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:12px 0 2px;gap:8px;align-items:center;flex-wrap:wrap">'
              + '<span>✍️ 样例库(决定她的开口标准)</span>'
              + '<button class="dk-btn" id="dk-vs-edit-toggle" style="font-size:12px;padding:1px 8px">' + (state.vsOpen ? '收起' : '展开编辑') + '</button>'
              + '<button class="dk-btn ok" id="dk-vs-aiwrite" style="font-size:12px;padding:1px 8px" title="模拟一条用户消息唤醒她, 让她自己读聊天记录写样例(样例库位置+写法一起发过去)">🤖 让ai写(有聊天记录最好)</button>'
              + '<span class="dk-msg" style="font-size:11px;color:#999" id="dk-vs-stat"></span>'
              + '</div>'
            body += '<div id="dk-vs-editor" style="display:' + (state.vsOpen ? 'block' : 'none') + '">'
              + '<textarea class="qqs-area" id="dk-vs-text" style="width:100%;min-height:170px;font-family:monospace;font-size:11px" placeholder=\'一行一条 JSON: {"m":"群消息文本","y":1}   (y=1 她会想接话 / y=0 她不会理)\'></textarea>'
              + '<div class="dk-row" style="gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap">'
              + '<button class="dk-btn ok" id="dk-vs-save">💾 保存样例库</button>'
              + '<span class="dk-msg" id="dk-vs-hint" style="color:#2f9e44"></span>'
              + '</div>'
              + '<div class="dk-msg" style="font-size:11px;color:#888;line-height:1.6">一行一条 JSON。保存后<b>下一条群消息</b>就按新样例判断(自动重载, 约 0.3 秒)。'
              + '想让她自己学 —— 群里说一句「<b>从最近的聊天记录总结一批样本</b>」, 她会读真实聊天记录提炼后写进来 ✧</div>'
              + '</div>'
            body += '<div class="dk-msg" style="font-size:12px;color:#888;line-height:1.6">'
              + (lm.available
                ? '模型加载是懒加载: 第一次用到(有群消息需要评分)才载入, 约 0.3 秒, 之后常驻内存(~150MB)。'
                : '点「⬇️ 下载模型」自动拉取(约 23MB, hf-mirror 优先/官方兜底, 1~2 分钟); 也可以自己下载后放进上面目录: '
                  + '<code>onnx/model_quantized.onnx</code> · <code>tokenizer.json</code> · <code>tokenizer_config.json</code> · <code>config.json</code>')
              + '</div>'
          }
          }
        } else if (state.tab === 'card') {
          // 📝 自定义 markdown 卡片(2026-09-10): 源码 + 实时预览 + 按钮配置 → 发送到选中群/私聊
          body += sendSubTabs()
          body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:4px 0 2px">📝 Markdown 卡片编辑器(自定义互动卡)</div>'
          body += '<div class="dk-row"><span class="dk-msg" style="flex:1;line-height:1.5">写 markdown(支持 <b>![图 #宽px #高px](网络图URL)</b> 嵌图) → 加按钮(每行一个, 格式 <b>文字|指令</b> 或 <b>文字|url|跳转</b>) → 选目标发送。markdown 图只能用<b>公网直链图</b>(带扩展名/有 Content-Length 的图床最稳)。</span></div>'
          // 目标: 群 + 私聊(c2c: 前缀) + 搜索过滤(2026-09-10 主人要求)
          // ⚠️ 字段名: 群对象用 gid(state.groups = {gid,name,from,lastAt}), 私聊对象用 id(state.c2cs)。
          //    2026-09-10 修复: 原写成 g.id → String(undefined)="undefined" → 请求打到
          //    /v2/groups/undefined/messages → 11255 invalid request(群里发不出去)。
          var cTargets = (state.groups || []).map(function (g) {
            var gid = String((g && (g.gid || g.id)) || '')
            return { v: gid, n: (g && g.name) || gid.slice(0, 8), kind: 'group' }
          }).filter(function (t) { return t.v && t.v !== 'undefined' && t.v !== 'null' })
          ;(state.c2cs || []).forEach(function (c) {
            var cid = String((c && (c.id || c.peerId || c.openid)) || '')
            if (!cid || cid === 'undefined' || cid === 'null') return
            cTargets.push({ v: 'c2c:' + cid, n: (c.name || ('私聊 ' + cid.slice(0, 8))) + '（私聊）', kind: 'c2c' })
          })
          var cq = String(state.cardQ || '').toLowerCase()
          if (cq) cTargets = cTargets.filter(function (t) { return (t.n + ' ' + t.v).toLowerCase().indexOf(cq) >= 0 })
          if (!state.cardGid && cTargets.length) state.cardGid = cTargets[0].v   // 默认选中第一项, 避免"未选目标"
          body += '<div class="dk-row" style="gap:6px;margin:2px 0">目标: <select class="qqs-sel" id="dk-card-gid" style="flex:1;min-width:0">'
          body += cTargets.map(function (t) { return '<option value="' + esc(t.v) + '"' + (t.v === state.cardGid ? ' selected' : '') + '>' + esc(t.n) + '</option>' }).join('')
            || '<option value="">(无可选目标)</option>'
          body += '</select>'
            + '<input class="qqs-txt" id="dk-card-q" placeholder="🔍 搜群/私聊…" value="' + esc(state.cardQ || '') + '" style="width:120px;font-size:12px;padding:3px 6px">'
            + '</div>'
          body += '<div style="display:flex;gap:6px;margin:2px 0">'
            + '<textarea id="dk-card-md" placeholder="# 标题&#10;&#10;正文 **加粗**&#10;&#10;![图 #208px #160px](https://example.com/img.png)" style="flex:1;min-height:140px;font-size:12px;font-family:monospace;box-sizing:border-box;padding:6px;border:1px solid #ddd;border-radius:6px;resize:vertical">' + esc(state.cardMd) + '</textarea>'
            + '<div id="dk-card-preview" style="flex:1;min-height:140px;max-height:200px;overflow:auto;border:1px dashed #c9d8ff;border-radius:6px;padding:6px;font-size:12px;background:#fafbff;box-sizing:border-box"></div>'
            + '</div>'
          body += '<div class="dk-row" style="gap:6px;margin:2px 0 0"><span style="font-size:12px;color:#888;flex:none">按钮:</span>'
            + '<textarea id="dk-card-btns" placeholder="每行一个: 文字|内容|类型&#10;先回文本: ✅ 签到|✅ 签到成功 +1 🎉&#10;执行命令: 查天气|/weather|cmd&#10;跳转链接: 🔗官网|https://qq.com|url" style="flex:1;min-height:72px;font-size:12px;font-family:monospace;box-sizing:border-box;padding:6px;border:1px solid #ddd;border-radius:6px;resize:vertical">' + esc(state.cardBtns) + '</textarea></div>'
          // 常显格式说明(2026-09-10 主人要求: 文本怎么写按钮要有说明; 三型动作 2026-09-10 晚扩充)
          body += '<div class="dk-msg" style="font-size:11px;line-height:1.6;color:#666;background:#f8f6ff;border:1px solid #eee7ff;border-radius:6px;padding:4px 8px;margin:2px 0">'
            + '<b>按钮写法</b>(上面框里一行一个, 竖线 <code>|</code> 分隔, 第三段可省):<br>'
            + '· <b>回文本</b> — <code>文字|要回的文本</code>　例: <code>✅ 签到|✅ 签到成功 +1 🎉</code>(点击后机器人直接回这句, 不吵 AI)<br>'
            + '· <b>执行命令</b> — <code>文字|/指令</code>　例: <code>查天气|/weather</code>(点击后执行该斜杠命令)<br>'
            + '· <b>跳转链接</b> — <code>文字|网址</code>　例: <code>🔗官网|https://qq.com</code>(点击直接跳网页)<br>'
            + '· 想写死类型就加第三段: <code>|text</code>(回文本) / <code>|cmd</code>(命令) / <code>|url</code>(跳转)<br>'
            + '· 每行一个按钮, 最多 25 个(5行×5列, 由"每行按钮"控制布局)</div>'
          body += '<div class="dk-row" style="gap:8px">'
            + '<button class="dk-btn ok" id="dk-card-send"' + (state.cardBusy ? ' disabled' : '') + '>🚀 发送卡片</button>'
            + '<button class="dk-btn" id="dk-card-save"' + (state.cardBusy ? ' disabled' : '') + '>💾 存为事件</button>'
            + '<button class="dk-btn" id="dk-card-broadcast"' + (state.cardBusy ? ' disabled' : '') + ' title="群发到「🎯 选目标」里勾选的全部目标(二次确认)">📤 群发到勾选目标(' + rosterSelN() + ')</button>'
            + '<span class="dk-msg" style="flex:1;text-align:right;font-size:11px;color:#888">最多 25 按钮(5行×5列)</span></div>'
          body += '<div class="dk-msg" id="dk-card-hint" style="color:#2f9e44;margin:2px 0"></div>'
        } else if (state.tab === 'bp') {
          body += sendSubTabs()
          body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:4px 0 2px">🎮 互动事件装配器(/botplay 触发)</div>'
          body += '<div class="dk-row"><span class="dk-msg" style="flex:1">定义事件与按钮 → 保存即热更 → QQ 里发 <b>/botplay 事件名</b> 发卡。点击按钮走 bot 行为(回文本等)并可选影响 AI。</span></div>'
          // 事件列表
          body += '<div class="dk-list" id="dk-bp-list" style="max-height:16vh">'
          if (!state.bpEvents.length) body += '<div class="dk-empty">还没有事件。点「➕ 新建事件」开始装配。</div>'
          state.bpEvents.forEach(function (ev, i) {
            var sel = state.bpSel === i
            var btnN = (ev.buttons || []).length
            var rowc = bpRowCount(ev)
            var overL = rowc.rows > 5
            // 🤖 自定义事件(带 file): 编辑器不适用 → 列表上标出来, 并显示模块文件与加载状态
            var isExt = !!(ev.file && String(ev.file).trim())
            var extSt = isExt ? bpExtOf(ev.file) : null
            var extBad = extSt && extSt.error
            body += '<div class="dk-item" style="cursor:pointer;background:' + (sel ? '#f1ecff' : 'transparent') + '" data-bpidx="' + i + '">'
              + '<span style="flex:1"><b>' + (isExt ? '🤖 ' : '') + esc(ev.name || '(未命名)') + '</b> <span style="color:#888;font-size:11px">/ ' + esc(ev.id || '?') + ' · ' + (isExt
                ? ('AI 模块 ' + esc(String(ev.file)) + (extSt ? (extSt.exists === false ? ' <b style="color:#e03131">文件缺失</b>' : (extBad ? ' <b style="color:#e03131">加载失败</b>' : ' <b style="color:#2f9e44">OK</b>')) : ''))
                : (btnN + ' 按钮·每行' + rowc.per + ' → ' + rowc.rows + '行' + (overL ? ' <b style="color:#e03131">⚠超限</b>' : ''))) + ' · ' + (ev.perm && ev.perm.type ? esc(ev.perm.type) : 'all') + ' · ' + (ev.expireSec || 600) + 's</span></span>'
              + '<button class="dk-btn" data-bp2card="' + i + '" title="把此事件的卡片预设(正文+按钮)复制进「📝 卡片」编辑器">📋</button>'
              + '<button class="dk-btn no" data-bpdel="' + i + '">🗑</button></div>'
          })
          body += '</div>'
          body += '<div class="dk-row"><button class="dk-btn ok" id="dk-bp-new">➕ 新建事件</button>'
          body += '<button class="dk-btn ok" id="dk-bp-save">💾 保存全部(live 热更)</button>'
          body += '<span class="dk-msg" id="dk-bp-hint" style="color:#2f9e44"></span></div>'
          // 🤖🤖 让 AI 写(2026-10-05 主人要求): 描述需求 → 拼成一条消息唤醒当前会话的 AI,
          // 它按契约把模块写进 {dataRoot}/.qqbot-extensions/botplay/ 并登记事件。
          // 走面板既有的"用户代你发送/唤醒 AI"通道(与「让ai写样例库」同一条路, 不新开渠道)。
          body += '<div style="border-top:1px dashed #e2d9ff;margin-top:8px;padding-top:8px">'
          body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:2px 0 2px;color:#4a3a9f">🤖 让 AI 写自定义事件</div>'
          body += '<div class="dk-row"><span class="dk-msg" style="flex:1;font-size:11px;color:#777">直接用大白话描述你想要的互动事件(谁点、点了干什么、谁能点、要不要统计…)，'
            + '点下面按钮就会把你的需求 + QQ 官方接口文档 + 自定义事件契约一起发给<b>当前会话的 AI</b>，由它写成一个模块并登记成 botplay 事件。</span></div>'
          body += '<div class="dk-row" style="align-items:flex-start"><textarea id="dk-bp-req" placeholder="例：我要一个签到人数统计。按钮1 签到，所有人都能点，每人只能点一次；按钮2 结束，只有我能点。我点结束后 bot 在群里发消息，列出签到人数和所有签到者的名字。" style="flex:1;min-height:72px;font-size:12px;font-family:inherit;box-sizing:border-box;padding:6px;border:1px solid #ddd;border-radius:6px;resize:vertical">' + esc(state.bpReq || '') + '</textarea></div>'
          body += '<div class="dk-row"><button class="dk-btn ok" id="dk-bp-aiwrite">🤖 让 AI 写</button>'
            + '<span class="dk-msg" style="flex:1;font-size:11px;color:#888">'
            + (state.detectedHit && state.detectedHit.peerId
              ? ('目标: ' + (state.detectedHit.scope === 'group' ? '群' : '私聊') + '「' + esc(state.detectedHit.name || state.detectedHit.peerId.slice(-6)) + '」(顶栏「当前会话」)')
              : '⚠ 请先把顶栏「当前会话」切到与 bot 的群/私聊 —— 不然不知道把需求发给谁')
            + '</span></div>'
          body += '<div class="dk-msg" id="dk-bp-aihint" style="color:#2f9e44;margin:2px 0 2px">' + esc(state.bpReqHint || '') + '</div>'
          body += '</div>'
          // 编辑器
          if (state.bpDraft) {
            var D = state.bpDraft
            var DIsExt = !!(D.file && String(D.file).trim())
            body += '<div style="border-top:1px dashed #e2d9ff;margin-top:8px;padding-top:8px">'
            if (DIsExt) {
              // ── 自定义事件: **不显示**下面的编辑表单(那些字段对模块驱动的卡片没有意义), 换成模块提示区 ──
              var st = bpExtOf(D.file)
              var mt = st && st.exists && st.mtime ? new Date(st.mtime) : null
              var mtStr = mt ? (mt.getFullYear() + '-' + String(mt.getMonth() + 1).padStart(2, '0') + '-' + String(mt.getDate()).padStart(2, '0') + ' ' + String(mt.getHours()).padStart(2, '0') + ':' + String(mt.getMinutes()).padStart(2, '0') + ':' + String(mt.getSeconds()).padStart(2, '0')) : ''
              body += '<div style="font-weight:700;font-size:12px;margin:2px 0 4px;color:#4a3a9f">🤖 自定义事件（由 AI 写的模块驱动）</div>'
              body += '<div class="dk-row"><span class="dk-msg" style="flex:1;font-size:12px;color:#555">此事件由 AI 编写的 JS 模块驱动，编辑器不适用。'
                + '模块文件位于数据根下的 .qqbot-extensions 目录（插件升级/重装不会覆盖）。</span></div>'
              body += '<div class="dk-row"><span class="dk-msg" style="flex:1;font-size:11px;color:#333;word-break:break-all">'
                + '<b>事件名</b> ' + esc(D.name || '(未命名)') + '　<b>id</b> ' + esc(D.id || '?') + '<br>'
                + '<b>模块文件</b> <code>' + esc(pickPath(st && st.path, state) || '(路径待取)') + '</code><br>'
                + '<b>状态</b> ' + (st
                  ? ((st.exists === false ? '<b style="color:#e03131">文件不存在</b>' : '<b style="color:#2f9e44">文件存在</b>')
                    + (mtStr ? '　最后修改 ' + mtStr : '')
                    + (st.size ? '　' + st.size + ' 字节' : '')
                    + (st.hooks && st.hooks.length ? '　导出: ' + esc(st.hooks.join(',')) : '')
                    + (st.loadedMtime && st.mtime && st.loadedMtime === st.mtime ? '　<b style="color:#2f9e44">已加载</b>' : (st.loadedMtime ? '　<b style="color:#e8590c">已改动, 需重载</b>' : '　<b style="color:#868e96">尚未加载</b>')))
                  : '(插件未就绪或正在读取…)')
                + '</span></div>'
              // 加载失败 / 目录不存在 / 插件未就绪 的错误摘要(红色)
              if (st && st.error) body += '<div class="dk-msg" style="color:#e03131;font-size:11px;word-break:break-all">✗ 模块加载失败: ' + esc(st.error) + '</div>'
              if (state.bpExt && state.bpExt.dirExists === false && state.bpExt.dir) body += '<div class="dk-msg" style="color:#e8590c;font-size:11px">⚠ 扩展目录还不存在: ' + esc(state.bpExt.dir) + '（让 AI 写一个模块时它会自动创建）</div>'
              if (state.bpExt && state.bpExt.note) body += '<div class="dk-msg" style="color:#e8590c;font-size:11px">⚠ ' + esc(state.bpExt.note) + '</div>'
              body += '<div class="dk-row" style="gap:8px">'
                + '<button class="dk-btn ok" id="dk-bp-extreload"' + (state.bpExtBusy ? ' disabled' : '') + ' title="热重载模块: 清掉插件内存里的缓存, 下次发卡/点击就用新代码(不用重启宿主)">🔄 重载模块</button>'
                + '<button class="dk-btn" id="dk-bp-extsrc" title="读取该模块源码(在下面文本域里显示, 可全选复制)">📄 查看源码</button>'
                + '<button class="dk-btn" id="dk-bp-extdir" title="把扩展目录路径复制到剪贴板(方便用编辑器/VSCode 打开)">📁 复制路径</button>'
                + '</div>'
              body += '<div class="dk-msg" id="dk-bp-exthint" style="color:#2f9e44;font-size:11px;margin:2px 0">' + esc(state.bpExtBusy || '') + '</div>'
              if (state.bpSrcText !== undefined && state.bpSrcText !== null) {
                body += '<div class="dk-row" style="align-items:flex-start"><textarea id="dk-bp-src" readonly style="flex:1;min-height:150px;font-size:11px;font-family:monospace;box-sizing:border-box;padding:6px;border:1px solid #ddd;border-radius:6px;resize:vertical">' + esc(state.bpSrcText) + '</textarea></div>'
                body += '<div class="dk-row"><span class="dk-msg" style="flex:1;font-size:11px;color:#888">' + esc(state.bpSrcPath || '') + '　(只读; 想改就让 AI 改, 或自己用编辑器打开)</span><button class="dk-btn" id="dk-bp-srcclose">收起</button></div>'
              }
              body += '<div class="dk-row"><span class="dk-msg" style="flex:1;font-size:11px;color:#777">想让这个事件回到普通编辑器？把事件 JSON 里的 <code>file</code> 字段删掉即可（或让 AI 改）。</span></div>'
              body += '<div class="dk-row"><button class="dk-btn" id="dk-bp-extevents" title="打开 botplay-events.json 所在目录路径(复制到剪贴板)">📋 复制事件文件路径</button>'
                + '<span class="dk-msg" style="flex:1;font-size:11px;color:#888">事件登记: botplay-events.json 里的 <code>' + esc(D.id || '?') + '</code> → file <code>' + esc(String(D.file)) + '</code></span></div>'
              body += '</div>'
            } else {
            body += '<div class="dk-row"><label style="font-size:12px;color:#555;width:56px">事件名</label><input class="qqs-txt" id="dk-bp-name" value="' + esc(D.name) + '" style="flex:1" placeholder="如: 签到"></div>'
            body += '<div class="dk-row"><label style="font-size:12px;color:#555;width:56px">id</label><input class="qqs-txt" id="dk-bp-id" value="' + esc(D.id) + '" style="flex:1" placeholder="英文/数字/_- (触发用)"></div>'
            body += '<div class="dk-row" style="align-items:flex-start"><label style="font-size:12px;color:#555;width:56px;padding-top:4px">卡片正文</label>'
              + '<textarea id="dk-bp-content" placeholder="markdown 模板(可嵌网络图 ![text #宽px #高px](url)); 留空=默认模板(## 🎮 事件名 + 引导)。支持 {name} 占位。" style="flex:1;min-height:64px;font-size:12px;font-family:monospace;box-sizing:border-box;padding:6px;border:1px solid #ddd;border-radius:6px;resize:vertical">' + esc(D.contentText || '') + '</textarea></div>'
            body += '<div class="dk-row"><label style="font-size:12px;color:#555;width:56px">权限</label>'
              + '<select class="qqs-sel" id="dk-bp-perm">' + ['all','triggerer','owner','users'].map(function (p) { return '<option value="' + p + '"' + (D.perm && D.perm.type === p ? ' selected' : '') + '>' + ({ all: '所有人', triggerer: '仅触发者本人(推荐)', owner: '主人白名单', users: '指定openid' }[p]) + '</option>' }).join('') + '</select>'
              + (D.perm && D.perm.type === 'users'
                ? '<input class="qqs-txt" id="dk-bp-users" value="' + esc(((D.perm.userIds) || []).join(', ')) + '" placeholder="指定 openid(逗号分隔)" style="flex:1;min-width:160px">'
                : '')
              + '<label style="font-size:12px;color:#555">有效期(s)</label><input class="qqs-txt" id="dk-bp-expire" type="number" min="30" value="' + (D.expireSec || 600) + '" style="width:70px">'
              + '<label style="font-size:12px;color:#555">总次数(0不限)</label><input class="qqs-txt" id="dk-bp-max" type="number" min="0" value="' + (D.maxClicks || 0) + '" style="width:60px">'
              + '<label style="font-size:12px;color:#555">每行按钮</label><input class="qqs-txt" id="dk-bp-perrow" type="number" min="1" max="5" value="' + (D.buttonsPerRow || 1) + '" style="width:50px" title="每行几个按钮(1~5); QQ 键盘≤5行×每行≤5, 行数=按钮数÷每行"></div>'
            var rowc2 = bpRowCount(D)
            body += '<div style="font-weight:700;font-size:12px;margin:6px 0 2px;color:#4a3a9f">按钮 <span id="dk-bp-layout" style="font-weight:400;color:' + (rowc2.rows > 5 ? '#e03131' : '#2f9e44') + '">共 ' + rowc2.n + ' 个 · 每行 ' + rowc2.per + ' 个 → ' + rowc2.rows + ' 行' + (rowc2.rows > 5 ? '(超 QQ 上限 5 行, 发卡会报错!)' : '(≤5 行 ✅)') + '</span></div>'
            ;(D.buttons || []).forEach(function (b, bi) {
              var bt = (b.botAction && b.botAction.type) || 'reply_text'
              var md = (b.llmEffect && b.llmEffect.mode) || 'no_append'
              var ctx = (b.llmEffect && b.llmEffect.contextText) || ''
              // 视觉隔离: 每加一个按钮, 与上一个之间加一条虚线 + 按钮序号, 一眼分清几组配置
              body += '<div style="font-size:11px;color:#8b7cc7;margin:' + (bi > 0 ? '6px 0 0' : '2px 0 0') + '">── 按钮 ' + (bi + 1) + '</div>'
              body += '<div class="dk-item" style="border:1px solid #f0ecff;border-radius:8px;margin:1px 0;padding:4px 6px">'
                + '<input class="qqs-txt" data-bplabel="' + bi + '" value="' + esc(b.label) + '" placeholder="按钮文字" style="flex:1;min-width:90px">'
                + '<select class="qqs-sel" data-bpact="' + bi + '">' + ['reply_text','jump_url','callback','command'].map(function (t) { return '<option value="' + t + '"' + (bt === t ? ' selected' : '') + '>' + ({ reply_text: '回文本', jump_url: '跳链接', callback: '仅结算', command: '执行命令' }[t]) + '</option>' }).join('') + '</select>'
                + '<select class="qqs-sel" data-bpmode="' + bi + '">' + ['no_append','append_silent','append_wake'].map(function (m) { return '<option value="' + m + '"' + (md === m ? ' selected' : '') + '>' + ({ no_append: '不影响AI', append_silent: '记录不唤醒', append_wake: '记录并唤醒AI' }[m]) + '</option>' }).join('') + '</select>'
                + '<button class="dk-btn no" data-bpdelbtn="' + bi + '">✕</button></div>'
                // 动作参数行: 按类型给出对应输入(jump_url → 链接 URL; command → 命令名; 其余 → 回复文本)
                + (bt === 'jump_url'
                  ? '<input class="qqs-txt" data-bpurl="' + bi + '" value="' + esc((b.botAction && b.botAction.url) || '') + '" placeholder="🔗 链接地址, 如 https://www.baidu.com(QQ 点按钮直接跳转)" style="width:calc(100% - 8px);box-sizing:border-box;margin:0 0 4px 4px">'
                  : '<input class="qqs-txt" data-bpacttext="' + bi + '" value="' + esc((b.botAction && b.botAction.text) || '') + '" placeholder="' + ({ reply_text: '点按钮后 bot 回复的内容', command: '执行的命令名(如 bot-status, 不带/)', callback: '(仅结算, 无需文本)' }[bt] || '') + '" style="width:calc(100% - 8px);box-sizing:border-box;margin:0 0 4px 4px">')
                + '<input class="qqs-txt" data-bpctx="' + bi + '" value="' + esc(ctx) + '" placeholder="(记录/唤醒AI时)对AI说的话, 支持 {name} 事件名 {label} 按钮名; 空=默认" style="width:calc(100% - 8px);box-sizing:border-box;margin:0 0 2px 4px">'
            })
            body += '<div class="dk-row"><button class="dk-btn" id="dk-bp-addbtn">➕ 加按钮</button>'
              + '<span class="dk-msg" id="dk-bp-addmsg">每行 ' + rowc2.per + ' 个 × 最多 5 行 = 上限 ' + (rowc2.per * 5) + ' 个(QQ 键盘: ≤5行 × 每行≤5)</span></div>'
            body += '</div>'
            }
          }
        }
        body += status
        body += '<div class="dk-row" style="border-top:1px solid #f0ecff;padding-top:8px;margin-top:8px"><span class="dk-msg">登记群(官方无群列表,手动粘贴):</span>'
          + '<input class="qqs-txt" id="dk-bindgid" placeholder="group_openid" value="' + esc(state.bindGid) + '" style="width:200px">'
          + '<input class="qqs-txt" id="dk-bindname" placeholder="备注(可选)" value="' + esc(state.bindName) + '" style="width:110px">'
          + '<button class="dk-btn" id="dk-bind">绑定</button></div>'
        b.innerHTML = body
        // ★ 2026-10-26：扩展页签的卡片在 DOM 写入之后才挂（Shadow DOM 需要真实容器）
        if (String(state.tab || '').indexOf('ext:') === 0) {
          try {
            var extHost = b.querySelector('#qqs-dock-ext-host')
            if (extHost) mountDockCard(extHost, String(state.tab).slice(4))
          } catch (e) { /* 扩展崩了不该影响面板 */ }
        }
        bindBodyEvents()
        bindPanelDrag()
        if (state.tab === 'send') applyTargetFilter(panel, state)
        if (state.tab === 'chat') renderChatList()
        if (state.tab === 'join') renderJoinList()
        if (state.tab === 'mute') {
          if ((state.hammerSub || 'mute') === 'kick') {
            // 首次进踢人页：先查一次登录状态（qunLogged 为 null 表示还没查过，查完会被置成 true/false，不会循环）
            if (state.qunLogged === null) loadQunStatus(true)
            renderQunMemberList()
          } else {
            renderMemberList(); renderMuteList()
          }
        }
        if (state.tab === 'roster' || state.tab === 'send') { renderRosterList(); bindRosterEvents(); loadHubState(); loadBroadcastTasks(false, true) }
        // 📝 卡片: 必须在 paintBody 内绑定(2026-09-10 修复: 原在 tab 点击处先 bind 后 paintBody,
        // 绑的是即将被替换的旧 DOM → 发送/存为事件无反应、预览不渲染)
        if (state.tab === 'card') bindCardEvents()
        if (state.tab === 'session') bindLocalModel()   // ⚠️ 只绑定: 加载由切 tab 时触发(防重绘循环)
        // 📤 广播子页: 绑定群发按钮 + 刷新任务列表(任务列表静默拉取, 不重绘 → 防死循环)
        if (state.tab === 'broadcast') { bindBroadcastEvents(); loadBroadcastTasks(false, true); startBroadcastAdvance() }
        // 分组(host 持久化, 与 AI 共用): 进选目标/广播页时拉一次, 保证多浏览器与 AI 侧看到的是同一份
        if (state.tab === 'roster' || state.tab === 'broadcast') loadTgGroupsFromHost()
        // 注: 📤 群发子标签栏的点击绑定由上面 bindBodyEvents() 统一处理(它含 [data-subtab])
        // 首次进入聊天 tab 自动拉最新一页
        if (state.tab === 'chat' && !state.chatItems.length && !state.chatBusy) loadChat(true)
        setTimeout(layoutPanel, 0)
      }
      // ── 🔨 锤子 · 踢人（2026-10-02 主人定）──
      //   登录态与 AI **共享**：两边读写同一个 {dataRoot}/qun-cookie.json，
      //   所以面板登录完 AI 立刻能用、AI 登录完面板也立刻显示已登录。
      // ── 🔨 锤子 · 自动撤回（2026-10-20 主人定）──
      function hammerAutoRecallHtml() {
        var kinds = [['text', '文本'], ['image', '图片'], ['voice', '语音'], ['video', '视频'], ['file', '文件']]
        var box = kinds.map(function (k) {
          return '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" id="dk-ar-k-' + k[0] + '"' + (state.arKinds.indexOf(k[0]) >= 0 ? ' checked' : '') + '> ' + k[1] + '</label>'
        }).join('')
        return '<div class="dk-row" style="gap:8px;flex-wrap:wrap">'
          + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" id="dk-ar-on"' + (state.arOn ? ' checked' : '') + '> 启用自动撤回</label>'
          + '<span style="font-size:12px;color:#666">命中后:</span>'
          + '<select id="dk-ar-mode" style="font-size:12px;padding:2px 4px">'
          + '<option value="keep"' + (state.arMode !== 'drop' ? ' selected' : '') + '>仍进 AI（只撤回聊天记录）</option>'
          + '<option value="drop"' + (state.arMode === 'drop' ? ' selected' : '') + '>直接吞掉（AI 也不看）</option>'
          + '</select>'
          + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px" title="只记日志, 不真撤"><input type="checkbox" id="dk-ar-dry"' + (state.arDry ? ' checked' : '') + '> 演练</label>'
          + '</div>'
          + '<div style="font-weight:700;font-size:13px;margin:8px 0 4px">① 关键词（一行一个，命中任一即撤）</div>'
          + '<textarea id="dk-ar-kws" rows="4" style="width:100%;box-sizing:border-box;font-size:12px;padding:6px;border:1px solid #e2d9ff;border-radius:6px" placeholder="例如：加我微信">' + (state.arKws || '') + '</textarea>'
          + '<div style="font-weight:700;font-size:13px;margin:8px 0 4px">② 按附件类型（勾上=这类消息直接被撤）</div>'
          + '<div class="dk-row" style="gap:10px;flex-wrap:wrap">' + box + '</div>'
          + '<div class="dk-row" style="gap:8px;margin-top:8px;align-items:center">'
          + '<span style="font-size:12px;color:#666">顺带禁言 <input type="number" id="dk-ar-mute" min="0" value="' + (state.arMute || 0) + '" style="width:64px;font-size:12px;padding:2px 4px"> 秒（0=不禁言）</span>'
          + '<button class="dk-btn ok" id="dk-ar-save" style="margin-left:auto">💾 保存</button>'
          + '</div>'
          + '<div class="dk-msg" style="line-height:1.5;color:#888">执行点在「入站扩展之后」：选"仍进 AI"=扩展与 AI 都照常收到、只是聊天记录里消失；选"直接吞掉"=扩展照常执行、但这条不进 AI。机器人需为群管理员，且官方撤回窗口只有 2 分钟。</div>'
          + '<div class="dk-msg" id="dk-ar-hint" style="color:#2f9e44">' + (state.arMsg || '') + '</div>'
      }
      function hammerKickHtml() {
        if (state.qunLogged !== true) {
          var h = '<div class="dk-msg">踢人需要先登录 QQ 群管理（扫码一次，之后长期免扫；登录态与 AI 共享）。</div>'
          h += '<div class="dk-row" style="gap:6px;align-items:center">'
            + '<button class="dk-btn ok" id="dk-qun-login"' + (state.qunBusy ? ' disabled' : '') + '>'
            + (state.qunBusy ? '⏳ 处理中…' : '📱 刷新二维码') + '</button>'
            + '<button class="dk-btn" id="dk-qun-status">🔄 查登录状态</button>'
            + '</div>'
          if (state.qunQr) {
            h += '<div class="dk-row" style="justify-content:center;margin:8px 0">'
              + '<img src="api/qqbot-settings/qun-qr?t=' + Date.now() + '" alt="二维码" '
              + 'style="width:230px;height:230px;border:1px solid #e2d9ff;border-radius:8px;background:#fff;object-fit:contain">'
              + '</div>'
              + '<div class="dk-msg" style="text-align:center">用手机 QQ「扫一扫」，摄像头对着<b>这块屏幕</b>扫'
              + '（腾讯只认摄像头；相册 / 长按识别会被拒）</div>'
          }
          if (state.qunMsg) h += '<div class="dk-msg">' + esc(state.qunMsg) + '</div>'
          return h
        }
        var groups = state.qunGroups || []
        var opts = groups.map(function (g) {
          return '<option value="' + esc(g.gc) + '"' + (g.gc === state.qunGc ? ' selected' : '') + '>'
            + esc(g.gn || g.gc) + '（' + esc(g.role || '') + '）</option>'
        }).join('')
        var out = '<div class="dk-row" style="gap:6px;flex-wrap:wrap;align-items:center">'
          + '<span style="font-size:12px;color:#666">群:</span>'
          + '<select class="qqs-sel" id="dk-qun-gc" style="min-width:200px">' + (opts || '<option value="">（没有可管理的群）</option>') + '</select>'
          + '<input class="qqs-txt" id="dk-qun-kw" placeholder="uin 或昵称（留空=全量）" value="' + esc(state.qunKw || '') + '" style="width:170px">'
          + '<button class="dk-btn" id="dk-qun-search">🔍 搜索成员</button>'
          + '<button class="dk-btn no" id="dk-qun-logout" title="清掉本地凭据（下次要重新扫码）">🚪 退出登录</button>'
          + '</div>'
        out += '<div class="dk-msg">✅ 已登录 uin=' + esc(state.qunUin || '?')
          + (state.qunCount ? ' · 该群共 ' + state.qunCount + ' 人' : '') + '</div>'
        out += '<div class="dk-list" id="dk-qun-member-list"></div>'
        return out
      }
      function renderQunMemberList() {
        var box = panel.querySelector('#dk-qun-member-list')
        if (!box) return
        var ms = state.qunMembers || []
        if (state.qunLoading) { box.innerHTML = '<div class="dk-empty">加载中…</div>'; return }
        if (!ms.length) { box.innerHTML = '<div class="dk-empty">还没有成员数据 —— 点「🔍 搜索成员」拉取</div>'; return }
        box.innerHTML = ms.map(function (m) {
          return '<div style="display:flex;align-items:center;gap:8px;padding:4px 2px;border-bottom:1px solid #f0ebff">'
            + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(m.nick || '(无昵称)') + '</span>'
            + '<span style="flex:none;font-family:monospace;font-size:11px;color:#888">' + esc(m.uin) + '</span>'
            + '<button class="dk-btn no" style="flex:none" data-kick="' + esc(m.uin) + '" data-knick="' + esc(m.nick || '') + '">👢 踢</button>'
            + '</div>'
        }).join('')
        box.querySelectorAll('button[data-kick]').forEach(function (btn) {
          btn.onclick = function () {
            var uin = btn.getAttribute('data-kick')
            var nick = btn.getAttribute('data-knick') || uin
            if (!window.confirm('确定把「' + nick + '」(uin ' + uin + ') 移出群 ' + state.qunGc + ' ？')) return
            doQunKick([uin])
          }
        })
      }
      function loadQunStatus(repaint) {
        api('qun/status').then(function (d) {
          state.qunLogged = !!(d && d.logged)
          if (d && d.uin) state.qunUin = d.uin
          if (d && d.groups && d.groups.length) {
            state.qunGroups = d.groups
            var has = d.groups.some(function (g) { return g.gc === state.qunGc })
            if (!state.qunGc || !has) state.qunGc = d.groups[0].gc
          }
          if (repaint) paintBody()
        }).catch(function () { state.qunLogged = false; if (repaint) paintBody() })
      }
      function doQunLogin() {
        state.qunBusy = true; state.qunMsg = ''
        paintBody()
        apiPost('qun/login', {}).then(function (d) {
          state.qunBusy = false
          if (d && d.logged) {
            state.qunLogged = true; state.qunUin = d.uin || ''
            state.qunMsg = '✅ 已登录（免扫码）'
            loadQunStatus(false); paintBody()
            return
          }
          state.qunQr = !!(d && d.needScan)
          state.qunMsg = (d && d.msg) || (state.qunQr ? '' : '没能生成二维码')
          paintBody()
          if (state.qunQr) startQunPoll()
        }).catch(function (e) { state.qunBusy = false; state.qunMsg = '异常: ' + e.message; paintBody() })
      }
      var qunPollTimer = null
      function startQunPoll() {
        if (qunPollTimer) return
        qunPollTimer = setInterval(function () {
          api('qun/poll').then(function (d) {
            if (d && d.logged) {
              clearInterval(qunPollTimer); qunPollTimer = null
              state.qunLogged = true; state.qunUin = d.uin || ''
              state.qunQr = false; state.qunMsg = '✅ 登录成功'
              loadQunStatus(false); paintBody()
            }
          }).catch(function () { /* ignore */ })
        }, 2500)
      }
      function doQunKick(uins) {
        state.qunMsg = '正在踢…'
        paintBody()
        apiPost('qun/kick', { gc: state.qunGc, uins: uins }).then(function (d) {
          var rs = (d && d.results) || []
          state.qunMsg = (d && d.msg ? d.msg : '完成') + '：' + rs.map(function (x) {
            return x.uin + (x.ec === 0 ? ' ✅' : ' ❌' + x.msg)
          }).join('；')
          loadQunMembers()
        }).catch(function (e) { state.qunMsg = '踢人异常: ' + e.message; paintBody() })
      }
      function loadQunMembers() {
        if (!state.qunGc) { state.qunMsg = '先选一个群'; paintBody(); return }
        state.qunLoading = true
        paintBody()
        // ⚠️ api(path, q) 的 q 是**字符串 query**，不是对象（传对象会变成 ?[object Object]）
        var qs = 'gc=' + encodeURIComponent(state.qunGc) + '&q=' + encodeURIComponent(state.qunKw || '')
        api('qun/members', qs).then(function (d) {
          state.qunLoading = false
          if (d && d.ok) {
            state.qunMembers = d.members || []
            state.qunCount = d.count || 0
            state.qunMsg = '共拉取 ' + state.qunMembers.length + ' 人' + (d.note ? '（' + d.note + '）' : '')
          } else {
            state.qunMembers = []
            state.qunMsg = (d && d.error) || '加载失败'
          }
          paintBody()
        }).catch(function (e) { state.qunLoading = false; state.qunMsg = '异常: ' + e.message; paintBody() })
      }

      function bindBodyEvents() {
        // ── 🚫 无上下文模式（2026-09-27）──
        // 照抄本文件既有模式：paintBody() 渲染完 → 调 bindBodyEvents() 统一绑事件
        // （DOM 每次重绘都是新的，所以必须绑在"渲染后"，而不是 loadCtxless 里）。
        var ctxSaveBtn = panel.querySelector('#dk-ctxless-save')
        if (ctxSaveBtn) ctxSaveBtn.onclick = function () { saveCtxless() }
        var ctxOnBox = panel.querySelector('#dk-ctxless-on')
        if (ctxOnBox) ctxOnBox.onchange = function () { saveCtxless() }
        if (state.tab === 'session' && (state.stTab || 'lm') === 'cl') loadCtxless()
        // 🔨 锤子 · 子标签 + 踢人页按钮（2026-10-02）
        panel.querySelectorAll('[data-hsub]').forEach(function (sb) {
          sb.onclick = function () {
            state.hammerSub = sb.getAttribute('data-hsub')
            paintBody()
          }
        })
        // 🔨 自动撤回 · 保存（2026-10-20）
        var arSaveBtn = panel.querySelector('#dk-ar-save')
        if (arSaveBtn) arSaveBtn.onclick = function () {
          var kv = panel.querySelector('#dk-ar-kws')
          state.arKws = kv ? kv.value : ''
          var on = panel.querySelector('#dk-ar-on'); state.arOn = on ? on.checked : false
          var md = panel.querySelector('#dk-ar-mode'); state.arMode = (md && md.value === 'drop') ? 'drop' : 'keep'
          var dr = panel.querySelector('#dk-ar-dry'); state.arDry = dr ? dr.checked : false
          var mu = panel.querySelector('#dk-ar-mute')
          state.arMute = Math.max(0, parseInt(mu ? mu.value : '0', 10) || 0)
          var arr = []
          ;['text', 'image', 'voice', 'video', 'file'].forEach(function (k) {
            var el = panel.querySelector('#dk-ar-k-' + k)
            if (el && el.checked) arr.push(k)
          })
          state.arKinds = arr
          state.arMsg = '保存中…'
          saveGroupAdmin()
        }
        var qLoginBtn = panel.querySelector('#dk-qun-login')
        if (qLoginBtn) qLoginBtn.onclick = function () { doQunLogin() }
        var qStatusBtn = panel.querySelector('#dk-qun-status')
        if (qStatusBtn) qStatusBtn.onclick = function () { state.qunMsg = '正在查询…'; paintBody(); loadQunStatus(true) }
        var qSearchBtn = panel.querySelector('#dk-qun-search')
        if (qSearchBtn) {
          qSearchBtn.onclick = function () {
            var kwEl = panel.querySelector('#dk-qun-kw')
            state.qunKw = kwEl ? kwEl.value : state.qunKw
            loadQunMembers()
          }
        }
        var qGcSel = panel.querySelector('#dk-qun-gc')
        if (qGcSel) {
          qGcSel.onchange = function () { state.qunGc = qGcSel.value; loadQunMembers() }
        }
        var qLogoutBtn = panel.querySelector('#dk-qun-logout')
        if (qLogoutBtn) {
          qLogoutBtn.onclick = function () {
            if (!window.confirm('清掉本地登录凭据？下次要重新扫码。')) return
            apiPost('qun/logout', {}).then(function () {
              state.qunLogged = false; state.qunUin = ''; state.qunMembers = []
              state.qunGroups = []; state.qunGc = ''; state.qunMsg = '已退出登录'
              paintBody()
            }).catch(function () { state.qunLogged = false; paintBody() })
          }
        }
        var tbs = panel.querySelectorAll('.dk-tab button')
        tbs.forEach(function (btn) {
          btn.onclick = function () {
            state.tab = btn.getAttribute('data-t'); state.msg = ''
            if (state.tab === 'join') loadJoins(); else if (state.tab === 'mute') loadMutes()
            else if (state.tab === 'out') loadOutMode()
            else if (state.tab === 'session') { loadLocalModel(); bindLocalModel() }
            else if (state.tab === 'bp') loadBotplay()
            else if (state.tab === 'chat') { state.chatItems = []; state.chatErr = ''; }
            paintBody()
          }
        })
        // 📤 群发 · 次级标签切换(2026-09-10)
        panel.querySelectorAll('[data-subtab]').forEach(function (sb) {
          sb.onclick = function () {
            var v = sb.getAttribute('data-subtab')
            state.tab = v; state.msg = ''
            if (v === 'bp') loadBotplay()
            paintBody()
          }
        })
        var gsel = panel.querySelector('#dk-gid')
        if (gsel) gsel.onchange = function (e) {
          state.gid = e.target.value; state.msg = ''
          if (state.tab === 'join') loadJoins(); else if (state.tab === 'mute') loadMutes()
          else if (state.tab === 'chat') { state.chatItems = []; state.chatErr = ''; state.chatBusy = ''; paintBody(); loadChat(true) }
          else paintBody()
        }
        var rads = panel.querySelectorAll('input[name="dk-scope"]')
        rads.forEach(function (r) {
          r.onchange = function () {
            state.sendScope = r.value; state.msg = ''
            if (r.value !== 'c2c') state.sendTo = ''
            if (state.tab === 'chat') { state.chatItems = []; state.chatErr = ''; state.chatBusy = ''; paintBody(); loadChat(true) }
            else paintBody()
          }
        })
        var c2c = panel.querySelector('#dk-c2c')
        if (c2c) c2c.onchange = function (e) {
          state.sendTo = e.target.value; state.msg = ''
          if (state.tab === 'chat') { state.chatItems = []; state.chatErr = ''; state.chatBusy = ''; paintBody(); loadChat(true) }
          else paintBody()
        }
        var srch = panel.querySelector('#dk-target-search')
        if (srch) srch.oninput = function (e) { state.targetQ = e.target.value; applyTargetFilter(panel, state) }
        var txt = panel.querySelector('#dk-text')
        if (txt) { txt.oninput = function (e) { state.sendText = e.target.value; var n = panel.querySelector('.dk-msg'); if (n) n.textContent = '已输 ' + state.sendText.length + '/2000' } }
        var ins = panel.querySelector('#dk-insctx')
        if (ins) { ins.onchange = function (e) { state.insertCtx = !!e.target.checked } }
        var omrad = panel.querySelectorAll('input[name="dk-outmode"]')
        if (omrad) omrad.forEach(function (r2) { r2.onchange = function () { saveOutMode(r2.value) } })
        var snd = panel.querySelector('#dk-send')
        if (snd) snd.onclick = sendNow
        var rj = panel.querySelector('#dk-refresh-join')
        if (rj) rj.onclick = loadJoins
        var rm = panel.querySelector('#dk-refresh-mute')
        if (rm) rm.onclick = loadMutes
        var crf = panel.querySelector('#dk-chat-refresh')
        if (crf) crf.onclick = function () { state.chatItems = []; state.chatErr = ''; state.chatBusy = ''; loadChat(true) }
        var cbox = panel.querySelector('#dk-chat-box')
        // 「↓ 最新」跳转按钮（2026-10-04 主人要求）：往上翻历史后一键回到最新。
        //   显示条件 = 距底部超过 40px；点一下滚到底、并顺手拉一次更新的消息。
        var jumpLatest = function () {
          var b = panel.querySelector('#dk-chat-box')
          var jb = panel.querySelector('#dk-jump-latest')
          if (b) { b.scrollTop = b.scrollHeight }
          if (jb) jb.classList.remove('on')
          if (state.tab === 'chat' && !state.chatBusy) { try { loadChatNewer() } catch (e) { /* 还没加载过也没关系 */ } }
        }
        var syncJumpLatest = function (b) {
          try {
            var jb = panel.querySelector('#dk-jump-latest')
            if (!jb || !b) return
            if ((b.scrollHeight - b.scrollTop - b.clientHeight) > 40) jb.classList.add('on')
            else jb.classList.remove('on')
          } catch (e) { /* ignore */ }
        }
        if (cbox) cbox.onscroll = function () {
          // ⚠️ 必须放在下面的 early return **之前** —— 否则 tab 不是 chat / 加载中就永远不显示按钮
          syncJumpLatest(cbox)
          if (state.tab !== 'chat' || !state.chatMore || state.chatBusy) return
          if (cbox.scrollTop <= 4) loadChat(false) // 顶部 → 加载更早
        }
        var jbtn = panel.querySelector('#dk-jump-latest')
        if (jbtn) jbtn.onclick = jumpLatest
        // 2026-10-01 主人要求：「滚轮向下滚一次就刷新一下」——**不管有没有滚动成功**
        //   （已经停在底部也刷：方便随时确认有没有新消息，比每个来回点 🔄 刷新省事）。
        //   向上滚不拦（交给上面的"到顶部加载更早"，两个功能不打架）。
        //   ⚠️ 一次滚轮会连发多个 wheel 事件 → 按 400ms 时间窗合并成一次，避免刷爆；
        //   ⚠️ 加载中(busy)直接跳过，别打断正在进行的请求。
        if (cbox) cbox.onwheel = function (e) {
          if (state.tab !== 'chat') return
          if (e && e.deltaY <= 0) return
          var now = Date.now()
          if (now - (state.chatWheelAt || 0) < 400) return
          state.chatWheelAt = now
          if (state.chatBusy) return
          loadChatNewer()   // ★ 增量: 只把新消息接在下面, 不重绘不闪不跳位置
        }
        var cinput = panel.querySelector('#dk-chat-input')
        if (cinput) {
          cinput.oninput = function (e) {
            state.chatText = e.target.value
            var n = panel.querySelector('#dk-chat-cnt'); if (n) n.textContent = state.chatText.length + '/2000'
            if (state.sendScope !== 'c2c') chatAtScan() // 输入 @ 弹成员候选
          }
          cinput.onkeydown = function (e) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (atM.open) {
                e.preventDefault()
                var lst = chatAtList()
                if (lst.length) { atM.idx = (atM.idx + (e.key === 'ArrowDown' ? 1 : -1) + lst.length) % lst.length; chatAtRender() }
              }
              return
            }
            if (e.key === 'Enter') {
              if (atM.open) {
                var l2 = chatAtList()
                if (l2.length) { e.preventDefault(); chatAtPick(l2[atM.idx >= l2.length ? 0 : atM.idx].mid); return }
              }
              if (!e.shiftKey) { e.preventDefault(); chatSend('auto') }
              return
            }
            if (e.key === 'Escape' && atM.open) { chatAtClose(); return }
          }
          // 粘贴/拖拽图片 → 自动转 [MEDIA:kind|来源] 追加进文本框(有本机路径直用, 否则小文件上传到 dock-uploads)
          cinput.onpaste = function (e) {
            var files = (e.clipboardData && e.clipboardData.files) ? Array.from(e.clipboardData.files) : []
            // 截图/复制位图时 clipboardData.files 常为空 → 从 items 里捞图片
            if (!files.length && e.clipboardData && e.clipboardData.items) {
              for (var i = 0; i < e.clipboardData.items.length; i++) {
                var it = e.clipboardData.items[i]
                if (it.kind === 'file' || String(it.type).indexOf('image/') === 0) {
                  var f = (it.getAsFile && it.getAsFile()) || null
                  if (f) files.push(f)
                }
              }
            }
            if (files.length) { e.preventDefault(); chatIngestFiles(files) }
          }
          cinput.addEventListener('dragover', function (e) { e.preventDefault() })
          cinput.ondrop = function (e) {
            e.preventDefault()
            var files = (e.dataTransfer && e.dataTransfer.files) ? Array.from(e.dataTransfer.files) : []
            if (files.length) chatIngestFiles(files)
          }
        }
        // 群聊目标: 预热 @ 成员表(输入 @ 时已缓存)
        if (state.sendScope !== 'c2c' && state.gid) chatLoadAtMembers()
        else chatAtClose()
        var cins = panel.querySelector('#dk-chat-ins')
        if (cins) cins.onclick = function () { state.chatIns = !state.chatIns; cins.textContent = '🧠 ' + (state.chatIns ? '记入上下文' : '不记上下文') }
        var csend = panel.querySelector('#dk-chat-send')
        if (csend) csend.onclick = function () { chatSend('auto') }
        var fadd = panel.querySelector('#dk-chat-add-file')
        var fpick = panel.querySelector('#dk-chat-file')
        if (fadd && fpick) fadd.onclick = function () { fpick.value = ''; fpick.click() }
        if (fpick) fpick.onchange = function () { var files = Array.from(fpick.files || []); if (files.length) chatIngestFiles(files, true) }
        var iadd = panel.querySelector('#dk-chat-add-img')
        if (iadd) iadd.onclick = function () {
          // 弹小窗输入本机路径或网络图片 → 插入 [MEDIA:image|src](追加, 不清空已有文本)
          var src = window.prompt('输入图片来源: 本机绝对路径(D:\\xxx\\a.jpg) 或 http(s) 图片地址', '')
          if (src === null) return
          src = String(src || '').trim()
          if (!src) return
          chatInsertMedia('image', src)
        }
        var bd = panel.querySelector('#dk-bind')
        if (bd) bd.onclick = function () { state.bindGid = (panel.querySelector('#dk-bindgid') || {}).value || ''; state.bindName = (panel.querySelector('#dk-bindname') || {}).value || ''; doBind() }
        // ── 🎮 互动事件装配器: 列表选择/删除/新建/保存/编辑器字段 ──
        var bpList = panel.querySelector('#dk-bp-list')
        if (bpList) bpList.querySelectorAll('[data-bpidx]').forEach(function (it) {
          it.onclick = function () {
            var idx = Number(it.getAttribute('data-bpidx'))
            state.bpSel = idx
            state.bpDraft = JSON.parse(JSON.stringify(state.bpEvents[idx] || {}))
            paintBody()
          }
        })
        bpList && bpList.querySelectorAll('[data-bpdel]').forEach(function (b) {
          b.onclick = function (e) {
            e.stopPropagation()
            var idx = Number(b.getAttribute('data-bpdel'))
            state.bpEvents.splice(idx, 1)
            if (state.bpSel === idx) { state.bpSel = null; state.bpDraft = null }
            else if (state.bpSel !== null && state.bpSel > idx) state.bpSel -= 1
            paintBody()
          }
        })
        // 📋 事件 → 卡片编辑器(2026-09-10 主人要求): 把事件的正文预设+按钮复制进「📝 卡片」, 便于改完再发
        bpList && bpList.querySelectorAll('[data-bp2card]').forEach(function (b) {
          b.onclick = function (e) {
            e.stopPropagation()
            var idx = Number(b.getAttribute('data-bp2card'))
            var ev = state.bpEvents[idx]
            if (!ev) return
            // 正文: 事件自定义 contentText; 空则用事件默认模板
            state.cardMd = (ev.contentText && String(ev.contentText).trim())
              ? String(ev.contentText)
              : ('## 🎮 ' + (ev.name || '互动事件') + '\n\n点下方按钮完成互动 👇')
            // 按钮 → 卡片编辑器的文本格式(**显式带类型后缀**, 三种动作都能无损搬过来):
            //   jump_url → 文字|网址|url　command → 文字|指令|cmd　reply_text → 文字|文本|text
            state.cardBtns = (ev.buttons || []).map(function (bb) {
              var act = (bb && bb.botAction) || {}
              var label = (bb && bb.label) || '按钮'
              if (act.type === 'jump_url') return label + '|' + String(act.url || '') + '|url'
              if (act.type === 'command') return label + '|' + String(act.text || '').replace(/^\//, '') + '|cmd'
              return label + '|' + String(act.text || '') + '|text'
            }).join('\n')
            state.tab = 'card'
            paintBody()
            setTimeout(function () {
              var h = panel.querySelector('#dk-card-hint')
              if (h) h.textContent = '📋 已从事件「' + (ev.name || '') + '」载入预设(正文 ' + state.cardMd.length + ' 字 / 按钮 ' + (ev.buttons || []).length + ' 个) — 可直接发送, 也可改完再发'
            }, 0)
          }
        })
        var bpNew = panel.querySelector('#dk-bp-new')
        if (bpNew) bpNew.onclick = function () {
          state.bpSel = null
          state.bpDraft = { id: '', name: '', contentText: '', maxClicks: 0, expireSec: 600, buttonsPerRow: 1, perm: { type: 'all', userIds: [] }, buttons: [{ id: 'b1', label: '按钮', botAction: { type: 'reply_text', text: '' }, llmEffect: { mode: 'no_append', contextText: '' } }] }
          paintBody()
        }
        // 编辑器字段(名称/id/有效期/总次数/权限)
        var bpName = panel.querySelector('#dk-bp-name')
        if (bpName) bpName.oninput = function (e) { state.bpDraft.name = e.target.value }
        var bpId = panel.querySelector('#dk-bp-id')
        if (bpId) bpId.oninput = function (e) { state.bpDraft.id = e.target.value.trim() }
        var bpContent = panel.querySelector('#dk-bp-content')
        if (bpContent) bpContent.oninput = function (e) { state.bpDraft.contentText = e.target.value }
        var bpPerm = panel.querySelector('#dk-bp-perm')
        if (bpPerm) bpPerm.onchange = function (e) {
          state.bpDraft.perm = state.bpDraft.perm || {}
          state.bpDraft.perm.type = e.target.value
          paintBody() // users 档要显示 openid 输入框
        }
        var bpUsers = panel.querySelector('#dk-bp-users')
        if (bpUsers) bpUsers.oninput = function (e) {
          state.bpDraft.perm = state.bpDraft.perm || {}
          state.bpDraft.perm.userIds = String(e.target.value || '').split(/[,，\s]+/).map(function (s) { return s.trim() }).filter(Boolean)
        }
        var bpExpire = panel.querySelector('#dk-bp-expire')
        if (bpExpire) bpExpire.oninput = function (e) { state.bpDraft.expireSec = Math.max(30, Number(e.target.value) || 600) }
        var bpMax = panel.querySelector('#dk-bp-max')
        if (bpMax) bpMax.oninput = function (e) { state.bpDraft.maxClicks = Math.max(0, Number(e.target.value) || 0) }
        var bpPerRow = panel.querySelector('#dk-bp-perrow')
        if (bpPerRow) bpPerRow.oninput = function (e) { state.bpDraft.buttonsPerRow = Math.max(1, Math.min(5, Math.round(Number(e.target.value)) || 1)); bpLayoutHint() }
        // 按钮行编辑(label/botAction.type/llmEffect.mode/删除/回复文本/对AI说的话)
        var bpBtns = panel.querySelectorAll('[data-bplabel]')
        bpBtns.forEach(function (inp) {
          var bi = Number(inp.getAttribute('data-bplabel'))
          inp.oninput = function (e) {
            state.bpDraft.buttons[bi].label = e.target.value
            if (!state.bpDraft.buttons[bi].id) state.bpDraft.buttons[bi].id = 'b' + (bi + 1)
          }
        })
        var bpActs = panel.querySelectorAll('[data-bpact]')
        bpActs.forEach(function (sel) {
          var bi = Number(sel.getAttribute('data-bpact'))
          sel.onchange = function (e) {
            state.bpDraft.buttons[bi].botAction = state.bpDraft.buttons[bi].botAction || {}
            state.bpDraft.buttons[bi].botAction.type = e.target.value
          }
        })
        var bpModes = panel.querySelectorAll('[data-bpmode]')
        bpModes.forEach(function (sel) {
          var bi = Number(sel.getAttribute('data-bpmode'))
          sel.onchange = function (e) {
            state.bpDraft.buttons[bi].llmEffect = state.bpDraft.buttons[bi].llmEffect || {}
            state.bpDraft.buttons[bi].llmEffect.mode = e.target.value
          }
        })
        var bpTexts = panel.querySelectorAll('[data-bpacttext]')
        bpTexts.forEach(function (inp) {
          var bi = Number(inp.getAttribute('data-bpacttext'))
          inp.oninput = function (e) {
            state.bpDraft.buttons[bi].botAction = state.bpDraft.buttons[bi].botAction || {}
            state.bpDraft.buttons[bi].botAction.text = e.target.value
          }
        })
        // 跳链接按钮的 URL 输入
        var bpUrls = panel.querySelectorAll('[data-bpurl]')
        bpUrls.forEach(function (inp) {
          var bi = Number(inp.getAttribute('data-bpurl'))
          inp.oninput = function (e) {
            state.bpDraft.buttons[bi].botAction = state.bpDraft.buttons[bi].botAction || {}
            state.bpDraft.buttons[bi].botAction.url = e.target.value
          }
        })
        var bpCtxs = panel.querySelectorAll('[data-bpctx]')
        bpCtxs.forEach(function (inp) {
          var bi = Number(inp.getAttribute('data-bpctx'))
          inp.oninput = function (e) {
            state.bpDraft.buttons[bi].llmEffect = state.bpDraft.buttons[bi].llmEffect || {}
            state.bpDraft.buttons[bi].llmEffect.contextText = e.target.value
          }
        })
        var bpDelBtn = panel.querySelectorAll('[data-bpdelbtn]')
        bpDelBtn.forEach(function (b) {
          b.onclick = function () {
            state.bpDraft.buttons.splice(Number(b.getAttribute('data-bpdelbtn')), 1)
            paintBody()
          }
        })
        var bpAddBtn = panel.querySelector('#dk-bp-addbtn')
        if (bpAddBtn) bpAddBtn.onclick = function () {
          var cap = Math.max(1, Math.min(5, Math.round(Number(state.bpDraft.buttonsPerRow)) || 1)) * 5
          if (state.bpDraft.buttons.length >= cap) return
          state.bpDraft.buttons.push({ id: 'b' + (state.bpDraft.buttons.length + 1), label: '按钮', botAction: { type: 'reply_text', text: '' }, llmEffect: { mode: 'no_append', contextText: '' } })
          paintBody()
        }
        var bpSave = panel.querySelector('#dk-bp-save')
        if (bpSave) bpSave.onclick = saveBotplay

        // ── 🤖 让 AI 写(2026-10-05): 需求文本域 + 按钮 ──
        var bpReq = panel.querySelector('#dk-bp-req')
        if (bpReq) bpReq.oninput = function (e) { state.bpReq = e.target.value }
        var bpAi = panel.querySelector('#dk-bp-aiwrite')
        if (bpAi) bpAi.onclick = letAiWriteBotplay
        // ── 🤖 自定义事件: 重载模块 / 看源码 / 复制路径 ──
        var bpReload = panel.querySelector('#dk-bp-extreload')
        if (bpReload) bpReload.onclick = function () {
          var f = state.bpDraft && state.bpDraft.file ? String(state.bpDraft.file) : ''
          var eh = panel.querySelector('#dk-bp-exthint')
          state.bpExtBusy = '重载中…'
          if (eh) eh.textContent = '重载中…'
          apiPost('group/botplay-ext/reload', { ns: state.ns || 'im-qqbot', file: f }).then(function (d) {
            state.bpExtBusy = ''
            if (eh) eh.textContent = (d && d.ok) ? ('✓ ' + (d.msg || '已重载')) : ('✗ ' + ((d && (d.error || d.msg)) || '重载失败'))
            loadBotplayExt(true)
          }).catch(function (e) {
            state.bpExtBusy = ''
            if (eh) eh.textContent = '重载异常: ' + e.message
          })
        }
        var bpSrc = panel.querySelector('#dk-bp-extsrc')
        if (bpSrc) bpSrc.onclick = function () {
          var f = state.bpDraft && state.bpDraft.file ? String(state.bpDraft.file) : ''
          var eh = panel.querySelector('#dk-bp-exthint')
          if (!f) return
          if (eh) eh.textContent = '读取源码中…'
          api('group/botplay-ext/source', 'ns=' + encodeURIComponent(state.ns || 'im-qqbot') + '&file=' + encodeURIComponent(f)).then(function (d) {
            if (d && d.ok) { state.bpSrcText = d.text; state.bpSrcPath = d.path; paintBody() }
            else if (eh) eh.textContent = '✗ ' + ((d && (d.error || d.msg)) || '读取失败')
          }).catch(function (e) { if (eh) eh.textContent = '异常: ' + e.message })
        }
        var bpSrcClose = panel.querySelector('#dk-bp-srcclose')
        if (bpSrcClose) bpSrcClose.onclick = function () { state.bpSrcText = null; state.bpSrcPath = ''; paintBody() }
        var bpExtDir = panel.querySelector('#dk-bp-extdir')
        if (bpExtDir) bpExtDir.onclick = function () {
          var p = (state.bpExt && state.bpExt.dir) || ''
          if (!p) return
          copyText(p, '#dk-bp-exthint', '✓ 已复制扩展目录: ')
        }
        var bpExtEvents = panel.querySelector('#dk-bp-extevents')
        if (bpExtEvents) bpExtEvents.onclick = function () {
          var dr = (state.bpExt && state.bpExt.dataRoot) || ''
          if (!dr) return
          copyText(dr + '\\botplay-events.json', '#dk-bp-exthint', '✓ 已复制事件文件路径: ')
        }
      }
      // 复制文本到剪贴板(带老浏览器回落); hintSel 指定的元素里回显提示
      function copyText(text, hintSel, okPrefix) {
        var h = hintSel ? panel.querySelector(hintSel) : null
        var done = function () { if (h) h.textContent = (okPrefix || '已复制: ') + text }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { done() })
            return
          }
        } catch (e) { /* 回落 */ }
        done()
      }
      // 在 state.bpExt.mods 里按文件名找模块状态(插件未就绪时 bpExt 可能是 null)
      function bpExtOf(file) {
        if (!state.bpExt || !Array.isArray(state.bpExt.mods)) return null
        var f = String(file || '')
        for (var i = 0; i < state.bpExt.mods.length; i++) { if (state.bpExt.mods[i] && state.bpExt.mods[i].file === f) return state.bpExt.mods[i] }
        return null
      }
      // 路径优先用 host 报的绝对路径; host 没给就按数据根拼一个(至少让主人知道该去哪儿找)
      function pickPath(p, st) {
        if (p) return p
        var dr = (st && st.dataRoot) || (state.bpExt && state.bpExt.dataRoot) || ''
        return dr ? (dr + '\\.qqbot-extensions\\botplay\\' + String((state.bpDraft && state.bpDraft.file) || '')) : ''
      }
      // 🤖 让 AI 写自定义事件: 把需求文本域的内容交给 host 现拼提示词(附接口文档+契约), 再由它唤醒当前会话 AI
      function letAiWriteBotplay() {
        var h = panel.querySelector('#dk-bp-aihint')
        var reqEl = panel.querySelector('#dk-bp-req')
        var req = String((reqEl ? reqEl.value : state.bpReq) || '').trim()
        state.bpReq = req
        if (!req) { if (h) h.textContent = '✗ 先在输入框里写你要的事件需求(大白话就行)'; return }
        var hit = state.detectedHit
        if (!hit || !hit.peerId) { if (h) h.textContent = '✗ 顶栏「当前会话」不是 QQ 群/私聊 —— 先切到与 bot 的群或私聊会话, 才知道把需求发给谁'; return }
        var ns = hit.ns || state.ns
        // 顺手把"已占用的 id/文件名"一起带过去, 免得 AI 撞号(它自己也能读文件, 但这句更省事)
        var ids = (state.bpEvents || []).map(function (e) { return e.id }).filter(Boolean).join(', ')
        var files = (state.bpEvents || []).map(function (e) { return e.file }).filter(Boolean).join(', ')
        if (ids || files) req += '\n\n(小提示: 已经占用的事件 id: ' + (ids || '无') + '；已用模块文件: ' + (files || '无') + ' —— 请避开重名)'
        if (h) h.textContent = '发给 AI 中…(' + (hit.scope === 'group' ? '群' : '私聊') + '「' + (hit.name || '') + '」)'
        apiPost('group/botplay-ext/let-ai-write', { ns: ns || 'im-qqbot', scope: hit.scope, peerId: hit.peerId, requirement: req })
          .then(function (d) {
            if (h) h.textContent = (d && d.ok) ? ('✓ ' + d.msg + ' 写完记得点事件的「🔄 重载模块」') : ('✗ ' + ((d && (d.error || d.msg)) || '失败'))
          })
          .catch(function (e) { if (h) h.textContent = '异常: ' + e.message })
      }
      // QQ 键盘布局限制(官方 API): 键盘最多 5 行 × 每行最多 5 个按钮 → 行数=ceil(按钮数/每行数)≤5 才合法
      function bpRowCount(ev) {
        var per = Math.max(1, Math.min(5, Math.round(Number(ev.buttonsPerRow)) || 1))
        var n = (ev.buttons || []).length
        return { n: n, per: per, rows: Math.ceil(n / per) }
      }
      // 编辑器内实时刷新布局提示(改「每行按钮」时调用, 不重建 DOM 保输入焦点)
      function bpLayoutHint() {
        if (!state.bpDraft || !panel) return
        var el = panel.querySelector('#dk-bp-layout')
        if (!el) return
        var c = bpRowCount(state.bpDraft)
        var over = c.rows > 5
        el.textContent = '共 ' + c.n + ' 个 · 每行 ' + c.per + ' 个 → ' + c.rows + ' 行' + (over ? '(超 QQ 上限 5 行, 发卡会报错!)' : '(≤5 行 ✅)')
        el.style.color = over ? '#e03131' : '#2f9e44'
      }
      // 🎮 互动事件装配器: 读/存走独立文件路由(2026-09-10 M4.3: {dataRoot}/.qqbot/botplay-events.json)
      function loadBotplay() {
        if (state.tab !== 'bp') return
        api('group/botplay-events', state.ns ? 'ns=' + encodeURIComponent(state.ns) : '')
          .then(function (d) {
            if (d && d.ok && Array.isArray(d.events)) {
              state.bpEvents = JSON.parse(JSON.stringify(d.events))
              if (!state.bpDraft && state.bpEvents.length) { state.bpSel = 0; state.bpDraft = JSON.parse(JSON.stringify(state.bpEvents[0])) }
              else if (!state.bpEvents.length) { state.bpSel = null; state.bpDraft = null }
              paintBody()
            }
          }).catch(function () {})
        // 🤖 自定义事件模块状态(路径/是否存在/mtime/加载错误) —— 与事件列表并行拉, 不阻塞编辑器渲染
        loadBotplayExt(false)
      }
      // 🤖 自定义事件: 拉模块状态(有自定义事件才拉, 省一次请求)
      // repaint=true 时重绘(重载后要刷新"已加载/已改动"标记); 否则只更新 state, 不打断正在打字的主人
      function loadBotplayExt(repaint) {
        if (state.tab !== 'bp') return
        var hasExt = (state.bpEvents || []).some(function (e) { return !!(e && e.file && String(e.file).trim()) })
        if (!hasExt && !repaint) return
        api('group/botplay-ext/status', state.ns ? 'ns=' + encodeURIComponent(state.ns) : '')
          .then(function (d) {
            if (d && d.ok) { state.bpExt = d; if (repaint) paintBody() }
          }).catch(function () { /* 拉不到就按"未就绪"显示路径 */ })
      }
      function saveBotplay() {
        var hint = panel.querySelector('#dk-bp-hint')
        var ok = function (v) { if (hint) hint.textContent = v }
        // 草稿回写进列表(存在编辑中草稿时)
        if (state.bpDraft) {
          var draft = state.bpDraft
          if (!draft.id || !/^[A-Za-z0-9_-]+$/.test(draft.id)) { ok('⚠️ id 必填且只能 字母/数字/_/-'); return }
          if (!draft.name || !draft.name.trim()) { ok('⚠️ 事件名必填'); return }
          if (!Array.isArray(draft.buttons) || !draft.buttons.length) { ok('⚠️ 至少 1 个按钮'); return }
          var dupId = false
          state.bpEvents.forEach(function (ev, i) { if (ev.id === draft.id && i !== state.bpSel) dupId = true })
          if (dupId) { ok('⚠️ 事件 id 重复: ' + draft.id); return }
          var draftRow = bpRowCount(draft)
          if (draftRow.rows > 5) { ok('⚠️ 「' + draft.name + '」按钮布局超限: ' + draftRow.n + ' 个按钮 × 每行 ' + draftRow.per + ' 个 = ' + draftRow.rows + ' 行(QQ 键盘最多 5 行)'); return }
          if (state.bpSel !== null && state.bpEvents[state.bpSel]) state.bpEvents[state.bpSel] = JSON.parse(JSON.stringify(draft))
          else { state.bpEvents.push(JSON.parse(JSON.stringify(draft))); state.bpSel = state.bpEvents.length - 1 }
        }
        var badEv = null
        state.bpEvents.forEach(function (ev) { var c = bpRowCount(ev); if (c.rows > 5 && !badEv) badEv = { name: ev.name, per: c.per, rows: c.rows } })
        if (badEv) { ok('⚠️ 事件「' + badEv.name + '」每行 ' + badEv.per + ' 个 → ' + badEv.rows + ' 行, 超 QQ 5 行上限, 未保存'); return }
        if (hint) hint.textContent = '保存中…'
        apiPost('group/botplay-events', { ns: state.ns || 'im-qqbot', events: state.bpEvents }).then(function (d) {
          if (d && d.ok) { if (hint) hint.textContent = '✅ 已保存(共 ' + state.bpEvents.length + ' 个事件, live 热更已生效)' }
          else { if (hint) hint.textContent = '保存失败: ' + ((d && (d.error || d.msg)) || '未知错误') }
        }).catch(function () { if (hint) hint.textContent = '保存异常' })
      }
      // ── 💬 聊天视图: 数据拉取 / QQ 风格气泡渲染 / 顶部滚动分页 ──
      function chatPeerReady() {
        return state.sendScope === 'c2c' ? !!state.sendTo : !!state.gid
      }
      function chatPeerName() {
        return state.sendScope === 'c2c'
          ? ('私聊「' + (c2cSelName()) + '」')
          : ('群「' + (groupSelName()) + '」')
      }
      // 剥 Markdown 语法(移植自 gal-view transcript.mjs, 保留正文)让气泡像 QQ 纯文本
      function mdPlain(t) {
        if (typeof t !== 'string') return ''
        return t
          .replace(/^```[^\n]*$/gm, '')
          .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
          .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
          .replace(/\*\*([^*\n]+)\*\*/g, '$1')
          .replace(/~~([^~\n]+)~~/g, '$1')
          .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)(?![*\w])/g, '$1$2')
          .replace(/`([^`\n]+)`/g, '$1')
          .replace(/^#{1,6}[ \t]+/gm, '')
          .replace(/^>[ \t]?/gm, '')
          .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
          .replace(/^[-*+][ \t]+/gm, '')
          .replace(/^\d+\.[ \t]+/gm, '')
          .replace(/\r\n?/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }
      function chatTime(ts) {
        if (!ts) return ''
        var d = new Date(ts)
        if (isNaN(d.getTime())) return ''
        var p2 = function (n) { return String(n).padStart(2, '0') }
        var hm = p2(d.getHours()) + ':' + p2(d.getMinutes())
        var now = new Date()
        if (d.toDateString() === now.toDateString()) return hm
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
      }
      // reset=true 拉最新一页(清空重载); reset=false 用 chatOldest 加载更早并保持视口
      function loadChat(reset) {
        if (!state.ns) { renderChatList(); return }
        if (!chatPeerReady()) { state.chatItems = []; state.chatMore = false; state.chatErr = '先选一个群/私聊目标'; renderChatList(); return }
        if (state.chatBusy) return
        var mode = reset ? 'chat' : 'more'
        state.chatBusy = mode
        if (reset) { state.chatItems = []; state.chatOldest = 0 }
        var box = document.getElementById('dk-chat-box')
        var keep = 0
        if (box && mode === 'more') keep = box.scrollHeight - box.scrollTop
        renderChatList() // 立即显示加载态
        var peerId = state.sendScope === 'c2c' ? state.sendTo : state.gid
        var q = 'ns=' + encodeURIComponent(state.ns) + '&scope=' + state.sendScope + '&peerId=' + encodeURIComponent(peerId) + '&limit=50'
        if (mode === 'more' && state.chatOldest > 0) q += '&beforeSeq=' + state.chatOldest
        api('chat/history', q).then(function (d) {
          state.chatBusy = ''
          try { state.chatDebug = (d && d.debug) || null } catch (e) { /* ignore */ }
          if (!d || !d.ok) { state.chatErr = (d && (d.error || d.msg)) || '加载失败'; renderChatList(); return }
          var list = (Array.isArray(d.items) ? d.items : []).filter(function (it) {
            return it && ((typeof it.text === 'string' && it.text) || (Array.isArray(it.images) && it.images.length))
          })
          if (mode === 'more') {
            var have = {}
            state.chatItems.forEach(function (x) { have[x.seq] = 1 })
            state.chatItems = list.filter(function (x) { return !have[x.seq] }).concat(state.chatItems)
          } else {
            state.chatItems = list
          }
          state.chatMore = d.hasMore === true
          state.chatErr = ''
          state.chatOldest = state.chatItems.length ? state.chatItems[0].seq : 0
          // 2026-10-01: 记住"已加载到的**最新事件 seq**" —— 滚轮增量刷新(loadChatNewer)的起点。
          //   ⚠️ 不能拿 d.tailSeq(= sess.seq = 下一个可用 seq): 正扫是 afterSeq+1 起, 记大会**漏一条/取不到**。
          var _maxSeq = 0
          state.chatItems.forEach(function (x) { var n = Number(x.seq); if (n > _maxSeq) _maxSeq = n })
          state.chatNewest = _maxSeq
          renderChatList(mode === 'more' ? keep : null)
        }).catch(function () {
          state.chatBusy = ''
          state.chatErr = '网络错误'
          renderChatList()
        })
      }
      // 文本里的 URL → 可点链接(2026-09-10 主人实测: "这个 jump_url 进不了 dock 聊天界面" ——
      // 卡片分享/ARK 里的 jump_url 在气泡里是纯文本, 点不动)。
      // ⚠️ 必须在 esc() 之后调用: 只对**已转义**的纯文本做替换, 拼进 href 的也是转义后的串 → 不开新的 XSS 面。
      function linkifyText(escaped) {
        return String(escaped || '').replace(/https?:\/\/[^\s<>"']+/g, function (u) {
          // 尾随标点不入链接(中文标点也剥), 避免把「。」「）」吃进 URL
          var trail = ''
          var m = u.match(/[.,;:!?，。；：！？、）)】」』"']+$/)
          if (m) { trail = m[0]; u = u.slice(0, u.length - trail.length) }
          if (!u) return trail
          return '<a class="dk-link" href="' + u + '" target="_blank" rel="noopener noreferrer" title="' + u + '">' + u + '</a>' + trail
        })
      }
      // ── 媒体地址归一(2026-09-13 主人要求: dock 聊天界面图片要**同时兼容 url 与本地路径/图库链接**) ──
      //   入站消息的图片已改为给**本地路径**(省 token、看图不用再下载), 浏览器直接拿 D:\… 当然加载不出来,
      //   于是统一转成同源直出 URL: /api/qqbot-settings/chat/raw-media?p=<本机路径>。
      //   http(s) / 已是 /api/... 的(含 sticker-img?id=xxx 图库链接) 一律原样。
      function chatMediaURL(u) {
        var s = String(u || '').trim()
        if (!s) return s
        if (/^(https?:|\/\/|\/api\/|data:|blob:)/i.test(s)) return s
        if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.charAt(0) === '/') {
          return 'api/qqbot-settings/chat/raw-media?p=' + encodeURIComponent(s)
        }
        return s
      }
      // 图库兜底: 消息里记的本地路径是"当时"的(candidate→library 搬层后就失效),
      //   但文件名正是图库 id(12 位 sha1) → 加载失败时再用 sticker-img?id= 试一次(按 id 解析, 与层无关)
      function chatStickerFallback(src) {
        var s = String(src || '')
        if (s.indexOf('/chat/raw-media?p=') >= 0) {
          try { s = decodeURIComponent(s.split('p=')[1] || '') } catch (e) { /* 保持原样 */ }
        }
        var base = s.replace(/[?#].*$/, '').split(/[\\/]/).pop() || ''
        var idm = base.match(/^([0-9a-f]{12})\.([a-z0-9]{2,5})$/i)
        if (!idm) return ''
        var dd = ''
        try { dd = curDataDir() || '' } catch (e) { dd = '' }
        return 'api/qqbot-settings/sticker-img?id=' + encodeURIComponent(idm[1]) + (dd ? '&dataDir=' + encodeURIComponent(dd) : '')
      }
      // 2026-10-01: 状态行单独成函数 —— 增量追加新消息后只更新这行, 不重绘整个列表
      function updateChatStatus() {
        var st = document.getElementById('dk-chat-status')
        if (!st) return
        if (state.chatBusy === 'send') st.textContent = '发送中…'
        else if (chatFlash) st.textContent = chatFlash
        else if (state.chatBusy === 'new') st.textContent = '检查新消息…'
        else if (state.chatBusy) st.textContent = state.chatBusy === 'chat' ? '加载中…' : '加载更早…'
        else if (state.chatErr) st.textContent = state.chatErr
        else if (!state.chatItems.length) st.textContent = '暂无记录 —— 机器人和该目标聊过后会显示在这里'
        else st.textContent = '共 ' + state.chatItems.length + ' 条 · ' + chatPeerName() + (state.chatMore ? ' · 上滑加载更早' : ' · 已到最早')
          + (state.chatDebug ? ' ｜🔍 ' + state.chatDebug.seq + '/' + state.chatDebug.eventsLen + '/' + state.chatDebug.got : '')
        // 🔍 临时诊断（2026-10-04，定位"只显示最旧"用）：鼠标悬停看完整信息
        try { if (state.chatDebug) st.title = JSON.stringify(state.chatDebug) } catch (e) { /* ignore */ }
      }
      // 2026-10-01: 单条气泡 HTML 抽成函数 —— renderChatList 与"增量追加"共用同一套渲染
      function chatRowHTML(it) {
        {
          var isOut = it.dir === 'out'
          var who = isOut ? '我' : (it.sender || (state.sendScope === 'c2c' ? c2cSelName() : '群友'))
          var ava = isOut ? '🐳' : chatAvaOf(who)
          var meta = '<span>' + esc(who) + '</span>'
            + (it.tag ? '<span class="dk-ctag">' + esc(it.tag) + '</span>' : '')
            + '<span>' + esc(chatTime(it.time)) + '</span>'
          var imgs = (Array.isArray(it.images) ? it.images : []).map(function (m) {
            var u = typeof m === 'string' ? m : (m && m.url)
            var k = typeof m === 'string' ? 'image' : ((m && m.kind) || 'image')
            if (!u) return ''
            u = chatMediaURL(u) // 本机路径 → 同源直出 URL(兼容 url / 本地路径 / 图库链接)
            if (k === 'file') return '<a class="dk-file" href="' + esc(u) + '" target="_blank" rel="noopener" title="' + esc(u) + '">📎 ' + esc((m && m.name) || '文件') + '</a>'
            if (k === 'voice') return '<audio class="dk-audio" controls preload="metadata" src="' + esc(u) + '"></audio>'
            if (k === 'video') return '<video class="dk-video" controls preload="metadata" src="' + esc(u) + '"></video>'
            // 兜底链(按序试): ① 后端给的 QQ 链接(台账兜底, 本地文件被清了也能显示)
            //                      ② 图库 id 链接 sticker-img?id=(路径搬层后的旧路径救不回时用)
            var fbs = []
            if (m && m.fb && String(m.fb) !== String(u)) fbs.push(String(m.fb))
            var sf = chatStickerFallback(m, u)
            if (sf && sf !== u && fbs.indexOf(sf) < 0) fbs.push(sf)
            return '<img class="dk-img" loading="lazy" data-lb="' + esc(u) + '"' + (fbs.length ? ' data-fb="' + esc(JSON.stringify(fbs)) + '"' : '') + ' src="' + esc(u) + '" referrerpolicy="no-referrer" alt="[图片]">'
          }).join('')
          var txt = it.text ? chatRenderText(it.text) : ''
          return '<div class="dk-crow ' + (isOut ? 'out' : 'in') + '">'
            + '<div class="dk-ava">' + ava + '</div>'
            + '<div class="dk-cmain">'
            + '<div class="dk-cmeta">' + meta + '</div>'
            + '<div class="dk-cbubble">' + imgs + txt + '</div>'
            + '</div>'
            + '</div>'
        }
      }
      // 2026-10-01: 图片交互绑定抽成函数(增量追加的新节点也要绑; 属性赋值 → 幂等)
      function bindChatImgs(root) {
        if (!root) return
        // 图片: 单击/右键 → 灯箱放大(右键不再弹浏览器菜单, 避免误触发 onerror 变加载失败)
        root.querySelectorAll('img.dk-img').forEach(function (img) {
          var lbOf = function () { return img.getAttribute('data-lb') || img.src }
          img.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openLightbox(lbOf()) }
          img.oncontextmenu = function (e) { e.preventDefault(); e.stopPropagation(); openLightbox(lbOf()) }
          // 加载失败 → 按兜底链依次重试(QQ 链接 → 图库 id 链接) ② 全都失败才灰字提示
          img.onerror = function () {
            var list = []
            try { list = JSON.parse(img.getAttribute('data-fb') || '[]') || [] } catch (e) { list = [] }
            var i = Number(img.getAttribute('data-fbi') || '0')
            if (Array.isArray(list) && i < list.length) {
              img.setAttribute('data-fbi', String(i + 1))
              img.setAttribute('data-lb', String(list[i]))
              img.src = String(list[i])
              return
            }
            img.outerHTML = '<span style="color:#888">[图加载失败]</span>'
          }
        })
      }
      function renderChatList(keepScrollOffset) {
        var box = document.getElementById('dk-chat-box')
        if (!box) return
        updateChatStatus()
        if (!state.chatItems.length) {
          var emptyTxt = state.chatErr || (!chatPeerReady() ? '先选一个群/私聊目标' : '还没有聊天记录(该目标暂无活跃会话)')
          box.innerHTML = '<div class="dk-empty" style="padding:26px 0">' + esc(emptyTxt) + '</div>'
          return
        }
        var html = ''
        if (state.chatMore) html += '<div class="dk-chat-top">↑ 上滑加载更早消息</div>'
        html += state.chatItems.map(chatRowHTML).join('')
        html += '<div class="dk-chat-bottom">—— 会话尾部 · ' + esc(chatPeerName()) + ' ——</div>'
        box.innerHTML = html
        bindChatImgs(box)
        // 滚动: 刷新/切目标 → 滚到底; 上滚加载更早 → 保持视口
        if (keepScrollOffset == null) {
          // 2026-10-01 主人实测「打开 dock 显示的不是最新消息」：
          //   气泡里的图是 loading="lazy"，刚渲染时高度还没撑开 → 首次贴底其实只贴到"半截"，
          //   等图加载完内容变高，视口就停在中间了。
          // 2026-10-04 二次修复（主人又实测到：57 条带图的会话，打开后停在**最旧**那条）：
          //   原来的"定时补贴 4 次（最多 1.2 秒）"在图片加载慢时窗口早关了 ⇒ 之后图片撑开就再没人管。
          //   改**事件驱动**：① 未加载完的 img 在 load/error 后贴底；
          //                ② ResizeObserver 盯内容高度，一变高就贴底（覆盖懒加载/字体/视频等一切撑高）。
          //
          // 2026-10-04 三次修复（主人定位：**"自从记录滚动位置后，打开就不再默认最新了"**）：
          //   上一版用 wheel / touchstart / keydown 当"用户在滚"的判据 —— 太容易误触发
          //   （触控板轻点、焦点在面板里按键，甚至 image 的可聚焦元素都算），
          //   一旦被 cancel，`box.innerHTML = html` 后的新容器 scrollTop 就停在 0 = **最旧那条** ✗
          //   现在只看**真实滚动方向**：scrollTop 变小 = 用户主动往上翻 ⇒ 才停手。
          //   其他一律继续贴底，等于恢复"打开/刷新默认停在最新"的老行为。
          var lastTop = box.scrollTop
          var userScrolledUp = false
          try {
            box.addEventListener('scroll', function () {
              var t = box.scrollTop
              if (t < lastTop - 6) userScrolledUp = true   // 往上翻 → 停手，别跟他抢
              else if (t + 6 >= box.scrollHeight - box.clientHeight) userScrolledUp = false  // 又回到底部 → 恢复跟随
              lastTop = t
            }, { passive: true })
          } catch (e) { /* 老浏览器忽略 */ }
          var stickBottom = function () { if (!userScrolledUp) box.scrollTop = box.scrollHeight }
          box.scrollTop = box.scrollHeight
          // ① 图片加载完成 → 贴底
          try {
            var imgs = box.querySelectorAll('img')
            for (var ii = 0; ii < imgs.length; ii++) {
              if (imgs[ii].complete) continue
              imgs[ii].addEventListener('load', stickBottom, { once: true })
              imgs[ii].addEventListener('error', stickBottom, { once: true })
            }
          } catch (e) { /* ignore */ }
          // ② 内容高度变化 → 贴底
          // 2026-10-04 四次修复（主人实测"刷新后打开 dock 还是停在 9/21 最旧处"）：
          //   上一版用 ResizeObserver 观测 `box`（#dk-chat-box）—— **错的**：
          //   box 的高度是 CSS 写死的（height:min(36vh,300px)），图片撑高的是**内容**不是**容器**，
          //   所以回调**永远不会触发**，一旦 1.2s 的定时补贴过去就再没人贴底 ✗
          //   现在改为 **rAF 轮询 box.scrollHeight**（内容高度的直接度量）：
          //   只要它在变（图片/字体/视频陆续撑开），就一直贴底；5 秒后自动停。
          //   期间用户若真的往上翻（userScrolledUp）立刻停手。
          try {
            (function () {
              var t0 = Date.now()
              var lastH = box.scrollHeight
              var tick = function () {
                if (userScrolledUp) return
                var h = box.scrollHeight
                if (h !== lastH) {
                  lastH = h
                  box.scrollTop = box.scrollHeight
                }
                if (Date.now() - t0 < 5000) requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            })()
          } catch (e) { /* 没有 rAF 的环境忽略（下面还有定时补贴兜底） */ }
          // ③ 保底定时补贴（覆盖没有 rAF 的环境）
          setTimeout(stickBottom, 80)
          setTimeout(stickBottom, 240)
          setTimeout(stickBottom, 600)
          setTimeout(stickBottom, 1200)
          setTimeout(stickBottom, 2500)
        }
        else box.scrollTop = box.scrollHeight - keepScrollOffset
        // 「↓ 最新」按钮：渲染即贴底 ⇒ 默认收起；并按输入框实际高度重新定位
        //   （全屏 / 小屏 / textarea 变高时都不会压住输入区）
        try {
          var jbR = document.getElementById('dk-jump-latest')
          if (jbR) {
            jbR.classList.remove('on')
            var comp = document.querySelector('#qqs-dock-panel .dk-composer')
            jbR.style.bottom = (((comp && comp.offsetHeight) ? comp.offsetHeight : 66) + 10) + 'px'
          }
        } catch (e) { /* ignore */ }
      }
      // 2026-10-01 主人要求：滚轮向下 → **增量**追加新消息
      //   · 只 append 新气泡（不 box.innerHTML 重绘 → **不闪**）
      //   · **不动 scrollTop**（不跳位置；想看最新的自己继续滑）
      function appendChatRows(list) {
        var box = document.getElementById('dk-chat-box')
        if (!box || !Array.isArray(list) || !list.length) return
        var html = list.map(chatRowHTML).join('')
        var tail = box.querySelector('.dk-chat-bottom')
        if (tail) tail.insertAdjacentHTML('beforebegin', html)
        else box.insertAdjacentHTML('beforeend', html)
        bindChatImgs(box)
        // 追加内容**不会触发 scroll 事件** ⇒ 主动同步一次「↓ 最新」按钮的显隐
        //   （不含图片：图撑开导致的高度变化由上面 renderChatList 的 ResizeObserver 管）
        try { syncJumpLatest(box) } catch (e) { /* ignore */ }
      }
      // 滚轮触发的"取更新的消息"：afterSeq = 当前已加载的最新位置
      function loadChatNewer() {
        if (!state.ns || !chatPeerReady() || state.chatBusy) return
        var after = Number(state.chatNewest || 0)
        if (!(after > 0)) { loadChat(true); return }   // 还没加载过 → 走整页首屏
        state.chatBusy = 'new'
        updateChatStatus()
        var peerId = state.sendScope === 'c2c' ? state.sendTo : state.gid
        var q = 'ns=' + encodeURIComponent(state.ns) + '&scope=' + state.sendScope
          + '&peerId=' + encodeURIComponent(peerId) + '&afterSeq=' + after + '&limit=100'
        api('chat/history', q).then(function (d) {
          state.chatBusy = ''
          if (!d || !d.ok) { updateChatStatus(); return }
          var list = (Array.isArray(d.items) ? d.items : []).filter(function (it) {
            return it && ((typeof it.text === 'string' && it.text) || (Array.isArray(it.images) && it.images.length))
          })
          // 去重键含 seq+方向+正文前缀 —— 群历史打包块里多条共用同一 seq, 只按 seq 去重会误删
          var keyOf = function (x) { return String(x.seq) + '|' + String(x.dir) + '|' + String(x.text || '').slice(0, 24) }
          var have = {}
          state.chatItems.forEach(function (x) { have[keyOf(x)] = 1 })
          // ⚠️ 2026-10-01 主人实测「向下滚后最新消息后面冒出历史消息」：
          //   群打包块([历史]…[/历史])会被拆成多条挂在**同一个新 seq** 上, 内容却是**更早**的消息;
          //   不过滤就会被当新事件整块接到列表尾部。只收"时间不早于列表尾部那条"的条目。
          var _tailT = state.chatItems.length ? (Number(state.chatItems[state.chatItems.length - 1].time) || 0) : 0
          var fresh = list.filter(function (x) {
            return !have[keyOf(x)] && (Number(x.time) || 0) >= _tailT
          })
          if (fresh.length) {
            state.chatItems = state.chatItems.concat(fresh)
            appendChatRows(fresh)          // ★ 增量追加: 不重绘、不闪、不跳位置
          }
          // 已加载位置 = 列表里最大的事件 seq（同 ①：不能用 tailSeq）
          state.chatItems.forEach(function (x) { var n = Number(x.seq); if (n > state.chatNewest) state.chatNewest = n })
          updateChatStatus()
        }).catch(function () { state.chatBusy = ''; updateChatStatus() })
      }
      // 聊天文本渲染(2026-09-13 引用消息功能): 把引用块渲染成"引用样式"气泡(左边框+灰底), 其余正文照常。
      //   2026-09-15 标记改短([引]…[/引][当前]) —— **新旧都认**, 否则老会话里的英文标记会显示成裸文本。
      function chatRenderText(t) {
        var src = String(t || '')
          .replace(/\[(?:当前|Current message)\]\s*/gi, '')
          // 2026-10-01: 历史块标记(新旧)一律剥掉 —— 后端已把历史段拆成独立气泡, 这里兜底老会话/异常残留
          .replace(/\[(?:\/?历史|\/?(?:Chat history begins|Chat history ends))\]/gi, '')
          // 后端把引用块折叠成 `[引用]` → 渲染成灰色提示文字, 别显示成裸方括号(也不该被当发送者)
          .replace(/\[引用\]/g, '↩ 引用上文')
          // 媒体标记残留兜底(后端已抽成缩略图/播放器): **只显文件名, 不把本机绝对路径暴露在气泡里**
          .replace(/\[(图片|附件|文件|语音|视频|音频|Image|Video|Voice|File|Attachment):\s*([^\]]*)\]/gi, function (all, tag, inner) {
            var s = String(inner || '').trim()
            if (!s) return ''
            var tg = String(tag).toLowerCase()
            var icon = (tg === '图片' || tg === 'image') ? '🖼'
              : (tg === '视频' || tg === 'video') ? '🎬'
                : (tg === '语音' || tg === '音频' || tg === 'voice') ? '🎵' : '📎'
            if (/^https?:/i.test(s)) return icon + ' 媒体'
            var nm = s.replace(/[?#].*$/, '').split(/[\\/]/).pop() || s
            return icon + ' ' + nm
          })
        var re = /\[(?:引|Quoted message begins)\]([\s\S]*?)\[\/(?:引|Quoted message ends)\]/g
        var parts = []
        var m, last = 0
        while ((m = re.exec(src)) !== null) {
          if (m.index > last) parts.push('<div>' + linkifyText(esc(mdPlain(src.slice(last, m.index)))) + '</div>')
          var q = (m[1] || '').replace(/^\s*\n/, '').replace(/\n\s*$/, '')
          parts.push('<div style="border-left:3px solid #5b7cfa;background:rgba(91,124,250,.10);padding:5px 9px;margin:2px 0 7px;border-radius:6px;color:#9fb0ff;font-size:12px;white-space:pre-wrap">↩ ' + linkifyText(esc(mdPlain(q))) + '</div>')
          last = m.index + m[0].length
        }
        if (last < src.length) parts.push('<div>' + linkifyText(esc(mdPlain(src.slice(last)))) + '</div>')
        if (!parts.length) parts.push('<div>' + linkifyText(esc(mdPlain(src))) + '</div>')
        return parts.join('')
      }
      // 头像字符: 群友取昵称首字; 私聊/无名兜底
      function chatAvaOf(who) {
        var s = String(who || '').trim()
        if (!s) return '?'
        // 脏数据兜底(2026-10-01): 万一 sender 还是块标记/方括号壳, 别把 "[" 当头像字
        s = s.replace(/^[\[［(（【]+|[\]］)）】]+$/g, '').trim()
        if (!s || /^(?:历|历史|当前|引|引用|(?:Chat history|Quoted message|Current message)(?:\s+begins|\s+ends)?)$/i.test(s)) return '❔'
        try { return Array.from(s)[0] } catch (e) { return s[0] || '?' }
      }
      function setChatStatus(msg) {
        var st = document.getElementById('dk-chat-status')
        if (st) st.textContent = msg
      }
      // 结果提示: 短暂保留(列表刷新/计数不覆盖), 到期自动还原
      function flashStatus(msg, ms) {
        chatFlash = msg
        setChatStatus(msg)
        var hold = ms || 3500
        setTimeout(function () {
          if (chatFlash === msg) {
            chatFlash = ''
            var st = document.getElementById('dk-chat-status')
            if (st && st.textContent === msg) renderChatList()
          }
        }, hold)
      }
      function closeLightbox() {
        var ov = document.getElementById('qqs-lightbox')
        if (ov) ov.remove()
      }
      function openLightbox(url) {
        closeLightbox()
        var ov = document.createElement('div')
        ov.id = 'qqs-lightbox'
        ov.innerHTML = '<span class="lb-x">✕</span><img src="' + esc(url) + '" referrerpolicy="no-referrer" alt="图片">'
        document.body.appendChild(ov)
        ov.onclick = closeLightbox
        var x = ov.querySelector('.lb-x')
        if (x) x.onclick = function (e) { e.stopPropagation(); closeLightbox() }
        window.addEventListener('keydown', function h(e) { if (e.key === 'Escape') { closeLightbox(); window.removeEventListener('keydown', h) } })
      }
      function chatUrls(text) {
        var out = []
        var re = /https?:\/\/[^\s]+/g
        var m
        while ((m = re.exec(String(text || ''))) !== null) {
          var u = m[0].replace(/[，。、；：,.;:!！?？)\]】》>」』]+$/, '')
          if (u) out.push(u)
        }
        return out
      }
      function chatKindOfMedia(fullText) {
        if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(fullText) || /\[(图片|img):/i.test(fullText)) return 'image'
        if (/\.(mp4|webm|mov|avi)(\?|$)/i.test(fullText) || /\[(视频|video):/i.test(fullText)) return 'video'
        if (/\.(mp3|wav|amr|silk|m4a|ogg)(\?|$)/i.test(fullText) || /\[(语音|voice|音频):/i.test(fullText)) return 'voice'
        return 'file'
      }
      function chatKindLbl(kind) {
        return kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'voice' ? '语音' : '文件'
      }
      // 把文本框里的 [MEDIA:kind|src] 拆出来(src 可为 http 链接或本机路径), 其余为纯文本段
      function chatSplitBbcode(t) {
        var medias = []
        var texts = []
        var re = /\[MEDIA:([^\]|]+)\|([^\]]+)\]/gi
        var m
        var last = 0
        while ((m = re.exec(String(t || ''))) !== null) {
          var pre = t.slice(last, m.index).trim()
          if (pre) texts.push(pre)
          medias.push({ kind: String(m[1]).toLowerCase(), src: String(m[2]).trim() })
          last = m.index + m[0].length
        }
        var tail = t.slice(last).trim()
        if (tail) texts.push(tail)
        // kind 中文兼容: [MEDIA:图片|…]
        medias.forEach(function (x) {
          if (x.kind === '图片' || x.kind === 'img') x.kind = 'image'
          else if (x.kind === '视频' || x.kind === 'video') x.kind = 'video'
          else if (x.kind === '语音' || x.kind === 'voice' || x.kind === '音频') x.kind = 'voice'
          else if (x.kind === '文件' || x.kind === 'file') x.kind = 'file'
          if (x.kind !== 'image' && x.kind !== 'video' && x.kind !== 'voice' && x.kind !== 'file') x.kind = 'file'
        })
        return { medias: medias, texts: texts }
      }
      // 发送单条媒体: src 支持 http(s) 或本机绝对路径; 勾了🧠记入上下文时 host 写「用户代发」模拟消息
      function chatSendMediaOne(kind, src) {
        var body = { ns: state.ns || undefined, scope: state.sendScope, kind: kind }
        var peerId = state.sendScope === 'c2c' ? state.sendTo : state.gid
        if (!peerId) return Promise.resolve({ ok: false, msg: '未选目标' })
        body.peerId = peerId
        if (/^https?:\/\//i.test(src)) body.url = src
        else body.localPath = src
        body.insertContext = state.chatIns === true
        body.relayText = src // 完整来源(路径/URL)进「用户代发」上下文, dock 可渲染/可读
        return apiPost('chat/media', body)
      }
      // 媒体来源的短描述(记入上下文用): 取文件名/链接尾
      function chatMediaDesc(src) {
        var s = String(src || '')
        var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
        var base = i >= 0 ? s.slice(i + 1) : s
        base = base.replace(/[?&#].*$/, '')
        return base || '媒体'
      }
      // 发送中 UI: 禁用发送按钮/输入框(防连点重复发送), 按钮显示进度
      function setSending(on, label) {
        var btn = document.getElementById('dk-chat-send')
        if (btn) { btn.disabled = !!on; btn.textContent = on ? (label || '发送中…') : '发送' }
        var ta = document.getElementById('dk-chat-input')
        if (ta) ta.disabled = !!on
      }
      // 依次发送媒体列表, 全部成功后清空输入并刷新; 部分失败即停并提示
      function chatSendMediaSeq(list, onDone) {
        if (!list.length) { if (onDone) onDone(); return }
        if (state.chatBusy) return // 防重入
        state.chatBusy = 'send'
        setSending(true, '发送中…')
        setChatStatus('正在发送 ' + list.length + ' 个媒体…')
        renderChatList()
        var i = 0
        var step = function () {
          setSending(true, '发送中 ' + (i + 1) + '/' + list.length)
          setChatStatus('正在发送' + chatKindLbl(list[i].kind) + ' ' + (i + 1) + '/' + list.length + '…(完成前勿再点发送)')
          chatSendMediaOne(list[i].kind, list[i].src).then(function (d) {
            if (!d || !d.ok) {
              state.chatBusy = ''; setSending(false)
              flashStatus('发送失败: ' + ((d && (d.msg || d.error)) || '未知') + '(输入已保留, 可改后重发)', 6000)
              return
            }
            i++
            if (i >= list.length) {
              state.chatText = ''; renderChatInput(); state.chatBusy = ''; setSending(false)
              flashStatus('已发送 ' + chatKindLbl(list[0].kind) + (list.length > 1 ? ' ×' + list.length : '') + ' ✓')
              loadChat(true)
              if (onDone) onDone()
            } else step()
          })
        }
        step()
      }
      // 发送入口(kindArg 保留兼容): 有 [MEDIA:…] → 逐条发媒体 + 剩余文字; 否则 纯链接自动判 / 纯文本
      function chatSend(kindArg) {
        if (state.chatBusy) { setChatStatus('正在发送中, 请稍候…'); return }
        if (!state.ns) { setChatStatus('先选账号实例(头部下拉)'); return }
        if (!chatPeerReady()) { setChatStatus('先选一个群/私聊目标'); return }
        var t = (state.chatText || '').trim()
        if (!t) { setChatStatus('先输入内容, 或用 📷插图/📎文件 加入媒体'); return }
        var blk = chatSplitBbcode(t)
        if (blk.medias.length) {
          chatSendMediaSeq(blk.medias, function () {
            if (blk.texts.length && !state.chatBusy) chatSendText(blk.texts.join('\n'))
          })
          return
        }
        var urls = chatUrls(t)
        if (!urls.length) { chatSendText(t); return }
        var kind = chatKindOfMedia(t)
        // 纯链接: 自动当媒体发; 若有残留描述文字(去掉链接后), 媒体成功后补发
        var clean = t.replace(/https?:\/\/[^\s]+/g, '').replace(/\[(图片|附件|文件|语音|视频|音频):\s*\]/g, '').replace(/\[Attachment:[^\]]*\]/g, '').trim()
        chatSendMediaSeq([{ kind: kind, src: urls[0] }], function () { if (clean && !state.chatBusy) chatSendText(clean) })
      }
      function chatSendText(t) {
        if (state.chatBusy) return // 防重入(媒体后补发文本也要等空闲)
        // @ mention: 输入框里的 @<32hex> → QQ 高亮 <@openid>(先保护已手输的 <@…>)
        if (state.sendScope === 'group') {
          t = String(t || '').replace(/<@([A-Za-z0-9]{32})>/g, '\u0001AT$1\u0001')
            .replace(/@([A-Za-z0-9]{32})(?![A-Za-z0-9])/g, '<@$1>')
            .replace(/\u0001AT([A-Za-z0-9]{32})\u0001/g, '<@$1>')
        }
        state.chatBusy = 'send'
        setSending(true, '发送中…')
        setChatStatus('正在发送文本…')
        renderChatList()
        var body = { text: t, ns: state.ns || undefined, insertContext: state.chatIns === true }
        if (state.sendScope === 'c2c') body.openid = state.sendTo
        else body.gid = state.gid
        apiPost(state.sendScope === 'c2c' ? 'chat/send' : 'group/send', body).then(function (d) {
          state.chatBusy = ''
          setSending(false)
          if (d && d.ok) { state.chatText = ''; renderChatInput(); flashStatus(d.msg || '已发送 ✓'); loadChat(true) }
          else flashStatus((d && (d.msg || (d.err && d.err.human) || d.error)) || '发送结果未知', 6000)
        })
      }
      // ── @ mention: 输入框敲 @ 自动弹成员候选, 支持继续输入过滤(昵称/ID) ──
      function chatAtKey() { return (state.ns || '') + ':' + (state.gid || '') }
      function chatLoadAtMembers() {
        if (state.sendScope === 'c2c' || !state.gid) { atM.members = []; chatAtClose(); return }
        var k = chatAtKey()
        if (atM.key === k && atM.members.length) return
        atM.key = k
        var q = 'gid=' + encodeURIComponent(state.gid) + (state.ns ? '&ns=' + encodeURIComponent(state.ns) : '')
        api('group/members_local', q).then(function (d) {
          if (atM.key !== chatAtKey()) return
          atM.members = (d && d.ok && Array.isArray(d.members) ? d.members : []).map(function (m) { return { mid: m.mid, name: m.name || '' } })
          if (atM.open) chatAtRender()
        })
      }
      // 光标前最近一个 @(到光标为止无空格/换行/@): 返回 {start, kw}
      function chatAtCtx(text, caret) {
        var head = String(text || '').slice(0, caret)
        var m = /@([^\s@]*)$/.exec(head)
        if (!m) return null
        return { start: caret - m[0].length, kw: m[1] }
      }
      function chatAtScan() {
        var ta = document.getElementById('dk-chat-input')
        if (!ta) return
        var v = ta.value || ''
        var c = ta.selectionStart == null ? v.length : ta.selectionStart
        var ctx = chatAtCtx(v, c)
        if (!ctx) { chatAtClose(); return }
        if (!atM.members.length) chatLoadAtMembers()
        atM.open = true
        atM.kw = String(ctx.kw).toLowerCase()
        atM.idx = 0
        atM.range = ctx
        chatAtRender()
      }
      function chatAtList() {
        if (!atM.open) return []
        var kw = atM.kw
        if (!kw) return atM.members
        return atM.members.filter(function (m) {
          return (m.name || '').toLowerCase().indexOf(kw) >= 0 || String(m.mid || '').indexOf(kw) >= 0
        })
      }
      function chatAtRender() {
        var pop = document.getElementById('dk-at-pop')
        if (!pop) return
        if (!atM.open) { pop.style.display = 'none'; return }
        var list = chatAtList()
        if (!list.length) { pop.style.display = 'block'; pop.innerHTML = '<div class="dk-at-empty">没有匹配的群成员(成员需先发过言)</div>'; return }
        pop.style.display = 'block'
        pop.innerHTML = list.map(function (m, i) {
          return '<div class="dk-at-item' + (i === atM.idx ? ' on' : '') + '" data-mid="' + esc(m.mid) + '">'
            + '<span>@' + esc(m.name || '(未知名)') + '</span>'
            + '<span style="color:#99a">' + esc(String(m.mid).slice(0, 6)) + '…</span></div>'
        }).join('')
        Array.prototype.forEach.call(pop.querySelectorAll('.dk-at-item'), function (el) {
          el.onmousedown = function (ev) { ev.preventDefault(); chatAtPick(el.getAttribute('data-mid')) }
        })
      }
      function chatAtPick(mid) {
        if (mid == null || !atM.range) return
        var ta = document.getElementById('dk-chat-input')
        if (!ta) return
        var v = state.chatText || ''
        var caret = ta.selectionStart == null ? v.length : ta.selectionStart
        if (caret < atM.range.start) caret = v.length
        state.chatText = v.slice(0, atM.range.start) + '@' + mid + ' ' + v.slice(caret)
        chatAtClose()
        renderChatInput()
        ta.focus()
        var pos = atM.range.start + 1 + String(mid).length + 1
        try { ta.setSelectionRange(pos, pos) } catch (e) { /* 忽略 */ }
      }
      function chatAtClose() {
        atM.open = false
        var pop = document.getElementById('dk-at-pop')
        if (pop) pop.style.display = 'none'
      }
      function chatKindOfFile(f) {
        var t = String((f && f.type) || '').toLowerCase()
        var n = String((f && f.name) || '').toLowerCase()
        if (t.indexOf('image/') === 0 || /\.(jpe?g|png|gif|webp|bmp)$/.test(n)) return 'image'
        if (t.indexOf('video/') === 0 || /\.(mp4|webm|mov|avi)$/.test(n)) return 'video'
        if (t.indexOf('audio/') === 0 || /\.(mp3|wav|amr|silk|m4a|ogg)$/.test(n)) return 'voice'
        return 'file'
      }
      function chatFileExt(f) {
        var n = String((f && f.name) || '')
        var i = n.lastIndexOf('.')
        var e = i >= 0 ? n.slice(i + 1).toLowerCase() : ''
        if (/^[a-z0-9]{1,6}$/.test(e)) return e
        return 'bin'
      }
      // 把 [MEDIA:kind|src] 追加进文本框(不清空已有内容)
      function chatInsertMedia(kind, src) {
        var cur = state.chatText || ''
        if (cur && !/\n$/.test(cur)) cur += '\n'
        state.chatText = cur + '[MEDIA:' + chatKindLbl(kind) + '|' + src + ']'
        renderChatInput()
        var ta = document.getElementById('dk-chat-input')
        if (ta) { ta.focus(); ta.scrollTop = ta.scrollHeight }
        setChatStatus('已插入 ' + chatKindLbl(kind) + ', 点发送即可发出')
      }
      // 处理选中的文件: 有本机路径(Electron 场景)直接用; 否则 base64 上传到 bot 临时目录拿路径
      function chatIngestFiles(files, fromPicker) {
        var list = Array.isArray(files) ? files : []
        if (!list.length) return
        var total = list.length
        var done = 0
        var finish = function () { done++; if (fromPicker && done >= total) { var fp = document.getElementById('dk-chat-file'); if (fp) fp.value = '' } }
        list.forEach(function (f) {
          var kind = chatKindOfFile(f)
          var directPath = ''
          try { if (f.path && /^[a-zA-Z]:[\\/]/.test(String(f.path))) directPath = String(f.path) } catch (e) { directPath = '' }
          if (directPath) { chatInsertMedia(kind, directPath); finish(); return }
          if (f.size > 300 * 1024 * 1024) { setChatStatus('「' + (f.name || '文件') + '」超过 300MB 上限, 请手动输入本机路径'); finish(); return }
          // 一律走流式上传(不限 ~5MB): 浏览器把 File 直接当 body 传, host 写盘后返回本机路径
          var ext = chatFileExt(f)
          setChatStatus('正在上传 ' + (f.name || '文件') + '…')
          var q = 'ns=' + encodeURIComponent(state.ns || '') + '&ext=' + encodeURIComponent(ext)
          fetch('api/qqbot-settings/chat/upload-raw?' + q, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: f,
          }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
            if (d && d.ok && d.path) { chatInsertMedia(kind, d.path); setChatStatus('已上传 ' + (f.name || '文件') + ', 点发送即可发出') }
            else setChatStatus('上传失败: ' + ((d && (d.error || d.msg)) || '未知'))
            finish()
          }).catch(function () { setChatStatus('上传失败(网络错误)'); finish() })
        })
      }
      function renderChatInput() {
        var ta = document.getElementById('dk-chat-input')
        if (ta) ta.value = state.chatText || ''
        var n = document.getElementById('dk-chat-cnt')
        if (n) n.textContent = (state.chatText || '').length + '/2000'
      }
      function renderJoinList() {
        var box = panel.querySelector('#dk-join-list')
        if (!box) return
        var badgeEl = panel.querySelector('.dk-join-badge')
        if (state.joins === null) { box.innerHTML = '<div class="dk-empty">加载中…</div>'; return }
        if (state.joins.length === 0) { box.innerHTML = '<div class="dk-empty">当前没有待审批的入群申请 ✓</div>'; return }
        box.innerHTML = state.joins.map(function (j) {
          var busying = state.busy === 'ap-' + j.member_openid
          return '<div class="dk-item">'
            + '<span style="font-weight:600">' + esc(j.username) + '</span>'
            + '<span style="color:#999;font-size:12px">' + esc(j.source) + '</span>'
            + (j.verify ? '<span style="color:#666;font-size:12px">验证: ' + esc(j.verify) + '</span>' : '')
            + (j.risk ? '<span style="color:#c23131;font-size:12px">⚠ ' + esc(j.risk) + '</span>' : '')
            + '<span style="flex:1"></span>'
            + '<button class="dk-btn ok" data-ap="approve" data-mid="' + esc(j.member_openid) + '"' + (busying ? ' disabled' : '') + '>' + (busying ? '处理中…' : '通过') + '</button>'
            + '<button class="dk-btn no" data-ap="decline" data-mid="' + esc(j.member_openid) + '"' + (busying ? ' disabled' : '') + '>拒绝</button>'
            + '</div>'
        }).join('')
        box.querySelectorAll('button[data-ap]').forEach(function (btn) {
          btn.onclick = function () { doApprove(btn.getAttribute('data-mid'), btn.getAttribute('data-ap')) }
        })
        if (badgeEl) { badgeEl.style.display = 'inline-block'; badgeEl.textContent = state.joins.length }
      }
      function renderMemberList() {
        var box = panel.querySelector('#dk-member-list')
        if (!box) return
        if (state.members === null) { box.innerHTML = '<div class="dk-empty">加载中…</div>'; return }
        if (state.members.length === 0) { box.innerHTML = '<div class="dk-empty">暂无成员记录 —— 群友发言后自动出现(官方成员列表未开放)</div>'; return }
        box.innerHTML = state.members.map(function (m) {
          var busying = state.busy === 'm-' + m.mid
          return '<div class="dk-item">'
            + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(m.name || '(未知名)') + ' · ' + esc(String(m.mid).slice(0, 10)) + '…</span>'
            + '<input class="qqs-txt" data-min="' + esc(m.mid) + '" type="number" min="1" value="' + esc(state.muteSecs) + '" style="width:64px">'
            + '<span style="color:#999;font-size:12px">分钟</span>'
            + '<button class="dk-btn no" data-mute="' + esc(m.mid) + '"' + (busying ? ' disabled' : '') + '>' + (busying ? '处理中…' : '禁言') + '</button>'
            + '</div>'
        }).join('')
        box.querySelectorAll('input[data-min]').forEach(function (inp) {
          inp.oninput = function () { state.muteSecs = inp.value }
        })
        box.querySelectorAll('button[data-mute]').forEach(function (btn) {
          btn.onclick = function () { doMute(btn.getAttribute('data-mute'), 'mute', Number(state.muteSecs || 60) * 60) }
        })
      }
      function renderMuteList() {
        var box = panel.querySelector('#dk-mute-list')
        if (!box) return
        if (state.mutes === null) { box.innerHTML = '<div class="dk-empty">加载中…</div>'; return }
        if (state.mutes.length === 0) { box.innerHTML = '<div class="dk-empty">没有正在禁言的成员</div>'; return }
        box.innerHTML = state.mutes.map(function (m) {
          var busying = state.busy === 'm-' + m.member_openid
          return '<div class="dk-item">'
            + '<span style="flex:1">' + esc(m.username || String(m.member_openid).slice(0, 12)) + '</span>'
            + '<span style="color:#999;font-size:12px">至 ' + esc(String(m.expire || '').replace('T', ' ').slice(0, 16)) + '</span>'
            + '<button class="dk-btn" data-um="' + esc(m.member_openid) + '"' + (busying ? ' disabled' : '') + '>' + (busying ? '处理中…' : '解除') + '</button>'
            + '</div>'
        }).join('')
        box.querySelectorAll('button[data-um]').forEach(function (btn) {
          btn.onclick = function () { doMute(btn.getAttribute('data-um'), 'unmute') }
        })
      }
      function renderPanel() {
        panel.innerHTML = '<div class="dk-h"></div><div class="dk-detect"></div><div class="dk-b"></div>'
        paintHead(); paintDetect(); paintBody()
        if (state.tab === 'join') loadJoins()
        // 每次展开都重查当前 web 会话(跟随主人切换会话; 不打断已有手动选择)
        if (sessionsSvc || true) { reDetectAndSelect() }
      }
      // 检测状态条: 显示 web 当前会话的 sessionId 与反查结果(悬浮球调试/自动选中依据)
      function paintDetect() {
        if (!panel || !open) return
        var d = panel.querySelector('.dk-detect')
        if (!d) return
        var det = state.detected
        var sids = (det && det.sid) || ''
        var srcLbl = det ? (det.src === 'sessions.list' ? 'sessions.list' : det.src === 'localStorage' ? 'localStorage' : '未检测到') : '检测中…'
        var hit = state.detectedHit
        var hitTxt = '未命中 QQ 会话'
        if (hit) {
          hitTxt = (hit.scope === 'group' ? '群「' : '私聊「') + esc((hit.name || '') + '」' + (hit.ns ? ' [' + hit.ns + ']' : '')) + (hit.peerId ? ' · ' + hit.peerId.slice(0, 10) + '…' : '')
        }
        d.innerHTML = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 14px;background:#f4f0ff;border-bottom:1px solid #efe8ff;font-size:12px;color:#4a3a9f">'
          + '<span style="font-weight:700">📡 当前会话</span>'
          + '<span style="color:#666">来源:' + esc(srcLbl) + '</span>'
          + (sids ? '<code style="font-size:11px;background:#fff;border:1px solid #e3d9ff;border-radius:5px;padding:1px 6px">' + esc(sids.slice(0, 36)) + (sids.length > 36 ? '…' : '') + '</code>' : '<span style="color:#999">(无)</span>')
          + '<span style="color:#2f9e44">→ ' + hitTxt + '</span>'
          + '<button class="dk-btn" id="dk-redetect" style="padding:1px 8px;font-size:11px;margin-left:auto">🔄 重查</button>'
          + '</div>'
        var btn = d.querySelector('#dk-redetect')
        if (btn) btn.onclick = function () { reDetectAndSelect() }
      }
      // 重新检测当前 web 会话并自动选中对应 QQ 目标
      function reDetectAndSelect() {
        state.detected = null; state.detectedHit = null
        state.wantPeer = null
        paintDetect()
        lookupCurrentSession(function (hit) {
          // ⚠️ 2026-09-28 修：只滤 disabled 不够 —— 插件 bundle 自动注入的「幽灵实例」
          //   (id: im-qqbot，凭据是占位符 __FROM_ENV__) 的 disabled 是 false，
          //   它只是【没有 appId】。它一旦被当成"当前账号"，面板就会读它的空配置，
          //   于是评分模式等全部回落成 schema 默认值（看着像"设置全被重置"）。
          function realOnly(list) {
            return (Array.isArray(list) ? list : []).filter(function (a) {
              return a && !a.disabled && a.appId
            })
          }
          if (!state.accts.length) { api('accounts').then(function (dd) { var list = realOnly(dd && dd.instances); state.accts = list; applyHit(hit, list) }) }
          else applyHit(hit, realOnly(state.accts))
        })
      }
      function applyHit(hit, list) {
        if (hit && list.length) {
          state.ns = hit.ns || list[0].ns || ''
          state.wantPeer = { scope: hit.scope, peerId: hit.peerId }
          if (hit.scope === 'c2c') { state.sendScope = 'c2c'; state.sendTo = hit.peerId; state.sendName = hit.name || '' }
          else { state.sendScope = 'group'; state.gid = hit.peerId }
        } else if (list.length && !state.ns) {
          // 反查不到（例如切到了非 QQ 会话）→ 回落到第一个【真实例】，
          // ⚠️ 绝不能落到幽灵实例，否则整个面板会显示成默认值。
          state.ns = list[0].ns || ''
        }
        refreshAll(); paintHead(); paintDetect()
      }
      loadAccts()
      // 首次自动展开?不——保持球形态(审批/提问仍走打断弹出)。主人点开才展开。
      closePanel()
    }


    // ═════════════════════════════════════════════════════════════════════════
    // 「QQ机器人扩展」会话页签（2026-10-24）
    //
    // 会话页顶部与「对话 / 轨迹 / 记忆 / 白板看板」并列，进会话就能看到当前工作区
    // 装了哪些扩展，不用切到设置页。数据来源 GET /api/qqbot-settings/extensions。
    //
    // 两块来源：
    //   · 内置扩展   {dataRoot}/.qqbot-extensions/{tools,commands,...}/
    //   · 扩展包     {dataRoot}/extension-packs/{包名}/{同样的子目录}/
    //     包目录里放 qqbot-pack.json 可声明 name/author/desc/version
    // ═════════════════════════════════════════════════════════════════════════
    var _lastCwd = ''
    var _lastSid = ''
    // 当前会话工作区（跟随 GUI 切换工作区）：与 dsh-auto-memory 的 currentWs() 同一套取法
    // sessions.list.getSnapshot().byId[current].cwd 是官方 buildListSnapshot 投影出来的权威字段
    /** 取当前会话 id（cwd 拿不到时后端靠它反查工作区） */
    function curSessionId() {
      try {
        var svc = _extSessionsSvc
        if (svc && svc.list && typeof svc.list.getSnapshot === 'function') {
          var snap = svc.list.getSnapshot()
          if (snap && snap.current) return String(snap.current)
        }
      } catch (e) {}
      try {
        var raw = localStorage.getItem('dsh.sessions.current')
        if (raw) { var o = JSON.parse(raw); if (o && o.sessionId) return String(o.sessionId) }
      } catch (e) {}
      return ''
    }

    /**
     * 当前会话是不是 QQ 会话（2026-10-28）。
     * 同一次查询在窗口内共享 —— 悬浮球显隐、扩展页签显隐都走这里，不重复打后端。
     * ⚠️ 否定结论只缓存 2 秒：宿主刚启动时后端可能还没就绪，长缓存会让悬浮球一直不出现。
     */
    function qqHitOf(sid, cb) {
      if (!sid) { try { cb(false) } catch (e0) {} ; return }
      var c = (window.__qqsHitCache = window.__qqsHitCache || {})
      var e = c[sid]
      if (e && Date.now() - e.at < (e.hit ? 10000 : 2000)) { try { cb(e.hit) } catch (e1) {} ; return }
      try {
        fetch('api/qqbot-settings/session-lookup?sessionId=' + encodeURIComponent(sid))
          .then(function (r) { return r.json() })
          .then(function (d) {
            var hit = !!(d && d.hits && d.hits.length)
            c[sid] = { at: Date.now(), hit: hit }
            try { cb(hit) } catch (e2) {}
          })
          .catch(function () { try { cb(false) } catch (e3) {} })
      } catch (e4) { try { cb(false) } catch (e5) {} }
    }

    // （2026-10-28）页签显隐不用 DOM 方案了 —— 见 apply() 里的 setExtTabVisible：
    //   `slots.inject` 的返回值是 disposer，注销后宿主自己会刷新页签列表。

    function curWorkspaceCwd() {
      try {
        var svc = _extSessionsSvc
        if (svc && svc.list && typeof svc.list.getSnapshot === 'function') {
          var snap = svc.list.getSnapshot()
          if (!snap) return ''
          var id = snap.current
          if (id === undefined || id === null) return ''
          var row = snap.byId && snap.byId[id]
          if (row && typeof row.cwd === 'string') return row.cwd
        }
      } catch (e) {}
      // 兜底：宿主持久化镜像（dock 球也在用这个键）
      try {
        var raw = localStorage.getItem('dsh.sessions.current')
        if (raw) { var o = JSON.parse(raw); if (o && o.cwd) return String(o.cwd) }
      } catch (e) {}
      return ''
    }

    var EXT_KIND_META = [
      { key: 'tools',     label: '扩展工具', icon: '🔧', hint: '模型可调用的工具' },
      { key: 'commands',  label: '斜杠命令', icon: '⌘',  hint: '/ 开头的命令' },
      { key: 'botplay',   label: '游戏裁判', icon: '🎲', hint: '群内小游戏' },
      { key: 'hooks',     label: '事件钩子', icon: '🪝', hint: '生命周期回调' },
      { key: 'inbound',   label: '入站处理', icon: '📥', hint: '消息进模型前' },
      { key: 'outbound',  label: '出站处理', icon: '📤', hint: '模型输出后' },
    ]

    function ExtPanel() {
      var _a = useState(null), data = _a[0], setData = _a[1]
      var _b = useState(true), loading = _b[0], setLoading = _b[1]
      var _c = useState(''), err = _c[0], setErr = _c[1]
      var _d = useState('builtin'), tab = _d[0], setTab = _d[1]
      var _e = useState(0), tick = _e[0], setTick = _e[1]
      var _sel = useState(null), sel = _sel[0], setSel = _sel[1]   // 正在编辑哪个扩展的设置
      function openSettings(info) { setSel(info) }
      // 首次进市场页签 -> 拉一次索引
      useEffect(function () { if (tab === 'market' && !market && !loadingMarket) loadMarket() }, [tab])
      var _filter = useState(''), filter = _filter[0], setFilter = _filter[1]
      var _tog = useState(false), toggling = _tog[0], setToggling = _tog[1]
      function toggleExt(info) {
        setToggling(true)
        var body = { kind: info.kind, file: info.file, enabled: info.enabled }
        var cw = curWorkspaceCwd()
        if (cw) body.cwd = cw
        fetch('api/qqbot-settings/ext-toggle', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (!d || d.ok === false) { console.warn('[ext-toggle] 失败', d); }
            else if (d.reloaded) {
              var r = d.reloaded
              var bits = []
              if (r.commands) bits.push('命令 ' + r.commands)
              if (r.inbound) bits.push('入站 ' + r.inbound)
              if (r.outbound) bits.push('出站 ' + r.outbound)
              var tail = r.tools ? '；工具' + r.tools : ''
              console.log('[ext-toggle] 热重载:', bits.join(' / ') + tail)
              if (typeof window !== 'undefined' && window.__qqsExtToast) window.__qqsExtToast(bits.join(' / ') + tail)
            }
            setTick(function (n) { return n + 1 })
          })
          .catch(function (e) { console.warn('[ext-toggle] 异常', e) })
          .then(function () { setToggling(false) })
      }
      // ── 插件市场（2026-10-24）──
      var _market = useState(null), market = _market[0], setMarket = _market[1]
      var _loadingMarket = useState(false), loadingMarket = _loadingMarket[0], setLoadingMarket = _loadingMarket[1]
      var _searchMarket = useState(''), searchMarket = _searchMarket[0], setSearchMarket = _searchMarket[1]
      var _busyId = useState(''), busyId = _busyId[0], setBusyId = _busyId[1]
      var marketCount = (market && market.index && market.index.plugins) ? market.index.plugins.length : 0

      function loadMarket() {
        setLoadingMarket(true)
        var cw = curWorkspaceCwd()
        var qs = cw ? ('?cwd=' + encodeURIComponent(cw)) : ''
        fetch('api/qqbot-settings/market' + qs, { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) { if (d && d.ok) setMarket(d); else console.warn('[market] 读取失败', d) })
          .catch(function (e) { console.warn('[market] 异常', e) })
          .then(function () { setLoadingMarket(false) })
      }
      function marketPost(path, body) {
        var cw = curWorkspaceCwd()
        if (cw) body.cwd = cw
        return fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })   // 返回原始 Response：调用方要看 r.ok 判断 HTTP 状态，并自己 r.text()
      }
      function onInstall(info) {
        setBusyId(info.id)
        marketPost('api/qqbot-settings/market/install', { id: info.id })
          .then(function (r) {
            return r.text().then(function (txt) {
              var d = null
              try { d = JSON.parse(txt) } catch (e) { d = { error: String(txt).slice(0, 200) } }
              if (!r.ok || !d || d.ok === false) {
                console.warn('[market] 安装失败 HTTP', r.status, d)
                var why = (d && (d.error || '')) || ('HTTP ' + r.status)
                var tag = (d && d.stage) ? ('［' + d.stage + '］') : ''
                if (window.__qqsExtToast) window.__qqsExtToast('安装失败' + tag + '：' + why)
                return
              }
              if (window.__qqsExtToast) window.__qqsExtToast('已安装 ' + info.id + '（' + d.written + '/' + d.total + ' 个文件）')
            })
          })
          .catch(function (e) { console.warn('[market] 安装异常', e); if (window.__qqsExtToast) window.__qqsExtToast('安装异常：' + e) })
          .then(function () { setBusyId(''); loadMarket(); setTick(function (n) { return n + 1 }) })
      }
      // ── 市场代理配置（2026-10-24 主人要求：墙内要能填代理）──
      var _proxyInput = useState(''), proxyInput = _proxyInput[0], setProxyInput = _proxyInput[1]
      var _savingProxy = useState(false), savingProxy = _savingProxy[0], setSavingProxy = _savingProxy[1]
      var _proxyInited = useState(false), proxyInited = _proxyInited[0], setProxyInited = _proxyInited[1]
      useEffect(function () {
        if (market && !proxyInited) { setProxyInput(market.proxy || ''); setProxyInited(true) }
      }, [market])
      function onSaveProxy() {
        setSavingProxy(true)
        var cw = curWorkspaceCwd()
        var body = { proxy: String(proxyInput || '').trim() }
        if (cw) body.cwd = cw
        fetch('api/qqbot-settings/market/config', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (!d || d.ok === false) {
              if (window.__qqsExtToast) window.__qqsExtToast('代理保存失败：' + ((d && d.error) || '未知'))
            } else {
              if (window.__qqsExtToast) window.__qqsExtToast(body.proxy ? ('代理已设为 ' + body.proxy + '，重新拉索引…') : '已切回直连，重新拉索引…')
              setProxyInited(false)
              setMarket(null)
              loadMarket()
            }
          })
          .catch(function (e) { if (window.__qqsExtToast) window.__qqsExtToast('保存异常：' + e) })
          .then(function () { setSavingProxy(false) })
      }

      function onRemove(info) {
        setBusyId(info.id)
        marketPost('api/qqbot-settings/market/remove', { id: info.id })
          .then(function (r) {
            return r.text().then(function (txt) {
              var d = null
              try { d = JSON.parse(txt) } catch (e) { d = { error: String(txt).slice(0, 200) } }
              if (!r.ok || !d || d.ok === false) {
                var why = (d && (d.error || '')) || ('HTTP ' + r.status)
                if (window.__qqsExtToast) window.__qqsExtToast('卸载失败：' + why)
                return
              }
              if (window.__qqsExtToast) window.__qqsExtToast('已卸载 ' + info.id)
            })
          })
          .catch(function (e) { console.warn('[market] 卸载异常', e) })
          .then(function () { setBusyId(''); loadMarket(); setTick(function (n) { return n + 1 }) })
      }

      // 工作区切换后自动重载：cwd 一变就刷新
      useEffect(function () {
        var nowCwd = curWorkspaceCwd()
        var nowSid = curSessionId()
        if ((nowCwd && nowCwd !== _lastCwd) || (nowSid && nowSid !== _lastSid)) {
          _lastCwd = nowCwd; _lastSid = nowSid
          setTick(function (n) { return n + 1 })
        }
      })

      useEffect(function () {
        var dead = false
        setLoading(true)
        var _cwd = curWorkspaceCwd()
        var _sid = curSessionId()
        var _qs = []
        if (_cwd) _qs.push('cwd=' + encodeURIComponent(_cwd))
        if (_sid) _qs.push('sid=' + encodeURIComponent(_sid))
        var _url = 'api/qqbot-settings/extensions' + (_qs.length ? ('?' + _qs.join('&')) : '')
        fetch(_url, { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) { if (!dead) { setData(d); setErr(d && d.ok === false ? (d.error || '未知错误') : ''); } })
          .catch(function (e) { if (!dead) setErr(String((e && e.message) || e)) })
          .then(function () { if (!dead) setLoading(false) })
        return function () { dead = true }
      }, [tick])

      var S = extStyles()

      if (loading && !data) return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读取扩展…'))
      if (err) return h('div', { style: S.wrap },
        h('div', { style: S.errBox }, '读取失败：' + err),
        h('button', { style: S.btn, onClick: function () { setTick(tick + 1) } }, '重试'))
      if (!data) return h('div', { style: S.wrap }, h('div', { style: S.hint }, '暂无数据'))

      // 汇总计数
      var builtinTotal = data.builtin ? data.builtin.total : 0
      var packList = data.packs || []
      var packTotal = packList.reduce(function (n, p) { return n + (p.total || 0) }, 0)
      var settingsCount = (data.settingsPages || []).length

      // 当前 tab 的内容块列表
      var groups = []
      if (tab === 'builtin') {
        groups = [{ title: '内置扩展', subtitle: data.builtinRoot || '', kinds: (data.builtin || {}).kinds || {}, isPack: false }]
      } else if (tab === 'packs') {
        groups = packList.map(function (p) {
          var meta = p.meta || {}
          return {
            title: meta.name || p.dirName,
            subtitle: [
              meta.author ? ('作者 ' + meta.author) : '',
              meta.version ? ('v' + meta.version) : '',
              // 2026-10-25：扩展包可声明「需要的最低插件版本」，这里直接对照当前插件版本
              p.minPluginVersion
                ? ((p.versionOk === false)
                  ? ('⚠ 需要插件 ≥ v' + p.minPluginVersion + '（当前 v' + (data.pluginVersion || '?') + '）')
                  : ('需要插件 v' + p.minPluginVersion))
                : '',
              meta.desc || '',
            ].filter(Boolean).join(' · ') || p.dir,
            kinds: p.kinds || {},
            isPack: true,
            raw: p,
          }
        })
      } else {
        // 设置页 tab
        groups = []
      }

      function kindRows(kinds, kindMeta, onOpen) {
        var list = (kinds && kinds[kindMeta.key]) || []
        if (!list.length) return null
        return h('div', { key: kindMeta.key, style: S.kindBlock },
          h('div', { style: S.kindHead },
            h('span', { style: S.kindIcon }, kindMeta.icon),
            h('span', { style: S.kindLabel }, kindMeta.label),
            h('span', { style: S.kindCount }, String(list.length)),
            h('span', { style: S.kindHint }, kindMeta.hint)),
          h('div', { style: S.chipWrap },
            list.map(function (it) {
              return h('span', {
                key: it.id,
                style: it.hasSettings ? S.chipClickable : S.chip,
                title: it.name + '  ·  ' + Math.round(it.size / 102.4) / 10 + ' KB' + (it.hasSettings ? '（点击打开设置）' : ''),
                onClick: it.hasSettings ? function () { onOpen({ kind: kindMeta.key, file: it.name }) } : undefined,
              }, it.id, it.hasSettings ? h('span', { style: S.gear }, ' ⚙') : null)
            })))
      }

      return h('div', { style: S.wrap },
        // 头部
        h('div', { style: S.head },
          h('div', null,
            h('div', { style: S.title }, 'QQ 机器人扩展'),
            h('div', { style: S.sub }, '当前工作区已装的扩展；放独立目录的扩展包也能在这里看到')),
          h('button', { style: S.btn, onClick: function () { setTick(tick + 1) } }, loading ? '刷新中…' : '刷新')),

        // 统计卡
        h('div', { style: S.stats },
          statCard(S, '内置扩展', builtinTotal, '个文件'),
          statCard(S, '扩展包', packList.length, '个包 · 共 ' + packTotal + ' 个扩展'),
          statCard(S, '带设置页', settingsCount, '个扩展可配置')),

        // 路径提示
        h('div', { style: S.pathBox },
          h('div', { style: S.pathRow }, h('span', { style: S.pathKey }, '当前工作区'), h('code', { style: S.code }, (data.workspaceCwd || curWorkspaceCwd() || '（未识别，回退到默认数据根）'),
            data.workspaceFrom && data.workspaceFrom !== 'default'
              ? h('span', { style: { fontSize: 10.5, opacity: .6, marginLeft: 6 } }, 'via ' + data.workspaceFrom)
              : null)),
          h('div', { style: S.pathRow }, h('span', { style: S.pathKey }, '内置目录'), h('code', { style: S.code }, data.builtinRoot || '—')),
          h('div', { style: S.pathRow }, h('span', { style: S.pathKey }, '扩展包目录'), h('code', { style: S.code }, data.packsRoot || '—'))),
          // 2026-10-25 主人要求：面板上要能直接看到当前装的 qqbot 插件版本
          h('div', { style: S.pathRow }, h('span', { style: S.pathKey }, '插件版本'), h('code', { style: S.code }, data.pluginVersion ? ('v' + data.pluginVersion) : '—')),

        // 页签
        h('div', { style: S.tabs },
          tabBtn(S, '内置扩展', 'builtin', tab, setTab, builtinTotal),
          tabBtn(S, '扩展包', 'packs', tab, setTab, packList.length),
          tabBtn(S, '设置中心', 'settings', tab, setTab, settingsCount),
          tabBtn(S, '市场', 'market', tab, setTab, marketCount)),

        // 内容
        tab === 'market'
          ? renderMarket(S, market, loadingMarket, searchMarket, setSearchMarket, onInstall, onRemove, busyId, proxyInput, setProxyInput, onSaveProxy, savingProxy)
          : tab === 'settings'
          ? renderSettingsCenter(S, data, filter, setFilter, openSettings, toggleExt, toggling)
          : (groups.length
            ? groups.map(function (g, gi) {
                var hasAny = EXT_KIND_META.some(function (k) { return ((g.kinds || {})[k.key] || []).length > 0 })
                return h('div', { key: gi, style: S.group },
                  h('div', { style: S.groupHead },
                    h('span', { style: S.groupTitle }, g.title),
                    h('span', { style: S.groupSub }, g.subtitle)),
                  hasAny
                    ? EXT_KIND_META.map(function (k) { return kindRows(g.kinds, k, openSettings) })
                    : h('div', { style: S.empty }, '这个' + (g.isPack ? '包' : '目录') + '里还没放扩展'))
              })
            : h('div', { style: S.empty }, tab === 'packs' ? '还没有扩展包。在 ' + (data.packsRoot || '') + ' 下建一个子文件夹，里面按 tools/commands/… 放扩展即可。' : '没有扩展'))
        ,
        sel ? h(ExtSettings, { kind: sel.kind, file: sel.file, cwd: (data && data.workspaceCwd) || '', onClose: function () { setSel(null) } }) : null
      )
    }

    /**
     * 扩展自定义设置面板（2026-10-24）
     *
     * 扩展在文件里声明：
     *   export const qqbotSettingsPage = {
     *     title: '我的设置',
     *     schema: [
     *       { key:'enabled', type:'bool',   label:'启用' },
     *       { key:'dirs',    type:'list',   label:'目录列表' },
     *       { key:'apiKey',  type:'string', label:'API Key', secret:true },
     *       { key:'mode',    type:'select', label:'模式', options:['a','b'] },
     *     ],
     *   }
     * 面板自动渲染表单，值存 {dataRoot}/.qqbot-extensions/.state/ext-config/{扩展id}.json
     */
    function ExtSettings(props) {
      var kind = props.kind, file = props.file, cwd = props.cwd, onClose = props.onClose
      var _a = useState(null), data = _a[0], setData = _a[1]
      var _b = useState({}), vals = _b[0], setVals = _b[1]
      var _c = useState(true), loading = _c[0], setLoading = _c[1]
      var _d = useState(''), msg = _d[0], setMsg = _d[1]
      var _e = useState(''), err = _e[0], setErr = _e[1]

      useEffect(function () {
        var dead = false
        setLoading(true); setErr('')
        var qs = '?kind=' + encodeURIComponent(kind) + '&file=' + encodeURIComponent(file)
        if (cwd) qs += '&cwd=' + encodeURIComponent(cwd)
        fetch('api/qqbot-settings/ext-panel' + qs, { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (dead) return
            if (!d || d.ok === false) { setErr((d && d.error) || '读取失败'); return }
            setData(d)
            setVals(d.values && typeof d.values === 'object' ? d.values : {})
          })
          .catch(function (e) { if (!dead) setErr(String((e && e.message) || e)) })
          .then(function () { if (!dead) setLoading(false) })
        return function () { dead = true }
      }, [kind, file, cwd])

      function save() {
        setMsg(''); setErr('')
        fetch('api/qqbot-settings/ext-panel', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: kind, file: file, cwd: cwd, values: vals }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) setMsg('已保存 → ' + (d.configPath || ''))
            else setErr((d && d.error) || '保存失败')
          })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
      }

      var S = extStyles()
      var page = (data && data.page) || {}
      var schema = page.schema || []
      var title = page.title || (data && data.extId) || file

      return h('div', { style: S.modalMask, onClick: onClose },
        h('div', { style: S.modalBox, onClick: function (e) { e.stopPropagation() } },
          h('div', { style: S.modalHead },
            h('div', null,
              h('div', { style: S.modalTitle }, title + ' · 设置'),
              h('div', { style: S.modalSub }, kind + '/' + file)),
            h('button', { style: S.btn, onClick: onClose }, '关闭')),

          loading ? h('div', { style: S.hint }, '读取中…') :
          err ? h('div', { style: S.errBox }, err) :
          (schema.length === 0
            ? h('div', null,
                h('div', { style: S.empty },
                  page._err ? ('读取失败：' + page._err)
                  : page._miss ? ('文件里没有 qqbotSettingsPage。实际导出：' + (page._keys || []).join(', '))
                  : '这个扩展没有声明配置项。'),
                h('div', { style: S.emptyHint },
                  page._err || page._miss
                    ? '检查扩展文件里的 export const qqbotSettingsPage = { title, schema: [...] } 写法。'
                    : '在它的文件里 export const qqbotSettingsPage = { title, schema: [...] } 即可在这里出现表单。'))
            : h('div', null,
                schema.map(function (f, i) { return renderExtField(S, f, i, vals, setVals) }),
                h('div', { style: S.modalFoot },
                  h('button', { style: S.btnPrimary, onClick: save }, '保存'),
                  msg ? h('span', { style: S.savedMsg }, msg) : null,
                  err ? h('span', { style: S.errMsg }, err) : null))),

          data && data.configPath
            ? h('div', { style: S.cfgPath }, '配置文件：', h('code', { style: S.code }, data.configPath))
            : null))
    }

    /** 按 schema 渲染一个字段 */
    function renderExtField(S, f, i, vals, setVals) {
      var key = f.key || ('f' + i)
      var val = vals[key]
      if (val === undefined && f.default !== undefined) val = f.default
      function upd(v) { var o = Object.assign({}, vals); o[key] = v; setVals(o) }
      var label = f.label || key
      var hint = f.hint || f.description || ''

      var control
      if (f.type === 'bool') {
        control = h('input', { type: 'checkbox', checked: !!val, onChange: function (e) { upd(e.target.checked) } })
      } else if (f.type === 'number') {
        control = h('input', { type: 'number', style: S.fieldInput, value: val === undefined ? '' : val,
          onChange: function (e) { var v = e.target.value; upd(v === '' ? undefined : Number(v)) } })
      } else if (f.type === 'select') {
        var opts = Array.isArray(f.options) ? f.options : []
        // 统一成 [{v: 实际值, t: 显示文本}]
        var normOpts = opts.map(function (o) {
          var v = (o && typeof o === 'object') ? (o.value !== undefined ? o.value : o.label) : o
          var t = (o && typeof o === 'object') ? (o.label || o.value) : o
          return { v: String(v), t: String(t) }
        })
        if (f.searchable) {
          // ★ 可搜索下拉（2026-10-26）：选项很多时（比如 294 个 TTS 音色）原生 select 没法找。
          //   用 <input list=datalist>：浏览器原生支持输入过滤，且允许手填列表外的值。
          //   datalist 的 option.value 用「显示文本」，这样搜中文名、选中后存进去的也是那一整串；
          //   读取侧（如 lib/settings.mjs 的 resolveVoice）需要自己从「中文名｜id」里剥出真值。
          var dlId = 'qqs-dl-' + String(f.key || 'f')
          control = h('div', null,
            h('input', {
              type: 'text',
              list: dlId,
              style: Object.assign({}, S.fieldInput, { width: '100%' }),
              value: val === undefined || val === null ? '' : String(val),
              placeholder: f.placeholder || ('输入关键字筛选（共 ' + normOpts.length + ' 项，也可直接手填值）'),
              onInput: function (e) { upd(e.target.value) },
              onChange: function (e) { upd(e.target.value) },
            }),
            h('datalist', { id: dlId },
              normOpts.map(function (o) {
                return h('option', { key: o.v, value: o.t })
              })))
        } else {
          control = h('select', { style: S.fieldInput, value: val === undefined ? '' : val,
            onChange: function (e) { upd(e.target.value) } },
            normOpts.map(function (o) {
              return h('option', { key: o.v, value: o.v, style: { background: '#2a2a2e', color: '#e8e8ea' } }, o.t)
            }))
        }
      } else if (f.type === 'list') {
        var arr = Array.isArray(val) ? val : []
        control = h('div', null,
          h('textarea', { style: Object.assign({}, S.fieldInput, { minHeight: 62, resize: 'vertical' }),
            value: arr.join('\n'),
            placeholder: '一行一项',
            onChange: function (e) { upd(e.target.value.split('\n').map(function (x) { return x.trim() }).filter(Boolean)) } }))
      } else {
        control = h('input', {
          type: f.secret ? 'password' : 'text',
          style: S.fieldInput,
          value: val === undefined ? '' : String(val),
          placeholder: f.placeholder || '',
          onChange: function (e) { upd(e.target.value) },
        })
      }

      return h('div', { key: key, style: S.field },
        h('div', { style: S.fieldLabel }, label, f.secret ? h('span', { style: S.secretTag }, ' 密钥') : null),
        control,
        hint ? h('div', { style: S.fieldHint }, hint) : null)
    }

    /**
     * 「设置中心」（2026-10-24 主人要求）
     *
     * 原「设置页」tab 只是把带 ⚙ 的扩展又列一遍、还点不动 —— 没有存在价值。
     * 改成：列出**全部扩展**（内置 + 各扩展包），每行能
     *   · 点「设置」打开它的设置弹层（有声明才可点）
     *   · 开关启停（启停状态存 .state/ext-disabled.json，扫描器会跳过停用的）
     * 顶部带搜索框。
     */
    function renderSettingsCenter(S, data, filter, setFilter, onOpen, onToggle, toggling) {
      // 汇总所有扩展
      var rows = []
      var push = function (list, from, isPack) {
        for (var i = 0; i < list.length; i++) {
          var it = list[i]
          rows.push({
            key: from + '/' + it.name,
            id: it.id,
            name: it.name,
            kind: '',
            from: from,
            isPack: isPack,
            hasSettings: !!it.hasSettings,
            settingsTitle: it.settingsTitle || '',
            disabled: !!it.disabled,
            size: it.size || 0,
          })
        }
      }
      var groupsForList = []
      // 内置（按六类）
      var bk = (data.builtin && data.builtin.kinds) ? data.builtin.kinds : {}
      for (var ki = 0; ki < EXT_KIND_META.length; ki++) {
        var km = EXT_KIND_META[ki]
        var list = bk[km.key] || []
        for (var j = 0; j < list.length; j++) {
          var it = list[j]
          rows.push({ key: 'builtin/' + km.key + '/' + it.name, id: it.id, name: it.name, kind: km.key, kindLabel: km.label,
            from: '内置', isPack: false, hasSettings: !!it.hasSettings, settingsTitle: it.settingsTitle || '',
            disabled: !!it.disabled, size: it.size || 0 })
        }
      }
      // 扩展包
      var packs = data.packs || []
      for (var pi = 0; pi < packs.length; pi++) {
        var p = packs[pi]
        var pn = (p.meta && p.meta.name) || p.dirName
        for (var k2 = 0; k2 < EXT_KIND_META.length; k2++) {
          var km2 = EXT_KIND_META[k2]
          var l2 = (p.kinds && p.kinds[km2.key]) || []
          for (var m = 0; m < l2.length; m++) {
            var it2 = l2[m]
            rows.push({ key: 'pack/' + p.dirName + '/' + km2.key + '/' + it2.name, id: it2.id, name: it2.name,
              kind: km2.key, kindLabel: km2.label, from: pn, isPack: true,
              hasSettings: !!it2.hasSettings, settingsTitle: it2.settingsTitle || '',
              disabled: !!it2.disabled, size: it2.size || 0 })
          }
        }
      }

      var q = String(filter || '').trim().toLowerCase()
      var shown = q ? rows.filter(function (r) { return (r.name + ' ' + r.from + ' ' + r.kindLabel).toLowerCase().indexOf(q) >= 0 }) : rows

      return h('div', null,
        // 搜索框
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
          h('input', {
            style: Object.assign({}, S.fieldInput, { maxWidth: 280, marginBottom: 0 }),
            placeholder: '搜索扩展名 / 来源 / 类型…',
            value: filter,
            onChange: function (e) { setFilter(e.target.value) },
          }),
          h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-text-secondary, #9a9aa0)' } },
            shown.length + ' / ' + rows.length + ' 个扩展')),

        shown.length === 0
          ? h('div', { style: S.empty }, q ? ('没有匹配「' + filter + '」的扩展') : '没有扩展')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              shown.map(function (r) {
                return h('div', { key: r.key, style: S.settingRow },
                  // 名字
                  h('span', { style: { fontWeight: 500, minWidth: 150, opacity: r.disabled ? 0.5 : 1 } }, r.id),
                  // 类型
                  h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #9a9aa0)', minWidth: 68 } }, r.kindLabel || ''),
                  // 来源
                  h('span', { style: Object.assign({}, S.settingFrom, r.isPack ? { border: '1px solid ' + 'var(--dsw-alias-accent, #5b8def)' } : {}) }, r.from),
                  // 已配置标记
                  r.hasSettings ? h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-accent, #5b8def)' } }, '⚙ ' + (r.settingsTitle || '可配置')) : null,
                  // 右侧操作
                  h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
                    r.hasSettings
                      ? h('button', {
                          style: { padding: '3px 12px', fontSize: 12, borderRadius: 5, border: '1px solid var(--dsw-alias-accent, #5b8def)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
                          onClick: function () { onOpen({ kind: r.kind, file: r.name }) },
                        }, '设置')
                      : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary, #9a9aa0)' } }, '—'),
                    // 启停开关
                    h('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, cursor: toggling ? 'wait' : 'pointer', opacity: toggling ? 0.6 : 1 } },
                      h('input', {
                        type: 'checkbox',
                        checked: !r.disabled,
                        disabled: !!toggling,
                        onChange: function (e) { onToggle({ kind: r.kind, file: r.name, enabled: e.target.checked }) },
                      }),
                      r.disabled ? h('span', { style: { color: 'var(--dsw-alias-text-secondary, #9a9aa0)' } }, '已停用') : h('span', null, '启用'))))
              })))
    }

    /**
     * 插件市场（2026-10-24）
     * 索引来自 GitHub 仓库 zaofan-make/dsh-qqbot-plugins 的 index.json
     */
    /** 市场专用样式（2026-10-24）：内联 style 管不了 ::placeholder 和主题变量，只能插 CSS */
    /**
     * 判断当前是深色还是浅色主题。
     *
     * 为什么不用 CSS 变量：DSH 的 --dsw-alias-* 变量名没法确认，
     * 猜错时 fallback 会在深色模式下变成黑字（2026-10-24 主人实测踩到）。
     * 直接量一下背景亮度最可靠。
     */
    function qqsIsDarkTheme() {
      try {
        var el = document.body || document.documentElement
        var bg = ''
        // 往上找一个有不透明背景的祖先，body 有时是透明的
        var node = el
        for (var i = 0; i < 6 && node; i++) {
          var cs = window.getComputedStyle(node)
          var c2 = cs.backgroundColor || ''
          var m0 = c2.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/)
          if (m0 && (m0[4] === undefined || parseFloat(m0[4]) > 0.5)) { bg = c2; break }
          node = node.parentElement
        }
        var m = String(bg).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
        if (m) {
          var r = +m[1], g = +m[2], b = +m[3]
          // 相对亮度（sRGB 近似）
          var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
          if (r + g + b > 24) return lum < 0.5
        }
      } catch (e) {}
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      } catch (e) {}
      return false
    }

    /**
     * 市场样式（2026-10-24 整体重写，不再叠补丁）
     *
     * 配色原则：
     *   · 全部走面板自己的主题变量 —— 面板在 body{} 里定义了亮色 token，
     *     在 body[data-ds-dark-theme]{} 里定义了暗色 token（宿主 ThemePresenter 切类）。
     *     所以用 var(--qqs-text) / var(--qqs-border) / var(--qqs-input) 就自动跟随主题，
     *     不需要自己判断深浅（之前猜 --dsw-alias-* 变量名，猜错导致深色下黑字）。
     *   · 主人要求：**除标题外的字也不要灰色**，所以描述/版本/标签全都用主文字色 var(--qqs-text)。
     *   · 卡片不填色块，只有一圈边框；图片框 4:3 固定，图片 contain 完整显示、四周留白。
     */
    /**
     * 市场配色：直接量页面真实颜色，把 rgb 写死进样式。
     *
     * 为什么不再用 CSS 变量：
     *   ① 猜 --dsw-alias-text-primary → 不存在，深色下 fallback 变黑字；
     *   ② 用面板的 --qqs-text → 实测取到的值和当前主题不符（浅色下拿到浅灰）。
     * 量出来的值一定对，代价是切主题后要刷新一次。
     */
    /**
     * 市场样式（2026-10-24 第四次，最终版）
     *
     * 三次失败的教训：
     *   ① 猜 --dsw-alias-text-primary → 变量不存在，深色下 fallback 黑字；
     *   ② 用 --qqs-text → 拿到的值和自己预期的主题不符；
     *   ③ 量背景亮度写死 rgb → 又引入额外不确定性。
     *
     * 根本问题其实一直是**我自己写的硬编码颜色**（inline style 的 color + CSS 里的 !important 色值），
     * 面板本身（ensureCss 注入的 qqs-css）是靠继承 DSH 主题的。
     * 所以这一版：**一个颜色都不写**，全部 inherit，让文字跟着面板走。
     * 只有边框给个中性灰（深浅主题下都看得见）。
     */
    /**
     * 市场样式（2026-10-24 定稿）
     *
     * 主人拍板：**不再跟随主题，统一白底黑字**。
     * 之前跟着主题走折腾了 5 版（猜变量 / 量亮度 / 继承 / token），
     * 每次都在「浅色下深底、深色下黑字」之间反复，索性写死最稳。
     *
     * 配色（全部硬编码）：
     *   卡片底 #fff / 文字 #1f2329 / 边框 #e2e5ea
     *   次要文字 #5a6270 / 弱化 #8a919c
     *   主色按钮 #7c6cf0
     */
    function ensureMarketCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('__qqsMarketCss')) return
      var st = document.createElement('style')
      st.id = '__qqsMarketCss'
      st.textContent = [
        /* ── 网格：两列等宽铺满 ── */
        '.qqs-mk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;align-items:stretch;width:100%;}',
        '@media (max-width:760px){.qqs-mk-grid{grid-template-columns:1fr;}}',

        /* ── 卡片：白底黑字 + 浅灰边框 ── */
        '.qqs-mk-card{background:#ffffff!important;color:#1f2329!important;'
          + 'border:1px solid #e2e5ea!important;border-radius:10px!important;'
          + 'height:100%;display:flex;flex-direction:column;box-sizing:border-box;'
          + 'padding:0 14px 14px 14px;overflow:hidden;}',
        '.qqs-mk-card:hover{border-color:#7c6cf0!important;}',
        '.qqs-mk-card *{color:inherit;}',

        /* ── 封面：4:3 固定框，contain 完整显示，四周留白 ── */
        '.qqs-mk-cover{width:100%;aspect-ratio:4/3;object-fit:contain;display:block;'
          + 'box-sizing:border-box;padding:10px;background:#f4f5f8;border-radius:6px;}',
        '.qqs-mk-cover-ph{width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;'
          + 'box-sizing:border-box;padding:10px;font-size:12px;color:#8a919c;background:#f4f5f8;border-radius:6px;}',

        /* ── 标题行 ── */
        '.qqs-mk-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 0 8px;}',
        '.qqs-mk-name{font-size:14.5px;font-weight:600;color:#1f2329;}',
        '.qqs-mk-meta{font-size:11.5px;color:#8a919c;}',

        /* ── 描述 ── */
        '.qqs-mk-desc{font-size:12.5px;line-height:1.65;color:#5a6270;flex:1 1 auto;'
          + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0 0 8px 0;}',

        /* ── 标签 ── */
        '.qqs-mk-tag{font-size:10.5px;padding:1px 7px;border-radius:4px;border:1px solid #e2e5ea;color:#5a6270;}',

        /* ── 按钮 ── */
        '.qqs-mk-btn{padding:4px 14px;font-size:12px;border-radius:5px;border:1px solid #7c6cf0;'
          + 'background:#7c6cf0;color:#fff!important;cursor:pointer;flex:0 0 auto;}',
        '.qqs-mk-btn:hover{background:#6b5ae6;}',
        '.qqs-mk-btn:disabled{opacity:.55;cursor:default;}',

        /* ── 卡片底部「作者说明」链接（2026-10-25）──
           一键跳到 GitHub 上这个包的目录，看作者自己写的 README。
           用 <a target=_blank>，DSH 的 Electron 壳会交给系统浏览器打开。 */
        '.qqs-mk-link{display:inline-block;margin-top:10px;font-size:11.5px;line-height:1.4;'
          + 'color:#7c6cf0!important;text-decoration:none;border-bottom:1px dashed rgba(124,108,240,.4);'
          + 'padding-bottom:1px;width:fit-content;cursor:pointer;}',
        '.qqs-mk-link:hover{color:#5b4fd6!important;border-bottom-color:#5b4fd6;border-bottom-style:solid;}',
        '.qqs-mk-ghost{padding:4px 14px;font-size:12px;border-radius:5px;border:1px solid #d0d5dd;'
          + 'background:#ffffff;color:#1f2329!important;cursor:pointer;flex:0 0 auto;}',
        '.qqs-mk-ghost:hover{border-color:#7c6cf0;color:#6b5ae6!important;}',

        /* ── 搜索框 / 代理框：白底黑字，看得见也能输入 ── */
        '.qqs-mk-search{background:#ffffff!important;color:#1f2329!important;'
          + 'border:1px solid #d0d5dd!important;box-sizing:border-box;}',
        '.qqs-mk-search::placeholder{color:#8a919c!important;opacity:1;}',
        '.qqs-mk-search:focus{outline:none!important;border-color:#7c6cf0!important;box-shadow:0 0 0 2px #7c6cf033!important;}',
      ].join('\n')
      document.head.appendChild(st)
    }

    function renderMarket(S, market, loading, search, setSearch, onInstall, onRemove, busyId, proxyInput, setProxyInput, onSaveProxy, savingProxy) {
      ensureMarketCss()
      var S2 = {
        card: { border: '1px solid var(--dsw-alias-border, #3a3a40)', borderRadius: 10, overflow: 'hidden', padding: '0 0 14px 0', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-primary, #252528)' },
        cardHead: { display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap', padding: '12px 16px 8px', borderBottom: '1px solid var(--dsw-alias-border, #3a3a40)' },
        cardName: { fontSize: 13.5, fontWeight: 600 },
        cardVer: { fontSize: 11 },
        cardDesc: { fontSize: 12, lineHeight: 1.6, margin: '0 16px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
        tag: { fontSize: 10.5, padding: '1px 7px', borderRadius: 4, border: '1px solid var(--dsw-alias-border, #3a3a40)', color: 'var(--dsw-alias-text-secondary, #9a9aa0)' },
        btnInstall: { padding: '4px 14px', fontSize: 12, borderRadius: 5, border: '1px solid var(--dsw-alias-accent, #5b8def)', background: 'var(--dsw-alias-accent, #5b8def)', color: '#fff', cursor: 'pointer' },
        btnGhost: { padding: '4px 14px', fontSize: 12, borderRadius: 5, border: '1px solid var(--dsw-alias-border, #3a3a40)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      }
      if (loading) return h('div', { style: S.hint }, '正在读取市场索引…')
      var err = market && market.indexErr
      var list = (market && market.index && market.index.plugins) || []
      var installed = (market && market.installed) || []
      // 兼容旧格式（字符串数组）和新格式（{id,version}）
      var installedIds = installed.map(function (x) { return typeof x === 'string' ? x : (x && x.id) })
      var installedVer = {}
      installed.forEach(function (x) { if (x && typeof x === 'object' && x.id) installedVer[x.id] = String(x.version || '') })
      /** 版本比较：a 比 b 新返回 1，相同 0，旧 -1。非语义版本按字符串比 */
      function cmpVer(a, b) {
        var pa = String(a || '').split(/[.\-+]/).map(function (s) { return parseInt(s, 10) || 0 })
        var pb = String(b || '').split(/[.\-+]/).map(function (s) { return parseInt(s, 10) || 0 })
        var n = Math.max(pa.length, pb.length)
        for (var i = 0; i < n; i++) {
          var x = pa[i] || 0, y = pb[i] || 0
          if (x > y) return 1
          if (x < y) return -1
        }
        return 0
      }
      var q = String(search || '').trim().toLowerCase()
      var shown = q ? list.filter(function (p) {
        return ((p.name || '') + ' ' + (p.id || '') + ' ' + (p.author || '') + ' ' + (p.description || '') + ' ' + ((p.tags || []).join(' '))).toLowerCase().indexOf(q) >= 0
      }) : list

      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
          h('input', {
            style: {
              width: 320, maxWidth: '50%', boxSizing: 'border-box',
              padding: '7px 12px', fontSize: 12.5, borderRadius: 16,
              border: '1px solid var(--dsw-alias-border, #45454c)',
              background: 'var(--dsw-alias-bg-primary, #252528)',
              color: 'var(--dsw-alias-text-primary, #e8e8ea)',
              colorScheme: 'dark', outline: 'none',
            },
            className: 'qqs-mk-search',
            placeholder: '搜索插件名 / 作者 / 标签…',
            value: search,
            onChange: function (e) { setSearch(e.target.value) },
          }),
          h('span', { style: { fontSize: 11.5, color: '#a8a8b2' } },
            shown.length + ' / ' + list.length + ' 个插件'),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, color: '#a8a8b2' } },
            '已知 ' + installed.length + ' 个已安装')),

        // 代理配置（墙内访问 GitHub 需要）
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11.5, color: '#a8a8b2' } }, '代理'),
          h('input', {
            className: 'qqs-mk-search qqs-mk-proxy',
            style: { width: 280, maxWidth: '50%', padding: '6px 11px', fontSize: 12, borderRadius: 14 },
            placeholder: 'http://127.0.0.1:29290（留空=直连）',
            value: proxyInput,
            onChange: function (e) { setProxyInput(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') onSaveProxy() },
          }),
          h('button', {
            className: 'qqs-mk-ghost',
            disabled: savingProxy,
            onClick: onSaveProxy,
          }, savingProxy ? '保存中…' : '保存并重试'),
          market && market.proxy
            ? h('span', { style: { fontSize: 11, color: '#7ec87e' } }, '当前：' + market.proxy)
            : h('span', { style: { fontSize: 11, color: '#a8a8b2' } }, '当前：直连'),
          err ? h('span', { style: { fontSize: 11, color: '#e07a7a', marginLeft: 'auto' } }, '索引读取失败') : null),

        err ? h('div', { style: S.errBox }, '索引读取失败：' + err) : null,

        shown.length === 0
          ? h('div', { style: S.empty }, err ? '索引不可用' : (q ? ('没有匹配「' + search + '」的插件') : '市场里还没有插件'))
          : h('div', { className: 'qqs-mk-grid' },
              shown.map(function (p) {
                var id = String(p.id || '')
                var isIn = installedIds.indexOf(id) >= 0
                var localVer = installedVer[id] || ''
                var remoteVer = String(p.version || '')
                var canUpdate = isIn && localVer && remoteVer && cmpVer(remoteVer, localVer) > 0
                var busy = busyId === id
                return h('div', { key: id, className: 'qqs-mk-card', style: S2.card },
                  // 封面（可选）
                  p.cover ? h('img', {
                    src: String(p.cover).replace(
                      /^https?:\/\/raw\.githubusercontent\.com\//,
                      'https://cdn.jsdelivr.net/gh/'
                    ),
                    alt: String(p.coverAlt || p.name || id),
                    loading: 'lazy',
                    className: 'qqs-mk-cover',
                    onError: function (e) {
                      // ★ 2026-10-26：封面图原来只有 jsdelivr → gh-proxy 两级，中间挂一个就白板。
                      //   改成四级降级链，全失败才隐藏（别破版）：
                      //     jsdelivr → gh-proxy → ghproxy.net → raw.githubusercontent.com
                      //   用 data-tries 记进度；img 不重渲染就不会丢这个属性。
                      try {
                        var el = e.target;
                        var cur = String(el.src || '');
                        var n = parseInt(el.getAttribute('data-tries') || '0', 10);
                        var next = '';
                        if (cur.indexOf('cdn.jsdelivr.net/gh/') >= 0) {
                          // owner/repo@branch/path → 还原成 raw 地址
                          var tail = cur.split('cdn.jsdelivr.net/gh/')[1] || '';
                          var m = tail.match(/^([^@]+)@([^/]+)\/(.*)$/);
                          if (m) {
                            var raw = 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3];
                            next = n === 0 ? ('https://gh-proxy.com/' + raw)
                                 : n === 1 ? ('https://ghproxy.net/' + raw)
                                 : raw;
                          }
                        } else if (cur.indexOf('gh-proxy.com/') >= 0) {
                          var r2 = cur.replace('https://gh-proxy.com/', '');
                          next = n <= 1 ? ('https://ghproxy.net/' + r2) : r2;
                        } else if (cur.indexOf('ghproxy.net/') >= 0) {
                          next = cur.replace('https://ghproxy.net/', '');
                        }
                        if (next && n < 3) {
                          el.setAttribute('data-tries', String(n + 1));
                          el.src = next;
                        } else {
                          el.style.display = 'none';   // 四个源都不通 → 藏掉，别破版
                        }
                      } catch (x) {}
                    },
                  }) : h('div', { className: 'qqs-mk-cover-ph' }, '暂无封面'),
                  h('div', { className: 'qqs-mk-head', style: S2.cardHead },
                    h('span', { className: 'qqs-mk-name', style: S2.cardName }, String(p.name || id)),
                    p.version ? h('span', { className: 'qqs-mk-meta', style: S2.cardVer }, 'v' + p.version) : null,
                    // 2026-10-25：扩展包可声明 minPluginVersion，这里直接对照当前插件版本。
                    // 满足 → 灰字提示「最低插件 vX」；不满足 → 标红并写清当前版本，免得装上去才发现跑不动。
                    p.minPluginVersion ? (function () {
                      var need = String(p.minPluginVersion)
                      var cur = String((market && market.pluginVersion) || '')
                      var cmpV = function (a, b) {
                        var na = String(a || '').replace(/^v/i, '').split(/[.+-]/).map(function (x) { return parseInt(x, 10) || 0 })
                        var nb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map(function (x) { return parseInt(x, 10) || 0 })
                        for (var i = 0; i < 3; i++) { var d = (na[i] || 0) - (nb[i] || 0); if (d) return d > 0 ? 1 : -1 }
                        return 0
                      }
                      var okVer = !cur ? true : (cmpV(cur, need) >= 0)
                      return h('span', {
                        className: 'qqs-mk-meta',
                        style: okVer ? S2.cardVer : Object.assign({}, S2.cardVer, { color: '#e5484d', fontWeight: 600 }),
                        title: okVer ? ('当前插件 v' + cur + ' 满足要求') : ('当前插件 v' + cur + ' 低于要求，装上也跑不起来'),
                      }, okVer ? ('最低插件 v' + need) : ('需要插件 ≥ v' + need + '（当前 v' + (cur || '?') + '）'))
                    })() : null,
                    p.author ? h('span', { className: 'qqs-mk-meta', style: S2.cardVer }, 'by ' + p.author) : null,
                    h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } },
                      isIn
                        ? h('span', { className: 'qqs-mk-tag' }, canUpdate ? ('已装 v' + localVer) : '已安装')
                        : null,
                      canUpdate
                        ? h('button', { type: 'button', className: 'qqs-mk-btn', disabled: busy, onClick: function () { onInstall({ id: id }) } },
                            busy ? '更新中…' : ('更新到 v' + remoteVer))
                        : null,
                      isIn
                        ? h('button', { type: 'button', className: 'qqs-mk-ghost', disabled: busy, onClick: function () { onRemove({ id: id }) } }, busy ? '处理中…' : '卸载')
                        : (canUpdate ? null : h('button', { type: 'button', className: 'qqs-mk-btn', disabled: busy, onClick: function () { onInstall({ id: id }) } }, busy ? '安装中…' : '安装')))),
                  p.description ? h('div', { className: 'qqs-mk-desc', style: S2.cardDesc }, String(p.description)) : null,
                  (p.tags && p.tags.length)
                    ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                        p.tags.map(function (t, i) { return h('span', { key: i, className: 'qqs-mk-tag' }, String(t)) }))
                    : null,
                  // 2026-10-25：卡片底部加「作者说明 · README ↗」
                  //   点开直接到 GitHub 上这个包的目录，能看到作者自己写的 README（安装说明/配置项/截图）。
                  //   优先用 manifest 里的 homepage；没填或指向市场仓库自己 → 就用 packs/<id>/ 的固定地址。
                  h('a', {
                    className: 'qqs-mk-link',
                    href: (function () {
                      var home = String(p.homepage || p.repo || '');
                      if (home && home.indexOf('dsh-qqbot-plugins') < 0) return home;
                      return 'https://github.com/zaofan-make/dsh-qqbot-plugins/tree/main/packs/' + encodeURIComponent(String(id));
                    })(),
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    title: '在 GitHub 上打开这个包的目录（含作者 README）',
                    onClick: function (e) {
                      // DSH 的 Electron 壳里 target=_blank 有时被拦，兜底手动开新窗口
                      try {
                        if (e && e.preventDefault) {
                          e.preventDefault();
                          window.open(e.currentTarget.href, '_blank', 'noopener');
                        }
                      } catch (x) { /* 让它走默认行为 */ }
                    },
                  }, '作者说明 · README ↗'))
              })))
    }

    function statCard(S, label, num, hint) {
      return h('div', { style: S.statCard },
        h('div', { style: S.statNum }, String(num)),
        h('div', { style: S.statLabel }, label),
        h('div', { style: S.statHint }, hint))
    }

    function tabBtn(S, label, key, cur, setTab, count) {
      var on = cur === key
      return h('button', {
        key: key,
        style: on ? S.tabOn : S.tabOff,
        onClick: function () { setTab(key) },
      }, label, count !== undefined ? h('span', { style: S.tabCount }, ' ' + count) : null)
    }

    function extStyles() {
      var C = {
        border: 'var(--dsw-alias-border, #8884)',
        sub: 'var(--dsw-alias-text-secondary, #888)',
        bg2: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.06))',
        accent: 'var(--dsw-alias-accent, #5b8def)',
        text: 'inherit',
      }
      return {
        wrap: { padding: '18px 22px', height: '100%', overflow: 'auto', boxSizing: 'border-box', color: C.text },
        head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 },
        title: { fontSize: 19, fontWeight: 600, marginBottom: 4 },
        sub: { fontSize: 12.5, color: C.sub },
        btn: { padding: '4px 12px', fontSize: 12.5, borderRadius: 6, border: '1px solid ' + C.border, background: 'transparent', color: 'inherit', cursor: 'pointer' },
        stats: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 },
        statCard: { border: '1px solid ' + C.border, borderRadius: 10, padding: '12px 14px', background: C.bg2 },
        statNum: { fontSize: 24, fontWeight: 600, lineHeight: 1.2 },
        statLabel: { fontSize: 12.5, marginTop: 2 },
        statHint: { fontSize: 11.5, color: C.sub, marginTop: 2 },
        pathBox: { border: '1px solid ' + C.border, borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12 },
        pathRow: { display: 'flex', gap: 10, alignItems: 'baseline', padding: '3px 0' },
        pathKey: { color: C.sub, minWidth: 68, fontSize: 12 },
        code: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, wordBreak: 'break-all', opacity: .85 },
        tabs: { display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid ' + C.border, paddingBottom: 8 },
        tabOn: { padding: '5px 14px', fontSize: 13, borderRadius: 6, border: '1px solid ' + C.accent, background: C.accent, color: '#fff', cursor: 'pointer' },
        tabOff: { padding: '5px 14px', fontSize: 13, borderRadius: 6, border: '1px solid ' + C.border, background: 'transparent', color: 'inherit', cursor: 'pointer' },
        tabCount: { opacity: .75, fontSize: 11.5 },
        group: { border: '1px solid ' + C.border, borderRadius: 10, padding: '14px 16px', marginBottom: 12 },
        groupHead: { marginBottom: 10, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
        groupTitle: { fontSize: 14.5, fontWeight: 600 },
        groupSub: { fontSize: 11.5, color: C.sub, wordBreak: 'break-all' },
        kindBlock: { marginBottom: 10 },
        kindHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 },
        kindIcon: { fontSize: 12.5 },
        kindLabel: { fontSize: 12.5, fontWeight: 500 },
        kindCount: { fontSize: 11, color: C.sub, background: C.bg2, borderRadius: 9, padding: '0 6px' },
        kindHint: { fontSize: 11, color: C.sub, marginLeft: 2 },
        chipWrap: { display: 'flex', flexWrap: 'wrap', gap: 5 },
        chip: { fontSize: 11.5, padding: '2px 8px', borderRadius: 5, border: '1px solid ' + C.border, background: C.bg2 },
        chipWithGear: { fontSize: 11.5, padding: '2px 8px', borderRadius: 5, border: '1px solid ' + C.accent, background: 'transparent' },
        gear: { opacity: .8, fontSize: 10.5 },
        settingsList: { display: 'flex', flexDirection: 'column', gap: 6 },
        settingRow: { display: 'flex', alignItems: 'baseline', gap: 10, border: '1px solid ' + C.border, borderRadius: 8, padding: '8px 12px', fontSize: 12.5 },
        settingTitle: { fontWeight: 500 },
        settingFrom: { fontSize: 11, color: C.sub, background: C.bg2, borderRadius: 4, padding: '1px 6px' },
        settingId: { fontSize: 11, color: C.sub, fontFamily: 'ui-monospace, Consolas, monospace', marginLeft: 'auto' },
        empty: { fontSize: 12.5, color: 'var(--dsw-alias-text-secondary, #9a9aa0)', padding: '18px 4px', lineHeight: 1.7 },
        emptyHint: { fontSize: 11.5, opacity: .8, marginTop: 4 },
        hint: { fontSize: 12.5, color: C.sub, padding: 20 },
        errBox: { fontSize: 12.5, color: '#c33', padding: '10px 12px', border: '1px solid #c335', borderRadius: 8, marginBottom: 10 },
        // ── 扩展设置弹层（2026-10-24）──
        chipClickable: { fontSize: 11.5, padding: '2px 8px', borderRadius: 5, border: '1px solid ' + C.accent, background: 'transparent', cursor: 'pointer' },
        // 2026-10-24 修「安卓上扩展自定义设置界面被截断、填不了」：
        //   原来是 minWidth:460 —— 手机视口只有 360~400px，盒子硬撑到 460 就横向溢出，
        //   右半边（输入框 / 保存按钮）直接被切掉。
        //   改成 minWidth:0 + width:100%（由 maxWidth 兜桌面宽度）+ 遮罩加 padding，
        //   maxHeight 用 calc(100vh - 24px) 对齐 padding，上下也不再各切一截。
        modalMask: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, boxSizing: 'border-box', zIndex: 2147483000 },
        modalBox: { background: 'var(--dsw-alias-bg-primary, #252528)', color: 'var(--dsw-alias-text-primary, #e8e8ea)', colorScheme: 'dark', borderRadius: 12, padding: '18px 20px', minWidth: 0, width: '100%', maxWidth: 640, maxHeight: 'calc(100vh - 24px)', overflow: 'auto', boxSizing: 'border-box', boxShadow: '0 16px 56px rgba(0,0,0,.5)', border: '1px solid ' + C.border },
        modalHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 12 },
        modalTitle: { fontSize: 15.5, fontWeight: 600, color: 'var(--dsw-alias-text-primary, #e8e8ea)' },
        modalSub: { fontSize: 11.5, color: C.sub, marginTop: 3, fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' },
        modalFoot: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, paddingTop: 14, borderTop: '1px solid ' + C.border },
        field: { marginBottom: 14 },
        fieldLabel: { fontSize: 12.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 },
        fieldHint: { fontSize: 11, color: C.sub, marginTop: 4 },
        fieldInput: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 12.5, borderRadius: 6, border: '1px solid ' + C.border, background: 'var(--dsw-alias-bg-primary, #252528)', color: 'var(--dsw-alias-text-primary, #e8e8ea)', fontFamily: 'inherit', colorScheme: 'dark' },
        secretTag: { fontSize: 10, color: C.sub, background: C.bg2, borderRadius: 4, padding: '1px 5px', fontWeight: 400 },
        btnPrimary: { padding: '7px 18px', fontSize: 13, borderRadius: 6, border: '1px solid ' + C.accent, background: C.accent, color: '#fff', cursor: 'pointer' },
        savedMsg: { fontSize: 12, color: '#4a4' },
        errMsg: { fontSize: 12, color: '#e55' },
        cfgPath: { fontSize: 11, color: C.sub, marginTop: 16, paddingTop: 12, borderTop: '1px solid ' + C.border, wordBreak: 'break-all' },
      }
    }

    function apply(ctx) {
      // 防御(与 dsh-undo-savepoint 的 safe() 同款): client 半边任一环节抛异常, 这条 entry 就会
      // 被判 FAILED, 而 dsh 0.1.7 的客户端启动审计是**致命**的 —— 整个 Web UI 只剩余下
      // "Failed to load plugins"。故这里逐段降级(打 warn 便于定位), 不连坐整页。
      var safe = function (label, fn) {
        try { return fn() } catch (e) {
          try { console.warn('[qqbot-settings] ' + label + ' degraded: ' + String((e && e.message) || e)) } catch (x) {}
        }
      }
      ensureCss()
      var slots = ctx.slots
      if (!slots) { console.warn('[qqbot-settings] slots unavailable'); return }
      safe('settings section', function () {
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'qqbot', order: 32, label: 'QQ 机器人' },
            function (props) { return h(QqbotHome, { close: props && props.close }) })
        })
      })
      // 「QQ机器人扩展」会话页签：**只在 QQ 会话里注入**（2026-10-28 主人定）
      //   为什么不用 DOM 隐藏：`slots.inject(key, cb)` 的返回值是 disposer（已核 ui-renderer 源码：
      //   `return () => { disposeController(); }`），注销后宿主 `slots.subscribe("conversation.view")`
      //   会自动刷新页签列表 —— 比按文案找按钮稳得多。
      var _extTabDisposed = null
      function setExtTabVisible(show) {
        if (show) {
          if (_extTabDisposed) return
          try {
            _extTabDisposed = slots.inject('conversation.view', function () {
              return slots.register(
                { name: 'conversation.view', id: 'qqbot-ext', order: 81, label: 'QQ机器人扩展' },
                ExtPanel)
            }) || null
            if (!_extTabDisposed) _extTabDisposed = function () {}
          } catch (eTab) { _extTabDisposed = null }
        } else {
          if (!_extTabDisposed) return
          try { _extTabDisposed() } catch (eTab2) {}
          _extTabDisposed = null
        }
      }
      safe('approval float', startApprovalFloat)
      // sessions 服务(宿主根服务): 权威读 web 当前会话(current)与 cwd(agent id === session id)
      var sessionsSvc = null
      try { sessionsSvc = (ctx && (ctx.sessions || (ctx.get && ctx.get('sessions')))) || null } catch (e) { sessionsSvc = null }
      if (!sessionsSvc) { try { sessionsSvc = ctx.get && ctx.get('sessions') } catch (e) {} }
      _extSessionsSvc = sessionsSvc   // 供 ExtPanel 读当前工作区 cwd
      safe('dock', function () { startQqDock(sessionsSvc) })
      // ── 统一刷新：页签 + 悬浮球，**事件驱动，不轮询**（2026-10-28）──
      //   信号源：`sessions.list`（ObservableSnapshot，宿主在左侧会话列表切换时就会推）
      //          ＋ window focus / 页面可见性（兜底，切回标签页时补一次）。
      var _qqUiRetry = 0
      var refreshQqUi = function () {
        // dock 球的显隐也走这同一个信号（否则切会话时页签跟走了、球还赖着不动）
        try { if (typeof window !== 'undefined' && typeof window.__qqsRefreshDock === 'function') window.__qqsRefreshDock() } catch (eDock) {}
        var sid = ''
        try { sid = curSessionId() } catch (eSid) { sid = '' }
        // 有限次重试（≈7 秒内 6 次）：宿主刚启动时"当前会话"或后端 lookup 可能还没就绪，
        // 一次性判空就再也不显示球了（2026-10-28 主人实测）。不是长期轮询。
        function retryLater() {
          if (_qqUiRetry >= 6) return
          _qqUiRetry++
          setTimeout(function () { refreshQqUi() }, 1200)
        }
        if (!sid) { setExtTabVisible(false); retryLater(); return }
        qqHitOf(sid, function (hit) {
          var now = ''
          try { now = curSessionId() } catch (eNow) {}
          if (now !== sid) return   // 查询期间切走了：别把旧结论套到新会话上
          setExtTabVisible(!!hit)
          if (hit) { _qqUiRetry = 0; return }
          retryLater()
        })
      }
      safe('qq ui refresh', function () {
        refreshQqUi()
        try {
          if (sessionsSvc && sessionsSvc.list && typeof sessionsSvc.list.subscribe === 'function') {
            sessionsSvc.list.subscribe(function () { refreshQqUi() })
          }
        } catch (eSub) {}
        try {
          window.addEventListener('focus', refreshQqUi)
          document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshQqUi() })
        } catch (eWin) {}
      })
    }

    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    return module.exports
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// web 会话列表自动重排（WEB_SESSION_REORDER，2026-10-05 主人定）
//
//   规则：QQ 消息入站 + AI 真的产出了
//         ⇒ 从列表头往下数 n 个仍"热的"（对话间隔 < 10min）会话，
//           把目标会话插到第 n+1 位；若第 1 个就冷掉（n=0）⇒ 直接插第 1 位。
//         · 置顶（📌「已置顶」）一律算"热"，位置也不动。
//
//   ★ 事件驱动，无轮询：服务端订阅宿主 session/event，命中 assistant/message
//      就推一条 SSE；这里用 EventSource 收，收到才干活。没开页面 ⇒ 服务端零开销。
//
//   ★ 两个数据源，各管一摊（2026-10-05 实测后定）：
//     · DOM   → 只用来读【谁是置顶的】
//         <div role="treeitem" data-row-key="session:<sid>"> …
//         <span aria-label="已置顶" title="已置顶">📌</span>
//     · localStorage["dsh.workspace.view.v5"].sessionOrderByAccount[accountKey]
//         → 完整的顺序数组（★ 不能只靠 DOM：侧边栏是分组+折叠的，
//           不在当前展开组里的会话 DOM 里根本没有 ⇒ 之前那版因此漏判、什么都没做）
//     · /workspace/sessions 端点 → 各会话最后活动时间（算"热不热"）
//
//   安全：宿主没起来 ⇒ SSE 连不上 ⇒ 天然不排序；读不到 DOM ⇒ 置顶当空集（仍能排）；
//         读不到 localStorage/结构异常 ⇒ 不改；写回前留备份 + readback 校验 + 失败回滚。
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  // ★ 加载即打印：F12 里若看不到这行 ⇒ 浏览器拿到的还是旧版 client.js（缓存/未重启）
  try { console.log("[qqbot] 会话重排模块已加载 build=2026-10-05c"); } catch (e) {}
  var LS_KEY = "dsh.workspace.view.v5";
  var FLAT_KEY = "__flat_session_order__";
  var HOT_MS = 10 * 60 * 1000;
  var lastSid = "";
  var lastAt = 0;

  /** 只读【置顶集合】：DOM 里带 aria-label="已置顶" 的行的 sessionId（读不到返回空对象） */
  function readPinnedFromDom() {
    var pinned = {};
    try {
      var rows = document.querySelectorAll('[role="treeitem"][data-row-key]');
      for (var i = 0; i < rows.length; i++) {
        var key = rows[i].getAttribute("data-row-key") || "";
        var m = /^session:(.+)$/.exec(key);
        if (!m) continue;
        if (rows[i].querySelector('[aria-label="已置顶"], .YDXeBa_pinIndicator')) pinned[m[1]] = true;
      }
    } catch (e) { /* 读不到就当没有置顶 */ }
    return pinned;
  }

  /** ★ 组内"热"判定：置顶一律算热；其余要求 10 分钟内有活动 */
  function isHot(s, at, pinned) {
    if (pinned[s]) return true;
    var t = at[s];
    return typeof t === "number" && Date.now() - t < HOT_MS;
  }

  /** 按【显示顺序】收集可见会话行（treeitem 是平铺的：workspace 行 + 其下会话行）。
   *  只有真渲染出来的行才有 DOM ⇒ 折叠的分组这里看不到，天然不参与。 */
  function collectRows() {
    var out = [];
    var cur = "";
    try {
      var items = document.querySelectorAll('[role="treeitem"][data-row-key]');
      for (var i = 0; i < items.length; i++) {
        var k = items[i].getAttribute("data-row-key") || "";
        var mw = /^workspace:(.*)$/.exec(k);
        if (mw) { cur = mw[1]; continue; }
        var ms = /^session:(.*)$/.exec(k);
        if (ms) out.push({ ws: cur, sid: ms[1], el: items[i] });
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /** 造一个原生拖拽事件。宿主侧【只认原生 HTML5 拖拽】：
   *  dragstart(dataTransfer text/plain = sessionId) → dragover(上半="before") → drop → dragend */
  function fireDrag(type, el, y, sid) {
    if (!el) return;
    var dt = null;
    try { dt = new DataTransfer(); } catch (e) { dt = null; }
    var ev = null;
    try {
      ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: 0, clientY: y });
    } catch (e) {
      try { ev = document.createEvent("Event"); ev.initEvent(type, true, true); } catch (e2) { return; }
      try { Object.defineProperty(ev, "dataTransfer", { value: dt }); } catch (e2) {}
      try { Object.defineProperty(ev, "clientY", { value: y }); } catch (e2) {}
    }
    if (sid && dt) { try { dt.effectAllowed = "move"; dt.setData("text/plain", sid); } catch (e) {} }
    el.dispatchEvent(ev);
  }

  /** ★★ 真正的重排：驱动侧边栏自己的拖拽，让【内存 store】更新 —— 这才会立刻重渲染 + 自动持久化。
   *  ⚠️ 2026-10-05 关键认知：光写 localStorage 是【绝对没用的】。侧边栏顺序的唯一真源是内存
   *     store（zustand），持久化是单向的（初始化读一次 + store 变化时往下写，没有 storage
   *     事件监听）⇒ 我们 setItem 既不重渲染，又会在下一次任何 store action（折叠分组/换排序
   *     方式/置顶）后被整份覆盖回去。所以必须走用户的真实入口：原生拖拽。
   *  @returns true = 已处理完（动了 / 判定不该动）；false = 本次没法处理（调用方走兜底） */
  function reorderByDom(sid, at) {
    if (typeof document === "undefined") return false;
    var pinned = readPinnedFromDom();
    if (pinned[sid]) { console.log("[qqbot] 目标是置顶会话，位置不动: " + sid); return true; }
    var rows = collectRows();
    if (!rows.length) return false;
    var mine = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].sid === sid) { mine = rows[i]; break; }
    if (!mine) { console.log("[qqbot] 目标不在可见列表里（分组被折叠?），跳过: " + sid); return true; }
    var group = [];
    for (var j = 0; j < rows.length; j++) if (rows[j].ws === mine.ws) group.push(rows[j]);

    // n = 从组头往下数的"热"会话；一碰到目标就停 ⇒ 目标已在热块内，绝不再把它往下挤
    var n = 0, k = 0;
    for (; k < group.length; k++) {
      if (group[k].sid === sid) { return true }
      if (isHot(group[k].sid, at, pinned)) { n++; continue; }
      break;
    }
    if (k >= group.length) { console.log("[qqbot] 组内全是热会话，不动: " + sid); return true; }
    var dest = group[k];
    if (dest.sid === sid) { console.log("[qqbot] 已在正确位置（冷块第一个），不动: " + sid); return true; }
    if (pinned[dest.sid]) { console.log("[qqbot] 落点是置顶会话，宿主不允许互落，不动: " + sid); return true; }

    var before = null;
    try { before = localStorage.getItem(LS_KEY); } catch (e) {}
    var rect = dest.el.getBoundingClientRect();
    var y = Math.round(rect.top + Math.min(4, Math.max(1, rect.height / 4)));   // 上半 ⇒ "before"
    console.log("[qqbot] 重排: " + sid + " → 插到 " + dest.sid + " 之前（n=" + n + "）");
    fireDrag("dragstart", mine.el, 0, sid);
    setTimeout(function () {
      fireDrag("dragover", dest.el, y, null);   // 让宿主登记落点
      setTimeout(function () {
        fireDrag("drop", dest.el, y, null);
        setTimeout(function () { fireDrag("dragend", mine.el, y, null); }, 40);
        setTimeout(function () {
          var after = null;
          try { after = localStorage.getItem(LS_KEY); } catch (e) {}
          console.log(after !== before ? "[qqbot] ✅ store 顺序已更新（持久层已同步）" : "[qqbot] ❌ store 顺序未变（拖拽未被宿主接受）");
        }, 600);
      }, 40);
    }, 80);
    return true;
  }

  /** 读 DOM：sid 所属的 workspace id（treeitem 是平铺的，顺序遍历即可）。
   *  组折叠/未渲染 ⇒ null（此时不初始化该组，退回旧行为，绝不乱猜）。 */
  function workspaceOfSession(sid) {
    try {
      var rows = document.querySelectorAll('[role="treeitem"][data-row-key]');
      var cur = null;
      for (var i = 0; i < rows.length; i++) {
        var k = rows[i].getAttribute("data-row-key") || "";
        var mw = /^workspace:(.+)$/.exec(k);
        if (mw) { cur = mw[1]; continue; }
        var ms = /^session:(.+)$/.exec(k);
        if (ms && ms[1] === sid) return cur;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function applyOrder(sid, at) {
    if (reorderByDom(sid, at)) return;        // ★ 首选：原生拖拽，改内存 store（会立刻重渲染）
    persistOnlyOrder(sid, at);                // 兜底：DOM 不可用时至少写持久层（刷新后才生效）
  }

  /** 兜底实现：只写 localStorage 持久层。⚠️ 不重渲染、且会被下一次 store action 覆盖，
   *  仅在 DOM 拖拽不可用（列表未渲染等）时使用。 */
  function persistOnlyOrder(sid, at) {
    if (typeof localStorage === "undefined") return;
    var pinned = readPinnedFromDom();          // 只有它是 DOM 来的
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    var j = null;
    try { j = JSON.parse(raw); } catch (e) { return; }
    if (!j || typeof j !== "object" || !j.sessionOrderByAccount || typeof j.sessionOrderByAccount !== "object") return;

    var now = Date.now();
    var changed = false;
    var wsOfSid = workspaceOfSession(sid);
    // 全量按「最后活动时间」降序 —— 这正是 dsh 在 orderBy:"updated" 下的显示顺序，
    // 所以拿它当初始值不会改变任何东西的视觉位置。
    var allIds = Object.keys(at).sort(function (a, b) { return (at[b] || 0) - (at[a] || 0); });

    var acc = j.sessionOrderByAccount;
    // ★ 2026-10-05 修复：目标没出现在任何一组里 ⇒ 用户从没手动拖过排序
    //   （这时 sessionOrderByAccount 甚至可能是 {}，一个键都没有 ⇒ 旧版直接跳过、什么都不做）。
    //   先把「目标所属工作区」和「扁平」两个键立出来（空数组），交给下面的初始化分支。
    var sidInAny = Object.keys(acc).some(function (k) {
      return Array.isArray(acc[k]) && acc[k].indexOf(sid) >= 0;
    });
    if (!sidInAny) {
      if (wsOfSid !== null && !Array.isArray(acc[wsOfSid])) acc[wsOfSid] = [];
      if (!Array.isArray(acc[FLAT_KEY])) acc[FLAT_KEY] = [];
    }

    Object.keys(j.sessionOrderByAccount).forEach(function (key) {
      var order = j.sessionOrderByAccount[key];
      if (!Array.isArray(order)) return;

      if (order.indexOf(sid) < 0) {
        // 目标不在这组里。两种情况：
        //   ① 这组是【空的】且【确实归目标】（扁平键，或 DOM 里目标就在该工作区下）
        //      ⇒ 用户从没手动排过 ⇒ 先按时间降序建起来，再走正常插入
        //   ② 组里已经有别的会话 ⇒ 目标本来就不属于这组 ⇒ 跳过（绝不污染别的组）
        var belongs = (key === FLAT_KEY) || (wsOfSid !== null && key === wsOfSid);
        if (!belongs || order.length > 0 || !allIds.length) return;
        order = allIds.slice();
        j.sessionOrderByAccount[key] = order;
        changed = true;
      }

      // n = 从头数：置顶算热；其余按 10 分钟内活跃算；遇冷即停
      var n = 0;
      for (var i = 0; i < order.length; i++) {
        if (order[i] === sid) continue;
        if (pinned[order[i]]) { n++; continue; }
        var t = at[order[i]];
        if (typeof t === "number" && now - t < HOT_MS) { n++; continue; }
        break;
      }
      var next = order.filter(function (x) { return x !== sid; });
      next.splice(n, 0, sid);
      var same = next.length === order.length;
      if (same) { for (var k = 0; k < next.length; k++) { if (next[k] !== order[k]) { same = false; break; } } }
      if (!same) { j.sessionOrderByAccount[key] = next; changed = true; }
    });

    if (!changed) { return }
    j.orderBy = "manual";
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(j));
      if (!localStorage.getItem(LS_KEY)) throw new Error("readback-empty");
      console.log("[qqbot] web 会话列表已重排: " + sid);
    } catch (e) {
      try { localStorage.setItem(LS_KEY, raw); } catch (e2) { /* 回滚失败则放弃 */ }
      console.warn("[qqbot] 会话重排写盘失败，已回滚:", e && e.message);
    }
  }

  function onActive(sid) {
    var now = Date.now();
    if (sid === lastSid && now - lastAt < 5000) return;
    lastSid = sid; lastAt = now;
    fetch("api/qqbot-settings/workspace/sessions", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok !== true) { console.warn("[qqbot] /workspace/sessions 不可用:", d && d.error); return; }
        var at = {};
        (d.sessions || []).forEach(function (x) { if (x && x.sessionId) at[x.sessionId] = x.at; });

        applyOrder(sid, at);
      })
      .catch(function (e) { console.warn("[qqbot] 拉时间表失败:", e && e.message); });
  }

  function connect() {
    if (typeof EventSource === "undefined") return;
    var es;
    try { es = new EventSource("api/qqbot-settings/workspace/watch"); } catch (e) { console.warn("[qqbot] EventSource 构造失败:", e); return; }
    es.onopen = function () { console.log("[qqbot] workspace/watch 已连接（SSE）"); };
    es.onmessage = function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d && d.sessionId) onActive(String(d.sessionId));
      } catch (e) { /* 忽略非 JSON 帧 */ }
    };
    es.onerror = function () {
      console.warn("[qqbot] workspace/watch 断开，5 秒后重连");
      try { es.close(); } catch (e) {}
      setTimeout(connect, 5000);
    };
  }
  // ★ 手动测试钩子（F12 里可直接调，不用等 QQ 消息）：
  //     window.__qqbotReorderTest()            → 自己挑一个"最近有活动的非置顶会话"来排
  //     window.__qqbotReorderTest("<sessionId>") → 指定会话
  //     window.__qqbotReorderDebug()            → 看当前读到的顺序/置顶集合/时间表
  try {
    window.__qqbotReorderTest = function (sid) {
      try {
        var target = sid ? String(sid) : "";
        if (!target) {
          var raw = localStorage.getItem(LS_KEY);
          var j = raw ? JSON.parse(raw) : null;
          var acc = j && j.sessionOrderByAccount ? j.sessionOrderByAccount : {};
          var keys = Object.keys(acc);
          var list = keys.length ? acc[keys[0]] : [];
          target = list.length ? String(list[Math.min(2, list.length - 1)]) : "";
        }
        if (!target) return "没有可用的 sessionId";
        console.log("[qqbot] 手动测试 目标=" + target);
        onActive(target);
        return "已触发 " + target + "（看后面的 [qqbot] 日志）";
      } catch (e) { return "异常: " + (e && e.message); }
    };
    window.__qqbotReorderDebug = function () {
      try {
        var pinned = readPinnedFromDom();
        var raw = localStorage.getItem(LS_KEY);
        var j = raw ? JSON.parse(raw) : null;
        var acc = j && j.sessionOrderByAccount ? j.sessionOrderByAccount : {};
        return {
          orderBy: j && j.orderBy,
          accounts: Object.keys(acc),
          firstOrder: (Object.values(acc)[0] || []).slice(0, 10),
          pinned: Object.keys(pinned),
          domRows: document.querySelectorAll('[role="treeitem"][data-row-key]').length,
        };
      } catch (e) { return "异常: " + (e && e.message); }
    };
    console.log("[qqbot] 调试钩子已就绪: __qqbotReorderTest / __qqbotReorderDebug");
  } catch (e) { /* 挂不上就算了 */ }

  connect();
})();
