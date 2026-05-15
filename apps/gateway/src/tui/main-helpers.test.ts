import { describe, expect, it } from "vitest";
import {
  HOME_VIEW_CHOICES,
  MANUAL_SESSION_ENTRY,
  asRecord,
  buildHeaderSummaryRows,
  buildSessionChoices,
  formatSessionSummary,
  formatTimestamp,
  parseTuiArgs,
  summarizeText,
  toText,
} from "./main-helpers.js";

describe("TUI main helpers", () => {
  it("parses command flags without changing positional doctor compatibility", () => {
    expect(
      parseTuiArgs([
        "--profile",
        "ops",
        "--gateway",
        "http://127.0.0.1:8787",
        "doctor",
        "--read-only",
        "--deep",
        "-y",
        "--json",
        "--audit-only",
        "--no-repair",
      ]),
    ).toEqual({
      profile: "ops",
      gateway: "http://127.0.0.1:8787",
      readOnly: true,
      doctor: true,
      deep: true,
      yes: true,
      json: true,
      auditOnly: true,
      noRepair: true,
    });

    expect(parseTuiArgs(["--doctor", "--yes"]).doctor).toBe(true);
    expect(parseTuiArgs(["--doctor", "--yes"]).yes).toBe(true);
  });

  it("builds stable navigation and header decisions for the terminal shell", () => {
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
      "integrations",
      "mesh",
      "npu",
      "system",
      "onboarding",
      "settings",
      "exit",
    ]);

    expect(
      buildHeaderSummaryRows({
        profile: "local",
        gateway: "http://127.0.0.1:8787",
        readOnly: false,
        liveState: "connected",
        lastEventAt: "not-a-date",
        liveNote: "  runtime   probe   recovered  ",
      }),
    ).toEqual([
      { key: "Profile", value: "local" },
      { key: "Gateway", value: "http://127.0.0.1:8787" },
      { key: "Live", value: "connected" },
      { key: "Mode", value: "read+safe-write" },
      { key: "Last event", value: "not-a-date" },
      { key: "Feed note", value: "runtime probe recovered" },
    ]);

    expect(
      buildHeaderSummaryRows({
        profile: "prod",
        gateway: "https://gateway.example.test",
        readOnly: true,
        liveState: "offline",
      }).find((row) => row.key === "Mode")?.value,
    ).toBe("read-only");
  });

  it("formats session choices and text coercion without leaking malformed values into prompts", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(toText("direct")).toBe("direct");
    expect(toText(42)).toBe("42");
    expect(toText(false)).toBe("false");
    expect(toText(null)).toBe("");
    expect(toText({ ok: true })).toBe('{"ok":true}');
    expect(toText(circular)).toBe("");
    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asRecord([])).toEqual({});
    expect(formatTimestamp("")).toBe("unknown");
    expect(formatTimestamp("still-pending")).toBe("still-pending");
    expect(summarizeText("  alpha \n beta  ")).toBe("alpha beta");
    expect(summarizeText("", 10)).toBe("(empty)");
    expect(summarizeText("abcdefghijkl", 8)).toBe("abcde...");

    const choices = buildSessionChoices(
      [
        { sessionId: "session-1", title: "Ops", kind: "cowork", updatedAt: "not-a-date" },
        { sessionId: "", title: "Missing id" },
        { sessionId: "session-2", title: "", kind: "", updatedAt: "" },
      ],
      1,
    );
    expect(choices).toEqual([
      { name: "Ops [session-1] · cowork · updated not-a-date", value: "session-1" },
      { name: "Enter session ID manually", value: MANUAL_SESSION_ENTRY },
    ]);
    expect(formatSessionSummary({ sessionId: "session-2", updatedAt: "" })).toBe(
      "(untitled) [session-2] · chat · updated unknown",
    );
    expect(buildSessionChoices([])).toEqual([{ name: "Enter session ID manually", value: MANUAL_SESSION_ENTRY }]);
    expect(
      formatSessionSummary({
        sessionId: 99,
        title: { name: "Ops" },
        kind: false,
        updatedAt: "2026-05-14T00:00:00.000Z",
      }),
    ).toContain("[99] · false · updated");
  });
});
