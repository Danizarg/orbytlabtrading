/**
 * User-safe wallet errors. Wallet extensions throw a zoo of shapes (EIP-1193
 * style `{ code: 4001 }`, `WalletSignTransactionError`, plain strings), so
 * every wallet call is funnelled through `toWalletError`.
 *
 * `rejected` is the user saying no in their wallet: the UI shows a quiet
 * note, never an error banner.
 */

export type WalletErrorKind =
  /** The user declined or closed the wallet prompt. */
  | 'rejected'
  /** The wallet lacks a feature ORBYT needs (e.g. transaction signing). */
  | 'unsupported'
  /** No wallet or account is connected. */
  | 'not_connected'
  /** The ORBYT server refused the sign-in proof. */
  | 'verification'
  /** ORBYT's auth routes could not be reached. */
  | 'network'
  /** Anything else the wallet reported. */
  | 'failed';

export class WalletError extends Error {
  readonly kind: WalletErrorKind;

  constructor(kind: WalletErrorKind, message: string, opts: { cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'WalletError';
    this.kind = kind;
  }
}

export function isWalletError(e: unknown): e is WalletError {
  return e instanceof WalletError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'WalletError');
}

/** EIP-1193 "User Rejected Request", used by Phantom, Solflare and Backpack. */
const REJECTION_CODES: ReadonlySet<number> = new Set([4001]);
const REJECTION_TEXT = /user (?:rejected|denied|declined|cancel+ed|closed)|rejected the request|request (?:was )?(?:rejected|cancel+ed|denied)|approval denied|cancel+ed by user|user abort/i;

function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return '';
}

/** True when a wallet error means the user declined the request. */
export function isUserRejection(e: unknown): boolean {
  if (isWalletError(e)) return e.kind === 'rejected';
  if (typeof e === 'object' && e !== null) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'number' && REJECTION_CODES.has(code)) return true;
    const name = (e as { name?: unknown }).name;
    if (name === 'UserRejectedRequestError' || name === 'NotAllowedError') return true;
  }
  return REJECTION_TEXT.test(errorText(e));
}

/** Wallet text is shown only when short and free of markup/URLs; otherwise the fallback is used. */
function safeWalletText(e: unknown): string | undefined {
  const text = errorText(e).trim();
  if (!text || text.length > 140 || /[<>]|https?:\/\//i.test(text)) return undefined;
  return text.replace(/\s+/g, ' ');
}

export const REJECTED_MESSAGE = 'Request cancelled in your wallet.';

/** Normalise anything a wallet throws into a WalletError with user-safe text. */
export function toWalletError(e: unknown, fallback: string): WalletError {
  if (isWalletError(e)) return e;
  if (isUserRejection(e)) return new WalletError('rejected', REJECTED_MESSAGE, { cause: e });
  const detail = safeWalletText(e);
  return new WalletError('failed', detail ? `${fallback} (${detail})` : fallback, { cause: e });
}
