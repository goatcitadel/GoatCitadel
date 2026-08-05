import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkPassportRecord } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { OperatorProfileService } from "./operator-profile-service.js";
import { WorkPassportService } from "./work-passport-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createHarness() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-work-passport-"));
  tempRoots.push(rootDir);
  const storage = new Storage({
    dbPath: path.join(rootDir, "runtime.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
  const workspace = storage.workspaces.create({ name: "Work Passport test" });
  const operatorProfiles = new OperatorProfileService({
    storage: createSqliteAsyncStorage(storage),
    isFeatureEnabled: () => false,
  });
  return {
    storage,
    workspaceId: workspace.workspaceId,
    service: new WorkPassportService(operatorProfiles),
    operatorProfiles,
  };
}

describe("WorkPassportService", () => {
  it("classifies the task without claiming a boundary when no operator baseline exists", async () => {
    const { service, workspaceId } = await createHarness();
    const passport = await service.classify(workspaceId, "Debug the TypeScript API and run the database tests.");

    expect(passport.taskSignals.map((signal) => signal.domain)).toContain("engineering");
    expect(passport.boundary).toBe("baseline_not_configured");
    expect(passport.operatorCorrectionAllowed).toBe(true);
    expect(passport.limitations.join(" ")).toContain("not an occupation");
    expect(() => assertWorkPassportRecord(passport)).not.toThrow();
    expect(
      (await service.classify(workspaceId, "Debug the TypeScript API and run the database tests.")).passportId,
    ).toBe(passport.passportId);
  });

  it("uses only the explicit workspace baseline to distinguish within- and cross-domain work", async () => {
    const { service, workspaceId } = await createHarness();
    const baseline = await service.updateBaseline({
      workspaceId,
      roleLabel: "Product engineer",
      primaryDomains: ["engineering", "design"],
    });

    expect(baseline.configured).toBe(true);
    expect((await service.classify(workspaceId, "Debug the software API.")).boundary).toBe("within_baseline");
    expect((await service.classify(workspaceId, "Prepare the tax and investment recommendation.")).boundary).toBe(
      "cross_domain",
    );
  });

  it("classifies mixed engineering and finance work for independent review", async () => {
    const { service, workspaceId } = await createHarness();
    await service.updateBaseline({ workspaceId, roleLabel: "Engineer", primaryDomains: ["engineering"] });

    const passport = await service.classify(
      workspaceId,
      "Debug the software API and compare the tax and investment data.",
    );

    expect(passport.taskSignals.map((signal) => signal.domain)).toEqual(
      expect.arrayContaining(["engineering", "finance"]),
    );
    expect(passport.boundary).toBe("mixed");
    expect(passport.consequence).toBe("moderate");
    expect(passport.review.posture).toBe("independent_review");
    expect(passport.actionPosture).toBe("ready_for_review");
    expect(() => assertWorkPassportRecord(passport)).not.toThrow();
  });

  it("requires expert review for consequential high-stakes work and never grants action authority", async () => {
    const { service, workspaceId } = await createHarness();
    await service.updateBaseline({ workspaceId, roleLabel: "Engineer", primaryDomains: ["engineering"] });

    const passport = await service.classify(workspaceId, "Approve and sign this legal contract for the company.");

    expect(passport.consequence).toBe("high");
    expect(passport.review.posture).toBe("domain_expert_required");
    expect(passport.actionPosture).toBe("approval_before_external_action");
    expect(passport.limitations.join(" ")).toContain("does not grant tools");
  });

  it("preserves operator-profile facts outside the Work Passport namespace", async () => {
    const { service, workspaceId, operatorProfiles } = await createHarness();
    await operatorProfiles.recordOperatorProfileFacts(workspaceId, {
      authority: "operator",
      facts: [{ kind: "preference", content: "Prefer concise updates.", confidence: 1, sourceRef: "manual" }],
    });

    await service.updateBaseline({ workspaceId, roleLabel: "Researcher", primaryDomains: ["research"] });
    await service.updateBaseline({ workspaceId, roleLabel: "Engineer", primaryDomains: ["engineering"] });

    const profile = await operatorProfiles.ensureOperatorProfile(workspaceId);
    expect(profile.facts.some((fact) => fact.sourceRef === "manual")).toBe(true);
    expect(profile.facts.filter((fact) => fact.sourceRef?.startsWith("work-passport:domain:"))).toHaveLength(1);
    expect((await service.getBaseline(workspaceId)).primaryDomains).toEqual(["engineering"]);
  });
});
