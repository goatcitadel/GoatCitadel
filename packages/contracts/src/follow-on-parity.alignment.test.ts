import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FOLLOW_ON_PARITY_EPIC_IDS, FOLLOW_ON_PARITY_RECOMMENDED_ORDER } from "./follow-on-parity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const followOnRegisterPath = resolve(repoRoot, "docs/FOLLOW_ON_PARITY_REGISTER.md");
const parityStatusPath = resolve(repoRoot, "docs/OPENCLAW_PARITY_STATUS.md");

describe("follow-on parity roadmap alignment", () => {
  it("keeps every follow-on epic id present in both roadmap documents", () => {
    const followOnRegister = readFileSync(followOnRegisterPath, "utf8");
    const parityStatus = readFileSync(parityStatusPath, "utf8");

    for (const epicId of FOLLOW_ON_PARITY_EPIC_IDS) {
      expect(followOnRegister).toContain(epicId);
      expect(parityStatus).toContain(epicId);
    }
  });

  it("keeps the register recommended order aligned with the shared contract list", () => {
    const followOnRegister = readFileSync(followOnRegisterPath, "utf8");
    const section = followOnRegister.split("## Recommended Order")[1];

    expect(section).toBeTruthy();
    if (!section) {
      throw new Error("Expected Recommended Order section in follow-on parity register.");
    }

    const actualOrder = section
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s+`GC-P/.test(line))
      .map((line) => {
        const match = line.match(/`(GC-P\d-\d{2})`/);
        return match?.[1];
      })
      .filter((epicId): epicId is (typeof FOLLOW_ON_PARITY_RECOMMENDED_ORDER)[number] => Boolean(epicId));

    expect(actualOrder).toEqual(FOLLOW_ON_PARITY_RECOMMENDED_ORDER);
  });
});
