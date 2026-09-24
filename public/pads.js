// RemoteGame: one control layout shared by the local emulator and the remote guest.
// Indexes are EmulatorJS/RetroPad inputs: 0 B, 1 Y, 2 Select, 3 Start, 4-7 D-pad,
// 8 A, 9 X, 10 L, 11 R, 12 L2, 13 R2, 14 L3, 15 R3, 16-19 left stick (+X,-X,+Y,-Y).
(function(root) {
  // Positional mapping (bottom = B, right = A, left = Y, top = X), as on a SNES pad.
  // FBNeo maps Neo Geo A/B/C/D to B/A/Y/X, so bottom-right-left-top = A-B-C-D.
  const PAD = {
    0: 'BUTTON_1', 1: 'BUTTON_3', 2: 'SELECT', 3: 'START',
    4: 'DPAD_UP', 5: 'DPAD_DOWN', 6: 'DPAD_LEFT', 7: 'DPAD_RIGHT',
    8: 'BUTTON_2', 9: 'BUTTON_4', 10: 'LEFT_TOP_SHOULDER', 11: 'RIGHT_TOP_SHOULDER',
    12: 'LEFT_BOTTOM_SHOULDER', 13: 'RIGHT_BOTTOM_SHOULDER', 14: 'LEFT_STICK', 15: 'RIGHT_STICK',
    16: 'LEFT_STICK_X:+1', 17: 'LEFT_STICK_X:-1', 18: 'LEFT_STICK_Y:+1', 19: 'LEFT_STICK_Y:-1',
    20: 'RIGHT_STICK_X:+1', 21: 'RIGHT_STICK_X:-1', 22: 'RIGHT_STICK_Y:+1', 23: 'RIGHT_STICK_Y:-1'
  };
  // A single player at a keyboard (online host and guest).
  const KEYS_SOLO = {
    0: 'z', 8: 'x', 1: 'a', 9: 's', 10: 'q', 11: 'w', 2: 'shift', 3: 'enter',
    4: 'up arrow', 5: 'down arrow', 6: 'left arrow', 7: 'right arrow'
  };
  // Two players sharing one keyboard: P1 on the left half, P2 on the right half.
  const KEYS_P1_SHARED = {
    0: 'f', 8: 'g', 1: 'r', 9: 't', 10: 'q', 11: 'e', 2: '1', 3: '2',
    4: 'w', 5: 's', 6: 'a', 7: 'd'
  };
  const KEYS_P2_SHARED = {
    0: 'k', 8: 'l', 1: 'i', 9: 'o', 10: 'u', 11: 'p', 2: 'backspace', 3: 'enter',
    4: 'up arrow', 5: 'down arrow', 6: 'left arrow', 7: 'right arrow'
  };
  // N64 needs the analog stick on the keyboard: keep EmulatorJS' own P1 layout.
  const KEYS_N64 = {
    0: 'x', 1: 's', 2: 'v', 3: 'enter', 4: 'up arrow', 5: 'down arrow', 6: 'left arrow', 7: 'right arrow',
    8: 'z', 9: 'a', 10: 'q', 11: 'e', 12: 'tab', 13: 'r', 16: 'h', 17: 'f', 18: 'g', 19: 't',
    20: 'l', 21: 'j', 22: 'k', 23: 'i'
  };

  function player(keys) {
    const out = {};
    for (const i in PAD) out[i] = { value: (keys && keys[i]) || '', value2: PAD[i] };
    return out;
  }
  // EJS_defaultControls: every player gets a gamepad (1st pad = P1, 2nd = P2...).
  function ejsControls(core, mode) {
    if (core === 'n64') return { 0: player(KEYS_N64), 1: player(null), 2: player(null), 3: player(null) };
    if (mode === 'online') return { 0: player(KEYS_SOLO), 1: player(null), 2: player(null), 3: player(null) };
    return { 0: player(KEYS_P1_SHARED), 1: player(KEYS_P2_SHARED), 2: player(null), 3: player(null) };
  }

  // Guest side: KeyboardEvent.code -> RetroPad index, same layout as KEYS_SOLO.
  const CODES = {
    KeyZ: 0, KeyX: 8, KeyA: 1, KeyS: 9, KeyQ: 10, KeyW: 11, ShiftLeft: 2, ShiftRight: 2, Enter: 3,
    ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7
  };
  // Standard Gamepad API button index -> RetroPad index.
  const BUTTONS = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7];

  // Returns { b: bitmask of RetroPad 0-15, x, y: left stick in -127..127 }.
  function readGuest(keys, gamepads, analog) {
    let b = 0, x = 0, y = 0;
    for (const code in keys) if (keys[code] && CODES[code] !== undefined) b |= 1 << CODES[code];
    for (const g of gamepads || []) {
      if (!g || !g.connected) continue;
      for (let i = 0; i < BUTTONS.length; i++) if (g.buttons[i] && g.buttons[i].pressed) b |= 1 << BUTTONS[i];
      const ax = g.axes[0] || 0, ay = g.axes[1] || 0;
      if (analog) {
        if (Math.abs(ax) > 0.15) x = Math.round(ax * 127);
        if (Math.abs(ay) > 0.15) y = Math.round(ay * 127);
      } else {
        // Arcade/console games read the D-pad: the stick doubles as one.
        if (ax < -0.5) b |= 1 << 6; if (ax > 0.5) b |= 1 << 7;
        if (ay < -0.5) b |= 1 << 4; if (ay > 0.5) b |= 1 << 5;
      }
      break;
    }
    return { b, x, y };
  }

  // Host side: turns a guest state into EmulatorJS simulateInput calls, only for what changed.
  function applyGuest(prev, next, simulate) {
    for (let i = 0; i < 16; i++) {
      const was = (prev.b >> i) & 1, is = (next.b >> i) & 1;
      if (was !== is) simulate(i, is);
    }
    const axis = (value, before, plus, minus) => {
      if (value === before) return;
      simulate(plus, value > 0 ? Math.round(0x7fff * value / 127) : 0);
      simulate(minus, value < 0 ? Math.round(-0x7fff * value / 127) : 0);
    };
    axis(next.x, prev.x, 16, 17);
    axis(next.y, prev.y, 18, 19);
  }

  const api = { PAD, KEYS_SOLO, KEYS_P1_SHARED, KEYS_P2_SHARED, ejsControls, readGuest, applyGuest, EMPTY: { b: 0, x: 0, y: 0 } };
  if (typeof module !== 'undefined') module.exports = api;
  else root.RemotePads = api;
})(globalThis);
