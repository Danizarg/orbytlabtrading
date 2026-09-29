import { Wallet } from 'lucide-react';
import { cn } from '@/components/ui/cn';

/**
 * A wallet's own icon (inline data: image supplied by the extension and
 * validated by the wallet layer), or a neutral glyph.
 */
export function WalletIcon({ icon, name, className }: { icon?: string | null; name?: string | null; className?: string }) {
  if (icon) {
    return <img src={icon} alt="" aria-hidden width={20} height={20} className={cn('size-5 shrink-0 rounded-[5px] object-contain', className)} />;
  }
  return (
    <span aria-hidden title={name ?? undefined} className={cn('flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-panel-3 text-muted', className)}>
      <Wallet className="size-3" />
    </span>
  );
}
