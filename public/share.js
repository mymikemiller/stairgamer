// Reads the photo the service worker stashed from the Android share sheet.
const SHARE_CACHE = "stairgamer-share";
const SHARE_KEY = "/__shared-image";

export async function takeSharedImage() {
  if (!("caches" in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match(SHARE_KEY);
  if (!res) return null;

  // Consume it, so a reload doesn't re-submit the same photo.
  await cache.delete(SHARE_KEY);

  const blob = await res.blob();
  const lastModified = Number(res.headers.get("X-Last-Modified-Ms")) || Date.now();
  return new File([blob], "shared.jpg", {
    type: res.headers.get("Content-Type") || "image/jpeg",
    lastModified,
  });
}
