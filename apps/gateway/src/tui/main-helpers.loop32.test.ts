import { describe, expect, it } from "vitest";
import {
  MANUAL_SESSION_ENTRY,
  buildHeaderSummaryRows,
  buildSessionChoices,
  parseTuiArgs,
  summarizeText,
} from "./main-helpers.js";

describe("TUI main helpers loop32 edge coverage", () => {
  it("keeps repeated flags last-write-wins while preserving safe defaults", () => {
    expect(parseTuiArgs(["--profile", "default", "--profile", "ops", "--gateway", "http://127.0.0.1:8787"])).toEqual({
      profile: "ops",
      gateway: "http://127.0.0.1:8787",
      readOnly: false,
      doctor: false,
      deep: false,
      yes: false,
      json: false,
      auditOnly: false,
      noRepair: false,
    });
    expect(parseTuiArgs(["--gateway"])).toMatchObject({ gateway: undefined });
  });

  it("bounds session choices and header notes without dropping manual entry", () => {
    const choices = buildSessionChoices(
      Array.from({ length: 4 }, (_, index) => ({
        sessionId: `session-${index}`,
        title: `Session ${index}`,
        kind: index % 2 === 0 ? "chat" : "cowork",
        updatedAt: "invalid-date",
      })),
      2,
    );

    expect(choices).toHaveLength(3);
    expect(choices.map((choice) => choice.value)).toEqual(["session-0", "session-1", MANUAL_SESSION_ENTRY]);
    const feedNote = buildHeaderSummaryRows({
      profile: "ops",
      gateway: "http://127.0.0.1:8787",
      readOnly: true,
      liveState: "reconnecting",
      lastEventAt: "",
      liveNote: "alpha ".repeat(40),
    }).at(-1);
    expect(feedNote?.key).toBe("Feed note");
    expect(feedNote?.value).toHaveLength(100);
    expect(feedNote?.value).toMatch(/^alpha alpha/);
    expect(feedNote?.value).toMatch(/\.\.\.$/);
    expect(summarizeText("abc", 3)).toBe("abc");
  });
});
