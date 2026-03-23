import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELEGATION_ROLES,
  detectDelegationRoles,
  inferSpecialistBaseRole,
  normalizeDelegationRoles,
  resolveDelegationRoles,
} from "./gateway-role-routing.js";

describe("gateway role routing", () => {
  it("keeps existing English delegation matches stable", () => {
    expect(detectDelegationRoles("Write the product requirements, architecture, implementation, test plan, rollout, and research sources."))
      .toEqual(["product", "architect", "coder", "qa", "ops", "researcher"]);
  });

  it("adds multilingual delegation keyword matches additively", () => {
    expect(detectDelegationRoles("Necesito investigar fuentes y analizar el mercado antes de implementar el cambio."))
      .toEqual(["coder", "researcher"]);
    expect(detectDelegationRoles("Bitte Sicherheit audit und den Rollout bereitstellen."))
      .toEqual(["ops", "reviewer"]);
  });

  it("keeps explicit slash-command roles ahead of heuristic routing", () => {
    expect(resolveDelegationRoles("please research and implement this", ["reviewer", "coder"])).toEqual(["reviewer", "coder"]);
  });

  it("falls back to the default delegation starter set when no keywords match", () => {
    expect(resolveDelegationRoles("something vague", undefined, DEFAULT_DELEGATION_ROLES.slice(0, 3))).toEqual(["product", "architect", "coder"]);
  });

  it("normalizes explicit roles without dropping additive specialist labels", () => {
    expect(normalizeDelegationRoles([" Reviewer ", "coder", "reviewer", "qa-validator "])).toEqual([
      "reviewer",
      "coder",
      "qa-validator",
    ]);
  });

  it("routes multilingual specialist roles to the intended base role", () => {
    expect(inferSpecialistBaseRole("desarrollador")).toBe("coder");
    expect(inferSpecialistBaseRole("recherche de marche")).toBe("researcher");
    expect(inferSpecialistBaseRole("architecte produit")).toBe("planner");
    expect(inferSpecialistBaseRole("auditoria de seguranca")).toBe("reviewer");
    expect(inferSpecialistBaseRole("executar rollout")).toBe("worker");
  });
});
