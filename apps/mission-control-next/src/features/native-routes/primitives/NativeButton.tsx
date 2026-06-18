import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { clsx } from "clsx";

/**
 * NativeButton — the canonical mission-control-next button primitive.
 *
 * Why a native primitive (not the shared CVA `ui/button.tsx`): mc-next is styled
 * with bespoke CSS, not Tailwind — it ships no `@import "tailwindcss"`, so the
 * Tailwind-utility CVA <Button> renders unstyled here. NativeButton is the
 * native-kit sibling of NativeCard / StatusChip / EmptyState: it maps a small
 * variant API onto the button treatments already defined in
 * `styles/mission-control-next.css`, so it is pixel-identical to the raw classes
 * it replaces and needs no new CSS.
 *
 * Emphasis rule — which variant to reach for (one primary CTA per view; every
 * other action steps down from there):
 *
 *   variant       use for                       look                         backing class
 *   ----------    --------------------------    -------------------------    ----------------------------
 *   default       page primary CTA              filled `--primary`           .mc-next-button
 *   outline       secondary action              bordered / elevated neutral  .gc-button
 *   ghost         tertiary / inline action      transparent, quiet           .mc-next-button-ghost
 *   destructive   destructive action            danger-tinted                .mc-next-button-danger
 *   secondary     low-emphasis transparent      flat neutral surface         .mc-next-button-secondary
 *
 * Phase 3 migrates raw `mc-next-button` / `mc-next-button-secondary` / `gc-button`
 * call sites onto this component; scripts/check-mission-control-next-buttons.mjs
 * tracks the remaining raw usages (this file is the one sanctioned home and is
 * excluded from that guard).
 */
export type NativeButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive";

const VARIANT_CLASS: Record<NativeButtonVariant, string> = {
  default: "mc-next-button",
  outline: "gc-button",
  secondary: "mc-next-button-secondary",
  ghost: "mc-next-button-ghost",
  destructive: "mc-next-button-danger",
};

export type NativeButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  variant?: NativeButtonVariant;
  /** Render the single child element (Radix Slot) instead of a native button, e.g. an anchor. */
  asChild?: boolean;
};

export const NativeButton = React.forwardRef<HTMLButtonElement, NativeButtonProps>(
  function NativeButton({ variant = "default", asChild = false, className, type, ...props }, ref) {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        data-variant={variant}
        className={clsx(VARIANT_CLASS[variant], className)}
        // Only a real button element gets a default type; an asChild element supplies its own.
        {...(asChild ? {} : { type: type ?? "button" })}
        {...props}
      />
    );
  },
);
