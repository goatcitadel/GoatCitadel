import assert from "node:assert/strict";
import test from "node:test";

import { startDeterministicLlmStub } from "./deterministic-llm-stub.mjs";

test("deterministic provider serves a valid PNG through the image-generation route", async () => {
  const stub = await startDeterministicLlmStub();
  try {
    const response = await fetch(`${stub.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, prompt: "fixture image", response_format: "b64_json" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    const bytes = Buffer.from(payload.data[0].b64_json, "base64");
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(stub.imageGenerationDispatches(), 1);
    assert.equal(JSON.stringify(stub.requestSummaries()).includes("fixture image"), false);
  } finally {
    await stub.close();
  }
});

test("scripted tool calls retain a full research-deck payload while bounding pathological arguments", async () => {
  const accepted = { title: "Fixture", evidence: "x".repeat(24_000) };
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [{ type: "tool_call", name: "presentations_create", arguments: accepted }],
  });
  try {
    const response = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, input: "fixture" }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /presentations_create/u);
  } finally {
    await stub.close();
  }

  await assert.rejects(
    startDeterministicLlmStub({
      dispatchPlan: [{ type: "tool_call", name: "presentations_create", arguments: { evidence: "x".repeat(128_001) } }],
    }),
    /no more than 128000 characters/u,
  );
});

test("scripted Responses provider emits a native server_error then succeeds without retaining prompt text", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [
      { type: "provider_error", code: "server_error", message: "Synthetic transient failure." },
      { type: "success", replyText: "RECOVERED" },
    ],
  });
  try {
    const requestBody = {
      model: stub.model,
      stream: true,
      input: [{ role: "user", content: "fixture prompt must not be retained" }],
    };
    const failed = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(failed.status, 200);
    const failedBody = await failed.text();
    assert.match(failedBody, /"type":"response\.failed"/u);
    assert.match(failedBody, /"code":"server_error"/u);

    const succeeded = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(succeeded.status, 200);
    assert.match(await succeeded.text(), /RECOVERED/u);
    assert.equal(stub.completionDispatches(), 2);
    assert.deepEqual(
      stub.completionDispatchRecords().map((entry) => entry.outcome),
      ["provider_error", "success"],
    );
    assert.equal(JSON.stringify(stub.requestSummaries()).includes("fixture prompt"), false);
  } finally {
    await stub.close();
  }
});

test("replaceDispatchPlan re-arms the next deterministic completion after fixture setup traffic", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [{ type: "success", replyText: "SETUP" }],
  });
  const request = () =>
    fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, messages: [{ role: "user", content: "fixture" }] }),
    });
  try {
    assert.match(await (await request()).text(), /SETUP/u);
    stub.replaceDispatchPlan([{ type: "http_error", status: 503, code: "rearmed" }]);
    const rearmed = await request();
    assert.equal(rearmed.status, 503);
    assert.match(await rearmed.text(), /rearmed/u);
    assert.equal(stub.dispatchPlanDispatches(), 1);
  } finally {
    await stub.close();
  }
});

test("scripted tool calls use native Responses and Chat Completions protocols", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [
      { type: "tool_call", name: "presentations_create", arguments: { title: "Fixture deck" }, callId: "call_deck" },
      { type: "tool_call", name: "browser_search", arguments: { query: "fixture" }, callId: "call_search" },
    ],
  });
  try {
    const responses = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, stream: true, input: "fixture" }),
    });
    const responsesBody = await responses.text();
    assert.match(responsesBody, /"type":"response\.output_item\.done"/u);
    assert.match(responsesBody, /"name":"presentations_create"/u);
    assert.match(responsesBody, /"call_id":"call_deck"/u);

    const chat = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, messages: [{ role: "user", content: "fixture" }] }),
    });
    const chatBody = await chat.json();
    assert.equal(chatBody.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(chatBody.choices[0].message.tool_calls, [
      {
        id: "call_search",
        type: "function",
        function: { name: "browser_search", arguments: '{"query":"fixture"}' },
      },
    ]);
  } finally {
    await stub.close();
  }
});

test("prompt reply rules survive auxiliary dispatches without retaining matched prompt content", async () => {
  const stub = await startDeterministicLlmStub({
    replyText: "AUXILIARY_OK",
    promptReplyRules: [
      {
        ruleId: "researcher-role",
        userContentIncludes: "Assigned role: researcher",
        replyText: "RESEARCHER_OK",
      },
    ],
  });
  const request = async (content, systemContent) => {
    const response = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: stub.model,
        messages: [...(systemContent ? [{ role: "system", content: systemContent }] : []), { role: "user", content }],
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).choices[0].message.content;
  };
  try {
    assert.equal(await request("Auxiliary fixture request."), "AUXILIARY_OK");
    assert.equal(await request("Assigned role: researcher\nsecret fixture prompt"), "RESEARCHER_OK");
    assert.equal(await request("Assigned role: researcher\nsecond secret fixture prompt"), "RESEARCHER_OK");
    assert.deepEqual(
      stub.completionDispatchRecords().map((entry) => entry.promptReplyRuleId),
      [undefined, "researcher-role", "researcher-role"],
    );
    const summaries = JSON.stringify(stub.requestSummaries());
    assert.equal(summaries.includes("secret fixture prompt"), false);
    assert.equal(summaries.includes("second secret fixture prompt"), false);

    stub.replacePromptReplyRules([
      {
        ruleId: "reviewer-role",
        userContentIncludes: "Assigned role: reviewer",
        replyText: "REVIEWER_OK",
      },
    ]);
    assert.equal(await request("Assigned role: researcher"), "AUXILIARY_OK");
    assert.equal(await request("Assigned role: reviewer"), "REVIEWER_OK");

    stub.replacePromptReplyRules([
      {
        ruleId: "context-distiller",
        systemContentIncludes: "Only use provided evidence.",
        replyText: "DISTILLER_OK",
      },
    ]);
    assert.equal(await request("opaque fixture", "Only use provided evidence. Return JSON."), "DISTILLER_OK");
    const metadata = stub.completionDispatchRecords().at(-1)?.promptMetadata;
    assert.deepEqual(metadata?.roles, ["system", "user"]);
    assert.equal(metadata?.userContentByteLength, Buffer.byteLength("opaque fixture"));
    assert.match(metadata?.userContentSha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(metadata).includes("opaque fixture"), false);
    assert.equal(JSON.stringify(stub.requestSummaries()).includes("Only use provided evidence"), false);
  } finally {
    await stub.close();
  }
});

test("prompt reply rules require exactly one privacy-safe role matcher", async () => {
  await assert.rejects(
    startDeterministicLlmStub({ promptReplyRules: [{ ruleId: "missing", replyText: "x" }] }),
    /exactly one/u,
  );
  await assert.rejects(
    startDeterministicLlmStub({
      promptReplyRules: [
        {
          ruleId: "ambiguous",
          userContentIncludes: "user",
          systemContentIncludes: "system",
          replyText: "x",
        },
      ],
    }),
    /exactly one/u,
  );
});

test("scripted stream disconnect exposes one partial frame and never synthesizes a terminal marker", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [{ type: "stream_disconnect", emittedText: "PARTIAL" }],
  });
  try {
    const response = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, stream: true, messages: [{ role: "user", content: "fixture" }] }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /PARTIAL/u);
    await assert.rejects(reader.read());
    await stub.waitForCompletionDispatchCount(1);
    assert.equal(stub.completionDispatches(), 1);
    assert.equal(stub.completionDispatchRecords()[0]?.behavior, "stream_disconnect");
  } finally {
    await stub.close();
  }
});

test("scripted stream stall can expose one partial frame before the client disconnects", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [{ type: "stream_stall", emittedText: "STREAMING_BEFORE_RESTART" }],
  });
  const controller = new AbortController();
  try {
    const response = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, stream: true, input: "fixture" }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /STREAMING_BEFORE_RESTART/u);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await stub.waitForCompletionDispatchCount(1);
    assert.equal(stub.completionDispatchRecords()[0]?.behavior, "stream_stall");
  } finally {
    controller.abort();
    await stub.close();
  }
});

test("listenHost can bind a wildcard while publicBaseUrlHost advertises a safe Docker-reachable host", async () => {
  const stub = await startDeterministicLlmStub({
    listenHost: "0.0.0.0",
    publicBaseUrlHost: "host.docker.internal",
    replyText: "BOUND_OK",
  });
  try {
    assert.equal(stub.listenHost, "0.0.0.0");
    assert.equal(stub.publicBaseUrlHost, "host.docker.internal");
    assert.match(stub.baseUrl, /^http:\/\/host\.docker\.internal:\d+\/v1$/u);
    const response = await fetch(`http://127.0.0.1:${stub.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, messages: [{ role: "user", content: "fixture" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "BOUND_OK");
  } finally {
    await stub.close();
  }
});

test("dispatchPlanModel isolates fault dispatches from auxiliary Responses requests", async () => {
  const stub = await startDeterministicLlmStub({
    model: "fault-model",
    dispatchPlanModel: "fault-model",
    dispatchPlan: [{ type: "provider_error", code: "server_error" }],
    replyText: "AUXILIARY_OK",
  });
  try {
    const auxiliary = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "title-model", input: "fixture", stream: false }),
    });
    assert.equal(auxiliary.status, 200);
    const auxiliaryBody = await auxiliary.json();
    assert.equal(auxiliaryBody.object, "response");
    assert.equal(auxiliaryBody.output[0].content[0].text, "AUXILIARY_OK");
    assert.equal(stub.completionDispatches(), 1);
    assert.equal(stub.dispatchPlanDispatches(), 0);

    const faultTarget = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fault-model", input: "fixture", stream: true }),
    });
    assert.equal(faultTarget.status, 200);
    assert.match(await faultTarget.text(), /server_error/u);
    assert.equal(stub.completionDispatches(), 2);
    assert.equal(stub.dispatchPlanDispatches(), 1);
    assert.equal(stub.dispatchPlanDispatchRecords().length, 1);
  } finally {
    await stub.close();
  }
});

test("expectedAuthorization rejects invalid provider credentials without dispatching a completion", async () => {
  const stub = await startDeterministicLlmStub({
    expectedAuthorization: "Bearer verification-key",
    replyText: "AUTH_OK",
  });
  try {
    const rejected = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
      body: JSON.stringify({ model: stub.model, messages: [{ role: "user", content: "fixture" }] }),
    });
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), {
      error: {
        message: "Synthetic provider credential rejected.",
        type: "invalid_api_key",
        code: "invalid_api_key",
      },
    });
    assert.equal(stub.completionDispatches(), 0);

    const accepted = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer verification-key" },
      body: JSON.stringify({ model: stub.model, messages: [{ role: "user", content: "fixture" }] }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).choices[0].message.content, "AUTH_OK");
    assert.equal(stub.completionDispatches(), 1);
    assert.deepEqual(
      stub.requestSummaries().map((entry) => entry.outcome),
      ["credential_rejected", "success"],
    );
  } finally {
    await stub.close();
  }
});

test("listen and advertised host validation rejects unsafe or unusable values", async () => {
  await assert.rejects(startDeterministicLlmStub({ listenHost: "192.168.1.20" }), /listenHost/u);
  await assert.rejects(
    startDeterministicLlmStub({ publicBaseUrlHost: "http://host.docker.internal/path" }),
    /publicBaseUrlHost/u,
  );
  await assert.rejects(startDeterministicLlmStub({ publicBaseUrlHost: "0.0.0.0" }), /cannot advertise/u);
});
