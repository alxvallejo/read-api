const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

/**
 * Extract a usable image URL from a Reddit post object.
 * Mirrors the original logic from server.js so share-preview behavior is unchanged.
 *
 * Returns the highest-quality preview if available, falling back to the
 * thumbnail, then to the local hero image. Reddit escapes ampersands in
 * preview URLs (&amp;) — we unescape them so the URL works in <img src>.
 */
function pickPreviewImage(post) {
  try {
    const preview = post && post.preview && post.preview.images && post.preview.images[0];
    if (preview && preview.source && preview.source.url) {
      return preview.source.url.replace(/&amp;/g, '&');
    }
  } catch (_) {}
  const thumb = post && post.thumbnail;
  if (thumb && /^https?:\/\//.test(thumb)) return thumb;
  return PUBLIC_BASE_URL ? PUBLIC_BASE_URL + '/reddzit-hero.png' : '/reddzit-hero.png';
}

/**
 * Like pickPreviewImage but returns null instead of the hero fallback.
 * Used by the news feed where we want to know "does this post actually have a usable image?"
 * so the frontend can render a text-only tile instead of a hero placeholder.
 */
function pickPreviewImageOrNull(post) {
  try {
    const preview = post && post.preview && post.preview.images && post.preview.images[0];
    if (preview && preview.source && preview.source.url) {
      return preview.source.url.replace(/&amp;/g, '&');
    }
  } catch (_) {}
  const thumb = post && post.thumbnail;
  if (thumb && /^https?:\/\//.test(thumb)) return thumb;
  return null;
}

module.exports = { pickPreviewImage, pickPreviewImageOrNull };
