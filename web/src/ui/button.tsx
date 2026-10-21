import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

export const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border text-sm font-medium leading-tight no-underline transition-[background-color,border-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface text-fg shadow-sm hover:border-border-strong hover:bg-surface-2 active:bg-surface-3',
        primary: 'border-primary bg-primary text-primary-fg shadow-sm hover:border-primary-hover hover:bg-primary-hover',
        danger: 'border-danger bg-danger text-white shadow-sm hover:brightness-110',
        ghost: 'border-transparent bg-transparent text-fg hover:bg-surface-2 active:bg-surface-3',
        soft: 'border-transparent bg-primary-soft text-primary hover:brightness-[0.97]',
        link: 'border-transparent bg-transparent px-0 text-primary underline-offset-4 hover:underline',
      },
      size: { xs: 'min-h-7 px-2.5 text-xs', sm: 'min-h-8 px-3 text-[0.8125rem]', md: 'min-h-10 px-4 py-2 max-sm:min-h-11', lg: 'min-h-12 px-6 text-base', icon: 'size-9 min-h-9 p-0 max-sm:size-11', 'icon-sm': 'size-8 min-h-8 p-0' },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
