// 使用教學（導覽）：第一次登入後自動播放；背景變暗、逐步標出介面；上一步／下一步／跳過；
// 依角色顯示步驟（共同協作者／負責人）；可從上方「使用教學」重看。
// v2：任何人登入後都能建立自己的行動並成為負責人；負責人在「協作者」頁籤增減共同協作者。
// 做法參考聖經 App 的 tour.js（聚光燈 + 說明泡泡），程式為本專案自寫。
//
// ★ 以後新增功能時：在 STEPS 加步驟，並把該步驟的 since 設成新的版本號、TOUR_VERSION 加 1。
//   看過舊版教學的人下次登入會收到「教學有新步驟」提示，只播放新步驟。

export const TOUR_VERSION = 3;
export const TOUR_KEY = 'rpt.tour';

// track：'all' 所有人、'collab' 只給共同協作者、'manager' 負責人（含總管理者）
// view：'home' | 'new' | 'materials' | 'generate' | 'members' | 'settings'（行動頁籤）
export const STEPS = [
  { id: 'welcome', since: 1, track: 'all', view: 'home', target: '[data-testid=tour-replay]',
    title: '歡迎使用行動報導協作平台', text: '這份教學會一步一步帶您認識主要功能。隨時可以按「跳過」，之後也能按這個「使用教學」按鈕重看。' },
  { id: 'login', since: 1, track: 'all', view: 'home', target: '.app-user',
    title: '登入與登出', text: '您是用 email 收到的 6 位數驗證碼登入，不需要密碼。這裡顯示目前登入的 email，用完可按「登出」。' },
  { id: 'new-action', since: 2, track: 'all', view: 'home', target: 'a[href="#/new"]',
    title: '建立新行動', text: '任何人登入後都可以建立自己的行動（例如福音出訪、特會），不需要管理員事先允許。建立的人就是這個行動的負責人，素材和報導都歸在這個行動底下。' },
  { id: 'action-collabs', since: 2, track: 'manager', view: 'new', target: '[data-testid=action-form] [data-testid=collab-rows]',
    title: '先邀請協作者（選填）', text: '一列填一位共同協作者的 email，姓名選填（方便辨認）；按「＋ 再加一位」加下一位。加過的人會記在「常用聯絡人」，下次點一下就能加入。之後也能在「協作者」頁籤增減。也可以勾選「開放任何登入者投稿」。' },
  { id: 'action-list', since: 2, track: 'all', view: 'home', target: '[data-testid=action-list]',
    title: '我的行動', text: '這裡列出您建立的行動（負責人）和被加入的行動（共同協作者），點一下卡片就能進入。' },
  { id: 'collab-role', since: 2, track: 'collab', view: 'materials', target: '[data-testid=my-role]',
    title: '您是共同協作者', text: '負責人把您加入了這個行動。您可以上傳素材、編輯或刪除自己上傳的素材，也能生成報導；行動設定和協作者名單由負責人管理。不想再參與時可以按「退出這個行動」。' },
  { id: 'tabs', since: 1, track: 'all', view: 'materials', target: '.app-tabs',
    title: '行動頁籤', text: '「素材」上傳文字、照片、影片；「生成報導」產生網頁報導與 A4；「產出紀錄」看已存回的報導。' },
  { id: 'upload-text', since: 1, track: 'all', view: 'materials', target: '[data-testid=material-form] textarea[name=text]',
    title: '上傳文字', text: '選類型（報導或見證），填標題與文字，可以分段。還沒送出的文字會暫存在這台裝置。' },
  { id: 'upload-photos', since: 1, track: 'all', view: 'materials', target: '[data-testid=material-form] input[name=photos]',
    title: '上傳照片', text: '可以一次選多張照片，會自動縮到最長邊 1600px。照片可加圖說，有圖說的照片會優先選用。' },
  { id: 'upload-video', since: 1, track: 'all', view: 'materials', target: '[data-testid=material-form] input[name=video-url]',
    title: '上傳影片', text: '建議先把影片上傳到 YouTube 並設為「不公開」，再把連結貼在這裡，最省空間也最穩定。也可以直接上傳小影片檔。' },
  { id: 'submit-material', since: 1, track: 'all', view: 'materials', target: '[data-testid=material-form] button[type=submit]',
    title: '送出素材', text: '填好後按「送出素材」，就會存到這個行動。' },
  { id: 'recordings', since: 3, track: 'all', view: 'materials', target: '[data-testid=recordings] textarea[name=paste-transcript]',
    title: '行動逐字稿', text: '把行動的逐字稿貼在這裡（例如用手機或電腦的語音轉文字先轉好）按「加入逐字稿」；再按「AI 修正」「AI 彙整重點」，最後「重點加入素材」，生成報導時就會用到。' },
  { id: 'my-materials', since: 1, track: 'all', view: 'materials', target: '[data-testid=material-list], [data-testid=material-form] ~ h2',
    title: '編輯／刪除素材', text: '已上傳的素材列在這裡，可以按「編輯」修改或「刪除」。共同協作者只能改刪自己上傳的；負責人可以管理所有素材。' },
  { id: 'gen-words', since: 1, track: 'manager', view: 'generate', target: '[data-testid=settings] input[name=words]',
    title: '報導設定：字數', text: '拖動滑桿設定網頁報導大約要多少字，系統會依素材自動整理到接近這個字數。' },
  { id: 'gen-limits', since: 1, track: 'manager', view: 'generate', target: '[data-testid=settings] input[name=maxPhotos]',
    title: '照片與影片上限', text: '設定最多放幾張照片、幾部影片。照片太多時會優先選有圖說的。' },
  { id: 'gen-layout', since: 1, track: 'manager', view: 'generate', target: '[data-testid=settings] fieldset',
    title: '版型', text: '選擇網頁報導的版型：經典單欄、圖文交錯或雙欄專題。' },
  { id: 'gen-pages', since: 1, track: 'manager', view: 'generate', target: '[data-testid=settings] input[name=pages]',
    title: 'A4 頁數', text: '設定 A4 圖檔／PDF 要幾頁。內容放不下時會自動減字、減照片，並註明「完整內容請見網頁報導」。' },
  { id: 'gen-web', since: 1, track: 'manager', view: 'generate', target: '[data-testid=gen-web]',
    title: '一鍵生成網頁報導', text: '按一下就依設定產生網頁報導並在下方預覽，可以下載單一 HTML 或存回後端。' },
  { id: 'gen-a4', since: 1, track: 'manager', view: 'generate', target: '[data-testid=gen-a4]',
    title: '一鍵生成 A4 圖檔／PDF', text: '產生 A4 圖檔，可逐頁下載圖片，或按旁邊的「下載 PDF」得到整份 PDF。' },
  { id: 'members', since: 2, track: 'manager', view: 'members', target: '[data-testid=add-collaborator] input[name=collaborator-email]',
    title: '新增／移除共同協作者', text: '在「協作者」頁籤輸入對方的 email（姓名選填）按「新增」，或直接點「常用聯絡人」加入，再把行動網址傳給對方；對方登入後就能上傳並編輯自己的素材。名單上每位協作者都可以按「移除」，已上傳的素材會保留。' },
  { id: 'action-settings', since: 2, track: 'manager', view: 'settings', target: '[data-testid=action-form] input[name=name]',
    title: '行動設定', text: '「行動設定」頁籤可以修改行動名稱、日期、地點與報導預設值，只有負責人看得到。' },
  { id: 'done', since: 1, track: 'all', view: 'home', target: '[data-testid=tour-replay]',
    title: '完成！', text: '教學結束。想再看一次，隨時按上方的「使用教學」。' },
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
    if (cached) return cached;
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
    let pick = actions.find((a) => (isManager ? a.myRole === 'manager' : true)) || actions[0];
    if (!pick && hooks.mode === 'demo' && isManager) {
      // 示範模式：沒有行動就建立一個示範行動，讓教學能從頭走完
      try {
        const r = await hooks.api.call('actions.create', {
          name: '教學示範行動', date: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10), place: '台中市召會',
          description: '使用教學自動建立的示範行動（示範模式資料只在這個分頁）。',
          collaborators: '', openSubmission: false, defaults: hooks.defaults,
        });
        pick = r.action;
        await hooks.api.call('materials.save', {
          actionId: pick.id, kind: 'testimony', title: '示範見證', author: '示範弟兄',
          text: '主日下午弟兄姊妹一同出訪，彼此扶持，經歷主的同在。\n\n（這是使用教學自動建立的示範素材。）',
          photos: [], videos: [],
        });
      } catch {
        /* 建不起來就以說明代替 */
      }
    }
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
    ui = { root, hole, bubble, title, text, note, count, prev, next };
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
    b.style.maxWidth = `${Math.min(380, vw - EDGE * 2)}px`;
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    if (!target) {
      ui.hole.hidden = true;
      ui.root.classList.add('no-target');
      b.style.left = `${Math.max(EDGE, (vw - bw) / 2)}px`;
      b.style.top = `${Math.max(EDGE, (vh - bh) / 2)}px`;
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
    if (top < EDGE) top = Math.min(vh - bh - EDGE, Math.max(EDGE, hy + hh + GAP));
    const left = Math.min(vw - bw - EDGE, Math.max(EDGE, hx + hw / 2 - bw / 2));
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
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
    ui.next.textContent = i === steps.length - 1 ? '完成' : '下一步';
    ui.root.dataset.step = s.id;
    delete ui.root.dataset.ready;
    target = null;
    if (hash && location.hash !== hash && !(hash === '#/' && (location.hash === '' || location.hash === '#'))) {
      hooks.go(hash);
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
      el('button', { type: 'button', class: 'tour-btn primary', text: '看新步驟', onclick: () => { box.remove(); start({ onlyNew: true }); } }),
      el('button', { type: 'button', class: 'tour-skip', text: '略過', onclick: () => { box.remove(); writeSeen(hooks.storage, track); } }),
    );
    document.body.append(box);
  }

  let checked = false;
  /** 登入後呼叫一次：第一次自動播放、教學改版時提示 */
  async function maybeStart() {
    if (checked || active) return;
    checked = true;
    const seen = readSeen(hooks.storage);
    // 看過目前版本、而且已經是負責人教學：不會再提示，不必查「我的行動」（省一次後端往返）
    if (seen && seen.v >= TOUR_VERSION && seen.track === 'manager') return;
    // 沒看過就直接播（start 會自己判斷角色）；看過的人才需要先查「我的行動」判斷角色有沒有變
    const guessTrack = seen ? trackFor(hooks.getMe(), await listActions()) : 'collab';
    if (active || !checked || !hooks.getMe()) return; // 等待期間已開始教學或已登出
    const plan = tourPlan(seen, guessTrack);
    if (plan === 'full') start();
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
