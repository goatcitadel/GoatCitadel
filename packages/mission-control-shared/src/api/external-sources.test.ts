import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  type ExternalSessionAttachmentRecord,
  type ExternalSourceImportIntent,
  type ExternalSourceImportItem,
  type ExternalSourceImportPlan,
  type ExternalSourceRecord,
} from "@goatcitadel/contracts";
import * as externalSources from "./external-sources";
import { ApiRequestError } from "./http-internal";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
}));

const timestamp = "2026-07-14T08:00:00.000Z";
const hash = (value: string): string => value.repeat(64).slice(0, 64);

function sourceRecord(): ExternalSourceRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId: "source-1",
    workspaceId: "workspace-1",
    kind: "codex_sessions",
    label: "Synthetic Codex source",
    ownerActorId: "operator-1",
    authActorId: "operator-1",
    authActorSource: "token",
    canonicalRootPath: "/srv/synthetic/codex/sessions",
    rootIdentitySha256: hash("1"),
    pathBridgeSnapshotId: "path-bridge-1",
    pathBridgeSnapshotSha256: hash("2"),
    allowedRootsSha256: hash("3"),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    ownershipAttestationSha256: hash("4"),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-fixture-1",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["codex-synthetic-1"],
    },
    revision: 1,
    configSha256: hash("5"),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function importPlan(): ExternalSourceImportPlan {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    planId: "plan-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    configRevision: 1,
    configSha256: hash("1"),
    manifestSha256: hash("2"),
    adapterVersions: ["codex-fixture-1"],
    selectedItemIds: ["item-1"],
    selectedItemSetSha256: hash("3"),
    rawSetSha256: hash("4"),
    rawByteCount: 256,
    normalizedSetSha256: hash("5"),
    normalizedByteCount: 128,
    messageCount: 2,
    blockerCodes: [],
    stagingLeaseId: "staging-1",
    stagingExpiresAt: "2026-07-14T08:30:00.000Z",
    planSha256: hash("6"),
    createdAt: timestamp,
  };
}

function importIntent(): ExternalSourceImportIntent {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    importId: "import-1",
    idempotencyKey: "external-source-import:v1:fixture",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    planId: "plan-1",
    configRevision: 1,
    configSha256: hash("1"),
    manifestSha256: hash("2"),
    planSha256: hash("6"),
    selectedItemSetSha256: hash("3"),
    adapterVersions: ["codex-fixture-1"],
    requestedByActorId: "operator-1",
    requestSha256: hash("7"),
    admittedAt: timestamp,
  };
}

function importItem(): ExternalSourceImportItem {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: "workspace-1",
    importId: "import-1",
    scanId: "scan-1",
    itemId: "item-1",
    ordinal: 0,
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-fixture-1",
    rawSha256: hash("4"),
    rawByteCount: 256,
    normalizedArtifactSha256: hash("8"),
    normalizedByteCount: 128,
    artifactRelativeKey: `external-sources/sha256/${hash("8")}`,
    provenanceSha256: hash("9"),
    createdAt: timestamp,
  };
}

function externalAttachment(): ExternalSessionAttachmentRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    attachmentId: "attachment-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sourceId: "source-1",
    importId: "import-1",
    itemId: "item-1",
    normalizedArtifactSha256: hash("1"),
    mode: "read_only_external",
    status: "attached",
    revision: 1,
    attachedByActorId: "operator-1",
    attachedAt: timestamp,
  };
}

function lastCall(): [string, RequestInit | undefined] {
  const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
  return [path as string, init as RequestInit | undefined];
}

function body(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

beforeEach(() => {
  apiMocks.request.mockReset();
});

describe("external-sources Library client", () => {
  it("lists workspace sources against the exact route and validates every summary", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      items: [
        {
          schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
          sourceId: "source-1",
          workspaceId: "workspace-1",
          kind: "codex_sessions",
          label: "Synthetic Codex source",
          adapterId: "codex.rollout-jsonl.v1",
          adapterVersion: "codex-fixture-1",
          revision: 1,
          configSha256: hash("5"),
          status: "active",
          updatedAt: timestamp,
        },
      ],
    });
    const list = await externalSources.fetchExternalSources("workspace-1");

    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/library/external-sources?workspaceId=workspace-1");
    expect(init?.method ?? "GET").toBe("GET");
    expect(list.items[0]?.sourceId).toBe("source-1");
  });

  it("rejects an invalid list response instead of trusting it", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      items: [{ sourceId: "source-1", secretRootPath: "C:/Users/private" }],
    });
    await expect(externalSources.fetchExternalSources("workspace-1")).rejects.toThrow();
  });

  it("registers a source through the frozen create normalizer", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      source: sourceRecord(),
    });
    await externalSources.registerExternalSource({
      workspaceId: "workspace-1",
      expectedWorkspaceRevision: 3,
      kind: "codex_sessions",
      label: "Synthetic Codex source",
      canonicalRootPath: "/srv/synthetic/codex/sessions",
      pathBridgeSnapshotId: "path-bridge-1",
      pathBridgeSnapshotSha256: hash("2"),
      inputFlavor: "windows_native",
      targetFlavor: "windows_native",
      requireGitIdentity: false,
      acceptedProducerVersions: ["codex-synthetic-1"],
    });

    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/library/external-sources");
    expect(init?.method).toBe("POST");
    expect(body(init)).toMatchObject({ workspaceId: "workspace-1", kind: "codex_sessions" });
  });

  it("rejects a malformed registration before any request leaves the client", async () => {
    await expect(
      externalSources.registerExternalSource({
        workspaceId: "workspace-1",
        expectedWorkspaceRevision: 3,
        kind: "codex_sessions",
        label: "Bad",
        canonicalRootPath: "/srv/synthetic",
        pathBridgeSnapshotId: "path-bridge-1",
        pathBridgeSnapshotSha256: "not-a-hash",
        inputFlavor: "windows_native",
        targetFlavor: "windows_native",
        requireGitIdentity: false,
        acceptedProducerVersions: [],
      }),
    ).rejects.toThrow();
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("scans a source and pages its sealed catalog with disposition filters", async () => {
    apiMocks.request.mockResolvedValueOnce({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      scanId: "scan-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      configRevision: 1,
      configSha256: hash("1"),
      rootIdentitySha256: hash("2"),
      pathBridgeSnapshotSha256: hash("3"),
      adapterId: "codex.rollout-jsonl.v1",
      adapterVersion: "codex-fixture-1",
      manifestSha256: hash("4"),
      highWater: { observedMtimeNs: "01720800000000000000", itemId: "item-1" },
      examinedEntryCount: 4,
      itemCount: 1,
      supportedItemCount: 1,
      quarantinedItemCount: 0,
      blockerCodes: [],
      status: "sealed",
      startedAt: timestamp,
      completedAt: timestamp,
    });
    const scan = await externalSources.scanExternalSource("source-1", {
      workspaceId: "workspace-1",
      expectedRevision: 1,
    });
    expect(scan.status).toBe("sealed");
    let [path, init] = lastCall();
    expect(path).toBe("/api/v1/library/external-sources/source-1/scans");
    expect(init?.method).toBe("POST");
    expect(body(init)).toEqual({ workspaceId: "workspace-1", expectedRevision: 1 });

    apiMocks.request.mockResolvedValueOnce({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scanId: "scan-1",
      items: [],
      nextCursor: "cursor-1",
    });
    const page = await externalSources.fetchExternalSourceCatalogPage("source-1", {
      workspaceId: "workspace-1",
      scanId: "scan-1",
      dispositions: ["supported", "quarantined"],
      cursor: "cursor-0",
      limit: 25,
    });
    expect(page.nextCursor).toBe("cursor-1");
    [path, init] = lastCall();
    // The frozen contract normalizer sorts disposition filters canonically.
    expect(path).toBe(
      "/api/v1/library/external-sources/source-1/items?workspaceId=workspace-1&scanId=scan-1&dispositions=quarantined&dispositions=supported&cursor=cursor-0&limit=25",
    );
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("creates a dry-run plan and applies it with a generated durable idempotency key", async () => {
    apiMocks.request.mockResolvedValueOnce({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      plan: importPlan(),
      idempotencyKey: "external-source-import:v1:fixture",
    });
    const planned = await externalSources.createExternalSourceImportPlan({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scanId: "scan-1",
      selectedItemIds: ["item-1"],
      expectedRevision: 1,
    });
    expect(planned.plan.planSha256).toBe(hash("6"));
    let [path, init] = lastCall();
    expect(path).toBe("/api/v1/library/external-source-import-plans");
    expect(init?.method).toBe("POST");

    apiMocks.request.mockResolvedValueOnce({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      plan: importPlan(),
      intent: importIntent(),
      items: [importItem()],
      settlement: {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        settlementId: "settlement-1",
        workspaceId: "workspace-1",
        importId: "import-1",
        disposition: "applied",
        artifactSetSha256: hash("1"),
        artifactsVerifiedAt: timestamp,
        blockerCodes: [],
        resultSha256: hash("2"),
        settledAt: timestamp,
      },
      applyDisposition: "created",
    });
    const applied = await externalSources.applyExternalSourceImport({
      workspaceId: "workspace-1",
      planId: "plan-1",
      expectedPlanSha256: hash("6"),
    });
    expect(applied.applyDisposition).toBe("created");
    [path, init] = lastCall();
    expect(path).toBe("/api/v1/library/external-source-imports");
    const sent = body(init);
    expect(sent.expectedPlanSha256).toBe(hash("6"));
    expect(typeof sent.idempotencyKey).toBe("string");
    expect((sent.idempotencyKey as string).length).toBeGreaterThan(8);
  });

  it("reads content-free import provenance by exact id", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      plan: importPlan(),
      intent: importIntent(),
      items: [importItem()],
    });
    const detail = await externalSources.fetchExternalSourceImportDetail("workspace-1", "import-1");
    expect(detail.items[0]?.itemId).toBe("item-1");
    const [path] = lastCall();
    expect(path).toBe("/api/v1/library/external-source-imports/import-1?workspaceId=workspace-1");
  });
});

describe("external-sources Chat client", () => {
  it("lists session attachments against the C4 packet route path", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      items: [externalAttachment()],
    });
    const list = await externalSources.fetchExternalSessionAttachments("session-1", "workspace-1", 50);
    expect(list.items[0]?.mode).toBe("read_only_external");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/chat/sessions/session-1/external-source-attachments?workspaceId=workspace-1&limit=50");
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("surfaces the C4 list-carried session incarnation and rejects a malformed one", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sessionIncarnationId: "incarnation-live-1",
      items: [externalAttachment()],
    });
    const list = await externalSources.fetchExternalSessionAttachments("session-1", "workspace-1");
    expect(list.sessionIncarnationId).toBe("incarnation-live-1");

    // Pre-C4 producers omit the field entirely; that stays valid.
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      items: [],
    });
    const legacy = await externalSources.fetchExternalSessionAttachments("session-1", "workspace-1");
    expect(legacy.sessionIncarnationId).toBeUndefined();

    // A present-but-invalid incarnation is a malformed response the Chat hook
    // must never receive as a CAS precondition.
    for (const malformed of [42, "", "   ", "x".repeat(321), null]) {
      apiMocks.request.mockResolvedValue({
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        workspaceId: "workspace-1",
        sessionId: "session-1",
        sessionIncarnationId: malformed,
        items: [],
      });
      await expect(externalSources.fetchExternalSessionAttachments("session-1", "workspace-1")).rejects.toThrow(
        "malformed",
      );
    }
  });

  it("attaches with the exact C1 identifier-only body and refuses smuggled hashes", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      attachment: externalAttachment(),
      disposition: "created",
    });
    const attached = await externalSources.attachExternalSourceToSession({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedSessionIncarnationId: "incarnation-1",
      sourceId: "source-1",
      importId: "import-1",
      itemId: "item-1",
    });
    expect(attached.disposition).toBe("created");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/chat/sessions/session-1/external-source-attachments");
    expect(init?.method).toBe("POST");
    expect(Object.keys(body(init)).sort()).toEqual([
      "expectedSessionIncarnationId",
      "importId",
      "itemId",
      "sessionId",
      "sourceId",
      "workspaceId",
    ]);

    apiMocks.request.mockClear();
    await expect(
      externalSources.attachExternalSourceToSession({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        expectedSessionIncarnationId: "incarnation-1",
        sourceId: "source-1",
        importId: "import-1",
        itemId: "item-1",
        normalizedArtifactSha256: hash("9"),
      } as never),
    ).rejects.toThrow();
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("detaches with the exact CAS body on the attachment route", async () => {
    apiMocks.request.mockResolvedValue({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      attachment: {
        ...externalAttachment(),
        status: "detached",
        revision: 2,
        detachedByActorId: "operator-1",
        detachedAt: timestamp,
      },
      disposition: "detached",
    });
    const detached = await externalSources.detachExternalSourceAttachment({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attachmentId: "attachment-1",
      expectedRevision: 1,
      expectedSessionIncarnationId: "incarnation-1",
    });
    expect(detached.disposition).toBe("detached");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/chat/sessions/session-1/external-source-attachments/attachment-1");
    expect(init?.method).toBe("DELETE");
    expect(body(init)).toMatchObject({ attachmentId: "attachment-1", expectedRevision: 1 });
  });

  it("requests a knowledge snapshot with an identifier-only payload (content canary absent)", async () => {
    apiMocks.request.mockResolvedValue({ approval: { approvalId: "approval-1" } });
    const receipt = await externalSources.requestExternalSourceKnowledgeSnapshot({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      expectedSessionIncarnationId: "incarnation-1",
      attachmentId: "attachment-1",
      importId: "import-1",
      itemId: "item-1",
      expectedAttachmentRevision: 1,
    });
    expect(receipt.approvalId).toBe("approval-1");

    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/library/external-source-imports/import-1/knowledge-snapshot-requests");
    expect(init?.method).toBe("POST");
    const sent = body(init);
    expect(Object.keys(sent).sort()).toEqual([
      "attachmentId",
      "expectedAttachmentRevision",
      "expectedSessionIncarnationId",
      "importId",
      "itemId",
      "sessionId",
      "workspaceId",
    ]);
    // Canary: the request can never carry content bytes or client-supplied hashes.
    const raw = String(init?.body);
    expect(raw).not.toMatch(/[0-9a-f]{64}/u);
    expect(raw).not.toContain("content");
  });

  it("rejects a knowledge-snapshot request that smuggles a hash, before any request", async () => {
    await expect(
      externalSources.requestExternalSourceKnowledgeSnapshot({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        expectedSessionIncarnationId: "incarnation-1",
        attachmentId: "attachment-1",
        importId: "import-1",
        itemId: "item-1",
        expectedAttachmentRevision: 1,
        rawSha256: hash("2"),
      } as never),
    ).rejects.toThrow();
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("rejects an invalid session id before making any request", async () => {
    await expect(externalSources.fetchExternalSessionAttachments("bad session!", "workspace-1")).rejects.toThrow();
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("classifies a 404 as capability-absent so surfaces degrade instead of erroring", () => {
    const absent = new ApiRequestError("API error 404: not found", {
      kind: "http",
      method: "GET",
      path: "/api/v1/chat/sessions/session-1/external-source-attachments",
      status: 404,
    });
    expect(externalSources.isExternalSourceCapabilityAbsent(absent)).toBe(true);
    const denied = new ApiRequestError("API error 403: denied", {
      kind: "http",
      method: "GET",
      path: "/api/v1/chat/sessions/session-1/external-source-attachments",
      status: 403,
    });
    expect(externalSources.isExternalSourceCapabilityAbsent(denied)).toBe(false);
    expect(externalSources.isExternalSourceCapabilityAbsent(new Error("network"))).toBe(false);
  });
});
