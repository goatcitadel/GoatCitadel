import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkFile,
  countLiveRegions,
  countSemanticRatchets,
  findUnguardedLinkHandlers,
} from "./check-mission-control-next-cockpit-semantics.mjs";

describe("names, Callout regions and phone inputs (GL-L01, GL-R01)", () => {
  it("flags an aria-label that does not start with the element's literal visible text", () => {
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<button aria-label="Search commands">Search<kbd>K</kbd></button>'), {});
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<button aria-label="Open the palette">Search</button>'), {
      "label-in-name": 1,
    });
    // An arrow handler before the label doesn't end the tag.
    assert.deepEqual(
      countSemanticRatchets("areas/x/X.tsx", '<button onClick={() => go()} aria-label="Open the palette">Search</button>'),
      { "label-in-name": 1 },
    );
    assert.deepEqual(
      countSemanticRatchets("areas/x/X.tsx", '<button onClick={() => go()} aria-label="Search commands">Search</button>'),
      {},
    );
    // A control inside a visible <label> is named by it; an aria-label that disagrees overrides the visible name.
    assert.deepEqual(
      countSemanticRatchets("areas/x/X.tsx", '<label>Kind<select aria-label="Filter by kind"><option /></select></label>'),
      { "label-in-name": 1 },
    );
    assert.deepEqual(
      countSemanticRatchets("areas/x/X.tsx", '<label>Kind<select aria-label="Kind of record"><option /></select></label>'),
      {},
    );
  });

  it("counts Callout without announce={false} as a live region", () => {
    assert.equal(countLiveRegions('<Callout tone="info">Saved.</Callout>'), 1);
    assert.equal(countLiveRegions('<Callout tone="info" announce={false}>Read me.</Callout>'), 0);
  });

  it("flags aria-label on div, span or p without a role", () => {
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<div aria-label="Run summary">…</div>'), {
      "aria-label-no-role": 1,
    });
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<div role="group" aria-label="Run summary">…</div>'), {});
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<section aria-label="Run summary">…</section>'), {});
  });

  it("flags inputs without cockpitInputClass or text-md below sm (iOS zoom)", () => {
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<input className="rounded-md border px-2 text-sm" />'), {
      "phone-input-size": 1,
    });
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", "<input className={cockpitInputClass} />"), {});
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<input className="text-md sm:text-sm" />'), {});
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<input type="checkbox" className="size-4 text-sm" />'), {});
    // iOS zooms selects and text areas too.
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<select className="min-h-10 rounded-md px-2 text-sm">'), {
      "phone-input-size": 1,
    });
    assert.deepEqual(countSemanticRatchets("areas/x/X.tsx", '<textarea className="w-full text-xs" />'), {
      "phone-input-size": 1,
    });
  });
});

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
      "areas/inbox/NewLink.tsx:1: intercepts clicks on a link without isModifiedClick",
    ]);
    const guarded = '<a href="/work" onClick={(event) => { if (isModifiedClick(event)) return; event.preventDefault(); }}>Work</a>';
    assert.deepEqual(checkFile("areas/inbox/NewLink.tsx", guarded), []);
  });

  it("checks every link handler on its own, inline or named", () => {
    const source = [
      'const open = (event) => { if (isModifiedClick(event)) return; event.preventDefault(); go("/a"); };',
      'const jump = (event) => { event.preventDefault(); go("/b"); };',
      '<a href="/a" onClick={open}>A</a>',
      '<a href="/b" onClick={jump}>B</a>',
      '<a href="/c" onClick={(event) => { event.preventDefault(); go("/c"); }}>C</a>',
      '<button type="button" onClick={(event) => { event.preventDefault(); save(); }}>Save</button>',
    ].join("\n");
    assert.deepEqual(findUnguardedLinkHandlers(source), [4, 5]);
  });
});
