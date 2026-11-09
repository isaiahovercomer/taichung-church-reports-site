// API 介面：同一組 call(action, data) 可切換三種後端
//   remote：site.config.json 的 apiUrl（Apps Script /exec）
//   mock  ：?mock=1 → site.config.json 的 mockApiUrl（scripts/mock-server.mjs）
//   demo  ：?demo=1，或 apiUrl 為空（尚未部署後端）時自動 → 在瀏覽器裡直接執行 apps-script/core.js＋記憶體儲存（重新整理就清空）
// POST 一律用 Content-Type: text/plain（Apps Script 不支援 CORS 預檢），token 放在 body 裡。
// localStorage 只存 session token（rpt.session.<mode>）；草稿文字由 main.mjs 另外存。

import { createMemoryEnv } from '../backend/memory-env.mjs?v=fdfd8c3183';

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const REMOTE_URL_RE = /^https:\/\/[^\s"'<>\\]+$/;

/** 是否設定了正式後端（apiUrl 為 https 網址） */
export function hasRemoteApi(config) {
  return typeof config?.apiUrl === 'string' && REMOTE_URL_RE.test(config.apiUrl.trim());
}

/** ?demo=1 → demo；?mock=1 → mock；apiUrl 為空（尚未部署後端）時自動進入 demo，讓公開網站可以先試用 */
export function detectMode(search, config = {}) {
  const q = new URLSearchParams(search);
  if (q.get('demo') === '1') return 'demo';
  if (q.get('mock') === '1') return 'mock';
  return hasRemoteApi(config) ? 'remote' : 'demo';
}

const CHUNK = 8 * 256 * 1024; // Drive resumable upload 每段需為 256 KiB 的倍數

export function createApi({ mode, config, onDemoMail }) {
  const tokenKey = `rpt.session.${mode}`;
  let token = null;
  try {
    token = localStorage.getItem(tokenKey);
  } catch {
    token = null;
  }

  let demo = null;
  if (mode === 'demo') {
    demo = createMemoryEnv({
      // 示範帳號是一般使用者（不是總管理者）：展示「任何人登入後都能建立自己的行動」
      deployer: '',
      sendMail: (to, subject, body) => onDemoMail && onDemoMail(to, (/(\d{6})/.exec(body) || [])[1]),
    });
  }

  const url = mode === 'mock' ? config.mockApiUrl : config.apiUrl;
  const configured = mode === 'demo' || (typeof url === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(url));

  async function call(action, data = {}) {
    const body = { action, token, data };
    let res;
    if (demo) {
      res = JSON.parse(JSON.stringify(globalThis.RptCore.handle(demo.env, JSON.parse(JSON.stringify(body)))));
    } else {
      if (!configured) throw new ApiError('NOT_CONFIGURED', '尚未設定後端網址（site.config.json 的 apiUrl）。可以先用 ?demo=1 試用示範模式。');
      let r;
      try {
        r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
      } catch {
        throw new ApiError('NETWORK', '無法連線到後端，請檢查網路後再試');
      }
      try {
        res = await r.json();
      } catch {
        throw new ApiError('NETWORK', `後端回應格式不正確（HTTP ${r.status}）`);
      }
    }
    if (!res || res.ok !== true) {
      if (res && res.code === 'AUTH_REQUIRED') setToken(null);
      throw new ApiError(res?.code || 'ERROR', res?.error || '發生錯誤');
    }
    return res;
  }

  function setToken(t) {
    token = t;
    try {
      if (t) localStorage.setItem(tokenKey, t);
      else localStorage.removeItem(tokenKey);
    } catch {
      /* 無痕模式等情況：只保留在記憶體 */
    }
  }

  /** 把檔案分段 PUT 到後端給的 resumable 上傳網址，完成後回傳 Drive 檔案 id。 */
  async function uploadResumable(uploadUrl, file, onProgress) {
    const total = file.size;
    let start = 0;
    while (start < total) {
      const end = Math.min(start + CHUNK, total);
      if (demo && uploadUrl.startsWith('demo-upload:')) {
        const r = demo.receiveUploadChunk(uploadUrl.slice(12), start, end, total, end - start);
        onProgress && onProgress(end / total);
        if (r.done) return r.file.id;
        start = end;
        continue;
      }
      if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(uploadUrl)) throw new ApiError('BAD_UPLOAD_URL', '上傳網址不正確');
      let r;
      try {
        r = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end - 1}/${total}` }, body: file.slice(start, end) });
      } catch {
        throw new ApiError('NETWORK', '影片上傳中斷，請重試；或改貼 YouTube／Google Drive 連結');
      }
      onProgress && onProgress(end / total);
      if (r.status === 200 || r.status === 201) {
        const j = await r.json();
        if (!j.id) throw new ApiError('UPLOAD', '上傳完成但沒有取得檔案 id');
        return j.id;
      }
      if (r.status !== 308) throw new ApiError('UPLOAD', `影片上傳失敗（HTTP ${r.status}）`);
      const range = r.headers.get('Range');
      start = range ? Number(/bytes=0-(\d+)/.exec(range)?.[1] ?? end - 1) + 1 : end;
    }
    throw new ApiError('UPLOAD', '影片上傳未完成');
  }

  return {
    mode,
    configured,
    call,
    uploadResumable,
    get token() {
      return token;
    },
    setToken,
  };
}
