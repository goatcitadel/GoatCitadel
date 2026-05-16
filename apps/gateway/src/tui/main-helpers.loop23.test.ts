import { describe, expect, it } from "vitest";
import { HOME_VIEW_CHOICES, MANUAL_SESSION_ENTRY, buildSessionChoices, parseTuiArgs, toText } from "./main-helpers.js";

describe("TUI helper edge decisions loop 23", () => {
  it("keeps the navigation catalog stable for every terminal surface", () => {
    expect(HOME_VIEW_CHOICES.map((choice) => choice.value)).toEqual([
      "dashboard",
      "chat",
      "approvals",
      "promptlab",
      "memory",
      "files",
      "cron",
      "improvement",
      "sessions",
      "costs",
      "tools",
      "tasks",
      "skills",
      "curator",
      "integrations",
      "mesh",
      "npu",
      "system",
      "onboarding",
      "settings",
      "exit",
    ]);
  });

  it("returns only manual session entry when no usable session ids are available", () => {
    expect(buildSessionChoices([{ title: "No id" }, { sessionId: "", title: "Empty id" }])).toEqual([
      { name: "Enter session ID manually", value: MANUAL_SESSION_ENTRY },
    ]);
  });

  it("parses doctor command flags independently of read-only TUI mode", () => {
    expect(parseTuiArgs(["doctor", "--deep", "--json", "--audit-only", "--no-repair", "-y", "--read-only"])).toEqual({
      profile: undefined,
      gateway: undefined,
      readOnly: true,
      doctor: true,
      deep: true,
      yes: true,
      json: true,
      auditOnly: true,
      noRepair: true,
    });
  });

  it("keeps non-serializable TUI values blank instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(toText(cyclic)).toBe("");
    expect(toText(false)).toBe("false");
    expect(toText(null)).toBe("");
  });
});
