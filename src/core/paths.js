// 智博X · 内核 · 路径解析
// 所有内核模块都从这里取目录，保证「便携版」在任何盘符都能跑。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let DATA_ROOT = '';
let DIRS = null;

function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '.w_' + process.pid + '_' + Date.now());
    fs.writeFileSync(p, 'x', 'utf8');
    fs.unlinkSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function candidates() {
  const out = [];
  const push = (d) => { if (d && out.indexOf(d) < 0) out.push(d); };
  if (process.env.ZB_DATA_DIR) push(process.env.ZB_DATA_DIR);
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'ZhiboX'));
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'ZhiboX'));
  try { push(path.join(path.dirname(process.execPath), 'data')); } catch (e) {}
  try { push(path.join(process.cwd(), 'ZhiboXData')); } catch (e) {}
  try { push(path.join(os.tmpdir(), 'ZhiboX')); } catch (e) {}
  try {
    const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (let i = 0; i < letters.length; i++) {
      const root = letters[i] + ':\\';
      try { if (fs.existsSync(root)) push(path.join(root, 'ZhiboXData')); } catch (e) {}
    }
  } catch (e) {}
  return out;
}

/** 真实写探测出一个可写根目录；全失败返回 ''（此时内核退化为纯内存态） */
function pickDataRoot(onSkip) {
  if (DATA_ROOT) return DATA_ROOT;
  const list = candidates();
  for (let i = 0; i < list.length; i++) {
    if (probeWritable(list[i])) {
      DATA_ROOT = list[i];
      return DATA_ROOT;
    }
    if (typeof onSkip === 'function') onSkip(list[i]);
  }
  DATA_ROOT = '';
  return '';
}

function setDataRoot(d) {
  DATA_ROOT = d || '';
  DIRS = null;
}

/** 内核目录布局：<DATA_ROOT>/{logs,state,library,cache,tmp} */
function dirs() {
  if (DIRS) return DIRS;
  const root = DATA_ROOT || path.join(os.tmpdir(), 'ZhiboX-mem');
  DIRS = {
    root: root,
    logs: path.join(root, 'logs'),
    state: path.join(root, 'state'),
    library: path.join(root, 'library'),
    cache: path.join(root, 'cache'),
    tmp: path.join(root, 'tmp'),
  };
  Object.keys(DIRS).forEach((k) => {
    if (k === 'root') return;
    try { fs.mkdirSync(DIRS[k], { recursive: true }); } catch (e) {}
  });
  return DIRS;
}

function dataRoot() {
  return DATA_ROOT;
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  return p;
}

/** 课时缓存目录：<library>/<courseId>/<lessonId>/ */
function lessonDir(courseId, lessonId) {
  return path.join(dirs().library, String(courseId || '0'), String(lessonId));
}

/** 课时目录下的子路径 */
function lessonPath(courseId, lessonId, name) {
  return path.join(lessonDir(courseId, lessonId), name);
}

module.exports = {
  pickDataRoot, setDataRoot, dataRoot, dirs, ensureDir,
  probeWritable, lessonDir, lessonPath,
};
