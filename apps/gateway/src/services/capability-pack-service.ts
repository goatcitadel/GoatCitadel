import type {
  CapabilityPackExportResponse,
  CapabilityPackInstallResult,
  CapabilityPackManifest,
  CapabilityPackMaterializationSummary,
  CapabilityPackMaterializeRequest,
  CapabilityPackMaterializeResult,
  CapabilityPackPreview,
  CapabilityPackStagedRecord,
  EvidenceEnvelope,
} from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";

export interface CapabilityPackInstallInput {
  actorId?: string;
}

export interface LocalCapabilityPackInput extends CapabilityPackInstallInput {
  manifest: CapabilityPackManifest;
}

export type CapabilityPackMaterializeInput = CapabilityPackMaterializeRequest;

export interface CapabilityPackServiceDependencies {
  evidenceEnvelopeService: Pick<EvidenceEnvelopeService, "createEnvelope" | "listEnvelopes">;
  publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;
}

const BUNDLED_PACKS: CapabilityPackManifest[] = [
  {
    packId: "browser-qa-operator",
    name: "Browser QA Operator Pack",
    description: "Review-first browser QA support for Cowork and Code runs.",
    version: "1.0.0",
    trustTier: "restricted",
    tags: ["qa", "browser", "cowork"],
    assets: [
      {
        kind: "mcp_template",
        id: "playwright",
        label: "Playwright Browser MCP",
        description: "Bundled MCP template for operator-approved browser automation.",
        runtimeSupport: hasMcpTemplate("playwright") ? "available" : "unsupported",
        installMode: "disabled",
        warnings: ["External tool server stays disabled until the operator validates and enables it."],
      },
      {
        kind: "skill",
        id: "browser-qa-operator",
        label: "Browser QA workflow skill",
        description: "Skill scaffold for browser proof, screenshots, and UI regression checks.",
        runtimeSupport: "requires_configuration",
        installMode: "disabled",
      },
      {
        kind: "runtime_preset",
        id: "cowork-run-map-browser-proof",
        label: "Run Map browser-proof preset",
        runtimeSupport: "available",
        installMode: "review_required",
      },
    ],
    policyDefaults: {
      requireFirstUseApproval: true,
      memoryWriteAuthority: "agent_proposals",
      redactionMode: "basic",
      autoRunEnabled: false,
    },
    provenance: {
      source: "bundled",
      publisher: "GoatCitadel",
      reference: "capability-packs/browser-qa-operator@1.0.0",
    },
    installWarnings: ["Pack installation does not auto-run browser tooling or enable external MCP servers."],
  },
  {
    packId: "cowork-reliability",
    name: "Cowork Reliability Pack",
    description: "Continuation gate, checkpoint, evidence, and run-map defaults for long Cowork runs.",
    version: "1.0.0",
    trustTier: "trusted",
    tags: ["cowork", "reliability", "evidence"],
    assets: [
      {
        kind: "runtime_preset",
        id: "continuation-gate-v1",
        label: "Continuation gate defaults",
        runtimeSupport: "available",
        installMode: "review_required",
      },
      {
        kind: "runtime_preset",
        id: "runtime-evidence-envelopes",
        label: "Runtime evidence envelopes",
        runtimeSupport: "available",
        installMode: "review_required",
      },
    ],
    policyDefaults: {
      requireFirstUseApproval: false,
      memoryWriteAuthority: "trusted_lifecycle_only",
      redactionMode: "basic",
      autoRunEnabled: false,
    },
    provenance: {
      source: "bundled",
      publisher: "GoatCitadel",
      reference: "capability-packs/cowork-reliability@1.0.0",
    },
    installWarnings: ["Review-required presets preserve the current runtime policy until explicitly enabled."],
  },
  {
    packId: "memory-governance",
    name: "Memory Governance Pack",
    description: "Memory write-gate defaults and evidence visibility for memory admin review.",
    version: "1.0.0",
    trustTier: "trusted",
    tags: ["memory", "trust", "admin"],
    assets: [
      {
        kind: "runtime_preset",
        id: "memory-write-gate-v1",
        label: "Memory write gate",
        runtimeSupport: "available",
        installMode: "review_required",
      },
      {
        kind: "runtime_preset",
        id: "memory-evidence-admin",
        label: "Memory evidence admin panel",
        runtimeSupport: "available",
        installMode: "review_required",
      },
    ],
    policyDefaults: {
      requireFirstUseApproval: false,
      memoryWriteAuthority: "agent_proposals",
      redactionMode: "strict",
      autoRunEnabled: false,
    },
    provenance: {
      source: "bundled",
      publisher: "GoatCitadel",
      reference: "capability-packs/memory-governance@1.0.0",
    },
    installWarnings: ["Agent and external memory writes stay proposals unless policy explicitly allows persistence."],
  },
];

export class CapabilityPackService {
  public constructor(private readonly deps: CapabilityPackServiceDependencies) {}

  public listPacks(): CapabilityPackManifest[] {
    return BUNDLED_PACKS.map((pack) => structuredClone(pack));
  }

  public previewPack(packId: string): CapabilityPackPreview {
    const manifest = this.requirePack(packId);
    return buildCapabilityPackPreview(manifest);
  }

  public previewLocalPack(manifest: CapabilityPackManifest): CapabilityPackPreview {
    return buildCapabilityPackPreview(normalizePortableCapabilityPackManifest(manifest));
  }

  public listStagedPacks(limit = 100): CapabilityPackStagedRecord[] {
    const envelopes = this.deps.evidenceEnvelopeService.listEnvelopes({
      limit: Math.max(1, Math.min(500, Math.floor(limit))),
    });
    const materializationsBySource = buildLatestMaterializationIndex(envelopes);
    return envelopes
      .filter((envelope) => envelope.eventKind === "capability_pack_install")
      .map((envelope) => readCapabilityPackStagedRecord(envelope, materializationsBySource.get(envelope.envelopeId)))
      .filter((record): record is CapabilityPackStagedRecord => Boolean(record))
      .sort((left, right) => right.stagedAt.localeCompare(left.stagedAt));
  }

  public exportPack(packId: string): CapabilityPackExportResponse {
    const staged = this.listStagedPacks(500).find((record) => record.packId === packId);
    const envelope = staged?.evidenceEnvelopeId
      ? this.deps.evidenceEnvelopeService
          .listEnvelopes({ limit: 500 })
          .find((item) => item.envelopeId === staged.evidenceEnvelopeId)
      : undefined;
    const manifest = readCapabilityPackManifestFromEnvelope(envelope) ?? this.requirePack(packId);
    return {
      exportedAt: new Date().toISOString(),
      readOnly: true,
      mutationSemantics: "none",
      manifest,
      staged,
      evidence: {
        source: staged ? "staged_evidence" : "bundled_catalog",
        evidenceEnvelopeId: staged?.evidenceEnvelopeId,
        contentHash: manifest.provenance.contentHash,
      },
      limitations: [
        "Capability pack export is read-only and does not install, enable, launch, or grant tools.",
        "Re-import uses the local portable pack preview/install path and remains staged for operator review.",
      ],
    };
  }

  public installPack(packId: string, input: CapabilityPackInstallInput = {}): CapabilityPackInstallResult {
    const preview = this.previewPack(packId);
    return this.stagePreview(preview, input);
  }

  public installLocalPack(input: LocalCapabilityPackInput): CapabilityPackInstallResult {
    const preview = this.previewLocalPack(input.manifest);
    return this.stagePreview(preview, input);
  }

  public materializeStagedPack(
    sourceEvidenceEnvelopeId: string,
    input: CapabilityPackMaterializeInput,
  ): CapabilityPackMaterializeResult {
    const envelope = this.requireStagedEnvelope(sourceEvidenceEnvelopeId);
    if (!input.confirmReview) {
      throw new Error("Capability pack materialization requires explicit operator review confirmation.");
    }
    const staged = readCapabilityPackStagedRecord(envelope);
    if (!staged) {
      throw new Error(`Capability pack staged evidence is incomplete: ${sourceEvidenceEnvelopeId}`);
    }
    const manifest = readCapabilityPackManifestFromEnvelope(envelope);
    if (!manifest) {
      throw new Error(`Capability pack staged manifest is unavailable: ${sourceEvidenceEnvelopeId}`);
    }
    const requestedAssetIds = normalizeRequestedAssetIds(
      input.assetIds,
      staged.stagedAssets.map((asset) => asset.assetId),
    );
    const assets = staged.stagedAssets.map((asset) => {
      const requested = requestedAssetIds.has(asset.assetId);
      if (!requested) {
        return {
          assetId: asset.assetId,
          kind: asset.kind,
          requested,
          outcome: "skipped" as const,
          reason: "Asset was not included in the operator materialization request.",
          callableState: "unchanged" as const,
          activationSemantics: "none" as const,
        };
      }
      if (asset.outcome === "unsupported") {
        return {
          assetId: asset.assetId,
          kind: asset.kind,
          requested,
          outcome: "blocked" as const,
          reason: "Runtime support is unavailable, so this asset remains blocked.",
          callableState: "unchanged" as const,
          activationSemantics: "blocked" as const,
        };
      }
      if (asset.kind === "runtime_preset") {
        return {
          assetId: asset.assetId,
          kind: asset.kind,
          requested,
          outcome: "evidence_recorded" as const,
          reason:
            "Runtime preset review was recorded as materialization evidence; runtime policy remains unchanged until an existing settings surface applies it.",
          callableState: "unchanged" as const,
          activationSemantics: "evidence_only" as const,
        };
      }
      return {
        assetId: asset.assetId,
        kind: asset.kind,
        requested,
        outcome: "review_recorded" as const,
        reason:
          "Operator review was recorded; activate this asset through its existing Skills, Add-ons, MCP, Plugins, or Tools surface.",
        callableState: "unchanged" as const,
        activationSemantics: "requires_existing_surface" as const,
      };
    });
    const actorId = input.actorId?.trim() || "operator";
    const envelopeResult = this.deps.evidenceEnvelopeService.createEnvelope({
      eventKind: "capability_pack_materialization",
      metadata: {
        packId: staged.packId,
        actorId,
        status: "materialization_recorded",
        sourceEvidenceEnvelopeId,
        sourceContentHash: staged.contentHash,
        name: staged.name,
        version: staged.version,
        trustTier: staged.trustTier,
        provenance: manifest.provenance,
        note: input.note?.trim() || undefined,
        assets,
        limitations: CAPABILITY_PACK_MATERIALIZATION_LIMITATIONS,
      },
    });
    const result: CapabilityPackMaterializeResult = {
      packId: staged.packId,
      actorId,
      materializedAt: envelopeResult.createdAt,
      status: "materialization_recorded",
      sourceEvidenceEnvelopeId,
      evidenceEnvelopeId: envelopeResult.envelopeId,
      assets,
      limitations: [...CAPABILITY_PACK_MATERIALIZATION_LIMITATIONS],
    };
    this.deps.publishRealtime?.("capability_pack_materialized", "settings", {
      packId: staged.packId,
      actorId,
      sourceEvidenceEnvelopeId,
      evidenceEnvelopeId: envelopeResult.envelopeId,
      assetCount: assets.filter((asset) => asset.requested).length,
    });
    return result;
  }

  private stagePreview(
    preview: CapabilityPackPreview,
    input: CapabilityPackInstallInput = {},
  ): CapabilityPackInstallResult {
    const actorId = input.actorId?.trim() || "operator";
    const envelope = this.deps.evidenceEnvelopeService.createEnvelope({
      eventKind: "capability_pack_install",
      metadata: {
        packId: preview.manifest.packId,
        actorId,
        trustTier: preview.manifest.trustTier,
        name: preview.manifest.name,
        version: preview.manifest.version,
        manifest: preview.manifest,
        reviewRequired: preview.reviewRequired,
        status: "staged_for_review",
        installPlan: preview.installPlan,
        provenance: preview.manifest.provenance,
      },
    });
    const result: CapabilityPackInstallResult = {
      packId: preview.manifest.packId,
      actorId,
      installedAt: envelope.createdAt,
      preview,
      stagedAssets: preview.installPlan,
      evidenceEnvelopeId: envelope.envelopeId,
    };
    this.deps.publishRealtime?.("capability_pack_installed", "settings", {
      packId: preview.manifest.packId,
      actorId,
      evidenceEnvelopeId: envelope.envelopeId,
      stagedAssets: result.stagedAssets,
    });
    return result;
  }

  private requirePack(packId: string): CapabilityPackManifest {
    const pack = BUNDLED_PACKS.find((item) => item.packId === packId);
    if (!pack) {
      throw new Error(`Unknown capability pack: ${packId}`);
    }
    return structuredClone(pack);
  }

  private requireStagedEnvelope(sourceEvidenceEnvelopeId: string): EvidenceEnvelope {
    const envelopeId = sourceEvidenceEnvelopeId.trim();
    if (!envelopeId) {
      throw new Error("Capability pack staged evidence id is required.");
    }
    const envelope = this.deps.evidenceEnvelopeService
      .listEnvelopes({ limit: 500 })
      .find((item) => item.envelopeId === envelopeId);
    if (!envelope || envelope.eventKind !== "capability_pack_install") {
      throw new Error(`Unknown staged capability pack evidence: ${envelopeId}`);
    }
    return envelope;
  }
}

const CAPABILITY_PACK_MATERIALIZATION_LIMITATIONS = [
  "Materialization records operator review evidence only; it does not grant tools, launch add-ons, call MCP servers, or enable skills.",
  "Assets that need runtime configuration must still be activated through their existing governed surface.",
  "Unsupported assets remain blocked even when included in a materialization request.",
];

function readCapabilityPackStagedRecord(
  envelope: EvidenceEnvelope,
  latestMaterialization?: CapabilityPackMaterializationSummary,
): CapabilityPackStagedRecord | undefined {
  const metadata = envelope.metadata;
  const packId = readString(metadata.packId);
  const actorId = readString(metadata.actorId);
  if (!packId || !actorId) {
    return undefined;
  }
  const manifest = readCapabilityPackManifestFromEnvelope(envelope);
  const provenance = readRecord(metadata.provenance);
  return {
    packId,
    name: readString(metadata.name) ?? manifest?.name ?? packId,
    version: readString(metadata.version) ?? manifest?.version ?? "unknown",
    trustTier: readTrustTier(metadata.trustTier) ?? manifest?.trustTier ?? "community",
    source: readProvenanceSource(provenance?.source) ?? manifest?.provenance.source ?? "local_file",
    actorId,
    stagedAt: envelope.createdAt,
    status: "staged_for_review",
    reviewRequired: readBoolean(metadata.reviewRequired) ?? true,
    stagedAssets: readInstallPlan(metadata.installPlan),
    evidenceEnvelopeId: envelope.envelopeId,
    contentHash: readString(provenance?.contentHash) ?? manifest?.provenance.contentHash,
    latestMaterialization,
  };
}

function buildLatestMaterializationIndex(
  envelopes: EvidenceEnvelope[],
): Map<string, CapabilityPackMaterializationSummary> {
  const bySource = new Map<string, CapabilityPackMaterializationSummary>();
  for (const envelope of envelopes) {
    if (envelope.eventKind !== "capability_pack_materialization") {
      continue;
    }
    const sourceEvidenceEnvelopeId = readString(envelope.metadata.sourceEvidenceEnvelopeId);
    const actorId = readString(envelope.metadata.actorId);
    const status = readMaterializationStatus(envelope.metadata.status);
    if (!sourceEvidenceEnvelopeId || !actorId || !status) {
      continue;
    }
    const assets = readMaterializedAssets(envelope.metadata.assets);
    const summary: CapabilityPackMaterializationSummary = {
      evidenceEnvelopeId: envelope.envelopeId,
      materializedAt: envelope.createdAt,
      actorId,
      status,
      assetCount: assets.filter((asset) => asset.requested).length,
    };
    const previous = bySource.get(sourceEvidenceEnvelopeId);
    if (!previous || previous.materializedAt.localeCompare(summary.materializedAt) < 0) {
      bySource.set(sourceEvidenceEnvelopeId, summary);
    }
  }
  return bySource;
}

function readCapabilityPackManifestFromEnvelope(
  envelope: EvidenceEnvelope | undefined,
): CapabilityPackManifest | undefined {
  const manifest = readRecord(envelope?.metadata.manifest);
  if (!manifest) {
    return undefined;
  }
  try {
    validateCapabilityPackManifest(manifest as unknown as CapabilityPackManifest);
    return structuredClone(manifest as unknown as CapabilityPackManifest);
  } catch {
    return undefined;
  }
}

function readInstallPlan(value: unknown): CapabilityPackPreview["installPlan"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = readRecord(item);
      const assetId = readString(record?.assetId);
      const kind = readAssetKind(record?.kind);
      const outcome = readInstallMode(record?.outcome);
      const reason = readString(record?.reason);
      if (!assetId || !kind || !outcome || !reason) {
        return undefined;
      }
      return { assetId, kind, outcome, reason };
    })
    .filter((item): item is CapabilityPackPreview["installPlan"][number] => Boolean(item));
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readTrustTier(value: unknown): CapabilityPackManifest["trustTier"] | undefined {
  return value === "trusted" || value === "restricted" || value === "community" ? value : undefined;
}

function readProvenanceSource(value: unknown): CapabilityPackManifest["provenance"]["source"] | undefined {
  return value === "bundled" || value === "local_file" ? value : undefined;
}

function readAssetKind(value: unknown): CapabilityPackPreview["installPlan"][number]["kind"] | undefined {
  return value === "skill" ||
    value === "addon" ||
    value === "mcp_template" ||
    value === "plugin" ||
    value === "runtime_preset"
    ? value
    : undefined;
}

function readInstallMode(value: unknown): CapabilityPackPreview["installPlan"][number]["outcome"] | undefined {
  return value === "enabled" || value === "disabled" || value === "review_required" || value === "unsupported"
    ? value
    : undefined;
}

function readMaterializationStatus(value: unknown): CapabilityPackMaterializationSummary["status"] | undefined {
  return value === "materialization_recorded" ? value : undefined;
}

function readMaterializedAssets(value: unknown): Array<{ requested: boolean }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = readRecord(item);
      const requested = record?.requested;
      return typeof requested === "boolean" ? { requested } : undefined;
    })
    .filter((item): item is { requested: boolean } => Boolean(item));
}

function normalizeRequestedAssetIds(input: string[] | undefined, knownAssetIds: string[]): Set<string> {
  const known = new Set(knownAssetIds);
  const requested = input?.length ? input.map((item) => item.trim()).filter(Boolean) : knownAssetIds;
  if (!requested.length) {
    throw new Error("Capability pack materialization requires at least one asset.");
  }
  const unknown = requested.filter((assetId) => !known.has(assetId));
  if (unknown.length) {
    throw new Error(`Capability pack materialization requested unknown assets: ${unknown.join(", ")}`);
  }
  return new Set(requested);
}

function hasMcpTemplate(templateId: string): boolean {
  return MCP_SERVER_TEMPLATES.some((template) => template.templateId === templateId);
}

function buildCapabilityPackPreview(manifest: CapabilityPackManifest): CapabilityPackPreview {
  validateCapabilityPackManifest(manifest);
  const unsupportedAssets = manifest.assets.filter((asset) => asset.runtimeSupport === "unsupported");
  const installPlan = manifest.assets.map((asset) => ({
    assetId: asset.id,
    kind: asset.kind,
    outcome: asset.runtimeSupport === "unsupported" ? ("unsupported" as const) : asset.installMode,
    reason:
      asset.runtimeSupport === "unsupported"
        ? "Runtime support is not available in this build."
        : asset.installMode === "enabled"
          ? "Asset can be enabled immediately by local policy."
          : asset.installMode === "disabled"
            ? "Asset is staged disabled for operator review."
            : "Asset requires explicit operator review before enablement.",
  }));
  return {
    manifest,
    unsupportedAssets,
    installPlan,
    policyChanges: manifest.policyDefaults,
    reviewRequired:
      unsupportedAssets.length > 0 ||
      installPlan.some((item) => item.outcome === "review_required" || item.outcome === "disabled"),
  };
}

function normalizePortableCapabilityPackManifest(manifest: CapabilityPackManifest): CapabilityPackManifest {
  validateCapabilityPackManifest(manifest);
  if (manifest.provenance.source !== "local_file") {
    throw new Error("Portable capability pack manifests must use local_file provenance.");
  }
  const normalized: CapabilityPackManifest = {
    ...structuredClone(manifest),
    policyDefaults: {
      ...manifest.policyDefaults,
      autoRunEnabled: false,
    },
    provenance: {
      ...manifest.provenance,
      contentHash: manifest.provenance.contentHash ?? hashManifest(manifest),
    },
    assets: manifest.assets.map((asset) => ({
      ...asset,
      installMode:
        asset.installMode === "enabled" && asset.kind !== "runtime_preset" ? "review_required" : asset.installMode,
      warnings: [
        ...(asset.warnings ?? []),
        ...(asset.installMode === "enabled" && asset.kind !== "runtime_preset"
          ? ["Portable skill/add-on assets are staged for review and are not auto-enabled."]
          : []),
      ],
    })),
    installWarnings: [
      ...manifest.installWarnings,
      "Portable local packs stage assets for operator review; they do not grant tools, bypass approvals, or make add-ons runnable automatically.",
    ],
  };
  return normalized;
}

function validateCapabilityPackManifest(manifest: CapabilityPackManifest): void {
  for (const field of ["packId", "name", "description", "version"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new Error(`Capability pack manifest ${field} is required.`);
    }
  }
  if (!["trusted", "restricted", "community"].includes(manifest.trustTier)) {
    throw new Error("Capability pack manifest trustTier is invalid.");
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error("Capability pack manifest must declare at least one asset.");
  }
  if (!manifest.provenance || !["bundled", "local_file"].includes(manifest.provenance.source)) {
    throw new Error("Capability pack manifest provenance source is invalid.");
  }
  if (!manifest.provenance.publisher?.trim()) {
    throw new Error("Capability pack manifest provenance publisher is required.");
  }
  for (const asset of manifest.assets) {
    if (!asset.id?.trim() || !asset.label?.trim()) {
      throw new Error("Capability pack assets require id and label.");
    }
    if (!["skill", "addon", "mcp_template", "plugin", "runtime_preset"].includes(asset.kind)) {
      throw new Error(`Capability pack asset ${asset.id} kind is invalid.`);
    }
    if (!["available", "requires_configuration", "unsupported"].includes(asset.runtimeSupport)) {
      throw new Error(`Capability pack asset ${asset.id} runtimeSupport is invalid.`);
    }
    if (!["enabled", "disabled", "review_required", "unsupported"].includes(asset.installMode)) {
      throw new Error(`Capability pack asset ${asset.id} installMode is invalid.`);
    }
  }
}

function hashManifest(manifest: CapabilityPackManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        packId: manifest.packId,
        version: manifest.version,
        assets: manifest.assets,
        policyDefaults: manifest.policyDefaults,
      }),
    )
    .digest("hex");
}
