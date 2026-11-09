/**
 * 台中市召會行動報導協作平台 — 後端核心邏輯（與環境無關的純函式）
 *
 * 這個檔案是 ES5 寫法，會由 npm run gas:bundle 與 Code.gs 合併成單一 Code.gs 貼進 Apps Script 專案，
 * 也會被 Node 的 mock server（scripts/mock-server.mjs）與瀏覽器示範模式（?demo=1）載入。
 * 所有外部服務（Drive／Sheets／MailApp／Properties／Cache／Lock）都由呼叫端以 env 物件注入：
 *
 *   env = {
 *     now: function () { return 毫秒 },
 *     randomHex: function (nBytes) { return 隨機十六進位字串 },
 *     sha256Hex: function (str) { return 64 位十六進位 }   // 可省略，省略時用本檔內建實作
 *     props: { get(k), set(k, v), del(k) },                // 字串值（ScriptProperties）
 *     cache: { get(k), put(k, v, ttlSec), del(k) },        // 字串值（CacheService）
 *     withLock: function (fn) { return fn() },             // LockService
 *     sendMail: function (to, subject, body) {},           // MailApp
 *     deployerEmail: function () { return 部署者 email 或 '' },
 *     limits: { ... }                                      // 只有 mock／測試會覆寫
 *     store: { 見 README「後端儲存介面」 }
 *   }
 *
 * 登入、session、管理者名單、防公式注入、錯誤訊息清理的寫法沿用「台中的民數記」報名系統，
 * 常數改用 RPT_ 前綴；安全參數（驗證碼 10 分鐘、最多錯 5 次、寄信額度、session 7 天…）維持相同。
 */
var RptCore = (function () {
  'use strict';

  // ---------- 常數 ----------
  // version 3：合併查詢加速（boot／action.open／photos.getMany）、協作者姓名與常用聯絡人、行動錄音逐字稿（OpenAI）
  // version 5：登入時回傳首頁資料（auth.verifyCode withBoot）
  // version 4：行動日期區間（endDate）、防重複建立（requestId、同名同日合併）、刪除行動（actions.delete）
  var RPT_VERSION_ = 5;
  var RPT_ADMIN_SEED_EMAILS_ = ['isaiah.overcomer@gmail.com'];
  var RPT_MAIL_SUBJECT_ = '台中市召會行動報導協作平台 登入驗證碼';
  var RPT_MAIL_SENDER_NAME_ = '台中市召會行動報導協作平台';
  var RPT_TOKEN_PREFIX_ = 'fs1_';
  var RPT_DEFAULT_LIMITS_ = {
    codeTtlMs: 10 * 60 * 1000,
    codeMaxTries: 5,
    mailPerEmailPerDay: 10,
    mailGlobalPerDay: 80,
    mailIntervalMs: 60 * 1000,
    sessionTtlMs: 7 * 24 * 3600 * 1000,
    sessionMaxPerEmail: 10,
    photoMaxBytes: Math.floor(1.5 * 1024 * 1024),
    videoMaxMbDefault: 200,
    outputMaxChars: 20 * 1024 * 1024,
    actionsPerUserPerDay: 20,
    audioMaxMbDefault: 600,
    // 轉錄一段：瀏覽器切好的 16kHz 單聲道 WAV（5 分鐘約 9.6MB）；OpenAI 單檔上限 25MB
    segmentMaxBytes: 20 * 1024 * 1024,
    segmentsPerRecording: 80,
    recordingsPerAction: 20,
    transcriptMaxChars: 300000,
    correctChunkMaxChars: 8000,
    summaryInputMaxChars: 150000,
    photosPerBatch: 8,
    contactsMax: 80
  };
  var RPT_P_ = {
    pepper: 'RPT_PEPPER',
    admins: 'RPT_ADMINS',
    mailQuota: 'RPT_MAIL_QUOTA',
    sessionPrefix: 'RPT_SESS_',
    sessionIndexPrefix: 'RPT_SIDX_',
    videoMaxMb: 'RPT_VIDEO_MAX_MB',
    audioMaxMb: 'RPT_AUDIO_MAX_MB',
    contactsPrefix: 'RPT_CONT_',
    aiKey: 'RPT_OPENAI_KEY',
    aiConfig: 'RPT_AI_CONFIG'
  };
  // OpenAI 模型預設值（總管理者可在「總管理者名單」頁更改，不必改程式）。
  // whisper-1／gpt-4o-transcribe 已公告 2027-02-26 停用，所以預設用 gpt-transcribe。
  var RPT_AI_DEFAULTS_ = { transcribeModel: 'gpt-transcribe', chatModel: 'gpt-6-luna' };
  // 逐字稿規則（全站預設）：常用詞彙會放進轉錄提示，替換規則逐字套用，兩段說明給 AI 修正與彙整
  var RPT_DEFAULT_RULES_ = {
    vocabulary: [
      '召會', '主恢復', '職事', '倪柝聲', '李常受', '申言', '擘餅聚會', '主日聚會', '禱告聚會', '小排', '家聚會', '福音聚會',
      '青職', '大專', '青少年', '兒童排', '全時間訓練', '生命讀經', '晨興聖言', '恢復本', '基督的身體', '新耶路撒冷',
      '召會生活', '聖徒', '弟兄', '姊妹', '長老', '執事', '會所', '受浸', '得救', '呼求主名', '三一神', '調和的靈'
    ],
    replacements: [
      { from: '招會', to: '召會' },
      { from: '照會', to: '召會' },
      { from: '主回復', to: '主恢復' },
      { from: '回復本', to: '恢復本' },
      { from: '姐妹', to: '姊妹' },
      { from: '擘並', to: '擘餅' }
    ],
    correctionNotes:
      '使用台灣繁體中文與全形標點。只修正錯字、同音字、標點與斷句，不增刪內容、不改寫語氣，保留講員原話；口頭禪（嗯、那個）可以刪除。人名、地名照原文，不確定時不要猜。',
    summaryNotes:
      '用條列整理：一、行動概要（時間、地點、對象、參加人數）；二、信息與分享重點；三、見證與故事（誰、發生什麼、結果）；四、數字（人數、受浸、得救、決志等）；五、決議與後續事項。每點一行、精簡，只寫錄音裡有的內容，沒有就略過該項。'
  };
  var RPT_CELL_MAX_ = 40000;
  var RPT_MAX_COLLABORATORS_ = 300;
  var RPT_VIDEO_HOSTS_ = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be', 'drive.google.com'];
  var RPT_LAYOUTS_ = ['classic', 'alternate', 'columns'];
  var RPT_PRESETS_ = [
    { id: 'brief', name: '週訊短訊', words: 600, maxPhotos: 2, maxVideos: 0, pages: 1, layout: 'classic' },
    { id: 'standard', name: '標準報導', words: 1500, maxPhotos: 4, maxVideos: 1, pages: 2, layout: 'alternate' },
    { id: 'feature', name: '專題', words: 3000, maxPhotos: 8, maxVideos: 2, pages: 4, layout: 'columns' }
  ];
  var RPT_SETTING_RANGES_ = {
    words: { min: 300, max: 5000, step: 100 },
    maxPhotos: { min: 0, max: 20, step: 1 },
    maxVideos: { min: 0, max: 5, step: 1 },
    pages: { min: 1, max: 8, step: 1 }
  };

  // ---------- 錯誤 ----------
  function RptError(code, message) {
    this.name = 'RptError';
    this.code = code;
    this.message = message;
  }
  RptError.prototype = Object.create(Error.prototype);
  RptError.prototype.constructor = RptError;
  function fail_(code, message) {
    throw new RptError(code, message);
  }

  // ---------- 小工具 ----------
  function isString_(v) {
    return typeof v === 'string';
  }
  function trim_(v) {
    return isString_(v) ? v.replace(/^\s+|\s+$/g, '') : '';
  }
  function hasOwn_(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }
  function arrayIncludes_(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true;
    return false;
  }
  function parseJson_(s, fallback) {
    if (!isString_(s) || !s) return fallback;
    try {
      return JSON.parse(s);
    } catch (e) {
      return fallback;
    }
  }
  function limits_(env) {
    var out = {};
    var k;
    for (k in RPT_DEFAULT_LIMITS_) if (hasOwn_(RPT_DEFAULT_LIMITS_, k)) out[k] = RPT_DEFAULT_LIMITS_[k];
    if (env && env.limits) for (k in env.limits) if (hasOwn_(env.limits, k)) out[k] = env.limits[k];
    return out;
  }
  /** 台北時間的日期字串 YYYY-MM-DD（寄信額度以台北日計） */
  function taipeiDay_(ms) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // ---------- SHA-256（環境沒有提供時使用；UTF-8） ----------
  function utf8Bytes_(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  var SHA_K_ = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256HexPure_(str) {
    var bytes = utf8Bytes_(String(str));
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        var j = off + t * 4;
        w[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var x = w[t - 15];
        var y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (k + S1 + ch + SHA_K_[t] + w[t]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) >>> 0;
        k = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
    }
    var hex = '';
    for (var i = 0; i < 8; i++) hex += ('00000000' + h[i].toString(16)).slice(-8);
    return hex;
  }
  function sha256_(env, str) {
    return env && typeof env.sha256Hex === 'function' ? env.sha256Hex(String(str)) : sha256HexPure_(str);
  }

  // ---------- 輸入正規化與驗證 ----------
  var EMAIL_RE_ = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
  function normalizeEmail(v) {
    return trim_(v).toLowerCase();
  }
  function isValidEmail(v) {
    return isString_(v) && v.length <= 254 && EMAIL_RE_.test(v);
  }
  function requireEmail_(v, label) {
    var e = normalizeEmail(v);
    if (!isValidEmail(e)) fail_('BAD_INPUT', (label || 'Email') + ' 格式不正確');
    return e;
  }
  function str_(v, label, maxLen, required) {
    if (v == null) v = '';
    if (!isString_(v)) fail_('BAD_INPUT', label + ' 必須是文字');
    var s = trim_(v);
    if (required && !s) fail_('BAD_INPUT', '請填寫' + label);
    if (s.length > maxLen) fail_('BAD_INPUT', label + ' 最多 ' + maxLen + ' 字');
    return s;
  }
  function id_(v, label) {
    if (!isString_(v) || !/^[A-Za-z0-9_-]{4,80}$/.test(v)) fail_('BAD_INPUT', (label || 'id') + ' 格式不正確');
    return v;
  }
  function isValidDate_(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  function emailList_(v, label, max) {
    if (v == null) return [];
    if (isString_(v)) v = v.split(/[\s,;，；、]+/);
    if (Object.prototype.toString.call(v) !== '[object Array]') fail_('BAD_INPUT', label + ' 格式不正確');
    var out = [];
    for (var i = 0; i < v.length; i++) {
      if (!trim_(v[i])) continue;
      var e = requireEmail_(v[i], label);
      if (!arrayIncludes_(out, e)) out.push(e);
    }
    if (out.length > max) fail_('BAD_INPUT', label + ' 最多 ' + max + ' 個');
    return out;
  }

  /** 報導設定：數值夾在範圍內並對齊 step；未知版面改為 classic。 */
  function normalizeSettings(input) {
    var s = input && typeof input === 'object' ? input : {};
    var base = RPT_PRESETS_[1];
    var out = {};
    for (var key in RPT_SETTING_RANGES_) {
      if (!hasOwn_(RPT_SETTING_RANGES_, key)) continue;
      var r = RPT_SETTING_RANGES_[key];
      var n = Number(s[key]);
      if (!isFinite(n)) n = base[key];
      n = Math.round((n - r.min) / r.step) * r.step + r.min;
      out[key] = Math.max(r.min, Math.min(r.max, n));
    }
    out.layout = arrayIncludes_(RPT_LAYOUTS_, s.layout) ? s.layout : 'classic';
    return out;
  }

  /** 影片連結：只接受 https 且網域在白名單（YouTube／Google Drive）。 */
  function isAllowedVideoUrl(url) {
    if (!isString_(url) || url.length > 500) return false;
    var m = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?(\/[^\s"'<>\\]*)?$/.exec(url);
    if (!m) return false;
    return arrayIncludes_(RPT_VIDEO_HOSTS_, m[1].toLowerCase());
  }

  // ---------- 試算表防公式注入／錯誤訊息清理 ----------
  /** 寫入試算表前：開頭是 = + - @（以及 ' 本身、tab、CR）就在前面加 '，讓試算表當作純文字。 */
  function safeCell(v) {
    if (v == null) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    var s = String(v);
    return /^[=+\-@'\t\r]/.test(s) ? "'" + s : s;
  }
  /** 讀回時還原 safeCell（試算表若已吃掉開頭的 ' 就不會再動）。 */
  function unsafeCell(v) {
    if (v == null) return '';
    var s = String(v);
    return /^'[=+\-@'\t\r]/.test(s) ? s.slice(1) : s;
  }
  /**
   * 錯誤訊息去掉 email／網址／電話，避免回傳或寫入紀錄時洩漏個資。
   * 比照報名系統 serverErrorText_：只留第一行、去掉堆疊（" at …"）、任何 x@y 都視為 email、最多 120 字。
   */
  function sanitizeError(msg) {
    var s = String(msg == null ? '' : msg).split(/\r?\n/)[0];
    s = s
      .replace(/\b(?:https?|ftp):\/\/\S+/gi, '[url]')
      .replace(/\bwww\.\S+/gi, '[url]')
      .replace(/[^\s@]+@[^\s@]+/g, '[email]')
      .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
      .replace(/\s+at\s.*$/, '')
      .replace(/^\s+|\s+$/g, '');
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }
  /** 長字串切成每段最多 40,000 字（試算表每格上限 50,000，留餘裕）。 */
  function chunkString(s, size) {
    s = String(s == null ? '' : s);
    size = size || RPT_CELL_MAX_;
    var out = [];
    for (var i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
    return out.length ? out : [''];
  }
  function joinChunks(parts) {
    var s = '';
    for (var i = 0; i < (parts || []).length; i++) s += parts[i] == null ? '' : String(parts[i]);
    return s;
  }

  // ---------- base64 與圖片檔頭 ----------
  var B64_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64Head_(b64, n) {
    var out = [];
    var buf = 0;
    var bits = 0;
    for (var i = 0; i < b64.length && out.length < n; i++) {
      var v = B64_.indexOf(b64.charAt(i));
      if (v < 0) break;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 255);
      }
    }
    return out;
  }
  function base64Size_(b64) {
    var pad = b64.slice(-2) === '==' ? 2 : b64.slice(-1) === '=' ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
  }
  /** 檢查檔頭：回傳 'image/jpeg' | 'image/png' | 'image/webp' | null */
  function detectImageType(b64) {
    if (!isString_(b64)) return null;
    var h = base64Head_(b64, 12);
    if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
    if (h.length >= 8 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47 && h[4] === 0x0d && h[5] === 0x0a && h[6] === 0x1a && h[7] === 0x0a) return 'image/png';
    if (h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return 'image/webp';
    return null;
  }

  // ---------- Properties 小工具 ----------
  function propJson_(env, key, fallback) {
    return parseJson_(env.props.get(key), fallback);
  }
  function setPropJson_(env, key, value) {
    env.props.set(key, JSON.stringify(value));
  }
  function pepper_(env) {
    var p = env.props.get(RPT_P_.pepper);
    if (!p) {
      p = env.randomHex(32);
      env.props.set(RPT_P_.pepper, p);
    }
    return p;
  }
  function emailKey_(env, email) {
    return sha256_(env, 'e:' + pepper_(env) + ':' + email).slice(0, 32);
  }

  // ---------- 驗證碼 ----------
  /** 固定時間比對兩個雜湊字串（與報名系統相同做法，避免時間差洩漏） */
  function hashEquals_(a, b) {
    a = String(a || '');
    b = String(b || '');
    var diff = a.length ^ b.length;
    for (var i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  function codeHash_(env, email, code) {
    return sha256_(env, 'c:' + pepper_(env) + ':' + email + ':' + code);
  }
  function makeCode_(env) {
    var n = parseInt(env.randomHex(6), 16) % 1000000;
    return ('000000' + n).slice(-6);
  }

  /**
   * 寄送驗證碼。任何格式正確的 email 都回應相同訊息（不透露是否為管理者或協作者）。
   * 限制：每個 email 每天 10 封、全站每天 80 封、同一 email 間隔 60 秒。
   */
  function requestCode_(env, data) {
    var L = limits_(env);
    var email = requireEmail_(data && data.email);
    var now = env.now();
    var day = taipeiDay_(now);
    var key = emailKey_(env, email);
    var code = makeCode_(env);
    env.withLock(function () {
      var q = propJson_(env, RPT_P_.mailQuota, null);
      if (!q || q.day !== day) q = { day: day, total: 0, per: {} };
      var mine = q.per[key] || { n: 0, last: 0 };
      if (now - mine.last < L.mailIntervalMs) fail_('RATE_LIMIT', '寄送太頻繁，請 ' + Math.ceil((L.mailIntervalMs - (now - mine.last)) / 1000) + ' 秒後再試');
      if (mine.n >= L.mailPerEmailPerDay) fail_('RATE_LIMIT', '這個 email 今天索取驗證碼的次數已達上限，請明天再試');
      if (q.total >= L.mailGlobalPerDay) fail_('RATE_LIMIT', '今天系統寄信量已達上限，請明天再試或聯絡管理者');
      // 與報名系統相同：先看 Google 帳號今天剩下的寄信額度（env.mailQuota 可省略）
      if (typeof env.mailQuota === 'function' && env.mailQuota() < 1) fail_('RATE_LIMIT', '今天系統寄信量已達上限，請明天再試或聯絡管理者');
      mine.n += 1;
      mine.last = now;
      q.per[key] = mine;
      q.total += 1;
      setPropJson_(env, RPT_P_.mailQuota, q);
      env.cache.put('RPT_OTP_' + key, JSON.stringify({ h: codeHash_(env, email, code), x: now + L.codeTtlMs, t: 0 }), Math.ceil(L.codeTtlMs / 1000));
    });
    try {
      env.sendMail(
        email,
        RPT_MAIL_SUBJECT_,
        '您的登入驗證碼是：' + code + '\n\n10 分鐘內有效。如果不是您本人操作，請忽略這封信。\n\n— ' + RPT_MAIL_SENDER_NAME_
      );
    } catch (mailErr) {
      // 比照報名系統：寄不出去就刪掉這組沒人收到的驗證碼，回固定訊息（不回 MailApp 原文）；授權錯誤照常拋出讓部署者看到
      env.cache.del('RPT_OTP_' + key);
      if (/authoriz|permission|授權|權限/i.test(String(mailErr && mailErr.message ? mailErr.message : mailErr))) throw mailErr;
      fail_('MAIL_FAILED', '驗證碼信寄不出去，請確認 email 是否正確，或稍後再試');
    }
    return { sent: true, message: '如果 email 正確，驗證碼已寄出，請在 10 分鐘內輸入。' };
  }

  function verifyCode_(env, data) {
    var L = limits_(env);
    var email = requireEmail_(data && data.email);
    var code = String((data && data.code) == null ? '' : data.code).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) fail_('BAD_INPUT', '驗證碼是 6 位數字');
    var key = emailKey_(env, email);
    var now = env.now();
    var ok = false;
    env.withLock(function () {
      var rec = parseJson_(env.cache.get('RPT_OTP_' + key), null);
      if (!rec || !(rec.x > now)) fail_('CODE_INVALID', '驗證碼已失效，請重新索取');
      if (rec.t >= L.codeMaxTries) {
        env.cache.del('RPT_OTP_' + key);
        fail_('CODE_LOCKED', '錯誤次數過多，請重新索取驗證碼');
      }
      if (hashEquals_(rec.h, codeHash_(env, email, code))) {
        env.cache.del('RPT_OTP_' + key);
        ok = true;
        return;
      }
      rec.t += 1;
      if (rec.t >= L.codeMaxTries) env.cache.del('RPT_OTP_' + key);
      else env.cache.put('RPT_OTP_' + key, JSON.stringify(rec), Math.max(1, Math.ceil((rec.x - now) / 1000)));
    });
    if (!ok) {
      var left = 0;
      var after = parseJson_(env.cache.get('RPT_OTP_' + key), null);
      if (after) left = L.codeMaxTries - after.t;
      if (left <= 0) fail_('CODE_LOCKED', '錯誤次數過多，請重新索取驗證碼');
      fail_('CODE_WRONG', '驗證碼不正確，還可以再試 ' + left + ' 次');
    }
    var token = createSession_(env, email);
    var out = { token: token, email: email };
    // 加速：登入成功時順便回傳首頁資料（me＋我的行動），前端不必再多一次往返；失敗不影響登入
    if (data && data.withBoot === true) {
      try {
        out.boot = boot_(env, ctxOf_(env, token));
      } catch (e) {
        out.boot = null;
      }
    }
    return out;
  }

  // ---------- Session ----------
  function tokenHash_(env, token) {
    return sha256_(env, 't:' + pepper_(env) + ':' + token);
  }
  function createSession_(env, email) {
    var L = limits_(env);
    var token = RPT_TOKEN_PREFIX_ + env.randomHex(32);
    var h = tokenHash_(env, token);
    var now = env.now();
    env.withLock(function () {
      sweepExpiredSessions_(env, now);
      var idxKey = RPT_P_.sessionIndexPrefix + emailKey_(env, email);
      var idx = propJson_(env, idxKey, []);
      var alive = [];
      for (var i = 0; i < idx.length; i++) {
        var s = propJson_(env, RPT_P_.sessionPrefix + idx[i], null);
        if (s && s.x > now) alive.push({ h: idx[i], c: s.c });
        else env.props.del(RPT_P_.sessionPrefix + idx[i]);
      }
      alive.sort(function (a, b) {
        return a.c - b.c;
      });
      while (alive.length >= L.sessionMaxPerEmail) env.props.del(RPT_P_.sessionPrefix + alive.shift().h);
      setPropJson_(env, RPT_P_.sessionPrefix + h, { e: email, c: now, x: now + L.sessionTtlMs });
      var hs = [];
      for (i = 0; i < alive.length; i++) hs.push(alive[i].h);
      hs.push(h);
      setPropJson_(env, idxKey, hs);
    });
    return token;
  }
  /**
   * 比照報名系統：建立 session 時清掉「所有人」過期的 session，避免不再登入的人留下的紀錄塞滿 ScriptProperties。
   * env.props.keys 可省略（沒有就只清本人的）。呼叫端須持有鎖。
   */
  function sweepExpiredSessions_(env, now) {
    if (typeof env.props.keys !== 'function') return;
    var keys = env.props.keys();
    var i;
    for (i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(RPT_P_.sessionPrefix) !== 0) continue;
      var s = propJson_(env, keys[i], null);
      if (!s || !(s.x > now)) env.props.del(keys[i]);
    }
    for (i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(RPT_P_.sessionIndexPrefix) !== 0) continue;
      var idx = propJson_(env, keys[i], []);
      var keep = [];
      for (var j = 0; j < idx.length; j++) if (env.props.get(RPT_P_.sessionPrefix + idx[j]) != null) keep.push(idx[j]);
      if (!keep.length) env.props.del(keys[i]);
      else if (keep.length !== idx.length) setPropJson_(env, keys[i], keep);
    }
  }
  function isTokenFormat_(token) {
    return isString_(token) && /^fs1_[0-9a-f]{64}$/.test(token);
  }
  /** 驗證 token，回傳 email 或 null */
  function sessionEmail_(env, token) {
    if (!isTokenFormat_(token)) return null;
    var key = RPT_P_.sessionPrefix + tokenHash_(env, token);
    var s = propJson_(env, key, null);
    if (!s) return null;
    if (!(s.x > env.now())) {
      env.props.del(key); // 比照報名系統：讀到過期的就順手刪掉（刪除是冪等的，不需要鎖）
      return null;
    }
    return s.e;
  }
  function logout_(env, token) {
    if (!isTokenFormat_(token)) return { loggedOut: true };
    var h = tokenHash_(env, token);
    var s = propJson_(env, RPT_P_.sessionPrefix + h, null);
    env.withLock(function () {
      env.props.del(RPT_P_.sessionPrefix + h);
      if (s && s.e) {
        var idxKey = RPT_P_.sessionIndexPrefix + emailKey_(env, s.e);
        var idx = propJson_(env, idxKey, []);
        var keep = [];
        for (var i = 0; i < idx.length; i++) if (idx[i] !== h) keep.push(idx[i]);
        setPropJson_(env, idxKey, keep);
      }
    });
    return { loggedOut: true };
  }

  // ---------- 管理者名單 ----------
  function adminList_(env) {
    var list = propJson_(env, RPT_P_.admins, []);
    return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
  }
  function superEmails_(env) {
    var out = [];
    var i;
    for (i = 0; i < RPT_ADMIN_SEED_EMAILS_.length; i++) out.push(normalizeEmail(RPT_ADMIN_SEED_EMAILS_[i]));
    var dep = normalizeEmail(env.deployerEmail ? env.deployerEmail() : '');
    if (dep && !arrayIncludes_(out, dep)) out.push(dep);
    var list = adminList_(env);
    for (i = 0; i < list.length; i++) if (list[i].role === 'super' && !arrayIncludes_(out, list[i].email)) out.push(list[i].email);
    return out;
  }
  /**
   * 全站角色只有兩種：總管理者（super）與一般使用者（user）。
   * 比照報名系統：任何人登入後都能建立自己的行動、成為該行動的負責人（擁有者），不需管理員事先允許；
   * 「負責人／協作者」是每個行動各自的權限（見下方「權限」與 myRole_）。舊版的 'event'（行動負責人）名單不再使用。
   */
  function roleOf_(env, email) {
    if (!email) return 'none';
    if (arrayIncludes_(superEmails_(env), email)) return 'super';
    return 'user';
  }
  function isLockedSuper_(env, email) {
    var dep = normalizeEmail(env.deployerEmail ? env.deployerEmail() : '');
    if (email === dep) return true;
    for (var i = 0; i < RPT_ADMIN_SEED_EMAILS_.length; i++) if (normalizeEmail(RPT_ADMIN_SEED_EMAILS_[i]) === email) return true;
    return false;
  }
  function upsertAdmin_(env, email, role, by) {
    env.withLock(function () {
      var list = adminList_(env);
      var found = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].email === email) {
          list[i].role = role;
          found = true;
        }
      }
      if (!found) list.push({ email: email, role: role, addedBy: by, addedAt: new Date(env.now()).toISOString() });
      setPropJson_(env, RPT_P_.admins, list);
    });
  }
  // ---------- 權限 ----------
  // 每個行動的權限分級（比照報名系統的「擁有者／共同管理者」）：
  //   負責人（owner，建立者）：修改行動設定、新增／移除共同協作者、編輯／刪除任何素材、生成並存回報導
  //   共同協作者（collaborator）：查看行動與所有素材、上傳並編輯／刪除自己的素材、生成並存回報導、退出行動；
  //                               不能改行動設定、不能增減協作者
  //   開放投稿（contributor）：只能上傳並編輯自己的素材
  //   總管理者（super）：所有行動都視同負責人，另可更換負責人
  function ctxOf_(env, token) {
    var email = sessionEmail_(env, token);
    if (!email) fail_('AUTH_REQUIRED', '請先登入（登入可能已過期）');
    return { email: email, role: roleOf_(env, email) };
  }
  function requireSuper_(ctx) {
    if (ctx.role !== 'super') fail_('FORBIDDEN', '只有總管理者可以進行這個操作');
  }
  function isOwner_(ctx, action) {
    return arrayIncludes_(action.owners || [], ctx.email);
  }
  function canManage_(ctx, action) {
    return ctx.role === 'super' || isOwner_(ctx, action);
  }
  function isCollaborator_(ctx, action) {
    return arrayIncludes_(action.collaborators || [], ctx.email);
  }
  function canView_(ctx, action) {
    return canManage_(ctx, action) || isCollaborator_(ctx, action) || !!action.openSubmission;
  }
  function myRole_(ctx, action) {
    if (canManage_(ctx, action)) return 'manager';
    if (isCollaborator_(ctx, action)) return 'collaborator';
    if (action.openSubmission) return 'contributor';
    return 'none';
  }
  function loadAction_(env, ctx, actionId) {
    id_(actionId, '行動 id');
    var a = env.store.getAction(actionId);
    if (!a) fail_('NOT_FOUND', '找不到這個行動');
    if (!canView_(ctx, a)) fail_('FORBIDDEN', '您不是這個行動的協作者，無法查看或投稿');
    return a;
  }
  function canEditMaterial_(ctx, action, m) {
    return canManage_(ctx, action) || m.createdBy === ctx.email;
  }
  /** 回給前端的行動資料：email 名單只給可管理的人看 */
  function publicAction_(ctx, a) {
    var out = {
      id: a.id,
      name: a.name,
      date: a.date,
      endDate: a.endDate || '',
      place: a.place,
      description: a.description,
      openSubmission: !!a.openSubmission,
      defaults: normalizeSettings(a.defaults),
      myRole: myRole_(ctx, a),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt
    };
    // 負責人看得到完整名單；共同協作者只看得到負責人是誰（方便聯絡）；開放投稿者都看不到
    if (out.myRole === 'manager') {
      out.owners = (a.owners || []).slice();
      out.collaborators = (a.collaborators || []).slice();
      out.collaboratorNames = namesFor_(a.collaboratorNames, out.collaborators);
    } else if (out.myRole === 'collaborator') {
      out.owners = (a.owners || []).slice();
    }
    return out;
  }

  // ---------- 行動 ----------
  function newId_(env, prefix) {
    return prefix + new Date(env.now()).toISOString().slice(0, 10).replace(/-/g, '') + '-' + env.randomHex(5);
  }
  /** 協作者名單：去掉負責人本人（負責人已有全部權限，不必重複列為協作者） */
  function collaboratorsFor_(list, owners) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (!arrayIncludes_(owners, list[i])) out.push(list[i]);
    return out;
  }
  /** 只留下名單上的人的姓名（email → 姓名；姓名是選填的備註，不影響權限） */
  function namesFor_(names, emails) {
    var out = {};
    if (!names || typeof names !== 'object') return out;
    for (var i = 0; i < emails.length; i++) if (hasOwn_(names, emails[i]) && names[emails[i]]) out[emails[i]] = names[emails[i]];
    return out;
  }
  function personName_(v) {
    return str_(v == null ? '' : v, '姓名', 40, false);
  }
  /**
   * 協作者輸入：相容舊格式（字串「一行一個／逗號分隔」或 email 陣列），
   * 新格式為 [{ email, name }]，或 email 陣列＋另送 collaboratorNames { email: 姓名 }。
   */
  function collaboratorInput_(list, namesIn) {
    var emails = [];
    var names = {};
    var items = list;
    if (items == null) items = [];
    if (isString_(items)) items = items.split(/[\s,;，；、]+/);
    if (Object.prototype.toString.call(items) !== '[object Array]') fail_('BAD_INPUT', '協作者 email 格式不正確');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var raw = it && typeof it === 'object' ? it.email : it;
      if (!trim_(raw)) continue;
      var e = requireEmail_(raw, '協作者 email');
      if (!arrayIncludes_(emails, e)) emails.push(e);
      var n = it && typeof it === 'object' ? personName_(it.name) : '';
      if (n) names[e] = n;
    }
    if (namesIn && typeof namesIn === 'object') {
      for (var k in namesIn) {
        if (!hasOwn_(namesIn, k)) continue;
        var ek = normalizeEmail(k);
        var nk = personName_(namesIn[k]);
        if (nk && arrayIncludes_(emails, ek)) names[ek] = nk;
      }
    }
    if (emails.length > RPT_MAX_COLLABORATORS_) fail_('BAD_INPUT', '協作者 email 最多 ' + RPT_MAX_COLLABORATORS_ + ' 個');
    return { emails: emails, names: names };
  }
  function actionFields_(data, isCreate, canChangeOwners) {
    var out = {};
    out.name = str_(data.name, '行動名稱', 100, true);
    out.date = str_(data.date, '日期', 10, true);
    if (!isValidDate_(out.date)) fail_('BAD_INPUT', '日期格式需為 YYYY-MM-DD');
    // 結束日期（選填）：多天的行動；空白或與開始日期相同＝單日
    out.endDate = str_(data.endDate == null ? '' : data.endDate, '結束日期', 10, false);
    if (out.endDate) {
      if (!isValidDate_(out.endDate)) fail_('BAD_INPUT', '結束日期格式需為 YYYY-MM-DD');
      if (out.endDate < out.date) fail_('BAD_INPUT', '結束日期不能早於開始日期');
      if (Date.parse(out.endDate) - Date.parse(out.date) > 366 * 86400000) fail_('BAD_INPUT', '行動期間最長一年');
      if (out.endDate === out.date) out.endDate = '';
    }
    out.place = str_(data.place, '地點', 100, false);
    out.description = str_(data.description, '說明', 2000, false);
    // 一般使用者送來的 owners 一律忽略（建立者就是負責人）；只有總管理者可以指定或更換負責人
    if (canChangeOwners && (data.owners != null || data.ownerEmail != null)) {
      out.owners = emailList_(data.owners != null ? data.owners : data.ownerEmail, '負責人 email', 5);
      if (!out.owners.length) fail_('BAD_INPUT', '請填寫負責人 email');
    }
    // 修改時沒送 collaborators 就維持原名單（協作者改用 actions.addCollaborator／removeCollaborator 增減）
    if (isCreate || data.collaborators != null) {
      var ci = collaboratorInput_(data.collaborators, data.collaboratorNames);
      out.collaborators = ci.emails;
      out.collaboratorNames = ci.names;
    }
    out.openSubmission = data.openSubmission === true;
    out.defaults = normalizeSettings(data.defaults);
    return out;
  }
  /** 一般使用者每天（台北日）最多建立幾個行動：任何人都能建立，避免被大量灌入 */
  function checkCreateQuota_(env, ctx) {
    if (ctx.role === 'super') return;
    var today = taipeiDay_(env.now());
    var all = env.store.listActions();
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      var t = Date.parse(all[i].createdAt);
      if (all[i].createdBy === ctx.email && t && taipeiDay_(t) === today) n++;
    }
    if (n >= limits_(env).actionsPerUserPerDay) fail_('RATE_LIMITED', '今天建立的行動已達上限（' + limits_(env).actionsPerUserPerDay + ' 個），請明天再建立');
  }
  /** 行動名稱比對用：去掉空白、全形半形空白，不分大小寫 */
  function sameName_(x, y) {
    var n = function (s) {
      return String(s || '').replace(/[\s\u3000]+/g, '').toLowerCase();
    };
    return n(x) === n(y);
  }
  /** 同一個人已建立的「同名、同開始日期」行動（避免連點或重填造成重複） */
  function findDuplicate_(env, ctx, f) {
    var all = env.store.listActions();
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      if (a.createdBy === ctx.email && a.date === f.date && sameName_(a.name, f.name) && canManage_(ctx, a)) return a;
    }
    return null;
  }
  /** 重複建立時改成更新原本那一筆：有填的欄位覆蓋、協作者合併（不會少人） */
  function mergeIntoExisting_(env, ctx, a, f) {
    if (f.endDate) a.endDate = f.endDate;
    if (f.place) a.place = f.place;
    if (f.description) a.description = f.description;
    if (f.openSubmission) a.openSubmission = true;
    var list = (a.collaborators || []).slice();
    var add = collaboratorsFor_(f.collaborators || [], a.owners || []);
    for (var i = 0; i < add.length; i++) if (!arrayIncludes_(list, add[i]) && list.length < RPT_MAX_COLLABORATORS_) list.push(add[i]);
    a.collaborators = list;
    var names = namesFor_(a.collaboratorNames, list);
    for (var k in f.collaboratorNames || {}) if (hasOwn_(f.collaboratorNames, k) && arrayIncludes_(list, k)) names[k] = f.collaboratorNames[k];
    a.collaboratorNames = names;
    a.updatedAt = new Date(env.now()).toISOString();
    env.store.updateAction(a);
    return a;
  }
  function createAction_(env, ctx, data) {
    data = data || {};
    var f = actionFields_(data, true, ctx.role === 'super');
    // 同一次送出（網路重送、連點）只建立一次：前端每次按下「建立行動」產生一個 requestId
    var reqKey = null;
    if (data.requestId != null) {
      var rid = str_(data.requestId, 'requestId', 64, false);
      if (rid && !/^[A-Za-z0-9_-]{8,64}$/.test(rid)) fail_('BAD_INPUT', 'requestId 格式不正確');
      if (rid) reqKey = 'RPT_CREQ_' + emailKey_(env, ctx.email) + '_' + rid;
    }
    var owners = f.owners || [ctx.email];
    var now = new Date(env.now()).toISOString();
    var result = null;
    env.withLock(function () {
      if (reqKey) {
        var prevId = env.cache.get(reqKey);
        var prev = prevId ? env.store.getAction(prevId) : null;
        if (prev) {
          result = { action: publicAction_(ctx, prev), duplicate: 'request' };
          return;
        }
      }
      var dup = findDuplicate_(env, ctx, f);
      if (dup) {
        dup = mergeIntoExisting_(env, ctx, dup, f);
        if (reqKey) env.cache.put(reqKey, dup.id, 600);
        result = { action: publicAction_(ctx, dup), duplicate: 'merged' };
      }
    });
    if (result) {
      if (result.duplicate === 'merged') rememberContacts_(env, ctx.email, result.action.collaborators || [], f.collaboratorNames);
      return result;
    }
    var a = {
      id: newId_(env, 'a'),
      name: f.name,
      date: f.date,
      endDate: f.endDate,
      place: f.place,
      description: f.description,
      owners: owners,
      collaborators: collaboratorsFor_(f.collaborators, owners),
      openSubmission: f.openSubmission,
      defaults: f.defaults,
      createdBy: ctx.email,
      createdAt: now,
      updatedAt: now
    };
    a.collaboratorNames = namesFor_(f.collaboratorNames, a.collaborators);
    env.withLock(function () {
      // 鎖內再查一次：兩個請求同時送到時，只有第一個會建立
      var dup = findDuplicate_(env, ctx, f);
      if (dup) {
        result = { action: publicAction_(ctx, mergeIntoExisting_(env, ctx, dup, f)), duplicate: 'merged' };
        return;
      }
      checkCreateQuota_(env, ctx);
      env.store.createAction(a);
      if (reqKey) env.cache.put(reqKey, a.id, 600);
    });
    if (result) return result;
    rememberContacts_(env, ctx.email, a.collaborators, a.collaboratorNames);
    return { action: publicAction_(ctx, a) };
  }
  /** 刪除行動：負責人或總管理者；Drive 資料夾（含素材試算表、照片、影片、錄音）移到垃圾桶，30 天內可救回 */
  function deleteAction_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.id);
    if (!canManage_(ctx, a)) fail_('FORBIDDEN', '只有這個行動的負責人可以刪除行動');
    // 防誤刪：要送出行動名稱確認
    if (!sameName_(data.confirmName, a.name)) fail_('BAD_INPUT', '請輸入正確的行動名稱以確認刪除');
    env.withLock(function () {
      env.store.deleteAction(a.id);
    });
    return { deleted: true, id: a.id };
  }
  function updateAction_(env, ctx, data) {
    var a = loadAction_(env, ctx, data && data.id);
    if (!canManage_(ctx, a)) fail_('FORBIDDEN', '只有這個行動的負責人可以修改行動設定');
    var f = actionFields_(data, false, ctx.role === 'super');
    a.name = f.name;
    a.date = f.date;
    a.endDate = f.endDate;
    a.place = f.place;
    a.description = f.description;
    if (f.owners) a.owners = f.owners;
    a.collaborators = collaboratorsFor_(f.collaborators || a.collaborators || [], a.owners);
    // 姓名：有送新名單就合併（新送的優先），沒送就保留原本的
    var mergedNames = {};
    var k;
    for (k in a.collaboratorNames || {}) if (hasOwn_(a.collaboratorNames, k)) mergedNames[k] = a.collaboratorNames[k];
    for (k in f.collaboratorNames || {}) if (hasOwn_(f.collaboratorNames, k)) mergedNames[k] = f.collaboratorNames[k];
    a.collaboratorNames = namesFor_(mergedNames, a.collaborators);
    a.openSubmission = f.openSubmission;
    a.defaults = f.defaults;
    a.updatedAt = new Date(env.now()).toISOString();
    env.withLock(function () {
      env.store.updateAction(a);
    });
    return { action: publicAction_(ctx, a) };
  }
  /** 負責人新增共同協作者（email）；回傳更新後的行動 */
  function addCollaborator_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    if (!canManage_(ctx, a)) fail_('FORBIDDEN', '只有這個行動的負責人可以新增協作者');
    var email = requireEmail_(data.email, '協作者 email');
    var name = personName_(data.name);
    if (arrayIncludes_(a.owners || [], email)) fail_('BAD_INPUT', '這個 email 已經是負責人');
    env.withLock(function () {
      a = env.store.getAction(a.id) || a; // 在鎖內重讀，避免同時增減時蓋掉別人的變更
      var list = (a.collaborators || []).slice();
      if (!arrayIncludes_(list, email)) {
        if (list.length >= RPT_MAX_COLLABORATORS_) fail_('BAD_INPUT', '協作者最多 ' + RPT_MAX_COLLABORATORS_ + ' 位');
        list.push(email);
      }
      a.collaborators = list;
      // 已在名單上再新增一次＝更新姓名
      var names = namesFor_(a.collaboratorNames, list);
      if (name) names[email] = name;
      a.collaboratorNames = names;
      a.updatedAt = new Date(env.now()).toISOString();
      env.store.updateAction(a);
    });
    var nm = {};
    if (name) nm[email] = name;
    rememberContacts_(env, ctx.email, [email], nm);
    return { action: publicAction_(ctx, a) };
  }
  /** 負責人移除共同協作者；協作者也可以把自己移除（退出行動）。已上傳的素材保留，由負責人決定是否刪除。 */
  function removeCollaborator_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    var email = requireEmail_(data.email, '協作者 email');
    if (!canManage_(ctx, a) && email !== ctx.email) fail_('FORBIDDEN', '只有這個行動的負責人可以移除協作者');
    if (arrayIncludes_(a.owners || [], email)) fail_('BAD_INPUT', '負責人不能被移除');
    env.withLock(function () {
      a = env.store.getAction(a.id) || a;
      var keep = [];
      for (var i = 0; i < (a.collaborators || []).length; i++) if (a.collaborators[i] !== email) keep.push(a.collaborators[i]);
      a.collaborators = keep;
      a.collaboratorNames = namesFor_(a.collaboratorNames, keep);
      a.updatedAt = new Date(env.now()).toISOString();
      env.store.updateAction(a);
    });
    return { action: canView_(ctx, a) ? publicAction_(ctx, a) : null, left: email === ctx.email };
  }
  function listActions_(env, ctx) {
    var all = env.store.listActions();
    var out = [];
    for (var i = 0; i < all.length; i++) if (canView_(ctx, all[i])) out.push(publicAction_(ctx, all[i]));
    out.sort(function (a, b) {
      return a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1;
    });
    return { actions: out };
  }

  // ---------- 素材 ----------
  function cleanMaterial_(env, ctx, action, data, existing) {
    var m = {};
    m.kind = data.kind === 'testimony' ? 'testimony' : data.kind === 'report' ? 'report' : fail_('BAD_INPUT', '類型只能是「報導」或「見證」');
    m.title = str_(data.title, '標題', 200, true);
    m.author = str_(data.author, '作者署名', 100, false);
    m.text = str_(data.text, '文字', 20000, false);
    var photos = data.photos || [];
    var videos = data.videos || [];
    if (Object.prototype.toString.call(photos) !== '[object Array]' || photos.length > 30) fail_('BAD_INPUT', '照片最多 30 張');
    if (Object.prototype.toString.call(videos) !== '[object Array]' || videos.length > 10) fail_('BAD_INPUT', '影片最多 10 部');
    var known = {};
    var i;
    if (existing) {
      for (i = 0; i < existing.photos.length; i++) known[existing.photos[i].id] = true;
      for (i = 0; i < existing.videos.length; i++) {
        if (existing.videos[i].fileId) known[existing.videos[i].fileId] = true;
        if (existing.videos[i].coverPhotoId) known[existing.videos[i].coverPhotoId] = true;
      }
    }
    // 新引用的檔案必須屬於這個行動，且是本人上傳的（管理者可引用任何人的）
    function checkFile(fileId, kind) {
      id_(fileId, '檔案 id');
      if (known[fileId]) return;
      var f = env.store.getFile(action.id, fileId, false);
      if (!f || !f.meta || f.meta.kind !== kind) fail_('BAD_INPUT', '找不到上傳的' + (kind === 'photo' ? '照片' : '影片') + '，請重新上傳');
      if (f.meta.uploadedBy !== ctx.email && !canManage_(ctx, action)) fail_('FORBIDDEN', '不能引用別人上傳的檔案');
      known[fileId] = true;
    }
    m.photos = [];
    var hasCover = false;
    for (i = 0; i < photos.length; i++) {
      var p = photos[i] || {};
      checkFile(p.id, 'photo');
      var cover = p.cover === true && !hasCover;
      if (cover) hasCover = true;
      m.photos.push({ id: p.id, caption: str_(p.caption, '圖說', 300, false), cover: cover });
    }
    m.videos = [];
    for (i = 0; i < videos.length; i++) {
      var v = videos[i] || {};
      var vv = { title: str_(v.title, '影片標題', 200, false) };
      if (v.kind === 'link') {
        if (!isAllowedVideoUrl(v.url)) fail_('BAD_INPUT', '影片連結只接受 https 的 YouTube 或 Google Drive 網址');
        vv.kind = 'link';
        vv.url = v.url;
      } else if (v.kind === 'drive') {
        checkFile(v.fileId, 'video');
        vv.kind = 'drive';
        vv.fileId = v.fileId;
        vv.url = 'https://drive.google.com/file/d/' + v.fileId + '/view';
      } else fail_('BAD_INPUT', '影片類型不正確');
      if (v.coverPhotoId) {
        checkFile(v.coverPhotoId, 'photo');
        vv.coverPhotoId = v.coverPhotoId;
      }
      m.videos.push(vv);
    }
    if (!m.text && !m.photos.length && !m.videos.length) fail_('BAD_INPUT', '請至少填寫文字、照片或影片其中一項');
    return m;
  }
  function saveMaterial_(env, ctx, data) {
    data = data || {};
    var action = loadAction_(env, ctx, data.actionId);
    var now = new Date(env.now()).toISOString();
    var existing = null;
    if (data.id) {
      existing = env.store.getMaterial(action.id, id_(data.id, '素材 id'));
      if (!existing) fail_('NOT_FOUND', '找不到這筆素材');
      if (!canEditMaterial_(ctx, action, existing)) fail_('FORBIDDEN', '只能編輯自己上傳的素材');
    }
    var m = cleanMaterial_(env, ctx, action, data, existing);
    if (existing) {
      m.id = existing.id;
      m.createdBy = existing.createdBy;
      m.createdAt = existing.createdAt;
    } else {
      m.id = newId_(env, 'm');
      m.createdBy = ctx.email;
      m.createdAt = now;
    }
    m.actionId = action.id;
    m.updatedAt = now;
    env.withLock(function () {
      env.store.putMaterial(action.id, m);
    });
    return { material: publicMaterial_(ctx, action, m) };
  }
  function publicMaterial_(ctx, action, m) {
    return {
      id: m.id,
      actionId: m.actionId,
      kind: m.kind,
      title: m.title,
      author: m.author,
      text: m.text,
      photos: m.photos,
      videos: m.videos,
      mine: m.createdBy === ctx.email,
      canEdit: canEditMaterial_(ctx, action, m),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    };
  }
  function listMaterials_(env, ctx, data) {
    var action = loadAction_(env, ctx, data && data.actionId);
    var list = env.store.listMaterials(action.id);
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(publicMaterial_(ctx, action, list[i]));
    out.sort(function (a, b) {
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    return { materials: out };
  }
  function deleteMaterial_(env, ctx, data) {
    var action = loadAction_(env, ctx, data && data.actionId);
    var m = env.store.getMaterial(action.id, id_(data.id, '素材 id'));
    if (!m) fail_('NOT_FOUND', '找不到這筆素材');
    if (!canEditMaterial_(ctx, action, m)) fail_('FORBIDDEN', '只能刪除自己上傳的素材');
    env.withLock(function () {
      env.store.deleteMaterial(action.id, m.id);
    });
    var i;
    for (i = 0; i < m.photos.length; i++) env.store.deleteFile(action.id, m.photos[i].id);
    for (i = 0; i < m.videos.length; i++) {
      if (m.videos[i].fileId) env.store.deleteFile(action.id, m.videos[i].fileId);
      if (m.videos[i].coverPhotoId) env.store.deleteFile(action.id, m.videos[i].coverPhotoId);
    }
    return { deleted: true };
  }

  // ---------- 照片／影片 ----------
  function uploadPhoto_(env, ctx, data) {
    data = data || {};
    var action = loadAction_(env, ctx, data.actionId);
    var L = limits_(env);
    var b64 = isString_(data.data) ? data.data.replace(/^data:[^,]*,/, '') : '';
    if (!b64 || !/^[A-Za-z0-9+\/]+={0,2}$/.test(b64)) fail_('BAD_INPUT', '照片資料格式不正確');
    var mime = detectImageType(b64);
    if (!mime) fail_('BAD_INPUT', '只接受 JPEG、PNG、WebP 照片');
    var size = base64Size_(b64);
    if (size > L.photoMaxBytes) fail_('TOO_LARGE', '照片超過 1.5MB，請縮小後再上傳');
    var ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
    var id = env.store.saveFile(action.id, {
      name: 'photo-' + new Date(env.now()).toISOString().replace(/[:.]/g, '-') + '.' + ext,
      mime: mime,
      base64: b64,
      meta: { kind: 'photo', uploadedBy: ctx.email, uploadedAt: new Date(env.now()).toISOString() }
    });
    return { photo: { id: id, mime: mime, size: size } };
  }
  function getPhoto_(env, ctx, data) {
    var action = loadAction_(env, ctx, data && data.actionId);
    var f = env.store.getFile(action.id, id_(data.id, '照片 id'), true);
    if (!f || !f.meta || f.meta.kind !== 'photo') fail_('NOT_FOUND', '找不到照片');
    return { photo: { id: f.id, mime: f.mime, data: f.base64 } };
  }
  function videoMaxMb_(env) {
    var n = Number(env.props.get(RPT_P_.videoMaxMb));
    return n > 0 ? n : limits_(env).videoMaxMbDefault;
  }
  // 影片與錄音檔共用的 Drive 直傳（resumable upload）：kind 決定 mime 白名單與大小上限
  var MEDIA_KINDS_ = {
    video: { label: '影片', mime: /^video\/[A-Za-z0-9.+-]+$/, tooLarge: '，請改貼 YouTube／Google Drive 連結' },
    // m4a 常被標成 audio/x-m4a、audio/mp4，有些手機錄音是 video/mp4（只有聲音）
    audio: { label: '錄音檔', mime: /^(audio\/[A-Za-z0-9.+-]+|video\/(mp4|webm|quicktime))$/, tooLarge: '' }
  };
  function mediaMaxMb_(env, kind) {
    return kind === 'audio' ? audioMaxMb_(env) : videoMaxMb_(env);
  }
  function createMediaUpload_(env, ctx, data, kind) {
    data = data || {};
    var K = MEDIA_KINDS_[kind];
    var action = loadAction_(env, ctx, data.actionId);
    if (kind === 'audio') requireWork_(ctx, action);
    var name = str_(data.name, '檔名', 200, true).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_');
    var mime = str_(data.mime, '檔案類型', 100, true);
    if (!K.mime.test(mime)) fail_('BAD_INPUT', '只接受' + K.label);
    var size = Number(data.size);
    var maxMb = mediaMaxMb_(env, kind);
    if (!(size > 0) || Math.floor(size) !== size) fail_('BAD_INPUT', '檔案大小不正確');
    if (size > maxMb * 1024 * 1024) fail_('TOO_LARGE', K.label + '超過 ' + maxMb + 'MB 上限' + K.tooLarge);
    var origin = str_(data.origin, 'origin', 200, true);
    if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin)) fail_('BAD_INPUT', 'origin 格式不正確');
    var up = env.store.createResumableUpload(action.id, {
      name: name,
      mime: mime,
      size: size,
      origin: origin,
      meta: { kind: kind + '-pending', uploadedBy: ctx.email }
    });
    return { uploadUrl: up.uploadUrl, maxBytes: maxMb * 1024 * 1024 };
  }
  function completeMediaUpload_(env, ctx, data, kind) {
    var K = MEDIA_KINDS_[kind];
    var action = loadAction_(env, ctx, data && data.actionId);
    var f = env.store.getFile(action.id, id_(data.fileId, '檔案 id'), false);
    if (!f || !f.meta || (f.meta.kind !== kind + '-pending' && f.meta.kind !== kind)) fail_('NOT_FOUND', '找不到上傳的' + K.label + '（可能尚未上傳完成）');
    if (f.meta.uploadedBy !== ctx.email && !canManage_(ctx, action)) fail_('FORBIDDEN', '不能引用別人上傳的檔案');
    var maxBytes = mediaMaxMb_(env, kind) * 1024 * 1024;
    if (!K.mime.test(f.mime || '') || f.size > maxBytes) {
      env.store.deleteFile(action.id, f.id);
      fail_('TOO_LARGE', K.label + '格式不正確或超過大小上限，已刪除');
    }
    env.store.setFileMeta(action.id, f.id, { kind: kind, uploadedBy: f.meta.uploadedBy, uploadedAt: new Date(env.now()).toISOString() });
    var out = {};
    out[kind] = { fileId: f.id, size: f.size, mime: f.mime };
    return out;
  }
  function createVideoUpload_(env, ctx, data) {
    return createMediaUpload_(env, ctx, data, 'video');
  }
  function completeVideoUpload_(env, ctx, data) {
    return completeMediaUpload_(env, ctx, data, 'video');
  }
  function createAudioUpload_(env, ctx, data) {
    return createMediaUpload_(env, ctx, data, 'audio');
  }
  function completeAudioUpload_(env, ctx, data) {
    return completeMediaUpload_(env, ctx, data, 'audio');
  }

  // ---------- 產出紀錄 ----------
  function saveOutput_(env, ctx, data) {
    data = data || {};
    var action = loadAction_(env, ctx, data.actionId);
    if (!canManage_(ctx, action) && !isCollaborator_(ctx, action)) fail_('FORBIDDEN', '只有負責人或協作者可以把報導存回後端');
    var html = data.html;
    if (!isString_(html) || !html || html.length > limits_(env).outputMaxChars) fail_('BAD_INPUT', '報導內容不正確或太大');
    var title = str_(data.title, '標題', 200, true);
    var now = new Date(env.now()).toISOString();
    var fileId = env.store.saveTextFile(action.id, {
      name: '報導-' + now.slice(0, 19).replace(/[:T]/g, '-') + '.html',
      mime: 'text/html',
      text: html,
      meta: { kind: 'output', uploadedBy: ctx.email }
    });
    var rec = {
      id: newId_(env, 'o'),
      title: title,
      fileId: fileId,
      settings: normalizeSettings(data.settings),
      chars: Math.max(0, Math.floor(Number(data.chars) || 0)),
      photos: Math.max(0, Math.floor(Number(data.photos) || 0)),
      createdBy: ctx.email,
      createdAt: now
    };
    env.withLock(function () {
      env.store.addOutput(action.id, rec);
    });
    return { output: rec };
  }
  function listOutputs_(env, ctx, data) {
    var action = loadAction_(env, ctx, data && data.actionId);
    var list = env.store.listOutputs(action.id);
    list.sort(function (a, b) {
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    return { outputs: list };
  }

  // ---------- 常用聯絡人（每位使用者自己的，存在 ScriptProperties；單一值上限約 9KB） ----------
  function contactsKey_(env, email) {
    return RPT_P_.contactsPrefix + emailKey_(env, email);
  }
  function readContacts_(env, email) {
    var list = propJson_(env, contactsKey_(env, email), []);
    return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
  }
  function writeContacts_(env, email, list) {
    list.sort(function (a, b) {
      return b.t - a.t;
    });
    var max = limits_(env).contactsMax;
    while (list.length > max) list.pop();
    while (list.length && JSON.stringify(list).length > 8000) list.pop();
    setPropJson_(env, contactsKey_(env, email), list);
  }
  /** 新增協作者時順手記到負責人的常用聯絡人；失敗不影響主要操作 */
  function rememberContacts_(env, owner, emails, names) {
    if (!emails || !emails.length) return;
    try {
      env.withLock(function () {
        var list = readContacts_(env, owner);
        var now = env.now();
        for (var i = 0; i < emails.length; i++) {
          var e = emails[i];
          if (e === owner) continue;
          var found = null;
          for (var j = 0; j < list.length; j++) if (list[j].e === e) found = list[j];
          var n = names && hasOwn_(names, e) ? names[e] : '';
          if (found) {
            found.c = (found.c || 0) + 1;
            found.t = now;
            if (n) found.n = n;
          } else list.push({ e: e, n: n || '', c: 1, t: now });
        }
        writeContacts_(env, owner, list);
      });
    } catch (err) {
      if (env.log) env.log('contacts: ' + sanitizeError(err && err.message ? err.message : err));
    }
  }
  function publicContacts_(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ email: list[i].e, name: list[i].n || '', count: list[i].c || 0, lastUsed: new Date(list[i].t || 0).toISOString() });
    return out;
  }
  function listContacts_(env, ctx) {
    return { contacts: publicContacts_(readContacts_(env, ctx.email)) };
  }
  function saveContact_(env, ctx, data) {
    data = data || {};
    var email = requireEmail_(data.email, '聯絡人 email');
    var name = personName_(data.name);
    var list;
    env.withLock(function () {
      list = readContacts_(env, ctx.email);
      var found = null;
      for (var i = 0; i < list.length; i++) if (list[i].e === email) found = list[i];
      if (found) found.n = name;
      else list.push({ e: email, n: name, c: 0, t: env.now() });
      writeContacts_(env, ctx.email, list);
    });
    return { contacts: publicContacts_(list) };
  }
  function removeContact_(env, ctx, data) {
    var email = requireEmail_(data && data.email, '聯絡人 email');
    var keep = [];
    env.withLock(function () {
      var list = readContacts_(env, ctx.email);
      for (var i = 0; i < list.length; i++) if (list[i].e !== email) keep.push(list[i]);
      writeContacts_(env, ctx.email, keep);
    });
    return { contacts: publicContacts_(keep) };
  }

  // ---------- 合併查詢（加速）：Apps Script 每次往返固定要 1 秒以上，畫面需要的資料一次拿齊 ----------
  function meInfo_(env, ctx) {
    return {
      email: ctx.email,
      role: ctx.role,
      presets: RPT_PRESETS_,
      ranges: RPT_SETTING_RANGES_,
      layouts: RPT_LAYOUTS_,
      videoMaxMb: videoMaxMb_(env),
      audioMaxMb: audioMaxMb_(env),
      ai: aiStatus_(env),
      version: RPT_VERSION_
    };
  }
  /** 首頁：我是誰＋我的行動 */
  function boot_(env, ctx) {
    var out = listActions_(env, ctx);
    out.me = meInfo_(env, ctx);
    return out;
  }
  /** 行動頁：只讀這一個行動（不必掃整份索引）＋素材＋錄音摘要；withMe 時一併回傳 me */
  function openAction_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    var list = env.store.listMaterials(a.id);
    var mats = [];
    for (var i = 0; i < list.length; i++) mats.push(publicMaterial_(ctx, a, list[i]));
    mats.sort(function (x, y) {
      return x.createdAt < y.createdAt ? -1 : 1;
    });
    var out = { action: publicAction_(ctx, a), materials: mats, recordings: recordingSummaries_(env, ctx, a) };
    if (data.withMe) out.me = meInfo_(env, ctx);
    return out;
  }
  /** 一次取多張照片；thumb=true 時回傳縮圖（列表用，正式環境由 Drive 產生，約 220px） */
  function getPhotos_(env, ctx, data) {
    data = data || {};
    var action = loadAction_(env, ctx, data.actionId);
    var ids = data.ids;
    if (Object.prototype.toString.call(ids) !== '[object Array]' || !ids.length) fail_('BAD_INPUT', '請指定照片');
    if (ids.length > limits_(env).photosPerBatch) fail_('BAD_INPUT', '一次最多取 ' + limits_(env).photosPerBatch + ' 張照片');
    var thumb = data.thumb === true;
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var id = id_(ids[i], '照片 id');
      var f = env.store.getFile(action.id, id, true, thumb ? { thumb: true } : null);
      if (!f || !f.meta || f.meta.kind !== 'photo') out.push({ id: id, error: 'NOT_FOUND' });
      else out.push({ id: id, mime: f.mime, data: f.base64, thumb: !!f.thumb });
    }
    return { photos: out };
  }

  // ---------- OpenAI 設定（總管理者） ----------
  function aiConfig_(env) {
    var c = propJson_(env, RPT_P_.aiConfig, {});
    return {
      transcribeModel: (c && c.transcribeModel) || RPT_AI_DEFAULTS_.transcribeModel,
      chatModel: (c && c.chatModel) || RPT_AI_DEFAULTS_.chatModel
    };
  }
  function aiKey_(env) {
    return env.props.get(RPT_P_.aiKey) || '';
  }
  /** env.ai.fake：mock／示範模式的假 AI，不需要金鑰 */
  function aiReady_(env) {
    return !!(env.ai && (env.ai.fake || aiKey_(env)));
  }
  function aiStatus_(env) {
    var c = aiConfig_(env);
    return { ready: aiReady_(env), transcribeModel: c.transcribeModel, chatModel: c.chatModel, fake: !!(env.ai && env.ai.fake) };
  }
  function requireAi_(env) {
    if (!aiReady_(env)) fail_('AI_NOT_READY', '尚未設定 OpenAI 金鑰，請總管理者到「總管理者名單」頁設定後再試');
  }
  function audioMaxMb_(env) {
    var n = Number(env.props.get(RPT_P_.audioMaxMb));
    return n > 0 ? n : limits_(env).audioMaxMbDefault;
  }
  function getAiConfig_(env, ctx) {
    requireSuper_(ctx);
    var key = aiKey_(env);
    var c = aiConfig_(env);
    return {
      transcribeModel: c.transcribeModel,
      chatModel: c.chatModel,
      defaults: RPT_AI_DEFAULTS_,
      hasKey: !!key,
      // 只回傳末 4 碼讓管理者確認是哪一把；金鑰本身不會離開後端
      keyHint: key ? '…' + key.slice(-4) : '',
      audioMaxMb: audioMaxMb_(env),
      fake: !!(env.ai && env.ai.fake)
    };
  }
  function setAiConfig_(env, ctx, data) {
    requireSuper_(ctx);
    data = data || {};
    var MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;
    var c = propJson_(env, RPT_P_.aiConfig, {}) || {};
    if (data.transcribeModel != null) {
      var tm = trim_(data.transcribeModel);
      if (tm && !MODEL_RE.test(tm)) fail_('BAD_INPUT', '轉錄模型名稱格式不正確');
      c.transcribeModel = tm || '';
    }
    if (data.chatModel != null) {
      var cm = trim_(data.chatModel);
      if (cm && !MODEL_RE.test(cm)) fail_('BAD_INPUT', 'AI 修正／彙整模型名稱格式不正確');
      c.chatModel = cm || '';
    }
    if (data.audioMaxMb != null) {
      var mb = Number(data.audioMaxMb);
      if (!(mb >= 1 && mb <= 4000) || Math.floor(mb) !== mb) fail_('BAD_INPUT', '錄音上限需為 1–4000 MB 的整數');
      env.props.set(RPT_P_.audioMaxMb, String(mb));
    }
    setPropJson_(env, RPT_P_.aiConfig, c);
    if (data.clearKey === true) env.props.del(RPT_P_.aiKey);
    else if (data.apiKey != null && trim_(data.apiKey)) {
      var k = trim_(data.apiKey);
      if (!/^sk-[A-Za-z0-9_-]{20,300}$/.test(k)) fail_('BAD_INPUT', 'OpenAI 金鑰格式不正確（應為 sk- 開頭）');
      env.props.set(RPT_P_.aiKey, k);
    }
    return getAiConfig_(env, ctx);
  }

  // ---------- 逐字稿規則（全站＋各行動，可以慢慢累積） ----------
  function cleanRules_(r) {
    r = r && typeof r === 'object' ? r : {};
    var out = { vocabulary: [], replacements: [], correctionNotes: '', summaryNotes: '' };
    var vocab = r.vocabulary;
    if (isString_(vocab)) vocab = vocab.split(/[\n,，、]+/);
    if (vocab != null && Object.prototype.toString.call(vocab) !== '[object Array]') fail_('BAD_INPUT', '常用詞彙格式不正確');
    var i;
    for (i = 0; vocab && i < vocab.length; i++) {
      var w = str_(vocab[i] == null ? '' : String(vocab[i]), '常用詞彙', 40, false);
      if (w && !arrayIncludes_(out.vocabulary, w)) out.vocabulary.push(w);
    }
    if (out.vocabulary.length > 400) fail_('BAD_INPUT', '常用詞彙最多 400 個');
    var reps = r.replacements;
    if (reps != null && Object.prototype.toString.call(reps) !== '[object Array]') fail_('BAD_INPUT', '替換規則格式不正確');
    for (i = 0; reps && i < reps.length; i++) {
      var it = reps[i] || {};
      var from = str_(it.from == null ? '' : String(it.from), '替換規則（原字）', 40, false);
      var to = str_(it.to == null ? '' : String(it.to), '替換規則（改成）', 40, false);
      if (!from || from === to) continue;
      var dup = false;
      for (var j = 0; j < out.replacements.length; j++) if (out.replacements[j].from === from) (out.replacements[j].to = to), (dup = true);
      if (!dup) out.replacements.push({ from: from, to: to });
    }
    if (out.replacements.length > 400) fail_('BAD_INPUT', '替換規則最多 400 條');
    out.correctionNotes = str_(r.correctionNotes, 'AI 修正說明', 3000, false);
    out.summaryNotes = str_(r.summaryNotes, '重點彙整說明', 3000, false);
    return out;
  }
  function globalRules_(env) {
    var r = env.store.getDoc(null, 'rules');
    return r ? cleanRules_(r) : cleanRules_(RPT_DEFAULT_RULES_);
  }
  function actionRules_(env, aid) {
    var r = env.store.getDoc(aid, 'rules');
    return r ? cleanRules_(r) : cleanRules_({});
  }
  /** 全站規則＋本行動規則：詞彙聯集；替換規則同一原字以本行動為準；說明兩段相接 */
  function mergedRules_(env, aid) {
    var g = globalRules_(env);
    var a = actionRules_(env, aid);
    var out = { vocabulary: g.vocabulary.slice(), replacements: [], correctionNotes: '', summaryNotes: '' };
    var i;
    for (i = 0; i < a.vocabulary.length; i++) if (!arrayIncludes_(out.vocabulary, a.vocabulary[i])) out.vocabulary.push(a.vocabulary[i]);
    var map = {};
    var order = [];
    var all = g.replacements.concat(a.replacements);
    for (i = 0; i < all.length; i++) {
      if (!hasOwn_(map, all[i].from)) order.push(all[i].from);
      map[all[i].from] = all[i].to;
    }
    for (i = 0; i < order.length; i++) out.replacements.push({ from: order[i], to: map[order[i]] });
    out.correctionNotes = [g.correctionNotes, a.correctionNotes].join('\n').replace(/^\s+|\s+$/g, '');
    out.summaryNotes = [g.summaryNotes, a.summaryNotes].join('\n').replace(/^\s+|\s+$/g, '');
    return out;
  }
  /** 逐字套用替換規則（長的原字先換，避免「主回復本」被短規則拆壞）；前端「套用替換規則」也用這個 */
  function applyReplacements(text, reps) {
    var s = String(text == null ? '' : text);
    var list = (reps || []).slice().sort(function (a, b) {
      return b.from.length - a.from.length;
    });
    for (var i = 0; i < list.length; i++) if (list[i].from) s = s.split(list[i].from).join(list[i].to);
    return s;
  }
  function getRules_(env, ctx, data) {
    data = data || {};
    var out = { global: globalRules_(env), defaults: cleanRules_(RPT_DEFAULT_RULES_), canEditGlobal: ctx.role === 'super' };
    if (data.actionId) {
      var a = loadAction_(env, ctx, data.actionId);
      out.action = actionRules_(env, a.id);
      out.canEditAction = canManage_(ctx, a);
      out.merged = mergedRules_(env, a.id);
    }
    return out;
  }
  function setRules_(env, ctx, data) {
    data = data || {};
    var rules = cleanRules_(data.rules);
    if (data.scope === 'global') {
      requireSuper_(ctx);
      env.withLock(function () {
        env.store.putDoc(null, 'rules', rules);
      });
    } else if (data.scope === 'action') {
      var a = loadAction_(env, ctx, data.actionId);
      if (!canManage_(ctx, a)) fail_('FORBIDDEN', '只有這個行動的負責人可以修改本行動的逐字稿規則');
      env.withLock(function () {
        env.store.putDoc(a.id, 'rules', rules);
      });
    } else fail_('BAD_INPUT', '規則範圍只能是全站或本行動');
    return getRules_(env, ctx, { actionId: data.scope === 'action' ? data.actionId : null });
  }

  // ---------- 行動錄音與逐字稿 ----------
  // 流程：瀏覽器把錄音切成約 5 分鐘、16kHz 單聲道 WAV → transcribe.segment 一段一段送 OpenAI 轉錄 →
  //       全部完成後組成逐字稿 → 套用替換規則／AI 修正（transcript.correct，分段）→ 彙整重點（transcript.summarize）→ 加入素材。
  //       原始錄音可另外用 audio.createUpload 直傳到行動的 Drive 資料夾保存（選用）。
  function canWork_(ctx, action) {
    return canManage_(ctx, action) || isCollaborator_(ctx, action);
  }
  function requireWork_(ctx, action) {
    if (!canWork_(ctx, action)) fail_('FORBIDDEN', '只有負責人或共同協作者可以使用錄音逐字稿');
  }
  function recKey_(id) {
    return 'rec:' + id;
  }
  function loadRecording_(env, action, id) {
    var rec = env.store.getDoc(action.id, recKey_(id_(id, '錄音 id')));
    if (!rec) fail_('NOT_FOUND', '找不到這個錄音');
    if (Object.prototype.toString.call(rec.segments) !== '[object Array]') rec.segments = [];
    return rec;
  }
  function doneCount_(rec) {
    var n = 0;
    for (var i = 0; i < rec.segments.length; i++) if (rec.segments[i] && isString_(rec.segments[i].text)) n++;
    return n;
  }
  function joinSegments_(rec) {
    var parts = [];
    for (var i = 0; i < rec.segments.length; i++) if (rec.segments[i] && rec.segments[i].text) parts.push(rec.segments[i].text);
    return parts.join('\n');
  }
  function recordingSummary_(ctx, action, rec) {
    var segs = [];
    for (var i = 0; i < (rec.segmentCount || rec.segments.length); i++) {
      var s = rec.segments[i];
      segs.push(s && isString_(s.text) ? 1 : 0);
    }
    return {
      id: rec.id,
      name: rec.name,
      size: rec.size || 0,
      durationSec: rec.durationSec || 0,
      segmentSec: rec.segmentSec || 0,
      segmentCount: rec.segmentCount || 0,
      segmentsDone: segs,
      doneCount: doneCount_(rec),
      status: rec.status,
      fileId: rec.fileId || '',
      transcriptChars: (rec.transcript || '').length,
      hasCorrected: !!rec.corrected,
      hasSummary: !!rec.summary,
      createdBy: rec.createdBy,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      canEdit: canWork_(ctx, action),
      canDelete: canManage_(ctx, action) || rec.createdBy === ctx.email
    };
  }
  function recordingSummaries_(env, ctx, action) {
    if (!canWork_(ctx, action) || !env.store.listDocs) return [];
    var docs = env.store.listDocs(action.id, 'rec:');
    var out = [];
    for (var i = 0; i < docs.length; i++) {
      var rec = docs[i];
      if (!rec || !rec.id) continue;
      if (Object.prototype.toString.call(rec.segments) !== '[object Array]') rec.segments = [];
      out.push(recordingSummary_(ctx, action, rec));
    }
    out.sort(function (a, b) {
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    return out;
  }
  function publicRecording_(ctx, action, rec) {
    var out = recordingSummary_(ctx, action, rec);
    var segs = [];
    for (var i = 0; i < rec.segments.length; i++) if (rec.segments[i]) segs.push({ i: i, start: rec.segments[i].start, end: rec.segments[i].end, text: rec.segments[i].text });
    out.segments = segs;
    out.transcript = rec.transcript || '';
    out.corrected = rec.corrected || '';
    out.summary = rec.summary || '';
    return out;
  }
  function listRecordings_(env, ctx, data) {
    var a = loadAction_(env, ctx, data && data.actionId);
    requireWork_(ctx, a);
    return { recordings: recordingSummaries_(env, ctx, a) };
  }
  function getRecording_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    requireWork_(ctx, a);
    return { recording: publicRecording_(ctx, a, loadRecording_(env, a, data.id)) };
  }
  function numIn_(v, label, min, max) {
    var n = Number(v);
    if (!isFinite(n) || n < min || n > max) fail_('BAD_INPUT', label + ' 不正確');
    return n;
  }
  /**
   * 建立錄音紀錄。兩種用法：
   *   1. 要轉錄：送 name、size、durationSec、segmentSec、segmentCount（預估），之後逐段呼叫 transcribe.segment
   *   2. 已經有逐字稿（例如在自己電腦轉好）：送 name＋transcript，直接完成
   */
  function createRecording_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    requireWork_(ctx, a);
    var L = limits_(env);
    var now = new Date(env.now()).toISOString();
    var transcript = data.transcript != null ? str_(data.transcript, '逐字稿', L.transcriptMaxChars, false) : '';
    var rec = {
      id: newId_(env, 'r'),
      name: str_(data.name, '錄音名稱', 200, true),
      size: data.size != null ? Math.floor(numIn_(data.size, '檔案大小', 0, 1e11)) : 0,
      durationSec: data.durationSec != null ? Math.round(numIn_(data.durationSec, '錄音長度', 0, 24 * 3600)) : 0,
      segmentSec: data.segmentSec != null ? Math.round(numIn_(data.segmentSec, '分段長度', 30, 1500)) : 0,
      segmentCount: data.segmentCount != null ? Math.floor(numIn_(data.segmentCount, '分段數', 0, L.segmentsPerRecording)) : 0,
      segments: [],
      status: transcript ? 'done' : 'transcribing',
      transcript: transcript,
      corrected: '',
      summary: '',
      createdBy: ctx.email,
      createdAt: now,
      updatedAt: now
    };
    if (!transcript && !rec.segmentCount) fail_('BAD_INPUT', '請提供錄音分段數，或直接貼上逐字稿');
    env.withLock(function () {
      var existing = env.store.listDocs(a.id, 'rec:');
      if (existing.length >= L.recordingsPerAction) fail_('BAD_INPUT', '每個行動最多 ' + L.recordingsPerAction + ' 個錄音');
      env.store.putDoc(a.id, recKey_(rec.id), rec);
    });
    return { recording: publicRecording_(ctx, a, rec) };
  }
  function transcribePrompt_(rules, prevText, model) {
    var max = /whisper/i.test(model) ? 350 : 1200;
    var p = '以下是台灣召會（台中市召會）聚會與行動的錄音，請用台灣繁體中文與全形標點轉寫。';
    if (rules.vocabulary.length) p += '常用詞彙：' + rules.vocabulary.join('、') + '。';
    if (p.length > max) p = p.slice(0, max);
    // 接續上一段的結尾，讓斷句與用詞前後一致
    if (prevText) {
      var room = max - p.length - 4;
      if (room > 20) p += '\n前文：' + String(prevText).slice(-Math.min(200, room));
    }
    return p;
  }
  /** 只接受本平台瀏覽器端切好的 WAV（RIFF....WAVE）；回傳位元組數 */
  function checkWav_(b64, maxBytes) {
    if (!isString_(b64) || !b64 || !/^[A-Za-z0-9+\/]+={0,2}$/.test(b64)) fail_('BAD_INPUT', '錄音分段資料格式不正確');
    var h = base64Head_(b64, 12);
    var riff = h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x41 && h[10] === 0x56 && h[11] === 0x45;
    if (!riff) fail_('BAD_INPUT', '錄音分段必須是 WAV 格式');
    var size = base64Size_(b64);
    if (size > maxBytes) fail_('TOO_LARGE', '錄音分段太大（上限 ' + Math.floor(maxBytes / 1048576) + 'MB）');
    return size;
  }
  function transcribeSegment_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    requireWork_(ctx, a);
    requireAi_(env);
    var L = limits_(env);
    var rec = loadRecording_(env, a, data.id);
    var index = Math.floor(numIn_(data.index, '分段序號', 0, L.segmentsPerRecording - 1));
    var start = numIn_(data.start, '分段開始時間', 0, 24 * 3600);
    var end = numIn_(data.end, '分段結束時間', start, 24 * 3600);
    checkWav_(data.data, L.segmentMaxBytes);
    var rules = mergedRules_(env, a.id);
    var cfg = aiConfig_(env);
    var prev = index > 0 && rec.segments[index - 1] ? rec.segments[index - 1].text : '';
    var result = env.ai.transcribe({
      apiKey: aiKey_(env),
      model: cfg.transcribeModel,
      base64: data.data.replace(/^data:[^,]*,/, ''),
      mime: 'audio/wav',
      filename: 'segment-' + index + '.wav',
      prompt: transcribePrompt_(rules, prev, cfg.transcribeModel),
      language: /whisper|4o/i.test(cfg.transcribeModel) ? 'zh' : '',
      segmentIndex: index
    });
    var text = trim_(result && isString_(result.text) ? result.text : '');
    var out;
    env.withLock(function () {
      rec = loadRecording_(env, a, data.id); // 在鎖內重讀：多段同時送回時不互相覆蓋
      rec.segments[index] = { start: start, end: end, text: text, at: new Date(env.now()).toISOString() };
      // 分段數一開始是預估值；收到標記 last 的那一段才確定總數（各段可能不照順序送回）
      if (data.last === true) {
        rec.segmentCount = index + 1;
        rec.countFinal = true;
        if (rec.segments.length > rec.segmentCount) rec.segments.length = rec.segmentCount;
      } else if (index + 1 > (rec.segmentCount || 0)) rec.segmentCount = index + 1;
      var done = rec.countFinal === true;
      for (var i = 0; done && i < rec.segmentCount; i++) if (!rec.segments[i] || !isString_(rec.segments[i].text)) done = false;
      rec.status = done ? 'done' : 'transcribing';
      if (done) rec.transcript = joinSegments_(rec).slice(0, L.transcriptMaxChars);
      rec.updatedAt = new Date(env.now()).toISOString();
      env.store.putDoc(a.id, recKey_(rec.id), rec);
      out = { segment: { i: index, start: start, end: end, text: text }, status: rec.status, segmentCount: rec.segmentCount, doneCount: doneCount_(rec) };
      if (rec.status === 'done') out.transcript = rec.transcript;
    });
    return out;
  }
  function updateRecording_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    requireWork_(ctx, a);
    var L = limits_(env);
    var rec;
    env.withLock(function () {
      rec = loadRecording_(env, a, data.id);
      if (data.name != null) rec.name = str_(data.name, '錄音名稱', 200, true);
      if (data.transcript != null) {
        rec.transcript = str_(data.transcript, '逐字稿', L.transcriptMaxChars, false);
        if (rec.transcript) rec.status = 'done';
      }
      if (data.corrected != null) rec.corrected = str_(data.corrected, '修正稿', L.transcriptMaxChars, false);
      if (data.summary != null) rec.summary = str_(data.summary, '重點彙整', 20000, false);
      rec.updatedAt = new Date(env.now()).toISOString();
      env.store.putDoc(a.id, recKey_(rec.id), rec);
    });
    return { recording: publicRecording_(ctx, a, rec) };
  }
  function attachRecordingFile_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    requireWork_(ctx, a);
    var f = env.store.getFile(a.id, id_(data.fileId, '檔案 id'), false);
    if (!f || !f.meta || f.meta.kind !== 'audio') fail_('NOT_FOUND', '找不到上傳的錄音檔');
    var rec;
    env.withLock(function () {
      rec = loadRecording_(env, a, data.id);
      rec.fileId = f.id;
      rec.updatedAt = new Date(env.now()).toISOString();
      env.store.putDoc(a.id, recKey_(rec.id), rec);
    });
    return { recording: recordingSummary_(ctx, a, rec) };
  }
  function deleteRecording_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    var rec = loadRecording_(env, a, data.id);
    if (!canManage_(ctx, a) && rec.createdBy !== ctx.email) fail_('FORBIDDEN', '只有負責人或上傳的人可以刪除這個錄音');
    env.withLock(function () {
      env.store.deleteDoc(a.id, recKey_(rec.id));
    });
    if (rec.fileId) env.store.deleteFile(a.id, rec.fileId);
    return { deleted: true };
  }
  function rulesText_(rules) {
    var lines = [];
    if (rules.vocabulary.length) lines.push('常用詞彙（以這些寫法為準）：' + rules.vocabulary.join('、'));
    if (rules.replacements.length) {
      var reps = [];
      for (var i = 0; i < rules.replacements.length && i < 200; i++) reps.push(rules.replacements[i].from + '→' + rules.replacements[i].to);
      lines.push('常見錯字（左邊一律改成右邊）：' + reps.join('；'));
    }
    return lines.join('\n');
  }
  /** AI 修正一段逐字稿（前端把長逐字稿切成數千字一段依序送來，避免 Apps Script 6 分鐘上限） */
  function correctTranscript_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    requireWork_(ctx, a);
    requireAi_(env);
    loadRecording_(env, a, data.id);
    var text = str_(data.text, '逐字稿段落', limits_(env).correctChunkMaxChars, true);
    var rules = mergedRules_(env, a.id);
    var system =
      '你是台中市召會行動報導的逐字稿校對員。請校對使用者給的逐字稿片段，直接輸出校對後的全文，不要加任何說明、標題或引號。\n' +
      (rules.correctionNotes || '') +
      '\n' +
      rulesText_(rules);
    var out = env.ai.chat({ apiKey: aiKey_(env), model: aiConfig_(env).chatModel, system: system, user: text, task: 'correct' });
    var fixed = applyReplacements(trim_(isString_(out) ? out : ''), rules.replacements);
    if (!fixed) fail_('AI_ERROR', 'AI 沒有回傳內容，請稍後再試');
    return { text: fixed };
  }
  /** 彙整重點：用修正稿（沒有就用原始逐字稿），結果存回錄音紀錄 */
  function summarizeTranscript_(env, ctx, data) {
    data = data || {};
    var a = loadAction_(env, ctx, data.actionId);
    requireWork_(ctx, a);
    requireAi_(env);
    var L = limits_(env);
    var rec = loadRecording_(env, a, data.id);
    var source = rec.corrected || rec.transcript || '';
    if (!trim_(source)) fail_('BAD_INPUT', '這個錄音還沒有逐字稿');
    var rules = mergedRules_(env, a.id);
    var system =
      '你是台中市召會行動報導的記錄同工。請根據逐字稿彙整重點，用台灣繁體中文條列，每點一行，以「- 」開頭（可用「## 」小標分類）。' +
      '只寫逐字稿裡有的內容，不要編造；人名、數字照原文。\n' +
      (rules.summaryNotes || '') +
      '\n' +
      rulesText_(rules);
    var user =
      '行動：' + a.name + '（' + a.date + (a.endDate ? '～' + a.endDate : '') + (a.place ? '，' + a.place : '') + '）\n錄音：' + rec.name + '\n\n逐字稿：\n' + source.slice(0, L.summaryInputMaxChars);
    var out = env.ai.chat({ apiKey: aiKey_(env), model: aiConfig_(env).chatModel, system: system, user: user, task: 'summarize' });
    var summary = applyReplacements(trim_(isString_(out) ? out : ''), rules.replacements).slice(0, 20000);
    if (!summary) fail_('AI_ERROR', 'AI 沒有回傳內容，請稍後再試');
    env.withLock(function () {
      rec = loadRecording_(env, a, data.id);
      rec.summary = summary;
      rec.updatedAt = new Date(env.now()).toISOString();
      env.store.putDoc(a.id, recKey_(rec.id), rec);
    });
    return { summary: summary, recording: recordingSummary_(ctx, a, rec) };
  }

  // ---------- 管理者 ----------
  /** 總管理者名單（舊版的 'event' 行動負責人已不需要：任何人登入後都能建立自己的行動） */
  function listAdmins_(env, ctx) {
    requireSuper_(ctx);
    var supers = superEmails_(env);
    var out = [];
    for (var i = 0; i < supers.length; i++) out.push({ email: supers[i], role: 'super', locked: isLockedSuper_(env, supers[i]) });
    return { admins: out, videoMaxMb: videoMaxMb_(env) };
  }
  function addAdmin_(env, ctx, data) {
    requireSuper_(ctx);
    var email = requireEmail_(data && data.email);
    if (data.role != null && data.role !== 'super') fail_('BAD_INPUT', '不需要指派行動負責人：任何人登入後都能建立自己的行動');
    if (isLockedSuper_(env, email)) fail_('BAD_INPUT', '這個帳號是固定的總管理者');
    upsertAdmin_(env, email, 'super', ctx.email);
    return listAdmins_(env, ctx);
  }
  function removeAdmin_(env, ctx, data) {
    requireSuper_(ctx);
    var email = requireEmail_(data && data.email);
    if (isLockedSuper_(env, email)) fail_('BAD_INPUT', '固定的總管理者不能移除');
    if (email === ctx.email) fail_('BAD_INPUT', '不能移除自己；請其他總管理者移除');
    env.withLock(function () {
      var list = adminList_(env);
      var keep = [];
      for (var i = 0; i < list.length; i++) if (list[i].email !== email) keep.push(list[i]);
      setPropJson_(env, RPT_P_.admins, keep);
    });
    return listAdmins_(env, ctx);
  }
  function setConfig_(env, ctx, data) {
    requireSuper_(ctx);
    var mb = Number(data && data.videoMaxMb);
    if (!(mb >= 1 && mb <= 2000) || Math.floor(mb) !== mb) fail_('BAD_INPUT', '影片上限需為 1–2000 MB 的整數');
    env.props.set(RPT_P_.videoMaxMb, String(mb));
    return listAdmins_(env, ctx);
  }

  // ---------- 路由 ----------
  var ROUTES_ = {
    'actions.list': listActions_,
    'actions.create': createAction_,
    'actions.update': updateAction_,
    'actions.addCollaborator': addCollaborator_,
    'actions.removeCollaborator': removeCollaborator_,
    'materials.list': listMaterials_,
    'materials.save': saveMaterial_,
    'materials.delete': deleteMaterial_,
    'photos.upload': uploadPhoto_,
    'photos.get': getPhoto_,
    'video.createUpload': createVideoUpload_,
    'video.complete': completeVideoUpload_,
    'outputs.save': saveOutput_,
    'outputs.list': listOutputs_,
    'admin.list': listAdmins_,
    'admin.add': addAdmin_,
    'admin.remove': removeAdmin_,
    'config.set': setConfig_,
    // version 3
    boot: boot_,
    'actions.delete': deleteAction_,
    'action.open': openAction_,
    'photos.getMany': getPhotos_,
    'contacts.list': listContacts_,
    'contacts.save': saveContact_,
    'contacts.remove': removeContact_,
    'ai.config.get': getAiConfig_,
    'ai.config.set': setAiConfig_,
    'rules.get': getRules_,
    'rules.set': setRules_,
    'recordings.list': listRecordings_,
    'recordings.get': getRecording_,
    'recordings.create': createRecording_,
    'recordings.update': updateRecording_,
    'recordings.attachFile': attachRecordingFile_,
    'recordings.delete': deleteRecording_,
    'audio.createUpload': createAudioUpload_,
    'audio.complete': completeAudioUpload_,
    'transcribe.segment': transcribeSegment_,
    'transcript.correct': correctTranscript_,
    'transcript.summarize': summarizeTranscript_
  };

  /**
   * 處理一個請求。body = { action, token?, data? }，回傳可直接 JSON 化的物件：
   *   成功 { ok: true, ...結果 }；失敗 { ok: false, code, error }
   * 未預期的錯誤只回傳清理過的訊息（不含 email／網址／電話）。
   */
  function handle(env, body) {
    try {
      if (!body || typeof body !== 'object') fail_('BAD_INPUT', '請求格式不正確');
      var action = body.action;
      var data = body.data && typeof body.data === 'object' ? body.data : {};
      var res;
      // version 2：任何人可建立行動＋共同協作者（打開 /exec 網址即可確認後端已更新）
      if (action === 'ping') res = { service: 'taichung-reports', version: RPT_VERSION_ };
      else if (action === 'auth.requestCode') res = requestCode_(env, data);
      else if (action === 'auth.verifyCode') res = verifyCode_(env, data);
      else if (action === 'auth.logout') res = logout_(env, body.token);
      else if (action === 'me') res = meInfo_(env, ctxOf_(env, body.token));
      else if (isString_(action) && hasOwn_(ROUTES_, action)) res = ROUTES_[action](env, ctxOf_(env, body.token), data);
      else fail_('BAD_INPUT', '未知的操作');
      res.ok = true;
      return res;
    } catch (err) {
      if (err instanceof RptError) return { ok: false, code: err.code, error: err.message };
      var msg = sanitizeError(err && err.message ? err.message : err);
      if (env && typeof env.log === 'function') env.log('error: ' + msg);
      return { ok: false, code: 'SERVER_ERROR', error: '伺服器發生錯誤，請稍後再試（' + msg + '）' };
    }
  }

  return {
    VERSION: RPT_VERSION_,
    ADMIN_SEED_EMAILS: RPT_ADMIN_SEED_EMAILS_,
    MAIL_SUBJECT: RPT_MAIL_SUBJECT_,
    PRESETS: RPT_PRESETS_,
    SETTING_RANGES: RPT_SETTING_RANGES_,
    LAYOUTS: RPT_LAYOUTS_,
    VIDEO_HOSTS: RPT_VIDEO_HOSTS_,
    CELL_MAX: RPT_CELL_MAX_,
    DEFAULT_LIMITS: RPT_DEFAULT_LIMITS_,
    RptError: RptError,
    handle: handle,
    // 只給伺服器端程式（mock 的測試端點）使用，沒有對外的 action 可以呼叫
    createSession: createSession_,
    normalizeEmail: normalizeEmail,
    isValidEmail: isValidEmail,
    normalizeSettings: normalizeSettings,
    isAllowedVideoUrl: isAllowedVideoUrl,
    safeCell: safeCell,
    unsafeCell: unsafeCell,
    sanitizeError: sanitizeError,
    /** setupOnce 用：確保 pepper 已產生；回傳 true 表示這次新建（不回傳 pepper 本身） */
    ensurePepper: function (env) {
      var created = false;
      env.withLock(function () {
        if (!env.props.get(RPT_P_.pepper)) {
          pepper_(env);
          created = true;
        }
      });
      return created;
    },
    adminSeedCount: RPT_ADMIN_SEED_EMAILS_.length,
    chunkString: chunkString,
    joinChunks: joinChunks,
    detectImageType: detectImageType,
    base64Size: base64Size_,
    sha256Hex: sha256HexPure_,
    taipeiDay: taipeiDay_,
    DEFAULT_RULES: RPT_DEFAULT_RULES_,
    AI_DEFAULTS: RPT_AI_DEFAULTS_,
    applyReplacements: applyReplacements,
    cleanRules: cleanRules_
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RptCore;
