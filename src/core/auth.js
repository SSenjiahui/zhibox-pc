// 智博X · 内核 · 认证
// 会话票据持久化 + 启动自愈 + 登录票据探测
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const net = require('./net');
const store = require('./store');
const log = require('./logger');
const paths = require('./paths');

const cfg = require('./config');
const API_BASE = cfg.API_BASE;
const STORE_KEY = 'session';

/* 应用级客户端标识（不是任何人的账号），见 core/config.js。
 * 鉴权口径在历史版本里换过一次：
 *   早期：Authorization = <用户票据>&&APP
 *   后来：Authorization = <应用标识>&&APP  +  userToken = <用户票据>
 * 现在两条口径都试；用户票据只能来自登录响应，代码里不留任何票据常量。 */
const APP_TOKEN = cfg.APP_TOKEN;

let memSession = null;
let lastProfileAt = 0;
let lastDiagFile = '';
/* 最近一次「登录真的成功」的时刻。上层用它做一道窄窗口抑制：
 * 登录成功的同一刻会并发发出课程/横幅等多个请求，其中任何一个偶发 code=0
 * 都不该把用户一脚踹回登录页——那是把「刚登进去」演成「登不进去」。 */
let lastOkAt = 0;   // 最近一次登录的原始响应落盘路径（用于诊断「密码对但拿不到票据」）

function empty() {
  return { authToken: '', userToken: '', cookie: '', profile: null, savedAt: 0 };
}

function get() {
  if (memSession) return memSession;
  const s = store.get(STORE_KEY, null);
  if (s && typeof s === 'object') {
    /* 老版本（含 1.7.4 之前）把服务端原样的 "xxx&&APP" 直接写进了 session.json，
     * 读的时候顺手剥一次，用户不用重新登录也能立刻恢复。 */
    memSession = {
      authToken: bareTicket(s.authToken),
      userToken: bareTicket(s.userToken),
      cookie: String(s.cookie || ''),
      profile: s.profile || null,
      savedAt: Number(s.savedAt) || 0,
    };
  } else {
    memSession = empty();
  }
  return memSession;
}

function set(s) {
  const prev = memSession || empty();
  /* 一律存**裸票据**：headers() 负责拼 '&&APP'。服务端在登录响应里回的是
   * 已经拼好的 "xxx&&APP"，直接存进来就会被拼第二次 → 所有请求 401。 */
  const next = {
    authToken: bareTicket(s && s.authToken != null ? s.authToken : prev.authToken),
    userToken: bareTicket(s && s.userToken != null ? s.userToken : prev.userToken),
    cookie: String((s && s.cookie != null ? s.cookie : prev.cookie) || ''),
    profile: (s && s.profile) || null,
    savedAt: Date.now(),
  };
  memSession = next;
  const ok = store.set(STORE_KEY, next, true);
  log.info('auth', '保存会话 ticket=' + next.authToken.slice(0, 8) + ' tokenLen=' + next.userToken.length +
    ' cookieLen=' + next.cookie.length + ' ok=' + ok);
  return { ok, session: next };
}

function clear() {
  memSession = empty();
  store.set(STORE_KEY, memSession, true);
  // 留调用栈：会话被清掉时必须能查到是谁干的
  let who = '';
  try { who = (new Error('clear-caller')).stack.split('\n').slice(2, 6).join(' <= '); } catch (e) {}
  log.info('auth', '会话已清除 :: ' + who);
  return true;
}

/**
 * API 请求要用的鉴权头（Authorization 必须是 <ticket>&&APP）。
 * 没有本地会话时**不发 Authorization**——匿名接口（课程列表 / 轮播 / 版本）
 * 本来就不需要鉴权，而任何内置票据都等于把某个人的账号塞进安装包。
 */
/* 这个服务端在**登录响应里直接就把 '&&APP' 后缀拼好了**（实测 data.token =
 * "<32位hex>&&APP"），而老会话里存的是裸 32 位 hex。
 * 两种都要能收：统一剥成裸值保存，只在真正发请求时拼一次后缀。
 * 之前漏了这一步 → 存进 authToken 的是带后缀的值，headers() 又拼一次，
 * 变成 '...&&APP&&APP'，服务端不认，登录成功下一秒就 401 弹回登录页。 */
function bareTicket(v) {
  return String(v == null ? '' : v).trim().replace(/&&APP$/i, '').trim();
}

function headers(sess) {
  const s = sess || get();
  const h = { 'X-Access-Token': '0' };
  if (s.authToken) h.Authorization = bareTicket(s.authToken) + '&&APP';
  else if (s.userToken) h.Authorization = APP_TOKEN + '&&APP';   // 新口径：应用标识 + userToken
  if (s.userToken) h.userToken = s.userToken;
  /* 有些服务端把会话放 Cookie 里（登录 200 时连发几个 Set-Cookie）。
   * 这条通路原先完全没走，导致「密码对、票据也拿到了，但请求还是未登录」。 */
  if (s.cookie) h.Cookie = s.cookie;
  return h;
}

/** 拿任意一组鉴权头去打 /profile，返回完整结果（不只是成败）。 */
async function hit(h) {
  try {
    const r = await net.fetchText(API_BASE + '/profile', { headers: h, timeout: 12000, retries: 1 });
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { j = null; }
    const okk = !!(j && j.code === 1 && j.data && j.data.id);
    return { ok: okk, status: r.status, code: j ? j.code : null, message: (j && j.message) || '', data: okk ? j.data : null };
  } catch (e) {
    return { ok: false, status: 0, code: null, message: String((e && e.message) || e), data: null };
  }
}

/** 拿任意一组鉴权头去打 /profile，命中返回资料（命中不了的返回 null）。 */
async function tryHeaders(h) {
  const r = await hit(h);
  if (r.ok) return r.data;
  log.debug('auth', 'tryHeaders miss ' + String(h.Authorization || h.userToken || h.Cookie || '').slice(0, 8) + ' :: ' + r.code + ' ' + r.message);
  return null;
}

/** 用某个票据试 /profile（默认按 Authorization: <ticket>&&APP 的既有口径） */
async function tryTicket(ticket, userToken) {
  const h = { Authorization: bareTicket(ticket) + '&&APP', 'X-Access-Token': '0' };
  if (userToken) h.userToken = userToken;
  return tryHeaders(h);
}

/**
 * 启动自愈：只用**本机保存的会话**去试 /profile。
 * 这里刻意不留任何内置票据——安装包里带一个票据，等于把某个人的账号
 * 随 exe 一起发出去；换台机器、换个人装，登录的就都是同一个人。
 */
async function autoLogin() {
  const s = get();
  const ticket = bareTicket(s.authToken);
  const ut = bareTicket(s.userToken);
  if (!ticket && !ut && !s.cookie) {
    log.info('auth', '本机没有会话，等待用户登录');
    return { ok: false, reason: 'no-session', authToken: '', profile: null };
  }
  /* 两种历史口径都要能自愈：
   *   ① 会话只有 userToken —— Authorization 必须是应用标识（新口径）
   *   ② 会话是 authToken —— Authorization = <ticket>&&APP（旧口径）
   * 只按 ① 或 ② 写死，都会让另一批用户的会话莫名其妙地「已失效」。 */
  const cands = [];
  if (ut) cands.push({ name: 'appToken+userToken', h: { Authorization: APP_TOKEN + '&&APP', userToken: ut, 'X-Access-Token': '0' } });
  if (ticket) cands.push({ name: 'ticket', h: { Authorization: ticket + '&&APP', 'X-Access-Token': '0', ...(ut ? { userToken: ut } : {}) } });
  if (s.cookie) cands.push({ name: 'cookie', h: { Cookie: s.cookie, 'X-Access-Token': '0' } });

  for (let i = 0; i < cands.length; i++) {
    const p = await tryHeaders(cands[i].h);
    if (p) {
      set({ authToken: ticket, userToken: ut, profile: p });
      log.info('auth', '自动登录命中本地会话 via=' + cands[i].name + ' user=' + p.name + '(id=' + p.id + ')');
      return { ok: true, authToken: ticket, profile: p, from: 'session', via: cands[i].name };
    }
  }
  log.warn('auth', '本地会话已失效，需要重新登录');
  return { ok: false, reason: 'expired', authToken: '', profile: null };
}

/** 是否已有可用于鉴权的本地会话（不联网） */
function hasToken() {
  const s = get();
  return !!(String(s.authToken || '').trim() || String(s.userToken || '').trim() || s.cookie);
}

/* ------------------------------------------------------------------ *
 * 票据派生
 *
 * 服务端下发的会话种子不一定能直接当 Authorization 用：老版本里留着
 * 的 sessionKey 是 base64（24 字符 = 16 字节），而实际票据是 32 位 hex
 * —— 同一份 16 字节，两种编码。所以每个候选值都要把「可能的一步变换」
 * 都展开，一次登录把所有形态试完。
 *
 * 这一点极其重要：错误次数是有限的（试错到第 5 次就锁 15 分钟），
 * 用户不可能为了让我们多猜几轮而反复登录。
 * ------------------------------------------------------------------ */
function derive(v) {
  const out = [];
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 1024) return out;
  const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
  // base64 → hex（sessionKey 形态：24 字符 base64 = 16 字节 → 32 hex）
  if (/^[A-Za-z0-9+/]{16,88}={0,2}$/.test(s)) {
    try {
      const buf = Buffer.from(s, 'base64');
      if (buf.length >= 8 && buf.length <= 64) out.push(buf.toString('hex'));
    } catch (e) {}
  }
  // hex → base64（反向）
  if (/^[0-9a-f]{16,64}$/i.test(s)) {
    try { out.push(Buffer.from(s, 'hex').toString('base64')); } catch (e) {}
  }
  out.push(md5(s));
  return out;
}

/** 并发池：把 [{name, h}] 分批打 /profile，命中即返回。 */
async function raceTry(items, concurrency) {
  const cc = Math.max(1, Math.min(8, concurrency || 4));
  for (let i = 0; i < items.length; i += cc) {
    const slice = items.slice(i, i + cc);
    const rs = await Promise.all(slice.map((it) => hit(it.h).then((r) => ({ it, r }))));
    for (let k = 0; k < rs.length; k++) {
      if (rs[k].r.ok) return { hit: rs[k].it, data: rs[k].r.data, tried: i + k + 1 };
    }
  }
  return null;
}

/** 账号密码登录：响应体 + 响应头里所有候选串（含派生形态）逐个试 /profile */
async function login(phone, password) {
  const payload = Buffer.from(JSON.stringify({ phone: String(phone || '').trim(), password: String(password || '') }), 'utf8');
  /* 登录请求的头，两个坑都要避开：
   *  ① 不能带**旧的用户票据**（Authorization: <旧ticket>&&APP / userToken: <旧>）。
   *     本地留着上一个会话的失效票据时，服务端可能走「先验票、票无效但不报错」的宽松分支：
   *     密码校验通过（code=1 操作成功），却不再签发新票据 —— 正好是
   *     「密码是对的、登录返回成功、拿到的票据不能用」这个现场。
   *  ② 但也不能什么都不带。这个后端区分「App 客户端」和「裸 HTTP」，
   *     早期版本的写法是 Authorization: <应用标识>&&APP（不带任何用户票据），
   *     一直能登进——那才是 App 的姿态。所以这里固定发应用标识。 */
  let res;
  try {
    res = await net.fetchText(API_BASE + '/account/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: APP_TOKEN + '&&APP',   // 应用标识，不是任何人的账号
        'X-Access-Token': '0',
      },
      body: payload,
      timeout: 20000,
      retries: 1,
    });
  } catch (e) {
    log.error('auth', '登录网络失败 :: ' + ((e && e.message) || e));
    return { ok: false, netError: String((e && e.message) || e) };
  }

  return await adopt(res, phone);
}

/* 从一个「已确认可信」的响应里把会话接过来：收集候选 → 分阶段探测 /profile → 落盘会话。
 * 密码登录和验证码登录的**响应结构完全一样**（都是 code=1 + data），
 * 所以这一步必须共用，否则两条链路会各自长出一套挑票据的逻辑。 */
/* 把命中的票据落盘，并用**归一化后的会话**自证一次。
 * 自证的用意：headers() 会把 authToken 拼成 '<bare>&&APP'，
 * 如果存进去的值本身就带 '&&APP'，拼出来就是 '&&APP&&APP' ——
 * 探测阶段用的是候选原样（能过），落盘后再发请求却过不了，
 * 表现正是「登录成功、下一秒弹回登录页」。这一步把这种不一致当场抓出来。 */
async function commit(patch, phone, via, candTag) {
  set(patch);
  const sess = get();
  lastOkAt = Date.now();
  let selfOk = null;
  try {
    const p = await tryHeaders(headers(sess));
    selfOk = !!p;
    if (!p) log.warn('auth', '自证失败：保存的会话打不通 /profile（ticket=' +
      String(sess.authToken).slice(0, 8) + ' tokenLen=' + sess.userToken.length +
      ' cookieLen=' + sess.cookie.length + '）');
  } catch (e) {
    log.warn('auth', '自证异常 :: ' + ((e && e.message) || e));
  }
  log.info('auth', '登录命中 ' + via + ' (' + (candTag || 'body') + ') user=' + (patch.profile && patch.profile.name) + ' 自证=' + selfOk);
  return { selfOk, sess };
}

async function adopt(res, phone) {
  let json = null;
  try { json = JSON.parse(res.text); } catch (e) { json = null; }
  log.info('auth', '登录 HTTP ' + res.status + ' code=' + (json && json.code) + ' msg=' + (json && json.message));
  if (!json) return { ok: false, error: '登录返回非 JSON' };
  if (json.code !== 1 || !json.data) {
    return { ok: false, code: json.code, message: json.message || ('HTTP ' + res.status) };
  }

  /* 服务端已经认了密码（code=1），从这里开始全是「哪个字段能当票据」的问题。
   * 把整个响应原样落盘：出问题时光看日志就能定位，不用让用户再登一次。 */
  try {
    log.info('auth', '登录响应头 = ' + JSON.stringify(res.headers || {}).slice(0, 2000));
    log.info('auth', '登录响应体 = ' + String(res.text || '').slice(0, 1500));
  } catch (e) {}

  let diagPath = '';
  try {
    const dir = paths.dirs().logs;
    fs.mkdirSync(dir, { recursive: true });
    diagPath = path.join(dir, 'login-diag-' + Date.now() + '.json');
    lastDiagFile = diagPath;
  } catch (e) {
    log.warn('auth', '登录诊断文件路径准备失败 :: ' + ((e && e.message) || e));
  }

  // ---- 收集候选票据 ----
  const cands = [];
  const candTags = Object.create(null);
  const seen = Object.create(null);
  const add = (v, tag) => {
    const t = bareTicket(v);
    if (!t || t.length < 8 || t.length > 1024) return;
    if (seen[t]) return;
    seen[t] = 1;
    cands.push(t);
    if (tag) candTags[t] = tag;
  };

  /* 先按已知字段名精确取（命中就是最可能的那个），再全量兜底。
   * 注意：这里遍历的是**整个响应体**（不只是 json.data）——票据放在顶层
   * （如 {code:1, token:'...', data:{...}}）是很常见的写法，只扫 data 会漏掉。 */
  const PREF = ['token', 'authToken', 'accessToken', 'access_token', 'ticket', 'userToken',
    'user_token', 'sessionId', 'sessionKey', 'sid', 'jwt', 'authorization', 'Authorization'];
  (function named(v, depth) {
    if (depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.slice(0, 5).forEach((x) => named(x, depth + 1)); return; }
    Object.keys(v).forEach((k) => {
      if (PREF.indexOf(k) >= 0) add(v[k], 'field:' + k);
      else named(v[k], depth + 1);
    });
  })(json, 0);

  /* 这个服务端的 data 有时是**一个 JSON 字符串**（banner 接口就是这样：
   * data 是 string，要 JSON.parse 才是数组）。票据完全可能被同样地包了一层，
   * 所以遇到像 JSON 的字符串要先拆开再往下走，否则整串都被当成一个候选，永远试不中。 */
  (function walk(v, depth, key) {
    if (depth > 7 || v == null) return;
    if (key === 'message' || key === 'msg') return;           // 提示语不是票据
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.charAt(0) === '{' && t.charAt(t.length - 1) === '}') ||
          (t.charAt(0) === '[' && t.charAt(t.length - 1) === ']')) {
        try { walk(JSON.parse(t), depth + 1, key); return; } catch (e) {}
      }
      try { if (/%22|%7B/i.test(t) && t.length < 4096) { walk(JSON.parse(decodeURIComponent(t)), depth + 1, key); return; } } catch (e) {}
      add(v, key || 'body');
      return;
    }
    if (typeof v === 'number' && v > 1e9) { add(v, key || 'body'); return; }
    if (Array.isArray(v)) { v.slice(0, 10).forEach((x) => walk(x, depth + 1, key)); return; }
    if (typeof v === 'object') {
      Object.keys(v).forEach((k) => {
        if (k === 'avatarUrl' || k === 'introduction' || k === 'shareTitle') return;
        walk(v[k], depth + 1, k);
      });
    }
  })(json, 0, '');

  const resHeaders = res.headers || {};
  const cookies = [];              // 原样拼好的 Cookie 头（name=value; name2=value2）
  Object.keys(resHeaders).forEach((k) => {
    const kl = String(k).toLowerCase();
    const v = resHeaders[k];
    if (kl === 'set-cookie') {
      (Array.isArray(v) ? v : [v]).forEach((ck) => {
        const first = String(ck).split(';')[0].trim();
        if (first.indexOf('=') > 0) { cookies.push(first); add(first.slice(first.indexOf('=') + 1), 'cookie'); }
      });
    } else if (typeof v === 'string' && /token|auth|session|ticket|sid/i.test(kl)) {
      add(v, 'header:' + kl);
    }
  });
  const cookieHeader = cookies.join('; ');
  if (cookieHeader) log.info('auth', '登录响应下发 Cookie ' + cookies.length + ' 个');

  /* 派生：对每个原始候选展开 base64↔hex / md5，尽量一次登录把形态试完。 */
  const base = cands.slice(0, 16);
  base.forEach((c) => {
    derive(c).forEach((d) => add(d, 'derive(' + (candTags[c] || 'body') + ')'));
  });

  /* 排序：命中已知字段名的最可能，其次 cookie/header，最后才是派生值与普通字段。
   * 顺序决定「第几次探测命中」，而 A 阶段最多只打 14 次 —— 别把最可能的排到后面去。 */
  const rank = (c) => {
    const tg = candTags[c] || 'body';
    if (tg.indexOf('field:') === 0) {
      return ['field:token', 'field:authToken', 'field:accessToken', 'field:access_token', 'field:ticket',
        'field:sessionKey', 'field:sessionId', 'field:jwt', 'field:userToken', 'field:user_token', 'field:sid',
        'field:authorization', 'field:Authorization'].indexOf(tg) >= 0 ? 0 : 1;
    }
    if (tg.indexOf('cookie') === 0 || tg.indexOf('header:') === 0) return 2;
    if (tg.indexOf('derive(') === 0) return 4;
    return 3;
  };
  cands.sort((a, b) => rank(a) - rank(b));

  log.info('auth', '登录候选票据 ' + cands.length + ' 个 :: ' +
    cands.slice(0, 24).map((c, i) => '#' + i + '(' + (candTags[c] || 'body') + ')' + c.slice(0, 8)).join(' '));

  /* 票据怎么拼到请求头上，服务端从来没文档。按命中概率分阶段试：
   *   A) Authorization: <t>&&APP                —— 现有唯一已知能用的口径，铺满所有候选
   *   B) Authorization: <t> / userToken: <t> / 两个头都填
   *   C) Authorization: <a>&&APP + userToken: <b>（a≠b —— 登录响应里有两个票据字段时）
   *   D) 纯 Cookie 会话
   * 全程并发 4 路，命中立刻落盘返回；每次探测的 code/message 都写进诊断文件。 */
  const probe = [];
  const XA = '0';

  /* 0 阶段（最高优先级）：Authorization 固定为应用标识，用户票据只放在 userToken 头里。
   * 这是历史版本的写法，也是最可能命中真实协议的一条 —— 先试它，
   * 因为错误次数有限、探测次数越少越好。 */
  const stage0 = [];
  cands.slice(0, 12).forEach((c) => {
    stage0.push({ name: 'appToken+userToken', cand: c, h: { Authorization: APP_TOKEN + '&&APP', userToken: c, 'X-Access-Token': XA } });
    stage0.push({ name: 'appToken+userToken(no-suffix)', cand: c, h: { Authorization: APP_TOKEN, userToken: c, 'X-Access-Token': XA } });
  });
  const r0 = await raceTry(stage0, 4);
  if (r0) {
    const tag = candTags[r0.hit.cand] || 'body';
    const cm = await commit({ authToken: '', userToken: r0.hit.cand, profile: r0.data }, phone, r0.hit.name, tag);
    if (diagPath) writeDiag(diagPath, { phone, res, cands, candTags, matched: { via: r0.hit.name, cand: tag }, selfOk: cm.selfOk });
    return { ok: true, authToken: '', userToken: r0.hit.cand, profile: r0.data, via: r0.hit.name, selfOk: cm.selfOk, diagFile: diagPath };
  }

  // A 阶段（最多 14 个最可能的候选；Authorization: <t>&&APP 是旧口径）
  const stageA = cands.slice(0, 14).map((c) => ({
    name: 'auth&&APP',
    cand: c,
    h: { Authorization: c + '&&APP', 'X-Access-Token': XA },
  }));
  let r1 = await raceTry(stageA, 4);
  if (r1) {
    const tag = candTags[r1.hit.cand] || 'body';
    const cm = await commit({ authToken: r1.hit.cand, userToken: '', profile: r1.data }, phone, 'authorization&&APP', tag);
    if (diagPath) writeDiag(diagPath, { phone, res, cands, candTags, matched: { via: 'auth&&APP', cand: tag }, selfOk: cm.selfOk });
    return { ok: true, authToken: r1.hit.cand, profile: r1.data, via: 'authorization&&APP', selfOk: cm.selfOk, diagFile: diagPath };
  }

  // B 阶段（前 10 个候选 × 3 种形态）
  const head = cands.slice(0, 10);
  const stageB = [];
  head.forEach((c) => {
    stageB.push({ name: 'auth-raw', cand: c, h: { Authorization: c, 'X-Access-Token': XA } });
    stageB.push({ name: 'userToken', cand: c, h: { userToken: c, 'X-Access-Token': XA } });
    stageB.push({ name: 'both', cand: c, h: { Authorization: c + '&&APP', userToken: c, 'X-Access-Token': XA } });
  });
  let r2 = await raceTry(stageB, 4);
  if (r2) {
    const isUser = r2.hit.name === 'userToken';
    const tag = candTags[r2.hit.cand] || 'body';
    const cm = await commit({ authToken: isUser ? '' : r2.hit.cand, userToken: isUser ? r2.hit.cand : '', profile: r2.data }, phone, r2.hit.name, tag);
    if (diagPath) writeDiag(diagPath, { phone, res, cands, candTags, matched: { via: r2.hit.name, cand: tag }, selfOk: cm.selfOk });
    return { ok: true, authToken: isUser ? '' : r2.hit.cand, profile: r2.data, via: r2.hit.name, selfOk: cm.selfOk, diagFile: diagPath };
  }

  // C 阶段：双票据（只在前 6 个候选里两两配）
  const pairSrc = cands.slice(0, 6);
  const stageC = [];
  for (let i = 0; i < pairSrc.length; i++) {
    for (let j = 0; j < pairSrc.length; j++) {
      if (i === j) continue;
      stageC.push({ name: 'pair', cand: pairSrc[i] + ' + ' + pairSrc[j], h: { Authorization: pairSrc[i] + '&&APP', userToken: pairSrc[j], 'X-Access-Token': XA } });
    }
  }
  let r3 = await raceTry(stageC, 4);
  if (r3) {
    const parts = r3.hit.cand.split(' + ');
    const cm = await commit({ authToken: parts[0], userToken: parts[1] || '', profile: r3.data }, phone, 'pair', 'pair');
    if (diagPath) writeDiag(diagPath, { phone, res, cands, candTags, matched: { via: 'pair', cand: 'pair' }, selfOk: cm.selfOk });
    return { ok: true, authToken: parts[0], profile: r3.data, via: 'pair', selfOk: cm.selfOk, diagFile: diagPath };
  }

  // D 阶段：纯 Cookie
  if (cookieHeader) {
    const stageD = [
      { name: 'cookie', h: { Cookie: cookieHeader, 'X-Access-Token': XA } },
      { name: 'cookie+auth', h: { Cookie: cookieHeader, 'X-Access-Token': XA, Authorization: (cands[0] || '') + '&&APP' } },
    ];
    const r4 = await raceTry(stageD, 2);
    if (r4) {
      const cm = await commit({ profile: r4.data, cookie: cookieHeader }, phone, r4.hit.name, 'cookie');
      if (diagPath) writeDiag(diagPath, { phone, res, cands, candTags, matched: { via: r4.hit.name, cand: 'cookie' }, selfOk: cm.selfOk });
      return { ok: true, profile: r4.data, cookie: cookieHeader, via: r4.hit.name, selfOk: cm.selfOk, diagFile: diagPath };
    }
  }

  /* 走到这里说明「密码对、票据拿不到」。把线索留给日志与界面，不要只说一句失败。 */
  let keys = [];
  try { keys = json.data && typeof json.data === 'object' ? Object.keys(json.data) : []; } catch (e) {}
  log.warn('auth', '登录响应未找到可用票据（候选 ' + cands.length + ' 个，data 字段 ' + JSON.stringify(keys) + '）');
  if (diagPath) writeDiag(diagPath, { phone, res, cands, candTags, matched: null });
  return { ok: false, noTicket: true, candidates: cands.length, keys: keys, diagFile: diagPath };
}

/** 把一次登录的完整现场写盘：原始响应 + 候选清单 + 全部探测结果。 */
function writeDiag(file, ctx) {
  try {
    const res = ctx.res || {};
    const cands = ctx.cands || [];
    const tags = ctx.candTags || {};
    fs.writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      phone: String(ctx.phone || '').replace(/^(\d{3})\d{4}(\d+)$/, '$1****$2'),
      status: res.status,
      responseHeaders: res.headers || {},
      responseBody: String(res.text || ''),
      candidates: cands.map((c, i) => ({ i: i, tag: tags[c] || 'body', len: c.length, value: c })),
      matched: ctx.matched || null,
      note: 'candidates 里每个值都按 Authorization:<v>&&APP / Authorization:<v> / userToken:<v> / 双填 依次打过 /api/profile；matched 为命中的那一组。',
    }, null, 2), 'utf8');
    log.info('auth', '登录原始响应已保存 ' + file);
  } catch (e) {
    log.warn('auth', '登录诊断落盘失败 :: ' + ((e && e.message) || e));
  }
}

/* ==================== 验证码登录 ====================
 * 密码登录这条路在这个后台上是「5 次错就锁 15 分钟」，而用户的账密在手机端早就能用，
 * 所以真正稳的入口是验证码：发码 → 校验 → 直接换会话。
 * 接口（实测，2026-11-17）：
 *   POST /account/H5/register/sendVerifyCode  body {phone, type}  → code=1 操作成功；60s 内重复发会拒绝
 *   POST /account/loginByVerifyCode           body {phone, verifyCode} → code=1 + data（与密码登录同结构）
 *   POST /account/updatePassword              body {phone, verifyCode, newPassword}
 * 下面两个函数只负责「发」和「收」，挑票据仍然复用 adopt()。 */

/** 发送短信验证码。type 缺省时后端也接受，但显式给 'login' 更符合语义。 */
async function sendCode(phone) {
  const p = String(phone || '').trim();
  if (!/^\d{6,15}$/.test(p)) return { ok: false, error: '手机号格式不对' };
  try {
    const res = await net.fetchText(API_BASE + '/account/H5/register/sendVerifyCode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: APP_TOKEN + '&&APP',
        'X-Access-Token': '0',
      },
      body: Buffer.from(JSON.stringify({ phone: p, type: 'login' }), 'utf8'),
      timeout: 20000,
      retries: 1,
    });
    let j = null;
    try { j = JSON.parse(res.text); } catch (e) {}
    const ok = !!(j && j.code === 1);
    log.info('auth', '发送验证码 HTTP ' + res.status + ' code=' + (j && j.code) + ' msg=' + (j && j.message));
    if (!ok) return { ok: false, message: (j && j.message) || ('HTTP ' + res.status) };
    return { ok: true, message: '验证码已发送，请查看手机短信' };
  } catch (e) {
    log.error('auth', '发送验证码失败 :: ' + ((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 用手机号 + 短信验证码登录。成功后的会话处理与密码登录完全一致。 */
async function loginByCode(phone, code) {
  const p = String(phone || '').trim();
  const c = String(code || '').trim();
  if (!/^\d{6,15}$/.test(p)) return { ok: false, error: '手机号格式不对' };
  if (!/^\d{4,8}$/.test(c)) return { ok: false, error: '验证码格式不对' };
  let res;
  try {
    res = await net.fetchText(API_BASE + '/account/loginByVerifyCode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: APP_TOKEN + '&&APP',
        'X-Access-Token': '0',
      },
      body: Buffer.from(JSON.stringify({ phone: p, verifyCode: c }), 'utf8'),
      timeout: 20000,
      retries: 1,
    });
  } catch (e) {
    log.error('auth', '验证码登录网络失败 :: ' + ((e && e.message) || e));
    return { ok: false, netError: String((e && e.message) || e) };
  }
  log.info('auth', '验证码登录 HTTP ' + res.status);
  return await adopt(res, p);
}

/** 刷新资料（低频，用于校验票据是否还有效） */
async function refreshProfile(force) {
  if (!force && Date.now() - lastProfileAt < 60 * 1000) return get().profile;
  lastProfileAt = Date.now();
  try {
    const r = await net.fetchText(API_BASE + '/profile', { headers: headers(), timeout: 12000, retries: 1 });
    const j = JSON.parse(r.text);
    if (j && j.code === 1 && j.data && j.data.id) {
      const s = get();
      set({ authToken: s.authToken, userToken: s.userToken, profile: j.data });
      return j.data;
    }
  } catch (e) {}
  return null;
}

module.exports = {
  API_BASE, get, set, clear, headers, autoLogin, login, loginByCode, sendCode,
  refreshProfile, tryTicket, tryHeaders, hit, hasToken,
  lastDiagFile: () => lastDiagFile,
  lastOkAt: () => lastOkAt,
};
