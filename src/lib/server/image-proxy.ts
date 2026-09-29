import 'server-only';

/**
 * Validation helpers for the token-logo proxy (/api/v1/img). Token metadata
 * points at arbitrary hosts; several send `Cross-Origin-Resource-Policy:
 * same-origin`, which browsers enforce on cross-site <img> loads, so logos
 * disappear. The proxy re-serves only public https raster images.
 */

export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 6_000;
export const IMAGE_MAX_REDIRECTS = 3;

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon']);

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp'];

/** Returns the parsed URL when it is a public https URL safe to fetch, else null. */
export function parseProxyTarget(raw: string | null): URL | null {
  if (!raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || !host.includes('.')) return null;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return null;
  // No IP literals at all (v4 or v6): public logos live on named hosts.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) return null;
  // Numeric-only labels such as 2130706433 or 0x7f.1 are IP encodings.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host)) return null;
  return url;
}

/** Normalized content type if it is an allowed raster image. SVG is refused (can carry script). */
export function allowedImageType(contentType: string | null): string | null {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type && ALLOWED_TYPES.has(type) ? type : null;
}
