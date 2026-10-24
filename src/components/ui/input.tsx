import { cn } from '@/src/lib/utils';
import { guiFontFamilyForClasses } from '@/src/lib/guiFonts';
import { Platform, TextInput, type TextInputInstance } from 'react-native';

function Input({ className, style, ...props }: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInputInstance>) {
  const resolvedClassName = cn(
    'dark:bg-input/30 border-input bg-background text-foreground flex h-11 w-full min-w-0 flex-row items-center rounded-md border px-3 py-2 text-base leading-5 shadow-none',
    props.editable === false && cn('opacity-50', Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' })),
    Platform.select({
      web: cn('placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground outline-none transition-[color,box-shadow] md:text-sm', 'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]', 'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'),
      native: 'placeholder:text-muted-foreground/50',
    }),
    className
  );
  const fontFamily = guiFontFamilyForClasses(resolvedClassName);
  return (
    <TextInput
      className={resolvedClassName}
      style={fontFamily ? [{ fontFamily }, style] : style}
      {...props}
    />
  );
}

export { Input };
