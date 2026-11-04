// A4 圖檔產生（瀏覽器）：用 a4-layout.mjs 排版、畫到 canvas，自動縮放字級／圖片以塞進指定頁數；
// 真的塞不下就減少節錄字數（必要時減少照片），並在最後加「全文見網頁版」。
// A4／PDF 完全不放影片（不放封面、不放 QR 碼），只有文字和照片；網頁版才有影片。

import { A4, COLORS, FONT_FAMILY, font, layoutA4 } from './a4-layout.mjs';
import { LOGO_DATA_URL } from '../brand.mjs';

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
    ctx.drawImage(img, op.x + (op.w - dw) / 2, op.y + (op.h - dh) / 2, dw, dh);
  }
  ctx.restore();
}

function drawChrome(ctx, index, total, title) {
  const W = A4.width;
  const H = A4.height;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  if (index === 0) {
    ctx.fillStyle = COLORS.navy;
    ctx.fillRect(0, 0, W, 132);
    ctx.fillStyle = COLORS.goldLight;
    ctx.fillRect(0, 132, W, 5);
    if (logoImg) {
      ctx.drawImage(logoImg, 100, 22, 88, 88);
    } else {
      ctx.beginPath();
      ctx.arc(140, 66, 36, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.goldLight;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.font = font(36, 900);
    ctx.textAlign = 'left';
    ctx.fillText('台中市召會', 196, 64);
    ctx.fillStyle = COLORS.goldLight;
    ctx.font = font(18, 700);
    ctx.fillText('THE CHURCH IN TAICHUNG', 198, 96);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = font(24, 700);
    ctx.fillText('行動報導', W - 100, 78);
  } else {
    ctx.fillStyle = COLORS.goldLight;
    ctx.fillRect(0, 0, W, 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.navy;
    ctx.font = font(20, 700);
    ctx.fillText('台中市召會　行動報導', 100, 70);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.gray;
    ctx.font = font(20);
    const t = title.length > 30 ? `${title.slice(0, 30)}…` : title;
    ctx.fillText(t, W - 100, 70);
    ctx.fillStyle = COLORS.line;
    ctx.fillRect(100, 92, W - 200, 2);
  }
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(100, H - 96, W - 200, 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.gray;
  ctx.font = font(20);
  ctx.fillText(`— ${index + 1} / ${total} —`, W / 2, H - 56);
}

function drawPage(page, index, total, title, images) {
  const canvas = document.createElement('canvas');
  canvas.width = A4.width;
  canvas.height = A4.height;
  const ctx = canvas.getContext('2d');
  drawChrome(ctx, index, total, title);
  for (const op of page.ops) {
    if (op.op === 'text') {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align || 'left';
      ctx.fillText(op.text, op.x, op.y);
    } else if (op.op === 'image') drawImage(ctx, images.get(op.photoId), op);
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
  return canvas;
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
  const target = settings.pages;
  const images = new Map();
  logoImg = await loadLogo();
  const ensureImages = async (comp) => {
    for (const id of photoIdsOf(comp)) if (!images.has(id)) images.set(id, await opts.loadImage(id));
  };
  const imageSize = (id) => {
    const img = images.get(id);
    return img ? { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height } : null;
  };

  let words = settings.words;
  let maxPhotos = settings.maxPhotos;
  let truncated = false;
  let last = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const raw = await opts.compose({ words, maxPhotos, note: truncated ? FULL_TEXT_NOTE : null });
    // 保險：就算 compose 沒帶 print，也不讓影片區塊進 A4
    const comp = { ...raw, blocks: raw.blocks.filter((b) => b.type !== 'video') };
    await ensureImages(comp);
    for (const scale of SCALES) {
      const res = layoutA4({ data: comp.data, metaLine: opts.metaLine, cover: comp.cover, blocks: comp.blocks, layout: settings.layout, scale, measure, imageSize });
      last = { res, comp, scale };
      if (res.pages.length <= target) {
        const canvases = res.pages.map((p, i) => drawPage(p, i, res.pages.length, comp.data.title, images));
        return { canvases, pages: canvases.length, truncated, scale, words, comp };
      }
    }
    // 塞不下：先減字數，字數到底再減照片
    truncated = true;
    if (words > 150) words = Math.max(150, Math.floor(words * 0.75));
    else if (maxPhotos > 1) maxPhotos = Math.max(1, Math.floor(maxPhotos / 2));
    else break;
  }
  // 最後手段：只保留前 target 頁
  const pages = last.res.pages.slice(0, target);
  const canvases = pages.map((p, i) => drawPage(p, i, pages.length, last.comp.data.title, images));
  const ctx = canvases[canvases.length - 1].getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(100, A4.height - 170, A4.width - 200, 60);
  ctx.fillStyle = COLORS.gold;
  ctx.textAlign = 'center';
  ctx.font = `700 24px ${FONT_FAMILY}`;
  ctx.fillText(FULL_TEXT_NOTE, A4.width / 2, A4.height - 130);
  return { canvases, pages: canvases.length, truncated: true, scale: last.scale, words, comp: last.comp };
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
