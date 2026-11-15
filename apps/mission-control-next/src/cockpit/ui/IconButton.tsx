import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, type = "button", ...props },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-fg-secondary transition-colors enabled:hover:bg-sunken enabled:hover:text-fg disabled:cursor-not-allowed disabled:text-fg-muted disabled:opacity-60",
        props.disabled && "pointer-events-none",
        className,
      )}
      {...props}
      // The tooltip says what the accessible name already says; do not read it twice.
      aria-describedby={props["aria-describedby"]}
    >
      {icon}
    </button>
  );
  // A disabled button fires no pointer events, so its wrapper carries the tooltip and the not-allowed cursor.
  return (
    <Tooltip label={label}>
      {props.disabled ? <span className="inline-flex cursor-not-allowed rounded-md">{button}</span> : button}
    </Tooltip>
  );
});
