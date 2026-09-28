'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/client/api';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Live views poll explicitly via refetchInterval; keep previous data on refetch errors.
            staleTime: 2_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            refetchIntervalInBackground: false,
            retry: (failureCount, error) => {
              if (error instanceof ApiError && (error.status === 400 || error.status === 404)) return false;
              return failureCount < 2;
            },
            retryDelay: (attempt) => Math.min(8_000, 750 * 2 ** attempt),
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
