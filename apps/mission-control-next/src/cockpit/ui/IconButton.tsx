import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
  /** False for a close button the dialog focuses by itself, so its first Escape closes the dialog, not a tooltip. */
  nameOnFocus?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, type = "button", nameOnFocus = true, ...props },
  ref,
) {
  return (
    <Tooltip label={label} openOnFocus={nameOnFocus}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-md text-fg-secondary transition-colors enabled:hover:bg-sunken enabled:hover:text-fg disabled:cursor-not-allowed disabled:text-fg-muted disabled:opacity-60",
          className,
        )}
        {...props}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
