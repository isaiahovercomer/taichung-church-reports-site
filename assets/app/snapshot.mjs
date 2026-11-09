// 上次畫面（加速）：把「我的行動」與最近開過的行動頁資料存在這台裝置，
// 重新整理或下次開啟時先顯示，再背景向後端更新（Apps Script 每次往返 1.5 秒以上，省不掉）。
//  - 只在同一個登入（token）下有效；換人登入、登入過期、登出時清除
//  - 只存文字資料（行動、素材列、錄音摘要）；照片另外在 photos.mjs 的 IndexedDB
//  - 示範模式不存

const KEY = 'rpt.snap.v1';
const MAX_ACTIONS = 8;
const MAX_CHARS = 1_500_000; // localStorage 每個網站約 5MB（UTF-16），留空間給草稿

/** token 的指紋（不把 token 本身再存一次） */
function tokenTag(token) {
  if (!token) return '';
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + token.length;
}

export function createSnapshot({ enabled = true, storage = globalThis.localStorage } = {}) {
  let timer = null;
  let pending = null;

  function read(token) {
    if (!enabled || !token) return null;
    try {
      const o = JSON.parse(storage.getItem(KEY) || 'null');
      if (!o || o.tag !== tokenTag(token)) return null;
      return o;
    } catch {
      return null;
    }
  }

  function write(token, snap) {
    if (!enabled || !token) return;
    pending = { token, snap };
    if (timer) return;
    // 合併短時間內的多次寫入；在畫面更新之後才寫
    timer = setTimeout(flush, 300);
  }

  function flush() {
    timer = null;
    if (!pending) return;
    const { token, snap } = pending;
    pending = null;
    const out = { tag: tokenTag(token), at: Date.now(), me: snap.me || null, home: snap.home || null, actions: {} };
    // 最近開過的行動優先，整體太大就少存幾個
    const ids = Object.keys(snap.actions || {})
      .sort((a, b) => (snap.actions[b].at || 0) - (snap.actions[a].at || 0))
      .slice(0, MAX_ACTIONS);
    for (const id of ids) out.actions[id] = snap.actions[id];
    let text = JSON.stringify(out);
    while (text.length > MAX_CHARS && Object.keys(out.actions).length) {
      const last = Object.keys(out.actions).sort((a, b) => out.actions[a].at - out.actions[b].at)[0];
      delete out.actions[last];
      text = JSON.stringify(out);
    }
    try {
      storage.setItem(KEY, text);
    } catch {
      // 空間不足：不存行動頁，只留首頁
      try {
        storage.setItem(KEY, JSON.stringify({ ...out, actions: {} }));
      } catch {
        /* 放棄 */
      }
    }
  }

  function clear() {
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      storage.removeItem(KEY);
    } catch {
      /* 忽略 */
    }
  }

  return { read, write, clear, flush, tokenTag };
}
