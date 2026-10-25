// RemoteGame: the audio of ONE process (the emulator and its children), not of the whole system, so Discord and the rest never reach the guests.
// Windows 10 2004+ / 11 offers it as WASAPI "process loopback" (the Microsoft "ApplicationLoopback" sample; every GUID, struct and
// signature below was checked against the Windows SDK headers 10.0.26100: audioclientactivationparams.h, audioclient.h, mmdeviceapi.h, objidl.h):
//   ActivateAudioInterfaceAsync(L"VAD\\Process_Loopback", IAudioClient, PROPVARIANT(VT_BLOB -> AUDIOCLIENT_ACTIVATION_PARAMS), handler)
//   AUDIOCLIENT_ACTIVATION_PARAMS { type = PROCESS_LOOPBACK (1), { TargetProcessId, mode = INCLUDE_TARGET_PROCESS_TREE (0) } }
// A persistent PowerShell compiles a small C# class with Add-Type (no install) and writes the PCM on stdout in frames:
//   1 byte kind + u32 LE length + payload. R = ready ("<rate> <channels> <bits> <int|float>"), D = data (f64 LE epoch ms of the capture + PCM),
//   E = a failure (text). The page gets the same D payloads over /ws-audio (see createAudioRelay) and plays them in an AudioWorklet.
// Anything that goes wrong (Windows too old, COM error, no PowerShell) only turns the state into "failed" with the reason, which is logged:
// the stream then falls back to the system audio, as before.
'use strict';
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const CSHARP = `
using System; using System.IO; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject { }
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceAsyncOperation {
  [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceCompletionHandler {
  [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
}
[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
  [PreserveSig] int Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint padding);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr handle);
  [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}
/* The completion handler must be agile (IAgileObject): it is called back from a COM thread of the system. */
public class RGHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject {
  public ManualResetEvent Done = new ManualResetEvent(false);
  public int Hr = -1; public object Client;
  public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) {
    try { int r; object o; int h = op.GetActivateResult(out r, out o); Hr = h < 0 ? h : r; Client = o; }
    catch (Exception e) { Hr = e is COMException ? ((COMException)e).ErrorCode : -2; }
    Done.Set(); return 0;
  }
}
[StructLayout(LayoutKind.Sequential)] public struct RGActivationParams { public int ActivationType; public uint TargetProcessId; public int ProcessLoopbackMode; }
/* PROPVARIANT of type VT_BLOB (65): vt + 3 reserved words, then { ULONG cbSize; BYTE *pBlobData } */
[StructLayout(LayoutKind.Sequential)] public struct RGPropVariant { public ushort vt, r1, r2, r3; public uint cbSize; public IntPtr pBlobData; }
[StructLayout(LayoutKind.Sequential, Pack = 2)] public struct RGWaveFormat { public ushort tag, channels; public uint rate, bytesPerSec; public ushort blockAlign, bits, cbSize; }

public static class RGA {
  [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
  static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, IntPtr activationParams, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);
  static Stream outS; static object lk = new object();
  static volatile bool stop, quit; static Thread th; static int pid; static Stopwatch sw = Stopwatch.StartNew(); static double epoch0;
  static double Now() { return epoch0 + sw.Elapsed.TotalMilliseconds; }
  static void Frame(char kind, byte[] body, int off, int len) {
    byte[] h = new byte[5]; h[0] = (byte)kind; BitConverter.GetBytes((uint)len).CopyTo(h, 1);
    lock (lk) { outS.Write(h, 0, 5); outS.Write(body, off, len); outS.Flush(); }
  }
  static void Text(char kind, string s) { byte[] b = System.Text.Encoding.UTF8.GetBytes(s); Frame(kind, b, 0, b.Length); }
  static void Fail(string s) { try { Text('E', s); } catch (Exception) { } Environment.Exit(3); }
  static string Hex(int hr) { return "0x" + hr.ToString("X8"); }
  public static void Start(int target) {
    pid = target; outS = Console.OpenStandardOutput();
    epoch0 = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds - sw.Elapsed.TotalMilliseconds;
    th = new Thread(Run); th.IsBackground = true; th.SetApartmentState(ApartmentState.MTA); th.Start();
  }
  public static void Stop() { quit = true; stop = true; if (th != null) th.Join(1500); }
  static void Run() {
    try {
      IntPtr pp = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RGActivationParams)));
      RGActivationParams ap = new RGActivationParams(); ap.ActivationType = 1; ap.TargetProcessId = (uint)pid; ap.ProcessLoopbackMode = 0;
      Marshal.StructureToPtr(ap, pp, false);
      RGPropVariant pv = new RGPropVariant(); pv.vt = 65; pv.cbSize = (uint)Marshal.SizeOf(typeof(RGActivationParams)); pv.pBlobData = pp;
      IntPtr pvp = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RGPropVariant)));
      Marshal.StructureToPtr(pv, pvp, false);
      RGHandler hd = new RGHandler(); IActivateAudioInterfaceAsyncOperation op;
      try { ActivateAudioInterfaceAsync("VAD\\\\Process_Loopback", typeof(IAudioClient).GUID, pvp, hd, out op); }
      catch (COMException e) { Fail("ActivateAudioInterfaceAsync " + Hex(e.ErrorCode)); return; }
      catch (DllNotFoundException) { Fail("Mmdevapi.dll no esta (Windows demasiado viejo)"); return; }
      catch (EntryPointNotFoundException) { Fail("ActivateAudioInterfaceAsync no existe (Windows demasiado viejo)"); return; }
      if (!hd.Done.WaitOne(8000)) { Fail("la activacion no respondio"); return; }
      if (hd.Hr < 0) { Fail("la activacion fallo " + Hex(hd.Hr) + " (hace falta Windows 10 2004 o mas nuevo)"); return; }
      IAudioClient ac = (IAudioClient)hd.Client;
      /* 48 kHz stereo; float first, 16-bit if the engine refuses it. AUTOCONVERTPCM + SRC_DEFAULT_QUALITY let the engine convert. */
      uint flags = 0x00020000u | 0x00040000u | 0x80000000u | 0x08000000u;
      int hr = -1; string fmtName = ""; int bits = 0; bool isFloat = false; int[] tries = new int[] { 32, 16 };
      foreach (int b in tries) {
        RGWaveFormat wf = new RGWaveFormat(); wf.tag = (ushort)(b == 32 ? 3 : 1); wf.channels = 2; wf.rate = 48000; wf.bits = (ushort)b;
        wf.blockAlign = (ushort)(2 * b / 8); wf.bytesPerSec = wf.rate * wf.blockAlign; wf.cbSize = 0;
        IntPtr fp = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RGWaveFormat))); Marshal.StructureToPtr(wf, fp, false);
        hr = ac.Initialize(0, flags, 0, 0, fp, IntPtr.Zero);
        Marshal.FreeHGlobal(fp);
        if (hr >= 0) { bits = b; isFloat = b == 32; fmtName = "48000 2 " + b + " " + (isFloat ? "float" : "int"); break; }
        if (hr != unchecked((int)0x88890008) && hr != unchecked((int)0x80070057)) break;
      }
      if (hr < 0) { Fail("Initialize " + Hex(hr)); return; }
      ManualResetEvent ev = new ManualResetEvent(false);
      hr = ac.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle()); if (hr < 0) { Fail("SetEventHandle " + Hex(hr)); return; }
      object svc; hr = ac.GetService(typeof(IAudioCaptureClient).GUID, out svc); if (hr < 0) { Fail("GetService " + Hex(hr)); return; }
      IAudioCaptureClient cc = (IAudioCaptureClient)svc;
      hr = ac.Start(); if (hr < 0) { Fail("Start " + Hex(hr)); return; }
      Text('R', fmtName);
      int block = 2 * bits / 8; byte[] buf = new byte[4 + 8 + 48000 * block]; long lastCheck = 0;
      while (!stop) {
        bool got = ev.WaitOne(100);
        long t = sw.ElapsedMilliseconds;
        if (t - lastCheck > 1000) {
          lastCheck = t;
          try { using (Process p = Process.GetProcessById(pid)) { if (p.HasExited) { stop = true; break; } } } catch (ArgumentException) { stop = true; break; }
        }
        if (!got) continue;
        for (;;) {
          uint n; if (cc.GetNextPacketSize(out n) < 0 || n == 0) break;
          IntPtr data; uint frames, fl; ulong dp, qp;
          if (cc.GetBuffer(out data, out frames, out fl, out dp, out qp) < 0) break;
          int bytes = (int)frames * block;
          if (bytes + 8 > buf.Length) buf = new byte[bytes + 8];
          /* Time of the packet's first sample (its QPC position, in 100 ns units), so the receiver sees the whole delay, the engine's buffering included. */
          double age = 0; if ((fl & 4) == 0) { age = (Stopwatch.GetTimestamp() * 1e7 / Stopwatch.Frequency - (double)qp) / 1e4; if (age < 0 || age > 1000) age = 0; }
          BitConverter.GetBytes(Now() - age).CopyTo(buf, 0);
          if ((fl & 2) != 0) Array.Clear(buf, 8, bytes); else Marshal.Copy(data, buf, 8, bytes);
          cc.ReleaseBuffer(frames);
          Frame('D', buf, 0, bytes + 8);
        }
      }
      ac.Stop();
      /* The target process ended on its own: so does the helper (the server hears it as an exit). */
      if (!quit) Environment.Exit(0);
    } catch (Exception e) { Fail(e.GetType().Name + " " + e.Message.Replace("\\r", " ").Replace("\\n", " ")); }
  }
}`;

// stdin carries one-line orders ("q" = quit); EOF (the server died) also ends it. The C# thread writes the frames to stdout itself.
const psCompile = pid => "try { Add-Type -TypeDefinition '" + CSHARP.replace(/\s*\n\s*/g, ' ').replace(/'/g, "''") + "'; [RGA]::Start(" + (pid | 0) + ") } catch { [Console]::Error.WriteLine('compile: ' + ($_.Exception.Message -replace '\\s+', ' ')); exit 1 }";
const PS_LOOP = "while (($l = [Console]::In.ReadLine()) -ne $null) { if ($l -eq 'q') { break } }; [RGA]::Stop(); exit 0";

// Splits the helper's stdout into { kind, payload } frames.
function frameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1);
      if (len > 1 << 22) { buf = Buffer.alloc(0); return false; }   // garbage: more than 4 MB in one frame
      if (buf.length < 5 + len) break;
      onFrame(String.fromCharCode(buf[0]), Buffer.from(buf.subarray(5, 5 + len)));
      buf = buf.subarray(5 + len);
    }
    return true;
  };
}

// One capture at a time. o: { spawn, platform, log(text), readyTimeout }.
// state(): idle | starting | ready | failed. A failure never throws: it is logged and state() says why (reason()).
function createAudioCapture(o = {}) {
  const doSpawn = o.spawn || spawn;
  const platform = o.platform || process.platform;
  const readyTimeout = o.readyTimeout ?? 20000;
  const note = text => { try { if (o.log) o.log(text); } catch (e) { /* the log must not break the stream */ } };
  const frameSubs = new Set(), stateSubs = new Set();
  let cur = null, n = 0;   // cur: { id, pid, child, state, reason, format, frames, bytes, startedAt, timer, stderr }
  const emitState = () => { for (const fn of [...stateSubs]) { try { fn(cur ? cur.state : 'idle'); } catch (e) { /* a subscriber's problem */ } } };
  const set = (s, state, reason) => {
    if (cur !== s || s.state === state) return;
    s.state = state; if (reason) s.reason = reason;
    if (state !== 'starting' && s.timer) { clearTimeout(s.timer); s.timer = null; }
    emitState();
  };
  function fail(s, reason) {
    if (cur !== s || s.state === 'failed') return;
    if (s.state === 'starting') note('audio: no pude capturar solo el audio del emulador (' + reason + '); se transmite el audio del sistema');
    else note('audio: se cortó la captura del emulador (' + reason + ')');
    set(s, 'failed', reason);
    killChild(s);
  }
  function killChild(s) {
    const c = s.child; s.child = null;
    if (!c) return;
    try { c.stdin.write('q\n'); c.stdin.end(); } catch (e) { /* already closed */ }
    // The helper ends by itself on "q"; this is the net under it.
    const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 1500); t.unref();
    c.once('exit', () => clearTimeout(t));
  }

  function start(pid) {
    if (cur && cur.pid === pid && (cur.state === 'starting' || cur.state === 'ready')) return;
    stop();
    const s = cur = { id: ++n, pid, child: null, state: 'starting', reason: null, format: null, frames: 0, bytes: 0, startedAt: Date.now(), timer: null, stderr: '' };
    if (!Number.isInteger(pid) || pid <= 0) { fail(s, 'no hay un proceso para capturar'); return; }
    if (platform !== 'win32') { fail(s, 'solo funciona en Windows'); return; }
    let child;
    try { child = doSpawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { fail(s, e.code === 'ENOENT' ? 'no encontré PowerShell' : e.message); return; }
    s.child = child;
    s.timer = setTimeout(() => fail(s, 'tardó demasiado en arrancar'), readyTimeout); s.timer.unref();
    const parse = frameParser((kind, payload) => {
      if (cur !== s) return;
      if (kind === 'D') {
        s.frames++; s.bytes += payload.length - 8;
        for (const fn of [...frameSubs]) { try { fn(payload); } catch (e) { /* a subscriber's problem */ } }
      } else if (kind === 'R') {
        const [rate, channels, bits, type] = payload.toString('latin1').split(' ');
        s.format = { rate: Number(rate), channels: Number(channels), bits: Number(bits), float: type === 'float' };
        note('audio: captura por proceso activa (pid ' + pid + ', ' + rate + ' Hz, ' + channels + ' canales, ' + bits + ' bits)');
        set(s, 'ready');
      } else if (kind === 'E') fail(s, payload.toString('utf8').slice(0, 200));
    });
    child.stdout.on('data', chunk => { if (!parse(chunk)) fail(s, 'respuesta ilegible del ayudante'); });
    child.stdout.on('error', () => {});
    child.stderr.setEncoding && child.stderr.setEncoding('utf8');
    child.stderr.on('data', t => { if (s.stderr.length < 400) s.stderr += t; });
    child.stderr.on('error', () => {}); child.stdin.on('error', () => {});
    child.on('error', e => fail(s, e.code === 'ENOENT' ? 'no encontré PowerShell' : e.message));
    child.on('exit', code => {
      if (cur !== s) return;
      s.child = null;
      if (s.state === 'ready') { note('audio: el ayudante terminó (código ' + code + ')'); set(s, 'failed', 'el ayudante terminó'); }
      else fail(s, s.stderr.trim().replace(/\s+/g, ' ').slice(0, 200) || 'el ayudante terminó con código ' + code);
    });
    try { child.stdin.write(psCompile(pid) + '\n' + PS_LOOP + '\n'); } catch (e) { fail(s, e.message); }
  }
  function stop() {
    const s = cur; cur = null; n++;
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    killChild(s);
    emitState();
  }
  return {
    start, stop,
    state: () => cur ? cur.state : 'idle',
    reason: () => cur && cur.reason || null,
    format: () => cur && cur.format || null,
    stats: () => cur ? { state: cur.state, frames: cur.frames, bytes: cur.bytes, since: cur.startedAt } : { state: 'idle', frames: 0, bytes: 0, since: 0 },
    // Resolves { ok, format, reason } as soon as the capture works or has failed (or after `ms`): the page asks this before choosing its audio.
    settled(ms = 8000) {
      return new Promise(resolve => {
        let timer = null;
        const done = () => {
          if (cur && cur.state === 'starting') return false;
          stateSubs.delete(check); if (timer) clearTimeout(timer);
          resolve(cur && cur.state === 'ready' ? { ok: true, format: cur.format } : { ok: false, reason: cur ? cur.reason || 'sin captura' : 'no hay un emulador abierto por RemoteGame' });
          return true;
        };
        const check = () => done();
        if (done()) return;
        stateSubs.add(check);
        timer = setTimeout(() => { stateSubs.delete(check); resolve({ ok: false, reason: 'tardó demasiado en arrancar' }); }, ms); timer.unref();
      });
    },
    onFrame(fn) { frameSubs.add(fn); return () => frameSubs.delete(fn); },
    onState(fn) { stateSubs.add(fn); return () => stateSubs.delete(fn); },
    close() { stop(); frameSubs.clear(); stateSubs.clear(); }
  };
}

// The /ws-audio relay. The server upgrades only requests from this PC (the same test as everything private) and hands the socket over.
// First message (text): { t: 'audio', ok, rate, channels, bits, float } or { t: 'audio', ok: false, reason }; then, binary, each D payload as it comes.
// A client that falls behind loses frames (the page would rather skip than build up delay).
function createAudioRelay(capture, { maxClients = 4, maxBuffered = 256 * 1024, wait = 8000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const clients = new Set();
  wss.on('connection', ws => {
    if (clients.size >= maxClients) return ws.close(1013, 'busy');
    clients.add(ws);
    ws._socket.setNoDelay(true);
    let unsub = null, unstate = null;
    const cleanup = () => { clients.delete(ws); if (unsub) unsub(); if (unstate) unstate(); unsub = unstate = null; };
    ws.on('error', () => {}); ws.on('close', cleanup); ws.on('message', () => {});
    if (!capture) { ws.send(JSON.stringify({ t: 'audio', ok: false, reason: 'sin captura de audio' })); return ws.close(); }
    capture.settled(wait).then(r => {
      if (ws.readyState !== 1) return;
      if (!r.ok) { ws.send(JSON.stringify({ t: 'audio', ok: false, reason: r.reason })); return ws.close(); }
      ws.send(JSON.stringify({ t: 'audio', ok: true, rate: r.format.rate, channels: r.format.channels, bits: r.format.bits, float: r.format.float }));
      unsub = capture.onFrame(buf => { if (ws.bufferedAmount < maxBuffered) ws.send(buf, { binary: true }); });
      unstate = capture.onState(s => { if (s !== 'ready') ws.close(1000, 'end'); });
    });
  });
  return {
    handle(req, socket, head) { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); },
    clients: () => clients.size,
    close() { for (const ws of clients) ws.terminate(); wss.close(); }
  };
}

module.exports = { createAudioCapture, createAudioRelay, frameParser, CSHARP, psCompile };
