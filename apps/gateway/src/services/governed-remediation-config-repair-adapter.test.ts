import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ValidationError,
  normalizeGovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigGenerationService,
  type CompleteUnifiedConfigPayload,
  type ConfigGenerationServiceHooks,
} from "./config-generation-service.js";
import {
  GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE,
  GOVERNED_CONFIG_MANUAL_REPAIR_REGISTRATION,
  GovernedRemediationConfigRepairAdapter,
  governedConfigRepairRecipeSha256,
  governedConfigRepairScope,
} from "./governed-remediation-config-repair-adapter.js";
import { GovernedRemediationRecipeRegistry } from "./governed-remediation-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("GovernedRemediationConfigRepairAdapter", () => {
  it("registers an exact manual-only declarative recipe for every deployment profile", () => {
    expect(normalizeGovernedRemediationRecipe(GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE)).toEqual(
      GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE,
    );
    expect(GOVERNED_CONFIG_MANUAL_REPAIR_REGISTRATION.owner).toBeNull();
    expect(GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE).toMatchObject({
      repairClass: "declarative_configuration",
      executionMode: "manual_required",
      rollbackStrategy: "manual_required",
      verificationProbeId: null,
      maxApplyAttempts: 0,
    });

    const registry = new GovernedRemediationRecipeRegistry([GOVERNED_CONFIG_MANUAL_REPAIR_REGISTRATION]);
    for (const deploymentProfile of ["local_dev", "trusted_local", "remote_hardened"] as const) {
      const resolution = registry.resolve({
        recipeId: GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE.recipeId,
        recipeVersion: GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE.recipeVersion,
        targetId: GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE.targetId,
        requestedCapabilityId: GOVERNED_CONFIG_MANUAL_REPAIR_RECIPE.requestedCapabilityId,
        deploymentProfile,
        scope: scope(),
      });
      expect(resolution.owner).toBeNull();
      expect(resolution.recipeSha256).toBe(governedConfigRepairRecipeSha256());
    }
  });

  it("emits only a coarse section diff and never candidate values or secret-derived hashes", async () => {
    const { service, canonicalPath } = await buildModernService();
    const adapter = new GovernedRemediationConfigRepairAdapter(service);
    const expectedOwnerRevision = adapter.getOwnerRevision();
    const candidate = service.getActivePayload();
    const canary = "test-only-config-candidate-canary-9375-do-not-store";
    const canarySha256 = createHash("sha256").update(canary, "utf8").digest("hex");
    const llm = candidate.llm as { providers: Array<Record<string, unknown>> };
    llm.providers[0] = { ...llm.providers[0], apiKey: canary, arbitrarySecretField: canary };
    const beforeCanonical = await fs.readFile(canonicalPath, "utf8");
    const beforeRevision = service.getRevision();

    const assessment = adapter.assess({
      deploymentProfile: "trusted_local",
      scope: scope(),
      expectedOwnerRevision,
      candidate,
    });

    expect(assessment).toMatchObject({
      status: "manual_required",
      reason: "durable_effect_journal_unavailable",
      ownerRevision: expectedOwnerRevision,
      automaticExecution: false,
      diff: {
        candidateValidation: "valid",
        changedSections: ["llm"],
        semanticChange: true,
      },
    });
    const serialized = JSON.stringify(assessment);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(canarySha256);
    expect(serialized).not.toContain("arbitrarySecretField");
    expect(service.getRevision()).toBe(beforeRevision);
    expect(await fs.readFile(canonicalPath, "utf8")).toBe(beforeCanonical);
  });

  it.each([
    ["malformed", "{test-only-malformed-budgets-mirror-canary"],
    [
      "extra-key",
      `${JSON.stringify({ mode: "power", unexpected: "test-only-extra-budgets-mirror-canary" }, null, 2)}\n`,
    ],
  ])("keeps a %s budgets compatibility mirror entirely observational", async (_case, mirrorBytes) => {
    const { root, service } = await buildModernService();
    const adapter = new GovernedRemediationConfigRepairAdapter(service);
    const mirrorPath = path.join(root, "config", "budgets.json");
    const ownerJournalPath = path.join(root, "config", ".generations", "governed-remediation");
    await fs.writeFile(mirrorPath, mirrorBytes, "utf8");
    const beforeMirror = await fs.readFile(mirrorPath);
    const candidate = service.getActivePayload();
    candidate.budgets = { ...candidate.budgets, mode: "saver" };

    const assessment = adapter.assess({
      deploymentProfile: "trusted_local",
      scope: scope(),
      expectedOwnerRevision: adapter.getOwnerRevision(),
      candidate,
    });

    expect(assessment).toMatchObject({
      status: "manual_required",
      reason: "durable_effect_journal_unavailable",
      automaticExecution: false,
    });
    expect(await fs.readFile(mirrorPath)).toEqual(beforeMirror);
    await expect(fs.stat(ownerJournalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(assessment)).not.toContain("budgets-mirror-canary");
  });

  it("classifies invalid or missing candidates without exposing validation details", async () => {
    const { service } = await buildModernService();
    const adapter = new GovernedRemediationConfigRepairAdapter(service);
    const expectedOwnerRevision = adapter.getOwnerRevision();
    const rawSecret = "test-only-invalid-candidate-canary-2841-do-not-store";

    const missing = adapter.assess({
      deploymentProfile: "local_dev",
      scope: scope(),
      expectedOwnerRevision,
    });
    const invalid = adapter.assess({
      deploymentProfile: "local_dev",
      scope: scope(),
      expectedOwnerRevision,
      candidate: { assistant: { rawSecret } },
    });

    expect(missing).toMatchObject({ status: "manual_required", reason: "candidate_unavailable" });
    expect(invalid).toMatchObject({
      status: "manual_required",
      reason: "candidate_invalid",
      diff: { candidateValidation: "invalid", changedSections: [], semanticChange: null },
    });
    expect(JSON.stringify(invalid)).not.toContain(rawSecret);
    expect(JSON.stringify(invalid)).not.toContain("assistant");
  });

  it("reports no repair for an exact semantic no-op and remains stable after restart", async () => {
    const { root, service } = await buildModernService();
    const first = new GovernedRemediationConfigRepairAdapter(service);
    const ownerRevision = first.getOwnerRevision();
    const candidate = service.getActivePayload();

    expect(
      first.assess({
        deploymentProfile: "trusted_local",
        scope: scope(),
        expectedOwnerRevision: ownerRevision,
        candidate,
      }),
    ).toMatchObject({ status: "not_required", ownerRevision, diff: { semanticChange: false } });

    const restarted = new ConfigGenerationService(root);
    const afterRestart = new GovernedRemediationConfigRepairAdapter(restarted);
    expect(afterRestart.getOwnerRevision()).toBe(ownerRevision);
    expect(
      afterRestart.assess({
        deploymentProfile: "trusted_local",
        scope: scope(),
        expectedOwnerRevision: ownerRevision,
        candidate,
      }),
    ).toMatchObject({ status: "not_required", ownerRevision });
  });

  it("fails closed on stale, malformed, or legacy owner revisions", async () => {
    const { service } = await buildModernService();
    const adapter = new GovernedRemediationConfigRepairAdapter(service);
    const candidate = service.getActivePayload();

    expect(
      adapter.assess({
        deploymentProfile: "local_dev",
        scope: scope(),
        expectedOwnerRevision: null,
        candidate,
      }),
    ).toMatchObject({ status: "manual_required", reason: "owner_revision_conflict" });
    expect(
      adapter.assess({
        deploymentProfile: "local_dev",
        scope: scope(),
        expectedOwnerRevision: "config-generation:v1:1:00000000-0000-4000-8000-000000000001",
        candidate,
      }),
    ).toMatchObject({ status: "manual_required", reason: "owner_revision_conflict" });
    expect(() =>
      adapter.assess({
        deploymentProfile: "local_dev",
        scope: scope(),
        expectedOwnerRevision: "not-a-canonical-owner-revision",
        candidate,
      }),
    ).toThrow(ValidationError);

    const legacy = await buildLegacyService();
    const legacyAdapter = new GovernedRemediationConfigRepairAdapter(legacy.service);
    expect(legacyAdapter.getOwnerRevision()).toBeNull();
    expect(
      legacyAdapter.assess({
        deploymentProfile: "local_dev",
        scope: scope(),
        expectedOwnerRevision: null,
        candidate: legacy.service.getActivePayload(),
      }),
    ).toMatchObject({ status: "manual_required", reason: "exact_owner_revision_unavailable" });
  });

  it("does not classify a committed-but-unreconciled config as safe", async () => {
    const { service } = await buildModernService(
      {
        afterCommitMarker: () => {
          throw new Error("simulated process death after durable config decision");
        },
      },
      false,
    );
    await expect(commitBudgetMode(service, "saver")).rejects.toThrow(
      "simulated process death after durable config decision",
    );
    expect(service.getHealthSnapshot().transactionState).toBe("committed");
    const adapter = new GovernedRemediationConfigRepairAdapter(service);

    expect(
      adapter.assess({
        deploymentProfile: "trusted_local",
        scope: scope(),
        expectedOwnerRevision: adapter.getOwnerRevision(),
        candidate: service.getActivePayload(),
      }),
    ).toMatchObject({ status: "manual_required", reason: "owner_reconciliation_pending" });
  });

  it("preserves exact installation scope and rejects broader or mismatched targets", async () => {
    const { service } = await buildModernService();
    const adapter = new GovernedRemediationConfigRepairAdapter(service);
    const base = scope();
    const candidate = service.getActivePayload();

    expect(() =>
      adapter.assess({
        deploymentProfile: "remote_hardened",
        scope: { ...base, scopeKind: "workspace" },
        expectedOwnerRevision: adapter.getOwnerRevision(),
        candidate,
      }),
    ).toThrow(/scope kind is not allowlisted/u);
    expect(() =>
      adapter.assess({
        deploymentProfile: "remote_hardened",
        scope: { ...base, targetId: "gateway.config.foreign" },
        expectedOwnerRevision: adapter.getOwnerRevision(),
        candidate,
      }),
    ).toThrow(/target does not match/u);
  });
});

function scope(): GovernedRemediationScope {
  return governedConfigRepairScope({ deploymentId: "deployment-test", installationId: "installation-test" });
}

async function buildModernService(
  hooks: ConfigGenerationServiceHooks = {},
  seedGeneration = true,
): Promise<{ root: string; canonicalPath: string; service: ConfigGenerationService }> {
  const legacy = await buildLegacyService(hooks);
  if (seedGeneration) await commitBudgetMode(legacy.service, "power");
  return legacy;
}

async function buildLegacyService(
  hooks: ConfigGenerationServiceHooks = {},
): Promise<{ root: string; canonicalPath: string; service: ConfigGenerationService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-governed-config-repair-"));
  roots.push(root);
  const payload = JSON.parse(
    await fs.readFile(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  delete payload.generation;
  const configDir = path.join(root, "config");
  const canonicalPath = path.join(configDir, "goatcitadel.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(canonicalPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { root, canonicalPath, service: new ConfigGenerationService(root, undefined, hooks) };
}

async function commitBudgetMode(service: ConfigGenerationService, mode: "saver" | "balanced" | "power"): Promise<void> {
  await service.commit({
    expectedRevision: service.getRevision(),
    requireExpectedRevision: true,
    previousRuntime: undefined,
    buildCandidate: () => {
      const payload = service.getActivePayload();
      payload.budgets = { ...payload.budgets, mode };
      return { payload, runtime: undefined };
    },
    apply: () => undefined,
    restore: () => undefined,
  });
}
