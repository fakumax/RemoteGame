// RemoteGame: the emulator's own audio on the stream page. The server captures just that process (audio-capture.js) and relays the PCM
// over /ws-audio (this PC only); here it becomes a MediaStreamTrack that is the room's audio track.
// ProcessAudio.open() -> { track, engine, stats(), close() }, or null (ProcessAudio.reason says why) when it is not available (no emulator
// started by RemoteGame, Windows too old, a browser without what it needs...): the caller then asks the screen capture for the system audio.
// Two ways to make the track, the first one that exists:
//   generator  MediaStreamTrackGenerator: each packet is written to the track as it arrives. No audio clock, no queue, ~30 ms less delay.
//   worklet    AudioWorklet (pcm-worklet.js) with a small ring buffer -> createMediaStreamDestination. Works wherever there is an AudioContext.
(function(root) {
  const nowMs = () => performance.timeOrigin + performance.now();
  // Skip a packet when this many are already waiting to be written: a stalled consumer must not turn into delay.
  const MAX_QUEUED = 4;

  // Writes each PCM packet straight into a MediaStreamTrackGenerator.
  function generatorEngine(hello, st) {
    const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
    const writer = gen.writable.getWriter();
    const rate = hello.rate || 48000, channels = hello.channels || 2, format = hello.float ? 'f32' : 's16';
    let stamp = 0;
    return {
      track: gen,
      push(buf) {
        if (writer.desiredSize !== null && writer.desiredSize < 1 - MAX_QUEUED) { st.skipped = (st.skipped || 0) + 1; return; }
        const pcm = hello.float ? new Float32Array(buf, 8) : new Int16Array(buf, 8);
        const frames = Math.floor(pcm.length / channels);
        const data = new AudioData({ format, sampleRate: rate, numberOfFrames: frames, numberOfChannels: channels, timestamp: stamp, data: pcm });
        stamp += frames * 1e6 / rate;
        writer.write(data).then(() => data.close(), () => data.close());
      },
      info: () => ({ queued: writer.desiredSize === null ? null : 1 - writer.desiredSize }),
      close() { try { writer.close(); } catch (e) {} try { gen.stop(); } catch (e) {} }
    };
  }

  // An AudioWorklet fed by postMessage plays the packets from a ring buffer; its AudioContext feeds a MediaStreamDestination.
  async function workletEngine(hello, st) {
    const ctx = new (root.AudioContext || root.webkitAudioContext)({ latencyHint: 'interactive', sampleRate: hello.rate || 48000 });
    try {
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: hello });
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2; dest.channelCountMode = 'explicit';
      node.connect(dest);
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      if (ctx.state !== 'running') throw new Error('el audio del navegador no arranca (' + ctx.state + ')');
      const track = dest.stream.getAudioTracks()[0];
      node.port.onmessage = ev => { st.worklet = ev.data; };
      return {
        track,
        push: buf => node.port.postMessage(buf, [buf]),
        info: () => ({ state: ctx.state, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency }),
        close() { try { track.stop(); } catch (e) {} try { ctx.close(); } catch (e) {} }
      };
    } catch (e) { try { ctx.close(); } catch (e2) {} throw e; }
  }

  // opts: { engine: 'generator' | 'worklet' (default: the first that exists), wait: ms to wait for the server's answer, onEnd() }
  async function open(opts = {}) {
    if (!root.WebSocket) { api.reason = 'el navegador no tiene WebSocket'; return null; }
    const wait = opts.wait ?? 12000;
    let ws;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws-audio'); } catch (e) { api.reason = e.message; return null; }
    ws.binaryType = 'arraybuffer';
    // The first message says whether the capture works (the server holds the answer while the helper starts).
    const hello = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), wait);
      ws.onmessage = ev => { clearTimeout(timer); try { resolve(typeof ev.data === 'string' ? JSON.parse(ev.data) : null); } catch (e) { resolve(null); } };
      ws.onerror = ws.onclose = () => { clearTimeout(timer); resolve(null); };
    });
    ws.onmessage = null;   // packets that arrive while the player is being built are dropped, not queued
    const fail = reason => { try { ws.close(); } catch (e) {} api.reason = reason; return null; };
    if (!hello || !hello.ok) return fail(hello && hello.reason || 'sin respuesta');
    const wanted = opts.engine || (typeof root.MediaStreamTrackGenerator === 'function' && typeof root.AudioData === 'function' ? 'generator' : 'worklet');
    const st = { frames: 0, lagMs: 0, lagMax: 0, lagAvg: 0, worklet: null, ended: false };
    let engine, name = wanted;
    try {
      if (wanted === 'generator') {
        try { engine = generatorEngine(hello, st); } catch (e) { name = 'worklet'; }
      }
      if (!engine) {
        if (!root.AudioWorkletNode) return fail('el navegador no tiene AudioWorklet');
        engine = await workletEngine(hello, st);
      }
    } catch (e) { return fail(e.message); }
    ws.onmessage = ev => {
      if (typeof ev.data === 'string' || !ev.data.byteLength) return;
      const lag = nowMs() - new DataView(ev.data).getFloat64(0, true);
      st.frames++; st.lagMs = lag; st.lagMax = Math.max(st.lagMax, lag); st.lagAvg += (lag - st.lagAvg) / Math.min(st.frames, 100);
      engine.push(ev.data);
    };
    ws.onclose = ws.onerror = () => { st.ended = true; if (opts.onEnd) opts.onEnd(); };
    return {
      track: engine.track, engine: name, hello,
      // lagAvg: ms from the first sample of a packet being captured to it reaching this page (the engine's own 10 ms, the helper, the server, the socket).
      stats: () => ({ ...st, engine: name, ...engine.info() }),
      close() { st.ended = true; ws.onclose = ws.onerror = null; try { ws.close(); } catch (e) {} engine.close(); }
    };
  }
  const api = { open, reason: null };
  if (typeof module !== 'undefined') module.exports = api; else root.ProcessAudio = api;
})(globalThis);
