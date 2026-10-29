import type {
  CapabilitySkillActionOutcome,
  CapabilitySkillDetail,
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
 * Switches a skill on, paused, or off. The outcome says whether the change applied, waits for an approval in the Inbox,
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
