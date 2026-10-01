import type { AgentProfileRecord, ChatSessionRecord, ToolAccessEvaluateRequest, ToolAccessEvaluateResponse, ToolCatalogEntry } from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { evaluateToolAccess, fetchEffectivePermissionProfile, fetchToolCatalog } from "@goatcitadel/mission-control-shared/api/approvals";
import { fetchChatSessions, fetchChatSessionStatus } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchAgent, fetchAgents } from "@goatcitadel/mission-control-shared/api/operators-agents-files";

export const POLICY_CONTEXT_LIMIT = 50;
export const POLICY_ARGUMENT_BYTE_LIMIT = 16 * 1024;
export type PolicyInspectionInput = Pick<ToolAccessEvaluateRequest, "toolName" | "agentId" | "sessionId" | "args" | "trustLevel"> & {
  workspaceId: string;
  surface: "chat" | "tools";
};
export interface PolicyInspectionOptions {
  tool: ToolCatalogEntry;
  agents: AgentProfileRecord[];
  sessions: ChatSessionRecord[];
  agentsPartial: boolean;
  sessionsPartial: boolean;
}
export interface PolicyInspectionResult {
  decision: ToolAccessEvaluateResponse;
  profileLabel: string;
  checkedAt: string;
}

function exactTool(items: ToolCatalogEntry[], toolName: string) {
  const matches = items.filter((tool) => tool.toolName === toolName);
  if (matches.length !== 1) throw new Error("This tool has no unique current tool-catalog record. Refresh the Library.");
  return matches[0]!;
}

export async function loadPolicyInspectionOptions(workspaceId: string, toolName: string): Promise<PolicyInspectionOptions> {
  const [catalog, agents, sessions] = await Promise.all([
    fetchToolCatalog(), fetchAgents("active", POLICY_CONTEXT_LIMIT),
    fetchChatSessions({ workspaceId, scope: "mission", view: "active", limit: POLICY_CONTEXT_LIMIT }),
  ]);
  return {
    tool: exactTool(catalog.items, toolName),
    agents: agents.items.filter((agent) => agent.lifecycleStatus === "active").slice(0, POLICY_CONTEXT_LIMIT),
    sessions: sessions.items.filter((session) => session.workspaceId === workspaceId && session.lifecycleStatus === "active").slice(0, POLICY_CONTEXT_LIMIT),
    agentsPartial: agents.items.length >= POLICY_CONTEXT_LIMIT,
    sessionsPartial: Boolean(sessions.nextCursor) || sessions.items.length >= POLICY_CONTEXT_LIMIT,
  };
}

export function parsePolicyArguments(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).byteLength > POLICY_ARGUMENT_BYTE_LIMIT) throw new Error("Arguments exceed the 16 KiB inspection limit.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Enter a valid JSON object for the custom arguments."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments must be an object, including {} for an empty object.");
  return value as Record<string, unknown>;
}

function profileIdentity(value: Record<string, unknown>, input: PolicyInspectionInput) {
  if (value.workspaceId !== input.workspaceId || value.sessionId !== input.sessionId || value.surface !== input.surface) {
    throw new Error("The effective policy returned a different conversation or workspace. Refresh the inspection.");
  }
  const profile = value.permissionProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("The effective permission profile is unavailable.");
  const record = profile as Record<string, unknown>;
  if (typeof record.profileId !== "string" || !record.profileId || typeof record.label !== "string" || !record.label
    || (value.permissionProfileId !== undefined && value.permissionProfileId !== record.profileId)
    || (value.localOperatorOverrideId !== undefined && typeof value.localOperatorOverrideId !== "string")) {
    throw new Error("The effective permission profile has inconsistent owner evidence.");
  }
  const override = value.localOperatorOverride;
  if (value.localOperatorOverrideId !== undefined || override !== undefined) {
    if (!override || typeof override !== "object" || Array.isArray(override)
      || typeof value.localOperatorOverrideId !== "string" || !value.localOperatorOverrideId
      || (override as Record<string, unknown>).overrideId !== value.localOperatorOverrideId) {
      throw new Error("The effective operator override has incomplete or inconsistent owner evidence.");
    }
  }
  return { profileId: record.profileId, label: record.label, overrideId: value.localOperatorOverrideId as string | undefined,
    // Compare all owner fields, including optional revisions, before publishing the advisory result.
    snapshot: canonicalJsonString({ permissionProfile: profile, localOperatorOverride: override }) };
}

function assertDecision(value: ToolAccessEvaluateResponse, input: PolicyInspectionInput) {
  if (!value || value.toolName !== input.toolName || typeof value.allowed !== "boolean" || typeof value.requiresApproval !== "boolean"
    || !["safe", "caution", "danger", "nuclear"].includes(value.riskLevel)
    || !Array.isArray(value.reasonCodes) || value.reasonCodes.some((reason) => typeof reason !== "string")
    || (value.matchedGrantId !== undefined && typeof value.matchedGrantId !== "string")
    || (value.wardEffect !== undefined && typeof value.wardEffect !== "string")
    || (value.permissionProfileId !== undefined && typeof value.permissionProfileId !== "string")
    || (value.localOperatorOverrideId !== undefined && typeof value.localOperatorOverrideId !== "string")) {
    throw new Error("The policy evaluation returned incomplete or mismatched evidence.");
  }
}

/** The existing public evaluator records an advisory decision, never an invocation or approval. */
export async function inspectSelectedToolPolicy(input: PolicyInspectionInput, isCurrent: () => boolean): Promise<PolicyInspectionResult> {
  // Freeze the submitted object across asynchronous owner reads; preserve omission versus {}.
  input = { ...input, ...(input.args === undefined ? {} : { args: parsePolicyArguments(JSON.stringify(input.args)) }) };
  const current = () => { if (!isCurrent()) throw new Error("This policy inspection is no longer active."); };
  current();
  const query = { workspaceId: input.workspaceId, sessionId: input.sessionId, surface: input.surface };
  const [catalog, agent, session, effective] = await Promise.all([
    fetchToolCatalog(), fetchAgent(input.agentId), fetchChatSessionStatus(input.sessionId), fetchEffectivePermissionProfile(query),
  ]);
  current();
  exactTool(catalog.items, input.toolName);
  if (agent.agentId !== input.agentId || agent.lifecycleStatus !== "active") throw new Error("The selected agent is no longer active. Refresh the inspection.");
  if (session.sessionId !== input.sessionId || session.workspaceId !== input.workspaceId) throw new Error("The conversation has no matching workspace evidence.");
  const before = profileIdentity(effective, input);
  const decision = await evaluateToolAccess(input);
  current();
  assertDecision(decision, input);
  const [afterSession, afterEffective] = await Promise.all([fetchChatSessionStatus(input.sessionId), fetchEffectivePermissionProfile(query)]);
  current();
  const after = profileIdentity(afterEffective, input);
  if (afterSession.sessionId !== input.sessionId || afterSession.workspaceId !== input.workspaceId
    || before.snapshot !== after.snapshot
    || decision.permissionProfileId !== after.profileId || decision.localOperatorOverrideId !== after.overrideId) {
    throw new Error("The policy context changed during evaluation. The advisory result is withheld; inspect again.");
  }
  return { decision, profileLabel: after.label, checkedAt: new Date().toISOString() };
}
