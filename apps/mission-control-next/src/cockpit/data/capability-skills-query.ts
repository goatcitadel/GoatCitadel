import { queryOptions } from "@tanstack/react-query";
import {
  fetchCapabilitySkillDetail,
  fetchCapabilitySkillDiscover,
  fetchCapabilitySkillInstalls,
  fetchCapabilitySkillUsage,
  fetchCapabilitySkills,
} from "@goatcitadel/mission-control-shared/api/capability-skills";
import { queryKeys } from "./query-keys";

/**
 * The Capabilities installed skills for one workspace. Every observer of this key must use these options (the Skills
 * tab, and the skill panel with `enabled: false`): all observers write their options onto the one shared query, so an
 * observer that carried no `queryFn` of its own would leave the next re-read with nothing to run.
 */
export function skillListQuery(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilitySkills(workspaceId),
    queryFn: ({ signal }) => fetchCapabilitySkills(workspaceId, { signal }),
  });
}

/**
 * A year of skill use counts. They change slowly and the Gateway caches them, so a minute is fresh enough. A manual
 * refresh asks the Gateway to re-count through `fetchCapabilitySkillUsage({ refresh: true })`.
 */
export function skillUsageQuery() {
  return queryOptions({
    queryKey: queryKeys.capabilitySkillUsage(),
    queryFn: ({ signal }) => fetchCapabilitySkillUsage({ signal }),
    staleTime: 60_000,
  });
}

/**
 * One skill's details for its panel. Every observer of this key must use these options, for the same reason as the
 * list: the key names the workspace and the skill, so a skill change refreshes it through the shared prefix.
 */
export function skillDetailQuery(workspaceId: string, skillId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilitySkillDetail(workspaceId, skillId),
    queryFn: ({ signal }) => fetchCapabilitySkillDetail(workspaceId, skillId, { signal }),
  });
}

/**
 * The skills on offer to install. `q` is the search term the Gateway should search for, or empty for the list it gives
 * without one (packs and curated listings, nothing online). Only a term of two or more characters may be passed: the
 * Gateway refuses a shorter one.
 */
export function skillDiscoverQuery(workspaceId: string, q: string) {
  return queryOptions({
    queryKey: queryKeys.capabilitySkillDiscover(workspaceId, q),
    queryFn: ({ signal }) => fetchCapabilitySkillDiscover(workspaceId, { ...(q ? { q } : {}), signal }),
  });
}

/**
 * The installs still on their way in, with whether the operator's skip applies. Every observer of this key must use
 * these options, for the same reason as the list.
 */
export function skillInstallsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilitySkillInstalls(workspaceId),
    queryFn: ({ signal }) => fetchCapabilitySkillInstalls(workspaceId, { signal }),
  });
}

/**
 * One checked skill at whatever step its install is on (done included), or `undefined` when the workspace's newest
 * checks don't hold it. The install panel reads it when an address names a check it isn't following already.
 */
export function skillInstallQuery(workspaceId: string, snapshotId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilitySkillInstall(workspaceId, snapshotId),
    queryFn: async ({ signal }) =>
      (await fetchCapabilitySkillInstalls(workspaceId, { snapshotId, signal })).installs.find(
        (install) => install.snapshotId === snapshotId,
      ) ?? null,
  });
}
