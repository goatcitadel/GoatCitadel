import { describe, expect, it } from "vitest";
import { ROUTE_RELEASE_SCOPE } from "./route-release-scope";

const INTERNAL_WORDS = /\b(projection|canonical|authority|durable|replay)\b/i;

describe("release scope notes (U-GL-034)", () => {
  it("use the glossary's words, not internal architecture words", () => {
    const offenders = Object.entries(ROUTE_RELEASE_SCOPE)
      .filter(([, scope]) => INTERNAL_WORDS.test(scope.note))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("keeps the two rewritten notes as the operator reads them", () => {
    const notes = Object.values(ROUTE_RELEASE_SCOPE).map((scope) => scope.note);
    expect(notes).toContain(
      "Journey shows skill learning, candidate reviews, memory, approvals and their effects, and Skill Hub changes including rollback and revoke. Imports and changes made on other screens are experimental here.",
    );
    expect(notes).toContain(
      "Saved boards keep only their layout. Every widget reads its saved record again and never changes how GoatCitadel runs.",
    );
  });
});
