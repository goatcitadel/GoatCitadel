import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const RUNTIME_TRUTH_NOTE = "Approved runtime-truth read: Orion 7.";

/** Called only with the fresh runtime root returned by prepareVerificationRuntime. */
export async function prepareRuntimeTruthApproval(runtimeRoot) {
  const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.assistant.dataDir = "./data";
  config.assistant.durable.enabled = true;
  config.assistant.durable.executionEnabled = true;
  config.assistant.toolApprovalMode = "approve_all";
  delete config.generation;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const notePath = path.join(runtimeRoot, "workspace", "runtime-truth-approval-note.txt");
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, RUNTIME_TRUTH_NOTE, { flag: "wx" });
  return { notePath };
}

/** Exercise public Chat admission and tool governance; never manufacture a
 * waiting tool row, pending action, approval decision, or continuation receipt. */
export async function requestRuntimeTruthApproval(gatewayUrl, input, deps) {
  const { requestJson, assertOk } = deps;
  const route = `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}`;
  const prefs = await requestJson(gatewayUrl, `${route}/prefs`);
  assertOk(prefs, "read runtime-truth session preferences");
  const controls = {
    providerId: input.llmStub.providerId,
    model: input.llmStub.model,
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "off",
    subagentPolicy: "off",
    toolAutonomy: "safe_auto",
    orchestrationEnabled: false,
  };
  assertOk(
    await requestJson(gatewayUrl, `${route}/prefs`, {
      method: "PATCH",
      body: { ...controls, expectedRevision: prefs.body.revision },
    }),
    "set isolated runtime-truth preferences",
  );
  const content = `Use fs.read to read the fixture file at ${input.notePath}, then report its contents.`;
  const request = {
    action: "send",
    content,
    providerId: controls.providerId,
    model: controls.model,
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "off",
    subagentPolicy: "off",
    prefsOverride: controls,
  };
  const preflight = await requestJson(gatewayUrl, `${route}/route-preflight`, { method: "POST", body: request });
  assertOk(preflight, "preflight runtime-truth tool request");
  assert.ok(preflight.body?.decision, "runtime-truth preflight omitted its route decision");
  input.llmStub.replaceDispatchPlan([
    { type: "tool_call", name: "fs_read", arguments: { path: input.notePath }, callId: "runtime_truth_read" },
  ]);
  const controller = new AbortController();
  let streamOutcome;
  const reading = fetch(`${gatewayUrl}${route}/agent-send/stream`, {
    method: "POST",
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    headers: { Accept: "text/event-stream", "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ ...request, routeDecision: preflight.body.decision }),
  })
    .then(async (response) => {
      streamOutcome = { status: response.status };
      const text = await response.text();
      streamOutcome = { status: response.status, tail: text.slice(-2_000) };
    })
    .catch((error) => {
      streamOutcome = { error: error.message };
    });
  const transport = {
    close: async () => {
      controller.abort();
      await reading;
    },
  };
  let thread;
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      thread = await requestJson(gatewayUrl, `${route}/thread`);
      assertOk(thread, "read runtime-truth approval thread");
      const turn = thread.body?.turns?.find((entry) => entry.userMessage?.content === content);
      if (turn?.trace?.status === "waiting_for_approval") {
        const tools = (turn.toolRuns ?? []).filter((tool) => tool.toolName === "fs.read");
        assert.equal(tools.length, 1, "runtime-truth must park exactly one real file read");
        const tool = tools[0];
        assert.equal(tool.status, "approval_required");
        assert.ok(tool.approvalId, "runtime-truth tool omitted its canonical approval");
        assert.equal(tool.result, undefined, "runtime-truth tool executed before approval");
        assert.equal(tool.args?.path, input.notePath);
        assert.ok(turn.trace.durable?.runId, "runtime-truth approval omitted its durable Chat identity");
        input.llmStub.replaceDispatchPlan([]);
        return {
          transport,
          approval: {
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            turnId: turn.turnId,
            userMessageId: turn.userMessage.messageId,
            toolRunId: tool.toolRunId,
            approvalId: tool.approvalId,
            chatTurnDurableRunId: turn.trace.durable.runId,
            source: "public_chat_tool_request",
          },
        };
      }
      if (turn && ["failed", "completed", "cancelled", "partial"].includes(turn.trace?.status))
        throw new Error(
          `runtime-truth tool request settled before approval: ${JSON.stringify({
            status: turn.trace.status,
            failure: turn.trace.failure,
            toolRuns: turn.toolRuns,
            providerRequests: input.llmStub.requestSummaries(),
            streamOutcome,
          })}`,
        );
      if (streamOutcome?.error || (streamOutcome?.status && streamOutcome.status !== 200))
        throw new Error(`runtime-truth Chat stream failed: ${JSON.stringify(streamOutcome)}`);
      await delay(250);
    }
    throw new Error(`runtime-truth request did not establish an approval wait; observed ${thread?.status}`);
  } catch (error) {
    try {
      await deps.captureFailure?.({
        error: error.message,
        turn: thread?.body?.turns?.find((entry) => entry.userMessage?.content === content),
        providerRequests: input.llmStub.requestSummaries(),
        streamOutcome,
      });
    } finally {
      await transport.close();
    }
    throw error;
  }
}

export function assertRuntimeTruthToolCompletion(thread, approval, notePath) {
  const turn = thread?.turns?.find((entry) => entry.turnId === approval.turnId);
  assert.ok(turn, "runtime-truth lost the original Chat turn");
  assert.equal(turn.trace?.status, "completed");
  assert.equal(turn.trace?.durable?.runId, approval.chatTurnDurableRunId);
  assert.ok(turn.assistantMessage?.messageId, "runtime-truth omitted its persisted assistant response");
  const tools = (turn.toolRuns ?? []).filter((tool) => tool.toolName === "fs.read");
  assert.equal(tools.length, 1, "runtime-truth duplicated its governed file read");
  assert.equal(tools[0].toolRunId, approval.toolRunId);
  assert.equal(tools[0].approvalId, approval.approvalId);
  assert.equal(tools[0].status, "executed");
  assert.equal(tools[0].args?.path, notePath);
  assert.ok(
    JSON.stringify(tools[0].result ?? null).includes(RUNTIME_TRUTH_NOTE),
    "runtime-truth read lacks fixture contents",
  );
  return {
    turnId: turn.turnId,
    assistantMessageId: turn.assistantMessage.messageId,
    toolRunId: tools[0].toolRunId,
    toolStatus: tools[0].status,
  };
}
