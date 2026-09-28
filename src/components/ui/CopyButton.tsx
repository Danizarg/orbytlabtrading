'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from './cn';

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`${label}: ${value}`}
      title={copied ? 'Copied' : label}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        } catch {
          /* clipboard unavailable: the value remains visible for manual copy */
        }
      }}
      className={cn('inline-flex size-5 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg', className)}
    >
      {copied ? <Check className="size-3 text-up" /> : <Copy className="size-3" />}
    </button>
  );
}
