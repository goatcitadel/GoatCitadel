# Unified Surface Auto-Router — Gateway Core (Phase 1A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side auto-routing of a new thread's first turn into `chat`/`cowork`/`code` (heuristic), persisted sticky in existing session prefs, with user overrides recorded as learning signals — all exposed through the existing chat send API and fully testable without any UI.

**Architecture:** A thin gateway `SurfaceRouterService` wraps a pure heuristic classifier (mirroring `model-router-decision-service` regexes) and emits a `routing_choice` runtime-decision trace. A new transient `autoRoute` request flag triggers classification on the first turn only; the resolved mode is persisted via the existing `chat_session_prefs.mode` path (sticky). Overrides (explicit `mode` ≠ persisted mode) are recorded through a new public `ImprovementService.recordSurfaceRouteOverrideSignal` wrapper. **No new tables, no migrations.**

**Tech Stack:** TypeScript, gateway services (Vitest + `vi` mocks), `@goatcitadel/contracts`, Node `DatabaseSync` storage (`node:test`/`assert` for storage, Vitest for gateway).

---

## Source-of-truth references (verified)

- `ChatMode = "chat" | "cowork" | "code"` — `packages/contracts/src/chat.ts:17`
- `ChatSendMessageRequest.mode?: ChatMode` — `packages/contracts/src/chat.ts:1586-1606`
- Entry: `agentSendChatMessage(host, sessionId, input, options?)` — `apps/gateway/src/services/chat-turn-entry-service.ts:147`; calls `resolveChatRouteDescriptor(host, sessionId, { mode: input.mode, ... })` at `:154-164`
- Mode resolution from prefs: `buildPreviewPrefs` `mode: input.mode ?? input.prefsOverride?.mode` — `apps/gateway/src/services/chat-route-resolution.ts:75-94`; prefs loaded via `chatSessionPrefs.ensure(sessionId)`; default `"chat"` — `packages/storage/src/chat-session-prefs-repo.ts:70`
- Persist mode: `updateChatSessionPrefs(deps, sessionId, buildChatModePrefsPatch(mode))` — `apps/gateway/src/services/chat-session-service.ts:334-336`
- `recordImprovementSignal(input: ImprovementSignalInput)` is **private** — `apps/gateway/src/services/improvement-service.ts:1641`; input type `:181-209`
- `ImprovementSignalOrigin = "runtime" | "human" | "evaluation" | "improvement_internal"`, `ImprovementSignalClass = "runtime" | "approval" | "evaluation"`, `ImprovementSignalOutcome = "positive" | "negative" | "neutral"` — `packages/contracts/src/improvement.ts:277-281` (`signalKind` is a free-form `string`)
- `RuntimeDecisionTraceRepository.append(input): RuntimeDecisionTraceRecord` — `packages/storage/src/runtime-decision-trace-repo.ts:98`; `RUNTIME_DECISION_KINDS` includes `"routing_choice"` — `packages/contracts/src/runtime-decision-trace.ts:10-35`; record `:108-121`
- Mirror regexes from `apps/gateway/src/services/model-router-decision-service.ts:34-47`

### Assumptions to confirm before Task 5 (2-minute check, not a placeholder)

1. The exact field names on `RuntimeDecisionScope` (`packages/contracts/src/runtime-decision-trace.ts`) — this plan uses `{ citadelId, workspaceId, sessionId, turnId }`. If a name differs, adjust the trace `scope` object accordingly.
2. How `agentSendChatMessage`'s `host` exposes session prefs (read + `updateChatSessionPrefs` deps). This plan adds two host accessors (`host.readChatSessionMode`, `host.persistChatSessionMode`) in Task 5; confirm whether equivalents already exist and reuse them if so.

---

## File structure

- **Create** `apps/gateway/src/services/surface-router-heuristics.ts` — pure classifier (`classifySurfaceHeuristic`). One responsibility: text+context → `{ mode, confidence, rationale, alternatives }`.
- **Create** `apps/gateway/src/services/surface-router-heuristics.test.ts`
- **Create** `apps/gateway/src/services/surface-router-service.ts` — orchestrates classify + emit `routing_choice` trace. Depends on the heuristic + the trace repo.
- **Create** `apps/gateway/src/services/surface-router-service.test.ts`
- **Modify** `packages/contracts/src/chat.ts` — add `autoRoute?: boolean` to `ChatSendMessageRequest`.
- **Modify** `apps/gateway/src/services/improvement-service.ts` — add public `recordSurfaceRouteOverrideSignal(...)`.
- **Modify** `apps/gateway/src/services/improvement-service.test.ts` — cover the wrapper.
- **Modify** `apps/gateway/src/services/chat-turn-entry-service.ts` — wire auto-route + override detection.
- **Modify** `apps/gateway/src/services/chat-turn-entry-service.test.ts` — integration coverage.

---

## Task 1: Pure surface heuristic classifier

**Files:**
- Create: `apps/gateway/src/services/surface-router-heuristics.ts`
- Test: `apps/gateway/src/services/surface-router-heuristics.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/gateway/src/services/surface-router-heuristics.test.ts
import { describe, expect, it } from "vitest";
import { classifySurfaceHeuristic } from "./surface-router-heuristics.js";

describe("classifySurfaceHeuristic", () => {
  it("routes explicit coding intent to code with high confidence", () => {
    const result = classifySurfaceHeuristic("run tests in the repo and fix the failing pytest", {
      hasBoundProject: true,
    });
    expect(result.mode).toBe("code");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.alternatives).not.toContain("code");
  });

  it("routes research/multi-step intent to cowork", () => {
    const result = classifySurfaceHeuristic("research the top 5 vector databases and compare tradeoffs", {
      hasBoundProject: false,
    });
    expect(result.mode).toBe("cowork");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("defaults a plain greeting to chat with low confidence", () => {
    const result = classifySurfaceHeuristic("hey, how are you?", { hasBoundProject: false });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("treats an empty prompt as low-confidence chat", () => {
    const result = classifySurfaceHeuristic("   ", { hasBoundProject: false });
    expect(result.mode).toBe("chat");
    expect(result.confidence).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test surface-router-heuristics`
Expected: FAIL — `classifySurfaceHeuristic` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/gateway/src/services/surface-router-heuristics.ts
import type { ChatMode } from "@goatcitadel/contracts";

export interface SurfaceHeuristicContext {
  hasBoundProject: boolean;
  workspaceCapabilityHints?: { code?: boolean; research?: boolean };
}

export interface SurfaceClassification {
  mode: ChatMode;
  confidence: number; // 0..1
  source: "heuristic";
  rationale: string;
  alternatives: ChatMode[];
}

// Mirrors model-router-decision-service.ts:34-47 intent signals.
const DIRECT_CODING_RE = /\b(repo|run tests?|pytest|ruff|fix the repo)\b/i;
const CODING_RE =
  /\b(code|coding|repo|repository|implement|implementation|pytest|ruff|unit tests?|tests?|debug|bug|pull request|pr)\b/i;
const RESEARCH_RE = /\b(research|look up|search|browse|cite|citations?|sources?|trends?|compare|web)\b/i;
const REASONING_RE =
  /\b(architecture|architect|design|plan|multi-step|strategy|roadmap|trade-?offs?|edge cases?|data flow|rollout|migration)\b/i;

const STRONG = 0.85;
const SOFT = 0.6;
const DEFAULT = 0.3;

export function classifySurfaceHeuristic(prompt: string, context: SurfaceHeuristicContext): SurfaceClassification {
  const text = (prompt || "").trim();
  if (!text) {
    return { mode: "chat", confidence: DEFAULT, source: "heuristic", rationale: "empty prompt", alternatives: [] };
  }

  if (DIRECT_CODING_RE.test(text)) {
    return { mode: "code", confidence: STRONG, source: "heuristic", rationale: "explicit code/test intent", alternatives: ["cowork", "chat"] };
  }
  if (RESEARCH_RE.test(text)) {
    return { mode: "cowork", confidence: STRONG, source: "heuristic", rationale: "research/compare intent", alternatives: ["chat", "code"] };
  }
  if (CODING_RE.test(text) || context.workspaceCapabilityHints?.code) {
    return { mode: "code", confidence: SOFT, source: "heuristic", rationale: "soft code signal/capability", alternatives: ["cowork", "chat"] };
  }
  if (REASONING_RE.test(text)) {
    return { mode: "cowork", confidence: SOFT, source: "heuristic", rationale: "multi-step reasoning intent", alternatives: ["chat", "code"] };
  }
  return { mode: "chat", confidence: DEFAULT, source: "heuristic", rationale: "no strong signal", alternatives: ["cowork", "code"] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test surface-router-heuristics`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/surface-router-heuristics.ts apps/gateway/src/services/surface-router-heuristics.test.ts
git commit -m "feat(gateway): add surface-router heuristic classifier"
```

---

## Task 2: Add `autoRoute` flag to the chat send request

**Files:**
- Modify: `packages/contracts/src/chat.ts:1586-1606`

- [ ] **Step 1: Add the field**

In `ChatSendMessageRequest`, add directly after the existing `mode?: ChatMode;` line:

```typescript
  mode?: ChatMode;
  /**
   * When true and the session has no resolved mode yet, the gateway auto-routes
   * this turn into chat/cowork/code instead of defaulting to "chat".
   * Transient (request-only); never persisted.
   */
  autoRoute?: boolean;
```

- [ ] **Step 2: Typecheck the contracts package**

Run: `pnpm --filter @goatcitadel/contracts typecheck`
Expected: PASS (no errors — additive optional field).

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/chat.ts
git commit -m "feat(contracts): add transient autoRoute flag to ChatSendMessageRequest"
```

---

## Task 3: `SurfaceRouterService` — decide + emit `routing_choice` trace

**Files:**
- Create: `apps/gateway/src/services/surface-router-service.ts`
- Test: `apps/gateway/src/services/surface-router-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/gateway/src/services/surface-router-service.test.ts
import { describe, expect, it, vi } from "vitest";
import { SurfaceRouterService } from "./surface-router-service.js";

describe("SurfaceRouterService", () => {
  it("classifies and appends a routing_choice trace with scope", () => {
    const append = vi.fn();
    const service = new SurfaceRouterService({
      classify: (prompt, ctx) => ({
        mode: "code",
        confidence: 0.85,
        source: "heuristic",
        rationale: "explicit code/test intent",
        alternatives: ["cowork", "chat"],
      }),
      traceRepo: { append } as never,
    });

    const result = service.route({
      prompt: "run tests in the repo",
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      context: { hasBoundProject: true },
    });

    expect(result.mode).toBe("code");
    expect(append).toHaveBeenCalledTimes(1);
    const traceArg = append.mock.calls[0][0];
    expect(traceArg.kind).toBe("routing_choice");
    expect(traceArg.selected).toBe("code");
    expect(traceArg.scope).toMatchObject({ citadelId: "personal", workspaceId: "default", sessionId: "s1", turnId: "t1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test surface-router-service`
Expected: FAIL — `SurfaceRouterService` is not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/gateway/src/services/surface-router-service.ts
import type { RuntimeDecisionTraceRepository } from "@goatcitadel/storage";
import type { SurfaceClassification, SurfaceHeuristicContext } from "./surface-router-heuristics.js";
import { classifySurfaceHeuristic } from "./surface-router-heuristics.js";

export interface SurfaceRouteRequest {
  prompt: string;
  citadelId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  context: SurfaceHeuristicContext;
}

export interface SurfaceRouterServiceDeps {
  classify?: (prompt: string, ctx: SurfaceHeuristicContext) => SurfaceClassification;
  traceRepo: Pick<RuntimeDecisionTraceRepository, "append">;
}

export class SurfaceRouterService {
  private readonly classify: NonNullable<SurfaceRouterServiceDeps["classify"]>;
  private readonly traceRepo: SurfaceRouterServiceDeps["traceRepo"];

  constructor(deps: SurfaceRouterServiceDeps) {
    this.classify = deps.classify ?? classifySurfaceHeuristic;
    this.traceRepo = deps.traceRepo;
  }

  public route(request: SurfaceRouteRequest): SurfaceClassification {
    const result = this.classify(request.prompt, request.context);
    this.traceRepo.append({
      kind: "routing_choice",
      scope: {
        citadelId: request.citadelId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        turnId: request.turnId,
      },
      selected: result.mode,
      rationale: `${result.rationale} (source=${result.source}, confidence=${result.confidence.toFixed(2)})`,
      alternatives: result.alternatives.map((mode) => ({ option: mode })),
    });
    return result;
  }
}
```

> If `RuntimeDecisionAlternative` is not `{ option: string }`, adjust the `alternatives.map` shape to match `packages/contracts/src/runtime-decision-trace.ts` (the test will catch the mismatch). If `RuntimeDecisionScope` omits `citadelId`, drop it from the scope object.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test surface-router-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/surface-router-service.ts apps/gateway/src/services/surface-router-service.test.ts
git commit -m "feat(gateway): add SurfaceRouterService that emits routing_choice traces"
```

---

## Task 4: Public `recordSurfaceRouteOverrideSignal` on `ImprovementService`

**Files:**
- Modify: `apps/gateway/src/services/improvement-service.ts` (add public method near the other `record*Signal` wrappers, e.g. after `recordApprovalResolutionSignal` ~:1223)
- Test: `apps/gateway/src/services/improvement-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// in apps/gateway/src/services/improvement-service.test.ts — add to the existing suite
import { describe, expect, it, vi } from "vitest";
// (reuse the file's existing ImprovementService construction helper)

describe("recordSurfaceRouteOverrideSignal", () => {
  it("records a human/negative signal with kind surface_route_override and a stable fingerprint", () => {
    const { service, recorded } = makeImprovementServiceForTest(); // existing/local helper

    service.recordSurfaceRouteOverrideSignal({
      citadelId: "personal",
      workspaceId: "default",
      sessionId: "s1",
      turnId: "t1",
      fromMode: "code",
      toMode: "chat",
      autoConfidence: 0.85,
      promptFeatureHash: "abc123",
    });

    expect(recorded).toHaveLength(1);
    const signal = recorded[0];
    expect(signal.origin).toBe("human");
    expect(signal.signalKind).toBe("surface_route_override");
    expect(signal.outcome).toBe("negative");
    expect(signal.fingerprint).toContain("personal");
    expect(signal.fingerprint).toContain("code");
    expect(signal.fingerprint).toContain("chat");
  });
});
```

> If the test file lacks a construction helper that captures recorded signals, spy on the private recorder via the public method's effect (assert against the in-memory `improvement_signals` table through the service's existing read API). Match the file's established pattern from the top-of-file imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test improvement-service`
Expected: FAIL — `recordSurfaceRouteOverrideSignal` is not a function.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/gateway/src/services/improvement-service.ts — new public method
export interface SurfaceRouteOverrideSignalInput {
  citadelId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  fromMode: string;
  toMode: string;
  autoConfidence: number;
  promptFeatureHash: string;
}

// inside class ImprovementService:
public recordSurfaceRouteOverrideSignal(input: SurfaceRouteOverrideSignalInput): void {
  const fingerprint = `surface_route_override:${input.citadelId}:${input.fromMode}->${input.toMode}:${input.promptFeatureHash}`;
  this.recordImprovementSignal({
    sourceService: "surface-router",
    sourceType: "surface_route_override",
    sourceId: input.sessionId,
    sourceEventId: input.turnId,
    idempotencyKey: `${input.sessionId}:${input.turnId}:surface_route_override`,
    workspaceId: input.workspaceId,
    origin: "human",
    signalClass: "runtime",
    signalKind: "surface_route_override",
    outcome: "negative",
    fingerprint,
    sessionId: input.sessionId,
    turnId: input.turnId,
    metadata: {
      citadelId: input.citadelId,
      fromMode: input.fromMode,
      toMode: input.toMode,
      autoConfidence: input.autoConfidence,
    },
  });
}
```

> `signalClass` must be one of `"runtime" | "approval" | "evaluation"` — we use `"runtime"` and carry the specific type in the free-form `signalKind`. `citadelId` rides in `metadata` (the signal input has no top-level citadel field); the citadel-scoped exemplar query in Phase 2 will filter on `metadata.citadelId` (or on `workspaceId → citadelId`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test improvement-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/improvement-service.ts apps/gateway/src/services/improvement-service.test.ts
git commit -m "feat(gateway): record surface-route overrides as human improvement signals"
```

---

## Task 5: Wire auto-route into the turn-entry seam

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-entry-service.ts:147-164`
- Test: `apps/gateway/src/services/chat-turn-entry-service.test.ts`

**Behavior:** before `resolveChatRouteDescriptor`, if `input.autoRoute` is true AND the session has no resolved mode yet (no persisted `chat_session_prefs.mode`), run the `SurfaceRouterService`, set `input.mode` to the result, and persist it so the thread is sticky.

- [ ] **Step 1: Write the failing integration test**

```typescript
// apps/gateway/src/services/chat-turn-entry-service.test.ts — add a case
it("auto-routes the first turn when autoRoute is set and no mode is persisted", async () => {
  const persistChatSessionMode = vi.fn();
  const route = vi.fn(() => ({ mode: "code", confidence: 0.85, source: "heuristic", rationale: "x", alternatives: [] }));
  const host = makeChatTurnEntryHost({
    // existing helper; inject these two seams:
    readChatSessionMode: () => undefined, // no persisted mode
    persistChatSessionMode,
    surfaceRouter: { route },
    resolveChatRouteDescriptor: vi.fn(() => makeRouteDescriptor({ mode: "code" })),
  });

  await agentSendChatMessage(host, "s1", { content: "run tests in the repo", autoRoute: true });

  expect(route).toHaveBeenCalledTimes(1);
  expect(persistChatSessionMode).toHaveBeenCalledWith("s1", "code");
});

it("does not auto-route when a mode is already persisted", async () => {
  const route = vi.fn();
  const host = makeChatTurnEntryHost({
    readChatSessionMode: () => "cowork",
    persistChatSessionMode: vi.fn(),
    surfaceRouter: { route },
  });

  await agentSendChatMessage(host, "s1", { content: "anything", autoRoute: true });

  expect(route).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test chat-turn-entry-service`
Expected: FAIL — host has no `surfaceRouter`/`readChatSessionMode`/`persistChatSessionMode`; auto-route branch absent.

- [ ] **Step 3: Extend the host interface and wire the branch**

Add to `ChatTurnEntryHost` (the host interface in this file):

```typescript
  surfaceRouter?: { route: (req: SurfaceRouteRequest) => SurfaceClassification };
  readChatSessionMode?: (sessionId: string) => ChatMode | undefined;
  persistChatSessionMode?: (sessionId: string, mode: ChatMode) => void;
```

In `agentSendChatMessage`, immediately before the `resolveChatRouteDescriptor(...)` call (`:154`):

```typescript
if (input.autoRoute && input.mode === undefined && host.surfaceRouter && host.readChatSessionMode && host.persistChatSessionMode) {
  const persistedMode = host.readChatSessionMode(sessionId);
  if (persistedMode === undefined) {
    const citadelId = resolveCitadelId(host, sessionId); // existing resolver; see chat-turn-prep-service workspace→citadel logic
    const workspaceId = resolveWorkspaceId(host, sessionId);
    const classified = host.surfaceRouter.route({
      prompt: input.content,
      citadelId,
      workspaceId,
      sessionId,
      turnId: input.operatorId ? `${sessionId}:pending` : `${sessionId}:pending`,
      context: { hasBoundProject: hasBoundProject(host, sessionId) },
    });
    input = { ...input, mode: classified.mode };
    host.persistChatSessionMode(sessionId, classified.mode);
  }
}
```

> `resolveCitadelId`/`resolveWorkspaceId`/`hasBoundProject` mirror the existing turn-prep logic (`workspaceId = sessionMeta.workspaceId`; `citadelId = workspaces.find(workspaceId)?.citadelId ?? DEFAULT_CITADEL_ID`). If those helpers don't exist yet in this module, add small private helpers using `host.storage`. Use a real `turnId` if one is allocated before this point; otherwise pass the turn id created downstream (acceptable to use the session-scoped pending id for the trace in v1).

Wire the three host seams in the gateway composition root where `ChatTurnEntryHost` is built:
- `surfaceRouter: new SurfaceRouterService({ traceRepo: storage.runtimeDecisionTraces })`
- `readChatSessionMode: (id) => chatSessionPrefs.ensure(id).mode`
- `persistChatSessionMode: (id, mode) => updateChatSessionPrefs(deps, id, buildChatModePrefsPatch(mode))`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test chat-turn-entry-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-turn-entry-service.ts apps/gateway/src/services/chat-turn-entry-service.test.ts
git commit -m "feat(gateway): auto-route first turn via SurfaceRouterService when autoRoute is set"
```

---

## Task 6: Detect and record overrides

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-entry-service.ts`
- Test: `apps/gateway/src/services/chat-turn-entry-service.test.ts`

**Behavior:** when `input.mode` is explicitly set, differs from the persisted mode, AND a persisted mode existed (i.e. the user changed it via the chip), persist the new mode and record an override signal. A sticky turn (`input.mode === persistedMode`) records nothing.

- [ ] **Step 1: Write the failing test**

```typescript
it("records an override when explicit mode differs from the persisted mode", async () => {
  const recordSurfaceRouteOverrideSignal = vi.fn();
  const persistChatSessionMode = vi.fn();
  const host = makeChatTurnEntryHost({
    readChatSessionMode: () => "code",
    persistChatSessionMode,
    improvementService: { recordSurfaceRouteOverrideSignal },
  });

  await agentSendChatMessage(host, "s1", { content: "actually just chat", mode: "chat" });

  expect(recordSurfaceRouteOverrideSignal).toHaveBeenCalledTimes(1);
  expect(recordSurfaceRouteOverrideSignal.mock.calls[0][0]).toMatchObject({ fromMode: "code", toMode: "chat" });
  expect(persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
});

it("does not record an override on a sticky turn (mode unchanged)", async () => {
  const recordSurfaceRouteOverrideSignal = vi.fn();
  const host = makeChatTurnEntryHost({
    readChatSessionMode: () => "code",
    improvementService: { recordSurfaceRouteOverrideSignal },
  });

  await agentSendChatMessage(host, "s1", { content: "keep going", mode: "code" });

  expect(recordSurfaceRouteOverrideSignal).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test chat-turn-entry-service`
Expected: FAIL — no override branch / host lacks `improvementService`.

- [ ] **Step 3: Implement the override branch**

Add `improvementService?: { recordSurfaceRouteOverrideSignal: (input: SurfaceRouteOverrideSignalInput) => void }` to `ChatTurnEntryHost`. After the auto-route block and before `resolveChatRouteDescriptor`:

```typescript
if (input.mode !== undefined && host.readChatSessionMode && host.persistChatSessionMode) {
  const persistedMode = host.readChatSessionMode(sessionId);
  if (persistedMode !== undefined && persistedMode !== input.mode) {
    host.persistChatSessionMode(sessionId, input.mode);
    host.improvementService?.recordSurfaceRouteOverrideSignal({
      citadelId: resolveCitadelId(host, sessionId),
      workspaceId: resolveWorkspaceId(host, sessionId),
      sessionId,
      turnId: `${sessionId}:pending`,
      fromMode: persistedMode,
      toMode: input.mode,
      autoConfidence: 0,
      promptFeatureHash: hashPromptFeatures(input.content),
    });
  }
}
```

Add a tiny pure helper at the bottom of the module:

```typescript
function hashPromptFeatures(content: string): string {
  // Stable, non-reversible bucket of the prompt's shape (length + first word), not the transcript.
  const firstWord = (content.trim().split(/\s+/)[0] ?? "").toLowerCase().slice(0, 24);
  return `${firstWord}:${Math.min(content.length, 4000)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test chat-turn-entry-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-turn-entry-service.ts apps/gateway/src/services/chat-turn-entry-service.test.ts
git commit -m "feat(gateway): record surface-route overrides on explicit mode change"
```

---

## Task 7: Composition wiring + full gateway suite

**Files:**
- Modify: the gateway composition root where `ChatTurnEntryHost`/services are constructed (search for the existing `agentSendChatMessage` host assembly).

- [ ] **Step 1: Wire the real dependencies**

Construct `SurfaceRouterService` once and pass the three seams + `improvementService` into the host (as in Task 5 Step 3). Ensure `autoRoute` flows from the route handler into `ChatSendMessageRequest` (it already passes `input` through; no handler change needed unless the request is re-validated — if a Zod schema gates the send body, add `autoRoute: z.boolean().optional()`).

- [ ] **Step 2: Run the full gateway test suite**

Run: `pnpm --filter @goatcitadel/gateway test`
Expected: PASS (no regressions; new suites green).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @goatcitadel/gateway typecheck && pnpm --filter @goatcitadel/gateway lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A apps/gateway/src
git commit -m "chore(gateway): wire SurfaceRouterService into the chat-turn entry host"
```

---

## Out of scope (separate plans)

- **Phase 1B — Unified surface UI:** collapse the three `PrimaryArea` entries into one surface, mode chip + 1-click override, low-confidence confirm, code+unbound bind prompt, and send `autoRoute: true` on first turn. (`route-model.ts`, `MissionControlNextApp.tsx`, `ThreadedComposer.tsx`, `useChatOutboundExecution.ts`.)
- **Phase 2 — Judge + learning loop:** LLM-judge fallback on low confidence, citadel-scoped exemplar retrieval from `improvement_signals` (filter `signalKind = "surface_route_override"` by `metadata.citadelId`), and wiring the existing weekly improvement scheduler to consume override stats. Depends on this plan + #145.
- **Phase 0 storage hygiene:** NOT required for this plan — `workspaces.citadel_id` is already added by SQLite migration v121 and `citadelId`/`workspaceId` are derivable at turn time. Verify the v121 path on a fresh DB; if a real gap is found, file a separate migration task.

## Notes
- No new tables, no migrations in this plan.
- Every override is recorded immediately (fast learning channel); Phase 2 consumes them.
- Confidence threshold for "ask before committing" is a UI concern (Phase 1B) reading the trace/classification confidence; the gateway always returns it.
