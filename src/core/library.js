// 智博X · 内核 · 离线库
// 每节课一个目录：meta.json + seg/NNN.ts + full.mp4
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const store = require('./store');
const log = require('./logger');

const META = 'meta.json';
const SEG_DIR = 'seg';
const FULL_MP4 = 'full.mp4';

function key(courseId, lessonId) { return String(courseId || '0') + ':' + String(lessonId); }

function dirOf(courseId, lessonId) { return paths.lessonDir(courseId, lessonId); }
function segDirOf(courseId, lessonId) { return path.join(dirOf(courseId, lessonId), SEG_DIR); }
function segFileOf(courseId, lessonId, i) {
  return path.join(segDirOf(courseId, lessonId), String(i).padStart(3, '0') + '.ts');
}
function mp4Of(courseId, lessonId) { return path.join(dirOf(courseId, lessonId), FULL_MP4); }

function emptyMeta(courseId, lessonId) {
  return {
    courseId: String(courseId || ''),
    lessonId: String(lessonId || ''),
    lessonName: '',
    courseName: '',
    duration: 0,
    segCount: 0,
    downloaded: 0,
    status: 'idle',       // idle | downloading | partial | ready | error | paused
    definition: 0,
    width: 0,
    height: 0,
    bytes: 0,
    mp4Bytes: 0,
    hasMp4: false,
    error: '',
    createdAt: 0,
    updatedAt: 0,
    segs: [],             // [{i, done, bytes, duration}]
  };
}

function readMeta(courseId, lessonId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dirOf(courseId, lessonId), META), 'utf8'));
    return Object.assign(emptyMeta(courseId, lessonId), j);
  } catch (e) {
    return null;
  }
}

function writeMeta(courseId, lessonId, meta) {
  const m = Object.assign({}, meta, { updatedAt: Date.now() });
  try {
    paths.ensureDir(dirOf(courseId, lessonId));
    const tmp = path.join(dirOf(courseId, lessonId), META + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(dirOf(courseId, lessonId), META));
  } catch (e) {
    log.warn('lib', '写 meta 失败 ' + key(courseId, lessonId) + ' :: ' + ((e && e.message) || e));
  }
  return m;
}

/** 全库扫描（启动时刷新索引） */
function scan() {
  const root = paths.dirs().library;
  const out = [];
  let courses = [];
  try { courses = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (e) { return out; }
  for (const c of courses) {
    let lessons = [];
    try { lessons = fs.readdirSync(path.join(root, c.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (e) { continue; }
    for (const l of lessons) {
      const m = readMeta(c.name, l.name);
      if (!m) continue;
      // 真实文件校验：标记实际已下载分片
      let real = 0;
      try {
        const files = fs.readdirSync(segDirOf(c.name, l.name));
        real = files.filter((f) => f.endsWith('.ts')).length;
      } catch (e) {}
      m.downloaded = real;
      m.hasMp4 = fs.existsSync(mp4Of(c.name, l.name));
      if (m.hasMp4) {
        try { m.mp4Bytes = fs.statSync(mp4Of(c.name, l.name)).size; } catch (e) {}
      }
      if (m.status === 'downloading') m.status = 'paused';
      if (m.segCount > 0 && real >= m.segCount && !m.hasMp4) m.status = 'partial';
      else if (m.hasMp4) m.status = 'ready';
      else if (real > 0) m.status = 'partial';
      out.push(m);
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  log.info('lib', '离线库扫描：' + out.length + ' 节课（' + out.filter((x) => x.hasMp4).length + ' 已完整缓存）');
  return out;
}

/** 已完整下载的连续分片数（从 0 开始，用于流式播放起点） */
function contiguousDone(courseId, lessonId, segCount) {
  let n = 0;
  for (let i = 0; i < segCount; i++) {
    try { fs.accessSync(segFileOf(courseId, lessonId, i)); n++; } catch (e) { break; }
  }
  return n;
}

/** 统计目录占用 */
function usage() {
  let bytes = 0;
  let lessons = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/^\d+$/.test(e.name)) lessons++; walk(p); }
      else { try { bytes += fs.statSync(p).size; } catch (x) {} }
    }
  };
  walk(paths.dirs().library);
  return { bytes, lessons, dir: paths.dirs().library };
}

/** 归档删除一节课的缓存（移进 trash，不物理删除，遵守可回退原则） */
function removeLesson(courseId, lessonId, hard) {
  const d = dirOf(courseId, lessonId);
  if (!fs.existsSync(d)) return { ok: true, removed: false };
  if (hard) {
    fs.rmSync(d, { recursive: true, force: true });
    log.info('lib', '硬删除 ' + d);
    return { ok: true, removed: true, hard: true };
  }
  const trash = path.join(paths.dirs().cache, 'trash', key(courseId, lessonId).replace(/:/g, '_') + '-' + Date.now());
  try {
    paths.ensureDir(path.dirname(trash));
    fs.renameSync(d, trash);
    log.info('lib', '归档到 ' + trash);
    return { ok: true, removed: true, trash };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 缓存上限治理 ----------------
 * 达到上限时不硬删：先把最久未访问的课时移进回收目录（可回退），
 * 回收目录里的东西超过保留天数才真正清理。这样「独立」不会因为
 * 磁盘被撑满而崩掉，也不会让用户丢数据。 */
function dirBytes(d) {
  let n = 0;
  const walk = (p) => {
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else { try { n += fs.statSync(q).size; } catch (x) {} }
    }
  };
  walk(d);
  return n;
}

function trashDir() { return path.join(paths.dirs().cache, 'trash'); }

/**
 * 把离线库压到 limitMB 以内。
 * @param {number} limitMB 0 = 不限
 * @param {string[]} protect 不能动的 key（正在下载 / 正在播放）
 */
function enforceLimit(limitMB, protect) {
  const limit = Number(limitMB) || 0;
  if (limit <= 0) return { ok: true, skipped: true, reason: '未设置上限' };
  const cap = limit * 1048576;
  const keep = new Set((protect || []).map(String));
  const rows = scan().filter((m) => !keep.has(key(m.courseId, m.lessonId)));
  let total = usage().bytes;
  if (total <= cap) return { ok: true, bytes: total, cap, archived: 0 };

  // 旧的先走；ready 的课时排在同 timestamp 时优先让位（mp4 可以再封装）
  rows.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  const archived = [];
  for (const m of rows) {
    if (total <= cap) break;
    const sz = dirBytes(dirOf(m.courseId, m.lessonId));
    const r = removeLesson(m.courseId, m.lessonId, false);
    if (r && r.removed) {
      total -= sz;
      archived.push({ courseId: m.courseId, lessonId: m.lessonId, bytes: sz, trash: r.trash });
      log.info('lib', '缓存超限，归档 ' + key(m.courseId, m.lessonId) + ' ' + (sz / 1048576).toFixed(1) + 'MB → ' + path.basename(r.trash || ''));
    }
  }

  // 归档目录自己也占空间：超过保留天数 + 仍然超限时真删最旧的那批
  const purged = purgeTrash(7, total > cap ? cap : 0);
  total = usage().bytes;
  log.info('lib', '缓存治理完成 · 现占用 ' + (total / 1048576).toFixed(1) + 'MB / 上限 ' + limit + 'MB · 归档 ' + archived.length + ' · 清理回收 ' + purged);
  return { ok: true, bytes: total, cap, archived: archived.length, purged, rows: archived };
}

/** 清理回收目录：先按 days 过期，若 stillOver>0 再按最旧继续删 */
function purgeTrash(days, stillOver) {
  const dir = trashDir();
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (e) { return 0; }
  const now = Date.now();
  const rows = ents.map((d) => {
    const p = path.join(dir, d.name);
    let sz = 0, mt = now;
    try { sz = dirBytes(p); mt = fs.statSync(p).mtimeMs; } catch (e) {}
    return { p, sz, mt };
  }).sort((a, b) => a.mt - b.mt);

  let freed = 0;
  let left = stillOver || 0;
  for (const r of rows) {
    const expired = days > 0 && (now - r.mt) > days * 86400000;
    if (!expired && left <= 0) continue;
    try { fs.rmSync(r.p, { recursive: true, force: true }); freed++; if (left > 0) left -= r.sz; } catch (e) {}
  }
  return freed;
}

/** 清空回收目录（用户在设置里手动点） */
function emptyTrash() {
  const n = purgeTrash(0, 1);
  log.info('lib', '清空回收目录 ' + n + ' 项');
  return { ok: true, removed: n };
}

module.exports = {
  META, SEG_DIR, FULL_MP4, key, dirOf, segDirOf, segFileOf, mp4Of,
  emptyMeta, readMeta, writeMeta, scan, contiguousDone, usage, removeLesson,
  dirBytes, trashDir, enforceLimit, purgeTrash, emptyTrash,
};
