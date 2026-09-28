import type { MintInfo } from '@/lib/core/types';
import { chunk, num } from '@/lib/core/chain';
import { isSolanaAddress, PROGRAMS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import { accountParsedInfo, MAX_MULTIPLE_ACCOUNTS, type RpcAccountInfo, type RpcClient } from './rpc';
import { rawToUi } from './units';

/**
 * On-chain mint facts from jsonParsed mint accounts (SPL Token and
 * Token-2022). pump.fun mints are Token-2022 with the `tokenMetadata`
 * extension, so name/symbol/uri come straight from chain without a Metaplex
 * lookup. Authorities are `null` when revoked.
 */

function tokenProgramOf(owner: string): MintInfo['tokenProgram'] | undefined {
  if (owner === PROGRAMS.TOKEN) return 'spl-token';
  if (owner === PROGRAMS.TOKEN_2022) return 'token-2022';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Authority field: a pubkey string, or null when revoked. Undefined when the field is absent/invalid. */
function authority(info: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in info)) return undefined;
  const value = info[key];
  if (value === null) return null;
  return typeof value === 'string' && isSolanaAddress(value) ? value : undefined;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replaceAll('\u0000', '').trim();
  return text || undefined;
}

function tokenMetadata(info: Record<string, unknown>): MintInfo['metadata'] {
  if (!Array.isArray(info.extensions)) return undefined;
  for (const ext of info.extensions) {
    if (!isRecord(ext) || ext.extension !== 'tokenMetadata' || !isRecord(ext.state)) continue;
    const meta: NonNullable<MintInfo['metadata']> = {};
    const name = cleanText(ext.state.name);
    const symbol = cleanText(ext.state.symbol);
    const uri = cleanText(ext.state.uri);
    if (name) meta.name = name;
    if (symbol) meta.symbol = symbol;
    if (uri) meta.uri = uri;
    return Object.keys(meta).length > 0 ? meta : undefined;
  }
  return undefined;
}

/**
 * Parse a jsonParsed account as a token mint. Returns null when the account
 * is missing, not owned by a token program, not a mint, or lacks the fields
 * needed to describe it honestly.
 */
export function parseMintAccount(mint: string, account: RpcAccountInfo | null | undefined, fetchedAt: number = Date.now()): MintInfo | null {
  if (!account) return null;
  const tokenProgram = tokenProgramOf(account.owner);
  if (!tokenProgram) return null;
  const parsed = accountParsedInfo(account);
  if (!parsed || parsed.type !== 'mint') return null;
  const { info } = parsed;
  const decimals = num(info.decimals);
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0) return null;
  const supply = rawToUi(info.supply, decimals);
  const mintAuthority = authority(info, 'mintAuthority');
  const freezeAuthority = authority(info, 'freezeAuthority');
  if (supply === undefined || mintAuthority === undefined || freezeAuthority === undefined) return null;
  const out: MintInfo = { mint, decimals, supply, tokenProgram, mintAuthority, freezeAuthority, fetchedAt };
  const metadata = tokenMetadata(info);
  if (metadata) out.metadata = metadata;
  return out;
}

/** One mint via getAccountInfo(jsonParsed). Throws ProviderError 'not_found' when the address is not a token mint. */
export async function getMintInfo(rpc: RpcClient, mint: string, signal?: AbortSignal): Promise<MintInfo> {
  if (!isSolanaAddress(mint)) throw new ProviderError(rpc.provider, 'not_found', `${rpc.label}: invalid mint address`);
  const account = await rpc.getAccountInfo(mint, { encoding: 'jsonParsed' }, signal);
  const info = parseMintAccount(mint, account, Date.now());
  if (!info) throw new ProviderError(rpc.provider, 'not_found', `${rpc.label}: ${mint} is not a token mint`);
  return info;
}

/**
 * Many mints via getMultipleAccounts(jsonParsed), 100 per call. Invalid
 * addresses, missing accounts and non-mint accounts are absent from the result.
 */
export async function getMintInfos(rpc: RpcClient, mints: string[], signal?: AbortSignal): Promise<Record<string, MintInfo>> {
  const unique = [...new Set(mints)].filter(isSolanaAddress);
  const out: Record<string, MintInfo> = {};
  for (const group of chunk(unique, MAX_MULTIPLE_ACCOUNTS)) {
    const accounts = await rpc.getMultipleAccounts(group, { encoding: 'jsonParsed' }, signal);
    const fetchedAt = Date.now();
    group.forEach((mint, i) => {
      const info = parseMintAccount(mint, accounts[i], fetchedAt);
      if (info) out[mint] = info;
    });
  }
  return out;
}
