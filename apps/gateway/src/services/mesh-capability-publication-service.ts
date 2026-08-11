/* eslint-disable max-lines -- Keep legacy and remote-worker publication authority decisions auditable in one owner. */
/**
 * HX-408 M1: the authenticated mesh capability publication owner.
 *
 * This service is the single gateway-side consumer of the durable HX-408
 * foundation (SQLite 168 / PostgreSQL 110 publication storage plus the
 * SQLite 169 / PostgreSQL 111 workspace-scoped node-admission authority). It
 * surfaces — never re-implements — the storage-enforced invariants:
 *
 * - Publisher identity comes exclusively from the durable admission row that
 *   binds the presented join-token digest (and its mTLS fingerprint binding),
 *   never from request bodies or headers a node could forge.
 * - Manifest publish is same-key/same-byte replayable, conflicts on changed
 *   bytes, and every malformed descriptor fails closed through the strict v1
 *   manifest contract before any durable write.
 * - A new publisher generation supersedes but never mutates prior
 *   generations; non-online health or a lost lease always forces a new
 *   generation instead of resuming an old one.
 * - The catalog projection is server-built: `review_required` on publish,
 *   `superseded` on new generations or manifest supersession, `offline` on
 *   node disconnect/health/lease loss, `revoked` on admission or health
 *   revocation, and `blocked` on certificate drift. Only exact activations
 *   that currently revalidate project as `active`/callable — published skill
 *   descriptors never do — so with no activation grants (M2) the callable
 *   projection is empty by construction.
 */
import { createHash } from "node:crypto";
import {
  ConflictError,
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST,
  NotFoundError,
  ValidationError,
  assertMeshCapabilityManifest,
  assertMeshCapabilityManifestEntry,
  canonicalJsonString,
  deriveMeshCapabilityId,
  normalizeRemoteWorkerMeshNodeAuthorityFence,
  type CapabilityCatalogEntry,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityCatalogEntryActivationProjection,
  type MeshCapabilityCatalogEntryProjection,
  type MeshCapabilityCatalogEntryStatus,
  type MeshCapabilityDescriptor,
  type MeshCapabilityKind,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
  type MeshCapabilityNodeAdmissionRecord,
  type MeshCapabilityPublisherGenerationRecord,
  type MeshCapabilityPublisherHealthRecord,
  type MeshLeaseRecord,
  type MeshNodeRecord,
  type RemoteWorkerMeshNodeAuthorityFence,
} from "@goatcitadel/contracts";
import {
  computeMeshCapabilityDescriptorSha256,
  computeMeshCapabilityEntrySha256,
  computeMeshCapabilityManifestSha256,
  type AsyncStorage as Storage,
} from "@goatcitadel/storage";
import { timingSafeStringEqual } from "./crypto-equals.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

export const MESH_NODE_TLS_FINGERPRINT_HEADER = "x-goatcitadel-mesh-tls-fingerprint";
const MESH_CAPABILITY_PUBLICATION_LEASE_PREFIX = "mesh-capability-publication";
const DEFAULT_PUBLICATION_LEASE_TTL_SECONDS = 600;
const DEFAULT_WORKSPACE_ID = "default";

/** Immutable, server-resolved identity of an authenticated admitted node. */
export interface MeshCapabilityAuthenticatedNodeIdentity {
  workspaceId: string;
  nodeId: string;
  admissionGeneration: number;
  mtlsRequired: boolean;
  tlsFingerprint?: string;
  provenance: "legacy" | "remote_worker";
  remoteWorkerAuthorityFence?: RemoteWorkerMeshNodeAuthorityFence;
}

export interface MeshCapabilityNodeAuthFailure {
  statusCode: 401 | 403 | 503;
  reason: string;
  message: string;
}

export interface MeshCapabilityManifestEntrySubmission {
  localId: string;
  kind: MeshCapabilityKind;
  descriptor: Record<string, unknown>;
  descriptorSha256: string;
}

export interface MeshCapabilityManifestPublishSubmission {
  publicationKey: string;
  supersedesManifestSha256?: string;
  entries: MeshCapabilityManifestEntrySubmission[];
}

export interface MeshCapabilityManifestPublishReceipt {
  replayed: boolean;
  manifest: MeshCapabilityManifest;
  entries: MeshCapabilityCatalogEntryProjection[];
}

export interface MeshCapabilityPublicationManifestView {
  publicationKey: string;
  manifestSha256: string;
  admissionGeneration: number;
  publisherGeneration: number;
  createdAt: string;
  supersedesManifestSha256?: string;
  supersededByManifestSha256?: string;
  entries: MeshCapabilityCatalogEntryProjection[];
}

export interface MeshCapabilityOwnPublicationList {
  workspaceId: string;
  nodeId: string;
  manifests: MeshCapabilityPublicationManifestView[];
}

export interface MeshCapabilityPublicationInspection {
  workspaceId: string;
  generatedAt: string;
  manifests: MeshCapabilityPublicationManifestView[];
}

/** Typed request failure the routes translate into an HTTP status. */
export class MeshCapabilityPublicationRequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "MeshCapabilityPublicationRequestError";
  }
}

export interface MeshCapabilityPublicationServiceOptions {
  storage: Storage;
  remoteWorkerAuthority?: MeshCapabilityRemoteWorkerAuthorityPort;
  now?: () => Date;
  leaseTtlSeconds?: number;
  publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<unknown>;
}

type Awaitable<T> = T | Promise<T>;

export interface MeshCapabilityRemoteWorkerAuthorityPort {
  resolveByRawMeshNodeCredential(rawMeshNodeCredential: string): Awaitable<
    | undefined
    | {
        readonly disposition: "legacy";
        readonly provenance: "legacy";
        readonly admission: {
          readonly workspaceId: string;
          readonly nodeId: string;
          readonly admissionGeneration: number;
          readonly joinCredentialSha256: string;
          readonly mtlsRequired: boolean;
          readonly tlsFingerprint?: string;
        };
      }
    | {
        readonly disposition: "current";
        readonly provenance: "remote_worker";
        readonly admission: {
          readonly workspaceId: string;
          readonly nodeId: string;
          readonly admissionGeneration: number;
          readonly mtlsRequired: true;
          readonly tlsFingerprint: string;
        };
        readonly fence: RemoteWorkerMeshNodeAuthorityFence;
      }
    | {
        readonly disposition: "unavailable";
        readonly provenance: "remote_worker";
        readonly reason: string;
      }
  >;
}

interface NodeProjectionFacts {
  currentAdmission?: MeshCapabilityNodeAdmissionRecord;
  publisher?: MeshCapabilityPublisherGenerationRecord;
  health?: MeshCapabilityPublisherHealthRecord;
  node?: MeshNodeRecord;
  lease?: MeshLeaseRecord;
  revokedAdmissionGenerations: Map<number, boolean>;
}

/** Per-projection cache of latest-activation facts, keyed by capability ID. */
interface ActivationProjectionFacts {
  latestByCapabilityId: Map<string, MeshCapabilityActivationRecord | undefined>;
  revokedByActivationId: Map<string, boolean>;
}

/**
 * Only the two exact paths below carry admitted-node credentials instead of
 * operator authority. The auth plugin defers those paths to the mesh-node
 * access class, whose enforcement calls `authenticateNodeRequest`.
 */
export function isMeshCapabilityNodePublicationPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/v1/mesh/capabilities/manifests" || pathname === "/api/v1/mesh/capabilities/manifests/self";
}

export class MeshCapabilityPublicationService {
  private readonly storage: Storage;
  private readonly now: () => Date;
  private readonly leaseTtlSeconds: number;
  private readonly remoteWorkerAuthority: MeshCapabilityRemoteWorkerAuthorityPort;
  private readonly publishRealtime?: (
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;

  public constructor(options: MeshCapabilityPublicationServiceOptions) {
    this.storage = options.storage;
    this.remoteWorkerAuthority = options.remoteWorkerAuthority ?? options.storage.remoteWorkerMeshNodeAdmissions;
    if (
      this.remoteWorkerAuthority === null ||
      (typeof this.remoteWorkerAuthority !== "object" && typeof this.remoteWorkerAuthority !== "function") ||
      typeof this.remoteWorkerAuthority.resolveByRawMeshNodeCredential !== "function"
    ) {
      throw new TypeError("Mesh remote-worker authority owner is unavailable.");
    }
    this.now = options.now ?? (() => new Date());
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_PUBLICATION_LEASE_TTL_SECONDS;
    this.publishRealtime = options.publishRealtime;
  }

  /**
   * Authenticates one admitted-node request from its bearer join token. The
   * resolved identity tuple comes exclusively from the durable admission
   * authority: workspace, node, admission generation, and mTLS binding are
   * read from the admission row bound to the presented token digest, and the
   * row must still be the node's current, unrevoked admission. Operator,
   * device, and companion credentials never satisfy this check.
   */
  public async authenticateNodeRequest(request: {
    headers: Record<string, string | string[] | undefined>;
    transportIdentity?: RemoteWorkerTransportIdentity;
  }): Promise<{ identity: MeshCapabilityAuthenticatedNodeIdentity } | MeshCapabilityNodeAuthFailure> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return {
        statusCode: 401,
        reason: "mesh_node_token_required",
        message: "Admitted mesh-node bearer credentials are required for this route.",
      };
    }
    const resolution = await this.remoteWorkerAuthority.resolveByRawMeshNodeCredential(token);
    if (resolution === undefined || resolution.disposition === "unavailable") {
      return unknownOrRevoked();
    }
    if (resolution.disposition === "current") {
      const current = resolution.admission;
      const fence = normalizeRemoteWorkerMeshNodeAuthorityFence(resolution.fence);
      const transport = request.transportIdentity;
      if (
        transport === undefined ||
        !isValidNativeTransportIdentity(transport) ||
        !timingSafeStringEqual(transport.certificateDerSha256, current.tlsFingerprint) ||
        fence.workspaceId !== current.workspaceId ||
        fence.nodeId !== current.nodeId ||
        fence.admissionGeneration !== current.admissionGeneration
      ) {
        return {
          statusCode: 503,
          reason: "mesh_node_native_mtls_required",
          message: "Remote-worker mesh publication requires the native mutual-TLS authority path.",
        };
      }
      return {
        identity: Object.freeze({
          workspaceId: current.workspaceId,
          nodeId: current.nodeId,
          admissionGeneration: current.admissionGeneration,
          mtlsRequired: true,
          tlsFingerprint: current.tlsFingerprint,
          provenance: "remote_worker",
          remoteWorkerAuthorityFence: fence,
        }),
      };
    }
    const current = resolution.admission;
    const tokenSha256 = sha256Hex(token);
    const legacyCurrent = await this.storage.meshCapabilityNodeAdmissions.findCurrent(
      current.workspaceId,
      current.nodeId,
    );
    if (
      legacyCurrent === undefined ||
      legacyCurrent.admissionGeneration !== current.admissionGeneration ||
      !timingSafeStringEqual(legacyCurrent.joinTokenSha256, tokenSha256) ||
      !timingSafeStringEqual(current.joinCredentialSha256, tokenSha256)
    ) {
      return unknownOrRevoked();
    }
    const presentedFingerprint = readHeaderValue(request.headers[MESH_NODE_TLS_FINGERPRINT_HEADER]);
    if (current.mtlsRequired) {
      if (
        !current.tlsFingerprint ||
        !presentedFingerprint ||
        !timingSafeStringEqual(presentedFingerprint, current.tlsFingerprint)
      ) {
        return {
          statusCode: 403,
          reason: "mesh_node_certificate_mismatch",
          message: "Admitted mesh-node TLS identity does not match its durable admission binding.",
        };
      }
    } else if (
      presentedFingerprint !== undefined &&
      (current.tlsFingerprint === undefined || !timingSafeStringEqual(presentedFingerprint, current.tlsFingerprint))
    ) {
      return {
        statusCode: 403,
        reason: "mesh_node_certificate_mismatch",
        message: "Presented mesh-node TLS identity does not match its durable admission binding.",
      };
    }
    return {
      identity: {
        workspaceId: current.workspaceId,
        nodeId: current.nodeId,
        admissionGeneration: current.admissionGeneration,
        mtlsRequired: current.mtlsRequired,
        ...(current.tlsFingerprint === undefined ? {} : { tlsFingerprint: current.tlsFingerprint }),
        provenance: "legacy",
      },
    };
  }

  /**
   * Publishes one strict v1 manifest for the authenticated node. Entries are
   * digest-verified against their submitted descriptor bytes, capability IDs
   * are server-derived, the publisher generation and lease fencing token are
   * server-resolved, and the immutable storage owner enforces replay,
   * conflict, cap, and supersession invariants.
   */
  public async publishCapabilityManifest(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    submission: MeshCapabilityManifestPublishSubmission,
  ): Promise<MeshCapabilityManifestPublishReceipt> {
    const entries = this.buildManifestEntries(identity.nodeId, submission.entries);
    const authorityFence = remoteWorkerAuthorityFence(identity);
    const replay =
      authorityFence === undefined
        ? await this.resolvePublicationKeyReplay(identity, submission, entries)
        : await this.resolveRemoteWorkerPublicationKeyReplay(authorityFence, identity, submission, entries);
    if (replay) {
      return { replayed: true, manifest: replay, entries: await this.projectManifestEntries(replay) };
    }
    const binding = await this.resolvePublisherBinding(identity);
    const unsigned = {
      schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
      workspaceId: identity.workspaceId,
      nodeId: identity.nodeId,
      admissionGeneration: binding.publisher.admissionGeneration,
      publisherGeneration: binding.publisher.publisherGeneration,
      publicationKey: submission.publicationKey,
      publicationLeaseFencingToken: binding.publisher.publicationLeaseFencingToken,
      ...(submission.supersedesManifestSha256 === undefined
        ? {}
        : { supersedesManifestSha256: submission.supersedesManifestSha256 }),
      entries,
      createdAt: this.nowIso(),
    };
    const manifest: MeshCapabilityManifest = {
      ...unsigned,
      manifestSha256: computeMeshCapabilityManifestSha256(unsigned),
    };
    assertMeshCapabilityManifest(manifest);
    const stored =
      authorityFence === undefined
        ? await this.storage.meshCapabilityPublications.publishManifest(manifest)
        : await this.storage.meshCapabilityPublications.publishRemoteWorkerManifest({ authorityFence, manifest });
    await this.publishRealtime?.("mesh_capability_manifest_published", "mesh", {
      workspaceId: stored.workspaceId,
      nodeId: stored.nodeId,
      publisherGeneration: stored.publisherGeneration,
      manifestSha256: stored.manifestSha256,
      publicationKey: stored.publicationKey,
      entryCount: stored.entries.length,
    });
    return { replayed: false, manifest: stored, entries: await this.projectManifestEntries(stored) };
  }

  /** Lists the authenticated node's own immutable manifests with statuses. */
  public async listOwnPublications(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
  ): Promise<MeshCapabilityOwnPublicationList> {
    return {
      workspaceId: identity.workspaceId,
      nodeId: identity.nodeId,
      manifests: await this.buildManifestViews(identity.workspaceId, identity.nodeId),
    };
  }

  /** Operator-only, read-only inspection of a workspace's publications. */
  public async listPublicationInspection(workspaceId: string): Promise<MeshCapabilityPublicationInspection> {
    return {
      workspaceId,
      generatedAt: this.nowIso(),
      manifests: await this.buildManifestViews(workspaceId),
    };
  }

  /**
   * The single server-built projection into the capability system. Every mesh
   * entry is inspectable with an explicit status; `callable` is true only for
   * exact active tool/MCP entries whose publisher generation and lease
   * revalidate right now, so it stays empty until governed activation (M2)
   * exists. Published skill descriptors never project as callable.
   */
  public async listCatalogEntries(workspaceId = DEFAULT_WORKSPACE_ID): Promise<CapabilityCatalogEntry[]> {
    const views = await this.buildManifestViews(workspaceId);
    const byCapabilityId = new Map<
      string,
      { projection: MeshCapabilityCatalogEntryProjection; title: string; summary: string }
    >();
    for (const view of views) {
      for (const projection of view.entries) {
        const existing = byCapabilityId.get(capabilityIdOf(projection));
        if (existing && existing.projection.status !== "superseded") {
          continue;
        }
        if (existing && projection.status === "superseded") {
          continue;
        }
        const descriptor = await this.findDescriptor(workspaceId, view, projection);
        byCapabilityId.set(capabilityIdOf(projection), {
          projection,
          title: descriptor?.title ?? projection.localId,
          summary:
            descriptor?.description ??
            `Mesh ${projection.capabilityKind.replace("_", " ")} published by node ${projection.nodeId}.`,
        });
      }
    }
    return [...byCapabilityId.entries()].map(([capabilityId, item]) =>
      buildCatalogEntry(capabilityId, item.projection, item.title, item.summary),
    );
  }

  private async findDescriptor(
    workspaceId: string,
    view: MeshCapabilityPublicationManifestView,
    projection: MeshCapabilityCatalogEntryProjection,
  ): Promise<MeshCapabilityDescriptor | undefined> {
    try {
      const manifest = await this.storage.meshCapabilityPublications.getManifest(
        workspaceId,
        projection.nodeId,
        projection.publisherGeneration,
        view.manifestSha256,
      );
      return manifest.entries.find((entry) => entry.entrySha256 === projection.entrySha256)?.descriptor;
    } catch {
      return undefined;
    }
  }

  private async buildManifestViews(
    workspaceId: string,
    nodeId?: string,
  ): Promise<MeshCapabilityPublicationManifestView[]> {
    const records = await this.storage.meshCapabilityPublications.listManifestRecords(workspaceId, {
      ...(nodeId === undefined ? {} : { nodeId }),
    });
    const callableIndex = await this.buildCallableIndex(workspaceId);
    const facts = new Map<string, NodeProjectionFacts>();
    const activationFacts = emptyActivationFacts();
    return await Promise.all(
      records.map(async (record) => ({
        publicationKey: record.manifest.publicationKey,
        manifestSha256: record.manifest.manifestSha256,
        admissionGeneration: record.manifest.admissionGeneration,
        publisherGeneration: record.manifest.publisherGeneration,
        createdAt: record.manifest.createdAt,
        ...(record.manifest.supersedesManifestSha256 === undefined
          ? {}
          : { supersedesManifestSha256: record.manifest.supersedesManifestSha256 }),
        ...(record.supersededByManifestSha256 === undefined
          ? {}
          : { supersededByManifestSha256: record.supersededByManifestSha256 }),
        entries: await Promise.all(
          record.manifest.entries.map(
            async (entry) =>
              await this.projectEntry(
                record.manifest,
                record.supersededByManifestSha256,
                entry,
                await this.resolveNodeFacts(facts, workspaceId, record.manifest.nodeId),
                callableIndex,
                activationFacts,
              ),
          ),
        ),
      })),
    );
  }

  private async projectManifestEntries(
    manifest: MeshCapabilityManifest,
  ): Promise<MeshCapabilityCatalogEntryProjection[]> {
    const record = (
      await this.storage.meshCapabilityPublications.listManifestRecords(manifest.workspaceId, {
        nodeId: manifest.nodeId,
      })
    ).find((candidate) => candidate.manifest.manifestSha256 === manifest.manifestSha256);
    const facts = new Map<string, NodeProjectionFacts>();
    const callableIndex = await this.buildCallableIndex(manifest.workspaceId);
    const activationFacts = emptyActivationFacts();
    return await Promise.all(
      manifest.entries.map(
        async (entry) =>
          await this.projectEntry(
            manifest,
            record?.supersededByManifestSha256,
            entry,
            await this.resolveNodeFacts(facts, manifest.workspaceId, manifest.nodeId),
            callableIndex,
            activationFacts,
          ),
      ),
    );
  }

  private async projectEntry(
    manifest: MeshCapabilityManifest,
    supersededByManifestSha256: string | undefined,
    entry: MeshCapabilityManifestEntry,
    facts: NodeProjectionFacts,
    callableIndex: Map<string, MeshCapabilityActivationRecord>,
    activationFacts: ActivationProjectionFacts,
  ): Promise<MeshCapabilityCatalogEntryProjection> {
    const activation = await this.resolveEntryActivationProjection(manifest, entry, activationFacts);
    const { status, reasons } = await this.resolveEntryStatus(
      manifest,
      supersededByManifestSha256,
      entry,
      facts,
      callableIndex,
      activation,
    );
    return {
      nodeId: manifest.nodeId,
      admissionGeneration: manifest.admissionGeneration,
      publisherGeneration: manifest.publisherGeneration,
      manifestSha256: manifest.manifestSha256,
      entrySha256: entry.entrySha256,
      localId: entry.localId,
      capabilityKind: entry.kind,
      status,
      reasons,
      effectPosture: entry.descriptor.effectPosture,
      ...(activation === undefined ? {} : { activation }),
    };
  }

  /**
   * HX-408 M2: latest governed-activation facts for this exact entry. The
   * annotation appears only when the workspace's latest activation for the
   * derived capability ID binds exactly this manifest/entry/generation; it is
   * evidence for the operator inspection surface, never callability truth.
   */
  private async resolveEntryActivationProjection(
    manifest: MeshCapabilityManifest,
    entry: MeshCapabilityManifestEntry,
    activationFacts: ActivationProjectionFacts,
  ): Promise<MeshCapabilityCatalogEntryActivationProjection | undefined> {
    if (!activationFacts.latestByCapabilityId.has(entry.capabilityId)) {
      activationFacts.latestByCapabilityId.set(
        entry.capabilityId,
        await this.storage.meshCapabilityPublications.findLatestActivation(manifest.workspaceId, entry.capabilityId),
      );
    }
    const latest = activationFacts.latestByCapabilityId.get(entry.capabilityId);
    if (
      !latest ||
      latest.manifestSha256 !== manifest.manifestSha256 ||
      latest.entrySha256 !== entry.entrySha256 ||
      latest.publisherGeneration !== manifest.publisherGeneration
    ) {
      return undefined;
    }
    if (!activationFacts.revokedByActivationId.has(latest.activationId)) {
      activationFacts.revokedByActivationId.set(
        latest.activationId,
        (await this.storage.meshCapabilityPublications.findActivationRevocation(
          manifest.workspaceId,
          latest.activationId,
        )) !== undefined,
      );
    }
    return {
      activationId: latest.activationId,
      activationRevision: latest.activationRevision,
      approvalId: latest.approvalId,
      revoked: activationFacts.revokedByActivationId.get(latest.activationId) === true,
    };
  }

  private async resolveEntryStatus(
    manifest: MeshCapabilityManifest,
    supersededByManifestSha256: string | undefined,
    entry: MeshCapabilityManifestEntry,
    facts: NodeProjectionFacts,
    callableIndex: Map<string, MeshCapabilityActivationRecord>,
    activationProjection?: MeshCapabilityCatalogEntryActivationProjection,
  ): Promise<{ status: MeshCapabilityCatalogEntryStatus; reasons: string[] }> {
    if (
      !facts.currentAdmission ||
      (await this.isAdmissionRevoked(manifest.workspaceId, manifest.nodeId, manifest.admissionGeneration, facts))
    ) {
      return { status: "revoked", reasons: ["node_admission_revoked"] };
    }
    const supersessionReasons: string[] = [];
    if (facts.publisher && manifest.publisherGeneration < facts.publisher.publisherGeneration) {
      supersessionReasons.push("publisher_generation_superseded");
    }
    if (supersededByManifestSha256 !== undefined) {
      supersessionReasons.push("manifest_superseded");
    }
    if (supersessionReasons.length > 0) {
      return { status: "superseded", reasons: supersessionReasons };
    }
    if (!facts.publisher || !facts.health) {
      return { status: "blocked", reasons: ["publication_state_unverifiable"] };
    }
    if (
      facts.publisher.mtlsRequired &&
      (!fingerprintEquals(facts.node?.tlsFingerprint, facts.publisher.tlsFingerprint) ||
        !fingerprintEquals(facts.health.tlsFingerprint, facts.publisher.tlsFingerprint))
    ) {
      return { status: "blocked", reasons: ["certificate_drift"] };
    }
    if (facts.health.status === "revoked") {
      return { status: "revoked", reasons: ["publisher_health_revoked"] };
    }
    if (facts.health.status !== "online") {
      return { status: "offline", reasons: [`publisher_health_${facts.health.status}`] };
    }
    if (!facts.node || facts.node.status !== "online") {
      return { status: "offline", reasons: ["node_disconnected"] };
    }
    const nowIso = this.nowIso();
    const leaseLive =
      facts.health.publicationLeaseExpiresAt > nowIso &&
      facts.lease !== undefined &&
      facts.lease.holderNodeId === manifest.nodeId &&
      facts.lease.fencingToken === facts.publisher.publicationLeaseFencingToken &&
      facts.lease.expiresAt > nowIso;
    if (!leaseLive) {
      return { status: "offline", reasons: ["publication_lease_expired"] };
    }
    const activation = callableIndex.get(
      callableKey(entry.capabilityId, entry.entrySha256, manifest.manifestSha256, manifest.publisherGeneration),
    );
    if (activation && entry.kind !== "skill") {
      return { status: "active", reasons: ["activation_live"] };
    }
    const reasons = ["operator_review_required"];
    if (activationProjection?.revoked === true) {
      reasons.push("activation_revoked");
    }
    if (entry.kind === "skill") {
      reasons.push("skill_descriptor_never_callable");
    }
    return { status: "review_required", reasons };
  }

  private async isAdmissionRevoked(
    workspaceId: string,
    nodeId: string,
    admissionGeneration: number,
    facts: NodeProjectionFacts,
  ): Promise<boolean> {
    const cached = facts.revokedAdmissionGenerations.get(admissionGeneration);
    if (cached !== undefined) {
      return cached;
    }
    let revoked = false;
    try {
      await this.storage.meshCapabilityNodeAdmissions.getRevocation(workspaceId, nodeId, admissionGeneration);
      revoked = true;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
    facts.revokedAdmissionGenerations.set(admissionGeneration, revoked);
    return revoked;
  }

  private async resolveNodeFacts(
    cache: Map<string, NodeProjectionFacts>,
    workspaceId: string,
    nodeId: string,
  ): Promise<NodeProjectionFacts> {
    const existing = cache.get(nodeId);
    if (existing) {
      return existing;
    }
    const publications = this.storage.meshCapabilityPublications;
    const currentAdmission = await this.storage.meshCapabilityNodeAdmissions.findCurrent(workspaceId, nodeId);
    const publisher = await publications.findCurrentPublisher(workspaceId, nodeId);
    const facts: NodeProjectionFacts = {
      ...(currentAdmission === undefined ? {} : { currentAdmission }),
      ...(publisher === undefined ? {} : { publisher }),
      revokedAdmissionGenerations: new Map(),
    };
    if (publisher) {
      try {
        facts.health = await publications.getPublisherHealth(workspaceId, nodeId, publisher.publisherGeneration);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      facts.lease = await this.tryGetLease(publisher.publicationLeaseKey);
    }
    try {
      facts.node = await this.storage.mesh.getNode(nodeId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    cache.set(nodeId, facts);
    return facts;
  }

  private async buildCallableIndex(workspaceId: string): Promise<Map<string, MeshCapabilityActivationRecord>> {
    const index = new Map<string, MeshCapabilityActivationRecord>();
    for (const activation of await this.storage.meshCapabilityPublications.listCallableActivations(workspaceId)) {
      index.set(
        callableKey(
          activation.capabilityId,
          activation.entrySha256,
          activation.manifestSha256,
          activation.publisherGeneration,
        ),
        activation,
      );
    }
    return index;
  }

  private buildManifestEntries(
    nodeId: string,
    submissions: MeshCapabilityManifestEntrySubmission[],
  ): MeshCapabilityManifestEntry[] {
    if (
      !Array.isArray(submissions) ||
      submissions.length < 1 ||
      submissions.length > MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST
    ) {
      throw new MeshCapabilityPublicationRequestError(
        400,
        "mesh_capability_manifest_entry_count",
        "Mesh capability manifests must contain between 1 and 128 entries.",
      );
    }
    const entries = submissions.map((submission) => {
      const descriptor = submission.descriptor as unknown as MeshCapabilityDescriptor;
      const computedDescriptorSha256 = computeMeshCapabilityDescriptorSha256(descriptor);
      if (submission.descriptorSha256 !== computedDescriptorSha256) {
        throw new MeshCapabilityPublicationRequestError(
          400,
          "mesh_capability_descriptor_digest_mismatch",
          `Mesh capability descriptor digest does not match the submitted bytes for ${submission.kind}:${submission.localId}.`,
        );
      }
      const capabilityId = deriveMeshCapabilityId(nodeId, submission.kind, submission.localId);
      const permissions = (descriptor as { permissions?: unknown }).permissions;
      const unsigned = {
        localId: submission.localId,
        kind: submission.kind,
        capabilityId,
        descriptor,
        descriptorSha256: computedDescriptorSha256,
        permissionEnvelopeSha256: computeMeshCapabilityDescriptorSha256(permissions),
      };
      const entry: MeshCapabilityManifestEntry = {
        ...unsigned,
        entrySha256: computeMeshCapabilityEntrySha256(unsigned),
      };
      // Deep-validate every kind-specific descriptor rule (unknown fields,
      // schema bombs, credential/URL smuggling, byte bounds) before any
      // publisher-binding write can happen for this request.
      assertMeshCapabilityManifestEntry(entry, nodeId);
      return entry;
    });
    // Server-side canonical ordering: the strict v1 manifest requires entries
    // sorted by exact kind/localId identity. Duplicate identities fail closed
    // here, before any durable write.
    const sorted = [...entries].sort((left, right) => {
      const leftIdentity = `${left.kind}:${left.localId}`;
      const rightIdentity = `${right.kind}:${right.localId}`;
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (previous.kind === current.kind && previous.localId === current.localId) {
        throw new MeshCapabilityPublicationRequestError(
          400,
          "mesh_capability_duplicate_entry",
          `Mesh capability manifest contains duplicate entry ${current.kind}:${current.localId}.`,
        );
      }
    }
    return sorted;
  }

  private async resolvePublicationKeyReplay(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    submission: MeshCapabilityManifestPublishSubmission,
    entries: MeshCapabilityManifestEntry[],
  ): Promise<MeshCapabilityManifest | undefined> {
    const existing = await this.storage.meshCapabilityPublications.getManifestByPublicationKey(
      identity.workspaceId,
      submission.publicationKey,
    );
    if (!existing) {
      return undefined;
    }
    const sameBytes =
      existing.nodeId === identity.nodeId &&
      existing.supersedesManifestSha256 === submission.supersedesManifestSha256 &&
      canonicalJsonString(existing.entries) === canonicalJsonString(entries);
    if (!sameBytes) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Mesh capability publication key was already used for different request bytes.",
      });
    }
    return existing;
  }

  private async resolveRemoteWorkerPublicationKeyReplay(
    authorityFence: RemoteWorkerMeshNodeAuthorityFence,
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    submission: MeshCapabilityManifestPublishSubmission,
    entries: MeshCapabilityManifestEntry[],
  ): Promise<MeshCapabilityManifest | undefined> {
    const publications = this.storage.meshCapabilityPublications as typeof this.storage.meshCapabilityPublications & {
      resolveRemoteWorkerManifestReplay(input: {
        readonly authorityFence: RemoteWorkerMeshNodeAuthorityFence;
        readonly workspaceId: string;
        readonly nodeId: string;
        readonly admissionGeneration: number;
        readonly publicationKey: string;
        readonly supersedesManifestSha256?: string;
        readonly entries: readonly MeshCapabilityManifestEntry[];
      }): Promise<MeshCapabilityManifest | undefined>;
    };
    return await publications.resolveRemoteWorkerManifestReplay({
      authorityFence,
      workspaceId: identity.workspaceId,
      nodeId: identity.nodeId,
      admissionGeneration: identity.admissionGeneration,
      publicationKey: submission.publicationKey,
      ...(submission.supersedesManifestSha256 === undefined
        ? {}
        : { supersedesManifestSha256: submission.supersedesManifestSha256 }),
      entries,
    });
  }

  private async resolvePublisherBinding(identity: MeshCapabilityAuthenticatedNodeIdentity): Promise<{
    publisher: MeshCapabilityPublisherGenerationRecord;
    health: MeshCapabilityPublisherHealthRecord;
  }> {
    const publications = this.storage.meshCapabilityPublications;
    const current = await publications.findCurrentPublisher(identity.workspaceId, identity.nodeId);
    const authorityFence = remoteWorkerAuthorityFence(identity);
    if (current && authorityFence === undefined) {
      const reused = await this.tryReuseCurrentGeneration(identity, current);
      if (reused) {
        return reused;
      }
    }
    const nextGeneration = (current?.publisherGeneration ?? 0) + 1;
    const leaseKey = `${MESH_CAPABILITY_PUBLICATION_LEASE_PREFIX}:${identity.workspaceId}:${identity.nodeId}`;
    const lease = await this.storage.mesh.acquireLease(leaseKey, identity.nodeId, this.leaseTtlSeconds, this.nowIso());
    const publisherInput = {
      workspaceId: identity.workspaceId,
      nodeId: identity.nodeId,
      admissionGeneration: identity.admissionGeneration,
      publisherGeneration: nextGeneration,
      mtlsRequired: identity.mtlsRequired,
      ...(identity.tlsFingerprint === undefined ? {} : { tlsFingerprint: identity.tlsFingerprint }),
      publicationLeaseKey: leaseKey,
      publicationLeaseFencingToken: lease.fencingToken,
      publicationLeaseExpiresAt: lease.expiresAt,
      idempotencyKey: `mesh-capability-publisher:${identity.workspaceId}:${identity.nodeId}:${nextGeneration}`,
    };
    const publisher =
      authorityFence === undefined
        ? await publications.registerPublisher(publisherInput)
        : await publications.registerRemoteWorkerPublisher({ authorityFence, publisher: publisherInput });
    return {
      publisher,
      health: await publications.getPublisherHealth(identity.workspaceId, identity.nodeId, nextGeneration),
    };
  }

  /**
   * Reuses the node's current publisher generation only while its identity
   * binding, online health, and fencing-token lease all still hold. Any
   * disqualifier (admission change, certificate drift, non-online health,
   * lost or re-fenced lease) falls through to a brand-new generation so a
   * reconnect can never resume a prior generation.
   */
  private async tryReuseCurrentGeneration(
    identity: MeshCapabilityAuthenticatedNodeIdentity,
    current: MeshCapabilityPublisherGenerationRecord,
  ): Promise<
    { publisher: MeshCapabilityPublisherGenerationRecord; health: MeshCapabilityPublisherHealthRecord } | undefined
  > {
    if (
      current.admissionGeneration !== identity.admissionGeneration ||
      current.mtlsRequired !== identity.mtlsRequired ||
      !fingerprintEquals(current.tlsFingerprint, identity.tlsFingerprint)
    ) {
      return undefined;
    }
    let health: MeshCapabilityPublisherHealthRecord;
    try {
      health = await this.storage.meshCapabilityPublications.getPublisherHealth(
        identity.workspaceId,
        identity.nodeId,
        current.publisherGeneration,
      );
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
    if (health.status !== "online") {
      return undefined;
    }
    const lease = await this.tryGetLease(current.publicationLeaseKey);
    if (
      !lease ||
      lease.holderNodeId !== identity.nodeId ||
      lease.fencingToken !== current.publicationLeaseFencingToken
    ) {
      return undefined;
    }
    const nowIso = this.nowIso();
    const extended =
      lease.expiresAt > nowIso
        ? await this.storage.mesh.renewLease(
            current.publicationLeaseKey,
            identity.nodeId,
            lease.fencingToken,
            this.leaseTtlSeconds,
            nowIso,
          )
        : await this.storage.mesh.acquireLease(
            current.publicationLeaseKey,
            identity.nodeId,
            this.leaseTtlSeconds,
            nowIso,
          );
    if (extended.fencingToken !== current.publicationLeaseFencingToken) {
      return undefined;
    }
    const refreshed = await this.storage.meshCapabilityPublications.refreshPublisherLease({
      workspaceId: identity.workspaceId,
      nodeId: identity.nodeId,
      publisherGeneration: current.publisherGeneration,
      expectedHealthGeneration: health.healthGeneration,
      publicationLeaseFencingToken: extended.fencingToken,
      publicationLeaseExpiresAt: extended.expiresAt,
    });
    return { publisher: current, health: refreshed };
  }

  private async tryGetLease(leaseKey: string): Promise<MeshLeaseRecord | undefined> {
    try {
      return await this.storage.mesh.getLease(leaseKey);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

/** Maps service failures onto the route contract without leaking internals. */
export function toMeshCapabilityPublicationHttpError(
  error: unknown,
): { statusCode: number; body: { error: string; reason?: string } } | undefined {
  if (error instanceof MeshCapabilityPublicationRequestError) {
    return { statusCode: error.statusCode, body: { error: error.message, reason: error.reason } };
  }
  if (error instanceof ConflictError) {
    return { statusCode: 409, body: { error: error.message } };
  }
  if (error instanceof ValidationError) {
    return { statusCode: 400, body: { error: error.message } };
  }
  if (error instanceof NotFoundError) {
    return { statusCode: 404, body: { error: error.message } };
  }
  if (error instanceof TypeError) {
    return { statusCode: 400, body: { error: error.message } };
  }
  return undefined;
}

function buildCatalogEntry(
  capabilityId: string,
  projection: MeshCapabilityCatalogEntryProjection,
  title: string,
  summary: string,
): CapabilityCatalogEntry {
  const callable = projection.status === "active" && projection.capabilityKind !== "skill";
  return {
    capabilityId,
    kind: catalogKindOf(projection.capabilityKind),
    category: "mesh_published",
    title,
    summary,
    callable,
    trustLabel: callable ? "Mesh activated" : "Mesh published (not callable)",
    ...(callable
      ? {}
      : {
          reviewWarning:
            projection.capabilityKind === "skill"
              ? "Published mesh skill descriptors are inspectable only; activation can only stage an inactive candidate for the governed skill lifecycle."
              : "Inspectable only until an operator-governed activation makes this exact entry callable.",
        }),
    mesh: projection,
  };
}

function catalogKindOf(kind: MeshCapabilityKind): CapabilityCatalogEntry["kind"] {
  return kind === "tool" ? "mesh_tool" : kind === "mcp_server" ? "mesh_mcp_server" : "mesh_skill";
}

function capabilityIdOf(projection: MeshCapabilityCatalogEntryProjection): string {
  return deriveMeshCapabilityId(projection.nodeId, projection.capabilityKind, projection.localId);
}

function emptyActivationFacts(): ActivationProjectionFacts {
  return { latestByCapabilityId: new Map(), revokedByActivationId: new Map() };
}

// NUL separator: capability IDs may contain arbitrary canonical-identifier
// characters, so a printable separator could be forged into an ambiguous
// composite key. Built via char code so no raw control byte sits in source.
const NUL_SEPARATOR = String.fromCharCode(0);

function callableKey(
  capabilityId: string,
  entrySha256: string,
  manifestSha256: string,
  publisherGeneration: number,
): string {
  return [capabilityId, entrySha256, manifestSha256, String(publisherGeneration)].join(NUL_SEPARATOR);
}

function fingerprintEquals(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return timingSafeStringEqual(left, right);
}

function remoteWorkerAuthorityFence(
  identity: MeshCapabilityAuthenticatedNodeIdentity,
): RemoteWorkerMeshNodeAuthorityFence | undefined {
  if (identity.provenance === "legacy") {
    if (identity.remoteWorkerAuthorityFence !== undefined) {
      throw new MeshCapabilityPublicationRequestError(
        403,
        "mesh_node_authority_mismatch",
        "Mesh-node publication authority is inconsistent.",
      );
    }
    return undefined;
  }
  const fence = normalizeRemoteWorkerMeshNodeAuthorityFence(identity.remoteWorkerAuthorityFence);
  if (
    fence.workspaceId !== identity.workspaceId ||
    fence.nodeId !== identity.nodeId ||
    fence.admissionGeneration !== identity.admissionGeneration ||
    identity.mtlsRequired !== true ||
    identity.tlsFingerprint === undefined
  ) {
    throw new MeshCapabilityPublicationRequestError(
      403,
      "mesh_node_authority_mismatch",
      "Mesh-node publication authority is inconsistent.",
    );
  }
  return fence;
}

function unknownOrRevoked(): MeshCapabilityNodeAuthFailure {
  return {
    statusCode: 403,
    reason: "mesh_node_unknown_or_revoked",
    message: "Mesh-node credentials are unknown, superseded, or revoked.",
  };
}

function readBearerToken(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(?<token>\S+)$/iu.exec(value.trim());
  const token = match?.groups?.token;
  return token && token.length <= 4096 ? token : undefined;
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 1024 ? trimmed : undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isValidNativeTransportIdentity(value: RemoteWorkerTransportIdentity): boolean {
  return (
    value.source === "native_mtls" &&
    Buffer.isBuffer(value.tlsExporter) &&
    value.tlsExporter.byteLength === 32 &&
    /^[0-9a-f]{64}$/u.test(value.certificateDerSha256) &&
    /^[0-9a-f]{64}$/u.test(value.publicKeySpkiSha256) &&
    /^[0-9a-f]{64}$/u.test(value.trustAnchorDerSha256) &&
    /^[0-9a-f]{64}$/u.test(value.tlsExporterSha256) &&
    timingSafeStringEqual(createHash("sha256").update(value.tlsExporter).digest("hex"), value.tlsExporterSha256)
  );
}
