import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn';

export const Table = ({ className, ...p }: HTMLAttributes<HTMLTableElement>) => (
  <div className="relative overflow-x-auto"><table className={cn('w-full border-collapse text-sm', className)} {...p} /></div>
);
export const THead = (p: HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} />;
export const TBody = (p: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />;
export const TR = ({ className, ...p }: HTMLAttributes<HTMLTableRowElement>) => <tr className={cn('transition-colors hover:bg-surface-2/60', className)} {...p} />;
export const TH = ({ className, ...p }: ThHTMLAttributes<HTMLTableCellElement>) => <th className={cn('whitespace-nowrap border-b border-border px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted', className)} {...p} />;
export const TD = ({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn('border-b border-border px-4 py-3.5 align-middle', className)} {...p} />;
