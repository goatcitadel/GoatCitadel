import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilitySkillUsageResponse } from "@goatcitadel/contracts";
import { fetchCapabilitySkillUsage } from "@goatcitadel/mission-control-shared/api/capability-skills";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { skillUsageQuery } from "../../../data/capability-skills-query";
import { lastVersionNote, recordView } from "../../../data/record-view";
import { presentSkillUses } from "./skill-view";

const OLD_COUNTS = "Use counts can't be refreshed right now.";

export interface SkillUsage {
  /** The last counts read. They stay beside a failed recheck. */
  usage: CapabilitySkillUsageResponse | undefined;
  /** The uses line of one skill: its count, or "Uses unknown" while there are no counts to show. */
  usesFor(skillId: string): string;
  /** There are no counts to show and the read failed: the tab says so and offers Try again. */
  unavailable: boolean;
  /** The one line about counts that are old, when a recheck or a refresh failed. The counts stay on screen. */
  oldCountsNote: string | undefined;
  /** Reads the counts again after a first read that failed. */
  retry(): void;
  retrying: boolean;
  /** Asks the Gateway to count again now, past the cache it keeps. */
  refresh(): void;
  refreshing: boolean;
}

/**
 * The year of use counts for the Skills tab. The counts come from the query's last good answer, so a refresh in flight
 * or a failed one never turns them into "Uses unknown" (the refetch guard). A manual refresh asks the Gateway to
 * re-count and writes its answer into the same cache entry, because a plain `refetch()` would not send `refresh=true`.
 */
export function useSkillUsage(): SkillUsage {
  const client = useQueryClient();
  const query = useQuery(skillUsageQuery());
  const view = recordView(query);
  const usage = view.record;
  const [refreshing, setRefreshing] = useState(false);
  // The refresh that failed is tied to the counts it failed on, so a newer answer from anywhere clears the line.
  const [failed, setFailed] = useState<{ on: number; reason: string } | undefined>();
  const running = useRef(false);

  const refresh = useCallback(() => {
    if (running.current) return;
    running.current = true;
    setRefreshing(true);
    const before = client.getQueryState(skillUsageQuery().queryKey)?.dataUpdatedAt;
    // A read already in flight would otherwise answer after the refresh and put its older counts back.
    void client
      .cancelQueries({ queryKey: skillUsageQuery().queryKey })
      .then(() => fetchCapabilitySkillUsage({ refresh: true }))
      .then((fresh) => {
        client.setQueryData(skillUsageQuery().queryKey, fresh);
        setFailed(undefined);
      })
      .catch((error: unknown) => setFailed({ on: before ?? 0, reason: describeApiError(error).summary }))
      .finally(() => {
        running.current = false;
        setRefreshing(false);
      });
  }, [client]);

  // Retrying clears the error while the first read runs again, so a read that has failed before keeps the trouble line
  // (and the button, with its focus) until it answers.
  const unavailable =
    usage === undefined && (view.phase === "error" || (query.isFetching && query.errorUpdateCount > 0));
  const refreshFailure = failed && failed.on === (query.dataUpdatedAt || 0) ? failed : undefined;
  const lastVersion = lastVersionNote(view);
  // The reason comes from the refresh that failed, else from the recheck that did, as the list's own warning does.
  const reason = refreshFailure?.reason ?? (query.error ? describeApiError(query.error).summary : undefined);
  const oldCountsNote =
    usage && (refreshFailure || lastVersion) ? [OLD_COUNTS, reason, lastVersion].filter(Boolean).join(" ") : undefined;
  const status = usage ? "ready" : "unknown";

  return {
    usage,
    usesFor: (skillId) =>
      presentSkillUses(
        usage?.skills.find((entry) => entry.skillId === skillId),
        status,
      ),
    unavailable,
    oldCountsNote,
    retry: () => void query.refetch(),
    retrying: query.isFetching,
    refresh,
    refreshing,
  };
}
