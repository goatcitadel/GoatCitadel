import assert from "node:assert/strict";
import { it } from "node:test";
import { buildFeatureAcceptanceProfile, FEATURE_ACCEPTANCE_PINS } from "./agent-comparison-acceptance-profile.mjs";
import { bindNativeComparisonConfig } from "./agent-comparison-native-profile.mjs";
import { createAcceptanceFaultControls } from "./agent-comparison-acceptance-faults.mjs";
import {
  bindNativeRecoveryConfiguration,
  readNativeRecoveryEffectObservation,
} from "./agent-comparison-native-recovery-binding.mjs";
import { sha256 } from "./agent-comparison.mjs";
import { bindRecoveryConfiguration as bindOpenclaw } from "./agent-comparison-openclaw-acceptance.mjs";
import { bindRecoveryConfiguration as bindHermes } from "./agent-comparison-hermes-acceptance.mjs";

function setup(product) {
  const profile = {
    revision: FEATURE_ACCEPTANCE_PINS[product],
    provider: "fixture",
    model: "fixture-model",
    reasoning: "none",
    tools: ["files", "fallback"],
    grants: ["test-workspace"],
    contextTokens: 64000,
    outputTokens: 4096,
    maxTaskMs: 600000,
  };
  const plan = buildFeatureAcceptanceProfile(product, profile, "provider_recovery", "max_tokens");
  const connection = {
    revision: profile.revision,
    effectiveConfigSha256: plan.effectiveConfigSha256,
    baseUrl: "http://127.0.0.1:31301/v1",
    apiKey: "controlled-proxy-key",
  };
  const config = bindNativeComparisonConfig(
    plan,
    connection,
    process.cwd(),
    product === "openclaw" ? { port: 31302, token: "a".repeat(64) } : undefined,
  );
  return {
    product,
    revision: profile.revision,
    config,
    connection,
    fixture: {
      url: "http://127.0.0.1:31303/mcp",
      nativeToolName: "record_marker",
      authType: "none",
      scope: "controlled_loopback_fixture",
    },
    deadlineAt: Date.now() + 60_000,
  };
}

for (const product of ["openclaw", "hermes"]) {
  it(`${product} binds one fallback and the reviewed marker through native config without mutating its input`, () => {
    const input = setup(product),
      before = sha256(input.config);
    const bound = (product === "openclaw" ? bindOpenclaw : bindHermes)(input);
    assert.equal(sha256(input.config), before);
    if (product === "openclaw") {
      assert.deepEqual(bound.agents.defaults.model.fallbacks, ["comparison-fallback/fixture-model"]);
      assert.deepEqual(bound.models.providers["comparison-fallback"], bound.models.providers.comparison);
      assert.equal(bound.models.providers["comparison-fallback"].models[0].maxTokens, 4096);
      assert.deepEqual(bound.mcp.servers["comparison-recovery"].toolFilter.include, ["record_marker"]);
      assert.equal(bound.mcp.servers["comparison-recovery"].requestTimeoutMs, 5000);
    } else {
      assert.equal(bound.fallback_providers.length, 1);
      assert.equal(bound.fallback_providers[0].base_url, input.connection.baseUrl);
      assert.equal(bound.providers["comparison-fallback"].extra_body.max_tokens, 4096);
      assert.equal(bound.mcp_servers["comparison-recovery"].timeout, 5);
    }
    // Only this explicitly reviewed fixture is added; native permission review remains separate.
    if (product === "openclaw") assert.deepEqual(bound.tools.allow,
      [...input.config.tools.allow, "comparison-recovery__record_marker"]);
    else assert.deepEqual(bound.toolsets, [...input.config.toolsets, "mcp-comparison-recovery"]);
  });

  it(`${product} rejects ambient transports, changed pins, existing fallback and expired scope`, () => {
    const input = setup(product);
    for (const change of [
      { revision: "b".repeat(40) },
      { deadlineAt: Date.now() - 1 },
      { fixture: { ...input.fixture, url: "https://third-party.invalid/mcp" } },
      { fixture: { ...input.fixture, url: "http://127.0.0.1:31303/mcp?token=forbidden" } },
      { connection: { ...input.connection, baseUrl: "http://localhost:31301/v1" } },
      { fixture: { ...input.fixture, scope: "ambient" } },
    ])
      assert.throws(() => bindNativeRecoveryConfiguration({ ...input, ...change }));
    const bound = bindNativeRecoveryConfiguration(input);
    assert.throws(() => bindNativeRecoveryConfiguration({ ...input, config: bound }), /changed/);
    const changedBudget = structuredClone(input.config);
    const ambientRoute = structuredClone(input.config);
    if (product === "openclaw") {
      changedBudget.models.providers.comparison.models[0].maxTokens = 8192;
      ambientRoute.models.providers.ambient = structuredClone(ambientRoute.models.providers.comparison);
    } else {
      changedBudget.providers.comparison.extra_body.max_tokens = 8192;
      ambientRoute.auxiliary.compression.base_url = "https://ambient.invalid/v1";
    }
    for (const config of [changedBudget, ambientRoute])
      assert.throws(() => bindNativeRecoveryConfiguration({ ...input, config }), /changed/);
  });

  it(`${product} joins real controlled lost responses without manufacturing native blocked status`, async (t) => {
    const receipts = [];
    const controls = await createAcceptanceFaultControls({
      cellId: `${product}:provider_recovery:1`,
      deadlineAt: Date.now() + 60_000,
      persistReceipt: async (receipt) => receipts.push(receipt),
    });
    t.after(() => controls.close());
    controls.bindRuntime("owned-native-test");
    const fixture = controls.enableReviewedPublicTransport({ runtimeId: "owned-native-test" });
    assert.equal(
      bindNativeRecoveryConfiguration({ ...setup(product), fixture }).mcp?.servers?.["comparison-recovery"]?.url ??
        bindNativeRecoveryConfiguration({ ...setup(product), fixture }).mcp_servers["comparison-recovery"].url,
      fixture.url,
    );
    controls.bindEffectTool({ runtimeId: "owned-native-test", toolName: "discovered-marker-alias" });
    const armed = controls.armUncertainEffect({ runtimeId: "owned-native-test" });
    const listed = await fetch(fixture.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((response) => response.json());
    const args = { marker: listed.result.tools[0].inputSchema.properties.marker.const };
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
    const observation = readNativeRecoveryEffectObservation({
      controls,
      runtimeId: "owned-native-test",
      effectId: "controlled-native-tool-call-id",
      toolName: armed.toolName,
      argsSha256: armed.argsSha256,
    });
    assert.equal(observation.dispatches.length, 1);
    assert.equal(observation.automaticRetries, 0);
    assert.equal(observation.nativeReconciliationVerified, false);
    assert.equal(observation.status, undefined);
    assert.equal(receipts.filter((receipt) => receipt.kind === "controlled_effect_dispatch").length, 1);
    assert.throws(() =>
      readNativeRecoveryEffectObservation({
        controls,
        runtimeId: "another-runtime",
        effectId: "controlled-native-tool-call-id",
        toolName: armed.toolName,
        argsSha256: armed.argsSha256,
      }),
    );
  });
}
