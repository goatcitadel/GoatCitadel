const BUILD_ID = new URL(self.location.href).searchParams.get("build")?.trim() || "v1";
const CACHE_NAME = `goatcitadel-mission-control-${BUILD_ID}`;
const APP_SHELL_ASSETS = ["/", "/?source=pwa", "/manifest.webmanifest", "/brand/favicon-32x32.png", "/brand/apple-touch-icon.png"];
const STATIC_DESTINATIONS = new Set(["script", "style", "image", "font", "manifest"]);

function isApiLikeRequest(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/health" ||
    url.pathname.includes("/events/stream") ||
    url.pathname.includes("/sse")
  );
}

function shouldCacheStaticAsset(request, url) {
  return APP_SHELL_ASSETS.includes(`${url.pathname}${url.search}`) || APP_SHELL_ASSETS.includes(url.pathname) || STATIC_DESTINATIONS.has(request.destination);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isApiLikeRequest(url)) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(`${url.pathname}${url.search}`)) || (await cache.match("/")) || Response.error();
      }),
    );
    return;
  }

  if (!shouldCacheStaticAsset(event.request, url)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request)
        .then((response) => {
          if (
            !response ||
            response.status !== 200 ||
            response.type !== "basic" ||
            /\bno-store\b/i.test(response.headers.get("cache-control") || "")
          ) {
            return response;
          }
          const responseClone = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => cached || Response.error());
    }),
  );
});
