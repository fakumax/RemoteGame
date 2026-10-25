// RemoteGame: the permanent invite banner (link for the friend + whether they are in).
(function(root) {
  function row(label, url, note) {
    const div = document.createElement('div');
    div.className = 'row';
    div.style.marginTop = '6px';
    const b = document.createElement('b'); b.textContent = label;
    const code = document.createElement('span'); code.textContent = url; code.style.wordBreak = 'break-all';
    div.append(b, code);
    if (url.startsWith('http')) {
      const copy = document.createElement('button'); copy.className = 'copy'; copy.textContent = 'Copiar';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(url); copy.textContent = '¡Copiado!'; } catch (e) { copy.textContent = 'Copialo a mano'; } };
      div.append(copy);
    }
    if (note) { const n = document.createElement('span'); n.className = 'mut'; n.textContent = note; div.append(n); }
    return div;
  }
  // Links for one path; the host usually opens localhost, which nobody else can use.
  async function render(box, path) {
    let info = {};
    try { info = await fetch('/api/party').then(r => r.json()); } catch (e) {}
    box.textContent = '';
    for (const base of info.lanUrls || []) box.append(row('Misma red (WiFi/cable de tu casa):', base + path));
    if (info.publicUrl) box.append(row('Por Internet (celu o desde otra casa):', info.publicUrl + path));
    else box.append(row('Por Internet:', 'no disponible', 'El túnel no está abierto.'));
    return info;
  }
  // Styles of the bar: one line on a desktop, the parts wrap on a phone.
  const style = document.createElement('style');
  style.textContent = '.sh-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:13px;width:100%}'
    + '.sh-info{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;flex:1 1 280px;min-width:0}'
    + '.sh-lnk{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;max-width:100%}'
    + '.sh-lnk code{font:12px/1.4 Consolas,monospace;color:var(--txt);overflow-wrap:anywhere}'
    + '.sh-lnk button{padding:3px 10px;font-size:12px}'
    + '.sh-tag{color:var(--mut);font-size:12px}'
    + '.sh-who{color:var(--mut);white-space:nowrap}.sh-who.on{color:var(--ok)}'
    + '.sh-tog{display:flex;align-items:center;gap:8px;margin-left:auto;padding:2px 0;background:none;border:0;color:var(--mut);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}'
    + '.sh-tog[aria-checked="true"]{color:var(--txt)}'
    + '.sh-tog[hidden]{display:none}'
    + '.sh-tog:focus-visible{outline:2px solid var(--acc);outline-offset:3px;border-radius:6px}'
    + '.sh-track{position:relative;flex:none;width:34px;height:18px;border-radius:9px;background:#2a3050;border:1px solid var(--line);transition:background .15s}'
    + '.sh-track::after{content:"";position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:var(--mut);transition:transform .15s}'
    + '.sh-tog[aria-checked="true"] .sh-track{background:var(--acc);border-color:var(--acc)}'
    + '.sh-tog[aria-checked="true"] .sh-track::after{transform:translateX(16px);background:#08122b}'
    + '.sh-st{width:100%;color:var(--mut);font-size:12px}.sh-st.warn{color:var(--warn)}.sh-st:empty{display:none}'
    + '.sh-more{font-size:12px}.sh-more[open]{flex-basis:100%}.sh-more summary{cursor:pointer;color:var(--mut)}.sh-more .sh-lnk{margin-top:4px}';
  document.head.appendChild(style);
  // One address with its Copy button; the tag says what it is good for.
  function addr(url, tag) {
    const lnk = document.createElement('span'); lnk.className = 'sh-lnk';
    const code = document.createElement('code'); code.textContent = url; code.title = url;
    lnk.append(code);
    if (url.startsWith('http')) {
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy'; copy.textContent = 'Copiar';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(url); copy.textContent = '¡Copiado!'; } catch (e) { copy.textContent = 'Copialo a mano'; } setTimeout(() => { copy.textContent = 'Copiar'; }, 2000); };
      lnk.append(copy);
    }
    if (tag) { const t = document.createElement('span'); t.className = 'sh-tag'; t.textContent = tag; lnk.append(t); }
    return lnk;
  }
  // The bar: the link (the Internet one, else the home-network one), who is in, and the Internet switch.
  // The switch and its status stay in place, so a redraw never takes its focus or makes it blink; the link
  // and who is in are redrawn only when what they show changes.
  function banner(box) {
    let last = null, owner = null, busy = false, tunnel = { state: 'off' };
    const bar = document.createElement('div'); bar.className = 'sh-bar';
    const line = document.createElement('div'); line.className = 'sh-info';
    const tog = document.createElement('button'); tog.type = 'button'; tog.className = 'sh-tog'; tog.setAttribute('role', 'switch'); tog.hidden = true;
    const name = document.createElement('span'); name.textContent = '🌐 Internet';
    const track = document.createElement('span'); track.className = 'sh-track';
    tog.append(name, track);
    const st = document.createElement('div'); st.className = 'sh-st';
    // The other home-network addresses: folded away on the link line, so the bar stays one line.
    const more = document.createElement('details'); more.className = 'sh-more'; more.hidden = true;
    bar.append(line, tog, st);
    box.replaceChildren(bar);
    function paint() {
      tog.setAttribute('aria-checked', String(tunnel.state === 'on' || tunnel.state === 'starting'));
      tog.title = tunnel.state === 'starting' && tunnel.msg ? tunnel.msg : { off: 'Prendelo para que se pueda entrar desde Internet', starting: 'Abriendo túnel…', on: 'Encendido: se puede entrar desde Internet', error: 'No se pudo abrir el túnel' }[tunnel.state] || '';
      st.textContent = tunnel.state === 'starting' ? (tunnel.msg || 'Abriendo túnel…') : tunnel.state === 'error' ? 'No se pudo abrir el túnel' + (tunnel.error ? ': ' + tunnel.error : '') : '';
      st.classList.toggle('warn', tunnel.state === 'error');
    }
    // Only this PC gets the switch: a guest's page is answered with 403. null means not known yet.
    async function probe() {
      try { const r = await fetch('/api/tunnel', { headers: { 'X-RemoteGame': 'tunnel' } }); return r.status === 200 ? true : r.status === 403 ? false : null; }
      catch (e) { return null; }
    }
    tog.onclick = async () => {
      if (busy) return;
      busy = true;
      const turnOn = !(tunnel.state === 'on' || tunnel.state === 'starting');
      try {
        const r = await fetch('/api/tunnel', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RemoteGame': 'tunnel' }, body: JSON.stringify({ on: turnOn }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 403) { owner = false; tog.hidden = true; }
        else tunnel = r.ok ? j.tunnel : { state: 'error', error: j.msg || 'no pude cambiar el túnel' };
      } catch (e) { tunnel = { state: 'error', error: 'no hay conexión con RemoteGame' }; }
      busy = false;
      paint();
    };
    async function update() {
      let info;
      try { info = await fetch('/api/party').then(r => r.json()); } catch (e) { return; }
      if (owner === null) owner = await probe();
      tog.hidden = owner !== true;
      if (!busy) tunnel = info.tunnel || { state: 'off' };
      paint();
      const lan = info.lanUrls || [];
      const players = info.players || (info.guest ? [2] : []);
      const who_ = info.who || players.map(p => ({ player: p, label: '', pad: '' }));
      const key = JSON.stringify([info.publicUrl, lan, players, who_]);
      if (key === last) return;
      last = key;
      // The Internet link when the tunnel is up; without it, the home-network one takes its place.
      const first = info.publicUrl || lan[0] || '';
      let main;
      if (first) { main = addr(first, info.publicUrl ? '' : 'solo red de casa'); main.prepend('🔗 '); }
      else { main = document.createElement('span'); main.className = 'sh-lnk'; main.textContent = '🔗 sin dirección'; main.title = 'No encontré ninguna dirección de red de esta PC.'; }
      const who = document.createElement('span'); who.className = 'sh-who' + (players.length ? ' on' : '');
      // Who is who: "P2 (PC · Chrome, mando de Xbox)". Two players with the same device are two tabs or two devices of one friend.
      who.textContent = players.length
        ? '👥 ' + who_.map(w => 'P' + w.player + (w.label || w.pad ? ' (' + [w.label, w.pad].filter(Boolean).join(', ') + ')' : '')).join(' · ') + (players.length === 1 ? ' conectado' : ' conectados')
        : '👥 Nadie conectado';
      const rest = info.publicUrl ? lan : lan.slice(1);
      const sum = document.createElement('summary'); sum.textContent = 'otras direcciones';
      more.replaceChildren(sum, ...rest.map(u => addr(u, '')));
      more.hidden = rest.length === 0;
      line.replaceChildren(main, who, more);
    }
    update();
    setInterval(update, 2000);
  }
  root.RemoteShare = { render, banner };
})(globalThis);
