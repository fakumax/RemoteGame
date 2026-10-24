const { test } = require('node:test');
const assert = require('node:assert/strict');
const RemoteWebRTC = require('../public/webrtc');

test('RemoteWebRTC: instance defaults and closed state', () => {
  const rtc = new RemoteWebRTC({ isHost: true });
  assert.equal(rtc.isHost, true);
  assert.equal(rtc.isOpen(), false);
  assert.equal(rtc.send({ hello: 'world' }), false);
  rtc.close();
  assert.equal(rtc.closed, true);
});

test('RemoteWebRTC: mock channel message routing and ping/pong', () => {
  let opened = false;
  let receivedMsg = null;
  let pingRtt = null;
  const sentSignals = [];

  const rtc = new RemoteWebRTC({
    isHost: true,
    sendSignal: s => sentSignals.push(s),
    onOpen: () => { opened = true; },
    onMessage: m => { receivedMsg = m; },
    onPing: rtt => { pingRtt = rtt; }
  });

  const mockChannel = {
    readyState: 'open',
    sendCalls: [],
    send(data) { this.sendCalls.push(data); },
    close() { this.readyState = 'closed'; }
  };

  rtc.hookChannel(mockChannel);
  assert.equal(rtc.isOpen(), true);
  mockChannel.onopen();
  assert.equal(opened, true);

  // Send regular message
  const ok = rtc.send({ t: 'input', frame: 1, pad: 8 });
  assert.equal(ok, true);
  assert.equal(mockChannel.sendCalls.length, 1);
  assert.deepEqual(JSON.parse(mockChannel.sendCalls[0]), { t: 'input', frame: 1, pad: 8 });

  // Receive regular message
  mockChannel.onmessage({ data: JSON.stringify({ t: 'input', frame: 1, pad: 4 }) });
  assert.deepEqual(receivedMsg, { t: 'input', frame: 1, pad: 4 });

  // Handle incoming ping -> sends pong
  mockChannel.onmessage({ data: JSON.stringify({ t: '__ping__', ts: 12345 }) });
  const pongMsg = JSON.parse(mockChannel.sendCalls[mockChannel.sendCalls.length - 1]);
  assert.equal(pongMsg.t, '__pong__');
  assert.equal(pongMsg.ts, 12345);

  // Handle incoming pong -> triggers onPing callback
  mockChannel.onmessage({ data: JSON.stringify({ t: '__pong__', ts: Date.now() - 25 }) });
  assert.ok(typeof pingRtt === 'number' && pingRtt >= 0);

  rtc.close();
  assert.equal(rtc.isOpen(), false);
});

test('RemoteWebRTC: a channel received already open still reports onOpen once', async () => {
  let opens = 0;
  const rtc = new RemoteWebRTC({ onOpen: () => { opens++; } });
  const channel = { readyState: 'open', send() {}, close() {} };
  rtc.hookChannel(channel);
  await Promise.resolve();
  channel.onopen();
  assert.equal(opens, 1);
  rtc.close();
});

test('RemoteWebRTC: one host feeds the same video and audio tracks to several guests', async () => {
  const sender = () => ({ track: null, params: { encodings: [] }, async replaceTrack(t) { this.track = t; }, getParameters() { return this.params; }, async setParameters(p) { this.params = p; } });
  const guests = [0, 1, 2].map(() => {
    const rtc = new RemoteWebRTC({ isHost: true, media: true });
    rtc.pc = {}; rtc.videoSender = sender(); rtc.audioSender = sender();
    return rtc;
  });
  const video = {}, audio = {};
  await Promise.all(guests.map(g => g.setTracks(video, audio, 3)));
  for (const g of guests) {
    assert.equal(g.videoSender.track, video);
    assert.equal(g.audioSender.track, audio);
    assert.equal(g.videoSender.params.encodings[0].scaleResolutionDownBy, 3);
  }
  // Closing one guest leaves the others streaming, and a closed one ignores later track swaps.
  guests[1].close();
  await Promise.all(guests.map(g => g.setTracks({}, {}, 1)));
  assert.notEqual(guests[0].videoSender.track, video);
  assert.equal(guests[1].videoSender, null);
  assert.equal(guests[2].videoSender.params.encodings[0].scaleResolutionDownBy, 1);
  guests.forEach(g => g.close());
});

const fakeSender = () => ({ track: null, params: { encodings: [] }, sets: 0, async replaceTrack(t) { this.track = t; }, getParameters() { return this.params; }, async setParameters(p) { this.params = p; this.sets++; } });
const fakeHost = () => { const rtc = new RemoteWebRTC({ isHost: true, media: true }); rtc.pc = {}; rtc.videoSender = fakeSender(); rtc.audioSender = fakeSender(); return rtc; };

test('RemoteWebRTC: setTracks takes scale, bitrate and keeps the frames; a number still means scale', async () => {
  const rtc = fakeHost(), video = {};
  await rtc.setTracks(video, null, 2);
  let e = rtc.videoSender.params.encodings[0];
  assert.deepEqual([e.scaleResolutionDownBy, e.maxBitrate, e.maxFramerate], [2, 8000000, 60], 'the old call keeps its 8 Mbps');
  assert.equal(rtc.videoSender.params.degradationPreference, 'maintain-framerate');
  assert.equal(video.contentHint, 'motion');
  // A screen capture: 15 Mbps at 60 fps, scaled down from 4K to 1080p.
  const capture = {};
  await rtc.setTracks(capture, null, { scale: 2, maxBitrate: 15e6 });
  e = rtc.videoSender.params.encodings[0];
  assert.deepEqual([rtc.videoSender.track, e.scaleResolutionDownBy, e.maxBitrate, e.maxFramerate], [capture, 2, 15e6, 60]);
  // Values below the floor are lifted, a missing scale is 1.
  await rtc.setTracks(capture, null, { scale: 0.2, maxBitrate: 1 });
  e = rtc.videoSender.params.encodings[0];
  assert.deepEqual([e.scaleResolutionDownBy, e.maxBitrate], [1, 100000]);
  rtc.close();
});

test('RemoteWebRTC: the parameters are applied again when they change, and only then', async () => {
  const rtc = fakeHost(), video = {};
  await rtc.setTracks(video, null, { scale: 1, maxBitrate: 15e6 });
  assert.equal(rtc.videoSender.sets, 1);
  await rtc.setTracks(video, null, { scale: 1, maxBitrate: 15e6 });
  assert.equal(rtc.videoSender.sets, 1, 'same track, same values: nothing to do');
  await rtc.setTracks(null, null, { scale: 1.5, maxBitrate: 15e6 });
  assert.equal(rtc.videoSender.sets, 2, 'the capture changed size: new scale, same track');
  assert.equal(rtc.videoSender.params.encodings[0].scaleResolutionDownBy, 1.5);
  await rtc.setTracks(video, null, { scale: 1.5, maxBitrate: 8e6 });
  assert.equal(rtc.videoSender.params.encodings[0].maxBitrate, 8e6);
  // No video yet: nothing to configure.
  const empty = fakeHost();
  await empty.setTracks(null, null, { scale: 3 });
  assert.equal(empty.videoSender.sets, 0);
  rtc.close(); empty.close();
});

// A browser that has H.264 (and the rest), to see what the host asks of the transceiver before the offer.
function withFakeBrowser(codecs, fn) {
  const made = [];
  const saved = { window: globalThis.window, pc: globalThis.RTCPeerConnection, sender: globalThis.RTCRtpSender };
  class FakePC {
    constructor() { this.localDescription = null; }
    createDataChannel() { return { readyState: 'connecting', close() {} }; }
    addTransceiver(kind) {
      const t = { kind, sender: fakeSender(), prefs: null, setCodecPreferences(list) { this.prefs = list; } };
      made.push(t); return t;
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    close() {}
  }
  globalThis.window = globalThis; globalThis.RTCPeerConnection = FakePC;
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs }) };
  return Promise.resolve(fn(made)).finally(() => {
    for (const [k, v] of [['window', saved.window], ['RTCPeerConnection', saved.pc], ['RTCRtpSender', saved.sender]]) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  });
}
const CODECS = [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' }, { mimeType: 'video/rtx' }, { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640c1f' }, { mimeType: 'video/AV1' }];

test('RemoteWebRTC: the host puts H.264 first before the offer, keeping the other codecs behind it', async () => {
  await withFakeBrowser(CODECS, async made => {
    const signals = [];
    const rtc = new RemoteWebRTC({ isHost: true, media: true, codec: 'h264', sendSignal: s => signals.push(s) });
    assert.equal(await rtc.start(), true);
    const video = made.find(t => t.kind === 'video'), audio = made.find(t => t.kind === 'audio');
    assert.deepEqual(video.prefs.map(c => c.mimeType), ['video/H264', 'video/H264', 'video/VP8', 'video/rtx', 'video/AV1']);
    assert.equal(audio.prefs, null);
    assert.equal(signals.length, 1, 'the offer went out after the preference');
    rtc.close();
  });
});

test('RemoteWebRTC: without the codec, without support or without asking, the browser keeps its own order', async () => {
  await withFakeBrowser(CODECS.filter(c => !/H264/.test(c.mimeType)), async made => {
    const rtc = new RemoteWebRTC({ isHost: true, media: true, codec: 'h264' });
    assert.equal(await rtc.start(), true, 'no H.264: it goes on with what there is');
    assert.equal(made.find(t => t.kind === 'video').prefs, null);
    rtc.close();
  });
  await withFakeBrowser(CODECS, async made => {
    const rtc = new RemoteWebRTC({ isHost: true, media: true });
    await rtc.start();
    assert.equal(made.find(t => t.kind === 'video').prefs, null, 'nobody asked');
    rtc.close();
    assert.equal(RemoteWebRTC.preferCodec({}, 'h264'), false, 'a transceiver that cannot set preferences');
    assert.equal(RemoteWebRTC.preferCodec({ setCodecPreferences() { throw new Error('x'); } }, 'h264'), false, 'a refusal does not break the call');
  });
  assert.equal(RemoteWebRTC.preferCodec({ setCodecPreferences() {} }, 'h264'), false, 'no RTCRtpSender at all');
});

test('RemoteWebRTC: the codec given to setTracks counts only until the offer exists', async () => {
  await withFakeBrowser(CODECS, async made => {
    const rtc = new RemoteWebRTC({ isHost: true, media: true });
    rtc.pc = new globalThis.RTCPeerConnection();
    rtc.videoTransceiver = rtc.pc.addTransceiver('video'); rtc.videoSender = rtc.videoTransceiver.sender; rtc.audioSender = fakeSender();
    await rtc.setTracks({}, null, { codec: 'h264' });
    assert.equal(rtc.videoTransceiver.prefs[0].mimeType, 'video/H264');
    const late = new RemoteWebRTC({ isHost: true, media: true });
    late.pc = new globalThis.RTCPeerConnection(); late.pc.localDescription = { type: 'offer' };
    late.videoTransceiver = late.pc.addTransceiver('video'); late.videoSender = late.videoTransceiver.sender; late.audioSender = fakeSender();
    await late.setTracks({}, null, { codec: 'h264' });
    assert.equal(late.videoTransceiver.prefs, null, 'already negotiated: left as it is');
  });
});
