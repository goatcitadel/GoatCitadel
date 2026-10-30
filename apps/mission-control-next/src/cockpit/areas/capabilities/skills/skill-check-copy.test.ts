import { SKILL_HUB_BLOCKER_CODES } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  blockerLines,
  blockerSentence,
  CANT_BE_INSTALLED,
  describeCheckFailure,
  SKILL_BLOCKER_COPY,
  UNKNOWN_BLOCKER_COPY,
} from "./skill-check-copy";

/** The copy guard's own rules, read from the script, so a value an operator reads is held to the same words. */
async function copyRatchets(): Promise<Array<{ id: string; pattern?: RegExp }>> {
  const guard = new URL("../../../../../../../scripts/check-mission-control-next-cockpit-copy.mjs", import.meta.url);
  const module = (await import(/* @vite-ignore */ guard.href)) as {
    COPY_RATCHETS: Array<{ id: string; pattern?: RegExp }>;
  };
  return module.COPY_RATCHETS;
}

const FALLBACK = "The address couldn't be checked.";

describe("skill check copy", () => {
  it("has plain words for every blocker code GoatCitadel's checks name", () => {
    for (const code of SKILL_HUB_BLOCKER_CODES) {
      expect(SKILL_BLOCKER_COPY[code], code).toMatch(/^[A-Z].*\.$/u);
      expect(blockerSentence(code)).toBe(SKILL_BLOCKER_COPY[code]);
    }
    expect(Object.keys(SKILL_BLOCKER_COPY).sort()).toEqual([...SKILL_HUB_BLOCKER_CODES].sort());
    // A code the map doesn't hold is still one of the checks, and never shows as the raw code.
    expect(blockerSentence("ARTIFACT_NOT_RETAINED")).toBe(UNKNOWN_BLOCKER_COPY);
  });

  it("uses none of the words the copy guard keeps out of the cockpit", async () => {
    const rules = (await copyRatchets()).filter((rule) => rule.pattern);
    expect(rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["internal-terms", "glossary-terms"]));
    const values = [
      ...Object.values(SKILL_BLOCKER_COPY),
      UNKNOWN_BLOCKER_COPY,
      CANT_BE_INSTALLED,
      ...[
        "UNKNOWN_FRONTMATTER_DIMENSION",
        "BUNDLE_MANIFEST_INVALID",
        "UNTRUSTED_GIT_HOST",
        "PROMPT_INJECTION_DETECTED",
      ].map((code) => describeCheckFailure(code, FALLBACK)),
    ];
    for (const value of values) {
      for (const rule of rules) {
        const pattern = new RegExp(rule.pattern!.source, rule.pattern!.flags);
        expect(value.match(pattern), `${rule.id}: ${value}`).toBeNull();
      }
    }
  });

  it("explains each blocker once and ends with why it can't be installed", () => {
    expect(blockerLines(["SUSPICIOUS_SCRIPT_INDICATOR", "PERMISSION_WIDENED", "SUSPICIOUS_SCRIPT_INDICATOR"])).toEqual([
      "It includes scripts that look unsafe.",
      "It asks for more than an earlier copy did.",
      "So it can't be installed.",
    ]);
    // Two codes that read the same say it once; a code without its own words reads as one of the checks.
    expect(blockerLines(["MYSTERY_CODE", "OTHER_MYSTERY"])).toEqual([UNKNOWN_BLOCKER_COPY, CANT_BE_INSTALLED]);
  });

  it("says only that it is installed when that is the only reason", () => {
    expect(blockerLines(["SOURCE_ALREADY_INSTALLED", "RUNTIME_ALREADY_EXISTS"])).toEqual(["It's already installed."]);
    expect(blockerLines(["SOURCE_ALREADY_INSTALLED", "AUDIT_MISSING"])).toEqual([
      "It's already installed.",
      "Some of GoatCitadel's checks didn't run on it.",
      CANT_BE_INSTALLED,
    ]);
  });

  it("words a refused check by its reason, and keeps the request's own line for the rest", () => {
    expect(describeCheckFailure("UNKNOWN_FRONTMATTER_DIMENSION", FALLBACK)).toBe(
      "Its SKILL.md has settings GoatCitadel doesn't recognise.",
    );
    expect(describeCheckFailure("BUNDLE_MANIFEST_INVALID", FALLBACK)).toBe("Its list of files isn't valid.");
    expect(describeCheckFailure("UNKNOWN_BUNDLE_DIMENSION", FALLBACK)).toBe("Its list of files isn't valid.");
    expect(describeCheckFailure("UNTRUSTED_GIT_HOST", FALLBACK)).toBe(
      "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.",
    );
    // These two stop the check itself, so they read like the blockers they are.
    expect(describeCheckFailure("PROMPT_INJECTION_DETECTED", FALLBACK)).toBe(
      "Its instructions try to override GoatCitadel's rules. So it can't be installed.",
    );
    expect(describeCheckFailure("PROMPTWARE_SCAN_INCOMPLETE", FALLBACK)).toBe(
      "Some of its files couldn't be checked. So it can't be installed.",
    );
    expect(describeCheckFailure("SOURCE_REFUSED", FALLBACK)).toBe(FALLBACK);
    expect(describeCheckFailure(undefined, FALLBACK)).toBe(FALLBACK);
    // A reason that only looks like one of the map's keys is not one.
    expect(describeCheckFailure("toString", FALLBACK)).toBe(FALLBACK);
  });
});
