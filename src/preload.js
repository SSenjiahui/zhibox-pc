// 智博X · preload —— 把内核能力安全暴露给渲染进程
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, a) => ipcRenderer.invoke(ch, a);

contextBridge.exposeInMainWorld('zhibo', {
  /* 内核 */
  kernel: {
    status: () => call('kernel:status'),
    boot: () => call('kernel:boot'),
  },

  /* 认证 */
  auth: {
    auto: () => call('auth:auto'),
    login: (phone, password) => call('auth:login', { phone, password }),
    sendCode: (phone) => call('auth:sendCode', { phone }),
    loginByCode: (phone, code) => call('auth:loginByCode', { phone, code }),
    diag: () => call('auth:diag'),
    session: () => call('session:get'),
    logout: () => call('session:clear'),
  },

  /* 业务 API */
  api: {
    call: (path, opts) => call('api:call', Object.assign({ path }, opts || {})),
    biz: (name, ...args) => call('api:biz', { name, args }),
  },

  /* 课程快捷方法 */
  course: {
    profile: () => call('api:biz', { name: 'profile' }),
    banners: () => call('api:biz', { name: 'banners' }),
    mine: () => call('api:biz', { name: 'myCourses' }),
    detail: (id) => call('api:biz', { name: 'courseDetail', args: [id] }),
    info: (id) => call('api:biz', { name: 'courseInfo', args: [id] }),
    // 完整详情：自动摊平「套课」的子课程，返回 data.groups
    full: (id) => call('api:biz', { name: 'courseFull', args: [id] }),
    categories: () => call('api:biz', { name: 'categories' }),
    page: (page, size, cat) => call('api:biz', { name: 'courseList', args: [page, size, cat] }),
    subtitles: (lessonId) => call('api:biz', { name: 'subtitles', args: [lessonId] }),
  },

  /* 图片 */
  image: (url) => call('image:fetch', url),
  subtitle: (url) => call('subtitle:fetch', url),

  /* 播放 */
  play: {
    open: (arg) => call('play:open', arg),
    close: (sid) => call('play:close', sid),
    // 内核取字节：不经过本机端口，直接向主进程要 init/meta/分片
    fetch: (pathname) => call('play:fetch', pathname),
  },

  /* 进度 */
  progress: {
    get: (courseId, lessonId) => call('progress:get', { courseId, lessonId }),
    save: (courseId, lessonId, pos, duration, extra) =>
      call('progress:save', { courseId, lessonId, pos, duration, extra }),
    all: () => call('progress:all'),
    course: (courseId, lessonIds) => call('progress:course', { courseId, lessonIds }),
  },

  /* 离线库 */
  library: {
    scan: () => call('lib:scan'),
    usage: () => call('lib:usage'),
    remove: (courseId, lessonId, hard) => call('lib:remove', { courseId, lessonId, hard }),
    remux: (courseId, lessonId, force) => call('lib:remux', { courseId, lessonId, force }),
  },

  /* 下载 */
  download: {
    start: (arg) => call('dl:start', arg),
    pause: (key) => call('dl:pause', key),
    resume: (key) => call('dl:resume', key),
    cancel: (key, removeFiles) => call('dl:cancel', { key, removeFiles }),
    list: () => call('dl:list'),
  },

  /* 日志 */
  log: {
    tail: (since, limit) => call('log:tail', { since, limit }),
    file: (day, maxLines) => call('log:file', { day, maxLines }),
    days: () => call('log:days'),
    dir: () => call('log:dir'),
    openDir: () => call('log:openDir'),
    write: (level, scope, text) => call('log:write', { level, scope, text }),
  },

  /* 设置（内核行为开关，改完立即生效并落盘） */
  settings: {
    get: () => call('settings:get'),
    patch: (p) => call('settings:patch', p),
    reset: () => call('settings:reset'),
    file: () => call('settings:file'),
  },

  /* 缓存治理 */
  cache: {
    enforce: () => call('cache:enforce'),
    trash: () => call('cache:trash'),
    emptyTrash: () => call('cache:emptyTrash'),
    openTrash: () => call('cache:openTrash'),
  },

  /* 桌面常驻 */
  tray: {
    refresh: () => call('tray:refresh'),
    hide: () => call('tray:hide'),
  },
  win: {
    show: () => call('win:show'),
    minimize: () => call('win:minimize'),
    quit: () => call('app:quit'),
  },

  /* 系统 */
  app: {
    info: () => call('app:info'),
    openExternal: (u) => call('app:openExternal', u),
    showItem: (p) => call('app:showItem', p),
  },

  /* 事件订阅 */
  on: (name, fn) => {
    const ch = 'ev:' + name;
    const h = (_e, data) => fn(data);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
