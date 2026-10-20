import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--surface-2),var(--surface-3),var(--surface-2))] bg-[length:200%_100%]', className)} {...props} />;
}
