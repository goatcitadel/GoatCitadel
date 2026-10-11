import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString, type ApprovalReplaySnapshot, type CandidateSkillDetailRecord, type ChangePlanRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { fetchApprovalReplay } from "@goatcitadel/mission-control-shared/api/approvals";
import { fetchCapabilityCandidate } from "@goatcitadel/mission-control-shared/api/capabilities";
import { fetchChangePlan, respondToChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { requesterMatchesPlanOrigin, useCandidateApprovalContinuation } from "./candidate-approval-continuation";

vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApprovalReplay: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({ fetchCapabilityCandidate: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChangePlan: vi.fn(), respondToChangePlan: vi.fn() }));

const plan = (actorId: string) => ({ origin: { workspaceId: "ws-origin", actorId } }) as unknown as ChangePlanRecord;
const linked = { linkage: { workspaceId: "ws-origin" } };

it("compares unredacted requesters exactly", () => {
  expect(requesterMatchesPlanOrigin(plan("basic:operator"), {}, "basic:operator")).toBe(true);
  expect(requesterMatchesPlanOrigin(plan("basic:operator"), linked, "basic:other")).toBe(false);
});

it("accepts a token requester only under the Gateway's public redaction and origin linkage", () => {
  // Literal value the Gateway approval replay returned for a token actor (public projection).
  const masked = "token:[REDACTED]";
  expect(requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), linked, masked)).toBe(true);
  expect(requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), {}, masked)).toBe(false);
  expect(
    requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), { linkage: { workspaceId: "ws-other" } }, masked),
  ).toBe(false);
  // A masked value never stands in for an origin the redactor would not mask.
  expect(requesterMatchesPlanOrigin(plan("basic:operator"), linked, masked)).toBe(false);
  expect(requesterMatchesPlanOrigin(plan("token:02cb90b79cac22e2"), linked, "token:ffffffffffffffff")).toBe(false);
});

async function sha(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJsonString(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A plan, candidate and approval replay whose immutable hashes bind exactly as the Gateway would
 * compute them. Each plan id is unique: the continuation lock is a module-level store keyed by plan.
 */
let planSequence = 0;
async function approvedCandidateFixture() {
  const planId = `plan-${++planSequence}`;
  const candidateId = "candidate-1", versionId = "version-1", manifestHash = "a".repeat(64), workspaceId = "ws-origin", actorId = "basic:operator";
  const versions = [{ versionId, lifecycleState: "candidate", updatedAt: "2026-10-01T00:00:00.000Z", manifestArtifact: { sha256: manifestHash } }];
  const reviewed = { candidateId, revision: 2, versions, latestVersion: versions[0], relatedProposals: [{ proposalId: "proposal-1", candidateId }] } as unknown as CandidateSkillDetailRecord;
  const mutation = { candidateId, versionId };
  const requestSha256 = await sha({ schemaVersion: "goatcitadel.capability-lifecycle-request.v1", subjectKind: "capability_candidate", subjectId: candidateId, action: "candidate_promoted", mutation });
  const versionsSha256 = await sha(versions.map((item) => ({ versionId: item.versionId, lifecycleState: item.lifecycleState, updatedAt: item.updatedAt })));
  const expectedStateSha256 = await sha({ schemaVersion: "goatcitadel.capability-lifecycle-state.v1", state: { candidateId, revision: 2, versionCount: 1, versionsSha256 } });
  const digest = await sha({ schemaVersion: "goatcitadel.capability-lifecycle-approval-id.v1", subjectKind: "capability_candidate", subjectId: candidateId, action: "candidate_promoted", requestSha256, expectedStateSha256 });
  const approvalId = [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join("-");
  const plan = {
    planId, revision: 3, intentHash: "intent-1", status: "awaiting_approval", origin: { workspaceId, actorId },
    request: { kind: "capability_candidate", proposalId: "proposal-1" },
    requiredAction: { kind: "approval", approvalId, actionId: "action-1", actionNonce: "nonce-1" }, approvalRefs: [approvalId],
    target: { resourceId: candidateId, expectedRevision: 2, expectedHash: manifestHash },
  } as unknown as ChangePlanRecord;
  const replay = {
    approval: {
      approvalId, kind: "capability.lifecycle", status: "approved", resolvedBy: "operator", linkage: { workspaceId },
      payload: {
        capabilityLifecycle: { schemaVersion: "goatcitadel.capability-lifecycle-approval.v1", scopeKind: "global", subjectKind: "capability_candidate", subjectId: candidateId, action: "candidate_promoted", requestSha256, expectedStateSha256 },
        request: { schemaVersion: "goatcitadel.capability-lifecycle-request-envelope.v1", requesterId: actorId, mutation },
      },
    },
    events: [], effects: [],
  } as unknown as ApprovalReplaySnapshot;
  const receipt = { planId, origin: { workspaceId }, intentHash: "intent-1", target: { resourceId: candidateId }, revision: 4 } as unknown as ChangePlanRecord;
  return { planId, plan, reviewed, replay, receipt };
}

describe("useCandidateApprovalContinuation failure classification", () => {
  type HookValue = ReturnType<typeof useCandidateApprovalContinuation>;
  let latest!: HookValue;
  let renderer: ReactTestRenderer | null = null;
  let planId = "";
  const onSettled = vi.fn(async () => undefined);
  const http = (status: number) => new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/api/v1/chat/change-plans/respond", status });

  beforeEach(async () => {
    const fixture = await approvedCandidateFixture();
    planId = fixture.planId;
    onSettled.mockClear();
    vi.mocked(fetchChangePlan).mockReset().mockResolvedValue(fixture.plan);
    vi.mocked(fetchApprovalReplay).mockReset().mockResolvedValue(fixture.replay);
    vi.mocked(fetchCapabilityCandidate).mockReset().mockResolvedValue(fixture.reviewed);
    vi.mocked(respondToChangePlan).mockReset().mockResolvedValue(fixture.receipt);
    function Harness() {
      latest = useCandidateApprovalContinuation({ plan: fixture.plan, reviewed: fixture.reviewed, onSettled });
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Harness));
    });
  });
  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("records a verified continuation", async () => {
    await act(async () => latest.continueApproved());
    expect(respondToChangePlan).toHaveBeenCalledWith(planId, { workspaceId: "ws-origin" }, { expectedRevision: 3, actionId: "action-1", actionNonce: "nonce-1", values: {} });
    expect(onSettled).toHaveBeenCalledOnce();
    expect(latest.message).toContain("Continuation recorded");
  });

  it.each([409, 422])("leaves the continuation available after a Gateway %s refusal and shows its summary", async (status) => {
    vi.mocked(respondToChangePlan).mockRejectedValueOnce(http(status));
    await act(async () => latest.continueApproved());
    expect(respondToChangePlan).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
    expect(latest.disabled).toBe(false);
    expect(latest.message).toContain(status === 409 ? "This changed somewhere else" : "couldn't complete that request");
    expect(latest.message).not.toContain("uncertain");
    await act(async () => latest.continueApproved());
    expect(respondToChangePlan).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("keeps a lost continuation response locked", async () => {
    vi.mocked(respondToChangePlan).mockRejectedValueOnce(new Error("socket closed"));
    await act(async () => latest.continueApproved());
    expect(latest.disabled).toBe(true);
    expect(latest.message).toContain("uncertain");
    await act(async () => latest.continueApproved());
    expect(respondToChangePlan).toHaveBeenCalledOnce();
  });
});
