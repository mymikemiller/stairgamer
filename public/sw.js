// The Android share sheet POSTs the shared photo to /share-target. A POST
// cannot be read by the page it lands on, so the service worker intercepts it,
// stashes the file, and redirects to the app, which then picks it up.
const SHARE_CACHE = "stairgamer-share";
const SHARE_KEY = "/__shared-image";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share-target") return;

  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const file = form.get("image") || form.get("file") || form.get("photo");

      if (file && file.size) {
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(SHARE_KEY, new Response(file, {
          headers: {
            "Content-Type": file.type || "image/jpeg",
            // lastModified survives here as the fallback capture date when the
            // photo carries no EXIF.
            "X-Last-Modified-Ms": String(file.lastModified || ""),
          },
        }));
        return Response.redirect("/?shared=1", 303);
      }
    } catch (err) {
      console.error("share-target failed", err);
    }
    return Response.redirect("/?shared=0", 303);
  })());
});
