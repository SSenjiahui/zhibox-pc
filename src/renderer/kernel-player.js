/*!
 * kernel-player.js —— 零依赖 MSE（MediaSource）播放内核（fMP4 分片版）
 * ---------------------------------------------------------------------------
 * 场景：Electron 31 / Chromium 126 渲染进程（contextIsolation:true，无 node 集成）。
 * 主进程把加密 TS 转成 fMP4 后由本机 http 服务提供：
 *   GET {base}/init.mp4     -> ftyp+moov
 *   GET {base}/meta.json    -> { codec, segCount, duration, segDurs, width, height }
 *   GET {base}/seg/N.m4s    -> moof+mdat（服务端保证 tfdt 严格单调、无重叠）
 *
 * 设计要点：
 *   1. 时间轴：segDurs 累加成 starts[]，二分定位 seek 目标段。
 *   2. 串行 append 队列：同一时刻只有一个 appendBuffer 在途，靠 updateend 推进。
 *   3. 缓冲水位：>= currentTime+20s 停拉，<= currentTime+8s 恢复（滞回）。
 *   4. 缓冲回收：buffered.start(0) 落后 currentTime 超过 40s 就 remove(keep=30s)。
 *   5. QuotaExceededError：收缩到 currentTime-5 后重试，最多 3 次。
 *   6. 单段 fetch 失败重试 2 次（400ms / 900ms），仍失败 -> onEvent('error') 并停在缓冲态。
 *   7. destroy() 必须可重入且立刻可再次 create（abort fetch / 清队列 / 清定时器 / revoke URL）。
 *
 * 用法：
 *   if (!KernelPlayer.isSupported(codec)) { // 回退 hls.js 或 file 模式 }
 *   var p = KernelPlayer.create(videoEl, { base: 'http://127.0.0.1:PORT/x', meta: m, onEvent: fn });
 *   p.ready.then(function (info) { ... });
 * ---------------------------------------------------------------------------
 */
(function (window) {
  'use strict';

  var VERSION = '1.0.0';

  /* ========================= 0. 常量 ========================= */
  var HIGH_WATER = 20;        // 已缓冲到 currentTime+20s -> 暂停拉取
  var LOW_WATER = 8;          // 低于 currentTime+8s -> 恢复拉取
  var RECYCLE_GAP = 40;       // buffered.start(0) 落后 currentTime 超过 40s -> 回收
  var KEEP_BEHIND = 30;       // 回收时保留 currentTime 之前 30s
  var QUOTA_SAFE_BACK = 5;    // 配额溢出时收缩到 currentTime-5
  var QUOTA_MAX_RETRY = 3;    // 配额重试上限
  var RETRY_DELAYS = [400, 900]; // 单段 fetch 重试间隔（共 3 次尝试）
  var IDLE_TICK = 250;        // 空闲心跳
  var BUSY_TICK = 60;         // 忙碌重排
  var SB_IDLE_TIMEOUT = 8000; // 等 SourceBuffer 静默的上限
  var DURATION_WAIT = 800;    // 等 durationchange 的兜底上限

  /* ========================= 1. 宿主对象 ========================= */
  var _setTimeout = window.setTimeout ? window.setTimeout.bind(window) : null;
  var _clearTimeout = window.clearTimeout ? window.clearTimeout.bind(window) : null;
  var _fetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  var _MediaSource = window.MediaSource || null;
  var _URL = window.URL || null;
  var _AbortController = window.AbortController || null;

  /* ========================= 2. 小工具 ========================= */
  function makeError(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      }
    }
    return e;
  }

  // 是否是「我们自己主动取消了」的错误
  function isAbort(e) {
    if (!e) return false;
    return e.name === 'AbortError' || e.code === 'aborted' || e.code === 'abort';
  }

  // 是否是配额溢出（Chromium 里 appendBuffer 同步抛 QuotaExceededError，也可能走 error 事件）
  function isQuotaError(e) {
    if (!e) return false;
    if (e.name === 'QuotaExceededError') return true;
    if (e.code === 22 || e.code === 1014) return true;
    return /quota\s*exceeded/i.test(String(e.name || '') + ' ' + String(e.message || ''));
  }

  // MediaSource/SourceBuffer 在 ended/closed 之后抛的状态错误
  function isInvalidState(e) {
    if (!e) return false;
    if (e.name === 'InvalidStateError') return true;
    return /invalid\s*state/i.test(String(e.name || '') + ' ' + String(e.message || ''));
  }

  function mimeOf(codec) {
    return 'video/mp4; codecs="' + codec + '"';
  }

  /* ========================= 3. 能力探测 ========================= */
  function isSupported(codec) {
    if (!_MediaSource || typeof _MediaSource.isTypeSupported !== 'function') return false;
    if (!codec || typeof codec !== 'string') return false;
    try {
      return !!_MediaSource.isTypeSupported(mimeOf(codec));
    } catch (e) {
      return false;
    }
  }

  /* ========================= 4. 播放器实例 ========================= */
  function create(videoEl, opts) {
    opts = opts || {};
    if (!videoEl || typeof videoEl.addEventListener !== 'function') return null;

    // 硬性要求 11：能从 meta 里提前判定编解码不支持 -> 直接返回 null（调用方回退）
    var presetMeta = opts.meta || null;
    if (presetMeta && presetMeta.codec && !isSupported(presetMeta.codec)) return null;
    if (!_MediaSource || !_URL || typeof _URL.createObjectURL !== 'function') return null;

    /* ---------- 4.1 实例状态 ---------- */
    var base = String(opts.base || '').replace(/\/+$/, '');
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    var startTime = Math.max(0, Number(opts.startTime) || 0);
    var autoplay = opts.autoplay !== false;

    var meta = presetMeta;
    var starts = [];          // starts[i] = 第 i 段的起始秒
    var segCount = 0;
    var duration = 0;

    var state = 'buffering';
    var destroyed = false;
    var gen = 0;              // 代际：seek / destroy 时自增，用来让在途的异步流程失效

    var ms = null;
    var sb = null;
    var objectUrl = null;
    var mime = '';
    var initBufCache = null;  // 缓存 init 段，重建 MediaSource 时要重新 append 一次

    var nextSeg = 0;          // 下一个要 append 的段号
    var pendingSeek = null;   // 待落地的 seek 目标秒数
    var fetchPaused = false;  // 水位滞回：true = 暂停拉取
    var pausedByError = false;// 段错误后停住，等用户 seek 或重试
    var fetching = false;     // 是否已有段在网络上
    var inflight = null;      // 当前 AbortController

    var sbTasks = [];         // append / remove 串行队列
    var sbActive = null;      // 在途任务
    var pendingRemove = false;// 是否有 remove 在途（remove 完成才清）
    var idleWaiters = [];     // 等 SourceBuffer 静默的等待者

    var timers = [];          // 本实例创建的定时器（destroy 时全部清掉）
    var sleepers = [];        // sleep 的唤醒器（destroy 时全部叫醒，避免悬挂 Promise）
    var tickScheduled = false;
    var pumping = false;
    var msReady = false;
    var endDone = false;

    var stats = { fetches: 0, retries: 0, appended: 0, removals: 0, quota: 0, resets: 0, staleSb: 0 };

    /* ---------- 4.2 定时器托管 ---------- */
    function later(fn, ms2) {
      if (destroyed || !_setTimeout) return null;
      var id = _setTimeout(function () {
        var i = timers.indexOf(id);
        if (i >= 0) timers.splice(i, 1);
        if (destroyed) return;
        try { fn(); } catch (e) { /* 定时器回调不应污染主流程 */ }
      }, ms2 || 0);
      timers.push(id);
      return id;
    }

    function sleep(ms2) {
      return new Promise(function (resolve) {
        var woken = false;
        var wake = function () {
          if (woken) return;
          woken = true;
          var i = sleepers.indexOf(wake);
          if (i >= 0) sleepers.splice(i, 1);
          resolve();
        };
        sleepers.push(wake);
        later(wake, ms2);
      });
    }

    function clearAllTimers() {
      for (var i = 0; i < timers.length; i++) {
        try { _clearTimeout(timers[i]); } catch (e) {}
      }
      timers.length = 0;
      tickScheduled = false;
    }

    function wakeSleepers() {
      var list = sleepers.slice();
      sleepers.length = 0;
      for (var i = 0; i < list.length; i++) {
        try { list[i](); } catch (e) {}
      }
    }

    /* ---------- 4.3 事件 ---------- */
    function emit(name, data) {
      if (!onEvent) return;
      try { onEvent(name, data || {}); } catch (e) { /* 回调异常不能打断内核 */ }
    }

    function setState(s) {
      state = s;
    }

    /* ---------- 4.4 时间轴 ---------- */
    function buildTimeline() {
      var durs = meta.segDurs;
      segCount = Number(meta.segCount) || (durs ? durs.length : 0);
      starts = new Array(segCount);
      var acc = 0;
      for (var i = 0; i < segCount; i++) {
        starts[i] = acc;
        var d = durs && i < durs.length ? Number(durs[i]) : 0;
        acc += isFinite(d) && d > 0 ? d : 0;
      }
      var md = Number(meta.duration);
      duration = isFinite(md) && md > 0 ? md : acc;
    }

    // 二分：返回覆盖 t 的段号
    function segIndexAt(t) {
      if (!segCount) return 0;
      var lo = 0, hi = segCount - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= t) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    function segEnd(i) {
      if (meta && meta.segDurs && i < meta.segDurs.length) return starts[i] + Number(meta.segDurs[i] || 0);
      return i + 1 < segCount ? starts[i + 1] : duration;
    }

    /* ---------- 4.5 buffered 查询 ---------- */
    /**
     * 取 SourceBuffer 的 buffered 区间表。
     * 返回 null 表示「当前没有可用的缓冲信息」，调用方必须按空处理。
     *
     * 为什么需要这一层：SourceBuffer 会在这些情况下从父 MediaSource 上被摘掉——
     *   · 媒体元素被重新 load() / 换 src（例如同一 <video> 上又开了第二个播放器）
     *   · MediaSource 进入 closed（媒体管线被浏览器回收）
     *   · destroy()/重建管线与读取并发
     * 此时 sb.buffered 读取会抛 InvalidStateError（"This SourceBuffer has been
     * removed from the parent media source."）。内核任何路径读缓冲都不能因此崩掉，
     * 所以统一走这里，顺便把失效的 sb 记下来供上层重建。
     */
    function bufferRanges() {
      if (!sb) return null;
      try {
        if (ms && ms.readyState === 'closed') { stats.staleSb++; return null; }
        var b = sb.buffered;
        return b && b.length ? b : null;
      } catch (e) {
        stats.staleSb++;
        return null;
      }
    }

    function sbIsStale() {
      if (!sb) return false;
      try {
        if (ms && ms.readyState === 'closed') return true;
        void sb.buffered;
        return false;
      } catch (e) { return true; }
    }

    function bufferedContains(t) {
      var b = bufferRanges();
      if (!b) return false;
      for (var i = 0; i < b.length; i++) {
        if (t >= b.start(i) - 0.05 && t <= b.end(i) + 0.05) return true;
      }
      return false;
    }

    // 已缓冲到的秒数：优先当前播放点所在区间，否则取最后一区间末尾
    function bufferedEnd() {
      var b = bufferRanges();
      if (!b) return 0;
      var ct = videoEl.currentTime || 0;
      for (var i = 0; i < b.length; i++) {
        if (ct >= b.start(i) - 0.15 && ct <= b.end(i) + 0.15) return b.end(i);
      }
      return b.end(b.length - 1);
    }

    /* ---------- 4.6 SourceBuffer 串行队列 ---------- */
    function sbBusy() {
      return !!(sb && sb.updating) || !!sbActive || sbTasks.length > 0;
    }

    function notifyIdle() {
      if (sbActive || sbTasks.length) return;
      var list = idleWaiters.slice();
      idleWaiters.length = 0;
      for (var i = 0; i < list.length; i++) {
        try { list[i](); } catch (e) {}
      }
    }

    function waitSbIdle(timeout) {
      if (!sbActive && !sbTasks.length && !(sb && sb.updating)) return Promise.resolve();
      return new Promise(function (resolve) {
        var done = false;
        var fin = function () {
          if (done) return;
          done = true;
          var i = idleWaiters.indexOf(fin);
          if (i >= 0) idleWaiters.splice(i, 1);
          resolve();
        };
        idleWaiters.push(fin);
        later(fin, timeout || SB_IDLE_TIMEOUT);
      });
    }

    // 入队一个 append / remove，返回在 updateend 时 resolve 的 Promise
    function sbEnqueue(op) {
      return new Promise(function (resolve, reject) {
        if (destroyed) { reject(makeError('destroyed', '播放器已销毁')); return; }
        sbTasks.push({ op: op, resolve: resolve, reject: reject });
        drainSb();
      });
    }

    function drainSb() {
      if (destroyed) { notifyIdle(); return; }
      if (!sb || sbActive || !sbTasks.length) { notifyIdle(); return; }
      var task = sbTasks.shift();
      sbActive = task;
      try {
        if (task.op.type === 'append') {
          if (!ms || ms.readyState !== 'open') {
            var se = makeError('mse-closed', 'MediaSource 未处于 open 状态');
            se.name = 'InvalidStateError';   // 让上层按「需要重建」处理
            throw se;
          }
          sb.appendBuffer(task.op.data);
        } else if (task.op.type === 'remove') {
          pendingRemove = true;
          sb.remove(task.op.start, task.op.end);
        } else {
          throw makeError('sb-op', '未知的 SourceBuffer 操作');
        }
      } catch (e) {
        sbActive = null;
        if (task.op.type === 'remove') pendingRemove = false;
        task.reject(e);
        // 让后续任务别卡死
        later(drainSb, 0);
      }
    }

    function onUpdateEnd() {
      var task = sbActive;
      sbActive = null;
      if (task) {
        if (task.op.type === 'remove') { pendingRemove = false; stats.removals++; }
        else stats.appended++;
        try { task.resolve(); } catch (e) {}
      }
      drainSb();
      notifyIdle();
    }

    function onSbError() {
      var task = sbActive;
      sbActive = null;
      var detail = null;
      try {
        if (sb && sb.error) detail = { code: sb.error.code, message: sb.error.message };
      } catch (e) {}
      var err = makeError('sb-error', 'SourceBuffer 错误' + (detail ? ' code=' + detail.code : ''), detail ? { detail: detail } : null);
      if (task) {
        if (task.op.type === 'remove') pendingRemove = false;
        try { task.reject(err); } catch (e) {}
      }
      drainSb();
      notifyIdle();
    }

    function clearSbQueue(reason) {
      var list = sbTasks.slice();
      sbTasks.length = 0;
      for (var i = 0; i < list.length; i++) {
        try { list[i].reject(reason || makeError('aborted', '队列已清空')); } catch (e) {}
      }
    }

    /* ---------- 4.7 网络 ---------- */
    function abortInflight() {
      if (!inflight) return;
      var ac = inflight;
      inflight = null;
      try { ac.abort(); } catch (e) {}
    }

    /**
     * IPC 直连传输：不经过本机 HTTP 端口，直接向主进程内核要字节。
     *
     * base 形如 'ipcbridge://fmp4/<sid>'，拼出来的 url 是
     * 'ipcbridge://fmp4/<sid>/seg/0.m4s'，真正发给主进程的 pathname 是
     * '/fmp4/<sid>/seg/0.m4s'（去掉 'ipcbridge://' 后补一个前导斜杠）。
     *
     * 这条路径的意义：播放内核完全不再依赖 127.0.0.1 端口。端口被占、服务
     * 没起来、本机代理/防火墙插手，都不会影响播放——媒体数据走的是进程间
     * 结构化克隆，本地即内存拷贝。
     */
    var IPC_PREFIX = 'ipcbridge://';

    function isIpcUrl(url) { return typeof url === 'string' && url.indexOf(IPC_PREFIX) === 0; }

    function ipcFetch(url, asText) {
      var bridge = (typeof window !== 'undefined' && window.zhibo && window.zhibo.play &&
        typeof window.zhibo.play.fetch === 'function') ? window.zhibo.play.fetch : null;
      if (!bridge) return Promise.reject(makeError('no-ipc', '主进程未提供内核取字节通道'));
      var p = '/' + url.slice(IPC_PREFIX.length);
      stats.fetches++;
      return Promise.resolve(bridge(p)).then(function (r) {
        if (!r || r.ok !== true) {
          throw makeError('http', 'IPC ' + ((r && r.status) || '?') + ' ' + p + (r && r.error ? ' ' + r.error : ''));
        }
        var ab = r.data;
        if (!ab || !ab.byteLength) throw makeError('empty', '空响应 ' + p);
        if (!asText) return ab;
        var u8 = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
        return new TextDecoder('utf-8').decode(u8);
      });
    }

    // asText=true 时返回字符串，否则返回 ArrayBuffer。失败按 RETRY_DELAYS 重试。
    function httpGet(url, asText, myGen) {
      if (isIpcUrl(url)) {
        return ipcFetch(url, asText).catch(function (err) {
          if (destroyed || (myGen != null && myGen !== gen) || isAbort(err)) throw err;
          stats.retries++;
          return sleep(RETRY_DELAYS[0]).then(function () {
            if (destroyed) throw makeError('aborted', '已销毁');
            return ipcFetch(url, asText);
          });
        });
      }
      var delays = [0].concat(RETRY_DELAYS);
      var lastErr = null;
      var attempt = 0;

      function once() {
        if (destroyed || (myGen != null && myGen !== gen)) {
          return Promise.reject(makeError('aborted', '已取消'));
        }
        if (!_fetch) return Promise.reject(makeError('no-fetch', '环境缺少 fetch'));
        var ac = null;
        try {
          ac = _AbortController ? new _AbortController() : null;
        } catch (e) { ac = null; }
        if (ac) inflight = ac;
        stats.fetches++;
        var init = { cache: 'no-store' };
        if (ac) init.signal = ac.signal;
        return _fetch(url, init).then(function (res) {
          if (!res || (res.ok === false)) {
            throw makeError('http', 'HTTP ' + (res ? res.status : '?') + ' ' + url);
          }
          return asText ? res.text() : res.arrayBuffer();
        }).then(function (out) {
          if (inflight === ac) inflight = null;
          if (!asText && (!out || !out.byteLength)) throw makeError('empty', '空响应 ' + url);
          return out;
        }, function (err) {
          if (inflight === ac) inflight = null;
          throw err;
        });
      }

      function loop() {
        return once().catch(function (err) {
          lastErr = err;
          if (destroyed || (myGen != null && myGen !== gen) || isAbort(err)) throw err;
          if (attempt >= delays.length - 1) throw err;
          attempt++;
          stats.retries++;
          return sleep(delays[attempt]).then(function () {
            if (destroyed) throw makeError('aborted', '已销毁');
            return loop();
          });
        });
      }

      return loop();
    }

    function segUrl(i) { return base + '/seg/' + i + '.m4s'; }

    /* ---------- 4.8 MediaSource 启动 ---------- */
    function openMediaSource() {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var onOpen = function () {
          if (settled) return;
          settled = true;
          try { ms.removeEventListener('sourceopen', onOpen); } catch (e) {}
          resolve();
        };
        try {
          ms = new _MediaSource();
        } catch (e) {
          reject(makeError('mse-create', 'MediaSource 创建失败: ' + e.message));
          return;
        }
        try {
          ms.addEventListener('sourceopen', onOpen);
        } catch (e) {}
        try {
          objectUrl = _URL.createObjectURL(ms);
        } catch (e) {
          reject(makeError('mse-url', 'createObjectURL 失败: ' + e.message));
          return;
        }
        try {
          videoEl.src = objectUrl;
        } catch (e) {
          reject(makeError('video-src', '设置 src 失败: ' + e.message));
          return;
        }
        // 兜底：个别情况下 sourceopen 已在设置 src 时同步触发
        if (ms.readyState === 'open') onOpen();
      });
    }

    function attachSourceBuffer() {
      mime = mimeOf(meta.codec);
      try {
        sb = ms.addSourceBuffer(mime);
      } catch (e) {
        throw makeError('sb-add', 'addSourceBuffer 失败（' + mime + '）: ' + e.message);
      }
      try { sb.mode = 'segments'; } catch (e) {}
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', onSbError);
      sb.addEventListener('abort', function () { /* 仅用于状态收敛，不做事 */ });
    }

    function setDurationAndWait() {
      return new Promise(function (resolve) {
        var settled = false;
        var onDc = function () { finish(); };
        var finish = function () {
          if (settled) return;
          settled = true;
          try { videoEl.removeEventListener('durationchange', onDc); } catch (e) {}
          resolve();
        };
        try { videoEl.addEventListener('durationchange', onDc); } catch (e) {}
        try {
          ms.duration = duration;   // 硬性要求 1：显式设置总时长
        } catch (e) { /* 极端情况下（正在 updating）忽略，durationchange 兜底 */ }
        // 若 duration 已经是有效值，直接放行
        if (isFinite(videoEl.duration) && videoEl.duration > 0 && Math.abs(videoEl.duration - duration) < 0.5) {
          later(finish, 0);
        }
        later(finish, DURATION_WAIT); // 兜底，避免 Chromium 不补发 durationchange 时卡死
      });
    }

    /* ---------- 4.9 append 与配额重试 ---------- */
    function appendWithQuotaRetry(data, label) {
      var attempt = 0;

      var reopenTried = false;

      function go() {
        return sbEnqueue({ type: 'append', data: data }).catch(function (err) {
          if (destroyed || isAbort(err)) throw err;
          // MediaSource 已经 ended/closed：重建管线后重试一次
          if (isInvalidState(err) && !reopenTried) {
            reopenTried = true;
            return reopenMediaSource().then(function () { return go(); });
          }
          if (!isQuotaError(err) || attempt >= QUOTA_MAX_RETRY) throw err;
          attempt++;
          stats.quota++;
          // 硬性要求 6：强制收缩缓冲后重试
          var ct = videoEl.currentTime || 0;
          var cut = Math.max(1, ct - QUOTA_SAFE_BACK);
          return sbEnqueue({ type: 'remove', start: 0, end: cut })
            .catch(function () { /* remove 失败也要继续尝试 append */ })
            .then(function () { return go(); });
        });
      }

      return go().then(function () { return true; });
    }

    /* ---------- 4.10 拉流主循环 ---------- */
    function scheduleTick(ms2) {
      if (destroyed || tickScheduled) return;
      tickScheduled = true;
      later(function () {
        tickScheduled = false;
        tick();
      }, ms2 || 0);
    }

    function tick() {
      if (destroyed || pumping) return;
      pumping = true;
      var p;
      try {
        p = step();
      } catch (e) {
        p = Promise.resolve(IDLE_TICK);
      }
      p.then(function (delay) {
        pumping = false;
        if (destroyed) return;
        scheduleTick(delay);
      }, function () {
        pumping = false;
        if (!destroyed) scheduleTick(IDLE_TICK);
      });
    }

    function step() {
      if (destroyed) return Promise.resolve(IDLE_TICK);
      if (!msReady) return Promise.resolve(BUSY_TICK);

      return maybeRecycle().then(function () {
        if (destroyed) return IDLE_TICK;

        // 段错误后停住：不自动重试，等用户 seek（seek 会清 pausedByError）
        if (pausedByError) return IDLE_TICK;

        if (nextSeg >= segCount) {
          maybeFinish();
          return IDLE_TICK;
        }

        var ct = videoEl.currentTime || 0;
        var be = bufferedEnd();

        // 水位滞回
        if (be >= ct + HIGH_WATER) fetchPaused = true;
        else if (be <= ct + LOW_WATER) fetchPaused = false;

        if (fetchPaused) return IDLE_TICK;
        if (fetching) return BUSY_TICK;
        if (sbBusy()) return BUSY_TICK;

        return pullSegment();
      });
    }

    function pullSegment() {
      var idx = nextSeg;
      var myGen = gen;
      fetching = true;
      return httpGet(segUrl(idx), false, myGen).then(function (buf) {
        fetching = false;
        if (destroyed || myGen !== gen) return BUSY_TICK;
        return appendWithQuotaRetry(buf, 'seg' + idx).then(function () {
          if (destroyed || myGen !== gen) return BUSY_TICK;
          nextSeg = idx + 1;
          // 硬性要求 2：seek 目标段 append 完成后再落地 currentTime
          if (pendingSeek != null && bufferedContains(pendingSeek)) applyPendingSeek();
          return 0;
        });
      }).catch(function (err) {
        fetching = false;
        if (destroyed || myGen !== gen || isAbort(err)) return IDLE_TICK;
        failSegment(idx, err);
        return IDLE_TICK;
      });
    }

    function failSegment(idx, err) {
      pausedByError = true;
      setState('buffering');
      emit('error', {
        where: 'segment',
        segIndex: idx,
        message: (err && err.message) || String(err),
        code: (err && err.code) || 'fetch'
      });
    }

    function applyPendingSeek() {
      var t = pendingSeek;
      if (t == null) return;
      pendingSeek = null;
      var wasPlaying = !videoEl.paused;
      try { videoEl.currentTime = t; } catch (e) {}
      if (wasPlaying) play();
    }

    function maybeFinish() {
      if (endDone || destroyed || !ms || ms.readyState !== 'open') return;
      if (nextSeg < segCount) return;
      var be = bufferedEnd();
      var ct = videoEl.currentTime || 0;
      // 末段的 tfdt+segDur 可能略小于 meta.duration，所以两种判据任一满足即可收尾
      if (be <= 0) return;
      if (be < duration - 0.5 && ct < duration - 0.3) return;
      endDone = true;
      try { ms.endOfStream(); } catch (e) {}
    }

    /* ---------- 4.11 缓冲回收 ---------- */
    function maybeRecycle() {
      if (destroyed || !sb || !msReady) return Promise.resolve();
      var b = bufferRanges();
      if (!b) return Promise.resolve();
      var ct = videoEl.currentTime || 0;
      var start = b.start(0);
      if (ct - start <= RECYCLE_GAP) return Promise.resolve();
      var cut = Math.max(0, ct - KEEP_BEHIND);
      if (cut <= start) return Promise.resolve();
      return sbEnqueue({ type: 'remove', start: start, end: cut }).catch(function () {});
    }

    /* ---------- 4.11b 重建 MediaSource（ended / closed 后继续 append 的唯一可靠通路） ---------- */
    // 背景：MediaSource 进入 'ended'（已 endOfStream）或 'closed' 后，
    // SourceBuffer.appendBuffer / remove 都会抛 InvalidStateError。
    // Chromium 对「seek 到已缓冲区间」会自动把 ended 拉回 open，但目标点不在缓冲里时
    // 就会死在 append 上，所以这里走整条管线重建：新 MediaSource + 新 SourceBuffer + 重 append init。
    function reopenMediaSource() {
      if (destroyed) return Promise.reject(makeError('destroyed', '播放器已销毁'));
      // 拆旧
      try {
        if (sb) {
          try { sb.removeEventListener('updateend', onUpdateEnd); } catch (e) {}
          try { sb.removeEventListener('error', onSbError); } catch (e) {}
          if (typeof sb.abort === 'function') { try { sb.abort(); } catch (e) {} }
        }
      } catch (e) {}
      sb = null;
      sbActive = null;
      sbTasks.length = 0;
      pendingRemove = false;
      try {
        if (objectUrl) _URL.revokeObjectURL(objectUrl);
      } catch (e) {}
      objectUrl = null;
      ms = null;
      endDone = false;
      msReady = false;
      stats.resets++;

      if (!initBufCache) {
        return Promise.reject(makeError('no-init', '缺少 init 段缓存，无法重建 MediaSource'));
      }
      return openMediaSource().then(function () {
        if (destroyed) throw makeError('destroyed', '播放器已销毁');
        attachSourceBuffer();
        return appendWithQuotaRetry(initBufCache, 'init');
      }).then(function () {
        if (destroyed) throw makeError('destroyed', '播放器已销毁');
        return setDurationAndWait();
      }).then(function () {
        if (destroyed) throw makeError('destroyed', '播放器已销毁');
        msReady = true;
      });
    }

    /* ---------- 4.12 video 事件 ---------- */
    function onVideoWaiting() {
      if (destroyed) return;
      if (state !== 'buffering') {
        setState('buffering');
        emit('buffering', { at: videoEl.currentTime || 0 });
      }
    }
    function onVideoPlaying() {
      if (destroyed) return;
      setState('playing');
      emit('playing', { at: videoEl.currentTime || 0 });
    }
    function onVideoPause() {
      if (destroyed) return;
      if (state !== 'ended' && state !== 'error') setState('paused');
    }
    function onVideoTimeUpdate() {
      if (destroyed) return;
      emit('timeupdate', {
        currentTime: videoEl.currentTime || 0,
        duration: duration,
        bufferedEnd: bufferedEnd(),
        state: state
      });
      // 播放推进后水位可能需要恢复
      if (fetchPaused || pausedByError) scheduleTick(0);
    }
    function onVideoEnded() {
      if (destroyed) return;
      setState('ended');
      emit('ended', { currentTime: videoEl.currentTime || 0 });
    }
    function onVideoError() {
      if (destroyed) return;
      var msg = '媒体错误';
      try {
        if (videoEl.error && videoEl.error.message) msg = videoEl.error.message;
      } catch (e) {}
      setState('error');
      emit('error', { where: 'media', message: msg });
    }

    var videoHandlers = {
      waiting: onVideoWaiting,
      playing: onVideoPlaying,
      pause: onVideoPause,
      timeupdate: onVideoTimeUpdate,
      ended: onVideoEnded,
      error: onVideoError
    };

    function attachVideo() {
      for (var k in videoHandlers) {
        if (Object.prototype.hasOwnProperty.call(videoHandlers, k)) {
          try { videoEl.addEventListener(k, videoHandlers[k]); } catch (e) {}
        }
      }
    }
    function detachVideo() {
      for (var k in videoHandlers) {
        if (Object.prototype.hasOwnProperty.call(videoHandlers, k)) {
          try { videoEl.removeEventListener(k, videoHandlers[k]); } catch (e) {}
        }
      }
    }

    /* ---------- 4.13 ready / boot ---------- */
    var readyResolve = null, readyReject = null;
    var readyPromise = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });
    // 内部挂一个空 catch，避免调用方忘记 catch 时控制台出现 UnhandledRejection
    readyPromise.catch(function () {});

    function fail(err) {
      setState('error');
      emit('error', { where: 'boot', message: (err && err.message) || String(err), code: (err && err.code) || 'boot' });
      if (readyReject) {
        var rej = readyReject;
        readyReject = null;
        readyResolve = null;
        rej(err);
      }
    }

    function loadMeta() {
      return httpGet(base + '/meta.json', true, gen).then(function (text) {
        var obj;
        try { obj = JSON.parse(text); } catch (e) { throw makeError('meta-json', 'meta.json 解析失败: ' + e.message); }
        if (!obj || !obj.codec || !obj.segCount) throw makeError('meta-invalid', 'meta.json 字段缺失');
        return obj;
      });
    }

    function boot() {
      setState('buffering');
      var p = meta ? Promise.resolve(meta) : loadMeta();
      p.then(function (m) {
        if (destroyed) return null;
        meta = m;
        if (!isSupported(meta.codec)) throw makeError('codec-unsupported', '不支持该编解码: ' + meta.codec);
        buildTimeline();
        // ready 之前调用过 seek(t) 的，以它为准（见 seek 的未就绪分支）
        var sT = pendingSeek != null ? pendingSeek : startTime;
        nextSeg = segIndexAt(sT);
        if (sT > 0) pendingSeek = sT;
        return openMediaSource();
      }).then(function (r) {
        if (r === null || destroyed) return null;
        attachSourceBuffer();
        return httpGet(base + '/init.mp4', false, gen);
      }).then(function (initBuf) {
        if (initBuf === null || destroyed) return null;
        initBufCache = initBuf;
        return appendWithQuotaRetry(initBuf, 'init');
      }).then(function (r) {
        if (r === null || destroyed) return null;
        return setDurationAndWait();
      }).then(function (r) {
        if (r === null || destroyed) return null;
        msReady = true;
        setState('buffering');
        emit('ready', {
          duration: duration,
          codec: meta.codec,
          segCount: segCount,
          width: meta.width || 0,
          height: meta.height || 0
        });
        if (readyResolve) {
          var res = readyResolve;
          readyResolve = null;
          readyReject = null;
          res({ duration: duration, codec: meta.codec, segCount: segCount });
        }
        if (autoplay) play();
        scheduleTick(0);
        return null;
      }).catch(function (err) {
        if (destroyed || isAbort(err)) return;
        fail(err);
      });
    }

    /* ---------- 4.14 对外方法 ---------- */
    function play() {
      if (destroyed) return Promise.resolve();
      var p;
      try { p = videoEl.play(); } catch (e) { p = Promise.reject(e); }
      return Promise.resolve(p).then(function () { return undefined; }, function (err) {
        // 自动播放被拦（NotAllowedError）不算内核错误，交给调用方按需处理
        if (destroyed) return;
        if (err && err.name === 'NotAllowedError') return;
        emit('error', { where: 'play', message: (err && err.message) || String(err) });
      });
    }

    function pause() {
      if (destroyed) return;
      try { videoEl.pause(); } catch (e) {}
      if (state !== 'ended' && state !== 'error') setState('paused');
    }

    function seek(t) {
      if (destroyed) return Promise.resolve();
      var target = Number(t);
      if (!isFinite(target)) return Promise.resolve();
      // duration 未知（ready 之前）时只钳下界，不能拿 0 当上界把目标压成 0
      var maxT = duration > 0 ? Math.max(0, duration - 0.05) : Infinity;
      target = Math.min(Math.max(0, target), maxT);

      var wasPlaying = !videoEl.paused;
      pausedByError = false;
      fetchPaused = false;

      // 情况零：还没 ready。此时中断 boot 会让 init 段 fetch 被 abort、永远到不了 ready，
      // 所以只登记落点，交给 boot 用 pendingSeek 决定起始段。
      if (!msReady) {
        pendingSeek = target;
        startTime = target;
        return Promise.resolve();
      }

      // 情况一：目标点已经在缓冲里 -> 直接跳
      if (msReady && bufferedContains(target)) {
        pendingSeek = null;
        try { videoEl.currentTime = target; } catch (e) {}
        // 从 ended 回拖：状态必须跟着退出 'ended'，否则调用方 UI 会一直显示已播完
        if (state === 'ended') {
          endDone = false;
          setState('buffering');
          emit('buffering', { at: target });
        }
        if (wasPlaying) play();
        scheduleTick(0);
        return Promise.resolve();
      }

      // 情况二：需要重新从目标段 append
      gen++;
      var myGen = gen;
      stats.resets++;
      pendingSeek = target;
      abortInflight();
      clearSbQueue(makeError('aborted', 'seek 打断'));
      fetching = false;

      return waitSbIdle(SB_IDLE_TIMEOUT).then(function () {
        if (destroyed || myGen !== gen) return;
        var idx = segIndexAt(target);
        nextSeg = idx;

        // ms 已经 endOfStream 过（播完回拖），或者被浏览器关掉：
        // 此时 appendBuffer/remove 都会抛 InvalidStateError，只能重建管线。
        if (!ms || ms.readyState !== 'open') {
          return reopenMediaSource().catch(function (err) {
            if (destroyed || myGen !== gen || isAbort(err)) return;
            fail(err);
          });
        }

        var clearEnd = Math.max(duration, bufferedEnd()) + 1;
        return sbEnqueue({ type: 'remove', start: 0, end: clearEnd }).catch(function (err) {
          // remove 失败（异常状态）也不阻断，后面的 append 仍在目标 tfdt 处
          if (isInvalidState(err)) return reopenMediaSource();
        });
      }).then(function () {
        if (destroyed || myGen !== gen) return;
        scheduleTick(0);
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      gen++;

      // 1) 中断网络
      abortInflight();
      // 2) 清空 append 队列
      clearSbQueue(makeError('destroyed', '播放器已销毁'));
      // 3) 清定时器 + 叫醒所有 sleep
      clearAllTimers();
      wakeSleepers();
      // 4) SourceBuffer 收尾
      try {
        if (sb) {
          try { sb.removeEventListener('updateend', onUpdateEnd); } catch (e) {}
          try { sb.removeEventListener('error', onSbError); } catch (e) {}
          if (typeof sb.abort === 'function') { try { sb.abort(); } catch (e) {} }
        }
      } catch (e) {}
      sb = null;
      pendingRemove = false;
      // 5) MediaSource 收尾
      try {
        if (ms && typeof ms.endOfStream === 'function' && ms.readyState === 'open') {
          try { ms.endOfStream(); } catch (e) {}
        }
      } catch (e) {}
      ms = null;
      // 6) video 元素收尾
      detachVideo();
      try { videoEl.pause(); } catch (e) {}
      try { videoEl.removeAttribute('src'); } catch (e) {}
      try { videoEl.load(); } catch (e) {}
      // 7) revoke blob URL
      if (objectUrl) {
        try { _URL.revokeObjectURL(objectUrl); } catch (e) {}
        objectUrl = null;
      }
      // 8) 状态收敛
      state = 'idle';
      msReady = false;
      notifyIdle();
      var rej = readyReject;
      readyReject = null;
      readyResolve = null;
      if (rej) { try { rej(makeError('destroyed', '播放器已销毁')); } catch (e) {} }
    }

    /* ---------- 4.15 组装 player ---------- */
    var player = {
      version: VERSION,
      ready: readyPromise,
      play: play,
      pause: pause,
      seek: seek,
      destroy: destroy,
      bufferedEnd: bufferedEnd,
      // 调试用：观察内部状态（不参与播放逻辑）
      _debugSnapshot: function () {
        return {
          state: state,
          nextSeg: nextSeg,
          pendingSeek: pendingSeek,
          fetchPaused: fetchPaused,
          pausedByError: pausedByError,
          fetching: fetching,
          inflight: !!inflight,
          sbBusy: sbBusy(),
          pendingRemove: pendingRemove,
          timers: timers.length,
          queued: sbTasks.length,
          gen: gen,
          msReady: msReady,
          stats: {
            fetches: stats.fetches, retries: stats.retries, appended: stats.appended,
            removals: stats.removals, quota: stats.quota, resets: stats.resets
          }
        };
      }
    };

    Object.defineProperty(player, 'currentTime', {
      enumerable: true,
      get: function () { return destroyed ? 0 : (videoEl.currentTime || 0); }
    });
    Object.defineProperty(player, 'duration', {
      enumerable: true,
      get: function () {
        if (duration > 0) return duration;
        var d = videoEl.duration;
        return isFinite(d) && d > 0 ? d : 0;
      }
    });
    Object.defineProperty(player, 'state', {
      enumerable: true,
      get: function () { return state; }
    });
    Object.defineProperty(player, 'video', {
      enumerable: true,
      get: function () { return videoEl; }
    });
    Object.defineProperty(player, 'meta', {
      enumerable: true,
      get: function () { return meta; }
    });
    Object.defineProperty(player, 'segCount', {
      enumerable: true,
      get: function () { return segCount; }
    });
    Object.defineProperty(player, 'destroyed', {
      enumerable: true,
      get: function () { return destroyed; }
    });

    attachVideo();
    // 异步启动，不阻塞 create() 返回
    later(boot, 0);

    return player;
  }

  /* ========================= 5. 导出 ========================= */
  window.KernelPlayer = {
    version: VERSION,
    isSupported: isSupported,
    create: create
  };
})(typeof window !== 'undefined' ? window : this);
