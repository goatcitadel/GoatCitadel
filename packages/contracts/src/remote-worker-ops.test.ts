import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_DETAIL_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_ITEM_SCHEMA_VERSION,
  REMOTE_WORKER_REGISTRY_PAGE_SCHEMA_VERSION,
  assertRemoteWorkerRegistryDetail,
  assertRemoteWorkerRegistryPage,
  freezeRemoteWorkerRegistryDetail,
  freezeRemoteWorkerRegistryPage,
  normalizeRemoteWorkerRegistryCursor,
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
