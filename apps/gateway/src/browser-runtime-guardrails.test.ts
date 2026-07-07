import { describe, expect, it } from "vitest";
import {
  evaluateComputerUseSafety,
  evaluateDeploymentProfileToolAccess,
  isRestrictedBrowserStateTool,
  policyContextHasOperatorApproval,
} from "./browser-runtime-guardrails.js";

const mutatingBrowserInteractArgs = {
  steps: [{ action: "click", selector: "button[type=submit]" }],
};

const modelSuppliedSafetyBooleans = {
  verifyStep: true,
  confirmBeforeSubmit: true,
};

describe("browser-runtime-guardrails: restricted browser-state tools", () => {
  it("flags cookie and storage tools as restricted", () => {
    expect(isRestrictedBrowserStateTool("browser.cookies.get")).toBe(true);
    expect(isRestrictedBrowserStateTool("browser.storage.set")).toBe(true);
    expect(isRestrictedBrowserStateTool("browser.interact")).toBe(false);
  });

  it("blocks restricted browser-state tools outside trusted_local regardless of server verification", () => {
    const violation = evaluateDeploymentProfileToolAccess(
      "remote_hardened",
      "browser.cookies.get",
      {},
      {
        operatorApproved: true,
      },
    );
    expect(violation).not.toBeNull();
    expect(violation?.statusCode).toBe(403);
  });

  it("allows restricted browser-state tools in trusted_local", () => {
    expect(evaluateDeploymentProfileToolAccess("trusted_local", "browser.cookies.get", {})).toBeNull();
  });
});

describe("browser-runtime-guardrails: remote_hardened mutating browser.interact", () => {
  it("BLOCKS a mutating browser.interact when the model supplies verifyStep/confirmBeforeSubmit but there is NO server-controlled verification", () => {
    // Core fix: model-supplied booleans must NOT satisfy the guard in remote_hardened.
    const violation = evaluateDeploymentProfileToolAccess("remote_hardened", "browser.interact", {
      ...mutatingBrowserInteractArgs,
      ...modelSuppliedSafetyBooleans,
    });
    expect(violation).not.toBeNull();
    expect(violation?.statusCode).toBe(409);
    expect(violation?.reason).toContain("operator approval");
    // The response must not advertise a model-satisfiable escape hatch.
    expect(violation?.reason).not.toContain("verifyStep");
    expect(violation?.reason).not.toContain("confirmBeforeSubmit");
  });

  it("BLOCKS a mutating browser.interact when server verification is explicitly not approved", () => {
    const violation = evaluateDeploymentProfileToolAccess(
      "remote_hardened",
      "browser.interact",
      { ...mutatingBrowserInteractArgs, ...modelSuppliedSafetyBooleans },
      { operatorApproved: false },
    );
    expect(violation).not.toBeNull();
    expect(violation?.statusCode).toBe(409);
  });

  it("ALLOWS a mutating browser.interact when the server-controlled operator approval is present", () => {
    const violation = evaluateDeploymentProfileToolAccess(
      "remote_hardened",
      "browser.interact",
      { ...mutatingBrowserInteractArgs },
      { operatorApproved: true },
    );
    expect(violation).toBeNull();
  });

  it("ALLOWS a non-mutating browser.interact (read/screenshot only) in remote_hardened without server verification", () => {
    const violation = evaluateDeploymentProfileToolAccess("remote_hardened", "browser.interact", {
      steps: [{ action: "screenshot" }, { action: "read" }],
    });
    expect(violation).toBeNull();
  });

  it("ALLOWS a mutating browser.interact in trusted_local without any verification (regression)", () => {
    const violation = evaluateDeploymentProfileToolAccess("trusted_local", "browser.interact", {
      ...mutatingBrowserInteractArgs,
    });
    expect(violation).toBeNull();
  });

  it("ALLOWS a mutating browser.interact in local_dev without any verification (regression)", () => {
    const violation = evaluateDeploymentProfileToolAccess("local_dev", "browser.interact", {
      ...mutatingBrowserInteractArgs,
    });
    expect(violation).toBeNull();
  });
});

describe("browser-runtime-guardrails: policyContextHasOperatorApproval (server-controlled signal)", () => {
  it("returns false for absent policy context (no server signal)", () => {
    expect(policyContextHasOperatorApproval(undefined)).toBe(false);
    expect(policyContextHasOperatorApproval(null)).toBe(false);
    expect(policyContextHasOperatorApproval({})).toBe(false);
  });

  it("returns true when an approved Code Mode replay marker is present", () => {
    expect(policyContextHasOperatorApproval({ approvedCodeModeRunId: "code-run-1" })).toBe(true);
  });

  it("returns true when a matched operator grant is present", () => {
    expect(policyContextHasOperatorApproval({ matchedGrantId: "grant-1" })).toBe(true);
  });

  it("gates the guard end-to-end: a policy context with an approval marker allows the mutating action", () => {
    const approvedContext = { matchedGrantId: "grant-1" };
    const violation = evaluateDeploymentProfileToolAccess(
      "remote_hardened",
      "browser.interact",
      { ...mutatingBrowserInteractArgs, ...modelSuppliedSafetyBooleans },
      { operatorApproved: policyContextHasOperatorApproval(approvedContext) },
    );
    expect(violation).toBeNull();
  });

  it("gates the guard end-to-end: an empty policy context blocks the mutating action", () => {
    const violation = evaluateDeploymentProfileToolAccess(
      "remote_hardened",
      "browser.interact",
      { ...mutatingBrowserInteractArgs, ...modelSuppliedSafetyBooleans },
      { operatorApproved: policyContextHasOperatorApproval({}) },
    );
    expect(violation).not.toBeNull();
    expect(violation?.statusCode).toBe(409);
  });
});

describe("browser-runtime-guardrails: evaluateComputerUseSafety (model-arg feature-flag layer, unchanged)", () => {
  it("still reports model-supplied verification/confirmation for the informational safety layer", () => {
    const safety = evaluateComputerUseSafety("browser.interact", {
      ...mutatingBrowserInteractArgs,
      ...modelSuppliedSafetyBooleans,
    });
    expect(safety).toEqual({
      requiresVerification: true,
      requiresConfirmation: true,
      verified: true,
      confirmed: true,
    });
  });

  it("reports no requirement for non-mutating interactions", () => {
    const safety = evaluateComputerUseSafety("browser.interact", { steps: [{ action: "screenshot" }] });
    expect(safety.requiresVerification).toBe(false);
    expect(safety.requiresConfirmation).toBe(false);
  });
});
