# Phase 0c — Pages, Lists, and Setup Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every list row and page header say something useful, and make first-run setup tell the truth.

**Architecture:** Most fixes land in two shared primitives:

- `NativeSelectableList` shows the row description again, adds a colored status chip, and windows long lists automatically.
- `NativePageFrame` and `NativeCard` show descriptions inline and keep only technical details behind the existing technical-details preference.

Row presenters and setup progress are pure functions in `packages/mission-control-shared`, so the cockpit reuses them.

**Tech Stack:** React 19, TypeScript, vitest (react-test-renderer, happy-dom per file), CSS, `lucide-react`.

**Spec:** [`docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`](../specs/2026-09-27-mission-control-cockpit-design.md) §9, §10.2, §10.6; fixes F-08, F-09, F-10, F-11, F-12, F-13, F-18.

## Global Constraints

- Everything in the roadmap's Global Constraints applies ([roadmap](./2026-09-27-mission-control-cockpit-roadmap.md#global-constraints)).
- **Branch and dependency:** branch `ux/phase-0c` in worktree `../personal-ai-phase-0c` from the latest `origin/main`, after Phase 0a has merged. Phase 0a provides `status-vocabulary.ts`. Phase 0c can run in parallel with 0b, since they touch different files.
- **Page scaffold usage:** `NativeCard` is used at 204 sites in 62 files and `NativePageFrame` at 22 sites. Change the primitives, not the call sites, except where a task names a call site.
- **Browser lanes may depend on the old disclosures.** Before Task 4, list every dependency with `git grep -n "Page details\|mc-next-card-explanation\|mc-next-page-explanation\|About \\\${" -- scripts apps/mission-control-next/src`, and update each one in the same task.
- **Status labels:** all status words come from `@goatcitadel/mission-control-shared/content/status-vocabulary`.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `apps/mission-control-next/src/features/native-routes/primitives/NativeSelectableList.tsx` | modify | Status chip, icon, automatic windowing |
| `apps/mission-control-next/src/features/native-routes/primitives/status-chip-tone.ts` | create | Map a vocabulary tone to a `StatusChip` tone |
| `apps/mission-control-next/src/features/native-routes/primitives/NativeSelectableList.test.tsx` | modify | Tests |
| `apps/mission-control-next/src/features/native-routes/styles/07-settings-library.css` | modify | Compact rows keep one description line |
| `packages/mission-control-shared/src/content/library-rows.ts` | create | Skill row presenter |
| `packages/mission-control-shared/src/content/provider-readiness.ts` | create | Provider readiness presenter |
| `packages/mission-control-shared/src/content/library-rows.test.ts` | create | Tests |
| `packages/mission-control-shared/src/content/provider-readiness.test.ts` | create | Tests |
| `apps/mission-control-next/src/features/native-routes/library/LibrarySkillsSection.tsx` | modify | Skill rows |
| `apps/mission-control-next/src/features/native-routes/library/LibraryCapabilitiesSection.tsx` | modify | Capability rows |
| `apps/mission-control-next/src/features/native-routes/settings/sections/ProvidersSection.tsx` | modify | Provider rows |
| `apps/mission-control-next/src/features/native-routes/settings/sections/TrustPolicySection.tsx` | modify | Trust rows, bounded and windowed |
| `apps/mission-control-next/src/features/native-routes/NativeRoutePageLayout.tsx` | modify | Inline descriptions; technical details by preference |
| `apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css` | modify | Subtitle and technical-detail styles |
| `apps/mission-control-next/src/features/native-routes/NativeRoutePageLayout.test.tsx` | modify | Tests |
| `apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.tsx` | modify | Drop duplicated stats |
| `apps/mission-control-next/src/features/native-routes/primitives/ThreePartChip.tsx` | modify | Skip empty segments |
| `apps/mission-control-next/src/features/native-routes/primitives/ThreePartChip.test.tsx` | modify | Tests |
| `apps/mission-control-next/src/features/native-routes/styles/08-ops-kanban-costs.css` | modify | Chips sized to content |
| `packages/mission-control-shared/src/content/setup-progress.ts` | create | One setup readiness model |
| `packages/mission-control-shared/src/content/setup-progress.test.ts` | create | Tests |
| `apps/mission-control-next/src/features/native-routes/settings/sections/GuidedModelSetup.tsx` | modify | Use the model; plain copy; icon |
| `apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.ts` | modify | Command follows the model and base URL |
| `apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.test.ts` | modify | Tests |
| `apps/mission-control-next/src/features/native-routes/library/MemoryEnumerationControls.tsx` | modify | Pluralization |
| `apps/mission-control-next/src/features/native-routes/primitives/ResultCount.tsx` | modify | Pluralization |

---

### Task 1: List rows show a description, a status chip, and window long lists

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/primitives/NativeSelectableList.tsx`
- Create: `apps/mission-control-next/src/features/native-routes/primitives/status-chip-tone.ts`
- Modify: `apps/mission-control-next/src/features/native-routes/styles/07-settings-library.css` (lines 1396-1398)
- Test: `apps/mission-control-next/src/features/native-routes/primitives/NativeSelectableList.test.tsx`

**Interfaces:**
- Consumes: `StatusTone` and `StatusPresentation` from `@goatcitadel/mission-control-shared/content/status-vocabulary`; `StatusChip` from `./StatusChip`.
- Produces:
  - `NativeSelectableListItem` gains `status?: StatusPresentation` and `icon?: ReactNode`.
  - `statusChipTone(tone: StatusTone): StatusChipTone`
  - `shouldWindowRows(input: { itemCount: number; maxHeight?: string; virtualized: boolean; hasChildren: boolean }): boolean`, which windows above 50 rows when `virtualized` and above 100 rows otherwise, whenever `maxHeight` is set.

- [ ] **Step 1: Write the failing tests**

Add to `NativeSelectableList.test.tsx` (keep its existing imports and add these):

```tsx
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shouldWindowRows } from "./NativeSelectableList";
import { statusChipTone } from "./status-chip-tone";

describe("NativeSelectableList rows", () => {
  it("renders a status chip with the vocabulary tone and keeps the description", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <NativeSelectableList
          items={[{ id: "a", title: "Web search", body: "Searches the web.", status: { label: "On", tone: "done" } }]}
        />,
      );
    });
    const chip = renderer.root.find((node) => node.props.className === "mc-next-status-chip");
    expect(chip.props["data-tone"]).toBe("success");
    expect(renderer.root.findByType("p").props.children).toBe("Searches the web.");
  });

  it("windows long lists automatically", () => {
    expect(shouldWindowRows({ itemCount: 101, maxHeight: "40rem", virtualized: false, hasChildren: false })).toBe(true);
    expect(shouldWindowRows({ itemCount: 101, maxHeight: "", virtualized: false, hasChildren: false })).toBe(false);
    expect(shouldWindowRows({ itemCount: 60, maxHeight: "40rem", virtualized: true, hasChildren: false })).toBe(true);
    expect(shouldWindowRows({ itemCount: 60, maxHeight: "40rem", virtualized: false, hasChildren: false })).toBe(false);
  });

  it("maps every vocabulary tone", () => {
    expect(["running", "waiting", "done", "failed", "neutral"].map((tone) => statusChipTone(tone as never))).toEqual([
      "live",
      "warning",
      "success",
      "critical",
      "muted",
    ]);
  });

  it("keeps one description line in compact rows", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles/07-settings-library.css", import.meta.url)), "utf8");
    const compact = css.match(/\.mc-next-settings-selectable-list\.is-compact \.mc-next-settings-selectable p \{([^}]*)\}/);
    expect(compact?.[1]).not.toMatch(/display:\s*none/);
    expect(compact?.[1]).toMatch(/-webkit-line-clamp:\s*1/);
  });
});
```

If the file does not already import `act`, `create`, and `ReactTestRenderer`, add `import { act, create, type ReactTestRenderer } from "react-test-renderer";`, and make sure the file starts with `// @vitest-environment happy-dom`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/primitives/NativeSelectableList.test.tsx`
Expected: FAIL (no status chip, missing exports, CSS still hides the body).

- [ ] **Step 3: Implement**

```ts
// apps/mission-control-next/src/features/native-routes/primitives/status-chip-tone.ts
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { StatusChipTone } from "./StatusChip";

const TONES: Readonly<Record<StatusTone, StatusChipTone>> = {
  running: "live",
  waiting: "warning",
  done: "success",
  failed: "critical",
  neutral: "muted",
};

export function statusChipTone(tone: StatusTone): StatusChipTone {
  return TONES[tone] ?? "muted";
}
```

In `NativeSelectableList.tsx`:

```tsx
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusChip } from "./StatusChip";
import { statusChipTone } from "./status-chip-tone";

export interface NativeSelectableListItem {
  id: string;
  title: string;
  meta?: ReactNode;
  body?: ReactNode;
  status?: StatusPresentation;
  icon?: ReactNode;
}

export function shouldWindowRows(input: {
  itemCount: number;
  maxHeight?: string;
  virtualized: boolean;
  hasChildren: boolean;
}): boolean {
  if (input.hasChildren || !input.maxHeight) {
    return false;
  }
  return input.itemCount > (input.virtualized ? 50 : 100);
}
```

Replace the `windowed` computation:

```tsx
  const windowed = shouldWindowRows({
    itemCount: items?.length ?? 0,
    maxHeight,
    virtualized,
    hasChildren: Boolean(children),
  });
```

Replace the row head markup `<div className="mc-next-settings-selectable-head"><strong>{item.title}</strong>{item.meta ? <span>{item.meta}</span> : null}</div>` with:

```tsx
<div className="mc-next-settings-selectable-head">
  {item.icon ? <span className="mc-next-settings-selectable-icon" aria-hidden="true">{item.icon}</span> : null}
  <strong>{item.title}</strong>
  {item.meta ? <span>{item.meta}</span> : null}
  {item.status ? <StatusChip tone={statusChipTone(item.status.tone)}>{item.status.label}</StatusChip> : null}
</div>
```

In `07-settings-library.css`, replace the compact rule (lines 1396-1398):

```css
.mc-next-settings-selectable-list.is-compact .mc-next-settings-selectable p {
  -webkit-line-clamp: 1;
}
```

Check the class `StatusChip` renders. The test expects `className="mc-next-status-chip"` with a `data-tone` attribute (`StatusChip.tsx` renders `span.mc-next-status-chip[data-tone]`). If the element carries additional classes, match with `String(node.props.className).includes("mc-next-status-chip")` instead.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/primitives`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/primitives/NativeSelectableList.tsx apps/mission-control-next/src/features/native-routes/primitives/status-chip-tone.ts apps/mission-control-next/src/features/native-routes/primitives/NativeSelectableList.test.tsx apps/mission-control-next/src/features/native-routes/styles/07-settings-library.css
git commit -m "fix: show list descriptions and status chips, and window long lists"
```

---

### Task 2: Shared row presenters for skills and providers

**Files:**
- Create: `packages/mission-control-shared/src/content/library-rows.ts`
- Create: `packages/mission-control-shared/src/content/provider-readiness.ts`
- Test: `packages/mission-control-shared/src/content/library-rows.test.ts`, `packages/mission-control-shared/src/content/provider-readiness.test.ts`

**Interfaces:**
- Consumes:
  - `SkillListItem` from `@goatcitadel/contracts` (`packages/contracts/src/skills.ts:24-75`; `state` is `"enabled"|"sleep"|"disabled"`; optional `routingHints.whenToUse`, `trustLabel`, `note`, `reviewWarning`; required `instructionBody`).
  - `ProviderModelCatalogOption` from `../hooks/useProviderModelCatalog.js` (`authReadiness?: { status: "configured"|"ready"|"missing"|"invalid"|"unknown"|"unavailable" }`, `hasApiKey`, `modelProbeState`).
  - `StatusPresentation` and `humanizeToken` from `./status-vocabulary.js`.
- Produces:
  - `presentSkillRow(skill): { description: string; status: StatusPresentation; trust?: string }`
  - `presentProviderReadiness(provider): StatusPresentation`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/mission-control-shared/src/content/library-rows.test.ts
import { describe, expect, it } from "vitest";
import type { SkillListItem } from "@goatcitadel/contracts";
import { presentSkillRow } from "./library-rows";

function skill(overrides: Partial<SkillListItem>): SkillListItem {
  return {
    skillId: "s-1",
    name: "coding",
    state: "enabled",
    instructionBody: "Writes and reviews code. Use it for repository work.",
    ...overrides,
  } as SkillListItem;
}

describe("presentSkillRow", () => {
  it("prefers the routing hint, then the first sentence of the instructions", () => {
    expect(presentSkillRow(skill({ routingHints: { whenToUse: "Use for code changes." } as never })).description).toBe(
      "Use for code changes.",
    );
    expect(presentSkillRow(skill({})).description).toBe("Writes and reviews code.");
    expect(presentSkillRow(skill({ instructionBody: "" })).description).toBe("No description yet.");
  });

  it("maps skill state to plain status words and keeps the trust label", () => {
    expect(presentSkillRow(skill({ state: "enabled", trustLabel: "Built-in" }))).toMatchObject({
      status: { label: "On", tone: "done" },
      trust: "Built-in",
    });
    expect(presentSkillRow(skill({ state: "sleep" })).status).toEqual({ label: "Sleeping", tone: "neutral" });
    expect(presentSkillRow(skill({ state: "disabled" })).status).toEqual({ label: "Off", tone: "neutral" });
  });
});
```

```ts
// packages/mission-control-shared/src/content/provider-readiness.test.ts
import { describe, expect, it } from "vitest";
import { presentProviderReadiness } from "./provider-readiness";

describe("presentProviderReadiness", () => {
  it("treats a live model probe as connected", () => {
    expect(presentProviderReadiness({ modelProbeState: "ready", hasApiKey: false })).toEqual({ label: "Connected", tone: "done" });
  });

  it("reads auth readiness for cloud providers", () => {
    expect(presentProviderReadiness({ authReadiness: { status: "missing" } as never })).toEqual({ label: "Needs setup", tone: "waiting" });
    expect(presentProviderReadiness({ authReadiness: { status: "invalid" } as never })).toEqual({ label: "Key rejected", tone: "failed" });
    expect(presentProviderReadiness({ authReadiness: { status: "configured" } as never })).toEqual({ label: "Key saved", tone: "neutral" });
    expect(presentProviderReadiness({ authReadiness: { status: "unavailable" } as never })).toEqual({ label: "Unavailable", tone: "failed" });
  });

  it("reads the probe for local endpoints", () => {
    expect(presentProviderReadiness({ modelProbeState: "error" })).toEqual({ label: "Not answering", tone: "failed" });
    expect(presentProviderReadiness({ modelProbeState: "empty" })).toEqual({ label: "No models loaded", tone: "waiting" });
    expect(presentProviderReadiness({})).toEqual({ label: "Not checked", tone: "neutral" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/content/library-rows.test.ts src/content/provider-readiness.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// packages/mission-control-shared/src/content/library-rows.ts
import type { SkillListItem } from "@goatcitadel/contracts";
import type { StatusPresentation } from "./status-vocabulary.js";

const SKILL_STATE: Readonly<Record<SkillListItem["state"], StatusPresentation>> = {
  enabled: { label: "On", tone: "done" },
  sleep: { label: "Sleeping", tone: "neutral" },
  disabled: { label: "Off", tone: "neutral" },
};

function firstSentence(text: string | undefined): string | undefined {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^.+?[.!?](?=\s|$)/);
  return (match?.[0] ?? trimmed).slice(0, 160);
}

export function presentSkillRow(skill: SkillListItem): {
  description: string;
  status: StatusPresentation;
  trust?: string;
} {
  const hint = skill.routingHints?.whenToUse?.trim();
  return {
    description: hint || firstSentence(skill.instructionBody) || "No description yet.",
    status: SKILL_STATE[skill.state] ?? { label: "Off", tone: "neutral" },
    ...(skill.trustLabel ? { trust: skill.trustLabel } : {}),
  };
}
```

```ts
// packages/mission-control-shared/src/content/provider-readiness.ts
import type { ProviderModelCatalogOption } from "../hooks/useProviderModelCatalog.js";
import type { StatusPresentation } from "./status-vocabulary.js";

type ReadinessInput = Partial<Pick<ProviderModelCatalogOption, "authReadiness" | "hasApiKey" | "modelProbeState">>;

export function presentProviderReadiness(provider: ReadinessInput): StatusPresentation {
  if (provider.modelProbeState === "ready") {
    return { label: "Connected", tone: "done" };
  }
  switch (provider.authReadiness?.status) {
    case "ready":
      return { label: "Connected", tone: "done" };
    case "configured":
      return { label: "Key saved", tone: "neutral" };
    case "missing":
      return { label: "Needs setup", tone: "waiting" };
    case "invalid":
      return { label: "Key rejected", tone: "failed" };
    case "unavailable":
      return { label: "Unavailable", tone: "failed" };
    default:
      break;
  }
  if (provider.modelProbeState === "error") {
    return { label: "Not answering", tone: "failed" };
  }
  if (provider.modelProbeState === "empty") {
    return { label: "No models loaded", tone: "waiting" };
  }
  return { label: "Not checked", tone: "neutral" };
}
```

If `SkillListItem["routingHints"]` has no `whenToUse` field in `packages/contracts/src/skills.ts`, read it with `(skill.routingHints as { whenToUse?: string } | undefined)?.whenToUse` and keep the test.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/content/library-rows.test.ts src/content/provider-readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/content/library-rows.ts packages/mission-control-shared/src/content/library-rows.test.ts packages/mission-control-shared/src/content/provider-readiness.ts packages/mission-control-shared/src/content/provider-readiness.test.ts
git commit -m "feat: add shared row presenters for skills and provider readiness"
```

---

### Task 3: Apply the presenters to Skills, Capabilities, Providers, and Trust

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/library/LibrarySkillsSection.tsx` (lines 227-233)
- Modify: `apps/mission-control-next/src/features/native-routes/library/LibraryCapabilitiesSection.tsx` (lines 103-111)
- Modify: `apps/mission-control-next/src/features/native-routes/settings/sections/ProvidersSection.tsx` (lines 1326-1336 on `origin/main`)
- Modify: `apps/mission-control-next/src/features/native-routes/settings/sections/TrustPolicySection.tsx` (line 251)

**Interfaces:**
- Consumes: Task 1's row fields, Task 2's presenters, `humanizeToken` from `@goatcitadel/mission-control-shared/content/status-vocabulary`.

- [ ] **Step 1: Skills**

```tsx
            items={filteredSkills.map((item) => {
              const row = presentSkillRow(item);
              return {
                id: item.skillId,
                title: `${item.name}${hasSessionDraft(`skill-evaluation:${activeWorkspaceId}:${item.skillId}`) ? " · Unsaved" : ""}`,
                meta: row.trust,
                body: item.reviewWarning ?? row.description,
                status: row.status,
              };
            })}
```

Import `presentSkillRow` from `@goatcitadel/mission-control-shared/content/library-rows`.

- [ ] **Step 2: Capabilities**

```tsx
            items={filteredCapabilities.map((item) => {
              const status = deriveCapabilityStatus(item);
              return {
                id: item.capabilityId,
                title: item.title,
                meta: humanizeToken(item.kind),
                body: truncateText(item.summary, 140),
                status: { label: status.label, tone: capabilityStatusTone(status.label) },
              };
            })}
```

Add at the bottom of the file:

```ts
function capabilityStatusTone(label: string): StatusTone {
  if (label === "Available" || label === "Configured") return "done";
  if (label === "Degraded") return "waiting";
  if (label === "Unavailable") return "failed";
  return "neutral";
}
```

Import `humanizeToken` and `type StatusTone` from `@goatcitadel/mission-control-shared/content/status-vocabulary`.

- [ ] **Step 3: Providers**

Replace the item mapping. The provider id moves out of the row, since the detail pane already names the provider:

```tsx
              items={providers.map((item) => ({
                id: item.providerId,
                title: `${item.label}${hasSessionDraft(`provider:system:${item.providerId}`) || hasSessionDraft(`provider-secret:system:${item.providerId}`) ? " · Unsaved" : ""}`,
                status: presentProviderReadiness(item),
                body: [
                  `${item.models.length} models`,
                  formatProviderCredentialLabel(item.providerId, item.hasApiKey, codexOAuthStatus),
                  formatProviderProbeStateLabel(item.modelProbeState),
                ].join(" · "),
              }))}
```

Import `presentProviderReadiness` from `@goatcitadel/mission-control-shared/content/provider-readiness`.

- [ ] **Step 4: Trust and policy**

Replace the list at line 251 so labels don't repeat, blockers show as the description, and the list is bounded (and therefore windowed above 100 rows):

```tsx
                <NativeSelectableList
                  items={visibleRows.map((row) => ({
                    id: row.id,
                    title: row.label,
                    meta: [...new Set([labelForKind(row.kind), labelForTrustPolicyStatus(row.status), labelForCallableState(row)])].join(" · "),
                    body: row.blockers?.[0] ?? row.actionNeeded ?? "Inspect effective policy",
                  }))}
                  selectedId={selectedId ?? ""}
                  onSelect={setSelectedId}
                  emptyLabel="No matching policy rows."
                  maxHeight="min(62vh, 40rem)"
                />
```

- [ ] **Step 5: Run the suites**

Run in order:
- `pnpm --filter @goatcitadel/mission-control-shared build`
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/library src/features/native-routes/settings src/features/native-routes/SettingsNativePage.test.tsx`

Expected: PASS after updating expectations that looked for the provider id or the raw state text in rows. `SettingsNativePage.test.tsx` is the de facto Providers suite; its `renderPage` defaults to the providers section.

- [ ] **Step 6: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/library/LibrarySkillsSection.tsx apps/mission-control-next/src/features/native-routes/library/LibraryCapabilitiesSection.tsx apps/mission-control-next/src/features/native-routes/settings/sections/ProvidersSection.tsx apps/mission-control-next/src/features/native-routes/settings/sections/TrustPolicySection.tsx
git add $(git diff --name-only -- "apps/mission-control-next/src/**/*.test.tsx")
git commit -m "fix: give skills, capabilities, providers, and trust rows real status and descriptions"
```

---

### Task 4: Descriptions inline; technical details follow the preference

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/NativeRoutePageLayout.tsx` (`NativePageFrame` "Page details" at lines 154-169; `NativeCard` "Details" at lines 291-309)
- Modify: `apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css`
- Test: `apps/mission-control-next/src/features/native-routes/NativeRoutePageLayout.test.tsx`

**Interfaces:**
- Produces:
  - `NativeCard` renders `subtitle` as `<p className="mc-next-card-subtitle">`.
  - Technical stats render as `<dl className="mc-next-card-technical mc-next-technical-detail">`.
  - `NativePageFrame` renders technical metrics as `<dl className="mc-next-page-technical mc-next-technical-detail">`.

  The existing rule `.mc-next-shell.ui-hide-technical .mc-next-technical-detail { display: none }` (`mission-control-next.css:353-355`) hides them unless the operator turns technical details on.

- [ ] **Step 1: List the dependencies on the old disclosures**

Run: `git grep -n "Page details\|mc-next-card-explanation\|mc-next-page-explanation\|About \\\${" -- scripts apps/mission-control-next/src`

Write the list into the task's commit message body. Every hit must be updated in Step 5.

- [ ] **Step 2: Write the failing tests**

Add to `NativeRoutePageLayout.test.tsx`, using its existing imports of `NativeCard` and `NativePageFrame` and the render style it already uses:

```tsx
  it("shows a card subtitle inline and puts technical stats behind the technical-details preference", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <NativeCard title="Projects" subtitle="Containers that bind Chat threads." stats={[{ label: "Citadel", value: "c-1", technical: true }]}>
          body
        </NativeCard>,
      );
    });
    expect(renderer.root.findByProps({ className: "mc-next-card-subtitle" }).props.children).toBe("Containers that bind Chat threads.");
    expect(renderer.root.findAll((node) => node.type === "details")).toHaveLength(0);
    expect(renderer.root.findByProps({ className: "mc-next-card-technical mc-next-technical-detail" })).toBeTruthy();
  });

  it("renders page technical metrics without a Page details disclosure", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <NativePageFrame title="Projects" description="Project chat threads." metrics={[{ label: "Citadel", value: "c-1", technical: true }]}>
          body
        </NativePageFrame>,
      );
    });
    expect(renderer.root.findAll((node) => node.type === "details")).toHaveLength(0);
    expect(renderer.root.findByProps({ className: "mc-next-page-technical mc-next-technical-detail" })).toBeTruthy();
  });
```

If `NativePageFrame` requires more props in this file's existing tests, pass the same values those tests pass.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/NativeRoutePageLayout.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `NativePageFrame`, replace the `<details className="mc-next-page-explanation">…</details>` block:

```tsx
          {technicalMetrics?.length ? (
            <dl className="mc-next-page-technical mc-next-technical-detail">
              {technicalMetrics.map((metric) => (
                <div key={metric.label}>
                  <dt>{metric.label}</dt>
                  <dd>{metric.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
```

In `NativeCard`, replace the `<details className="mc-next-card-explanation">…</details>` block:

```tsx
          {subtitle ? <p className="mc-next-card-subtitle">{subtitle}</p> : null}
          {technicalStats.length ? (
            <dl className="mc-next-card-technical mc-next-technical-detail">
              {technicalStats.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
```

Remove the `Info` icon import if it is now unused. Update the comment above `statusStats` so it no longer mentions "behind Details".

Append to `01-shared-primitives.css`:

```css
.mc-next-card-subtitle {
  margin: 0.15rem 0 0;
  color: var(--fg-secondary);
  font-size: var(--text-xs);
  line-height: 1.45;
}

.mc-next-card-technical,
.mc-next-page-technical {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.9rem;
  margin: 0.3rem 0 0;
  font: var(--text-2xs) / 1.4 var(--font-mono);
  color: var(--fg-muted);
}

.mc-next-card-technical div,
.mc-next-page-technical div {
  display: flex;
  gap: 0.3rem;
}

.mc-next-card-technical dd,
.mc-next-page-technical dd {
  margin: 0;
}
```

- [ ] **Step 5: Update the dependencies found in Step 1, then run the suites**

For each hit:
- Browser lanes that clicked a "Page details" or "Details" summary: remove the click. The content is visible now, or needs technical details on (the lanes set `goatcitadel.ui.technical_details.v1`).
- Tests that looked for the disclosures: assert the new elements instead.

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes`
Then: `node --test "scripts/verification/**/*.test.mjs"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/NativeRoutePageLayout.tsx apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css apps/mission-control-next/src/features/native-routes/NativeRoutePageLayout.test.tsx
git add $(git diff --name-only -- "apps/mission-control-next/src/**/*.test.tsx" scripts)
git commit -m "fix: show page and card descriptions inline instead of behind Details"
```

---

### Task 5: Projects stops repeating its numbers; Ops chips size to content

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.tsx` (lines 704-711)
- Modify: `apps/mission-control-next/src/features/native-routes/primitives/ThreePartChip.tsx`
- Modify: `apps/mission-control-next/src/features/native-routes/primitives/ThreePartChip.test.tsx`
- Modify: `apps/mission-control-next/src/features/native-routes/styles/08-ops-kanban-costs.css` (lines 32-37)

- [ ] **Step 1: Write the failing chip test**

Add to `ThreePartChip.test.tsx`:

```tsx
  it("omits empty middle and age segments", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<ThreePartChip tone="caution" state="Stale proof" mid="" age="" />);
    });
    expect(renderer.root.findAll((node) => node.props.className === "mc-next-chip-3-mid")).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.props.className === "mc-next-chip-3-age")).toHaveLength(0);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/primitives/ThreePartChip.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ThreePartChip.tsx`:

```tsx
      {mid !== undefined && mid !== "" ? <span className="mc-next-chip-3-mid">{mid}</span> : null}
      {age !== undefined && age !== "" ? <span className="mc-next-chip-3-age">{age}</span> : null}
```

In `08-ops-kanban-costs.css`, add `justify-items: start;` to `.mc-next-ops-attention-copy`.

In `ProjectsRoutePage.tsx`, delete the `stats={[…]}` prop from the "Projects" `NativeCard` (lines 707-710). The page header already shows both numbers.

- [ ] **Step 4: Run the suites**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/primitives src/features/native-routes/projects src/features/native-routes/ops`
Expected: PASS after removing expectations for the duplicated Projects card stats.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/primitives/ThreePartChip.tsx apps/mission-control-next/src/features/native-routes/primitives/ThreePartChip.test.tsx apps/mission-control-next/src/features/native-routes/styles/08-ops-kanban-costs.css apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.tsx
git add $(git diff --name-only -- "apps/mission-control-next/src/**/*.test.tsx")
git commit -m "fix: drop duplicated Projects stats and size Ops attention chips to content"
```

---

### Task 6: First-run setup tells one consistent story

**Files:**
- Create: `packages/mission-control-shared/src/content/setup-progress.ts`
- Test: `packages/mission-control-shared/src/content/setup-progress.test.ts`
- Modify: `apps/mission-control-next/src/features/native-routes/settings/sections/GuidedModelSetup.tsx` (`origin/main`):
  - stats at lines 341-349
  - steps at lines 358-378
  - note at line 430
  - Change Plan error strings at lines 554, 567, 582, 597, 639
  - icon at line 506
  - the `localRuntimeSetupGuide(…)` call
- Modify: `apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.ts` (`origin/main`, lines 175-205)
- Modify: `apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.test.ts`

**Interfaces:**
- Produces:
  - `SetupStepState = "complete"|"active"|"pending"`
  - `deriveSetupProgress(input: { providerReady: boolean; defaultPlanCompleted: boolean; firstResponseVerified: boolean }): { steps: readonly [SetupStepState, SetupStepState, SetupStepState]; firstResponseLabel: string; needsRecheck: boolean }`
  - `localRuntimeSetupGuide(provider, model?: string)`

Rule: a step is complete only when every step before it is complete. A first response verified earlier does not complete step 3 while the connection is stale; it reads "Verified before · recheck the connection".

- [ ] **Step 1: Write the failing tests**

```ts
// packages/mission-control-shared/src/content/setup-progress.test.ts
import { describe, expect, it } from "vitest";
import { deriveSetupProgress } from "./setup-progress";

describe("deriveSetupProgress", () => {
  it("never completes a later step while an earlier one is incomplete", () => {
    expect(deriveSetupProgress({ providerReady: false, defaultPlanCompleted: false, firstResponseVerified: true })).toEqual({
      steps: ["active", "pending", "pending"],
      firstResponseLabel: "Verified before · recheck the connection",
      needsRecheck: true,
    });
  });

  it("walks through the steps in order", () => {
    expect(deriveSetupProgress({ providerReady: true, defaultPlanCompleted: false, firstResponseVerified: false }).steps).toEqual([
      "complete",
      "active",
      "pending",
    ]);
    expect(deriveSetupProgress({ providerReady: true, defaultPlanCompleted: true, firstResponseVerified: false })).toMatchObject({
      steps: ["complete", "complete", "active"],
      firstResponseLabel: "Not yet",
    });
    expect(deriveSetupProgress({ providerReady: true, defaultPlanCompleted: true, firstResponseVerified: true })).toMatchObject({
      steps: ["complete", "complete", "complete"],
      firstResponseLabel: "Verified",
      needsRecheck: false,
    });
  });
});
```

Add to `guided-model-setup-support.test.ts`:

```ts
  it("builds the llama.cpp command from the selected model and the base URL", () => {
    const guide = localRuntimeSetupGuide({ providerId: "llamacpp", baseUrl: "http://127.0.0.1:8181/v1" }, "Ornith-35B-Q4_K_M");
    expect(guide?.command).toBe(
      "llama-server -m path/to/model.gguf --alias Ornith-35B-Q4_K_M --host 127.0.0.1 --port 8181 --jinja",
    );
  });

  it("uses a neutral alias and default port when nothing is chosen", () => {
    const guide = localRuntimeSetupGuide({ providerId: "llamacpp", baseUrl: "not a url" });
    expect(guide?.command).toBe("llama-server -m path/to/model.gguf --alias my-local-model --host 127.0.0.1 --port 8080 --jinja");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/content/setup-progress.test.ts`
Then: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/settings/sections/guided-model-setup-support.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/mission-control-shared/src/content/setup-progress.ts
/** Spec F-12: one readiness model for first-run setup, reused by the cockpit's first run. */
export type SetupStepState = "complete" | "active" | "pending";

export interface SetupProgress {
  steps: readonly [SetupStepState, SetupStepState, SetupStepState];
  firstResponseLabel: string;
  needsRecheck: boolean;
}

export function deriveSetupProgress(input: {
  providerReady: boolean;
  defaultPlanCompleted: boolean;
  firstResponseVerified: boolean;
}): SetupProgress {
  const connect: SetupStepState = input.providerReady ? "complete" : "active";
  const confirm: SetupStepState = !input.providerReady ? "pending" : input.defaultPlanCompleted ? "complete" : "active";
  const firstChat: SetupStepState = confirm !== "complete" ? "pending" : input.firstResponseVerified ? "complete" : "active";
  const needsRecheck = input.firstResponseVerified && !input.providerReady;
  const firstResponseLabel = needsRecheck
    ? "Verified before · recheck the connection"
    : firstChat === "complete"
      ? "Verified"
      : input.firstResponseVerified
        ? "Verified before"
        : "Not yet";
  return { steps: [connect, confirm, firstChat], firstResponseLabel, needsRecheck };
}
```

In `guided-model-setup-support.ts`, change the guide builders to receive the model:

```ts
type GuideContext = { baseUrl: string; model?: string };

function hostAndPort(baseUrl: string): { host: string; port: string } {
  try {
    const url = new URL(baseUrl);
    return { host: url.hostname || "127.0.0.1", port: url.port || "8080" };
  } catch {
    return { host: "127.0.0.1", port: "8080" };
  }
}

const LOCAL_RUNTIME_GUIDES: Readonly<Record<string, (context: GuideContext) => LocalRuntimeSetupGuide>> = {
  llamacpp: ({ baseUrl, model }) => {
    const { host, port } = hostAndPort(baseUrl);
    const alias = model?.trim() || "my-local-model";
    return {
      title: "Start llama.cpp before connecting",
      steps: [
        "Download a GGUF model, or let GoatCitadel manage llama-server from Settings → Runtime.",
        `Run llama-server so it answers at ${baseUrl} (the /v1 OpenAI-compatible API).`,
        "Pass --alias so the model name you pick here matches what the server reports from /v1/models.",
        "Select Check connection. GoatCitadel checks the server and lists the models it serves.",
      ],
      command: `llama-server -m path/to/model.gguf --alias ${alias} --host ${host} --port ${port} --jinja`,
    };
  },
  localai: ({ baseUrl }) => ({
```

Keep the LocalAI body unchanged, then close the object as before.

Update the exported function:

```ts
export function localRuntimeSetupGuide(
  provider: Pick<ProviderModelCatalogOption, "providerId" | "baseUrl"> | null,
  model?: string,
): LocalRuntimeSetupGuide | null {
  if (!provider) return null;
  const build = LOCAL_RUNTIME_GUIDES[provider.providerId.trim().toLowerCase()];
  return build ? build({ baseUrl: provider.baseUrl, model }) : null;
}
```

In `GuidedModelSetup.tsx`:
- **Import** `deriveSetupProgress` from `@goatcitadel/mission-control-shared/content/setup-progress`, and `PlugZap` from `lucide-react`.
- **Compute progress** before the JSX:

```tsx
  const progress = deriveSetupProgress({
    providerReady,
    defaultPlanCompleted,
    firstResponseVerified: onboarding.firstTask?.status === "verified",
  });
```

- **Stats:** the "First response" stat becomes `{ label: "First response", value: progress.firstResponseLabel }`.
- **Steps:** the three step `state` values become `progress.steps[0]`, `progress.steps[1]`, and `progress.steps[2]`. Step 3's description becomes:

```tsx
            description: progress.needsRecheck
              ? "Your first response was verified earlier. Check the connection to continue."
              : progress.steps[2] === "complete"
                ? "A completed model response is recorded in Chat."
                : "Ask your own question or choose a starter prompt in Chat.",
```

- **Guide call:** pass the model as the second argument: `localRuntimeSetupGuide(selectedProvider, model)`, using the same provider variable the current call passes.
- **Line 430:** "Model availability is checked live when the Change Plan is created." becomes "GoatCitadel checks that the model is available when you confirm it."
- **Error strings** at lines 554, 567, 582, 597, and 639: replace "the Change Plan" with "your change" and "Change Plan" with "change", keeping each sentence's meaning.
- **Line 506 icon:** `{defaultPlanCompleted ? <Play size={16} /> : <Save size={16} />}` becomes `{defaultPlanCompleted ? <Play size={16} /> : <PlugZap size={16} />}`. Remove the `Save` import if unused.

- [ ] **Step 4: Run the suites**

Run in order:
- `pnpm --filter @goatcitadel/mission-control-shared build`
- `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/content/setup-progress.test.ts`
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/settings`

Expected: PASS after updating expectations for "Not yet verified" (now "Not yet") and for the step states in the stale case.

- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/content/setup-progress.ts packages/mission-control-shared/src/content/setup-progress.test.ts apps/mission-control-next/src/features/native-routes/settings/sections/GuidedModelSetup.tsx apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.ts apps/mission-control-next/src/features/native-routes/settings/sections/guided-model-setup-support.test.ts
git add $(git diff --name-only -- "apps/mission-control-next/src/**/*.test.tsx")
git commit -m "fix: make first-run setup steps and the local runtime command consistent"
```

---

### Task 7: Plural-aware counts

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/library/MemoryEnumerationControls.tsx` (line 20)
- Modify: `apps/mission-control-next/src/features/native-routes/primitives/ResultCount.tsx` (lines 28-38)
- Modify: `apps/mission-control-next/src/features/native-routes/primitives/ResultCount.test.tsx`

**Interfaces:**
- Produces: `ResultCountProps.nounSingular?: string`. It defaults to `noun` with a trailing "s" removed.

- [ ] **Step 1: Write the failing test**

Add to `ResultCount.test.tsx`, using its existing render pattern:

```tsx
  it("uses the singular noun for exactly one result", () => {
    const text = renderResultCount({ shown: 1, total: 1, noun: "items" });
    expect(text).toBe("1 item");
  });
```

If the file has no `renderResultCount` helper, render `<ResultCount shown={1} total={1} noun="items" />` with react-test-renderer. Read the text of the `aria-live` span, as the file's existing tests do.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/primitives/ResultCount.test.tsx`
Expected: FAIL ("1 items").

- [ ] **Step 3: Implement**

In `ResultCount.tsx`, add `nounSingular` to the props and destructuring, then:

```tsx
  const label = (count: number) => (count === 1 ? (nounSingular ?? noun.replace(/s$/, "")) : noun);
  const truncated = shown < total;
  const text = truncated
    ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${label(total)}`
    : `${total.toLocaleString()} ${label(total)}`;
```

In `MemoryEnumerationControls.tsx` (line 20), make the result phrase plural-aware:

```tsx
        : `${props.visible} matching ${props.visible === 1 ? "result" : "results"} loaded · ${props.loaded} of ${props.total ?? "unknown"} total. ${props.hasMore ? "Namespace and lifecycle counts cover loaded items." : ""}`}
```

- [ ] **Step 4: Run the suites**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/primitives/ResultCount.test.tsx src/features/native-routes/library`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/primitives/ResultCount.tsx apps/mission-control-next/src/features/native-routes/primitives/ResultCount.test.tsx apps/mission-control-next/src/features/native-routes/library/MemoryEnumerationControls.tsx
git commit -m "fix: use singular nouns for single results"
```

---

### Task 8: Phase exit

- [ ] **Step 1: Run the UX lane**

Run: `pnpm verify:ux:budgets`
Expected: every cold-load scenario still passes. The new descriptions must not introduce raw copy. If a row description shows a snake_case value, pass it through `humanizeToken` at its presenter.

- [ ] **Step 2: Rebaseline**

Descriptions now show on every card, so rebaseline through the workflow:

```bash
gh workflow run visual-rebaseline.yml --ref ux/phase-0c
```

Then cherry-pick the pushed `chore/visual-rebaseline-<runid>` commit and delete that branch. Review by eye:
- `visual-regression-library-skills-desktop-dark.png`
- `visual-regression-settings-providers-desktop-dark.png`
- `visual-regression-settings-trust-policy-desktop-dark.png`
- `visual-regression-settings-onboarding-desktop-dark.png`

- [ ] **Step 3: Phase validation, push, and PR**

Run the roadmap's per-phase validation list, then:

```bash
# First write the PR description (what changed, lane results before and after, anything left for the next phase) to "${TMPDIR:-/tmp}/ux-phase-0c-pr.md".
git push -u origin ux/phase-0c
gh pr create --title "UX phase 0c: useful list rows, inline descriptions, honest first-run setup" --body-file "${TMPDIR:-/tmp}/ux-phase-0c-pr.md"
```
