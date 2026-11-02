import { afterEach, describe, expect, it } from "vitest";
import { startFakeOpenAiCompatibleServer, type FakeOpenAiServer } from "../test/fake-openai-server.js";
import { createOpenAiCompatibleLlmService } from "../test/llm-fixtures.js";

let server: FakeOpenAiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("LlmService real provider transport", () => {
  it("discovers live models through the guarded dispatcher", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl);

    const result = await service.listModelsWithSource("fake-openai");

    expect(result.source).toBe("live");
    expect(result.items.map((model) => model.id)).toEqual(["fake-chat", "fake-tools"]);
    expect(server.requests.map((request) => request.path)).toEqual(["/v1/models"]);
  });

  it("consumes a JSON completion through the guarded dispatcher", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl);

    const response = await service.chatCompletions({ messages: [{ role: "user", content: "hello" }] });

    expect(response.choices).toEqual([
      { index: 0, message: { role: "assistant", content: "fake response" }, finish_reason: "stop" },
    ]);
    expect(server.requests.map((request) => request.path)).toEqual(["/v1/chat/completions"]);
  });

  it("consumes streamed completion frames through the guarded dispatcher", async () => {
    server = await startFakeOpenAiCompatibleServer();
    const service = createOpenAiCompatibleLlmService(server.baseUrl);
    const chunks: unknown[] = [];

    for await (const chunk of service.chatCompletionsStream({ messages: [{ role: "user", content: "hello" }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ choices: [{ index: 0, delta: { content: "hello " } }] }),
        expect.objectContaining({ choices: [{ index: 0, delta: { content: "world" }, finish_reason: "stop" }] }),
      ]),
    );
    expect(server.requests.map((request) => request.path)).toEqual(["/v1/chat/completions"]);
  });

  it("sends native FormData and consumes an image-edit response through the guarded dispatcher", async () => {
    server = await startFakeOpenAiCompatibleServer((request) => {
      if (request.method === "POST" && request.path === "/v1/images/edits") {
        return { body: { data: [{ b64_json: "aW1hZ2U=" }] } };
      }
      return { status: 404, body: { error: { message: "Unexpected test endpoint" } } };
    });
    const service = createOpenAiCompatibleLlmService(server.baseUrl, {
      providerId: "openai",
      provider: { apiKey: "transport-test-only" },
    });

    const response = await service.generateImage({
      model: "gpt-image-1",
      prompt: "Edit the test image",
      referenceImages: [{ bytesBase64: "aW1hZ2U=", mimeType: "image/png", fileName: "test.png" }],
    });

    expect(response.data).toEqual([expect.objectContaining({ b64Json: "aW1hZ2U=" })]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe("/v1/images/edits");
    expect(server.requests[0]?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(server.requests[0]?.rawBody).toContain('name="prompt"\r\n\r\nEdit the test image');
    expect(server.requests[0]?.rawBody).toContain('name="image"; filename="test.png"');
    expect(server.requests[0]?.rawBody).toContain("image");
  });
});
