# Code Mode In The Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the assistant hits something no tool can do (the motivating case: reviewing a PDF it just wrote), it asks to run code, the operator approves with one click in the reply, the code runs, and the same turn continues with the result. Afterwards one click saves the code as a reusable tool.

**Architecture:** A new model-callable tool, `code_mode.request`, carries a one-line goal and a short script. It always needs approval, and it goes through the ordinary `tool.invoke` approval path. That path already pauses the durable Chat turn and resumes it after approval. The tool's executor hands the approved script to a new `CapabilitySystemService.runApprovedCodeModeRequest`, which keeps Code Mode's artifact hashing and execution-time hash checks, binds them to the approval, runs the script and returns the result to the model. Code inside a run gets three new read-only helpers (`docs.read_bytes`, `docs.extract_text`, `docs.decompress`). The Cockpit reply shows a compact one-line card with details collapsed. When Code Mode is off, the same click turns it on, and the gap-suggestion scout triggers on evidence from the turn instead of keywords.

**Tech Stack:** TypeScript, Fastify gateway, `@goatcitadel/policy-engine`, `@goatcitadel/contracts`, React (mission-control-next Cockpit), vitest (happy-dom, raw `createRoot` + `act`), `unpdf`/`mammoth` (already dependencies), `node:zlib`.

**Spec:** No separate spec document; the decisions below are the spec. They came from the 2026-10-30 review of chat session `sess_71fa6e242b2c619a529db104` (Saturday plan, then PDF, then "review it", then a PDF upload, then "why can't you read it").

### Decisions (the spec)

1. **Gap outcome:** solve now in the same turn, then offer one click to keep it as a reusable tool.
2. **Approval:** one click in the chat reply. A compact card shows one line of what it will do, an Approve button, and collapsed details. After approval the turn resumes on its own, with no Continue step.
3. **Code Mode off:** the same card offers "Turn on Code Mode and run". That one click turns on Code Mode and the Windows AppContainer host sandbox (audited), then runs. Never claim hostile-code sandboxing.
4. **Run power:** add vetted read-only helpers inside runs: read file bytes, extract document text (the existing PDF/DOCX parser), decompress. Still no imports, no network and no writes.
5. **Out of scope** (separate plans): built-in PDF reading for uploads and `fs.read` in normal chat; the `.md` writer that flattens newlines; research depth (OSRM, NWS, the raw-prompt first search). The Hermes Saturday plan is the benchmark for that second plan, not this one.

### What was broken (each one is fixed by a task below)

| # | Problem | Evidence | Task |
|---|---|---|---|
| 1 | The model cannot start Code Mode; `code_mode.run` is an approval kind, not a callable tool | `capability-system-service.ts:6291`; not in `BUILTIN_TOOLS` | 4 |
| 2 | Scout triggers on keywords: false positives on turns 1–2, misses on turns 3–4, title built from the question ("Why Aren Able Read Pdf") | `chat-capability-scout.ts:92-95, 297, 390` | 5 |
| 3 | Suggestions render only in the legacy `ThreadedContextDrawer`; Cockpit renders none | `ThreadedContextDrawer.tsx:586`; nothing under `cockpit/` | 6, 7 |
| 4 | Code Mode is off (`codeModeV1Enabled: false`), and the Windows host sandbox is config-only and off | `config.ts:1236, 1468` | 2, 6 |
| 5 | Run code cannot read binary files or parse documents (`fs.read` is UTF-8, 64 KB) | `filesystem-executor.ts:78`; guest has no `require` | 1 |
| 6 | A finished run does not resume the turn; it posts a separate hash-listing message without `run.result` | `approval-resolution-effects-service.ts:3431`; `enqueueCodeModeFinalTranscript` | 3, 4 |
| 7 | In Cockpit chat a `code_mode.run` Approve is disabled (no `specialistEvidence` passed) | `ChatBlockers.tsx`, `ApprovalDecisionBar.tsx:378` | 6 |

## Global Constraints

- Code Mode always needs an explicit operator approval. A grant, MCP relief, `approve_all`-off profile or `trusted_local_power` bypass never runs a `code_mode.request` without an operator decision (`docs/1_0_CONTRACT.md:74`).
- Never claim hostile-code sandboxing in code, copy or docs (`docs/1_0_CONTRACT.md:111`). Copy says "runs on this computer in a restricted sandbox".
- No new dependencies. PDF uses `unpdf` and DOCX uses `mammoth` through `parseNativeFileDocument`. Decompression uses `node:zlib`.
- One click to approve and no Continue step (`MEMORY: feedback_one_click_approvals`). Details are collapsed by default.
- DESIGN.md rules apply. Flat surfaces, no nested cards (:48). Approvals scale with risk: "Turn on Code Mode and run" is the danger style with a shield icon, and Deny is neutral secondary (:60). Hashes and IDs appear only in `TechnicalDetails` (:71). No modals for tasks that need no interruption (:113).
- Do not edit `config/*.json` (the operator's live config). Ship defaults in code and `*.example.json` only.
- Rebuild `@goatcitadel/contracts` after changing it (`pnpm --filter @goatcitadel/contracts build`), because gateway, policy-engine and mission-control-next tests read its dist.
- Tests run with `--maxWorkers=2`, one heavy job at a time. Never `git stash`. Run prettier only on files you changed. Do the work in a worktree. Another session is building Capabilities hub Phase 4 in `capabilities` files, so rebase before each commit that touches `routes/capabilities.ts`.
- Copy strings fixed by this plan:
  - card line: `Run code to {goal}`
  - enable button: `Turn on Code Mode and run`
  - approve button: `Run it`
  - running: `Running code…`
  - done receipt: `Ran code to {goal}`
  - keep button: `Keep as a tool`
  - kept: `Saved as a tool for review`
  - denied: `Not run`

## Review Focus

1. **A grant or bypass profile must not skip the click.** Under `trusted_local_power`, or with an allow grant matching `code_mode.*`, a `code_mode.request` still returns `approval_required`. Test in Task 4.
2. **Approving from Inbox while Code Mode is off.** The operator should get a clean tool error ("Code Mode is off…"), and the turn should resume and say so, not hang in `waiting_for_approval`. Test in Task 4.
3. **Hostile or huge inputs to the helpers:** a path outside the read roots, a 40 MB file, or a decompression bomb. Each should be rejected with a clear error and output capped, never exhausting memory. Tests in Task 1.
4. **Deny or expiry (15 min):** the turn resumes, the model says the code did not run, and the card shows `Not run`. Test in Task 4 (gateway) and Task 6 (card).
5. **Claude Code CLI provider:** the session's provider must see `mcp__goatcitadel__code_mode_request`, and the resumed turn must continue with the tool result. Checked in Task 9 end-to-end, because the CLI loop can't be unit-tested here.

---

### Task 1: Read-only document helpers for Code Mode runs

**Files:**
- Modify: `packages/policy-engine/src/tool-registry.ts` (add three `ToolDefinition`s next to `docs.ingest`)
- Modify: `packages/policy-engine/src/tool-executor/filesystem-executor.ts` (add the `binary` flag to `fsRead`)
- Create: `packages/policy-engine/src/tool-executor/document-helpers-executor.ts`
- Modify: `packages/policy-engine/src/tool-executor.ts` (route `docs.read_bytes|docs.extract_text|docs.decompress`; add the hook `readAttachmentBytes` to `ToolExecutorRuntimeHooks` at :138)
- Modify: `packages/policy-engine/src/native-document-parser.ts` (export `looksBinary`)
- Modify: `packages/contracts/src/tool-groups.ts` (add the three to the group that lists `docs.ingest`)
- Modify: `apps/mission-control-next/src/cockpit/areas/capabilities/tools/tool-labels.ts` (`TOOL_LABELS`)
- Modify: `packages/mission-control-shared/src/components/chat/chat-tool-display-name.ts:34`
- Modify: `apps/gateway/src/services/gateway-service.ts:1472` (wire `readAttachmentBytes`)
- Test: `packages/policy-engine/src/tool-executor-document-helpers.test.ts`; extend `packages/policy-engine/src/tool-registry.test.ts`

**Interfaces:**
- Produces:
  - `docs.read_bytes({ path?: string; attachmentId?: string; maxBytes?: number })` → `{ name: string; sizeBytes: number; sha256: string; base64: string; truncated: boolean }`. The default and maximum for `maxBytes` is `DOCS_READ_BYTES_MAX = 8 * 1024 * 1024`.
  - `docs.extract_text({ path?: string; attachmentId?: string; maxChars?: number })` → `{ name: string; format: "pdf" | "docx" | "text"; pageCount?: number; text: string; truncated: boolean }`. The default for `maxChars` is `DOCS_EXTRACT_TEXT_MAX_CHARS = 200_000`.
  - `docs.decompress({ base64: string; format: "gzip" | "deflate" | "raw-deflate" | "brotli"; maxOutputBytes?: number })` → `{ base64: string; outputBytes: number }`. The default and maximum for `maxOutputBytes` is `DOCS_DECOMPRESS_MAX_OUTPUT = 16 * 1024 * 1024`.
  - `fs.read` adds `binary: true` and `content: ""` when `looksBinary(bytes)`, plus `hint: "Binary file. Inside Code Mode use docs.extract_text or docs.read_bytes."`.
  - Hook: `readAttachmentBytes?: (request: ToolInvokeRequest, attachmentId: string) => Promise<{ fileName: string; mimeType: string; bytes: Buffer }>`.
- All three definitions: `readOnly: true`, `deterministic: true`, `codeModeAllowed: true`, `riskLevel: "safe"`, `requiresApproval: false`, `recommendedContexts: []`. Keep them out of normal chat exposure (that belongs to the PDF plan).

- [ ] **Step 1: Write the failing tests** in `tool-executor-document-helpers.test.ts`:
  - `extracts PDF text through docs.extract_text`: use the fixture PDF from `document-pdf.test.ts`. Expect `format: "pdf"`, `pageCount >= 1`, and `text` containing that test's expected phrase.
  - `rejects a path outside read roots`: expect a rejection matching the error from `assertReadPathAllowedForRequest`.
  - `requires exactly one of path or attachmentId`: both given → throws `/exactly one of path or attachmentId/`; neither given → same.
  - `caps docs.read_bytes`: a 9 MB file → `truncated: true` and `Buffer.from(base64,"base64").length === DOCS_READ_BYTES_MAX`.
  - `stops a decompression bomb`: gzip 64 MB of zeros, then call with `maxOutputBytes: 1024` → throws `/exceeds 1024 bytes/`. Implement with `zlib.gunzipSync(buf, { maxOutputLength })`.
  - `reads an attachment through the gateway hook`: a stub `readAttachmentBytes` returns the PDF bytes → text extracted, with the stub called once with `"att_1"`.
  - `fs.read flags binary files`: reading the PDF fixture → `binary: true`, `content: ""`.
  - In `tool-registry.test.ts`: `document helpers are Code Mode-allowed and read-only`, asserting the three flags for each name.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/policy-engine exec vitest run src/tool-executor-document-helpers.test.ts src/tool-registry.test.ts --maxWorkers=2`. Expected: FAIL (unknown tools).
- [ ] **Step 3: Implement** `executeDocumentHelperTool(request, config, storage, deps): Promise<Record<string, unknown>>` in `document-helpers-executor.ts`. Resolve the bytes with `assertReadPathAllowedForRequest` for `path`, or with `runtimeHooks.readAttachmentBytes` for `attachmentId`. When the hook is missing, throw `"Attachments are not readable here."`. Use `parseNativeFileDocument(name, bytes)` for extraction. Add the registry entries, the group membership, the labels and the display names. In the gateway, `readAttachmentBytes` must load the attachment through `storage.chatAttachments`, check that its session equals `request.sessionId`, and read the stored bytes.
- [ ] **Step 4: Run** the same command, then `pnpm --filter @goatcitadel/contracts build` and `pnpm --filter @goatcitadel/policy-engine exec vitest run src/tool-groups-registry.test.ts --maxWorkers=2` and `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/capabilities/tools/tool-labels.test.ts --maxWorkers=2`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(code-mode): read-only document helpers for runs`.

### Task 2: Turn Code Mode and its Windows sandbox on at runtime, plus a readiness check

**Files:**
- Modify: `apps/gateway/src/services/gateway/feature-flags.ts` (add `codeModeHostSandboxEnabled` beside `codeModeV1Enabled` at :20 and :114)
- Modify: `apps/gateway/src/services/gateway/runtime-settings.ts:124`, `apps/gateway/src/config.ts` (`FeatureFlagsConfig`, default `false`), `apps/gateway/src/routes/dashboard.ts:246` (zod)
- Modify: `apps/gateway/src/services/capability-system-service.ts` (`resolveCurrentSandboxMetadata` at :491, the run paths at :4059 and :4150; add `getCodeModeReadiness`)
- Modify: `apps/gateway/src/routes/capabilities.ts` (new route)
- Modify: `packages/contracts/src/capabilities.ts` (`CodeModeReadiness`)
- Test: `apps/gateway/src/services/capability-system-service.code-mode-readiness.test.ts`; extend the feature-flags test file beside `feature-flags.ts`

**Interfaces:**
- Produces:
  - `interface CodeModeReadiness { enabled: boolean; sandboxEnabled: boolean; sandboxSupported: boolean; canRun: boolean; reason?: "code_mode_off" | "sandbox_off" | "sandbox_unsupported" }`
  - `CapabilitySystemService.getCodeModeReadiness(): Promise<CodeModeReadiness>`
  - `GET /api/v1/code-mode/readiness` returns 200 with `CodeModeReadiness`, behind the same auth as `GET /api/v1/code-mode/execution-backends`
  - `private readEffectiveSandboxConfig(): Promise<CapabilityRuntimeConfig["codeModeSandbox"]>`, which returns `runtimeConfig.codeModeSandbox` with `bestEffortHostEnabled` overridden by the stored `codeModeHostSandboxEnabled` when that value is set
- `sandboxSupported` comes from the host adapter probe. On win32 that is `isAppContainerCapable(osRelease)` plus a PowerShell path.

- [ ] **Step 1: Write the failing tests:**
  - `readiness reports code_mode_off by default`: expect `{ enabled:false, canRun:false, reason:"code_mode_off" }`.
  - `stored host-sandbox flag overrides config at run time`: config `bestEffortHostEnabled:false`, stored flag `true`, `readFeatureFlags` codeMode true, adapter supported → `canRun:true`. Then flip the stored flag to `false` without rebuilding the service → `reason:"sandbox_off"`. This proves the value is read live.
  - `unsupported host never reports canRun`: adapter unsupported plus both flags true → `reason:"sandbox_unsupported"`.
  - Feature flags: `codeModeHostSandboxEnabled patch merges and defaults to false`.
- [ ] **Step 2: Run** `pnpm --dir apps/gateway exec vitest run src/services/capability-system-service.code-mode-readiness.test.ts src/services/gateway/feature-flags.test.ts --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement.** Thread the stored flag through `readFeatureFlags`. Replace every direct read of `this.options.runtimeConfig.codeModeSandbox` in the run paths with `await this.readEffectiveSandboxConfig()`. Add the route and contract type. Update the `codeModeSandbox` comment in `config/goatcitadel.example.json` and `config/assistant.config.example.json` (example files only) to say it can also be switched at runtime.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @goatcitadel/contracts build` and `pnpm verify:code-mode:sandbox`. Expected: PASS. The sandbox lane must still show fail-closed when the flag is off.
- [ ] **Step 5: Commit** `feat(code-mode): runtime host-sandbox switch and readiness route`.

### Task 3: Run an already-approved Code Mode request

**Files:**
- Modify: `apps/gateway/src/services/capability-system-service.ts` (new public method; extract the shared execution core from `executeApprovedCodeModeRun` at :2458)
- Modify: `packages/contracts/src/capabilities.ts` (`CodeModeRunRecord.approvalSource?`)
- Test: `apps/gateway/src/services/capability-system-service.approved-request.test.ts`

**Interfaces:**
- Consumes: `getCodeModeReadiness()` (Task 2); the helpers in the wrapper manifest (Task 1)
- Produces:

```ts
interface ApprovedCodeModeRequest {
  approvalId: string;           // the code_mode.request tool approval
  approvedSourceSha256: string; // sha256 of args.source as stored in the pending action
  goal: string;
  language: "javascript" | "typescript";
  source: string;
  input?: Record<string, unknown>;
  sessionId: string;
  turnId: string;
  workspaceId?: string;
  policyContext: ToolPolicyActorContext;
}
interface ApprovedCodeModeResult {
  runId: string;
  status: "completed" | "failed";
  result?: unknown;             // guest return value, JSON-safe, capped at 64 KB serialized
  stdoutPreview?: string;
  stderrPreview?: string;
  error?: string;
  durationMs: number;
}
public async runApprovedCodeModeRequest(request: ApprovedCodeModeRequest, signal?: AbortSignal): Promise<ApprovedCodeModeResult>
```

- [ ] **Step 1: Write the failing tests:**
  - `runs approved source and returns the guest result`: source `return { pages: 3 };` → `status:"completed"`, `result` deep-equals `{ pages: 3 }`. The run record has `approvalSource: { kind: "code_mode.request", approvalId }`, and its stored `codeHash` equals `sha256(source)`.
  - `refuses when the approved hash does not match the source`: `approvedSourceSha256` of a different string → throws `/does not match the approved code/`, and no run is executed.
  - `refuses when Code Mode cannot run`: readiness `reason:"code_mode_off"` → throws `/Code Mode is off/`. For `sandbox_off`/`sandbox_unsupported` → `/sandbox/`.
  - `does not post the separate final transcript message`: `enqueueCodeModeFinalTranscript` spy not called for this path, while the existing `executeApprovedCodeModeRun` path still calls it (regression).
  - `guest can call docs.extract_text`: source `return await capabilities["docs.extract_text"]({ path: input.path });` with the PDF fixture → `result.format === "pdf"`. Use whatever accessor form the wrapper manifest actually generates, and assert that exact form.
  - `caps a huge return value`: guest returns a 1 MB string → `result` is `{ truncated: true, preview: <first 64 KB> }`.
- [ ] **Step 2: Run** `pnpm --dir apps/gateway exec vitest run src/services/capability-system-service.approved-request.test.ts --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `validateGuestSource`, artifact persistence, hashing, the catalog snapshot and the policy snapshot from `createCodeModeRun` (:1855). Do not create a second approval. Record the run with `approvalSource`, then call the extracted core (claim, hash re-check, execute through `executeGovernedChildHarness`, record output, finish claim) shared with `executeApprovedCodeModeRun`. Skip `stageCandidateBundle` and the final transcript.
- [ ] **Step 4: Run** the Step 2 command plus the existing Code Mode service tests: `pnpm --dir apps/gateway exec vitest run src/services/capability-system-service --maxWorkers=2`. Expected: PASS. Re-run a timed-out Code Mode test on its own before treating it as a failure (see MEMORY "capability suite Code Mode load timeouts").
- [ ] **Step 5: Commit** `feat(code-mode): execute a run bound to an approved chat request`.

### Task 4: The `code_mode.request` tool

**Files:**
- Modify: `packages/policy-engine/src/tool-registry.ts` (`CODE_MODE_REQUEST_TOOL_NAME = "code_mode.request"` beside `CHANGE_REQUEST_TOOL_NAME` at :40; definition modeled on `change.request` at :196)
- Modify: `packages/policy-engine/src/tool-executor.ts` (case next to `CHANGE_REQUEST_TOOL_NAME` at :406; hook `runCodeModeRequest`)
- Modify: `packages/policy-engine/src/engine.ts` (always require approval at ~:1410; stamp `approvedByApprovalId` before `executeTool` at :2372)
- Modify: `packages/contracts/src/policy.ts:436` (`ToolInvokeRequest.approvedByApprovalId?: string`, engine-owned), `packages/contracts/src/tool-groups.ts` (core group)
- Modify: `apps/gateway/src/services/gateway-service.ts:1472` (wire the hook)
- Modify: `apps/gateway/src/services/chat-turn-agent-runner.ts` (`buildEssentialToolSet` :10043, `buildToolAccessProbeArgs` :10151)
- Modify: `apps/gateway/src/services/base-agent-system-prompt.ts` (volatile, conditional line like `change.request` at :175)
- Modify: `apps/gateway/src/services/chat-turn-user-message.ts:91` (unreadable-attachment line)
- Modify: tool labels and display names (same files as Task 1); `docs/1_0_CONTRACT.md:74`
- Test: `packages/policy-engine/src/tool-executor-code-mode-request.test.ts`, `packages/policy-engine/src/engine.code-mode-request.test.ts`, `apps/gateway/src/services/chat-code-mode-request.integration.test.ts`; extend `base-agent-system-prompt.test.ts`, `chat-turn-agent-runner.tool-budget.test.ts`, `chat-turn-user-message.test.ts`

**Interfaces:**
- Consumes: `runApprovedCodeModeRequest` (Task 3), `getCodeModeReadiness` (Task 2)
- Produces:
  - Tool args schema (`required: ["goal","source"]`, `additionalProperties: false`):
    - `goal`: string, 1–120 chars, a plain verb phrase shown to the operator, e.g. `"read the text of saturday-plan.pdf"`
    - `source`: string, max 20 000 chars
    - `language`: `"javascript"` (default) | `"typescript"`
    - `input`: object; file paths and values go here so the code can be kept
    - `reads`: string[], at most 10; paths and attachment IDs shown in the details
  - Tool result: the `ApprovedCodeModeResult` from Task 3, minus nothing.
  - Hook: `runCodeModeRequest?: (request: ToolInvokeRequest) => Promise<Record<string, unknown>>`.
  - Definition: `category: "ops"`, `riskLevel: "caution"`, `requiresApproval: true`, `recommendedContexts: ["chat"]`, `codeModeAllowed: false`. `usageHints` (two lines):
    - "Use only when no available tool can do a step, such as reading a binary file. Put paths and values in `input`, return the answer, and keep the script short."
    - "Inside the script call helpers as `<accessor form from Task 3>` (docs.extract_text, docs.read_bytes, docs.decompress, fs.read, fs.list)."
  - Prompt line (volatile, only when the toolset has `code_mode.request`): `- When no available tool can do a needed step, call code_mode.request with a short goal and script instead of saying you can't. The operator approves it with one click and you continue with the result.`
  - Attachment prompt line for an attachment with no preview: `Preview: not extracted. attachmentId: {id}. Code Mode can read it with docs.extract_text({ attachmentId }).`

- [ ] **Step 1: Write the failing tests:**
  - Engine: `code_mode.request always needs approval`. It returns `approval_required` under three conditions: the `safe` profile, `trusted_local_power`, and an allow grant `code_mode.*` (Review Focus 1).
  - Engine: `stamps approvedByApprovalId only on approved execution`. A caller-supplied `approvedByApprovalId` is stripped on `invoke`. After `executeApprovedAction(id)`, the executor sees `approvedByApprovalId === id`.
  - Executor: `refuses without an approval id` → throws `/requires an operator approval/`. `calls runCodeModeRequest when approved`: the hook stub is called once and its result is returned.
  - Gateway hook (integration):
    - `executes approved request`. The hook loads the approval (`kind === "code_mode.request"`, `status === "approved"`, `resolvedBy` set), computes `approvedSourceSha256` from the pending action's stored args, and returns a `status:"completed"` result. The waiting turn's `code_mode.request` tool run is patched `executed`, and a `linked_chat_turn_wake` is queued. This is the existing `tool.invoke` path; assert it, don't build it.
    - `Code Mode off when approved from Inbox` → the tool run is `failed` with error `"Code Mode is off. Turn it on from the card in Chat or in Settings, then ask again."`, and the turn still wakes (Review Focus 2).
    - `deny resumes the turn` and `expiry resumes the turn` → the tool run is `blocked` with `Not run` and the turn wakes (Review Focus 4).
  - Runner: `exposes code_mode.request as essential in chat when Code Mode can run or can be turned on`. The tool is exposed when readiness `canRun` is true, or when `reason` is `code_mode_off`/`sandbox_off` for an operator-authenticated session. It is not exposed for `sandbox_unsupported`, companion, a2a or delegated-child sessions, or `effectiveToolAutonomy === "manual"`. Update the `toHaveLength(8)` assertion only if the total count changes. It should not, because essentials count toward the cap.
  - Prompt: `offers code_mode.request only when it is in the toolset` (`volatileTail` contains or does not contain the line). The existing `stablePrefix` byte-identity test still passes.
  - Attachment line: `an unreadable attachment names its id and docs.extract_text`.
- [ ] **Step 2: Run** the new and extended test files with `--maxWorkers=2` (policy-engine and gateway commands as above). Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Engine: after `requiresApproval` is computed (~:1410), OR it with `request.toolName === CODE_MODE_REQUEST_TOOL_NAME`. That keeps the tool out of the grant, relief and bypass reliefs. Bypass ids from `getVerifiedApprovalBypassId` must not apply to this tool either; return `undefined` from that branch for it.
  - Probe args: `{ goal: "probe", source: "return null;" }`.
  - Hook: map tool args to `ApprovedCodeModeRequest`. Exposure: read `getCodeModeReadiness()` once per turn in tool-schema preparation.
  - Contract doc :74: append "The assistant can request a run itself with `code_mode.request`; it still needs that explicit operator approval, and the approved code's hash is checked at execution."
- [ ] **Step 4: Run** the Step 2 commands, then `pnpm --filter @goatcitadel/contracts build`, `pnpm verify:gateway:async-boundary` and `pnpm docs:check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): the assistant can request a Code Mode run in the turn`.

### Task 5: The scout triggers on evidence, not keywords

**Files:**
- Modify: `apps/gateway/src/services/chat-capability-scout.ts` (`looksLikeCapabilityGap` :315, the Code Mode fallback :297, `buildCodeModeBuildTitle` :420, `CapabilityScoutInput` :37)
- Modify: `apps/gateway/src/services/gateway-service.ts:8372` (`collectCapabilityUpgradeSuggestions` passes `unreadableAttachments`)
- Test: `apps/gateway/src/services/chat-capability-scout.test.ts`; fixture `apps/gateway/src/services/__fixtures__/scout-saturday-session.ts`

**Interfaces:**
- Produces:
  - `CapabilityScoutInput.unreadableAttachments?: Array<{ fileName: string; mimeType: string }>`
  - `function collectGapEvidence(input: CapabilityScoutInput): GapEvidence | undefined`, where `type GapEvidence = { kind: "binary_read"; ext: string } | { kind: "unreadable_attachment"; ext: string } | { kind: "tool_failed"; toolName: string }`
- Rules:
  - A Code Mode build suggestion needs `collectGapEvidence(input)` and needs the turn to have no `code_mode.request` tool run.
  - Keyword-only `GAP_SIGNAL` text no longer produces a `code_mode_build` suggestion. It still gates the other lanes (enable skill, import, MCP) as today.
  - `ACTION_INTENT` is not required when there is evidence.
  - Title: `binary_read` / `unreadable_attachment` → `Build a tool to read .{ext} files`; `tool_failed` → `Build a tool for what {displayName(toolName)} couldn't do`.

- [ ] **Step 1: Write the failing test** `matches the reviewed Saturday session`. The fixture holds the five turns' `content`, `assistantText` and trace tool runs as recorded (turn 1: 12 browser runs plus `documents.create` executed; turn 2: `fs.read` and `documents.create`; turn 3: `fs.read` executed with `result.binary: true`; turn 4: no tools plus `unreadableAttachments: [{ fileName: "saturday-plan.pdf", mimeType: "application/pdf" }]`; turn 5: no tools). Expected `code_mode_build` titles per turn:

```ts
expect(titles).toEqual([
  [],                                            // turn 1: no false positive
  [],                                            // turn 2: no false positive
  ["Build a tool to read .pdf files"],           // turn 3
  ["Build a tool to read .pdf files"],           // turn 4
  [],                                            // turn 5: no evidence in this turn
]);
```

  Also `no Code Mode suggestion when the turn already ran code_mode.request`. The existing tests at :383 and :560 must still pass; update :383's input to carry `tool_failed` evidence, since it asserted the keyword path.
- [ ] **Step 2: Run** `pnpm --dir apps/gateway exec vitest run src/services/chat-capability-scout.test.ts --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement** the rules above. In the gateway, derive `unreadableAttachments` from the turn's attachments with `extractStatus !== "ready"` that aren't images sent to a vision model.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `fix(chat): offer a Code Mode build only on real evidence of a gap`.

### Task 6: The inline Code Mode card in Cockpit

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/chat/ChatCodeModeRequestCard.tsx`, `ChatCodeModeRequestCard.test.tsx`
- Create: `apps/mission-control-next/src/cockpit/areas/chat/useCodeModeReadiness.ts`
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatTranscriptContent.tsx` (`Turn` :77; render the card after `TurnReceipt` :194, before `ChatTurnDetails` :211)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/ChatBlockers.tsx` (skip approvals whose kind is `code_mode.request`, since the card owns them; pass `specialistEvidence` for `code_mode.run`)
- Modify: `packages/mission-control-shared/src/api/client` (`fetchCodeModeReadiness`)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/chat-vocabulary.ts:171` (`code_mode.request` → "Run code")
- Test: also extend `ChatBlockers.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/code-mode/readiness` (Task 2); the `code_mode.request` tool run in `turn.toolRuns` (Task 4); `ApprovalDecisionBar` with `compact` and `reviewedInPlace`; `readSpecialistEvidence` from `specialist-approval-evidence.ts:43`; the existing settings update client used by Settings for `features`
- Produces: `ChatCodeModeRequestCard(props: { turn: <the turn type that ChatTranscriptContent's Turn already receives>; workspaceId: string; onRefreshThread(): void })`. It renders nothing when the turn has no `code_mode.request` tool run.
- States (one row each, flat, no nested card):

| Tool run state | Row | Actions |
|---|---|---|
| `approval_required`, readiness `canRun` | `Run code to {goal}` | `Run it` (one click), `Deny` |
| `approval_required`, `code_mode_off` / `sandbox_off` | `Run code to {goal}` + muted "Code Mode is off" | `Turn on Code Mode and run` (danger style, shield), `Deny` |
| `approval_required`, `sandbox_unsupported` | `Run code to {goal}` + "This computer can't run Code Mode" | `Deny` only |
| running (approved, not finished) | `Running code…` (spinner, `aria-live="polite"`) | — |
| `executed` | `Ran code to {goal}` · duration | `Keep as a tool` (Task 8) |
| `failed` / `blocked` | `Not run` or the error's first sentence | — |

- A `Details` disclosure (closed by default) shows the `reads` list, `<details>` code preview (`args.source`, monospace, max-height 16 lines with scroll), and `TechnicalDetails` (approval ID, run ID, code hash).

- [ ] **Step 1: Write the failing tests** in `ChatCodeModeRequestCard.test.tsx` (happy-dom, `createRoot`/`act`, `QueryClientProvider`, `vi.mock` for the client):
  - `shows one line and a Run it button`: the text `Run code to read the text of saturday-plan.pdf` is visible, the Details element is closed, and no hash text is visible.
  - `Run it approves once and refreshes`: `resolveApproval` called once with `(approvalId, "approve")`, then `onRefreshThread` called. No confirm dialog opens.
  - `Turn on Code Mode and run enables then approves`: settings update called with `features: { codeModeV1Enabled: true, codeModeHostSandboxEnabled: true }` before `resolveApproval`. If the update returns a pending settings approval, that approval is resolved `approve` in the same click. If the update fails, the approval is not sent and the row shows the error.
  - `unsupported sandbox offers only Deny`.
  - `running then done`: re-render with the tool run `executed` → `Ran code to …`; no `Running code…`.
  - `denied shows Not run`.
  - In `ChatBlockers.test.tsx`: `does not duplicate a code_mode.request approval` and `enables Approve for a code_mode.run once specialist evidence matches` (mock `readSpecialistEvidence`).
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/chat/ChatCodeModeRequestCard.test.tsx src/cockpit/areas/chat/ChatBlockers.test.tsx --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `ApprovalDecisionBar` with `compact` and `reviewedInPlace` for Run it/Deny so the attempt locks and invalidation stay shared. The enable path wraps it: enable, then let the bar approve. Use status-vocabulary presenters for the error text.
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @goatcitadel/mission-control-next typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): one-click Code Mode card in the chat reply`.

### Task 7: Capability suggestions inline in the Cockpit reply

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/chat/ChatCapabilitySuggestionLine.tsx`, `ChatCapabilitySuggestionLine.test.tsx`
- Modify: `ChatTranscriptContent.tsx` (render under `ChatCodeModeRequestCard` for the selected/last turn only)
- Modify: `apps/mission-control-next/src/cockpit/areas/chat/createChatTranscriptProps.ts:360` (pass `capabilitySuggestions`, `onCapabilitySuggestionAction`, `onDismissCapabilitySuggestion` from the existing dock props at `createChatContextDockProps.ts:305`, honoring `blockHistoricalMutation`)

**Interfaces:**
- Consumes: `runCapabilitySuggestionAction` / `handleCapabilitySuggestionAction` / `dismissCapabilitySuggestion` from `useChatSpecialistCapabilityActions.ts:240-491`; confirm copy from `getCapabilitySuggestionConfirmationCopy` (`chat-page-pure-helpers.ts:297`)
- Produces: `ChatCapabilitySuggestionLine(props: { suggestions: ChatCapabilityUpgradeSuggestion[]; onAction(s): void; onDismiss(s): void })`. It shows at most one row: the first suggestion's `title` as a quiet link-styled button, a dismiss "×" (accessible name `Dismiss suggestion: {title}`), and `+N more` that expands the rest. `summary` and `reason` sit behind a `Why?` disclosure. It renders nothing for an empty list.

- [ ] **Step 1: Write the failing tests:** `renders one quiet row for the first suggestion`; `+N more expands the rest`; `clicking the title calls onAction with that suggestion`; `dismiss removes it`; `historical turn renders nothing` (when `blockHistoricalMutation`).
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/chat/ChatCapabilitySuggestionLine.test.tsx --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement** the component and the prop threading.
- [ ] **Step 4: Run** the Step 2 command plus `ChatTranscriptContent`'s existing test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): show capability suggestions in the reply`.

### Task 8: Keep as a tool

**Files:**
- Modify: `apps/gateway/src/services/capability-system-service.ts` (new method; reuse `stageCandidateBundle` at :4640)
- Modify: `apps/gateway/src/routes/capabilities.ts` (new route next to `/promote` :430)
- Modify: `packages/mission-control-shared/src/api/client` (`keepCodeModeRun`)
- Modify: `ChatCodeModeRequestCard.tsx` (the Keep button and its states)
- Test: `apps/gateway/src/services/capability-system-service.keep-run.test.ts`, extend `ChatCodeModeRequestCard.test.tsx`

**Interfaces:**
- Consumes: the run record with `approvalSource.kind === "code_mode.request"` (Task 3); the existing promote route `POST /api/v1/capabilities/candidates/:candidateId/promote` `{ expectedRevision, versionId? }`
- Produces:
  - `CapabilitySystemService.keepCodeModeRunAsCandidate(runId: string, input: { name: string; summary: string }): Promise<{ candidateId: string; versionId: string; revision: number }>`
  - `POST /api/v1/code-mode/runs/:runId/keep`, body `{ name: string (1–60), summary: string (1–200) }`, returns 201 with the result above, behind operator auth
  - `name`/`summary` default from the tool args `goal` (name = goal in title case, cut to 60 chars).
- Rules:
  - Refuse unless the run `status === "completed"` and `approvalSource.kind === "code_mode.request"`; return 409 with `"Only a finished Code Mode run from Chat can be kept."`.
  - Stage from the stored, hash-checked source artifact, never from client text.
  - After staging, the card calls promote. If promote creates a `capability.lifecycle` approval, the card resolves it `approve` in the same click (the button label is the consent). If promote returns a Change Plan, or isn't available, the card shows `Saved as a tool for review` linking to Capabilities.

- [ ] **Step 1: Write the failing tests:**
  - `keeps a finished chat run as a candidate`: the candidate's `program.js` sha256 equals the run's `codeHash`, and `sourceKind:"code_mode_generated"`.
  - `refuses a failed run` (409); `refuses a run without a chat approval source` (409).
  - Card: `Keep as a tool stages, then promotes in one click`; `shows Saved as a tool for review when promote returns a change plan`.
- [ ] **Step 2: Run** `pnpm --dir apps/gateway exec vitest run src/services/capability-system-service.keep-run.test.ts --maxWorkers=2` and the card test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat(code-mode): keep a chat run as a reusable tool`.

### Task 9: End-to-end proof and visual baselines

**Files:**
- Modify: `scripts/verification/lib/scenarios/visual-regression-lane.mjs` (add a `chat-code-mode-card` scenario: the pending, enable and done states, desktop and mobile, light and dark)
- Modify: `apps/mission-control-next/src/__testbench__/catalog/approvals.ts` (seed a `code_mode.request` approval)
- No product code; fix forward in the owning task's files if something fails.

- [ ] **Step 1: Bring up the sandbox.** Start a throwaway token-mode gateway on 18787 with a scratch root, home and backups, keychain off (MEMORY "Token-mode live sandbox"), with Code Mode off in its scratch config. Run the worktree's Vite as a background job and open the browser pane by URL.
- [ ] **Step 2: Replay the session** on the Claude Code CLI provider: send the Saturday prompt, then "Can you use the design skill and put your findings into a pdf?", then "Please review it before sending to me." Expected:
  - (a) Turn 3 shows one row `Run code to …saturday-plan.pdf…` with `Turn on Code Mode and run`.
  - (b) After one click, the row goes `Running code…` → `Ran code to …`.
  - (c) The same turn's reply quotes real text from the PDF (for example its `Timeline` heading) and reviews it.
  - (d) No separate "code-mode-final" message.
  - (e) No Code Mode suggestion row on turns 1–2.
  - (f) `Keep as a tool` → `Saved as a tool for review` or a promoted tool.
  - Record screenshots.
- [ ] **Step 3: Upload the PDF** in a new turn ("review this"). Expected: the model calls `docs.extract_text({ attachmentId })` inside one Code Mode run and reviews the text.
- [ ] **Step 4: Deny path.** Ask again and click Deny. Expected: `Not run`, and the reply says it did not run the code.
- [ ] **Step 5: Run** `pnpm verify:visual:rebaseline` for the new scenario, then `pnpm verify:visual:regression`. Remember the rebaseline is all-or-nothing (MEMORY). Then run `pnpm verify:fast`, `pnpm verify:code-mode:sandbox`, `pnpm verify:agentic:governance` and `git diff --check`. Expected: all green.
- [ ] **Step 6: Commit** `test(chat): end-to-end and visual proof for Code Mode in the turn`.
