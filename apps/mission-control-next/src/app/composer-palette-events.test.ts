import { describe, expect, it } from "vitest";
import { OPEN_CHAT_COMPOSER_PALETTE_EVENT, requestChatComposerPaletteOpen } from "./composer-palette-events";

describe("requestChatComposerPaletteOpen", () => {
  it("reports whether an eligible Chat composer claimed the shell shortcut", () => {
    const claimed = new EventTarget();
    claimed.addEventListener(OPEN_CHAT_COMPOSER_PALETTE_EVENT, (event) => event.preventDefault());
    expect(requestChatComposerPaletteOpen(claimed)).toBe(true);

    expect(requestChatComposerPaletteOpen(new EventTarget())).toBe(false);
    expect(requestChatComposerPaletteOpen({})).toBe(false);
  });
});
