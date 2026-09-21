/* WorkBuddy Token 消耗看板 —— 纯浏览器本地版
 * 所有解析与聚合都在用户本机浏览器内完成，日志内容不上传、不请求任何后端。
 * 解析口径与 gen_dashboard.py 保持一致。 */

/* ============================ 常量 ============================ */

const MODEL_MERGE = { 'glm-5.2-x': 'glm-5.2' };

/* 官方模型倍率表（离线兜底，与 gen_dashboard.py 的 MULT_FALLBACK 同源） */
const MULT_FALLBACK = {
  'glm-5.3': 0.79, 'glm-5.3-flash': 0.06, 'glm-5.2': 0.79, 'glm-5.1': 0.79,
  'glm-5v-turbo': 0.95, 'kimi-k3': 1.62, 'kimi-k2.8': 0.77, 'kimi-k2.7': 0.57,
  'kimi-k2.6': 0.52, 'minimax-m3': 0.25, 'hy4': 0.29, 'hy3': 0.0,
  'deepseek-v4.1-flash': 0.03, 'deepseek-v4-flash': 0.06, 'deepseek-v4-pro': 0.16
};

/* 积分单价（元/积分）三级回退的第三级：内置默认 */
const MEMB_FALLBACK = { hi: 0.0498, mo: 0.035, yr: 0.028 };

/* 同用量 API 直购价（元/百万 token）[输入, 输出, 缓存命中] —— 离线兜底 */
const PRICE_FALLBACK = {
  'deepseek-v4.1-flash': [1.37, 3.67, 0.2],
  'deepseek-v4-flash': [1.37, 3.67, 0.2],
  'deepseek-v4-pro': [12.53, 25.06, 1.04],
  'glm-5.1': [6.84, 22.68, 0.0], 'glm-5.2': [6.84, 22.68, 0.0],
  'glm-5.3': [6.84, 22.68, 0.0], 'glm-5.3-flash': [6.84, 22.68, 0.0],
  'kimi-k2.6': [3.96, 15.84, 0.0], 'kimi-k2.7': [3.96, 15.84, 0.0],
  'kimi-k2.8': [3.96, 15.84, 0.0], 'minimax-m3': [2.16, 8.64, 0.43],
  hy3: [1.01, 4.18, 0.25], hy4: [1.01, 4.18, 0.25]
};

/* ============================ 工具函数 ============================ */

/* 时间戳解析：兼容 epoch 毫秒 / epoch 秒 / 多种 ISO 字符串 */
function parse_ts(v) {
  if (typeof v === 'number') {
    if (v > 1e12) return v / 1000;
    if (v > 1e9) return v;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    const t = Date.parse(s);
    if (!isNaN(t)) return t / 1000;
    const f = parseFloat(s);
    if (!isNaN(f)) return f / 1000;
  }
  return null;
}

function int(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/* 数字千分位 */
function fmt(n) {
  if (n == null || isNaN(n)) return '-';
  return Math.round(n).toLocaleString('zh-CN');
}

/* 大数简写：1.23 亿 / 45.6 万 */
function fmtShort(n) {
  if (n == null || isNaN(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (a >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(Math.round(n));
}

function pct(a, b) {
  if (!b) return '0%';
  return (a / b * 100).toFixed(1) + '%';
}

/* ============================ 从日志记录提取 usage ============================ */

function grab(o) {
  const pd = o.providerData;
  if (!pd || typeof pd !== 'object') return null;
  const ru = pd.rawUsage || {}, u = pd.usage || {};
  const tt = ru.total_tokens || u.totalTokens;
  if (!tt) return null;
  const model = pd.model || pd.requestModelId || pd.requestModelName || 'unknown';
  const ptd = ru.prompt_tokens_details || {};
  let ch = ru.prompt_cache_hit_tokens;
  if (ch == null) ch = ptd.cached_tokens || 0;
  const cw = ptd.cached_creation_tokens || ptd.cache_write_tokens || 0;
  return {
    tt: int(tt),
    it: int(ru.prompt_tokens || u.inputTokens || 0),
    ot: int(ru.completion_tokens || u.outputTokens || 0),
    ch: int(ch || 0),
    cw: int(cw || 0),
    model: model,
    credit: (ru.credit != null ? num(ru.credit) : null)
  };
}

/* 会话标题：三级策略（与 Python 版 session_title 一致）
 * ① 剥掉 <system-reminder> 包装块后取内文
 * ② 标签包装消息取 summary 属性
 * ③ 剥掉首层标签取内文 */
function session_title(o) {
  if (o.role !== 'user') return null;
  const c = o.content;
  let texts = [];
  if (typeof c === 'string') texts = [c];
  else if (Array.isArray(c)) {
    for (const seg of c) {
      if (seg && typeof seg === 'object' && (seg.type === 'input_text' || seg.type === 'text')) {
        texts.push(seg.text || '');
      }
    }
  }
  for (let t of texts) {
    if (!t || !t.trim()) continue;
    t = t.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!t) continue;
    if (t.charAt(0) === '<') {
      const m = t.match(/^<(\w+)([^>]*)>/);
      if (!m) continue;
      const sm = m[2].match(/summary="([^"]+)"/);
      if (sm) return sm[1].trim().slice(0, 42);
      const inner = t.replace(/^<[^>]*>/, '').trim();
      if (inner && inner.charAt(0) !== '<') {
        const s = inner.split(/\s+/).join(' ');
        if (s) return s.slice(0, 42);
      }
      continue;
    }
    const s = t.split(/\s+/).join(' ');
    if (s) return s.slice(0, 42);
  }
  return null;
}

/* 工作空间目录名是路径 slug，取 WorkBuddy 之后的部分 */
function short_ws(name) {
  let i = name.lastIndexOf('-WorkBuddy-');
  if (i >= 0 && name.slice(i + 11)) return name.slice(i + 11);
  i = name.lastIndexOf('-workbuddy-');
  if (i >= 0 && name.slice(i + 11)) return name.slice(i + 11);
  return name;
}

/* 工作空间显示名：优先用日志 cwd 的路径基名 */
function ws_display(folder, cwd) {
  const base = cwd ? (cwd.replace(/\/+$/, '').split(/[\\/]/).pop() || '') : '';
  if (base) {
    const m = base.match(/^(automation-)?(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
    if (m) {
      return (m[1] ? '自动化 ' : '临时空间 ') + `${m[3]}-${m[4]} ${m[5]}:${m[6]}`;
    }
    return base;
  }
  return short_ws(folder);
}

/* ============================ 聚合：文件数组 → 看板数据 ============================ */

/* files: [{ segments: string[], text: string }]
 * segments 是相对日志根目录的路径分段，例如
 *   ['<工作空间目录>', '<会话id>.jsonl']
 *   ['<工作空间目录>', '<会话id>', 'subagents', 'agent-xxx.jsonl'] */
function buildData(files, onProgress) {
  const ws_names = {}, ws_idx = {};
  const cwd_by_folder = {};
  const models = [], model_idx = {};
  const sessions = {};

  files.forEach((f, fi) => {
    const segs = f.segments;
    if (!segs || !segs.length) return;
    const folder = segs[0];
    let sid = segs.length === 2 ? segs[1].replace(/\.jsonl$/i, '') : segs[1];

    if (!(folder in ws_idx)) {
      ws_names[folder] = short_ws(folder);
      ws_idx[folder] = Object.keys(ws_idx).length;
    }

    const recs = [], evs = [];
    const tks = {};
    let title = null, title_ai = null;

    const lines = f.text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o || typeof o !== 'object') continue;

      const sid_r = o.sessionId;
      if (sid_r && segs.length === 2) sid = sid_r;

      const cwdo = o.cwd;
      if (cwdo) {
        const cc = cwd_by_folder[folder] || (cwd_by_folder[folder] = {});
        cc[cwdo] = (cc[cwdo] || 0) + 1;
      }

      if (o.type === 'ai-title' && o.aiTitle) {
        const t = String(o.aiTitle).trim();
        if (t) title_ai = t;
      }
      if (title === null) {
        const t = session_title(o);
        if (t) title = t;
      }

      const ts = parse_ts(o.timestamp);
      if (ts) {
        evs.push(ts);
        if (o.type === 'function_call' && o.name) {
          tks[o.name] = (tks[o.name] || 0) + 1;
        }
      }

      const r = grab(o);
      if (!r) continue;
      r.model = MODEL_MERGE[r.model] || r.model;
      if (!ts) continue;
      if (!(r.model in model_idx)) {
        model_idx[r.model] = models.length;
        models.push(r.model);
      }
      recs.push([Math.floor(ts / 60), model_idx[r.model], r.tt, r.it, r.ot, r.ch, r.cw, r.credit]);
    }

    if (fi % 20 === 0 && onProgress) onProgress(fi + 1, files.length);

    if (!recs.length && !evs.length) return;
    recs.sort((a, b) => a[0] - b[0]);

    const d = sessions[sid] || (sessions[sid] = {
      w: ws_idx[folder], id: sid, t: null, tai: null, r: [], ev: [], tk: {}
    });
    if (title && !d.t) d.t = title;
    if (title_ai && !d.tai) d.tai = title_ai;
    for (const rec of recs) d.r.push(rec);
    for (const e of evs) d.ev.push(e);
    for (const k in tks) d.tk[k] = (d.tk[k] || 0) + tks[k];
  });

  /* 用 cwd 还原工作空间真实显示名 */
  for (const folder in cwd_by_folder) {
    if (!(folder in ws_names)) continue;
    const cc = cwd_by_folder[folder];
    let best = null, bestN = -1;
    for (const k in cc) if (cc[k] > bestN) { bestN = cc[k]; best = k; }
    if (best) ws_names[folder] = ws_display(folder, best);
  }

  /* 组装会话列表 */
  const sess_list = [];
  for (const sid in sessions) {
    const d = sessions[sid];
    if (!d.r.length) continue;
    /* AI 耗时：会话内事件时间戳排序，相邻间隔 ≤5 分钟视为连续工作累计 */
    const ev = Array.from(new Set(d.ev)).sort((a, b) => a - b);
    let busy_s = 0;
    for (let i = 0; i < ev.length - 1; i++) {
      const gap = ev[i + 1] - ev[i];
      if (gap <= 300) busy_s += gap;
    }
    sess_list.push({
      w: d.w, id: sid.slice(0, 8),
      t: d.tai || d.t || '(无标题会话)',
      st: d.r[0][0], r: d.r, by: Math.floor(busy_s), tk: d.tk
    });
  }
  sess_list.sort((a, b) => a.st - b.st);

  return {
    genMs: Date.now(),
    gen: new Date().toLocaleString('zh-CN', { hour12: false }),
    ws: Object.keys(ws_idx).sort((a, b) => ws_idx[a] - ws_idx[b]).map(k => ws_names[k]),
    models: models,
    sess: sess_list
  };
}

/* ============================ 窗口聚合 ============================ */

/* 请求记录下标：0=分钟时间戳 1=模型索引 2=总token 3=输入 4=输出 5=缓存命中 6=缓存写 7=积分 */
function aggregate(D, fromMs, toMs) {
  const from = fromMs / 60000, to = toMs / 60000;
  const A = {
    tt: 0, it: 0, ot: 0, ch: 0, cw: 0, credit: 0, req: 0, creditMissing: 0,
    turns: 0, sess: 0, busy: 0,
    mTot: new Array(D.models.length).fill(0),
    mIt: new Array(D.models.length).fill(0),
    mOt: new Array(D.models.length).fill(0),
    mCh: new Array(D.models.length).fill(0),
    mCredit: new Array(D.models.length).fill(0),
    mReq: new Array(D.models.length).fill(0),
    wTot: new Array(D.ws.length).fill(0),
    wCredit: new Array(D.ws.length).fill(0),
    wReq: new Array(D.ws.length).fill(0),
    wSess: new Array(D.ws.length).fill(0),
    tools: {},
    toolMax: 0,
    hour: Array.from({ length: 24 }, () => ({ tt: 0, byModel: {} })),
    daily: {},
    dailyModels: {},
    sessions: []
  };

  for (const s of D.sess) {
    let inWin = false;
    for (const a of s.r) {
      const m = a[0];
      if (m < from || m > to) continue;
      inWin = true;
      const mi = a[1], tt = a[2], it = a[3], ot = a[4], ch = a[5], cw = a[6], cr = a[7];
      A.tt += tt; A.it += it; A.ot += ot; A.ch += ch; A.cw += cw;
      A.credit += (cr || 0);
      if (cr == null) A.creditMissing++;
      A.req++;
      if (mi < A.mTot.length) {
        A.mTot[mi] += tt; A.mIt[mi] += it; A.mOt[mi] += ot;
        A.mCh[mi] += ch; A.mCredit[mi] += (cr || 0); A.mReq[mi]++;
      }
      if (s.w < A.wTot.length) {
        A.wTot[s.w] += tt; A.wCredit[s.w] += (cr || 0); A.wReq[s.w]++;
      }
      /* 小时分布 */
      const hr = new Date(m * 60000).getHours();
      A.hour[hr].tt += tt;
      A.hour[hr].byModel[mi] = (A.hour[hr].byModel[mi] || 0) + tt;
      /* 每日分布 */
      const dk = dayKey(m);
      const dd = A.daily[dk] || (A.daily[dk] = { tt: 0, it: 0, ot: 0, ch: 0, credit: 0, req: 0, sess: 0 });
      dd.tt += tt; dd.it += it; dd.ot += ot; dd.ch += ch; dd.credit += (cr || 0); dd.req++;
      const dm = A.dailyModels[dk] || (A.dailyModels[dk] = {});
      dm[mi] = (dm[mi] || 0) + tt;
    }
    if (inWin) {
      A.sess++;
      if (s.w < A.wSess.length) A.wSess[s.w]++;
      A.busy += s.by;
      /* 只统计窗口内的轮次 */
      A.sessions.push(s);
      for (const k in s.tk) {
        A.tools[k] = (A.tools[k] || 0) + s.tk[k];
        if (A.tools[k] > A.toolMax) A.toolMax = A.tools[k];
      }
    }
  }
  return A;
}

function dayKey(minutes) {
  const d = new Date(minutes * 60000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/* ============================ 派生指标 ============================ */

function deriveKpis(A, days) {
  const cacheHitRate = (A.it + A.ch) ? A.ch / (A.it + A.ch) : 0;
  const memb = window._memb || MEMB_FALLBACK;
  const creditYuan = A.credit * (memb.yr || 0.028);
  /* 同用量 API 直购价 */
  let apiYuan = 0;
  return {
    tt: A.tt, it: A.it, ot: A.ot, ch: A.ch, cw: A.cw,
    req: A.req, sess: A.sess, busy: A.busy,
    credit: A.credit, creditYuan: creditYuan,
    cacheHitRate: cacheHitRate,
    ioRatio: A.ot ? A.it / A.ot : 0,
    perDay: days ? A.tt / days : 0,
    apiYuan: apiYuan
  };
}

/* ============================ 导出到全局 ============================ */

window.TD = {
  parse_ts, grab, session_title, short_ws, ws_display,
  buildData, aggregate, dayKey, deriveKpis,
  fmt, fmtShort, pct, int, num,
  MODEL_MERGE, MULT_FALLBACK, MEMB_FALLBACK, PRICE_FALLBACK
};
