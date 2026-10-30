import type {
  CapabilitySkillActionOutcome,
  CapabilitySkillDetail,
  CapabilitySkillDiscoverResponse,
  CapabilitySkillInstall,
  CapabilitySkillInstallsResponse,
  CapabilitySkillOperationRequest,
  CapabilitySkillReviewRequest,
  CapabilitySkillStateRequest,
  CapabilitySkillsResponse,
  CapabilitySkillUsageResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

/**
 * Installed skills for the Capabilities page. The Gateway builds every row, switch, and left-out mark; the cockpit only
 * renders it. The route reads `workspaceId` and nothing else, so no other parameter is sent.
 */
export async function fetchCapabilitySkills(
  workspaceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilitySkillsResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<CapabilitySkillsResponse>(`/api/v1/capabilities/skills?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * A year of skill use counts. The Gateway keeps the counts for a while; `refresh` asks it to count again, and is sent
 * only when asked.
 */
export async function fetchCapabilitySkillUsage(
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<CapabilitySkillUsageResponse> {
  const query = options.refresh ? `?${new URLSearchParams({ refresh: "true" })}` : "";
  return request<CapabilitySkillUsageResponse>(`/api/v1/capabilities/skills/usage${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** One skill's details for its panel, including its SKILL.md text. Both ids are encoded into the query string. */
export async function fetchCapabilitySkillDetail(
  workspaceId: string,
  skillId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CapabilitySkillDetail> {
  const query = new URLSearchParams({ workspaceId, skillId });
  return request<CapabilitySkillDetail>(`/api/v1/capabilities/skills/detail?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Switches a skill on, paused, or off. The outcome says whether the change applied, waits for the operator's approval,
 * was declined, or changed nothing. No field chooses the operator's skip; the Gateway decides it. The client adds the
 * Idempotency-Key every non-GET carries.
 */
export async function setCapabilitySkillState(
  input: CapabilitySkillStateRequest,
): Promise<CapabilitySkillActionOutcome> {
  return request<CapabilitySkillActionOutcome>("/api/v1/capabilities/skills/state", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * The skills on offer to install. With no term the Gateway answers GoatCitadel's own packs and the curated listings and
 * goes nowhere online; with `q` (2 to 100 characters) it also searches the marketplaces. `q` and `refresh` are sent
 * only when asked, and an empty term is not a term.
 */
export async function fetchCapabilitySkillDiscover(
  workspaceId: string,
  options: { q?: string; refresh?: boolean; signal?: AbortSignal } = {},
): Promise<CapabilitySkillDiscoverResponse> {
  const query = new URLSearchParams({ workspaceId });
  if (options.q) query.set("q", options.q);
  if (options.refresh) query.set("refresh", "true");
  return request<CapabilitySkillDiscoverResponse>(`/api/v1/capabilities/skills/discover?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * The installs still on their way in, or stopped, in a workspace, and whether the operator's skip applies. With
 * `snapshotId` the Gateway answers just that check at whatever step it is on (done included), or none.
 */
export async function fetchCapabilitySkillInstalls(
  workspaceId: string,
  options: { snapshotId?: string; signal?: AbortSignal } = {},
): Promise<CapabilitySkillInstallsResponse> {
  const query = new URLSearchParams({ workspaceId });
  if (options.snapshotId) query.set("snapshotId", options.snapshotId);
  return request<CapabilitySkillInstallsResponse>(`/api/v1/capabilities/skills/installs?${query}`, {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Checks a source (one of GoatCitadel's packs, or an https Git address) and answers the checked skill. The request's
 * own `idempotencyKey` makes a retry hand back the same check; the client adds the Idempotency-Key header every
 * non-GET carries. A refused source is a 422 the caller reads from the error body.
 */
export async function reviewCapabilitySkill(input: CapabilitySkillReviewRequest): Promise<CapabilitySkillInstall> {
  return request<CapabilitySkillInstall>("/api/v1/capabilities/skills/reviews", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Asks for one install step of a checked skill. The outcome says whether the step's approval was granted already or
 * waits for the operator. No field chooses the operator's skip; the Gateway decides it.
 */
export async function requestCapabilitySkillOperation(
  input: CapabilitySkillOperationRequest,
): Promise<CapabilitySkillActionOutcome> {
  return request<CapabilitySkillActionOutcome>("/api/v1/capabilities/skills/operations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
