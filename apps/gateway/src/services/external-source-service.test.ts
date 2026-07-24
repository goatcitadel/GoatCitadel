import { createHash } from "node:crypto";
import {
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  type ExternalSourceCatalogListInput,
  type ExternalSourceCreateInput,
  type ExternalSourcePage,
  type ExternalSourceRecord,
  type ExternalSourceScanRecord,
  type WorkspacePathBridgeSnapshotRecord,
  type WorkspaceRecord,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  ExternalSourceService,
  ExternalSourceServiceError,
  StorageExternalSourceIdentityResolver,
  type ExternalSourceConfigRepositoryPort,
  type ExternalSourceRequestActor,
  type ExternalSourceRootInspectorPort,
  type ExternalSourceScanRepositoryPort,
  type ExternalSourcePathVerifierPort,
} from "./external-source-service.js";
import { ExternalSourceScanServiceError } from "./external-source-scan-service.js";

const ACTOR: ExternalSourceRequestActor = { actorId: "operator-1", source: "token" };
const OTHER_ACTOR: ExternalSourceRequestActor = { actorId: "operator-2", source: "basic" };
const ROOT = "/synthetic/codex/sessions";
const NOW = "2026-07-14T10:00:00.000Z";

describe("HX-407 external source lifecycle service", () => {
  it("registers an exact verified root with request-derived ownership and a fixed adapter", async () => {
    const harness = createHarness();
    const created = await harness.service.create(createInput(), ACTOR, liveSignal());

    expect(created.source).toMatchObject({
      sourceId: "external-source-fixed",
      workspaceId: "workspace-1",
      ownerActorId: ACTOR.actorId,
      authActorId: ACTOR.actorId,
      authActorSource: ACTOR.source,
      canonicalRootPath: ROOT,
      rootIdentitySha256: digest("root-identity"),
      pathBridgeSnapshotId: "snapshot-1",
      adapterId: "codex.rollout-jsonl.v1",
      adapterVersion: "1.0.0",
      revision: 1,
      status: "active",
    });
    expect(created.source.adapterPolicy).toEqual({
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["synthetic-codex.v1"],
    });
    expect(created.source.ownershipAttestationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(created.source.rootGrantApprovalId).toBeUndefined();
    expect(harness.rootInspector.paths).toEqual([ROOT]);
    expect(harness.pathVerifier.requests).toEqual([
      {
        verificationId: "snapshot-1",
        workspaceId: "workspace-1",
        inputPath: ROOT,
        inputFlavor: "windows_native",
        targetFlavor: "windows_native",
        requireGitIdentity: false,
      },
    ]);
    expect(JSON.stringify(created)).toContain(ROOT);

    const list = harness.service.list("workspace-1", ACTOR);
    const serialized = JSON.stringify(list);
    expect(list.items).toHaveLength(1);
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain(ACTOR.actorId);
    expect(serialized).not.toContain("snapshot-1");
    expect(harness.service.list("workspace-1", OTHER_ACTOR).items).toEqual([]);
    expect(() => harness.service.get("workspace-1", created.source.sourceId, OTHER_ACTOR)).toThrow(
      expect.objectContaining<Partial<ExternalSourceServiceError>>({ code: "not_found" }),
    );
    expect(harness.service.list("workspace-1", { actorId: ACTOR.actorId, source: "basic" }).items).toEqual([]);
  });

  it("applies the list cap after exact actor ownership filtering", () => {
    const harness = createHarness();
    harness.configs.records.push(
      ...Array.from({ length: 100 }, (_, index) => sourceStub(`foreign-${index}`, "disabled", OTHER_ACTOR)),
      sourceStub("owned-after-foreign-page", "disabled", ACTOR),
    );

    expect(harness.service.list("workspace-1", ACTOR).items.map((item) => item.sourceId)).toEqual([
      "owned-after-foreign-page",
    ]);
  });

  it("fails closed on snapshot, workspace, root, and actor drift before persistence", async () => {
    const wrongWorkspace = createHarness({ workspaceStatus: "archived" });
    await expect(wrongWorkspace.service.create(createInput(), ACTOR, liveSignal())).rejects.toMatchObject<
      Partial<ExternalSourceServiceError>
    >({ code: "not_found" });
    expect(wrongWorkspace.configs.records).toHaveLength(0);

    const snapshotDrift = createHarness();
    await expect(
      snapshotDrift.service.create(
        { ...createInput(), pathBridgeSnapshotSha256: digest("wrong") },
        ACTOR,
        liveSignal(),
      ),
    ).rejects.toMatchObject<Partial<ExternalSourceServiceError>>({ code: "identity_drift" });
    expect(snapshotDrift.rootInspector.paths).toEqual([]);

    const allowedRootPolicyDrift = createHarness({ pathVerifierFailure: true });
    await expect(allowedRootPolicyDrift.service.create(createInput(), ACTOR, liveSignal())).rejects.toMatchObject<
      Partial<ExternalSourceServiceError>
    >({ code: "identity_drift" });
    expect(allowedRootPolicyDrift.rootInspector.paths).toEqual([]);
    expect(allowedRootPolicyDrift.configs.records).toHaveLength(0);

    const workspaceRace = createHarness({ workspaceRevisionAtCreate: 2 });
    await expect(workspaceRace.service.create(createInput(), ACTOR, liveSignal())).rejects.toMatchObject<
      Partial<ExternalSourceServiceError>
    >({ code: "conflict" });
    expect(workspaceRace.rootInspector.paths).toEqual([ROOT]);
    expect(workspaceRace.configs.records).toHaveLength(0);

    const rootDrift = createHarness({ rootFailure: true });
    await expect(rootDrift.service.create(createInput(), ACTOR, liveSignal())).rejects.toMatchObject<
      Partial<ExternalSourceServiceError>
    >({ code: "identity_drift" });
    expect(rootDrift.configs.records).toHaveLength(0);

    const cancelled = createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.service.create(createInput(), ACTOR, controller.signal)).rejects.toMatchObject<
      Partial<ExternalSourceServiceError>
    >({ code: "cancelled" });
    expect(cancelled.configs.records).toHaveLength(0);
  });

  it("enforces revision CAS, terminal revoke, and the active-root hard cap", async () => {
    const harness = createHarness();
    const created = await harness.service.create(createInput(), ACTOR, liveSignal());
    const disabled = await harness.service.update(
      created.source.sourceId,
      { workspaceId: "workspace-1", status: "disabled", expectedRevision: 1 },
      ACTOR,
    );
    expect(disabled.source).toMatchObject({ status: "disabled", revision: 2 });
    await expect(
      harness.service.update(
        created.source.sourceId,
        { workspaceId: "workspace-1", label: "stale", expectedRevision: 1 },
        ACTOR,
      ),
    ).rejects.toMatchObject<Partial<ExternalSourceServiceError>>({ code: "conflict" });

    const revoked = await harness.service.update(
      created.source.sourceId,
      { workspaceId: "workspace-1", status: "revoked", expectedRevision: 2 },
      ACTOR,
    );
    expect(revoked.source).toMatchObject({ status: "revoked", revision: 3 });
    await expect(
      harness.service.update(
        created.source.sourceId,
        { workspaceId: "workspace-1", status: "active", expectedRevision: 3 },
        ACTOR,
      ),
    ).rejects.toMatchObject<Partial<ExternalSourceServiceError>>({ code: "conflict" });

    const capped = createHarness();
    capped.configs.records.push(
      ...Array.from({ length: 16 }, (_, index) => sourceStub(`source-${index}`, "active", ACTOR)),
    );
    await expect(capped.service.create(createInput(), ACTOR, liveSignal())).rejects.toMatchObject<
      Partial<ExternalSourceServiceError>
    >({ code: "limit_exceeded" });
    expect(capped.rootInspector.paths).toEqual([ROOT]);
  });

  it("never lets request producer strings expand the frozen compatibility registry", async () => {
    const harness = createHarness();
    await expect(
      harness.service.create(
        { ...createInput(), acceptedProducerVersions: ["real-but-unreviewed-codex"] },
        ACTOR,
        liveSignal(),
      ),
    ).rejects.toMatchObject<Partial<ExternalSourceServiceError>>({ code: "unsupported_producer_version" });
    expect(harness.configs.records).toHaveLength(0);
    expect(harness.rootInspector.paths).toEqual([]);

    const created = await harness.service.create(createInput(), ACTOR, liveSignal());
    await expect(
      harness.service.update(
        created.source.sourceId,
        {
          workspaceId: "workspace-1",
          acceptedProducerVersions: ["operator-manufactured-trust"],
          expectedRevision: 1,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject<Partial<ExternalSourceServiceError>>({ code: "unsupported_producer_version" });
    expect(harness.configs.records[0]?.revision).toBe(1);
  });

  it("binds scans and immutable pages to the owned source and expected config revision", async () => {
    const harness = createHarness();
    const created = await harness.service.create(createInput(), ACTOR, liveSignal());
    harness.scanner.result = scanStub(created.source);

    await expect(
      harness.service.scan(
        created.source.sourceId,
        { workspaceId: "workspace-1", expectedRevision: 2 },
        ACTOR,
        liveSignal(),
      ),
    ).rejects.toMatchObject<Partial<ExternalSourceServiceError>>({ code: "conflict" });
    expect(harness.scanner.calls).toEqual([]);

    const scan = await harness.service.scan(
      created.source.sourceId,
      { workspaceId: "workspace-1", expectedRevision: 1 },
      ACTOR,
      liveSignal(),
    );
    expect(scan.scanId).toBe("scan-1");
    expect(harness.scanner.calls).toEqual([
      { workspaceId: "workspace-1", sourceId: created.source.sourceId, expectedConfigRevision: 1 },
    ]);

    const input: ExternalSourceCatalogListInput = {
      workspaceId: "workspace-1",
      scanId: "scan-1",
      dispositions: ["supported"],
      cursor: "opaque-cursor",
      limit: 25,
    };
    const page = harness.service.listCatalog(created.source.sourceId, input, ACTOR);
    expect(page).toEqual(harness.scans.page);
    expect(harness.scans.pageInputs).toEqual([{ ...input, sourceId: created.source.sourceId }]);
    expect(() => harness.service.listCatalog(created.source.sourceId, input, OTHER_ACTOR)).toThrow(
      expect.objectContaining<Partial<ExternalSourceServiceError>>({ code: "not_found" }),
    );
  });

  it("returns a content-free conflict when the final scan seal observes a later config revision", async () => {
    const harness = createHarness();
    const created = await harness.service.create(createInput(), ACTOR, liveSignal());
    harness.scanner.failure = new ExternalSourceScanServiceError("source_revision_conflict");

    const error = await harness.service
      .scan(created.source.sourceId, { workspaceId: "workspace-1", expectedRevision: 1 }, ACTOR, liveSignal())
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toMatchObject<Partial<ExternalSourceServiceError>>({
      code: "conflict",
      message: "External source state changed; refresh and retry.",
    });
    expect((error as Error).message).not.toContain(ROOT);
  });

  it("resolves only the current active config and exact immutable path snapshot for the reader", async () => {
    const harness = createHarness();
    const created = await harness.service.create(createInput(), ACTOR, liveSignal());
    const resolver = new StorageExternalSourceIdentityResolver({
      configs: harness.configs,
      pathSnapshots: harness.pathSnapshots,
      pathVerifier: harness.pathVerifier,
    });
    await expect(
      resolver.resolveCurrent({ workspaceId: "workspace-1", sourceId: created.source.sourceId, signal: liveSignal() }),
    ).resolves.toEqual({ source: created.source, snapshot: harness.snapshot });
    harness.configs.records[0] = sourceStub(created.source.sourceId, "disabled", ACTOR);
    await expect(
      resolver.resolveCurrent({ workspaceId: "workspace-1", sourceId: created.source.sourceId, signal: liveSignal() }),
    ).resolves.toBeUndefined();
  });

  it("preserves a committed CAS result when optional latest-scan projection fails", async () => {
    const harness = createHarness();
    const created = await harness.service.create(createInput(), ACTOR, liveSignal());
    harness.scans.throwOnList = true;
    await expect(
      harness.service.update(
        created.source.sourceId,
        { workspaceId: "workspace-1", label: "Committed rename", expectedRevision: 1 },
        ACTOR,
      ),
    ).resolves.toMatchObject({ source: { label: "Committed rename", revision: 2 } });
    expect(harness.configs.records[0]).toMatchObject({ label: "Committed rename", revision: 2 });
  });

  it("maps generic repository and corrupt-row failures to repository_failure rather than 404 or 409", async () => {
    const harness = createHarness();
    const created = await harness.service.create(createInput(), ACTOR, liveSignal());
    harness.configs.throwOnFind = true;
    expect(() => harness.service.get("workspace-1", created.source.sourceId, ACTOR)).toThrow(
      expect.objectContaining<Partial<ExternalSourceServiceError>>({ code: "repository_failure" }),
    );
    harness.configs.throwOnFind = false;
    harness.scans.throwOnPage = true;
    expect(() =>
      harness.service.listCatalog(created.source.sourceId, { workspaceId: "workspace-1", scanId: "scan-1" }, ACTOR),
    ).toThrow(expect.objectContaining<Partial<ExternalSourceServiceError>>({ code: "repository_failure" }));
    harness.scans.throwOnPage = false;
    harness.scans.pageFailure = new TypeError("synthetic corrupt row shape");
    expect(() =>
      harness.service.listCatalog(created.source.sourceId, { workspaceId: "workspace-1", scanId: "scan-1" }, ACTOR),
    ).toThrow(expect.objectContaining<Partial<ExternalSourceServiceError>>({ code: "repository_failure" }));
    harness.scans.pageFailure = Object.assign(new TypeError("synthetic invalid cursor"), {
      code: "INVALID_EXTERNAL_SOURCE_CURSOR",
    });
    expect(() =>
      harness.service.listCatalog(created.source.sourceId, { workspaceId: "workspace-1", scanId: "scan-1" }, ACTOR),
    ).toThrow(expect.objectContaining<Partial<ExternalSourceServiceError>>({ code: "invalid_cursor" }));
  });

  it("validates the request actor before parsing any service-level input", async () => {
    const harness = createHarness();
    await expect(
      harness.service.create({} as ExternalSourceCreateInput, { actorId: "auth:none", source: "token" }, liveSignal()),
    ).rejects.toMatchObject<Partial<ExternalSourceServiceError>>({ code: "not_found" });
    expect(harness.pathVerifier.requests).toEqual([]);
    expect(harness.rootInspector.paths).toEqual([]);
  });

  it("blocks current allowed-root and Git-evidence drift before the reader can open the root", async () => {
    const source = sourceStub("source-git", "active", ACTOR);
    const snapshot = pathSnapshot();
    const configs = new MemoryConfigRepository();
    configs.records.push(source);
    const allowedRootDrift = new RecordingPathVerifier(snapshot, true);
    const resolver = new StorageExternalSourceIdentityResolver({
      configs,
      pathSnapshots: { find: () => snapshot },
      pathVerifier: allowedRootDrift,
    });
    await expect(
      resolver.resolveCurrent({ workspaceId: "workspace-1", sourceId: source.sourceId, signal: liveSignal() }),
    ).rejects.toMatchObject({ code: "identity_drift" });

    const gitCurrent = {
      ...snapshot,
      gitIdentityRequired: true,
      gitIdentity: { status: "verified" as const, identitySha256: digest("new-git-identity") },
    };
    const gitDrift = new RecordingPathVerifier(gitCurrent);
    const gitResolver = new StorageExternalSourceIdentityResolver({
      configs,
      pathSnapshots: { find: () => snapshot },
      pathVerifier: gitDrift,
    });
    await expect(
      gitResolver.resolveCurrent({ workspaceId: "workspace-1", sourceId: source.sourceId, signal: liveSignal() }),
    ).rejects.toMatchObject({ code: "identity_drift" });
  });
});

function createHarness(
  options: {
    workspaceStatus?: "active" | "archived";
    rootFailure?: boolean;
    pathVerifierFailure?: boolean;
    workspaceRevisionAtCreate?: number;
  } = {},
) {
  const snapshot = pathSnapshot();
  const configs = new MemoryConfigRepository();
  configs.workspaceRevisionAtCreate = options.workspaceRevisionAtCreate ?? 1;
  const scans = new MemoryScanRepository();
  const rootInspector = new RecordingRootInspector(options.rootFailure ?? false);
  const scanner = new RecordingScanner();
  const workspace: WorkspaceRecord = {
    workspaceId: "workspace-1",
    revision: 1,
    name: "Synthetic",
    slug: "synthetic",
    lifecycleStatus: options.workspaceStatus ?? "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const pathSnapshots = { find: (snapshotId: string) => (snapshotId === snapshot.snapshotId ? snapshot : undefined) };
  const pathVerifier = new RecordingPathVerifier(snapshot, options.pathVerifierFailure ?? false);
  const service = new ExternalSourceService({
    configs,
    scans,
    pathSnapshots,
    pathVerifier,
    workspaces: { find: (workspaceId) => (workspaceId === workspace.workspaceId ? workspace : undefined) },
    scanner,
    rootInspector,
    clock: { now: () => new Date(NOW) },
    ids: { createSourceId: () => "external-source-fixed" },
  });
  return { service, configs, scans, scanner, snapshot, pathSnapshots, pathVerifier, rootInspector };
}

class MemoryConfigRepository implements ExternalSourceConfigRepositoryPort {
  public readonly records: ExternalSourceRecord[] = [];
  public workspaceRevisionAtCreate = 1;
  public throwOnFind = false;

  public createForActiveWorkspace(
    record: ExternalSourceRecord,
    expectedWorkspaceRevision: number,
    activeRootLimit: number,
  ): ExternalSourceRecord {
    if (expectedWorkspaceRevision !== this.workspaceRevisionAtCreate) {
      throw Object.assign(new Error("workspace changed"), { code: "WRITE_CONFLICT" });
    }
    if (
      this.records.filter((entry) => entry.workspaceId === record.workspaceId && entry.status === "active").length >=
      activeRootLimit
    ) {
      throw Object.assign(new Error("active root limit"), {
        code: "STATE_CONFLICT",
        details: { reason: "active_root_limit" },
      });
    }
    if (this.records.some((entry) => entry.workspaceId === record.workspaceId && entry.sourceId === record.sourceId)) {
      throw Object.assign(new Error("conflict"), { code: "ALREADY_EXISTS" });
    }
    this.records.push(record);
    return record;
  }

  public updateCas(
    record: ExternalSourceRecord,
    expectedRevision: number,
    activeRootLimit: number,
  ): ExternalSourceRecord {
    const index = this.records.findIndex(
      (entry) =>
        entry.workspaceId === record.workspaceId &&
        entry.sourceId === record.sourceId &&
        entry.revision === expectedRevision,
    );
    if (index < 0) throw Object.assign(new Error("conflict"), { code: "WRITE_CONFLICT" });
    const current = this.records[index]!;
    if (
      current.status !== "active" &&
      record.status === "active" &&
      this.records.filter((entry) => entry.workspaceId === record.workspaceId && entry.status === "active").length >=
        activeRootLimit
    ) {
      throw Object.assign(new Error("active root limit"), {
        code: "STATE_CONFLICT",
        details: { reason: "active_root_limit" },
      });
    }
    this.records[index] = record;
    return record;
  }

  public find(workspaceId: string, sourceId: string): ExternalSourceRecord | undefined {
    if (this.throwOnFind) throw new Error("synthetic corrupt config row");
    return this.records.find((entry) => entry.workspaceId === workspaceId && entry.sourceId === sourceId);
  }

  public get(workspaceId: string, sourceId: string): ExternalSourceRecord {
    const found = this.find(workspaceId, sourceId);
    if (!found) throw Object.assign(new Error("not found"), { code: "ENTITY_NOT_FOUND" });
    return found;
  }

  public listByWorkspace(workspaceId: string, limit = 100): ExternalSourceRecord[] {
    return this.records.filter((entry) => entry.workspaceId === workspaceId).slice(0, limit);
  }

  public listByWorkspaceActor(
    workspaceId: string,
    ownerActorId: string,
    authActorId: string,
    authActorSource: ExternalSourceRequestActor["source"],
    limit = 100,
  ): ExternalSourceRecord[] {
    return this.records
      .filter(
        (entry) =>
          entry.workspaceId === workspaceId &&
          entry.ownerActorId === ownerActorId &&
          entry.authActorId === authActorId &&
          entry.authActorSource === authActorSource,
      )
      .slice(0, limit);
  }
}

class MemoryScanRepository implements ExternalSourceScanRepositoryPort {
  public readonly page: ExternalSourcePage = {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: "workspace-1",
    sourceId: "external-source-fixed",
    scanId: "scan-1",
    items: [],
  };
  public readonly pageInputs: Array<ExternalSourceCatalogListInput & { sourceId: string }> = [];
  public scans: ExternalSourceScanRecord[] = [];
  public throwOnList = false;
  public throwOnPage = false;
  public pageFailure: Error | undefined;

  public listScans(workspaceId: string, sourceId: string, limit = 100): ExternalSourceScanRecord[] {
    if (this.throwOnList) throw new Error("synthetic corrupt scan row");
    return this.scans.filter((scan) => scan.workspaceId === workspaceId && scan.sourceId === sourceId).slice(0, limit);
  }

  public listPage(input: ExternalSourceCatalogListInput & { sourceId: string }): ExternalSourcePage {
    if (this.throwOnPage) throw new Error("synthetic catalog repository failure");
    if (this.pageFailure) throw this.pageFailure;
    this.pageInputs.push(input);
    return this.page;
  }
}

class RecordingRootInspector implements ExternalSourceRootInspectorPort {
  public readonly paths: string[] = [];

  public constructor(private readonly fail: boolean) {}

  public async inspect(canonicalRootPath: string, signal: AbortSignal): Promise<{ rootIdentitySha256: string }> {
    if (signal.aborted) throw new ExternalSourceServiceError("cancelled");
    this.paths.push(canonicalRootPath);
    if (this.fail) throw new Error("synthetic root drift");
    return { rootIdentitySha256: digest("root-identity") };
  }
}

class RecordingPathVerifier implements ExternalSourcePathVerifierPort {
  public readonly requests: Array<Record<string, unknown>> = [];

  public constructor(
    private readonly snapshot: WorkspacePathBridgeSnapshotRecord,
    private readonly fail = false,
  ) {}

  public async resolve(request: Record<string, unknown>): Promise<WorkspacePathBridgeSnapshotRecord> {
    this.requests.push(request);
    if (this.fail) throw new Error("synthetic current allowed-root policy drift");
    return this.snapshot;
  }
}

class RecordingScanner {
  public readonly calls: Array<{ workspaceId: string; sourceId: string; expectedConfigRevision: number }> = [];
  public result?: ExternalSourceScanRecord;
  public failure?: Error;

  public async scan(input: {
    workspaceId: string;
    sourceId: string;
    expectedConfigRevision: number;
    signal: AbortSignal;
  }): Promise<ExternalSourceScanRecord> {
    this.calls.push({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      expectedConfigRevision: input.expectedConfigRevision,
    });
    if (this.failure) throw this.failure;
    if (!this.result) throw new Error("missing synthetic scan");
    return this.result;
  }
}

function createInput(): ExternalSourceCreateInput {
  return {
    workspaceId: "workspace-1",
    expectedWorkspaceRevision: 1,
    kind: "codex_sessions",
    label: "Synthetic Codex sessions",
    canonicalRootPath: ROOT,
    pathBridgeSnapshotId: "snapshot-1",
    pathBridgeSnapshotSha256: digest("snapshot"),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    acceptedProducerVersions: ["synthetic-codex.v1"],
  };
}

function pathSnapshot(): WorkspacePathBridgeSnapshotRecord {
  return {
    schemaVersion: WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
    snapshotId: "snapshot-1",
    requestHash: digest("request"),
    workspaceId: "workspace-1",
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    gitIdentityRequired: false,
    inputPathHash: digest(ROOT),
    allowedRootsHash: digest("allowed-roots"),
    canonicalHostPath: ROOT,
    canonicalTargetPath: ROOT,
    roundTrip: { attempted: true, converter: "native", equal: true },
    gitIdentity: { status: "not_repository" },
    status: "verified",
    callable: true,
    snapshotSha256: digest("snapshot"),
    createdAt: NOW,
  };
}

function sourceStub(
  sourceId: string,
  status: ExternalSourceRecord["status"],
  actor: ExternalSourceRequestActor,
): ExternalSourceRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId,
    workspaceId: "workspace-1",
    kind: "codex_sessions",
    label: sourceId,
    ownerActorId: actor.actorId,
    authActorId: actor.actorId,
    authActorSource: actor.source,
    canonicalRootPath: ROOT,
    rootIdentitySha256: digest(`root:${sourceId}`),
    pathBridgeSnapshotId: "snapshot-1",
    pathBridgeSnapshotSha256: digest("snapshot"),
    allowedRootsSha256: digest("allowed-roots"),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    ownershipAttestationSha256: digest("attestation"),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "1.0.0",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["synthetic-codex.v1"],
    },
    revision: 1,
    configSha256: digest(`config:${sourceId}:${status}`),
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function scanStub(source: ExternalSourceRecord): ExternalSourceScanRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    scanId: "scan-1",
    workspaceId: source.workspaceId,
    sourceId: source.sourceId,
    configRevision: source.revision,
    configSha256: source.configSha256,
    rootIdentitySha256: source.rootIdentitySha256,
    pathBridgeSnapshotSha256: source.pathBridgeSnapshotSha256,
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    manifestSha256: digest("manifest"),
    examinedEntryCount: 0,
    itemCount: 0,
    supportedItemCount: 0,
    quarantinedItemCount: 0,
    blockerCodes: [],
    status: "sealed",
    startedAt: NOW,
    completedAt: NOW,
  };
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
