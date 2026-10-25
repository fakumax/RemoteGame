// RemoteGame: plays the emulator's PCM (from /ws-audio, see process-audio.js) with a small ring buffer that never piles up delay.
// Messages in: an ArrayBuffer { f64 capture time, then interleaved PCM }. Out: stats every STAT_S seconds.
// Playing starts once PRIME ms are queued. The device pulls in bursts of ~10 ms while the capture delivers a packet every 10 ms, so a
// little always stays queued; what is queued above that is delay, and goes: if more than MAX ms are queued the oldest is dropped down to
// TARGET, and every STAT_S seconds the part that never dipped below KEEP ms is trimmed (a late burst does not stay in the pipe for good).
// If it runs dry it plays what is left, then silence, and primes again (the capture sends nothing while the game is silent).
const PRIME_MS = 15, TARGET_MS = 20, MAX_MS = 50, KEEP_MS = 12, CAP = 16384, STAT_S = 0.1;
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const f = options.processorOptions || {};
    this.ch = f.channels || 2; this.float = !!f.float;
    this.rate = f.rate || sampleRate;
    this.ring = [new Float32Array(CAP), new Float32Array(CAP)];
    this.w = 0; this.r = 0;   // absolute frame counters
    this.primed = false; this.drops = 0; this.trims = 0; this.underruns = 0; this.lastStat = currentTime;
    const ms = v => Math.round(v * this.rate / 1000);
    this.prime = ms(PRIME_MS); this.target = ms(TARGET_MS); this.max = ms(MAX_MS); this.keep = ms(KEEP_MS);
    this.fillSum = 0; this.fillN = 0; this.fillMin = Infinity; this.fillMax = 0;
    this.port.onmessage = ev => this.push(ev.data);
  }
  push(buf) {
    const bytes = this.float ? 4 : 2, frames = Math.floor((buf.byteLength - 8) / (bytes * this.ch));
    const pcm = this.float ? new Float32Array(buf, 8, frames * this.ch) : new Int16Array(buf, 8, frames * this.ch);
    const k = this.float ? 1 : 1 / 32768, two = this.ch > 1;
    for (let i = 0; i < frames; i++) {
      const p = (this.w + i) & (CAP - 1);
      this.ring[0][p] = pcm[i * this.ch] * k;
      this.ring[1][p] = pcm[i * this.ch + (two ? 1 : 0)] * k;
    }
    this.w += frames;
    if (this.w - this.r > this.max) { this.drops += this.w - this.r - this.target; this.r = this.w - this.target; }
  }
  process(inputs, outputs) {
    const out = outputs[0], n = out[0].length;
    let fill = this.w - this.r;
    if (!this.primed && fill >= this.prime) { this.primed = true; this.fillMin = Infinity; }
    if (this.primed) {
      const k = Math.min(n, fill);   // short of a quantum: what is left plays, the rest stays silent
      for (let i = 0; i < k; i++) {
        const p = (this.r + i) & (CAP - 1);
        out[0][i] = this.ring[0][p]; if (out[1]) out[1][i] = this.ring[1][p];
      }
      this.r += k;
      fill -= k;   // what is left after this quantum is what the next one has to live on
      if (k < n) { this.primed = false; this.underruns++; }
      else { this.fillSum += fill; this.fillN++; if (fill > this.fillMax) this.fillMax = fill; if (fill < this.fillMin) this.fillMin = fill; }
    }
    if (currentTime - this.lastStat >= STAT_S) {
      this.lastStat = currentTime;
      if (this.primed && this.fillMin > this.keep) { const cut = this.fillMin - Math.round(this.keep / 2); this.r += cut; this.trims += cut; }
      const toMs = v => v * 1000 / this.rate;
      this.port.postMessage({ fillMs: toMs(this.w - this.r), avgMs: this.fillN ? toMs(this.fillSum / this.fillN) : 0, minMs: this.fillMin === Infinity ? 0 : toMs(this.fillMin), maxMs: toMs(this.fillMax), drops: this.drops, trims: this.trims, underruns: this.underruns, primed: this.primed });
      this.fillSum = 0; this.fillN = 0; this.fillMin = Infinity; this.fillMax = 0;
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
