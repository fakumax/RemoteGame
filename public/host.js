// RemoteGame: the host side of the party, shared by play-ejs (an emulator in this tab) and stream
// (a native emulator captured from the screen). It owns the connection to the server, one WebRTC call
// per guest (P2-P4 = seats 0-2), their controls, ping and fps. What differs is passed in:
//   hello          first message to the server, e.g. { t: 'host', system, rom, core } or { t: 'host', mode: 'stream', name }
//   els            { status, peers, pingBox, links }: elements to write to (all optional)
//   getTracks()    -> { video, audio, scale, maxBitrate, codec } to send to every guest (read again on setTracks())
//   onPad(seat, state, prev)   a guest's controls changed: state = { b, x, y, rx, ry }
//   onRelease(seat, prev)      that guest left or dropped: let go of everything it held
//   onStatus(text), onHosting(msg), hostingNote, replacedText: page texts and hooks
//   diagLog(line)  where the diagnosis lines go (default: POST /api/diag, which writes cache/remotegame.log)
// Besides, it tells the page (document events) what a guest presses: 'rg-pad' {seat, state}, 'rg-release' {seat}, 'rg-seats' {seats}.
(function(root) {
  const label = seat => 'P' + (seat + 2), names = seats => seats.map(label).join(', ');
  const clamp = v => Math.max(-127, Math.min(127, v | 0));

  // A guest's "pad" message as a state, or null when it is not one or is older than the last seen.
  // rx/ry are optional (older guests and games without a right stick do not send them).
  function parsePad(m, lastSeq) {
    if (!m || m.t !== 'pad' || !Number.isInteger(m.s) || m.s <= lastSeq) return null;
    return { b: (m.b | 0) & 0xffff, x: clamp(m.x), y: clamp(m.y), rx: clamp(m.rx), ry: clamp(m.ry) };
  }
  // A guest's "freeze" report with only finite numbers kept (it crosses the network: nothing in it is trusted), or null.
  function parseFreeze(m) {
    if (!m || m.t !== 'freeze' || !Number.isInteger(m.fc) || m.fc < 1) return null;
    const n = v => typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1e7, Math.round(v))) : null;
    return { fc: m.fc, ms: n(m.ms) ?? 0, lost: n(m.lost) ?? 0, jit: n(m.jit), rtt: n(m.rtt), fps: n(m.fps), drop: n(m.drop) ?? 0, jb: n(m.jb) };
  }

  async function start(o) {
    const noop = () => {};
    const els = o.els || {}, getTracks = o.getTracks || (() => ({})), onPad = o.onPad || noop, onRelease = o.onRelease || noop;
    const guests = new Map(); // seat -> { rtc, lastSeq, remote, open, active, ms, fps, sent, freezeSeen, dh, dprev, limit }
    let ws = null, replaced = false, note = '', hello = o.hello, retry = null, everOpened = false;
    const ping = els.pingBox ? RemoteHUD.ping(els.pingBox) : { set: noop, hide: noop };
    if (els.links) RemoteShare.banner(els.links);
    const iceServers = await fetch('/api/ice').then(r => r.json()).catch(() => undefined);
    const emit = (name, detail) => {
      try { if (typeof document !== 'undefined' && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* no page */ }
    };
    const seatsNow = () => [...guests.entries()].filter(([, g]) => g.open).map(([seat]) => seat).sort();
    // Diagnosis lines (freezes, encoder limits): one POST each, to the server's log. Never blocks anything.
    const diagLog = o.diagLog || (line => {
      try { fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RemoteGame': 'diag' }, body: JSON.stringify({ line }) }).catch(noop); } catch (e) { /* no network */ }
    });
    const Diag = root.RemoteDiag;

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
      emit('rg-seats', { seats: seatsNow() });
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

    // Tells the guest what arrived: the last pad sequence number and the last freeze report seen. The guest shows "your controls arrive"
    // from it, and rebuilds the call when it stops coming. Straight over the channel, no server in between.
    const ack = g => g.open && g.rtc.send({ t: 'ack', s: g.lastSeq, f: g.freezeSeen });

    // The encoder's side of each call (every 2 s, from its own connection's stats): a change of the quality limit and the first
    // reading of the encoder go to the log; the latest reading goes with a guest's freeze report.
    function diagHost(seat, g, report) {
      if (!Diag) return;
      const cur = Diag.hostSample(report), now = performance.now();
      if (!cur) return;
      if (!g.dprev) { g.dprev = { at: now, s: cur }; g.limit = cur.limit; diagLog(Diag.encoderLine(seat + 2, cur)); return; }
      if (now - g.dprev.at < 1900) return;
      g.dh = Diag.hostDelta(g.dprev.s, cur);
      g.dprev = { at: now, s: cur };
      if (cur.limit !== g.limit) { diagLog(Diag.limitLine(seat + 2, g.limit, g.dh)); g.limit = cur.limit; }
    }
    // Video frames sent to each guest in the last second, from its own connection's stats.
    const statsTimer = setInterval(() => {
      for (const [seat, g] of guests) {
        if (!g.open || !g.rtc.pc) continue;
        ack(g);
        g.rtc.pc.getStats().then(report => {
          report.forEach(r => {
            if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
            const now = performance.now();
            if (g.sent) g.fps = (r.framesSent - g.sent.n) * 1000 / (now - g.sent.t);
            g.sent = { n: r.framesSent, t: now };
          });
          diagHost(seat, g, report);
          drawPeers();
        }).catch(() => {});
      }
    }, 1000);

    const wsSend = obj => {
      if (obj && obj.t === 'host') hello = obj;   // a reconnect opens the room as it was last asked
      // caps: this host confirms what it receives (see ack), so a guest may rely on that to notice a dead link.
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj && obj.t === 'host' ? Object.assign({ caps: ['ack'] }, obj) : obj));
    };
    // Lets go of what the guest held (only if it ever sent anything).
    const release = (seat, g) => {
      if (!g.active) return;
      const prev = g.remote;
      g.remote = RemotePads.EMPTY; g.active = false;
      onRelease(seat, prev);
      emit('rg-release', { seat });
    };
    function closeGuest(seat) {
      const g = guests.get(seat);
      if (!g) return;
      g.rtc.close(); release(seat, g); guests.delete(seat); ping.hide(label(seat));
    }

    function startRtc(seat) {
      closeGuest(seat);
      const g = { rtc: null, lastSeq: -1, remote: RemotePads.EMPTY, open: false, active: false, ms: null, fps: null, sent: null, freezeSeen: 0, dh: null, dprev: null, limit: 'none' };
      guests.set(seat, g);
      g.rtc = new RemoteWebRTC({
        isHost: true, media: true, iceServers, codec: (getTracks() || {}).codec,
        sendSignal: data => wsSend({ t: 'signal', to: seat, data }),
        onOpen: () => { g.open = true; ack(g); refresh(''); },
        onClose: () => { g.open = false; release(seat, g); ping.hide(label(seat)); drawPeers(); emit('rg-seats', { seats: seatsNow() }); },
        onPing: rtt => { g.ms = rtt; ping.set(rtt, label(seat)); drawPeers(); },
        // Straight from the channel's event to the callback: nothing here waits for a timer.
        onMessage: m => {
          const fz = parseFreeze(m);
          if (fz) {
            if (fz.fc > g.freezeSeen) { g.freezeSeen = fz.fc; if (Diag) diagLog(Diag.freezeLine(seat + 2, fz, g.dh)); }
            ack(g);
            return;
          }
          const next = parsePad(m, g.lastSeq);
          if (!next) return;
          const first = g.lastSeq < 0;
          g.lastSeq = m.s;
          const prev = g.remote;
          g.remote = next; g.active = true;
          if (first) ack(g);   // the guest hears "your controls arrive" at once, not at the next tick
          onPad(seat, next, prev);
          emit('rg-pad', { seat, state: next });
        }
      });
      g.rtc.start().then(() => apply(g.rtc));
    }

    function onSocketMessage(ev) {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hosting') { if (o.onHosting) o.onHosting(m); refresh(o.hostingNote || ''); }
      else if (m.t === 'peer' && Number.isInteger(m.slot)) { note = ''; startRtc(m.slot); refresh(); }
      else if (m.t === 'signal') { const g = guests.get(m.from); g && g.rtc.handleSignal(m.data); }
      else if (m.t === 'peer-left' && Number.isInteger(m.slot)) { closeGuest(m.slot); refresh(label(m.slot) + ' salió. Puede volver con el mismo link.'); }
      else if (m.t === 'replaced') { replaced = true; clearInterval(statsTimer); for (const seat of [...guests.keys()]) closeGuest(seat); setStatus(o.replacedText || 'Abriste otra pestaña como anfitriona. Cerrá esta.'); drawPeers(); }
      else if (m.t === 'error') { setStatus('❌ ' + m.msg); }
    }
    // The socket to the server. If it drops after having worked, it is opened again and the room is announced again (the guests were
    // told the host left; they come back by themselves), instead of asking for a reload.
    function openSocket(resolve, reject) {
      const sock = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');
      ws = sock;
      sock.onopen = () => { everOpened = true; wsSend(hello); if (resolve) resolve(); };
      sock.onerror = () => { if (!everOpened && reject) reject(new Error('No se pudo conectar con el servidor.')); };
      sock.onclose = () => {
        if (ws !== sock || replaced) return;
        if (!everOpened) return;
        for (const seat of [...guests.keys()]) closeGuest(seat);
        setStatus('⚠️ Se perdió la conexión con el servidor. Reconectando…');
        retry = setTimeout(() => openSocket(), 1500);
      };
      sock.onmessage = onSocketMessage;
    }
    // One permanent room: opening this game makes it the one the guests see.
    await new Promise((resolve, reject) => openSocket(resolve, reject));
    return {
      guests, setTracks, refresh, send: wsSend, label,
      // Hangs up on everyone and leaves the room.
      close() { replaced = true; clearInterval(statsTimer); clearTimeout(retry); for (const seat of [...guests.keys()]) closeGuest(seat); try { ws.close(); } catch (e) {} }
    };
  }

  const api = { start, parsePad, parseFreeze };
  if (typeof module !== 'undefined') module.exports = api;
  else root.RemoteHost = api;
})(globalThis);
