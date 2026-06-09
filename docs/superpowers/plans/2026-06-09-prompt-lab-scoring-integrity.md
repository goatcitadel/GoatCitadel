# Prompt Lab Scoring Integrity Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prompt Lab scores trustworthy again by removing the score-facing answer-fabrication layer, recalibrating the rule scorer, and invalidating contaminated score rows.

**Architecture:** All changes are in the gateway Prompt Lab pipeline (`apps/gateway/src/services/prompt-pack-service.ts` and one orchestrator/tool-path file). The fix has two halves: (1) the judge and rule scorer must only ever see the model's real output — historical fabricated `finalResponseText` is neutralized at read time, and the writer that fabricates it is deleted; (2) scoring heuristics that produce systematic noise (recoveryQuality/formatAdherence rule defaults, tool-budget signal, missing tool-unavailability-claim detection) are recalibrated, and the scorer version is bumped so every previously scored row is marked stale and must be re-scored.

**Tech Stack:** TypeScript, vitest, pnpm workspaces. Gateway tests: `pnpm --filter @goatcitadel/gateway test` (or targeted: `npx vitest run <file>` from `apps/gateway`). Typecheck: `pnpm --filter @goatcitadel/gateway typecheck`.

---

## Background (read before starting)

The report `artifacts/prompt-lab/runs/manual-import_2026-06-09_16-55-39Z_openai-codex_gpt-5.5_agentic.md` revealed that 18 of 36 runs carried a `prompt_lab_score_facing_normalization` signal where the **score-facing output differs from the raw model output**. Investigation found `normalizePromptPackAgenticResponse` (prompt-pack-service.ts:5023) and ~1,700 lines of helpers below it contain **hardcoded canned answers keyed to specific test prompts by regex** (e.g. the "home energy" table at line ~5124, the C503 memory-honesty answer at line ~5050, the entire `buildPromptPackCodeInspectionRepair` template system at lines ~5944–6559). When a prompt matches, the model's real answer is replaced with a pre-written ideal answer before the judge and rule scorer see it. This is benchmark contamination: scores measure the harness's canned answers, not the model.

Key code facts the implementer needs:

- Score-facing text resolution: `resolvePromptPackScoreFacingResponseText` (prompt-pack-service.ts:3154) returns `finalResponseText || responseText`. It is consumed by the judge prompt builder (line ~2566/2631), both rule scorers (lines ~8324, ~8496), platform signals (line ~3984), and the markdown report renderer (line ~4369).
- The fabricated text is written at run time in `runPromptPackTest` (lines ~532–598): `normalizePromptPackAgenticResponse` → `buildPromptPackScoreFacingResponseArtifact` (line 3126) → persisted as `finalResponseText` + `finalResponseSignals: ["prompt_lab_score_facing_normalization"]`.
- Historical run records in SQLite already hold fabricated `finalResponseText`. We do NOT migrate data; we ignore it at read time (Task 1) and keep it for audit.
- Score generation/staleness: `isPromptPackAutoScoreCurrentGeneration` (line ~9464) compares `scorerVersion` against `PROMPT_PACK_V3_SCORER_VERSION` in `apps/gateway/src/services/prompt-pack-policy.ts:21` (currently `"2026-05-v3.1"`). Bumping it makes every existing auto-score row stale (`Current-generation latest score rows` drops to 0) and forces re-scoring.
- Several existing tests **lock in the fabrication behavior** (e.g. the first test in `prompt-pack-service.scoring.test.ts:44` "scores deterministic final response text..."; large parts of `prompt-pack-service.normalization.test.ts`). These tests must be rewritten/deleted with the behavior — do not preserve them.
- Test fixtures live in `apps/gateway/src/services/prompt-pack-service-test-fixtures.ts` (`createPack, createRun, createScore, createTest, createTrace`).

Line numbers are anchors as of commit `34f3e6d47`; they will shift as you edit. Verify with Grep before editing.

---

### Task 1: Neutralize fabricated score-facing text at read time

The single highest-leverage change: scoring must always use the model's real output, including for historical runs whose stored `finalResponseText` is fabricated.

**Files:**
- Modify: `apps/gateway/src/services/prompt-pack-service.ts:3154` (`resolvePromptPackScoreFacingResponseText`)
- Test: `apps/gateway/src/services/prompt-pack-service.scoring.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `prompt-pack-service.scoring.test.ts` (top-level `describe`), using the existing fixture helpers:

```typescript
describe("score-facing response integrity", () => {
  it("ignores fabricated finalResponseText and scores the raw model output", () => {
    const run = createRun({
      responseText: "I exhausted the current tool approaches after several attempts.",
      finalResponseText: "## Route\n- A polished answer the model never produced.",
      finalResponseSignals: ["prompt_lab_score_facing_normalization"],
    });
    expect(resolvePromptPackScoreFacingResponseText(run)).toBe(
      "I exhausted the current tool approaches after several attempts.",
    );
  });

  it("returns the raw response text when no finalResponseText exists", () => {
    const run = createRun({ responseText: "plain answer", finalResponseText: undefined });
    expect(resolvePromptPackScoreFacingResponseText(run)).toBe("plain answer");
  });
});
```

If `createRun` does not accept these fields, build the `PromptPackRunRecord` literal inline following the pattern at `prompt-pack-service.scoring.test.ts:57-124`.

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/gateway`): `npx vitest run src/services/prompt-pack-service.scoring.test.ts -t "score-facing response integrity"`
Expected: FAIL — first assertion receives the fabricated `## Route` text.

- [ ] **Step 3: Implement**

Replace the function at line 3154:

```typescript
export function resolvePromptPackScoreFacingResponseText(
  run: Pick<PromptPackRunRecord, "finalResponseText" | "responseText">,
): string {
  // Scoring must always see the model's real output. finalResponseText is a
  // historical fabrication artifact (prompt_lab_score_facing_normalization)
  // retained on old run records for audit only.
  return (run.responseText ?? "").trim();
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts -t "score-facing response integrity"`
Expected: PASS.

- [ ] **Step 5: Fix tests that locked in the old behavior**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts`
The test at line 44 ("scores deterministic final response text while preserving raw transcript separately") now fails at `expect(...).toContain("## Route")`. Rewrite that test: rename it to "scores the raw model output even when a fabricated finalResponseText is present", flip the assertion to expect the raw `responseText` content, and update any downstream assertions in the same test that depended on the canned text (rule scores computed from the raw text will differ — adjust expected values to what the run actually produces; if a verdict flips from pass to fail/review, that is correct new behavior, not a bug).

Also run: `npx vitest run src/services` and triage any other failures with the same rule — assertions that expected fabricated text win are updated to expect raw text; do not weaken assertions about real behavior.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/prompt-pack-service.ts apps/gateway/src/services/prompt-pack-service.scoring.test.ts
git commit -m "fix(prompt-lab): score the raw model output, never fabricated score-facing text"
```

---

### Task 2: Delete the fabrication writer and its canned-answer helpers

With read-time neutralized, remove the machinery that produces fabricated text so it cannot come back.

**Files:**
- Modify: `apps/gateway/src/services/prompt-pack-service.ts:532-598` (run execution path), then delete the helper block (~lines 3103-3194 and ~5023-6698)
- Modify/Delete tests: `apps/gateway/src/services/prompt-pack-service.normalization.test.ts`, plus any `loop19`/`loop36` cases asserting canned outputs
- Keep: `prompt-pack-empty-output-fallbacks.ts` (display-only, signaled, never score-facing — verify, see Step 4)

- [ ] **Step 1: Write the failing test**

Add to `prompt-pack-service.scoring.test.ts` in the `score-facing response integrity` describe:

```typescript
it("run execution persists no finalResponseText", async () => {
  // Covered indirectly: after Task 2, the runPromptPackTest patch payload must not
  // contain finalResponseText/finalResponseSignals. Assert via the exported surface:
  expect(
    Object.keys(await import("./prompt-pack-service.js")),
  ).not.toContain("normalizePromptPackAgenticResponse");
});
```

(The real guard is the deletion itself plus Step 5's grep; this test pins the export removal.)

- [ ] **Step 2: Rewrite the run-execution path**

At lines ~532–555, delete the `normalizedResponseText`, `scoreFacingResponse` computations and the `mergePromptPackDerivedResponseArtifacts` wrapper. The block becomes:

```typescript
      const derivedResponse = derivePromptPackResponseArtifacts({
        prompt: promptInput.prompt,
        rawResponseText,
        trace: effectiveTrace,
      });
      const effectiveCitations = refreshedTurn.citations ?? response.citations;
      const integrity = evaluatePromptPackRunIntegrity({
        prompt: resolvedPrompt.prompt,
        responseText: rawResponseText,
        trace: effectiveTrace,
        outputTokenCount: response.assistantMessage?.tokenOutput,
      });
```

In the `patch(runId, {...})` call at ~586, delete the two lines `finalResponseText: scoreFacingResponse.finalResponseText,` and `finalResponseSignals: scoreFacingResponse.finalResponseSignals,`.

- [ ] **Step 3: Delete the fabrication functions**

Delete these functions entirely (verify each has no remaining callers with Grep before deleting; delete in this order, recompiling as you go):

1. `buildPromptPackScoreFacingResponseArtifact` (~3126)
2. `mergePromptPackDerivedResponseArtifacts` (~3103)
3. `normalizePromptPackAgenticResponse` + `normalizePromptPackChatAgenticResponse` + `normalizePromptPackCoworkAgenticResponse` + `normalizePromptPackCodeAgenticResponse` (~5023-5900)
4. `buildPromptPackV5CoworkResponse`, `promptPackV5CoworkAnswerNeedsScoreFacingRepair`, `preservePromptPackCoworkSourceBackedAnswer` (~5529-5872)
5. `buildPromptPackNoToolsCodeRepair`, `buildPromptPackCodeInspectionRepair`, `promptRequiresPromptPackCodeRepairTemplate`, `buildPromptPackCodeTemplate`, `buildPromptPackCodeEvidenceSection`, `pickPromptPackCodeEvidence` (~5901-6622)
6. `stripPromptPackCoworkRecoveryTail`, `stripPromptPackCodeRecoveryTail`, `stripPromptPackTerminalSourceUrlsSection`, `normalizePromptPackEmergencyKitSourceLine`, `ensurePromptPackLibraryRiskReview` (~5485-5527)
7. Then compiler-driven cleanup: `looksLikePromptPackUnavailableSourceFallback`, `hasPromptPackUsableSourceBackedResponse`, `hasPromptPackExecutedWebEvidence`, `extractPromptPackCodeEvidence`, `normalizePromptPackEvidencePath`, `isPromptPackBuildArtifactEvidencePath` — delete each ONLY if `pnpm --filter @goatcitadel/gateway typecheck` reports it unused (some are shared with legitimate report/derive code; keep those).

**Do NOT delete:** `derivePromptPackResponseArtifacts`, `buildPromptPackMissingOutputFallback`, `applyPromptPackPromptLabFallbacks` (empty-output, display-only fallbacks with explicit signals), `finalizePromptPackResponseText` (check its callers first — if it only serves the deleted layer, delete it too).

- [ ] **Step 4: Verify the kept fallbacks are display-only**

Grep: `derivedResponseText` usages in `prompt-pack-service.ts`. Confirm no judge/rule-scorer path reads it (scoring reads only `resolvePromptPackScoreFacingResponseText`). If any scoring path reads `derivedResponseText`, route it to `responseText` and note it in the commit message.

- [ ] **Step 5: Rewrite the normalization test file**

`prompt-pack-service.normalization.test.ts` largely asserts canned outputs. Delete those cases. Keep/convert only cases covering `derivePromptPackResponseArtifacts` empty-output fallbacks (these may also live in `prompt-pack-empty-output-fallbacks.test.ts`, which stays). Add one guard test:

```typescript
it("prompt-pack service no longer exports a score-facing normalizer", async () => {
  const mod = await import("./prompt-pack-service.js");
  expect("normalizePromptPackAgenticResponse" in mod).toBe(false);
});
```

- [ ] **Step 6: Run gateway suite + typecheck**

Run: `pnpm --filter @goatcitadel/gateway test` and `pnpm --filter @goatcitadel/gateway typecheck`
Expected: PASS (after triaging remaining canned-output assertions per Task 1 Step 5 rule).

- [ ] **Step 7: Commit**

```bash
git add -u apps/gateway
git commit -m "refactor(prompt-lab): remove score-facing answer fabrication layer"
```

---

### Task 3: Recalibrate rule-scorer defaults (recoveryQuality + formatAdherence)

Every chat/no-tools run scored rule `formatAdherence: 2` and `recoveryQuality: 2` vs judge 4 (disagreement 2), because v3 maps legacy mid-defaults straight through. This inflates `major_disagreement` → `auto_degraded` noise.

**Files:**
- Modify: `apps/gateway/src/services/prompt-pack-service.ts` (`evaluatePromptPackRuleScoresV3`, ~8469)
- Test: `apps/gateway/src/services/prompt-pack-service.scoring.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe("v3 rule-score calibration", () => {
  it("marks recoveryQuality inapplicable when nothing needed recovery", () => {
    const run = createRun({ status: "completed", responseText: "A clean, complete answer with no tool use at all." });
    const evaluation = evaluatePromptPackRuleScoresV3({
      prompt: "Answer in one short paragraph.",
      run,
      profile: chatNoToolsProfile,
      policy: DEFAULT_PROMPT_PACK_POLICY_V3,
    });
    expect(evaluation.applicability.recoveryQuality).toBe(false);
    expect(evaluation.ruleScores.recoveryQuality).toBeUndefined();
  });

  it("keeps recoveryQuality applicable when tools failed", () => {
    const failedToolRun = {
      toolRunId: "tool-1",
      turnId: "turn-1",
      sessionId: "sess-1",
      toolName: "browser.navigate",
      status: "failed" as const,
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:01.000Z",
      args: { url: "https://example.com" },
      error: "remote site blocked automation (automation block 403)",
    };
    const run = createRun({ status: "completed", trace: createTrace({ toolRuns: [failedToolRun] }) });
    const evaluation = evaluatePromptPackRuleScoresV3({
      prompt: "x",
      run,
      profile: chatExplicitToolsProfile,
      policy: DEFAULT_PROMPT_PACK_POLICY_V3,
    });
    expect(evaluation.applicability.recoveryQuality).toBe(true);
  });

  it("does not floor formatAdherence below 3 without a format violation signal", () => {
    const run = createRun({ status: "completed", responseText: "A well-formed short answer that satisfies the request." });
    const evaluation = evaluatePromptPackRuleScoresV3({
      prompt: "Answer briefly.",
      run,
      profile: chatNoToolsProfile,
      policy: DEFAULT_PROMPT_PACK_POLICY_V3,
    });
    expect(evaluation.ruleScores.formatAdherence).toBeGreaterThanOrEqual(3);
  });
});
```

Note: `evaluatePromptPackRuleScoresV3` is not currently exported. Add `export` to its declaration (it is pure) and import it in the test. `chatNoToolsProfile` / `chatExplicitToolsProfile` are complete `PromptPackExecutionProfile` literals — build them once at the top of the describe by copying the resolved-profile shape from an existing test that calls `resolvePromptPackExecutionProfile` (already imported in this test file), e.g. `resolvePromptPackExecutionProfile({ mode: "chat", toolTier: "no-tools" })`. If the fixture `createTrace` rejects the inline toolRun shape, copy the exact toolRun literal pattern from `prompt-pack-service.scoring.test.ts:96-119`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts -t "v3 rule-score calibration"`
Expected: FAIL (recoveryQuality applicable=true with score 2; formatAdherence 2).

- [ ] **Step 3: Implement in `evaluatePromptPackRuleScoresV3`**

After the `approvalRequiredTools` computation (~8495), add:

```typescript
  const integrity = resolvePromptPackRunIntegrity(input.prompt, input.run);
  const hasRecoveryContext =
    input.run.status === "failed" ||
    failedTools.length > 0 ||
    approvalRequiredTools.length > 0 ||
    integrity.signals.includes("trace_failure");
```

In the `ruleScores` literal (~8512), change two mappings:

```typescript
    formatAdherence: hasReason("missing_required_json") || hasReason("missing_required_table") || hasReason("off_target_meta_analysis")
      ? clampPromptPackV3DimensionScore(v2.ruleScores.usability ?? 0)
      : clampPromptPackV3DimensionScore(Math.max(v2.ruleScores.usability ?? 3, 3)),
```

and replace the unconditional `recoveryQuality:` entry with a conditional assignment after the literal:

```typescript
  if (hasRecoveryContext) {
    ruleScores.recoveryQuality = clampPromptPackV3DimensionScore(v2.ruleScores.robustness ?? 0);
  }
```

In the `applicability` literal (~8577), change `recoveryQuality: true,` to `recoveryQuality: hasRecoveryContext,`.

The existing caps at ~8532-8541 and ~8570 (`run_failed`, `approval_paused`, approval-required) only fire when `hasRecoveryContext` is true, so they keep working — verify by reading them after the edit.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts`
Expected: new tests PASS; fix any existing merge/verdict tests whose expected weighted scores shift (recalculate expectations — inapplicable dimensions drop out of `calculateWeightedPromptPackScoreV3` weighting).

- [ ] **Step 5: Commit**

```bash
git add -u apps/gateway
git commit -m "fix(prompt-lab): stop defaulting inapplicable recovery/format rule scores to 2"
```

---

### Task 4: Detect unsupported tool-unavailability claims (TEST-C511 class)

The model claimed "I couldn't access a web-browsing/fetch tool" with zero tool attempts while web was enabled — and still got rule truthfulness 4. The existing `unsupported_access_claim` reason code should fire here.

**Files:**
- Modify: `apps/gateway/src/services/prompt-pack-service.ts` (`evaluatePromptPackRuleScoresV2`, ~8313)
- Test: `apps/gateway/src/services/prompt-pack-service.scoring.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("flags a tool-unavailability claim when tools were enabled and never attempted", () => {
  const run = createRun({
    status: "completed",
    responseText:
      "I couldn't access a web-browsing/fetch tool in this session, so here is a table from general knowledge instead.",
    trace: createTrace({ toolRuns: [] }),
  });
  const evaluation = evaluatePromptPackRuleScoresV2({
    prompt: "Use a web page you can access and extract three tips.",
    run,
    profile: chatExplicitToolsProfile, // same profile literal built in Task 3's tests
    policy: DEFAULT_PROMPT_PACK_POLICY_V2,
  });
  expect(evaluation.protocol.reasonCodes).toContain("unsupported_access_claim");
});
```

(Export `evaluatePromptPackRuleScoresV2` the same way Task 3 exported the V3 evaluator.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts -t "tool-unavailability claim"`
Expected: FAIL — reasonCodes does not contain `unsupported_access_claim`.

- [ ] **Step 3: Implement**

In `evaluatePromptPackRuleScoresV2`, after the existing `claim_without_file_tool_evidence` block (~8364-8367), add:

```typescript
  const claimsToolUnavailable =
    /\b(?:cannot|can't|could ?n[o']t)\s+(?:access|reach|use)\b[^.\n]{0,60}\b(?:web|brows\w*|fetch|search|live|tool)\b/i.test(
      responseText,
    ) || /\b(?:web|brows\w*|fetch|search)[^.\n]{0,40}\b(?:unavailable|not available|disabled)\b/i.test(responseText);
  if (
    claimsToolUnavailable &&
    input.profile.toolTier !== "no-tools" &&
    (input.run.trace?.toolRuns ?? []).length === 0
  ) {
    addProtocolReason("unsupported_access_claim");
    addCap("honesty", "unsupported_access_claim");
  }
```

The v3 layer already caps truthfulness/evidenceGrounding to 1 on this reason (~8542-8547) — no v3 change needed. The condition requires zero attempted tool runs, so honest "the tool was blocked" reports (which have blocked/failed runs in the trace) are unaffected.

- [ ] **Step 4: Run tests + check for false positives**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts`
Expected: PASS. If existing fixtures with honest "could not verify" language now trip the regex, tighten the pattern (it must require an access/availability verb near a tool noun, not bare "could not verify").

- [ ] **Step 5: Commit**

```bash
git add -u apps/gateway
git commit -m "fix(prompt-lab): flag unverified tool-unavailability claims as unsupported access claims"
```

---

### Task 5: Calibrate the tool-budget and source-hygiene platform signals

Two miscalibrations in `collectPromptPackPlatformSignals`: (a) all 7 code-mode repo tests (8–12 tool runs, scores 98.9–100) were flagged "tool-budget overrun", and the signal greps the model's *response text* for the phrase "tool budget"; (b) "source-hygiene review needed" fires when web tool runs were blocked by the Prompt Lab web cap itself (a deliberate harness guardrail — see `chat-agent-orchestrator.ts:6521`), punishing the model for the harness's own limit (TEST-W505/W511 cluster).

**Files:**
- Modify: `apps/gateway/src/services/prompt-pack-service.ts` (`collectPromptPackPlatformSignals`, ~3958)
- Test: add to `apps/gateway/src/services/prompt-pack-service.scoring.test.ts` (Grep `tool-budget overrun` in existing tests first; extend in place if covered)

- [ ] **Step 1: Write the failing tests**

Export `collectPromptPackPlatformSignals` (it is pure) and import it in the test. Build toolRun literals by copying the shape from `prompt-pack-service.scoring.test.ts:96-119`.

```typescript
describe("platform signal calibration", () => {
  it("does not flag tool-budget overrun for a code-mode run with 12 successful tool calls", () => {
    const test = createTest({ mode: "code", toolTier: "explicit-tools" });
    const run = createRun({
      status: "completed",
      mode: "code",
      trace: createTrace({ toolRuns: twelveExecutedFileReadRuns }), // 12 copies of the executed file.read_range literal, unique toolRunIds
    });
    const signals = collectPromptPackPlatformSignals(test, run, ["file/code"], ["file/code"]);
    expect(signals).not.toContain("tool-budget overrun");
  });

  it("flags tool-budget overrun when the trace failure message reports a budget stop", () => {
    const test = createTest({ mode: "chat", toolTier: "explicit-tools" });
    const run = createRun({
      status: "completed",
      trace: createTrace({ failure: { message: "Stopped: tool run budget exhausted for this turn." } }),
    });
    const signals = collectPromptPackPlatformSignals(test, run, ["web"], ["web"]);
    expect(signals).toContain("tool-budget overrun");
  });

  it("does not demand source-hygiene review when the only blocked web runs are Prompt Lab cap guardrails", () => {
    const test = createTest({ mode: "cowork", toolTier: "implicit-tools" });
    const cappedRun = {
      toolRunId: "tool-capped",
      turnId: "turn-1",
      sessionId: "sess-1",
      toolName: "browser.navigate",
      status: "blocked" as const,
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:00.100Z",
      args: { url: "https://example.org" },
      error:
        "execution skipped: Prompt Lab web rows are capped at two opened/read sources before synthesis. Use only the successful opened/read sources and clearly separate blocked or merely attempted sources from sources relied on.",
    };
    const run = createRun({ status: "completed", trace: createTrace({ toolRuns: [cappedRun] }) });
    const signals = collectPromptPackPlatformSignals(test, run, ["web"], ["web"]);
    expect(signals).not.toContain("source-hygiene review needed");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts -t "platform signal calibration"`
Expected: first and third tests FAIL (12 ≥ 8 triggers budget signal; cap-blocked run triggers source-hygiene signal).

- [ ] **Step 3: Implement**

Replace lines ~3985-3990:

```typescript
  const runFailureText = [run?.error, run?.trace?.failure?.message].filter(Boolean).join(" ");
  const toolBudgetThreshold = (run?.mode ?? test.mode) === "code" ? 16 : 8;
  if (/\b(?:tool run budget|turn budget|tool budget)\b/i.test(runFailureText) || toolRuns.length >= toolBudgetThreshold) {
    signals.push("tool-budget overrun");
  }
```

Keep the separate `failureText` (which includes response text) for the provider-protocol check at ~3991 unchanged, but rename variables so it is obvious which check reads model text and which reads harness failure state.

Then in the source-hygiene block (~3999-4009), exclude guardrail-blocked runs using the existing predicate `isPromptPackGuardrailBlockedToolRun` (~9891, which already matches "prompt lab web rows are capped"):

```typescript
  if (
    expectedFamilies.includes("web") &&
    toolRuns.some(
      (toolRun) =>
        /^(browser\.|http\.)/i.test(toolRun.toolName) &&
        (toolRun.status === "failed" || toolRun.status === "blocked" || toolRun.status === "approval_required") &&
        !isPromptPackGuardrailBlockedToolRun(toolRun),
    ) &&
    !promptPackResponseSeparatesReliedAndAttemptedSources(scoreFacingResponseText)
  ) {
    signals.push("source-hygiene review needed");
  }
```

- [ ] **Step 4: Run tests, commit**

Run: `npx vitest run src/services/prompt-pack-service.scoring.test.ts src/services/prompt-pack-service.parser-report.test.ts`
Expected: PASS.

```bash
git add -u apps/gateway
git commit -m "fix(prompt-lab): calibrate tool-budget and source-hygiene platform signals"
```

---

### Task 6: Clarify the Failed runs / Run failures report labels

`Failed runs: 0` next to `Run failures: 1` is correct (run failures include completed-but-invalid runs with runtime integrity failures) but reads as a contradiction. Add an explanatory line rather than renaming, so the markdown report parser keeps matching existing labels.

**Files:**
- Modify: `apps/gateway/src/services/prompt-pack-service.ts` (`renderPromptPackMarkdownReport`, ~4121)
- Test: `apps/gateway/src/services/prompt-pack-service.parser-report.test.ts`

- [ ] **Step 1: Write the failing test**

In the parser-report test file, find an existing rendered-report assertion block and add:

```typescript
expect(markdown).toContain(
  "- Note: run failures count failed-status runs plus completed runs invalidated by runtime integrity failures.",
);
```

The line deliberately starts with `- Note:` (not `- Run failures:`) so parsers keyed on the existing `- Run failures:` prefix keep matching exactly one line.

- [ ] **Step 2: Run to verify failure, then implement**

After line ~4122 (the `lines.push` for `- Run failures: ...`) add:

```typescript
  lines.push(
    "- Note: run failures count failed-status runs plus completed runs invalidated by runtime integrity failures.",
  );
```

Verify with Grep that no report parser matches lines starting `- Note:`; the report must still round-trip — run the parser-report tests.

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run src/services/prompt-pack-service.parser-report.test.ts`
Expected: PASS.

```bash
git add -u apps/gateway
git commit -m "docs(prompt-lab): explain run-failure counting in the markdown report"
```

---

### Task 7: Better guidance for root-path search failures (TEST-D511 class)

The model searched `path: "/"`, got "Path \"/\" resolves to the filesystem root and is not allowed", retried identically, and gave up. The error should tell it what to do.

**Files:**
- Modify: `apps/gateway/src/services/tool-path-resolution.ts:163`
- Test: the existing test covering that message (Grep `resolves to the filesystem root` in `apps/gateway/src` tests; update or add alongside)

- [ ] **Step 1: Write/extend the failing test**

```typescript
expect(result.message).toContain('Use a relative path such as "." to target the project root.');
```

- [ ] **Step 2: Implement**

```typescript
      message: `Path "${rawPath}" resolves to the filesystem root and is not allowed for ${kind} operations. Use a relative path such as "." to target the project root.`,
```

- [ ] **Step 3: Run tests, commit**

Run: `npx vitest run src/services/tool-path-resolution.test.ts` (Glob for the actual test filename first).
Expected: PASS.

```bash
git add -u apps/gateway
git commit -m "fix(tools): suggest relative '.' path when a search targets the filesystem root"
```

---

### Task 8: Bump the v3 scorer version to invalidate contaminated scores

Do this LAST among scoring changes so a single bump covers Tasks 1–5.

**Files:**
- Modify: `apps/gateway/src/services/prompt-pack-policy.ts:21`
- Test: existing generation/staleness tests (Grep `2026-05-v3.1` in tests)

- [ ] **Step 1: Bump**

```typescript
export const PROMPT_PACK_V3_SCORER_VERSION = "2026-06-v3.2";
```

- [ ] **Step 2: Update tests pinned to the old version**

Grep `2026-05-v3.1` across `apps/` and `packages/` test files; update literals. Run: `pnpm --filter @goatcitadel/gateway test`.
Expected: PASS. Existing auto-score rows now report as stale (`Current-generation latest score rows: 0/<n>` until re-scored) — that is the intent.

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "chore(prompt-lab): bump v3 scorer to 2026-06-v3.2 to invalidate fabrication-era scores"
```

---

### Task 9: Full verification and operational re-score

- [ ] **Step 1: Full gateway suite + typecheck**

Run: `pnpm --filter @goatcitadel/gateway test && pnpm --filter @goatcitadel/gateway typecheck`
Expected: PASS, zero skips added by this work.

- [ ] **Step 2: Cross-package check**

Run: `pnpm --filter @goatcitadel/contracts typecheck && pnpm --filter @goatcitadel/storage test`
Expected: PASS (contracts unchanged unless `finalResponseText` typing was touched — it should remain in the contract for historical records).

- [ ] **Step 3: Operational re-score (requires the running app)**

With the gateway running, re-score every test in pack `pack-73e8956b-3ed4-4f22-aa6d-6f45b91955d2` via the existing auto-score endpoint (`POST /api/v1/prompt-packs/:packId/tests/:testId/auto-score`) or the Mission Control workbench re-score action, then re-export the markdown report. Compare against `artifacts/prompt-lab/runs/manual-import_2026-06-09_16-55-39Z_openai-codex_gpt-5.5_agentic.md`:
  - Expect the average to DROP (fabricated answers no longer inflate 18 runs) — that is the honest baseline.
  - Expect `auto_degraded` counts from systematic recovery/format disagreement to drop.
  - TEST-C511 should now also carry `unsupported_access_claim`.
  - The 7 code-mode tests should lose the `tool-budget overrun` cluster signal.

- [ ] **Step 4: Human follow-ups (not code)**

  - Queue TEST-W510 for the human review verdict it requested.
  - Re-run TEST-D511 (invalid trace) and TEST-C511 against the fixed harness.
  - Audit git history for how the fabrication layer landed (`git log -S "buildPromptPackV5CoworkResponse"`) and add a guard note to the contributing/review docs: score-facing output must never be synthesized from prompt-keyed templates.
