import 'server-only';

/**
 * Pure parsers for Helius responses (standard Solana JSON-RPC + DAS).
 *
 * Everything here is defensive: upstream payloads are `unknown`, numbers may
 * arrive as strings, and optional fields are omitted rather than zero-filled.
 */

import { num } from '@/lib/core/chain';
import { isSolanaAddress, PROGRAMS } from '@/lib/core/solana';
import type { TokenMeta } from '@/lib/core/types';

export type Rec = Record<string, unknown>;

export function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

/** https URLs only (logos are untrusted third-party content; ipfs:// etc. are dropped). */
export function httpsUrl(value: unknown): string | undefined {
  const t = text(value);
  if (!t) return undefined;
  try {
    return new URL(t).protocol === 'https:' ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Drop keys whose value is undefined (the data contract omits unknown fields). */
export function defined<T extends object>(value: T): T {
  const out: Rec = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * Raw integer amount (string or number) → decimal-adjusted number. String
 * inputs go through BigInt so supplies above 2^53 (e.g. BONK) keep their
 * integer part exactly before the final float conversion.
 */
export function rawToUi(raw: unknown, decimals: number): number | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return undefined;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const big = BigInt(raw);
    const scale = 10n ** BigInt(decimals);
    return Number(big / scale) + Number(big % scale) / Number(scale);
  }
  const n = num(raw);
  return n === undefined || n < 0 ? undefined : n / 10 ** decimals;
}

/** `uiTokenAmount`-style object → decimal-adjusted amount (uiAmountString > uiAmount > amount/decimals). */
export function uiAmountOf(value: Rec | undefined): number | undefined {
  if (!value) return undefined;
  const fromString = num(value.uiAmountString);
  if (fromString !== undefined) return fromString;
  const fromFloat = num(value.uiAmount);
  if (fromFloat !== undefined) return fromFloat;
  const decimals = num(value.decimals);
  return decimals === undefined ? undefined : rawToUi(value.amount, decimals);
}

// ---------------------------------------------------------------------------
// Standard RPC
// ---------------------------------------------------------------------------

export interface LargestAccount {
  tokenAccount: string;
  amount: number;
}

/** getTokenLargestAccounts `result` → token accounts with a positive balance (max 20, largest first). */
export function parseLargestAccounts(result: unknown): LargestAccount[] | undefined {
  const value = rec(result)?.value;
  if (!Array.isArray(value)) return undefined;
  const out: LargestAccount[] = [];
  for (const item of value) {
    const r = rec(item);
    const tokenAccount = r?.address;
    const amount = uiAmountOf(r);
    if (!isSolanaAddress(tokenAccount) || amount === undefined || amount <= 0) continue;
    out.push({ tokenAccount, amount });
  }
  return out;
}

/** getTokenSupply `result` → decimal-adjusted supply. */
export function parseTokenSupply(result: unknown): number | undefined {
  const supply = uiAmountOf(rec(rec(result)?.value));
  return supply !== undefined && supply > 0 ? supply : undefined;
}

/**
 * getMultipleAccounts (jsonParsed) `result` → token account → owner wallet.
 * `value[]` is aligned with the requested keys; closed accounts are `null`.
 */
export function parseTokenAccountOwners(result: unknown, requested: readonly string[]): Map<string, string> | undefined {
  const value = rec(result)?.value;
  if (!Array.isArray(value)) return undefined;
  const owners = new Map<string, string>();
  requested.forEach((account, i) => {
    const data = rec(rec(value[i])?.data);
    const parsed = rec(data?.parsed);
    if (parsed?.type !== 'account') return;
    const owner = rec(parsed.info)?.owner;
    if (isSolanaAddress(owner)) owners.set(account, owner);
  });
  return owners;
}

/**
 * getMultipleAccounts (any encoding) `result` → address → owning program.
 * Used to recognise pool / curve accounts that own vaults; missing accounts
 * (PDAs without data, closed accounts) are simply absent.
 */
export function parseAccountPrograms(result: unknown, requested: readonly string[]): Map<string, string> | undefined {
  const value = rec(result)?.value;
  if (!Array.isArray(value)) return undefined;
  const programs = new Map<string, string>();
  requested.forEach((account, i) => {
    const program = rec(value[i])?.owner;
    if (isSolanaAddress(program)) programs.set(account, program);
  });
  return programs;
}

// ---------------------------------------------------------------------------
// DAS
// ---------------------------------------------------------------------------

function tokenProgramOf(value: unknown): TokenMeta['tokenProgram'] {
  if (value === PROGRAMS.TOKEN) return 'spl-token';
  if (value === PROGRAMS.TOKEN_2022) return 'token-2022';
  return undefined;
}

function imageFromFiles(files: unknown): string | undefined {
  if (!Array.isArray(files)) return undefined;
  const entries = files.map(rec).filter((f): f is Rec => !!f);
  const imageFile = entries.find((f) => typeof f.mime === 'string' && f.mime.startsWith('image/') && httpsUrl(f.uri));
  return httpsUrl((imageFile ?? entries[0])?.uri);
}

/**
 * DAS asset (getAsset / getAssetBatch item) → TokenMeta.
 *
 * `token_info.price_info` is deliberately ignored: Helius caches it for up to
 * 10 minutes and only for verified tokens. Update authorities are not mapped
 * (TokenMeta has no field for them; mint/freeze authorities live in MintInfo).
 */
export function assetToTokenMeta(asset: unknown): TokenMeta | undefined {
  const a = rec(asset);
  const mint = a?.id;
  if (!a || !isSolanaAddress(mint)) return undefined;
  const content = rec(a.content);
  const metadata = rec(content?.metadata);
  const links = rec(content?.links);
  const tokenInfo = rec(a.token_info);
  // Token-2022 metadata extension (pump.fun mints carry name/symbol/uri on-chain).
  const extMeta = rec(rec(a.mint_extensions)?.metadata);

  const decimals = num(tokenInfo?.decimals);
  const validDecimals = decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 ? decimals : undefined;
  const totalSupply = validDecimals !== undefined ? rawToUi(tokenInfo?.supply, validDecimals) : undefined;
  const website = httpsUrl(links?.external_url);

  return defined<TokenMeta>({
    mint,
    name: text(metadata?.name) ?? text(extMeta?.name),
    symbol: text(metadata?.symbol) ?? text(tokenInfo?.symbol) ?? text(extMeta?.symbol),
    image: httpsUrl(links?.image) ?? imageFromFiles(content?.files),
    decimals: validDecimals,
    tokenProgram: tokenProgramOf(tokenInfo?.token_program),
    description: text(metadata?.description),
    totalSupply,
    socials: website ? { website } : {},
  });
}
