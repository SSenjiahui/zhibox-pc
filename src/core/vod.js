// 智博X · 内核 · 腾讯云 VOD 播放链路
// /video/sign(JWT) → getplayinfo/v4 → m3u8 → AES-128 key → 解密明文 TS
'use strict';

const crypto = require('crypto');
const net = require('./net');
const auth = require('./auth');
const log = require('./logger');

/* 分析已知的硬性事实（实测）：
 * - getplayinfo 返回的 url 是 http://...vod2.myqcloud.com/.../drm/v.f<def>.m3u8
 *   但该域名的 443 端口直接拒绝纯 HTTP 请求（400 "plain http request was sent to https port"），
 *   所以必须把协议改成 https。
 * - m3u8 本身不需要鉴权；解密 key 端点必须带 Authorization。 */
function forceHttps(u) {
  if (!u) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('http://')) return 'https://' + u.slice(7);
  return u;
}

function parseJwt(sig) {
  const parts = String(sig).split('.');
  if (parts.length < 2) throw new Error('播放签名格式异常（不是 JWT）');
  const json = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!json.appId || !json.fileId) throw new Error('播放签名缺少 appId / fileId');
  return json;
}

/** 拉 getplayinfo，得到清晰度列表（按分辨率降序） */
async function playInfo(signature) {
  const claims = parseJwt(signature);
  const url = 'https://playvideo.qcloud.com/getplayinfo/v4/' + claims.appId + '/' +
    claims.fileId + '?sign=' + encodeURIComponent(signature);
  const r = await net.fetchText(url, { timeout: 15000, retries: 2, headers: { Accept: 'application/json' } });

  let info;
  try { info = JSON.parse(r.text); } catch (e) { throw new Error('getplayinfo 返回非 JSON'); }
  if (info.code !== 0) throw new Error('getplayinfo 失败 code=' + info.code + ' ' + (info.message || ''));

  const vi = info.videoInfo || {};
  const basic = vi.basicInfo || {};
  const list = (vi.transcodeList || []).slice().sort(
    (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
  );
  if (!list.length) throw new Error('该视频没有可用的转码流');

  return {
    appId: claims.appId,
    fileId: claims.fileId,
    claims: claims,
    name: basic.name || '',
    duration: basic.duration || list[0].duration || 0,
    drm: vi.drm || null,
    streams: list.map((s, i) => ({
      index: i,
      definition: s.definition,
      width: s.width || 0,
      height: s.height || 0,
      bitrate: s.bitrate || 0,
      duration: s.duration || 0,
      size: s.size || 0,
      url: forceHttps(s.url),
      label: (s.height || 0) >= 720 ? String(s.height) + 'P 高清' : String(s.height || '') + 'P',
    })),
  };
}

/** 解析 m3u8：key URL、IV、分片列表、总时长 */
async function loadPlaylist(m3u8Url) {
  const url = forceHttps(m3u8Url);
  const r = await net.fetchText(url, { timeout: 15000, retries: 2 });
  if (r.status !== 200) throw new Error('m3u8 拉取失败 HTTP ' + r.status);

  let keyUrl = null;
  let iv = null;
  let targetDuration = 10;
  const segs = [];
  let pendingDur = 0;

  for (const rawLine of r.text.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    if (t.startsWith('#EXT-X-KEY:')) {
      const m = /URI="([^"]+)"/.exec(t);
      if (m) keyUrl = new URL(m[1], url).toString();
      const mi = /IV=0x([0-9a-fA-F]+)/.exec(t);
      if (mi) iv = mi[1];
      continue;
    }
    if (t.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(t.split(':')[1]) || 10;
      continue;
    }
    if (t.startsWith('#EXTINF:')) {
      const n = parseFloat(t.slice(8));
      pendingDur = isNaN(n) ? targetDuration : n;
      continue;
    }
    if (t.startsWith('#')) continue;
    segs.push({ index: segs.length, url: new URL(t, url).toString(), duration: pendingDur || targetDuration });
    pendingDur = 0;
  }

  const duration = segs.reduce((a, s) => a + s.duration, 0);
  log.info('vod', 'm3u8 解析：' + segs.length + ' 分片 / ' + duration.toFixed(2) + 's key=' + (keyUrl ? '有' : '无'));
  return { m3u8Url: url, keyUrl, iv, segments: segs, duration, targetDuration };
}

/** 取解密 key（必须 16 字节；服务端未鉴权时返回 JSON 错误体，要显式识别） */
async function fetchKey(keyUrl, sess) {
  const h = auth.headers(sess);
  const r = await net.fetchBuffer(keyUrl, { headers: Object.assign({ Accept: '*/*' }, h), timeout: 15000, retries: 2 });
  if (r.status !== 200) throw new Error('解密 key 请求失败 HTTP ' + r.status);
  if (r.buffer.length === 16) return r.buffer;
  // 非 16 字节 → 一定是错误 JSON
  let msg = r.buffer.toString('utf8').slice(0, 160);
  try { msg = JSON.parse(msg).message || msg; } catch (e) {}
  throw new Error('解密 key 无效（' + r.buffer.length + ' 字节）：' + msg);
}

function ivBuffer(ivHex) {
  if (!ivHex) return Buffer.alloc(16, 0);
  return Buffer.from(String(ivHex).padStart(32, '0'), 'hex');
}

/** AES-128-CBC 解密一个分片 */
function decryptSegment(buf, key, ivHex) {
  if (!key) return buf;
  const d = crypto.createDecipheriv('aes-128-cbc', key, ivBuffer(ivHex));
  return Buffer.concat([d.update(buf), d.final()]);
}

/**
 * 完整解析一个课时的播放信息。
 * @returns {Promise<{name,duration,streams,current,m3u8Url,keyUrl,iv,segments}>}
 */
async function resolve(signature, streamIndex, sess) {
  const info = await playInfo(signature);
  const idx = Math.max(0, Math.min(streamIndex || 0, info.streams.length - 1));
  const st = info.streams[idx];
  const pl = await loadPlaylist(st.url);
  return {
    name: info.name,
    duration: info.duration || pl.duration,
    streams: info.streams,
    current: idx,
    drm: info.drm,
    m3u8Url: pl.m3u8Url,
    keyUrl: pl.keyUrl,
    iv: pl.iv,
    segments: pl.segments,
    segmentDuration: pl.duration / Math.max(1, pl.segments.length),
    fileId: info.fileId,
    appId: info.appId,
  };
}

/** 下载并解密单个分片 */
async function fetchSegment(seg, key, ivHex, sess) {
  const h = auth.headers(sess);
  const r = await net.fetchBuffer(seg.url, { headers: { Accept: '*/*' }, timeout: 30000, retries: 3 });
  if (r.status !== 200) throw new Error('分片 ' + seg.index + ' HTTP ' + r.status);
  const out = decryptSegment(r.buffer, key, ivHex);
  // TS 同步字节校验
  if (out.length > 0 && out[0] !== 0x47 && out[188] !== undefined && out[188] !== 0x47) {
    log.warn('vod', '分片 ' + seg.index + ' 解密后首字节非 0x47（' + out[0] + '），可能 key/IV 不匹配');
  }
  return out;
}

module.exports = { playInfo, loadPlaylist, fetchKey, decryptSegment, resolve, fetchSegment, forceHttps, parseJwt };
