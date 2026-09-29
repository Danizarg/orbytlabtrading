import { describe, expect, it } from 'vitest';
import { isMobileUserAgent, phantomBrowseLink } from './phantom';

describe('phantomBrowseLink', () => {
  it('encodes the page and the ref origin', () => {
    expect(phantomBrowseLink('https://www.orbytai.org/trade/So11111111111111111111111111111111111111112?x=1&y=2', 'https://www.orbytai.org')).toBe(
      'https://phantom.app/ul/browse/https%3A%2F%2Fwww.orbytai.org%2Ftrade%2FSo11111111111111111111111111111111111111112%3Fx%3D1%26y%3D2?ref=https%3A%2F%2Fwww.orbytai.org',
    );
  });
});

describe('isMobileUserAgent', () => {
  it('detects phones and tablets only', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe(true);
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toBe(true);
    expect(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toBe(false);
    expect(isMobileUserAgent(undefined)).toBe(false);
  });
});
