// RemoteGame: what to read from WebRTC stats to tell why a guest's video stuttered, and how it is written in cache/remotegame.log.
// The guest reads its side (freezes, loss, jitter, rtt); the host reads its own (encoder, quality limit, source fps); the host
// joins both in one line. Pure functions over an RTCStatsReport (or any Map-like), so they are tested without a browser.
(function(root) {
  const num = v => typeof v === 'number' && isFinite(v) ? v : null;
  const diff = (a, b) => a == null || b == null ? null : Math.max(0, a - b);
  const ms = (sec, digits = 0) => sec == null ? null : +(sec * 1000).toFixed(digits);

  // Walks the report once: the video entry of the kind asked, and the selected network path.
  function scan(report) {
    const out = { inbound: null, outbound: null, pair: null, source: null, codecs: {} };
    if (!report || typeof report.forEach !== 'function') return out;
    report.forEach(s => {
      if (!s) return;
      if (s.type === 'inbound-rtp' && s.kind === 'video') out.inbound = s;
      else if (s.type === 'outbound-rtp' && s.kind === 'video') out.outbound = s;
      else if (s.type === 'media-source' && s.kind === 'video') out.source = s;
      else if (s.type === 'codec') out.codecs[s.id] = s.mimeType;
      else if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || !out.pair)) out.pair = s;
    });
    return out;
  }

  // Guest: the numbers of the incoming video (cumulative counters, kept to compare with the next reading).
  function guestSample(report) {
    const r = scan(report), v = r.inbound;
    if (!v) return null;
    return {
      freezeCount: num(v.freezeCount) ?? 0, freezeSec: num(v.totalFreezesDuration) ?? 0,
      lost: num(v.packetsLost) ?? 0, jitter: num(v.jitter), dropped: num(v.framesDropped) ?? 0, fps: num(v.framesPerSecond),
      jbDelay: num(v.jitterBufferDelay), jbCount: num(v.jitterBufferEmittedCount), rtt: r.pair ? num(r.pair.currentRoundTripTime) : null
    };
  }
  // A freeze that happened between two readings, or null. ms: how long it lasted; lost/dropped: what went missing meanwhile.
  function guestFreeze(prev, cur) {
    if (!prev || !cur || cur.freezeCount <= prev.freezeCount) return null;
    const jb = diff(cur.jbDelay, prev.jbDelay), n = diff(cur.jbCount, prev.jbCount);
    return {
      fc: cur.freezeCount, ms: Math.round((cur.freezeSec - prev.freezeSec) * 1000), lost: diff(cur.lost, prev.lost) ?? 0,
      jit: ms(cur.jitter), rtt: ms(cur.rtt), fps: cur.fps == null ? null : Math.round(cur.fps),
      drop: diff(cur.dropped, prev.dropped) ?? 0, jb: jb != null && n ? Math.round(jb / n * 1000) : null
    };
  }

  // Host: the encoder side of one guest's outgoing video.
  function hostSample(report) {
    const r = scan(report), o = r.outbound;
    if (!o) return null;
    return {
      enc: o.encoderImplementation || '', limit: o.qualityLimitationReason || 'none', codec: (r.codecs[o.codecId] || '').replace(/^video\//, ''),
      frames: num(o.framesEncoded) ?? 0, encSec: num(o.totalEncodeTime) ?? 0, nack: num(o.nackCount) ?? 0, pli: num(o.pliCount) ?? 0,
      retx: num(o.retransmittedPacketsSent) ?? 0, fps: num(o.framesPerSecond), src: r.source ? num(r.source.framesPerSecond) : null,
      size: o.frameWidth && o.frameHeight ? o.frameWidth + 'x' + o.frameHeight : ''
    };
  }
  // What changed since the previous reading: average encode time per frame, and counters as increments.
  function hostDelta(prev, cur) {
    if (!cur) return null;
    const frames = prev ? diff(cur.frames, prev.frames) : null;
    return {
      enc: cur.enc, limit: cur.limit, codec: cur.codec, size: cur.size,
      encMs: frames ? +((cur.encSec - prev.encSec) / frames * 1000).toFixed(1) : null,
      fps: cur.fps == null ? null : Math.round(cur.fps), src: cur.src == null ? null : Math.round(cur.src),
      nack: prev ? diff(cur.nack, prev.nack) : 0, pli: prev ? diff(cur.pli, prev.pli) : 0, retx: prev ? diff(cur.retx, prev.retx) : 0
    };
  }

  const encText = h => h && h.enc ? 'enc ' + h.enc.replace(/VideoEncodeAccelerator$|Encoder$/i, '') + (h.encMs != null ? ' ' + h.encMs + 'ms' : '') : '';
  const extras = h => h ? [h.src != null ? 'src ' + h.src + 'fps' : '', encText(h), h.nack ? 'nack ' + h.nack : '', h.pli ? 'pli ' + h.pli : '', h.retx ? 'retx ' + h.retx : ''].filter(Boolean) : [];
  // "freeze P2 320ms · lost 14 · jitter 22ms · rtt 48ms · fps 41 · src 58fps · enc MediaFoundation 9.1ms · limit none"
  function freezeLine(player, f, h) {
    const parts = ['freeze P' + player + ' ' + (f.ms | 0) + 'ms', 'lost ' + (f.lost | 0)];
    if (f.jit != null) parts.push('jitter ' + f.jit + 'ms');
    if (f.rtt != null) parts.push('rtt ' + f.rtt + 'ms');
    if (f.fps != null) parts.push('fps ' + f.fps);
    if (f.drop) parts.push('drop ' + f.drop);
    if (f.jb != null) parts.push('jbuf ' + f.jb + 'ms');
    parts.push(...extras(h));
    parts.push('limit ' + (h ? h.limit : '?'));
    return parts.join(' · ');
  }
  // "limit P2 none -> cpu · enc MediaFoundation 11.2ms · fps 41"
  function limitLine(player, from, h) {
    return ['limit P' + player + ' ' + from + ' -> ' + h.limit, ...extras(h).filter(p => !/^(nack|pli|retx)/.test(p)), h.fps != null ? 'fps ' + h.fps : ''].filter(Boolean).join(' · ');
  }
  // "enc P2 MediaFoundation · h264 · 1920x1080"
  function encoderLine(player, h) {
    return 'enc P' + player + ' ' + [h.enc.replace(/VideoEncodeAccelerator$|Encoder$/i, '') || '?', h.codec, h.size].filter(Boolean).join(' · ');
  }

  const api = { scan, guestSample, guestFreeze, hostSample, hostDelta, freezeLine, limitLine, encoderLine };
  if (typeof module !== 'undefined') module.exports = api;
  else root.RemoteDiag = api;
})(globalThis);
