// 智博X · 内核 · 智博教务 API
// 统一注入双 token；带内存缓存 + 离线兜底（断网时用最后一次成功数据）
'use strict';

const net = require('./net');
const auth = require('./auth');
const store = require('./store');
const log = require('./logger');

const API_BASE = auth.API_BASE;
const memCache = new Map();   // path -> {at, json}
const TTL = 5 * 60 * 1000;

function cacheKey(p) { return p; }

/* 登录失效的判定与广播。
   v1.7 起安装包不带任何人的账号，票据全靠用户自己登录产生；票据随时可能被
   服务端踢掉。所有 API 返回都要过一遍这里，让上层能在「登录没了」的第一时间
   把界面拉回登录页，而不是让用户对着一堆「未登录或token已失效」发愣。 */
const AUTH_DEAD_RE = /未登录|token.{0,4}(已失效|失效|过期)|登录已过期|重新登录/i;
let onAuthExpired = null;
function setAuthExpiredHandler(fn) { onAuthExpired = typeof fn === 'function' ? fn : null; }
function isAuthDead(json) {
  if (!json || json.code === 1) return false;
  return json.code === 0 && AUTH_DEAD_RE.test(String(json.message || ''));
}
function noticeAuthDead(pathname) {
  try { log.warn('api', '登录已失效（' + pathname + '），通知上层重新登录'); } catch (e) {}
  if (onAuthExpired) { try { onAuthExpired(pathname); } catch (e) {} }
}

function getCached(p, ttl) {
  const c = memCache.get(cacheKey(p));
  if (!c) return null;
  if (Date.now() - c.at > (ttl == null ? TTL : ttl)) return null;
  return c.json;
}

function setCached(p, json) {
  memCache.set(cacheKey(p), { at: Date.now(), json });
  // 落盘作为离线兜底（只存轻量的课程/资料类）
  if (p.length < 200) {
    store.update('api-cache', {}, (m) => {
      m[p] = { at: Date.now(), json };
      return m;
    });
  }
}

function offlineCached(p) {
  const m = store.get('api-cache', {});
  return m[p] ? m[p].json : null;
}

/**
 * 调 API。
 * @param {string} pathname 以 / 开头的路径，可含 query
 * @param {{method?:string, body?:any, needAuth?:boolean, timeout?:number,
 *          cache?:boolean, ttl?:number, offlineFallback?:boolean}} [opt]
 */
async function call(pathname, opt) {
  const o = opt || {};
  const p = pathname.startsWith('/') ? pathname : '/' + pathname;

  if (o.cache) {
    const hit = getCached(p, o.ttl);
    if (hit) return hit;
  }

  const h = auth.headers();
  if (o.needAuth === false) {
    delete h.Authorization;
    delete h['X-Access-Token'];
    delete h.userToken;
  }

  let body = null;
  if (o.body !== null && o.body !== undefined) {
    h['Content-Type'] = 'application/json; charset=utf-8';
    body = Buffer.from(JSON.stringify(o.body), 'utf8');
  }

  const t0 = Date.now();
  try {
    const r = await net.fetchText(API_BASE + p, {
      method: o.method || 'GET',
      headers: h,
      body: body,
      timeout: o.timeout || 20000,
      retries: o.retries == null ? 2 : o.retries,
    });
    let json;
    try {
      json = JSON.parse(r.text);
    } catch (e) {
      log.warn('api', p + ' 返回非 JSON HTTP' + r.status + ' :: ' + r.text.slice(0, 120));
      return { code: -1, message: '返回不是合法 JSON', data: null, _status: r.status };
    }
    json._status = r.status;
    json._ms = Date.now() - t0;
    log.debug('api', p + ' → code=' + json.code + ' ' + (Date.now() - t0) + 'ms');
    if (json.code === 1 && o.cache !== false) setCached(p, json);
    else if (isAuthDead(json)) noticeAuthDead(p);
    return json;
  } catch (e) {
    const msg = String((e && e.message) || e);
    log.error('api', p + ' 请求失败 :: ' + msg);
    if (o.offlineFallback !== false) {
      const off = offlineCached(p);
      if (off && !isAuthDead(off)) {
        log.warn('api', p + ' 使用离线缓存（' + new Date().toISOString() + '）');
        return Object.assign({}, off, { _offline: true });
      }
    }
    return { code: -1, message: msg, data: null, _offline: true, _error: true };
  }
}

/* ---------- 业务封装 ---------- */
// 说明：智博服务端已改版，以下路径全部经实测确认（2026-11 用真实票据验证）
//   /api/profile                                     ✅
//   /api/config/ZHIBO_APP_UI_BANNER                  ✅ data 是 JSON 字符串，需要二次 parse
//   /api/my/course/list/v3?expired=0&page=1&pageSize=100 ✅
//   /api/course/list?page=N&pageSize=N               ✅ 服务端每页固定最多 20 条
//   /api/my/course/<id>                              ✅ 只有它会带 qcloudVodFileId
//   /api/video/sign?lessonId=&type=2                 ✅

/** 把可能是 JSON 字符串的字段解成数组 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p;
    } catch (e) {}
  }
  return [];
}

const PAGE_SIZE = 20;   // 服务端硬上限，传更大也只回 20

const biz = {
  profile: () => call('/profile', { cache: true, ttl: 60 * 1000 }),

  /** 首页轮播：data 为 [{imageUrl, province}] 的 JSON 字符串 */
  banners: async () => {
    const r = await call('/config/ZHIBO_APP_UI_BANNER', { cache: true });
    return Object.assign({}, r, { data: asArray(r.data) });
  },

  myCourses: () => call('/my/course/list/v3?expired=0&page=1&pageSize=100', { cache: true }),

  courseDetail: (id) => call('/my/course/' + encodeURIComponent(id), { cache: true }),
  courseInfo: (id) => call('/course/' + encodeURIComponent(id), { cache: true }),

  /**
   * 完整课程详情：把「套课」结构摊平成可以直接渲染的课时分组。
   *
   * 服务端的两套接口各缺一半，必须合用：
   *   /my/course/<id>  有 lessonList 与 qcloudVodFileId（能播），但**没有 subCourseList**
   *   /course/<id>     有 subCourseList（套课的子课程清单），但 qcloudVodFileId 全是 null
   * 结果是「线上集训营（含高数Ⅰ）」这类课在我的课程里只回 lessonList:[]，直接渲染成
   * 「暂无课时」——课时其实挂在 4 个子课程（高数Ⅰ/英语/计算机/大学语文）里。
   *
   * 所以：先拿 my 版；若 lessonList 为空而公开版带 subCourseList，就逐个把子课程的
   * my 版拉回来，拼成 data.groups = [{id,name,classHours,lessons:[...]}]。
   * 单层套课（实测最深一层），不做无限递归。
   */
  courseFull: async (id) => {
    const cid = String(id);
    const my = await call('/my/course/' + encodeURIComponent(cid), { cache: true });
    const data = (my && my.data) || null;
    if (!data) return my;

    const own = asArray(data.lessonList);
    data.lessonList = own;
    if (own.length) {
      data.groups = [{ id: cid, name: data.name || '', classHours: data.classHours, lessons: own }];
      data.flatCount = own.length;
      return Object.assign({}, my, { data });
    }

    // lessonList 为空：看公开接口有没有子课程
    let subs = [];
    try {
      const pub = await call('/course/' + encodeURIComponent(cid), { cache: true });
      subs = asArray(pub && pub.data && pub.data.subCourseList);
      if (!subs.length) subs = asArray(data.subCourseList);
    } catch (e) { subs = asArray(data.subCourseList); }
    if (!subs.length) {
      data.groups = [];
      data.flatCount = 0;
      return Object.assign({}, my, { data });
    }

    const groups = [];
    for (const s of subs) {
      const sid = String(s.id);
      let lessons = [];
      try {
        const r = await call('/my/course/' + encodeURIComponent(sid), { cache: true });
        const d = (r && r.data) || {};
        lessons = asArray(d.lessonList);
        if (!lessons.length) {
          const r2 = await call('/course/' + encodeURIComponent(sid), { cache: true });
          lessons = asArray(r2 && r2.data && r2.data.lessonList);
        }
      } catch (e) { /* 单个子课程失败不影响其它 */ }
      groups.push({
        id: sid,
        name: s.name || ('子课程' + sid),
        classHours: s.classHours != null ? s.classHours : (lessons.length || null),
        coverImageUrl: s.coverImageUrl || '',
        lessons,
      });
    }
    data.groups = groups;
    data.flatCount = groups.reduce((a, g) => a + g.lessons.length, 0);
    // 顶层 lessonList 仍是空（不能伪造，播放要靠真实 courseId 归属）
    return Object.assign({}, my, { data });
  },

  /** 分类：服务端没有分类接口，从课程列表前 5 页聚合出来 */
  categories: async () => {
    const seen = new Map();
    for (let page = 1; page <= 5; page++) {
      const r = await call('/course/list?page=' + page + '&pageSize=' + PAGE_SIZE, { cache: true, ttl: 30 * 60 * 1000 });
      const list = Array.isArray(r.data) ? r.data : [];
      for (const c of list) {
        if (!c || c.categoryId == null) continue;
        const k = String(c.categoryId);
        if (!seen.has(k)) seen.set(k, { id: k, name: c.categoryName || ('分类' + k), count: 0 });
        seen.get(k).count++;
      }
      if (list.length < PAGE_SIZE) break;
    }
    return { code: 1, message: 'ok', data: Array.from(seen.values()), _derived: true };
  },

  courseList: (page, size, categoryId, recommended) => {
    let q = '/course/list?page=' + (page || 1) + '&pageSize=' + (size || PAGE_SIZE);
    if (categoryId) q += '&categoryId=' + encodeURIComponent(categoryId);
    if (recommended) q += '&isRecommended=true';
    return call(q, { cache: true, ttl: 10 * 60 * 1000 });
  },

  subtitles: (lessonId) => call('/course-lesson/zimu/' + encodeURIComponent(lessonId), { cache: true, ttl: 5 * 60 * 1000 }),


  sign: (lessonId, type) =>
    call('/video/sign?lessonId=' + encodeURIComponent(lessonId) + '&type=' + (type || 2), { cache: false }),
};

function clearCache() { memCache.clear(); }

module.exports = { API_BASE, call, biz, clearCache, getCached, isAuthDead, setAuthExpiredHandler };
