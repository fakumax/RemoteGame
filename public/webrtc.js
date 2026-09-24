// RemoteGame: WebRTC DataChannel (UDP P2P) para netplay de baja latencia
(function(root) {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  // Receive-side buffering is the main extra delay of a stream; ask for none.
  function lowLatencyReceiver(receiver) {
    try { receiver.jitterBufferTarget = 0; } catch (e) {}
    try { receiver.playoutDelayHint = 0; } catch (e) {}
  }

  class RemoteWebRTC {
    constructor(options = {}) {
      this.isHost = !!options.isHost;
      this.sendSignal = typeof options.sendSignal === 'function' ? options.sendSignal : () => {};
      this.onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {};
      this.onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
      this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
      this.onPing = typeof options.onPing === 'function' ? options.onPing : () => {};
      this.onTrack = typeof options.onTrack === 'function' ? options.onTrack : () => {};
      // Host streaming: send-only video/audio transceivers whose tracks are swapped in later.
      this.media = !!options.media;
      this.iceServers = options.iceServers || ICE_SERVERS;
      this.videoSender = null;
      this.audioSender = null;

      this.pc = null;
      this.dc = null;
      this.pendingCandidates = [];
      this.closed = false;
      this.pingInterval = null;
    }

    isOpen() {
      return !!(this.dc && this.dc.readyState === 'open');
    }

    hookChannel(channel) {
      this.dc = channel;
      this.dc.binaryType = 'arraybuffer';

      let opened = false;
      this.dc.onopen = () => {
        if (this.closed || opened) return;
        opened = true;
        this.onOpen();
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => this.ping(), 2000);
      };
      // The answerer can receive the channel already open, and then 'open' never fires.
      if (channel.readyState === 'open') Promise.resolve().then(() => this.dc === channel && this.dc.onopen());

      this.dc.onclose = () => {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        this.onClose();
      };

      this.dc.onerror = () => {
        // Fallback or retry handles recovery
      };

      this.dc.onmessage = (event) => {
        if (!event.data) return;
        let msg;
        if (typeof event.data === 'string') {
          try { msg = JSON.parse(event.data); } catch { return; }
        } else {
          msg = event.data;
        }

        if (msg && typeof msg === 'object') {
          if (msg.t === '__ping__') {
            this.send({ t: '__pong__', ts: msg.ts });
            return;
          }
          if (msg.t === '__pong__') {
            const rtt = Math.max(0, Date.now() - Number(msg.ts || 0));
            this.onPing(rtt);
            return;
          }
        }
        this.onMessage(msg);
      };
    }

    ping() {
      if (this.isOpen()) {
        this.send({ t: '__ping__', ts: Date.now() });
      }
    }

    async start() {
      this.close();
      this.closed = false;

      const RTCPeer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (!RTCPeer) return false;

      try {
        this.pc = new RTCPeer({ iceServers: this.iceServers });
      } catch (e) {
        return false;
      }

      this.pc.onicecandidate = (event) => {
        if (event.candidate && !this.closed) {
          this.sendSignal({ candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
        }
      };

      this.pc.ontrack = (event) => {
        lowLatencyReceiver(event.receiver);
        this.onTrack(event.track, event.streams && event.streams[0]);
      };

      if (this.isHost) {
        // Modo UDP no confiable ni ordenado para enviar inputs con minima latencia
        const dc = this.pc.createDataChannel('netplay', { ordered: false, maxRetransmits: 0 });
        this.hookChannel(dc);
        if (this.media) {
          this.videoSender = this.pc.addTransceiver('video', { direction: 'sendonly' }).sender;
          this.audioSender = this.pc.addTransceiver('audio', { direction: 'sendonly' }).sender;
        }

        try {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this.sendSignal({ sdp: this.pc.localDescription });
        } catch (e) {
          this.close();
          return false;
        }
      } else {
        this.pc.ondatachannel = (event) => {
          if (event.channel) this.hookChannel(event.channel);
        };
      }

      return true;
    }

    async handleSignal(signal) {
      if (this.closed || !signal || !this.pc) return;

      try {
        if (signal.sdp) {
          const desc = new RTCSessionDescription(signal.sdp);
          await this.pc.setRemoteDescription(desc);

          while (this.pendingCandidates.length > 0) {
            const cand = this.pendingCandidates.shift();
            try { await this.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }

          if (desc.type === 'offer') {
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this.sendSignal({ sdp: this.pc.localDescription });
          }
        } else if (signal.candidate) {
          if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
            await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            this.pendingCandidates.push(signal.candidate);
          }
        }
      } catch (e) {
        // Continua fallback
      }
    }

    // Tracks can arrive before or after the connection; replaceTrack avoids renegotiation.
    // scaleDown: canvas pixels per game pixel, so the stream goes out at the game's native size.
    async setTracks(video, audio, scaleDown = 1) {
      if (!this.pc || !this.videoSender) return;
      try {
        if (video && this.videoSender.track !== video) {
          video.contentHint = 'motion';
          await this.videoSender.replaceTrack(video);
          const params = this.videoSender.getParameters();
          params.degradationPreference = 'maintain-framerate';
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = 8000000;
          params.encodings[0].maxFramerate = 60;
          params.encodings[0].scaleResolutionDownBy = Math.max(1, scaleDown);
          await this.videoSender.setParameters(params);
        }
        if (audio && this.audioSender.track !== audio) await this.audioSender.replaceTrack(audio);
      } catch (e) {}
    }

    send(data) {
      if (!this.isOpen()) return false;
      try {
        const payload = (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data))
          ? data
          : JSON.stringify(data);
        this.dc.send(payload);
        return true;
      } catch (e) {
        return false;
      }
    }

    close() {
      this.closed = true;
      if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
      if (this.dc) {
        try { this.dc.close(); } catch (e) {}
        this.dc = null;
      }
      if (this.pc) {
        try { this.pc.close(); } catch (e) {}
        this.pc = null;
      }
      this.pendingCandidates = [];
      this.videoSender = null;
      this.audioSender = null;
    }
  }

  if (typeof module !== 'undefined') module.exports = RemoteWebRTC;
  else root.RemoteWebRTC = RemoteWebRTC;
})(globalThis);
