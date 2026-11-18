/* 智博X PC —— 渲染进程（内核版）
 * 职责只有三件：画界面、调 window.zhibo、把播放进度记下来。
 * 所有网络 / 解密 / 解复用 / 封装 / 缓存都在主进程内核里。 */
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtSize = (b) => {
  const n = Number(b) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
};
const fmtTime = (s) => {
  const n = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const ss = n % 60;
  if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
};

/* ================= 状态 ================= */
const state = {
  profile: null,
  guest: true,
  banners: [],
  homeCourses: [],
  allCourses: [],
  allPage: 1,
  allPageSize: 12,
  filterCategory: '',
  categories: new Map(),
  mineCourses: [],
  currentCourse: null,
  lessonProgress: new Map(), // lessonId -> {percent,pos,finished}
  libMap: new Map(), // 'courseId:lessonId' -> meta
  dlMap: new Map(), // key -> task
  imgCache: new Map(),
  view: 'home',
  prevView: 'home',
  hls: null,
  kp: null,
  player: null, // {lessonId,courseId,lessonName,courseName,sid,mode,streams,current,duration}
  saving: false,
  settings: null,
  logSince: 0,
  logTimer: null,
  logDay: '',
  /* 进度条拖动：拖动期间只画预览，松手才提交一次 seek（seek 在内核里是很重的操作） */
  seeking: false,
  lastSaveSec: -1,
  /* 课程目录的科目筛选 / 折叠状态；xxxFor 记住是哪门课，换课就重置 */
  groupFilter: '',
  groupCollapsed: {},
  groupFilterFor: '',
  groupCollapsedFor: '',
};

/* ================= 通用 ================= */
let toastTimer = null;
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
}

async function imgSrc(url) {
  if (!url) return null;
  let u = String(url).trim();
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:/.test(u)) return null;
  u = u.replace(/([^:])\/{2,}/g, '$1/');
  if (state.imgCache.has(u)) return state.imgCache.get(u);
  const p = window.zhibo.image(u)
    .then((r) => (r && r.ok && r.result && r.result.base64 ? 'data:' + r.result.mime + ';base64,' + r.result.base64 : null))
    .catch(() => null);
  state.imgCache.set(u, p);
  return p;
}

async function fillImg(imgEl, url) {
  const src = await imgSrc(url);
  if (src) { imgEl.src = src; imgEl.style.display = ''; }
  else imgEl.style.display = 'none';
}

function fmtPrice(p) {
  const n = Number(p);
  if (!n || n <= 0) return { text: '免费', zero: true };
  return { text: '¥' + (n / 100).toFixed(2).replace(/\.00$/, ''), zero: false };
}
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '');
const safeJson = (s) => { if (s == null) return null; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch { return null; } };

/* 统一拆壳：主进程返回 {ok,result} / {ok,error} */
async function unwrap(p) {
  const r = await p;
  if (!r) throw new Error('内核无响应');
  if (!r.ok) throw new Error(r.error || '调用失败');
  return r.result;
}

/* ================= 认证 ================= */
function showLogin() {
  $('loginView').hidden = false;
  $('appView').hidden = true;
  /* 回登录页一律落在「验证码登录」这一栏：密码登录有 5 次错锁 15 分钟的风险，
   * 不能让用户一睁眼就站在那条路上。 */
  try { setLoginMode('code'); } catch (e) {}
}
function showApp() {
  $('loginView').hidden = true;
  $('appView').hidden = false;
}

async function doLogin(e) {
  e.preventDefault();
  const phone = $('phoneInput').value.trim();
  const pwd = $('pwdInput').value;
  const errBox = $('loginError');
  const btn = $('loginBtn');
  errBox.hidden = true;

  if (!/^\d{6,15}$/.test(phone)) { errBox.textContent = '请输入正确的手机号'; errBox.hidden = false; return; }
  if (!pwd) { errBox.textContent = '请输入密码'; errBox.hidden = false; return; }

  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const r = await window.zhibo.auth.login(phone, pwd);
    if (!r || !r.ok) throw new Error((r && r.error) || '登录失败，请检查账号密码');
    const res = r.result || {};
    if (res.ok === false) {
      /* 不再笼统地说「登录失败」——登录失败的原因分得很清楚：
       *   ① 密码错/账号不存在：服务端直接给 message
       *   ② 密码对但服务端没下发能用的票据：noTicket，且原始响应已落盘
       *   ③ 网络问题：netError
       * 说清楚是哪一种，用户才知道该重输密码还是该反馈。 */
      if (res.noTicket) {
        /* 这一步失败时不要只说「登录失败」—— 密码是对的，缺的是「哪个字段能当票据」。
         * 现场已经落盘（login-diag-*.json：完整响应头+响应体+候选清单+每个候选的探测结果），
         * 界面上直接把入口给出来，用户点一下就能把文件发给开发者，不用再登一次。 */
        const keys = Array.isArray(res.keys) ? res.keys.join(' / ') : '';
        const t = '密码已通过，但服务端没有给出能用的会话票据' +
          (keys ? '（响应字段：' + keys + '）' : '') +
          (res.candidates ? '，已试 ' + res.candidates + ' 个候选值' : '') +
          '。诊断文件已保存，点下面的按钮打开日志目录。';
        logPush([{ level: 'error', scope: 'auth', text: '[auth] ' + t }]);
        errBox.textContent = t;
        errBox.hidden = false;
        if (res.diagFile) {
          const a = document.createElement('button');
          a.type = 'button';
          a.className = 'btn-mini';
          a.style.marginTop = '8px';
          a.textContent = '打开日志目录';
          a.onclick = () => { try { window.zhibo.log.openDir(); } catch (e) {} };
          errBox.appendChild(document.createElement('br'));
          errBox.appendChild(a);
        }
        btn.disabled = false; btn.textContent = '登 录';
        return;
      }
      throw new Error(res.message || res.error || ('登录失败（code=' + res.code + '）'));
    }
    await bootAfterLogin();
    toast('登录成功');
  } catch (err) {
    errBox.textContent = err.message || '登录失败';
    errBox.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
}

/* 登录方式切换：默认验证码（不消耗密码错误次数），密码只作备选 */
function setLoginMode(mode) {
  const code = mode !== 'pwd';
  $('codeForm').hidden = !code;
  $('loginForm').hidden = code;
  $('tabCode').classList.toggle('active', code);
  $('tabPwd').classList.toggle('active', !code);
  $('codeError').hidden = true;
  $('loginError').hidden = true;
  try { (code ? $('codePhone') : $('phoneInput')).focus(); } catch (e) {}
}

let codeTimer = null;

/* 发送验证码：60 秒倒计时，失败直接把服务端原话显示出来
   （「60秒内请勿重复发送」「发送失败，请稍后重试」这些都是可行动的提示） */
async function doSendCode() {
  const btn = $('sendCodeBtn');
  const err = $('codeError');
  const phone = $('codePhone').value.trim();
  err.hidden = true;
  if (!/^\d{6,15}$/.test(phone)) { err.textContent = '请输入正确的手机号'; err.hidden = false; return; }

  btn.disabled = true; btn.textContent = '发送中…';
  try {
    const r = await window.zhibo.auth.sendCode(phone);
    if (!r || !r.ok) throw new Error((r && r.error) || '发送失败');
    const res = r.result || {};
    if (res.ok === false) throw new Error(res.message || res.error || '发送失败');
    toast('验证码已发送');
    let left = 60;
    btn.textContent = left + ' 秒后重发';
    clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(codeTimer); codeTimer = null;
        btn.disabled = false; btn.textContent = '获取验证码';
      } else {
        btn.textContent = left + ' 秒后重发';
      }
    }, 1000);
    try { $('codeInput').focus(); } catch (e) {}
  } catch (e) {
    err.textContent = e.message || '发送失败';
    err.hidden = false;
    btn.disabled = false; btn.textContent = '获取验证码';
  }
}

async function doCodeLogin(e) {
  e.preventDefault();
  const phone = $('codePhone').value.trim();
  const code = $('codeInput').value.trim();
  const errBox = $('codeError');
  const btn = $('codeLoginBtn');
  errBox.hidden = true;

  if (!/^\d{6,15}$/.test(phone)) { errBox.textContent = '请输入正确的手机号'; errBox.hidden = false; return; }
  if (!/^\d{4,8}$/.test(code)) { errBox.textContent = '请输入短信里的验证码'; errBox.hidden = false; return; }

  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const r = await window.zhibo.auth.loginByCode(phone, code);
    if (!r || !r.ok) throw new Error((r && r.error) || '登录失败');
    const res = r.result || {};
    if (res.ok === false) throw new Error(res.message || res.error || ('登录失败（code=' + res.code + '）'));
    await bootAfterLogin();
    toast('登录成功');
  } catch (err) {
    errBox.textContent = err.message || '登录失败';
    errBox.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
}

async function logout() {
  await window.zhibo.auth.logout();
  state.profile = null;
  state.guest = true;
  state.mineCourses = [];
  state.currentCourse = null;
  state.imgCache.clear();
  toast('已退出登录');
  $('pwdInput').value = '';
  try { $('codeInput').value = ''; } catch (e) {}
  showLogin();
}

/* 服务端判定票据失效（内核 via main 转发 ev:auth-expired）。
   1.7 的立场：安装包里没有任何人的账号，登录态只属于当前使用者，没了就当场回登录页——
   而不是让播放、下载、课程列表各自报一句「未登录或token已失效」让用户猜。 */
let authExpiredShown = 0;
async function onAuthExpired(x) {
  const now = Date.now();
  if (now - authExpiredShown < 6000) return;   // 一屏错误只提示一次
  authExpiredShown = now;
  try { destroyHls(); } catch (e) {}
  try { if (state.player) { state.player = null; $('playerOverlay').hidden = true; } } catch (e) {}
  try { if (window.zhibo && window.zhibo.play) await window.zhibo.play.close(); } catch (e) {}
  state.profile = null;
  state.guest = true;
  state.mineCourses = [];
  state.currentCourse = null;
  state.lessonProgress.clear();
  state.imgCache.clear();
  const errBox = $('loginError');
  if (errBox) { errBox.textContent = '登录已过期，请重新登录（' + ((x && x.pathname) || '/profile') + '）'; errBox.hidden = false; }
  renderUser();
  showLogin();
  toast('登录已过期，请重新登录');
}

function renderUser() {
  const p = state.profile || {};
  $('userName').textContent = p.name || p.phoneNumber || '同学';
  $('userSub').textContent = state.guest ? '游客模式' : (p.phoneNumber ? String(p.phoneNumber).slice(-11) : '已登录');
  $('logoutBtn').hidden = state.guest;
  $('reloginBtn').hidden = !state.guest;
  const av = $('userAvatar');
  imgSrc(p.avatarUrl).then((src) => { av.src = src || ''; av.style.visibility = src ? 'visible' : 'hidden'; });
}

/* ================= 启动 ================= */
async function bootGuest() {
  state.guest = true;
  state.profile = null;
  showApp();
  renderUser();
  switchView('home');
  await Promise.all([loadBanners().catch(() => {}), loadHomeCourses().catch(() => {})]);
  $('mineList').innerHTML = '';
  const d = el('div', 'empty-box');
  d.appendChild(el('div', 'empty-title', '需要登录'));
  d.appendChild(el('div', 'empty-sub', '「我的课程」和播放需要有效登录；首页与选课中心可自由浏览。'));
  const b = el('button', 'btn-primary small', '去登录');
  b.addEventListener('click', showLogin);
  d.appendChild(b);
  $('mineList').appendChild(d);
}

async function bootAfterLogin() {
  state.guest = false;
  const sess = await window.zhibo.auth.session();
  state.profile = (sess && sess.profile) || null;
  if (!state.profile) {
    try {
      const r = await unwrap(window.zhibo.course.profile());
      if (r && r.code === 1 && r.data) state.profile = r.data;
    } catch (e) { /* 断网时用缓存资料 */ }
  }
  showApp();
  renderUser();
  switchView('home');
  await Promise.all([
    loadBanners().catch(() => {}),
    loadHomeCourses().catch(() => {}),
    loadMineCourses().catch(() => {}),
    refreshLibrary().catch(() => {}),
  ]);
}

/* ================= 离线状态 ================= */
// 主进程 api 层在断网时会给返回对象加 _offline:true。渲染层据此点亮顶部标签。
function markOffline(r) {
  if (!r || !r._offline) return;
  const tag = $('offlineTag');
  if (tag) tag.hidden = false;
  if (!state.offlineNotified) {
    state.offlineNotified = true;
    toast('网络不可用 · 已切换到本地缓存');
  }
}

/* ================= 首页 ================= */
async function loadBanners() {
  try {
    const r = await unwrap(window.zhibo.course.banners());
    const arr = Array.isArray(r && r.data) ? r.data : (Array.isArray(r) ? r : []);
    state.banners = arr.filter((x) => x && x.imageUrl);
    markOffline(r);
  } catch (e) { state.banners = []; }
  renderCarousel();
}

function renderCarousel() {
  const track = $('carouselTrack');
  const dots = $('carouselDots');
  track.innerHTML = ''; dots.innerHTML = '';
  if (!state.banners.length) { track.appendChild(el('div', 'carousel-slide skeleton')); return; }
  state.banners.forEach((b, i) => {
    const slide = el('div', 'carousel-slide');
    const img = el('img'); img.alt = 'banner ' + (i + 1);
    slide.appendChild(img); fillImg(img, b.imageUrl);
    track.appendChild(slide);
    const dot = el('i', i === 0 ? 'on' : '');
    dot.addEventListener('click', () => goSlide(i));
    dots.appendChild(dot);
  });
  startCarousel();
}
let carouselTimer = null, carouselIdx = 0;
function goSlide(i) {
  const n = state.banners.length; if (!n) return;
  carouselIdx = (i + n) % n;
  $('carouselTrack').style.transform = 'translateX(-' + (carouselIdx * 100) + '%)';
  [...$('carouselDots').children].forEach((d, k) => d.classList.toggle('on', k === carouselIdx));
}
function startCarousel() {
  clearInterval(carouselTimer);
  if (state.banners.length < 2) return;
  carouselTimer = setInterval(() => goSlide(carouselIdx + 1), 5000);
}

async function loadHomeCourses() {
  const box = $('homeCourses');
  box.innerHTML = '';
  for (let i = 0; i < 3; i++) box.appendChild(el('div', 'sk-card skeleton'));
  try {
    const r = await unwrap(window.zhibo.course.page(1, 8, ''));
    markOffline(r);
    state.homeCourses = ((r && r.data) || []).slice(0, 8);
  } catch (e) { state.homeCourses = []; }
  box.innerHTML = '';
  if (!state.homeCourses.length) {
    box.appendChild(el('div', 'muted', state.offlineNotified ? '当前离线，首页课程无本地缓存；「离线库」里的课时仍可播放。' : '暂无课程数据'));
    return;
  }
  state.homeCourses.forEach((c) => box.appendChild(courseCard(c)));
}

/* ================= 课程卡片 ================= */
function courseCard(c) {
  const card = el('div', 'course-card');
  const cover = el('div', 'cc-cover');
  cover.appendChild(el('div', 'cc-ph', (c.categoryName || '课').slice(0, 1)));
  const img = el('img'); img.alt = '';
  cover.appendChild(img);
  if (c.coverImageUrl) fillImg(img, c.coverImageUrl);
  if (c.isBought) cover.appendChild(el('span', 'cc-badge bought', '已购'));
  else if (c.courseTagName) cover.appendChild(el('span', 'cc-badge', c.courseTagName));
  else if (c.isFree) cover.appendChild(el('span', 'cc-badge free', '免费'));
  card.appendChild(cover);

  const body = el('div', 'cc-body');
  body.appendChild(el('div', 'cc-title', c.name || '未命名课程'));
  const meta = el('div', 'cc-meta');
  if (c.categoryName) meta.appendChild(el('span', '', c.categoryName));
  if (c.classHours) meta.appendChild(el('span', '', c.classHours + ' 课时'));
  body.appendChild(meta);

  const foot = el('div', 'cc-foot');
  const t = (c.teacherList && c.teacherList[0]) || null;
  if (t) {
    const tw = el('div', 'cc-teacher');
    const ti = el('img'); ti.alt = '';
    tw.appendChild(ti);
    if (t.avatarUrl) fillImg(ti, t.avatarUrl);
    tw.appendChild(el('span', '', t.name || '讲师'));
    foot.appendChild(tw);
  }
  const pr = fmtPrice(c.price);
  foot.appendChild(el('div', 'cc-price' + (pr.zero ? ' zero' : ''), pr.text));
  body.appendChild(foot);
  card.appendChild(body);
  card.addEventListener('click', () => openCourse(c));
  return card;
}

/* ================= 选课中心 ================= */
async function loadAllCourses(page) {
  const box = $('allCourses');
  state.allPage = page || 1;
  box.innerHTML = '';
  for (let i = 0; i < 6; i++) box.appendChild(el('div', 'sk-card skeleton'));
  try {
    const r = await unwrap(window.zhibo.course.page(state.allPage, state.allPageSize, state.filterCategory));
    state.allCourses = (r && r.data) || [];
  } catch (e) { state.allCourses = []; }
  state.allCourses.forEach((c) => { if (c.categoryId && c.categoryName) state.categories.set(String(c.categoryId), c.categoryName); });
  renderFilters();
  box.innerHTML = '';
  $('courseCount').textContent = state.allCourses.length ? '第 ' + state.allPage + ' 页 · ' + state.allCourses.length + ' 门' : '';
  if (!state.allCourses.length) { box.appendChild(el('div', 'muted', '没有符合条件的课程')); renderPager(); return; }
  state.allCourses.forEach((c) => box.appendChild(courseCard(c)));
  renderPager();
}
function renderFilters() {
  const bar = $('filterBar'); bar.innerHTML = '';
  const mk = (id, name) => {
    const b = el('button', 'chip' + (state.filterCategory === String(id) ? ' on' : ''), name);
    b.addEventListener('click', () => { state.filterCategory = String(id); loadAllCourses(1); });
    bar.appendChild(b);
  };
  mk('', '全部');
  [...state.categories.entries()].forEach(([id, name]) => mk(id, name));
}
function renderPager() {
  const p = $('coursePager'); p.innerHTML = '';
  const cur = state.allPage;
  const prev = el('button', '', '‹ 上一页');
  prev.disabled = cur <= 1;
  prev.addEventListener('click', () => loadAllCourses(cur - 1));
  p.appendChild(prev);
  p.appendChild(el('button', 'on', String(cur)));
  const next = el('button', '', '下一页 ›');
  next.disabled = state.allCourses.length < state.allPageSize;
  next.addEventListener('click', () => loadAllCourses(cur + 1));
  p.appendChild(next);
}

/* ================= 我的课程 ================= */
async function loadMineCourses() {
  const box = $('mineList');
  box.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const sk = el('div', 'mine-row');
    sk.appendChild(el('div', 'mine-cover skeleton'));
    sk.appendChild(el('div', 'mine-info skeleton'));
    box.appendChild(sk);
  }
  try {
    const r = await unwrap(window.zhibo.course.mine());
    markOffline(r);
    state.mineCourses = (r && r.data) || [];
  } catch (e) { state.mineCourses = []; }

  box.innerHTML = '';
  $('mineCount').textContent = state.mineCourses.length ? '共 ' + state.mineCourses.length + ' 门' : '';
  if (!state.mineCourses.length) { box.appendChild(el('div', 'muted', '还没有已购课程')); return; }
  state.mineCourses.forEach((c) => box.appendChild(mineRow(c)));
}

function mineRow(c) {
  const row = el('div', 'mine-row');
  const cover = el('div', 'mine-cover');
  const img = el('img'); img.alt = '';
  cover.appendChild(img);
  if (c.coverImageUrl) fillImg(img, c.coverImageUrl);
  row.appendChild(cover);

  const info = el('div', 'mine-info');
  info.appendChild(el('div', 'mine-name', c.name || '未命名课程'));
  const sub = el('div', 'mine-sub');
  if (c.categoryName) sub.appendChild(el('span', '', c.categoryName));
  if (c.classHours) sub.appendChild(el('span', '', c.classHours + ' 课时'));
  if (c.expiryDate) sub.appendChild(el('span', '', '有效期至 ' + fmtDate(c.expiryDate)));
  info.appendChild(sub);

  const tags = el('div', 'mine-tags');
  if (c.courseTagName) tags.appendChild(el('span', 'tag', c.courseTagName));
  tags.appendChild(el('span', 'tag' + (c.expired ? ' warn' : ' ok'), c.expired ? '已过期' : '有效'));
  info.appendChild(tags);
  row.appendChild(info);

  const go = el('button', 'mine-go', '继续学习');
  go.addEventListener('click', (e) => { e.stopPropagation(); openCourse(c); });
  row.appendChild(go);
  row.addEventListener('click', () => openCourse(c));
  return row;
}

/* ================= 课程详情 ================= */
async function openCourse(c) {
  if (c == null || typeof c !== 'object') {
    const id = String(c);
    c = state.allCourses.find((x) => String(x.id) === id) ||
        state.mineCourses.find((x) => String(x.id) === id) ||
        state.homeCourses.find((x) => String(x.id) === id) || { id: id };
  }
  switchView('detail');
  $('detailHero').innerHTML = '<div class="sk-card skeleton"></div>';

  // 1) 先走 courseFull：它会把「套课」的子课程拉回来摊平（线上集训营这类课
  //    在 /my/course/<id> 下 lessonList 是空的，课时全挂在子课程里）
  let d = c;
  try {
    const r = await unwrap(window.zhibo.course.full(c.id));
    markOffline(r);
    if (r && r.data) d = r.data;
    else if (r && r.lessonList) d = r;
  } catch (e) {
    // 2) 回落：只要课时能出来就行，先 my 版再公开版
    try {
      const r = await unwrap(window.zhibo.course.detail(c.id));
      markOffline(r);
      if (r && r.data) d = r.data;
      else if (r && r.lessonList) d = r;
    } catch (e1) {
      try {
        const r2 = await unwrap(window.zhibo.course.info(c.id));
        if (r2 && r2.data) d = r2.data;
      } catch (e2) {}
    }
  }
  // courseFull 没拿到分组时，就地用 lessonList / subCourseList 造一个，保证渲染层只有一条路
  if (!Array.isArray(d.groups)) {
    const own = Array.isArray(d.lessonList) ? d.lessonList : [];
    d.groups = own.length
      ? [{ id: String(d.id), name: '', classHours: d.classHours, lessons: own }]
      : [];
  }
  state.currentCourse = d;
  await renderDetail(d);
}

async function renderDetail(d) {
  const hero = $('detailHero');
  hero.innerHTML = '';

  const cover = el('div', 'dh-cover');
  const img = el('img'); img.alt = '';
  cover.appendChild(img);
  if (d.coverImageUrl) fillImg(img, d.coverImageUrl);
  hero.appendChild(cover);

  const main = el('div', 'dh-main');
  main.appendChild(el('div', 'dh-name', d.name || '未命名课程'));
  const tags = el('div', 'mine-tags');
  if (d.categoryName) tags.appendChild(el('span', 'tag', d.categoryName));
  if (d.courseTagName) tags.appendChild(el('span', 'tag', d.courseTagName));
  main.appendChild(tags);
  if (d.introduction) main.appendChild(el('div', 'dh-intro', d.introduction));

  const stats = el('div', 'dh-stats');
  const add = (label, val) => {
    const s = el('span');
    s.appendChild(el('b', '', String(val)));
    s.appendChild(document.createTextNode(' ' + label));
    stats.appendChild(s);
  };
  if (d.classHours) add('课时', d.classHours);
  if (d.salesVolume != null) add('人已报名', d.salesVolume);
  if (d.expiryDate) add('有效期至', fmtDate(d.expiryDate));
  const pr = fmtPrice(d.price);
  add('价格', pr.text);
  main.appendChild(stats);
  hero.appendChild(main);

  /* 目录：按科目分组渲染
   * 单课只有一组，平铺显示；套课（线上集训营这类）有 4 个子课程、几百课时，
   * 光在一长串前面插一行小字，视觉上仍然是一条长列表，科目分不清。所以改成：
   *   ① 顶部「科目筛选条」：全部科目 / 高数Ⅰ / 英语 / …，点一下只看该科目
   *   ② 每个科目一张卡片：卡片头显示科目名、课时数、已缓存进度条，点一下折叠
   */
  const groups = (Array.isArray(d.groups) ? d.groups : [])
    .filter((g) => g && Array.isArray(g.lessons));
  const total = groups.reduce((a, g) => a + g.lessons.length, 0);
  $('lessonCount').textContent = total ? total + ' 课时' : '';
  const list = $('lessonList');
  list.innerHTML = '';
  const bar = $('lessonFilterBar');
  if (bar) { bar.innerHTML = ''; bar.hidden = true; }

  if (!groups.length) {
    list.appendChild(el('div', 'lesson-row', '暂无课时'));
    return;
  }

  /* 进度：一次把所有分组的课时都查了，避免每组一次 IPC */
  const allIds = [];
  groups.forEach((g) => g.lessons.forEach((l) => allIds.push(String(l.id))));
  const progOf = async (cid) => {
    try {
      const pg = await window.zhibo.progress.course(String(cid), allIds);
      const m = new Map(Object.entries(pg || {}));
      m.forEach((v, k) => state.lessonProgress.set(k, v));
    } catch (e) {}
  };
  state.lessonProgress = new Map();
  for (const g of groups) await progOf(g.id);

  const multi = groups.length > 1;

  /* 换一门课就把筛选/折叠重置，别把上一门课的状态带过来 */
  const scope = String(d.id) + '|' + groups.map((g) => g.id).join(',');
  if (state.groupFilterFor !== scope) { state.groupFilterFor = scope; state.groupFilter = ''; }
  if (state.groupCollapsedFor !== scope) { state.groupCollapsedFor = scope; state.groupCollapsed = {}; }

  // 子课程名形如「线上集训营——高数Ⅰ」，筛选条和卡片头只显示破折号后面的科目名
  const subjectOf = (g) => {
    const n = String((g && g.name) || '子课程');
    const i = n.indexOf('——');
    return i >= 0 && i + 2 < n.length ? n.slice(i + 2) : n;
  };
  const cachedOf = (g) => g.lessons.reduce((n, L) => {
    const m = state.libMap.get(String(g.id) + ':' + String(L.id));
    return n + (m && (m.hasMp4 || m.status === 'ready') ? 1 : 0);
  }, 0);

  const secs = [];
  const applyFilter = () => {
    const f = String(state.groupFilter || '');
    secs.forEach((it) => { it.sec.hidden = !!f && String(it.gid) !== f; });
    if (bar) {
      [...bar.children].forEach((c) => {
        c.classList.toggle('on', String(c.dataset.gid || '') === f);
      });
    }
  };

  if (multi && bar) {
    bar.hidden = false;
    const mk = (label, n, gid) => {
      const c = el('button', 'lchip');
      c.appendChild(document.createTextNode(label));
      c.appendChild(el('span', 'lchip-n', String(n)));
      c.dataset.gid = gid == null ? '' : String(gid);
      c.addEventListener('click', () => {
        state.groupFilter = gid == null ? '' : String(gid);
        applyFilter();
      });
      return c;
    };
    bar.appendChild(mk('全部科目', total, null));
    groups.forEach((g) => bar.appendChild(mk(subjectOf(g), g.lessons.length, g.id)));
  }

  groups.forEach((g) => {
   // 该组的「课程身份」：套课里课时属于子课程 id，进度/离线库/下载都必须用它
   const gc = multi
     ? Object.assign({}, d, { id: String(g.id), name: (d.name ? d.name + ' · ' : '') + (g.name || '') })
     : d;

   const holder = multi ? el('div', 'lesson-group') : null;
   const body = el('div', multi ? 'lesson-group-body' : 'lesson-flat');

   if (multi) {
     const head = el('div', 'lesson-group-head');
     head.tabIndex = 0;
     head.appendChild(el('span', 'lgh-caret', '▾'));
     const nm = el('span', 'lgh-name', subjectOf(g));
     nm.title = g.name || '';
     head.appendChild(nm);
     const cs = cachedOf(g);
     head.appendChild(el('span', 'lgh-count',
       (g.lessons.length || 0) + ' 课时' + (cs ? ' · 已缓存 ' + cs : '')));
     const barWrap = el('div', 'lgh-bar');
     const barIn = document.createElement('i');
     barIn.style.width = (g.lessons.length ? Math.round((cs / g.lessons.length) * 100) : 0) + '%';
     barWrap.appendChild(barIn);
     head.appendChild(barWrap);
     if (state.groupCollapsed[g.id]) holder.classList.add('collapsed');
     const toggle = () => {
       const collapsed = !holder.classList.contains('collapsed');
       holder.classList.toggle('collapsed', collapsed);
       state.groupCollapsed[g.id] = collapsed;
     };
     head.addEventListener('click', toggle);
     head.addEventListener('keydown', (e) => {
       if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
     });
     holder.appendChild(head);
     holder.appendChild(body);
     list.appendChild(holder);
     secs.push({ sec: holder, gid: String(g.id) });
   } else {
     list.appendChild(body);
   }

   // 少数子课程服务端本身就是 0 课时（如「重点、难点精讲」里的英语/大学语文），
   // 只留一个组头会像渲染出错，补一行占位说明。
   if (!g.lessons.length) {
     const blank = el('div', 'lesson-row lesson-blank');
     blank.appendChild(el('div', 'lr-idx', '·'));
     blank.appendChild(el('div', 'lr-name', '该子课程暂无课时（服务端未上线内容）'));
     body.appendChild(blank);
     return;
   }

   g.lessons.forEach((L, i) => {
    const key = String(gc.id) + ':' + String(L.id);
    const lp = state.lessonProgress.get(String(L.id)) || null;
    const lm = state.libMap.get(key) || null;

    const row = el('div', 'lesson-row');
    row.appendChild(el('div', 'lr-idx', String(i + 1)));
    const nameWrap = el('div', 'lr-name');
    nameWrap.appendChild(document.createTextNode(L.name || '第 ' + (i + 1) + ' 节'));
    if (lp && lp.percent > 0.5) {
      const pg = el('span', 'lr-progress', lp.finished ? '已学完' : Math.round(lp.percent * 100) + '%');
      nameWrap.appendChild(pg);
    }
    row.appendChild(nameWrap);

    const isLive = String(L.type) === '2' || !!L.liveClassStartTime;
    row.appendChild(el('span', 'lr-type' + (isLive ? ' live' : ''), isLive ? '直播' : '录播'));

    if (lm) {
      const badge = el('span', 'lr-lib' + (lm.hasMp4 ? ' ok' : ''), lm.hasMp4 ? '离线可播' : (lm.downloaded || 0) + '/' + (lm.segCount || 0));
      row.appendChild(badge);
    }

    const dlBtn = el('button', 'lr-dl', lm ? '已缓存' : '缓存');
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startDownload(L, gc);
    });
    if (lm && lm.status === 'ready') { dlBtn.disabled = true; dlBtn.textContent = '已缓存'; }
    row.appendChild(dlBtn);

    const offlineCapable = !!(lm && (lm.hasMp4 || (lm.downloaded > 0)));
    const b = el('button', 'lr-play', offlineCapable ? '离线播放' : '播放');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      // 已缓存 → 强制离线（不走网络）；否则正常在线播放
      playLesson(L, gc, offlineCapable ? { forceLocal: true } : null);
    });
    row.appendChild(b);

    row.addEventListener('click', () => playLesson(L, gc));
    body.appendChild(row);
   });
  });

  applyFilter();
}

/* ================= 离线库 ================= */
/* 离线库索引刷新。
 *
 * 老实现是「谁想刷就直接 await library.scan()」，而 scan 会遍历整个 library 目录并写一条 INFO 日志。
 * 下载完成那一刻（download 事件 + remux 事件 + 通知 + 托盘刷新）会同时触发七八处，
 * 用户日志里 20:15:47 那 200 多行「离线库扫描」风暴就是这么来的，还会和主进程写 meta 抢文件。
 *
 * 现在改成单飞 + 最小间隔：并发调用共用同一个 Promise，短时间内重复请求直接复用上次结果。 */
let _libFlight = null;
let _libAt = 0;
const LIB_MIN_GAP = 800;   // ms

function refreshLibrary(opts) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (_libFlight) return _libFlight;                       // 已有一次在跑 → 共用
  if (!force && now - _libAt < LIB_MIN_GAP) return Promise.resolve(state.libMap);  // 太密 → 直接复用
  _libAt = now;
  _libFlight = (async () => {
    try {
      const arr = await window.zhibo.library.scan();
      state.libMap = new Map();
      (arr || []).forEach((m) => state.libMap.set(String(m.courseId) + ':' + String(m.lessonId), m));
      let ready = 0;
      (arr || []).forEach((m) => { if (m.status === 'ready') ready++; });
      $('libDot').hidden = ready === 0;
      $('libDot').textContent = ready ? String(ready) : '';
    } catch (e) { state.libMap = new Map(); }
    finally { _libFlight = null; }
    return state.libMap;
  })();
  return _libFlight;
}

async function renderLibrary() {
  await refreshLibrary({ force: true });
  const box = $('libList');
  box.innerHTML = '';
  const arr = [...state.libMap.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  try {
    const u = await window.zhibo.library.usage();
    $('libUsage').textContent = u ? (u.lessons || 0) + ' 课时 · ' + fmtSize(u.bytes || 0) : '';
  } catch (e) { $('libUsage').textContent = ''; }

  if (!arr.length) {
    box.appendChild(el('div', 'muted', '离线库还是空的。在课程目录里点「缓存」，或点右上角「全部缓存」。'));
    return;
  }
  arr.forEach((m) => {
    const row = el('div', 'lib-row');
    const left = el('div', 'lib-left');
    left.appendChild(el('div', 'lib-name', m.lessonName || ('第 ' + m.lessonId + ' 节')));
    left.appendChild(el('div', 'lib-sub', (m.courseName || '') + ' · ' + (m.definition || '') +
      ' · ' + (m.hasMp4 ? 'MP4 ' + fmtSize(m.mp4Bytes) : '分片 ' + fmtSize(m.bytes))));
    row.appendChild(left);

    const st = el('div', 'lib-state ' + (m.status || ''));
    st.textContent = m.status === 'ready' ? '就绪' : m.status === 'partial' ? (m.downloaded || 0) + '/' + (m.segCount || 0) : (m.status || '');
    row.appendChild(st);

    const hasSegs = (m.downloaded || 0) > 0;
    const play = el('button', 'btn-mini', m.hasMp4 ? '播放 MP4' : '播放');
    play.title = m.hasMp4 ? '直接读取本地 full.mp4（zbfile 协议）' : '用本机分片现场封装后播放';
    play.addEventListener('click', () => {
      playLesson({ id: m.lessonId, name: m.lessonName }, { id: m.courseId, name: m.courseName }, { forceLocal: true });
    });
    row.appendChild(play);

    if (hasSegs) {
      const segPlay = el('button', 'btn-mini', '分片播放');
      segPlay.title = '完全跳过 MP4，用离线分片走自研 MSE 内核（断网时的主通路）';
      segPlay.addEventListener('click', () => {
        playLesson({ id: m.lessonId, name: m.lessonName }, { id: m.courseId, name: m.courseName },
          { forceLocal: true, preferSegs: true });
      });
      row.appendChild(segPlay);
    }

    if (!m.hasMp4 && m.downloaded === m.segCount && m.segCount > 0) {
      const rm = el('button', 'btn-mini', '封装 MP4');
      rm.addEventListener('click', async () => {
        rm.disabled = true; rm.textContent = '封装中…';
        try { await unwrap(window.zhibo.library.remux(m.courseId, m.lessonId, false)); toast('封装完成'); }
        catch (e) { toast('封装失败：' + e.message); }
        renderLibrary();
      });
      row.appendChild(rm);
    }

    const del = el('button', 'btn-mini danger', '移除');
    del.addEventListener('click', async () => {
      if (!confirm('移除《' + (m.lessonName || m.lessonId) + '》的本地缓存？（会归档到回收目录，可恢复）')) return;
      await window.zhibo.library.remove(m.courseId, m.lessonId, false);
      toast('已归档到回收目录');
      renderLibrary();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

/* ================= 下载中心 ================= */
function taskRow(t) {
  const row = el('div', 'dl-row');
  const left = el('div', 'dl-left');
  left.appendChild(el('div', 'dl-name', (t.courseName ? t.courseName + ' · ' : '') + (t.lessonName || '')));
  const sub = el('div', 'dl-sub');
  sub.textContent = t.status === 'done' || t.status === 'ready' ? '已完成'
    : t.status === 'error' ? ('失败：' + (t.error || ''))
    : (t.done || 0) + '/' + (t.total || 0) + ' 分片 · ' + fmtSize(t.bytes) +
      (t.speed ? ' · ' + fmtSize(t.speed) + '/s' : '') + (t.etaSec ? ' · 剩余 ' + fmtTime(t.etaSec) : '');
  left.appendChild(sub);
  row.appendChild(left);

  const pct = t.total ? Math.min(100, ((t.done || 0) / t.total) * 100) : 0;
  const bar = el('div', 'dl-bar');
  const fill = el('div', 'dl-fill');
  fill.style.width = pct.toFixed(1) + '%';
  bar.appendChild(fill);
  row.appendChild(bar);

  const acts = el('div', 'dl-acts');
  if (t.status === 'downloading' || t.status === 'queued') {
    const b = el('button', 'btn-mini', '暂停');
    b.addEventListener('click', () => window.zhibo.download.pause(t.key));
    acts.appendChild(b);
  } else if (t.status === 'paused' || t.status === 'error') {
    const b = el('button', 'btn-mini', '继续');
    b.addEventListener('click', () => window.zhibo.download.resume(t.key));
    acts.appendChild(b);
  }
  const c = el('button', 'btn-mini danger', '取消');
  c.addEventListener('click', async () => {
    if (!confirm('取消并删除已下载的分片？')) return;
    await window.zhibo.download.cancel(t.key, true);
    renderDownloads();
  });
  acts.appendChild(c);
  row.appendChild(acts);
  return row;
}

async function renderDownloads() {
  let arr = [];
  try { arr = (await window.zhibo.download.list()) || []; } catch (e) { arr = []; }
  state.dlMap = new Map(arr.map((t) => [t.key, t]));
  const box = $('dlList');
  box.innerHTML = '';
  const active = arr.filter((t) => t.status === 'downloading' || t.status === 'queued').length;
  $('dlDot').hidden = active === 0;
  $('dlDot').textContent = active ? String(active) : '';
  $('dlSummary').textContent = arr.length ? (arr.length + ' 个任务 · ' + active + ' 个进行中') : '';
  if (!arr.length) { box.appendChild(el('div', 'muted', '暂无下载任务')); return; }
  arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((t) => box.appendChild(taskRow(t)));
}

function patchTask(t) {
  state.dlMap.set(t.key, t);
  if (state.view === 'downloads') renderDownloads();
  const active = [...state.dlMap.values()].filter((x) => x.status === 'downloading' || x.status === 'queued').length;
  $('dlDot').hidden = active === 0;
  $('dlDot').textContent = active ? String(active) : '';
}

/* ================= 下载动作 ================= */
async function startDownload(lesson, course) {
  try {
    const r = await unwrap(window.zhibo.download.start({
      courseId: String(course.id),
      lessonId: String(lesson.id),
      lessonName: lesson.name || '',
      courseName: course.name || '',
      streamIndex: 0,
    }));
    toast('已加入下载队列');
    if (r && r.key) state.dlMap.set(r.key, r);
    renderDownloads();
  } catch (e) { toast('加入队列失败：' + e.message); }
}

async function downloadCourseAll() {
  const d = state.currentCourse;
  if (!d) return;
  // 套课的课时挂在子课程（groups）里，顶层 lessonList 是空的；
  // 直接看 lessonList 会让「全部缓存」在套课上直接报「没有可缓存的课时」。
  const groups = (Array.isArray(d.groups) ? d.groups : []).filter((g) => g && Array.isArray(g.lessons));
  const jobs = [];
  if (groups.length > 1) {
    const f = String(state.groupFilter || '');
    groups.forEach((g) => {
      if (f && String(g.id) !== f) return;   // 只缓存当前筛选的科目
      g.lessons.forEach((L) => jobs.push({ cid: String(g.id), cname: (d.name ? d.name + ' · ' : '') + (g.name || ''), L }));
    });
  } else if (groups.length === 1) {
    groups[0].lessons.forEach((L) => jobs.push({ cid: String(d.id), cname: d.name || '', L }));
  } else if (Array.isArray(d.lessonList)) {
    d.lessonList.forEach((L) => jobs.push({ cid: String(d.id), cname: d.name || '', L }));
  }
  if (!jobs.length) { toast('没有可缓存的课时'); return; }
  toast('正在加入 ' + jobs.length + ' 个课时…');
  let n = 0;
  for (const j of jobs) {
    const key = j.cid + ':' + String(j.L.id);
    const lm = state.libMap.get(key);
    if (lm && lm.status === 'ready') continue;
    try {
      await window.zhibo.download.start({
        courseId: j.cid, lessonId: String(j.L.id),
        lessonName: j.L.name || '', courseName: j.cname, streamIndex: 0,
      });
      n++;
    } catch (e) { /* 单节失败不影响整体 */ }
  }
  toast('已加入 ' + n + ' 个课时');
  switchView('downloads');
  renderDownloads();
}

async function resumeUnfinished() {
  const arr = [...state.libMap.values()].filter((m) => m.status === 'partial' || m.status === 'paused');
  if (!arr.length) { toast('没有未完成的缓存任务'); return; }
  for (const m of arr) {
    try {
      await window.zhibo.download.start({
        courseId: m.courseId, lessonId: m.lessonId,
        lessonName: m.lessonName, courseName: m.courseName, streamIndex: 0,
      });
    } catch (e) {}
  }
  toast('已恢复 ' + arr.length + ' 个任务');
  switchView('downloads');
  renderDownloads();
}

/* ================= 播放器 ================= */
const V = () => $('videoEl');

/* 进度条只画 UI，不碰 video —— 拖动时每帧写 video.currentTime 会反复打断内核
 * （每次 seek 都要 abort 在途请求、清空 SourceBuffer、重下目标分片），
 * 几十次/秒地这么干就是「一拖就卡死」。 */
function paintSeek(t, dur) {
  const d = Number(dur) || 0;
  const cur = Math.min(Math.max(0, Number(t) || 0), d || Number(t) || 0);
  $('tCur').textContent = fmtTime(cur);
  if (d) $('tDur').textContent = fmtTime(d);
  const pct = d ? (cur / d) * 100 : 0;
  $('seekFill').style.width = pct.toFixed(2) + '%';
  $('seekKnob').style.left = pct.toFixed(2) + '%';
}

/* 真正提交一次跳转：内核在跑就走内核 seek（它会按目标分片续传），
 * 本地 MP4 / hls.js 才直接写 video.currentTime。 */
function doSeek(t) {
  const v = V();
  const dur = v.duration || 0;
  const target = Math.min(Math.max(0, Number(t) || 0), dur ? Math.max(0, dur - 0.05) : Math.max(0, Number(t) || 0));
  const kp = state.kp;
  let via = 'video';
  if (kp && !kp.destroyed && typeof kp.seek === 'function') {
    via = 'kernel';
    try { kp.seek(target); } catch (e) { try { v.currentTime = target; } catch (x) {} }
  } else {
    try { v.currentTime = target; } catch (e) {}
  }
  paintSeek(target, dur);
  return via;
}

function destroyHls() {
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  if (state.kp) { try { state.kp.destroy(); } catch (e) {} state.kp = null; }
}

function setCover(txt, show) {
  $('playerCoverTxt').textContent = txt || '';
  $('playerCover').hidden = !show;
}

async function playLesson(lesson, course, opts) {
  const o = opts || {};
  const overlay = $('playerOverlay');
  overlay.hidden = false;
  $('playerTitle').textContent = (course && course.name ? course.name + ' · ' : '') + (lesson.name || '');
  $('playerFoot').innerHTML = '';
  setCover('正在解析播放地址…', true);

  const v = V();
  v.pause(); destroyHls(); v.removeAttribute('src'); v.load();

  state.player = {
    lessonId: String(lesson.id), courseId: String(course.id),
    lessonName: lesson.name || '', courseName: course.name || '',
    sid: null, mode: null, streams: [], current: 0, duration: 0,
  };

  let r;
  try {
    r = await unwrap(window.zhibo.play.open({
      courseId: state.player.courseId, lessonId: state.player.lessonId,
      lessonName: state.player.lessonName, courseName: state.player.courseName,
      streamIndex: 0,
      forceLocal: !!o.forceLocal,
      preferSegs: !!o.preferSegs,
    }));
  } catch (e) {
    setCover('播放失败：' + e.message, true);
    return;
  }

  state.player.sid = r.sid || null;
  state.player.mode = r.mode || 'stream';
  state.player.streams = r.streams || [];
  state.player.current = r.current || 0;
  state.player.duration = r.duration || 0;

  const badgeMap = {
    file: { txt: '离线 · MP4', cls: 'pbadge offline' },
    local: { txt: '离线 · 分片', cls: 'pbadge offline' },
    stream: { txt: '在线 · 内核', cls: 'pbadge' },
    partial: { txt: '部分缓存', cls: 'pbadge offline' },
  };
  const bd = badgeMap[r.mode] || { txt: '在线', cls: 'pbadge' };
  $('playerBadge').textContent = bd.txt;
  $('playerBadge').className = bd.cls;

  /* 清晰度下拉 */
  const q = $('qSel'); q.innerHTML = '';
  if (state.player.streams.length > 1 && r.mode !== 'file') {
    state.player.streams.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = s.label || (s.height + 'P');
      if (i === state.player.current) o.selected = true;
      q.appendChild(o);
    });
    q.hidden = false;
  } else q.hidden = true;

  state.player.engine = r.engine || null;

  /* 恢复进度：作为 attachSrc 的起点，内核会直接 seek 到该分片而不是从头拉 */
  let startAt = 0;
  const resumeOn = S().resumePlay !== false;
  try {
    if (resumeOn) {
      const pg = await window.zhibo.progress.get(state.player.courseId, state.player.lessonId);
      const dur = r.duration || (r.engine && r.engine.timelineTotal) || 0;
      if (pg && pg.pos > 5 && (!dur || pg.pos < dur - 8)) {
        startAt = pg.pos;
        toast('已续播到 ' + fmtTime(pg.pos));
      }
    }
  } catch (e) {}

  attachSrc(r, startAt);

  /* 底部信息 */
  const foot = $('playerFoot');
  const bar = el('div', 'player-meta');
  const ipcUsed = !!(r.engine && r.engine.ipcBase && window.zhibo && window.zhibo.play && typeof window.zhibo.play.fetch === 'function');
  const engTxt = r.mode === 'file' ? '本地缓存直读'
    : (r.engine ? '自研 MSE 内核 · ' + r.engine.codec + ' ' + r.engine.width + 'x' + r.engine.height +
        (ipcUsed ? ' · IPC 直连' : ' · 本机流')
      : '内置内核流式封装（HLS 兼容模式）');
  bar.appendChild(el('span', 'player-info',
    '时长 ' + fmtTime(state.player.duration || r.duration) + ' · ' + engTxt +
    (r.segCount ? ' · ' + r.segCount + ' 分片' : '')));
  foot.appendChild(bar);
}

/**
 * 把内核设置里的播放偏好套到 video 元素上（倍速 / 音量 / 静音 / 自动播放）。
 * 每次挂源、每次 ready 都调一次，保证「设置 → 播放器」这条链路是活的。
 */
function applyPlayPrefs(v) {
  const s = S();
  const rate = Number(s.prefRate) || 1;
  try { v.playbackRate = rate; } catch (e) {}
  const rsel = $('rateSel');
  if (rsel) rsel.value = String(rate);
  const vol = typeof s.volume === 'number' ? s.volume : 1;
  try { v.volume = Math.min(1, Math.max(0, vol)); } catch (e) {}
  const mm = !!s.muted || vol <= 0;
  v.muted = mm;
  $('btnMute').textContent = mm ? '🔇' : '🔊';
  const vr = $('volRange');
  if (vr && document.activeElement !== vr) vr.value = String(Math.round(vol * 100));
}

/**
 * 挂载播放源。优先级：
 *   1) 自研 MSE 内核（fMP4）—— 自己 appendBuffer，不依赖 hls.js
 *   2) HLS 兜底（编码不被 MSE 支持、或内核未就绪）
 *   3) zbfile 本地文件（离线 MP4）
 * @param {object} r play.open 的返回值
 * @param {number} startAt 续播起点（秒）
 */
function attachSrc(r, startAt) {
  const v = V();
  destroyHls();
  setCover('加载中…', true);
  const at = Math.max(0, Number(startAt) || 0);

  const onReady = () => {
    setCover('', false);
    applyPlayPrefs(v);
    if (at > 1) { try { v.currentTime = at; } catch (e) {} }
    if (S().autoPlay !== false) v.play().catch(() => {});
  };
  const onFail = (msg) => setCover('播放失败：' + msg, true);

  // ---- 1) 自研内核 ----
  const eng = r && r.engine;
  if (eng && window.KernelPlayer && typeof window.KernelPlayer.create === 'function') {
    if (window.KernelPlayer.isSupported(eng.codec)) {
      const meta = {
        codec: eng.codec,
        segCount: eng.segDurs ? eng.segDurs.length : (r.segCount || 0),
        segDurs: eng.segDurs || [],
        duration: eng.timelineTotal || r.duration || 0,
        width: eng.width || 0, height: eng.height || 0,
        sampleRate: eng.sampleRate || 0, channels: eng.channels || 0,
      };
      const autoOn = S().autoPlay !== false;
      applyPlayPrefs(v);
      // 传输层选择：优先 IPC 直连（不经本机端口，端口被占/服务未起也能播）；
      // 通道缺失时退回本机 HTTP。
      const ipcOk = !!(eng.ipcBase && window.zhibo && window.zhibo.play && typeof window.zhibo.play.fetch === 'function');
      const useBase = ipcOk ? eng.ipcBase : eng.base;
      const kp = window.KernelPlayer.create(v, {
        base: useBase,
        meta,
        startTime: at,
        autoplay: autoOn,
        onEvent: (name, data) => {
          if (name === 'error') {
            // 内核自认为挂了 → 回退 HLS（若还有可用地址）
            if (r.url) { try { kp.destroy(); } catch (e) {} state.kp = null; attachHlsFallback(r, at); }
            else onFail((data && data.message) || '内核错误');
          } else if (name === 'playing') {
            setCover('', false);
          } else if (name === 'waiting' || name === 'buffering') {
            // 边下边播时短暂缓冲，不遮盖画面，只更新封面提示
            if (!v.currentTime) setCover('缓冲中…', true);
          }
        },
      });
      if (kp) {
        state.kp = kp;
        kp.ready.then(() => {
          setCover('', false);
          applyPlayPrefs(v);   // 内核建流后 video 元素属性会被重置，这里再套一次
          if (!autoOn) { try { v.pause(); } catch (e) {} }
        }).catch((e) => {
          onFail((e && e.message) || '内核启动失败');
        });
        return;
      }
    }
    // 编解码不被 MSE 支持 → 静默降级
  }

  // ---- 2) 本地文件 ----
  if (r && r.mode === 'file') {
    v.src = r.url;
    v.addEventListener('loadedmetadata', () => { setCover('', false); applyPlayPrefs(v); if (at > 1) { try { v.currentTime = at; } catch (e) {} } if (S().autoPlay !== false) v.play().catch(() => {}); }, { once: true });
    v.addEventListener('error', () => onFail(v.error ? v.error.message : '未知'), { once: true });
    return;
  }

  // ---- 3) HLS 兜底 ----
  attachHlsFallback(r, at);
}

function attachHlsFallback(r, at) {
  const v = V();
  if (!r || !r.url) { setCover('播放失败：没有可用的播放地址', true); return; }
  if (!window.Hls || !window.Hls.isSupported()) {
    v.src = r.url;
    v.addEventListener('loadedmetadata', () => {
      setCover('', false);
      applyPlayPrefs(v);
      if (at > 1) { try { v.currentTime = at; } catch (e) {} }
      if (S().autoPlay !== false) v.play().catch(() => {});
    }, { once: true });
    v.addEventListener('error', () => setCover('播放器报错：' + (v.error ? v.error.message : '未知'), true), { once: true });
    return;
  }
  const hls = new window.Hls({
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 30,
    xhrSetup: (xhr) => { xhr.withCredentials = false; },
  });
  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    setCover('', false);
    applyPlayPrefs(v);
    if (at > 1) {
      v.addEventListener('loadedmetadata', function once() {
        v.removeEventListener('loadedmetadata', once);
        try { v.currentTime = at; } catch (e) {}
      }, { once: true });
    }
    if (S().autoPlay !== false) v.play().catch(() => {});
  });
  hls.on(window.Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
      try { hls.startLoad(); return; } catch (e) {}
    }
    setCover('播放错误：' + (data.details || data.type), true);
  });
  hls.loadSource(r.url);
  hls.attachMedia(v);
  state.hls = hls;
}

async function switchQuality(idx) {
  const p = state.player;
  if (!p) return;
  const v = V();
  const at = v.currentTime;
  const wasPlaying = !v.paused;
  setCover('切换清晰度…', true);
  try {
    const r = await unwrap(window.zhibo.play.open({
      courseId: p.courseId, lessonId: p.lessonId,
      lessonName: p.lessonName, courseName: p.courseName, streamIndex: idx,
    }));
    p.sid = r.sid || p.sid;
    p.current = r.current || idx;
    p.streams = r.streams || p.streams;
    attachSrc(r, at);
    if (!wasPlaying) setTimeout(() => { try { V().pause(); } catch (e) {} }, 600);
  } catch (e) { setCover('切换失败：' + e.message, true); }
}

async function closePlayer() {
  const p = state.player;
  if (p) {
    await saveProgress(true);
    if (p.sid) window.zhibo.play.close(p.sid);
  }
  destroyHls();
  const v = V();
  v.pause(); v.removeAttribute('src'); v.load();
  $('playerOverlay').hidden = true;
  state.player = null;
  if (state.view === 'detail') renderDetail(state.currentCourse);
  if (state.view === 'library') renderLibrary();
}

async function saveProgress(force) {
  const p = state.player;
  const v = V();
  if (!p || !v.duration || !isFinite(v.duration)) return;
  if (state.saving) return;
  if (state.seeking && !force) return;   // 拖动中不落盘，松手后由暂停/定时器补
  state.saving = true;
  try {
    await window.zhibo.progress.save(p.courseId, p.lessonId, v.currentTime, v.duration, {
      lessonName: p.lessonName, courseName: p.courseName,
    });
  } catch (e) {} finally { state.saving = false; }
}

/* ================= 播放器控件 ================= */
function bindPlayer() {
  const v = V();
  v.addEventListener('timeupdate', () => {
    const d = v.duration || 0;
    // 拖动中由指针位置决定画面，别被播放进度抢回去
    if (state.seeking) { $('tDur').textContent = fmtTime(d); return; }
    paintSeek(v.currentTime, d);
    // 每踏过一个 5 秒刻度才落盘一次（旧写法在同一个刻度里会连环触发）
    const sec = Math.floor(v.currentTime);
    if (sec !== state.lastSaveSec && sec % 5 === 0) {
      state.lastSaveSec = sec;
      saveProgress(false);
    }
  });
  v.addEventListener('progress', () => {
    const d = v.duration || 0;
    if (!d || !v.buffered.length) return;
    $('seekBuf').style.width = ((v.buffered.end(v.buffered.length - 1) / d) * 100).toFixed(2) + '%';
  });
  v.addEventListener('play', () => { $('btnPlay').textContent = '❚❚'; });
  v.addEventListener('pause', () => { $('btnPlay').textContent = '▶'; saveProgress(false); });
  v.addEventListener('ended', () => { $('btnPlay').textContent = '▶'; saveProgress(true); });

  $('btnPlay').addEventListener('click', () => {
    const vv = V();
    if (vv.paused) vv.play().catch(() => {}); else vv.pause();
  });

  const seek = $('seek');
  let dragPid = null;
  let dragTarget = 0;
  const ratioAt = (ev) => {
    const rect = seek.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  };
  // 拖动过程：只更新预览（进度条 + 时间文字），不碰 video
  const preview = (ev) => {
    const d = V().duration || 0;
    if (!d) return;
    dragTarget = ratioAt(ev) * d;
    paintSeek(dragTarget, d);
  };
  const endDrag = (commit) => {
    if (dragPid == null) return;
    const pid = dragPid;
    dragPid = null;
    try { seek.releasePointerCapture(pid); } catch (x) {}
    seek.classList.remove('dragging');
    state.seeking = false;
    if (commit) doSeek(dragTarget);
  };
  seek.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    if (!V().duration) return;
    dragPid = e.pointerId;
    state.seeking = true;
    seek.classList.add('dragging');
    try { seek.setPointerCapture(e.pointerId); } catch (x) {}
    preview(e);
    e.preventDefault();
  });
  seek.addEventListener('pointermove', (e) => {
    if (dragPid !== e.pointerId) return;
    preview(e);
  });
  seek.addEventListener('pointerup', (e) => {
    if (dragPid !== e.pointerId) return;
    preview(e);
    endDrag(true);
  });
  seek.addEventListener('pointercancel', (e) => {
    if (dragPid !== e.pointerId) return;
    endDrag(false);   // 拖到窗口外被取消：不提交，位置回到 actual
  });
  // 滚轮微调：一次 ±5s，也只提交一次
  seek.addEventListener('wheel', (e) => {
    const vv = V();
    if (!vv.duration) return;
    e.preventDefault();
    const step = e.deltaY > 0 ? 5 : -5;
    doSeek((vv.currentTime || 0) + step);
  }, { passive: false });

  $('rateSel').addEventListener('change', () => {
    const rate = Number($('rateSel').value) || 1;
    V().playbackRate = rate;
    patchSetting({ prefRate: rate });
  });
  $('qSel').addEventListener('change', () => switchQuality(Number($('qSel').value)));
  $('btnMute').addEventListener('click', () => {
    const vv = V(); vv.muted = !vv.muted;
    $('btnMute').textContent = vv.muted ? '🔇' : '🔊';
    patchSetting({ muted: vv.muted });
  });
  const vol = $('volRange');
  if (vol) {
    vol.addEventListener('input', () => {
      const vv = V();
      vv.volume = Math.min(1, Math.max(0, Number(vol.value) / 100));
      vv.muted = vv.volume === 0;
      $('btnMute').textContent = vv.muted ? '🔇' : '🔊';
    });
    // 拖动结束才落盘，避免每帧写一次设置
    vol.addEventListener('change', () => {
      const vv = V();
      patchSetting({ volume: vv.volume, muted: vv.muted });
    });
  }
  $('btnFull').addEventListener('click', () => {
    const stage = $('playerStage');
    if (!document.fullscreenElement) stage.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });
  $('playerClose').addEventListener('click', closePlayer);
  $('playerDlBtn').addEventListener('click', () => {
    const p = state.player;
    if (!p) return;
    startDownload({ id: p.lessonId, name: p.lessonName }, { id: p.courseId, name: p.courseName });
  });

  document.addEventListener('keydown', (e) => {
    if ($('playerOverlay').hidden) return;
    if (e.key === 'Escape') { closePlayer(); return; }
    if (e.key === ' ') { e.preventDefault(); $('btnPlay').click(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); doSeek((V().currentTime || 0) - 5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); doSeek((V().currentTime || 0) + 5); }
  });

  setInterval(() => { if (state.player && !V().paused) saveProgress(false); }, 10000);
  window.addEventListener('beforeunload', () => { saveProgress(true); });
}

/* ================= 日志 ================= */
// 原始日志行缓冲：[{seq,level,scope,text} 或 {text}]。过滤只对缓冲重绘，不丢历史。
const LOG_BUF_MAX = 6000;
function logReset() { state.logRaw = []; state.logSince = 0; }
function logPush(recs) {
  for (const r of recs) {
    state.logRaw.push(r);
    if (r && r.seq && r.seq > state.logSince) state.logSince = r.seq;
  }
  if (state.logRaw.length > LOG_BUF_MAX) state.logRaw.splice(0, state.logRaw.length - LOG_BUF_MAX);
}
function logTextOf(r) { return typeof r === 'string' ? r : (r.text || ''); }
function logRender() {
  const body = $('logBody');
  const follow = $('logFollow').checked;
  const showDebug = $('logDebug').checked;
  const kw = $('logFilter').value.trim().toLowerCase();
  const pinned = kw || !showDebug;   // 有过滤条件时不自动滚，方便看
  const out = [];
  let hidden = 0;
  for (const r of state.logRaw) {
    const t = logTextOf(r);
    if (!showDebug && r && r.level === 'debug') { hidden++; continue; }
    if (kw && !t.toLowerCase().includes(kw)) { hidden++; continue; }
    out.push(t);
  }
  body.textContent = out.join('\n');
  let stats = out.length + ' 行';
  if (hidden) stats += ' · 隐藏 ' + hidden;
  if (state.logRaw.length >= LOG_BUF_MAX) stats += ' · 仅保留最近 ' + LOG_BUF_MAX;
  $('logStats').textContent = stats;
  if (follow && !pinned) body.scrollTop = body.scrollHeight;
}

async function renderLogs() {
  try {
    const days = (await window.zhibo.log.days()) || [];
    const sel = $('logDay');
    const cur = $('logDay').value || '';
    sel.innerHTML = '';
    if (!days.length) {
      sel.appendChild(el('option', '', '（暂无日志文件）'));
    } else {
      days.forEach((d) => {
        const o = document.createElement('option');
        const day = d.day || d.name || String(d);
        o.value = day;
        o.textContent = day + (d.size ? ' · ' + fmtSize(d.size) : '');
        if (day === cur) o.selected = true;
        sel.appendChild(o);
      });
    }
  } catch (e) {}
  await pullLogs();
}

async function pullLogs() {
  try {
    const r = await window.zhibo.log.tail(state.logSince, 600);
    // 主进程 log:tail 直接返回记录数组 [{seq,t,level,scope,text}]
    const arr = Array.isArray(r) ? r : (r && Array.isArray(r.lines) ? r.lines : []);
    if (arr.length) logPush(arr);
  } catch (e) {}

  if (!state.logRaw.length) {
    try {
      const r2 = await window.zhibo.log.file($('logDay').value, 400);
      if (r2 && Array.isArray(r2.lines) && r2.lines.length) {
        // 历史文件没有 seq，只能整体载入；
        // 载入后把 logSince 设到当前最大 seq，避免下次 tail 重复叠加
        state.logRaw = r2.lines.map((t) => ({ text: t, level: lineLevel(t) }));
        const cur = await window.zhibo.log.tail(0, 1).catch(() => null);
        if (Array.isArray(cur) && cur.length) state.logSince = cur[cur.length - 1].seq || 0;
      }
    } catch (e) {}
  }
  logRender();
}

function lineLevel(t) {
  const m = /\]\s*\[([A-Z]+)\]/.exec(t) || /\[([A-Z]+)\][^\]]*$/.exec(t);
  return m ? m[1].toLowerCase() : 'info';
}

/* ================= 视图 ================= */
function switchView(v) {
  if (v !== 'detail' && v !== state.view) state.prevView = state.view;
  state.view = v;
  ['home', 'courses', 'mine', 'detail', 'library', 'downloads', 'settings', 'logs'].forEach((k) => {
    const p = $('pane-' + k);
    if (p) p.hidden = k !== v;
  });
  [...$('topNav').children].forEach((b) => {
    if (!b.dataset || !b.dataset.view) return;
    b.classList.toggle('active', b.dataset.view === v);
  });
  $('content').scrollTop = 0;

  if (v === 'courses' && !state.allCourses.length) loadAllCourses(1);
  if (v === 'mine' && !state.guest && !state.mineCourses.length) loadMineCourses();
  if (v === 'library') renderLibrary();
  if (v === 'downloads') renderDownloads();
  if (v === 'settings') renderSettings();
  if (v === 'logs') { logReset(); $('logBody').textContent = ''; renderLogs(); }

  clearInterval(state.logTimer);
  if (v === 'logs') state.logTimer = setInterval(pullLogs, 1200);
}

/* ================= 绑定 ================= */
function bind() {
  $('loginForm').addEventListener('submit', doLogin);
  $('codeForm').addEventListener('submit', doCodeLogin);
  $('sendCodeBtn').addEventListener('click', doSendCode);
  $('tabCode').addEventListener('click', () => setLoginMode('code'));
  $('tabPwd').addEventListener('click', () => setLoginMode('pwd'));
  $('guestBtn2').addEventListener('click', () => { showApp(); bootGuest(); });
  $('guestBtn').addEventListener('click', () => bootGuest());
  $('logoutBtn').addEventListener('click', () => logout());
  $('reloginBtn').addEventListener('click', showLogin);

  $('topNav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (!b || !b.dataset.view) return;
    switchView(b.dataset.view);
  });

  $('backBtn').addEventListener('click', () => switchView(state.prevView || 'home'));
  $('dlAllBtn').addEventListener('click', downloadCourseAll);
  $('dlResumeBtn').addEventListener('click', resumeUnfinished);
  $('libScanBtn').addEventListener('click', renderLibrary);
  $('dlCleanBtn').addEventListener('click', async () => {
    const arr = [...state.dlMap.values()].filter((t) => t.status === 'done' || t.status === 'ready');
    for (const t of arr) await window.zhibo.download.cancel(t.key, false);
    toast('已清理 ' + arr.length + ' 条记录');
    renderDownloads();
  });
  $('logOpenDirBtn').addEventListener('click', () => window.zhibo.log.openDir());
  $('logCopyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText($('logBody').textContent || '').then(() => toast('已复制'), () => toast('复制失败'));
  });
  $('logDay').addEventListener('change', async () => {
    const r = await window.zhibo.log.file($('logDay').value, 4000);
    state.logRaw = ((r && Array.isArray(r.lines)) ? r.lines : []).map((t) => ({ text: t, level: lineLevel(t) }));
    logRender();
  });
  $('logDebug').addEventListener('change', logRender);
  $('logFilter').addEventListener('input', logRender);

  document.querySelectorAll('[data-quick]').forEach((b) => {
    b.addEventListener('click', () => {
      const map = { study: '自习室', words: '猩子单词', checkin: '猩子打卡', shop: '猩子商城' };
      toast(map[b.dataset.quick] + ' · PC 端暂未开放，请在手机 App 使用');
    });
  });

  bindPlayer();
  bindSettings();

  window.zhibo.on('auth-expired', onAuthExpired);
  window.zhibo.on('download', patchTask);
  window.zhibo.on('remux', (t) => {
    if (t && t.status === 'done') toast('《' + (t.lessonName || '') + '》已封装为 MP4');
    refreshLibrary();
  });
  window.zhibo.on('log', (rec) => {
    if (!rec) return;
    // 只在本视图打开时累积，避免后台长时间跑把内存刷满
    if (state.view !== 'logs') return;
    logPush([rec]);
    if (state.logRaw.length && $('logFollow').checked) logRender();
  });
}


/* ================= 内核设置面板 ================= */
const S = () => state.settings || {};

/** 一个受控开关：读 settings → 写 DOM → 变更即 patch */
function bindSwitch(id, key) {
  const elx = $(id);
  if (!elx) return;
  elx.addEventListener('change', () => {
    patchSetting({ [key]: elx.checked });
  });
}

function bindNumber(id, key, transform) {
  const elx = $(id);
  if (!elx) return;
  const commit = () => {
    const raw = Number(elx.value);
    if (!isFinite(raw)) { paintSettings(); return; }
    patchSetting({ [key]: transform ? transform(raw) : raw });
  };
  elx.addEventListener('change', commit);
  elx.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
}

async function patchSetting(p) {
  try {
    const r = await window.zhibo.settings.patch(p);
    if (r && r.ok === false) { toast('设置失败：' + (r.error || '未知')); paintSettings(); return; }
    const res = r && r.result ? r.result : r;
    state.settings = (res && res.settings) || (await window.zhibo.settings.get());
    paintSettings();
    if (res && res.changed && res.changed.length) {
      $('setSaved').textContent = '已保存 · ' + new Date().toLocaleTimeString();
      // 影响面较大的项给一句人话反馈
      if (res.changed.indexOf('offline') >= 0) {
        toast(state.settings.offline ? '已开启强制离线 · 只用本地缓存' : '已关闭强制离线 · 恢复联网');
      } else if (res.changed.indexOf('cacheLimitMB') >= 0) {
        const n = state.settings.cacheLimitMB;
        toast(n ? '离线库上限 ' + n + ' MB' : '离线库不限容量');
        refreshLibrary().catch(() => {});
      } else if (res.changed.indexOf('trayOnClose') >= 0) {
        toast(state.settings.trayOnClose ? '关窗口后将留在托盘继续运行' : '关窗口即退出程序');
      }
      window.zhibo.tray.refresh().catch(() => {});
    }
  } catch (e) { toast('设置失败：' + e.message); paintSettings(); }
}

/** 把 state.settings 铺到所有控件上 */
function paintSettings() {
  const s = S();
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v == null ? '—' : String(v); };
  const chk = (id, v) => { const e = $(id); if (e) e.checked = !!v; };
  const val = (id, v) => { const e = $(id); if (e && document.activeElement !== e) e.value = String(v); };

  chk('setOffline', s.offline);
  val('setNetConc', s.netConcurrency);
  val('setQueueConc', s.queueConcurrency);
  val('setSegConc', s.segConc ?? s.segConcurrency);
  chk('setAutoRemux', s.autoRemux);
  chk('setKeepAwake', s.keepAwakeWhileDownload);
  val('setCacheLimit', s.cacheLimitMB);
  val('setRate', s.prefRate);
  chk('setAutoPlay', s.autoPlay);
  chk('setResume', s.resumePlay);
  val('setVolume', Math.round((Number(s.volume) || 0) * 100));
  chk('setTrayOnClose', s.trayOnClose);
  chk('setNotify', s.notifyOnDone);

  // 离线开关打开时，联网相关项灰掉（但保留可改，改完仍不生效）
  const off = !!s.offline;
  ['setNetConc', 'setQueueConc', 'setSegConc'].forEach((id) => {
    const e = $(id); if (e) e.disabled = off;
  });
}

/** 内核能力网格（真数据，不是装饰） */
async function paintKernelGrid() {
  const grid = $('setKernelGrid');
  if (!grid) return;
  let st = null;
  try { st = await window.zhibo.kernel.status(); } catch (e) { st = null; }
  if (!st) { grid.innerHTML = '<div class="k-cell warn"><b>内核</b><span>未就绪</span></div>'; return; }

  const cells = [];
  const cell = (label, value, cls, mono) => cells.push(
    '<div class="k-cell ' + (cls || '') + '"><b>' + label + '</b><span class="' + (mono ? 'mono' : '') + '">' + value + '</span></div>'
  );

  cell('播放内核', st.fmp4 ? 'fMP4 + MSE ✓' : '未就绪', st.fmp4 ? 'ok' : 'warn');
  cell('MP4 封装', st.remux ? '已加载 ✓' : '未加载', st.remux ? 'ok' : 'warn');
  cell('内核版本', 'v' + (st.version || '?' ) + ' / Electron ' + (st.electron || '?'), 'mono');
  cell('网络状态', st.offline ? '强制离线（拦截出网）' : (st.net && st.net.inflight ? ('联网 · ' + st.net.inflight + ' 请求在飞') : '联网 · 空闲'), st.offline ? '' : 'ok');
  cell('离线库', st.library ? ((st.library.bytes / 1048576).toFixed(1) + ' MB · ' + st.library.lessons + ' 节课') : '—');
  cell('下载任务', (() => {
    const dl = st.downloads || [];
    const act = dl.filter((t) => t.status === 'running' || t.status === 'queued').length;
    return act ? act + ' 个进行中 / ' + dl.length + ' 条记录' : (dl.length ? dl.length + ' 条记录 · 空闲' : '无');
  })());
  cell('数据根', st.dataRoot || '—', 'mono');
  cell('本地流服务', st.hlsBase || '未启动', 'mono');
  grid.innerHTML = cells.join('');
  $('setKernelVer').textContent = '设置文件 ' + (st.settingsFile || '—');
}

async function renderSettings() {
  try {
    state.settings = await window.zhibo.settings.get();
  } catch (e) { state.settings = null; }
  paintSettings();
  paintKernelGrid();

  // 存储占用 + 回收目录
  try {
    const u = await window.zhibo.library.usage();
    $('setUsage').textContent = u ? ((u.bytes / 1048576).toFixed(1) + ' MB · ' + u.lessons + ' 节课') : '—';
  } catch (e) { $('setUsage').textContent = '—'; }
  try {
    const t = await window.zhibo.cache.trash();
    const tr = t && t.result ? t.result : t;
    if (tr) {
      $('setTrashTxt').textContent = '回收目录占用 ' + ((tr.bytes || 0) / 1048576).toFixed(1) + ' MB；归档后可随时恢复，7 天后自动清理。';
    }
  } catch (e) {}
}

function bindSettings() {
  bindSwitch('setOffline', 'offline');
  bindSwitch('setAutoRemux', 'autoRemux');
  bindSwitch('setKeepAwake', 'keepAwakeWhileDownload');
  bindSwitch('setAutoPlay', 'autoPlay');
  bindSwitch('setResume', 'resumePlay');
  bindSwitch('setTrayOnClose', 'trayOnClose');
  bindSwitch('setNotify', 'notifyOnDone');

  bindNumber('setNetConc', 'netConcurrency');
  bindNumber('setQueueConc', 'queueConcurrency');
  bindNumber('setSegConc', 'segConcurrency');
  bindNumber('setCacheLimit', 'cacheLimitMB');
  bindNumber('setVolume', 'volume', (v) => Math.round(v) / 100);

  const rate = $('setRate');
  if (rate) rate.addEventListener('change', () => patchSetting({ prefRate: Number(rate.value) || 1 }));

  const reset = $('setResetBtn');
  if (reset) reset.addEventListener('click', async () => {
    if (!confirm('恢复全部内核设置为出厂默认？')) return;
    try {
      const r = await window.zhibo.settings.reset();
      const res = r && r.result ? r.result : r;
      state.settings = (res && res.settings) || (await window.zhibo.settings.get());
      paintSettings();
      toast('已恢复默认设置');
    } catch (e) { toast('恢复失败：' + e.message); }
  });

  const dd = $('setDataDirBtn');
  if (dd) dd.addEventListener('click', async () => {
    const info = await window.zhibo.app.info();
    if (info && info.dataRoot) window.zhibo.app.showItem(info.dataRoot);
  });
  const ld = $('setLogDirBtn');
  if (ld) ld.addEventListener('click', () => window.zhibo.log.openDir());
  const sf = $('setFileBtn');
  if (sf) sf.addEventListener('click', () => window.zhibo.settings.file());

  const ot = $('setOpenTrashBtn');
  if (ot) ot.addEventListener('click', () => window.zhibo.cache.openTrash());
  const et = $('setEmptyTrashBtn');
  if (et) et.addEventListener('click', async () => {
    if (!confirm('清空回收目录？归档的课时会被真正删除，无法恢复。')) return;
    try {
      const r = await window.zhibo.cache.emptyTrash();
      const res = r && r.result ? r.result : r;
      toast('已清理 ' + ((res && res.removed) || 0) + ' 项');
      renderSettings();
      refreshLibrary().catch(() => {});
    } catch (e) { toast('清理失败：' + e.message); }
  });
  const en = $('setEnforceBtn');
  if (en) en.addEventListener('click', async () => {
    try {
      const r = await window.zhibo.cache.enforce();
      const res = r && r.result ? r.result : r;
      if (res && res.skipped) { $('setEnforceInfo').textContent = '未设置上限，无需整理'; return; }
      if (res) {
        $('setEnforceInfo').textContent = '占用 ' + ((res.bytes || 0) / 1048576).toFixed(1) + ' MB · 归档 ' + (res.archived || 0) + ' 项';
        toast('缓存整理完成');
      }
      renderSettings();
      refreshLibrary().catch(() => {});
    } catch (e) { toast('整理失败：' + e.message); }
  });

  // 主进程推过来的设置变化（托盘改开关时同步界面）
  window.zhibo.on('settings', (s) => {
    state.settings = s;
    if (state.view === 'settings') paintSettings();
  });
}

/* ================= 内核自检 ================= */
async function kernelSelfCheck() {
  const pill = $('loginKernel');
  try {
    const st = await window.zhibo.kernel.status();
    const parts = [];
    // 内核能力位：MSE 自研引擎 / MP4 封装 / HLS 兜底 / 数据根
    parts.push(st.fmp4 ? '播放内核 ✓' : '播放内核 ✗');
    parts.push(st.remux ? '封装 ✓' : '封装 ✗');
    parts.push('数据 ' + (st.dataRoot ? '✓' : '✗'));
    pill.textContent = parts.join(' · ');
    const good = !!(st.fmp4 && st.remux && st.dataRoot);
    pill.className = 'kernel-pill' + (good ? ' ok' : ' warn');
    pill.title = '内核版本 ' + (st.version || '?') +
      '\n数据根 ' + (st.dataRoot || '?') +
      '\n本地流服务 ' + (st.hlsBase || '未启动') +
      '\nMSE 自研引擎 ' + (st.fmp4 ? '已就绪' : '未就绪') +
      '\nMP4 封装 ' + (st.remux ? '已就绪' : '未就绪');
  } catch (e) {
    pill.textContent = '内核未就绪';
    pill.className = 'kernel-pill warn';
  }
}

/* 侧栏版本号 = 应用真实版本（顺带把内核版本也记到 title 上） */
async function paintVersion() {
  let info = null;
  try {
    const w = window.zhibo;
    info = w && w.app && w.app.info ? await w.app.info() : null;
    if (!info && w && w.info) info = await w.info();
  } catch (e) { info = null; }
  if (info && info.version) {
    $('sideVersion').textContent = 'v' + info.version;
    $('sideVersion').title = 'Electron ' + (info.electron || '?') + ' · Node ' + (info.node || '?') +
      '\n数据根 ' + (info.dataRoot || '?') + '\n日志 ' + (info.logs || '?');
  }
}

/* ---------- 调试/自检用的 UI 接线（只读入口，不改变正常行为） ---------- */
window.__zbUI = {
  playLesson: (l, c, o) => playLesson(l, c, o),
  openCourse: (c) => openCourse(c),
  switchView: (v) => switchView(v),
  destroyHls: () => destroyHls(),
  state: () => ({
    view: state.view, libCount: state.libMap.size, dlCount: state.dlMap.size,
    seeking: !!state.seeking, hasKp: !!(state.kp && !state.kp.destroyed),
  }),
  // 分组目录的只读观测点（自检用，不参与业务）
  detail: () => {
    const secs = [...document.querySelectorAll('#lessonList .lesson-group')];
    return {
      groups: secs.length,
      chips: document.querySelectorAll('#lessonFilterBar .lchip').length,
      chipOn: (document.querySelector('#lessonFilterBar .lchip.on') || {}).textContent || '',
      rows: document.querySelectorAll('#lessonList .lesson-row').length,
      visibleGroups: secs.filter((e) => !e.hidden).length,
      collapsed: secs.filter((e) => e.classList.contains('collapsed')).length,
    };
  },
};

/* ================= 入口 ================= */
(async function main() {
  bind();
  paintVersion();
  kernelSelfCheck();
  // 设置要在第一次播放之前就位：倍速/音量/自动播放/续播都靠它
  try { state.settings = await window.zhibo.settings.get(); } catch (e) { state.settings = null; }
  if (state.settings) applyPlayPrefs(V());
  refreshLibrary().catch(() => {});

  // 只认本机保存的会话：安装包里不带任何人的票据，谁装谁登录
  let auto = null;
  try { auto = await window.zhibo.auth.auto(); } catch (e) { auto = null; }
  const res = (auto && auto.ok && auto.result) ? auto.result : null;

  if (res && res.ok) {
    try { await bootAfterLogin(); return; } catch (e) { console.error(e); }
  }

  // 没会话 / 会话过期 → 停在登录页；「先逛逛」才进游客模式
  showLogin();
  const why = res && res.reason;
  const hint = $('loginError');
  if (hint) {
    if (why === 'expired') { hint.textContent = '上次的登录已失效，请重新登录'; hint.hidden = false; }
    else { hint.hidden = true; }
  }
})();