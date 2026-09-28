'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { isProviderError } from '@/lib/net/errors';
import { POLL, qk } from '../query';
import { server } from '../sources';

/**
 * ORBYT server health (GET /api/v1/health, every 60 s): which keyed providers
 * are configured (booleans / plan names only, never secrets), which RPC kind
 * backs server reads, and per-provider server-side health (last OK, errors,
 * cooldowns). Result is Sourced<HealthReport>.
 */
export function useProviderHealth() {
  return useQuery({
    queryKey: qk.health(),
    queryFn: ({ signal }) => server.health(signal),
    refetchInterval: POLL.slow,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    // A missing route or bad request will not fix itself on retry.
    retry: (failureCount, error) =>
      failureCount < 1 && !(isProviderError(error) && (error.code === 'not_found' || error.code === 'unsupported' || error.code === 'not_configured')),
  });
}
