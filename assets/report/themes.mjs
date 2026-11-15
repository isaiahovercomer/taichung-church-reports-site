// src/report/themes.mjs
// 教會活動報導網站：視覺範本（與版面配置獨立，可自由搭配）
// 風格：淡雅、樸素、穩重，適合教會刊物與印刷。
// 規則：不用鮮豔、霓虹、漸層花俏、卡通風；不用任何十字架圖示或十字形裝飾。
// 中文字型只用 'Noto Sans TC' 或 'Noto Serif TC'。
// 色票鍵：navy 主色（頁首、標題、標籤底）、gold 強調色（小標、強調線）、
// goldLight 細線裝飾、text 內文、gray 次要文字與圖說、line 分隔線、
// bg 頁面底色、paper 淡底區塊；另加 headerText（頁首白字）、accentSoft（淡色強調底）。


export const THEMES = [
  {
    id: 'classic-navy',
    name: '經典墨藍',
    desc: '墨藍頁首配淡金細線，莊重經典，適合正式刊物與週年報導。',
    pattern: 'doubleRule',
    titleFont: 'Noto Serif TC',
    titleWeight: 700,
    colors: {
      navy: '#16324F', gold: '#836427', goldLight: '#C9A865',
      text: '#1F2D3D', gray: '#5A6A7A', line: '#E4E3DE',
      bg: '#FFFFFF', paper: '#F5F5F2',
      headerText: '#FFFFFF', accentSoft: '#EDE8DC',
    },
  },
  {
    id: 'rice-paper',
    name: '米白紙感',
    desc: '米白紙底配暖褐墨色，像宣紙刊物，溫潤安靜，長文閱讀最舒服。',
    pattern: 'paper',
    titleFont: 'Noto Serif TC',
    titleWeight: 700,
    colors: {
      navy: '#33302A', gold: '#7A5E2E', goldLight: '#C9B48A',
      text: '#26241F', gray: '#5B574E', line: '#E8E2D5',
      bg: '#FFFEF9', paper: '#F6F1E6',
      headerText: '#FFFFFF', accentSoft: '#F1EAD8',
    },
  },
  {
    id: 'sage-gray',
    name: '灰綠靜謐',
    desc: '深灰綠配苔綠點陣，沉靜有生氣，適合戶外、親子與社區活動。',
    pattern: 'dots',
    titleFont: 'Noto Serif TC',
    titleWeight: 600,
    colors: {
      navy: '#2F4A3E', gold: '#5F7052', goldLight: '#A8B89A',
      text: '#22302A', gray: '#55665C', line: '#DDE3DA',
      bg: '#FFFFFF', paper: '#F2F5F0',
      headerText: '#FFFFFF', accentSoft: '#E6EDE3',
    },
  },
  {
    id: 'warm-gray',
    name: '暖灰素雅',
    desc: '暖灰主色配細外框，極簡穩重，什麼內容放進來都不搶戲。',
    pattern: 'frame',
    titleFont: 'Noto Sans TC',
    titleWeight: 700,
    colors: {
      navy: '#3A3A3C', gold: '#7A5E33', goldLight: '#C2A87E',
      text: '#262628', gray: '#5E5E62', line: '#E3E1DD',
      bg: '#FFFFFF', paper: '#F4F3F1',
      headerText: '#FFFFFF', accentSoft: '#ECE9E4',
    },
  },
  {
    id: 'pale-gold',
    name: '淡金細線',
    desc: '淡金角花與細線，帶一點節慶感，仍保持素雅，適合感恩與節期報導。',
    pattern: 'corner',
    titleFont: 'Noto Serif TC',
    titleWeight: 700,
    colors: {
      navy: '#3D3226', gold: '#7A5F22', goldLight: '#D4B978',
      text: '#2B251D', gray: '#655E52', line: '#EAE0C8',
      bg: '#FFFDF7', paper: '#FAF3E3',
      headerText: '#FFFFFF', accentSoft: '#F7EED6',
    },
  },
  {
    id: 'newsprint',
    name: '黑白報紙',
    desc: '黑白灰三色、淡格線，像老報紙的通訊版，資訊清楚、印刷最省墨。',
    pattern: 'grid',
    titleFont: 'Noto Serif TC',
    titleWeight: 700,
    colors: {
      navy: '#111111', gold: '#333333', goldLight: '#8A8A8A',
      text: '#1A1A1A', gray: '#555555', line: '#D9D9D9',
      bg: '#FFFFFF', paper: '#F5F5F5',
      headerText: '#FFFFFF', accentSoft: '#EDEDED',
    },
  },
  {
    id: 'pale-blue',
    name: '淡藍水彩',
    desc: '淡藍紙紋配霧藍主色，清爽安靜，適合青年、詩歌與水邊活動。',
    pattern: 'paper',
    titleFont: 'Noto Sans TC',
    titleWeight: 600,
    colors: {
      navy: '#24425E', gold: '#4A7396', goldLight: '#A9C2D6',
      text: '#1E2F3F', gray: '#546978', line: '#DDE8F0',
      bg: '#FFFFFF', paper: '#EEF4F8',
      headerText: '#FFFFFF', accentSoft: '#E2EDF5',
    },
  },
  {
    id: 'plum-ink',
    name: '梅紫墨韻',
    desc: '深梅紫配細外框，沉穩中帶暖意，適合追念、見證與文字較多的報導。',
    pattern: 'frame',
    titleFont: 'Noto Serif TC',
    titleWeight: 600,
    colors: {
      navy: '#402E3D', gold: '#7A4A5E', goldLight: '#C19AA8',
      text: '#2E222B', gray: '#61545E', line: '#E6DEE2',
      bg: '#FFFFFF', paper: '#F7F2F4',
      headerText: '#FFFFFF', accentSoft: '#EFE6E9',
    },
  },
  {
    id: 'olive-moss',
    name: '苔綠古樸',
    desc: '橄欖綠配淡橫紋，古樸耐看，適合歷史、郊遊與長時間保存的刊物。',
    pattern: 'lines',
    titleFont: 'Noto Serif TC',
    titleWeight: 700,
    colors: {
      navy: '#333A24', gold: '#6D6A2F', goldLight: '#B8B48A',
      text: '#272B1E', gray: '#5A5F4C', line: '#E2E3D6',
      bg: '#FFFFFF', paper: '#F4F5EC',
      headerText: '#FFFFFF', accentSoft: '#EDEEDD',
    },
  },
  {
    id: 'brick-clay',
    name: '陶土暖褐',
    desc: '陶土褐配淡金角花，暖而不豔，適合秋冬、家庭與手工活動報導。',
    pattern: 'corner',
    titleFont: 'Noto Sans TC',
    titleWeight: 700,
    colors: {
      navy: '#4A2E28', gold: '#8A4A33', goldLight: '#C99A7E',
      text: '#2E211D', gray: '#6A5A52', line: '#EADDD5',
      bg: '#FFFFFF', paper: '#F9F1EC',
      headerText: '#FFFFFF', accentSoft: '#F3E6DE',
    },
  },
  {
    id: 'slate-mist',
    name: '青灰霧嵐',
    desc: '青灰藍配淡點陣，冷靜克制，適合研討、訓練與紀實類報導。',
    pattern: 'dots',
    titleFont: 'Noto Sans TC',
    titleWeight: 700,
    colors: {
      navy: '#2F3E4D', gold: '#4E6578', goldLight: '#A3B8C6',
      text: '#222E38', gray: '#556671', line: '#DEE6EA',
      bg: '#FFFFFF', paper: '#F1F5F7',
      headerText: '#FFFFFF', accentSoft: '#E4EBEF',
    },
  },
  {
    id: 'ink-wash',
    name: '水墨留白',
    desc: '近黑墨色、大面積留白、無花樣，最安靜的一個，適合詩文與默想。',
    pattern: 'none',
    titleFont: 'Noto Serif TC',
    titleWeight: 700,
    colors: {
      navy: '#232323', gold: '#5A5A5A', goldLight: '#A8A8A8',
      text: '#202020', gray: '#595959', line: '#E0E0E0',
      bg: '#FDFDFC', paper: '#F5F5F3',
      headerText: '#FFFFFF', accentSoft: '#EDEDED',
    },
  },
];


export const THEME_IDS = THEMES.map((t) => t.id);
export const DEFAULT_THEME_ID = THEMES[0].id;

export function getTheme(id) {
  if (typeof id !== 'string' || !id.trim()) return THEMES[0];
  const found = THEMES.find((t) => t.id === id.trim().toLowerCase());
  return found || THEMES[0];
}

export function isThemeId(id) {
  return THEME_IDS.includes(String(id || '').trim().toLowerCase());
}


// 在 canvas 上畫背景花樣。page = { width, height, index }，index 為頁碼（0 起算）。
// 只畫非常淡的裝飾，絕不蓋住文字；列印時也好看。
// 呼叫時機：在 renderA4 每頁先填底色，再呼叫 drawPattern，最後才畫文字、照片與分隔線。
export function drawPattern(ctx, theme, page) {
  if (!ctx || !theme || !theme.colors) return;
  const width = page && page.width ? page.width : 1240;
  const height = page && page.height ? page.height : 1754;
  const index = page && typeof page.index === 'number' ? page.index : 0;
  const c = theme.colors;
  const pattern = theme.pattern || 'none';
  if (pattern === 'none') return;


  ctx.save();
  try {
    if (pattern === 'frame') {
      ctx.strokeStyle = c.goldLight;
      ctx.lineWidth = 2;
      ctx.strokeRect(28, 28, width - 56, height - 56);
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(36, 36, width - 72, height - 72);
    } else if (pattern === 'doubleRule') {
      ctx.strokeStyle = c.gold;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(56, 46); ctx.lineTo(width - 56, 46);
      ctx.moveTo(56, height - 46); ctx.lineTo(width - 56, height - 46);
      ctx.stroke();
      ctx.strokeStyle = c.goldLight;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(56, 52); ctx.lineTo(width - 56, 52);
      ctx.moveTo(56, height - 52); ctx.lineTo(width - 56, height - 52);
      ctx.stroke();
    } else if (pattern === 'corner') {
      // 四角各一個 L 形角花（直線 + 直線，簡單幾何，不含十字）。
      ctx.strokeStyle = c.gold;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'square';
      const m = 34;
      const len = 56;
      const corners = [
        [m, m, 1, 1],
        [width - m, m, -1, 1],
        [m, height - m, 1, -1],
        [width - m, height - m, -1, -1],
      ];
      for (const [x, y, dx, dy] of corners) {
        ctx.beginPath();
        ctx.moveTo(x + dx * len, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * len);
        ctx.stroke();
      }
      ctx.strokeStyle = c.goldLight;
      ctx.lineWidth = 1;
      const m2 = 42;
      const len2 = 36;
      const corners2 = [
        [m2, m2, 1, 1],
        [width - m2, m2, -1, 1],
        [m2, height - m2, 1, -1],
        [width - m2, height - m2, -1, -1],
      ];
      for (const [x, y, dx, dy] of corners2) {
        ctx.beginPath();
        ctx.moveTo(x + dx * len2, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * len2);
        ctx.stroke();
      }
    } else if (pattern === 'dots') {
      ctx.fillStyle = c.goldLight;
      ctx.globalAlpha = 0.35;
      const step = 46;
      for (let y = step; y < height - 20; y += step) {
        for (let x = step; x < width - 20; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    } else if (pattern === 'lines') {
      ctx.strokeStyle = c.line;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      for (let y = 72; y < height - 40; y += 42) {
        ctx.beginPath();
        ctx.moveTo(56, y);
        ctx.lineTo(width - 56, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (pattern === 'paper') {
      // 紙紋：用頁碼作種子的固定亂數撒點，每頁花紋相同位置、印出來不花。
      let seed = (index + 1) * 2654435761;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      ctx.fillStyle = c.goldLight;
      for (let i = 0; i < 700; i += 1) {
        ctx.globalAlpha = 0.04 + rnd() * 0.04;
        ctx.beginPath();
        ctx.arc(rnd() * width, rnd() * height, 0.6 + rnd() * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.05;
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      for (let y = 96; y < height; y += 96) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (pattern === 'grid') {
      ctx.strokeStyle = c.line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      for (let x = 72; x < width; x += 72) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 72; y < height; y += 72) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  } finally {
    ctx.restore();
  }
}


function patternCss(theme) {
  const pattern = theme.pattern || 'none';
  if (pattern === 'frame') {
    return [
      'border: 1px solid var(--c-gold-light);',
      'outline: 1px solid var(--c-line);',
      'outline-offset: 6px;',
      'background-image: none;',
    ].join('\n  ');
  }
  if (pattern === 'doubleRule') {
    return [
      'background-image:',
      '  linear-gradient(var(--c-gold), var(--c-gold)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold), var(--c-gold));',
      'background-size: 100% 2px, 100% 1px, 100% 1px, 100% 2px;',
      'background-position: left top, left top 6px, left bottom 6px, left bottom;',
      'background-repeat: no-repeat;',
    ].join('\n  ');
  }
  if (pattern === 'corner') {
    return [
      'background-image:',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light)),',
      '  linear-gradient(var(--c-gold-light), var(--c-gold-light));',
      'background-size: 56px 2px, 2px 56px, 56px 2px, 2px 56px, 56px 2px, 2px 56px, 56px 2px, 2px 56px;',
      'background-position: left 24px top 24px, left 24px top 24px, right 24px top 24px, right 24px top 24px, left 24px bottom 24px, left 24px bottom 24px, right 24px bottom 24px, right 24px bottom 24px;',
      'background-repeat: no-repeat;',
    ].join('\n  ');
  }
  if (pattern === 'dots') {
    return [
      'background-image: radial-gradient(var(--c-line) 1px, transparent 1.4px);',
      'background-size: 28px 28px;',
      'background-repeat: repeat;',
    ].join('\n  ');
  }
  if (pattern === 'lines') {
    return [
      'background-image: repeating-linear-gradient(0deg, transparent 0 35px, var(--c-line) 35px 36px);',
      'background-size: auto;',
      'background-repeat: repeat;',
    ].join('\n  ');
  }
  if (pattern === 'paper') {
    return [
      'background-image:',
      '  repeating-linear-gradient(0deg, transparent 0 3px, var(--c-paper) 3px 4px),',
      '  repeating-linear-gradient(90deg, transparent 0 120px, var(--c-paper) 120px 121px);',
      'background-size: auto;',
      'background-repeat: repeat;',
    ].join('\n  ');
  }
  if (pattern === 'grid') {
    return [
      'background-image:',
      '  linear-gradient(var(--c-line) 1px, transparent 1px),',
      '  linear-gradient(90deg, var(--c-line) 1px, transparent 1px);',
      'background-size: 48px 48px;',
      'background-repeat: repeat;',
    ].join('\n  ');
  }
  return 'background-image: none;';
}


// 回傳網頁報導用的 CSS 字串。純 CSS，不用外部圖片。
// 用法：把回傳字串放進 <style>，報導根元素加 class="report-theme"。
export function themeCss(theme) {
  const t = theme || THEMES[0];
  const c = t.colors;
  const titleFont = t.titleFont || 'Noto Serif TC';
  const titleWeight = t.titleWeight || 700;
  return `
.report-theme {
  --c-navy: ${c.navy};
  --c-gold: ${c.gold};
  --c-gold-light: ${c.goldLight};
  --c-text: ${c.text};
  --c-gray: ${c.gray};
  --c-line: ${c.line};
  --c-bg: ${c.bg};
  --c-paper: ${c.paper};
  --c-header-text: ${c.headerText};
  --c-accent-soft: ${c.accentSoft};
  color: var(--c-text);
  background-color: var(--c-bg);
  font-family: 'Noto Sans TC', sans-serif;
  ${patternCss(t)}
}
.report-theme .report-header {
  background: var(--c-navy);
  color: var(--c-header-text);
}
.report-theme .report-title,
.report-theme h1 {
  font-family: '${titleFont}', 'Noto Sans TC', sans-serif;
  font-weight: ${titleWeight};
  color: var(--c-navy);
}
.report-theme .report-header .report-title,
.report-theme .report-header h1 {
  color: var(--c-header-text);
}
.report-theme h2,
.report-theme .report-section-title {
  font-family: '${titleFont}', 'Noto Sans TC', sans-serif;
  font-weight: ${titleWeight};
  color: var(--c-navy);
  border-bottom: 2px solid var(--c-gold);
}
.report-theme .report-kicker,
.report-theme .report-tag {
  background: var(--c-navy);
  color: var(--c-header-text);
}
.report-theme .report-sub {
  color: var(--c-gray);
}
.report-theme figcaption,
.report-theme .report-caption {
  color: var(--c-gray);
}
.report-theme .report-paper {
  background: var(--c-paper);
  border: 1px solid var(--c-line);
}
.report-theme .report-accent {
  background: var(--c-accent-soft);
  border-left: 3px solid var(--c-gold);
}
.report-theme hr,
.report-theme .report-rule {
  border: 0;
  border-top: 1px solid var(--c-line);
}
.report-theme .report-gold-rule {
  border: 0;
  border-top: 2px solid var(--c-gold);
}
.report-theme a {
  color: var(--c-navy);
}
.report-theme .site-header {
  background: var(--c-navy);
  color: var(--c-header-text);
}
.report-theme .article-title {
  font-family: '${titleFont}', 'Noto Sans TC', sans-serif;
  font-weight: ${titleWeight};
  color: var(--c-navy);
}
.report-theme .kicker {
  color: var(--c-gold);
}
.report-theme .meta,
.report-theme .meta-item dd,
.report-theme .meta-item dt {
  color: var(--c-gray);
}
.report-theme .hairline {
  border-color: var(--c-line);
}
.report-theme .article-body {
  color: var(--c-text);
}
.report-theme .article-body h2,
.report-theme .article-body h3 {
  font-family: '${titleFont}', 'Noto Sans TC', sans-serif;
  color: var(--c-navy);
}
.report-theme .site-footer {
  color: var(--c-gray);
  border-top-color: var(--c-line);
}
@media print {
  .report-theme {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`.trim();
}

/** 設計範本縮圖的內聯樣式：色塊加頁首條，花樣用 data-pattern 搭配 CSS。 */
export function themeThumbStyle(theme) {
  const t = theme && theme.colors ? theme : getTheme(theme);
  const c = t.colors;
  return [
    `--c-navy:${c.navy}`,
    `--c-gold:${c.gold}`,
    `--c-gold-light:${c.goldLight}`,
    `--c-text:${c.text}`,
    `--c-line:${c.line}`,
    `--c-bg:${c.bg}`,
    `--c-paper:${c.paper}`,
    `background-color:${c.bg}`,
  ].join(';');
}
