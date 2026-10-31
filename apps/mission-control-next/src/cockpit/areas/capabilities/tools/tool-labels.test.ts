import { TOOL_GROUPS } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { TOOL_LABELS, UNKNOWN_TOOL_LABEL, toolLabel } from "./tool-labels";

const GROUPED_TOOLS = TOOL_GROUPS.flatMap((group) =>
  group.toolNames.map((toolName) => ({ group: group.id, toolName })),
);

// The words the cockpit copy guard bans in text an operator reads (scripts/check-mission-control-next-cockpit-copy.mjs,
// COPY_RATCHETS), plus the model-facing words the tool registry's own descriptions use. The guard cannot see these
// labels as runtime data, so this list stands in for it.
const BANNED_WORDS = [
  "projection",
  "projections",
  "durable",
  "posture",
  "canonical",
  "gateway",
  "gateway-authored",
  "owner-reported",
  "caller",
  "callers",
  "admitted",
  "admission",
  "readback",
  "live proof",
  "rebase",
  "rebased",
  "rebasing",
  "evidence",
  "owner",
  "owners",
  "replay",
  "replays",
  "replayed",
  "replaying",
  "revision",
  "revisions",
  "snapshot",
  "snapshots",
  "jail",
  "jailed",
  "allowlist",
  "allowlisted",
  "immutable",
  "change plan",
];

describe("tool labels", () => {
  it("has a plain label for every grouped tool", () => {
    expect(GROUPED_TOOLS).toHaveLength(105);
    for (const { group, toolName } of GROUPED_TOOLS) {
      const label = TOOL_LABELS[toolName];
      expect(label, `${group}: ${toolName}`).toBeTruthy();
      expect(label!.trim(), toolName).not.toBe("");
      // The label is not the tool's name in disguise.
      expect(label!.toLowerCase(), toolName).not.toBe(toolName.toLowerCase());
      expect(toolLabel(toolName)).toBe(label);
    }
  });

  it("has no label for a tool no group lists", () => {
    expect(Object.keys(TOOL_LABELS).sort()).toEqual(GROUPED_TOOLS.map((entry) => entry.toolName).sort());
  });

  it("keeps tool labels free of jargon", () => {
    for (const [toolName, label] of Object.entries(TOOL_LABELS)) {
      for (const banned of BANNED_WORDS) {
        expect(new RegExp(`\\b${banned}\\b`, "i").test(label), `${toolName}: "${label}" uses "${banned}"`).toBe(false);
      }
      // Tool names and their dotted ids stay in the monospace slot, never in a label.
      expect(label, toolName).not.toMatch(/[a-z_]\.[a-z_]/);
    }
  });

  it("writes each label as a short sentence-case phrase", () => {
    for (const [toolName, label] of Object.entries(TOOL_LABELS)) {
      const words = label.trim().split(/\s+/);
      expect(words.length, `${toolName}: "${label}"`).toBeGreaterThanOrEqual(2);
      expect(words.length, `${toolName}: "${label}"`).toBeLessThanOrEqual(7);
      expect(label, toolName).toMatch(/^[A-Z]/);
      expect(label, toolName).not.toMatch(/[.!?:;]$/);
    }
  });

  it("gives the tools of one group different labels, so a row can't be mistaken for another", () => {
    for (const group of TOOL_GROUPS) {
      const labels = group.toolNames.map((toolName) => TOOL_LABELS[toolName]);
      expect(new Set(labels).size, group.id).toBe(labels.length);
    }
  });

  it("says plain words for the examples the panel is built around", () => {
    expect(toolLabel("fs.read")).toBe("Read a file");
    expect(toolLabel("fs.write")).toBe("Write a file");
    expect(toolLabel("shell.exec")).toBe("Run a shell command");
    expect(toolLabel("browser.search")).toBe("Search the web");
    expect(toolLabel("telegram.send")).toBe("Send a Telegram message");
    expect(toolLabel("notify.request")).toBe("Ask for your attention");
  });

  it("falls back to a plain line for a tool it doesn't know, never its raw name", () => {
    expect(UNKNOWN_TOOL_LABEL).toBe("A tool GoatCitadel can use");
    for (const name of ["new.tool", "", "constructor", "__proto__", "toString", "mcp:linear.create_issue"]) {
      expect(toolLabel(name), name).toBe(UNKNOWN_TOOL_LABEL);
    }
  });
});
