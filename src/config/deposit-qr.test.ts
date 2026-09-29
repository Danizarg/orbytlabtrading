import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { SITE } from './site';

/**
 * Guard for the central deposit QR code: the image shown to depositors must
 * encode exactly the address printed next to it. If either changes without the
 * other, this test fails.
 */
describe('deposit QR code', () => {
  it('encodes the central deposit address', () => {
    const png = PNG.sync.read(readFileSync(join(process.cwd(), 'public/deposit-qr.png')));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'attemptBoth' });
    expect(decoded).not.toBeNull();
    // Accept a bare address or a solana: URI, but the address itself must match exactly.
    const payload = decoded?.data.replace(/^solana:/, '').split('?')[0];
    expect(payload).toBe(SITE.depositAddress);
  });
});
