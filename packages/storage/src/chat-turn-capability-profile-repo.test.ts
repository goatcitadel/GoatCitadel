import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  canonicalJsonString,
  mcpRequesterScopeHashMaterial,
  TOOL_EFFECT_CLASSIFICATION_VERSION,
  type CapabilityCatalogSnapshotRecord,
  type ChatTurnCapabilityProfileDraft,
  type ChatTurnCapabilityProfileRecord,
  type McpRequesterResolutionBindingMaterial,
  type ToolEffectPotentialRecord,
} from "@goatcitadel/contracts";
import {
  ChatTurnCapabilityProfileRepository,
  sealChatTurnCapabilityProfile,
  verifyChatTurnCapabilityProfile,
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilitySkillBindings,
} from "./index.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function createStore() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-capability-profile-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatTurnCapabilityProfileRepository(db) };
}

function buildDraft(): ChatTurnCapabilityProfileDraft {
  return {
    profileId: "chat-capability-profile-turn-1",
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      citadelId: "citadel-1",
      durableRunId: "run-1",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
    },
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: "snapshot-1",
      inspectableHash: "a".repeat(64),
      callableHash: "b".repeat(64),
      inspectableCount: 0,
      callableCount: 0,
    },
    selection: {
      contentHash: "c".repeat(64),
      requestedProviderId: "provider-1",
      requestedModel: "model-1",
      effectiveProviderId: "provider-1",
      effectiveModel: "model-1",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        contextManifestRef: `chat-memory-scope:${"d".repeat(64)}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "auto_when_useful",
      toolAutonomy: "manual",
      tools: [],
      modelNameAllowMap: [],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: {
        profileId: "safe",
        approvalMode: "approve_all",
        profileHash: "e".repeat(64),
      },
      policyDecisions: [],
      authReadiness: [
        { kind: "provider", ref: "provider-1", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "channel-binding-1", status: "ready", reasonCodes: [] },
      ],
      approval: {
        mode: "approve_all",
        selectedToolCount: 0,
        toolsRequiringApproval: [],
        approvalGranted: false,
      },
    },
    preflightFingerprint: "f".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}

function buildDraftWithProviderDefinition(
  providerDefinition: Record<string, unknown>,
  suffix: string,
): ChatTurnCapabilityProfileDraft {
  const draft = buildDraft();
  draft.profileId = `chat-capability-profile-${suffix}`;
  draft.identity.turnId = `turn-${suffix}`;
  const definitionHash = createHash("sha256").update(canonicalJsonString(providerDefinition)).digest("hex");
  draft.catalog.inspectableCount = 1;
  draft.catalog.callableCount = 1;
  draft.selection.tools = [
    {
      canonicalName: "credential_probe",
      modelName: "credential_probe",
      definitionHash,
      providerDefinition,
    },
  ];
  draft.selection.modelNameAllowMap = [{ modelName: "credential_probe", canonicalName: "credential_probe" }];
  draft.governance.policyDecisions = [
    {
      toolName: "credential_probe",
      allowed: true,
      requiresApproval: true,
      reasonCodes: ["approval_required"],
    },
  ];
  draft.governance.authReadiness.push({
    kind: "tool",
    ref: "credential_probe",
    status: "unknown",
    reasonCodes: ["runtime_auth_check_required"],
  });
  draft.governance.approval.selectedToolCount = 1;
  draft.governance.approval.toolsRequiringApproval = ["credential_probe"];
  return draft;
}

function credentialToolDefinition(apiKeySchema: unknown): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "credential_probe",
      description: "Checks whether a provider credential is configured without persisting it.",
      parameters: {
        type: "object",
        properties: {
          apiKey: apiKeySchema,
        },
      },
    },
  };
}

function addRequesterMcpBinding(draft: ChatTurnCapabilityProfileDraft): void {
  const tool = draft.selection.tools[0]!;
  tool.canonicalName = "mcp.tenant-mcp.search";
  tool.runtimeOwner = { kind: "builtin", bindingHash: "1".repeat(64) };
  draft.selection.modelNameAllowMap[0]!.canonicalName = tool.canonicalName;
  draft.governance.policyDecisions[0]!.toolName = tool.canonicalName;
  draft.governance.authReadiness.at(-1)!.kind = "mcp";
  draft.governance.authReadiness.at(-1)!.ref = tool.canonicalName;
  draft.governance.approval.toolsRequiringApproval = [tool.canonicalName];
  const material: McpRequesterResolutionBindingMaterial = {
    schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
    mode: "requester_scoped",
    serverId: "tenant-mcp",
    toolName: tool.canonicalName,
    resolverId: "gateway.tenant-mcp",
    resolverVersion: "1.2.3",
    resolverConfigGeneration: 4,
    requesterScopeSha256: createHash("sha256")
      .update(
        canonicalJsonString(
          mcpRequesterScopeHashMaterial({
            profileId: draft.profileId,
            turnId: draft.identity.turnId,
            sessionId: draft.identity.sessionId,
            workspaceId: draft.identity.workspaceId,
            authActorId: draft.identity.authActorId!,
            authActorSource: draft.identity.authActorSource as "token",
          }),
        ),
      )
      .digest("hex"),
    serverConfigRevision: 7,
    serverConfigSha256: "3".repeat(64),
    transportPolicySha256: "4".repeat(64),
    callableCatalogSnapshotId: draft.catalog.snapshotId,
    callableCatalogSha256: draft.catalog.callableHash,
  };
  tool.mcpRequesterResolution = {
    ...material,
    bindingSha256: createHash("sha256").update(canonicalJsonString(material)).digest("hex"),
  };
}

function refreshRequesterBindingHash(draft: ChatTurnCapabilityProfileDraft): void {
  const binding = draft.selection.tools[0]!.mcpRequesterResolution!;
  const { bindingSha256: _prior, ...material } = binding;
  binding.bindingSha256 = createHash("sha256").update(canonicalJsonString(material)).digest("hex");
}

type TestDatabase = ReturnType<typeof createDatabase>;

function seedFrozenSessionIncarnation(db: TestDatabase, profile: ChatTurnCapabilityProfileRecord) {
  const { workspaceId, sessionId, turnId } = profile.identity;
  new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-1",
    idempotencyKey: `lifecycle:init:${sessionId}`,
    correlationId: `correlation:init:${sessionId}`,
  });
  const admissions = new SessionMutationAdmissionRepository(db);
  const admitted = admissions.admit({
    workspaceId,
    sessionId,
    turnId,
    runtimeOwnerId: `runtime-${turnId}`,
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "system",
    actorId: "system:test",
    operation: "chat.turn.execute",
    materialSha256: createHash("sha256").update(`material:${turnId}`).digest("hex"),
    idempotencyKey: `admission:${turnId}`,
    correlationId: `correlation:${turnId}`,
  }).admission;
  return { admissions, admitted };
}

// The profile-binding FK to chat_turn_capability_profiles is DEFERRABLE INITIALLY
// DEFERRED, so the incarnation binding and the profile row must commit in the same
// immediate transaction, mirroring how production seals a turn_write admission
// around every profile insert.
function createWithFrozenIncarnation(
  db: TestDatabase,
  repo: ChatTurnCapabilityProfileRepository,
  profile: ChatTurnCapabilityProfileRecord,
): ChatTurnCapabilityProfileRecord {
  const { admissions, admitted } = seedFrozenSessionIncarnation(db, profile);
  return db.transaction("immediate", () => {
    admissions.bindCapabilityProfile({
      admissionId: admitted.admissionId,
      workspaceId: admitted.workspaceId,
      sessionId: admitted.sessionId,
      sessionIncarnationId: admitted.sessionIncarnationId,
      turnId: admitted.turnId!,
      profileId: profile.profileId,
      profileHash: profile.hashes.profileHash,
      createdAt: profile.createdAt,
      requestRuntimeClaim: {
        runtimeOwnerId: admitted.runtimeOwnerId!,
        leaseRevision: admitted.runtimeLeaseRevision!,
      },
    });
    return repo.create(profile);
  });
}

describe("ChatTurnCapabilityProfileRepository", () => {
  it("round-trips a sealed profile and exposes explicit legacy absence", () => {
    const { db, repo } = createStore();
    const profile = sealChatTurnCapabilityProfile(buildDraft());

    assert.deepEqual(createWithFrozenIncarnation(db, repo, profile), profile);
    assert.deepEqual(repo.get(profile.profileId), profile);
    assert.deepEqual(repo.findByTurn(profile.identity.turnId), profile);
    assert.deepEqual(repo.findByRun(profile.identity.durableRunId as string), profile);
    assert.deepEqual(repo.findScopeByTurn(profile.identity.turnId), {
      profileId: profile.profileId,
      turnId: profile.identity.turnId,
      sessionId: profile.identity.sessionId,
      workspaceId: profile.identity.workspaceId,
      durableRunId: profile.identity.durableRunId,
      operatorId: profile.identity.operatorId,
      authActorId: profile.identity.authActorId,
      profileHash: profile.hashes.profileHash,
    });
    assert.deepEqual(repo.inspectByTurn("legacy-turn"), { state: "legacy_missing" });
    db.close();
  });

  it("round-trips profiles whose optional durable and actor bindings are all null", () => {
    const { db, repo } = createStore();
    const draft = buildDraft();
    delete draft.identity.durableRunId;
    delete draft.identity.operatorId;
    delete draft.identity.authActorId;
    const profile = sealChatTurnCapabilityProfile(draft);

    assert.deepEqual(createWithFrozenIncarnation(db, repo, profile), profile);
    assert.deepEqual(repo.get(profile.profileId), profile);
    assert.deepEqual(repo.findScopeByTurn(profile.identity.turnId), {
      profileId: profile.profileId,
      turnId: profile.identity.turnId,
      sessionId: profile.identity.sessionId,
      workspaceId: profile.identity.workspaceId,
      profileHash: profile.hashes.profileHash,
    });
    const persistedBindings = db
      .prepare(
        `SELECT durable_run_id, operator_id, auth_actor_id
         FROM chat_turn_capability_profiles
         WHERE profile_id = ?`,
      )
      .get<{ durable_run_id: unknown; operator_id: unknown; auth_actor_id: unknown }>(profile.profileId);
    assert.equal(persistedBindings?.durable_run_id, null);
    assert.equal(persistedBindings?.operator_id, null);
    assert.equal(persistedBindings?.auth_actor_id, null);
    db.close();
  });

  it("fails closed instead of returning malformed optional authority bindings", () => {
    for (const column of ["durable_run_id", "operator_id", "auth_actor_id"] as const) {
      const { db, repo } = createStore();
      const profile = sealChatTurnCapabilityProfile(buildDraft());
      createWithFrozenIncarnation(db, repo, profile);
      db.exec("DROP TRIGGER trg_chat_turn_capability_profiles_no_update");
      db.prepare(
        `UPDATE chat_turn_capability_profiles
         SET ${column} = X'01'
         WHERE profile_id = ?`,
      ).run(profile.profileId);

      const raw = db
        .prepare(`SELECT ${column} AS malformed_value FROM chat_turn_capability_profiles WHERE profile_id = ?`)
        .get<{ malformed_value: unknown }>(profile.profileId);
      assert.notEqual(raw?.malformed_value, null, `${column} fixture must not be null`);
      assert.notEqual(typeof raw?.malformed_value, "string", `${column} fixture must not be a string`);
      assert.equal(repo.findByTurn(profile.identity.turnId), undefined, `${column} must fail the full-row decoder`);
      assert.equal(
        repo.findScopeByTurn(profile.identity.turnId),
        undefined,
        `${column} must never escape through the narrow authorization-scope read`,
      );
      db.close();
    }
  });

  it("round-trips only a secret-free exact requester-scoped MCP binding", () => {
    const { db, repo } = createStore();
    const draft = buildDraftWithProviderDefinition(
      {
        type: "function",
        function: {
          name: "credential_probe",
          description: "Search an authenticated tenant source.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      "requester-mcp",
    );
    addRequesterMcpBinding(draft);
    const profile = sealChatTurnCapabilityProfile(draft);

    assert.deepEqual(createWithFrozenIncarnation(db, repo, profile), profile);
    assert.doesNotMatch(canonicalJsonString(repo.get(profile.profileId)), /https?:|authorization|never-store-this/u);

    const smuggledDraft = structuredClone(draft);
    Object.assign(smuggledDraft.selection.tools[0]!.mcpRequesterResolution as object, {
      url: "https://secret.example.test/path?token=never-store-this",
    });
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(smuggledDraft)),
      /requester resolution binding contains unsupported fields/,
    );
    db.close();
  });

  it("binds requester-scoped MCP to exact auth, tool, catalog, and Gateway runtime ownership", () => {
    const { db, repo } = createStore();
    const base = buildDraftWithProviderDefinition(
      {
        type: "function",
        function: {
          name: "credential_probe",
          description: "Search an authenticated tenant source.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      "requester-binding-adversarial",
    );
    addRequesterMcpBinding(base);

    const wrongRequester = structuredClone(base);
    wrongRequester.selection.tools[0]!.mcpRequesterResolution!.requesterScopeSha256 = "9".repeat(64);
    refreshRequesterBindingHash(wrongRequester);
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(wrongRequester)),
      /does not match its authenticated requester authority/,
    );

    const wrongTool = structuredClone(base);
    wrongTool.selection.tools[0]!.mcpRequesterResolution!.toolName = "mcp.tenant-mcp.other";
    refreshRequesterBindingHash(wrongTool);
    assert.throws(() => repo.create(sealChatTurnCapabilityProfile(wrongTool)), /names a different tool/);

    const wrongCatalog = structuredClone(base);
    wrongCatalog.selection.tools[0]!.mcpRequesterResolution!.callableCatalogSha256 = "8".repeat(64);
    refreshRequesterBindingHash(wrongCatalog);
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(wrongCatalog)),
      /does not match the callable catalog/,
    );

    const pluginOwned = structuredClone(base);
    pluginOwned.selection.tools[0]!.runtimeOwner = { kind: "plugin", bindingHash: "1".repeat(64) };
    assert.throws(() => repo.create(sealChatTurnCapabilityProfile(pluginOwned)), /not Gateway-owned/);

    const unauthenticated = structuredClone(base);
    unauthenticated.identity.authActorSource = "sse";
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(unauthenticated)),
      /lacks authenticated requester authority/,
    );
    db.close();
  });

  it("round-trips the exact mesh publication snapshot and rejects malformed or plugin-owned bindings", () => {
    const { db, repo } = createStore();
    const base = buildDraftWithProviderDefinition(
      {
        type: "function",
        function: {
          name: "credential_probe",
          description: "Invoke one mesh-published tool.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      "mesh-publication",
    );
    const tool = base.selection.tools[0]!;
    tool.runtimeOwner = { kind: "builtin", bindingHash: "1".repeat(64) };
    tool.meshPublication = {
      nodeId: "node-a",
      publisherGeneration: 3,
      manifestSha256: "d".repeat(64),
      entrySha256: "e".repeat(64),
      activationId: `mesh-activation-${"f".repeat(48)}`,
      activationRevision: 2,
      publicationLeaseFencingToken: 5,
      permissionEnvelopeSha256: "a".repeat(64),
      effectPosture: "read_only",
      healthGeneration: 4,
    };
    const profile = sealChatTurnCapabilityProfile(base);
    assert.deepEqual(createWithFrozenIncarnation(db, repo, profile), profile);
    assert.deepEqual(repo.get(profile.profileId).selection.tools[0]!.meshPublication, tool.meshPublication);

    const badDigest = structuredClone(base);
    badDigest.selection.tools[0]!.meshPublication!.manifestSha256 = "not-a-digest";
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(badDigest)),
      /meshPublication\.manifestSha256 must be a lowercase sha256 digest/,
    );

    const badRevision = structuredClone(base);
    badRevision.selection.tools[0]!.meshPublication!.activationRevision = 0;
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(badRevision)),
      /meshPublication\.activationRevision must be a positive integer/,
    );

    const badPosture = structuredClone(base);
    (badPosture.selection.tools[0]!.meshPublication as { effectPosture: string }).effectPosture = "harmless";
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(badPosture)),
      /meshPublication effect posture is invalid/,
    );

    const pluginOwned = structuredClone(base);
    pluginOwned.selection.tools[0]!.runtimeOwner = { kind: "plugin", bindingHash: "1".repeat(64) };
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(pluginOwned)),
      /mesh publication is not Gateway-owned/,
    );
    db.close();
  });

  it("rejects updates, deletes, conflicting re-inserts, and detects storage tampering", () => {
    const { db, repo } = createStore();
    const profile = sealChatTurnCapabilityProfile(buildDraft());
    createWithFrozenIncarnation(db, repo, profile);

    assert.throws(
      () =>
        db
          .prepare("UPDATE chat_turn_capability_profiles SET session_id = ? WHERE profile_id = ?")
          .run("other", profile.profileId),
      /immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM chat_turn_capability_profiles WHERE profile_id = ?").run(profile.profileId),
      /immutable/,
    );

    // A conflicting re-insert no longer reaches the repo's upsert: the incarnation
    // insert guard aborts first because the sealed binding hash no longer matches.
    // Peel that outer layer, as the tampering step below does, to prove the repo's
    // own immutable-record backstop still holds.
    db.exec("DROP TRIGGER trg_chat_turn_capability_profiles_incarnation_insert_guard");
    const conflicting = sealChatTurnCapabilityProfile({
      ...buildDraft(),
      source: { channel: "chat", account: "other" },
    });
    assert.throws(() => repo.create(conflicting), /conflicts with an existing immutable record/);

    db.exec("DROP TRIGGER trg_chat_turn_capability_profiles_no_update");
    db.prepare("UPDATE chat_turn_capability_profiles SET profile_json = ? WHERE profile_id = ?").run(
      JSON.stringify({ ...profile, profileId: "tampered-profile" }),
      profile.profileId,
    );
    const inspection = repo.inspectByTurn(profile.identity.turnId);
    assert.deepEqual(inspection, {
      state: "invalid",
      error: "Persisted capability profile failed integrity verification.",
    });
    assert.doesNotMatch(inspection.error ?? "", /tampered-profile|column bindings|profileHash/);
    db.close();
  });

  it("fails closed on deep, oversized, secret-bearing, and hash-corrupt profiles", () => {
    const { db, repo } = createStore();

    const deepDraft = structuredClone(buildDraft()) as ChatTurnCapabilityProfileDraft & {
      source: Record<string, unknown>;
    };
    let nested: Record<string, unknown> = {};
    deepDraft.source.extra = nested;
    for (let index = 0; index < 20; index += 1) {
      nested.child = {};
      nested = nested.child as Record<string, unknown>;
    }
    assert.throws(() => repo.create(sealChatTurnCapabilityProfile(deepDraft)), /JSON depth limit/);

    const oversized = buildDraft();
    oversized.source.account = "x".repeat(140_000);
    assert.throws(() => repo.create(sealChatTurnCapabilityProfile(oversized)), /not safely bounded/);

    const secretBearing = buildDraft();
    secretBearing.source.account = "api_key=0123456789abcdef0123456789abcdef";
    assert.throws(() => repo.create(sealChatTurnCapabilityProfile(secretBearing)), /secret-like material/);

    const hashCorrupt = sealChatTurnCapabilityProfile(buildDraft());
    hashCorrupt.hashes.profileHash = "0".repeat(64);
    assert.throws(() => createWithFrozenIncarnation(db, repo, hashCorrupt), /profileHash verification/);
    db.close();
  });

  it("allows credential-named schema metadata but rejects credential defaults, examples, enums, and direct values", () => {
    const { db, repo } = createStore();
    const safeDefinition = credentialToolDefinition({
      type: "string",
      description: "Operator-supplied API key. The runtime reads it from the secret store.",
      minLength: 1,
    });
    const safe = sealChatTurnCapabilityProfile(buildDraftWithProviderDefinition(safeDefinition, "safe-api-key-schema"));
    assert.equal(createWithFrozenIncarnation(db, repo, safe).profileId, safe.profileId);

    const credentialValues: Array<[string, unknown]> = [
      ["short-default", { type: "string", default: "hunter2" }],
      ["long-const", { type: "string", const: "z".repeat(96) }],
      ["short-example", { type: "string", example: "abc123" }],
      ["mixed-examples", { type: "string", examples: ["tiny", "q".repeat(128)] }],
      ["short-enum", { type: "string", enum: ["alpha", "beta"] }],
      ["direct-scalar", "hunter2"],
    ];
    for (const [suffix, schema] of credentialValues) {
      const rejected = sealChatTurnCapabilityProfile(
        buildDraftWithProviderDefinition(credentialToolDefinition(schema), suffix),
      );
      assert.throws(() => repo.create(rejected), /credential value/);
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS count FROM chat_turn_capability_profiles WHERE profile_id = ?")
          .get<{ count: number }>(rejected.profileId)?.count,
        0,
      );
      assert.deepEqual(repo.inspectByTurn(rejected.identity.turnId), { state: "legacy_missing" });
    }
    db.close();
  });

  it("rejects invalid retrieval modes, provider-name drift, and imported skills without exact bytes", () => {
    const { db, repo } = createStore();

    const invalidRetrieval = buildDraft();
    (invalidRetrieval.selection.memory as { retrievalMode: string }).retrievalMode = "unbounded";
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(invalidRetrieval)),
      /memory retrieval mode is invalid/,
    );

    const providerNameDrift = buildDraftWithProviderDefinition(
      {
        type: "function",
        function: { name: "different_model_name", parameters: { type: "object" } },
      },
      "provider-name-drift",
    );
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(providerNameDrift)),
      /provider name binding is invalid/,
    );

    const missingExactBytes = buildDraft();
    missingExactBytes.profileId = "chat-capability-profile-imported-skill";
    missingExactBytes.identity.turnId = "turn-imported-skill";
    missingExactBytes.catalog.inspectableCount = 1;
    missingExactBytes.catalog.callableCount = 1;
    missingExactBytes.selection.trustedSkills = [
      {
        capabilityId: "skill:imported-review",
        skillId: "imported-review",
        category: "community_imported",
        lifecycleState: "approved",
        trustLabel: "Reviewed import",
        source: "extra",
      },
    ];
    missingExactBytes.governance.authReadiness.push({
      kind: "skill",
      ref: "imported-review",
      status: "unknown",
      reasonCodes: ["missing_exact_bytes"],
    });
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(missingExactBytes)),
      /lacks exact-byte integrity evidence/,
    );

    assert.equal(typeof verifyChatTurnCapabilityCatalogBinding, "function");
    assert.equal(typeof verifyChatTurnCapabilitySkillBindings, "function");
    const collisionEntry = {
      capabilityId: "tool:collision",
      kind: "tool" as const,
      category: "built_in" as const,
      title: "Collision",
      summary: "Ambiguous duplicate entry.",
      callable: true,
      toolName: "collision",
    };
    assert.throws(
      () =>
        verifyChatTurnCapabilityCatalogBinding(sealChatTurnCapabilityProfile(buildDraft()), {
          snapshotId: "snapshot-1",
          inspectableEntries: [collisionEntry, collisionEntry],
          callableEntries: [collisionEntry, collisionEntry],
          createdAt: "2026-07-13T00:00:00.000Z",
        }),
      /capability-id collision/,
    );
    db.close();
  });

  it("rejects whitespace-bearing skill capability ids and seals identifier-safe bundled skill ids", () => {
    const { db, repo } = createStore();

    // Regression: the bundled self-improvement skill once shipped the spaced
    // frontmatter name "GoatCitadel Native Safe Improvement", which reached
    // this repository inside `skill:<skillId>` and failed every routed-context
    // send at seal time. The skills loader now rejects such names at load
    // time; this pins the storage contract both ways.
    const spaced = buildDraft();
    spaced.profileId = "chat-capability-profile-spaced-skill";
    spaced.identity.turnId = "turn-spaced-skill";
    spaced.catalog.inspectableCount = 1;
    spaced.catalog.callableCount = 1;
    spaced.selection.trustedSkills = [
      {
        capabilityId: "skill:bundled:GoatCitadel Native Safe Improvement",
        skillId: "bundled:GoatCitadel Native Safe Improvement",
        category: "built_in",
        lifecycleState: "trusted",
        trustLabel: "Built-in",
        source: "bundled",
      },
    ];
    assert.throws(
      () => repo.create(sealChatTurnCapabilityProfile(spaced)),
      /trustedSkills\.capabilityId contains invalid identifier characters/,
    );

    const sealed = buildDraft();
    sealed.profileId = "chat-capability-profile-slug-skill";
    sealed.identity.turnId = "turn-slug-skill";
    sealed.catalog.inspectableCount = 1;
    sealed.catalog.callableCount = 1;
    sealed.selection.trustedSkills = [
      {
        capabilityId: "skill:bundled:goatcitadel-native-safe-self-improvement",
        skillId: "bundled:goatcitadel-native-safe-self-improvement",
        category: "built_in",
        lifecycleState: "trusted",
        trustLabel: "Built-in",
        source: "bundled",
        contentIntegrityManifestVersion: "goatcitadel.skill-tree.v1",
        treeSha256: "f".repeat(64),
        contentFileCount: 1,
        contentBytes: 2_048,
      },
    ];
    sealed.governance.authReadiness.push({
      kind: "skill",
      ref: "bundled:goatcitadel-native-safe-self-improvement",
      status: "ready",
      reasonCodes: ["verified_content_integrity"],
    });
    const created = createWithFrozenIncarnation(db, repo, sealChatTurnCapabilityProfile(sealed));
    assert.equal(
      created.selection.trustedSkills[0]?.capabilityId,
      "skill:bundled:goatcitadel-native-safe-self-improvement",
    );
    db.close();
  });

  it("binds tool-effect potential into immutable selection and catalog hashes", () => {
    const providerDefinition = credentialToolDefinition({ type: "string" });
    const noEffect: ToolEffectPotentialRecord = {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      potential: "none",
      sourceKind: "builtin",
      reason: "trusted_builtin_safe_read",
    };
    const unknownEffect: ToolEffectPotentialRecord = {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      potential: "unknown",
      sourceKind: "remote",
      reason: "remote_runtime_may_cross_boundary",
    };
    const buildSnapshot = (effectPotential: ToolEffectPotentialRecord): CapabilityCatalogSnapshotRecord => {
      const entry = {
        capabilityId: "tool:credential_probe",
        kind: "tool" as const,
        category: "built_in" as const,
        title: "Credential probe",
        summary: "Read provider credential readiness.",
        callable: true,
        toolName: "credential_probe",
        effectPotential,
      };
      return {
        snapshotId: `snapshot-${effectPotential.potential}`,
        inspectableEntries: [entry],
        callableEntries: [entry],
        createdAt: "2026-07-13T00:00:00.000Z",
      };
    };
    const buildBoundDraft = (
      effectPotential: ToolEffectPotentialRecord,
      snapshot: CapabilityCatalogSnapshotRecord,
    ): ChatTurnCapabilityProfileDraft => {
      const draft = buildDraftWithProviderDefinition(providerDefinition, `effect-${effectPotential.potential}`);
      draft.catalog = {
        snapshotId: snapshot.snapshotId,
        inspectableHash: createHash("sha256").update(canonicalJsonString(snapshot.inspectableEntries)).digest("hex"),
        callableHash: createHash("sha256").update(canonicalJsonString(snapshot.callableEntries)).digest("hex"),
        inspectableCount: 1,
        callableCount: 1,
      };
      draft.selection.tools[0]!.effectPotential = effectPotential;
      return draft;
    };

    const noEffectSnapshot = buildSnapshot(noEffect);
    const unknownEffectSnapshot = buildSnapshot(unknownEffect);
    const noEffectProfile = sealChatTurnCapabilityProfile(buildBoundDraft(noEffect, noEffectSnapshot));
    const unknownEffectProfile = sealChatTurnCapabilityProfile(buildBoundDraft(unknownEffect, unknownEffectSnapshot));

    verifyChatTurnCapabilityCatalogBinding(noEffectProfile, noEffectSnapshot);
    verifyChatTurnCapabilityCatalogBinding(unknownEffectProfile, unknownEffectSnapshot);
    assert.notEqual(noEffectProfile.catalog.callableHash, unknownEffectProfile.catalog.callableHash);
    assert.notEqual(noEffectProfile.hashes.catalogHash, unknownEffectProfile.hashes.catalogHash);
    assert.notEqual(noEffectProfile.hashes.selectionHash, unknownEffectProfile.hashes.selectionHash);
    assert.notEqual(noEffectProfile.hashes.profileHash, unknownEffectProfile.hashes.profileHash);

    const tampered = structuredClone(noEffectProfile);
    tampered.selection.tools[0]!.effectPotential = unknownEffect;
    assert.throws(() => verifyChatTurnCapabilityProfile(tampered), /selectionHash verification/);

    const crossBound = sealChatTurnCapabilityProfile(buildBoundDraft(noEffect, unknownEffectSnapshot));
    assert.throws(
      () => verifyChatTurnCapabilityCatalogBinding(crossBound, unknownEffectSnapshot),
      /tool effect potential has drifted from its catalog/,
    );
  });
});

describe("chat capability profile schema parity", () => {
  it("installs immutable SQLite migration 154 and Postgres migration 96", () => {
    const { db } = createStore();
    const migration = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 154")
      .get<{ version: number; name: string }>();
    assert.deepEqual({ ...migration }, { version: 154, name: "chat_turn_capability_profiles" });
    const columns = db.prepare("PRAGMA table_info(chat_turn_capability_profiles)").all<{ name: string }>();
    assert.ok(columns.some((column) => column.name === "profile_hash"));
    assert.ok(columns.some((column) => column.name === "preflight_fingerprint"));
    assert.ok(columns.some((column) => column.name === "operator_id"));
    assert.ok(columns.some((column) => column.name === "auth_actor_id"));
    db.close();

    const postgres = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 96);
    assert.equal(postgres?.name, "chat_turn_capability_profiles");
    for (const token of [
      "CREATE TABLE IF NOT EXISTS chat_turn_capability_profiles",
      "octet_length(profile_json) <= 524288",
      "gc_reject_chat_turn_capability_profile_mutation",
      "trg_chat_turn_capability_profiles_no_update",
      "trg_chat_turn_capability_profiles_no_delete",
    ]) {
      assert.match(postgres?.sql ?? "", new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
