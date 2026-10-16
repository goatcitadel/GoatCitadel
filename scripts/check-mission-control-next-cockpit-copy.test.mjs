import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countCopyRatchets,
  evaluateCopyRatchets,
  findClassicHandoffCopy,
} from "./check-mission-control-next-cockpit-copy.mjs";

const texts = (source) => findClassicHandoffCopy("item.tsx", source).map((finding) => finding.text);

describe("cockpit copy guard", () => {
  it("flags handoff phrasing that points at the classic shell as 'current'", () => {
    assert.deepEqual(texts('return "A decision is pending. Resolve it in current Chat.";'), [
      "Resolve it in current Chat",
    ]);
    assert.deepEqual(texts('<ClassicOwnerLink label="current Ops Kanban" />'), ["current Ops Kanban"]);
    assert.deepEqual(texts("<p>Connection setup is available in current Settings.</p>"), ["current Settings"]);
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

describe("operator-language ratchets", () => {
  it("counts internal terms only in text an operator can read", () => {
    const source = [
      "const durableRun = await fetchDurableRun(runId);",
      'const key = ["durable", "projection"];',
      "<p>The Gateway-authored Inbox projection is stale.</p>",
      'description="Cost posture comes from the canonical record."',
      "      Read status is checked for this caller.",
      "// The durable projection is canonical.",
    ].join("\n");
    assert.deepEqual(countCopyRatchets("areas/inbox/X.tsx", source), { "internal-terms": 5 });
  });

  it("counts pointers without links and accessible names that read IDs", () => {
    assert.deepEqual(countCopyRatchets("areas/work/X.tsx", "<p>Review recovery in Ops.</p>"), {
      "dead-end-pointer": 1,
    });
    assert.deepEqual(countCopyRatchets("areas/work/X.tsx", "<p>Open run</p>"), {});
    assert.deepEqual(
      countCopyRatchets("areas/inbox/X.tsx", "<button aria-label={`Inspect decision ${approval.approvalId}`}>"),
      { "aria-label-id": 1 },
    );
  });

  it("fails above the budget and asks for a lower budget below it", () => {
    const rules = [{ id: "internal-terms", budget: 2, help: "use the glossary" }];
    assert.deepEqual(evaluateCopyRatchets({ "internal-terms": 2 }, rules), []);
    assert.match(evaluateCopyRatchets({ "internal-terms": 3 }, rules)[0], /3 uses, budget 2/);
    assert.match(evaluateCopyRatchets({}, rules)[0], /lower the budget to 0/);
  });
});
