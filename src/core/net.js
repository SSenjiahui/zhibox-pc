// 智博X · 内核 · HTTP 客户端
// 特点：连接复用、自动重定向、超时/重试、并发闸门、二进制直落盘（不占内存）
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const log = require('./logger');

const UA = 'ZhiboPC/1.5 (Windows NT 10.0; Win64; x64)';

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 }),
};

/* ---------- 离线开关（真·离线模式：连 DNS 都不发） ---------- */
let OFFLINE = false;

function setOffline(v) {
  OFFLINE = !!v;
  try { log.info('net', '离线模式 = ' + OFFLINE); } catch (e) {}
  return OFFLINE;
}
function isOffline() { return OFFLINE; }

/* ---------- 全局并发闸门 ---------- */
let active = 0;
const waiters = [];
let limit = 4;

function setConcurrency(n) {
  limit = Math.max(1, Math.min(16, Number(n) || 4));
}

function acquire() {
  if (active < limit) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}

function release() {
  active = Math.max(0, active - 1);
  const w = waiters.shift();
  if (w) { active++; w(); }
}

function stats() {
  return { active, queued: waiters.length, limit };
}

/* ---------- 单次请求 ---------- */
function once(urlStr, opt) {
  return new Promise((resolve, reject) => {
    if (OFFLINE) { reject(new Error('离线模式已开启，已拦截请求')); return; }
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('非法 URL: ' + urlStr)); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('不支持的协议: ' + u.protocol));
      return;
    }
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept-Encoding': 'gzip, deflate',
    }, opt.headers || {});

    const req = (u.protocol === 'https:' ? https : http).request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opt.method || 'GET',
      headers: headers,
      agent: agents[u.protocol],
      servername: u.protocol === 'https:' ? u.hostname : undefined,
    }, (res) => {
      const status = res.statusCode || 0;
      // 重定向
      if (status >= 300 && status < 400 && res.headers.location && (opt.redirects == null ? 5 : opt.redirects) > 0) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).toString();
        resolve(once(next, Object.assign({}, opt, { redirects: (opt.redirects == null ? 5 : opt.redirects) - 1 })));
        return;
      }

      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br' && zlib.createBrotliDecompress) stream = res.pipe(zlib.createBrotliDecompress());

      resolve({ status, headers: res.headers, stream });
    });

    req.on('error', reject);
    req.setTimeout(opt.timeout || 25000, () => req.destroy(new Error('请求超时 ' + (opt.timeout || 25000) + 'ms')));
    if (opt.signal) {
      opt.signal.addEventListener('abort', () => req.destroy(new Error('已取消')));
    }
    if (opt.body) req.write(opt.body);
    req.end();
  });
}

/** 把响应流收成 Buffer（带上限保护） */
function collect(stream, maxBytes) {
  const cap = maxBytes || 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    stream.on('data', (c) => {
      n += c.length;
      if (n > cap) { stream.destroy(new Error('响应超过上限 ' + cap + ' 字节')); return; }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/* ---------- 带闸门 + 重试的对外接口 ---------- */
const RETRY_ON = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|超时|已取消|ECONNREFUSED/i;

async function fetchBuffer(urlStr, opt) {
  if (OFFLINE) throw new Error('离线模式已开启，已拦截请求');
  const o = opt || {};
  const tries = Math.max(1, o.retries == null ? 3 : o.retries);
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    await acquire();
    try {
      const r = await once(urlStr, o);
      const buf = await collect(r.stream, o.maxBytes);
      return { status: r.status, headers: r.headers, buffer: buf };
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (o.signal && o.signal.aborted) break;
      if (!RETRY_ON.test(msg) || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 180 * (i + 1)));
    } finally {
      release();
    }
  }
  throw lastErr || new Error('请求失败');
}

async function fetchText(urlStr, opt) {
  const r = await fetchBuffer(urlStr, opt);
  return { status: r.status, headers: r.headers, text: r.buffer.toString('utf8') };
}

async function fetchJson(urlStr, opt) {
  const r = await fetchText(urlStr, opt);
  let json = null;
  try { json = JSON.parse(r.text); } catch (e) {
    throw new Error('返回不是合法 JSON（HTTP ' + r.status + '）：' + r.text.slice(0, 160));
  }
  return { status: r.status, headers: r.headers, json, text: r.text };
}

/**
 * 直接把响应体写到文件（大分片/大文件用，绝不整块进内存）。
 * @returns {Promise<{status:number, bytes:number, headers:object}>}
 */
async function downloadTo(urlStr, destPath, opt) {
  if (OFFLINE) throw new Error('离线模式已开启，已拦截下载');
  const o = opt || {};
  const tries = Math.max(1, o.retries == null ? 3 : o.retries);
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    await acquire();
    let ws = null;
    try {
      const r = await once(urlStr, o);
      if (r.status !== 200) {
        await collect(r.stream, 1 << 20).catch(() => {});
        throw new Error('HTTP ' + r.status);
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      ws = fs.createWriteStream(destPath);
      const bytes = await new Promise((resolve, reject) => {
        let n = 0;
        r.stream.on('data', (c) => { n += c.length; });
        r.stream.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve(n));
        r.stream.pipe(ws);
      });
      return { status: r.status, bytes, headers: r.headers };
    } catch (e) {
      lastErr = e;
      try { if (ws) ws.destroy(); } catch (x) {}
      try { fs.unlinkSync(destPath); } catch (x) {}
      const msg = String((e && e.message) || e);
      if (o.signal && o.signal.aborted) break;
      if (!RETRY_ON.test(msg) || i === tries - 1) break;
      await new Promise((r2) => setTimeout(r2, 180 * (i + 1)));
    } finally {
      release();
    }
  }
  throw lastErr || new Error('下载失败');
}

module.exports = {
  fetchBuffer, fetchText, fetchJson, downloadTo, setConcurrency, stats, UA,
  setOffline, isOffline,
};