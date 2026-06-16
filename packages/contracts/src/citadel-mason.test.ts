import { describe, it, expect } from "vitest";
import type { Citadel, CitadelChamber, CitadelCharter } from "./citadels.js";
import { CITADEL_BLUEPRINT_SCHEMA_VERSION, exportCitadelBlueprint, validateCitadelBlueprint } from "./citadel-blueprints.js";
import { MASON_SETUP_QUESTIONS, draftBlueprintFromAnswers, generateBlueprintReviewSummary } from "./citadel-mason.js";

function sampleCitadel(): Citadel {
  const charter: CitadelCharter = {
    citadelId: "ws-1",
    purpose: "Run the company",
    kind: "company",
    goals: ["ship 1.0"],
    boundaries: ["production writes require approval"],
    successDefinition: ["weekly review done"],
    riskPosture: "conservative",
    modelPolicyDefault: "hybrid_guarded",
    createdAt: "t",
    updatedAt: "t",
  };
  const chambers: CitadelChamber[] = [
    { chamberId: "c1", citadelId: "ws-1", name: "General", sensitivity: "private", sealed: false, createdAt: "t", updatedAt: "t" },
    { chamberId: "c2", citadelId: "ws-1", name: "Finance", sensitivity: "restricted", sealed: true, createdAt: "t", updatedAt: "t" },
  ];
  return { citadelId: "ws-1", charter, chambers };
}

describe("MASON_SETUP_QUESTIONS", () => {
  it("includes the core setup questions", () => {
    expect(MASON_SETUP_QUESTIONS.length).toBeGreaterThanOrEqual(10);
    expect(MASON_SETUP_QUESTIONS[0]).toMatch(/run/i);
    expect(MASON_SETUP_QUESTIONS.some((q) => /approval/i.test(q))).toBe(true);
  });
});

describe("generateBlueprintReviewSummary", () => {
  it("summarizes the blueprint with the review-before-activation notice", () => {
    const blueprint = exportCitadelBlueprint(sampleCitadel(), { name: "Co-Founder" });
    const summary = generateBlueprintReviewSummary(blueprint);

    expect(summary.name).toBe("Co-Founder");
    expect(summary.kind).toBe("company");
    expect(summary.chamberCount).toBe(2);
    expect(summary.sealedChamberCount).toBe(1);
    expect(summary.boundaries).toContain("production writes require approval");
    expect(summary.riskNotes.length).toBeGreaterThan(0);
    expect(summary.lines.some((line) => /nothing is connected or activated yet/i.test(line))).toBe(true);
  });
});

describe("draftBlueprintFromAnswers", () => {
  it("drafts a valid blueprint from structured answers, sealing sensitive areas", () => {
    const blueprint = draftBlueprintFromAnswers({
      kind: "company",
      purpose: "Run the company",
      sensitiveAreas: ["Payroll"],
      boundaries: ["No prod writes without approval"],
      preferLocalForSensitive: true,
    });

    expect(blueprint.schemaVersion).toBe(CITADEL_BLUEPRINT_SCHEMA_VERSION);
    expect(blueprint.charter.kind).toBe("company");
    expect(blueprint.charter.purpose).toBe("Run the company");
    expect(blueprint.charter.boundaries).toContain("No prod writes without approval");
    expect(blueprint.charter.modelPolicyDefault).toBe("local_only");

    const payroll = blueprint.chambers.find((chamber) => chamber.name === "Payroll");
    expect(payroll?.sealed).toBe(true);
    expect(payroll?.sensitivity).toBe("restricted");

    expect(validateCitadelBlueprint(blueprint).ok).toBe(true);
  });

  it("defaults to a General chamber for a kind with no template and validates", () => {
    const blueprint = draftBlueprintFromAnswers({ kind: "custom", purpose: "Something custom" });
    expect(blueprint.chambers.some((chamber) => chamber.name === "General")).toBe(true);
    expect(validateCitadelBlueprint(blueprint).ok).toBe(true);
  });
});
