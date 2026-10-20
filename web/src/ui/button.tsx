import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

export const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-sm font-semibold leading-tight no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border-strong bg-surface text-fg shadow-sm hover:bg-surface-2',
        primary: 'border-primary bg-primary text-primary-fg shadow-sm hover:bg-primary-hover',
        danger: 'border-danger bg-danger text-white shadow-sm hover:brightness-110',
        ghost: 'border-transparent bg-transparent text-fg hover:bg-surface-2',
        soft: 'border-transparent bg-primary-soft text-primary hover:brightness-95',
        link: 'border-transparent bg-transparent px-0 text-primary underline-offset-4 hover:underline',
      },
      size: { xs: 'min-h-6 px-2 text-xs', sm: 'min-h-7 px-2.5 text-[0.82rem]', md: 'min-h-9 px-3.5 py-1.5', lg: 'min-h-11 px-5 text-base', icon: 'size-8 min-h-8 p-0', 'icon-sm': 'size-7 min-h-7 p-0' },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
