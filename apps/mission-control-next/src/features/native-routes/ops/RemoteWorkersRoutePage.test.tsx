import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerRegistryItem } from "@goatcitadel/contracts";
import { RemoteWorkersRoutePage } from "./RemoteWorkersRoutePage";
import { useRemoteWorkerRegistry } from "@goatcitadel/mission-control-shared/hooks/useRemoteWorkerRegistry";
import {
  fetchRemoteWorkerAssignmentEvents,
  fetchRemoteWorkerAssignments,
  fetchRemoteWorkerDetail,
  fetchRemoteWorkerReconciliation,
} from "@goatcitadel/mission-control-shared/api/remote-workers";
import type { NativeRoutePagesProps } from "../types";

vi.mock("@goatcitadel/mission-control-shared/hooks/useRemoteWorkerRegistry", () => ({
  useRemoteWorkerRegistry: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({
  fetchRemoteWorkerDetail: vi.fn(),
  fetchRemoteWorkerAssignments: vi.fn(),
  fetchRemoteWorkerReconciliation: vi.fn(),
  fetchRemoteWorkerAssignmentEvents: vi.fn(),
}));
vi.mock("../../../app/remote-worker-realtime", () => ({
  REMOTE_WORKER_REALTIME_COALESCE_MS: 0,
  RemoteWorkerRealtimeCursor: class {
    decide() {
      return { reload: false };
    }
    reset() {}
  },
  subscribeRemoteWorkerRealtime: () => () => undefined,
}));

const mockedRegistry = vi.mocked(useRemoteWorkerRegistry);
const mockedDetail = vi.mocked(fetchRemoteWorkerDetail);
const mockedAssignments = vi.mocked(fetchRemoteWorkerAssignments);
const mockedReconciliation = vi.mocked(fetchRemoteWorkerReconciliation);
const mockedEvents = vi.mocked(fetchRemoteWorkerAssignmentEvents);

const OBS = "2026-07-15T12:00:00.000Z";
const truth = <T,>(value: T | null, authorityClass: string, owner = "storage.remoteWorkerAdmissions") => ({
  value,
  authorityClass,
  owner,
  observedAt: OBS,
});

function item(): RemoteWorkerRegistryItem {
  return {
    schemaVersion: "goatcitadel.remote-worker-registry-item.v1",
    workerId: "worker-a",
    admission: truth(
      {
        registryWorkspaceId: "workspace-a",
        workerId: "worker-a",
        nodeId: "node-a",
        workerGeneration: 2,
        workerLabel: "Office worker",
        platform: "windows",
        architecture: "x64",
        allowedWorkspaceCount: 2,
        capabilityClassCount: 3,
        publicKeySpkiSha256: "a".repeat(64),
        clientCertificateSha256: "b".repeat(64),
        runtimeManifestSha256: "c".repeat(64),
        admittedAt: OBS,
      },
      "canonical_record",
    ),
    control: truth(null, "canonical_record"),
    posture: truth("active", "derived_projection", "gateway.remoteWorkers"),
    unavailable: {},
  } as unknown as RemoteWorkerRegistryItem;
}

function assignmentProjection() {
  const t = <T,>(value: T | null, ac: string) => truth(value, ac, "storage.remoteWorkerAssignments");
  return {
    schemaVersion: "goatcitadel.remote-worker-assignment-projection.v1",
    assignmentId: "assign-a",
    lineage: t({ sessionId: "session-a", turnId: "turn-a", durableRunId: "run-a" }, "canonical_record"),
    identity: t(
      { assignmentGeneration: 1, workerId: "worker-a", workerGeneration: 2, nodeId: "node-a" },
      "canonical_record",
    ),
    lease: t(
      { assignmentGeneration: 1, leaseRevision: 2, workerSentThrough: 3, serverAcknowledgedThrough: 2 },
      "canonical_record",
    ),
    leaseFreshness: t({ fresh: true }, "derived_projection"),
    control: t(null, "canonical_record"),
    settlement: t(null, "canonical_record"),
    materialization: t(null, "canonical_record"),
    phase: t("leased", "derived_projection"),
    unavailable: {},
  };
}

function reconciliation() {
  const t = <T,>(value: T | null, ac: string) => truth(value, ac, "gateway.remoteWorkers");
  return {
    schemaVersion: "goatcitadel.remote-worker-reconciliation.v1",
    workspaceId: "workspace-a",
    workerId: "worker-a",
    posture: t("active", "derived_projection"),
    admissionControl: t({ status: "consistent", summary: "Generation 2 admitted." }, "derived_projection"),
    assignmentLease: t({ status: "divergent", summary: "1 expired lease." }, "derived_projection"),
    settlementMaterialization: t({ status: "empty", summary: "No settlements." }, "derived_projection"),
    resourceCell: t(null, "unavailable"),
    cleanup: t(null, "unavailable"),
    observedAt: OBS,
  };
}

function props(): NativeRoutePagesProps {
  return {
    route: { area: "ops", section: "workers" },
    activeWorkspaceId: "workspace-a",
    activeWorkspaceName: "Workspace A",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
  } as unknown as NativeRoutePagesProps;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const record = node as { children?: unknown };
  return textOf(record.children);
}

describe("RemoteWorkersRoutePage", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    renderer = null;
    mockedDetail.mockResolvedValue({ item: item() } as never);
    mockedAssignments.mockResolvedValue({ items: [assignmentProjection()] } as never);
    mockedReconciliation.mockResolvedValue(reconciliation() as never);
    mockedEvents.mockResolvedValue({
      items: [],
      omitted: { transcriptDeltas: 0, terminalOutputs: 0, diagnostics: 0 },
    } as never);
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("renders the registry and shows an empty detail prompt until a worker is chosen", async () => {
    mockedRegistry.mockReturnValue({
      page: { items: [item()] } as never,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    await act(async () => {
      renderer = create(<RemoteWorkersRoutePage {...props()} />);
    });
    await flush();
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("Registry");
    expect(text).toContain("Office worker");
    expect(text).toContain("Select a worker");
    expect(mockedDetail).not.toHaveBeenCalled();
  });

  it("loads and renders identity, assignments, and reconciliation for a selected worker, secret-free", async () => {
    mockedRegistry.mockReturnValue({
      page: { items: [item()] } as never,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    await act(async () => {
      renderer = create(<RemoteWorkersRoutePage {...props()} />);
    });
    await flush();

    const workerButton = renderer!.root.findAllByType("button").find((node) => textOf(node).includes("Office worker"));
    expect(workerButton).toBeDefined();
    await act(async () => {
      workerButton!.props.onClick();
    });
    await flush();

    expect(mockedDetail).toHaveBeenCalledWith("workspace-a", "worker-a");
    expect(mockedAssignments).toHaveBeenCalledWith("workspace-a", { workerId: "worker-a", limit: 50 });
    expect(mockedReconciliation).toHaveBeenCalledWith("workspace-a", "worker-a");

    const text = textOf(renderer!.toJSON());
    expect(text).toContain("Identity");
    expect(text).toContain("node-a");
    expect(text).toContain("Reconciliation");
    expect(text).toContain("divergent");
    // Digests are shortened by default and downstream owners stay unavailable.
    expect(text).toContain("aaaaaaaaaa…");
    expect(text).toContain("unavailable");
    // No lease token, reason, or idempotency secret ever renders.
    expect(text.toLowerCase()).not.toMatch(/leasetoken|reasonsha|idempotency|requestsha|dispatchauthority/u);
  });

  it("surfaces an unavailable registry without inventing worker facts", async () => {
    mockedRegistry.mockReturnValue({
      page: null,
      loading: false,
      error: "The remote-worker registry is unavailable.",
      reload: vi.fn(),
    });
    await act(async () => {
      renderer = create(<RemoteWorkersRoutePage {...props()} />);
    });
    await flush();
    expect(textOf(renderer!.toJSON())).toContain("Registry unavailable");
  });
});
