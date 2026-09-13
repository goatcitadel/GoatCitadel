import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ChangePlanRecord, McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import { CapabilityPackService } from "./capability-pack-service.js";
import { CapabilityPackChangePlanAdapter } from "./capability-pack-change-plan-adapter.js";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService } from "./evolution-control-plane-service.js";
import { readCandidateSkillArtifacts } from "./candidate-skill-artifact-review.js";
import { compensatePackMcpServer } from "./capability-pack-mcp-owner.js";
import type { McpServerAdminHost } from "./mcp-server-admin-service.js";

const resources: { root: string; storage: Storage }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    item.storage.close();
    await fs.rm(item.root, { recursive: true, force: true });
  }
});
async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-pack-execution-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  resources.push({ root, storage });
  const asyncStorage = createSqliteAsyncStorage(storage);
  const catalog = new CapabilityPackService({ evidenceEnvelopeService: {} as never });
  const servers: McpServerRecord[] = [];
  const tools: McpToolRecord[] = [];
  const features: Record<string, boolean> = {};
  const settings = { revision: 1 };
  let approved = false;
  const createServer = vi.fn(async (input, serverId, planId) => {
    const record = {
      ...input,
      serverId,
      packChange: { planId, revision: 1, phase: "apply", created: true },
      status: "disconnected",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    } as McpServerRecord;
    servers.push(record);
    return record;
  });
  const mcpHost = {
    readMcpServers: async () => servers,
    requireMcpServer: async (id: string) => servers.find((server) => server.serverId === id)!,
    writeMcpServers: async (updated: McpServerRecord[]) => {
      servers.splice(0, servers.length, ...updated);
    },
  } as McpServerAdminHost;
  const compensateMcp = vi.fn((input) => compensatePackMcpServer(mcpHost, input));
  const candidateDetail = vi.fn(async () => ({ activationBlocked: true }) as never);
  const connect = vi.fn(async (id) => {
    const server = servers.find((item) => item.serverId === id)!;
    server.status = "connected";
    for (const toolName of ["browser_navigate", "browser_snapshot", "browser_take_screenshot"]) {
      tools.push({ serverId: id, toolName, enabled: true, updatedAt: server.updatedAt });
    }
    return server;
  });
  const adapter = new CapabilityPackChangePlanAdapter({
    storage: asyncStorage,
    rootDir: root,
    candidateRoot: "candidates",
    listPacks: () => catalog.listPacks(),
    readMcpServers: async () => servers,
    readMcpTools: async () => tools,
    createMcpServer: createServer,
    enableMcpServer: async (id, planId) => {
      const server = servers.find((item) => item.serverId === id)!;
      server.enabled = true;
      server.packChange = {
        planId,
        revision: server.packChange?.planId === planId ? server.packChange.revision + 1 : 1,
        phase: "apply",
        created: server.packChange?.planId === planId && server.packChange.created,
      };
      return server;
    },
    compensateMcp,
    connectMcpServer: connect,
    readFeatures: async () => features,
    readSettingsSnapshot: async () => ({ ...settings, features }),
    getCandidateDetail: candidateDetail,
    cancelChild: async (_parent, child) =>
      asyncStorage.changePlans.transition(child.planId, {
        expectedRevision: child.revision,
        status: "cancelled",
        internal: true,
        eventType: "cancelled",
        actorId: "operator",
      }),
    createChild: async (parent, request, idempotencyKey) =>
      asyncStorage.changePlans.create({
        origin: parent.origin,
        request,
        adapter: { adapterId: "test-child", version: 1 },
        target: { ownerId: "test-child", resourceId: idempotencyKey, expectedRevision: settings.revision },
        title: "Review child",
        summary: "Separate owner action",
        impact: "No effect until reviewed",
        risk: "caution",
        status: "awaiting_confirmation",
        requiredAction: {
          kind: "confirmation",
          actionId: idempotencyKey,
          actionNonce: idempotencyKey,
          title: "Confirm child",
          confirmationText: "Confirm exact child",
        },
        idempotencyKey,
      }),
  });
  const plane = new EvolutionControlPlaneService({
    repository: asyncStorage.changePlans,
    adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
    createApproval: async () => "pack-approval",
    getApprovalDisposition: () => (approved ? "approved" : "pending"),
  });
  const actor = { workspaceId: "default", actorId: "operator", surface: "settings" as const };
  const manifest = catalog.listPacks()[0]!;
  const create = (assetIds: string[]) =>
    plane.create({
      actor,
      request: {
        kind: "capability_pack",
        packId: manifest.packId,
        manifestHash: manifest.provenance.contentHash!,
        assetIds,
      },
    });
  const execute = async (plan: ChangePlanRecord) => {
    const pending = await plane.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    expect(createServer).not.toHaveBeenCalled();
    expect(pending.status).toBe("awaiting_approval");
    approved = true;
    return plane.resumeApproved(actor, pending.planId, pending.revision, "pack-approval");
  };
  return {
    root,
    storage,
    asyncStorage,
    adapter,
    plane,
    actor,
    manifest,
    servers,
    tools,
    features,
    settings,
    compensateMcp,
    candidateDetail,
    createServer,
    connect,
    create,
    execute,
  };
}

describe("capability pack execution", () => {
  it("compensates a failed owned MCP connection and records durable rollback", async () => {
    const h = await harness();
    h.connect.mockRejectedValueOnce(new Error("controlled connection failure"));
    const failed = await h.execute(await h.create(["playwright"]));
    const pending = await h.plane.requestRollback(h.actor, failed.planId, failed.revision);
    const rolledBack = await h.plane.confirm(
      h.actor,
      pending.planId,
      pending.revision,
      pending.requiredAction!.actionNonce,
    );
    expect(rolledBack.status, JSON.stringify(rolledBack.result)).toBe("rolled_back");
    expect(h.servers[0]).toMatchObject({
      enabled: false,
      packChange: { planId: failed.planId, phase: "compensate", revision: 3 },
    });
    expect(h.servers).toHaveLength(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect((await h.adapter.reconcile({} as never, { ...rolledBack, status: "rolling_back" })).status).toBe(
      "rolled_back",
    );
  });
  it("preserves later MCP edits during compensation", async () => {
    const h = await harness();
    const installed = await h.execute(await h.create(["playwright"]));
    h.servers[0]!.args = [...h.servers[0]!.args!, "--browser", "firefox"];
    h.servers[0]!.packChange = undefined;
    const pending = await h.plane.requestRollback(h.actor, installed.planId, installed.revision);
    const result = await h.plane.confirm(
      h.actor,
      pending.planId,
      pending.revision,
      pending.requiredAction!.actionNonce,
    );
    expect(result.status).toBe("manual_required");
    expect(h.servers[0]!.enabled).toBe(true);
    expect(result.result?.summary).toContain("preserved");
  });
  it("creates a reviewed inverse settings plan only at the applied owner revision", async () => {
    const h = await harness();
    h.features.computerUseGuardrailsV1Enabled = false;
    const result = await h.execute(await h.create(["cowork-run-map-browser-proof"]));
    const child = (await h.asyncStorage.changePlans.list({ workspaceId: "default" })).find(
      (plan) => plan.kind === "runtime_configuration",
    )!;
    h.features.computerUseGuardrailsV1Enabled = true;
    h.settings.revision = 2;
    const applyingChild = await h.asyncStorage.changePlans.transition(child.planId, {
      expectedRevision: child.revision,
      status: "applying",
      internal: true,
      eventType: "owner_applying",
      actorId: "operator",
      actionNonce: child.requiredAction!.actionNonce,
      requiredAction: null,
    });
    await h.asyncStorage.changePlans.transition(child.planId, {
      expectedRevision: applyingChild.revision,
      status: "completed",
      internal: true,
      eventType: "owner_completed",
      actorId: "operator",
      result: { appliedRevision: 2, summary: "Applied" },
    });
    const installed = await h.plane.verifyMonitoringPlan(h.actor, result.planId, result.revision);
    const pending = await h.plane.requestRollback(h.actor, installed.planId, installed.revision);
    const rollback = await h.plane.confirm(
      h.actor,
      pending.planId,
      pending.revision,
      pending.requiredAction!.actionNonce,
    );
    expect(rollback.status).toBe("monitoring");
    expect(h.features.computerUseGuardrailsV1Enabled).toBe(true);
    const reversal = await h.asyncStorage.changePlans.findByIdempotency(
      "default",
      `pack:${installed.planId}:compensate:runtime-settings`,
    );
    expect(reversal).toMatchObject({
      status: "awaiting_confirmation",
      target: { expectedRevision: 2 },
      request: { change: { operation: "feature_flags", flags: { computerUseGuardrailsV1Enabled: false } } },
    });
    const stillPending = await h.plane.verifyMonitoringPlan(h.actor, rollback.planId, rollback.revision);
    expect(stillPending.status).toBe("monitoring");
    expect(h.compensateMcp).not.toHaveBeenCalled();
  });
  it("refreshes owner evidence without replaying setup and rejects stale or unapproved verification", async () => {
    const h = await harness();
    const pending = await h.create(["cowork-run-map-browser-proof"]);
    await expect(h.plane.verifyMonitoringPlan(h.actor, pending.planId, pending.revision)).rejects.toThrow("monitoring");
    const result = await h.execute(pending);
    const child = (await h.asyncStorage.changePlans.list({ workspaceId: "default" })).find(
      (plan) => plan.kind === "runtime_configuration",
    )!;
    h.features.computerUseGuardrailsV1Enabled = true;
    const stillWaiting = await h.plane.verifyMonitoringPlan(h.actor, result.planId, result.revision);
    expect(stillWaiting.status).toBe("monitoring");
    await expect(h.plane.verifyMonitoringPlan(h.actor, result.planId, result.revision)).rejects.toThrow(
      "changed elsewhere",
    );
    await expect(
      h.plane.verifyMonitoringPlan({ ...h.actor, workspaceId: "foreign" }, result.planId, stillWaiting.revision),
    ).rejects.toThrow("not found");
    const applying = await h.asyncStorage.changePlans.transition(child.planId, {
      expectedRevision: child.revision,
      status: "applying",
      internal: true,
      actionNonce: child.requiredAction!.actionNonce,
      requiredAction: null,
      actorId: "test",
      eventType: "owner_apply_started",
    });
    await h.asyncStorage.changePlans.transition(child.planId, {
      expectedRevision: applying.revision,
      status: "completed",
      actorId: "test",
      eventType: "owner_verified",
    });
    const completed = await h.plane.verifyMonitoringPlan(h.actor, result.planId, stillWaiting.revision);
    expect(completed.status).toBe("completed");
    expect(h.createServer).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
    expect(
      (await h.asyncStorage.changePlans.list({ workspaceId: "default" })).filter(
        (plan) => plan.kind === "runtime_configuration",
      ),
    ).toHaveLength(1);
  });
  it("does not create a settings approval when the reviewed preset is already satisfied", async () => {
    const h = await harness();
    h.features.computerUseGuardrailsV1Enabled = true;
    const result = await h.execute(await h.create(["cowork-run-map-browser-proof"]));
    expect(result.status).toBe("completed");
    expect(result.evidenceRefs.filter((ref) => ref.startsWith("change_plan:"))).toHaveLength(0);
  });
  it("waits for the required enabled tools even after the server connects", async () => {
    const h = await harness();
    h.connect.mockImplementationOnce(async (id) => {
      const server = h.servers.find((item) => item.serverId === id)!;
      server.status = "connected";
      return server;
    });
    const result = await h.execute(await h.create(["playwright"]));
    expect(result.status).toBe("monitoring");
    for (const toolName of ["browser_navigate", "browser_snapshot", "browser_take_screenshot"]) {
      h.tools.push({ serverId: h.servers[0]!.serverId, toolName, enabled: false, updatedAt: h.servers[0]!.updatedAt });
    }
    await h.plane.reconcileActive();
    expect((await h.asyncStorage.changePlans.get(result.planId)).status).toBe("monitoring");
    h.tools.forEach((tool) => {
      tool.enabled = true;
    });
    await h.plane.reconcileActive();
    expect((await h.asyncStorage.changePlans.get(result.planId)).status).toBe("completed");
    expect(h.createServer).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
  it("runs MCP setup only after canonical approval and recovers without duplicate effects", async () => {
    const h = await harness();
    const result = await h.execute(await h.create(["playwright"]));
    expect(result.status).toBe("completed");
    expect(h.servers[0]).toMatchObject({
      enabled: true,
      status: "connected",
      args: ["-y", "@playwright/mcp@0.0.80", "--isolated", "--headless"],
      policy: { requireFirstToolApproval: true },
    });
    await h.plane.reconcileActive();
    expect(h.createServer).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
  it("stages actual inactive skill bytes and links separate settings and activation plans", async () => {
    const h = await harness();
    const result = await h.execute(await h.create(["browser-qa-operator", "cowork-run-map-browser-proof"]));
    expect(result.status, JSON.stringify(result.result)).toBe("monitoring");
    const [candidate] = h.storage.candidateSkillVersions.list();
    expect(candidate).toMatchObject({ lifecycleState: "candidate", sourceKind: "capability_pack" });
    const review = await readCandidateSkillArtifacts(h.root, path.join(h.root, "candidates"), candidate!, 1);
    expect(review.artifacts[0]?.content).toContain("## Failure handling");
    expect(result.evidenceRefs.filter((ref) => ref.startsWith("change_plan:"))).toHaveLength(2);
    expect(h.connect).not.toHaveBeenCalled();
    await fs.writeFile(path.join(h.root, candidate!.instructionArtifact.relPath), "changed");
    await expect(readCandidateSkillArtifacts(h.root, path.join(h.root, "candidates"), candidate!, 1)).rejects.toThrow();
  });
  it("rejects stale manifests and unknown assets before owner work", async () => {
    const h = await harness();
    await expect(h.create(["unreviewed-plugin"])).rejects.toThrow("no reviewed execution binding");
    await expect(
      h.plane.create({
        actor: h.actor,
        request: {
          kind: "capability_pack",
          packId: h.manifest.packId,
          manifestHash: "0".repeat(64),
          assetIds: ["playwright"],
        },
      }),
    ).rejects.toThrow("manifest");
    expect(h.createServer).not.toHaveBeenCalled();
  });
  it("leaves a failed connection visible without claiming the pack ready or retrying it", async () => {
    const h = await harness();
    h.connect.mockRejectedValueOnce(new Error("controlled connection failure"));
    expect((await h.execute(await h.create(["playwright"]))).status).toBe("manual_required");
    await h.plane.reconcileActive();
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
});
