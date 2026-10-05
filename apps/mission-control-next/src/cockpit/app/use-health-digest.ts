import { useQuery } from "@tanstack/react-query";
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useDesktopUpdates } from "../../features/desktop-updates/desktop-update-bridge";
import { backupTrustFromInbox } from "../areas/system/backup-trust";
import { summarizeHealthChecks } from "../areas/system/health-overview";
import { deriveSystemHealthChecks, hasDeferredHealthChecks } from "../areas/system/system-health";
import { loadSystemHealthDigest } from "../areas/system/system-health-sources";
import { recordView } from "../data/record-view";
import { useOperatorInbox } from "../data/use-operator-inbox";
import { inboxMatchesWorkspace } from "../areas/inbox/inbox-presentation";

/** Fallback only: health-relevant events refresh the digest (throttled), so it polls every 5 minutes. */
export const HEALTH_DIGEST_INTERVAL_MS = 300_000;
const DEFERRED_NOTE = "Channel and worker checks run on System › Health.";

export function healthDigestKey(workspaceId: string) {
  return ["system", "health", "digest", workspaceId] as const;
}

/** The sidebar dot and the phone strip share this four-read digest; the full fan-out runs on System › Health. */
export function useHealthDigest(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: healthDigestKey(workspaceId),
    queryFn: () => loadSystemHealthDigest(),
    refetchInterval: HEALTH_DIGEST_INTERVAL_MS,
    enabled,
  });
}

export interface HealthDigestStatus {
  /** checking = no answer yet; unavailable = the read failed with nothing to show; ready = a summary. */
  phase: "checking" | "unavailable" | "ready";
  label: string;
  tone: StatusTone;
  title: string;
  retry: () => void;
}

/** One summary line for the digest, kept during refetches (NV-04). */
export function useHealthDigestStatus(workspaceId: string, enabled: boolean): HealthDigestStatus {
  const query = useHealthDigest(workspaceId, enabled);
  const desktopUpdates = useDesktopUpdates();
  const inbox = useOperatorInbox(workspaceId);
  const view = recordView(query);
  const retry = () => void query.refetch();
  if (view.record) {
    const scopedInbox = !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined;
    const summary = summarizeHealthChecks(
      deriveSystemHealthChecks(view.record, desktopUpdates, backupTrustFromInbox(scopedInbox)),
    );
    const title = hasDeferredHealthChecks(view.record) ? `${summary.label}. ${DEFERRED_NOTE}` : summary.label;
    return { phase: "ready", label: summary.label, tone: summary.tone, title, retry };
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
