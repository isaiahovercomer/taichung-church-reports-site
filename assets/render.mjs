// 共用排版模組：建置腳本（Node）與協作平台預覽／匯出（瀏覽器）都用這一份，保證預覽＝成品。
// 不直接 import 套件；markdown-it 由呼叫端傳入（Node 用 npm 套件，瀏覽器用 vendor 版）。
//
// 安全原則：所有使用者欄位（標題、作者…）一律經 escapeHtml；
// 內文只經 markdown-it（html:false），圖片只接受安全檔名，連結只接受 https/http/mailto/相對路徑。

import { CATEGORIES, categorySlug, isSafeImageName, isValidDate } from './content.mjs?v=e1f809eb5f';
import { LOGO_DATA_URL } from './brand.mjs?v=e1f809eb5f';

export const SITE_NAME = '台中市召會';
export const SITE_NAME_EN = 'THE CHURCH IN TAICHUNG';
export const SITE_TITLE = '台中市召會行動報導';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const e = escapeHtml;

function dateParts(date) {
  if (!isValidDate(date)) return null;
  const [y, m, d] = String(date).split('-').map(Number);
  return { y, m, d, w: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** 2026-11-04 → 2026/11/4（週三） */
export function formatDate(date) {
  const p = dateParts(date);
  return p ? `${p.y}/${p.m}/${p.d}（週${WEEKDAYS[p.w]}）` : String(date ?? '');
}

/** 2026-11-04 → 2026/11/4 */
export function formatShortDate(date) {
  const p = dateParts(date);
  return p ? `${p.y}/${p.m}/${p.d}` : String(date ?? '');
}

/** 多天的行動：結束日期有效且晚於開始日期才算區間 */
function rangeEnd(start, end) {
  const a = dateParts(start);
  const b = dateParts(end);
  return a && b && String(end) > String(start) ? { a, b } : null;
}

/**
 * 區間：2026-11-04～2026-11-06 → 2026/11/4（週三）～11/6（週五）；跨年才寫年份。
 * 沒有結束日期（或同一天）就跟 formatDate 一樣。
 */
export function formatDateRange(start, end) {
  const r = rangeEnd(start, end);
  if (!r) return formatDate(start);
  const { a, b } = r;
  const tail = a.y === b.y ? `${b.m}/${b.d}` : `${b.y}/${b.m}/${b.d}`;
  return `${formatDate(start)}～${tail}（週${WEEKDAYS[b.w]}）`;
}

/** 區間短格式：2026/11/4–11/6 */
export function formatShortDateRange(start, end) {
  const r = rangeEnd(start, end);
  if (!r) return formatShortDate(start);
  const { a, b } = r;
  return `${formatShortDate(start)}–${a.y === b.y ? `${b.m}/${b.d}` : `${b.y}/${b.m}/${b.d}`}`;
}

export function isHttpsUrl(url) {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url);
}

// ---------- Markdown ----------

/** 建立設定好的 markdown-it 實例。markdownit 為套件匯出的工廠函式。 */
export function createMarkdown(markdownit) {
  const md = markdownit({ html: false, linkify: false, typographer: false, breaks: false });

  // 只允許 https/http/mailto 與相對連結；其他（javascript:、data: 等）一律擋掉
  md.validateLink = (url) => {
    const u = String(url).trim().toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:/.test(u)) return /^(https?:|mailto:)/.test(u);
    return true;
  };

  // 單獨成段的圖片 → figure；# 一級標題降為 h2（頁面只保留一個 h1）
  md.core.ruler.push('tc_figure', (state) => {
    const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      if (t[i].type === 'heading_open' && t[i].tag === 'h1') {
        t[i].tag = 'h2';
        if (t[i + 2] && t[i + 2].type === 'heading_close') t[i + 2].tag = 'h2';
      }
      if (t[i].type !== 'paragraph_open' || !t[i + 1] || t[i + 1].type !== 'inline') continue;
      const kids = (t[i + 1].children || []).filter((c) => !(c.type === 'text' && c.content.trim() === '') && c.type !== 'softbreak');
      if (kids.length === 1 && kids[0].type === 'image') {
        kids[0].meta = { ...(kids[0].meta || {}), figure: true };
        t[i].hidden = true;
        if (t[i + 2] && t[i + 2].type === 'paragraph_close') t[i + 2].hidden = true;
      }
    }
  });

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    let name = token.attrGet('src') || '';
    try {
      name = decodeURIComponent(name);
    } catch {
      /* 保留原字串，交給安全檔名檢查擋掉 */
    }
    const caption = self.renderInlineAsText(token.children || [], options, env).trim();
    const src = isSafeImageName(name) && env && typeof env.resolveImage === 'function' ? env.resolveImage(name) : null;
    let img;
    if (src) {
      img = `<img src="${e(src)}" alt="${e(caption)}" loading="lazy" decoding="async">`;
    } else {
      if (env && Array.isArray(env.missingImages)) env.missingImages.push(name);
      img = `<span class="img-missing">找不到圖片：${e(name)}</span>`;
    }
    if (token.meta && token.meta.figure) {
      return `<figure class="figure">${img}${caption ? `<figcaption>${e(caption)}</figcaption>` : ''}</figure>\n`;
    }
    return img;
  };

  const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:/i.test(href)) {
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      tokens[idx].attrSet('target', '_blank');
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  return md;
}

/** 內文 Markdown → HTML。env.resolveImage(name) 回傳圖片網址或 null；缺圖會記到 env.missingImages。 */
export function renderBody(md, markdown, env = {}) {
  return md.render(String(markdown ?? ''), env);
}

// ---------- 版面元件 ----------

// 台中市召會標誌（深色版，見 src/brand.mjs）；名稱沿用 LOGO_SVG 以免影響既有呼叫端
export const LOGO_SVG = `<img class="logo" src="${LOGO_DATA_URL}" width="40" height="40" alt="">`;

function link(href, text, attrs = '') {
  return href == null ? `<span${attrs}>${text}</span>` : `<a href="${e(href)}"${attrs}>${text}</a>`;
}

/** 站內連結前綴：root 為相對路徑（'../../'）或 https 絕對網址；null 代表不輸出連結。 */
function href(root, path) {
  if (root == null) return null;
  const r = root === '' ? './' : root;
  return path ? r + path : r;
}

export function reportPath(slug) {
  return `reports/${slug}/`;
}
export function categoryPath(name) {
  const s = categorySlug(name);
  return s ? `category/${s}/` : '';
}

export function renderBreadcrumb(items) {
  const parts = items.map((it) => (it.href != null ? `<a href="${e(it.href)}">${e(it.label)}</a>` : `<span>${e(it.label)}</span>`));
  return `<nav class="breadcrumb" aria-label="麵包屑">${parts.join('<span class="sep" aria-hidden="true">›</span>')}</nav>`;
}

/** 報導卡片。opts: { root, imageSrc, headingTag } */
export function renderCard(report, opts = {}) {
  const { data, slug } = report;
  const tag = opts.headingTag || 'h2';
  const img = opts.imageSrc ?? (opts.root != null ? href(opts.root, `${reportPath(slug)}${data.cover}`) : '');
  return (
    `<a class="card" href="${e(href(opts.root ?? '', reportPath(slug)))}">` +
    `<span class="card-img"><img src="${e(img)}" alt="" loading="lazy" decoding="async"></span>` +
    `<span class="card-text">` +
    `<span class="card-cat">${e(data.category)}</span>` +
    `<${tag} class="card-title">${e(data.title)}</${tag}>` +
    `<time class="card-date" datetime="${e(data.date)}">${e(formatShortDateRange(data.date, data.end_date))}</time>` +
    `</span></a>`
  );
}

export function renderShare(url) {
  if (!isHttpsUrl(url)) return '';
  const u = encodeURIComponent(url);
  return (
    `<section class="share" aria-label="分享">` +
    `<h2 class="share-title">分享這篇報導</h2>` +
    `<div class="share-buttons">` +
    `<a class="pill" data-share="line" href="https://social-plugins.line.me/lineit/share?url=${u}" target="_blank" rel="noopener noreferrer">LINE</a>` +
    `<a class="pill" data-share="facebook" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener noreferrer">Facebook</a>` +
    `<button class="pill" type="button" data-copy-url="${e(url)}">複製連結</button>` +
    `</div></section>`
  );
}

/**
 * 單篇報導主體。
 * report: { slug, data, body }
 * opts: { md, root, resolveImage, shareUrl, prev, next, related, missingImages }
 *   root：站內連結前綴（相對路徑或 https 網址；null 不輸出連結）
 */
export function renderArticle(report, opts) {
  const { data, slug } = report;
  const root = opts.root === undefined ? '' : opts.root;
  const resolve = opts.resolveImage || (() => null);
  const env = { resolveImage: resolve, missingImages: opts.missingImages || [] };
  const catHref = href(root, categoryPath(data.category));

  const meta = [
    ['日期', `<time datetime="${e(data.date)}">${e(formatDateRange(data.date, data.end_date))}</time>`],
    ['作者', e(data.author)],
    ['分類', link(catHref, e(data.category))],
  ];
  if (data.hall) meta.push(['會所', e(data.hall)]);
  if (data.place) meta.push(['地點', e(data.place)]);

  let cover = '';
  if (data.cover) {
    const src = isSafeImageName(data.cover) ? resolve(data.cover) : null;
    if (!src) env.missingImages.push(data.cover);
    cover =
      `<figure class="figure cover">` +
      (src ? `<img src="${e(src)}" alt="${e(data.cover_caption || data.title)}" decoding="async">` : `<span class="img-missing">找不到主圖：${e(data.cover)}</span>`) +
      (data.cover_caption ? `<figcaption>${e(data.cover_caption)}</figcaption>` : '') +
      `</figure>`;
  }

  let prevNext = '';
  if (opts.prev || opts.next) {
    const cell = (r, label, cls) =>
      r
        ? `<a class="pn ${cls}" href="${e(href(root, reportPath(r.slug)))}"><span class="pn-label">${label}</span><span class="pn-title">${e(r.data.title)}</span></a>`
        : `<span class="pn pn-empty ${cls}"></span>`;
    prevNext = `<nav class="prevnext" aria-label="上一篇／下一篇">${cell(opts.prev, '← 上一篇', 'pn-prev')}${cell(opts.next, '下一篇 →', 'pn-next')}</nav>`;
  }

  let related = '';
  if (opts.related && opts.related.length) {
    related =
      `<section class="related" aria-labelledby="related-title">` +
      `<div class="section-head"><h2 id="related-title" class="section-title">相關報導</h2>` +
      `<a class="more" href="${e(catHref)}">更多${e(data.category)}報導 →</a></div>` +
      `<div class="card-grid">${opts.related.map((r) => renderCard(r, { root, headingTag: 'h3' })).join('')}</div>` +
      `</section>`;
  }

  return (
    `<article class="article">` +
    renderBreadcrumb([
      { label: '首頁', href: href(root, '') },
      { label: '報導', href: href(root, '') },
      { label: data.category, href: catHref },
    ]) +
    (data.kicker ? `<p class="kicker">${e(data.kicker)}</p>` : '') +
    `<h1 class="article-title">${e(data.title)}</h1>` +
    `<dl class="meta">${meta.map(([k, v]) => `<div class="meta-item"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
    `<hr class="hairline">` +
    cover +
    `<div class="article-body">${renderBody(opts.md, report.body, env)}</div>` +
    renderShare(opts.shareUrl) +
    prevNext +
    `</article>` +
    related
  );
}

function renderHeader(root, current) {
  const nav = root == null
    ? ''
    : `<a href="${e(href(root, ''))}"${current === 'reports' ? ' aria-current="page"' : ''}>報導</a>` +
      `<a href="${e(href(root, 'app/'))}"${current === 'app' ? ' aria-current="page"' : ''}>協作平台</a>`;
  const brand =
    `${LOGO_SVG}<span class="brand-text"><strong>${SITE_NAME}</strong><small>${SITE_NAME_EN}</small></span>`;
  return (
    `<header class="site-header"><div class="header-inner">` +
    (root == null ? `<span class="brand">${brand}</span>` : `<a class="brand" href="${e(href(root, ''))}">${brand}</a>`) +
    (nav
      ? `<nav class="main-nav" aria-label="主選單">${nav}</nav>` +
        `<details class="menu"><summary aria-label="開啟選單"><span class="burger" aria-hidden="true"></span></summary><nav class="menu-panel" aria-label="行動版選單">${nav}</nav></details>`
      : '') +
    `</div></header>`
  );
}

function renderFooter() {
  return (
    `<footer class="site-footer"><div class="footer-inner">` +
    `<p class="footer-brand">${SITE_NAME}　${SITE_NAME_EN}</p>` +
    `<p>本站報導由各會所弟兄姊妹投稿協作</p>` +
    `</div></footer>`
  );
}

export const SITE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'";
export const STANDALONE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * 完整 HTML 頁面。
 * opts: { title, description, root, current, content, bodyClass, og, canonical, css (內嵌時), csp, scripts }
 */
export function renderPage(opts) {
  const root = opts.root === undefined ? '' : opts.root;
  const assetRoot = opts.assetRoot ?? root ?? '';
  const og = opts.og || {};
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="${e(opts.csp || SITE_CSP)}">`,
    `<meta name="referrer" content="strict-origin-when-cross-origin">`,
    // 協作平台：先告訴瀏覽器所有要用的模組，一次平行下載（不必等 import 一層層發現）
    ...(opts.modulePreload || []).map((s) => `<link rel="modulepreload" href="${e(s)}">`),
    `<title>${e(opts.title)}</title>`,
    opts.description ? `<meta name="description" content="${e(opts.description)}">` : '',
    isHttpsUrl(opts.canonical) ? `<link rel="canonical" href="${e(opts.canonical)}">` : '',
    `<meta property="og:site_name" content="${e(SITE_TITLE)}">`,
    `<meta property="og:locale" content="zh_TW">`,
    `<meta property="og:type" content="${e(og.type || 'website')}">`,
    `<meta property="og:title" content="${e(og.title || opts.title)}">`,
    opts.description ? `<meta property="og:description" content="${e(opts.description)}">` : '',
    isHttpsUrl(og.url) ? `<meta property="og:url" content="${e(og.url)}">` : '',
    isHttpsUrl(og.image) ? `<meta property="og:image" content="${e(og.image)}">` : '',
    og.publishedTime ? `<meta property="article:published_time" content="${e(og.publishedTime)}">` : '',
    `<meta name="twitter:card" content="${isHttpsUrl(og.image) ? 'summary_large_image' : 'summary'}">`,
    opts.css != null
      ? `<style>${String(opts.css).replace(/<\/style/gi, '<\\/style')}</style>`
      : `<link rel="stylesheet" href="${e(assetRoot === '' ? './' : assetRoot)}assets/styles.css">`,
    ...(opts.css != null
      ? [`<link rel="icon" type="image/png" href="${LOGO_DATA_URL}">`]
      : [
          `<link rel="icon" href="${e(assetRoot === '' ? './' : assetRoot)}favicon.ico" sizes="any">`,
          `<link rel="icon" type="image/png" sizes="32x32" href="${e(assetRoot === '' ? './' : assetRoot)}assets/brand/logo-32.png">`,
          `<link rel="apple-touch-icon" href="${e(assetRoot === '' ? './' : assetRoot)}assets/brand/apple-touch-icon.png">`,
          `<link rel="manifest" href="${e(assetRoot === '' ? './' : assetRoot)}manifest.webmanifest">`,
          `<meta name="theme-color" content="#16324F">`,
        ]),
  ]
    .filter(Boolean)
    .join('\n');
  // classicScripts：一般 <script defer>（UMD 套件、apps-script/core.js 需要全域變數）；會依序在 module 之前執行
  const scripts = (opts.classicScripts || [])
    .map((s) => `<script defer src="${e(s)}"></script>`)
    .concat((opts.scripts || []).map((s) => `<script type="module" src="${e(s)}"></script>`))
    .join('\n');
  return (
    `<!doctype html>\n<html lang="zh-Hant">\n<head>\n${head}\n</head>\n` +
    `<body class="${e(opts.bodyClass || '')}">\n` +
    renderHeader(root, opts.current) +
    `\n<main class="container" id="main">\n${opts.content}\n</main>\n` +
    renderFooter() +
    (scripts ? `\n${scripts}` : '') +
    `\n</body>\n</html>\n`
  );
}

/**
 * 單一 HTML 檔（CSS 內嵌、圖片以 data: 內嵌），協作平台預覽與匯出共用。
 * opts: { md, css, images: Map/物件 name→dataURL, siteUrl, layout: 'classic'|'alternate'|'columns' }
 */
export function renderStandalone(report, opts) {
  const images = opts.images || {};
  const get = (n) => (images instanceof Map ? images.get(n) : images[n]) || null;
  const siteUrl = isHttpsUrl(opts.siteUrl) ? opts.siteUrl.replace(/\/?$/, '/') : null;
  const shareUrl = siteUrl && report.slug ? `${siteUrl}${reportPath(report.slug)}` : null;
  const content = renderArticle(report, {
    md: opts.md,
    root: siteUrl,
    resolveImage: (n) => {
      const v = get(n);
      return typeof v === 'string' && /^data:image\/(jpeg|png|gif|webp|svg\+xml);base64,/.test(v) ? v : null;
    },
    shareUrl,
    missingImages: opts.missingImages,
  });
  return renderPage({
    title: `${report.data.title || '（未命名報導）'}｜${SITE_TITLE}`,
    description: report.data.summary,
    root: null,
    content,
    css: opts.css ?? '',
    csp: STANDALONE_CSP,
    bodyClass: `page-article standalone${/^(classic|alternate|columns)$/.test(opts.layout || '') ? ` layout-${opts.layout}` : ''}`,
    og: { type: 'article', title: report.data.title },
  });
}

export { CATEGORIES };
