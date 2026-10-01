import {
  canonicalJsonString,
  type CapabilityPackManifest,
  type CapabilityPackPreview,
  type CapabilityPackInstallResult,
  type CapabilityPackStagedRecord,
  type CapabilityPackMaterializeResult,
  type CapabilityPackExportResponse,
  type EvidenceEnvelope,
} from "@goatcitadel/contracts";

export const PACK_INPUT_LIMIT = 512_000;
export const PACK_ASSET_LIMIT = 1000;
export const PACK_EVIDENCE_LIMIT = 500;
export const samePackValue = (a: unknown, b: unknown) => canonicalJsonString(a) === canonicalJsonString(b);
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export function isPackManifest(value: unknown): value is CapabilityPackManifest {
  if (
    !object(value) ||
    !["packId", "name", "description", "version"].every((key) => text(value[key])) ||
    !["trusted", "restricted", "community"].includes(String(value.trustTier)) ||
    !strings(value.tags) ||
    !strings(value.installWarnings) ||
    !object(value.policyDefaults) ||
    !object(value.provenance) ||
    !["bundled", "local_file"].includes(String(value.provenance.source)) ||
    !text(value.provenance.publisher) ||
    !Array.isArray(value.assets) ||
    !value.assets.length ||
    value.assets.length > PACK_ASSET_LIMIT
  )
    return false;
  const policy = value.policyDefaults;
  return (
    typeof policy.requireFirstUseApproval === "boolean" &&
    typeof policy.autoRunEnabled === "boolean" &&
    ["trusted_lifecycle_only", "agent_proposals", "operator_controlled"].includes(
      String(policy.memoryWriteAuthority),
    ) &&
    ["none", "basic", "strict"].includes(String(policy.redactionMode)) &&
    value.assets.every(
      (asset) =>
        object(asset) &&
        text(asset.id) &&
        text(asset.label) &&
        ["skill", "addon", "mcp_template", "plugin", "runtime_preset"].includes(String(asset.kind)) &&
        ["available", "requires_configuration", "unsupported"].includes(String(asset.runtimeSupport)) &&
        ["enabled", "disabled", "review_required", "unsupported"].includes(String(asset.installMode)) &&
        (asset.warnings === undefined || strings(asset.warnings)),
    ) &&
    new Set(value.assets.map((asset) => asset.id)).size === value.assets.length
  );
}

export function parsePortablePack(source: string): CapabilityPackManifest {
  if (!source.trim() || source.length > PACK_INPUT_LIMIT)
    throw new Error("Choose a portable manifest of at most 512,000 characters.");
  const parsed: unknown = JSON.parse(source);
  if (!isPackManifest(parsed) || parsed.provenance.source !== "local_file")
    throw new Error(
      "A portable manifest needs local_file provenance, policy labels and 1–1,000 uniquely named assets.",
    );
  return parsed;
}

export function requirePackPreview(value: CapabilityPackPreview, packId: string, source: "bundled" | "local_file") {
  if (
    !value ||
    !isPackManifest(value.manifest) ||
    value.manifest.packId !== packId ||
    value.manifest.provenance.source !== source ||
    typeof value.reviewRequired !== "boolean" ||
    !Array.isArray(value.installPlan) ||
    !Array.isArray(value.unsupportedAssets) ||
    !samePackValue(value.policyChanges, value.manifest.policyDefaults) ||
    value.installPlan.length !== value.manifest.assets.length ||
    new Set(value.installPlan.map((item) => item.assetId)).size !== value.installPlan.length ||
    value.installPlan.some(
      (item) =>
        !value.manifest.assets.some((asset) => asset.id === item.assetId && asset.kind === item.kind) ||
        !["enabled", "disabled", "review_required", "unsupported"].includes(item.outcome) ||
        !text(item.reason),
    )
  )
    throw new Error("The Gateway preview does not match this pack or contains unsupported evidence.");
  return value;
}

function exactEnvelope(items: EvidenceEnvelope[], id: string, event: EvidenceEnvelope["eventKind"]) {
  const found = items.filter((item) => item.envelopeId === id);
  if (
    found.length !== 1 ||
    found[0]!.eventKind !== event ||
    found[0]!.publicProjection?.metadataRedacted ||
    found[0]!.workspaceId ||
    found[0]!.sessionId ||
    found[0]!.turnId ||
    found[0]!.runId
  )
    throw new Error("The exact installation evidence was unavailable, redacted or outside this bounded read.");
  return found[0]!;
}

export function assertPackStageReceipt(
  receipt: CapabilityPackInstallResult,
  preview: CapabilityPackPreview,
  prior: CapabilityPackStagedRecord[],
) {
  if (
    !receipt?.evidenceEnvelopeId ||
    prior.some((item) => item.evidenceEnvelopeId === receipt.evidenceEnvelopeId) ||
    receipt.packId !== preview.manifest.packId ||
    receipt.actorId !== "operator" ||
    !Number.isFinite(Date.parse(receipt.installedAt)) ||
    !samePackValue(receipt.preview, preview) ||
    !samePackValue(receipt.stagedAssets, preview.installPlan)
  )
    throw new Error("The staging receipt does not match the reviewed preview.");
}

export function assertPackStageReadback(
  receipt: CapabilityPackInstallResult,
  records: CapabilityPackStagedRecord[],
  envelopes: EvidenceEnvelope[],
) {
  const matches = records.filter((item) => item.evidenceEnvelopeId === receipt.evidenceEnvelopeId);
  const manifest = receipt.preview.manifest;
  if (
    matches.length !== 1 ||
    !samePackValue(matches[0], {
      packId: receipt.packId,
      name: manifest.name,
      version: manifest.version,
      trustTier: manifest.trustTier,
      source: manifest.provenance.source,
      actorId: receipt.actorId,
      stagedAt: receipt.installedAt,
      status: "staged_for_review",
      reviewRequired: receipt.preview.reviewRequired,
      stagedAssets: receipt.stagedAssets,
      evidenceEnvelopeId: receipt.evidenceEnvelopeId,
      contentHash: manifest.provenance.contentHash,
    })
  )
    throw new Error("The staged owner did not confirm this exact new evidence record.");
  const envelope = exactEnvelope(envelopes, receipt.evidenceEnvelopeId!, "capability_pack_install");
  if (
    envelope.createdAt !== receipt.installedAt ||
    !samePackValue(envelope.metadata, {
      packId: receipt.packId,
      actorId: receipt.actorId,
      trustTier: manifest.trustTier,
      name: manifest.name,
      version: manifest.version,
      manifest,
      reviewRequired: receipt.preview.reviewRequired,
      status: "staged_for_review",
      installPlan: receipt.stagedAssets,
      provenance: manifest.provenance,
    })
  )
    throw new Error("The immutable staging evidence does not confirm the returned manifest.");
}

export function assertPackMaterializationReceipt(
  receipt: CapabilityPackMaterializeResult,
  reviewed: CapabilityPackStagedRecord,
) {
  if (
    !receipt?.evidenceEnvelopeId ||
    receipt.evidenceEnvelopeId === reviewed.evidenceEnvelopeId ||
    receipt.sourceEvidenceEnvelopeId !== reviewed.evidenceEnvelopeId ||
    receipt.packId !== reviewed.packId ||
    receipt.actorId !== "operator" ||
    receipt.status !== "materialization_recorded" ||
    !Number.isFinite(Date.parse(receipt.materializedAt)) ||
    !strings(receipt.limitations) ||
    receipt.assets.length !== reviewed.stagedAssets.length ||
    new Set(receipt.assets.map((item) => item.assetId)).size !== receipt.assets.length ||
    receipt.assets.some((item) => {
      const original = reviewed.stagedAssets.find(
        (asset) => asset.assetId === item.assetId && asset.kind === item.kind,
      );
      const outcome =
        original?.outcome === "unsupported"
          ? "blocked"
          : original?.kind === "runtime_preset"
            ? "evidence_recorded"
            : "review_recorded";
      const semantics =
        outcome === "blocked"
          ? "blocked"
          : outcome === "evidence_recorded"
            ? "evidence_only"
            : "requires_existing_surface";
      return (
        !original ||
        !item.requested ||
        item.callableState !== "unchanged" ||
        item.outcome !== outcome ||
        item.activationSemantics !== semantics ||
        !text(item.reason)
      );
    })
  )
    throw new Error("The returned review evidence did not preserve unchanged capability authority.");
}

export function assertPackMaterializationReadback(
  receipt: CapabilityPackMaterializeResult,
  reviewed: CapabilityPackStagedRecord,
  records: CapabilityPackStagedRecord[],
  envelopes: EvidenceEnvelope[],
) {
  const found = records.filter((item) => item.evidenceEnvelopeId === reviewed.evidenceEnvelopeId);
  if (
    found.length !== 1 ||
    !samePackValue(found[0], {
      ...reviewed,
      latestMaterialization: {
        evidenceEnvelopeId: receipt.evidenceEnvelopeId,
        materializedAt: receipt.materializedAt,
        actorId: receipt.actorId,
        status: receipt.status,
        assetCount: receipt.assets.length,
      },
    })
  )
    throw new Error("The staged record does not confirm this review acknowledgement.");
  const envelope = exactEnvelope(envelopes, receipt.evidenceEnvelopeId!, "capability_pack_materialization");
  if (
    envelope.createdAt !== receipt.materializedAt ||
    envelope.metadata.packId !== reviewed.packId ||
    envelope.metadata.actorId !== receipt.actorId ||
    envelope.metadata.status !== receipt.status ||
    envelope.metadata.sourceEvidenceEnvelopeId !== reviewed.evidenceEnvelopeId ||
    envelope.metadata.sourceContentHash !== reviewed.contentHash ||
    !samePackValue(envelope.metadata.assets, receipt.assets) ||
    !samePackValue(envelope.metadata.limitations, receipt.limitations)
  )
    throw new Error("The immutable review envelope does not match its acknowledgement.");
}

export function assertPackExport(value: CapabilityPackExportResponse, manifest: CapabilityPackManifest) {
  if (
    !value ||
    value.readOnly !== true ||
    value.mutationSemantics !== "none" ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    !samePackValue(value.manifest, manifest) ||
    value.evidence.contentHash !== manifest.provenance.contentHash
  )
    throw new Error(
      "The current export belongs to a different staged manifest. Inspect the latest owner before exporting.",
    );
}
