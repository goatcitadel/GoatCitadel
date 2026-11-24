import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startDeterministicLlmStub, writeDeterministicLlmProviderConfig } from "./deterministic-llm-stub.mjs";

test("a cancelled fixture upload leaves the provider available", async () => {
  const stub = await startDeterministicLlmStub();
  try {
    const upload = httpRequest(`${stub.baseUrl}/responses`, { method: "POST" });
    upload.on("error", () => undefined);
    const sent = new Promise((resolve, reject) => {
      upload.on("error", reject);
      upload.write('{"input":', resolve);
    });
    try {
      await sent;
      await delay(20);
    } finally {
      upload.destroy();
    }
    const response = await fetch(`${stub.baseUrl}/models`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, stub.model);
    assert.equal(stub.completionDispatches(), 0);
  } finally {
    await stub.close();
  }
});

test("controlled display streams hold, advance exact chunks, finish and release their controller", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [{ type: "stream_controlled", chunks: ["First\n\n", "\nSecond " + "fragment ".repeat(160)] }],
  });
  try {
    const response = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, stream: true, messages: [] }),
    });
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let source = decoder.decode((await reader.read()).value);
    assert.match(source, /First/);
    assert.doesNotMatch(source, /Second|DONE/);
    assert.equal(stub.advanceControlledStream(), true);
    source += decoder.decode((await reader.read()).value);
    assert.match(source, /Second/);
    assert.equal(stub.advanceControlledStream(), false);
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      source += decoder.decode(part.value);
    }
    assert.match(source, /DONE/);
    const frames = source
      .split("\n\n")
      .filter((event) => event.startsWith("data: {"))
      .map((event) => JSON.parse(event.slice(6)));
    assert.equal(frames.at(-1).usage.prompt_tokens_details.cached_tokens, 0);
    const deltas = frames.map((frame) => frame.choices[0].delta.content ?? "");
    assert.ok(deltas.every((delta) => delta.length <= 128));
    assert.equal(deltas.join(""), "First\n\n\nSecond " + "fragment ".repeat(160));
    assert.throws(() => stub.advanceControlledStream(), /found 0/);
  } finally {
    await stub.close();
  }
});

test("deterministic provider metadata supports Chat thinking off", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goat-stub-reasoning-"));
  try {
    const configRoot = path.join(runtimeRoot, "config");
    await fs.mkdir(configRoot);
    await fs.writeFile(path.join(configRoot, "llm-model-metadata.json"), '{"version":1,"entries":{}}\n');
    await writeDeterministicLlmProviderConfig(runtimeRoot, "http://127.0.0.1:12345/v1");
    const metadata = JSON.parse(await fs.readFile(path.join(configRoot, "llm-model-metadata.json"), "utf8"));
    assert.deepEqual(metadata.entries["verification-stub/verification-stub-chat"].reasoning.supportedEfforts, [
      "none",
      "low",
      "medium",
      "high",
    ]);
    const config = JSON.parse(await fs.readFile(path.join(configRoot, "llm-providers.json"), "utf8"));
    assert.deepEqual(config.providers[0].capabilities, {
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high"],
    });
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("controlled display rejects incompatible requests before consuming its dispatch", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [{ type: "stream_controlled", chunks: ["fixture", "more"] }],
  });
  try {
    for (const [route, stream] of [
      ["chat/completions", false],
      ["responses", true],
    ]) {
      const response = await fetch(`${stub.baseUrl}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: stub.model, stream }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.type, "invalid_request_error");
    }
    assert.equal(stub.dispatchPlanDispatches(), 0);
  } finally {
    await stub.close();
  }
});

test("stream-only dispatch plans are not consumed by background non-stream requests", async () => {
  const stub = await startDeterministicLlmStub({
    replyText: "Background",
    dispatchPlanStreamOnly: true,
    dispatchPlan: [{ type: "success", replyText: "Visible answer" }],
  });
  try {
    for (const stream of [false, true]) {
      const response = await fetch(`${stub.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: stub.model, stream, messages: [{ role: "user", content: "fixture" }] }),
      });
      const body = await response.text();
      const content = stream
        ? body
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "")
            .join("")
        : JSON.parse(body).choices[0].message.content;
      assert.equal(content, stream ? "Visible answer" : "Background");
    }
    assert.equal(stub.dispatchPlanDispatches(), 1);
  } finally {
    await stub.close();
  }
});

test("deterministic text and tool replies declare zero cached input for settled model cost", async () => {
  for (const route of ["responses", "chat/completions"]) {
    for (const stream of [false, true]) {
      for (const behavior of [
        { type: "success", replyText: "Reply" },
        { type: "tool_call", name: "fixture_read", arguments: {} },
      ]) {
        const stub = await startDeterministicLlmStub({ dispatchPlan: [behavior] });
        try {
          const response = await fetch(`${stub.baseUrl}/${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: stub.model,
              stream,
              input: "fixture",
              messages: [{ role: "user", content: "fixture" }],
            }),
          });
          assert.equal(response.status, 200);
          const body = await response.text();
          const frames = stream
            ? body
                .split("\n")
                .filter((line) => line.startsWith("data: {"))
                .map((line) => JSON.parse(line.slice(6)))
            : [JSON.parse(body)];
          const usages = frames.flatMap((frame) =>
            frame.usage ? [frame.usage] : frame.response?.usage ? [frame.response.usage] : [],
          );
          assert.equal(usages.length, 1);
          assert.equal(
            usages[0].input_tokens_details?.cached_tokens ?? usages[0].prompt_tokens_details?.cached_tokens,
            0,
          );
          assert.equal(usages[0].input_tokens ?? usages[0].prompt_tokens, 12);
        } finally {
          await stub.close();
        }
      }
    }
  }
});

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
    const body = await response.json();
    const call = body.output.find((item) => item.type === "function_call");
    assert.equal(call?.name, "presentations_create");
    assert.deepEqual(JSON.parse(call.arguments), accepted);
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

test("non-streaming completions receive a JSON provider failure on each route", async () => {
  const failure = { type: "provider_error", code: "server_error", message: "Fixture failure." };
  const stub = await startDeterministicLlmStub({ dispatchPlan: [failure, failure] });
  try {
    for (const route of ["responses", "chat/completions"]) {
      const response = await fetch(`${stub.baseUrl}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: stub.model, stream: false }),
      });
      assert.equal(response.status, 500);
      assert.match(response.headers.get("content-type"), /^application\/json/u);
      assert.deepEqual((await response.json()).error, {
        code: "server_error",
        type: "server_error",
        message: "Fixture failure.",
      });
    }
    assert.deepEqual(
      stub.completionDispatchRecords().map((entry) => entry.status),
      [500, 500],
    );
  } finally {
    await stub.close();
  }
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
    dispatchPlan: [
      { type: "success", replyText: "SETUP" },
      { type: "success", replyText: "ORIGINAL_PLAN" },
    ],
  });
  const request = () =>
    fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, messages: [{ role: "user", content: "fixture" }] }),
    });
  try {
    assert.match(await (await request()).text(), /SETUP/u);
    const previousDispatches = stub.dispatchPlanDispatches();
    assert.throws(
      () => stub.replaceDispatchPlan([{ type: "success" }, { type: "http_error", status: 418 }], "bad tool"),
      /requiredTool/i,
    );
    assert.equal(stub.dispatchPlanDispatches(), previousDispatches);
    const afterRejectedReplacement = await request();
    assert.equal(afterRejectedReplacement.status, 200);
    assert.match(await afterRejectedReplacement.text(), /ORIGINAL_PLAN/u);
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
      { type: "tool_call", name: "browser_search", arguments: { query: "stream" }, callId: "call_stream" },
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

    const stream = await fetch(`${stub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, stream: true, messages: [{ role: "user", content: "fixture" }] }),
    });
    const toolFrame = (await stream.text()).split("\n").find((line) => line.startsWith("data: {"));
    assert.ok(toolFrame);
    assert.deepEqual(JSON.parse(toolFrame.slice(6)).choices[0].delta.tool_calls, [
      {
        index: 0,
        id: "call_stream",
        type: "function",
        function: { name: "browser_search", arguments: '{"query":"stream"}' },
      },
    ]);
  } finally {
    await stub.close();
  }
});

test("Responses string input participates in prompt rules and privacy-safe metadata", async () => {
  const input = "Synthetic user prompt with café";
  const stub = await startDeterministicLlmStub({
    promptReplyRules: [{ ruleId: "string-input", userContentIncludes: "user prompt", replyText: "STRING_MATCH" }],
  });
  try {
    const response = await fetch(`${stub.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: stub.model, input }),
    });
    assert.match(await response.text(), /STRING_MATCH/u);
    const [summary] = stub.requestSummaries();
    assert.equal(summary.promptReplyRuleId, "string-input");
    assert.deepEqual(summary.promptMetadata.roles, ["user"]);
    assert.equal(summary.promptMetadata.userContentByteLength, Buffer.byteLength(input, "utf8"));
    assert.equal(summary.promptMetadata.userContentSha256, createHash("sha256").update(input).digest("hex"));
    assert.ok(!JSON.stringify(summary).includes(input));
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
    assert.equal(stub.completionDispatchRecords()[0]?.finishedAt, undefined);
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

test("required tool isolates approval dispatches from setup and background traffic", async () => {
  for (const route of ["responses", "chat/completions"]) {
    const stub = await startDeterministicLlmStub({
      dispatchPlanRequiredTool: "fs_read",
      dispatchPlan: [{ type: "tool_call", name: "fs_read", arguments: { path: "fixture.txt" } }],
    });
    const send = (tools) =>
      fetch(`${stub.baseUrl}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: stub.model,
          input: "fixture",
          messages: [{ role: "user", content: "fixture" }],
          tools,
        }),
      });
    try {
      for (const tools of [undefined, [], [{ type: "function", name: "unrelated" }]]) {
        const response = await send(tools);
        assert.equal(response.status, 200);
        assert.doesNotMatch(await response.text(), /"fs_read"/u);
      }
      assert.equal(stub.dispatchPlanDispatches(), 0);
      const offered =
        route === "responses"
          ? { type: "function", name: "fs_read" }
          : { type: "function", function: { name: "fs_read" } };
      assert.match(await (await send([offered])).text(), /"fs_read"/u);
      assert.equal(stub.dispatchPlanDispatches(), 1);
    } finally {
      await stub.close();
    }
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

test("credential rotation invalidates the previous key without recording credential bytes", async () => {
  const before = "Bearer synthetic-before";
  const after = "Bearer synthetic-after";
  const stub = await startDeterministicLlmStub({ expectedAuthorization: before });
  const models = (authorization) => fetch(stub.baseUrl + "/models", { headers: { authorization } });
  try {
    assert.equal((await models(before)).status, 200);
    stub.replaceExpectedAuthorization(after);
    assert.equal((await models(before)).status, 401);
    assert.equal((await models(after)).status, 200);
    assert.throws(() => stub.replaceExpectedAuthorization(""), /expectedAuthorization/u);
    assert.equal((await models(before)).status, 401);
    const evidence = JSON.stringify(stub.requestSummaries());
    assert.ok(!evidence.includes(before) && !evidence.includes(after));
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
  for (const host of ["0.0.0.0", "[::]", "0:0:0:0:0:0:0:0"]) {
    await assert.rejects(startDeterministicLlmStub({ publicBaseUrlHost: host }), /cannot advertise/u);
  }
  for (const host of ["localhost:123", "[::1", "::1]", "example..test", "127.1"]) {
    await assert.rejects(startDeterministicLlmStub({ publicBaseUrlHost: host }), /plain hostname or IP address/u);
  }
  const stub = await startDeterministicLlmStub({ publicBaseUrlHost: "[0:0:0:0:0:0:0:1]" });
  try {
    assert.equal(stub.publicBaseUrlHost, "::1");
    assert.equal(new URL(stub.baseUrl).hostname, "[::1]");
  } finally {
    await stub.close();
  }
});

test("provider-error clock markers are explicit response metadata and leave native failures unchanged", async () => {
  const stub = await startDeterministicLlmStub({
    dispatchPlan: [
      {
        type: "provider_error",
        code: "server_error",
        message: "Marked fixture failure.",
        faultClockMarker: "GC_CLOCK_TRANSPORT_TEST",
      },
      { type: "provider_error", code: "server_error", message: "Unmarked fixture failure." },
    ],
  });
  try {
    for (const expectedMarker of ["GC_CLOCK_TRANSPORT_TEST", null]) {
      const response = await fetch(stub.baseUrl + "/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: stub.model, stream: true, input: "Synthetic fixture" }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-goatcitadel-verification-fault-clock"), expectedMarker);
      assert.match(await response.text(), /"type":"response.failed"/u);
    }
    assert.deepEqual(
      stub.dispatchPlanDispatchRecords().map(({ outcome }) => outcome),
      ["provider_error", "provider_error"],
    );
  } finally {
    await stub.close();
  }
});

test("provider-error clock marker rejects values unsafe for its fixture response header", async () => {
  let unexpectedStub;
  try {
    await assert.rejects(async () => {
      unexpectedStub = await startDeterministicLlmStub({
        dispatchPlan: [{ type: "provider_error", faultClockMarker: "bad\r\ninjected: value" }],
      });
    }, /faultClockMarker/u);
  } finally {
    await unexpectedStub?.close();
  }
});
