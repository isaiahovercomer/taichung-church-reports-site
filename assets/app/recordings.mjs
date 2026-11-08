// 「素材」頁的行動錄音與逐字稿：
//   上傳錄音 → 瀏覽器切段（audio.mjs）→ 逐段送後端轉錄（OpenAI）→ 逐字稿 →
//   套用替換規則／AI 修正 → AI 彙整重點 → 「加入素材」後就能在「生成報導」使用。
// 另含逐字稿規則編輯器（全站：總管理者頁；本行動：負責人在這裡改）。

import { SEGMENT_SEC, audioSegments, bytesToBase64, probeAudio } from './audio.mjs?v=dafa651415';

const CONCURRENCY = 2; // 同時轉錄幾段（Apps Script 每段都要等 OpenAI 回應）
const RETRIES = 2;
const CORRECT_CHUNK = 5000;

const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
};
const fmtMb = (b) => `${(b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1)}MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把逐字稿切成數千字一段（盡量在換行或句號處切），給 AI 修正 */
export function chunkText(text, max = CORRECT_CHUNK) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = Math.max(rest.lastIndexOf('。', max), rest.lastIndexOf('！', max), rest.lastIndexOf('？', max));
    if (cut < max * 0.5) cut = max - 1;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) out.push(rest);
  return out;
}

/** 重點彙整（Markdown 條列）→ 素材文字：小標變段落開頭、每點一句 */
export function summaryToMaterialText(summary) {
  const paras = [];
  let cur = [];
  for (const raw of String(summary || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^#{1,6}\s*(.+)$/.exec(line);
    if (head) {
      if (cur.length) paras.push(cur.join(''));
      cur = [`${head[1].replace(/[：:]$/, '')}：`];
      continue;
    }
    let t = line.replace(/^([-*•‧・]|\d+[.、)]|[一二三四五六七八九十]+、)\s*/, '').replace(/\*\*/g, '');
    if (t && !/[。！？…」』）)]$/.test(t)) t += '。';
    cur.push(t);
  }
  if (cur.length) paras.push(cur.join(''));
  return paras.join('\n\n');
}

// ---------- 規則編輯器 ----------
/**
 * rules：{ vocabulary, replacements, correctionNotes, summaryNotes }
 * opts：{ h, field, editable, onSave(rules) → Promise, onReset?() }
 */
export function rulesEditor(rules, { h, field, editable, onSave, onReset, testid }) {
  const r = rules || { vocabulary: [], replacements: [], correctionNotes: '', summaryNotes: '' };
  const vocab = h('textarea', { name: 'rules-vocabulary', class: 'short', rows: 4, disabled: !editable, value: (r.vocabulary || []).join('、') });
  const repRows = h('div', { class: 'rep-rows', 'data-testid': 'rep-rows' });
  const addRep = (from = '', to = '') => {
    const f = h('input', { name: 'rep-from', placeholder: '常聽錯的字', maxlength: 40, value: from, disabled: !editable, 'aria-label': '原字' });
    const t = h('input', { name: 'rep-to', placeholder: '改成', maxlength: 40, value: to, disabled: !editable, 'aria-label': '改成' });
    const row = h('div', { class: 'rep-row' }, f, h('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }), t, editable ? h('button', { type: 'button', class: 'btn small', text: '刪除', onclick: () => row.remove() }) : null);
    repRows.append(row);
    return f;
  };
  for (const x of r.replacements || []) addRep(x.from, x.to);
  if (editable && !(r.replacements || []).length) addRep();
  const corr = h('textarea', { name: 'rules-correction', class: 'short', rows: 3, maxlength: 3000, disabled: !editable, value: r.correctionNotes || '' });
  const summ = h('textarea', { name: 'rules-summary', class: 'short', rows: 3, maxlength: 3000, disabled: !editable, value: r.summaryNotes || '' });
  const err = h('p', { class: 'errors', role: 'alert' });
  const get = () => ({
    vocabulary: vocab.value.split(/[\n,，、]+/).map((s) => s.trim()).filter(Boolean),
    replacements: [...repRows.querySelectorAll('.rep-row')].map((row) => ({ from: row.querySelector('[name=rep-from]').value.trim(), to: row.querySelector('[name=rep-to]').value.trim() })).filter((x) => x.from),
    correctionNotes: corr.value,
    summaryNotes: summ.value,
  });
  const el = h(
    'div',
    { class: 'rules-editor', 'data-testid': testid || 'rules-editor' },
    field('常用詞彙（轉錄時提示模型；用頓號或換行分隔）', vocab, '人名、會所名稱、屬靈用語寫在這裡，轉錄比較不會聽錯。'),
    h('fieldset', { class: 'field' }, h('legend', { class: 'label', text: '替換規則（常聽錯的字 → 正確寫法；套用規則與 AI 修正時都會用）' }), repRows, editable ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', 'data-testid': 'add-rep', text: '＋ 新增一條', onclick: () => addRep().focus() })) : null),
    field('AI 修正說明', corr, '告訴 AI 怎麼修逐字稿，例如保留講員原話、口頭禪要不要刪。'),
    field('重點彙整說明', summ, '告訴 AI 彙整時要整理哪些項目。'),
    err,
    editable
      ? h(
          'div',
          { class: 'actions' },
          h('button', {
            type: 'button',
            class: 'btn primary',
            'data-testid': 'save-rules',
            text: '儲存規則',
            onclick: async () => {
              err.textContent = '';
              try {
                await onSave(get());
              } catch (e) {
                err.textContent = e.message || String(e);
              }
            },
          }),
          onReset ? h('button', { type: 'button', class: 'btn', text: '恢復預設', onclick: () => onReset() }) : null,
        )
      : null,
  );
  return { el, get };
}

// ---------- 錄音區塊 ----------
/**
 * ctx：{ h, fill, field, api, Core, state, action, recordings, setStatus, errorText, isUnsupported, legacy, reload, download, safeFileName }
 */
export function renderRecordings(ctx) {
  const { h, fill, field, api, Core, state, action, setStatus, errorText } = ctx;
  const me = state.me;
  const ai = me.ai || { ready: false };
  const isManager = action.myRole === 'manager';
  const canUse = action.myRole === 'manager' || action.myRole === 'collaborator';
  const section = h('section', { class: 'panel recordings', 'data-testid': 'recordings' });
  if (!canUse) return null;
  if (ctx.legacy) {
    fill(section, h('h2', { text: '行動錄音與逐字稿' }), h('p', { class: 'hint', text: '後端尚未更新到 version 3，請總管理者重新發佈 Apps Script 後就能使用錄音逐字稿。' }));
    return section;
  }
  let recordings = ctx.recordings || [];
  const err = h('p', { class: 'errors', role: 'alert' });
  const list = h('div', { class: 'recording-list', 'data-testid': 'recording-list' });
  const running = new Map(); // recId → { cancel }

  // ---- 上傳與轉錄 ----
  const fileInput = h('input', { type: 'file', name: 'audio-file', accept: 'audio/*,video/mp4,.m4a,.mp3,.wav,.aac,.ogg,.webm,.flac' });
  const keep = h('input', { type: 'checkbox', name: 'keep-original', checked: true });
  const startBtn = h('button', { type: 'button', class: 'btn primary', 'data-testid': 'start-transcribe', text: '開始轉逐字稿', disabled: !ai.ready });
  const progress = h('div', { class: 'transcribe-progress', hidden: true, 'data-testid': 'transcribe-progress' });

  startBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    err.textContent = '';
    if (!file) {
      err.textContent = '請先選擇錄音檔';
      return;
    }
    // 同一個檔案、還沒轉完：接著轉（已完成的段落不重送）
    const resume = recordings.find((r) => r.name === file.name && r.size === file.size && r.status !== 'done');
    await transcribeFile(file, resume || null);
    fileInput.value = '';
  });

  async function withRetry(fn) {
    for (let k = 0; ; k++) {
      try {
        return await fn();
      } catch (e) {
        const retryable = ['NETWORK', 'SERVER_ERROR', 'BUSY'].includes(e.code) || (e.code === 'AI_ERROR' && /HTTP (429|5\d\d)/.test(e.message));
        if (!retryable || k >= RETRIES) throw e;
        await sleep(3000 * (k + 1));
      }
    }
  }

  async function transcribeFile(file, resume) {
    const audioMax = (me.audioMaxMb || 600) * 1048576;
    let wake = null;
    const bar = h('progress', { max: 1, value: 0 });
    const label = h('span', { class: 'hint' });
    const cancelBtn = h('button', { type: 'button', class: 'btn small', text: '暫停' });
    fill(progress, h('p', { text: `處理「${file.name}」（${fmtMb(file.size)}）…轉錄期間請保持這個頁面開啟；中途關掉的話，重新選同一個檔案就會從沒轉完的段落繼續。` }), bar, label, cancelBtn);
    progress.hidden = false;
    startBtn.disabled = true;
    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      label.textContent = '暫停中（目前送出的段落完成後停止）…';
    };
    try {
      try {
        wake = await navigator.wakeLock?.request('screen');
      } catch {
        wake = null; // 不支援或沒權限：不影響
      }
      setStatus('分析錄音…');
      const probe = await probeAudio(file);
      let rec = resume;
      if (!rec) {
        const est = Math.max(1, Math.ceil(probe.durationSec / SEGMENT_SEC));
        rec = (
          await api.call('recordings.create', {
            actionId: action.id,
            name: file.name,
            size: file.size,
            durationSec: Math.round(probe.durationSec),
            segmentSec: SEGMENT_SEC,
            segmentCount: Math.min(est, 80),
          })
        ).recording;
        recordings = [rec, ...recordings];
        drawList();
      }
      const done = new Set((rec.segmentsDone || []).map((v, i) => (v ? i : -1)).filter((i) => i >= 0));
      let total = rec.segmentCount || 1;
      let finished = done.size;
      let decodeP = 0;
      const show = () => {
        bar.value = Math.min(1, (finished + decodeP * 0.05) / Math.max(total, 1));
        label.textContent = `已轉錄 ${finished}／${total} 段（每段約 ${SEGMENT_SEC / 60} 分鐘）・讀取錄音 ${Math.round(decodeP * 100)}%`;
      };
      show();

      // 原始錄音另外直傳到 Drive 保存（選用；失敗不影響轉錄）
      const archive =
        keep.checked && !rec.fileId && file.size <= audioMax
          ? (async () => {
              const sess = await api.call('audio.createUpload', { actionId: action.id, name: file.name, mime: file.type || 'audio/mp4', size: file.size, origin: location.origin });
              const fileId = await api.uploadResumable(sess.uploadUrl, file, () => {});
              await api.call('audio.complete', { actionId: action.id, fileId });
              await api.call('recordings.attachFile', { actionId: action.id, id: rec.id, fileId });
              return true;
            })().catch((e) => {
              setStatus(`原始錄音沒有存到 Drive（${errorText(e)}）；逐字稿不受影響`, 'error');
              return false;
            })
          : Promise.resolve(null);

      const inflight = new Set();
      let failure = null;
      let finalTranscript = null;
      for await (const seg of audioSegments(file, { format: probe.format, segmentSec: SEGMENT_SEC, onProgress: (p) => ((decodeP = p), show()) })) {
        if (failure || cancelled) break;
        if (seg.last) total = seg.index + 1;
        else if (seg.index + 1 > total) total = seg.index + 1;
        if (done.has(seg.index) && !seg.last) continue;
        while (inflight.size >= CONCURRENCY) await Promise.race(inflight);
        if (failure || cancelled) break;
        const data = bytesToBase64(seg.wav);
        const p = withRetry(() => api.call('transcribe.segment', { actionId: action.id, id: rec.id, index: seg.index, start: seg.start, end: seg.end, last: seg.last, data }))
          .then((r) => {
            done.add(seg.index);
            finished = done.size;
            total = Math.max(total, r.segmentCount);
            if (r.status === 'done') finalTranscript = r.transcript;
            show();
          })
          .catch((e) => (failure = e))
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.all(inflight);
      if (failure) throw failure;
      if (cancelled) {
        setStatus('已暫停；重新選同一個檔案按「開始轉逐字稿」就會接著轉');
      } else {
        setStatus(finalTranscript != null ? '逐字稿完成' : '轉錄送出完成');
      }
      label.textContent = '等待原始錄音上傳到 Drive…';
      await archive;
      await refresh();
      if (!cancelled) openDetail(rec.id);
    } catch (e) {
      err.textContent = `${errorText(e)}（已完成的段落會保留，重新選同一個檔案可以接著轉）`;
      await refresh().catch(() => {});
    } finally {
      try {
        await wake?.release();
      } catch {
        /* 忽略 */
      }
      progress.hidden = true;
      startBtn.disabled = !ai.ready;
    }
  }

  async function refresh() {
    recordings = (await api.call('recordings.list', { actionId: action.id })).recordings;
    drawList();
  }

  // ---- 貼上現成逐字稿 ----
  const pasteName = h('input', { name: 'paste-name', maxlength: 200, placeholder: '例如：11/8 福音行動分享' });
  const pasteText = h('textarea', { name: 'paste-transcript', rows: 5 });
  const pasteBox = h(
    'details',
    { class: 'paste-transcript' },
    h('summary', { text: '已經有逐字稿了？直接貼上（例如在自己電腦轉好的）' }),
    field('名稱', pasteName),
    field('逐字稿', pasteText),
    h('div', { class: 'actions' }, h('button', {
      type: 'button',
      class: 'btn',
      text: '加入逐字稿',
      onclick: async () => {
        err.textContent = '';
        try {
          const r = await api.call('recordings.create', { actionId: action.id, name: pasteName.value || '貼上的逐字稿', transcript: pasteText.value });
          pasteName.value = '';
          pasteText.value = '';
          pasteBox.open = false;
          recordings = [r.recording, ...recordings];
          drawList();
          openDetail(r.recording.id);
        } catch (e) {
          err.textContent = errorText(e);
        }
      },
    })),
  );

  // ---- 規則（本行動） ----
  const rulesBox = h('details', { class: 'rules-box', 'data-testid': 'rules-box' }, h('summary', { text: isManager ? '逐字稿規則（本行動，可以慢慢累積修正）' : '逐字稿規則' }));
  rulesBox.addEventListener('toggle', async () => {
    if (!rulesBox.open || rulesBox.dataset.loaded) return;
    rulesBox.dataset.loaded = '1';
    const body = h('div', {}, h('p', { text: '載入中…' }));
    rulesBox.append(body);
    try {
      const r = await api.call('rules.get', { actionId: action.id });
      const ed = rulesEditor(r.action, {
        h,
        field,
        editable: r.canEditAction,
        testid: 'action-rules',
        onSave: async (rules) => {
          await api.call('rules.set', { scope: 'action', actionId: action.id, rules });
          setStatus('已儲存本行動的逐字稿規則');
        },
      });
      fill(
        body,
        h('p', { class: 'hint', text: `全站規則（總管理者維護）目前有 ${r.global.vocabulary.length} 個常用詞彙、${r.global.replacements.length} 條替換規則；這裡是只用在本行動的補充。${r.canEditAction ? '' : '只有負責人可以修改。'}` }),
        ed.el,
      );
    } catch (e) {
      fill(body, h('p', { class: 'errors', text: errorText(e) }));
    }
  });

  // ---- 列表與詳細 ----
  const details = new Map(); // recId → detail element
  function statusText(r) {
    if (r.status === 'done') return `已完成・${r.transcriptChars.toLocaleString()} 字${r.hasCorrected ? '・已修正' : ''}${r.hasSummary ? '・已彙整' : ''}`;
    return `轉錄中 ${r.doneCount}／${r.segmentCount} 段（重新選同一個檔案可以接著轉）`;
  }
  function drawList() {
    fill(
      list,
      recordings.length
        ? recordings.map((r) => {
            const det = details.get(r.id) || h('div', { class: 'recording-detail', hidden: true });
            details.set(r.id, det);
            return h(
              'article',
              { class: 'recording-card', 'data-recording': r.id },
              h(
                'div',
                { class: 'recording-head' },
                h('h3', { class: 'material-title', text: r.name }),
                h('span', { class: 'hint', 'data-testid': 'recording-status', text: [r.durationSec ? fmtTime(r.durationSec) : '', statusText(r), r.fileId ? '原始錄音已存 Drive' : ''].filter(Boolean).join('・') }),
              ),
              h(
                'div',
                { class: 'actions' },
                h('button', { type: 'button', class: 'btn small', 'data-testid': 'open-recording', text: det.hidden ? '開啟逐字稿' : '收合', onclick: (ev) => toggleDetail(r.id, ev.target) }),
                r.canDelete
                  ? h('button', {
                      type: 'button',
                      class: 'btn small danger',
                      text: '刪除',
                      onclick: async () => {
                        if (!confirm(`確定刪除錄音「${r.name}」與它的逐字稿？${r.fileId ? '存在 Drive 的原始錄音也會一併刪除。' : ''}`)) return;
                        try {
                          await api.call('recordings.delete', { actionId: action.id, id: r.id });
                          recordings = recordings.filter((x) => x.id !== r.id);
                          details.delete(r.id);
                          drawList();
                        } catch (e) {
                          err.textContent = errorText(e);
                        }
                      },
                    })
                  : null,
              ),
              det,
            );
          })
        : h('p', { class: 'empty', text: '還沒有錄音。選擇整場行動的錄音檔（最長可到 150 分鐘以上），系統會自動轉成逐字稿。' }),
    );
  }
  function toggleDetail(id, btn) {
    const det = details.get(id);
    if (det.hidden) openDetail(id);
    else {
      det.hidden = true;
      if (btn) btn.textContent = '開啟逐字稿';
    }
  }
  async function openDetail(id) {
    const det = details.get(id);
    if (!det) return;
    det.hidden = false;
    const btn = det.parentElement?.querySelector('[data-testid=open-recording]');
    if (btn) btn.textContent = '收合';
    fill(det, h('p', { text: '載入逐字稿…' }));
    try {
      const rec = (await api.call('recordings.get', { actionId: action.id, id })).recording;
      drawDetail(det, rec);
    } catch (e) {
      fill(det, h('p', { class: 'errors', text: errorText(e) }));
    }
  }

  function drawDetail(det, rec) {
    const derr = h('p', { class: 'errors', role: 'alert' });
    const raw = h('textarea', { name: 'transcript', rows: 10, class: 'transcript', 'data-testid': 'transcript', value: rec.transcript || rec.segments.map((s) => s.text).join('\n') });
    const fixed = h('textarea', { name: 'corrected', rows: 10, class: 'transcript', 'data-testid': 'corrected', value: rec.corrected, placeholder: '按上面的「套用替換規則」或「AI 修正」產生，也可以直接修改' });
    const summary = h('textarea', { name: 'summary', rows: 8, class: 'transcript', 'data-testid': 'summary', value: rec.summary, placeholder: '按「AI 彙整重點」產生，可以再修改' });
    const busy = h('span', { class: 'hint', 'data-testid': 'detail-busy' });
    const guard = (fn) => async (ev) => {
      derr.textContent = '';
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        derr.textContent = errorText(e);
      } finally {
        b.disabled = false;
        busy.textContent = '';
      }
    };
    const save = async (patch, msg) => {
      await api.call('recordings.update', { actionId: action.id, id: rec.id, ...patch });
      setStatus(msg);
    };
    const segInfo = rec.segments.length > 1 ? h('p', { class: 'hint', text: `共 ${rec.segments.length} 段：${rec.segments.map((s) => fmtTime(s.start)).join('、')}` }) : null;
    const aiOff = !ai.ready;
    fill(
      det,
      segInfo,
      field('逐字稿（原始）', raw, '轉錄結果；改了規則可以從這裡重新套用。'),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', text: '儲存原始逐字稿', onclick: guard(() => save({ transcript: raw.value }, '已儲存逐字稿')) }),
        h('button', {
          type: 'button',
          class: 'btn small',
          'data-testid': 'apply-rules',
          text: '套用替換規則 → 修正稿',
          onclick: guard(async () => {
            const r = await api.call('rules.get', { actionId: action.id });
            fixed.value = Core.applyReplacements(raw.value, r.merged.replacements);
            await save({ corrected: fixed.value }, `已套用 ${r.merged.replacements.length} 條替換規則`);
          }),
        }),
        h('button', {
          type: 'button',
          class: 'btn small primary',
          'data-testid': 'ai-correct',
          text: 'AI 修正 → 修正稿',
          disabled: aiOff,
          onclick: guard(async () => {
            const parts = chunkText(raw.value);
            const out = [];
            for (let i = 0; i < parts.length; i++) {
              busy.textContent = `AI 修正中 ${i + 1}／${parts.length}…`;
              out.push((await withRetry(() => api.call('transcript.correct', { actionId: action.id, id: rec.id, text: parts[i] }))).text);
            }
            fixed.value = out.join('\n');
            await save({ corrected: fixed.value }, 'AI 修正完成並已儲存');
          }),
        }),
      ),
      field('修正稿', fixed),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', text: '儲存修正稿', onclick: guard(() => save({ corrected: fixed.value }, '已儲存修正稿')) })),
      field('會議重點（AI 彙整，可修改）', summary),
      h(
        'div',
        { class: 'actions' },
        h('button', {
          type: 'button',
          class: 'btn small primary',
          'data-testid': 'ai-summarize',
          text: 'AI 彙整重點',
          disabled: aiOff,
          onclick: guard(async () => {
            if (fixed.value !== rec.corrected) await save({ corrected: fixed.value }, '已儲存修正稿');
            busy.textContent = 'AI 彙整中（長的錄音約需 1 分鐘）…';
            summary.value = (await withRetry(() => api.call('transcript.summarize', { actionId: action.id, id: rec.id }))).summary;
            rec.corrected = fixed.value;
            setStatus('已彙整重點');
          }),
        }),
        h('button', { type: 'button', class: 'btn small', text: '儲存重點', onclick: guard(() => save({ summary: summary.value }, '已儲存重點')) }),
        h('button', {
          type: 'button',
          class: 'btn small',
          'data-testid': 'summary-to-material',
          text: '重點加入素材（生成報導會用到）',
          onclick: guard(async () => {
            if (!summary.value.trim()) throw new Error('還沒有重點，請先按「AI 彙整重點」或自己填寫');
            await save({ summary: summary.value }, '已儲存重點');
            await api.call('materials.save', { actionId: action.id, kind: 'report', title: `${rec.name}｜錄音重點`.slice(0, 200), author: '', text: summaryToMaterialText(summary.value).slice(0, 20000), photos: [], videos: [] });
            setStatus('已加入素材：到「生成報導」勾選就會用到');
            ctx.reload();
          }),
        }),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', {
          type: 'button',
          class: 'btn small',
          text: '下載逐字稿（.txt）',
          onclick: () => {
            const text = [`${action.name}｜${rec.name}`, '', '【會議重點】', summary.value || '（尚未彙整）', '', '【修正稿】', fixed.value || '（尚未修正）', '', '【原始逐字稿】', raw.value].join('\n');
            ctx.download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${ctx.safeFileName(`${action.date}-${rec.name}`)}-逐字稿.txt`);
          },
        }),
        busy,
      ),
      aiOff ? h('p', { class: 'hint', text: 'AI 修正與彙整需要總管理者先設定 OpenAI 金鑰；在那之前可以用「套用替換規則」並手動修改。' }) : null,
      derr,
    );
  }

  drawList();
  fill(
    section,
    h('h2', { text: '行動錄音與逐字稿' }),
    h('p', { class: 'hint', text: '上傳整場行動的錄音（mp3、m4a、wav 等，最長可到 150 分鐘以上），系統會在瀏覽器切成約 5 分鐘一段，逐段轉成逐字稿；再用 AI 修正、彙整重點，加入素材後就能直接用在報導撰寫。' }),
    ai.ready ? null : h('p', { class: 'notice', 'data-testid': 'ai-not-ready', text: '總管理者尚未設定 OpenAI 金鑰，暫時不能自動轉錄；可以先用下方「直接貼上逐字稿」。' }),
    h('div', { class: 'row-2' }, field('錄音檔', fileInput), h('label', { class: 'field checkbox' }, keep, h('span', { text: `同時把原始錄音存到這個行動的 Drive 資料夾（上限 ${me.audioMaxMb || 600}MB）` }))),
    h('div', { class: 'actions' }, startBtn),
    progress,
    pasteBox,
    err,
    list,
    rulesBox,
  );
  return section;
}
