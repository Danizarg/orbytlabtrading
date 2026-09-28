'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Capabilities } from '@/lib/config/capabilities';

const CapabilitiesContext = createContext<Capabilities | null>(null);

/** Server capabilities (which keyed providers exist), resolved at render time by the root layout. */
export function CapabilitiesProvider({ value, children }: { value: Capabilities; children: ReactNode }) {
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): Capabilities {
  const ctx = useContext(CapabilitiesContext);
  if (!ctx) throw new Error('useCapabilities must be used inside CapabilitiesProvider');
  return ctx;
}
