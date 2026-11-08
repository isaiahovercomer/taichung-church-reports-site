// 照片載入（加速）：
//  1. 合併請求：同一時間要顯示的照片累積 30ms 後用 photos.getMany 一次取（每批最多 8 張），
//     取代原本「每張照片各打一次 Apps Script（每次 1 秒以上）」
//  2. 列表用縮圖（thumb）；生成報導、A4 才用原圖
//  3. 存在這台裝置的 IndexedDB：照片內容不會變（id 固定），重新整理或下次開啟不必再下載；登出時清除
//  後端還是舊版（沒有 photos.getMany）時，自動退回一張一張取。

const DB_NAME = 'rpt-photos';
const STORE = 'p';
const BATCH = 8;
const MAX_PARALLEL = 3;

function openDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // 無痕模式等情況：只用記憶體
    }
  });
}

function idbGet(db, key) {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
function idbPut(db, key, value) {
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
  } catch {
    /* 空間不足等：忽略 */
  }
}

/**
 * api：createApi() 的結果；isUnsupported(err)：判斷是不是舊版後端不認得的 action
 * persist：false 時不寫 IndexedDB（示範模式）
 */
export function createPhotoLoader({ api, isUnsupported, persist = true }) {
  const mem = new Map(); // key → Promise<dataUrl>
  const queue = new Map(); // `${actionId}|${thumb}` → [{ id, resolve, reject }]
  let timer = null;
  let running = 0;
  const waiting = [];
  let manyUnsupported = false;
  const dbp = persist ? openDb() : Promise.resolve(null);

  const keyOf = (id, thumb) => `${thumb ? 't' : 'f'}:${id}`;

  async function limited(fn) {
    if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      const next = waiting.shift();
      if (next) next();
    }
  }

  async function fetchOne(actionId, id) {
    const res = await api.call('photos.get', { actionId, id });
    return `data:${res.photo.mime};base64,${res.photo.data}`;
  }

  async function runBatch(actionId, thumb, items) {
    const db = await dbp;
    if (manyUnsupported) {
      for (const it of items) limited(() => fetchOne(actionId, it.id)).then(it.resolve, it.reject);
      return;
    }
    let res;
    try {
      res = await limited(() => api.call('photos.getMany', { actionId, ids: items.map((i) => i.id), thumb }));
    } catch (e) {
      if (isUnsupported(e)) {
        manyUnsupported = true;
        return runBatch(actionId, thumb, items);
      }
      for (const it of items) it.reject(e);
      return;
    }
    const byId = new Map(res.photos.map((p) => [p.id, p]));
    for (const it of items) {
      const p = byId.get(it.id);
      if (!p || p.error) {
        it.reject(new Error('找不到照片'));
        continue;
      }
      const url = `data:${p.mime};base64,${p.data}`;
      // 後端沒有縮圖時回的是原圖：兩種都記起來
      idbPut(db, keyOf(it.id, thumb && p.thumb), url);
      if (!p.thumb) mem.set(keyOf(it.id, false), Promise.resolve(url));
      it.resolve(url);
    }
  }

  function flush() {
    timer = null;
    const groups = [...queue.entries()];
    queue.clear();
    for (const [k, items] of groups) {
      const [actionId, t] = k.split('|');
      for (let i = 0; i < items.length; i += BATCH) runBatch(actionId, t === '1', items.slice(i, i + BATCH));
    }
  }

  /** 取得照片的 data URL；thumb=true 給列表用 */
  function get(actionId, id, { thumb = false } = {}) {
    const key = keyOf(id, thumb);
    if (mem.has(key)) return mem.get(key);
    // 要縮圖但原圖已經在記憶體：直接用原圖
    if (thumb && mem.has(keyOf(id, false))) return mem.get(keyOf(id, false));
    const p = (async () => {
      const db = await dbp;
      const hit = (await idbGet(db, key)) || (thumb ? await idbGet(db, keyOf(id, false)) : null);
      if (hit) return hit;
      return new Promise((resolve, reject) => {
        const qk = `${actionId}|${thumb ? 1 : 0}`;
        if (!queue.has(qk)) queue.set(qk, []);
        queue.get(qk).push({ id, resolve, reject });
        if (!timer) timer = setTimeout(flush, 30);
      });
    })();
    mem.set(key, p);
    p.catch(() => mem.delete(key)); // 失敗的下次再試
    return p;
  }

  /** 剛上傳的照片：直接放進快取，不必再下載 */
  function put(id, dataUrl) {
    mem.set(keyOf(id, false), Promise.resolve(dataUrl));
    dbp.then((db) => idbPut(db, keyOf(id, false), dataUrl));
  }

  /** 登出：清掉記憶體與這台裝置上的照片 */
  async function clear() {
    mem.clear();
    const db = await dbp;
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    } catch {
      /* 忽略 */
    }
  }

  return { get, put, clear };
}
