/* eslint-disable max-lines -- Profile persistence and its fail-closed envelope verification remain one audit boundary. */

import { createHash } from "node:crypto";
import {
  CHAT_TURN_CAPABILITY_PROFILE_VERSION,
  CHAT_WORKSPACE_SNAPSHOT_VERSION,
  assertWorkPassportRecord,
  assertMcpRequesterResolutionBinding,
  canonicalJsonString,
  isToolEffectPotentialRecord,
  mcpRequesterResolutionBindingHashMaterial,
  mcpRequesterScopeHashMaterial,
  NotFoundError,
  type CapabilityCategory,
  type ChatTurnCapabilityProfileDraft,
  type ChatTurnCapabilityProfileEnvelope,
  type ChatTurnCapabilityProfileHashes,
  type ChatTurnCapabilityProfileRecord,
  type ChatWorkspaceSnapshotRecord,
  type CapabilityCatalogEntry,
  type CapabilityCatalogSnapshotRecord,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

/**
 * Frozen-profile trusted skills must come from a LOCAL skill category. This is
 * a deliberate allowlist: HX-408 mesh-published descriptors (category
 * `mesh_published`) are review-only and must keep failing closed here even
 * though the contracts union now carries the new category.
 */
const PROFILE_TRUSTED_SKILL_CATEGORIES: readonly CapabilityCategory[] = [
  "built_in",
  "optional",
  "project_local",
  "self_generated",
  "community_imported",
];

const MAX_PROFILE_BYTES = 512 * 1024;
const MAX_TOOLS = 32;
const MAX_SKILLS = 128;
const MAX_GRANTS = 512;
const MAX_POLICY_DECISIONS = 512;
// The shipped presentations.create provider schema reaches depth 21 once it is
// nested under selection.tools[].providerDefinition. Keep the traversal bound
// at that measured catalog maximum rather than disabling depth protection.
const MAX_JSON_DEPTH = 21;
const MAX_JSON_NODES = 50_000;
const MAX_COLLECTION_ITEMS = 2_048;
const MAX_STRING_LENGTH = 131_072;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_REASON_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const RAW_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|github_pat|glpat|xox[baprs]|grat)_[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
] as const;
const SENSITIVE_FIELD_NAMES = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "authorization",
  "bearertoken",
  "privatekey",
]);
const SCHEMA_SECRET_VALUE_KEYS = new Set(["default", "const", "example", "examples", "enum"]);

interface ChatTurnCapabilityProfileRow {
  profile_id: string;
  turn_id: string;
  session_id: string;
  workspace_id: string;
  durable_run_id: string | null;
  operator_id: string | null;
  auth_actor_id: string | null;
  schema_version: string;
  profile_hash: string;
  catalog_snapshot_id: string;
  inspectable_hash: string;
  callable_hash: string;
  selection_hash: string;
  governance_hash: string;
  preflight_fingerprint: string;
  profile_json: string;
  created_at: string;
}

type ChatTurnCapabilityProfileScopeRow = Pick<
  ChatTurnCapabilityProfileRow,
  | "profile_id"
  | "turn_id"
  | "session_id"
  | "workspace_id"
  | "durable_run_id"
  | "operator_id"
  | "auth_actor_id"
  | "profile_hash"
>;

export interface ChatTurnCapabilityProfileScope {
  profileId: string;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  durableRunId?: string;
  operatorId?: string;
  authActorId?: string;
  profileHash: string;
}

export class ChatTurnCapabilityProfileRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly findByTurnStmt;
  private readonly findByRunStmt;
  private readonly findScopeByTurnStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO chat_turn_capability_profiles (
        profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
        schema_version, profile_hash, catalog_snapshot_id, inspectable_hash,
        callable_hash, selection_hash, governance_hash, preflight_fingerprint,
        profile_json, created_at
      ) VALUES (
        @profileId, @turnId, @sessionId, @workspaceId, @durableRunId, @operatorId, @authActorId,
        @schemaVersion, @profileHash, @catalogSnapshotId, @inspectableHash,
        @callableHash, @selectionHash, @governanceHash, @preflightFingerprint,
        @profileJson, @createdAt
      )
      ON CONFLICT(profile_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM chat_turn_capability_profiles WHERE profile_id = ?");
    this.findByTurnStmt = db.prepare("SELECT * FROM chat_turn_capability_profiles WHERE turn_id = ?");
    this.findByRunStmt = db.prepare("SELECT * FROM chat_turn_capability_profiles WHERE durable_run_id = ?");
    this.findScopeByTurnStmt = db.prepare(`
      SELECT profile_id, turn_id, session_id, workspace_id, durable_run_id,
             operator_id, auth_actor_id, profile_hash
      FROM chat_turn_capability_profiles
      WHERE turn_id = ?
    `);
  }

  public create(input: ChatTurnCapabilityProfileRecord): ChatTurnCapabilityProfileRecord {
    assertValidProfile(input);
    const profileJson = canonicalJsonString(input);
    assertBoundedProfile(input, profileJson);
    this.insertStmt.run({
      profileId: input.profileId,
      turnId: input.identity.turnId,
      sessionId: input.identity.sessionId,
      workspaceId: input.identity.workspaceId,
      durableRunId: input.identity.durableRunId ?? null,
      operatorId: input.identity.operatorId ?? null,
      authActorId: input.identity.authActorId ?? null,
      schemaVersion: input.schemaVersion,
      profileHash: input.hashes.profileHash,
      catalogSnapshotId: input.catalog.snapshotId,
      inspectableHash: input.catalog.inspectableHash,
      callableHash: input.catalog.callableHash,
      selectionHash: input.hashes.selectionHash,
      governanceHash: input.hashes.governanceHash,
      preflightFingerprint: input.preflightFingerprint,
      profileJson,
      createdAt: input.createdAt,
    });
    const stored = this.get(input.profileId);
    if (stored.hashes.profileHash !== input.hashes.profileHash) {
      throw new Error(`Capability profile ${input.profileId} conflicts with an existing immutable record.`);
    }
    return stored;
  }

  public get(profileId: string): ChatTurnCapabilityProfileRecord {
    const row = toRow(this.getStmt.get(profileId));
    if (!row) {
      throw new NotFoundError({ entity: "chat turn capability profile", id: profileId });
    }
    return mapVerifiedRow(row);
  }

  public findByTurn(turnId: string): ChatTurnCapabilityProfileRecord | undefined {
    const row = toRow(this.findByTurnStmt.get(turnId));
    return row ? mapVerifiedRow(row) : undefined;
  }

  public findByRun(runId: string): ChatTurnCapabilityProfileRecord | undefined {
    const row = toRow(this.findByRunStmt.get(runId));
    return row ? mapVerifiedRow(row) : undefined;
  }

  /** Read only the authorization binding; never materializes provider definitions or source references. */
  public findScopeByTurn(turnId: string): ChatTurnCapabilityProfileScope | undefined {
    const row = toScopeRow(this.findScopeByTurnStmt.get(turnId));
    if (!row) {
      return undefined;
    }
    return {
      profileId: row.profile_id,
      turnId: row.turn_id,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      ...(row.durable_run_id !== null ? { durableRunId: row.durable_run_id } : {}),
      ...(row.operator_id !== null ? { operatorId: row.operator_id } : {}),
      ...(row.auth_actor_id !== null ? { authActorId: row.auth_actor_id } : {}),
      profileHash: row.profile_hash,
    };
  }

  public inspectByTurn(turnId: string): ChatTurnCapabilityProfileEnvelope {
    const row = toRow(this.findByTurnStmt.get(turnId));
    if (!row) {
      return { state: "legacy_missing" };
    }
    try {
      return { state: "available", profile: mapVerifiedRow(row) };
    } catch {
      return { state: "invalid", error: "Persisted capability profile failed integrity verification." };
    }
  }
}

export function sealChatTurnCapabilityProfile(draft: ChatTurnCapabilityProfileDraft): ChatTurnCapabilityProfileRecord {
  const hashes = buildHashes(draft);
  return { ...draft, hashes };
}

export function verifyChatTurnCapabilityProfile(input: ChatTurnCapabilityProfileRecord): void {
  assertValidProfile(input);
  const expected = buildHashes(input);
  for (const key of Object.keys(expected) as Array<keyof ChatTurnCapabilityProfileHashes>) {
    if (input.hashes[key] !== expected[key]) {
      throw new Error(`Capability profile ${input.profileId} failed ${key} verification.`);
    }
  }
  assertBoundedProfile(input, canonicalJsonString(input));
}

/** Verify that the immutable catalog row bound by a profile is the exact admitted catalog. */
export function verifyChatTurnCapabilityCatalogBinding(
  profile: ChatTurnCapabilityProfileRecord,
  snapshot: CapabilityCatalogSnapshotRecord,
): void {
  verifyChatTurnCapabilityProfile(profile);
  verifyCapabilityCatalogEntryUniqueness(snapshot.inspectableEntries, "inspectable capability catalog");
  verifyCapabilityCatalogEntryUniqueness(snapshot.callableEntries, "callable capability catalog");
  const inspectableHash = digest(snapshot.inspectableEntries);
  const callableHash = digest(snapshot.callableEntries);
  if (
    snapshot.snapshotId !== profile.catalog.snapshotId ||
    inspectableHash !== profile.catalog.inspectableHash ||
    callableHash !== profile.catalog.callableHash ||
    snapshot.inspectableEntries.length !== profile.catalog.inspectableCount ||
    snapshot.callableEntries.length !== profile.catalog.callableCount
  ) {
    throw new Error(`Capability profile ${profile.profileId} does not match its immutable catalog snapshot.`);
  }

  const inspectableById = new Map(snapshot.inspectableEntries.map((entry) => [entry.capabilityId, entry]));
  const callableTools = new Map<string, CapabilityCatalogEntry>();
  const callableSkills = new Map<string, string>();
  for (const entry of snapshot.callableEntries) {
    const inspectable = inspectableById.get(entry.capabilityId);
    if (!entry.callable || !inspectable || canonicalJsonString(entry) !== canonicalJsonString(inspectable)) {
      throw new Error(`Capability profile ${profile.profileId} contains a non-canonical callable catalog entry.`);
    }
    if (entry.kind === "tool" && entry.toolName) {
      callableTools.set(entry.toolName, entry);
    }
    if (entry.kind === "skill" && entry.skillId) {
      callableSkills.set(entry.capabilityId, entry.skillId);
    }
  }
  for (const tool of profile.selection.tools) {
    const catalogTool = callableTools.get(tool.canonicalName);
    if (!catalogTool) {
      throw new Error(`Capability profile ${profile.profileId} selected a tool outside its callable snapshot.`);
    }
    if (tool.effectPotential !== undefined) {
      const exactEffectBinding =
        canonicalJsonString(tool.effectPotential) === canonicalJsonString(catalogTool.effectPotential);
      const conservativeMissingDescriptor =
        catalogTool.effectPotential === undefined && tool.effectPotential.potential === "unknown";
      const conservativeRuntimeInterposition =
        (profile.catalog.toolCallBeforeHookCount ?? 0) > 0 &&
        Boolean(profile.catalog.runtimeInterpositionHash) &&
        tool.effectPotential.potential === "unknown";
      const conservativeRuntimeOwner =
        tool.runtimeOwner?.kind === "plugin" && tool.effectPotential.potential === "unknown";
      if (
        !exactEffectBinding &&
        !conservativeMissingDescriptor &&
        !conservativeRuntimeInterposition &&
        !conservativeRuntimeOwner
      ) {
        throw new Error(`Capability profile ${profile.profileId} tool effect potential has drifted from its catalog.`);
      }
    }
  }
  for (const skill of profile.selection.trustedSkills) {
    if (callableSkills.get(skill.capabilityId) !== skill.skillId) {
      throw new Error(`Capability profile ${profile.profileId} selected a skill outside its callable snapshot.`);
    }
  }
}

/**
 * Reject ambiguous catalog identities before constructing lookup maps. Without
 * this guard, a duplicate appearing later in an array could silently win and
 * make admission or replay depend on entry order.
 */
export function verifyCapabilityCatalogEntryUniqueness(
  entries: CapabilityCatalogEntry[],
  label = "capability catalog",
): void {
  const capabilityIds = new Set<string>();
  const toolNames = new Set<string>();
  const skillIds = new Set<string>();
  for (const entry of entries) {
    if (capabilityIds.has(entry.capabilityId)) {
      throw new Error(`${label} contains a capability-id collision for ${entry.capabilityId}.`);
    }
    capabilityIds.add(entry.capabilityId);
    if (entry.kind === "tool" && entry.toolName) {
      if (toolNames.has(entry.toolName)) {
        throw new Error(`${label} contains a tool-name collision for ${entry.toolName}.`);
      }
      toolNames.add(entry.toolName);
    }
    if (entry.kind === "skill" && entry.skillId) {
      if (skillIds.has(entry.skillId)) {
        throw new Error(`${label} contains a skill-id collision for ${entry.skillId}.`);
      }
      skillIds.add(entry.skillId);
    }
  }
}

/** Refuse replay when a skill is no longer trusted or its exact provenance/content has drifted. */
export function verifyChatTurnCapabilitySkillBindings(
  profile: ChatTurnCapabilityProfileRecord,
  lifecycleRows: SkillLifecycleRecord[],
): void {
  if (profile.selection.trustedSkills.length === 0) {
    return;
  }
  const lifecycleBySkill = new Map<string, SkillLifecycleRecord>();
  for (const row of lifecycleRows) {
    if (lifecycleBySkill.has(row.skillId)) {
      throw new Error(`Capability profile ${profile.profileId} cannot verify duplicate skill lifecycle state.`);
    }
    lifecycleBySkill.set(row.skillId, row);
  }
  for (const skill of profile.selection.trustedSkills) {
    const current = lifecycleBySkill.get(skill.skillId);
    const provenance = current?.provenance;
    const integrity = provenance?.contentIntegrity;
    if (!current || (current.lifecycleState !== "approved" && current.lifecycleState !== "trusted")) {
      throw new Error(`Capability profile ${profile.profileId} skill ${skill.skillId} is no longer callable.`);
    }
    if (
      current.category !== skill.category ||
      current.lifecycleState !== skill.lifecycleState ||
      current.trustLabel !== skill.trustLabel ||
      provenance?.source !== skill.source ||
      provenance?.sourceRef !== skill.sourceRef ||
      provenance?.sourceProvider !== skill.sourceProvider ||
      provenance?.commitSha !== skill.commitSha ||
      integrity?.manifestVersion !== skill.contentIntegrityManifestVersion ||
      integrity?.treeSha256 !== skill.treeSha256 ||
      integrity?.fileCount !== skill.contentFileCount ||
      integrity?.totalBytes !== skill.contentBytes ||
      (integrity !== undefined && integrity.verified !== true)
    ) {
      throw new Error(`Capability profile ${profile.profileId} skill ${skill.skillId} provenance has drifted.`);
    }
  }
}

function buildHashes(
  input: ChatTurnCapabilityProfileDraft | ChatTurnCapabilityProfileRecord,
): ChatTurnCapabilityProfileHashes {
  const identityHash = digest(input.identity);
  const sourceHash = digest(input.source);
  const catalogHash = digest(input.catalog);
  const selectionHash = digest(input.selection);
  const governanceHash = digest(input.governance);
  const profileHash = digest({
    profileId: input.profileId,
    schemaVersion: input.schemaVersion,
    identity: input.identity,
    source: input.source,
    catalog: input.catalog,
    selection: input.selection,
    governance: input.governance,
    sectionHashes: { identityHash, sourceHash, catalogHash, selectionHash, governanceHash },
    preflightFingerprint: input.preflightFingerprint,
    createdAt: input.createdAt,
  });
  return { identityHash, sourceHash, catalogHash, selectionHash, governanceHash, profileHash };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

function assertValidProfile(input: ChatTurnCapabilityProfileRecord): void {
  assertBoundedJsonTree(input);
  if (input.schemaVersion !== CHAT_TURN_CAPABILITY_PROFILE_VERSION) {
    throw new Error(`Unsupported capability profile schema: ${String(input.schemaVersion)}`);
  }
  assertSafeId(input.profileId, "profileId");
  assertSafeId(input.identity.turnId, "identity.turnId");
  assertSafeId(input.identity.sessionId, "identity.sessionId");
  assertSafeId(input.identity.workspaceId, "identity.workspaceId");
  assertSafeId(input.identity.citadelId, "identity.citadelId");
  if (input.identity.durableRunId !== undefined) {
    assertSafeId(input.identity.durableRunId, "identity.durableRunId");
  }
  if (input.identity.operatorId !== undefined) {
    assertSafeId(input.identity.operatorId, "identity.operatorId");
  }
  if (input.identity.authActorId !== undefined) {
    assertSafeId(input.identity.authActorId, "identity.authActorId");
  }
  if (
    input.identity.authActorSource !== undefined &&
    !(["none", "token", "basic", "loopback", "sse", "device", "companion", "a2a_peer", "mesh_node"] as const).includes(
      input.identity.authActorSource,
    )
  ) {
    throw new Error("Capability profile identity auth actor source is invalid.");
  }
  if (!input.profileId.trim() || !input.identity.turnId.trim() || !input.identity.sessionId.trim()) {
    throw new Error("Capability profile identity is incomplete.");
  }
  assertSafeString(input.source.channel, "source.channel", 256);
  assertSafeString(input.source.account, "source.account", 256);
  for (const [key, value] of Object.entries(input.source)) {
    if (key === "bindingTargetHash" && value !== undefined) {
      assertHash(value, "source.bindingTargetHash");
    } else if (key !== "channel" && key !== "account" && value !== undefined) {
      assertSafeString(value, `source.${key}`, 2_048);
    }
  }
  assertHash(input.catalog.inspectableHash, "catalog.inspectableHash");
  assertHash(input.catalog.callableHash, "catalog.callableHash");
  assertSafeId(input.catalog.snapshotId, "catalog.snapshotId");
  assertNonNegativeInteger(input.catalog.inspectableCount, "catalog.inspectableCount");
  assertNonNegativeInteger(input.catalog.callableCount, "catalog.callableCount");
  const hasRuntimeInterpositionHash = input.catalog.runtimeInterpositionHash !== undefined;
  const hasToolCallBeforeHookCount = input.catalog.toolCallBeforeHookCount !== undefined;
  if (hasRuntimeInterpositionHash !== hasToolCallBeforeHookCount) {
    throw new Error("Capability profile runtime interposition catalog binding is incomplete.");
  }
  if (input.catalog.runtimeInterpositionHash !== undefined) {
    assertHash(input.catalog.runtimeInterpositionHash, "catalog.runtimeInterpositionHash");
    assertNonNegativeInteger(input.catalog.toolCallBeforeHookCount as number, "catalog.toolCallBeforeHookCount");
  }
  if (input.catalog.callableCount > input.catalog.inspectableCount) {
    throw new Error("Capability profile callable catalog count exceeds its inspectable count.");
  }
  assertHash(input.preflightFingerprint, "preflightFingerprint");
  assertHash(input.selection.contentHash, "selection.contentHash");
  for (const [path, value] of [
    ["selection.requestedProviderId", input.selection.requestedProviderId],
    ["selection.requestedModel", input.selection.requestedModel],
    ["selection.effectiveProviderId", input.selection.effectiveProviderId],
    ["selection.effectiveModel", input.selection.effectiveModel],
  ] as const) {
    if (value !== undefined) {
      assertSafeId(value, path);
    }
  }
  if (!(["chat", "cowork", "code"] as const).includes(input.selection.mode)) {
    throw new Error("Capability profile selection mode is invalid.");
  }
  if (!(["auto", "off", "quick", "deep"] as const).includes(input.selection.webMode)) {
    throw new Error("Capability profile web mode is invalid.");
  }
  if (!(["auto", "on", "off"] as const).includes(input.selection.memory.mode)) {
    throw new Error("Capability profile memory mode is invalid.");
  }
  if (
    !(["off", "minimal", "standard", "extended", "deep", "max", "ultra"] as const).includes(
      input.selection.thinkingLevel,
    )
  ) {
    throw new Error("Capability profile thinking level is invalid.");
  }
  if (!(["standard", "fast"] as const).includes(input.selection.speedMode)) {
    throw new Error("Capability profile speed mode is invalid.");
  }
  if (!(["off", "ask_when_useful", "auto_when_useful"] as const).includes(input.selection.subagentPolicy)) {
    throw new Error("Capability profile subagent policy is invalid.");
  }
  if (!(["safe_auto", "manual"] as const).includes(input.selection.toolAutonomy)) {
    throw new Error("Capability profile tool autonomy is invalid.");
  }
  if (input.selection.workPassport !== undefined) {
    assertWorkPassportRecord(input.selection.workPassport);
  }
  if (input.selection.workspaceSnapshot !== undefined) {
    assertChatWorkspaceSnapshot(input.selection.workspaceSnapshot, input.identity.workspaceId);
  }
  assertSafeString(input.selection.memory.retrievalMode, "selection.memory.retrievalMode", 128);
  if (!(["standard", "layered"] as const).includes(input.selection.memory.retrievalMode)) {
    throw new Error("Capability profile memory retrieval mode is invalid.");
  }
  assertSafeId(input.selection.memory.workspaceId, "selection.memory.workspaceId");
  assertSafeId(input.selection.memory.sessionId, "selection.memory.sessionId");
  if (
    input.selection.memory.workspaceId !== input.identity.workspaceId ||
    input.selection.memory.sessionId !== input.identity.sessionId
  ) {
    throw new Error("Capability profile memory scope does not match its identity scope.");
  }
  if (!/^chat-memory-scope:[a-f0-9]{64}$/.test(input.selection.memory.contextManifestRef)) {
    throw new Error("Capability profile memory context manifest reference is invalid.");
  }
  if (typeof input.selection.memory.writeApprovalRequired !== "boolean") {
    throw new Error("Capability profile memory write-approval posture is invalid.");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Capability profile createdAt is invalid.");
  }
  if (!Array.isArray(input.selection.tools) || !Array.isArray(input.selection.modelNameAllowMap)) {
    throw new Error("Capability profile tool selection is malformed.");
  }
  if (!Array.isArray(input.selection.trustedSkills) || !Array.isArray(input.selection.allowedFallbacks)) {
    throw new Error("Capability profile selection lists are malformed.");
  }
  if (
    !Array.isArray(input.governance.activeGrants) ||
    !Array.isArray(input.governance.policyDecisions) ||
    !Array.isArray(input.governance.authReadiness)
  ) {
    throw new Error("Capability profile governance lists are malformed.");
  }
  if (input.selection.tools.length > MAX_TOOLS) {
    throw new Error(`Capability profile exceeds the ${MAX_TOOLS} tool definition limit.`);
  }
  if (input.selection.trustedSkills.length > MAX_SKILLS) {
    throw new Error(`Capability profile exceeds the ${MAX_SKILLS} trusted skill limit.`);
  }
  if (input.governance.activeGrants.length > MAX_GRANTS) {
    throw new Error(`Capability profile exceeds the ${MAX_GRANTS} active grant limit.`);
  }
  if (input.governance.policyDecisions.length > MAX_POLICY_DECISIONS) {
    throw new Error(`Capability profile exceeds the ${MAX_POLICY_DECISIONS} policy decision limit.`);
  }
  if (input.selection.modelNameAllowMap.length !== input.selection.tools.length) {
    throw new Error("Capability profile model-name allow-map does not match its tool definitions.");
  }
  const toolBindings = new Map<string, string>();
  const canonicalNames = new Set<string>();
  for (const tool of input.selection.tools) {
    assertSafeId(tool.canonicalName, "selection.tools.canonicalName");
    assertSafeId(tool.modelName, "selection.tools.modelName");
    assertHash(tool.definitionHash, `selection.tools.${tool.canonicalName}.definitionHash`);
    if (!isRecord(tool.providerDefinition)) {
      throw new Error(`Capability profile tool ${tool.canonicalName} has a malformed provider definition.`);
    }
    const providerFunction = tool.providerDefinition.function;
    if (
      tool.providerDefinition.type !== "function" ||
      !isRecord(providerFunction) ||
      providerFunction.name !== tool.modelName
    ) {
      throw new Error(`Capability profile tool ${tool.canonicalName} provider name binding is invalid.`);
    }
    if (digest(tool.providerDefinition) !== tool.definitionHash) {
      throw new Error(`Capability profile tool ${tool.canonicalName} definition hash is invalid.`);
    }
    if (tool.effectPotential !== undefined && !isToolEffectPotentialRecord(tool.effectPotential)) {
      throw new Error(`Capability profile tool ${tool.canonicalName} has invalid effect-potential truth.`);
    }
    if (tool.runtimeOwner !== undefined) {
      if (tool.runtimeOwner.kind !== "builtin" && tool.runtimeOwner.kind !== "plugin") {
        throw new Error(`Capability profile tool ${tool.canonicalName} has an invalid runtime owner kind.`);
      }
      assertHash(tool.runtimeOwner.bindingHash, `selection.tools.${tool.canonicalName}.runtimeOwner.bindingHash`);
    }
    if (tool.mcpRequesterResolution !== undefined) {
      assertMcpRequesterResolutionBinding(tool.mcpRequesterResolution);
      if (!tool.canonicalName.startsWith("mcp.")) {
        throw new Error(`Capability profile tool ${tool.canonicalName} cannot carry a requester-scoped MCP binding.`);
      }
      if (tool.runtimeOwner?.kind !== "builtin") {
        throw new Error(`Capability profile tool ${tool.canonicalName} requester resolution is not Gateway-owned.`);
      }
      if (tool.mcpRequesterResolution.toolName !== tool.canonicalName) {
        throw new Error(`Capability profile tool ${tool.canonicalName} requester binding names a different tool.`);
      }
      if (
        tool.mcpRequesterResolution.callableCatalogSnapshotId !== input.catalog.snapshotId ||
        tool.mcpRequesterResolution.callableCatalogSha256 !== input.catalog.callableHash
      ) {
        throw new Error(
          `Capability profile tool ${tool.canonicalName} requester binding does not match the callable catalog.`,
        );
      }
      if (
        digest(mcpRequesterResolutionBindingHashMaterial(tool.mcpRequesterResolution)) !==
        tool.mcpRequesterResolution.bindingSha256
      ) {
        throw new Error(`Capability profile tool ${tool.canonicalName} requester binding hash is invalid.`);
      }
      if (
        input.identity.authActorId === undefined ||
        !(["token", "basic", "loopback", "device", "companion"] as const).includes(
          input.identity.authActorSource as "token" | "basic" | "loopback" | "device" | "companion",
        )
      ) {
        throw new Error(
          `Capability profile tool ${tool.canonicalName} requester binding lacks authenticated requester authority.`,
        );
      }
      const expectedRequesterScopeSha256 = digest(
        mcpRequesterScopeHashMaterial({
          profileId: input.profileId,
          turnId: input.identity.turnId,
          sessionId: input.identity.sessionId,
          workspaceId: input.identity.workspaceId,
          authActorId: input.identity.authActorId,
          authActorSource: input.identity.authActorSource as "token" | "basic" | "loopback" | "device" | "companion",
        }),
      );
      if (tool.mcpRequesterResolution.requesterScopeSha256 !== expectedRequesterScopeSha256) {
        throw new Error(
          `Capability profile tool ${tool.canonicalName} requester binding does not match its authenticated requester authority.`,
        );
      }
    }
    if (tool.meshPublication !== undefined) {
      // HX-408 M2: the packet-mandated snapshot for one mesh-published
      // callable. Shape truth only — live revalidation stays with the freeze
      // and pre-dispatch gates against the storage revalidation query.
      const mesh = tool.meshPublication;
      assertSafeId(mesh.nodeId, `selection.tools.${tool.canonicalName}.meshPublication.nodeId`);
      assertSafeId(mesh.activationId, `selection.tools.${tool.canonicalName}.meshPublication.activationId`);
      assertHash(mesh.manifestSha256, `selection.tools.${tool.canonicalName}.meshPublication.manifestSha256`);
      assertHash(mesh.entrySha256, `selection.tools.${tool.canonicalName}.meshPublication.entrySha256`);
      assertHash(
        mesh.permissionEnvelopeSha256,
        `selection.tools.${tool.canonicalName}.meshPublication.permissionEnvelopeSha256`,
      );
      for (const [field, value] of [
        ["publisherGeneration", mesh.publisherGeneration],
        ["activationRevision", mesh.activationRevision],
        ["publicationLeaseFencingToken", mesh.publicationLeaseFencingToken],
        ["healthGeneration", mesh.healthGeneration],
      ] as const) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
          throw new Error(
            `Capability profile tool ${tool.canonicalName} meshPublication.${field} must be a positive integer.`,
          );
        }
      }
      if (
        !(["none", "read_only", "write_local", "external_side_effect", "unknown"] as const).includes(mesh.effectPosture)
      ) {
        throw new Error(`Capability profile tool ${tool.canonicalName} meshPublication effect posture is invalid.`);
      }
      if (tool.runtimeOwner?.kind !== "builtin") {
        throw new Error(`Capability profile tool ${tool.canonicalName} mesh publication is not Gateway-owned.`);
      }
      if (tool.mcpRequesterResolution !== undefined) {
        throw new Error(
          `Capability profile tool ${tool.canonicalName} cannot bind both mesh publication and requester-scoped MCP.`,
        );
      }
    }
    if (toolBindings.has(tool.modelName) || canonicalNames.has(tool.canonicalName)) {
      throw new Error("Capability profile contains duplicate tool-name bindings.");
    }
    toolBindings.set(tool.modelName, tool.canonicalName);
    canonicalNames.add(tool.canonicalName);
  }
  for (const binding of input.selection.modelNameAllowMap) {
    if (toolBindings.get(binding.modelName) !== binding.canonicalName) {
      throw new Error("Capability profile model-name allow-map contains a non-selected tool.");
    }
  }
  if (input.selection.allowedFallbacks.length > 8) {
    throw new Error("Capability profile contains too many fallback targets.");
  }
  for (const target of input.selection.allowedFallbacks) {
    assertSafeId(target.providerId, "selection.allowedFallbacks.providerId");
    assertSafeId(target.model, "selection.allowedFallbacks.model");
  }
  const skillCapabilityIds = new Set<string>();
  const skillIds = new Set<string>();
  for (const skill of input.selection.trustedSkills) {
    assertSafeId(skill.capabilityId, "selection.trustedSkills.capabilityId");
    assertSafeId(skill.skillId, "selection.trustedSkills.skillId");
    if (skillCapabilityIds.has(skill.capabilityId) || skillIds.has(skill.skillId)) {
      throw new Error("Capability profile contains duplicate trusted skill bindings.");
    }
    skillCapabilityIds.add(skill.capabilityId);
    skillIds.add(skill.skillId);
    if (!PROFILE_TRUSTED_SKILL_CATEGORIES.includes(skill.category)) {
      throw new Error(`Capability profile skill ${skill.skillId} category is invalid.`);
    }
    if (!(["approved", "trusted"] as const).includes(skill.lifecycleState)) {
      throw new Error(`Capability profile skill ${skill.skillId} is not in a callable lifecycle state.`);
    }
    assertSafeString(skill.trustLabel, `selection.trustedSkills.${skill.skillId}.trustLabel`, 256);
    assertSafeString(skill.source, `selection.trustedSkills.${skill.skillId}.source`, 2_048);
    if (skill.sourceRef !== undefined) {
      assertSafeString(skill.sourceRef, `selection.trustedSkills.${skill.skillId}.sourceRef`, 8_192);
    }
    if (skill.sourceProvider !== undefined) {
      assertSafeString(skill.sourceProvider, `selection.trustedSkills.${skill.skillId}.sourceProvider`, 256);
    }
    if (skill.treeSha256 !== undefined) {
      assertHash(skill.treeSha256, `selection.trustedSkills.${skill.skillId}.treeSha256`);
    }
    if (skill.commitSha !== undefined && !/^[a-f0-9]{7,64}$/i.test(skill.commitSha)) {
      throw new Error(`Capability profile skill ${skill.skillId} commitSha is invalid.`);
    }
    if (skill.contentFileCount !== undefined) {
      assertNonNegativeInteger(skill.contentFileCount, `selection.trustedSkills.${skill.skillId}.contentFileCount`);
    }
    if (skill.contentBytes !== undefined) {
      assertNonNegativeInteger(skill.contentBytes, `selection.trustedSkills.${skill.skillId}.contentBytes`);
    }
    const integrityFields = [
      skill.contentIntegrityManifestVersion,
      skill.treeSha256,
      skill.contentFileCount,
      skill.contentBytes,
    ];
    if (integrityFields.some((value) => value !== undefined) && integrityFields.some((value) => value === undefined)) {
      throw new Error(`Capability profile skill ${skill.skillId} has an incomplete content-integrity binding.`);
    }
    if (skill.treeSha256 === undefined) {
      throw new Error(`Capability profile trusted skill ${skill.skillId} lacks exact-byte integrity evidence.`);
    }
  }
  for (const grant of input.governance.activeGrants) {
    assertSafeId(grant.grantId, "governance.activeGrants.grantId");
    assertSafeString(grant.toolPattern, "governance.activeGrants.toolPattern", 512);
    assertSafeString(grant.scopeRef, "governance.activeGrants.scopeRef", 2_048);
    if (!(["allow", "deny"] as const).includes(grant.decision)) {
      throw new Error(`Capability profile grant ${grant.grantId} has an invalid decision.`);
    }
    if (!(["global", "agent", "workspace", "session", "task", "citadel", "chamber"] as const).includes(grant.scope)) {
      throw new Error(`Capability profile grant ${grant.grantId} has an invalid scope.`);
    }
    if (!(["one_time", "ttl", "persistent"] as const).includes(grant.grantType)) {
      throw new Error(`Capability profile grant ${grant.grantId} has an invalid type.`);
    }
    if (grant.usesRemaining !== undefined) {
      assertNonNegativeInteger(grant.usesRemaining, `governance.activeGrants.${grant.grantId}.usesRemaining`);
    }
    if (grant.expiresAt !== undefined && !Number.isFinite(Date.parse(grant.expiresAt))) {
      throw new Error(`Capability profile grant ${grant.grantId} has an invalid expiry.`);
    }
  }
  const policyByTool = new Map<string, (typeof input.governance.policyDecisions)[number]>();
  for (const decision of input.governance.policyDecisions) {
    assertSafeId(decision.toolName, "governance.policyDecisions.toolName");
    if (policyByTool.has(decision.toolName)) {
      throw new Error(`Capability profile contains duplicate policy decisions for ${decision.toolName}.`);
    }
    if (
      !Array.isArray(decision.reasonCodes) ||
      decision.reasonCodes.some((code) => !SAFE_REASON_CODE_PATTERN.test(code))
    ) {
      throw new Error(`Capability profile policy decision ${decision.toolName} has invalid reason codes.`);
    }
    if (typeof decision.allowed !== "boolean" || typeof decision.requiresApproval !== "boolean") {
      throw new Error(`Capability profile policy decision ${decision.toolName} has invalid boolean posture.`);
    }
    if (decision.matchedGrantId !== undefined) {
      assertSafeId(decision.matchedGrantId, `governance.policyDecisions.${decision.toolName}.matchedGrantId`);
    }
    policyByTool.set(decision.toolName, decision);
  }
  for (const canonicalName of canonicalNames) {
    if (policyByTool.get(canonicalName)?.allowed !== true) {
      throw new Error(`Capability profile selected tool ${canonicalName} lacks an allowed frozen policy decision.`);
    }
  }
  assertSafeId(input.governance.permission.profileId, "governance.permission.profileId");
  assertHash(input.governance.permission.profileHash, "governance.permission.profileHash");
  if (input.governance.permission.localOperatorOverrideId !== undefined) {
    assertSafeId(input.governance.permission.localOperatorOverrideId, "governance.permission.localOperatorOverrideId");
  }
  if (!(["approve_all", "approve_risky", "bypass"] as const).includes(input.governance.permission.approvalMode)) {
    throw new Error("Capability profile permission approval mode is invalid.");
  }
  if (
    input.governance.permission.localOperatorOverrideExpiresAt !== undefined &&
    !Number.isFinite(Date.parse(input.governance.permission.localOperatorOverrideExpiresAt))
  ) {
    throw new Error("Capability profile local operator override expiry is invalid.");
  }
  if (input.governance.approval.approvalGranted !== false) {
    throw new Error("Capability profile cannot pre-grant approval.");
  }
  if (input.governance.approval.selectedToolCount !== input.selection.tools.length) {
    throw new Error("Capability profile approval posture tool count is inconsistent.");
  }
  const approvalTools = new Set(input.governance.approval.toolsRequiringApproval);
  const expectedApprovalTools = new Set(
    [...canonicalNames].filter((toolName) => policyByTool.get(toolName)?.requiresApproval === true),
  );
  if (
    input.governance.approval.mode !== input.governance.permission.approvalMode ||
    approvalTools.size !== input.governance.approval.toolsRequiringApproval.length ||
    approvalTools.size !== expectedApprovalTools.size ||
    [...approvalTools].some((toolName) => !expectedApprovalTools.has(toolName))
  ) {
    throw new Error("Capability profile approval posture does not match its frozen policy decisions.");
  }
  assertReadinessCoverage(input, canonicalNames);
  const expectedHashKeys = [
    "catalogHash",
    "governanceHash",
    "identityHash",
    "profileHash",
    "selectionHash",
    "sourceHash",
  ];
  if (Object.keys(input.hashes).sort().join("|") !== expectedHashKeys.join("|")) {
    throw new Error("Capability profile hash manifest has unexpected fields.");
  }
  for (const hash of Object.values(input.hashes)) {
    assertHash(hash, "hashes");
  }
  assertSecretFree(input);
}

function assertChatWorkspaceSnapshot(snapshot: ChatWorkspaceSnapshotRecord, workspaceId: string): void {
  if (snapshot.schemaVersion !== CHAT_WORKSPACE_SNAPSHOT_VERSION) {
    throw new Error("Capability profile workspace snapshot has an unsupported schema version.");
  }
  assertSafeId(snapshot.snapshotId, "selection.workspaceSnapshot.snapshotId");
  assertSafeId(snapshot.requestId, "selection.workspaceSnapshot.requestId");
  assertSafeId(snapshot.workspaceId, "selection.workspaceSnapshot.workspaceId");
  if (snapshot.workspaceId !== workspaceId) {
    throw new Error("Capability profile workspace snapshot is outside the turn workspace.");
  }
  if (
    typeof snapshot.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    new Date(snapshot.capturedAt).toISOString() !== snapshot.capturedAt
  ) {
    throw new Error("Capability profile workspace snapshot capture time is invalid.");
  }
  assertHash(snapshot.snapshotHash, "selection.workspaceSnapshot.snapshotHash");
  const { snapshotHash: _snapshotHash, ...hashMaterial } = snapshot;
  if (digest(hashMaterial) !== snapshot.snapshotHash) {
    throw new Error("Capability profile workspace snapshot hash is invalid.");
  }
  if (snapshot.project) {
    assertSafeId(snapshot.project.projectId, "selection.workspaceSnapshot.project.projectId");
    if (!Number.isSafeInteger(snapshot.project.projectRevision) || snapshot.project.projectRevision < 1) {
      throw new Error("Capability profile workspace snapshot project revision is invalid.");
    }
  }
  if (snapshot.status === "captured") {
    if (!snapshot.project || !snapshot.pathBinding || !snapshot.git || snapshot.reasonCode !== undefined) {
      throw new Error("Captured workspace snapshot evidence is incomplete.");
    }
    assertSafeId(snapshot.pathBinding.verificationId, "selection.workspaceSnapshot.pathBinding.verificationId");
    assertHash(snapshot.pathBinding.fingerprintSha256, "selection.workspaceSnapshot.pathBinding.fingerprintSha256");
    assertHash(snapshot.pathBinding.gitIdentitySha256, "selection.workspaceSnapshot.pathBinding.gitIdentitySha256");
    if (!/^[a-f0-9]{40,64}$/u.test(snapshot.git.headSha)) {
      throw new Error("Capability profile workspace snapshot HEAD is invalid.");
    }
    if (snapshot.git.branch !== undefined) {
      assertSafeString(snapshot.git.branch, "selection.workspaceSnapshot.git.branch", 256);
      if (containsAsciiControlCharacter(snapshot.git.branch)) {
        throw new Error("Capability profile workspace snapshot branch is invalid.");
      }
    }
    assertNonNegativeInteger(snapshot.git.trackedChangeCount, "selection.workspaceSnapshot.git.trackedChangeCount");
    assertNonNegativeInteger(snapshot.git.untrackedChangeCount, "selection.workspaceSnapshot.git.untrackedChangeCount");
    if (
      typeof snapshot.git.dirty !== "boolean" ||
      snapshot.git.dirty !== snapshot.git.trackedChangeCount + snapshot.git.untrackedChangeCount > 0
    ) {
      throw new Error("Capability profile workspace snapshot dirty posture is inconsistent.");
    }
    if (snapshot.git.ahead !== undefined) {
      assertNonNegativeInteger(snapshot.git.ahead, "selection.workspaceSnapshot.git.ahead");
    }
    if (snapshot.git.behind !== undefined) {
      assertNonNegativeInteger(snapshot.git.behind, "selection.workspaceSnapshot.git.behind");
    }
    return;
  }
  const unavailableReasons = new Set([
    "workspace_unavailable",
    "project_unbound",
    "path_verification_failed",
    "path_identity_changed",
    "git_unavailable",
    "git_not_repository",
    "git_summary_failed",
  ]);
  if (
    snapshot.status !== "unavailable" ||
    !snapshot.reasonCode ||
    !unavailableReasons.has(snapshot.reasonCode) ||
    snapshot.pathBinding !== undefined ||
    snapshot.git !== undefined
  ) {
    throw new Error("Unavailable workspace snapshot evidence is malformed.");
  }
}

function assertBoundedProfile(input: ChatTurnCapabilityProfileRecord, profileJson: string): void {
  if (Buffer.byteLength(profileJson, "utf8") > MAX_PROFILE_BYTES) {
    throw new Error(`Capability profile ${input.profileId} exceeds ${MAX_PROFILE_BYTES} bytes.`);
  }
}

function assertReadinessCoverage(input: ChatTurnCapabilityProfileRecord, canonicalNames: Set<string>): void {
  const readinessKeys = new Set<string>();
  for (const readiness of input.governance.authReadiness) {
    if (!(["provider", "tool", "skill", "channel", "mcp"] as const).includes(readiness.kind)) {
      throw new Error("Capability profile contains an unknown auth-readiness kind.");
    }
    assertSafeString(readiness.ref, "governance.authReadiness.ref", 2_048);
    if (!(["ready", "missing", "blocked", "unknown"] as const).includes(readiness.status)) {
      throw new Error(`Capability profile auth readiness ${readiness.ref} has an invalid status.`);
    }
    if (
      !Array.isArray(readiness.reasonCodes) ||
      readiness.reasonCodes.some((code) => !SAFE_REASON_CODE_PATTERN.test(code))
    ) {
      throw new Error(`Capability profile auth readiness ${readiness.ref} has invalid reason codes.`);
    }
    const key = `${readiness.kind}:${readiness.ref}`;
    if (readinessKeys.has(key)) {
      throw new Error(`Capability profile contains duplicate auth readiness ${key}.`);
    }
    readinessKeys.add(key);
  }
  if (!input.governance.authReadiness.some((item) => item.kind === "provider")) {
    throw new Error("Capability profile is missing provider auth readiness.");
  }
  if (!input.governance.authReadiness.some((item) => item.kind === "channel")) {
    throw new Error("Capability profile is missing channel auth readiness.");
  }
  for (const toolName of canonicalNames) {
    if (
      !input.governance.authReadiness.some(
        (item) => (item.kind === "tool" || item.kind === "mcp") && item.ref === toolName,
      )
    ) {
      throw new Error(`Capability profile is missing auth readiness for tool ${toolName}.`);
    }
  }
  for (const skill of input.selection.trustedSkills) {
    if (!input.governance.authReadiness.some((item) => item.kind === "skill" && item.ref === skill.skillId)) {
      throw new Error(`Capability profile is missing auth readiness for skill ${skill.skillId}.`);
    }
  }
}

function assertBoundedJsonTree(value: unknown): void {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new Error(`Capability profile exceeds the ${MAX_JSON_NODES} JSON node limit.`);
    }
    if (depth > MAX_JSON_DEPTH) {
      throw new Error(`Capability profile exceeds the ${MAX_JSON_DEPTH} JSON depth limit at ${path}.`);
    }
    if (typeof current === "string") {
      if (current.length > MAX_STRING_LENGTH || containsUnsafeJsonStringCharacter(current)) {
        throw new Error(`Capability profile string at ${path} is not safely bounded.`);
      }
      return;
    }
    if (current === null || typeof current === "boolean") {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`Capability profile contains a non-finite number at ${path}.`);
      }
      return;
    }
    if (current === undefined) {
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`Capability profile contains a non-JSON value at ${path}.`);
    }
    if (seen.has(current)) {
      throw new Error(`Capability profile contains a cycle at ${path}.`);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`Capability profile collection at ${path} exceeds ${MAX_COLLECTION_ITEMS} items.`);
      }
      current.forEach((entry, index) => visit(entry, depth + 1, `${path}[${index}]`));
      return;
    }
    const entries = Object.entries(current as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION_ITEMS) {
      throw new Error(`Capability profile object at ${path} exceeds ${MAX_COLLECTION_ITEMS} keys.`);
    }
    for (const [key, entry] of entries) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`Capability profile contains a prohibited key at ${path}.${key}.`);
      }
      assertSafeString(key, `${path} key`, 256);
      visit(entry, depth + 1, `${path}.${key}`);
    }
  };
  visit(value, 0, "$profile");
}

function assertSecretFree(value: unknown): void {
  let nodes = 0;
  const visit = (
    current: unknown,
    path: string,
    depth: number,
    sensitiveSchema = false,
    rejectScalar = false,
  ): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error(`Capability profile secret scan exceeded its bounded traversal at ${path}.`);
    }
    if (typeof current === "string") {
      if (RAW_SECRET_PATTERNS.some((pattern) => pattern.test(current))) {
        throw new Error(`Capability profile contains secret-like material at ${path}.`);
      }
      if (/^(?:https?|git\+https):\/\/[^/@\s]+:[^/@\s]+@/i.test(current)) {
        throw new Error(`Capability profile contains credential-bearing source material at ${path}.`);
      }
      if (rejectScalar && current.trim().length > 0) {
        throw new Error(`Capability profile contains a credential value at ${path}.`);
      }
      return;
    }
    if ((typeof current === "number" || typeof current === "boolean") && rejectScalar) {
      throw new Error(`Capability profile contains a credential value at ${path}.`);
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1, sensitiveSchema, rejectScalar));
      return;
    }
    if (isRecord(current)) {
      for (const [key, entry] of Object.entries(current)) {
        const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        const sensitiveField = SENSITIVE_FIELD_NAMES.has(normalizedKey);
        if (sensitiveField && isCredentialScalar(entry)) {
          throw new Error(`Capability profile contains a direct credential value at ${path}.${key}.`);
        }
        const nextSensitiveSchema = sensitiveSchema || sensitiveField;
        const schemaValue = nextSensitiveSchema && SCHEMA_SECRET_VALUE_KEYS.has(key.toLowerCase());
        visit(
          entry,
          `${path}.${key}`,
          depth + 1,
          nextSensitiveSchema,
          rejectScalar || schemaValue || (sensitiveField && Array.isArray(entry)),
        );
      }
    }
  };
  visit(value, "$profile", 0);
}

function isCredentialScalar(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return typeof value === "number" || typeof value === "boolean";
}

function containsUnsafeJsonStringCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 8 || code === 11 || code === 12) return true;
  }
  return false;
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertHash(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Capability profile ${path} must be a lowercase sha256 digest.`);
  }
}

function assertSafeId(value: unknown, path: string): asserts value is string {
  assertSafeString(value, path, 256);
  if (/\s/u.test(value) || containsAsciiControlCharacter(value)) {
    throw new Error(`Capability profile ${path} contains invalid identifier characters.`);
  }
}

function assertSafeString(value: unknown, path: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    containsUnsafeJsonStringCharacter(value)
  ) {
    throw new Error(`Capability profile ${path} is not a bounded safe string.`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Capability profile ${path} must be a non-negative integer.`);
  }
}

function mapVerifiedRow(row: ChatTurnCapabilityProfileRow): ChatTurnCapabilityProfileRecord {
  const parsed = safeJsonParse<unknown>(row.profile_json, undefined);
  if (!isProfileRecord(parsed)) {
    throw new Error(`Capability profile ${row.profile_id} contains malformed JSON.`);
  }
  verifyChatTurnCapabilityProfile(parsed);
  if (
    parsed.profileId !== row.profile_id ||
    parsed.identity.turnId !== row.turn_id ||
    parsed.identity.sessionId !== row.session_id ||
    parsed.identity.workspaceId !== row.workspace_id ||
    (parsed.identity.durableRunId ?? null) !== row.durable_run_id ||
    (parsed.identity.operatorId ?? null) !== row.operator_id ||
    (parsed.identity.authActorId ?? null) !== row.auth_actor_id ||
    parsed.hashes.profileHash !== row.profile_hash ||
    parsed.catalog.snapshotId !== row.catalog_snapshot_id ||
    parsed.catalog.inspectableHash !== row.inspectable_hash ||
    parsed.catalog.callableHash !== row.callable_hash ||
    parsed.hashes.selectionHash !== row.selection_hash ||
    parsed.hashes.governanceHash !== row.governance_hash ||
    parsed.preflightFingerprint !== row.preflight_fingerprint ||
    parsed.createdAt !== row.created_at
  ) {
    throw new Error(`Capability profile ${row.profile_id} column bindings failed verification.`);
  }
  return parsed;
}

function isProfileRecord(value: unknown): value is ChatTurnCapabilityProfileRecord {
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.catalog) || !isRecord(value.selection)) {
    return false;
  }
  return (
    typeof value.profileId === "string" &&
    value.schemaVersion === CHAT_TURN_CAPABILITY_PROFILE_VERSION &&
    typeof value.createdAt === "string" &&
    typeof value.preflightFingerprint === "string" &&
    isRecord(value.source) &&
    isRecord(value.governance) &&
    isRecord(value.hashes) &&
    typeof value.identity.turnId === "string" &&
    typeof value.identity.sessionId === "string" &&
    typeof value.identity.workspaceId === "string" &&
    typeof value.catalog.snapshotId === "string" &&
    Array.isArray(value.selection.tools) &&
    Array.isArray(value.selection.modelNameAllowMap) &&
    Array.isArray(value.selection.trustedSkills) &&
    typeof value.hashes.profileHash === "string"
  );
}

function toRow(value: unknown): ChatTurnCapabilityProfileRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const required = [
    "profile_id",
    "turn_id",
    "session_id",
    "workspace_id",
    "schema_version",
    "profile_hash",
    "catalog_snapshot_id",
    "inspectable_hash",
    "callable_hash",
    "selection_hash",
    "governance_hash",
    "preflight_fingerprint",
    "profile_json",
    "created_at",
  ];
  if (required.some((key) => typeof value[key] !== "string")) {
    return undefined;
  }
  if (
    !isNullableString(value.durable_run_id) ||
    !isNullableString(value.operator_id) ||
    !isNullableString(value.auth_actor_id)
  ) {
    return undefined;
  }
  return value as unknown as ChatTurnCapabilityProfileRow;
}

function toScopeRow(value: unknown): ChatTurnCapabilityProfileScopeRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const required = ["profile_id", "turn_id", "session_id", "workspace_id", "profile_hash"];
  if (
    required.some((key) => typeof value[key] !== "string") ||
    !isNullableString(value.durable_run_id) ||
    !isNullableString(value.operator_id) ||
    !isNullableString(value.auth_actor_id)
  ) {
    return undefined;
  }
  return value as unknown as ChatTurnCapabilityProfileScopeRow;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
