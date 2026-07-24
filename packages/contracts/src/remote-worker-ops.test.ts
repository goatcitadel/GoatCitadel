import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_ASSIGNMENT_EVENT_PAGE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_PAGE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_PROJECTION_SCHEMA_VERSION,
  REMOTE_WORKER_RECONCILIATION_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION,
  assertRemoteWorkerAssignmentEventPage,
  assertRemoteWorkerAssignmentPage,
  assertRemoteWorkerReconciliation,
  assertRemoteWorkerRegistryDetail,
  assertRemoteWorkerRegistryPage,
  freezeRemoteWorkerAssignmentEventPage,
  freezeRemoteWorkerAssignmentPage,
  freezeRemoteWorkerReconciliation,
  freezeRemoteWorkerRegistryDetail,
  freezeRemoteWorkerRegistryPage,
  normalizeRemoteWorkerRegistryCursor,
  type RemoteWorkerAssignmentEventPage,
  type RemoteWorkerAssignmentPage,
  type RemoteWorkerAssignmentProjection,
  type RemoteWorkerReconciliation,
  type RemoteWorkerRegistryDetail,
  type RemoteWorkerRegistryItem,
  type RemoteWorkerRegistryPage,
} from "./remote-worker-ops.js";

const D = (character: string): string => character.repeat(64);
const OBSERVED_AT = "2026-07-15T12:00:00.000Z";

function item(overrides: Partial<RemoteWorkerRegistryItem> = {}): RemoteWorkerRegistryItem {
  return {
    schemaVersion: REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION,
    workerId: "worker-a",
    admission: {
      value: {
        registryWorkspaceId: "workspace-a",
        workerId: "worker-a",
        nodeId: "node-a",
        workerGeneration: 2,
        workerLabel: "Office worker",
        platform: "windows",
        architecture: "x64",
        allowedWorkspaceCount: 2,
        workspaceCeilingSha256: D("a"),
        capabilityClassCount: 3,
        capabilityCeilingSha256: D("b"),
        publicKeySpkiSha256: D("c"),
        clientCertificateSha256: D("d"),
        runtimeManifestSha256: D("e"),
        transportIdentitySource: "native_mtls",
        transportTrustAnchorSha256: D("f"),
        transportVerificationReceiptSha256: D("0"),
        proofOfPossessionReceiptSha256: D("1"),
        downloadVerificationReceiptSha256: D("2"),
        installedTreeAttestationSha256: D("3"),
        installedTreeVerificationReceiptSha256: D("4"),
        admittedAt: "2026-07-15T11:00:00.000Z",
      },
      authorityClass: "canonical_record",
      owner: "storage.remoteWorkerAdmissions",
      observedAt: OBSERVED_AT,
    },
    control: {
      value: {
        workerGeneration: 2,
        controlRevision: 1,
        action: "quarantine",
        createdAt: "2026-07-15T11:30:00.000Z",
      },
      authorityClass: "canonical_record",
      owner: "storage.remoteWorkerAdmissions",
      observedAt: OBSERVED_AT,
    },
    posture: {
      value: "quarantined",
      authorityClass: "derived_projection",
      owner: "gateway.remoteWorkers",
      observedAt: OBSERVED_AT,
    },
    unavailable: {
      connectionHealth: unavailable("remote-worker.listener"),
      assignments: unavailable("storage.remoteWorkerAssignments"),
      usageAndCost: unavailable("storage.remoteWorkerUsage"),
      resourceCell: unavailable("storage.remoteWorkerResourceCells"),
      artifactAndEffects: unavailable("storage.remoteWorkerArtifacts"),
    },
    ...overrides,
  };
}

function unavailable(owner: string) {
  return {
    value: null,
    authorityClass: "unavailable" as const,
    owner,
    observedAt: OBSERVED_AT,
    caveat: "Not composed in this server-only read tranche.",
  };
}

function page(overrides: Partial<RemoteWorkerRegistryPage> = {}): RemoteWorkerRegistryPage {
  return {
    schemaVersion: REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION,
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "workspace-a",
    items: [item()],
    nextCursor: "opaque-cursor",
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function detail(overrides: Partial<RemoteWorkerRegistryDetail> = {}): RemoteWorkerRegistryDetail {
  return {
    schemaVersion: REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION,
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "workspace-a",
    item: item(),
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe("remote worker operator registry contracts", () => {
  it("normalizes only the frozen exact workspace-bound cursor shape", () => {
    const cursor = normalizeRemoteWorkerRegistryCursor({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-a",
    });
    expect(cursor).toEqual({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-a",
    });
    expect(Object.isFrozen(cursor)).toBe(true);
    expect(() => normalizeRemoteWorkerRegistryCursor({ ...cursor, registryWorkspaceId: "foreign-workspace" })).toThrow(
      /fields are invalid/u,
    );
    expect(() => normalizeRemoteWorkerRegistryCursor({ ...cursor, schemaVersion: "remote-worker-cursor.v2" })).toThrow(
      /schema is invalid/u,
    );
  });

  it("accepts and deeply freezes the exact secret-free page and detail projections", () => {
    const frozenPage = freezeRemoteWorkerRegistryPage(page());
    const frozenDetail = freezeRemoteWorkerRegistryDetail(detail());
    expect(Object.isFrozen(frozenPage)).toBe(true);
    expect(Object.isFrozen(frozenPage.items)).toBe(true);
    expect(Object.isFrozen(frozenPage.items[0]?.admission.value)).toBe(true);
    expect(Object.isFrozen(frozenDetail.item.unavailable.assignments)).toBe(true);
    expect(JSON.stringify({ frozenPage, frozenDetail })).not.toMatch(
      /secret|token|reason|actor|idempotency|requestSha256|allowedWorkspaceIds|capabilityClasses/u,
    );
  });

  it("rejects foreign-workspace, control/posture, digest, and unknown-field inconsistencies", () => {
    expect(() =>
      assertRemoteWorkerRegistryPage(
        page({
          items: [
            item({
              admission: {
                ...item().admission,
                value: { ...item().admission.value!, registryWorkspaceId: "workspace-b" },
              },
            }),
          ],
        }),
      ),
    ).toThrow(/foreign workspace/u);
    expect(() =>
      assertRemoteWorkerRegistryDetail(detail({ item: item({ posture: { ...item().posture, value: "active" } }) })),
    ).toThrow(/authority is inconsistent/u);
    expect(() =>
      assertRemoteWorkerRegistryPage({
        ...page(),
        items: [
          item({
            admission: {
              ...item().admission,
              value: { ...item().admission.value!, publicKeySpkiSha256: "SECRET" },
            },
          }),
        ],
      }),
    ).toThrow(/publicKeySpkiSha256 is invalid/u);
    expect(() => assertRemoteWorkerRegistryPage({ ...page(), bootstrapSecret: "do-not-echo" })).toThrow(
      /fields are invalid/u,
    );
  });

  it("requires every downstream section to stay explicitly unavailable", () => {
    expect(() =>
      assertRemoteWorkerRegistryDetail(
        detail({
          item: item({
            unavailable: {
              ...item().unavailable,
              connectionHealth: {
                value: null,
                authorityClass: "retained_signal",
                owner: "remote-worker.listener",
                observedAt: OBSERVED_AT,
              },
            },
          }),
        }),
      ),
    ).toThrow(/must remain unavailable/u);
  });

  it("rejects duplicate and non-ascending worker IDs in paged registry truth", () => {
    const workerB = item({
      workerId: "worker-b",
      admission: {
        ...item().admission,
        value: { ...item().admission.value!, workerId: "worker-b", nodeId: "node-b" },
      },
    });
    expect(() => assertRemoteWorkerRegistryPage(page({ items: [item(), item()] }))).toThrow(/order is invalid/u);
    expect(() => assertRemoteWorkerRegistryPage(page({ items: [workerB, item()] }))).toThrow(/order is invalid/u);
  });
});

function truth<T>(
  value: T | null,
  authorityClass: "canonical_record" | "derived_projection" | "retained_signal" | "unavailable",
  owner = "storage.remoteWorkerAssignments",
) {
  return { value, authorityClass, owner, observedAt: OBSERVED_AT };
}

function assignmentProjection(
  overrides: Partial<RemoteWorkerAssignmentProjection> = {},
): RemoteWorkerAssignmentProjection {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_PROJECTION_SCHEMA_VERSION,
    assignmentId: "assign-a",
    lineage: truth(
      {
        registryWorkspaceId: "workspace-a",
        assignmentId: "assign-a",
        sessionId: "session-a",
        turnId: "turn-a",
        durableRunId: "run-a",
        createdAt: "2026-07-15T11:00:00.000Z",
      },
      "canonical_record",
    ),
    identity: truth(
      { assignmentGeneration: 1, workerId: "worker-a", workerGeneration: 2, nodeId: "node-a", startedAt: OBSERVED_AT },
      "canonical_record",
    ),
    lease: truth(
      {
        assignmentGeneration: 1,
        leaseRevision: 2,
        workerSentThrough: 3,
        serverAcknowledgedThrough: 2,
        heartbeatAt: OBSERVED_AT,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      "canonical_record",
    ),
    leaseFreshness: truth({ fresh: true, expiresAt: "2099-01-01T00:00:00.000Z" }, "derived_projection"),
    control: truth(null, "canonical_record"),
    settlement: truth(null, "canonical_record"),
    materialization: truth(null, "canonical_record"),
    phase: truth<RemoteWorkerAssignmentProjection["phase"]["value"]>("leased", "derived_projection"),
    unavailable: {
      usageAndCost: unavailable("storage.remoteWorkerUsage"),
      resourceCell: unavailable("storage.remoteWorkerResourceCells"),
      artifactAndEffects: unavailable("storage.remoteWorkerArtifacts"),
    },
    ...overrides,
  } as RemoteWorkerAssignmentProjection;
}

function assignmentPage(overrides: Partial<RemoteWorkerAssignmentPage> = {}): RemoteWorkerAssignmentPage {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_PAGE_SCHEMA_VERSION,
    readOnly: true,
    mutationSemantics: "none",
    workspaceId: "workspace-a",
    filters: { workerId: "worker-a" },
    items: [assignmentProjection()],
    observedAt: OBSERVED_AT,
    ...overrides,
  } as RemoteWorkerAssignmentPage;
}

describe("assertRemoteWorkerAssignmentPage", () => {
  it("accepts a settled projection with unavailable downstream sections", () => {
    const settled = assignmentProjection({
      control: truth(
        { assignmentGeneration: 1, controlRevision: 1, action: "cancel_requested", createdAt: OBSERVED_AT },
        "canonical_record",
      ),
      settlement: truth(
        {
          assignmentGeneration: 1,
          outcome: "completed",
          origin: "worker",
          finalEventSequence: 4,
          settledAt: OBSERVED_AT,
        },
        "canonical_record",
      ),
      materialization: truth(
        { count: 2, chatTranscriptCount: 1, durableRunResultCount: 1, latestMaterializedAt: OBSERVED_AT },
        "canonical_record",
      ),
      phase: truth<RemoteWorkerAssignmentProjection["phase"]["value"]>("settled", "derived_projection"),
    });
    expect(() => freezeRemoteWorkerAssignmentPage(assignmentPage({ items: [settled] }))).not.toThrow();
  });

  it("accepts an unstarted assignment with null identity/lease", () => {
    const created = assignmentProjection({
      identity: truth(null, "canonical_record"),
      lease: truth(null, "canonical_record"),
      leaseFreshness: truth(null, "derived_projection"),
      phase: truth<RemoteWorkerAssignmentProjection["phase"]["value"]>("created", "derived_projection"),
    });
    expect(() => assertRemoteWorkerAssignmentPage(assignmentPage({ items: [created] }))).not.toThrow();
  });

  it("rejects a lease projection promoted above canonical authority", () => {
    const bad = assignmentProjection({
      lease: truth(
        {
          assignmentGeneration: 1,
          leaseRevision: 2,
          workerSentThrough: 3,
          serverAcknowledgedThrough: 2,
          heartbeatAt: OBSERVED_AT,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        "derived_projection",
      ),
    });
    expect(() => assertRemoteWorkerAssignmentPage(assignmentPage({ items: [bad] }))).toThrow(
      /authority is inconsistent/u,
    );
  });

  it("rejects a usage section that claims availability", () => {
    const bad = assignmentProjection({
      unavailable: {
        usageAndCost: truth({ costUsd: 0 } as never, "canonical_record"),
        resourceCell: unavailable("storage.remoteWorkerResourceCells"),
        artifactAndEffects: unavailable("storage.remoteWorkerArtifacts"),
      } as RemoteWorkerAssignmentProjection["unavailable"],
    });
    expect(() => assertRemoteWorkerAssignmentPage(assignmentPage({ items: [bad] }))).toThrow(
      /must remain unavailable/u,
    );
  });

  it("rejects a page over the item cap", () => {
    const items = Array.from({ length: 101 }, () => assignmentProjection());
    expect(() => assertRemoteWorkerAssignmentPage(assignmentPage({ items }))).toThrow(/items are invalid/u);
  });
});

describe("assertRemoteWorkerAssignmentEventPage", () => {
  function eventPage(overrides: Partial<RemoteWorkerAssignmentEventPage> = {}): RemoteWorkerAssignmentEventPage {
    return {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_PAGE_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-a",
      assignmentId: "assign-a",
      assignmentGeneration: 1,
      items: [
        { sequence: 1, eventId: "e1", eventType: "status", receivedAt: OBSERVED_AT, workerSentThrough: 1 },
        { sequence: 2, eventId: "e2", eventType: "tool_progress", receivedAt: OBSERVED_AT, workerSentThrough: 2 },
      ],
      nextAfterSequence: 2,
      omitted: { transcriptDeltas: 1, terminalOutputs: 0, diagnostics: 2 },
      observedAt: OBSERVED_AT,
      ...overrides,
    };
  }

  it("accepts an ordered sanitized event page with explicit omitted counts", () => {
    expect(() => freezeRemoteWorkerAssignmentEventPage(eventPage())).not.toThrow();
  });

  it("rejects out-of-order or duplicate sequences", () => {
    expect(() =>
      assertRemoteWorkerAssignmentEventPage(
        eventPage({
          items: [
            { sequence: 2, eventId: "e2", eventType: "status", receivedAt: OBSERVED_AT, workerSentThrough: 2 },
            { sequence: 1, eventId: "e1", eventType: "status", receivedAt: OBSERVED_AT, workerSentThrough: 1 },
          ],
        }),
      ),
    ).toThrow(/order is invalid/u);
  });

  it("rejects an event summary carrying an unexpected payload field", () => {
    expect(() =>
      assertRemoteWorkerAssignmentEventPage(
        eventPage({
          items: [
            {
              sequence: 1,
              eventId: "e1",
              eventType: "status",
              receivedAt: OBSERVED_AT,
              workerSentThrough: 1,
              payload: { secret: "x" },
            } as never,
          ],
        }),
      ),
    ).toThrow(/fields are invalid/u);
  });
});

describe("assertRemoteWorkerReconciliation", () => {
  function reconciliation(overrides: Partial<RemoteWorkerReconciliation> = {}): RemoteWorkerReconciliation {
    return {
      schemaVersion: REMOTE_WORKER_RECONCILIATION_SCHEMA_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-a",
      workerId: "worker-a",
      posture: truth<RemoteWorkerReconciliation["posture"]["value"]>(
        "active",
        "derived_projection",
        "gateway.remoteWorkers",
      ),
      admissionControl: truth(
        { status: "consistent", summary: "Generation 2 active, no control." },
        "derived_projection",
        "gateway.remoteWorkers",
      ),
      assignmentLease: truth(
        { status: "divergent", summary: "1 of 3 assignments has an expired lease." },
        "derived_projection",
        "gateway.remoteWorkers",
      ),
      settlementMaterialization: truth(
        { status: "empty", summary: "No settlements recorded." },
        "derived_projection",
        "gateway.remoteWorkers",
      ),
      resourceCell: unavailable("storage.remoteWorkerResourceCells"),
      cleanup: unavailable("storage.remoteWorkerCleanup"),
      observedAt: OBSERVED_AT,
      ...overrides,
    } as RemoteWorkerReconciliation;
  }

  it("accepts a derived comparison with unavailable resource-cell and cleanup owners", () => {
    expect(() => freezeRemoteWorkerReconciliation(reconciliation())).not.toThrow();
  });

  it("rejects a resource-cell section projected as available", () => {
    expect(() =>
      assertRemoteWorkerReconciliation(
        reconciliation({ resourceCell: truth({ cell: "x" } as never, "canonical_record") }),
      ),
    ).toThrow(/must remain unavailable/u);
  });

  it("rejects an observation summary over 256 characters", () => {
    expect(() =>
      assertRemoteWorkerReconciliation(
        reconciliation({
          admissionControl: truth(
            { status: "consistent", summary: "x".repeat(257) },
            "derived_projection",
            "gateway.remoteWorkers",
          ),
        }),
      ),
    ).toThrow(/summary is invalid/u);
  });
});
