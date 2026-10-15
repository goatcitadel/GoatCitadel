import type { ReactNode } from "react";
import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

type CalloutTone = "info" | "warning" | "error";

// Tone is carried by border colour AND icon shape, never by colour alone, and never by an "Error:" style prefix.
const TONES: Readonly<Record<CalloutTone, { icon: LucideIcon; border: string; iconClass: string }>> = {
  info: { icon: Info, border: "border-line", iconClass: "text-fg-muted" },
  warning: { icon: TriangleAlert, border: "border-status-waiting/60", iconClass: "text-status-waiting" },
  error: { icon: CircleAlert, border: "border-status-failed/60", iconClass: "text-status-failed" },
};

export function Callout({
  children,
  tone = "info",
  announce,
}: {
  children: ReactNode;
  tone?: CalloutTone;
  /**
   * Most callouts report the result of an action (a save, an approval, a failed read), so they announce by default:
   * errors as alerts, the rest as polite status. Pass announce={false} for static guidance that is part of the page.
   */
  announce?: boolean;
}) {
  const style = TONES[tone];
  const Icon = style.icon;
  const live = announce ?? true;
  return (
    <div
      role={live ? (tone === "error" ? "alert" : "status") : undefined}
      data-tone={tone}
      className={cn(
        "flex min-w-0 max-w-full items-start gap-2 rounded-md border bg-sunken p-3 text-sm text-fg-secondary",
        style.border,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", style.iconClass)} />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}
