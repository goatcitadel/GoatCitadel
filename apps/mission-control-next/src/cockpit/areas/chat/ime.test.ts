import { describe, expect, it } from "vitest";
import { isImeEnter } from "./ime";

const keyEvent = (init: { isComposing?: boolean; nativeKeyCode?: number; keyCode?: number }) =>
  ({
    keyCode: init.keyCode ?? 13,
    nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.nativeKeyCode ?? 13 },
  }) as Parameters<typeof isImeEnter>[0];

describe("isImeEnter", () => {
  it("recognizes composition by flag or by Safari's keyCode 229", () => {
    expect(isImeEnter(keyEvent({ isComposing: true }))).toBe(true);
    expect(isImeEnter(keyEvent({ nativeKeyCode: 229 }))).toBe(true);
    expect(isImeEnter(keyEvent({ keyCode: 229 }))).toBe(true);
    expect(isImeEnter(keyEvent({}))).toBe(false);
  });
});
