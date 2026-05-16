import { describe, expect, it } from "vitest";
import {
  MANUAL_SESSION_ENTRY,
  asRecord,
  buildHeaderSummaryRows,
  buildSessionChoices,
  buildRuntimeLlmSummaryLines,
  formatSessionSummary,
  formatTimestamp,
  parseTuiArgs,
  summarizeText,
  toText,
} from "./main-helpers.js";

describe("TUI main helper loop24 edge coverage", () => {
  it("keeps repeated and unknown command flags deterministic", () => {
    expect(
      parseTuiArgs([
        "--profile",
        "ops",
        "--profile",
        "incident",
        "--gateway",
        "http://127.0.0.1:8787/",
        "--unknown",
        "--doctor",
        "--yes",
      ]),
    ).toEqual({
      profile: "incident",
      gateway: "http://127.0.0.1:8787/",
      readOnly: false,
      doctor: true,
      deep: false,
      yes: true,
      json: false,
      auditOnly: false,
      noRepair: false,
    });
  });

  it("summarizes live-feed rows and session choices without resizing prompt contracts", () => {
    const rows = buildHeaderSummaryRows({
      profile: "operator",
      gateway: "https://gateway.example.test",
      readOnly: false,
      liveState: "reconnecting",
      lastEventAt: "2026-05-14T20:00:00.000Z",
      liveNote: "x".repeat(140),
    });

    expect(rows.map((row) => row.key)).toEqual(["Profile", "Gateway", "Live", "Mode", "Last event", "Feed note"]);
    expect(rows.find((row) => row.key === "Feed note")?.value).toHaveLength(100);
    expect(rows.find((row) => row.key === "Feed note")?.value.endsWith("...")).toBe(true);

    expect(
      buildSessionChoices(
        [
          { sessionId: "session-1", title: "First", kind: "chat", updatedAt: "bad-date" },
          { sessionId: "session-2", title: "Second", kind: "code", updatedAt: "bad-date" },
        ],
        0,
      ),
    ).toEqual([{ name: "Enter session ID manually", value: MANUAL_SESSION_ENTRY }]);

    expect(formatSessionSummary({ sessionId: "session-3", title: "Third", updatedAt: "not-a-date" })).toBe(
      "Third [session-3] · chat · updated not-a-date",
    );
  });

  it("renders the runtime LLM summary with contextWindow when the active model has metadata", () => {
    const lines = buildRuntimeLlmSummaryLines({
      activeProviderId: "openai-codex",
      activeModel: "gpt-5.5",
      providers: [],
      activeModelContextWindow: 272_000,
      activeModelOutputTokenLimit: 32_000,
    });
    expect(lines).toContain("Active provider: openai-codex");
    expect(lines).toContain("Active model: gpt-5.5");
    expect(lines.some((line) => line.includes("272,000"))).toBe(true);
    expect(lines.some((line) => line.includes("32,000"))).toBe(true);
  });

  it("omits contextWindow lines when the active model metadata is missing", () => {
    const lines = buildRuntimeLlmSummaryLines({
      activeProviderId: "custom",
      activeModel: "unknown-model",
      providers: [],
    });
    expect(lines).toContain("Active provider: custom");
    expect(lines).toContain("Active model: unknown-model");
    expect(lines.some((line) => line.toLowerCase().includes("context window"))).toBe(false);
    expect(lines.some((line) => line.toLowerCase().includes("output limit"))).toBe(false);
  });

  it("coerces timestamps, records, and compact labels defensively", () => {
    expect(formatTimestamp("1970-01-01T00:00:00.000Z")).toEqual(expect.any(String));
    expect(asRecord(new Date("2026-05-14T20:00:00.000Z"))).toBeInstanceOf(Date);
    expect(asRecord({ nested: true })).toEqual({ nested: true });
    expect(toText(["a", "b"])).toBe('["a","b"]');
    expect(summarizeText("abcdef", 6)).toBe("abcdef");
    expect(summarizeText("abcdefg", 6)).toBe("abc...");
  });
});
