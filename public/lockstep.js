// Bounded lockstep: stop sampling while stalled, never replay an old input backlog.
(function(root) {
  class Lockstep {
    constructor(delay = 2) { this.reset(delay); }
    reset(delay = 2) {
      this.delay = Math.max(1, Math.min(6, delay | 0));
      this.frame = 0;
      this.next = this.delay;
      this.local = new Map();
      this.remote = new Map();
      for (let i = 0; i < this.delay; i++) { this.local.set(i, 0); this.remote.set(i, 0); }
    }
    receive(frame, pad) {
      if (!Number.isInteger(frame) || frame < this.frame || frame > this.frame + 120 || !Number.isInteger(pad) || pad < 0 || pad > 255) return false;
      this.remote.set(frame, pad);
      return true;
    }
    tick(pad, send, emulate) {
      if (this.next <= this.frame + this.delay) {
        this.local.set(this.next, pad);
        send(this.next, pad);
        this.next++;
      }
      if (!this.local.has(this.frame) || !this.remote.has(this.frame)) return false;
      emulate(this.local.get(this.frame), this.remote.get(this.frame));
      this.local.delete(this.frame);
      this.remote.delete(this.frame);
      this.frame++;
      return true;
    }
  }
  if (typeof module !== 'undefined') module.exports = Lockstep;
  else root.RemoteLockstep = Lockstep;
})(globalThis);
