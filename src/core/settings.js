// 智博X · 内核 · 设置
// 所有会影响内核行为的开关集中在这里，落盘到 <数据根>/state/settings.json。
'use strict';

const store = require('./store');
const log = require('./logger');

const KEY = 'settings';
const STATE_FILE = 'state/settings.json';

/** 出厂默认值 —— 每一项都会在 boot 时真正生效，不是摆设 */
const DEFAULTS = {
  /* 网络与下载 */
  netConcurrency: 4,      // 全局 HTTP 并发闸门（1..16）
  queueConcurrency: 2,    // 同时下载的课时数（1..3）
  segConcurrency: 4,      // 单课时并行分片数（1..8）
  autoRemux: true,        // 分片下完自动封装成 MP4
  cacheLimitMB: 0,        // 离线库上限（MB），0 = 不限
  offline: false,         // 强制离线：拦截一切出网请求，只读本地

  /* 播放 */
  prefRate: 1,            // 倍速记忆（0.75..2）
  prefQuality: 'auto',    // auto | high | low
  volume: 1,              // 0..1
  muted: false,
  autoPlay: true,         // 打开课时自动播
  resumePlay: true,       // 续播

  /* 桌面行为 */
  trayOnClose: true,      // 关窗口 → 收进托盘，内核继续跑
  notifyOnDone: true,     // 下载/封装完成发系统通知
  keepAwakeWhileDownload: false, // 下载时阻止系统休眠
  startMinimized: false,
};

/** 数值字段的取值范围，用于输入校验（不做静默截断之外的花样） */
const RANGES = {
  netConcurrency: [1, 16],
  queueConcurrency: [1, 3],
  segConcurrency: [1, 8],
  cacheLimitMB: [0, 1024 * 1024],
  prefRate: [0.5, 3],
  volume: [0, 1],
};

const BOOLS = ['autoRemux', 'offline', 'muted', 'autoPlay', 'resumePlay',
  'trayOnClose', 'notifyOnDone', 'keepAwakeWhileDownload', 'startMinimized'];

let cache = null;

function normalize(raw) {
  const out = Object.assign({}, DEFAULTS);
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(DEFAULTS).forEach((k) => {
    const v = raw[k];
    if (v === undefined || v === null) return;
    if (k === 'prefQuality') {
      if (v === 'auto' || v === 'high' || v === 'low' || v === 'file') out[k] = v;
      return;
    }
    if (BOOLS.indexOf(k) >= 0) { out[k] = !!v; return; }
    const n = Number(v);
    if (!isFinite(n)) return;
    const r = RANGES[k];
    out[k] = r ? Math.min(r[1], Math.max(r[0], n)) : n;
  });
  return out;
}

function get() {
  if (cache) return cache;
  cache = normalize(store.get(KEY, {}));
  return cache;
}

/**
 * 改设置。只接受 DEFAULTS 里有的键，其它静默忽略。
 * @returns {{ok:boolean, settings:object, changed:string[]}}
 */
function patch(p) {
  const cur = get();
  const next = Object.assign({}, cur);
  const changed = [];
  Object.keys(p || {}).forEach((k) => {
    if (!(k in DEFAULTS)) return;
    const merged = normalize(Object.assign({}, cur, { [k]: p[k] }));
    if (JSON.stringify(merged[k]) !== JSON.stringify(cur[k])) changed.push(k);
    next[k] = merged[k];
  });
  cache = next;
  store.set(KEY, next, true);
  if (changed.length) {
    log.info('settings', '更新 ' + changed.join(',') + ' → ' +
      changed.map((k) => k + '=' + JSON.stringify(next[k])).join(' '));
  }
  return { ok: true, settings: next, changed };
}

function reset() {
  cache = Object.assign({}, DEFAULTS);
  store.set(KEY, cache, true);
  log.info('settings', '恢复出厂设置');
  return cache;
}

/** 给内核套用当前设置（boot 与每次 patch 后都调） */
function apply(net) {
  const s = get();
  let netMod = net;
  if (!netMod) { try { netMod = require('./net'); } catch (e) { netMod = null; } }
  if (netMod) {
    try { netMod.setConcurrency(s.netConcurrency); } catch (e) {}
    try { netMod.setOffline(s.offline); } catch (e) {}
  }
  return s;
}

function filePath() {
  const paths = require('./paths');
  try { return require('path').join(paths.dirs().state, 'settings.json'); } catch (e) { return STATE_FILE; }
}

module.exports = { DEFAULTS, RANGES, get, patch, reset, apply, filePath, KEY };
