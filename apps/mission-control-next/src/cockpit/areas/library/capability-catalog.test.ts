import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCatalogEntry, SkillListItem } from "@goatcitadel/contracts";
import { fetchCapabilityCatalog } from "@goatcitadel/mission-control-shared/api/capabilities";
import { fetchSkills } from "@goatcitadel/mission-control-shared/api/skills";
import { capabilityUsage, filterCapabilities, loadCapabilityCatalog } from "./capability-catalog";

vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({ fetchCapabilityCatalog: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/skills", () => ({ fetchSkills: vi.fn() }));

const entry: CapabilityCatalogEntry = {
  capabilityId: "skill:skill-a",
  skillId: "skill-a",
  kind: "skill",
  category: "built_in",
  title: "Review changes",
  summary: "Review a code change before it is applied.",
  callable: false,
  trustLabel: "reviewed",
};
const skill: SkillListItem = {
  skillId: "skill-a", name: "Review changes", source: "bundled", dir: "skills/review", declaredTools: [],
  requires: [], keywords: [], instructionBody: "Review a code change", mtime: "2026-09-28T00:00:00.000Z",
  revision: 1, state: "enabled", usageCount: 3, lastUsedAt: "2026-09-28T12:00:00.000Z",
};

beforeEach(() => {
  vi.mocked(fetchCapabilityCatalog).mockReset();
  vi.mocked(fetchSkills).mockReset();
  vi.mocked(fetchSkills).mockResolvedValue({ items: [skill] });
});

describe("cockpit capability catalog", () => {
  it("merges inspectable and callable records without losing callability", async () => {
    vi.mocked(fetchCapabilityCatalog).mockImplementation(async (scope) => ({
      scope: scope ?? "inspectable",
      items: scope === "inspectable" ? [entry] : [{ ...entry, callable: true }],
    }));
    const result = await loadCapabilityCatalog();
    expect(result.items).toEqual([{ ...entry, callable: true }]);
    expect(result.callableKnown).toBe(true);
    expect(capabilityUsage(entry, result)).toEqual({ status: "recorded", usageCount: 3, lastUsedAt: skill.lastUsedAt });
    expect(result.issues).toEqual([]);
  });

  it("keeps a partial catalog but marks callability unknown when that owner fails", async () => {
    vi.mocked(fetchCapabilityCatalog).mockImplementation(async (scope) => {
      if (scope === "callable") throw new Error("Network error GET /api/v1/capabilities/catalog");
      return { scope: scope ?? "inspectable", items: [entry] };
    });
    const result = await loadCapabilityCatalog();
    expect(result.items).toEqual([entry]);
    expect(result.callableKnown).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).not.toContain("/api/");
  });

  it("does not infer zero use when the skills source fails or a record is missing", async () => {
    vi.mocked(fetchCapabilityCatalog).mockResolvedValue({ scope: "inspectable", items: [entry] });
    vi.mocked(fetchSkills).mockRejectedValue(new Error("Network error GET /api/v1/skills"));
    const failed = await loadCapabilityCatalog();
    expect(capabilityUsage(entry, failed)).toEqual({ status: "unavailable" });
    expect(failed.issues.at(-1)).toContain("Skill state and usage could not be checked");
    expect(failed.issues.at(-1)).not.toContain("/api/");

    vi.mocked(fetchSkills).mockResolvedValue({ items: [] });
    const missing = await loadCapabilityCatalog();
    expect(capabilityUsage(entry, missing)).toEqual({ status: "unavailable" });
    expect(capabilityUsage({ ...entry, kind: "tool" }, missing)).toEqual({ status: "unsupported" });
  });

  it("filters by search, kind, status, and trust", () => {
    expect(filterCapabilities([entry], { search: "code change", kind: "skill", status: "configured", trust: "reviewed" })).toEqual([entry]);
    expect(filterCapabilities([entry], { search: "code change", kind: "skill", status: "unavailable", trust: "reviewed" })).toEqual([]);
    expect(filterCapabilities([entry], { search: "missing", kind: "all", status: "all", trust: "all" })).toEqual([]);
  });
});
