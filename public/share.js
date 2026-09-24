// RemoteGame: renders the invite links (home network and Internet) for a room.
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
  // The host usually opens localhost, a link nobody else can use: build real ones.
  async function render(box, path) {
    let info = {};
    try { info = await fetch('/api/info').then(r => r.json()); } catch (e) {}
    box.textContent = '';
    const here = location.hostname;
    const isLocal = here === 'localhost' || here === '127.0.0.1' || here === '[::1]';
    const lan = (info.lanUrls || []).filter(Boolean);
    if (!isLocal && !lan.some(u => u.includes(location.host))) lan.unshift(location.origin);
    for (const base of lan) box.append(row('Misma red (WiFi/cable de tu casa):', base + path));
    if (info.publicUrl) box.append(row('Por Internet (celu o desde otra casa):', info.publicUrl + path, 'ngrok puede mostrar un aviso la primera vez: tocar "Visit Site".'));
    else box.append(row('Por Internet:', 'no disponible', 'Cerrá el servidor y abrilo con "npm run share" para tener link por Internet.'));
  }
  root.RemoteShare = { render };
})(globalThis);
