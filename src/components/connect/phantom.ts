/** Phantom install / mobile deep-link helpers (no wallet detected in this browser). */

export const PHANTOM_DOWNLOAD_URL = 'https://phantom.app/download';

/**
 * Phantom universal link that opens `currentUrl` inside Phantom's in-app
 * browser, where the wallet is available to the page.
 * https://docs.phantom.com/phantom-deeplinks/other-methods/browse
 */
export function phantomBrowseLink(currentUrl: string, origin: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(currentUrl)}?ref=${encodeURIComponent(origin)}`;
}

/** Phones and tablets, where browser extensions are unavailable and wallets live in apps. */
export function isMobileUserAgent(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false;
  return /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(userAgent);
}
