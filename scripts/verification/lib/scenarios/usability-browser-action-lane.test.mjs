import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BROWSER_ACTION_BUNDLES,
  BROWSER_ACTION_STEP_REGISTRY,
  validateBrowserActionTerminalEvidenceContract,
} from "./usability-browser-action-registry.mjs";
import {
  buildDelegationPromptReplyRules,
  buildPromptPackBenchmarkReplyRules,
  decodeBrowserFixtureFile,
  editableLocator,
  evaluateSseConnectionRecovery,
  filterExpectedBrowserConsoleMessages,
  pollSseConnectionRecoveryEvidence,
  pollResolvedBlockerEvidence,
  prepareCodeModeVerificationProject,
  resolveNotificationArchiveFixture,
  resolveSelectOption,
  resolveThreadDurableCorrelation,
  resolveUniqueEditableLocatorCandidate,
  startSettingsBrowserFixtureServer,
  USABILITY_BROWSER_ACTION_GATEWAY_ENV,
  USABILITY_LOCAL_MCP_POLICY,
  validatePersistedAgentDefaultTools,
  validatePromptPackBenchmarkDispatchRecords,
  validatePromptPackBenchmarkStatus,
  validatePromptPackRunAllStatus,
  validateAttachedDurableWatcher,
  validateBrowserDownloadEvidence,
  validateCanonicalChatAttachmentProjection,
  validateCanonicalChatAttachmentRecords,
  validateCanonicalChatUrlSource,
  validateCodeModeArtifactEvidence,
  validateCompletedCodeModeRun,
  validateCompletedDelegationFanIn,
  validateDurableRunCorrelation,
  validateResolvedBlockerCapabilityProfile,
  validateResolvedBlockerEvidence,
  validateUniversalRunDetailTrace,
  validateVerifiedCodeModeNamedProof,
  withOperatorAuth,
} from "./usability-browser-action-lane.mjs";

function strictEditableCandidate(states) {
  let stateIndex = 0;
  let nthCalls = 0;
  const controls = [{ value: "" }, { value: "" }];
  const current = () => states[Math.min(stateIndex, states.length - 1)];
  const candidate = {
    async count() {
      return current().count;
    },
    async evaluate(predicate) {
      const state = current();
      if (state.count !== 1) throw new Error(`strict locator matched ${state.count} controls`);
      const node = {
        tagName: state.tagName ?? "INPUT",
        getAttribute(name) {
          if (name === "role") return state.role ?? null;
          if (name === "contenteditable") return state.contenteditable ?? null;
          return null;
        },
      };
      return predicate(node);
    },
    async isVisible() {
      const state = current();
      if (state.count !== 1) throw new Error(`strict locator matched ${state.count} controls`);
      return state.visible !== false;
    },
    async fill(value) {
      const state = current();
      if (state.count !== 1) throw new Error(`strict locator matched ${state.count} controls`);
      controls[0].value = value;
    },
    nth() {
      nthCalls += 1;
      throw new Error("strict editable resolution must not construct an ordinal locator");
    },
  };
  return {
    candidate,
    controls,
    advance() {
      stateIndex = Math.min(stateIndex + 1, states.length - 1);
    },
    replaceState(state) {
      states[stateIndex] = state;
    },
    nthCalls() {
      return nthCalls;
    },
  };
}

function strictEditablePage(model) {
  const labelCalls = [];
  return {
    labelCalls,
    getByLabel(label, options) {
      labelCalls.push({ label, options });
      return model.candidate;
    },
    getByPlaceholder() {
      throw new Error("editable resolution must not fall back to placeholder matching");
    },
    async waitForTimeout() {
      model.advance();
    },
  };
}

test("editable locator waits for an exact accessible label without consulting a fuzzy or placeholder fallback", async () => {
  const model = strictEditableCandidate([{ count: 0 }, { count: 0 }, { count: 1, tagName: "INPUT" }]);
  const page = strictEditablePage(model);
  const locator = await editableLocator(page, "New workspace name", { timeoutMs: 100, pollIntervalMs: 1 });
  assert.equal(locator, model.candidate);
  assert.deepEqual(page.labelCalls, [{ label: "New workspace name", options: { exact: true } }]);
  assert.equal(model.nthCalls(), 0);
});

test("editable locator waits for an exact hidden control to become visible", async () => {
  const model = strictEditableCandidate([
    { count: 1, tagName: "INPUT", visible: false },
    { count: 1, tagName: "INPUT", visible: false },
    { count: 1, tagName: "INPUT", visible: true },
  ]);
  const locator = await editableLocator(strictEditablePage(model), "New workspace name", {
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.equal(locator, model.candidate);
  assert.equal(model.nthCalls(), 0);
});

test("editable locator fails closed for duplicate exact accessible labels", async () => {
  const model = strictEditableCandidate([{ count: 2, tagName: "INPUT" }]);
  await assert.rejects(
    editableLocator(strictEditablePage(model), "Name", { timeoutMs: 100, pollIntervalMs: 1 }),
    /ambiguous editable control: Name matched 2 controls by exact accessible label/u,
  );
  assert.equal(model.nthCalls(), 0);
});

test("editable locator fails closed when the exact accessible label names a noneditable control", async () => {
  const model = strictEditableCandidate([{ count: 1, tagName: "DIV" }]);
  await assert.rejects(
    editableLocator(strictEditablePage(model), "Name", { timeoutMs: 100, pollIntervalMs: 1 }),
    /exact accessible label does not identify an editable control: Name/u,
  );
  assert.equal(model.nthCalls(), 0);
});

test("editable locator returns a strict base locator that rejects a duplicate inserted before fill", async () => {
  const model = strictEditableCandidate([{ count: 1, tagName: "INPUT" }]);
  const locator = await editableLocator(strictEditablePage(model), "Name", { timeoutMs: 100, pollIntervalMs: 1 });
  model.replaceState({ count: 2, tagName: "INPUT" });
  await assert.rejects(locator.fill("wrong target"), /strict locator matched 2 controls/u);
  assert.deepEqual(
    model.controls.map((control) => control.value),
    ["", ""],
  );
  assert.equal(model.nthCalls(), 0);
});

test("exact editable candidate resolution returns the strict base locator without nth selection", async () => {
  const model = strictEditableCandidate([{ count: 1, tagName: "TEXTAREA" }]);
  assert.equal(await resolveUniqueEditableLocatorCandidate(model.candidate, "Description"), model.candidate);
  assert.equal(
    await resolveUniqueEditableLocatorCandidate(strictEditableCandidate([{ count: 0 }]).candidate, "Missing field"),
    undefined,
  );
  assert.equal(model.nthCalls(), 0);
});

test("browser action registry fails closed without terminal readback or a verified download", () => {
  for (const step of Object.values(BROWSER_ACTION_STEP_REGISTRY)) {
    assert.equal(validateBrowserActionTerminalEvidenceContract(step), true);
  }

  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unverified-mutation",
        operations: [{ kind: "click", name: "Save", exact: true }],
      }),
    /instead of a terminal UI\/API readback/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unverified-download",
        operations: [
          { kind: "click", name: "Download report", exact: true },
          { kind: "assert-text", value: "Downloaded" },
        ],
      }),
    /must observe and validate the Playwright download/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unapproved-exemption",
        operations: [{ kind: "click", name: "Save", exact: true }],
        terminalEvidenceExemption: "No readback exists.",
      }),
    /unapproved terminal-evidence exemption/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unbound-download",
        operations: [{ kind: "download", name: "Download", exact: true }],
      }),
    /requires exactly one expected filename selector/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unverified-download-content",
        operations: [{ kind: "download", name: "Download", exact: true, expectedFileName: "report.json" }],
      }),
    /requires a SHA-256 or approved content contract/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unapproved-download-content",
        operations: [
          {
            kind: "download",
            name: "Download",
            exact: true,
            expectedFileName: "report.json",
            contentContract: "looks-like-json",
          },
        ],
      }),
    /unapproved content contract/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unbounded-operation",
        operations: [{ kind: "assert-text", value: "eventually", timeoutMs: 120_001 }],
      }),
    /invalid operation timeout/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.unbound-blueprint",
        operations: [
          {
            kind: "download",
            name: "Download blueprint",
            exact: true,
            expectedFileName: "fixture-blueprint.json",
            contentContract: "citadel-blueprint-v1",
          },
        ],
      }),
    /requires the exact fixture purpose/u,
  );
  assert.throws(
    () =>
      validateBrowserActionTerminalEvidenceContract({
        stepId: "route.example.invalid-capture",
        operations: [
          {
            kind: "click",
            name: "Start",
            captureJsonResponse: { method: "POST", pathPattern: "[", status: 200 },
          },
          { kind: "assert-text", value: "Done" },
        ],
      }),
    /invalid JSON response capture/u,
  );
});

test("notification archive journey ends with an archive-bound canonical readback and access denial", () => {
  const notificationStep = BROWSER_ACTION_BUNDLES["ops-governance-reliability"].find(
    (step) => step.stepId === "route.ops-notifications.notification-test-and-operator-policy",
  );
  assert.deepEqual(notificationStep?.operations.slice(-4), [
    { kind: "click-pattern", namePattern: "Archive notification rule Usability notification rule" },
    { kind: "api", probe: "notification-rule-archive-readback" },
    { kind: "click-pattern", namePattern: "Archive notification destination Usability notification destination" },
    { kind: "api", probe: "notification-archive-and-non-operator-denial" },
  ]);
});

test("verified browser downloads bind safe filenames, nonempty bytes, and SHA-256", () => {
  const bytes = Buffer.from("isolated upload fixture", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(
    validateBrowserDownloadEvidence(
      { expectedFileName: "usability-upload.txt", expectedSha256: sha256 },
      "usability-upload.txt",
      bytes,
    ),
    { fileName: "usability-upload.txt", sizeBytes: bytes.length, sha256 },
  );
  const diagnostics = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-07-30T09:00:00.000Z",
      workspaceId: "workspace-1",
      sourceStatus: { health: { status: "ok" }, daemon: { status: "ok" } },
      daemonLogs: [],
      daemonDiagnostics: [],
    })}\n`,
    "utf8",
  );
  assert.equal(
    validateBrowserDownloadEvidence(
      { expectedFileNamePattern: "^[a-z-]+\\.json$", contentContract: "ops-diagnostics-v1" },
      "ops-diagnostics.json",
      diagnostics,
      { workspaceId: "workspace-1" },
    ).contentContract,
    "ops-diagnostics-v1",
  );
  assert.throws(
    () => validateBrowserDownloadEvidence({ expectedFileName: "expected.txt" }, "other.txt", bytes),
    /filename mismatch/u,
  );
  assert.throws(
    () => validateBrowserDownloadEvidence({ expectedFileName: "empty.txt" }, "empty.txt", Buffer.alloc(0)),
    /contained no bytes/u,
  );
  assert.throws(
    () => validateBrowserDownloadEvidence({ expectedFileName: "unsafe.txt" }, "..\\unsafe.txt", bytes),
    /unsafe filename/u,
  );
  assert.throws(
    () => validateBrowserDownloadEvidence({ expectedFileName: "unsafe.txt" }, "../unsafe.txt", bytes),
    /unsafe filename/u,
  );
  assert.throws(() => validateBrowserDownloadEvidence({ expectedFileName: "." }, ".", bytes), /unsafe filename/u);
  assert.throws(
    () => validateBrowserDownloadEvidence({ expectedFileName: "unsafe.txt" }, "unsafe\u0000.txt", bytes),
    /unsafe filename/u,
  );
  assert.throws(
    () =>
      validateBrowserDownloadEvidence(
        { expectedFileName: "hash.txt", expectedSha256: "0".repeat(64) },
        "hash.txt",
        bytes,
      ),
    /SHA-256 mismatch/u,
  );
  assert.throws(
    () =>
      validateBrowserDownloadEvidence(
        { expectedFileName: "ops.json", contentContract: "ops-diagnostics-v1" },
        "ops.json",
        Buffer.from("{}\n", "utf8"),
        { workspaceId: "workspace-1" },
      ),
    /wrong schemaVersion/u,
  );
  assert.throws(
    () =>
      validateBrowserDownloadEvidence(
        { expectedFileName: "too-large.bin" },
        "too-large.bin",
        Buffer.alloc(16 * 1024 * 1024 + 1),
      ),
    /exceeded/u,
  );
});

test("typed Citadel Blueprint downloads retain fixture identity and portable structure", () => {
  const operation = {
    expectedFileName: "personal-blueprint.json",
    contentContract: "citadel-blueprint-v1",
    expectedBlueprintPurpose: "Govern the isolated Chromium Citadel journey.",
  };
  const blueprint = {
    schemaVersion: "goatcitadel.blueprint.v1",
    metadata: { name: "Govern the isolated Chromium Citadel journey." },
    charter: { purpose: "Govern the isolated Chromium Citadel journey." },
    chambers: [{ name: "General", sensitivity: "internal", sealed: false }],
    riskNotes: ["Structure only."],
  };
  assert.equal(
    validateBrowserDownloadEvidence(
      operation,
      "personal-blueprint.json",
      Buffer.from(JSON.stringify(blueprint), "utf8"),
    ).contentContract,
    "citadel-blueprint-v1",
  );
  assert.throws(
    () =>
      validateBrowserDownloadEvidence(
        operation,
        "personal-blueprint.json",
        Buffer.from(JSON.stringify({ ...blueprint, metadata: { name: "Wrong" } }), "utf8"),
      ),
    /exact Citadel fixture/u,
  );
  assert.throws(
    () =>
      validateBrowserDownloadEvidence(
        operation,
        "personal-blueprint.json",
        Buffer.from(JSON.stringify({ ...blueprint, citadelId: "secret-identity" }), "utf8"),
      ),
    /non-portable identity/u,
  );
});

test("notification archive readback binds canonical IDs, lifecycleState, and the one exact target link", () => {
  const target = {
    workspaceId: "workspace-1",
    targetId: "target-1",
    label: "Usability notification destination",
    lifecycleState: "archived",
  };
  const rule = {
    workspaceId: "workspace-1",
    ruleId: "rule-1",
    label: "Usability notification rule",
    lifecycleState: "archived",
    targetIds: ["target-1"],
  };
  assert.deepEqual(
    resolveNotificationArchiveFixture([target], [rule], "workspace-1", {
      targetId: "target-1",
      ruleId: "rule-1",
    }),
    { target, rule },
  );
  assert.throws(
    () =>
      resolveNotificationArchiveFixture(
        [{ ...target, lifecycleState: undefined, status: "archived" }],
        [rule],
        "workspace-1",
      ),
    /lifecycleState/u,
  );
  assert.throws(
    () => resolveNotificationArchiveFixture([target], [{ ...rule, targetIds: ["other-target"] }], "workspace-1"),
    /one exact fixture destination/u,
  );
});

test("prompt-pack compare proof classifies exact execution, memory-distiller, and score-judge dispatches", () => {
  const prior = { model: "verification-stub-chat", outcome: "success", status: 200 };
  const executions = ["verification-stub-chat", "verification-stub-chat-alt"].flatMap((model) =>
    Array.from({ length: 2 }, () => ({
      model,
      stream: true,
      messageCount: 4,
      outcome: "success",
      status: 200,
    })),
  );
  const judges = ["verification-stub-chat", "verification-stub-chat-alt"].flatMap((model) =>
    Array.from({ length: 2 }, () => ({
      model,
      stream: false,
      messageCount: 3,
      behavior: "prompt_reply_rule",
      promptReplyRuleId: "prompt-pack-benchmark-judge",
      outcome: "success",
      status: 200,
    })),
  );
  const memoryDistillers = Array.from({ length: 2 }, () => ({
    model: "verification-stub-chat",
    stream: false,
    messageCount: 2,
    behavior: "prompt_reply_rule",
    promptReplyRuleId: "prompt-pack-benchmark-memory-context-distillation",
    outcome: "success",
    status: 200,
  }));
  const benchmarkRecords = [...executions, ...memoryDistillers, ...judges];
  assert.deepEqual(validatePromptPackBenchmarkDispatchRecords([prior, ...benchmarkRecords], 1), {
    dispatchCount: 10,
    executionDispatches: 4,
    memoryDistillerDispatches: 2,
    judgeDispatches: 4,
    models: ["verification-stub-chat", "verification-stub-chat-alt"],
  });
  assert.throws(
    () => validatePromptPackBenchmarkDispatchRecords([...executions, ...judges.slice(0, -1)], 0),
    /prompt-tagged judges/u,
  );
  assert.throws(
    () =>
      validatePromptPackBenchmarkDispatchRecords(
        [...benchmarkRecords, { model: "verification-stub-chat", stream: false, outcome: "success", status: 200 }],
        0,
      ),
    /unclassified provider dispatch/u,
  );
  assert.throws(
    () =>
      validatePromptPackBenchmarkDispatchRecords(
        benchmarkRecords.map((record, index) =>
          index === 0 ? { ...record, outcome: "http_error", status: 500 } : record,
        ),
        0,
      ),
    /did not succeed/u,
  );
});

test("prompt-pack benchmark fixture tags valid score-judge and behavior-preserving memory-distiller replies", () => {
  assert.deepEqual(
    buildPromptPackBenchmarkReplyRules().map((rule) => ({
      ruleId: rule.ruleId,
      marker: rule.userContentIncludes ?? rule.systemContentIncludes,
      markerScope: rule.userContentIncludes ? "user" : "system",
      reply: rule.replyText,
    })),
    [
      {
        ruleId: "prompt-pack-benchmark-judge",
        marker: "Trace summary (metadata only):",
        markerScope: "user",
        reply:
          '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"Deterministic benchmark judge fixture."}',
      },
      {
        ruleId: "prompt-pack-benchmark-memory-context-distillation",
        marker: "You are a context distiller. Only use provided evidence. Return strict JSON. Never invent citations.",
        markerScope: "system",
        reply: "Verification stub reply.",
      },
    ],
  );
});

test("prompt-pack canonical benchmark status binds exact run, matrix, hashes, and four scored rows", () => {
  const status = {
    run: {
      benchmarkRunId: "ppb-00000000-0000-4000-8000-000000000001",
      packId: "pack-1",
      status: "completed",
      testCodes: ["TEST-91", "TEST-92"],
      providers: [
        { providerId: "verification-stub", model: "verification-stub-chat" },
        { providerId: "verification-stub", model: "verification-stub-chat-alt" },
      ],
      executionStyle: "single_turn_harness",
      packContentSha256: "a".repeat(64),
      policyHash: "b".repeat(64),
      testSnapshotSha256: "c".repeat(64),
      startedAt: "2026-07-30T09:00:00.000Z",
      finishedAt: "2026-07-30T09:00:01.000Z",
    },
    progress: { totalItems: 4, completedItems: 4 },
    modelSummaries: ["verification-stub-chat", "verification-stub-chat-alt"].map((model) => ({
      providerId: "verification-stub",
      model,
      total: 2,
      scored: 2,
      runFailures: 0,
      approvalPausedCount: 0,
      noOutputCount: 0,
    })),
  };
  assert.deepEqual(
    validatePromptPackBenchmarkStatus(status, {
      benchmarkRunId: status.run.benchmarkRunId,
      packId: "pack-1",
    }),
    {
      totalItems: 4,
      completedItems: 4,
      models: ["verification-stub-chat", "verification-stub-chat-alt"],
    },
  );
  assert.throws(
    () =>
      validatePromptPackBenchmarkStatus(
        { ...status, progress: { totalItems: 4, completedItems: 3 } },
        { benchmarkRunId: status.run.benchmarkRunId, packId: "pack-1" },
      ),
    /not 4\/4/u,
  );
});

test("prompt-pack run-all status proves the prior two rows and scores settled before the compare baseline", () => {
  const status = {
    run: {
      benchmarkRunId: "ppb-00000000-0000-4000-8000-000000000002",
      packId: "pack-1",
      status: "completed",
      testCodes: ["TEST-91", "TEST-92"],
      providers: [{ providerId: "verification-stub", model: "verification-stub-chat" }],
      executionStyle: "single_turn_harness",
    },
    progress: { totalItems: 2, completedItems: 2 },
    modelSummaries: [
      {
        providerId: "verification-stub",
        model: "verification-stub-chat",
        total: 2,
        scored: 2,
        runFailures: 0,
        approvalPausedCount: 0,
        noOutputCount: 0,
      },
    ],
  };
  assert.deepEqual(
    validatePromptPackRunAllStatus(status, {
      benchmarkRunId: status.run.benchmarkRunId,
      packId: "pack-1",
    }),
    { totalItems: 2, completedItems: 2, models: ["verification-stub-chat"] },
  );
  assert.throws(
    () =>
      validatePromptPackRunAllStatus(
        { ...status, modelSummaries: [{ ...status.modelSummaries[0], scored: 1 }] },
        { benchmarkRunId: status.run.benchmarkRunId, packId: "pack-1" },
      ),
    /did not settle canonically/u,
  );
});

test("skill lifecycle operations await an exact UI and canonical approval/state readback after every request", () => {
  const skillStep = BROWSER_ACTION_BUNDLES["library-catalog-memory"].find(
    (step) => step.stepId === "route.library-skills.skill-inspect-activate-deactivate",
  );
  assert.deepEqual(
    skillStep?.operations.map((operation) => ({
      kind: operation.kind,
      name: operation.name,
      probe: operation.probe,
    })),
    [
      { kind: "fill", name: undefined, probe: undefined },
      { kind: "api", name: undefined, probe: "skill-lifecycle-approval-baseline" },
      { kind: "click", name: "Enable", probe: undefined },
      { kind: "assert-text-pattern", name: undefined, probe: undefined },
      { kind: "api", name: undefined, probe: "skill-lifecycle-enabled-readback" },
      { kind: "click", name: "Sleep", probe: undefined },
      { kind: "assert-text-pattern", name: undefined, probe: undefined },
      { kind: "api", name: undefined, probe: "skill-lifecycle-sleep-readback" },
      { kind: "click", name: "Disable", probe: undefined },
      { kind: "assert-text-pattern", name: undefined, probe: undefined },
      { kind: "api", name: undefined, probe: "skill-lifecycle-disabled-readback" },
    ],
  );
});

test("Settings browser fixtures exercise loopback integration and ntfy sandbox destinations", async () => {
  const fixture = await startSettingsBrowserFixtureServer();
  try {
    const integration = await fetch(`${fixture.baseUrl}/v1/integrations/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "fixture", actionId: "read", input: { marker: "ok" } }),
    });
    assert.equal(integration.status, 200);
    assert.deepEqual(await integration.json(), {
      message: "fixture bridge ok",
      output: { catalogId: "fixture", actionId: "read", input: { marker: "ok" } },
    });

    const ntfy = await fetch(`${fixture.baseUrl}/goatcitadel-verification`, {
      method: "POST",
      body: "GoatCitadel deterministic sandbox notification",
    });
    assert.equal(ntfy.status, 200);
    assert.deepEqual(await ntfy.json(), { id: "verification-ntfy-message", accepted: true });

    const unknown = await fetch(`${fixture.baseUrl}/not-a-fixture-route`);
    assert.equal(unknown.status, 404);
  } finally {
    await fixture.close();
  }
});

test("Code Mode named-proof fixture pins LF-stable repository configuration", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-code-proof-fixture-"));
  try {
    const fixture = await prepareCodeModeVerificationProject(runtimeRoot);
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.autocrlf"], {
        cwd: fixture.absolutePath,
        encoding: "utf8",
      }).trim(),
      "false",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: fixture.absolutePath,
        encoding: "utf8",
      }),
      "",
    );
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

const OPTIONS = Object.freeze([
  { label: "Configured channel", value: "channel_connection" },
  { label: "Keychain HTTPS webhook", value: "https_webhook" },
]);

test("Chromium select operations resolve an explicit option value before any label", () => {
  assert.deepEqual(
    resolveSelectOption(OPTIONS, {
      value: "https_webhook",
      optionLabel: "Configured channel",
    }),
    OPTIONS[1],
  );
});

test("Chromium select operations resolve exact and case-insensitive option labels", () => {
  assert.deepEqual(resolveSelectOption(OPTIONS, { optionLabel: "Keychain HTTPS webhook" }), OPTIONS[1]);
  assert.deepEqual(resolveSelectOption(OPTIONS, { optionLabel: "keychain https WEBHOOK" }), OPTIONS[1]);
  assert.deepEqual(resolveSelectOption(OPTIONS, { option: "Configured channel" }), OPTIONS[0]);
});

test("Chromium select operations fail closed when neither value nor label matches", () => {
  assert.equal(resolveSelectOption(OPTIONS, { value: "missing" }), undefined);
  assert.equal(resolveSelectOption(OPTIONS, { optionLabel: "Missing" }), undefined);
  assert.equal(resolveSelectOption(OPTIONS, {}), undefined);
});

test("browser action pattern helpers retain executable operation kinds", () => {
  const operations = Object.values(BROWSER_ACTION_BUNDLES).flatMap((steps) => steps.flatMap((step) => step.operations));
  const patternKinds = new Set(["click-pattern", "check-pattern", "uncheck-pattern", "assert-checked"]);
  const malformedPatterns = operations.filter(
    (operation) => operation.namePattern && !patternKinds.has(operation.kind),
  );

  assert.deepEqual(malformedPatterns, []);
  assert.ok(operations.some((operation) => operation.kind === "click-pattern"));
  assert.ok(operations.some((operation) => operation.kind === "check-pattern"));
  assert.ok(operations.some((operation) => operation.kind === "uncheck-pattern"));
  assert.ok(operations.some((operation) => operation.kind === "assert-checked" && operation.checked === false));
});

test("General Settings changes interface preferences and proves exact persistence after reload", () => {
  const settingsStep = BROWSER_ACTION_BUNDLES["settings-core-auth-provider"].find(
    (step) => step.stepId === "route.settings-general.interface-preferences-persist-across-reload",
  );
  assert.ok(settingsStep);
  assert.deepEqual(settingsStep.operations, [
    { kind: "select", label: "Display density", optionLabel: "Compact" },
    { kind: "select", label: "Sound cue", optionLabel: "Subtle" },
    { kind: "uncheck-pattern", namePattern: "Show operator attention toasts" },
    { kind: "reload" },
    { kind: "assert-value", label: "Display density", value: "compact" },
    { kind: "assert-value", label: "Sound cue", value: "subtle" },
    { kind: "assert-checked", namePattern: "Show operator attention toasts", checked: false },
  ]);
});

test("desktop Chat edit choreography waits for the retried turn to settle before editing", () => {
  const editStep = BROWSER_ACTION_BUNDLES["chat-lifecycle"].find(
    (step) => step.stepId === "route.chat.edit-and-branch",
  );
  assert.ok(editStep);
  assert.deepEqual(editStep.operations.slice(0, 4), [
    {
      kind: "api",
      probe: "chat-retry-completed",
    },
    {
      kind: "click",
      name: "Open turn: Stop this deterministic usability turn.",
      exact: true,
    },
    {
      kind: "wait-enabled",
      name: "Edit and resend turn ",
      exact: false,
    },
    { kind: "click-pattern", namePattern: "Edit and resend turn " },
  ]);
  assert.equal(
    editStep.operations.some((operation) => operation.kind === "click" && operation.name === "Actions"),
    false,
  );
});

test("Chat attachment journey proves URL, MIME-aware image/audio send, citation, tool event, and canonical state", () => {
  const attachmentStep = BROWSER_ACTION_BUNDLES["chat-lifecycle"].find(
    (step) => step.stepId === "route.chat.attachments-citations-tools",
  );
  assert.ok(attachmentStep);
  assert.deepEqual(attachmentStep.operations.slice(0, 4), [
    { kind: "api", probe: "chat-branch-completed" },
    { kind: "api", probe: "chat-attachment-evidence-seed" },
    { kind: "reload" },
    { kind: "click", name: "Work Record", exact: true },
  ]);
  assert.deepEqual(
    attachmentStep.operations
      .filter((operation) => operation.kind === "file")
      .map(({ fileName, mimeType, encoding }) => ({ fileName, mimeType, encoding })),
    [
      { fileName: "usability-image.png", mimeType: "image/png", encoding: "base64" },
      { fileName: "usability-audio.wav", mimeType: "audio/wav", encoding: "base64" },
    ],
  );
  assert.ok(
    attachmentStep.operations.some(
      (operation) => operation.kind === "assert-image-loaded" && operation.name === "usability-image.png",
    ),
  );
  assert.deepEqual(attachmentStep.operations.slice(-2), [
    { kind: "assert-text", value: "Verification stub reply." },
    { kind: "api", probe: "chat-attachments-canonical" },
  ]);
});

test("Chat-native Build editor journey proves governed launch, approval, artifacts, named proof, and Run Detail", () => {
  const codeStep = BROWSER_ACTION_BUNDLES["chat-agentic-durable-code"].find(
    (step) => step.stepId === "route.chat.code-mode-artifacts",
  );
  assert.ok(codeStep);
  assert.deepEqual(
    codeStep.operations.filter((operation) => operation.kind === "api").map((operation) => operation.probe),
    [
      "arm-code-helper-provider",
      "code-helper-turn-completed",
      "code-mode-helper-approve-complete",
      "code-mode-helper-artifacts",
      "code-mode-helper-proof",
      "capability-catalog-read",
      "code-mode-helper-run-detail",
    ],
  );
  assert.deepEqual(codeStep.operations.slice(0, 4), [
    { kind: "api", probe: "arm-code-helper-provider" },
    {
      kind: "fill",
      label: "Message composer",
      value: "Create a deterministic TypeScript helper snippet.",
    },
    { kind: "click", name: "Send", exact: true },
    { kind: "assert-text", value: "CHAT_CODE_MODE_OK" },
  ]);
  assert.ok(
    codeStep.operations.some(
      (operation) =>
        operation.kind === "click" &&
        operation.name === "Open turn: Create a deterministic TypeScript helper snippet." &&
        operation.exact === true,
    ),
    "the governed helper journey must select the exact code turn before opening its snippet workbench",
  );
  assert.ok(
    codeStep.operations.some(
      (operation) => operation.kind === "assert-text" && operation.value === "Execution: approval_pending",
    ),
  );
  assert.ok(
    codeStep.operations.some(
      (operation) => operation.kind === "assert-text" && operation.value === "Artifact integrity: hashes matched",
    ),
  );
  assert.deepEqual(codeStep.operations.slice(-4), [
    { kind: "click-pattern", namePattern: "Open durable run trace " },
    { kind: "assert-text", value: "Signed evidence receipt" },
    { kind: "assert-text", value: "Timeline" },
    { kind: "api", probe: "code-mode-helper-run-detail" },
  ]);
});

test("browser fixture files decode strict UTF-8 and canonical base64 without MIME loss", () => {
  assert.equal(
    decodeBrowserFixtureFile({
      fileName: "note.txt",
      mimeType: "text/plain",
      encoding: "utf8",
      content: "fixture",
    }).toString("utf8"),
    "fixture",
  );
  assert.deepEqual(
    decodeBrowserFixtureFile({
      fileName: "pixel.png",
      mimeType: "image/png",
      encoding: "base64",
      contentBase64: "iVBORw0KGgo=",
    }),
    Buffer.from("iVBORw0KGgo=", "base64"),
  );
  assert.throws(
    () =>
      decodeBrowserFixtureFile({
        fileName: "bad.wav",
        mimeType: "audio/wav",
        encoding: "base64",
        contentBase64: "not base64",
      }),
    /invalid base64/u,
  );
});

test("canonical Chat attachment validators fail closed on projection, metadata, URL, citation, or tool drift", () => {
  const evidence = {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-evidence",
    citationId: "citation-1",
    toolRunId: "tool-1",
    sourceAttachmentId: "source-1",
    sourceUrl: "https://fixture.example.invalid/usability-attachment-source",
  };
  const expectedAttachments = [
    { fileName: "usability-image.png", mimeType: "image/png", mediaType: "image" },
    { fileName: "usability-audio.wav", mimeType: "audio/wav", mediaType: "audio" },
  ];
  const thread = {
    sessionId: "session-1",
    turns: [
      {
        turnId: "turn-evidence",
        citations: [
          {
            citationId: "citation-1",
            title: "Deterministic attachment citation",
            url: evidence.sourceUrl,
          },
        ],
        toolRuns: [{ toolRunId: "tool-1", toolName: "verification.inspect", status: "executed" }],
      },
      {
        turnId: "turn-attachments",
        trace: { status: "completed" },
        userMessage: {
          content: "Inspect deterministic image and audio attachments.",
          attachments: [
            {
              attachmentId: "attachment-image",
              fileName: "usability-image.png",
              mimeType: "image/png",
              sizeBytes: 68,
            },
            {
              attachmentId: "attachment-audio",
              fileName: "usability-audio.wav",
              mimeType: "audio/wav",
              sizeBytes: 44,
            },
          ],
        },
        assistantMessage: { content: "Verification stub reply." },
      },
    ],
  };
  const projection = validateCanonicalChatAttachmentProjection(thread, {
    evidence,
    expectedAttachments,
    expectedAssistantContent: "Verification stub reply.",
    expectedUserContent: "Inspect deterministic image and audio attachments.",
    sessionId: "session-1",
  });
  assert.equal(projection.attachments.length, 2);
  assert.equal(
    validateCanonicalChatAttachmentRecords(
      [
        {
          attachmentId: "attachment-image",
          sessionId: "session-1",
          fileName: "usability-image.png",
          mimeType: "image/png",
          mediaType: "image",
          sizeBytes: 68,
          sha256: "a".repeat(64),
          storageRelPath: "chat/default/attachments/image.png",
        },
        {
          attachmentId: "attachment-audio",
          sessionId: "session-1",
          fileName: "usability-audio.wav",
          mimeType: "audio/wav",
          mediaType: "audio",
          sizeBytes: 44,
          sha256: "b".repeat(64),
          storageRelPath: "chat/default/attachments/audio.wav",
        },
      ],
      { expectedAttachments, projectedAttachments: projection.attachments, sessionId: "session-1" },
    ),
    true,
  );
  assert.throws(
    () =>
      validateCanonicalChatAttachmentRecords(
        [
          {
            attachmentId: "attachment-image",
            sessionId: "session-1",
            fileName: "usability-image.png",
            mimeType: "image/png",
            mediaType: "image",
            sizeBytes: 68,
            sha256: "a".repeat(64),
            storageRelPath: "chat/default/attachments/image.png",
          },
          {
            attachmentId: "attachment-image",
            sessionId: "session-1",
            fileName: "usability-image.png",
            mimeType: "image/png",
            mediaType: "image",
            sizeBytes: 68,
            sha256: "a".repeat(64),
            storageRelPath: "chat/default/attachments/image.png",
          },
        ],
        { expectedAttachments, projectedAttachments: projection.attachments, sessionId: "session-1" },
      ),
    /reused an attachment identity or file name/u,
  );
  assert.equal(
    validateCanonicalChatUrlSource(
      [
        {
          attachmentId: "source-1",
          sessionId: "session-1",
          sourceType: "url",
          sourceRef: evidence.sourceUrl,
          retrievalMode: "retrieval",
          ingestStatus: "ready",
          chunkCount: 1,
        },
      ],
      evidence,
    ),
    true,
  );
  assert.throws(
    () =>
      validateCanonicalChatAttachmentProjection(
        { ...thread, turns: [{ ...thread.turns[0], toolRuns: [] }, thread.turns[1]] },
        {
          evidence,
          expectedAttachments,
          expectedAssistantContent: "Verification stub reply.",
          expectedUserContent: "Inspect deterministic image and audio attachments.",
          sessionId: "session-1",
        },
      ),
    /tool event is absent/u,
  );
  assert.throws(() => validateCanonicalChatUrlSource([], evidence), /missing, duplicated, or not ready/u);
});

test("Library actions prove uncredentialed Communications and authored Prompt Pack depth", () => {
  const catalogStep = BROWSER_ACTION_BUNDLES["library-catalog-memory"].find(
    (step) => step.stepId === "route.library-agents.agent-default-tool-profile",
  );
  assert.ok(catalogStep);
  assert.deepEqual(catalogStep.operations.slice(-2), [
    {
      kind: "assert-value",
      label: "Default tools",
      value: "fs.read, fs.list",
    },
    { kind: "api", probe: "agent-default-tools-persisted" },
  ]);

  const communicationsSteps = BROWSER_ACTION_BUNDLES["library-content"].filter(
    (step) => step.routeSlug === "library-communications",
  );
  assert.deepEqual(
    communicationsSteps.map((step) => step.stepId),
    [
      "route.library-communications.communication-list-and-agenda",
      "route.library-communications.approval-gated-draft-no-send",
    ],
  );
  assert.deepEqual(communicationsSteps[0].operations.slice(-1), [
    { kind: "api", probe: "communications-uncredentialed-fixture" },
  ]);
  assert.deepEqual(communicationsSteps[1].operations.slice(-2), [
    { kind: "assert-text", value: "approval_required" },
    { kind: "api", probe: "communications-approval-no-send" },
  ]);

  const promptPackSteps = BROWSER_ACTION_BUNDLES["library-content"].filter(
    (step) => step.routeSlug === "library-prompt-packs",
  );
  assert.deepEqual(
    promptPackSteps.map((step) => step.stepId),
    [
      "route.library-prompt-packs.author-edit",
      "route.library-prompt-packs.run-selected-and-all",
      "route.library-prompt-packs.compare-review-export",
    ],
  );
  assert.deepEqual(
    promptPackSteps[0].operations.slice(0, 2).map((operation) => operation.kind),
    ["click-pattern", "fill"],
  );
  assert.equal(promptPackSteps[0].operations.filter((operation) => operation.kind === "fill").length, 2);
  assert.deepEqual(promptPackSteps[1].operations.slice(0, 2), [
    { kind: "click", name: "Run selected", exact: true },
    { kind: "assert-text", value: "Ran TEST-91." },
  ]);
  assert.deepEqual(promptPackSteps[1].operations.slice(-3), [
    {
      kind: "click",
      name: "Run all",
      exact: true,
      captureJsonResponse: {
        method: "POST",
        pathPattern: "^/api/v1/prompt-packs/[^/]+/benchmark/run$",
        status: 200,
        field: "benchmarkRunId",
        valuePattern: "^ppb-[a-f0-9-]{36}$",
        stateKey: "promptPackRunAllBenchmarkRunId",
        expectedBody: {
          allTests: true,
          providers: [{ providerId: "verification-stub", model: "verification-stub-chat" }],
          executionStyle: "single_turn_harness",
        },
      },
    },
    { kind: "assert-text", value: "Benchmark completed 2/2" },
    { kind: "api", probe: "prompt-pack-run-all-canonical-settle" },
  ]);
  assert.deepEqual(promptPackSteps[2].operations.slice(0, 2), [
    { kind: "click-pattern", namePattern: "Advanced quality ops" },
    { kind: "fill", label: "Test codes", value: "TEST-91, TEST-92" },
  ]);
  assert.deepEqual(promptPackSteps[2].operations.slice(3, 7), [
    { kind: "api", probe: "prompt-pack-benchmark-provider-readiness" },
    {
      kind: "click",
      name: "Start benchmark",
      exact: true,
      captureJsonResponse: {
        method: "POST",
        pathPattern: "^/api/v1/prompt-packs/[^/]+/benchmark/run$",
        status: 200,
        field: "benchmarkRunId",
        valuePattern: "^ppb-[a-f0-9-]{36}$",
        stateKey: "promptPackBenchmarkRunId",
        expectedBody: {
          testCodes: ["TEST-91", "TEST-92"],
          providers: [
            { providerId: "verification-stub", model: "verification-stub-chat" },
            { providerId: "verification-stub", model: "verification-stub-chat-alt" },
          ],
          executionStyle: "single_turn_harness",
        },
      },
    },
    { kind: "assert-text", value: "Benchmark completed 4/4", timeoutMs: 120_000 },
    { kind: "api", probe: "prompt-pack-benchmark-provider-dispatch" },
  ]);
  assert.deepEqual(promptPackSteps[2].operations.slice(-2), [
    { kind: "click", name: "Export report", exact: true },
    { kind: "assert-text", value: "Saved prompt-pack log to" },
  ]);

  const vaultStep = BROWSER_ACTION_BUNDLES.citadel.find(
    (step) => step.stepId === "route.library-citadel-vault.vault-secret-status-and-governance",
  );
  assert.ok(vaultStep);
  assert.deepEqual(vaultStep.operations.slice(4, 6), [
    { kind: "click", name: "Reveal", exact: true },
    { kind: "click", name: "Hide", exact: true },
  ]);
});

test("canonical agent persistence proof requires exact identity and default tools", () => {
  const input = {
    agentId: "agent-1",
    expectedRoleId: "usability-browser-agent",
    expectedTools: ["fs.read", "fs.list"],
  };
  assert.doesNotThrow(() =>
    validatePersistedAgentDefaultTools(
      {
        agentId: "agent-1",
        roleId: "usability-browser-agent",
        defaultTools: ["fs.read", "fs.list"],
      },
      input,
    ),
  );
  assert.throws(
    () =>
      validatePersistedAgentDefaultTools(
        {
          agentId: "agent-1",
          roleId: "usability-browser-agent",
          defaultTools: ["fs.read"],
        },
        input,
      ),
    /canonical agent defaultTools mismatch/u,
  );
  assert.throws(
    () =>
      validatePersistedAgentDefaultTools(
        {
          agentId: "agent-2",
          roleId: "usability-browser-agent",
          defaultTools: ["fs.read", "fs.list"],
        },
        input,
      ),
    /canonical agent identity mismatch/u,
  );
});

test("exact revision-conflict probes acknowledge only their expected Chromium 409s", () => {
  const expectedConflict = {
    type: "error",
    text: "Failed to load resource: the server responded with a status of 409 (Conflict)",
  };
  const unexpectedError = { type: "error", text: "Unexpected browser failure" };
  const result = filterExpectedBrowserConsoleMessages(
    { consoleMessages: [expectedConflict, expectedConflict, unexpectedError], pageErrors: [] },
    [
      {
        operatorActions: [
          {
            kind: "canonical-api-probe",
            probe: "project-revision-conflict",
            status: 409,
          },
          {
            kind: "canonical-api-probe",
            probe: "note-revision-conflict",
            status: 409,
          },
        ],
      },
    ],
  );

  assert.equal(result.acknowledgedCount, 2);
  assert.deepEqual(result.snapshot.consoleMessages, [unexpectedError]);
  assert.deepEqual(
    filterExpectedBrowserConsoleMessages({ consoleMessages: [expectedConflict], pageErrors: [] }, [
      {
        operatorActions: [
          {
            kind: "canonical-api-probe",
            probe: "unrelated-conflict",
            status: 409,
          },
        ],
      },
    ]).snapshot.consoleMessages,
    [expectedConflict],
  );
});

test("one exact event-stream connection failure is acknowledged only with bounded 200 and client-open proof", () => {
  const snapshot = recoveredSseSnapshot();
  const clientSseDiagnostics = recoveredSseDiagnostics();
  const result = filterExpectedBrowserConsoleMessages(snapshot, [], { clientSseDiagnostics });

  assert.equal(result.acknowledgedCount, 1);
  assert.equal(result.acknowledgedRevisionConflictCount, 0);
  assert.equal(result.acknowledgedSseRecoveryCount, 1);
  assert.deepEqual(result.snapshot.consoleMessages, []);
  assert.deepEqual(result.sseRecovery, {
    acknowledged: true,
    reason: "single event-stream connection failure recovered with a 200 response and client SSE open diagnostic",
    failedUrl: "/api/v1/events/stream",
    failureTimestamp: "2026-07-30T12:26:15.187Z",
    responseTimestamp: "2026-07-30T12:26:16.689Z",
    clientOpenTimestamp: "2026-07-30T12:26:16.692Z",
    recoveryMs: 1505,
    requestFailureCount: 1,
    responseCount: 1,
    clientDiagnosticCount: 1,
  });
});

test("event-stream console recovery acknowledgement stays fatal for wrong, repeated, truncated, or unrecovered evidence", () => {
  const valid = recoveredSseSnapshot();
  const diagnostics = recoveredSseDiagnostics();
  const cases = [
    {
      name: "wrong URL",
      snapshot: {
        ...valid,
        eventStreamRequestFailures: [{ ...valid.eventStreamRequestFailures[0], url: "/api/v1/other" }],
      },
      diagnostics,
    },
    {
      name: "repeated request failure",
      snapshot: {
        ...valid,
        eventStreamRequestFailures: [
          ...valid.eventStreamRequestFailures,
          { ...valid.eventStreamRequestFailures[0], timestamp: "2026-07-30T12:26:15.500Z" },
        ],
      },
      diagnostics,
    },
    {
      name: "repeated console failure",
      snapshot: { ...valid, consoleMessages: [...valid.consoleMessages, ...valid.consoleMessages] },
      diagnostics,
    },
    {
      name: "truncated network evidence",
      snapshot: { ...valid, eventStreamEvidenceTruncated: true },
      diagnostics,
    },
    {
      name: "late 200 response",
      snapshot: {
        ...valid,
        eventStreamResponses: [{ ...valid.eventStreamResponses[0], timestamp: "2026-07-30T12:26:20.188Z" }],
      },
      diagnostics,
    },
    {
      name: "missing 200 response",
      snapshot: { ...valid, eventStreamResponses: [] },
      diagnostics,
    },
    {
      name: "missing client open",
      snapshot: valid,
      diagnostics: { available: true, records: [] },
    },
    {
      name: "late client open",
      snapshot: valid,
      diagnostics: {
        available: true,
        records: [{ ...diagnostics.records[0], timestamp: "2026-07-30T12:26:20.188Z" }],
      },
    },
    {
      name: "unavailable diagnostics",
      snapshot: valid,
      diagnostics: { available: false, records: [] },
    },
  ];

  for (const fixture of cases) {
    const recovery = evaluateSseConnectionRecovery(fixture.snapshot, fixture.diagnostics);
    assert.equal(recovery.acknowledged, false, fixture.name);
    const filtered = filterExpectedBrowserConsoleMessages(fixture.snapshot, [], {
      clientSseDiagnostics: fixture.diagnostics,
    });
    assert.equal(filtered.acknowledgedSseRecoveryCount, 0, fixture.name);
    assert.deepEqual(filtered.snapshot.consoleMessages, fixture.snapshot.consoleMessages, fixture.name);
  }
});

test("event-stream recovery polling waits only for an exact candidate and captures delayed evidence", async () => {
  const initial = recoveredSseSnapshot();
  initial.eventStreamResponses = [];
  const diagnostics = recoveredSseDiagnostics();
  diagnostics.records = [];
  let nowMs = Date.parse("2026-07-30T12:26:15.200Z");
  let pollCount = 0;

  const result = await pollSseConnectionRecoveryEvidence({
    snapshot: initial,
    clientSseDiagnostics: diagnostics,
    getSnapshot: () => recoveredSseSnapshot(),
    readClientSseDiagnostics: async () => recoveredSseDiagnostics(),
    now: () => nowMs,
    wait: async () => {
      pollCount += 1;
      nowMs = Date.parse("2026-07-30T12:26:20.187Z");
    },
  });

  assert.equal(pollCount, 1);
  assert.equal(result.pollCount, 1);
  assert.equal(result.stabilityDeadlineTimestamp, "2026-07-30T12:26:20.187Z");
  assert.equal(result.stabilityWindowCompleted, true);
  assert.equal(result.recovery.acknowledged, true);
  assert.equal(result.recovery.recoveryMs, 1505);
});

test("event-stream stability polling revokes recovery when the final snapshot contains a delayed repeat", async () => {
  const initial = recoveredSseSnapshot();
  initial.eventStreamResponses = [];
  const diagnostics = recoveredSseDiagnostics();
  diagnostics.records = [];
  const recovered = recoveredSseSnapshot();
  const repeated = recoveredSseSnapshot();
  repeated.consoleMessages = [
    ...repeated.consoleMessages,
    {
      type: "error",
      text: "Failed to load resource: net::ERR_CONNECTION_FAILED",
      timestamp: "2026-07-30T12:26:19.900Z",
    },
  ];
  repeated.eventStreamRequestFailures = [
    ...repeated.eventStreamRequestFailures,
    {
      url: "/api/v1/events/stream",
      errorText: "net::ERR_CONNECTION_FAILED",
      timestamp: "2026-07-30T12:26:19.900Z",
    },
  ];
  let nowMs = Date.parse("2026-07-30T12:26:15.200Z");
  let snapshotReads = 0;

  const result = await pollSseConnectionRecoveryEvidence({
    snapshot: initial,
    clientSseDiagnostics: diagnostics,
    getSnapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? recovered : repeated;
    },
    readClientSseDiagnostics: async () => recoveredSseDiagnostics(),
    now: () => nowMs,
    wait: async () => {
      nowMs = Date.parse("2026-07-30T12:26:20.187Z");
    },
  });

  assert.equal(snapshotReads, 2, "one poll snapshot plus the final synchronous stability snapshot");
  assert.equal(result.pollCount, 1);
  assert.equal(result.stabilityWindowCompleted, true);
  assert.equal(result.recovery.acknowledged, false);
  assert.match(result.recovery.reason, /exactly one matching console error/u);
  assert.equal(result.snapshot.eventStreamRequestFailures.length, 2);
});

test("event-stream recovery polling does not wait for non-exact or unavailable candidates", async () => {
  const valid = recoveredSseSnapshot();
  const diagnostics = recoveredSseDiagnostics();
  const cases = [
    {
      name: "wrong URL",
      snapshot: {
        ...valid,
        eventStreamRequestFailures: [{ ...valid.eventStreamRequestFailures[0], url: "/api/v1/other" }],
      },
      diagnostics,
    },
    {
      name: "repeated failure",
      snapshot: {
        ...valid,
        eventStreamRequestFailures: [...valid.eventStreamRequestFailures, valid.eventStreamRequestFailures[0]],
      },
      diagnostics,
    },
    {
      name: "truncated evidence",
      snapshot: { ...valid, eventStreamEvidenceTruncated: true },
      diagnostics,
    },
    {
      name: "unavailable diagnostics",
      snapshot: valid,
      diagnostics: { available: false, records: [] },
    },
  ];

  for (const fixture of cases) {
    let waited = false;
    const result = await pollSseConnectionRecoveryEvidence({
      snapshot: fixture.snapshot,
      clientSseDiagnostics: fixture.diagnostics,
      getSnapshot: () => fixture.snapshot,
      readClientSseDiagnostics: async () => fixture.diagnostics,
      now: () => Date.parse("2026-07-30T12:26:15.200Z"),
      wait: async () => {
        waited = true;
      },
    });
    assert.equal(waited, false, fixture.name);
    assert.equal(result.pollCount, 0, fixture.name);
    assert.equal(result.recovery.acknowledged, false, fixture.name);
  }
});

function recoveredSseSnapshot() {
  return {
    consoleMessages: [
      {
        type: "error",
        text: "Failed to load resource: net::ERR_CONNECTION_FAILED",
        timestamp: "2026-07-30T12:26:15.187Z",
      },
    ],
    pageErrors: [],
    eventStreamRequestFailures: [
      {
        url: "/api/v1/events/stream",
        errorText: "net::ERR_CONNECTION_FAILED",
        timestamp: "2026-07-30T12:26:15.187Z",
      },
    ],
    eventStreamResponses: [
      {
        url: "/api/v1/events/stream",
        status: 200,
        timestamp: "2026-07-30T12:26:16.689Z",
      },
    ],
    eventStreamEvidenceTruncated: false,
  };
}

function recoveredSseDiagnostics() {
  return {
    available: true,
    records: [
      {
        category: "sse",
        event: "open",
        level: "info",
        timestamp: "2026-07-30T12:26:16.692Z",
      },
    ],
  };
}

test("Settings bundles use live control names and execute the seeded MCP grant lifecycle", () => {
  const settingsSteps = [
    ...BROWSER_ACTION_BUNDLES["settings-core-auth-provider"],
    ...BROWSER_ACTION_BUNDLES["settings-governance-runtime-integrations"],
  ];
  const operationNames = settingsSteps.flatMap((step) =>
    step.operations.flatMap((operation) => [operation.name, operation.namePattern].filter(Boolean)),
  );
  assert.equal(operationNames.includes("Save general settings"), false);
  assert.equal(operationNames.includes("Test notification"), false);
  assert.equal(operationNames.includes("Run Local AI readiness"), false);

  const permissionCrud = settingsSteps.find(
    (step) => step.stepId === "route.settings-permissions.permission-profile-crud",
  );
  assert.ok(permissionCrud);
  assert.ok(
    permissionCrud.operations.some(
      (operation) =>
        operation.kind === "fill" &&
        operation.label === "Edit profile description" &&
        operation.value === "Updated deterministic Settings permission profile.",
    ),
  );

  const oauthStatus = settingsSteps.find(
    (step) => step.stepId === "route.settings-providers.oauth-status-and-invalid-credential",
  );
  assert.ok(oauthStatus);
  assert.deepEqual(
    oauthStatus.operations.map((operation) =>
      operation.kind === "click"
        ? `${operation.kind}:${operation.name}`
        : operation.kind === "assert-text"
          ? `${operation.kind}:${operation.value}`
          : `${operation.kind}:${operation.probe}`,
    ),
    [
      "click:Add ChatGPT setup",
      "assert-text:ChatGPT provider added. Start ChatGPT login below.",
      "assert-text:Not started",
      "api:invalid-provider-credential",
    ],
  );
  assert.equal(operationNames.includes("OpenAI Codex ChatGPT login"), false);

  const mcpLifecycle = settingsSteps.find(
    (step) => step.stepId === "route.settings-mcp.mcp-server-tool-grant-lifecycle",
  );
  assert.ok(mcpLifecycle);
  assert.deepEqual(
    mcpLifecycle.operations
      .filter((operation) => operation.kind === "click" || operation.kind === "confirm")
      .map((operation) => `${operation.kind}:${operation.name}`),
    [
      "click:Save changes",
      "click:Connect",
      "click:Health check",
      "click:Disconnect",
      "click:Manage tool grants",
      "click:Create grant",
      "click:Revoke",
      "confirm:Revoke",
    ],
  );
  assert.ok(
    mcpLifecycle.operations.some(
      (operation) =>
        operation.kind === "fill" &&
        operation.label === "MCP server label" &&
        operation.value === "Verification local MCP updated",
    ),
  );
  assert.ok(
    mcpLifecycle.operations.some(
      (operation) => operation.kind === "assert-text" && operation.value === "goatcitadel.context.list",
    ),
  );
  assert.ok(
    mcpLifecycle.operations.some(
      (operation) => operation.kind === "fill" && operation.label === "Search" && operation.value === "mcp.invoke",
    ),
  );
});

test("operator-authenticated request options preserve caller options and headers", () => {
  const options = withOperatorAuth({
    method: "PATCH",
    headers: { "x-usability-probe": "expected-conflict" },
    body: { expectedRevision: 7 },
  });

  assert.equal(options.method, "PATCH");
  assert.deepEqual(options.body, { expectedRevision: 7 });
  assert.deepEqual(options.headers, {
    authorization: "Bearer verification-usability-browser-actions-operator-token",
    "x-usability-probe": "expected-conflict",
  });
  assert.equal(
    withOperatorAuth({ headers: { authorization: "Bearer explicit" } }).headers.authorization,
    "Bearer explicit",
  );
});

test("the Settings action runtime enables the connector diagnostics capability it exercises", () => {
  assert.equal(USABILITY_BROWSER_ACTION_GATEWAY_ENV.GOATCITADEL_FEATURE_CONNECTOR_DIAGNOSTICS_V1_ENABLED, "true");
  assert.deepEqual(USABILITY_LOCAL_MCP_POLICY.allowedEnvKeys, ["GOATCITADEL_AUTH_TOKEN"]);
});

test("Ops approval recovery pauses the linked durable run after fixture-session hydration", () => {
  const recovery = BROWSER_ACTION_BUNDLES["ops-governance-reliability"].find(
    (step) => step.stepId === "route.ops-approvals.approval-resume-canonical-run",
  );
  assert.deepEqual(
    recovery.operations.map((operation) => (operation.kind === "api" ? operation.probe : operation.kind)),
    ["fixture-session", "durable-run-pause", "click", "click", "click", "approval-durable-run-read"],
  );
});

test("resolved blocker evidence requires exact approval and user-input session linkage", () => {
  const evidence = validateResolvedBlockerEvidence({
    approvalSessionId: "session-approval",
    approvals: [
      {
        approvalId: "approval-1",
        status: "approved",
        linkage: { sessionId: "session-approval", turnId: "turn-approval" },
      },
    ],
    approvalTurns: [resolvedTurn("session-approval", "turn-approval", "run-approval")],
    userInputSessionId: "session-input",
    userInputTurns: [resolvedTurn("session-input", "turn-input", "run-input")],
  });

  assert.deepEqual(evidence, {
    approvalId: "approval-1",
    approvalTurnId: "turn-approval",
    userInputTurnId: "turn-input",
    userInputRunId: "run-input",
  });
  assert.throws(
    () =>
      validateResolvedBlockerEvidence({
        approvalSessionId: "session-approval",
        approvals: [
          {
            approvalId: "approval-1",
            status: "pending",
            linkage: { sessionId: "session-approval", turnId: "turn-approval" },
          },
        ],
        approvalTurns: [resolvedTurn("session-approval", "turn-approval", "run-approval")],
        userInputSessionId: "session-input",
        userInputTurns: [resolvedTurn("session-input", "turn-input", "run-input")],
      }),
    /approved decision not found/u,
  );
});

test("resolved blocker capability profiles require exact actor, durable, and trace bindings", () => {
  const turn = {
    ...resolvedTurn("session-approval", "turn-approval", "run-approval"),
    trace: {
      ...resolvedTurn("session-approval", "turn-approval", "run-approval").trace,
      capabilityProfileId: "profile-approval",
      capabilityProfileHash: "a".repeat(64),
    },
  };
  const envelope = {
    state: "available",
    profile: {
      profileId: "profile-approval",
      identity: {
        turnId: "turn-approval",
        sessionId: "session-approval",
        workspaceId: "workspace-1",
        durableRunId: "run-approval",
        operatorId: "token:fixture-actor",
        authActorId: "token:fixture-actor",
        authActorSource: "token",
      },
      hashes: { profileHash: "a".repeat(64) },
    },
  };
  const expected = {
    requestActor: {
      actorKind: "operator",
      actorId: "token:fixture-actor",
      operatorId: "token:fixture-actor",
      authActorId: "token:fixture-actor",
      authActorSource: "token",
    },
    sessionId: "session-approval",
    turn,
    workspaceId: "workspace-1",
  };

  assert.equal(validateResolvedBlockerCapabilityProfile(envelope, expected), true);
  assert.throws(
    () =>
      validateResolvedBlockerCapabilityProfile(
        {
          ...envelope,
          profile: {
            ...envelope.profile,
            identity: { ...envelope.profile.identity, authActorId: "token:wrong-actor" },
          },
        },
        expected,
      ),
    /authenticated actor identity/u,
  );
  assert.throws(
    () => validateResolvedBlockerCapabilityProfile({ state: "legacy_missing" }, expected),
    /capability profile is unavailable/u,
  );
});

test("blocker proof polls until both canonical projections settle", async () => {
  let reads = 0;
  const settled = await pollResolvedBlockerEvidence(
    async () => {
      reads += 1;
      return {
        approvalSessionId: "session-approval",
        approvals: [
          {
            approvalId: "approval-1",
            status: reads === 1 ? "pending" : "approved",
            linkage: { sessionId: "session-approval", turnId: "turn-approval" },
          },
        ],
        approvalTurns: [resolvedTurn("session-approval", "turn-approval", "run-approval")],
        userInputSessionId: "session-input",
        userInputTurns: [resolvedTurn("session-input", "turn-input", "run-input")],
      };
    },
    { timeoutMs: 100, pollIntervalMs: 0, wait: async () => undefined },
  );

  assert.equal(reads, 2);
  assert.equal(settled.evidence.approvalId, "approval-1");
  assert.equal(settled.evidence.userInputRunId, "run-input");
});

test("durable correlation resolves the current session turn and rejects payload drift", () => {
  const correlation = resolveThreadDurableCorrelation(
    [resolvedTurn("other-session", "other-turn", "other-run"), resolvedTurn("session-1", "turn-1", "run-1")],
    "session-1",
  );
  assert.deepEqual(correlation, { runId: "run-1", sessionId: "session-1", turnId: "turn-1" });
  assert.equal(
    validateDurableRunCorrelation(
      { runId: "run-1", payload: { sessionId: "session-1", turnId: "turn-1" } },
      correlation,
    ),
    true,
  );
  assert.throws(
    () =>
      validateDurableRunCorrelation(
        { runId: "run-1", payload: { sessionId: "session-2", turnId: "turn-1" } },
        correlation,
      ),
    /different or missing session\/turn/u,
  );
  assert.throws(
    () => validateDurableRunCorrelation({ runId: "run-1", payload: {} }, correlation),
    /different or missing session\/turn/u,
  );
});

test("attached durable watcher proof binds the exact parent and verified workspace scope", () => {
  const rail = {
    version: "durable.background_task_rail.v1",
    parent: { runId: "parent-run" },
    scope: { workspaceId: "workspace-1", sessionId: "session-1", verified: true },
    tasks: [
      {
        watcherId: "watcher-1",
        childRunId: "child-run",
        watcherState: "attached",
        scope: { workspaceId: "workspace-1", sessionId: "child-session", verified: true },
      },
    ],
  };
  assert.equal(
    validateAttachedDurableWatcher(rail, {
      parentRunId: "parent-run",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      watcherId: "watcher-1",
      childRunId: "child-run",
    }).watcherId,
    "watcher-1",
  );
  assert.throws(
    () =>
      validateAttachedDurableWatcher(
        { ...rail, tasks: [{ ...rail.tasks[0], watcherState: "detached" }] },
        { parentRunId: "parent-run", workspaceId: "workspace-1", sessionId: "session-1" },
      ),
    /not attached/u,
  );
});

test("completed delegation proof requires independent children, exact fan-in, and complete synthesis lineage", () => {
  assert.deepEqual(buildDelegationPromptReplyRules(), [
    {
      ruleId: "delegation-researcher",
      userContentIncludes: "Assigned role: researcher",
      replyText: "Deterministic research handoff.",
    },
    {
      ruleId: "delegation-reviewer",
      userContentIncludes: "Assigned role: reviewer",
      replyText: "Deterministic review handoff.",
    },
    {
      ruleId: "delegation-synthesizer",
      userContentIncludes: "Assigned role: synthesizer",
      replyText: "Final deterministic delegation synthesis from both handoffs.",
    },
  ]);
  const objective = "Produce two independent deterministic analyses and synthesize both.";
  const outputs = [
    "Deterministic research handoff.",
    "Deterministic review handoff.",
    "Final deterministic delegation synthesis from both handoffs.",
  ];
  const steps = [
    delegationStep("step-research", 0, "researcher", outputs[0], true, []),
    delegationStep("step-review", 1, "reviewer", outputs[1], true, []),
    delegationStep("step-synthesis", 2, "synthesizer", outputs[2], false, ["step-research", "step-review"]),
  ];
  const stitchedOutput = outputs.join("\n\n");
  const accepted = { runId: "delegation-1", status: "completed", steps, stitchedOutput };
  const canonical = {
    run: {
      runId: "delegation-1",
      sessionId: "session-1",
      parentRunId: "parent-run",
      objective,
      status: "completed",
      stitchedOutput,
    },
    steps,
  };
  const tasks = steps.map((step, index) => {
    const output = outputs[index];
    return {
      watcherId: `watcher-${index}`,
      childRunId: `child-${index}`,
      delegationRunId: "delegation-1",
      delegationStepId: step.stepId,
      watcherState: "attached",
      canonicalStatus: "completed",
      scope: { workspaceId: "workspace-1", sessionId: `child-session-${index}`, verified: true },
      output: {
        availability: "available",
        source: "delegation_step",
        sourceId: step.stepId,
        sha256: sha256(output),
        byteCount: Buffer.byteLength(output),
      },
      blockers: [],
    };
  });
  const rail = {
    version: "durable.background_task_rail.v1",
    parent: { runId: "parent-run" },
    scope: { workspaceId: "workspace-1", sessionId: "session-1", verified: true },
    coverage: { watchers: { complete: true }, parentSignals: { complete: true } },
    tasks,
    synthesis: {
      availability: "available",
      summary: stitchedOutput,
      delegationRunId: "delegation-1",
      lineage: tasks.map((task) => ({
        watcherId: task.watcherId,
        childRunId: task.childRunId,
        source: task.output.source,
        sourceId: task.output.sourceId,
        sha256: task.output.sha256,
        byteCount: task.output.byteCount,
        links: [],
      })),
      missingTerminalChildRunIds: [],
      uncoveredChildRunIds: [],
      uncoveredStepIds: [],
    },
    unknowns: [],
  };
  assert.equal(
    validateCompletedDelegationFanIn(accepted, canonical, rail, {
      delegationRunId: "delegation-1",
      objective,
      parentRunId: "parent-run",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    }).tasks.length,
    3,
  );
  assert.throws(
    () =>
      validateCompletedDelegationFanIn(
        accepted,
        canonical,
        { ...rail, synthesis: { ...rail.synthesis, uncoveredStepIds: ["step-review"] } },
        {
          delegationRunId: "delegation-1",
          objective,
          parentRunId: "parent-run",
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
      ),
    /synthesis lineage is incomplete/u,
  );
  assert.throws(
    () =>
      validateCompletedDelegationFanIn(
        accepted,
        {
          ...canonical,
          steps: canonical.steps.map((step) =>
            step.index === 2 ? { ...step, output: "Unexpected terminal synthesis." } : step,
          ),
        },
        rail,
        {
          delegationRunId: "delegation-1",
          objective,
          parentRunId: "parent-run",
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
      ),
    /"actual":\["Deterministic research handoff\.","Deterministic review handoff\.","Unexpected terminal synthesis\."\]/u,
  );
});

test("governed Code Mode proof fails closed across approval scope, artifacts, named proof, and Run Detail", () => {
  const source = 'console.log("CHAT_CODE_MODE_STDOUT"); return { ok: true, marker: "CHAT_CODE_MODE_OK" };';
  const contents = {
    source,
    wrapper_manifest: '{"wrappers":[]}',
    policy_snapshot: '{"policy":"fixture"}',
    stdout: "CHAT_CODE_MODE_STDOUT\n",
  };
  const artifacts = Object.fromEntries(
    Object.entries(contents).map(([kind, content]) => [
      kind,
      { artifactId: `artifact-${kind}`, relPath: `managed/${kind}`, sha256: sha256(content) },
    ]),
  );
  const integrity = {
    mode: "trusted_code_artifact_hash_check",
    claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox",
    verifiedAt: "2026-07-29T00:00:00.000Z",
    artifacts: Object.entries(artifacts).map(([artifactKind, artifact]) => ({
      artifactKind,
      artifactId: artifact.artifactId,
      relPath: artifact.relPath,
      expectedSha256: artifact.sha256,
      actualSha256: artifact.sha256,
      verified: true,
    })),
    notes: ["Does not claim hostile-code sandboxing."],
  };
  const run = {
    runId: "code-run-1",
    approvalId: "approval-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    status: "completed",
    language: "typescript",
    originSurface: "chat",
    requestedOutputIntent: "workbench_helper",
    saveCandidateOnSuccess: false,
    capabilitySnapshotId: "cap-snap-1",
    codeModeInputHash: "a".repeat(64),
    // Semantic JSON hashes are intentionally independent of the pretty-printed
    // managed artifact byte hashes checked below.
    wrapperManifestHash: "b".repeat(64),
    policySnapshotHash: "c".repeat(64),
    codeHash: artifacts.source.sha256,
    codeArtifact: artifacts.source,
    wrapperManifestArtifact: artifacts.wrapper_manifest,
    policySnapshotArtifact: artifacts.policy_snapshot,
    stdoutArtifact: artifacts.stdout,
    trustedCodeWriteVerification: integrity,
    verification: { status: "completed_unverified", updatedAt: "2026-07-29T00:00:00.000Z" },
    result: { ok: true, marker: "CHAT_CODE_MODE_OK" },
  };
  const expected = {
    runId: "code-run-1",
    approvalId: "approval-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
  };
  assert.equal(validateCompletedCodeModeRun(run, expected), true);
  const previews = Object.fromEntries(
    Object.entries(contents).map(([artifactKind, content]) => [
      artifactKind,
      {
        runId: run.runId,
        artifactKind,
        artifact: artifacts[artifactKind],
        content,
        sha256: artifacts[artifactKind].sha256,
        truncated: false,
      },
    ]),
  );
  assert.equal(
    validateCodeModeArtifactEvidence(
      run,
      previews,
      {
        snapshotId: "cap-snap-1",
        inspectableEntries: [{ capabilityId: "tool:fixture" }],
        callableEntries: [{ capabilityId: "tool:fixture" }],
      },
      source,
    ),
    true,
  );
  const verifiedRun = {
    ...run,
    verification: { status: "verified", evidenceId: "proof-1", subjectHash: "f".repeat(64) },
  };
  const evidence = {
    evidenceId: "proof-1",
    runId: run.runId,
    workspaceId: run.workspaceId,
    sessionId: run.sessionId,
    turnId: run.turnId,
    status: "verified",
    commandName: "git_diff_check",
    commandLabel: "git diff --check",
    command: "git",
    args: ["diff", "--check"],
    scope: "worktree",
    commandStatus: "passed",
    exitCode: 0,
    subject: {
      subjectHash: verifiedRun.verification.subjectHash,
      codeModeInputHash: run.codeModeInputHash,
      codeHash: run.codeHash,
      wrapperManifestHash: run.wrapperManifestHash,
      policySnapshotHash: run.policySnapshotHash,
      worktreeIdentityHash: "1".repeat(64),
      worktreeStateHash: "2".repeat(64),
      worktreeBaseRef: "HEAD",
      worktreeHeadHash: "3".repeat(40),
      changedFiles: [],
      changedFilesTruncated: false,
      artifacts: integrity.artifacts,
    },
  };
  assert.equal(validateVerifiedCodeModeNamedProof(verifiedRun, [evidence], expected).evidenceId, "proof-1");
  assert.equal(
    validateUniversalRunDetailTrace(
      {
        version: "observe.run_trace.v1",
        runId: "durable-1",
        run: {
          runId: "durable-1",
          status: "completed",
          payload: { sessionId: "session-1", turnId: "turn-1" },
        },
        thread: { state: "available", turns: [{ sessionId: "session-1", turnId: "turn-1" }] },
        posture: { readOnly: true, sideEffectPosture: "audit_only", audit: { state: "available" } },
      },
      { runId: "durable-1", sessionId: "session-1", turnId: "turn-1" },
    ),
    true,
  );
  assert.throws(
    () => validateCompletedCodeModeRun({ ...run, approvalId: "wrong" }, expected),
    /lost its exact governed Chat scope/u,
  );
  assert.throws(
    () => validateVerifiedCodeModeNamedProof(verifiedRun, [{ ...evidence, args: ["diff"] }], expected),
    /missing exact command/u,
  );
  assert.throws(
    () =>
      validateVerifiedCodeModeNamedProof(
        verifiedRun,
        [{ ...evidence, subject: { ...evidence.subject, worktreeStateHash: "malformed" } }],
        expected,
      ),
    /missing exact command/u,
  );
  assert.throws(
    () =>
      validateVerifiedCodeModeNamedProof(
        verifiedRun,
        [{ ...evidence, subject: { ...evidence.subject, changedFiles: ["README.md"] } }],
        expected,
      ),
    /missing exact command/u,
  );
});

function resolvedTurn(sessionId, turnId, runId) {
  return {
    turnId,
    trace: {
      sessionId,
      turnId,
      status: "completed",
      durable: { runId },
    },
  };
}

function delegationStep(stepId, index, role, output, parallelizable, dependsOnStepIds) {
  return {
    stepId,
    runId: "delegation-1",
    index,
    role,
    output,
    status: "completed",
    parallelizable,
    dependsOnStepIds,
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
