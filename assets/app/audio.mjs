// 錄音切段：把長錄音（最長約 150 分鐘以上）在瀏覽器邊解碼邊切成約 5 分鐘的 16kHz 單聲道 WAV，逐段送後端轉錄。
//
// 為什麼這樣做：
//  - OpenAI 轉錄單檔上限 25MB，150 分鐘的 m4a／mp3 通常 70–300MB，必須切段
//  - m4a（iPhone 語音備忘錄、多數手機）不能直接按位元組切；整個檔案一次解碼會吃掉 1GB 以上記憶體
//  - 所以：m4a／mp4 用內建的 MP4 解析＋WebCodecs AudioDecoder 串流解碼；mp3 按影格邊界切小塊解碼；
//    wav 直接讀取；其他格式（或瀏覽器不支援 WebCodecs）才整個檔案解碼
//  - 切點：每段目標 5 分鐘，在最後 20 秒內找最安靜的 0.4 秒切開，避免把一句話切成兩半
//  - 16kHz 單聲道 16-bit WAV：5 分鐘約 9.6MB（語音辨識模型本身就用 16kHz）
//
// 純函式（WAV 解析、MP3 影格、MP4 解析、重新取樣、切段、WAV 編碼）都可以在 Node 測試；
// 解碼（decodeAudioData／AudioDecoder）只在瀏覽器執行。

export const TARGET_RATE = 16000;
export const SEGMENT_SEC = 300;
const SEARCH_SEC = 20;
const WINDOW_SEC = 0.4;

// ---------- 小工具 ----------
export function downmix(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

function concatF32(parts, total) {
  const out = new Float32Array(total ?? parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * 串流重新取樣（降頻時取區間平均當作簡單低通，語音辨識足夠）。
 * push() 可以分很多次餵；輸出的樣本數只跟總輸入長度有關，不受分塊方式影響。
 */
export class StreamResampler {
  constructor(fromRate, toRate = TARGET_RATE) {
    this.ratio = fromRate / toRate;
    this.buf = new Float32Array(0);
    this.bufStart = 0; // buf[0] 在整條訊號中的位置
    this.k = 0; // 下一個要輸出的樣本序號
  }
  push(input) {
    if (input && input.length) {
      const nb = new Float32Array(this.buf.length + input.length);
      nb.set(this.buf);
      nb.set(input, this.buf.length);
      this.buf = nb;
    }
    return this._drain(false);
  }
  flush() {
    return this._drain(true);
  }
  _drain(final) {
    const r = this.ratio;
    const half = Math.max(0.5, r / 2);
    const end = this.bufStart + this.buf.length;
    const out = [];
    while (true) {
      const c = this.k * r;
      const lo = Math.floor(c - half + 0.5);
      const hi = Math.floor(c + half + 0.5); // 不含
      if (!final && hi > end) break;
      if (c >= end) break;
      let s = 0;
      let n = 0;
      for (let i = Math.max(lo, this.bufStart); i < Math.min(hi, end); i++) {
        s += this.buf[i - this.bufStart];
        n++;
      }
      if (!n) {
        const i = Math.min(end - 1, Math.max(this.bufStart, Math.round(c)));
        s = this.buf[i - this.bufStart] || 0;
        n = 1;
      }
      out.push(s / n);
      this.k++;
    }
    // 丟掉之後用不到的樣本
    const keepFrom = Math.max(this.bufStart, Math.floor(this.k * r - half));
    if (keepFrom > this.bufStart) {
      this.buf = this.buf.slice(keepFrom - this.bufStart);
      this.bufStart = keepFrom;
    }
    return Float32Array.from(out);
  }
}

/** 在 [target - search, target] 內找能量最小的視窗中點當切點 */
export function findCut(samples, rate, target, searchSec = SEARCH_SEC, winSec = WINDOW_SEC) {
  const win = Math.max(1, Math.round(winSec * rate));
  const from = Math.max(0, target - Math.round(searchSec * rate));
  const to = Math.min(samples.length, target);
  if (to - from < win) return to;
  let best = to;
  let bestE = Infinity;
  const step = Math.max(1, Math.round(win / 4));
  for (let start = from; start + win <= to; start += step) {
    let e = 0;
    for (let i = start; i < start + win; i++) e += samples[i] * samples[i];
    // 一樣安靜時取較靠近目標的位置（每段長度接近設定值）
    if (e <= bestE) {
      bestE = e;
      best = start + Math.floor(win / 2);
    }
  }
  return best;
}

/**
 * 切段器：餵 16kHz 單聲道樣本，滿一段（在安靜處）就交出；end() 交出最後一段（標記 last）。
 * 為了能標記「最後一段」，每段會延後到下一段出現（或 end）才交出。
 */
export class Segmenter {
  constructor({ rate = TARGET_RATE, segmentSec = SEGMENT_SEC } = {}) {
    this.rate = rate;
    this.target = Math.round(segmentSec * rate);
    this.parts = [];
    this.len = 0;
    this.offset = 0; // 已切出的樣本數
    this.index = 0;
    this.held = null;
  }
  push(samples) {
    const ready = [];
    if (samples && samples.length) {
      this.parts.push(samples);
      this.len += samples.length;
    }
    while (this.len >= this.target + Math.round(1 * this.rate)) {
      const all = concatF32(this.parts, this.len);
      const cut = findCut(all, this.rate, this.target);
      ready.push(...this._emit(all.subarray(0, cut), false));
      const rest = all.slice(cut);
      this.parts = [rest];
      this.len = rest.length;
    }
    return ready;
  }
  end() {
    const out = [];
    const all = concatF32(this.parts, this.len);
    this.parts = [];
    this.len = 0;
    // 最後剩不到 2 秒：併進上一段，免得多一次轉錄
    if (all.length && all.length < 2 * this.rate && this.held) {
      const merged = concatF32([this.held.samples, all]);
      this.held = { ...this.held, samples: merged, end: (this.offset + all.length) / this.rate };
      this.offset += all.length;
    } else if (all.length) out.push(...this._emit(all, false));
    if (this.held) {
      out.push({ ...this.held, last: true });
      this.held = null;
    }
    return out;
  }
  _emit(samples, last) {
    const seg = { index: this.index++, start: this.offset / this.rate, end: (this.offset + samples.length) / this.rate, samples: Float32Array.from(samples), last };
    this.offset += samples.length;
    const prev = this.held;
    this.held = seg;
    return prev ? [prev] : [];
  }
}

/** Float32 → 16-bit PCM 單聲道 WAV */
export function encodeWav(samples, rate = TARGET_RATE) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- 格式判斷 ----------
export function sniffFormat(head, name = '', mime = '') {
  const b = head;
  const s4 = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length >= 12 && s4(0) === 'RIFF' && s4(8) === 'WAVE') return 'wav';
  if (b.length >= 8 && s4(4) === 'ftyp') return 'mp4';
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3'; // ID3
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe6) === 0xe2) return 'mp3'; // MPEG Layer III 影格
  if (/\.(m4a|mp4|mov|aac)$/i.test(name) && b.length >= 8 && s4(4) === 'ftyp') return 'mp4';
  if (/\.mp3$/i.test(name) || /mpeg/.test(mime)) return 'mp3';
  return 'other';
}

// ---------- WAV ----------
export function parseWavHeader(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const s4 = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (s4(0) !== 'RIFF' || s4(8) !== 'WAVE') throw new Error('不是 WAV 檔');
  let o = 12;
  let fmt = null;
  while (o + 8 <= u8.length) {
    const id = s4(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let format = v.getUint16(o + 8, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE：子格式
      fmt = { format, channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV 缺少格式資訊');
      return { ...fmt, dataOffset: o + 8, dataLength: size };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV 標頭不完整（找不到 data）');
}

/** WAV 原始位元組（交錯）→ 各聲道 Float32 */
export function wavBytesToChannels(u8, { format, channels, bits }) {
  const bps = bits / 8;
  const frames = Math.floor(u8.length / (bps * channels));
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = (f * channels + c) * bps;
      let x;
      if (format === 3 && bits === 32) x = v.getFloat32(p, true);
      else if (bits === 16) x = v.getInt16(p, true) / 32768;
      else if (bits === 24) x = ((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) x = v.getInt32(p, true) / 2147483648;
      else if (bits === 8) x = (u8[p] - 128) / 128;
      else throw new Error(`不支援 ${bits} 位元 WAV`);
      out[c][f] = x;
    }
  }
  return out;
}

// ---------- MP3 ----------
const MP3_BITRATES = {
  // [version][layer] → kbps（index 1–14）
  1: { 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const MP3_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** 若 i 是 MPEG Layer III 影格開頭，回傳影格長度，否則 0 */
export function mp3FrameLength(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const vbits = (b[i + 1] >> 3) & 3;
  const layer = (b[i + 1] >> 1) & 3;
  if (vbits === 1 || layer !== 1) return 0; // 只處理 Layer III
  const version = vbits === 3 ? 1 : vbits === 2 ? 2 : 2.5;
  const bi = (b[i + 2] >> 4) & 15;
  const ri = (b[i + 2] >> 2) & 3;
  if (bi === 0 || bi === 15 || ri === 3) return 0;
  const kbps = MP3_BITRATES[version === 1 ? 1 : 2][3][bi];
  const rate = MP3_RATES[version][ri];
  const pad = (b[i + 2] >> 1) & 1;
  return Math.floor(((version === 1 ? 144 : 72) * kbps * 1000) / rate) + pad;
}

/** 在 buf 中從 from 開始找下一個「連續兩個影格都合法」的位置 */
export function findMp3Sync(b, from) {
  for (let i = Math.max(0, from); i + 4 <= b.length; i++) {
    const len = mp3FrameLength(b, i);
    if (len && (i + len + 4 > b.length || mp3FrameLength(b, i + len))) return i;
  }
  return -1;
}

export function id3v2Size(b) {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  return 10 + ((b[6] & 0x7f) << 21) + ((b[7] & 0x7f) << 14) + ((b[8] & 0x7f) << 7) + (b[9] & 0x7f) + (b[5] & 0x10 ? 10 : 0);
}

// ---------- MP4／M4A（只抓第一條音軌） ----------
function u32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u64(b, o) {
  return u32(b, o) * 4294967296 + u32(b, o + 4);
}
function boxType(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = boxType(b, o + 4);
    let header = 8;
    if (size === 1) {
      size = u64(b, o + 8);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}
function child(b, box, type) {
  for (const c of boxes(b, box.start, box.end)) if (c.type === type) return c;
  return null;
}
function readDescriptor(b, o) {
  const tag = b[o];
  let len = 0;
  let i = o + 1;
  for (let k = 0; k < 4; k++) {
    const x = b[i++];
    len = (len << 7) | (x & 0x7f);
    if (!(x & 0x80)) break;
  }
  return { tag, start: i, end: i + len };
}
/** esds → AudioSpecificConfig 位元組 */
export function ascFromEsds(b, esds) {
  let o = esds.start + 4; // version/flags
  const es = readDescriptor(b, o);
  if (es.tag !== 0x03) return null;
  o = es.start + 2;
  const flags = b[o++];
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + b[o];
  if (flags & 0x20) o += 2;
  const dc = readDescriptor(b, o);
  if (dc.tag !== 0x04) return null;
  const dsi = readDescriptor(b, dc.start + 13);
  if (dsi.tag !== 0x05) return null;
  return b.slice(dsi.start, dsi.end);
}

/**
 * 解析 MP4 的 moov（呼叫端讀好整個 moov 盒子的位元組，含 8 位元組標頭）。
 * 回傳第一條音軌：{ codec, sampleRate, channels, asc, timescale, duration, offsets, sizes }
 */
export function parseMoov(b) {
  const moov = { start: 8, end: b.length };
  for (const trak of boxes(b, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(b, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(b, mdia, 'hdlr');
    if (!hdlr || boxType(b, hdlr.start + 8) !== 'soun') continue;
    const mdhd = child(b, mdia, 'mdhd');
    const v1 = b[mdhd.start] === 1;
    const timescale = u32(b, mdhd.start + (v1 ? 20 : 12));
    const duration = v1 ? u64(b, mdhd.start + 24) : u32(b, mdhd.start + 16);
    const minf = child(b, mdia, 'minf');
    const stbl = minf && child(b, minf, 'stbl');
    if (!stbl) continue;
    const stsd = child(b, stbl, 'stsd');
    const entry = boxes(b, stsd.start + 8, stsd.end).next().value;
    const format = entry.type; // mp4a
    const ver = (b[entry.start + 8] << 8) | b[entry.start + 9];
    const channels = (b[entry.start + 16] << 8) | b[entry.start + 17];
    let sampleRate = u32(b, entry.start + 24) >>> 16;
    const childStart = entry.start + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    let asc = null;
    for (const c of boxes(b, childStart, entry.end)) if (c.type === 'esds') asc = ascFromEsds(b, c);
    let codec = format;
    if (format === 'mp4a' && asc && asc.length) {
      let aot = asc[0] >> 3;
      if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
      codec = `mp4a.40.${aot}`;
      // AudioSpecificConfig 的取樣率比 sample entry（16.16、可能溢位）可靠
      const fi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
      const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
      if (ASC_RATES[fi]) sampleRate = ASC_RATES[fi];
    }
    // 取樣表
    const stsz = child(b, stbl, 'stsz');
    const fixed = u32(b, stsz.start + 4);
    const count = u32(b, stsz.start + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || u32(b, stsz.start + 12 + i * 4);
    const stco = child(b, stbl, 'stco');
    const co64 = child(b, stbl, 'co64');
    const cbox = stco || co64;
    const nChunks = u32(b, cbox.start + 4);
    const chunkOff = new Float64Array(nChunks);
    for (let i = 0; i < nChunks; i++) chunkOff[i] = stco ? u32(b, cbox.start + 8 + i * 4) : u64(b, cbox.start + 8 + i * 8);
    const stsc = child(b, stbl, 'stsc');
    const nEnt = u32(b, stsc.start + 4);
    const ent = [];
    for (let i = 0; i < nEnt; i++) ent.push({ first: u32(b, stsc.start + 8 + i * 12) - 1, per: u32(b, stsc.start + 12 + i * 12) });
    const offsets = new Float64Array(count);
    let s = 0;
    for (let e = 0; e < ent.length && s < count; e++) {
      const lastChunk = e + 1 < ent.length ? ent[e + 1].first : nChunks;
      for (let c = ent[e].first; c < lastChunk && s < count; c++) {
        let off = chunkOff[c];
        for (let k = 0; k < ent[e].per && s < count; k++) {
          offsets[s] = off;
          off += sizes[s];
          s++;
        }
      }
    }
    return { codec, sampleRate, channels, asc, timescale, duration, offsets, sizes };
  }
  throw new Error('找不到音軌');
}

/** 掃最上層的盒子找 moov 的位置（moov 可能在檔尾） */
export async function locateMoov(readRange, size) {
  let o = 0;
  while (o + 8 <= size) {
    const h = await readRange(o, Math.min(size, o + 16));
    let len = u32(h, 0);
    const type = boxType(h, 4);
    if (len === 1) len = u64(h, 8);
    else if (len === 0) len = size - o;
    if (len < 8) break;
    if (type === 'moov') return { start: o, end: o + len };
    o += len;
  }
  throw new Error('這個 MP4／M4A 檔找不到 moov（檔案可能不完整）');
}

// ---------- 瀏覽器解碼 ----------
const readBlob = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());

async function decodeWithContext(arrayBuffer) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('這個瀏覽器不能解碼音訊');
  // 在 16kHz 的 context 解碼：瀏覽器會順便高品質地轉成 16kHz
  const ctx = new Ctx(1, 1, TARGET_RATE);
  const ab = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  const chs = [];
  for (let c = 0; c < ab.numberOfChannels; c++) chs.push(ab.getChannelData(c));
  return downmix(chs);
}

async function* wavPcm(file, onProgress) {
  const head = await readBlob(file, 0, Math.min(file.size, 1 << 16));
  const h = parseWavHeader(head);
  const frameBytes = (h.bits / 8) * h.channels;
  const total = Math.min(h.dataLength || file.size - h.dataOffset, file.size - h.dataOffset);
  const step = frameBytes * h.rate * 10; // 10 秒
  const rs = new StreamResampler(h.rate);
  for (let o = 0; o < total; o += step) {
    const u8 = await readBlob(file, h.dataOffset + o, h.dataOffset + Math.min(total, o + step));
    yield rs.push(downmix(wavBytesToChannels(u8, h)));
    onProgress && onProgress((o + step) / total);
  }
  yield rs.flush();
}

async function* mp3Pcm(file, onProgress) {
  const SLICE = 1536 * 1024; // 約 1 分半（128kbps）
  const head = await readBlob(file, 0, Math.min(file.size, 1 << 20));
  let pos = id3v2Size(head);
  while (pos < file.size) {
    let end = Math.min(file.size, pos + SLICE);
    if (end < file.size) {
      // 切在影格邊界
      const probe = await readBlob(file, end, Math.min(file.size, end + 8192));
      const k = findMp3Sync(probe, 0);
      if (k >= 0) end += k;
    }
    const buf = await file.slice(pos, end).arrayBuffer();
    try {
      yield await decodeWithContext(buf);
    } catch {
      // 壞掉的一小塊略過，不中斷整個錄音
    }
    pos = end;
    onProgress && onProgress(pos / file.size);
  }
}

async function* mp4Pcm(file, onProgress) {
  const read = (s, e) => readBlob(file, s, e);
  const loc = await locateMoov(read, file.size);
  const t = parseMoov(await read(loc.start, loc.end));
  const config = { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.channels, description: t.asc };
  const supported = typeof AudioDecoder !== 'undefined' && (await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported;
  if (!supported) {
    yield* wholeFilePcm(file, onProgress);
    return;
  }
  const outQ = [];
  let failure = null;
  const dec = new AudioDecoder({
    output: (ad) => {
      try {
        const chs = [];
        for (let c = 0; c < ad.numberOfChannels; c++) {
          const a = new Float32Array(ad.numberOfFrames);
          ad.copyTo(a, { planeIndex: c, format: 'f32-planar' });
          chs.push(a);
        }
        outQ.push({ rate: ad.sampleRate, pcm: downmix(chs) });
      } finally {
        ad.close();
      }
    },
    error: (e) => (failure = e),
  });
  dec.configure(config);
  let rs = null;
  const drain = function* () {
    while (outQ.length) {
      const { rate, pcm } = outQ.shift();
      if (!rs) rs = new StreamResampler(rate);
      yield rs.push(pcm);
    }
  };
  const n = t.sizes.length;
  const frameUs = (1024 / t.sampleRate) * 1e6;
  let i = 0;
  while (i < n) {
    // 連續存放的樣本一次讀（最多 2MB）
    let j = i;
    let bytes = 0;
    while (j < n && bytes < 2 * 1024 * 1024 && (j === i || t.offsets[j] === t.offsets[j - 1] + t.sizes[j - 1])) bytes += t.sizes[j++];
    const u8 = await read(t.offsets[i], t.offsets[i] + bytes);
    let o = 0;
    for (let k = i; k < j; k++) {
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(k * frameUs), data: u8.subarray(o, o + t.sizes[k]) }));
      o += t.sizes[k];
    }
    i = j;
    while (dec.decodeQueueSize > 0 && !failure) await new Promise((r) => setTimeout(r, 0));
    if (failure) throw new Error(`錄音解碼失敗：${failure.message || failure}`);
    yield* drain();
    onProgress && onProgress(i / n);
  }
  await dec.flush();
  dec.close();
  yield* drain();
  if (rs) yield rs.flush();
}

async function* wholeFilePcm(file, onProgress) {
  const pcm = await decodeWithContext(await file.arrayBuffer());
  onProgress && onProgress(1);
  const step = TARGET_RATE * 30;
  for (let o = 0; o < pcm.length; o += step) yield pcm.subarray(o, o + step);
}

/** 讀檔頭判斷格式，並用 <audio> 取得長度（拿不到就用檔案大小粗估） */
export async function probeAudio(file) {
  const head = await readBlob(file, 0, Math.min(file.size, 64));
  const format = sniffFormat(head, file.name, file.type);
  let durationSec = await new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const el = document.createElement('audio');
      const done = (v) => {
        URL.revokeObjectURL(url);
        resolve(v);
      };
      el.preload = 'metadata';
      el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : 0);
      el.onerror = () => done(0);
      setTimeout(() => done(0), 8000);
      el.src = url;
    } catch {
      resolve(0);
    }
  });
  if (!durationSec) durationSec = file.size / (128000 / 8); // 粗估 128kbps
  return { format, durationSec };
}

/**
 * 逐段產生 { index, start, end, last, wav(Uint8Array) }。
 * onProgress(0–1)：解碼進度。整個檔案解碼的路徑（不支援的格式）較耗記憶體。
 */
export async function* audioSegments(file, { format, segmentSec = SEGMENT_SEC, onProgress } = {}) {
  const fmt = format || (await probeAudio(file)).format;
  const src = fmt === 'wav' ? wavPcm(file, onProgress) : fmt === 'mp3' ? mp3Pcm(file, onProgress) : fmt === 'mp4' ? mp4Pcm(file, onProgress) : wholeFilePcm(file, onProgress);
  const seg = new Segmenter({ segmentSec });
  const pack = (s) => ({ index: s.index, start: s.start, end: s.end, last: s.last, wav: encodeWav(s.samples) });
  for await (const pcm of src) for (const s of seg.push(pcm)) yield pack(s);
  for (const s of seg.end()) yield pack(s);
}
