import { canonicalJsonString, type ToolGrantCreateInput, type ToolGrantRecord } from "@goatcitadel/contracts";

export type ToolGrantDraft = {
  toolPattern: string;
  decision: string;
  scope: string;
  scopeRef: string;
  grantType: string;
  expiresAt: string;
};
export type ToolGrantRequest = Omit<ToolGrantCreateInput, "createdBy">;
const scopes = ["global", "workspace", "session", "agent", "task"] as const;
export function normalizeToolGrantDraft(draft: ToolGrantDraft): ToolGrantRequest {
  if (!draft.toolPattern.trim()) throw new Error("Tool pattern is required.");
  if (draft.decision !== "allow" && draft.decision !== "deny") throw new Error("Choose an allow or deny decision.");
  if (!scopes.includes(draft.scope as (typeof scopes)[number])) throw new Error("Choose a supported grant scope.");
  if (!["persistent", "ttl", "one_time"].includes(draft.grantType)) throw new Error("Choose a supported grant type.");
  if (draft.scope !== "global" && !draft.scopeRef.trim()) throw new Error(`Add the exact ${draft.scope} ID.`);
  if (draft.decision === "deny" && draft.grantType === "one_time")
    throw new Error("One-use grants can only allow an action.");
  const expiresAt = draft.expiresAt.trim();
  if (draft.grantType === "ttl" && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    throw new Error("Choose a future expiry. The Gateway also checks its database clock.");
  }
  return {
    toolPattern: draft.toolPattern.trim(),
    decision: draft.decision,
    scope: draft.scope as ToolGrantRequest["scope"],
    grantType: draft.grantType as ToolGrantRequest["grantType"],
    ...(draft.scope === "global" ? {} : { scopeRef: draft.scopeRef.trim() }),
    ...(draft.grantType === "ttl" ? { expiresAt } : {}),
  };
}
export function toolGrantMatchesRequest(record: ToolGrantRecord | undefined, request: ToolGrantRequest): boolean {
  return Boolean(
    record?.grantId &&
    record.createdBy &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    record.toolPattern === request.toolPattern &&
    record.decision === request.decision &&
    record.scope === request.scope &&
    record.scopeRef === (request.scope === "global" ? "global" : request.scopeRef) &&
    record.grantType === request.grantType &&
    record.expiresAt === request.expiresAt &&
    canonicalJsonString(record.constraints ?? {}) === canonicalJsonString(request.constraints ?? {}),
  );
}
/** Consumption and revocation can advance; the recorded grant identity is immutable. */
export function sameToolGrantIdentity(reviewed: ToolGrantRecord, current: ToolGrantRecord | undefined): boolean {
  return Boolean(
    current &&
    [
      "grantId",
      "toolPattern",
      "decision",
      "scope",
      "scopeRef",
      "grantType",
      "createdAt",
      "createdBy",
      "expiresAt",
    ].every((key) => reviewed[key as keyof ToolGrantRecord] === current[key as keyof ToolGrantRecord]) &&
    canonicalJsonString(reviewed.constraints ?? {}) === canonicalJsonString(current.constraints ?? {}),
  );
}
