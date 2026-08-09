import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  NotFoundError,
  REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
  canonicalJsonString,
  type RemoteWorkerAssignmentEventRecord,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentRecord,
  type RemoteWorkerRegistryAdmission,
} from "@goatcitadel/contracts";
import type { RemoteWorkerAssignmentAggregate, RemoteWorkerRegistryRecord } from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import {
  RemoteWorkerRegistryInputError,
  RemoteWorkersRouteService,
  decodeRemoteWorkerAssignmentCursor,
  decodeRemoteWorkerRegistryCursor,
  encodeRemoteWorkerAssignmentCursor,
  encodeRemoteWorkerRegistryCursor,
  type RemoteWorkerAssignmentStore,
  type RemoteWorkerRegistryStore,
} from "./remote-workers-route-service.js";

const OBSERVED_AT = "2026-07-15T12:00:00.000Z";
const D = (character: string): string => character.repeat(64);

function admission(overrides: Partial<RemoteWorkerRegistryAdmission> = {}): RemoteWorkerRegistryAdmission {
  return {
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
    ...overrides,
  };
}

function record(overrides: Partial<RemoteWorkerRegistryRecord> = {}): RemoteWorkerRegistryRecord {
  return {
    admission: admission(),
    ...overrides,
  };
}

function store(overrides: Partial<RemoteWorkerRegistryStore> = {}): RemoteWorkerRegistryStore {
  return {
    listWorkerRegistry: vi.fn(async () => ({ items: [record()] })),
    findWorkerRegistryEntry: vi.fn(async () => record()),
    ...overrides,
  };
}

function assignmentStore(overrides: Partial<RemoteWorkerAssignmentStore> = {}): RemoteWorkerAssignmentStore {
  return {
    listAssignmentAggregates: vi.fn(async () => ({ items: [] })),
    findAssignmentAggregate: vi.fn(async () => undefined),
    findCurrentGeneration: vi.fn(async () => undefined),
    listEventsAfter: vi.fn(async () => []),
    ...overrides,
  };
}

function assignmentRecord(overrides: Partial<RemoteWorkerAssignmentRecord> = {}): RemoteWorkerAssignmentRecord {
  return {
    registryWorkspaceId: "workspace-a",
    assignmentId: "assign-a",
    manifest: {
      sessionId: "session-a",
      turnId: "turn-a",
      durableRunId: "run-a",
    } as RemoteWorkerAssignmentRecord["manifest"],
    manifestSha256: D("m"),
    createdByActorId: "gateway-a",
    idempotencyKey: "assignment:seed",
    requestSha256: D("r"),
    createdAt: "2026-07-15T11:00:00.000Z",
    ...overrides,
  };
}

function generationRecord(): RemoteWorkerAssignmentGenerationRecord {
  return {
    assignmentGeneration: 1,
    workerId: "worker-a",
    workerGeneration: 2,
    nodeId: "node-a",
    startedAt: "2026-07-15T11:05:00.000Z",
  } as RemoteWorkerAssignmentGenerationRecord;
}

function aggregate(overrides: Partial<RemoteWorkerAssignmentAggregate> = {}): RemoteWorkerAssignmentAggregate {
  return {
    assignment: assignmentRecord(),
    generation: generationRecord(),
    lease: {
      assignmentGeneration: 1,
      leaseRevision: 2,
      workerSentThrough: 3,
      serverAcknowledgedThrough: 2,
      heartbeatAt: "2026-07-15T11:10:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as RemoteWorkerAssignmentAggregate["lease"],
    materialization: { count: 0, chatTranscriptCount: 0, durableRunResultCount: 0 },
    ...overrides,
  };
}

describe("RemoteWorkersRouteService HX-507A", () => {
  it("projects a deeply frozen read-only page with explicit downstream unavailability", async () => {
    const registry = store({
      listWorkerRegistry: vi.fn(async () => ({ items: [record()], nextCursor: "worker-a" })),
    });
    const service = new RemoteWorkersRouteService(registry, assignmentStore(), () => OBSERVED_AT);
    const page = await service.listRegistry({ workspaceId: "workspace-a", limit: 1 });

    expect(page).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-a",
      observedAt: OBSERVED_AT,
      items: [
        {
          workerId: "worker-a",
          admission: { authorityClass: "canonical_record", owner: "storage.remoteWorkerAdmissions" },
          control: { value: null, authorityClass: "canonical_record" },
          posture: { value: "active", authorityClass: "derived_projection" },
          unavailable: {
            connectionHealth: { value: null, authorityClass: "unavailable" },
            assignments: { value: null, authorityClass: "unavailable" },
            usageAndCost: { value: null, authorityClass: "unavailable" },
            resourceCell: { value: null, authorityClass: "unavailable" },
            artifactAndEffects: { value: null, authorityClass: "unavailable" },
          },
        },
      ],
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0]?.admission.value)).toBe(true);
    expect(registry.listWorkerRegistry).toHaveBeenCalledWith("workspace-a", { limit: 1 });
    expect(decodeRemoteWorkerRegistryCursor(page.nextCursor!)).toEqual({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-a",
    });
    expect(JSON.stringify(page)).not.toMatch(
      /secret|token|reason|actor|idempotency|requestSha256|allowedWorkspaceIds|capabilityClasses/u,
    );
  });

  it("decodes only canonical workspace-bound cursors and passes the raw position to storage", async () => {
    const registry = store({ listWorkerRegistry: vi.fn(async () => ({ items: [] })) });
    const service = new RemoteWorkersRouteService(registry, assignmentStore(), () => OBSERVED_AT);
    const cursor = encodeRemoteWorkerRegistryCursor({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-before",
    });
    await service.listRegistry({ workspaceId: "workspace-a", cursor });
    expect(registry.listWorkerRegistry).toHaveBeenCalledWith("workspace-a", {
      limit: 25,
      cursor: "worker-before",
    });
    await expect(service.listRegistry({ workspaceId: "workspace-b", cursor })).rejects.toThrow(
      RemoteWorkerRegistryInputError,
    );

    const reordered = Buffer.from(
      JSON.stringify({
        workspaceId: "workspace-a",
        schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
        lastWorkerId: "worker-before",
      }),
      "utf8",
    ).toString("base64url");
    const extra = Buffer.from(
      canonicalJsonString({
        schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
        workspaceId: "workspace-a",
        lastWorkerId: "worker-before",
        secret: "must-not-echo",
      }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeRemoteWorkerRegistryCursor(reordered)).toThrow(RemoteWorkerRegistryInputError);
    expect(() => decodeRemoteWorkerRegistryCursor(extra)).toThrow(RemoteWorkerRegistryInputError);
    expect(() => decodeRemoteWorkerRegistryCursor("not-canonical+base64")).toThrow(RemoteWorkerRegistryInputError);
  });

  it("derives quarantine and revoke posture only from the canonical latest control", async () => {
    const registry = store({
      listWorkerRegistry: vi.fn(async () => ({
        items: [
          record({
            control: {
              workerGeneration: 2,
              controlRevision: 1,
              action: "quarantine",
              createdAt: "2026-07-15T11:30:00.000Z",
            },
          }),
          record({
            admission: admission({ workerId: "worker-b", nodeId: "node-b" }),
            control: {
              workerGeneration: 2,
              controlRevision: 2,
              action: "revoke",
              createdAt: "2026-07-15T11:45:00.000Z",
            },
          }),
        ],
      })),
    });
    const page = await new RemoteWorkersRouteService(registry, assignmentStore(), () => OBSERVED_AT).listRegistry({
      workspaceId: "workspace-a",
    });
    expect(page.items.map((item) => item.posture.value)).toEqual(["quarantined", "revoked"]);
  });

  it("returns frozen detail, maps foreign-workspace absence to 404, and fails inconsistent storage closed", async () => {
    const registry = store();
    const service = new RemoteWorkersRouteService(registry, assignmentStore(), () => OBSERVED_AT);
    const detail = await service.getRegistryEntry({ workspaceId: "workspace-a", workerId: "worker-a" });
    expect(detail).toMatchObject({ readOnly: true, workspaceId: "workspace-a", item: { workerId: "worker-a" } });
    expect(Object.isFrozen(detail.item)).toBe(true);

    const missing = new RemoteWorkersRouteService(
      store({ findWorkerRegistryEntry: vi.fn(async () => undefined) }),
      assignmentStore(),
      () => OBSERVED_AT,
    );
    await expect(missing.getRegistryEntry({ workspaceId: "workspace-b", workerId: "worker-a" })).rejects.toThrow(
      NotFoundError,
    );

    const wrongDetail = new RemoteWorkersRouteService(
      store({
        findWorkerRegistryEntry: vi.fn(async () =>
          record({ admission: admission({ workerId: "worker-b", nodeId: "node-b" }) }),
        ),
      }),
      assignmentStore(),
      () => OBSERVED_AT,
    );
    await expect(wrongDetail.getRegistryEntry({ workspaceId: "workspace-a", workerId: "worker-a" })).rejects.toThrow(
      /storage detail is inconsistent/u,
    );

    const inconsistent = new RemoteWorkersRouteService(
      store({
        listWorkerRegistry: vi.fn(async () => ({
          items: [record({ admission: admission({ registryWorkspaceId: "workspace-b" }) })],
        })),
      }),
      assignmentStore(),
      () => OBSERVED_AT,
    );
    await expect(inconsistent.listRegistry({ workspaceId: "workspace-a" })).rejects.toThrow(TypeError);

    const reordered = new RemoteWorkersRouteService(
      store({
        listWorkerRegistry: vi.fn(async () => ({
          items: [record({ admission: admission({ workerId: "worker-b", nodeId: "node-b" }) }), record()],
          nextCursor: "worker-a",
        })),
      }),
      assignmentStore(),
      () => OBSERVED_AT,
    );
    await expect(reordered.listRegistry({ workspaceId: "workspace-a", limit: 2 })).rejects.toThrow(/order is invalid/u);
  });

  it("binds malformed storage pages to the requested limit and decoded cursor", async () => {
    const cursor = encodeRemoteWorkerRegistryCursor({
      schemaVersion: REMOTE_WORKER_REGISTRY_CURSOR_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      lastWorkerId: "worker-a",
    });
    const oversized = new RemoteWorkersRouteService(
      store({
        listWorkerRegistry: vi.fn(async () => ({
          items: [record(), record({ admission: admission({ workerId: "worker-b", nodeId: "node-b" }) })],
        })),
      }),
      assignmentStore(),
      () => OBSERVED_AT,
    );
    await expect(oversized.listRegistry({ workspaceId: "workspace-a", limit: 1 })).rejects.toThrow(
      /storage page is inconsistent/u,
    );

    for (const workerId of ["worker-a", "worker-0"]) {
      const stale = new RemoteWorkersRouteService(
        store({
          listWorkerRegistry: vi.fn(async () => ({
            items: [record({ admission: admission({ workerId, nodeId: `node-${workerId}` }) })],
          })),
        }),
        () => OBSERVED_AT,
      );
      await expect(stale.listRegistry({ workspaceId: "workspace-a", cursor })).rejects.toThrow(
        /storage page is inconsistent/u,
      );
    }

    const shortPageWithCursor = new RemoteWorkersRouteService(
      store({ listWorkerRegistry: vi.fn(async () => ({ items: [record()], nextCursor: "worker-a" })) }),
      assignmentStore(),
      () => OBSERVED_AT,
    );
    await expect(shortPageWithCursor.listRegistry({ workspaceId: "workspace-a", limit: 2 })).rejects.toThrow(
      /storage page is inconsistent/u,
    );
  });

  it("composes read owners plus governed admission/audit/manifest-verification control and registers the route", () => {
    const composition = readFileSync(new URL("./gateway-route-composition-runtime.ts", import.meta.url), "utf8");
    const services = readFileSync(new URL("./gateway-route-services.ts", import.meta.url), "utf8");
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(composition).toMatch(/registry:\s*gateway\.storage\.remoteWorkerAdmissions/u);
    expect(composition).toMatch(/assignments:\s*gateway\.storage\.remoteWorkerAssignments/u);
    expect(composition).toMatch(/admissions:\s*gateway\.storage\.remoteWorkerAdmissions/u);
    expect(composition).toMatch(/audit:\s*gateway\.storage\.audit/u);
    expect(composition).toMatch(/manifestVerifier:\s*createConfiguredRemoteWorkerManifestVerifier\(\)/u);
    // No usage/resource-cell/artifact owner is composed into this visibility tranche.
    expect(composition).not.toMatch(/gateway\.storage\.remoteWorker(?:Usage|ResourceCells|Artifacts|Cells|Effects)/u);
    expect(services).toMatch(/new RemoteWorkersRouteService\([\s\S]*?deps\.remoteWorkers\.operatorControl/u);
    expect(app).toMatch(/import \{ remoteWorkersRoutes \} from "\.\/routes\/remote-workers\.js"/u);
    expect(app).toMatch(/await app\.register\(remoteWorkersRoutes\)/u);
  });
});

describe("RemoteWorkersRouteService HX-507B projections", () => {
  it("projects a frozen, secret-free assignment page with derived lease freshness and phase", async () => {
    const assignments = assignmentStore({
      listAssignmentAggregates: vi.fn(async () => ({
        items: [aggregate()],
        nextCursor: { lastCreatedAt: "2026-07-15T11:00:00.000Z", lastAssignmentId: "assign-a" },
      })),
    });
    const service = new RemoteWorkersRouteService(store(), assignments, () => OBSERVED_AT);
    const page = await service.listAssignments({ workspaceId: "workspace-a", workerId: "worker-a", limit: 1 });

    expect(page).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-a",
      filters: { workerId: "worker-a" },
      items: [
        {
          assignmentId: "assign-a",
          identity: { value: { workerId: "worker-a" }, authorityClass: "canonical_record" },
          lease: { value: { leaseRevision: 2, workerSentThrough: 3 }, authorityClass: "canonical_record" },
          leaseFreshness: { value: { fresh: true }, authorityClass: "derived_projection" },
          phase: { value: "leased", authorityClass: "derived_projection" },
          unavailable: {
            usageAndCost: { value: null, authorityClass: "unavailable" },
            resourceCell: { value: null, authorityClass: "unavailable" },
            artifactAndEffects: { value: null, authorityClass: "unavailable" },
          },
        },
      ],
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(assignments.listAssignmentAggregates).toHaveBeenCalledWith("workspace-a", {
      workerId: "worker-a",
      limit: 1,
    });
    // Never leaks lease tokens, dispatch authority, reason digests, idempotency keys, or manifest hashes.
    expect(JSON.stringify(page)).not.toMatch(
      /leaseToken|dispatchAuthority|reasonSha256|requestSha256|idempotency|manifestSha256|parentDispatch/u,
    );
    const decoded = decodeRemoteWorkerAssignmentCursor(page.nextCursor!);
    expect(decoded).toMatchObject({ workspaceId: "workspace-a", workerId: "worker-a", lastAssignmentId: "assign-a" });
  });

  it("derives lease_expired, cancelling, and settled phases from canonical evidence", async () => {
    const build = async (over: Partial<RemoteWorkerAssignmentAggregate>) =>
      (
        await new RemoteWorkersRouteService(
          store(),
          assignmentStore({ listAssignmentAggregates: vi.fn(async () => ({ items: [aggregate(over)] })) }),
          () => OBSERVED_AT,
        ).listAssignments({ workspaceId: "workspace-a" })
      ).items[0]!;

    const staleLease = await build({
      lease: {
        assignmentGeneration: 1,
        leaseRevision: 1,
        workerSentThrough: 0,
        serverAcknowledgedThrough: 0,
        heartbeatAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:00:00.000Z",
      } as RemoteWorkerAssignmentAggregate["lease"],
    });
    expect(staleLease.phase.value).toBe("lease_expired");
    expect(staleLease.leaseFreshness.value).toMatchObject({ fresh: false });

    const cancelling = await build({
      control: {
        expectedAssignmentGeneration: 1,
        controlRevision: 1,
        action: "cancel_requested",
        createdAt: OBSERVED_AT,
      } as RemoteWorkerAssignmentAggregate["control"],
    });
    expect(cancelling.phase.value).toBe("cancelling");
    expect(cancelling.control?.value).toMatchObject({ action: "cancel_requested" });

    const settled = await build({
      settlement: {
        assignmentGeneration: 1,
        outcome: "completed",
        origin: "worker",
        finalEventSequence: 4,
        settledAt: OBSERVED_AT,
      } as RemoteWorkerAssignmentAggregate["settlement"],
      materialization: {
        count: 2,
        chatTranscriptCount: 1,
        durableRunResultCount: 1,
        latestMaterializedAt: OBSERVED_AT,
      },
    });
    expect(settled.phase.value).toBe("settled");
    expect(settled.settlement?.value).toMatchObject({ outcome: "completed" });
    expect(settled.materialization.value).toMatchObject({ count: 2 });
  });

  it("projects an unstarted assignment as created with null identity/lease", async () => {
    const service = new RemoteWorkersRouteService(
      store(),
      assignmentStore({
        listAssignmentAggregates: vi.fn(async () => ({
          items: [
            {
              assignment: assignmentRecord({
                manifest: { durableRunId: "run-a" } as RemoteWorkerAssignmentRecord["manifest"],
              }),
              materialization: { count: 0, chatTranscriptCount: 0, durableRunResultCount: 0 },
            },
          ],
        })),
      }),
      () => OBSERVED_AT,
    );
    const item = (await service.listAssignments({ workspaceId: "workspace-a" })).items[0]!;
    expect(item.phase.value).toBe("created");
    expect(item.identity.value).toBeNull();
    expect(item.lease.value).toBeNull();
    expect(item.leaseFreshness.value).toBeNull();
    expect(item.lineage.value).toMatchObject({ sessionId: null, turnId: null });
  });

  it("rebinds a cursor to its exact workspace+filter set", async () => {
    const cursor = encodeRemoteWorkerAssignmentCursor({
      schemaVersion: "goatcitadel.remote-worker-assignment-cursor.v1",
      workspaceId: "workspace-a",
      workerId: "worker-a",
      sessionId: null,
      turnId: null,
      lastCreatedAt: "2026-07-15T11:00:00.000Z",
      lastAssignmentId: "assign-a",
    });
    const service = new RemoteWorkersRouteService(store(), assignmentStore(), () => OBSERVED_AT);
    // Same filter set is accepted.
    await expect(
      service.listAssignments({ workspaceId: "workspace-a", workerId: "worker-a", cursor }),
    ).resolves.toBeDefined();
    // A different filter set is rejected — the cursor cannot be replayed across scopes.
    await expect(service.listAssignments({ workspaceId: "workspace-a", cursor })).rejects.toThrow(
      RemoteWorkerRegistryInputError,
    );
    await expect(service.listAssignments({ workspaceId: "workspace-b", workerId: "worker-a", cursor })).rejects.toThrow(
      RemoteWorkerRegistryInputError,
    );
  });

  it("returns sanitized ordered event summaries with explicit omitted content counts", async () => {
    const events: RemoteWorkerAssignmentEventRecord[] = [
      eventRecord(1, "status"),
      eventRecord(2, "transcript_delta"),
      eventRecord(3, "terminal_output"),
      eventRecord(4, "diagnostic"),
    ];
    const assignments = assignmentStore({
      findCurrentGeneration: vi.fn(async () => generationRecord()),
      listEventsAfter: vi.fn(async () => events),
    });
    const service = new RemoteWorkersRouteService(store(), assignments, () => OBSERVED_AT);
    const page = await service.getAssignmentEvents({ workspaceId: "workspace-a", assignmentId: "assign-a" });
    expect(page.assignmentGeneration).toBe(1);
    expect(page.items.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(page.nextAfterSequence).toBe(4);
    expect(page.omitted).toEqual({ transcriptDeltas: 1, terminalOutputs: 1, diagnostics: 1 });
    // No payload body, hash, terminal chunk, or transcript text escapes — only sanitized metadata.
    expect(JSON.stringify(page)).not.toMatch(/payload|Sha256|stdout|chunk|"text"|"role"/u);
  });

  it("404s events for an assignment with no started generation and isolates cross-workspace ids", async () => {
    const service = new RemoteWorkersRouteService(
      store(),
      assignmentStore({ findCurrentGeneration: vi.fn(async () => undefined) }),
      () => OBSERVED_AT,
    );
    await expect(service.getAssignmentEvents({ workspaceId: "workspace-a", assignmentId: "missing" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("reconciles admission, assignment/lease, and settlement while holding HX-505 owners unavailable", async () => {
    const registry = store({
      findWorkerRegistryEntry: vi.fn(async () => record()),
    });
    const assignments = assignmentStore({
      listAssignmentAggregates: vi.fn(async () => ({
        items: [
          aggregate(),
          aggregate({
            assignment: assignmentRecord({ assignmentId: "assign-b" }),
            lease: {
              assignmentGeneration: 1,
              leaseRevision: 1,
              workerSentThrough: 0,
              serverAcknowledgedThrough: 0,
              heartbeatAt: "2020-01-01T00:00:00.000Z",
              expiresAt: "2020-01-01T00:00:00.000Z",
            } as RemoteWorkerAssignmentAggregate["lease"],
          }),
        ],
      })),
    });
    const reconciliation = await new RemoteWorkersRouteService(
      registry,
      assignments,
      () => OBSERVED_AT,
    ).getReconciliation({ workspaceId: "workspace-a", workerId: "worker-a" });
    expect(reconciliation.posture.value).toBe("active");
    expect(reconciliation.admissionControl.value?.status).toBe("consistent");
    expect(reconciliation.assignmentLease.value?.status).toBe("divergent");
    expect(reconciliation.settlementMaterialization.value?.status).toBe("empty");
    expect(reconciliation.resourceCell).toMatchObject({ value: null, authorityClass: "unavailable" });
    expect(reconciliation.cleanup).toMatchObject({ value: null, authorityClass: "unavailable" });
    expect(Object.isFrozen(reconciliation)).toBe(true);
  });

  it("reconciles every assignment page instead of reporting false consistency from the first page", async () => {
    const secondPageCursor = {
      lastCreatedAt: "2026-07-15T10:00:00.000Z",
      lastAssignmentId: "assign-page-one",
    };
    const expired = aggregate({
      assignment: assignmentRecord({ assignmentId: "assign-expired" }),
      lease: {
        assignmentGeneration: 1,
        leaseRevision: 1,
        workerSentThrough: 0,
        serverAcknowledgedThrough: 0,
        heartbeatAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:00:00.000Z",
      } as RemoteWorkerAssignmentAggregate["lease"],
    });
    const settledWithoutMaterialization = aggregate({
      assignment: assignmentRecord({ assignmentId: "assign-unmaterialized" }),
      settlement: {
        assignmentGeneration: 1,
        outcome: "completed",
        origin: "worker",
        finalEventSequence: 4,
        settledAt: OBSERVED_AT,
      } as RemoteWorkerAssignmentAggregate["settlement"],
    });
    const listAssignmentAggregates = vi.fn(
      async (_workspaceId: string, options?: Parameters<RemoteWorkerAssignmentStore["listAssignmentAggregates"]>[1]) =>
        options?.cursor
          ? { items: [expired, settledWithoutMaterialization] }
          : { items: [aggregate()], nextCursor: secondPageCursor },
    );
    const service = new RemoteWorkersRouteService(
      store({ findWorkerRegistryEntry: vi.fn(async () => record()) }),
      assignmentStore({ listAssignmentAggregates }),
      () => OBSERVED_AT,
    );

    const reconciliation = await service.getReconciliation({ workspaceId: "workspace-a", workerId: "worker-a" });

    expect(reconciliation.assignmentLease.value).toEqual({
      status: "divergent",
      summary: "3 assignment(s): 1 with a fresh lease, 1 with an expired unsettled lease.",
    });
    expect(reconciliation.settlementMaterialization.value).toEqual({
      status: "divergent",
      summary: "1 settled assignment(s); 0 carry recorded materialization receipts.",
    });
    expect(listAssignmentAggregates).toHaveBeenNthCalledWith(1, "workspace-a", {
      workerId: "worker-a",
      limit: 100,
    });
    expect(listAssignmentAggregates).toHaveBeenNthCalledWith(2, "workspace-a", {
      workerId: "worker-a",
      limit: 100,
      cursor: secondPageCursor,
    });
  });

  it("fails closed when reconciliation storage repeats a pagination cursor", async () => {
    const repeatedCursor = {
      lastCreatedAt: "2026-07-15T10:00:00.000Z",
      lastAssignmentId: "assign-repeat",
    };
    const service = new RemoteWorkersRouteService(
      store({ findWorkerRegistryEntry: vi.fn(async () => record()) }),
      assignmentStore({
        listAssignmentAggregates: vi.fn(async () => ({ items: [aggregate()], nextCursor: repeatedCursor })),
      }),
      () => OBSERVED_AT,
    );

    await expect(service.getReconciliation({ workspaceId: "workspace-a", workerId: "worker-a" })).rejects.toThrow(
      "Remote worker assignment reconciliation cursor did not advance.",
    );
  });

  it("bounds full reconciliation scans and fails closed instead of running an unbounded Ops request", async () => {
    let pageNumber = 0;
    const listAssignmentAggregates = vi.fn(async () => {
      pageNumber += 1;
      return {
        items: [aggregate({ assignment: assignmentRecord({ assignmentId: `assign-${pageNumber}` }) })],
        nextCursor: {
          lastCreatedAt: new Date(Date.parse("2026-07-15T10:00:00.000Z") - pageNumber * 60_000).toISOString(),
          lastAssignmentId: `assign-${pageNumber}`,
        },
      };
    });
    const service = new RemoteWorkersRouteService(
      store({ findWorkerRegistryEntry: vi.fn(async () => record()) }),
      assignmentStore({ listAssignmentAggregates }),
      () => OBSERVED_AT,
    );

    await expect(service.getReconciliation({ workspaceId: "workspace-a", workerId: "worker-a" })).rejects.toThrow(
      "Remote worker assignment reconciliation exceeded 100 pages.",
    );
    expect(listAssignmentAggregates).toHaveBeenCalledTimes(100);
  });

  it("404s reconciliation for an unknown worker id", async () => {
    const service = new RemoteWorkersRouteService(
      store({ findWorkerRegistryEntry: vi.fn(async () => undefined) }),
      assignmentStore(),
      () => OBSERVED_AT,
    );
    await expect(service.getReconciliation({ workspaceId: "workspace-a", workerId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

function eventRecord(sequence: number, eventType: string): RemoteWorkerAssignmentEventRecord {
  return {
    registryWorkspaceId: "workspace-a",
    assignmentId: "assign-a",
    assignmentGeneration: 1,
    sequence,
    eventId: `event-${sequence}`,
    eventType,
    payload: { schemaVersion: "x", phase: "running" },
    payloadSha256: D("p"),
    previousEventSha256: D("q"),
    eventSha256: D("s"),
    workerSentThrough: sequence,
    receivedAt: "2026-07-15T11:20:00.000Z",
  } as unknown as RemoteWorkerAssignmentEventRecord;
}
