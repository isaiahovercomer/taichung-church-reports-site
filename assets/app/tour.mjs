// 使用教學（導覽）：第一次登入先詢問要不要看；背景變暗、逐步標出介面；上一步／下一步／跳過；
// 依角色顯示步驟（共同協作者／負責人）；可從上方「使用教學」重看。導覽不會建立或修改資料。
// v2：任何人登入後都能建立自己的行動並成為負責人；負責人在「協作者」頁籤增減共同協作者。
// v4：行動的單位／區域（建立時設定、素材選單位、生成時依單位勾選與自訂 A4 每頁單位）。
// v5：縮短步驟、先詢問再播放、最後一步按「完成」，不再自動建立示範資料。
// 做法參考聖經 App 的 tour.js（聚光燈 + 說明泡泡），程式為本專案自寫。
//
// ★ 以後新增功能時：在 STEPS 加步驟，並把該步驟的 since 設成新的版本號、TOUR_VERSION 加 1。
//   看過舊版教學的人下次登入會收到「教學有新步驟」提示，只播放新步驟。

export const TOUR_VERSION = 5;
export const TOUR_KEY = 'rpt.tour';

// track：'all' 所有人、'collab' 只給共同協作者、'manager' 負責人（含總管理者）
// view：'home' | 'new' | 'materials' | 'generate' | 'members' | 'settings'（行動頁籤）
export const STEPS = [
  { id: 'welcome', track: 'all', view: 'home', since: 1, target: '[data-testid="mode-badge"]', title: '歡迎使用行動報導協作平台', text: '這裡可以建立行動、收集素材，再生成網頁報導與 A4 圖檔。' },
  { id: 'login', track: 'all', view: 'home', since: 1, target: '.app-user', title: '進入與離開系統', text: '用 Email 取得驗證碼登入；示範模式不會寄信，驗證碼直接顯示在頁面。右上可登出。' },
  { id: 'new-action', track: 'all', view: 'home', since: 1, target: '[data-testid="new-action"]', title: '建立新行動', text: '按「建立新行動」，填寫名稱、日期、地點與單位。' },
  { id: 'action-list', track: 'all', view: 'home', since: 1, target: '[data-testid="action-list"]', title: '我的行動', text: '建立好的行動會列在這裡，點進去開始收集素材。' },
  { id: 'collab-role', track: 'collab', view: 'materials', since: 1, target: '[data-testid="material-form"]', title: '您是共同協作者', text: '您可以上傳素材、編輯與刪除自己的素材。' },
  { id: 'upload-material', track: 'all', view: 'materials', since: 5, target: '[data-testid="material-form"]', title: '上傳素材', text: '在同一份表單上傳文字、照片與影片連結；YouTube 影片請設為「不公開」，送出後可以在列表編輯或刪除。' },
  { id: 'generate', track: 'manager', view: 'generate', since: 5, target: '[data-testid="generate-form"]', title: '生成報導', text: '設定字數與照片、影片上限，一鍵生成網頁報導或 A4 圖檔、PDF。' },
  { id: 'members', track: 'manager', view: 'members', since: 5, target: '[data-testid="members-list"]', title: '協作者', text: '在「成員」邀請或移除共同協作者。' },
  { id: 'done', track: 'all', view: 'home', since: 1, target: '[data-testid="mode-badge"]', title: '完成！', text: '教學結束，詳細說明請看「使用說明」。' },
];

/** 依角色與「已看過的版本」挑步驟。seenVersion=0 代表全部；只有新步驟時加上結尾提示。 */
export function stepsFor(track, seenVersion = 0) {
  const all = STEPS.filter((s) => s.track === 'all' || s.track === track);
  if (!seenVersion) return all;
  const fresh = all.filter((s) => s.since > seenVersion && s.id !== 'done');
  return fresh.length ? [...fresh, all.find((s) => s.id === 'done')] : [];
}

/**
 * 依「我的行動」決定教學角色：只參與別人的行動（全部是共同協作者／開放投稿）→ 'collab'；
 * 其他（總管理者、有自己建立的行動、還沒有任何行動的新使用者，接下來多半要建立行動）→ 'manager'
 */
export function trackFor(me, actions) {
  if (me && me.role === 'super') return 'manager';
  const list = actions || [];
  if (!list.length || list.some((a) => a.myRole === 'manager')) return 'manager';
  return 'collab';
}

/** 讀／寫本機紀錄：{ v: 看過的版本, track: 看過的角色 } */
export function readSeen(storage) {
  try {
    const raw = storage.getItem(TOUR_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return { v: Number(o.v) || 0, track: o.track === 'manager' ? 'manager' : 'collab' };
  } catch {
    return null;
  }
}
export function writeSeen(storage, track) {
  try {
    storage.setItem(TOUR_KEY, JSON.stringify({ v: TOUR_VERSION, track }));
  } catch {
    /* 無痕模式等：不影響使用 */
  }
}

/** 決定登入後要做什麼：'full' 完整播放、'new' 提示新步驟、null 不打擾 */
export function tourPlan(seen, track) {
  if (!seen) return 'full';
  if (seen.v < TOUR_VERSION) return 'new';
  if (track === 'manager' && seen.track !== 'manager') return 'new'; // 協作者後來成為負責人
  return null;
}

// ---------------- DOM（瀏覽器） ----------------
const PAD = 6;
const GAP = 12;
const EDGE = 12;
const WAIT = 4000;

/**
 * hooks: { api, getMe, getActions?, go, mode, storage, defaults }
 */
export function createTour(hooks) {
  let ui = null;
  let steps = [];
  let idx = 0;
  let actionId = null;
  let track = 'collab';
  let active = false;
  let onScroll = null;

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };

  async function listActions() {
    // 首頁剛載入過的列表就直接用（省一次後端往返）
    const cached = hooks.getActions && hooks.getActions();
    if (Array.isArray(cached) && cached.length) return cached;
    try {
      return (await hooks.api.call('actions.list')).actions || [];
    } catch {
      return []; // 取不到就當沒有行動
    }
  }

  async function detect() {
    const me = hooks.getMe();
    const actions = await listActions();
    track = trackFor(me, actions);
    const isManager = track === 'manager';
    const pick = actions.find((a) => (isManager ? a.myRole === 'manager' : true)) || actions[0];
    actionId = pick ? pick.id : null;
  }

  function hashFor(view) {
    if (view === 'home') return '#/';
    if (view === 'new') return '#/new';
    return actionId ? `#/a/${actionId}/${view}` : null;
  }

  const visible = (n) => n && n.getClientRects().length > 0 && !n.closest('[hidden]');
  async function waitFor(sel, ms) {
    const t0 = performance.now();
    for (;;) {
      const n = [...document.querySelectorAll(sel)].find(visible);
      if (n) return n;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  function build() {
    const hole = el('div', { class: 'tour-hole', 'aria-hidden': 'true' });
    const title = el('h2', { class: 'tour-title', id: 'tour-title' });
    const text = el('p', { class: 'tour-text', id: 'tour-text' });
    const note = el('p', { class: 'tour-note', hidden: '' });
    const count = el('span', { class: 'tour-count', 'data-testid': 'tour-count' });
    const prev = el('button', { type: 'button', class: 'tour-btn', 'data-testid': 'tour-prev', text: '上一步', onclick: () => show(idx - 1) });
    const next = el('button', { type: 'button', class: 'tour-btn primary', 'data-testid': 'tour-next', text: '下一步', onclick: () => (idx >= steps.length - 1 ? end() : show(idx + 1)) });
    const skip = el('button', { type: 'button', class: 'tour-skip', 'data-testid': 'tour-skip', text: '跳過', onclick: () => end() });
    const bubble = el(
      'div',
      { class: 'tour-bubble', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text', 'data-testid': 'tour-bubble', tabindex: '-1' },
      el('div', { class: 'tour-head' }, count, skip),
      title, text, note,
      el('div', { class: 'tour-actions' }, prev, next),
    );
    const blocker = el('div', { class: 'tour-blocker' });
    const root = el('div', { class: 'tour-root', 'data-testid': 'tour' }, blocker, hole, bubble);
    document.body.append(root);
    ui = { root, hole, bubble, title, text, note, count, prev, next, skip };
    document.addEventListener('keydown', onKey, true);
    onScroll = () => place();
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ui.next.click(); }
    else if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); show(idx - 1); }
  }

  let target = null;
  function place() {
    if (!ui) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const b = ui.bubble;
    const maxW = Math.min(380, Math.max(0, vw - EDGE * 2));
    b.style.maxWidth = `${maxW}px`;
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const clampLeft = (x) => {
      if (bw + EDGE * 2 >= vw) return Math.max(0, (vw - bw) / 2);
      return Math.min(vw - bw - EDGE, Math.max(EDGE, x));
    };
    const clampTop = (y) => {
      if (bh + EDGE * 2 >= vh) return Math.max(0, (vh - bh) / 2);
      return Math.min(vh - bh - EDGE, Math.max(EDGE, y));
    };
    if (!target) {
      ui.hole.hidden = true;
      ui.root.classList.add('no-target');
      b.style.left = `${clampLeft((vw - bw) / 2)}px`;
      b.style.top = `${clampTop((vh - bh) / 2)}px`;
      return;
    }
    ui.root.classList.remove('no-target');
    ui.hole.hidden = false;
    const r = target.getBoundingClientRect();
    const hx = Math.max(4, r.left - PAD);
    const hy = Math.max(4, r.top - PAD);
    const hw = Math.min(vw - 8, r.width + PAD * 2);
    const hh = Math.min(vh - 8, r.height + PAD * 2);
    Object.assign(ui.hole.style, { left: `${hx}px`, top: `${hy}px`, width: `${hw}px`, height: `${hh}px` });
    let top = hy + hh + GAP;
    if (top + bh > vh - EDGE) top = hy - GAP - bh;
    if (top < EDGE) top = hy + hh + GAP;
    b.style.left = `${clampLeft(hx + hw / 2 - bw / 2)}px`;
    b.style.top = `${clampTop(top)}px`;
  }

  async function show(i) {
    if (i < 0 || i >= steps.length) return;
    idx = i;
    const s = steps[i];
    const hash = hashFor(s.view);
    ui.title.textContent = s.title;
    ui.text.textContent = s.text;
    ui.count.textContent = `${i + 1} / ${steps.length}`;
    ui.prev.disabled = i === 0;
    const last = i === steps.length - 1;
    ui.next.textContent = last ? '完成' : '下一步';
    ui.skip.textContent = last ? '完成' : '跳過';
    // 最後一步 next 已是「完成」，隱藏 skip 避免兩個相同按鈕
    ui.skip.hidden = last;
    ui.root.dataset.step = s.id;
    delete ui.root.dataset.ready;
    target = null;
    if (hash && location.hash !== hash && !(hash === '#/' && (location.hash === '' || location.hash === '#'))) {
      hooks.go(hash);
    }
    if (hash === '#/a/' || (hash && hash.includes('/generate'))) {
      const wantA4 = ['gen-layout', 'gen-pages', 'gen-plan', 'gen-a4'].includes(s.id);
      const tab = document.querySelector(wantA4 ? '[data-testid=tab-a4]' : '[data-testid=tab-web]');
      if (tab) tab.click();
    }
    if (hash) target = await waitFor(s.target, WAIT);
    if (steps[idx] !== s) return; // 使用者已經換步
    ui.note.hidden = !!target;
    ui.note.textContent = target ? '' : hash ? '（這個畫面目前沒有對應的項目，例如還沒有素材時。）' : '（您目前還沒有可進入的行動；進入行動後就會看到這個畫面。）';
    if (target) {
      const r = target.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight * 0.55) target.scrollIntoView({ block: 'center' });
    }
    place();
    ui.root.dataset.ready = s.id; // 聚光燈已定位（測試用）
    ui.bubble.focus({ preventScroll: true });
  }

  function end() {
    if (!active) return;
    active = false;
    writeSeen(hooks.storage, track);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('scroll', onScroll, true);
    ui.root.remove();
    ui = null;
    target = null;
    hooks.go('#/');
  }

  function askTourStart(guessTrack) {
    const box = el(
      'div',
      { class: 'tour-toast', role: 'dialog', 'data-testid': 'tour-start-prompt' },
      el('span', { text: '要不要看使用教學？' }),
      el(
        'div',
        { class: 'tour-toast-actions' },
        el('button', { type: 'button', class: 'tour-btn primary', 'data-testid': 'tour-start-confirm', text: '開始', onclick: () => { box.remove(); start(); } }),
        el('button', { type: 'button', class: 'tour-skip', 'data-testid': 'tour-start-skip', text: '略過', onclick: () => { box.remove(); writeSeen(hooks.storage, guessTrack); } }),
      ),
    );
    document.body.append(box);
  }

  async function start({ onlyNew = false } = {}) {
    if (active) return;
    active = true;
    await detect();
    const seen = readSeen(hooks.storage);
    if (!onlyNew || !seen) steps = stepsFor(track, 0);
    else if (seen.track === 'collab' && track === 'manager') steps = STEPS.filter((s) => s.track === 'manager' || s.id === 'done');
    else steps = stepsFor(track, seen.v);
    if (!steps.length) { active = false; writeSeen(hooks.storage, track); return; }
    build();
    show(0);
  }

  /** 新步驟提示（已看過舊版的人） */
  function promptNew() {
    const box = el(
      'div',
      { class: 'tour-toast', role: 'status', 'data-testid': 'tour-new' },
      el('span', { text: '使用教學有新步驟！' }),
      el(
        'div',
        { class: 'tour-toast-actions' },
        el('button', { type: 'button', class: 'tour-btn primary', text: '看新步驟', onclick: () => { box.remove(); start({ onlyNew: true }); } }),
        el('button', { type: 'button', class: 'tour-skip', text: '略過', onclick: () => { box.remove(); writeSeen(hooks.storage, track); } }),
      ),
    );
    document.body.append(box);
  }

  let checked = false;
  /** 登入後呼叫一次：第一次先問要不要看，教學改版時提示 */
  async function maybeStart() {
    if (checked || active) return;
    checked = true;
    const seen = readSeen(hooks.storage);
    // 看過目前版本、而且已經是負責人教學：不會再提示，不必查「我的行動」（省一次後端往返）
    if (seen && seen.v >= TOUR_VERSION && seen.track === 'manager') return;
    // 沒看過就直接播（start 會自己判斷角色）；看過的人才需要先查「我的行動」判斷角色有沒有變
    const guessTrack = trackFor(hooks.getMe(), await listActions());
    if (active || !checked || !hooks.getMe()) return; // 等待期間已開始教學或已登出
    const plan = tourPlan(seen, guessTrack);
    if (plan === 'full') askTourStart(guessTrack);
    else if (plan === 'new') { track = guessTrack; promptNew(); }
  }

  /** 登出時呼叫：關掉進行中的教學與提示，下一位登入者會重新判斷是否自動播放 */
  function reset() {
    checked = false;
    if (active) {
      active = false;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
      if (ui) ui.root.remove();
      ui = null;
      target = null;
    }
    for (const n of document.querySelectorAll('.tour-toast')) n.remove();
  }

  return { start, maybeStart, reset, get active() { return active; } };
}
