import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSafeArea, countAnatomy, evaluateAnatomy } from "./check-mission-control-next-page-anatomy.mjs";

describe("page-anatomy guard", () => {
  it("counts raw page titles outside Chat, bare radius, eyebrows and card surfaces", () => {
    const source = [
      '<h1 className="text-xl">Spend</h1>',
      '<div className="rounded border p-2">',
      '<p className="text-xs uppercase tracking-wide text-accent">Run</p>',
      '<section className="rounded-lg border border-line p-4">',
    ].join("\n");
    assert.deepEqual(countAnatomy("areas/system/X.tsx", source), {
      "raw-h1": 1,
      "bare-rounded": 1,
      eyebrow: 1,
      "card-surface": 1,
    });
  });

  it("allows Chat's own header, radius tokens and plain labels", () => {
    assert.deepEqual(countAnatomy("areas/chat/X.tsx", '<h1 className="text-lg">Conversation</h1>'), {});
    assert.deepEqual(countAnatomy("ui/X.tsx", '<div className="rounded-md bg-sunken text-xs">Label</div>'), {});
  });

  it("counts phone-sized text boxes and requires safe-area padding on the tab bar", () => {
    assert.deepEqual(countAnatomy("areas/chat/X.tsx", '<textarea\n  rows={2}\n  className="w-full text-sm"\n/>'), {
      "small-textarea": 1,
    });
    assert.deepEqual(countAnatomy("areas/chat/X.tsx", '<textarea className="w-full text-md sm:text-sm" />'), {});
    assert.deepEqual(checkSafeArea("app/MobileTabBar.tsx", '<nav className="flex">'), [
      "app/MobileTabBar.tsx: bottom-edge phone chrome must use cockpit-safe-bottom",
    ]);
    assert.deepEqual(checkSafeArea("app/MobileTabBar.tsx", '<nav className="flex cockpit-safe-bottom">'), []);
  });

  it("fails above the budget and asks for a lower budget below it", () => {
    const rules = [{ id: "card-surface", budget: 3, help: "flatten", count: () => 0 }];
    assert.deepEqual(evaluateAnatomy({ "card-surface": 3 }, rules), []);
    assert.match(evaluateAnatomy({ "card-surface": 4 }, rules)[0], /4 uses, budget 3/);
    assert.match(evaluateAnatomy({ "card-surface": 1 }, rules)[0], /lower the budget to 1/);
  });
});
