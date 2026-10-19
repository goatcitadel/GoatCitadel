import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilityCatalogEntry,
  ChatTurnFeatureReferences,
  LoadedSkill,
  SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import { resolveCallableSkillSelection } from "./callable-skill-activation.js";
import { captureSkillContentIntegritySync } from "./skill-content-integrity.js";
import {
  renderAdmittedSkillInstructions,
  resolveChatFeatureAdmission,
  type ChatFeatureAdmissionHost,
} from "./chat-feature-admission-service.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function harness(content = "# Reports\n\nRead source evidence and summarize the findings.\n") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-feature-skill-"));
  roots.push(dir);
  await fs.writeFile(path.join(dir, "SKILL.md"), content);
  const manifest = captureSkillContentIntegritySync(dir);
  const skill: LoadedSkill = {
    skillId: "bundled:reports",
    name: "reports",
    description: "Summarize research reports",
    source: "bundled",
    dir,
    declaredTools: [],
    requires: [],
    keywords: ["reports"],
    instructionBody: content,
    mtime: "2026-10-11",
  };
  const lifecycle: SkillLifecycleRecord = {
    skillId: skill.skillId,
    category: "built_in",
    lifecycleState: "trusted",
    trustLabel: "bundled_trusted",
    provenance: {
      source: "bundled",
      contentIntegrity: {
        manifestVersion: manifest.manifestVersion,
        treeSha256: manifest.treeSha256,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        verified: true,
      },
    },
    createdAt: "2026-10-11",
    updatedAt: "2026-10-11",
  };
  const catalog: CapabilityCatalogEntry[] = [
    {
      capabilityId: `skill:${skill.skillId}`,
      skillId: skill.skillId,
      title: skill.name,
      summary: skill.description!,
      kind: "skill",
      category: "built_in",
      callable: true,
    },
  ];
  const bindings = new Map<string, { references: ChatTurnFeatureReferences; referenceSha256: string }>();
  const state = { enabled: true, confirmation: false, contextWindow: 32768 };
  const resolveSkills = vi.fn(async (text: string) => {
    const decision = resolveCallableSkillSelection(
      { request: { text }, loadedSkills: [skill], inspectableCatalog: catalog, callableCatalog: catalog },
      { mode: "ranked" },
    ).decision;
    if (state.confirmation)
      decision.selected.forEach((entry) => {
        entry.requiresConfirmation = true;
      });
    return decision;
  });
  const bindFeatureReferences = vi.fn(async (value: { admissionId: string; references: ChatTurnFeatureReferences }) => {
    const result = {
      references: structuredClone(value.references),
      referenceSha256: createHash("sha256").update(JSON.stringify(value.references)).digest("hex"),
    };
    bindings.set(value.admissionId, result);
    return result;
  });
  const host: ChatFeatureAdmissionHost = {
    storage: {
      sessionMutationAdmissions: {
        findFeatureReferences: async ({ admissionId }: { admissionId: string }) => bindings.get(admissionId),
        bindFeatureReferences,
      },
    } as never,
    listToolNames: () => [],
    assertTurnAdmissionWrite: vi.fn(async () => undefined),
    isFeatureEnabled: async (flag) => flag === "chatSkillInstructionsV1Enabled" && state.enabled,
    getSkillSelectionMode: async () => "ranked",
    resolveSkills,
    listCallable: async () => catalog,
    listLifecycle: async () => [lifecycle],
    listLoadedSkills: async () => [skill],
    getModelContextWindow: () => state.contextWindow,
    routeFingerprint: () => "b".repeat(64),
  };
  return { host, bindings, resolveSkills, bindFeatureReferences, state, lifecycle, catalog, dir };
}

function admission(id = "admission"): ActiveTurnAdmission {
  return {
    identity: {
      admissionId: id,
      workspaceId: "workspace",
      sessionId: "session",
      sessionIncarnationId: "incarnation",
      turnId: id,
      aggregateRevision: 1,
      controllerGeneration: 1,
      materialSha256: "a".repeat(64),
    },
    admittedRequest: { content: "Use reports" },
    requestActor: { actorKind: "operator", actorId: "operator" },
    requestClaim: { runtimeOwnerId: "runtime", leaseRevision: 1 },
  };
}
function request(id = "admission", providerId = "local") {
  return {
    admission: admission(id),
    content: "Use reports",
    route: { effectiveProviderId: providerId, effectiveModel: "fixture" } as never,
  };
}

describe("fresh Chat feature skill admission", () => {
  it.each(["local", "hosted"])(
    "selects exact skill bytes for %s without a whole capability profile and reuses receipts",
    async (providerId) => {
      const h = await harness();
      const binding = await resolveChatFeatureAdmission(h.host, request("one", providerId));
      expect(binding?.references.selectedSkills).toMatchObject({
        selectionMode: "ranked",
        instructionBudgetTokens: 4096,
      });
      expect(binding?.references.selectedSkills?.activatedSkills).toHaveLength(1);
      expect(binding?.references.providerRoute).toEqual({
        primary: { providerId, model: "fixture" },
        fingerprint: "b".repeat(64),
      });
      expect(await renderAdmittedSkillInstructions(h.host, binding!.references, "workspace")).toContain(
        "Read source evidence",
      );
      expect(await resolveChatFeatureAdmission(h.host, request("one", providerId))).toEqual(binding);
      expect(h.resolveSkills).toHaveBeenCalledTimes(1);
      const fresh = await resolveChatFeatureAdmission(h.host, request("two", providerId));
      expect(fresh?.references.selectedSkills?.activatedSkills).toEqual(
        binding?.references.selectedSkills?.activatedSkills,
      );
      expect(h.resolveSkills).toHaveBeenCalledTimes(2);
    },
  );

  it("replays admitted evidence without recomputing selection and rejects hash disagreement", async () => {
    const h = await harness();
    const req = request();
    const binding = await resolveChatFeatureAdmission(h.host, req);
    h.resolveSkills.mockImplementation(async () => {
      throw new Error("replay must not select");
    });
    const replay = {
      ...req,
      admission: { ...req.admission, durableClaim: { durableRunId: "run", leaseOwnerId: "worker", attemptCount: 1 } },
      expectedReferenceSha256: binding!.referenceSha256,
    };
    expect(await resolveChatFeatureAdmission(h.host, replay)).toEqual(binding);
    await expect(
      resolveChatFeatureAdmission(h.host, { ...replay, expectedReferenceSha256: "b".repeat(64) }),
    ).rejects.toThrow(/admitted hash/);
  });

  it("keeps historical replay without feature evidence free of newly enabled skill selection", async () => {
    const h = await harness();
    const req = request();
    const result = await resolveChatFeatureAdmission(h.host, {
      ...req,
      admission: {
        ...req.admission,
        durableClaim: { durableRunId: "old-run", leaseOwnerId: "worker", attemptCount: 2 },
      },
    });
    expect(result).toBeUndefined();
    expect(h.resolveSkills).not.toHaveBeenCalled();
    expect(h.bindFeatureReferences).not.toHaveBeenCalled();
  });

  it("refuses new feature bindings without verifiable routing", async () => {
    const h = await harness();
    h.host.routeFingerprint = () => undefined;
    await expect(resolveChatFeatureAdmission(h.host, request())).rejects.toThrow(/verifiable provider route/);
    await expect(resolveChatFeatureAdmission(h.host, { ...request(), route: undefined })).rejects.toThrow(
      /explicit provider route/,
    );
    expect(h.bindFeatureReferences).not.toHaveBeenCalled();
  });

  it("keeps rollout-off and first-use confirmation from injecting instructions", async () => {
    const h = await harness();
    h.state.enabled = false;
    expect(await resolveChatFeatureAdmission(h.host, request("off"))).toBeUndefined();
    expect(h.resolveSkills).not.toHaveBeenCalled();
    h.state.enabled = true;
    h.state.confirmation = true;
    expect(await resolveChatFeatureAdmission(h.host, request("confirmation"))).toBeUndefined();
    expect(h.bindFeatureReferences).not.toHaveBeenCalled();
  });

  it("rejects changed, revoked, disabled and newly noncallable skill evidence before rendering", async () => {
    const h = await harness();
    const binding = (await resolveChatFeatureAdmission(h.host, request()))!;
    h.state.enabled = false;
    await expect(renderAdmittedSkillInstructions(h.host, binding.references, "workspace")).rejects.toThrow(/disabled/);
    h.state.enabled = true;
    h.lifecycle.lifecycleState = "revoked";
    await expect(renderAdmittedSkillInstructions(h.host, binding.references, "workspace")).rejects.toThrow(
      /exact-byte lifecycle/,
    );
    h.lifecycle.lifecycleState = "trusted";
    await fs.writeFile(path.join(h.dir, "SKILL.md"), "changed instructions");
    await expect(renderAdmittedSkillInstructions(h.host, binding.references, "workspace")).rejects.toThrow(
      /exact-byte lifecycle/,
    );
    h.catalog.splice(0);
    await expect(renderAdmittedSkillInstructions(h.host, binding.references, "workspace")).rejects.toThrow(
      /no longer callable/,
    );
  });

  it("fails oversized explicit instructions before immutable admission without partial truncation", async () => {
    const h = await harness("# Reports\n" + "Read source evidence. ".repeat(400));
    h.state.contextWindow = 2048;
    await expect(resolveChatFeatureAdmission(h.host, request())).rejects.toThrow(/instruction budget/);
    expect(h.bindFeatureReferences).not.toHaveBeenCalled();
  });
});

describe("fresh Chat workspace snapshot admission", () => {
  const snapshot = {
    schemaVersion: "chat.workspace-snapshot.v1" as const,
    snapshotId: "chat-workspace-snapshot-1",
    requestId: "snapshot-request-1",
    workspaceId: "workspace",
    project: { projectId: "project-1", projectRevision: 3 },
    status: "captured" as const,
    pathBinding: {
      verificationId: "verification-1",
      fingerprintSha256: "c".repeat(64),
      gitIdentitySha256: "d".repeat(64),
    },
    git: { headSha: "e".repeat(40), branch: "main", trackedChangeCount: 1, untrackedChangeCount: 0, dirty: true },
    capturedAt: "2026-10-19T00:00:00.000Z",
    snapshotHash: "f".repeat(64),
  };
  async function snapshotHarness(enabled: boolean) {
    const h = await harness();
    const captureWorkspaceSnapshot = vi.fn(async () => structuredClone(snapshot));
    h.host.captureWorkspaceSnapshot = captureWorkspaceSnapshot;
    h.host.isFeatureEnabled = async (flag) => flag === "chatWorkspaceSnapshotV1Enabled" && enabled;
    return { ...h, captureWorkspaceSnapshot };
  }
  function snapshotRequest(id: string) {
    const req = request(id);
    return {
      ...req,
      admission: {
        ...req.admission,
        admittedRequest: {
          content: "Use reports",
          workspaceSnapshot: { capture: true as const, requestId: "snapshot-request-1" },
        },
      },
    };
  }

  it("captures one turn-scoped snapshot only when chatWorkspaceSnapshotV1Enabled is on", async () => {
    const off = await snapshotHarness(false);
    expect(await resolveChatFeatureAdmission(off.host, snapshotRequest("off"))).toBeUndefined();
    expect(off.captureWorkspaceSnapshot).not.toHaveBeenCalled();
    const on = await snapshotHarness(true);
    const binding = await resolveChatFeatureAdmission(on.host, snapshotRequest("on"));
    expect(on.captureWorkspaceSnapshot).toHaveBeenCalledWith({
      sessionId: "session",
      turnId: "on",
      workspaceId: "workspace",
      request: { capture: true, requestId: "snapshot-request-1" },
    });
    expect(binding?.references.workspaceSnapshot).toEqual(snapshot);
  });

  it("reuses the admitted snapshot on durable replay and never recaptures", async () => {
    const h = await snapshotHarness(true);
    const req = snapshotRequest("replay");
    const binding = await resolveChatFeatureAdmission(h.host, req);
    const replay = await resolveChatFeatureAdmission(h.host, {
      ...req,
      admission: { ...req.admission, durableClaim: { durableRunId: "run", leaseOwnerId: "worker", attemptCount: 1 } },
      expectedReferenceSha256: binding!.referenceSha256,
    });
    expect(replay?.references.workspaceSnapshot).toEqual(snapshot);
    expect(h.captureWorkspaceSnapshot).toHaveBeenCalledOnce();
  });

  it("binds without a route and refuses a snapshot from another workspace", async () => {
    const h = await snapshotHarness(true);
    const routeless = await resolveChatFeatureAdmission(h.host, { ...snapshotRequest("routeless"), route: undefined });
    expect(routeless?.references.providerRoute).toBeUndefined();
    h.captureWorkspaceSnapshot.mockResolvedValue({ ...structuredClone(snapshot), workspaceId: "other" });
    await expect(resolveChatFeatureAdmission(h.host, snapshotRequest("foreign"))).rejects.toThrow(
      /does not match the admitted turn/,
    );
  });
});
