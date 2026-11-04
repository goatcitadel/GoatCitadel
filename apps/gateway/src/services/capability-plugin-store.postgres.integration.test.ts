import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSkillHubManifestSha256, createPostgresRemoteStorage } from "@goatcitadel/storage";
import {
  canonicalJsonString,
  diffSkillPermissionEnvelopes,
  parsePluginManifest,
  type SkillHubOperationIntentTemplate,
} from "@goatcitadel/contracts";
import { acquireGatewayLivePostgresTestLease } from "../test/live-postgres-suite-lock.js";
import {
  PROMPTWARE_SCANNER_ID,
  PROMPTWARE_SCANNER_REVISION,
  PROMPTWARE_SCANNER_VERSION,
} from "./assembled-prompt-injection-guard.js";
import { CAPABILITY_PLUGINS_SETTING_KEY, CapabilityPluginStore } from "./capability-plugin-store.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS, McpServerStore } from "./mcp-server-store.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { readConnectorScope } from "./plugin-uninstall-scope.js";
import { captureSkillContentIntegrity } from "./skill-content-integrity.js";
import { NodeSkillHubArtifactFilesystem, SkillHubArtifactStore } from "./skill-hub-artifact-store.js";
import {
  buildSkillHubLifecycleApprovalInput,
  materializeApprovedSkillHubIntent,
  SkillHubLifecycleService,
} from "./skill-hub-lifecycle-service.js";
import { skillHubOperationFingerprint } from "./skill-hub-operation-identity.js";
import { NodeSkillHubWindowsSecurity, PowerShellSkillHubWindowsSecurityProtocol } from "./skill-hub-windows-security.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const template = {
  templateId: "shared", label: "Shared connector", description: "Test connector", transport: "http" as const,
  url: "https://example.invalid/mcp", authType: "none" as const, category: "data" as const,
  trustTier: "restricted" as const, costTier: "unknown" as const, policy: normalizeMcpPolicy(),
  enabledByDefault: false,
};
function manifestOf(pluginId: string) {
  const parsed = parsePluginManifest(JSON.stringify({
    schemaVersion: 1, pluginId, name: pluginId, description: "Test plugin", version: "1.0.0",
    pieces: [{ kind: "connector", id: "shared", templateId: "shared", asksFirst: "changes" }],
  }));
  if (!parsed.ok) throw new Error("The test manifest is invalid.");
  return parsed;
}

function plugin(pluginId: string, owned: boolean) {
  const treeSha256 = (owned ? "a" : "c").repeat(64);
  return {
    pluginId, name: pluginId, description: "Test plugin", version: "1.0.0", trust: "unverified" as const,
    sourceKind: "folder" as const, sourceDisplay: pluginId,
    pin: { kind: "content" as const, treeSha256 },
    manifestSha256: manifestOf(pluginId).manifestSha256, snapshotTreeSha256: treeSha256,
    workspaceId: "default", installPlanId: `install-${pluginId}`, state: "installed" as const,
    installedAt: "2026-11-02T00:00:00.000Z",
    pieces: [{ pieceId: "shared", kind: "connector" as const, owned, ...(owned ? { ref: "shared" } : {}) }],
  };
}

describe.skipIf(!connectionString)("plugin connector fence across independent PostgreSQL workers", { timeout: 120_000 }, () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const schema = `plugin_fence_${suffix}`;
  const workerBName = `plugin-fence-${suffix}-b`;
  let root: string;
  let admin: Pool;
  let lease: Awaited<ReturnType<typeof acquireGatewayLivePostgresTestLease>>;
  let a: ReturnType<typeof createPostgresRemoteStorage>;
  let b: ReturnType<typeof createPostgresRemoteStorage>;
  let pluginsA: CapabilityPluginStore;
  let pluginsB: CapabilityPluginStore;
  let connectorsA: McpServerStore;
  let connectorsB: McpServerStore;

  beforeAll(async () => {
    lease = await acquireGatewayLivePostgresTestLease(connectionString!);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-plugin-fence-pg-"));
    admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(connectionString!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const options = {
      migrationsTable: "schema_migrations", startupWaitTimeoutMs: 120_000,
      transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit"),
    };
    a = createPostgresRemoteStorage({
      ...options, connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1), applicationName: `plugin-fence-${suffix}-a`, pool: { max: 2 } },
    });
    await a.waitUntilReady();
    b = createPostgresRemoteStorage({
      ...options, connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1), applicationName: workerBName, pool: { max: 2 } },
    });
    await b.waitUntilReady();
    pluginsA = new CapabilityPluginStore(a.systemSettings);
    pluginsB = new CapabilityPluginStore(b.systemSettings);
    connectorsA = new McpServerStore({ systemSettings: a.systemSettings, runImmediateTransaction: (work) => a.runImmediateTransaction(work), approvalInbox: a.approvalInbox });
    connectorsB = new McpServerStore({ systemSettings: b.systemSettings, runImmediateTransaction: (work) => b.runImmediateTransaction(work), approvalInbox: b.approvalInbox });
  }, 120_000);

  afterAll(async () => {
    await b?.close();
    await a?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
    await lease?.release();
  }, 120_000);

  const txA = <T>(work: () => T | Promise<T>) => a.runImmediateTransaction(work);
  const txB = <T>(work: () => T | Promise<T>) => b.runImmediateTransaction(work);
  const callers = async () => (await connectorsB.readServers()).filter((server) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId));
  const scope = () => readConnectorScope({
    listPlugins: () => pluginsB.list(),
    readManifest: async (tree) => manifestOf(tree === "a".repeat(64) ? "owner" : "keeper"),
    listSavedConnectors: () => connectorsB.readServers(), connectorTemplates: () => [template],
    readInstallSecretRefs: async () => ({}), listHookSecrets: async () => [],
  }, plugin("owner", true), new Map());
  const blocked = () => vi.waitFor(async () => {
    const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [workerBName]);
    expect(result.rowCount).toBeGreaterThan(0);
  }, { timeout: 10_000, interval: 25 });

  beforeEach(async () => {
    await a.systemSettings.set(CAPABILITY_PLUGINS_SETTING_KEY, { version: 1, plugins: [plugin("owner", true)], inspections: [] });
    const now = new Date().toISOString();
    await connectorsA.writeServers([{
      serverId: "shared", label: template.label, transport: template.transport, url: template.url,
      authType: template.authType, category: template.category, trustTier: template.trustTier,
      costTier: template.costTier, policy: template.policy,
      enabled: false, status: "disconnected", createdAt: now, updatedAt: now,
      pluginOwner: { pluginId: "owner", name: "owner", installPlanId: "install-owner" },
    }], await callers());
  });

  it("blocks stale deletion until keeper commit, then requires fresh keeper scope", async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const keeper = pluginsA.withLock(txA, async () => {
      await pluginsA.update("keeper", () => plugin("keeper", false));
      entered();
      await gate;
    });
    await ready;
    let removed = false;
    const deletion = pluginsB.withLock(txB, async () => {
      removed = true;
      await connectorsB.writeServers([], await callers());
    });
    const refused = expect(deletion).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    try {
      await blocked();
      expect(removed).toBe(false);
    } finally {
      release();
      await keeper;
      await refused;
    }
    await pluginsB.withLock(txB, async () => {
      expect((await scope()).map((decision) => decision.action)).toEqual(["keep"]);
    });
    expect(await pluginsB.get("keeper")).toBeDefined();
    expect((await callers()).map((server) => server.serverId)).toEqual(["shared"]);
  });

  it("admits waiting deletion after keeper rollback and commits connector plus plugin removal", async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const keeper = pluginsA.withLock(txA, async () => {
      await pluginsA.update("keeper", () => plugin("keeper", false));
      entered();
      await gate;
      throw new Error("Roll back keeper");
    });
    const rolledBack = expect(keeper).rejects.toThrow("Roll back keeper");
    await ready;
    let removed = false;
    const deletion = pluginsB.withLock(txB, async () => {
      expect((await scope()).map((decision) => decision.action)).toEqual(["remove"]);
      await connectorsB.writeServers([], await callers());
      await pluginsB.update("owner", () => undefined);
      removed = true;
    });
    try {
      await blocked();
      expect(removed).toBe(false);
    } finally {
      release();
      await rolledBack;
      await deletion;
    }
    expect(await pluginsA.list()).toEqual([]);
    expect(await pluginsB.list()).toEqual([]);
    expect(await callers()).toEqual([]);
  });

  it("blocks a stale Skill Hub generation across independent PostgreSQL workers", async () => {
    const protocol = process.platform === "win32"
      ? new PowerShellSkillHubWindowsSecurityProtocol({ idleShutdownMs: Number.POSITIVE_INFINITY })
      : undefined;
    try {
      const filesystem = new NodeSkillHubArtifactFilesystem(
        protocol ? { windowsSecurity: new NodeSkillHubWindowsSecurity(protocol) } : {},
      );
      const skillRoot = await fs.mkdtemp(path.join(root, "generation-"));
      const sourceDir = path.join(skillRoot, "source");
      await fs.mkdir(sourceDir);
      await fs.writeFile(path.join(sourceDir, "SKILL.md"),
        "---\nname: pg-demo\ndescription: PostgreSQL fixture\nmetadata:\n  version: 1.0.0\n---\n\nUse this fixture skill.\n");
      const artifactStore = new SkillHubArtifactStore(path.join(skillRoot, "artifacts"), { filesystem });
      const { treeSha256 } = await captureSkillContentIntegrity(sourceDir);
      const bundle = await artifactStore.publishFromDirectory({ sourceDir, expectedTreeSha256: treeSha256 });
      const { workspaceId } = await a.workspaces.create({ name: "Plugin generation proof" });
      const snapshotId = "pg-generation-snapshot";
      const now = new Date().toISOString();
      const audit = {
        policyId: "skill-import", policyVersion: "2.0.0", policyRevision: 2,
        scanners: [{ scannerId: PROMPTWARE_SCANNER_ID, scannerVersion: PROMPTWARE_SCANNER_VERSION,
          revision: PROMPTWARE_SCANNER_REVISION, coverageIds: ["exact_bytes", "model_facing_md_txt", "multiline", "protective_negation"] }],
        findingCodes: [], blockerCodes: [], approvedBlockerResolutions: [],
      };
      const permissionEnvelope = {
        version: "goatcitadel.skill-permission-envelope.v1" as const,
        toolIds: [], environmentVariableNames: [], networkOrigins: [], filesystem: { readScopes: [], writeScopes: [] },
        scripts: [], dependencies: { packages: [], nativeRequirements: [] },
      };
      const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
      await a.skillHubSnapshots.create({
        snapshotId, workspaceId, operation: "install", sourceProvider: "goatcitadel_plugin", sourceType: "local_path",
        sourceRef: `plugin:skill-owner/pg-demo@content:${treeSha256}`, canonicalSourceKey: "plugin:skill-owner/pg-demo",
        declaredVersion: "1.0.0", contentTreeSha256: treeSha256, provenance: { capturedBy: "test" },
        audit, auditSha256: hash(audit), permissionEnvelope, permissionEnvelopeSha256: hash(permissionEnvelope),
        permissionDiff: { ...diffSkillPermissionEnvelopes(permissionEnvelope, permissionEnvelope) }, compatibility: {},
        riskLevel: "low", trustDisposition: "candidate", blockerCodes: [], createdAt: now,
      });
      await a.skillHubArtifacts.create({
        artifactId: "pg-generation-artifact", workspaceId, snapshotId, contentTreeSha256: treeSha256,
        bundleRelPath: bundle.bundleRelPath, manifest: bundle.manifest, manifestSha256: computeSkillHubManifestSha256(bundle.manifest),
        fileCount: bundle.manifest.fileCount, totalBytes: bundle.manifest.totalBytes, createdAt: now,
      });
      const originalInstall = "install-skill-owner";
      const replacementInstall = "replacement-skill-owner";
      const owner = {
        ...plugin("skill-owner", true), workspaceId,
        pieces: [{ kind: "skill" as const, pieceId: "pg-demo", owned: true, skillSnapshotId: snapshotId }],
      };
      await pluginsA.update(owner.pluginId, () => owner);
      const operation = {
        workspaceId, snapshotId, contentTreeSha256: treeSha256, operationKind: "install_inactive",
        skillId: "extra:pg-demo", targetCandidateId: "pg-generation-candidate", targetVersionId: "pg-generation-version",
        expectedCandidateAbsent: true, expectedRuntimeAbsent: true, actorId: "operator",
      } satisfies Omit<SkillHubOperationIntentTemplate, "operationId" | "idempotencyKey" | "createdAt">;
      const fingerprint = skillHubOperationFingerprint(operation, originalInstall);
      const pending = await a.approvals.create(buildSkillHubLifecycleApprovalInput({
        ...operation, operationId: `skill-hub-op-${fingerprint.slice(0, 32)}-1`,
        idempotencyKey: `skill-hub:lifecycle:${fingerprint}:1`, createdAt: now,
      }, originalInstall));
      const approved = await a.approvals.resolve(pending.approvalId, { decision: "approve", resolvedBy: "operator" });
      const intent = materializeApprovedSkillHubIntent(approved);
      await a.skillHubOperations.createIntent(intent);
      const lifecycle = new SkillHubLifecycleService({
        rootDir: skillRoot, candidateRoot: "candidates", skillsExtraRoot: "skills/extra", artifactStore,
        storage: b, filesystem,
      });
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const replacing = pluginsA.withLock(txA, async () => {
        await pluginsA.update(owner.pluginId, () => ({ ...owner, installPlanId: replacementInstall }));
        entered();
        await gate;
      });
      let attempted: Promise<unknown> | undefined;
      try {
        await Promise.race([ready, replacing.then(() => { throw new Error("Replacement ended before the lock barrier"); })]);
        const first = lifecycle.applyApprovedOperation(intent);
        attempted = expect(first).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
        void attempted.catch(() => undefined);
        await blocked();
        await expect(fs.stat(path.join(skillRoot, "candidates"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        release();
        await replacing;
        await attempted;
      }
      await expect(lifecycle.applyApprovedOperation(intent)).resolves.toMatchObject({
        settlement: { disposition: "blocked", result: { code: "plugin_install_authority_changed", boundaryCrossed: false } },
      });
      await expect(pluginsB.get(owner.pluginId)).resolves.toMatchObject({ installPlanId: replacementInstall });
      await expect(b.candidateSkillVersions.find(operation.targetVersionId)).resolves.toBeUndefined();
      await expect(b.skillLifecycle.find(operation.skillId)).resolves.toBeUndefined();
      await expect(fs.stat(path.join(skillRoot, "candidates"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(skillRoot, "skills", "extra"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      protocol?.dispose();
    }
  });
});
