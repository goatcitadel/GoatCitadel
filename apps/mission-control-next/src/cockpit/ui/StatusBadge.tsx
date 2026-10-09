import { Check, Circle, Hand, LoaderCircle, X, type LucideIcon } from "lucide-react";
import type { StatusPresentation, StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { cn } from "../lib/cn";

const TONE_CLASSES: Readonly<Record<StatusTone, string>> = {
  running: "border-status-running/40 text-status-running",
  waiting: "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
  done: "border-status-done/40 text-status-done",
  failed: "border-status-failed/40 text-status-failed",
  neutral: "border-line text-fg-muted",
};

const TONE_ICONS: Readonly<Record<StatusTone, LucideIcon>> = {
  running: LoaderCircle,
  waiting: Hand,
  done: Check,
  failed: X,
  neutral: Circle,
};

export function StatusBadge({ status, className, icon }: { status: StatusPresentation; className?: string; icon?: LucideIcon }) {
  const Icon = icon ?? TONE_ICONS[status.tone];
  return <span data-tone={status.tone} className={cn(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
    TONE_CLASSES[status.tone], className,
  )}>
    <Icon aria-hidden="true" className={cn("size-3", status.tone === "running" && "animate-pulse-live")} />
    {status.label}
  </span>;
}
