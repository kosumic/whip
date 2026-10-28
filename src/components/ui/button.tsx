import { TextClassContext } from '@/src/components/ui/text';
import { useAppFontScale } from '@/src/hooks/useAppFontScale';
import { cn } from '@/src/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import { Platform, Pressable } from 'react-native';

const buttonVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-2 rounded-md shadow-none',
    Platform.select({
      web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
      default: 'min-h-11 min-w-11',
    }),
  ),
  {
    variants: {
      variant: {
        default: cn('bg-primary active:bg-primary/90 shadow-sm shadow-black/5', Platform.select({ web: 'hover:bg-primary/90' })),
        destructive: cn('bg-destructive active:bg-destructive/90 dark:bg-destructive/60 shadow-sm shadow-black/5', Platform.select({ web: 'hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40' })),
        outline: cn('border-border bg-background active:bg-accent dark:bg-input/30 dark:border-input dark:active:bg-input/50 border shadow-sm shadow-black/5', Platform.select({ web: 'hover:bg-accent dark:hover:bg-input/50' })),
        secondary: cn('bg-secondary active:bg-secondary/80 shadow-sm shadow-black/5', Platform.select({ web: 'hover:bg-secondary/80' })),
        ghost: cn('active:bg-accent dark:active:bg-accent/50', Platform.select({ web: 'hover:bg-accent dark:hover:bg-accent/50' })),
        link: '',
      },
      size: {
        default: cn(
          Platform.select({
            web: 'h-10 px-4 py-0 sm:h-9',
            default: 'h-11 px-4 py-0',
          }),
          Platform.select({ web: 'has-[>svg]:px-3' }),
        ),
        sm: cn(
          Platform.select({
            web: 'h-9 gap-1.5 rounded-md px-3 sm:h-8',
            default: 'h-11 gap-1.5 rounded-md px-3',
          }),
          Platform.select({ web: 'has-[>svg]:px-2.5' }),
        ),
        lg: cn(
          Platform.select({
            web: 'h-11 rounded-md px-6 sm:h-10',
            default: 'h-12 rounded-md px-6',
          }),
          Platform.select({ web: 'has-[>svg]:px-4' }),
        ),
        icon: Platform.select({
          web: 'h-10 w-10 sm:h-9 sm:w-9',
          default: 'h-11 w-11',
        }),
        content: '',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

const buttonTextVariants = cva('text-foreground text-sm font-medium', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      destructive: 'text-destructive-foreground',
      outline: cn('group-active:text-accent-foreground', Platform.select({ web: 'group-hover:text-accent-foreground' })),
      secondary: 'text-secondary-foreground',
      ghost: 'group-active:text-accent-foreground',
      link: cn('text-primary group-active:underline', Platform.select({ web: 'underline-offset-4 hover:underline group-hover:underline' })),
    },
    size: { default: '', sm: '', lg: '', icon: '', content: '' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

type ButtonProps = React.ComponentProps<typeof Pressable> & React.RefAttributes<typeof Pressable> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  const fontScale = useAppFontScale();
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(props.disabled && 'opacity-50', buttonVariants({ variant, size }), fontScale > 1 && size !== 'icon' && size !== 'content' && 'h-auto py-2', className)}
        role="button"
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
