import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { buildVerificationProcessEnv } from "../runtime.mjs";
import {
  EXPECTED_USABILITY_SURFACE_COUNTS,
  ROUTE_ACTIONS_BY_SLUG,
  appendLiveCapabilityRows,
  buildUsabilityRouteActionInventory,
  collectVerificationSecretEnvKeys,
  countUsabilitySurfaces,
} from "./usability-coverage.mjs";
import {
  normalizeNodeJunitActionReport,
  normalizeVitestActionReport,
  runUsabilityActionProofScenarios,
} from "./usability-action-evidence.mjs";
import {
  BROWSER_ACTION_BUNDLES,
  BROWSER_ACTION_STEP_REGISTRY,
  EXPECTED_BROWSER_ACTION_BUNDLE_COUNTS,
  listBrowserActionProofGaps,
} from "./usability-browser-action-registry.mjs";
import {
  CAPABILITY_DISPOSITIONS,
  awaitCompletedApprovedToolAction,
  buildCapabilityFilesystemFixturePaths,
  classifyCapabilityDisposition,
  listDeterministicCapabilityProbeIds,
  readCompletedApprovedToolAction,
  validateDeterministicCapabilityResult,
  validateNamedProofRefs,
  validateSkillActivationDecision,
} from "./usability-capability-dispositions.mjs";
import { startDeterministicLlmStub } from "./deterministic-llm-stub.mjs";
import { assertExperimentalSurfaceLabel } from "./surface-regression-lane.mjs";
import {
  assertGatewayChatFaultScenario,
  assertCompletedChatTurns,
  assertRequiredUsabilityScenarioOrder,
  buildExternalSourceBrowserActionSteps,
  readGatewayChatFaultResultRows,
  resolveBrowserActionBinding as resolveBrowserActionBindingForRun,
  resolveCapabilityEntryBinding as resolveCapabilityEntryBindingForRun,
  resolveInventoryEvidence as resolveInventoryEvidenceForRun,
  runUsabilityCoreLane,
  runUsabilityLane,
  usabilityResultRow,
} from "./usability-lane.mjs";
import { assertUsabilitySourceState, assertUsabilitySourceStateUnchanged } from "./usability-source-state.mjs";
import {
  DEFAULT_USABILITY_MIN_FREE_GIB,
  inspectUsabilityDiskCapacity,
  resolveUsabilityDiskThreshold,
  runUsabilityDiskCapacityPreflight,
} from "./usability-disk-preflight.mjs";

const retainedEvidenceRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-usability-evidence-"));

after(() => {
  fsSync.rmSync(retainedEvidenceRoot, { recursive: true, force: true });
});

function resolveInventoryEvidence(inventoryRow, scenarioById, baseSha) {
  retainScenarioArtifacts(scenarioById.values());
  return resolveInventoryEvidenceForRun(inventoryRow, scenarioById, baseSha, retainedEvidenceRoot);
}

function resolveBrowserActionBinding(binding, scenarios, baseSha) {
  retainScenarioArtifacts(scenarios);
  return resolveBrowserActionBindingForRun(binding, scenarios, baseSha, retainedEvidenceRoot);
}

function resolveCapabilityEntryBinding(binding, scenarios, baseSha) {
  retainScenarioArtifacts(scenarios);
  return resolveCapabilityEntryBindingForRun(binding, scenarios, baseSha, retainedEvidenceRoot);
}

function retainScenarioArtifacts(scenarios) {
  for (const scenario of scenarios) {
    for (const references of Object.values(scenario?.artifacts ?? {})) {
      if (!Array.isArray(references)) continue;
      for (const reference of references) {
        retainArtifactReference(scenario.id, reference);
      }
    }
    for (const browserStep of scenario?.metrics?.browserActionSteps ?? []) {
      for (const reference of browserStep?.evidence ?? []) retainArtifactReference(scenario.id, reference);
    }
    for (const disposition of scenario?.metrics?.capabilityDispositions ?? []) {
      for (const reference of disposition?.evidence ?? []) retainArtifactReference(scenario.id, reference);
    }
  }
}

function retainArtifactReference(scenarioId, reference) {
  if (typeof reference !== "string" || path.isAbsolute(reference)) return;
  const absolutePath = path.resolve(retainedEvidenceRoot, reference);
  const relativePath = path.relative(retainedEvidenceRoot, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) return;
  fsSync.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fsSync.writeFileSync(absolutePath, `${scenarioId}:${reference}\n`, "utf8");
}

test("usability inventory follows current implementation truth and covers every route action", () => {
  const counts = countUsabilitySurfaces();
  assert.deepEqual(counts, EXPECTED_USABILITY_SURFACE_COUNTS);
  assert.equal(Object.keys(ROUTE_ACTIONS_BY_SLUG).length, EXPECTED_USABILITY_SURFACE_COUNTS.routes);

  const inventory = buildUsabilityRouteActionInventory("a".repeat(40));
  assert.equal(inventory.counts.routes, 48);
  assert.equal(inventory.counts.shipped, 42);
  assert.equal(inventory.counts.experimental, 6);
  assert.equal(inventory.counts.redirects, 20);
  assert.equal(inventory.counts.directCompatibility, 3);
  assert.ok(inventory.rows.length > 100);
  const requiredRows = inventory.rows.filter((row) => row.required);
  const optionalRows = inventory.rows.filter((row) => !row.required);
  assert.equal(requiredRows.length, 154);
  assert.ok(requiredRows.every((row) => row.proofBindings.length > 0 && row.expectedResult));
  assert.ok(
    requiredRows.every(
      (row) =>
        row.implementationRefs.length > 0 &&
        row.testRefs.length > 0 &&
        row.proofBindings.every(
          (binding) => binding.mode === "missing-browser-action-proof" || binding.scenarioIds.length > 0,
        ),
    ),
  );
  const actionRows = requiredRows.filter((row) => row.kind === "route-action");
  assert.equal(actionRows.length, 83);
  assert.ok(
    actionRows.every((row) =>
      row.proofBindings.every((binding) =>
        ["browser-action-step", "dedicated-scenario", "missing-browser-action-proof"].includes(binding.mode),
      ),
    ),
  );
  const directCompatibilityRows = requiredRows.filter((row) => row.kind === "direct-compatibility-path");
  assert.deepEqual(
    directCompatibilityRows.map((row) => ({
      stepId: row.stepId,
      route: row.route,
      scenarioId: row.proofBindings[0]?.scenarioIds[0],
    })),
    [
      {
        stepId: "direct-compatibility.direct-cowork",
        route: "/cowork",
        scenarioId: "surface-regression.direct-compatibility.direct-cowork",
      },
      {
        stepId: "direct-compatibility.direct-code",
        route: "/code",
        scenarioId: "surface-regression.direct-compatibility.direct-code",
      },
      {
        stepId: "direct-compatibility.direct-settings-safety",
        route: "/settings/safety",
        scenarioId: "surface-regression.direct-compatibility.direct-settings-safety",
      },
    ],
  );
  assert.deepEqual(
    actionRows
      .filter((row) => row.proofBindings.some((binding) => binding.mode === "missing-browser-action-proof"))
      .map((row) => row.stepId)
      .sort(),
    listBrowserActionProofGaps()
      .map((gap) => gap.stepId)
      .sort(),
  );
  assert.equal(optionalRows.length, 2);
  assert.ok(optionalRows.every((row) => row.requiredCondition && row.skipReason && row.proofBindings.length === 0));
  assert.equal(new Set(inventory.rows.map((row) => row.stepId)).size, inventory.rows.length);
});

test("required action evidence fails closed unless every exact owner passes with artifacts", () => {
  const inventory = buildUsabilityRouteActionInventory("c".repeat(40));
  const row = inventory.rows.find((candidate) => candidate.stepId === "route.chat.send-stream");
  assert.ok(row);
  const scenarios = new Map(
    row.proofBindings
      .flatMap((binding) => binding.scenarioIds)
      .map((id) => [id, { id, status: "passed", artifacts: { logs: [`logs/${id}.log`] } }]),
  );
  assert.equal(resolveInventoryEvidence(row, scenarios, "c".repeat(40)).status, "passed");

  const missingArtifactScenarios = new Map(scenarios);
  const missingArtifactOwnerId = row.proofBindings[0].scenarioIds[0];
  missingArtifactScenarios.set(missingArtifactOwnerId, {
    ...missingArtifactScenarios.get(missingArtifactOwnerId),
    artifacts: { logs: ["logs/required-owner-missing.log"] },
  });
  const invalidEvidence = resolveInventoryEvidenceForRun(
    row,
    missingArtifactScenarios,
    "c".repeat(40),
    retainedEvidenceRoot,
  );
  assert.equal(invalidEvidence.status, "failed");
  assert.match(invalidEvidence.actualResult, /evidence_invalid=missing-reference/u);

  scenarios.delete("usability.foundation.chat-send-stream");
  const missing = resolveInventoryEvidence(row, scenarios, "c".repeat(40));
  assert.equal(missing.status, "failed");
  assert.match(missing.actualResult, /usability\.foundation\.chat-send-stream/u);
});

test("a passing broad owner scenario cannot satisfy an action without its exact Chromium step result", () => {
  const baseSha = "d".repeat(40);
  const inventory = buildUsabilityRouteActionInventory(baseSha);
  const row = inventory.rows.find((candidate) => candidate.stepId === "route.projects.workspace-project-crud");
  assert.ok(row);
  const ownerId = row.proofBindings[0].scenarioIds[0];
  const broadOnly = resolveInventoryEvidence(
    row,
    new Map([[ownerId, { id: ownerId, status: "passed", artifacts: { logs: ["logs/broad.log"] } }]]),
    baseSha,
  );
  assert.equal(broadOnly.status, "failed");
  assert.match(broadOnly.actualResult, /browser_action=/u);
});

test("exact Chromium action steps pass once and fail stale, duplicate, or non-browser evidence", () => {
  const baseSha = "e".repeat(40);
  const inventory = buildUsabilityRouteActionInventory(baseSha);
  const row = inventory.rows.find((candidate) => candidate.stepId === "route.projects.workspace-project-crud");
  assert.ok(row);
  const binding = row.proofBindings[0];
  const ownerId = binding.scenarioIds[0];
  const exact = {
    stepId: binding.browserStepIds[0],
    baseSha,
    status: "passed",
    proofKind: "chromium-operator-action",
    operatorActions: [{ kind: "click", accessibleName: "Create project" }],
    evidence: ["diagnostics/browser-actions.json"],
  };
  const scenario = {
    id: ownerId,
    status: "passed",
    metrics: { baseSha, browserActionSteps: [exact] },
    artifacts: { diagnostics: ["diagnostics/action.json"] },
  };
  assert.equal(resolveInventoryEvidence(row, new Map([[ownerId, scenario]]), baseSha).status, "passed");

  const stale = { ...scenario, metrics: { ...scenario.metrics, baseSha: "f".repeat(40) } };
  assert.equal(resolveInventoryEvidence(row, new Map([[ownerId, stale]]), baseSha).status, "failed");

  const duplicated = { ...scenario, metrics: { ...scenario.metrics, browserActionSteps: [exact, exact] } };
  assert.equal(resolveInventoryEvidence(row, new Map([[ownerId, duplicated]]), baseSha).status, "failed");

  const unitOnly = {
    ...scenario,
    metrics: { ...scenario.metrics, browserActionSteps: [{ ...exact, proofKind: "unit-test-assertion" }] },
  };
  assert.equal(resolveInventoryEvidence(row, new Map([[ownerId, unitOnly]]), baseSha).status, "failed");
  const missingStepArtifact = {
    ...scenario,
    metrics: {
      ...scenario.metrics,
      browserActionSteps: [{ ...exact, evidence: ["diagnostics/missing-browser-step.json"] }],
    },
  };
  const missingStepEvidence = resolveInventoryEvidenceForRun(
    row,
    new Map([[ownerId, missingStepArtifact]]),
    baseSha,
    retainedEvidenceRoot,
  );
  assert.equal(missingStepEvidence.status, "failed");
  assert.match(missingStepEvidence.actualResult, /step-evidence-invalid:missing-reference/u);
  assert.equal(
    resolveBrowserActionBinding(
      binding,
      [{ ...scenario, metrics: { ...scenario.metrics, browserActionSteps: [exact] } }],
      baseSha,
    ).status,
    "passed",
  );
});

test("restart, recovery, auth, and realtime rows require Chromium plus their isolated named owners", () => {
  const baseSha = "9".repeat(40);
  const inventory = buildUsabilityRouteActionInventory(baseSha);
  const expectations = [
    {
      stepId: "route.chat.durable-restart-resume",
      browserScenarioId: "usability.browser-actions.chat-agentic-durable-code",
      dedicatedScenarioId: "runtime-truth.approval-restart-durable-truth",
    },
    {
      stepId: "route.ops-activity.realtime-reconnect",
      browserScenarioId: "usability.browser-actions.ops-work",
      dedicatedScenarioId: "realtime-truth.disconnect-reconnect-resubscribe",
    },
    {
      stepId: "route.ops-runtime.restart-recovery",
      browserScenarioId: "usability.browser-actions.ops-governance-reliability",
      dedicatedScenarioId: "runtime-truth.approval-restart-durable-truth",
    },
    {
      stepId: "route.ops-diagnostics.backup-recovery-entry",
      browserScenarioId: "usability.browser-actions.ops-governance-reliability",
      dedicatedScenarioId: "backup-roundtrip.runtime.config-restore",
    },
    {
      stepId: "route.settings-access.token-basic-device-grants",
      browserScenarioId: "usability.browser-actions.settings-core-auth-provider",
      dedicatedScenarioId: "auth-matrix.basic-restart-device-revocation",
    },
    {
      stepId: "route.settings-access.revoked-and-persisted-credentials",
      browserScenarioId: "usability.browser-actions.settings-core-auth-provider",
      dedicatedScenarioId: "auth-matrix.basic-restart-device-revocation",
    },
  ];

  for (const { stepId, browserScenarioId, dedicatedScenarioId } of expectations) {
    const row = inventory.rows.find((candidate) => candidate.stepId === stepId);
    assert.ok(row, `missing inventory row ${stepId}`);
    assert.deepEqual(
      row.proofBindings.map((binding) => ({ mode: binding.mode, scenarioId: binding.scenarioIds[0] })),
      [
        { mode: "browser-action-step", scenarioId: browserScenarioId },
        { mode: "dedicated-scenario", scenarioId: dedicatedScenarioId },
      ],
    );

    const browserBinding = row.proofBindings[0];
    const browserStep = {
      stepId,
      baseSha,
      status: "passed",
      proofKind: "chromium-operator-action",
      operatorActions: [{ kind: "click", accessibleName: "recovery entry" }],
      evidence: ["screenshots/ops-recovery-entry.png"],
    };
    const browserScenario = {
      id: browserBinding.scenarioIds[0],
      status: "passed",
      metrics: { baseSha, browserActionSteps: [browserStep] },
      artifacts: { diagnostics: ["diagnostics/ops-browser-actions.json"] },
    };
    const recoveryScenario = {
      id: dedicatedScenarioId,
      status: "passed",
      artifacts: { diagnostics: [`diagnostics/${dedicatedScenarioId}.json`] },
    };
    const scenarios = new Map([
      [browserScenario.id, browserScenario],
      [recoveryScenario.id, recoveryScenario],
    ]);

    assert.equal(resolveInventoryEvidence(row, scenarios, baseSha).status, "passed");
    scenarios.delete(dedicatedScenarioId);
    const missingRecovery = resolveInventoryEvidence(row, scenarios, baseSha);
    assert.equal(missingRecovery.status, "failed");
    assert.match(missingRecovery.actualResult, new RegExp(dedicatedScenarioId.replaceAll(".", "\\."), "u"));
  }
});

test("every route action has an exact Chromium owner contract and requested bundle count", () => {
  const inventory = buildUsabilityRouteActionInventory("1".repeat(40));
  assert.deepEqual(listBrowserActionProofGaps(), []);
  assert.equal(Object.keys(BROWSER_ACTION_STEP_REGISTRY).length, 76);
  assert.deepEqual(
    Object.fromEntries(Object.entries(BROWSER_ACTION_BUNDLES).map(([bundleId, steps]) => [bundleId, steps.length])),
    EXPECTED_BROWSER_ACTION_BUNDLE_COUNTS,
  );
  assert.equal(
    inventory.rows
      .filter((row) => row.kind === "route-action")
      .every((row) => row.proofBindings.every((binding) => binding.mode !== "missing-browser-action-proof")),
    true,
  );
  assert.equal(
    inventory.rows
      .filter((row) => row.kind === "route-action")
      .flatMap((row) => row.proofBindings)
      .filter((binding) => binding.mode === "action-assertion").length,
    0,
  );
});

test("Chat and Projects Chromium contracts retain exact fixture sessions and complete visible lifecycles", () => {
  const steps = Object.values(BROWSER_ACTION_BUNDLES).flat();
  const operations = (stepId) => {
    const row = steps.find((candidate) => candidate.stepId === stepId);
    assert.ok(row, `missing browser action step ${stepId}`);
    return row.operations;
  };

  assert.deepEqual(operations("route.chat.planning-delegation-synthesis"), [
    { kind: "click", name: "Plan", exact: true },
    { kind: "assert-text", value: "Planning mode is on" },
    { kind: "fill", label: "Message composer", value: "Plan this deterministic usability turn." },
    { kind: "click", name: "Send", exact: true },
    { kind: "assert-text", value: "Verification stub reply." },
    { kind: "api", probe: "planning-turn-completed" },
    { kind: "api", probe: "delegate-suggest-accept" },
  ]);
  assert.deepEqual(operations("route.chat.edit-and-branch"), [
    { kind: "api", probe: "chat-retry-completed" },
    { kind: "click", name: "Open turn: Stop this deterministic usability turn.", exact: true },
    { kind: "wait-enabled", name: "Edit and resend turn ", exact: false },
    { kind: "click-pattern", namePattern: "Edit and resend turn " },
    { kind: "assert-text", value: "Branching from turn" },
    { kind: "fill", label: "Message composer", value: "Branch this deterministic turn." },
    { kind: "click", name: "Send branch", exact: true },
    { kind: "api", probe: "chat-branch-completed" },
  ]);
  assert.deepEqual(operations("route.chat.approval-and-user-input-resume"), [
    { kind: "fixture-session", sessionKey: "approval" },
    { kind: "assert-text", value: "Approval needed" },
    { kind: "click", name: "Allow once", exact: true },
    { kind: "assert-text", value: "Approved once." },
    { kind: "fixture-session", sessionKey: "userInput" },
    { kind: "assert-text", value: "Input needed" },
    { kind: "click-pattern", namePattern: "Continue with the current plan" },
    { kind: "click", name: "Submit answer", exact: true },
    { kind: "api", probe: "approval-and-user-input" },
  ]);
  assert.deepEqual(operations("route.chat.durable-restart-resume"), [
    { kind: "click", name: "Work Record", exact: true },
    { kind: "click", name: "Background tasks", exact: true },
    { kind: "click", name: "Refresh background tasks", exact: true },
    { kind: "click-pattern", namePattern: "Detach background task " },
    { kind: "assert-text", value: "detached" },
    { kind: "click-pattern", namePattern: "Reattach background task " },
    { kind: "assert-text", value: "attached" },
    { kind: "api", probe: "durable-run-read" },
  ]);

  const crud = operations("route.projects.workspace-project-crud");
  assert.deepEqual(
    crud.filter((operation) => operation.kind === "click").map((operation) => operation.name),
    [
      "Create project from form",
      "Save project",
      "Archive project Usability browser project",
      "Unarchive project Usability browser project",
    ],
  );
  assert.ok(
    crud.some((operation) => operation.kind === "click-pattern" && operation.namePattern === "Archived projects"),
  );
  assert.ok(
    crud.some(
      (operation) =>
        operation.kind === "fill" &&
        operation.label === "Edit project description" &&
        operation.value === "Updated by the visible project edit flow.",
    ),
  );

  const conflict = operations("route.projects.revision-conflict");
  assert.equal(
    conflict.filter((operation) => operation.kind === "click" && operation.name === "Save project").length,
    2,
  );
  assert.ok(conflict.some((operation) => operation.kind === "assert-text" && operation.value === "changed elsewhere"));
  assert.ok(
    conflict.some((operation) => operation.kind === "assert-text" && operation.value === "draft was preserved"),
  );
  assert.deepEqual(conflict.at(-1), { kind: "api", probe: "project-revision-persisted" });

  assert.deepEqual(operations("route.settings-workspaces.workspace-create-select-archive-restore"), [
    { kind: "fill", label: "New workspace name", value: "Usability browser workspace" },
    { kind: "click", name: "Create workspace", exact: true },
    { kind: "click-pattern", namePattern: "Make active workspace Usability browser workspace" },
    { kind: "click-pattern", namePattern: "Archive workspace Usability browser workspace" },
    { kind: "click", name: "Confirm archive workspace", exact: true },
    { kind: "assert-text", value: "Workspace Usability browser workspace archived." },
    { kind: "click", name: "Archived workspaces", exact: true },
    { kind: "click-pattern", namePattern: "Usability browser workspace" },
    { kind: "click-pattern", namePattern: "Restore workspace Usability browser workspace" },
    { kind: "assert-text", value: "Workspace Usability browser workspace restored." },
    { kind: "click", name: "Active workspaces", exact: true },
    { kind: "click-pattern", namePattern: "Usability browser workspace" },
    { kind: "api", probe: "workspace-lifecycle-active" },
  ]);
});

test("external-source capability rows bind every exact browser step in every responsive combo", () => {
  const requiredNames = [
    ...new Set(
      Object.values(BROWSER_ACTION_STEP_REGISTRY)
        .filter((row) => row.external)
        .flatMap((row) => row.externalSourceStepNames),
    ),
  ];
  const comboResults = ["desktop-dark", "desktop-light", "mobile-dark", "mobile-light"].map((combo) => ({
    combo,
    status: "passed",
    steps: requiredNames.map((name) => ({ name, status: "passed" })),
  }));
  const rows = buildExternalSourceBrowserActionSteps(
    { comboResults },
    { baseSha: "2".repeat(40), evidence: ["diagnostics/external.json"] },
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "passed" && row.proofKind === "chromium-operator-action"));
  assert.ok(rows.every((row) => row.operatorActions.length > 0));

  const missing = buildExternalSourceBrowserActionSteps(
    { comboResults: [{ ...comboResults[0], steps: comboResults[0].steps.slice(1) }] },
    { baseSha: "2".repeat(40), evidence: ["diagnostics/external.json"] },
  );
  assert.ok(missing.some((row) => row.status === "failed"));
});

test("Vitest action reports bind exact file and title and reject missing or duplicate rows", () => {
  const file = "apps/mission-control-next/src/example.test.tsx";
  const title = "performs the exact action";
  const assertion = { assertionId: `${file}::${title}`, stepId: "route.example.action", file, title, contract: title };
  const raw = {
    success: true,
    testResults: [
      {
        name: path.join(process.cwd(), file),
        assertionResults: [{ title, fullName: `Example ${title}`, status: "passed", failureMessages: [] }],
      },
    ],
  };
  const exact = normalizeVitestActionReport(raw, [assertion], "2".repeat(40), process.cwd());
  assert.equal(exact.assertionResults[0].status, "passed");
  const missing = normalizeVitestActionReport(
    { success: true, testResults: [] },
    [assertion],
    "2".repeat(40),
    process.cwd(),
  );
  assert.equal(missing.assertionResults[0].runnerStatus, "missing");
  const duplicateRaw = { ...raw, testResults: [...raw.testResults, ...raw.testResults] };
  const duplicate = normalizeVitestActionReport(duplicateRaw, [assertion], "2".repeat(40), process.cwd());
  assert.equal(duplicate.assertionResults[0].runnerStatus, "duplicate");
});

test("node:test JUnit action reports bind exact file and title", () => {
  const file = "packages/storage/src/citadel-repo.test.ts";
  const title = "assigns existing agents to a citadel council idempotently and unassigns them";
  const assertion = { assertionId: `${file}::${title}`, stepId: "route.citadel.council", file, title, contract: title };
  const absoluteFile = path.join(process.cwd(), file).replaceAll("&", "&amp;");
  const junit = `<?xml version="1.0"?><testsuites><testsuite><testcase name="${title}" file="${absoluteFile}"/></testsuite><!-- pass 1 --><!-- fail 0 --></testsuites>`;
  const normalized = normalizeNodeJunitActionReport(junit, [assertion], "9".repeat(40), process.cwd());
  assert.equal(normalized.runnerSuccess, true);
  assert.equal(normalized.assertionResults[0].status, "passed");
});

test("node:test JUnit action reports use a missing-file fallback only for the exact command-owned source", () => {
  const file = "packages/storage/src/citadel-repo.test.ts";
  const title = "creates chambers and lists them scoped to a citadel";
  const assertion = {
    assertionId: `${file}::${title}`,
    stepId: "route.citadel.chambers",
    file,
    title,
    contract: title,
  };
  const junit = `<?xml version="1.0"?><testsuites><testcase name="${title}"/><!-- pass 1 --><!-- fail 0 --></testsuites>`;
  const normalized = normalizeNodeJunitActionReport(junit, [assertion], "a".repeat(40), process.cwd(), {
    commandOwnedFile: file,
  });
  assert.equal(normalized.runnerSuccess, true);
  assert.equal(normalized.assertionResults[0].status, "passed");
  assert.equal(normalized.assertionResults[0].occurrences, 1);

  const wrongAbsoluteFile = path.join(process.cwd(), "packages/storage/src/other.test.ts").replaceAll("&", "&amp;");
  const wrongExplicitFile = normalizeNodeJunitActionReport(
    `<?xml version="1.0"?><testsuites><testcase name="${title}" file="${wrongAbsoluteFile}"/><!-- pass 1 --><!-- fail 0 --></testsuites>`,
    [assertion],
    "a".repeat(40),
    process.cwd(),
    { commandOwnedFile: file },
  );
  assert.equal(wrongExplicitFile.assertionResults[0].status, "failed");
  assert.equal(wrongExplicitFile.assertionResults[0].runnerStatus, "missing");

  const duplicate = normalizeNodeJunitActionReport(
    `<?xml version="1.0"?><testsuites><testcase name="${title}"/><testcase name="${title}"/><!-- pass 2 --><!-- fail 0 --></testsuites>`,
    [assertion],
    "a".repeat(40),
    process.cwd(),
    { commandOwnedFile: file },
  );
  assert.equal(duplicate.assertionResults[0].status, "failed");
  assert.equal(duplicate.assertionResults[0].runnerStatus, "duplicate");

  const failed = normalizeNodeJunitActionReport(
    `<?xml version="1.0"?><testsuites><testcase name="${title}"><failure message="boom"/></testcase><!-- pass 0 --><!-- fail 1 --></testsuites>`,
    [assertion],
    "a".repeat(40),
    process.cwd(),
    { commandOwnedFile: file },
  );
  assert.equal(failed.runnerSuccess, false);
  assert.equal(failed.assertionResults[0].status, "failed");
  assert.equal(failed.assertionResults[0].runnerStatus, "failed");
});

test("node:test JUnit missing-file fallback rejects ambiguous or mismatched command ownership", () => {
  const file = "packages/storage/src/citadel-repo.test.ts";
  const title = "creates chambers and lists them scoped to a citadel";
  const assertion = {
    assertionId: `${file}::${title}`,
    stepId: "route.citadel.chambers",
    file,
    title,
    contract: title,
  };
  const otherFile = "packages/storage/src/chat-message-repo.search.test.ts";
  const otherAssertion = {
    assertionId: `${otherFile}::search boundary`,
    stepId: "route.settings.workspace-isolation",
    file: otherFile,
    title: "search boundary",
    contract: "search boundary",
  };
  const junit = `<?xml version="1.0"?><testsuites><testcase name="${title}"/><!-- pass 1 --><!-- fail 0 --></testsuites>`;
  assert.throws(
    () =>
      normalizeNodeJunitActionReport(junit, [assertion, otherAssertion], "b".repeat(40), process.cwd(), {
        commandOwnedFile: file,
      }),
    /fallback is ambiguous/u,
  );
  assert.throws(
    () =>
      normalizeNodeJunitActionReport(junit, [assertion], "b".repeat(40), process.cwd(), {
        commandOwnedFile: otherFile,
      }),
    /fallback is ambiguous/u,
  );
});

test("node:test action proofs run one command per source and retain distinct command artifacts", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-node-action-proofs-"));
  try {
    const calls = [];
    const writes = [];
    let storageOutcome;
    const forcedExitCodes = new Map();
    const titlesByPackageFile = new Map([
      [
        "src/citadel-repo.test.ts",
        [
          "creates chambers and lists them scoped to a citadel",
          "adds, lists, and removes wards scoped to a citadel",
          "assigns existing agents to a citadel council idempotently and unassigns them",
          "stores, lists (metadata only), reveals, and deletes vault secrets scoped to a citadel",
        ],
      ],
      [
        "src/chat-message-repo.search.test.ts",
        ["searchMessages never crosses workspace boundaries and excludes hidden sessions by default"],
      ],
    ]);
    const executeStorageActionProofs = async () => {
      await runUsabilityActionProofScenarios(
        { artifactRoot },
        {
          baseSha: "c".repeat(40),
          secretEnvKeys: ["OPENAI_API_KEY"],
          deps: {
            repoRoot: process.cwd(),
            pnpmCommand: () => "pnpm",
            runScenario: async (_context, scenario, execute) => {
              if (scenario.id === "usability.action-proofs.storage") storageOutcome = await execute();
            },
            runCommand: async (command, args, options) => {
              calls.push({ command, args, options });
              const packageFile = args.at(-1);
              const titles = titlesByPackageFile.get(packageFile);
              assert.ok(titles, `unexpected storage action-proof source ${packageFile}`);
              const testcases = titles
                .map((title) => `<testcase name="${title.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"/>`)
                .join("");
              const stdout = `<?xml version="1.0"?><testsuites>${testcases}<!-- pass ${titles.length} --><!-- fail 0 --></testsuites>`;
              const stdoutPath = path.join(options.artifactRoot, `${options.logName}.stdout.log`);
              const stderrPath = path.join(options.artifactRoot, `${options.logName}.stderr.log`);
              await fs.mkdir(options.artifactRoot, { recursive: true });
              await fs.writeFile(stdoutPath, stdout);
              await fs.writeFile(stderrPath, "");
              return { code: forcedExitCodes.get(packageFile) ?? 0, stdout, stderr: "", stdoutPath, stderrPath };
            },
            writeJson: async (file, value) => {
              writes.push({ file, value });
              await fs.mkdir(path.dirname(file), { recursive: true });
              await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
            },
            relativeToRun: (context, file) => path.relative(context.artifactRoot, file).replaceAll("\\", "/"),
          },
        },
      );
    };
    await executeStorageActionProofs();

    assert.equal(calls.length, 2);
    assert.deepEqual(new Set(calls.map((call) => call.args.at(-1))), new Set(titlesByPackageFile.keys()));
    assert.ok(calls.every((call) => call.args.filter((arg) => arg.endsWith(".test.ts")).length === 1));
    assert.ok(calls.every((call) => call.options.omitEnv.includes("OPENAI_API_KEY")));
    assert.equal(new Set(calls.map((call) => call.options.logName)).size, 2);
    const citadelCall = calls.find((call) => call.args.at(-1) === "src/citadel-repo.test.ts");
    assert.ok(citadelCall.args.some((arg) => arg.includes("creates chambers and lists them")));
    assert.ok(citadelCall.args.every((arg) => !arg.includes("searchMessages never crosses")));
    assert.equal(storageOutcome.status, "passed");
    assert.equal(storageOutcome.metrics.expectedAssertions, 5);
    assert.equal(storageOutcome.metrics.passedAssertions, 5);
    assert.equal(storageOutcome.artifacts.logs.length, 4);
    assert.equal(new Set(storageOutcome.artifacts.logs).size, 4);
    assert.ok(storageOutcome.artifacts.logs.every((file) => fsSync.existsSync(path.join(artifactRoot, file))));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].value.runnerSuccess, true);
    assert.equal(writes[0].value.assertionResults.length, 5);

    calls.length = 0;
    writes.length = 0;
    storageOutcome = undefined;
    forcedExitCodes.set("src/citadel-repo.test.ts", 1);
    await executeStorageActionProofs();
    assert.equal(storageOutcome.status, "failed");
    assert.match(storageOutcome.error, /citadel-repo\.test\.ts/u);
    assert.equal(storageOutcome.metrics.passedAssertions, 5);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].value.runnerSuccess, false);
    assert.equal(writes[0].value.assertionResults.length, 5);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("live capability rows require direct, activation, named-journey, or denial evidence rather than catalog membership", () => {
  const inventory = buildUsabilityRouteActionInventory("3".repeat(40));
  const tool = {
    capabilityId: "tool:files.read",
    kind: "tool",
    category: "files",
    callable: true,
    toolName: "files.read",
    wrapperVisibility: { readOnly: true, deterministic: true, codeModeAllowed: true },
    effectPotential: {
      version: "goatcitadel.tool-effect.v1",
      potential: "none",
      sourceKind: "builtin",
      reason: "trusted_builtin_safe_read",
    },
  };
  const skill = {
    capabilityId: "skill:review",
    kind: "skill",
    category: "governance",
    callable: false,
    lifecycleState: "candidate",
    skillId: "review",
    candidateId: "candidate-1",
    declaredTools: [],
    requires: [],
  };
  const rows = appendLiveCapabilityRows(inventory, { inspectable: [tool, skill], callable: [tool] });
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.action === "inspectability").length, 2);
  assert.equal(rows.filter((row) => row.action === "callability-governance").length, 1);
  assert.equal(new Set(rows.map((row) => row.stepId)).size, rows.length);
  const foundation = {
    id: "usability.foundation.chat-send-stream",
    status: "passed",
    metrics: {
      baseSha: "3".repeat(40),
      capabilityCatalog: { inspectable: [tool, skill], callable: [tool] },
      capabilityDispositions: [
        {
          capabilityId: tool.capabilityId,
          baseSha: "3".repeat(40),
          callable: true,
          disposition: "named_journey_proof",
          status: "passed",
          catalogOwner: tool.toolName,
          proof: {
            probeKind: "named-journey-non-executed-contract",
            probeOutcome: "named_proof_required",
            executed: false,
            reason: "Exact required journey owns execution proof.",
            proofRefs: ["route.chat.send-stream"],
            namedProofs: [{ stepId: "route.chat.send-stream" }],
          },
          evidence: ["diagnostics/usability-capability-dispositions.json"],
        },
        {
          capabilityId: skill.capabilityId,
          baseSha: "3".repeat(40),
          callable: false,
          disposition: "catalog_only_denied",
          status: "passed",
          catalogOwner: skill.skillId,
          proof: {
            probeKind: "noncallable-autonomy-denial",
            probeOutcome: "denied",
            executed: false,
            reason: "No matching grant.",
          },
          evidence: ["diagnostics/usability-capability-dispositions.json"],
        },
      ],
    },
    artifacts: { diagnostics: ["diagnostics/usability-capability-inventory.json"] },
  };
  for (const row of rows) {
    assert.equal(
      resolveInventoryEvidence(row, new Map([[foundation.id, foundation]]), "3".repeat(40)).status,
      "passed",
    );
  }
  assert.equal(
    resolveInventoryEvidence(
      rows.find((row) => row.action === "callability-governance"),
      new Map([[foundation.id, { ...foundation, metrics: { ...foundation.metrics, baseSha: "f".repeat(40) } }]]),
      "3".repeat(40),
    ).status,
    "failed",
  );
  const catalogOnlyFoundation = {
    ...foundation,
    metrics: { baseSha: "3".repeat(40), capabilityCatalog: foundation.metrics.capabilityCatalog },
  };
  assert.equal(
    resolveInventoryEvidence(rows[0], new Map([[foundation.id, catalogOnlyFoundation]]), "3".repeat(40)).status,
    "failed",
  );
  const missingDispositionArtifact = {
    ...foundation,
    metrics: {
      ...foundation.metrics,
      capabilityDispositions: foundation.metrics.capabilityDispositions.map((disposition) =>
        disposition.capabilityId === tool.capabilityId
          ? { ...disposition, evidence: ["diagnostics/missing-capability-disposition.json"] }
          : disposition,
      ),
    },
  };
  const missingDispositionEvidence = resolveInventoryEvidenceForRun(
    rows[0],
    new Map([[foundation.id, missingDispositionArtifact]]),
    "3".repeat(40),
    retainedEvidenceRoot,
  );
  assert.equal(missingDispositionEvidence.status, "failed");
  assert.match(missingDispositionEvidence.actualResult, /disposition-artifact-invalid:missing-reference/u);
  assert.equal(rows[0].proofBindings[0].mode, "capability-disposition");
  assert.equal(resolveCapabilityEntryBinding(rows[0].proofBindings[0], [foundation], "3".repeat(40)).status, "passed");

  assert.throws(
    () =>
      appendLiveCapabilityRows(buildUsabilityRouteActionInventory("4".repeat(40)), { inspectable: [], callable: [] }),
    /catalog is empty/u,
  );
  assert.throws(
    () =>
      appendLiveCapabilityRows(buildUsabilityRouteActionInventory("5".repeat(40)), {
        inspectable: [{ ...tool, toolName: undefined }],
        callable: [{ ...tool, toolName: undefined }],
      }),
    /no owner provenance/u,
  );
  assert.throws(
    () =>
      appendLiveCapabilityRows(buildUsabilityRouteActionInventory("6".repeat(40)), {
        inspectable: [{ ...tool, lifecycleState: "candidate", proposalId: "proposal-1" }],
        callable: [{ ...tool, lifecycleState: "candidate", proposalId: "proposal-1" }],
      }),
    /proposal\/candidate identity|inactive/u,
  );
  assert.throws(
    () =>
      appendLiveCapabilityRows(buildUsabilityRouteActionInventory("6".repeat(40)), {
        inspectable: [{ ...tool, lifecycleState: "candidate", proposalId: "proposal-1" }],
        callable: [{ ...tool, lifecycleState: "approved" }],
      }),
    /proposal\/candidate identity|inactive/u,
  );
});

test("capability disposition classifier separates direct, skill, named, limitation, and catalog-only proof", () => {
  assert.equal(
    classifyCapabilityDisposition({ capabilityId: "tool:time.now", kind: "tool", toolName: "time.now" }, true),
    CAPABILITY_DISPOSITIONS.SAFE_CONTRACT_PROBE,
  );
  assert.equal(
    classifyCapabilityDisposition(
      { capabilityId: "tool:session.status", kind: "tool", toolName: "session.status" },
      true,
    ),
    CAPABILITY_DISPOSITIONS.SAFE_CONTRACT_PROBE,
  );
  assert.equal(
    classifyCapabilityDisposition({ capabilityId: "tool:http.get", kind: "tool", toolName: "http.get" }, true),
    CAPABILITY_DISPOSITIONS.EXPLICIT_NON_EXECUTED_LIMITATION,
  );
  assert.equal(
    classifyCapabilityDisposition({ capabilityId: "tool:fs.write", kind: "tool", toolName: "fs.write" }, true),
    CAPABILITY_DISPOSITIONS.NAMED_JOURNEY_PROOF,
  );
  assert.equal(
    classifyCapabilityDisposition({ capabilityId: "skill:bundled:qa", kind: "skill", skillId: "bundled:qa" }, true),
    CAPABILITY_DISPOSITIONS.SKILL_ACTIVATION_CONTRACT,
  );
  assert.equal(
    classifyCapabilityDisposition({ capabilityId: "candidate:genie-npu-ir20", kind: "candidate" }, false),
    CAPABILITY_DISPOSITIONS.CATALOG_ONLY_DENIED,
  );
});

test("approved safe capability recovery reads exactly one completed durable tool action", () => {
  const approvalId = "9182ebd3-307c-4082-804c-a3a745954de6";
  const action = {
    outcome: "executed",
    policyReason: "Approved by operator.",
    auditEventId: "audit-1",
    approvalId,
    result: { iso: "2026-07-30T05:27:09.197Z" },
  };
  const effect = {
    effectId: "effect-1",
    approvalId,
    effectKind: "pending_action_execute",
    targetKind: "pending_action",
    targetId: approvalId,
    status: "completed",
    payload: { actionType: "tool.invoke", decision: "approve" },
    result: action,
  };
  const resolution = {
    approval: { approvalId, status: "approved" },
    effects: [
      {
        effectId: "signals-1",
        approvalId,
        effectKind: "approval_resolution_signals",
        targetKind: "approval",
        targetId: approvalId,
        status: "completed",
        payload: {},
        result: {},
      },
      effect,
    ],
    replay: {
      approval: { approvalId, status: "approved" },
      effects: [effect],
      pendingAction: {
        approvalId,
        actionType: "tool.invoke",
        resolutionStatus: "executed",
        result: action,
      },
    },
    resolutionEffects: { proactiveRunIds: [], chatTurnResume: { resumed: false } },
  };

  assert.deepEqual(readCompletedApprovedToolAction(resolution, approvalId), action);
});

test("approved safe capability recovery polls replay until the durable tool action completes", async () => {
  const approvalId = "9182ebd3-307c-4082-804c-a3a745954de6";
  const action = {
    outcome: "executed",
    policyReason: "Approved by operator.",
    auditEventId: "audit-1",
    approvalId,
    result: { ok: true },
  };
  const pendingEffect = {
    effectId: "effect-1",
    approvalId,
    effectKind: "pending_action_execute",
    targetKind: "pending_action",
    targetId: approvalId,
    status: "running",
    payload: { actionType: "tool.invoke" },
    result: {},
  };
  const completedEffect = { ...pendingEffect, status: "completed", result: action };
  const pendingAction = { approvalId, actionType: "tool.invoke", resolutionStatus: "pending" };
  const requestJson = async (gatewayUrl, route) => {
    assert.equal(gatewayUrl, "http://127.0.0.1:9999");
    assert.equal(route, `/api/v1/approvals/${approvalId}/replay`);
    return {
      ok: true,
      status: 200,
      body: {
        approval: { approvalId, status: "approved" },
        effects: [completedEffect],
        pendingAction: { ...pendingAction, resolutionStatus: "executed", result: action },
      },
    };
  };

  assert.deepEqual(
    await awaitCompletedApprovedToolAction({
      approvalId,
      gatewayUrl: "http://127.0.0.1:9999",
      initialResolution: {
        approval: { approvalId, status: "approved" },
        effects: [pendingEffect],
        replay: { approval: { approvalId, status: "approved" }, effects: [pendingEffect], pendingAction },
      },
      requestJson,
      pollIntervalMs: 0,
    }),
    action,
  );
});

test("approved safe capability replay polling stops at its configured settlement bound", async () => {
  const approvalId = "9182ebd3-307c-4082-804c-a3a745954de6";
  const effect = {
    effectId: "effect-1",
    approvalId,
    effectKind: "pending_action_execute",
    targetKind: "pending_action",
    targetId: approvalId,
    status: "pending",
    payload: { actionType: "tool.invoke" },
    result: {},
  };
  const resolution = {
    approval: { approvalId, status: "approved" },
    effects: [effect],
    pendingAction: { approvalId, actionType: "tool.invoke", resolutionStatus: "pending" },
  };
  let clockMs = 0;
  let replayReads = 0;

  await assert.rejects(
    awaitCompletedApprovedToolAction({
      approvalId,
      gatewayUrl: "http://127.0.0.1:9999",
      initialResolution: resolution,
      requestJson: async () => {
        replayReads += 1;
        return { ok: true, status: 200, body: resolution };
      },
      timeoutMs: 100,
      pollIntervalMs: 25,
      now: () => clockMs,
      sleep: async (delayMs) => {
        clockMs += delayMs;
      },
    }),
    /did not complete within 100ms/u,
  );
  assert.equal(replayReads, 4);
});

test("approved safe capability recovery fails closed for missing, ambiguous, or failed durable effects", () => {
  const approvalId = "9182ebd3-307c-4082-804c-a3a745954de6";
  const effect = {
    effectId: "effect-1",
    approvalId,
    effectKind: "pending_action_execute",
    targetKind: "pending_action",
    targetId: approvalId,
    status: "completed",
    payload: { actionType: "tool.invoke" },
    result: {
      outcome: "executed",
      policyReason: "Approved by operator.",
      auditEventId: "audit-1",
      result: { ok: true },
    },
  };
  const pendingAction = {
    approvalId,
    actionType: "tool.invoke",
    resolutionStatus: "executed",
    result: effect.result,
  };
  const resolution = {
    approval: { approvalId, status: "approved" },
    effects: [],
    replay: { approval: { approvalId, status: "approved" }, effects: [], pendingAction },
  };

  assert.throws(
    () => readCompletedApprovedToolAction(resolution, approvalId),
    /returned 0 canonical pending-action effects/u,
  );
  assert.throws(
    () =>
      readCompletedApprovedToolAction(
        { ...resolution, effects: [effect, { ...effect, effectId: "effect-2" }] },
        approvalId,
      ),
    /returned 2 canonical pending-action effects/u,
  );
  assert.throws(
    () =>
      readCompletedApprovedToolAction(
        { ...resolution, effects: [{ ...effect, status: "failed", lastError: "executor unavailable" }] },
        approvalId,
      ),
    /pending-action effect is failed: executor unavailable/u,
  );
  assert.throws(
    () =>
      readCompletedApprovedToolAction(
        { ...resolution, effects: [{ ...effect, result: { ...effect.result, outcome: "blocked" } }] },
        approvalId,
      ),
    /completed without a canonical executed tool action/u,
  );
  assert.throws(
    () =>
      readCompletedApprovedToolAction(
        {
          ...resolution,
          effects: [effect],
          replay: {
            ...resolution.replay,
            effects: [effect],
            pendingAction: { ...pendingAction, result: { ...effect.result, auditEventId: "audit-other" } },
          },
        },
        approvalId,
      ),
    /replay action does not match its completed effect/u,
  );
});

test("deterministic capability result validators reject empty and wrong output", () => {
  const ids = listDeterministicCapabilityProbeIds();
  assert.equal(ids.length, 16);
  for (const capabilityId of ids) {
    assert.throws(
      () =>
        validateDeterministicCapabilityResult(capabilityId, undefined, {
          fixture: {},
          sessionId: "session-1",
          startedAtMs: 1,
          completedAtMs: 2,
        }),
      /returned no object result/u,
    );
  }
  assert.throws(
    () =>
      validateDeterministicCapabilityResult(
        "tool:time.now",
        { epochMs: 10, iso: "wrong", local: "local", timezone: "UTC" },
        { fixture: {}, sessionId: "session-1", startedAtMs: 1, completedAtMs: 20 },
      ),
    /ISO and epoch disagree/u,
  );
  assert.deepEqual(
    validateDeterministicCapabilityResult(
      "tool:time.now",
      { epochMs: 10, iso: "1970-01-01T00:00:00.010Z", local: "local", timezone: "UTC" },
      { fixture: {}, sessionId: "session-1", startedAtMs: 1, completedAtMs: 20 },
    ),
    { epochMs: 10, iso: "1970-01-01T00:00:00.010Z", timezone: "UTC" },
  );
});

test("deterministic capability filesystem probes stay inside the isolated runtime workspace", () => {
  const runtimeRoot = path.join(os.tmpdir(), "goatcitadel-capability-contract");
  const workspaceRoot = path.join(runtimeRoot, "workspace");
  const fixture = buildCapabilityFilesystemFixturePaths(workspaceRoot);

  assert.deepEqual(fixture, {
    fileRoot: path.join(workspaceRoot, "capability-probe"),
    alphaPath: path.join(workspaceRoot, "capability-probe", "alpha.txt"),
    codePath: path.join(workspaceRoot, "capability-probe", "example.ts"),
  });
  for (const candidate of Object.values(fixture)) {
    const relative = path.relative(workspaceRoot, candidate);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  assert.throws(() => buildCapabilityFilesystemFixturePaths("  "), /isolated runtime workspaceRoot/u);
});

test("named capability proof refs fail closed when orphaned from required scenario evidence", () => {
  const valid = new Map([
    [
      "route.chat.code-mode-artifacts",
      {
        stepId: "route.chat.code-mode-artifacts",
        required: true,
        proofMode: "browser-and-api",
        proofBindings: [{ mode: "browser-action", scenarioIds: ["usability.browser-actions"] }],
      },
    ],
  ]);
  assert.equal(
    validateNamedProofRefs(["route.chat.code-mode-artifacts"], valid)[0].stepId,
    "route.chat.code-mode-artifacts",
  );
  assert.throws(
    () => validateNamedProofRefs(["route.chat.missing"], valid),
    /orphaned from required inventory\/scenario evidence/u,
  );
  valid.get("route.chat.code-mode-artifacts").proofBindings = [];
  assert.throws(
    () => validateNamedProofRefs(["route.chat.code-mode-artifacts"], valid),
    /orphaned from required inventory\/scenario evidence/u,
  );
});

test("skill activation result requires exact selected identity, state, and tool closure", () => {
  const item = {
    capabilityId: "skill:bundled:qa",
    skillId: "bundled:qa",
    declaredTools: ["fs.read", "shell.exec"],
    requires: [],
  };
  const selected = {
    skillId: "bundled:qa",
    state: "enabled",
    declaredTools: ["fs.read", "shell.exec"],
    requires: [],
    confidence: 1,
    requiresConfirmation: false,
  };
  assert.equal(validateSkillActivationDecision(item, { selected: [selected], blocked: [] }).skillId, "bundled:qa");
  assert.throws(() => validateSkillActivationDecision(item, { selected: [], blocked: [] }), /did not select exactly/u);
  assert.throws(
    () =>
      validateSkillActivationDecision(item, {
        selected: [{ ...selected, declaredTools: ["fs.read"] }],
        blocked: [],
      }),
    /changed its declared tool\/dependency closure/u,
  );
});

test("final source mode rejects dirty state while exploratory mode records it", () => {
  const base = { baseSha: "7".repeat(40), diffSha256: "8".repeat(64), changedPathCount: 1 };
  assert.doesNotThrow(() => assertUsabilitySourceState({ ...base, mode: "exploratory", sourceModified: true }));
  assert.throws(
    () => assertUsabilitySourceState({ ...base, mode: "final", sourceModified: true }),
    /requires a clean source tree/u,
  );
  assert.doesNotThrow(() => assertUsabilitySourceState({ ...base, mode: "final", sourceModified: false }));
  const stable = { ...base, mode: "final", sourceModified: false, changedPathCount: 0 };
  assert.deepEqual(assertUsabilitySourceStateUnchanged(stable, { ...stable }), stable);
  assert.throws(
    () => assertUsabilitySourceStateUnchanged(stable, { ...stable, baseSha: "9".repeat(40) }),
    /source changed during verification \(baseSha\)/u,
  );
  assert.throws(
    () =>
      assertUsabilitySourceStateUnchanged(stable, {
        ...stable,
        sourceModified: true,
        diffSha256: "a".repeat(64),
        changedPathCount: 1,
      }),
    /sourceModified, diffSha256, changedPathCount/u,
  );
});

test("usability lane rejects a HEAD change during prerequisites before running route scenarios", async () => {
  const started = {
    mode: "final",
    baseSha: "7".repeat(40),
    sourceModified: false,
    diffSha256: "8".repeat(64),
    changedPathCount: 0,
  };
  let ranScenario = false;
  await assert.rejects(
    runUsabilityLane(
      { artifactRoot: retainedEvidenceRoot, manifest: { scenarios: [] } },
      { sourceState: started },
      {
        repoRoot: "C:/fixture/repo",
        snapshotUsabilitySourceState: () => ({ ...started, baseSha: "9".repeat(40) }),
        runScenario: async () => {
          ranScenario = true;
        },
      },
    ),
    /source changed during verification \(baseSha\)/u,
  );
  assert.equal(ranScenario, false);
});

test("Gateway Chat fault proof is required, current, and preserved as step-level usability evidence", async () => {
  const baseSha = "7".repeat(40);
  const artifactPath = "diagnostics/gateway-chat-fault-recovery-steps.json";
  const stepIds = [
    "pre-output-server-error-retry",
    "post-output-disconnect-no-replay",
    "restart-during-streaming-reconciles-canonical-turn",
    "streaming-restart-next-turn-admission",
    "near-expiry-4551-single-dispatch",
    "invalid-credentials-terminal-failure",
    "invalid-credentials-next-turn-admission",
    "provider-idle-timeout-terminal-failure",
    "provider-timeout-next-turn-admission",
  ];
  const scenario = {
    id: "usability.gateway-chat-fault-recovery",
    status: "passed",
    metrics: {
      baseSha,
      stepsPlanned: 9,
      stepsExecuted: 9,
      stepsPassed: 9,
      stepsFailed: 0,
      faultTargetDispatches: 12,
    },
    artifacts: { diagnostics: [artifactPath], logs: ["logs/gateway-fault.log"] },
  };
  const steps = stepIds.map((stepId, index) => ({
    journeyId: "gateway-chat-fault-recovery",
    stepId,
    baseSha,
    environment: "isolated-source",
    storage: "sqlite",
    profileState: "api-sse",
    viewport: null,
    theme: null,
    provider: "openai",
    expectedResult: `expected ${stepId}`,
    actualResult: "passed",
    evidence: ["gateway-chat-fault-recovery-steps.json"],
    defectId: "GC-USAB-002",
    skipReason: null,
    status: "passed",
    startedAt: new Date(index).toISOString(),
    diagnostics: {
      providerDispatchCount: 1,
      emittedOutput: stepId === "post-output-disconnect-no-replay",
      providerFailureClass: index % 2 === 0 ? "transient" : null,
      remainingBudgetMs: stepId === "near-expiry-4551-single-dispatch" ? 4_551 : null,
      recoveryOutcome: "completed",
      correlation: {
        correlationId: `correlation-${index}`,
        sessionId: `session-${index}`,
        turnId: `turn-${index}`,
        runId: `run-${index}`,
      },
      diagnosticEvents: [],
    },
  }));
  const artifact = {
    schemaVersion: 1,
    baseSha,
    defectId: "GC-USAB-002",
    summary: {
      status: "passed",
      stepsPlanned: 9,
      stepsExecuted: 9,
      stepsPassed: 9,
      stepsFailed: 0,
      faultTargetDispatches: 12,
    },
    steps,
  };
  const artifactRoot = path.join(process.cwd(), "artifacts", "verification", "gateway-fault-unit");
  const rows = await readGatewayChatFaultResultRows({ artifactRoot }, new Map([[scenario.id, scenario]]), baseSha, {
    readJson: async (filePath) => {
      assert.equal(filePath, path.join(artifactRoot, "diagnostics", "gateway-chat-fault-recovery-steps.json"));
      return artifact;
    },
  });
  assert.equal(assertGatewayChatFaultScenario(scenario, baseSha), scenario);
  assert.equal(rows.length, 9);
  assert.ok(rows.every((row) => row.evidence[0] === artifactPath && row.diagnostics.correlation.runId));
  assert.doesNotThrow(() =>
    assertRequiredUsabilityScenarioOrder([scenario, { id: "usability.evidence-integrity", status: "passed" }]),
  );

  assert.throws(
    () =>
      assertGatewayChatFaultScenario(
        { ...scenario, metrics: { ...scenario.metrics, baseSha: "8".repeat(40) } },
        baseSha,
      ),
    /does not match the usability base SHA/u,
  );
  assert.throws(
    () => assertRequiredUsabilityScenarioOrder([{ id: "usability.evidence-integrity", status: "passed" }, scenario]),
    /must run before usability evidence integrity/u,
  );
  assert.throws(
    () => assertRequiredUsabilityScenarioOrder([{ id: "usability.evidence-integrity", status: "passed" }]),
    /exactly one Gateway fault scenario/u,
  );
  await assert.rejects(
    readGatewayChatFaultResultRows({ artifactRoot }, new Map([[scenario.id, scenario]]), baseSha, {
      readJson: async () => {
        const error = new Error("missing fault artifact");
        error.code = "ENOENT";
        throw error;
      },
    }),
    /missing fault artifact/u,
  );
  await assert.rejects(
    readGatewayChatFaultResultRows({ artifactRoot }, new Map([[scenario.id, scenario]]), baseSha, {
      readJson: async () => ({
        ...artifact,
        steps: steps.map((step, index) =>
          index === 0 ? { ...step, diagnostics: { ...step.diagnostics, correlation: null } } : step,
        ),
      }),
    }),
    /missing session\/turn\/run correlation/u,
  );
});

test("usability core reuses the foundation and fails closed on source and secret handling", async () => {
  const baseSha = "a".repeat(40);
  const sourceState = {
    mode: "final",
    baseSha,
    sourceModified: false,
    diffSha256: "b".repeat(64),
    changedPathCount: 0,
  };
  const artifactRoot = path.join(process.cwd(), "artifacts", "verification", "usability-core-unit");
  const context = { artifactRoot, manifest: { scenarios: [] } };
  const writes = [];
  let requestedSourceMode;
  let requestedSecretRoot;
  let foundationInput;
  const deps = {
    repoRoot: process.cwd(),
    snapshotUsabilitySourceState: (_repoRoot, mode) => {
      requestedSourceMode = mode;
      return sourceState;
    },
    collectVerificationSecretEnvKeys: async (configRoot) => {
      requestedSecretRoot = configRoot;
      return ["DATABASE_URL", "OPENAI_API_KEY"];
    },
    runFoundationJourney: async (_context, input) => {
      foundationInput = input;
      return {
        status: "passed",
        metrics: { foundationSteps: 7 },
        artifacts: {
          diagnostics: ["diagnostics/foundation.json"],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
      };
    },
    runScenario: async (scenarioContext, definition, run) => {
      const result = await run({ correlationId: "usability-core-correlation" });
      const scenario = { ...definition, ...result };
      scenarioContext.manifest.scenarios.push(scenario);
      return scenario;
    },
    writeJson: async (filePath, value) => writes.push({ filePath, value }),
    relativeToRun: (scenarioContext, filePath) =>
      path.relative(scenarioContext.artifactRoot, filePath).replaceAll("\\", "/"),
  };

  const scenario = await runUsabilityCoreLane(context, { sourceMode: "final" }, deps);
  assert.equal(scenario.status, "passed");
  assert.equal(scenario.id, "usability-core.foundation.chat-send-stream");
  assert.equal(requestedSourceMode, "final");
  assert.equal(requestedSecretRoot, path.join(process.cwd(), "config"));
  assert.equal(foundationInput.baseSha, baseSha);
  assert.equal(foundationInput.correlationId, "usability-core-correlation");
  assert.deepEqual(foundationInput.secretEnvKeys, ["DATABASE_URL", "OPENAI_API_KEY"]);
  assert.equal(scenario.metrics.sourceModified, false);
  assert.equal(scenario.metrics.sourceDiffSha256, sourceState.diffSha256);
  assert.ok(scenario.artifacts.diagnostics.includes("diagnostics/usability-core-source-state.json"));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].value.baseSha, baseSha);
  assert.deepEqual(writes[1].value, { schemaVersion: 1, started: sourceState, completed: sourceState });
  assert.equal(scenario.metrics.completedSourceDiffSha256, sourceState.diffSha256);

  await assert.rejects(
    runUsabilityCoreLane(
      { artifactRoot, manifest: { scenarios: [] } },
      { sourceMode: "final" },
      {
        ...deps,
        snapshotUsabilitySourceState: () => ({ ...sourceState, sourceModified: true, changedPathCount: 1 }),
      },
    ),
    /requires a clean source tree/u,
  );
  await assert.rejects(
    runUsabilityCoreLane(
      { artifactRoot, manifest: { scenarios: [] } },
      { sourceMode: "final" },
      { ...deps, collectVerificationSecretEnvKeys: async () => ["not-valid"] },
    ),
    /did not return valid environment keys/u,
  );
  await assert.rejects(
    runUsabilityCoreLane(
      { artifactRoot, manifest: { scenarios: [] } },
      { sourceMode: "final" },
      {
        ...deps,
        runFoundationJourney: async () => ({ status: "failed", error: "fixture failure" }),
      },
    ),
    /usability core foundation failed/u,
  );
});

test("usability result rows carry the required evidence schema without synthetic skips", () => {
  const row = usabilityResultRow({
    journeyId: "foundation",
    stepId: "foundation.chat",
    baseSha: "b".repeat(40),
    environment: "isolated-source",
    storage: "sqlite",
    profileState: "fresh",
    viewport: { width: 390, height: 844 },
    theme: "light",
    provider: "verification-stub",
    expectedResult: "CHAT_OK",
    actualResult: "passed",
    evidence: ["screenshots/foundation.png"],
  });
  assert.deepEqual(Object.keys(row), [
    "journeyId",
    "stepId",
    "baseSha",
    "environment",
    "storage",
    "profileState",
    "viewport",
    "theme",
    "provider",
    "expectedResult",
    "actualResult",
    "evidence",
    "defectId",
    "skipReason",
    "status",
    "startedAt",
  ]);
  assert.equal(row.skipReason, null);
  assert.equal(row.status, "passed");
});

test("secret scrub combines inherited credential names with config-referenced env names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-usability-env-"));
  try {
    await fs.writeFile(
      path.join(root, "providers.json"),
      JSON.stringify({
        providers: [{ apiKeyEnv: "FIXTURE_PROVIDER_CREDENTIAL" }],
        channel: { tokenEnv: "CHAT_TOKEN" },
      }),
    );
    const keys = await collectVerificationSecretEnvKeys(root, {
      PATH: "safe",
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      DATABASE_URL: "postgres://secret",
      GOATCITADEL_TEST_POSTGRES_URL: "postgres://secret",
      GOATCITADEL_POSTGRES_CONNECTION_STRING: "postgres://secret",
      GOATCITADEL_POSTGRES_CONNECTION_STRING_ENV: "PERSONAL_DB_REFERENCE",
      GOATCITADEL_POSTGRES_HOST: "personal-db.internal",
      GOATCITADEL_DATABASE_DRIVER: "postgres",
      PERSONAL_DB_REFERENCE: "postgres://indirect-secret",
      PGHOST: "personal-db.internal",
      PGPASSWORD: "secret",
      SESSION_COOKIE: "secret",
      APP_SESSION_ID: "personal-session",
      BROWSER_COOKIE_JAR: "C:/secret/cookies.json",
      CLIENT_CERT: "secret",
      WINDOWS_SIGN_CERT_BASE64: "secret",
      POSTGRES_CERT_PATH: "C:/secret/client.crt",
      TLS_CERTIFICATE_PATH: "C:/secret/client.pem",
      SIGNING_PRIVATE_KEY_PATH: "C:/secret/key.pem",
      GOOGLE_CREDENTIALS_PATH: "C:/secret/credentials.json",
      ORDINARY_CACHE_PATH: "C:/safe/cache",
      ORDINARY_SETTING: "visible",
    });
    assert.deepEqual(keys, [
      "APP_SESSION_ID",
      "BROWSER_COOKIE_JAR",
      "CHAT_TOKEN",
      "CLIENT_CERT",
      "DATABASE_URL",
      "FIXTURE_PROVIDER_CREDENTIAL",
      "GITHUB_TOKEN",
      "GOATCITADEL_DATABASE_DRIVER",
      "GOATCITADEL_POSTGRES_CONNECTION_STRING",
      "GOATCITADEL_POSTGRES_CONNECTION_STRING_ENV",
      "GOATCITADEL_POSTGRES_HOST",
      "GOATCITADEL_TEST_POSTGRES_URL",
      "GOOGLE_CREDENTIALS_PATH",
      "OPENAI_API_KEY",
      "PERSONAL_DB_REFERENCE",
      "PGHOST",
      "PGPASSWORD",
      "POSTGRES_CERT_PATH",
      "SESSION_COOKIE",
      "SIGNING_PRIVATE_KEY_PATH",
      "TLS_CERTIFICATE_PATH",
      "WINDOWS_SIGN_CERT_BASE64",
    ]);
    assert.equal(keys.includes("PATH"), false);
    assert.equal(keys.includes("ORDINARY_CACHE_PATH"), false);

    const childEnv = buildVerificationProcessEnv(
      { PATH: "safe", OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret" },
      { GITHUB_TOKEN: "fixture-token", GOATCITADEL_ROOT_DIR: "fixture-root" },
      keys,
    );
    assert.equal(childEnv.PATH, "safe");
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.GITHUB_TOKEN, "fixture-token");
    assert.equal(childEnv.GOATCITADEL_ROOT_DIR, "fixture-root");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deterministic provider supports an injectable server_error before success", async () => {
  const stub = await startDeterministicLlmStub({ replyText: "CHAT_OK", failuresBeforeSuccess: 1 });
  try {
    const requestBody = { model: stub.model, messages: [{ role: "user", content: "fixture" }] };
    const failed = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).error.code, "server_error");

    const succeeded = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(succeeded.status, 200);
    assert.equal((await succeeded.json()).choices[0].message.content, "CHAT_OK");
    assert.equal(stub.completionDispatches(), 2);
    assert.deepEqual(
      stub.requestSummaries().map((entry) => entry.messageCount),
      [1, 1],
    );
    assert.equal(JSON.stringify(stub.requestSummaries()).includes("fixture"), false);
  } finally {
    await stub.close();
  }
});

test("experimental surfaces require an explicit visible status label", async () => {
  const visibleBadge = {
    waitFor: async () => undefined,
    count: async () => 1,
    isVisible: async () => true,
    getAttribute: async (name) => (name === "aria-label" ? "Experimental" : null),
    innerText: async () => "Experimental",
  };
  await assertExperimentalSurfaceLabel({ locator: () => visibleBadge }, "library-journey");
  await assert.rejects(
    assertExperimentalSurfaceLabel(
      {
        locator: () => ({
          ...visibleBadge,
          count: async () => 0,
          isVisible: async () => false,
        }),
      },
      "library-journey",
    ),
    /has no unique visible on-surface Experimental badge/u,
  );
});

test("canonical Chat proof rejects provider dispatch without completed assistant output", () => {
  const completed = {
    turns: [
      {
        turnId: "turn-1",
        trace: { status: "completed" },
        assistantMessage: { content: "CHAT_OK" },
      },
    ],
  };
  assert.doesNotThrow(() => assertCompletedChatTurns(completed, 1, "CHAT_OK"));
  assert.throws(
    () =>
      assertCompletedChatTurns(
        {
          turns: [
            {
              turnId: "turn-dispatched-only",
              trace: { status: "running" },
              assistantMessage: undefined,
            },
          ],
        },
        1,
        "CHAT_OK",
      ),
    /is running/u,
  );
});

test("usability disk threshold defaults to 8 GiB and only permits a lower exploratory override", () => {
  const defaultThreshold = resolveUsabilityDiskThreshold();
  assert.equal(defaultThreshold.minimumFreeGiB, DEFAULT_USABILITY_MIN_FREE_GIB);
  assert.equal(defaultThreshold.minimumFreeBytes, 8n * 1024n * 1024n * 1024n);
  assert.equal(defaultThreshold.source, "default");

  const exploratory = resolveUsabilityDiskThreshold({ sourceMode: "exploratory", minimumFreeGiB: "2" });
  assert.equal(exploratory.minimumFreeGiB, 2n);
  assert.equal(exploratory.source, "environment");
  assert.throws(() => resolveUsabilityDiskThreshold({ sourceMode: "final", minimumFreeGiB: "7" }), /cannot lower/u);
  for (const invalid of ["0", "-1", "1.5", "abc"]) {
    assert.throws(
      () => resolveUsabilityDiskThreshold({ sourceMode: "exploratory", minimumFreeGiB: invalid }),
      /positive whole number/u,
    );
  }
});

test("usability disk capacity checks the repository and effective temporary roots at the exact boundary", async () => {
  const threshold = 8n * 1024n * 1024n * 1024n;
  const measured = [];
  const result = await inspectUsabilityDiskCapacity(
    {
      repoRoot: path.join(retainedEvidenceRoot, "repo-capacity"),
      tempRoot: path.join(retainedEvidenceRoot, "temp-capacity"),
      minimumFreeBytes: threshold,
    },
    {
      mkdir: async () => undefined,
      statfs: async (target, options) => {
        measured.push({ target, options });
        return target.endsWith("repo-capacity")
          ? { bavail: 8n, bsize: 1024n * 1024n * 1024n }
          : { bavail: threshold - 1n, bsize: 1n };
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.roots.map((root) => [root.role, root.status]),
    [
      ["repository", "passed"],
      ["temporary", "failed"],
    ],
  );
  assert.equal(measured.length, 2);
  assert.ok(measured.every((entry) => entry.options.bigint === true));
});

test("usability disk capacity fails closed when a volume cannot be measured", async () => {
  const result = await inspectUsabilityDiskCapacity(
    {
      repoRoot: path.join(retainedEvidenceRoot, "repo-statfs-error"),
      tempRoot: path.join(retainedEvidenceRoot, "temp-statfs-error"),
      minimumFreeBytes: 1024n,
    },
    {
      mkdir: async () => undefined,
      statfs: async (target) => {
        if (target.endsWith("repo-statfs-error")) throw new Error("statfs unavailable");
        return { bavail: 1024n, bsize: 1n };
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.roots[0].availableBytes, null);
  assert.match(result.roots[0].error, /statfs unavailable/u);
});

test("failed usability disk preflight retains its environment scenario and diagnostic before stopping", async () => {
  const recorded = [];
  const written = [];
  const context = {
    lane: "usability",
    repoRoot: path.join(retainedEvidenceRoot, "repo-preflight-failure"),
    artifactRoot: path.join(retainedEvidenceRoot, "artifact-preflight-failure"),
  };
  await assert.rejects(
    runUsabilityDiskCapacityPreflight(
      context,
      {
        env: {
          GOATCITADEL_USABILITY_SOURCE_MODE: "exploratory",
          GOATCITADEL_USABILITY_MIN_FREE_GIB: "1",
          GOATCITADEL_VERIFY_TEMP_ROOT: path.join(retainedEvidenceRoot, "explicit-temp-root"),
        },
      },
      {
        mkdir: async () => undefined,
        statfs: async (target) =>
          target.endsWith("repo-preflight-failure")
            ? { bavail: 512n, bsize: 1024n * 1024n }
            : { bavail: 2n, bsize: 1024n * 1024n * 1024n },
        now: () => new Date("2026-07-30T08:30:00.000Z"),
        writeJson: async (target, value) => written.push({ target, value }),
        runScenario: async (_context, definition, fn) => {
          const result = await fn({ correlationId: "disk-preflight-test" });
          const scenario = { ...definition, ...result };
          recorded.push(scenario);
          return scenario;
        },
      },
    ),
    /repository volume has 0.5 GiB available/u,
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].id, "usability.preflight.disk-capacity");
  assert.equal(recorded[0].status, "failed");
  assert.deepEqual(recorded[0].artifacts.diagnostics, ["diagnostics/usability-disk-preflight.json"]);
  assert.equal(written.length, 1);
  assert.equal(written[0].value.status, "failed");
  assert.equal(written[0].value.roots[1].path.endsWith("explicit-temp-root"), true);
});

test("usability orchestration guards source before prerequisites and completes integrity after review", async () => {
  const source = await fs.readFile(new URL("../../run.mjs", import.meta.url), "utf8");
  const sourceGuardIndex = source.indexOf("usabilitySourceState = beginUsabilitySourceGuard");
  const usabilityStart = source.indexOf('} else if (lane === "usability") {');
  const usabilityEnd = source.indexOf('} else if (lane === "usability-core") {', usabilityStart);
  const usabilityBranch = source.slice(usabilityStart, usabilityEnd);
  const preflightIndex = usabilityBranch.indexOf("await runUsabilityDiskCapacityPreflight");
  const fastIndex = usabilityBranch.indexOf("await runFastLane");
  const allStart = source.indexOf('} else if (lane === "all") {');
  const finalIntegrityIndex = source.indexOf("await completeUsabilityFinalIntegrity");
  const reviewIndex = source.indexOf("await generateVerificationReview", allStart);
  const failureBranchStart = source.indexOf("  } catch (error) {", allStart);
  const failureBranchEnd = source.indexOf("\n  }\n\n  console.log", failureBranchStart);
  const failureBranch = source.slice(failureBranchStart, failureBranchEnd);
  const failedFinalizeIndex = failureBranch.indexOf('await finalizeRunContext(context, "failed")');
  const failedReviewIndex = failureBranch.indexOf("await generateVerificationReview");
  const failedIntegrityIndex = failureBranch.indexOf("await completeUsabilityFinalIntegrity");
  assert.ok(sourceGuardIndex > 0);
  assert.ok(sourceGuardIndex < usabilityStart);
  assert.ok(sourceGuardIndex < allStart);
  assert.ok(preflightIndex > 0);
  assert.ok(fastIndex > preflightIndex);
  assert.match(usabilityBranch, /runUsabilityLane\(context, \{ profile, sourceState: usabilitySourceState \}\)/u);
  assert.match(
    source.slice(allStart),
    /runUsabilityLane\(context, \{ profile, sourceState: usabilitySourceState \}\)/u,
  );
  assert.ok(finalIntegrityIndex > reviewIndex);
  assert.ok(failureBranchStart > allStart);
  assert.ok(failureBranchEnd > failureBranchStart);
  assert.ok(failedFinalizeIndex > 0);
  assert.ok(failedReviewIndex > failedFinalizeIndex);
  assert.ok(failedIntegrityIndex > failedReviewIndex);
  assert.match(failureBranch, /combineUsabilityPrimaryAndIntegrityErrors\(error, integrityError\)/u);
  assert.equal(source.slice(usabilityEnd).includes("runUsabilityDiskCapacityPreflight"), false);
});

test("direct browser lane orchestration collects and forwards secret environment keys", async () => {
  const source = await fs.readFile(new URL("../../run.mjs", import.meta.url), "utf8");
  const scrubLaneSetStart = source.indexOf("const DIRECT_BROWSER_SECRET_SCRUB_LANES");
  const scrubLaneSetEnd = source.indexOf("]);", scrubLaneSetStart);
  const scrubLaneSet = source.slice(scrubLaneSetStart, scrubLaneSetEnd);
  for (const lane of ["accessibility-smoke", "surface-regression", "visual-regression", "visual-rebaseline", "all"]) {
    assert.match(scrubLaneSet, new RegExp(`"${lane}"`, "u"));
  }

  assert.match(
    source,
    /DIRECT_BROWSER_SECRET_SCRUB_LANES\.has\(lane\)[\s\S]*?collectVerificationSecretEnvKeys\(path\.join\(repoRoot, "config"\)\)/u,
  );

  const accessibilityStart = source.indexOf('} else if (lane === "accessibility-smoke") {');
  const surfaceStart = source.indexOf('} else if (lane === "surface-regression") {', accessibilityStart);
  const visualStart = source.indexOf('} else if (lane === "visual-regression") {', surfaceStart);
  const rebaselineStart = source.indexOf('} else if (lane === "visual-rebaseline") {', visualStart);
  const backupStart = source.indexOf('} else if (lane === "backup-roundtrip") {', rebaselineStart);
  const allStart = source.indexOf('} else if (lane === "all") {', backupStart);
  const allEnd = source.indexOf("\n    manifest = await finalizeRunContext", allStart);

  assert.match(
    source.slice(accessibilityStart, surfaceStart),
    /runAccessibilitySmokeLane\(context, \{ profile, secretEnvKeys: directBrowserSecretEnvKeys \}\)/u,
  );
  assert.match(
    source.slice(surfaceStart, visualStart),
    /runSurfaceRegressionLane\(context, \{ profile, secretEnvKeys: directBrowserSecretEnvKeys \}\)/u,
  );
  assert.match(source.slice(visualStart, rebaselineStart), /secretEnvKeys: directBrowserSecretEnvKeys/u);
  assert.match(source.slice(rebaselineStart, backupStart), /secretEnvKeys: directBrowserSecretEnvKeys/u);
  assert.match(
    source.slice(allStart, allEnd),
    /runVisualRegressionLane\(context, \{[\s\S]*?secretEnvKeys: directBrowserSecretEnvKeys/u,
  );
});
