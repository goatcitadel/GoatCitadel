import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { cn } from "../lib/cn";
import { DisclosureSummary } from "./DisclosureSummary";

/** Secondary diagnostics only. Keep targets, scope, risk and review state outside this disclosure. */
export function TechnicalDetails({
  children,
  label = "Technical details",
  animate = false,
}: {
  children: ReactNode;
  label?: string;
  animate?: boolean;
}) {
  const { showTechnicalDetails } = useUiPreferences();
  if (!showTechnicalDetails) return null;
  return (
    <details className={cn("text-sm text-fg-secondary", animate && "cockpit-evidence-disclosure")}>
      <DisclosureSummary
        className={cn(
          "cursor-pointer font-medium text-accent",
          (animate || label === "Technical details") && "whitespace-nowrap",
        )}
      >
        {animate && <ChevronRight aria-hidden="true" className="cockpit-evidence-chevron size-4 shrink-0" />}
        {label}
      </DisclosureSummary>
      <div className="mt-2 min-w-0 break-words">{children}</div>
    </details>
  );
}
