// 智博X · 内核 · 常驻日志
// 双通道：文件（<root>/logs/app-YYYY-MM-DD.log，按天滚动 + 单文件上限）
//        内存环（最近 N 条，供 UI 实时查看 / 崩溃前回溯）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_RING = 2000;
const MAX_FILE = 8 * 1024 * 1024;

const ring = [];
let ringSeq = 0;
let logDir = '';
let curDay = '';
let curStream = null;
let curSize = 0;
let listeners = [];

function pad(n, w) {
  let s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

function stamp(d) {
  const t = d || new Date();
  return (
    t.getFullYear() + '-' + pad(t.getMonth() + 1, 2) + '-' + pad(t.getDate(), 2) +
    ' ' + pad(t.getHours(), 2) + ':' + pad(t.getMinutes(), 2) + ':' + pad(t.getSeconds(), 2) +
    '.' + pad(t.getMilliseconds(), 3)
  );
}

function dayKey(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1, 2) + '-' + pad(t.getDate(), 2);
}

function openFor(day) {
  closeStream();
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'app-' + day + '.log');
    curSize = 0;
    try { curSize = fs.statSync(file).size; } catch (e) {}
    curStream = fs.createWriteStream(file, { flags: 'a' });
    curStream.on('error', () => { curStream = null; });
    curDay = day;
  } catch (e) {
    curStream = null;
  }
}

function closeStream() {
  if (curStream) {
    try { curStream.end(); } catch (e) {}
    curStream = null;
  }
}

function rotateIfNeeded() {
  if (!curStream) return;
  if (curSize <= MAX_FILE) return;
  const day = dayKey();
  const file = path.join(logDir, 'app-' + day + '.log');
  try {
    fs.renameSync(file, file + '.' + Date.now() + '.bak');
  } catch (e) {}
  openFor(day);
}

function formatArg(a) {
  if (a == null) return String(a);
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object') {
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  return String(a);
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} scope 模块名，如 'net' / 'vod' / 'kernel'
 * @param {...any} args
 */
function log(level, scope, ...args) {
  const now = new Date();
  const line = stamp(now) + ' [' + level.toUpperCase() + '] [' + scope + '] ' +
    args.map(formatArg).join(' ');
  const rec = { seq: ++ringSeq, t: now.getTime(), level: level, scope: scope, text: line };
  ring.push(rec);
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);

  const day = dayKey(now);
  if (!logDir) {
    // 还没 init：只留内存
  } else {
    if (day !== curDay || !curStream) openFor(day);
    if (curStream) {
      try {
        curStream.write(line + '\n');
        curSize += Buffer.byteLength(line) + 1;
        rotateIfNeeded();
      } catch (e) {}
    }
  }

  for (let i = 0; i < listeners.length; i++) {
    try { listeners[i](rec); } catch (e) {}
  }
  if (level === 'error' || level === 'warn') {
    try { console.log(line); } catch (e) {}
  }
  return rec;
}

function init(root) {
  logDir = path.join(root || '', 'logs');
  openFor(dayKey());
  log('info', 'logger', '日志目录 = ' + logDir + '  平台=' + process.platform + ' pid=' + process.pid);
}

function debug(scope, ...a) { return log('debug', scope, ...a); }
function info(scope, ...a) { return log('info', scope, ...a); }
function warn(scope, ...a) { return log('warn', scope, ...a); }
function error(scope, ...a) { return log('error', scope, ...a); }

/** 读内存环（可按 seq 增量拉取） */
function tail(sinceSeq, limit) {
  const from = Math.max(0, Number(sinceSeq) || 0);
  let list = ring.filter((r) => r.seq > from);
  if (limit && list.length > limit) list = list.slice(list.length - limit);
  return list;
}

/** 读磁盘日志文件尾部 */
function readFile(day, maxLines) {
  const d = day || dayKey();
  const file = path.join(logDir, 'app-' + d + '.log');
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split('\n');
    const n = Math.max(1, Math.min(5000, maxLines || 500));
    return { file: file, total: lines.length, lines: lines.slice(Math.max(0, lines.length - n - 1)) };
  } catch (e) {
    return { file: file, total: 0, lines: [], error: String((e && e.message) || e) };
  }
}

/** 列出已有日志日 */
function listDays() {
  try {
    return fs.readdirSync(logDir)
      .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => ({ day: f.slice(4, 14), file: path.join(logDir, f), size: fs.statSync(path.join(logDir, f)).size }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  } catch (e) {
    return [];
  }
}

function onRecord(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((x) => x !== fn); };
}

function dirPath() { return logDir; }

module.exports = {
  init, log, debug, info, warn, error, tail, readFile, listDays, onRecord,
  dirPath, dayKey, flush: closeStream,
  hostInfo: () => ({ platform: process.platform, arch: process.arch, pid: process.pid, uptime: os.uptime() }),
};
