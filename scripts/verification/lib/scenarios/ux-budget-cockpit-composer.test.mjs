import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("cockpit composer lookups in verification helpers", () => {
  it("match the native composer's settled semantics: a combobox labelled Message", () => {
    const composer = read("../../../../apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.tsx");
    assert.match(composer, /id="cockpit-chat-draft"[\s\S]{0,200}role="combobox"/);
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
    it(`${helper} reaches the cockpit composer as that combobox, never as a textbox`, () => {
      const source = read(`./${helper}`);
      assert.doesNotMatch(source, /getByRole\("textbox", \{ name: "Message"/);
      assert.match(source, /getByRole\("combobox", \{ name: "Message", exact: true \}\)/);
    });
  }
});
