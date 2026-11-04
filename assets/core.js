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
  var RPT_VERSION_ = 2;
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
    actionsPerUserPerDay: 20
  };
  var RPT_P_ = {
    pepper: 'RPT_PEPPER',
    admins: 'RPT_ADMINS',
    mailQuota: 'RPT_MAIL_QUOTA',
    sessionPrefix: 'RPT_SESS_',
    sessionIndexPrefix: 'RPT_SIDX_',
    videoMaxMb: 'RPT_VIDEO_MAX_MB'
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
    return { token: token, email: email };
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
  function actionFields_(data, isCreate, canChangeOwners) {
    var out = {};
    out.name = str_(data.name, '行動名稱', 100, true);
    out.date = str_(data.date, '日期', 10, true);
    if (!isValidDate_(out.date)) fail_('BAD_INPUT', '日期格式需為 YYYY-MM-DD');
    out.place = str_(data.place, '地點', 100, false);
    out.description = str_(data.description, '說明', 2000, false);
    // 一般使用者送來的 owners 一律忽略（建立者就是負責人）；只有總管理者可以指定或更換負責人
    if (canChangeOwners && (data.owners != null || data.ownerEmail != null)) {
      out.owners = emailList_(data.owners != null ? data.owners : data.ownerEmail, '負責人 email', 5);
      if (!out.owners.length) fail_('BAD_INPUT', '請填寫負責人 email');
    }
    // 修改時沒送 collaborators 就維持原名單（協作者改用 actions.addCollaborator／removeCollaborator 增減）
    if (isCreate || data.collaborators != null) out.collaborators = emailList_(data.collaborators, '協作者 email', RPT_MAX_COLLABORATORS_);
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
  function createAction_(env, ctx, data) {
    var f = actionFields_(data || {}, true, ctx.role === 'super');
    var owners = f.owners || [ctx.email];
    var now = new Date(env.now()).toISOString();
    var a = {
      id: newId_(env, 'a'),
      name: f.name,
      date: f.date,
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
    env.withLock(function () {
      checkCreateQuota_(env, ctx);
      env.store.createAction(a);
    });
    return { action: publicAction_(ctx, a) };
  }
  function updateAction_(env, ctx, data) {
    var a = loadAction_(env, ctx, data && data.id);
    if (!canManage_(ctx, a)) fail_('FORBIDDEN', '只有這個行動的負責人可以修改行動設定');
    var f = actionFields_(data, false, ctx.role === 'super');
    a.name = f.name;
    a.date = f.date;
    a.place = f.place;
    a.description = f.description;
    if (f.owners) a.owners = f.owners;
    a.collaborators = collaboratorsFor_(f.collaborators || a.collaborators || [], a.owners);
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
    if (arrayIncludes_(a.owners || [], email)) fail_('BAD_INPUT', '這個 email 已經是負責人');
    env.withLock(function () {
      a = env.store.getAction(a.id) || a; // 在鎖內重讀，避免同時增減時蓋掉別人的變更
      var list = (a.collaborators || []).slice();
      if (!arrayIncludes_(list, email)) {
        if (list.length >= RPT_MAX_COLLABORATORS_) fail_('BAD_INPUT', '協作者最多 ' + RPT_MAX_COLLABORATORS_ + ' 位');
        list.push(email);
      }
      a.collaborators = list;
      a.updatedAt = new Date(env.now()).toISOString();
      env.store.updateAction(a);
    });
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
  function createVideoUpload_(env, ctx, data) {
    data = data || {};
    var action = loadAction_(env, ctx, data.actionId);
    var name = str_(data.name, '檔名', 200, true).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_');
    var mime = str_(data.mime, '檔案類型', 100, true);
    if (!/^video\/[A-Za-z0-9.+-]+$/.test(mime)) fail_('BAD_INPUT', '只接受影片檔');
    var size = Number(data.size);
    var maxMb = videoMaxMb_(env);
    if (!(size > 0) || Math.floor(size) !== size) fail_('BAD_INPUT', '檔案大小不正確');
    if (size > maxMb * 1024 * 1024) fail_('TOO_LARGE', '影片超過 ' + maxMb + 'MB 上限，請改貼 YouTube／Google Drive 連結');
    var origin = str_(data.origin, 'origin', 200, true);
    if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin)) fail_('BAD_INPUT', 'origin 格式不正確');
    var up = env.store.createResumableUpload(action.id, {
      name: name,
      mime: mime,
      size: size,
      origin: origin,
      meta: { kind: 'video-pending', uploadedBy: ctx.email }
    });
    return { uploadUrl: up.uploadUrl, maxBytes: maxMb * 1024 * 1024 };
  }
  function completeVideoUpload_(env, ctx, data) {
    var action = loadAction_(env, ctx, data && data.actionId);
    var f = env.store.getFile(action.id, id_(data.fileId, '檔案 id'), false);
    if (!f || !f.meta || (f.meta.kind !== 'video-pending' && f.meta.kind !== 'video')) fail_('NOT_FOUND', '找不到上傳的影片（可能尚未上傳完成）');
    if (f.meta.uploadedBy !== ctx.email && !canManage_(ctx, action)) fail_('FORBIDDEN', '不能引用別人上傳的檔案');
    var maxBytes = videoMaxMb_(env) * 1024 * 1024;
    if (!/^video\//.test(f.mime || '') || f.size > maxBytes) {
      env.store.deleteFile(action.id, f.id);
      fail_('TOO_LARGE', '影片格式不正確或超過大小上限，已刪除');
    }
    env.store.setFileMeta(action.id, f.id, { kind: 'video', uploadedBy: f.meta.uploadedBy, uploadedAt: new Date(env.now()).toISOString() });
    return { video: { fileId: f.id, size: f.size, mime: f.mime } };
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
    'config.set': setConfig_
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
      else if (action === 'me') {
        var c = ctxOf_(env, body.token);
        res = { email: c.email, role: c.role, presets: RPT_PRESETS_, ranges: RPT_SETTING_RANGES_, layouts: RPT_LAYOUTS_, videoMaxMb: videoMaxMb_(env) };
      } else if (isString_(action) && hasOwn_(ROUTES_, action)) res = ROUTES_[action](env, ctxOf_(env, body.token), data);
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
    taipeiDay: taipeiDay_
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RptCore;
