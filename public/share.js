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
    if (info.publicUrl) box.append(row('Por Internet (celu o desde otra casa):', info.publicUrl + path, 'ngrok puede mostrar un aviso la primera vez: tocar "Visit Site".'));
    else box.append(row('Por Internet:', 'no disponible', 'El túnel de ngrok no está abierto.'));
    return info;
  }
  // Compact link line for the banner: small label over the address, with its Copy button.
  const style = document.createElement('style');
  style.textContent = '.sh-link{margin-top:8px}.sh-link small{display:block;color:var(--mut)}.sh-link div{display:flex;gap:6px;align-items:center}'
    + '.sh-link code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/1.4 Consolas,monospace;color:var(--txt)}'
    + '.sh-link button{padding:4px 10px;font-size:12px}.sh-more{margin-top:6px}.sh-more summary{cursor:pointer;color:var(--mut)}'
    + '.sh-sw{margin-top:2px}.sh-tog{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:4px 0;background:none;border:0;color:var(--txt);font:inherit;font-weight:600;cursor:pointer;text-align:left}'
    + '.sh-tog:focus-visible{outline:2px solid var(--acc);outline-offset:3px;border-radius:6px}'
    + '.sh-track{position:relative;flex:none;width:40px;height:22px;border-radius:11px;background:#2a3050;border:1px solid var(--line);transition:background .15s}'
    + '.sh-track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--mut);transition:transform .15s}'
    + '.sh-tog[aria-checked="true"] .sh-track{background:var(--acc);border-color:var(--acc)}'
    + '.sh-tog[aria-checked="true"] .sh-track::after{transform:translateX(18px);background:#08122b}'
    + '.sh-st{display:block;color:var(--mut);font-size:12px;margin:2px 0 4px}.sh-st.warn{color:var(--warn)}';
  document.head.appendChild(style);
  function link(label, url, note) {
    const box = document.createElement('div'); box.className = 'sh-link';
    const small = document.createElement('small'); small.textContent = label; if (note) small.title = note;
    const line = document.createElement('div');
    const code = document.createElement('code'); code.textContent = url; code.title = url;
    line.append(code);
    if (url.startsWith('http')) {
      const copy = document.createElement('button'); copy.className = 'copy'; copy.textContent = 'Copiar';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(url); copy.textContent = '¡Copiado!'; } catch (e) { copy.textContent = 'Copialo a mano'; } setTimeout(() => { copy.textContent = 'Copiar'; }, 2000); };
      line.append(copy);
    }
    box.append(small, line);
    return box;
  }
  // Always-visible banner: the Internet switch, one link that never changes, and who is in (P2-P4).
  // The switch row is built once and stays in place, so a redraw never takes its focus or makes it blink;
  // only the links under it are redrawn, and only when what they show changes.
  // The Internet link comes first; the home-network ones fold away unless they are all there is.
  function banner(box) {
    let last = '', owner = null, busy = false, tunnel = { state: 'off' };
    const sw = document.createElement('div'); sw.className = 'sh-sw';
    const tog = document.createElement('button'); tog.type = 'button'; tog.className = 'sh-tog'; tog.setAttribute('role', 'switch');
    const name = document.createElement('span'); name.textContent = '🌐 Amigos por Internet';
    const track = document.createElement('span'); track.className = 'sh-track';
    tog.append(name, track);
    const st = document.createElement('small'); st.className = 'sh-st';
    sw.append(tog, st);
    function paint() {
      tog.setAttribute('aria-checked', String(tunnel.state === 'on' || tunnel.state === 'starting'));
      st.textContent = { off: 'Solo tu red de casa. Prendelo para que tus amigos entren desde Internet.', starting: 'Abriendo túnel…', on: 'Encendido: tus amigos pueden entrar desde Internet.', error: 'No se pudo abrir el túnel: ' + tunnel.error }[tunnel.state] || '';
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
        if (r.status === 403) { owner = false; sw.remove(); }
        else tunnel = r.ok ? j.tunnel : { state: 'error', error: j.msg || 'no pude cambiar el túnel' };
      } catch (e) { tunnel = { state: 'error', error: 'no hay conexión con RemoteGame' }; }
      busy = false;
      paint();
    };
    async function update() {
      let info;
      try { info = await fetch('/api/party').then(r => r.json()); } catch (e) { return; }
      if (owner === null) owner = await probe();
      if (owner && !sw.isConnected) box.replaceChildren(sw);
      if (!busy) tunnel = info.tunnel || { state: 'off' };
      paint();
      const key = JSON.stringify([info.publicUrl, info.lanUrls, info.players, tunnel, owner]);
      if (key === last) return;
      last = key;
      for (const node of [...box.childNodes]) if (node !== sw) node.remove();
      const state = document.createElement('div');
      const players = info.players || (info.guest ? [2] : []);
      state.innerHTML = players.length
        ? '<b class="ok">🟢 ' + (players.length === 1 ? '1 amigo conectado' : players.length + ' amigos conectados') + ' (' + players.map(p => 'P' + p).join(', ') + ')</b>'
        : '<b>⚪ Todavía no entró nadie.</b> Pasales el link: sirve para todos los juegos y hasta 3 amigos.';
      box.append(state);
      const lan = info.lanUrls || [];
      if (info.publicUrl) {
        box.append(link('Link para tus amigos (Internet)', info.publicUrl, 'ngrok puede mostrar un aviso la primera vez: tocar "Visit Site".'));
        if (lan.length) {
          const more = document.createElement('details'); more.className = 'sh-more';
          const sum = document.createElement('summary'); sum.textContent = 'Misma red';
          more.append(sum); for (const base of lan) more.append(link('WiFi o cable de tu casa', base));
          box.append(more);
        }
      } else {
        for (const base of lan) box.append(link('Link para tus amigos (misma red)', base));
        // The owner's switch says what is going on; a guest gets the plain status.
        if (!owner) box.append(link('Internet', 'sin túnel (ngrok no está abierto)', 'pnpm start lo abre y pnpm local no. Si recién arrancó, esperá unos segundos.'));
      }
    }
    update();
    setInterval(update, 2000);
  }
  root.RemoteShare = { render, banner };
})(globalThis);
