'use strict';
/**
 * ts2mp4.js — 纯 JavaScript 的 MPEG-TS → MP4 重封装内核（零第三方依赖）
 *
 * 设计要点：
 *  - 只依赖 Node 内置 fs / Buffer，不使用任何外部进程或 npm 包。
 *  - 大文件友好：解析与写 mdat 同步进行，只在内存里保留 sample 表（每帧几十字节），
 *    不把整段媒体拼成巨型 Buffer。mdat 大小写完后回填，moov 追加到文件末尾。
 *  - 时间戳：33 位 PTS/DTS，支持 33 位回绕与分片时间轴重置。
 *  - 视频：H.264 Annex-B → AVCC（4 字节长度前缀），SPS/PPS 写入 avcC。
 *  - 音频：ADTS → 裸 AAC，ASC 写入 esds。
 *
 * 用法：
 *   const t2m = require('./ts2mp4');
 *   const r = await t2m.remuxFiles(tsPaths, outMp4Path, (p) => console.log(p.done + '/' + p.total));
 *   // r = { ok, bytes, durationSec, video:{codec,width,height,profile}, audio:{...}|null, error? }
 *
 * 输入：已解密的 MPEG-TS 分片（188 / 192 字节包长均可），H.264 + AAC-LC。
 * 输出：单文件 MP4（ftyp + mdat + moov，moov 在尾部），可直接被浏览器 / ffmpeg 播放。
 */

const fs = require('fs');

/* ==================================================================
 * 一、基础工具
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
BW.prototype.str = function (s) {
  return this.push(Buffer.from(s, 'latin1'));
};
BW.prototype.raw = function (b) {
  return this.push(b);
};
BW.prototype.toBuffer = function () {
  return Buffer.concat(this.parts, this.len);
};

/** 组装一个普通 box：8 字节头 + 内容（content 可以是 BW，也可以是已编码的 Buffer） */
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
  if (content) b.push(content.toBuffer());
  return mkBox(type, b);
}

/** MP4 里的单位矩阵（9 个 32 位定点数） */
function unityMatrix(b) {
  b.u32(0x00010000).u32(0).u32(0);
  b.u32(0).u32(0x00010000).u32(0);
  b.u32(0).u32(0).u32(0x40000000);
  return b;
}

/** MPEG-4 描述符长度编码（可扩展的 7 位小端分组） */
function encodeDescLen(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    out.unshift(0x80 | (n & 0x7f));
    n >>= 7;
  }
  return Buffer.from(out);
}

/** 带缓冲的文件顺序写入器：把碎片写合并成 1MB 级的大块 IO */
function OutFile(fd) {
  this.fd = fd;
  this.pos = 0;
  this.parts = [];
  this.pending = 0;
}
OutFile.prototype.tell = function () {
  return this.pos + this.pending;
};
OutFile.prototype.write = function (buf) {
  if (!buf || !buf.length) return;
  this.parts.push(buf);
  this.pending += buf.length;
  if (this.pending >= 1 << 20) this.flush();
};
OutFile.prototype.flush = function () {
  if (!this.pending) return;
  const b = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.pending);
  let off = 0;
  while (off < b.length) {
    const n = fs.writeSync(this.fd, b, off, b.length - off, this.pos + off);
    if (!(n > 0)) throw new Error('写文件失败（writeSync 返回 ' + n + '）');
    off += n;
  }
  this.pos += b.length;
  this.parts = [];
  this.pending = 0;
};
OutFile.prototype.patch = function (buf, at) {
  this.flush();
  fs.writeSync(this.fd, buf, 0, buf.length, at);
};

/* ==================================================================
 * 二、MPEG-TS 解复用层
 * ================================================================== */

const TS_SYNC = 0x47;
const TS_MOD = 8589934592; /* 2^33，33 位时间戳回绕模数 */

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

/**
 * 遍历所有 TS 包。对每个包回调 onPacket(pid, pusi, payload)。
 * payload 是 Buffer 视图（零拷贝），指向该包净荷。
 */
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
 * 三、H.264 解析与转换
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

/** 跳过一段 scaling list（只是占位，不解析具体系数） */
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
 * 宽高按 H.264 的宏块数与 croppings 换算。
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

/**
 * 从 Annex-B 字节流切出所有 NAL 单元（返回视图，零拷贝）。
 */
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
 * 丢弃 AUD(9)/SPS(7)/PPS(8)，它们要么无意义要么已进 avcC。
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
 * 四、AAC / ADTS 解析
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
 * 五、MP4 box 构造
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
  b.u8(0xff); /* lengthSizeMinusOne = 3 */
  b.u8(0xe1); /* numOfSequenceParameterSets = 1 */
  b.u16(sps.length).raw(sps);
  b.u8(1); /* numOfPictureParameterSets */
  b.u16(pps.length).raw(pps);
  return mkBox('avcC', b);
}

/** 一段 MPEG-4 描述符：tag + 长度 + 内容 */
function mkDesc(tag, payload) {
  return Buffer.concat([Buffer.from([tag]), encodeDescLen(payload.length), payload]);
}

/** esds：AAC 的解码器配置（含 ASC） */
function buildEsds(asc, avgBitrate) {
  const dsi = mkDesc(0x05, asc);
  const dcdBody = new BW();
  dcdBody.u8(0x40); /* objectTypeIndication: MPEG-4 Audio */
  dcdBody.u8(0x15); /* streamType=5 (audio) <<2 | upStream=0 | reserved=1 */
  dcdBody.u24(6144); /* bufferSizeDB */
  dcdBody.u32(avgBitrate).u32(avgBitrate);
  dcdBody.raw(dsi);
  const dcd = mkDesc(0x04, dcdBody.toBuffer());
  const sl = mkDesc(0x06, Buffer.from([0x02]));
  const esBody = new BW();
  esBody.u16(1).u8(0);
  esBody.raw(dcd).raw(sl);
  return mkFullBox('esds', 0, 0, new BW().raw(mkDesc(0x03, esBody.toBuffer())));
}

/** 视频 sample entry：avc1 */
function buildAvc1(ctx) {
  const b = new BW();
  b.raw(Buffer.alloc(6)).u16(1);
  b.u16(0).u16(0).u32(0).u32(0).u32(0);
  b.u16(ctx.width).u16(ctx.height);
  b.u32(0x00480000).u32(0x00480000).u32(0);
  b.u16(1);
  b.raw(Buffer.alloc(32)); /* compressorname */
  b.u16(0x0018).u16(0xffff);
  b.raw(buildAvcC(ctx.sps, ctx.pps));
  /* stsd 里的 sample entry 自己也带 8 字节 box 头（size + 'avc1'） */
  return mkBox('avc1', b);
}

/** 音频 sample entry：mp4a */
function buildMp4a(ctx) {
  const b = new BW();
  b.raw(Buffer.alloc(6)).u16(1);
  b.u32(0).u32(0);
  b.u16(ctx.channels).u16(16).u16(0).u16(0);
  b.u32(ctx.sampleRate << 16);
  b.raw(buildEsds(ctx.asc, ctx.avgBitrate));
  /* 同样需要 8 字节 box 头 */
  return mkBox('mp4a', b);
}

/** stts：把相邻相同 delta 合并成 (count, delta) 项 */
function buildStts(deltas) {
  const entries = [];
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i] > 0 ? deltas[i] : 1;
    const last = entries.length ? entries[entries.length - 1] : null;
    if (last && last[1] === d) last[0]++;
    else entries.push([1, d]);
  }
  const b = new BW();
  b.u32(entries.length);
  for (let i = 0; i < entries.length; i++) b.u32(entries[i][0]).u32(entries[i][1]);
  return mkFullBox('stts', 0, 0, b);
}

/** ctts：composition offset（有 B 帧重排时才需要） */
function buildCtts(offsets) {
  const entries = [];
  for (let i = 0; i < offsets.length; i++) {
    const o = offsets[i];
    const last = entries.length ? entries[entries.length - 1] : null;
    if (last && last[1] === o) last[0]++;
    else entries.push([1, o]);
  }
  const b = new BW();
  b.u32(entries.length);
  for (let i = 0; i < entries.length; i++) b.u32(entries[i][0]).i32(entries[i][1]);
  return mkFullBox('ctts', 1, 0, b);
}

/** stss：关键帧（sample 序号从 1 开始） */
function buildStss(keys) {
  const b = new BW();
  b.u32(keys.length);
  for (let i = 0; i < keys.length; i++) b.u32(keys[i]);
  return mkFullBox('stss', 0, 0, b);
}

/** stsc：每 sample 独立成 chunk，因此只有一条记录 */
function buildStsc() {
  const b = new BW();
  b.u32(1).u32(1).u32(1).u32(1);
  return mkFullBox('stsc', 0, 0, b);
}

/** stsz：记录每个 sample 的字节数 */
function buildStsz(sizes) {
  const b = new BW();
  b.u32(0).u32(sizes.length);
  for (let i = 0; i < sizes.length; i++) b.u32(sizes[i]);
  return mkFullBox('stsz', 0, 0, b);
}

/** stco / co64：每个 chunk 在文件中的偏移 */
function buildStco(offsets) {
  let need64 = false;
  for (let i = 0; i < offsets.length; i++) if (offsets[i] > 0xffffffff) need64 = true;
  const b = new BW();
  b.u32(offsets.length);
  if (need64) {
    for (let i = 0; i < offsets.length; i++) {
      const hi = Math.floor(offsets[i] / 4294967296);
      b.u32(hi).u32(offsets[i] - hi * 4294967296);
    }
    return mkFullBox('co64', 0, 0, b);
  }
  for (let i = 0; i < offsets.length; i++) b.u32(offsets[i]);
  return mkFullBox('stco', 0, 0, b);
}

/**
 * stbl：sample table 的完整装配。
 * box 顺序按 ISO/IEC 14496-12 建议：stsd → stts → ctts → stss → stsc → stsz → stco。
 */
function buildStbl(s) {
  const stsdBody = new BW();
  stsdBody.u32(1).raw(s.entry);
  const b = new BW();
  b.raw(mkFullBox('stsd', 0, 0, stsdBody));
  b.raw(buildStts(s.deltas));
  /* 只有确实存在 B 帧重排（composition offset 非全 0）才写 ctts */
  if (s.ctts && s.ctts.some((x) => x !== 0)) b.raw(buildCtts(s.ctts));
  if (s.keys && s.keys.length) b.raw(buildStss(s.keys));
  b.raw(buildStsc());
  b.raw(buildStsz(s.sizes));
  b.raw(buildStco(s.offsets));
  return mkBox('stbl', b);
}

/** minf：媒体信息容器 */
function buildMinf(kind, stbl) {
  const b = new BW();
  if (kind === 'vide') {
    /* vmhd 内容：graphicsmode(16) + opcolor[3](16*3) = 8 字节 */
    const vmhd = new BW();
    vmhd.u16(0).u16(0).u16(0).u16(0);
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

/** tkhd：轨道头 */
function buildTkhd(trackId, durationMs, width, height, isAudio) {
  const b = new BW();
  b.u32(0).u32(0).u32(trackId).u32(0).u32(durationMs);
  b.u32(0).u32(0);
  b.u16(0).u16(0);
  b.u16(isAudio ? 0x0100 : 0);
  b.u16(0);
  unityMatrix(b);
  b.u32(isAudio ? 0 : width << 16);
  b.u32(isAudio ? 0 : height << 16);
  return mkFullBox('tkhd', 0, 3, b);
}

/**
 * edts/elst：编辑表。
 * 用来把轨道首帧的 composition offset（B 帧重排造成的正向偏移）
 * 从呈现时间轴上裁掉，让 start_time 归 0，与 ffmpeg 产出的 mp4 保持一致。
 */
function buildEdts(segmentDurationMs, mediaTimeMs, mediaTimescale) {
  const mediaTime = Math.max(0, Math.round((mediaTimeMs / 1000) * mediaTimescale));
  const b = new BW();
  b.u32(1); /* entry_count */
  b.u32(segmentDurationMs);
  b.i32(mediaTime);
  b.u16(1).u16(0); /* media_rate = 1.0 */
  return mkBox('edts', mkFullBox('elst', 0, 0, b));
}

/** trak：单条轨道 */
function buildTrak(opts) {
  const b = new BW();
  b.raw(buildTkhd(opts.trackId, opts.durationMs, opts.width, opts.height, opts.kind !== 'vide'));
  if (opts.mediaTimeSec > 0) {
    b.raw(buildEdts(opts.durationMs, opts.mediaTimeSec * 1000, opts.timescale));
  }
  b.raw(buildMdia(opts.kind, opts.timescale, opts.duration, opts.stbl));
  return mkBox('trak', b);
}

/** mvhd：影片头 */
function buildMvhd(durationMs, nextTrackId) {
  const b = new BW();
  b.u32(0).u32(0).u32(1000).u32(durationMs);
  b.u32(0x00010000);
  b.u16(0x0100).u16(0).u32(0).u32(0);
  unityMatrix(b);
  b.raw(Buffer.alloc(24));
  b.u32(nextTrackId);
  return mkFullBox('mvhd', 0, 0, b);
}

/* ==================================================================
 * 六、时间戳重建
 * ================================================================== */

/** 对缺失的 DTS 做线性插值，并强制单调递增 */
function rebuildDts(frames, fallbackStep) {
  const n = frames.length;
  const known = [];
  for (let i = 0; i < n; i++) if (frames[i].dts != null) known.push(i);
  if (!known.length) {
    for (let i = 0; i < n; i++) frames[i].dts = i * fallbackStep;
    return;
  }
  /* 首尾外推 */
  const step = fallbackStep > 0 ? fallbackStep : 1;
  for (let i = known[0] - 1; i >= 0; i--) {
    frames[i].dts = frames[i + 1].dts - step;
  }
  for (let i = known[known.length - 1] + 1; i < n; i++) {
    frames[i].dts = frames[i - 1].dts + step;
  }
  /* 中间线性插值 */
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
  /* 单调修复：任何后退都按最小步长往前推 */
  for (let i = 1; i < n; i++) {
    if (frames[i].dts <= frames[i - 1].dts) frames[i].dts = frames[i - 1].dts + step;
  }
}

/**
 * 计算音频每帧的 sample 时长（单位：采样数）。
 * AAC 每帧固定 1024 采样；若相邻 PTS 的实测间隔偏离明显（时间轴被切/漂移），
 * 用实测值对齐，避免累计误差把音画拉歪。
 */
function buildAudioDeltas(frames, sampleRate) {
  const n = frames.length;
  const out = new Array(n);
  if (!n) return out;
  const nominal = 1024;
  for (let i = 0; i < n; i++) out[i] = nominal;
  /* 相邻 PTS 差值（90kHz）→ 采样数 */
  for (let i = 0; i < n - 1; i++) {
    const dTs = frames[i + 1].pts - frames[i].pts;
    if (dTs <= 0) continue;
    const samples = Math.round((dTs / 90000) * sampleRate);
    /* 只采纳接近名义值的实测间隔，避免个别坏 PTS 把整条音轨拉坏 */
    if (samples >= nominal - 64 && samples <= nominal + 64) out[i] = samples;
  }
  if (n > 1) out[n - 1] = out[n - 2];
  return out;
}

/**
 * 估算视频帧步长：取 PTS 排序后相邻差值的**众数**（出现次数最多的正差值）。
 * 不能用最小值：尾部偶发的半帧间隔（如 750 ticks）会把整体步长带偏一个数量级，
 * 进而让后面的 DTS 插值与 PTS 吸附全部失准。
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
    /* 次数优先；同次数时取较小差值（帧步长一定小于等于常见的重排差值） */
    if (n > bestN || (n === bestN && d < best)) { best = d; bestN = n; }
  });
  return best > 0 ? best : 3000;
}

/**
 * 把视频 PTS 吸附到"帧步长整数倍"的网格上，并保证呈现顺序严格递增。
 * 目的：某些源（含本样本）会出现个别 PTS 偏离网格（如 15582000 = 4155.2 帧），
 * 与相邻帧在 1/24 输出网格上撞到同一刻度，导致下游按 CFR 处理时报
 * "non monotonically increasing dts"。吸附后每帧独占一个刻度。
 * 只在发生撞格时推动后续帧，其余帧时间戳保持不变。
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

/** 让当前分片的时间戳接上前一片，处理回绕与时间轴重置 */
function alignSegment(prevLast, rawFirst, offset, step) {
  if (prevLast == null || rawFirst == null) return offset;
  const cand = rawFirst + offset;

  /* 情况 A：接得上（允许半帧以内的轻微倒退，正常分片衔接就落在这里） */
  if (cand >= prevLast - step) return offset;

  const gap = prevLast - cand;
  /* 情况 B：倒退幅度接近模数 → 33 位时间戳回绕，整体加一圈 */
  if (gap > TS_MOD / 2) return offset + TS_MOD;

  /* 情况 C：分片时间轴从 0 重启（CDN 常见）：把本片整体平移到上一片之后 */
  return offset + gap + step;
}

/* ==================================================================
 * 七、主解析流程
 * ================================================================== */

/**
 * 解析全部分片，把 ES 数据按到达顺序写入 sink，并记录 sample 表。
 * sink 为 null 时只收集元数据（probe 用）。
 */
function parseAllSources(getSource, count, sink, onProgress) {
  const acc = {
    vFrames: [], aFrames: [], sps: null, pps: null, asc: null,
    sampleRate: 44100, channels: 2, width: 0, height: 0,
    profile: 'High', profileIdc: 0, levelIdc: 0,
    errors: 0, badPackets: 0,
  };
  /* 跨分片的时间轴状态：累计偏移 + 上一片的末个时间戳（用于识别回绕/重置） */
  const st = { vOff: 0, aOff: 0, lastVDts: null, lastADts: null };
  const total = count;

  for (let si = 0; si < total; si++) {
    /* 一次只持有一个分片：解析完立刻释放，避免 1GB 级课程把内存吃满 */
    const d = demuxSegment(getSource(si));
    acc.badPackets += d.badPackets;
    collectVideoOfSegment(d, acc, sink, st);
    collectAudioOfSegment(d, acc, sink, st);
    if (onProgress && (si % 2 === 0 || si === total - 1)) {
      onProgress({ phase: 'parse', done: si + 1, total });
    }
  }
  return acc;
}

/** 处理单个分片的视频 PES：解析 SPS/PPS、Annex-B 转 AVCC、写 mdat 并记录 sample */
function collectVideoOfSegment(d, acc, sink, st) {
  const list = d.videoPid >= 0 ? d.byPid.get(d.videoPid) || [] : [];
  const tmp = [];
  for (let i = 0; i < list.length; i++) {
    const h = parsePesHeader(list[i]);
    if (!h || h.pts == null) continue;
    tmp.push({ pes: list[i], pts: h.pts, dts: h.dts, off: h.dataOffset });
  }
  if (!tmp.length) return;

  const step = estimateFrameStep(tmp);
  const firstDts = tmp.find((f) => f.dts != null);
  st.vOff = alignSegment(st.lastVDts, firstDts ? firstDts.dts : tmp[0].pts, st.vOff, step);

  for (let i = 0; i < tmp.length; i++) {
    const t = tmp[i];
    const nals = splitAnnexB(t.pes.subarray(t.off));
    if (!acc.sps) readSpsPps(nals, acc);
    const av = nalsToAvcc(nals);
    if (!av.data.length) continue;
    const off = sink ? sink.tell() : 0;
    if (sink) sink.write(av.data);
    acc.vFrames.push({
      off, size: av.data.length, key: av.key,
      pts: t.pts + st.vOff,
      dts: t.dts == null ? null : t.dts + st.vOff,
    });
    if (t.dts != null) st.lastVDts = t.dts + st.vOff;
  }
}

/** 从 NAL 序列里取首个 SPS/PPS 并解析出宽高与 profile */
function readSpsPps(nals, acc) {
  for (let k = 0; k < nals.length; k++) {
    if (nals[k].type === 7) {
      acc.sps = Buffer.from(nals[k].data);
      const info = parseSps(nals[k].data);
      acc.width = info.width;
      acc.height = info.height;
      acc.profile = info.profileName;
      acc.profileIdc = info.profileIdc;
      acc.levelIdc = info.levelIdc;
    } else if (nals[k].type === 8) {
      acc.pps = Buffer.from(nals[k].data);
    }
  }
}

/** 处理单个分片的音频 PES：拆 ADTS、写 mdat 并记录 sample */
function collectAudioOfSegment(d, acc, sink, st) {
  const list = d.audioPid >= 0 ? d.byPid.get(d.audioPid) || [] : [];
  const tmp = [];
  for (let i = 0; i < list.length; i++) {
    const h = parsePesHeader(list[i]);
    if (!h || h.pts == null) continue;
    tmp.push({ pes: list[i], pts: h.pts, off: h.dataOffset });
  }
  if (!tmp.length) return;

  /* 音频一帧 1024 采样，90kHz 下约 2089.8 tick，作为跨分片对齐的名义步长 */
  st.aOff = alignSegment(st.lastADts, tmp[0].pts, st.aOff, 2089);
  for (let i = 0; i < tmp.length; i++) {
    const t = tmp[i];
    const ptsAbs = t.pts + st.aOff;
    let p = t.off;
    const end = t.pes.length;
    while (p + 7 <= end) {
      const ad = parseAdts(t.pes, p);
      if (!ad) break;
      const stop = Math.min(p + ad.frameLen, end);
      if (stop - p <= ad.headerLen) break; /* 分片尾部被截断的残帧，跳过 */
      if (!acc.asc) {
        acc.asc = buildAsc(ad.objectType, ad.sfIndex, ad.channelCfg);
        acc.sampleRate = AAC_RATES[ad.sfIndex] || 44100;
        acc.channels = ad.channelCfg || 2;
      }
      const off = sink ? sink.tell() : 0;
      if (sink) sink.write(t.pes.subarray(p + ad.headerLen, stop));
      acc.aFrames.push({ off, size: stop - p - ad.headerLen, pts: ptsAbs });
      p = stop;
    }
  }
  st.lastADts = tmp[tmp.length - 1].pts + st.aOff;
}

/* ==================================================================
 * 八、把解析结果转换成 moov
 * ================================================================== */

/**
 * 预处理视频样本表：补 DTS、吸附 PTS、换算成以 0 为原点的 t/cts/delta。
 * @returns {{vDur:number, vDurMs:number, presentationStart:number}}
 */
function prepareVideoTrack(v) {
  /* 1) DTS 可能有大半帧缺失（只有 PTS），先补成严格单调序列 */
  rebuildDts(v, estimateFrameStep(v));
  /* 2) PTS 吸附到帧步长网格，避免个别非整格 PTS 与邻帧撞到同一输出刻度 */
  snapVideoPts(v, estimateFrameStep(v));

  let minDts = Infinity;
  for (let i = 0; i < v.length; i++) minDts = Math.min(minDts, v[i].dts);
  if (!Number.isFinite(minDts)) minDts = 0;

  /* 3) t = 解码时间戳（归零），cts = 呈现偏移（B 帧重排，不允许为负） */
  for (let i = 0; i < v.length; i++) {
    v[i].t = v[i].dts - minDts;
    v[i].cts = Math.max(0, v[i].pts - v[i].dts);
  }

  /* 4) 首帧不一定是最早呈现的帧：呈现起点取 min(t + cts) */
  let vStart = Infinity;
  for (let i = 0; i < v.length; i++) vStart = Math.min(vStart, v[i].t + v[i].cts);
  if (!Number.isFinite(vStart) || vStart < 0) vStart = 0;

  /* 5) 每帧时长：相邻 t 之差，末帧用平均步长 */
  const avg = v.length > 1 ? Math.max(1, Math.round(v[v.length - 1].t / (v.length - 1))) : 3000;
  for (let i = 0; i < v.length - 1; i++) v[i].delta = Math.max(1, v[i + 1].t - v[i].t);
  if (v.length > 1) v[v.length - 1].delta = avg;

  /* 6) 轨长要覆盖末帧呈现结束点，否则末帧呈现被截断 */
  const last = v[v.length - 1];
  const vDur = Math.max(last.t + last.delta, last.t + last.cts + last.delta);
  return { vDur, vDurMs: Math.round((vDur / 90000) * 1000), presentationStart: vStart };
}

/** 构造视频 trak（avc1 + ctts） */
function makeVideoTrak(acc, v, prep, trackId) {
  const stbl = buildStbl({
    entry: buildAvc1({ width: acc.width, height: acc.height, sps: acc.sps, pps: acc.pps }),
    deltas: v.map((f) => f.delta),
    ctts: v.map((f) => f.cts),
    keys: v.map((f, i) => (f.key ? i + 1 : 0)).filter((x) => x > 0),
    sizes: v.map((f) => f.size),
    offsets: v.map((f) => f.off),
  });
  return buildTrak({
    trackId, kind: 'vide', timescale: 90000, duration: prep.vDur,
    durationMs: prep.vDurMs, width: acc.width, height: acc.height, stbl,
    /* 呈现起点晚于解码起点时用 elst 裁掉，让 start_time 归 0 */
    mediaTimeSec: prep.presentationStart / 90000,
  });
}

/** 构造音频 trak（mp4a + esds），样本表从 0 起算因此不写 elst */
function makeAudioTrak(acc, a, aDelta, aDur, aDurMs, sr, trackId) {
  const totalBytes = a.reduce((s, f) => s + f.size, 0);
  const stbl = buildStbl({
    entry: buildMp4a({
      channels: acc.channels, sampleRate: sr, asc: acc.asc,
      /* 平均码率按实际数据量估算，供 esds 的 DecoderConfigDescriptor 使用 */
      avgBitrate: Math.max(16000, Math.min(320000,
        Math.round((totalBytes * 8) / Math.max(1, aDur / sr)))),
    }),
    deltas: aDelta,
    ctts: null, keys: null,
    sizes: a.map((f) => f.size),
    offsets: a.map((f) => f.off),
  });
  return buildTrak({
    trackId, kind: 'soun', timescale: sr, duration: aDur,
    durationMs: aDurMs, width: 0, height: 0, stbl, mediaTimeSec: 0,
  });
}

/** 构造完整 moov */
function buildMoov(acc) {
  const v = acc.vFrames;
  const a = acc.aFrames;
  /* 必须用 !!(...) 归一成布尔，否则 && 短路会把 Buffer 原样返回 */
  const hasVideo = !!(v.length > 0 && acc.sps && acc.pps);
  const hasAudio = !!(a.length > 0 && acc.asc);
  const sr = acc.sampleRate || 44100;

  const prep = hasVideo ? prepareVideoTrack(v) : { vDur: 0, vDurMs: 0, presentationStart: 0 };
  const aDelta = buildAudioDeltas(a, sr);
  let aDur = 0;
  for (let i = 0; i < aDelta.length; i++) aDur += aDelta[i];
  const aDurMs = hasAudio ? Math.round((aDur / sr) * 1000) : 0;
  const totalMs = Math.max(prep.vDurMs, aDurMs, 1);

  const b = new BW();
  b.raw(buildMvhd(totalMs, 1 + (hasVideo ? 1 : 0) + (hasAudio ? 1 : 0)));
  if (hasVideo) b.raw(makeVideoTrak(acc, v, prep, 1));
  if (hasAudio) b.raw(makeAudioTrak(acc, a, aDelta, aDur, aDurMs, sr, hasVideo ? 2 : 1));

  return {
    moov: mkBox('moov', b), hasVideo, hasAudio,
    videoDur: prep.vDur / 90000, audioDur: aDur / sr,
  };
}

/* ==================================================================
 * 九、对外 API
 * ================================================================== */

/**
 * 把多个 TS 分片重封装成一个标准 MP4 文件。
 */
async function remuxFiles(tsPaths, outMp4Path, onProgress) {
  if (!tsPaths || !tsPaths.length) {
    return { ok: false, bytes: 0, durationSec: 0, video: null, audio: null, error: '没有输入文件' };
  }
  /* 逐片读盘：任一时刻内存里只有当前分片（约 10 秒 / 数百 KB），支持 1GB 以上课程 */
  let totalBytes = 0;
  for (let i = 0; i < tsPaths.length; i++) {
    try { totalBytes += fs.statSync(tsPaths[i]).size; } catch (e) { /* 读不到的片后面会报错 */ }
  }
  return runRemux(tsPaths.length, (i) => fs.readFileSync(tsPaths[i]), totalBytes, outMp4Path, onProgress);
}

/**
 * 同样的工作，输入是内存里的 Buffer 数组。
 */
async function remuxBuffers(buffers, outMp4Path, onProgress) {
  if (!buffers || !buffers.length) {
    return { ok: false, bytes: 0, durationSec: 0, video: null, audio: null, error: '没有输入数据' };
  }
  let totalBytes = 0;
  for (let i = 0; i < buffers.length; i++) totalBytes += buffers[i].length;
  return runRemux(buffers.length, (i) => buffers[i], totalBytes, outMp4Path, onProgress);
}

/**
 * 重封装主流程（文件版与内存版共用）：
 * 1) 写 ftyp；2) 写 mdat 占位并在解析过程中边写边记 sample 表；
 * 3) 回填 mdat 大小；4) 最后追加 moov（此时才知道 sample 表全貌）。
 */
function runRemux(count, getSource, totalInputBytes, outMp4Path, onProgress) {
  let fd = -1;
  try {
    fd = fs.openSync(outMp4Path, 'w');
    const sink = new OutFile(fd);
    sink.write(buildFtyp());

    /* mdat 头：32 位 size 只到 4GB。预计超过 3.5GB 时改用 size=1 + 64 位 largesize，
     * 否则保持最常见的 8 字节头（兼容性最好）。两种头都由下面的 patch 回填。 */
    const large = totalInputBytes > 3.5 * 1024 * 1024 * 1024;
    const mdatPos = sink.tell();
    const hdrLen = large ? 16 : 8;
    const placeholder = Buffer.alloc(hdrLen);
    if (large) placeholder.writeUInt32BE(1, 0);
    placeholder.write('mdat', 4, 'latin1');
    sink.write(placeholder);

    const acc = parseAllSources(getSource, count, sink, onProgress);

    sink.flush();
    const mdatSize = sink.tell() - mdatPos;
    const sizeBuf = Buffer.allocUnsafe(hdrLen);
    if (large) {
      sizeBuf.writeUInt32BE(1, 0);
      sizeBuf.write('mdat', 4, 'latin1');
      const hi = Math.floor(mdatSize / 4294967296);
      sizeBuf.writeUInt32BE(hi, 8);
      sizeBuf.writeUInt32BE(mdatSize - hi * 4294967296, 12);
    } else {
      sizeBuf.writeUInt32BE(mdatSize, 0);
      sizeBuf.write('mdat', 4, 'latin1');
    }
    sink.patch(sizeBuf, mdatPos);

    if (onProgress) onProgress({ phase: 'finalize', done: count, total: count });
    const built = buildMoov(acc);
    sink.write(built.moov);
    sink.flush();
    let bytes = sink.tell();
    fs.closeSync(fd);
    fd = -1;

    const errParts = [];
    if (acc.badPackets) errParts.push('跳过 ' + acc.badPackets + ' 个损坏的 TS 包');
    if (!built.hasVideo) errParts.push('未解析到可用的 H.264 视频轨');
    if (!built.hasAudio) errParts.push('未解析到可用的 AAC 音频轨');

    /* 两条轨都没解析出来时不留垃圾文件，避免下游误当作可用产物 */
    if (!built.hasVideo && !built.hasAudio) {
      try { fs.unlinkSync(outMp4Path); } catch (e) { /* 删不掉也不影响返回值 */ }
      bytes = 0;
    }

    if (onProgress) onProgress({ phase: 'done', done: count, total: count });
    return {
      ok: built.hasVideo || built.hasAudio,
      bytes,
      durationSec: Math.max(built.videoDur, built.audioDur),
      video: built.hasVideo
        ? { codec: 'h264', width: acc.width, height: acc.height, profile: acc.profile }
        : null,
      audio: built.hasAudio
        ? { codec: 'aac', sampleRate: acc.sampleRate, channels: acc.channels }
        : null,
      error: errParts.length ? errParts.join('；') : undefined,
    };
  } catch (e) {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch (e2) { /* 忽略 */ }
    }
    return {
      ok: false, bytes: 0, durationSec: 0, video: null, audio: null,
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * 只解析不写文件：返回探测到的轨道信息与总时长。
 */
function probe(tsPaths) {
  try {
    const acc = parseAllSources((i) => fs.readFileSync(tsPaths[i]), tsPaths.length, null, null);
    const v = acc.vFrames;
    const a = acc.aFrames;
    let vDur = 0;
    if (v.length > 1) {
      const step = estimateFrameStep(v);
      vDur = (v[v.length - 1].pts - v[0].pts + step) / 90000;
    }
    const aDur = (a.length * 1024) / (acc.sampleRate || 44100);
    return {
      ok: v.length > 0 || a.length > 0,
      durationSec: Math.max(vDur, aDur),
      video: v.length
        ? { codec: 'h264', width: acc.width, height: acc.height,
            profile: acc.profile, profileIdc: acc.profileIdc, levelIdc: acc.levelIdc,
            frames: v.length, keyFrames: v.filter((f) => f.key).length,
            durationSec: vDur }
        : null,
      audio: a.length
        ? { codec: 'aac', sampleRate: acc.sampleRate, channels: acc.channels,
            frames: a.length, durationSec: aDur }
        : null,
      badPackets: acc.badPackets,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { remuxFiles, remuxBuffers, probe };
