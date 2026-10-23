// RemoteGame: one control layout shared by the local emulator and the remote guest.
// Indexes are EmulatorJS/RetroPad inputs: 0 B, 1 Y, 2 Select, 3 Start, 4-7 D-pad,
// 8 A, 9 X, 10 L, 11 R, 12 L2, 13 R2, 14 L3, 15 R3, 16-19 left stick (+X,-X,+Y,-Y),
// 20-23 right stick.
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

  // We read keyboard and pads ourselves (a page-level listener needs no focus, so the arrows
  // never scroll the page), so EmulatorJS gets every binding blank and stays out of the way.
  function ejsControls() {
    const player = {};
    for (const i in PAD) player[i] = { value: '', value2: '' };
    return { 0: player, 1: player, 2: player, 3: player };
  }

  // EmulatorJS key name -> KeyboardEvent.code (layout independent, like the guest).
  const NAMED = {
    'up arrow': ['ArrowUp'], 'down arrow': ['ArrowDown'], 'left arrow': ['ArrowLeft'], 'right arrow': ['ArrowRight'],
    shift: ['ShiftLeft', 'ShiftRight'], enter: ['Enter', 'NumpadEnter'], backspace: ['Backspace'], tab: ['Tab']
  };
  function codeMap(keys) {
    const map = {};
    for (const i in keys) {
      const name = keys[i];
      const codes = /^[a-z]$/.test(name) ? ['Key' + name.toUpperCase()] : /^\d$/.test(name) ? ['Digit' + name] : NAMED[name] || [];
      for (const code of codes) (map[code] = map[code] || []).push(+i);
    }
    return map;
  }
  // Guest side: KeyboardEvent.code -> RetroPad indexes, same layout as KEYS_SOLO.
  const CODES = codeMap(KEYS_SOLO);
  // Standard Gamepad API button index -> RetroPad index.
  const BUTTONS = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7];

  // Sony pads without the "standard" mapping (Firefox before 152, or a build that does not know the
  // model) keep the raw HID order: square, cross, circle, triangle, L1, R1, L2, R2, share, options,
  // L3, R3. Raw index of each standard button 0-11; the D-pad is a hat on axis 9, right stick X/Y
  // on axes 2/5 (device/gamepad/gamepad_standard_mappings.cc, MapperDualshock4/MapperDualSense).
  const SONY_RAW = [1, 2, 0, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const isSony = id => /\b054c\b/i.test(id || '');
  // Hat axis: -1 = up, +2/7 per step clockwise, ~1.29 = released (0 = no data). -> [up, right, down, left].
  const HAT = [[1, 0, 0, 0], [1, 1, 0, 0], [0, 1, 0, 0], [0, 1, 1, 0], [0, 0, 1, 0], [0, 0, 1, 1], [0, 0, 0, 1], [1, 0, 0, 1]];
  function hat(v) {
    return typeof v === 'number' && v !== 0 && v >= -1.05 && v <= 1.05 ? HAT[Math.round((v + 1) * 3.5)] : [0, 0, 0, 0];
  }

  // Friendly name from Gamepad.id ("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)").
  function padName(id) {
    id = String(id || '');
    if (/dualsense|054c[\s\S]*(0ce6|0df2|0e5f)/i.test(id)) return 'DualSense';
    if (/dualshock|054c[\s\S]*(05c4|09cc|0ba0)/i.test(id)) return 'DualShock 4';
    if (isSony(id)) return 'mando de PlayStation';
    if (/xbox|xinput|\b045e\b/i.test(id)) return 'mando de Xbox';
    if (/pro controller|\b057e\b/i.test(id)) return 'mando de Switch';
    const name = id.replace(/\s*\(.*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim();
    return name && name.length < 28 ? name : 'mando genérico';
  }

  // One pad as a RetroPad state: { b: bits 0-15, x, y: left stick, rx, ry: right stick (-127..127) }.
  function padState(g, analog) {
    const raw = g.mapping !== 'standard' && isSony(g.id);
    const press = i => !!(g.buttons[i] && g.buttons[i].pressed);
    let b = 0;
    for (let i = 0; i < BUTTONS.length; i++) {
      if (raw ? i < 12 && press(SONY_RAW[i]) : press(i)) b |= 1 << BUTTONS[i];
    }
    if (raw) {
      const [up, right, down, left] = hat(g.axes[9]);
      b |= up << 4 | down << 5 | left << 6 | right << 7;
    }
    const lx = g.axes[0] || 0, ly = g.axes[1] || 0, rx = g.axes[2] || 0, ry = (raw ? g.axes[5] : g.axes[3]) || 0;
    const out = { b, x: 0, y: 0, rx: 0, ry: 0 };
    if (analog) {
      const stick = v => Math.abs(v) > 0.15 ? Math.round(v * 127) : 0;
      out.x = stick(lx); out.y = stick(ly); out.rx = stick(rx); out.ry = stick(ry);
    } else {
      // Arcade/console games read the D-pad: the stick doubles as one.
      if (lx < -0.5) out.b |= 1 << 6; if (lx > 0.5) out.b |= 1 << 7;
      if (ly < -0.5) out.b |= 1 << 4; if (ly > 0.5) out.b |= 1 << 5;
    }
    return out;
  }

  // Which connected pads are alive. Virtual drivers (Steam, vJoy, ViGEm) can sit at index 0 and
  // never move: a pad counts once a button is pressed or an axis leaves where it first rested.
  function padTracker() {
    const seen = {};
    return gamepads => {
      const live = [];
      for (const g of gamepads || []) {
        if (!g || !g.connected) continue;
        const s = seen[g.index + g.id] || (seen[g.index + g.id] = { base: Array.from(g.axes), live: false });
        if (!s.live) s.live = g.buttons.some(b => b && b.pressed) || Array.from(g.axes).some((a, i) => Math.abs(a - s.base[i]) > 0.5);
        if (s.live) live.push(g);
      }
      return live.sort((a, b) => a.index - b.index);
    };
  }

  // Header line: what the browser exposes and what we are reading. perPlayer: local 2P, pad N is PN.
  function padStatus(gamepads, live, perPlayer) {
    if (live.length) {
      const names = live.map((g, i) => (perPlayer ? 'P' + (i + 1) + ': ' : '') + padName(g.id));
      return '🎮 ' + names.join(perPlayer ? ' · ' : ' + ') + (live.length > 1 ? ' conectados' : ' conectado');
    }
    // Browsers hide a pad until a button is pressed with the tab focused.
    if (Array.from(gamepads || []).some(g => g && g.connected)) return '🎮 Mando detectado: apretá cualquier botón';
    return '🎮 Ningún mando: conectalo y apretá cualquier botón';
  }

  // Returns { b: bitmask of RetroPad 0-15, x, y: left stick in -127..127 }.
  function readGuest(keys, gamepads, analog) {
    let b = 0, x = 0, y = 0;
    for (const code in keys) if (keys[code] && CODES[code]) for (const i of CODES[code]) b |= 1 << i;
    for (const g of gamepads || []) {
      if (!g || !g.connected) continue;
      const s = padState(g, analog);
      b |= s.b;
      if (s.x) x = s.x;
      if (s.y) y = s.y;
    }
    return { b, x, y };
  }

  // Host side: turns a state into EmulatorJS simulateInput calls, only for what changed.
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
    axis(next.rx | 0, prev.rx | 0, 20, 21);
    axis(next.ry | 0, prev.ry | 0, 22, 23);
  }

  // Host side: this PC's keyboard and pads -> simulate(player, index, value).
  // Online only P1 is local (P2 is the guest); in local 2P the Nth live pad is player N.
  function hostInput(core, online, simulate) {
    const layouts = core === 'n64' ? [KEYS_N64] : online ? [KEYS_SOLO] : [KEYS_P1_SHARED, KEYS_P2_SHARED];
    const maps = layouts.map(codeMap), analog = core === 'n64', count = Math.max(layouts.length, online ? 1 : 4);
    const AXES = ['x', 'x', 'y', 'y', 'rx', 'rx', 'ry', 'ry'];
    const track = padTracker(), down = {}, prev = [];
    let states = [];
    for (let p = 0; p < count; p++) prev.push(Object.assign({}, api.EMPTY));
    function apply() {
      for (let p = 0; p < count; p++) {
        const next = Object.assign({}, api.EMPTY), map = maps[p], keyed = { x: 0, y: 0, rx: 0, ry: 0 };
        if (map) {
          for (const code in down) {
            for (const i of map[code] || []) {
              if (i < 16) next.b |= 1 << i;
              else keyed[AXES[i - 16]] += i % 2 ? -127 : 127;
            }
          }
        }
        for (const s of online ? states : states.slice(p, p + 1)) {
          next.b |= s.b;
          for (const k of AXES) if (s[k] && Math.abs(s[k]) > Math.abs(next[k])) next[k] = s[k];
        }
        for (const k of AXES) if (!next[k]) next[k] = Math.max(-127, Math.min(127, keyed[k]));
        applyGuest(prev[p], next, (i, v) => simulate(p, i, v));
        prev[p] = next;
      }
    }
    return {
      // Returns true when the key belongs to the game (the caller then cancels its default action).
      key(code, isDown) {
        if (!maps.some(m => m[code])) return false;
        if (isDown) down[code] = true; else delete down[code];
        apply();
        return true;
      },
      // Call often with navigator.getGamepads(); returns the live pads for the status line.
      pads(gamepads) {
        const live = track(gamepads);
        states = live.map(g => padState(g, analog));
        apply();
        return live;
      },
      release() { for (const code in down) delete down[code]; states = []; apply(); }
    };
  }

  const api = {
    PAD, KEYS_SOLO, KEYS_P1_SHARED, KEYS_P2_SHARED, KEYS_N64, ejsControls, codeMap, readGuest, applyGuest,
    padName, padState, padTracker, padStatus, hostInput, EMPTY: { b: 0, x: 0, y: 0, rx: 0, ry: 0 }
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.RemotePads = api;
})(globalThis);
