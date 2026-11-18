// 智博X · 内核 · 持久化存储
// 零依赖 KV：JSON 文件 + 原子写 + 写合并（debounce）+ 进程退出前强制落盘
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const cache = new Map();     // name -> data
const dirty = new Set();
const timers = new Map();
let dir = '';

function init(stateDir) {
  dir = stateDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

function fileOf(name) {
  return path.join(dir, name.replace(/[^\w.-]/g, '_') + '.json');
}

/** 读取（带内存缓存）。文件不存在返回 fallback */
function get(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  let data = fallback;
  try {
    const txt = fs.readFileSync(fileOf(name), 'utf8');
    data = JSON.parse(txt);
  } catch (e) {
    data = fallback;
  }
  cache.set(name, data);
  return data;
}

/** 原子写：先写 .tmp 再 rename，断电不会留半个 JSON */
function flush(name) {
  if (!dir) return false;
  const data = cache.get(name);
  const file = fileOf(name);
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    dirty.delete(name);
    return true;
  } catch (e) {
    log.warn('store', '写入失败 ' + name + ' :: ' + ((e && e.message) || e));
    try { fs.unlinkSync(tmp); } catch (x) {}
    return false;
  }
}

function schedule(name, ms) {
  dirty.add(name);
  if (timers.has(name)) return;
  const t = setTimeout(() => {
    timers.delete(name);
    flush(name);
  }, ms || 1200);
  if (t.unref) t.unref();
  timers.set(name, t);
}

/** 写入（默认合并写，重要数据传立即 flush） */
function set(name, data, immediate) {
  cache.set(name, data);
  if (immediate) {
    if (timers.has(name)) { clearTimeout(timers.get(name)); timers.delete(name); }
    return flush(name);
  }
  schedule(name);
  return true;
}

/** 局部更新：读 → 交给 mutator 改 → 写回 */
function update(name, fallback, mutator, immediate) {
  const cur = get(name, fallback);
  const next = mutator(cur) || cur;
  set(name, next, immediate);
  return next;
}

function remove(name) {
  cache.delete(name);
  dirty.delete(name);
  try { fs.unlinkSync(fileOf(name)); } catch (e) {}
}

function flushAll() {
  for (const n of Array.from(dirty)) flush(n);
}

function names() {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch (e) { return []; }
}

module.exports = { init, get, set, update, remove, flush, flushAll, names, dir: () => dir };
