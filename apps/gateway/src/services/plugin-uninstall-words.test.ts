import { describe, expect, it } from "vitest";
import type { StoredPlugin } from "./capability-plugin-store.js";
import { waitingSummary, type UninstallProgress } from "./plugin-uninstall-words.js";

// The words an uninstall answers with while a skill's removal still waits (F12 and Q6), read from the words alone.

const record = { name: "Meeting tools" } as StoredPlugin;

function summary(waiting: UninstallProgress["waiting"]): string {
  return waitingSummary(record, { removed: 2, handedOver: [], waiting });
}

describe("waitingSummary", () => {
  it("names the step that waits for the operator's decision, switching on or installing, and says to decline it", () => {
    expect(summary([{ label: "Notes", reason: "decision", operation: "install_inactive" }])).toBe(
      [
        "Removed 2 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "Installing the skill Notes waits for your decision in the Inbox.",
        "Decline it, then uninstall Meeting tools again to finish.",
      ].join(" "),
    );
    expect(summary([{ label: "Notes", reason: "decision", operation: "activate" }])).toContain(
      "Switching on the skill Notes waits for your decision in the Inbox.",
    );
  });

  it("says to decline them when more than one skill's step waits for a decision", () => {
    expect(
      summary([
        { label: "Notes", reason: "decision", operation: "activate" },
        { label: "Agenda", reason: "decision", operation: "install_inactive" },
      ]),
    ).toBe(
      [
        "Removed 2 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "Switching on the skill Notes waits for your decision in the Inbox.",
        "Installing the skill Agenda waits for your decision in the Inbox.",
        "Decline them, then uninstall Meeting tools again to finish.",
      ].join(" "),
    );
  });

  it("names both what to decline and what to approve when a decision and a removal both wait", () => {
    expect(
      summary([
        { label: "Notes", reason: "decision", operation: "activate" },
        { label: "Agenda", reason: "revoke", operation: "revoke" },
      ]),
    ).toBe(
      [
        "Removed 2 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "Switching on the skill Notes waits for your decision in the Inbox.",
        "Removing the skill Agenda waits for your approval.",
        "Decline each step that waits for your decision and approve each removal that waits for your approval, then",
        "uninstall Meeting tools again to finish.",
      ].join(" "),
    );
  });

  it("says only to decline when a decision waits beside a removal already under way", () => {
    expect(
      summary([
        { label: "Notes", reason: "decision", operation: "activate" },
        { label: "Agenda", reason: "removing" },
      ]),
    ).toContain("Decline each step that waits for your decision, then uninstall Meeting tools again to finish.");
  });
});
