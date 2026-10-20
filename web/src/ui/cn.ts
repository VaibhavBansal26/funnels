import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and resolves Tailwind conflicts (the last utility wins). */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
