// 報導組版：從素材挑照片／影片、呼叫節錄器，產生與輸出格式無關的「區塊」，
// 再轉成 Markdown（給 render.mjs 生網頁）或交給 A4 排版（a4-layout.mjs）。
// 純函式，不碰 DOM，Node 單元測試可直接 import。

import { countChars } from './summarizer.mjs?v=d8bd729ee7';

/** 單一素材的照片順序：主圖 → 有圖說 → 其他（同級維持原順序） */
export function orderPhotos(photos = []) {
  return photos
    .map((p, i) => ({ p, i, rank: p.cover ? 0 : p.caption && p.caption.trim() ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.p);
}

/** 所有素材中被當成影片封面的照片 id */
export function videoCoverIds(materials) {
  const ids = new Set();
  for (const m of materials) for (const v of m.videos || []) if (v.coverPhotoId) ids.add(v.coverPhotoId);
  return ids;
}

/**
 * 挑照片：先選主圖（第一個標了主圖的素材；沒有就用第一張照片），
 * 其餘在各素材之間輪流平均分配，每個素材內有圖說的優先。max 含主圖。
 * 影片封面不算照片，一律排除。
 * 回傳 [{ photoId, materialId, caption, isMain }]
 */
export function pickPhotos(materials, max) {
  const covers = videoCoverIds(materials);
  const lists = materials.map((m) => ({ id: m.id, list: orderPhotos((m.photos || []).filter((p) => !covers.has(p.id))) }));
  const out = [];
  if (!(max > 0)) return out;
  const mainSrc = lists.find((l) => l.list.length && l.list[0].cover) || lists.find((l) => l.list.length);
  if (!mainSrc) return out;
  const main = mainSrc.list.shift();
  out.push({ photoId: main.id, materialId: mainSrc.id, caption: main.caption || '', isMain: true });
  // 主圖來源素材已經「用掉一張」，輪流從下一個素材開始
  let start = (lists.indexOf(mainSrc) + 1) % lists.length;
  while (out.length < max && lists.some((l) => l.list.length)) {
    for (let k = 0; k < lists.length && out.length < max; k++) {
      const l = lists[(start + k) % lists.length];
      const p = l.list.shift();
      if (p) out.push({ photoId: p.id, materialId: l.id, caption: p.caption || '', isMain: false });
    }
    start = 0;
  }
  return out;
}

/** 挑影片：各素材輪流 */
export function pickVideos(materials, max) {
  const lists = materials.map((m) => ({ id: m.id, list: [...(m.videos || [])] }));
  const out = [];
  while (out.length < max && lists.some((l) => l.list.length)) {
    for (const l of lists) {
      if (out.length >= max) break;
      const v = l.list.shift();
      if (v) out.push({ ...v, materialId: l.id });
    }
  }
  return out;
}

/** Markdown 跳脫：使用者文字一律當純文字 */
export function mdEscape(s) {
  return String(s ?? '').replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, (c) => `\\${c}`);
}

function safeHttpsUrl(url) {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>\\]+$/.test(url) ? url.replace(/\(/g, '%28').replace(/\)/g, '%29') : null;
}

/**
 * 產生報導。
 * input: { action, materials, settings:{words,maxPhotos,maxVideos,layout,pages}, summarizer, words?(覆寫), note?, print? }
 *   print: true 時為 A4／PDF 用——完全不放影片（不產生 video 區塊、不用影片封面），只有文字和照片
 * 回傳 {
 *   data,          // 給 render.mjs 的前置資料（title/kicker/date/author/category/place/cover/cover_caption/summary）
 *   cover,         // { photoId, imageName, caption } | null
 *   blocks,        // [{type:'heading'|'para'|'figure'|'byline'|'video'|'note', ...}]
 *   images,        // [{ name, photoId }]（Markdown 中用到的圖片檔名 → 照片 id）
 *   stats          // { chars, target, photos, maxPhotos, videos, maxVideos }
 * }
 */
export async function composeReport({ action, materials, settings, summarizer, words, note, print = false }) {
  const target = words ?? settings.words;
  const summary = await summarizer.summarize({ materials, targetChars: target });
  const photos = pickPhotos(materials, settings.maxPhotos);
  const videos = print ? [] : pickVideos(materials, settings.maxVideos);

  const images = [];
  const imageName = (photoId) => {
    let it = images.find((x) => x.photoId === photoId);
    if (!it) {
      it = { name: `photo-${images.length + 1}.jpg`, photoId };
      images.push(it);
    }
    return it.name;
  };

  const main = photos.find((p) => p.isMain) || null;
  const cover = main ? { photoId: main.photoId, imageName: imageName(main.photoId), caption: main.caption } : null;

  const blocks = [];
  materials.forEach((m, idx) => {
    const sec = summary.sections[idx] || { paragraphs: [] };
    const myPhotos = photos.filter((p) => !p.isMain && p.materialId === m.id);
    const myVideos = videos.filter((v) => v.materialId === m.id);
    if (!sec.paragraphs.length && !myPhotos.length && !myVideos.length) return;
    blocks.push({ type: 'heading', text: m.title, kind: m.kind, materialId: m.id });
    // 照片穿插在段落之間：第 1 段後、第 2 段後…，剩下的放在最後
    const queue = [...myPhotos];
    sec.paragraphs.forEach((p) => {
      blocks.push({ type: 'para', text: p, materialId: m.id });
      const ph = queue.shift();
      if (ph) blocks.push({ type: 'figure', photoId: ph.photoId, imageName: imageName(ph.photoId), caption: ph.caption, materialId: m.id });
    });
    for (const ph of queue) blocks.push({ type: 'figure', photoId: ph.photoId, imageName: imageName(ph.photoId), caption: ph.caption, materialId: m.id });
    if (m.kind === 'testimony' && m.author) blocks.push({ type: 'byline', text: `—— ${m.author}`, materialId: m.id });
    for (const v of myVideos) {
      const url = safeHttpsUrl(v.url);
      if (!url) continue;
      blocks.push({
        type: 'video',
        title: v.title || '活動影片',
        url,
        coverPhotoId: v.coverPhotoId || null,
        imageName: v.coverPhotoId ? imageName(v.coverPhotoId) : null,
        materialId: m.id,
      });
    }
  });
  if (note) blocks.push({ type: 'note', text: note });

  const authors = [...new Set(materials.map((m) => (m.author || '').trim()).filter(Boolean))];
  const data = {
    title: action.name,
    kicker: action.place ? `${action.place}・行動報導` : '行動報導',
    date: action.date,
    author: authors.length ? authors.join('、') : '行動報導小組',
    category: '行動報導',
    place: action.place || '',
    summary: (action.description || '').slice(0, 150),
    cover: cover ? cover.imageName : '',
    cover_caption: cover ? cover.caption : '',
  };
  const usedPhotoCount = new Set(blocks.filter((b) => b.type === 'figure').map((b) => b.photoId)).size + (cover ? 1 : 0);
  const chars = blocks.filter((b) => b.type === 'para').reduce((a, b) => a + countChars(b.text), 0);
  return {
    data,
    cover,
    blocks,
    images,
    stats: {
      chars,
      target,
      photos: usedPhotoCount,
      maxPhotos: settings.maxPhotos,
      videos: blocks.filter((b) => b.type === 'video').length,
      maxVideos: print ? 0 : settings.maxVideos,
    },
  };
}

/** 區塊 → Markdown（render.mjs 的 renderBody 會把單獨成段的圖片轉成 figure） */
export function blocksToMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'heading') out.push(`## ${mdEscape(b.text)}`);
    else if (b.type === 'para') out.push(mdEscape(b.text));
    else if (b.type === 'figure') out.push(`![${mdEscape(b.caption)}](${b.imageName})`);
    else if (b.type === 'byline') out.push(`*${mdEscape(b.text)}*`);
    else if (b.type === 'video') {
      if (b.imageName) out.push(`![${mdEscape(`影片：${b.title}`)}](${b.imageName})`);
      out.push(`[▶ 觀看影片：${mdEscape(b.title)}](${b.url})`);
    } else if (b.type === 'note') out.push(`> ${mdEscape(b.text)}`);
  }
  return out.join('\n\n') + '\n';
}
