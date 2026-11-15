// A4 拖拉編輯器：DOM 疊在預覽上，對齊 Canva／PowerPoint 操作慣例。
// 照片預設保持比例，按住 Shift 才自由縮放；標題／文字／圖說預設自由縮放，按住 Shift 才等比例。
// 拖曳中只用 rAF 更新疊層與參考線，放開後才解重疊、補空隙並呼叫 reflowPage，溢出接到下一頁。

import { reflowPage } from './a4-layout.mjs?v=df37e48a51';
import { drawA4Ops, drawA4Page } from './a4.mjs?v=df37e48a51';

export const A4_WIDTH = 1240;
export const A4_HEIGHT = 1754;
export const A4_MARGIN = 100;
export const A4_BOTTOM = 1624;
export const SNAP_THRESHOLD = 8;

export function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function headerChromeHeight(pageIndex) {
  return (pageIndex || 0) === 0 ? 137 : 96;
}

export function forbiddenRects(page, pageIndex, movingId) {
  const top = headerChromeHeight(pageIndex != null ? pageIndex : page && page.index);
  const rects = [{ x: 0, y: 0, w: A4_WIDTH, h: top, kind: 'chrome' }];
  for (const f of (page && page.frames) || []) {
    if (!f || (f.type !== 'title' && f.type !== 'meta')) continue;
    if (movingId && f.id === movingId) continue;
    rects.push({ x: f.x, y: f.y, w: f.w, h: f.h, kind: f.type, id: f.id });
  }
  return rects;
}

export function rectsOverlap(a, b, pad = 0) {
  if (!a || !b) return false;
  return a.x < b.x + b.w + pad && a.x + a.w > b.x - pad && a.y < b.y + b.h + pad && a.y + a.h > b.y - pad;
}

/** 把會蓋住標題／meta／頁首的框推到禁區外。 */
export function clampOutOfForbidden(frame, rects, pageIndex) {
  const next = { ...frame };
  const top = headerChromeHeight(pageIndex);
  next.x = clamp(next.x, 0, A4_WIDTH - next.w);
  next.y = clamp(next.y, top, A4_HEIGHT - next.h);
  for (const r of rects || []) {
    if (r.id && r.id === frame.id) continue;
    if (!rectsOverlap(next, r, 2)) continue;
    const below = r.y + r.h + 8;
    if (below + next.h <= A4_BOTTOM) next.y = below;
    else if (r.x + r.w + 8 + next.w <= A4_WIDTH) next.x = r.x + r.w + 8;
    else if (r.x - 8 - next.w >= 0) next.x = r.x - 8 - next.w;
    next.x = clamp(next.x, 0, A4_WIDTH - next.w);
    next.y = clamp(next.y, top, A4_HEIGHT - next.h);
  }
  return next;
}

function fallbackMeasure(text, font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  const size = m ? parseFloat(m[1]) : 27;
  return String(text || '').length * size * 0.55;
}

export function wrapTextLocal(text, font, maxWidth, measure) {
  const m = measure || fallbackMeasure;
  const lines = [];
  let cur = '';
  for (const ch of String(text || '')) {
    const test = cur + ch;
    if (m(test, font) > maxWidth && cur) { lines.push(cur); cur = ch; } else { cur = test; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export function getColumnLines(layout) {
  const left = A4_MARGIN;
  const right = A4_WIDTH - A4_MARGIN;
  const mid = A4_WIDTH / 2;
  if (layout === 'columns' || layout === 'two-col' || layout === 'double' || layout === 'wrap2') {
    // 雙欄：欄寬 (1040-44)/2 = 498，第二欄起點 642
    return [left, 598, 642, right];
  }
  if (layout === 'three-col' || layout === 'tri' || layout === 'newspaper') {
    // 三欄：欄寬 (1040-72)/3 ≈ 322.7，欄起點 100、458.7、817.3
    return [left, 423, 459, 781, 817, right];
  }
  if (layout === 'sidebar') {
    // 左側邊欄寬 240、間距 36，主欄從 376 起
    return [left, 340, 376, right];
  }
  if (layout === 'timeline') {
    return [left, 112, 136, right];
  }
  if (layout === 'spread') {
    // 對開欄寬 (1040-36)/2 = 502，右欄起點 638
    return [left, 602, 638, right];
  }
  return [left, mid, right];
}

export function serializeLayout(result) {
  const pages = Array.isArray(result && result.pages) ? result.pages : [];
  return {
    version: 1,
    layout: (result && result.layout) || 'classic',
    scale: (result && result.scale) || 1,
    title: (result && result.title) || '',
    kicker: (result && result.kicker) || '',
    metaLine: (result && result.metaLine) || '',
    fileBase: (result && result.fileBase) || 'a4',
    textEdits: clone((result && result.textEdits) || {}),
    blocks: clone((result && (result.blocks || result.sourceBlocks)) || []),
    pages: pages.map((p, i) => ({
      index: p.index != null ? p.index : i,
      frames: (p.frames || []).filter((f) => f && f.id).map((f) => {
        const o = { id: f.id, type: f.type, x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h), locked: !!f.locked };
        if (f.photoId) o.photoId = f.photoId;
        if (f.blockIndex != null) o.blockIndex = f.blockIndex;
        if (f.fit) o.fit = f.fit;
        if (f.type === 'image') { o.focusX = f.focusX != null ? f.focusX : 0.5; o.focusY = f.focusY != null ? f.focusY : 0.5; }
        if (f.text != null) o.text = f.text;
        return o;
      })
    }))
  };
}

export function parseLayout(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : clone(input);
  if (!data || !Array.isArray(data.pages)) throw new Error('版面 JSON 缺少 pages');
  for (const p of data.pages) {
    if (!Array.isArray(p.frames)) throw new Error('版面 JSON 頁面缺少 frames');
    for (const f of p.frames) {
      if (!f.id || !f.type || typeof f.x !== 'number' || typeof f.y !== 'number' || typeof f.w !== 'number' || typeof f.h !== 'number') throw new Error('版面 JSON 含有不完整的 frame');
      if (f.type === 'image') { f.focusX = clamp(f.focusX != null ? f.focusX : 0.5, 0, 1); f.focusY = clamp(f.focusY != null ? f.focusY : 0.5, 0, 1); }
    }
  }
  return data;
}

export function snapCoordinate(value, candidates, threshold) {
  const t = threshold != null ? threshold : SNAP_THRESHOLD;
  let best = value;
  let bestDist = Infinity;
  let snapped = false;
  for (const c of candidates || []) {
    const d = Math.abs(value - c);
    if (d <= t && d < bestDist) { best = c; bestDist = d; snapped = true; }
  }
  return { value: best, snapped, distance: snapped ? bestDist : Infinity };
}

export function computeSnap(moving, others, opts) {
  const o = opts || {};
  const displayScale = o.displayScale || 1;
  const threshold = (o.threshold != null ? o.threshold : SNAP_THRESHOLD) / Math.max(displayScale, 0.2);
  const xCands = [100, 620, 1140].concat(getColumnLines(o.layout || 'classic'));
  const yCands = [150, 196, 1624];
  for (const f of others || []) {
    if (!f) continue;
    xCands.push(f.x, f.x + f.w, f.x + f.w / 2);
    yCands.push(f.y, f.y + f.h, f.y + f.h / 2);
  }
  const guides = [];
  let dx = 0;
  let dy = 0;
  const xEdges = [{ v: moving.x, k: 'l' }, { v: moving.x + moving.w / 2, k: 'c' }, { v: moving.x + moving.w, k: 'r' }];
  let bestX = null;
  for (const e of xEdges) {
    const s = snapCoordinate(e.v, xCands, threshold);
    if (s.snapped && (!bestX || s.distance < bestX.distance)) bestX = { dx: s.value - e.v, pos: s.value, distance: s.distance };
  }
  if (bestX) { dx = bestX.dx; guides.push({ orientation: 'v', pos: bestX.pos }); }
  const yEdges = [{ v: moving.y, k: 't' }, { v: moving.y + moving.h / 2, k: 'c' }, { v: moving.y + moving.h, k: 'b' }];
  let bestY = null;
  for (const e of yEdges) {
    const s = snapCoordinate(e.v, yCands, threshold);
    if (s.snapped && (!bestY || s.distance < bestY.distance)) bestY = { dy: s.value - e.v, pos: s.value, distance: s.distance };
  }
  if (bestY) { dy = bestY.dy; guides.push({ orientation: 'h', pos: bestY.pos }); }
  return { dx, dy, guides };
}

export function resizeFrame(frame, handle, dx, dy, keepRatio) {
  const f = { ...frame };
  let x = f.x;
  let y = f.y;
  let w = f.w;
  let h = f.h;
  const minW = 40;
  const minH = 40;
  if (handle.indexOf('w') !== -1) { x += dx; w -= dx; }
  if (handle.indexOf('e') !== -1) { w += dx; }
  if (handle.indexOf('n') !== -1) { y += dy; h -= dy; }
  if (handle.indexOf('s') !== -1) { h += dy; }
  if (w < minW) { if (handle.indexOf('w') !== -1) x -= (minW - w); w = minW; }
  if (h < minH) { if (handle.indexOf('n') !== -1) y -= (minH - h); h = minH; }
  if (keepRatio) {
    const ratio = frame.w / Math.max(frame.h, 1);
    const isCorner = handle.length === 2;
    if (isCorner) {
      if (Math.abs(dx) >= Math.abs(dy)) {
        h = w / ratio;
        if (handle.indexOf('n') !== -1) y = frame.y + frame.h - h;
      } else {
        w = h * ratio;
        if (handle.indexOf('w') !== -1) x = frame.x + frame.w - w;
      }
    } else if (handle === 'e' || handle === 'w') {
      h = w / ratio;
      y = frame.y + (frame.h - h) / 2;
    } else if (handle === 'n' || handle === 's') {
      w = h * ratio;
      x = frame.x + (frame.w - w) / 2;
    }
  }
  x = clamp(x, 0, A4_WIDTH - minW);
  y = clamp(y, 0, A4_HEIGHT - minH);
  w = clamp(w, minW, A4_WIDTH - x);
  h = clamp(h, minH, A4_HEIGHT - y);
  return { ...f, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function resolvePhotoOverlaps(frames, opts) {
  const out = (frames || []).map((f) => ({ ...f }));
  const photos = out.filter((f) => f.type === 'image').sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const a = photos[i];
      const b = photos[j];
      if (!rectsOverlap(a, b)) continue;
      const ratio = b.w / Math.max(b.h, 1);
      let nx = a.x + a.w + 12;
      let nw = b.w;
      if (nx + nw > 1140) { nw = Math.max(80, 1140 - nx); }
      const nh = nw / ratio;
      b.x = Math.round(nx);
      b.w = Math.round(nw);
      b.h = Math.round(nh);
      if (b.y + b.h > A4_BOTTOM) { b.h = Math.max(80, A4_BOTTOM - b.y); b.w = Math.round(b.h * ratio); }
    }
  }
  const rows = [];
  for (const p of photos) {
    let row = rows.find((r) => Math.abs(r.y - p.y) < Math.min(p.h, 60) || (p.y < r.y + r.h && r.y < p.y + p.h));
    if (!row) { row = { y: p.y, h: p.h, items: [] }; rows.push(row); }
    row.items.push(p);
    row.h = Math.max(row.h, p.h);
  }
  for (const row of rows) {
    if (row.items.length < 2) continue;
    row.items.sort((a, b) => a.x - b.x);
    let totalW = row.items.reduce((s, f) => s + f.w, 0);
    let gaps = 0;
    for (let i = 1; i < row.items.length; i++) gaps += Math.max(0, row.items[i].x - (row.items[i - 1].x + row.items[i - 1].w));
    const rowWidth = 1140 - 100;
    if (gaps > 24 && totalW + gaps < rowWidth) {
      const extra = rowWidth - totalW - (row.items.length - 1) * 12;
      if (extra > 0) {
        let x = 100;
        for (const f of row.items) {
          const share = f.w / Math.max(totalW, 1);
          const nw = Math.round(f.w + extra * share);
          const ratio = f.w / Math.max(f.h, 1);
          f.w = nw;
          f.h = Math.round(nw / ratio);
          f.x = Math.round(x);
          x += f.w + 12;
        }
      }
    }
  }
  return out;
}

export function createHistory(initial) {
  let past = [];
  let future = [];
  let current = clone(initial);
  return {
    push(state) { past.push(clone(current)); if (past.length > 100) past.shift(); future = []; current = clone(state); },
    undo() { if (!past.length) return null; future.push(clone(current)); current = past.pop(); return clone(current); },
    redo() { if (!future.length) return null; past.push(clone(current)); current = future.pop(); return clone(current); },
    current() { return clone(current); },
    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; }
  };
}

export function getFrameText(frame, ctx) {
  const c = ctx || {};
  if (!frame) return '';
  if (frame.type === 'title') return (c.data && c.data.title) || c.title || '';
  if (frame.type === 'meta') {
    if (frame.id && String(frame.id).indexOf('kicker') !== -1) return (c.data && c.data.kicker) || c.kicker || '';
    return c.metaLine || '';
  }
  if (frame.type === 'caption') {
    if (c.cover && c.cover.photoId === frame.photoId) return c.cover.caption || '';
    const b = (c.blocks || []).find((x) => x && x.photoId === frame.photoId);
    return (b && b.caption) || '';
  }
  if (frame.type === 'text' || frame.type === 'heading') {
    const b = (c.blocks || [])[frame.blockIndex];
    return (b && (b.text || b.para)) || '';
  }
  if (frame.type === 'note') return frame.text || '';
  return frame.text || '';
}

export function textFrameToOps(frame, ctx) {
  const c = ctx || {};
  const s = c.scale || 1;
  const measure = c.measure || fallbackMeasure;
  const text = frame.text != null ? frame.text : getFrameText(frame, c);
  if (!text) return [];
  const size = frame.type === 'heading' ? 32 * s : 27 * s;
  const font = size + 'px "Noto Sans TC", sans-serif';
  const lines = wrapTextLocal(text, font, frame.w, measure);
  const lh = size * 1.8;
  return lines.map((ln, i) => ({ op: 'text', x: frame.x, y: frame.y + i * lh + size, text: ln, font, color: '#1F2D3D' }));
}

export function applyTextEditToBlocks(blocks, frame, newText) {
  const out = (blocks || []).map((b) => ({ ...b }));
  if (frame && frame.blockIndex != null && out[frame.blockIndex]) out[frame.blockIndex].text = newText;
  return out;
}

export function focusFromCropDrag(frame, imageSize, dx, dy, focusX, focusY) {
  const iw = (imageSize && imageSize.w) || 4;
  const ih = (imageSize && imageSize.h) || 3;
  const r = Math.max(frame.w / iw, frame.h / ih);
  const dw = iw * r;
  const dh = ih * r;
  const rx = dw - frame.w;
  const ry = dh - frame.h;
  const nx = rx <= 0 ? 0.5 : clamp((focusX != null ? focusX : 0.5) - dx / rx, 0, 1);
  const ny = ry <= 0 ? 0.5 : clamp((focusY != null ? focusY : 0.5) - dy / ry, 0, 1);
  return { focusX: nx, focusY: ny };
}

export function reflowPagesChain(pages, ctx, reflowFn) {
  const fn = reflowFn || ((p) => ({ page: p, overflow: [], pages: [p] }));
  const out = [];
  let remaining = ctx && ctx.blocks ? clone(ctx.blocks) : [];
  if (!remaining.length) {
    for (const p of pages || []) {
      if (Array.isArray(p.blocks) && p.blocks.length) remaining.push(...clone(p.blocks));
      else if (Array.isArray(p.sourceBlocks) && p.sourceBlocks.length) remaining.push(...clone(p.sourceBlocks));
    }
  }
  let idx = 0;
  for (; idx < (pages || []).length; idx++) {
    const page = { ...pages[idx], frames: clone(pages[idx].frames || []), blocks: clone(remaining) };
    const res = fn(page, page.frames, { ...(ctx || {}), blocks: clone(remaining) });
    const newPage = res.page || page;
    newPage.blocks = clone(remaining);
    newPage.sourceBlocks = clone(remaining);
    out.push(newPage);
    remaining = res.overflow ? clone(res.overflow) : [];
    if (!remaining.length) {
      let hasFixedLater = false;
      for (let j = idx + 1; j < pages.length; j++) {
        const fixed = (pages[j].frames || []).filter((f) => f && (f.type === 'title' || f.type === 'meta' || f.type === 'image' || f.type === 'caption' || (f.type === 'note' && f.blockIndex == null)));
        if (fixed.length) { hasFixedLater = true; break; }
      }
      if (!hasFixedLater) break;
    }
  }
  while (remaining.length) {
    const newIndex = out.length;
    const input = { index: newIndex, frames: [], blocks: clone(remaining) };
    const res = fn(input, [], { ...(ctx || {}), blocks: clone(remaining) });
    const newPage = res.page || input;
    newPage.blocks = clone(remaining);
    out.push(newPage);
    const next = res.overflow ? clone(res.overflow) : [];
    if (next.length === remaining.length) break;
    remaining = next;
  }
  while (out.length > 1) {
    const last = out[out.length - 1];
    const hasFrames = (last.frames || []).length > 0;
    const hasOps = (last.ops || []).length > 0;
    if (!hasFrames && !hasOps) out.pop(); else break;
  }
  out.forEach((p, i) => { p.index = i; });
  return out;
}

export function mountA4Editor(container, result, opts) {
  if (typeof document === 'undefined') throw new Error('mountA4Editor 需要瀏覽器環境');
  if (!container) throw new Error('需要 container');
  if (!result || !Array.isArray(result.pages) || !result.pages.length) throw new Error('result.pages 為空，無法編輯');
  const o = opts || {};
  const measure = o.measure || fallbackMeasure;
  const imageSize = o.imageSize || (() => ({ w: 4, h: 3 }));
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
  const imagesMap = result.images instanceof Map ? result.images : new Map(Object.entries(result.images || {}));
  let pages = clone(result.pages).map((p, i) => ({ index: p.index != null ? p.index : i, frames: (p.frames || []).map((f) => ({ ...f, focusX: f.focusX != null ? f.focusX : 0.5, focusY: f.focusY != null ? f.focusY : 0.5 })), ops: clone(p.ops || []), canvas: p.canvas || null, blocks: p.blocks || p.sourceBlocks || null }));
  let blocks = clone(result.blocks || result.sourceBlocks || o.blocks || []);
  let textEdits = clone(result.textEdits || {});
  let layoutId = result.layout || 'classic';
  let scale = result.scale || 1;
  let displayWidth = 0;
  let displayScale = 0.5;
  let selected = null;
  let cropMode = null;
  let dragState = null;
  let pointers = new Map();
  let pinchStart = null;
  let rafId = 0;
  let editingTextarea = null;
  let cropEl = null;
  let history = createHistory({ pages: clone(pages), blocks: clone(blocks), textEdits: clone(textEdits) });
  let initialSnapshot = JSON.stringify(serializeLayout({ ...result, pages, blocks, textEdits }));

  function pageSnapshot(p) {
    const copy = clone({ ...p, canvas: undefined });
    copy.canvas = p.canvas || null;
    return copy;
  }
  function syncResult() {
    result.pages = pages.map(pageSnapshot);
    result.layout = layoutId;
    result.scale = scale;
    result.blocks = clone(blocks);
    result.textEdits = clone(textEdits);
    result.canvases = pages.map((p) => p.canvas).filter(Boolean);
    if (result.title == null) result.title = '';
  }
  function pushHistory() { history.push({ pages: clone(pages), blocks: clone(blocks), textEdits: clone(textEdits) }); }
  function restoreSnapshot(snap) {
    pages = clone(snap.pages); blocks = clone(snap.blocks); textEdits = clone(snap.textEdits || {});
    selected = null; cropMode = null; dragState = null;
    render(); redrawAllCanvases(); syncResult();
  }
  function isDirty() { return JSON.stringify(serializeLayout({ ...result, pages, blocks, textEdits })) !== initialSnapshot; }
  function getLayout() { return clone(pages); }
  function serialize() { return JSON.stringify(serializeLayout({ ...result, pages, blocks, textEdits }), null, 2); }
  function undo() { const s = history.undo(); if (!s) return false; restoreSnapshot(s); onChange(result); return true; }
  function redo() { const s = history.redo(); if (!s) return false; restoreSnapshot(s); onChange(result); return true; }
  function findFrame(pageIndex, frameId) {
    const p = pages[pageIndex];
    if (!p) return null;
    return (p.frames || []).find((f) => f.id === frameId) || null;
  }
  function computeDisplayScale() {
    const w = container.clientWidth || 720;
    displayWidth = Math.min(w - 16, 760);
    if (displayWidth < 280) displayWidth = 280;
    displayScale = displayWidth / A4_WIDTH;
  }
  function drawCanvasForPage(canvas, page, pageIndex) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);
    if (typeof drawA4Page === 'function') {
      try { drawA4Page(canvas, page, pageIndex, pages.length, imagesMap, result.title || '', result.theme); return; } catch (e) { /* 改用 drawA4Ops 備援 */ }
    }
    drawA4Ops(ctx, page.ops || [], imagesMap);
  }
  function redrawAllCanvases() {
    pages.forEach((p, i) => {
      if (!p.canvas) return;
      const c = p.canvas;
      c.width = A4_WIDTH; c.height = A4_HEIGHT;
      drawCanvasForPage(c, p, i);
    });
  }
  function reflowFromPage(startIndex, pinned) {
    const ctx = { measure, imageSize, scale, layout: layoutId, theme: result.theme || null, data: { title: result.title || '', kicker: result.kicker || '' }, metaLine: result.metaLine || '', cover: result.cover || null, blocks: clone(blocks) };
    let effectivePages = clone(pages);
    const pinnedList = pinned ? (Array.isArray(pinned) ? pinned : [pinned]) : [];
    if (pinnedList.length) {
      const pinnedIdx = new Set(pinnedList.map((f) => f.blockIndex));
      ctx.blocks = blocks.filter((b, i) => !pinnedIdx.has(i));
      const sp = effectivePages[startIndex || 0];
      if (sp) pinnedList.forEach((f) => { sp.frames.push({ ...f, type: 'note', blockIndex: null, id: f.id + '__pin' }); });
    }
    const all = reflowPagesChain(effectivePages, ctx, reflowPage);
    all.forEach((p) => {
      (p.ops || []).forEach((op) => {
        if (op.op === 'image') {
          const fr = (p.frames || []).find((f) => f.type === 'image' && f.photoId === op.photoId);
          if (fr) { op.focusX = fr.focusX != null ? fr.focusX : 0.5; op.focusY = fr.focusY != null ? fr.focusY : 0.5; }
          else { op.focusX = op.focusX != null ? op.focusX : 0.5; op.focusY = op.focusY != null ? op.focusY : 0.5; }
        }
      });
    });
    if (pinnedList.length) {
      const target = all[startIndex || 0];
      if (target) {
        target.frames = (target.frames || []).filter((f) => !(f.id && String(f.id).endsWith('__pin')));
        pinnedList.forEach((f) => {
          target.frames.push({ ...f });
          const ops = textFrameToOps({ ...f, text: getFrameText(f, { blocks, data: { title: result.title, kicker: result.kicker }, metaLine: result.metaLine, cover: result.cover }) }, ctx);
          target.ops.push(...ops);
        });
      }
    }
    const oldCanvases = pages.map((p) => p.canvas);
    pages = all;
    pages.forEach((p, i) => { p.canvas = oldCanvases[i] || null; });
  }
  function commitEdit(pinned) {
    pages.forEach((p, i) => {
      const rects = forbiddenRects(p, i);
      p.frames = (p.frames || []).map((f) => (f.type === 'title' || f.type === 'meta') ? f : clampOutOfForbidden(f, rects.filter((r) => r.id !== f.id), i));
      p.frames = resolvePhotoOverlaps(p.frames || []);
    });
    reflowFromPage(dragState ? dragState.pageIndex : 0, pinned || null);
    pushHistory();
    redrawAllCanvases();
    render();
    syncResult();
    onChange(result);
  }
  function showGuides(pageEl, guides) {
    hideGuides(pageEl);
    for (const g of guides || []) {
      const el = document.createElement('div');
      el.className = g.orientation === 'v' ? 'a4-guide-v' : 'a4-guide-h';
      if (g.orientation === 'v') el.style.left = (g.pos * displayScale) + 'px';
      else el.style.top = (g.pos * displayScale) + 'px';
      pageEl.appendChild(el);
    }
  }
  function hideGuides(pageEl) {
    const scope = pageEl || container;
    scope.querySelectorAll('.a4-guide-v, .a4-guide-h').forEach((el) => el.remove());
  }
  function applyFrameStyle(pageIndex, fr) {
    if (!fr) return;
    const el = container.querySelector('.a4-frame[data-page-index="' + pageIndex + '"][data-frame-id="' + fr.id + '"]');
    if (!el) return;
    el.style.left = (fr.x * displayScale) + 'px';
    el.style.top = (fr.y * displayScale) + 'px';
    el.style.width = (fr.w * displayScale) + 'px';
    el.style.height = (fr.h * displayScale) + 'px';
  }
  function scheduleOverlayUpdate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      container.querySelectorAll('.a4-editor-page').forEach((pageEl) => {
        const pi = Number(pageEl.dataset.pageIndex);
        const page = pages[pi];
        if (!page) return;
        pageEl.querySelectorAll('.a4-frame').forEach((el) => {
          const fr = (page.frames || []).find((f) => f.id === el.dataset.frameId);
          if (!fr) return;
          el.style.left = (fr.x * displayScale) + 'px';
          el.style.top = (fr.y * displayScale) + 'px';
          el.style.width = (fr.w * displayScale) + 'px';
          el.style.height = (fr.h * displayScale) + 'px';
        });
      });
    });
  }
  function updateSelection() {
    container.querySelectorAll('.a4-frame').forEach((el) => el.classList.remove('selected'));
    container.querySelectorAll('.a4-handle').forEach((el) => el.remove());
    if (!selected) return;
    const el = container.querySelector('.a4-frame[data-page-index="' + selected.pageIndex + '"][data-frame-id="' + selected.frameId + '"]');
    if (!el) return;
    el.classList.add('selected');
    const fr = findFrame(selected.pageIndex, selected.frameId);
    if (!fr || fr.locked) return;
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const h of handles) {
      const hd = document.createElement('div');
      hd.className = 'a4-handle a4-handle-' + h;
      hd.dataset.handle = h;
      hd.setAttribute('aria-label', '縮放控制點 ' + h);
      el.appendChild(hd);
    }
  }
  function render() {
    computeDisplayScale();
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add('a4-editor');
    container.setAttribute('tabindex', '0');
    container.setAttribute('role', 'application');
    container.setAttribute('aria-label', 'A4 頁面編輯器');
    const wrap = document.createElement('div');
    wrap.className = 'a4-editor-pages';
    pages.forEach((page, pi) => {
      const pageEl = document.createElement('div');
      pageEl.className = 'a4-editor-page';
      pageEl.dataset.pageIndex = String(pi);
      pageEl.style.width = displayWidth + 'px';
      pageEl.style.height = (displayWidth * A4_HEIGHT / A4_WIDTH) + 'px';
      const canvas = document.createElement('canvas');
      canvas.width = A4_WIDTH; canvas.height = A4_HEIGHT;
      canvas.className = 'a4-editor-canvas';
      page.canvas = canvas;
      drawCanvasForPage(canvas, page, pi);
      pageEl.appendChild(canvas);
      const overlay = document.createElement('div');
      overlay.className = 'a4-overlay';
      overlay.dataset.pageIndex = String(pi);
      (page.frames || []).forEach((fr) => {
        const el = document.createElement('div');
        el.className = 'a4-frame a4-frame-' + fr.type + (fr.locked ? ' is-locked' : '');
        el.dataset.frameId = fr.id;
        el.dataset.frameType = fr.type;
        el.dataset.pageIndex = String(pi);
        el.setAttribute('data-testid', 'a4-frame-' + fr.id);
        el.style.left = (fr.x * displayScale) + 'px';
        el.style.top = (fr.y * displayScale) + 'px';
        el.style.width = (fr.w * displayScale) + 'px';
        el.style.height = (fr.h * displayScale) + 'px';
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', fr.type + ' ' + fr.id);
        if (fr.locked) el.title = '已鎖定，可選取但不可移動、縮放或刪除';
        overlay.appendChild(el);
      });
      pageEl.appendChild(overlay);
      const cap = document.createElement('figcaption');
      cap.className = 'a4-editor-caption';
      cap.textContent = '第 ' + (pi + 1) + ' / ' + pages.length + ' 頁';
      const fig = document.createElement('figure');
      fig.className = 'a4-editor-figure a4-page';
      fig.setAttribute('data-testid', 'a4-page-' + (pi + 1));
      fig.appendChild(pageEl);
      fig.appendChild(cap);
      if (typeof o.onDownloadPage === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.setAttribute('data-testid', 'png-' + (pi + 1));
        btn.textContent = '下載第 ' + (pi + 1) + ' 頁 PNG';
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          o.onDownloadPage(pi, pages[pi]);
        });
        fig.appendChild(btn);
      }
      wrap.appendChild(fig);
    });
    const bar = document.createElement('div');
    bar.className = 'a4-editor-toolbar';
    bar.setAttribute('data-testid', 'a4-editor-toolbar');
    const mkBtn = (label, testid, fn, enabled) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn a4-editor-' + testid;
      btn.setAttribute('data-testid', 'a4-' + testid);
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); });
      return btn;
    };
    bar.appendChild(mkBtn('復原', 'undo', () => undo(), history.canUndo()));
    bar.appendChild(mkBtn('重做', 'redo', () => redo(), history.canRedo()));
    container.appendChild(bar);
    container.appendChild(wrap);
    updateSelection();
  }
  function deletePhotoFrame(pageIndex, frameId) {
    const page = pages[pageIndex];
    if (!page) return false;
    const fr = findFrame(pageIndex, frameId);
    if (!fr || fr.type !== 'image' || fr.locked) return false;
    const pid = fr.photoId;
    page.frames = (page.frames || []).filter((f) => !(f.id === frameId || (f.type === 'caption' && f.photoId === pid)));
    selected = null;
    commitEdit(null);
    return true;
  }
  function startTextEdit(pageIndex, frame) {
    if (editingTextarea) return;
    const pageEl = container.querySelector('.a4-editor-page[data-page-index="' + pageIndex + '"]');
    const frameEl = pageEl ? pageEl.querySelector('.a4-frame[data-frame-id="' + frame.id + '"]') : null;
    if (!pageEl || !frameEl) return;
    const ctx = { blocks, data: { title: result.title || '', kicker: result.kicker || '' }, metaLine: result.metaLine || '', cover: result.cover || null };
    const cur = getFrameText(frame, ctx);
    const ta = document.createElement('textarea');
    ta.className = 'a4-text-editor';
    ta.value = cur;
    ta.style.left = frameEl.style.left;
    ta.style.top = frameEl.style.top;
    ta.style.width = frameEl.style.width;
    ta.style.height = Math.max(parseFloat(frameEl.style.height) || 60, 60) + 'px';
    ta.setAttribute('aria-label', '編輯文字');
    pageEl.appendChild(ta);
    editingTextarea = ta;
    ta.focus();
    ta.select();
    let done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      const val = ta.value;
      ta.remove();
      editingTextarea = null;
      if (!commit) return;
      if (val === cur) return;
      if (frame.type === 'title') { result.title = val; textEdits[frame.id] = val; }
      else if (frame.type === 'meta') {
        if (frame.id && String(frame.id).indexOf('kicker') !== -1) { result.kicker = val; } else { result.metaLine = val; }
        textEdits[frame.id] = val;
      } else if (frame.type === 'caption') {
        textEdits[frame.id] = val;
        const b = blocks.find((x) => x && x.photoId === frame.photoId);
        if (b) b.caption = val;
        else if (result.cover && result.cover.photoId === frame.photoId) result.cover.caption = val;
      } else {
        blocks = applyTextEditToBlocks(blocks, frame, val);
        textEdits[frame.id] = val;
      }
      const pinned = (frame.type === 'text' || frame.type === 'heading') ? [{ ...frame }] : null;
      commitEdit(pinned);
    }
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { finish(false); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { finish(true); }
    });
  }
  function enterCropMode(pageIndex, frame) {
    exitCropMode(false);
    const pageEl = container.querySelector('.a4-editor-page[data-page-index="' + pageIndex + '"]');
    if (!pageEl) return;
    const img = imagesMap.get(frame.photoId);
    if (!img || !img.src) return;
    cropMode = { pageIndex, frameId: frame.id };
    selected = { pageIndex, frameId: frame.id };
    updateSelection();
    const el = document.createElement('div');
    el.className = 'a4-crop';
    el.style.left = (frame.x * displayScale) + 'px';
    el.style.top = (frame.y * displayScale) + 'px';
    el.style.width = (frame.w * displayScale) + 'px';
    el.style.height = (frame.h * displayScale) + 'px';
    const iw = img.naturalWidth || img.width || 4;
    const ih = img.naturalHeight || img.height || 3;
    const r = Math.max(frame.w / iw, frame.h / ih);
    const dw = iw * r;
    const dh = ih * r;
    const inner = document.createElement('img');
    inner.className = 'a4-crop-img';
    inner.src = img.src;
    inner.alt = '';
    inner.style.width = (dw * displayScale) + 'px';
    inner.style.height = (dh * displayScale) + 'px';
    inner.style.left = ((frame.w - dw) * (frame.focusX != null ? frame.focusX : 0.5) * displayScale) + 'px';
    inner.style.top = ((frame.h - dh) * (frame.focusY != null ? frame.focusY : 0.5) * displayScale) + 'px';
    el.appendChild(inner);
    const hint = document.createElement('div');
    hint.className = 'a4-crop-hint';
    hint.textContent = '拖動照片調整裁切位置，按 Esc 或點空白處完成';
    el.appendChild(hint);
    pageEl.appendChild(el);
    cropEl = el;
    let sx = 0;
    let sy = 0;
    let startFocus = { focusX: frame.focusX != null ? frame.focusX : 0.5, focusY: frame.focusY != null ? frame.focusY : 0.5 };
    function onMove(e) {
      const dx = (e.clientX - sx) / displayScale;
      const dy = (e.clientY - sy) / displayScale;
      const nf = focusFromCropDrag(frame, { w: iw, h: ih }, dx, dy, startFocus.focusX, startFocus.focusY);
      frame.focusX = nf.focusX; frame.focusY = nf.focusY;
      inner.style.left = ((frame.w - dw) * nf.focusX * displayScale) + 'px';
      inner.style.top = ((frame.h - dh) * nf.focusY * displayScale) + 'px';
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const page = pages[pageIndex];
      if (page) {
        const op = (page.ops || []).find((x) => x.op === 'image' && x.photoId === frame.photoId);
        if (op) { op.focusX = frame.focusX; op.focusY = frame.focusY; }
      }
      exitCropMode(true);
    }
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      sx = e.clientX; sy = e.clientY;
      startFocus = { focusX: frame.focusX, focusY: frame.focusY };
      el.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
  function exitCropMode(commit) {
    if (cropEl) { cropEl.remove(); cropEl = null; }
    if (cropMode && commit) {
      const cm = cropMode;
      cropMode = null;
      pushHistory();
      redrawAllCanvases();
      render();
      syncResult();
      onChange(result);
      return cm;
    }
    cropMode = null;
    return null;
  }
  function onPointerDown(e) {
    if (editingTextarea) return;
    const handleEl = e.target.closest('.a4-handle');
    const frameEl = e.target.closest('.a4-frame');
    const pageEl = e.target.closest('.a4-editor-page');
    if (!pageEl) return;
    const pageIndex = Number(pageEl.dataset.pageIndex);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStart = { dist, frame: selected ? clone(findFrame(selected.pageIndex, selected.frameId)) : null, displayScale };
      dragState = null;
      return;
    }
    if (cropMode) { exitCropMode(true); }
    if (handleEl && frameEl) {
      const frameId = frameEl.dataset.frameId;
      const fr = findFrame(pageIndex, frameId);
      if (!fr || fr.locked) return;
      selected = { pageIndex, frameId };
      updateSelection();
      dragState = { type: 'resize', pageIndex, frameId, handle: handleEl.dataset.handle, startX: e.clientX, startY: e.clientY, orig: clone(fr) };
      frameEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (frameEl) {
      const frameId = frameEl.dataset.frameId;
      const fr = findFrame(pageIndex, frameId);
      if (!fr) return;
      selected = { pageIndex, frameId };
      updateSelection();
      if (fr.locked) { dragState = null; return; }
      dragState = { type: 'move', pageIndex, frameId, startX: e.clientX, startY: e.clientY, orig: clone(fr), moved: false };
      frameEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    selected = null;
    updateSelection();
    dragState = null;
  }
  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (dist <= 0 || pinchStart.dist <= 0) return;
      const factor = dist / pinchStart.dist;
      if (selected && pinchStart.frame) {
        const fr = findFrame(selected.pageIndex, selected.frameId);
        if (!fr || fr.locked) return;
        const orig = pinchStart.frame;
        const nw = Math.max(40, orig.w * factor);
        const nh = Math.max(40, orig.h * factor);
        fr.w = Math.round(nw);
        fr.h = Math.round(nh);
        fr.x = Math.round(orig.x + (orig.w - nw) / 2);
        fr.y = Math.round(orig.y + (orig.h - nh) / 2);
        applyFrameStyle(selected.pageIndex, fr);
        scheduleOverlayUpdate();
      } else {
        displayScale = clamp(pinchStart.displayScale * factor, 0.3, 2);
        displayWidth = Math.round(displayScale * A4_WIDTH);
        container.querySelectorAll('.a4-editor-page').forEach((pe) => {
          pe.style.width = displayWidth + 'px';
          pe.style.height = (displayWidth * A4_HEIGHT / A4_WIDTH) + 'px';
        });
        scheduleOverlayUpdate();
      }
      return;
    }
    if (!dragState) return;
    const page = pages[dragState.pageIndex];
    if (!page) return;
    const fr = findFrame(dragState.pageIndex, dragState.frameId);
    if (!fr || fr.locked) return;
    const dxA4 = (e.clientX - dragState.startX) / displayScale;
    const dyA4 = (e.clientY - dragState.startY) / displayScale;
    if (dragState.type === 'move') {
      const moved = { ...dragState.orig, x: dragState.orig.x + dxA4, y: dragState.orig.y + dyA4 };
      const others = (page.frames || []).filter((f) => f.id !== fr.id);
      const snap = computeSnap(moved, others, { layout: layoutId, displayScale, threshold: SNAP_THRESHOLD });
      const raw = { ...moved, x: moved.x + snap.dx, y: moved.y + snap.dy };
      const safe = fr.type === 'title' || fr.type === 'meta'
        ? { ...raw, x: clamp(raw.x, 0, A4_WIDTH - fr.w), y: clamp(raw.y, 0, A4_HEIGHT - fr.h) }
        : clampOutOfForbidden(raw, forbiddenRects(page, dragState.pageIndex, fr.id), dragState.pageIndex);
      fr.x = Math.round(safe.x);
      fr.y = Math.round(safe.y);
      dragState.moved = true;
      const pageEl = container.querySelector('.a4-editor-page[data-page-index="' + dragState.pageIndex + '"]');
      if (pageEl) showGuides(pageEl, snap.guides);
      applyFrameStyle(dragState.pageIndex, fr);
      scheduleOverlayUpdate();
    } else if (dragState.type === 'resize') {
      const isPhoto = dragState.orig.type === 'image';
      const keep = isPhoto ? !e.shiftKey : !!e.shiftKey;
      const next = resizeFrame(dragState.orig, dragState.handle, dxA4, dyA4, keep);
      const safe = fr.type === 'title' || fr.type === 'meta' ? next : clampOutOfForbidden(next, forbiddenRects(page, dragState.pageIndex, fr.id), dragState.pageIndex);
      fr.x = safe.x; fr.y = safe.y; fr.w = safe.w; fr.h = safe.h;
      applyFrameStyle(dragState.pageIndex, fr);
      scheduleOverlayUpdate();
    }
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (!dragState) return;
    const ds = dragState;
    dragState = null;
    const pageEl = container.querySelector('.a4-editor-page[data-page-index="' + ds.pageIndex + '"]');
    if (pageEl) hideGuides(pageEl);
    if (ds.type === 'move' && !ds.moved) return;
    const fr = findFrame(ds.pageIndex, ds.frameId);
    if (!fr) return;
    const pinned = (fr.type === 'text' || fr.type === 'heading') ? [{ ...fr }] : null;
    commitEdit(pinned);
  }
  function onKeyDown(e) {
    if (editingTextarea) return;
    if (!selected) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
      return;
    }
    const fr = findFrame(selected.pageIndex, selected.frameId);
    if (!fr) return;
    if (e.key === 'Escape') {
      if (cropMode) { exitCropMode(true); return; }
      selected = null; updateSelection(); e.preventDefault(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !fr.locked) {
      if (fr.type === 'image') { e.preventDefault(); deletePhotoFrame(selected.pageIndex, selected.frameId); }
      return;
    }
    if (e.key.indexOf('Arrow') === 0) {
      if (fr.locked) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') fr.x -= step;
      if (e.key === 'ArrowRight') fr.x += step;
      if (e.key === 'ArrowUp') fr.y -= step;
      if (e.key === 'ArrowDown') fr.y += step;
      const page = pages[selected.pageIndex];
      const safe = (fr.type === 'title' || fr.type === 'meta')
        ? { x: clamp(fr.x, 0, A4_WIDTH - fr.w), y: clamp(fr.y, 0, A4_HEIGHT - fr.h) }
        : clampOutOfForbidden(fr, forbiddenRects(page, selected.pageIndex, fr.id), selected.pageIndex);
      fr.x = Math.round(safe.x);
      fr.y = Math.round(safe.y);
      scheduleOverlayUpdate();
      clearTimeout(onKeyDown._t);
      onKeyDown._t = setTimeout(() => {
        const pinned = (fr.type === 'text' || fr.type === 'heading') ? [{ ...fr }] : null;
        commitEdit(pinned);
      }, 350);
    }
  }
  function onDblClick(e) {
    const frameEl = e.target.closest('.a4-frame');
    if (!frameEl) return;
    const pageIndex = Number(frameEl.dataset.pageIndex);
    const fr = findFrame(pageIndex, frameEl.dataset.frameId);
    if (!fr || fr.locked) return;
    if (fr.type === 'image') { enterCropMode(pageIndex, fr); return; }
    if (fr.type === 'title' || fr.type === 'meta' || fr.type === 'text' || fr.type === 'heading' || fr.type === 'caption') startTextEdit(pageIndex, fr);
  }
  function onResize() { render(); }
  const moveOpts = { capture: true };
  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, moveOpts);
  window.addEventListener('pointerup', onPointerUp, moveOpts);
  window.addEventListener('pointercancel', onPointerUp, moveOpts);
  window.addEventListener('mousemove', onPointerMove, moveOpts);
  window.addEventListener('mouseup', onPointerUp, moveOpts);
  function onGlobalKeyDown(e) {
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    if (editingTextarea) return;
    onKeyDown(e);
  }
  document.addEventListener('keydown', onGlobalKeyDown);
  container.addEventListener('dblclick', onDblClick);
  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => { if (!editingTextarea) onResize(); });
    resizeObserver.observe(container);
  } else {
    window.addEventListener('resize', onResize);
  }
  render();
  syncResult();
  function destroy() {
    if (rafId) cancelAnimationFrame(rafId);
    container.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove, { capture: true });
    window.removeEventListener('pointerup', onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', onPointerUp, { capture: true });
    window.removeEventListener('mousemove', onPointerMove, { capture: true });
    window.removeEventListener('mouseup', onPointerUp, { capture: true });
    document.removeEventListener('keydown', onGlobalKeyDown);
    container.removeEventListener('dblclick', onDblClick);
    if (resizeObserver) resizeObserver.disconnect();
    else window.removeEventListener('resize', onResize);
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.remove('a4-editor');
    container.removeAttribute('role');
    container.removeAttribute('aria-label');
  }
  function applyLayout(input) {
    const data = parseLayout(input);
    layoutId = data.layout || layoutId;
    scale = data.scale || scale;
    if (data.title != null) result.title = data.title;
    if (data.kicker != null) result.kicker = data.kicker;
    if (data.metaLine != null) result.metaLine = data.metaLine;
    if (Array.isArray(data.blocks)) blocks = clone(data.blocks);
    if (data.textEdits) textEdits = clone(data.textEdits);
    pages = data.pages.map((p, i) => ({ index: p.index != null ? p.index : i, frames: (p.frames || []).map((f) => ({ ...f, focusX: f.focusX != null ? f.focusX : 0.5, focusY: f.focusY != null ? f.focusY : 0.5 })), ops: [], canvas: null }));
    reflowFromPage(0, null);
    redrawAllCanvases();
    render();
    pushHistory();
    syncResult();
    onChange(result);
    return true;
  }
  return { destroy, getLayout, serialize, applyLayout, undo, redo, isDirty, canUndo: () => history.canUndo(), canRedo: () => history.canRedo() };
}
