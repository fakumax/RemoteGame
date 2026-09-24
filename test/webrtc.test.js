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
