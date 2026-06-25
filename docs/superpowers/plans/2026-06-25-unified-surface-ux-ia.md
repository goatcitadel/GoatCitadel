# Unified "Chat" Surface — UX/IA Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the three Chat/Cowork/Code nav areas into one auto-routing "Chat" surface with a mode-adaptive rail, an in-surface mode chip (resolved mode + 1-click override), and a pre-send "→ mode" preview with a code-path guard.

**Architecture:** Thin shell layer over the already-merged auto-router engine (#146/#147/#148). `mode` becomes a route field bridging the surface's resolved mode to the shell rail. The override re-uses the existing explicit-`mode` send path (`surfaceMode`). One new **read-only** gateway endpoint (`POST /api/v1/surface/classify`) calls the existing pure `classifySurfaceHeuristic` for the live preview — no trace, no persistence.

**Tech Stack:** TypeScript, React (mission-control-next + threaded-surface-core), Fastify + Zod (gateway), Vitest, pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-06-25-unified-surface-ux-ia-design.md`

**Worktree:** `F:\code\personal-ai\.claude\worktrees\unified-surface-shell` (branch `worktree-unified-surface-shell`, off `origin/main`). `pnpm install` done. Commit with `git commit --no-verify` (husky can't spawn here); no co-author trailer (global attribution-disabled preference).

---

## File structure / decomposition

**Phase 1 — Collapse (pure UI, no endpoint):**
- `apps/mission-control-next/src/app/route-model.ts` — `AppRoute.mode`, central collapse in `normalizeAppRoute`, `?mode=` parse/build, `buildModeRail(mode)`.
- `apps/mission-control-next/src/app/route-model.test.ts` — route tests.
- `apps/mission-control-next/src/app/MissionControlNextApp.tsx` — collapse `PRIMARY_NAV`, mode-keyed rail, mode bridge.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedModeChip.tsx` (new) — the chip component.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx` — header chip; drop cross-area buttons.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx` — composer kicker chip.
- `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx` — `modeOverride` state, outbound explicit-mode, `onResolvedModeChange` up-channel; extend surface props type.

**Phase 2 — Pre-flight (endpoint + guards):**
- `packages/contracts/src/chat.ts` (+ `index.ts`) — `SurfaceClassifyRequest`/`SurfaceClassifyResponse`.
- `apps/gateway/src/routes/surface.ts` (new) + `apps/gateway/src/app.ts` — the read-only `classify` route.
- `apps/gateway/src/routes/surface.test.ts` (new) — route test.
- `packages/mission-control-shared/src/api/chat.ts` — `classifySurfaceMode` client helper.
- `packages/threaded-surface-core/src/chat/useSurfaceClassifyPreview.ts` (new) — debounced, fail-open preview hook.
- chip + composer + controller host — live preview display + code-path guard.

---

## Conventions

- **Run scoped tests** from the worktree root. Vitest per package:
  - mc-next: `pnpm --filter @goatcitadel/mission-control-next test -- <pattern>`
  - core: `pnpm --filter @goatcitadel/threaded-surface-core test -- <pattern>`
  - gateway: `pnpm --filter @goatcitadel/gateway test -- <pattern>`
  - contracts: `pnpm --filter @goatcitadel/contracts test`
- **Verify the exact filter names first** (Step 0 below) — the `--filter` package names must match each `package.json`.
- `ChatMode = "chat" | "cowork" | "code"` (from `@goatcitadel/contracts`).

---

### Task 0: Baseline & filter names

- [ ] **Step 1: Confirm package filter names**

Run:
```bash
node -e "for (const p of ['apps/mission-control-next','packages/threaded-surface-core','apps/gateway','packages/contracts','packages/mission-control-shared']) console.log(p, '=>', require('./'+p+'/package.json').name)"
```
Record the four `name` values; use them in every `pnpm --filter` below (the plan assumes `@goatcitadel/<dir>` — fix if different).

- [ ] **Step 2: Baseline the files you'll touch compile/test green**

Run:
```bash
pnpm --filter @goatcitadel/mission-control-next test -- route-model
```
Expected: PASS (existing route tests). If the file/test doesn't exist yet, note it and continue (Task 1 creates tests).

---

## PHASE 1 — Collapse (pure UI)

### Task 1: `AppRoute.mode` field + central area collapse

**Files:**
- Modify: `apps/mission-control-next/src/app/route-model.ts`
- Test: `apps/mission-control-next/src/app/route-model.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `route-model.test.ts` (import what's needed at top: `parseAppRoute`, `buildAppHref`, `normalizeAppRoute`):
```ts
describe("unified surface mode field", () => {
  it("collapses /code to chat with mode=code", () => {
    const r = parseAppRoute("http://x/code?sessionId=s1");
    expect(r.area).toBe("chat");
    expect(r.mode).toBe("code");
    expect(r.sessionId).toBe("s1");
  });
  it("collapses /cowork (root) to chat with mode=cowork", () => {
    const r = parseAppRoute("http://x/cowork");
    expect(r.area).toBe("chat");
    expect(r.mode).toBe("cowork");
  });
  it("keeps /cowork/tasks as the Task Board route", () => {
    const r = parseAppRoute("http://x/cowork/tasks");
    expect(r.area).toBe("cowork");
    expect(r.section).toBe("tasks");
  });
  it("keeps /cowork/board as the Agent Board route", () => {
    const r = parseAppRoute("http://x/cowork/board");
    expect(r.area).toBe("cowork");
    expect(r.section).toBe("board");
  });
  it("reads ?mode= on the chat area", () => {
    expect(parseAppRoute("http://x/chat?mode=cowork").mode).toBe("cowork");
    expect(parseAppRoute("http://x/chat").mode).toBeUndefined();
  });
  it("ignores an invalid ?mode=", () => {
    expect(parseAppRoute("http://x/chat?mode=bogus").mode).toBeUndefined();
  });
  it("round-trips a code thread href", () => {
    expect(buildAppHref({ area: "chat", mode: "code", sessionId: "s9" }))
      .toBe("/chat?sessionId=s9&mode=code");
  });
  it("emits bare /chat for chat mode", () => {
    expect(buildAppHref({ area: "chat", mode: "chat" })).toBe("/chat");
    expect(buildAppHref({ area: "chat" })).toBe("/chat");
  });
  it("normalizes a stray area:code into chat+mode", () => {
    const n = normalizeAppRoute({ area: "code", sessionId: "s2" } as never);
    expect(n.area).toBe("chat");
    expect(n.mode).toBe("code");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- route-model`
Expected: FAIL (mode undefined / area not collapsed).

- [ ] **Step 3: Add `mode` to `AppRoute` and a `ChatMode` import**

In `route-model.ts`, add the import and field:
```ts
import type { ChatMode } from "@goatcitadel/contracts";
// ...
export interface AppRoute {
  area: PrimaryArea;
  mode?: ChatMode; // unified-surface conversation mode (chat area only)
  section?: CoworkSection | LibrarySection | OpsSection | SettingsSection;
  // ...rest unchanged
}
```
Add a helper near `isPrimaryArea`:
```ts
function isChatMode(value: string | undefined): value is ChatMode {
  return value === "chat" || value === "cowork" || value === "code";
}
```

- [ ] **Step 4: Centralize the collapse in `normalizeAppRoute`**

At the TOP of `normalizeAppRoute(route)`, before the existing `base` object, collapse stray code/cowork-root into chat+mode (keep cowork tasks/board):
```ts
export function normalizeAppRoute(route: AppRoute): AppRoute {
  // Unified surface: code + cowork(root/workspace) are modes of the chat area.
  if (route.area === "code") {
    return normalizeAppRoute({ ...route, area: "chat", mode: "code", section: undefined });
  }
  if (route.area === "cowork" && (!route.section || route.section === "workspace")) {
    return normalizeAppRoute({ ...route, area: "chat", mode: "cowork", section: undefined });
  }
  const base = { /* ...existing... */ };
  // ...existing branches...
  // In the final (chat/projects/default) return, carry mode through for chat:
  return { ...base, area: route.area, mode: route.area === "chat" ? route.mode : undefined };
}
```
(Keep the existing `cowork`/`library`/`ops`/`settings` branches; add `mode: undefined` is implicit for those since `base` omits it. Ensure the chat path carries `mode`.)

- [ ] **Step 5: Parse `?mode=` and collapse path in `parseAppRoute`**

In `parseAppRoute`, after computing `params`, before building `nextRoute`, read mode:
```ts
const rawMode = readParam(params, "mode");
const parsedMode = isChatMode(rawMode) ? rawMode : undefined;
```
Then include `mode: parsedMode` in the `normalizeAppRoute({...})` call (the normalize call already maps area `code`→chat etc., so `/code` returns `mode:"code"` even without a query). For the chat branch, pass `mode: parsedMode`.

- [ ] **Step 6: Serialize `?mode=` in `buildAppHref`**

In `buildAppHref`, after the existing `writeParam(...)` calls, add (before computing `path`):
```ts
if (next.area === "chat" && next.mode && next.mode !== "chat") {
  writeParam(params, "mode", next.mode);
}
```
The existing `path` for chat is `/${next.area}` → stays `/chat`; the query carries `?mode=`. (Order: existing params are written first, so `sessionId` precedes `mode`, matching the round-trip test.)

- [ ] **Step 7: Run tests, verify PASS**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- route-model`
Expected: PASS (all new + existing route tests).

- [ ] **Step 8: Commit**

```bash
git add apps/mission-control-next/src/app/route-model.ts apps/mission-control-next/src/app/route-model.test.ts
git commit --no-verify -m "feat(mc): add AppRoute.mode field + collapse code/cowork into chat (#136)"
```

---

### Task 2: `buildModeRail(mode)` — mode-adaptive rail items

**Files:**
- Modify: `apps/mission-control-next/src/app/route-model.ts`
- Test: `apps/mission-control-next/src/app/route-model.test.ts`

- [ ] **Step 1: Write failing tests**
```ts
describe("buildModeRail", () => {
  it("chat mode → Artifacts + Memory", () => {
    const ids = buildModeRail("chat").map((i) => i.id);
    expect(ids).toContain("chat-thread");
    expect(ids).toContain("chat-artifacts");
    expect(ids).toContain("chat-memory");
    expect(ids).toContain("chat-approvals");
  });
  it("cowork mode → Task Board + Agent Board", () => {
    const items = buildModeRail("cowork");
    const tasks = items.find((i) => i.id === "mode-tasks");
    expect(tasks?.area).toBe("cowork");
    expect(tasks?.section).toBe("tasks");
    expect(items.some((i) => i.id === "mode-board" && i.section === "board")).toBe(true);
  });
  it("code mode → Files + Runtime + Prompt Packs", () => {
    const items = buildModeRail("code");
    expect(items.some((i) => i.section === "files")).toBe(true);
    expect(items.some((i) => i.section === "runtime")).toBe(true);
    expect(items.some((i) => i.section === "prompt-packs")).toBe(true);
  });
  it("every mode rail ends with Approvals", () => {
    for (const m of ["chat", "cowork", "code"] as const) {
      expect(buildModeRail(m).some((i) => i.section === "approvals")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @goatcitadel/mission-control-next test -- route-model` → FAIL (`buildModeRail` not defined).

- [ ] **Step 3: Implement `buildModeRail`**

Add to `route-model.ts` (after `RAIL_ITEMS`). The chat-mode arm reuses the existing `RAIL_ITEMS.chat` entries; cowork/code arms point at the preserved native routes + Library/Ops cross-links:
```ts
const MODE_RAIL_THREAD: RailItem = {
  id: "chat-thread", label: "Thread",
  description: "The active conversation with artifacts and attachments close at hand.",
  area: "chat", preserveThread: true,
};
const MODE_RAIL_APPROVALS: RailItem = {
  id: "chat-approvals", label: "Approvals",
  description: "Review pending tool or risk decisions.",
  area: "ops", section: "approvals", preserveThread: true,
};

/** Mode-adaptive rail for the unified chat surface (route.mode keyed). */
export function buildModeRail(mode: ChatMode | undefined): RailItem[] {
  const m = mode ?? "chat";
  if (m === "cowork") {
    return [
      MODE_RAIL_THREAD,
      { id: "mode-tasks", label: "Task Board", description: "Planning, assigned, review, blocked, and done.", area: "cowork", section: "tasks" },
      { id: "mode-board", label: "Agent Board", description: "Agent posture and live board state.", area: "cowork", section: "board" },
      MODE_RAIL_APPROVALS,
    ];
  }
  if (m === "code") {
    return [
      MODE_RAIL_THREAD,
      { id: "mode-files", label: "Files", description: "Browse shared workspace files outside the active thread.", area: "library", section: "files" },
      { id: "mode-runtime", label: "Runtime", description: "Serving posture and spend while coding.", area: "ops", section: "runtime" },
      { id: "mode-prompt-packs", label: "Prompt Packs", description: "Quality gates and pack authoring.", area: "library", section: "prompt-packs" },
      MODE_RAIL_APPROVALS,
    ];
  }
  return [
    MODE_RAIL_THREAD,
    { id: "chat-artifacts", label: "Artifacts", description: "Jump to generated outputs from active work.", area: "library", section: "artifacts", preserveThread: true },
    { id: "chat-memory", label: "Memory", description: "Inspect what the system knows and what it learned.", area: "library", section: "memory" },
    MODE_RAIL_APPROVALS,
  ];
}
```

- [ ] **Step 4: Run, verify PASS** — `pnpm --filter @goatcitadel/mission-control-next test -- route-model` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/mission-control-next/src/app/route-model.ts apps/mission-control-next/src/app/route-model.test.ts
git commit --no-verify -m "feat(mc): mode-adaptive rail resolver buildModeRail (#136)"
```

---

### Task 3: Collapse `PRIMARY_NAV` + use mode-keyed rail in the shell

**Files:**
- Modify: `apps/mission-control-next/src/app/MissionControlNextApp.tsx`

- [ ] **Step 1: Collapse the primary nav**

At `MissionControlNextApp.tsx:100`, remove the `cowork` and `code` entries:
```ts
const PRIMARY_NAV: Array<{ area: PrimaryArea; icon: typeof Bot }> = [
  { area: "chat", icon: Bot },
  { area: "projects", icon: FolderKanban },
  { area: "library", icon: LibraryBig },
  { area: "ops", icon: Activity },
  { area: "settings", icon: SlidersHorizontal },
];
```

- [ ] **Step 2: Use `buildModeRail` for the chat area**

Find `const currentRailItems = RAIL_ITEMS[route.area];` (~:304). Replace with:
```ts
const currentRailItems =
  route.area === "chat" ? buildModeRail(route.mode) : RAIL_ITEMS[route.area];
```
Add `buildModeRail` to the existing `route-model` import block (~:68).

- [ ] **Step 3: Carry `mode` when jumping to the chat area**

In `buildPrimaryAreaRoute` (~:199), preserve `mode` for the chat area so the topbar "Chat" link keeps context:
```ts
const buildPrimaryAreaRoute = useCallback(
  (area: PrimaryArea): AppRoute => ({
    area,
    mode: area === "chat" ? route.mode : undefined,
    theme: route.theme,
    sessionId: area === "chat" ? route.sessionId : undefined,
    turnId: area === "chat" ? route.turnId : undefined,
    artifactId: area === "chat" ? route.artifactId : undefined,
  }),
  [route.artifactId, route.mode, route.sessionId, route.theme, route.turnId],
);
```
(`cowork`/`code` are no longer reachable as primary areas; the Task/Agent Board open via the cowork-mode rail items, which still build `{area:"cowork", section}`.)

- [ ] **Step 4: Verify the app type-checks and renders**

Run: `pnpm --filter @goatcitadel/mission-control-next build` (or `typecheck` script if present).
Expected: no type errors. (If `RAIL_ITEMS` is now unused for chat, it's still used for other areas + `getRouteLabel`; leave it.)

- [ ] **Step 5: Commit**
```bash
git add apps/mission-control-next/src/app/MissionControlNextApp.tsx
git commit --no-verify -m "feat(mc): single Chat nav entry + mode-adaptive rail wiring (#136)"
```

---

### Task 4: Surface→shell mode bridge (`onResolvedModeChange`)

**Files:**
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfaceRoute.tsx`
- Modify: `apps/mission-control-next/src/app/MissionControlNextApp.tsx` (`renderRouteContent`)
- Test: `packages/threaded-surface-core/src/MissionThreadedControllerHost.test.tsx`

- [ ] **Step 1: Write a failing test (controller emits resolved mode)**

In `MissionThreadedControllerHost.test.tsx`, add a test that renders the host unlocked (`lockSurface={false}`) with a selected session whose mode is `code` and asserts the `onResolvedModeChange` prop is called with `"code"`. Mirror the existing render harness in that file (reuse its mocks/wrappers); assert:
```tsx
const onResolvedModeChange = vi.fn();
// render host with lockSurface={false}, a session mode "code", onResolvedModeChange
await waitFor(() => expect(onResolvedModeChange).toHaveBeenCalledWith("code"));
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @goatcitadel/threaded-surface-core test -- MissionThreadedControllerHost` → FAIL (prop unused).

- [ ] **Step 3: Add the prop + emit on resolved-mode change**

In `MissionThreadedControllerHost.tsx`, add `onResolvedModeChange?: (mode: ChatMode) => void;` to the host props interface. After `currentSessionMode` is computed (~:953-957), emit on change:
```tsx
const lastEmittedModeRef = useRef<ChatMode | null>(null);
useEffect(() => {
  if (currentSessionMode && currentSessionMode !== lastEmittedModeRef.current) {
    lastEmittedModeRef.current = currentSessionMode;
    onResolvedModeChange?.(currentSessionMode);
  }
}, [currentSessionMode, onResolvedModeChange]);
```

- [ ] **Step 4: Thread the prop through `ThreadedSurfaceRoute`**

In `ThreadedSurfaceRoute.tsx`, add `onResolvedModeChange?: (mode: ChatMode) => void` to its props and pass it down to `MissionThreadedControllerHost`.

- [ ] **Step 5: Wire it in `renderRouteContent` (chat arm only)**

In `MissionControlNextApp.tsx` `renderRouteContent`, on the chat `LazyThreadedSurfaceRoute` (~:1144), add:
```tsx
onResolvedModeChange={(mode) =>
  input.navigate({ ...route, area: "chat", mode }, { replace: true })
}
```
(`renderRouteContent` receives `navigate`; this replaces the URL so the rail + deep-link reflect the resolved mode without a history entry.)

- [ ] **Step 6: Run, verify PASS** — core test green.

- [ ] **Step 7: Commit**
```bash
git add packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx packages/threaded-surface-core/src/MissionThreadedControllerHost.test.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedSurfaceRoute.tsx apps/mission-control-next/src/app/MissionControlNextApp.tsx
git commit --no-verify -m "feat(surface): bridge resolved mode to the shell route field (#136)"
```

---

### Task 5: Client mode override → explicit-mode send

**Files:**
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`
- Test: `packages/threaded-surface-core/src/chat/useChatOutboundExecution.test.tsx`

- [ ] **Step 1: Write a failing test (override forces explicit mode + disables auto-route)**

In `useChatOutboundExecution.test.tsx`, mirror the existing `Harness` (it already accepts `surfaceMode`). Add a test: unlocked surface, first turn, `surfaceMode="code"` (simulating an override) → the send payload carries `mode:"code"` and NO `autoRoute`:
```tsx
it("an override sends explicit mode and no autoRoute on the first turn", async () => {
  const sendSpy = captureSendPayload(); // reuse the file's existing fetch/send capture
  create(<Harness surfaceMode="code" />);
  await act(() => fireSend("build the parser"));
  expect(sendSpy.lastBody.mode).toBe("code");
  expect(sendSpy.lastBody.autoRoute).toBeUndefined();
});
```
(Use the file's existing send-capture mechanism; do not invent a new one.)

- [ ] **Step 2: Run, verify it PASSES already OR FAILS**

Run: `pnpm --filter @goatcitadel/threaded-surface-core test -- useChatOutboundExecution`
Expected: This likely **passes already** (the `surfaceMode ?? ...` path makes `surfaceMode="code"` → `effectiveMode="code"`, `shouldAutoRoute=false`). If it passes, this confirms the engine path; proceed to wire the override state. If it fails, fix the send path so an explicit `surfaceMode` disables auto-route (it should not need changes).

- [ ] **Step 3: Add `modeOverride` state and feed it to outbound only**

In `MissionThreadedControllerHost.tsx`:
```tsx
const [modeOverride, setModeOverride] = useState<ChatMode | null>(null);
```
Where `useChatOutboundExecution({ surfaceMode: ... })` is called (~:1199 area, `surfaceMode: executionSurfaceMode`), make the outbound surfaceMode honor the override on the unlocked surface:
```tsx
const executionSurfaceMode = lockSurface && surface ? surface : (modeOverride ?? undefined);
```
Leave `useChatSessionData({ surfaceMode: lockSurface && surface ? surface : undefined })` (~:912) UNCHANGED so the thread list still shows all modes.

- [ ] **Step 4: Expose override setter + current display mode on the active-session surface props**

Add to the surface props type (`MissionThreadedActiveSessionSurfaceProps`):
```ts
onModeOverride?: (mode: ChatMode) => void;
modeOverridePending?: ChatMode | null;
```
Populate them where the active-session props object is built (the object that already sets `mode`, `onNavigateSurface`, etc.):
```tsx
onModeOverride: (mode: ChatMode) => {
  setModeOverride(mode);
  onResolvedModeChange?.(mode); // update the shell rail immediately
},
modeOverridePending: modeOverride,
```
Clear the override after a successful turn re-pins prefs (in the existing post-turn `loadSessionCoreState`/prefs-refetch path): `setModeOverride(null)`.

- [ ] **Step 5: Run, verify PASS** — outbound + host tests green.

- [ ] **Step 6: Commit**
```bash
git add packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx packages/threaded-surface-core/src/chat/useChatOutboundExecution.test.tsx
git commit --no-verify -m "feat(surface): mode override drives explicit-mode send (#136)"
```

---

### Task 6: Mode chip component + header integration

**Files:**
- Create: `apps/mission-control-next/src/features/threaded-surface/ThreadedModeChip.tsx`
- Create: `apps/mission-control-next/src/features/threaded-surface/ThreadedModeChip.test.tsx`
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx`

- [ ] **Step 1: Write failing tests for the chip**
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { ThreadedModeChip } from "./ThreadedModeChip";

it("shows the resolved mode label", () => {
  render(<ThreadedModeChip mode="code" onOverride={() => {}} />);
  expect(screen.getByRole("button", { name: /code/i })).toBeInTheDocument();
});
it("calls onOverride when a different mode is picked", () => {
  const onOverride = vi.fn();
  render(<ThreadedModeChip mode="chat" onOverride={onOverride} />);
  fireEvent.click(screen.getByRole("button", { name: /chat/i }));
  fireEvent.click(screen.getByRole("menuitem", { name: /code/i }));
  expect(onOverride).toHaveBeenCalledWith("code");
});
it("renders an Auto preview when mode is unresolved", () => {
  render(<ThreadedModeChip mode={undefined} preview="cowork" onOverride={() => {}} />);
  expect(screen.getByText(/auto/i)).toBeInTheDocument();
  expect(screen.getByText(/cowork/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @goatcitadel/mission-control-next test -- ThreadedModeChip` → FAIL.

- [ ] **Step 3: Implement the chip**
```tsx
import type { ChatMode } from "@goatcitadel/contracts";
import { useState } from "react";

const MODES: ChatMode[] = ["chat", "cowork", "code"];
const LABEL: Record<ChatMode, string> = { chat: "Chat", cowork: "Cowork", code: "Code" };

export function ThreadedModeChip({
  mode, preview, onOverride, disabled,
}: {
  mode: ChatMode | undefined;
  preview?: ChatMode;
  onOverride: (mode: ChatMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const resolved = mode ?? "chat";
  const label = mode ? LABEL[mode] : `Auto${preview ? ` → ${LABEL[preview]}` : ""}`;
  return (
    <div className="mc-next-mode-chip">
      <button
        type="button"
        className="mc-next-mode-chip-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>◇</span> {label}
      </button>
      {open ? (
        <div role="menu" className="mc-next-mode-chip-menu">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
              aria-current={m === resolved}
              className={`mc-next-mode-chip-item${m === resolved ? " active" : ""}`}
              onClick={() => { setOpen(false); if (m !== mode) onOverride(m); }}
            >
              {LABEL[m]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```
Add minimal styles to the surface's existing CSS (e.g. `styles/*.css`): a small inline-flex chip + absolutely-positioned menu. Match existing `mc-next-threaded-*` token usage.

- [ ] **Step 4: Run, verify PASS** — chip tests green.

- [ ] **Step 5: Replace the header label + cross-area buttons with the chip**

In `ThreadedSurfacePage.tsx`:
- Replace the static `<p>{MODE_META[surface].label}</p>` (~:705) with `<ThreadedModeChip mode={props.mode} onOverride={(m) => props.onModeOverride?.(m)} />`.
- Remove the `actions` list that builds "Continue in Cowork / Open in Code / Back to Chat" (~:665-678) and its render (~:744-749) — these were cross-area jumps now subsumed by the chip. Keep the `onToggleCodeWorkbench` button and panel switcher.
- Import `ThreadedModeChip`.

- [ ] **Step 6: Run scoped surface tests, verify PASS**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- ThreadedSurfacePage`
Expected: PASS. Update any snapshot/string assertions that referenced "Open in Code"/"Continue in Cowork" (those affordances are intentionally gone — fix the assertions, not the behavior).

- [ ] **Step 7: Commit**
```bash
git add apps/mission-control-next/src/features/threaded-surface/ThreadedModeChip.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedModeChip.test.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx
git commit --no-verify -m "feat(mc): in-surface mode chip with 1-click override (#136)"
```

---

### Task 7: Composer kicker chip mirror

**Files:**
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx`

- [ ] **Step 1: Replace the static kicker with the chip**

At `ThreadedComposer.tsx:679`, replace `<p className="mc-next-composer-kicker">{getSurfaceLabel(props.mode)}</p>` with:
```tsx
<ThreadedModeChip
  mode={props.mode}
  preview={props.modePreview}
  onOverride={(m) => props.onModeOverride?.(m)}
  disabled={props.sending}
/>
```
Import `ThreadedModeChip`. (`props.modePreview` is added in Phase 2; until then it's `undefined`, so the chip shows the resolved mode — safe.)

- [ ] **Step 2: Run, verify PASS**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- ThreadedComposer`
Expected: PASS (fix any kicker-label assertions). `getSurfaceLabel` may become unused — if so, remove it.

- [ ] **Step 3: Commit**
```bash
git add apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx
git commit --no-verify -m "feat(mc): mirror mode chip in the composer kicker (#136)"
```

---

### Task 8: Phase 1 verification (tests + VISUAL)

- [ ] **Step 1: Run all touched-package tests**
```bash
pnpm --filter @goatcitadel/mission-control-next test
pnpm --filter @goatcitadel/threaded-surface-core test
```
Expected: green. Fix regressions (notably any test asserting 3 separate nav areas or the removed cross-area buttons).

- [ ] **Step 2: VISUAL verification (required — UI shell change)**

Launch the app (use the `run` skill or the project's dev command) and confirm with screenshots:
- Topbar shows a single **Chat** entry (no Cowork/Code).
- Rail shows **Artifacts/Memory** for a chat thread; opening a cowork thread shows **Task Board/Agent Board**; a code thread shows **Files/Runtime/Prompt Packs**; Approvals always present.
- The header + composer show the **mode chip**; picking a different mode switches the rail and the next send uses that mode.
- Deep links: `/code` and `/cowork` land on the unified surface with the right mode; `/cowork/tasks` still opens the Task Board.

Capture screenshots of the three rail states + the chip dropdown.

- [ ] **Step 3: Commit any visual-fix tweaks**
```bash
git add -A && git commit --no-verify -m "fix(mc): phase-1 unified-surface visual polish (#136)"
```

---

## PHASE 2 — Pre-flight (classify endpoint + guards)

### Task 9: Classify contracts

**Files:**
- Modify: `packages/contracts/src/chat.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/chat.test.ts` (or the nearest existing contracts test) — optional type-only; a compile check suffices.

- [ ] **Step 1: Add the DTOs**

In `chat.ts` (near `RoutingPreflightRequest`):
```ts
export interface SurfaceClassifyRequest {
  prompt: string;
  workspaceId?: string;
  citadelId?: string;
  hasBoundProject?: boolean;
}
export interface SurfaceClassifyResponse {
  mode: ChatMode;
  confidence: number; // 0..1
  source: "heuristic" | "judge";
  rationale: string;
  alternatives: ChatMode[];
}
```
Confirm `index.ts` already `export * from "./chat.js"` (it does) — no change needed.

- [ ] **Step 2: Build contracts**

Run: `pnpm --filter @goatcitadel/contracts build`
Expected: no type errors.

- [ ] **Step 3: Commit**
```bash
git add packages/contracts/src/chat.ts
git commit --no-verify -m "feat(contracts): SurfaceClassify request/response DTOs (#136)"
```

---

### Task 10: Read-only `POST /api/v1/surface/classify` gateway route

**Files:**
- Create: `apps/gateway/src/routes/surface.ts`
- Create: `apps/gateway/src/routes/surface.test.ts`
- Modify: `apps/gateway/src/app.ts` (register the route)

- [ ] **Step 1: Write a failing route test**

Mirror an existing route test in `apps/gateway/src/routes/*.test.ts` (build the Fastify app the way they do). Assert:
```ts
it("classifies an explicit code prompt as code (read-only)", async () => {
  const res = await app.inject({ method: "POST", url: "/api/v1/surface/classify",
    payload: { prompt: "fix the repo and run tests", hasBoundProject: true } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.mode).toBe("code");
  expect(body.source).toBe("heuristic");
});
it("defaults an empty prompt to chat", async () => {
  const res = await app.inject({ method: "POST", url: "/api/v1/surface/classify", payload: { prompt: "" } });
  expect(res.json().mode).toBe("chat");
});
it("rejects a missing prompt with 400", async () => {
  const res = await app.inject({ method: "POST", url: "/api/v1/surface/classify", payload: {} });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @goatcitadel/gateway test -- surface` → FAIL (404/route missing).

- [ ] **Step 3: Implement the route (read-only — heuristic only, no trace/persist)**
```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SurfaceClassifyResponse } from "@goatcitadel/contracts";
import { classifySurfaceHeuristic } from "../services/surface-router-heuristics.js";

const bodySchema = z.object({
  prompt: z.string(),
  workspaceId: z.string().trim().optional(),
  citadelId: z.string().trim().optional(),
  hasBoundProject: z.boolean().optional(),
});

export async function surfaceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/v1/surface/classify", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const c = classifySurfaceHeuristic(parsed.data.prompt, {
      hasBoundProject: parsed.data.hasBoundProject ?? false,
    });
    const result: SurfaceClassifyResponse = {
      mode: c.mode, confidence: c.confidence, source: c.source,
      rationale: c.rationale, alternatives: c.alternatives,
    };
    return reply.code(200).send(result);
  });
}
```
Register in `app.ts` next to the other `await app.register(...)` calls:
```ts
import { surfaceRoutes } from "./routes/surface.js";
// ...
await app.register(surfaceRoutes);
```

- [ ] **Step 4: Run, verify PASS** — `pnpm --filter @goatcitadel/gateway test -- surface` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/routes/surface.ts apps/gateway/src/routes/surface.test.ts apps/gateway/src/app.ts
git commit --no-verify -m "feat(gateway): read-only surface classify endpoint (#136)"
```

---

### Task 11: Client `classifySurfaceMode` helper

**Files:**
- Modify: `packages/mission-control-shared/src/api/chat.ts`

- [ ] **Step 1: Add the helper (mirror `createChatProject`)**
```ts
import type { SurfaceClassifyRequest, SurfaceClassifyResponse } from "@goatcitadel/contracts";

export async function classifySurfaceMode(input: SurfaceClassifyRequest): Promise<SurfaceClassifyResponse> {
  return request<SurfaceClassifyResponse>("/api/v1/surface/classify", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
```

- [ ] **Step 2: Build the package**

Run: `pnpm --filter @goatcitadel/mission-control-shared build`
Expected: no type errors.

- [ ] **Step 3: Commit**
```bash
git add packages/mission-control-shared/src/api/chat.ts
git commit --no-verify -m "feat(mc-shared): classifySurfaceMode client helper (#136)"
```

---

### Task 12: Debounced, fail-open preview hook

**Files:**
- Create: `packages/threaded-surface-core/src/chat/useSurfaceClassifyPreview.ts`
- Create: `packages/threaded-surface-core/src/chat/useSurfaceClassifyPreview.test.tsx`

- [ ] **Step 1: Write failing tests**
```tsx
// Mock classifySurfaceMode; render the hook; assert:
it("returns the predicted mode for a new thread after debounce", async () => { /* ... resolves to "code" */ });
it("is inert when a thread mode is already resolved (existing thread)", async () => { /* never calls classify */ });
it("fails open: classify error → preview undefined, no throw", async () => { /* ... */ });
```
Use the package's existing hook-test harness (`create(...)`/`act`) as in `useChatRoutePreflight.test.tsx`.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**
```tsx
import { useEffect, useRef, useState } from "react";
import type { ChatMode } from "@goatcitadel/contracts";
import { classifySurfaceMode } from "@goatcitadel/mission-control-shared/api/chat";

export function useSurfaceClassifyPreview(input: {
  draft: string;
  enabled: boolean; // true only for a new thread with no resolved mode
  workspaceId?: string;
  hasBoundProject: boolean;
}): ChatMode | undefined {
  const [preview, setPreview] = useState<ChatMode | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!input.enabled || input.draft.trim().length < 3) { setPreview(undefined); return; }
    if (timer.current) clearTimeout(timer.current);
    let cancelled = false;
    timer.current = setTimeout(() => {
      classifySurfaceMode({
        prompt: input.draft, workspaceId: input.workspaceId, hasBoundProject: input.hasBoundProject,
      })
        .then((r) => { if (!cancelled) setPreview(r.mode); })
        .catch(() => { if (!cancelled) setPreview(undefined); }); // fail-open
    }, 350);
    return () => { cancelled = true; if (timer.current) clearTimeout(timer.current); };
  }, [input.draft, input.enabled, input.workspaceId, input.hasBoundProject]);
  return preview;
}
```

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit**
```bash
git add packages/threaded-surface-core/src/chat/useSurfaceClassifyPreview.ts packages/threaded-surface-core/src/chat/useSurfaceClassifyPreview.test.tsx
git commit --no-verify -m "feat(surface): debounced fail-open classify preview hook (#136)"
```

---

### Task 13: Wire live preview into the chip

**Files:**
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`

- [ ] **Step 1: Call the hook + expose `modePreview` on surface props**

In the host, compute:
```tsx
const isNewUnroutedThread = !selectedSessionId || (threadController... turns.length === 0);
const modePreview = useSurfaceClassifyPreview({
  draft, // the composer draft already tracked in the host
  enabled: !lockSurface && !modeOverride && isNewUnroutedThread,
  workspaceId,
  hasBoundProject: !codeModeNeedsProjectBinding ? true : false,
});
```
Add `modePreview?: ChatMode` to `MissionThreadedActiveSessionSurfaceProps` and set it on the active-session props object: `modePreview`.

- [ ] **Step 2: Run scoped tests, verify PASS** — host + composer tests still green; the chip now shows `Auto → <preview>` on a new thread.

- [ ] **Step 3: Commit**
```bash
git add packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx
git commit --no-verify -m "feat(surface): live mode preview in the chip for new threads (#136)"
```

---

### Task 14: Code-path pre-send guard

**Files:**
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx` (or the existing pre-send guard hook `useMissionControlSurfaceState`/`useChatDelegationPolicyActions` where `codeModeNeedsProjectBinding` is consumed)
- Test: the same package's existing surface-state/outbound tests

- [ ] **Step 1: Write failing tests**
```tsx
it("predicted code + unbound project → surfaces a connect-project prompt before send", async () => { /* ... */ });
it("predicted code + bound project → sends straight through", async () => { /* ... */ });
it("predicted code + low confidence → surfaces a Run-as-Code confirm before send", async () => { /* ... */ });
```
(Drive these via the preview value + `codeModeNeedsProjectBinding` + a confidence value returned from the hook — extend `useSurfaceClassifyPreview` to also return `confidence` if the confirm needs it; keep a single `THRESHOLD` constant shared with the chip.)

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement the guard at the send boundary**

In the send handler, before dispatching the outbound item, if `modePreview === "code"`:
- and `codeModeNeedsProjectBinding` → set a `pendingBindPrompt` state that the surface renders (reuse the existing binding affordance / `CodeWorkbenchPanel` bind flow); block the send until bound or the user picks "send as chat".
- else if `previewConfidence < THRESHOLD` → set a `pendingCodeConfirm` state; render an inline "Run as Code?" confirm with Confirm/"Send as chat" actions.
Chat/cowork predictions → no guard. Always **fail-open**: if there's no preview (classify failed), no guard — normal auto-route.

Add the new optional surface props the surface renders against:
```ts
pendingCodeConfirm?: boolean;
onConfirmCode?: () => void;
onSendAsChat?: () => void;
pendingBindPrompt?: boolean;
```

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit**
```bash
git add packages/threaded-surface-core/src/ apps/mission-control-next/src/features/threaded-surface/
git commit --no-verify -m "feat(surface): code-path connect/confirm guard before a code turn (#136)"
```

---

### Task 15: Phase 2 verification (tests + VISUAL)

- [ ] **Step 1: Full touched-package test sweep**
```bash
pnpm --filter @goatcitadel/gateway test -- surface
pnpm --filter @goatcitadel/threaded-surface-core test
pnpm --filter @goatcitadel/mission-control-next test
pnpm --filter @goatcitadel/contracts build
```
Expected: green.

- [ ] **Step 2: VISUAL verification**

With the app running, on a NEW thread type a code-ish prompt and confirm the chip shows **Auto → Code** before send; with no project bound, confirm the **connect-project** prompt appears; bind (or "send as chat") and confirm the turn proceeds. Type an ambiguous low-confidence code prompt and confirm the **Run as Code?** inline confirm. Confirm classify failure (e.g. block the endpoint) leaves typing/sending unaffected (fail-open). Screenshot each.

- [ ] **Step 3: Commit polish**
```bash
git add -A && git commit --no-verify -m "fix(mc): phase-2 pre-flight visual polish (#136)"
```

---

## Final: branch wrap-up

- [ ] **Step 1: Re-read the spec; confirm each in-scope item maps to a shipped task** (U1–U6, §3 scope). Note any gap.
- [ ] **Step 2: Run the broadest practical verification** (the package test sweeps above + a typecheck/lint of touched packages).
- [ ] **Step 3:** Use **superpowers:finishing-a-development-branch** to open the PR (base `main`; relates to #136/#146/#147/#148; separate from the workspace-capability-scoping thread). Include the Phase-1 + Phase-2 screenshots in the PR body.

---

## Self-review notes (author)

- **Spec coverage:** U1 (name=Chat)→Task 3; U2 (mode-adaptive rail)→Tasks 2–3; U3 (preserve-and-redirect)→Task 1; U4 (mode route field + bridge)→Tasks 1,4; U5 (classify + preview + code guard)→Tasks 9–14; U6 (keep union)→Task 1 (collapse via normalize, types retained). Visual verification→Tasks 8,15.
- **Type consistency:** `ChatMode` everywhere; chip prop `onOverride`/host prop `onModeOverride`; preview is `ChatMode | undefined`; classify DTO field names match between contract, route, client, and hook.
- **Risk flags:** Tasks 4/5/13/14 touch the large `MissionThreadedControllerHost.tsx` — read the actual call sites (anchors given) before editing; the test-first step guards behavior. Task 5 Step 2 may already pass (confirms, doesn't change, the engine path). Keep `RAIL_ITEMS.chat` for `getRouteLabel`/`getRouteDescription` fallbacks even though the shell uses `buildModeRail` for rendering.
