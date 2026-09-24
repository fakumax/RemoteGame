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
  // Always-visible banner: one link that never changes, and live guest status.
  function banner(box) {
    let last = '';
    async function update() {
      let info;
      try { info = await fetch('/api/party').then(r => r.json()); } catch (e) { return; }
      const key = JSON.stringify([info.publicUrl, info.lanUrls, info.guest]);
      if (key === last) return;
      last = key;
      box.textContent = '';
      const state = document.createElement('div');
      state.innerHTML = info.guest
        ? '<b class="ok">🟢 Tu amigo está conectado.</b> Ve el juego que abras y juega como P2.'
        : '<b>⚪ Tu amigo todavía no entró.</b> Pasale el link una sola vez: sirve para todos los juegos.';
      box.append(state);
      if (info.publicUrl) box.append(row('Link para tu amigo:', info.publicUrl));
      else box.append(row('Link para tu amigo:', 'abriendo túnel…', 'Si no aparece, revisá la consola del servidor (ngrok).'));
      for (const base of info.lanUrls || []) box.append(row('En tu misma red:', base));
    }
    update();
    setInterval(update, 2000);
  }
  root.RemoteShare = { render, banner };
})(globalThis);
