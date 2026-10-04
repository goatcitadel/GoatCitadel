import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { capabilityChecks } from "./capabilities";

const mocks = vi.hoisted(() => ({
  fetchCapabilityCatalog: vi.fn(),
  fetchCapabilityCatalogDriftMetrics: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => mocks);

const TOOL = { capabilityId: "tool:fs.read", kind: "tool", callable: true };
const CANDIDATE = { capabilityId: "candidate:c1:v1", kind: "candidate_skill", callable: false };
const HEALTHY_METRICS = { callableSubsetValid: true, orphanCallableCapabilityIds: [] };

function catalogs(callable: unknown[], inspectable: unknown[]) {
  mocks.fetchCapabilityCatalog.mockImplementation(async (scope: string) => ({
    scope,
    items: scope === "callable" ? callable : inspectable,
  }));
}

beforeEach(() => {
  mocks.fetchCapabilityCatalog.mockReset();
  mocks.fetchCapabilityCatalogDriftMetrics.mockReset();
  mocks.fetchCapabilityCatalogDriftMetrics.mockResolvedValue(HEALTHY_METRICS);
});

function run() {
  return findCheck(capabilityChecks, "capabilities.callable-invariants").run(makeTestContext());
}

describe("capability invariants", () => {
  it("passes when only active, inspectable entries are callable", async () => {
    catalogs([TOOL], [TOOL, CANDIDATE]);
    await expect(run()).resolves.toMatchObject({
      status: "pass",
      summary: "1 callable of 2 inspectable; no inactive entry is callable.",
    });
  });

  it("fails when a candidate is callable", async () => {
    catalogs([TOOL, { ...CANDIDATE, callable: true }], [TOOL, CANDIDATE]);
    await expect(run()).rejects.toThrow("Inactive candidates or proposals are callable: candidate:c1:v1.");
  });

  it("fails when a callable entry is missing from the inspectable catalog", async () => {
    catalogs([TOOL], [CANDIDATE]);
    await expect(run()).rejects.toThrow("missing from the inspectable catalog: tool:fs.read");
  });

  it("fails when the drift metrics report an invalid subset", async () => {
    catalogs([TOOL], [TOOL]);
    mocks.fetchCapabilityCatalogDriftMetrics.mockResolvedValueOnce({ ...HEALTHY_METRICS, callableSubsetValid: false });
    await expect(run()).rejects.toThrow("not a valid subset");
  });
});
