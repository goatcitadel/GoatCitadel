import type { DurableRunRecord } from "@goatcitadel/contracts";

/** Client safety check only; the Gateway remains the authority for every run action. */
export function durableRunWorkspaceId(run: DurableRunRecord): string | null {
  const payload = typeof run.payload.workspaceId === "string" ? run.payload.workspaceId.trim() : null;
  const metadata = typeof run.metadata?.workspaceId === "string" ? run.metadata.workspaceId.trim() : null;
  if (payload && metadata && payload !== metadata) return null;
  return payload || metadata || null;
}
