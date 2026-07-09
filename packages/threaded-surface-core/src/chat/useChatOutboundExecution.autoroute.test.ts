import { describe, expect, it } from "vitest";
import { shouldAutoRouteSend } from "./useChatOutboundExecution";

describe("shouldAutoRouteSend", () => {
  it("returns false for a first-turn send with no surface lock because Chat is the only surface", () => {
    expect(
      shouldAutoRouteSend({
        action: "send",
        threadEmpty: true,
        surfaceMode: undefined,
      }),
    ).toBe(false);
  });

  it("returns false when the thread is non-empty (later turns do not auto-route)", () => {
    expect(
      shouldAutoRouteSend({
        action: "send",
        threadEmpty: false,
        surfaceMode: undefined,
      }),
    ).toBe(false);
  });

  it("returns false when a surface is locked (explicit mode preserved regardless of thread state)", () => {
    expect(
      shouldAutoRouteSend({
        action: "send",
        threadEmpty: true,
        surfaceMode: "cowork",
      }),
    ).toBe(false);

    expect(
      shouldAutoRouteSend({
        action: "send",
        threadEmpty: true,
        surfaceMode: "code",
      }),
    ).toBe(false);

    expect(
      shouldAutoRouteSend({
        action: "send",
        threadEmpty: true,
        surfaceMode: "chat",
      }),
    ).toBe(false);
  });

  it("returns false for retry actions (retry/edit paths are never auto-routed)", () => {
    expect(
      shouldAutoRouteSend({
        action: "retry",
        threadEmpty: true,
        surfaceMode: undefined,
      }),
    ).toBe(false);

    expect(
      shouldAutoRouteSend({
        action: "edit",
        threadEmpty: true,
        surfaceMode: undefined,
      }),
    ).toBe(false);
  });
});
