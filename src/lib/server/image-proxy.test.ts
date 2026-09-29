import { describe, expect, it } from 'vitest';
import { allowedImageType, parseProxyTarget } from './image-proxy';

describe('parseProxyTarget', () => {
  it('accepts public https image hosts', () => {
    expect(parseProxyTarget('https://ipfs.io/ipfs/QmYtULBSGFSR2Xxbj8WpWfD8CzrBzPi9RXQAtC7EJ1dr4m')?.hostname).toBe('ipfs.io');
    expect(parseProxyTarget('https://pump.mypinata.cloud/ipfs/bafkrei?img-width=64')?.hostname).toBe('pump.mypinata.cloud');
    expect(parseProxyTarget('https://arweave.net:443/abc')?.hostname).toBe('arweave.net');
  });

  it.each([
    null,
    '',
    'not a url',
    'http://ipfs.io/x',
    'ftp://example.com/x.png',
    'https://localhost/x.png',
    'https://127.0.0.1/x.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x.png',
    'https://2130706433/x.png',
    'https://0x7f.1/x.png',
    'https://intranet/x.png',
    'https://metadata.google.internal/x',
    'https://printer.local/x.png',
    'https://user:pass@example.com/x.png',
    'https://example.com:8443/x.png',
    `https://example.com/${'a'.repeat(2100)}`,
  ])('rejects %s', (raw) => {
    expect(parseProxyTarget(raw)).toBeNull();
  });
});

describe('allowedImageType', () => {
  it('allows raster images and normalizes parameters', () => {
    expect(allowedImageType('image/png')).toBe('image/png');
    expect(allowedImageType('image/webp; charset=binary')).toBe('image/webp');
    expect(allowedImageType('IMAGE/JPEG')).toBe('image/jpeg');
  });

  it('refuses SVG, HTML and missing types', () => {
    expect(allowedImageType('image/svg+xml')).toBeNull();
    expect(allowedImageType('text/html')).toBeNull();
    expect(allowedImageType(null)).toBeNull();
  });
});
