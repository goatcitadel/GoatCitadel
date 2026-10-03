# Phase 0a — Shared Fixes and Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the toast flood, remove raw request errors and raw status names from the screen, and add a verification lane that proves it and keeps it that way.

**Architecture:** All logic lands in shared modules that the future cockpit shell reuses:

- a delivery marker on the realtime event stream
- a pure notification policy
- `describeApiError`
- a status vocabulary

The classic shell only rewires to them. A new `ux-budgets` verification lane measures the result in a real browser against an isolated runtime.

**Tech Stack:** TypeScript, React 19, vitest (react-test-renderer, happy-dom per file), `node:test` for scripts, Playwright 1.58 via `scripts/verification`.

**Spec:** [`docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`](../specs/2026-09-27-mission-control-cockpit-design.md) §11 (notification policy), §10.2 and §10.6 (status vocabulary, copy rules), §14 (quality gates); fixes F-01, F-02, F-03, F-07, F-19.

## Global Constraints

- Everything in the roadmap's Global Constraints applies ([roadmap](./2026-09-27-mission-control-cockpit-roadmap.md#global-constraints)).
- Branch `ux/phase-0a` in worktree `../personal-ai-phase-0a` from the latest `origin/main`.
- After editing `packages/threaded-surface-core`, rebuild it (`pnpm --filter @goatcitadel/threaded-surface-core build`) before running `apps/mission-control-next` tests. The app's tests load the core package from its built `dist` (`apps/mission-control-next/vite.config.ts:54-58`).
- Shared-package imports use the `.js` suffix inside `packages/mission-control-shared/src` (for example `import { isApiRequestError } from "./http-internal.js";`).
- New shared modules stay at 400 lines or fewer.
- User-facing copy: sentence case, contractions, no "Error:" prefix, no raw enum values, IDs, URLs, or API paths.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `scripts/verification/lib/ux-budgets.mjs` | create | Pure budget evaluators and the raw-copy scanner |
| `scripts/verification/lib/ux-budgets.test.mjs` | create | `node:test` coverage for the evaluators |
| `scripts/verification/lib/scenarios/ux-budgets-lane.mjs` | create | Browser lane: toasts after cold load, raw copy, overflow, Chat space, sidebar reach |
| `scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs` | create | Route list and registration wiring checks |
| `scripts/verification/lib/scenarios.mjs` | modify | Wrapper that injects lane dependencies |
| `scripts/verification/run.mjs` | modify | Register the `ux-budgets` lane |
| `package.json` | modify | `verify:ux:budgets` script |
| `packages/mission-control-shared/src/api/client.ts` | modify | Pass `{ replayed }` with every event |
| `packages/mission-control-shared/src/api/shell-client.ts` | modify | Re-export the delivery type |
| `packages/mission-control-shared/src/api/client-event-stream.test.ts` | modify | Replay-marker tests |
| `packages/mission-control-shared/src/state/realtime-derived.ts` | modify | Give handoff and deliverable notices their own kind |
| `packages/mission-control-shared/src/state/realtime-derived.test.ts` | modify | Test the new kind |
| `packages/mission-control-shared/src/state/notification-policy.ts` | create | Pure decision: toast, sound, desktop |
| `packages/mission-control-shared/src/state/notification-policy.test.ts` | create | Policy tests |
| `apps/mission-control-next/src/app/use-event-stream.ts` | modify | Forward the delivery context |
| `apps/mission-control-next/src/app/use-shell-notifications.ts` | modify | Apply the policy |
| `apps/mission-control-next/src/app/use-shell-notifications.policy.test.tsx` | create | Hook-level policy tests |
| `apps/mission-control-next/src/app/use-event-stream.notification-stability.test.tsx` | modify | Mock returns a toastable kind |
| `apps/mission-control-next/src/app/MissionControlNextApp.tsx` | modify | Pass the visible Chat session |
| `apps/mission-control-next/src/styles/mission-control-next.css` | modify | Toast stack at the top |
| `apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css` | modify | Drop the bottom override |
| `apps/mission-control-next/src/features/prompt-packs/prompt-packs-workbench.css` | modify | Drop the bottom override |
| `apps/mission-control-next/src/styles/notification-stack-placement.test.ts` | create | Stylesheet assertions |
| `packages/mission-control-shared/src/api/describe-api-error.ts` | create | Plain-language error summaries |
| `packages/mission-control-shared/src/api/describe-api-error.test.ts` | create | Tests |
| `apps/mission-control-next/src/features/native-routes/shared/native-helpers.ts` | modify | `getErrorMessage` delegates |
| `packages/threaded-surface-core/src/chat/chat-error-copy.ts` | modify | Network errors get plain copy |
| `packages/threaded-surface-core/src/chat/useChatRoutePreflight.ts` | modify | Store the plain summary |
| `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx` | modify | Drop the "Sending is unavailable:" prefix |
| `packages/mission-control-shared/src/content/status-vocabulary.ts` | create | Labels and tones for every domain state |
| `packages/mission-control-shared/src/content/status-vocabulary.test.ts` | create | Tests |
| `packages/mission-control-shared/src/content/approval-helpers.ts` | modify | Use the vocabulary |
| `packages/mission-control-shared/src/components/chat/chat-tool-effect-truth.ts` | modify | Plain summary for every outcome |
| `apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.tsx` | modify | Activity feed labels |

---

### Task 1: Budget evaluators and raw-copy scanner

**Files:**
- Create: `scripts/verification/lib/ux-budgets.mjs`
- Test: `scripts/verification/lib/ux-budgets.test.mjs`

**Interfaces:**
- Produces:
  - `CHAT_BUDGET_THRESHOLDS: { desktop: 0.6, mobile: 0.55 }`
  - `findRawCopyTokens(text: string): Array<{ kind: "enum"|"api-path"|"uuid"|"prefixed-id"|"transport-error", token: string }>`
  - `evaluateChatBudget({ viewportHeight, scrollerHeight }, variant: "desktop"|"mobile"): { ratio, threshold, pass }`
  - `evaluateToastBudget(count: number): { count, pass }`
  - `evaluateRailReach({ railVisible, railBottom, viewportHeight }): { gap, pass }`
  - `evaluateHorizontalOverflow({ scrollWidth, clientWidth }): { overflow, pass }`

- [ ] **Step 1: Write the failing test**

```js
// scripts/verification/lib/ux-budgets.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_BUDGET_THRESHOLDS,
  evaluateChatBudget,
  evaluateHorizontalOverflow,
  evaluateRailReach,
  evaluateToastBudget,
  findRawCopyTokens,
} from "./ux-budgets.mjs";

describe("findRawCopyTokens", () => {
  it("flags snake_case enum values, API paths, ids, and transport errors", () => {
    const text = [
      "task_updated / tasks",
      "Sending is unavailable: Network error POST /api/v1/chat/sessions/sess_57696ff7ad69ef722fc07b8f/route-preflight: Failed to fetch",
      "Run 3f2b8c1e-9a4d-4c2b-8e1f-0a9b8c7d6e5f",
    ].join("\n");
    const kinds = new Set(findRawCopyTokens(text).map((finding) => finding.kind));
    assert.deepEqual([...kinds].sort(), ["api-path", "enum", "prefixed-id", "transport-error", "uuid"]);
  });

  it("accepts plain sentences, dotted tool names, and environment variable names", () => {
    const text = "Waiting on you\nUsed web.search and browser.extract\nSet GOATCITADEL_AUTH_MODE to token";
    assert.deepEqual(findRawCopyTokens(text), []);
  });
});

describe("evaluateChatBudget", () => {
  it("passes at or above the variant threshold", () => {
    assert.deepEqual(evaluateChatBudget({ viewportHeight: 900, scrollerHeight: 540 }, "desktop"), {
      ratio: 0.6,
      threshold: CHAT_BUDGET_THRESHOLDS.desktop,
      pass: true,
    });
  });

  it("fails the measured 2026-09-27 layout", () => {
    const result = evaluateChatBudget({ viewportHeight: 900, scrollerHeight: 249 }, "desktop");
    assert.equal(result.pass, false);
    assert.equal(result.ratio, 0.277);
  });

  it("rejects unknown variants and non-positive viewports", () => {
    assert.throws(() => evaluateChatBudget({ viewportHeight: 900, scrollerHeight: 1 }, "tablet"), /Unknown chat budget variant/);
    assert.throws(() => evaluateChatBudget({ viewportHeight: 0, scrollerHeight: 1 }, "mobile"), /viewportHeight/);
  });
});

describe("evaluateToastBudget", () => {
  it("allows zero toasts only", () => {
    assert.equal(evaluateToastBudget(0).pass, true);
    assert.equal(evaluateToastBudget(2).pass, false);
  });
});

describe("evaluateRailReach", () => {
  it("passes when the rail reaches the viewport bottom or is hidden", () => {
    assert.equal(evaluateRailReach({ railVisible: true, railBottom: 900, viewportHeight: 900 }).pass, true);
    assert.equal(evaluateRailReach({ railVisible: false, railBottom: 0, viewportHeight: 844 }).pass, true);
  });

  it("fails the 72px dead strip", () => {
    assert.deepEqual(evaluateRailReach({ railVisible: true, railBottom: 828, viewportHeight: 900 }), { gap: 72, pass: false });
  });
});

describe("evaluateHorizontalOverflow", () => {
  it("tolerates one pixel of rounding", () => {
    assert.equal(evaluateHorizontalOverflow({ scrollWidth: 1441, clientWidth: 1440 }).pass, true);
    assert.equal(evaluateHorizontalOverflow({ scrollWidth: 1460, clientWidth: 1440 }).pass, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/verification/lib/ux-budgets.test.mjs`
Expected: FAIL with `Cannot find module` for `./ux-budgets.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// scripts/verification/lib/ux-budgets.mjs
/*
 * Pure evaluators for the ux-budgets verification lane. Thresholds come from
 * docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md §2 and §14.
 */

export const CHAT_BUDGET_THRESHOLDS = Object.freeze({ desktop: 0.6, mobile: 0.55 });

const RAW_COPY_PATTERNS = Object.freeze([
  { kind: "enum", pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { kind: "api-path", pattern: /\/api\/v\d+\/[\w\-/.:?=&%]+/g },
  { kind: "uuid", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: "prefixed-id", pattern: /\b(?:sess|turn|run|appr|task|plan|evt|msg|ws)_[0-9a-z]{12,}\b/gi },
  { kind: "transport-error", pattern: /Network error (?:GET|POST|PUT|PATCH|DELETE)|Failed to fetch|API error \d{3}/g },
]);

export function findRawCopyTokens(text) {
  const findings = [];
  for (const { kind, pattern } of RAW_COPY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ kind, token: match[0] });
    }
  }
  return findings;
}

export function evaluateChatBudget({ viewportHeight, scrollerHeight }, variant) {
  const threshold = CHAT_BUDGET_THRESHOLDS[variant];
  if (threshold === undefined) {
    throw new Error(`Unknown chat budget variant: ${variant}`);
  }
  if (!(viewportHeight > 0)) {
    throw new Error("viewportHeight must be positive");
  }
  const ratio = Math.max(0, scrollerHeight) / viewportHeight;
  return { ratio: Math.round(ratio * 1000) / 1000, threshold, pass: ratio >= threshold };
}

export function evaluateToastBudget(count) {
  return { count, pass: count === 0 };
}

export function evaluateRailReach({ railVisible, railBottom, viewportHeight }) {
  if (!railVisible) {
    return { gap: 0, pass: true };
  }
  const gap = Math.round(viewportHeight - railBottom);
  return { gap, pass: Math.abs(gap) <= 1 };
}

export function evaluateHorizontalOverflow({ scrollWidth, clientWidth }) {
  const overflow = scrollWidth - clientWidth;
  return { overflow, pass: overflow <= 1 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/verification/lib/ux-budgets.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/verification/lib/ux-budgets.mjs scripts/verification/lib/ux-budgets.test.mjs
git commit -m "test: add UX budget evaluators for the ux-budgets lane"
```

---

### Task 2: The `ux-budgets` verification lane

**Files:**
- Create: `scripts/verification/lib/scenarios/ux-budgets-lane.mjs`
- Create: `scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`
- Modify: `scripts/verification/lib/scenarios.mjs` (import near the accessibility-smoke import at line 110; wrapper next to `runAccessibilitySmokeLane` at line 2438)
- Modify: `scripts/verification/run.mjs` (import list near line 25, `VALID_LANES` at line 83, `DIRECT_BROWSER_SECRET_SCRUB_LANES` at line 145, dispatch next to the `accessibility-smoke` branch at line 372)
- Modify: `package.json` (next to `verify:accessibility:smoke`)

**Interfaces:**
- Consumes: Task 1 evaluators. `NEXT_RELEASE_SURFACE_MANIFEST` and `resolveReleaseSurfaceHref(route, variant, fixture)` from `scripts/verification/lib/release-surface-manifest.mjs`. The lane dependencies injected by `verificationLaneDeps()`: the same names `accessibility-smoke-lane.mjs` destructures, lines 184-212.
- Produces:
  - `runUxBudgetsLane(context, options, deps)`
  - `UX_BUDGET_ROUTE_SLUGS: string[]`
  - `UX_BUDGET_ENFORCEMENT_DEFAULTS: { chatBudget: false, railReach: false }`. Phase 0b flips both to `true`.

The lane deliberately runs without visual-regression mode, because that mode hides toasts. Chat space and sidebar reach are reported as `degraded` until Phase 0b enforces them. Toasts, raw copy, and overflow fail from day one.

- [ ] **Step 1: Write the failing wiring test**

```js
// scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { NEXT_RELEASE_SURFACE_MANIFEST } from "../release-surface-manifest.mjs";
import { UX_BUDGET_ENFORCEMENT_DEFAULTS, UX_BUDGET_ROUTE_SLUGS } from "./ux-budgets-lane.mjs";

const runSource = readFileSync(new URL("../../run.mjs", import.meta.url), "utf8");
const scenariosSource = readFileSync(new URL("../scenarios.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));

describe("ux-budgets lane", () => {
  it("only measures routes that exist in the release surface manifest", () => {
    const known = new Set(NEXT_RELEASE_SURFACE_MANIFEST.map((entry) => entry.slug));
    for (const slug of UX_BUDGET_ROUTE_SLUGS) {
      assert.ok(known.has(slug), `unknown route slug ${slug}`);
    }
  });

  it("starts with Chat space and sidebar reach reported, not enforced", () => {
    assert.deepEqual(UX_BUDGET_ENFORCEMENT_DEFAULTS, { chatBudget: false, railReach: false });
  });

  it("is registered with run.mjs, scenarios.mjs, and package.json", () => {
    assert.match(runSource, /"ux-budgets"/);
    assert.match(runSource, /lane === "ux-budgets"/);
    assert.match(scenariosSource, /export async function runUxBudgetsLane\(/);
    assert.equal(packageJson.scripts["verify:ux:budgets"], "node scripts/verification/run.mjs ux-budgets");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`
Expected: FAIL with `Cannot find module` for `./ux-budgets-lane.mjs`.

- [ ] **Step 3: Write the lane**

```js
// scripts/verification/lib/scenarios/ux-budgets-lane.mjs
import { NEXT_RELEASE_SURFACE_MANIFEST, resolveReleaseSurfaceHref } from "../release-surface-manifest.mjs";
import {
  evaluateChatBudget,
  evaluateHorizontalOverflow,
  evaluateRailReach,
  evaluateToastBudget,
  findRawCopyTokens,
} from "../ux-budgets.mjs";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";

const UX_STUB_REPLY = "UX_BUDGET_OK";
const UX_STUB_KEY = "verification-ux-budgets-stub-key";
const TOAST_SETTLE_MS = 5_000;

export const UX_BUDGET_ROUTE_SLUGS = Object.freeze([
  "chat",
  "projects",
  "library-skills",
  "library-capabilities",
  "ops-activity",
  "ops-approvals",
  "settings-onboarding",
  "settings-providers",
  "settings-trust-policy",
]);

export const UX_BUDGET_ENFORCEMENT_DEFAULTS = Object.freeze({ chatBudget: false, railReach: false });

const CHAT_VARIANTS = Object.freeze([
  { variant: "desktop", viewport: { width: 1440, height: 900 } },
  { variant: "mobile", viewport: { width: 390, height: 844 } },
]);

const COPY_EXEMPT_SELECTOR = [
  "code",
  "pre",
  "kbd",
  "samp",
  "textarea",
  "input",
  "select",
  "script",
  "style",
  "[data-copy-exempt]",
  ".mc-assistant-renderer",
  ".mc-next-technical-detail",
].join(", ");

function collectVisibleUiText(exemptSelector) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest(exemptSelector)) {
      continue;
    }
    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (style.visibility === "hidden" || rect.width === 0 || rect.height === 0) {
      continue;
    }
    parts.push(text);
  }
  return parts.join("\n");
}

function measureLayout() {
  const scroller = document.querySelector(".mc-next-thread-scroll");
  const rail = document.querySelector(".mc-next-rail");
  const railRect = rail?.getBoundingClientRect();
  const railVisible = Boolean(rail && getComputedStyle(rail).display !== "none" && railRect && railRect.width > 0);
  return {
    viewportHeight: window.innerHeight,
    scrollerHeight: scroller ? scroller.clientHeight : 0,
    railVisible,
    railBottom: railRect ? railRect.bottom : 0,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    toastCount: document.querySelectorAll(".notification-stack .notification-item").length,
  };
}

function manifestEntry(slug) {
  const entry = NEXT_RELEASE_SURFACE_MANIFEST.find((candidate) => candidate.slug === slug);
  if (!entry) {
    throw new Error(`ux-budgets: route ${slug} is missing from NEXT_RELEASE_SURFACE_MANIFEST`);
  }
  return entry;
}

export async function runUxBudgetsLane(context, options = {}, deps) {
  const {
    NEXT_UI_PACKAGE,
    buildVerificationUiUrl,
    chromium,
    ensureOnboardingComplete,
    forceVerificationUiPackage,
    installMissionControlNextBrowserState,
    prepareCleanRuntime = prepareUsabilityRuntime,
    runScenario,
    seedMissionControlNextFixture,
    startDeterministicLlmStub,
    startVerificationStack,
    stopVerificationStack,
    waitForVerificationRouteReady,
  } = deps;
  const enforcement = { ...UX_BUDGET_ENFORCEMENT_DEFAULTS, ...(options.enforce ?? {}) };
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  let stack;
  let runtimeRoot;
  let stub;
  try {
    stub = await startDeterministicLlmStub({
      replyText: UX_STUB_REPLY,
      expectedAuthorization: `Bearer ${UX_STUB_KEY}`,
    });
    runtimeRoot = await prepareCleanRuntime(`${context.runId}-ux-budgets`, stub.baseUrl);
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      gatewayMode: "built",
      uiMode: "preview",
      processLogPrefix: options.processLogPrefix,
      gatewayEnvOmit: options.secretEnvKeys,
      uiEnvOmit: options.secretEnvKeys,
      gatewayEnv: {
        GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: "verification-ux-budgets-operator-token",
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
        GOATCITADEL_VERIFY_STUB_LLM_KEY: UX_STUB_KEY,
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-ux-budgets");
    const fixture = await seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot });
    const browser = await chromium.launch({ headless: true });

    async function openRoute(viewport, entry, href) {
      const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
      await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
      const page = await browserContext.newPage();
      await page.goto(buildVerificationUiUrl(stack.uiUrl, href), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, entry, NEXT_UI_PACKAGE);
      await page.waitForTimeout(TOAST_SETTLE_MS);
      return { browserContext, page };
    }

    try {
      for (const slug of options.routeSlugs ?? UX_BUDGET_ROUTE_SLUGS) {
        const entry = manifestEntry(slug);
        await runScenario(
          context,
          { id: `ux-budgets.cold-load.${slug}`, lane: "ux-budgets", title: `Cold load ${slug}`, subsystem: "mission-control-ux" },
          async () => {
            const { browserContext, page } = await openRoute(
              { width: 1440, height: 900 },
              entry,
              resolveReleaseSurfaceHref(entry, {}, fixture),
            );
            try {
              const layout = await page.evaluate(measureLayout);
              const text = await page.evaluate(collectVisibleUiText, COPY_EXEMPT_SELECTOR);
              const toasts = evaluateToastBudget(layout.toastCount);
              const overflow = evaluateHorizontalOverflow(layout);
              const rawCopy = findRawCopyTokens(text);
              const problems = [
                toasts.pass ? null : `${toasts.count} toast(s) visible after a cold load`,
                overflow.pass ? null : `document overflows horizontally by ${overflow.overflow}px`,
                rawCopy.length === 0 ? null : `raw copy: ${rawCopy.map((finding) => `${finding.kind}=${finding.token}`).join(", ")}`,
              ].filter(Boolean);
              if (problems.length > 0) {
                throw new Error(`ux-budgets ${slug}: ${problems.join("; ")}`);
              }
              return { status: "passed", metrics: { toasts: toasts.count, overflow: overflow.overflow } };
            } finally {
              await browserContext.close();
            }
          },
        );
      }

      const chatEntry = manifestEntry("chat");
      for (const { variant, viewport } of CHAT_VARIANTS) {
        await runScenario(
          context,
          { id: `ux-budgets.chat-space.${variant}`, lane: "ux-budgets", title: `Chat space ${variant}`, subsystem: "mission-control-ux" },
          async () => {
            const href = `/chat?sessionId=${encodeURIComponent(fixture.sessionId)}`;
            const { browserContext, page } = await openRoute(viewport, chatEntry, href);
            try {
              const layout = await page.evaluate(measureLayout);
              const chat = evaluateChatBudget(layout, variant);
              const rail = evaluateRailReach(layout);
              const metrics = { ratio: chat.ratio, threshold: chat.threshold, railGap: rail.gap };
              const failures = [
                !chat.pass && enforcement.chatBudget ? `message area ${chat.ratio} < ${chat.threshold}` : null,
                !rail.pass && enforcement.railReach ? `sidebar ends ${rail.gap}px above the viewport bottom` : null,
              ].filter(Boolean);
              if (failures.length > 0) {
                throw new Error(`ux-budgets chat ${variant}: ${failures.join("; ")}`);
              }
              const degraded = !chat.pass || !rail.pass;
              return {
                status: degraded ? "degraded" : "passed",
                metrics,
                ...(degraded ? { error: `not yet enforced: chat ${chat.ratio}/${chat.threshold}, rail gap ${rail.gap}px` } : {}),
              };
            } finally {
              await browserContext.close();
            }
          },
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    if (stack || runtimeRoot) {
      await stopVerificationStack(stack ?? { runtimeRoot });
    }
    await stub?.close();
    restoreUiPackage();
  }
}
```

- [ ] **Step 4: Register the lane**

In `scripts/verification/lib/scenarios.mjs`, add next to the accessibility-smoke import (around line 110):

```js
import { runUxBudgetsLane as runUxBudgetsLaneImpl } from "./scenarios/ux-budgets-lane.mjs";
```

Add next to `runAccessibilitySmokeLane` (around line 2438):

```js
export async function runUxBudgetsLane(context, options = {}) {
  return await runUxBudgetsLaneImpl(context, options, verificationLaneDeps());
}
```

In `scripts/verification/run.mjs`:
- Add `runUxBudgetsLane,` to the import list that contains `runAccessibilitySmokeLane` (line 25).
- Add `"ux-budgets",` to `VALID_LANES` (line 83) and to `DIRECT_BROWSER_SECRET_SCRUB_LANES` (line 145).
- Add a dispatch branch directly after the `accessibility-smoke` branch (line 372):

```js
    } else if (lane === "ux-budgets") {
      await runUxBudgetsLane(context, { profile, secretEnvKeys: directBrowserSecretEnvKeys });
```

In the root `package.json`, next to `"verify:accessibility:smoke"`:

```json
    "verify:ux:budgets": "node scripts/verification/run.mjs ux-budgets",
```

- [ ] **Step 5: Run the wiring test to verify it passes**

Run: `node --test scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the lane once to record the red baseline**

Run: `pnpm verify:ux:budgets`
Expected: exit code 1. The cold-load scenarios fail with toast and raw-copy findings (for example `2 toast(s) visible after a cold load` and `raw copy: enum=task_updated`). The two Chat scenarios report `degraded` with a ratio near `0.277`. Save the manifest path printed at the end for the PR description.

- [ ] **Step 7: Commit**

```bash
git add scripts/verification/lib/scenarios/ux-budgets-lane.mjs scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs scripts/verification/lib/scenarios.mjs scripts/verification/run.mjs package.json
git commit -m "test: add ux-budgets verification lane for toasts, raw copy, and Chat space"
```

---

### Task 3: Mark replayed realtime events

**Files:**
- Modify: `packages/mission-control-shared/src/api/client.ts` (`EventStreamSubscriber` at line 1117, `connectEventStream` at line 1139, `ensureEventStreamConnected` handlers at lines 1240-1332)
- Modify: `packages/mission-control-shared/src/api/shell-client.ts` (type re-exports near line 49)
- Test: `packages/mission-control-shared/src/api/client-event-stream.test.ts`

**Interfaces:**
- Produces:
  - `export interface RealtimeEventDelivery { replayed: boolean }` (exported from `client.ts` and re-exported from `shell-client.ts`)
  - `connectEventStream(onEvent: (event: RealtimeEvent, delivery: RealtimeEventDelivery) => void, …)`
  - `export const STREAM_READY_FALLBACK_MS = 5_000`

Frames that arrive before the server's named `stream-ready` frame are catch-up replay (`afterCursor` or `replay=20`, `apps/gateway/src/routes/events.ts:247-341`). A gateway that never sends `stream-ready` is treated as live 5 seconds after the connection opens.

- [ ] **Step 1: Write the failing tests**

Add inside the existing top-level `describe` in `client-event-stream.test.ts`, reusing the file's `FakeEventSource`, `installBrowser`, and `flushAsync` helpers and the setup used by the test titled "connects once, forwards events, persists cursors, handles replay gaps, reconnects, and cleans up":

```ts
function realtimeFrame(sequence: number) {
  return {
    eventId: `evt-${sequence}`,
    sequence,
    eventType: "chat_thread_updated",
    source: "chat",
    timestamp: "2026-09-27T00:00:00.000Z",
    payload: {},
  };
}

it("marks frames before stream-ready as replayed and later frames as live", async () => {
  const onEvent = vi.fn();
  const disconnect = connectEventStream(onEvent);
  await flushAsync();
  const source = FakeEventSource.instances.at(-1)!;
  source.onopen?.();
  source.onmessage?.({ data: JSON.stringify(realtimeFrame(1)) });
  source.emit("stream-ready", { leaseId: "lease-1", replayedEventCount: 1, lastSentSequence: 1 });
  source.onmessage?.({ data: JSON.stringify(realtimeFrame(2)) });

  expect(onEvent.mock.calls.map(([event, delivery]) => [event.sequence, delivery.replayed])).toEqual([
    [1, true],
    [2, false],
  ]);
  disconnect();
});

it("treats the stream as live after the fallback when stream-ready never arrives", async () => {
  vi.useFakeTimers();
  installBrowser();
  try {
    const onEvent = vi.fn();
    const disconnect = connectEventStream(onEvent);
    await flushAsync();
    const source = FakeEventSource.instances.at(-1)!;
    source.onopen?.();
    vi.advanceTimersByTime(STREAM_READY_FALLBACK_MS);
    source.onmessage?.({ data: JSON.stringify(realtimeFrame(3)) });

    expect(onEvent.mock.calls.at(-1)?.[1]).toEqual({ replayed: false });
    disconnect();
  } finally {
    vi.useRealTimers();
  }
});
```

Update the import line at the top of the file:

```ts
import { STREAM_READY_FALLBACK_MS, connectEventStream, runUiAction } from "./client";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api/client-event-stream.test.ts`
Expected: FAIL. `STREAM_READY_FALLBACK_MS` is not exported, and `delivery` is `undefined`.

- [ ] **Step 3: Implement the marker in `client.ts`**

Replace the subscriber interface (line 1117) and add the exported type and constant above it:

```ts
/** Delivery facts the stream knows about each event. */
export interface RealtimeEventDelivery {
  /** True for frames delivered while the stream catches up on connect or reconnect (before `stream-ready`). */
  replayed: boolean;
}

/** Older gateways may not send `stream-ready`; treat the stream as live after this long. */
export const STREAM_READY_FALLBACK_MS = 5_000;

interface EventStreamSubscriber {
  onEvent: (event: RealtimeEvent, delivery: RealtimeEventDelivery) => void;
  onStateChange?: (state: EventStreamConnectionState) => void;
  onStatusChange?: (status: EventStreamStatus) => void;
}
```

Change the `connectEventStream` parameter type (line 1140):

```ts
export function connectEventStream(
  onEvent: (event: RealtimeEvent, delivery: RealtimeEventDelivery) => void,
```

In `ensureEventStreamConnected`, directly after `sharedEventSource = source;`, add:

```ts
  let streamLive = false;
  let liveFallbackTimer: number | null = null;
  const markStreamLive = () => {
    streamLive = true;
    if (liveFallbackTimer !== null) {
      window.clearTimeout(liveFallbackTimer);
      liveFallbackTimer = null;
    }
  };
```

At the end of `source.onopen`, after `recordClientDiagnostic({... event: "open" ...})`, add:

```ts
    liveFallbackTimer = window.setTimeout(markStreamLive, STREAM_READY_FALLBACK_MS);
```

In `source.onmessage`, replace the subscriber loop:

```ts
      const delivery: RealtimeEventDelivery = { replayed: !streamLive };
      for (const subscriber of eventStreamSubscribers) {
        subscriber.onEvent(event, delivery);
      }
```

In the `replay-gap` listener, replace `subscriber.onEvent(replayGapEvent);` with:

```ts
      subscriber.onEvent(replayGapEvent, { replayed: !streamLive });
```

In the `stream-ready` listener, add `markStreamLive();` as the first statement after the `sharedEventSource !== source` guard.

In `source.onerror`, add `markStreamLive();` as the first statement after the guard, so the timer is cleared. The next connection builds a fresh closure.

- [ ] **Step 4: Re-export the type**

In `packages/mission-control-shared/src/api/shell-client.ts`, extend the `client.js` import and the type re-export:

```ts
import { connectEventStream, type RealtimeEventDelivery } from "./client.js";
```

```ts
export type { EventStreamConnectionState, EventStreamStatus, RealtimeEventDelivery };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api/client-event-stream.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add packages/mission-control-shared/src/api/client.ts packages/mission-control-shared/src/api/shell-client.ts packages/mission-control-shared/src/api/client-event-stream.test.ts
git commit -m "feat: mark realtime events replayed before stream-ready"
```

---

### Task 4: Notification policy

**Files:**
- Create: `packages/mission-control-shared/src/state/notification-policy.ts`
- Test: `packages/mission-control-shared/src/state/notification-policy.test.ts`
- Modify: `packages/mission-control-shared/src/state/realtime-derived.ts` (`attentionKind` union at lines 21-29; handoff branch around line 312)
- Test: `packages/mission-control-shared/src/state/realtime-derived.test.ts`

**Interfaces:**
- Consumes: `DerivedRealtimeNotification` from `./realtime-derived.js`.
- Produces:
  - `RealtimeNotificationOrigin { replayed: boolean; eventSessionId?: string }`
  - `NotificationDeliveryContext extends RealtimeNotificationOrigin { visibleSessionId?: string; pageFocused: boolean }`
  - `NotificationDeliveryDecision { toast: boolean; sound: boolean; desktop: boolean }`
  - `decideNotificationDelivery(notification: DerivedRealtimeNotification | undefined, context: NotificationDeliveryContext): NotificationDeliveryDecision`
  - The new `attentionKind` value `"handoff_ready"`.

- [ ] **Step 1: Write the failing policy tests**

```ts
// packages/mission-control-shared/src/state/notification-policy.test.ts
import { describe, expect, it } from "vitest";
import { decideNotificationDelivery } from "./notification-policy";
import type { DerivedRealtimeNotification } from "./realtime-derived";

const LIVE_FOCUSED = { replayed: false, pageFocused: true } as const;

function notification(overrides: Partial<DerivedRealtimeNotification>): DerivedRealtimeNotification {
  return { tone: "info", message: "m", groupKey: "g", truthMode: "authoritative", ...overrides };
}

describe("decideNotificationDelivery", () => {
  it("never delivers replayed events", () => {
    const approval = notification({ tone: "warning", attentionKind: "approval_waiting", groupKey: "approval-1" });
    expect(decideNotificationDelivery(approval, { replayed: true, pageFocused: false })).toEqual({
      toast: false,
      sound: false,
      desktop: false,
    });
  });

  it("silences generic task and conversation refreshes", () => {
    for (const attentionKind of ["activity_update", "conversation_update"] as const) {
      expect(decideNotificationDelivery(notification({ attentionKind }), LIVE_FOCUSED).toast).toBe(false);
    }
  });

  it("silences transport status that belongs to the stream indicator", () => {
    for (const groupKey of ["connection-interrupted", "connection-restored", "stream-replay-gap"]) {
      const status = notification({ tone: "warning", attentionKind: "runtime_degraded", groupKey });
      expect(decideNotificationDelivery(status, LIVE_FOCUSED).toast).toBe(false);
    }
  });

  it("toasts and plays sound for decisions, and notifies the desktop only when unfocused", () => {
    const approval = notification({ tone: "warning", attentionKind: "approval_waiting", groupKey: "approval-1" });
    expect(decideNotificationDelivery(approval, LIVE_FOCUSED)).toEqual({ toast: true, sound: true, desktop: false });
    expect(decideNotificationDelivery(approval, { replayed: false, pageFocused: false })).toEqual({
      toast: true,
      sound: true,
      desktop: true,
    });
  });

  it("toasts problems with sound but no desktop notification", () => {
    const failed = notification({ tone: "error", attentionKind: "run_failed", groupKey: "run-1" });
    expect(decideNotificationDelivery(failed, { replayed: false, pageFocused: false })).toEqual({
      toast: true,
      sound: true,
      desktop: false,
    });
  });

  it("toasts completions and handoffs quietly", () => {
    for (const attentionKind of ["run_completed", "handoff_ready"] as const) {
      expect(decideNotificationDelivery(notification({ tone: "success", attentionKind }), LIVE_FOCUSED)).toEqual({
        toast: true,
        sound: false,
        desktop: false,
      });
    }
  });

  it("keeps Gateway-authored notices", () => {
    const authored = notification({ attentionKind: "activity_update", groupKey: "ui-timer_due" });
    expect(decideNotificationDelivery(authored, LIVE_FOCUSED)).toEqual({ toast: true, sound: false, desktop: false });
  });

  it("stays quiet for the Chat session the operator is looking at", () => {
    const approval = notification({ tone: "warning", attentionKind: "approval_waiting", groupKey: "approval-1" });
    const context = { replayed: false, pageFocused: true, eventSessionId: "s-1", visibleSessionId: "s-1" };
    expect(decideNotificationDelivery(approval, context).toast).toBe(false);
    expect(decideNotificationDelivery(approval, { ...context, pageFocused: false }).toast).toBe(true);
  });

  it("ignores undefined notifications", () => {
    expect(decideNotificationDelivery(undefined, LIVE_FOCUSED)).toEqual({ toast: false, sound: false, desktop: false });
  });
});
```

Add to `realtime-derived.test.ts`, inside the existing top-level `describe`:

```ts
  it("gives handoff notices their own attention kind", () => {
    expect(deriveRealtimeNotification(event({ eventType: "deliverable_added", links: { taskId: "task-1" } }))).toMatchObject({
      attentionKind: "handoff_ready",
      groupKey: "handoff-task-1",
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/state/notification-policy.test.ts src/state/realtime-derived.test.ts`
Expected: FAIL. `./notification-policy` is missing, and the handoff attention kind is `activity_update`.

- [ ] **Step 3: Implement**

In `realtime-derived.ts`, add `| "handoff_ready"` to the `attentionKind` union, and in the `isHandoffReadyEvent` branch change `attentionKind: "activity_update"` to `attentionKind: "handoff_ready"`.

```ts
// packages/mission-control-shared/src/state/notification-policy.ts
import type { DerivedRealtimeNotification } from "./realtime-derived.js";

/** Facts the event stream knows about the event behind a notification. */
export interface RealtimeNotificationOrigin {
  replayed: boolean;
  eventSessionId?: string;
}

export interface NotificationDeliveryContext extends RealtimeNotificationOrigin {
  /** Chat session open in the shell, when the Chat area is showing. */
  visibleSessionId?: string;
  /** Document visible and focused. */
  pageFocused: boolean;
}

export interface NotificationDeliveryDecision {
  toast: boolean;
  sound: boolean;
  desktop: boolean;
}

type AttentionKind = NonNullable<DerivedRealtimeNotification["attentionKind"]>;

const SILENT: NotificationDeliveryDecision = Object.freeze({ toast: false, sound: false, desktop: false });
const DECISION_KINDS: ReadonlySet<AttentionKind> = new Set(["approval_waiting", "operator_blocked"]);
const PROBLEM_KINDS: ReadonlySet<AttentionKind> = new Set(["run_failed", "runtime_degraded"]);
const UPDATE_KINDS: ReadonlySet<AttentionKind> = new Set(["run_completed", "handoff_ready"]);
/** Transport status belongs to the stream status indicator, not toasts. */
const TRANSPORT_GROUP_KEYS: ReadonlySet<string> = new Set([
  "connection-interrupted",
  "connection-restored",
  "stream-replay-gap",
]);
const AUTHORED_GROUP_PREFIX = "ui-";

/**
 * Spec §11: interrupt only for decisions and problems, stay quiet for the
 * thread on screen, and never replay history as fresh news.
 */
export function decideNotificationDelivery(
  notification: DerivedRealtimeNotification | undefined,
  context: NotificationDeliveryContext,
): NotificationDeliveryDecision {
  if (!notification || context.replayed || TRANSPORT_GROUP_KEYS.has(notification.groupKey)) {
    return SILENT;
  }
  const kind = notification.attentionKind;
  const isDecision = kind !== undefined && DECISION_KINDS.has(kind);
  const isProblem = kind !== undefined && PROBLEM_KINDS.has(kind);
  const isUpdate = kind !== undefined && UPDATE_KINDS.has(kind);
  const isAuthored = notification.groupKey.startsWith(AUTHORED_GROUP_PREFIX);
  if (!isDecision && !isProblem && !isUpdate && !isAuthored) {
    return SILENT;
  }
  const inVisibleThread =
    context.pageFocused && context.eventSessionId !== undefined && context.eventSessionId === context.visibleSessionId;
  if (inVisibleThread) {
    return SILENT;
  }
  return {
    toast: true,
    sound: isDecision || isProblem,
    desktop: isDecision && !context.pageFocused,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/state/notification-policy.test.ts src/state/realtime-derived.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/state/notification-policy.ts packages/mission-control-shared/src/state/notification-policy.test.ts packages/mission-control-shared/src/state/realtime-derived.ts packages/mission-control-shared/src/state/realtime-derived.test.ts
git commit -m "feat: add a notification delivery policy for realtime events"
```

---

### Task 5: Apply the policy in the shell

**Files:**
- Modify: `apps/mission-control-next/src/app/use-event-stream.ts` (options type at line 40; `connectEventStream` callback at lines 136-155)
- Modify: `apps/mission-control-next/src/app/use-shell-notifications.ts` (options, refs, `deliverRealtimeNotification` at lines 107-130)
- Modify: `apps/mission-control-next/src/app/MissionControlNextApp.tsx` (lines 219-224)
- Modify: `apps/mission-control-next/src/app/use-event-stream.notification-stability.test.tsx` (the `deriveRealtimeNotification` mock at lines 48-55)
- Test: `apps/mission-control-next/src/app/use-shell-notifications.policy.test.tsx`

**Interfaces:**
- Consumes: `decideNotificationDelivery`, `RealtimeNotificationOrigin` (Task 4); `RealtimeEventDelivery` (Task 3).
- Produces:
  - `UseShellNotificationsOptions.visibleSessionId?: string`
  - `deliverRealtimeNotification(notification, origin?: RealtimeNotificationOrigin)`
  - `UseEventStreamOptions.onRealtimeNotification(notification, origin)`

- [ ] **Step 1: Write the failing hook test**

```tsx
// apps/mission-control-next/src/app/use-shell-notifications.policy.test.tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { playOperatorAttentionSound } from "@goatcitadel/mission-control-shared/state/operator-attention";
import { useShellNotifications, type UseShellNotificationsResult } from "./use-shell-notifications";

vi.mock("@goatcitadel/mission-control-shared/state/operator-attention", () => ({
  playOperatorAttentionSound: vi.fn(async () => undefined),
}));

const PREFS: UiNotificationPreferences = {
  toastsEnabled: true,
  soundMode: "normal",
  desktopEnabled: false,
  onlyWhenUnfocused: false,
};

let root: Root;
let container: HTMLDivElement;
let latest: UseShellNotificationsResult;

function Harness({ visibleSessionId }: { visibleSessionId?: string }) {
  latest = useShellNotifications({ notificationPreferences: PREFS, visibleSessionId });
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(playOperatorAttentionSound).mockClear();
  vi.restoreAllMocks();
});

const APPROVAL = {
  tone: "warning" as const,
  message: "Approval waiting for operator review.",
  groupKey: "approval-1",
  truthMode: "authoritative" as const,
  attentionKind: "approval_waiting" as const,
  soundCue: "waiting" as const,
};

describe("useShellNotifications policy", () => {
  it("drops replayed and generic refresh notifications", () => {
    act(() => root.render(<Harness />));
    act(() => {
      latest.deliverRealtimeNotification(APPROVAL, { replayed: true });
      latest.deliverRealtimeNotification(
        { ...APPROVAL, tone: "info", groupKey: "chat-thread", attentionKind: "conversation_update" },
        { replayed: false },
      );
    });
    expect(latest.notifications).toHaveLength(0);
    expect(playOperatorAttentionSound).not.toHaveBeenCalled();
  });

  it("delivers live decisions with sound", () => {
    act(() => root.render(<Harness />));
    act(() => latest.deliverRealtimeNotification(APPROVAL, { replayed: false, eventSessionId: "s-2" }));
    expect(latest.notifications).toHaveLength(1);
    expect(playOperatorAttentionSound).toHaveBeenCalledWith("waiting", "normal");
  });

  it("stays quiet for the visible Chat session", () => {
    act(() => root.render(<Harness visibleSessionId="s-1" />));
    act(() => latest.deliverRealtimeNotification(APPROVAL, { replayed: false, eventSessionId: "s-1" }));
    expect(latest.notifications).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/use-shell-notifications.policy.test.tsx`
Expected: FAIL. The replayed approval and the conversation refresh both produce toasts.

- [ ] **Step 3: Implement in `use-shell-notifications.ts`**

Add the imports:

```ts
import {
  decideNotificationDelivery,
  type RealtimeNotificationOrigin,
} from "@goatcitadel/mission-control-shared/state/notification-policy";
```

Extend the options and result types:

```ts
export interface UseShellNotificationsOptions {
  notificationPreferences: UiNotificationPreferences;
  /** Chat session open in the shell; its events show inline instead of as toasts. */
  visibleSessionId?: string;
}
```

```ts
  deliverRealtimeNotification: (
    notification: RealtimeNotificationDescriptor,
    origin?: RealtimeNotificationOrigin,
  ) => void;
```

Inside the hook, destructure `visibleSessionId`, add a ref, and keep it current. Use a ref so `deliverRealtimeNotification` stays stable and the event stream does not reconnect on navigation:

```ts
  const { notificationPreferences, visibleSessionId } = options;
  const visibleSessionIdRef = useRef(visibleSessionId);
  useEffect(() => {
    visibleSessionIdRef.current = visibleSessionId;
  }, [visibleSessionId]);
```

Replace the body of `deliverRealtimeNotification`:

```ts
  const deliverRealtimeNotification = useCallback(
    (notification: RealtimeNotificationDescriptor, origin: RealtimeNotificationOrigin = { replayed: false }) => {
      const pageFocused = isPageFocused();
      const decision = decideNotificationDelivery(notification, {
        ...origin,
        visibleSessionId: visibleSessionIdRef.current,
        pageFocused,
      });
      if (!notification || (!decision.toast && !decision.sound && !decision.desktop)) {
        return;
      }
      // Read the latest preferences from the ref so this callback stays stable
      // (see `preferencesRef` above): the event-stream subscription must not
      // reconnect when the operator only toggles a notification preference.
      const preferences = preferencesRef.current;
      if (preferences.onlyWhenUnfocused && pageFocused) {
        return;
      }
      if (decision.toast && preferences.toastsEnabled) {
        pushNotification(notification.tone, notification.message, notification.groupKey);
      }
      if (decision.sound) {
        void playOperatorAttentionSound(notification.soundCue, preferences.soundMode);
      }
      if (decision.desktop && preferences.desktopEnabled) {
        showBrowserNotification(notification.message, notification.tone);
      }
    },
    [pushNotification],
  );
```

Add the helper at the bottom of the file:

```ts
function isPageFocused(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const visible = document.visibilityState === "visible";
  return visible && (typeof document.hasFocus !== "function" || document.hasFocus());
}
```

- [ ] **Step 4: Forward the origin from `use-event-stream.ts`**

Change the options type:

```ts
import type { RealtimeNotificationOrigin } from "@goatcitadel/mission-control-shared/state/notification-policy";

export interface UseEventStreamOptions {
  gatewayReady: boolean;
  onRealtimeNotification: (notification: RealtimeNotificationDescriptor, origin: RealtimeNotificationOrigin) => void;
}
```

Change the first `connectEventStream` callback to accept the delivery and pass the origin. The `?.` guard keeps mocks that call with one argument working:

```ts
    const close = connectEventStream(
      (event, delivery) => {
        publishChannelActivityFromRealtimeEvent(event);
        publishOpsSavedBoardRealtimeEvent(event);
        publishRemoteWorkerRealtimeEvent(event);
        const derivedRefresh = deriveRealtimeRefresh(event, { defaultTopics: ["surface"] });
        for (const topic of derivedRefresh.topics) {
          emitRefresh(topic, {
            reason: derivedRefresh.signalReason,
            source: event.source,
            eventType: derivedRefresh.signalEventType,
            eventId: event.eventId,
            timestamp: Date.now(),
          });
        }
        setStreamTruthMode(derivedRefresh.truthMode);
        scheduleDecay(decayHandle, derivedRefresh.truthMode, () => setStreamTruthMode("authoritative"));
        const notification = deriveRealtimeNotification(event);
        onRealtimeNotification(notification, {
          replayed: delivery?.replayed ?? false,
          eventSessionId: event.links?.sessionId,
        });
      },
```

- [ ] **Step 5: Pass the visible session from the shell**

In `MissionControlNextApp.tsx` (lines 219-220):

```tsx
  const { notifications, pushNotification, dismissNotification, deliverRealtimeNotification, lastEnabledSoundModeRef } =
    useShellNotifications({
      notificationPreferences,
      visibleSessionId: route.area === "chat" ? route.sessionId : undefined,
    });
```

- [ ] **Step 6: Keep the stability test meaningful**

The generic info mock is now silenced by the policy, so give it a toastable kind. In `use-event-stream.notification-stability.test.tsx`, replace the `deriveRealtimeNotification` mock body:

```ts
  deriveRealtimeNotification: vi.fn(() => ({
    tone: "warning" as const,
    message: "Approval waiting for operator review.",
    groupKey: "approval-stability",
    truthMode: "authoritative" as const,
    attentionKind: "approval_waiting" as const,
    soundCue: "waiting" as const,
  })),
```

- [ ] **Step 7: Rebuild the shared package and run the app tests**

Run: `pnpm --filter @goatcitadel/mission-control-shared build`
Then: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/use-shell-notifications.policy.test.tsx src/app/use-event-stream.notification-stability.test.tsx src/app/MissionControlNextApp.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/mission-control-next/src/app/use-shell-notifications.ts apps/mission-control-next/src/app/use-shell-notifications.policy.test.tsx apps/mission-control-next/src/app/use-event-stream.ts apps/mission-control-next/src/app/use-event-stream.notification-stability.test.tsx apps/mission-control-next/src/app/MissionControlNextApp.tsx
git commit -m "fix: toast only decisions and problems, never replayed history"
```

---

### Task 6: Move toasts off the composer

**Files:**
- Modify: `apps/mission-control-next/src/styles/mission-control-next.css` (`.notification-stack` at lines 1719-1730; the mobile block at lines 2588-2592)
- Modify: `apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css` (lines 52-58)
- Modify: `apps/mission-control-next/src/features/prompt-packs/prompt-packs-workbench.css` (lines 15-19)
- Test: `apps/mission-control-next/src/styles/notification-stack-placement.test.ts`

- [ ] **Step 1: Write the failing stylesheet test**

This reads the CSS through `import.meta.url`, so it works from any working directory.

```ts
// apps/mission-control-next/src/styles/notification-stack-placement.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  let index = css.indexOf(`${selector} {`);
  while (index !== -1) {
    const open = css.indexOf("{", index);
    const close = css.indexOf("}", open);
    bodies.push(css.slice(open + 1, close));
    index = css.indexOf(`${selector} {`, close);
  }
  return bodies;
}

describe("notification stack placement", () => {
  it("pins toasts to the top so they never cover the composer", () => {
    const [base] = ruleBodies(read("./mission-control-next.css"), ".notification-stack");
    expect(base).toMatch(/top:\s*4rem/);
    expect(base).not.toMatch(/bottom:\s*\d/);
  });

  it("has no area overrides that move toasts back to the bottom", () => {
    const overrides = [
      read("../features/native-routes/styles/01-shared-primitives.css"),
      read("../features/prompt-packs/prompt-packs-workbench.css"),
    ].join("\n");
    for (const match of overrides.matchAll(/\.notification-stack\s*\{([^}]*)\}/g)) {
      expect(match[1]).not.toMatch(/bottom:/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/styles/notification-stack-placement.test.ts`
Expected: FAIL (`bottom: 2.75rem` is present).

- [ ] **Step 3: Implement**

Replace the `.notification-stack` rule in `mission-control-next.css`:

```css
.notification-stack {
  position: fixed;
  /* Below the 52px top bar, clear of the composer and its Send button. */
  top: 4rem;
  right: 1rem;
  z-index: var(--z-toast);
  display: grid;
  gap: 0.65rem;
  width: min(20rem, calc(100vw - 2rem));
  pointer-events: none;
}
```

Replace the mobile rule inside the `@media (max-width: 767px)` block:

```css
  .notification-stack {
    top: calc(env(safe-area-inset-top, 0px) + 3.75rem);
    right: 0.9rem;
    left: 0.9rem;
    width: auto;
  }
```

In `01-shared-primitives.css`, replace the area override with:

```css
.mc-next-shell[data-area="library"] .notification-stack,
.mc-next-shell[data-area="ops"] .notification-stack,
.mc-next-shell[data-area="settings"] .notification-stack {
  width: min(16rem, calc(100vw - 1.5rem));
  right: 0.75rem;
}
```

In `prompt-packs-workbench.css`, remove the `bottom: 0.75rem;` line from the `.mc-next-shell[data-route="/library/prompt-packs"] .notification-stack` rule.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/styles/notification-stack-placement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/styles/mission-control-next.css apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css apps/mission-control-next/src/features/prompt-packs/prompt-packs-workbench.css apps/mission-control-next/src/styles/notification-stack-placement.test.ts
git commit -m "fix: show toasts at the top so they never cover the composer"
```

---

### Task 7: Plain-language error descriptions

**Files:**
- Create: `packages/mission-control-shared/src/api/describe-api-error.ts`
- Test: `packages/mission-control-shared/src/api/describe-api-error.test.ts`
- Modify: `apps/mission-control-next/src/features/native-routes/shared/native-helpers.ts` (`getErrorMessage` at lines 404-427)
- Modify: `packages/threaded-surface-core/src/chat/chat-error-copy.ts` (inside `describeChatUiError`, before the `econnrefused` branch)
- Modify: `packages/threaded-surface-core/src/chat/useChatRoutePreflight.ts` (line 153)
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx` (line 1778)

**Interfaces:**
- Consumes: `ApiRequestError` and `isApiRequestError` from `packages/mission-control-shared/src/api/http-internal.ts:41-72`.
- Produces:
  - `ApiErrorDescription { summary: string; technical?: string }`
  - `describeApiError(error: unknown, fallback?: string): ApiErrorDescription`
  - `GATEWAY_UNREACHABLE_SUMMARY: string`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/mission-control-shared/src/api/describe-api-error.test.ts
import { describe, expect, it } from "vitest";
import { GATEWAY_UNREACHABLE_SUMMARY, describeApiError } from "./describe-api-error";
import { ApiRequestError } from "./http-internal";

function httpError(status: number, body?: unknown) {
  return new ApiRequestError(`API error ${status}: {}`, { kind: "http", method: "POST", path: "/api/v1/x", status, body });
}

describe("describeApiError", () => {
  it("turns network failures into a plain sentence and keeps the details as technical text", () => {
    const error = new ApiRequestError("Network error POST /api/v1/chat/sessions/s/route-preflight: Failed to fetch", {
      kind: "network",
      method: "POST",
      path: "/api/v1/chat/sessions/s/route-preflight",
    });
    const described = describeApiError(error);
    expect(described.summary).toBe(GATEWAY_UNREACHABLE_SUMMARY);
    expect(described.technical).toContain("POST /api/v1/chat/sessions/s/route-preflight");
  });

  it("maps HTTP statuses to actionable sentences", () => {
    expect(describeApiError(httpError(401)).summary).toBe("Your gateway session expired. Sign in again to continue.");
    expect(describeApiError(httpError(403)).summary).toBe("You don't have permission to do that.");
    expect(describeApiError(httpError(404)).summary).toBe("That item no longer exists. Refresh to see the latest.");
    expect(describeApiError(httpError(409)).summary).toBe("This changed somewhere else. Refresh and try again.");
    expect(describeApiError(httpError(429)).summary).toBe("Too many requests. Wait a moment and try again.");
    expect(describeApiError(httpError(503)).summary).toBe("The gateway hit an error. Try again, or check System health.");
  });

  it("uses a readable server message for other client errors", () => {
    expect(describeApiError(httpError(400, { error: "Name is required." })).summary).toBe("Name is required.");
    expect(describeApiError(httpError(422, { error: "API error 422: /api/v1/x" })).summary).toBe(
      "The gateway couldn't complete that request.",
    );
  });

  it("recognizes transport failures in plain Error messages", () => {
    expect(describeApiError(new Error("Network error GET /api/v1/x: Failed to fetch")).summary).toBe(
      GATEWAY_UNREACHABLE_SUMMARY,
    );
    expect(describeApiError(new TypeError("Failed to fetch")).summary).toBe(GATEWAY_UNREACHABLE_SUMMARY);
  });

  it("passes human messages through and hides technical ones behind the fallback", () => {
    expect(describeApiError(new Error("Choose a model first.")).summary).toBe("Choose a model first.");
    expect(describeApiError(new Error("TypeError: x is undefined")).summary).toBe("Something went wrong. Try again.");
    expect(describeApiError(undefined, "Couldn't load skills.").summary).toBe("Couldn't load skills.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api/describe-api-error.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/mission-control-shared/src/api/describe-api-error.ts
import { isApiRequestError } from "./http-internal.js";

/** Spec §10.6: say what happened and what to do; technical text only in technical slots. */
export interface ApiErrorDescription {
  summary: string;
  technical?: string;
}

export const GATEWAY_UNREACHABLE_SUMMARY = "Can't reach the GoatCitadel gateway. Check that it's running, then try again.";
const DEFAULT_FALLBACK = "Something went wrong. Try again.";

export function describeApiError(error: unknown, fallback: string = DEFAULT_FALLBACK): ApiErrorDescription {
  if (isApiRequestError(error)) {
    const technical = `${error.method} ${error.path}${error.status ? ` (${error.status})` : ""}: ${error.message}`;
    if (error.kind === "network") {
      return { summary: GATEWAY_UNREACHABLE_SUMMARY, technical };
    }
    if (error.kind === "protocol") {
      return { summary: "The gateway sent a response Mission Control couldn't read. Try again.", technical };
    }
    return { summary: summaryForStatus(error.status, readBodyMessage(error.body)), technical };
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = message.trim();
  if (!trimmed) {
    return { summary: fallback };
  }
  if (looksLikeTransportFailure(trimmed)) {
    return { summary: GATEWAY_UNREACHABLE_SUMMARY, technical: trimmed };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { summary: "The request timed out. Try again.", technical: trimmed };
  }
  if (looksTechnical(trimmed)) {
    return { summary: fallback, technical: trimmed };
  }
  return { summary: trimmed };
}

function summaryForStatus(status: number | undefined, bodyMessage: string | undefined): string {
  if (status === 401) return "Your gateway session expired. Sign in again to continue.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That item no longer exists. Refresh to see the latest.";
  if (status === 409) return "This changed somewhere else. Refresh and try again.";
  if (status === 413) return "That's too large to send.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status !== undefined && status >= 500) return "The gateway hit an error. Try again, or check System health.";
  if (bodyMessage && !looksTechnical(bodyMessage)) return bodyMessage;
  return "The gateway couldn't complete that request.";
}

function readBodyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function looksLikeTransportFailure(message: string): boolean {
  return /^network error\b/i.test(message) || /failed to fetch|networkerror|econnrefused|load failed/i.test(message);
}

function looksTechnical(message: string): boolean {
  return (
    /\/api\/v\d+\//.test(message) ||
    /^(api|http) error \d{3}/i.test(message) ||
    /\b[A-Za-z]*Error:/.test(message) ||
    /\n\s+at\s/.test(message)
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api/describe-api-error.test.ts`
Expected: PASS.

- [ ] **Step 5: Route the existing helpers through it**

In `native-helpers.ts`, make `getErrorMessage` delegate for `Error` and string inputs, and keep the record branch for non-Error objects:

```ts
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error || typeof error === "string") {
    return describeApiError(error, "Something went wrong.").summary;
  }
  if (isErrorRecord(error)) {
    const message = readErrorString(error.message) ?? readErrorString(error.error) ?? readErrorString(error.detail);
    const code = readErrorString(error.code);
    if (message && code) {
      return `${describeApiError(message, "Something went wrong.").summary} (${code})`;
    }
    if (message) {
      return describeApiError(message, "Something went wrong.").summary;
    }
    if (code) {
      return `Request failed (${code})`;
    }
  }
  return "Something went wrong.";
}
```

Replace the body of each duplicate error helper so it returns `describeApiError(error).summary`, adding the same import. The duplicates are:
- the error helper in `apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.helpers.ts` (line 298)
- the error helper in `packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts` (line 935)
- the error helper in `packages/mission-control-shared/src/hooks/useOpsRuntimeSnapshot.ts` (line 422)

Inside `packages/mission-control-shared`, import it as `../api/describe-api-error.js`.

In `describeChatUiError` (`chat-error-copy.ts`), insert this branch directly before the `econnrefused` branch:

```ts
  } else if (/^network error\b/i.test(value) || normalized.includes("failed to fetch")) {
    summary = `Can't reach the GoatCitadel gateway. Check that it's running, then try again.${retryNote}`;
```

In `useChatRoutePreflight.ts` (line 153), replace the raw message with the summary, and add the import `import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";`:

```ts
          setError(describeApiError(cause).summary);
```

In `ThreadedComposer.tsx` (line 1778), drop the prefix so the hint is one plain sentence:

```tsx
            {routeSendBlockReason}
```

- [ ] **Step 6: Update tests that asserted raw text**

Run: `git grep -n "Sending is unavailable\|Network error \(GET\|POST\)" -- "apps/mission-control-next/src/**/*.test.*" "packages/*/src/**/*.test.*"`

Change each visible-text expectation to the new sentence. Keep assertions on `.technical` or on `raw` values unchanged.

- [ ] **Step 7: Run the affected suites**

Run in order (never alongside `tsc`):
- `pnpm --filter @goatcitadel/mission-control-shared build`
- `pnpm --filter @goatcitadel/threaded-surface-core build`
- `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api src/hooks`
- `pnpm --filter @goatcitadel/threaded-surface-core exec vitest run src/chat`
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface src/features/native-routes/shared`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/mission-control-shared/src/api/describe-api-error.ts packages/mission-control-shared/src/api/describe-api-error.test.ts apps/mission-control-next/src/features/native-routes/shared/native-helpers.ts apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.helpers.ts packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts packages/mission-control-shared/src/hooks/useOpsRuntimeSnapshot.ts packages/threaded-surface-core/src/chat/chat-error-copy.ts packages/threaded-surface-core/src/chat/useChatRoutePreflight.ts apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx
git add $(git diff --name-only -- "*.test.ts" "*.test.tsx")
git commit -m "fix: describe request errors in plain language"
```

---

### Task 8: Sweep the remaining raw error text

**Files (modify each; every site sets visible error or notice text from a raw message):**
- `apps/mission-control-next/src/app/MissionControlNextApp.tsx` (lines 454, 665)
- `apps/mission-control-next/src/app/use-shell-status.ts` (lines 80, 102, 124)
- Threaded surface, under `apps/mission-control-next/src/features/threaded-surface/`:
  - `ThreadedSurfaceRoute.tsx:139`
  - `ChatCapabilityProfilePanel.tsx:453`
  - `ThreadedContextDrawer.tsx:205,221`
  - `WorkflowSkillCaptureControl.tsx:91`
  - `workflow/CodeWorkbenchPanel.tsx:1469,1503,1532,1569,1605,1656,1689,1843`
  - `workflow/WorkbenchFileActionForm.tsx:92,114`
- Ops, under `apps/mission-control-next/src/features/native-routes/ops/`:
  - `BrowserSessionsRoutePage.tsx:134,161,208,242`
  - `KanbanRoutePage.tsx:124,132,301`
  - `KanbanNewTask.tsx:55`
  - `QualityDashboardRoutePage.tsx:142,162,185,211`
  - `RunDetailRoutePage.tsx:148,180,204`
  - `RuntimeRoutePage.tsx:257,343,372,401,450,494,538`
  - `OpsSavedBoardsRoutePage.tsx:827`
  - `OpsSavedBoardsWidgets.tsx:435`
- Library, Projects, and Settings, under `apps/mission-control-next/src/features/native-routes/`:
  - `library/MemoryRoutePage.tsx:392,420,884`
  - `library/LibraryExternalSourcesSection.tsx:44`
  - `library/DraftLeaveDialog.tsx:22`
  - `projects/ProjectsRoutePage.tsx:207`
  - `projects/ProjectAutomaticFanoutCard.tsx:64,122,143`
  - `settings/channel-setup/ChannelSetupWizard.tsx:164`
  - `settings/use-settings-change.tsx:236`
  - `settings/sections/PackExecutionPanel.tsx:73,88`
  - `cowork/CoworkNativePage.tsx:174,274`
- Other:
  - `apps/mission-control-next/src/features/prompt-packs/usePromptPacksWorkbenchState.ts:224,905,931,1043`

Line numbers are from `origin/main` on 2026-09-27. If a path moved, locate it with `git grep -n "\.message" -- <file>`.

**Interfaces:**
- Consumes: `describeApiError` (Task 7).

**Rule:** where a raw message becomes visible text (state that renders, a toast, or a notice), replace `error instanceof Error ? error.message : String(error)`, `error.message`, `(error as Error).message`, and `String(error)` with `describeApiError(error).summary`. Keep the prefix wording in sentence case. For example, `Trust report export failed: ${error.message}` becomes `` `Couldn't export the trust report. ${describeApiError(error).summary}` ``. Leave logging, diagnostics, and thrown errors unchanged.

- [ ] **Step 1: Apply the rule to each site above, adding the import `import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";`**

- [ ] **Step 2: Run the affected app suites**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app src/features/native-routes src/features/threaded-surface src/features/prompt-packs src/features/cowork`
Expected: PASS after updating visible-text expectations the same way as Task 7 Step 6.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @goatcitadel/mission-control-next typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add $(git diff --name-only -- apps/mission-control-next/src)
git commit -m "fix: stop showing raw request errors across Mission Control"
```

---

### Task 9: Status vocabulary and raw-enum removal

**Files:**
- Create: `packages/mission-control-shared/src/content/status-vocabulary.ts`
- Test: `packages/mission-control-shared/src/content/status-vocabulary.test.ts`
- Modify: `packages/mission-control-shared/src/content/approval-helpers.ts` (`approvalResolutionLabel`)
- Modify: `packages/mission-control-shared/src/components/chat/chat-tool-effect-truth.ts`
- Modify: `apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.tsx` (activity feed rows at lines 2155-2164)

**Interfaces:**
- Consumes: `DurableRunStatus`, `ChangePlanStatus`, `ApprovalStatus`, `ApprovalResolutionOutcome`, and `ApprovalRequest` from `@goatcitadel/contracts`.
- Produces:
  - Types: `StatusTone = "running"|"waiting"|"done"|"failed"|"neutral"`; `StatusPresentation { label: string; tone: StatusTone }`.
  - `presentRunStatus(status, { waitingOnOperator? })`
  - `presentChangePlanStatus(status)`
  - `presentApprovalStatus(status)`
  - `presentApprovalOutcome(outcome)`
  - `presentRiskLevel(level)`
  - `presentEventClass(eventClass?)`
  - `presentEventType(eventType)`
  - `presentToolEffectOutcome(outcome)`
  - `humanizeToken(value)`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/mission-control-shared/src/content/status-vocabulary.test.ts
import { describe, expect, it } from "vitest";
import {
  humanizeToken,
  presentApprovalOutcome,
  presentApprovalStatus,
  presentChangePlanStatus,
  presentEventClass,
  presentEventType,
  presentRiskLevel,
  presentRunStatus,
  presentToolEffectOutcome,
} from "./status-vocabulary";

describe("status vocabulary", () => {
  it("presents run states, including an operator wait", () => {
    expect(presentRunStatus("dead_lettered")).toEqual({ label: "Failed · needs recovery", tone: "failed" });
    expect(presentRunStatus("waiting")).toEqual({ label: "Waiting", tone: "neutral" });
    expect(presentRunStatus("waiting", { waitingOnOperator: true })).toEqual({ label: "Waiting on you", tone: "waiting" });
    expect(presentRunStatus("completed")).toEqual({ label: "Done", tone: "done" });
  });

  it("presents every change plan status in plain words", () => {
    expect(presentChangePlanStatus("awaiting_confirmation")).toEqual({ label: "Needs confirmation", tone: "waiting" });
    expect(presentChangePlanStatus("manual_required")).toEqual({ label: "Needs a manual step", tone: "waiting" });
    expect(presentChangePlanStatus("applied")).toEqual({ label: "Done", tone: "done" });
    expect(presentChangePlanStatus("rollback_failed")).toEqual({ label: "Rollback failed", tone: "failed" });
  });

  it("presents approvals, outcomes, and risk", () => {
    expect(presentApprovalStatus("edited")).toEqual({ label: "Approved with edits", tone: "done" });
    expect(presentApprovalStatus("rejected")).toEqual({ label: "Denied", tone: "neutral" });
    expect(presentApprovalOutcome("policy_blocked")).toEqual({ label: "Blocked by policy", tone: "failed" });
    expect(presentRiskLevel("nuclear")).toEqual({ label: "Nuclear", tone: "failed" });
  });

  it("names event classes and types without raw tokens", () => {
    expect(presentEventClass("domain_fact")).toBe("Record");
    expect(presentEventClass(undefined)).toBe("Event");
    expect(presentEventType("task_updated")).toBe("Task updated");
    expect(presentEventType("change_plan.awaiting_approval")).toBe("Change plan awaiting approval");
  });

  it("describes tool effect outcomes", () => {
    expect(presentToolEffectOutcome("concrete")).toBe("Made an outside change. A receipt is recorded.");
    expect(presentToolEffectOutcome("uncertain")).toBe("Outcome uncertain. Check before retrying.");
    expect(presentToolEffectOutcome("none")).toBe("No outside changes.");
  });

  it("humanizes unknown tokens in sentence case", () => {
    expect(humanizeToken("remote_worker.assignment-changed")).toBe("Remote worker assignment changed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/content/status-vocabulary.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/mission-control-shared/src/content/status-vocabulary.ts
import type {
  ApprovalRequest,
  ApprovalResolutionOutcome,
  ApprovalStatus,
  ChangePlanStatus,
  DurableRunStatus,
} from "@goatcitadel/contracts";

/** Spec §10.2: the only source of status words and tones in Mission Control. */
export type StatusTone = "running" | "waiting" | "done" | "failed" | "neutral";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
}

const status = (label: string, tone: StatusTone): StatusPresentation => Object.freeze({ label, tone });

const RUN_STATUS: Readonly<Record<DurableRunStatus, StatusPresentation>> = {
  queued: status("Queued", "neutral"),
  running: status("Running", "running"),
  waiting: status("Waiting", "neutral"),
  paused: status("Paused", "neutral"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
  dead_lettered: status("Failed · needs recovery", "failed"),
};

const CHANGE_PLAN_STATUS: Readonly<Record<ChangePlanStatus, StatusPresentation>> = {
  draft: status("Draft", "neutral"),
  awaiting_input: status("Needs your input", "waiting"),
  awaiting_confirmation: status("Needs confirmation", "waiting"),
  staging: status("Applying", "running"),
  awaiting_approval: status("Waiting on you", "waiting"),
  applying: status("Applying", "running"),
  verifying: status("Verifying", "running"),
  monitoring: status("Monitoring", "running"),
  completed: status("Done", "done"),
  applied: status("Done", "done"),
  manual_required: status("Needs a manual step", "waiting"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
  rolling_back: status("Rolling back", "running"),
  rolled_back: status("Rolled back", "neutral"),
  rollback_failed: status("Rollback failed", "failed"),
};

const APPROVAL_STATUS: Readonly<Record<ApprovalStatus, StatusPresentation>> = {
  pending: status("Waiting on you", "waiting"),
  approved: status("Approved", "done"),
  rejected: status("Denied", "neutral"),
  edited: status("Approved with edits", "done"),
};

const APPROVAL_OUTCOME: Readonly<Record<ApprovalResolutionOutcome, StatusPresentation>> = {
  approved: status("Approved", "done"),
  denied: status("Denied", "neutral"),
  withdrawn: status("Withdrawn", "neutral"),
  expired: status("Expired", "neutral"),
  policy_blocked: status("Blocked by policy", "failed"),
  delivery_failed: status("Couldn't deliver", "failed"),
  unknown: status("Outcome unknown", "waiting"),
};

const RISK_LEVEL: Readonly<Record<ApprovalRequest["riskLevel"], StatusPresentation>> = {
  safe: status("Safe", "neutral"),
  caution: status("Caution", "waiting"),
  danger: status("Danger", "failed"),
  nuclear: status("Nuclear", "failed"),
};

const EVENT_CLASS: Readonly<Record<string, string>> = {
  domain_fact: "Record",
  operational_signal: "System signal",
  ui_notification: "Notice",
};

export function humanizeToken(value: string): string {
  const words = value.split(/[_.\s-]+/).filter(Boolean).join(" ").toLowerCase();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

export function presentRunStatus(
  value: DurableRunStatus,
  options: { waitingOnOperator?: boolean } = {},
): StatusPresentation {
  if (value === "waiting" && options.waitingOnOperator) {
    return status("Waiting on you", "waiting");
  }
  return RUN_STATUS[value] ?? status(humanizeToken(value), "neutral");
}

export function presentChangePlanStatus(value: ChangePlanStatus): StatusPresentation {
  return CHANGE_PLAN_STATUS[value] ?? status(humanizeToken(value), "neutral");
}

export function presentApprovalStatus(value: ApprovalStatus): StatusPresentation {
  return APPROVAL_STATUS[value] ?? status(humanizeToken(value), "neutral");
}

export function presentApprovalOutcome(value: ApprovalResolutionOutcome): StatusPresentation {
  return APPROVAL_OUTCOME[value] ?? status(humanizeToken(value), "neutral");
}

export function presentRiskLevel(value: ApprovalRequest["riskLevel"]): StatusPresentation {
  return RISK_LEVEL[value] ?? status(humanizeToken(value), "neutral");
}

export function presentEventClass(value: string | null | undefined): string {
  return (value && EVENT_CLASS[value]) || "Event";
}

export function presentEventType(value: string): string {
  return humanizeToken(value);
}

export function presentToolEffectOutcome(value: "none" | "uncertain" | "concrete"): string {
  if (value === "concrete") return "Made an outside change. A receipt is recorded.";
  if (value === "uncertain") return "Outcome uncertain. Check before retrying.";
  return "No outside changes.";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/content/status-vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply the vocabulary where raw values reach the screen**

- **`approval-helpers.ts`:** make `approvalResolutionLabel` return vocabulary labels in lowercase so existing sentence builders keep reading naturally:

```ts
import { presentApprovalOutcome, presentApprovalStatus } from "./status-vocabulary.js";

export function approvalResolutionLabel(approval: ApprovalRequest): string {
  if (isExpiredApproval(approval)) return presentApprovalOutcome("expired").label.toLowerCase();
  if (approval.status === "pending") return "pending";
  if (approval.resolutionOutcome) return presentApprovalOutcome(approval.resolutionOutcome).label.toLowerCase();
  return presentApprovalStatus(approval.status).label.toLowerCase();
}
```

- **`chat-tool-effect-truth.ts`:** set `plainSummary` for every outcome. Import `presentToolEffectOutcome` from `../../content/status-vocabulary.js`, then replace the `...(guidance ? { plainSummary: ... } : {})` spread with:

```ts
    plainSummary: guidance ? `${presentToolEffectOutcome(outcome)} ${guidance}` : presentToolEffectOutcome(outcome),
```

- **`plainSummary` type:** make it required in `ChatToolEffectTruthProjection` (`plainSummary: string;`).
- **Tool-effect render sites:** in `packages/mission-control-shared/src/components/ChatTraceCard.tsx` (around lines 394-396) and `apps/mission-control-next/src/features/native-routes/ops/RunDetailRoutePage.tsx` (around line 1134), render `projection.plainSummary` as the visible line. Render `projection.facts` only inside an element with `className="mc-next-technical-detail"`, which the technical-details preference hides.
- **Activity feed** in `RuntimeRoutePage.tsx`: import `presentEventClass`, `presentEventType` from `@goatcitadel/mission-control-shared/content/status-vocabulary`, and replace the chip and raw source line:

```tsx
                        <ThreePartChip
                          tone={toneForActivityEvent(item.eventType, item.eventClass)}
                          state={presentEventType(item.eventType)}
                          mid={presentEventClass(item.eventClass)}
                          age={formatActivityAge(item.timestamp)}
                        />
                        <span className="mc-next-activity-feed-source mc-next-technical-detail">
                          {item.eventType}
                          {item.source ? ` / ${item.source}` : ""}
                        </span>
```

- [ ] **Step 6: Run the affected suites**

Run in order:
- `pnpm --filter @goatcitadel/mission-control-shared build`
- `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/content src/components`
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/ops`

Expected: PASS after updating expectations that asserted the old raw labels. For example, an expectation of `"blocked by policy"` stays the same, while `"delivery failed"` becomes `"couldn't deliver"`.

- [ ] **Step 7: Commit**

```bash
git add packages/mission-control-shared/src/content/status-vocabulary.ts packages/mission-control-shared/src/content/status-vocabulary.test.ts packages/mission-control-shared/src/content/approval-helpers.ts packages/mission-control-shared/src/components/chat/chat-tool-effect-truth.ts packages/mission-control-shared/src/components/ChatTraceCard.tsx apps/mission-control-next/src/features/native-routes/ops/RunDetailRoutePage.tsx apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.tsx
git add $(git diff --name-only -- "*.test.ts" "*.test.tsx")
git commit -m "feat: add a shared status vocabulary and remove raw status names"
```

---

### Task 10: Phase exit

- [ ] **Step 1: Run the UX lane**

Run: `pnpm verify:ux:budgets`
Expected:
- Every `ux-budgets.cold-load.*` scenario passes: zero toasts, no raw copy, no overflow.
- `ux-budgets.chat-space.*` reports `degraded` with its ratio; Phase 0b enforces it.

If a cold-load scenario still reports raw copy, fix it at its source with Task 7, 8, or 9's helpers. Do not widen the scanner's exemptions.

- [ ] **Step 2: Run the phase validation list from the roadmap's Global Constraints, one command at a time**

Expected: all exit 0. If `pnpm verify:fast` or `perf:check` was already red on `origin/main` before this branch, record that with the failing check names in the PR description and do not fix it here.

- [ ] **Step 3: Push and open the PR**

```bash
# First write the PR description (what changed, lane results before and after, anything left for the next phase) to "${TMPDIR:-/tmp}/ux-phase-0a-pr.md".
git push -u origin ux/phase-0a
gh pr create --title "UX phase 0a: calm notifications, plain errors, status vocabulary, ux-budgets lane" --body-file "${TMPDIR:-/tmp}/ux-phase-0a-pr.md"
```

The PR body lists:
- what changed (Tasks 1–9)
- the `verify:ux:budgets` results before (Task 2 Step 6) and after
- anything left `degraded` for Phase 0b
