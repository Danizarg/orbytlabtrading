import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CapabilitiesProvider } from '@/client/capabilities';
import { deriveCapabilities, type Capabilities } from '@/lib/config/capabilities';

/** children passed positionally to createElement (optional in this signature). */
const Caps = CapabilitiesProvider as ComponentType<{ value: Capabilities; children?: ReactNode }>;

const { TradePanel } = await import('../TradePanel');

function render(props: Parameters<typeof TradePanel>[0]) {
  const caps = deriveCapabilities({ helius: false, birdeye: false, solanatracker: false, coingecko: null, jupiter: false, customRpc: false });
  const tree = createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Caps, { value: caps }, createElement(TradePanel, props)));
  return renderToString(tree);
}

describe('TradePanel (server render, no wallet)', () => {
  const html = render({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'Bonk', decimals: 5, priceUsd: 0.0000036 });

  it('offers "Connect wallet" as the primary action', () => {
    expect(html).toContain('Connect wallet');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it('renders the Market form with the default presets and slippage', () => {
    expect(html).toContain('Market');
    for (const preset of ['0.1 SOL', '0.5 SOL', '1 SOL', '5 SOL', '1%', '5%', '10%', '20%']) expect(html).toContain(preset);
    expect(html).toContain('Open in Jupiter');
  });

  it('has no Limit placeholder, deep-link-only copy or disclaimers', () => {
    expect(html).not.toMatch(/Limit/);
    expect(html).not.toMatch(/coming soon|never signs|holds funds|Opens jup\.ag|new tab/i);
  });

  it('shows no wallet data before a wallet connects', () => {
    expect(html).not.toMatch(/Holding|Avg cost|Balance/);
  });
});
