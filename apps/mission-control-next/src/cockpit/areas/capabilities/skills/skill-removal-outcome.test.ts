import { describe, expect, it } from "vitest";
import { removalLeftoversNote, removalOutcomeNote, removalRefusalLine } from "./skill-removal-outcome";

describe("removalLeftoversNote", () => {
  it("counts the temporary folders an applied removal left, in the singular for one", () => {
    expect(removalLeftoversNote({ disposition: "applied", otherScratchFolders: 2 })).toBe(
      "Removed. GoatCitadel left 2 temporary folders in the skills folder that it couldn't confirm were its own.",
    );
    expect(removalLeftoversNote({ disposition: "applied", otherScratchFolders: 1 })).toBe(
      "Removed. GoatCitadel left 1 temporary folder in the skills folder that it couldn't confirm was its own.",
    );
  });

  it("says nothing when none were left, or the removal did not apply", () => {
    expect(removalLeftoversNote({ disposition: "applied" })).toBeUndefined();
    expect(removalLeftoversNote({ disposition: "applied", otherScratchFolders: 0 })).toBeUndefined();
    expect(removalLeftoversNote({ disposition: "blocked", otherScratchFolders: 2 })).toBeUndefined();
  });
});

describe("removalOutcomeNote", () => {
  it("says nothing for an applied removal", () => {
    expect(removalOutcomeNote({ disposition: "applied", reason: "applied" })).toBeUndefined();
  });

  it("says a changed folder was left alone and what to do about it", () => {
    expect(removalOutcomeNote({ disposition: "manual_reconciliation", reason: "runtime_projection_diverged" })).toBe(
      "Not removed. The skill's folder no longer matches the files GoatCitadel checked, so nothing was deleted. Put the checked files back or delete the folder yourself, then remove the skill again.",
    );
    expect(removalOutcomeNote({ disposition: "manual_reconciliation", reason: "runtime_removal_unverifiable" })).toBe(
      "Not removed. GoatCitadel couldn't confirm the skill's folder holds only the files it checked, or couldn't move it aside, so nothing was deleted. Check the skill's folder: replace it with the checked files or delete it yourself, then remove the skill again.",
    );
    expect(removalOutcomeNote({ disposition: "manual_reconciliation" })).toContain("nothing was deleted");
  });

  it("names why a blocked removal stopped, in plain words", () => {
    expect(removalOutcomeNote({ disposition: "blocked", reason: "plugin_still_installed" })).toBe(
      "Not removed. An installed plugin still lists this skill. Uninstall the plugin first.",
    );
    expect(removalOutcomeNote({ disposition: "blocked", reason: "stale_aggregate_revision" })).toBe(
      "Not removed. The skill changed after you asked. Remove it again if you still want it gone.",
    );
    expect(removalOutcomeNote({ disposition: "blocked", reason: "skill_not_revoked" })).toBe(
      "Not removed. The skill was switched on again or changed after you asked, so nothing was deleted.",
    );
    expect(removalOutcomeNote({ disposition: "blocked", reason: "lineage_already_removed" })).toBe(
      "Not removed. This request was for a copy of the skill that was already removed, and the copy here was installed after that, so nothing was deleted. Remove it again to remove this copy.",
    );
    // A refusal no retry can change never tells the operator to try again.
    for (const reason of ["lineage_too_large", "artifact_tamper", "bundled_skill"]) {
      const note = removalOutcomeNote({ disposition: "blocked", reason });
      expect(note).toContain("can't be removed here");
      expect(note).not.toMatch(/again/u);
    }
    for (const reason of [
      "artifact_tamper",
      "bundled_skill",
      "skill_not_revoked",
      "candidate_not_revoked",
      "lineage_too_large",
      "runtime_not_from_check",
      "lineage_already_removed",
      "runtime_record_present",
      "runtime_folder_present",
      undefined,
    ]) {
      const note = removalOutcomeNote({ disposition: "blocked", reason });
      expect(note).toMatch(/^Not removed\. /u);
      expect(note).not.toMatch(/_/u);
    }
  });
});

describe("removalRefusalLine", () => {
  const refusal = (
    reason: string,
    error = "GoatCitadel can't remove it from here, because no uninstalled plugin left it behind.",
  ) =>
    Object.assign(new Error("API error 409"), {
      status: 409,
      body: { error, code: "STATE_CONFLICT", details: { reason } },
    });

  it("shows the Gateway's own plain words for the removal's own refusals", () => {
    expect(removalRefusalLine(refusal("not_left_by_plugin"))).toBe(
      "GoatCitadel can't remove it from here, because no uninstalled plugin left it behind.",
    );
    expect(removalRefusalLine(refusal("version_switched_on", "plain words"))).toBe("plain words");
  });

  it("reads nothing else, so no code reaches the screen", () => {
    expect(removalRefusalLine(refusal("blocked", "CANDIDATE_NOT_REVOKED"))).toBeUndefined();
    expect(removalRefusalLine(Object.assign(new Error("x"), { status: 503, body: { error: "down" } }))).toBeUndefined();
    expect(removalRefusalLine(new Error("plain"))).toBeUndefined();
  });

  it("words each never-on refusal of the effect plainly", () => {
    for (const reason of [
      "runtime_record_present",
      "runtime_folder_present",
      "skills_folder_unreadable",
      "version_switched_on",
      "not_left_by_plugin",
      "lineage_removed",
    ]) {
      const note = removalOutcomeNote({ disposition: "blocked", reason });
      expect(note).toMatch(/^Not removed\. /u);
      expect(note).not.toMatch(/_/u);
    }
    expect(removalOutcomeNote({ disposition: "blocked", reason: "skills_folder_unreadable" })).toBe(
      "Not removed. GoatCitadel couldn't read its skills folder, so nothing was changed. Try again.",
    );
  });
});
