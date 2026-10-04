import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findClassicHandoffCopy } from "./check-mission-control-next-cockpit-copy.mjs";

const texts = (source) => findClassicHandoffCopy("item.tsx", source).map((finding) => finding.text);

describe("cockpit copy guard", () => {
  it("flags handoff phrasing that points at the classic shell as 'current'", () => {
    assert.deepEqual(texts('return "A decision is pending. Resolve it in current Chat.";'), ["Resolve it in current Chat"]);
    assert.deepEqual(texts('<ClassicOwnerLink label="current Ops Kanban" />'), ["current Ops Kanban"]);
    assert.deepEqual(texts('<p>Connection setup is available in current Settings.</p>'), ["current Settings"]);
    assert.deepEqual(texts('<ClassicOwnerLink label="Review in current controls" />'), ["current controls"]);
  });

  it("allows descriptive uses that mean the present Chat", () => {
    assert.deepEqual(texts("<p>This legacy-only grant does not govern current Chat.</p>"), []);
    assert.deepEqual(texts('description="The Gateway will record this answer for the current Chat turn."'), []);
    assert.deepEqual(texts("`history is unavailable; current Chat turns are unchanged.`"), []);
    assert.deepEqual(texts('aria-label="Current Chat question"'), []);
    assert.deepEqual(texts("// the only destination is the bound current Chat selection."), []);
  });

  it("accepts the classic-view vocabulary", () => {
    assert.deepEqual(texts('<ClassicOwnerLink label="Open this question in the classic view" />'), []);
  });
});
