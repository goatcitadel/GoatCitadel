// The Mason — the deterministic core of the Citadel setup experience (spec §9/§10).
// The conversational runtime wraps these: it asks MASON_SETUP_QUESTIONS, drafts a
// Blueprint (see citadel-blueprints.ts), and shows generateBlueprintReviewSummary
// before the human opens any Gates. Nothing here connects or activates anything.

import type { CitadelBlueprint } from "./citadel-blueprints.js";

/** The Mason's core setup questions (spec §9.5). */
export const MASON_SETUP_QUESTIONS: readonly string[] = [
  "What do you want this Citadel to help you run?",
  "What does success look like?",
  "What are the top 3 things it should help with first?",
  "What information is sensitive?",
  "Who, if anyone, should have access?",
  "What integrations might help?",
  "What should always require approval?",
  "What should it never do?",
  "What should it watch for?",
  "What should it review daily, weekly, or monthly?",
  "Should this Citadel prioritize privacy, convenience, collaboration, or automation?",
  "Should cloud AI be allowed, or should sensitive work prefer local AI?",
];

export interface BlueprintReviewSummary {
  name: string;
  kind: string;
  chamberCount: number;
  sealedChamberCount: number;
  boundaries: string[];
  riskNotes: string[];
  /** Human-readable review lines for the staged (not yet activated) Citadel. */
  lines: string[];
}

/**
 * Produce the Mason's human-readable review of a drafted Blueprint (spec §10.4 output,
 * §6.1 step 5). Always includes the review-before-activation notice — staging a Citadel
 * never connects accounts or opens Gates.
 */
export function generateBlueprintReviewSummary(blueprint: CitadelBlueprint): BlueprintReviewSummary {
  const chambers = blueprint.chambers ?? [];
  const sealed = chambers.filter((chamber) => chamber.sealed);
  const boundaries = blueprint.charter.boundaries ?? [];
  const riskNotes = blueprint.riskNotes ?? [];

  const lines: string[] = [
    `Citadel: ${blueprint.metadata.name} (${blueprint.charter.kind})`,
    `Purpose: ${blueprint.charter.purpose}`,
    `Chambers: ${chambers.length} (${sealed.length} sealed)`,
    ...boundaries.map((boundary) => `Boundary: ${boundary}`),
    "Nothing is connected or activated yet — review what this Citadel can see, remember, watch, and do, then open the Gates you trust.",
    ...riskNotes.map((note) => `Risk note: ${note}`),
  ];

  return {
    name: blueprint.metadata.name,
    kind: blueprint.charter.kind,
    chamberCount: chambers.length,
    sealedChamberCount: sealed.length,
    boundaries,
    riskNotes,
    lines,
  };
}
