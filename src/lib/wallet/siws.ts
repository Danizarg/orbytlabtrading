/**
 * Sign-In With Solana (SIWS) message format, shared by the browser (fallback
 * for wallets without `solana:signIn`) and the server (verification).
 *
 * The text layout follows the Solana Wallet Standard `solana:signIn`
 * reference (EIP-4361 adapted to Solana, CAIP-122):
 *
 *   ${domain} wants you to sign in with your Solana account:
 *   ${address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: ${version}
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   Expiration Time: ${expirationTime}
 *   Not Before: ${notBefore}
 *   Request ID: ${requestId}
 *   Resources:
 *   - ${resource}
 *
 * Every field after the address is optional, but when present the fields
 * appear exactly once, in this order.
 */

export interface SignInMessageFields {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

/** What GET /api/v1/auth/nonce returns: everything the wallet needs to build the message. */
export interface SignInChallenge {
  nonce: string;
  /** ISO-8601. */
  issuedAt: string;
  /** ISO-8601; also sent to the wallet as the message's Expiration Time. */
  expiresAt: string;
  domain: string;
  uri: string;
  statement: string;
  version: string;
  chainId: string;
  /** True when the server holds AUTH_SECRET: the nonce is signed and a session cookie will be issued. */
  signed: boolean;
}

export const SIWS_VERSION = '1';
/** Chain ID written into messages (SIWS accepts `mainnet` or the CAIP-2 style `solana:mainnet`). */
export const SIWS_CHAIN_ID = 'mainnet';
export const SIWS_ACCEPTED_CHAIN_IDS: ReadonlySet<string> = new Set(['mainnet', 'solana:mainnet']);
/** A challenge is valid for 10 minutes. */
export const SIGN_IN_TTL_MS = 10 * 60_000;
/** Allowed clock skew between the server, the wallet and the browser. */
export const SIGN_IN_CLOCK_SKEW_MS = 60_000;
/** Upper bound for a sign-in message (the ORBYT one is ~450 bytes). */
export const SIGN_IN_MAX_MESSAGE_BYTES = 2_048;
export const SIGN_IN_STATEMENT =
  'Sign in to ORBYT to prove you own this wallet. Signing is free and does not send a transaction or move funds.';
export const NONCE_RE = /^[A-Za-z0-9]{8,128}$/;

const HEADER_SUFFIX = ' wants you to sign in with your Solana account:';

const FIELD_ORDER = [
  ['uri', 'URI: '],
  ['version', 'Version: '],
  ['chainId', 'Chain ID: '],
  ['nonce', 'Nonce: '],
  ['issuedAt', 'Issued At: '],
  ['expirationTime', 'Expiration Time: '],
  ['notBefore', 'Not Before: '],
  ['requestId', 'Request ID: '],
] as const satisfies ReadonlyArray<readonly [keyof SignInMessageFields, string]>;

const RESOURCES_LINE = 'Resources:';

function isFieldLine(line: string): boolean {
  return line === RESOURCES_LINE || FIELD_ORDER.some(([, prefix]) => line.startsWith(prefix));
}

function singleLine(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (/[\r\n]/.test(value)) throw new Error(`Sign-in ${name} must be a single line`);
  return value;
}

/** Message text for the given fields (byte-for-byte what `solana:signIn` wallets produce). */
export function buildSignInMessage(fields: SignInMessageFields): string {
  const domain = singleLine(fields.domain, 'domain');
  const address = singleLine(fields.address, 'address');
  if (!domain || !address) throw new Error('Sign-in message needs a domain and an address');
  let message = `${domain}${HEADER_SUFFIX}\n${address}`;
  const statement = singleLine(fields.statement, 'statement');
  if (statement) message += `\n\n${statement}`;

  const lines: string[] = [];
  for (const [key, prefix] of FIELD_ORDER) {
    const value = singleLine(fields[key], key);
    if (value !== undefined) lines.push(`${prefix}${value}`);
  }
  if (fields.resources?.length) {
    lines.push(RESOURCES_LINE);
    for (const resource of fields.resources) lines.push(`- ${singleLine(resource, 'resource') ?? ''}`);
  }
  if (lines.length) message += `\n\n${lines.join('\n')}`;
  return message;
}

/** Parse a sign-in message. Returns null for anything that does not follow the format exactly. */
export function parseSignInMessage(text: string): SignInMessageFields | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > SIGN_IN_MAX_MESSAGE_BYTES || text.includes('\r')) return null;
  const lines = text.split('\n');
  while (lines.length > 2 && lines[lines.length - 1] === '') lines.pop();

  const header = lines[0] ?? '';
  if (!header.endsWith(HEADER_SUFFIX)) return null;
  const domain = header.slice(0, -HEADER_SUFFIX.length);
  if (!domain || /\s/.test(domain)) return null;
  const address = lines[1];
  if (!address || /\s/.test(address)) return null;

  const out: SignInMessageFields = { domain, address };
  let i = 2;
  if (i === lines.length) return out;

  // Blank line, then either the statement or the first field.
  if (lines[i] !== '') return null;
  i++;
  const next = lines[i];
  if (next === undefined || next === '') return null;
  if (!isFieldLine(next) || lines[i + 1] === '') {
    out.statement = next;
    i++;
    if (i === lines.length) return out;
    if (lines[i] !== '') return null;
    i++;
    if (i === lines.length) return null;
  }

  // Fields: each at most once, in canonical order.
  let order = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line === RESOURCES_LINE) {
      const resources: string[] = [];
      for (i++; i < lines.length; i++) {
        const item = lines[i] ?? '';
        if (!item.startsWith('- ') || item.length === 2) return null;
        resources.push(item.slice(2));
      }
      out.resources = resources;
      break;
    }
    let matched = false;
    for (; order < FIELD_ORDER.length; order++) {
      const [key, prefix] = FIELD_ORDER[order]!;
      if (line.startsWith(prefix)) {
        const value = line.slice(prefix.length);
        if (!value) return null;
        out[key] = value;
        order++;
        matched = true;
        break;
      }
    }
    if (!matched) return null;
    i++;
  }
  return out;
}

/** Message fields for a server challenge, bound to one wallet address. */
export function challengeFields(challenge: SignInChallenge, address: string): SignInMessageFields {
  return {
    domain: challenge.domain,
    address,
    statement: challenge.statement,
    uri: challenge.uri,
    version: challenge.version,
    chainId: challenge.chainId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expirationTime: challenge.expiresAt,
  };
}

/** Milliseconds since epoch for an ISO-8601 timestamp; undefined when unparseable. */
export function parseIsoTime(value: string | undefined): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
