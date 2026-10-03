# Phase 1 — Cockpit Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new "cockpit" shell next to the classic one, behind a local preference. This phase builds:

- a Tailwind v4 theme and tokens
- primitive components
- a TanStack Query data layer with a realtime bridge
- the router, sidebar, command palette, inspector host, and phone tab bar
- a component gallery

The five areas themselves stay placeholders until later phases fill them.

**Architecture:**
- `main.tsx` picks the shell at boot from `goatcitadel.ui.shell.v1`, or from a `?shell=` override. It then dynamically imports `classic-entry.tsx` or `cockpit-entry.tsx`, so the two CSS sets never load together.
- Cockpit code lives in `apps/mission-control-next/src/cockpit/`.
- The cockpit reuses from earlier phases:
  - the gateway access hook
  - the API client and the event stream
  - the notification policy and the status vocabulary
  - the UI preferences

**Tech Stack:** React 19, TypeScript, Vite with `@tailwindcss/vite` 4.2.2 (already registered), Tailwind v4, `radix-ui` 1.4.3, `cmdk`, `vaul`, `sonner`, `lucide-react`, `clsx`, `tailwind-merge`, and `@tanstack/react-query` 5.x (the only new dependency; 5.104.0 was current on 2026-09-28). Tests use vitest with happy-dom and react-test-renderer.

**Spec:** [`docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`](../specs/2026-09-27-mission-control-cockpit-design.md) §6, §10, §12, §14.

## Global Constraints

- Everything in the roadmap's Global Constraints applies ([roadmap](./2026-09-27-mission-control-cockpit-roadmap.md#global-constraints)).
- **Branch:** `ux/phase-1`, in worktree `../personal-ai-phase-1`, from the latest `origin/main`, after Phase 0a has merged.
- **Overlap with other phases:** Phases 0b–0d can land before or after this one. This phase touches none of their files except `main.tsx` and `GeneralSection.tsx`.
- **Tailwind isolation:**
  - `@import "tailwindcss"` appears only in `apps/mission-control-next/src/cockpit/styles/cockpit.css`. A test in Task 2 enforces this.
  - Cockpit code never imports classic CSS, and nothing outside `cockpit/` imports cockpit CSS.
- **Cockpit styling:** use theme utilities only, with no arbitrary values (the Task 3 check). A value the theme lacks goes in a named class in `cockpit.css`.
- **Cockpit files:** at most 400 lines each (the Task 3 ESLint override). Components use named exports.
- **Copy:** follows spec §10.6. Status words come from `status-vocabulary.ts` and errors go through `describeApiError`.
- **Bundle budgets:** `scripts/check-mission-control-next-budgets.mjs` must keep passing. The classic app moves behind a dynamic import, so its CSS and JS stop counting as "initial". Change the budget script only if it matches specific chunk names that the split renames.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `apps/mission-control-next/src/shell-preference.ts` | create | Read, write, and switch the shell preference |
| `apps/mission-control-next/src/shell-preference.test.ts` | create | Tests |
| `apps/mission-control-next/src/main.tsx` | modify | Boot: visual-regression flags, service-worker cleanup, pick an entry |
| `apps/mission-control-next/src/classic-entry.tsx` | create | Today's CSS imports and render |
| `apps/mission-control-next/src/cockpit-entry.tsx` | create | Cockpit CSS and render |
| `apps/mission-control-next/src/cockpit/styles/cockpit.css` | create | Tailwind entry, tokens, variants |
| `apps/mission-control-next/src/cockpit/styles/tailwind-isolation.test.ts` | create | Only `cockpit.css` imports Tailwind |
| `scripts/check-mission-control-next-cockpit-classes.mjs` | create | No arbitrary Tailwind values in cockpit code |
| `scripts/check-mission-control-next-cockpit-classes.test.mjs` | create | Tests |
| `eslint.config.mjs` | modify | `max-lines` 400 for `cockpit/**` |
| `apps/mission-control-next/package.json` | modify | Add `@tanstack/react-query`; `perf:check` runs the class check |
| `apps/mission-control-next/src/cockpit/lib/cn.ts` | create | Class merge helper |
| `apps/mission-control-next/src/cockpit/ui/*.tsx` | create | Primitives (listed in Task 4) |
| `apps/mission-control-next/src/cockpit/data/query-client.ts` | create | `QueryClient` defaults |
| `apps/mission-control-next/src/cockpit/data/query-keys.ts` | create | Query keys that start with a refresh topic |
| `apps/mission-control-next/src/cockpit/data/realtime.ts` | create | Event stream to query invalidation and toasts |
| `apps/mission-control-next/src/cockpit/app/routes.ts` | create | Parse and build cockpit paths |
| `apps/mission-control-next/src/cockpit/app/use-cockpit-route.ts` | create | Location store and navigate |
| `apps/mission-control-next/src/cockpit/app/inspector.tsx` | create | Inspector context and panel |
| `apps/mission-control-next/src/cockpit/app/Sidebar.tsx` | create | Scope, search, areas, health, account menu |
| `apps/mission-control-next/src/cockpit/app/MobileTabBar.tsx` | create | Phone tabs |
| `apps/mission-control-next/src/cockpit/app/CommandPalette.tsx` | create | Ctrl+K |
| `apps/mission-control-next/src/cockpit/app/AreaPlaceholder.tsx` | create | Placeholder with "Open in classic view" |
| `apps/mission-control-next/src/cockpit/app/CockpitAccessGate.tsx` | create | Gateway access states |
| `apps/mission-control-next/src/cockpit/app/CockpitShell.tsx` | create | Layout |
| `apps/mission-control-next/src/cockpit/app/CockpitApp.tsx` | create | Providers and gate |
| `apps/mission-control-next/src/cockpit/app/Gallery.tsx` | create | Every primitive in every state |
| `apps/mission-control-next/src/features/native-routes/settings/sections/GeneralSection.tsx` | modify | "Try the new Mission Control" control |
| `scripts/verification/lib/scenarios/ux-budgets-lane.mjs` | modify | Cockpit scenarios |

---

### Task 1: Shell preference and entry split

**Files:**
- Create: `apps/mission-control-next/src/shell-preference.ts`
- Test: `apps/mission-control-next/src/shell-preference.test.ts`
- Create: `apps/mission-control-next/src/classic-entry.tsx`
- Create: `apps/mission-control-next/src/cockpit-entry.tsx`. It renders a minimal root until Task 7.
- Modify: `apps/mission-control-next/src/main.tsx`

**Interfaces:**
- Produces:
  - `SHELL_PREFERENCE_KEY = "goatcitadel.ui.shell.v1"`
  - `type ShellPreference = "classic" | "cockpit"`
  - `resolveShellPreference(input: { search: string; storage: Pick<Storage, "getItem" | "setItem"> | null }): ShellPreference`
  - `writeShellPreference(value: ShellPreference, storage?: Pick<Storage, "setItem"> | null): void`
  - `switchShell(value: ShellPreference): void`, which writes the preference and reloads the current URL without the `shell` parameter

- [ ] **Step 1: Write the failing tests**

```ts
// apps/mission-control-next/src/shell-preference.test.ts
import { describe, expect, it } from "vitest";
import { SHELL_PREFERENCE_KEY, resolveShellPreference, writeShellPreference } from "./shell-preference";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

describe("shell preference", () => {
  it("defaults to the classic shell", () => {
    expect(resolveShellPreference({ search: "", storage: memoryStorage() })).toBe("classic");
    expect(resolveShellPreference({ search: "", storage: null })).toBe("classic");
  });

  it("reads the stored preference and ignores unknown values", () => {
    expect(resolveShellPreference({ search: "", storage: memoryStorage({ [SHELL_PREFERENCE_KEY]: "cockpit" }) })).toBe("cockpit");
    expect(resolveShellPreference({ search: "", storage: memoryStorage({ [SHELL_PREFERENCE_KEY]: "neon" }) })).toBe("classic");
  });

  it("lets ?shell= override and persist the choice", () => {
    const storage = memoryStorage();
    expect(resolveShellPreference({ search: "?shell=cockpit", storage })).toBe("cockpit");
    expect(storage.items.get(SHELL_PREFERENCE_KEY)).toBe("cockpit");
  });

  it("writes through storage", () => {
    const storage = memoryStorage();
    writeShellPreference("cockpit", storage);
    expect(storage.items.get(SHELL_PREFERENCE_KEY)).toBe("cockpit");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/shell-preference.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the preference module**

```ts
// apps/mission-control-next/src/shell-preference.ts
/*
 * Which Mission Control shell renders. Chosen at boot, before any CSS loads,
 * so the classic stylesheet and the cockpit's Tailwind stylesheet never mix.
 * This is a local presentation preference, like the theme; it carries no
 * runtime authority.
 */
export const SHELL_PREFERENCE_KEY = "goatcitadel.ui.shell.v1";
export type ShellPreference = "classic" | "cockpit";

function parse(value: string | null | undefined): ShellPreference | null {
  return value === "classic" || value === "cockpit" ? value : null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function writeShellPreference(
  value: ShellPreference,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(SHELL_PREFERENCE_KEY, value);
  } catch {
    // Storage can be disabled; the choice then lasts for this page only.
  }
}

export function resolveShellPreference(input: {
  search: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}): ShellPreference {
  const override = parse(new URLSearchParams(input.search).get("shell"));
  if (override) {
    writeShellPreference(override, input.storage);
    return override;
  }
  try {
    return parse(input.storage?.getItem(SHELL_PREFERENCE_KEY)) ?? "classic";
  } catch {
    return "classic";
  }
}

export function switchShell(value: ShellPreference): void {
  writeShellPreference(value);
  const url = new URL(window.location.href);
  url.searchParams.delete("shell");
  window.location.assign(url.toString());
}
```

- [ ] **Step 4: Split the entry**

```tsx
// apps/mission-control-next/src/classic-entry.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { MissionControlNextApp } from "@next/app/MissionControlNextApp";
import "@next/styles/mission-control-next-tokens.css";
import "@next/styles/mission-control-next-foundation.css";
import "@next/styles/mission-control-next-theme-bridge.css";
import "@next/styles/mission-control-next.css";
import "@next/features/native-routes/primitives/primitives.css";

export function mountClassic(root: HTMLElement): void {
  createRoot(root).render(
    <React.StrictMode>
      <UiPreferencesProvider>
        <MissionControlNextApp />
      </UiPreferencesProvider>
    </React.StrictMode>,
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit-entry.tsx (Task 7 replaces the render)
import React from "react";
import { createRoot } from "react-dom/client";
import "@next/cockpit/styles/cockpit.css";

export function mountCockpit(root: HTMLElement): void {
  createRoot(root).render(
    <React.StrictMode>
      <main data-cockpit-ready="false">GoatCitadel cockpit</main>
    </React.StrictMode>,
  );
}
```

```tsx
// apps/mission-control-next/src/main.tsx
import { retireMissionControlServiceWorkers } from "./service-worker-cleanup";
import { resolveShellPreference } from "./shell-preference";

const visualRegressionMode =
  (import.meta.env.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE as string | undefined)?.trim().toLowerCase() === "true";

if (visualRegressionMode) {
  document.documentElement.dataset.visualRegression = "true";
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  if (params.get("vr-blocked") === "1") {
    document.documentElement.dataset.visualRegressionShowBlocked = "true";
  }
}

void retireMissionControlServiceWorkers();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}

const shell = resolveShellPreference({ search: globalThis.location?.search ?? "", storage });
document.documentElement.dataset.shell = shell;

if (shell === "cockpit") {
  void import("./cockpit-entry").then(({ mountCockpit }) => mountCockpit(root));
} else {
  void import("./classic-entry").then(({ mountClassic }) => mountClassic(root));
}
```

Create `apps/mission-control-next/src/cockpit/styles/cockpit.css` containing only `@import "tailwindcss";`. Task 2 fills it in.

- [ ] **Step 5: Run the tests, including the entry test**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/shell-preference.test.ts src/main.coverage.test.tsx`
Expected: PASS.

If `main.coverage.test.tsx` asserts that `MissionControlNextApp` renders synchronously, rewrite it to mock `./classic-entry` and `./cockpit-entry`, await the dynamic import, and assert two things:
- `mountClassic` is called with the root element when no preference is stored.
- `mountCockpit` is called when the URL has `?shell=cockpit`.

- [ ] **Step 6: Build and check the budgets**

Run: `pnpm --filter @goatcitadel/mission-control-next build`
Then: `pnpm --filter @goatcitadel/mission-control-next perf:check`
Expected: exit 0. If the budget script fails because it expects a chunk name that now sits inside the `classic-entry` chunk, widen its matcher to include `classic-entry-*` and say so in the commit message.

- [ ] **Step 7: Commit**

```bash
git add apps/mission-control-next/src/shell-preference.ts apps/mission-control-next/src/shell-preference.test.ts apps/mission-control-next/src/main.tsx apps/mission-control-next/src/classic-entry.tsx apps/mission-control-next/src/cockpit-entry.tsx apps/mission-control-next/src/cockpit/styles/cockpit.css
git add $(git diff --name-only -- apps/mission-control-next/src/main.coverage.test.tsx scripts/check-mission-control-next-budgets.mjs)
git commit -m "feat: choose the Mission Control shell at boot from a local preference"
```

---

### Task 2: Cockpit theme and Tailwind isolation

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/styles/cockpit.css`
- Test: `apps/mission-control-next/src/cockpit/styles/tailwind-isolation.test.ts`

**Interfaces:**
- Produces utilities:
  - Colors: `bg-canvas`, `bg-raised`, `bg-sunken`, and `bg-overlay`; `text-fg`, `text-fg-secondary`, and `text-fg-muted`; `border-line-subtle`, `border-line`, and `border-line-strong`; `bg-accent` and `text-accent-ink`.
  - Status colors: `text-status-running`, `text-status-waiting`, `text-status-done`, `text-status-failed`, and `text-status-neutral`, with `bg-` and `border-` variants and opacity modifiers.
  - Type sizes: `text-xs` (12), `text-sm` (13), `text-base` (14), `text-md` (16), `text-lg` (20), `text-xl` (24), `text-2xl` (32).
  - Fonts: `font-sans`, `font-display`, `font-mono`.
  - Radii: `rounded-sm` (6px), `rounded-md` (8px), `rounded-lg` (12px), `rounded-full`.
  - Breakpoints: `sm` 640, `md` 1024, `lg` 1280, `xl` 1600.
  - Custom variants: `dark:` (under `[data-theme="dark"]`) and `compact:` (under `[data-density="compact"]`, which also scales `--spacing`).
  - Other: `animate-pulse-live`, `shadow-overlay`, and the class `cockpit-sheet`.

- [ ] **Step 1: Write the failing isolation test**

```ts
// apps/mission-control-next/src/cockpit/styles/tailwind-isolation.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../../", import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? cssFiles(full) : name.endsWith(".css") ? [full] : [];
  });
}

describe("Tailwind isolation", () => {
  it("imports Tailwind only from the cockpit stylesheet", () => {
    const importers = cssFiles(srcRoot)
      .filter((file) => readFileSync(file, "utf8").includes('@import "tailwindcss"'))
      .map((file) => path.relative(srcRoot, file).replace(/\\/g, "/"));
    expect(importers).toEqual(["cockpit/styles/cockpit.css"]);
  });

  it("defines both themes and the density variant", () => {
    const css = readFileSync(fileURLToPath(new URL("./cockpit.css", import.meta.url)), "utf8");
    expect(css).toContain('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));');
    expect(css).toContain('@custom-variant compact (&:where([data-density="compact"], [data-density="compact"] *));');
    expect(css).toMatch(/--breakpoint-md:\s*64rem;/);
    expect(css).toMatch(/--text-md:\s*1rem;/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/styles/tailwind-isolation.test.ts`
Expected: FAIL on the second test (the placeholder has no theme).

- [ ] **Step 3: Write the theme**

Token values come from `.theme-signal-noir` and `.theme-citadel-light` in `apps/mission-control-next/src/styles/mission-control-next-tokens.css`, so both shells share the brand.

```css
/* apps/mission-control-next/src/cockpit/styles/cockpit.css */
@import "tailwindcss";
@import "@fontsource-variable/geist";
@import "@fontsource-variable/hanken-grotesk";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
@custom-variant compact (&:where([data-density="compact"], [data-density="compact"] *));

:root {
  --gc-canvas: #f6fbff;
  --gc-raised: #ffffff;
  --gc-sunken: #eef6fb;
  --gc-overlay: #ffffff;
  --gc-text: #101922;
  --gc-text-secondary: #32424d;
  --gc-text-muted: #4b5b68;
  --gc-border-subtle: rgba(13, 42, 55, 0.14);
  --gc-border: rgba(13, 42, 55, 0.2);
  --gc-border-strong: rgba(13, 42, 55, 0.32);
  --gc-accent: #0f6070;
  --gc-accent-ink: #f6fbff;
  --gc-running: #0f6070;
  --gc-waiting: oklch(0.62 0.18 85);
  --gc-done: oklch(0.5 0.16 160);
  --gc-failed: oklch(0.52 0.2 28);
  --gc-neutral: #4b5b68;
}

[data-theme="dark"] {
  --gc-canvas: #080f11;
  --gc-raised: #0d1516;
  --gc-sunken: #050a0b;
  --gc-overlay: #151d1e;
  --gc-text: #f3f9fb;
  --gc-text-secondary: #c8d5dc;
  --gc-text-muted: #a8b7c0;
  --gc-border-subtle: rgba(255, 255, 255, 0.06);
  --gc-border: rgba(255, 255, 255, 0.1);
  --gc-border-strong: rgba(255, 255, 255, 0.16);
  --gc-accent: #00e5ff;
  --gc-accent-ink: #071016;
  --gc-running: #00e5ff;
  --gc-waiting: oklch(0.84 0.15 85);
  --gc-done: oklch(0.76 0.15 160);
  --gc-failed: oklch(0.7 0.18 28);
  --gc-neutral: #a8b7c0;
}

@theme {
  --color-*: initial;
  --font-*: initial;
  --text-*: initial;
  --radius-*: initial;
  --breakpoint-*: initial;
  --shadow-*: initial;

  --breakpoint-sm: 40rem;
  --breakpoint-md: 64rem;
  --breakpoint-lg: 80rem;
  --breakpoint-xl: 100rem;

  --font-sans: "Geist Variable", ui-sans-serif, system-ui, sans-serif;
  --font-display: "Hanken Grotesk Variable", "Geist Variable", ui-sans-serif, sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;

  --text-xs: 0.75rem;
  --text-xs--line-height: 1rem;
  --text-sm: 0.8125rem;
  --text-sm--line-height: 1.125rem;
  --text-base: 0.875rem;
  --text-base--line-height: 1.25rem;
  --text-md: 1rem;
  --text-md--line-height: 1.5rem;
  --text-lg: 1.25rem;
  --text-lg--line-height: 1.75rem;
  --text-xl: 1.5rem;
  --text-xl--line-height: 2rem;
  --text-2xl: 2rem;
  --text-2xl--line-height: 2.5rem;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;

  --shadow-overlay: 0 12px 32px rgb(0 0 0 / 0.28), 0 2px 8px rgb(0 0 0 / 0.16);
  --animate-pulse-live: pulse-live 1.6s ease-in-out infinite;
}

@theme inline {
  --color-canvas: var(--gc-canvas);
  --color-raised: var(--gc-raised);
  --color-sunken: var(--gc-sunken);
  --color-overlay: var(--gc-overlay);
  --color-fg: var(--gc-text);
  --color-fg-secondary: var(--gc-text-secondary);
  --color-fg-muted: var(--gc-text-muted);
  --color-line-subtle: var(--gc-border-subtle);
  --color-line: var(--gc-border);
  --color-line-strong: var(--gc-border-strong);
  --color-accent: var(--gc-accent);
  --color-accent-ink: var(--gc-accent-ink);
  --color-status-running: var(--gc-running);
  --color-status-waiting: var(--gc-waiting);
  --color-status-done: var(--gc-done);
  --color-status-failed: var(--gc-failed);
  --color-status-neutral: var(--gc-neutral);
}

@keyframes pulse-live {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

[data-density="compact"] {
  --spacing: 0.21875rem;
}

@layer base {
  html,
  body {
    background: var(--gc-canvas);
    color: var(--gc-text);
  }

  body {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--text-base--line-height);
  }

  :focus-visible {
    outline: 2px solid var(--gc-accent);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
}

@layer components {
  .cockpit-sheet {
    max-height: 85dvh;
  }
}
```

- [ ] **Step 4: Run the test and build**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/styles/tailwind-isolation.test.ts`
Then: `pnpm --filter @goatcitadel/mission-control-next build`
Expected: PASS, and the build emits a separate CSS asset for the cockpit entry.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/styles/cockpit.css apps/mission-control-next/src/cockpit/styles/tailwind-isolation.test.ts
git commit -m "feat: add the cockpit Tailwind theme with GoatCitadel tokens"
```

---

### Task 3: Cockpit code guards

**Files:**
- Create: `scripts/check-mission-control-next-cockpit-classes.mjs`
- Test: `scripts/check-mission-control-next-cockpit-classes.test.mjs`
- Modify: `eslint.config.mjs`. Add a block after the one that sets `max-lines` to 1000 (around line 142).
- Modify: `apps/mission-control-next/package.json` (`perf:check`)

**Interfaces:**
- Produces: `findArbitraryClassValues(filePath: string, contents: string): Array<{ file, line, token }>`.
  - A class token is flagged when its utility part (after the last top-level `:`) contains `[` or `(`.
  - Bracketed variants such as `data-[state=open]:` stay allowed.

- [ ] **Step 1: Write the failing test**

```js
// scripts/check-mission-control-next-cockpit-classes.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findArbitraryClassValues } from "./check-mission-control-next-cockpit-classes.mjs";

describe("findArbitraryClassValues", () => {
  it("flags arbitrary values in utilities", () => {
    const source = 'const a = <div className="w-[13px] bg-(--x) text-fg" />;';
    assert.deepEqual(
      findArbitraryClassValues("a.tsx", source).map((finding) => finding.token),
      ["w-[13px]", "bg-(--x)"],
    );
  });

  it("allows bracketed variants and token utilities", () => {
    const source = 'const a = cn("data-[state=open]:bg-sunken", "aria-[current=page]:text-fg", "lg:grid-cols-3");';
    assert.deepEqual(findArbitraryClassValues("a.tsx", source), []);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/check-mission-control-next-cockpit-classes.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// scripts/check-mission-control-next-cockpit-classes.mjs
#!/usr/bin/env node
/*
 * Cockpit styling guard (spec §12.3): cockpit code uses theme utilities only.
 * A class token whose utility part contains an arbitrary value ("[...]" or
 * "(...)") is rejected; bracketed variants like data-[state=open]: are fine.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COCKPIT_ROOT = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");
const STRING_RE = /(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;

function utilityPart(token) {
  let depth = 0;
  let lastColon = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) lastColon = index;
  }
  return token.slice(lastColon + 1);
}

export function findArbitraryClassValues(filePath, contents) {
  const findings = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(STRING_RE)) {
      for (const token of match[2].split(/\s+/).filter(Boolean)) {
        if (/^[a-z][a-z0-9-]*-[[(]/.test(utilityPart(token))) {
          findings.push({ file: filePath, line: index + 1, token });
        }
      }
    }
  });
  return findings;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    }),
  );
  return nested.flat();
}

async function main() {
  const files = await walk(COCKPIT_ROOT);
  const findings = [];
  for (const file of files) {
    findings.push(...findArbitraryClassValues(file, await fs.readFile(file, "utf8")));
  }
  if (findings.length > 0) {
    console.error("[cockpit-classes] arbitrary Tailwind values are not allowed in cockpit code:");
    for (const finding of findings) {
      console.error(`- ${path.relative(repoRoot, finding.file)}:${finding.line} -> ${finding.token}`);
    }
    process.exit(1);
  }
  console.log(`[cockpit-classes] ${files.length} cockpit files use theme utilities only`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
```

- [ ] **Step 4: Add the ESLint override and wire the check**

In `eslint.config.mjs`, directly after the block containing `"max-lines": ["warn", { max: 1000, … }]`, add:

```js
  {
    files: ["apps/mission-control-next/src/cockpit/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
```

CI runs ESLint with `--max-warnings 0`, so a warning blocks.

In `apps/mission-control-next/package.json`, insert `node ../../scripts/check-mission-control-next-cockpit-classes.mjs && ` at the start of `perf:check`.

- [ ] **Step 5: Run the tests**

Run: `node --test scripts/check-mission-control-next-cockpit-classes.test.mjs`
Then: `node scripts/check-mission-control-next-cockpit-classes.mjs`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-mission-control-next-cockpit-classes.mjs scripts/check-mission-control-next-cockpit-classes.test.mjs eslint.config.mjs apps/mission-control-next/package.json
git commit -m "chore: guard cockpit code against arbitrary styles and large files"
```

---

### Task 4: Primitives

**Files (all under `apps/mission-control-next/src/cockpit/`):**
- Create: `lib/cn.ts`
- Create in `ui/`:
  - `Button.tsx`, `IconButton.tsx`, `Kbd.tsx`
  - `StatusBadge.tsx`, `EmptyState.tsx`, `Skeleton.tsx`
  - `Tabs.tsx`, `Menu.tsx`, `Dialog.tsx`, `Sheet.tsx`, `Tooltip.tsx`, `Toaster.tsx`
  - `index.ts`
- Test in `ui/`: `Button.test.tsx`, `StatusBadge.test.tsx`, `EmptyState.test.tsx`, `Dialog.test.tsx`

**Interfaces:**
- Produces:
  - `cn(...inputs: ClassValue[]): string`
  - `Button` with `variant: "primary"|"secondary"|"ghost"|"danger"`, `size: "sm"|"md"`, and `type="button"` by default
  - `IconButton` with `label` (becomes `aria-label`) and `icon`
  - `Kbd`
  - `StatusBadge({ status: StatusPresentation })`
  - `EmptyState({ title, description?, action? })`
  - `Skeleton({ className? })`
  - `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`
  - `Menu`, `MenuTrigger`, `MenuContent`, `MenuItem`
  - `Dialog({ open, onOpenChange, title, description?, children })`
  - `Sheet({ open, onOpenChange, title, children })`
  - `Tooltip({ label, children })`
  - `CockpitToaster`

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/mission-control-next/src/cockpit/ui/Button.test.tsx
// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

describe("Button", () => {
  it("defaults to a secondary, non-submitting button", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Button>Save</Button>);
    });
    const button = renderer.root.findByType("button");
    expect(button.props.type).toBe("button");
    expect(button.props.className).toContain("border-line");
  });

  it("gives icon buttons an accessible name", () => {
    const onClick = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<IconButton label="Open inbox" icon={<span />} onClick={onClick} />);
    });
    const button = renderer.root.findByType("button");
    expect(button.props["aria-label"]).toBe("Open inbox");
    act(() => button.props.onClick());
    expect(onClick).toHaveBeenCalledOnce();
  });
});
```

```tsx
// apps/mission-control-next/src/cockpit/ui/StatusBadge.test.tsx
// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("pairs the label with a tone class and an icon", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<StatusBadge status={{ label: "Waiting on you", tone: "waiting" }} />);
    });
    const badge = renderer.root.findByProps({ "data-tone": "waiting" });
    expect(badge.props.className).toContain("text-status-waiting");
    expect(JSON.stringify(renderer.toJSON())).toContain("Waiting on you");
    expect(badge.findAll((node) => node.props["aria-hidden"] === "true").length).toBeGreaterThan(0);
  });
});
```

```tsx
// apps/mission-control-next/src/cockpit/ui/EmptyState.test.tsx
// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders a heading, a description, and an optional action", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <EmptyState
          title="Nothing waiting on you"
          description="New decisions appear here."
          action={<button type="button">Open Chat</button>}
        />,
      );
    });
    expect(renderer.root.findByType("h2").props.children).toBe("Nothing waiting on you");
    expect(renderer.root.findByType("p").props.children).toBe("New decisions appear here.");
    expect(renderer.root.findByType("button").props.children).toBe("Open Chat");
  });
});
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Dialog.test.tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog } from "./Dialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Dialog", () => {
  it("renders an accessible dialog with its title when open", () => {
    act(() => {
      root.render(
        <Dialog open onOpenChange={() => undefined} title="Command palette">
          <p>Body</p>
        </Dialog>,
      );
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Command palette");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/ui`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// apps/mission-control-next/src/cockpit/lib/cn.ts
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the cockpit's type scale so "text-md" merges as a size, not a color.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["xs", "sm", "base", "md", "lg", "xl", "2xl"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Button.tsx
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-accent text-accent-ink hover:opacity-90",
  secondary: "border border-line bg-raised text-fg hover:border-line-strong",
  ghost: "text-fg-secondary hover:bg-sunken hover:text-fg",
  danger: "border border-status-failed text-status-failed hover:bg-sunken",
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: "h-7 px-2.5 text-sm",
  md: "h-9 px-3.5 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});
```

```tsx
// apps/mission-control-next/src/cockpit/ui/IconButton.tsx
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-sunken hover:text-fg",
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Kbd.tsx
import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm border border-line px-1 font-mono text-xs text-fg-muted">{children}</kbd>;
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/StatusBadge.tsx
import { Check, Circle, Hand, LoaderCircle, X, type LucideIcon } from "lucide-react";
import type { StatusPresentation, StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { cn } from "../lib/cn";

const TONE_CLASSES: Readonly<Record<StatusTone, string>> = {
  running: "border-status-running/40 text-status-running",
  waiting: "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
  done: "border-status-done/40 text-status-done",
  failed: "border-status-failed/40 text-status-failed",
  neutral: "border-line text-fg-muted",
};

const TONE_ICONS: Readonly<Record<StatusTone, LucideIcon>> = {
  running: LoaderCircle,
  waiting: Hand,
  done: Check,
  failed: X,
  neutral: Circle,
};

export function StatusBadge({ status, className }: { status: StatusPresentation; className?: string }) {
  const Icon = TONE_ICONS[status.tone];
  return (
    <span
      data-tone={status.tone}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[status.tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("size-3", status.tone === "running" && "animate-pulse-live")} />
      {status.label}
    </span>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/EmptyState.tsx
import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <section role="status" className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <h2 className="font-display text-lg text-fg">{title}</h2>
      {description ? <p className="max-w-md text-base text-fg-secondary">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Skeleton.tsx
import { cn } from "../lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse-live rounded-md bg-sunken", className)} />;
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Tabs.tsx
import type { ComponentPropsWithoutRef } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex gap-1 border-b border-line-subtle", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary data-[state=active]:border-accent data-[state=active]:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = TabsPrimitive.Content;
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Menu.tsx
import type { ComponentPropsWithoutRef } from "react";
import { DropdownMenu } from "radix-ui";
import { cn } from "../lib/cn";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={6}
        className={cn("min-w-48 rounded-md border border-line bg-overlay p-1 shadow-overlay", className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Item>) {
  return (
    <DropdownMenu.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-sunken",
        className,
      )}
      {...props}
    />
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Dialog.tsx
import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-canvas/70" />
        <DialogPrimitive.Content className="fixed top-24 left-1/2 w-full max-w-xl -translate-x-1/2 rounded-lg border border-line bg-overlay p-2 shadow-overlay">
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          ) : null}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Sheet.tsx
import type { ReactNode } from "react";
import { Drawer } from "vaul";

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-canvas/70" />
        <Drawer.Content className="cockpit-sheet fixed inset-x-0 bottom-0 rounded-t-lg border border-line bg-overlay p-4">
          <Drawer.Title className="mb-2 text-md font-medium text-fg">{title}</Drawer.Title>
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Tooltip.tsx
import type { ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={400}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content sideOffset={6} className="rounded-sm bg-overlay px-2 py-1 text-xs text-fg shadow-overlay">
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/ui/Toaster.tsx
import { Toaster } from "sonner";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

/** Spec §11: toasts sit top-right, clear of the composer, and follow the theme. */
export function CockpitToaster() {
  const { theme } = useUiPreferences();
  return <Toaster position="top-right" offset={16} visibleToasts={3} theme={theme} closeButton />;
}
```

```ts
// apps/mission-control-next/src/cockpit/ui/index.ts
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { Dialog } from "./Dialog";
export { EmptyState } from "./EmptyState";
export { IconButton } from "./IconButton";
export { Kbd } from "./Kbd";
export { Menu, MenuContent, MenuItem, MenuTrigger } from "./Menu";
export { Sheet } from "./Sheet";
export { Skeleton } from "./Skeleton";
export { StatusBadge } from "./StatusBadge";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";
export { CockpitToaster } from "./Toaster";
export { Tooltip } from "./Tooltip";
```

- [ ] **Step 4: Run the tests and the guard**

Run:
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/ui`
- `node scripts/check-mission-control-next-cockpit-classes.mjs`

Expected: PASS, and the guard exits 0. The shared test setup mocks `vaul`, so `Sheet` is not rendered in these unit tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/lib apps/mission-control-next/src/cockpit/ui
git commit -m "feat: add cockpit primitives built on Radix, vaul, and sonner"
```

---

### Task 5: Data layer and realtime bridge

**Files:**
- Modify: `apps/mission-control-next/package.json` (dependency)
- Create: `apps/mission-control-next/src/cockpit/data/query-client.ts`, `query-keys.ts`, `realtime.ts`
- Test: `apps/mission-control-next/src/cockpit/data/query-client.test.ts`, `realtime.test.ts`

**Interfaces:**
- Consumes:
  - `ApiRequestError` and `isApiRequestError` from `@goatcitadel/mission-control-shared/api/http-internal`
  - `connectEventStream` and `type RealtimeEvent` from `@goatcitadel/mission-control-shared/api/shell-client`
  - `deriveRealtimeRefresh` and `deriveRealtimeNotification` from `@goatcitadel/mission-control-shared/state/realtime-derived`
  - `decideNotificationDelivery` from `@goatcitadel/mission-control-shared/state/notification-policy`
  - `type RefreshTopic` from `@goatcitadel/mission-control-shared/state/refresh-bus`
  - `toast` from `sonner`
- Produces:
  - `COCKPIT_STALE_TIME_MS = 30_000`
  - `shouldRetryQuery(failureCount: number, error: unknown): boolean`
  - `createCockpitQueryClient(): QueryClient`
  - `queryKeys.workspaces(citadelId?: string)` and `queryKeys.citadels()`. Every key starts with a `RefreshTopic`.
  - `invalidateForEvent(queryClient, event): RefreshTopic[]`
  - `useCockpitRealtime({ queryClient, enabled, visibleSessionId? }): void`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @goatcitadel/mission-control-next add --save-exact @tanstack/react-query@5`
Expected: `package.json` pins `"@tanstack/react-query": "5.x.y"` exactly, and `pnpm-lock.yaml` updates. Record the version in the commit message.

- [ ] **Step 2: Write the failing tests**

```ts
// apps/mission-control-next/src/cockpit/data/query-client.test.ts
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { COCKPIT_STALE_TIME_MS, createCockpitQueryClient, shouldRetryQuery } from "./query-client";
import { queryKeys } from "./query-keys";

describe("cockpit query client", () => {
  it("does not retry client errors and retries others twice", () => {
    const notFound = new ApiRequestError("API error 404", { kind: "http", method: "GET", path: "/x", status: 404 });
    const offline = new ApiRequestError("Network error", { kind: "network", method: "GET", path: "/x" });
    expect(shouldRetryQuery(0, notFound)).toBe(false);
    expect(shouldRetryQuery(0, offline)).toBe(true);
    expect(shouldRetryQuery(2, offline)).toBe(false);
  });

  it("uses the thirty-second stale time", () => {
    expect(createCockpitQueryClient().getDefaultOptions().queries?.staleTime).toBe(COCKPIT_STALE_TIME_MS);
  });

  it("starts every key with a refresh topic", () => {
    expect(queryKeys.workspaces("c-1")[0]).toBe("system");
    expect(queryKeys.citadels()[0]).toBe("system");
  });
});
```

```ts
// apps/mission-control-next/src/cockpit/data/realtime.test.ts
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateForEvent } from "./realtime";

describe("invalidateForEvent", () => {
  it("invalidates the queries for each refresh topic of an event", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const topics = invalidateForEvent(queryClient, {
      eventId: "e-1",
      sequence: 1,
      eventType: "chat_thread_updated",
      source: "chat",
      timestamp: "2026-09-28T00:00:00.000Z",
      links: { sessionId: "s-1" },
      payload: {},
    } as never);
    expect(topics).toContain("chat");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["chat"] });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/data`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

```ts
// apps/mission-control-next/src/cockpit/data/query-client.ts
import { QueryClient } from "@tanstack/react-query";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

export const COCKPIT_STALE_TIME_MS = 30_000;
const MAX_QUERY_RETRIES = 2;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.kind === "http" && error.status !== undefined && error.status < 500) {
    return false;
  }
  return failureCount < MAX_QUERY_RETRIES;
}

export function createCockpitQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: COCKPIT_STALE_TIME_MS, retry: shouldRetryQuery, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
```

```ts
// apps/mission-control-next/src/cockpit/data/query-keys.ts
import type { RefreshTopic } from "@goatcitadel/mission-control-shared/state/refresh-bus";

/** Every cockpit query key starts with the refresh topic whose events invalidate it. */
type TopicKey = readonly [RefreshTopic, ...unknown[]];

export const queryKeys = {
  workspaces: (citadelId?: string): TopicKey => ["system", "workspaces", citadelId ?? "all"],
  citadels: (): TopicKey => ["system", "citadels"],
};
```

```ts
// apps/mission-control-next/src/cockpit/data/realtime.ts
import { useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { connectEventStream, type RealtimeEvent } from "@goatcitadel/mission-control-shared/api/shell-client";
import { decideNotificationDelivery } from "@goatcitadel/mission-control-shared/state/notification-policy";
import { deriveRealtimeNotification, deriveRealtimeRefresh } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import type { RefreshTopic } from "@goatcitadel/mission-control-shared/state/refresh-bus";

export function invalidateForEvent(queryClient: QueryClient, event: RealtimeEvent): RefreshTopic[] {
  const { topics } = deriveRealtimeRefresh(event, { defaultTopics: ["surface"] });
  for (const topic of topics) {
    void queryClient.invalidateQueries({ queryKey: [topic] });
  }
  return topics;
}

function pageFocused(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/** One event subscription: refresh the data it touches, and toast only what the policy allows. */
export function useCockpitRealtime(input: { queryClient: QueryClient; enabled: boolean; visibleSessionId?: string }): void {
  const visibleSessionIdRef = useRef(input.visibleSessionId);
  useEffect(() => {
    visibleSessionIdRef.current = input.visibleSessionId;
  }, [input.visibleSessionId]);

  const { queryClient, enabled } = input;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    return connectEventStream((event, delivery) => {
      invalidateForEvent(queryClient, event);
      const notification = deriveRealtimeNotification(event);
      const decision = decideNotificationDelivery(notification, {
        replayed: delivery?.replayed ?? false,
        eventSessionId: event.links?.sessionId,
        visibleSessionId: visibleSessionIdRef.current,
        pageFocused: pageFocused(),
      });
      if (notification && decision.toast) {
        const show = notification.tone === "error" ? toast.error : notification.tone === "warning" ? toast.warning : toast;
        show(notification.message, { id: notification.groupKey });
      }
    });
  }, [queryClient, enabled]);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/data`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mission-control-next/package.json pnpm-lock.yaml apps/mission-control-next/src/cockpit/data
git commit -m "feat: add the cockpit query client and realtime invalidation"
```

---

### Task 6: Routes, location store, and inspector host

**Files:**
- Create: `apps/mission-control-next/src/cockpit/app/routes.ts`, `use-cockpit-route.ts`, `inspector.tsx`
- Test: `apps/mission-control-next/src/cockpit/app/routes.test.ts`, `inspector.test.tsx`

**Interfaces:**
- Produces:
  - `type CockpitArea = "chat"|"inbox"|"work"|"library"|"system"|"settings"|"gallery"`
  - `COCKPIT_AREAS`: the five sidebar areas, as `{ area, label, path, shortcut }` entries
  - `parseCockpitLocation(pathname): { area; rest: string[] }`
  - `useCockpitRoute(): { area, rest, pathname, navigate(path) }`
  - `InspectorProvider`
  - `useInspector(): { content, open({ title, body }), close() }`
  - `InspectorPanel`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/mission-control-next/src/cockpit/app/routes.test.ts
import { describe, expect, it } from "vitest";
import { COCKPIT_AREAS, parseCockpitLocation } from "./routes";

describe("cockpit routes", () => {
  it("maps paths to areas, including classic prefixes", () => {
    expect(parseCockpitLocation("/inbox/appr-1")).toEqual({ area: "inbox", rest: ["appr-1"] });
    expect(parseCockpitLocation("/projects/p-1")).toEqual({ area: "chat", rest: ["p-1"] });
    expect(parseCockpitLocation("/ops/costs")).toEqual({ area: "system", rest: ["costs"] });
    expect(parseCockpitLocation("/__gallery")).toEqual({ area: "gallery", rest: [] });
    expect(parseCockpitLocation("/")).toEqual({ area: "chat", rest: [] });
  });

  it("lists the five sidebar areas with Ctrl+1 to Ctrl+5", () => {
    expect(COCKPIT_AREAS.map((entry) => [entry.label, entry.shortcut])).toEqual([
      ["Chat", "1"],
      ["Inbox", "2"],
      ["Work", "3"],
      ["Library", "4"],
      ["System", "5"],
    ]);
  });
});
```

```tsx
// apps/mission-control-next/src/cockpit/app/inspector.test.tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InspectorPanel, InspectorProvider, useInspector } from "./inspector";

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useInspector>;

function Probe() {
  api = useInspector();
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("inspector", () => {
  it("opens with a title and body, and closes on Escape", () => {
    act(() => {
      root.render(
        <InspectorProvider>
          <Probe />
          <InspectorPanel />
        </InspectorProvider>,
      );
    });
    act(() => api.open({ title: "Run", body: <p>Steps</p> }));
    expect(container.querySelector('[aria-label="Inspector: Run"]')?.textContent).toContain("Steps");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[aria-label="Inspector: Run"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/app/routes.test.ts src/cockpit/app/inspector.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/mission-control-next/src/cockpit/app/routes.ts
export type CockpitArea = "chat" | "inbox" | "work" | "library" | "system" | "settings" | "gallery";

export const COCKPIT_AREAS = [
  { area: "chat", label: "Chat", path: "/chat", shortcut: "1" },
  { area: "inbox", label: "Inbox", path: "/inbox", shortcut: "2" },
  { area: "work", label: "Work", path: "/work", shortcut: "3" },
  { area: "library", label: "Library", path: "/library", shortcut: "4" },
  { area: "system", label: "System", path: "/system", shortcut: "5" },
] as const satisfies readonly { area: CockpitArea; label: string; path: string; shortcut: string }[];

const AREA_BY_SEGMENT: Readonly<Record<string, CockpitArea>> = {
  chat: "chat",
  projects: "chat",
  inbox: "inbox",
  work: "work",
  library: "library",
  system: "system",
  ops: "system",
  settings: "settings",
  __gallery: "gallery",
};

export function parseCockpitLocation(pathname: string): { area: CockpitArea; rest: string[] } {
  const segments = pathname.split("/").filter(Boolean);
  const area = AREA_BY_SEGMENT[segments[0] ?? ""] ?? "chat";
  return { area, rest: segments.slice(1) };
}
```

```ts
// apps/mission-control-next/src/cockpit/app/use-cockpit-route.ts
import { useCallback, useSyncExternalStore } from "react";
import { parseCockpitLocation } from "./routes";

const LOCATION_EVENT = "goatcitadel:cockpit-location";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(LOCATION_EVENT, onChange);
  };
}

export function useCockpitRoute() {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname, () => "/chat");
  const navigate = useCallback((path: string) => {
    if (path === window.location.pathname + window.location.search) {
      return;
    }
    window.history.pushState(null, "", path);
    window.dispatchEvent(new Event(LOCATION_EVENT));
  }, []);
  return { ...parseCockpitLocation(pathname), pathname, navigate };
}
```

```tsx
// apps/mission-control-next/src/cockpit/app/inspector.tsx
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { IconButton } from "../ui/IconButton";

interface InspectorContent {
  title: string;
  body: ReactNode;
}

interface InspectorApi {
  content: InspectorContent | null;
  open: (content: InspectorContent) => void;
  close: () => void;
}

const InspectorContext = createContext<InspectorApi | null>(null);

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<InspectorContent | null>(null);
  const close = useCallback(() => setContent(null), []);
  useEffect(() => {
    if (!content) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [content, close]);
  const api = useMemo(() => ({ content, open: setContent, close }), [content, close]);
  return <InspectorContext.Provider value={api}>{children}</InspectorContext.Provider>;
}

export function useInspector(): InspectorApi {
  const api = useContext(InspectorContext);
  if (!api) {
    throw new Error("useInspector must be used inside InspectorProvider");
  }
  return api;
}

export function InspectorPanel() {
  const { content, close } = useInspector();
  if (!content) {
    return null;
  }
  return (
    <aside
      aria-label={`Inspector: ${content.title}`}
      className="flex w-96 shrink-0 flex-col border-l border-line-subtle bg-raised max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:shadow-overlay"
    >
      <header className="flex h-12 items-center justify-between border-b border-line-subtle px-3">
        <h2 className="text-sm font-medium text-fg">{content.title}</h2>
        <IconButton label="Close inspector" icon={<X className="size-4" aria-hidden="true" />} onClick={close} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{content.body}</div>
    </aside>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/app/routes.test.ts src/cockpit/app/inspector.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/app/routes.ts apps/mission-control-next/src/cockpit/app/routes.test.ts apps/mission-control-next/src/cockpit/app/use-cockpit-route.ts apps/mission-control-next/src/cockpit/app/inspector.tsx apps/mission-control-next/src/cockpit/app/inspector.test.tsx
git commit -m "feat: add cockpit routing and the inspector host"
```

---

### Task 7: Shell, sidebar, phone tabs, command palette, access gate

**Files (under `apps/mission-control-next/src/cockpit/app/`):**
- Create:
  - `Sidebar.tsx`, `MobileTabBar.tsx`, `CommandPalette.tsx`
  - `AreaPlaceholder.tsx`, `CockpitAccessGate.tsx`
  - `CockpitShell.tsx`, `CockpitApp.tsx`, `Gallery.tsx`
- Test: `CockpitShell.test.tsx`, `CommandPalette.test.tsx`
- Modify: `apps/mission-control-next/src/cockpit-entry.tsx`

**Interfaces:**
- Consumes:
  - `useGatewayAccess` and `type GatewayAccessViewState` from `@next/app/use-gateway-access`
  - `UiPreferencesProvider` and `useUiPreferences` from `@goatcitadel/mission-control-shared/state/ui-preferences`, using `theme`, `setTheme`, `density`, `activeWorkspaceId`, and `activeCitadelId`
  - `fetchWorkspaces` from `@goatcitadel/mission-control-shared/api/workspaces`
  - `switchShell` from `@next/shell-preference`
  - Tasks 4–6
- Produces:
  - `CockpitApp`, whose root carries `data-cockpit-ready="true"` once the gateway is ready
  - `CockpitShell`, `Sidebar`, `MobileTabBar`
  - `CommandPalette({ open, onOpenChange })`
  - `AreaPlaceholder({ area })`
  - `Gallery`

Layout rules (spec §6):
- **Sidebar:** 248px wide at `sm` and up. There is no global top bar and no footer strip.
- **Below `sm`:** the sidebar is hidden and `MobileTabBar` shows at the bottom.
- **Inspector:** docks right at `lg` and up; below `lg` it overlays the content.
- **Keyboard:** Ctrl+K opens the palette, and Ctrl+1 to Ctrl+5 switch areas.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/mission-control-next/src/cockpit/app/CockpitShell.test.tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitShell } from "./CockpitShell";

vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [{ workspaceId: "default", name: "Default Workspace" }] })),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  window.history.replaceState(null, "", "/inbox");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CockpitShell", () => {
  it("renders the five areas, marks the current one, and switches with Ctrl+number", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <CockpitShell />
        </QueryClientProvider>,
      );
    });
    const nav = container.querySelector('nav[aria-label="Areas"]')!;
    const labels = [...nav.querySelectorAll("button")].map((node) => node.textContent?.trim());
    expect(labels).toEqual(["Chat", "Inbox", "Work", "Library", "System"]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toContain("Inbox");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "4", ctrlKey: true }));
    });
    expect(window.location.pathname).toBe("/library");
  });
});
```

```tsx
// apps/mission-control-next/src/cockpit/app/CommandPalette.test.tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

vi.mock("@next/shell-preference", () => ({ switchShell: vi.fn() }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CommandPalette", () => {
  it("offers area navigation and the classic shell", () => {
    act(() => {
      root.render(<CommandPalette open onOpenChange={() => undefined} />);
    });
    const text = document.body.textContent ?? "";
    for (const label of ["Go to Chat", "Go to Inbox", "Go to Work", "Go to Library", "Go to System", "Switch to classic Mission Control"]) {
      expect(text).toContain(label);
    }
  });
});
```

`fetchWorkspaces` returns `WorkspacesResponse` (`packages/mission-control-shared/src/api/workspaces.ts`). If that type's list field is not `items`, or its name field is not `name`, use the real field names in the mock and in `Sidebar`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/app/CockpitShell.test.tsx src/cockpit/app/CommandPalette.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```tsx
// apps/mission-control-next/src/cockpit/app/CommandPalette.tsx
import { Command } from "cmdk";
import { switchShell } from "@next/shell-preference";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Dialog } from "../ui/Dialog";
import { COCKPIT_AREAS } from "./routes";
import { useCockpitRoute } from "./use-cockpit-route";

const ITEM_CLASS = "rounded-sm px-3 py-2 text-sm text-fg data-[selected=true]:bg-sunken";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { navigate } = useCockpitRoute();
  const { theme, setTheme } = useUiPreferences();
  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Jump to an area or run a command">
      <Command label="Command palette" className="flex flex-col">
        <Command.Input
          placeholder="Search or run a command"
          className="h-10 border-b border-line-subtle bg-transparent px-3 text-base text-fg outline-none"
        />
        <Command.List className="max-h-80 overflow-y-auto p-1">
          <Command.Empty className="px-3 py-6 text-center text-sm text-fg-muted">No matches</Command.Empty>
          <Command.Group heading="Go to" className="text-xs text-fg-muted">
            {COCKPIT_AREAS.map((entry) => (
              <Command.Item key={entry.area} onSelect={() => run(() => navigate(entry.path))} className={ITEM_CLASS}>
                Go to {entry.label}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Preferences" className="text-xs text-fg-muted">
            <Command.Item onSelect={() => run(() => setTheme(theme === "dark" ? "light" : "dark"))} className={ITEM_CLASS}>
              Switch to {theme === "dark" ? "light" : "dark"} theme
            </Command.Item>
            <Command.Item onSelect={() => run(() => switchShell("classic"))} className={ITEM_CLASS}>
              Switch to classic Mission Control
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </Dialog>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/app/AreaPlaceholder.tsx
import { switchShell } from "@next/shell-preference";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import type { CockpitArea } from "./routes";

const COPY: Readonly<Record<Exclude<CockpitArea, "gallery">, string>> = {
  chat: "Chat moves into the new Mission Control next. Until then, use it in the classic view.",
  inbox: "Every approval, question, and proposal will collect here.",
  work: "Runs and tasks in progress will show here.",
  library: "Skills, tools, knowledge, memory, and files will live here.",
  system: "Health, spend, quality, and diagnostics will live here.",
  settings: "Settings move here in a later update.",
};

export function AreaPlaceholder({ area }: { area: Exclude<CockpitArea, "gallery"> }) {
  return (
    <EmptyState
      title="Coming to the new Mission Control"
      description={COPY[area]}
      action={<Button onClick={() => switchShell("classic")}>Open in classic view</Button>}
    />
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/app/MobileTabBar.tsx
import { Inbox, LayoutGrid, Library, MessageSquare, MoreHorizontal } from "lucide-react";
import { useCockpitRoute } from "./use-cockpit-route";

const TABS = [
  { area: "chat", label: "Chat", path: "/chat", Icon: MessageSquare },
  { area: "inbox", label: "Inbox", path: "/inbox", Icon: Inbox },
  { area: "work", label: "Work", path: "/work", Icon: LayoutGrid },
  { area: "library", label: "Library", path: "/library", Icon: Library },
  { area: "system", label: "More", path: "/system", Icon: MoreHorizontal },
] as const;

export function MobileTabBar() {
  const { area: current, navigate } = useCockpitRoute();
  return (
    <nav aria-label="Areas on small screens" className="flex border-t border-line-subtle bg-raised sm:hidden">
      {TABS.map(({ area, label, path, Icon }) => (
        <button
          key={area}
          type="button"
          aria-current={current === area ? "page" : undefined}
          onClick={() => navigate(path)}
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-fg-muted aria-[current=page]:text-fg"
        >
          <Icon aria-hidden="true" className="size-5" />
          {label}
        </button>
      ))}
    </nav>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/app/Sidebar.tsx
import { useQuery } from "@tanstack/react-query";
import { Activity, Inbox, LayoutGrid, Library, MessageSquare, Search, Settings } from "lucide-react";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { switchShell } from "@next/shell-preference";
import { queryKeys } from "../data/query-keys";
import { Kbd } from "../ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/Menu";
import { COCKPIT_AREAS } from "./routes";
import { useCockpitRoute } from "./use-cockpit-route";

const AREA_ICONS = { chat: MessageSquare, inbox: Inbox, work: LayoutGrid, library: Library, system: Activity } as const;

export function Sidebar({ onOpenPalette, streamHealthy }: { onOpenPalette: () => void; streamHealthy: boolean }) {
  const { area: current, navigate } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId, theme, setTheme } = useUiPreferences();
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(activeCitadelId),
    queryFn: () => fetchWorkspaces("active", 200, activeCitadelId),
  });
  const workspaceName =
    workspaces.data?.items.find((item) => item.workspaceId === activeWorkspaceId)?.name ?? "Workspace";

  return (
    <aside className="hidden w-62 shrink-0 flex-col gap-1 border-r border-line-subtle bg-raised p-2 sm:flex">
      <div className="px-2 py-1.5 text-sm font-medium text-fg">{workspaceName}</div>
      <button
        type="button"
        onClick={onOpenPalette}
        className="mb-2 flex h-8 items-center gap-2 rounded-md border border-line px-2 text-sm text-fg-muted hover:border-line-strong"
      >
        <Search aria-hidden="true" className="size-4" />
        <span className="flex-1 text-left">Search</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <nav aria-label="Areas" className="flex flex-col gap-0.5">
        {COCKPIT_AREAS.map((entry) => {
          const Icon = AREA_ICONS[entry.area];
          return (
            <button
              key={entry.area}
              type="button"
              aria-current={current === entry.area ? "page" : undefined}
              onClick={() => navigate(entry.path)}
              className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-secondary hover:bg-sunken aria-[current=page]:bg-sunken aria-[current=page]:text-fg"
            >
              <Icon aria-hidden="true" className="size-4" />
              {entry.label}
            </button>
          );
        })}
      </nav>
      <div className="flex-1" />
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-fg-muted">
        <span aria-hidden="true" className={streamHealthy ? "size-2 rounded-full bg-status-done" : "size-2 rounded-full bg-status-waiting"} />
        <span className="flex-1">{streamHealthy ? "All systems ok" : "Reconnecting"}</span>
        <Menu>
          <MenuTrigger aria-label="Settings and account" className="rounded-md p-1 text-fg-muted hover:bg-sunken">
            <Settings aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => navigate("/settings/general")}>Settings</MenuItem>
            <MenuItem onSelect={() => setTheme(theme === "dark" ? "light" : "dark")}>
              Switch to {theme === "dark" ? "light" : "dark"} theme
            </MenuItem>
            <MenuItem onSelect={() => switchShell("classic")}>Switch to classic Mission Control</MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </aside>
  );
}
```

`w-62` resolves through the spacing scale: 62 × 0.25rem = 15.5rem = 248px.

```tsx
// apps/mission-control-next/src/cockpit/app/CockpitShell.tsx
import { useEffect, useState } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { AreaPlaceholder } from "./AreaPlaceholder";
import { CommandPalette } from "./CommandPalette";
import { Gallery } from "./Gallery";
import { InspectorPanel, InspectorProvider } from "./inspector";
import { MobileTabBar } from "./MobileTabBar";
import { COCKPIT_AREAS } from "./routes";
import { Sidebar } from "./Sidebar";
import { useCockpitRoute } from "./use-cockpit-route";

export function CockpitShell({ streamHealthy = true }: { streamHealthy?: boolean }) {
  const { area, navigate } = useCockpitRoute();
  const { theme, density } = useUiPreferences();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density === "compact" ? "compact" : "comfortable";
  }, [theme, density]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      const target = COCKPIT_AREAS.find((entry) => entry.shortcut === event.key);
      if (target) {
        event.preventDefault();
        navigate(target.path);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <InspectorProvider>
      <div className="flex h-dvh flex-col bg-canvas text-fg">
        <div className="flex min-h-0 flex-1">
          <Sidebar onOpenPalette={() => setPaletteOpen(true)} streamHealthy={streamHealthy} />
          <main id="main-content" className="min-w-0 flex-1 overflow-y-auto">
            {area === "gallery" ? <Gallery /> : <AreaPlaceholder area={area} />}
          </main>
          <InspectorPanel />
        </div>
        <MobileTabBar />
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </InspectorProvider>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/app/CockpitAccessGate.tsx
import { switchShell } from "@next/shell-preference";
import type { GatewayAccessViewState } from "@next/app/use-gateway-access";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

export function CockpitAccessGate({ access, busy, onRetry }: { access: GatewayAccessViewState; busy: boolean; onRetry: () => void }) {
  const needsSignIn = access.status === "needs-auth";
  const title =
    access.status === "checking"
      ? "Connecting to GoatCitadel"
      : needsSignIn
        ? "Sign in to continue"
        : "Can't reach the GoatCitadel gateway";
  return (
    <main className="flex h-dvh items-center justify-center bg-canvas">
      <EmptyState
        title={title}
        description={
          needsSignIn
            ? "Sign in on the classic screen; the new Mission Control uses the same session."
            : "Check that the gateway is running. This page retries on its own."
        }
        action={
          needsSignIn ? (
            <Button variant="primary" onClick={() => switchShell("classic")}>
              Sign in
            </Button>
          ) : (
            <Button disabled={busy} onClick={onRetry}>
              {busy ? "Checking…" : "Try again"}
            </Button>
          )
        }
      />
    </main>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/app/CockpitApp.tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useGatewayAccess } from "@next/app/use-gateway-access";
import { createCockpitQueryClient } from "../data/query-client";
import { useCockpitRealtime } from "../data/realtime";
import { CockpitToaster } from "../ui/Toaster";
import { CockpitAccessGate } from "./CockpitAccessGate";
import { CockpitShell } from "./CockpitShell";

function GatedCockpit() {
  const { gatewayAccess, gatewayBusy, retryGatewayAccess } = useGatewayAccess();
  const [queryClient] = useState(createCockpitQueryClient);
  const ready = gatewayAccess.status === "ready";
  useCockpitRealtime({ queryClient, enabled: ready });
  if (!ready) {
    return <CockpitAccessGate access={gatewayAccess} busy={gatewayBusy} onRetry={() => void retryGatewayAccess()} />;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <div data-cockpit-ready="true">
        <CockpitShell />
      </div>
      <CockpitToaster />
    </QueryClientProvider>
  );
}

export function CockpitApp() {
  return (
    <UiPreferencesProvider>
      <GatedCockpit />
    </UiPreferencesProvider>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit/app/Gallery.tsx
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Kbd } from "../ui/Kbd";
import { Skeleton } from "../ui/Skeleton";
import { StatusBadge } from "../ui/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/Tabs";

const STATUSES = [
  { label: "Running", tone: "running" },
  { label: "Waiting on you", tone: "waiting" },
  { label: "Paused", tone: "neutral" },
  { label: "Done", tone: "done" },
  { label: "Failed", tone: "failed" },
] as const;

/** Every primitive in every state, for tests and visual review. Not linked from navigation. */
export function Gallery() {
  return (
    <div className="flex flex-col gap-8 p-6" data-cockpit-gallery="true">
      <section className="flex flex-wrap gap-2">
        <Button variant="primary">Approve once</Button>
        <Button>Edit</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Deny</Button>
        <Button disabled>Unavailable</Button>
        <Button size="sm">Small</Button>
      </section>
      <section className="flex flex-wrap items-center gap-2">
        {STATUSES.map((status) => (
          <StatusBadge key={status.label} status={status} />
        ))}
        <Kbd>Ctrl K</Kbd>
      </section>
      <Tabs defaultValue="run">
        <TabsList>
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="turn">Turn</TabsTrigger>
        </TabsList>
        <TabsContent value="run" className="p-3 text-sm text-fg-secondary">
          Run details
        </TabsContent>
        <TabsContent value="turn" className="p-3 text-sm text-fg-secondary">
          Turn details
        </TabsContent>
      </Tabs>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>
      <EmptyState title="Nothing waiting on you" description="New decisions appear here." action={<Button>Open Chat</Button>} />
    </div>
  );
}
```

```tsx
// apps/mission-control-next/src/cockpit-entry.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { CockpitApp } from "@next/cockpit/app/CockpitApp";
import "@next/cockpit/styles/cockpit.css";

export function mountCockpit(root: HTMLElement): void {
  createRoot(root).render(
    <React.StrictMode>
      <CockpitApp />
    </React.StrictMode>,
  );
}
```

- [ ] **Step 4: Run the tests and the guards**

Run:
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit`
- `node scripts/check-mission-control-next-cockpit-classes.mjs`
- `pnpm lint`

Expected: PASS, exit 0, and no ESLint warnings (including the 400-line `max-lines` limit in `cockpit/**`).

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/cockpit/app apps/mission-control-next/src/cockpit-entry.tsx
git commit -m "feat: add the cockpit shell with sidebar, phone tabs, palette, and access gate"
```

---

### Task 8: Try it from the classic shell

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/settings/sections/GeneralSection.tsx` (the "Interface" `NativeCard` at lines 133-156 on `origin/main`)
- Test: `apps/mission-control-next/src/features/native-routes/settings/sections/GeneralSection.test.tsx` (create it with happy-dom if absent)

- [ ] **Step 1: Write the failing test**

```tsx
// apps/mission-control-next/src/features/native-routes/settings/sections/GeneralSection.test.tsx
// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { switchShell } from "@next/shell-preference";
import { GeneralSection } from "./GeneralSection";

vi.mock("@next/shell-preference", () => ({ switchShell: vi.fn() }));

describe("GeneralSection shell preview", () => {
  it("offers to switch to the new Mission Control", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<GeneralSection {...generalSectionProps()} />);
    });
    const button = renderer.root.find(
      (node) => node.type === "button" && node.props.children === "Try the new Mission Control",
    );
    act(() => button.props.onClick());
    expect(switchShell).toHaveBeenCalledWith("cockpit");
  });
});
```

`generalSectionProps()` builds the `SettingsSectionProps` shape. Define it at the top of this test file by copying the props builder from an existing `*Section.test.tsx` in the same folder, or from `SettingsNativePage.test.tsx`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/settings/sections/GeneralSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Inside the Interface card's `SettingsFieldGrid`, after the density field, add the control below and import `switchShell` from `@next/shell-preference`:

```tsx
          <SettingsField label="New Mission Control (preview)">
            <button type="button" className="mc-next-settings-filter" onClick={() => switchShell("cockpit")}>
              Try the new Mission Control
            </button>
            <p className="mc-next-settings-field-note">
              Opens the redesigned layout. Switch back any time from its settings menu.
            </p>
          </SettingsField>
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/settings/sections/GeneralSection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/settings/sections/GeneralSection.tsx apps/mission-control-next/src/features/native-routes/settings/sections/GeneralSection.test.tsx
git commit -m "feat: let operators try the new Mission Control from Settings"
```

---

### Task 9: Measure the cockpit in the UX lane

**Files:**
- Modify: `scripts/verification/lib/scenarios/ux-budgets-lane.mjs`
- Modify: `scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`

**Interfaces:**
- Produces:
  - `COCKPIT_ROUTES = ["/chat", "/inbox", "/work", "/library", "/system", "/__gallery"]`
  - One scenario per route, with id `ux-budgets.cockpit.<slug>`. Each scenario:
    - opens the route with `goatcitadel.ui.shell.v1=cockpit`
    - waits for `[data-cockpit-ready="true"]`
    - applies the cold-load checks (sonner toasts render as `[data-sonner-toast]`)
    - runs axe and fails on any serious or critical violation

- [ ] **Step 1: Write the failing wiring test**

Add to `ux-budgets-lane.test.mjs`, extending the existing import from `./ux-budgets-lane.mjs` with `COCKPIT_ROUTES`:

```js
  it("measures every cockpit area and the gallery", () => {
    assert.deepEqual(COCKPIT_ROUTES, ["/chat", "/inbox", "/work", "/library", "/system", "/__gallery"]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Export the list:

```js
export const COCKPIT_ROUTES = Object.freeze(["/chat", "/inbox", "/work", "/library", "/system", "/__gallery"]);
```

Add `axeSourcePath` to the destructured `deps`. Then, inside the `try` that owns `browser` and after the Chat-space loop, add:

```js
      for (const href of options.cockpitRoutes ?? COCKPIT_ROUTES) {
        const slug = href.replace(/[^a-z]+/gi, "-").replace(/^-|-$/g, "") || "root";
        await runScenario(
          context,
          { id: `ux-budgets.cockpit.${slug}`, lane: "ux-budgets", title: `Cockpit ${href}`, subsystem: "mission-control-ux" },
          async () => {
            const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
            await browserContext.addInitScript(() => {
              window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            });
            await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
            const page = await browserContext.newPage();
            try {
              await page.goto(buildVerificationUiUrl(stack.uiUrl, href), { waitUntil: "domcontentloaded" });
              await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
              await page.waitForTimeout(TOAST_SETTLE_MS);
              const toasts = evaluateToastBudget(await page.locator("[data-sonner-toast]").count());
              const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
              const rawCopy = findRawCopyTokens(await page.evaluate(collectVisibleUiText, COPY_EXEMPT_SELECTOR));
              await page.addScriptTag({ path: axeSourcePath });
              const serious = await page.evaluate(async () => {
                const results = await window.axe.run(document, {
                  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
                });
                return results.violations
                  .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
                  .map((violation) => violation.id);
              });
              const problems = [
                toasts.pass ? null : `${toasts.count} toast(s) after a cold load`,
                overflow.pass ? null : `overflows horizontally by ${overflow.overflow}px`,
                rawCopy.length === 0 ? null : `raw copy: ${rawCopy.map((finding) => finding.token).join(", ")}`,
                serious.length === 0 ? null : `accessibility: ${serious.join(", ")}`,
              ].filter(Boolean);
              if (problems.length > 0) {
                throw new Error(`ux-budgets cockpit ${href}: ${problems.join("; ")}`);
              }
              return { status: "passed", metrics: { toasts: toasts.count, overflow: overflow.overflow } };
            } finally {
              await browserContext.close();
            }
          },
        );
      }
```

- [ ] **Step 4: Run the unit test, then the lane**

Run: `node --test scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs`
Then: `pnpm verify:ux:budgets`
Expected: PASS, including every `ux-budgets.cockpit.*` scenario.

- [ ] **Step 5: Commit**

```bash
git add scripts/verification/lib/scenarios/ux-budgets-lane.mjs scripts/verification/lib/scenarios/ux-budgets-lane.test.mjs
git commit -m "test: measure the cockpit shell in the ux-budgets lane"
```

---

### Task 10: Phase exit

- [ ] **Step 1: Try both shells by hand in the dev server**

Start `mission-control-next` with `preview_start`. Open `/?shell=cockpit` and check that all of these work, in dark and light, and at 390px wide with the phone tabs:

- the sidebar
- Ctrl+K
- Ctrl+1 to Ctrl+5
- `/__gallery`

Then choose "Switch to classic Mission Control" from the sidebar's settings menu and confirm the classic shell loads.

- [ ] **Step 2: Run the phase validation**

Run the roadmap's per-phase validation list, then `node scripts/check-mission-control-next-cockpit-classes.mjs`. Expected: exit 0.

- [ ] **Step 3: Push and open the PR**

```bash
# First write the PR description (what changed, lane results before and after, anything left for the next phase) to "${TMPDIR:-/tmp}/ux-phase-1-pr.md".
git push -u origin ux/phase-1
gh pr create --title "UX phase 1: cockpit foundations behind a local preference" --body-file "${TMPDIR:-/tmp}/ux-phase-1-pr.md"
```

Screenshot baselines for cockpit screens start in Phase 2. That plan adds a cockpit visual lane after reading the current visual-regression lane's internals.
