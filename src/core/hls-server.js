// 智博X · 内核 · 本地流服务
// 同一份会话同时暴露两种输出：
//   1) /hls/<sid>/index.m3u8 + seg/N.ts      —— 明文 HLS（hls.js 兼容兜底）
//   2) /fmp4/<sid>/init.mp4 + seg/N.m4s      —— 自研 fMP4 流（MSE 内核直吃，零第三方依赖）
// 播放与缓存是同一次 IO：任何一路取到的分片都会落进离线库。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const vod = require('./vod');
const lib = require('./library');
const auth = require('./auth');
const log = require('./logger');

let server = null;
let baseUrl = '';
const sessions = new Map();   // sid -> session

// fMP4 封装器（可选：模块缺失时自动只留 HLS 一路）
let fmp4 = null;
try { fmp4 = require('./fmp4'); log.info('hls', 'fMP4 流式封装内核已加载'); }
catch (e) { fmp4 = null; log.warn('hls', 'fMP4 内核未就绪（回退 HLS） :: ' + ((e && e.message) || e)); }

/* fMP4 内存缓存上限（段）。每段约 150KB，48 段 ≈ 7MB，
 * 更早的段需要时从明文 TS 重新封装（单段 ~35ms），不占磁盘。 */
const F4_CACHE_MAX = 48;

function newSid() {
  return require('crypto').randomBytes(8).toString('hex');
}

function start(port) {
  if (server) return Promise.resolve(baseUrl);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handle);
    srv.on('error', reject);
    srv.listen(port || 0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + srv.address().port;
      server = srv;
      log.info('hls', '本地流服务已启动 ' + baseUrl);
      resolve(baseUrl);
    });
  });
}

function stop() {
  if (server) { try { server.close(); } catch (e) {} server = null; baseUrl = ''; }
}

/* ---------------- 分片取用（磁盘优先，缺则远端下载并解密落盘） ---------------- */

async function readOrFetchTs(s, idx) {
  const file = lib.segFileOf(s.courseId, s.lessonId, idx);
  try {
    const st = fs.statSync(file);
    if (st.size > 0) return fs.readFileSync(file);
  } catch (e) {}
  if (s.local) throw new Error('离线会话缺少分片 #' + idx);
  const r = await cacheSegment(s, idx);
  if (r.buf) return r.buf;
  return fs.readFileSync(r.file);
}

/** 把分片落盘到离线库（幂等，已存在直接跳过） */
async function cacheSegment(s, idx) {
  const file = lib.segFileOf(s.courseId, s.lessonId, idx);
  try {
    const st = fs.statSync(file);
    if (st.size > 0) return { buf: null, file, cached: true };
  } catch (e) {}

  const seg = s.info.segments[idx];
  if (!seg) throw new Error('分片越界 ' + idx);
  const buf = await vod.fetchSegment(seg, s.key, s.iv, s.auth);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.part';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn('hls', '分片落盘失败 ' + idx + ' :: ' + ((e && e.message) || e));
  }
  return { buf, file, cached: false };
}

/* ---------------- fMP4 会话状态 ---------------- */

/** 由分片声明时长推出 90kHz 时间轴（客户端与服务端共用同一套，保证 seek 对齐） */
function buildTimeline(info, durs) {
  const list = [];
  let acc = 0;
  for (let i = 0; i < info.segments.length; i++) {
    const dur = Number(durs && durs[i]) || Number(info.segments[i].duration) || 10;
    list.push({ startSec: acc, durSec: dur, start90k: Math.round(acc * 90000) });
    acc += dur;
  }
  return { list, total: acc };
}

function f4Of(s) {
  if (!s.f4) {
    const tl = buildTimeline(s.info, s.segDurs);
    s.f4 = {
      timeline: tl,
      init: null,
      codec: '',
      width: 0,
      height: 0,
      sampleRate: 0,
      channels: 0,
      cache: new Map(),     // idx -> media Buffer
      seq: 0,
      chain: Promise.resolve(),
      errors: 0,
    };
  }
  return s.f4;
}

/** 解析第 0 片，产出 init 段与 codec（一次即可，后续复用） */
async function ensureInit(s) {
  const f = f4Of(s);
  if (f.init) return f;
  const ts = await readOrFetchTs(s, 0);
  const parsed = fmp4.parseSegment(ts);
  if (!parsed) throw new Error('首片不是合法 MPEG-TS');
  f.init = fmp4.buildInit(parsed);
  f.codec = fmp4.codecString(parsed);
  f.width = parsed.width || 0;
  f.height = parsed.height || 0;
  f.sampleRate = parsed.sampleRate || 0;
  f.channels = parsed.channels || 0;
  log.info('hls', 'fMP4 初始化段就绪 codec=' + f.codec + ' ' + f.width + 'x' + f.height +
    ' 分片=' + s.info.segments.length + ' 时间轴=' + f.timeline.total.toFixed(1) + 's');
  return f;
}

/** 取第 idx 段的 moof+mdat（必要时现场封装；同一会话内串行，避免重复劳动） */
function ensureSeg(s, idx) {
  const f = f4Of(s);
  if (f.cache.has(idx)) return Promise.resolve(f.cache.get(idx));

  const job = f.chain.then(async () => {
    if (f.cache.has(idx)) return f.cache.get(idx);
    await ensureInit(s);
    const ts = await readOrFetchTs(s, idx);
    const baseDts = f.timeline.list[idx] ? f.timeline.list[idx].start90k : 0;
    const r = fmp4.convert(ts, { baseDts: baseDts, seq: f.seq++ });
    if (!r || !r.ok && !r.media) {
      throw new Error('fMP4 封装失败 #' + idx + ' :: ' + ((r && r.error) || 'unknown'));
    }
    const media = r.media || (r.ok ? r.media : null);
    if (!media) throw new Error('fMP4 封装无输出 #' + idx);
    f.cache.set(idx, media);
    // 顺序淘汰最旧
    while (f.cache.size > F4_CACHE_MAX) {
      const k = f.cache.keys().next().value;
      f.cache.delete(k);
    }
    return media;
  });

  // 串联：失败也要把链放回可用态，否则后续请求永远挂着
  f.chain = job.catch((e) => {
    log.warn('hls', 'fMP4 段封装失败 #' + idx + ' :: ' + ((e && e.message) || e));
    f.errors++;
    return null;
  });
  return job;
}

/* ---------------- HLS 清单（兜底一路） ---------------- */

function buildPlaylist(s, startIdx) {
  const out = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:' + Math.ceil(s.info.segments[0] ? s.info.segments[0].duration : 10),
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (let i = startIdx || 0; i < s.info.segments.length; i++) {
    out.push('#EXTINF:' + (s.info.segments[i].duration || 10).toFixed(6) + ',');
    out.push('seg/' + i + '.ts');
  }
  out.push('#EXT-X-ENDLIST');
  return out.join('\n') + '\n';
}

/**
 * 打开一个播放会话。
 * @param {{signature:string, streamIndex?:number, courseId:string, lessonId:string,
 *          lessonName?:string, courseName?:string}} opts
 */
async function open(opts) {
  const sess = auth.get();
  const info = await vod.resolve(opts.signature, opts.streamIndex || 0, sess);

  const key = info.keyUrl ? await vod.fetchKey(info.keyUrl, sess) : null;

  const sid = newSid();
  const s = {
    sid,
    courseId: String(opts.courseId || '0'),
    lessonId: String(opts.lessonId),
    lessonName: opts.lessonName || info.name,
    courseName: opts.courseName || '',
    info,
    key,
    iv: info.iv,
    auth: sess,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    prefetch: new Map(),  // index -> Promise
  };
  sessions.set(sid, s);
  log.info('hls', '打开会话 ' + sid + ' lesson=' + s.lessonId + ' ' + info.streams[info.current].width + 'x' +
    info.streams[info.current].height + ' 分片=' + info.segments.length + ' 时长=' + info.duration.toFixed(1) + 's');

  // 写 meta（记录清晰度，供离线库展示）
  const meta = lib.readMeta(s.courseId, s.lessonId) || lib.emptyMeta(s.courseId, s.lessonId);
  meta.lessonName = s.lessonName;
  meta.courseName = s.courseName;
  meta.duration = info.duration;
  meta.segCount = info.segments.length;
  meta.definition = info.streams[info.current].definition;
  meta.width = info.streams[info.current].width;
  meta.height = info.streams[info.current].height;
  meta.segDurs = info.segments.map((x) => Number(x.duration) || 0);
  if (!meta.createdAt) meta.createdAt = Date.now();
  if (meta.status === 'idle') meta.status = 'partial';
  lib.writeMeta(s.courseId, s.lessonId, meta);

  // 自研 fMP4 内核：先把 init 段做出来，客户端才能一次拿到 codec 与时长表
  let f4 = null;
  if (fmp4) {
    try {
      const f = await ensureInit(s);
      f4 = {
        base: baseUrl + '/fmp4/' + sid,
        // IPC 直连地址：渲染进程经 preload 的 play.fetch 向主进程要字节，
        // 完全不经过本机端口（端口被占 / 服务未起都不影响播放）
        ipcBase: 'ipcbridge://fmp4/' + sid,
        codec: f.codec,
        width: f.width, height: f.height,
        sampleRate: f.sampleRate, channels: f.channels,
        segDurs: f.timeline.list.map((x) => x.durSec),
        timelineTotal: f.timeline.total,
      };
    } catch (e) {
      log.warn('hls', 'fMP4 初始化失败，本会话回退 HLS :: ' + ((e && e.message) || e));
      f4 = null;
    }
  }

  return {
    sid,
    url: baseUrl + '/hls/' + sid + '/index.m3u8',
    // 自研内核地址（渲染进程优先用它；为 null 则回退 hls.js）
    engine: f4,
    name: s.lessonName,
    duration: info.duration,
    streams: info.streams,
    current: info.current,
    segCount: info.segments.length,
  };
}

/**
 * 打开一个「纯离线」会话：完全不发网络请求，只用离线库里的明文分片。
 * 用于「下载到一半 / 未封装 MP4 / 断网」时仍然能播已缓存部分——这是真正独立的关键一环。
 * @param {{courseId:string, lessonId:string, lessonName?:string, courseName?:string, maxSeg?:number}} opts
 */
async function openLocal(opts) {
  if (!fmp4) throw new Error('fMP4 内核未加载，无法本地播放');
  const courseId = String(opts.courseId || '0');
  const lessonId = String(opts.lessonId);
  const meta = lib.readMeta(courseId, lessonId);
  if (!meta || !meta.segCount) throw new Error('本地没有这节课的缓存');

  // 只能用「从 0 开始连续」的分片：中间缺片会导致时间轴断裂
  const have = lib.contiguousDone(courseId, lessonId, meta.segCount);
  if (!have) throw new Error('本地分片不连续，无法流式播放');

  const segDurs = Array.isArray(meta.segDurs) && meta.segDurs.length === meta.segCount
    ? meta.segDurs
    : new Array(meta.segCount).fill((Number(meta.duration) || 0) / meta.segCount || 10);

  // 构造与远端同构的 info（segments 只需长度，url 为空表示不可联网取）
  const info = {
    name: meta.lessonName || '',
    duration: Number(meta.duration) || segDurs.reduce((a, b) => a + b, 0),
    streams: [{ index: 0, definition: meta.definition, width: meta.width, height: meta.height,
      bitrate: 0, duration: meta.duration, size: meta.bytes, url: '', label: (meta.height || 0) + 'P' }],
    current: 0,
    segments: segDurs.map((d, i) => ({ index: i, url: '', duration: d })),
    segmentDuration: 0,
  };

  const sid = newSid();
  const s = {
    sid, courseId, lessonId,
    lessonName: opts.lessonName || meta.lessonName || '',
    courseName: opts.courseName || meta.courseName || '',
    info, key: null, iv: null, auth: null,
    local: true,                 // 关键标记：不许联网
    segDurs,
    maxSeg: Math.min(have, meta.segCount),
    createdAt: Date.now(), lastAccess: Date.now(),
    prefetch: new Map(),
  };
  sessions.set(sid, s);

  const f = await ensureInit(s);
  log.info('hls', '打开离线会话 ' + sid + ' lesson=' + lessonId + ' 可用分片=' + s.maxSeg + '/' + meta.segCount +
    ' codec=' + f.codec + ' ' + f.width + 'x' + f.height);

  return {
    sid,
    url: baseUrl + '/hls/' + sid + '/index.m3u8',
    engine: {
      base: baseUrl + '/fmp4/' + sid,
      ipcBase: 'ipcbridge://fmp4/' + sid,
      codec: f.codec,
      width: f.width, height: f.height,
      sampleRate: f.sampleRate, channels: f.channels,
      segDurs: f.timeline.list.map((x) => x.durSec),
      timelineTotal: f.timeline.total,
      availableSegs: s.maxSeg,
    },
    name: s.lessonName,
    duration: info.duration,
    streams: info.streams,
    current: 0,
    segCount: s.maxSeg,
    offline: true,
  };
}

function close(sid) {
  const s = sessions.get(sid);
  if (s && s.f4) s.f4.cache.clear();
  sessions.delete(sid);
}

/* ---------------- HTTP 路由 ---------------- */

function send(res, code, type, body, extra) {
  const h = Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body),
  }, extra || {});
  res.writeHead(code, h);
  res.end(body);
}

/**
 * 路由解析的唯一实现：给定 pathname，返回 { code, type, body }。
 *
 * 为什么要抽出来：内核取分片原本只有 HTTP 一条路（本机 127.0.0.1:随机端口）。
 * 服务进程万一没起来 / 端口被占 / 防火墙拦，播放就全废。把它做成纯函数后，
 * 渲染进程可以经 IPC 直接拿到同样的字节，内核不再依赖端口——这是「真正独立」
 * 的最后一块：播放路径上没有网络栈参与，也就没有端口、没有握手、没有超时。
 */
async function resolvePath(pathname) {
  const m = /^\/(hls|fmp4)\/([0-9a-f]+)\/(.+)$/.exec(pathname);
  if (!m) return { code: 404, type: 'text/plain; charset=utf-8', body: Buffer.from('not found') };
  const kind = m[1];
  const s = sessions.get(m[2]);
  if (!s) return { code: 404, type: 'text/plain; charset=utf-8', body: Buffer.from('session not found') };
  s.lastAccess = Date.now();
  const what = m[3];

  const ok = (type, body) => ({ code: 200, type, body: Buffer.isBuffer(body) ? body : Buffer.from(body) });
  const tb = (code, text) => ({ code, type: 'text/plain; charset=utf-8', body: Buffer.from(String(text)) });

  /* ---------- fMP4 一路（自研内核） ---------- */
  if (kind === 'fmp4') {
    if (!fmp4) return tb(503, 'fmp4 engine unavailable');

    if (what === 'init.mp4') {
      const f = await ensureInit(s);
      return ok('video/mp4', f.init);
    }

    if (what === 'meta.json') {
      const f = await ensureInit(s);
      /* 离线会话只缓存了前 maxSeg 片：这里必须把清单裁到可用范围。
       * 否则内核按全量 segCount 一路要到 333，越过 maxSeg 就是 416，
       * 表现成「离线播到缓存末尾就卡住，进度条再也走不动」。 */
      const total = s.info.segments.length;
      const usable = s.local ? Math.min(s.maxSeg || 0, total) : total;
      const durs = f.timeline.list.slice(0, usable).map((x) => x.durSec);
      const dur = durs.reduce((a, b) => a + b, 0);
      return ok('application/json', JSON.stringify({
        codec: f.codec,
        segCount: usable,
        duration: dur,
        segDurs: durs,
        width: f.width, height: f.height,
        sampleRate: f.sampleRate, channels: f.channels,
        local: !!s.local,
        totalSegCount: total,
      }));
    }

    const fm = /^seg\/(\d+)\.m4s$/.exec(what);
    if (fm) {
      const idx = Number(fm[1]);
      const limit = s.local ? (s.maxSeg || 0) : s.info.segments.length;
      if (idx < 0 || idx >= limit) return tb(416, 'bad index');
      const media = await ensureSeg(s, idx);
      return ok('video/iso.segment', media);
    }

    return tb(404, 'unknown fmp4 route');
  }

  /* ---------- 明文 HLS 一路（兜底） ---------- */
  if (what === 'index.m3u8') return ok('application/vnd.apple.mpegurl', buildPlaylist(s, 0));

  if (what === 'meta.json') {
    return ok('application/json', JSON.stringify({
      segCount: s.info.segments.length, duration: s.info.duration,
      streams: s.info.streams, current: s.info.current,
    }));
  }

  const sm = /^seg\/(\d+)\.ts$/.exec(what);
  if (sm) {
    const idx = Number(sm[1]);
    /* 离线会话没有远端分片地址（seg.url 为空串）。
     * 老代码直接往下走 cacheSegment → net.once 里 new URL('') 抛「非法 URL: 」，
     * 用户日志里那一串 502 就是这么来的。离线会话只认磁盘，缺片就是 416。 */
    if (s.local && !fs.existsSync(lib.segFileOf(s.courseId, s.lessonId, idx))) {
      return tb(416, 'offline segment unavailable');
    }
    let buf;
    const file = lib.segFileOf(s.courseId, s.lessonId, idx);
    if (fs.existsSync(file)) {
      buf = fs.readFileSync(file);
    } else {
      if (!s.prefetch.has(idx)) {
        s.prefetch.set(idx, cacheSegment(s, idx).finally(() => s.prefetch.delete(idx)));
      }
      const r = await s.prefetch.get(idx) || await cacheSegment(s, idx);
      buf = r.buf || fs.readFileSync(r.file);
    }
    return ok('video/mp2t', buf);
  }

  return tb(404, 'unknown route');
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    const r = await resolvePath(u.pathname);
    send(res, r.code, r.type, r.body);
  } catch (e) {
    log.error('hls', 'hls 请求失败 ' + u.pathname + ' :: ' + ((e && e.stack) || e));
    send(res, 502, 'text/plain; charset=utf-8', String((e && e.message) || e));
  }
}

/* 定期回收 3 小时未访问的会话 */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.lastAccess > 3 * 3600 * 1000) {
      if (v.f4) v.f4.cache.clear();
      sessions.delete(k);
    }
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  start, stop, open, openLocal, close, sessions, resolvePath,
  baseUrl: () => baseUrl, hasFmp4: () => !!fmp4,
};