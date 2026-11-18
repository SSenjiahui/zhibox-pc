// 智博X · 内核 · 离线下载调度器
// 队列化 + 并发分片 + 断点续传 + 进度事件 + 暂停/取消 + 下载完自动封装 MP4
'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const vod = require('./vod');
const api = require('./api');
const lib = require('./library');
const net = require('./net');
const auth = require('./auth');
const log = require('./logger');
const paths = require('./paths');

// 并发数改为从 settings 实时读取（用户可在设置面板改，立即生效）
function segConcurrency() {
  try { return Math.max(1, Math.min(8, Number(require('./settings').get().segConcurrency) || 4)); } catch (e) { return 4; }
}
function queueConcurrency() {
  try { return Math.max(1, Math.min(3, Number(require('./settings').get().queueConcurrency) || 2)); } catch (e) { return 2; }
}

class Downloader extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();      // key -> task
    this.queue = [];             // 等待中的 key
    this.running = new Set();    // 正在跑的 key
    this.kernel = null;          // 由 kernel 注入（封装 mp4 用）
  }

  attachKernel(k) { this.kernel = k; }

  /* ---------- 任务创建 ---------- */
  create(arg) {
    const courseId = String(arg.courseId || '0');
    const lessonId = String(arg.lessonId);
    const key = lib.key(courseId, lessonId);
    const exist = this.tasks.get(key);
    if (exist) {
      // 已有记录（多为 rehydrate 还原出来的 paused）→ 直接续传
      if (exist.status === 'paused' || exist.status === 'error' || exist.status === 'canceled') {
        exist.status = 'queued';
        exist.error = '';
        this.enqueue(key);
        this.emitTask(exist);
      } else if (exist.status === 'queued') {
        this.enqueue(key);
      }
      return exist;
    }

    const meta = lib.readMeta(courseId, lessonId) || lib.emptyMeta(courseId, lessonId);
    const t = {
      key, courseId, lessonId,
      lessonName: arg.lessonName || meta.lessonName || ('第 ' + lessonId + ' 课'),
      courseName: arg.courseName || meta.courseName || '',
      streamIndex: arg.streamIndex || 0,
      status: 'queued',        // queued | running | paused | done | error | canceled
      progress: 0,             // 0..1
      done: 0,
      total: meta.segCount || 0,
      bytes: 0,
      speed: 0,
      etaSec: 0,
      error: '',
      startedAt: 0,
      updatedAt: Date.now(),
      abort: null,
      info: null,
      keyBuf: null,
      _speedWin: [],
    };
    this.tasks.set(key, t);
    this.enqueue(key);
    return t;
  }

  enqueue(key) {
    if (this.queue.indexOf(key) < 0 && !this.running.has(key)) this.queue.push(key);
    this.pump();
  }

  pump() {
    while (this.running.size < queueConcurrency() && this.queue.length) {
      const key = this.queue.shift();
      const t = this.tasks.get(key);
      if (!t || t.status === 'canceled') continue;
      this.runOne(t).catch(() => {});
    }
  }

  /* ---------- 单个课时下载 ---------- */
  async runOne(t) {
    this.running.add(t.key);
    t.status = 'running';
    t.startedAt = Date.now();
    t.error = '';
    this.emitTask(t);

    const ac = new AbortController();
    t.abort = ac;

    try {
      const sess = auth.get();
      // 1) 签名
      const sign = await api.biz.sign(t.lessonId, 2);
      if (!sign || sign.code !== 1) throw new Error('获取播放签名失败：' + ((sign && sign.message) || ''));
      // 2) 解析播放信息
      const info = await vod.resolve(sign.data, t.streamIndex, sess);
      t.info = info;
      t.total = info.segments.length;
      const st = info.streams[info.current];
      t.width = st.width;
      t.height = st.height;
      t.duration = info.duration;

      // 3) 解密 key
      t.keyBuf = info.keyUrl ? await vod.fetchKey(info.keyUrl, sess) : null;

      // 4) 写 meta
      const meta = lib.readMeta(t.courseId, t.lessonId) || lib.emptyMeta(t.courseId, t.lessonId);
      meta.lessonName = t.lessonName;
      meta.courseName = t.courseName;
      meta.duration = info.duration;
      meta.segCount = t.total;
      meta.definition = st.definition;
      meta.width = st.width;
      meta.height = st.height;
      meta.status = 'downloading';
      if (!meta.createdAt) meta.createdAt = Date.now();
      lib.writeMeta(t.courseId, t.lessonId, meta);

      // 5) 找出还需要下载的分片
      const todo = [];
      for (let i = 0; i < t.total; i++) {
        const f = lib.segFileOf(t.courseId, t.lessonId, i);
        let ok = false;
        try { ok = fs.statSync(f).size > 0; } catch (e) {}
        if (!ok) todo.push(i);
      }
      t.done = t.total - todo.length;
      t.bytes = 0;
      this.emitTask(t);

      log.info('dl', '开始下载 ' + t.courseId + '/' + t.lessonId + ' 需下载 ' + todo.length + '/' + t.total +
        ' 分片 ' + (st.width + 'x' + st.height) + ' 时长 ' + info.duration.toFixed(1) + 's');

      // 6) 并发下载
      let cursor = 0;
      const t0 = Date.now();
      const worker = async () => {
        while (true) {
          if (ac.signal.aborted) return;
          const myIdx = cursor++;
          if (myIdx >= todo.length) return;
          const i = todo[myIdx];
          const seg = info.segments[i];
          try {
            const buf = await vod.fetchSegment(seg, t.keyBuf, info.iv, sess);
            const file = lib.segFileOf(t.courseId, t.lessonId, i);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file + '.part', buf);
            fs.renameSync(file + '.part', file);
            t.done += 1;
            t.bytes += buf.length;
            const el = (Date.now() - t0) / 1000;
            t.speed = el > 0 ? t.bytes / el : 0;
            t.progress = t.total ? t.done / t.total : 0;
            const left = todo.length - (t.done - (t.total - todo.length));
            t.etaSec = t.speed > 0 ? Math.round((t.bytes / Math.max(1, t.done - (t.total - todo.length))) * left / t.speed) : 0;
            this.emitTask(t);
          } catch (e) {
            log.warn('dl', '分片 ' + i + ' 失败 :: ' + ((e && e.message) || e));
            throw e;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(segConcurrency(), Math.max(1, todo.length)) }, worker));

      if (ac.signal.aborted) throw new Error('已取消');

      // 7) 全部下完 → 封装 MP4（保留总字节数，供 UI 显示体积与速度）
      t.progress = 1;
      t.speed = 0;
      const m2 = lib.readMeta(t.courseId, t.lessonId) || meta;
      m2.bytes = t.bytes;
      m2.status = 'partial';
      m2.downloaded = t.total;
      lib.writeMeta(t.courseId, t.lessonId, m2);
      this.emitTask(t);

      let wantRemux = true;
      try { wantRemux = !!require('./settings').get().autoRemux; } catch (e) {}
      if (wantRemux && this.kernel && this.kernel.remuxLesson) {
        try {
          t.status = 'remuxing';
          this.emitTask(t);
          const r = await this.kernel.remuxLesson(t.courseId, t.lessonId);
          log.info('dl', 'MP4 封装 ' + (r && r.ok ? '成功 ' + (r.bytes / 1048576).toFixed(1) + 'MB' : '失败 ' + (r && r.error)));
        } catch (e) {
          log.warn('dl', 'MP4 封装异常 :: ' + ((e && e.message) || e));
        }
      }

      t.status = 'done';
      t.progress = 1;
      log.info('dl', '完成 ' + t.courseId + '/' + t.lessonId + ' 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      this.emitTask(t);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (ac.signal.aborted) {
        t.status = 'paused';
        log.info('dl', '暂停 ' + t.key);
      } else {
        t.status = 'error';
        t.error = msg;
        log.error('dl', '下载失败 ' + t.key + ' :: ' + msg);
      }
      const meta = lib.readMeta(t.courseId, t.lessonId);
      if (meta) {
        meta.status = t.status === 'paused' ? 'paused' : (t.status === 'error' ? 'error' : meta.status);
        meta.error = t.error;
        lib.writeMeta(t.courseId, t.lessonId, meta);
      }
      this.emitTask(t);
    } finally {
      this.running.delete(t.key);
      t.abort = null;
      this.pump();
    }
  }

  emitTask(t) {
    t.updatedAt = Date.now();
    this.emit('task', this.serialize(t));
  }

  serialize(t) {
    return {
      key: t.key, courseId: t.courseId, lessonId: t.lessonId,
      lessonName: t.lessonName, courseName: t.courseName,
      status: t.status, progress: t.progress, done: t.done, total: t.total,
      bytes: t.bytes, speed: t.speed, etaSec: t.etaSec, error: t.error,
      width: t.width || 0, height: t.height || 0, duration: t.duration || 0,
      startedAt: t.startedAt, updatedAt: t.updatedAt,
    };
  }

  list() {
    return Array.from(this.tasks.values())
      .filter((t) => t.status !== 'canceled')
      .map((t) => this.serialize(t))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(key) {
    const t = this.tasks.get(key);
    return t ? this.serialize(t) : null;
  }

  pause(key) {
    const t = this.tasks.get(key);
    if (!t) return false;
    if (t.abort) t.abort.abort();
    const i = this.queue.indexOf(key);
    if (i >= 0) this.queue.splice(i, 1);
    if (t.status === 'queued') { t.status = 'paused'; this.emitTask(t); }
    return true;
  }

  resume(key) {
    const t = this.tasks.get(key);
    if (!t) return false;
    if (t.status === 'paused' || t.status === 'error') {
      t.status = 'queued';
      t.error = '';
      this.enqueue(key);
      this.emitTask(t);
    }
    return true;
  }

  cancel(key, removeFiles) {
    const t = this.tasks.get(key);
    if (!t) return false;
    if (t.abort) t.abort.abort();
    const i = this.queue.indexOf(key);
    if (i >= 0) this.queue.splice(i, 1);
    t.status = 'canceled';
    this.tasks.delete(key);
    this.emitTask(t);
    if (removeFiles) {
      lib.removeLesson(t.courseId, t.lessonId, false);
    }
    return true;
  }

  /** 启动时：把上次中断的（status=downloading）任务标为已暂停，等用户手动继续 */
  rehydrate() {
    const all = lib.scan();
    for (const m of all) {
      if (m.status === 'partial' || m.status === 'paused') {
        const key = lib.key(m.courseId, m.lessonId);
        if (this.tasks.has(key)) continue;
        this.tasks.set(key, {
          key, courseId: m.courseId, lessonId: m.lessonId,
          lessonName: m.lessonName, courseName: m.courseName,
          streamIndex: 0, status: 'paused', progress: m.segCount ? m.downloaded / m.segCount : 0,
          done: m.downloaded, total: m.segCount, bytes: 0, speed: 0, etaSec: 0,
          error: '', startedAt: 0, updatedAt: m.updatedAt, abort: null,
          width: m.width, height: m.height, duration: m.duration,
        });
      }
    }
    log.info('dl', '还原 ' + this.tasks.size + ' 个离线任务记录');
  }
}

module.exports = new Downloader();