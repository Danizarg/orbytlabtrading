import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { CapabilitiesProvider } from '@/client/capabilities';
import { AppShell } from '@/components/shell/AppShell';
import { SITE } from '@/config/site';
import { serverCapabilities } from '@/lib/server/env';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap', axes: ['opsz'] });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: `${SITE.name} — ${SITE.tagline}`, template: `%s · ${SITE.name}` },
  description: 'Live Solana token discovery, launch scanner, on-chain charts, real transaction feeds and wallet analytics.',
  alternates: { canonical: '/' },
  openGraph: {
    title: SITE.fullName,
    description: 'Live Solana token discovery, launch scanner, on-chain charts and wallet analytics.',
    url: SITE.url,
    siteName: SITE.fullName,
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0c10',
  colorScheme: 'dark',
};

// Capabilities depend on runtime env vars, so render per request.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  const capabilities = serverCapabilities();
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh bg-bg text-fg">
        <CapabilitiesProvider value={capabilities}>
          <Providers>
            <AppShell>{children}</AppShell>
          </Providers>
        </CapabilitiesProvider>
      </body>
    </html>
  );
}
