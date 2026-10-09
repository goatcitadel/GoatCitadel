import { describe, expect, it, vi } from "vitest";
import type { CodeModeRunVerificationResponse, EngineeringLearningRecord } from "@goatcitadel/contracts";
import { EngineeringLearningService, type EngineeringLearningProposalInput } from "./engineering-learning-service.js";
const source = { run: { runId: "run-a", workspaceId: "one", sessionId: "chat-a", turnId: "turn-a", status: "completed", verification: { status: "verified", evidenceId: "proof-a", subjectHash: "subject" }, codeHash: "code", codeModeInputHash: "input", wrapperManifestHash: "wrapper", policySnapshotHash: "policy", stdoutArtifact: { artifactId: "stdout" } }, evidence: { evidenceId: "proof-a", runId: "run-a", workspaceId: "one", sessionId: "chat-a", turnId: "turn-a", status: "verified", subject: { subjectHash: "subject", codeHash: "code", codeModeInputHash: "input", wrapperManifestHash: "wrapper", policySnapshotHash: "policy", changedFiles: ["src/verified.ts"], changedFilesTruncated: false }, outputArtifactRefs: ["verified-output"] } } as CodeModeRunVerificationResponse;
const input: EngineeringLearningProposalInput = { workspaceId: "one", source: { runId: "run-a" }, disposition: "completed", changedFiles: ["caller-claim.ts"], verificationEvidence: ["caller says passed"], title: "Fix", problem: "Problem", rootCause: "Cause", resolution: "Resolution", prevention: "Prevention" };
function setup(response = structuredClone(source)) {
 const service = new EngineeringLearningService({ storage: {} as never, rootDir: ".", isEnabled: () => true, createApproval: vi.fn(), resolveSourceRoot: vi.fn(), resolveProjectId: async () => "project-a", readVerifiedSource: async () => response });
 const persist = vi.spyOn(service, "propose").mockResolvedValue({ learningId: "learning-a", status: "proposed" } as EngineeringLearningRecord);
 return { service, persist };
}
describe("canonical Engineering proposal source", () => {
 it("derives files, evidence, source and project from the verified owner, never client claims", async () => {
  const { service, persist } = setup(); await service.proposeFromCanonicalSource(input);
  expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: "project-a", source: { runId: "run-a", sessionId: "chat-a", turnId: "turn-a", patchArtifactId: "stdout", commitSha: undefined }, changedFiles: ["src/verified.ts"], verificationEvidence: ["code-mode-verification:proof-a", "artifact:verified-output"] }));
 });
 it.each(["missing", "foreign", "unfinished", "stale", "evidence", "hash", "truncated", "empty", "session", "project"])("rejects %s source before persistence", async kind => {
  const response = structuredClone(source); const request = structuredClone(input);
  if (kind === "missing") response.run.runId = "another";
  if (kind === "foreign") response.run.workspaceId = "other";
  if (kind === "unfinished") response.run.status = "running";
  if (kind === "stale") response.run.verification!.status = "stale";
  if (kind === "evidence") response.evidence.evidenceId = "older";
  if (kind === "hash") response.evidence.subject.codeHash = "different";
  if (kind === "truncated") response.evidence.subject.changedFilesTruncated = true;
  if (kind === "empty") response.evidence.subject.changedFiles = [];
  if (kind === "session") request.source.sessionId = "other";
  if (kind === "project") request.projectId = "other";
  const { service, persist } = setup(response); await expect(service.proposeFromCanonicalSource(request)).rejects.toThrow(); expect(persist).not.toHaveBeenCalled();
 });
 it("fails closed when no canonical source reader is composed", async () => {
  const service = new EngineeringLearningService({ storage: {} as never, rootDir: ".", isEnabled: () => true, createApproval: vi.fn(), resolveSourceRoot: vi.fn() });
  await expect(service.proposeFromCanonicalSource(input)).rejects.toThrow("unavailable");
 });
});

it("binds replacement targets to their reviewed workspace and provenance before approval", async () => {
 const createApproval = vi.fn().mockResolvedValue({ approvalId: "approval-a" });
 const service = new EngineeringLearningService({ storage: {} as never, rootDir: ".", isEnabled: () => true, createApproval, resolveSourceRoot: vi.fn() });
 const records: Record<string, EngineeringLearningRecord> = { a: { learningId: "a", workspaceId: "one", title: "Original", status: "proposed", provenanceHash: "a-hash", source: { runId: "run-a" }, verificationEvidence: ["proof-a"] } as EngineeringLearningRecord, b: { learningId: "b", workspaceId: "one", title: "Target", status: "active", provenanceHash: "b-hash" } as EngineeringLearningRecord };
 vi.spyOn(service, "get").mockImplementation(async id => records[id]!);
 await service.requestAction("a", { action: "replace", targetLearningIds: ["b"] });
 expect(createApproval).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ expectedTargetProvenance: { b: "b-hash" } }), preview: expect.objectContaining({ scopeSummary: "Workspace: one", targetSummary: "Target (active)" }) }));
 records.b!.workspaceId = "other"; createApproval.mockClear(); await expect(service.requestAction("a", { action: "replace", targetLearningIds: ["b"] })).rejects.toThrow("same workspace"); expect(createApproval).not.toHaveBeenCalled();
});
it("rejects a changed approved consolidation target before persistence", async () => {
 const upsert = vi.fn(); const service = new EngineeringLearningService({ storage: { approvals: { get: async () => ({ kind: "engineering_learning.lifecycle", status: "approved", payload: { learningId: "a", action: "consolidate", expectedProvenanceHash: "a-hash", expectedTargetProvenance: { b: "old" }, targetLearningIds: ["b"] } }) }, engineeringLearnings: { upsert } } as never, rootDir: ".", isEnabled: () => true, createApproval: vi.fn(), resolveSourceRoot: vi.fn() });
 vi.spyOn(service,"get").mockImplementation(async id => ({ learningId: id, workspaceId: "one", status: "proposed", provenanceHash: id === "a" ? "a-hash" : "changed" }) as EngineeringLearningRecord);
 await expect(service.applyApprovedAction("approval-a")).rejects.toThrow("target changed"); expect(upsert).not.toHaveBeenCalled();
});
