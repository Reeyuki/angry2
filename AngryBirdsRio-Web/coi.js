(() => {
  "use strict";
  if (typeof window === "undefined") {
    const q = new URL(self.location.href).searchParams;
    const coep = q.get("coep") === "credentialless" ? "credentialless" : "require-corp";
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener("fetch", (e) => {
      const r = e.request;
      if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
      const req = coep === "credentialless" && r.mode === "no-cors" ? new Request(r, { credentials: "omit" }) : r;
      e.respondWith(fetch(req).then((res) => {
        if (res.status === 0) return res;
        const h = new Headers(res.headers);
        h.set("x-coi-orig-coop", res.headers.get("cross-origin-opener-policy") || "(none)");
        h.set("x-coi-orig-coep", res.headers.get("cross-origin-embedder-policy") || "(none)");
        h.set("Cross-Origin-Embedder-Policy", coep);
        h.set("Cross-Origin-Opener-Policy", "same-origin");
        if (!h.has("Cross-Origin-Resource-Policy")) h.set("Cross-Origin-Resource-Policy", "cross-origin");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      }));
    });
    return;
  }

  const script = document.currentScript && document.currentScript.src;
  const url = new URL(location.href);
  const diag = { isolated: self.crossOriginIsolated === true, secure: self.isSecureContext, sw: "serviceWorker" in navigator,
    sab: typeof SharedArrayBuffer !== "undefined", framed: window.top !== window, reason: "", headers: {}, action: "" };
  window.__coi = diag;

  function show(force) {
    if (diag.isolated && !force && url.searchParams.get("diag") !== "1") return;
    const draw = () => {
      let el = document.getElementById("coi-diag");
      if (!el) {
        el = document.createElement("pre");
        el.id = "coi-diag";
        el.style.cssText = "position:fixed;left:8px;bottom:8px;max-width:min(96vw,680px);margin:0;padding:8px 10px;z-index:2147483647;" +
          "font:12px/1.4 monospace;color:#fff;background:rgba(0,0,0,.82);border:1px solid " + (diag.isolated ? "#4c4" : "#f55") +
          ";white-space:pre-wrap;pointer-events:auto";
        (document.body || document.documentElement).appendChild(el);
      }
      const L = [diag.isolated ? "Cross-origin isolation: OK" : "Cross-origin isolation: MISSING (SharedArrayBuffer unavailable, mouse/audio will not work)"];
      L.push("crossOriginIsolated=" + diag.isolated + "  SharedArrayBuffer=" + diag.sab + "  secureContext=" + diag.secure +
        "  serviceWorker=" + diag.sw + "  framed=" + diag.framed);
      if (diag.reason) L.push("Reason: " + diag.reason);
      if (diag.action) L.push("Action: " + diag.action);
      const h = diag.headers;
      if (h.status) {
        L.push("Server response for " + url.pathname + " (status " + h.status + "):");
        L.push("  Cross-Origin-Opener-Policy   : " + h.serverCoop);
        L.push("  Cross-Origin-Embedder-Policy : " + h.serverCoep);
        L.push("  Delivered to page            : COOP=" + h.coop + " COEP=" + h.coep);
        L.push("  content-type=" + h.type + "  server=" + h.server + "  cf-cache-status=" + h.cache);
      }
      if (!diag.isolated) L.push("Fix: serve every file with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`" +
        " (Cloudflare Pages: a `_headers` file at the deploy root), or open the game as its own top-level page.");
      el.textContent = L.join("\n");
    };
    if (document.body) draw(); else document.addEventListener("DOMContentLoaded", draw);
  }

  function probe() {
    return fetch(location.href, { cache: "no-store" }).then((r) => {
      const g = (n) => r.headers.get(n) || "(none)";
      diag.headers = { status: r.status, coop: g("cross-origin-opener-policy"), coep: g("cross-origin-embedder-policy"),
        serverCoop: r.headers.get("x-coi-orig-coop") || g("cross-origin-opener-policy"),
        serverCoep: r.headers.get("x-coi-orig-coep") || g("cross-origin-embedder-policy"),
        type: g("content-type"), server: g("server"), cache: g("cf-cache-status") };
    }).catch(() => {});
  }

  function finish() {
    probe().then(() => {
      if (!diag.isolated) console.warn("[coi] not cross-origin isolated: " + diag.reason);
      show();
    });
  }

  if (diag.isolated) { try { sessionStorage.removeItem("coi_reload"); } catch (e) {} finish(); return; }
  if (diag.framed) {
    diag.reason = "page is inside a frame; the embedding page must itself be isolated and the iframe needs allow=\"cross-origin-isolated\", or open the game in its own tab";
    finish(); return;
  }
  if (!diag.secure) { diag.reason = "not a secure context (use https:// or localhost)"; finish(); return; }
  if (!diag.sw) { diag.reason = "service workers are unavailable (private mode or blocked); the host must send the headers"; finish(); return; }
  if (url.searchParams.get("coi") === "0") { diag.reason = "service worker disabled by ?coi=0"; finish(); return; }

  const credentialless = "credentialless" in HTMLIFrameElement.prototype;
  const swUrl = new URL(script || "coi.js", location.href);
  swUrl.search = credentialless ? "?coep=credentialless" : "?coep=require-corp";
  const base = new URL("./", swUrl).pathname;
  let tries = 0;
  try { tries = parseInt(sessionStorage.getItem("coi_reload") || "0", 10); } catch (e) {}
  navigator.serviceWorker.register(swUrl.href, { scope: base }).then((reg) => {
    const reload = () => {
      if (tries >= 2) {
        diag.reason = "service worker is active but the page is still not isolated after " + tries + " reloads (hard reload / clear site data, or a cached page without the worker)";
        finish(); return;
      }
      try { sessionStorage.setItem("coi_reload", String(tries + 1)); } catch (e) {}
      diag.action = "reloading once to activate the isolation service worker";
      location.reload();
    };
    if (reg.active && !navigator.serviceWorker.controller) { reload(); return; }
    if (navigator.serviceWorker.controller) { reload(); return; }
    const w = reg.installing || reg.waiting;
    if (w) w.addEventListener("statechange", () => { if (w.state === "activated") reload(); });
    else reload();
  }).catch((e) => { diag.reason = "service worker registration failed: " + e.message; finish(); });
})();
