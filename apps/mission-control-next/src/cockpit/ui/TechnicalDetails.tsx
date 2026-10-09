import type { ReactNode } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

/** Secondary diagnostics only. Keep targets, scope, risk and review state outside this disclosure. */
export function TechnicalDetails({ children, label = "Technical details" }: { children: ReactNode; label?: string }) {
  const { showTechnicalDetails } = useUiPreferences();
  if (!showTechnicalDetails) return null;
  return <details className="text-sm text-fg-secondary">
    <summary className="cursor-pointer font-medium text-accent">{label}</summary>
    <div className="mt-2 min-w-0 break-words">{children}</div>
  </details>;
}
