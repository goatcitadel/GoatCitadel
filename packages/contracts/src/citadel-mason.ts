// The Mason — the deterministic core of the Citadel setup experience (spec §9/§10).
// The conversational runtime wraps these: it asks MASON_SETUP_QUESTIONS, drafts a
// Blueprint (see citadel-blueprints.ts), and shows generateBlueprintReviewSummary
// before the human opens any Gates. Nothing here connects or activates anything.

import type { CitadelKind, CitadelRiskPosture } from "./citadels.js";
import { CITADEL_TEMPLATES } from "./citadels.js";
import type { CitadelBlueprint, CitadelBlueprintChamber } from "./citadel-blueprints.js";
import { CITADEL_BLUEPRINT_SCHEMA_VERSION } from "./citadel-blueprints.js";

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

/**
 * Structured setup answers the Mason collects (the conversational runtime turns
 * freeform replies to MASON_SETUP_QUESTIONS into this shape).
 */
export interface MasonAnswers {
  kind: CitadelKind;
  purpose: string;
  name?: string;
  goals?: string[];
  /** Each becomes a sealed, restricted Chamber. */
  sensitiveAreas?: string[];
  boundaries?: string[];
  successDefinition?: string[];
  riskPosture?: CitadelRiskPosture;
  preferLocalForSensitive?: boolean;
}

/**
 * Deterministically draft a Blueprint from structured answers (the Mason's
 * generate-blueprint step, §9.4 / §22.2). Picks a starter template by kind,
 * seals each stated sensitive area into its own restricted Chamber, and applies
 * the chosen boundaries/posture. The result always validates and contains no secrets.
 */
export function draftBlueprintFromAnswers(answers: MasonAnswers): CitadelBlueprint {
  const template = CITADEL_TEMPLATES.find((entry) => entry.kind === answers.kind);

  const chambers: CitadelBlueprintChamber[] = (template?.chambers ?? [{ name: "General" }]).map((chamber) => ({
    name: chamber.name,
    sensitivity: chamber.sensitivity ?? "private",
    sealed: chamber.sealed ?? false,
  }));

  for (const area of answers.sensitiveAreas ?? []) {
    const name = area.trim();
    if (name.length === 0 || chambers.some((chamber) => chamber.name.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    chambers.push({ name, sensitivity: "restricted", sealed: true });
  }

  return {
    schemaVersion: CITADEL_BLUEPRINT_SCHEMA_VERSION,
    metadata: { name: answers.name?.trim() || template?.name || "New Citadel" },
    charter: {
      purpose: answers.purpose,
      kind: answers.kind,
      goals: answers.goals ?? template?.goals ?? [],
      boundaries: answers.boundaries ?? template?.boundaries ?? [],
      successDefinition: answers.successDefinition ?? template?.successDefinition ?? [],
      riskPosture: answers.riskPosture ?? template?.riskPosture ?? "balanced",
      modelPolicyDefault: answers.preferLocalForSensitive
        ? "local_only"
        : (template?.modelPolicyDefault ?? "hybrid_guarded"),
    },
    chambers,
    riskNotes: ["This Blueprint contains structure only — no credentials, secrets, tokens, or private data."],
  };
}
