import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "./agent-comparison.mjs";
import { FEATURE_ACCEPTANCE_PINS } from "./agent-comparison-acceptance-profile.mjs";
import { createAcceptanceFaultControls } from "./agent-comparison-acceptance-faults.mjs";
import { createAcceptanceActions as openclawActions } from "./agent-comparison-openclaw-acceptance.mjs";
import { createAcceptanceActions as hermesActions } from "./agent-comparison-hermes-acceptance.mjs";
import { nativeComparisonPermissions } from "./agent-comparison-permissions.mjs";
import {
  readOpenclawRecoveryEvidence,
  readHermesRecoveryEvidence,
  projectNativeRecoveryOutcome,
} from "./agent-comparison-native-recovery-evidence.mjs";

function native(product, workspace, prompt, index, tool, previous) {
  const at = new Date().toISOString(),
    sessionId = `native-session-${index}`;
  if (product === "openclaw") {
    const runId = `native-run-${index}`,
      sessionKey = `agent:main:recovery-${index}`;
    const messages = [{ role: "user", content: prompt }];
    if (tool)
      messages.push(
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "marker-call", name: tool.name, arguments: tool.args }],
        },
        {
          role: "toolResult",
          toolCallId: "marker-call",
          toolName: tool.name,
          timestamp: at,
          isError: true,
          content: [{ type: "text", text: "Response lost" }],
        },
      );
    return {
      sessionKey,
      result: {
        status: "ok",
        runId,
        result: {
          meta: {
            agentMeta: {
              sessionId,
              terminalReceipt: {
                runId,
                turnId: runId,
                sessionId,
                requested: { provider: "comparison", model: "fixture-model" },
                effective: { provider: "comparison-fallback", model: "fixture-model" },
              },
            },
            systemPromptReport: { source: "run", sessionKey, sessionId, workspaceDir: workspace },
            executionTrace: { attempts: [{ provider: "comparison", model: "fixture-model", result: "error" }] },
          },
        },
      },
      history: { sessionKey, sessionId, hasMore: false, messages },
    };
  }
  const old = previous?.transcript?.messages ?? [],
    messages = [...old];
  const message = (fields) =>
    messages.push({ id: messages.length + 1, session_id: sessionId, active: 1, timestamp: at, ...fields });
  message({ role: "user", content: prompt });
  if (tool) {
    message({
      role: "assistant",
      tool_calls: JSON.stringify([
        { id: "marker-call", function: { name: tool.name, arguments: JSON.stringify(tool.args) } },
      ]),
    });
    message({
      role: "tool",
      tool_call_id: "marker-call",
      tool_name: tool.name,
      content: "response lost",
      effect_disposition: "unknown",
    });
  }
  message({ role: "assistant", content: "I switched provider and blocked safely", finish_reason: "stop" });
  return {
    process: { exitCode: 0, cleanupUnconfirmed: false },
    transcript: {
      status: "retained",
      sessions: [
        ...(previous?.transcript?.sessions ?? []),
        { id: sessionId, source: "cli", model: "fixture-model", billing_provider: "custom", cwd: workspace },
      ],
      messages,
    },
  };
}

it("reads exact OpenClaw native route and refuses stale, foreign or incomplete receipts", () => {
  const context = { model: "fixture-model", workspace: process.cwd(), prompt: "fixture prompt" };
  const receipt = native("openclaw", context.workspace, context.prompt, 1);
  const value = readOpenclawRecoveryEvidence(receipt, context);
  assert.equal(value.providerId, "comparison-fallback");
  assert.equal(value.reconciliation.status, "unavailable");
  for (const mutate of [
    (item) => (item.result.result.meta.agentMeta.terminalReceipt.runId = "another-run"),
    (item) => (item.history.hasMore = true),
    (item) => item.history.messages.push({ role: "user", content: context.prompt }),
    (item) => (item.result.result.meta.systemPromptReport.workspaceDir = path.dirname(context.workspace)),
    (item) => (item.result.result.meta.executionTrace.attempts[0].model = "unapproved-model"),
    (item) => (item.result.result.meta.executionTrace.attempts[0].provider = "ambient-provider"),
    (item) =>
      (item.result.result.meta.executionTrace.attempts = Array(33).fill(
        item.result.result.meta.executionTrace.attempts[0],
      )),
    (item) => (item.result.result.meta.executionTrace.attempts = { forged: true }),
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.throws(() => readOpenclawRecoveryEvidence(changed, context));
  }
  const projected = projectNativeRecoveryOutcome(value, { observedAt: new Date().toISOString(), runtimeId: "owned" });
  assert.equal(projected.records.find((record) => record.kind === "provider_changed").surface, "native_rpc");
  assert.equal(
    projected.records.some((record) => record.kind === "reconciliation_required"),
    false,
  );
});

it("never derives Hermes fallback alias or canonical blocking from assistant text or effect disposition", () => {
  const context = { model: "fixture-model", workspace: process.cwd(), prompt: "fixture prompt" };
  const receipt = native("hermes", context.workspace, context.prompt, 1, { name: "marker", args: { marker: "nonce" } });
  const value = readHermesRecoveryEvidence(receipt, context);
  assert.equal(value.providerId, null);
  assert.equal(value.tools[0].nativeEffectDisposition, "unknown");
  assert.equal(value.reconciliation.status, "unavailable");
  const projected = projectNativeRecoveryOutcome(value, { observedAt: new Date().toISOString(), runtimeId: "owned" });
  assert.equal(
    projected.records.some((record) => ["provider_changed", "reconciliation_required"].includes(record.kind)),
    false,
  );
  receipt.process.cleanupUnconfirmed = true;
  assert.throws(() => readHermesRecoveryEvidence(receipt, context));
});

describe("controlled native recovery phases (no live product or model)", { concurrency: 2 }, () => {
  for (const product of ["openclaw", "hermes"])
    it(`${product} retains all phases and reports native proof gaps without minting a block`, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "native-recovery-phases-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const evidence = path.join(root, "evidence");
      await mkdir(evidence);
      const receipts = [],
        controls = await createAcceptanceFaultControls({
          cellId: `${product}:provider_recovery:1`,
          deadlineAt: Date.now() + 60_000,
          persistReceipt: async (receipt) => receipts.push(receipt),
        });
      t.after(() => controls.close());
      controls.bindRuntime("controlled-runtime");
      const fixture = controls.enableReviewedPublicTransport({ runtimeId: "controlled-runtime" });
      let count = 0,
        previous,
        setup;
      const supervisor = {
        start: async () => ({
          runtimeId: "controlled-runtime",
          stateId: "controlled-state",
          revision: FEATURE_ACCEPTANCE_PINS[product],
          workspace: root,
          configurationSha256: sha256("controlled-config"),
        }),
        reviewPermissions: async ({ configurationSha256 }) => ({
          configurationSha256,
          reviewedBy: "controlled-human",
          reviewedAt: new Date().toISOString(),
          policy: nativeComparisonPermissions(product, ["files", "fallback"]),
        }),
        armPreDispatchFailure: (input) => controls.armPreDispatchFailure(input),
        observeProviderFault: (input) => controls.observeProviderFault(input),
        armUncertainEffect: async (input) => {
          controls.bindEffectTool({ ...input, toolName: "marker-alias" });
          setup = controls.armUncertainEffect(input);
          return setup;
        },
        observeEffectTransport: (input) => controls.observeEffectTransport(input),
        stop: async () => {},
        runTurn: async ({ prompt }) => {
          let tool;
          if (++count === 1)
            await controls.consumeProviderFault({
              budgetSequence: 1,
              requestSha256: sha256("controlled-reservation"),
              startedAt: new Date().toISOString(),
            });
          else {
            const response = await fetch(fixture.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
            }).then((result) => result.json());
            const args = { marker: response.result.tools[0].inputSchema.properties.marker.const };
            await assert.rejects(
              fetch(fixture.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: { name: "record_marker", arguments: args },
                }),
              }),
            );
            tool = { name: setup.toolName, args };
          }
          const value = native(product, root, prompt, count, tool, previous);
          previous = value;
          return value;
        },
      };
      const options = { cellId: `${product}:provider_recovery:1` },
        session = {
          workspace: root,
          evidence,
          connectionFile: path.join(root, "connection.json"),
          binding: { revision: FEATURE_ACCEPTANCE_PINS[product], cellId: options.cellId },
        };
      const manifest = {
        products: { [product]: { revision: FEATURE_ACCEPTANCE_PINS[product], model: "fixture-model" } },
      };
      const actions = await (product === "openclaw" ? openclawActions : hermesActions)({
        session,
        manifest,
        options,
        supervisor,
      });
      t.after(() => actions.close());
      const phases = [];
      for (const method of ["arm_predispatch_failure", "run_turn", "run_uncertain_effect_case", "read_reconciliation"])
        phases.push(await actions[method]({ signal: new AbortController().signal }));
      assert.equal(count, 2);
      assert.equal(phases[2].records[0].outcome, "unknown_after_send");
      assert.equal(phases[3].records[0].kind, "native_reconciliation_unavailable");
      assert.equal(phases[3].records[0].dispatchCount, 1);
      assert.equal(
        phases.flatMap((phase) => phase.records).some((record) => record.kind === "reconciliation_required"),
        false,
      );
      assert.ok(phases.every((phase) => phase.nativeReceipts.length > 0));
      assert.equal(receipts.filter((receipt) => receipt.kind === "controlled_effect_dispatch").length, 1);
    });
});
