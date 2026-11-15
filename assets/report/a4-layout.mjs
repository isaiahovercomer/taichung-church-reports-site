// A4 版面計算（純函式，不碰 DOM）：把報導區塊排進 1240×1754 px（A4 210:297，150dpi）頁面。
// 框架式排版：每頁先決定固定框（標題／主圖／照片），內文再流進「欄位減去障礙物」的文字區，
// 真正繞著照片排；一頁排滿接下一頁。回傳每頁的 frames（給編輯器拖拉）與 ops（給 a4.mjs 畫圖）。
// A4／PDF 不放影片：video 區塊一律略過。measure(text, font) 由呼叫端提供（canvas.measureText 或測試用假函式）。
// 同步純函式：素材與圖片尺寸已快取時不做 I/O、不讀 DOM，只做換行與矩形運算。


export const A4 = { width: 1240, height: 1754 };
export const FONT_FAMILY = '"Noto Sans CJK TC","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';
export const COLORS = { navy: '#16324F', gold: '#836427', goldLight: '#C9A865', text: '#1F2D3D', gray: '#5A6A7A', line: '#E4E3DE', bg: '#FFFFFF', paper: '#F5F5F2' };

/** 排版進行中的色票；runWithTheme 可暫時換成設計範本，結束後還原。 */
let PAL = COLORS;
export function runWithTheme(theme, fn) {
  const prev = PAL;
  PAL = theme && theme.colors ? { ...COLORS, ...theme.colors } : COLORS;
  try { return fn(); } finally { PAL = prev; }
}


const MARGIN = 100;
const TOP_FIRST = 196;
const TOP_OTHER = 150;
const BOTTOM = A4.height - 130;
export const DPI = 150;
/** 左右至少 15mm 安全邊距（150dpi）。內文欄仍用 100px，換行時再內縮以免字被切到。 */
export const SAFE_MARGIN = Math.round((15 / 25.4) * DPI);
export const DEFAULT_FOCUS_X = 0.5;
export const DEFAULT_FOCUS_Y = 0.4;
export const PHOTO_ASPECT = { portrait: 3 / 4, landscape: 3 / 2, square: 1, bannerMax: 16 / 9 };
/** 橫圖框最小高度：不扁於 16:9，且至少為框寬的 50%。 */
export function minLandscapeHeight(frameW) {
  const w = Math.max(1, frameW);
  return Math.max(w / PHOTO_ASPECT.bannerMax, w * 0.5);
}
export function framesOverlap(a, b, pad = 0) {
  if (!a || !b) return false;
  return a.x < b.x + b.w + pad && a.x + a.w > b.x - pad && a.y < b.y + b.h + pad && a.y + a.h > b.y - pad;
}
export const TYPE_RATIO = { title: 2.2, heading: 1.4, meta: 0.85, caption: 0.85 };
export const BODY_PX = 27;
export const BODY_PX_TRI = 24;
export const MIN_BODY_PT = 10.5;
export const MIN_BODY_PX = MIN_BODY_PT * DPI / 72;

export const font = (size, weight = 400) => `${weight} ${Math.round(size)}px ${FONT_FAMILY}`;

/** 同一份報導的字級階梯：主標 : 段標 : 內文 : meta／圖說 ≈ 2.2 : 1.4 : 1 : 0.85 */
export function typeSizes(s = 1, spec = {}) {
  const body = ((spec && spec.columns === 3 ? BODY_PX_TRI : BODY_PX) * s * ((spec && spec.bodyScale) || 1));
  const titleScale = (spec && spec.titleScale) || 1;
  return {
    body,
    bodyLH: body * 1.8,
    title: body * TYPE_RATIO.title * titleScale,
    heading: body * TYPE_RATIO.heading,
    section: body * TYPE_RATIO.heading,
    meta: body * TYPE_RATIO.meta,
    caption: body * TYPE_RATIO.caption,
    kicker: Math.max(22 * s, body * 0.9),
  };
}

/** 圖說用小字，明顯小於內文與標題，避免被看成小標。 */
export const captionSize = (s = 1, spec) => typeSizes(s, spec || {}).caption;
export const captionLineHeight = (s = 1, spec) => captionSize(s, spec) * 1.4;
export const captionGap = (s = 1) => 8 * s;

export function photoKind(sz) {
  const w = sz && sz.w > 0 ? sz.w : 4;
  const h = sz && sz.h > 0 ? sz.h : 3;
  const r = w / h;
  if (r < 0.95) return 'portrait';
  if (r > 1.15) return 'landscape';
  return 'square';
}

/** 回傳框的寬高比（寬/高）：直圖 3:4、橫圖 3:2，橫幅最寬不超過 16:9。 */
export function frameAspectFor(sz, opts = {}) {
  const kind = photoKind(sz);
  if (kind === 'portrait') return PHOTO_ASPECT.portrait;
  if (kind === 'square') return PHOTO_ASPECT.square;
  if (opts.banner) {
    const nat = ((sz && sz.w) || 3) / ((sz && sz.h) || 2);
    return Math.min(PHOTO_ASPECT.bannerMax, Math.max(PHOTO_ASPECT.landscape, nat));
  }
  return PHOTO_ASPECT.landscape;
}

/** 在 maxW×maxH 內依照片方向選框，必要時等比縮小，不把直圖壓成橫幅。 */
export function frameSizeForPhoto(sz, maxW, maxH, opts = {}) {
  const aspect = frameAspectFor(sz, opts);
  let w = Math.max(1, maxW);
  let h = w / aspect;
  if (h > maxH) {
    h = Math.max(1, maxH);
    w = h * aspect;
  }
  if (w > maxW) {
    w = Math.max(1, maxW);
    h = w / aspect;
  }
  if (h > maxH) {
    h = Math.max(1, maxH);
    w = h * aspect;
  }
  return { w, h, kind: photoKind(sz), aspect };
}

/** meta 改兩行：第一行日期與地點，第二行作者；超過 3 位顯示「某某等 N 位」。 */
export function formatMetaLines({ dateText, place, authors } = {}) {
  const list = [...new Set((authors || []).map((a) => String(a || '').trim()).filter(Boolean))];
  const line1 = [dateText, place ? `地點：${place}` : ''].filter(Boolean).join('　');
  let line2;
  if (!list.length) line2 = '作者：行動報導小組';
  else if (list.length > 3) line2 = `作者：${list[0]}等 ${list.length} 位`;
  else line2 = `作者：${list.join('、')}`;
  return [line1, line2].filter(Boolean);
}
export function formatMetaLine(opts) {
  return formatMetaLines(opts).join('\n');
}

/** 從見證或內文取一句作大字引言。 */
export function pickPullQuote(blocks) {
  const paras = [];
  let prefer = false;
  for (const b of blocks || []) {
    if (b && b.type === 'heading') prefer = b.kind === 'testimony';
    if (b && b.type === 'para' && String(b.text || '').trim()) {
      paras.push({ text: String(b.text).trim(), prefer: prefer || b.kind === 'testimony' });
    }
  }
  const ordered = paras.filter((p) => p.prefer).concat(paras.filter((p) => !p.prefer));
  const split = (t) => String(t).split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
  for (const p of ordered) {
    for (const sent of split(p.text)) {
      const n = Array.from(sent.replace(/\s+/g, '')).length;
      if (n >= 10 && n <= 48) return sent.replace(/[。！？!?]+$/g, '');
    }
  }
  if (ordered[0]) {
    const t = Array.from(ordered[0].text.replace(/\s+/g, ''));
    return t.slice(0, 28).join('') + (t.length > 28 ? '……' : '');
  }
  return '';
}

export function pageContentBottom(page) {
  let bottom = 0;
  for (const f of (page && page.frames) || []) bottom = Math.max(bottom, (f.y || 0) + (f.h || 0));
  for (const o of (page && page.ops) || []) {
    if (o.op === 'text') bottom = Math.max(bottom, o.y || 0);
    if (o.op === 'image' || o.op === 'rect') bottom = Math.max(bottom, (o.y || 0) + (o.h || 0));
  }
  return bottom;
}
export function pageFillRatio(page) {
  const top = TOP_OTHER;
  const span = Math.max(1, BOTTOM - top);
  return Math.max(0, Math.min(1, (pageContentBottom(page) - top) / span));
}
export function trimCaption(text) {
  return String(text ?? '').trim();
}
export function wrapCaption(text, width, s, measure) {
  const cap = trimCaption(text);
  if (!cap || width <= 0) return [];
  return wrapText(cap, font(captionSize(s)), width, measure);
}
export function captionBlockHeight(lines, s) {
  return lines.length ? lines.length * captionLineHeight(s) : 0;
}


const NO_LINE_START = '，。、；：！？）」』】》〉,.;:!?)」”’…';
const TOKEN_RE = /[A-Za-z0-9@#$%&*+=/:._~'"\-]+\s*|\s+|[\s\S]/gu;


/** 依寬度換行：中文逐字、英數以單字為單位；行首避開標點。 */
export function wrapText(text, fnt, width, measure) {
  const raw = String(text ?? '');
  if (raw.includes('\n')) {
    return raw.split('\n').flatMap((part) => (part === '' ? [] : wrapText(part, fnt, width, measure)));
  }
  const lines = [];
  let line = '';
  const tokens = raw.match(TOKEN_RE) || [];
  for (let tok of tokens) {
    if (measure(tok, fnt) > width) {
      for (const ch of Array.from(tok)) {
        if (line && measure(line + ch, fnt) > width) {
          lines.push(line);
          line = '';
        }
        line += ch;
      }
      continue;
    }
    if (line && measure(line + tok, fnt) > width && !NO_LINE_START.includes(tok[0])) {
      lines.push(line.trimEnd());
      line = tok.trimStart();
    } else line += tok;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}


export const LAYOUTS = [
  { id: 'classic', name: '經典單欄', desc: '全寬單欄、主圖置中，適合正式報導與週訊長文。' },
  { id: 'alternate', name: '圖文繞排', desc: '照片左右輪流、內文逐行繞著照片排，圖說在照片下方。' },
  { id: 'columns', name: '雙欄專刊', desc: '雙欄排版、照片跨欄置中，適合篇幅較長的專題。' },
  { id: 'magazine', name: '大主圖雜誌封面', desc: '大主圖在標題下方佔據上半頁，內文繞排，雜誌感最強。' },
  { id: 'wrap2', name: '雙欄繞排', desc: '雙欄加上照片左右輪流繞排，資訊量大又不擁擠。' },
  { id: 'collage', name: '照片拼貼', desc: '照片兩兩並排成格狀拼貼，配短文與圖說，適合活動花絮。' },
  { id: 'tri', name: '三欄專刊', desc: '三欄小字排版，適合內容多、像刊物內頁的專刊。' },
  { id: 'banner', name: '寬圖橫幅穿插', desc: '照片以寬橫幅全寬穿插在段落之間，節奏明快。' },
  { id: 'newspaper', name: '報紙頭版', desc: '大標題加三欄，像報紙頭版，適合頭條與多則短訊。' },
  { id: 'timeline', name: '時間軸', desc: '左側一條時間線、標題帶圓點，照片靠右繞排，適合歷程回顧。' },
  { id: 'quote', name: '見證引言大字', desc: '從見證或內文取出一句大字引言，適合見證與引言為主的報導。' },
  { id: 'card', name: '上圖下文卡片', desc: '每張照片連圖說裝進一張淺色卡片，段落接在卡片之後。' },
  { id: 'sidebar', name: '左側邊欄', desc: '左側邊欄列出本期要目，主文在右側繞排。' },
  { id: 'fullbleed', name: '全版滿版照片', desc: '第一頁照片滿版、標題白字疊印在照片上，內文從第二頁開始。' },
  { id: 'spread', name: '左右對開', desc: '第 1 頁左圖右文，第 2 頁起左右互換，像翻開的書冊，適合圖文並重的報導。' },
];


const LAYOUT_SPECS = {
  // headerCover: 第 1 頁是否在標題下畫整頁寬主圖。false 時主圖改插入內文，依該版型的照片模式排列。
  classic: { columns: 1, photo: 'center', photoW: 1, cover: 'normal', titleScale: 1, headerCover: true },
  alternate: { columns: 1, photo: 'alternate', photoW: 0.40, cover: 'normal', titleScale: 1, headerCover: false },
  columns: { columns: 2, photo: 'center', photoW: 1, cover: 'normal', titleScale: 1, headerCover: true },
  magazine: { columns: 1, photo: 'alternate', photoW: 0.5, cover: 'hero', titleScale: 1.08, headerCover: true },
  wrap2: { columns: 2, photo: 'alternate', photoW: 0.45, cover: 'normal', titleScale: 1, headerCover: false },
  collage: { columns: 1, photo: 'grid', photoW: 0.5, cover: 'normal', titleScale: 1, headerCover: false },
  tri: { columns: 3, photo: 'center', photoW: 1, cover: 'normal', titleScale: 0.92, bodyScale: 0.9, headerCover: true },
  banner: { columns: 1, photo: 'banner', photoW: 1, cover: 'normal', titleScale: 1, headerCover: false },
  newspaper: { columns: 3, photo: 'top', photoW: 1, cover: 'normal', titleScale: 1.18, bodyScale: 0.9, headerCover: true },
  timeline: { columns: 1, photo: 'right', photoW: 0.38, cover: 'normal', titleScale: 1, timeline: true, headerCover: false },
  quote: { columns: 1, photo: 'alternate', photoW: 0.5, cover: 'normal', titleScale: 1, quote: true, headerCover: false },
  card: { columns: 1, photo: 'card', photoW: 1, cover: 'normal', titleScale: 1, headerCover: false },
  sidebar: { columns: 1, photo: 'alternate', photoW: 0.5, cover: 'normal', titleScale: 1, sidebar: true, headerCover: false },
  fullbleed: { columns: 1, photo: 'alternate', photoW: 0.5, cover: 'fullbleed', titleScale: 1.1, headerCover: true },
  spread: { columns: 1, photo: 'pane', photoW: 0.5, cover: 'normal', titleScale: 0.9, headerCover: true, spread: true },
};

/** 可選版型以 LAYOUTS 為準。後端清單只用來忽略前端尚不認識的 id，不會因舊版只有三種而縮減選項。 */
export function selectableLayoutIds(backendLayouts) {
  // 以 LAYOUTS 為準。後端清單只用來過濾不認得的 id，不會拿舊的三種清單縮減選項。
  const ids = LAYOUTS.map((l) => l.id);
  const known = new Set(ids);
  if (Array.isArray(backendLayouts)) backendLayouts.filter((id) => known.has(id));
  return ids;
}

function usesHeaderCover(spec) {
  return !!(spec && spec.headerCover) || spec.cover === 'fullbleed' || spec.cover === 'hero';
}

/** 不畫整寬主圖的版型：把 cover 插入內文，依該版型的照片模式排在第 1 頁。 */
function insertInlineCover(list, cover, spec) {
  if (!cover || !cover.photoId) return;
  if (list.some((b) => b.type === 'figure' && b.photoId === cover.photoId)) return;
  const fig = { type: 'figure', photoId: cover.photoId, caption: trimCaption(cover.caption) };
  const afterPara = spec.photo === 'banner' || spec.photo === 'grid';
  const i = list.findIndex((b) => b.type === 'para');
  if (i >= 0) list.splice(afterPara ? i + 1 : i, 0, fig);
  else list.unshift(fig);
}


function specFor(id) { return LAYOUT_SPECS[id] || LAYOUT_SPECS.classic; }
function fallbackMeasure(t, f) {
  const m = String(f).match(/(\d+)px/);
  const sz = m ? parseInt(m[1], 10) : 24;
  return String(t ?? '').length * sz * 0.55;
}
function sizeOf(imageSize, id) {
  const s = imageSize ? imageSize(id) : null;
  return s && s.w > 0 && s.h > 0 ? s : { w: 4, h: 3 };
}
function nextId(st, type) { st.seq = (st.seq || 0) + 1; return 'p' + st.pageIndex + '-' + type + '-' + st.seq; }


function spreadPane(pageIndex) {
  const gap = 36;
  const paneW = (A4.width - 2 * MARGIN - gap) / 2;
  const photoLeft = pageIndex % 2 === 0;
  const photoX = photoLeft ? MARGIN : MARGIN + paneW + gap;
  const textX = photoLeft ? MARGIN + paneW + gap : MARGIN;
  return { gap, paneW, photoLeft, photoX, textX };
}

function geometryFor(spec, top, pageIndex = 0, opts = {}) {
  let mainX = MARGIN;
  let mainW = A4.width - 2 * MARGIN;
  let railX = null;
  if (spec.spread && opts.hasPhoto !== false) {
    const g = spreadPane(pageIndex);
    const cols = [{ x: g.textX, y: top, w: g.paneW, h: Math.max(0, BOTTOM - top) }];
    return { mainX: g.textX, mainW: g.paneW, cols, colW: g.paneW, gap: g.gap, railX: null, photoX: g.photoX, photoW: g.paneW, photoLeft: g.photoLeft };
  }
  if (spec.sidebar) { mainX = MARGIN + 240 + 36; mainW = A4.width - MARGIN - mainX; }
  else if (spec.timeline) { mainX = MARGIN + 36; mainW = A4.width - MARGIN - mainX; railX = MARGIN + 12; }
  const ncol = spec.columns || 1;
  const gap = ncol === 3 ? 36 : 44;
  const colW = (mainW - gap * (ncol - 1)) / ncol;
  const cols = [];
  for (let i = 0; i < ncol; i++) cols.push({ x: mainX + i * (colW + gap), y: top, w: colW, h: Math.max(0, BOTTOM - top) });
  return { mainX, mainW, cols, colW, gap, railX };
}


function headerCoverFrame(sz, CW, spec) {
  const kind = photoKind(sz);
  if (kind === 'portrait') return frameSizeForPhoto(sz, CW, A4.height * 0.28);
  // 橫圖主圖維持全寬，高度取 16:9（橫幅上限），避免再縮寬或裁成更扁的色帶
  const h = CW / PHOTO_ASPECT.bannerMax;
  return { w: CW, h, kind, aspect: PHOTO_ASPECT.bannerMax };
}

function buildHeader(page, data, metaLine, cover, spec, s, measure, imageSize, isFirst, pageIndex, targetPages) {
  const CW = A4.width - 2 * MARGIN;
  const typ = typeSizes(s, spec);
  let n = 0;
  const hid = (t) => 'p' + pageIndex + '-' + t + '-' + (++n);
  if (!isFirst) return TOP_OTHER;
  if (spec.cover === 'fullbleed' && cover) {
    const sz = sizeOf(imageSize, cover.photoId);
    const kind = photoKind(sz);
    const shortCover = targetPages && targetPages <= 2;
    const typTitle = typ.title * (58 / 54);
    const tf = font(typTitle, 900);
    const lines = data.title ? wrapText(data.title, tf, CW, measure) : [];
    const lh = typTitle * 1.3;
    const mf = font(typ.meta);
    const mlines = metaLine ? wrapText(metaLine, mf, CW, measure) : [];
    const metaH = mlines.length ? mlines.length * typ.meta * 1.6 + 20 * s : 0;
    const capLines = wrapCaption(cover.caption, CW, s, measure);
    const capH = capLines.length ? captionBlockHeight(capLines, s) + 16 * s : 0;
    const textH = lines.length * lh + metaH + capH + 24 * s;
    if (shortCover) {
      const bandH = Math.min(A4.height * 0.55, Math.max(A4.height * 0.42, (kind === 'landscape' ? A4.width / PHOTO_ASPECT.bannerMax : A4.width / PHOTO_ASPECT.portrait) + 80));
      const photoMaxH = Math.max(200, bandH - 8);
      const fr = kind === 'portrait'
        ? frameSizeForPhoto(sz, A4.width, photoMaxH)
        : frameSizeForPhoto(sz, A4.width, Math.min(photoMaxH, A4.width / PHOTO_ASPECT.landscape), { banner: true });
      const ix = (A4.width - fr.w) / 2;
      page.ops.push({ op: 'rect', x: 0, y: 0, w: A4.width, h: bandH, fill: PAL.navy });
      page.frames.push({ id: hid('image'), type: 'image', x: ix, y: 0, w: fr.w, h: fr.h, locked: false, photoId: cover.photoId, fit: 'cover', focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
      page.ops.push({ op: 'image', photoId: cover.photoId, x: ix, y: 0, w: fr.w, h: fr.h, fit: 'cover', radius: 0, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
      const overlayH = Math.min(bandH, Math.max(textH + 40, 220));
      const overlayY = Math.max(0, bandH - overlayH);
      page.ops.push({ op: 'rect', x: 0, y: overlayY, w: A4.width, h: bandH - overlayY, fill: 'rgba(22,50,79,0.55)' });
      let ty = overlayY + 28 * s;
      page.frames.push({ id: hid('title'), type: 'title', x: MARGIN, y: ty, w: CW, h: lines.length * lh, locked: false });
      lines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: ty + i * lh + typTitle, text: ln, font: tf, color: '#ffffff' }); });
      let bandY = ty + lines.length * lh;
      if (mlines.length) {
        const my = bandY + 16 * s;
        page.frames.push({ id: hid('meta'), type: 'meta', x: MARGIN, y: my, w: CW, h: mlines.length * typ.meta * 1.6, locked: false });
        mlines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: my + i * typ.meta * 1.6 + typ.meta, text: ln, font: mf, color: '#ffffff' }); });
        bandY = my + mlines.length * typ.meta * 1.6;
      }
      if (capLines.length) {
        const cy = bandY + 12 * s;
        const ch = captionBlockHeight(capLines, s);
        page.frames.push({ id: hid('caption'), type: 'caption', x: MARGIN, y: cy, w: CW, h: ch, locked: false, photoId: cover.photoId, align: 'left' });
        capLines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: cy + i * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: 'rgba(255,255,255,0.88)' }); });
      }
      return Math.max(bandH, 200) + 28;
    }
    page.ops.push({ op: 'rect', x: 0, y: 0, w: A4.width, h: A4.height, fill: PAL.navy });
    if (kind === 'landscape' || kind === 'square') {
      const fr = frameSizeForPhoto(sz, A4.width, Math.min(A4.height * 0.62, A4.width / PHOTO_ASPECT.landscape), { banner: true });
      const ix = (A4.width - fr.w) / 2;
      page.frames.push({ id: hid('image'), type: 'image', x: ix, y: 0, w: fr.w, h: fr.h, locked: false, photoId: cover.photoId, fit: 'cover', focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
      page.ops.push({ op: 'image', photoId: cover.photoId, x: ix, y: 0, w: fr.w, h: fr.h, fit: 'cover', radius: 0, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    } else {
      page.frames.push({ id: hid('image'), type: 'image', x: 0, y: 0, w: A4.width, h: A4.height, locked: false, photoId: cover.photoId, fit: 'cover', focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
      page.ops.push({ op: 'image', photoId: cover.photoId, x: 0, y: 0, w: A4.width, h: A4.height, fit: 'cover', radius: 0, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    }
    const bandTop = Math.max(1060, BOTTOM - textH - 40);
    page.ops.push({ op: 'rect', x: 0, y: bandTop, w: A4.width, h: A4.height - bandTop, fill: 'rgba(22,50,79,0.55)' });
    let ty = bandTop + 32 * s;
    page.frames.push({ id: hid('title'), type: 'title', x: MARGIN, y: ty, w: CW, h: lines.length * lh, locked: false });
    lines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: ty + i * lh + typTitle, text: ln, font: tf, color: '#ffffff' }); });
    let bandY = ty + lines.length * lh;
    if (mlines.length) {
      const my = bandY + 16 * s;
      page.frames.push({ id: hid('meta'), type: 'meta', x: MARGIN, y: my, w: CW, h: mlines.length * typ.meta * 1.6, locked: false });
      mlines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: my + i * typ.meta * 1.6 + typ.meta, text: ln, font: mf, color: '#ffffff' }); });
      bandY = my + mlines.length * typ.meta * 1.6;
    }
    if (capLines.length) {
      const cy = Math.min(bandY + 12 * s, BOTTOM - captionBlockHeight(capLines, s));
      const ch = captionBlockHeight(capLines, s);
      page.frames.push({ id: hid('caption'), type: 'caption', x: MARGIN, y: cy, w: CW, h: ch, locked: false, photoId: cover.photoId, align: 'left' });
      capLines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: cy + i * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: 'rgba(255,255,255,0.88)' }); });
    }
    return BOTTOM + 1;
  }
  let y = TOP_FIRST;
  if (data.kicker) {
    const f = font(typ.kicker, 700);
    page.frames.push({ id: 'p' + pageIndex + '-kicker-' + (++n), type: 'meta', x: MARGIN, y: y, w: CW, h: typ.kicker + 18 * s, locked: false });
    page.ops.push({ op: 'text', x: MARGIN, y: y + typ.kicker, text: data.kicker, font: f, color: PAL.gold });
    y += typ.kicker + 18 * s;
  }
  const titleSize = typ.title;
  const tf = font(titleSize, 900);
  const tlines = data.title ? wrapText(data.title, tf, CW, measure) : [];
  const tlh = titleSize * 1.35;
  if (tlines.length) {
    page.frames.push({ id: hid('title'), type: 'title', x: MARGIN, y: y, w: CW, h: tlines.length * tlh, locked: false });
    for (const ln of tlines) { page.ops.push({ op: 'text', x: MARGIN, y: y + titleSize, text: ln, font: tf, color: PAL.navy }); y += tlh; }
  }
  y += 10 * s;
  const mf = font(typ.meta);
  const mlines = wrapText(metaLine || '', mf, CW, measure);
  if (mlines.length) {
    page.frames.push({ id: hid('meta'), type: 'meta', x: MARGIN, y: y, w: CW, h: mlines.length * typ.meta * 1.6, locked: false });
    for (const ln of mlines) { page.ops.push({ op: 'text', x: MARGIN, y: y + typ.meta, text: ln, font: mf, color: PAL.gray }); y += typ.meta * 1.6; }
  }
  y += 14 * s;
  page.ops.push({ op: 'line', x1: MARGIN, y1: y, x2: MARGIN + CW, y2: y, color: PAL.line, width: 2 });
  y += 30 * s;
  if (cover) {
    const sz = sizeOf(imageSize, cover.photoId);
    const fr = headerCoverFrame(sz, CW, spec);
    const ix = MARGIN + (CW - fr.w) / 2;
    page.frames.push({ id: hid('image'), type: 'image', x: ix, y: y, w: fr.w, h: fr.h, locked: false, photoId: cover.photoId, fit: 'cover', focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    page.ops.push({ op: 'image', photoId: cover.photoId, x: ix, y: y, w: fr.w, h: fr.h, fit: 'cover', radius: 8, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    y += fr.h;
    const clines = wrapCaption(cover.caption, fr.w, s, measure);
    if (clines.length) {
      y += captionGap(s);
      const ch = captionBlockHeight(clines, s);
      page.frames.push({ id: hid('caption'), type: 'caption', x: ix, y: y, w: fr.w, h: ch, locked: false, photoId: cover.photoId, align: 'center' });
      for (const ln of clines) { page.ops.push({ op: 'text', x: ix + fr.w / 2, y: y + captionSize(s), text: ln, font: font(captionSize(s)), color: PAL.gray, align: 'center' }); y += captionLineHeight(s); }
    }
    y += Math.max(24, 22 * s);
  }
  return y;
}


function makeState(page, spec, cols, opts) {
  return {
    page, spec, cols, col: 0, y: cols.length ? cols[0].y : TOP_OTHER,
    obstacles: [], figIndex: 0, s: opts.s || 1, measure: opts.measure,
    imageSize: opts.imageSize, seq: opts.seq || 0, pageIndex: opts.pageIndex || 0,
    bodySize: opts.bodySize, bodyLH: opts.bodyLH, bf: opts.bf, railX: opts.railX || null,
    mainX: opts.mainX, mainW: opts.mainW,
  };
}
function colRect(st) { return st.cols[st.col]; }
function atTop(st) { const c = colRect(st); return st.y <= c.y + 0.5; }
function nextSlot(st) {
  if (st.col < st.cols.length - 1) { st.col++; st.y = colRect(st).y; return true; }
  return false;
}
function segmentsAt(st, y, lh) {
  const c = colRect(st);
  let segs = [{ x: c.x, w: c.w }];
  for (const o of st.obstacles) {
    if (!(o.y < y + lh && o.y + o.h > y)) continue;
    const next = [];
    for (const seg of segs) {
      if (o.x >= seg.x + seg.w || o.x + o.w <= seg.x) { next.push(seg); continue; }
      if (o.x > seg.x) next.push({ x: seg.x, w: o.x - seg.x });
      if (o.x + o.w < seg.x + seg.w) next.push({ x: o.x + o.w, w: seg.x + seg.w - (o.x + o.w) });
    }
    segs = next;
  }
  return segs.filter((sg) => sg.w > 1);
}
function currentSeg(st, lh) {
  const segs = segmentsAt(st, st.y, lh || st.bodyLH);
  if (!segs.length) return null;
  let best = segs[0];
  for (const sg of segs) if (sg.w > best.w) best = sg;
  return best;
}
function jumpY(st) {
  const c = colRect(st);
  const cand = st.obstacles.filter((o) => o.y < st.y + st.bodyLH && o.y + o.h > st.y && o.x < c.x + c.w && o.x + o.w > c.x);
  if (!cand.length) return null;
  return Math.min.apply(null, cand.map((o) => o.y + o.h));
}
function jumpPastObstacles(st, lh) {
  const c = colRect(st);
  const obs = st.obstacles.filter((o) => o.y < st.y + lh && o.y + o.h > st.y && o.x < c.x + c.w && o.x + o.w > c.x);
  if (!obs.length) return true;
  st.y = Math.max.apply(null, obs.map((o) => o.y + o.h));
  return st.y <= BOTTOM;
}

function bumpPastOverlaps(st, rect) {
  const frames = (st.page && st.page.frames) || [];
  let moved = false;
  for (const f of frames) {
    if (!f || (f.type !== 'heading' && f.type !== 'title' && f.type !== 'meta' && f.type !== 'image' && f.type !== 'quote')) continue;
    if (framesOverlap(rect, f, 4)) {
      st.y = Math.max(st.y, f.y + f.h + 12 * (st.s || 1));
      moved = true;
    }
  }
  return !moved;
}

function takeLastBodyLines(st, n) {
  const col = colRect(st);
  const ops = st.page.ops || [];
  const picked = [];
  for (let i = ops.length - 1; i >= 0 && picked.length < n; i--) {
    const o = ops[i];
    if (o.op === 'image') break;
    if (o.op !== 'text' || o.color !== PAL.text) {
      if (o.op === 'text' && /文／|——/.test(String(o.text || ''))) break;
      continue;
    }
    if (o.x < col.x - 4 || o.x > col.x + col.w) break;
    picked.push({ i, o });
  }
  picked.reverse();
  if (!picked.length) return '';
  const lh = st.bodyLH;
  const size = st.bodySize;
  const text = picked.map((x) => x.o.text).join('');
  const firstY = picked[0].o.y - (lh + size * 0.72) / 2;
  for (let k = picked.length - 1; k >= 0; k--) ops.splice(picked[k].i, 1);
  const frames = st.page.frames || [];
  for (const x of picked) {
    for (let fi = frames.length - 1; fi >= 0; fi--) {
      const f = frames[fi];
      if (f.type !== 'text') continue;
      if (Math.abs(f.x - col.x) > 4) continue;
      if (x.o.y >= f.y - 2 && x.o.y <= f.y + f.h + 4) {
        f.h = Math.max(0, x.o.y - (lh + size * 0.72) / 2 - f.y);
        if (f.h < lh * 0.5) frames.splice(fi, 1);
        break;
      }
    }
  }
  st.y = Math.min(st.y, Math.max(col.y, firstY));
  return text;
}

function emitBodyLines(st, text, idx) {
  if (!text || !String(text).trim()) return;
  const col = colRect(st);
  const tokens = String(text).match(TOKEN_RE) || [];
  let line = '';
  let startY = st.y;
  let lines = 0;
  const flush = () => {
    if (lines > 0) {
      st.page.frames.push({ id: nextId(st, 'text'), type: 'text', x: col.x, y: startY, w: col.w, h: lines * st.bodyLH, blockIndex: idx });
      lines = 0;
    }
  };
  const emit = () => {
    const seg = currentSeg(st, st.bodyLH) || { x: col.x, w: col.w };
    st.page.ops.push({ op: 'text', x: seg.x, y: st.y + (st.bodyLH + st.bodySize * 0.72) / 2, text: line, font: st.bf, color: PAL.text });
    st.y += st.bodyLH;
    lines++;
    line = '';
  };
  for (let ti = 0; ti < tokens.length; ) {
    if (st.y + st.bodyLH > BOTTOM) { flush(); if (!nextSlot(st)) return String(line + tokens.slice(ti).join('')); startY = st.y; continue; }
    const tok = tokens[ti];
    const seg = currentSeg(st, st.bodyLH);
    const width = (seg ? seg.w : col.w) - 4;
    if (line && st.measure(line + tok, st.bf) > width && !NO_LINE_START.includes(tok[0])) { emit(); continue; }
    line += tok;
    ti++;
  }
  if (line.trim()) {
    if (st.y + st.bodyLH > BOTTOM) { flush(); if (!nextSlot(st)) return line; startY = st.y; }
    emit();
  }
  flush();
  return '';
}


function flowPara(st, b, idx) {
  const s = st.s;
  const size = st.bodySize;
  const lh = st.bodyLH;
  const fnt = st.bf;
  const color = PAL.text;
  const tokens = String(b.text ?? '').match(TOKEN_RE) || [];
  let ti = 0;
  let line = '';
  let chunkStartY = st.y;
  let chunkCol = st.col;
  let chunkLines = 0;
  const flushChunk = () => {
    if (chunkLines > 0) {
      st.page.frames.push({ id: nextId(st, 'text'), type: 'text', x: st.cols[chunkCol].x, y: chunkStartY, w: st.cols[chunkCol].w, h: chunkLines * lh, blockIndex: idx });
      chunkLines = 0;
    }
  };
  const emitLine = () => {
    const seg = currentSeg(st, lh);
    if (!seg) return false;
    st.page.ops.push({ op: 'text', x: seg.x, y: st.y + (lh + size * 0.72) / 2, text: line, font: fnt, color });
    st.y += lh;
    chunkLines++;
    line = '';
    return true;
  };
  while (ti < tokens.length) {
    let seg = currentSeg(st, lh);
    if (!seg || seg.w < 90) {
      const jy = jumpY(st);
      if (jy != null && jy < BOTTOM && jy > st.y) { st.y = jy; continue; }
      flushChunk();
      if (!nextSlot(st)) return { remaining: line + tokens.slice(ti).join('') };
      chunkStartY = st.y; chunkCol = st.col; continue;
    }
    if (st.y + lh > BOTTOM) {
      flushChunk();
      if (!nextSlot(st)) return { remaining: line + tokens.slice(ti).join('') };
      chunkStartY = st.y; chunkCol = st.col; continue;
    }
    const tok = tokens[ti];
    if (st.measure(tok, fnt) > seg.w - 4) {
      if (line) { emitLine(); continue; }
      const chars = Array.from(tok);
      tokens.splice(ti, 1, ...chars);
      continue;
    }
    if (line && st.measure(line + tok, fnt) > seg.w - 4 && !NO_LINE_START.includes(tok[0])) {
      emitLine();
      line = tok.trimStart();
      ti++;
      continue;
    }
    line += tok;
    ti++;
  }
  if (line.trim()) {
    if (st.y + lh > BOTTOM) {
      flushChunk();
      if (!nextSlot(st)) return { remaining: line };
      chunkStartY = st.y; chunkCol = st.col;
    }
    let seg = currentSeg(st, lh);
    if (!seg || seg.w < 90) {
      const jy = jumpY(st);
      if (jy != null && jy < BOTTOM) st.y = jy;
      seg = currentSeg(st, lh);
    }
    if (seg && seg.w >= 90) emitLine();
    else return { remaining: line };
  }
  flushChunk();
  st.y += 12 * s;
  return null;
}


function flowSectionHeading(st, b, idx, kind) {
  const s = st.s;
  const typ = typeSizes(s, st.spec);
  const col = colRect(st);
  const isSection = kind === 'section';
  const size = isSection ? typ.section : typ.heading;
  const fnt = font(size, 900);
  const lh = size * (isSection ? 1.5 : 1.45);
  const barX = isSection && st.mainX != null ? st.mainX : col.x;
  const barW = isSection && st.mainW != null ? st.mainW : col.w;
  const lines = wrapText(b.text, fnt, barW - (isSection ? 40 * s : 22 * s), st.measure);
  const boxH = isSection ? lines.length * lh + 22 * s : lines.length * lh;
  const need = boxH + 3 * st.bodyLH;
  if (isSection && st.col !== 0) return false;
  if (!jumpPastObstacles(st, boxH)) {
    if (!nextSlot(st)) return false;
  }
  const afterPhoto = st.obstacles.some((o) => Math.abs((o.y + o.h) - st.y) < 8);
  const minGap = afterPhoto || (isSection && atTop(st)) ? 22 : 0;
  const top = (atTop(st) ? minGap : (isSection ? 34 * s : 26 * s)) + minGap;
  if (st.y + top + need > BOTTOM) {
    if (!nextSlot(st)) return false;
    jumpPastObstacles(st, boxH);
  }
  st.y += top;
  bumpPastOverlaps(st, { x: barX, y: st.y, w: barW, h: boxH });
  if (st.y + boxH + 3 * st.bodyLH > BOTTOM) {
    if (!nextSlot(st)) return false;
    jumpPastObstacles(st, boxH);
  }
  if (isSection) {
    st.page.frames.push({ id: nextId(st, 'heading'), type: 'heading', x: barX, y: st.y, w: barW, h: boxH, blockIndex: idx });
    st.page.ops.push({ op: 'rect', x: barX, y: st.y, w: barW, h: boxH, fill: PAL.navy });
    let ty = st.y + 11 * s;
    for (const ln of lines) {
      st.page.ops.push({ op: 'text', x: barX + 20 * s, y: ty + (lh + size * 0.72) / 2, text: ln, font: fnt, color: '#ffffff' });
      ty += lh;
    }
    st.y += boxH + 22 * s;
    for (const c of st.cols) c.y = st.y;
    st.col = 0;
  } else {
    st.page.frames.push({ id: nextId(st, 'heading'), type: 'heading', x: col.x, y: st.y, w: col.w, h: boxH, blockIndex: idx });
    st.page.ops.push({ op: 'rect', x: col.x, y: st.y + lh * 0.18, w: 7 * s, h: lines.length * lh - lh * 0.36, fill: PAL.goldLight });
    if (st.spec.timeline && st.railX != null) {
      st.page.ops.push({ op: 'rect', x: st.railX - 5, y: st.y + lh * 0.35, w: 14, h: 14, fill: PAL.gold });
    }
    let ty = st.y;
    for (const ln of lines) {
      st.page.ops.push({ op: 'text', x: col.x + 22 * s, y: ty + (lh + size * 0.72) / 2, text: ln, font: fnt, color: PAL.navy });
      ty += lh;
    }
    st.y += boxH + 8 * s;
  }
  return true;
}


function placeBylineOps(st, b, idx, lines) {
  const s = st.s;
  const col = colRect(st);
  const quoteMode = !!st.spec.quote;
  const size = st.bodySize;
  const fnt = font(size, 700);
  const lh = st.bodyLH;
  const total = lines.length * lh;
  const frameY = st.y;
  st.page.frames.push({ id: nextId(st, 'text'), type: 'text', x: col.x, y: frameY, w: col.w, h: quoteMode ? total + 20 * s : total, blockIndex: idx });
  for (const ln of lines) {
    st.page.ops.push({ op: 'text', x: col.x + col.w, y: st.y + (lh + size * 0.72) / 2, text: ln, font: fnt, color: PAL.gold, align: 'right' });
    st.y += lh;
  }
  if (quoteMode) {
    const lw = Math.min(160 * s, col.w * 0.28);
    st.page.ops.push({ op: 'line', x1: col.x + col.w - lw, y1: st.y + 6 * s, x2: col.x + col.w, y2: st.y + 6 * s, color: PAL.goldLight, width: 2 });
    st.y += 16 * s;
  }
  st.y += 10 * s;
  return true;
}

function flowByline(st, b, idx) {
  const col = colRect(st);
  const size = st.bodySize;
  const fnt = font(size, 700);
  const lh = st.bodyLH;
  const lines = wrapText(b.text, fnt, col.w, st.measure);
  const total = lines.length * lh;
  if (!jumpPastObstacles(st, total)) {
    const pulled = takeLastBodyLines(st, 2);
    if (!nextSlot(st)) return pulled ? { prefix: pulled } : false;
    if (pulled) {
      const left = emitBodyLines(st, pulled, idx);
      if (left) return { prefix: left };
    }
  }
  const aloneAtTop = atTop(st) && st.y + total <= BOTTOM;
  if (st.y + total > BOTTOM || (aloneAtTop && st.col > 0 && st.y <= col.y + 1)) {
    const pulled = takeLastBodyLines(st, 2);
    if (st.y + (pulled ? 2 * lh : 0) + total > BOTTOM) {
      if (!nextSlot(st)) return pulled ? { prefix: pulled } : false;
    }
    if (pulled) {
      const left = emitBodyLines(st, pulled, idx);
      if (left) return { prefix: left };
    }
  }
  if (st.y + total > BOTTOM) {
    const pulled = takeLastBodyLines(st, 2);
    if (!nextSlot(st)) return pulled ? { prefix: pulled } : false;
    if (pulled) {
      const left = emitBodyLines(st, pulled, idx);
      if (left) return { prefix: left };
    }
  }
  return placeBylineOps(st, b, idx, wrapText(b.text, fnt, colRect(st).w, st.measure));
}


function flowNote(st, b, idx) {
  const s = st.s;
  const col = colRect(st);
  const fnt = font(24 * s, 700);
  const lh = 24 * s * 1.6;
  const lines = wrapText(b.text, fnt, col.w, st.measure);
  const total = lines.length * lh + 30 * s;
  if (!jumpPastObstacles(st, total)) {
    if (!nextSlot(st)) return false;
  }
  if (st.y + total > BOTTOM) {
    if (!nextSlot(st)) return false;
  }
  const frameY = st.y;
  st.y += 14 * s;
  st.page.ops.push({ op: 'line', x1: col.x, y1: st.y, x2: col.x + col.w, y2: st.y, color: PAL.line, width: 2 });
  st.y += 10 * s;
  st.page.frames.push({ id: nextId(st, 'note'), type: 'note', x: col.x, y: frameY, w: col.w, h: total, blockIndex: idx });
  for (const ln of lines) {
    st.page.ops.push({ op: 'text', x: col.x, y: st.y + (lh + 24 * s * 0.72) / 2, text: ln, font: fnt, color: PAL.gold });
    st.y += lh;
  }
  return true;
}


function placeFigure(st, b, idx) {
  const s = st.s;
  let col = colRect(st);
  let colW = col.w;
  const spec = st.spec;
  const mode = spec.photo;
  const sz = sizeOf(st.imageSize, b.photoId);
  const kind = photoKind(sz);
  const isWrap = mode === 'alternate' || mode === 'right';
  const isBanner = mode === 'banner';
  const isCard = mode === 'card';
  const bannerPortrait = isBanner && kind === 'portrait';
  const pad = 18 * s;
  const minH = kind === 'portrait' ? 160 * s : Math.max(160 * s, minLandscapeHeight(isWrap ? colW * (spec.photoW || 0.4) : (isCard ? colW - 32 * s : colW)));
  let w, h, ix, iy = st.y;
  let wrapThis = isWrap;
  if (isBanner && !bannerPortrait) {
    const fr = frameSizeForPhoto(sz, colW, Math.min(BOTTOM - iy - 80 * s, colW / PHOTO_ASPECT.landscape), { banner: true });
    w = fr.w; h = fr.h; ix = col.x + (colW - w) / 2;
  } else if (bannerPortrait) {
    const fr = frameSizeForPhoto(sz, colW * 0.5, Math.min(420 * s, BOTTOM - iy - 80 * s));
    w = fr.w; h = fr.h; ix = col.x + (colW - w) / 2;
    wrapThis = false;
  } else if (isCard) {
    const fr = frameSizeForPhoto(sz, colW - 32 * s, Math.min(420 * s, BOTTOM - iy - 80 * s), { banner: kind !== 'portrait' });
    w = fr.w; h = fr.h; ix = col.x + (colW - w) / 2; iy = st.y + (isCard ? 16 * s : 0);
  } else if (isWrap) {
    const maxW = colW * (mode === 'right' ? 0.38 : (spec.photoW || 0.4));
    const fr = frameSizeForPhoto(sz, maxW, 420 * s);
    w = fr.w; h = fr.h;
    const left = mode === 'right' ? false : (st.figIndex % 2 === 0);
    ix = left ? col.x : col.x + colW - w;
    const ov = st.obstacles.filter((o) => o.y < iy + 20 && o.y + o.h > iy && o.x < col.x + colW && o.x + o.w > col.x);
    if (ov.length) iy = Math.max.apply(null, ov.map((o) => o.y + o.h)) + 18 * s;
  } else {
    const maxH = (BOTTOM - TOP_OTHER) * (mode === 'top' ? 0.28 : 0.36);
    const fr = frameSizeForPhoto(sz, colW * (spec.photoW || 1), maxH, { banner: kind !== 'portrait' && (spec.photoW || 1) >= 0.9 });
    w = fr.w; h = fr.h;
    ix = col.x + (colW - w) / 2; iy = st.y;
  }
  const capW = w;
  const capLines = wrapCaption(b.caption, capW, s, st.measure);
  const capH = captionBlockHeight(capLines, s);
  const capSpace = capH ? capH + captionGap(s) : 0;
  const cardExtra = isCard ? 32 * s : 0;
  const total = h + capSpace + cardExtra;
  const roomFor = (y) => BOTTOM - y - capSpace - cardExtra - pad;
  const applyFrame = (maxW, maxH) => {
    const fr = frameSizeForPhoto(sz, maxW, maxH, { banner: isBanner && kind !== 'portrait' });
    w = fr.w; h = fr.h;
  };
  const moveToNext = () => {
    if (!nextSlot(st)) return false;
    col = colRect(st);
    colW = col.w;
    iy = st.y;
    if (isBanner && !bannerPortrait) {
      applyFrame(colW, Math.min(roomFor(iy), colW / PHOTO_ASPECT.landscape));
      ix = col.x + (colW - w) / 2;
    } else if (bannerPortrait) {
      applyFrame(colW * 0.5, Math.min(420 * s, roomFor(iy)));
      ix = col.x + (colW - w) / 2;
    } else if (isCard) {
      applyFrame(colW - 32 * s, Math.min(420 * s, roomFor(iy)));
      ix = col.x + (colW - w) / 2;
      iy = st.y + 16 * s;
    } else if (isWrap) {
      const left = mode === 'right' ? false : (st.figIndex % 2 === 0);
      ix = left ? col.x : col.x + col.w - w;
    } else ix = col.x + (col.w - w) / 2;
    return true;
  };
  if (iy + total + pad > BOTTOM) {
    if (roomFor(iy) < minH && (st.y > col.y + 0.5 || st.col < st.cols.length - 1)) {
      if (!moveToNext()) return 'pageFull';
    }
    if (iy + h + capSpace + cardExtra + pad > BOTTOM) {
      const room = roomFor(iy);
      if (room >= minH) applyFrame(w, room);
      else if (st.y > col.y + 0.5 || st.col < st.cols.length - 1) {
        if (!moveToNext()) return 'pageFull';
        if (iy + h + capSpace + cardExtra + pad > BOTTOM) {
          const room2 = roomFor(iy);
          if (room2 < minH) return 'pageFull';
          applyFrame(w, room2);
        }
      } else if (room >= minH) applyFrame(w, room);
      else return 'pageFull';
      if (isWrap) {
        const left = mode === 'right' ? false : (st.figIndex % 2 === 0);
        ix = left ? col.x : col.x + col.w - w;
      } else ix = col.x + (col.w - w) / 2;
    }
  }
  // 橫圖若被縮到比 16:9 更扁或明顯窄於欄寬，改換欄／換頁，避免裁成細條
  if (kind !== 'portrait' && h + 1 < minLandscapeHeight(w) - 1) {
    if (st.y > col.y + 0.5 || st.col < st.cols.length - 1) {
      if (!moveToNext()) return 'pageFull';
    } else return 'pageFull';
  }
  if (!isWrap && kind !== 'portrait' && w < colW * 0.45 && (st.y > col.y + 0.5 || st.col < st.cols.length - 1)) {
    if (!moveToNext()) return 'pageFull';
  }
  bumpPastOverlaps(st, { x: ix, y: iy, w, h });
  if (st.y > iy + 1) {
    iy = st.y + (isCard ? 16 * s : 0);
    if (iy + h + capSpace + cardExtra + pad > BOTTOM) return 'pageFull';
  }
  const effTotal = h + capSpace + (isCard ? 32 * s : 0);
  if (isCard) {
    const cardX = ix - 16 * s;
    const cardW = w + 32 * s;
    const cardY = iy - 16 * s;
    const cardH = h + capSpace + 32 * s;
    st.page.ops.push({ op: 'rect', x: cardX, y: cardY, w: cardW, h: cardH, fill: PAL.paper });
  }
  const imgFrame = { id: nextId(st, 'image'), type: 'image', x: ix, y: iy, w: w, h: h, locked: false, photoId: b.photoId, fit: 'cover', blockIndex: idx, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y };
  st.page.frames.push(imgFrame);
  st.page.ops.push({ op: 'image', photoId: b.photoId, x: ix, y: iy, w: w, h: h, fit: 'cover', radius: 6, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
  if (capLines.length) {
    const cy = iy + h + captionGap(s);
    if (cy + capH <= BOTTOM + 0.5) {
      const capAlign = wrapThis ? 'left' : 'center';
      st.page.frames.push({ id: nextId(st, 'caption'), type: 'caption', x: ix, y: cy, w: w, h: capH, locked: false, photoId: b.photoId, blockIndex: idx, align: capAlign });
      const clh = captionLineHeight(s);
      const cf = font(captionSize(s));
      for (let i = 0; i < capLines.length; i++) {
        const tx = capAlign === 'left' ? ix : ix + w / 2;
        st.page.ops.push({ op: 'text', x: tx, y: cy + i * clh + captionSize(s), text: capLines[i], font: cf, color: PAL.gray, align: capAlign });
      }
    }
  }
  const wrapPad = 16 * s;
  const leftFig = wrapThis && ix <= col.x + 1;
  st.obstacles.push({
    x: wrapThis ? (leftFig ? ix : ix - wrapPad) : col.x,
    y: isCard ? iy - 16 * s : iy,
    w: wrapThis ? w + wrapPad : (isCard ? w + 32 * s : col.w),
    h: (isCard ? h + capSpace + 32 * s : effTotal) + 8 * s,
  });
  if (wrapThis) st.y = iy;
  else st.y = (isCard ? iy - 16 * s : iy) + (isCard ? h + capSpace + 32 * s : effTotal) + pad;
  st.figIndex++;
  return 'done';
}


function pairCellAspect(sz1, sz2) {
  const k1 = photoKind(sz1);
  const k2 = photoKind(sz2);
  if (k1 === 'portrait' && k2 === 'portrait') return PHOTO_ASPECT.portrait;
  if (k1 === 'landscape' && k2 === 'landscape') return PHOTO_ASPECT.landscape;
  if (k1 === 'square' && k2 === 'square') return PHOTO_ASPECT.square;
  return 1; // 直橫混排用正方格，兩邊都不至於裁過狠
}

function placeFigurePair(st, b1, b2, idx1, idx2) {
  const s = st.s;
  const gap = 24;
  let col = colRect(st);
  const w = (col.w - gap) / 2;
  const sz1 = sizeOf(st.imageSize, b1.photoId);
  const sz2 = sizeOf(st.imageSize, b2.photoId);
  const aspect = pairCellAspect(sz1, sz2);
  let h = w / aspect;
  const c1 = wrapCaption(b1.caption, w, s, st.measure);
  const c2 = wrapCaption(b2.caption, w, s, st.measure);
  const ch1 = captionBlockHeight(c1, s);
  const ch2 = captionBlockHeight(c2, s);
  const capMax = Math.max(ch1, ch2);
  const capPair = capMax ? capMax + captionGap(s) : 0;
  let rowH = h + capPair;
  const pad = 18 * s;
  let y0 = st.y;
  const minRow = 160 * s + capPair;
  if (y0 + rowH + pad > BOTTOM) {
    if (BOTTOM - y0 - pad < minRow && !atTop(st)) {
      if (!nextSlot(st)) return 'pageFull';
      col = colRect(st); y0 = col.y;
    }
    if (y0 + rowH + pad > BOTTOM) {
      const room = BOTTOM - y0 - pad - capPair;
      if (room < 80 * s) return 'pageFull';
      // 保持格子比例，不夠高就換欄／換頁，不把直圖壓成橫框
      const newAspect = w / room;
      if (newAspect > aspect + 0.08) {
        if (!atTop(st) && nextSlot(st)) {
          col = colRect(st); y0 = col.y;
        } else return 'pageFull';
      } else {
        h = room;
        rowH = h + capPair;
      }
    }
  }
  const items = [[b1, idx1, col.x, c1], [b2, idx2, col.x + w + gap, c2]];
  const cy = y0 + h + captionGap(s);
  const clh = captionLineHeight(s);
  const cf = font(captionSize(s));
  for (const it of items) {
    const bb = it[0]; const bi = it[1]; const xx = it[2]; const caps = it[3];
    st.page.frames.push({ id: nextId(st, 'image'), type: 'image', x: xx, y: y0, w: w, h: h, locked: false, photoId: bb.photoId, fit: 'cover', blockIndex: bi, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    st.page.ops.push({ op: 'image', photoId: bb.photoId, x: xx, y: y0, w: w, h: h, fit: 'cover', radius: 6, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    if (caps.length && cy + captionBlockHeight(caps, s) <= BOTTOM + 0.5) {
      st.page.frames.push({ id: nextId(st, 'caption'), type: 'caption', x: xx, y: cy, w: w, h: captionBlockHeight(caps, s), locked: false, photoId: bb.photoId, blockIndex: bi, align: 'left' });
      for (let i = 0; i < caps.length; i++) st.page.ops.push({ op: 'text', x: xx, y: cy + i * clh + captionSize(s), text: caps[i], font: cf, color: PAL.gray });
    }
  }
  st.obstacles.push({ x: col.x, y: y0, w: col.w, h: rowH });
  st.y = y0 + rowH + pad;
  st.figIndex += 2;
  return 'done';
}


function placeCollageTrio(st, figs) {
  const s = st.s;
  const gap = 20;
  const col = colRect(st);
  const [a, b, c] = figs;
  const smallW = (col.w - gap) * 0.38;
  const largeW = col.w - gap - smallW;
  const szA = sizeOf(st.imageSize, a.b.photoId);
  const szB = sizeOf(st.imageSize, b.b.photoId);
  const szC = sizeOf(st.imageSize, c.b.photoId);
  const largeFr = frameSizeForPhoto(szA, largeW, Math.min(520 * s, BOTTOM - st.y - 80 * s));
  const smallH = (largeFr.h - gap) / 2;
  const smallAspect = smallW / smallH;
  const cellOk = (sz, ww, hh) => {
    const kind = photoKind(sz);
    const fr = ww / Math.max(1, hh);
    if (kind === 'portrait' && fr > 1.15) return false;
    if (kind === 'landscape' && (fr < 0.9 || fr > PHOTO_ASPECT.bannerMax + 0.05)) return false;
    return true;
  };
  if (smallH < 70 * s || !cellOk(szA, largeFr.w, largeFr.h) || !cellOk(szB, smallW, smallH) || !cellOk(szC, smallW, smallH)) return 'fallback';
  const y0 = st.y;
  const totalH = largeFr.h;
  if (y0 + totalH + 60 * s > BOTTOM && !atTop(st)) {
    if (!nextSlot(st)) return 'pageFull';
    return placeCollageTrio(st, figs);
  }
  const items = [
    { ...a, x: col.x, y: y0, w: largeFr.w, h: largeFr.h },
    { ...b, x: col.x + largeFr.w + gap, y: y0, w: smallW, h: smallH },
    { ...c, x: col.x + largeFr.w + gap, y: y0 + smallH + gap, w: smallW, h: smallH },
  ];
  const capRoom = 40 * s;
  for (const it of items) {
    const caps = wrapCaption(it.b.caption, it.w, s, st.measure);
    const capH = captionBlockHeight(caps, s);
    st.page.frames.push({ id: nextId(st, 'image'), type: 'image', x: it.x, y: it.y, w: it.w, h: it.h, locked: false, photoId: it.b.photoId, fit: 'cover', blockIndex: it.idx, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    st.page.ops.push({ op: 'image', photoId: it.b.photoId, x: it.x, y: it.y, w: it.w, h: it.h, fit: 'cover', radius: 6, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    if (caps.length && it.y + it.h + captionGap(s) + capH <= BOTTOM + capRoom) {
      const cy = it.y + it.h + captionGap(s);
      st.page.frames.push({ id: nextId(st, 'caption'), type: 'caption', x: it.x, y: cy, w: it.w, h: capH, locked: false, photoId: it.b.photoId, blockIndex: it.idx, align: 'left' });
      caps.forEach((ln, i) => { st.page.ops.push({ op: 'text', x: it.x, y: cy + i * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: PAL.gray }); });
    }
  }
  const bottom = Math.max(y0 + largeFr.h, y0 + smallH * 2 + gap) + capRoom;
  st.obstacles.push({ x: col.x, y: y0, w: col.w, h: bottom - y0 });
  st.y = bottom + 18 * s;
  st.figIndex += 3;
  return 'done';
}


function flowOnePage(st, blocks, startIdx) {
  let idx = startIdx;
  while (idx < blocks.length) {
    const b = blocks[idx];
    if (!b || b.type === 'video') { idx++; continue; }
    if (b.type === 'figure' && st.spec.photo === 'grid') {
      const nxt = [];
      for (let k = idx; k < blocks.length && blocks[k].type === 'figure' && nxt.length < 5; k++) nxt.push({ b: blocks[k], idx: k });
      if (nxt.length === 5) {
        const r = placeFigurePair(st, nxt[0].b, nxt[1].b, nxt[0].idx, nxt[1].idx);
        if (r === 'pageFull') break;
        idx += 2; continue;
      }
      if (nxt.length === 3) {
        if (st.figIndex >= 2) {
          const r = placeFigure(st, nxt[0].b, nxt[0].idx);
          if (r === 'pageFull') break;
          idx += 1; continue;
        }
        const r = placeCollageTrio(st, nxt.slice(0, 3));
        if (r === 'pageFull' || r === 'fallback') {
          const r2 = placeFigurePair(st, nxt[0].b, nxt[1].b, nxt[0].idx, nxt[1].idx);
          if (r2 === 'pageFull') break;
          idx += 2; continue;
        }
        idx += 3; continue;
      }
      if (nxt.length >= 2) {
        const r = placeFigurePair(st, nxt[0].b, nxt[1].b, nxt[0].idx, nxt[1].idx);
        if (r === 'pageFull') break;
        idx += 2; continue;
      }
    }
    if (b.type === 'figure') {
      const r = placeFigure(st, b, idx);
      if (r === 'pageFull') break;
      idx++; continue;
    }
    if (b.type === 'para') {
      const r = flowPara(st, b, idx);
      if (r && r.remaining != null && r.remaining.trim()) { blocks[idx] = { ...b, text: r.remaining }; break; }
      idx++; continue;
    }
    if (b.type === 'section') { if (!flowSectionHeading(st, b, idx, 'section')) break; idx++; continue; }
    if (b.type === 'heading') {
      const snap = { col: st.col, y: st.y, frames: st.page.frames.length, ops: st.page.ops.length };
      if (!flowSectionHeading(st, b, idx, 'heading')) break;
      const next = blocks[idx + 1];
      if (next && next.type === 'para') {
        const headingCol = st.col;
        const headingY = st.y;
        const r = flowPara(st, next, idx + 1);
        const sameColLines = (st.page.ops || []).filter((o) => o.op === 'text' && o.color === PAL.text && o.y >= headingY - 2 && o.x >= st.cols[headingCol].x - 4 && o.x <= st.cols[headingCol].x + st.cols[headingCol].w).length;
        if (sameColLines < 1) {
          // 標題與內文被拆到不同欄：撤回後改與內文一起換欄／換頁
          st.page.frames.length = snap.frames;
          st.page.ops.length = snap.ops;
          st.col = snap.col;
          st.y = snap.y;
          if (!nextSlot(st)) break;
          continue;
        }
        if (r && r.remaining != null && r.remaining.trim()) { blocks[idx + 1] = { ...next, text: r.remaining }; idx += 1; break; }
        idx += 2; continue;
      }
      idx++; continue;
    }
    if (b.type === 'byline') {
      const r = flowByline(st, b, idx);
      if (r && r.prefix) {
        blocks.splice(idx, 0, { type: 'para', text: r.prefix, materialId: b.materialId });
        break;
      }
      if (!r) break;
      idx++; continue;
    }
    if (b.type === 'note') { if (!flowNote(st, b, idx)) break; idx++; continue; }
    const r = flowPara(st, { ...b, text: String(b.text ?? '') }, idx);
    if (r && r.remaining != null && r.remaining.trim()) { blocks[idx] = { ...b, text: r.remaining }; break; }
    idx++;
  }
  return idx;
}


/**
 * input: {
 *   data: { title, kicker }, metaLine, cover: { photoId, caption } | null, blocks,
 *   layout: 'classic'|'alternate'|'columns'|...（見 LAYOUTS）, scale, measure, imageSize(photoId) → {w,h}|null
 * }
 * 回傳 { pages: [{ index, frames: [{ id, type, x, y, w, h, locked?, photoId?, blockIndex? }], ops: [...] }] }
 */
/**
 * header：false 時是接續頁（A4 自訂每頁內容的第 2 頁以後）：不畫大標題、meta 與主圖，從頁面上方直接排內文
 */
function placePullQuote(page, text, y, s, measure, pageIndex, typ, opts) {
  const typo = typ || typeSizes(s);
  const qSize = typo.body * 1.8;
  const markSize = typo.body * 2.4;
  const x0 = opts && opts.x != null ? opts.x : MARGIN;
  const CW = opts && opts.w != null ? opts.w : A4.width - 2 * MARGIN;
  const markW = 56 * s;
  const fnt = font(qSize, 500);
  const lines = wrapText('「' + text + '」', fnt, CW - markW, measure);
  const lh = qSize * 1.45;
  const boxH = lines.length * lh + 28 * s;
  if (!(opts && opts.skipFrame)) {
    const id = 'p' + pageIndex + '-quote-1';
    page.frames.push({ id, type: 'quote', x: x0, y, w: CW, h: boxH, locked: false, text });
  }
  page.ops.push({ op: 'text', x: x0, y: y + markSize * 0.85, text: '「', font: font(markSize, 700), color: PAL.goldLight });
  let ty = y + 10 * s;
  for (const ln of lines) {
    page.ops.push({ op: 'text', x: x0 + markW, y: ty + qSize, text: ln, font: fnt, color: PAL.navy });
    ty += lh;
  }
  page.ops.push({ op: 'line', x1: x0 + markW, y1: ty + 4 * s, x2: x0 + markW + Math.min(180 * s, CW * 0.25), y2: ty + 4 * s, color: PAL.goldLight, width: 3 });
  return ty + 28 * s;
}

function sidebarPayload(data, metaLine, blocks, cover) {
  const items = [];
  const dateText = data && (data.date || data.end_date) ? [data.date, data.end_date].filter(Boolean).join(' 至 ') : '';
  if (dateText) items.push({ label: '日期', text: dateText });
  else if (metaLine) {
    const part = String(metaLine).split(/\n|　/)[0];
    if (part && !part.startsWith('作者')) items.push({ label: '日期', text: part });
  }
  if (data && data.place) items.push({ label: '地點', text: data.place });
  const toc = [];
  for (const b of blocks || []) {
    if ((b.type === 'section' || b.type === 'heading') && b.text) toc.push(b.text);
  }
  return {
    items,
    toc,
    quote: pickPullQuote(blocks),
    photoId: cover && cover.photoId ? cover.photoId : null,
  };
}

function drawSidebar(page, box, payload, s, measure, imageSize) {
  const p = payload || {};
  page.ops.push({ op: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, fill: PAL.paper });
  page.ops.push({ op: 'line', x1: box.x + box.w, y1: box.y, x2: box.x + box.w, y2: box.y + box.h, color: PAL.line, width: 2 });
  const inner = box.w - 32;
  let sy = box.y + 22 * s;
  const titleF = font(22 * s, 700);
  const labelF = font(16 * s, 700);
  const bodyF = font(20 * s);
  const add = (text, fnt, color, lhMul) => {
    for (const ln of wrapText(text, fnt, inner, measure)) {
      if (sy + 22 * s > box.y + box.h - 8) return false;
      page.ops.push({ op: 'text', x: box.x + 16, y: sy + 20 * s, text: ln, font: fnt, color });
      sy += 20 * s * (lhMul || 1.45);
    }
    return true;
  };
  if (!add('本期要目', titleF, PAL.navy, 1.6)) return;
  sy += 8 * s;
  for (const it of p.items || []) {
    if (!add(it.label, labelF, PAL.gold, 1.3)) return;
    if (!add(it.text, bodyF, PAL.text, 1.45)) return;
    sy += 8 * s;
  }
  if ((p.toc || []).length) {
    if (!add('目錄', labelF, PAL.gold, 1.3)) return;
    for (const t of p.toc) {
      if (!add('・' + t, bodyF, PAL.gray, 1.4)) return;
    }
    sy += 8 * s;
  }
  if (p.quote) {
    if (!add('金句', labelF, PAL.gold, 1.3)) return;
    if (!add('「' + p.quote + '」', bodyF, PAL.navy, 1.45)) return;
  }
}

function collectSpreadPhotos(cover, list) {
  const photos = [];
  const seen = new Set();
  const add = (photoId, caption, blockIndex) => {
    if (!photoId || seen.has(photoId)) return;
    seen.add(photoId);
    photos.push({ photoId, caption: trimCaption(caption), blockIndex });
  };
  if (cover && cover.photoId) add(cover.photoId, cover.caption, null);
  list.forEach((b, i) => { if (b && b.type === 'figure') add(b.photoId, b.caption, i); });
  return photos;
}

function drawSpreadHeader(page, data, metaLine, geom, s, measure, pageIndex, spec) {
  const typ = typeSizes(s, spec);
  const x = geom.textX;
  const CW = geom.paneW;
  let n = 0;
  const hid = (t) => 'p' + pageIndex + '-' + t + '-' + (++n);
  let y = TOP_FIRST;
  if (data.kicker) {
    const f = font(typ.kicker, 700);
    page.frames.push({ id: hid('kicker'), type: 'meta', x, y, w: CW, h: typ.kicker + 18 * s, locked: false });
    page.ops.push({ op: 'text', x, y: y + typ.kicker, text: data.kicker, font: f, color: PAL.gold });
    y += typ.kicker + 18 * s;
  }
  const titleSize = typ.title;
  const tf = font(titleSize, 900);
  const tlines = data.title ? wrapText(data.title, tf, CW, measure) : [];
  const tlh = titleSize * 1.35;
  if (tlines.length) {
    page.frames.push({ id: hid('title'), type: 'title', x, y, w: CW, h: tlines.length * tlh, locked: false });
    for (const ln of tlines) { page.ops.push({ op: 'text', x, y: y + titleSize, text: ln, font: tf, color: PAL.navy }); y += tlh; }
  }
  y += 10 * s;
  const mf = font(typ.meta);
  const mlines = wrapText(metaLine || '', mf, CW, measure);
  if (mlines.length) {
    page.frames.push({ id: hid('meta'), type: 'meta', x, y, w: CW, h: mlines.length * typ.meta * 1.6, locked: false });
    for (const ln of mlines) { page.ops.push({ op: 'text', x, y: y + typ.meta, text: ln, font: mf, color: PAL.gray }); y += typ.meta * 1.6; }
  }
  y += 14 * s;
  page.ops.push({ op: 'line', x1: x, y1: y, x2: x + CW, y2: y, color: PAL.line, width: 2 });
  y += 24 * s;
  return y;
}

function placeSpreadPhotos(page, photos, geom, s, measure, pageIndex, imageSize) {
  let y = MARGIN;
  let placed = 0;
  let n = page.frames.length;
  const hid = (t) => 'p' + pageIndex + '-' + t + '-' + (++n);
  for (const photo of photos) {
    if (!photo) continue;
    const sz = sizeOf(imageSize, photo.photoId);
    const capLines = wrapCaption(photo.caption, geom.paneW, s, measure);
    const capH = captionBlockHeight(capLines, s);
    const capSpace = capH ? capH + captionGap(s) : 0;
    const room = BOTTOM - y - capSpace - 12 * s;
    if (room < 140 * s && placed) break;
    if (room < 80 * s) break;
    const fr = frameSizeForPhoto(sz, geom.paneW, room);
    const xx = geom.photoX + (geom.paneW - fr.w) / 2;
    page.frames.push({ id: hid('image'), type: 'image', x: xx, y, w: fr.w, h: fr.h, locked: false, photoId: photo.photoId, fit: 'cover', blockIndex: photo.blockIndex, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    page.ops.push({ op: 'image', photoId: photo.photoId, x: xx, y, w: fr.w, h: fr.h, fit: 'cover', radius: 8, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
    if (capLines.length) {
      const cy = y + fr.h + captionGap(s);
      if (cy + capH <= BOTTOM + 0.5) {
        page.frames.push({ id: hid('caption'), type: 'caption', x: xx, y: cy, w: fr.w, h: capH, locked: false, photoId: photo.photoId, blockIndex: photo.blockIndex, align: 'left' });
        const lh = captionLineHeight(s);
        const cf = font(captionSize(s));
        capLines.forEach((ln, i) => { page.ops.push({ op: 'text', x: xx, y: cy + i * lh + captionSize(s), text: ln, font: cf, color: PAL.gray, align: 'left' }); });
      }
    }
    y += fr.h + capSpace + 16 * s;
    placed++;
  }
  return placed;
}

function placeSpreadPhotoTail(pages, photos, s, measure, startPage, imageSize) {
  const gap = 24;
  const cellW = (A4.width - 2 * MARGIN - gap) / 2;
  let i = 0;
  let pageIndex = pages.length;
  while (i < photos.length) {
    const page = { index: pageIndex, frames: [], ops: [] };
    let y = TOP_OTHER;
    let placed = 0;
    while (i < photos.length) {
      const a = photos[i];
      const b = photos[i + 1] || null;
      const szA = sizeOf(imageSize, a.photoId);
      const szB = b ? sizeOf(imageSize, b.photoId) : null;
      const aspect = b ? pairCellAspect(szA, szB) : frameAspectFor(szA);
      const capA = wrapCaption(a.caption, b ? cellW : A4.width - 2 * MARGIN, s, measure);
      const capB = b ? wrapCaption(b.caption, cellW, s, measure) : [];
      const capMax = Math.max(captionBlockHeight(capA, s), captionBlockHeight(capB, s));
      const capPair = capMax ? capMax + captionGap(s) : 0;
      const maxH = BOTTOM - y - capPair - 18 * s;
      if (maxH < 160 * s && placed) break;
      if (maxH < 80 * s) break;
      let w = b ? cellW : Math.min(A4.width - 2 * MARGIN, maxH * aspect);
      let h = w / aspect;
      if (h > maxH) { h = maxH; w = h * aspect; }
      const rowH = h + capPair;
      if (b) {
        const items = [[a, capA, MARGIN + (cellW - w) / 2], [b, capB, MARGIN + cellW + gap + (cellW - w) / 2]];
        const cy = y + h + captionGap(s);
        for (const it of items) {
          const photo = it[0]; const caps = it[1]; const xx = it[2];
          page.frames.push({ id: 'p' + pageIndex + '-image-' + (++placed), type: 'image', x: xx, y, w, h, locked: false, photoId: photo.photoId, fit: 'cover', blockIndex: photo.blockIndex, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
          page.ops.push({ op: 'image', photoId: photo.photoId, x: xx, y, w, h, fit: 'cover', radius: 8, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
          if (caps.length && cy + captionBlockHeight(caps, s) <= BOTTOM + 0.5) {
            page.frames.push({ id: 'p' + pageIndex + '-caption-' + placed, type: 'caption', x: xx, y: cy, w, h: captionBlockHeight(caps, s), locked: false, photoId: photo.photoId, blockIndex: photo.blockIndex, align: 'left' });
            caps.forEach((ln, n) => { page.ops.push({ op: 'text', x: xx, y: cy + n * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: PAL.gray, align: 'left' }); });
          }
        }
        i += 2;
      } else {
        const fr = frameSizeForPhoto(szA, A4.width - 2 * MARGIN, maxH);
        const xx = MARGIN + (A4.width - 2 * MARGIN - fr.w) / 2;
        const cy = y + fr.h + captionGap(s);
        page.frames.push({ id: 'p' + pageIndex + '-image-' + (++placed), type: 'image', x: xx, y, w: fr.w, h: fr.h, locked: false, photoId: a.photoId, fit: 'cover', blockIndex: a.blockIndex, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
        page.ops.push({ op: 'image', photoId: a.photoId, x: xx, y, w: fr.w, h: fr.h, fit: 'cover', radius: 8, focusX: DEFAULT_FOCUS_X, focusY: DEFAULT_FOCUS_Y });
        if (capA.length && cy + captionBlockHeight(capA, s) <= BOTTOM + 0.5) {
          page.frames.push({ id: 'p' + pageIndex + '-caption-' + placed, type: 'caption', x: xx, y: cy, w: fr.w, h: captionBlockHeight(capA, s), locked: false, photoId: a.photoId, blockIndex: a.blockIndex, align: 'left' });
          capA.forEach((ln, n) => { page.ops.push({ op: 'text', x: xx, y: cy + n * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: PAL.gray, align: 'left' }); });
        }
        i += 1;
      }
      y += rowH + 18 * s;
    }
    if (!placed) break;
    pages.push(page);
    pageIndex++;
  }
}

function blockChars(b) {
  return Array.from(String((b && b.text) || '').replace(/\s+/g, '')).length;
}

function splitBlocksByShare(list, n) {
  if (n <= 1) return [list.slice()];
  const total = list.reduce((a, b) => a + blockChars(b), 0);
  const share = Math.max(1, total / n);
  const groups = Array.from({ length: n }, () => []);
  let g = 0;
  let used = 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    groups[g].push(b);
    used += blockChars(b);
    const isHead = b.type === 'heading' || b.type === 'section';
    const next = list[i + 1];
    const keepWith = b.type === 'byline' || (next && next.type === 'byline');
    if (g < n - 1 && used >= share * (g + 1) && !isHead && !keepWith) g++;
  }
  return groups;
}

function layoutSpread({ data, metaLine, cover, blocks, scale, measure, imageSize, header, startPage, targetPages }) {
  const s = scale || 1;
  const spec = LAYOUT_SPECS.spread;
  const typ = typeSizes(s, spec);
  const list = (blocks || []).filter((b) => b && b.type !== 'figure' && b.type !== 'video' && String(b.text ?? '').trim()).map((b) => ({ ...b }));
  const photos = collectSpreadPhotos(cover, blocks || []);
  const bodySize = typ.body;
  const bodyLH = typ.bodyLH;
  const bf = font(bodySize);
  const textChars = list.reduce((a, b) => a + blockChars(b), 0);
  const shortText = textChars <= 380;
  const nTextPages = Math.max(1, Math.ceil(textChars / 700));
  const photosPerPage = shortText ? 1 : Math.min(3, photos.length > nTextPages ? Math.ceil(photos.length / nTextPages) : 1);
  const nPhotoPages = Math.max(1, Math.ceil((photos.length || 1) / photosPerPage));
  const nSplit = shortText ? 1 : Math.max(nTextPages, nPhotoPages > 1 ? nPhotoPages : 1);
  const groups = splitBlocksByShare(list, nSplit);
  const pages = [];
  let groupIdx = 0;
  let overflow = [];
  let photoIdx = 0;
  let pageIndex = 0;
  const pending = () => overflow.length || groupIdx < groups.length;
  while (pending() || pageIndex === 0) {
    if (pageIndex > 200) break;
    const isFirst = pageIndex === 0;
    const absPage = (startPage || 0) + pageIndex;
    const page = { index: pageIndex, frames: [], ops: [] };
    pages.push(page);
    const wantPhotos = photoIdx < photos.length && (pending() || isFirst || !shortText);
    let yAfter;
    let geom;
    let usedPhotos = 0;
    if (wantPhotos) {
      const pane = spreadPane(absPage);
      if (isFirst && header) yAfter = drawSpreadHeader(page, data, metaLine, pane, s, measure, pageIndex, spec);
      else yAfter = TOP_OTHER;
      geom = geometryFor(spec, yAfter, absPage, { hasPhoto: true });
      usedPhotos = placeSpreadPhotos(page, photos.slice(photoIdx, photoIdx + photosPerPage), pane, s, measure, pageIndex, imageSize);
      photoIdx += usedPhotos;
    } else if (isFirst && header) {
      yAfter = buildHeader(page, data, metaLine, null, spec, s, measure, imageSize, true, pageIndex);
      geom = geometryFor(spec, yAfter, absPage, { hasPhoto: false });
    } else {
      yAfter = TOP_OTHER;
      geom = geometryFor(spec, yAfter, absPage, { hasPhoto: false });
    }
    if (yAfter > BOTTOM) { pageIndex++; if (!pending()) break; continue; }
    const chunk = overflow.concat(groupIdx < groups.length ? groups[groupIdx++] : []);
    overflow = [];
    const st = makeState(page, spec, geom.cols, { s, measure, imageSize, pageIndex, bodySize, bodyLH, bf, mainX: geom.mainX, mainW: geom.mainW });
    const framesBefore = page.frames.length;
    const roomy = BOTTOM - (geom.cols[0] ? geom.cols[0].y : TOP_OTHER) >= 200;
    const nextIdx = flowOnePage(st, chunk, 0);
    if (nextIdx < chunk.length) overflow = chunk.slice(nextIdx);
    else if (chunk.length && nextIdx === 0 && page.frames.length === framesBefore && roomy) { const b = chunk[0]; const empty = !b || (b.type !== "figure" && b.type !== "heading" && b.type !== "section" && b.type !== "byline" && !String(b.text || "").trim()); if (empty) overflow = chunk.slice(1); else overflow = chunk.slice(); }
    pageIndex++;
    if (!pending() && (shortText || photoIdx >= photos.length)) break;
    if (!pending() && photoIdx < photos.length) break;
  }
  if (photoIdx < photos.length) placeSpreadPhotoTail(pages, photos.slice(photoIdx), s, measure, startPage, imageSize);
  return { pages };
}

export function layoutA4({ data, metaLine, cover, blocks, layout = 'classic', scale = 1, measure, imageSize, header = true, startPage = 0, theme = null, targetPages = null }) {
  return runWithTheme(theme, () => layoutA4Inner({ data, metaLine, cover, blocks, layout, scale, measure, imageSize, header, startPage, targetPages }));
}
function gatherFiguresForCollage(list) {
  const figs = list.filter((b) => b && b.type === 'figure');
  const rest = list.filter((b) => b && b.type !== 'figure');
  let i = 0;
  while (i < rest.length && (rest[i].type === 'section' || rest[i].type === 'heading')) i++;
  return rest.slice(0, i).concat(figs, rest.slice(i));
}
function layoutA4Inner({ data, metaLine, cover, blocks, layout = 'classic', scale = 1, measure, imageSize, header = true, startPage = 0, targetPages = null }) {
  const s = scale || 1;
  const spec = specFor(layout);
  const m = measure || fallbackMeasure;
  const imgSize = imageSize || (() => ({ w: 4, h: 3 }));
  const d = data || {};
  const list = Array.isArray(blocks) ? blocks.map((b) => ({ ...b })) : [];
  if (spec.spread) return layoutSpread({ data: d, metaLine: metaLine || '', cover, blocks: list, scale: s, measure: m, imageSize: imgSize, header, startPage, targetPages });
  const headerCover = usesHeaderCover(spec);
  if (header && !headerCover) insertInlineCover(list, cover, spec);
  if (spec.photo === 'grid') {
    const gathered = gatherFiguresForCollage(list);
    list.length = 0;
    list.push(...gathered);
  }
  const typ = typeSizes(s, spec);
  const bodySize = typ.body;
  const bodyLH = typ.bodyLH;
  const bf = font(bodySize);
  const pages = [];
  let idx = 0;
  let pageIndex = 0;
  while (idx < list.length || pageIndex === 0) {
    if (pageIndex > 200) break;
    const isFirst = pageIndex === 0;
    const page = { index: pageIndex, frames: [], ops: [] };
    pages.push(page);
    const yAfter = buildHeader(page, d, metaLine || '', headerCover ? cover : null, spec, s, m, imgSize, header && isFirst, pageIndex, targetPages);
    let yBody = yAfter;
    if (spec.quote && header && isFirst) {
      const quote = pickPullQuote(list);
      if (quote) yBody = placePullQuote(page, quote, yAfter, s, m, pageIndex, typ);
    }
    const geom = geometryFor(spec, yBody);
    if (spec.sidebar) {
      const sbY = yBody;
      const sbH = Math.max(0, BOTTOM - sbY);
      if (sbH > 40) {
        const payload = sidebarPayload(d, metaLine || '', list, cover);
        page.frames.push({ id: 'p' + pageIndex + '-note-sidebar', type: 'note', x: MARGIN, y: sbY, w: 240, h: sbH, locked: true, sidebar: true, sidebarPayload: payload });
        drawSidebar(page, { x: MARGIN, y: sbY, w: 240, h: sbH }, payload, s, m, imgSize);
      }
    }
    if (spec.timeline && geom.railX != null) {
      page.ops.push({ op: 'line', x1: geom.railX, y1: yBody, x2: geom.railX, y2: BOTTOM, color: PAL.line, width: 3 });
    }
    if (yBody > BOTTOM) {
      pageIndex++;
      if (idx >= list.length) break;
      continue;
    }
    const st = makeState(page, spec, geom.cols, { s, measure: m, imageSize: imgSize, pageIndex, bodySize, bodyLH, bf, railX: geom.railX, mainX: geom.mainX, mainW: geom.mainW });
    const framesBefore = page.frames.length;
    const roomy = BOTTOM - (geom.cols[0] ? geom.cols[0].y : TOP_OTHER) >= 200;
    const nextIdx = flowOnePage(st, list, idx);
    if (nextIdx > idx) idx = nextIdx;
    else if (idx < list.length && page.frames.length === framesBefore && roomy) {
      const b = list[idx];
      const empty = !b || b.type === 'video' || (b.type !== 'figure' && b.type !== 'heading' && b.type !== 'section' && b.type !== 'byline' && !String(b.text || '').trim());
      if (empty) idx++;
    }
    pageIndex++;
    if (idx >= list.length) break;
  }
  return { pages };
}


/**
 * reflowPage(page, frames, ctx)
 * page: layoutA4 回傳的某一頁（或含 blocks / sourceBlocks 的頁物件）；frames: 使用者改過位置／大小後的新固定框陣列
 * （type 為 title/meta/image/caption 的框，及 blockIndex 為空的 note 框；text/heading/note 流排框會被重新產生，不必傳入）。
 * ctx: { measure, imageSize, scale, layout, data, metaLine, cover, blocks }
 * 回傳 { page: { index, frames, ops }, overflow: [未排完的區塊，para 會是剩餘文字], pages: [page] }。
 * 固定框一律視為障礙物，內文逐行在欄位減去障礙物的可用段落裡重排；排不下的文字以 overflow 交給下一頁。
 */
export function reflowPage(page, frames, ctx) {
  const c = ctx || {};
  if (c.theme) return runWithTheme(c.theme, () => reflowPageInner(page, frames, ctx));
  return reflowPageInner(page, frames, ctx);
}
function reflowPageInner(page, frames, ctx) {
  const c = ctx || {};
  const s = c.scale || 1;
  const spec = specFor(c.layout || page.layout || 'classic');
  const m = c.measure || fallbackMeasure;
  const imgSize = c.imageSize || (() => ({ w: 4, h: 3 }));
  const blocksSrc = page.blocks || page.sourceBlocks || c.blocks || [];
  const list = blocksSrc.filter((b) => b && b.type !== 'figure' && b.type !== 'video').map((b) => ({ ...b }));
  const fixed = (frames || page.frames || []).filter((f) => f && (f.type === 'title' || f.type === 'meta' || f.type === 'image' || f.type === 'caption' || f.type === 'quote' || (f.type === 'note' && f.blockIndex == null)));
  let top = (page.index || 0) === 0 ? TOP_FIRST : TOP_OTHER;
  const headerFrames = fixed.filter((f) => f.type === 'title' || f.type === 'meta' || (((f.type === 'image') || (f.type === 'caption')) && f.blockIndex == null && !(f.type === 'image' && f.h > 1500)));
  if (headerFrames.length) top = Math.max.apply(null, headerFrames.map((f) => f.y + f.h)) + 22 * s;
  if (top > BOTTOM) top = BOTTOM + 1;
  const newPage = { index: page.index || 0, frames: [...fixed], ops: [] };
  const data = c.data || page.data || {};
  const metaLine = c.metaLine || page.metaLine || '';
  const cover = c.cover || page.cover || null;
  for (const f of fixed) {
    const typ = typeSizes(s, spec);
    if (f.type === 'image') {
      newPage.ops.push({ op: 'image', photoId: f.photoId, x: f.x, y: f.y, w: f.w, h: f.h, fit: f.fit || 'cover', radius: 8, focusX: f.focusX != null ? f.focusX : DEFAULT_FOCUS_X, focusY: f.focusY != null ? f.focusY : DEFAULT_FOCUS_Y });
    } else if (f.type === 'title') {
      const titleSize = typ.title;
      const tf = font(titleSize, 900);
      const lines = data.title ? wrapText(data.title, tf, f.w, m) : [];
      const lh = titleSize * 1.35;
      lines.forEach((ln, i) => { newPage.ops.push({ op: 'text', x: f.x, y: f.y + i * lh + titleSize, text: ln, font: tf, color: PAL.navy }); });
    } else if (f.type === 'quote') {
      placePullQuote(newPage, f.text || pickPullQuote(blocksSrc), f.y, s, m, newPage.index, typ, { skipFrame: true, x: f.x, w: f.w });
    } else if (f.type === 'meta') {
      const isKicker = f.id && String(f.id).includes('kicker');
      const txt = isKicker ? (data.kicker || '') : metaLine;
      const ff = font(isKicker ? typ.kicker : typ.meta, isKicker ? 700 : 400);
      const lines = txt ? wrapText(txt, ff, f.w, m) : [];
      const lsz = isKicker ? typ.kicker : typ.meta;
      lines.forEach((ln, i) => { newPage.ops.push({ op: 'text', x: f.x, y: f.y + i * lsz * 1.6 + lsz, text: ln, font: ff, color: isKicker ? PAL.gold : PAL.gray }); });
    } else if (f.type === 'caption') {
      let cap = '';
      if (cover && cover.photoId === f.photoId) cap = trimCaption(cover.caption);
      if (!cap) {
        const fb = blocksSrc.find((b) => b && b.photoId === f.photoId);
        if (fb) cap = trimCaption(fb.caption);
      }
      const lines = wrapCaption(cap, f.w, s, m);
      const align = f.align || 'center';
      const cf = font(captionSize(s));
      const lh = captionLineHeight(s);
      lines.forEach((ln, i) => { newPage.ops.push({ op: 'text', x: align === 'left' ? f.x : f.x + f.w / 2, y: f.y + i * lh + captionSize(s), text: ln, font: cf, color: PAL.gray, align }); });
    } else if (f.type === 'note') {
      if (f.sidebar) drawSidebar(newPage, { x: f.x, y: f.y, w: f.w, h: f.h }, f.sidebarPayload || sidebarPayload(data, metaLine, blocksSrc, cover), s, m, imgSize);
      else newPage.ops.push({ op: 'rect', x: f.x, y: f.y, w: f.w, h: f.h, fill: PAL.paper });
    }
  }
  if (top > BOTTOM || !list.length) return { page: newPage, overflow: [], pages: [newPage] };
  const hasPhoto = fixed.some((f) => f.type === 'image');
  const geom = geometryFor(spec, top, newPage.index, { hasPhoto });
  const typ2 = typeSizes(s, spec);
  const bodySize = typ2.body;
  const st = makeState(newPage, spec, geom.cols, { s, measure: m, imageSize: imgSize, pageIndex: newPage.index, bodySize, bodyLH: typ2.bodyLH, bf: font(bodySize), railX: geom.railX, seq: fixed.length, mainX: geom.mainX, mainW: geom.mainW });
  for (const f of fixed) {
    if (f.type === 'image' || f.type === 'caption' || f.type === 'title' || f.type === 'meta' || f.type === 'quote' || (f.type === 'note' && f.sidebar)) st.obstacles.push({ x: f.x, y: f.y, w: f.w, h: f.h });
  }
  const nextIdx = flowOnePage(st, list, 0);
  const overflow = list.slice(nextIdx);
  return { page: newPage, overflow, pages: [newPage] };
}


/** 版型切換預覽：同步純函式，直接用新 layoutId 重排、重畫，不必再按「一鍵生成」。 */
export function previewLayout(input, layoutId) {
  return layoutA4({ ...input, layout: layoutId });
}
