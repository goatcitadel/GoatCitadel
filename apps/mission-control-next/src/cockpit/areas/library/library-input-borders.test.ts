import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(join(here, file), "utf8");

describe("Library form field borders", () => {
  it.each([
    "LibraryNoteEditor.tsx",
    "LibraryMailCompose.tsx",
    "LibraryJourney.tsx",
    "LibraryKnowledgeSourceFields.tsx",
  ])("%s gives its fields the 3:1 control border (U-LB-002)", (file) => {
    const input = /const INPUT = "([^"]*)"/.exec(read(file))![1]!;
    expect(input).toContain("border-line-control");
    expect(input).not.toMatch(/(^|\s)border-line(\s|$)/);
  });
});
