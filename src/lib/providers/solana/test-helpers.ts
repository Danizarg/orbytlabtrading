/**
 * Test-only helpers for the Solana provider tests (never imported by app code).
 * Fixtures are real captured RPC responses under tests/fixtures/.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderId } from '@/lib/core/providers';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';

export function loadFixture<T = unknown>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', relativePath), 'utf8')) as T;
}

/** JSON-RPC envelope of a fixture file (some wrap it in `{ response }`). */
export function fixtureResponse(relativePath: string): { result?: unknown; error?: unknown } {
  const raw = loadFixture<Record<string, unknown>>(relativePath);
  const envelope = (raw.response ?? raw) as { result?: unknown; error?: unknown };
  return envelope;
}

/** `result` of a fixture's JSON-RPC envelope. */
export function fixtureResult<T = unknown>(relativePath: string): T {
  return fixtureResponse(relativePath).result as T;
}

export function fixtureTransaction(name: string): RpcParsedTransaction {
  return fixtureResult<RpcParsedTransaction>(`solana-rpc/${name}`);
}

export interface RpcRequest {
  method: string;
  params: unknown[];
  id: unknown;
}

export interface RecordedCall {
  provider: ProviderId;
  url: string;
  init: JsonRequest;
  /** Methods in this HTTP call (several for a batch). */
  requests: RpcRequest[];
  batch: boolean;
}

/**
 * Handler for one JSON-RPC request. Return `{ result }` or `{ error }` (a
 * JSON-RPC envelope without id), or throw to simulate a transport failure
 * (e.g. a ProviderError with status 429).
 */
export type RpcHandler = (request: RpcRequest) => unknown;

function asRequest(value: unknown): RpcRequest {
  const v = value as { method?: unknown; params?: unknown; id?: unknown };
  return { method: String(v.method), params: Array.isArray(v.params) ? v.params : [], id: v.id };
}

/**
 * Fake transport routing JSON-RPC bodies by method. Batch bodies (arrays)
 * are answered item by item; `reverseBatch` returns them in reverse order to
 * prove results are matched by id.
 */
export function fakeRpc(handler: RpcHandler, opts: { reverseBatch?: boolean; delayMs?: number } = {}) {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetcher: JsonFetcher = async <T>(provider: ProviderId, url: string, init: JsonRequest = {}): Promise<T> => {
    const body = init.body;
    const batch = Array.isArray(body);
    const requests = batch ? body.map(asRequest) : [asRequest(body)];
    calls.push({ provider, url, init, requests, batch });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      else await Promise.resolve();
      if (!batch) {
        const request = requests[0] as RpcRequest;
        return { jsonrpc: '2.0', id: request.id, ...(handler(request) as object) } as T;
      }
      const answers = requests.map((request) => ({ jsonrpc: '2.0', id: request.id, ...(handler(request) as object) }));
      return (opts.reverseBatch ? answers.reverse() : answers) as T;
    } finally {
      inFlight--;
    }
  };
  return {
    fetcher,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    /** Requests (flattened across batches) for one method. */
    requestsFor(method: string): RpcRequest[] {
      return calls.flatMap((c) => c.requests).filter((r) => r.method === method);
    },
  };
}

/** A copy of a real transaction re-labelled with another signature / block time (for multi-tx orchestration tests). */
export function relabelTransaction(tx: RpcParsedTransaction, signature: string, blockTime: number | null): RpcParsedTransaction {
  return { ...tx, blockTime, transaction: { ...tx.transaction, signatures: [signature] } };
}
