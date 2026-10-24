// RemoteGame: the host side of the party, shared by play-ejs (an emulator in this tab) and stream
// (a native emulator captured from the screen). It owns the connection to the server, one WebRTC call
// per guest (P2-P4 = seats 0-2), their controls, ping and fps. What differs is passed in:
//   hello          first message to the server, e.g. { t: 'host', system, rom, core } or { t: 'host', mode: 'stream', name }
//   els            { status, peers, pingBox, links }: elements to write to (all optional)
//   getTracks()    -> { video, audio, scale, maxBitrate, codec } to send to every guest (read again on setTracks())
//   onPad(seat, state, prev)   a guest's controls changed: state = { b, x, y, rx, ry }
//   onRelease(seat, prev)      that guest left or dropped: let go of everything it held
//   onStatus(text), onHosting(msg), hostingNote, replacedText: page texts and hooks
(function(root) {
  const label = seat => 'P' + (seat + 2), names = seats => seats.map(label).join(', ');
  const clamp = v => Math.max(-127, Math.min(127, v | 0));

  // A guest's "pad" message as a state, or null when it is not one or is older than the last seen.
  // rx/ry are optional (older guests and games without a right stick do not send them).
  function parsePad(m, lastSeq) {
    if (!m || m.t !== 'pad' || !Number.isInteger(m.s) || m.s <= lastSeq) return null;
    return { b: (m.b | 0) & 0xffff, x: clamp(m.x), y: clamp(m.y), rx: clamp(m.rx), ry: clamp(m.ry) };
  }

  async function start(o) {
    const noop = () => {};
    const els = o.els || {}, getTracks = o.getTracks || (() => ({})), onPad = o.onPad || noop, onRelease = o.onRelease || noop;
    const guests = new Map(); // seat -> { rtc, lastSeq, remote, open, active, ms, fps, sent }
    let ws = null, replaced = false, note = '';
    const ping = els.pingBox ? RemoteHUD.ping(els.pingBox) : { set: noop, hide: noop };
    if (els.links) RemoteShare.banner(els.links);
    const iceServers = await fetch('/api/ice').then(r => r.json()).catch(() => undefined);

    function setStatus(text) {
      if (els.status) els.status.textContent = text;
      if (o.onStatus) o.onStatus(text);
    }
    // The same video and audio tracks feed every guest's connection (each one encodes on its own).
    const apply = rtc => { const t = getTracks() || {}; return rtc.setTracks(t.video, t.audio, { scale: t.scale, maxBitrate: t.maxBitrate, codec: t.codec }); };
    const setTracks = () => { for (const g of guests.values()) apply(g.rtc); };

    // What the host sees: who is still connecting and the last thing that happened (who is in, with
    // their ping and fps, is the list above; the banner counts them).
    function refresh(next) {
      if (next !== undefined) note = next;
      const wait = [...guests.keys()].sort().filter(s => !guests.get(s).open);
      const lines = [];
      if (note) lines.push(note);
      if (wait.length) lines.push(names(wait) + (wait.length > 1 ? ' entraron' : ' entró') + ', conectando video…');
      setStatus(lines.join('\n'));
      drawPeers();
    }
    // One row per connected guest: ping (coloured by quality) and the fps that reaches them.
    function drawPeers() {
      const box = els.peers;
      if (!box) return;
      box.textContent = '';
      for (const seat of [...guests.keys()].sort()) {
        const g = guests.get(seat);
        if (!g.open) continue;
        const row = document.createElement('div'); row.className = 'peer';
        const who = document.createElement('b'); who.textContent = label(seat);
        const ms = document.createElement('span'); ms.textContent = g.ms == null ? '… ms' : Math.round(g.ms) + ' ms'; if (g.ms != null) ms.className = RemoteHUD.quality(g.ms);
        const fps = document.createElement('span'); fps.className = 'mut'; fps.title = 'Cuadros por segundo que le llegan'; fps.textContent = g.fps == null ? '… fps' : Math.round(g.fps) + ' fps';
        row.append(who, ms, fps); box.append(row);
      }
    }
    // Video frames sent to each guest in the last second, from its own connection's stats.
    const statsTimer = setInterval(() => {
      for (const g of guests.values()) {
        if (!g.open || !g.rtc.pc) continue;
        g.rtc.pc.getStats().then(report => {
          report.forEach(r => {
            if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
            const now = performance.now();
            if (g.sent) g.fps = (r.framesSent - g.sent.n) * 1000 / (now - g.sent.t);
            g.sent = { n: r.framesSent, t: now };
          });
          drawPeers();
        }).catch(() => {});
      }
    }, 1000);

    const wsSend = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    // Lets go of what the guest held (only if it ever sent anything).
    const release = (seat, g) => {
      if (!g.active) return;
      const prev = g.remote;
      g.remote = RemotePads.EMPTY; g.active = false;
      onRelease(seat, prev);
    };
    function closeGuest(seat) {
      const g = guests.get(seat);
      if (!g) return;
      g.rtc.close(); release(seat, g); guests.delete(seat); ping.hide(label(seat));
    }

    function startRtc(seat) {
      closeGuest(seat);
      const g = { rtc: null, lastSeq: -1, remote: RemotePads.EMPTY, open: false, active: false, ms: null, fps: null, sent: null };
      guests.set(seat, g);
      g.rtc = new RemoteWebRTC({
        isHost: true, media: true, iceServers, codec: (getTracks() || {}).codec,
        sendSignal: data => wsSend({ t: 'signal', to: seat, data }),
        onOpen: () => { g.open = true; refresh(''); },
        onClose: () => { g.open = false; release(seat, g); ping.hide(label(seat)); drawPeers(); },
        onPing: rtt => { g.ms = rtt; ping.set(rtt, label(seat)); drawPeers(); },
        // Straight from the channel's event to the callback: nothing here waits for a timer.
        onMessage: m => {
          const next = parsePad(m, g.lastSeq);
          if (!next) return;
          g.lastSeq = m.s;
          const prev = g.remote;
          g.remote = next; g.active = true;
          onPad(seat, next, prev);
        }
      });
      g.rtc.start().then(() => apply(g.rtc));
    }

    await new Promise((resolve, reject) => {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');
      // One permanent room: opening this game makes it the one the guests see.
      ws.onopen = () => { wsSend(o.hello); resolve(); };
      ws.onerror = () => reject(new Error('No se pudo conectar con el servidor.'));
      ws.onclose = () => { clearInterval(statsTimer); if (!replaced) setStatus('⚠️ Se perdió la conexión con el servidor. Recargá la página.'); };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'hosting') { if (o.onHosting) o.onHosting(m); refresh(o.hostingNote || ''); }
        else if (m.t === 'peer' && Number.isInteger(m.slot)) { note = ''; startRtc(m.slot); refresh(); }
        else if (m.t === 'signal') { const g = guests.get(m.from); g && g.rtc.handleSignal(m.data); }
        else if (m.t === 'peer-left' && Number.isInteger(m.slot)) { closeGuest(m.slot); refresh(label(m.slot) + ' salió. Puede volver con el mismo link.'); }
        else if (m.t === 'replaced') { replaced = true; for (const seat of [...guests.keys()]) closeGuest(seat); setStatus(o.replacedText || 'Abriste otra pestaña como anfitriona. Cerrá esta.'); }
        else if (m.t === 'error') { setStatus('❌ ' + m.msg); }
      };
    });
    return {
      guests, setTracks, refresh, send: wsSend, label,
      // Hangs up on everyone and leaves the room.
      close() { replaced = true; clearInterval(statsTimer); for (const seat of [...guests.keys()]) closeGuest(seat); try { ws.close(); } catch (e) {} }
    };
  }

  const api = { start, parsePad };
  if (typeof module !== 'undefined') module.exports = api;
  else root.RemoteHost = api;
})(globalThis);
