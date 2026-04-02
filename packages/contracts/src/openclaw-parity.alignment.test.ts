import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OPENCLAW_PARITY_COMPLETION_ORDER,
  OPENCLAW_PARITY_EPICS,
  OPENCLAW_PARITY_OPEN_EPIC_IDS,
} from "./openclaw-parity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const parityStatusPath = resolve(repoRoot, "docs/OPENCLAW_PARITY_STATUS.md");
const completionProgramPath = resolve(repoRoot, "docs/OPENCLAW_PARITY_COMPLETION_PROGRAM.md");

describe("openclaw parity roadmap alignment", () => {
  it("keeps every parity epic present in the main status document", () => {
    const parityStatus = readFileSync(parityStatusPath, "utf8");

    for (const epic of OPENCLAW_PARITY_EPICS) {
      expect(parityStatus).toContain(epic.epicId);
      expect(parityStatus).toContain(epic.label);
    }
  });

  it("keeps every open epic present in the completion program", () => {
    const completionProgram = readFileSync(completionProgramPath, "utf8");

    for (const epicId of OPENCLAW_PARITY_OPEN_EPIC_IDS) {
      expect(completionProgram).toContain(epicId);
    }
  });

  it("keeps the full-program completion order aligned with the shared contract list", () => {
    const completionProgram = readFileSync(completionProgramPath, "utf8");
    const section = completionProgram.split("## Completion Order")[1];

    expect(section).toBeTruthy();
    if (!section) {
      throw new Error("Expected Completion Order section in OpenClaw parity completion program.");
    }

    const actualOrder = section
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s+`GC-P/.test(line))
      .map((line) => {
        const match = line.match(/`(GC-P\d-\d{2})`/);
        return match?.[1];
      })
      .filter((epicId): epicId is typeof OPENCLAW_PARITY_COMPLETION_ORDER[number] => Boolean(epicId));

    expect(actualOrder).toEqual(OPENCLAW_PARITY_COMPLETION_ORDER);
  });
});
