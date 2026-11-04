// 網站頁面的少量互動：年份下拉跳頁、複製連結、在 https 網址上以實際網址更新分享連結。

for (const select of document.querySelectorAll('select[data-nav-select]')) {
  select.addEventListener('change', () => {
    const target = new URL(select.value, location.href);
    if (target.origin === location.origin) location.href = target.href;
  });
}

const here = location.protocol === 'https:' ? `${location.origin}${location.pathname}` : null;

if (here) {
  const u = encodeURIComponent(here);
  const line = document.querySelector('a[data-share="line"]');
  const fb = document.querySelector('a[data-share="facebook"]');
  if (line) line.href = `https://social-plugins.line.me/lineit/share?url=${u}`;
  if (fb) fb.href = `https://www.facebook.com/sharer/sharer.php?u=${u}`;
}

for (const btn of document.querySelectorAll('button[data-copy-url]')) {
  btn.addEventListener('click', async () => {
    const url = here || btn.dataset.copyUrl;
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '已複製！';
    } catch {
      btn.textContent = '無法複製，請手動複製網址';
    }
    setTimeout(() => {
      btn.textContent = label;
    }, 2000);
  });
}
