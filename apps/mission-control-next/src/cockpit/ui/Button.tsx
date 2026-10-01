import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-accent text-accent-ink hover:underline underline-offset-2",
  secondary: "border border-line bg-raised text-fg hover:border-line-strong",
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
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...props }, ref,
) {
  return <button ref={ref} type={type} className={cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    VARIANTS[variant], SIZES[size], className,
  )} {...props} />;
});
