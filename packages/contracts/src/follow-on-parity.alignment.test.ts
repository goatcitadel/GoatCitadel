import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FOLLOW_ON_PARITY_EPIC_IDS } from "./follow-on-parity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const followOnRegisterPath = resolve(repoRoot, "docs/FOLLOW_ON_PARITY_REGISTER.md");
const parityStatusPath = resolve(repoRoot, "docs/OPENCLAW_PARITY_STATUS.md");
const masterCompletionProgramPath = resolve(repoRoot, "docs/MASTER_COMPLETION_PROGRAM.md");

describe("follow-on parity roadmap alignment", () => {
  it("keeps every follow-on epic id present in both roadmap documents", () => {
    const followOnRegister = readFileSync(followOnRegisterPath, "utf8");
    const parityStatus = readFileSync(parityStatusPath, "utf8");

    for (const epicId of FOLLOW_ON_PARITY_EPIC_IDS) {
      expect(followOnRegister).toContain(epicId);
      expect(parityStatus).toContain(epicId);
    }
  });

  it("delegates cross-workstream ordering to the canonical master program", () => {
    const followOnRegister = readFileSync(followOnRegisterPath, "utf8");
    const masterCompletionProgram = readFileSync(masterCompletionProgramPath, "utf8");

    expect(followOnRegister).toContain("[MASTER_COMPLETION_PROGRAM.md](./MASTER_COMPLETION_PROGRAM.md)");
    expect(followOnRegister).toMatch(/must\s+not be used as a competing implementation sequence/);
    expect(masterCompletionProgram).toContain("Status: canonical aggregate execution ledger");
    expect(masterCompletionProgram).toContain("single execution plan for unfinished GoatCitadel work");
  });
});
