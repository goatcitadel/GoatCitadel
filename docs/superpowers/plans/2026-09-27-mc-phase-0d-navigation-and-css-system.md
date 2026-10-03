# Phase 0d — Navigation and CSS System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Cut the sidebar to at most seven pages per area, with sections as tabs and no URL changes.
- Reduce 31 CSS breakpoints to 4 and fold the one-off heading sizes into tokens.
- Split the oversized files the cockpit will build on.

**Architecture:**
- **Grouping:** `RAIL_GROUPS` in `apps/mission-control-next/src/app/route-model.ts` already drives the sidebar and breadcrumbs. Regroup it into the spec's pages, render one sidebar entry per group, and show a tab strip of the group's sections above the page. Section slugs, URLs, release manifests, and baselines keep their keys, so the governance gates stay green.
- **Breakpoints:** a tested codemod rewrites breakpoints, and a new check script in the existing `check-mission-control-next-*` family keeps them at four values.
- **Splits:** each split moves code without changing behavior and re-exports from the original path, so existing tests and `vi.mock` targets keep working.

**Tech Stack:** TypeScript, React 19, vitest, `node:test` for scripts, CSS.

**Spec:** [`docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`](../specs/2026-09-27-mission-control-cockpit-design.md) §5.2, §5.3, §10.5, §14; fixes F-14, F-15, F-16, F-17.

## Global Constraints

- Everything in the roadmap's Global Constraints applies ([roadmap](./2026-09-27-mission-control-cockpit-roadmap.md#global-constraints)).
- **Branch and dependencies:** branch `ux/phase-0d` in worktree `../personal-ai-phase-0d` from the latest `origin/main`, after Phases 0b and 0c have merged.
- **No renaming:** never rename or remove a section slug or route. `scripts/validate-governance-docs.mjs` fails when a slug changes (checks: route release scope, manifest, scope doc, route counts in `README.md:167` and `docs/1_0_RELEASE_EVIDENCE.md:40`, and 8 baselines per slug).
- **`docs/1_0_CONTRACT.md` wording:** the contract must keep the literal text "Work / Projects / Library / Ops / Settings" (validator line 411-416). This phase does not change top-level areas.
- **Refactor tasks change no behavior:** the existing tests for a moved file must pass unchanged. The only allowed edits to them are import paths, and only when a test needs a symbol the original module no longer re-exports. Prefer adding the re-export.
- **Split hazards** (from the 2026-09-27 research):
  - **Moved-code tests:** keep helpers re-exported from their original module. `RuntimeRoutePage.test.tsx` imports 20 helpers from `./RuntimeRoutePage`. Host tests import helpers from the host path.
  - **ChannelsSection imports:** `ChannelSetupWizard.test.tsx:75` partially mocks `../../SettingsNativePage` while rendering ChannelsSection. Keep ChannelsSection importing its helpers from `SettingsNativePage`, not from new helper files.
  - **Host test mocks:** `MissionThreadedControllerHost.test.tsx` mocks 17 `./chat/*` hooks and checks their exact argument shapes. It also mocks `api/client` without 12 functions the host uses. New modules must not call API functions at module top level, and new hooks must not change the arguments passed to existing mocked hooks.
  - **One draft-leave instance:** `useDraftLeave` is one instance per page (SettingsNativePage line 316, RuntimeRoutePage line 149, ProvidersSection line 124). Pass it to extracted children as a prop; never call it again in a child.
  - **Test paths and titles:** verification lanes pin test file paths and titles (`usability-action-evidence.mjs`, `usability-coverage.mjs`, `model-council-lane.mjs`). Do not rename or move test files.
  - **Chunk names:** `scripts/check-mission-control-next-budgets.mjs` expects chunk names `ThreadedSurface*`, `NativeRoutePages-*`, and `ThreadedSurfaceRoute-*.css`. Do not add new `lazy()` boundaries in this phase.
  - **Rebuild core:** rebuild `@goatcitadel/threaded-surface-core` before running app tests.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `apps/mission-control-next/src/app/route-model.ts` | modify | New page groups; the Communications label becomes Mail |
| `apps/mission-control-next/src/app/MissionControlNextApp.helpers.test.ts` | modify | Pin the new groups |
| `apps/mission-control-next/src/app/RailGroupTabs.tsx` | create | Tab strip of a page's sections |
| `apps/mission-control-next/src/app/RailGroupTabs.test.tsx` | create | Tests |
| `apps/mission-control-next/src/app/MissionControlShellChrome.tsx` | modify | One sidebar entry per page; stage slot for tabs |
| `apps/mission-control-next/src/app/MissionControlNextApp.tsx` | modify | Pass the tabs into the stage |
| `apps/mission-control-next/src/styles/mission-control-next.css` | modify | Tab strip styles |
| `scripts/codemods/normalize-mission-control-next-breakpoints.mjs` | create | Rewrite breakpoints to four values |
| `scripts/codemods/normalize-mission-control-next-breakpoints.test.mjs` | create | Mapping tests |
| `scripts/check-mission-control-next-breakpoints.mjs` | create | Gate: only canonical breakpoints |
| `scripts/check-mission-control-next-breakpoints.test.mjs` | create | Tests |
| `scripts/check-mission-control-next-typography.mjs` | modify | `clamp()` only in the tokens file; no literal fallbacks |
| `scripts/check-mission-control-next-typography.test.mjs` | modify | Tests |
| `apps/mission-control-next/package.json` | modify | `perf:check` runs the breakpoint check |
| `.github/workflows/code-quality.yml` | modify | CI runs the breakpoint check next to typography |
| `packages/threaded-surface-core/src/chat/hydrated-storage.ts` | create | Storage parsers moved from the host |
| `packages/threaded-surface-core/src/chat/useChatTimerPanel.ts` | create | Timer panel state moved from the host |
| `packages/threaded-surface-core/src/chat/useRunVariablePanel.ts` | create | Run-variable panel state moved from the host |
| `packages/threaded-surface-core/src/chat/useChatChangePlans.ts` | create | Change-plan state moved from the host |
| `apps/mission-control-next/src/features/native-routes/ops/runtime/*` | create | Sections and helpers moved out of RuntimeRoutePage |
| `apps/mission-control-next/src/features/native-routes/settings/helpers/*` | create | Helpers moved out of SettingsNativePage |
| `apps/mission-control-next/src/features/native-routes/settings/sections/providers/*` | create | Inspectors and format helpers moved out of ProvidersSection |
| `apps/mission-control-next/src/features/threaded-surface/surface/*` | create | Components moved out of ThreadedSurfacePage |
| `docs/LLAMA_CPP_SETUP.md`, `docs/1_0_RELEASE_SURFACE_SCOPE.md` | modify | Navigation wording |

---

### Task 1: Regroup sections into pages

**Files:**
- Modify: `apps/mission-control-next/src/app/route-model.ts` (`RAIL_GROUPS` at lines 703-723; the Communications rail item label at line 385)
- Modify: `apps/mission-control-next/src/app/MissionControlNextApp.helpers.test.ts` (lines 21-72)

**Interfaces:**
- Produces: the group ids and labels below. Later tasks and the cockpit use them as page identities.

| Area | Group id | Label | Sections, in tab order |
| --- | --- | --- | --- |
| settings | `settings-general` | General | general, personalities |
| settings | `settings-models` | Models | onboarding, providers, local-ai |
| settings | `settings-connections` | Connections | channels, integrations, mcp, addons |
| settings | `settings-safety` | Safety | permissions, tools, trust-policy, hooks, budget |
| settings | `settings-citadel` | Citadel | citadel-overview, workspaces, citadel, citadel-wards, citadel-council, citadel-vault, citadel-blueprint, workspace-capabilities, citadel-capabilities |
| settings | `settings-access` | Access | access |
| settings | `settings-advanced` | Advanced | runtime |
| library | `library-agents` | Agents | agents |
| library | `library-skills` | Skills and tools | skills, capabilities, prompt-packs, curator, journey |
| library | `library-knowledge` | Knowledge | knowledge, memory, notes |
| library | `library-files` | Files | files, artifacts |
| library | `library-mail` | Mail | communications |
| ops | `ops-approvals` | Approvals | approvals |
| ops | `ops-activity` | Activity | activity, sessions, notifications |
| ops | `ops-work-board` | Work board | kanban, boards, schedules |
| ops | `ops-costs` | Costs | costs |
| ops | `ops-health` | Health | runtime, diagnostics, workers |
| ops | `ops-quality` | Quality | quality, improvement |

- [ ] **Step 1: Rewrite the pinned expectations**

In `MissionControlNextApp.helpers.test.ts`, replace the body of `it("groups rail sections by product area", …)`:

```ts
    expect(buildRailSections("settings", [item("general"), item("channels"), item("tools")])).toEqual([
      { id: "settings-general", label: "General", items: [item("general")] },
      { id: "settings-connections", label: "Connections", items: [item("channels")] },
      { id: "settings-safety", label: "Safety", items: [item("tools")] },
    ]);
    expect(
      buildRailSections("settings", [
        item("onboarding"),
        item("permissions"),
        item("providers"),
        item("trust-policy"),
        item("personalities"),
        item("access"),
        item("runtime"),
        item("workspaces"),
        item("integrations"),
        item("mcp"),
        item("addons"),
        item("hooks"),
      ]).map((group) => group.items.map((entry) => entry.section)),
    ).toEqual([
      ["personalities"],
      ["onboarding", "providers"],
      ["integrations", "mcp", "addons"],
      ["permissions", "trust-policy", "hooks"],
      ["workspaces"],
      ["access"],
      ["runtime"],
    ]);
    expect(
      buildRailSections("library", [item("memory"), item("prompt-packs"), item("curator"), item("communications")]).map(
        (group) => group.id,
      ),
    ).toEqual(["library-skills", "library-knowledge", "library-mail"]);
    expect(buildRailSections("ops", [item("activity"), item("approvals")]).map((group) => group.id)).toEqual([
      "ops-approvals",
      "ops-activity",
    ]);
    expect(
      buildRailSections("ops", [
        item("sessions"),
        item("schedules"),
        item("improvement"),
        item("notifications"),
        item("costs"),
        item("quality"),
        item("runtime"),
        item("diagnostics"),
        item("kanban"),
      ]).map((group) => group.items.map((entry) => entry.section)),
    ).toEqual([
      ["sessions", "notifications"],
      ["schedules", "kanban"],
      ["costs"],
      ["runtime", "diagnostics"],
      ["improvement", "quality"],
    ]);
    expect(buildRailSections("chat", [item("thread")])).toEqual([{ id: "chat-primary", items: [item("thread")] }]);
```

Add a new case in the same `describe`:

```ts
  it("keeps every area at seven pages or fewer", () => {
    for (const area of ["settings", "library", "ops"] as const) {
      expect(buildRailSections(area, navigationRailItems(area)).length).toBeLessThanOrEqual(7);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/MissionControlNextApp.helpers.test.ts`
Expected: FAIL (old group ids).

- [ ] **Step 3: Replace `RAIL_GROUPS`**

```ts
export const RAIL_GROUPS: Partial<Record<PrimaryArea, RailGroup[]>> = {
  settings: [
    { id: "settings-general", label: "General", sections: ["general", "personalities"] },
    { id: "settings-models", label: "Models", sections: ["onboarding", "providers", "local-ai"] },
    { id: "settings-connections", label: "Connections", sections: ["channels", "integrations", "mcp", "addons"] },
    { id: "settings-safety", label: "Safety", sections: ["permissions", "tools", "trust-policy", "hooks", "budget"] },
    {
      id: "settings-citadel",
      label: "Citadel",
      sections: [
        "citadel-overview",
        "workspaces",
        "citadel",
        "citadel-wards",
        "citadel-council",
        "citadel-vault",
        "citadel-blueprint",
        "workspace-capabilities",
        "citadel-capabilities",
      ],
    },
    { id: "settings-access", label: "Access", sections: ["access"] },
    { id: "settings-advanced", label: "Advanced", sections: ["runtime"] },
  ],
  library: [
    { id: "library-agents", label: "Agents", sections: ["agents"] },
    { id: "library-skills", label: "Skills and tools", sections: ["skills", "capabilities", "prompt-packs", "curator", "journey"] },
    { id: "library-knowledge", label: "Knowledge", sections: ["knowledge", "memory", "notes"] },
    { id: "library-files", label: "Files", sections: ["files", "artifacts"] },
    { id: "library-mail", label: "Mail", sections: ["communications"] },
  ],
  ops: [
    { id: "ops-approvals", label: "Approvals", sections: ["approvals"] },
    { id: "ops-activity", label: "Activity", sections: ["activity", "sessions", "notifications"] },
    { id: "ops-work-board", label: "Work board", sections: ["kanban", "boards", "schedules"] },
    { id: "ops-costs", label: "Costs", sections: ["costs"] },
    { id: "ops-health", label: "Health", sections: ["runtime", "diagnostics", "workers"] },
    { id: "ops-quality", label: "Quality", sections: ["quality", "improvement"] },
  ],
};
```

At line 385, change the Communications rail item's `label: "Communications"` to `label: "Mail"`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/MissionControlNextApp.helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Update breadcrumb and label expectations**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app`

Update each failing expectation to the new group labels, for example:
- `route-model.unified-surface.test.ts:126-150`: "Ops · Overview · Saved boards" becomes "Ops · Work board · Saved boards".
- `MissionControlNextApp.test.tsx:1003-1026`: `mc-next-rail-group-settings-connections` stays for Connections. Other group ids change.

Do not change `legacy-route-adapter.test.ts`, because its scope keys are section slugs, which are unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/mission-control-next/src/app/route-model.ts apps/mission-control-next/src/app/MissionControlNextApp.helpers.test.ts
git add $(git diff --name-only -- "apps/mission-control-next/src/app/*.test.ts" "apps/mission-control-next/src/app/*.test.tsx")
git commit -m "feat: group Settings, Library, and Ops sections into pages"
```

---

### Task 2: One sidebar entry per page, with sections as tabs

**Files:**
- Create: `apps/mission-control-next/src/app/RailGroupTabs.tsx`
- Test: `apps/mission-control-next/src/app/RailGroupTabs.test.tsx`
- Modify: `apps/mission-control-next/src/app/MissionControlShellChrome.tsx` (group rendering in `ShellRail` at lines 403-464; `ShellRouteStage` at lines 601-641)
- Modify: `apps/mission-control-next/src/app/MissionControlNextApp.tsx` (`<ShellRouteStage` at line 981)
- Modify: `apps/mission-control-next/src/styles/mission-control-next.css`
- Modify: `apps/mission-control-next/src/app/MissionControlShellChrome.mobile-nav.test.tsx`

**Interfaces:**
- Consumes: `RailSection` (the return type of `buildRailSections`, with `id`, `label?`, and `items: RailItem[]`), `isRailItemActive`, `buildNavigationTarget`.
- Produces:
  - `RailGroupTabs({ route, sections, navigate }): JSX.Element | null`. It renders only when the active group has more than one visible item.
  - `ShellRouteStage` prop `sectionTabs?: ReactNode`, rendered above the page inside `.mc-next-stage-scroll`.

- [ ] **Step 1: Write the failing tab test**

```tsx
// apps/mission-control-next/src/app/RailGroupTabs.test.tsx
// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { RailGroupTabs } from "./RailGroupTabs";
import type { AppRoute, RailItem } from "./route-model";

const items: RailItem[] = [
  { id: "providers", label: "Providers", description: "Model providers.", area: "settings", section: "providers" },
  { id: "local-ai", label: "Local AI", description: "Local runtimes.", area: "settings", section: "local-ai" },
];
const sections = [{ id: "settings-models", label: "Models", items }];

describe("RailGroupTabs", () => {
  it("lists the active page's sections and marks the current one", () => {
    const navigate = vi.fn();
    let renderer!: ReactTestRenderer;
    const route: AppRoute = { area: "settings", section: "local-ai" };
    act(() => {
      renderer = create(<RailGroupTabs route={route} sections={sections} navigate={navigate} />);
    });
    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map((button) => button.props.children)).toEqual(["Providers", "Local AI"]);
    expect(buttons[1]!.props["aria-current"]).toBe("page");
    act(() => buttons[0]!.props.onClick());
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ area: "settings", section: "providers" }));
  });

  it("renders nothing for single-section pages or routes outside any page", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <RailGroupTabs route={{ area: "settings", section: "access" }} sections={[{ id: "settings-access", label: "Access", items: [items[0]!] }]} navigate={vi.fn()} />,
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/RailGroupTabs.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the tab strip**

```tsx
// apps/mission-control-next/src/app/RailGroupTabs.tsx
import { buildNavigationTarget, isRailItemActive, type AppRoute, type RailItem } from "./route-model";

export interface RailGroupTabsSection {
  id: string;
  label?: string;
  items: RailItem[];
}

export function RailGroupTabs({
  route,
  sections,
  navigate,
}: {
  route: AppRoute;
  sections: readonly RailGroupTabsSection[];
  navigate: (route: AppRoute) => void;
}) {
  const active = sections.find((section) => section.items.some((item) => isRailItemActive(route, item)));
  // Unlabeled groups are areas without pages (for example Projects); their items stay in the sidebar.
  if (!active || !active.label || active.items.length < 2) {
    return null;
  }
  return (
    <nav className="mc-next-section-tabs" aria-label={`${active.label ?? "Page"} sections`}>
      {active.items.map((item) => {
        const current = isRailItemActive(route, item);
        return (
          <button
            key={item.id}
            type="button"
            className={`mc-next-section-tab${current ? " active" : ""}`}
            aria-current={current ? "page" : undefined}
            onClick={() => navigate(buildNavigationTarget(route, item))}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
```

Append to `mission-control-next.css`:

```css
.mc-next-section-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin: 0 0 0.9rem;
  border-bottom: 1px solid var(--border-subtle);
}

.mc-next-section-tab {
  padding: 0.45rem 0.75rem;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--fg-secondary);
  font-size: var(--text-sm);
}

.mc-next-section-tab.active {
  border-bottom-color: var(--brand);
  color: var(--fg-primary);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/RailGroupTabs.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing sidebar test**

Add to `MissionControlShellChrome.mobile-nav.test.tsx`, using `MobileRailHarness` with `groupedRailItems` that have one group of two items:

```tsx
  it("shows one sidebar entry per page, active when any of its sections is current", async () => {
    await act(async () => {
      root.render(<MobileRailHarness />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]')!.click();
    });
    const links = [...container.querySelectorAll(".mc-next-rail-link")];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector(".mc-next-rail-separator")).toBeNull();
  });
```

For this test, pass `groupedRailItems` with `id: "settings-models"`, `label: "Models"`, and the Providers and Local AI items (the route is `settings/providers`). If `MobileRailHarness` hard-codes its props, add a `groupedRailItems` prop to the harness with the current value as the default.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app/MissionControlShellChrome.mobile-nav.test.tsx`
Expected: FAIL (two links and a separator render).

- [ ] **Step 7: Render one entry per group**

In `ShellRail`, replace the `groupedRailItems.map(…)` body (lines 403-464). A labeled group renders as one page entry. An unlabeled group (an area with no pages in `RAIL_GROUPS`, for example Projects) keeps one entry per item, as it does today:

```tsx
        <div className="mc-next-rail-menu" hidden={route.area === "chat"}>
          <div className="mc-next-rail-group">
            {groupedRailItems.flatMap((group) => {
              const first = group.items[0];
              if (!first) return [];
              const entries = group.label
                ? [{ key: group.id, label: group.label, items: group.items }]
                : group.items.map((item) => ({ key: item.id, label: item.label, items: [item] }));
              return entries.map((entry) => {
                const lead = entry.items[0]!;
                const target = buildNavigationTarget(route, lead);
                const active = entry.items.some((item) => isRailItemActive(route, item));
                const releaseScope = getRouteReleaseScope(target);
                const releaseStatusLabel = describeReleaseSurfaceStatus(releaseScope.status);
                const releaseScopeOperatorSummary = describeReleaseScopeForOperator(releaseScope);
                const backlogCount = entry.items.some((item) => item.section === "approvals")
                  ? pendingApprovals
                  : entry.items.some((item) => item.section === "tasks")
                    ? taskBacklogCount
                    : undefined;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    className={`mc-next-rail-link${active ? " active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    aria-label={`${entry.label}: ${lead.description}`}
                    onFocus={() => preloadRouteChunk(target)}
                    onMouseEnter={() => preloadRouteChunk(target)}
                    onClick={() => {
                      navigate(target);
                      if (isMobileNav) onClose();
                    }}
                  >
                    <div>
                      <strong>
                        {entry.label}
                        {releaseScope.status === "ship" ? null : (
                          <span
                            className="mc-next-rail-release-badge"
                            data-release-status={releaseScope.status}
                            title={releaseScopeOperatorSummary}
                            aria-label={releaseScopeOperatorSummary}
                          >
                            {releaseStatusLabel}
                          </span>
                        )}
                      </strong>
                      <span title={lead.description}>{lead.description}</span>
                    </div>
                    {typeof backlogCount === "number" && backlogCount > 0 ? (
                      <span className="mc-next-rail-count">{backlogCount}</span>
                    ) : null}
                  </button>
                );
              });
            })}
          </div>
        </div>
```

Add a second case to the Step 5 test. Render the harness with an unlabeled group of two items (`{ id: "projects-primary", items: [...] }` on a `projects` route), and expect two `.mc-next-rail-link` entries.

- [ ] **Step 8: Render the tabs in the stage**

Add `sectionTabs?: ReactNode` to `ShellRouteStage`'s props and render it first inside `.mc-next-stage-scroll`:

```tsx
          <div className="mc-next-stage-scroll">
            {sectionTabs}
            <section
```

In `MissionControlNextApp.tsx`, on `<ShellRouteStage` (line 981), add:

```tsx
                sectionTabs={
                  route.area === "chat" ? null : (
                    <RailGroupTabs route={route} sections={groupedRailItems} navigate={navigate} />
                  )
                }
```

Import `RailGroupTabs` from `./RailGroupTabs`.

- [ ] **Step 9: Run the shell suites**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/app`
Expected: PASS after updating assertions that counted rail links or looked for `.mc-next-rail-separator`.

- [ ] **Step 10: Commit**

```bash
git add apps/mission-control-next/src/app/RailGroupTabs.tsx apps/mission-control-next/src/app/RailGroupTabs.test.tsx apps/mission-control-next/src/app/MissionControlShellChrome.tsx apps/mission-control-next/src/app/MissionControlNextApp.tsx apps/mission-control-next/src/styles/mission-control-next.css apps/mission-control-next/src/app/MissionControlShellChrome.mobile-nav.test.tsx
git add $(git diff --name-only -- "apps/mission-control-next/src/app/*.test.tsx")
git commit -m "feat: show one sidebar entry per page with section tabs"
```

---

### Task 3: Browser lanes and docs follow the new navigation

**Files:**
- Modify: the files found by the search in Step 1 (under `scripts/verification`)
- Modify: `docs/LLAMA_CPP_SETUP.md` (line 3)
- Modify: `docs/1_0_RELEASE_SURFACE_SCOPE.md` (lines 66-72)

- [ ] **Step 1: Find the lane dependencies**

Run: `git grep -n "Preferences\|Security\|Workspace & Citadel\|Agents & skills\|Files & outputs\|Monitor\|Decisions\|Automations\|mc-next-rail-separator\|mc-next-rail-group-" -- scripts/verification`

For each hit that clicks or reads a sidebar group label or separator, switch to the new page label. If the lane needs a section that is now a tab, navigate to the page, then click the tab by its section label.

- [ ] **Step 2: Update the docs**

- `docs/LLAMA_CPP_SETUP.md:3`: "Settings → Get started → Set up llama.cpp" becomes "Settings → Models → Get started → Set up llama.cpp".
- `docs/1_0_RELEASE_SURFACE_SCOPE.md:66-72`: replace the stale "Observe group" wording for `/ops/workers` with "the Ops Health page (Remote workers tab)". Do not change any table row. The validator parses rows at line 842.

- [ ] **Step 3: Run the lane unit tests and the docs gate**

Run: `node --test "scripts/verification/**/*.test.mjs"`
Then: `pnpm docs:check`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add docs/LLAMA_CPP_SETUP.md docs/1_0_RELEASE_SURFACE_SCOPE.md
git add $(git diff --name-only -- scripts/verification)
git commit -m "docs: describe the grouped Settings, Library, and Ops pages"
```

---

### Task 4: Four breakpoints

**Files:**
- Create: `scripts/codemods/normalize-mission-control-next-breakpoints.mjs`
- Test: `scripts/codemods/normalize-mission-control-next-breakpoints.test.mjs`
- Create: `scripts/check-mission-control-next-breakpoints.mjs`
- Test: `scripts/check-mission-control-next-breakpoints.test.mjs`
- Modify: every `apps/mission-control-next/src/**/*.css` file with a width media query (the codemod edits them)
- Modify: these media-query string literals:
  - `apps/mission-control-next/src/app/MissionControlNextApp.tsx:407,412`
  - `apps/mission-control-next/src/app/UnifiedSidebar.tsx:30`
  - `apps/mission-control-next/src/components/DetailInspector.tsx:15`
  - `apps/mission-control-next/src/features/threaded-surface/ThreadedBtwSideChatPanel.tsx:47`
  - `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx:320,343`
  - `apps/mission-control-next/src/features/threaded-surface/workflow/CodeWorkbenchPanel.tsx:827`
  - `packages/mission-control-shared/src/components/PageTabs.tsx:26,49`
  - `packages/mission-control-shared/src/components/StatusStrip.tsx:25,61`
  - `packages/mission-control-shared/src/components/SideInspectorDrawer.tsx` (the `SIDE_INSPECTOR_DOCKED_MAX_WIDTH` constant)
- Modify: `apps/mission-control-next/package.json` (`perf:check`); `.github/workflows/code-quality.yml` (next to the typography step, lines 48-49)

**Interfaces:**
- Produces:
  - `CANONICAL_MIN_WIDTHS = [640, 1024, 1280, 1600]`
  - `CANONICAL_MAX_WIDTHS = [639, 1023, 1279, 1599]`
  - `mapMaxWidth(px: number): number`
  - `mapMinWidth(px: number): number`
  - `normalizeMediaPrelude(prelude: string): string`
  - `findBreakpointViolations(filePath: string, contents: string): Array<{ file, line, value }>`

Mapping: each width maps to the nearest canonical value. A `max-width` or `width <` value maps into the maximum family; a `min-width` or `width >=` value maps into the minimum family. `(width < N)` maps its exclusive bound into the minimum family, so `width < 1180` becomes `width < 1280`. Height features stay unchanged. The known narrow-desktop band is a range whose endpoints collapse, so it gets an explicit override.

- [ ] **Step 1: Write the failing mapping tests**

```js
// scripts/codemods/normalize-mission-control-next-breakpoints.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapMaxWidth, mapMinWidth, normalizeMediaPrelude } from "./normalize-mission-control-next-breakpoints.mjs";

describe("breakpoint mapping", () => {
  it("maps max widths to the nearest canonical maximum", () => {
    assert.deepEqual([520, 767, 820, 840, 1100, 1179, 1439, 1680].map(mapMaxWidth), [639, 639, 639, 1023, 1023, 1279, 1279, 1599]);
  });

  it("maps min widths to the nearest canonical minimum", () => {
    assert.deepEqual([560, 900, 1200, 1680].map(mapMinWidth), [640, 1024, 1280, 1600]);
  });

  it("rewrites preludes and leaves height and non-size features alone", () => {
    assert.equal(normalizeMediaPrelude("(max-width: 767px)"), "(max-width: 639px)");
    assert.equal(normalizeMediaPrelude("(width < 1180px)"), "(width < 1280px)");
    assert.equal(
      normalizeMediaPrelude("(max-width: 1680px) and (max-height: 699px), (width < 1180px)"),
      "(max-width: 1599px) and (max-height: 699px), (width < 1280px)",
    );
    assert.equal(normalizeMediaPrelude("(prefers-reduced-motion: reduce)"), "(prefers-reduced-motion: reduce)");
  });

  it("keeps the narrow-desktop band non-empty", () => {
    assert.equal(
      normalizeMediaPrelude("(min-width: 1180px) and (max-width: 1279px)"),
      "(min-width: 1024px) and (max-width: 1279px)",
    );
  });
});
```

```js
// scripts/check-mission-control-next-breakpoints.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findBreakpointViolations } from "./check-mission-control-next-breakpoints.mjs";

describe("findBreakpointViolations", () => {
  it("accepts canonical widths in CSS and TypeScript", () => {
    const css = "@media (max-width: 639px) { a { color: red; } }\n@media (width < 1280px) { b {} }";
    const ts = 'const narrow = useMediaQuery("(max-width: 1023px)");';
    assert.deepEqual(findBreakpointViolations("a.css", css), []);
    assert.deepEqual(findBreakpointViolations("a.tsx", ts), []);
  });

  it("reports other widths with their line", () => {
    const css = "a {}\n@media (max-width: 767px) { a {} }";
    assert.deepEqual(findBreakpointViolations("a.css", css), [{ file: "a.css", line: 2, value: "max-width: 767px" }]);
    assert.equal(findBreakpointViolations("a.ts", 'matchMedia("(min-width: 900px)")').length, 1);
  });

  it("ignores height features", () => {
    assert.deepEqual(findBreakpointViolations("a.css", "@media (max-height: 699px) { a {} }"), []);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/codemods/normalize-mission-control-next-breakpoints.test.mjs scripts/check-mission-control-next-breakpoints.test.mjs`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the codemod**

```js
// scripts/codemods/normalize-mission-control-next-breakpoints.mjs
#!/usr/bin/env node
/*
 * One-shot codemod: rewrite width media queries in apps/mission-control-next
 * CSS to the four canonical breakpoints (spec §10.5). Height features are
 * untouched. Run from the repo root; review the diff before committing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_MIN_WIDTHS = Object.freeze([640, 1024, 1280, 1600]);
export const CANONICAL_MAX_WIDTHS = Object.freeze([639, 1023, 1279, 1599]);

const RANGE_OVERRIDES = new Map([
  ["(min-width: 1180px) and (max-width: 1279px)", "(min-width: 1024px) and (max-width: 1279px)"],
]);

function nearest(values, px) {
  return values.reduce((best, value) => (Math.abs(value - px) < Math.abs(best - px) ? value : best), values[0]);
}

export function mapMaxWidth(px) {
  return nearest(CANONICAL_MAX_WIDTHS, px);
}

export function mapMinWidth(px) {
  return nearest(CANONICAL_MIN_WIDTHS, px);
}

export function normalizeMediaPrelude(prelude) {
  const override = RANGE_OVERRIDES.get(prelude.trim());
  if (override) {
    return override;
  }
  return prelude
    .replace(/\(max-width:\s*(\d+)px\)/g, (_match, px) => `(max-width: ${mapMaxWidth(Number(px))}px)`)
    .replace(/\(min-width:\s*(\d+)px\)/g, (_match, px) => `(min-width: ${mapMinWidth(Number(px))}px)`)
    .replace(/\(width\s*<\s*(\d+)px\)/g, (_match, px) => `(width < ${mapMinWidth(Number(px))}px)`)
    .replace(/\(width\s*>=\s*(\d+)px\)/g, (_match, px) => `(width >= ${mapMinWidth(Number(px))}px)`);
}

async function listCssFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listCssFiles(full);
      return entry.name.endsWith(".css") ? [full] : [];
    }),
  );
  return nested.flat();
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = await listCssFiles(path.join(repoRoot, "apps", "mission-control-next", "src"));
  let changed = 0;
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const next = source.replace(/@media([^{]+)\{/g, (_match, prelude) => `@media ${normalizeMediaPrelude(prelude.trim())} {`);
    if (next !== source) {
      await fs.writeFile(file, next);
      changed += 1;
    }
  }
  console.log(`normalized breakpoints in ${changed} file(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
```

- [ ] **Step 4: Implement the check**

```js
// scripts/check-mission-control-next-breakpoints.mjs
#!/usr/bin/env node
/*
 * Breakpoint guard for apps/mission-control-next (spec §10.5). Width media
 * features may only use 640/1024/1280/1600 (min, width <, width >=) or
 * 639/1023/1279/1599 (max). Scans CSS and media-query string literals in
 * TypeScript. Height features are ignored.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = [
  path.join(repoRoot, "apps", "mission-control-next", "src"),
  path.join(repoRoot, "packages", "mission-control-shared", "src"),
];
const MIN_ALLOWED = new Set([640, 1024, 1280, 1600]);
const MAX_ALLOWED = new Set([639, 1023, 1279, 1599]);
const FEATURE_RE = /\((max-width|min-width):\s*(\d+)px\)|\(width\s*(<|>=)\s*(\d+)px\)/g;

export function findBreakpointViolations(filePath, contents) {
  const isScript = /\.(ts|tsx)$/.test(filePath);
  const violations = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    if (isScript && !/(useMediaQuery|matchMedia)\(/.test(line)) {
      return;
    }
    if (!isScript && !line.includes("@media")) {
      return;
    }
    for (const match of line.matchAll(FEATURE_RE)) {
      const [, feature, featurePx, operator, operatorPx] = match;
      const px = Number(featurePx ?? operatorPx);
      const allowed = feature === "max-width" ? MAX_ALLOWED : MIN_ALLOWED;
      if (!allowed.has(px)) {
        violations.push({
          file: filePath,
          line: index + 1,
          value: feature ? `${feature}: ${px}px` : `width ${operator} ${px}px`,
        });
      }
    }
  });
  return violations;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : walk(full);
      return /\.(css|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    }),
  );
  return nested.flat();
}

async function main() {
  const files = (await Promise.all(SCAN_ROOTS.map(walk))).flat();
  const violations = [];
  for (const file of files) {
    violations.push(...findBreakpointViolations(file, await fs.readFile(file, "utf8")));
  }
  if (violations.length > 0) {
    console.error("[breakpoints] non-canonical width breakpoints:");
    for (const violation of violations) {
      console.error(`- ${path.relative(repoRoot, violation.file)}:${violation.line} -> ${violation.value}`);
    }
    process.exit(1);
  }
  console.log(`[breakpoints] ${files.length} files use only canonical breakpoints`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `node --test scripts/codemods/normalize-mission-control-next-breakpoints.test.mjs scripts/check-mission-control-next-breakpoints.test.mjs`
Expected: PASS.

- [ ] **Step 6: Apply the codemod and fix the TypeScript literals by hand**

Run: `node scripts/codemods/normalize-mission-control-next-breakpoints.mjs`

Then change each TypeScript media literal listed under **Files** with the same mapping:

| Old query | New query |
| --- | --- |
| `(max-width: 1439px)` | `(max-width: 1279px)` |
| `(max-width: 1179px)` | `(max-width: 1279px)` |
| `(min-width: 1180px) and (max-width: 1279px)` | `(min-width: 1024px) and (max-width: 1279px)` |
| `(max-width: 840px)` | `(max-width: 1023px)` |
| `(width < 1180px)` | `(width < 1280px)` |
| `(max-width: 767px)` | `(max-width: 639px)` |

Also update the query at `ThreadedSurfacePage.tsx:343` with the same mapping. Set `SIDE_INSPECTOR_DOCKED_MAX_WIDTH` to the canonical maximum nearest its current value.

Update the tests that mock exact query strings. For example, `ThreadedSurfacePage.test.tsx` mocks `useMediaQuery` keyed on `"(width < 1180px)"`; change it to `"(width < 1280px)"`. Find them all with `git grep -n "1180px\|1179px\|767px\|840px\|1439px" -- "apps/mission-control-next/src/**/*.test.*" "packages/*/src/**/*.test.*"`.

Run: `node scripts/check-mission-control-next-breakpoints.mjs`
Expected: `[breakpoints] … files use only canonical breakpoints`.

- [ ] **Step 7: Wire the check into `perf:check` and CI**

In `apps/mission-control-next/package.json`, insert `node ../../scripts/check-mission-control-next-breakpoints.mjs && ` directly after the typography check inside `perf:check`.

In `.github/workflows/code-quality.yml`, after the typography step's two commands (lines 48-49), add:

```yaml
          node --test scripts/check-mission-control-next-breakpoints.test.mjs
          node scripts/check-mission-control-next-breakpoints.mjs
```

- [ ] **Step 8: Run the suites and the UX lane**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src`
Then: `pnpm verify:ux:budgets`
Expected: PASS. If the Chat budget regresses at 1440 or 390, it is a mapped rule that now applies where it didn't before. Find it by diffing the codemod's changes for the Chat stylesheets, and adjust that rule's content rather than the breakpoint.

- [ ] **Step 9: Commit**

```bash
git add scripts/codemods/normalize-mission-control-next-breakpoints.mjs scripts/codemods/normalize-mission-control-next-breakpoints.test.mjs scripts/check-mission-control-next-breakpoints.mjs scripts/check-mission-control-next-breakpoints.test.mjs apps/mission-control-next/package.json .github/workflows/code-quality.yml
git add $(git diff --name-only -- apps/mission-control-next/src packages/mission-control-shared/src)
git commit -m "refactor: reduce Mission Control to four breakpoints and gate them"
```

---

### Task 5: Fold one-off heading sizes into tokens

**Files:**
- Modify: `scripts/check-mission-control-next-typography.mjs`
- Modify: `scripts/check-mission-control-next-typography.test.mjs`
- Modify: these eight `clamp()` sites:

| Site | Current value | Replacement |
| --- | --- | --- |
| `apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css:173` | `clamp(1.05rem, 1.45vw, 1.4rem)` | `var(--text-xl)` |
| `apps/mission-control-next/src/features/native-routes/styles/07-settings-library.css:1231` | `clamp(1.25rem, 2.4vw, 2rem)` | `var(--text-2xl)` |
| `apps/mission-control-next/src/features/native-routes/styles/09-legacy-compatibility.css:306` | `clamp(1.02rem, 1.45vw, 1.24rem)` | `var(--text-lg)` |
| `apps/mission-control-next/src/features/native-routes/styles/09-legacy-compatibility.css:319` | `clamp(0.82rem, 1.1vw, 1rem)` | `var(--text-md)` |
| `apps/mission-control-next/src/features/native-routes/styles/13-chat-alignment.css:59` | `clamp(1.22rem, 1.1rem + 0.45vw, 1.65rem)` | `var(--text-xl)` |
| `apps/mission-control-next/src/features/prompt-packs/prompt-packs-workbench.css:87` | `clamp(1.05rem, 1.45vw, 1.4rem)` | `var(--text-xl)` |
| `apps/mission-control-next/src/features/threaded-surface/styles/rail.css:189` | `clamp(1.2rem, 1.8vw, 1.55rem)` | `var(--text-xl)` |
| `apps/mission-control-next/src/styles/mission-control-next.css:1932` | `clamp(1.55rem, 3vw, 2rem)` | `var(--text-2xl)` |

- Modify: every CSS file that declares a `var(--text-*, <literal>)` fallback. Find them with `git grep -nE "var\(--text-[a-z0-9]+," -- apps/mission-control-next/src`.

**Interfaces:**
- Changes `findTypographyViolations(filePath, contents)`: a `clamp()` value is allowed only when `filePath` ends with `mission-control-next-tokens.css`, and a `var(--text-*, <literal>)` fallback is always a violation.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/check-mission-control-next-typography.test.mjs`:

```js
test("allows clamp() only in the tokens file", () => {
  const css = "h1 { font-size: clamp(1rem, 2vw, 2rem); }";
  assert.equal(findTypographyViolations("src/styles/mission-control-next-tokens.css", css).length, 0);
  assert.equal(findTypographyViolations("src/features/x.css", css).length, 1);
});

test("rejects literal fallbacks inside text tokens", () => {
  assert.equal(findTypographyViolations("src/features/x.css", "p { font-size: var(--text-xs, 0.75rem); }").length, 1);
  assert.equal(findTypographyViolations("src/features/x.css", "p { font-size: var(--text-xs); }").length, 0);
});
```

Use the file's existing test style. If it uses `describe`/`it`, wrap these in the same form.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/check-mission-control-next-typography.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `check-mission-control-next-typography.mjs`, give `valueIsHardcoded` the file path and apply both rules:

```js
function valueIsHardcoded(rawValue, filePath) {
  const value = rawValue.trim().replace(/!important\s*$/i, "").trim();
  if (value === "0" || value === "inherit" || value === "initial" || value === "unset") {
    return false;
  }
  if (/var\(--text-[a-z0-9-]+\s*,/.test(value)) {
    return true;
  }
  if (/var\(--text-/.test(value)) {
    return false;
  }
  if (/\bclamp\(/.test(value)) {
    return !filePath.replace(/\\/g, "/").endsWith("mission-control-next-tokens.css");
  }
  return LENGTH_RE.test(stripVars(value));
}
```

Update the call inside `findTypographyViolations` to `valueIsHardcoded(valueMatch[1], filePath)`.

Replace each `clamp()` site as listed in the table under **Files**.

Remove every literal fallback, so `var(--text-xs, 0.8125rem)` becomes `var(--text-xs)`. Replace `var(--type-small)` with `var(--text-xs)` after confirming with `git grep -n -- "--type-small:" -- apps packages` that no file defines it.

- [ ] **Step 4: Run the check and its tests**

Run: `node --test scripts/check-mission-control-next-typography.test.mjs`
Then: `pnpm --filter @goatcitadel/mission-control-next typography:check`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-mission-control-next-typography.mjs scripts/check-mission-control-next-typography.test.mjs
git add $(git diff --name-only -- apps/mission-control-next/src)
git commit -m "refactor: fold one-off heading sizes into type tokens and tighten the gate"
```

---

### Task 6: Split the Chat controller host

**Files:**
- Create: `packages/threaded-surface-core/src/chat/hydrated-storage.ts` (move host lines 270-740)
- Create: `packages/threaded-surface-core/src/chat/useChatTimerPanel.ts` (move host lines 1126-1137, 1446-1530, and 5071-5085)
- Create: `packages/threaded-surface-core/src/chat/useRunVariablePanel.ts` (move host lines 1138-1149, 1371-1386, 4400-4422, and 5086-5099)
- Create: `packages/threaded-surface-core/src/chat/useChatChangePlans.ts` (move host lines 1150-1173, 1398-1444, 3595-4132, 5678-5706, and 6130-6229)
- Test: `packages/threaded-surface-core/src/chat/useChatTimerPanel.test.tsx`, `packages/threaded-surface-core/src/chat/useRunVariablePanel.test.tsx`
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`

**Interfaces:**
- Produces, re-exported from the host so existing imports keep working:
  - `parseHydratedChatAttachments`, `parseHydratedOutboundQueue`, `mergeHydratedOutboundQueue`
  - `useChatTimerPanel(input: { sessionId: string | null; enabled: boolean })`, which returns the timer panel props and the open and refresh callbacks exactly as the host computed them
  - `useRunVariablePanel(input: { draft: string; composerRef })`, which returns the panel props, `openForm`, and `capture`
  - `useChatChangePlans(input)`, which returns `{ chatChangePlans, changePlanReceipt, changePlanDialogProps, requestThreadModelPatch, admitChangePlan }`

Line ranges come from `origin/main` on 2026-09-27; confirm them before moving. The target after this task is under 5,000 lines for the host, down from 6,229.

Order is lowest risk first. Run the full host suite after every step.

- [ ] **Step 1: Move the pure storage parsers**

1. Move lines 270-740 (the three parsers and their private helpers) into `chat/hydrated-storage.ts` unchanged, exporting the three public functions.
2. In the host, delete the moved code and add:

```ts
import {
  mergeHydratedOutboundQueue,
  parseHydratedChatAttachments,
  parseHydratedOutboundQueue,
} from "./chat/hydrated-storage";

export { mergeHydratedOutboundQueue, parseHydratedChatAttachments, parseHydratedOutboundQueue };
```

Run: `pnpm --filter @goatcitadel/threaded-surface-core exec vitest run src/MissionThreadedControllerHost.test.tsx src/MissionThreadedControllerHost.loop23-branch-tail.test.tsx src/MissionThreadedControllerHost.loop30-branch-tail.test.tsx src/index.test.ts`
Expected: PASS unchanged.

Commit: `git add packages/threaded-surface-core/src/chat/hydrated-storage.ts packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx && git commit -m "refactor: move hydrated chat storage parsers out of the controller host"`

- [ ] **Step 2: Extract `useChatTimerPanel` test-first**

1. Write `useChatTimerPanel.test.tsx` (happy-dom, `react-dom/client` harness like `use-shell-notifications.policy.test.tsx`). It asserts that with `enabled: false` the hook returns a closed panel without fetching, and that `open()` makes the panel open.
2. Run it and confirm it fails.
3. Move the timer state and effects (host lines 1126-1137 and 1446-1530) and the props assembly (5071-5085) into the hook unchanged.
4. Call the hook from the host at the old state position.

Run the new test, then the full host suite from Step 1. Expected: PASS. Commit.

- [ ] **Step 3: Extract `useRunVariablePanel` the same way**

Its test asserts that `openForm(template)` opens the panel with the template's inputs, and `capture()` returns the typed values. Move lines 1138-1149, 1371-1386, 4400-4422, and 5086-5099. Run the new test and the host suite. Commit.

- [ ] **Step 4: Extract `useChatChangePlans`**

This includes the Phase 0b visibility rule and persisted dismissals.

1. Move the change-plan state, the fetch and realtime effect, the actions (including the OAuth polling effect at around 4030), the receipt selection, and the helper functions at 6130-6229 into the hook.
2. The hook takes, as one input object:
   - `selectedSessionId`
   - `prefs`, `prefsRef`, `setPrefs`
   - the current provider and model
   - `setUiError`, `pushLocalNotice`, `onOpenApprovals`
   - `thread`
3. In the host, keep the forward refs listed in the research (`executeOutboundItemRef`, `pushLocalNoticeRef`, `applyFetchedThreadRef`, and so on) and the order-sensitive render-time writes where they are.
4. Pass `pushLocalNoticeRef.current` through a stable callback rather than moving the ref.

Run the host suite. The dismissal tests at `MissionThreadedControllerHost.test.tsx:2121-2206` must pass unchanged. Commit.

- [ ] **Step 5: Confirm the size**

Run: `wc -l packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`
Expected: under 5,000. The remaining seams (send pipeline, presets and palette, documents, knowledge attachments) move in Phase 2, where the cockpit Chat consumes them.

---

### Task 7: Split the Ops runtime page

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/ops/runtime/ops-runtime-derivations.ts`, `ops-format.ts`, and `ops-cost.ts` (move the exported builders, formatters, and cost readers from `RuntimeRoutePage.tsx` lines 3381-4175)
- Create: `apps/mission-control-next/src/features/native-routes/ops/runtime/OpsActivitySection.tsx` (lines 2102-2198), `OpsNotificationsSection.tsx` (lines 1995-2101), and `OpsDiagnosticsSection.tsx` (lines 1855-1994)
- Modify: `apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.tsx`

**Interfaces:**
- Produces:
  - `RuntimeRoutePage.tsx` re-exports every helper its test file imports, so `RuntimeRoutePage.test.tsx` passes unchanged.
  - Section components receive what they read as props: `data`, `runtime`, `supportPanel`, `openInspection`, `needsAttentionItems`, `readNotifications`, and the page's single `useDraftLeave` instance where needed.

- [ ] **Step 1: Move the exported helpers**

Move lines 3381-4175 into the three modules, grouped by purpose: derivations (attention, health, efficiency), formatting, and cost readers. In `RuntimeRoutePage.tsx`, import what the page uses and add `export { … } from "./runtime/ops-format";` (and the same for the other two modules) for every symbol the test imports.

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/ops`
Expected: PASS unchanged. Commit.

- [ ] **Step 2: Move the three sections**

Move each section's JSX and its local state into its component, passing shared state as props. The section switch and page shell stay in `RuntimeRoutePage`. Run the Ops suites after each section. Commit after each.

- [ ] **Step 3: Confirm the size**

Run: `wc -l apps/mission-control-next/src/features/native-routes/ops/RuntimeRoutePage.tsx`
Expected: under 3,000.

---

### Task 8: Split the Settings page helpers and Providers

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/settings/helpers/` with one module per range of `SettingsNativePage.tsx` on `origin/main`:

| Module | Lines |
| --- | --- |
| `providers.ts` | 248-680 |
| `access.ts` | 681-905 |
| `onboarding.ts` | 906-1340 |
| `labels.ts` | 1342-1451 |
| `connections.ts` | 1452-1668 |
| `personalities.ts` | 1669-1764 |

- Create: `apps/mission-control-next/src/features/native-routes/settings/sections/providers/` with `provider-format.ts` (`ProvidersSection.tsx` lines 2517-2597) and one component per inspector:

| Component | Starts at line |
| --- | --- |
| `ProviderRoutingInspector.tsx` | 1353 |
| `ProviderModelsInspector.tsx` | 1509 |
| `ProviderAdviceInspector.tsx` | 1591 |
| `ProviderOAuthInspector.tsx` | 1647 |
| `ProviderConnectionInspector.tsx` | 1829 |
| `ProviderEditorInspector.tsx` | 2149 |

- Modify: `SettingsNativePage.tsx`, `ProvidersSection.tsx`

**Interfaces:**
- Produces: `SettingsNativePage.tsx` re-exports every moved helper, so `SettingsNativePage.test.tsx`, `.coverage.test.tsx`, `.helpers.test.ts`, `.loop30.test.ts`, `provider-save-contract.test.ts`, and the partial mock in `ChannelSetupWizard.test.tsx:75` keep working. ChannelsSection keeps importing from `SettingsNativePage`.

- [ ] **Step 1: Move the helpers**

Move one range at a time. After each range, add the re-export to `SettingsNativePage.tsx` and run `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/SettingsNativePage.test.tsx src/features/native-routes/SettingsNativePage.helpers.test.ts src/features/native-routes/settings`. Expected: PASS unchanged. Commit after each range.

- [ ] **Step 2: Move the Providers format helpers and inspectors**

Move `provider-format.ts` first, then one inspector per commit. Each inspector receives the state it reads as props; the editor state and the single `useDraftLeave` stay in `ProvidersSection`. After each move, run the same command as Step 1. Expected: PASS unchanged.

- [ ] **Step 3: Confirm the sizes**

Run: `wc -l apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx apps/mission-control-next/src/features/native-routes/settings/sections/ProvidersSection.tsx`
Expected: under 400 and under 1,500 respectively.

---

### Task 9: Split the Chat surface page

**Files:**
- Create in `apps/mission-control-next/src/features/threaded-surface/surface/`:

| New file | Moved from `ThreadedSurfacePage.tsx` lines |
| --- | --- |
| `ThreadedSessionList.tsx` | 2361-2688 |
| `ThreadEmptyState.tsx` | 2277-2359 |
| `usePaneResize.tsx` | 1421-1581 |
| `UtilityWorkbenchCards.tsx` | 2044-2275 |
| `UtilityWorkRecord.tsx` | 1762-2042 |

- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx`

**Interfaces:**
- Produces: `ThreadedSurfacePage.tsx` keeps its 20 CSS side-effect imports (lines 63-82) and re-exports any helper its tests import. The test's mocks of `./ChatOptionsPopover`, `./ThreadedWorkflowPanel`, and `./ThreadedContextDrawer` keep resolving because moved code imports those same modules.

- [ ] **Step 1: Move one component per commit**

Move in the order listed in the table. After each move, run `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface`. Expected: PASS unchanged.

- [ ] **Step 2: Confirm the size**

Run: `wc -l apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx`
Expected: under 1,800.

---

### Task 10: Split the composer (operator decision required first)

`ThreadedComposer.tsx` line 1 says the C3 closure packet forbids splitting it. The packet it cites (`docs/review/HX_407_CLOSURE_PACKET_2026-07-14.md:50-73`) lists the composer as a C3 owner but contains no text that prohibits a split.

- [ ] **Step 1: Get the operator's decision in writing** (a PR comment or chat message) before touching the file.
- [ ] **Step 2: Only if the operator approves the split**, make these moves:

| New file | Moved from `ThreadedComposer.tsx` lines |
| --- | --- |
| `ExternalSourceStrip.tsx` | 398-755 |
| `ComposerPrompts.tsx` | 260-396 |
| `composer-helpers.ts` | 28-258 |
| `ComposerCommandPalette.tsx` | 757-919 and 1477-1574 |

Put them under `apps/mission-control-next/src/features/threaded-surface/composer/`. Follow the same rules as Task 9, and update the line-1 comment to cite the approval. After each move, run `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface`. Expected: PASS unchanged.
- [ ] **Step 3: If the operator declines**, record that in the PR description and leave the file as it is.

---

### Task 11: Phase exit

- [ ] **Step 1: Run the gates**

Run, one at a time:
- `pnpm verify:ux:budgets`
- `node scripts/check-mission-control-next-breakpoints.mjs`
- `pnpm --filter @goatcitadel/mission-control-next typography:check`
- `pnpm docs:check`
- `pnpm --filter @goatcitadel/mission-control-next build`, then `pnpm --filter @goatcitadel/mission-control-next perf:check`

Expected: all exit 0. `perf:check` also runs the dist-size budgets; splits must not change chunk names.

- [ ] **Step 2: Rebaseline**

Breakpoints and the sidebar changed everywhere, so rebaseline through the workflow for all 8 variants:

```bash
gh workflow run visual-rebaseline.yml --ref ux/phase-0d
```

Then cherry-pick the pushed `chore/visual-rebaseline-<runid>` commit and delete that branch. Review by eye:
- the `laptop-dark` Chat and Settings PNGs (the 1280px top bar is no longer compact)
- the `desktop-narrow-dark` PNGs (1179px keeps the mobile navigation)

- [ ] **Step 3: Phase validation, push, and PR**

Run the roadmap's per-phase validation list, then:

```bash
# First write the PR description (what changed, lane results before and after, anything left for the next phase) to "${TMPDIR:-/tmp}/ux-phase-0d-pr.md".
git push -u origin ux/phase-0d
gh pr create --title "UX phase 0d: page tabs, four breakpoints, type tokens, oversized files split" --body-file "${TMPDIR:-/tmp}/ux-phase-0d-pr.md"
```
