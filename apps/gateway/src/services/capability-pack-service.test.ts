import { describe, expect, it, vi } from "vitest";
import type { CapabilityPackManifest, EvidenceEnvelope } from "@goatcitadel/contracts";
import { CapabilityPackService } from "./capability-pack-service.js";

describe("CapabilityPackService portable packs", () => {
  it("previews local portable skill/add-on bundles without auto-enabling risky assets", () => {
    const service = new CapabilityPackService({
      evidenceEnvelopeService: { createEnvelope: vi.fn() } as never,
    });

    const preview = service.previewLocalPack(localPackManifest());

    expect(preview.manifest.provenance).toMatchObject({
      source: "local_file",
      publisher: "Workspace Operator",
      contentHash: expect.any(String),
    });
    expect(preview.manifest.policyDefaults.autoRunEnabled).toBe(false);
    expect(preview.reviewRequired).toBe(true);
    expect(preview.installPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: "skill:triage", kind: "skill", outcome: "review_required" }),
        expect.objectContaining({ assetId: "addon:notes", kind: "addon", outcome: "review_required" }),
      ]),
    );
    expect(preview.manifest.assets[0]?.warnings).toEqual(
      expect.arrayContaining(["Portable skill/add-on assets are staged for review and are not auto-enabled."]),
    );
  });

  it("records evidence when a portable local pack is staged", () => {
    const createEnvelope = vi.fn(() => ({
      envelopeId: "env-local-pack",
      createdAt: "2026-05-31T00:00:00.000Z",
    }));
    const publishRealtime = vi.fn();
    const service = new CapabilityPackService({
      evidenceEnvelopeService: { createEnvelope } as never,
      publishRealtime,
    });

    const result = service.installLocalPack({
      actorId: "operator:test",
      manifest: localPackManifest(),
    });

    expect(result).toMatchObject({
      packId: "local-review-pack",
      actorId: "operator:test",
      evidenceEnvelopeId: "env-local-pack",
    });
    expect(result.stagedAssets.every((asset) => asset.outcome !== "enabled")).toBe(true);
    expect(createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "capability_pack_install",
        metadata: expect.objectContaining({
          packId: "local-review-pack",
          manifest: expect.objectContaining({ packId: "local-review-pack" }),
          reviewRequired: true,
          status: "staged_for_review",
          provenance: expect.objectContaining({ source: "local_file" }),
        }),
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "capability_pack_installed",
      "settings",
      expect.objectContaining({ packId: "local-review-pack", actorId: "operator:test" }),
    );
  });

  it("lists staged pack records from install evidence without activating assets", () => {
    const envelope = capabilityPackEnvelope({
      envelopeId: "env-local-pack",
      createdAt: "2026-05-31T00:00:00.000Z",
      metadata: {
        packId: "local-review-pack",
        actorId: "operator:test",
        name: "Local Review Pack",
        version: "1.0.0",
        trustTier: "community",
        reviewRequired: true,
        status: "staged_for_review",
        provenance: { source: "local_file", contentHash: "sha256:local" },
        installPlan: [{ assetId: "addon:notes", kind: "addon", outcome: "review_required", reason: "Review first" }],
        manifest: { ...localPackManifest(), provenance: { source: "local_file", publisher: "Workspace Operator" } },
      },
    });
    const service = new CapabilityPackService({
      evidenceEnvelopeService: {
        createEnvelope: vi.fn(),
        listEnvelopes: vi.fn(() => [envelope]),
      },
    });

    expect(service.listStagedPacks()).toEqual([
      expect.objectContaining({
        packId: "local-review-pack",
        status: "staged_for_review",
        reviewRequired: true,
        source: "local_file",
        evidenceEnvelopeId: "env-local-pack",
        stagedAssets: [{ assetId: "addon:notes", kind: "addon", outcome: "review_required", reason: "Review first" }],
      }),
    ]);
  });

  it("exports staged local manifests as read-only portable evidence", () => {
    const manifest = localPackManifest();
    const service = new CapabilityPackService({
      evidenceEnvelopeService: {
        createEnvelope: vi.fn(),
        listEnvelopes: vi.fn(() => [
          capabilityPackEnvelope({
            envelopeId: "env-export",
            metadata: {
              packId: manifest.packId,
              actorId: "operator:test",
              name: manifest.name,
              version: manifest.version,
              trustTier: manifest.trustTier,
              reviewRequired: true,
              status: "staged_for_review",
              provenance: { source: "local_file", contentHash: "sha256:local" },
              installPlan: [
                { assetId: "skill:triage", kind: "skill", outcome: "review_required", reason: "Review first" },
              ],
              manifest,
            },
          }),
        ]),
      },
    });

    expect(service.exportPack(manifest.packId)).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      manifest: expect.objectContaining({ packId: manifest.packId }),
      staged: expect.objectContaining({ evidenceEnvelopeId: "env-export" }),
      evidence: { source: "staged_evidence", evidenceEnvelopeId: "env-export" },
      limitations: expect.arrayContaining([
        "Capability pack export is read-only and does not install, enable, launch, or grant tools.",
      ]),
    });
  });

  it("exports bundled manifests without claiming staged evidence", () => {
    const service = new CapabilityPackService({
      evidenceEnvelopeService: {
        createEnvelope: vi.fn(),
        listEnvelopes: vi.fn(() => []),
      },
    });

    expect(service.exportPack("cowork-reliability")).toMatchObject({
      readOnly: true,
      mutationSemantics: "none",
      manifest: expect.objectContaining({ packId: "cowork-reliability" }),
      evidence: { source: "bundled_catalog" },
    });
  });

  it("rejects malformed portable pack manifests before staging", () => {
    const service = new CapabilityPackService({
      evidenceEnvelopeService: { createEnvelope: vi.fn() } as never,
    });

    expect(() =>
      service.previewLocalPack({
        ...localPackManifest(),
        provenance: { source: "bundled", publisher: "Not local" },
      }),
    ).toThrow("Portable capability pack manifests must use local_file provenance.");

    expect(() =>
      service.previewLocalPack({
        ...localPackManifest(),
        assets: [],
      }),
    ).toThrow("must declare at least one asset");
  });
});

function capabilityPackEnvelope(input: {
  envelopeId: string;
  createdAt?: string;
  metadata: Record<string, unknown>;
}): EvidenceEnvelope {
  return {
    envelopeId: input.envelopeId,
    eventKind: "capability_pack_install",
    contentHash: "sha256:content",
    payloadHash: "sha256:payload",
    toolCallHashes: [],
    memoryLineage: [],
    signatureStatus: "unsigned_local",
    metadata: input.metadata,
    createdAt: input.createdAt ?? "2026-05-31T00:00:00.000Z",
  };
}

function localPackManifest(): CapabilityPackManifest {
  return {
    packId: "local-review-pack",
    name: "Local Review Pack",
    description: "Portable local pack with one skill and one add-on.",
    version: "1.0.0",
    trustTier: "community",
    tags: ["local", "review"],
    assets: [
      {
        kind: "skill",
        id: "skill:triage",
        label: "Triage skill",
        runtimeSupport: "requires_configuration",
        installMode: "enabled",
      },
      {
        kind: "addon",
        id: "addon:notes",
        label: "Notes add-on",
        runtimeSupport: "requires_configuration",
        installMode: "enabled",
      },
    ],
    policyDefaults: {
      requireFirstUseApproval: true,
      memoryWriteAuthority: "operator_controlled",
      redactionMode: "strict",
      autoRunEnabled: true,
    },
    provenance: {
      source: "local_file",
      publisher: "Workspace Operator",
      reference: "local-review-pack.json",
    },
    installWarnings: ["Review this local pack before enabling assets."],
  };
}
