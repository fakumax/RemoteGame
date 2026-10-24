// RemoteGame: CRT looks drawn with CSS layers over the picture (no per-frame work).
// They never touch the stream: each side sees its own pick on its own screen.
(function(root) {
  const KEY = 'remotegame-crt';
  // Old versions stored 'on' / 'off'.
  const STYLES = { off: 'Apagado', classic: 'CRT clásico', scan: 'Scanlines', soft: 'Scanlines suaves', trin: 'Trinitron', arcade: 'Arcade' };
  const style = document.createElement('style');
  // --scan: screen px per game line; --k: 1 when a line is wide enough to look sharp, less (or 0) when it would shimmer.
  style.textContent = `
.crt{position:absolute;inset:0;pointer-events:none;z-index:20;display:none;border-radius:inherit}
.crt-on>.crt{display:block}
.crt-on video,.crt-on canvas{image-rendering:auto!important}
/* Classic: shadow mask + faint lines + vignette */
.crt-classic>.crt{background:
    radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,.55) 100%),
    repeating-linear-gradient(90deg, rgba(255,40,40,.06) 0 1px, rgba(40,255,40,.06) 1px 2px, rgba(40,40,255,.06) 2px 3px),
    repeating-linear-gradient(180deg, transparent 0 calc(var(--scan) * .5), rgba(0,0,0,calc(var(--k) * .32)) calc(var(--scan) * .5) var(--scan));
  box-shadow:inset 0 0 60px rgba(0,0,0,.6)}
.crt-classic video,.crt-classic canvas{filter:brightness(1.18) saturate(1.15) contrast(1.05)}
/* Scanlines: only crisp horizontal dark lines, nothing else */
.crt-scan>.crt{background:repeating-linear-gradient(180deg, transparent 0 calc(var(--scan) * .45), rgba(0,0,0,calc(var(--k) * .6)) calc(var(--scan) * .45) var(--scan))}
.crt-scan video,.crt-scan canvas{filter:brightness(1.2) contrast(1.05)}
/* Soft scanlines: thin, faint lines and a light bloom */
.crt-soft>.crt{background:
    radial-gradient(ellipse at center, rgba(255,255,255,.07) 0%, transparent 70%),
    repeating-linear-gradient(180deg, transparent 0 calc(var(--scan) * .62), rgba(0,0,0,calc(var(--k) * .34)) calc(var(--scan) * .62) var(--scan));
  box-shadow:inset 0 0 40px rgba(255,255,255,.05)}
.crt-soft video,.crt-soft canvas{filter:brightness(1.1) contrast(.97) saturate(1.1) blur(.35px)}
/* Trinitron: vertical aperture grille, two thin damper wires across (at 1/3 and 2/3) and faint lines */
.crt-trin>.crt{background:
    linear-gradient(180deg, transparent calc(33.3% - 1px), rgba(0,0,0,.55) calc(33.3% - 1px) calc(33.3% + 1px), transparent calc(33.3% + 1px) calc(66.6% - 1px), rgba(0,0,0,.55) calc(66.6% - 1px) calc(66.6% + 1px), transparent calc(66.6% + 1px)),
    repeating-linear-gradient(90deg, rgba(255,60,60,.13) 0 1px, rgba(60,255,60,.13) 1px 2px, rgba(60,60,255,.13) 2px 3px, rgba(0,0,0,.18) 3px 4px),
    repeating-linear-gradient(180deg, transparent 0 calc(var(--scan) * .6), rgba(0,0,0,calc(var(--k) * .14)) calc(var(--scan) * .6) var(--scan));
  box-shadow:inset 0 0 30px rgba(0,0,0,.35)}
.crt-trin video,.crt-trin canvas{filter:brightness(1.25) saturate(1.3) contrast(1.08)}
/* Arcade: heavy lines, strong vignette, a glow and rounded tube corners */
.crt-arcade{border-radius:5% / 6.5%;overflow:hidden}
.crt-arcade>.crt{background:
    radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,.8) 100%),
    repeating-linear-gradient(180deg, transparent 0 calc(var(--scan) * .4), rgba(0,0,0,calc(var(--k) * .7)) calc(var(--scan) * .4) var(--scan));
  box-shadow:inset 0 0 90px rgba(0,0,0,.85), inset 0 0 12px rgba(120,190,255,.28)}
.crt-arcade video,.crt-arcade canvas{filter:brightness(1.35) saturate(1.35) contrast(1.15)}`;
  document.head.appendChild(style);

  const known = v => Object.hasOwn(STYLES, v);
  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'on' || !known(v) ? 'classic' : v;
    } catch (e) { return 'classic'; }
  }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  // frame: box exactly covering the picture. select: optional <select> to pick the look.
  function attach(frame, select) {
    const layer = document.createElement('div');
    layer.className = 'crt';
    frame.appendChild(layer);
    let lines = 240, look = saved();
    // One dark scanline per game line; thinner than 2.5px on screen they would shimmer, so fade them.
    const fit = () => {
      const px = frame.getBoundingClientRect().height / lines;
      frame.style.setProperty('--scan', px.toFixed(3) + 'px');
      frame.style.setProperty('--k', px >= 2.5 ? '1' : px >= 1.8 ? '.56' : '0');
    };
    const render = () => {
      for (const id in STYLES) frame.classList.toggle('crt-' + id, id === look);
      frame.classList.toggle('crt-on', look !== 'off');
      if (select) select.value = look;
    };
    if (root.ResizeObserver) new ResizeObserver(fit).observe(frame);
    addEventListener('resize', fit);
    if (select) {
      select.textContent = '';
      for (const id in STYLES) { const o = document.createElement('option'); o.value = id; o.textContent = STYLES[id]; select.appendChild(o); }
      select.onchange = () => { look = known(select.value) ? select.value : 'classic'; save(look); render(); };
    }
    fit(); render();
    return {
      // Arcade boards draw 224 lines; consoles 240.
      setCore(core) { lines = core === 'fbneo' || core === 'mame2003' ? 224 : 240; fit(); }
    };
  }
  root.RemoteCRT = { attach, STYLES };
})(globalThis);
