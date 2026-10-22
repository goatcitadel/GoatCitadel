import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { AREA_PAGE } from "./area-layout";

/**
 * Hosts a Classic native-route page inside a cockpit tab until it is ported: the page body stays in the cockpit
 * column, and `embedded-classic.css` hides Classic's kicker, lays NativeButtons out inline and drops all-caps labels.
 * Pass `inColumn` when the caller already renders inside AREA_PAGE, so the column padding is not applied twice.
 */
export function EmbeddedClassicPage({ children, inColumn = false }: { children: ReactNode; inColumn?: boolean }) {
  return (
    <div
      className={cn(
        inColumn ? "flex min-w-0 flex-col gap-4" : cn(AREA_PAGE, "pt-0 sm:pt-0"),
        "cockpit-embedded-classic",
      )}
    >
      {children}
    </div>
  );
}
