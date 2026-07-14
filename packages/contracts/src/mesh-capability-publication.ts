import { canonicalJsonString } from "./canonical-json.js";

export const MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION = "goatcitadel.mesh-capability-manifest.v1" as const;
export const MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION = "goatcitadel.mesh-capability-permissions.v1" as const;
export const MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND = "mesh.capability.activate" as const;
export const MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION = "goatcitadel.mesh-capability-permission-diff.v1" as const;
export const MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION = "goatcitadel.mesh-capability-effect-diff.v1" as const;
export const MESH_CAPABILITY_HEALTH_CHECK_PROTOCOL = "mesh.capability-health.v1" as const;
export const MESH_CAPABILITY_MAX_PUBLISHERS_PER_WORKSPACE = 16;
export const MESH_CAPABILITY_MAX_ACTIVE_MANIFESTS_PER_PUBLISHER_GENERATION = 32;
export const MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST = 128;
export const MESH_CAPABILITY_MAX_ACTIVE_CALLABLES_PER_WORKSPACE = 256;
export const MESH_CAPABILITY_MAX_MANIFEST_BYTES = 512 * 1024;
export const MESH_CAPABILITY_MAX_DESCRIPTOR_BYTES = 64 * 1024;

export type MeshCapabilityKind = "tool" | "mcp_server" | "skill";
export type MeshCapabilityEffectPosture = "none" | "read_only" | "write_local" | "external_side_effect" | "unknown";
export type MeshCapabilityIdempotency = "none" | "keyed" | "intrinsic";
export type MeshCapabilityPublisherHealthStatus = "online" | "suspect" | "offline" | "revoked";
export type MeshCapabilitySettlementDisposition = "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown";
export type MeshCapabilityPermissionDiffDisposition = "initial" | "unchanged" | "narrowed" | "widened" | "mixed";
export type MeshCapabilityEffectDiffDisposition = "initial" | "unchanged" | "reduced" | "increased" | "changed";

export interface MeshCapabilityResourceLimits {
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

export interface MeshCapabilityHealthCheckContract {
  protocol: typeof MESH_CAPABILITY_HEALTH_CHECK_PROTOCOL;
  intervalMs: number;
  timeoutMs: number;
}

export interface MeshCapabilityPermissionEnvelope {
  schemaVersion: typeof MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION;
  filesystemRead: string[];
  filesystemWrite: string[];
  networkOrigins: string[];
  environmentNames: string[];
  deviceCapabilities: string[];
}

interface MeshCapabilityDescriptorBase {
  title: string;
  description?: string;
  semanticVersion: string;
  effectPosture: MeshCapabilityEffectPosture;
  permissions: MeshCapabilityPermissionEnvelope;
  resourceLimits: MeshCapabilityResourceLimits;
  healthCheck: MeshCapabilityHealthCheckContract;
}

export interface MeshToolCapabilityDescriptor extends MeshCapabilityDescriptorBase {
  kind: "tool";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  idempotency: MeshCapabilityIdempotency;
}

export interface MeshMcpServerCapabilityDescriptor extends MeshCapabilityDescriptorBase {
  kind: "mcp_server";
  protocol: "mcp";
  protocolVersion: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchemaSha256: string;
  }>;
}

export interface MeshSkillCapabilityDescriptor extends MeshCapabilityDescriptorBase {
  kind: "skill";
  manifestSha256: string;
  instructionsSha256: string;
  proofSha256: string;
}

export type MeshCapabilityDescriptor =
  | MeshToolCapabilityDescriptor
  | MeshMcpServerCapabilityDescriptor
  | MeshSkillCapabilityDescriptor;

export interface MeshCapabilityManifestEntry {
  localId: string;
  kind: MeshCapabilityKind;
  capabilityId: string;
  descriptor: MeshCapabilityDescriptor;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  entrySha256: string;
}

export interface MeshCapabilityManifest {
  schemaVersion: typeof MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION;
  workspaceId: string;
  nodeId: string;
  admissionGeneration: number;
  publisherGeneration: number;
  publicationKey: string;
  publicationLeaseFencingToken: number;
  supersedesManifestSha256?: string;
  entries: MeshCapabilityManifestEntry[];
  createdAt: string;
  manifestSha256: string;
}

export interface MeshCapabilityPublisherGenerationRecord {
  workspaceId: string;
  nodeId: string;
  admissionGeneration: number;
  publisherGeneration: number;
  tlsFingerprint?: string;
  mtlsRequired: boolean;
  publicationLeaseKey: string;
  publicationLeaseFencingToken: number;
  publicationLeaseExpiresAt: string;
  idempotencyKey: string;
  requestSha256: string;
  createdAt: string;
}

export interface MeshCapabilityPublisherHealthRecord {
  workspaceId: string;
  nodeId: string;
  publisherGeneration: number;
  healthGeneration: number;
  status: MeshCapabilityPublisherHealthStatus;
  publicationLeaseFencingToken: number;
  publicationLeaseExpiresAt: string;
  tlsFingerprint?: string;
  updatedAt: string;
}

export interface MeshCapabilityActivationRecord {
  workspaceId: string;
  activationId: string;
  activationRevision: number;
  capabilityId: string;
  nodeId: string;
  publisherGeneration: number;
  healthGeneration: number;
  publicationLeaseFencingToken: number;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  effectPosture: MeshCapabilityEffectPosture;
  permissionDiff: MeshCapabilityPermissionDiff;
  effectDiff: MeshCapabilityEffectDiff;
  approvalId: string;
  actorId: string;
  sessionId?: string;
  turnId?: string;
  idempotencyKey: string;
  requestSha256: string;
  createdAt: string;
}

export interface MeshCapabilityActivationApprovalPayload {
  workspaceId: string;
  activationId: string;
  activationRevision: number;
  requestSha256: string;
  capabilityId: string;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  effectPosture: MeshCapabilityEffectPosture;
}

export interface MeshCapabilityPermissionDiff {
  schemaVersion: typeof MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION;
  disposition: MeshCapabilityPermissionDiffDisposition;
  priorActivationId?: string;
  priorPermissionEnvelopeSha256?: string;
  currentPermissionEnvelopeSha256: string;
  added: string[];
  removed: string[];
}

export interface MeshCapabilityEffectDiff {
  schemaVersion: typeof MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION;
  disposition: MeshCapabilityEffectDiffDisposition;
  priorActivationId?: string;
  priorEffectPosture?: MeshCapabilityEffectPosture;
  currentEffectPosture: MeshCapabilityEffectPosture;
}

export interface MeshCapabilityActivationRevocationRecord {
  workspaceId: string;
  activationId: string;
  reason: string;
  actorId: string;
  idempotencyKey: string;
  requestSha256: string;
  revokedAt: string;
}

export interface MeshCapabilityInvocationIntentRecord {
  workspaceId: string;
  invocationId: string;
  activationId: string;
  activationRevision: number;
  capabilityId: string;
  nodeId: string;
  publisherGeneration: number;
  healthGeneration: number;
  publicationLeaseFencingToken: number;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  executionProfileSha256: string;
  inputSha256: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  approvalId?: string;
  deadlineAt: string;
  idempotencyKey: string;
  requestSha256: string;
  createdAt: string;
}

export interface MeshCapabilityInvocationSettlementRecord {
  workspaceId: string;
  invocationId: string;
  disposition: MeshCapabilitySettlementDisposition;
  outputSha256?: string;
  errorCode?: string;
  settlementSha256: string;
  effectiveCostAttributionSha256?: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
  idempotencyKey: string;
  requestSha256: string;
  settledAt: string;
}

export function deriveMeshCapabilityId(nodeId: string, kind: MeshCapabilityKind, localId: string): string {
  assertCanonicalIdentifier(nodeId, "nodeId", 128);
  assertMeshCapabilityLocalId(localId);
  assertEnum(kind, ["tool", "mcp_server", "skill"] as const, "kind");
  return `mesh:${nodeId}:${kind}:${localId}`;
}

export function assertMeshCapabilityManifest(manifest: MeshCapabilityManifest): void {
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "workspaceId",
      "nodeId",
      "admissionGeneration",
      "publisherGeneration",
      "publicationKey",
      "publicationLeaseFencingToken",
      "supersedesManifestSha256",
      "entries",
      "createdAt",
      "manifestSha256",
    ],
    "manifest",
    ["supersedesManifestSha256"],
  );
  if (manifest.schemaVersion !== MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError("Mesh capability manifest schemaVersion is unsupported.");
  }
  assertCanonicalIdentifier(manifest.workspaceId, "workspaceId", 256);
  assertCanonicalIdentifier(manifest.nodeId, "nodeId", 128);
  assertPositiveInteger(manifest.admissionGeneration, "admissionGeneration");
  assertPositiveInteger(manifest.publisherGeneration, "publisherGeneration");
  assertCanonicalIdentifier(manifest.publicationKey, "publicationKey", 512);
  assertPositiveInteger(manifest.publicationLeaseFencingToken, "publicationLeaseFencingToken");
  if (manifest.supersedesManifestSha256 !== undefined)
    assertSha256(manifest.supersedesManifestSha256, "supersedesManifestSha256");
  assertIsoTimestamp(manifest.createdAt, "createdAt");
  assertSha256(manifest.manifestSha256, "manifestSha256");
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length < 1 ||
    manifest.entries.length > MESH_CAPABILITY_MAX_ENTRIES_PER_MANIFEST
  ) {
    throw new TypeError("Mesh capability manifest entries must contain between 1 and 128 records.");
  }
  const identities = new Set<string>();
  let previousIdentity = "";
  for (const entry of manifest.entries) {
    assertMeshCapabilityManifestEntry(entry, manifest.nodeId);
    const identity = `${entry.kind}:${entry.localId}`;
    if (identities.has(identity)) throw new TypeError(`Mesh capability manifest contains duplicate entry ${identity}.`);
    if (previousIdentity && compareExactStrings(identity, previousIdentity) <= 0) {
      throw new TypeError("Mesh capability manifest entries must be sorted by exact kind/localId identity.");
    }
    identities.add(identity);
    previousIdentity = identity;
  }
  assertJsonBounds(manifest, MESH_CAPABILITY_MAX_MANIFEST_BYTES, "manifest");
}

export function assertMeshCapabilityManifestEntry(entry: MeshCapabilityManifestEntry, nodeId: string): void {
  assertExactKeys(
    entry,
    ["localId", "kind", "capabilityId", "descriptor", "descriptorSha256", "permissionEnvelopeSha256", "entrySha256"],
    "entry",
  );
  assertMeshCapabilityLocalId(entry.localId);
  assertEnum(entry.kind, ["tool", "mcp_server", "skill"] as const, "kind");
  if (entry.capabilityId !== deriveMeshCapabilityId(nodeId, entry.kind, entry.localId)) {
    throw new TypeError("Mesh capabilityId must be derived from the admitted node and exact entry identity.");
  }
  if (entry.descriptor.kind !== entry.kind)
    throw new TypeError("Mesh capability descriptor kind does not match the entry kind.");
  assertSha256(entry.descriptorSha256, "descriptorSha256");
  assertSha256(entry.permissionEnvelopeSha256, "permissionEnvelopeSha256");
  assertSha256(entry.entrySha256, "entrySha256");
  assertMeshCapabilityDescriptor(entry.descriptor);
}

export function assertMeshCapabilityDescriptor(descriptor: MeshCapabilityDescriptor): void {
  const baseKeys = [
    "kind",
    "title",
    "description",
    "semanticVersion",
    "effectPosture",
    "permissions",
    "resourceLimits",
    "healthCheck",
  ];
  if (descriptor.kind === "tool") {
    assertExactKeys(descriptor, [...baseKeys, "inputSchema", "outputSchema", "idempotency"], "tool descriptor", [
      "description",
    ]);
    assertJsonSchema(descriptor.inputSchema, "inputSchema");
    assertJsonSchema(descriptor.outputSchema, "outputSchema");
    assertEnum(descriptor.idempotency, ["none", "keyed", "intrinsic"] as const, "idempotency");
  } else if (descriptor.kind === "mcp_server") {
    assertExactKeys(descriptor, [...baseKeys, "protocol", "protocolVersion", "tools"], "MCP descriptor", [
      "description",
    ]);
    if (descriptor.protocol !== "mcp") throw new TypeError("Mesh MCP descriptor protocol must be mcp.");
    assertCanonicalIdentifier(descriptor.protocolVersion, "protocolVersion", 64);
    if (!Array.isArray(descriptor.tools) || descriptor.tools.length < 1 || descriptor.tools.length > 128) {
      throw new TypeError("Mesh MCP descriptor must contain between 1 and 128 bounded tool metadata records.");
    }
    const names = new Set<string>();
    for (const tool of descriptor.tools) {
      assertExactKeys(tool, ["name", "description", "inputSchemaSha256"], "MCP tool metadata", ["description"]);
      assertMeshCapabilityLocalId(tool.name);
      if (names.has(tool.name)) throw new TypeError(`Mesh MCP descriptor contains duplicate tool ${tool.name}.`);
      names.add(tool.name);
      if (tool.description !== undefined) assertSafeText(tool.description, "tool description", 1_000);
      assertSha256(tool.inputSchemaSha256, "inputSchemaSha256");
    }
  } else if (descriptor.kind === "skill") {
    assertExactKeys(
      descriptor,
      [...baseKeys, "manifestSha256", "instructionsSha256", "proofSha256"],
      "skill descriptor",
      ["description"],
    );
    assertSha256(descriptor.manifestSha256, "manifestSha256");
    assertSha256(descriptor.instructionsSha256, "instructionsSha256");
    assertSha256(descriptor.proofSha256, "proofSha256");
  } else {
    throw new TypeError("Mesh capability descriptor kind is unsupported.");
  }
  assertSafeText(descriptor.title, "title", 160);
  if (descriptor.description !== undefined) assertSafeText(descriptor.description, "description", 4_000);
  assertSemanticVersion(descriptor.semanticVersion);
  assertEnum(
    descriptor.effectPosture,
    ["none", "read_only", "write_local", "external_side_effect", "unknown"] as const,
    "effectPosture",
  );
  assertMeshCapabilityPermissions(descriptor.permissions);
  assertExactKeys(descriptor.resourceLimits, ["timeoutMs", "maxRequestBytes", "maxResponseBytes"], "resourceLimits");
  assertBoundedPositiveInteger(descriptor.resourceLimits.timeoutMs, "timeoutMs", 600_000);
  assertBoundedPositiveInteger(descriptor.resourceLimits.maxRequestBytes, "maxRequestBytes", 16 * 1024 * 1024);
  assertBoundedPositiveInteger(descriptor.resourceLimits.maxResponseBytes, "maxResponseBytes", 64 * 1024 * 1024);
  if (!isRecord(descriptor.healthCheck)) throw new TypeError("Mesh capability health check must be an object.");
  assertExactKeys(descriptor.healthCheck, ["protocol", "intervalMs", "timeoutMs"], "health check");
  if (descriptor.healthCheck.protocol !== MESH_CAPABILITY_HEALTH_CHECK_PROTOCOL) {
    throw new TypeError("Mesh capability health-check protocol is unsupported.");
  }
  assertBoundedPositiveInteger(descriptor.healthCheck.intervalMs, "health-check intervalMs", 3_600_000);
  assertBoundedPositiveInteger(descriptor.healthCheck.timeoutMs, "health-check timeoutMs", 600_000);
  if (descriptor.healthCheck.timeoutMs > descriptor.healthCheck.intervalMs) {
    throw new TypeError("Mesh capability health-check timeout cannot exceed its interval.");
  }
  assertNoCredentialOrDirectTransportFields(descriptor);
  assertJsonBounds(descriptor, MESH_CAPABILITY_MAX_DESCRIPTOR_BYTES, "descriptor");
}

export function assertMeshCapabilityPermissions(permissions: MeshCapabilityPermissionEnvelope): void {
  assertExactKeys(
    permissions,
    ["schemaVersion", "filesystemRead", "filesystemWrite", "networkOrigins", "environmentNames", "deviceCapabilities"],
    "permission envelope",
  );
  if (permissions.schemaVersion !== MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION)
    throw new TypeError("Mesh capability permission schemaVersion is unsupported.");
  assertStringArray(permissions.filesystemRead, "filesystemRead", 64, 512);
  assertStringArray(permissions.filesystemWrite, "filesystemWrite", 64, 512);
  assertStringArray(permissions.environmentNames, "environmentNames", 64, 128);
  assertStringArray(permissions.deviceCapabilities, "deviceCapabilities", 64, 128);
  assertStringArray(permissions.networkOrigins, "networkOrigins", 64, 512);
  for (const origin of permissions.networkOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError("Mesh capability network origins must be absolute origins.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== origin
    ) {
      throw new TypeError("Mesh capability network origins must be credential-free exact HTTP(S) origins.");
    }
  }
}

export function assertMeshCallableKind(kind: MeshCapabilityKind): asserts kind is "tool" | "mcp_server" {
  if (kind === "skill")
    throw new TypeError("Published mesh skill descriptors are inspectable only and can never be callable.");
  if (kind !== "tool" && kind !== "mcp_server") throw new TypeError("Mesh capability kind is unsupported.");
}

export function assertMeshCapabilityPermissionDiff(
  diff: MeshCapabilityPermissionDiff,
  currentPermissionEnvelopeSha256: string,
): void {
  assertExactKeys(
    diff,
    [
      "schemaVersion",
      "disposition",
      "priorActivationId",
      "priorPermissionEnvelopeSha256",
      "currentPermissionEnvelopeSha256",
      "added",
      "removed",
    ],
    "permission diff",
    ["priorActivationId", "priorPermissionEnvelopeSha256"],
  );
  if (diff.schemaVersion !== MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION) {
    throw new TypeError("Mesh capability permission diff schemaVersion is unsupported.");
  }
  assertEnum(
    diff.disposition,
    ["initial", "unchanged", "narrowed", "widened", "mixed"] as const,
    "permission diff disposition",
  );
  assertSha256(diff.currentPermissionEnvelopeSha256, "currentPermissionEnvelopeSha256");
  if (diff.currentPermissionEnvelopeSha256 !== currentPermissionEnvelopeSha256) {
    throw new TypeError("Mesh capability permission diff is not bound to the activated envelope.");
  }
  assertStringArray(diff.added, "permission diff added", 320, 640);
  assertStringArray(diff.removed, "permission diff removed", 320, 640);
  assertStrictlySortedStrings(diff.added, "permission diff added");
  assertStrictlySortedStrings(diff.removed, "permission diff removed");
  const removed = new Set(diff.removed);
  if (diff.added.some((value) => removed.has(value))) {
    throw new TypeError("Mesh capability permission diff cannot add and remove the same grant.");
  }
  const hasPriorId = diff.priorActivationId !== undefined;
  const hasPriorHash = diff.priorPermissionEnvelopeSha256 !== undefined;
  if (hasPriorId !== hasPriorHash || (diff.disposition === "initial") !== !hasPriorId) {
    throw new TypeError("Mesh capability permission diff prior binding is inconsistent.");
  }
  if (diff.priorActivationId !== undefined) assertCanonicalIdentifier(diff.priorActivationId, "priorActivationId", 256);
  if (diff.priorPermissionEnvelopeSha256 !== undefined)
    assertSha256(diff.priorPermissionEnvelopeSha256, "priorPermissionEnvelopeSha256");
  const expectedShape =
    diff.disposition === "initial" || diff.disposition === "unchanged"
      ? diff.added.length === 0 && diff.removed.length === 0
      : diff.disposition === "narrowed"
        ? diff.added.length === 0 && diff.removed.length > 0
        : diff.disposition === "widened"
          ? diff.added.length > 0 && diff.removed.length === 0
          : diff.added.length > 0 && diff.removed.length > 0;
  if (!expectedShape) {
    throw new TypeError("Mesh capability permission diff disposition does not match its exact change shape.");
  }
}

export function assertMeshCapabilityEffectDiff(
  diff: MeshCapabilityEffectDiff,
  currentEffectPosture: MeshCapabilityEffectPosture,
): void {
  assertExactKeys(
    diff,
    ["schemaVersion", "disposition", "priorActivationId", "priorEffectPosture", "currentEffectPosture"],
    "effect diff",
    ["priorActivationId", "priorEffectPosture"],
  );
  if (diff.schemaVersion !== MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION) {
    throw new TypeError("Mesh capability effect diff schemaVersion is unsupported.");
  }
  assertEnum(
    diff.disposition,
    ["initial", "unchanged", "reduced", "increased", "changed"] as const,
    "effect diff disposition",
  );
  assertEnum(
    diff.currentEffectPosture,
    ["none", "read_only", "write_local", "external_side_effect", "unknown"] as const,
    "currentEffectPosture",
  );
  if (diff.currentEffectPosture !== currentEffectPosture)
    throw new TypeError("Mesh capability effect diff is not bound to the activated posture.");
  const hasPriorId = diff.priorActivationId !== undefined;
  const hasPriorEffect = diff.priorEffectPosture !== undefined;
  if (hasPriorId !== hasPriorEffect || (diff.disposition === "initial") !== !hasPriorId) {
    throw new TypeError("Mesh capability effect diff prior binding is inconsistent.");
  }
  if (diff.priorActivationId !== undefined) assertCanonicalIdentifier(diff.priorActivationId, "priorActivationId", 256);
  if (diff.priorEffectPosture !== undefined) {
    assertEnum(
      diff.priorEffectPosture,
      ["none", "read_only", "write_local", "external_side_effect", "unknown"] as const,
      "priorEffectPosture",
    );
  }
  const expectedDisposition = expectedEffectDiffDisposition(diff.priorEffectPosture, diff.currentEffectPosture);
  if (diff.disposition !== expectedDisposition) {
    throw new TypeError("Mesh capability effect diff disposition does not match the exact posture transition.");
  }
}

export function isCanonicalMeshCapabilityJson(value: unknown, encoded: string): boolean {
  return canonicalJsonString(value) === encoded;
}

function assertMeshCapabilityLocalId(value: string): void {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC") ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(value)
  ) {
    throw new TypeError("Mesh capability localId must be a canonical lower-case safe name.");
  }
}

function assertJsonSchema(value: Record<string, unknown>, field: string): void {
  if (!isRecord(value) || Array.isArray(value))
    throw new TypeError(`Mesh capability ${field} must be a JSON Schema object.`);
  if (Object.keys(value).length === 0) throw new TypeError(`Mesh capability ${field} cannot be empty.`);
  if (value.$schema !== undefined && value.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new TypeError(`Mesh capability ${field} uses an unsupported JSON Schema dialect.`);
  }
  assertNoCredentialOrDirectTransportFields(value);
  assertJsonBounds(value, 32 * 1024, field);
}

function assertNoCredentialOrDirectTransportFields(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "string") {
    if (
      /(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu.test(value) ||
      /https?:\/\/[^/\s:@]+:[^/\s@]+@/iu.test(value) ||
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(value) ||
      /\bsk-[A-Za-z0-9_-]{12,}\b/u.test(value)
    ) {
      throw new TypeError("Mesh capability descriptors cannot contain embedded credential material.");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError("Mesh capability descriptors cannot contain cyclic values.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertNoCredentialOrDirectTransportFields(child, seen);
    seen.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:url|uri|endpoint|transport|command|shell|executable|auth|authorization|credential|password|secret|token|api[_-]?key|private[_-]?key|cookie|bearer)/iu.test(
        key,
      )
    ) {
      throw new TypeError(`Mesh capability descriptors cannot publish direct transport or credential field ${key}.`);
    }
    if (key === "$ref" && typeof child === "string" && /^[a-z][a-z0-9+.-]*:/iu.test(child)) {
      throw new TypeError("Mesh capability JSON Schemas cannot resolve external references.");
    }
    assertNoCredentialOrDirectTransportFields(child, seen);
  }
  seen.delete(value);
}

function assertJsonBounds(value: unknown, maxBytes: number, field: string): void {
  assertBoundedJsonTree(value, field);
  const encoded = canonicalJsonString(value);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes)
    throw new TypeError(`Mesh capability ${field} exceeds its byte limit.`);
}

function assertBoundedJsonTree(value: unknown, field: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 10_000 || current.depth > 32) {
      throw new TypeError(`Mesh capability ${field} exceeds its structural bounds.`);
    }
    if (current.value === null || ["string", "boolean"].includes(typeof current.value)) continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value))
        throw new TypeError(`Mesh capability ${field} contains a non-finite number.`);
      continue;
    }
    if (typeof current.value !== "object") throw new TypeError(`Mesh capability ${field} contains a non-JSON value.`);
    if (seen.has(current.value)) throw new TypeError(`Mesh capability ${field} must be an acyclic JSON tree.`);
    seen.add(current.value);
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
}

function assertCanonicalIdentifier(value: string, field: string, max: number): void {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Mesh capability ${field} is not a canonical identifier.`);
  }
}

function assertStringArray(value: string[], field: string, maxItems: number, maxLength: number): void {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new TypeError(`Mesh capability ${field} exceeds its item limit.`);
  const seen = new Set<string>();
  for (const item of value) {
    assertCanonicalIdentifier(item, field, maxLength);
    if (seen.has(item)) throw new TypeError(`Mesh capability ${field} contains duplicate values.`);
    seen.add(item);
  }
}

function assertStrictlySortedStrings(value: string[], field: string): void {
  for (let index = 1; index < value.length; index += 1) {
    if (compareExactStrings(value[index]!, value[index - 1]!) <= 0) {
      throw new TypeError(`Mesh capability ${field} must be sorted by exact value.`);
    }
  }
}

function assertSemanticVersion(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      value,
    )
  ) {
    throw new TypeError("Mesh capability semanticVersion must be a canonical SemVer value.");
  }
}

function compareExactStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectedEffectDiffDisposition(
  prior: MeshCapabilityEffectPosture | undefined,
  current: MeshCapabilityEffectPosture,
): MeshCapabilityEffectDiffDisposition {
  if (prior === undefined) return "initial";
  if (prior === current) return "unchanged";
  if (prior === "unknown" || current === "unknown") return "changed";
  const rank: Record<Exclude<MeshCapabilityEffectPosture, "unknown">, number> = {
    none: 0,
    read_only: 1,
    write_local: 2,
    external_side_effect: 3,
  };
  return rank[current] < rank[prior] ? "reduced" : "increased";
}

function assertSafeText(value: string, field: string, maxLength: number): void {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > maxLength ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`Mesh capability ${field} is invalid.`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`Mesh capability ${field} must be a positive safe integer.`);
}

function assertBoundedPositiveInteger(value: number, field: string, max: number): void {
  assertPositiveInteger(value, field);
  if (value > max) throw new TypeError(`Mesh capability ${field} exceeds its limit.`);
}

function assertIsoTimestamp(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`Mesh capability ${field} must be a UTC ISO timestamp.`);
  }
}

function assertSha256(value: string, field: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new TypeError(`Mesh capability ${field} must be a lower-case SHA-256 digest.`);
}

function assertExactKeys(value: object, allowed: string[], field: string, optional: string[] = []): void {
  if (!isRecord(value)) throw new TypeError(`Mesh capability ${field} must be an object.`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`Mesh capability ${field} contains unknown field ${key}.`);
  }
  const optionalSet = new Set(optional);
  for (const key of allowed) {
    if (!optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`Mesh capability ${field} is missing required field ${key}.`);
    }
  }
}

function assertEnum<T extends string>(value: string, values: readonly T[], field: string): asserts value is T {
  if (!values.includes(value as T)) throw new TypeError(`Mesh capability ${field} is unsupported.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
