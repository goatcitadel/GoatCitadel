import { describe, expect, it } from "vitest";
import { CHANGE_PLAN_KINDS } from "@goatcitadel/contracts";
import {
  EVOLUTION_GOVERNED_MUTATION_INVENTORY,
  EVOLUTION_MUTATION_EXCLUSIONS,
  assertEvolutionGovernanceInventory,
} from "./evolution-control-plane-governance.js";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";

describe("Evolution Control Plane governed route inventory", () => {
  it("enumerates every allowlisted durable mutation kind exactly once", () => {
    expect(() => assertEvolutionGovernanceInventory()).not.toThrow();
    expect(EVOLUTION_GOVERNED_MUTATION_INVENTORY.map((entry) => entry.kind).sort()).toEqual(
      [...CHANGE_PLAN_KINDS].sort(),
    );
  });

  it("keeps deliberate exclusions explicit and outside the Change Plan taxonomy", () => {
    expect(EVOLUTION_MUTATION_EXCLUSIONS.map((entry) => entry.category)).toEqual(
      expect.arrayContaining([
        "client_local_preferences",
        "ordinary_content_crud",
        "project_task_memory_crud",
        "ordinary_tool_side_effects",
      ]),
    );
    expect(EVOLUTION_MUTATION_EXCLUSIONS.every((entry) => entry.reason.length > 20 && entry.examples.length > 0)).toBe(
      true,
    );
  });

  it("binds compatibility entrypoints to one named owner mutation boundary", () => {
    for (const entry of EVOLUTION_GOVERNED_MUTATION_INVENTORY) {
      expect(entry.mutationBoundary).toMatch(/ChangePlanAdapter\.(apply|stage)$/u);
      expect(entry.canonicalEntryPoints).toContain("POST /api/v1/change-plans");
    }
  });

  it("normalizes every registered owner to the inspect, describeInputs, validate, apply, verify, and reconcile contract", () => {
    const registry = new EvolutionControlPlaneAdapterRegistry([
      {
        adapterId: "contract-probe",
        version: 1,
        kinds: ["runtime_configuration"],
        prepare: async (context) => ({
          target: { ownerId: "runtime_settings", resourceId: "budget_mode", expectedRevision: 1 },
          title: "Budget mode",
          summary: "Use the bounded balanced mode.",
          impact: "Future turns use the selected budget posture.",
          risk: "safe",
          status: "awaiting_confirmation",
          requiredAction: context.actions.confirmation({ title: "Confirm", confirmationText: "Use balanced mode." }),
        }),
        apply: async () => ({ status: "completed", result: { summary: "Applied." } }),
        verify: async () => ({ status: "completed", result: { summary: "Verified." } }),
        reconcile: async () => ({ effectObserved: true, status: "completed", result: { summary: "Observed." } }),
      },
    ]);
    const adapter = registry.get("runtime_configuration");
    expect(adapter.inspect).toBeTypeOf("function");
    expect(adapter.describeInputs).toBeTypeOf("function");
    expect(adapter.validate).toBeTypeOf("function");
    expect(adapter.apply).toBeTypeOf("function");
    expect(adapter.verify).toBeTypeOf("function");
    expect(adapter.reconcile).toBeTypeOf("function");
  });
});
