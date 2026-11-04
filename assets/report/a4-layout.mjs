// A4 版面計算（純函式，不碰 DOM）：把報導區塊排進 1240×1754 px（A4 210:297，150dpi）頁面。
// 回傳每頁的繪圖指令，由 a4.mjs 畫到 canvas。A4／PDF 不放影片：video 區塊一律略過。measure(text, font) 由呼叫端提供（canvas.measureText 或測試用假函式）。

export const A4 = { width: 1240, height: 1754 };
export const FONT_FAMILY = '"Noto Sans CJK TC","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';
export const COLORS = { navy: '#16324F', gold: '#836427', goldLight: '#C9A865', text: '#1F2D3D', gray: '#5A6A7A', line: '#E4E3DE', bg: '#FFFFFF', paper: '#F5F5F2' };

const MARGIN = 100;
const TOP_FIRST = 196;
const TOP_OTHER = 150;
const BOTTOM = A4.height - 130;

export const font = (size, weight = 400) => `${weight} ${Math.round(size)}px ${FONT_FAMILY}`;

const NO_LINE_START = '，。、；：！？）」』】》〉,.;:!?)」”’…';
const TOKEN_RE = /[A-Za-z0-9@#$%&*+=/:._~'"\-]+\s*|\s+|[\s\S]/gu;

/** 依寬度換行：中文逐字、英數以單字為單位；行首避開標點。 */
export function wrapText(text, fnt, width, measure) {
  const lines = [];
  let line = '';
  const tokens = String(text ?? '').match(TOKEN_RE) || [];
  for (let tok of tokens) {
    if (measure(tok, fnt) > width) {
      // 太長的英數串（例如網址）拆成單字元
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

/**
 * input: {
 *   data: { title, kicker }, metaLine, cover: { photoId, caption } | null, blocks,
 *   layout: 'classic'|'alternate'|'columns', scale, measure, imageSize(photoId) → {w,h}|null
 * }
 * 回傳 { pages: [{ ops: [...] }] }
 */
export function layoutA4({ data, metaLine, cover, blocks, layout = 'classic', scale = 1, measure, imageSize }) {
  const s = scale;
  const CW = A4.width - 2 * MARGIN;
  const pages = [{ ops: [] }];
  let ops = pages[0].ops;
  let y = TOP_FIRST;
  const sizeOf = (id) => imageSize(id) || { w: 4, h: 3 };

  // ---- 第一頁頂部（全寬）：肩題、標題、meta、細線、主圖 ----
  if (data.kicker) {
    const f = font(24 * s, 700);
    ops.push({ op: 'text', x: MARGIN, y: y + 24 * s, text: data.kicker, font: f, color: COLORS.gold });
    y += 24 * s + 18 * s;
  }
  const tf = font(54 * s, 900);
  for (const ln of wrapText(data.title, tf, CW, measure)) {
    ops.push({ op: 'text', x: MARGIN, y: y + 54 * s, text: ln, font: tf, color: COLORS.navy });
    y += 54 * s * 1.35;
  }
  y += 10 * s;
  const mf = font(23 * s);
  for (const ln of wrapText(metaLine, mf, CW, measure)) {
    ops.push({ op: 'text', x: MARGIN, y: y + 23 * s, text: ln, font: mf, color: COLORS.gray });
    y += 23 * s * 1.6;
  }
  y += 14 * s;
  ops.push({ op: 'line', x1: MARGIN, y1: y, x2: MARGIN + CW, y2: y, color: COLORS.line, width: 2 });
  y += 30 * s;
  if (cover) {
    const sz = sizeOf(cover.photoId);
    const h = Math.min((CW * sz.h) / sz.w, 640 * s);
    ops.push({ op: 'image', photoId: cover.photoId, x: MARGIN, y, w: CW, h, fit: 'cover', radius: 8 });
    y += h + 12 * s;
    if (cover.caption) {
      const cf = font(21 * s);
      for (const ln of wrapText(cover.caption, cf, CW, measure)) {
        ops.push({ op: 'text', x: MARGIN + CW / 2, y: y + 21 * s, text: ln, font: cf, color: COLORS.gray, align: 'center' });
        y += 21 * s * 1.5;
      }
    }
    y += 22 * s;
  }

  // ---- 內文：單欄或雙欄 ----
  const ncol = layout === 'columns' ? 2 : 1;
  const gap = 44;
  const colW = ncol === 2 ? (CW - gap) / 2 : CW;
  let col = 0;
  let colTop = y;
  const colX = () => MARGIN + col * (colW + gap);
  const atTop = () => y <= colTop + 0.5;
  function nextSlot() {
    if (col < ncol - 1) {
      col++;
      y = colTop;
      return;
    }
    pages.push({ ops: [] });
    ops = pages[pages.length - 1].ops;
    col = 0;
    colTop = TOP_OTHER;
    y = TOP_OTHER;
  }
  const fits = (h) => y + h <= BOTTOM;

  const bodySize = 27 * s;
  const bodyLH = bodySize * 1.8;
  const bf = font(bodySize);
  let figIndex = 0;

  function textLines(lines, fnt, size, lh, color, align = 'left', indentX = 0) {
    for (const ln of lines) {
      if (!fits(lh)) nextSlot();
      const x = align === 'right' ? colX() + colW : colX() + indentX;
      ops.push({ op: 'text', x, y: y + (lh + size * 0.72) / 2, text: ln, font: fnt, color, align });
      y += lh;
    }
  }

  for (const b of blocks) {
    if (b.type === 'heading') {
      const size = 34 * s;
      const hf = font(size, 900);
      const lines = wrapText(b.text, hf, colW - 22 * s, measure);
      const lh = size * 1.45;
      const top = atTop() ? 0 : 26 * s;
      if (!fits(top + lines.length * lh + 2 * bodyLH)) nextSlot();
      else y += top;
      ops.push({ op: 'rect', x: colX(), y: y + lh * 0.18, w: 7 * s, h: lines.length * lh - lh * 0.36, fill: COLORS.goldLight });
      textLines(lines, hf, size, lh, COLORS.navy, 'left', 22 * s);
      y += 8 * s;
    } else if (b.type === 'para') {
      textLines(wrapText(b.text, bf, colW, measure), bf, bodySize, bodyLH, COLORS.text);
      y += 12 * s;
    } else if (b.type === 'byline') {
      const f = font(25 * s, 700);
      textLines(wrapText(b.text, f, colW, measure), f, 25 * s, 25 * s * 1.7, COLORS.gold, 'right');
      y += 10 * s;
    } else if (b.type === 'figure') {
      const sz = sizeOf(b.photoId);
      const side = layout === 'alternate';
      const maxH = (BOTTOM - TOP_OTHER) * (side ? 0.32 : 0.42) * Math.min(1, s + 0.1);
      let w = (side ? colW * 0.6 : colW) * Math.min(1, s);
      let h = (w * sz.h) / sz.w;
      if (h > maxH) {
        h = maxH;
        w = (h * sz.w) / sz.h;
      }
      const cf = font(21 * s);
      const capW = side ? colW - w - 28 * s : w;
      const capLines = b.caption ? wrapText(b.caption, cf, capW, measure) : [];
      const capH = capLines.length * 21 * s * 1.5;
      const total = side ? Math.max(h, capH) : h + (capH ? capH + 10 * s : 0);
      const pad = 18 * s;
      if (!fits(pad + total + pad) && !atTop()) nextSlot();
      if (!atTop()) y += pad;
      const left = !side || figIndex % 2 === 0;
      const ix = side ? (left ? colX() : colX() + colW - w) : colX() + (colW - w) / 2;
      ops.push({ op: 'image', photoId: b.photoId, x: ix, y, w, h, fit: 'contain', radius: 6 });
      if (side) {
        const cx = left ? colX() + w + 28 * s : colX();
        let cy = y + Math.max(0, (h - capH) / 2);
        for (const ln of capLines) {
          ops.push({ op: 'text', x: cx, y: cy + 21 * s, text: ln, font: cf, color: COLORS.gray });
          cy += 21 * s * 1.5;
        }
      } else {
        let cy = y + h + 10 * s;
        for (const ln of capLines) {
          ops.push({ op: 'text', x: colX() + colW / 2, y: cy + 21 * s, text: ln, font: cf, color: COLORS.gray, align: 'center' });
          cy += 21 * s * 1.5;
        }
      }
      y += total + pad;
      figIndex++;
    } else if (b.type === 'note') {
      const f = font(24 * s, 700);
      const lh = 24 * s * 1.6;
      if (!fits(lh + 30 * s)) nextSlot();
      y += 14 * s;
      ops.push({ op: 'line', x1: colX(), y1: y, x2: colX() + colW, y2: y, color: COLORS.line, width: 2 });
      y += 10 * s;
      textLines(wrapText(b.text, f, colW, measure), f, 24 * s, lh, COLORS.gold, 'left');
    }
  }
  return { pages };
}
