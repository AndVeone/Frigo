/* Service worker: funzionamento offline + notifiche push (Firebase Cloud Messaging) */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
importScripts("./config.js");

const VERSION = "frigo-v1";
const SHELL = ["./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/badge-96.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Mostra subito la copia salvata e la aggiorna in background (stale-while-revalidate).
// Database, login e API passano sempre dalla rete.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const same = url.origin === self.location.origin;
  const sdk = url.origin === "https://www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  const fonts = url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com";
  if (!same && !sdk && !fonts) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: same });
    const network = fetch(e.request).then(r => {
      if (r && (r.ok || r.type === "opaque")) cache.put(e.request, r.clone());
      return r;
    }).catch(() => cached || (same && e.request.mode === "navigate" ? cache.match("./index.html") : undefined));
    return cached || network;
  }));
});

// Notifiche in background: l'SDK mostra la notifica e gestisce il tocco (apre l'app)
const C = self.FRIGO_CONFIG || {};
if (C.firebase && C.firebase.apiKey && !String(C.firebase.apiKey).startsWith("INCOLLA")) {
  firebase.initializeApp(C.firebase);
  firebase.messaging();
}

// Se l'app è già aperta in background, il tocco sulla notifica la porta in primo piano
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
