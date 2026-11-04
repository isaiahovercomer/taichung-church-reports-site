// 報導編輯器（瀏覽器端）。排版與網站共用 render.mjs／styles.css，預覽＝成品。
// 安全：使用者輸入只經 textContent 或 render.mjs 的跳脫；預覽放在 sandbox iframe（不允許腳本）。

import yaml from './vendor/js-yaml.mjs';
import { strToU8, zipSync } from './vendor/fflate.mjs';
import {
  SLUG_RE,
  findImageRefs,
  isValidDate,
  makeSlug,
  sanitizeImageName,
  sanitizeSlug,
  serializeReport,
  validateFrontMatter,
} from './content.mjs';
import { createMarkdown, renderStandalone } from './render.mjs';

const DRAFT_KEY = 'tc-report-draft-v1';
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

await import('./vendor/markdown-it.min.js');
const md = createMarkdown(globalThis.markdownit);

const $ = (id) => document.getElementById(id);
const root = $('editor');
const siteUrl = root.dataset.siteUrl || '';
const fields = {
  title: $('f-title'),
  kicker: $('f-kicker'),
  date: $('f-date'),
  category: $('f-category'),
  hall: $('f-hall'),
  author: $('f-author'),
  summary: $('f-summary'),
  cover_caption: $('f-cover-caption'),
};
const slugInput = $('f-slug');
const bodyInput = $('f-body');
const preview = $('preview');
const errorsEl = $('errors');
const statusEl = $('status');

/** name → { dataUrl } ；只在記憶體，不存 localStorage */
const images = new Map();
let coverName = '';
let slugTouched = false;
let css = '';

// ---------- 草稿 ----------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveDraft() {
  const draft = { slug: slugInput.value, slugTouched, body: bodyInput.value, cover: coverName };
  for (const [k, el] of Object.entries(fields)) draft[k] = el.value;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* 私密模式或容量不足時略過 */
  }
}

function loadDraft() {
  let draft = null;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    draft = null;
  }
  if (!draft || typeof draft !== 'object') {
    fields.date.value = todayStr();
    slugInput.value = makeSlug(fields.date.value, '');
    return false;
  }
  for (const [k, el] of Object.entries(fields)) if (typeof draft[k] === 'string') el.value = draft[k];
  if (typeof draft.body === 'string') bodyInput.value = draft.body;
  slugTouched = draft.slugTouched === true;
  slugInput.value = typeof draft.slug === 'string' ? draft.slug : '';
  if (typeof draft.cover === 'string') coverName = draft.cover;
  if (!slugTouched || !slugInput.value) slugInput.value = makeSlug(fields.date.value, fields.title.value);
  return true;
}

// ---------- 資料 ----------
function currentReport() {
  const data = {};
  for (const [k, el] of Object.entries(fields)) data[k] = el.value;
  data.cover = coverName;
  return { slug: slugInput.value.trim(), data, body: bodyInput.value };
}

function collectErrors(report) {
  const { data, errors } = validateFrontMatter(report.data, '報導');
  const msgs = errors.map((x) => x.message.replace(/^報導：/, ''));
  if (!SLUG_RE.test(report.slug)) msgs.push('資料夾名稱格式需為 YYYY-MM-DD-名稱（小寫英數與連字號）');
  else if (isValidDate(data.date) && !report.slug.startsWith(`${data.date}-`)) msgs.push('資料夾名稱開頭的日期需與「日期」欄位相同');
  if (coverName && !images.has(coverName)) msgs.push(`主圖「${coverName}」尚未上傳（草稿不保存照片，請重新上傳）`);
  for (const n of findImageRefs(report.body)) {
    if (!images.has(n)) msgs.push(`內文插圖「${n}」尚未上傳`);
  }
  return { data, msgs };
}

function showErrors(msgs) {
  errorsEl.replaceChildren(
    ...msgs.map((m) => {
      const li = document.createElement('li');
      li.textContent = m;
      return li;
    }),
  );
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function imagesForRender() {
  const out = {};
  for (const [n, v] of images) out[n] = v.dataUrl;
  return out;
}

function renderHtml(report) {
  return renderStandalone(report, { md, css, images: imagesForRender(), siteUrl });
}

// ---------- 預覽 ----------
let timer = 0;
let lastScroll = 0;
function schedulePreview() {
  clearTimeout(timer);
  timer = setTimeout(updatePreview, 120);
}

function updatePreview() {
  const report = currentReport();
  try {
    lastScroll = preview.contentWindow?.scrollY || 0;
  } catch {
    lastScroll = 0;
  }
  preview.srcdoc = renderHtml(report);
  showErrors(collectErrors(report).msgs);
  saveDraft();
}

preview.addEventListener('load', () => {
  try {
    if (lastScroll) preview.contentWindow.scrollTo(0, lastScroll);
  } catch {
    /* 無法存取就略過 */
  }
});

// ---------- 圖片 ----------
function uniqueName(name) {
  if (!images.has(name)) return name;
  const base = name.replace(/\.[^.]+$/, '');
  const ext = name.slice(base.length);
  let i = 2;
  while (images.has(`${base}-${i}${ext}`)) i++;
  return `${base}-${i}${ext}`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`無法讀取圖片：${file.name}`));
    };
    img.src = url;
  });
}

/** 縮到最長邊 1600px，轉 JPEG 0.85 */
async function processImage(file) {
  const { img, url } = await loadImage(file);
  try {
    const w = img.naturalWidth || 1600;
    const h = img.naturalHeight || 1000;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function insertAtCursor(textarea, snippet) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const pre = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const post = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  textarea.value = before + pre + snippet + post + after;
  const pos = (before + pre + snippet).length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
}

function renderImageList() {
  const list = $('image-list');
  const items = [];
  for (const [name, v] of images) {
    if (name === coverName) continue;
    const li = document.createElement('li');
    li.className = 'image-item';
    const thumb = document.createElement('img');
    thumb.src = v.dataUrl;
    thumb.alt = '';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    const actions = document.createElement('span');
    actions.className = 'image-actions';
    const ins = document.createElement('button');
    ins.type = 'button';
    ins.className = 'btn small';
    ins.textContent = '插入';
    ins.setAttribute('aria-label', `插入 ${name}`);
    ins.addEventListener('click', () => {
      insertAtCursor(bodyInput, `![請輸入圖說](${name})`);
      schedulePreview();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small danger';
    del.textContent = '移除';
    del.setAttribute('aria-label', `移除 ${name}`);
    del.addEventListener('click', () => {
      images.delete(name);
      renderImageList();
      schedulePreview();
    });
    actions.append(ins, del);
    li.append(thumb, label, actions);
    items.push(li);
  }
  list.replaceChildren(...items);
  $('cover-name').textContent = coverName ? coverName + (images.has(coverName) ? '' : '（需重新上傳）') : '（尚未上傳）';
}

async function addFiles(fileList, asCover) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  for (const file of files) {
    setStatus(`處理圖片中：${file.name}…`);
    try {
      const result = await processImage(file);
      if (asCover) {
        if (coverName) images.delete(coverName);
        coverName = uniqueName(sanitizeImageName(`cover-${file.name}`, 'jpg'));
        images.set(coverName, result);
      } else {
        const name = uniqueName(sanitizeImageName(file.name, 'jpg'));
        images.set(name, result);
      }
      setStatus(`已加入 ${file.name}（${result.width}×${result.height}）`);
    } catch (err) {
      setStatus(err.message);
    }
  }
  renderImageList();
  schedulePreview();
}

$('cover-input').addEventListener('change', (ev) => {
  addFiles(ev.target.files, true);
  ev.target.value = '';
});
$('images-input').addEventListener('change', (ev) => {
  addFiles(ev.target.files, false);
  ev.target.value = '';
});

// ---------- 匯出 ----------
function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function download(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function readyToExport() {
  const report = currentReport();
  const { data, msgs } = collectErrors(report);
  showErrors(msgs);
  if (msgs.length) {
    setStatus('請先修正上方紅框列出的問題再匯出。');
    return null;
  }
  return { report, data };
}

$('export-zip').addEventListener('click', () => {
  const ok = readyToExport();
  if (!ok) return;
  const { report, data } = ok;
  const folder = report.slug;
  const files = { [`${folder}/index.md`]: strToU8(serializeReport(data, report.body, yaml)) };
  const used = new Set([coverName, ...findImageRefs(report.body)]);
  for (const name of used) {
    const img = images.get(name);
    if (img) files[`${folder}/${name}`] = [dataUrlToBytes(img.dataUrl), { level: 0 }];
  }
  const zip = zipSync(files, { level: 6 });
  download(new Blob([zip], { type: 'application/zip' }), `${folder}.zip`);
  const unused = [...images.keys()].filter((n) => !used.has(n));
  setStatus(`已下載 ${folder}.zip${unused.length ? `（未使用的照片沒有放進 zip：${unused.join('、')}）` : ''}`);
});

$('export-html').addEventListener('click', () => {
  const ok = readyToExport();
  if (!ok) return;
  const html = renderHtml({ ...ok.report, data: ok.data });
  download(new Blob([html], { type: 'text/html;charset=utf-8' }), `${ok.report.slug}.html`);
  setStatus(`已下載 ${ok.report.slug}.html`);
});

$('clear-draft').addEventListener('click', () => {
  if (!window.confirm('確定要清除草稿？所有欄位與已上傳的照片都會清空。')) return;
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 略過 */
  }
  $('editor-form').reset();
  images.clear();
  coverName = '';
  slugTouched = false;
  fields.date.value = todayStr();
  slugInput.value = makeSlug(fields.date.value, '');
  renderImageList();
  updatePreview();
  setStatus('草稿已清除。');
});

// ---------- 欄位事件 ----------
function syncSlug() {
  if (!slugTouched) slugInput.value = makeSlug(fields.date.value, fields.title.value);
}
for (const el of Object.values(fields)) {
  el.addEventListener('input', () => {
    if (el === fields.title || el === fields.date) syncSlug();
    schedulePreview();
  });
  el.addEventListener('change', schedulePreview);
}
bodyInput.addEventListener('input', schedulePreview);
slugInput.addEventListener('input', () => {
  slugTouched = slugInput.value.trim() !== '';
  schedulePreview();
});
slugInput.addEventListener('change', () => {
  slugInput.value = sanitizeSlug(slugInput.value);
  if (!slugInput.value) {
    slugTouched = false;
    syncSlug();
  }
  schedulePreview();
});

// 手機版：編輯／預覽分頁切換
for (const btn of document.querySelectorAll('.editor-tabs [data-view]')) {
  btn.addEventListener('click', () => {
    root.dataset.view = btn.dataset.view;
    for (const b of document.querySelectorAll('.editor-tabs [data-view]')) b.setAttribute('aria-selected', String(b === btn));
    if (btn.dataset.view === 'preview') updatePreview();
  });
}

// ---------- 啟動 ----------
try {
  css = await (await fetch(new URL('./styles.css', import.meta.url))).text();
} catch {
  css = '';
}
const restored = loadDraft();
renderImageList();
updatePreview();
if (restored) setStatus('已載入上次的草稿（照片需重新上傳）。');
root.dataset.ready = 'true';
