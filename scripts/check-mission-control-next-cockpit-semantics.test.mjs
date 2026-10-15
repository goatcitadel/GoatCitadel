import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFile, countLiveRegions } from "./check-mission-control-next-cockpit-semantics.mjs";

describe("cockpit semantics guard", () => {
  it("keeps EmptyState and Callout off live regions and prefixes", () => {
    assert.deepEqual(checkFile("ui/EmptyState.tsx", '<section role="status"><h2>Empty</h2></section>'), [
      "ui/EmptyState.tsx: EmptyState must not be a live region",
    ]);
    assert.deepEqual(checkFile("ui/Callout.tsx", '<strong>{"Problem: "}</strong>'), [
      'ui/Callout.tsx: no "Problem:"-style prefixes',
    ]);
    assert.deepEqual(checkFile("ui/Callout.tsx", "<div role={live ? \"alert\" : undefined}>{children}</div>"), []);
  });

  it("counts every live-region form", () => {
    assert.equal(countLiveRegions('<p role="status"/><p role="alert"/><p aria-live="polite"/><p role={x ? "alert" : "status"}/>'), 4);
    assert.equal(countLiveRegions('<p role="group"/>'), 0);
  });

  it("allows layer-level z-index only in layer owners", () => {
    assert.deepEqual(checkFile("ui/Tooltip.tsx", 'className="z-60 rounded-sm"'), []);
    assert.deepEqual(checkFile("areas/work/WorkBoard.tsx", 'className="fixed z-50 inset-0"'), [
      "areas/work/WorkBoard.tsx:1: layer z-index outside a layer owner",
    ]);
    assert.deepEqual(checkFile("areas/chat/ChatTranscript.tsx", 'className="sticky z-10"'), []);
  });

  it("requires isModifiedClick when a new file intercepts link clicks", () => {
    const intercepting = '<a href="/work" onClick={(event) => { event.preventDefault(); go(); }}>Work</a>';
    assert.deepEqual(checkFile("areas/inbox/NewLink.tsx", intercepting), [
      "areas/inbox/NewLink.tsx: intercepts clicks on a link without isModifiedClick",
    ]);
    const guarded = '<a href="/work" onClick={(event) => { if (isModifiedClick(event)) return; event.preventDefault(); }}>Work</a>';
    assert.deepEqual(checkFile("areas/inbox/NewLink.tsx", guarded), []);
  });
});
