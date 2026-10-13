import { describe, expect, it } from "vitest";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { discoveredToolNamesFromResult, searchCallableCapabilities } from "./callable-capability-discovery.js";

const entry = (id: string, overrides: Partial<CapabilityCatalogEntry> = {}): CapabilityCatalogEntry => ({
  capabilityId: id,
  kind: "tool",
  category: "built_in",
  callable: true,
  title: id,
  summary: "Read calendar events",
  toolName: id,
  ...overrides,
});

describe("callable capability discovery", () => {
  it("returns bounded metadata only and never promotes inactive or proposal records", () => {
    const result = searchCallableCapabilities({
      query: "calendar",
      callableCatalog: [
        entry("inactive", { callable: false }),
        entry("proposal", { kind: "proposal" }),
        ...Array.from({ length: 8 }, (_, index) =>
          entry(`calendar.${index}`, { sourceRef: "private/path", declaredTools: ["shell.exec"] }),
        ),
      ],
    });
    expect(discoveredToolNamesFromResult(result)).toEqual([
      "calendar.0",
      "calendar.1",
      "calendar.2",
      "calendar.3",
      "calendar.4",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|declaredTools|inactive|proposal/);
    expect(result.discoveryOnly).toBe(true);
  });

  it("abstains for no match, validates bounds, and treats discovery text as nominations only", () => {
    expect(
      searchCallableCapabilities({ query: "unmatched", callableCatalog: [entry("time.now")] }).capabilities,
    ).toEqual([]);
    expect(() => searchCallableCapabilities({ query: "x", limit: 6, callableCatalog: [] })).toThrow(/bounded/);
    expect(discoveredToolNamesFromResult({ capabilities: [{ kind: "tool", toolName: "shell.exec" }] })).toEqual([]);
    expect(
      discoveredToolNamesFromResult({ discoveryOnly: true, capabilities: [{ kind: "skill", toolName: "shell.exec" }] }),
    ).toEqual([]);
  });
});
