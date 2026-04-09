import type {
  CapabilityCatalogEntry,
  CapabilityCatalogScope,
  CapabilityCatalogSnapshotRecord,
  CapabilityProposalRecord,
  CodeModeRunRecord,
  CodeModeRunRequest,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchCapabilityCatalog(
  scope: CapabilityCatalogScope = "inspectable",
): Promise<{ scope: CapabilityCatalogScope; items: CapabilityCatalogEntry[] }> {
  return request(`/api/v1/capabilities/catalog?scope=${encodeURIComponent(scope)}`);
}

export async function fetchCapabilityCatalogSnapshot(snapshotId: string): Promise<CapabilityCatalogSnapshotRecord> {
  return request(`/api/v1/capabilities/snapshots/${encodeURIComponent(snapshotId)}`);
}

export async function fetchCapabilityProposals(limit = 100): Promise<{ items: CapabilityProposalRecord[] }> {
  return request(`/api/v1/capabilities/proposals?limit=${Math.max(1, Math.min(limit, 500))}`);
}

export async function createCapabilityProposal(input: {
  proposalKind: "skill" | "tool";
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  candidateId?: string;
  activationTargetId?: string;
}): Promise<CapabilityProposalRecord> {
  return request("/api/v1/capabilities/proposals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchCodeModeRuns(limit = 100): Promise<{ items: CodeModeRunRecord[] }> {
  return request(`/api/v1/code-mode/runs?limit=${Math.max(1, Math.min(limit, 500))}`);
}

export async function fetchCodeModeRun(runId: string): Promise<CodeModeRunRecord> {
  return request(`/api/v1/code-mode/runs/${encodeURIComponent(runId)}`);
}

export async function createCodeModeRun(input: CodeModeRunRequest): Promise<CodeModeRunRecord> {
  return request("/api/v1/code-mode/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
