# Phase 0b — Chat and Shell Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Chat conversation at least 60% of a 1440×900 screen and 55% of a 390×844 phone screen, and fix the shell defects around it.

**Architecture:** First turn on the Chat-space and sidebar checks in the `ux-budgets` lane from Phase 0a, so they fail. Then remove each source of lost space until they pass:

- the footer status strip moves into the top bar
- the thread header becomes one row
- finished change-plan receipts stop pinning above the thread
- a failure is shown once, in the status card
- the composer's option rows fold into its control row
- the phone layout is tightened

Logic changes land in `packages/threaded-surface-core` (receipt visibility) and the focused-work state. The rest is classic-shell markup and CSS.

**Tech Stack:** React 19, TypeScript, vitest (react-test-renderer, happy-dom per file), CSS, Playwright through `scripts/verification`.

**Spec:** [`docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`](../specs/2026-09-27-mission-control-cockpit-design.md) §2, §7.1, §7.3; fixes F-04, F-05, F-06, F-18.

## Global Constraints

- Everything in the roadmap's Global Constraints applies ([roadmap](./2026-09-27-mission-control-cockpit-roadmap.md#global-constraints)).
- **Branch and dependency:** branch `ux/phase-0b` in worktree `../personal-ai-phase-0b` from the latest `origin/main`, after Phase 0a has merged. Phase 0a provides `verify:ux:budgets`, `status-vocabulary.ts`, and the toast placement.
- **Parallel work:** other sessions have edited Chat files in the main checkout before. Coordinate before touching `ThreadedComposer.tsx`, `ThreadedSurfacePage.tsx`, or `MissionThreadedControllerHost.tsx`, and re-read each file immediately before editing.
- **Rebuilds:** after editing `packages/threaded-surface-core`, rebuild it (`pnpm --filter @goatcitadel/threaded-surface-core build`) before running app tests.
- **Stylesheet-text tests:** some tests assert on stylesheet text, so update them when their selectors change:
  - `ThreadedSurfacePage.test.tsx:728-755` and `:769-792`
  - `threaded-surface-styles.test.ts:68+`
  - `MissionControlNextApp.test.tsx:506-518`
- **Chat Ctrl+K:** the 1.0 contract (`unifiedComposerPaletteV1Enabled`) defines what Ctrl+K does in Chat, so this phase does not change it. The cockpit revisits it with a contract update in Phase 9.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `scripts/verification/lib/scenarios/ux-budgets-lane.mjs` | modify | Enforce Chat space and sidebar reach |
| `scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs` | modify | Expect enforcement |
| `apps/mission-control-next/src/app/unified-sidebar.css` | modify | Rail fills the frame; two grid rows |
| `apps/mission-control-next/src/app/unified-sidebar-layout.test.ts` | create | Stylesheet assertions |
| `apps/mission-control-next/src/app/MissionControlShellChrome.tsx` | modify | Status in the top bar; `aria-current` |
| `apps/mission-control-next/src/app/MissionControlNextApp.tsx` | modify | Pass the status as a top-bar slot |
| `apps/mission-control-next/src/styles/mission-control-next.css` | modify | Status popover opens downward; drop the fixed mobile footer |
| `apps/mission-control-next/src/app/MissionControlShellChrome.topbar.test.tsx` | modify | Status slot test |
| `apps/mission-control-next/src/app/MissionControlShellChrome.mobile-nav.test.tsx` | modify | `aria-current` test |
| `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx` | modify | One-row header; pass the Deep-mode action to the timeline |
| `apps/mission-control-next/src/features/threaded-surface/styles/conversation-workspace.css` | modify | Header nowrap; composer spacing |
| `apps/mission-control-next/src/features/threaded-surface/styles/mobile.css` | modify | Phone header and composer |
| `apps/mission-control-next/src/features/threaded-surface/styles/calm-chat.css` | modify | Phone composer cap |
| `packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.ts` | create | When a finished receipt may show; persisted dismissals |
| `packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.test.ts` | create | Tests |
| `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx` | modify | Use the visibility rule and persisted dismissals |
| `packages/mission-control-shared/src/components/chat/ChatChangePlanCard.tsx` | modify | Compact receipt with plain status words |
| `apps/mission-control-next/src/features/threaded-surface/styles/change-plans.css` | modify | No uppercase; compact receipt |
| `apps/mission-control-next/src/features/threaded-surface/FocusedActiveWorkSummary.tsx` | modify | Failure card carries the recovery advice and action |
| `apps/mission-control-next/src/features/threaded-surface/FocusedActiveWorkSummary.test.tsx` | modify | Tests |
| `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx` | modify | Pass the Deep-mode action through |
| `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx` | modify | Remove the duplicate recovery banner; one control row |
| `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.test.tsx` | modify | Tests |

---

### Task 1: Enforce the Chat-space and sidebar checks

**Files:**
- Modify: `scripts/verification/lib/scenarios/ux-budgets-lane.mjs`
- Modify: `scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`

- [ ] **Step 1: Change the test expectation**

In `ux-budgets-lane.test.mjs`, replace the "starts with Chat space and sidebar reach reported, not enforced" test:

```js
  it("enforces Chat space and sidebar reach", () => {
    assert.deepEqual(UX_BUDGET_ENFORCEMENT_DEFAULTS, { chatBudget: true, railReach: true });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`
Expected: FAIL (defaults are still `false`).

- [ ] **Step 3: Flip the defaults**

```js
export const UX_BUDGET_ENFORCEMENT_DEFAULTS = Object.freeze({ chatBudget: true, railReach: true });
```

- [ ] **Step 4: Run the unit test, then the lane to record the red baseline**

Run: `node --test scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`
Expected: PASS.

Run: `pnpm verify:ux:budgets`
Expected: exit 1. `ux-budgets.chat-space.desktop` fails with `message area 0.277 < 0.6; sidebar ends 72px above the viewport bottom`, and `ux-budgets.chat-space.mobile` fails on the message area. Record both ratios for the PR.

- [ ] **Step 5: Commit**

```bash
git add scripts/verification/lib/scenarios/ux-budgets-lane.mjs scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs
git commit -m "test: enforce Chat space and sidebar reach in ux-budgets"
```

---

### Task 2: The sidebar reaches the bottom, and status moves into the top bar

**Files:**
- Modify: `apps/mission-control-next/src/app/unified-sidebar.css` (frame rule at lines 3-14; rail rule at lines 30-47)
- Create: `apps/mission-control-next/src/app/unified-sidebar-layout.test.ts`
- Modify: `apps/mission-control-next/src/app/MissionControlShellChrome.tsx` (`ShellTopbar` props and `.mc-next-topbar-right` at lines 78-229; `ShellStatusStrip` root element at line 539)
- Modify: `apps/mission-control-next/src/app/MissionControlNextApp.tsx` (`<ShellTopbar` at line 918; `<ShellStatusStrip` at line 1001)
- Modify: `apps/mission-control-next/src/styles/mission-control-next.css` (status popover rules; the `@media (max-width: 767px)` block at lines 2464-2511 that fixes the strip to the bottom and offsets the composer)
- Modify: `apps/mission-control-next/src/app/MissionControlShellChrome.topbar.test.tsx`

**Interfaces:**
- Produces:
  - `ShellTopbar` prop `statusSlot?: ReactNode`, rendered first inside `.mc-next-topbar-right`.
  - `ShellStatusStrip` renders `<div className="mc-next-status-strip" data-placement="topbar">` instead of `<footer>`.

Why the gap exists: `mission-control-next.css:1548-1550` sets `max-height: calc(100dvh - 4.5rem)` on `.mc-next-rail`. The unified-sidebar rule sets `height: 100%` but never resets `max-height`, so the rail ends 72px short.

- [ ] **Step 1: Write the failing stylesheet test**

```ts
// apps/mission-control-next/src/app/unified-sidebar-layout.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./unified-sidebar.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

describe("unified sidebar layout", () => {
  it("lets the rail fill the frame height", () => {
    expect(ruleBody(".mc-next-shell .mc-next-app-frame[data-unified-sidebar] .mc-next-rail")).toMatch(/max-height:\s*none/);
  });

  it("uses two rows: top bar and body, with no footer strip row", () => {
    expect(ruleBody(".mc-next-shell .mc-next-app-frame[data-unified-sidebar]")).toMatch(
      /grid-template-rows:\s*auto minmax\(0, 1fr\);/,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/unified-sidebar-layout.test.ts`
Expected: FAIL on both assertions.

- [ ] **Step 3: Fix the CSS**

In `unified-sidebar.css`:
- In the frame rule, change `grid-template-rows: auto minmax(0, 1fr) auto;` to `grid-template-rows: auto minmax(0, 1fr);`.
- In the rail rule, add `max-height: none;` directly after `height: 100%;`.

In `mission-control-next.css`, delete the rules inside the `@media (max-width: 767px)` block that position `.mc-next-status-strip` as `position: fixed` at the bottom and add a bottom offset or padding to the composer for it. Find them with `git grep -n "mc-next-status-strip" -- apps/mission-control-next/src/styles/mission-control-next.css`. Then add, next to the existing `.mc-next-status-details-popover` rule:

```css
.mc-next-status-strip[data-placement="topbar"] {
  position: relative;
  border: 0;
  padding: 0;
  background: transparent;
}

.mc-next-status-strip[data-placement="topbar"] .mc-next-status-details-popover {
  top: calc(100% + 0.4rem);
  right: 0;
  bottom: auto;
  left: auto;
}
```

- [ ] **Step 4: Write the failing top-bar test**

Add to `MissionControlShellChrome.topbar.test.tsx`, reusing that file's existing render helper for `ShellTopbar` (pass the same props it already uses plus `statusSlot`):

```tsx
  it("renders the status slot first in the top bar's right-hand controls", () => {
    const renderer = renderTopbar({ statusSlot: <span data-testid="status-slot">System</span> });
    const right = renderer.root.findByProps({ className: "mc-next-topbar-right" });
    expect(right.children[0]).toMatchObject({ props: { "data-testid": "status-slot" } });
  });
```

If the file's helper is named differently, use that helper. The assertion stays the same: the slot is the first child of `.mc-next-topbar-right`.

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/MissionControlShellChrome.topbar.test.tsx`
Expected: FAIL (`statusSlot` is not rendered).

- [ ] **Step 6: Implement the slot**

In `ShellTopbar`'s props type and destructuring, add `statusSlot?: ReactNode;` and import `type ReactNode` from `react`. Render it first inside `.mc-next-topbar-right`:

```tsx
      <div className="mc-next-topbar-right">
        {statusSlot}
        <button
          type="button"
          className="mc-next-icon-button"
          onClick={onOpenPalette}
```

In `ShellStatusStrip`, change the root element from `<footer className="mc-next-status-strip" aria-label="Mission Control status strip" data-status={systemStatus}>` … `</footer>` to:

```tsx
    <div className="mc-next-status-strip" data-placement="topbar" aria-label="Mission Control status" data-status={systemStatus}>
```

Close it with `</div>`.

In `MissionControlNextApp.tsx`:
1. Cut the whole `<ShellStatusStrip … />` JSX element currently rendered at line 1001, with its props unchanged.
2. Paste it as the value of a new `statusSlot` prop on `<ShellTopbar` (line 918), so the top bar opens like this:

```tsx
            <ShellTopbar
              statusSlot={
                <ShellStatusStrip
```

The rest of the pasted element follows unchanged (all its existing props and the closing `/>`), then the prop closes with `}`. Nothing else renders `ShellStatusStrip` afterwards.

- [ ] **Step 7: Run the shell tests**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app`
Expected: PASS after updating assertions that looked for a `footer` or `"Mission Control status strip"` label. Search with `git grep -n "status strip" -- apps/mission-control-next/src/app/*.test.tsx`.

- [ ] **Step 8: Commit**

```bash
git add apps/mission-control-next/src/app/unified-sidebar.css apps/mission-control-next/src/app/unified-sidebar-layout.test.ts apps/mission-control-next/src/app/MissionControlShellChrome.tsx apps/mission-control-next/src/app/MissionControlNextApp.tsx apps/mission-control-next/src/styles/mission-control-next.css apps/mission-control-next/src/app/MissionControlShellChrome.topbar.test.tsx
git add $(git diff --name-only -- "apps/mission-control-next/src/app/*.test.tsx")
git commit -m "fix: let the sidebar reach the bottom and move system status into the top bar"
```

---

### Task 3: Navigation announces the current page

**Files:**
- Modify: `apps/mission-control-next/src/app/MissionControlShellChrome.tsx` (primary nav button at lines 383-397; sub-nav `mc-next-rail-link` button at lines 426-437; count badge at lines 454-456)
- Modify: `apps/mission-control-next/src/app/MissionControlShellChrome.mobile-nav.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `MissionControlShellChrome.mobile-nav.test.tsx`, reusing `MobileRailHarness` (its route is `settings/providers`):

```tsx
  it("marks the active area and the active section with aria-current", async () => {
    await act(async () => {
      root.render(<MobileRailHarness />);
    });
    const openButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]')!;
    await act(async () => {
      openButton.click();
    });
    const current = [...container.querySelectorAll('[aria-current="page"]')].map((node) => node.textContent?.trim());
    expect(current).toEqual(expect.arrayContaining(["Settings", expect.stringContaining("Providers")]));
  });
```

The file's `beforeEach` provides `root` and `container`. If it names them differently, use its names.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/MissionControlShellChrome.mobile-nav.test.tsx`
Expected: FAIL (the Providers sub-nav button has no `aria-current`).

- [ ] **Step 3: Implement**

On the primary nav button, compute `aria-current` from the same function as the active class:

```tsx
                  aria-current={navigationAreaForRoute(route) === area ? "page" : undefined}
```

On the sub-nav `mc-next-rail-link` button, add:

```tsx
                        aria-current={isRailItemActive(route, item) ? "page" : undefined}
```

Hide a zero approvals badge:

```tsx
                        {typeof backlogCount === "number" && backlogCount > 0 ? (
                          <span className="mc-next-rail-count">{backlogCount}</span>
                        ) : null}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/MissionControlShellChrome.mobile-nav.test.tsx src/app/MissionControlNextApp.test.tsx`
Expected: PASS after updating any assertion that expected a `0` badge.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/app/MissionControlShellChrome.tsx apps/mission-control-next/src/app/MissionControlShellChrome.mobile-nav.test.tsx
git add $(git diff --name-only -- "apps/mission-control-next/src/app/*.test.tsx")
git commit -m "fix: mark the current area and section for assistive technology"
```

---

### Task 4: Finished change-plan receipts stop pinning

**Files:**
- Create: `packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.ts`
- Test: `packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.test.ts`
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx` (dismissal state at line 1172; receipt selection at lines 5678-5706)
- Modify: `packages/mission-control-shared/src/components/chat/ChatChangePlanCard.tsx` (terminal markup at lines 120-149)
- Modify: `apps/mission-control-next/src/features/threaded-surface/styles/change-plans.css` (lines 40-60)
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.test.tsx` (dismissal cases at lines 2121-2206)

**Interfaces:**
- Consumes: `presentChangePlanStatus` from `@goatcitadel/mission-control-shared/content/status-vocabulary` (Phase 0a).
- Produces:
  - `TERMINAL_RECEIPT_FRESH_MS = 600_000`
  - `shouldShowTerminalChangePlanReceipt(input: { originTurnId?: string; latestTurnId?: string; settledAt: string; now: number }): boolean`
  - `readDismissedChangePlanReceiptKeys(storage?: Storage | null): Set<string>`
  - `writeDismissedChangePlanReceiptKeys(keys: ReadonlySet<string>, storage?: Storage | null): void`
  - `DISMISSED_CHANGE_PLAN_RECEIPTS_KEY = "goatcitadel.chat.dismissed-change-plan-receipts.v1"`

Rule:

- **Plan with an origin turn:** its finished receipt shows only while that turn is still the newest turn in the thread.
- **Plan with no origin turn** (for example one made from Settings): the receipt shows for 10 minutes after it settles.
- **Dismissals:** kept in local storage, capped at the 50 most recent. The canonical plan history stays in the Gateway and in Activity.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.test.ts
import { describe, expect, it } from "vitest";
import {
  DISMISSED_CHANGE_PLAN_RECEIPTS_KEY,
  TERMINAL_RECEIPT_FRESH_MS,
  readDismissedChangePlanReceiptKeys,
  shouldShowTerminalChangePlanReceipt,
  writeDismissedChangePlanReceiptKeys,
} from "./change-plan-receipt-visibility";

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const NOW = Date.parse("2026-09-27T12:00:00.000Z");

describe("shouldShowTerminalChangePlanReceipt", () => {
  it("shows a receipt only while its origin turn is the newest turn", () => {
    expect(shouldShowTerminalChangePlanReceipt({ originTurnId: "t-2", latestTurnId: "t-2", settledAt: "2026-09-26T00:00:00Z", now: NOW })).toBe(true);
    expect(shouldShowTerminalChangePlanReceipt({ originTurnId: "t-2", latestTurnId: "t-3", settledAt: "2026-09-27T11:59:00Z", now: NOW })).toBe(false);
  });

  it("shows a receipt without an origin turn for ten minutes", () => {
    const fresh = new Date(NOW - TERMINAL_RECEIPT_FRESH_MS + 1_000).toISOString();
    const stale = new Date(NOW - TERMINAL_RECEIPT_FRESH_MS - 1_000).toISOString();
    expect(shouldShowTerminalChangePlanReceipt({ settledAt: fresh, now: NOW })).toBe(true);
    expect(shouldShowTerminalChangePlanReceipt({ settledAt: stale, now: NOW })).toBe(false);
    expect(shouldShowTerminalChangePlanReceipt({ settledAt: "not a date", now: NOW })).toBe(false);
  });
});

describe("dismissed receipt keys", () => {
  it("round-trips through storage and keeps the 50 most recent", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const keys = new Set(Array.from({ length: 55 }, (_, index) => `plan-${index}:1:completed`));
    writeDismissedChangePlanReceiptKeys(keys, storage);
    const restored = readDismissedChangePlanReceiptKeys(storage);
    expect(restored.size).toBe(50);
    expect(restored.has("plan-54:1:completed")).toBe(true);
    expect(restored.has("plan-0:1:completed")).toBe(false);
  });

  it("returns an empty set for missing or malformed storage", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    storage.setItem(DISMISSED_CHANGE_PLAN_RECEIPTS_KEY, "{not json");
    expect(readDismissedChangePlanReceiptKeys(storage).size).toBe(0);
    expect(readDismissedChangePlanReceiptKeys(null).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/threaded-surface-core exec vitest run src/chat/change-plan-receipt-visibility.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.ts
/*
 * Finished change-plan receipts are a moment-in-time acknowledgement, not a
 * pinned banner. The canonical plan, result, and evidence stay in the Gateway
 * history that Activity shows.
 */

export const TERMINAL_RECEIPT_FRESH_MS = 10 * 60 * 1000;
export const DISMISSED_CHANGE_PLAN_RECEIPTS_KEY = "goatcitadel.chat.dismissed-change-plan-receipts.v1";
const MAX_DISMISSED_KEYS = 50;

export function shouldShowTerminalChangePlanReceipt(input: {
  originTurnId?: string;
  latestTurnId?: string;
  settledAt: string;
  now: number;
}): boolean {
  if (input.originTurnId) {
    return input.originTurnId === input.latestTurnId;
  }
  const settled = Date.parse(input.settledAt);
  return Number.isFinite(settled) && input.now - settled <= TERMINAL_RECEIPT_FRESH_MS;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDismissedChangePlanReceiptKeys(storage?: Storage | null): Set<string> {
  const target = resolveStorage(storage);
  if (!target) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(target.getItem(DISMISSED_CHANGE_PLAN_RECEIPTS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeDismissedChangePlanReceiptKeys(keys: ReadonlySet<string>, storage?: Storage | null): void {
  const target = resolveStorage(storage);
  if (!target) {
    return;
  }
  try {
    target.setItem(DISMISSED_CHANGE_PLAN_RECEIPTS_KEY, JSON.stringify([...keys].slice(-MAX_DISMISSED_KEYS)));
  } catch {
    // Storage can be full or disabled; dismissal still applies for this page.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/threaded-surface-core exec vitest run src/chat/change-plan-receipt-visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the rule into the host**

In `MissionThreadedControllerHost.tsx`, import the three helpers from `./chat/change-plan-receipt-visibility`. Then:

- Initialize dismissals from storage (line 1172):

```ts
  const [dismissedChangePlanReceiptKeys, setDismissedChangePlanReceiptKeys] = useState<Set<string>>(() =>
    readDismissedChangePlanReceiptKeys(),
  );
```

- In the receipt selection (lines 5678-5688), gate the newest terminal plan on the rule:

```ts
  const newestTerminalChangePlan = chatChangePlans.find((plan) => isTerminalChangePlanStatus(plan.status));
  const latestTurnId = thread?.turns.at(-1)?.turnId;
  const terminalReceiptVisible =
    newestTerminalChangePlan !== undefined &&
    !dismissedChangePlanReceiptKeys.has(changePlanReceiptKey(newestTerminalChangePlan)) &&
    shouldShowTerminalChangePlanReceipt({
      originTurnId: newestTerminalChangePlan.origin.turnId,
      latestTurnId,
      settledAt: newestTerminalChangePlan.updatedAt,
      now: Date.now(),
    });
  const transcriptChangePlan =
    activeTranscriptChangePlan ?? (terminalReceiptVisible ? newestTerminalChangePlan : undefined);
```

- Persist on dismiss:

```ts
        onDismiss: (dismissedPlan: ChangePlanRecord) => {
          setDismissedChangePlanReceiptKeys((current) => {
            const next = new Set(current);
            next.add(changePlanReceiptKey(dismissedPlan));
            writeDismissedChangePlanReceiptKeys(next);
            return next;
          });
        },
```

- [ ] **Step 6: Make the receipt compact and plainly worded**

In `ChatChangePlanCard.tsx`, import `presentChangePlanStatus` from `../../content/status-vocabulary.js`. In the terminal branch, replace `<span>{formatStatus(plan.status)}</span>` with:

```tsx
            <span>{presentChangePlanStatus(plan.status).label}</span>
```

In `change-plans.css`, replace both status-label rules (`.chat-change-plan-card > header span` and `.chat-change-plan-receipt-title span`):

```css
.chat-change-plan-card > header span,
.chat-change-plan-receipt-title span {
  color: var(--fg-muted);
  font: 500 var(--text-xs) / 1.2 var(--font-sans);
  text-transform: none;
}

.chat-change-plan-card--terminal {
  padding: 0.35rem 0.6rem;
}
```

- [ ] **Step 7: Update the host dismissal tests and run the suites**

The existing cases at `MissionThreadedControllerHost.test.tsx:2121-2206` build terminal plans. For each case that expects the receipt to be visible, give the plan fixture an `origin.turnId` equal to the fixture thread's last turn id. Then run:

- `pnpm --filter @goatcitadel/mission-control-shared build`
- `pnpm --filter @goatcitadel/threaded-surface-core exec vitest run src/MissionThreadedControllerHost.test.tsx src/chat`
- `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/components/chat/ChatChangePlanCard.test.tsx`

Expected: PASS. In `ChatChangePlanCard.test.tsx`, expect "Done" where it expected the old formatted status.

- [ ] **Step 8: Commit**

```bash
git add packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.ts packages/threaded-surface-core/src/chat/change-plan-receipt-visibility.test.ts packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx packages/threaded-surface-core/src/MissionThreadedControllerHost.test.tsx packages/mission-control-shared/src/components/chat/ChatChangePlanCard.tsx packages/mission-control-shared/src/components/chat/ChatChangePlanCard.test.tsx apps/mission-control-next/src/features/threaded-surface/styles/change-plans.css
git commit -m "fix: stop pinning finished change-plan receipts above the conversation"
```

---

### Task 5: Show a failure once

**Files:**
- Modify: `apps/mission-control-next/src/features/threaded-surface/FocusedActiveWorkSummary.tsx`
  - state type at lines 8-16
  - failure branch at lines 127-134
  - props and render at lines 227-358
- Modify: `apps/mission-control-next/src/features/threaded-surface/FocusedActiveWorkSummary.test.tsx`
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx` (props; the `<FocusedActiveWorkSummary` at line 860)
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx` (`<ThreadedTimeline` render at lines 1237-1246)
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx` (recovery banner at lines 1381-1413)
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.test.tsx`

**Interfaces:**
- Consumes: `getChatTurnRecoveryActionLabel`, `getChatTurnRecoveryActionSummary`, and `type ChatTurnRecoveryAction` from `@goatcitadel/contracts` (`packages/contracts/src/chat.ts:948,1106,1127`).
- Produces:
  - `FocusedActiveWorkState.recovery?: { action: ChatTurnRecoveryAction; label: string; summary: string }`
  - `FocusedActiveWorkSummary` prop `onUseDeepMode?: () => void`
  - `ThreadedTimeline` prop `onUseDeepMode?: () => void`

The status card becomes the single place a failure appears, with the specific recovery advice and actions. The composer's duplicate "Failed" banner is removed. Each turn's own Activity chip stays, because it is per-turn history.

- [ ] **Step 1: Write the failing tests**

Add to `FocusedActiveWorkSummary.test.tsx`, reusing the file's turn fixture helper (whatever it uses to build a failed `ChatThreadTurnRecord`), and set `trace.failure.recommendedAction`:

```tsx
  it("puts the recovery advice for a failed turn in the status card", () => {
    const turn = failedTurnFixture({ recommendedAction: "continue_from_partial" });
    const state = deriveFocusedActiveWorkState({ turn, streamStatus: "idle" });
    expect(state).toMatchObject({
      kind: "failure",
      detail: "Ask GoatCitadel to continue from the strongest leads or partial results it already gathered.",
      recovery: { action: "continue_from_partial", label: "Continue from the strongest leads" },
    });
  });

  it("offers Deep mode from the status card when that is the recovery", () => {
    const onUseDeepMode = vi.fn();
    const state = deriveFocusedActiveWorkState({
      turn: failedTurnFixture({ recommendedAction: "switch_to_deep_mode" }),
      streamStatus: "idle",
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <FocusedActiveWorkSummary
          state={state}
          onFocusComposer={vi.fn()}
          onFocusPendingInput={vi.fn()}
          onOpenActivity={vi.fn()}
          onOpenApprovals={vi.fn()}
          onRetry={vi.fn()}
          onStop={vi.fn()}
          onUseDeepMode={onUseDeepMode}
        />,
      );
    });
    const deep = renderer.root.findAll((node) => node.type === "button" && node.props.children === "Switch to Deep mode");
    expect(deep).toHaveLength(1);
    act(() => deep[0]!.props.onClick());
    expect(onUseDeepMode).toHaveBeenCalledOnce();
  });
```

If the file has no failed-turn fixture helper, add `failedTurnFixture` at the top of the test file. It builds the minimal `ChatThreadTurnRecord` that the file's existing failure test already constructs, with `trace: { status: "failed", failure: { failureClass: "provider_timeout", recommendedAction } }`, `toolRuns: []`, and no `assistantMessage`.

Add to `ThreadedComposer.test.tsx`, using its existing render helper with a failed `selectedTurn` and a `selectedTurnRecovery`:

```tsx
  it("does not repeat a failed turn's recovery banner in the composer", () => {
    const renderer = renderComposer({
      selectedTurn: failedSelectedTurn,
      selectedTurnRecovery: { action: "continue_from_partial", summary: "Ask GoatCitadel to continue." },
    });
    expect(renderer.root.findAll((node) => node.props.className === "mc-next-composer-banner warning")).toHaveLength(0);
  });
```

If the helper and fixture are named differently in the file, use those names.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface/FocusedActiveWorkSummary.test.tsx src/features/threaded-surface/ThreadedComposer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the state change**

In `FocusedActiveWorkSummary.tsx`:

```ts
import {
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  type ChatThreadTurnRecord,
  type ChatTurnFailureClass,
  type ChatTurnRecoveryAction,
} from "@goatcitadel/contracts";
```

```ts
export type FocusedActiveWorkState = {
  kind: FocusedActiveWorkKind;
  title: string;
  detail: string;
  turnId?: string;
  approvalId?: string;
  canRetry: boolean;
  canStop: boolean;
  recovery?: { action: ChatTurnRecoveryAction; label: string; summary: string };
};
```

Replace the plain `failure` return (lines 127-134):

```ts
    const recommendedAction = turn.trace.failure?.recommendedAction;
    const recovery = recommendedAction
      ? {
          action: recommendedAction,
          label: getChatTurnRecoveryActionLabel(recommendedAction),
          summary: getChatTurnRecoveryActionSummary(recommendedAction),
        }
      : undefined;
    return {
      kind: "failure",
      title: humanizeFailure(turn.trace.failure?.failureClass, failedTool?.status),
      detail: recovery?.summary ?? humanizeFailureDetail(turn.trace.failure?.failureClass, failedTool?.status),
      turnId: turn.turnId,
      canRetry: canRetryTurn(turn),
      canStop: false,
      ...(recovery ? { recovery } : {}),
    };
```

Add `onUseDeepMode?: () => void;` to `FocusedActiveWorkSummaryProps`, destructure it in `FocusedActiveWorkSummaryContents`, and render it after the Stop button:

```tsx
        {state.recovery?.action === "switch_to_deep_mode" && onUseDeepMode ? (
          <button type="button" className="mc-next-thread-inline-button" onClick={onUseDeepMode}>
            {state.recovery.label}
          </button>
        ) : null}
```

- [ ] **Step 4: Pass the Deep-mode action down and delete the composer banner**

In `ThreadedTimeline.tsx`, add `onUseDeepMode?: () => void;` to its props type and pass `onUseDeepMode={props.onUseDeepMode}` to `<FocusedActiveWorkSummary` (line 860).

In `ThreadedSurfacePage.tsx`, on the `<ThreadedTimeline` element (lines 1237-1246), add:

```tsx
              onUseDeepMode={activeProps.currentWebMode !== "deep" ? activeProps.onSetDeepMode : undefined}
```

These are the same `activeProps` fields the composer already receives as `currentWebMode` and `onSetDeepMode`.

In `ThreadedComposer.tsx`, delete the whole `{props.selectedTurnRecovery && … ? (<div className="mc-next-composer-banner warning">…</div>) : null}` block (lines 1381-1413). If `formatRecoveryStatus` (lines 33-36) is now unused, delete it too.

- [ ] **Step 5: Rebuild and run the suites**

Run:
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface`

Expected: PASS. Update expectations that looked for "Review run details" or "Retry turn" in the composer: those actions live in the status card as "View activity" and "Retry".

- [ ] **Step 6: Commit**

```bash
git add apps/mission-control-next/src/features/threaded-surface/FocusedActiveWorkSummary.tsx apps/mission-control-next/src/features/threaded-surface/FocusedActiveWorkSummary.test.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.test.tsx
git add $(git diff --name-only -- "apps/mission-control-next/src/features/threaded-surface/*.test.tsx")
git commit -m "fix: show a failed turn once, with its recovery advice, in the status card"
```

---

### Task 6: One-row header and a one-row composer

**Files:**
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx` (header actions at lines 1131-1209)
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx`:
  - options popover at lines 1254-1369
  - active context at lines 1370-1380
  - textarea rows at lines 1452-1470
  - `useAutoGrowTextarea` call at line 799
  - controls at line 1641
- Modify: `apps/mission-control-next/src/features/threaded-surface/styles/conversation-workspace.css`:
  - header actions at lines 233-240
  - textarea min-height at lines 668-673
- Modify: `apps/mission-control-next/src/features/threaded-surface/styles/header.css` (actions `flex-wrap` at lines 165-174)
- Modify: `apps/mission-control-next/src/features/threaded-surface/styles/calm-chat.css` (active context at lines 1-6 and 270-273)
- Test: `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.test.tsx`, `ThreadedComposer.test.tsx`

**Interfaces:**
- Produces:
  - header buttons keep their icon and wrap their text in `<span className="mc-next-header-button-label">`
  - the "Chat details" summary gets `aria-label="Chat details"`
  - the composer's options trigger and active-context chips render inside `.mc-next-composer-controls-start`

- [ ] **Step 1: Write the failing tests**

Add to `ThreadedSurfacePage.test.tsx`, using its existing render helper for an active session:

```tsx
  it("keeps header button text in label spans so small screens can show icons only", () => {
    const renderer = renderActiveSurface();
    const labels = renderer.root
      .findAll((node) => node.props.className === "mc-next-header-button-label")
      .map((node) => node.props.children);
    expect(labels).toEqual(expect.arrayContaining(["Threads", "Activity"]));
  });
```

Add to `ThreadedComposer.test.tsx`:

```tsx
  it("renders options and active context inside the single control row", () => {
    const renderer = renderComposer({ fullWebAccess: true });
    const controlsStart = renderer.root.findByProps({ className: "mc-next-composer-controls-start" });
    expect(controlsStart.findAll((node) => node.props.children === "Full web access")).toHaveLength(1);
    expect(renderer.root.findAll((node) => node.props.className === "mc-next-composer-options-bar")).toHaveLength(0);
  });
```

Use each file's existing helper names.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface/ThreadedSurfacePage.test.tsx src/features/threaded-surface/ThreadedComposer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Header markup**

In `ThreadedSurfacePage.tsx`:
- Wrap the button texts: `Threads` becomes `<span className="mc-next-header-button-label">Threads</span>`, and the same for `Activity`.
- Change `<summary>Chat details</summary>` to:

```tsx
<summary aria-label="Chat details">
  <Info size={14} aria-hidden="true" />
  <span className="mc-next-header-button-label">Details</span>
</summary>
```

Import `Info` from `lucide-react` alongside the existing icons.

- [ ] **Step 4: Header CSS**

In `header.css`, in the header actions rule (lines 165-174), change `flex-wrap: wrap;` to `flex-wrap: nowrap;`. In `conversation-workspace.css`, replace the actions cap (lines 233-240) so the actions never wrap and the title ellipsizes instead:

```css
.mc-next-threaded-header-actions {
  flex: 0 0 auto;
  flex-wrap: nowrap;
  max-width: none;
}

.mc-next-threaded-title-block h1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 5: Composer markup**

In `ThreadedComposer.tsx`:
1. Cut the complete `<ChatOptionsPopover …>…</ChatOptionsPopover>` element (lines 1254-1369) and paste it inside `.mc-next-composer-controls-start`, directly after the closing `</ChatComposerPlusMenu>`.
2. Cut the active-context block (lines 1370-1380) and paste it directly after the popover. Change its wrapper to `<div className="mc-next-composer-active-context is-inline" aria-label="Active context and overrides">`.
3. Delete the now-empty `mc-next-composer-options-bar` wrapper, if one remains around the old position.
4. Change the textarea's `rows={2}` to `rows={1}`, and the minimum-lines argument of the `useAutoGrowTextarea` call (line 799) from `2` to `1`.

- [ ] **Step 6: Composer CSS**

In `calm-chat.css`, add:

```css
.mc-next-composer-active-context.is-inline {
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 0.35rem;
  margin: 0;
  font-family: var(--font-sans);
}
```

In `conversation-workspace.css` (lines 668-673), change the textarea `min-height: 3rem;` to `min-height: 2.25rem;`.

- [ ] **Step 7: Run the suites**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface`
Expected: PASS after updating stylesheet-text tests (`ThreadedSurfacePage.test.tsx:728-755`, `:769-792`, `threaded-surface-styles.test.ts:68+`) whose expected declarations changed. Also update any `useAutoGrowTextarea.test.tsx` case that asserted a two-line minimum through the composer.

- [ ] **Step 8: Commit**

```bash
git add apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx apps/mission-control-next/src/features/threaded-surface/styles/header.css apps/mission-control-next/src/features/threaded-surface/styles/conversation-workspace.css apps/mission-control-next/src/features/threaded-surface/styles/calm-chat.css
git add $(git diff --name-only -- "apps/mission-control-next/src/features/threaded-surface/*.test.*")
git commit -m "fix: fit the Chat header and composer controls on one row each"
```

---

### Task 7: The phone shows the conversation

**Files:**
- Modify: `apps/mission-control-next/src/features/threaded-surface/styles/mobile.css`:
  - header at lines 341-372
  - header and card padding at lines 466-473
  - banner stacking at lines 486-498
- Modify: `apps/mission-control-next/src/features/threaded-surface/styles/calm-chat.css` (composer card cap at lines 188-246)
- Modify: `apps/mission-control-next/src/features/threaded-surface/styles/focused-active-work.css` (lines 88-97)

- [ ] **Step 1: Header on one row at 767px and below**

In `mobile.css`, inside the header block (lines 341-372), set:

```css
  .mc-next-threaded-header {
    flex-wrap: nowrap;
    align-items: center;
    min-height: 48px;
    gap: 0.4rem;
  }

  .mc-next-threaded-header-actions {
    flex-wrap: nowrap;
    gap: 0.25rem;
  }

  .mc-next-header-button-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .mc-next-threaded-header .mc-next-threaded-header-copy > span {
    display: none;
  }
```

The labels are visually hidden but stay readable to screen readers.

- [ ] **Step 2: Cap the phone composer and compact the status card**

In `calm-chat.css`, inside the `(width < 1180px)` block, change the composer card's `max-height: 50dvh;` to `max-height: 38dvh;`.

In `focused-active-work.css`, inside the `(max-width: 700px)` block, add:

```css
  .mc-next-active-work-summary {
    padding: 0.45rem 0.6rem;
    gap: 0.4rem;
  }

  .mc-next-active-work-copy > span {
    display: none;
  }
```

The title and actions stay; the detail line hides on phones.

- [ ] **Step 3: Measure with the lane**

Run: `pnpm verify:ux:budgets`
Expected: `ux-budgets.chat-space.desktop` and `ux-budgets.chat-space.mobile` pass. If either still fails, read the lane's reported ratio, measure the remaining rows in the browser at that size with the lane's `measureLayout` approach, and reduce the largest remaining row. Record each additional CSS change in this task's commit message.

- [ ] **Step 4: Commit**

```bash
git add apps/mission-control-next/src/features/threaded-surface/styles/mobile.css apps/mission-control-next/src/features/threaded-surface/styles/calm-chat.css apps/mission-control-next/src/features/threaded-surface/styles/focused-active-work.css
git commit -m "fix: show the conversation on phones"
```

---

### Task 8: Phase exit

- [ ] **Step 1: Full lane**

Run: `pnpm verify:ux:budgets`
Expected: every scenario passes. Record the Chat ratios at both sizes for the PR.

- [ ] **Step 2: Visual rebaseline**

This phase changes the top bar on every page and the Chat layout, so rebaseline through the workflow, following the roadmap's visual-baseline rule:

```bash
gh workflow run visual-rebaseline.yml --ref ux/phase-0b
```

Then cherry-pick the pushed `chore/visual-rebaseline-<runid>` commit and delete that branch. Review at least these PNGs by eye before committing:
- `visual-regression-chat-desktop-dark.png`
- `visual-regression-chat-mobile-dark.png`
- `visual-regression-settings-providers-desktop-dark.png`

- [ ] **Step 3: Phase validation**

Run the roadmap's per-phase validation list, one command at a time. Expected: exit 0, or pre-existing reds documented in the PR.

- [ ] **Step 4: Push and open the PR**

```bash
# First write the PR description (what changed, lane results before and after, anything left for the next phase) to "${TMPDIR:-/tmp}/ux-phase-0b-pr.md".
git push -u origin ux/phase-0b
gh pr create --title "UX phase 0b: Chat gets the screen; status moves to the top bar" --body-file "${TMPDIR:-/tmp}/ux-phase-0b-pr.md"
```
