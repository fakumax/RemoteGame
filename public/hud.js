// RemoteGame: ping badge over the top-right corner of the game screen.
// It is plain HTML on top of the picture, so it never enters the video that is streamed.
(function(root) {
  const style = document.createElement('style');
  style.textContent = `
.hud-ping{position:absolute;top:8px;right:10px;z-index:30;display:none;pointer-events:none;padding:3px 10px;border-radius:12px;
  background:rgba(0,0,0,.55);font:700 13px/1.4 Segoe UI,Arial,sans-serif;color:#3ddc84;text-shadow:0 1px 2px #000;white-space:nowrap}
.hud-ping .warn{color:#ffb020}.hud-ping .bad{color:#ff5d5d}.hud-ping .ok{color:#3ddc84}.hud-ping .sep{color:#9aa3c0}
/* Phone in landscape: the R button floats in that corner */
@media (orientation:landscape) and (max-height:520px){body.touch .hud-ping{right:auto;left:50%;transform:translateX(-50%)}}
/* Who is pressing what: one chip per player that lights up while a button is held (the host's "test the controls") */
.hud-pl{display:flex;flex-wrap:wrap;gap:6px}.hud-pl:empty{display:none}
.hud-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:14px;border:1px solid var(--line,#2c3350);background:rgba(15,18,32,.7);font:600 12px/1.4 Segoe UI,Arial,sans-serif;color:var(--mut,#9aa3c0);white-space:nowrap}
.hud-chip b{color:var(--txt,#e8ebf5)}.hud-chip i{width:9px;height:9px;border-radius:50%;background:#3a4166;flex:none}
.hud-chip.recent{color:var(--txt,#e8ebf5)}.hud-chip.recent i{background:#2f8f5a}
.hud-chip.on{color:#08122b;background:var(--ok,#3ddc84);border-color:var(--ok,#3ddc84)}.hud-chip.on b{color:#08122b}.hud-chip.on i{background:#08122b}
.hud-chip.lost{opacity:.6}`;
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
  // The test of the controls, on the host's side: a chip per player ("P2 ● ↑ A") lit while that guest holds something.
  // set(player, state, seenAt): the state that just arrived (RetroPad bits and sticks) and when. drop(player): that guest left.
  function padLights(box) {
    const chips = new Map(); // player -> { el, dot, txt, text, held, pressedAt, seenAt }
    let timer = null;
    function chip(player) {
      let c = chips.get(player);
      if (c) return c;
      const el = document.createElement('span'); el.className = 'hud-chip';
      const who = document.createElement('b'); who.textContent = 'P' + player;
      const dot = document.createElement('i'), txt = document.createElement('span');
      el.append(who, dot, txt);
      c = { el, txt, text: '', held: false, pressedAt: 0, seenAt: Date.now() };
      chips.set(player, c);
      const order = [...chips.keys()].sort((a, b) => a - b);
      box.replaceChildren(...order.map(p => chips.get(p).el));
      if (!timer) timer = setInterval(draw, 120);
      draw();
      return c;
    }
    function draw() {
      const now = Date.now();
      for (const c of chips.values()) {
        const quiet = now - c.seenAt > 3000;
        const mode = c.held && !quiet ? 'on' : now - c.pressedAt < 1500 ? 'recent' : '';
        c.el.className = 'hud-chip' + (mode ? ' ' + mode : '') + (quiet ? ' lost' : '');
        c.txt.textContent = mode ? c.text : quiet ? 'sin señal' : 'conectado, sin tocar nada';
      }
    }
    return {
      set(player, state, seenAt) {
        const c = chip(player), words = root.RemotePads ? root.RemotePads.describe(state) : [];
        c.seenAt = seenAt || Date.now();
        c.held = words.length > 0;
        if (c.held) { c.text = words.join(' '); c.pressedAt = c.seenAt; }
        draw();
      },
      drop(player) {
        if (!chips.delete(player)) return;
        box.replaceChildren(...[...chips.keys()].sort((a, b) => a - b).map(p => chips.get(p).el));
        if (!chips.size && timer) { clearInterval(timer); timer = null; }
      },
      players: () => [...chips.keys()]
    };
  }
  root.RemoteHUD = { ping, quality, padLights };
})(globalThis);
