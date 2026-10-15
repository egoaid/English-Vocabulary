/* The cache version follows APP_VERSION in app.js: app.js registers "sw.js?v=<APP_VERSION>".
   FALLBACK_VERSION is used only when the worker is started without that query
   (e.g. an older page registering plain "sw.js") and must match APP_VERSION. */
const FALLBACK_VERSION = "1.8.1";
const SW_VERSION = (new URL(self.location.href)).searchParams.get("v") || FALLBACK_VERSION;
const CACHE_NAME = "english-learning-studio-v" + SW_VERSION;
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./reading-1.html",
  "./reading-2.html",
  "./reading-3.html",
  "./reading-4.html",
  "./reading-5.html",
  "./reading-6.html",
  "./reading-7.html",
  "./reading-8.html",
  "./reading-9.html",
  "./reading-10.html",
  "./reading-11.html",
  "./quiz.html",
  "./vocab-words.html",
  "./vocab-idioms.html",
  "./styles.css",
  "./app.js",
  "./quiz.js",
  "./data/words.json",
  "./data/idioms.json",
  "./data/quiz.json",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon-180.png",
  "./icons/favicon-32.png",
  "./icons/favicon-16.png",
  "./icons/og-image.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
