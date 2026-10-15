# Gap Closure WS1 — Quick Wins and Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead legacy surface auto-router, make the active-hours timezone actually apply, let SQLite async transactions nest, make add-on launch data-driven, and correct the stale gap docs.

**Architecture:** Five independent, small changes in one worktree and one PR, one commit per task. None of them changes a stored data format. The `autoRoute` contract field stays deprecated and ignored, because stored durable chat payloads require it.

**Tech Stack:** TypeScript, vitest (gateway), `node:test` via `tsx --test` (storage).

**Spec:** [2026-10-15-gap-closure-program.md](2026-10-15-gap-closure-program.md), section WS1.

## Global Constraints

- **Worktree:** start a new one from `origin/main`:
  ```powershell
  git -C C:\personal-ai worktree add .worktrees/gap-ws1 -b fix/gap-ws1-quick-wins origin/main
  ```
  Never edit `C:\personal-ai` itself. Never `git stash`.
- Gateway tests: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`.
- Storage tests: `pnpm --filter @goatcitadel/storage exec tsx --test <file>`.
- Run `prettier --write` only on the files you changed.
- Final proof before the PR: `pnpm typecheck`, `pnpm verify:fast`, `pnpm docs:check`, `git diff --check`.

## Review Focus

1. **Stored durable chat payloads written by the old router** carry `autoRoute:false` plus a `surfaceDerivation`, and they must still reconstruct. Pinned in Task 1 Step 7.
2. **A legacy client that still sends `autoRoute:true`** must still get `mode:"chat"` and `autoRoute:false`, and must not cause an extra preference write per turn. Pinned in Task 1 Step 1.
3. **An invalid IANA zone in stored active hours** (e.g. `"Mars/Base"`) must fall back to host time and must not throw. Pinned in Task 2 Step 1.
4. **A failing nested SQLite transaction** must roll back only its own work and leave the outer transaction usable. Pinned in Task 3 Step 1.
5. **Concurrent nested transactions on the same SQLite transaction client** (e.g. inside `Promise.all`) must be rejected loudly, never interleaved. Pinned in Task 3 Step 1.

---

### Task 1: Retire the legacy surface auto-router

**Files:**
- Modify: `apps/gateway/src/services/surface-router-entry.ts`
- Modify: `apps/gateway/src/services/surface-router-entry.test.ts`
- Delete: `apps/gateway/src/services/surface-router-service.ts`, `surface-router-judge.ts`, `surface-router-heuristics.ts`, and their `.test.ts` files
- Delete: `apps/gateway/src/routes/surface.ts`, `apps/gateway/src/routes/surface.test.ts`
- Modify: `apps/gateway/src/app.ts` (the surface route import and registration, ~L92 and ~L476)
- Modify: `apps/gateway/src/routes/route-access.ts` (~L81-85) and `route-access.test.ts`
- Modify: `apps/gateway/src/services/gateway-service.ts` (imports ~L118-119; the `surfaceRouter:` and `recordSurfaceRouteOverrideSignal:` host fields ~L3732-3748)
- Modify: `apps/gateway/src/services/chat-turn-runtime-host-composition.ts` (~L271-274, ~L294-297)
- Modify: `apps/gateway/src/services/chat-turn-entry-service.ts` (imports ~L59-62, host fields ~L204-208, wiring ~L649-666)
- Modify: `apps/gateway/src/services/improvement-service.ts`: delete `recordSurfaceRouteOverrideSignal` (~L1463), `listSurfaceRouteOverrideExemplars` (~L1489) and their interfaces (~L402, ~L413). Edit `improvement-service.test.ts` (~L51-234, ~L854) and `improvement-service.loop43.test.ts` (~L45).
- Modify: `apps/gateway/src/services/gateway-service.chat-turn-runtime-host.test.ts` (~L18/45/68/97)
- Modify: drop `GOATCITADEL_SURFACE_ROUTER_JUDGE_ENABLED` from the env lists in `discord-inbound-admission.integration.test.ts` (~L25, ~L309) and `llama-cpp-setup.integration.test.ts` (~L20, ~L106)
- Delete: `classifySurfaceMode` in `packages/mission-control-shared/src/api/chat.ts` (~L1095); `packages/threaded-surface-core/src/chat/useSurfaceClassifyPreview.ts` and its test
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx` (~L80, ~L475-478) and its test
- Modify: delete the `autoRouteActive` prop from `createChatActiveSessionPresentation.ts` (~L155/214/375), `createChatRunControlProps.ts` (~L26-27/50/71/113), `MissionControlActiveSessionSurface.tsx` (~L397-400), `apps/mission-control-next/src/features/threaded-surface/ThreadConversationSurface.tsx` (~L89) and `ThreadedComposer.tsx` (~L597)
- Modify: delete the `preview?: SurfaceClassifyResponse` prop from `ThreadedModeControl.tsx` and its test
- Modify: `packages/threaded-surface-core/src/chat/useChatOutboundExecution.ts`. Delete `shouldAutoRouteSend` (~L60), `const shouldAutoRoute = false` (~L479) and the conditional `autoRoute: true` spreads (~L981-982, ~L1075-1076). Delete `useChatOutboundExecution.autoroute.test.ts`.
- Modify: `packages/contracts/src/chat.ts`. Delete `SurfaceClassifyRequest` / `SurfaceClassifyResponse` (~L2134-2150). Mark `autoRoute` (~L2016-2020) with `/** @deprecated Ignored; Chat is the only surface. Kept so stored durable turn payloads stay readable. */`.
- **Keep unchanged:** `packages/contracts/src/durable-chat-turn-payload.ts`, `packages/storage/src/session-mutation-admission-repo.ts`, `session-control-service.ts` `deriveChatTurnSurfaceDerivation` / `reconstructAdmittedChatTurnRequest`, and `chat-turn-execution-profile.ts` L49.
- Docs: add a banner to `docs/superpowers/specs/2026-06-24-unified-surface-auto-router-design.md`, `docs/superpowers/specs/2026-06-25-unified-surface-ux-ia-design.md` and `docs/superpowers/plans/2026-06-24-unified-surface-auto-router-gateway-core.md`.

**Interfaces:**
- Produces: `applyAutoRouteToInput(host: AutoRouteHost, sessionId: string, input: ChatSendMessageRequest): Promise<ChatSendMessageRequest>`. `AutoRouteHost` shrinks to `{ readChatSessionMode?, persistChatSessionMode? }`.
- `ModeOverrideHost` shrinks to `{ readChatSessionMode?, persistChatSessionMode? }`.
- `applySurfaceRoutingPreflight` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Replace `makeHost` and the `applyAutoRouteToInput` describe block in `surface-router-entry.test.ts` with:

```ts
function makeHost(overrides: Record<string, unknown> = {}) {
  return {
    readChatSessionMode: vi.fn(async () => undefined as string | undefined),
    persistChatSessionMode: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("applyAutoRouteToInput", () => {
  it("normalizes a legacy autoRoute turn to chat without any classifier", async () => {
    const host = makeHost();
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "run tests in the repo", autoRoute: true });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("does not rewrite the pinned mode when the session is already chat", async () => {
    const host = makeHost({ readChatSessionMode: vi.fn(async () => "chat") });
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "hi", autoRoute: true });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).not.toHaveBeenCalled();
  });

  it("repairs a persisted legacy sticky mode", async () => {
    const host = makeHost({ readChatSessionMode: vi.fn(async () => "code") });
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "hi", autoRoute: true });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });

  it("does nothing when autoRoute is not set and no mode is given", async () => {
    const host = makeHost();
    const input = { content: "hi" };
    expect(await applyAutoRouteToInput(host as never, "s1", input)).toBe(input);
    expect(host.persistChatSessionMode).not.toHaveBeenCalled();
  });

  it("normalizes an explicit legacy mode to chat", async () => {
    const host = makeHost();
    const out = await applyAutoRouteToInput(host as never, "s1", { content: "hi", mode: "code" as never });
    expect(out).toMatchObject({ mode: "chat", autoRoute: false });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
  });
});
```

Delete the `hashPromptFeatures` import and its describe block (~L128). In the `applySurfaceRoutingPreflight` block, delete "calls onError and returns original input when router throws" and replace it with:

```ts
  it("calls onError and returns original input when persisting the mode throws", async () => {
    const onError = vi.fn();
    const host = makeHost({ persistChatSessionMode: vi.fn(async () => { throw new Error("boom"); }) });
    const input = { content: "hi", autoRoute: true };
    expect(await applySurfaceRoutingPreflight(host as never, "s1", input, onError)).toBe(input);
    expect(onError).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/surface-router-entry.test.ts --maxWorkers=2`

Expected: FAIL. "normalizes a legacy autoRoute turn…" gets `autoRoute: true` back, because the current code returns the input unchanged when `host.surfaceRouter` is missing.

- [ ] **Step 3: Rewrite `surface-router-entry.ts`**

Replace the whole file with:

```ts
import type { ChatMode, ChatSendMessageRequest } from "@goatcitadel/contracts";

export interface AutoRouteHost {
  readChatSessionMode?(sessionId: string): Promise<ChatMode | undefined>;
  persistChatSessionMode?(sessionId: string, mode: ChatMode): Promise<void>;
}

export type ModeOverrideHost = AutoRouteHost;

const CHAT_ONLY = { mode: "chat", autoRoute: false } as const;

/**
 * Chat is the only conversation surface. Legacy `mode`/`autoRoute` inputs are
 * normalized to `{ mode: "chat", autoRoute: false }` and a stale persisted mode
 * is re-pinned to chat. The `autoRoute:false` marker is kept on purpose: stored
 * durable surface derivations (durable-chat-turn-payload.ts) require it.
 */
export async function applyAutoRouteToInput(
  host: AutoRouteHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): Promise<ChatSendMessageRequest> {
  if (input.mode !== undefined && input.mode !== "chat") {
    await host.persistChatSessionMode?.(sessionId, "chat");
    return { ...input, ...CHAT_ONLY };
  }
  if (!input.autoRoute || input.mode !== undefined) {
    return input.mode === undefined ? input : { ...input, mode: "chat" };
  }
  const persistedMode = await host.readChatSessionMode?.(sessionId);
  if (persistedMode !== "chat") {
    await host.persistChatSessionMode?.(sessionId, "chat");
  }
  return { ...input, ...CHAT_ONLY };
}

/** Re-pin a stale persisted legacy mode to chat when the client sends an explicit mode. */
export async function recordModeOverrideIfChanged(
  host: ModeOverrideHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): Promise<void> {
  if (input.mode === undefined || !host.readChatSessionMode || !host.persistChatSessionMode) {
    return;
  }
  const persistedMode = await host.readChatSessionMode(sessionId);
  if (persistedMode !== undefined && persistedMode !== "chat") {
    await host.persistChatSessionMode(sessionId, "chat");
  }
}

/**
 * Normalize the send turn's surface fields, error-isolated. On any failure,
 * calls onError and returns the input unchanged so the turn always proceeds.
 */
export async function applySurfaceRoutingPreflight(
  host: AutoRouteHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  onError?: (error: unknown) => void,
): Promise<ChatSendMessageRequest> {
  try {
    const routed = await applyAutoRouteToInput(host, sessionId, input);
    await recordModeOverrideIfChanged(host, sessionId, routed);
    return routed;
  } catch (error) {
    onError?.(error);
    return input;
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/surface-router-entry.test.ts --maxWorkers=2`

Expected: PASS.

- [ ] **Step 5: Delete the classifier, the route and the client plumbing**

Work through the "Delete" and "Modify" entries in the Files list above. After each file, run:

```bash
git grep -n -E "surfaceRouter|SurfaceRouterService|buildSurfaceRouterJudge|classifySurfaceHeuristic|SurfaceClassify|classifySurfaceMode|useSurfaceClassifyPreview|autoRouteActive|shouldAutoRoute|recordSurfaceRouteOverrideSignal|listSurfaceRouteOverrideExemplars|SURFACE_ROUTER_JUDGE|hashPromptFeatures" -- apps packages
```

Expected when finished: no matches. Leave the deprecated `autoRoute` field and the durable-payload readers alone.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`

Expected: PASS. Any error points to a leftover reference; remove it.

- [ ] **Step 7: Pin stored-payload compatibility**

In `apps/gateway/src/services/session-control-service.test.ts` (near the existing derivation tests, ~L655), add a case that builds a stored v1 payload. Its `originalRequest` must have `{ content: "x", autoRoute: true }` and its `surfaceDerivation` must be `{ version: 1, originalMode: undefined, originalAutoRoute: true, effectiveMode: "chat", effectiveAutoRoute: false }`. Assert that `reconstructAdmittedChatTurnRequest` returns `{ content: "x", autoRoute: true }` without throwing. Copy the fixture builder that the surrounding tests in that file already use.

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/session-control-service.test.ts src/services/surface-router-entry.test.ts src/services/improvement-service.test.ts src/routes/route-access.test.ts --maxWorkers=2`

Expected: PASS.

- [ ] **Step 8: Run the UI package tests**

Run: `pnpm --filter @goatcitadel/threaded-surface-core exec vitest run --maxWorkers=2`

Then: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface --maxWorkers=2`

Expected: PASS.

- [ ] **Step 9: Add the superseded banners**

Add this line under the H1 of each of the three auto-router docs:

```markdown
> **Superseded (2026-10-15):** Chat is the only conversation surface. The surface classifier, LLM judge and `/api/v1/surface/classify` were removed; `autoRoute` survives only as a deprecated, ignored field for stored durable payloads.
```

- [ ] **Step 10: Commit**

```bash
git add -A apps/gateway/src packages docs/superpowers
git commit -m "refactor: retire legacy surface auto-router after chat unification"
```

Before running this, check `git status` and make sure nothing outside this task's files is staged.

---

### Task 2: Make the active-hours timezone actually apply

**Files:**
- Modify: `apps/gateway/src/services/gateway/commitment-sweep-service.ts` (`ActiveHoursWindow` ~L19, `isWithinActiveHours` ~L139)
- Modify: `apps/gateway/src/services/gateway/heartbeat-service.ts` (`toActiveHoursWindow` ~L213)
- Modify: `apps/gateway/src/services/chat-proactive-service.ts` (`toActiveHoursWindow` ~L2931)
- Modify: `packages/storage/src/session-autonomy-prefs-repo.ts` (doc comment ~L25-29)
- Test: `apps/gateway/src/services/gateway/commitment-sweep-service.test.ts`

**Interfaces:**
- Produces: `ActiveHoursWindow { startHour: number; endHour: number; tz?: string }`. `isWithinActiveHours(now: Date, window: ActiveHoursWindow): boolean` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("isWithinActiveHours", …)`:

```ts
  it("evaluates the window in the session timezone when tz is set", () => {
    const noonUtc = new Date("2026-06-22T12:00:00.000Z");
    // 21:00 in Tokyo (UTC+9) -> inside 8-22.
    expect(isWithinActiveHours(noonUtc, { startHour: 8, endHour: 22, tz: "Asia/Tokyo" })).toBe(true);
    // 05:00 in Los Angeles (UTC-7 in June) -> outside 8-22.
    expect(isWithinActiveHours(noonUtc, { startHour: 8, endHour: 22, tz: "America/Los_Angeles" })).toBe(false);
  });

  it("handles midnight in the session timezone", () => {
    const midnightTokyo = new Date("2026-06-22T15:00:00.000Z");
    expect(isWithinActiveHours(midnightTokyo, { startHour: 0, endHour: 1, tz: "Asia/Tokyo" })).toBe(true);
  });

  it("falls back to host time for an unknown timezone", () => {
    const now = pinDate(10);
    expect(isWithinActiveHours(now, { startHour: 8, endHour: 22, tz: "Mars/Base" })).toBe(
      isWithinActiveHours(now, { startHour: 8, endHour: 22 }),
    );
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/gateway/commitment-sweep-service.test.ts --maxWorkers=2`

Expected: FAIL. TypeScript rejects `tz`, or the Tokyo/LA assertions fail on a host that isn't in those zones.

- [ ] **Step 3: Implement**

In `commitment-sweep-service.ts`, replace the interface and the function:

```ts
export interface ActiveHoursWindow {
  /** Inclusive start hour [0, 23] in `tz` (host-local when absent). */
  startHour: number;
  /** Exclusive end hour [1, 24]. Supports overnight windows (start > end). */
  endHour: number;
  /** Optional IANA timezone. Unknown values fall back to the host's local hour. */
  tz?: string;
}

/**
 * Pure active-hours check against the hour of `now` in `window.tz` (host-local
 * when absent or invalid). Supports overnight windows (e.g. `{ startHour: 22,
 * endHour: 6 }`). A full-day window (`startHour === endHour`) is always active.
 */
export function isWithinActiveHours(now: Date, window: ActiveHoursWindow): boolean {
  const start = clampHour(window.startHour);
  const end = clampHour(window.endHour);
  const hour = resolveHour(now, window.tz);
  if (start === end) {
    return true; // full-day / always active
  }
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Overnight window wraps past midnight.
  return hour >= start || hour < end;
}

function resolveHour(now: Date, tz: string | undefined): number {
  if (!tz) {
    return now.getHours();
  }
  try {
    const formatted = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now);
    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour : now.getHours();
  } catch {
    // RangeError for an unknown zone: keep wakes running on host time.
    return now.getHours();
  }
}
```

In `heartbeat-service.ts`:

```ts
function toActiveHoursWindow(prefs: Pick<SessionAutonomyPrefsRecord, "activeHours">): ActiveHoursWindow {
  const { start, end, tz } = prefs.activeHours;
  return tz ? { startHour: start, endHour: end, tz } : { startHour: start, endHour: end };
}
```

In `chat-proactive-service.ts`:

```ts
function toActiveHoursWindow(activeHours: SessionActiveHoursWindow): ActiveHoursWindow {
  const { start, end, tz } = activeHours;
  return tz ? { startHour: start, endHour: end, tz } : { startHour: start, endHour: end };
}
```

Then add `type ActiveHoursWindow` to that file's existing import from `./gateway/commitment-sweep-service.js`. If it imports `isWithinActiveHours` from somewhere else, match that path.

In `session-autonomy-prefs-repo.ts`, replace the doc comment over `SessionActiveHoursWindow` with:

```ts
/**
 * Active-hours window for autonomous self-wake (P1-F4). `start`/`end` are hours
 * in `tz` (an IANA zone such as "Europe/Berlin"); when `tz` is absent or unknown
 * the runtime evaluates against the host's local hour.
 */
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/gateway/commitment-sweep-service.test.ts src/services/gateway/heartbeat-service.test.ts --maxWorkers=2`

Expected: PASS.

- [ ] **Step 5: Pin the adapters**

In `heartbeat-service.test.ts`, copy that file's existing prefs fixture and add a case: `activeHours: { start: 8, end: 22, tz: "America/Los_Angeles" }` with the clock at `2026-06-22T12:00:00.000Z` (05:00 in LA). Assert the heartbeat is skipped as outside active hours, using the same assertion the file already uses for the host-time case. Re-run the Step 4 command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/gateway/commitment-sweep-service.ts apps/gateway/src/services/gateway/commitment-sweep-service.test.ts apps/gateway/src/services/gateway/heartbeat-service.ts apps/gateway/src/services/gateway/heartbeat-service.test.ts apps/gateway/src/services/chat-proactive-service.ts packages/storage/src/session-autonomy-prefs-repo.ts
git commit -m "fix: evaluate session active hours in the configured timezone"
```

---

### Task 3: Nested SQLite async transactions with savepoints

**Files:**
- Modify: `packages/storage/src/async-db.ts` (`SqlitePinnedAsyncDatabaseClient.transaction`, ~L147-149)
- Test: `packages/storage/src/async-db.test.ts`

**Interfaces:**
- `AsyncDatabaseClient.transaction` is unchanged. A SQLite transaction client now nests the way the Postgres one already does.

- [ ] **Step 1: Write the failing tests**

Append to `async-db.test.ts`:

```ts
test("SQLite async transaction client nests with savepoints", async () => {
  const db = new SqliteAsyncDatabaseClient(createDatabase({ dbPath: ":memory:" }));
  try {
    await db.exec("CREATE TABLE nested_tx_test (id INTEGER PRIMARY KEY)");
    await db.transaction("immediate", async (tx) => {
      await tx.prepare("INSERT INTO nested_tx_test (id) VALUES (?)").run(1);
      await assert.rejects(
        tx.transaction("immediate", async (inner) => {
          await inner.prepare("INSERT INTO nested_tx_test (id) VALUES (?)").run(2);
          throw new Error("inner rollback");
        }),
        /inner rollback/,
      );
      await tx.transaction("immediate", async (inner) => {
        await inner.prepare("INSERT INTO nested_tx_test (id) VALUES (?)").run(3);
      });
    });
    const rows = await db.prepare("SELECT id FROM nested_tx_test ORDER BY id").all<{ id: number }>();
    assert.deepEqual(
      rows.map((row) => row.id),
      [1, 3],
    );
  } finally {
    await db.close();
  }
});

test("SQLite async transaction client rejects concurrent nested transactions", async () => {
  const db = new SqliteAsyncDatabaseClient(createDatabase({ dbPath: ":memory:" }));
  try {
    await db.transaction("immediate", async (tx) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = tx.transaction("immediate", async () => {
        await gate;
      });
      await assert.rejects(
        tx.transaction("immediate", async () => undefined),
        /concurrent nested/i,
      );
      release();
      await first;
    });
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/async-db.test.ts`

Expected: FAIL with "Nested SQLite async transactions are not supported".

- [ ] **Step 3: Implement**

In `SqlitePinnedAsyncDatabaseClient`, add a field and replace `transaction`:

```ts
  private nestedActive = false;

  public async transaction<T>(_mode: DbTransactionMode, callback: (db: AsyncDatabaseClient) => Promise<T>): Promise<T> {
    if (this.nestedActive) {
      throw new Error("Concurrent nested SQLite async transactions are not supported; await each nested transaction.");
    }
    this.nestedActive = true;
    const savepoint = `gc_async_nested_${randomUUID().replaceAll("-", "")}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await callback(this);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Preserve the original callback failure.
      }
      throw error;
    } finally {
      this.nestedActive = false;
    }
  }
```

The guard is per pinned client. A nested callback that opens a further nested transaction gets the same client (`callback(this)`), so the guard rejects that too. That's intentional: one savepoint level at a time is all the callers need.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/async-db.test.ts`

Expected: PASS.

- [ ] **Step 5: Look for callers that relied on the old throw**

Run: `git grep -n "Nested SQLite async transactions" -- apps packages`

Expected: no matches outside `async-db.ts` itself. If any test expected the old message, update it to the new behavior and re-run it.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/async-db.ts packages/storage/src/async-db.test.ts
git commit -m "feat: support nested SQLite async transactions with savepoints"
```

---

### Task 4: Data-driven add-on launch

**Files:**
- Modify: `packages/contracts/src/addons.ts` (`AddonCatalogEntry` ~L25)
- Modify: `apps/gateway/src/services/addons-service.ts` (Arena constants ~L56-68, `ADDON_CATALOG` ~L82, `launch` ~L382-425)
- Test: `apps/gateway/src/services/addons-service.test.ts`

**Interfaces:**
- Produces (gateway-internal; it does not go into contracts, because it holds functions):
  ```ts
  interface AddonLaunchSpec {
    command: string;
    args: string[];
    healthUrl: string;
    readyTimeoutMs: number;
    buildEnv(context: { installedPath: string; addonsRootDir: string }): Promise<Record<string, string>>;
    probeReady(healthUrl: string, timeoutMs: number): Promise<{ ready: boolean } | undefined>;
  }
  ```
  A `Record<string, AddonLaunchSpec>` called `ADDON_LAUNCH_SPECS`, keyed by `addonId`.

- [ ] **Step 1: Write the failing test**

Add this to `addons-service.test.ts`. Reuse the file's existing service factory and Arena install fixture (the same setup the "launches Arena with the local web origin…" test at ~L457 uses):

```ts
  it("declares a launch spec for every catalog add-on", async () => {
    const { listAddonLaunchSpecIds, listAddonCatalogIds } = await import("./addons-service.js");
    expect(listAddonLaunchSpecIds().sort()).toEqual(listAddonCatalogIds().sort());
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/addons-service.test.ts --maxWorkers=2`

Expected: FAIL. `listAddonLaunchSpecIds` is not exported.

- [ ] **Step 3: Implement**

In `addons-service.ts`, add the following after the Arena constants. The spawn arguments, env and probe are moved verbatim from today's `launch()`:

```ts
interface AddonLaunchSpec {
  command: string;
  args: string[];
  healthUrl: string;
  readyTimeoutMs: number;
  buildEnv(context: { installedPath: string; addonsRootDir: string }): Promise<Record<string, string>>;
  probeReady(healthUrl: string, timeoutMs: number): Promise<{ ready: boolean } | undefined>;
}

const ADDON_LAUNCH_SPECS: Record<string, AddonLaunchSpec> = {
  arena: {
    command: "corepack",
    args: ["pnpm", "--filter", "@arena/server", "start"],
    healthUrl: ARENA_SERVER_HEALTH_URL,
    readyTimeoutMs: 12_000,
    buildEnv: async ({ installedPath, addonsRootDir }) => ({
      ARENA_HOST: "127.0.0.1",
      ARENA_PORT: String(ARENA_SERVER_PORT),
      CORS_ORIGIN: ARENA_LAUNCH_URL.replace(/\/$/, ""),
      GOATCITADEL_BASE_URL: "http://127.0.0.1:8787",
      ARENA_DB_PATH: await prepareArenaDataPath(installedPath, addonsRootDir),
    }),
    probeReady: (healthUrl, timeoutMs) => waitForArenaReady(healthUrl, timeoutMs),
  },
};

export function listAddonLaunchSpecIds(): string[] {
  return Object.keys(ADDON_LAUNCH_SPECS);
}

export function listAddonCatalogIds(): string[] {
  return ADDON_CATALOG.map((entry) => entry.addonId);
}
```

`ADDON_CATALOG` is declared further down the file. A function body that references a later `const` is fine at runtime, because it only runs after the module has evaluated.

In `launch()`, replace the `if (addonId !== "arena")` throw and the Arena-specific spawn/probe with:

```ts
    const spec = ADDON_LAUNCH_SPECS[addonId];
    if (!spec) {
      throw new Error(`Add-on ${addonId} does not declare a launch spec.`);
    }
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (!fsSync.existsSync(installedPath)) {
      throw new Error(`Installed add-on path is missing: ${installedPath}`);
    }
    const alreadyRunning = typeof current.pid === "number" && isProcessRunning(current.pid);
    let pid = current.pid;
    if (!alreadyRunning) {
      const env = await spec.buildEnv({ installedPath, addonsRootDir: this.addonsRootDir });
      pid = spawnDetachedCommand(spec.command, spec.args, installedPath, env).pid;
    }

    const probe = await spec.probeReady(spec.healthUrl, spec.readyTimeoutMs);
    const ready = probe?.ready ?? false;
    const updated: AddonInstalledRecord = {
      ...current,
      pid,
      installedPath,
      enabled: true,
      webEntryMode: addon.webEntryMode,
      launchUrl: current.launchUrl ?? addon.launchUrl,
      runtimeStatus: ready ? "running" : "error",
      updatedAt: new Date().toISOString(),
      lastError: ready ? undefined : `${addon.label} health check did not report ready at ${spec.healthUrl}.`,
    };
```

Keep the rest of `launch()` (manifest write, return) as it is. This also removes the in-place `current.pid = …` mutation.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/addons-service.test.ts src/services/addons-route-service.test.ts --maxWorkers=2`

Expected: PASS, including the existing Arena launch tests. If an Arena test asserts the old error text "Arena health check did not report uiReady", update it to "Arena health check did not report ready" (`addon.label` is "Arena").

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/addons-service.ts apps/gateway/src/services/addons-service.test.ts
git commit -m "refactor: make add-on launch data-driven instead of Arena-only"
```

---

### Task 5: Docs truth pass

**Files:**
- Modify: `README.md` (~L164, ~L213, ~L546)
- Modify: `apps/gateway/src/services/skill-output-directives.ts` (~L47 comment)

- [ ] **Step 1: README, Gatehouse Wards row (~L164) and Citadels row (~L213)**

In both rows, replace:

`` `require_dry_run` enforcement is wired at the side-effect runner (integration/a2a caller wiring is a tracked follow-up); `route_local` is evaluated and audited but not yet enforced ``

with:

`` `require_dry_run` is enforced for integration actions and A2A outbound/push callers through the shared side-effect runner; `route_local` is evaluated and audited but not yet enforced ``

- [ ] **Step 2: README known gaps (~L546)**

Replace the clause:

`` but `require_dry_run` is not yet wired to the integration/a2a side-effect callers, and `route_local` is evaluated and audited without an execution-routing path to enforce it ``

with:

`` and `route_local` is evaluated and audited without an execution-routing path to enforce it ``

- [ ] **Step 3: Check the README governance gate**

Run: `pnpm docs:check`

Expected: PASS. If a verbatim-phrase check fails, put the protected phrase back exactly and reword only the surrounding text.

- [ ] **Step 4: Fix the stale code comment**

`connector-delivery.ts` `applyAsDocumentDirectives` now calls `parseSkillOutputDirectives`, so channel delivery *is* wired. Open `skill-output-directives.ts` around L47, read the full comment block, and rewrite only the sentence that begins "Channel delivery is not yet wired to these directives" so it states that `connector-delivery.ts` (`applyAsDocumentDirectives`) turns parsed directives into channel attachments. Keep the rest of the comment, including its exploit/safety reasoning, if it still holds.

- [ ] **Step 5: Commit (docs-only, so no /verify needed)**

```bash
git add README.md apps/gateway/src/services/skill-output-directives.ts
git commit -m "docs: record require_dry_run caller enforcement and fix stale directive comment"
```

---

### Final verification (whole branch)

- [ ] `pnpm typecheck` → PASS
- [ ] `pnpm verify:fast` → PASS (run in the background; it takes several minutes)
- [ ] `pnpm docs:check` → PASS
- [ ] `git diff --check origin/main...HEAD` → no output
- [ ] Final check that the router is gone: `git grep -n -E "surfaceRouter|SurfaceClassify|SURFACE_ROUTER_JUDGE" -- apps packages`. Expected: no matches.
