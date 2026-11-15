// A4 版面計算（純函式，不碰 DOM）：把報導區塊排進 1240×1754 px（A4 210:297，150dpi）頁面。
// 框架式排版：每頁先決定固定框（標題／主圖／照片），內文再流進「欄位減去障礙物」的文字區，
// 真正繞著照片排；一頁排滿接下一頁。回傳每頁的 frames（給編輯器拖拉）與 ops（給 a4.mjs 畫圖）。
// A4／PDF 不放影片：video 區塊一律略過。measure(text, font) 由呼叫端提供（canvas.measureText 或測試用假函式）。
// 同步純函式：素材與圖片尺寸已快取時不做 I/O、不讀 DOM，只做換行與矩形運算。


export const A4 = { width: 1240, height: 1754 };
export const FONT_FAMILY = '"Noto Sans CJK TC","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';
export const COLORS = { navy: '#16324F', gold: '#836427', goldLight: '#C9A865', text: '#1F2D3D', gray: '#5A6A7A', line: '#E4E3DE', bg: '#FFFFFF', paper: '#F5F5F2' };


const MARGIN = 100;
const TOP_FIRST = 196;
const TOP_OTHER = 150;
const BOTTOM = A4.height - 130;


export const font = (size, weight = 400) => `${weight} ${Math.round(size)}px ${FONT_FAMILY}`;

/** 圖說用小字，明顯小於內文（約 27px）與標題，避免被看成小標。 */
export const captionSize = (s = 1) => 16 * s;
export const captionLineHeight = (s = 1) => 16 * s * 1.4;
export const captionGap = (s = 1) => 8 * s;
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
  const lines = [];
  let line = '';
  const tokens = String(text ?? '').match(TOKEN_RE) || [];
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
  { id: 'quote', name: '見證引言大字', desc: '見證署名放大置中、上下加金線，適合見證與引言為主的報導。' },
  { id: 'card', name: '上圖下文卡片', desc: '每張照片連圖說裝進一張淺色卡片，段落接在卡片之後。' },
  { id: 'sidebar', name: '左側邊欄', desc: '左側邊欄列出本期要目，主文在右側繞排。' },
  { id: 'fullbleed', name: '全版滿版照片', desc: '第一頁照片滿版、標題白字疊印在照片上，內文從第二頁開始。' },
  { id: 'spread', name: '左右對開', desc: '第 1 頁左圖右文，第 2 頁起左右互換，像翻開的書冊，適合圖文並重的報導。' },
];


const LAYOUT_SPECS = {
  // headerCover: 第 1 頁是否在標題下畫整頁寬主圖。false 時主圖改插入內文，依該版型的照片模式排列。
  classic: { columns: 1, photo: 'center', photoW: 1, cover: 'normal', titleScale: 1, headerCover: true },
  alternate: { columns: 1, photo: 'alternate', photoW: 0.52, cover: 'normal', titleScale: 1, headerCover: false },
  columns: { columns: 2, photo: 'center', photoW: 1, cover: 'normal', titleScale: 1, headerCover: true },
  magazine: { columns: 1, photo: 'alternate', photoW: 0.5, cover: 'hero', titleScale: 1.08, headerCover: true },
  wrap2: { columns: 2, photo: 'alternate', photoW: 0.58, cover: 'normal', titleScale: 1, headerCover: false },
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


function buildHeader(page, data, metaLine, cover, spec, s, measure, imageSize, isFirst, pageIndex) {
  const CW = A4.width - 2 * MARGIN;
  let n = 0;
  const hid = (t) => 'p' + pageIndex + '-' + t + '-' + (++n);
  if (!isFirst) return TOP_OTHER;
  if (spec.cover === 'fullbleed' && cover) {
    page.frames.push({ id: hid('image'), type: 'image', x: 0, y: 0, w: A4.width, h: A4.height, locked: false, photoId: cover.photoId, fit: 'cover' });
    page.ops.push({ op: 'image', photoId: cover.photoId, x: 0, y: 0, w: A4.width, h: A4.height, fit: 'cover', radius: 0 });
    page.ops.push({ op: 'rect', x: 0, y: 1060, w: A4.width, h: 694, fill: 'rgba(22,50,79,0.55)' });
    const titleSize = 58 * s * (spec.titleScale || 1);
    const tf = font(titleSize, 900);
    const lines = data.title ? wrapText(data.title, tf, CW, measure) : [];
    const lh = titleSize * 1.3;
    page.frames.push({ id: hid('title'), type: 'title', x: MARGIN, y: 1160, w: CW, h: lines.length * lh, locked: false });
    lines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: 1160 + i * lh + titleSize, text: ln, font: tf, color: '#ffffff' }); });
    let bandY = 1160 + lines.length * lh;
    if (metaLine) {
      const mf = font(23 * s);
      const mlines = wrapText(metaLine, mf, CW, measure);
      const my = bandY + 20 * s;
      page.frames.push({ id: hid('meta'), type: 'meta', x: MARGIN, y: my, w: CW, h: mlines.length * 23 * s * 1.6, locked: false });
      mlines.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: my + i * 23 * s * 1.6 + 23 * s, text: ln, font: mf, color: '#ffffff' }); });
      bandY = my + mlines.length * 23 * s * 1.6;
    }
    const bleedCap = wrapCaption(cover.caption, CW, s, measure);
    if (bleedCap.length) {
      const cy = bandY + 16 * s;
      const ch = captionBlockHeight(bleedCap, s);
      page.frames.push({ id: hid('caption'), type: 'caption', x: MARGIN, y: cy, w: CW, h: ch, locked: false, photoId: cover.photoId, align: 'left' });
      bleedCap.forEach((ln, i) => { page.ops.push({ op: 'text', x: MARGIN, y: cy + i * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: 'rgba(255,255,255,0.88)' }); });
    }
    return BOTTOM + 1;
  }
  let y = TOP_FIRST;
  if (data.kicker) {
    const f = font(24 * s, 700);
    page.frames.push({ id: 'p' + pageIndex + '-kicker-' + (++n), type: 'meta', x: MARGIN, y: y, w: CW, h: 24 * s + 18 * s, locked: false });
    page.ops.push({ op: 'text', x: MARGIN, y: y + 24 * s, text: data.kicker, font: f, color: COLORS.gold });
    y += 24 * s + 18 * s;
  }
  const titleSize = 54 * s * (spec.titleScale || 1);
  const tf = font(titleSize, 900);
  const tlines = data.title ? wrapText(data.title, tf, CW, measure) : [];
  const tlh = titleSize * 1.35;
  if (tlines.length) {
    page.frames.push({ id: hid('title'), type: 'title', x: MARGIN, y: y, w: CW, h: tlines.length * tlh, locked: false });
    for (const ln of tlines) { page.ops.push({ op: 'text', x: MARGIN, y: y + titleSize, text: ln, font: tf, color: COLORS.navy }); y += tlh; }
  }
  y += 10 * s;
  const mf = font(23 * s);
  const mlines = wrapText(metaLine || '', mf, CW, measure);
  if (mlines.length) {
    page.frames.push({ id: hid('meta'), type: 'meta', x: MARGIN, y: y, w: CW, h: mlines.length * 23 * s * 1.6, locked: false });
    for (const ln of mlines) { page.ops.push({ op: 'text', x: MARGIN, y: y + 23 * s, text: ln, font: mf, color: COLORS.gray }); y += 23 * s * 1.6; }
  }
  y += 14 * s;
  page.ops.push({ op: 'line', x1: MARGIN, y1: y, x2: MARGIN + CW, y2: y, color: COLORS.line, width: 2 });
  y += 30 * s;
  if (cover) {
    const sz = sizeOf(imageSize, cover.photoId);
    const h = spec.cover === 'hero' ? 900 * s : Math.min((CW * sz.h) / sz.w, 640 * s);
    page.frames.push({ id: hid('image'), type: 'image', x: MARGIN, y: y, w: CW, h: h, locked: false, photoId: cover.photoId, fit: 'cover' });
    page.ops.push({ op: 'image', photoId: cover.photoId, x: MARGIN, y: y, w: CW, h: h, fit: 'cover', radius: 8 });
    y += h;
    const clines = wrapCaption(cover.caption, CW, s, measure);
    if (clines.length) {
      y += captionGap(s);
      const ch = captionBlockHeight(clines, s);
      page.frames.push({ id: hid('caption'), type: 'caption', x: MARGIN, y: y, w: CW, h: ch, locked: false, photoId: cover.photoId, align: 'center' });
      for (const ln of clines) { page.ops.push({ op: 'text', x: MARGIN + CW / 2, y: y + captionSize(s), text: ln, font: font(captionSize(s)), color: COLORS.gray, align: 'center' }); y += captionLineHeight(s); }
    }
    y += 16 * s;
  }
  return y;
}


function makeState(page, spec, cols, opts) {
  return {
    page, spec, cols, col: 0, y: cols.length ? cols[0].y : TOP_OTHER,
    obstacles: [], figIndex: 0, s: opts.s || 1, measure: opts.measure,
    imageSize: opts.imageSize, seq: opts.seq || 0, pageIndex: opts.pageIndex || 0,
    bodySize: opts.bodySize, bodyLH: opts.bodyLH, bf: opts.bf, railX: opts.railX || null,
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


function flowPara(st, b, idx) {
  const s = st.s;
  const quoteLead = !!st.spec.quote && !st.quoteLeadDone;
  if (quoteLead) st.quoteLeadDone = true;
  const size = quoteLead ? st.bodySize * 1.22 : st.bodySize;
  const lh = quoteLead ? size * 1.7 : st.bodyLH;
  const fnt = quoteLead ? font(size, 500) : st.bf;
  const color = quoteLead ? COLORS.navy : COLORS.text;
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
    if (st.measure(tok, fnt) > seg.w) {
      if (line) { emitLine(); continue; }
      const chars = Array.from(tok);
      tokens.splice(ti, 1, ...chars);
      continue;
    }
    if (line && st.measure(line + tok, fnt) > seg.w && !NO_LINE_START.includes(tok[0])) {
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
  const col = colRect(st);
  const colW = col.w;
  const isSection = kind === 'section';
  const size = (isSection ? 32 : 34) * s;
  const fnt = font(size, 900);
  const lh = size * (isSection ? 1.5 : 1.45);
  const lines = wrapText(b.text, fnt, colW - (isSection ? 40 * s : 22 * s), st.measure);
  const boxH = isSection ? lines.length * lh + 22 * s : lines.length * lh;
  const need = isSection ? boxH + 4 * st.bodyLH : boxH + 2 * st.bodyLH;
  if (!jumpPastObstacles(st, boxH)) {
    if (!nextSlot(st)) return false;
  }
  const top = atTop(st) ? 0 : (isSection ? 34 * s : 26 * s);
  if (st.y + top + need > BOTTOM) {
    if (!nextSlot(st)) return false;
    jumpPastObstacles(st, boxH);
  }
  st.y += top;
  if (isSection) {
    st.page.frames.push({ id: nextId(st, 'heading'), type: 'heading', x: col.x, y: st.y, w: colW, h: boxH, blockIndex: idx });
    st.page.ops.push({ op: 'rect', x: col.x, y: st.y, w: colW, h: boxH, fill: COLORS.navy });
    let ty = st.y + 11 * s;
    for (const ln of lines) {
      st.page.ops.push({ op: 'text', x: col.x + 20 * s, y: ty + (lh + size * 0.72) / 2, text: ln, font: fnt, color: '#ffffff' });
      ty += lh;
    }
    st.y += boxH + 22 * s;
  } else {
    st.page.frames.push({ id: nextId(st, 'heading'), type: 'heading', x: col.x, y: st.y, w: colW, h: boxH, blockIndex: idx });
    st.page.ops.push({ op: 'rect', x: col.x, y: st.y + lh * 0.18, w: 7 * s, h: lines.length * lh - lh * 0.36, fill: COLORS.goldLight });
    if (st.spec.timeline && st.railX != null) {
      st.page.ops.push({ op: 'rect', x: st.railX - 4, y: st.y + lh * 0.4, w: 12, h: 12, fill: COLORS.gold });
    }
    let ty = st.y;
    for (const ln of lines) {
      st.page.ops.push({ op: 'text', x: col.x + 22 * s, y: ty + (lh + size * 0.72) / 2, text: ln, font: fnt, color: COLORS.navy });
      ty += lh;
    }
    st.y += boxH + 8 * s;
  }
  return true;
}


function flowByline(st, b, idx) {
  const s = st.s;
  const col = colRect(st);
  const quoteMode = !!st.spec.quote;
  const size = st.bodySize;
  const fnt = font(size, 700);
  const lh = st.bodyLH;
  const lines = wrapText(b.text, fnt, col.w, st.measure);
  const total = lines.length * lh;
  if (!jumpPastObstacles(st, total)) {
    if (!nextSlot(st)) return false;
  }
  if (st.y + total > BOTTOM) {
    if (!nextSlot(st)) return false;
  }
  const frameY = st.y;
  if (quoteMode) {
    st.page.ops.push({ op: 'line', x1: col.x + col.w * 0.2, y1: st.y, x2: col.x + col.w * 0.8, y2: st.y, color: COLORS.goldLight, width: 3 });
    st.y += 18 * s;
  }
  st.page.frames.push({ id: nextId(st, 'text'), type: 'text', x: col.x, y: frameY, w: col.w, h: quoteMode ? total + 36 * s : total, blockIndex: idx });
  for (const ln of lines) {
    st.page.ops.push({ op: 'text', x: col.x + col.w, y: st.y + (lh + size * 0.72) / 2, text: ln, font: fnt, color: COLORS.gold, align: 'right' });
    st.y += lh;
  }
  if (quoteMode) {
    st.page.ops.push({ op: 'line', x1: col.x + col.w * 0.2, y1: st.y + 6 * s, x2: col.x + col.w * 0.8, y2: st.y + 6 * s, color: COLORS.goldLight, width: 3 });
    st.y += 18 * s;
  }
  st.y += 10 * s;
  return true;
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
  st.page.ops.push({ op: 'line', x1: col.x, y1: st.y, x2: col.x + col.w, y2: st.y, color: COLORS.line, width: 2 });
  st.y += 10 * s;
  st.page.frames.push({ id: nextId(st, 'note'), type: 'note', x: col.x, y: frameY, w: col.w, h: total, blockIndex: idx });
  for (const ln of lines) {
    st.page.ops.push({ op: 'text', x: col.x, y: st.y + (lh + 24 * s * 0.72) / 2, text: ln, font: fnt, color: COLORS.gold });
    st.y += lh;
  }
  return true;
}


function placeFigure(st, b, idx) {
  const s = st.s;
  let col = colRect(st);
  const colW = col.w;
  const spec = st.spec;
  const mode = spec.photo;
  const sz = sizeOf(st.imageSize, b.photoId);
  const isWrap = mode === 'alternate' || mode === 'right';
  const isBanner = mode === 'banner';
  const isCard = mode === 'card';
  let w = colW;
  let h = 200 * s;
  let ix = col.x;
  let iy = st.y;
  if (isBanner) {
    w = colW; h = Math.min((w * sz.h) / sz.w, 220 * s); ix = col.x; iy = st.y;
  } else if (isCard) {
    w = colW - 32 * s; h = Math.min((w * sz.h) / sz.w, 420 * s); ix = col.x + 16 * s; iy = st.y;
  } else if (isWrap) {
    w = colW * (mode === 'right' ? 0.38 : 0.52);
    h = (w * sz.h) / sz.w;
    if (h > 420 * s) { h = 420 * s; w = (h * sz.w) / sz.h; }
    const left = mode === 'right' ? false : (st.figIndex % 2 === 0);
    ix = left ? col.x : col.x + colW - w; iy = st.y;
    const ov = st.obstacles.filter((o) => o.y < iy + 20 && o.y + o.h > iy && o.x < col.x + colW && o.x + o.w > col.x);
    if (ov.length) iy = Math.max.apply(null, ov.map((o) => o.y + o.h)) + 18 * s;
  } else {
    w = colW * (spec.photoW || 1); if (w > colW) w = colW;
    h = (w * sz.h) / sz.w;
    const maxH = (BOTTOM - TOP_OTHER) * (mode === 'top' ? 0.30 : 0.42);
    if (h > maxH) { h = maxH; w = (h * sz.w) / sz.h; }
    ix = col.x + (colW - w) / 2; iy = st.y;
  }
  const capW = w;
  const capLines = wrapCaption(b.caption, capW, s, st.measure);
  const capH = captionBlockHeight(capLines, s);
  const capSpace = capH ? capH + captionGap(s) : 0;
  const cardExtra = isCard ? 48 * s : 0;
  const total = h + capSpace + cardExtra;
  const pad = 18 * s;
  const minH = 180 * s;
  const roomFor = (y) => BOTTOM - y - capSpace - cardExtra - pad;
  const moveToNext = () => {
    if (!nextSlot(st)) return false;
    col = colRect(st);
    iy = st.y;
    const cw = col.w;
    if (isBanner) { w = cw; h = Math.min((w * sz.h) / sz.w, 220 * s); ix = col.x; }
    else if (isCard) { w = cw - 32 * s; h = Math.min((w * sz.h) / sz.w, 420 * s); ix = col.x + 16 * s; }
    else if (isWrap) {
      const left = mode === 'right' ? false : (st.figIndex % 2 === 0);
      ix = left ? col.x : col.x + cw - w;
    } else ix = col.x + (cw - w) / 2;
    return true;
  };
  if (iy + total + pad > BOTTOM) {
    if (roomFor(iy) < minH && (st.y > col.y + 0.5 || st.col < st.cols.length - 1)) {
      if (!moveToNext()) return 'pageFull';
    }
    if (iy + h + capSpace + cardExtra + pad > BOTTOM) {
      const room = roomFor(iy);
      if (room >= minH) h = room;
      else if (st.y > col.y + 0.5 || st.col < st.cols.length - 1) {
        if (!moveToNext()) return 'pageFull';
        if (iy + h + capSpace + cardExtra + pad > BOTTOM) {
          const room2 = roomFor(iy);
          if (room2 < 80 * s) return 'pageFull';
          h = room2;
        }
      } else if (room >= 80 * s) h = room;
      else return 'pageFull';
    }
  }
  const effTotal = h + capSpace + (isCard ? 48 * s : 0);
  if (isCard) {
    st.page.ops.push({ op: 'rect', x: col.x, y: iy, w: colW, h: effTotal, fill: COLORS.paper });
  }
  const imgFrame = { id: nextId(st, 'image'), type: 'image', x: ix, y: iy, w: w, h: h, locked: false, photoId: b.photoId, fit: (isCard || isBanner) ? 'cover' : 'contain', blockIndex: idx };
  st.page.frames.push(imgFrame);
  st.page.ops.push({ op: 'image', photoId: b.photoId, x: ix, y: iy, w: w, h: h, fit: imgFrame.fit, radius: 6 });
  if (capLines.length) {
    const cy = iy + h + captionGap(s);
    if (cy + capH <= BOTTOM + 0.5) {
      const capAlign = isWrap ? 'left' : 'center';
      st.page.frames.push({ id: nextId(st, 'caption'), type: 'caption', x: ix, y: cy, w: w, h: capH, locked: false, photoId: b.photoId, blockIndex: idx, align: capAlign });
      const lh = captionLineHeight(s);
      const cf = font(captionSize(s));
      for (let i = 0; i < capLines.length; i++) {
        const tx = capAlign === 'left' ? ix : ix + w / 2;
        st.page.ops.push({ op: 'text', x: tx, y: cy + i * lh + captionSize(s), text: capLines[i], font: cf, color: COLORS.gray, align: capAlign });
      }
    }
  }
  const wrapPad = 16 * s;
  const leftFig = isWrap && ix <= col.x + 1;
  st.obstacles.push({
    x: isWrap ? (leftFig ? ix : ix - wrapPad) : col.x,
    y: iy,
    w: isWrap ? w + wrapPad : col.w,
    h: effTotal + 8 * s,
  });
  if (isWrap) st.y = iy;
  else st.y = iy + effTotal + pad;
  st.figIndex++;
  return 'done';
}


function placeFigurePair(st, b1, b2, idx1, idx2) {
  const s = st.s;
  const gap = 24;
  let col = colRect(st);
  const w = (col.w - gap) / 2;
  const sz1 = sizeOf(st.imageSize, b1.photoId);
  const sz2 = sizeOf(st.imageSize, b2.photoId);
  // 兩張等高，圖說才能對齊在同一列，不會一高一低看起來亂放
  let h = Math.min(Math.max((w * sz1.h) / sz1.w, (w * sz2.h) / sz2.w), 380 * s);
  const c1 = wrapCaption(b1.caption, w, s, st.measure);
  const c2 = wrapCaption(b2.caption, w, s, st.measure);
  const ch1 = captionBlockHeight(c1, s);
  const ch2 = captionBlockHeight(c2, s);
  const capMax = Math.max(ch1, ch2);
  const capPair = capMax ? capMax + captionGap(s) : 0;
  let rowH = h + capPair;
  const pad = 18 * s;
  let y0 = st.y;
  const minRow = 180 * s + capPair;
  if (y0 + rowH + pad > BOTTOM) {
    if (BOTTOM - y0 - pad < minRow && !atTop(st)) {
      if (!nextSlot(st)) return 'pageFull';
      col = colRect(st); y0 = col.y;
    }
    if (y0 + rowH + pad > BOTTOM) {
      const room = BOTTOM - y0 - pad - capPair;
      if (room < 80 * s) return 'pageFull';
      h = room;
      rowH = h + capPair;
    }
  }
  const items = [[b1, idx1, col.x, c1], [b2, idx2, col.x + w + gap, c2]];
  const cy = y0 + h + captionGap(s);
  const lh = captionLineHeight(s);
  const cf = font(captionSize(s));
  for (const it of items) {
    const bb = it[0]; const bi = it[1]; const xx = it[2]; const caps = it[3];
    st.page.frames.push({ id: nextId(st, 'image'), type: 'image', x: xx, y: y0, w: w, h: h, locked: false, photoId: bb.photoId, fit: 'cover', blockIndex: bi });
    st.page.ops.push({ op: 'image', photoId: bb.photoId, x: xx, y: y0, w: w, h: h, fit: 'cover', radius: 6 });
    if (caps.length && cy + captionBlockHeight(caps, s) <= BOTTOM + 0.5) {
      st.page.frames.push({ id: nextId(st, 'caption'), type: 'caption', x: xx, y: cy, w: w, h: captionBlockHeight(caps, s), locked: false, photoId: bb.photoId, blockIndex: bi, align: 'left' });
      for (let i = 0; i < caps.length; i++) st.page.ops.push({ op: 'text', x: xx, y: cy + i * lh + captionSize(s), text: caps[i], font: cf, color: COLORS.gray });
    }
  }
  st.obstacles.push({ x: col.x, y: y0, w: col.w, h: rowH });
  st.y = y0 + rowH + pad;
  st.figIndex += 2;
  return 'done';
}


function flowOnePage(st, blocks, startIdx) {
  let idx = startIdx;
  while (idx < blocks.length) {
    const b = blocks[idx];
    if (!b || b.type === 'video') { idx++; continue; }
    if (b.type === 'figure' && st.spec.photo === 'grid' && idx + 1 < blocks.length && blocks[idx + 1].type === 'figure') {
      const r = placeFigurePair(st, b, blocks[idx + 1], idx, idx + 1);
      if (r === 'pageFull') break;
      idx += 2; continue;
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
    if (b.type === 'heading') { if (!flowSectionHeading(st, b, idx, 'heading')) break; idx++; continue; }
    if (b.type === 'byline') { if (!flowByline(st, b, idx)) break; idx++; continue; }
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
  const x = geom.textX;
  const CW = geom.paneW;
  let n = 0;
  const hid = (t) => 'p' + pageIndex + '-' + t + '-' + (++n);
  let y = TOP_FIRST;
  if (data.kicker) {
    const f = font(24 * s, 700);
    page.frames.push({ id: hid('kicker'), type: 'meta', x, y, w: CW, h: 24 * s + 18 * s, locked: false });
    page.ops.push({ op: 'text', x, y: y + 24 * s, text: data.kicker, font: f, color: COLORS.gold });
    y += 24 * s + 18 * s;
  }
  const titleSize = 48 * s * (spec.titleScale || 1);
  const tf = font(titleSize, 900);
  const tlines = data.title ? wrapText(data.title, tf, CW, measure) : [];
  const tlh = titleSize * 1.35;
  if (tlines.length) {
    page.frames.push({ id: hid('title'), type: 'title', x, y, w: CW, h: tlines.length * tlh, locked: false });
    for (const ln of tlines) { page.ops.push({ op: 'text', x, y: y + titleSize, text: ln, font: tf, color: COLORS.navy }); y += tlh; }
  }
  y += 10 * s;
  const mf = font(23 * s);
  const mlines = wrapText(metaLine || '', mf, CW, measure);
  if (mlines.length) {
    page.frames.push({ id: hid('meta'), type: 'meta', x, y, w: CW, h: mlines.length * 23 * s * 1.6, locked: false });
    for (const ln of mlines) { page.ops.push({ op: 'text', x, y: y + 23 * s, text: ln, font: mf, color: COLORS.gray }); y += 23 * s * 1.6; }
  }
  y += 14 * s;
  page.ops.push({ op: 'line', x1: x, y1: y, x2: x + CW, y2: y, color: COLORS.line, width: 2 });
  y += 24 * s;
  return y;
}

function placeSpreadPhoto(page, photo, geom, s, measure, pageIndex) {
  if (!photo) return;
  const w = geom.paneW;
  const xx = geom.photoX;
  const iy = MARGIN;
  const capLines = wrapCaption(photo.caption, w, s, measure);
  const capH = captionBlockHeight(capLines, s);
  const capSpace = capH ? capH + captionGap(s) : 0;
  const h = Math.max(80 * s, BOTTOM - iy - capSpace);
  let n = page.frames.length;
  const hid = (t) => 'p' + pageIndex + '-' + t + '-' + (++n);
  page.frames.push({ id: hid('image'), type: 'image', x: xx, y: iy, w, h, locked: false, photoId: photo.photoId, fit: 'cover', blockIndex: photo.blockIndex });
  page.ops.push({ op: 'image', photoId: photo.photoId, x: xx, y: iy, w, h, fit: 'cover', radius: 8 });
  if (capLines.length) {
    const cy = iy + h + captionGap(s);
    if (cy + capH <= BOTTOM + 0.5) {
      page.frames.push({ id: hid('caption'), type: 'caption', x: xx, y: cy, w, h: capH, locked: false, photoId: photo.photoId, blockIndex: photo.blockIndex, align: 'left' });
      const lh = captionLineHeight(s);
      const cf = font(captionSize(s));
      capLines.forEach((ln, i) => { page.ops.push({ op: 'text', x: xx, y: cy + i * lh + captionSize(s), text: ln, font: cf, color: COLORS.gray, align: 'left' }); });
    }
  }
}

function placeSpreadPhotoTail(pages, photos, s, measure, startPage) {
  const gap = 24;
  const w = (A4.width - 2 * MARGIN - gap) / 2;
  let i = 0;
  let pageIndex = pages.length;
  while (i < photos.length) {
    const page = { index: pageIndex, frames: [], ops: [] };
    let y = TOP_OTHER;
    let placed = 0;
    while (i < photos.length) {
      const a = photos[i];
      const b = photos[i + 1] || null;
      const capA = wrapCaption(a.caption, b ? w : A4.width - 2 * MARGIN, s, measure);
      const capB = b ? wrapCaption(b.caption, w, s, measure) : [];
      const capMax = Math.max(captionBlockHeight(capA, s), captionBlockHeight(capB, s));
      const capPair = capMax ? capMax + captionGap(s) : 0;
      const h = Math.min(420 * s, BOTTOM - y - capPair - 18 * s);
      if (h < 160 * s && placed) break;
      if (h < 80 * s) break;
      const rowH = h + capPair;
      if (b) {
        const items = [[a, capA, MARGIN], [b, capB, MARGIN + w + gap]];
        const cy = y + h + captionGap(s);
        for (const it of items) {
          const photo = it[0]; const caps = it[1]; const xx = it[2];
          page.frames.push({ id: 'p' + pageIndex + '-image-' + (++placed), type: 'image', x: xx, y, w, h, locked: false, photoId: photo.photoId, fit: 'cover', blockIndex: photo.blockIndex });
          page.ops.push({ op: 'image', photoId: photo.photoId, x: xx, y, w, h, fit: 'cover', radius: 8 });
          if (caps.length && cy + captionBlockHeight(caps, s) <= BOTTOM + 0.5) {
            page.frames.push({ id: 'p' + pageIndex + '-caption-' + placed, type: 'caption', x: xx, y: cy, w, h: captionBlockHeight(caps, s), locked: false, photoId: photo.photoId, blockIndex: photo.blockIndex, align: 'left' });
            caps.forEach((ln, n) => { page.ops.push({ op: 'text', x: xx, y: cy + n * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: COLORS.gray, align: 'left' }); });
          }
        }
        i += 2;
      } else {
        const ww = A4.width - 2 * MARGIN;
        const cy = y + h + captionGap(s);
        page.frames.push({ id: 'p' + pageIndex + '-image-' + (++placed), type: 'image', x: MARGIN, y, w: ww, h, locked: false, photoId: a.photoId, fit: 'cover', blockIndex: a.blockIndex });
        page.ops.push({ op: 'image', photoId: a.photoId, x: MARGIN, y, w: ww, h, fit: 'cover', radius: 8 });
        if (capA.length && cy + captionBlockHeight(capA, s) <= BOTTOM + 0.5) {
          page.frames.push({ id: 'p' + pageIndex + '-caption-' + placed, type: 'caption', x: MARGIN, y: cy, w: ww, h: captionBlockHeight(capA, s), locked: false, photoId: a.photoId, blockIndex: a.blockIndex, align: 'left' });
          capA.forEach((ln, n) => { page.ops.push({ op: 'text', x: MARGIN, y: cy + n * captionLineHeight(s) + captionSize(s), text: ln, font: font(captionSize(s)), color: COLORS.gray, align: 'left' }); });
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

function layoutSpread({ data, metaLine, cover, blocks, scale, measure, imageSize, header, startPage }) {
  const s = scale || 1;
  const spec = LAYOUT_SPECS.spread;
  const list = (blocks || []).filter((b) => b && b.type !== 'figure' && b.type !== 'video' && String(b.text ?? '').trim()).map((b) => ({ ...b }));
  const photos = collectSpreadPhotos(cover, blocks || []);
  const bodySize = 27 * s * (spec.bodyScale || 1);
  const bodyLH = bodySize * 1.8;
  const bf = font(bodySize);
  const pages = [];
  let idx = 0;
  let photoIdx = 0;
  let pageIndex = 0;
  const hasText = () => idx < list.length;
  while (hasText() || pageIndex === 0) {
    if (pageIndex > 200) break;
    const isFirst = pageIndex === 0;
    const absPage = (startPage || 0) + pageIndex;
    const page = { index: pageIndex, frames: [], ops: [] };
    pages.push(page);
    const hasPhoto = photoIdx < photos.length && (hasText() || isFirst);
    let yAfter;
    let geom;
    if (hasPhoto) {
      const pane = spreadPane(absPage);
      if (isFirst && header) yAfter = drawSpreadHeader(page, data, metaLine, pane, s, measure, pageIndex, spec);
      else yAfter = TOP_OTHER;
      geom = geometryFor(spec, yAfter, absPage, { hasPhoto: true });
      placeSpreadPhoto(page, photos[photoIdx], pane, s, measure, pageIndex);
      photoIdx++;
    } else if (isFirst && header) {
      yAfter = buildHeader(page, data, metaLine, null, spec, s, measure, imageSize, true, pageIndex);
      geom = geometryFor(spec, yAfter, absPage, { hasPhoto: false });
    } else {
      yAfter = TOP_OTHER;
      geom = geometryFor(spec, yAfter, absPage, { hasPhoto: false });
    }
    if (yAfter > BOTTOM) { pageIndex++; if (!hasText()) break; continue; }
    const st = makeState(page, spec, geom.cols, { s, measure, imageSize, pageIndex, bodySize, bodyLH, bf });
    const framesBefore = page.frames.length;
    const roomy = BOTTOM - (geom.cols[0] ? geom.cols[0].y : TOP_OTHER) >= 200;
    const nextIdx = flowOnePage(st, list, idx);
    if (nextIdx > idx) idx = nextIdx;
    else if (idx < list.length && page.frames.length === framesBefore && roomy) idx++;
    pageIndex++;
    if (!hasText()) break;
  }
  if (photoIdx < photos.length) placeSpreadPhotoTail(pages, photos.slice(photoIdx), s, measure, startPage);
  return { pages };
}

export function layoutA4({ data, metaLine, cover, blocks, layout = 'classic', scale = 1, measure, imageSize, header = true, startPage = 0 }) {
  const s = scale || 1;
  const spec = specFor(layout);
  const m = measure || fallbackMeasure;
  const imgSize = imageSize || (() => ({ w: 4, h: 3 }));
  const d = data || {};
  const list = Array.isArray(blocks) ? blocks.map((b) => ({ ...b })) : [];
  if (spec.spread) return layoutSpread({ data: d, metaLine: metaLine || '', cover, blocks: list, scale: s, measure: m, imageSize: imgSize, header, startPage });
  const headerCover = usesHeaderCover(spec);
  if (header && !headerCover) insertInlineCover(list, cover, spec);
  const bodySize = (spec.columns === 3 ? 24 : 27) * s * (spec.bodyScale || 1);
  const bodyLH = bodySize * 1.8;
  const bf = font(bodySize);
  const pages = [];
  let idx = 0;
  let pageIndex = 0;
  while (idx < list.length || pageIndex === 0) {
    if (pageIndex > 200) break;
    const isFirst = pageIndex === 0;
    const page = { index: pageIndex, frames: [], ops: [] };
    pages.push(page);
    const yAfter = buildHeader(page, d, metaLine || '', headerCover ? cover : null, spec, s, m, imgSize, header && isFirst, pageIndex);
    const geom = geometryFor(spec, yAfter);
    if (spec.sidebar) {
      const sbY = yAfter;
      const sbH = Math.max(0, BOTTOM - sbY);
      if (sbH > 40) {
        page.frames.push({ id: 'p' + pageIndex + '-note-sidebar', type: 'note', x: MARGIN, y: sbY, w: 240, h: sbH, locked: true });
        page.ops.push({ op: 'rect', x: MARGIN, y: sbY, w: 240, h: sbH, fill: COLORS.paper });
        page.ops.push({ op: 'line', x1: MARGIN + 240, y1: sbY, x2: MARGIN + 240, y2: BOTTOM, color: COLORS.line, width: 2 });
        const sections = list.filter((b) => b.type === 'section').map((b) => b.text);
        const sf = font(22 * s, 700);
        let sy = sbY + 24 * s;
        page.ops.push({ op: 'text', x: MARGIN + 16, y: sy + 22 * s, text: '本期要目', font: sf, color: COLORS.navy });
        sy += 22 * s * 1.6 + 10 * s;
        const tf2 = font(21 * s);
        for (const t of sections) {
          for (const ln of wrapText(t, tf2, 208, m)) {
            if (sy + 21 * s * 1.5 > BOTTOM) break;
            page.ops.push({ op: 'text', x: MARGIN + 16, y: sy + 21 * s, text: ln, font: tf2, color: COLORS.gray });
            sy += 21 * s * 1.5;
          }
        }
      }
    }
    if (spec.timeline && geom.railX != null) {
      page.ops.push({ op: 'line', x1: geom.railX, y1: yAfter, x2: geom.railX, y2: BOTTOM, color: COLORS.line, width: 3 });
    }
    if (yAfter > BOTTOM) {
      pageIndex++;
      if (idx >= list.length) break;
      continue;
    }
    const st = makeState(page, spec, geom.cols, { s, measure: m, imageSize: imgSize, pageIndex, bodySize, bodyLH, bf, railX: geom.railX });
    const framesBefore = page.frames.length;
    const roomy = BOTTOM - (geom.cols[0] ? geom.cols[0].y : TOP_OTHER) >= 200;
    const nextIdx = flowOnePage(st, list, idx);
    if (nextIdx > idx) idx = nextIdx;
    else if (idx < list.length && page.frames.length === framesBefore && roomy) idx++;
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
  const s = c.scale || 1;
  const spec = specFor(c.layout || page.layout || 'classic');
  const m = c.measure || fallbackMeasure;
  const imgSize = c.imageSize || (() => ({ w: 4, h: 3 }));
  const blocksSrc = page.blocks || page.sourceBlocks || c.blocks || [];
  const list = blocksSrc.filter((b) => b && b.type !== 'figure' && b.type !== 'video').map((b) => ({ ...b }));
  const fixed = (frames || page.frames || []).filter((f) => f && (f.type === 'title' || f.type === 'meta' || f.type === 'image' || f.type === 'caption' || (f.type === 'note' && f.blockIndex == null)));
  let top = (page.index || 0) === 0 ? TOP_FIRST : TOP_OTHER;
  const headerFrames = fixed.filter((f) => f.type === 'title' || f.type === 'meta' || (((f.type === 'image') || (f.type === 'caption')) && f.blockIndex == null && !(f.type === 'image' && f.h > 1500)));
  if (headerFrames.length) top = Math.max.apply(null, headerFrames.map((f) => f.y + f.h)) + 22 * s;
  if (top > BOTTOM) top = BOTTOM + 1;
  const newPage = { index: page.index || 0, frames: [...fixed], ops: [] };
  const data = c.data || page.data || {};
  const metaLine = c.metaLine || page.metaLine || '';
  const cover = c.cover || page.cover || null;
  for (const f of fixed) {
    if (f.type === 'image') {
      newPage.ops.push({ op: 'image', photoId: f.photoId, x: f.x, y: f.y, w: f.w, h: f.h, fit: f.fit || 'cover', radius: 8, focusX: f.focusX != null ? f.focusX : 0.5, focusY: f.focusY != null ? f.focusY : 0.5 });
    } else if (f.type === 'title') {
      const tf = font(54 * s * (spec.titleScale || 1), 900);
      const lines = data.title ? wrapText(data.title, tf, f.w, m) : [];
      const lh = 54 * s * 1.35;
      lines.forEach((ln, i) => { newPage.ops.push({ op: 'text', x: f.x, y: f.y + i * lh + 54 * s, text: ln, font: tf, color: COLORS.navy }); });
    } else if (f.type === 'meta') {
      const isKicker = f.id && String(f.id).includes('kicker');
      const txt = isKicker ? (data.kicker || '') : metaLine;
      const ff = font(isKicker ? 24 * s : 23 * s, isKicker ? 700 : 400);
      const lines = txt ? wrapText(txt, ff, f.w, m) : [];
      lines.forEach((ln, i) => { newPage.ops.push({ op: 'text', x: f.x, y: f.y + i * (isKicker ? 42 * s : 36 * s) + (isKicker ? 24 * s : 23 * s), text: ln, font: ff, color: isKicker ? COLORS.gold : COLORS.gray }); });
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
      lines.forEach((ln, i) => { newPage.ops.push({ op: 'text', x: align === 'left' ? f.x : f.x + f.w / 2, y: f.y + i * lh + captionSize(s), text: ln, font: cf, color: COLORS.gray, align }); });
    } else if (f.type === 'note') {
      newPage.ops.push({ op: 'rect', x: f.x, y: f.y, w: f.w, h: f.h, fill: COLORS.paper });
    }
  }
  if (top > BOTTOM || !list.length) return { page: newPage, overflow: [], pages: [newPage] };
  const hasPhoto = fixed.some((f) => f.type === 'image');
  const geom = geometryFor(spec, top, newPage.index, { hasPhoto });
  const bodySize = (spec.columns === 3 ? 24 : 27) * s * (spec.bodyScale || 1);
  const st = makeState(newPage, spec, geom.cols, { s, measure: m, imageSize: imgSize, pageIndex: newPage.index, bodySize, bodyLH: bodySize * 1.8, bf: font(bodySize), railX: geom.railX, seq: fixed.length });
  for (const f of fixed) {
    if (f.type === 'image' || f.type === 'caption' || f.type === 'title' || f.type === 'meta') st.obstacles.push({ x: f.x, y: f.y, w: f.w, h: f.h });
  }
  const nextIdx = flowOnePage(st, list, 0);
  const overflow = list.slice(nextIdx);
  return { page: newPage, overflow, pages: [newPage] };
}


/** 版型切換預覽：同步純函式，直接用新 layoutId 重排、重畫，不必再按「一鍵生成」。 */
export function previewLayout(input, layoutId) {
  return layoutA4({ ...input, layout: layoutId });
}
