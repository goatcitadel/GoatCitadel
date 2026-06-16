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
  CITADEL_TEMPLATES,
  applyCitadelTemplate,
  findCitadelTemplate,
  isWithinCitadelScope,
  resolveCitadelScope,
} from "./citadels.js";

describe("resolveCitadelScope", () => {
  it("resolves citadelId from workspaceId when citadelId is absent", () => {
    expect(resolveCitadelScope({ workspaceId: "ws-1" })).toEqual({ citadelId: "ws-1" });
  });

  it("prefers an explicit citadelId over workspaceId", () => {
    expect(resolveCitadelScope({ citadelId: "c-1", workspaceId: "ws-1" })).toEqual({ citadelId: "c-1" });
  });

  it("includes chamberId when present", () => {
    expect(resolveCitadelScope({ workspaceId: "ws-1", chamberId: "ch-1" })).toEqual({
      citadelId: "ws-1",
      chamberId: "ch-1",
    });
  });

  it("returns undefined when no identity is present", () => {
    expect(resolveCitadelScope({})).toBeUndefined();
    expect(resolveCitadelScope(undefined)).toBeUndefined();
    expect(resolveCitadelScope({ workspaceId: "   " })).toBeUndefined();
  });
});

describe("isWithinCitadelScope", () => {
  it("lets an unscoped viewer (global operator inbox) see everything", () => {
    expect(isWithinCitadelScope({ citadelId: "a" }, undefined)).toBe(true);
    expect(isWithinCitadelScope(undefined, undefined)).toBe(true);
  });

  it("hides items that belong to a different citadel", () => {
    expect(isWithinCitadelScope({ citadelId: "a" }, { citadelId: "b" })).toBe(false);
  });

  it("hides unscoped items from a citadel-scoped viewer", () => {
    expect(isWithinCitadelScope(undefined, { citadelId: "a" })).toBe(false);
  });

  it("shows same-citadel items to a citadel-scoped viewer", () => {
    expect(isWithinCitadelScope({ citadelId: "a", chamberId: "ch-1" }, { citadelId: "a" })).toBe(true);
  });

  it("restricts a chamber-scoped viewer to that chamber plus citadel-general items", () => {
    expect(isWithinCitadelScope({ citadelId: "a", chamberId: "ch-1" }, { citadelId: "a", chamberId: "ch-1" })).toBe(
      true,
    );
    expect(isWithinCitadelScope({ citadelId: "a", chamberId: "ch-2" }, { citadelId: "a", chamberId: "ch-1" })).toBe(
      false,
    );
    // A citadel-general item (no chamber) stays visible to a chamber-scoped viewer.
    expect(isWithinCitadelScope({ citadelId: "a" }, { citadelId: "a", chamberId: "ch-1" })).toBe(true);
  });
});

describe("citadel templates", () => {
  it("exposes built-in templates with unique ids and non-empty content", () => {
    expect(CITADEL_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    const ids = CITADEL_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of CITADEL_TEMPLATES) {
      expect(template.purpose.length).toBeGreaterThan(0);
      expect(template.chambers.length).toBeGreaterThan(0);
    }
  });

  it("finds a template by id", () => {
    expect(findCitadelTemplate("company-co-founder")?.kind).toBe("company");
    expect(findCitadelTemplate("nope")).toBeUndefined();
  });

  it("applies a template by upserting a charter and creating its chambers", () => {
    const charters: CitadelCharterInput[] = [];
    const chambers: CitadelChamberInput[] = [];
    const target: CitadelTemplateTarget = {
      upsertCharter: (input) => {
        charters.push(input);
        return { citadelId: input.citadelId } as CitadelCharter;
      },
      createChamber: (input) => {
        chambers.push(input);
        return { chamberId: `ch-${chambers.length}`, citadelId: input.citadelId } as CitadelChamber;
      },
      getCitadel: (citadelId) => ({ citadelId } as Citadel),
    };

    const template = findCitadelTemplate("project-command");
    expect(template).toBeDefined();
    applyCitadelTemplate(target, "ws-1", template!);

    expect(charters).toHaveLength(1);
    expect(charters[0]?.citadelId).toBe("ws-1");
    expect(charters[0]?.kind).toBe("project");
    expect(chambers).toHaveLength(template!.chambers.length);
    expect(chambers.every((chamber) => chamber.citadelId === "ws-1")).toBe(true);
  });
});
