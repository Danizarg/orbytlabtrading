import { describe, expect, it } from 'vitest';
import { isUserRejection, toWalletError, WalletError } from './errors';
import { safeWalletIcon, sortWallets } from './standard';

describe('isUserRejection', () => {
  it('recognises the rejection shapes wallets actually throw', () => {
    expect(isUserRejection(Object.assign(new Error('x'), { code: 4001 }))).toBe(true);
    expect(isUserRejection(new Error('User rejected the request.'))).toBe(true);
    expect(isUserRejection({ message: 'Transaction cancelled by user' })).toBe(true);
    expect(isUserRejection('User denied message signature')).toBe(true);
    expect(isUserRejection(new WalletError('rejected', 'x'))).toBe(true);
    expect(isUserRejection(new Error('Blockhash not found'))).toBe(false);
    expect(isUserRejection(new WalletError('failed', 'user rejected'))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

describe('toWalletError', () => {
  it('keeps short wallet text and drops markup or links', () => {
    expect(toWalletError(new Error('Wallet locked'), 'Could not connect.')).toMatchObject({ kind: 'failed', message: 'Could not connect. (Wallet locked)' });
    expect(toWalletError(new Error('see https://x.y'), 'Could not connect.').message).toBe('Could not connect.');
    expect(toWalletError(new Error('<b>x</b>'), 'Could not connect.').message).toBe('Could not connect.');
    expect(toWalletError(new Error('x'.repeat(300)), 'Could not connect.').message).toBe('Could not connect.');
    expect(toWalletError({ code: 4001 }, 'Could not connect.')).toMatchObject({ kind: 'rejected', message: 'Request cancelled in your wallet.' });
  });
});

describe('wallet ordering and icons', () => {
  it('orders Phantom, Solflare, Backpack, then alphabetically', () => {
    const names = ['OKX Wallet', 'Backpack', 'Coinbase Wallet', 'Solflare', 'Phantom'].map((name) => ({ name }));
    expect(sortWallets(names).map((w) => w.name)).toEqual(['Phantom', 'Solflare', 'Backpack', 'Coinbase Wallet', 'OKX Wallet']);
  });

  it('accepts only inline data: image icons', () => {
    expect(safeWalletIcon('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(safeWalletIcon('https://example.com/icon.png')).toBeUndefined();
    expect(safeWalletIcon('data:text/html;base64,PHNjcmlwdD4=')).toBeUndefined();
    expect(safeWalletIcon(undefined)).toBeUndefined();
  });
});
