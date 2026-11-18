// 智博X PC — 主进程
// 现在是「壳」：窗口 + IPC 桥 + 内核托管。真正的业务在 src/core/ 里。
'use strict';

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, ipcMain, shell, protocol, net,
  Tray, Menu, Notification, nativeImage, powerSaveBlocker, dialog, globalShortcut,
} = require('electron');

const paths = require('./core/paths');
const log = require('./core/logger');
const kernel = require('./core/kernel');
const store = require('./core/store');
const auth = require('./core/auth');
const apiMod = require('./core/api');
const library = require('./core/library');
const settings = require('./core/settings');
const netMod = require('./core/net');
const hlsServer = require('./core/hls-server');
const cfgMod = require('./core/config');

/* -------- 极早期日志（logger 还没 init 之前也要留痕） -------- */
const BOOT_LOG = process.env.ZB_BOOTLOG || '';
function early(m) {
  if (!BOOT_LOG) return;
  try { fs.appendFileSync(BOOT_LOG, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (e) {}
}

/* -------- 关键：userData 必须是纯 ASCII 路径 --------
 * productName 为中文时 Electron 会指向 %APPDATA%\智博X，中文路径会让
 * Chromium 建 Code Cache / Network 目录失败并静默退出。 */
const DATA_ROOT = paths.pickDataRoot((bad) => early('dataRoot skip ' + bad));
if (DATA_ROOT) {
  try {
    app.setPath('userData', DATA_ROOT);
    app.setPath('sessionData', DATA_ROOT);
  } catch (e) { early('setPath FAIL ' + e); }
}

/* 兼容性：部分 Windows / 虚拟化环境下 GPU 合成会让渲染进程 0xC0000005 崩溃 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');

/* 自定义协议：让 <video> 能直接播本地 MP4（Chromium 不允许 file:// 加载媒体） */
protocol.registerSchemesAsPrivileged([
  { scheme: 'zbfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

process.on('uncaughtException', (e) => {
  early('UNCAUGHT ' + (e && e.stack || e));
  try { log.error('main', '未捕获异常 :: ' + ((e && e.stack) || e)); } catch (x) {}
});
process.on('unhandledRejection', (e) => {
  early('UNHANDLED ' + (e && e.stack || e));
  try { log.error('main', '未处理拒绝 :: ' + ((e && e.stack) || e)); } catch (x) {}
});

let win = null;

/* ================= 窗口 ================= */
function createWindow() {
  let bounds = null;
  if (process.env.ZB_WIN_BOUNDS) {
    const q = String(process.env.ZB_WIN_BOUNDS).split(',').map((v) => Number(v) || 0);
    if (q.length >= 4) bounds = { x: q[0], y: q[1], width: q[2], height: q[3] };
  }
  win = new BrowserWindow(Object.assign({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0F0B1A',
    title: '智博X',
    autoHideMenuBar: true,
    show: !(process.env.ZB_HIDE_START === '1'),
    icon: assetPath('icon.png') || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // 缩到托盘 / 最小化时不能把播放和下载的计时器节流掉，否则画面会卡住
      backgroundThrottling: false,
    },
  }, bounds || {}));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler((d) => {
    if (/^https?:/.test(d.url)) shell.openExternal(d.url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  /* 渲染进程崩溃自愈：内核在主进程里，界面崩了不该把下载和离线库一起带走 */
  let revived = 0;
  win.webContents.on('render-process-gone', (_e, d) => {
    try { log.error('main', '渲染进程退出 reason=' + (d && d.reason) + ' exitCode=' + (d && d.exitCode)); } catch (x) {}
    if (quitting || revived >= 3) return;
    revived++;
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      try {
        log.warn('main', '尝试自愈重载界面（第 ' + revived + ' 次）');
        win.reload();
      } catch (x) {}
    }, 700);
  });
  win.webContents.on('did-finish-load', () => { revived = 0; });

  /* 关窗口 = 收进托盘，内核继续跑（下载不断、离线库继续长）
   * 只有「托盘菜单退出 / app:quit / before-quit」才真的结束进程。 */
  win.on('close', (e) => {
    if (quitting) return;
    let keep = false;
    try { keep = !!settings.get().trayOnClose && !!tray; } catch (x) {}
    if (!keep) return;
    e.preventDefault();
    win.hide();
    log.info('main', '窗口已隐藏，内核继续在托盘运行');
    if (Notification.isSupported()) {
      try {
        const n = new Notification({
          title: '智博X 仍在后台运行',
          body: '下载与离线缓存继续，点托盘图标可回到窗口。',
          icon: assetPath('icon.png') || undefined,
          silent: true,
        });
        n.on('click', () => showMainWindow());
        n.show();
      } catch (x) {}
    }
  });

  if (process.env.ZB_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.capturePage();
          fs.writeFileSync(process.env.ZB_SHOT, img.toPNG());
          console.log('SHOT_OK ' + JSON.stringify(img.getSize()));
        } catch (e) { console.log('SHOT_FAIL ' + e); }
        app.quit();
      }, Number(process.env.ZB_SHOT_DELAY || 4000));
    });
  }
}

/* ================= 桌面常驻（托盘 + 通知 + 休眠锁） =================
 * 「独立」的桌面含义：关掉窗口不等于关掉内核。
 * 托盘在 → 内核在 → 下载继续跑、离线库继续长、下一次点开接着播。 */
let tray = null;
let quitting = false;          // 真退出（托盘菜单/退出菜单触发）
let awakeId = 0;               // powerSaveBlocker id，0 = 未持有
let trayTip = '智博X · 内核就绪';

function assetPath(name) {
  const p = path.join(__dirname, 'assets', name);
  return fs.existsSync(p) ? p : null;
}

function trayImage() {
  const p = assetPath('tray.png') || assetPath('icon.png');
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 20, height: 20 });
}

function showMainWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  try {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.setSkipTaskbar(false);
    /* show() 之后个别显卡驱动 / 远程桌面 / 多显示器切换会让首帧出不来（窗口在、画面空白）。
     * 做一次 1px 的尺寸扰动，逼 DWM 与合成器重新出一帧；再 moveTop + focus 拿回前台。 */
    if (process.env.ZB_NO_NUDGE !== '1') {
      try {
        const b = win.getBounds();
        win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height + 1 });
        win.setBounds(b);
      } catch (e) {}
    }
    win.moveTop();
    win.focus();
    try { win.webContents.invalidate(); } catch (e) {}
    log.info('main', '窗口已唤起 visible=' + win.isVisible() + ' min=' + win.isMinimized() + ' focus=' + win.isFocused());
  } catch (e) {
    log.error('main', '唤起窗口失败 :: ' + ((e && e.message) || e));
  }
}

function updateTrayTip(extra) {
  const st = (() => { try { return kernel.status(); } catch (e) { return null; } })();
  const dl = st ? (st.downloads || []).filter((t) => t.status === 'running' || t.status === 'queued').length : 0;
  const lib = st && st.library ? (st.library.bytes / 1048576).toFixed(0) + 'MB' : '—';
  trayTip = '智博X · ' + (dl ? dl + ' 个任务下载中' : '空闲') + ' · 离线库 ' + lib + (extra ? ' · ' + extra : '');
  if (tray) { try { tray.setToolTip(trayTip); } catch (e) {} }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const st = (() => { try { return kernel.status(); } catch (e) { return null; } })();
  const s = settings.get();
  const dl = st ? (st.downloads || []) : [];
  const active = dl.filter((t) => t.status === 'running' || t.status === 'queued');
  const done = dl.filter((t) => t.status === 'done');
  const items = [];

  items.push({ label: '打开智博X' + (wakeAcc ? '（' + wakeAcc.replace('Control', 'Ctrl') + '）' : ''), click: () => showMainWindow() });
  items.push({ type: 'separator' });
  items.push({ label: '下载中 ' + active.length + ' · 已完成 ' + done.length, enabled: false });
  if (active.length) {
    items.push({
      label: '暂停全部下载',
      click: () => { active.forEach((t) => { try { kernel.pauseDownload(t.key); } catch (e) {} }); rebuildTrayMenu(); },
    });
  }
  items.push({ type: 'separator' });
  items.push({
    label: '离线模式（断网只用本地）',
    type: 'checkbox',
    checked: !!s.offline,
    click: (mi) => { applySettings({ offline: !!mi.checked }); },
  });
  items.push({
    label: '关闭窗口时最小化到托盘',
    type: 'checkbox',
    checked: !!s.trayOnClose,
    click: (mi) => { applySettings({ trayOnClose: !!mi.checked }); },
  });
  items.push({ type: 'separator' });
  items.push({ label: '查看运行日志目录', click: () => { const d = log.dirPath(); if (d) shell.openPath(d); } });
  items.push({ label: '打开数据目录', click: () => { const d = paths.dataRoot(); if (d) shell.openPath(d); } });
  items.push({ type: 'separator' });
  items.push({ label: '退出智博X', click: () => quitApp() });

  try { tray.setContextMenu(Menu.buildFromTemplate(items)); } catch (e) {}
  updateTrayTip();
}

function createTray() {
  if (tray) return;
  const img = trayImage();
  if (img.isEmpty()) { log.warn('main', '托盘图标缺失，跳过托盘'); return; }
  tray = new Tray(img);
  tray.setToolTip('智博X · 内核就绪' + (wakeAcc ? ' · ' + wakeAcc.replace('Control', 'Ctrl') + ' 唤起窗口' : ''));
  /* 托盘单击 = 「把我叫出来」，不是「切换隐藏」。
   * 之前的写法是「可见就 hide」，于是窗口被别的窗口盖住时（isVisible() 仍为 true），
   * 用户点托盘想调到前面，结果反而把它藏起来 —— 这就是「点了没反应」的直接来源。
   * 现在只有「已经在前台且没最小化」才收起，其余情况一律 showMainWindow()。 */
  tray.on('click', () => {
    const front = !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused());
    if (front) win.hide();
    else showMainWindow();
  });
  tray.on('double-click', () => showMainWindow());
  rebuildTrayMenu();
  log.info('main', '托盘已就位（关窗口不退出内核）');
}

/* 全局唤醒快捷键：Ctrl+Alt+Z（首个可用者，被占用则自动降级）
 * 为什么需要它：托盘图标会被 Windows 收进「隐藏的图标」折叠区，用户找不到；
 * 而「关窗口 = 收进托盘」是默认行为，于是窗口一旦被藏起来就真的叫不回来。
 * 快捷键是绕开一切 UI 层的最后一道保险 —— 内核还活着就一定唤得出来。 */
let wakeAcc = '';
const WAKE_CANDIDATES = ['Control+Alt+Z', 'Control+Alt+X', 'Control+Alt+B', 'Alt+Shift+Z', 'Control+Shift+F10'];
function registerWakeHotkey() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  wakeAcc = '';
  for (const acc of WAKE_CANDIDATES) {
    let okHot = false;
    try {
      okHot = globalShortcut.register(acc, () => {
        log.info('main', '全局快捷键 ' + acc + ' → 唤起窗口');
        showMainWindow();
      });
    } catch (e) {
      log.warn('main', '全局快捷键 ' + acc + ' 注册异常 :: ' + ((e && e.message) || e));
      continue;
    }
    if (okHot) { wakeAcc = acc; break; }
    log.warn('main', '全局快捷键 ' + acc + ' 被占用，试下一个');
  }
  if (wakeAcc) {
    log.info('main', '全局快捷键已注册 ' + wakeAcc + '（窗口藏进托盘时用它叫回来）');
    try { rebuildTrayMenu(); } catch (e) {}
  } else {
    log.warn('main', '全部候选快捷键都被占用，只能靠托盘图标唤起窗口');
  }
  return wakeAcc;
}

function unregisterWakeHotkey() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch (e) {}
  tray = null;
}

/* 系统通知：下载/封装完成 */
function notify(title, body) {
  if (!settings.get().notifyOnDone) return;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: assetPath('icon.png') || undefined, silent: false });
    n.on('click', () => showMainWindow());
    n.show();
    log.info('main', '通知 ' + title + ' :: ' + body);
  } catch (e) { log.warn('main', '通知失败 :: ' + ((e && e.message) || e)); }
}

/* 下载期间阻止系统休眠（让「挂着下完」真的成立） */
function syncPowerBlocker() {
  let want = false;
  try {
    const s = settings.get();
    if (s.keepAwakeWhileDownload) {
      const active = kernel.downloadList().some((t) => t.status === 'running' || t.status === 'queued');
      want = !!active;
    }
  } catch (e) {}
  if (want && !awakeId) {
    try { awakeId = powerSaveBlocker.start('prevent-app-suspension'); log.info('main', '已阻止系统休眠（下载中）'); } catch (e) {}
  } else if (!want && awakeId) {
    try { powerSaveBlocker.stop(awakeId); log.info('main', '已恢复系统休眠'); } catch (e) {}
    awakeId = 0;
  }
}

/* 设置统一入口：改 + 落盘 + 套用 + 广播 + 托盘刷新 */
function applySettings(patch) {
  let r;
  try { r = kernel.patchSettings(patch || {}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  rebuildTrayMenu();
  syncPowerBlocker();
  if (win && !win.isDestroyed()) win.webContents.send('ev:settings', settings.get());
  return r;
}

/* ================= 自检（ZB_SELFTEST=<out.json>） =================
 * 端到端验收：真下载 → 真解密 → 真封装 MP4 → 真离线播放 → 真进度 → 真日志。
 * 只在显式设置环境变量时执行，正常启动不走这条路径。 */
async function runSelfTest(outFile) {
  const rep = { t: new Date().toISOString(), steps: [] };
  const push = (name, data) => {
    rep.steps.push(Object.assign({ name }, data));
    try { fs.writeFileSync(outFile, JSON.stringify(rep, null, 2)); } catch (e) {}
  };
  try {
    const st = kernel.status();
    push('boot', { ok: true, dataRoot: st.dataRoot, hlsBase: st.hlsBase, remux: !!st.remux, session: st.session });

    /* 登录态体检：1.7 的安装包里没有别人的账号，所以「有没有可用的票据」是运行时事实，
       不是常量。没有就如实把依赖账号的步骤标记为 skipped（不是 pass），不做假绿。 */
    let authed = false, authWhy = '';
    try {
      const pr = await apiMod.call('/profile');
      authed = !!(pr && pr.code === 1 && pr.data);
      authWhy = authed ? '' : ((pr && pr.message) || '未登录');
    } catch (e) { authWhy = String((e && e.message) || e); }
    push('auth-state', { ok: true, authed: authed, reason: authWhy, hasToken: !!(st.session && st.session.hasToken) });

    /* 1.7 的核心承诺：安装包不自带任何人的账号。
       直接把**打进包里的** auth.js 读回来，断言没有任何票据/手机号常量。 */
    try {
      const src = fs.readFileSync(path.join(__dirname, 'core', 'auth.js'), 'utf8');
      /* APP_TOKEN 是**应用标识**（每个客户端都一样的公开常量），不是任何人的账号票据；
         先把它从源码里剔掉，剩下的 32 位 hex 才可能是「预置的别人的票据」。 */
      const APP_ID = cfgMod.APP_TOKEN;
      const stripped = src.split(APP_ID).join('');
      const hex32 = (stripped.match(/['"][0-9a-fA-F]{32}['"]/g) || []);
      const phone = (stripped.match(/['"]1[3-9]\d{9}['"]/g) || []);
      const flag = /FALLBACK_TICKET|BUILTIN_TICKET|DEFAULT_TICKET/.test(stripped);
      push('no-baked-account', {
        ok: hex32.length === 0 && phone.length === 0 && !flag,
        bytes: src.length, hex32: hex32.length, phone: phone.length, ticketConst: flag,
        appIdOnly: src.includes(APP_ID),
      });
    } catch (e) { push('no-baked-account', { ok: false, error: String((e && e.message) || e) }); }

    // 渲染进程真的活着、window.zhibo 桥真的通
    if (win && !win.isDestroyed()) {
      try {
        const r = await win.webContents.executeJavaScript(
          '(async () => { const s = await window.zhibo.kernel.status(); ' +
          'return { bridge: !!window.zhibo, dataRoot: s && s.dataRoot, ' +
          'title: document.title, panes: document.querySelectorAll(".pane").length }; })()'
        );
        push('renderer', { ok: true, value: r });
      } catch (e) { push('renderer', { ok: false, error: String(e && e.message || e) }); }
    }

    // 在线打开（应命中 stream + 自研 fMP4 引擎）
    const o1 = await kernel.openLesson({ courseId: '1760', lessonId: '85810', lessonName: '1' });
    const eng = o1 && o1.engine;
    push('open-online', {
      ok: o1.ok, mode: o1.mode, offline: !!o1.offline, duration: o1.duration,
      streams: (o1.streams || []).length,
      engine: eng ? { codec: eng.codec, w: eng.width, h: eng.height, segs: (eng.segDurs || []).length, total: eng.timelineTotal, base: eng.base, ipcBase: eng.ipcBase } : null,
    });

    // 自研 fMP4 内核：init.mp4 / meta.json / seg/0.m4s 真能取到、moof 魔数对、tfdt 从 0 起
    if (eng) {
      try {
        const ri = await net.fetch(eng.base + '/init.mp4');
        const bi = Buffer.from(await ri.arrayBuffer());
        const rm = await net.fetch(eng.base + '/meta.json');
        const jm = await rm.json();
        const rs0 = await net.fetch(eng.base + '/seg/0.m4s');
        const bs0 = Buffer.from(await rs0.arrayBuffer());
        const rs1 = await net.fetch(eng.base + '/seg/1.m4s');
        const bs1 = Buffer.from(await rs1.arrayBuffer());
        const tfdtOf = (b) => {
          const o = b.indexOf(Buffer.from('tfdt', 'latin1'));
          if (o < 0) return null;
          return b[o + 4] === 1 ? Number(b.readBigUInt64BE(o + 8)) : b.readUInt32BE(o + 8);
        };
        push('fmp4-kernel', {
          ok: ri.status === 200 && bi.length > 512 &&
              bs0.toString('latin1', 4, 8) === 'moof' &&
              bs1.toString('latin1', 4, 8) === 'moof' &&
              tfdtOf(bs0) === 0,
          initStatus: ri.status, initBytes: bi.length,
          initBoxes: bi.toString('latin1', 4, 8) + '+' + (bi.length > 40 ? bi.toString('latin1', bi.readUInt32BE(0) + 4, bi.readUInt32BE(0) + 8) : ''),
          metaCodec: jm.codec, metaSegs: jm.segCount, metaDur: jm.duration,
          seg0Status: rs0.status, seg0Bytes: bs0.length, seg0Head: bs0.toString('latin1', 4, 8),
          seg1Head: bs1.toString('latin1', 4, 8),
          tfdt0: tfdtOf(bs0), tfdt1: tfdtOf(bs1),
          ct: ri.headers.get('content-type'),
        });
      } catch (e) { push('fmp4-kernel', { ok: false, error: String((e && e.message) || e) }); }
    } else {
      push('fmp4-kernel', { ok: false, error: 'engine 为空（fMP4 内核未就绪）' });
    }

    // IPC 直连传输：渲染进程不经本机端口，直接向主进程内核要 init / meta / 分片
    if (eng && eng.ipcBase) {
      try {
        const ip = await win.webContents.executeJavaScript(
          '(async () => {' +
          '  const b = window.zhibo && window.zhibo.play;' +
          '  if (!b || typeof b.fetch !== "function") return { ok: false, error: "preload 未暴露 play.fetch" };' +
          '  const sid = ' + JSON.stringify(eng.ipcBase.replace(/^ipcbridge:\/\//, '')) + ';' +
          '  const init = await b.fetch("/" + sid + "/init.mp4");' +
          '  const meta = await b.fetch("/" + sid + "/meta.json");' +
          '  const seg0 = await b.fetch("/" + sid + "/seg/0.m4s");' +
          '  const bad = await b.fetch("/" + sid + "/seg/9999.m4s");' +
          '  const u8 = seg0 && seg0.data ? new Uint8Array(seg0.data) : null;' +
          '  const head = u8 ? String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) : "";' +
          '  const txt = meta && meta.data ? new TextDecoder("utf-8").decode(new Uint8Array(meta.data)) : "{}";' +
          '  let jm = {}; try { jm = JSON.parse(txt); } catch (e) {}' +
          '  return { ok: !!(init && init.ok && seg0 && seg0.ok && head === "moof" && bad && bad.ok === false),' +
          '    initOk: !!(init && init.ok), initBytes: init ? init.bytes : 0, initType: init ? init.type : "",' +
          '    metaSegs: jm.segCount || 0, metaCodec: jm.codec || "",' +
          '    seg0Ok: !!(seg0 && seg0.ok), seg0Bytes: seg0 ? seg0.bytes : 0, seg0Head: head,' +
          '    oobStatus: bad ? bad.status : 0, oobRejected: !!(bad && bad.ok === false) };' +
          '})()'
        );
        push('ipc-transport', ip);
      } catch (e) { push('ipc-transport', { ok: false, error: String((e && e.message) || e) }); }
    } else {
      push('ipc-transport', { ok: false, error: 'engine 未提供 ipcBase' });
    }

    // 渲染进程用自研 MSE 内核真播（不是 <video src>，是 appendBuffer）
    if (win && !win.isDestroyed() && eng) {
      try {
        const kp = await win.webContents.executeJavaScript(
          '(async () => {' +
          '  const v = document.getElementById("videoEl");' +
          '  const eng = ' + JSON.stringify(eng) + ';' +
          '  if (!window.KernelPlayer) return { ok: false, error: "KernelPlayer 未加载" };' +
          '  const sup = window.KernelPlayer.isSupported(eng.codec);' +
          '  if (!sup) return { ok: false, error: "codec 不被 MSE 支持: " + eng.codec };' +
          '  v.pause(); v.removeAttribute("src"); v.load();' +
          '  const meta = { codec: eng.codec, segCount: eng.segDurs.length, segDurs: eng.segDurs,' +
          '                 duration: eng.timelineTotal, width: eng.width, height: eng.height };' +
          '  const events = [];' +
          '  const useBase = (eng.ipcBase && window.zhibo && window.zhibo.play && window.zhibo.play.fetch) ? eng.ipcBase : eng.base;' +
          '  const player = window.KernelPlayer.create(v, { base: useBase, meta, startTime: 0, autoplay: true,' +
          '    onEvent: (n) => { events.push(n); } });' +
          '  if (!player) return { ok: false, error: "create 返回 null" };' +
          '  let readyOk = false, readyErr = "";' +
          '  try { await Promise.race([player.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("ready 超时")), 15000))]); readyOk = true; }' +
          '  catch (e) { readyErr = String(e && e.message || e); }' +
          '  await new Promise(r => setTimeout(r, 2500));' +
          '  const out = { ok: readyOk && v.currentTime > 0.3, supported: sup, readyOk, readyErr,' +
          '    currentTime: v.currentTime, duration: v.duration || 0, w: v.videoWidth || 0, h: v.videoHeight || 0,' +
          '    state: player.state, bufferedEnd: player.bufferedEnd ? player.bufferedEnd() : 0,' +
          '    paused: v.paused, videoError: v.error ? v.error.code : 0, events: events.slice(0, 12) };' +
          '  try { player.destroy(); } catch (e) {}' +
          '  v.pause(); v.removeAttribute("src"); v.load();' +
          '  return out;' +
          '})()'
        );
        push('mse-play', kp);
        if (process.env.ZB_SHOT2 && win && !win.isDestroyed()) {
          try {
            await new Promise((r) => setTimeout(r, 800));
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.ZB_SHOT2, img.toPNG());
            push('shot-mse', { ok: true, file: process.env.ZB_SHOT2, bytes: img.toPNG().length });
          } catch (e) { push('shot-mse', { ok: false, error: String((e && e.message) || e) }); }
        }
      } catch (e) {
        let msg;
        try { msg = (e && (e.stack || e.message)) || JSON.stringify(e); } catch (x) { msg = String(e); }
        push('mse-play', { ok: false, error: String(msg).slice(0, 800) });
      }
    }

    // UI 层真播：走渲染进程自己的播放器（overlay + 角标 + 内核），不是裸 MSE
    try {
      const ui = await win.webContents.executeJavaScript(
        '(async () => {' +
        '  const out = { hasUI: !!window.__zbUI };' +
        '  if (!window.__zbUI) return out;' +
        '  window.__zbUI.switchView("home");' +
        '  await window.__zbUI.playLesson({ id: "85810", name: "1" }, { id: "1760", name: "高数Ⅰ补充练习题讲解" });' +
        '  const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
        '  let v = document.getElementById("videoEl");' +
        '  for (let i = 0; i < 40; i++) { await wait(250); if (v && v.currentTime > 0.5) break; }' +
        '  out.overlayHidden = document.getElementById("playerOverlay").hidden;' +
        '  out.badge = document.getElementById("playerBadge").textContent;' +
        '  out.foot = (document.getElementById("playerFoot").textContent || "").slice(0, 120);' +
        '  out.paused = v ? v.paused : null;' +
        '  out.currentTime = v ? Math.round(v.currentTime * 1000) / 1000 : 0;' +
        '  out.duration = v ? Math.round(v.duration * 1000) / 1000 : 0;' +
        '  out.w = v ? v.videoWidth : 0; out.h = v ? v.videoHeight : 0;' +
        '  out.videoError = v && v.error ? v.error.code : 0;' +
        '  out.hasKp = !!(window.KernelPlayer);' +
        '  return out;' +
        '})()'
      );
      ui.ok = !ui.overlayHidden && ui.currentTime > 0.5 && !ui.videoError;
      push('ui-play', ui);
      if (process.env.ZB_SHOT2 && win && !win.isDestroyed()) {
        try {
          await new Promise((r) => setTimeout(r, 1200));
          const img2 = await win.webContents.capturePage();
          const f2 = process.env.ZB_SHOT2.replace(/\.png$/i, '-ui.png');
          fs.writeFileSync(f2, img2.toPNG());
          push('shot-ui', { ok: true, file: f2, bytes: img2.toPNG().length });
        } catch (e) { push('shot-ui', { ok: false, error: String((e && e.message) || e) }); }
      }
    } catch (e) { push('ui-play', { ok: false, error: String((e && e.message) || e) }); }

    // 收起 UI 播放器：同一 <video> 上如果还挂着内核实例，后面换源会被它抢回去
    try {
      const closed = await win.webContents.executeJavaScript(
        '(async () => {' +
        '  if (window.__zbUI) { try { window.__zbUI.destroyHls(); } catch (e) {} }' +
        '  const v = document.getElementById("videoEl");' +
        '  if (v) { try { v.pause(); } catch (e) {} v.removeAttribute("src"); try { v.load(); } catch (e) {} }' +
        '  const ov = document.getElementById("playerOverlay");' +
        '  if (ov) ov.hidden = true;' +
        '  await new Promise((r) => setTimeout(r, 300));' +
        '  return { ok: true, kp: !!(window.__zbUI && window.__zbUI.state) };' +
        '})()'
      );
      push('ui-close', closed);
    } catch (e) { push('ui-close', { ok: false, error: String((e && e.message) || e) }); }

    // 真下载（含解密落盘 + 自动封装）
    const t0 = Date.now();
    const task = kernel.startDownload({ courseId: '1760', lessonId: '85810', lessonName: '1', courseName: '高数Ⅰ补充练习题讲解' });
    push('download-start', { ok: !!(task && task.key && task.total > 0), key: task && task.key, status: task && task.status, total: task && task.total });
    await new Promise((res) => {
      const iv = setInterval(() => {
        const x = kernel.downloadList().find((y) => y.key === '1760:85810');
        if (!x || x.status === 'done' || x.status === 'error' || Date.now() - t0 > 180000) {
          clearInterval(iv);
          push('download-done', {
            ok: !!(x && x.status === 'done' && x.total > 0 && x.done === x.total && !x.error),
            status: x && x.status, done: x && x.done, total: x && x.total, error: x && x.error, ms: Date.now() - t0,
          });
          res();
        }
      }, 200);
    });

    // 落盘真相
    const meta = library.readMeta('1760', '85810');
    push('library-meta', {
      ok: !!(meta && meta.status === 'ready' && meta.hasMp4 && meta.mp4Bytes > 1024 &&
        meta.width >= 320 && meta.height >= 240 && meta.duration > 1),
      status: meta && meta.status, segCount: meta && meta.segCount, hasMp4: !!(meta && meta.hasMp4),
      mp4Bytes: meta && meta.mp4Bytes, w: meta && meta.width, h: meta && meta.height, duration: meta && meta.duration,
    });

    // 离线打开（应命中 file + offline）
    const o2 = await kernel.openLesson({ courseId: '1760', lessonId: '85810' });
    push('open-offline', { ok: o2.ok, mode: o2.mode, offline: !!o2.offline, duration: o2.duration, bytes: o2.bytes, url: (o2.url || '').slice(0, 60) });

    // 强制离线分片通路（不读 mp4、只用 seg/*.ts 现场封装 —— 断网时的最后一道保险）
    try {
      const o3 = await kernel.openLesson({ courseId: '1760', lessonId: '85810', forceLocal: true, preferSegs: true });
      let segOk = false, segBytes = 0;
      if (o3.ok && o3.engine) {
        const s0 = await net.fetch(o3.engine.base + '/seg/0.m4s');
        const b0 = Buffer.from(await s0.arrayBuffer());
        segOk = s0.status === 200 && b0.toString('latin1', 4, 8) === 'moof';
        segBytes = b0.length;
        kernel.closeLesson(o3.sid);
      }
      push('open-local', {
        ok: !!o3.ok && segOk, mode: o3.mode, offline: !!o3.offline,
        segs: o3.segs, segCount: o3.segCount, error: o3.error,
        codec: o3.engine && o3.engine.codec, seg0Head: segOk ? 'moof' : '', seg0Bytes: segBytes,
      });
    } catch (e) { push('open-local', { ok: false, error: String((e && e.message) || e) }); }

    // zbfile:// 协议真的能吐出字节
    try {
      const resp = await net.fetch(o2.url);
      const buf = Buffer.from(await resp.arrayBuffer());
      const resp2 = await net.fetch(o2.url, { headers: { Range: 'bytes=1000-1999' } });
      const buf2 = Buffer.from(await resp2.arrayBuffer());
      push('zbfile-proto', {
        ok: resp.status === 200 && buf.length > 1024,
        status: resp.status, bytes: buf.length,
        head: buf.slice(0, 8).toString('hex'),
        rangeStatus: resp2.status, rangeBytes: buf2.length,
        rangeHeader: resp2.headers.get('content-range'),
      });
    } catch (e) { push('zbfile-proto', { ok: false, error: String(e && e.message || e) }); }

    // 渲染进程真的把 zbfile:// 播起来了（内核 → 播放器 全链路）
    if (win && !win.isDestroyed() && o2.ok) {
      try {
        const play = await win.webContents.executeJavaScript(
          '(async () => {' +
          '  const v = document.getElementById("videoEl");' +
          '  const url = ' + JSON.stringify(o2.url) + ';' +
          '  v.src = url; v.muted = true;' +
          '  const ready = await new Promise((res) => {' +
          '    const t = setTimeout(() => res(false), 12000);' +
          '    v.addEventListener("loadedmetadata", () => { clearTimeout(t); res(true); }, { once: true });' +
          '    v.addEventListener("error", () => { clearTimeout(t); res(false); }, { once: true });' +
          '  });' +
          '  let played = false;' +
          '  if (ready) {' +
          '    try { await v.play(); } catch (e) {}' +
          '    for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 200)); if (v.currentTime > 0.2) { played = true; break; } if (v.paused) { try { await v.play(); } catch (e) {} } }' +
          '  }' +
          '  return { ready, played, duration: v.duration || 0, w: v.videoWidth || 0, h: v.videoHeight || 0,' +
          '           currentTime: v.currentTime || 0, error: v.error ? v.error.code : 0 };' +
          '})()'
        );
        push('video-play', Object.assign({ ok: !!(play && play.ready && play.played && play.w > 0 && play.h > 0 && !play.error) }, play));
      } catch (e) { push('video-play', { ok: false, error: String(e && e.message || e) }); }
    }

    // 进度持久化
    const p = kernel.saveProgress('1760', '85810', 42.5, o2.duration || 173);
    push('progress', { ok: true, percent: p.percent, finished: p.finished });
    push('progress-read', { ok: true, value: kernel.getProgress('1760', '85810') });

    // 离线库统计 + 日志
    const usage = kernel.libraryUsage();
    push('library-usage', Object.assign({ ok: !!(usage && usage.bytes > 0) }, usage));
    const days = log.listDays();
    push('log-days', { ok: days.length > 0, days: days.length });
    const tail = log.tail(0, 12);
    /* 常驻日志是本项目的硬承诺之一：必须有内容，且最后一行是真实写过的记录 */
    push('log-tail', { ok: tail.length > 0 && !!tail[tail.length - 1].text, count: tail.length, last: tail.length ? tail[tail.length - 1].text : '' });


    // 断网可用性：强制离线后，已缓存过的课程列表仍能读出来（走本地缓存兜底）
    try {
      const was2 = netMod.isOffline();
      netMod.setOffline(true);
      let cachedOk = false, cachedCount = 0, cachedErr = '';
      try {
        const mc = await apiMod.biz.myCourses();
        cachedCount = Array.isArray(mc && mc.data) ? mc.data.length : 0;
        cachedOk = !!(mc && mc.code === 1 && cachedCount > 0);
      } catch (e) { cachedErr = String((e && e.message) || e).slice(0, 160); }
      // 离线时远端播放必须失败，但已缓存课时必须还能播
      const offPlay = await kernel.openLesson({ courseId: '1760', lessonId: '85810' });
      netMod.setOffline(was2);
      push('offline-play', {
        ok: cachedOk && !!(offPlay && offPlay.ok && offPlay.offline),
        cachedLists: cachedCount, cachedOk, cachedErr,
        playMode: offPlay && offPlay.mode, playOffline: !!(offPlay && offPlay.offline),
        restored: netMod.isOffline() === was2,
      });
    } catch (e) { push('offline-play', { ok: false, error: String((e && e.message) || e) }); }

    // 内核设置：读 → 改 → 生效 → 复原
    try {
      const s0 = kernel.getSettings();
      const r1 = kernel.patchSettings({ prefRate: 1.5, segConcurrency: 6 });
      const s1 = (r1 && r1.settings) || kernel.getSettings();
      const back = kernel.patchSettings({ prefRate: s0.prefRate, segConcurrency: s0.segConcurrency });
      push('settings', {
        ok: !!r1 && r1.ok !== false,
        changed: (r1 && r1.changed) || [],
        rateApplied: s1.prefRate === 1.5,
        segApplied: s1.segConcurrency === 6,
        restored: !!back && back.ok !== false,
        file: kernel.settingsFile(),
        keys: Object.keys(s0).length,
      });
    } catch (e) { push('settings', { ok: false, error: String((e && e.message) || e) }); }

    // 缓存治理：上限算法（设 1MB 触发归档，随后复原）
    try {
      const before = library.usage();
      const r = library.enforceLimit(1, []);
      const after = library.usage();
      library.enforceLimit(0, []);
      push('cache-limit', {
        ok: !!(r && !r.skipped),
        beforeMB: +(before.bytes / 1048576).toFixed(2),
        afterMB: +(after.bytes / 1048576).toFixed(2),
        archived: r && r.archived, purged: r && r.purged,
        shrunk: after.bytes <= before.bytes,
      });
    } catch (e) { push('cache-limit', { ok: false, error: String((e && e.message) || e) }); }

    // 设置面板：真渲染出来了吗（视图切换 + 控件状态 + 内核信息格）
    if (win && !win.isDestroyed()) {
      try {
        const sp = await win.webContents.executeJavaScript(
          '(async () => {' +
          '  const out = { hasUI: !!window.__zbUI };' +
          '  if (!window.__zbUI) return out;' +
          '  window.__zbUI.switchView("settings");' +
          '  await new Promise((r) => setTimeout(r, 700));' +
          '  const pane = document.getElementById("pane-settings");' +
          '  out.paneVisible = !!(pane && !pane.hidden);' +
          '  out.groups = pane ? pane.querySelectorAll(".set-group").length : 0;' +
          '  out.rows = pane ? pane.querySelectorAll(".set-row").length : 0;' +
          '  out.cells = pane ? pane.querySelectorAll(".k-cell").length : 0;' +
          '  out.kernelVer = (document.getElementById("setKernelVer") || {}).textContent || "";' +
          '  out.usage = (document.getElementById("setUsage") || {}).textContent || "";' +
          '  out.trash = (document.getElementById("setTrashTxt") || {}).textContent || "";' +
          '  const off = document.getElementById("setOffline");' +
          '  out.offlineSwitch = !!off;' +
          '  out.offlineChecked = off ? !!off.checked : null;' +
          '  out.netConc = (document.getElementById("setNetConc") || {}).value || "";' +
          '  out.cacheLimit = (document.getElementById("setCacheLimit") || {}).value || "";' +
          '  out.rate = (document.getElementById("setRate") || {}).value || "";' +
          '  out.vol = (document.getElementById("setVolume") || {}).value || "";' +
          '  return out;' +
          '})()'
        );
        sp.ok = sp.paneVisible && sp.groups >= 5 && sp.rows >= 12 && sp.cells >= 6;
        push('settings-ui', sp);
        if (process.env.ZB_SHOT2 && win && !win.isDestroyed()) {
          try {
            await new Promise((r) => setTimeout(r, 500));
            const img3 = await win.webContents.capturePage();
            const f3 = process.env.ZB_SHOT2.replace(/\.png$/i, '-settings.png');
            fs.writeFileSync(f3, img3.toPNG());
            push('shot-settings', { ok: true, file: f3, bytes: img3.toPNG().length });
          } catch (e) { push('shot-settings', { ok: false, error: String((e && e.message) || e) }); }
        }
      } catch (e) { push('settings-ui', { ok: false, error: String((e && e.message) || e) }); }
    }

    // 套课目录：这类课在 /my/course/<id> 里 lessonList 是空的，课时挂在子课程里。
    // 校验 courseFull 能摊平出分组，且 UI 真的把课时渲染出来（不能再是「暂无课时」）
    if (authed && win && !win.isDestroyed()) {
      try {
        let cg = null;
        // 顺带核一遍所有已购课程：flatCount 必须等于 classHours（套课最容易在这出错）
        let allOk = 0, allBad = [];
        try {
          const r0 = await apiMod.biz.courseFull('1996');
          const dd = (r0 && r0.data) || {};
          try {
            const mine = await apiMod.biz.myCourses();
            for (const cc of ((mine && mine.data) || [])) {
              const rr = await apiMod.biz.courseFull(cc.id);
              const gs = ((rr && rr.data && rr.data.groups) || []);
              const flat = gs.reduce((s, g) => s + g.lessons.length, 0);
              if (flat === Number(cc.classHours || 0)) allOk++;
              else allBad.push(String(cc.id) + ':' + flat + '/' + cc.classHours);
            }
          } catch (e) { allBad.push('scan:' + String((e && e.message) || e)); }
          cg = {
            groups: (dd.groups || []).length,
            flatCount: dd.flatCount || 0,
            names: (dd.groups || []).map((g) => g.name),
            counts: (dd.groups || []).map((g) => g.lessons.length),
          };
        } catch (e) { cg = { error: String((e && e.message) || e) }; }
        const ui = await win.webContents.executeJavaScript(
          '(async () => {' +
          '  const out = {};' +
          '  if (!window.__zbUI) return { noUI: true };' +
          '  window.__zbUI.switchView("mine");' +
          '  const c = { id: "1996", name: "线上集训营（含高数 I）" };' +
          '  await window.__zbUI.openCourse(c);' +
          '  await new Promise((r) => setTimeout(r, 900));' +
          '  const rows = document.querySelectorAll("#lessonList .lesson-row");' +
          '  out.rows = rows.length;' +
          '  out.heads = document.querySelectorAll("#lessonList .lesson-group-head").length;' +
          '  out.count = (document.getElementById("lessonCount") || {}).textContent || "";' +
          '  out.empty = /暂无课时/.test(document.getElementById("lessonList").textContent || "");' +
          '  out.firstName = rows[0] ? (rows[0].querySelector(".lr-name") || {}).textContent || "" : "";' +
          '  out.headNames = Array.prototype.map.call(' +
          '    document.querySelectorAll("#lessonList .lgh-name"), (e) => e.textContent);' +
          '  return out;' +
          '})()'
        );
        const total = (cg && cg.flatCount) || 0;
        push('course-groups', {
          ok: !!(cg && cg.groups >= 4 && total >= 396 && ui && !ui.noUI && !ui.empty && ui.rows >= 20 && ui.heads >= 4 && allOk >= 13),
          api: cg, ui, allOk, allBad,
        });
        if (process.env.ZB_SHOT2 && win && !win.isDestroyed()) {
          try {
            await new Promise((r) => setTimeout(r, 400));
            const im = await win.webContents.capturePage();
            const f = process.env.ZB_SHOT2.replace(/\.png$/i, '-course.png');
            fs.writeFileSync(f, im.toPNG());
            push('shot-course', { ok: true, file: f, bytes: im.toPNG().length });
          } catch (e) { push('shot-course', { ok: false, error: String((e && e.message) || e) }); }
        }
      } catch (e) { push('course-groups', { ok: false, error: String((e && e.message) || e) }); }
    }

    // 分组交互：科目筛选 + 折叠。这两个是「一长串」问题的正面解药，
    // 必须验到「点了真的收窄/收起」，而不是只看 DOM 里有没有元素
    if (authed && win && !win.isDestroyed()) {
      try {
        const gu = await win.webContents.executeJavaScript(
          '(async () => {' +
          '  const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
          '  const out = {};' +
          '  try {' +
          '  if (!window.__zbUI) return { noUI: true };' +
          '  window.__zbUI.switchView("mine");' +
          '  await window.__zbUI.openCourse({ id: "1996", name: "线上集训营（含高数 I）" });' +
          '  await wait(700);' +
          '  out.base = window.__zbUI.detail();' +
          '  const chips = document.querySelectorAll("#lessonFilterBar .lchip");' +
          '  if (chips.length < 2) return { error: "no chips", base: out.base };' +
          '  chips[1].click();' +
          '  await wait(200);' +
          '  out.afterFilter = window.__zbUI.detail();' +
          '  out.filteredRows = [...document.querySelectorAll("#lessonList .lesson-group")]' +
          '    .filter((e) => !e.hidden).reduce((n, e) => n + e.querySelectorAll(".lesson-row").length, 0);' +
          '  /* 回到全部科目，再试折叠 */' +
          '  chips[0].click();' +
          '  await wait(150);' +
          '  out.afterReset = window.__zbUI.detail();' +
          '  const head = document.querySelector("#lessonList .lesson-group-head");' +
          '  head.click();' +
          '  await wait(250);' +
          '  out.collapsed = window.__zbUI.detail();' +
          '  const body = document.querySelector("#lessonList .lesson-group-body");' +
          '  out.bodyH = body ? body.getBoundingClientRect().height : -1;' +
          '  head.click();' +
          '  await wait(200);' +
          '  out.expanded = window.__zbUI.detail();' +
          '  } catch (e) { out.thrown = String((e && e.stack) || e); }' +
          '  return out;' +
          '})()'
        );
        push('group-ui', {
          ok: !!(gu && !gu.noUI && !gu.error &&
            gu.base && gu.base.groups >= 4 && gu.base.chips === gu.base.groups + 1 &&
            gu.afterFilter && gu.afterFilter.visibleGroups === 1 && gu.afterFilter.chipOn &&
            gu.filteredRows > 0 && gu.filteredRows < gu.base.rows &&
            gu.afterReset && gu.afterReset.visibleGroups === gu.base.groups &&
            gu.collapsed && gu.collapsed.collapsed === 1 && gu.bodyH <= 0.5 &&
            gu.expanded && gu.expanded.collapsed === 0),
          detail: gu,
        });
        if (process.env.ZB_SHOT2 && win && !win.isDestroyed()) {
          try {
            await new Promise((r) => setTimeout(r, 300));
            const im = await win.webContents.capturePage();
            const f = process.env.ZB_SHOT2.replace(/\.png$/i, '-groups.png');
            fs.writeFileSync(f, im.toPNG());
            push('shot-groups', { ok: true, file: f, bytes: im.toPNG().length });
          } catch (e) { push('shot-groups', { ok: false, error: String((e && e.message) || e) }); }
        }
      } catch (e) { push('group-ui', { ok: false, error: String((e && e.message) || e) }); }
    }

    // 拖动 seek：这是「拖一下就卡死」的回归测试。
    // 关键判据：拖动过程中 video.currentTime 必须一动不动（旧实现每帧写一次，
    // 每次都要 abort 在途分片 + 清空 SourceBuffer，几十次/秒就把主进程打满），
    // 松手后才落地一次，且落地位置要接近目标。
    if (authed && win && !win.isDestroyed()) {
      try {
        const sd = await win.webContents.executeJavaScript(
          '(async () => {' +
          '  const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
          '  const out = {};' +
          '  try {' +
          '  if (!window.__zbUI) return { noUI: true };' +
          '  window.__zbUI.switchView("mine");' +
          '  await window.__zbUI.openCourse({ id: "1760", name: "高数Ⅰ补充练习题讲解" });' +
          '  await wait(500);' +
          '  await window.__zbUI.playLesson({ id: "85810", name: "1" }, { id: "1760", name: "高数Ⅰ补充练习题讲解" });' +
          '  const v = document.getElementById("videoEl");' +
          '  const seek = document.getElementById("seek");' +
          '  let t0 = 0;' +
          '  for (let i = 0; i < 60; i++) {' +
          '    await wait(200);' +
          '    if (v.currentTime > 0.6 && v.duration > 5) { t0 = v.currentTime; break; }' +
          '  }' +
          '  if (!t0) return { error: "video not playing", ct: v.currentTime, dur: v.duration };' +
          '  out.startCT = t0;' +
          '  out.duration = v.duration;' +
          '  out.hasKp = !!(window.__zbUI.state().hasKp);' +
          '  const r = seek.getBoundingClientRect();' +
          '  const y = r.top + r.height / 2;' +
          '  const px = (ratio) => r.left + r.width * ratio;' +
          '  const ev = (type, x) => new PointerEvent(type, {' +
          '    bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse",' +
          '    isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1,' +
          '    clientX: x, clientY: y,' +
          '  });' +
          '  seek.dispatchEvent(ev("pointerdown", px(0.5)));' +
          '  await wait(50);' +
          '  const ctAtDown = v.currentTime;' +
          '  const rate = v.playbackRate || 1;' +
          '  const tDrag0 = Date.now();' +
          '  /* 模拟一次真实拖拽：来回拖 20 步 */' +
          '  for (let i = 0; i <= 20; i++) {' +
          '    const ratio = 0.5 + 0.3 * Math.sin((i / 20) * Math.PI);' +
          '    seek.dispatchEvent(ev("pointermove", px(ratio)));' +
          '    await wait(8);' +
          '  }' +
          '  const dragMs = Date.now() - tDrag0;' +
          '  out.dragging = window.__zbUI.state().seeking;' +
          '  out.dragMs = dragMs;' +
          '  out.rate = rate;' +
          '  /* 拖动期间视频照常播（不暂停），所以播放头会按墙钟前移一点。' +
          '     真正要排除的是「每次 pointermove 都写 currentTime」导致的跳转 ——' +
          '     那种情况播放头会直接飞到拖动目标（本用例目标约 72s）。 */' +
          '  out.movedDuringDrag = Math.abs(v.currentTime - ctAtDown);' +
          '  out.expectedDrift = (dragMs / 1000) * rate;' +
          '  out.jumpedToTargetDuringDrag = Math.abs(v.currentTime - v.duration * 0.5) < 5;' +
          '  out.previewText = (document.getElementById("tCur") || {}).textContent || "";' +
          '  const target = v.duration * 0.42;' +
          '  out.target = target;' +
          '  seek.dispatchEvent(ev("pointermove", px(0.42)));' +
          '  seek.dispatchEvent(ev("pointerup", px(0.42)));' +
          '  await wait(60);' +
          '  out.afterUp = window.__zbUI.state().seeking;' +
          '  let landed = 0;' +
          '  for (let i = 0; i < 50; i++) {' +
          '    await wait(200);' +
          '    if (Math.abs(v.currentTime - target) < 3 && !v.paused) { landed = v.currentTime; break; }' +
          '  }' +
          '  out.landed = landed;' +
          '  out.videoError = v.error ? v.error.code : 0;' +
          '  out.draggingClass = seek.classList.contains("dragging");' +
          '  } catch (e) { out.thrown = String((e && e.stack) || e); }' +
          '  return out;' +
          '})()'
        );
        push('seek-drag', {
          // 拖动中位移必须是 0；松手后必须真的跳到目标附近；不能残留 dragging 态
          /* 判定分三条，各自对应一个真实缺陷：
           *   ①拖动中不得跳转：位移必须落在「正常播放漂移 + 0.4s 容差」内，
           *     且播放头绝不能出现在拖动目标附近（旧版每 move 写一次 currentTime 就会跳到目标）；
           *   ②松手后必须真的落到目标附近（±4s），并且不残留 dragging 态；
           *   ③拖动全程不得出现 media error。 */
          ok: !!(sd && !sd.noUI && !sd.error &&
            sd.dragging === true &&
            sd.movedDuringDrag <= (Number(sd.expectedDrift) || 0) + 0.4 &&
            sd.jumpedToTargetDuringDrag === false &&
            sd.afterUp === false && sd.draggingClass === false &&
            sd.landed > 0 && Math.abs(sd.landed - sd.target) < 4 && !sd.videoError),
          detail: sd,
        });
      } catch (e) { push('seek-drag', { ok: false, error: String((e && e.message) || e) }); }
    }

    // 登录闸门：本机没有会话时必须停在登录页，不能自己溜进主界面
    try {
      const g = await win.webContents.executeJavaScript(
        '(async () => {' +
        '  const lv = document.getElementById("loginView");' +
        '  const av = document.getElementById("appView");' +
        '  const gh = document.getElementById("guestBtn");' +
        '  const sess = await window.zhibo.auth.session();' +
        '  return {' +
        '    loginVisible: !!(lv && !lv.hidden),' +
        '    appHidden: !!(av && av.hidden),' +
        '    hasGuest: !!gh,' +
        '    guestText: gh ? String(gh.textContent || "") : "",' +
        '    tokenLen: String((sess && sess.authToken) || "").length,' +
        '  };' +
        '})()'
      );
      /* 判定基准是「服务端认不认这张票据」（即前面 auth-state 的 authed），
         不是「本地有没有一串字符」——1.7 装完之后本地可能残留一张过期票据，
         那时界面必须停在登录页，而不是把过期的会话当成已登录。 */
      const noSession = !authed;
      const gateOk = noSession ? (g.loginVisible && g.appHidden) : (g.appHidden === false);
      push('login-gate', {
        ok: gateOk, noSession, authed, tokenLen: g && g.tokenLen, detail: g,
      });
    } catch (e) { push('login-gate', { ok: false, error: String((e && e.message) || e) }); }

    // 登录界面：验证码 tab 必须真的可用（密码登录有 5 次错锁 15 分钟的风险，验证码是主通路）
    try {
      const lu = await win.webContents.executeJavaScript(
        '(async () => {' +
        '  const q = (id) => document.getElementById(id);' +
        '  const tabCode = q("tabCode"), tabPwd = q("tabPwd");' +
        '  const cf = q("codeForm"), pf = q("loginForm");' +
        '  const vis = (el) => !!(el && !el.hidden && el.offsetParent !== null);' +
        '  return {' +
        '    hasTabs: !!(tabCode && tabPwd),' +
        '    codeActive: !!(tabCode && tabCode.classList.contains("active")),' +
        '    codeFormVisible: vis(cf),' +
        '    pwdFormHidden: !!(pf && pf.hidden),' +
        '    sendBtn: !!(q("sendCodeBtn") && String(q("sendCodeBtn").textContent||"").trim()),' +
        '    phone: !!(q("codePhone")),' +
        '    codeInput: !!(q("codeInput")),' +
        '    submitBtn: !!(q("codeLoginBtn")),' +
        '    hasBridge: !!(window.zhibo && window.zhibo.auth && typeof window.zhibo.auth.sendCode === "function" && typeof window.zhibo.auth.loginByCode === "function"),' +
        '  };' +
        '})()'
      );
      /* 只在没登录时校验「停在登录页且验证码通道就绪」；
         已登录时界面在主视图，这几项天然不可见，跳过判定。 */
      const structuralOk = !!(lu && lu.hasTabs && lu.sendBtn && lu.phone && lu.codeInput && lu.submitBtn && lu.hasBridge);
      const gateOk2 = authed ? true : !!(lu.codeActive && lu.codeFormVisible && lu.pwdFormHidden);
      push('login-ui', { ok: structuralOk && gateOk2, authed, detail: lu });
      /* 只在未登录时截登录页 —— 这是用户第一眼看到的东西，必须真的能看能点 */
      if (!authed && process.env.ZB_SHOT2 && win && !win.isDestroyed()) {
        try {
          const img = await win.capturePage();
          const f4 = process.env.ZB_SHOT2.replace(/\.png$/i, '-login.png');
          fs.writeFileSync(f4, img.toPNG());
          push('shot-login', { ok: true, file: f4, bytes: img.toPNG().length });
        } catch (e) { push('shot-login', { ok: false, error: String((e && e.message) || e) }); }
      }
    } catch (e) { push('login-ui', { ok: false, error: String((e && e.message) || e) }); }

    // 桌面常驻：托盘是否真的建起来了
    push('tray', {
      ok: !!tray,
      exists: !!(tray && !tray.isDestroyed()),
      hasTip: !!trayTip,
      tip: trayTip,
      tipFromTray: tray && tray.getToolTip ? tray.getToolTip() : '',
      tipSet: !!(tray && !tray.isDestroyed() && trayTip),
      singleInstance: !!app.requestSingleInstanceLock,
      powerBlocker: typeof powerSaveBlocker.isStarted === 'function' ? powerSaveBlocker.isStarted(1) : null,
      /* 唤醒快捷键：窗口被藏进托盘折叠区时，这是唯一不依赖 UI 的兜底通路 */
      hotkey: wakeAcc || '(无可用快捷键)',
      hotkeyCandidates: WAKE_CANDIDATES,
      hotkeyRegistered: (() => { try { return !!wakeAcc && globalShortcut.isRegistered(wakeAcc); } catch (e) { return false; } })(),
    });

    /* 窗口唤起（这是用户真实遇到的故障：点到托盘/图标后窗口不出来，只能看到任务栏图标）。
       验证的是**应用自己的通路**：hide → showMainWindow() → 窗口可见 + 真的出帧。
       注意：绝不能用 Win32 ShowWindow 从外部去 show —— 那样 Chromium 的遮挡状态不会同步，
       客户区会永远白屏（已实测）。这里走的就是用户点托盘图标时的那条代码路径。 */
    try {
      const before = win.isVisible();
      win.hide();
      await new Promise((r) => setTimeout(r, 900));
      const hidden = !win.isVisible();
      const hiddenShot = await win.capturePage().catch(() => null);
      showMainWindow();
      await new Promise((r) => setTimeout(r, 1400));
      const vis = win.isVisible();
      const min = win.isMinimized();
      const img = await win.capturePage().catch(() => null);
      let distinct = 0, avg = 0;
      if (img && !img.isEmpty()) {
        const bmp = img.toBitmap();  // BGRA
        const seen = new Set();
        let sum = 0, n = 0;
        for (let i = 0; i + 3 < bmp.length; i += 4 * 97) {
          seen.add((bmp[i] << 16) | (bmp[i + 1] << 8) | bmp[i + 2]);
          sum += (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3; n++;
        }
        distinct = seen.size; avg = n ? Math.round(sum / n) : 0;
      }
      const shotBytes = img && !img.isEmpty() ? img.toPNG().length : 0;
      if (shotBytes > 2000) {
        try { fs.writeFileSync(outFile.replace(/\.json$/, '-recall.png'), img.toPNG()); } catch (e) {}
      }
      push('window-recall', {
        ok: hidden && vis && !min && shotBytes > 20000 && distinct > 40,
        wasVisible: before, hidden, visAfter: vis, min, shotBytes, distinctColors: distinct, avgLuma: avg,
        hiddenShotBytes: hiddenShot && !hiddenShot.isEmpty() ? hiddenShot.toPNG().length : 0,
      });
    } catch (e) { push('window-recall', { ok: false, error: String((e && e.message) || e) }); }

    // 离线模式：拦截验证（进程级开关，验证完立刻复原）
    try {
      const was = netMod.isOffline();
      netMod.setOffline(true);
      let blocked = false;
      try { await netMod.fetchBuffer(cfgMod.API_BASE + '/profile'); }
      catch (e) { blocked = /离线模式已开启/.test(String(e && e.message)); }
      netMod.setOffline(was);
      push('offline-guard', { ok: blocked, blocked, restored: netMod.isOffline() === was });
    } catch (e) { push('offline-guard', { ok: false, error: String((e && e.message) || e) }); }


    /* 未登录时，依赖账号的步骤一律记为 skipped —— 它们没被验证，但也绝不冒充通过。
       登录之后重跑自检，这些步骤必须重新变成真正的 pass。 */
    if (!authed) {
      const ACCT = ['open-online', 'fmp4-kernel', 'ipc-transport', 'mse-play', 'shot-mse',
        'ui-play', 'shot-ui', 'ui-close', 'download-start', 'download-done', 'library-meta',
        'open-offline', 'open-local', 'zbfile-proto', 'video-play', 'progress', 'progress-read',
        'library-usage', 'offline-play', 'course-groups', 'shot-course', 'group-ui',
        'shot-groups', 'seek-drag'];
      const set = new Set(ACCT);
      rep.steps.forEach((s) => {
        if (set.has(s.name) && s.ok === false) {
          s.skipped = true; s.ok = null;
          s.reason = '本机没有有效登录态（' + (authWhy || '未登录') + '）';
        }
      });
      /* 还有一类更容易被忽略：未登录时某些步骤**根本没跑到**（比如被 authed 门禁挡掉），
         报告里连一条记录都没有。缺记录不等于通过，必须显式补成 skipped，
         否则「34 步全绿」会变成一句假话。 */
      const have = new Set(rep.steps.map((x) => x.name));
      ACCT.forEach((n) => {
        if (!have.has(n)) {
          rep.steps.push({ name: n, ok: null, skipped: true, reason: '未登录，未执行（' + (authWhy || '未登录') + '）' });
        }
      });
    }
    rep.authed = authed;
    rep.ok = !rep.steps.some((s) => s.ok === false);
  } catch (e) {
    rep.ok = false;
    rep.error = String((e && e.stack) || e);
  }
  try { fs.writeFileSync(outFile, JSON.stringify(rep, null, 2)); } catch (e) {}
  try { log.info('selftest', '自检完成 ok=' + rep.ok); log.flush(); } catch (e) {}
  if (process.env.ZB_SELFTEST_EXIT !== '0') { setTimeout(() => app.quit(), 300); }
}

/* ================= IPC ================= */
function ok(v) { return { ok: true, result: v }; }
function fail(e) { return { ok: false, error: String((e && e.message) || e) }; }

function registerIpc() {
  /* ---------- 内核状态 ---------- */
  ipcMain.handle('kernel:status', () => kernel.status());
  ipcMain.handle('kernel:boot', () => ({
    dataRoot: paths.dataRoot(), logs: log.dirPath(), dirs: paths.dirs(),
  }));

  /* ---------- 认证 ---------- */
  ipcMain.handle('auth:auto', async () => {
    try { return ok(await auth.autoLogin()); } catch (e) { return fail(e); }
  });
  ipcMain.handle('auth:login', async (_e, a) => {
    try { return ok(await auth.login(a && a.phone, a && a.password)); } catch (e) { return fail(e); }
  });
  /* 验证码登录：密码登录在这个后端上 5 次错就锁 15 分钟，短信码是更稳的入口 */
  ipcMain.handle('auth:sendCode', async (_e, a) => {
    try { return ok(await auth.sendCode(a && a.phone)); } catch (e) { return fail(e); }
  });
  ipcMain.handle('auth:loginByCode', async (_e, a) => {
    try { return ok(await auth.loginByCode(a && a.phone, a && a.code)); } catch (e) { return fail(e); }
  });
  /* 登录诊断：把最近一次登录的原始响应（响应头 + 响应体）读回来，
   * 让界面能直接告诉用户「服务端到底返回了什么」，而不是只说一句登录失败。 */
  ipcMain.handle('auth:diag', () => {
    try {
      const f = auth.lastDiagFile();
      if (!f || !fs.existsSync(f)) return { ok: true, file: '', data: null };
      let data = null;
      try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { data = null; }
      return { ok: true, file: f, data };
    } catch (e) { return fail(e); }
  });
  ipcMain.handle('session:get', () => {
    const s = auth.get();
    return { authToken: s.authToken, userToken: s.userToken, cookie: s.cookie, profile: s.profile };
  });
  ipcMain.handle('session:clear', () => {
    let who = '';
    try { who = (new Error('session:clear')).stack.split('\n').slice(2, 8).map((x) => x.trim()).join(' <= '); } catch (e) {}
    try { log.warn('main', 'session:clear 被调用 :: ' + who); } catch (e) {}
    auth.clear();
    return true;
  });

  /* ---------- API ---------- */
  ipcMain.handle('api:call', async (_e, a) => {
    const x = a || {};
    try {
      return ok(await apiMod.call(x.path, {
        method: x.method, body: x.body, needAuth: x.needAuth,
        cache: x.cache, ttl: x.ttl, offlineFallback: x.offlineFallback,
      }));
    } catch (e) { return fail(e); }
  });
  ipcMain.handle('api:biz', async (_e, a) => {
    const x = a || {};
    try {
      const fn = apiMod.biz[x.name];
      if (typeof fn !== 'function') return fail(new Error('未知业务接口 ' + x.name));
      return ok(await fn.apply(null, x.args || []));
    } catch (e) { return fail(e); }
  });

  /* ---------- 图片（规避防盗链） ---------- */
  ipcMain.handle('image:fetch', async (_e, url) => {
    try {
      const netMod = require('./core/net');
      const r = await netMod.fetchBuffer(String(url), {
        headers: { Referer: cfgMod.IMAGE_REFERER, Accept: 'image/*,*/*' },
        timeout: 30000, retries: 2, maxBytes: 16 * 1024 * 1024,
      });
      const mime = String(r.headers['content-type'] || 'image/png').split(';')[0];
      return ok({ mime, base64: r.buffer.toString('base64'), status: r.status });
    } catch (e) { return fail(e); }
  });

  /* ---------- 播放 ---------- */
  ipcMain.handle('play:open', async (_e, a) => {
    try {
      const x = a || {};
      const r = await kernel.openLesson({
        courseId: x.courseId, lessonId: x.lessonId,
        lessonName: x.lessonName, courseName: x.courseName,
        streamIndex: x.streamIndex || 0,
        forceLocal: !!x.forceLocal,
        preferSegs: !!x.preferSegs,
      });
      log.info('play', '打开课时 ' + x.courseId + '/' + x.lessonId +
        ' → ' + (r && r.ok ? r.mode + (r.offline ? '(离线)' : '') : '失败 ' + (r && r.error)));
      return ok(r);
    } catch (e) { return fail(e); }
  });
  ipcMain.handle('play:close', (_e, sid) => { kernel.closeLesson(String(sid || '')); return true; });

  /**
   * 内核取字节通道（IPC 直连）。
   * 渲染进程的自研 MSE 内核用它拿 init/meta/分片，路径与本地 HTTP 服务完全同构，
   * 只是把「socket 上的 HTTP」换成「结构化克隆」——于是播放链路对端口零依赖。
   */
  ipcMain.handle('play:fetch', async (_e, pathname) => {
    try {
      const r = await hlsServer.resolvePath(String(pathname || ''));
      if (!r || r.code !== 200) {
        return { ok: false, status: (r && r.code) || 0, type: (r && r.type) || '', error: (r && Buffer.isBuffer(r.body)) ? r.body.toString('utf8').slice(0, 200) : '' };
      }
      const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
      // 转成独立 ArrayBuffer（结构化克隆不复制 Buffer 的分片视图）
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { ok: true, status: 200, type: r.type, bytes: buf.length, data: ab };
    } catch (e) {
      return { ok: false, status: 500, error: String((e && e.message) || e) };
    }
  });

  /* ---------- 进度 ---------- */
  ipcMain.handle('progress:get', (_e, a) => {
    const x = a || {};
    return kernel.getProgress(String(x.courseId || ''), String(x.lessonId || ''));
  });
  ipcMain.handle('progress:save', (_e, a) => {
    const x = a || {};
    return kernel.saveProgress(String(x.courseId || ''), String(x.lessonId || ''), x.pos, x.duration, x.extra);
  });
  ipcMain.handle('progress:all', () => kernel.allProgress());
  ipcMain.handle('progress:course', (_e, a) => {
    const x = a || {};
    return kernel.courseProgress(String(x.courseId || ''), x.lessonIds || []);
  });

  /* ---------- 离线库 ---------- */
  ipcMain.handle('lib:scan', () => kernel.libraryScan());
  ipcMain.handle('lib:usage', () => kernel.libraryUsage());
  ipcMain.handle('lib:remove', (_e, a) => {
    const x = a || {};
    return kernel.libraryRemove(String(x.courseId), String(x.lessonId), !!x.hard);
  });
  ipcMain.handle('lib:remux', async (_e, a) => {
    const x = a || {};
    try { return ok(await kernel.remuxLesson(String(x.courseId), String(x.lessonId), !!x.force)); }
    catch (e) { return fail(e); }
  });

  /* ---------- 下载 ---------- */
  ipcMain.handle('dl:start', (_e, a) => {
    try { return ok(kernel.startDownload(a || {})); } catch (e) { return fail(e); }
  });
  ipcMain.handle('dl:pause', (_e, key) => { kernel.pauseDownload(String(key)); return true; });
  ipcMain.handle('dl:resume', (_e, key) => { kernel.resumeDownload(String(key)); return true; });
  ipcMain.handle('dl:cancel', (_e, a) => {
    const x = a || {};
    kernel.cancelDownload(String(x.key), !!x.removeFiles);
    return true;
  });
  ipcMain.handle('dl:list', () => kernel.downloadList());

  /* ---------- 日志 ---------- */
  ipcMain.handle('log:tail', (_e, a) => {
    const x = a || {};
    return log.tail(x.since || 0, x.limit || 500);
  });
  ipcMain.handle('log:file', (_e, a) => {
    const x = a || {};
    return log.readFile(x.day, x.maxLines);
  });
  ipcMain.handle('log:days', () => log.listDays());
  ipcMain.handle('log:dir', () => log.dirPath());
  ipcMain.handle('log:openDir', () => {
    const d = log.dirPath();
    if (d) shell.openPath(d);
    return d;
  });
  ipcMain.handle('log:write', (_e, a) => {
    const x = a || {};
    const lv = ['debug', 'info', 'warn', 'error'].indexOf(x.level) >= 0 ? x.level : 'info';
    log.log(lv, String(x.scope || 'ui'), String(x.text || ''));
    return true;
  });

  /* ---------- 设置 ---------- */
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:patch', (_e, a) => applySettings(a || {}));
  ipcMain.handle('settings:reset', () => {
    const r = kernel.resetSettings();
    rebuildTrayMenu();
    if (win && !win.isDestroyed()) win.webContents.send('ev:settings', settings.get());
    return r;
  });
  ipcMain.handle('settings:file', () => {
    const p = settings.filePath();
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return p;
  });

  /* ---------- 缓存治理 ---------- */
  ipcMain.handle('cache:enforce', () => kernel.cacheEnforce());
  ipcMain.handle('cache:trash', () => {
    let bytes = 0;
    try { bytes = library.dirBytes(library.trashDir()); } catch (e) {}
    return { dir: library.trashDir(), bytes };
  });
  ipcMain.handle('cache:emptyTrash', () => kernel.cacheEmptyTrash());
  ipcMain.handle('cache:openTrash', () => {
    const d = library.trashDir();
    try { fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } catch (e) {}
    return d;
  });

  /* ---------- 桌面常驻 ---------- */
  ipcMain.handle('tray:refresh', () => { rebuildTrayMenu(); return true; });
  ipcMain.handle('tray:hide', () => {
    if (win && !win.isDestroyed()) win.hide();
    return true;
  });
  ipcMain.handle('win:show', () => { showMainWindow(); return true; });
  ipcMain.handle('win:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); return true; });
  ipcMain.handle('app:quit', () => { quitApp(); return true; });

  /* ---------- 其它 ---------- */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    dataRoot: paths.dataRoot(),
    logs: log.dirPath(),
  }));
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:/.test(String(url))) shell.openExternal(String(url));
    return true;
  });
  ipcMain.handle('app:showItem', (_e, p) => {
    if (p && fs.existsSync(String(p))) shell.showItemInFolder(String(p));
    return true;
  });
}

/* ================= 生命周期 ================= */
registerIpc();

/** 真退出：托盘菜单、app:quit、二次启动的「退出」都走这里 */
function quitApp() {
  quitting = true;
  unregisterWakeHotkey();
  try { store.flushAll(); } catch (e) {}
  try { log.info('main', '==== 智博X 退出（用户主动） ===='); log.flush(); } catch (e) {}
  destroyTray();
  app.quit();
}

/* 单实例：第二次双击只把已有窗口拉到前台，不再起第二套内核 */
const gotLock = app.requestSingleInstanceLock ? app.requestSingleInstanceLock() : true;
if (!gotLock) {
  /* 关键：第二个实例必须在**内核启动之前**就死掉。
   * 用 app.quit() 只发一个异步退出请求，whenReady 照样会跑完 —— 那就是「幽灵实例」：
   * 它会把 hls 端口、离线库扫描、store 初始化（含 state/session.json）再跑一遍，
   * 用户看到的就是「双击图标 → 闪一下 → 什么也没发生」，还会把自己的登录态搅乱。
   * app.exit(0) 是同步硬退出，不留任何尾巴。 */
  early('单实例锁未获得（已有实例在跑），直接退出');
  try { log.info('main', '单实例锁未获得，本次启动直接退出'); log.flush(); } catch (e) {}
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    log.info('main', '检测到二次启动，激活已有窗口 argv=' + JSON.stringify(argv || []));
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!gotLock) return;              // 幽灵实例不启动内核、不建窗口、不碰 store
  /* zbfile:// 协议：把本地 mp4 喂给 <video> */
  protocol.handle('zbfile', async (req) => {
    try {
      const u = new URL(req.url);
      // 标准 scheme 下 host 会被小写化、反斜杠会被改写，
      // 所以路径用 base64url 编在 pathname 里，避免任何字符被 Chromium 规范化。
      if (process.env.ZB_PROTO_DEBUG) {
        try { fs.appendFileSync(process.env.ZB_PROTO_DEBUG, 'REQ ' + req.url + ' | pathname=' + u.pathname + ' | host=' + u.hostname + '\n'); } catch (e) {}
      }
      // 标准 scheme 会把 // 后面的第一段当 host 并强制小写，
      // 所以路径用**小写十六进制**编码：哪怕被当成 host 也完全无损。
      let tok = u.hostname || '';
      if (!tok) tok = u.pathname.replace(/^\//, '');
      tok = tok.replace(/\/$/, '');
      if (!tok) return new Response('empty path', { status: 400 });
      if (!/^[0-9a-fA-F]+$/.test(tok)) return new Response('bad token', { status: 400 });
      const p = Buffer.from(tok, 'hex').toString('utf8');
      if (!p) return new Response('empty path', { status: 400 });
      let st = null;
      try { st = fs.statSync(p); } catch (e) {}
      if (!st || !st.isFile()) return new Response('not found', { status: 404 });

      const total = st.size;
      const range = req.headers.get('range') || req.headers.get('Range') || '';
      const m = /bytes=(\d*)-(\d*)/i.exec(range);
      if (m) {
        let start = m[1] === '' ? null : parseInt(m[1], 10);
        let end = m[2] === '' ? null : parseInt(m[2], 10);
        if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1; }
        if (start === null) start = 0;
        if (end === null || end >= total) end = total - 1;
        if (start > end) return new Response('bad range', { status: 416 });
        const len = end - start + 1;
        const fh = await fs.promises.open(p, 'r');
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        await fh.close();
        return new Response(buf, {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(len),
          },
        });
      }
      const data = await fs.promises.readFile(p);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(total) },
      });
    } catch (e) {
      return new Response('bad request: ' + ((e && e.message) || e), { status: 400 });
    }
  });

  try {
    await kernel.boot({ version: app.getVersion(), electron: process.versions.electron });
  } catch (e) {
    early('kernel boot FAIL ' + (e && e.stack || e));
  }

  /* 自检专用：ZB_SEED_SESSION=<session.json> 时把外部会话灌进本机库。
     正常启动不设这个变量，走的是「谁装谁登录」。 */
  if (process.env.ZB_SEED_SESSION) {
    try {
      if (!auth.hasToken()) {
        const raw = JSON.parse(fs.readFileSync(process.env.ZB_SEED_SESSION, 'utf8'));
        if (raw && raw.authToken) {
          auth.set({ authToken: raw.authToken, userToken: raw.userToken || '', profile: raw.profile || null });
          log.info('main', '自检播种会话 user=' + ((raw.profile && raw.profile.name) || '?'));
        }
      }
    } catch (e) { early('seed session FAIL ' + (e && e.message || e)); }
  }

  createWindow();
  createTray();
  registerWakeHotkey();
  syncPowerBlocker();
  // 内核 boot 完成后离线库统计才有值，再刷一次托盘提示
  setTimeout(() => { try { updateTrayTip(); rebuildTrayMenu(); } catch (e) {} }, 4000);

  /* 下载/封装进度实时推给渲染进程 */
  const notified = new Set();
  kernel.on('download', (t) => {
    if (win && !win.isDestroyed()) win.webContents.send('ev:download', t);
    // 完成通知只发一次；失败也发（让用户知道为什么没下完）
    if (t && (t.status === 'done' || t.status === 'error') && !notified.has(t.key + ':' + t.status)) {
      notified.add(t.key + ':' + t.status);
      if (t.status === 'done') {
        notify('缓存完成 · ' + (t.lessonName || t.lessonId),
          (t.courseName ? t.courseName + ' · ' : '') + '已可离线播放');
      } else {
        notify('下载失败 · ' + (t.lessonName || t.lessonId), String(t.error || '未知原因').slice(0, 120));
      }
      rebuildTrayMenu();
    }
    syncPowerBlocker();
    updateTrayTip();
  });
  kernel.on('remux', (t) => { if (win && !win.isDestroyed()) win.webContents.send('ev:remux', t); });
  kernel.on('auth', (t) => { if (win && !win.isDestroyed()) win.webContents.send('ev:auth', t); });
  // 登录失效：内核判定服务端已不认这张票据 → 让界面回登录页（这是 1.7 的核心体验分界：
  // 安装包不带任何人的账号，登录态属于用户，失效了就明说，不装作还能用）
  kernel.on('auth-expired', (x) => {
    try { log.warn('main', '登录失效，通知界面回登录页 :: ' + ((x && x.pathname) || '')); } catch (e) {}
    if (win && !win.isDestroyed()) win.webContents.send('ev:auth-expired', x || {});
    rebuildTrayMenu();
  });
  kernel.on('settings', (s) => {
    rebuildTrayMenu();
    syncPowerBlocker();
    if (win && !win.isDestroyed()) win.webContents.send('ev:settings', s);
  });
  log.onRecord((rec) => {
    if (win && !win.isDestroyed() && rec.level !== 'debug') win.webContents.send('ev:log', rec);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  /* 自动化验收：ZB_SELFTEST=<report.json> 时，等界面真起来再跑全链路自检 */
  if (process.env.ZB_SELFTEST) {
    if (win) {
      win.webContents.once('did-finish-load', () => {
        const delay = Number(process.env.ZB_SELFTEST_DELAY || 4500);
        setTimeout(() => { runSelfTest(process.env.ZB_SELFTEST).catch(() => {}); }, delay);
      });
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // 托盘还在 = 用户只是关了窗口，不是要退出内核
  let keep = false;
  try { keep = !!settings.get().trayOnClose && !!tray; } catch (e) {}
  if (keep) return;
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  unregisterWakeHotkey();
  if (awakeId) { try { powerSaveBlocker.stop(awakeId); } catch (e) {} awakeId = 0; }
  destroyTray();
  try { store.flushAll(); } catch (e) {}
  try { log.info('main', '==== 智博X 退出 ===='); log.flush(); } catch (e) {}
});