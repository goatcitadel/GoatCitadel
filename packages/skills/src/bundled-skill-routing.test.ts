import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SkillsService } from "./loader.js";

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
