import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_BUDGET_THRESHOLDS,
  evaluateChatBudget,
  evaluateHorizontalOverflow,
  evaluateRailReach,
  evaluateToastBudget,
  findRawCopyTokens,
  ownerDescriptionLines,
  withoutOwnerText,
} from "./ux-budgets.mjs";

describe("UX budgets", () => {
  it("exempts only exact owner-supplied lines from the raw-copy check", () => {
    const owner = "Perform approved click, type, press, wait_for_selector, or wait steps.";
    const visible = ["Library", owner, "Status: wait_for_selector"].join("\n");
    assert.deepEqual(
      findRawCopyTokens(withoutOwnerText(visible, new Set([owner]))).map(({ token }) => token),
      ["wait_for_selector"],
    );
    assert.equal(withoutOwnerText(visible, new Set()), visible);
  });

  it("recognizes the Classic Library's truncated owner description", () => {
    const long = `${"Perform approved click, type, press, wait_for_selector, or wait steps. ".repeat(3)}End.`;
    const [full, preview] = ownerDescriptionLines(long);
    assert.equal(full, long);
    assert.equal(preview, long.slice(0, 140).trimEnd());
    const classicRow = `${preview}\n\n…`;
    assert.deepEqual(findRawCopyTokens(withoutOwnerText(classicRow, new Set([full, preview]))), []);
    assert.deepEqual(ownerDescriptionLines("Short summary."), ["Short summary."]);
  });

  it("catches technical copy but leaves plain text and tool names alone", () => {
    const raw = "task_updated /api/v1/chat/sessions/sess_57696ff7ad69ef722fc07b8f Network error POST 3f2b8c1e-9a4d-4c2b-8e1f-0a9b8c7d6e5f";
    assert.deepEqual(
      [...new Set(findRawCopyTokens(raw).map((finding) => finding.kind))].sort(),
      ["api-path", "enum", "prefixed-id", "transport-error", "uuid"],
    );
    assert.deepEqual(findRawCopyTokens("Waiting on you. Used web.search. Set GOATCITADEL_AUTH_MODE."), []);
  });

  it("enforces desktop and phone Chat space", () => {
    assert.deepEqual(evaluateChatBudget({ viewportHeight: 900, scrollerHeight: 540 }, "desktop"), {
      ratio: 0.6,
      threshold: CHAT_BUDGET_THRESHOLDS.desktop,
      pass: true,
    });
    assert.equal(evaluateChatBudget({ viewportHeight: 844, scrollerHeight: 0 }, "mobile").pass, false);
    assert.throws(() => evaluateChatBudget({ viewportHeight: 0, scrollerHeight: 1 }, "mobile"));
  });

  it("requires a quiet cold load, a full-height rail, and no document overflow", () => {
    assert.equal(evaluateToastBudget(0).pass, true);
    assert.equal(evaluateToastBudget(2).pass, false);
    assert.deepEqual(evaluateRailReach({ railVisible: true, railBottom: 828, viewportHeight: 900 }), { gap: 72, pass: false });
    assert.equal(evaluateRailReach({ railVisible: false, railBottom: 0, viewportHeight: 844 }).pass, true);
    assert.equal(evaluateHorizontalOverflow({ scrollWidth: 1441, clientWidth: 1440 }).pass, true);
    assert.equal(evaluateHorizontalOverflow({ scrollWidth: 1460, clientWidth: 1440 }).pass, false);
  });
});
