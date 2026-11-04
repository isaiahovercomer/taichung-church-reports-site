// 文字節錄器（可插拔）。介面：
//   summarizer.summarize({ materials, targetChars }) → Promise<{ sections, totalChars }>
//   materials: [{ id, kind, title, author, text }]
//   sections:  [{ materialId, paragraphs: [string], chars, truncated }]（順序同 materials）
// 預設 ruleBasedSummarizer：純規則、在瀏覽器本機執行，不會把文字送到任何地方。
// remoteSummarizer 只是介面範例：只呼叫設定的 https endpoint，程式裡沒有任何金鑰，預設不啟用。

/** 字數：去掉空白後的字元數（中文一字一字、英數一字元一字） */
export function countChars(s) {
  return Array.from(String(s ?? '').replace(/\s+/g, '')).length;
}

export function splitParagraphs(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const TERMINALS = '。！？!?；;';
const CLOSERS = '」』”’）)】》〉"\'';

/** 依句號等標點切句，標點與後面的引號、括號留在句尾；英文句點只在後面接空白時才切。 */
export function splitSentences(paragraph) {
  const chars = Array.from(String(paragraph ?? ''));
  const out = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    cur += c;
    const isEnd = TERMINALS.includes(c) || c === '…' || (c === '.' && (i + 1 >= chars.length || /\s/.test(chars[i + 1])));
    if (!isEnd) continue;
    while (i + 1 < chars.length && (TERMINALS.includes(chars[i + 1]) || chars[i + 1] === '…' || chars[i + 1] === '.')) cur += chars[++i];
    while (i + 1 < chars.length && CLOSERS.includes(chars[i + 1])) cur += chars[++i];
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function joinSentences(list) {
  return list.reduce((acc, s) => (acc && /[A-Za-z0-9.!?;,]$/.test(acc) && /^[A-Za-z0-9"'(]/.test(s) ? `${acc} ${s}` : acc + s), '');
}

/** 依各素材長度比例分配字數（總長不超過目標時呼叫端直接全留）。 */
export function allocateBudgets(lengths, target) {
  const sum = lengths.reduce((a, n) => a + n, 0);
  return lengths.map((n) => (sum ? Math.floor((target * n) / sum) : 0));
}

function summarizeSync(materials, targetChars) {
  const parsed = materials.map((m) => {
    const sentences = [];
    splitParagraphs(m.text).forEach((p, pi) => {
      splitSentences(p).forEach((s, si) => sentences.push({ pi, si, text: s, chars: countChars(s) }));
    });
    return { m, sentences, total: sentences.reduce((a, s) => a + s.chars, 0) };
  });
  const totalAll = parsed.reduce((a, p) => a + p.total, 0);
  const budgets = totalAll <= targetChars ? parsed.map((p) => p.total) : allocateBudgets(parsed.map((p) => p.total), targetChars);

  const chosen = parsed.map((p, k) => {
    const n = p.sentences.length;
    const pick = new Set();
    if (!n) return { pick, used: 0 };
    // 一定保留開頭與結尾句
    pick.add(0);
    pick.add(n - 1);
    let used = [...pick].reduce((a, i) => a + p.sentences[i].chars, 0);
    if (used >= budgets[k]) return { pick, used };
    // 其次：各段第一句；再其次：依原文順序
    const order = p.sentences
      .map((s, i) => ({ i, rank: s.si === 0 ? 0 : 1 }))
      .filter((x) => !pick.has(x.i))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);
    for (const { i } of order) {
      if (used + p.sentences[i].chars <= budgets[k]) {
        pick.add(i);
        used += p.sentences[i].chars;
      }
    }
    return { pick, used };
  });

  // 全域補位：整體還有額度時，把放得下的句子補回去（不超過目標字數）
  let total = chosen.reduce((a, c) => a + c.used, 0);
  if (totalAll > targetChars) {
    parsed.forEach((p, k) => {
      p.sentences.forEach((s, i) => {
        if (!chosen[k].pick.has(i) && total + s.chars <= targetChars) {
          chosen[k].pick.add(i);
          chosen[k].used += s.chars;
          total += s.chars;
        }
      });
    });
  }

  const sections = parsed.map((p, k) => {
    const byPara = new Map();
    p.sentences.forEach((s, i) => {
      if (!chosen[k].pick.has(i)) return;
      if (!byPara.has(s.pi)) byPara.set(s.pi, []);
      byPara.get(s.pi).push(s.text);
    });
    const paragraphs = [...byPara.keys()].sort((a, b) => a - b).map((pi) => joinSentences(byPara.get(pi)));
    return { materialId: p.m.id, paragraphs, chars: chosen[k].used, truncated: chosen[k].pick.size < p.sentences.length };
  });
  return { sections, totalChars: sections.reduce((a, s) => a + s.chars, 0) };
}

export const ruleBasedSummarizer = {
  id: 'rule',
  name: '規則節錄（本機）',
  async summarize({ materials, targetChars }) {
    return summarizeSync(materials, targetChars);
  },
  summarizeSync,
};

/**
 * 遠端節錄器介面範例（預設不啟用）。
 * 只把 { materials:[{id,kind,title,author,text}], targetChars } POST 到設定的 https endpoint，
 * 期待回傳 { sections:[{ materialId, paragraphs:[string] }] }。
 * 不在程式裡放任何金鑰：endpoint 應該是你們自己架的代理服務，金鑰放在那台伺服器上。
 * 回傳格式不對或連線失敗時，退回 ruleBasedSummarizer。
 */
export function remoteSummarizer({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof endpoint !== 'string' || !/^https:\/\/[^\s]+$/.test(endpoint)) throw new Error('remoteSummarizer：endpoint 必須是 https 網址');
  return {
    id: 'remote',
    name: '遠端節錄（自訂服務）',
    async summarize({ materials, targetChars }) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ targetChars, materials: materials.map(({ id, kind, title, author, text }) => ({ id, kind, title, author, text })) }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const json = await res.json();
        const byId = new Map((json.sections || []).map((s) => [s.materialId, s]));
        const sections = materials.map((m) => {
          const s = byId.get(m.id);
          const paragraphs = Array.isArray(s?.paragraphs) ? s.paragraphs.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [];
          return { materialId: m.id, paragraphs, chars: paragraphs.reduce((a, p) => a + countChars(p), 0), truncated: true };
        });
        if (!sections.some((s) => s.paragraphs.length)) throw new Error('empty');
        return { sections, totalChars: sections.reduce((a, s) => a + s.chars, 0) };
      } catch {
        return summarizeSync(materials, targetChars);
      }
    },
  };
}

/** 依設定選擇節錄器：只有 site.config.json 的 summarizer.enabled 為 true 且 endpoint 是 https 時才用遠端。 */
export function createSummarizer(config = {}) {
  const s = config.summarizer || {};
  if (s.enabled === true && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://')) return remoteSummarizer({ endpoint: s.endpoint });
  return ruleBasedSummarizer;
}
