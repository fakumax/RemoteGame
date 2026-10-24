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
    + '.sh-link button{padding:4px 10px;font-size:12px}.sh-more{margin-top:6px}.sh-more summary{cursor:pointer;color:var(--mut)}';
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
  // Always-visible banner: one link that never changes, and who is in (P2-P4).
  // The Internet link comes first; the home-network ones fold away unless they are all there is.
  function banner(box) {
    let last = '';
    async function update() {
      let info;
      try { info = await fetch('/api/party').then(r => r.json()); } catch (e) { return; }
      const key = JSON.stringify([info.publicUrl, info.lanUrls, info.players]);
      if (key === last) return;
      last = key;
      box.textContent = '';
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
        box.append(link('Internet', 'sin túnel (ngrok no está abierto)', 'pnpm start lo abre y pnpm local no. Si recién arrancó, esperá unos segundos.'));
      }
    }
    update();
    setInterval(update, 2000);
  }
  root.RemoteShare = { render, banner };
})(globalThis);
