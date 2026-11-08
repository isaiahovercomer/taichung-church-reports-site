// 行動報導協作平台（單頁應用，hash 路由）
//   #/            我的行動（未登入時顯示 Email 驗證碼登入）
//   #/new         建立行動（任何登入者；建立者就是負責人）
//   #/admin       總管理者名單與設定（總管理者）
//   #/a/<id>[/materials|generate|outputs|members|settings]  行動報導協作頁（members／settings 只給負責人）
// 所有畫面用 DOM API 建立（textContent），不使用 innerHTML。

import { ApiError, createApi, detectMode } from './api.mjs?v=dafa651415';
import { captureVideoFrame, resizePhoto } from './media.mjs?v=dafa651415';
import { blocksToMarkdown, composeReport } from '../report/compose.mjs?v=dafa651415';
import { createSummarizer, ruleBasedSummarizer } from '../report/summarizer.mjs?v=dafa651415';
import { canvasToJpegBytes, renderA4 } from '../report/a4.mjs?v=dafa651415';
import { buildPdf } from '../report/pdf.mjs?v=dafa651415';
import { createMarkdown, formatDate, renderStandalone } from '../render.mjs?v=dafa651415';
import { createTour } from './tour.mjs?v=dafa651415';
import { createPhotoLoader } from './photos.mjs?v=dafa651415';
import { renderRecordings, rulesEditor } from './recordings.mjs?v=dafa651415';

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
const state = { me: null, action: null, home: null, contacts: null };
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
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  if (value != null) el.value = value;
  return el;
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
  if (cssText == null) cssText = await (await fetch(new URL('../styles.css?v=dafa651415', import.meta.url))).text();
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
  state.action = { id, data, at: Date.now() };
  return data;
}
async function loadAction(id, { force = false } = {}) {
  const c = state.action;
  if (!force && c && c.id === id && Date.now() - c.at < ACTION_TTL) return c.data;
  return fetchAction(id);
}
/** 資料改了：清掉快取，下次重新載入 */
function invalidate() {
  state.action = null;
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
  demoBox.textContent = `示範模式不會真的寄信：寄給 ${to} 的驗證碼是 ${code}`;
}

function renderBar() {
  const badge =
    mode === 'demo'
      ? h('span', { class: 'mode-badge', 'data-testid': 'mode-badge', text: `示範模式${autoDemo ? '・尚未設定後端' : ''}（資料只在這個分頁，重新整理就清空）` })
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
  state.me = null;
  state.action = null;
  state.home = null;
  state.contacts = null;
  await photos.clear();
  tour.reset();
  go('#/');
}

// ---------- 路由 ----------
async function route() {
  setStatus('');
  if (!api.configured) {
    renderBar();
    fill(view, 
      h('section', { class: 'panel' }, h('h1', { class: 'page-title', text: '尚未設定後端' }), h('p', { text: '請在 site.config.json 填入 Apps Script 網頁應用程式網址（apiUrl）後重新建置。也可以在網址後面加上 ?demo=1 試用示範模式。' })),
    );
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
function renderLogin() {
  const err = h('p', { class: 'errors', role: 'alert' });
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', value: mode === 'demo' ? 'demo@example.com' : '' });
  const code = h('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '\\d{6}', required: true });
  const codeForm = h(
    'form',
    { class: 'login-step', hidden: true, 'data-testid': 'code-form' },
    field('驗證碼（6 位數）', code, '請到信箱收信，10 分鐘內有效；輸入錯誤 5 次需重新索取。'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: '登入' }), h('button', { class: 'btn', type: 'button', text: '換一個 email', onclick: () => ((codeForm.hidden = true), (emailForm.hidden = false)) })),
  );
  const emailForm = h(
    'form',
    { class: 'login-step', 'data-testid': 'email-form' },
    field('Email', email, '我們會寄一組 6 位數驗證碼給您，不需要密碼。'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: '寄送驗證碼' })),
  );
  emailForm.addEventListener('submit', async (ev) => {
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
  codeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    try {
      const r = await api.call('auth.verifyCode', { email: email.value, code: code.value });
      api.setToken(r.token);
      state.me = null;
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
    h('section', { class: 'panel login' }, h('h1', { class: 'page-title', text: '登入' }), h('p', { text: '台中市召會行動報導協作平台：任何人用 email 登入後都能建立自己的行動、邀請共同協作者上傳報導與見證，一鍵生成網頁報導與 A4 圖檔。' }), emailForm, codeForm, err),
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
      return;
    }
    try {
      const fresh = await fetchHome();
      state.home.fresh = false;
      if (location.hash && location.hash !== '#/' && location.hash !== '#') return; // 已離開首頁
      if (JSON.stringify(fresh) !== JSON.stringify(cached.list)) drawHome(fresh);
    } catch {
      /* 背景更新失敗：保留畫面 */
    }
    return;
  }
  fill(view, h('p', { text: '載入中…' }));
  try {
    drawHome(await fetchHome());
  } catch (e) {
    fill(view, h('p', { class: 'errors', role: 'alert', text: errorText(e) }));
  }
}
function drawHome(list) {
  const isSuper = state.me.role === 'super';
  fill(view,
    h(
      'div',
      { class: 'section-head' },
      h('h1', { class: 'page-title', text: '我的行動' }),
      h('span', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/new', text: '建立新行動' }), isSuper ? h('a', { class: 'btn', href: '#/admin', text: '總管理者名單' }) : null),
    ),
    h('hr', { class: 'hairline' }),
    list.length
      ? h(
          'div',
          { class: 'card-grid action-list', 'data-testid': 'action-list' },
          list.map((a) =>
            h(
              'a',
              { class: 'card action-card', href: `#/a/${a.id}` },
              h(
                'span',
                { class: 'card-text' },
                h('span', { class: 'card-cat', text: ROLE_LABEL[a.myRole] || '' }),
                h('h2', { class: 'card-title', text: a.name }),
                h('span', { class: 'card-date', text: `${formatDate(a.date)}${a.place ? `｜${a.place}` : ''}` }),
              ),
            ),
          ),
        )
      : h(
          'div',
          { class: 'empty', 'data-testid': 'empty-actions' },
          h('p', { text: '您還沒有任何行動。按「建立新行動」開始，您就是這個行動的負責人，可以再邀請共同協作者一起上傳素材。' }),
          h('p', { class: 'hint', text: '若您是受邀的協作者，請確認負責人已把您的 email 加入協作者名單。' }),
          h('p', {}, h('a', { class: 'btn primary', href: '#/new', text: '建立新行動' })),
        ),
  );
}

// ---------- 報導設定控制項 ----------
function settingsControls(initial) {
  const me = state.me;
  const s = Core.normalizeSettings(initial);
  const ranges = me.ranges;
  const wrap = h('div', { class: 'settings', 'data-testid': 'settings' });
  const group = `layout-${++uid}`;
  const inputs = {};
  const labels = { words: ['字數', (v) => `${v} 字`], maxPhotos: ['照片張數上限', (v) => `${v} 張`], maxVideos: ['影片數上限', (v) => `${v} 部`], pages: ['A4 頁數', (v) => `${v} 頁`] };
  const rows = Object.keys(labels).map((key) => {
    const r = ranges[key];
    const out = h('output', { class: 'range-value', 'data-testid': `out-${key}` });
    const input = h('input', { type: 'range', name: key, min: r.min, max: r.max, step: r.step, value: String(s[key]), 'aria-label': labels[key][0] });
    const sync = () => (out.textContent = labels[key][1](input.value));
    input.addEventListener('input', sync);
    sync();
    inputs[key] = { input, sync };
    return h('label', { class: 'field range-row' }, h('span', { class: 'label', text: labels[key][0] }), input, out);
  });
  const layoutNames = { classic: '經典單欄', alternate: '圖文交錯', columns: '雙欄專題' };
  const layoutGroup = h(
    'fieldset',
    { class: 'field layout-choice' },
    h('legend', { class: 'label', text: '版面樣式' }),
    me.layouts.map((l) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: group, value: l, checked: s.layout === l, 'data-layout': l }), layoutNames[l] || l)),
  );
  const apply = (p) => {
    for (const key of Object.keys(inputs)) {
      inputs[key].input.value = String(p[key]);
      inputs[key].sync();
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
  wrap.append(presets, ...rows, layoutGroup);
  return {
    el: wrap,
    get() {
      const out = {};
      for (const key of Object.keys(inputs)) out[key] = Number(inputs[key].input.value);
      const checked = layoutGroup.querySelector('input[type=radio]:checked');
      out.layout = checked ? checked.value : 'classic';
      return Core.normalizeSettings(out);
    },
  };
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
                  if (!confirm(`從常用聯絡人刪除 ${c.name ? `${c.name}（${c.email}）` : c.email}？（不影響已加入的行動）`)) return;
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

// ---------- 建立／編輯行動 ----------
function actionForm(action, onSubmit) {
  const isSuper = state.me.role === 'super';
  const a = action || { name: '', date: taipeiToday(), place: '', description: '', owners: [], collaborators: [], openSubmission: false, defaults: Core.PRESETS[1] };
  const f = {
    name: h('input', { name: 'name', required: true, maxlength: 100, value: a.name }),
    date: h('input', { name: 'date', type: 'date', required: true, value: a.date }),
    place: h('input', { name: 'place', maxlength: 100, value: a.place }),
    description: h('textarea', { name: 'description', class: 'short', rows: 3, maxlength: 2000, value: a.description }),
    owners: h('input', { name: 'owners', type: 'text', value: (a.owners || []).join(', '), disabled: !!action && !isSuper }),
    openSubmission: h('input', { type: 'checkbox', name: 'openSubmission', checked: !!a.openSubmission }),
  };
  const collabs = action ? null : collaboratorEditor();
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
    h('div', { class: 'row-2' }, field('日期', f.date), field('地點', f.place)),
    field('說明', f.description),
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
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const data = {
      name: f.name.value,
      date: f.date.value,
      place: f.place.value,
      description: f.description.value,
      openSubmission: f.openSubmission.checked,
      defaults: settings.get(),
    };
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
    if (!action) data.owners = state.me.email;
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
      setStatus(`已建立行動「${r.action.name}」`);
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
    add.addEventListener('submit', async (ev) => {
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
    cfg.addEventListener('submit', async (ev) => {
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
                        if (!confirm(`確定移除 ${a.email}？`)) return;
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
                if (!confirm('刪除 OpenAI 金鑰？刪除後無法自動轉錄、AI 修正與彙整。')) return;
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
    form.addEventListener('submit', async (ev) => {
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
      onReset: () => {
        if (confirm('把全站規則恢復成預設值？（儲存後才生效）')) fill(box, title, rulesEditor(r.defaults, { h, field, editable: true, testid: 'global-rules-editor', onSave: async (rules) => draw(await api.call('rules.set', { scope: 'global', rules })) }).el);
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
async function renderAction(id, tab, { force = false } = {}) {
  // 切換頁籤時沿用剛載入的資料（不再每次重打兩次後端）
  const c = state.action;
  if (force || !c || c.id !== id || Date.now() - c.at >= ACTION_TTL) fill(view, h('p', { text: '載入中…' }));
  let action;
  let materials;
  let data;
  try {
    data = await loadAction(id, { force });
    ({ action, materials } = data);
  } catch (e) {
    fill(view, h('p', { class: 'errors', role: 'alert', 'data-testid': 'action-error', text: errorText(e) }), h('a', { href: '#/', text: '回我的行動' }));
    return;
  }
  // 頁籤已經換了（使用者在載入中又點了別的）：交給新的那次 route
  if (location.hash && ACTION_ROUTE.exec(location.hash)?.[1] !== id) return;
  const isManager = action.myRole === 'manager';
  const tabs = [
    ['materials', '素材'],
    ['generate', '生成報導'],
    ['outputs', '產出紀錄'],
  ];
  if (isManager) tabs.push(['members', '協作者'], ['settings', '行動設定']);
  const panel = h('div', { class: 'tab-panel' });
  const leaveBtn =
    action.myRole === 'collaborator'
      ? h('button', {
          class: 'btn small',
          type: 'button',
          'data-testid': 'leave-action',
          text: '退出這個行動',
          onclick: async () => {
            if (!confirm(`確定退出「${action.name}」？您已上傳的素材會保留給負責人。`)) return;
            try {
              await api.call('actions.removeCollaborator', { actionId: id, email: state.me.email });
              invalidate();
              state.home = null;
              setStatus(`已退出「${action.name}」`);
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
      h('div', { class: 'meta-item' }, h('dt', { text: '日期' }), h('dd', { text: formatDate(action.date) })),
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
      }),
    );
}

// ---------- 協作者（負責人新增／移除共同協作者） ----------
function renderMembers(panel, action) {
  const err = h('p', { class: 'errors', role: 'alert' });
  const body = h('div');
  // 協作者名單改了：行動頁快取更新成新的名單（不必重新載入）
  const remember = (a) => {
    if (state.action && state.action.id === a.id) state.action.data.action = a;
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
    add.addEventListener('submit', async (ev) => {
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
        { class: 'table-scroll' },
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
                          'aria-label': `修改 ${r.email} 的姓名`,
                          onclick: async () => {
                            const n = prompt(`${r.email} 的姓名（選填）`, r.name);
                            if (n == null || !n.trim()) return;
                            await addOne(a, r.email, n.trim());
                          },
                        }),
                        h('button', {
                          class: 'btn small danger',
                          type: 'button',
                          text: '移除',
                          'aria-label': `移除 ${r.email}`,
                          onclick: async () => {
                            if (!confirm(`確定移除協作者 ${r.name ? `${r.name}（${r.email}）` : r.email}？對方已上傳的素材會保留。`)) return;
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
  const kind = h('select', { name: 'kind' }, h('option', { value: 'report', text: '報導' }), h('option', { value: 'testimony', text: '見證' }));
  const title = h('input', { name: 'title', maxlength: 200, required: true });
  const author = h('input', { name: 'author', maxlength: 100 });
  const text = h('textarea', { name: 'text', rows: 8, maxlength: 20000 });
  const photoInput = h('input', { type: 'file', name: 'photos', accept: 'image/jpeg,image/png,image/webp', multiple: true });
  const photoList = h('div', { class: 'image-list', 'data-testid': 'photo-list' });
  const videoUrl = h('input', { name: 'video-url', type: 'url', placeholder: 'https://www.youtube.com/watch?v=…' });
  const videoTitle = h('input', { name: 'video-title', maxlength: 200, placeholder: '影片標題（選填）' });
  const videoFile = h('input', { type: 'file', name: 'video-file', accept: 'video/*' });
  const videoProgress = h('progress', { max: 1, value: 0, hidden: true });
  const videoList = h('ul', { class: 'video-list', 'data-testid': 'video-list' });
  const formTitle = h('h2', { text: '新增素材' });
  const cancelBtn = h('button', { class: 'btn', type: 'button', hidden: true, text: '取消編輯', onclick: () => resetForm() });

  const saveDraft = () => {
    if (form.id) return;
    try {
      localStorage.setItem(draftKey(action.id), JSON.stringify({ kind: kind.value, title: title.value, author: author.value, text: text.value }));
    } catch {
      /* 忽略 */
    }
  };
  for (const el of [kind, title, author, text]) el.addEventListener('input', saveDraft);

  function drawPhotos() {
    fill(photoList, 
      ...form.photos.map((p, i) => {
        const img = h('img', { alt: '', loading: 'lazy' });
        photoThumbUrl(action.id, p.id).then((u) => (img.src = u)).catch(() => {});
        const cap = h('input', { name: 'caption', maxlength: 300, placeholder: '圖說（選填，有圖說的照片會優先選用）', value: p.caption, oninput: (e) => (p.caption = e.target.value) });
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
    kind.value = src.kind === 'testimony' ? 'testimony' : 'report';
    title.value = src.title || '';
    author.value = src.author || '';
    text.value = src.text || '';
    formTitle.textContent = m ? `編輯素材：${m.title}` : '新增素材';
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
    formTitle,
    h('div', { class: 'row-2' }, field('類型', kind), field('作者署名（選填）', author)),
    field('標題', title),
    field('文字', text, '可以分段；未送出的文字會暫存在這台裝置，送出後以後端為準。'),
    field('照片（可多張，會縮到最長邊 1600px）', photoInput),
    photoList,
    h('fieldset', { class: 'field' }, h('legend', { class: 'label', text: '影片' }), h('div', { class: 'row-2' }, videoUrl, videoTitle), h('div', { class: 'actions' }, addLink), field(`或上傳影片檔（上限 ${state.me.videoMaxMb}MB）`, videoFile), videoProgress, videoList),
    err,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit', text: '送出素材' }), cancelBtn),
  );
  editor.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    try {
      await api.call('materials.save', {
        actionId: action.id,
        id: form.id || undefined,
        kind: kind.value,
        title: title.value,
        author: author.value,
        text: text.value,
        photos: form.photos.map((p) => ({ id: p.id, caption: p.caption, cover: !!p.cover })),
        videos: form.videos,
      });
      if (!form.id) localStorage.removeItem(draftKey(action.id));
      setStatus('素材已儲存');
      reload();
    } catch (e) {
      err.textContent = errorText(e);
    }
  });

  const list = h(
    'div',
    { class: 'material-list', 'data-testid': 'material-list' },
    materials.length
      ? materials.map((m) => {
          const thumbs = h('div', { class: 'thumbs' });
          for (const p of m.photos) {
            const img = h('img', { alt: p.caption || '', loading: 'lazy', 'data-photo': p.id });
            photoThumbUrl(action.id, p.id).then((u) => (img.src = u)).catch(() => {});
            thumbs.append(img);
          }
          return h(
            'article',
            { class: 'material-card', 'data-material': m.id },
            h('span', { class: 'card-cat', text: m.kind === 'testimony' ? '見證' : '報導' }),
            h('h3', { class: 'material-title', text: m.title }),
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
                    onclick: async () => {
                      if (!confirm(`確定刪除「${m.title}」？照片與上傳的影片也會一併刪除。`)) return;
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
  const summarizers = [ruleBasedSummarizer];
  const configured = createSummarizer(config);
  if (configured !== ruleBasedSummarizer) summarizers.push(configured);
  const sumSelect = h('select', { name: 'summarizer' }, summarizers.map((s, i) => h('option', { value: String(i), text: s.name })));
  const picks = h(
    'fieldset',
    { class: 'field material-picks' },
    h('legend', { class: 'label', text: '使用的素材' }),
    materials.map((m) => h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'use-material', value: m.id, checked: true }), `${m.kind === 'testimony' ? '［見證］' : '［報導］'}${m.title}`)),
  );
  const err = h('p', { class: 'errors', role: 'alert' });
  const stats = h('p', { class: 'report-stats', 'data-testid': 'report-stats' });
  const frame = h('iframe', { class: 'preview-frame', title: '報導預覽', sandbox: '', 'data-testid': 'report-preview' });
  const a4Info = h('p', { class: 'report-stats', 'data-testid': 'a4-stats' });
  const a4Pages = h('div', { class: 'a4-pages', 'data-testid': 'a4-pages' });
  let last = null; // { html, comp, settings }
  let lastA4 = null;
  // 改了設定、素材勾選或節錄方式後，「下載 HTML／存回後端／下載 PDF」要重新生成，不能沿用舊結果
  const invalidate = () => {
    last = null;
    lastA4 = null;
  };
  for (const el of [settings.el, picks, sumSelect]) {
    el.addEventListener('input', invalidate);
    el.addEventListener('change', invalidate);
  }
  settings.el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-preset]')) invalidate();
  });

  const selected = () => {
    const ids = [...picks.querySelectorAll('input:checked')].map((i) => i.value);
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
    setStatus('生成網頁報導中…');
    const comp = await composeReport({ action, materials: selected(), settings: s, summarizer: summarizer() });
    const html = renderStandalone({ slug: '', data: comp.data, body: blocksToMarkdown(comp.blocks) }, { md, css: await getCss(), images: await imagesFor(comp), layout: s.layout });
    frame.srcdoc = html;
    last = { html, comp, settings: s };
    const st = comp.stats;
    stats.dataset.chars = String(st.chars);
    stats.dataset.photos = String(st.photos);
    stats.dataset.videos = String(st.videos);
    stats.textContent = `字數 ${st.chars}（目標 ${st.target}）・照片 ${st.photos} 張（上限 ${st.maxPhotos}）・影片 ${st.videos} 部（上限 ${st.maxVideos}）`;
    setStatus('已生成網頁報導，可預覽、下載或存回後端');
  }

  async function generateA4() {
    const s = settings.get();
    setStatus('生成 A4 圖檔中…');
    const mats = selected();
    const res = await renderA4({
      settings: s,
      metaLine: [formatDate(action.date), action.place ? `地點：${action.place}` : '', `作者：${[...new Set(mats.map((m) => m.author).filter(Boolean))].join('、') || '行動報導小組'}`].filter(Boolean).join('　'),
      compose: ({ words, maxPhotos, note }) => composeReport({ action, materials: mats, settings: { ...s, maxPhotos }, summarizer: summarizer(), words, note, print: true }),
      loadImage: async (photoId) => loadImg(await photoDataUrl(action.id, photoId)),
    });
    lastA4 = { canvases: res.canvases, settings: s };
    const base = safeFileName(`${action.date}-${action.name}`);
    fill(a4Pages, 
      ...res.canvases.map((c, i) => {
        const url = c.toDataURL('image/png');
        return h(
          'figure',
          { class: 'a4-page' },
          h('img', { src: url, alt: `第 ${i + 1} 頁`, 'data-page': String(i + 1) }),
          h('figcaption', {}, h('a', { href: url, download: `${base}-p${i + 1}.png`, class: 'btn small', 'data-testid': `png-${i + 1}`, text: `下載第 ${i + 1} 頁 PNG` })),
        );
      }),
    );
    a4Info.dataset.pages = String(res.pages);
    // A4／PDF 不放影片：供檢查用（影片區塊數應為 0、用到的照片不含影片封面）
    a4Info.dataset.videos = String(res.comp.blocks.filter((b) => b.type === 'video').length);
    a4Info.dataset.photoIds = [res.comp.cover?.photoId, ...res.comp.blocks.filter((b) => b.type === 'figure').map((b) => b.photoId)].filter(Boolean).join(',');
    a4Info.textContent = `A4 共 ${res.pages} 頁（設定 ${s.pages} 頁，1240×1754 px）${res.truncated ? '・篇幅超過，已再節錄並註明「全文見網頁版」' : ''}・字級縮放 ${Math.round(res.scale * 100)}%`;
    setStatus('已生成 A4 圖檔');
  }

  async function downloadPdf() {
    if (!lastA4) await generateA4();
    setStatus('產生 PDF 中…');
    const pages = [];
    for (const c of lastA4.canvases) pages.push({ jpeg: await canvasToJpegBytes(c, 0.9), width: c.width, height: c.height });
    download(new Blob([buildPdf(pages)], { type: 'application/pdf' }), `${safeFileName(`${action.date}-${action.name}`)}.pdf`);
    setStatus(`已下載 PDF（${pages.length} 頁）`);
  }

  fill(panel, 
    h('section', { class: 'panel' }, h('h2', { text: '報導設定' }), settings.el, field('文字節錄方式', sumSelect), picks),
    h(
      'div',
      { class: 'actions generate-actions' },
      h('button', { class: 'btn primary', type: 'button', 'data-testid': 'gen-web', text: '一鍵生成網頁報導', onclick: guard(generateWeb) }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-testid': 'download-html',
        text: '下載單一 HTML',
        onclick: guard(async () => {
          if (!last) await generateWeb();
          download(new Blob([last.html], { type: 'text/html;charset=utf-8' }), `${safeFileName(`${action.date}-${action.name}`)}.html`);
        }),
      }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-testid': 'save-output',
        text: '存回後端',
        onclick: guard(async () => {
          if (!last) await generateWeb();
          await api.call('outputs.save', { actionId: action.id, title: last.comp.data.title, html: last.html, settings: last.settings, chars: last.comp.stats.chars, photos: last.comp.stats.photos });
          setStatus('已存回後端（記在產出紀錄）');
        }),
      }),
      h('button', { class: 'btn primary', type: 'button', 'data-testid': 'gen-a4', text: '一鍵生成 A4 圖檔', onclick: guard(generateA4) }),
      h('button', { class: 'btn', type: 'button', 'data-testid': 'download-pdf', text: '下載 PDF', onclick: guard(downloadPdf) }),
    ),
    err,
    stats,
    frame,
    a4Info,
    a4Pages,
  );
}

// ---------- 產出紀錄 ----------
async function renderOutputs(panel, action) {
  fill(panel, h('p', { text: '載入中…' }));
  try {
    const list = (await api.call('outputs.list', { actionId: action.id })).outputs;
    const layoutNames = { classic: '經典單欄', alternate: '圖文交錯', columns: '雙欄專題' };
    fill(panel, 
      list.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'table', 'data-testid': 'outputs-table' },
              h('thead', {}, h('tr', {}, ['時間', '標題', '設定', '字數', '照片', '建立者'].map((t) => h('th', { text: t })))),
              h(
                'tbody',
                {},
                list.map((o) =>
                  h(
                    'tr',
                    {},
                    h('td', { text: taipeiTime(o.createdAt) }),
                    h('td', { text: o.title }),
                    h('td', { text: `${o.settings.words}字／${o.settings.maxPhotos}圖／${o.settings.pages}頁／${layoutNames[o.settings.layout] || ''}` }),
                    h('td', { text: String(o.chars) }),
                    h('td', { text: String(o.photos) }),
                    h('td', { text: o.createdBy }),
                  ),
                ),
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
