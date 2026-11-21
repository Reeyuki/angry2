// worker.js - background thread that runs the yukicomp guest
// Prevents blocking the browser UI thread during CRT static initializers and game loop.

Error.stackTraceLimit = 100;

if (self.name === 'em-pthread') {
    importScripts('yukicomp-lifted.js');
} else {

// Throttle guest log forwarding: the guest emits thousands of [shim #N] and
// [ALLOC_HOOK] lines per second. Forward boot/status lines fully, shim spam
// 1-in-64, to keep the main thread responsive.
let __yuki_log_count = 0;
let __yuki_stats_count = 0;
const __yuki_mem_interval = setInterval(() => {
    __yuki_stats_count++;
    try {
        const m = Module.HEAPU8 ? Module.HEAPU8.byteLength : 0;
        if (self.__yuki_dev) console.log('[yuki_mem] wasm_memory=' + (m / 1048576).toFixed(0) + 'MB t=' + __yuki_stats_count + 's');
    } catch (e) {}
    if (__yuki_stats_count > 120) clearInterval(__yuki_mem_interval);
}, 1000);
function throttleLog(text) {
    if (text.startsWith('[shim #') || text.startsWith('[disp') || text.startsWith('[ALLOC_HOOK')) {
        __yuki_log_count++;
        return (__yuki_log_count & 0x3f) === 0;
    }
    return true;
}


// ---------------------------------------------------------------------------------------------------------------------------
// Asset packs (optional; page.json "packs", see yukicomp/webpacks.py). The page fetched the index and prefetches packs in
// the background into one SharedArrayBuffer (cfg.data; per-pack state/progress in cfg.ctl: 0 idle, 1 page loading, 2 ready,
// 3 worker loading). The guest blocks this worker, so it can never await: reads are served from a pack that is ready, wait
// (Atomics.wait) for one the page is still loading, or fetch it with a sync XHR themselves. "range" packs (huge) are read in
// 4 MiB windows with HTTP Range; a server that answers 200 to a Range request is handled by slicing the whole body.
function makePacks(cfg, dev, logFile, log) {
    if (!cfg || !cfg.index || !cfg.index.packs) return null;
    const packs = cfg.index.packs, n = packs.length;
    const ctl = cfg.ctl ? new Int32Array(cfg.ctl) : null;
    const data = cfg.data ? new Uint8Array(cfg.data) : null;
    const files = new Map();
    const stats = self.__yuki_packstats = { waited_ms: 0, own_fetch: 0, own_bytes: 0, range_req: 0, used: 0 };
    packs.forEach((p, i) => {
        p.i = i; p.buf = null; p.used = false;
        p.sab = (data && cfg.off && cfg.off[i] >= 0 && !p.range) ? data.subarray(cfg.off[i], cfg.off[i] + p.size) : null;
        let o = 0;
        for (const [rel, size] of p.files) { files.set(rel, { p, off: o, size, rel, t: false }); o += size; }
    });
    function xhr(url, range) {
        let last = null;
        for (let a = 0; a < 3; a++) {
            try {
                const x = new XMLHttpRequest();
                x.open('GET', url, false);
                x.responseType = 'arraybuffer';
                if (range) x.setRequestHeader('Range', range);
                x.send();
                if (x.status === 200 || x.status === 206) return x;
                last = new Error('HTTP ' + x.status);
            } catch (e) { last = e; }
        }
        throw new Error('pack fetch failed ' + url + ': ' + (last && last.message));
    }
    function fetchWhole(p, dst) {
        const x = xhr(p.url);
        if (x.response.byteLength !== p.size) throw new Error('pack ' + p.url + ' size ' + x.response.byteLength + ' != ' + p.size);
        dst.set(new Uint8Array(x.response));
        stats.own_fetch++; stats.own_bytes += p.size;
    }
    function packBytes(p) {
        if (p.buf) return p.buf;
        const t0 = performance.now();
        let how = 'private';
        if (p.sab && ctl) {
            let lastProg = -1, lastChange = t0;
            how = 'ready';
            for (;;) {
                const s = Atomics.load(ctl, p.i);
                if (s === 2) break;
                if (s === 1) {
                    how = 'waited';
                    Atomics.wait(ctl, p.i, 1, 250);
                    const pr = Atomics.load(ctl, n + p.i), now = performance.now();
                    if (pr !== lastProg) { lastProg = pr; lastChange = now; }
                    else if (now - lastChange > 20000 && Atomics.compareExchange(ctl, p.i, 1, 3) === 1) {   // page download stalled: do it here
                        try { fetchWhole(p, p.sab); Atomics.store(ctl, p.i, 2); Atomics.notify(ctl, p.i); how = 'takeover'; break; }
                        catch (e) { Atomics.store(ctl, p.i, 0); throw e; }
                    }
                    continue;
                }
                if (Atomics.compareExchange(ctl, p.i, 0, 3) === 0) {
                    how = 'own';
                    try { fetchWhole(p, p.sab); } catch (e) { Atomics.store(ctl, p.i, 0); throw e; }
                    Atomics.store(ctl, p.i, 2); Atomics.notify(ctl, p.i);
                    break;
                }
                Atomics.wait(ctl, p.i, 3, 250);
            }
            p.buf = p.sab;
        } else {
            const b = new Uint8Array(p.size);
            fetchWhole(p, b);
            p.buf = b;
            how = 'own-private';
        }
        const dt = performance.now() - t0;
        stats.waited_ms += dt;
        if (!p.used) { p.used = true; stats.used++; if (dev) log('[pack] ' + p.name + ' (' + (p.size / 1048576).toFixed(1) + ' MiB) first use: ' + how + ' ' + dt.toFixed(0) + ' ms'); }
        return p.buf;
    }
    const CH = 4 << 20, winCache = new Map();
    function rangeWindow(p, ci) {
        const key = p.i + ':' + ci;
        let w = winCache.get(key);
        if (w) { winCache.delete(key); winCache.set(key, w); return w; }
        const a = ci * CH, b = Math.min(p.size, a + CH);
        const x = xhr(p.url, 'bytes=' + a + '-' + (b - 1));
        stats.range_req++;
        const body = new Uint8Array(x.response);
        if (x.status === 200) {           // server ignored Range: keep the whole pack from now on
            if (body.length !== p.size) throw new Error('pack ' + p.url + ' size mismatch');
            p.buf = body; w = body.subarray(a, b);
        } else w = body;
        winCache.set(key, w);
        while (winCache.size > 16) winCache.delete(winCache.keys().next().value);
        if (!p.used) { p.used = true; stats.used++; if (dev) log('[pack] ' + p.name + ' range mode first use'); }
        return w;
    }
    function readInto(f, u8, offset, length, position) {
        const p = f.p;
        const n2 = Math.min(length, f.size - position);
        if (n2 <= 0) return 0;
        if (p.range && !p.buf) {
            let done = 0;
            while (done < n2) {
                const abs = f.off + position + done, ci = Math.floor(abs / CH), w = rangeWindow(p, ci);
                if (p.buf) { u8.set(p.buf.subarray(f.off + position + done, f.off + position + n2), offset + done); return n2; }
                const s = abs - ci * CH, take = Math.min(n2 - done, w.length - s);
                u8.set(w.subarray(s, s + take), offset + done);
                done += take;
            }
            return n2;
        }
        const b = packBytes(p), a = f.off + position;
        u8.set(b.subarray(a, a + n2), offset);
        return n2;
    }
    return {
        count: files.size,
        has: (rel) => files.has(rel),
        mount(fs) {
            const dirs = new Set();
            let k = 0;
            for (const f of files.values()) {
                const slash = f.rel.lastIndexOf('/'), dir = '/' + f.rel.slice(0, slash);
                if (!dirs.has(dir)) { fs.mkdirTree(dir); dirs.add(dir); }
                try {
                    const node = fs.createFile(dir, f.rel.slice(slash + 1), {}, true, false);
                    node.usedBytes = f.size;
                    node.__pk = f;
                    node.stream_ops = {
                        llseek(stream, offset, whence) {
                            let pos = offset;
                            if (whence === 1) pos += stream.position; else if (whence === 2) pos += stream.node.usedBytes;
                            if (pos < 0) throw new fs.ErrnoError(28);
                            return pos;
                        },
                        read(stream, buffer, offset, length, position) {
                            const f2 = stream.node.__pk;
                            if (!f2.t) { f2.t = true; if (logFile) log('[pack] touch ' + f2.rel + ' (' + f2.p.name + ')'); }
                            const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                            return readInto(f2, u8, offset, length, position);
                        },
                    };
                    k++;
                } catch (e) { log('[worker] pack mount failed ' + f.rel + ': ' + e); }
            }
            return k;
        },
    };
}

self.__yuki_dev = false;
function postLog(msg, isErr) {
    if (!self.__yuki_dev) return;     // silent unless the page was opened with ?debug=1
    if (!throttleLog(msg)) return;
    self.postMessage({ type: 'log', text: msg, isErr: !!isErr });
}

function postStatus(status) {
    self.postMessage({ type: 'status', text: status });
}

self.__yuki_keys = {};

// Uncaught errors / rejected promises inside the worker would otherwise vanish; tell the page.
self.addEventListener('error', (e) => self.postMessage({ type: 'fatal', text: 'worker error: ' + (e.message || e) }));
self.addEventListener('unhandledrejection', (e) => self.postMessage({ type: 'fatal', text: 'unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason) }));
// Heartbeat: only fires while the guest yields to the event loop, so its absence is the hang signal.
setInterval(() => self.postMessage({ type: 'heartbeat', t: Date.now() }), 1000);

self.onmessage = async function(e) {
    if (e.data.type === 'key') {
        self.__yuki_keys[e.data.vk] = e.data.down;
        return;
    }
    if (e.data.type === 'start') {
        self.__yuki_dev = !!e.data.dev;
        if (e.data.audio) self.__yuki_audio_sab = e.data.audio;   // SharedArrayBuffer ring the guest mixes into (dsound.c / audio.c)
        if (e.data.keys) { self.__yuki_keys_sab = new Uint8Array(e.data.keys, 0, 256); self.__yuki_in_i32 = new Int32Array(e.data.keys); }   // read by input.c
        postStatus('Loading engine...');

        const guestEnv = e.data.env || {};
        self.Module = {
            canvas: (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas((e.data.res && e.data.res[0]) || 1280, (e.data.res && e.data.res[1]) || 720) : undefined,
            preRun: [function() {
                const env = Module.ENV || (typeof ENV !== 'undefined' ? ENV : null);
                if (!env) return;
                for (const k of Object.keys(guestEnv)) env[k] = String(guestEnv[k]);
            }],
            print: function(text) { postLog(text, false); },
            printErr: function(text) { postLog(text, true); },
            onRuntimeInitialized: async function() {
                postLog('[worker] WASM runtime initialized', false);
                postStatus('Loading game...');
                try {
                    let resp = null, lastErr = null;
                    for (let attempt = 0; attempt < 4 && !(resp && resp.ok); attempt++) {
                        try { resp = await fetch('game.exe'); if (!resp.ok) lastErr = new Error('HTTP ' + resp.status); }
                        catch (e) { lastErr = e; resp = null; }
                        if (!(resp && resp.ok)) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
                    }
                    if (!resp || !resp.ok) throw new Error('game.exe fetch failed: ' + (lastErr && lastErr.message));
                    const buf = await resp.arrayBuffer();
                    postLog('[worker] Fetched game.exe (' + buf.byteLength + ' bytes)', false);
                    postStatus('Loading game...');

                    const ptr = Module._malloc(buf.byteLength);
                    Module.HEAPU8.set(new Uint8Array(buf), ptr);

                    /* extra PE modules (modules.json beside the page): yuki_load_image fopen()s them from the guest dir, so write them to the FS first */
                    try {
                        const mr = await fetch('modules.json');
                        if (mr.ok) {
                            for (const m of ((await mr.json()).modules || [])) {
                                const dr = await fetch(m.file);
                                if (dr.ok) { Module.FS.writeFile('/' + m.file, new Uint8Array(await dr.arrayBuffer())); postLog('[worker] module ' + m.file + ' staged', false); }
                                else postLog('[worker] module ' + m.file + ' fetch failed: HTTP ' + dr.status, true);
                            }
                        }
                    } catch (e) { postLog('[worker] modules.json: ' + e, true); }

                    postLog('[worker] Calling _yuki_load_image...', false);
                    Module._yuki_load_image(ptr, buf.byteLength);
                    try { self.postMessage({ type: 'audio', buf: Module.HEAPU8.buffer, addr: Module._yuki_audio_ring_addr() }); } catch (e) { postLog('[worker] audio bridge: ' + e, true); }

                    const entry = Module._yuki_entry_va(ptr);
                    postLog('[worker] Entry VA: 0x' + entry.toString(16).toUpperCase(), false);

                    postStatus('Preparing game files...');
                    try {
                        const fs = Module.FS || (typeof FS !== 'undefined' ? FS : null);
                        const cfgResp = await fetch('configs.json');
                        if (cfgResp.ok && fs) {
                            const cfgJson = await cfgResp.json();
                            const configs = cfgJson.base64 || cfgJson;
                            const isB64 = !!cfgJson.base64;
                            const enc = new TextEncoder();
                            for (const [relPath, content] of Object.entries(configs)) {
                                let bytes = isB64 ? Uint8Array.from(atob(content), c => c.charCodeAt(0)) : enc.encode(content);
                                // page.json "resolution.patch": rewrite the game's width/height setting for the size the player chose ({w}/{h})
                                const rp = e.data.resPatch && e.data.res && e.data.resPatch[relPath];
                                if (rp) {
                                    let text = new TextDecoder().decode(bytes);
                                    for (const [from, to] of rp) text = text.split(from).join(String(to).split('{w}').join(e.data.res[0]).split('{h}').join(e.data.res[1]));
                                    bytes = enc.encode(text);
                                }
                                try {
                                    const cut = relPath.lastIndexOf('/');
                                    if (cut > 0) { try { fs.mkdirTree('/' + relPath.slice(0, cut)); } catch (e) {} }
                                    fs.writeFile('/' + relPath, bytes);
                                    fs.writeFile(relPath, bytes);
                                } catch(e) {}
                            }
                            postLog('[worker] Successfully populated ' + Object.keys(configs).length + ' config files in virtual FS', false);

                            postStatus('Preparing game files...');
                            const PK = makePacks(e.data.packs, self.__yuki_dev, !!guestEnv.YUKI_PACK_LOG, (t) => postLog(t, false));
                            let packed = 0;
                            if (PK) { packed = PK.mount(fs); postLog('[worker] mounted ' + packed + ' files from asset packs (' + (e.data.packs.index.packs.length) + ' packs)', false); }
                            const manResp = await fetch('assets.json');
                            if (!manResp.ok) throw new Error('assets.json fetch failed: ' + manResp.status);
                            const manifest = (await manResp.json()).files;
                            let mounted = 0, mountedBytes = 0;
                            for (const [rel, size] of Object.entries(manifest)) {
                                if (PK && PK.has(rel)) continue;     // served from a pack; everything else keeps the per-file lazy path
                                const slash = rel.lastIndexOf('/');
                                const dir = '/' + rel.slice(0, slash);
                                try {
                                    fs.mkdirTree(dir);
                                    fs.createLazyFile(dir, rel.slice(slash + 1), rel, true, false);
                                    mounted++;
                                    mountedBytes += size;
                                } catch (e) {
                                    postLog('[worker] lazy mount failed ' + rel + ': ' + e, true);
                                }
                            }
                            postLog('[worker] mounted ' + mounted + ' lazy files (' + (mountedBytes / 1048576).toFixed(0) + ' MiB, range-fetched on demand)', false);
                        } else if (!fs) {
                            postLog('[worker] Error: FS object not available on Module or global', true);
                        }
                    } catch (e) {
                        postLog('[worker] Warning loading configs: ' + e, true);
                    }

                    // Setup persistent Documents directory via IDBFS if available
                    try {
                        const userRoot = '/' + (guestEnv.YUKI_USERDATA || 'userdata').replace(/^\/+|\/+$/g, '');
                        try { Module.FS.mkdir(userRoot); } catch(e) {}
                        {   // save persistence: restore files from the page's IndexedDB, flush changes back (see tools/patch_saves.py)
                            const saves = e.data.saves || [];
                            const sent = {};
                            for (const f of saves) {
                                try {
                                    const dir = f.path.slice(0, f.path.lastIndexOf('/'));
                                    if (dir) Module.FS.mkdirTree(dir);
                                    Module.FS.writeFile(f.path, new Uint8Array(f.data));
                                    const st = Module.FS.stat(f.path); sent[f.path] = st.size + ':' + (+st.mtime);
                                } catch (er) {}
                            }
                            self.yukiSaveFlush = () => {
                                try {
                                    const out = [];
                                    const walk = (d) => {
                                        for (const n of Module.FS.readdir(d)) {
                                            if (n === '.' || n === '..') continue;
                                            const p = d + '/' + n, st = Module.FS.stat(p);
                                            if (Module.FS.isDir(st.mode)) walk(p);
                                            else { const k = st.size + ':' + (+st.mtime); if (sent[p] !== k) { sent[p] = k; out.push({ path: p, data: Module.FS.readFile(p) }); } }
                                        }
                                    };
                                    walk(userRoot);
                                    if (out.length) self.postMessage({ type: 'save', files: out });
                                } catch (er) {}
                            };
                            postLog('[worker] save persistence: restored ' + saves.length + ' file(s) into ' + userRoot, false);
                        }
                    } catch(e) {
                        postLog('[worker] IDBFS setup note: ' + e, true);
                    }

                    postStatus('Starting the game...');
                    self.postMessage({ type: 'boot_started' });

                    Module._yuki_boot(entry);

                    postStatus('Starting the game...');
                    self.postMessage({ type: 'boot_completed' });

                    const statsStr = Module._yuki_guest_stats_json();
                    if (statsStr) {
                        postLog('[worker] Stats: ' + UTF8ToString(statsStr), false);
                    }
                } catch (err) {
                    var exitStatus = (err && (err.name === 'ExitStatus' || typeof err.status === 'number')) ? err.status : null;
                    if (exitStatus !== null) {
                        postLog('[worker] ExitStatus: ' + exitStatus, true);
                        postStatus('Error: ExitStatus ' + exitStatus);
                    } else {
                        postLog('[worker] Exception: ' + err + '\n' + (err.stack || ''), true);
                        postStatus('Error: ' + (err && err.message ? err.message : String(err)));
                    }
                }
            }
        };

        // The page serves the engine wasm as two halves (host file-size limit) and reassembles them in memory,
        // so instantiate straight from the transferred bytes instead of fetching yukicomp-lifted.wasm.
        if (e.data.wasmBinary) {
            const wasmBytes = new Uint8Array(e.data.wasmBinary);
            self.Module.instantiateWasm = function(imports, successCallback) {
                WebAssembly.instantiate(wasmBytes, imports).then(
                    (result) => successCallback(result instanceof WebAssembly.Instance ? result : result.instance),
                    (err) => {
                        const msg = 'wasm instantiate failed: ' + ((err && err.message) || err);
                        postLog('[worker] ' + msg, true);
                        self.postMessage({ type: 'fatal', text: msg });
                    }
                );
                return {};
            };
        }

                importScripts('yukicomp-lifted.js');
    }
};
}
