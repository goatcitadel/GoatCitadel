import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerAssignmentRuntime, type RemoteWorkerAssignmentProjection } from "@goatcitadel/contracts";
import { fetchRemoteWorkerAssignmentRuntime } from "@goatcitadel/mission-control-shared/api/remote-workers";
import { RemoteWorkerRuntimeSummary } from "./RemoteWorkerRuntimeSummary";

vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({
  fetchRemoteWorkerAssignmentRuntime: vi.fn(),
}));
const fetchRuntime = vi.mocked(fetchRemoteWorkerAssignmentRuntime);
const observedAt = "2026-09-14T01:00:00.000Z";
const truth = (owner: string, authorityClass: string, value: unknown = null) => ({
  owner,
  authorityClass,
  value,
  observedAt,
});
function runtime({ assignmentId = "assignment-a", costUsd = 0.012345, known = true } = {}) {
  return normalizeRemoteWorkerAssignmentRuntime({
    schemaVersion: "goatcitadel.remote-worker-assignment-runtime.v1",
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "workspace-a",
    assignmentId,
    assignmentGeneration: 1,
    workerId: "worker-a",
    workerGeneration: 2,
    observedAt,
    usageAndCost: truth("storage.remoteWorkerRuntimeReads", "derived_projection", {
      usage: {
        attemptCount: 2,
        uncertainDispatchCount: 0,
        trackedAttemptCount: known ? 1 : 0,
        unknownAttemptCount: known ? 1 : 2,
        ...(known ? { costUsd, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } : {}),
        metricAvailability: Object.fromEntries(
          ["costUsd", "inputTokens", "outputTokens", "cachedInputTokens"].map((metric) => [
            metric,
            { knownAttemptCount: known ? 1 : 0, unknownAttemptCount: known ? 1 : 2, complete: false },
          ]),
        ),
      },
      pendingReservations: 1,
      reservedRequests: 2,
      reservedCostMicrousd: 1000,
    }),
    resourceCell: truth("storage.remoteWorkerCells", "canonical_record"),
    artifactAndEffects: truth("storage.remoteWorkerRuntimeReads", "derived_projection", {
      uploadCount: 2,
      committedUploadCount: 1,
      quarantinedUploadCount: 1,
      cleanupPendingCount: 1,
      manifestFileCount: 2,
      manifestTotalBytes: 123,
      verificationState: "pending",
      effectIntentCount: 3,
      effectReceiptCount: 2,
      effectReconciliationCount: 1,
    }),
    connectionHealth: truth("storage.remoteWorkerNonces", "derived_projection", {
      basis: "credential_request_nonce",
      retention: "replay_window",
      connectionStatus: "unavailable",
      freshness: "not_observed",
      lastAuthenticatedAt: null,
      evaluatedAt: observedAt,
      staleAfter: null,
      recentWindowMs: 60000,
    }),
  });
}
const assignment = (assignmentId = "assignment-a") =>
  ({
    assignmentId,
    identity: { value: { assignmentGeneration: 1, workerId: "worker-a", workerGeneration: 2 } },
  }) as RemoteWorkerAssignmentProjection;
let renderer: ReactTestRenderer | undefined;
function collect(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(collect).join(" ");
  return collect((node as { children?: unknown }).children);
}
const text = () => collect(renderer?.toJSON()).replace(/\s+/g, " ");
async function mount() {
  await act(async () => {
    renderer = create(
      <RemoteWorkerRuntimeSummary workspaceId="workspace-a" assignment={assignment()} refreshKey={1} />,
    );
  });
}
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  fetchRuntime.mockReset();
});
describe("Chat worker runtime evidence", () => {
  it("separates partial usage, reservations, pending verification and uncertain effects", async () => {
    fetchRuntime.mockResolvedValue(runtime());
    await mount();
    expect(fetchRuntime).toHaveBeenCalledWith("workspace-a", "assignment-a");
    expect(text()).toContain("Recorded cost $0.012345 · partial");
    expect(text()).toContain("Budget held $0.001 · 2 requests");
    expect(text()).toContain("2 · verification pending");
    expect(text()).toContain("2 of 3 intents · 1 needs reconciliation");
    expect(text()).toContain("1 known / 1 unknown attempts");
    expect(text()).toContain("Recorded execution Unavailable");
    expect(text()).toContain("Not observed in retained history");
    expect(text()).not.toMatch(/offline|healthy|successful effects/i);
    expect(renderer!.root.findByType("details").props.open).not.toBe(true);
  });
  it("keeps missing usage unknown instead of displaying a zero charge", async () => {
    fetchRuntime.mockResolvedValue(runtime({ known: false }));
    await mount();
    expect(text()).toContain("Recorded cost Unavailable · partial");
    expect(text()).toContain("Input tokens Unavailable · partial");
    expect(text()).not.toContain("Recorded cost $0");
  });
  it("recovers a failed read only after a successful fresh request", async () => {
    fetchRuntime.mockRejectedValueOnce(new Error("disconnected"));
    await mount();
    expect(text()).toContain("Assignment runtime evidence is unavailable");
    expect(text()).not.toContain("Recorded cost");
    fetchRuntime.mockResolvedValue(runtime());
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(text()).toContain("$0.012345");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
  it.each(["workspaceId", "assignmentId", "assignmentGeneration", "workerId", "workerGeneration"] as const)(
    "refuses a mismatched %s before displaying evidence",
    async (field) => {
      const value = runtime();
      fetchRuntime.mockResolvedValue({ ...value, [field]: typeof value[field] === "number" ? 9 : "different" });
      await mount();
      expect(text()).toContain("Assignment identity changed");
      expect(text()).not.toContain("$0.012345");
    },
  );
  it("does not restore late evidence after an assignment switch or a refresh", async () => {
    let resolveOld!: (value: ReturnType<typeof runtime>) => void;
    fetchRuntime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await mount();
    expect(text()).toContain("Loading worker evidence");
    fetchRuntime.mockResolvedValue(runtime({ assignmentId: "assignment-b", costUsd: 0.5 }));
    await act(async () =>
      renderer!.update(
        <RemoteWorkerRuntimeSummary workspaceId="workspace-a" assignment={assignment("assignment-b")} refreshKey={2} />,
      ),
    );
    await act(async () => resolveOld(runtime()));
    expect(text()).toContain("Recorded cost $0.50");
    expect(text()).not.toContain("$0.012345");
    fetchRuntime.mockResolvedValue(runtime({ assignmentId: "assignment-b", costUsd: 0.7 }));
    await act(async () =>
      renderer!.update(
        <RemoteWorkerRuntimeSummary workspaceId="workspace-a" assignment={assignment("assignment-b")} refreshKey={3} />,
      ),
    );
    expect(text()).toContain("Recorded cost $0.70");
  });
});
