// RemoteGame: ping badge over the top-right corner of the game screen.
// It is plain HTML on top of the picture, so it never enters the video that is streamed.
(function(root) {
  const style = document.createElement('style');
  style.textContent = `
.hud-ping{position:absolute;top:8px;right:10px;z-index:30;display:none;pointer-events:none;padding:3px 10px;border-radius:12px;
  background:rgba(0,0,0,.55);font:700 13px/1.4 Segoe UI,Arial,sans-serif;color:#3ddc84;text-shadow:0 1px 2px #000}
.hud-ping.warn{color:#ffb020}.hud-ping.bad{color:#ff5d5d}
/* Phone in landscape: the R button floats in that corner */
@media (orientation:landscape) and (max-height:520px){body.touch .hud-ping{right:auto;left:50%;transform:translateX(-50%)}}`;
  document.head.appendChild(style);

  // container: positioned element that is (or sits inside) the fullscreen target.
  function ping(container) {
    const badge = document.createElement('div');
    badge.className = 'hud-ping';
    container.appendChild(badge);
    let stale = null;
    const hide = () => { clearTimeout(stale); badge.style.display = 'none'; };
    return {
      hide,
      // Green under 60 ms, yellow under 120, red above. Hides itself if the readings stop (the call died).
      set(ms) {
        badge.textContent = '📶 ' + Math.round(ms) + ' ms';
        badge.className = 'hud-ping' + (ms < 60 ? '' : ms < 120 ? ' warn' : ' bad');
        badge.style.display = 'block';
        clearTimeout(stale);
        stale = setTimeout(hide, 7000);
      }
    };
  }
  root.RemoteHUD = { ping };
})(globalThis);
