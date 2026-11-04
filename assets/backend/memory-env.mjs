// 記憶體版後端環境：提供 apps-script/core.js 需要的 env（Properties／Cache／Lock／寄信／Drive＋試算表）。
// Node 的 mock server 與瀏覽器示範模式（?demo=1）共用；不 import 任何套件。
// 正式環境的對應實作在 apps-script/Code.gs（Google Drive／Sheets／MailApp…）。

function randomHexDefault(nBytes) {
  const a = new Uint8Array(nBytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function emptyState() {
  return { props: {}, cache: {}, actions: {}, materials: {}, files: {}, outputs: {}, uploads: {} };
}

/**
 * opts: {
 *   state?        先前 exportState() 的結果（mock 的 JSON 檔）
 *   now?          () => 毫秒（測試可注入假時鐘）
 *   randomHex?    (n) => hex
 *   sendMail?     (to, subject, body) => void
 *   deployer?     部署者 email（模擬 Session.getEffectiveUser）
 *   limits?       覆寫 core 的限制（只給 mock／測試用）
 *   uploadUrl?    (sid) => 影片分段上傳網址
 *   onChange?     () => void（狀態改變時通知，mock 用來寫檔）
 * }
 */
export function createMemoryEnv(opts = {}) {
  const state = opts.state ? structuredClone(opts.state) : emptyState();
  for (const [k, v] of Object.entries(emptyState())) if (!state[k]) state[k] = v;
  const now = opts.now || (() => Date.now());
  const randomHex = opts.randomHex || randomHexDefault;
  const changed = () => opts.onChange && opts.onChange();
  const newFileId = () => `f${randomHex(12)}`;

  const store = {
    listActions: () => Object.values(state.actions).map((a) => structuredClone(a)),
    getAction: (id) => (state.actions[id] ? structuredClone(state.actions[id]) : null),
    createAction(a) {
      // 對應 Code.gs：在「行動報導」資料夾下建子資料夾＋試算表（素材／產出紀錄／_settings）
      state.actions[a.id] = structuredClone({ ...a, folderId: `folder-${a.id}`, sheetId: `sheet-${a.id}` });
      state.materials[a.id] = {};
      state.files[a.id] = {};
      state.outputs[a.id] = [];
      changed();
    },
    updateAction(a) {
      const old = state.actions[a.id];
      state.actions[a.id] = structuredClone({ ...a, folderId: old.folderId, sheetId: old.sheetId });
      changed();
    },
    listMaterials: (aid) => Object.values(state.materials[aid] || {}).map((m) => structuredClone(m)),
    getMaterial: (aid, id) => (state.materials[aid]?.[id] ? structuredClone(state.materials[aid][id]) : null),
    putMaterial(aid, m) {
      state.materials[aid][m.id] = structuredClone(m);
      changed();
    },
    deleteMaterial(aid, id) {
      delete state.materials[aid][id];
      changed();
    },
    saveFile(aid, f) {
      const id = newFileId();
      state.files[aid][id] = { name: f.name, mime: f.mime, size: Math.floor((f.base64.length * 3) / 4) - (f.base64.match(/=*$/)[0].length), base64: f.base64, meta: f.meta };
      changed();
      return id;
    },
    saveTextFile(aid, f) {
      const id = newFileId();
      state.files[aid][id] = { name: f.name, mime: f.mime, size: new TextEncoder().encode(f.text).length, text: f.text, meta: f.meta };
      changed();
      return id;
    },
    getFile(aid, id, withData) {
      const f = state.files[aid]?.[id];
      if (!f) return null;
      const out = { id, name: f.name, mime: f.mime, size: f.size, meta: structuredClone(f.meta || {}) };
      if (withData) out.base64 = f.base64 || '';
      return out;
    },
    setFileMeta(aid, id, meta) {
      if (state.files[aid]?.[id]) state.files[aid][id].meta = structuredClone(meta);
      changed();
    },
    deleteFile(aid, id) {
      if (state.files[aid]) delete state.files[aid][id];
      changed();
    },
    createResumableUpload(aid, info) {
      const sid = randomHex(16);
      state.uploads[sid] = { aid, name: info.name, mime: info.mime, size: info.size, meta: info.meta, received: 0, origin: info.origin, createdAt: now() };
      changed();
      return { uploadUrl: opts.uploadUrl ? opts.uploadUrl(sid) : `demo-upload:${sid}` };
    },
    listOutputs: (aid) => structuredClone(state.outputs[aid] || []),
    addOutput(aid, rec) {
      state.outputs[aid].push(structuredClone(rec));
      changed();
    },
  };

  const env = {
    now,
    randomHex,
    limits: opts.limits,
    props: {
      get: (k) => (Object.hasOwn(state.props, k) ? state.props[k] : null),
      set: (k, v) => {
        state.props[k] = String(v);
        changed();
      },
      del: (k) => {
        delete state.props[k];
        changed();
      },
      keys: () => Object.keys(state.props),
    },
    cache: {
      get(k) {
        const c = state.cache[k];
        if (!c) return null;
        if (c.x <= now()) {
          delete state.cache[k];
          return null;
        }
        return c.v;
      },
      put: (k, v, ttlSec) => {
        state.cache[k] = { v: String(v), x: now() + Math.min(21600, ttlSec) * 1000 };
      },
      del: (k) => {
        delete state.cache[k];
      },
    },
    withLock: (fn) => fn(),
    sendMail: (to, subject, body) => (opts.sendMail ? opts.sendMail(to, subject, body) : undefined),
    deployerEmail: () => opts.deployer || '',
    log: (msg) => (opts.log ? opts.log(msg) : undefined),
    store,
  };

  /**
   * 模擬 Drive resumable upload 的一段 PUT。
   * 回傳 { done:false, received } 或 { done:true, file:{ id, name, mimeType, size } }；錯誤丟出 { status, message }。
   */
  function receiveUploadChunk(sid, start, endExclusive, total, byteLength) {
    const u = state.uploads[sid];
    if (!u) throw { status: 404, message: 'upload session not found' };
    if (total !== u.size || start !== u.received || endExclusive - start !== byteLength || endExclusive > total) {
      throw { status: 400, message: 'bad content-range' };
    }
    u.received = endExclusive;
    if (u.received < u.size) {
      changed();
      return { done: false, received: u.received };
    }
    const id = newFileId();
    // 影片位元組在 mock 中不保存，只記錄大小與中繼資料（實際 Drive 會保存檔案）
    state.files[u.aid][id] = { name: u.name, mime: u.mime, size: u.size, meta: u.meta };
    delete state.uploads[sid];
    changed();
    return { done: true, file: { id, name: u.name, mimeType: u.mime, size: String(u.size) } };
  }

  return {
    env,
    state,
    exportState: () => structuredClone(state),
    receiveUploadChunk,
  };
}
