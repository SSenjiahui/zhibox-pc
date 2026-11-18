'use strict';
/**
 * fmp4.js — 纯 JavaScript 的 MPEG-TS → fragmented MP4(fMP4) 封装内核（零第三方依赖）
 *
 * 设计要点：
 *  - 只使用 Node 内置能力（本文件甚至不需要 require 任何模块），无 npm 依赖、无外部进程。
 *  - 面向 MSE：init（ftyp + moov，含 mvex/trex）可缓存复用，media（moof + mdat）按分片生成。
 *  - TS 解复用 / PAT / PMT / PES / Annex-B / SPS / ADTS 解析逻辑与 ts2mp4.js 同源
 *    （该文件是成熟的 TS→普通 MP4 封装器，这里把内部函数复制过来，不改动它）。
 *  - 视频：Annex-B → AVCC（4 字节大端长度前缀），一个 PES 的 NAL 合成一个样本；
 *          丢弃 AUD/SPS/PPS，保留 SEI 与其余 NAL。
 *  - 音频：ADTS 头剥离，裸 AAC 帧直接做样本；ASC 由 ADTS 头推出写进 esds。
 *  - 时间戳：MPEG-TS 的 PTS/DTS 是 33 位，片内出现大幅回退（>2^32）按 +2^33 展开；
 *          视频 tfdt 用展开后的绝对 DTS，保证同一路流多个分片的 fragment 首尾相接。
 *
 * 时间轴串联（MSE 边下边播）：
 *   分片之间用 baseDts 首尾相接——第一片 baseDts=0，之后每片传上一片返回的 nextDts。
 *   tfdt 因此严格递增，浏览器不会因为 fragment 时间轴重叠而卡住或跳帧。
 *
 * 用法：
 *   const f4 = require('./fmp4');
 *   const r = f4.convert(tsBuffer);           // { ok, init, media, codec, width, height, ... }
 *   const r2 = f4.convert(nextBuf, { baseDts: r.nextDts, seq: 2 });
 *   const p = f4.parseSegment(tsBuffer);      // 只要解析结果
 *   const init = f4.buildInit(p);             // 自己拼装
 *   const media = f4.buildMedia(p, { seq: 7, baseDts: 0 });
 *   const codec = f4.codecString(p);          // 'avc1.64001f,mp4a.40.2'
 */

/* ==================================================================
 * 一、基础工具（与 ts2mp4.js 同源）
 * ================================================================== */

/** 大端字节写入器，用来拼装 MP4 box */
function BW() {
  this.parts = [];
  this.len = 0;
}
BW.prototype.push = function (b) {
  this.parts.push(b);
  this.len += b.length;
  return this;
};
BW.prototype.u8 = function (v) {
  const b = Buffer.allocUnsafe(1);
  b[0] = v & 0xff;
  return this.push(b);
};
BW.prototype.u16 = function (v) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(v & 0xffff, 0);
  return this.push(b);
};
BW.prototype.u24 = function (v) {
  const b = Buffer.allocUnsafe(3);
  b[0] = (v >>> 16) & 0xff;
  b[1] = (v >>> 8) & 0xff;
  b[2] = v & 0xff;
  return this.push(b);
};
BW.prototype.u32 = function (v) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(v >>> 0, 0);
  return this.push(b);
};
BW.prototype.i32 = function (v) {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32BE(v | 0, 0);
  return this.push(b);
};
/** 64 位无符号（JS 安全整数范围内），拆成高低两个 32 位字写入 */
BW.prototype.u64 = function (v) {
  const hi = Math.floor(v / 4294967296);
  return this.u32(hi).u32(v - hi * 4294967296);
};
BW.prototype.str = function (s) {
  return this.push(Buffer.from(s, 'latin1'));
};
BW.prototype.raw = function (b) {
  return this.push(b);
};
BW.prototype.toBuffer = function () {
  return Buffer.concat(this.parts, this.len);
};

/** 组装一个普通 box：8 字节头 + 内容 */
function mkBox(type, content) {
  let body;
  if (!content) body = Buffer.alloc(0);
  else if (Buffer.isBuffer(content)) body = content;
  else body = content.toBuffer();
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body], body.length + 8);
}

/** 组装一个 full box（version + flags + 内容） */
function mkFullBox(type, version, flags, content) {
  const b = new BW();
  b.u8(version);
  b.u24(flags);
  if (content) b.push(Buffer.isBuffer(content) ? content : content.toBuffer());
  return mkBox(type, b);
}

/** MP4 里的单位矩阵（9 个 32 位定点数） */
function unityMatrix(b) {
  b.u32(0x00010000).u32(0).u32(0);
  b.u32(0).u32(0x00010000).u32(0);
  b.u32(0).u32(0).u32(0x40000000);
  return b;
}

/** MPEG-4 描述符长度编码（7 位分组的变长编码） */
function encodeDescLen(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    out.unshift(0x80 | (n & 0x7f));
    n >>= 7;
  }
  return Buffer.from(out);
}

/** 一段 MPEG-4 描述符：tag + 长度 + 内容 */
function mkDesc(tag, payload) {
  return Buffer.concat([Buffer.from([tag]), encodeDescLen(payload.length), payload]);
}

/* ==================================================================
 * 二、MPEG-TS 解复用层（与 ts2mp4.js 同源）
 * ================================================================== */

const TS_SYNC = 0x47;
const TS_MOD = 8589934592; /* 2^33，33 位时间戳回绕模数 */
const TS_HALF = 4294967296; /* 2^32，判定"回退即回绕"的阈值 */

/**
 * 探测 TS 包长与同步字节偏移。
 * 188 = 标准 TS；192 = 4 字节时间戳前缀 + 188（腾讯云等 CDN 常见）。
 */
function detectPacketLayout(buf) {
  if (buf.length > 376 && buf[0] === TS_SYNC && buf[188] === TS_SYNC) {
    return { pktLen: 188, syncOffset: 0 };
  }
  if (buf.length > 384 && buf[4] === TS_SYNC && buf[196] === TS_SYNC) {
    return { pktLen: 192, syncOffset: 4 };
  }
  const lim = Math.min(200, buf.length - 189);
  for (let off = 0; off < lim; off++) {
    if (buf[off] !== TS_SYNC) continue;
    if (buf[off + 188] === TS_SYNC) return { pktLen: 188, syncOffset: off };
    if (buf[off + 192] === TS_SYNC) return { pktLen: 192, syncOffset: off };
  }
  return { pktLen: 188, syncOffset: 0 };
}

/** 输入是否像 MPEG-TS：至少能在 188/192 的步长上找到连续两个同步字节 */
function looksLikeTs(buf) {
  if (!buf || buf.length < 376) return false;
  if (buf[0] === TS_SYNC && buf[188] === TS_SYNC) return true;
  if (buf.length > 384 && buf[4] === TS_SYNC && buf[196] === TS_SYNC) return true;
  const lim = Math.min(200, buf.length - 189);
  for (let off = 0; off < lim; off++) {
    if (buf[off] !== TS_SYNC) continue;
    if (buf[off + 188] === TS_SYNC || buf[off + 192] === TS_SYNC) return true;
  }
  return false;
}

/** 遍历所有 TS 包，对每个包回调 onPacket(pid, pusi, payload) */
function forEachTsPacket(buf, layout, onPacket) {
  const pktLen = layout.pktLen;
  const end = buf.length - 188;
  let bad = 0;
  for (let i = layout.syncOffset; i <= end; i += pktLen) {
    if (buf[i] !== TS_SYNC) {
      bad++;
      continue;
    }
    const b1 = buf[i + 1];
    const pid = ((b1 & 0x1f) << 8) | buf[i + 2];
    const pusi = (b1 & 0x40) !== 0;
    const afc = (buf[i + 3] >> 4) & 0x03;
    let p = i + 4;
    if (afc & 0x02) p += 1 + buf[p];
    if (!(afc & 0x01) || p >= i + 188) continue;
    onPacket(pid, pusi, buf.subarray(p, i + 188));
  }
  return bad;
}

/** 解析 PAT section，取第一个有节目号的 program_map_PID */
function parsePatSection(sec) {
  if (sec.length < 12 || sec[0] !== 0x00) return -1;
  const end = sec.length - 4; /* 去掉 CRC32 */
  for (let p = 8; p + 4 <= end; p += 4) {
    const progNum = (sec[p] << 8) | sec[p + 1];
    if (progNum === 0) continue;
    return ((sec[p + 2] & 0x1f) << 8) | sec[p + 3];
  }
  return -1;
}

/** 解析 PMT section，填充视频/音频 PID 与 stream_type 映射 */
function parsePmtSection(sec, out) {
  if (sec.length < 16 || sec[0] !== 0x02) return;
  const progInfoLen = ((sec[10] & 0x0f) << 8) | sec[11];
  let p = 12 + progInfoLen;
  const end = sec.length - 4;
  while (p + 5 <= end) {
    const stype = sec[p];
    const pid = ((sec[p + 1] & 0x1f) << 8) | sec[p + 2];
    const esLen = ((sec[p + 3] & 0x0f) << 8) | sec[p + 4];
    out.streams[pid] = stype;
    if (stype === 0x1b && out.videoPid < 0) out.videoPid = pid;
    else if ((stype === 0x0f || stype === 0x11) && out.audioPid < 0) out.audioPid = pid;
    p += 5 + esLen;
  }
}

/** 读取 33 位时间戳（4+3+15+15 位打包） */
function readTs33(b, o) {
  return (
    (b[o] & 0x0e) * 536870912 +
    b[o + 1] * 4194304 +
    ((b[o + 2] & 0xfe) >> 1) * 32768 +
    b[o + 3] * 128 +
    ((b[o + 4] & 0xfe) >> 1)
  );
}

/** 解析 PES 头，返回时间戳与净荷范围 */
function parsePesHeader(buf) {
  if (buf.length < 6 || buf[0] !== 0x00 || buf[1] !== 0x00 || buf[2] !== 0x01) return null;
  const streamId = buf[3];
  /* 这些流没有 PES 扩展头，净荷紧随 6 字节头 */
  const NO_EXT = [0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf3, 0xf8, 0xff];
  if (NO_EXT.indexOf(streamId) >= 0) {
    return { streamId, pts: null, dts: null, dataOffset: 6 };
  }
  if (buf.length < 9) return null;
  const flags = buf[7];
  const hdrLen = buf[8];
  const dataOffset = 9 + hdrLen;
  const ptsDts = (flags >> 6) & 0x03;
  let pts = null;
  let dts = null;
  if ((ptsDts === 2 || ptsDts === 3) && buf.length >= 14) pts = readTs33(buf, 9);
  if (ptsDts === 3 && buf.length >= 19) dts = readTs33(buf, 14);
  return { streamId, pts, dts, dataOffset };
}

/**
 * 解复用一个 TS 分片：解析 PAT/PMT，把所有 PES 按 PID 归集。
 * 返回 { videoPid, audioPid, streams, byPid: Map<pid, Buffer[]>, badPackets }
 */
function demuxSegment(buf) {
  const layout = detectPacketLayout(buf);
  const out = { videoPid: -1, audioPid: -1, pmtPid: -1, streams: {}, byPid: new Map() };
  const sec = { buf: Buffer.alloc(0) };
  const pes = new Map();

  /* 收集并输出一个完整 PES */
  const emit = (pid) => {
    const a = pes.get(pid);
    if (!a || !a.parts) return;
    const joined = a.parts.length === 1 ? a.parts[0] : Buffer.concat(a.parts, a.len);
    a.parts = null;
    let list = out.byPid.get(pid);
    if (!list) {
      list = [];
      out.byPid.set(pid, list);
    }
    list.push(joined);
  };

  const pushPsi = (pid, pusi, payload) => {
    if (pusi) {
      if (!payload.length) return;
      const ptr = payload[0];
      if (1 + ptr >= payload.length) {
        sec.buf = Buffer.alloc(0);
        return;
      }
      sec.buf = Buffer.from(payload.subarray(1 + ptr));
    } else {
      if (!sec.buf.length) return;
      sec.buf = Buffer.concat([sec.buf, payload]);
    }
    while (sec.buf.length >= 3) {
      const secLen = ((sec.buf[1] & 0x0f) << 8) | sec.buf[2];
      const total = 3 + secLen;
      if (sec.buf.length < total) return;
      const one = sec.buf.subarray(0, total);
      sec.buf = sec.buf.subarray(total);
      if (one[0] === 0x00 && out.pmtPid < 0) out.pmtPid = parsePatSection(one);
      else if (one[0] === 0x02) parsePmtSection(one, out);
    }
  };

  const pushPes = (pid, pusi, payload) => {
    let a = pes.get(pid);
    if (pusi) {
      if (a && a.parts) emit(pid);
      pes.set(pid, { parts: [payload], len: payload.length });
    } else if (a && a.parts) {
      a.parts.push(payload);
      a.len += payload.length;
    }
  };

  out.badPackets = forEachTsPacket(buf, layout, (pid, pusi, payload) => {
    if (pid === 0x1fff) return;
    if (pid === 0x00 || pid === out.pmtPid) return pushPsi(pid, pusi, payload);
    if (pid === out.videoPid || pid === out.audioPid || out.videoPid < 0) {
      return pushPes(pid, pusi, payload);
    }
  });
  for (const pid of Array.from(pes.keys())) emit(pid);
  return out;
}

/* ==================================================================
 * 三、H.264 解析（与 ts2mp4.js 同源）
 * ================================================================== */

/** 去掉 RBSP 里的防竞争字节 0x000003 */
function unescapeRbsp(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i + 2 < buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 3) {
      out[o++] = 0;
      out[o++] = 0;
      i += 2;
    } else {
      out[o++] = buf[i];
    }
  }
  return out.subarray(0, o);
}

/** RBSP 位读取器（含指数哥伦布） */
function BitReader(buf) {
  this.b = buf;
  this.pos = 0;
}
BitReader.prototype.bit = function () {
  const byte = this.b[this.pos >> 3];
  if (byte === undefined) return 0;
  const v = (byte >> (7 - (this.pos & 7))) & 1;
  this.pos++;
  return v;
};
BitReader.prototype.bits = function (n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 2 + this.bit();
  return v;
};
BitReader.prototype.ue = function () {
  let lz = 0;
  while (this.bit() === 0) {
    lz++;
    if (lz > 32) return 0;
  }
  if (lz === 0) return 0;
  return Math.pow(2, lz) - 1 + this.bits(lz);
};
BitReader.prototype.se = function () {
  const k = this.ue();
  return k % 2 === 0 ? -(k / 2) : (k + 1) / 2;
};

/** 跳过一段 scaling list（只按语法推进，不保留系数） */
function skipScalingList(rb, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      const delta = rb.se();
      next = (last + delta + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/**
 * 解析 SPS NAL（含 NAL 头），返回 profile/level/宽高。
 * 宽高按 H.264 的宏块数与 frame_cropping 换算。
 */
function parseSps(nal) {
  const rb = new BitReader(unescapeRbsp(nal.subarray(1)));
  const info = { profileIdc: rb.bits(8), constraints: rb.bits(8), levelIdc: rb.bits(8) };
  rb.ue(); /* seq_parameter_set_id */
  let chromaFormat = 1;
  if (HIGH_PROFILES.indexOf(info.profileIdc) >= 0) {
    chromaFormat = rb.ue();
    if (chromaFormat === 3) rb.bit(); /* separate_colour_plane_flag */
    rb.ue(); /* bit_depth_luma_minus8 */
    rb.ue(); /* bit_depth_chroma_minus8 */
    rb.bit(); /* qpprime_y_zero_transform_bypass_flag */
    if (rb.bit()) {
      const n = chromaFormat !== 3 ? 8 : 12;
      for (let i = 0; i < n; i++) if (rb.bit()) skipScalingList(rb, i < 6 ? 16 : 64);
    }
  }
  rb.ue(); /* log2_max_frame_num_minus4 */
  const pocType = rb.ue();
  if (pocType === 0) {
    rb.ue(); /* log2_max_pic_order_cnt_lsb_minus4 */
  } else if (pocType === 1) {
    rb.bit();
    rb.se();
    rb.se();
    const n = rb.ue();
    for (let i = 0; i < n; i++) rb.se();
  }
  rb.ue(); /* max_num_ref_frames */
  rb.bit(); /* gaps_in_frame_num_value_allowed_flag */
  const wMbs = rb.ue() + 1;
  const hMap = rb.ue() + 1;
  const frameMbsOnly = rb.bit();
  if (!frameMbsOnly) rb.bit(); /* mb_adaptive_frame_field_flag */
  rb.bit(); /* direct_8x8_inference_flag */
  let cl = 0;
  let cr = 0;
  let ct = 0;
  let cb = 0;
  if (rb.bit()) {
    cl = rb.ue();
    cr = rb.ue();
    ct = rb.ue();
    cb = rb.ue();
  }
  const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
  const subH = chromaFormat === 1 ? 2 : 1;
  const cropY = subH * (2 - frameMbsOnly);
  info.width = wMbs * 16 - (cl + cr) * subW;
  info.height = (2 - frameMbsOnly) * hMap * 16 - (ct + cb) * cropY;
  info.profileName =
    { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10',
      122: 'High 4:2:2', 244: 'High 4:4:4' }[info.profileIdc] || ('Profile' + info.profileIdc);
  return info;
}

/** 从 Annex-B 字节流切出所有 NAL 单元（返回视图，零拷贝） */
function splitAnnexB(buf) {
  const out = [];
  const n = buf.length;
  let start = -1;
  let i = 0;
  const flush = (endPos) => {
    if (start < 0) return;
    let e = endPos;
    while (e > start && buf[e - 1] === 0) e--;
    if (e > start) out.push({ type: buf[start] & 0x1f, data: buf.subarray(start, e) });
  };
  while (i + 2 < n) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      flush(i);
      i += 3;
      start = i;
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      flush(i);
      i += 4;
      start = i;
    } else {
      i++;
    }
  }
  flush(n);
  return out;
}

/**
 * 把一帧的 NAL 列表转成 AVCC（4 字节长度前缀）。
 * 丢弃 AUD(9)/SPS(7)/PPS(8)：AUD 无意义，SPS/PPS 已进 avcC（参数集变更的极端情况
 * 下也由 avcC 提供初始集，MSE 不接受 mid-stream 参数集，这是 fMP4 的常规做法）。
 * SEI(6) 保留，其余 NAL 原样保留。
 * 返回 { data, key }。
 */
function nalsToAvcc(nals) {
  const keep = [];
  let total = 0;
  let key = false;
  for (let i = 0; i < nals.length; i++) {
    const n = nals[i];
    if (n.type === 7 || n.type === 8 || n.type === 9) continue;
    if (!n.data.length) continue;
    if (n.type === 5) key = true;
    keep.push(n);
    total += 4 + n.data.length;
  }
  const out = Buffer.allocUnsafe(total);
  let o = 0;
  for (let i = 0; i < keep.length; i++) {
    out.writeUInt32BE(keep[i].data.length, o);
    o += 4;
    keep[i].data.copy(out, o);
    o += keep[i].data.length;
  }
  return { data: out, key };
}

/* ==================================================================
 * 四、AAC / ADTS 解析（与 ts2mp4.js 同源）
 * ================================================================== */

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000,
  22050, 16000, 12000, 11025, 8000, 7350];

/** 解析 ADTS 头（7 或 9 字节），返回帧长与音频参数 */
function parseAdts(buf, off) {
  if (off + 7 > buf.length) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) return null;
  const protectionAbsent = buf[off + 1] & 1;
  const profile = (buf[off + 2] >> 6) & 0x03;
  const sfIndex = (buf[off + 2] >> 2) & 0x0f;
  const channelCfg = ((buf[off + 2] & 0x01) << 2) | ((buf[off + 3] >> 6) & 0x03);
  const frameLen = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x07);
  const headerLen = protectionAbsent ? 7 : 9;
  if (frameLen <= headerLen || sfIndex > 12) return null;
  return { objectType: profile + 1, sfIndex, channelCfg, frameLen, headerLen };
}

/** 由 ADTS 参数构造 2 字节 AudioSpecificConfig */
function buildAsc(objectType, sfIndex, channelCfg) {
  const b = Buffer.allocUnsafe(2);
  b[0] = ((objectType & 0x1f) << 3) | ((sfIndex >> 1) & 0x07);
  b[1] = ((sfIndex & 0x01) << 7) | ((channelCfg & 0x0f) << 3);
  return b;
}

/* ==================================================================
 * 五、时间戳处理
 * ================================================================== */

/**
 * 33 位时间戳展开器（每个流字段一个"上一次的值"）。
 * 只在**片内**使用：同一片内出现 PTS/DTS 大幅回退（> 2^32 tick，约 13.3 小时）
 * 判定为 33 位回绕，整体加 2^33；小幅回退（B 帧重排、抖动）保持原值。
 */
function makeUnwrapper() {
  const last = Object.create(null);
  return function unwrap(key, raw) {
    if (raw == null) return null;
    const prev = last[key];
    if (prev === undefined) {
      last[key] = raw;
      return raw;
    }
    let v = raw;
    while (v < prev - TS_HALF) v += TS_MOD;
    last[key] = v;
    return v;
  };
}

/** 对缺失的 DTS 做线性插值，并强制单调递增（与 ts2mp4.js 同源） */
function rebuildDts(frames, fallbackStep) {
  const n = frames.length;
  if (!n) return;
  const known = [];
  for (let i = 0; i < n; i++) if (frames[i].dts != null) known.push(i);
  const step = fallbackStep > 0 ? fallbackStep : 1;
  if (!known.length) {
    const base = frames[0].pts != null ? frames[0].pts : 0;
    for (let i = 0; i < n; i++) frames[i].dts = base + i * step;
    return;
  }
  for (let i = known[0] - 1; i >= 0; i--) frames[i].dts = frames[i + 1].dts - step;
  for (let i = known[known.length - 1] + 1; i < n; i++) frames[i].dts = frames[i - 1].dts + step;
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k];
    const b = known[k + 1];
    if (b - a <= 1) continue;
    const da = frames[a].dts;
    const db = frames[b].dts;
    for (let i = a + 1; i < b; i++) {
      frames[i].dts = Math.round(da + ((db - da) * (i - a)) / (b - a));
    }
  }
  for (let i = 1; i < n; i++) {
    if (frames[i].dts <= frames[i - 1].dts) frames[i].dts = frames[i - 1].dts + step;
  }
}

/**
 * 估算视频帧步长：取 PTS 排序后相邻差值的众数。
 * 不能用最小值（尾部半帧间隔会把整体步长带偏）。
 */
function estimateFrameStep(frames) {
  const pts = frames.map((f) => f.pts).sort((a, b) => a - b);
  const hist = new Map();
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i] - pts[i - 1];
    if (d > 0) hist.set(d, (hist.get(d) || 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  hist.forEach((n, d) => {
    if (n > bestN || (n === bestN && d < best)) { best = d; bestN = n; }
  });
  return best > 0 ? best : 3000;
}

/**
 * 把视频 PTS 吸附到"帧步长整数倍"的网格上，并保证呈现顺序严格递增。
 * 源里偶尔会出现偏离网格的 PTS（如 15699750 = 75.2 帧），它会让下游按 CFR
 * 处理时与邻帧撞到同一输出刻度，ffmpeg 报 "non monotonically increasing dts"。
 * 吸附后每帧独占一个刻度；只在撞格时推动后续帧，其余帧保持不变。
 */
function snapVideoPts(frames, step) {
  if (!(step > 0) || frames.length < 2) return;
  const order = frames.map((f, i) => i).sort((x, y) => frames[x].pts - frames[y].pts);
  let lastK = -Infinity;
  for (let n = 0; n < order.length; n++) {
    const f = frames[order[n]];
    let k = Math.round(f.pts / step);
    if (k <= lastK) k = lastK + 1;
    lastK = k;
    f.pts = k * step;
  }
}

/**
 * 视频每样本时长（90kHz）：相邻 DTS 差值。
 * 末样本用前面样本的中位步长补齐；任何非正差值强制为 1，保证严格单调。
 */
function videoDurations(frames) {
  const n = frames.length;
  const out = new Array(n);
  if (!n) return out;
  for (let i = 0; i < n - 1; i++) {
    const d = frames[i + 1].dts - frames[i].dts;
    out[i] = d > 0 ? d : 1;
  }
  let med = 3000;
  if (n > 1) {
    const ds = out.slice(0, n - 1).filter((d) => d > 0).sort((a, b) => a - b);
    if (ds.length) med = ds[ds.length >> 1];
  }
  out[n - 1] = med > 0 ? med : 3000;
  return out;
}

/* ==================================================================
 * 六、分片解析 parseSegment
 * ================================================================== */

/**
 * 解析一个 TS 分片，产出可直接写 fragment 的样本表。
 *
 * 返回：
 *   {
 *     hasVideo, hasAudio, sps, pps, profileIdc, constraints, levelIdc, width, height,
 *     asc, sampleRate, channels, audioObjectType,
 *     videoSamples: [{ dts, pts, duration, cts, key, data }],   // dts/pts 90kHz，data 为 AVCC
 *     audioSamples: [{ dts, pts, duration, data }],             // dts/pts 90kHz，duration 为采样数
 *     startDts, startPts, durationSec, badPackets, warnings
 *   }
 * 输入不是 TS（找不到 0x47 同步字节）时返回 null。
 */
function parseSegment(tsBuffer) {
  const warnings = [];
  if (!Buffer.isBuffer(tsBuffer) || !tsBuffer.length) return null;
  if (!looksLikeTs(tsBuffer)) return null;

  const d = demuxSegment(tsBuffer);
  const out = {
    hasVideo: false, hasAudio: false,
    sps: null, pps: null, profileIdc: 0, constraints: 0, levelIdc: 0,
    width: 0, height: 0,
    asc: null, sampleRate: 44100, channels: 2, audioObjectType: 2,
    videoSamples: [], audioSamples: [],
    startDts: 0, startPts: 0, durationSec: 0,
    badPackets: d.badPackets, warnings,
  };
  const unwrap = makeUnwrapper();

  /* ---------- 6.1 视频：PES → 访问单元 → AVCC ---------- */
  const vlist = d.videoPid >= 0 ? d.byPid.get(d.videoPid) || [] : [];
  const vframes = [];
  for (let i = 0; i < vlist.length; i++) {
    const pes = vlist[i];
    const h = parsePesHeader(pes);
    if (!h || h.pts == null) continue;
    const nals = splitAnnexB(pes.subarray(h.dataOffset));
    if (!nals.length) continue;
    if (!out.sps) {
      for (let k = 0; k < nals.length; k++) {
        if (nals[k].type === 7) {
          out.sps = Buffer.from(nals[k].data);
          const info = parseSps(nals[k].data);
          out.width = info.width;
          out.height = info.height;
          out.profileIdc = info.profileIdc;
          out.constraints = info.constraints;
          out.levelIdc = info.levelIdc;
        } else if (nals[k].type === 8) {
          out.pps = Buffer.from(nals[k].data);
        }
      }
    }
    const av = nalsToAvcc(nals);
    if (!av.data.length) continue;
    vframes.push({
      pts: unwrap('vpts', h.pts),
      dts: h.dts == null ? null : unwrap('vdts', h.dts),
      data: av.data,
      key: av.key,
    });
  }

  if (vframes.length && out.sps && out.pps) {
    out.hasVideo = true;
    const step = estimateFrameStep(vframes);
    rebuildDts(vframes, step);
    /* PTS 吸附到帧步长网格：避免个别非整格 PTS 与邻帧在输出刻度上相撞 */
    snapVideoPts(vframes, step);
    const durs = videoDurations(vframes);
    let negCts = 0;
    for (let i = 0; i < vframes.length; i++) {
      const f = vframes[i];
      /* 要求 PTS >= DTS；不满足时 cts 置 0（并按需警告），避免负 cts 破坏时间轴 */
      let cts = f.pts - f.dts;
      if (cts < 0) {
        negCts++;
        cts = 0;
      }
      out.videoSamples.push({
        dts: f.dts, pts: f.dts + cts, duration: durs[i], cts: cts, key: !!f.key, data: f.data,
      });
    }
    if (negCts) warnings.push('视频有 ' + negCts + ' 个样本 PTS<DTS，cts 已置 0');
  } else if (vframes.length) {
    warnings.push('未在分片内找到 SPS/PPS，视频轨失效');
  }

  /* ---------- 6.2 音频：PES → ADTS → 裸 AAC 帧 ---------- */
  const alist = d.audioPid >= 0 ? d.byPid.get(d.audioPid) || [] : [];
  let sr = 44100;
  let nextPts = null; /* 90kHz 播放时间轴（按帧数累加，遇到 PES PTS 明显偏离时重新对齐） */
  let stepTicks = 0;
  let dropped = 0;
  for (let i = 0; i < alist.length; i++) {
    const pes = alist[i];
    const h = parsePesHeader(pes);
    if (!h || h.pts == null) continue;
    const pesPts = unwrap('apts', h.pts);
    /* 先用第一帧确定采样率，才能算出 1024 采样对应的 90kHz tick 数 */
    if (!out.asc) {
      const first = parseAdts(pes, h.dataOffset);
      if (first) {
        sr = AAC_RATES[first.sfIndex] || 44100;
        out.asc = buildAsc(first.objectType, first.sfIndex, first.channelCfg);
        out.sampleRate = sr;
        out.channels = first.channelCfg || 2;
        out.audioObjectType = first.objectType;
      }
    }
    if (!stepTicks) stepTicks = (1024 * 90000) / sr;
    /* PES 自带的 PTS 与按帧数推算的时间轴比对：偏差超过 3 帧判定为丢帧/时间轴跳变 */
    if (nextPts == null) nextPts = pesPts;
    else if (Math.abs(pesPts - nextPts) > stepTicks * 3) nextPts = pesPts;

    let p = h.dataOffset;
    const end = pes.length;
    while (p + 7 <= end) {
      const ad = parseAdts(pes, p);
      if (!ad) break;
      const stop = Math.min(p + ad.frameLen, end);
      if (stop - p <= ad.headerLen) {
        dropped++; /* 分片尾部被截断的残帧 */
        break;
      }
      const pts = Math.round(nextPts);
      out.audioSamples.push({
        dts: pts, pts: pts, duration: 1024,
        data: Buffer.from(pes.subarray(p + ad.headerLen, stop)),
      });
      p = stop;
      nextPts += stepTicks;
    }
  }
  if (out.audioSamples.length && out.asc) out.hasAudio = true;
  else if (out.asc) warnings.push('音频参数已解析但没有完整 AAC 帧');
  if (dropped) warnings.push('跳过 ' + dropped + ' 个被截断的 AAC 残帧');

  /* ---------- 6.3 时间轴汇总 ---------- */
  const vFirst = out.videoSamples.length ? out.videoSamples[0] : null;
  const aFirst = out.audioSamples.length ? out.audioSamples[0] : null;
  if (vFirst) {
    out.startDts = vFirst.dts;
    out.startPts = vFirst.dts;
    for (let i = 0; i < out.videoSamples.length; i++) {
      const s = out.videoSamples[i];
      out.startPts = Math.min(out.startPts, s.dts + s.cts);
    }
  } else if (aFirst) {
    out.startDts = aFirst.dts;
    out.startPts = aFirst.dts;
  }
  /* 视频总时长（90kHz tick）：末样本 DTS + 其时长 − 起点；音频按 1024 采样/帧累加 */
  let vTicks = 0;
  if (vFirst) {
    const last = out.videoSamples[out.videoSamples.length - 1];
    vTicks = last.dts + last.duration - out.startDts;
  }
  const vDur = vTicks > 0 ? vTicks / 90000 : 0;
  const aDur = out.audioSamples.length ? (out.audioSamples.length * 1024) / sr : 0;
  out.videoDurationTicks = Math.max(0, vTicks);
  out.audioDurationSec = aDur;
  out.durationSec = Math.max(vDur, aDur);
  return out;
}

/* ==================================================================
 * 七、init 段：ftyp + moov（含 mvex/trex）
 * ================================================================== */

/** ftyp：isom + avc1 + mp41 兼容品牌 */
function buildFtyp() {
  const b = new BW();
  b.str('isom').u32(512).str('isom').str('iso2').str('avc1').str('mp41');
  return mkBox('ftyp', b);
}

/** avcC：H.264 解码器配置（含 SPS/PPS） */
function buildAvcC(sps, pps) {
  const b = new BW();
  b.u8(1).u8(sps[1]).u8(sps[2]).u8(sps[3]);
  b.u8(0xff); /* lengthSizeMinusOne = 3 → 4 字节长度前缀 */
  b.u8(0xe1); /* numOfSequenceParameterSets = 1 */
  b.u16(sps.length).raw(sps);
  b.u8(1); /* numOfPictureParameterSets */
  b.u16(pps.length).raw(pps);
  return mkBox('avcC', b);
}

/** esds：AAC 的解码器配置（objectTypeIndication 0x40 / streamType 0x15） */
function buildEsds(asc) {
  const dsi = mkDesc(0x05, asc);
  const dcdBody = new BW();
  dcdBody.u8(0x40); /* objectTypeIndication: MPEG-4 Audio */
  dcdBody.u8(0x15); /* streamType=5 (audio) <<2 | upStream=0 | reserved=1 */
  dcdBody.u24(6144); /* bufferSizeDB */
  dcdBody.u32(128000).u32(128000); /* maxBitrate / avgBitrate */
  dcdBody.raw(dsi);
  const dcd = mkDesc(0x04, dcdBody.toBuffer());
  const sl = mkDesc(0x06, Buffer.from([0x02]));
  const esBody = new BW();
  esBody.u16(1).u8(0);
  esBody.raw(dcd).raw(sl);
  return mkFullBox('esds', 0, 0, new BW().raw(mkDesc(0x03, esBody.toBuffer())));
}

/** 视频 sample entry：avc1（内含 avcC） */
function buildAvc1(ctx) {
  const b = new BW();
  b.raw(Buffer.alloc(6)).u16(1); /* reserved + data_reference_index */
  b.u16(0).u16(0).u32(0).u32(0).u32(0);
  b.u16(ctx.width).u16(ctx.height);
  b.u32(0x00480000).u32(0x00480000).u32(0); /* 72dpi */
  b.u16(1);
  b.raw(Buffer.alloc(32)); /* compressorname */
  b.u16(0x0018).u16(0xffff); /* depth 24, pre_defined -1 */
  b.raw(buildAvcC(ctx.sps, ctx.pps));
  return mkBox('avc1', b);
}

/** 音频 sample entry：mp4a（内含 esds） */
function buildMp4a(ctx) {
  const b = new BW();
  b.raw(Buffer.alloc(6)).u16(1);
  b.u32(0).u32(0); /* reserved */
  b.u16(ctx.channels).u16(16).u16(0).u16(0);
  b.u32(ctx.sampleRate << 16); /* 整数部分 16 位 + 小数部分 16 位 */
  b.raw(buildEsds(ctx.asc));
  return mkBox('mp4a', b);
}

/** 空表：fMP4 的样本表在 moov 里全为空，实际数据由 moof/trun 描述 */
function buildEmptyTables(entry) {
  const b = new BW();
  const stsdBody = new BW();
  stsdBody.u32(1).raw(entry);
  b.raw(mkFullBox('stsd', 0, 0, stsdBody));
  b.raw(mkFullBox('stts', 0, 0, new BW().u32(0))); /* entry_count = 0 */
  b.raw(mkFullBox('stsc', 0, 0, new BW().u32(0)));
  b.raw(mkFullBox('stsz', 0, 0, new BW().u32(0).u32(0))); /* sample_size=0, sample_count=0 */
  b.raw(mkFullBox('stco', 0, 0, new BW().u32(0)));
  return mkBox('stbl', b);
}

/** minf：媒体信息容器 */
function buildMinf(kind, stbl) {
  const b = new BW();
  if (kind === 'vide') {
    const vmhd = new BW();
    vmhd.u16(0).u16(0).u16(0).u16(0); /* graphicsmode + opcolor[3] */
    b.raw(mkFullBox('vmhd', 0, 1, vmhd));
  } else {
    b.raw(mkFullBox('smhd', 0, 0, new BW().u16(0).u16(0)));
  }
  const url = mkFullBox('url ', 0, 1, null);
  const drefBody = new BW();
  drefBody.u32(1).raw(url);
  b.raw(mkBox('dinf', new BW().raw(mkFullBox('dref', 0, 0, drefBody))));
  b.raw(stbl);
  return mkBox('minf', b);
}

/** mdia：媒体头 + 处理器 + minf */
function buildMdia(kind, timescale, duration, stbl) {
  const mdhd = new BW();
  mdhd.u32(0).u32(0).u32(timescale).u32(duration);
  mdhd.u16(0x55c4).u16(0); /* language = 'und' */
  const handlerName = kind === 'vide' ? 'VideoHandler' : 'SoundHandler';
  const hdlr = new BW();
  hdlr.u32(0).str(kind).u32(0).u32(0).u32(0);
  hdlr.str(handlerName).u8(0);
  const b = new BW();
  b.raw(mkFullBox('mdhd', 0, 0, mdhd));
  b.raw(mkFullBox('hdlr', 0, 0, hdlr));
  b.raw(buildMinf(kind, stbl));
  return mkBox('mdia', b);
}

/** tkhd：轨道头（fMP4 里 duration 写 0，实际时长由 fragment 决定） */
function buildTkhd(trackId, width, height, isAudio) {
  const b = new BW();
  b.u32(0).u32(0).u32(trackId).u32(0).u32(0); /* creation/modification/track_id/reserved/duration */
  b.u32(0).u32(0);
  b.u16(0).u16(0);
  b.u16(isAudio ? 0x0100 : 0);
  b.u16(0);
  unityMatrix(b);
  b.u32(isAudio ? 0 : width << 16);
  b.u32(isAudio ? 0 : height << 16);
  return mkFullBox('tkhd', 0, 3, b); /* flags 3 = enabled | in_movie */
}

/** mvhd：影片头（timescale 1000，duration 0 → 分片流式） */
function buildMvhd(nextTrackId) {
  const b = new BW();
  b.u32(0).u32(0).u32(1000).u32(0);
  b.u32(0x00010000); /* rate 1.0 */
  b.u16(0x0100).u16(0); /* volume 1.0 + reserved */
  b.u32(0).u32(0);
  unityMatrix(b);
  b.raw(Buffer.alloc(24)); /* pre_defined[6] */
  b.u32(nextTrackId);
  return mkFullBox('mvhd', 0, 0, b);
}

/**
 * trex：每个轨道一条缺省样本描述。
 * default_sample_duration 写 0（真实时长在 trun 里逐样本给出），
 * default_sample_flags 按轨道类型给：视频非关键帧 0x01010000，音频 0x02000000。
 */
function buildTrex(trackId, defDuration, defFlags) {
  const b = new BW();
  b.u32(trackId).u32(1).u32(defDuration).u32(0).u32(defFlags);
  return mkFullBox('trex', 0, 0, b);
}

/**
 * 生成 init 段：ftyp + moov。
 * moov = mvhd + trak(video,id=1) + trak(audio,id=2) + mvex(trex×2)。
 * 同一路流的所有分片共用这个 init，可以缓存。
 */
function buildInit(parsed) {
  const hasVideo = !!(parsed && parsed.hasVideo && parsed.sps && parsed.pps);
  const hasAudio = !!(parsed && parsed.hasAudio && parsed.asc);
  const sr = (parsed && parsed.sampleRate) || 44100;

  const b = new BW();
  b.raw(buildMvhd((hasVideo ? 1 : 0) + (hasAudio ? 1 : 0) + 1));

  if (hasVideo) {
    const stbl = buildEmptyTables(buildAvc1({
      width: parsed.width, height: parsed.height, sps: parsed.sps, pps: parsed.pps,
    }));
    b.raw(mkBox('trak', new BW()
      .raw(buildTkhd(1, parsed.width, parsed.height, false))
      .raw(buildMdia('vide', 90000, 0, stbl))));
  }
  if (hasAudio) {
    const stbl = buildEmptyTables(buildMp4a({
      channels: parsed.channels || 2, sampleRate: sr, asc: parsed.asc,
    }));
    b.raw(mkBox('trak', new BW()
      .raw(buildTkhd(2, 0, 0, true))
      .raw(buildMdia('soun', sr, 0, stbl))));
  }

  const mv = new BW();
  if (hasVideo) mv.raw(buildTrex(1, 0, 0x01010000));
  if (hasAudio) mv.raw(buildTrex(2, 1024, 0x02000000));
  b.raw(mkBox('mvex', mv));

  return Buffer.concat([buildFtyp(), mkBox('moov', b)]);
}

/* ==================================================================
 * 八、media 段：moof + mdat
 * ================================================================== */

let SEQ = 0; /* 模块级 mfhd sequence_number 自增游标 */

/** mfhd：分片序号 */
function buildMfhd(seq) {
  return mkFullBox('mfhd', 0, 0, new BW().u32(seq >>> 0));
}

/**
 * tfhd：轨道 fragment 头。
 * flags = 0x020000（default-base-is-moof），trun 的 data_offset 因此相对 moof 起点。
 * 不写 default_sample_duration/size/flags——全部逐样本在 trun 里给出，避免两处冲突。
 */
function buildTfhd(trackId) {
  return mkFullBox('tfhd', 0, 0x020000, new BW().u32(trackId));
}

/** tfdt：base media decode time（version 1，64 位） */
function buildTfdt(baseTime) {
  const t = Math.max(0, Math.round(baseTime));
  return mkFullBox('tfdt', 1, 0, new BW().u64(t));
}

/** trun 的 sample-flags 位 */
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;

/**
 * trun：样本表。version 1（composition offset 允许为负，本项目通常非负）。
 * 每样本写 duration / size / flags，视频另写 composition offset。
 */
function buildTrun(track, dataOffset, withCts) {
  let flags = TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS;
  if (withCts) flags |= TRUN_SAMPLE_CTS;
  const b = new BW();
  b.u8(1).u24(flags);
  b.u32(track.length);
  b.i32(dataOffset);
  for (let i = 0; i < track.length; i++) {
    const s = track[i];
    b.u32(s.duration > 0 ? s.duration : 1);
    b.u32(s.data.length);
    b.u32(s.flags);
    if (withCts) b.i32(s.cts | 0);
  }
  return mkBox('trun', b);
}

/**
 * 组装一条 traf。
 * @param {number} trackId 1=视频 2=音频
 * @param {Array} track 样本数组（已带 duration/size/flags/cts）
 * @param {number} baseTime tfdt 的 baseMediaDecodeTime（本轨 timescale）
 * @param {number} dataOffset 相对 moof 起点的样本数据偏移
 */
function buildTraf(trackId, track, baseTime, dataOffset, withCts) {
  const b = new BW();
  b.raw(buildTfhd(trackId));
  b.raw(buildTfdt(baseTime));
  b.raw(buildTrun(track, dataOffset, withCts));
  return mkBox('traf', b);
}

/**
 * 组装 moof。data_offset 依赖 moof 自身长度，所以先用占位 0 量出长度，
 * 再用真实偏移重建一次（box 长度与偏移数值无关，两次结果长度一致）。
 */
function buildMoof(parsed, seq, vOff, aOff) {
  const b = new BW();
  b.raw(buildMfhd(seq));
  if (parsed.videoTraf) {
    b.raw(buildTraf(1, parsed.videoTraf, parsed.videoBase, vOff, true));
  }
  if (parsed.audioTraf) {
    b.raw(buildTraf(2, parsed.audioTraf, parsed.audioBase, aOff, false));
  }
  return mkBox('moof', b);
}

/** mdat 头：32 位 size 只到 4GB，超过时退化为 size=1 + 64 位 largesize */
function mdatHeader(payloadBytes) {
  if (payloadBytes + 8 > 0xfffffff0) {
    const h = Buffer.allocUnsafe(16);
    h.writeUInt32BE(1, 0);
    h.write('mdat', 4, 'latin1');
    const size = payloadBytes + 16;
    const hi = Math.floor(size / 4294967296);
    h.writeUInt32BE(hi, 8);
    h.writeUInt32BE(size - hi * 4294967296, 12);
    return h;
  }
  const h = Buffer.allocUnsafe(8);
  h.writeUInt32BE(payloadBytes + 8, 0);
  h.write('mdat', 4, 'latin1');
  return h;
}

/**
 * 生成一个 media 段：moof + mdat。
 * mdat 里的样本顺序固定为「先 video 全部、再 audio 全部」，
 * 两个 traf 的 trun.data_offset 分别指向各自首样本在文件里的位置。
 *
 * @param {object} parsed parseSegment 的返回值
 * @param {object} [opts]
 *        opts.seq      分片序号（缺省用模块级自增）
 *        opts.baseDts  视频 tfdt 归零点（缺省 0，即用展开后的绝对 DTS）
 * @returns {Buffer}
 */
function buildMedia(parsed, opts) {
  const o = opts || {};
  const seq = o.seq == null ? ++SEQ : o.seq;
  const hasBase = typeof o.baseDts === 'number' && isFinite(o.baseDts) && o.baseDts >= 0;
  /* 平移量：给出 baseDts 时把本片首样本 DTS 拉到 baseDts；否则保持原始绝对时间轴 */
  const shift = hasBase ? o.baseDts - parsed.startDts : 0;
  const sr = parsed.sampleRate || 44100;

  /* 1) 归一化样本表：视频补 flags/cts，音频补 flags（全部 sync） */
  const vSamples = parsed.hasVideo ? parsed.videoSamples : null;
  const aSamples = parsed.hasAudio ? parsed.audioSamples : null;

  const vTrack = [];
  if (vSamples && vSamples.length) {
    for (let i = 0; i < vSamples.length; i++) {
      const s = vSamples[i];
      vTrack.push({
        duration: s.duration > 0 ? s.duration : 1,
        data: s.data,
        flags: s.key ? 0x02000000 : 0x01010000,
        cts: s.cts > 0 ? s.cts : 0,
      });
    }
  }
  const aTrack = [];
  if (aSamples && aSamples.length) {
    for (let i = 0; i < aSamples.length; i++) {
      const s = aSamples[i];
      aTrack.push({
        duration: s.duration > 0 ? s.duration : 1024,
        data: s.data,
        flags: 0x02000000,
        cts: 0,
      });
    }
  }

  /* 2) 计算各轨字节数与 tfdt 基时间 */
  let vBytes = 0;
  for (let i = 0; i < vTrack.length; i++) vBytes += vTrack[i].data.length;
  let aBytes = 0;
  for (let i = 0; i < aTrack.length; i++) aBytes += aTrack[i].data.length;

  /* tfdt 基时间：视频 timescale 固定 90000；音频 timescale = sampleRate，需要换算。
   * 两条轨用同一个 shift 平移，音视频相对关系保持不变；任何情况下都不允许为负。 */
  let videoBase = 0;
  if (vTrack.length) videoBase = Math.max(0, Math.round(parsed.startDts + shift));
  let audioBase = 0;
  if (aTrack.length && aSamples.length) {
    audioBase = Math.round(((aSamples[0].dts + shift) * sr) / 90000);
    if (audioBase < 0) audioBase = 0;
  }
  const ctx = {
    videoTraf: vTrack.length ? vTrack : null,
    audioTraf: aTrack.length ? aTrack : null,
    videoBase: videoBase,
    audioBase: audioBase,
  };

  /* 3) 先量 moof 长度（偏移占位 0），再按真实偏移重建 */
  const probeMoof = buildMoof(ctx, seq, 0, 0);
  const hdr = mdatHeader(vBytes + aBytes);
  const vOff = probeMoof.length + hdr.length;
  const aOff = vOff + vBytes;
  const moof = buildMoof(ctx, seq, vOff, aOff);
  /* 理论上两次长度一致；不一致说明结构有问题，直接按实际长度修正一次 */
  let vOff2 = moof.length + hdr.length;
  let aOff2 = vOff2 + vBytes;
  const moof2 = (vOff2 === vOff && aOff2 === aOff) ? moof : buildMoof(ctx, seq, vOff2, aOff2);

  /* 4) mdat：头 + 视频样本 + 音频样本 */
  const parts = [moof2, hdr];
  if (vTrack.length) {
    const vb = Buffer.allocUnsafe(vBytes);
    let o1 = 0;
    for (let i = 0; i < vTrack.length; i++) {
      vTrack[i].data.copy(vb, o1);
      o1 += vTrack[i].data.length;
    }
    parts.push(vb);
  }
  if (aTrack.length) {
    const ab = Buffer.allocUnsafe(aBytes);
    let o2 = 0;
    for (let i = 0; i < aTrack.length; i++) {
      aTrack[i].data.copy(ab, o2);
      o2 += aTrack[i].data.length;
    }
    parts.push(ab);
  }
  return Buffer.concat(parts);
}

/* ==================================================================
 * 九、codec 字符串
 * ================================================================== */

/** 两位小写十六进制 */
function hex2(v) {
  const s = (v & 0xff).toString(16);
  return s.length < 2 ? '0' + s : s;
}

/**
 * MSE addSourceBuffer 用的 codecs 字符串：
 *   'avc1.' + profile + constraints + level + ',mp4a.40.' + audioObjectType
 * 只有视频时返回 'avc1.xxxxxx'，只有音频时返回 'mp4a.40.2'。
 */
function codecString(parsed) {
  const parts = [];
  if (parsed && parsed.hasVideo && parsed.sps) {
    parts.push('avc1.' + hex2(parsed.profileIdc) + hex2(parsed.constraints) + hex2(parsed.levelIdc));
  }
  if (parsed && parsed.hasAudio && parsed.asc) {
    const aot = parsed.audioObjectType || (parsed.asc[0] >> 3) || 2;
    parts.push('mp4a.40.' + aot);
  }
  return parts.join(',');
}

/* ==================================================================
 * 十、对外 API
 * ================================================================== */

/**
 * 一次调用完成解析 + 封装。
 * 失败返回 { ok:false, error }，不抛异常。
 *
 * @param {Buffer} tsBuffer 一个 TS 分片
 * @param {object} [opts] { seq, baseDts }
 */
function convert(tsBuffer, opts) {
  try {
    const parsed = parseSegment(tsBuffer);
    if (!parsed) {
      return { ok: false, error: '输入不是 MPEG-TS（未找到 0x47 同步字节）' };
    }
    if (!parsed.hasVideo && !parsed.hasAudio) {
      return { ok: false, error: '分片内没有可用的 H.264 / AAC 轨道' };
    }
    const init = buildInit(parsed);
    const media = buildMedia(parsed, opts);
    const codec = codecString(parsed);
    if (!codec) {
      return { ok: false, error: '无法生成 codec 字符串（缺少 SPS 或 ASC）' };
    }
    const hasBase = opts && typeof opts.baseDts === 'number' && isFinite(opts.baseDts) && opts.baseDts >= 0;
    const origin = hasBase ? opts.baseDts : parsed.startDts;
    /* 本片末样本 DTS + 尾部时长（90kHz）；nextDts 供调用方串联下一片。
     * 纯音频分片没有视频时长，这里退回按音频采样数换算，避免 nextDts 原地不动。 */
    let totalTicks = Math.max(0, Math.round(parsed.videoDurationTicks || 0));
    if (!totalTicks && parsed.audioSamples.length) {
      totalTicks = Math.round((parsed.audioSamples.length * 1024 * 90000) / (parsed.sampleRate || 44100));
    }
    const res = {
      ok: true,
      init,
      media,
      codec,
      width: parsed.width || 0,
      height: parsed.height || 0,
      sampleRate: parsed.sampleRate || 0,
      channels: parsed.channels || 0,
      startDts: origin,
      nextDts: origin + totalTicks,
      durationSec: parsed.durationSec,
      videoSamples: parsed.videoSamples.length,
      audioSamples: parsed.audioSamples.length,
      warnings: parsed.warnings.slice(),
    };
    if (!parsed.hasVideo) res.warnings.push('分片内没有视频轨');
    if (!parsed.hasAudio) res.warnings.push('分片内没有音频轨');
    if (parsed.badPackets) res.warnings.push('跳过 ' + parsed.badPackets + ' 个损坏的 TS 包');
    return res;
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { convert, parseSegment, buildInit, buildMedia, codecString };
