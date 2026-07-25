import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerAssignmentProjection } from "@goatcitadel/contracts";
import { RemoteWorkerInlineActivity } from "./RemoteWorkerInlineActivity";
import { useRemoteWorkerInlineActivity } from "./useRemoteWorkerInlineActivity";

vi.mock("./useRemoteWorkerInlineActivity", () => ({ useRemoteWorkerInlineActivity: vi.fn() }));

const mockedHook = vi.mocked(useRemoteWorkerInlineActivity);

function assignment(): RemoteWorkerAssignmentProjection {
  const truth = <T,>(value: T | null, authorityClass: string) => ({
    value,
    authorityClass,
    owner: "storage.remoteWorkerAssignments",
    observedAt: "2026-07-15T12:00:00.000Z",
  });
  return {
    schemaVersion: "goatcitadel.remote-worker-assignment-projection.v1",
    assignmentId: "assign-a",
    lineage: truth({ sessionId: "session-a", turnId: "turn-a", durableRunId: "run-a" }, "canonical_record"),
    identity: truth(
      { assignmentGeneration: 1, workerId: "worker-a", workerGeneration: 2, nodeId: "node-a" },
      "canonical_record",
    ),
    lease: truth(
      { assignmentGeneration: 1, leaseRevision: 2, workerSentThrough: 3, serverAcknowledgedThrough: 2 },
      "canonical_record",
    ),
    leaseFreshness: truth({ fresh: true }, "derived_projection"),
    control: truth(null, "canonical_record"),
    settlement: truth({ outcome: "completed", origin: "worker" }, "canonical_record"),
    materialization: truth({ count: 1, chatTranscriptCount: 1, durableRunResultCount: 0 }, "canonical_record"),
    phase: truth("settled", "derived_projection"),
    unavailable: {},
  } as unknown as RemoteWorkerAssignmentProjection;
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const record = node as { children?: unknown };
  return textOf(record.children);
}

describe("RemoteWorkerInlineActivity", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    renderer = null;
  });

  it("renders read-only session/turn-bound worker facts without raw JSON or worker mutation controls", () => {
    mockedHook.mockReturnValue({ assignments: [assignment()], loading: false, error: null, reload: vi.fn() });
    act(() => {
      renderer = create(<RemoteWorkerInlineActivity workspaceId="workspace-a" sessionId="session-a" turnId="turn-a" />);
    });
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("Remote workers");
    expect(text).toContain("settled");
    expect(text).toContain("worker-a");
    expect(text).toMatch(/sent\s+3/u);
    expect(text).toContain("unavailable");
    expect(text).not.toContain('"schemaVersion"');
    // No rotate/quarantine/revoke/recovery/cleanup management leaks into Chat.
    expect(text.toLowerCase()).not.toMatch(/quarantine|revoke|rotate|recovery|cleanup/u);
  });

  it("renders nothing when the turn is not bound or no remote work exists", () => {
    mockedHook.mockReturnValue({ assignments: [], loading: false, error: null, reload: vi.fn() });
    act(() => {
      renderer = create(<RemoteWorkerInlineActivity workspaceId="workspace-a" sessionId="session-a" turnId={null} />);
    });
    expect(renderer!.toJSON()).toBeNull();

    act(() => {
      renderer!.update(<RemoteWorkerInlineActivity workspaceId="workspace-a" sessionId="session-a" turnId="turn-a" />);
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("offers an Ops detail link only when a handler and worker identity are present", () => {
    const onOpenOps = vi.fn();
    mockedHook.mockReturnValue({ assignments: [assignment()], loading: false, error: null, reload: vi.fn() });
    act(() => {
      renderer = create(
        <RemoteWorkerInlineActivity
          workspaceId="workspace-a"
          sessionId="session-a"
          turnId="turn-a"
          onOpenOps={onOpenOps}
        />,
      );
    });
    const opsButton = renderer!.root.findAllByType("button").find((node) => textOf(node).includes("View in Ops"));
    expect(opsButton).toBeDefined();
    act(() => opsButton!.props.onClick());
    expect(onOpenOps).toHaveBeenCalledWith("worker-a");
  });
});
