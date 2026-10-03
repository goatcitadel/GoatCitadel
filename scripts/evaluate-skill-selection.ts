import {
  GENERATED_SKILL_ROUTING_HINTS,
  resolveSkillActivation,
  rankSkillSelectionCandidates,
} from "../packages/skills/src/index.js";
import type { LoadedSkill } from "@goatcitadel/contracts";

// Curated public examples, not operator transcripts or a real-world quality benchmark.
const skills: LoadedSkill[] = Object.entries(GENERATED_SKILL_ROUTING_HINTS).map(([name, routingHints]) => ({
  skillId: `bundled:${name}`,
  name,
  source: "bundled",
  dir: "",
  declaredTools: [],
  requires: [],
  keywords: [],
  routingHints,
  instructionBody: "",
  mtime: "",
}));
const cases = [
  { text: "Fix a code bug and add a regression test", expected: "coding" },
  { text: "Review presentation design and slide deck accessibility", expected: "design-intelligence" },
  { text: "Review skill architecture and runtime governance", expected: "agentic-skill-architect" },
  { text: "@skill coding", expected: "coding" },
  { text: "Decode this word", expected: undefined },
  { text: "Tell me a joke", expected: undefined },
];
let baselineHits = 0;
let rankedHits = 0;
let baselineSelections = 0;
let rankedSelections = 0;
const results = cases.map(({ text, expected }, index) => {
  const baseline = resolveSkillActivation({ text }, skills).selected.map((skill) => skill.name);
  const ranked = rankSkillSelectionCandidates({ text }, skills, 3).candidates.map((candidate) =>
    candidate.skillId.replace(/^bundled:/, ""),
  );
  const baselineHit = expected ? baseline.includes(expected) : baseline.length === 0;
  const rankedHit = expected ? ranked.includes(expected) : ranked.length === 0;
  baselineHits += Number(baselineHit);
  rankedHits += Number(rankedHit);
  baselineSelections += baseline.length;
  rankedSelections += ranked.length;
  return { caseId: `SF1-${index + 1}`, expected: expected ?? "none", baseline, ranked, baselineHit, rankedHit };
});
process.stdout.write(
  `${JSON.stringify({ mode: "offline_curated_evaluation", runtimeSelectionChanged: false, cases: cases.length, baselineHits, rankedHits, baselineSelections, rankedSelections, results }, null, 2)}\n`,
);
