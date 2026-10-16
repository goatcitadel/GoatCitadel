# Gap Closure WS4 — Providers and Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make three half-built provider/evaluation features real: an AWS Bedrock provider adapter (Converse/ConverseStream), blind model comparisons that actually execute, and a thinking stream that streams per provider delta instead of once per pass.

**Architecture:** Bedrock is a new `LlmProviderAdapter` registered beside `anthropicProviderAdapter` in `LlmService`; it signs requests itself (SigV4) or relies on the host's bearer header (Bedrock API key), and decodes the AWS event stream with the official codec. Model comparisons gain a `start`/`cancel` lifecycle in `ModelComparisonService` that drives `PromptPackService.runPromptPackTest` with bounded concurrency and persists per-result progress through two new repository methods. The thinking stream adds an internal opt-in request flag (`streamReasoningDeltas`) so `LlmService` keeps per-chunk reasoning text past its public-projection sanitizer only for the chat runner, which then yields one `thinking_delta` per provider chunk.

**Tech Stack:** TypeScript, Fastify gateway, vitest (gateway), `node:test` via `tsx --test` (storage), `@smithy/signature-v4`, `@aws-crypto/sha256-js`, `@smithy/eventstream-codec`.

**Spec:** `docs/superpowers/plans/2026-10-15-gap-closure-program.md`, section "WS4 — Providers and evaluation" (on `origin/fix/gap-ws1-quick-wins` until PR #375 merges).

## Global Constraints

- Work only in this worktree, branched from `origin/main`. Never edit the main checkout.
- Never `git stash`.
- vitest with `--maxWorkers=2`, low priority, one heavy job at a time.
- Gateway focused test: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`.
- Storage focused test: `pnpm --filter @goatcitadel/storage exec tsx --test <file>`.
- `prettier --write` only on files you changed.
- Never run `architecture:baseline:update`. A new service file needs an entry in `scripts/verification/baselines/architecture-new-service-allowances.json`.
- Gateway tests that mock `@goatcitadel/storage` must spread any new real exports.
- No personal paths in tracked files.
- Docs, UI copy and code must agree; remove text that claims a gap this PR closes.
- New dependencies: only `@smithy/signature-v4`, `@aws-crypto/sha256-js`, `@smithy/eventstream-codec` (gateway package).
- Commits: `<type>: <description>`.
- Proof lane: `pnpm typecheck`, focused tests, `pnpm verify:fast`, `git diff --check`.
- Use `git grep` for searches (the Grep tool silently omits matches on this tree).

## Deliberate deviations from the program plan

- **No `aws: { region; profile? }` config block.** The Bedrock region is parsed from the provider `baseUrl` host (`bedrock-runtime.<region>.amazonaws.com`, also VPC endpoint forms). The base URL must already name the region for requests to reach it, so a second region field could only disagree with it. `profile` would need `~/.aws` file parsing that nothing else in the gateway does; leaving it out avoids a config knob that does nothing. If the region cannot be parsed, dispatch fails with a clear error.
- **The end-of-pass `thinking_delta` emission stays as a fallback** that fires only when no per-chunk reasoning was streamed in that pass (non-streaming path, or providers that only return reasoning in the final message). Without it the non-streaming path would lose the feature.

## Review Focus

1. **SigV4 credentials leaking as a bearer header.** For `authMode: "aws-sigv4"` the resolved secret is a JSON credential blob; the host's default `Authorization: Bearer <apiKey>` must never be built for it. Pinned in Task 8 (`buildHeaders` test) and Task 9 (adapter overwrites/removes Authorization).
2. **Comparison started twice / restarted after gateway restart.** A second `start` while the run is active must be rejected (409), and a run left `running` by a dead process must be restartable and only re-run missing/errored results. Pinned in Task 6.
3. **Reasoning leaking to non-opted-in consumers.** OpenAI-compatible proxies and other `LlmService` callers must keep receiving sanitized chunks with no reasoning, and reasoning-only chunks must be dropped for them, not forwarded as empty frames. Pinned in Task 3.
4. **Truncated / split AWS event-stream frames.** Network chunks split frames anywhere (inside the prelude, mid-payload); the decoder must buffer and never throw on a partial frame, and must fail cleanly if the stream ends mid-frame. Pinned in Task 10.
5. **Partial comparison failure.** One candidate's provider failing must not discard other completed results; run ends `failed` with the successful results persisted. Pinned in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/gateway/src/services/chat-agent-completion-adapters.ts` | `absorbCompletionStreamChunk` returns `reasoningDelta` |
| `apps/gateway/src/services/llm-provider-anthropic.ts` | yield `delta.reasoning_content` per `thinking_delta` event |
| `packages/contracts/src/llm.ts` | `ChatCompletionRequest.streamReasoningDeltas`; `LlmProviderAuthMode` adds `aws-sigv4`, `aws-bedrock-api-key` |
| `apps/gateway/src/services/llm-service.ts` | opt-in reasoning preservation; register Bedrock; remove throws; sigv4 header guard |
| `apps/gateway/src/services/chat-turn-agent-runner.ts` | per-chunk `thinking_delta`; fallback end-of-pass |
| `apps/gateway/src/config.ts`, `apps/gateway/src/services/gateway/runtime-settings.ts` | drop "skeleton" wording |
| `packages/storage/src/model-comparison-run-repo.ts` | `updateStatus`, `upsertResult` |
| `apps/gateway/src/services/model-comparison-service.ts` | `startComparison`, `cancelComparison`, executor |
| `apps/gateway/src/services/gateway-route-composition-runtime.ts` | wire `runPromptPackTest` |
| `apps/gateway/src/routes/model-comparisons.ts` | `POST …/:comparisonId/run`, `POST …/:comparisonId/cancel` |
| `packages/mission-control-shared/src/api/model-comparisons.ts` | `runModelComparison`, `cancelModelComparison` |
| `apps/gateway/src/services/llm-provider-bedrock.ts` (new) | Bedrock Converse adapter (payload, auth, response) |
| `apps/gateway/src/services/llm-provider-bedrock-stream.ts` (new) | AWS event-stream framing/decoding helper |
| auth-mode enum sites (Task 8 list) | accept the two new auth modes |
| `packages/contracts/src/provider-templates.ts` | Bedrock template |
| `apps/mission-control-next/.../ProviderProfileFields.tsx` (cockpit + native) | Bedrock auth mode options |

---

### Task 1: `absorbCompletionStreamChunk` returns `reasoningDelta`

**Files:**
- Modify: `apps/gateway/src/services/chat-agent-completion-adapters.ts` (`absorbCompletionStreamChunk`, ~L368)
- Test: `apps/gateway/src/services/chat-agent-completion-adapters.loop26.test.ts` (append a `describe`)

**Interfaces:**
- Produces: `absorbCompletionStreamChunk(aggregate, rawChunk): { delta?: string; reasoningDelta?: string; sawToolCall: boolean }`. `reasoningDelta` is the concatenation of every choice's `delta.reasoning_content` (string) or, when that is absent, `delta.reasoning` (string). Non-string values (e.g. OpenRouter `reasoning_details` arrays) are ignored. Reasoning is never appended to `aggregate.content`.

- [ ] **Step 1: Write the failing test** (append to the loop26 test file)

```ts
describe("absorbCompletionStreamChunk reasoning deltas", () => {
  it("returns reasoning_content and reasoning deltas without touching visible content", () => {
    const aggregate = createCompletionStreamAggregate();
    const first = absorbCompletionStreamChunk(aggregate, {
      choices: [{ index: 0, delta: { reasoning_content: "Plan: " } }],
    });
    const second = absorbCompletionStreamChunk(aggregate, {
      choices: [{ index: 0, delta: { reasoning: "check units." } }],
    });
    const third = absorbCompletionStreamChunk(aggregate, {
      choices: [{ index: 0, delta: { content: "42", reasoning_content: "" } }],
    });
    expect(first).toEqual({ delta: undefined, reasoningDelta: "Plan: ", sawToolCall: false });
    expect(second.reasoningDelta).toBe("check units.");
    expect(third).toEqual({ delta: "42", reasoningDelta: undefined, sawToolCall: false });
    expect(aggregate.content).toBe("42");
  });

  it("prefers reasoning_content over reasoning and ignores non-string reasoning payloads", () => {
    const aggregate = createCompletionStreamAggregate();
    const both = absorbCompletionStreamChunk(aggregate, {
      choices: [{ index: 0, delta: { reasoning_content: "A", reasoning: "A-dup" } }],
    });
    const structured = absorbCompletionStreamChunk(aggregate, {
      choices: [{ index: 0, delta: { reasoning: { summary: "x" }, reasoning_details: [{ text: "y" }] } }],
    });
    expect(both.reasoningDelta).toBe("A");
    expect(structured.reasoningDelta).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-agent-completion-adapters.loop26.test.ts --maxWorkers=2`
Expected: FAIL — `reasoningDelta` missing from the returned object.

- [ ] **Step 3: Implement**

In `absorbCompletionStreamChunk`, add `let reasoningDelta = "";` next to `textDelta`. Inside the `for (const choice of choices)` loop, after the `if (!delta || typeof delta !== "object") continue;` guard, add:

```ts
    const reasoningText =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (reasoningText) {
      reasoningDelta += reasoningText;
    }
```

Change the return type to `{ delta?: string; reasoningDelta?: string; sawToolCall: boolean }` and return `{ delta: textDelta || undefined, reasoningDelta: reasoningDelta || undefined, sawToolCall }`.

- [ ] **Step 4: Run to verify it passes** (same command). Also run `src/services/llm-completion-helpers.test.ts` if it exists to confirm the other caller is unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-agent-completion-adapters.ts apps/gateway/src/services/chat-agent-completion-adapters.loop26.test.ts
git commit -m "feat: surface per-chunk reasoning deltas from the completion stream aggregate"
```

---

### Task 2: Anthropic adapter yields partial thinking per event

**Files:**
- Modify: `apps/gateway/src/services/llm-provider-anthropic.ts` (`content_block_delta` branch, ~L300-335)
- Test: `apps/gateway/src/services/llm-provider-anthropic.test.ts` (extend "preserves streamed thinking signatures…" area with a new `it`)

**Interfaces:**
- Produces: for each SSE `content_block_delta` with `delta.type === "thinking_delta"`, the stream yields `{ id, model, choices: [{ index: 0, delta: { reasoning_content: <partial text> } }] }` immediately. The existing buffering into `nativeContentBuffers` and the `provider_native_content` emission at `content_block_stop` stay unchanged (signature replay needs them). `redacted_thinking` blocks produce no reasoning chunk (they have no deltas). Reasoning chunks do **not** set `emittedVisibleChunk` (an output-cap retry before visible output must stay possible).

- [ ] **Step 1: Write the failing test**

Build an SSE body with `message_start`, `content_block_start` (index 0, `{type:"thinking", thinking:""}`), two `content_block_delta` `thinking_delta` events (`"Step one. "`, `"Step two."`), a `signature_delta`, `content_block_stop` 0, `content_block_start` index 1 `{type:"redacted_thinking", data:"cipher"}`, `content_block_stop` 1, a text block with `"Answer"`, `message_delta`, `message_stop`. Use the existing `fetch` spy + `host` pattern at the top of the file and a helper like the one used in the "normalizes streaming text…" test to build `text/event-stream` responses.

```ts
  it("streams partial thinking deltas before the block completes and never streams redacted thinking", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_t", model: "claude-test", usage: { input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step one. " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step two." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-t" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "cipher" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Answer" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of anthropicProviderAdapter.chatCompletionsStream(
      { messages: [{ role: "user", content: "think" }], max_tokens: 64 },
      resolved,
      "claude-test",
      host,
    )) {
      chunks.push(chunk);
    }
    const reasoning = chunks
      .map((chunk) => (chunk.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]?.delta?.reasoning_content)
      .filter((value): value is string => typeof value === "string");
    expect(reasoning).toEqual(["Step one. ", "Step two."]);
    const firstReasoningIndex = chunks.findIndex((chunk) => JSON.stringify(chunk).includes("Step one. "));
    const nativeIndex = chunks.findIndex((chunk) => JSON.stringify(chunk).includes("provider_native_content"));
    expect(firstReasoningIndex).toBeLessThan(nativeIndex);
    expect(JSON.stringify(chunks)).toContain('"signature":"sig-t"');
    expect(chunks.some((chunk) => JSON.stringify(chunk).includes('"reasoning_content":"cipher"'))).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/llm-provider-anthropic.test.ts --maxWorkers=2`
Expected: FAIL — `reasoning` is `[]`.

- [ ] **Step 3: Implement**

In the `content_block_delta` branch, before the `input_json_delta` handling, add:

```ts
            if (event.delta.type === "thinking_delta") {
              const thinkingText = String(event.delta.thinking ?? "");
              if (thinkingText) {
                yield withUsageEvent(
                  {
                    id: messageId ?? "message",
                    model: messageModel,
                    choices: [{ index: 0, delta: { reasoning_content: thinkingText } }],
                  },
                  accounting,
                  priorModelUsageEventIds,
                );
              }
            }
```

Leave the existing `nativeContentBuffers` thinking accumulation in place (it must keep running for the same event, so do not `continue` here).

- [ ] **Step 4: Run to verify it passes** (same command; the whole file must stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/llm-provider-anthropic.ts apps/gateway/src/services/llm-provider-anthropic.test.ts
git commit -m "feat: stream Anthropic thinking deltas as they arrive"
```

---

### Task 3: `LlmService` keeps reasoning deltas only for opted-in callers

**Files:**
- Modify: `packages/contracts/src/llm.ts` (`ChatCompletionRequest`)
- Modify: `apps/gateway/src/services/llm-service.ts` (`chatCompletionsStreamInternal` ~L1933-1995, helpers near `stripPrivateReasoningFromChunk` ~L4236)
- Test: `apps/gateway/src/services/llm-service.test.ts` (new `it`s near the llamacpp stream test ~L620)

**Interfaces:**
- Produces: `ChatCompletionRequest.streamReasoningDeltas?: boolean` — doc comment: `/** Internal: the chat runner opts in to receiving per-chunk display reasoning (delta.reasoning_content). Never sent to providers. */`.
- Behavior in `chatCompletionsStreamInternal`:
  - The flag is removed from the request before any adapter/payload builder sees it (`const { streamReasoningDeltas, ...requestWithoutFlag } = request;` and use `requestWithoutFlag` everywhere the old `request` was used).
  - For every raw chunk: `const reasoningByChoice = readChunkReasoningDeltas(chunk)` (map choice index → text from `delta.reasoning_content` string, else `delta.reasoning` string). Then sanitize as today.
  - Opted in: re-attach `delta.reasoning_content = text` on the sanitized chunk's matching choices.
  - Not opted in: if the raw chunk carried reasoning **and** the sanitized chunk has no meaningful payload (every choice's delta is empty, no `finish_reason`, no `usage`, no `message`), skip yielding it.
- Constraint: Do NOT add `reasoning_content` anywhere else; the sanitizer itself is unchanged.

- [ ] **Step 1: Write the failing tests**

Use an OpenAI-compatible provider (copy the llamacpp/openai config pattern from the nearby test) with a `globalThis.fetch` stub that returns this SSE body:

```
data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"Think A. "}}]}

data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"Think B."}}]}

data: {"id":"c1","choices":[{"index":0,"delta":{"content":"OK"}}]}

data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Test A — opted in:

```ts
    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of service.chatCompletionsStream({
      providerId: "openai-compat", // the provider id you configured
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      streamReasoningDeltas: true,
    })) chunks.push(chunk);
    const reasoning = chunks.flatMap((chunk) =>
      ((chunk.choices as Array<{ delta?: { reasoning_content?: string } }>) ?? [])
        .map((choice) => choice.delta?.reasoning_content)
        .filter((text): text is string => typeof text === "string"),
    );
    expect(reasoning).toEqual(["Think A. ", "Think B."]);
    expect(JSON.stringify(sentPayloads)).not.toContain("streamReasoningDeltas");
```

(`sentPayloads` = bodies captured by the fetch stub via `JSON.parse(String(init.body))`.)

Test B — not opted in: same stream, no flag. Expect `JSON.stringify(chunks)` not to contain `"Think A."` and not to contain `reasoning_content`, and expect no chunk whose choices all have an empty delta and no finish_reason (i.e. the two reasoning-only frames were dropped): `expect(chunks.filter((c) => JSON.stringify(c).includes('"delta":{}') && !JSON.stringify(c).includes("finish_reason"))).toHaveLength(0)`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/llm-service.test.ts -t "reasoning" --maxWorkers=2`
Expected: Test A fails (no reasoning), Test B fails (empty frames forwarded). Typecheck error on `streamReasoningDeltas` until the contract field is added — add the contract field first, then rebuild contracts: `pnpm --filter @goatcitadel/contracts build`.

- [ ] **Step 3: Implement**

Add near `stripPrivateReasoningFromChunk`:

```ts
function readChunkReasoningDeltas(chunk: Record<string, unknown>): Map<number, string> {
  const result = new Map<number, string>();
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  choices.forEach((choice, position) => {
    if (!isRecord(choice) || !isRecord(choice.delta)) return;
    const text =
      typeof choice.delta.reasoning_content === "string"
        ? choice.delta.reasoning_content
        : typeof choice.delta.reasoning === "string"
          ? choice.delta.reasoning
          : "";
    if (text) result.set(position, text);
  });
  return result;
}

function attachReasoningDeltas(
  chunk: Record<string, unknown>,
  reasoningByChoice: Map<number, string>,
): Record<string, unknown> {
  if (reasoningByChoice.size === 0 || !Array.isArray(chunk.choices)) return chunk;
  return {
    ...chunk,
    choices: chunk.choices.map((choice, position) => {
      const text = reasoningByChoice.get(position);
      if (!text || !isRecord(choice)) return choice;
      return { ...choice, delta: { ...(isRecord(choice.delta) ? choice.delta : {}), reasoning_content: text } };
    }),
  };
}

function isEmptyStreamFrame(chunk: Record<string, unknown>): boolean {
  if (chunk.usage !== undefined) return false;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  return choices.every(
    (choice) =>
      isRecord(choice) &&
      choice.message === undefined &&
      (choice.finish_reason === undefined || choice.finish_reason === null) &&
      (!isRecord(choice.delta) || Object.keys(choice.delta).length === 0),
  );
}
```

Replace the yield loop:

```ts
      for await (const chunk of stream) {
        const reasoningByChoice = readChunkReasoningDeltas(chunk);
        const publicChunk = stripPrivateReasoningFromChunk(chunk);
        if (!streamReasoningDeltas && reasoningByChoice.size > 0 && isEmptyStreamFrame(publicChunk)) {
          continue;
        }
        const projected = streamReasoningDeltas ? attachReasoningDeltas(publicChunk, reasoningByChoice) : publicChunk;
        yield attachReasoningReceiptToChunk(projected, reasoning.receipt);
      }
```

- [ ] **Step 4: Run to verify they pass**, then run the whole `llm-service.test.ts` file.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/llm.ts apps/gateway/src/services/llm-service.ts apps/gateway/src/services/llm-service.test.ts
git commit -m "feat: let the chat runner opt in to per-chunk reasoning deltas"
```

---

### Task 4: Runner yields `thinking_delta` per chunk

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-agent-runner.ts` (stream loop ~L4350-4390; end-of-pass emission ~L4530-4555; the `chatThinkingStreamV1Enabled` dep doc ~L1045)
- Modify: `apps/gateway/src/config.ts` (~L123-129) and `apps/gateway/src/services/gateway/runtime-settings.ts` (~L117): replace "Thinking-display skeleton" wording with "Thinking display" and describe per-chunk streaming.
- Test: `apps/gateway/src/services/chat-turn-agent-runner.thinking-stream.test.ts`; `apps/gateway/src/services/chat-stream-secret-projector.test.ts`; `packages/mission-control-shared/src/components/chat/chat-thread-reducer.test.ts`

**Interfaces:**
- Consumes: Task 1 `reasoningDelta`; Task 3 `streamReasoningDeltas`.
- Behavior:
  - Evaluate `const thinkingStreamEnabled = (await this.deps.chatThinkingStreamV1Enabled?.()) === true;` once per completion pass, before building the stream request.
  - When enabled, the stream request includes `streamReasoningDeltas: true`. When disabled, the flag is omitted (byte-identical request).
  - In the `for await (const rawChunk of providerStream)` loop: when enabled and `streamed.reasoningDelta` is non-empty, yield `{ type: "thinking_delta", sessionId, turnId, delta }` (apply `projectWorkspaceExplorerPathValue(delta, [readOnlyExplorerScopeRoot])` when `readOnlyExplorerScopeRoot` is set, exactly like the existing end-of-pass emission). Set a per-pass `streamedThinking = true`. Thinking chunks do not set `streamYieldedVisibleChunk`.
  - End-of-pass emission: keep it, but guard with `!streamedThinking` (declare `let streamedThinking = false;` at the start of each loop pass, in scope of both sites).

- [ ] **Step 1: Write the failing tests** (append to the thinking-stream test file)

```ts
function streamingDeps(chunks: Array<Record<string, unknown>>, seenRequests: Array<Record<string, unknown>>) {
  return {
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog([]),
    createChatCompletion: async () => {
      throw new Error("non-stream path not expected");
    },
    createChatCompletionStream: async (request: Record<string, unknown>) => {
      seenRequests.push(request);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
    invokeTool: async () => {
      throw new Error("not expected");
    },
  };
}

const reasoningStream = [
  { id: "s1", model: "m", choices: [{ index: 0, delta: { reasoning_content: "First, " } }] },
  { id: "s1", model: "m", choices: [{ index: 0, delta: { reasoning_content: "then second." } }] },
  { id: "s1", model: "m", choices: [{ index: 0, delta: { content: "Done." } }] },
  { id: "s1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

describe("ChatTurnAgentRunner incremental thinking stream", () => {
  it("yields one thinking_delta per provider reasoning chunk, in order, before message_done", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const orchestrator = new ChatTurnAgentRunner({
      ...streamingDeps(reasoningStream, seen),
      chatThinkingStreamV1Enabled: () => true,
    } as never);
    const input = baseTurn("sess-incremental", "Explain.");
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of orchestrator.runStream(input)) chunks.push(chunk as Record<string, unknown>);
    const thinking = chunks.filter((chunk) => chunk.type === "thinking_delta");
    expect(thinking.map((chunk) => chunk.delta)).toEqual(["First, ", "then second."]);
    const doneIndex = chunks.findIndex((chunk) => chunk.type === "message_done");
    expect(chunks.findIndex((chunk) => chunk.type === "thinking_delta")).toBeLessThan(doneIndex);
    expect(chunks.filter((chunk) => chunk.type === "thinking_delta")).toHaveLength(2); // no end-of-pass duplicate
    expect(String(chunks[doneIndex]?.content)).toBe("Done.");
    expect(seen[0]?.streamReasoningDeltas).toBe(true);
  });

  it("neither requests nor yields reasoning when the flag is off", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const orchestrator = new ChatTurnAgentRunner(streamingDeps(reasoningStream, seen) as never);
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of orchestrator.runStream(baseTurn("sess-incremental-off", "Explain."))) {
      chunks.push(chunk as Record<string, unknown>);
    }
    expect(chunks.some((chunk) => chunk.type === "thinking_delta")).toBe(false);
    expect("streamReasoningDeltas" in (seen[0] ?? {})).toBe(false);
  });
});
```

If `runStream` needs more deps for the streaming path (check the existing streaming tests in `chat-turn-agent-runner*.test.ts` with `git grep -n "createChatCompletionStream" -- apps/gateway/src/services/*.test.ts`), copy the minimal set from there.

Projector test (append to `chat-stream-secret-projector.test.ts`, following its existing construction pattern): feed two consecutive `thinking_delta` chunks where a known secret fixture already used in that file is split across them; assert the projected output never contains the raw secret and that the redaction marker appears. If an equivalent test already exists for `thinking_delta`, note it in the commit and skip writing a duplicate.

Reducer test (append to `chat-thread-reducer.test.ts`, following its existing `thinking_delta` tests): dispatch 40 `thinking_delta` events of 500 chars each for one turn; assert the stored thinking text length is `<= 16_000`. Skip if an equivalent cap test already exists (note in commit).

Redacted thinking: the Task 2 test already pins that redacted blocks never produce `reasoning_content`; additionally assert here that a stream chunk `{ choices: [{ index: 0, delta: { provider_native_content: [{ type: "redacted_thinking", data: "cipher" }] } }] }` followed by a finish chunk yields no `thinking_delta` containing `"cipher"` with the flag on.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-turn-agent-runner.thinking-stream.test.ts --maxWorkers=2`
Expected: first new test FAILS (no per-chunk thinking / missing flag).

- [ ] **Step 3: Implement** per the Behavior bullets. Update the large comment above the end-of-pass emission so it describes the fallback role instead of "skeleton … terminal-block variant".

- [ ] **Step 4: Run all three test files**; the four pre-existing thinking-stream tests must stay green (they use the non-stream path and exercise the fallback). Run the shared reducer test with `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/components/chat/chat-thread-reducer.test.ts --maxWorkers=2`.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-turn-agent-runner.ts apps/gateway/src/services/chat-turn-agent-runner.thinking-stream.test.ts apps/gateway/src/config.ts apps/gateway/src/services/gateway/runtime-settings.ts apps/gateway/src/services/chat-stream-secret-projector.test.ts packages/mission-control-shared/src/components/chat/chat-thread-reducer.test.ts
git commit -m "feat: stream thinking deltas per provider chunk"
```

---

### Task 5: Repository `updateStatus` and `upsertResult`

**Files:**
- Modify: `packages/storage/src/model-comparison-run-repo.ts`
- Test: `packages/storage/src/model-comparison-run-repo.test.ts`

**Interfaces:**
- Produces:
  - `updateStatus(comparisonId: string, update: { status: ModelComparisonStatus; updatedAt: string; completedAt?: string | null; error?: string | null }): Promise<ModelComparisonRun>` — `completedAt`/`error` are written as given (`undefined` → leave column unchanged; `null` → clear).
  - `upsertResult(comparisonId: string, result: ModelComparisonPromptResult, updatedAt: string): Promise<ModelComparisonRun>` — inside `runImmediateTransaction`, read `results_json`, replace the entry with the same `resultId` (or append), write back with `updated_at`. Throws `NotFoundError` for an unknown comparison.
- No schema change (columns already exist), so no migration.

- [ ] **Step 1: Write the failing tests**

```ts
  it("updates status and upserts results without losing other results", async () => {
    const repo = createRepo();
    await repo.create(sampleRun()); // reuse the run literal from the round-trip test via a local sampleRun() helper with two results r1, r2
    const running = await repo.updateStatus("cmp-1", { status: "running", updatedAt: "2026-10-15T00:00:01.000Z" });
    assert.equal(running.status, "running");
    await repo.upsertResult("cmp-1", { ...running.results[0]!, responseText: "first answer", runId: "run-1" }, "2026-10-15T00:00:02.000Z");
    const after = await repo.upsertResult(
      "cmp-1",
      { ...running.results[1]!, error: "provider down" },
      "2026-10-15T00:00:03.000Z",
    );
    assert.equal(after.results.length, 2);
    assert.equal(after.results[0]?.responseText, "first answer");
    assert.equal(after.results[1]?.error, "provider down");
    assert.equal(after.updatedAt, "2026-10-15T00:00:03.000Z");
    const done = await repo.updateStatus("cmp-1", {
      status: "failed",
      updatedAt: "2026-10-15T00:00:04.000Z",
      completedAt: "2026-10-15T00:00:04.000Z",
      error: "1 of 2 results failed",
    });
    assert.equal(done.completedAt, "2026-10-15T00:00:04.000Z");
    assert.equal(done.error, "1 of 2 results failed");
    const cleared = await repo.updateStatus("cmp-1", { status: "running", updatedAt: "2026-10-15T00:00:05.000Z", completedAt: null, error: null });
    assert.equal(cleared.completedAt, undefined);
    assert.equal(cleared.error, undefined);
  });

  it("rejects updates for unknown comparisons", async () => {
    const repo = createRepo();
    await assert.rejects(() => repo.updateStatus("missing", { status: "running", updatedAt: "2026-10-15T00:00:00.000Z" }));
    await assert.rejects(() =>
      repo.upsertResult("missing", { resultId: "x", testId: "t", candidateId: "c" }, "2026-10-15T00:00:00.000Z"),
    );
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @goatcitadel/storage exec tsx --test src/model-comparison-run-repo.test.ts`
Expected: FAIL — `updateStatus is not a function`.

- [ ] **Step 3: Implement**

```ts
  public async updateStatus(
    comparisonId: string,
    update: { status: ModelComparisonStatus; updatedAt: string; completedAt?: string | null; error?: string | null },
  ): Promise<ModelComparisonRun> {
    const current = await this.get(comparisonId);
    await this.db.prepare(UPDATE_RUN_STATUS_SQL).run({
      comparisonId,
      status: update.status,
      updatedAt: update.updatedAt,
      completedAt: update.completedAt === undefined ? (current.completedAt ?? null) : update.completedAt,
      error: update.error === undefined ? (current.error ?? null) : update.error,
    });
    return await this.get(comparisonId);
  }

  public async upsertResult(
    comparisonId: string,
    result: ModelComparisonPromptResult,
    updatedAt: string,
  ): Promise<ModelComparisonRun> {
    await this.ensureSchema();
    await this.db.runImmediateTransaction(async () => {
      const row = toRunRow(await this.db.prepare(GET_RUN_SQL).get(comparisonId));
      if (!row) throw new NotFoundError({ entity: "Model comparison", id: comparisonId });
      const results = safeJsonParse<ModelComparisonPromptResult[]>(row.results_json, []);
      const index = results.findIndex((item) => item.resultId === result.resultId);
      const next = index >= 0 ? results.map((item, i) => (i === index ? result : item)) : [...results, result];
      await this.db.prepare(UPDATE_RUN_RESULTS_SQL).run({ comparisonId, resultsJson: JSON.stringify(next), updatedAt });
    });
    return await this.get(comparisonId);
  }
```

```ts
const UPDATE_RUN_STATUS_SQL = `
  UPDATE model_comparison_runs
  SET status = @status, updated_at = @updatedAt, completed_at = @completedAt, error = @error
  WHERE comparison_id = @comparisonId
`;
const UPDATE_RUN_RESULTS_SQL = `
  UPDATE model_comparison_runs SET results_json = @resultsJson, updated_at = @updatedAt
  WHERE comparison_id = @comparisonId
`;
```

- [ ] **Step 4: Run to verify they pass**; then `pnpm --filter @goatcitadel/storage build` (gateway tests resolve storage from dist).

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/model-comparison-run-repo.ts packages/storage/src/model-comparison-run-repo.test.ts
git commit -m "feat: persist model comparison status and per-result progress"
```

---

### Task 6: `ModelComparisonService.startComparison` / `cancelComparison`

**Files:**
- Modify: `apps/gateway/src/services/model-comparison-service.ts`
- Modify: `apps/gateway/src/services/model-comparison-route-service.ts` (extend the port with the two new methods)
- Modify: `apps/gateway/src/services/gateway-route-composition-runtime.ts` (~L374)
- Test: `apps/gateway/src/services/model-comparison-service.test.ts` (extend the in-memory repository there with `updateStatus`/`upsertResult`)

**Interfaces:**
- Consumes: Task 5 repo methods.
- Produces:
  - `ModelComparisonRepositoryPort` gains `updateStatus` and `upsertResult` (same signatures as Task 5).
  - `ModelComparisonServiceDependencies.runPromptPackTest?: (packId: string, testId: string, input: { providerId: string; model: string; signal: AbortSignal }) => Promise<PromptPackRunRecord>`.
  - `startComparison(comparisonId: string): Promise<ModelComparisonRun>` — returns the run in `running` status immediately; execution continues in the background. Exposes `whenSettled(comparisonId): Promise<void>` (resolves when the background run ends; resolves immediately if none) for tests and shutdown.
  - `cancelComparison(comparisonId: string): Promise<ModelComparisonRun>`.
  - Error classes: throw `ConflictError` from `@goatcitadel/contracts` if it exists (check with `git grep -n "export class ConflictError" -- packages/contracts/src`), else `ValidationError` with `code: "INVALID_STATE"` if that code exists, else plain `ValidationError` — the route maps it to 409 by `instanceof`/message check consistently (see Task 7).
- Rules:
  - `runPromptPackTest` dep missing → `startComparison` throws `ValidationError` ("Live comparison execution is not available in this runtime.").
  - Active in this process (an AbortController is registered) → reject (409 semantics).
  - Status `completed` → reject ("Comparison already completed.").
  - Status `queued`, `failed`, `cancelled`, or `running` with no in-process controller (stale after a restart) → allowed.
  - Work items = results with no non-empty `responseText` (results that already have a response are kept, so a restart only re-runs missing or errored ones). Before running an item, clear its `error`.
  - Concurrency: 2 workers pulling from a shared queue.
  - Per item: call `runPromptPackTest(run.packId, testId, { providerId, model, signal })`; on success `upsertResult` with `runId`, `responseText` (trimmed; if empty and `run.error`, use error), `latencyMs` (finishedAt − startedAt via the existing `computeRunLatencyMs`), `error: run.status === "failed" ? (run.error ?? "Prompt-pack run failed.") : undefined`. On throw: if aborted, stop pulling; otherwise `upsertResult` with `error: <message>` and continue.
  - Final status: aborted → `cancelled` (with `completedAt`); any result with `error` → `failed`, `error: "<n> of <total> results failed."`; else `completed`. Always `completedAt` = now. Background failures inside the loop are caught; the run is marked `failed` with the error message (never an unhandled rejection).
  - `cancelComparison`: active → abort controller, then `await whenSettled`, return the stored run (status `cancelled`). Not active and status `running` (stale) → `updateStatus` to `cancelled`. Otherwise reject (409 semantics).
  - Blindness: results and run records never add provider/model fields; candidate identities stay only in `candidates` (unchanged contract).
  - Advisory `safetyNotes`: replace the two notes about not starting execution with: `"Start the comparison to run each prompt-pack test once per candidate through the governed prompt-pack runner."` and `"Comparing does not change routing by itself."` (keep the first note). Search for any other copy of the removed sentence with `git grep -n "does not start live provider execution"` and update it.
- Composition: in `gateway-route-composition-runtime.ts`, add `runPromptPackTest: (packId, testId, input) => gateway.promptPackService.runPromptPackTest(packId, testId, input)`.

- [ ] **Step 1: Write the failing tests**

Add to the in-memory repository in the test file:

```ts
  async updateStatus(comparisonId: string, update: { status: ModelComparisonRun["status"]; updatedAt: string; completedAt?: string | null; error?: string | null }) {
    const run = await this.get(comparisonId);
    const next: ModelComparisonRun = {
      ...run,
      status: update.status,
      updatedAt: update.updatedAt,
      completedAt: update.completedAt === undefined ? run.completedAt : (update.completedAt ?? undefined),
      error: update.error === undefined ? run.error : (update.error ?? undefined),
    };
    this.runs.set(comparisonId, next);
    return next;
  }
  async upsertResult(comparisonId: string, result: ModelComparisonPromptResult, updatedAt: string) {
    const run = await this.get(comparisonId);
    const exists = run.results.some((item) => item.resultId === result.resultId);
    const results = exists ? run.results.map((item) => (item.resultId === result.resultId ? result : item)) : [...run.results, result];
    const next = { ...run, results, updatedAt };
    this.runs.set(comparisonId, next);
    return next;
  }
```

(Adapt field names to the existing in-memory class — read it first.)

Tests:

```ts
describe("ModelComparisonService execution", () => {
  function promptRun(overrides: Partial<PromptPackRunRecord>): PromptPackRunRecord {
    return {
      runId: "run",
      packId: "pack-1",
      testId: "test-a",
      sessionId: "s",
      status: "completed",
      providerId: "p",
      model: "m",
      startedAt: "2026-10-15T00:00:00.000Z",
      finishedAt: "2026-10-15T00:00:01.500Z",
      responseText: "answer",
      ...overrides,
    } as PromptPackRunRecord;
  }

  async function setup(runPromptPackTest: NonNullable<ModelComparisonServiceDependencies["runPromptPackTest"]>) {
    const repository = new InMemoryModelComparisonRepository();
    const service = new ModelComparisonService({
      repository,
      clock: () => new Date("2026-10-15T00:00:00.000Z"),
      idFactory: idSequence("cmp-1"),
      listPromptPackTests: async () => [testRecord("test-a"), testRecord("test-b")],
      runPromptPackTest,
    });
    const created = await service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "openai", model: "gpt-5" },
        { providerId: "anthropic", model: "claude" },
      ],
    });
    return { service, repository, created };
  }

  it("moves queued → running → completed and stores every response with at most 2 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { service, created } = await setup(async (_packId, testId, input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return promptRun({ testId, runId: `${testId}-${input.model}`, responseText: `${input.model} says hi` });
    });
    const started = await service.startComparison(created.comparisonId);
    expect(started.status).toBe("running");
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeDefined();
    expect(done.results.every((result) => Boolean(result.responseText))).toBe(true);
    expect(done.results[0]?.latencyMs).toBe(1500);
    expect(maxInFlight).toBe(2);
    expect(JSON.stringify(done.results)).not.toContain("anthropic");
    expect(done.advisory?.safetyNotes.join(" ")).not.toContain("does not start live provider execution");
  });

  it("ends failed but keeps completed results when one candidate fails", async () => {
    const { service, created } = await setup(async (_packId, testId, input) => {
      if (input.model === "claude") throw new Error("provider down");
      return promptRun({ testId, responseText: "ok" });
    });
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const done = await service.getComparison(created.comparisonId);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("2 of 4 results failed.");
    expect(done.results.filter((result) => result.responseText === "ok")).toHaveLength(2);
    expect(done.results.filter((result) => result.error === "provider down")).toHaveLength(2);
  });

  it("restarting a failed comparison only re-runs missing or errored results", async () => {
    const calls: string[] = [];
    let fail = true;
    const { service, created } = await setup(async (_packId, testId, input) => {
      calls.push(`${testId}:${input.model}`);
      if (fail && input.model === "claude") throw new Error("provider down");
      return promptRun({ testId, responseText: "ok" });
    });
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    fail = false;
    calls.length = 0;
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    expect(calls.sort()).toEqual(["test-a:claude", "test-b:claude"]);
    expect((await service.getComparison(created.comparisonId)).status).toBe("completed");
  });

  it("rejects a second start while running and a start after completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, created } = await setup(async (_packId, testId) => {
      await gate;
      return promptRun({ testId });
    });
    await service.startComparison(created.comparisonId);
    await expect(service.startComparison(created.comparisonId)).rejects.toThrow();
    release();
    await service.whenSettled(created.comparisonId);
    await expect(service.startComparison(created.comparisonId)).rejects.toThrow(/already completed/i);
  });

  it("cancel aborts the in-flight signal and ends cancelled", async () => {
    const signals: AbortSignal[] = [];
    const { service, created } = await setup(
      (_packId, _testId, input) =>
        new Promise((_resolve, reject) => {
          signals.push(input.signal);
          input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await service.startComparison(created.comparisonId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = await service.cancelComparison(created.comparisonId);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancelled.status).toBe("cancelled");
  });

  it("a stale running comparison (no live executor) can be cancelled or restarted", async () => {
    const { service, repository, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await repository.updateStatus(created.comparisonId, { status: "running", updatedAt: "2026-10-15T00:00:00.000Z" });
    const restarted = await service.startComparison(created.comparisonId);
    expect(restarted.status).toBe("running");
    await service.whenSettled(created.comparisonId);
    expect((await service.getComparison(created.comparisonId)).status).toBe("completed");
  });

  it("refuses to start without a live runner", async () => {
    const service = new ModelComparisonService({
      repository: new InMemoryModelComparisonRepository(),
      idFactory: idSequence("cmp-1"),
      listPromptPackTests: async () => [testRecord("test-a")],
    });
    const created = await service.createComparison({
      packId: "pack-1",
      allTests: true,
      candidates: [
        { providerId: "a", model: "a" },
        { providerId: "b", model: "b" },
      ],
    });
    await expect(service.startComparison(created.comparisonId)).rejects.toThrow(/not available/i);
  });

  it("judging is unchanged after a run", async () => {
    const { service, created } = await setup(async (_packId, testId) => promptRun({ testId }));
    await service.startComparison(created.comparisonId);
    await service.whenSettled(created.comparisonId);
    const judgment = await service.addJudgment(created.comparisonId, {
      testId: "test-a",
      winnerCandidateId: created.candidates[0]!.candidateId,
      scores: [{ candidateId: created.candidates[0]!.candidateId, quality: 4 }],
    });
    expect(judgment.testId).toBe("test-a");
  });
});
```

Note `idSequence` in the existing file — make sure a sequence of ids works for comparisons and judgments (check its implementation; adapt if it returns one id only).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/model-comparison-service.test.ts --maxWorkers=2`
Expected: FAIL — `startComparison is not a function`.

- [ ] **Step 3: Implement** per the Rules. Skeleton:

```ts
  private readonly active = new Map<string, { controller: AbortController; settled: Promise<void> }>();

  public async startComparison(comparisonId: string): Promise<ModelComparisonRun> {
    const runPromptPackTest = this.deps.runPromptPackTest;
    if (!runPromptPackTest) {
      throw new ValidationError({ field: "comparisonId", message: "Live comparison execution is not available in this runtime." });
    }
    if (this.active.has(comparisonId)) throw /* 409 error per Interfaces */;
    const run = await this.deps.repository.get(comparisonId);
    if (run.status === "completed") throw /* 409 error */ ("Comparison already completed.");
    const controller = new AbortController();
    const running = await this.deps.repository.updateStatus(comparisonId, {
      status: "running", updatedAt: this.nowIso(), completedAt: null, error: null,
    });
    const settled = this.execute(running, runPromptPackTest, controller.signal)
      .catch(async (error: unknown) => {
        await this.deps.repository.updateStatus(comparisonId, {
          status: "failed", updatedAt: this.nowIso(), completedAt: this.nowIso(),
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      })
      .finally(() => this.active.delete(comparisonId));
    this.active.set(comparisonId, { controller, settled });
    return this.withAdvisory(running);
  }

  public async whenSettled(comparisonId: string): Promise<void> {
    await this.active.get(comparisonId)?.settled;
  }
```

`execute` builds the work list, runs two workers (`await Promise.all([worker(), worker()])` where each `worker` pops from a shared array until empty or aborted), then sets the final status as specified. Keep each function under 50 lines; extract `runOne(item)` and `resolveFinalStatus(run, aborted)` helpers.

Wire composition (`runPromptPackTest`) and extend `ModelComparisonRoutePort` + `ModelComparisonRouteService` with `startModelComparison`/`cancelModelComparison` passthroughs.

- [ ] **Step 4: Run to verify they pass**; also re-run the pre-existing tests in the same file.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/model-comparison-service.ts apps/gateway/src/services/model-comparison-service.test.ts apps/gateway/src/services/model-comparison-route-service.ts apps/gateway/src/services/gateway-route-composition-runtime.ts
git commit -m "feat: run blind model comparisons through the prompt-pack runner"
```

---

### Task 7: Run/cancel routes, shared client, Library button

**Files:**
- Modify: `apps/gateway/src/routes/model-comparisons.ts`
- Test: `apps/gateway/src/routes/model-comparisons.test.ts`
- Modify: `packages/mission-control-shared/src/api/model-comparisons.ts`
- Modify: `apps/mission-control-next/src/features/native-routes/library/LibraryPromptPacksSection.tsx` (only if it already lists comparisons with per-row actions; see Step 6)

**Interfaces:**
- Consumes: Task 6 `startComparison`, `cancelComparison`.
- Produces:
  - `POST /api/v1/model-comparisons/:comparisonId/run` → `202` with the run (status `running`). Errors: unknown id → `404`; state conflict (already running / already completed / not running for cancel) → `409`; runner unavailable / validation → `400`.
  - `POST /api/v1/model-comparisons/:comparisonId/cancel` → `200` with the run.
  - Shared client: `runModelComparison(comparisonId: string): Promise<ModelComparisonRun>` and `cancelModelComparison(comparisonId: string): Promise<ModelComparisonRun>`, both `POST` with an empty JSON body `{}` (a body-less POST hits `FST_ERR_CTP_EMPTY_JSON_BODY`).
- Error mapping helper in the route file: `NotFoundError` (from `@goatcitadel/contracts`) → 404; the Task 6 conflict error → 409; everything else → 400.

- [ ] **Step 1: Write the failing route test**

```ts
  it("starts and cancels comparisons with conflict and not-found mapping", async () => {
    const run = { comparisonId: "cmp-1", status: "running" } as Record<string, unknown>;
    app = Fastify();
    app.decorate("services", {
      modelComparisons: {
        startComparison: async (id: string) => {
          if (id === "missing") throw new NotFoundError({ entity: "Model comparison", id });
          if (id === "busy") throw /* the Task 6 conflict error instance */;
          return run;
        },
        cancelComparison: async () => ({ ...run, status: "cancelled" }),
      },
    } as never);
    await app.register(modelComparisonRoutes);
    const started = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/cmp-1/run", payload: {} });
    const missing = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/missing/run", payload: {} });
    const busy = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/busy/run", payload: {} });
    const cancelled = await app.inject({ method: "POST", url: "/api/v1/model-comparisons/cmp-1/cancel", payload: {} });
    expect(started.statusCode).toBe(202);
    expect(started.json().status).toBe("running");
    expect(missing.statusCode).toBe(404);
    expect(busy.statusCode).toBe(409);
    expect(cancelled.json().status).toBe("cancelled");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/routes/model-comparisons.test.ts --maxWorkers=2`
Expected: FAIL — 404 for unregistered route.

- [ ] **Step 3: Implement both routes** using `paramsSchema` and the error helper.

- [ ] **Step 4: Run to verify it passes.** Then check the route inventory/sweep tests that enumerate routes: `git grep -n "model-comparisons" -- apps/gateway/src/*.test.ts apps/gateway/src/**/*.test.ts scripts` and update any route manifest/allowlist that lists every POST route (e.g. route-auth or CSRF inventories) so they include the two new routes.

- [ ] **Step 5: Add the shared client functions**, mirroring `judgeModelComparison` in the same file:

```ts
export function runModelComparison(comparisonId: string) {
  return request<ModelComparisonRun>(`/api/v1/model-comparisons/${encodeURIComponent(comparisonId)}/run`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function cancelModelComparison(comparisonId: string) {
  return request<ModelComparisonRun>(`/api/v1/model-comparisons/${encodeURIComponent(comparisonId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
```

(Match the exact `request` option shape used by `judgeModelComparison`, e.g. headers.)

- [ ] **Step 6: Library button (conditional).** Read `LibraryPromptPacksSection.tsx`. If it renders a list of comparisons with per-comparison controls, add a "Run comparison" button for `queued`/`failed`/`cancelled` runs and a "Cancel" button for `running` runs, calling the new client functions and refreshing the list; follow the file's existing async-action/error-display pattern and add/extend its test. If the section has no per-comparison controls, do not build new UI here — record "UI entry point deferred: Library has no comparison row controls" in the PR description instead.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/routes/model-comparisons.ts apps/gateway/src/routes/model-comparisons.test.ts packages/mission-control-shared/src/api/model-comparisons.ts
# plus the Library files if Step 6 changed them
git commit -m "feat: add run and cancel endpoints for blind model comparisons"
```

---

### Task 8: Bedrock auth modes in contracts, routes, and host headers

**Files:**
- Modify: `packages/contracts/src/llm.ts` (`LlmProviderAuthMode`)
- Modify every auth-mode enum site found by `git grep -n '"google-service-account", "google-adc"' -- apps packages`:
  - `packages/contracts/src/config-schemas.ts` (~L285)
  - `packages/contracts/src/change-plan.ts` (~L932)
  - `apps/gateway/src/routes/change-plans.ts` (~L28), `dashboard.ts` (~L194), `llm.ts` (~L125), `onboarding.ts` (~L120)
  - `packages/policy-engine/src/tool-registry.ts` (~L221)
- Modify: `apps/gateway/src/services/llm-service.ts` — `buildHeaders` (~L2870) and `resolveProvider` (~L2719)
- Test: `packages/contracts/src/config-schemas.test.ts`; `apps/gateway/src/services/llm-service.test.ts`

**Interfaces:**
- Produces:
  - `LlmProviderAuthMode` adds `"aws-sigv4" | "aws-bedrock-api-key"`.
  - `aws-bedrock-api-key`: the stored provider API key (keychain / `apiKeyEnv` / inline, via the existing `resolveApiKey`) is a Bedrock API key; the host's existing default `Authorization: Bearer <key>` is exactly what Bedrock expects — no change.
  - `aws-sigv4`: `resolveProvider` resolves the credential through `resolveApiKey` as a JSON string `{"accessKeyId":"…","secretAccessKey":"…","sessionToken":"…"}` (sessionToken optional). If `resolveApiKey` returns nothing, fall back to `this.env.AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` and serialize the same JSON. `ResolvedProvider.apiKey` carries that JSON; the adapter (Task 9) parses it. Inline (`provider.apiKey`) SigV4 secrets are rejected, mirroring the Vertex service-account rule: `"AWS SigV4 credentials must be stored in the Gateway keychain or provided through AWS_* environment variables."`
  - `buildHeaders`: when `resolveProviderAuthMode(resolved.provider) === "aws-sigv4"`, never set `Authorization` from `resolved.apiKey` (skip the bearer branch and the `applyRequestAuthHeaders` secret injection — pass `undefined` as its apiKey argument).

- [ ] **Step 1: Write the failing tests**

Contracts (`config-schemas.test.ts`, next to the existing bedrock apiStyle test):

```ts
  it.each(["aws-sigv4", "aws-bedrock-api-key"])("accepts authMode %s on the zod runtime enum", (authMode) => {
    const result = LlmConfigFileSchema.safeParse({ // use the same schema symbol the neighbouring test uses
      activeProviderId: "bedrock",
      providers: [
        {
          providerId: "bedrock",
          label: "Bedrock",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          apiStyle: "bedrock-messages",
          authMode,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
```

Gateway (`llm-service.test.ts`): configure a `bedrock-messages` provider with `authMode: "aws-sigv4"` and env `{ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }` (AWS's published documentation example credentials — check `docs/security/findings-triage.md` and `secret_scanning.yml` for the synthetic-fixture convention before committing; if scanning flags them, use obviously fake values like `"AKIATESTTESTTESTTEST"` / `"test-secret"`). Stub `fetch` to capture the request and return a Converse JSON response (`{ output: { message: { role: "assistant", content: [{ text: "hi" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }`). This test can only pass after Task 9+11, so in **this** task write only the header-guard test below and leave the end-to-end test for Task 11:

```ts
  it("never builds a bearer header from SigV4 credential JSON", async () => {
    // Build service with the sigv4 bedrock provider, then call the private header builder.
    const headers = (service as unknown as {
      buildHeaders(resolved: { provider: LlmProviderConfig; apiKey?: string }, purpose: string): Record<string, string>;
    }).buildHeaders(
      { provider: bedrockSigV4Provider, apiKey: '{"accessKeyId":"A","secretAccessKey":"S"}' },
      "chat",
    );
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("secretAccessKey");
  });
```

- [ ] **Step 2: Run to verify they fail** (contracts: `pnpm --filter @goatcitadel/contracts exec vitest run src/config-schemas.test.ts --maxWorkers=2`; gateway: llm-service test with `-t "SigV4"`).

- [ ] **Step 3: Implement** the enum additions at every site, the `buildHeaders` guard, and the `resolveProvider` SigV4 resolution described above. Rebuild contracts (`pnpm --filter @goatcitadel/contracts build`).

- [ ] **Step 4: Run to verify they pass**; run `pnpm --filter @goatcitadel/policy-engine exec vitest run --maxWorkers=2` if that package has tests touching the tool-registry schema.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/llm.ts packages/contracts/src/config-schemas.ts packages/contracts/src/config-schemas.test.ts packages/contracts/src/change-plan.ts apps/gateway/src/routes/change-plans.ts apps/gateway/src/routes/dashboard.ts apps/gateway/src/routes/llm.ts apps/gateway/src/routes/onboarding.ts packages/policy-engine/src/tool-registry.ts apps/gateway/src/services/llm-service.ts apps/gateway/src/services/llm-service.test.ts
git commit -m "feat: add AWS SigV4 and Bedrock API-key provider auth modes"
```

---

### Task 9: Bedrock adapter — Converse (non-streaming)

**Files:**
- Add dependencies: `pnpm --filter @goatcitadel/gateway add @smithy/signature-v4 @aws-crypto/sha256-js @smithy/eventstream-codec` (online; pin exact versions the way the gateway `package.json` pins its other deps; commit `pnpm-lock.yaml`). Verify each package's latest version is ≥ 14 days old (`npm view <pkg> time --json`); if the newest is younger, pin the previous release.
- Create: `apps/gateway/src/services/llm-provider-bedrock.ts`
- Test: `apps/gateway/src/services/llm-provider-bedrock.test.ts`
- Modify: `scripts/verification/baselines/architecture-new-service-allowances.json` (add `llm-provider-bedrock.ts` and `llm-provider-bedrock-stream.ts`, following the existing entry format; read the file first)

**Interfaces:**
- Produces (exports from `llm-provider-bedrock.ts`):
  - `bedrockProviderAdapter: LlmProviderAdapter` with `apiStyle: "bedrock-messages"`.
  - `buildBedrockConversePayload(request: ChatCompletionRequest): Record<string, unknown>`.
  - `parseBedrockRegion(baseUrl: string): string` — throws `Error("Cannot determine the AWS region from the Bedrock base URL …")` when no region.
  - `adaptBedrockConverseResponse(json: Record<string, unknown>, model: string): ChatCompletionResponse`.
  - `signBedrockRequest(input: { url: string; body: string; headers: Record<string, string>; region: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }): Promise<Record<string, string>>` — returns the headers to send.
- Endpoints: `${baseUrl}/model/${encodeURIComponent(model)}/converse` and `/converse-stream`. Purpose passed to `buildRequestTarget` is `"chat"`.
- Payload mapping (`buildBedrockConversePayload`):
  - `system` / `developer` messages → `system: [{ text }]` (concatenate structured parts with `extractStructuredTextContent`-style text extraction; write a local `messageText(content)` helper).
  - `user` text → `{ role: "user", content: [{ text }] }`; image parts with `data:` URLs → `{ image: { format: "png"|"jpeg"|"gif"|"webp", source: { bytes: <base64 string> } } }`; non-data image URLs are rejected with an error (Converse needs bytes).
  - `assistant` → text block (if non-empty) + one `{ toolUse: { toolUseId: id, name, input: <parsed JSON object, {} on parse failure> } }` per `tool_calls` entry.
  - `tool` messages → `{ role: "user", content: [{ toolResult: { toolUseId: tool_call_id, content: [{ text }] } }] }`; consecutive tool results merge into one user message; a user message right after tool results merges into the same user turn (Converse requires alternation).
  - `max_tokens` → `inferenceConfig.maxTokens`; `temperature` → `inferenceConfig.temperature`; `top_p` → `inferenceConfig.topP`; `stop` → `inferenceConfig.stopSequences` (array). Omit `inferenceConfig` when empty.
  - `tools` (OpenAI `{type:"function", function:{name, description, parameters}}`) → `toolConfig.tools: [{ toolSpec: { name, description, inputSchema: { json: parameters ?? { type: "object", properties: {} } } } }]`; `tool_choice` `"auto"` → `{ auto: {} }`, `"required"` → `{ any: {} }`, `{type:"function", function:{name}}` → `{ tool: { name } }`, `"none"` → omit `toolConfig` entirely.
  - No reasoning/thinking request fields are sent (out of scope; Bedrock reasoning output is still read in responses).
- Response mapping (`adaptBedrockConverseResponse`): text blocks concatenated into `message.content`; `toolUse` blocks → `tool_calls` (`{ id: toolUseId, type: "function", function: { name, arguments: JSON.stringify(input ?? {}) } }`); `reasoningContent.reasoningText.text` → `provider_native_content: [{ type: "reasoning", text }]` (never into `content`); `stopReason` mapping `end_turn|stop_sequence → "stop"`, `tool_use → "tool_calls"`, `max_tokens → "length"`, `guardrail_intervened|content_filtered → "content_filter"`; `usage` → `{ prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens }`; `model` = the requested model id.
- Auth (`chatCompletions` and `chatCompletionsStream`):
  - Build target via `host.buildRequestTarget(resolved, "chat", url)`.
  - `authMode === "aws-sigv4"`: parse `resolved.apiKey` JSON (throw `"AWS SigV4 credentials are missing or malformed."` if not parseable or missing keys); `const body = JSON.stringify(payload)`; `headers = await signBedrockRequest({ url: target.url, body, headers: { ...target.headers without any Authorization }, region: parseBedrockRegion(baseUrl), credentials })`. The host serializes `payload` with the same `JSON.stringify`, so the signed body matches byte-for-byte; do not pass `outputCapRecovery` (a retried payload would invalidate the signature).
  - Otherwise (`aws-bedrock-api-key`, default `api-key`): use `target.headers` as is (bearer). Throw `"Amazon Bedrock requires an API key or SigV4 credentials."` when `resolved.apiKey` is missing.
  - `signBedrockRequest` uses `new SignatureV4({ service: "bedrock", region, credentials, sha256: Sha256 })` and `signer.sign({ method: "POST", protocol: "https:", hostname, path: url.pathname, query: <from url.searchParams>, headers: { ...headers, host: hostname }, body })`; return `signed.headers` minus `host` (fetch sets it).
- Errors: redirect → `"Bedrock converse request blocked redirect (<status>)"`; non-2xx → `"Bedrock converse request failed (<status> <x-amzn-errortype or ''>): <message from JSON body or bounded text>"` read with `readBoundedResponseText` (64 KiB, 5 s), mirroring `buildHttpError` in the Anthropic adapter.
- Usage accounting: copy the Anthropic non-stream pattern (`applyEstimatedCostToChatResponseWithSource`, `observeProviderUsageWithTrustedEstimate`, `usage.observeNormalized`, `succeed`/`fail`, `modelUsageEventIds`).

- [ ] **Step 1: Install dependencies** (see Files). Confirm `pnpm --filter @goatcitadel/gateway exec node -e "require.resolve('@smithy/signature-v4')"` succeeds.

- [ ] **Step 2: Write the failing tests** (`llm-provider-bedrock.test.ts`, host and fetch-spy pattern copied from `llm-provider-anthropic.test.ts`; resolved provider `{ providerId: "bedrock", baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com", apiStyle: "bedrock-messages", authMode: "aws-sigv4" }`, `apiKey: JSON.stringify({ accessKeyId: "AKIATESTTESTTESTTEST", secretAccessKey: "test-secret", sessionToken: "test-session" })`)

  1. **Request body mapping**: call `buildBedrockConversePayload` with system + developer + user(text+data-URL png image) + assistant(text + tool_call) + tool result + user follow-up, `max_tokens: 256`, `temperature: 0.2`, `stop: ["END"]`, one tool, `tool_choice: "required"`. Assert exact `system`, alternating roles `["user","assistant","user"]`, the merged final user turn containing both `toolResult` and the follow-up text, `inferenceConfig` `{ maxTokens: 256, temperature: 0.2, stopSequences: ["END"] }`, `toolConfig.toolChoice` `{ any: {} }`, image block `{ format: "png", source: { bytes: "<base64>" } }`.
  2. **SigV4 headers present**: spy `fetch`, call `chatCompletions`; assert URL `https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-test%3A0/converse` (model `anthropic.claude-test:0`), `authorization` starts with `AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST/` and contains `/us-west-2/bedrock/aws4_request`, `x-amz-date` present, `x-amz-security-token` = `test-session`, and no header value contains `test-secret`.
  3. **Bearer mode**: `authMode: "aws-bedrock-api-key"`, `apiKey: "bedrock-key"`, host headers `{ Authorization: "Bearer bedrock-key" }` → request carries that header and no `x-amz-date`.
  4. **Response mapping + tool use**: Converse JSON with `reasoningContent`, text, and a `toolUse` block, `stopReason: "tool_use"`, usage → assert `content`, `tool_calls[0]` (`arguments` = `'{"q":"goat"}'`), `finish_reason: "tool_calls"`, `usage.total_tokens`, reasoning only in `provider_native_content`.
  5. **Tool-use round trip**: feed the adapted response's assistant message plus a `tool` message back into `buildBedrockConversePayload` and assert the `toolUse.toolUseId` equals the `toolResult.toolUseId`.
  6. **Error mapping**: 400 with header `x-amzn-errortype: ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/` and body `{"message":"Malformed input request"}` → rejects with a message containing `400`, `ValidationException` and `Malformed input request`; 307 → rejects with `blocked redirect`.
  7. **Region parsing**: `parseBedrockRegion("https://bedrock-runtime.eu-central-1.amazonaws.com")` → `"eu-central-1"`; `"https://vpce-0abc-xyz.bedrock-runtime.us-east-1.vpce.amazonaws.com"` → `"us-east-1"`; `"https://example.com"` throws.
  8. **Malformed SigV4 credentials**: `apiKey: "not-json"` → rejects with `malformed`, and `fetch` is never called.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @goatcitadel/gateway exec vitest run src/services/llm-provider-bedrock.test.ts --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** `llm-provider-bedrock.ts` (non-stream path; `chatCompletionsStream` may temporarily `throw new Error("not implemented")` — Task 10 replaces it in the same PR). Region regex: `/bedrock-runtime(?:-fips)?\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\./`. Keep the file under 800 lines; put the event-stream code in Task 10's separate file.

- [ ] **Step 5: Run to verify they pass.**

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/package.json pnpm-lock.yaml apps/gateway/src/services/llm-provider-bedrock.ts apps/gateway/src/services/llm-provider-bedrock.test.ts scripts/verification/baselines/architecture-new-service-allowances.json
git commit -m "feat: add Amazon Bedrock Converse provider adapter"
```

---

### Task 10: Bedrock adapter — ConverseStream event-stream decoding

**Files:**
- Create: `apps/gateway/src/services/llm-provider-bedrock-stream.ts`
- Modify: `apps/gateway/src/services/llm-provider-bedrock.ts` (`chatCompletionsStream`)
- Test: `apps/gateway/src/services/llm-provider-bedrock.test.ts`

**Interfaces:**
- Produces (`llm-provider-bedrock-stream.ts`):
  - `export interface BedrockStreamEvent { eventType: string; messageType: "event" | "exception" | "error"; exceptionType?: string; payload: Record<string, unknown> }`
  - `export async function* decodeBedrockEventStream(body: ReadableStream<Uint8Array>, limits?: { maxBytes?: number; maxEvents?: number }): AsyncGenerator<BedrockStreamEvent>` — buffers bytes, reads the 4-byte big-endian total length, slices complete frames, decodes each with `new EventStreamCodec(utf8Encode, utf8Decode).decode(frame)` (`utf8Encode`/`utf8Decode` built on `TextEncoder`/`TextDecoder`), reads headers `:event-type`, `:message-type`, `:exception-type`, parses the body as JSON (empty body → `{}`). Throws `"Bedrock event stream ended mid-frame"` if bytes remain at end of stream; enforces `maxBytes` (default 16 MiB) and `maxEvents` (default 4096) like the Anthropic SSE limits.
- Stream mapping in `chatCompletionsStream` (endpoint `/converse-stream`, timeout default 120 s, same auth as Task 9):
  - `messageStart` → remember role, nothing yielded.
  - `contentBlockStart` with `start.toolUse` → open a tool buffer `{ id: toolUseId, name, partialJson: "", toolCallIndex: next++ }` keyed by `contentBlockIndex`.
  - `contentBlockDelta`: `delta.text` → yield `{ choices: [{ index: 0, delta: { content } }] }`; `delta.toolUse.input` → append to the buffer; `delta.reasoningContent.text` → yield `{ choices: [{ index: 0, delta: { reasoning_content } }] }` (consistent with Task 2).
  - `contentBlockStop` → if a tool buffer exists, yield one `tool_calls` delta (same shape as the Anthropic adapter, `arguments` = buffered JSON or `"{}"`).
  - `messageStop` → remember `stopReason`.
  - `metadata` → remember `usage`; then yield the final chunk `{ choices: [{ index: 0, delta: {}, finish_reason }], usage }` with cost estimate (`applyEstimatedCostToStreamChunkWithSource`) and `succeed()` the accounting handle. If the stream ends after `messageStop` without `metadata`, yield the final chunk then (usage omitted).
  - `messageType === "exception"` (or `"error"`) → throw `"Bedrock stream error (<exceptionType>): <payload.message>"`.
  - Stream ending before `messageStop` → throw `"Bedrock stream ended before messageStop"`.
  - Non-2xx / redirect → same errors as Task 9. A 200 whose content-type is not `application/vnd.amazon.eventstream` → parse as Converse JSON (fallback, like Anthropic's non-SSE fallback) and yield one completion.
  - Accounting lifecycle (`renewLease` per event, `fail` on error, `cancel` when the consumer stops early) copied from the Anthropic stream loop.

- [ ] **Step 1: Write the failing tests** (helper builds frames with the real codec):

```ts
import { EventStreamCodec } from "@smithy/eventstream-codec";
const codec = new EventStreamCodec(
  (bytes) => new TextDecoder().decode(bytes),
  (text) => new TextEncoder().encode(text),
);
function frame(eventType: string, payload: unknown, messageType = "event"): Uint8Array {
  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":message-type": { type: "string", value: messageType },
      ":content-type": { type: "string", value: "application/json" },
      ...(messageType === "exception" ? { ":exception-type": { type: "string", value: eventType } } : {}),
    },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
}
function streamOf(bytes: Uint8Array, splitEvery: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += splitEvery) {
        controller.enqueue(bytes.slice(offset, offset + splitEvery));
      }
      controller.close();
    },
  });
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
```

  1. **Decode `contentBlockDelta` / `messageStop` with arbitrary splits**: frames `messageStart`, two text deltas (`"Hel"`, `"lo"`), `contentBlockStop`, `messageStop {stopReason:"end_turn"}`, `metadata {usage:{inputTokens:3,outputTokens:2,totalTokens:5}}`; for `splitEvery` in `[1, 7, 64, 100000]` the adapter yields contents `["Hel","lo"]` then a final chunk with `finish_reason: "stop"` and `usage.total_tokens: 5`. Response: `new Response(streamOf(bytes, n), { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } })`.
  2. **Tool use**: `contentBlockStart {contentBlockIndex:1, start:{toolUse:{toolUseId:"tu1", name:"lookup"}}}`, deltas `{toolUse:{input:'{"q":'}}`, `{toolUse:{input:'"goat"}'}}`, `contentBlockStop`, `messageStop {stopReason:"tool_use"}`, `metadata` → one `tool_calls` chunk `{ index: 0, id: "tu1", function: { name: "lookup", arguments: '{"q":"goat"}' } }` and `finish_reason: "tool_calls"`.
  3. **Reasoning deltas**: `contentBlockDelta {delta:{reasoningContent:{text:"hmm"}}}` → chunk with `delta.reasoning_content === "hmm"` and never in `content`.
  4. **Exception frame**: `frame("throttlingException", { message: "Too many requests" }, "exception")` after `messageStart` → rejects with `throttlingException` and `Too many requests`.
  5. **Truncated stream**: drop the last 3 bytes of a valid stream → rejects with `mid-frame`.
  6. **Ended before messageStop**: frames up to `contentBlockStop` only → rejects with `before messageStop`.
  7. `decodeBedrockEventStream` unit test: two concatenated frames split at byte 5 → two events with correct `eventType`/`payload`.

- [ ] **Step 2: Run to verify they fail** (same command as Task 9).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/llm-provider-bedrock-stream.ts apps/gateway/src/services/llm-provider-bedrock.ts apps/gateway/src/services/llm-provider-bedrock.test.ts
git commit -m "feat: stream Amazon Bedrock ConverseStream responses"
```

---

### Task 11: Register Bedrock end to end, template, settings UI, docs

**Files:**
- Modify: `apps/gateway/src/services/llm-service.ts` (registry ~L316; delete the two `case "bedrock-messages": throw …` at ~L1812 and ~L1980; model discovery for Bedrock)
- Modify: `apps/gateway/src/services/llm-service.test.ts` (bedrock upsert test ~L1313 → also dispatch)
- Modify: `packages/contracts/src/provider-templates.ts` (Bedrock template) and its test if one enumerates templates
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/ProviderProfileFields.tsx`, `apps/mission-control-next/src/features/native-routes/settings/sections/ProviderProfileFields.tsx`, `apps/mission-control-next/src/cockpit/areas/settings/settings-vocabulary.ts` (labels for the two auth modes), `provider-save-contract.ts` / `provider-drafts.ts` only if they narrow `authMode` unions
- Modify docs that mention Bedrock as unsupported: `git grep -n -i "bedrock" -- README.md docs/1_0_CONTRACT.md docs/CANONICAL_RUNTIME_STATE_MODEL.md docs/*.md`

**Interfaces:**
- Consumes: Tasks 8–10.
- Template: `{ providerId: "bedrock", label: "Amazon Bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", apiStyle: "bedrock-messages", authMode: "aws-bedrock-api-key", defaultModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", knownModels: ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "us.amazon.nova-pro-v1:0", "us.meta.llama4-maverick-17b-instruct-v1:0"] }`. Before committing, confirm these are real Bedrock inference-profile ids (AWS Bedrock docs "Supported Regions and models for inference profiles"); replace any that are not with ids the docs list.
- Model discovery: Bedrock has no OpenAI `/models` endpoint on the runtime host. Find the discovery path (`git grep -n '"models"' -- apps/gateway/src/services/llm-service.ts`) and make `bedrock-messages` providers return their configured `defaultModel` + `models`/`knownModels` without a network call.
- UI: both `ProviderProfileFields` gain `<option value="aws-bedrock-api-key">Bedrock API key</option>` and `<option value="aws-sigv4">AWS access key (SigV4)</option>`, shown only when `apiStyle === "bedrock-messages"`. For `aws-sigv4`, the secret field label reads "AWS credentials JSON" with help text `{"accessKeyId":"…","secretAccessKey":"…","sessionToken":"…"} — or leave empty to use AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the gateway environment.` Follow `DESIGN.md`/`PRODUCT.md` (read both first) and never show raw wire values (`bedrock-messages`) — use `settings-vocabulary.ts` labels; the existing `ProviderProfileFields.test.tsx` asserts that.

- [ ] **Step 1: Write the failing tests**
  - `llm-service.test.ts`: replace the upsert-only bedrock assertion with: upsert succeeds **and** `chatCompletions({ providerId: "bedrock", model: <default>, messages:[{role:"user",content:"hi"}] })` with env `BEDROCK_API_KEY` (set `apiKeyEnv: "BEDROCK_API_KEY"`, `authMode: "aws-bedrock-api-key"`) and a stubbed fetch returning a Converse JSON body resolves with content `"hi there"`; assert the request URL ends with `/converse` and carries `Authorization: Bearer <env value>`. Add a SigV4 variant with `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env and assert an `AWS4-HMAC-SHA256` authorization header, and a streaming variant through `chatCompletionsStream` using an event-stream body (reuse the frame helper; export it from a small `llm-provider-bedrock.test-support.ts` if both test files need it).
  - Cockpit `ProviderProfileFields.test.tsx`: rendering with `apiStyle: "bedrock-messages"` shows the "Bedrock API key" and "AWS access key (SigV4)" options and not the raw strings `aws-sigv4`/`bedrock-messages` as visible text.

- [ ] **Step 2: Run to verify they fail** (llm-service test `-t "bedrock"`; UI: `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/settings/ProviderProfileFields.test.tsx --maxWorkers=2`).

- [ ] **Step 3: Implement** registry entry (`createLlmProviderAdapterRegistry([anthropicProviderAdapter, bedrockProviderAdapter])`), delete both throws, discovery short-circuit, template, UI, vocabulary, docs.

- [ ] **Step 4: Run to verify they pass**, plus `git grep -n "not yet supported in this version"` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add -A apps/gateway/src/services/llm-service.ts apps/gateway/src/services/llm-service.test.ts packages/contracts/src/provider-templates.ts apps/mission-control-next/src docs README.md
git commit -m "feat: enable Amazon Bedrock providers end to end"
```

(Stage only files you changed; check `git status --short` first.)

---

### Task 12: Proof lane and PR

- [ ] **Step 1:** `pnpm typecheck` (through the repo's output-lock wrapper if `package.json` routes it there) — must be green.
- [ ] **Step 2:** Re-run every focused test file touched in Tasks 1–11, one at a time, `--maxWorkers=2`.
- [ ] **Step 3:** `pnpm verify:fast` in the background at low priority; fix reds caused by this branch (re-check `origin/main` before treating a red as ours).
- [ ] **Step 4:** `git diff --check origin/main...HEAD`; `prettier --write` only on changed files (`git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx' '*.json' '*.md'`), then `prettier --check` the same list.
- [ ] **Step 5:** Repo hygiene: no personal paths (`git diff origin/main...HEAD | grep -n -i "C:\\\\Users\|F:\\\\code\|/f/code/"` → empty).
- [ ] **Step 6:** Push with `git -c credential.helper='!gh auth git-credential' push -u origin fix/gap-ws4-providers` and open the PR against `main` titled `feat: WS4 providers and evaluation (Bedrock, live model comparisons, incremental thinking)`, body listing the three tasks, the two deliberate deviations, the validation run, and anything not validated (no live AWS account call).

---

## Self-review

- **Spec coverage:** 4.1 → Tasks 8–11 (adapter, Converse/ConverseStream, both auth modes, three named deps, throws removed, contracts/zod, settings UI, template, tests for body mapping/SigV4/event-stream/tool round trip/errors, llm-service bedrock test). The `aws` config block is replaced by baseUrl region parsing (documented deviation). 4.2 → Tasks 5–7 (repo methods, start with transitions, composition wiring, run route, shared client, concurrency 2, blind identities, partial failure, cancel signal, judging unchanged, advisory text removed). 4.3 → Tasks 1–4 (Anthropic partial deltas, `reasoningDelta` incl. OpenAI `reasoning_content`/`reasoning`, per-chunk runner emission, "skeleton" wording, projector redaction, 16k reducer cap, redacted thinking never emitted).
- **Type consistency:** `reasoningDelta` (Task 1) used in Task 4; `streamReasoningDeltas` (Task 3) used in Task 4; `updateStatus`/`upsertResult` (Task 5) match the port in Task 6; `startComparison`/`cancelComparison`/`whenSettled` (Task 6) used in Task 7; `bedrockProviderAdapter` (Task 9) registered in Task 11.
