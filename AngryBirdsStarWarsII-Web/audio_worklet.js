// 'yuki-out': consumer of the guest's audio ring (SharedArrayBuffer). Header Int32 [0]=write index (frames, guest),
// [1]=read index (frames, this worklet), [2]=rate, [3]=capacity (power of two), then capacity x {L,R} Float32 from byte 16.
// The read index is the HARDWARE CLOCK: it advances by one render quantum every callback whether or not data was
// available, so the guest can pace its production from it (underrun => the guest sees w < r and resynchronises).
class YukiOut extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.i32 = new Int32Array(o.buf, o.addr, 4);
    this.cap = this.i32[3] | 0;
    this.d = new Float32Array(o.buf, o.addr + 16, this.cap * 2);
    this.mask = this.cap - 1;
    this.frames = 0;
    this.nz = 0;
    this.starved = 0;      // frames of silence inserted after audio first arrived (underruns)
    this.started = false;
    this.n = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0], n = L.length;
    const r = Atomics.load(this.i32, 1), w = Atomics.load(this.i32, 0);
    let av = (w - r) | 0;
    if (av < 0) av = 0;
    if (av > n) av = n;
    for (let i = 0; i < av; i++) {
      const k = ((r + i) & this.mask) * 2;
      const a = this.d[k], b = this.d[k + 1];
      L[i] = a; R[i] = b;
      if (a !== 0 || b !== 0) this.nz++;
    }
    for (let i = av; i < n; i++) { L[i] = 0; R[i] = 0; }
    if (av > 0) this.started = true;
    if (av < n && this.started) this.starved += n - av;
    Atomics.store(this.i32, 1, (r + n) | 0);
    this.frames += av;
    if (++this.n % 172 === 0) this.port.postMessage({ frames: this.frames, nz: this.nz, starved: this.starved, fill: (w - r - n) | 0 });
    return true;
  }
}
registerProcessor('yuki-out', YukiOut);
