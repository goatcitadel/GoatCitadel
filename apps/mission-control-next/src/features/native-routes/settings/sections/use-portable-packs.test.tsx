import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CapabilityPackManifest,
  CapabilityPackPreview,
  CapabilityPackStagedRecord,
  EvidenceEnvelope,
} from "@goatcitadel/contracts";
import { usePortablePacks } from "./use-portable-packs";
import { __resetPackAttemptsForTests } from "./pack-mutation-state";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";

const api = vi.hoisted(() => ({
  packs: vi.fn(),
  staged: vi.fn(),
  preview: vi.fn(),
  local: vi.fn(),
  stage: vi.fn(),
  stageLocal: vi.fn(),
  record: vi.fn(),
  evidence: vi.fn(),
  export: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchCapabilityPacks: api.packs,
  fetchStagedCapabilityPacks: api.staged,
  fetchCapabilityPackPreview: api.preview,
  fetchLocalCapabilityPackPreview: api.local,
  installCapabilityPack: api.stage,
  installLocalCapabilityPack: api.stageLocal,
  materializeStagedCapabilityPack: api.record,
  fetchEvidenceEnvelopes: api.evidence,
  exportCapabilityPack: api.export,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
const manifest: CapabilityPackManifest = {
  packId: "pack",
  name: "Reviewed pack",
  description: "A source fixture",
  version: "1.0.0",
  trustTier: "restricted",
  tags: ["proof"],
  assets: [
    {
      id: "one",
      label: "One asset",
      kind: "runtime_preset",
      runtimeSupport: "available",
      installMode: "review_required",
    },
  ],
  policyDefaults: {
    requireFirstUseApproval: true,
    memoryWriteAuthority: "operator_controlled",
    redactionMode: "strict",
    autoRunEnabled: false,
  },
  provenance: { source: "bundled", publisher: "Test fixture", contentHash: "a".repeat(64) },
  installWarnings: ["Review only"],
};
const preview: CapabilityPackPreview = {
  manifest,
  unsupportedAssets: [],
  installPlan: [{ assetId: "one", kind: "runtime_preset", outcome: "review_required", reason: "Requires review." }],
  policyChanges: manifest.policyDefaults,
  reviewRequired: true,
};
const timestamp = "2026-09-30T10:00:00.000Z";
let records: CapabilityPackStagedRecord[],
  envelopes: EvidenceEnvelope[],
  renderer: ReactTestRenderer | undefined,
  owner!: ReturnType<typeof usePortablePacks>;
function Harness({ workspaceId = "a" }: { workspaceId?: string }) {
  owner = usePortablePacks(workspaceId);
  return null;
}
async function mount(workspaceId = "a") {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Harness workspaceId={workspaceId} />
      </StrictMode>,
    );
  });
}
async function changeWorkspace(workspaceId: string) {
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Harness workspaceId={workspaceId} />
      </StrictMode>,
    ),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function stage(value = preview) {
  const receipt = {
    packId: value.manifest.packId,
    actorId: "operator",
    installedAt: timestamp,
    preview: structuredClone(value),
    stagedAssets: value.installPlan,
    evidenceEnvelopeId: "stage-1",
  };
  const item: CapabilityPackStagedRecord = {
    packId: receipt.packId,
    name: value.manifest.name,
    version: value.manifest.version,
    trustTier: value.manifest.trustTier,
    source: value.manifest.provenance.source,
    actorId: "operator",
    stagedAt: timestamp,
    status: "staged_for_review",
    reviewRequired: value.reviewRequired,
    stagedAssets: value.installPlan,
    evidenceEnvelopeId: receipt.evidenceEnvelopeId,
    contentHash: value.manifest.provenance.contentHash,
  };
  records.push(item);
  envelopes.push({
    envelopeId: receipt.evidenceEnvelopeId,
    eventKind: "capability_pack_install",
    createdAt: timestamp,
    contentHash: "b".repeat(64),
    payloadHash: "c".repeat(64),
    toolCallHashes: [],
    memoryLineage: [],
    signatureStatus: "unsigned_local",
    metadata: {
      packId: receipt.packId,
      actorId: "operator",
      trustTier: item.trustTier,
      name: item.name,
      version: item.version,
      manifest: value.manifest,
      reviewRequired: value.reviewRequired,
      status: "staged_for_review",
      installPlan: value.installPlan,
      provenance: value.manifest.provenance,
    },
  });
  return receipt;
}
const portable = { ...manifest, provenance: { ...manifest.provenance, source: "local_file" as const } };
const localPreview = { ...preview, manifest: portable };
async function inspect() {
  await act(async () => owner.open({ kind: "catalog", packId: manifest.packId }));
}
async function review() {
  await inspect();
  await act(async () => owner.requestStage());
}
async function localReview() {
  await act(async () => owner.open({ kind: "portable" }));
  await act(async () => owner.setSource(JSON.stringify(portable)));
  await act(async () => owner.previewLocal());
  await act(async () => owner.requestStage());
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetPackAttemptsForTests();
  __resetSessionDraftsForTests();
  records = [];
  envelopes = [];
  api.packs.mockResolvedValue({ items: [manifest] });
  api.staged.mockImplementation(async () => ({ items: structuredClone(records) }));
  api.preview.mockResolvedValue(preview);
  api.local.mockResolvedValue(localPreview);
  api.evidence.mockImplementation(async () => ({ items: structuredClone(envelopes) }));
  api.stage.mockImplementation(async () => stage());
  api.stageLocal.mockImplementation(async () => stage(localPreview));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

it("loads and previews without mutations, then confirms exact stage receipt and immutable evidence", async () => {
  await mount();
  await review();
  expect(api.stage).not.toHaveBeenCalled();
  await act(async () => {
    expect(await owner.confirm()).toBe(true);
  });
  expect(api.stage).toHaveBeenCalledExactlyOnceWith("pack", { actorId: "operator" });
  expect(api.preview).toHaveBeenCalledTimes(2);
  expect(owner.notice).toContain("exact evidence confirmed");
  expect(owner.attempt.phase).toBe("idle");
  expect(owner.data?.staged[0]?.evidenceEnvelopeId).toBe("stage-1");
});
it("requires explicit review after preview and never saves through draft leave", async () => {
  await mount();
  await localReview();
  await act(async () => owner.cancelReview());
  await act(async () => {
    expect(await owner.confirm()).toBe(false);
  });
  await act(async () => owner.open(null));
  expect(owner.leave.dialogProps.open).toBe(true);
  expect(api.stageLocal).not.toHaveBeenCalled();
  expect(owner.draft.isDirty).toBe(true);
});
it.each(["scope", "scope round trip", "unmount", "cancel", "source edit", "source round trip"])(
  "cancels local preflight on %s without staging",
  async (timing) => {
    await mount();
    await localReview();
    const wait = deferred<CapabilityPackPreview>();
    api.local.mockReturnValueOnce(wait.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = owner.confirm();
      await Promise.resolve();
    });
    if (timing.startsWith("scope")) {
      await changeWorkspace("b");
      if (timing.endsWith("round trip")) await changeWorkspace("a");
    } else if (timing === "unmount") {
      await act(async () => renderer!.unmount());
      renderer = undefined;
    } else if (timing === "cancel") await act(async () => owner.cancelReview());
    else {
      const source = owner.draft.value;
      await act(async () => owner.setSource(`${source} `));
      if (timing.endsWith("round trip")) await act(async () => owner.setSource(source));
    }
    await act(async () => {
      wait.resolve(localPreview);
      await pending;
    });
    expect(api.stageLocal).not.toHaveBeenCalled();
  },
);
it("rejects changed owner preview before dispatch", async () => {
  await mount();
  await review();
  api.preview.mockResolvedValueOnce({ ...preview, reviewRequired: false });
  await act(async () => {
    expect(await owner.confirm()).toBe(false);
  });
  expect(api.stage).not.toHaveBeenCalled();
  expect(owner.attempt.phase).toBe("idle");
  expect(owner.notice).toContain("preview changed");
});
it("admits one request and acknowledges the originating local draft after unmount", async () => {
  await mount();
  await localReview();
  const wait = deferred<ReturnType<typeof stage>>();
  api.stageLocal.mockReturnValueOnce(wait.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = owner.confirm();
    await Promise.resolve();
  });
  await act(async () => {
    expect(await owner.confirm()).toBe(false);
  });
  expect(api.stageLocal).toHaveBeenCalledTimes(1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => {
    wait.resolve(stage(localPreview));
    expect(await pending).toBe(true);
  });
  await mount();
  expect(owner.draft.isDirty).toBe(false);
  expect(owner.attempt.phase).toBe("idle");
});
it("preserves newer manifest input after a confirmed old write", async () => {
  await mount();
  await localReview();
  const wait = deferred<ReturnType<typeof stage>>();
  api.stageLocal.mockReturnValueOnce(wait.promise);
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = owner.confirm();
    await Promise.resolve();
  });
  await act(async () => owner.setSource("newer draft"));
  await act(async () => {
    wait.resolve(stage(localPreview));
    await pending;
  });
  expect(owner.draft.value).toBe("newer draft");
  expect(owner.draft.isDirty).toBe(true);
  expect(owner.attempt.phase).toBe("idle");
});
it.each(["transport", "postcommit 400", "foreign receipt", "redacted evidence", "missing readback"])(
  "retains installation-wide uncertainty for %s across workspace and remount",
  async (failure) => {
    await mount();
    await review();
    api.stage.mockImplementationOnce(async () => {
      if (failure === "transport") throw new Error("Connection lost");
      const result = stage();
      if (failure === "postcommit 400") throw { status: 400, body: { error: "realtime failed" } };
      if (failure === "foreign receipt") result.packId = "foreign";
      if (failure === "redacted evidence")
        envelopes[0]!.publicProjection = {
          metadataRedacted: true,
          redactedPaths: ["manifest"],
          canonicalHashesReferToStoredEnvelope: true,
        };
      if (failure === "missing readback") records = [];
      return result;
    });
    await act(async () => {
      expect(await owner.confirm()).toBe(false);
    });
    expect(owner.attempt.phase).toBe("uncertain");
    await changeWorkspace("b");
    await act(async () => owner.reload());
    expect(owner.locked).toBe(true);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    await mount("b");
    expect(owner.locked).toBe(true);
    expect(api.stage).toHaveBeenCalledTimes(1);
  },
);
it("withholds stale review evidence before materialization", async () => {
  stage();
  await mount();
  await act(async () => owner.requestRecord(records[0]!));
  records[0]!.latestMaterialization = {
    status: "materialization_recorded",
    materializedAt: timestamp,
    actorId: "peer",
    assetCount: 1,
  };
  await act(async () => {
    expect(await owner.confirm()).toBe(false);
  });
  expect(api.record).not.toHaveBeenCalled();
  expect(owner.attempt.phase).toBe("idle");
});
it("confirms materialization as review-only evidence with unchanged callable state", async () => {
  stage();
  await mount();
  await act(async () => owner.requestRecord(records[0]!));
  api.record.mockImplementationOnce(async () => {
    const saved = {
      packId: "pack",
      actorId: "operator",
      materializedAt: timestamp,
      status: "materialization_recorded" as const,
      sourceEvidenceEnvelopeId: "stage-1",
      evidenceEnvelopeId: "review-1",
      limitations: ["Review only"],
      assets: [
        {
          assetId: "one",
          kind: "runtime_preset" as const,
          requested: true,
          outcome: "evidence_recorded" as const,
          reason: "Runtime policy is unchanged",
          callableState: "unchanged" as const,
          activationSemantics: "evidence_only" as const,
        },
      ],
    };
    records[0]!.latestMaterialization = {
      evidenceEnvelopeId: "review-1",
      materializedAt: timestamp,
      status: saved.status,
      actorId: "operator",
      assetCount: 1,
    };
    envelopes.push({
      envelopeId: "review-1",
      eventKind: "capability_pack_materialization",
      createdAt: timestamp,
      contentHash: "c".repeat(64),
      payloadHash: "d".repeat(64),
      toolCallHashes: [],
      memoryLineage: [],
      signatureStatus: "unsigned_local",
      metadata: {
        packId: "pack",
        actorId: "operator",
        status: saved.status,
        sourceEvidenceEnvelopeId: "stage-1",
        sourceContentHash: manifest.provenance.contentHash,
        assets: saved.assets,
        limitations: saved.limitations,
      },
    });
    return saved;
  });
  await act(async () => {
    expect(await owner.confirm()).toBe(true);
  });
  expect(api.record).toHaveBeenCalledExactlyOnceWith("stage-1", {
    actorId: "operator",
    confirmReview: true,
    assetIds: ["one"],
    note: "Operator recorded reviewed pack evidence from Settings.",
  });
  expect(owner.notice).toContain("Callable state and runtime policy are unchanged");
  expect(owner.attempt.phase).toBe("idle");
});
it("rejects an export shadowed by a different staged manifest", async () => {
  await mount();
  await inspect();
  api.export.mockResolvedValueOnce({
    exportedAt: timestamp,
    readOnly: true,
    mutationSemantics: "none",
    manifest: { ...manifest, version: "2" },
    evidence: { source: "staged_evidence", contentHash: manifest.provenance.contentHash },
    limitations: [],
  });
  await act(async () => owner.exportPreview());
  expect(owner.exported).toBeNull();
  expect(owner.notice).toContain("newer staged manifest");
  expect(api.stage).not.toHaveBeenCalled();
});
it("does not let late file content overwrite newer typing or a closed inspector", async () => {
  await mount();
  await act(async () => owner.open({ kind: "portable" }));
  const wait = deferred<string>();
  const file = new File(["{}"], "pack.json");
  vi.spyOn(file, "text").mockReturnValue(wait.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = owner.importFile(file);
  });
  await act(async () => owner.setSource("new input"));
  await act(async () => {
    wait.resolve(JSON.stringify(portable));
    await pending;
  });
  expect(owner.draft.value).toBe("new input");
  expect(api.local).not.toHaveBeenCalled();
});
