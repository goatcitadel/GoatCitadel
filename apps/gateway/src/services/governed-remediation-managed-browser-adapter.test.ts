import { createHash } from "node:crypto";
import { normalizeGovernedRemediationRecipe, type GovernedRemediationScope } from "@goatcitadel/contracts";
import { BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE } from "@goatcitadel/policy-engine";
import { describe, expect, it } from "vitest";
import {
  GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE,
  GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_REGISTRATION,
  GovernedRemediationManagedBrowserAdapter,
  governedManagedBrowserRecipeSha256,
  governedManagedBrowserScope,
} from "./governed-remediation-managed-browser-adapter.js";
import {
  GovernedRemediationRecipeRegistry,
  type GovernedRemediationOwnerPort,
} from "./governed-remediation-registry.js";

describe("GovernedRemediationManagedBrowserAdapter", () => {
  it("registers an exact installation-scoped managed dependency recipe for every deployment profile", () => {
    expect(normalizeGovernedRemediationRecipe(GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE)).toEqual(
      GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE,
    );
    expect(GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_REGISTRATION.owner).toBeNull();
    expect(GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE).toMatchObject({
      repairClass: "managed_dependency",
      targetId: "policy-engine.browser.playwright-chromium",
      requestedCapabilityId: "browser.native.chromium.available",
      executionMode: "manual_required",
      allowedScopeKinds: ["installation"],
      allowedDeploymentProfiles: ["local_dev", "trusted_local", "remote_hardened"],
      inputKind: "none",
      preEffectApproval: "not_applicable",
      activationMode: "not_applicable",
      activationApproval: "not_applicable",
      verificationProbeId: null,
      rollbackStrategy: "manual_required",
      maxApplyAttempts: 0,
    });

    const registry = new GovernedRemediationRecipeRegistry([GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_REGISTRATION]);
    for (const deploymentProfile of ["local_dev", "trusted_local", "remote_hardened"] as const) {
      const resolution = registry.resolve({
        recipeId: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.recipeId,
        recipeVersion: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.recipeVersion,
        targetId: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.targetId,
        requestedCapabilityId: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.requestedCapabilityId,
        deploymentProfile,
        scope: scope(),
      });
      expect(resolution.owner).toBeNull();
      expect(resolution.recipeSha256).toBe(governedManagedBrowserRecipeSha256());
    }
  });

  it("classifies only the stable policy-engine diagnostic and remains non-callable", () => {
    const assessment = new GovernedRemediationManagedBrowserAdapter().assess({
      deploymentProfile: "trusted_local",
      scope: scope(),
      sourceDiagnosticCode: BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE,
    });

    expect(assessment).toMatchObject({
      status: "manual_required",
      reason: "operator_installation_required",
      ownerRevision: null,
      automaticExecution: false,
      targetId: "policy-engine.browser.playwright-chromium",
      requestedCapabilityId: "browser.native.chromium.available",
      observation: {
        dependencyId: "playwright-chromium",
        availability: "missing",
        automaticInstallation: "disabled",
        nativeBrowserCapability: "unavailable",
      },
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.observation)).toBe(true);
  });

  it("fails closed on arbitrary or secret-bearing diagnostics without retaining raw material", () => {
    const canary = "test-only-browser-install-secret-canary-4831";
    const canarySha256 = createHash("sha256").update(canary, "utf8").digest("hex");
    let accessorRead = false;
    const hostileDiagnostic = Object.defineProperty({ rawError: canary }, "code", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE;
      },
    });

    const assessment = new GovernedRemediationManagedBrowserAdapter().assess({
      deploymentProfile: "remote_hardened",
      scope: scope(),
      sourceDiagnosticCode: hostileDiagnostic,
    });

    expect(assessment).toMatchObject({
      status: "manual_required",
      reason: "source_diagnostic_unavailable",
      observation: { availability: "unknown" },
      automaticExecution: false,
    });
    expect(accessorRead).toBe(false);
    const serialized = JSON.stringify(assessment);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(canarySha256);
    expect(serialized).not.toContain("rawError");
    expect(serialized).not.toContain("sourceDiagnosticCode");
  });

  it("rejects broader scopes and mismatched target authority", () => {
    const adapter = new GovernedRemediationManagedBrowserAdapter();
    const base = scope();

    expect(() =>
      adapter.assess({
        deploymentProfile: "trusted_local",
        scope: { ...base, scopeKind: "workspace" },
        sourceDiagnosticCode: BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE,
      }),
    ).toThrow(/scope kind is not allowlisted/u);
    expect(() =>
      adapter.assess({
        deploymentProfile: "trusted_local",
        scope: { ...base, targetId: "policy-engine.browser.foreign-runtime" },
        sourceDiagnosticCode: BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE,
      }),
    ).toThrow(/target does not match/u);
  });

  it("rejects attempts to attach a callable owner to the manual managed dependency recipe", () => {
    const injectedOwner = {
      ownerId: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.ownerId,
      targetId: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.targetId,
      requestedCapabilityId: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE.requestedCapabilityId,
      activationMode: "not_applicable",
    } as unknown as GovernedRemediationOwnerPort;

    expect(
      () =>
        new GovernedRemediationRecipeRegistry([
          { recipe: GOVERNED_MANAGED_BROWSER_MANUAL_REPAIR_RECIPE, owner: injectedOwner },
        ]),
    ).toThrow(/Manual remediation recipes cannot have callable owners/u);
  });
});

function scope(): GovernedRemediationScope {
  return governedManagedBrowserScope({
    deploymentId: "deployment-test",
    installationId: "installation-test",
  });
}
