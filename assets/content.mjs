// 內容模型：前置資料驗證、slug 產生、index.md 解析與序列化。
// 本模組不 import 任何套件，Node 與瀏覽器都能直接使用；
// 需要 YAML 時由呼叫端傳入 js-yaml（{ load, dump, CORE_SCHEMA }）。

export const CATEGORIES = [
  { name: '會所報導', slug: 'hall' },
  { name: '青職', slug: 'young-working' },
  { name: '大專', slug: 'college' },
  { name: '青少年', slug: 'youth' },
  { name: '兒童', slug: 'children' },
  { name: '福音開展', slug: 'gospel' },
  { name: '整體綜合', slug: 'general' },
];

export function categorySlug(name) {
  const c = CATEGORIES.find((x) => x.name === name);
  return c ? c.slug : null;
}

export const FIELDS = [
  { key: 'title', label: '標題', required: true },
  { key: 'kicker', label: '肩題', required: false },
  { key: 'date', label: '日期', required: true },
  { key: 'category', label: '分類', required: true },
  { key: 'hall', label: '會所/區', required: false },
  { key: 'author', label: '作者', required: true },
  { key: 'cover', label: '主圖檔名', required: true },
  { key: 'cover_caption', label: '主圖圖說', required: false },
  { key: 'summary', label: '摘要', required: true },
];

export const FIELD_KEYS = FIELDS.map((f) => f.key);

// 資料夾名稱（＝網址 slug）：YYYY-MM-DD-小寫英數與連字號
export const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
// 圖片檔名：只允許英數、點、底線、連字號，且須為圖片副檔名
export const IMAGE_NAME_RE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:jpe?g|png|webp|gif|svg)$/i;
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MAX_LEN = { title: 120, kicker: 80, author: 80, hall: 60, cover_caption: 200, summary: 400 };

export function isValidDate(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isSafeImageName(name) {
  return typeof name === 'string' && name.length <= 100 && IMAGE_NAME_RE.test(name);
}

/**
 * 驗證前置資料。回傳 { data, errors }；errors 每一項都含檔案與欄位，可直接顯示。
 * data 為正規化後的物件（數字轉文字、去頭尾空白）。
 */
export function validateFrontMatter(raw, file = '(未知檔案)') {
  const errors = [];
  const err = (field, msg) => errors.push({ file, field, message: `${file}：欄位「${field}」${msg}` });
  const data = {};

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ file, field: '(前置資料)', message: `${file}：找不到前置資料（檔案開頭需要以 --- 包住的 YAML 區塊）` });
    return { data, errors };
  }

  for (const key of Object.keys(raw)) {
    if (!FIELD_KEYS.includes(key)) err(key, `不是可用的欄位（可用欄位：${FIELD_KEYS.join('、')}）`);
  }

  for (const f of FIELDS) {
    let v = raw[f.key];
    if (typeof v === 'number') v = String(v);
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (f.required) err(f.key, `（${f.label}）是必要欄位，但沒有填寫`);
      continue;
    }
    if (typeof v !== 'string') {
      err(f.key, `（${f.label}）必須是文字`);
      continue;
    }
    v = v.trim();
    if (MAX_LEN[f.key] && v.length > MAX_LEN[f.key]) err(f.key, `（${f.label}）太長，最多 ${MAX_LEN[f.key]} 字`);
    data[f.key] = v;
  }

  if (data.date !== undefined && !isValidDate(data.date)) err('date', `（日期）格式需為 YYYY-MM-DD 且為有效日期，目前是「${data.date}」`);
  if (data.category !== undefined && !categorySlug(data.category)) {
    err('category', `（分類）「${data.category}」不在清單中（可用：${CATEGORIES.map((c) => c.name).join('、')}）`);
  }
  if (data.cover !== undefined && !isSafeImageName(data.cover)) {
    err('cover', `（主圖檔名）「${data.cover}」不合法：只能用英數、- _ . 並以 .jpg/.png/.webp/.gif/.svg 結尾`);
  }
  return { data, errors };
}

/** 把 index.md 拆成前置資料與內文。yaml 需提供 load 與 CORE_SCHEMA。 */
export function parseReportSource(text, yaml, file = '(未知檔案)') {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) {
    return { raw: null, body: src, errors: [{ file, field: '(前置資料)', message: `${file}：找不到前置資料（檔案開頭需要以 --- 包住的 YAML 區塊）` }] };
  }
  let raw;
  try {
    // CORE_SCHEMA：不把日期自動轉成 Date 物件，保持文字
    raw = yaml.load(m[1], { schema: yaml.CORE_SCHEMA }) ?? {};
  } catch (e) {
    return { raw: null, body: '', errors: [{ file, field: '(前置資料)', message: `${file}：前置資料 YAML 格式錯誤：${e.reason || e.message}` }] };
  }
  return { raw, body: src.slice(m[0].length).replace(/^\n+/, ''), errors: [] };
}

/** 依欄位順序產生 index.md 內容（只輸出有值的欄位）。 */
export function serializeReport(data, body, yaml) {
  const ordered = {};
  for (const k of FIELD_KEYS) {
    const v = data[k];
    if (typeof v === 'string' && v.trim() !== '') ordered[k] = v.trim();
  }
  const fm = yaml.dump(ordered, { schema: yaml.CORE_SCHEMA, lineWidth: -1, quotingType: '"', forceQuotes: true });
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '');
  return `---\n${fm}---\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

// 小型穩定雜湊（FNV-1a 32 bit），用於中文標題產生 ASCII slug
function hash36(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(-6);
}

/**
 * 由日期＋標題產生資料夾名稱（slug）。
 * 標題裡的英數字會保留成單字；純中文標題則用標題雜湊（例：2026-11-04-r-1a2b3c），可再手動修改。
 */
export function makeSlug(date, title) {
  const d = isValidDate(date) ? String(date) : '0000-00-00';
  const t = String(title ?? '').replace(/【範例】/g, ' ').normalize('NFKC').toLowerCase();
  const words = t.match(/[a-z0-9]+/g) || [];
  let tail = words.join('-').slice(0, 50).replace(/-+$/, '');
  if (!tail) tail = t.trim() ? `r-${hash36(t.trim())}` : 'report';
  return `${d}-${tail}`;
}

/** 把使用者輸入的 slug 整理成合法格式（不保證日期正確，需再用 SLUG_RE 驗證）。 */
export function sanitizeSlug(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** 把上傳檔名整理成安全檔名；ext 可強制改副檔名（例如重新編碼成 jpg）。 */
export function sanitizeImageName(name, ext) {
  const base = String(name ?? '')
    .normalize('NFKC')
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60);
  const e = (ext || (/\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1] ?? 'jpg')).toLowerCase();
  return `${base || 'image'}.${e}`;
}

/** 從內文找出所有 ![...](檔名) 參照的檔名。 */
export function findImageRefs(markdown) {
  const out = [];
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = re.exec(String(markdown ?? '')))) out.push(m[1]);
  return out;
}
