// 行動報導協作平台（單頁應用，hash 路由）
//   #/            我的行動（未登入時顯示 Email 驗證碼登入）
//   #/new         建立行動（任何登入者；建立者就是負責人）
//   #/admin       總管理者名單與設定（總管理者）
//   #/a/<id>[/materials|generate|outputs|members|settings]  行動報導協作頁（members／settings 只給負責人）
//   #/r/<id>      已發佈的公開報導（免登入，sandbox iframe）
// 所有畫面用 DOM API 建立（textContent），不使用 innerHTML。

import { ApiError, createApi, detectMode } from './api.mjs?v=f3b8c882d4';
import { captureVideoFrame, resizePhoto } from './media.mjs?v=f3b8c882d4';
import { blocksToMarkdown, composeReport, groupByUnit } from '../report/compose.mjs?v=f3b8c882d4';
import { createSummarizer, ruleBasedSummarizer } from '../report/summarizer.mjs?v=f3b8c882d4';
import { canvasToJpegBytes, drawA4Ops, renderA4, renderA4Plan } from '../report/a4.mjs?v=f3b8c882d4';
import { LAYOUTS, previewLayout, selectableLayoutIds } from '../report/a4-layout.mjs?v=f3b8c882d4';
import { buildPdf } from '../report/pdf.mjs?v=f3b8c882d4';
import { createMarkdown, formatDate, formatDateRange, renderStandalone } from '../render.mjs?v=f3b8c882d4';
import { createTour } from './tour.mjs?v=f3b8c882d4';
import { helpView } from './help.mjs?v=f3b8c882d4';
import { createPhotoLoader } from './photos.mjs?v=f3b8c882d4';
import { renderRecordings, rulesEditor } from './recordings.mjs?v=f3b8c882d4';
import { createSnapshot } from './snapshot.mjs?v=f3b8c882d4';

const layoutNames = Object.fromEntries(LAYOUTS.map((l) => [l.id, l.name]));

const root = document.getElementById('app');
const config = JSON.parse(root.dataset.config || '{}');
const mode = detectMode(location.search, config);
const autoDemo = mode === 'demo' && new URLSearchParams(location.search).get('demo') !== '1';
const md = createMarkdown(globalThis.markdownit);
const Core = globalThis.RptCore;
const api = createApi({ mode, config, onDemoMail: (to, code) => showDemoCode(to, code) });
/** 舊版後端（version 2 以前）不認得的 action：前端自動退回舊的呼叫方式 */
const isUnsupported = (e) => e instanceof ApiError && e.code === 'BAD_INPUT' && /未知的操作/.test(e.message);
const photos = createPhotoLoader({ api, isUnsupported, persist: mode !== 'demo' });
// 加速：行動頁資料（行動＋素材＋錄音）在切換頁籤時沿用 2 分鐘；首頁列表先顯示上次的再背景更新
const ACTION_TTL = 2 * 60 * 1000;
const state = { me: null, actions: new Map(), inflight: new Map(), home: null, contacts: null };
// 上次畫面存在這台裝置：重新整理／下次開啟先顯示，再背景更新
const snapshot = createSnapshot({ enabled: mode !== 'demo' });
function saveSnapshot() {
  const actions = {};
  for (const [id, c] of state.actions) actions[id] = { data: c.data, at: c.at };
  snapshot.write(api.token, { me: state.me, home: state.home?.list || null, actions });
}
/** 從上次畫面還原（資料標成過期：會顯示，但一定會背景更新） */
function restoreSnapshot() {
  const snap = snapshot.read(api.token);
  if (!snap || !snap.me) return false;
  state.me = snap.me;
  if (snap.home) state.home = { list: snap.home, at: 0, fresh: false };
  for (const [id, c] of Object.entries(snap.actions || {})) if (!state.actions.has(id)) state.actions.set(id, { data: c.data, at: 0, savedAt: c.at });
  return true;
}
/** 背景更新時發現登入已過期：清掉並回到登入頁 */
function sessionExpired() {
  snapshot.clear();
  api.setToken(null);
  state.me = null;
  state.home = null;
  state.actions.clear();
  flashStatus('登入已過期，請重新登入', 'error');
  route();
}
const tour = createTour({
  api,
  mode,
  getMe: () => state.me,
  getActions: () => state.home?.list,
  go: (hash) => go(hash),
  // 示範模式每個分頁都從頭播放；正式使用記在這台裝置
  storage: mode === 'demo' ? sessionStorage : localStorage,
  defaults: globalThis.RptCore?.PRESETS?.[1],
});
let cssText = null;
let uid = 0;

// ---------- DOM 小工具 ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'onclick' && typeof v === 'function' && (tag === 'button' || tag === 'a')) el.addEventListener('click', guardClick(el, v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  if (value != null) el.value = value;
  return el;
}
/**
 * 防連點：表單送出期間鎖住（再按不會重送），送出按鈕顯示「處理中…」；完成或失敗後恢復。
 * Apps Script 一次往返 1 秒以上，建立行動要建資料夾與試算表更久，沒有這個保護很容易被連點成好幾筆。
 */
function guardSubmit(form, fn) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (form.dataset.busy === '1') return;
    form.dataset.busy = '1';
    form.setAttribute('aria-busy', 'true');
    const btns = [...form.querySelectorAll('button[type=submit], button:not([type])')];
    const saved = btns.map((b) => [b, b.disabled, b.textContent]);
    for (const b of btns) {
      b.disabled = true;
      if (b.textContent.trim()) b.textContent = '處理中…';
    }
    try {
      await fn(ev);
    } finally {
      delete form.dataset.busy;
      form.removeAttribute('aria-busy');
      for (const [b, d, t] of saved) {
        b.disabled = d;
        b.textContent = t;
      }
    }
  });
}
/** 按鈕的非同步動作執行期間自動停用，避免連點重複執行 */
function guardClick(el, fn) {
  return (ev) => {
    if (el.dataset.busy === '1') return;
    const r = fn(ev);
    if (!r || typeof r.then !== 'function') return r;
    const was = el.disabled;
    el.dataset.busy = '1';
    el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    return r.finally(() => {
      delete el.dataset.busy;
      el.removeAttribute('aria-busy');
      // 動作本身改了 disabled（例如自己先停用）就尊重它
      if (el.disabled) el.disabled = was;
    });
  };
}
/** replaceChildren 不會略過 null，統一經這裡濾掉 */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'label', text: label }), control, hint ? h('span', { class: 'hint', text: hint }) : null);

function errorText(err) {
  return err instanceof ApiError ? err.message : `發生錯誤：${err && err.message ? err.message : err}`;
}
let statusEl;
function setStatus(msg, kind = 'info') {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.dataset.kind = kind;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const safeFileName = (s) => String(s || 'report').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60);
/** 台北時間（UTC+8）：toISOString() 是 UTC，台灣清晨 8 點前會變成前一天 */
const taipeiIso = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString();
const taipeiToday = () => taipeiIso(Date.now()).slice(0, 10);
const taipeiTime = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? taipeiIso(ms).replace('T', ' ').slice(0, 16) : String(iso || '');
};
/** 我在這個行動的角色（後端 myRole）；比照報名系統的擁有者／共同管理者 */
const ROLE_LABEL = { manager: '負責人', collaborator: '共同協作者', contributor: '開放投稿' };
const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

async function getCss() {
  if (cssText == null) cssText = await (await fetch(new URL('../styles.css?v=f3b8c882d4', import.meta.url))).text();
  return cssText;
}

/** 原圖（生成報導、A4 用） */
const photoDataUrl = (actionId, photoId) => photos.get(actionId, photoId);
/** 縮圖（列表用） */
const photoThumbUrl = (actionId, photoId) => photos.get(actionId, photoId, { thumb: true });

// ---------- 資料載入（合併查詢＋快取） ----------
/** 首頁：boot 一次拿 me＋我的行動；舊版後端退回 me＋actions.list */
async function fetchHome() {
  let list;
  try {
    const r = await api.call('boot');
    state.me = r.me;
    list = r.actions;
  } catch (e) {
    if (!isUnsupported(e)) throw e;
    if (!state.me) state.me = await api.call('me');
    list = (await api.call('actions.list')).actions;
  }
  state.home = { list, at: Date.now(), fresh: true };
  saveSnapshot();
  return list;
}
/** 行動頁：action.open 一次拿行動＋素材＋錄音（必要時含 me）；舊版後端退回 actions.list＋materials.list */
async function fetchAction(id) {
  let data;
  try {
    const r = await api.call('action.open', { actionId: id, withMe: !state.me });
    if (r.me) state.me = r.me;
    data = { action: r.action, materials: r.materials, recordings: r.recordings || [], legacy: false };
  } catch (e) {
    if (!isUnsupported(e)) throw e;
    if (!state.me) state.me = await api.call('me');
    const action = (await api.call('actions.list')).actions.find((a) => a.id === id);
    if (!action) throw new ApiError('FORBIDDEN', '找不到這個行動，或您不是這個行動的協作者。');
    data = { action, materials: (await api.call('materials.list', { actionId: id })).materials, recordings: [], legacy: true };
  }
  state.actions.set(id, { data, at: Date.now() });
  saveSnapshot();
  return data;
}
/** 任何時間存過的行動資料（含過期的上次畫面），用來先顯示 */
function staleAction(id) {
  return state.actions.get(id)?.data || null;
}
/** 快取中、還沒過期的行動資料（沒有就回 null） */
function cachedAction(id) {
  const c = state.actions.get(id);
  return c && Date.now() - c.at < ACTION_TTL ? c.data : null;
}
async function loadAction(id, { force = false } = {}) {
  if (!force) {
    const c = cachedAction(id);
    if (c) return c;
    // 預先載入已經在路上：等同一個請求，不重打
    if (state.inflight.has(id)) return state.inflight.get(id);
  }
  const p = fetchAction(id).finally(() => state.inflight.delete(id));
  state.inflight.set(id, p);
  return p;
}
/** 首頁顯示後，背景依序先載入前幾個行動（一次一個，不跟使用者的操作搶） */
let warmTimer = null;
function warmActions(list) {
  clearTimeout(warmTimer);
  const ids = list.slice(0, 3).map((a) => a.id);
  const next = () => {
    const id = ids.shift();
    if (!id) return;
    if (cachedAction(id) || state.inflight.has(id)) return next();
    loadAction(id).catch(() => {}).finally(() => (warmTimer = setTimeout(next, 200)));
  };
  warmTimer = setTimeout(next, 600);
}
/** 預先載入（手指碰到或滑鼠移到行動卡片時）：失敗不提示，真的點進去時再處理 */
function prefetchAction(id) {
  if (cachedAction(id) || state.inflight.has(id)) return;
  loadAction(id).catch(() => {});
}
/** 資料改了：清掉快取，下次重新載入 */
function invalidate() {
  state.actions.clear();
  if (state.home) state.home.fresh = false;
}
async function loadContacts() {
  if (state.contacts) return state.contacts;
  try {
    state.contacts = (await api.call('contacts.list')).contacts;
  } catch (e) {
    if (!isUnsupported(e)) throw e;
    state.contacts = [];
  }
  return state.contacts;
}
function loadImg(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ---------- 外框 ----------
const view = h('div', { class: 'app-view' });
const bar = h('div', { class: 'app-bar' });
statusEl = h('p', { class: 'status app-status', role: 'status', 'aria-live': 'polite' });
const demoBox = h('p', { class: 'demo-code', hidden: true, 'data-testid': 'demo-code' });
root.replaceChildren(bar, demoBox, statusEl, view);

function showDemoCode(to, code) {
  demoBox.hidden = false;
  demoBox.textContent = `示範模式不會寄信，驗證碼就在這裡：${code}（${to}）`;
}
function syncDateHint(input, testid) {
  const hint = document.querySelector('[data-testid="' + testid + '"]');
  if (hint) hint.textContent = input.value ? formatDate(input.value) : '';
}

function openDialog({ title, body, actions, testid = 'app-dialog' }) {
  const dialog = h('dialog', { class: 'dialog', 'data-testid': testid, 'aria-label': title });
  dialog.append(h('h3', { text: title }));
  if (body) dialog.append(body);
  const row = h('div', { class: 'dialog-actions' });
  function close() {
    if (dialog.open) dialog.close();
    dialog.remove();
  }
  for (const a of actions || []) {
    row.append(h('button', {
      type: 'button',
      class: a.primary ? 'btn primary' : 'btn',
      text: a.text,
      'data-testid': a.testid || (a.primary ? 'dialog-ok' : 'dialog-cancel'),
      onclick: () => { if (a.onClick) a.onClick(close); else close(); },
    }));
  }
  dialog.append(row);
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  return { overlay: dialog, box: dialog, close };
}

function confirmDialog(message, { title = '請確認', confirmText = '確定', cancelText = '取消', testid = 'confirm-dialog' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const dlg = openDialog({
      title,
      body: h('p', { class: 'dialog-message', text: message }),
      testid,
      actions: [
        { text: cancelText, testid: 'dialog-cancel', onClick: (close) => { finish(false); close(); } },
        { text: confirmText, primary: true, testid: 'dialog-ok', onClick: (close) => { finish(true); close(); } },
      ],
    });
    dlg.overlay.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); finish(false); });
    dlg.overlay.addEventListener('close', () => finish(false));
  });
}

function promptDialog(message, { title = '請輸入', defaultValue = '', confirmText = '確定', cancelText = '取消', testid = 'prompt-dialog' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const input = h('input', { class: 'dialog-input', 'data-testid': 'prompt-input', value: defaultValue || '' });
    const submit = () => finish(input.value);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
        dlg.close();
      }
    });
    const dlg = openDialog({
      title,
      body: h('div', {}, h('p', { class: 'dialog-message', text: message }), input),
      testid,
      actions: [
        { text: cancelText, testid: 'dialog-cancel', onClick: (close) => { finish(null); close(); } },
        { text: confirmText, primary: true, testid: 'dialog-ok', onClick: (close) => { submit(); close(); } },
      ],
    });
    dlg.overlay.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); finish(null); });
    dlg.overlay.addEventListener('close', () => finish(null));
    setTimeout(() => input.focus(), 0);
  });
}

function askPickVideos(videos, max) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const list = h('div', { class: 'video-pick-list' });
    const boxes = [];
    videos.forEach((item, index) => {
      const box = h('input', { type: 'checkbox', value: item.key, 'data-testid': `video-keep-${item.key}` });
      if (index < max) box.checked = true;
      const label = h('label', { class: 'video-pick-item' }, box, h('span', { text: `${item.materialTitle}：${item.video.title || item.video.url || '未命名影片'}` }));
      boxes.push(box);
      box.addEventListener('change', () => {
        const checkedCount = boxes.filter((b) => b.checked).length;
        boxes.forEach((b) => { b.disabled = checkedCount >= max && !b.checked; });
      });
      list.append(label);
    });
    boxes.forEach((b) => { b.disabled = boxes.filter((x) => x.checked).length >= max && !b.checked; });
    const body = h('div', {}, h('p', { text: `有 ${videos.length} 支影片，超過上限 ${max} 支，請勾選要保留的（最多 ${max} 支），其餘將被省略。` }), list);
    const dlg = openDialog({
      title: '選擇要保留的影片',
      body,
      testid: 'video-pick-dialog',
      actions: [
        { text: '取消', testid: 'dialog-cancel', onClick: (close) => { finish(null); close(); } },
        { text: '確認保留', primary: true, testid: 'dialog-ok', onClick: (close) => { finish(boxes.filter((b) => b.checked).map((b) => b.value)); close(); } },
      ],
    });
    dlg.overlay.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); finish(null); });
    dlg.overlay.addEventListener('close', () => finish(null));
  });
}

function base64ToBlob(base64, mime) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

function outputFileBase(o) {
  const page = o.pageIndex != null ? `-p${o.pageIndex + 1}` : '';
  return `${(o.title || '未命名報導').replace(/[\\/:*?"<>|]/g, '')}${page}`;
}

async function viewOutput(action, o) {
  if (o.published && o.publicId && o.kind !== 'a4') {
    window.open(publicReportUrl(o.publicId), '_blank', 'noopener');
    return;
  }
  const res = await api.call('outputs.get', { actionId: action.id, outputId: o.id });
  const rec = res.output || res;
  const pageLabel = rec.pageIndex != null ? `（第 ${rec.pageIndex + 1} 頁）` : '';
  if (rec.kind === 'a4') {
    const mime = rec.mime || (rec.format === 'pdf' ? 'application/pdf' : 'image/png');
    let src = rec.dataUrl || null;
    if (!src && rec.base64) src = URL.createObjectURL(base64ToBlob(rec.base64, mime));
    if (!src) throw new Error('找不到檔案內容');
    const body = mime === 'application/pdf' ? h('embed', { src, type: 'application/pdf', class: 'output-preview' }) : h('img', { src, class: 'output-preview', alt: `${rec.title || 'A4 報導'}${pageLabel}` });
    openDialog({ title: `${rec.title || '未命名報導'}${pageLabel}`, body, actions: [{ text: '關閉', testid: 'dialog-ok' }], testid: 'output-view-dialog' });
    return;
  }
  const frame = h('iframe', { class: 'output-preview-frame', title: rec.title || '網頁報導' });
  frame.srcdoc = rec.html || '';
  openDialog({ title: rec.title || '未命名報導', body: frame, actions: [{ text: '關閉', testid: 'dialog-ok' }], testid: 'output-view-dialog' });
}

async function downloadOutput(action, o) {
  const res = await api.call('outputs.get', { actionId: action.id, outputId: o.id });
  const rec = res.output || res;
  const base = outputFileBase(rec);
  if (rec.kind === 'a4') {
    const mime = rec.mime || (rec.format === 'pdf' ? 'application/pdf' : 'image/png');
    const ext = rec.format === 'pdf' ? 'pdf' : 'png';
    let blob = null;
    if (rec.dataUrl) blob = await dataUrlToBlob(rec.dataUrl);
    else if (rec.base64) blob = base64ToBlob(rec.base64, mime);
    if (!blob) throw new Error('找不到檔案內容');
    download(blob, `${base}.${ext}`);
    return;
  }
  download(new Blob([rec.html || ''], { type: 'text/html' }), `${base}.html`);
}

function applyRegenSettings(settings, action) {
  try {
    const raw = sessionStorage.getItem('regen-settings:' + action.id);
    if (!raw) return;
    sessionStorage.removeItem('regen-settings:' + action.id);
    const rs = JSON.parse(raw);
    if (!rs) return;
    if (settings && typeof settings.set === 'function') { settings.set(rs); return; }
    const setVal = (name, value) => {
      if (value == null) return;
      const el = document.querySelector(`[name="${name}"]`);
      if (el) { el.value = String(value); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    setVal('words', rs.words);
    setVal('maxPhotos', rs.maxPhotos);
    setVal('maxVideos', rs.maxVideos);
    setVal('pages', rs.pages);
  } catch {
    /* 忽略損壞的暫存設定 */
  }
}

/** 頁尾版本號後面補上後端版本（登入後才知道） */
function showBackendVersion() {
  const el = document.querySelector('[data-backend-version]');
  if (!el) return;
  const v = state.me && state.me.version;
  el.textContent = v ? ` · 後端 v${v}` : '';
}
function renderBar() {
  showBackendVersion();
  const badge =
    mode === 'demo'
      ? h('span', { class: 'mode-badge', 'data-testid': 'mode-badge', text: `示範模式${autoDemo ? '・尚未設定後端' : ''}（資料存在這個分頁，關閉分頁才會清除）` })
      : mode === 'mock'
        ? h('span', { class: 'mode-badge', text: '本機 mock 後端' })
        : null;
  const user = state.me
    ? h(
        'span',
        { class: 'app-user' },
        h('span', { 'data-testid': 'me-email', text: state.me.email }),
        state.me.role === 'super' ? h('span', { class: 'role-badge', text: '總管理者' }) : null,
        h('button', { class: 'btn small', type: 'button', 'data-testid': 'tour-replay', onclick: () => tour.start(), text: '使用教學' }),
        h('a', { class: 'btn small', href: '#/help', 'data-testid': 'help-link', text: '使用說明' }),
        h('button', { class: 'btn small', type: 'button', 'data-testid': 'logout', onclick: logout, text: '登出' }),
      )
    : null;
  fill(bar, h('a', { class: 'app-home', href: '#/', text: '行動報導協作平台' }), badge, user);
}

async function logout() {
  try {
    await api.call('auth.logout');
  } catch {
    /* 已失效也沒關係 */
  }
  api.setToken(null);
  snapshot.clear();
  state.me = null;
  state.actions.clear();
  state.home = null;
  state.contacts = null;
  await photos.clear();
  tour.reset();
  go('#/');
}

// ---------- 路由 ----------
/** 換頁後仍要讓使用者看到的訊息（例如「已合併到原本的行動」） */
let flash = null;
function flashStatus(msg, kind = 'info') {
  flash = { msg, kind };
  setStatus(msg, kind);
}
async function fetchPublicReport(id) {
  const res = await api.call('outputs.public', { id });
  if (!res || !res.output) throw new Error((res && res.error) || '找不到已發佈的報導');
  return res.output;
}

async function renderPublicReport(id) {
  renderBar();
  fill(view, h('section', { class: 'panel' }, h('h1', { class: 'page-title', text: '載入公開報導…' })));
  window.scrollTo(0, 0);
  try {
    const output = await fetchPublicReport(id);
    const frame = h('iframe', { class: 'preview-frame public-frame', title: output.title || '公開報導', sandbox: '', 'data-testid': 'public-preview' });
    fill(
      view,
      h(
        'section',
        { class: 'panel' },
        h('h1', { class: 'page-title', text: output.title || '公開報導' }),
        h('p', { class: 'report-stats', text: output.publishedAt || output.createdAt ? `發佈於 ${(output.publishedAt || output.createdAt).slice(0, 10)}` : '' }),
        frame,
      ),
    );
    frame.srcdoc = output.html;
  } catch (e) {
    fill(
      view,
      h(
        'section',
        { class: 'panel' },
        h('h1', { class: 'page-title', text: '找不到這篇公開報導' }),
        h('p', { text: '連結可能已取消發佈，或 id 不正確。' }),
      ),
    );
  }
}

async function route() {
  if (flash) {
    setStatus(flash.msg, flash.kind);
    flash = null;
  } else setStatus('');
  if (!api.configured) {
    renderBar();
    fill(view, 
      h('section', { class: 'panel' }, h('h1', { class: 'page-title', text: '尚未設定後端' }), h('p', { text: '請在 site.config.json 填入 Apps Script 網頁應用程式網址（apiUrl）後重新建置。也可以在網址後面加上 ?demo=1 試用示範模式。' })),
    );
    return;
  }
  const publicMatch = /^#\/r\/([A-Za-z0-9_-]+)$/.exec(location.hash || '');
  if (publicMatch) {
    await renderPublicReport(publicMatch[1]);
    return;
  }
  if ((location.hash || '') === '#/help') {
    renderBar();
    fill(view, helpView(h, { loggedIn: !!api.token }));
    window.scrollTo(0, 0);
    return;
  }
  if (!api.token) {
    state.me = null;
    renderBar();
    return renderLogin();
  }
  const hash = location.hash || '#/';
  const am = ACTION_ROUTE.exec(hash);
  const isHome = hash === '#/' || hash === '#';
  // 有上次畫面：直接用（首頁／行動頁會背景更新）
  if (!state.me) restoreSnapshot();
  if (!state.me) {
    // 第一次載入：跟畫面資料一起拿 me（省一次 1 秒以上的往返）
    fill(view, h('p', { text: '載入中…' }));
    try {
      if (isHome) await fetchHome();
      else if (am) await fetchAction(am[1]).catch(async (e) => {
        if (e.code === 'AUTH_REQUIRED' || state.me) throw e;
        state.me = await api.call('me'); // 行動打不開（例如不是協作者）：仍要知道我是誰，下面會顯示錯誤
      });
      else state.me = await api.call('me');
    } catch (err) {
      renderBar();
      if (err.code === 'AUTH_REQUIRED') return renderLogin();
      fill(view, h('p', { class: 'errors', role: 'alert', text: errorText(err) }));
      return;
    }
  }
  renderBar();
  tour.maybeStart();
  if (isHome) return renderHome();
  if (hash === '#/new') return renderActionForm(null);
  if (hash === '#/admin') return renderAdmin();
  if (am) return renderAction(am[1], am[2] || 'materials');
  fill(view, h('p', { text: '找不到這個頁面。' }), h('a', { href: '#/', text: '回首頁' }));
}
const ACTION_ROUTE = /^#\/a\/([A-Za-z0-9_-]+)(?:\/(materials|generate|outputs|members|settings))?$/;

// ---------- 登入 ----------
/** 預熱：Apps Script 閒置一陣子後第一次呼叫特別慢；登入頁一打開就先叫醒它 */
let warmedUp = false;
function warmUpBackend() {
  if (warmedUp || mode === 'demo') return;
  warmedUp = true;
  api.call('ping').catch(() => {});
}
function renderLogin() {
  warmUpBackend();
  const err = h('p', { class: 'errors', role: 'alert' });
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', value: mode === 'demo' ? 'demo@example.com' : '' });
  const code = h('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '\\d{6}', required: true });
  const codeForm = h(
    'form',
    { class: 'login-step', hidden: true, 'data-testid': 'code-form' },
    field('驗證碼（6 位數）', code, mode === 'demo' ? '驗證碼會直接顯示在這個頁面，10 分鐘內有效；輸入錯誤 5 次需重新索取。' : '請到信箱收信，10 分鐘內有效；輸入錯誤 5 次需重新索取。'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: '登入' }), h('button', { class: 'btn', type: 'button', text: '換一個 email', onclick: () => ((codeForm.hidden = true), (emailForm.hidden = false)) })),
  );
  const emailForm = h(
    'form',
    { class: 'login-step', 'data-testid': 'email-form' },
    field('Email', email, mode === 'demo' ? '不會寄信，驗證碼會直接顯示在這個頁面。' : '我們會寄一組 6 位數驗證碼給您，不需要密碼。'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: mode === 'demo' ? '取得示範驗證碼' : '寄送驗證碼' })),
  );
  guardSubmit(emailForm, async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    try {
      const r = await api.call('auth.requestCode', { email: email.value });
      setStatus(r.message);
      emailForm.hidden = true;
      codeForm.hidden = false;
      code.focus();
    } catch (e) {
      err.textContent = errorText(e);
    }
  });
  guardSubmit(codeForm, async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    try {
      const r = await api.call('auth.verifyCode', { email: email.value, code: code.value, withBoot: true });
      api.setToken(r.token);
      snapshot.clear();
      state.me = null;
      state.actions.clear();
      state.home = null;
      // 後端順便回傳了首頁資料（version 5）：直接用，不必再等一次
      if (r.boot && r.boot.me) {
        state.me = r.boot.me;
        state.home = { list: r.boot.actions || [], at: Date.now(), fresh: true };
        saveSnapshot();
      }
      demoBox.hidden = true;
      // 協作者點負責人傳來的 #/a/<id> 連結再登入：登入後回到原本要去的行動
      go(location.hash && location.hash !== '#' ? location.hash : '#/');
    } catch (e) {
      err.textContent = errorText(e);
      code.select();
      if (e.code === 'CODE_LOCKED' || e.code === 'CODE_INVALID') {
        codeForm.hidden = true;
        emailForm.hidden = false;
      }
    }
  });
  fill(view, 
    h('section', { class: 'panel login' }, h('h1', { class: 'page-title', text: '登入' }), h('p', { text: '台中市召會行動報導協作平台：任何人用 email 登入後都能建立自己的行動、邀請共同協作者上傳報導與見證，一鍵生成網頁報導與 A4 圖檔。' }), emailForm, codeForm, err, h('p', { class: 'hint' }, h('a', { href: '#/help', 'data-testid': 'help-link', text: '第一次使用？看使用說明' }))),
  );
}

// ---------- 首頁：我的行動 ----------
async function renderHome() {
  const cached = state.home;
  if (cached) {
    drawHome(cached.list);
    // 這次進站剛用 boot 拿到的就不再重拿；否則背景更新，有變才重畫
    if (cached.fresh) {
      cached.fresh = false;
      warmActions(cached.list);
      return;
    }
    try {
      const fresh = await fetchHome();
      state.home.fresh = false;
      if (location.hash && location.hash !== '#/' && location.hash !== '#') return; // 已離開首頁
      if (JSON.stringify(fresh) !== JSON.stringify(cached.list)) drawHome(fresh);
      renderBar();
      warmActions(fresh);
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED') return sessionExpired();
      /* 其他背景更新失敗：保留畫面 */
    }
    return;
  }
  fill(view, h('p', { text: '載入中…' }));
  try {
    const list = await fetchHome();
    drawHome(list);
    warmActions(list);
  } catch (e) {
    fill(view, h('p', { class: 'errors', role: 'alert', text: errorText(e) }));
  }
}
// 總管理者的選取模式（首頁「選取」→ 勾選／全選 →「刪除所選」）；背景更新重畫時保留
const homeSelect = { on: false, ids: new Set() };

function drawHome(list) {
  const isSuper = state.me.role === 'super';
  if (!isSuper) homeSelect.on = false;
  // 已不在列表上的就不算選取
  const known = new Set(list.map((a) => a.id));
  for (const id of [...homeSelect.ids]) if (!known.has(id)) homeSelect.ids.delete(id);
  const selecting = isSuper && homeSelect.on && list.length > 0;
  const redraw = () => drawHome(state.home?.list || list);

  const cardText = (a) =>
    h(
      'span',
      { class: 'card-text' },
      h('span', { class: 'card-cat', text: ROLE_LABEL[a.myRole] || '' }),
      h('h2', { class: 'card-title', text: a.name }),
      h('span', { class: 'card-date', text: `${formatDateRange(a.date, a.endDate)}${a.place ? `｜${a.place}` : ''}` }),
      // 總管理者選取時多顯示負責人，方便分辨同名的行動
      selecting && a.owners && a.owners.length ? h('span', { class: 'card-owner hint', text: `負責人：${a.owners.join('、')}` }) : null,
    );
  const card = (a) =>
    selecting
      ? h(
          'label',
          { class: `card action-card selectable${homeSelect.ids.has(a.id) ? ' selected' : ''}`, 'data-action': a.id },
          h('input', {
            type: 'checkbox',
            class: 'select-box',
            name: 'select-action',
            value: a.id,
            checked: homeSelect.ids.has(a.id),
            'aria-label': `選取「${a.name}」`,
            onchange: (ev) => {
              if (ev.target.checked) homeSelect.ids.add(a.id);
              else homeSelect.ids.delete(a.id);
              redraw();
            },
          }),
          cardText(a),
        )
      : h(
          'a',
          {
            class: 'card action-card',
            href: `#/a/${a.id}`,
            // 先載入：手指一碰到、滑鼠移上去或用鍵盤選到就開始拿資料，點下去時多半已經好了
            onpointerenter: () => prefetchAction(a.id),
            ontouchstart: () => prefetchAction(a.id),
            onfocus: () => prefetchAction(a.id),
          },
          cardText(a),
        );

  const n = homeSelect.ids.size;
  const allOn = n > 0 && n === list.length;
  const toolbar = selecting
    ? h(
        'div',
        { class: 'select-toolbar', 'data-testid': 'select-toolbar' },
        h(
          'label',
          { class: 'checkbox select-all' },
          h('input', {
            type: 'checkbox',
            name: 'select-all',
            checked: allOn,
            onchange: (ev) => {
              homeSelect.ids = ev.target.checked ? new Set(list.map((a) => a.id)) : new Set();
              redraw();
            },
          }),
          h('span', { text: '全選' }),
        ),
        h('span', { class: 'select-count', 'data-testid': 'select-count', text: `已選 ${n} 個` }),
        h('button', { type: 'button', class: 'btn danger', 'data-testid': 'delete-selected', disabled: n === 0, text: '刪除所選', onclick: () => deleteSelected(list) }),
        h('button', {
          type: 'button',
          class: 'btn',
          text: '完成',
          onclick: () => {
            homeSelect.on = false;
            homeSelect.ids.clear();
            redraw();
          },
        }),
      )
    : null;

  fill(view,
    h(
      'div',
      { class: 'section-head' },
      h('h1', { class: 'page-title', text: isSuper ? '所有行動' : '我的行動' }),
      h(
        'span',
        { class: 'actions' },
        h('a', { class: 'btn primary', href: '#/new', 'data-testid': 'new-action', text: '建立新行動' }),
        isSuper && list.length && !selecting
          ? h('button', {
              type: 'button',
              class: 'btn',
              'data-testid': 'select-mode',
              text: '選取',
              onclick: () => {
                homeSelect.on = true;
                homeSelect.ids.clear();
                redraw();
              },
            })
          : null,
        isSuper ? h('a', { class: 'btn', href: '#/admin', text: '總管理者名單' }) : null,
      ),
    ),
    h('hr', { class: 'hairline' }),
    toolbar,
    list.length
      ? h('div', { class: `card-grid action-list${selecting ? ' selecting' : ''}`, 'data-testid': 'action-list' }, list.map(card))
      : h(
          'div',
          { class: 'empty', 'data-testid': 'empty-actions' },
          h('p', { text: '您還沒有任何行動。按「建立新行動」開始，您就是這個行動的負責人，可以再邀請共同協作者一起上傳素材。' }),
          h('p', { class: 'hint', text: '若您是受邀的協作者，請確認負責人已把您的 email 加入協作者名單。' }),
          h('p', {}, h('a', { class: 'btn primary', href: '#/new', 'data-testid': 'new-action', text: '建立新行動' })),
        ),
  );
}

/** 刪除所選的行動（總管理者）：列出名稱、輸入「刪除」確認；資料夾移到雲端硬碟垃圾桶 */
async function deleteSelected(list) {
  const picked = list.filter((a) => homeSelect.ids.has(a.id));
  if (!picked.length) return;
  const names = picked.slice(0, 10).map((a) => `・${a.name}（${formatDateRange(a.date, a.endDate)}）`);
  if (picked.length > 10) names.push(`…還有 ${picked.length - 10} 個`);
  const typed = await promptDialog(
    `要刪除這 ${picked.length} 個行動嗎？\n\n${names.join('\n')}\n\n素材、照片、錄音會一起刪除；雲端硬碟中的資料夾會移到垃圾桶，30 天內可以救回。\n請輸入「刪除」兩個字確認：`,
    { title: '刪除行動', confirmText: '確認刪除', testid: 'delete-many-dialog' },
  );
  if (typed == null) return;
  if (typed.trim() !== '刪除') {
    setStatus('沒有輸入「刪除」，已取消', 'error');
    return;
  }
  const ids = picked.map((a) => a.id);
  setStatus(`刪除 ${ids.length} 個行動中…`);
  let deleted = [];
  let failed = [];
  try {
    const r = await api.call('actions.deleteMany', { ids, confirmCount: ids.length });
    deleted = r.deleted;
    failed = r.failed;
  } catch (e) {
    if (!isUnsupported(e)) {
      setStatus(errorText(e), 'error');
      return;
    }
    // 後端還是舊版：一個一個刪
    for (const a of picked) {
      try {
        await api.call('actions.delete', { id: a.id, confirmName: a.name });
        deleted.push(a.id);
      } catch (err) {
        failed.push({ id: a.id, error: errorText(err) });
      }
    }
  }
  const gone = new Set(deleted);
  for (const id of gone) {
    state.actions.delete(id);
    homeSelect.ids.delete(id);
  }
  if (state.home) state.home.list = state.home.list.filter((a) => !gone.has(a.id));
  saveSnapshot();
  if (!homeSelect.ids.size) homeSelect.on = false;
  drawHome(state.home?.list || []);
  const nameOf = (id) => list.find((a) => a.id === id)?.name || id;
  if (failed.length) setStatus(`已刪除 ${deleted.length} 個；${failed.length} 個沒有刪除：${failed.map((f) => `${nameOf(f.id)}（${f.error}）`).join('、')}`, 'error');
  else setStatus(`已刪除 ${deleted.length} 個行動`);
}

// ---------- 報導設定控制項 ----------
function settingsControls(initial) {
  const me = state.me;
  const s = Core.normalizeSettings(initial);
  const ranges = me.ranges;
  const sharedWrap = h('div', { class: 'settings', 'data-testid': 'settings' });
  const a4Wrap = h('div', { class: 'settings settings-a4', 'data-testid': 'settings-a4' });
  const group = `layout-${++uid}`;
  const inputs = {};
  const a4Inputs = {};
  const sharedLabels = {
    words: ['字數', (v) => `${v} 字`],
    maxPhotos: ['照片張數上限', (v) => `${v} 張`],
    maxVideos: ['影片數上限', (v) => `${v} 部`],
  };
  const a4Labels = { pages: ['A4 頁數', (v) => `${v} 頁`] };
  const makeRow = (store, key, label, fmt) => {
    const r = ranges[key];
    const out = h('output', { class: 'range-value', 'data-testid': `out-${key}` });
    const input = h('input', { type: 'range', name: key, min: r.min, max: r.max, step: r.step, value: String(s[key]), 'aria-label': label });
    const sync = () => {
      out.textContent = fmt(input.value);
    };
    input.addEventListener('input', sync);
    sync();
    store[key] = { input, sync };
    return h('label', { class: 'field range-row' }, h('span', { class: 'label', text: label }), input, out);
  };
  const sharedRows = Object.keys(sharedLabels).map((key) => makeRow(inputs, key, sharedLabels[key][0], sharedLabels[key][1]));
  const a4Rows = Object.keys(a4Labels).map((key) => makeRow(a4Inputs, key, a4Labels[key][0], a4Labels[key][1]));
  const available = selectableLayoutIds(me.layouts);
  const layoutThumb = (id) => new URL(`../brand/layouts/${id}.webp`, import.meta.url).href;
  const layoutGroup = h(
    'fieldset',
    { class: 'field layout-choice', 'data-testid': 'layout-choice' },
    h('legend', { class: 'label', text: '版面樣式' }),
    h(
      'div',
      { class: 'layout-grid' },
      available.map((l) =>
        h(
          'label',
          { class: 'layout-card', 'data-testid': `layout-card-${l}` },
          h('input', { type: 'radio', name: group, value: l, checked: s.layout === l, 'data-layout': l }),
          h('img', { src: layoutThumb(l), alt: '', width: '360', height: '509', decoding: 'async' }),
          h('span', { class: 'layout-card-name', text: layoutNames[l] || l }),
        ),
      ),
    ),
  );
  const apply = (p) => {
    for (const key of Object.keys(inputs)) {
      inputs[key].input.value = String(p[key]);
      inputs[key].sync();
    }
    for (const key of Object.keys(a4Inputs)) {
      a4Inputs[key].input.value = String(p[key]);
      a4Inputs[key].sync();
    }
    for (const r of layoutGroup.querySelectorAll('input[type=radio]')) r.checked = r.value === p.layout;
  };
  const presets = h(
    'div',
    { class: 'presets' },
    h('span', { class: 'label', text: '預設組合' }),
    me.presets.map((p) =>
      h('button', { type: 'button', class: 'pill', 'data-preset': p.id, onclick: () => apply(p), text: `${p.name}（${p.words}字／${p.maxPhotos}圖／${p.maxVideos}影片／${p.pages}頁）` }),
    ),
  );
  sharedWrap.append(presets, ...sharedRows);
  a4Wrap.append(...a4Rows, layoutGroup);
  const read = (store) => {
    const out = {};
    for (const key of Object.keys(store)) out[key] = Number(store[key].input.value);
    return out;
  };
  return {
    el: sharedWrap,
    a4El: a4Wrap,
    layoutGroup,
    get() {
      const out = { ...read(inputs), ...read(a4Inputs) };
      const checked = layoutGroup.querySelector('input[type=radio]:checked');
      out.layout = checked ? checked.value : 'classic';
      return Core.normalizeSettings(out);
    },
    getShared() {
      return Core.normalizeSettings({ ...read(inputs), pages: s.pages, layout: s.layout });
    },
    getA4() {
      const out = { ...read(a4Inputs) };
      const checked = layoutGroup.querySelector('input[type=radio]:checked');
      out.layout = checked ? checked.value : 'classic';
      return out;
    },
    set(rs) {
      if (!rs) return;
      apply({
        words: rs.words ?? Number(inputs.words.input.value),
        maxPhotos: rs.maxPhotos ?? Number(inputs.maxPhotos.input.value),
        maxVideos: rs.maxVideos ?? Number(inputs.maxVideos.input.value),
        pages: rs.pages ?? Number(a4Inputs.pages.input.value),
        layout: rs.layout || (layoutGroup.querySelector('input[type=radio]:checked') || {}).value,
      });
    },
  };
}

function measurePreviewText(text, fnt) {
  if (!measurePreviewText.ctx) measurePreviewText.ctx = document.createElement('canvas').getContext('2d');
  measurePreviewText.ctx.font = fnt;
  return measurePreviewText.ctx.measureText(text).width;
}

function isA4Canvas(page) {
  return page instanceof HTMLCanvasElement || (page && page.nodeName === 'CANVAS');
}

/** 把 A4 結果畫進預覽區。之後的拖拉編輯器直接接在這個函式。 */
export function renderA4Preview(container, result) {
  fill(container);
  if (!result || !Array.isArray(result.pages) || !result.pages.length) {
    container.append(h('p', { class: 'report-stats', text: '尚未生成 A4 圖檔' }));
    return;
  }
  const total = result.pages.length;
  const base = result.fileBase || 'a4';
  result.pages.forEach((page, i) => {
    const pageEl = h('figure', { class: 'a4-page', 'data-testid': `a4-page-${i + 1}` });
    let url = '';
    if (isA4Canvas(page)) {
      const c = document.createElement('canvas');
      c.width = page.width;
      c.height = page.height;
      c.getContext('2d').drawImage(page, 0, 0);
      url = c.toDataURL('image/png');
    } else if (page.canvas) {
      const src = page.canvas;
      const c = document.createElement('canvas');
      c.width = src.width || 1240;
      c.height = src.height || 1754;
      c.getContext('2d').drawImage(src, 0, 0);
      url = c.toDataURL('image/png');
    } else if (page.dataUrl) {
      url = page.dataUrl;
    } else if (Array.isArray(page.ops)) {
      const c = document.createElement('canvas');
      c.width = 1240;
      c.height = 1754;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      drawA4Ops(ctx, page.ops, result.images);
      url = c.toDataURL('image/png');
    }
    if (url) pageEl.append(h('img', { src: url, alt: `第 ${i + 1} 頁` }));
    pageEl.append(
      h('figcaption', {}, h('span', { class: 'a4-page-no', text: `第 ${i + 1} / ${total} 頁` }), url ? h('button', {
        type: 'button', class: 'btn', 'data-testid': `png-${i + 1}`, text: `下載第 ${i + 1} 頁 PNG`,
        onclick: () => {
          if (!url) return;
          if (url.startsWith('data:')) {
            download(new Blob([Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0))], { type: 'image/png' }), `${base}-p${i + 1}.png`);
          } else {
            const a = document.createElement('a');
            a.href = url; a.download = `${base}-p${i + 1}.png`; a.click();
          }
        },
      }) : null),
    );
    container.append(pageEl);
  });
}

function a4PageDataUrl(page) {
  if (isA4Canvas(page)) return page.toDataURL('image/png');
  if (page && page.dataUrl) return page.dataUrl;
  if (page && page.canvas) return page.canvas.toDataURL('image/png');
  if (page && Array.isArray(page.ops)) {
    const c = document.createElement('canvas');
    c.width = 1240;
    c.height = 1754;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    drawA4Ops(ctx, page.ops);
    return c.toDataURL('image/png');
  }
  throw new Error('這一頁沒有可下載的圖檔');
}

function bytesToDataUrl(bytes, mime) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  return `data:${mime};base64,${btoa(bin)}`;
}

function publicReportUrl(publicId) {
  return `${location.origin}${location.pathname}${location.search}#/r/${publicId}`;
}

function renderOutputsList(action, outputs, onChanged) {
  const box = h('div', { class: 'outputs-list', 'data-testid': 'outputs-list' });
  if (!outputs.length) {
    box.append(h('p', { class: 'report-stats', text: '尚無產出紀錄' }));
    return box;
  }
  for (const o of outputs) {
    const kindLabel = o.kind === 'a4' ? `A4（${o.format || ''}${o.pageIndex != null ? `・第 ${o.pageIndex + 1} 頁` : ''}）` : '網頁';
    const row = h(
      'div',
      { class: 'output-row' },
      h('span', { class: 'output-kind', text: kindLabel }),
      h('span', { class: 'output-title', text: o.title || '未命名報導' }),
      h('span', { class: 'output-date', text: (o.createdAt || '').slice(0, 10) }),
    );
    const actions = h(
      'div',
      { class: 'output-actions' },
      h('button', { type: 'button', class: 'btn small', text: '查看', 'data-testid': `output-view-${o.id}`, onclick: async () => { try { await viewOutput(action, o); } catch (e) { setStatus('無法查看：' + errorText(e)); } } }),
      h('button', { type: 'button', class: 'btn small', text: '下載', 'data-testid': `output-download-${o.id}`, onclick: async () => { try { await downloadOutput(action, o); setStatus('已開始下載'); } catch (e) { setStatus('無法下載：' + errorText(e)); } } }),
      h('button', { type: 'button', class: 'btn small', text: '以此設定重新生成', 'data-testid': `output-regen-${o.id}`, onclick: () => { sessionStorage.setItem('regen-settings:' + action.id, JSON.stringify(o.settings || {})); location.hash = `#/a/${action.id}/generate`; } }),
    );
    row.append(actions);
    if (o.published && o.publicId) {
      row.append(h('a', { href: publicReportUrl(o.publicId), target: '_blank', rel: 'noopener', text: '公開連結' }));
      row.append(
        h('button', {
          type: 'button',
          class: 'btn small',
          text: '取消發佈',
          onclick: async () => {
            await api.call('outputs.unpublish', { actionId: action.id, outputId: o.id });
            setStatus('已取消發佈');
            await onChanged();
          },
        }),
      );
    }
    box.append(row);
  }
  return box;
}

// ---------- 協作者輸入（一列一位：email＋姓名選填；常用聯絡人點一下加入） ----------
function contactChips({ exclude, onPick, testid = 'contact-chips' }) {
  const box = h('div', { class: 'contact-chips', 'data-testid': testid });
  const draw = () => {
    const used = new Set(exclude());
    const list = (state.contacts || []).filter((c) => !used.has(c.email));
    fill(
      box,
      list.length
        ? list.slice(0, 40).map((c) =>
            h(
              'span',
              { class: 'chip-wrap' },
              h('button', { type: 'button', class: 'pill contact-chip', 'data-contact': c.email, title: c.email, onclick: () => onPick(c) }, '＋ ', c.name ? h('b', { text: c.name }) : null, h('span', { class: 'chip-email', text: c.email })),
              h('button', {
                type: 'button',
                class: 'chip-x',
                'aria-label': `從常用聯絡人刪除 ${c.email}`,
                title: '從常用聯絡人刪除',
                text: '×',
                onclick: async () => {
                  if (!(await confirmDialog(`從常用聯絡人刪除 ${c.name ? `${c.name}（${c.email}）` : c.email}？（不影響已加入的行動）`, { title: '刪除常用聯絡人', testid: 'delete-contact-dialog' }))) return;
                  try {
                    state.contacts = (await api.call('contacts.remove', { email: c.email })).contacts;
                  } catch (e) {
                    setStatus(errorText(e), 'error');
                  }
                  draw();
                },
              }),
            ),
          )
        : h('span', { class: 'hint', text: (state.contacts || []).length ? '常用聯絡人都已加入。' : '加過的協作者會記在這裡，下次點一下就能加入。' }),
    );
  };
  loadContacts().then(draw, () => draw());
  draw();
  return { el: box, draw };
}

function collaboratorEditor(initial = []) {
  const rowsEl = h('div', { class: 'collab-rows', 'data-testid': 'collab-rows' });
  const rows = [];
  const current = () => rows.map((r) => ({ email: Core.normalizeEmail(r.em.value), name: r.nm.value.trim() })).filter((x) => x.email);
  function addRow(email = '', name = '', focus = false) {
    const em = h('input', { type: 'email', name: 'collab-email', placeholder: 'email', autocomplete: 'off', value: email, 'aria-label': '協作者 email' });
    const nm = h('input', { name: 'collab-name', placeholder: '姓名（選填）', maxlength: 40, value: name, 'aria-label': '協作者姓名（選填）' });
    const r = { em, nm };
    r.row = h(
      'div',
      { class: 'collab-row' },
      em,
      nm,
      h('button', {
        type: 'button',
        class: 'btn small',
        text: '移除',
        'aria-label': '移除這一列',
        onclick: () => {
          rows.splice(rows.indexOf(r), 1);
          r.row.remove();
          if (!rows.length) addRow();
          chips.draw();
        },
      }),
    );
    em.addEventListener('change', () => chips.draw());
    rows.push(r);
    rowsEl.append(r.row);
    if (focus) em.focus();
  }
  const chips = contactChips({
    exclude: () => current().map((x) => x.email),
    onPick: (c) => {
      const empty = rows.find((r) => !r.em.value.trim());
      if (empty) {
        empty.em.value = c.email;
        if (!empty.nm.value) empty.nm.value = c.name || '';
      } else addRow(c.email, c.name || '');
      chips.draw();
    },
  });
  for (const x of initial) addRow(x.email, x.name);
  if (!rows.length) addRow();
  const el = h(
    'div',
    { class: 'collab-editor' },
    rowsEl,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', 'data-testid': 'add-collab-row', text: '＋ 再加一位', onclick: () => addRow('', '', true) })),
    h('div', { class: 'contacts-box' }, h('span', { class: 'label', text: '常用聯絡人（點一下加入）' }), chips.el),
  );
  return {
    el,
    get: current,
    /** 有錯回傳錯誤訊息，並把游標移到那一列 */
    validate() {
      for (const r of rows) {
        const v = r.em.value.trim();
        if (v && !Core.isValidEmail(Core.normalizeEmail(v))) {
          r.em.focus();
          return `協作者 email「${v}」格式不正確`;
        }
        if (!v && r.nm.value.trim()) {
          r.em.focus();
          return `請填寫「${r.nm.value.trim()}」的 email`;
        }
      }
      return '';
    },
  };
}

// ---------- 單位／區域（行動裡要分開彙整的單位） ----------
/** 一列一個單位，可上下移動、刪除；一列裡用頓號／逗號分隔也會拆成多個 */
function unitsEditor(initial = [], { hasMaterials = () => false } = {}) {
  const rowsEl = h('div', { class: 'unit-rows', 'data-testid': 'unit-rows' });
  const rows = [];
  const redrawMoves = () =>
    rows.forEach((r, i) => {
      r.up.disabled = i === 0;
      r.down.disabled = i === rows.length - 1;
    });
  function addRow(u = { id: '', name: '' }, focus = false) {
    const name = h('input', { name: 'unit-name', maxlength: 60, placeholder: '例如：北屯區、青職、大專', value: u.name, 'aria-label': '單位名稱' });
    const r = { id: u.id, name };
    const move = (d) => {
      const i = rows.indexOf(r);
      const j = i + d;
      if (j < 0 || j >= rows.length) return;
      rows.splice(i, 1);
      rows.splice(j, 0, r);
      rowsEl.replaceChildren(...rows.map((x) => x.row));
      redrawMoves();
      name.focus();
    };
    r.up = h('button', { type: 'button', class: 'btn small', text: '↑', 'aria-label': '往上移', onclick: () => move(-1) });
    r.down = h('button', { type: 'button', class: 'btn small', text: '↓', 'aria-label': '往下移', onclick: () => move(1) });
    r.row = h(
      'div',
      { class: 'unit-row' },
      name,
      r.up,
      r.down,
      h('button', {
        type: 'button',
        class: 'btn small',
        text: '刪除',
        'aria-label': '刪除這個單位',
        onclick: async () => {
          if (r.id && hasMaterials(r.id) && !(await confirmDialog(`「${name.value}」已經有素材標了這個單位，刪除後那些素材會歸到「全體」。確定刪除？`, { title: '刪除單位', testid: 'delete-unit-dialog' }))) return;
          rows.splice(rows.indexOf(r), 1);
          r.row.remove();
          redrawMoves();
        },
      }),
    );
    // 在最後一列按 Enter：新增下一列
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        if (rows.indexOf(r) === rows.length - 1 && name.value.trim()) addRow(undefined, true);
        else rows[rows.indexOf(r) + 1]?.name.focus();
      }
    });
    rows.push(r);
    rowsEl.append(r.row);
    redrawMoves();
    if (focus) name.focus();
  }
  for (const u of initial) addRow(u);
  const el = h(
    'fieldset',
    { class: 'field units-field', 'data-testid': 'units-editor' },
    h('legend', { class: 'label', text: '單位／區域（選填）' }),
    h('p', { class: 'hint', text: '行動裡要分開彙整的單位，例如各區、各會所或各年齡層。上傳素材時可以選所屬單位，生成報導時會依單位分段，也可以指定 A4 每一頁放哪些單位。不分單位就留空。' }),
    rowsEl,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', 'data-testid': 'add-unit', text: '＋ 新增單位', onclick: () => addRow(undefined, true) })),
  );
  return {
    el,
    get() {
      const out = [];
      for (const r of rows) {
        const parts = r.name.value.split(/[、,，;；\n]+/).map((x) => x.trim()).filter(Boolean);
        parts.forEach((name, k) => out.push(k === 0 && r.id ? { id: r.id, name } : { name }));
      }
      return out;
    },
  };
}

// ---------- 建立／編輯行動 ----------
function actionForm(action, onSubmit, opts = {}) {
  const isSuper = state.me.role === 'super';
  const a = action || { name: '', date: taipeiToday(), endDate: '', place: '', description: '', owners: [], collaborators: [], openSubmission: false, defaults: Core.PRESETS[1] };
  const f = {
    name: h('input', { name: 'name', required: true, maxlength: 100, value: a.name }),
    date: h('input', { name: 'date', type: 'date', lang: 'zh-TW', required: true, value: a.date, oninput: (e) => syncDateHint(e.target, 'date-hint'), onchange: (e) => syncDateHint(e.target, 'date-hint') }),
    endDate: h('input', { name: 'endDate', type: 'date', lang: 'zh-TW', value: a.endDate || '', min: a.date, oninput: (e) => syncDateHint(e.target, 'end-date-hint'), onchange: (e) => syncDateHint(e.target, 'end-date-hint') }),
    dateHint: h('output', { class: 'date-hint', 'data-testid': 'date-hint', text: a.date ? formatDate(a.date) : '' }),
    endDateHint: h('output', { class: 'date-hint', 'data-testid': 'end-date-hint', text: a.endDate ? formatDate(a.endDate) : '' }),
    place: h('input', { name: 'place', maxlength: 100, value: a.place }),
    description: h('textarea', { name: 'description', class: 'short', rows: 3, maxlength: 2000, value: a.description }),
    owners: h('input', { name: 'owners', type: 'text', value: (a.owners || []).join(', '), disabled: !!action && !isSuper }),
    openSubmission: h('input', { type: 'checkbox', name: 'openSubmission', checked: !!a.openSubmission }),
  };
  const collabs = action ? null : collaboratorEditor();
  const units = unitsEditor(a.units || [], { hasMaterials: (id) => (opts.materials || []).some((m) => m.unitId === id) });
  // 這張表單的請求編號：網路重送或重按也只會建立一次（失敗後重送沿用同一個）
  const requestId = action ? null : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const settings = settingsControls(a.defaults);
  const err = h('p', { class: 'errors', role: 'alert' });
  // 負責人：建立者自動成為負責人；只有總管理者可以在行動設定裡更換
  const ownersField = action
    ? isSuper
      ? field('負責人 email（總管理者可更換，用逗號分隔）', f.owners)
      : h('p', { class: 'hint', text: `負責人：${(a.owners || []).join('、')}` })
    : h('p', { class: 'hint', 'data-testid': 'owner-note', text: `建立後您（${state.me.email}）就是這個行動的負責人。` });
  const form = h(
    'form',
    { class: 'panel action-form', 'data-testid': 'action-form' },
    field('行動名稱', f.name),
    h('div', { class: 'row-2' }, field('開始日期', h('div', {}, f.date, f.dateHint)), field('結束日期（選填）', h('div', {}, f.endDate, f.endDateHint), '多天的行動才填，例如 11/4～11/6；一天的行動留空')),
    field('地點', f.place),
    field('說明', f.description),
    units.el,
    ownersField,
    // 協作者：建立時可先填；建立後改到「協作者」頁籤逐一新增／移除
    action
      ? null
      : h(
          'fieldset',
          { class: 'field collaborators-field' },
          h('legend', { class: 'label', text: '共同協作者（選填，一次一位；姓名選填，方便辨認）' }),
          collabs.el,
          h('span', { class: 'hint', text: '名單上的人用 email 驗證碼登入後就能上傳素材；建立後也可以到「協作者」頁籤增減。' }),
        ),
    h('label', { class: 'field checkbox' }, f.openSubmission, h('span', { text: '開放任何登入者投稿（預設關閉）' })),
    h('h2', { text: '報導預設設定' }),
    settings.el,
    err,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: action ? '儲存行動設定' : '建立行動' })),
  );
  // 結束日期不能早於開始日期：改了開始日期就跟著調整可選範圍
  f.date.addEventListener('change', () => {
    f.endDate.min = f.date.value;
    if (f.endDate.value && f.endDate.value < f.date.value) f.endDate.value = '';
    syncDateHint(f.date, 'date-hint');
    syncDateHint(f.endDate, 'end-date-hint');
  });
  guardSubmit(form, async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const data = {
      name: f.name.value,
      date: f.date.value,
      endDate: f.endDate.value && f.endDate.value !== f.date.value ? f.endDate.value : '',
      place: f.place.value,
      description: f.description.value,
      openSubmission: f.openSubmission.checked,
      defaults: settings.get(),
      units: units.get(),
    };
    const seen = new Set();
    for (const u of data.units) {
      const k = u.name.replace(/\s+/g, '').toLowerCase();
      if (u.name.length > 30) {
        err.textContent = `單位名稱「${u.name}」太長（最多 30 字）`;
        return;
      }
      if (seen.has(k)) {
        err.textContent = `單位名稱「${u.name}」重複了`;
        return;
      }
      seen.add(k);
    }
    if (!action) {
      const bad = collabs.validate();
      if (bad) {
        err.textContent = bad;
        return;
      }
      // email 陣列＋另送姓名：舊版後端（version 2）也看得懂 email 陣列
      const list = collabs.get();
      data.collaborators = list.map((x) => x.email);
      data.collaboratorNames = Object.fromEntries(list.filter((x) => x.name).map((x) => [x.email, x.name]));
    }
    // 相容舊版後端（version 1 建立時必填負責人 email）：送出自己的 email；
    // 新版後端一律以登入的 email 為負責人，一般使用者送來的 owners 會被忽略
    if (!action) {
      data.owners = state.me.email;
      data.requestId = requestId;
    }
    if (action && isSuper) data.owners = f.owners.value;
    try {
      await onSubmit(data);
    } catch (e) {
      err.textContent = errorText(e);
    }
  });
  return form;
}

function renderActionForm() {
  fill(view,
    h('h1', { class: 'page-title', text: '建立新行動' }),
    h('hr', { class: 'hairline' }),
    actionForm(null, async (data) => {
      let r;
      try {
        r = await api.call('actions.create', data);
      } catch (e) {
        // 舊版後端（version 1）只有總管理者能建立行動：提示需要重新發佈 Apps Script
        if (e instanceof ApiError && (e.code === 'FORBIDDEN' || e.code === 'BAD_INPUT')) {
          const ping = await api.call('ping').catch(() => null);
          if (ping && Number(ping.version) < 2) throw new ApiError(e.code, `${e.message}（後端仍是舊版 version ${ping.version}，請管理者重新發佈 Apps Script 至 version 2 以上）`);
        }
        throw e;
      }
      invalidate();
      state.contacts = null; // 後端已把協作者記進常用聯絡人
      if (r.duplicate === 'merged') flashStatus(`您已經有同名、同日期的行動「${r.action.name}」，已把這次填的內容更新到那一筆（沒有重複建立）`);
      else flashStatus(`已建立行動「${r.action.name}」`);
      // 新建立的行動還沒有素材：直接放進快取，進入行動頁不必再等一次載入
      if (!r.duplicate) state.actions.set(r.action.id, { data: { action: r.action, materials: [], recordings: [], legacy: false }, at: Date.now() });
      go(`#/a/${r.action.id}`);
    }),
  );
}

// ---------- 管理者 ----------
async function renderAdmin() {
  if (state.me.role !== 'super') {
    fill(view, h('p', { class: 'errors', role: 'alert', text: '只有總管理者可以管理名單。' }));
    return;
  }
  const err = h('p', { class: 'errors', role: 'alert' });
  const body = h('div');
  const draw = (r) => {
    const email = h('input', { type: 'email', name: 'admin-email', required: true });
    const add = h(
      'form',
      { class: 'inline-form' },
      field('新增總管理者 email', email, '總管理者可以查看與管理所有行動。一般人不需要加入名單：登入後就能建立自己的行動。'),
      h('button', { class: 'btn primary', type: 'submit', text: '新增' }),
    );
    guardSubmit(add, async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      try {
        draw(await api.call('admin.add', { email: email.value, role: 'super' }));
      } catch (e) {
        err.textContent = errorText(e);
      }
    });
    const mb = h('input', { type: 'number', name: 'video-max-mb', min: 1, max: 2000, value: String(r.videoMaxMb) });
    const cfg = h('form', { class: 'inline-form' }, field('影片上傳大小上限（MB）', mb), h('button', { class: 'btn', type: 'submit', text: '儲存' }));
    guardSubmit(cfg, async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      try {
        draw(await api.call('config.set', { videoMaxMb: Number(mb.value) }));
        setStatus('已更新影片上限');
      } catch (e) {
        err.textContent = errorText(e);
      }
    });
    fill(body, 
      h(
        'table',
        { class: 'table', 'data-testid': 'admin-table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Email' }), h('th', { text: '角色' }), h('th', { text: '' }))),
        h(
          'tbody',
          {},
          r.admins.map((a) =>
            h(
              'tr',
              {},
              h('td', { text: a.email }),
              h('td', { text: '總管理者' }),
              h(
                'td',
                {},
                a.locked
                  ? h('span', { class: 'hint', text: '固定' })
                  : h('button', {
                      class: 'btn small danger',
                      type: 'button',
                      text: '移除',
                      onclick: async () => {
                        if (!(await confirmDialog(`確定移除 ${a.email}？`, { title: '移除管理者', testid: 'remove-admin-dialog' }))) return;
                        try {
                          draw(await api.call('admin.remove', { email: a.email }));
                        } catch (e) {
                          err.textContent = errorText(e);
                        }
                      },
                    }),
              ),
            ),
          ),
        ),
      ),
      add,
      cfg,
    );
  };
  const aiBox = h('section', { class: 'panel', 'data-testid': 'ai-config' });
  const rulesBox = h('section', { class: 'panel', 'data-testid': 'global-rules' });
  fill(view, h('h1', { class: 'page-title', text: '總管理者名單' }), h('hr', { class: 'hairline' }), err, body, aiBox, rulesBox);
  try {
    draw(await api.call('admin.list'));
  } catch (e) {
    err.textContent = errorText(e);
  }
  renderAiConfig(aiBox);
  renderGlobalRules(rulesBox);
}

/** OpenAI 金鑰與模型（錄音轉逐字稿、AI 修正與彙整）。金鑰只寫不讀：畫面只顯示末 4 碼 */
async function renderAiConfig(box) {
  const err = h('p', { class: 'errors', role: 'alert' });
  const draw = (c) => {
    const key = h('input', { type: 'password', name: 'openai-key', autocomplete: 'off', placeholder: c.hasKey ? `已設定（${c.keyHint}），要更換才填` : 'sk-…' });
    const tm = h('input', { name: 'transcribe-model', value: c.transcribeModel, placeholder: c.defaults?.transcribeModel });
    const cm = h('input', { name: 'chat-model', value: c.chatModel, placeholder: c.defaults?.chatModel });
    const mb = h('input', { type: 'number', name: 'audio-max-mb', min: 1, max: 4000, value: String(c.audioMaxMb) });
    const form = h(
      'form',
      { class: 'ai-form' },
      field('OpenAI API 金鑰', key, c.fake ? '本機／示範模式使用模擬的 AI，不需要金鑰。' : '存在 Apps Script 的指令碼屬性（只有部署者看得到），不會傳到瀏覽器。'),
      h('div', { class: 'row-2' }, field('轉錄模型', tm, `預設 ${c.defaults?.transcribeModel}；whisper-1、gpt-4o-transcribe 將於 2027-02-26 停用。`), field('AI 修正／彙整模型', cm, `預設 ${c.defaults?.chatModel}`)),
      field('錄音檔存到 Drive 的大小上限（MB）', mb),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit', text: '儲存 AI 設定' }),
        c.hasKey
          ? h('button', {
              class: 'btn danger',
              type: 'button',
              text: '刪除金鑰',
              onclick: async () => {
                if (!(await confirmDialog('刪除 OpenAI 金鑰？刪除後無法自動轉錄、AI 修正與彙整。', { title: '刪除金鑰', testid: 'delete-key-dialog' }))) return;
                try {
                  draw(await api.call('ai.config.set', { clearKey: true }));
                  state.me = null;
                } catch (e) {
                  err.textContent = errorText(e);
                }
              },
            })
          : null,
      ),
    );
    guardSubmit(form, async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      try {
        const data = { transcribeModel: tm.value, chatModel: cm.value, audioMaxMb: Number(mb.value) };
        if (key.value.trim()) data.apiKey = key.value.trim();
        draw(await api.call('ai.config.set', data));
        state.me = null; // 重新取得 me（AI 是否可用）
        setStatus('已儲存 AI 設定');
      } catch (e) {
        err.textContent = errorText(e);
      }
    });
    fill(box, h('h2', { text: 'OpenAI 設定（錄音轉逐字稿、AI 修正與彙整）' }), h('p', { 'data-testid': 'ai-status', class: 'hint', text: c.hasKey || c.fake ? '狀態：可以使用' : '狀態：尚未設定金鑰' }), form, err);
  };
  fill(box, h('p', { text: '載入中…' }));
  try {
    draw(await api.call('ai.config.get'));
  } catch (e) {
    fill(box, h('h2', { text: 'OpenAI 設定' }), h('p', { class: 'errors', text: isUnsupported(e) ? '後端尚未更新到 version 3，請重新發佈 Apps Script。' : errorText(e) }));
  }
}

/** 全站逐字稿規則：每個行動都會套用；各行動負責人可在錄音區另外補充 */
async function renderGlobalRules(box) {
  const draw = (r) => {
    const ed = rulesEditor(r.global, {
      h,
      field,
      editable: true,
      testid: 'global-rules-editor',
      onSave: async (rules) => {
        draw(await api.call('rules.set', { scope: 'global', rules }));
        setStatus('已儲存全站逐字稿規則');
      },
      onReset: async () => {
        if (await confirmDialog('把全站規則恢復成預設值？（儲存後才生效）', { title: '恢復預設規則', testid: 'reset-rules-dialog' })) fill(box, title, rulesEditor(r.defaults, { h, field, editable: true, testid: 'global-rules-editor', onSave: async (rules) => draw(await api.call('rules.set', { scope: 'global', rules })) }).el);
      },
    });
    fill(box, title, h('p', { class: 'hint', text: '轉錄、AI 修正與彙整都會用到；可以隨時增修。各行動的負責人另外可以在「素材」頁的錄音區加上只用在該行動的規則。' }), ed.el);
  };
  const title = h('h2', { text: '全站逐字稿規則' });
  fill(box, title, h('p', { text: '載入中…' }));
  try {
    draw(await api.call('rules.get'));
  } catch (e) {
    fill(box, title, h('p', { class: 'errors', text: isUnsupported(e) ? '後端尚未更新到 version 3。' : errorText(e) }));
  }
}

// ---------- 行動頁 ----------
const ACTION_TABS = [
  ['materials', '素材'],
  ['generate', '生成報導'],
  ['outputs', '產出紀錄'],
];
const MANAGER_TABS = [
  ['members', '協作者'],
  ['settings', '行動設定'],
];
/** 載入中的行動頁外框：用首頁列表已有的資料先顯示 */
function actionShell(a, tab) {
  const tabs = a.myRole === 'manager' ? [...ACTION_TABS, ...MANAGER_TABS] : ACTION_TABS;
  return [
    h('nav', { class: 'breadcrumb', 'aria-label': '麵包屑' }, h('a', { href: '#/', text: '我的行動' }), h('span', { class: 'sep', 'aria-hidden': 'true', text: '›' }), h('span', { text: a.name })),
    a.place ? h('p', { class: 'kicker', text: a.place }) : null,
    h('h1', { class: 'article-title', text: a.name }),
    h('dl', { class: 'meta' }, h('div', { class: 'meta-item' }, h('dt', { text: '日期' }), h('dd', { text: formatDateRange(a.date, a.endDate) })), a.place ? h('div', { class: 'meta-item' }, h('dt', { text: '地點' }), h('dd', { text: a.place })) : null),
    h('div', { class: 'app-tabs', role: 'tablist' }, tabs.map(([key, label]) => h('a', { role: 'tab', class: 'tab', href: `#/a/${a.id}/${key}`, 'aria-selected': String(key === tab), 'data-tab': key, text: label }))),
    h('div', { class: 'tab-panel', 'aria-busy': 'true', 'data-testid': 'action-loading' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton short' }), h('p', { class: 'hint', text: '載入素材中…' })),
  ].filter(Boolean);
}
/** 使用者正在輸入或選了檔案：先不要重畫，免得打到一半的內容不見 */
function userBusy() {
  const el = document.activeElement;
  if (el && view.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  if (view.querySelector('form[aria-busy=true], [aria-busy=true] button, .transcribe-progress:not([hidden])')) return true;
  return [...view.querySelectorAll('input[type=file]')].some((f) => f.files && f.files.length);
}
/** 背景更新行動頁：資料有變才重畫；使用者正在輸入時改成顯示「有新資料」按鈕 */
function revalidateAction(id, shown) {
  loadAction(id, { force: true })
    .then((fresh) => {
      const m = ACTION_ROUTE.exec(location.hash || '');
      if (!m || m[1] !== id) return; // 已離開這個行動
      if (JSON.stringify(fresh) === JSON.stringify(shown)) return;
      if (!userBusy()) return renderAction(id, m[2] || 'materials');
      if (view.querySelector('[data-testid=fresh-data]')) return;
      view.prepend(
        h('p', { class: 'notice fresh-data', 'data-testid': 'fresh-data' }, '這個行動有新的資料。', h('button', { type: 'button', class: 'btn small', text: '更新畫面', onclick: () => renderAction(id, (ACTION_ROUTE.exec(location.hash || '') || [])[2] || 'materials') })),
      );
    })
    .catch((e) => {
      if (e.code === 'AUTH_REQUIRED') return sessionExpired();
      if (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND') {
        // 已被移除或行動已刪除：清掉舊資料，重畫會顯示錯誤
        state.actions.delete(id);
        saveSnapshot();
        const m = ACTION_ROUTE.exec(location.hash || '');
        if (m && m[1] === id) renderAction(id, m[2] || 'materials', { force: true });
      }
    });
}
async function renderAction(id, tab, { force = false } = {}) {
  // 切換頁籤時沿用剛載入的資料（不再每次重打兩次後端）；
  // 沒有快取時先畫出外框（標題、日期、頁籤），素材再陸續載入，不讓畫面空白等待
  // 有過期的資料（上次畫面、超過 2 分鐘）：先顯示，背景更新
  const stale = !force && !cachedAction(id) ? staleAction(id) : null;
  if (!stale && (force || !cachedAction(id))) {
    const known = state.actions.get(id)?.data.action || state.home?.list.find((a) => a.id === id);
    fill(view, known ? actionShell(known, tab) : h('p', { class: 'loading', text: '載入中…' }));
  }
  let action;
  let materials;
  let data;
  try {
    data = stale || (await loadAction(id, { force }));
    ({ action, materials } = data);
    if (stale) revalidateAction(id, stale);
  } catch (e) {
    fill(view, h('p', { class: 'errors', role: 'alert', 'data-testid': 'action-error', text: errorText(e) }), h('a', { href: '#/', text: '回我的行動' }));
    return;
  }
  // 頁籤已經換了（使用者在載入中又點了別的）：交給新的那次 route
  if (location.hash && ACTION_ROUTE.exec(location.hash)?.[1] !== id) return;
  const isManager = action.myRole === 'manager';
  const tabs = isManager ? [...ACTION_TABS, ...MANAGER_TABS] : ACTION_TABS;
  const panel = h('div', { class: 'tab-panel' });
  const leaveBtn =
    action.myRole === 'collaborator'
      ? h('button', {
          class: 'btn small',
          type: 'button',
          'data-testid': 'leave-action',
          text: '退出這個行動',
          onclick: async () => {
            if (!(await confirmDialog(`確定退出「${action.name}」？您已上傳的素材會保留給負責人。`, { title: '退出行動', testid: 'leave-action-dialog' }))) return;
            try {
              await api.call('actions.removeCollaborator', { actionId: id, email: state.me.email });
              invalidate();
              state.home = null;
              flashStatus(`已退出「${action.name}」`);
              go('#/');
            } catch (e) {
              setStatus(errorText(e), 'error');
            }
          },
        })
      : null;
  fill(view, 
    h('nav', { class: 'breadcrumb', 'aria-label': '麵包屑' }, h('a', { href: '#/', text: '我的行動' }), h('span', { class: 'sep', 'aria-hidden': 'true', text: '›' }), h('span', { text: action.name })),
    action.place ? h('p', { class: 'kicker', text: action.place }) : null,
    h('h1', { class: 'article-title', text: action.name }),
    h(
      'dl',
      { class: 'meta' },
      h('div', { class: 'meta-item' }, h('dt', { text: '日期' }), h('dd', { text: formatDateRange(action.date, action.endDate) })),
      action.place ? h('div', { class: 'meta-item' }, h('dt', { text: '地點' }), h('dd', { text: action.place })) : null,
      h('div', { class: 'meta-item' }, h('dt', { text: '我的角色' }), h('dd', { 'data-testid': 'my-role', text: ROLE_LABEL[action.myRole] || '' })),
      action.owners && !isManager ? h('div', { class: 'meta-item' }, h('dt', { text: '負責人' }), h('dd', { text: action.owners.join('、') })) : null,
      h('div', { class: 'meta-item' }, h('dt', { text: '素材' }), h('dd', { text: `${materials.length} 筆` })),
    ),
    action.description ? h('p', { class: 'action-desc', text: action.description }) : null,
    leaveBtn,
    h(
      'div',
      { class: 'app-tabs', role: 'tablist' },
      tabs.map(([key, label]) => h('a', { role: 'tab', class: 'tab', href: `#/a/${id}/${key}`, 'aria-selected': String(key === tab), 'data-tab': key, text: label })),
    ),
    panel,
  );
  const reload = () => {
    invalidate();
    return renderAction(id, tab, { force: true });
  };
  if (tab === 'materials') renderMaterials(panel, action, materials, reload, data);
  else if (tab === 'generate') renderGenerate(panel, action, materials);
  else if (tab === 'outputs') renderOutputs(panel, action);
  else if (tab === 'members' && isManager) renderMembers(panel, action);
  else if (tab === 'settings' && isManager)
    panel.append(
      actionForm(action, async (data) => {
        // 一併送出目前的協作者名單：舊版後端（version 1）沒送就會清空名單；新版收到相同名單不影響
        await api.call('actions.update', { ...data, id, collaborators: action.collaborators || [] });
        setStatus('已儲存行動設定');
        reload();
      }, { materials }),
      deleteActionBox(action, materials),
    );
}

/** 刪除行動（例如連點造成的重複行動）：要輸入行動名稱確認；Drive 資料移到垃圾桶，30 天內可救回 */
function deleteActionBox(action, materials) {
  const err = h('p', { class: 'errors', role: 'alert' });
  return h(
    'section',
    { class: 'panel danger-zone', 'data-testid': 'delete-action' },
    h('h2', { text: '刪除這個行動' }),
    h('p', {
      class: 'hint',
      text: `重複建立的行動可以在這裡刪除。${materials.length ? `這個行動有 ${materials.length} 筆素材，會一起刪除。` : '這個行動還沒有素材。'}刪除後協作者也看不到；雲端硬碟中的資料夾（素材試算表、照片、錄音）會移到垃圾桶，30 天內可以從雲端硬碟救回。`,
    }),
    h('button', {
      type: 'button',
      class: 'btn danger',
      'data-testid': 'delete-action-btn',
      text: '刪除這個行動',
      onclick: async () => {
        err.textContent = '';
        const typed = await promptDialog(`確定要刪除「${action.name}」？\n請輸入行動名稱確認：`, { title: '刪除這個行動', defaultValue: '', confirmText: '確認刪除', testid: 'delete-action-dialog' });
        if (typed == null) return;
        try {
          await api.call('actions.delete', { id: action.id, confirmName: typed });
        } catch (e) {
          err.textContent = isUnsupported(e) ? '後端還沒更新，暫時不能刪除行動。' : errorText(e);
          return;
        }
        invalidate();
        if (state.home) state.home.list = state.home.list.filter((x) => x.id !== action.id);
        flashStatus(`已刪除行動「${action.name}」`);
        go('#/');
      },
    }),
    err,
  );
}

// ---------- 協作者（負責人新增／移除共同協作者） ----------
function renderMembers(panel, action) {
  const err = h('p', { class: 'errors', role: 'alert' });
  const body = h('div');
  // 協作者名單改了：行動頁快取更新成新的名單（不必重新載入）
  const remember = (a) => {
    const c = state.actions.get(a.id);
    if (c) c.data.action = a;
    if (state.home) state.home.fresh = false;
  };
  const addOne = async (a, email, name) => {
    err.textContent = '';
    try {
      const r = await api.call('actions.addCollaborator', { actionId: a.id, email, name });
      state.contacts = null;
      await loadContacts().catch(() => {});
      setStatus(`已新增協作者 ${name ? `${name}（${Core.normalizeEmail(email)}）` : Core.normalizeEmail(email)}`);
      remember(r.action);
      draw(r.action);
      return true;
    } catch (e) {
      err.textContent = errorText(e);
      return false;
    }
  };
  const draw = (a) => {
    const names = a.collaboratorNames || {};
    const email = h('input', { type: 'email', name: 'collaborator-email', required: true, autocomplete: 'off', placeholder: 'name@example.com' });
    const name = h('input', { name: 'collaborator-name', maxlength: 40, placeholder: '姓名（選填）' });
    const add = h(
      'form',
      { class: 'inline-form add-collaborator', 'data-testid': 'add-collaborator' },
      field('新增共同協作者 email', email, '對方用這個 email 收驗證碼登入後，「我的行動」就會出現這個行動，可以上傳並編輯自己的素材。'),
      field('姓名（選填，方便辨認）', name),
      h('button', { class: 'btn primary', type: 'submit', text: '新增' }),
    );
    guardSubmit(add, async (ev) => {
      ev.preventDefault();
      await addOne(a, email.value, name.value.trim());
    });
    const chips = contactChips({
      testid: 'member-contact-chips',
      exclude: () => [...(a.owners || []), ...(a.collaborators || [])],
      onPick: (c) => addOne(a, c.email, c.name || ''),
    });
    const rows = [
      ...(a.owners || []).map((e) => ({ email: e, owner: true, name: e === state.me.email ? '（我）' : '' })),
      ...(a.collaborators || []).map((e) => ({ email: e, owner: false, name: names[e] || '' })),
    ];
    fill(body,
      add,
      h('div', { class: 'contacts-box' }, h('span', { class: 'label', text: '常用聯絡人（點一下直接加入這個行動）' }), chips.el),
      h(
        'div',
        { class: 'table-scroll', 'data-testid': 'members-list' },
        h(
          'table',
          { class: 'table', 'data-testid': 'members-table' },
          h('thead', {}, h('tr', {}, h('th', { text: '姓名' }), h('th', { text: 'Email' }), h('th', { text: '權限' }), h('th', { text: '' }))),
          h(
            'tbody',
            {},
            rows.map((r) =>
              h(
                'tr',
                {},
                h('td', { 'data-testid': 'member-name', text: r.name }),
                h('td', { text: r.email }),
                h('td', { text: r.owner ? '負責人（管理行動與協作者）' : '共同協作者（上傳、編輯自己的素材）' }),
                h(
                  'td',
                  { class: 'row-actions' },
                  r.owner
                    ? h('span', { class: 'hint', text: '負責人' })
                    : [
                        h('button', {
                          class: 'btn small',
                          type: 'button',
                          text: '改姓名',
                          'data-testid': `rename-member-${r.email}`,
                          'aria-label': `修改 ${r.email} 的姓名`,
                          onclick: async () => {
                            const n = await promptDialog(`${r.email} 的姓名（選填）`, { title: '改姓名', defaultValue: r.name || '', confirmText: '儲存', testid: 'rename-member-dialog' });
                            if (n == null || !n.trim()) return;
                            await addOne(a, r.email, n.trim());
                          },
                        }),
                        h('button', {
                          class: 'btn small danger',
                          type: 'button',
                          text: '移除',
                          'data-testid': `remove-member-${r.email}`,
                          'aria-label': `移除 ${r.email}`,
                          onclick: async () => {
                            if (!(await confirmDialog(`確定移除協作者 ${r.name ? `${r.name}（${r.email}）` : r.email}？對方已上傳的素材會保留。`, { title: '移除協作者', testid: 'remove-collab-dialog' }))) return;
                            err.textContent = '';
                            try {
                              const next = (await api.call('actions.removeCollaborator', { actionId: a.id, email: r.email })).action;
                              remember(next);
                              draw(next);
                              setStatus(`已移除協作者 ${r.email}`);
                            } catch (e) {
                              err.textContent = errorText(e);
                            }
                          },
                        }),
                      ],
                ),
              ),
            ),
          ),
        ),
      ),
      a.collaborators && a.collaborators.length ? null : h('p', { class: 'empty', text: '還沒有共同協作者。輸入對方的 email 按「新增」，再把這個行動的網址傳給對方。' }),
      h('p', { class: 'hint' }, '行動網址：', h('code', { 'data-testid': 'action-link', text: `${location.origin}${location.pathname}${location.search}#/a/${a.id}` })),
    );
  };
  fill(panel, err, body);
  draw(action);
}

// ---------- 素材 ----------
function draftKey(actionId) {
  return `rpt.draft.${mode}.${actionId}`;
}

function renderMaterials(panel, action, materials, reload, data = {}) {
  const err = h('p', { class: 'errors', role: 'alert' });
  const form = { id: null, photos: [], videos: [] };
  const kind = h('select', { name: 'kind', 'aria-label': '要新增的素材類型' }, h('option', { value: 'report', text: '報導' }), h('option', { value: 'testimony', text: '見證' }));
  // 所屬單位（行動有設定單位才顯示）：空白＝全體
  const units = action.units || [];
  const unitName = (id) => units.find((u) => u.id === id)?.name || '';
  const unit = h(
    'select',
    { name: 'unit', 'aria-label': '所屬單位' },
    h('option', { value: '', text: '全體（總報導）' }),
    units.map((u) => h('option', { value: u.id, text: u.name })),
  );
  const lastUnitKey = `rpt.lastUnit.${action.id}`;
  const lastUnit = () => {
    try {
      const v = localStorage.getItem(lastUnitKey) || '';
      return unitName(v) ? v : '';
    } catch {
      return '';
    }
  };
  // 送出後記住類型：同一類素材可以一篇接一篇新增
  const lastKindKey = `rpt.lastKind.${action.id}`;
  const lastKind = () => {
    try {
      return localStorage.getItem(lastKindKey) === 'testimony' ? 'testimony' : 'report';
    } catch {
      return 'report';
    }
  };
  const title = h('input', { name: 'title', maxlength: 200 });
  const author = h('input', { name: 'author', maxlength: 100 });
  const text = h('textarea', { name: 'text', rows: 8, maxlength: 20000 });
  const photoInput = h('input', { type: 'file', name: 'photos', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  const photoList = h('div', { class: 'image-list', 'data-testid': 'photo-list' });
  const videoUrl = h('input', { name: 'video-url', type: 'url', placeholder: 'https://www.youtube.com/watch?v=…' });
  const videoTitle = h('input', { name: 'video-title', maxlength: 200, placeholder: '影片標題（選填）' });
  const videoFile = h('input', { type: 'file', name: 'video-file', accept: 'video/*' });
  const videoProgress = h('progress', { max: 1, value: 0, hidden: true });
  const videoList = h('ul', { class: 'video-list', 'data-testid': 'video-list' });
  const formTitle = h('h2', { class: 'material-form-title', text: '新增素材' });
  const cancelBtn = h('button', { class: 'btn', type: 'button', hidden: true, text: '取消編輯', onclick: () => resetForm() });

  const saveDraft = () => {
    if (form.id) return;
    try {
      localStorage.setItem(draftKey(action.id), JSON.stringify({ kind: kind.value, unitId: unit.value, title: title.value, author: author.value, text: text.value }));
    } catch {
      /* 忽略 */
    }
  };
  for (const el of [kind, unit, title, author, text]) el.addEventListener('input', saveDraft);

  function drawPhotos() {
    fill(photoList, 
      ...form.photos.map((p, i) => {
        const img = h('img', { alt: '', loading: 'lazy' });
        photoThumbUrl(action.id, p.id).then((u) => (img.src = u)).catch(() => {});
        const cap = h('input', { name: 'caption', maxlength: 300, placeholder: '照片說明（選填）', value: p.caption, oninput: (e) => (p.caption = e.target.value) });
        const cover = h('input', {
          type: 'radio',
          name: 'cover-photo',
          checked: p.cover,
          onchange: () => form.photos.forEach((q, j) => (q.cover = j === i)),
        });
        return h(
          'div',
          { class: 'image-item photo-item' },
          img,
          cap,
          h('label', { class: 'radio' }, cover, '主圖'),
          h('button', {
            class: 'btn small danger',
            type: 'button',
            text: '移除',
            onclick: () => {
              const [gone] = form.photos.splice(i, 1);
              // 移除的是主圖：改由第一張當主圖
              if (gone && gone.cover && form.photos.length) form.photos[0].cover = true;
              drawPhotos();
            },
          }),
        );
      }),
    );
  }
  function drawVideos() {
    fill(videoList, 
      ...form.videos.map((v, i) =>
        h(
          'li',
          {},
          h('span', { text: `${v.kind === 'link' ? '連結' : '已上傳'}：${v.title || v.url || v.fileId}` }),
          v.coverPhotoId ? h('span', { class: 'hint', text: '（已擷取封面）' }) : null,
          h('button', { class: 'btn small danger', type: 'button', text: '移除', onclick: () => (form.videos.splice(i, 1), drawVideos()) }),
        ),
      ),
    );
  }
  function resetForm(m) {
    form.id = m ? m.id : null;
    form.photos = m ? m.photos.map((p) => ({ ...p })) : [];
    form.videos = m ? m.videos.map((v) => ({ ...v })) : [];
    let draft = {};
    if (!m) {
      try {
        draft = JSON.parse(localStorage.getItem(draftKey(action.id)) || '{}');
      } catch {
        draft = {};
      }
    }
    const src = m || draft;
    kind.value = src.kind === 'testimony' || src.kind === 'report' ? src.kind : lastKind();
    unit.value = src.unitId != null && (src.unitId === '' || unitName(src.unitId)) ? src.unitId : m ? '' : lastUnit();
    title.value = src.title || '';
    author.value = src.author || '';
    text.value = src.text || '';
    formTitle.textContent = m ? `編輯素材：${m.title || '未命名素材'}` : '新增素材';
    cancelBtn.hidden = !m;
    err.textContent = '';
    drawPhotos();
    drawVideos();
  }

  photoInput.addEventListener('change', async () => {
    const files = [...photoInput.files];
    photoInput.value = '';
    for (const file of files) {
      try {
        setStatus(`處理照片 ${file.name}…`);
        const r = await resizePhoto(file);
        const up = await api.call('photos.upload', { actionId: action.id, data: r.base64 });
        photos.put(up.photo.id, `data:image/jpeg;base64,${r.base64}`);
        form.photos.push({ id: up.photo.id, caption: '', cover: !form.photos.length });
        drawPhotos();
        setStatus(`已上傳照片（${Math.round(r.bytes / 1024)} KB）`);
      } catch (e) {
        err.textContent = errorText(e);
      }
    }
  });

  const addLink = h('button', {
    class: 'btn',
    type: 'button',
    text: '加入影片連結',
    onclick: () => {
      err.textContent = '';
      const url = videoUrl.value.trim();
      if (!Core.isAllowedVideoUrl(url)) {
        err.textContent = '影片連結只接受 https 的 YouTube（youtube.com／youtu.be）或 Google Drive 網址';
        return;
      }
      form.videos.push({ kind: 'link', url, title: videoTitle.value.trim() });
      videoUrl.value = '';
      videoTitle.value = '';
      drawVideos();
    },
  });

  videoFile.addEventListener('change', async () => {
    const file = videoFile.files[0];
    videoFile.value = '';
    if (!file) return;
    err.textContent = '';
    const maxBytes = state.me.videoMaxMb * 1024 * 1024;
    if (file.size > maxBytes) {
      err.textContent = `影片超過 ${state.me.videoMaxMb}MB 上限，請改貼 YouTube／Google Drive 連結`;
      return;
    }
    try {
      setStatus('擷取影片封面…');
      let coverPhotoId = null;
      const frame = await captureVideoFrame(file);
      if (frame) {
        const up = await api.call('photos.upload', { actionId: action.id, data: frame });
        coverPhotoId = up.photo.id;
        photos.put(coverPhotoId, `data:image/jpeg;base64,${frame}`);
      }
      setStatus('上傳影片中…');
      const sess = await api.call('video.createUpload', { actionId: action.id, name: file.name, mime: file.type || 'video/mp4', size: file.size, origin: location.origin });
      videoProgress.hidden = false;
      const fileId = await api.uploadResumable(sess.uploadUrl, file, (p) => (videoProgress.value = p));
      const done = await api.call('video.complete', { actionId: action.id, fileId });
      form.videos.push({ kind: 'drive', fileId: done.video.fileId, title: videoTitle.value.trim() || file.name, coverPhotoId });
      videoTitle.value = '';
      drawVideos();
      setStatus('影片上傳完成');
    } catch (e) {
      err.textContent = errorText(e);
    } finally {
      videoProgress.hidden = true;
    }
  });

  const editor = h(
    'form',
    { class: 'panel material-form', 'data-testid': 'material-form' },
    // 標題右邊選類型：「新增素材 ［報導 ▾］」
    h(
      'div',
      { class: 'material-form-head' },
      formTitle,
      h(
        'span',
        { class: 'kind-pickers' },
        h('label', { class: 'kind-picker' }, h('span', { class: 'label', text: '類型' }), kind),
        units.length ? h('label', { class: 'kind-picker' }, h('span', { class: 'label', text: '單位' }), unit) : null,
      ),
    ),
    field('作者署名（選填）', author),
    field('標題', title),
    field('文字', text, '可以分段；未送出的文字會暫存在這台裝置，送出後以後端為準。'),
    field('照片（可多張，會縮到最長邊 1600px）', photoInput),
    photoList,
    h('fieldset', { class: 'field' }, h('legend', { class: 'label', text: '影片' }), h('div', { class: 'row-2' }, videoUrl, videoTitle), h('div', { class: 'actions' }, addLink), field(`或上傳影片檔（上限 ${state.me.videoMaxMb}MB）`, videoFile), videoProgress, videoList),
    err,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: '送出素材' }), cancelBtn),
  );
  guardSubmit(editor, async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    try {
      await api.call('materials.save', {
        actionId: action.id,
        id: form.id || undefined,
        kind: kind.value,
        unitId: units.length ? unit.value : undefined,
        title: title.value,
        author: author.value,
        text: text.value,
        photos: form.photos.map((p) => ({ id: p.id, caption: String(p.caption || '').trim(), cover: !!p.cover })),
        videos: form.videos,
      });
      const wasNew = !form.id;
      if (wasNew) localStorage.removeItem(draftKey(action.id));
      try {
        localStorage.setItem(lastKindKey, kind.value);
        localStorage.setItem(lastUnitKey, unit.value);
      } catch {
        /* 忽略 */
      }
      const label = (unitName(unit.value) ? `${unitName(unit.value)}的` : '') + (kind.value === 'testimony' ? '見證' : '報導');
      setStatus(wasNew ? `${label}已儲存，可以接著新增下一篇${label}` : '素材已儲存');
      reload();
    } catch (e) {
      err.textContent = errorText(e);
    }
  });

  /** 「＋ 再新增一篇見證」：表單切到這個類型、捲過去、游標停在標題 */
  const startNew = (k) => {
    resetForm();
    kind.value = k;
    saveDraft();
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    title.focus({ preventScroll: true });
  };
  const KINDS = [
    ['report', '報導'],
    ['testimony', '見證'],
  ];
  const card = (m) => {
          const thumbs = h('div', { class: 'thumbs' });
          for (const p of m.photos) {
            const img = h('img', { alt: p.caption || '', loading: 'lazy', 'data-photo': p.id });
            photoThumbUrl(action.id, p.id).then((u) => (img.src = u)).catch(() => {});
            thumbs.append(img);
          }
          return h(
            'article',
            { class: 'material-card', 'data-material': m.id },
            h('span', { class: 'card-cat', text: m.kind === 'testimony' ? '見證' : '報導' }, units.length ? h('span', { class: 'unit-badge', 'data-testid': 'unit-badge', text: unitName(m.unitId) || '全體' }) : null),
            h('h3', { class: 'material-title', text: m.title || '未命名素材' }),
            m.author ? h('p', { class: 'hint', text: `作者：${m.author}` }) : null,
            m.text ? h('p', { class: 'material-text', text: m.text.length > 240 ? `${m.text.slice(0, 240)}…` : m.text }) : null,
            m.photos.length ? thumbs : null,
            m.videos.length
              ? h(
                  'ul',
                  { class: 'video-list' },
                  m.videos.map((v) => h('li', {}, Core.isAllowedVideoUrl(v.url) ? h('a', { href: v.url, target: '_blank', rel: 'noopener noreferrer', text: `▶ ${v.title || v.url}` }) : h('span', { text: v.title }))),
                )
              : null,
            m.canEdit
              ? h(
                  'div',
                  { class: 'actions' },
                  h('button', { class: 'btn small', type: 'button', text: '編輯', onclick: () => (resetForm(m), editor.scrollIntoView()) }),
                  h('button', {
                    class: 'btn small danger',
                    type: 'button',
                    text: '刪除',
                    'data-testid': `delete-material-${m.id}`,
                    onclick: async () => {
                      if (!(await confirmDialog(`確定刪除「${m.title || '未命名素材'}」？照片與上傳的影片也會一併刪除。`, { title: '刪除素材', testid: 'delete-material-dialog' }))) return;
                      try {
                        await api.call('materials.delete', { actionId: action.id, id: m.id });
                        setStatus('已刪除');
                        reload();
                      } catch (e) {
                        err.textContent = errorText(e);
                      }
                    },
                  }),
                )
              : null,
          );
  };
  // 依類別分組，每組下面都有「＋ 再新增一篇」
  const list = h(
    'div',
    { class: 'material-list', 'data-testid': 'material-list' },
    materials.length
      ? KINDS.map(([k, label]) => {
          const items = materials.filter((m) => (m.kind === 'testimony' ? 'testimony' : 'report') === k);
          return h(
            'section',
            { class: 'material-group', 'data-kind': k, 'data-testid': `material-group-${k}` },
            h('h3', { class: 'material-group-title', text: `${label}（${items.length}）` }),
            items.length ? items.map(card) : h('p', { class: 'hint', text: `還沒有${label}。` }),
            h('button', { type: 'button', class: 'btn add-same-kind', 'data-testid': `add-${k}`, text: `＋ ${items.length ? '再新增一篇' : '新增'}${label}`, onclick: () => startNew(k) }),
          );
        })
      : h('p', { class: 'empty', text: '還沒有素材，用上面的表單上傳第一篇報導或見證吧！' }),
  );
  resetForm();
  const recordings = renderRecordings({
    h,
    fill,
    field,
    api,
    Core,
    state,
    action,
    recordings: data.recordings || [],
    legacy: !!data.legacy,
    setStatus,
    errorText,
    reload,
    download,
    safeFileName,
  });
  fill(panel, editor, recordings, h('h2', { class: 'section-title', text: `已上傳的素材（${materials.length}）` }), list);
}

// ---------- 生成報導 ----------
function renderGenerate(panel, action, materials) {
  const settings = settingsControls(action.defaults);
  let results = { web: null, a4: null };
  let scheduleA4Preview = () => {};
  const summarizers = [ruleBasedSummarizer];
  const configured = createSummarizer(config);
  if (configured !== ruleBasedSummarizer) summarizers.push(configured);
  const sumSelect = h('select', { name: 'summarizer' }, summarizers.map((s, i) => h('option', { value: String(i), text: s.name })));
  // ---- 使用的素材：有單位時依單位分組，每組可以一次全勾／全不勾 ----
  const units = action.units || [];
  const knownUnit = new Set(units.map((u) => u.id));
  const unitKey = (m) => (m.unitId && knownUnit.has(m.unitId) ? m.unitId : '');
  const UNIT_ALL = { id: '', name: '全體' };
  const pickRow = (m) => h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'use-material', value: m.id, 'data-unit': unitKey(m), checked: true }), `${m.kind === 'testimony' ? '［見證］' : '［報導］'}${m.title || '未命名素材'}`);
  const picks = h(
    'fieldset',
    { class: 'field material-picks', 'data-testid': 'pick-materials' },
    h('legend', { class: 'label', text: '使用的素材' }),
    units.length
      ? groupByUnit(materials, units).map((g) => {
          const u = g.unit || UNIT_ALL;
          const all = h('input', { type: 'checkbox', name: 'use-unit', value: u.id, checked: true });
          const box = h('div', { class: 'pick-group', 'data-unit-group': u.id }, h('label', { class: 'checkbox pick-group-head' }, all, h('b', { text: `${u.name}（${g.materials.length}）` })), h('div', { class: 'pick-group-items' }, g.materials.map(pickRow)));
          const items = () => [...box.querySelectorAll('input[name=use-material]')];
          all.addEventListener('change', () => items().forEach((i) => (i.checked = all.checked)));
          box.addEventListener('change', (ev) => {
            if (ev.target === all) return;
            const n = items().filter((i) => i.checked).length;
            all.checked = n === items().length;
            all.indeterminate = n > 0 && n < items().length;
          });
          return box;
        })
      : materials.map(pickRow),
  );

  // ---- A4 頁面安排（有單位才顯示）：自動依單位接續排，或自訂每一頁放哪些單位 ----
  const unitOptions = [UNIT_ALL, ...units].filter((u) => materials.some((m) => unitKey(m) === u.id));
  const plan = []; // plan[i] = Set(unitId)
  const planMode = h('div', { class: 'plan-mode', role: 'radiogroup', 'aria-label': 'A4 頁面安排' });
  const modeAuto = h('input', { type: 'radio', name: 'plan-mode', value: 'auto', checked: true });
  const modeCustom = h('input', { type: 'radio', name: 'plan-mode', value: 'custom' });
  const planRows = h('div', { class: 'plan-rows', 'data-testid': 'plan-rows', hidden: true });
  const planWarn = h('p', { class: 'hint plan-warn', 'data-testid': 'plan-warn' });
  /** 預設：把單位依序平均分到各頁 */
  function defaultPlan(n) {
    const out = Array.from({ length: n }, () => new Set());
    unitOptions.forEach((u, i) => out[Math.min(n - 1, Math.floor((i * n) / Math.max(unitOptions.length, 1)))].add(u.id));
    // 頁數比單位多：多出來的頁接著放最後一組
    for (let i = 0; i < n; i++) if (!out[i].size && unitOptions.length) out[i].add(unitOptions[Math.min(i, unitOptions.length - 1)].id);
    return out;
  }
  function drawPlan() {
    const n = Math.max(1, Number(settings.get().pages) || 1);
    if (plan.length !== n) {
      const def = defaultPlan(n);
      plan.length = n;
      for (let i = 0; i < n; i++) if (!plan[i]) plan[i] = def[i];
    }
    fill(
      planRows,
      plan.map((sel, i) =>
        h(
          'div',
          { class: 'plan-row', 'data-page': String(i + 1) },
          h('span', { class: 'plan-page', text: `第 ${i + 1} 頁` }),
          h(
            'span',
            { class: 'plan-chips' },
            unitOptions.map((u) =>
              h(
                'label',
                { class: `plan-chip${sel.has(u.id) ? ' on' : ''}`, 'data-unit': u.id },
                h('input', {
                  type: 'checkbox',
                  name: `plan-${i + 1}`,
                  value: u.id,
                  checked: sel.has(u.id),
                  onchange: (ev) => {
                    if (ev.target.checked) sel.add(u.id);
                    else sel.delete(u.id);
                    scheduleA4Preview();
                    drawPlan();
                  },
                }),
                u.name,
              ),
            ),
          ),
        ),
      ),
    );
    // 提醒：哪一頁沒選、哪個單位沒放到任何一頁
    const empty = plan.map((s2, i) => (s2.size ? null : i + 1)).filter(Boolean);
    const placed = new Set(plan.flatMap((s2) => [...s2]));
    const missing = unitOptions.filter((u) => !placed.has(u.id)).map((u) => u.name);
    planWarn.textContent = [empty.length ? `第 ${empty.join('、')} 頁還沒選單位` : '', missing.length ? `「${missing.join('、')}」沒有放在任何一頁` : ''].filter(Boolean).join('；');
  }
  const syncMode = () => {
    planRows.hidden = !modeCustom.checked;
    planWarn.hidden = !modeCustom.checked;
    if (modeCustom.checked) drawPlan();
  };
  modeAuto.addEventListener('change', syncMode);
  modeCustom.addEventListener('change', syncMode);
  fill(
    planMode,
    h('label', { class: 'checkbox' }, modeAuto, h('span', { text: '自動排版：依單位順序接續排（全體在前，每個單位有標題）' })),
    h('label', { class: 'checkbox' }, modeCustom, h('span', { text: '自訂每一頁放哪些單位（可複選）' })),
  );
  const planBox = unitOptions.length > 1 ? h('fieldset', { class: 'field plan-box', 'data-testid': 'plan-box' }, h('legend', { class: 'label', text: 'A4 頁面安排' }), planMode, planRows, planWarn) : null;
  const err = h('p', { class: 'errors', role: 'alert', 'data-testid': 'report-error' });
  const stats = h('p', { class: 'report-stats', 'data-testid': 'report-stats' });
  const wordHint = h('p', { class: 'hint warning', 'data-testid': 'word-count-hint', hidden: true });
  const frame = h('iframe', { class: 'preview-frame', title: '報導預覽', sandbox: '', 'data-testid': 'report-preview' });
  const a4Info = h('p', { class: 'report-stats', 'data-testid': 'a4-stats' });
  const a4Pages = h('div', { class: 'a4-pages', 'data-testid': 'a4-pages' });
  const publicLink = h('a', { class: 'public-link', target: '_blank', rel: 'noopener', hidden: true, 'data-testid': 'public-link' });
  const outputsBox = h('div', { 'data-testid': 'outputs-box' });
  const fileBase = () => safeFileName(`${action.date}-${action.name}`);
  let mode = 'web';

  const tabWeb = h('button', { type: 'button', class: 'tab active', role: 'tab', 'aria-selected': 'true', 'data-testid': 'tab-web', text: '網頁報導' });
  const tabA4 = h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', 'data-testid': 'tab-a4', text: 'A4 圖檔' });
  const tabs = h('div', { class: 'mode-tabs', role: 'tablist', 'aria-label': '生成模式' }, tabWeb, tabA4);
  const webPanel = h('div', { class: 'mode-panel mode-web', 'data-testid': 'panel-web' });
  const a4Panel = h('div', { class: 'mode-panel mode-a4', hidden: true, 'data-testid': 'panel-a4' });

  const showPublicLink = (publicId) => {
    if (!publicId) {
      publicLink.hidden = true;
      return;
    }
    publicLink.href = publicReportUrl(publicId);
    publicLink.textContent = publicLink.href;
    publicLink.hidden = false;
  };
  const invalidateAll = () => {
    results = { web: null, a4: null };
    frame.removeAttribute('srcdoc');
    stats.textContent = '';
    wordHint.hidden = true;
    a4Info.textContent = '';
    fill(a4Pages);
    publicLink.hidden = true;
  };
  const setMode = (next) => {
    mode = next;
    const isWeb = next === 'web';
    tabWeb.classList.toggle('active', isWeb);
    tabA4.classList.toggle('active', !isWeb);
    tabWeb.setAttribute('aria-selected', String(isWeb));
    tabA4.setAttribute('aria-selected', String(!isWeb));
    webPanel.hidden = !isWeb;
    a4Panel.hidden = isWeb;
    if (isWeb) {
      if (results.web) {
        frame.srcdoc = results.web.html;
        stats.textContent = results.web.statsText || '';
        showPublicLink(results.web.publicId);
      }
    } else if (results.a4) {
      a4Info.textContent = results.a4.statsText || '';
      renderA4Preview(a4Pages, results.a4);
    }
  };
  tabWeb.addEventListener('click', () => setMode('web'));
  tabA4.addEventListener('click', () => setMode('a4'));
  applyRegenSettings(settings, action);

  const selected = () => {
    const ids = [...picks.querySelectorAll('input[name=use-material]:checked')].map((i) => i.value);
    return materials.filter((m) => ids.includes(m.id));
  };
  const summarizer = () => summarizers[Number(sumSelect.value) || 0];
  const guard = (fn) => async () => {
    err.textContent = '';
    try {
      if (!selected().length) throw new Error('請至少勾選一筆素材');
      await fn();
    } catch (e) {
      err.textContent = errorText(e);
    }
  };

  async function imagesFor(comp) {
    const images = {};
    for (const it of comp.images) images[it.name] = await photoDataUrl(action.id, it.photoId);
    return images;
  }

  async function generateWeb() {
    const s = settings.get();
    const chosen = selected();
    const allVideos = [];
    chosen.forEach((m) => {
      (m.videos || []).forEach((v, i) => allVideos.push({ materialId: m.id, materialTitle: m.title || '未命名素材', video: v, key: `${m.id}:${i}` }));
    });
    let videoKeep = null;
    if (allVideos.length > s.maxVideos) {
      videoKeep = await askPickVideos(allVideos, s.maxVideos);
      if (!videoKeep) { setStatus('已取消生成'); return; }
    }
    setStatus('生成網頁報導中…');
    const comp = await composeReport({ action, materials: chosen, settings: s, summarizer: summarizer(), videoKeep });
    const html = renderStandalone({ slug: '', data: comp.data, body: blocksToMarkdown(comp.blocks) }, { md, css: await getCss(), images: await imagesFor(comp), layout: s.layout });
    const omittedVideos = allVideos.length - comp.stats.videos;
    const omittedText = omittedVideos > 0 ? `・已省略 ${omittedVideos} 支影片` : '';
    results.web = {
      html,
      comp,
      settings: s,
      outputId: results.web?.outputId || null,
      publicId: results.web?.publicId || null,
      statsText: `字數 ${comp.stats.chars}（目標 ${comp.stats.target}）・照片 ${comp.stats.photos} 張（上限 ${comp.stats.maxPhotos}）・影片 ${comp.stats.videos} 部（上限 ${comp.stats.maxVideos}）${omittedText}`,
    };
    frame.srcdoc = html;
    const st = comp.stats;
    stats.dataset.chars = String(st.chars);
    stats.dataset.photos = String(st.photos);
    stats.dataset.videos = String(st.videos);
    stats.textContent = results.web.statsText;
    if (st.target > 0 && st.chars < st.target / 2) {
      wordHint.textContent = `目標字數是上限，不會自動補寫；目前素材只有 ${st.chars} 字，可再補素材。`;
      wordHint.hidden = false;
    } else {
      wordHint.hidden = true;
    }
    showPublicLink(results.web.publicId);
    setStatus('已生成網頁報導，可預覽、下載、存回後端或發佈到網站');
  }

  function applyA4Result(res, s, metaLine) {
    const title = res.comp?.data?.title || res.comps?.[0]?.data?.title || action.name;
    const statsText = `A4 共 ${res.pages} 頁（設定 ${s.pages} 頁，1240×1754 px）${res.truncated ? '・篇幅超過，已再節錄並註明「全文見網頁版」' : ''}・字級縮放 ${Math.round(res.scale * 100)}%`;
    results.a4 = {
      pages: res.canvases.map((c) => ({ canvas: c })),
      canvases: res.canvases,
      settings: s,
      title,
      metaLine,
      comp: res.comp || (res.comps ? { cover: res.comps[0].cover, blocks: res.comps.flatMap((c) => c.blocks) } : null),
      outputId: results.a4?.outputId || null,
      statsText,
      truncated: res.truncated,
      scale: res.scale,
      fileBase: fileBase(),
    };
    const used = results.a4.comp;
    a4Info.dataset.pages = String(res.pages);
    a4Info.dataset.videos = String((used?.blocks || []).filter((b) => b.type === 'video').length);
    a4Info.dataset.photoIds = [used?.cover?.photoId, ...(used?.blocks || []).filter((b) => b.type === 'figure').map((b) => b.photoId)].filter(Boolean).join(',');
    a4Info.textContent = statsText;
    renderA4Preview(a4Pages, results.a4);
  }

  function quickLayoutPreview(s) {
    if (!results.a4 || !results.a4.comp) return false;
    try {
      const laid = previewLayout(
        {
          data: results.a4.comp.data,
          metaLine: results.a4.metaLine || '',
          cover: results.a4.comp.cover,
          blocks: (results.a4.comp.blocks || []).filter((b) => b.type !== 'video'),
          layout: s.layout,
          scale: results.a4.scale || 1,
          measure: measurePreviewText,
          imageSize: () => null,
          header: true,
        },
        s.layout,
      );
      a4Info.textContent = `正在套用「${layoutNames[s.layout] || s.layout}」…`;
      renderA4Preview(a4Pages, { pages: laid.pages, title: results.a4.title, fileBase: fileBase() });
      return true;
    } catch {
      return false;
    }
  }

  async function generateA4() {
    const s = settings.get();
    setStatus('生成 A4 圖檔中…');
    const mats = selected();
    const metaLine = [formatDateRange(action.date, action.endDate), action.place ? `地點：${action.place}` : '', `作者：${[...new Set(mats.map((m) => m.author).filter(Boolean))].join('、') || '行動報導小組'}`].filter(Boolean).join('　');
    const loadImage = async (photoId) => loadImg(await photoDataUrl(action.id, photoId));
    let res;
    if (planBox && modeCustom.checked) {
      drawPlan();
      const pagesMats = plan.map((sel) => mats.filter((m) => sel.has(unitKey(m))));
      const bad = pagesMats.map((list, i) => (list.length ? null : i + 1)).filter(Boolean);
      if (bad.length) throw new Error(`第 ${bad.join('、')} 頁選的單位沒有勾選的素材，請在「A4 頁面安排」調整，或勾選那些單位的素材`);
      res = await renderA4Plan({
        settings: s,
        metaLine,
        loadImage,
        plan: pagesMats.map((list) => ({
          compose: ({ words, maxPhotos, note, header }) => composeReport({ action, materials: list, settings: { ...s, maxPhotos }, summarizer: summarizer(), words, note, print: true, noCover: !header }),
        })),
      });
      res.comp = { cover: res.comps[0].cover, blocks: res.comps.flatMap((c) => c.blocks), data: res.comps[0].data };
    } else {
      res = await renderA4({
        settings: s,
        metaLine,
        compose: ({ words, maxPhotos, note }) => composeReport({ action, materials: mats, settings: { ...s, maxPhotos }, summarizer: summarizer(), words, note, print: true }),
        loadImage,
      });
    }
    applyA4Result(res, s, metaLine);
    setStatus(`已生成 A4 圖檔（${layoutNames[s.layout] || s.layout}）`);
  }

  async function buildPdfBytes() {
    if (!results.a4?.canvases?.length) await generateA4();
    setStatus('產生 PDF 中…');
    const pages = [];
    for (const c of results.a4.canvases) pages.push({ jpeg: await canvasToJpegBytes(c, 0.9), width: c.width, height: c.height });
    return { bytes: buildPdf(pages), pages };
  }

  async function downloadPdf() {
    const { bytes, pages } = await buildPdfBytes();
    download(new Blob([bytes], { type: 'application/pdf' }), `${fileBase()}.pdf`);
    setStatus(`已下載 PDF（${pages.length} 頁）`);
  }

  async function refreshOutputs() {
    const res = await api.call('outputs.list', { actionId: action.id });
    fill(outputsBox, renderOutputsList(action, res.outputs || [], refreshOutputs));
  }

  let previewTimer = 0;
  let previewGen = 0;
  scheduleA4Preview = (immediate) => {
    if (modeCustom.checked) drawPlan();
    const s = settings.get();
    if (results.a4) quickLayoutPreview(s);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const n = ++previewGen;
      guard(async () => {
        await generateA4();
        if (n !== previewGen) return;
      })();
    }, immediate ? 80 : 280);
  };

  for (const el of [settings.el, picks, sumSelect]) {
    el.addEventListener('input', invalidateAll);
    el.addEventListener('change', invalidateAll);
  }
  settings.el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-preset]')) {
      invalidateAll();
      setTimeout(() => modeCustom.checked && drawPlan(), 0);
    }
  });
  settings.a4El.addEventListener('input', (ev) => {
    if (ev.target && ev.target.name === 'pages') {
      if (modeCustom.checked) drawPlan();
      if (mode === 'a4' || results.a4) scheduleA4Preview(false);
    }
  });
  settings.layoutGroup.addEventListener('change', () => {
    if (mode === 'a4' || results.a4) scheduleA4Preview(true);
  });
  modeAuto.addEventListener('change', () => { if (mode === 'a4' || results.a4) scheduleA4Preview(false); });
  modeCustom.addEventListener('change', () => { if (mode === 'a4' || results.a4) scheduleA4Preview(false); });

  fill(
    webPanel,
    h(
      'div',
      { class: 'actions generate-actions' },
      h('button', { class: 'btn primary', type: 'button', 'data-testid': 'gen-web', text: '一鍵生成網頁報導', onclick: guard(generateWeb) }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-testid': 'download-html',
        text: '下載單一 HTML',
        onclick: () => {
          err.textContent = '';
          if (!results.web) {
            guard(async () => {
              await generateWeb();
              download(new Blob([results.web.html], { type: 'text/html;charset=utf-8' }), `${fileBase()}.html`);
            })();
            return;
          }
          download(new Blob([results.web.html], { type: 'text/html;charset=utf-8' }), `${fileBase()}.html`);
        },
      }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-testid': 'save-output',
        text: '存回後端',
        onclick: guard(async () => {
          if (!results.web) await generateWeb();
          const res = await api.call('outputs.save', { actionId: action.id, kind: 'web', format: 'html', title: results.web.comp.data.title, html: results.web.html, settings: results.web.settings, chars: results.web.comp.stats.chars, photos: results.web.comp.stats.photos });
          results.web.outputId = res.output.id;
          setStatus('已存回後端（記在產出紀錄）');
          await refreshOutputs();
        }),
      }),
      h('button', {
        class: 'btn primary',
        type: 'button',
        'data-testid': 'publish-output',
        text: '發佈到網站',
        onclick: guard(async () => {
          if (!results.web) await generateWeb();
          const res = await api.call('outputs.publish', { actionId: action.id, outputId: results.web.outputId || null, title: results.web.comp.data.title, html: results.web.html, settings: results.web.settings, chars: results.web.comp.stats.chars, photos: results.web.comp.stats.photos });
          results.web.outputId = res.output.id;
          results.web.publicId = res.publicId;
          showPublicLink(res.publicId);
          setStatus('已發佈到網站');
          await refreshOutputs();
        }),
      }),
      publicLink,
    ),
    stats,
    wordHint,
    frame,
  );
  fill(
    a4Panel,
    settings.a4El,
    planBox,
    h(
      'div',
      { class: 'actions generate-actions' },
      h('button', { class: 'btn primary', type: 'button', 'data-testid': 'gen-a4', text: '一鍵生成 A4 圖檔', onclick: guard(generateA4) }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-testid': 'download-png',
        text: '下載 PNG',
        onclick: guard(async () => {
          if (!results.a4) await generateA4();
          results.a4.pages.forEach((page, i) => {
            const dataUrl = a4PageDataUrl(page);
            download(new Blob([Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0))], { type: 'image/png' }), `${fileBase()}-p${i + 1}.png`);
          });
        }),
      }),
      h('button', { class: 'btn', type: 'button', 'data-testid': 'download-pdf', text: '下載 PDF', onclick: guard(downloadPdf) }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-testid': 'save-a4-png',
        text: '存回後端（PNG）',
        onclick: guard(async () => {
          if (!results.a4) await generateA4();
          const res = await api.call('outputs.save', { actionId: action.id, kind: 'a4', format: 'png', title: results.a4.title || action.name, settings: results.a4.settings, pages: results.a4.pages.length, dataUrls: results.a4.pages.map(a4PageDataUrl) });
          results.a4.outputId = (res.outputs || [res.output])[0].id;
          setStatus('A4 PNG 已存回後端（記在產出紀錄）');
          await refreshOutputs();
        }),
      }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-testid': 'save-a4-pdf',
        text: '存回後端（PDF）',
        onclick: guard(async () => {
          const { bytes } = await buildPdfBytes();
          const dataUrl = bytesToDataUrl(bytes, 'application/pdf');
          const res = await api.call('outputs.save', { actionId: action.id, kind: 'a4', format: 'pdf', title: results.a4.title || action.name, settings: results.a4.settings, pages: results.a4.pages.length, dataUrl });
          results.a4.outputId = res.output.id;
          setStatus('A4 PDF 已存回後端（記在產出紀錄）');
          await refreshOutputs();
        }),
      }),
    ),
    a4Info,
    a4Pages,
  );
  fill(
    panel,
    h('section', { class: 'panel', 'data-testid': 'generate-form' }, h('h2', { text: '報導設定' }), settings.el, field('文字節錄方式', sumSelect), picks),
    tabs,
    webPanel,
    a4Panel,
    err,
    h('section', { class: 'panel' }, h('h2', { text: '產出紀錄' }), outputsBox),
  );
  // 產出紀錄在「產出」頁籤載入；這裡只在存回後更新，避免切換頁籤多打一次後端。
}


// ---------- 產出紀錄 ----------
async function renderOutputs(panel, action) {
  fill(panel, h('p', { text: '載入中…' }));
  try {
    const list = (await api.call('outputs.list', { actionId: action.id })).outputs;
      fill(panel, 
      list.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'table', 'data-testid': 'outputs-table' },
              h('thead', {}, h('tr', {}, ['時間', '類型', '標題', '設定', '字數', '照片', '建立者', '公開', '操作'].map((t) => h('th', { text: t })))),
              h(
                'tbody',
                {},
                list.map((o) => {
                  const kindLabel = o.kind === 'a4' ? `A4（${o.format || ''}${o.pageIndex != null ? `・第 ${o.pageIndex + 1} 頁` : ''}）` : '網頁';
                  return h(
                    'tr',
                    {},
                    h('td', { text: taipeiTime(o.createdAt) }),
                    h('td', { text: kindLabel }),
                    h('td', { text: o.title }),
                    h('td', { text: `${(o.settings || {}).words || 0}字／${(o.settings || {}).maxPhotos || 0}圖／${(o.settings || {}).pages || 0}頁／${layoutNames[(o.settings || {}).layout] || ''}` }),
                    h('td', { text: String(o.chars) }),
                    h('td', { text: String(o.photos) }),
                    h('td', { text: o.createdBy }),
                    h('td', {}, o.published && o.publicId ? h('a', { href: publicReportUrl(o.publicId), target: '_blank', rel: 'noopener', text: '公開連結' }) : h('span', { text: '—' })),
                    h('td', { class: 'output-actions' },
                      h('button', { type: 'button', class: 'btn small', text: '查看', 'data-testid': `outputs-view-${o.id}`, onclick: async () => { try { await viewOutput(action, o); } catch (e) { setStatus('無法查看：' + errorText(e)); } } }),
                      h('button', { type: 'button', class: 'btn small', text: '下載', 'data-testid': `outputs-download-${o.id}`, onclick: async () => { try { await downloadOutput(action, o); setStatus('已開始下載'); } catch (e) { setStatus('無法下載：' + errorText(e)); } } }),
                      h('button', { type: 'button', class: 'btn small', text: '以此設定重新生成', 'data-testid': `outputs-regen-${o.id}`, onclick: () => { sessionStorage.setItem('regen-settings:' + action.id, JSON.stringify(o.settings || {})); location.hash = `#/a/${action.id}/generate`; } }),
                    ),
                  );
                }),
              ),
            ),
          )
        : h('p', { class: 'empty', text: '還沒有存回後端的報導。在「生成報導」按「存回後端」後會記在這裡（檔案存在該行動的 Drive 資料夾）。' }),
    );
  } catch (e) {
    fill(panel, h('p', { class: 'errors', role: 'alert', text: errorText(e) }));
  }
}

window.addEventListener('hashchange', route);
route();
