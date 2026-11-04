// 行動報導協作平台（單頁應用，hash 路由）
//   #/            我的行動（未登入時顯示 Email 驗證碼登入）
//   #/new         建立行動（總管理者）
//   #/admin       管理者名單與設定（總管理者）
//   #/a/<id>[/materials|generate|outputs|settings]  行動報導協作頁
// 所有畫面用 DOM API 建立（textContent），不使用 innerHTML。

import { ApiError, createApi, detectMode } from './api.mjs?v=970ad7e4e1';
import { captureVideoFrame, resizePhoto } from './media.mjs?v=970ad7e4e1';
import { blocksToMarkdown, composeReport } from '../report/compose.mjs?v=970ad7e4e1';
import { createSummarizer, ruleBasedSummarizer } from '../report/summarizer.mjs?v=970ad7e4e1';
import { canvasToJpegBytes, renderA4 } from '../report/a4.mjs?v=970ad7e4e1';
import { buildPdf } from '../report/pdf.mjs?v=970ad7e4e1';
import { createMarkdown, formatDate, renderStandalone } from '../render.mjs?v=970ad7e4e1';
import { createTour } from './tour.mjs?v=970ad7e4e1';

const root = document.getElementById('app');
const config = JSON.parse(root.dataset.config || '{}');
const mode = detectMode(location.search, config);
const autoDemo = mode === 'demo' && new URLSearchParams(location.search).get('demo') !== '1';
const md = createMarkdown(globalThis.markdownit);
const Core = globalThis.RptCore;
const api = createApi({ mode, config, onDemoMail: (to, code) => showDemoCode(to, code) });
const state = { me: null, photoCache: new Map() };
const tour = createTour({
  api,
  mode,
  getMe: () => state.me,
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
const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

async function getCss() {
  if (cssText == null) cssText = await (await fetch(new URL('../styles.css?v=970ad7e4e1', import.meta.url))).text();
  return cssText;
}

async function photoDataUrl(actionId, photoId) {
  if (state.photoCache.has(photoId)) return state.photoCache.get(photoId);
  const res = await api.call('photos.get', { actionId, id: photoId });
  const url = `data:${res.photo.mime};base64,${res.photo.data}`;
  state.photoCache.set(photoId, url);
  return url;
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
        state.me.role === 'super' ? h('span', { class: 'role-badge', text: '總管理者' }) : state.me.role === 'event' ? h('span', { class: 'role-badge', text: '行動負責人' }) : null,
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
  state.photoCache.clear();
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
  if (!state.me) {
    try {
      state.me = await api.call('me');
    } catch (err) {
      if (err.code === 'AUTH_REQUIRED') {
        renderBar();
        return renderLogin();
      }
      renderBar();
      fill(view, h('p', { class: 'errors', role: 'alert', text: errorText(err) }));
      return;
    }
  }
  renderBar();
  tour.maybeStart();
  const hash = location.hash || '#/';
  let m;
  if (hash === '#/' || hash === '#') return renderHome();
  if (hash === '#/new') return renderActionForm(null);
  if (hash === '#/admin') return renderAdmin();
  if ((m = /^#\/a\/([A-Za-z0-9_-]+)(?:\/(materials|generate|outputs|settings))?$/.exec(hash))) return renderAction(m[1], m[2] || 'materials');
  fill(view, h('p', { text: '找不到這個頁面。' }), h('a', { href: '#/', text: '回首頁' }));
}

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
      go('#/');
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
    h('section', { class: 'panel login' }, h('h1', { class: 'page-title', text: '登入' }), h('p', { text: '台中市召會行動報導協作平台：管理者建立行動，協作者上傳報導與見證，一鍵生成網頁報導與 A4 圖檔。' }), emailForm, codeForm, err),
  );
}

// ---------- 首頁：我的行動 ----------
async function renderHome() {
  fill(view, h('p', { text: '載入中…' }));
  let list;
  try {
    list = (await api.call('actions.list')).actions;
  } catch (e) {
    fill(view, h('p', { class: 'errors', role: 'alert', text: errorText(e) }));
    return;
  }
  const isSuper = state.me.role === 'super';
  const roleLabel = { manager: '負責人', collaborator: '協作者', contributor: '開放投稿' };
  fill(view, 
    h('div', { class: 'section-head' }, h('h1', { class: 'page-title', text: '我的行動' }), isSuper ? h('span', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/new', text: '建立行動' }), h('a', { class: 'btn', href: '#/admin', text: '管理者名單' })) : null),
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
                h('span', { class: 'card-cat', text: roleLabel[a.myRole] || '' }),
                h('h2', { class: 'card-title', text: a.name }),
                h('span', { class: 'card-date', text: `${formatDate(a.date)}${a.place ? `｜${a.place}` : ''}` }),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty', text: '目前沒有您可以參與的行動。若您是協作者，請確認負責人已把您的 email 加入名單。' }),
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

// ---------- 建立／編輯行動 ----------
function actionForm(action, onSubmit) {
  const isSuper = state.me.role === 'super';
  const a = action || { name: '', date: new Date().toISOString().slice(0, 10), place: '', description: '', owners: [], collaborators: [], openSubmission: false, defaults: Core.PRESETS[1] };
  const f = {
    name: h('input', { name: 'name', required: true, maxlength: 100, value: a.name }),
    date: h('input', { name: 'date', type: 'date', required: true, value: a.date }),
    place: h('input', { name: 'place', maxlength: 100, value: a.place }),
    description: h('textarea', { name: 'description', class: 'short', rows: 3, maxlength: 2000, value: a.description }),
    owners: h('input', { name: 'owners', type: 'text', value: (a.owners || []).join(', '), disabled: !!action && !isSuper }),
    collaborators: h('textarea', { name: 'collaborators', class: 'short', rows: 3, value: (a.collaborators || []).join('\n') }),
    openSubmission: h('input', { type: 'checkbox', name: 'openSubmission', checked: !!a.openSubmission }),
  };
  const settings = settingsControls(a.defaults);
  const err = h('p', { class: 'errors', role: 'alert' });
  const form = h(
    'form',
    { class: 'panel action-form', 'data-testid': 'action-form' },
    field('行動名稱', f.name),
    h('div', { class: 'row-2' }, field('日期', f.date), field('地點', f.place)),
    field('說明', f.description),
    field('負責人 email（行動負責人，可多個，用逗號分隔）', f.owners, action && !isSuper ? '只有總管理者可以更換負責人' : '負責人會自動成為「行動負責人」，只能管理被指派的行動'),
    field('協作者 email 名單（一行一個或用逗號分隔）', f.collaborators, '名單上的人用 email 驗證碼登入後就能上傳素材'),
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
      collaborators: f.collaborators.value,
      openSubmission: f.openSubmission.checked,
      defaults: settings.get(),
    };
    if (!action || isSuper) data.owners = f.owners.value;
    try {
      await onSubmit(data);
    } catch (e) {
      err.textContent = errorText(e);
    }
  });
  return form;
}

function renderActionForm() {
  if (state.me.role !== 'super') {
    fill(view, h('p', { class: 'errors', role: 'alert', text: '只有總管理者可以建立行動。' }));
    return;
  }
  fill(view, 
    h('h1', { class: 'page-title', text: '建立行動' }),
    h('hr', { class: 'hairline' }),
    actionForm(null, async (data) => {
      const r = await api.call('actions.create', data);
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
    const role = h('select', { name: 'admin-role' }, h('option', { value: 'event', text: '行動負責人（只能管自己被指派的行動）' }), h('option', { value: 'super', text: '總管理者' }));
    const add = h('form', { class: 'inline-form' }, field('新增管理者 email', email), field('角色', role), h('button', { class: 'btn primary', type: 'submit', text: '新增' }));
    add.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      try {
        draw(await api.call('admin.add', { email: email.value, role: role.value }));
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
              h('td', { text: a.role === 'super' ? '總管理者' : '行動負責人' }),
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
  fill(view, h('h1', { class: 'page-title', text: '管理者名單' }), h('hr', { class: 'hairline' }), err, body);
  try {
    draw(await api.call('admin.list'));
  } catch (e) {
    err.textContent = errorText(e);
  }
}

// ---------- 行動頁 ----------
async function renderAction(id, tab) {
  fill(view, h('p', { text: '載入中…' }));
  let action;
  let materials;
  try {
    const list = (await api.call('actions.list')).actions;
    action = list.find((a) => a.id === id);
    if (!action) throw new ApiError('FORBIDDEN', '找不到這個行動，或您不是這個行動的協作者。');
    materials = (await api.call('materials.list', { actionId: id })).materials;
  } catch (e) {
    fill(view, h('p', { class: 'errors', role: 'alert', 'data-testid': 'action-error', text: errorText(e) }), h('a', { href: '#/', text: '回我的行動' }));
    return;
  }
  const isManager = action.myRole === 'manager';
  const tabs = [
    ['materials', '素材'],
    ['generate', '生成報導'],
    ['outputs', '產出紀錄'],
  ];
  if (isManager) tabs.push(['settings', '行動設定']);
  const panel = h('div', { class: 'tab-panel' });
  fill(view, 
    h('nav', { class: 'breadcrumb', 'aria-label': '麵包屑' }, h('a', { href: '#/', text: '我的行動' }), h('span', { class: 'sep', 'aria-hidden': 'true', text: '›' }), h('span', { text: action.name })),
    action.place ? h('p', { class: 'kicker', text: action.place }) : null,
    h('h1', { class: 'article-title', text: action.name }),
    h(
      'dl',
      { class: 'meta' },
      h('div', { class: 'meta-item' }, h('dt', { text: '日期' }), h('dd', { text: formatDate(action.date) })),
      action.place ? h('div', { class: 'meta-item' }, h('dt', { text: '地點' }), h('dd', { text: action.place })) : null,
      h('div', { class: 'meta-item' }, h('dt', { text: '我的角色' }), h('dd', { text: { manager: '負責人／管理者', collaborator: '協作者', contributor: '開放投稿' }[action.myRole] })),
      h('div', { class: 'meta-item' }, h('dt', { text: '素材' }), h('dd', { text: `${materials.length} 筆` })),
    ),
    action.description ? h('p', { class: 'action-desc', text: action.description }) : null,
    h(
      'div',
      { class: 'app-tabs', role: 'tablist' },
      tabs.map(([key, label]) => h('a', { role: 'tab', class: 'tab', href: `#/a/${id}/${key}`, 'aria-selected': String(key === tab), 'data-tab': key, text: label })),
    ),
    panel,
  );
  const reload = () => renderAction(id, tab);
  if (tab === 'materials') renderMaterials(panel, action, materials, reload);
  else if (tab === 'generate') renderGenerate(panel, action, materials);
  else if (tab === 'outputs') renderOutputs(panel, action);
  else if (tab === 'settings' && isManager)
    panel.append(
      actionForm(action, async (data) => {
        await api.call('actions.update', { ...data, id });
        setStatus('已儲存行動設定');
        reload();
      }),
    );
}

// ---------- 素材 ----------
function draftKey(actionId) {
  return `rpt.draft.${mode}.${actionId}`;
}

function renderMaterials(panel, action, materials, reload) {
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
        photoDataUrl(action.id, p.id).then((u) => (img.src = u)).catch(() => {});
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
          h('button', { class: 'btn small danger', type: 'button', text: '移除', onclick: () => (form.photos.splice(i, 1), drawPhotos()) }),
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
        state.photoCache.set(up.photo.id, `data:image/jpeg;base64,${r.base64}`);
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
        state.photoCache.set(coverPhotoId, `data:image/jpeg;base64,${frame}`);
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
            photoDataUrl(action.id, p.id).then((u) => (img.src = u)).catch(() => {});
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
  fill(panel, editor, h('h2', { class: 'section-title', text: `已上傳的素材（${materials.length}）` }), list);
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
                  h('td', { text: o.createdAt.replace('T', ' ').slice(0, 16) }),
                  h('td', { text: o.title }),
                  h('td', { text: `${o.settings.words}字／${o.settings.maxPhotos}圖／${o.settings.pages}頁／${layoutNames[o.settings.layout] || ''}` }),
                  h('td', { text: String(o.chars) }),
                  h('td', { text: String(o.photos) }),
                  h('td', { text: o.createdBy }),
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
