import { formatAbsoluteTime, plural } from "@goatcitadel/mission-control-shared/content/format";
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
import type { HealthCheck } from "../areas/system/health-overview";
import { deriveSystemHealthChecks, hasDeferredHealthChecks, HEALTH_SOURCE_LABELS } from "../areas/system/system-health";
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
        label: "Earlier check needs review",
        title: `${earlierProblems.map((check) => `${check.title}: ${check.detail}${check.lastKnown ? ` ${check.lastKnown}` : ""}`).join(" ")} Last checked ${formatAbsoluteTime(inspected.dataUpdatedAt)}. This is an earlier result; recheck on System › Health.`,
        retry: () => void inspected.refetch(),
      };
  }
  if (view.record) {
    const scopedInbox = !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined;
    const summary = summarizeDigest(
      deriveSystemHealthChecks(
        view.record,
        desktopUpdates,
        backupTrustFromInbox(
          scopedInbox,
          view.record.summary.state === "current" ? view.record.summary.value.backups.latest : undefined,
        ),
      ),
      deferOptionalSources,
    );
    const deferredNote = deferOptionalSources
      ? "Managed local runtimes, integrations, channels and workers are checked on System › Health."
      : DEFERRED_NOTE;
    const title = hasDeferredHealthChecks(view.record) ? `${summary.sentence} ${deferredNote}` : summary.sentence;
    const staleSources = staleHealthSources(view.record);
    if (!query.isFetching && staleSources.length) {
      const observations = staleSources
        .map(
          ({ name, observedAt }) =>
            `${HEALTH_SOURCE_LABELS[name]}: last checked ${observedAt ? formatAbsoluteTime(observedAt) : "at an unknown time"}`,
        )
        .join(". ");
      return {
        phase: "stale",
        label: "Checks out of date",
        tone: "neutral",
        title: `${title} ${observations}. Some checks could not refresh, so these are earlier results.`,
        retry,
      };
    }
    const lastChecked = view.checkedAt
      ? `Last checked ${formatAbsoluteTime(view.checkedAt)}.`
      : "Last check time unavailable.";
    if (view.stale) {
      const failed = view.phase === "error" && !query.isFetching;
      return {
        phase: failed ? "stale" : "checking",
        label: failed ? "Checks out of date" : "Checking…",
        tone: "neutral",
        title: `${title} ${lastChecked} ${failed ? "The refresh failed; showing earlier results." : "Checking again; showing earlier results."}`,
        retry,
      };
    }
    return { phase: "ready", label: summary.label, tone: summary.tone, title: `${title} ${lastChecked}`, retry };
  }
  if (view.phase === "error")
    return {
      phase: "unavailable",
      label: "Checks unavailable",
      tone: "neutral",
      title: "System checks unavailable. Retry, or open System › Health.",
      retry,
    };
  return { phase: "checking", label: "Checking…", tone: "neutral", title: "Checking system…", retry };
}

/** One short state for the 248px rail (SH-13); the full sentence goes in the title. */
function summarizeDigest(
  checks: readonly HealthCheck[],
  coreOnly: boolean,
): { label: string; sentence: string; tone: StatusTone } {
  const problems = checks.filter((check) => check.status.tone === "failed" || check.status.tone === "waiting");
  if (problems.length) {
    const label = `${plural(problems.length, "check")} ${problems.length === 1 ? "needs" : "need"} review`;
    return {
      label,
      sentence: `${label}: ${problems.map((check) => check.title).join(", ")}.`,
      tone: problems.some((check) => check.status.tone === "failed") ? "failed" : "waiting",
    };
  }
  if (!checks.length)
    return { label: "Checks unverified", sentence: "No system checks reported yet.", tone: "neutral" };
  const unknown = checks.filter((check) => check.status.tone === "neutral" && !check.notSetUp);
  if (unknown.length)
    return {
      label: `${plural(unknown.length, "check")} unverified`,
      sentence: `Not verified yet: ${unknown.map((check) => check.title).join(", ")}.`,
      tone: "neutral",
    };
  return coreOnly
    ? { label: "Core checks passing", sentence: "Core system checks report no problems.", tone: "done" }
    : { label: "All checks passing", sentence: "System checks report no problems.", tone: "done" };
}
