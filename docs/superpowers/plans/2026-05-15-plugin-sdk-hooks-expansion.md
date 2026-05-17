# Plugin/Extension SDK Expansion (O10–O15) Implementation Plan

> Implementation-plan artifact only. This document may name proposed files, commands, tests, and runtime behavior; treat those as plan intent, not shipped 1.0 truth, unless the current implementation and release evidence prove them.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the plugin/extension SDK with 4 new `HookTrigger` values, an intercept-veto regression suite, a `tool_override` plugin flag, a `[[as_document]]` skill output directive, and page-scoped dashboard slots — per the OpenClaw + Hermes Agent gap review for 2026-05-15.

**Architecture:** Each feature is contract-first. Add the type to `packages/contracts/src/*.ts`, then wire it into the relevant service in `apps/gateway/src/services/*.ts` (or `packages/skills-core` / `packages/extensions-sdk` for the skill-side and addon-side bits). New hook triggers go through the existing `HooksService.runInlineHooks` / `enqueueAfterHooks` pipelines so we get circuit breakers, audit logging, and durable delivery for free.

**Tech Stack:** TypeScript, Fastify (gateway routes), Vitest (tests), Zod (route schemas), pnpm workspaces.

**Original workstream label:** `feature/plugin-sdk-hooks-expansion`; historical plan metadata, not the current release branch.

---

## File Structure

| Layer | Path | Purpose |
|---|---|---|
| Contracts | `packages/contracts/src/hooks.ts` | New `HookTrigger` literals + payload + patch types for `gateway.dispatch.before`, `transform_llm_output`, `approval.request.before`, `approval.response.after` |
| Contracts | `packages/contracts/src/integrations.ts` | `IntegrationPluginToolOverride` + `toolOverrides` on `IntegrationPluginRecord` + owner-approval record |
| Contracts | `packages/contracts/src/skills.ts` | `SkillOutputDocumentDirective` (parsed `[[as_document]]`) |
| Contracts | `packages/contracts/src/addons.ts` | `DashboardSlotDeclaration` + `dashboardSlots` on addon manifest |
| Gateway | `apps/gateway/src/routes/hooks.ts` | Add new trigger names to the Zod enum |
| Gateway | `apps/gateway/src/services/hooks-service.ts` | Update `assertTriggerModeSupported` allowlists |
| Gateway | `apps/gateway/src/services/hook-patch-helpers.ts` | Add `parseTransformLlmOutputHookPatch`, parse helpers for new triggers |
| Gateway | `apps/gateway/src/services/llm-completion-service.ts` | Wire `gateway.dispatch.before` (before `llm.request.before`) + `transform_llm_output` (after model returns, before publishRealtime) |
| Gateway | `apps/gateway/src/services/approval-lifecycle-service.ts` | Wire `approval.request.before` immediately before `approval.create.before` |
| Gateway | `apps/gateway/src/services/approval-resolution-effects-service.ts` | Enqueue `approval.response.after` alongside existing `approval.resolve.after` |
| Gateway | `apps/gateway/src/services/tool-invocation-coordinator-service.ts` | (No code change — has working veto; add coverage test) |
| Gateway | `apps/gateway/src/services/plugin-tool-override-service.ts` **NEW** | Plugin tool override registry with owner approval state |
| Gateway | `apps/gateway/src/services/skill-output-directives.ts` **NEW** | `[[as_document]]` parser for skill output → attachment payload |
| Gateway | `apps/gateway/src/services/addon-slot-service.ts` **NEW** | Enumerate dashboard slot declarations registered by installed addons/plugins |
| Tests | `apps/gateway/src/services/*.test.ts` | Vitest tests colocated with each service |

---

## Pre-flight: Branch + Baseline

- [ ] **Step 1: Confirm branch name with user**

The current worktree is on `goatrocity/practical-nightingale-e904c6`. The user requested `feature/plugin-sdk-hooks-expansion`. Ask whether to:
- (a) rename current branch in this worktree, or
- (b) open a new worktree on the new branch.

- [ ] **Step 2: Verify baseline build is green before starting**

Run: `pnpm -w typecheck && pnpm -w test --filter @goatcitadel/contracts --filter @goatcitadel/gateway-app`
Expected: PASS — no pre-existing red.

- [ ] **Step 3: Commit nothing yet — start TDD cycle below**

---

## Task 1: Add `gateway.dispatch.before` HookTrigger (O12 part 1)

Fires once per user message entering the gateway dispatch path — BEFORE `llm.request.before` and BEFORE any tool resolution. Lets plugins block or annotate a dispatch with a single observation point.

**Files:**
- Modify: `packages/contracts/src/hooks.ts`
- Modify: `apps/gateway/src/routes/hooks.ts`
- Modify: `apps/gateway/src/services/hooks-service.ts:571-594` (`assertTriggerModeSupported`)
- Modify: `apps/gateway/src/services/llm-completion-service.ts`
- Test: `apps/gateway/src/services/llm-completion-service.test.ts`
- Test: `apps/gateway/src/services/hooks-service.test.ts`

- [ ] **Step 1: Write failing contract test**

Add to `packages/contracts/src/module-load-smoke.test.ts` (or wherever HookTrigger union is exercised) a test that asserts `"gateway.dispatch.before"` is assignable to `HookTrigger`. Use a type-level check pattern from existing tests in the same file.

```ts
import type { HookTrigger } from "./hooks.js";

it("includes gateway.dispatch.before in HookTrigger", () => {
  const trigger: HookTrigger = "gateway.dispatch.before";
  expect(trigger).toBe("gateway.dispatch.before");
});
```

- [ ] **Step 2: Run the test — it should fail**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: FAIL (literal not in union).

- [ ] **Step 3: Add the trigger to the union**

Edit `packages/contracts/src/hooks.ts:11-30`. Add `"gateway.dispatch.before"` after `"llm.request.before"`. Also add to `HookPatchByTrigger` interface a `never` entry so it compiles.

```ts
export type HookTrigger =
  | "llm.model.select.before"
  | "llm.request.before"
  | "gateway.dispatch.before"   // NEW
  | "llm.response.after"
  | "transform_llm_output"      // NEW (Task 2)
  | ...
```

Add to `HookPatchByTrigger`:

```ts
export interface HookPatchByTrigger {
  ...
  "gateway.dispatch.before": GatewayDispatchHookPatch;
  ...
}
```

Add new patch interface:

```ts
export interface GatewayDispatchHookPatch {
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 4: Run the contract test — should pass**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: PASS.

- [ ] **Step 5: Write failing route schema test**

Add to `apps/gateway/src/services/hooks-service.test.ts` a new test that creates a workspace hook with trigger `"gateway.dispatch.before"` and `mode: "intercept"`, then expects no `ValidationError`.

```ts
it("accepts gateway.dispatch.before for intercept mode hooks", () => {
  const { service, workspaceId } = createHarness({
    workspacePrefs: { hooks: { allowInterceptingHooks: true } },
  });
  const created = service.createWorkspaceHook({
    workspaceId,
    label: "dispatch-veto",
    trigger: "gateway.dispatch.before",
    mode: "intercept",
    action: { type: "webhook", webhook: { url: "https://hooks.example.test/dispatch" } },
  });
  expect(created.trigger).toBe("gateway.dispatch.before");
  expect(created.mode).toBe("intercept");
});
```

- [ ] **Step 6: Run test — should fail with `ValidationError: Trigger gateway.dispatch.before only supports observe hooks in v1`**

Run: `pnpm --filter @goatcitadel/gateway-app test -- hooks-service`
Expected: FAIL.

- [ ] **Step 7: Update `assertTriggerModeSupported` allowlist**

Edit `apps/gateway/src/services/hooks-service.ts:571-594`. `gateway.dispatch.before` should support all three modes (observe/mutate/intercept). Leave the existing `if (trigger === "..." || ...)` whitelist untouched — `gateway.dispatch.before` does NOT belong there since it's not an after-only trigger.

- [ ] **Step 8: Update route Zod enum**

Edit `apps/gateway/src/routes/hooks.ts:27-47`. Add `"gateway.dispatch.before"` to the `z.enum([...])` literal list.

- [ ] **Step 9: Run hooks-service tests — should pass**

Run: `pnpm --filter @goatcitadel/gateway-app test -- hooks-service`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/contracts/src/hooks.ts packages/contracts/src/module-load-smoke.test.ts \
  apps/gateway/src/routes/hooks.ts apps/gateway/src/services/hooks-service.ts \
  apps/gateway/src/services/hooks-service.test.ts
git commit -m "feat(contracts): add gateway.dispatch.before HookTrigger"
```

- [ ] **Step 11: Write failing wiring test**

Add to `apps/gateway/src/services/llm-completion-service.test.ts` a test that:
1. Sets up a mock `hooksService.runInlineHooks` that records each `trigger` value it sees.
2. Calls `createChatCompletion`.
3. Asserts `runInlineHooks` was called first with `"gateway.dispatch.before"` and then with `"llm.request.before"` (in that order).

Use the existing test harness pattern in the file (see the `llm.request.before` assertion around line 442).

- [ ] **Step 12: Run test — should fail (only `llm.request.before` is called)**

Run: `pnpm --filter @goatcitadel/gateway-app test -- llm-completion-service`
Expected: FAIL.

- [ ] **Step 13: Wire `gateway.dispatch.before` into `createChatCompletion`**

Edit `apps/gateway/src/services/llm-completion-service.ts:195` (just before the existing `runInlineHooks` for `llm.request.before`). Add:

```ts
const dispatchHook = await host.hooksService.runInlineHooks({
  workspaceId: chatHookWorkspaceId,
  trigger: "gateway.dispatch.before",
  entityType: "chat_completion",
  entityId: chatHookEntityId,
  payload: {
    providerId: hookableRequest.providerId,
    model: hookableRequest.model,
    messageCount: hookableRequest.messages.length,
    metadata: hookableRequest.metadata ?? {},
  },
  parsePatch: () => undefined,
});
if (dispatchHook.blockedBy) {
  throw new Error(dispatchHook.blockedBy.reason);
}
```

Do the same in `createChatCompletionStream` (mirror placement before the existing `llm.request.before` hook).

- [ ] **Step 14: Run test — should pass**

Run: `pnpm --filter @goatcitadel/gateway-app test -- llm-completion-service`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add apps/gateway/src/services/llm-completion-service.ts apps/gateway/src/services/llm-completion-service.test.ts
git commit -m "feat(gateway): fire gateway.dispatch.before before llm.request.before"
```

---

## Task 2: Add `transform_llm_output` HookTrigger (O11)

Fires AFTER the LLM responds but BEFORE the response is returned to the caller / published over realtime. Mode `mutate` returns a transformed payload; mode `intercept` may veto with a reason that surfaces in the turn transcript.

**Files:**
- Modify: `packages/contracts/src/hooks.ts`
- Modify: `apps/gateway/src/services/hook-patch-helpers.ts`
- Modify: `apps/gateway/src/routes/hooks.ts`
- Modify: `apps/gateway/src/services/hooks-service.ts`
- Modify: `apps/gateway/src/services/llm-completion-service.ts`
- Test: `apps/gateway/src/services/hook-patch-helpers.test.ts` (create if missing)
- Test: `apps/gateway/src/services/llm-completion-service.test.ts`

- [ ] **Step 1: Write failing contract test**

Add to `packages/contracts/src/module-load-smoke.test.ts`:

```ts
it("includes transform_llm_output in HookTrigger", () => {
  const trigger: HookTrigger = "transform_llm_output";
  expect(trigger).toBe("transform_llm_output");
});
```

- [ ] **Step 2: Run test — should fail**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: FAIL.

- [ ] **Step 3: Add trigger + patch types to hooks.ts**

In `packages/contracts/src/hooks.ts`, add `"transform_llm_output"` to the union (next to `gateway.dispatch.before`). Add:

```ts
export interface TransformLlmOutputHookPatch {
  content?: string;
  contentParts?: Array<{ type: "text" | "tool_use" | "tool_result"; [key: string]: unknown }>;
  metadata?: Record<string, unknown>;
}
```

Add to `HookPatchByTrigger`:

```ts
"transform_llm_output": TransformLlmOutputHookPatch;
```

Add to `HookPatch` union:

```ts
export type HookPatch =
  | LlmModelSelectHookPatch
  | LlmRequestHookPatch
  | TransformLlmOutputHookPatch  // NEW
  | ToolCallHookPatch
  | ...
```

- [ ] **Step 4: Run contract test — should pass**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: PASS.

- [ ] **Step 5: Write failing patch-helper test**

Add `apps/gateway/src/services/hook-patch-helpers.test.ts` (create file). Import `parseTransformLlmOutputHookPatch` (not yet exported). Write tests:

```ts
import { describe, expect, it } from "vitest";
import { parseTransformLlmOutputHookPatch } from "./hook-patch-helpers.js";

describe("parseTransformLlmOutputHookPatch", () => {
  it("returns undefined when no recognized fields", () => {
    expect(parseTransformLlmOutputHookPatch({})).toBeUndefined();
  });
  it("parses content override", () => {
    expect(parseTransformLlmOutputHookPatch({ content: "redacted" })).toEqual({ content: "redacted" });
  });
  it("rejects empty string content", () => {
    expect(parseTransformLlmOutputHookPatch({ content: "" })).toBeUndefined();
  });
  it("parses metadata", () => {
    expect(parseTransformLlmOutputHookPatch({ metadata: { reason: "policy" } })).toEqual({
      metadata: { reason: "policy" },
    });
  });
});
```

- [ ] **Step 6: Run test — should fail (function not exported)**

Run: `pnpm --filter @goatcitadel/gateway-app test -- hook-patch-helpers`
Expected: FAIL (import error).

- [ ] **Step 7: Add `parseTransformLlmOutputHookPatch` to hook-patch-helpers.ts**

Follow the existing pattern of `parseLlmRequestHookPatch`:

```ts
export function parseTransformLlmOutputHookPatch(
  value: Record<string, unknown>,
): TransformLlmOutputHookPatch | undefined {
  const content =
    typeof value.content === "string" && value.content.trim() ? value.content : undefined;
  const metadata =
    value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : undefined;
  const contentParts = Array.isArray(value.contentParts)
    ? (value.contentParts.filter(
        (part): part is { type: "text" | "tool_use" | "tool_result"; [key: string]: unknown } =>
          Boolean(part) &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          ((part as { type?: unknown }).type === "text" ||
            (part as { type?: unknown }).type === "tool_use" ||
            (part as { type?: unknown }).type === "tool_result"),
      ) as TransformLlmOutputHookPatch["contentParts"])
    : undefined;
  if (!content && !metadata && !contentParts) {
    return undefined;
  }
  return {
    ...(content ? { content } : {}),
    ...(contentParts ? { contentParts } : {}),
    ...(metadata ? { metadata } : {}),
  };
}
```

Also re-export the type from this module.

- [ ] **Step 8: Run test — should pass**

Run: `pnpm --filter @goatcitadel/gateway-app test -- hook-patch-helpers`
Expected: PASS.

- [ ] **Step 9: Update `assertTriggerModeSupported` allowlist in hooks-service.ts**

The current allowlist (lines 571-594) restricts `mode !== "observe"` for after-triggers. `transform_llm_output` SHOULD support mutate + intercept (it's the whole point) — so do NOT add it to the restrictive list. Verify the implicit default branch in that function permits new triggers; if not, add an explicit case.

- [ ] **Step 10: Update route Zod enum**

Add `"transform_llm_output"` to `apps/gateway/src/routes/hooks.ts:27-47`.

- [ ] **Step 11: Write failing wiring test**

Add to `apps/gateway/src/services/llm-completion-service.test.ts`:
1. Mutating hook test: mock `runInlineHooks` for `"transform_llm_output"` to return `{ patch: { content: "scrubbed" } }`. Assert the returned `ChatCompletionResponse.choices[0].message.content` is `"scrubbed"`.
2. Intercept hook test: mock `runInlineHooks` for `"transform_llm_output"` to return `{ blockedBy: { type: "block", reason: "policy" } }`. Assert the call throws with `/policy/`.

- [ ] **Step 12: Run tests — should fail**

Run: `pnpm --filter @goatcitadel/gateway-app test -- llm-completion-service`
Expected: FAIL (no hook wired yet).

- [ ] **Step 13: Wire `transform_llm_output` in `createChatCompletion`**

In `apps/gateway/src/services/llm-completion-service.ts`, after the LLM call returns successfully (line ~445, right after `if (!response)` guard at 408 and before `host.publishRealtime` at 451), add:

```ts
const transformHook = await host.hooksService.runInlineHooks<TransformLlmOutputHookPatch>({
  workspaceId: chatHookWorkspaceId,
  trigger: "transform_llm_output",
  entityType: "chat_completion",
  entityId: chatHookEntityId,
  payload: {
    providerId: routing.effectiveProviderId ?? primaryProviderId,
    model: routing.effectiveModel ?? primaryModel,
    response,
  },
  parsePatch: (value) => parseTransformLlmOutputHookPatch(value as Record<string, unknown>),
  mergePatch: (current, next) => ({ ...(current ?? {}), ...next }),
});
if (transformHook.blockedBy) {
  throw new Error(transformHook.blockedBy.reason);
}
if (transformHook.patch?.content && response.choices[0]?.message) {
  response.choices[0].message.content = transformHook.patch.content;
}
```

For streaming (`createChatCompletionStream`), the transform happens on the assembled response after the stream concludes — find the equivalent post-stream synthesis path.

- [ ] **Step 14: Run tests — should pass**

Run: `pnpm --filter @goatcitadel/gateway-app test -- llm-completion-service`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add packages/contracts/src/hooks.ts packages/contracts/src/module-load-smoke.test.ts \
  apps/gateway/src/routes/hooks.ts apps/gateway/src/services/hook-patch-helpers.ts \
  apps/gateway/src/services/hook-patch-helpers.test.ts \
  apps/gateway/src/services/llm-completion-service.ts \
  apps/gateway/src/services/llm-completion-service.test.ts
git commit -m "feat(hooks): add transform_llm_output hook trigger"
```

---

## Task 3: Add `approval.request.before` HookTrigger (O12 part 2)

Fires when an agent decides to REQUEST an approval — before `approval.create.before` (which lets plugins patch the create input). Intent: plugins that want to short-circuit the entire approval flow without inspecting payload shape.

**Files:**
- Modify: `packages/contracts/src/hooks.ts`
- Modify: `apps/gateway/src/routes/hooks.ts`
- Modify: `apps/gateway/src/services/hooks-service.ts` allowlist
- Modify: `apps/gateway/src/services/approval-lifecycle-service.ts:388-435`
- Test: `apps/gateway/src/services/approval-lifecycle-service.test.ts`

- [ ] **Step 1: Write failing contract test**

Add to `module-load-smoke.test.ts`:

```ts
it("includes approval.request.before in HookTrigger", () => {
  const trigger: HookTrigger = "approval.request.before";
  expect(trigger).toBe("approval.request.before");
});
```

- [ ] **Step 2: Run — fails**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: FAIL.

- [ ] **Step 3: Add trigger to union**

In `packages/contracts/src/hooks.ts`, add `"approval.request.before"` next to `"approval.create.before"`.

Add to `HookPatchByTrigger`:

```ts
"approval.request.before": never;
```

(No patch — pure veto trigger.)

- [ ] **Step 4: Run — passes**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: PASS.

- [ ] **Step 5: Add to route enum and to mode allowlist**

Add `"approval.request.before"` to `apps/gateway/src/routes/hooks.ts:27-47`.

In `hooks-service.ts` `assertTriggerModeSupported`, the trigger should support `observe` + `intercept` only (no mutate — there's no patch). Add an explicit case:

```ts
if (trigger === "approval.request.before" && mode === "mutate") {
  throw new ValidationError({
    message: `Trigger ${trigger} does not support mutate hooks.`,
  });
}
```

- [ ] **Step 6: Write failing wiring test**

Add to `apps/gateway/src/services/approval-lifecycle-service.test.ts`:

```ts
it("fires approval.request.before and respects veto", async () => {
  const triggers: HookTrigger[] = [];
  const hooksService = {
    runInlineHooks: vi.fn(async (input: { trigger: HookTrigger }) => {
      triggers.push(input.trigger);
      if (input.trigger === "approval.request.before") {
        return { blockedBy: { type: "block", reason: "policy: blocked" }, runs: [] };
      }
      return { runs: [] };
    }),
    enqueueAfterHooks: vi.fn(),
  };
  // ... wire host stub with hooksService
  await expect(createApproval(host, { kind: "tool_invoke", ... })).rejects.toThrow(/policy: blocked/);
  expect(triggers).toEqual(["approval.request.before"]);  // never reached create.before
});
```

- [ ] **Step 7: Run — fails**

Run: `pnpm --filter @goatcitadel/gateway-app test -- approval-lifecycle-service`
Expected: FAIL.

- [ ] **Step 8: Wire `approval.request.before` in `createApproval()`**

Edit `apps/gateway/src/services/approval-lifecycle-service.ts` around line 392 (just inside `createApproval`, before the existing `approval.create.before` block). Add:

```ts
const requestHook = await host.hooksService.runInlineHooks({
  workspaceId: approvalHookWorkspaceId,
  trigger: "approval.request.before",
  entityType: "approval",
  entityId: approvalHookEntityId,
  payload: {
    kind: input.kind,
    riskLevel: input.riskLevel,
    payload: input.payload,
  },
  parsePatch: () => undefined,
});
if (requestHook.blockedBy) {
  throw new Error(requestHook.blockedBy.reason);
}
```

- [ ] **Step 9: Run — passes**

Run: `pnpm --filter @goatcitadel/gateway-app test -- approval-lifecycle-service`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/contracts/src/hooks.ts packages/contracts/src/module-load-smoke.test.ts \
  apps/gateway/src/routes/hooks.ts apps/gateway/src/services/hooks-service.ts \
  apps/gateway/src/services/approval-lifecycle-service.ts \
  apps/gateway/src/services/approval-lifecycle-service.test.ts
git commit -m "feat(hooks): add approval.request.before pre-create veto trigger"
```

---

## Task 4: Add `approval.response.after` HookTrigger (O12 part 3)

Fires when an approval response has been computed and is being delivered back to the requesting agent — alongside the existing `approval.resolve.after`. Distinguished from resolve.after by payload semantics (resolution + delivery channel).

**Files:**
- Modify: `packages/contracts/src/hooks.ts`
- Modify: `apps/gateway/src/routes/hooks.ts`
- Modify: `apps/gateway/src/services/hooks-service.ts` allowlist (observe-only)
- Modify: `apps/gateway/src/services/approval-resolution-effects-service.ts:668-694`
- Test: `apps/gateway/src/services/approval-resolution-effects-service.test.ts`

- [ ] **Step 1: Write failing contract test**

Add to `module-load-smoke.test.ts`:

```ts
it("includes approval.response.after in HookTrigger", () => {
  const trigger: HookTrigger = "approval.response.after";
  expect(trigger).toBe("approval.response.after");
});
```

- [ ] **Step 2: Run — fails. Add to union, run — passes**

Run: `pnpm --filter @goatcitadel/contracts test`

Add `"approval.response.after"` next to `"approval.resolve.after"`. Set its `HookPatchByTrigger` entry to `never`. Add to mode allowlist as observe-only (after-trigger pattern, same as `approval.resolve.after` at line 583).

- [ ] **Step 3: Add to route enum**

Add `"approval.response.after"` to `apps/gateway/src/routes/hooks.ts`.

- [ ] **Step 4: Write failing wiring test**

Add to `approval-resolution-effects-service.test.ts`:

```ts
it("enqueues approval.response.after alongside approval.resolve.after", async () => {
  const calls: HookTrigger[] = [];
  const enqueueAfterHooks = vi.fn((input: { trigger: HookTrigger }) => calls.push(input.trigger));
  // ... wire service with stub deps
  await service.handleApprovalAfterHooks(testEffect);
  expect(calls).toContain("approval.resolve.after");
  expect(calls).toContain("approval.response.after");
});
```

- [ ] **Step 5: Run — fails**

Run: `pnpm --filter @goatcitadel/gateway-app test -- approval-resolution-effects-service`
Expected: FAIL.

- [ ] **Step 6: Wire in `handleApprovalAfterHooks()`**

Edit `apps/gateway/src/services/approval-resolution-effects-service.ts:677-687`. After the existing `enqueueAfterHooks({ trigger: "approval.resolve.after", ... })` call, add:

```ts
this.deps.enqueueAfterHooks({
  workspaceId,
  trigger: "approval.response.after",
  entityType: "approval",
  entityId: approval.approvalId,
  payload: {
    approval,
    decision,
    resolvedBy,
    deliveryChannel: payload.deliveryChannel ?? null,
  },
});
```

Update the `enqueueAfterHooks` `trigger` discriminant on the deps type to also accept `"approval.response.after"`.

- [ ] **Step 7: Run — passes**

Run: `pnpm --filter @goatcitadel/gateway-app test -- approval-resolution-effects-service`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/hooks.ts packages/contracts/src/module-load-smoke.test.ts \
  apps/gateway/src/routes/hooks.ts apps/gateway/src/services/hooks-service.ts \
  apps/gateway/src/services/approval-resolution-effects-service.ts \
  apps/gateway/src/services/approval-resolution-effects-service.test.ts
git commit -m "feat(hooks): add approval.response.after observer trigger"
```

---

## Task 5: Pre-Tool Veto Regression Suite + Doc (O13)

Verify `HookMode = "intercept"` actually blocks tool execution today and add regression coverage. Existing wiring at `apps/gateway/src/services/tool-invocation-coordinator-service.ts:255-261` returns `outcome: "blocked"` when `beforeHook.blockedBy` is set — confirm with an integration test.

**Files:**
- Test: `apps/gateway/src/services/tool-invocation-coordinator-service.test.ts` (new tests)
- Modify: `packages/contracts/src/hooks.ts` (jsdoc only — document veto contract)

- [ ] **Step 1: Write failing test that proves veto blocks execution**

Add to `tool-invocation-coordinator-service.test.ts`:

```ts
it("blocks tool execution when intercept hook returns a block decision", async () => {
  const policyInvoke = vi.fn();
  const hooksService = {
    runInlineHooks: vi.fn(async () => ({
      blockedBy: { type: "block" as const, reason: "policy:dryrun-blocked" },
      runs: [],
    })),
    enqueueAfterHooks: vi.fn(),
  };
  const coordinator = new ToolInvocationCoordinatorService({
    ...buildBaseHost(),
    hooksService,
    policyEngine: { invoke: policyInvoke, evaluateAccess: () => ({ allowed: true, requiresApproval: false, reasonCodes: [] }) },
  });
  const result = await coordinator.invokeTool({
    toolName: "shell.exec",
    args: { command: "echo hi" },
    agentId: "agent-1",
    sessionId: "session-1",
  });
  expect(result.outcome).toBe("blocked");
  expect(result.policyReason).toMatch(/policy:dryrun-blocked/);
  expect(policyInvoke).not.toHaveBeenCalled();  // tool NEVER ran
});
```

- [ ] **Step 2: Run — verify it PASSES today (regression test for existing behavior)**

Run: `pnpm --filter @goatcitadel/gateway-app test -- tool-invocation-coordinator-service`
Expected: PASS (existing behavior is correct — this is a regression guard).

If it fails, that means the veto is broken — file an immediate fix.

- [ ] **Step 3: Add JSDoc to HookMode in contracts**

Edit `packages/contracts/src/hooks.ts:5`. Replace:

```ts
export type HookMode = "observe" | "mutate" | "intercept";
```

with:

```ts
/**
 * Hook execution mode.
 *
 * - `observe`: hook receives the event but cannot affect dispatch. Best for logging,
 *   metrics, audit fan-out. Failure of observe hooks never blocks the caller.
 * - `mutate`: hook may return a `patch` object that the runtime merges back into the
 *   request before execution proceeds. Only valid for `*.before` triggers that define
 *   a `HookPatchByTrigger` entry.
 * - `intercept`: hook may return `{ decision: { type: "block", reason } }` to veto
 *   the operation. The runtime surfaces the reason to the caller (transcript / API
 *   error) and never invokes the underlying side effect. Combine with
 *   `failPolicy: "closed"` for fail-closed enforcement when the hook itself errors.
 */
export type HookMode = "observe" | "mutate" | "intercept";
```

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/services/tool-invocation-coordinator-service.test.ts packages/contracts/src/hooks.ts
git commit -m "test(hooks): add regression guard for intercept-mode tool veto"
```

---

## Task 6: Plugin `tool_override` Flag (O10)

A plugin can declare it overrides a built-in tool name. On first activation, owner approval is required. Current `ToolInvocationCoordinatorService` coverage proves that an approved override with a registered handler routes through the plugin handler; product-ready override behavior still depends on handler registration and e2e/live coverage for each installed plugin.

**Files:**
- Modify: `packages/contracts/src/integrations.ts`
- Modify: `packages/contracts/src/channels.ts` (manifest schema)
- Create: `apps/gateway/src/services/plugin-tool-override-service.ts`
- Create: `apps/gateway/src/services/plugin-tool-override-service.test.ts`
- Test: in same file

- [ ] **Step 1: Write failing contract test**

Add `packages/contracts/src/integrations.test.ts` (if it doesn't exist, create it):

```ts
import type { IntegrationPluginToolOverride, IntegrationPluginRecord } from "./channels.js";

it("supports IntegrationPluginToolOverride records on plugin records", () => {
  const record: IntegrationPluginRecord = {
    pluginId: "search-plus",
    label: "Search Plus",
    version: "1.0.0",
    enabled: true,
    installedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    capabilities: ["tool:web_search"],
    toolOverrides: [{ toolName: "web_search", override: true, status: "pending_owner_approval" }],
  };
  expect(record.toolOverrides?.[0]?.toolName).toBe("web_search");
});
```

- [ ] **Step 2: Run — fails (type does not exist)**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: FAIL.

- [ ] **Step 3: Add types**

In `packages/contracts/src/channels.ts`, add after `IntegrationPluginAuthorManifest`:

```ts
export type IntegrationPluginToolOverrideStatus =
  | "pending_owner_approval"
  | "approved"
  | "revoked";

export interface IntegrationPluginToolOverride {
  toolName: string;
  override: boolean;
  status: IntegrationPluginToolOverrideStatus;
  approvedAt?: string;
  approvedBy?: string;
  revokedAt?: string;
}

export interface IntegrationPluginToolOverrideManifestEntry {
  toolName: string;
  override: boolean;
}
```

Extend `IntegrationPluginRecord`:

```ts
export interface IntegrationPluginRecord {
  ...
  toolOverrides?: IntegrationPluginToolOverride[];
}
```

Extend `IntegrationPluginAuthorManifest`:

```ts
export interface IntegrationPluginAuthorManifest {
  ...
  toolOverrides?: IntegrationPluginToolOverrideManifestEntry[];
}
```

- [ ] **Step 4: Run — passes**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: PASS.

- [ ] **Step 5: Write failing service test**

Create `apps/gateway/src/services/plugin-tool-override-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PluginToolOverrideService } from "./plugin-tool-override-service.js";

describe("PluginToolOverrideService", () => {
  it("records a pending override on registration", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({
      pluginId: "search-plus",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    const claims = service.listClaims();
    expect(claims).toEqual([
      expect.objectContaining({
        pluginId: "search-plus",
        toolName: "web_search",
        status: "pending_owner_approval",
      }),
    ]);
  });

  it("approving a claim transitions status and records approver", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({
      pluginId: "search-plus",
      toolName: "web_search",
      override: true,
      claimedAt: "2026-05-15T00:00:00.000Z",
    });
    const approved = service.approveClaim({ pluginId: "search-plus", toolName: "web_search", approvedBy: "owner-1" });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("owner-1");
  });

  it("rejects approval by non-owner", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({ pluginId: "p", toolName: "t", override: true, claimedAt: "2026-05-15T00:00:00.000Z" });
    expect(() =>
      service.approveClaim({ pluginId: "p", toolName: "t", approvedBy: "intruder-2" }),
    ).toThrow(/owner/i);
  });

  it("resolveActiveOverride returns the approved plugin for the tool", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({ pluginId: "p", toolName: "t", override: true, claimedAt: "2026-05-15T00:00:00.000Z" });
    service.approveClaim({ pluginId: "p", toolName: "t", approvedBy: "owner-1" });
    expect(service.resolveActiveOverride("t")).toEqual(expect.objectContaining({ pluginId: "p" }));
  });

  it("resolveActiveOverride returns undefined when pending", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({ pluginId: "p", toolName: "t", override: true, claimedAt: "2026-05-15T00:00:00.000Z" });
    expect(service.resolveActiveOverride("t")).toBeUndefined();
  });

  it("revoke flips status to revoked", () => {
    const service = new PluginToolOverrideService({ getOwnerId: () => "owner-1" });
    service.registerOverrideClaim({ pluginId: "p", toolName: "t", override: true, claimedAt: "2026-05-15T00:00:00.000Z" });
    service.approveClaim({ pluginId: "p", toolName: "t", approvedBy: "owner-1" });
    const revoked = service.revokeClaim({ pluginId: "p", toolName: "t", revokedBy: "owner-1" });
    expect(revoked.status).toBe("revoked");
    expect(service.resolveActiveOverride("t")).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run — fails (no service)**

Run: `pnpm --filter @goatcitadel/gateway-app test -- plugin-tool-override-service`
Expected: FAIL.

- [ ] **Step 7: Implement the service**

Create `apps/gateway/src/services/plugin-tool-override-service.ts`:

```ts
import type { IntegrationPluginToolOverride } from "@goatcitadel/contracts";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";

export interface PluginToolOverrideClaimInput {
  pluginId: string;
  toolName: string;
  override: boolean;
  claimedAt: string;
}

export interface PluginToolOverrideClaimRecord extends IntegrationPluginToolOverride {
  pluginId: string;
  claimedAt: string;
}

export interface PluginToolOverrideServiceDeps {
  getOwnerId(): string;
}

export class PluginToolOverrideService {
  private readonly claims = new Map<string, PluginToolOverrideClaimRecord>();

  public constructor(private readonly deps: PluginToolOverrideServiceDeps) {}

  public registerOverrideClaim(input: PluginToolOverrideClaimInput): PluginToolOverrideClaimRecord {
    if (!input.pluginId.trim() || !input.toolName.trim()) {
      throw new ValidationError({ message: "pluginId and toolName are required." });
    }
    const key = makeKey(input.pluginId, input.toolName);
    const existing = this.claims.get(key);
    if (existing && existing.status !== "revoked") {
      return existing;
    }
    const record: PluginToolOverrideClaimRecord = {
      pluginId: input.pluginId,
      toolName: input.toolName,
      override: input.override,
      status: "pending_owner_approval",
      claimedAt: input.claimedAt,
    };
    this.claims.set(key, record);
    return record;
  }

  public approveClaim(input: { pluginId: string; toolName: string; approvedBy: string }): PluginToolOverrideClaimRecord {
    if (input.approvedBy !== this.deps.getOwnerId()) {
      throw new ConflictError({
        code: "OWNER_SCOPE_REQUIRED",
        message: "Only the owner can approve plugin tool overrides.",
      });
    }
    const record = this.requireClaim(input.pluginId, input.toolName);
    record.status = "approved";
    record.approvedBy = input.approvedBy;
    record.approvedAt = new Date().toISOString();
    return record;
  }

  public revokeClaim(input: { pluginId: string; toolName: string; revokedBy: string }): PluginToolOverrideClaimRecord {
    if (input.revokedBy !== this.deps.getOwnerId()) {
      throw new ConflictError({
        code: "OWNER_SCOPE_REQUIRED",
        message: "Only the owner can revoke plugin tool overrides.",
      });
    }
    const record = this.requireClaim(input.pluginId, input.toolName);
    record.status = "revoked";
    record.revokedAt = new Date().toISOString();
    return record;
  }

  public listClaims(): PluginToolOverrideClaimRecord[] {
    return Array.from(this.claims.values()).map((record) => ({ ...record }));
  }

  public resolveActiveOverride(toolName: string): PluginToolOverrideClaimRecord | undefined {
    for (const record of this.claims.values()) {
      if (record.toolName === toolName && record.status === "approved" && record.override) {
        return { ...record };
      }
    }
    return undefined;
  }

  private requireClaim(pluginId: string, toolName: string): PluginToolOverrideClaimRecord {
    const record = this.claims.get(makeKey(pluginId, toolName));
    if (!record) {
      throw new ValidationError({
        message: `No override claim for plugin ${pluginId} on tool ${toolName}.`,
      });
    }
    return record;
  }
}

function makeKey(pluginId: string, toolName: string): string {
  return `${pluginId}::${toolName}`;
}
```

- [ ] **Step 8: Run — passes**

Run: `pnpm --filter @goatcitadel/gateway-app test -- plugin-tool-override-service`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/channels.ts packages/contracts/src/integrations.test.ts \
  apps/gateway/src/services/plugin-tool-override-service.ts \
  apps/gateway/src/services/plugin-tool-override-service.test.ts
git commit -m "feat(plugins): add tool_override flag with owner approval gate"
```

> NOTE: Current coordinator coverage proves handler-level override routing through `ToolInvocationCoordinatorService` when `PluginToolOverrideService.resolveActiveHandler()` returns an approved handler, including native fallback and hook behavior. This is not yet product-wide readiness for every plugin install path; e2e/live installed-plugin proof remains follow-up work.

---

## Task 7: `[[as_document]]` Skill Directive (O14)

Skills can embed `[[as_document]]` in output to force document delivery on supporting platforms (Slack file upload, Discord file attach) instead of inline text.

**Files:**
- Modify: `packages/contracts/src/skills.ts`
- Create: `apps/gateway/src/services/skill-output-directives.ts`
- Create: `apps/gateway/src/services/skill-output-directives.test.ts`

- [ ] **Step 1: Write failing contract test**

Add to `packages/contracts/src/module-load-smoke.test.ts`:

```ts
import type { SkillOutputDocumentDirective } from "./skills.js";

it("exposes SkillOutputDocumentDirective", () => {
  const directive: SkillOutputDocumentDirective = {
    kind: "document",
    fileName: "report.md",
    mimeType: "text/markdown",
    content: "# hello",
  };
  expect(directive.kind).toBe("document");
});
```

- [ ] **Step 2: Run — fails. Add type, run — passes**

In `packages/contracts/src/skills.ts`:

```ts
export interface SkillOutputDocumentDirective {
  kind: "document";
  fileName: string;
  mimeType: string;
  content: string;
}

export type SkillOutputDirective = SkillOutputDocumentDirective;

export interface SkillOutputParseResult {
  text: string;
  directives: SkillOutputDirective[];
}
```

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: PASS.

- [ ] **Step 3: Write failing parser test**

Create `apps/gateway/src/services/skill-output-directives.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSkillOutputDirectives } from "./skill-output-directives.js";

describe("parseSkillOutputDirectives", () => {
  it("returns text unchanged when no directive present", () => {
    const result = parseSkillOutputDirectives("Just a plain message.");
    expect(result.text).toBe("Just a plain message.");
    expect(result.directives).toEqual([]);
  });

  it("parses [[as_document fileName=report.md mimeType=text/markdown]]...[[/as_document]] blocks", () => {
    const input = `Here is your report:
[[as_document fileName=report.md mimeType=text/markdown]]
# Quarterly Report
Numbers and figures.
[[/as_document]]
End of message.`;
    const result = parseSkillOutputDirectives(input);
    expect(result.text).toMatch(/Here is your report:/);
    expect(result.text).toMatch(/End of message./);
    expect(result.text).not.toMatch(/as_document/);
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0]).toEqual({
      kind: "document",
      fileName: "report.md",
      mimeType: "text/markdown",
      content: "# Quarterly Report\nNumbers and figures.",
    });
  });

  it("supports multiple document blocks", () => {
    const input = `[[as_document fileName=a.txt mimeType=text/plain]]A[[/as_document]]
[[as_document fileName=b.txt mimeType=text/plain]]B[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives).toHaveLength(2);
    expect(result.directives[0]?.fileName).toBe("a.txt");
    expect(result.directives[1]?.fileName).toBe("b.txt");
  });

  it("falls back to default mimeType when omitted", () => {
    const input = `[[as_document fileName=note.txt]]hello[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives[0]?.mimeType).toBe("text/plain");
  });

  it("ignores malformed directives by leaving them as text", () => {
    const input = `[[as_document]]no filename[[/as_document]]`;
    const result = parseSkillOutputDirectives(input);
    expect(result.directives).toEqual([]);
    expect(result.text).toContain("[[as_document]]");
  });
});
```

- [ ] **Step 4: Run — fails (no parser)**

Run: `pnpm --filter @goatcitadel/gateway-app test -- skill-output-directives`
Expected: FAIL.

- [ ] **Step 5: Implement parser**

Create `apps/gateway/src/services/skill-output-directives.ts`:

```ts
import type { SkillOutputDirective, SkillOutputParseResult } from "@goatcitadel/contracts";

const DIRECTIVE_PATTERN =
  /\[\[as_document(?<attrs>[^\]]*?)\]\](?<content>[\s\S]*?)\[\[\/as_document\]\]/g;

export function parseSkillOutputDirectives(input: string): SkillOutputParseResult {
  const directives: SkillOutputDirective[] = [];
  const text = input.replace(DIRECTIVE_PATTERN, (_match, _attrs, _content, _offset, _full, groups) => {
    const attrs = groups?.attrs ?? "";
    const content = (groups?.content ?? "").trim();
    const parsed = parseAttributes(attrs);
    if (!parsed.fileName) {
      // Malformed — leave the original substring in place.
      return _match;
    }
    directives.push({
      kind: "document",
      fileName: parsed.fileName,
      mimeType: parsed.mimeType ?? "text/plain",
      content,
    });
    return ""; // strip from delivered text
  });
  return {
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    directives,
  };
}

interface ParsedAttributes {
  fileName?: string;
  mimeType?: string;
}

function parseAttributes(raw: string): ParsedAttributes {
  const result: ParsedAttributes = {};
  const pattern = /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[5];
    if (!key || value === undefined) continue;
    if (key === "fileName") result.fileName = value;
    else if (key === "mimeType") result.mimeType = value;
  }
  return result;
}
```

- [ ] **Step 6: Run — passes**

Run: `pnpm --filter @goatcitadel/gateway-app test -- skill-output-directives`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/skills.ts packages/contracts/src/module-load-smoke.test.ts \
  apps/gateway/src/services/skill-output-directives.ts \
  apps/gateway/src/services/skill-output-directives.test.ts
git commit -m "feat(skills): add [[as_document]] media-routing directive parser"
```

> NOTE: Wiring the parsed directives into `connector-delivery.ts` so each `SkillOutputDocumentDirective` becomes a `ChannelAttachmentInput` is a FOLLOW-UP task. This task ships the parser + contract — actual delivery integration is its own PR because it crosses channel-capability boundaries.

---

## Task 8: Page-Scoped Plugin Slots (O15)

Allow extensions to declare which Mission Control Next routes/slots they target.

**Files:**
- Modify: `packages/contracts/src/addons.ts`
- Create: `apps/gateway/src/services/addon-slot-service.ts`
- Create: `apps/gateway/src/services/addon-slot-service.test.ts`

- [ ] **Step 1: Write failing contract test**

Add `packages/contracts/src/addons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AddonCatalogEntry, AddonDashboardSlotDeclaration } from "./addons.js";

describe("AddonCatalogEntry dashboard slots", () => {
  it("supports dashboardSlots declarations targeting specific routes", () => {
    const slot: AddonDashboardSlotDeclaration = {
      slot: "ops.approvals.actions",
      route: "/ops/approvals",
    };
    const entry: AddonCatalogEntry = {
      addonId: "test",
      label: "Test",
      description: "Test addon",
      owner: "owner-1",
      repoUrl: "https://example.com/repo",
      sameOwnerAsGoatCitadel: false,
      trustTier: "trusted",
      category: "productivity",
      runtimeType: "separate_repo_app",
      installCommands: [],
      webEntryMode: "none",
      requiresSeparateRepoDownload: true,
      healthChecks: [],
      dashboardSlots: [slot],
    };
    expect(entry.dashboardSlots?.[0]?.slot).toBe("ops.approvals.actions");
  });
});
```

- [ ] **Step 2: Run — fails (type does not exist)**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: FAIL.

- [ ] **Step 3: Add slot types to addons.ts**

In `packages/contracts/src/addons.ts`, add after the existing types:

```ts
export type AddonDashboardSlot =
  | "ops.approvals.actions"
  | "ops.runtime.actions"
  | "ops.runtime.statusbar"
  | "library.skills.cards"
  | "library.memory.actions"
  | "projects.detail.toolbar"
  | "settings.account.sections";

export interface AddonDashboardSlotDeclaration {
  slot: AddonDashboardSlot;
  /** If set, this slot only renders on this route. If omitted, renders on every page that hosts the slot. */
  route?: string;
  /** Optional render priority for ordering within the slot. Higher is rendered first. */
  priority?: number;
}

export interface AddonCatalogEntry {
  ...
  dashboardSlots?: AddonDashboardSlotDeclaration[];
}
```

- [ ] **Step 4: Run — passes**

Run: `pnpm --filter @goatcitadel/contracts test`
Expected: PASS.

- [ ] **Step 5: Write failing service test**

Create `apps/gateway/src/services/addon-slot-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AddonSlotService } from "./addon-slot-service.js";

describe("AddonSlotService", () => {
  it("returns slots whose route matches", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("test-addon", [
      { slot: "ops.approvals.actions", route: "/ops/approvals" },
      { slot: "library.skills.cards", route: "/library/skills" },
    ]);
    const matched = service.findSlotsForRoute("/ops/approvals");
    expect(matched).toHaveLength(1);
    expect(matched[0]?.slot).toBe("ops.approvals.actions");
  });

  it("returns slots without a route on every match", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("test-addon", [{ slot: "ops.runtime.statusbar" }]);
    const matched = service.findSlotsForRoute("/anywhere");
    expect(matched).toHaveLength(1);
  });

  it("orders slots by priority (higher first)", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("low", [{ slot: "ops.approvals.actions", priority: 10 }]);
    service.registerDeclarations("high", [{ slot: "ops.approvals.actions", priority: 90 }]);
    const matched = service.findSlotsForRoute("/ops/approvals");
    expect(matched.map((m) => m.addonId)).toEqual(["high", "low"]);
  });

  it("unregister removes all declarations for an addon", () => {
    const service = new AddonSlotService();
    service.registerDeclarations("a", [{ slot: "ops.approvals.actions" }]);
    service.unregister("a");
    expect(service.findSlotsForRoute("/ops/approvals")).toEqual([]);
  });
});
```

- [ ] **Step 6: Run — fails**

Run: `pnpm --filter @goatcitadel/gateway-app test -- addon-slot-service`
Expected: FAIL.

- [ ] **Step 7: Implement service**

Create `apps/gateway/src/services/addon-slot-service.ts`:

```ts
import type { AddonDashboardSlot, AddonDashboardSlotDeclaration } from "@goatcitadel/contracts";

export interface AddonSlotRegistration extends AddonDashboardSlotDeclaration {
  addonId: string;
}

export class AddonSlotService {
  private readonly byAddon = new Map<string, AddonDashboardSlotDeclaration[]>();

  public registerDeclarations(addonId: string, declarations: AddonDashboardSlotDeclaration[]): void {
    this.byAddon.set(addonId, [...declarations]);
  }

  public unregister(addonId: string): void {
    this.byAddon.delete(addonId);
  }

  public findSlotsForRoute(route: string): AddonSlotRegistration[] {
    const matches: AddonSlotRegistration[] = [];
    for (const [addonId, declarations] of this.byAddon.entries()) {
      for (const declaration of declarations) {
        if (declaration.route && declaration.route !== route) continue;
        matches.push({ addonId, ...declaration });
      }
    }
    matches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return matches;
  }

  public listAllRegistrations(): AddonSlotRegistration[] {
    const items: AddonSlotRegistration[] = [];
    for (const [addonId, declarations] of this.byAddon.entries()) {
      for (const declaration of declarations) {
        items.push({ addonId, ...declaration });
      }
    }
    return items;
  }
}
```

- [ ] **Step 8: Run — passes**

Run: `pnpm --filter @goatcitadel/gateway-app test -- addon-slot-service`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/addons.ts packages/contracts/src/addons.test.ts \
  apps/gateway/src/services/addon-slot-service.ts \
  apps/gateway/src/services/addon-slot-service.test.ts
git commit -m "feat(addons): add page-scoped dashboard slot declarations"
```

> NOTE: Wiring the slot service into the addons-service install/uninstall lifecycle and exposing a Mission Control Next read endpoint is a FOLLOW-UP. This task ships the contract + registry only.

---

## Final Verification

- [ ] **Step 1: Full typecheck + test suite**

Run: `pnpm -w typecheck && pnpm -w test`
Expected: ALL PASS.

- [ ] **Step 2: Lint pass**

Run: `pnpm -w lint`
Expected: PASS or only pre-existing warnings.

- [ ] **Step 3: Push branch**

```bash
git push -u origin feature/plugin-sdk-hooks-expansion
```

- [ ] **Step 4: Update upstream review doc**

If updating an upstream-review summary, mark items O10-O15 as "covered where backed by committed contracts/services; plugin override has coordinator-level handler proof, installed-plugin e2e proof still pending." Do not treat untracked scratch notes as release evidence.

---

## Out of Scope (Explicit Follow-Ups)

The following work is intentionally NOT in this plan and should ship in subsequent PRs:

1. **Tool-override installed-plugin e2e proof**: coordinator tests cover approved handler routing via `PluginToolOverrideService.resolveActiveHandler()`, fallback, after-hooks, and error hooks. A follow-up should prove the installed-plugin registration path end-to-end before claiming product-wide override readiness.
2. **`[[as_document]]` delivery integration**: in `connector-delivery.ts`, convert each `SkillOutputDocumentDirective` into a `ChannelAttachmentInput` before invoking `channel.send`. Touches channel capability matrix.
3. **Mission Control Next slot rendering**: read `/api/v1/addons/slots?route=X` and render extension components into matching slots. New gateway route + MCN feature.
4. **Streaming `transform_llm_output`**: the synchronous path is wired in this plan; streaming requires assembling deltas before transform.
5. **End-to-end Playwright coverage**: e2e flows that exercise an installed plugin overriding `web_search` and a skill emitting `[[as_document]]` over Slack.

Each follow-up should reference this plan and the relevant `O##` item from the upstream gap review.
