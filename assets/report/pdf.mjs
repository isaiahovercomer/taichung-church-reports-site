// 極簡 PDF 產生器：每頁放一張 JPEG（DCTDecode），A4 直式。純函式、不依賴套件。
// pages: [{ jpeg: Uint8Array, width, height }]（width/height 為像素）→ Uint8Array（PDF 檔案位元組）

const A4_PT = { w: 595.28, h: 841.89 };

export function buildPdf(pages) {
  if (!pages.length) throw new Error('PDF 至少要有一頁');
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    size += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    for (const part of [].concat(body)) push(part);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二進位註解：讓傳輸工具把檔案當二進位
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const pid = pageIds[i];
    const content = `q ${A4_PT.w} 0 0 ${A4_PT.h} 0 0 cm /Im0 Do Q`;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_PT.w} ${A4_PT.h}] /Resources << /XObject << /Im0 ${pid + 2} 0 R >> >> /Contents ${pid + 1} 0 R >>`);
    obj(pid + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(pid + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      '\nendstream',
    ]);
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
