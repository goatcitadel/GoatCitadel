import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useDesktopUpdates } from "../../features/desktop-updates/desktop-update-bridge";
import { backupTrustFromInbox } from "../areas/system/backup-trust";
import { summarizeHealthChecks } from "../areas/system/health-overview";
import { deriveSystemHealthChecks, hasDeferredHealthChecks } from "../areas/system/system-health";
import {
  loadSystemHealthDigest,
  loadSystemHealthSources,
  retainedHealthObservations,
  staleHealthSources,
  type SystemHealthSources,
} from "../areas/system/system-health-sources";
import { recordView } from "../data/record-view";
import { useOperatorInbox } from "../data/use-operator-inbox";
import { inboxMatchesWorkspace } from "../areas/inbox/inbox-presentation";
import { healthQueryScope } from "../data/health-query-scope";
import { queryKeys } from "../data/query-keys";

/** Fallback only: health-relevant events refresh the digest (throttled), so it polls every 5 minutes. */
export const HEALTH_DIGEST_INTERVAL_MS = 300_000;
const DEFERRED_NOTE = "Channel and worker checks run on System › Health.";

export function healthDigestKey(
  workspaceId: string,
  accessRevision = getGatewayAccessRevision(),
  scopeGeneration = 0,
  deferOptionalSources = false,
) {
  return [
    "system",
    "health",
    "digest",
    workspaceId,
    getGatewayApiBaseUrl(),
    accessRevision,
    scopeGeneration,
    deferOptionalSources ? "core" : "digest",
  ] as const;
}

/** Shell consumers share one core read; detailed consumers retain independent runtime observations. */
export function useHealthDigest(workspaceId: string, enabled: boolean, deferOptionalSources = false) {
  const client = useQueryClient();
  const accessRevision = useSyncExternalStore(
    subscribeGatewayAccessChange,
    getGatewayAccessRevision,
    getGatewayAccessRevision,
  );
  const scope = healthQueryScope(client, workspaceId, accessRevision, enabled);
  return useQuery({
    queryKey: healthDigestKey(workspaceId, accessRevision, scope[2], deferOptionalSources),
    queryFn: ({ queryKey }) =>
      loadSystemHealthDigest(client.getQueryData<SystemHealthSources>(queryKey), { deferOptionalSources }),
    staleTime: 30_000,
    refetchInterval: HEALTH_DIGEST_INTERVAL_MS,
    enabled,
  });
}

export interface HealthDigestStatus {
  /** checking includes a retained summary during refresh; stale = failed refresh with earlier evidence. */
  phase: "checking" | "stale" | "unavailable" | "ready";
  label: string;
  tone: StatusTone;
  title: string;
  retry: () => void;
}

/** One summary line for the digest, kept during refetches (NV-04). */
export function useHealthDigestStatus(
  workspaceId: string,
  enabled: boolean,
  deferOptionalSources = false,
): HealthDigestStatus {
  const query = useHealthDigest(workspaceId, enabled, deferOptionalSources);
  const desktopUpdates = useDesktopUpdates();
  const inbox = useOperatorInbox(workspaceId);
  const view = recordView(query);
  const client = useQueryClient();
  const inspected = useQuery({
    queryKey: [
      ...queryKeys.health(workspaceId),
      ...healthQueryScope(client, workspaceId, getGatewayAccessRevision(), enabled),
    ],
    queryFn: ({ queryKey }) => loadSystemHealthSources(workspaceId, client.getQueryData<SystemHealthSources>(queryKey)),
    enabled: false,
  });
  const retry = () => void query.refetch();
  if (deferOptionalSources && inspected.data) {
    const earlierProblems = deriveSystemHealthChecks(retainedHealthObservations(inspected.data), desktopUpdates).filter(
      (check) => check.status.tone === "failed" || check.status.tone === "waiting",
    );
    if (earlierProblems.length)
      return {
        phase: "stale",
        tone: earlierProblems.some((check) => check.status.tone === "failed") ? "failed" : "waiting",
        label: `Earlier system check needs review · ${earlierProblems.map((check) => check.title).join(", ")}`,
        title: `${earlierProblems.map((check) => check.detail).join(" ")} Last inspected ${new Date(inspected.dataUpdatedAt).toLocaleString()}. Recheck on System › Health; this is retained evidence.`,
        retry: () => void inspected.refetch(),
      };
  }
  if (view.record) {
    const scopedInbox = !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined;
    const summary = summarizeHealthChecks(
      deriveSystemHealthChecks(
        view.record,
        desktopUpdates,
        backupTrustFromInbox(
          scopedInbox,
          view.record.summary.state === "current" ? view.record.summary.value.backups.latest : undefined,
        ),
      ),
    );
    const label = deferOptionalSources ? `Core checks · ${summary.label}` : summary.label;
    const deferredNote = deferOptionalSources
      ? "Managed local runtimes, integrations, channels and workers are checked on System › Health."
      : DEFERRED_NOTE;
    const title = hasDeferredHealthChecks(view.record)
      ? `${label.replace(/[.!?]+$/, "")}. ${deferredNote.replace(/[.!?]+$/, "")}`
      : label;
    const staleSources = staleHealthSources(view.record);
    if (!query.isFetching && staleSources.length) {
      const observations = staleSources
        .map(
          ({ name, observedAt }) =>
            `${name}: last observed ${observedAt ? new Date(observedAt).toLocaleString() : "at an unavailable time"}`,
        )
        .join(". ");
      return {
        phase: "stale",
        label: `Stale system checks · ${label}`,
        tone: "neutral",
        title: `${title}. ${observations}. Some sources could not refresh; retained observations are not current health.`,
        retry,
      };
    }
    const lastChecked = view.checkedAt
      ? `Last checked ${new Date(view.checkedAt).toLocaleString()}.`
      : "Last check time unavailable.";
    if (view.stale) {
      const failed = view.phase === "error" && !query.isFetching;
      const retainedLabel = `${failed ? "Stale system checks" : "Checking for changes…"} · ${label}`;
      return {
        phase: failed ? "stale" : "checking",
        label: `${retainedLabel}. ${lastChecked}`,
        tone: "neutral",
        title: `${title}. ${lastChecked} ${failed ? "The refresh failed; showing earlier evidence." : "Checking for changes; showing earlier evidence."}`,
        retry,
      };
    }
    return { phase: "ready", label, tone: summary.tone, title: `${title}. ${lastChecked}`, retry };
  }
  if (view.phase === "error")
    return {
      phase: "unavailable",
      label: "System checks unavailable",
      tone: "neutral",
      title: "System checks unavailable",
      retry,
    };
  return { phase: "checking", label: "Checking system…", tone: "neutral", title: "Checking system…", retry };
}
