import { forwardRef, type ButtonHTMLAttributes, type MouseEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-accent text-accent-ink hover:underline underline-offset-2",
  secondary: "border border-line-control bg-raised text-fg hover:border-fg",
  ghost: "text-fg-secondary hover:bg-sunken hover:text-fg",
  danger: "border border-status-failed text-status-failed hover:bg-sunken",
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: "h-7 px-2.5 text-sm",
  md: "h-9 px-3.5 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and ignores clicks while keeping keyboard focus on the button. */
  loading?: boolean;
  /** Replaces the label while loading, for example "Saving…". Defaults to the normal label. */
  loadingLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    className,
    type = "button",
    loading = false,
    loadingLabel,
    children,
    onClick,
    ...props
  },
  ref,
) {
  // A busy button uses aria-disabled rather than disabled, so focus is not dropped to <body> mid-action.
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      ref={ref}
      type={type}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
      onClick={handleClick}
    >
      {loading ? (
        <>
          <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
          {loadingLabel ?? children}
        </>
      ) : (
        // Untouched when idle, so the button's children are exactly what the caller passed.
        children
      )}
    </button>
  );
});
