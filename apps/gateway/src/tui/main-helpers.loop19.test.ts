import { describe, expect, it } from "vitest";
import {
  MANUAL_SESSION_ENTRY,
  buildHeaderSummaryRows,
  buildSessionChoices,
  formatSessionSummary,
  parseTuiArgs,
  summarizeText,
} from "./main-helpers.js";

describe("Loop 19 TUI command normalization and rendering decisions", () => {
  it("keeps partial command-line flags inert instead of inventing profile or gateway values", () => {
    expect(parseTuiArgs(["--profile", "--gateway", "http://127.0.0.1:8787"])).toMatchObject({
      profile: "--gateway",
      gateway: undefined,
      readOnly: false,
      doctor: false,
    });
    expect(parseTuiArgs(["--gateway"])).toMatchObject({
      profile: undefined,
      gateway: undefined,
      yes: false,
      json: false,
    });
  });

  it("renders live-feed fallback rows without adding empty optional rows", () => {
    expect(
      buildHeaderSummaryRows({
        profile: "ops",
        gateway: "http://127.0.0.1:8787",
        readOnly: true,
        liveState: "degraded",
        lastEventAt: "",
        liveNote: "",
      }),
    ).toEqual([
      { key: "Profile", value: "ops" },
      { key: "Gateway", value: "http://127.0.0.1:8787" },
      { key: "Live", value: "degraded" },
      { key: "Mode", value: "read-only" },
      { key: "Last event", value: "none yet" },
    ]);
  });

  it("keeps session prompt options stable when rows contain malformed dates and non-string titles", () => {
    const choices = buildSessionChoices(
      [
        { sessionId: 123, title: { text: "Ops" }, kind: true, updatedAt: "bad-date" },
        { sessionId: "session-2", title: "Second", kind: "code", updatedAt: "2026-05-14T12:00:00.000Z" },
      ],
      5,
    );

    expect(choices[0]).toEqual({
      name: '{"text":"Ops"} [123] · true · updated bad-date',
      value: "123",
    });
    expect(choices.at(-1)).toEqual({ name: "Enter session ID manually", value: MANUAL_SESSION_ENTRY });
    expect(formatSessionSummary({ sessionId: "session-3", title: "", kind: "", updatedAt: "" })).toBe(
      "(untitled) [session-3] · chat · updated unknown",
    );
  });

  it("summarizes compact terminal text without shifting empty or exact-limit labels", () => {
    expect(summarizeText("one two", 7)).toBe("one two");
    expect(summarizeText("one two three", 10)).toBe("one two...");
    expect(summarizeText(" \n\t ", 10)).toBe("(empty)");
  });
});
