import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TOOL_EFFECT_CLASSIFICATION_VERSION } from "../../../../packages/contracts/dist/index.js";

export const RECORDED_OPENCODE_REPORT = Object.freeze({
  version: 1, engine: "opencode", truncated: true,
  text: "Recorded browser fixture only. No OpenCode process ran and no file change was applied.",
  error: "Fixture permission denied",
  steps: [{ id: "fixture-edit", tool: "edit", title: "Recorded edit attempt", status: "error", error: "Fixture permission denied" }],
  files: [{ path: "src/<script>fixture</script>.ts", patch: "-const previous = 1;\n+const proposed = 2;", additions: 1, deletions: 1, truncated: true }],
});

/** Display-only records: never add execution authority, grants or effects. */
export function seedRenderingRecords(storage, { workspaceId, sessionId, turnId }) {
  assert.equal(storage.chatSessionMeta.get(sessionId)?.workspaceId, workspaceId);
  assert.equal(storage.chatSessionBranchState.get(sessionId)?.activeLeafTurnId, turnId);
  const trace = storage.chatTurnTraces.get(turnId);
  assert.equal(trace.sessionId, sessionId);
  assert.equal(trace.status, "completed");
  const identity = createHash("sha256").update(`${workspaceId}\n${sessionId}\n${turnId}`).digest("hex").slice(0, 24);
  const citationId = `cockpit-render-unsafe-${identity}`;
  if (!trace.citations.some((item) => item.citationId === citationId)) {
    storage.chatTurnTraces.patch(turnId, { citations: [...trace.citations,
      { citationId, title: "Unsafe recorded fixture source", url: "javascript:alert(1)",
        snippet: "This display fixture verifies that unsafe source links are withheld.", sourceType: "web" }] });
  }
  const toolRunId = `cockpit-render-opencode-${identity}`;
  if (!storage.chatToolRuns.listByTurn(turnId).some((item) => item.toolRunId === toolRunId)) {
    storage.chatToolRuns.create({ toolRunId, turnId, sessionId, toolName: "verification.recorded_opencode_report",
      status: "executed", args: { fixture: "display-only; no process execution" },
      result: { fixture: "display-only", externalAgent: RECORDED_OPENCODE_REPORT },
      effectPotential: "none", effectDisposition: "none", effectOutcomeKind: "none",
      effectEvidence: { version: TOOL_EFFECT_CLASSIFICATION_VERSION, outcomeKind: "none", reason: "trusted_safe_read", refs: [] },
      startedAt: trace.finishedAt, finishedAt: trace.finishedAt });
  }
  return { citationId, toolRunId };
}

/** Terminal historical presentation only; no child admission or dispatch. */
export function seedDelegationDisplayRecords(storage, { workspaceId, sessionId, turnId }) {
  assert.equal(storage.chatSessionMeta.get(sessionId)?.workspaceId, workspaceId);
  assert.equal(storage.chatSessionBranchState.get(sessionId)?.activeLeafTurnId, turnId);
  const trace = storage.chatTurnTraces.get(turnId);
  assert.equal(trace.sessionId, sessionId);
  assert.equal(trace.status, "completed");
  assert.ok(!trace.orchestration, "Never replace existing recorded orchestration");
  const identity = createHash("sha256").update(`${workspaceId}\n${sessionId}\n${turnId}`).digest("hex").slice(0, 24);
  const runId = `cockpit-display-delegation-${identity}`;
  const objective = "Recorded browser fixture: inspect retained delegation; no delegated turn executed.";
  const steps = [
    { role: "Architect", label: "Recorded planning step", status: "completed", output: "Recorded fixture plan only." },
    { role: "QA", label: "Recorded verification step", status: "failed", output: "Recorded fixture verification failed; no execution claimed." },
  ].map((step, index) => ({ ...step, stepId: `${runId}-step-${index}`, runId, index,
    startedAt: trace.finishedAt, finishedAt: trace.finishedAt }));
  storage.chatDelegationRuns.create({ runId, sessionId, taskId: `${runId}-task`, objective,
    roles: steps.map((step) => step.role), mode: "sequential", status: "partial",
    finalSummary: objective, startedAt: trace.finishedAt, finishedAt: trace.finishedAt });
  for (const step of steps) storage.chatDelegationSteps.create(step);
  const routeDecision = { modePolicy: "chat", workflowTemplate: "verification_recorded_display", hidden: false,
    visibility: "explicit", intensity: "minimal", providerPreference: "balanced", reviewDepth: "standard",
    parallelism: "sequential", selectedRoles: steps.map((step) => step.role), selectedProviders: [], triggerReason: "Display-only fixture" };
  storage.chatTurnTraces.patch(turnId, { orchestration: { runId, objective, workflowTemplate: routeDecision.workflowTemplate,
    status: "partial", modePolicy: "chat", visibility: "explicit", routeDecision, finalSummary: objective,
    steps: steps.map(({ output, ...step }) => ({ ...step, summary: output })) } });
  return { runId, objective, steps };
}

export async function recordRenderingFixture(stack, scope, kind = "rendering") {
  assert.match(path.basename(stack.runtimeRoot ?? ""), /^goatcitadel-usability-/u);
  const runtimeRoot = await realpath(stack.runtimeRoot);
  const dbPath = await realpath(path.join(runtimeRoot, "data", "index.db"));
  const relative = path.relative(runtimeRoot, dbPath);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.ok((await stat(dbPath)).isFile());
  const { Storage } = await import(new URL("../../../../packages/storage/dist/index.js", import.meta.url));
  const storage = new Storage({ dbPath, transcriptsDir: path.join(runtimeRoot, "data", "transcripts"), auditDir: path.join(runtimeRoot, "data", "audit") });
  try {
    assert.ok(kind === "rendering" || kind === "delegation");
    return kind === "delegation" ? seedDelegationDisplayRecords(storage, scope) : seedRenderingRecords(storage, scope);
  }
  finally { storage.close(); }
}
