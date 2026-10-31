import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SkillsService } from "./loader.js";
import { rankSkillSelectionCandidates } from "./selection-ranking.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, "../../../skills/bundled");

// Skills adapted from public skill repos (see THIRD_PARTY_NOTICES.md). Activation matches keywords and
// routing phrases as substrings of the whole message, so every row pins which of these a message loads.
const NEW_SKILLS: readonly string[] = [
  "debugging",
  "tdd",
  "grilling",
  "codebase-design",
  "receiving-code-review",
  "secure-coding",
  "source-driven-development",
  "ponytail",
  "spec-driven-development",
];

const CASES: ReadonlyArray<readonly [text: string, expected: readonly string[]]> = [
  ["The checkout test is flaky on CI, find the root cause", ["debugging"]],
  ["Why is this failing only in production? Here is the stack trace", ["debugging"]],
  ["Fix a typo in the README", []],
  ["Tell me a joke", []],
  ["What's the latest news on AI chips?", []],
  ["Harden the empty states and error copy on the settings page", []],
  ["What's a good recipe for grilled chicken?", []],
  ["Summarize this article for me", []],
  ["Add a slugify helper using TDD", ["tdd"]],
  ["Write the test first, then implement the parser", ["tdd"]],
  ["Run the test suite and tell me what fails", []],
  ["Sort the list with the latest first", []],
  ["Grill me on this shared-workspace design", ["grilling"]],
  ["Poke holes in my migration plan", ["grilling"]],
  ["Is this a shallow module? Should I merge these pass-through layers?", ["codebase-design"]],
  ["Design it twice before we pick the cache interface", ["codebase-design"]],
  ["The reviewer said to swap this Map for a plain object, address the review", ["receiving-code-review"]],
  ["Here are the PR comments from the bot, work through them", ["receiving-code-review"]],
  ["Review my pull request", []],
  ["Do a security review of this login handler", ["secure-coding"]],
  ["Is this query open to SQL injection?", ["secure-coding"]],
  ["Check the official docs and write the Next.js streaming route handler", ["source-driven-development"]],
  ["Is this API deprecated in the version we use? Follow the migration guide", ["source-driven-development"]],
  ["use ponytail and add CSV export to the report page", ["ponytail"]],
  ["$bundled:ponytail add CSV export to the report page", ["ponytail"]],
  ["Keep this change small and minimal", []],
  ["@skill spec-driven-development for team invites", ["spec-driven-development"]],
  ["use spec-driven-development to plan the export feature", ["spec-driven-development"]],
  ["Write a spec for this feature", []],
  // Substring false positives found in the branch review.
  ["What's a good recipe for a flaky pie crust?", []],
  ["What's the root cause of inflation?", []],
  ["Make the chart readable for red-green colour blindness", []],
  ["Sort the feed latest-first", []],
  ["Stress-test my API with 1000 concurrent users", []],
  ["Grill this steak recipe for me", []],
  ["Interview me about my career for the podcast", []],
  ["Check the docs/ folder and update the changelog", []],
  ["Write a migration guide for users upgrading to 2.0", []],
  ["Leave review comments on the open pull request", []],
  ["Give me review feedback on my blog post draft", []],
];

let service: SkillsService;

beforeAll(async () => {
  service = new SkillsService([{ source: "bundled", dir: bundledDir }]);
  await service.reload();
});

function selectedNew(text: string): string[] {
  return service
    .resolveActivation({ text })
    .selected.map((skill) => skill.name)
    .filter((name) => NEW_SKILLS.includes(name))
    .sort();
}

describe("bundled skill routing", () => {
  it.each(CASES)("%s", (text, expected) => {
    expect(selectedNew(text)).toEqual([...expected].sort());
  });
});

// The gateway's ranked selection mode nominates candidates by metadata score instead of substring match.
const EXPLICIT_ONLY = ["bundled:ponytail", "bundled:spec-driven-development"];
const RANKED_UNNAMED = [
  "Keep this change small and minimal",
  "Make the smallest possible change to fix this",
  "Write a spec for this feature",
  "Write a written specification before any code for the export feature",
];

describe("bundled skill ranked selection", () => {
  it.each(RANKED_UNNAMED)("does not nominate an explicit-only skill for %s", async (text) => {
    const ranked = rankSkillSelectionCandidates({ text }, await service.reload(), 5);
    const nominated = ranked.candidates.map((candidate) => candidate.skillId);
    expect(nominated.filter((skillId) => EXPLICIT_ONLY.includes(skillId))).toEqual([]);
  });
});
