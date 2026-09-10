const CACHE_NAME = "en-reading-practice-v5";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./reading-1.html",
  "./reading-2.html",
  "./reading-3.html",
  "./reading-4.html",
  "./reading-5.html",
  "./vocab-words.html",
  "./vocab-idioms.html",
  "./styles.css",
  "./app.js",
  "./data/words.json",
  "./data/idioms.json",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
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
