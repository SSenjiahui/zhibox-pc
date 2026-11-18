// 智博X · 内核 · 总装
// 把 paths/logger/store/auth/api/vod/library/hls-server/downloader/ts2mp4 拧成一台可独立运行的引擎。
'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const paths = require('./paths');
const log = require('./logger');
const store = require('./store');
const auth = require('./auth');
const api = require('./api');
const vod = require('./vod');
const library = require('./library');
const hlsServer = require('./hls-server');
const downloader = require('./downloader');
const settings = require('./settings');

const PROGRESS_KEY = 'progress';
const REMUX_KEY = 'remuxed';

class Kernel extends EventEmitter {
  constructor() {
    super();
    this.ready = false;
    this.dataRoot = '';
    this.ts2mp4 = null;
    this.remuxQueue = [];
    this.remuxRunning = false;
  }

  /* ---------------- 启动 ---------------- */
  async boot(opts) {
    const o = opts || {};
    this.version = o.version || '1.5.0';
    this.electron = o.electron || '';
    
    // 1) 数据根
    const root = paths.pickDataRoot((bad) => {
      // 这里还没有 logger，先攒着
      (this._skipped || (this._skipped = [])).push(bad);
    });
    this.dataRoot = root;
    if (!root) {
      // 全盘不可写 → 退到内存态，仍然要能跑
      paths.setDataRoot(path.join(require('os').tmpdir(), 'ZhiboX-mem-' + Date.now()));
    }

    // 2) 日志
    log.init(paths.dataRoot());
    (this._skipped || []).forEach((b) => log.warn('kernel', '跳过不可写目录 ' + b));
    log.info('kernel', '==== 智博X 内核启动 ====');
    log.info('kernel', '数据根 = ' + paths.dataRoot());
    log.info('kernel', '内核版本 = ' + (o.version || '1.5.0') + ' Electron=' + (o.electron || '?'));

    // 3) 存储 + 设置（设置必须在下载器与网络开工前套用）
    store.init(paths.dirs().state);
    const st0 = settings.apply();
    log.info('kernel', '设置已套用 · 并发 ' + st0.netConcurrency + '/' + st0.queueConcurrency + '/' +
      st0.segConcurrency + ' · 自动封装 ' + (st0.autoRemux ? '开' : '关') +
      ' · 离线模式 ' + (st0.offline ? '开' : '关') +
      ' · 缓存上限 ' + (st0.cacheLimitMB ? st0.cacheLimitMB + 'MB' : '不限'));

    // 4) MP4 重封装模块（可选，失败不影响基础播放）
    try {
      this.ts2mp4 = require('./ts2mp4');
      log.info('kernel', 'MP4 重封装内核已加载');
    } catch (e) {
      this.ts2mp4 = null;
      log.warn('kernel', 'MP4 重封装内核未就绪 :: ' + ((e && e.message) || e));
    }

    // 5) 本地流服务
    try {
      this.hlsBase = await hlsServer.start(0);
    } catch (e) {
      log.error('kernel', '本地流服务启动失败 :: ' + ((e && e.message) || e));
    }

    // 6) 下载器接管
    downloader.attachKernel(this);
    downloader.on('task', (t) => this.emit('download', t));
    downloader.rehydrate();

    // 6.5) 启动即做一次缓存治理（不阻塞窗口）
    setImmediate(() => {
      try { library.enforceLimit(settings.get().cacheLimitMB, []); } catch (e) {}
    });

    // 7) 认证自愈（后台跑，不阻塞窗口）
    // 登录失效广播：任何一次 API 返回「未登录 / token 失效」都立刻通知界面回登录页。
    // v1.7 不内置任何人的票据，登录态完全属于用户：失效就该当场告诉他，而不是让
    // 播放、下载、课程列表一起报同一句话。
    try {
      api.setAuthExpiredHandler((pathname) => {
        const now = Date.now();
        if (this._authDeadAt && now - this._authDeadAt < 8000) return; // 8s 去抖，避免一屏错误刷屏
        /* 刚登录成功后的 20 秒内不广播失效：
         * 登录那一刻会并发发出课程/横幅/我的课程等多个请求，服务端偶发一张过期缓存
         * 就会 code=0。若此时广播，用户会被「刚登进去」直接踹回登录页。
         * 这一窗口只吞广播，不吞日志 —— 真失效下一次请求照样会广播。 */
        try {
          const okAt = auth.lastOkAt && auth.lastOkAt();
          if (okAt && now - okAt < 20000) {
            log.warn('kernel', '忽略一次登录失效广播（登录成功 ' + Math.round((now - okAt) / 1000) + 's 内）:: ' + pathname);
            return;
          }
        } catch (e) {}
        this._authDeadAt = now;
        log.warn('kernel', '服务端判定登录失效（' + pathname + '），等用户重新登录');
        this.emit('auth-expired', { pathname: pathname, at: now });
      });
    } catch (e) {}

    this.ready = true;
    this.emit('ready');
    log.info('kernel', '内核就绪');
    this.autoAuth().catch(() => {});
    return { ok: true, dataRoot: paths.dataRoot(), logs: log.dirPath(), hlsBase: this.hlsBase };
  }

  async autoAuth() {
    const r = await auth.autoLogin();
    this.emit('auth', r);
    return r;
  }

  /* ---------------- 播放 ---------------- */
  /**
   * 打开一节课。三条通路，按「最独立」优先：
   *   1) file     —— 离线库里已有封装好的 full.mp4，直接 zbfile:// 本地文件，完全不碰网络
   *   2) stream   —— 联网：走自研 fMP4 流（MSE 直吃），边播边缓存；内嵌 HLS 兜底
   *   3) local    —— 断网 / 只下了一部分：只用离线库里的明文分片现场封装，照样能播
   * @param {{courseId,lessonId,lessonName?,courseName?,streamIndex?,forceLocal?}} arg
   */
  async openLesson(arg) {
    const courseId = String(arg.courseId || '0');
    const lessonId = String(arg.lessonId);

    // 1) 已有完整 mp4 → 直接本地文件播放（真正离线）
    //    preferSegs 时跳过这一步，强制走「分片 → 自研 fMP4 内核」通路
    const mp4 = library.mp4Of(courseId, lessonId);
    if (!arg.preferSegs && fs.existsSync(mp4)) {
      let size = 0;
      try { size = fs.statSync(mp4).size; } catch (e) {}
      if (size > 1024) {
        const m = library.readMeta(courseId, lessonId) || {};
        log.info('kernel', '离线播放（本地 MP4）' + mp4 + ' ' + (size / 1048576).toFixed(1) + 'MB');
        return {
          ok: true, mode: 'file', url: 'zbfile://' + Buffer.from(mp4, 'utf8').toString('hex'), path: mp4,
          name: arg.lessonName || m.lessonName || '',
          duration: Number(m.duration) || 0,
          width: m.width || 0, height: m.height || 0, bytes: size,
          streams: [], current: 0,
          progress: this.getProgress(courseId, lessonId),
          offline: true,
        };
      }
    }

    // 2) 强制离线：只用本地分片（UI 的「离线播放」按钮走这条）
    if (arg.forceLocal || arg.preferSegs) {
      return this._openLocal({ courseId, lessonId, arg });
    }

    // 3) 联网：远端 HLS（顺带缓存到离线库），并给出自研 fMP4 引擎地址
    try {
      const sign = await api.biz.sign(lessonId, 2);
      if (!sign || sign.code !== 1) throw new Error((sign && sign.message) || '获取播放签名失败');
      const s = await hlsServer.open({
        signature: sign.data,
        streamIndex: arg.streamIndex || 0,
        courseId, lessonId,
        lessonName: arg.lessonName, courseName: arg.courseName,
      });
      const prog = this.getProgress(courseId, lessonId);
      return Object.assign({ ok: true, mode: 'stream', offline: false, progress: prog }, s);
    } catch (e) {
      log.error('kernel', '打开课时失败 ' + lessonId + ' :: ' + ((e && e.message) || e));
      // 4) 联网失败 → 还能用本地分片播就播
      const local = await this._openLocal({ courseId, lessonId, arg, reason: String((e && e.message) || e) });
      if (local.ok) return local;
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** 用离线库里的明文分片开一个纯本地会话（可断网） */
  async _openLocal(opt) {
    const courseId = opt.courseId;
    const lessonId = opt.lessonId;
    const arg = opt.arg || {};
    const parts = library.contiguousDone(courseId, lessonId, 9999);
    if (!parts) {
      return { ok: false, error: opt.reason || '本地没有可播放的缓存' };
    }
    if (!hlsServer.hasFmp4()) {
      return { ok: false, error: 'fMP4 内核未就绪，无法本地播放', segs: parts };
    }
    try {
      const s = await hlsServer.openLocal({
        courseId, lessonId,
        lessonName: arg.lessonName, courseName: arg.courseName,
      });
      log.info('kernel', '本地分片播放 ' + courseId + '/' + lessonId + ' 连续分片=' + parts);
      const prog = this.getProgress(courseId, lessonId);
      return Object.assign({ ok: true, mode: 'local', offline: true, progress: prog, segs: parts }, s);
    } catch (e) {
      log.warn('kernel', '本地分片播放失败 ' + lessonId + ' :: ' + ((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e), segs: parts };
    }
  }

  closeLesson(sid) { hlsServer.close(sid); }

  /* ---------------- 进度 ---------------- */
  getProgress(courseId, lessonId) {
    const all = store.get(PROGRESS_KEY, {});
    return all[courseId + ':' + lessonId] || null;
  }

  saveProgress(courseId, lessonId, pos, duration, extra) {
    const key = courseId + ':' + lessonId;
    const all = store.get(PROGRESS_KEY, {});
    const prev = all[key] || {};
    all[key] = Object.assign({}, prev, {
      courseId, lessonId, pos: Math.max(0, Number(pos) || 0),
      duration: Number(duration) || 0,
      percent: duration > 0 ? Math.min(1, (Number(pos) || 0) / duration) : 0,
      watchedAt: Date.now(),
      finished: duration > 0 && Number(pos) / duration > 0.95 ? true : !!(prev.finished),
    }, extra || {});
    store.set(PROGRESS_KEY, all);
    return all[key];
  }

  allProgress() { return store.get(PROGRESS_KEY, {}); }

  /** 某课程的整体进度（用于「我的课程」角标） */
  courseProgress(courseId, lessonIds) {
    const all = store.get(PROGRESS_KEY, {});
    let watched = 0, finished = 0;
    (lessonIds || []).forEach((id) => {
      const p = all[courseId + ':' + id];
      if (!p) return;
      if (p.finished) { finished++; watched++; }
      else if (p.pos > 5) watched++;
    });
    return { watched, finished, total: (lessonIds || []).length };
  }

  /* ---------------- 离线库 ---------------- */
  libraryScan() { return library.scan(); }
  libraryUsage() { return library.usage(); }
  libraryRemove(courseId, lessonId, hard) { return library.removeLesson(courseId, lessonId, hard); }

  /* ---------------- 下载 ---------------- */
  startDownload(arg) { return downloader.serialize(downloader.create(arg)); }
  pauseDownload(key) { return downloader.pause(key); }
  resumeDownload(key) { return downloader.resume(key); }
  cancelDownload(key, rm) { return downloader.cancel(key, rm); }
  downloadList() { return downloader.list(); }

  /* ---------------- MP4 重封装 ---------------- */
  /** 把某节课的离线分片封装成单个 mp4 */
  async remuxLesson(courseId, lessonId, force) {
    if (!this.ts2mp4) return { ok: false, error: 'ts2mp4 内核未加载' };
    const out = library.mp4Of(courseId, lessonId);
    if (!force && fs.existsSync(out)) {
      try { if (fs.statSync(out).size > 1024) return { ok: true, skipped: true, path: out }; } catch (e) {}
    }
    const meta = library.readMeta(courseId, lessonId);
    if (!meta || !meta.segCount) return { ok: false, error: '没有可封装的离线数据' };

    const files = [];
    for (let i = 0; i < meta.segCount; i++) {
      const f = library.segFileOf(courseId, lessonId, i);
      try { if (fs.statSync(f).size > 0) files.push(f); } catch (e) { log.warn('kernel', '缺分片 ' + i); }
    }
    if (!files.length) return { ok: false, error: '分片全部缺失' };

    const t0 = Date.now();
    log.info('kernel', '开始封装 MP4 ' + courseId + '/' + lessonId + ' 分片=' + files.length);
    const r = await this.ts2mp4.remuxFiles(files, out, (p) => {
      if (p && p.total) this.emit('remux', { courseId, lessonId, phase: p.phase, done: p.done, total: p.total });
    });
    if (r && r.ok) {
      const m = library.readMeta(courseId, lessonId) || meta;
      m.hasMp4 = true;
      m.mp4Bytes = r.bytes;
      m.status = 'ready';
      m.width = r.video && r.video.width || m.width;
      m.height = r.video && r.video.height || m.height;
      m.duration = r.durationSec || m.duration;
      library.writeMeta(courseId, lessonId, m);
      log.info('kernel', 'MP4 封装成功 ' + (r.bytes / 1048576).toFixed(1) + 'MB ' + r.durationSec.toFixed(1) + 's 耗时 ' + (Date.now() - t0) + 'ms');
    } else {
      log.error('kernel', 'MP4 封装失败 :: ' + (r && r.error));
    }
    return r;
  }

  /* ---------------- 设置 ---------------- */
  getSettings() { return settings.get(); }
  settingsFile() { return settings.filePath(); }

  /**
   * 改设置并立即套用（网络并发 / 离线开关 / 下载并发都在这里生效）。
   * @returns {{ok, settings, changed}}
   */
  patchSettings(p) {
    const r = settings.patch(p || {});
    if (r.changed.length) {
      settings.apply();
      const s = r.settings;
      if (r.changed.indexOf('cacheLimitMB') >= 0) {
        try { library.enforceLimit(s.cacheLimitMB, this._protectKeys()); } catch (e) {}
      }
      if (r.changed.indexOf('offline') >= 0) {
        this.emit('settings', s);
      }
      this.emit('settings', s);
    }
    return r;
  }

  resetSettings() {
    const s = settings.reset();
    settings.apply();
    this.emit('settings', s);
    return { ok: true, settings: s };
  }

  _protectKeys() {
    try { return downloader.list().filter((t) => t.status === 'running' || t.status === 'queued').map((t) => t.key); } catch (e) { return []; }
  }

  /* 缓存治理（手动触发 / 定时触发都走这里） */
  cacheEnforce() {
    const s = settings.get();
    return library.enforceLimit(s.cacheLimitMB, this._protectKeys());
  }
  cacheEmptyTrash() { return library.emptyTrash(); }

  /* ---------------- 诊断 ---------------- */
  status() {
    return {
      ready: this.ready,
      dataRoot: paths.dataRoot(),
      dirs: paths.dirs(),
      logs: log.dirPath(),
      hlsBase: this.hlsBase,
      net: require('./net').stats(),
      downloads: downloader.list(),
      library: library.usage(),
      remux: !!this.ts2mp4,
      fmp4: hlsServer.hasFmp4(),
      version: this.version || '',
      electron: this.electron || process.versions.electron || '',
      session: (() => { const s = auth.get(); return { hasToken: !!s.authToken, profile: s.profile }; })(),
      settings: settings.get(),
      settingsFile: settings.filePath(),
      offline: (() => { try { return require('./net').isOffline(); } catch (e) { return false; } })(),
      trash: (() => { try { return { dir: library.trashDir(), bytes: library.dirBytes(library.trashDir()) }; } catch (e) { return null; } })(),
    };
  }
}

module.exports = new Kernel();