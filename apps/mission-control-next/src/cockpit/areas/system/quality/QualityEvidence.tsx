import { createContext, useContext, type ReactNode } from "react";
import type { OpsQualityAvailabilityState } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { formatAbsoluteTime } from "@goatcitadel/mission-control-shared/content/format";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { resolveCockpitCompatibility } from "../../../app/cockpit-compatibility";

/** Installation limitations appear once above the selected evidence panel. */
export const QualityGlobalWarnings = createContext<readonly string[]>([]);

export function QualitySource({
  title,
  state,
  error,
  warnings = [],
  children,
}: {
  title: string;
  state: OpsQualityAvailabilityState;
  error?: string;
  warnings?: readonly string[];
  children: ReactNode;
}) {
  const available = state === "available" && !error;
  const globalWarnings = useContext(QualityGlobalWarnings);
  return (
    <section
      aria-label={title}
      className="min-w-0 space-y-3 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {!available ? (
        <p role="status" className="text-sm text-fg-secondary">
          {title}: {state === "unknown" ? "availability unknown" : "unavailable"}.
          {error
            ? ` ${describeApiError(new Error(error)).summary}`
            : " The Gateway has no available evidence for this source."}
        </p>
      ) : (
        children
      )}
      <QualityNotes items={warnings.filter((item) => !globalWarnings.includes(item))} />
    </section>
  );
}

export function QualityNotes({ items }: { items: readonly string[] }) {
  return items.length ? (
    <ul className="space-y-1 text-sm text-fg-secondary">
      {[...new Set(items)].map((item, index) => (
        <li key={`${index}:${item}`} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  ) : null;
}

export function QualityFacts({ items }: { items: readonly { label: string; value: string | number }[] }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-fg-muted">{item.label}</dt>
          <dd className="wrap-anywhere text-sm text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Plain-text time for evidence sentences; markup that can hold a <time> element uses TimeText instead. */
export function qualityTimestamp(value: string): string {
  return formatAbsoluteTime(value);
}

export function qualityNumber(value: number | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)}${suffix}`
    : "Not recorded";
}

export function promptPackQualityHref(
  packId?: string,
  context: { search?: string; hash?: string; workspaceId?: string; citadelId?: string } = {},
): string {
  const query = new URLSearchParams(context.search);
  query.set("shell", "cockpit");
  query.delete("shellScope");
  if (packId) query.set("view", `pack:${packId}`);
  else query.delete("view");
  if (context.workspaceId) query.set("workspaceId", context.workspaceId);
  if (context.citadelId) query.set("citadelId", context.citadelId);
  const target = resolveCockpitCompatibility(`/library/prompt-packs?${query}${context.hash ?? ""}`);
  if (target.kind !== "native") throw new Error("Native prompt-pack workbench is unavailable.");
  return target.href;
}

/** Workspace is presentation context; the existing workbench owns all run/scoring policy. */
export function usePromptPackQualityHref() {
  const route = useCockpitRoute();
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  return (packId?: string) =>
    promptPackQualityHref(packId, {
      search: route.search,
      hash: route.hash,
      workspaceId: activeWorkspaceId ?? "default",
      citadelId: activeCitadelId ?? undefined,
    });
}
