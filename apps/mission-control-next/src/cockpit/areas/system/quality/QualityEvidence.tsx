import { createContext, useContext, type ReactNode } from "react";
import type { OpsQualityAvailabilityState } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

/** Installation limitations appear once above the selected evidence panel. */
export const QualityGlobalWarnings = createContext<readonly string[]>([]);

export function QualitySource({ title, state, error, warnings = [], children }: {
  title: string;
  state: OpsQualityAvailabilityState;
  error?: string;
  warnings?: readonly string[];
  children: ReactNode;
}) {
  const available = state === "available" && !error;
  const globalWarnings = useContext(QualityGlobalWarnings);
  return <section aria-label={title} className="min-w-0 space-y-3 rounded-lg border border-line bg-raised p-4">
    <h2 className="font-display text-md font-semibold text-fg">{title}</h2>
    {!available ? <p role="status" className="text-sm text-fg-secondary">
      {title}: {state === "unknown" ? "availability unknown" : "unavailable"}.
      {error ? ` ${describeApiError(new Error(error)).summary}` : " The Gateway has no available evidence for this source."}
    </p> : children}
    <QualityNotes items={warnings.filter(item => !globalWarnings.includes(item))} />
  </section>;
}

export function QualityNotes({ items }: { items: readonly string[] }) {
  return items.length ? <ul className="space-y-1 text-sm text-fg-secondary">{[...new Set(items)].map((item, index) =>
    <li key={`${index}:${item}`} className="break-words">{item}</li>)}</ul> : null;
}

export function QualityFacts({ items }: { items: readonly { label: string; value: string | number }[] }) {
  return <dl className="grid gap-2 sm:grid-cols-2">{items.map((item) => <div key={item.label} className="min-w-0">
    <dt className="text-xs text-fg-muted">{item.label}</dt>
    <dd className="wrap-anywhere text-sm text-fg">{item.value}</dd>
  </div>)}</dl>;
}

export function qualityTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Time unavailable";
}

export function qualityNumber(value: number | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)}${suffix}` : "Not recorded";
}

export function promptPackQualityHref(packId?: string): string {
  const query = new URLSearchParams({ shell: "classic" });
  if (packId) query.set("view", `pack:${packId}`);
  return `/library/prompt-packs?${query.toString()}`;
}
