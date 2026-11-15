import type { IntegrationCatalogEntry } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { integrationOptionLabel, needsCompanionDevice, orderCreatableCatalog } from "./integration-catalog-order";

function entry(overrides: Partial<IntegrationCatalogEntry>): IntegrationCatalogEntry {
  return {
    catalogId: "automation.gmail",
    kind: "automation",
    key: "gmail",
    label: "Gmail",
    description: "",
    maturity: "native",
    authMethods: [],
    capabilities: [],
    ...overrides,
  };
}

describe("orderCreatableCatalog", () => {
  it("puts native entries first and keeps each group in catalog order", () => {
    const ordered = orderCreatableCatalog([
      entry({ catalogId: "b1", maturity: "beta" }),
      entry({ catalogId: "n1" }),
      entry({ catalogId: "p1", maturity: "planned" }),
      entry({ catalogId: "n2" }),
    ]);
    expect(ordered.map((item) => item.catalogId)).toEqual(["n1", "n2", "b1", "p1"]);
  });
});

describe("integrationOptionLabel", () => {
  it("marks beta and planned entries and nothing else", () => {
    expect(integrationOptionLabel(entry({ label: "Gmail" }))).toBe("Gmail");
    expect(integrationOptionLabel(entry({ label: "Notes", maturity: "beta" }))).toBe("Notes (beta)");
    expect(integrationOptionLabel(entry({ label: "Later", maturity: "planned" }))).toBe("Later (planned)");
  });
});

describe("needsCompanionDevice", () => {
  it("is true for platform entries and for entries that take a bridge address", () => {
    expect(needsCompanionDevice(entry({ kind: "platform" }))).toBe(true);
    const bridge = entry({
      kind: "productivity",
      formSchema: { catalogId: "x", title: "X", fields: [{ key: "bridgeUrl", label: "Bridge", type: "text" }] },
    } as Partial<IntegrationCatalogEntry>);
    expect(needsCompanionDevice(bridge)).toBe(true);
  });
  it("is false for a plain automation entry", () => {
    expect(needsCompanionDevice(entry({}))).toBe(false);
  });
});
