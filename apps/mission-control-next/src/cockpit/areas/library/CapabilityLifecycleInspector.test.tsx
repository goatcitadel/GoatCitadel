import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
// @vitest-environment happy-dom
import { createHash, webcrypto } from "node:crypto";
import { canonicalJsonString, type ApprovalReplaySnapshot } from "@goatcitadel/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CandidateSkillDetailRecord, ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchCapabilityCandidate, fetchCandidateSkillArtifactReview, promoteCapabilityCandidate } from "@goatcitadel/mission-control-shared/api/capabilities";
import { fetchChangePlan, confirmChangePlan, respondToChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchApproval, fetchApprovalReplay } from "@goatcitadel/mission-control-shared/api/approvals";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { CapabilityLifecycleInspector } from "./CapabilityLifecycleInspector";
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({ fetchCapabilityCandidate: vi.fn(), fetchCapabilityProposal: vi.fn(), fetchCandidateSkillArtifactReview: vi.fn(), promoteCapabilityCandidate: vi.fn(), revokeCapabilityCandidate: vi.fn(), rollbackCapabilityCandidate: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChangePlan: vi.fn(), confirmChangePlan: vi.fn(), respondToChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: vi.fn(), fetchApprovalReplay: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "one", activeCitadelId: "personal", showTechnicalDetails: false }) }));
const candidate = { candidateId: "candidate-a", revision: 4, originatingRun: { workspaceId: "one" }, relatedProposals: [{ proposalId: "proposal-a", candidateId: "candidate-a" }], activationBlockers: [], versions: [{ versionId: "version-a", updatedAt: "2026-10-01", manifestArtifact: { sha256: "manifest-hash" }, title: "Reviewed version", summary: "Summary", lifecycleState: "proposed", sourceKind: "code_mode", instructionArtifact: { artifactId: "artifact-a" }, workspaceId: "one" }] } as unknown as CandidateSkillDetailRecord;
const plan = { schemaVersion: 1, planId: "plan-a", kind: "capability_candidate", request: { kind: "capability_candidate", proposalId: "proposal-a", action: "activate", versionId: "version-a" }, intentHash: "intent-a", adapter: { adapterId: "candidate", version: 1 }, target: { ownerId: "candidate", resourceId: "candidate-a", expectedRevision: 4, expectedHash: "manifest-hash" }, origin: { surface: "settings", workspaceId: "one", actorId: "operator" }, title: "Activate reviewed candidate", summary: "Activation plan", impact: "Capability availability changes after governance settles", risk: "caution", scope: "workspace", status: "awaiting_confirmation", phase: "confirmation", revision: 2, requiredAction: { kind: "confirmation", actionId: "action-a", actionNonce: "nonce-a", title: "Review exact activation", confirmationText: "Activate this reviewed version" }, approvalRefs: [], evidenceRefs: [], rollbackRefs: [], createdAt: "now", updatedAt: "now" } as unknown as ChangePlanRecord;
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { setGatewayCallerScope("operator-a"); vi.resetAllMocks(); __resetSessionViewStateForTests(); __resetApprovalOperationAttemptsForTests(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); vi.mocked(fetchCapabilityCandidate).mockResolvedValue(candidate); vi.mocked(fetchChangePlan).mockResolvedValue(plan); vi.mocked(promoteCapabilityCandidate).mockResolvedValue({ pendingApproval: null, noMutationRequired: false, detail: candidate, changePlan: plan }); vi.mocked(fetchApproval).mockRejectedValue(new Error("Approval unavailable")); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
function button(name: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => !item.closest('[aria-hidden="true"]') && (item.getAttribute("aria-label") ?? item.textContent) === name)!; }
async function click(name: string) { expect(button(name)).toBeTruthy(); await act(async () => button(name).click()); }
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><CapabilityLifecycleInspector item={{ capabilityId: "candidate:a", kind: "candidate_skill", category: "built_in", title: "Candidate", summary: "Summary", callable: false, candidateId: "candidate-a" }} workspaceId="one" /></QueryClientProvider>)); await vi.waitFor(() => expect(button("Review promote")?.disabled).toBe(false)); }
async function request() { await render(); await click("Review promote"); await click("Request capability change"); await vi.waitFor(() => expect(button("Review required candidate action")?.disabled).toBe(false)); }
it("retains the Evolution plan and confirms only its fresh exact action in the actual review portal", async () => {
  await request(); expect(fetchChangePlan).toHaveBeenCalledWith("plan-a", { workspaceId: "one" }); await click("Review required candidate action"); const receipt = { ...plan, revision: 3, status: "applied" as const, requiredAction: undefined, result: { summary: "Owner reports applied" } }; vi.mocked(confirmChangePlan).mockImplementation(async () => { vi.mocked(fetchChangePlan).mockResolvedValue(receipt); return receipt; }); await click("Apply exact change"); await act(async () => { await client.invalidateQueries(); });
  expect(confirmChangePlan).toHaveBeenCalledExactlyOnceWith("plan-a", { workspaceId: "one" }, { expectedRevision: 2, actionNonce: "nonce-a" }); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Owner reports applied");
});
it("reads immutable artifact refs before recording their review, then exposes the real approval", async () => {
  const artifactPlan: ChangePlanRecord = { ...plan, requiredAction: { kind: "artifact_review", actionId: "review-a", actionNonce: "review-nonce", title: "Review immutable artifacts", artifactRefs: ["artifact-a"] } };
  vi.mocked(fetchChangePlan).mockResolvedValue(artifactPlan); vi.mocked(fetchCandidateSkillArtifactReview).mockResolvedValue({ candidateId: "candidate-a", versionId: "version-a", revision: 4, artifacts: [{ artifactRef: "artifact-a", label: "Instructions", content: "Reviewed content" }] } as Awaited<ReturnType<typeof fetchCandidateSkillArtifactReview>>);
  await request(); await click("Review required candidate action"); await vi.waitFor(() => expect(button("Artifacts reviewed")?.disabled).toBe(false));
  const receipt: ChangePlanRecord = { ...artifactPlan, revision: 3, status: "awaiting_approval", phase: "authorization", approvalRefs: ["approval-a"], requiredAction: { kind: "approval", actionId: "approve-a", actionNonce: "approval-nonce", title: "Approval needed", risk: "caution", approvalId: "approval-a" } }; vi.mocked(respondToChangePlan).mockImplementation(async () => { vi.mocked(fetchChangePlan).mockResolvedValue(receipt); return receipt; }); await click("Artifacts reviewed");
  expect(respondToChangePlan).toHaveBeenCalledExactlyOnceWith("plan-a", { workspaceId: "one" }, { expectedRevision: 2, actionId: "review-a", actionNonce: "review-nonce", values: {} }); await vi.waitFor(() => expect(fetchApproval).toHaveBeenCalledWith("approval-a", expect.objectContaining({ workspaceId: "one" }))); expect(button("Continue approved candidate change")).toBeTruthy();
});
it("rejects a stale plan action before confirmation and preserves its portal error", async () => { await request(); await click("Review required candidate action"); vi.mocked(fetchChangePlan).mockResolvedValue({ ...plan, revision: 3 }); await click("Apply exact change"); expect(confirmChangePlan).not.toHaveBeenCalled(); expect(document.querySelectorAll('[role="dialog"]')[1]?.textContent ?? document.body.textContent).toContain("changed or expired"); });
it("retains uncertain confirmation without automatic retry", async () => { await request(); await click("Review required candidate action"); vi.mocked(confirmChangePlan).mockRejectedValue(new Error("Connection lost")); await click("Apply exact change"); await click("Apply exact change"); expect(confirmChangePlan).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain("outcome is uncertain"); });
it("preserves the direct pending-approval branch without inventing a Change Plan", async () => { vi.mocked(promoteCapabilityCandidate).mockResolvedValue({ pendingApproval: { candidateId: "candidate-a", approvalId: "direct-a" } } as Awaited<ReturnType<typeof promoteCapabilityCandidate>>); await render(); await click("Review promote"); await click("Request capability change"); await vi.waitFor(() => expect(fetchApproval).toHaveBeenCalledWith("direct-a", expect.objectContaining({ workspaceId: "one" }))); expect(fetchChangePlan).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Callability has not changed"); });
it("blocks lifecycle dispatch when candidate revision changes during review", async () => { await render(); await click("Review promote"); vi.mocked(fetchCapabilityCandidate).mockResolvedValue({ ...candidate, revision: 5 }); await click("Request capability change"); expect(promoteCapabilityCandidate).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Candidate changed during review"); });
const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function approvedPlan(suffix: string) {
  const mutation = { candidateId: candidate.candidateId, versionId: "version-a" };
  const subject = { subjectKind: "capability_candidate", subjectId: candidate.candidateId, action: "candidate_promoted" };
  const requestSha256 = digest({ schemaVersion: "goatcitadel.capability-lifecycle-request.v1", ...subject, mutation });
  const expectedStateSha256 = digest({ schemaVersion: "goatcitadel.capability-lifecycle-state.v1", state: { candidateId: candidate.candidateId, revision: 4, versionCount: 1, versionsSha256: digest([{ versionId: "version-a", lifecycleState: "proposed", updatedAt: "2026-10-01" }]) } });
  const raw = digest({ schemaVersion: "goatcitadel.capability-lifecycle-approval-id.v1", ...subject, requestSha256, expectedStateSha256 });
  const approvalId = [raw.slice(0,8), raw.slice(8,12), raw.slice(12,16), raw.slice(16,20), raw.slice(20,32)].join("-");
  const waiting = { ...plan, planId: `continue-${suffix}`, revision: 3, status: "awaiting_approval", phase: "authorization", approvalRefs: [approvalId], requiredAction: { kind: "approval", actionId: "approve-a", actionNonce: "approval-nonce", title: "Approval needed", risk: "caution", approvalId } } as ChangePlanRecord;
  const replay = { approval: { approvalId, kind: "capability.lifecycle", status: "approved", resolvedBy: "operator", payload: { capabilityLifecycle: { schemaVersion: "goatcitadel.capability-lifecycle-approval.v1", scopeKind: "global", ...subject, requestSha256, expectedStateSha256 }, request: { schemaVersion: "goatcitadel.capability-lifecycle-request-envelope.v1", requesterId: "operator", mutation } } } } as unknown as ApprovalReplaySnapshot;
  return { waiting, replay };
}
async function readyContinuation(suffix: string) {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  const fixture = approvedPlan(suffix);
  vi.mocked(fetchChangePlan).mockResolvedValue(fixture.waiting);
  vi.mocked(promoteCapabilityCandidate).mockResolvedValue({ pendingApproval: null, noMutationRequired: false, detail: candidate, changePlan: fixture.waiting });
  vi.mocked(fetchApprovalReplay).mockResolvedValue(fixture.replay);
  await render(); await click("Review promote"); await click("Request capability change");
  await vi.waitFor(() => expect(button("Continue approved candidate change")?.disabled).toBe(false));
  return fixture;
}
it("continues the real lifecycle approval with exact revision/nonce then refreshes canonical settlement", async () => {
  const { waiting } = await readyContinuation("success");
  vi.mocked(fetchCapabilityCandidate).mockResolvedValue({ ...candidate, revision: 5 });
  const receipt = { ...waiting, revision: 4, status: "applied" as const, requiredAction: undefined, result: { summary: "Canonical candidate settled" } };
  vi.mocked(respondToChangePlan).mockImplementation(async () => { vi.mocked(fetchChangePlan).mockResolvedValue(receipt); return receipt; });
  await click("Continue approved candidate change");
  await vi.waitFor(() => expect(respondToChangePlan).toHaveBeenCalledExactlyOnceWith(waiting.planId, { workspaceId: "one" }, { expectedRevision: 3, actionId: "approve-a", actionNonce: "approval-nonce", values: {} }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Canonical candidate settled"));
});
it.each(["candidate", "version", "action", "workspace", "version workspace", "request hash", "state hash", "pending", "denied", "stale"])("rejects %s before candidate continuation dispatch", async mismatch => {
  const { waiting, replay } = await readyContinuation(mismatch);
  const changed = structuredClone(replay);
  const payload = changed.approval.payload as { capabilityLifecycle: Record<string, unknown>; request: { mutation: Record<string, unknown> } };
  if (mismatch === "candidate") payload.capabilityLifecycle.subjectId = "other";
  if (mismatch === "version") payload.request.mutation.versionId = "other";
  if (mismatch === "action") payload.capabilityLifecycle.action = "candidate_revoked";
  if (mismatch === "request hash") payload.capabilityLifecycle.requestSha256 = "other";
  if (mismatch === "state hash") payload.capabilityLifecycle.expectedStateSha256 = "other";
  if (mismatch === "pending" || mismatch === "denied") changed.approval.status = mismatch === "denied" ? "rejected" : "pending";
  vi.mocked(fetchApprovalReplay).mockResolvedValue(changed);
  if (mismatch === "workspace") vi.mocked(fetchCapabilityCandidate).mockResolvedValue({ ...candidate, originatingRun: { ...candidate.originatingRun!, workspaceId: "other" } });
  if (mismatch === "version workspace") vi.mocked(fetchCapabilityCandidate).mockResolvedValue({ ...candidate, versions: candidate.versions.map(v => ({ ...v, workspaceId: "other" })) });
  if (mismatch === "stale") vi.mocked(fetchChangePlan).mockResolvedValue({ ...waiting, revision: 4 });
  await click("Continue approved candidate change");
  await vi.waitFor(() => expect(button("Continue approved candidate change")?.disabled).toBe(false));
  expect(respondToChangePlan).not.toHaveBeenCalled();
});
it("locks an uncertain candidate continuation against repeated dispatch", async () => {
  await readyContinuation("uncertain"); vi.mocked(respondToChangePlan).mockRejectedValue(new Error("Connection lost"));
  await click("Continue approved candidate change"); await vi.waitFor(() => expect(document.body.textContent).toContain("outcome is uncertain"));
  await click("Continue approved candidate change"); expect(respondToChangePlan).toHaveBeenCalledOnce();
});

it("retains uncertain plan confirmation after remount and a newer canonical revision", async () => {
 await request(); await click("Review required candidate action"); vi.mocked(confirmChangePlan).mockRejectedValue(new Error("Lost response")); await click("Apply exact change");
 await act(async () => root.render(<div />)); vi.mocked(fetchChangePlan).mockResolvedValue({ ...plan, revision: 7 }); await act(async () => root.render(<QueryClientProvider client={client}><CapabilityLifecycleInspector item={{ capabilityId: "candidate:a", kind: "candidate_skill", category: "built_in", title: "Candidate", summary: "Summary", callable: false, candidateId: "candidate-a" }} workspaceId="one" /></QueryClientProvider>));
 await vi.waitFor(() => expect(document.body.textContent).toContain("outcome is uncertain"));
 const reviewButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Review required candidate action"); expect(reviewButton?.disabled).toBe(true); expect(confirmChangePlan).toHaveBeenCalledTimes(1);
});
it("withholds a candidate plan action after caller changes during its fresh read", async () => {
 await request(); await click("Review required candidate action"); let finish!: (value: ChangePlanRecord) => void; vi.mocked(fetchChangePlan).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await click("Apply exact change"); await act(async () => setGatewayCallerScope("operator-b")); await act(async () => finish(plan)); expect(confirmChangePlan).not.toHaveBeenCalled();
});

it("allows governed first promotion without claiming the inactive candidate is callable", async () => {
 vi.mocked(fetchCapabilityCandidate).mockResolvedValue({ ...candidate, activationBlocked: true, activationBlockers: ["No candidate version has been promoted into an approved or trusted lifecycle state."] }); await render(); expect(document.body.textContent).toContain("Inactive candidates are not callable"); expect(button("Review promote").disabled).toBe(false); await click("Review promote"); expect(promoteCapabilityCandidate).not.toHaveBeenCalled(); await click("Request capability change"); expect(promoteCapabilityCandidate).toHaveBeenCalledExactlyOnceWith("candidate-a", 4, "version-a");
});
