import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { createChangePlan, fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  approvePlanInPlace,
  failed,
  type InPlaceOutcome,
} from "../../../cockpit/areas/chat/channel-setup/approve-plan-in-place";
import { isBaseUrlAllowlisted } from "../../../cockpit/areas/settings/web-search-state";

/** Said when the allowlist couldn't be read: until it is, a page can't list every host, so it can't go ahead. */
export const HOSTS_UNKNOWN = "GoatCitadel couldn't check which hosts it may reach. Try again.";

const unlistedHost = (host: string) =>
  `GoatCitadel needs to reach ${host}. Reload this page to see the change before turning it on.`;

/** The Inbox page for one approval, in the workspace the change was made in. */
export function inboxApprovalHref(approvalId: string, workspaceId: string): string {
  return `/inbox?approvalId=${encodeURIComponent(approvalId)}&workspaceId=${encodeURIComponent(workspaceId)}`;
}

/** The Inbox item for one change, in the workspace the change was made in. */
export function inboxPlanHref(planId: string, workspaceId: string): string {
  return `/inbox?${new URLSearchParams({ item: `change_plan:${planId}`, workspaceId })}`;
}

/** The hosts, of those a channel needs, that the outbound allowlist does not yet allow. The same check Turn on makes. */
export function missingHosts(requiredHosts: readonly string[], allowlist: readonly string[]): string[] {
  return [...new Set(requiredHosts)].filter((host) => !isBaseUrlAllowlisted(`https://${host}/`, allowlist));
}

export interface MissingHosts {
  /** The allowlist has been read, so `missing` names every host Turn on would add. Until then it names none. */
  known: boolean;
  missing: string[];
  /** The allowlist couldn't be read. */
  failed: boolean;
  /** Reads the allowlist again. */
  retry(): void;
}

/**
 * Which of a channel's hosts Turn on will have to add. It reads the settings only once asked to (`enabled`), shares
 * the Web & Search page's settings read so one allowlist is never fetched twice, and names no host until it has read
 * them: the page then says nothing it has not seen, and keeps its button off until `known`.
 */
export function useMissingHosts(requiredHosts: readonly string[] | undefined, enabled: boolean): MissingHosts {
  const settings = useQuery({
    queryKey: ["system", "settings-web-search"],
    queryFn: () => fetchSettings(),
    enabled: enabled && (requiredHosts?.length ?? 0) > 0,
    retry: false,
  });
  const { refetch } = settings;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (requiredHosts?.length === 0) return { known: true, missing: [], failed: false, retry };
  if (requiredHosts && settings.data) {
    return { known: true, missing: missingHosts(requiredHosts, settings.data.networkAllowlist), failed: false, retry };
  }
  return { known: false, missing: [], failed: settings.isError, retry };
}

/**
 * Makes sure GoatCitadel may reach every host a channel needs. Any missing hosts go into the outbound allowlist as
 * their own change in the caller's workspace, which is approved in place like the channel's change. It does not use
 * the Settings save: that route plans in the default workspace and applies with the operator's approval skip, and
 * Turn on never takes the skip. A finished allowlist change is "allowed", never "completed": that word is for the
 * channel's own change. A host missing now that is not in `shownHosts`, the ones the page listed, is never added:
 * the click is blocked so the operator can see the change first.
 */
export async function ensureHostsAllowed(
  hosts: readonly string[],
  workspaceId: string,
  shownHosts: readonly string[],
): Promise<{ kind: "allowed" } | InPlaceOutcome | { kind: "blocked"; reasons: string[] }> {
  if (hosts.length === 0) return { kind: "allowed" };
  try {
    const settings = await fetchSettings();
    const missing = missingHosts(hosts, settings.networkAllowlist);
    if (missing.length === 0) return { kind: "allowed" };
    const shown = new Set(shownHosts.map((host) => host.trim().toLowerCase()));
    const unshown = missing.filter((host) => !shown.has(host.trim().toLowerCase()));
    if (unshown.length > 0) return { kind: "blocked", reasons: unshown.map(unlistedHost) };
    const plan = await createChangePlan({
      workspaceId,
      surface: "settings",
      request: {
        kind: "runtime_configuration",
        change: { operation: "network_allowlist", entries: [...settings.networkAllowlist, ...missing] },
      },
      idempotencyKey: `messaging-allow-hosts:${[...missing].sort().join(",")}:${settings.revision}`,
    });
    const outcome = await approvePlanInPlace(plan.planId, workspaceId);
    return outcome.kind === "completed" ? { kind: "allowed" } : outcome;
  } catch (error) {
    return failed(describeApiError(error).summary);
  }
}
