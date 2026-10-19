import { describe, expect, it } from "vitest";
import { CITADEL_PAGE_LABELS, RAIL_GROUPS, RAIL_ITEMS } from "./route-model";

/** Citadel-only names. A label that uses one must lead with the plain name: "Rules · Wards" (DESIGN.md › Copy). */
const CITADEL_TERMS = ["Mason", "Wards", "Ward", "Council", "Vault", "Blueprint", "Charter", "Chambers", "Gatehouse"];
const PLAIN_FIRST = new RegExp(`^[^·]+ · (?:${CITADEL_TERMS.join("|")})$`);

const citadelTabLabels = () => {
  const group = RAIL_GROUPS.settings!.find((item) => item.id === "settings-citadel")!;
  return group.sections.map(
    (section) =>
      [...RAIL_ITEMS.settings, ...RAIL_ITEMS.library].find((item) => item.section === section)?.label ?? section,
  );
};

describe("Citadel page names", () => {
  it("puts the plain name first on every Citadel tab that uses a Citadel term", () => {
    const labels = citadelTabLabels();
    expect(labels).toHaveLength(9);
    for (const label of labels) {
      const usesCitadelTerm = CITADEL_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(label));
      if (usesCitadelTerm) expect(label, label).toMatch(PLAIN_FIRST);
      // The plain half never repeats a Citadel term ("Wards · Rules" or "Vault · Vault" fail).
      const plain = label.split(" · ")[0]!;
      expect(
        CITADEL_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(plain)),
        label,
      ).toBe(false);
    }
  });

  it("keeps every governance page in the plain-first form, from one label source", () => {
    const { "citadel-overview": overview, ...governed } = CITADEL_PAGE_LABELS;
    expect(overview).toBe("Citadel overview");
    for (const label of Object.values(governed)) expect(label).toMatch(PLAIN_FIRST);
    for (const [section, label] of Object.entries(CITADEL_PAGE_LABELS))
      expect(RAIL_ITEMS.library.find((item) => item.section === section)?.label).toBe(label);
  });
});
