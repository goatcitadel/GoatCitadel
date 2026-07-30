import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LIVE_PROVIDER_GATEWAY_ENV,
  buildLiveChatMutation,
  completeLiveProviderSourceState,
  consumeCompleteSseFrames,
  ensureLiveProviderOnboardingComplete,
  validateLiveProviderProbe,
  writeOpenAICodexProviderConfig,
} from "./live-provider-preqa.mjs";

const LIVE_SOURCE_STATE = Object.freeze({
  mode: "final",
  baseSha: "a".repeat(40),
  sourceModified: false,
  diffSha256: "b".repeat(64),
  changedPathCount: 0,
});

test("live provider lane deliberately enables only the OS keychain boundary", () => {
  assert.equal(LIVE_PROVIDER_GATEWAY_ENV.GOATCITADEL_DISABLE_SECRET_STORE, "false");
  assert.equal(LIVE_PROVIDER_GATEWAY_ENV.GOATCITADEL_AUTH_MODE, "token");
  assert.equal(
    Object.keys(LIVE_PROVIDER_GATEWAY_ENV).some((key) => /api.*key|refresh.*token|access.*token/iu.test(key)),
    false,
  );
});

test("live provider onboarding retries only the exact config-generation reconciliation conflict", async () => {
  const exactConflict = {
    ok: false,
    status: 409,
    body: {
      code: "STATE_CONFLICT",
      error: "Settings are temporarily unavailable while runtime owners reconcile a config generation.",
    },
  };
  const calls = [];
  const responses = [
    exactConflict,
    { ok: true, status: 200, body: { completed: false } },
    { ok: true, status: 200, body: { completed: true } },
  ];
  await ensureLiveProviderOnboardingComplete("http://fixture", {
    requestJson: async (_url, route, init) => {
      calls.push({ route, method: init?.method ?? "GET" });
      return responses.shift();
    },
    delay: async () => undefined,
  });
  assert.deepEqual(calls, [
    { route: "/api/v1/onboarding/state", method: "GET" },
    { route: "/api/v1/onboarding/state", method: "GET" },
    { route: "/api/v1/onboarding/complete", method: "POST" },
  ]);

  await assert.rejects(
    ensureLiveProviderOnboardingComplete("http://fixture", {
      requestJson: async () => ({ ok: false, status: 409, body: { code: "STATE_CONFLICT", error: "other" } }),
      delay: async () => undefined,
    }),
    /read live-provider onboarding state failed/u,
  );
});

test("live Chat mutations disable personal context and retain exact action lineage", () => {
  const retry = buildLiveChatMutation({
    action: "retry",
    content: "Reply with exactly: CHAT_OK",
    model: "gpt-5.6-sol",
    sourceTurnId: "turn-source",
  });
  assert.equal(retry.action, "retry");
  assert.equal(retry.preflight.turnId, "turn-source");
  assert.deepEqual(retry.body.prefsOverride, {
    providerId: "openai-codex",
    model: "gpt-5.6-sol",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "off",
    subagentPolicy: "off",
    toolAutonomy: "manual",
    orchestrationEnabled: false,
  });
  assert.equal(retry.body.webMode, "off");
  assert.equal(retry.body.memoryMode, "off");
  assert.equal(retry.body.subagentPolicy, "off");
  assert.equal(buildLiveChatMutation({ action: "branch-send", content: "x", model: "gpt-5.6-sol" }).action, "send");
  assert.throws(() => buildLiveChatMutation({ action: "unknown", content: "x", model: "m" }), /unsupported/u);
});

test("live provider proof requires exact terminal content, provider, and model", () => {
  const turn = {
    assistantMessage: { content: "CHAT_OK" },
    trace: {
      status: "completed",
      routing: { effectiveProviderId: "openai-codex", effectiveModel: "gpt-5.6-sol" },
    },
  };
  assert.doesNotThrow(() =>
    validateLiveProviderProbe(turn, {
      action: "send",
      expectedReply: "CHAT_OK",
      expectedModel: "gpt-5.6-sol",
    }),
  );
  assert.throws(
    () =>
      validateLiveProviderProbe(
        { ...turn, assistantMessage: { content: "almost" } },
        { action: "send", expectedReply: "CHAT_OK", expectedModel: "gpt-5.6-sol" },
      ),
    /did not equal/u,
  );
  assert.throws(
    () =>
      validateLiveProviderProbe(
        { ...turn, trace: { ...turn.trace, status: "failed" } },
        { action: "send", expectedReply: "CHAT_OK", expectedModel: "gpt-5.6-sol" },
      ),
    /status was failed/u,
  );
});

test("live cancellation consumes only complete SSE frames and retains an incomplete tail", () => {
  const first = 'data: {"type":"message_start","turnId":"turn-1"}\r\n\r\n';
  const partial = 'data: {"type":"delta","turnId":"turn-1"';
  assert.deepEqual(consumeCompleteSseFrames(first + partial), {
    events: [{ type: "message_start", turnId: "turn-1" }],
    remainder: partial,
  });
  assert.deepEqual(consumeCompleteSseFrames(partial), { events: [], remainder: partial });
  assert.throws(() => consumeCompleteSseFrames(null), /must be a string/u);
});

test("isolated ChatGPT provider config contains no credential material", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-live-provider-config-"));
  try {
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "goatcitadel.json"), '{"generation":{"id":"stale"}}\n', "utf8");
    const llm = await writeOpenAICodexProviderConfig(root, "gpt-5.6-sol");
    assert.equal(llm.activeProviderId, "openai-codex");
    assert.equal(llm.activeModel, "gpt-5.6-sol");
    assert.deepEqual(llm.providers[0], {
      providerId: "openai-codex",
      label: "OpenAI Codex (ChatGPT OAuth)",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiStyle: "openai-codex-responses",
      defaultModel: "gpt-5.6-sol",
      authMode: "codex-oauth",
    });
    const unified = JSON.parse(await fs.readFile(path.join(root, "config", "goatcitadel.json"), "utf8"));
    assert.equal(unified.generation, undefined);
    assert.deepEqual(unified.llm, llm);
    assert.doesNotMatch(JSON.stringify(llm), /accessToken|refreshToken|apiKey/iu);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("live provider source completion fails and retains evidence when HEAD changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-live-provider-source-"));
  try {
    const artifactRoot = path.join(root, "run");
    await fs.mkdir(path.join(artifactRoot, "diagnostics"), { recursive: true });
    const completedSourceState = { ...LIVE_SOURCE_STATE, baseSha: "c".repeat(40) };

    const result = await completeLiveProviderSourceState({ artifactRoot }, LIVE_SOURCE_STATE, {
      repoRoot: root,
      snapshotUsabilitySourceState: () => completedSourceState,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error, /source changed during verification \(baseSha\)/u);
    assert.deepEqual(result.artifacts.diagnostics, ["diagnostics/live-provider-source-state.json"]);
    const proof = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "diagnostics", "live-provider-source-state.json"), "utf8"),
    );
    assert.deepEqual(proof, {
      schemaVersion: 1,
      started: LIVE_SOURCE_STATE,
      completed: completedSourceState,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("live provider source integrity runs after redaction and before finalization", async () => {
  const source = await fs.readFile(new URL("./live-provider-preqa.mjs", import.meta.url), "utf8");
  const redactionIndex = source.indexOf('id: "live-provider.artifact-redaction"');
  const sourceIntegrityIndex = source.indexOf('id: "live-provider.source-integrity"');
  const finalizeIndex = source.indexOf("const manifest = await finalizeRunContext", sourceIntegrityIndex);
  assert.ok(redactionIndex > 0);
  assert.ok(sourceIntegrityIndex > redactionIndex);
  assert.ok(finalizeIndex > sourceIntegrityIndex);
});
