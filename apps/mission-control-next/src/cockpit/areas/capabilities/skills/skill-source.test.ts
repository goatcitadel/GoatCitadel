import type { SkillLifecycleState } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { presentSkillReview, presentSkillSource } from "./skill-source";

describe("where a skill came from", () => {
  it("says it in plain words for each origin", () => {
    expect(presentSkillSource("built_in", undefined)).toBe("Ships with GoatCitadel");
    expect(presentSkillSource("self_authored", undefined)).toBe("Written by GoatCitadel from your chats");
    expect(presentSkillSource("workspace", undefined)).toBe("From this workspace's skills folder");
  });

  it("names only the host of a Git repository a skill was imported from", () => {
    const git = { source: "git", commitSha: "0123456789abcdef0123456789abcdef01234567" };
    expect(presentSkillSource("imported", { ...git, sourceRef: "https://github.com/acme/skills.git" })).toBe(
      "Imported from a Git repository on github.com",
    );
    // A credential or port in the address never shows.
    expect(presentSkillSource("imported", { ...git, sourceRef: "https://user:token@git.example.org:8443/a.git" })).toBe(
      "Imported from a Git repository on git.example.org",
    );
    expect(presentSkillSource("imported", { ...git, sourceRef: "git@gitlab.com:acme/skills.git" })).toBe(
      "Imported from a Git repository on gitlab.com",
    );
  });

  it("names the host of another import, and says plainly when there is none to name", () => {
    expect(presentSkillSource("imported", { source: "clawhub", sourceRef: "https://clawhub.ai/skills/writer" })).toBe(
      "Imported from clawhub.ai",
    );
    expect(presentSkillSource("imported", { source: "local_file", sourceRef: "C:/skills/writer" })).toBe(
      "Imported from outside GoatCitadel",
    );
    expect(presentSkillSource("imported", { source: "git", commitSha: "abc" })).toBe(
      "Imported from outside GoatCitadel",
    );
    expect(presentSkillSource("imported", undefined)).toBe("Imported from outside GoatCitadel");
  });
});

describe("how far a skill was reviewed", () => {
  it.each<[SkillLifecycleState, string]>([
    ["trusted", "Trusted"],
    ["approved", "Reviewed"],
    ["candidate", "Not reviewed yet"],
    ["deprecated", "Retired"],
    ["revoked", "Revoked"],
    ["draft", "Draft"],
  ])("says %s as %j", (state, word) => {
    expect(presentSkillReview(state)).toBe(word);
  });

  it("says nothing when the list doesn't say", () => {
    expect(presentSkillReview(undefined)).toBeUndefined();
  });
});
