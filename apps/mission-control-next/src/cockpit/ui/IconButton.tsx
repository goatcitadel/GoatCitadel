import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, type = "button", ...props }, ref,
) {
  return <button ref={ref} type={type} aria-label={label} title={label} className={cn(
    "inline-flex size-8 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-sunken hover:text-fg",
    className,
  )} {...props}>{icon}</button>;
});
