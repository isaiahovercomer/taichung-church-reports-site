// 瀏覽器端媒體處理：照片縮圖（最長邊 1600px、JPEG 0.85）、影片擷取封面影格。

export const PHOTO_MAX_EDGE = 1600;
export const PHOTO_QUALITY = 0.85;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('無法轉成 JPEG'))), 'image/jpeg', quality));
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取這張照片（請用 JPEG／PNG／WebP）'));
    };
    img.src = url;
  });
}

/** 照片縮到最長邊 1600px、轉 JPEG 0.85（透明處補白底），回傳 base64（不含 data: 前綴） */
export async function resizePhoto(file) {
  const img = await loadImageFromBlob(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const r = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * r));
  canvas.height = Math.max(1, Math.round(h * r));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  let blob = await canvasToJpeg(canvas, PHOTO_QUALITY);
  // 後端上限 1.5MB；極少數高細節照片在 0.85 仍超過時再降品質
  for (let q = 0.75; blob.size > 1.45 * 1024 * 1024 && q >= 0.45; q -= 0.15) blob = await canvasToJpeg(canvas, q);
  return { base64: await blobToBase64(blob), width: canvas.width, height: canvas.height, bytes: blob.size };
}

/** 從影片檔擷取一張影格當封面（JPEG base64）；瀏覽器無法解碼時回傳 null */
export function captureVideoFrame(file, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const t = Number.isFinite(video.duration) ? Math.min(1, video.duration / 3) : 0;
      video.currentTime = t;
    };
    video.onseeked = async () => {
      try {
        const r = Math.min(1, PHOTO_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * r));
        canvas.height = Math.max(1, Math.round(video.videoHeight * r));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(await blobToBase64(await canvasToJpeg(canvas, PHOTO_QUALITY)));
      } catch {
        finish(null);
      }
    };
    video.src = url;
  });
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
