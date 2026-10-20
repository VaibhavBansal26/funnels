import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn('rounded-lg border border-border bg-surface shadow-card', className)} {...p} />;
export const CardHeader = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn('flex flex-col gap-1 border-b border-border px-4 py-3', className)} {...p} />;
export const CardTitle = ({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) => <h3 className={cn('text-base font-semibold', className)} {...p} />;
export const CardBody = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn('p-4', className)} {...p} />;
