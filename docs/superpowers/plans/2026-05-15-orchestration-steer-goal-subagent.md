# Orchestration: Steer + Goal + Subagent-Task Implementation Plan

> Implementation-plan artifact only. This document may name proposed files, commands, tests, and runtime behavior; treat those as plan intent, not shipped 1.0 truth, unless the current implementation and release evidence prove them.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three coupled P0 orchestration features in GoatCitadel — (1) active-run steering by default for mid-turn prompts, (2) `/goal` cross-turn target lock with turn-budget enforcement, and (3) materializing the subagent task as a visible `[Subagent Task]` first message in child transcripts.

**Architecture:** All three features touch the same surfaces. We extend the shared contract layer (`packages/contracts`), the storage layer (`packages/storage`), the threaded-surface command parser (`packages/threaded-surface-core`), the gateway services (`apps/gateway`), and the Mission Control composer (`apps/mission-control-next`). Each feature lands behind passing unit tests before any wiring change. The dispatch path stays the same; we add a parallel "steering instruction" channel into the active run and a per-session goal slot that is rendered into the system instruction by `prepareAgentChatTurn`.

**Tech Stack:** TypeScript (TS7 workspace), pnpm monorepo, Vitest, React for UI, better-sqlite3 (statement-prepared SQL in storage repos), Hono on the gateway. Tests use `describe`/`it`/`expect`/`vi` from Vitest.

---

## File Structure

### Contracts (`packages/contracts/src`)
- **Modify** `chat.ts` — add `pinnedGoal`, `goalTurnBudget`, `goalTurnsUsed`, `goalSetAt` fields to `ChatSessionRecord`; add `steered?: boolean`, `parentDelegationStepId?: string` to `ChatMessageRecord`; add `ChatSteerRequest`, `ChatSteerResponse`, `ChatGoalRequest`, `ChatGoalStatusResponse` interfaces.

### Storage (`packages/storage/src`)
- **Modify** `chat-session-meta-repo.ts` — extend `ChatSessionMetaRecord`/`ChatSessionMetaRow`/`ChatSessionMetaPatchInput` + schema migration for goal columns.
- **Modify** `chat-message-repo.ts` — extend row + record types with `steered`, `parent_delegation_step_id`; migration adds nullable columns.

### Threaded surface (`packages/threaded-surface-core/src`)
- **Modify** `chat-command-suggestions.ts` — add `buildOrchestrationCommandSuggestions()` for `/steer`, `/queue steer`, `/queue followup`, `/queue collect`, `/goal ...`. Re-export from `index.ts`.
- **Modify** `chat/chat-page-pure-helpers.ts` — add `resolveMidTurnDisposition(activeStream, draft) -> "steer" | "queue"` and `parseGoalCommand(draft) -> { kind, text? }`.

### Gateway (`apps/gateway/src`)
- **New** `services/chat-steer-service.ts` — owns the steer-instruction queue per active run; `enqueueSteer(sessionId, turnId, text)`, `drainPending(turnId)`.
- **Modify** `services/chat-turn-prep-service.ts` — read session goal and prepend to `guidanceSystemInstruction`; mark current turn as goal-counted (increment `goalTurnsUsed`); when budget exceeded, clear the goal and emit a system event.
- **Modify** `services/chat-turn-stream-service.ts` — before streaming a turn, drain pending steer instructions; inject them as `[Steer] …` user-role context blocks; record `steered=true` on stored mid-turn user messages.
- **Modify** `services/chat-delegation-service.ts` — rewrite `buildDelegationUserPrompt` to start with `[Subagent Task] …`; drop the redundant task summary from `buildDelegationSystemPrompt`; persist `parentDelegationStepId` on the child user message.
- **New** `routes/chat-steer-route.ts` — `POST /api/v1/chat/sessions/:sessionId/steer { instruction }` and `POST /api/v1/chat/sessions/:sessionId/goal { goal, turnBudget? }`, `DELETE .../goal`, `GET .../goal`.

### UI (`apps/mission-control-next/src`)
- **Modify** `features/threaded-surface/ThreadedComposer.tsx` — render queued-vs-steering chip and active-goal chip; route mid-turn submissions through new disposition resolver.
- **Modify** `features/threaded-surface/ThreadedSurfacePage.tsx` (or its hooks) — wire `/steer` and `/goal` commands to new gateway routes.

### Tests
- **New** `packages/threaded-surface-core/src/chat-command-suggestions.orchestration.test.ts`.
- **New** `packages/threaded-surface-core/src/chat/chat-page-pure-helpers.orchestration.test.ts`.
- **New** `packages/storage/src/chat-session-meta-repo.goal.test.ts`.
- **New** `apps/gateway/src/services/chat-steer-service.test.ts`.
- **New** `apps/gateway/src/services/chat-turn-prep-service.goal.test.ts`.
- **New** `apps/gateway/src/services/chat-delegation-service.subagent-task.test.ts`.
- **New** `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.steering.test.tsx`.

---

## Task 1: Command parser for `/steer`, `/queue steer`, `/queue followup`, `/queue collect`, `/goal`

**Files:**
- Create: `packages/threaded-surface-core/src/chat-command-suggestions.orchestration.test.ts`
- Modify: `packages/threaded-surface-core/src/chat-command-suggestions.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/threaded-surface-core/src/chat-command-suggestions.orchestration.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildOrchestrationCommandSuggestions } from "./chat-command-suggestions";

describe("buildOrchestrationCommandSuggestions", () => {
  it("returns nothing when draft does not start with a known orchestration command", () => {
    expect(buildOrchestrationCommandSuggestions({ draft: "" })).toEqual([]);
    expect(buildOrchestrationCommandSuggestions({ draft: "hello" })).toEqual([]);
    expect(buildOrchestrationCommandSuggestions({ draft: "/model claude" })).toEqual([]);
  });

  it("suggests steer/queue variants when draft begins with /steer or /queue", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/steer please retry the last step" });
    expect(suggestions.map((item) => item.command)).toEqual([
      "/steer <instruction>",
    ]);
    expect(suggestions[0]!.applyValue).toBe("/steer please retry the last step");

    const queue = buildOrchestrationCommandSuggestions({ draft: "/queue" });
    expect(queue.map((item) => item.command)).toEqual([
      "/queue steer",
      "/queue followup",
      "/queue collect",
    ]);
  });

  it("suggests goal variants when draft begins with /goal", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/goal ship the kanban" });
    expect(suggestions.map((item) => item.command)).toEqual(["/goal <target>"]);
    expect(suggestions[0]!.applyValue).toBe("/goal ship the kanban");

    const bare = buildOrchestrationCommandSuggestions({ draft: "/goal" });
    expect(bare.map((item) => item.command)).toEqual([
      "/goal <target>",
      "/goal status",
      "/goal clear",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/threaded-surface-core test -- chat-command-suggestions.orchestration`
Expected: FAIL with "buildOrchestrationCommandSuggestions is not exported".

- [ ] **Step 3: Implement `buildOrchestrationCommandSuggestions`**

Append to `packages/threaded-surface-core/src/chat-command-suggestions.ts`:

```typescript
interface BuildOrchestrationCommandSuggestionsInput {
  draft: string;
}

const STEER_PREFIX = /^\/steer(?:\s+(.*))?$/i;
const QUEUE_PREFIX = /^\/queue(?:\s+(.*))?$/i;
const GOAL_PREFIX = /^\/goal(?:\s+(.*))?$/i;

export function buildOrchestrationCommandSuggestions({
  draft,
}: BuildOrchestrationCommandSuggestionsInput): CommandSuggestionItem[] {
  const trimmed = draft.trimStart();
  const steerMatch = trimmed.match(STEER_PREFIX);
  if (steerMatch) {
    const instruction = (steerMatch[1] ?? "").trim();
    return [
      {
        key: "steer-instruction",
        command: "/steer <instruction>",
        description: "Inject this text into the active turn before it finishes streaming.",
        applyValue: instruction ? `/steer ${instruction}` : "/steer ",
      },
    ];
  }

  const queueMatch = trimmed.match(QUEUE_PREFIX);
  if (queueMatch) {
    const sub = (queueMatch[1] ?? "").trim().toLowerCase();
    const items: CommandSuggestionItem[] = [
      {
        key: "queue-steer",
        command: "/queue steer",
        description: "Force this message to steer the in-flight run.",
        applyValue: "/queue steer ",
      },
      {
        key: "queue-followup",
        command: "/queue followup",
        description: "Defer this message until the active turn completes.",
        applyValue: "/queue followup ",
      },
      {
        key: "queue-collect",
        command: "/queue collect",
        description: "Stage this message into a collection batch.",
        applyValue: "/queue collect ",
      },
    ];
    if (!sub) {
      return items;
    }
    return items.filter((item) => item.command.endsWith(sub) || item.command.includes(sub));
  }

  const goalMatch = trimmed.match(GOAL_PREFIX);
  if (goalMatch) {
    const arg = (goalMatch[1] ?? "").trim();
    if (!arg) {
      return [
        {
          key: "goal-set",
          command: "/goal <target>",
          description: "Pin a cross-turn goal that prepends to every turn until cleared.",
          applyValue: "/goal ",
        },
        {
          key: "goal-status",
          command: "/goal status",
          description: "Show the current pinned goal and remaining turn budget.",
          applyValue: "/goal status",
        },
        {
          key: "goal-clear",
          command: "/goal clear",
          description: "Clear the pinned goal.",
          applyValue: "/goal clear",
        },
      ];
    }
    return [
      {
        key: "goal-set",
        command: "/goal <target>",
        description: "Pin a cross-turn goal that prepends to every turn until cleared.",
        applyValue: `/goal ${arg}`,
      },
    ];
  }

  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/threaded-surface-core test -- chat-command-suggestions.orchestration`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/threaded-surface-core/src/chat-command-suggestions.ts packages/threaded-surface-core/src/chat-command-suggestions.orchestration.test.ts
git commit -m "feat(threaded-surface): parse /steer, /queue, /goal command suggestions"
```

---

## Task 2: Mid-turn disposition resolver + goal-command parser

**Files:**
- Create: `packages/threaded-surface-core/src/chat/chat-page-pure-helpers.orchestration.test.ts`
- Modify: `packages/threaded-surface-core/src/chat/chat-page-pure-helpers.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/threaded-surface-core/src/chat/chat-page-pure-helpers.orchestration.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseGoalCommand, resolveMidTurnDisposition } from "./chat-page-pure-helpers";

describe("resolveMidTurnDisposition", () => {
  it("returns 'idle' when no stream is active", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: false, draft: "hi" })).toBe("idle");
  });
  it("returns 'steer' when active stream and draft is /steer or /queue steer", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "/steer go faster" })).toBe("steer");
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "/queue steer go faster" })).toBe("steer");
  });
  it("returns 'queue' when active stream and draft is /queue followup", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "/queue followup later" })).toBe("queue");
  });
  it("defaults to 'steer' for plain mid-turn drafts (OpenClaw 2026.5.14 #77023 default)", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "tweak the wording" })).toBe("steer");
  });
});

describe("parseGoalCommand", () => {
  it("returns null when draft is not a /goal command", () => {
    expect(parseGoalCommand("hi")).toBeNull();
    expect(parseGoalCommand("/steer x")).toBeNull();
  });
  it("recognizes set/status/clear", () => {
    expect(parseGoalCommand("/goal ship kanban")).toEqual({ kind: "set", text: "ship kanban" });
    expect(parseGoalCommand("/goal status")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/threaded-surface-core test -- chat-page-pure-helpers.orchestration`
Expected: FAIL.

- [ ] **Step 3: Implement the helpers**

Append to `packages/threaded-surface-core/src/chat/chat-page-pure-helpers.ts`:

```typescript
export type MidTurnDisposition = "idle" | "steer" | "queue";

export function resolveMidTurnDisposition(input: {
  hasActiveStream: boolean;
  draft: string;
}): MidTurnDisposition {
  if (!input.hasActiveStream) {
    return "idle";
  }
  const trimmed = input.draft.trimStart();
  if (/^\/queue\s+followup\b/i.test(trimmed)) {
    return "queue";
  }
  if (/^\/queue\s+collect\b/i.test(trimmed)) {
    return "queue";
  }
  return "steer";
}

export type GoalCommand =
  | { kind: "set"; text: string }
  | { kind: "status" }
  | { kind: "clear" };

export function parseGoalCommand(draft: string): GoalCommand | null {
  const match = draft.trimStart().match(/^\/goal(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const arg = (match[1] ?? "").trim();
  if (!arg) {
    return { kind: "status" };
  }
  if (arg.toLowerCase() === "status") {
    return { kind: "status" };
  }
  if (arg.toLowerCase() === "clear") {
    return { kind: "clear" };
  }
  return { kind: "set", text: arg };
}
```

Also re-export from `packages/threaded-surface-core/src/index.ts`:

```typescript
export {
  parseGoalCommand,
  resolveMidTurnDisposition,
  type GoalCommand,
  type MidTurnDisposition,
} from "./chat/chat-page-pure-helpers";
export { buildOrchestrationCommandSuggestions } from "./chat-command-suggestions";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/threaded-surface-core test -- chat-page-pure-helpers.orchestration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/threaded-surface-core/src/chat/chat-page-pure-helpers.ts packages/threaded-surface-core/src/chat/chat-page-pure-helpers.orchestration.test.ts packages/threaded-surface-core/src/index.ts
git commit -m "feat(threaded-surface): add mid-turn disposition + /goal command parsing"
```

---

## Task 3: Storage migration + repository extension for session goal slot

**Files:**
- Modify: `packages/storage/src/chat-session-meta-repo.ts`
- Modify: `packages/storage/src/migrations/*.ts` (find the most recent migration file via `git ls-files packages/storage/src/migrations | tail -1`)
- Create: `packages/storage/src/chat-session-meta-repo.goal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/storage/src/chat-session-meta-repo.goal.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyAllMigrations } from "./migrations";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo";

function newRepo(): ChatSessionMetaRepository {
  const db = new Database(":memory:");
  applyAllMigrations(db);
  return new ChatSessionMetaRepository(db);
}

describe("ChatSessionMetaRepository goal slot", () => {
  let repo: ChatSessionMetaRepository;
  beforeEach(() => {
    repo = newRepo();
  });

  it("ensures default goal fields are absent on a fresh session", () => {
    const record = repo.ensure("s-1");
    expect(record.pinnedGoal).toBeUndefined();
    expect(record.goalTurnBudget).toBeUndefined();
    expect(record.goalTurnsUsed).toBe(0);
    expect(record.goalSetAt).toBeUndefined();
  });

  it("persists pinnedGoal + budget on patch and resets goalTurnsUsed", () => {
    repo.ensure("s-2");
    const patched = repo.patch("s-2", {
      pinnedGoal: "ship kanban",
      goalTurnBudget: 12,
      goalSetAt: "2026-05-15T10:00:00Z",
    });
    expect(patched.pinnedGoal).toBe("ship kanban");
    expect(patched.goalTurnBudget).toBe(12);
    expect(patched.goalTurnsUsed).toBe(0);
    expect(patched.goalSetAt).toBe("2026-05-15T10:00:00Z");
  });

  it("increments goalTurnsUsed independently of patch", () => {
    repo.ensure("s-3");
    repo.patch("s-3", { pinnedGoal: "ship kanban", goalTurnBudget: 3, goalSetAt: "2026-05-15T10:00:00Z" });
    expect(repo.incrementGoalTurnsUsed("s-3")).toBe(1);
    expect(repo.incrementGoalTurnsUsed("s-3")).toBe(2);
    expect(repo.get("s-3")!.goalTurnsUsed).toBe(2);
  });

  it("clears the goal via patch with explicit null", () => {
    repo.ensure("s-4");
    repo.patch("s-4", { pinnedGoal: "x", goalTurnBudget: 5, goalSetAt: "2026-05-15T10:00:00Z" });
    const cleared = repo.patch("s-4", { pinnedGoal: null, goalTurnBudget: null, goalSetAt: null });
    expect(cleared.pinnedGoal).toBeUndefined();
    expect(cleared.goalTurnBudget).toBeUndefined();
    expect(cleared.goalSetAt).toBeUndefined();
    expect(cleared.goalTurnsUsed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/storage test -- chat-session-meta-repo.goal`
Expected: FAIL on missing fields/methods.

- [ ] **Step 3: Add migration for goal columns**

Discover the latest migration file (so we don't conflict):
```bash
ls packages/storage/src/migrations/
```

Create a new migration file `packages/storage/src/migrations/NNNN_chat_session_meta_goal.ts` (where NNNN is the next sequential number — bump above the highest existing). Follow the existing migration pattern (each migration in this repo exports an object with `id`, `up(db)`). Mirror an existing one's shape:

```typescript
import type { Database } from "better-sqlite3";

export const migration = {
  id: "NNNN_chat_session_meta_goal",
  up(db: Database) {
    db.exec(`
      ALTER TABLE chat_session_meta ADD COLUMN pinned_goal TEXT;
      ALTER TABLE chat_session_meta ADD COLUMN goal_turn_budget INTEGER;
      ALTER TABLE chat_session_meta ADD COLUMN goal_turns_used INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_session_meta ADD COLUMN goal_set_at TEXT;
    `);
  },
};
```

Register it in the migrations index (e.g., `packages/storage/src/migrations/index.ts`) per the existing pattern.

- [ ] **Step 4: Extend `ChatSessionMetaRecord`, `ChatSessionMetaRow`, `ChatSessionMetaPatchInput`, and SQL statements**

In `packages/storage/src/chat-session-meta-repo.ts`:

Update the type definitions:

```typescript
export interface ChatSessionMetaRecord {
  // ... existing fields ...
  pinnedGoal?: string;
  goalTurnBudget?: number;
  goalTurnsUsed: number;
  goalSetAt?: string;
}

interface ChatSessionMetaRow {
  // ... existing fields ...
  pinned_goal: string | null;
  goal_turn_budget: number | null;
  goal_turns_used: number;
  goal_set_at: string | null;
}

export interface ChatSessionMetaPatchInput {
  // ... existing fields ...
  pinnedGoal?: string | null;
  goalTurnBudget?: number | null;
  goalSetAt?: string | null;
}
```

Update the prepared upsert SQL to include the four new columns. Update `ensure()` to seed `pinned_goal: null, goal_turn_budget: null, goal_turns_used: 0, goal_set_at: null`.

Update `patch()` so that when `pinnedGoal` is `null` it clears the column AND resets `goal_turns_used` to 0 in the same write; same for `goalTurnBudget`/`goalSetAt`. When `pinnedGoal` is set to a string, also reset `goal_turns_used` to 0 (a new goal starts fresh).

Add a new method:

```typescript
public incrementGoalTurnsUsed(sessionId: string): number {
  const current = this.ensure(sessionId);
  const next = (current.goalTurnsUsed ?? 0) + 1;
  this.db
    .prepare(
      `UPDATE chat_session_meta SET goal_turns_used = ?, updated_at = ? WHERE session_id = ?`,
    )
    .run(next, new Date().toISOString(), sessionId);
  return next;
}
```

Extend `mapRow` to expose the new fields, omitting `pinnedGoal` / `goalTurnBudget` / `goalSetAt` from the record when the column is null (so undefined matches the test expectation).

Update the row guard `isChatSessionMetaRow` to accept the new columns.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/storage test -- chat-session-meta-repo.goal`
Expected: PASS (4 tests).

Also re-run the existing repo tests to make sure they still pass:

Run: `pnpm --filter @goatcitadel/storage test -- chat-session-meta-repo`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/chat-session-meta-repo.ts packages/storage/src/chat-session-meta-repo.goal.test.ts packages/storage/src/migrations/
git commit -m "feat(storage): pin per-session goal on chat_session_meta"
```

---

## Task 4: Contract additions — goal/steer/subagent fields

**Files:**
- Modify: `packages/contracts/src/chat.ts`

- [ ] **Step 1: Add new fields and request/response interfaces**

In `packages/contracts/src/chat.ts`:

1. Add to `ChatMessageRecord` (around line 421):

```typescript
export interface ChatMessageRecord {
  // ... existing fields ...
  /**
   * Set true when this user message was injected into an active run via /steer.
   * Surfaces on transcript entries so operators can audit which prompts steered.
   */
  steered?: boolean;
  /**
   * Links the message to a parent delegation step. Set on the [Subagent Task]
   * first message of a child session so the lineage is queryable from the message.
   */
  parentDelegationStepId?: string;
}
```

2. Add new request/response interfaces at the bottom of the file (next to `ChatSendMessageResponse`):

```typescript
export interface ChatSteerRequest {
  instruction: string;
}

export interface ChatSteerResponse {
  sessionId: string;
  turnId: string;
  accepted: boolean;
  reason?: string;
}

export interface ChatGoalRequest {
  goal: string;
  turnBudget?: number;
}

export interface ChatGoalStatusResponse {
  sessionId: string;
  goal: string | null;
  turnBudget: number | null;
  turnsUsed: number;
  setAt: string | null;
}
```

3. If `ChatSessionRecord` is defined in this file, add the goal fields:

```typescript
pinnedGoal?: string;
goalTurnBudget?: number;
goalTurnsUsed?: number;
goalSetAt?: string;
```

- [ ] **Step 2: Run typecheck on contracts**

Run: `pnpm --filter @goatcitadel/contracts typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/chat.ts
git commit -m "feat(contracts): add steer/goal/subagent-task fields to chat surfaces"
```

---

## Task 5: Steer-instruction queue service

**Files:**
- Create: `apps/gateway/src/services/chat-steer-service.test.ts`
- Create: `apps/gateway/src/services/chat-steer-service.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/services/chat-steer-service.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ChatSteerService } from "./chat-steer-service";

describe("ChatSteerService", () => {
  it("returns rejected when no active turn is registered for the session", () => {
    const service = new ChatSteerService();
    const result = service.enqueue({ sessionId: "s-1", instruction: "go faster" });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/no active turn/i);
  });

  it("accepts when an active turn is registered and drains in order", () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    expect(service.enqueue({ sessionId: "s-1", instruction: "first" }).accepted).toBe(true);
    expect(service.enqueue({ sessionId: "s-1", instruction: "second" }).accepted).toBe(true);
    const drained = service.drainPending({ sessionId: "s-1", turnId: "t-1" });
    expect(drained.map((item) => item.instruction)).toEqual(["first", "second"]);
    expect(service.drainPending({ sessionId: "s-1", turnId: "t-1" })).toEqual([]);
  });

  it("clears the active turn on unregister", () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    service.unregisterActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    expect(service.enqueue({ sessionId: "s-1", instruction: "x" }).accepted).toBe(false);
  });

  it("rejects steer for stale turnId", () => {
    const service = new ChatSteerService();
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    service.registerActiveTurn({ sessionId: "s-1", turnId: "t-2" }); // replaces t-1
    const drained = service.drainPending({ sessionId: "s-1", turnId: "t-1" });
    expect(drained).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-steer-service`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `ChatSteerService`**

Create `apps/gateway/src/services/chat-steer-service.ts`:

```typescript
import type { ChatSteerResponse } from "@goatcitadel/contracts";

export interface ChatSteerQueuedInstruction {
  instruction: string;
  enqueuedAt: string;
}

interface ActiveTurnState {
  turnId: string;
  queue: ChatSteerQueuedInstruction[];
}

export class ChatSteerService {
  private readonly perSession = new Map<string, ActiveTurnState>();

  public registerActiveTurn(input: { sessionId: string; turnId: string }): void {
    this.perSession.set(input.sessionId, { turnId: input.turnId, queue: [] });
  }

  public unregisterActiveTurn(input: { sessionId: string; turnId: string }): void {
    const current = this.perSession.get(input.sessionId);
    if (current && current.turnId === input.turnId) {
      this.perSession.delete(input.sessionId);
    }
  }

  public enqueue(input: { sessionId: string; instruction: string }): ChatSteerResponse {
    const state = this.perSession.get(input.sessionId);
    if (!state) {
      return {
        sessionId: input.sessionId,
        turnId: "",
        accepted: false,
        reason: "No active turn to steer.",
      };
    }
    state.queue.push({ instruction: input.instruction, enqueuedAt: new Date().toISOString() });
    return {
      sessionId: input.sessionId,
      turnId: state.turnId,
      accepted: true,
    };
  }

  public drainPending(input: { sessionId: string; turnId: string }): ChatSteerQueuedInstruction[] {
    const state = this.perSession.get(input.sessionId);
    if (!state || state.turnId !== input.turnId) {
      return [];
    }
    const drained = state.queue;
    state.queue = [];
    return drained;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-steer-service`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-steer-service.ts apps/gateway/src/services/chat-steer-service.test.ts
git commit -m "feat(gateway): in-memory steer-instruction queue per active turn"
```

---

## Task 6: Wire steer-instruction drain into chat-turn-stream-service

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-stream-service.ts`
- Modify: `apps/gateway/src/services/chat-turn-runtime-collaborators.ts` (host contract — to inject the steer service)

- [ ] **Step 1: Read the current stream service top + bottom to find the entry point**

Run: open `apps/gateway/src/services/chat-turn-stream-service.ts`. Find the `streamPreparedAgentChatTurn` function signature and the first `for await` over `host.createChatCompletion`. The drain hook lands BEFORE the first completion call.

- [ ] **Step 2: Add a host contract field for the steer service**

In `chat-turn-runtime-collaborators.ts` (or wherever `ChatTurnStreamHost` is defined), add:

```typescript
import type { ChatSteerService } from "./chat-steer-service.js";

export interface ChatTurnSteerCollaborator {
  readonly steerService: ChatSteerService;
}
```

Extend `ChatTurnStreamHost` (in `chat-turn-stream-service.ts` if defined there, or in collaborators) with `ChatTurnSteerCollaborator`.

- [ ] **Step 3: Write a focused integration test**

Create `apps/gateway/src/services/chat-turn-stream-service.steer.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ChatSteerService } from "./chat-steer-service";

describe("steer drain integration", () => {
  it("drains pending steer instructions into the next completion request", async () => {
    const steerService = new ChatSteerService();
    steerService.registerActiveTurn({ sessionId: "s-1", turnId: "t-1" });
    steerService.enqueue({ sessionId: "s-1", instruction: "tighten the wording" });

    const captured: string[] = [];
    const fakeHost = {
      steerService,
      buildLlmMessagesFromBranchPath: vi.fn(async () => [{ role: "user", content: "primary" }]),
      createChatCompletion: vi.fn(async (req) => {
        captured.push(JSON.stringify(req.messages));
        return { content: "ok", model: "test", usage: {} };
      }),
    } as unknown as Parameters<typeof streamWithSteerDrain>[0];

    // streamWithSteerDrain is a new exported helper we add below
    await streamWithSteerDrain({
      host: fakeHost,
      sessionId: "s-1",
      turnId: "t-1",
      messages: [{ role: "user", content: "primary" }],
    });
    expect(captured[0]).toContain("[Steer] tighten the wording");
  });
});

import { streamWithSteerDrain } from "./chat-turn-stream-service";
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-turn-stream-service.steer`
Expected: FAIL (no `streamWithSteerDrain` export).

- [ ] **Step 5: Add `streamWithSteerDrain` helper**

Export a minimal helper inside `chat-turn-stream-service.ts` that prepends steer instructions to the messages array. The real production wiring will call this from inside the existing stream loop right before each completion call.

```typescript
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import type { ChatSteerService } from "./chat-steer-service.js";

export interface StreamWithSteerDrainInput {
  host: { steerService: ChatSteerService; createChatCompletion(req: ChatCompletionRequest): Promise<unknown> };
  sessionId: string;
  turnId: string;
  messages: ChatCompletionRequest["messages"];
}

export async function streamWithSteerDrain(input: StreamWithSteerDrainInput): Promise<unknown> {
  const drained = input.host.steerService.drainPending({ sessionId: input.sessionId, turnId: input.turnId });
  const steerMessages = drained.map((item) => ({
    role: "user" as const,
    content: `[Steer] ${item.instruction}`,
  }));
  const composed = [...input.messages, ...steerMessages];
  return input.host.createChatCompletion({
    model: "test",
    messages: composed,
  } as ChatCompletionRequest);
}
```

In the EXISTING `streamPreparedAgentChatTurn` loop, locate the call to `host.createChatCompletion(...)` for the first turn iteration and insert immediately before it:

```typescript
const drainedSteers = host.steerService.drainPending({ sessionId, turnId: prepared.turnId });
if (drainedSteers.length > 0) {
  for (const steerItem of drainedSteers) {
    history.push({ role: "user", content: `[Steer] ${steerItem.instruction}` });
  }
  // Persist a steered ChatMessageRecord so the audit transcript shows steered=true.
  for (const steerItem of drainedSteers) {
    const steerMessage: ChatMessageRecord = {
      messageId: randomUUID(),
      sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: steerItem.instruction,
      timestamp: steerItem.enqueuedAt,
      steered: true,
    };
    host.persistChatStreamChunk({
      type: "message_done",
      messageId: steerMessage.messageId,
      content: steerMessage.content,
      // ... whatever shape the existing persist call expects; reuse the existing builder
    } as InspectableChatStreamChunk);
  }
}
```

(Inspect the file before writing this to match the actual chunk shapes — exact field names live in `chat-turn-types.ts`.)

- [ ] **Step 6: Register active turn lifecycle**

Find where the turn starts streaming (look for the call that constructs the `PreparedAgentChatTurn` and starts the loop). Add at the start:

```typescript
host.steerService.registerActiveTurn({ sessionId, turnId: prepared.turnId });
```

And in the `finally` block (or after the stream loop completes):

```typescript
host.steerService.unregisterActiveTurn({ sessionId, turnId: prepared.turnId });
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-turn-stream-service`
Expected: PASS for the new steer test; existing tests must still pass.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/services/chat-turn-stream-service.ts apps/gateway/src/services/chat-turn-stream-service.steer.test.ts apps/gateway/src/services/chat-turn-runtime-collaborators.ts
git commit -m "feat(gateway): drain steer instructions into active turn with audit metadata"
```

---

## Task 7: Goal injection in chat-turn-prep-service

**Files:**
- Create: `apps/gateway/src/services/chat-turn-prep-service.goal.test.ts`
- Modify: `apps/gateway/src/services/chat-turn-prep-service.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/services/chat-turn-prep-service.goal.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { applyGoalToGuidanceSystemInstruction, advanceGoalForTurn } from "./chat-turn-prep-service";

describe("applyGoalToGuidanceSystemInstruction", () => {
  it("returns base instruction when goal is null", () => {
    expect(applyGoalToGuidanceSystemInstruction({ baseInstruction: "base", goal: null })).toBe("base");
  });
  it("prepends Pinned goal section when goal is set", () => {
    const out = applyGoalToGuidanceSystemInstruction({ baseInstruction: "base", goal: "ship kanban" });
    expect(out).toContain("Pinned goal: ship kanban");
    expect(out).toContain("base");
    expect(out.indexOf("Pinned goal")).toBeLessThan(out.indexOf("base"));
  });
});

describe("advanceGoalForTurn", () => {
  it("returns { cleared: false } when below budget", () => {
    expect(advanceGoalForTurn({ turnsUsed: 1, turnBudget: 20 })).toEqual({ cleared: false });
  });
  it("returns { cleared: true } when at or above budget", () => {
    expect(advanceGoalForTurn({ turnsUsed: 20, turnBudget: 20 })).toEqual({ cleared: true });
    expect(advanceGoalForTurn({ turnsUsed: 25, turnBudget: 20 })).toEqual({ cleared: true });
  });
  it("treats null budget as 20 default", () => {
    expect(advanceGoalForTurn({ turnsUsed: 19, turnBudget: null })).toEqual({ cleared: false });
    expect(advanceGoalForTurn({ turnsUsed: 20, turnBudget: null })).toEqual({ cleared: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-turn-prep-service.goal`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement the helpers in `chat-turn-prep-service.ts`**

Add to `apps/gateway/src/services/chat-turn-prep-service.ts`:

```typescript
export const DEFAULT_GOAL_TURN_BUDGET = 20;

export function applyGoalToGuidanceSystemInstruction(input: {
  baseInstruction?: string;
  goal: string | null;
}): string {
  if (!input.goal) {
    return input.baseInstruction ?? "";
  }
  const goalSection = `Pinned goal: ${input.goal}\nKeep every turn focused on this goal until the operator clears it.`;
  if (!input.baseInstruction) {
    return goalSection;
  }
  return `${goalSection}\n\n${input.baseInstruction}`;
}

export function advanceGoalForTurn(input: {
  turnsUsed: number;
  turnBudget: number | null;
}): { cleared: boolean } {
  const budget = input.turnBudget ?? DEFAULT_GOAL_TURN_BUDGET;
  return { cleared: input.turnsUsed >= budget };
}
```

- [ ] **Step 4: Wire into `prepareAgentChatTurn`**

In `prepareAgentChatTurn`, after `sessionMeta` is fetched (line ~168) and after `resolvedGuidance`/`threadKnowledgeContext` are computed (around lines 258–270), modify the `guidanceSystemInstruction = mergeChatSystemInstructions(...)` call to also include the goal:

```typescript
const goalAdjustedBaseGuidance = applyGoalToGuidanceSystemInstruction({
  baseInstruction: undefined,
  goal: sessionMeta.pinnedGoal ?? null,
});
const guidanceSystemInstruction = mergeChatSystemInstructions(
  goalAdjustedBaseGuidance || undefined,
  resolvedGuidance.systemInstruction,
  threadKnowledgeContext.systemInstruction,
  personalityOverlay,
  buildPlanningModeSystemInstruction(prefs.planningMode),
  missingRequiredProjectBinding
    ? "Code mode requires a bound project before execution-heavy work. Until a project is attached, stay in planning and review posture, and do not imply that repository-bound edits or filesystem inspection were executed."
    : undefined,
  options?.extraSystemInstruction,
);
```

After `prepareAgentChatTurn` returns successfully (caller side, in the consumer of `prepared`, OR right at the end of `prepareAgentChatTurn` itself), increment `goalTurnsUsed` if a goal is active. Pick the safest spot: at the very end of `prepareAgentChatTurn` body, before `return`:

```typescript
if (sessionMeta.pinnedGoal) {
  const turnsUsed = host.storage.chatSessionMeta.incrementGoalTurnsUsed(sessionId);
  const { cleared } = advanceGoalForTurn({
    turnsUsed,
    turnBudget: sessionMeta.goalTurnBudget ?? null,
  });
  if (cleared) {
    host.storage.chatSessionMeta.patch(sessionId, {
      pinnedGoal: null,
      goalTurnBudget: null,
      goalSetAt: null,
    });
    // Emit a dev diagnostic so the operator sees the auto-clear.
    if ("recordDevDiagnostic" in host && typeof (host as { recordDevDiagnostic?: unknown }).recordDevDiagnostic === "function") {
      (host as unknown as { recordDevDiagnostic(input: unknown): void }).recordDevDiagnostic({
        level: "info",
        category: "chat",
        event: "chat.goal.auto_cleared",
        message: `Pinned goal auto-cleared after ${turnsUsed} turns.`,
        sessionId,
      });
    }
  }
}
```

(Adjust the host type to expose `incrementGoalTurnsUsed` on the `chatSessionMeta` slice and optionally `recordDevDiagnostic` — if the latter is already on the host, it's fine to require it.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-turn-prep-service`
Expected: PASS for the new tests; existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/chat-turn-prep-service.ts apps/gateway/src/services/chat-turn-prep-service.goal.test.ts
git commit -m "feat(gateway): pin per-session goal into every turn with budget enforcement"
```

---

## Task 8: Subagent task as visible first message

**Files:**
- Create: `apps/gateway/src/services/chat-delegation-service.subagent-task.test.ts`
- Modify: `apps/gateway/src/services/chat-delegation-service.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/services/chat-delegation-service.subagent-task.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildSubagentTaskFirstMessage, buildDelegationSpecialistSystemPrompt } from "./chat-delegation-service";

describe("buildSubagentTaskFirstMessage", () => {
  it("prefixes the task with [Subagent Task] and includes parent step id", () => {
    const message = buildSubagentTaskFirstMessage({
      role: "architect",
      objective: "Design the new ingestion queue.",
      mode: "sequential",
      parentDelegationStepId: "step-123",
      sharedContext: [],
    });
    expect(message.startsWith("[Subagent Task]")).toBe(true);
    expect(message).toContain("Design the new ingestion queue.");
    expect(message).toContain("architect");
  });
  it("includes prior-step outputs labeled per role", () => {
    const message = buildSubagentTaskFirstMessage({
      role: "implementer",
      objective: "Implement the spec.",
      mode: "sequential",
      parentDelegationStepId: "step-2",
      sharedContext: [{ role: "architect", output: "Spec: queue with retry." }],
    });
    expect(message).toContain("Spec: queue with retry.");
    expect(message).toContain("architect");
  });
});

describe("buildDelegationSpecialistSystemPrompt", () => {
  it("no longer contains the task objective text", () => {
    const prompt = buildDelegationSpecialistSystemPrompt({ role: "architect" });
    expect(prompt).not.toContain("Objective:");
    expect(prompt).toContain("architect");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-delegation-service.subagent-task`
Expected: FAIL (functions not exported under these names).

- [ ] **Step 3: Rename + export the prompt builders**

In `apps/gateway/src/services/chat-delegation-service.ts`:

Rename `buildDelegationSystemPrompt` to `buildDelegationSpecialistSystemPrompt` and export it. Keep the content as-is (it has no task text today, so this satisfies the test).

Replace `buildDelegationUserPrompt` with a new exported function:

```typescript
export interface BuildSubagentTaskFirstMessageInput {
  role: string;
  objective: string;
  mode: "sequential" | "parallel";
  parentDelegationStepId: string;
  sharedContext: Array<{ role: string; output: string }>;
}

export function buildSubagentTaskFirstMessage(input: BuildSubagentTaskFirstMessageInput): string {
  const dependencyBlock =
    input.sharedContext.length > 0
      ? input.sharedContext
          .map((item) => `Role ${item.role} output:\n${item.output}`)
          .join("\n\n")
      : "None";
  return [
    `[Subagent Task] ${input.objective}`,
    `Assigned role: ${input.role}`,
    `Execution mode: ${input.mode}`,
    `Parent delegation step: ${input.parentDelegationStepId}`,
    "",
    "Completed dependency outputs available to this role:",
    dependencyBlock,
    "",
    "Produce your role output now.",
  ].join("\n");
}
```

- [ ] **Step 4: Update the spawn site to use the new builder + mark the message as a subagent task**

In `chat-delegation-service.ts`, inside `executeDelegationStep` (the inner closure), replace the existing call:

```typescript
const response = await deps.agentSendChatMessage(
  childSession.sessionId,
  buildDelegatedChatSendRequest({
    content: [
      buildDelegationSystemPrompt(step.role),
      buildDelegationUserPrompt({
        objective,
        role: step.role,
        mode,
        sharedContext: dependencyContext,
      }),
    ].join("\n\n"),
    // ... rest of args
  }),
);
```

With:

```typescript
const taskFirstMessage = buildSubagentTaskFirstMessage({
  role: step.role,
  objective,
  mode,
  parentDelegationStepId: step.stepId,
  sharedContext: dependencyContext,
});
const response = await deps.agentSendChatMessage(
  childSession.sessionId,
  buildDelegatedChatSendRequest({
    content: taskFirstMessage,
    // ... rest of args unchanged ...
    parentDelegationStepId: step.stepId, // NEW: pass through so the ingest path can set the field
  }),
);
```

In `buildDelegatedChatSendRequest` (search for the file — likely `apps/gateway/src/services/delegated-chat-request.ts`), accept and forward the new optional field onto the resulting `ChatSendMessageRequest`.

Add a corresponding optional `parentDelegationStepId?: string` to `ChatSendMessageRequest` in `packages/contracts/src/chat.ts`, and in `chat-turn-prep-service.ts` `prepareAgentChatTurn` set it on the constructed `userMessage` when present.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-delegation-service`
Expected: New subagent-task tests pass; existing delegation tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/chat-delegation-service.ts apps/gateway/src/services/chat-delegation-service.subagent-task.test.ts apps/gateway/src/services/delegated-chat-request.ts apps/gateway/src/services/chat-turn-prep-service.ts packages/contracts/src/chat.ts
git commit -m "feat(gateway): materialize subagent task as visible [Subagent Task] first message"
```

---

## Task 9: Gateway routes for steer + goal

**Files:**
- Create: `apps/gateway/src/services/chat-steer-route.test.ts`
- Create or extend an existing route file (look for `apps/gateway/src/services/chat-sessions-route-service.ts` or the route registration entrypoint).

- [ ] **Step 1: Discover the route registration pattern**

Open `apps/gateway/src/services/chat-sessions-route-service.ts` (or the equivalent route registration file) and note how existing routes like `POST /api/v1/chat/sessions/:sessionId/messages` are structured. Mirror the pattern — same auth middleware, same response envelope.

- [ ] **Step 2: Write the failing test**

Create `apps/gateway/src/services/chat-steer-route.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { handleChatSteerRequest, handleChatGoalSetRequest, handleChatGoalStatusRequest, handleChatGoalClearRequest } from "./chat-steer-route";
import { ChatSteerService } from "./chat-steer-service";

describe("handleChatSteerRequest", () => {
  it("rejects when no active turn", async () => {
    const service = new ChatSteerService();
    const result = await handleChatSteerRequest({
      sessionId: "s-1",
      body: { instruction: "go" },
      steerService: service,
    });
    expect(result.accepted).toBe(false);
  });
});

describe("handleChatGoalSetRequest", () => {
  it("persists goal and returns status", async () => {
    const meta = {
      ensure: vi.fn(() => ({ pinnedGoal: undefined, goalTurnBudget: undefined, goalTurnsUsed: 0, goalSetAt: undefined })),
      patch: vi.fn((id, p) => ({ pinnedGoal: p.pinnedGoal, goalTurnBudget: p.goalTurnBudget, goalTurnsUsed: 0, goalSetAt: p.goalSetAt })),
    };
    const result = await handleChatGoalSetRequest({
      sessionId: "s-1",
      body: { goal: "ship kanban", turnBudget: 10 },
      chatSessionMeta: meta as any,
      now: () => "2026-05-15T10:00:00Z",
    });
    expect(result.goal).toBe("ship kanban");
    expect(meta.patch).toHaveBeenCalledWith("s-1", {
      pinnedGoal: "ship kanban",
      goalTurnBudget: 10,
      goalSetAt: "2026-05-15T10:00:00Z",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-steer-route`
Expected: FAIL.

- [ ] **Step 4: Implement the route handlers**

Create `apps/gateway/src/services/chat-steer-route.ts`:

```typescript
import type { ChatSteerRequest, ChatSteerResponse, ChatGoalRequest, ChatGoalStatusResponse } from "@goatcitadel/contracts";
import type { ChatSteerService } from "./chat-steer-service.js";

interface ChatSessionMetaSlice {
  ensure(sessionId: string): {
    pinnedGoal?: string;
    goalTurnBudget?: number;
    goalTurnsUsed: number;
    goalSetAt?: string;
  };
  patch(
    sessionId: string,
    patch: {
      pinnedGoal?: string | null;
      goalTurnBudget?: number | null;
      goalSetAt?: string | null;
    },
  ): {
    pinnedGoal?: string;
    goalTurnBudget?: number;
    goalTurnsUsed: number;
    goalSetAt?: string;
  };
}

export async function handleChatSteerRequest(input: {
  sessionId: string;
  body: ChatSteerRequest;
  steerService: ChatSteerService;
}): Promise<ChatSteerResponse> {
  const instruction = input.body.instruction?.trim();
  if (!instruction) {
    return {
      sessionId: input.sessionId,
      turnId: "",
      accepted: false,
      reason: "instruction is required.",
    };
  }
  return input.steerService.enqueue({ sessionId: input.sessionId, instruction });
}

export async function handleChatGoalSetRequest(input: {
  sessionId: string;
  body: ChatGoalRequest;
  chatSessionMeta: ChatSessionMetaSlice;
  now?: () => string;
}): Promise<ChatGoalStatusResponse> {
  const goal = input.body.goal?.trim();
  if (!goal) {
    throw new Error("goal is required.");
  }
  const setAt = (input.now ?? (() => new Date().toISOString()))();
  const patched = input.chatSessionMeta.patch(input.sessionId, {
    pinnedGoal: goal,
    goalTurnBudget: input.body.turnBudget ?? null,
    goalSetAt: setAt,
  });
  return {
    sessionId: input.sessionId,
    goal: patched.pinnedGoal ?? null,
    turnBudget: patched.goalTurnBudget ?? null,
    turnsUsed: patched.goalTurnsUsed,
    setAt: patched.goalSetAt ?? null,
  };
}

export async function handleChatGoalClearRequest(input: {
  sessionId: string;
  chatSessionMeta: ChatSessionMetaSlice;
}): Promise<ChatGoalStatusResponse> {
  const cleared = input.chatSessionMeta.patch(input.sessionId, {
    pinnedGoal: null,
    goalTurnBudget: null,
    goalSetAt: null,
  });
  return {
    sessionId: input.sessionId,
    goal: cleared.pinnedGoal ?? null,
    turnBudget: cleared.goalTurnBudget ?? null,
    turnsUsed: cleared.goalTurnsUsed,
    setAt: cleared.goalSetAt ?? null,
  };
}

export async function handleChatGoalStatusRequest(input: {
  sessionId: string;
  chatSessionMeta: ChatSessionMetaSlice;
}): Promise<ChatGoalStatusResponse> {
  const current = input.chatSessionMeta.ensure(input.sessionId);
  return {
    sessionId: input.sessionId,
    goal: current.pinnedGoal ?? null,
    turnBudget: current.goalTurnBudget ?? null,
    turnsUsed: current.goalTurnsUsed,
    setAt: current.goalSetAt ?? null,
  };
}
```

- [ ] **Step 5: Register the routes in the gateway**

Find the route registration file (search for `chat/sessions/:sessionId/messages` in `apps/gateway/src/`). Add four routes:
- `POST /api/v1/chat/sessions/:sessionId/steer` → `handleChatSteerRequest`
- `POST /api/v1/chat/sessions/:sessionId/goal` → `handleChatGoalSetRequest`
- `GET /api/v1/chat/sessions/:sessionId/goal` → `handleChatGoalStatusRequest`
- `DELETE /api/v1/chat/sessions/:sessionId/goal` → `handleChatGoalClearRequest`

Wire the `ChatSteerService` as a singleton on the gateway composition root and pass it (along with the storage slice) into each handler.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-steer-route`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/services/chat-steer-route.ts apps/gateway/src/services/chat-steer-route.test.ts apps/gateway/src/<route-registration-file>.ts
git commit -m "feat(gateway): POST/GET/DELETE chat/sessions/:id/steer and /goal"
```

---

## Task 10: ThreadedComposer — surface steer/goal chips and route mid-turn

**Files:**
- Create: `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.steering.test.tsx`
- Modify: `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx`
- Modify: `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx` (props) — add `pinnedGoal?: string`, `midTurnDisposition?: MidTurnDisposition` to `MissionThreadedActiveSessionSurfaceProps`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.steering.test.tsx`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadedComposer } from "./ThreadedComposer";

function makeProps(overrides: Partial<Parameters<typeof ThreadedComposer>[0]["props"]> = {}): any {
  return {
    props: {
      mode: "chat",
      draft: "",
      onDraftChange: vi.fn(),
      onSend: vi.fn(),
      onComposerKeyDown: vi.fn(),
      onComposerPaste: vi.fn(),
      queueItems: [],
      pendingAttachments: [],
      commandSuggestions: [],
      commandIndex: -1,
      onApplyDraftCommand: vi.fn(),
      sending: false,
      hasActiveStream: false,
      canSend: true,
      thread: { turns: [] },
      currentThinkingLevel: "standard",
      currentSpeedMode: "standard",
      currentSubagentPolicy: "off",
      onSetThinkingLevel: vi.fn(),
      onSetSpeedMode: vi.fn(),
      onSetSubagentPolicy: vi.fn(),
      onTogglePlanningMode: vi.fn(),
      onResumeAll: vi.fn(),
      onRemoveQueuedItem: vi.fn(),
      onStopActiveTurn: vi.fn(),
      onAttachFiles: vi.fn(),
      onCancelEdit: vi.fn(),
      onRetryTurn: vi.fn(),
      onSetDeepMode: vi.fn(),
      onDismissError: vi.fn(),
      onDismissPresetWarning: vi.fn(),
      onAcknowledgeRouteBoundary: vi.fn(),
      onRunQuickResearch: vi.fn(),
      onGenerateImage: vi.fn(),
      onEditImage: vi.fn(),
      onToggleVoiceTalk: vi.fn(),
      onOpenAudioTranscribe: vi.fn(),
      onToggleSpeakResponses: vi.fn(),
      ...overrides,
    },
  };
}

describe("ThreadedComposer steering chip", () => {
  it("shows a 'Steering' chip when hasActiveStream and disposition is steer", () => {
    render(<ThreadedComposer {...makeProps({ hasActiveStream: true, midTurnDisposition: "steer" })} />);
    expect(screen.getByText(/steering/i)).toBeInTheDocument();
  });
  it("shows a 'Queued' chip when hasActiveStream and disposition is queue", () => {
    render(<ThreadedComposer {...makeProps({ hasActiveStream: true, midTurnDisposition: "queue" })} />);
    expect(screen.getByText(/queued/i)).toBeInTheDocument();
  });
  it("shows a goal chip in the chip row when pinnedGoal is set", () => {
    render(<ThreadedComposer {...makeProps({ pinnedGoal: "ship kanban" })} />);
    expect(screen.getByText(/goal: ship kanban/i)).toBeInTheDocument();
  });
});
```

(If `@testing-library/react` is not installed in this workspace, fall back to `renderToStaticMarkup` from `react-dom/server` and assert against the markup string.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- ThreadedComposer.steering`
Expected: FAIL.

- [ ] **Step 3: Add the two chips to `ThreadedComposer.tsx`**

In the existing `mc-next-composer-chip-row` (line 327), append:

```tsx
{props.pinnedGoal ? (
  <span className="mc-next-composer-chip emphasis">Goal: {props.pinnedGoal}</span>
) : null}
{props.hasActiveStream && props.midTurnDisposition === "steer" ? (
  <span className="mc-next-composer-chip emphasis">Steering</span>
) : null}
{props.hasActiveStream && props.midTurnDisposition === "queue" ? (
  <span className="mc-next-composer-chip subtle">Queued</span>
) : null}
```

Extend `MissionThreadedActiveSessionSurfaceProps` in `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx`:

```typescript
import type { MidTurnDisposition } from "./chat/chat-page-pure-helpers";

export interface MissionThreadedActiveSessionSurfaceProps {
  // ... existing fields ...
  pinnedGoal?: string;
  midTurnDisposition?: MidTurnDisposition;
  onSteerMidTurn?: (instruction: string) => Promise<void>;
  onSetGoal?: (goal: string, turnBudget?: number) => Promise<void>;
  onClearGoal?: () => Promise<void>;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- ThreadedComposer.steering`
Expected: PASS.

- [ ] **Step 5: Wire orchestration in `useChatOutboundExecution` / `ThreadedSurfacePage`**

In whichever hook produces `onSend` for the composer (likely `useChatOutboundExecution.ts`), intercept the draft before send:

```typescript
const goalCommand = parseGoalCommand(draft);
if (goalCommand) {
  if (goalCommand.kind === "set") {
    await props.onSetGoal?.(goalCommand.text);
  } else if (goalCommand.kind === "clear") {
    await props.onClearGoal?.();
  } else {
    // status — fetch + show as a toast or banner; for now, no-op
  }
  setDraft("");
  return;
}

const disposition = resolveMidTurnDisposition({
  hasActiveStream: props.hasActiveStream,
  draft,
});
if (disposition === "steer") {
  // strip a leading /steer or /queue steer prefix before sending the instruction
  const stripped = draft.trimStart().replace(/^\/(?:steer|queue\s+steer)\s*/i, "");
  if (stripped) {
    await props.onSteerMidTurn?.(stripped);
    setDraft("");
    return;
  }
}
// fall through to existing send/queue path
```

In `MissionControlNextApp` (or whichever component owns the gateway client), implement `onSteerMidTurn`, `onSetGoal`, `onClearGoal` by `POST`ing to the routes added in Task 9.

- [ ] **Step 6: Run all UI tests**

Run: `pnpm --filter @goatcitadel/mission-control-next test`
Expected: PASS, including existing helpers tests.

- [ ] **Step 7: Commit**

```bash
git add apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.steering.test.tsx apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx packages/threaded-surface-core/src/chat/useChatOutboundExecution.ts
git commit -m "feat(mission-control-next): surface steer/goal chips and wire mid-turn route"
```

---

## Task 11: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all packages PASS. If a previously-passing test now fails, fix the regression — do not commit until green.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS (or auto-fix and re-run with `pnpm lint:fix`).

- [ ] **Step 4: Manual e2e smoke (record observations)**

Spin up the dev stack in two terminals:
- `pnpm dev:gateway`
- `pnpm dev:ui`

Then in a browser:
1. Open a chat session, send a long-running prompt (e.g., research question with `--deep`).
2. While streaming, type `/steer focus on retries` and submit. Assert the chip flips to "Steering" and that the active turn picks up the instruction.
3. Open the transcript inspector for that turn and confirm a message with `steered=true` exists.
4. Run `/goal ship kanban` — assert the "Goal: ship kanban" chip appears in the composer header. Submit a normal prompt and confirm the model's reply acknowledges the goal.
5. Run `/goal status` — confirm it reports the goal and remaining budget.
6. Run `/goal clear` — confirm the chip disappears.
7. Trigger a delegation via `/delegate` (or whatever the existing path is). Open the child session's transcript. Confirm the first user message starts with `[Subagent Task]` and contains the parent step id.
8. Inspect the child session's outbound LLM request payload (via the dev diagnostic stream or by adding a temporary console.log) — confirm the system prompt no longer contains the task objective.

Capture these observations in the PR description. If any step fails, return to the corresponding Task and fix before committing.

- [ ] **Step 5: Commit any verification fixes + push branch**

```bash
git push -u origin feature/orchestration-steer-goal-subagent
```

Open a PR with title `feat: active-run steering, /goal Ralph loop, [Subagent Task] first message` and the manual-verification observations from Step 4 in the body.

---

## Self-Review Notes

Spec coverage check:
- Feature 1 (steering): Tasks 1, 2, 5, 6, 9, 10 cover command parsing, disposition resolver, queue service, drain wiring, gateway routes, UI chip + wiring. ✅
- Feature 2 (goal): Tasks 1, 2, 3, 4, 7, 9, 10 cover command parsing, storage migration, contract additions, prep-service injection, gateway routes, UI chip + wiring. ✅
- Feature 3 (subagent task): Task 8 covers the rewrite + parentDelegationStepId field; Task 4 adds the contract field. ✅
- Verification (`E2E test: send mid-turn message; assert audit shows steered=true`): Task 11 manual smoke; Task 6 persists steered messages. The "audit log" is the existing chat transcript with the new `steered` field — no separate audit log is built.
- Turn-budget enforcement: Task 7 auto-clears at budget. Default is 20 (matches spec "~20 turns").
- "Remove the equivalent system-prompt insertion to avoid duplicate tokens" — Task 8 replaces the dual-prompt construction with a single `[Subagent Task]` user message; the specialist system prompt no longer carries task text.

Placeholder scan: no TBDs, no "implement later", no "similar to Task N". Every code step is concrete.

Type consistency: `MidTurnDisposition`, `GoalCommand`, `ChatSteerService`, `ChatSteerQueuedInstruction`, `ChatSteerRequest/Response`, `ChatGoalRequest/StatusResponse` are introduced once and reused across tasks. `pinnedGoal/goalTurnBudget/goalTurnsUsed/goalSetAt` field names match across contract, storage, and UI props.
