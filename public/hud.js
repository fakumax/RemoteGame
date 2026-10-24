// RemoteGame: ping badge over the top-right corner of the game screen.
// It is plain HTML on top of the picture, so it never enters the video that is streamed.
(function(root) {
  const style = document.createElement('style');
  style.textContent = `
.hud-ping{position:absolute;top:8px;right:10px;z-index:30;display:none;pointer-events:none;padding:3px 10px;border-radius:12px;
  background:rgba(0,0,0,.55);font:700 13px/1.4 Segoe UI,Arial,sans-serif;color:#3ddc84;text-shadow:0 1px 2px #000;white-space:nowrap}
.hud-ping .warn{color:#ffb020}.hud-ping .bad{color:#ff5d5d}.hud-ping .ok{color:#3ddc84}.hud-ping .sep{color:#9aa3c0}
/* Phone in landscape: the R button floats in that corner */
@media (orientation:landscape) and (max-height:520px){body.touch .hud-ping{right:auto;left:50%;transform:translateX(-50%)}}`;
  document.head.appendChild(style);

  // Green under 60 ms, yellow under 120, red above.
  const quality = ms => ms < 60 ? 'ok' : ms < 120 ? 'warn' : 'bad';

  // container: positioned element that is (or sits inside) the fullscreen target.
  // The host has one reading per guest ("P2 32 ms · P3 80 ms"), keyed by name; the guest has just one.
  function ping(container) {
    const badge = document.createElement('div');
    badge.className = 'hud-ping';
    container.appendChild(badge);
    const reads = new Map(); // key -> { ms, stale }
    function draw() {
      badge.textContent = '';
      if (!reads.size) { badge.style.display = 'none'; return; }
      badge.append('📶 ');
      let first = true;
      for (const [key, r] of [...reads].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
        if (!first) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = ' · '; badge.append(sep); }
        first = false;
        const part = document.createElement('span');
        part.className = quality(r.ms);
        part.textContent = (key ? key + ' ' : '') + Math.round(r.ms) + ' ms';
        badge.append(part);
      }
      badge.style.display = 'block';
    }
    function drop(key) { const r = reads.get(key); if (r) { clearTimeout(r.stale); reads.delete(key); } }
    return {
      // Without a key: forget every reading. With one: just that guest's.
      hide(key) {
        if (key === undefined) for (const k of [...reads.keys()]) drop(k); else drop(key);
        draw();
      },
      // A reading disappears by itself if they stop (the call died).
      set(ms, key = '') {
        const old = reads.get(key);
        if (old) clearTimeout(old.stale);
        reads.set(key, { ms, stale: setTimeout(() => { drop(key); draw(); }, 7000) });
        draw();
      }
    };
  }
  root.RemoteHUD = { ping, quality };
})(globalThis);
