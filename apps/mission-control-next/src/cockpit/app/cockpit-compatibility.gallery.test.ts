import { afterEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({ enabled: true }));
vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isDevDiagnosticsEnabled: () => diagnostics.enabled,
}));

const { resolveCockpitCompatibility } = await import("./cockpit-compatibility");

describe("SH-35: component gallery", () => {
  afterEach(() => {
    diagnostics.enabled = true;
  });

  it("opens in development and verification builds", () => {
    expect(resolveCockpitCompatibility("/__gallery")).toEqual({ kind: "native", href: "/__gallery" });
  });

  it("is not a page in a shipped cockpit", () => {
    diagnostics.enabled = false;
    expect(resolveCockpitCompatibility("/__gallery")).toEqual({ kind: "missing" });
  });
});
