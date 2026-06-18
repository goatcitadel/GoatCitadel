import { describe, it, expect } from "vitest";
import type {
  Citadel,
  CitadelChamber,
  CitadelChamberInput,
  CitadelCharter,
  CitadelCharterInput,
  CitadelTemplateTarget,
} from "./citadels.js";
import {
  CITADEL_BLUEPRINT_SCHEMA_VERSION,
  applyCitadelBlueprint,
  exportCitadelBlueprint,
  validateCitadelBlueprint,
} from "./citadel-blueprints.js";

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
    {
      chamberId: "ch-1",
      citadelId: "ws-1",
      name: "General",
      sensitivity: "private",
      sealed: false,
      createdAt: "t",
      updatedAt: "t",
    },
    {
      chamberId: "ch-2",
      citadelId: "ws-1",
      name: "Finance",
      sensitivity: "restricted",
      sealed: true,
      createdAt: "t",
      updatedAt: "t",
    },
  ];
  return { citadelId: "ws-1", charter, chambers };
}

describe("exportCitadelBlueprint", () => {
  it("produces a v1 blueprint with charter and chambers but no identity/secret data", () => {
    const blueprint = exportCitadelBlueprint(sampleCitadel(), { name: "Co-Founder" });
    expect(blueprint.schemaVersion).toBe(CITADEL_BLUEPRINT_SCHEMA_VERSION);
    expect(blueprint.metadata.name).toBe("Co-Founder");
    expect(blueprint.charter.kind).toBe("company");
    expect(blueprint.chambers.map((chamber) => chamber.name)).toEqual(["General", "Finance"]);
    // No citadelId / chamberId / timestamps leak into the portable artifact.
    expect(JSON.stringify(blueprint)).not.toContain("ws-1");
    expect(JSON.stringify(blueprint)).not.toContain("ch-1");
    expect(blueprint.riskNotes.length).toBeGreaterThan(0);
  });

  it("round-trips through validation", () => {
    const blueprint = exportCitadelBlueprint(sampleCitadel());
    expect(validateCitadelBlueprint(blueprint).ok).toBe(true);
  });
});

describe("validateCitadelBlueprint", () => {
  it("rejects an unsupported schema version", () => {
    const result = validateCitadelBlueprint({ schemaVersion: "nope", charter: { purpose: "x" }, chambers: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/schemaVersion/i);
  });

  it("requires a charter purpose", () => {
    const result = validateCitadelBlueprint({ schemaVersion: CITADEL_BLUEPRINT_SCHEMA_VERSION, chambers: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/purpose/i);
  });

  it("flags secret-like content", () => {
    const blueprint = exportCitadelBlueprint(sampleCitadel());
    const poisoned = { ...blueprint, charter: { ...blueprint.charter, purpose: "use api_key=sk-livesecret123 here" } };
    const result = validateCitadelBlueprint(poisoned);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/secret/i);
  });
});

describe("applyCitadelBlueprint", () => {
  it("imports a blueprint by upserting a charter and creating its chambers", () => {
    const charters: CitadelCharterInput[] = [];
    const chambers: CitadelChamberInput[] = [];
    const target: CitadelTemplateTarget = {
      upsertCharter: (input) => {
        charters.push(input);
        return { citadelId: input.citadelId } as CitadelCharter;
      },
      createChamber: (input) => {
        chambers.push(input);
        return { chamberId: `c-${chambers.length}`, citadelId: input.citadelId } as CitadelChamber;
      },
      getCitadel: (citadelId) => ({ citadelId }) as Citadel,
    };

    const blueprint = exportCitadelBlueprint(sampleCitadel());
    applyCitadelBlueprint(target, "ws-2", blueprint);

    expect(charters).toHaveLength(1);
    expect(charters[0]?.citadelId).toBe("ws-2");
    expect(charters[0]?.kind).toBe("company");
    expect(chambers.map((chamber) => chamber.name)).toEqual(["General", "Finance"]);
    expect(chambers.every((chamber) => chamber.citadelId === "ws-2")).toBe(true);
  });
});
