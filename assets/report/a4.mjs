// A4 圖檔產生（瀏覽器）：用 a4-layout.mjs 排版、畫到 canvas，自動縮放字級／圖片以塞進指定頁數；
// 真的塞不下就減少節錄字數（必要時減少照片），並在最後加「全文見網頁版」。
// A4／PDF 完全不放影片（不放封面、不放 QR 碼），只有文字和照片；網頁版才有影片。

import { A4, COLORS, FONT_FAMILY, font, layoutA4 } from './a4-layout.mjs?v=6afe119b22';
import { LOGO_DATA_URL } from '../brand.mjs?v=6afe119b22';
import { getTheme, drawPattern } from './themes.mjs?v=6afe119b22';


function themePalette(theme) {
  const t = theme && theme.colors ? theme : getTheme(theme && theme.id ? theme.id : theme);
  return { theme: t, c: t && t.colors ? { ...COLORS, ...t.colors } : COLORS };
}

let logoPromise = null;
/** 載入台中市召會標誌（只載一次；失敗回 null，改畫簡單外框） */
function loadLogo() {
  if (!logoPromise) {
    logoPromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = LOGO_DATA_URL;
    });
  }
  return logoPromise;
}
let logoImg = null;

export const FULL_TEXT_NOTE = '（篇幅所限，以上為節錄，全文見網頁版）';
const SCALES = [1, 0.93, 0.86, 0.8, 0.74, 0.68, 0.62];

let measureCtx = null;
function measure(text, fnt) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = fnt;
  return measureCtx.measureText(text).width;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawImage(ctx, img, op) {
  ctx.save();
  roundRect(ctx, op.x, op.y, op.w, op.h, op.radius || 0);
  ctx.clip();
  if (!img) {
    ctx.fillStyle = COLORS.line;
    ctx.fillRect(op.x, op.y, op.w, op.h);
  } else {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const r = op.fit === 'cover' ? Math.max(op.w / iw, op.h / ih) : Math.min(op.w / iw, op.h / ih);
    const dw = iw * r;
    const dh = ih * r;
    const fx = op.focusX != null ? op.focusX : 0.5;
    const fy = op.focusY != null ? op.focusY : 0.5;
    ctx.drawImage(img, op.x + (op.w - dw) * fx, op.y + (op.h - dh) * fy, dw, dh);
  }
  ctx.restore();
}

function drawChrome(ctx, index, total, title, theme) {
  const { theme: t, c } = themePalette(theme);
  const W = A4.width;
  const H = A4.height;
  const headerText = c.headerText || '#fff';
  const titleFamily = t && t.titleFont ? `"${t.titleFont}",${FONT_FAMILY}` : FONT_FAMILY;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);
  if (t) drawPattern(ctx, t, { width: W, height: H, index });
  ctx.textBaseline = 'alphabetic';
  if (index === 0) {
    ctx.fillStyle = c.navy;
    ctx.fillRect(0, 0, W, 132);
    ctx.fillStyle = c.goldLight;
    ctx.fillRect(0, 132, W, 5);
    if (logoImg) {
      ctx.drawImage(logoImg, 100, 22, 88, 88);
    } else {
      ctx.beginPath();
      ctx.arc(140, 66, 36, 0, Math.PI * 2);
      ctx.strokeStyle = c.goldLight;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = headerText;
    ctx.font = font(36, 900);
    ctx.textAlign = 'left';
    ctx.fillText('台中市召會', 196, 64);
    ctx.fillStyle = c.goldLight;
    ctx.font = font(18, 700);
    ctx.fillText('THE CHURCH IN TAICHUNG', 198, 96);
    ctx.textAlign = 'right';
    ctx.fillStyle = headerText;
    ctx.font = font(24, 700);
    ctx.fillText('行動報導', W - 100, 78);
  } else {
    ctx.fillStyle = c.goldLight;
    ctx.fillRect(0, 0, W, 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = c.navy;
    ctx.font = font(20, 700);
    ctx.fillText('台中市召會　行動報導', 100, 70);
    ctx.textAlign = 'right';
    ctx.fillStyle = c.gray;
    ctx.font = font(20);
    const t = title.length > 30 ? `${title.slice(0, 30)}…` : title;
    ctx.fillText(t, W - 100, 70);
    ctx.fillStyle = c.line;
    ctx.fillRect(100, 92, W - 200, 2);
  }
  ctx.fillStyle = c.line;
  ctx.fillRect(100, H - 96, W - 200, 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = c.gray;
  ctx.font = font(20);
  ctx.fillText(`— ${index + 1} / ${total} —`, W / 2, H - 56);
}

function drawFooter(ctx, index, total, light, theme) {
  const { c } = themePalette(theme);
  const W = A4.width;
  const H = A4.height;
  ctx.fillStyle = light ? 'rgba(255,255,255,0.45)' : c.line;
  ctx.fillRect(100, H - 96, W - 200, 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = light ? '#ffffff' : c.gray;
  ctx.font = font(20);
  ctx.fillText(`— ${index + 1} / ${total} —`, W / 2, H - 56);
}

/** 把一頁的 ops 畫到既有 canvas context（給預覽／編輯器）。images 可省略。 */
export function drawA4Ops(ctx, ops, images) {
  const map = images instanceof Map ? images : new Map(Object.entries(images || {}));
  for (const op of ops || []) {
    if (op.op === 'text') {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align || 'left';
      ctx.fillText(op.text, op.x, op.y);
    } else if (op.op === 'image') drawImage(ctx, map.get(op.photoId), op);
    else if (op.op === 'rect') {
      if (op.fill) {
        ctx.fillStyle = op.fill;
        ctx.fillRect(op.x, op.y, op.w, op.h);
      }
      if (op.stroke) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = 2;
        ctx.strokeRect(op.x, op.y, op.w, op.h);
      }
    } else if (op.op === 'line') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width || 1;
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
    }
  }
}

function attachFocus(pages) {
  for (const page of pages || []) {
    for (const f of page.frames || []) {
      if (f.type === 'image') {
        if (f.focusX == null) f.focusX = 0.5;
        if (f.focusY == null) f.focusY = 0.5;
      }
    }
    for (const op of page.ops || []) {
      if (op.op === 'image') {
        const fr = (page.frames || []).find((f) => f.type === 'image' && f.photoId === op.photoId);
        op.focusX = fr ? fr.focusX : (op.focusX != null ? op.focusX : 0.5);
        op.focusY = fr ? fr.focusY : (op.focusY != null ? op.focusY : 0.5);
      }
    }
  }
  return pages;
}

function paintPage(canvas, page, index, total, title, images, theme) {
  canvas.width = A4.width;
  canvas.height = A4.height;
  const ctx = canvas.getContext('2d');
  drawChrome(ctx, index, total, title, theme);
  drawA4Ops(ctx, page.ops, images);
  const fullbleed = (page.ops || []).some((o) => o.op === 'image' && o.x <= 0 && o.y <= 0 && o.w >= A4.width && o.h >= A4.height - 1);
  drawFooter(ctx, index, total, fullbleed, theme);
  return canvas;
}

function drawPage(page, index, total, title, images, theme) {
  return paintPage(document.createElement('canvas'), page, index, total, title, images, theme);
}

/** 把一頁重畫到既有 canvas（給編輯器）。沿用正式頁首頁尾，不會改成簡化版頁眉。 */
export function drawA4Page(canvas, page, pageIndex, total, images, title, theme) {
  if (!canvas) return canvas;
  return paintPage(canvas, page, pageIndex, total, title || '', images, theme);
}

function photoIdsOf(comp) {
  const ids = new Set();
  if (comp.cover) ids.add(comp.cover.photoId);
  for (const b of comp.blocks) {
    if (b.type === 'figure') ids.add(b.photoId);
  }
  return [...ids];
}

/**
 * 把一份內容塞進 target 頁：先試各種字級縮放，塞不下就減字數、再減照片；最後手段只留前 target 頁並註明。
 * 回傳 { pages, comp, scale, truncated, words, lastResort }
 */
async function fitPages({ compose, words, maxPhotos, target, header, layout, metaLine, ensureImages, imageSize, startPage = 0, theme = null }) {
  let truncated = false;
  let last = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const raw = await compose({ words, maxPhotos, note: truncated ? FULL_TEXT_NOTE : null });
    // 保險：就算 compose 沒帶 print，也不讓影片區塊進 A4
    const comp = { ...raw, blocks: raw.blocks.filter((b) => b.type !== 'video') };
    await ensureImages(comp);
    for (const scale of SCALES) {
      const res = layoutA4({ data: comp.data, metaLine, cover: comp.cover, blocks: comp.blocks, layout, scale, measure, imageSize, header, startPage, theme });
      last = { res, comp, scale };
      if (res.pages.length <= target) return { pages: res.pages, comp, scale, truncated, words, lastResort: false };
    }
    // 塞不下：先減字數，字數到底再減照片
    truncated = true;
    if (words > 150) words = Math.max(150, Math.floor(words * 0.75));
    else if (maxPhotos > 1) maxPhotos = Math.max(1, Math.floor(maxPhotos / 2));
    else break;
  }
  return { pages: last.res.pages.slice(0, target), comp: last.comp, scale: last.scale, truncated: true, words, lastResort: true };
}

function stampNote(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(100, A4.height - 170, A4.width - 200, 60);
  ctx.fillStyle = COLORS.gold;
  ctx.textAlign = 'center';
  ctx.font = `700 24px ${FONT_FAMILY}`;
  ctx.fillText(FULL_TEXT_NOTE, A4.width / 2, A4.height - 130);
}

async function imageHelpers(loadImage) {
  const images = new Map();
  logoImg = await loadLogo();
  const ensureImages = async (comp) => {
    for (const id of photoIdsOf(comp)) if (!images.has(id)) images.set(id, await loadImage(id));
  };
  const imageSize = (id) => {
    const img = images.get(id);
    return img ? { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height } : null;
  };
  return { images, ensureImages, imageSize };
}

/**
 * opts: {
 *   compose: async ({ words, maxPhotos, note }) => composeReport({ …, print: true }) 的結果
 *   settings: { words, maxPhotos, pages, layout }
 *   loadImage: async (photoId) => HTMLImageElement | null
 *   metaLine: string
 * }
 * 回傳 { canvases, pages, truncated, scale, words, comp }
 */
export async function renderA4(opts) {
  const { settings } = opts;
  const theme = opts.theme || settings.theme || null;
  const { images, ensureImages, imageSize } = await imageHelpers(opts.loadImage);
  const r = await fitPages({ compose: opts.compose, words: settings.words, maxPhotos: settings.maxPhotos, target: settings.pages, header: true, layout: settings.layout, metaLine: opts.metaLine, ensureImages, imageSize, theme });
  attachFocus(r.pages);
  const canvases = r.pages.map((p, i) => {
    const c = drawPage(p, i, r.pages.length, r.comp.data.title, images, theme);
    p.canvas = c;
    return c;
  });
  if (r.lastResort) stampNote(canvases[canvases.length - 1]);
  return { canvases, pages: canvases.length, layoutPages: r.pages, images, truncated: r.truncated, scale: r.scale, words: r.words, comp: r.comp, theme };
}

/**
 * 自訂每一頁的內容（例如第 1 頁全體、第 2 頁北屯區＋西屯區…）：每一頁各自塞到剛好一頁。
 * opts: {
 *   plan: [{ compose: async ({ words, maxPhotos, note, header }) => comp }]，一頁一項
 *   settings: { words, maxPhotos, layout }（字數與照片上限平均分給每一頁）
 *   loadImage, metaLine
 * }
 * 回傳 { canvases, pages, truncated, scale（最小的）, comps }
 */
export async function renderA4Plan(opts) {
  const { settings, plan } = opts;
  const { images, ensureImages, imageSize } = await imageHelpers(opts.loadImage);
  const n = plan.length;
  const words = Math.max(150, Math.round(settings.words / n));
  const maxPhotos = Math.max(1, Math.round(settings.maxPhotos / n));
  const results = [];
  for (let i = 0; i < n; i++) {
    const header = i === 0;
    results.push(
      await fitPages({
        compose: (o) => plan[i].compose({ ...o, header }),
        words,
        maxPhotos,
        target: 1,
        header,
        startPage: i,
        layout: settings.layout,
        metaLine: opts.metaLine,
        ensureImages,
        imageSize,
        theme: opts.theme || settings.theme || null,
      }),
    );
  }
  const title = results[0].comp.data.title;
  const layoutPages = results.map((r, i) => {
    const page = r.pages[0] || { ops: [], frames: [] };
    page.index = i;
    return page;
  });
  attachFocus(layoutPages);
  const canvases = layoutPages.map((page, i) => {
    const c = drawPage(page, i, n, title, images, opts.theme || settings.theme || null);
    if (results[i].lastResort) stampNote(c);
    page.canvas = c;
    return c;
  });
  return {
    canvases,
    pages: n,
    layoutPages,
    images,
    truncated: results.some((r) => r.truncated),
    scale: Math.min(...results.map((r) => r.scale)),
    comps: results.map((r) => r.comp),
    theme: opts.theme || settings.theme || null,
  };
}

export function canvasToJpegBytes(canvas, quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) return reject(new Error('無法產生 JPEG'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      'image/jpeg',
      quality,
    );
  });
}
