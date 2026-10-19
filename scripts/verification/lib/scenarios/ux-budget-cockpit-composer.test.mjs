import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("cockpit composer lookups in verification helpers", () => {
  it("match the native composer's settled semantics: a textbox labelled Message", () => {
    const composer = read("../../../../apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.tsx");
    // HTML-ARIA allows no explicit role on a textarea (axe aria-allowed-role), so the draft keeps its implicit textbox.
    assert.match(composer, /<textarea\s+id="cockpit-chat-draft"/);
    assert.doesNotMatch(composer, /id="cockpit-chat-draft"[\s\S]{0,200}role="combobox"/);
    assert.match(composer, /htmlFor="cockpit-chat-draft"[^>]*>\s*Message\s*</);
  });

  // Every helper that drives the cockpit composer (cockpit-shell-controls uses &shell=cockpit; async-clarification waits
  // for the cockpit ChatArea section[aria-label="Chat"]).
  for (const helper of [
    "ux-budget-chat.mjs",
    "ux-budget-idle-traffic.mjs",
    "cockpit-shell-controls-proof.mjs",
    "chat-async-clarification-proof.mjs",
  ]) {
    it(`${helper} reaches the cockpit composer as that textbox, never as a combobox`, () => {
      const source = read(`./${helper}`);
      assert.doesNotMatch(source, /getByRole\("combobox", \{ name: "Message"/);
      assert.match(source, /getByRole\("textbox", \{ name: "Message", exact: true \}\)/);
    });
  }
});
