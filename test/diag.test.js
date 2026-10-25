const { test } = require('node:test');
const assert = require('node:assert/strict');
const diag = require('../public/diag');

// A stats report as the browser gives it: a Map-like with forEach(value).
const report = (...entries) => new Map(entries.map((e, i) => [String(i), e]));
const inbound = extra => ({ type: 'inbound-rtp', kind: 'video', freezeCount: 0, totalFreezesDuration: 0, packetsLost: 0, jitter: 0.01, framesDropped: 0, framesPerSecond: 60, jitterBufferDelay: 1, jitterBufferEmittedCount: 100, ...extra });
const pair = rtt => ({ type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: rtt });

test('Diag guest: a new freeze is read from the counters, with what was lost meanwhile', () => {
  const a = diag.guestSample(report(inbound(), pair(0.04)));
  const b = diag.guestSample(report(inbound({ freezeCount: 1, totalFreezesDuration: 0.32, packetsLost: 14, jitter: 0.022, framesDropped: 3, framesPerSecond: 41, jitterBufferDelay: 4, jitterBufferEmittedCount: 200 }), pair(0.048)));
  assert.deepEqual(diag.guestFreeze(a, b), { fc: 1, ms: 320, lost: 14, jit: 22, rtt: 48, fps: 41, drop: 3, jb: 30 });
  assert.equal(diag.guestFreeze(b, b), null, 'the same reading is not a new freeze');
  assert.equal(diag.guestFreeze(null, b), null);
  assert.equal(diag.guestSample(report(pair(0.04))), null, 'no video yet');
});

test('Diag host: encoder, limit and per-frame encode time from outbound-rtp', () => {
  const out = extra => ({ type: 'outbound-rtp', kind: 'video', codecId: 'c1', encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', qualityLimitationReason: 'none', framesEncoded: 100, totalEncodeTime: 0.5, nackCount: 1, pliCount: 0, retransmittedPacketsSent: 2, framesPerSecond: 58, frameWidth: 1920, frameHeight: 1080, ...extra });
  const codec = { type: 'codec', id: 'c1', mimeType: 'video/H264' };
  const src = { type: 'media-source', kind: 'video', framesPerSecond: 31 };
  const a = diag.hostSample(report(out(), codec, src));
  const b = diag.hostSample(report(out({ framesEncoded: 160, totalEncodeTime: 1.04, qualityLimitationReason: 'cpu', nackCount: 13, pliCount: 2, retransmittedPacketsSent: 9 }), codec, src));
  assert.equal(a.codec, 'H264'); assert.equal(a.size, '1920x1080');
  const d = diag.hostDelta(a, b);
  assert.deepEqual([d.enc, d.limit, d.encMs, d.src, d.nack, d.pli, d.retx], ['MediaFoundationVideoEncodeAccelerator', 'cpu', 9, 31, 12, 2, 7]);
  assert.equal(diag.hostSample(report(inbound())), null);
});

test('Diag lines: compact, one per event, to read after a game', () => {
  const f = { fc: 1, ms: 320, lost: 14, jit: 22, rtt: 48, fps: 41, drop: 0, jb: null };
  const h = { enc: 'MediaFoundationVideoEncodeAccelerator', limit: 'none', encMs: 9.1, src: 58, fps: 58, nack: 0, pli: 0, retx: 0, codec: 'H264', size: '1920x1080' };
  assert.equal(diag.freezeLine(2, f, h), 'freeze P2 320ms · lost 14 · jitter 22ms · rtt 48ms · fps 41 · src 58fps · enc MediaFoundation 9.1ms · limit none');
  assert.equal(diag.freezeLine(3, { ...f, jit: null, rtt: null, fps: null }, null), 'freeze P3 320ms · lost 14 · limit ?');
  assert.equal(diag.limitLine(2, 'none', { ...h, limit: 'cpu', fps: 41 }), 'limit P2 none -> cpu · src 58fps · enc MediaFoundation 9.1ms · fps 41');
  assert.equal(diag.encoderLine(2, h), 'enc P2 MediaFoundation · H264 · 1920x1080');
});
