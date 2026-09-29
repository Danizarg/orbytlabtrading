import { NextResponse, type NextRequest } from 'next/server';
import {
  allowedImageType,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_REDIRECTS,
  IMAGE_TIMEOUT_MS,
  parseProxyTarget,
} from '@/lib/server/image-proxy';

export const maxDuration = 10;

function reject(status: number) {
  return new NextResponse(null, { status, headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600' } });
}

/**
 * GET /api/v1/img?u=<https image url> — token-logo proxy for hosts that block
 * cross-origin image loads. Public https raster images only, size-capped,
 * redirects re-validated, long CDN cache.
 */
export async function GET(request: NextRequest) {
  let target = parseProxyTarget(request.nextUrl.searchParams.get('u'));
  if (!target) return reject(400);

  let res: Response | undefined;
  for (let hop = 0; hop <= IMAGE_MAX_REDIRECTS; hop++) {
    try {
      res = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1', 'user-agent': 'ORBYT-logo-proxy/1.0' },
        cache: 'no-store',
      });
    } catch {
      return reject(502);
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      target = next ? parseProxyTarget(new URL(next, target).href) : null;
      if (!target) return reject(400);
      continue;
    }
    break;
  }
  if (!res || !res.ok || !res.body) return reject(404);

  const type = allowedImageType(res.headers.get('content-type'));
  if (!type) return reject(415);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) return reject(413);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > IMAGE_MAX_BYTES) {
      await reader.cancel();
      return reject(413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}
