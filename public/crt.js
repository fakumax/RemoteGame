// RemoteGame: light CRT look drawn with CSS layers over the picture (no per-frame work).
// It never touches the stream: each side sees it on its own screen and can turn it off.
(function(root) {
  const KEY = 'remotegame-crt';
  const style = document.createElement('style');
  style.textContent = `
.crt{position:absolute;inset:0;pointer-events:none;z-index:20;display:none;border-radius:inherit;
  background:
    radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,.55) 100%),
    repeating-linear-gradient(90deg, rgba(255,40,40,.06) 0 1px, rgba(40,255,40,.06) 1px 2px, rgba(40,40,255,.06) 2px 3px),
    repeating-linear-gradient(180deg, transparent 0 calc(var(--scan) * .5), rgba(0,0,0,var(--scan-a)) calc(var(--scan) * .5) var(--scan));
  box-shadow:inset 0 0 60px rgba(0,0,0,.6)}
.crt-on>.crt{display:block}
.crt-on video,.crt-on canvas{filter:brightness(1.18) saturate(1.15) contrast(1.05);image-rendering:auto!important}`;
  document.head.appendChild(style);

  function saved() { try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; } }
  function save(on) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {} }

  // frame: box exactly covering the picture. button: optional on/off toggle.
  function attach(frame, button) {
    const layer = document.createElement('div');
    layer.className = 'crt';
    frame.appendChild(layer);
    let lines = 240, on = saved();
    // One dark scanline per game line; thinner than 2.5px on screen they would shimmer, so fade them.
    const fit = () => {
      const px = frame.getBoundingClientRect().height / lines;
      frame.style.setProperty('--scan', px.toFixed(3) + 'px');
      frame.style.setProperty('--scan-a', px >= 2.5 ? '.32' : px >= 1.8 ? '.18' : '0');
    };
    const render = () => {
      frame.classList.toggle('crt-on', on);
      if (button) button.textContent = on ? '📺 CRT on' : '📺 CRT off';
    };
    if (root.ResizeObserver) new ResizeObserver(fit).observe(frame);
    addEventListener('resize', fit);
    if (button) button.onclick = () => { on = !on; save(on); render(); };
    fit(); render();
    return {
      // Arcade boards draw 224 lines; consoles 240.
      setCore(core) { lines = core === 'fbneo' || core === 'mame2003' ? 224 : 240; fit(); }
    };
  }
  root.RemoteCRT = { attach };
})(globalThis);
