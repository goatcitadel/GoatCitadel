import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "@goatcitadel/contracts";
import { resolveSkillPrecedence } from "./precedence.js";

const skill = (name: string, source: LoadedSkill["source"], mtime: string): LoadedSkill => ({
  skillId: `${source}:${name}`,
  name,
  source,
  dir: `/tmp/${source}/${name}`,
  declaredTools: [],
  requires: [],
  keywords: [],
  instructionBody: "",
  mtime,
});

describe("resolveSkillPrecedence", () => {
  it("prefers workspace over managed over bundled over extra", () => {
    const out = resolveSkillPrecedence([
      skill("research", "bundled", "2025-01-01T00:00:00.000Z"),
      skill("research", "managed", "2025-01-02T00:00:00.000Z"),
      skill("research", "workspace", "2025-01-03T00:00:00.000Z"),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe("workspace");
  });

  it("keeps newer same-precedence skills and sorts names", () => {
    const out = resolveSkillPrecedence([
      skill("zeta", "extra", "2025-01-01T00:00:00.000Z"),
      skill("alpha", "bundled", "2025-01-01T00:00:00.000Z"),
      skill("alpha", "extra", "2025-01-03T00:00:00.000Z"),
      skill("alpha", "bundled", "2025-01-04T00:00:00.000Z"),
      skill("alpha", "bundled", "2025-01-02T00:00:00.000Z"),
    ]);

    expect(out.map((item) => `${item.name}:${item.source}:${item.mtime}`)).toEqual([
      "alpha:bundled:2025-01-04T00:00:00.000Z",
      "zeta:extra:2025-01-01T00:00:00.000Z",
    ]);
  });
});
