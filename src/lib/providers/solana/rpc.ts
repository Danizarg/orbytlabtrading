import type { ProviderId } from '@/lib/core/providers';
import { chunk, num } from '@/lib/core/chain';
import { isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher } from '@/lib/net/types';
import type { RpcParsedTransaction, RpcUiTokenAmount } from '@/lib/analytics/tx-types';

/**
 * Isomorphic Solana JSON-RPC 2.0 client (POST). The server passes
 * SOLANA_RPC_URL / a Helius URL with the server fetcher; the browser passes
 * publicnode with the browser fetcher for light reads.
 *
 * Live-verified quirks (2026-09-28):
 * - Transaction v1 (SIMD-0385) is live on mainnet: every getTransaction /
 *   getTransactionsForAddress must send `maxSupportedTransactionVersion: 1`,
 *   otherwise v1 transactions fail with -32015.
 * - Public mainnet per-IP per-method limits per 10 s: getTransaction,
 *   getSignaturesForAddress, getTokenAccountsByOwner 10; getMultipleAccounts
 *   50; getBalance/getTokenSupply 150; getTokenLargestAccounts 0 (always 429).
 * - publicnode rejects "indexed" methods (getTokenSupply,
 *   getTokenAccountsByOwner, getProgramAccounts) and getTokenLargestAccounts
 *   with HTTP 403.
 * - Helius accepts JSON-RPC batch arrays of up to 100 getTransaction calls;
 *   getTransactionsForAddress is Helius-only and cannot be batched.
 *
 * URLs may carry `?api-key=`, so every request passes a `label` and no error
 * produced here ever contains the URL.
 */

export type RpcProviderId = Extract<ProviderId, 'solana-rpc' | 'helius'>;
export type RpcCommitment = 'confirmed' | 'finalized';
export type RpcAccountEncoding = 'base64' | 'jsonParsed';

/** jsonParsed account data (token program accounts, mints, …). */
export interface RpcParsedAccountData {
  program: string;
  parsed: unknown;
  space?: number;
}

export interface RpcAccountInfo {
  /** Owning program id. */
  owner: string;
  /** Lamports held by the account. */
  lamports: number;
  executable: boolean;
  space?: number;
  /**
   * base64 encoding: `[data, 'base64']`. jsonParsed: a parsed object, or the
   * `[data, 'base64']` fallback for accounts the node cannot parse
   * (program-owned accounts such as pump.fun bonding curves).
   */
  data: [string, string] | RpcParsedAccountData;
}

export interface RpcKeyedAccount {
  pubkey: string;
  account: RpcAccountInfo;
}

export interface RpcSignatureInfo {
  signature: string;
  slot: number;
  /** UNIX seconds; null when the node has no block time. */
  blockTime: number | null;
  /** null when the transaction succeeded. */
  err: unknown;
  memo: string | null;
  confirmationStatus?: string | null;
}

export interface RpcTokenLargestAccount {
  /** Token ACCOUNT address (not the owner wallet). */
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString?: string;
}

/** Per-signature outcome of `getTransactions` (aligned with the requested order). */
export type TxFetchResult =
  | { signature: string; ok: true; /** null = not found at this commitment. */ tx: RpcParsedTransaction | null }
  | { signature: string; ok: false; error: ProviderError };

export interface SignaturesQuery {
  /** 1–1000 (upstream default 1000). */
  limit?: number;
  /** Start searching backwards from this signature (exclusive). */
  before?: string;
  /** Stop at this signature (exclusive). */
  until?: string;
}

export interface TransactionsForAddressOptions {
  transactionDetails?: 'full' | 'signatures';
  sortOrder?: 'asc' | 'desc';
  /** 1–1000. */
  limit?: number;
  /** Opaque 'slot:position' cursor from a previous page. */
  paginationToken?: string;
  /** Maps to `filters.status`. */
  status?: 'succeeded' | 'failed';
  /** Extra raw Helius filters (slot, blockTime, tokenAccounts, …), merged under `filters`. */
  filters?: Record<string, unknown>;
}

export interface TransactionsForAddressPage<T> {
  data: T[];
  /** Absent when history is exhausted. */
  paginationToken?: string;
}

export interface RpcClient {
  readonly provider: RpcProviderId;
  readonly label: string;
  /** Raw JSON-RPC call returning `result` (errors mapped to ProviderError). */
  call<T = unknown>(method: string, params: unknown[], signal?: AbortSignal): Promise<T>;
  getAccountInfo(address: string, opts?: { encoding?: RpcAccountEncoding }, signal?: AbortSignal): Promise<RpcAccountInfo | null>;
  /** Up to 100 addresses; result aligned with the input (null = account missing). */
  getMultipleAccounts(addresses: string[], opts?: { encoding?: RpcAccountEncoding }, signal?: AbortSignal): Promise<Array<RpcAccountInfo | null>>;
  /** Lamports. */
  getBalance(address: string, signal?: AbortSignal): Promise<number>;
  getTokenSupply(mint: string, signal?: AbortSignal): Promise<RpcUiTokenAmount>;
  /** jsonParsed token accounts of `owner` for ONE token program (includes zero balances). */
  getTokenAccountsByOwner(owner: string, programId: string, signal?: AbortSignal): Promise<RpcKeyedAccount[]>;
  /** Newest first; includes failed transactions (err !== null). */
  getSignaturesForAddress(address: string, query?: SignaturesQuery, signal?: AbortSignal): Promise<RpcSignatureInfo[]>;
  /** jsonParsed, maxSupportedTransactionVersion 1, commitment confirmed. null = not found. */
  getTransaction(signature: string, signal?: AbortSignal): Promise<RpcParsedTransaction | null>;
  /**
   * Many transactions: one JSON-RPC batch per 100 signatures on Helius;
   * otherwise individual calls with concurrency 3 that stop issuing new
   * requests after a rate limit (the public RPC allows 10 per 10 s).
   * Never throws for per-signature failures (except aborts).
   */
  getTransactions(signatures: string[], signal?: AbortSignal): Promise<TxFetchResult[]>;
  /** Top-20 token accounts. The public RPC and publicnode block this method ('unsupported'). */
  getTokenLargestAccounts(mint: string, signal?: AbortSignal): Promise<RpcTokenLargestAccount[]>;
  /** Helius-only indexed history; 'unsupported' on other providers. */
  getTransactionsForAddress(
    address: string,
    opts: TransactionsForAddressOptions & { transactionDetails: 'signatures' },
    signal?: AbortSignal,
  ): Promise<TransactionsForAddressPage<RpcSignatureInfo>>;
  getTransactionsForAddress(
    address: string,
    opts?: TransactionsForAddressOptions & { transactionDetails?: 'full' },
    signal?: AbortSignal,
  ): Promise<TransactionsForAddressPage<RpcParsedTransaction>>;
}

export interface RpcClientOptions {
  url: string;
  fetcher: JsonFetcher;
  provider?: RpcProviderId;
  /** Used in every error message instead of the URL. */
  label?: string;
  commitment?: RpcCommitment;
  /** Per-request timeout (ms) passed to the fetcher. */
  timeoutMs?: number;
}

export const TRANSACTION_REQUEST_CONFIG = {
  encoding: 'jsonParsed',
  maxSupportedTransactionVersion: 1,
  commitment: 'confirmed',
} as const;

export const MAX_MULTIPLE_ACCOUNTS = 100;
export const MAX_TRANSACTION_BATCH = 100;
/** Concurrency for individual getTransaction calls on non-batching endpoints. */
export const SEQUENTIAL_TX_CONCURRENCY = 3;

/**
 * Methods known (live-verified) to be refused by public endpoints. Calling
 * them anyway earns a guaranteed 429/403, which would also push the whole
 * provider into the transport's cooldown, so they fail fast locally.
 */
const PUBLIC_MAINNET_BLOCKED = new Set(['getTokenLargestAccounts', 'getTransactionsForAddress']);
const BLOCKED_BY_HOST: Record<string, ReadonlySet<string>> = {
  'api.mainnet-beta.solana.com': PUBLIC_MAINNET_BLOCKED,
  'api.mainnet.solana.com': PUBLIC_MAINNET_BLOCKED,
  'solana-rpc.publicnode.com': new Set([
    'getTokenLargestAccounts',
    'getTokenSupply',
    'getTokenAccountsByOwner',
    'getProgramAccounts',
    'getTransactionsForAddress',
  ]),
};

const HELIUS_ONLY = new Set(['getTransactionsForAddress']);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip anything that looks like a credential from upstream error text and bound its length. */
function sanitize(message: string): string {
  return message
    .replace(/api[-_]?key=[^&\s"']+/gi, 'api-key=***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Map a JSON-RPC `error` object to a ProviderError. */
export function mapRpcError(provider: RpcProviderId, label: string, method: string, error: unknown): ProviderError {
  const code = isRecord(error) ? num(error.code) : undefined;
  const rawMessage = isRecord(error) && typeof error.message === 'string' ? error.message : '';
  const message = sanitize(rawMessage);
  const where = `${label} ${method}`;
  if (code === 429 || code === -32429 || /too many requests|rate.?limit/i.test(rawMessage)) {
    return new ProviderError(provider, 'rate_limited', `${where}: rate limited`, { status: 429 });
  }
  if (code === -32015) {
    return new ProviderError(provider, 'unsupported', `${where}: transaction version not supported (${message || code})`);
  }
  if (code === -32601) {
    return new ProviderError(provider, 'unsupported', `${where}: method not available on this endpoint`);
  }
  if (code === 403 || /personal token|request blocked|forbidden/i.test(rawMessage)) {
    return new ProviderError(provider, 'unsupported', `${where}: refused by this endpoint${message ? ` (${message})` : ''}`);
  }
  if (code === 401 || code === -32401 || /api key|unauthori[sz]ed/i.test(rawMessage)) {
    return new ProviderError(provider, 'not_configured', `${where}: missing or invalid API key`);
  }
  return new ProviderError(provider, 'http', `${where}: RPC error ${code ?? 'unknown'}${message ? ` ${message}` : ''}`);
}

function parseAccount(value: unknown): RpcAccountInfo | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.owner !== 'string') return undefined;
  const data = value.data;
  const isB64 = Array.isArray(data) && typeof data[0] === 'string';
  const isParsed = isRecord(data) && typeof data.program === 'string';
  if (!isB64 && !isParsed) return undefined;
  return {
    owner: value.owner,
    lamports: num(value.lamports) ?? 0,
    executable: value.executable === true,
    space: num(value.space),
    data: isB64 ? [String(data[0]), String(data[1] ?? 'base64')] : (data as unknown as RpcParsedAccountData),
  };
}

/** Structural check of a jsonParsed getTransaction result. */
export function parseTransaction(value: unknown): RpcParsedTransaction | undefined {
  if (!isRecord(value)) return undefined;
  const transaction = value.transaction;
  if (!isRecord(transaction) || !Array.isArray(transaction.signatures)) return undefined;
  const message = transaction.message;
  if (!isRecord(message) || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) return undefined;
  if (value.meta !== null && !isRecord(value.meta)) return undefined;
  if (typeof value.slot !== 'number') return undefined;
  return value as unknown as RpcParsedTransaction;
}

function parseSignatureInfo(value: unknown): RpcSignatureInfo | undefined {
  if (!isRecord(value) || typeof value.signature !== 'string') return undefined;
  const blockTime = num(value.blockTime);
  return {
    signature: value.signature,
    slot: num(value.slot) ?? 0,
    blockTime: blockTime ?? null,
    err: value.err ?? null,
    memo: typeof value.memo === 'string' ? value.memo : null,
    confirmationStatus: typeof value.confirmationStatus === 'string' ? value.confirmationStatus : null,
  };
}

/** Raw bytes of an account fetched with base64 encoding (or a jsonParsed base64 fallback). */
export function accountBytes(account: RpcAccountInfo | null | undefined): Uint8Array | undefined {
  if (!account || !Array.isArray(account.data)) return undefined;
  const [b64, encoding] = account.data;
  if (encoding !== 'base64') return undefined;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** `data.parsed` of a jsonParsed account as `{ program, type, info }`. */
export function accountParsedInfo(
  account: RpcAccountInfo | null | undefined,
): { program: string; type?: string; info: Record<string, unknown> } | undefined {
  if (!account || Array.isArray(account.data)) return undefined;
  const parsed = account.data.parsed;
  if (!isRecord(parsed) || !isRecord(parsed.info)) return undefined;
  return { program: account.data.program, type: typeof parsed.type === 'string' ? parsed.type : undefined, info: parsed.info };
}

export function createRpcClient(opts: RpcClientOptions): RpcClient {
  const { url, fetcher } = opts;
  const provider: RpcProviderId = opts.provider ?? 'solana-rpc';
  const label = opts.label ?? (provider === 'helius' ? 'Helius RPC' : 'Solana RPC');
  const commitment: RpcCommitment = opts.commitment ?? 'confirmed';
  const blocked = BLOCKED_BY_HOST[hostOf(url)];

  const malformed = (method: string, detail: string) => new ProviderError(provider, 'malformed', `${label} ${method}: ${detail}`);

  function assertAvailable(method: string) {
    if (HELIUS_ONLY.has(method) && provider !== 'helius') {
      throw new ProviderError(provider, 'unsupported', `${label} ${method}: Helius-only method`);
    }
    if (blocked?.has(method)) {
      throw new ProviderError(provider, 'unsupported', `${label} ${method}: not available on this public endpoint`);
    }
  }

  /** Transport errors: re-label auth/forbidden responses (their JSON-RPC body is not visible here). */
  function mapTransportError(error: unknown, method: string): unknown {
    if (!isProviderError(error) || error.code !== 'http') return error;
    if (error.status === 401) {
      return new ProviderError(provider, 'not_configured', `${label} ${method}: missing or invalid API key`, { status: 401, cause: error });
    }
    if (error.status === 403) {
      return new ProviderError(provider, 'unsupported', `${label} ${method}: refused by this endpoint (HTTP 403)`, { status: 403, cause: error });
    }
    return error;
  }

  async function post(method: string, body: unknown, signal: AbortSignal | undefined, timeoutMs?: number): Promise<unknown> {
    try {
      return await fetcher<unknown>(provider, url, {
        method: 'POST',
        body,
        label: `${label} ${method}`,
        retries: 1,
        timeoutMs: timeoutMs ?? opts.timeoutMs,
        notFoundAs404: true,
        signal,
      });
    } catch (error) {
      throw mapTransportError(error, method);
    }
  }

  async function call<T = unknown>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    assertAvailable(method);
    // Constant id: identical concurrent requests can be de-duplicated by the transport.
    const body = await post(method, { jsonrpc: '2.0', id: 1, method, params }, signal);
    if (!isRecord(body)) throw malformed(method, 'invalid JSON-RPC response');
    if (body.error !== undefined && body.error !== null) throw mapRpcError(provider, label, method, body.error);
    if (!('result' in body)) throw malformed(method, 'missing result');
    return body.result as T;
  }

  type BatchItem = { ok: true; result: unknown } | { ok: false; error: ProviderError };

  async function callBatch(method: string, paramsList: unknown[][], signal?: AbortSignal): Promise<BatchItem[]> {
    assertAvailable(method);
    const body = await post(
      method,
      paramsList.map((params, id) => ({ jsonrpc: '2.0', id, method, params })),
      signal,
      opts.timeoutMs ?? 30_000,
    );
    if (isRecord(body) && body.error) throw mapRpcError(provider, label, method, body.error);
    if (!Array.isArray(body)) throw malformed(method, 'batch response is not an array');
    const byId = new Map<number, Record<string, unknown>>();
    for (const item of body) {
      const id = isRecord(item) ? num(item.id) : undefined;
      if (isRecord(item) && id !== undefined) byId.set(id, item);
    }
    return paramsList.map((_, id): BatchItem => {
      const item = byId.get(id);
      if (!item) return { ok: false, error: malformed(method, 'batch item missing') };
      if (item.error !== undefined && item.error !== null) return { ok: false, error: mapRpcError(provider, label, method, item.error) };
      if (!('result' in item)) return { ok: false, error: malformed(method, 'batch item without result') };
      return { ok: true, result: item.result };
    });
  }

  function contextValue(method: string, result: unknown): unknown {
    if (!isRecord(result) || !('value' in result)) throw malformed(method, 'missing result.value');
    return result.value;
  }

  async function getAccountInfo(address: string, o: { encoding?: RpcAccountEncoding } = {}, signal?: AbortSignal) {
    const result = await call('getAccountInfo', [address, { encoding: o.encoding ?? 'base64', commitment }], signal);
    const account = parseAccount(contextValue('getAccountInfo', result));
    if (account === undefined) throw malformed('getAccountInfo', 'unexpected account shape');
    return account;
  }

  async function getMultipleAccounts(addresses: string[], o: { encoding?: RpcAccountEncoding } = {}, signal?: AbortSignal) {
    if (addresses.length === 0) return [];
    if (addresses.length > MAX_MULTIPLE_ACCOUNTS) {
      throw new ProviderError(provider, 'unsupported', `${label} getMultipleAccounts: at most ${MAX_MULTIPLE_ACCOUNTS} addresses per call`);
    }
    const result = await call('getMultipleAccounts', [addresses, { encoding: o.encoding ?? 'base64', commitment }], signal);
    const value = contextValue('getMultipleAccounts', result);
    if (!Array.isArray(value) || value.length !== addresses.length) throw malformed('getMultipleAccounts', 'result not aligned with request');
    return value.map((item) => {
      const account = parseAccount(item);
      if (account === undefined) throw malformed('getMultipleAccounts', 'unexpected account shape');
      return account;
    });
  }

  async function getBalance(address: string, signal?: AbortSignal) {
    const lamports = num(contextValue('getBalance', await call('getBalance', [address, { commitment }], signal)));
    if (lamports === undefined || lamports < 0) throw malformed('getBalance', 'balance is not a number');
    return lamports;
  }

  async function getTokenSupply(mint: string, signal?: AbortSignal): Promise<RpcUiTokenAmount> {
    const value = contextValue('getTokenSupply', await call('getTokenSupply', [mint, { commitment }], signal));
    const decimals = isRecord(value) ? num(value.decimals) : undefined;
    if (!isRecord(value) || typeof value.amount !== 'string' || decimals === undefined) throw malformed('getTokenSupply', 'unexpected supply shape');
    return {
      amount: value.amount,
      decimals,
      uiAmount: num(value.uiAmount) ?? null,
      uiAmountString: typeof value.uiAmountString === 'string' ? value.uiAmountString : undefined,
    };
  }

  async function getTokenAccountsByOwner(owner: string, programId: string, signal?: AbortSignal) {
    const result = await call('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment }], signal);
    const value = contextValue('getTokenAccountsByOwner', result);
    if (!Array.isArray(value)) throw malformed('getTokenAccountsByOwner', 'result.value is not an array');
    const out: RpcKeyedAccount[] = [];
    for (const item of value) {
      if (!isRecord(item) || typeof item.pubkey !== 'string') continue;
      const account = parseAccount(item.account);
      if (account) out.push({ pubkey: item.pubkey, account });
    }
    return out;
  }

  async function getSignaturesForAddress(address: string, query: SignaturesQuery = {}, signal?: AbortSignal) {
    const config: Record<string, unknown> = { commitment };
    if (query.limit !== undefined) config.limit = Math.min(1000, Math.max(1, Math.trunc(query.limit)));
    if (query.before) config.before = query.before;
    if (query.until) config.until = query.until;
    const result = await call('getSignaturesForAddress', [address, config], signal);
    if (!Array.isArray(result)) throw malformed('getSignaturesForAddress', 'result is not an array');
    return result.map(parseSignatureInfo).filter((s): s is RpcSignatureInfo => s !== undefined);
  }

  function toTxResult(signature: string, raw: unknown): TxFetchResult {
    if (raw === null || raw === undefined) return { signature, ok: true, tx: null };
    const tx = parseTransaction(raw);
    return tx ? { signature, ok: true, tx } : { signature, ok: false, error: malformed('getTransaction', 'unexpected transaction shape') };
  }

  async function getTransaction(signature: string, signal?: AbortSignal) {
    const result = await call('getTransaction', [signature, { ...TRANSACTION_REQUEST_CONFIG }], signal);
    const outcome = toTxResult(signature, result);
    if (!outcome.ok) throw outcome.error;
    return outcome.tx;
  }

  const asProviderError = (error: unknown): ProviderError =>
    isProviderError(error) ? error : new ProviderError(provider, 'network', `${label} getTransaction: request failed`, { cause: error });

  /** Errors after which further calls in the same burst are pointless. */
  const isStopError = (error: ProviderError) => error.code === 'rate_limited' || error.code === 'unsupported' || error.code === 'not_configured';

  async function getTransactions(signatures: string[], signal?: AbortSignal): Promise<TxFetchResult[]> {
    const unique = [...new Set(signatures)];
    const results = new Map<string, TxFetchResult>();

    if (provider === 'helius') {
      let stop: ProviderError | undefined;
      for (const group of chunk(unique, MAX_TRANSACTION_BATCH)) {
        if (signal?.aborted) throw new ProviderError(provider, 'aborted', `${label} getTransaction: aborted`);
        if (stop) {
          for (const signature of group) results.set(signature, { signature, ok: false, error: stop });
          continue;
        }
        try {
          const items = await callBatch('getTransaction', group.map((signature) => [signature, { ...TRANSACTION_REQUEST_CONFIG }]), signal);
          group.forEach((signature, i) => {
            const item = items[i];
            if (!item) results.set(signature, { signature, ok: false, error: malformed('getTransaction', 'batch item missing') });
            else results.set(signature, item.ok ? toTxResult(signature, item.result) : { signature, ok: false, error: item.error });
          });
        } catch (error) {
          if (isAbortError(error)) throw error;
          const failure = asProviderError(error);
          for (const signature of group) results.set(signature, { signature, ok: false, error: failure });
          if (isStopError(failure)) stop = failure;
        }
      }
    } else {
      let next = 0;
      let stop: ProviderError | undefined;
      const worker = async () => {
        while (next < unique.length) {
          const signature = unique[next++];
          if (signature === undefined) break;
          if (stop) {
            results.set(signature, { signature, ok: false, error: stop });
            continue;
          }
          try {
            results.set(signature, { signature, ok: true, tx: await getTransaction(signature, signal) });
          } catch (error) {
            if (isAbortError(error)) throw error;
            const failure = asProviderError(error);
            results.set(signature, { signature, ok: false, error: failure });
            if (isStopError(failure)) stop ??= failure;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SEQUENTIAL_TX_CONCURRENCY, unique.length) }, worker));
    }

    return signatures.map(
      (signature) => results.get(signature) ?? { signature, ok: false, error: malformed('getTransaction', 'no result for signature') },
    );
  }

  async function getTokenLargestAccounts(mint: string, signal?: AbortSignal) {
    const value = contextValue('getTokenLargestAccounts', await call('getTokenLargestAccounts', [mint, { commitment }], signal));
    if (!Array.isArray(value)) throw malformed('getTokenLargestAccounts', 'result.value is not an array');
    const out: RpcTokenLargestAccount[] = [];
    for (const item of value) {
      const decimals = isRecord(item) ? num(item.decimals) : undefined;
      if (!isRecord(item) || typeof item.address !== 'string' || typeof item.amount !== 'string' || decimals === undefined) continue;
      out.push({
        address: item.address,
        amount: item.amount,
        decimals,
        uiAmount: num(item.uiAmount) ?? null,
        uiAmountString: typeof item.uiAmountString === 'string' ? item.uiAmountString : undefined,
      });
    }
    return out;
  }

  function getTransactionsForAddress(
    address: string,
    o: TransactionsForAddressOptions & { transactionDetails: 'signatures' },
    signal?: AbortSignal,
  ): Promise<TransactionsForAddressPage<RpcSignatureInfo>>;
  function getTransactionsForAddress(
    address: string,
    o?: TransactionsForAddressOptions & { transactionDetails?: 'full' },
    signal?: AbortSignal,
  ): Promise<TransactionsForAddressPage<RpcParsedTransaction>>;
  async function getTransactionsForAddress(
    address: string,
    o: TransactionsForAddressOptions = {},
    signal?: AbortSignal,
  ): Promise<TransactionsForAddressPage<RpcSignatureInfo> | TransactionsForAddressPage<RpcParsedTransaction>> {
    const method = 'getTransactionsForAddress';
    const details = o.transactionDetails ?? 'full';
    const config: Record<string, unknown> = {
      transactionDetails: details,
      sortOrder: o.sortOrder ?? 'desc',
      limit: Math.min(1000, Math.max(1, Math.trunc(o.limit ?? 100))),
      commitment,
    };
    if (details === 'full') {
      config.encoding = 'jsonParsed';
      config.maxSupportedTransactionVersion = 1;
    }
    if (o.paginationToken) config.paginationToken = o.paginationToken;
    const filters: Record<string, unknown> = { ...o.filters };
    if (o.status) filters.status = o.status;
    if (Object.keys(filters).length > 0) config.filters = filters;

    const result = await call(method, [address, config], signal);
    if (!isRecord(result) || !Array.isArray(result.data)) throw malformed(method, 'result.data is not an array');
    const paginationToken = typeof result.paginationToken === 'string' && result.paginationToken ? result.paginationToken : undefined;
    if (details === 'signatures') {
      const data = result.data.map(parseSignatureInfo).filter((s): s is RpcSignatureInfo => s !== undefined);
      return paginationToken ? { data, paginationToken } : { data };
    }
    const data: RpcParsedTransaction[] = [];
    for (const item of result.data) {
      const tx = parseTransaction(item);
      if (!tx) throw malformed(method, 'unexpected transaction shape');
      data.push(tx);
    }
    return paginationToken ? { data, paginationToken } : { data };
  }

  return {
    provider,
    label,
    call,
    getAccountInfo,
    getMultipleAccounts,
    getBalance,
    getTokenSupply,
    getTokenAccountsByOwner,
    getSignaturesForAddress,
    getTransaction,
    getTransactions,
    getTokenLargestAccounts,
    getTransactionsForAddress,
  };
}
