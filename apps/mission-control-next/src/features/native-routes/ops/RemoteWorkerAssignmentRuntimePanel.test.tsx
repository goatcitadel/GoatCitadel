import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerAssignmentRuntime, type RemoteWorkerAssignmentProjection } from "@goatcitadel/contracts";
import { fetchRemoteWorkerAssignmentRuntime } from "@goatcitadel/mission-control-shared/api/remote-workers";
import { RemoteWorkerAssignmentRuntimePanel } from "./RemoteWorkerAssignmentRuntimePanel";
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({
  fetchRemoteWorkerAssignmentRuntime: vi.fn(),
}));
const fetchRuntime = vi.mocked(fetchRemoteWorkerAssignmentRuntime);
const observedAt = "2026-09-12T12:00:00.000Z";
const truth = (owner: string, authorityClass: string, value: unknown = null) => ({
  value,
  owner,
  authorityClass,
  observedAt,
});
function runtime(assignmentId = "assign-a", workerGeneration = 2) {
  return normalizeRemoteWorkerAssignmentRuntime({
    schemaVersion: "goatcitadel.remote-worker-assignment-runtime.v1",
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "workspace-a",
    assignmentId,
    assignmentGeneration: 1,
    workerId: "worker-a",
    workerGeneration,
    observedAt,
    usageAndCost: truth("storage.remoteWorkerRuntimeReads", "derived_projection", {
      usage: {
        attemptCount: 2,
        uncertainDispatchCount: 0,
        trackedAttemptCount: 1,
        unknownAttemptCount: 1,
        costUsd: 0.000001,
        inputTokens: 5,
        outputTokens: 2,
        cachedInputTokens: 0,
        metricAvailability: Object.fromEntries(
          ["costUsd", "inputTokens", "outputTokens", "cachedInputTokens"].map((metric) => [
            metric,
            { knownAttemptCount: 1, unknownAttemptCount: 1, complete: false },
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
      freshness: "recent",
      lastAuthenticatedAt: observedAt,
      evaluatedAt: observedAt,
      staleAfter: "2026-09-12T12:01:00.000Z",
      recentWindowMs: 60000,
    }),
  });
}
const assignment = (assignmentId = "assign-a", workerGeneration = 2) =>
  ({
    assignmentId,
    identity: { value: { assignmentGeneration: 1, workerId: "worker-a", workerGeneration } },
  }) as RemoteWorkerAssignmentProjection;
let renderer: ReactTestRenderer;
function collect(node: any): string {
  if (typeof node === "string") return node;
  if (!node) return "";
  if (Array.isArray(node)) return node.map(collect).join(" ");
  return collect(node.children);
}
const text = () => collect(renderer.toJSON()).replace(/\s+/g, " ");
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  fetchRuntime.mockReset();
});
describe("assignment runtime evidence", () => {
  it("separates partial cost, holds, contact, unavailable cell state, and effect receipts", async () => {
    fetchRuntime.mockResolvedValue(runtime());
    await act(async () => {
      renderer = create(<RemoteWorkerAssignmentRuntimePanel workspaceId="workspace-a" assignment={assignment()} />);
    });
    expect(text()).toContain("$0.000001");
    expect(text()).toContain("incomplete");
    expect(text()).toContain("outstanding holds");
    expect(text()).toContain("Recent authenticated request");
    expect(text()).toContain("does not establish an open connection");
    expect(text()).toContain("Resource cell unavailable");
    expect(text()).toContain("Effect receipts");
    expect(text()).not.toContain("Worker healthy");
    expect(text()).not.toContain("$0.00 ");
  });
  it("rejects a generation mismatch and preserves explicit unavailability on read failure", async () => {
    fetchRuntime.mockResolvedValue(runtime("assign-a", 3));
    await act(async () => {
      renderer = create(<RemoteWorkerAssignmentRuntimePanel workspaceId="workspace-a" assignment={assignment()} />);
    });
    expect(text()).toContain("Assignment identity changed");
    expect(text()).not.toContain("Recent authenticated request");
    fetchRuntime.mockRejectedValueOnce(new Error("503 owner not composed"));
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(text()).toContain("Assignment runtime evidence is unavailable");
    expect(text()).not.toContain("$0.00");
  });
  it("ignores a late read after switching assignment or generation", async () => {
    let resolve!: (value: ReturnType<typeof runtime>) => void;
    fetchRuntime
      .mockImplementationOnce(
        () =>
          new Promise((value) => {
            resolve = value;
          }),
      )
      .mockResolvedValue(runtime("assign-b", 4));
    await act(async () => {
      renderer = create(<RemoteWorkerAssignmentRuntimePanel workspaceId="workspace-a" assignment={assignment()} />);
    });
    await act(async () => {
      renderer.update(
        <RemoteWorkerAssignmentRuntimePanel workspaceId="workspace-a" assignment={assignment("assign-b", 4)} />,
      );
    });
    await act(async () => {
      resolve(runtime());
    });
    expect(text()).toContain("assign-b");
    expect(text()).not.toContain("assign-a");
  });
});
