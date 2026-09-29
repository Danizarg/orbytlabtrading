import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: unknown }) => createElement('a', { href }, children as never) }));

const { ConnectWalletButton } = await import('./ConnectWalletButton');

describe('ConnectWalletButton (server render)', () => {
  it('renders the disconnected Connect control with no wallet data or browser APIs', () => {
    const client = new QueryClient();
    const html = renderToString(createElement(QueryClientProvider, { client }, createElement(ConnectWalletButton)));
    expect(html).toContain('aria-label="Connect wallet"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('Connect');
    expect(html).not.toContain('<dialog');
    expect(html).not.toMatch(/SOL|Signed in/);
  });
});
