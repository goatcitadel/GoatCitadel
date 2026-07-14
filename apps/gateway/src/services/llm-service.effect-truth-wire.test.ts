import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import { INTERNAL_TOOL_EFFECT_POTENTIAL_KEY } from "./chat-message-sanitize.js";

const CONFIG: LlmConfigFile = {
  activeProviderId: "local-wire-proof",
  providers: [
    {
      providerId: "local-wire-proof",
      label: "Local wire proof",
      baseUrl: "http://127.0.0.1:24681/v1",
      apiStyle: "openai-chat-completions",
      defaultModel: "wire-proof-model",
    },
  ],
};

function service(): LlmService {
  return new LlmService(CONFIG, process.env, {
    // The loopback provider does not require a secret. Keep the test isolated
    // from the host keychain regardless of platform configuration.
    secretStore: {} as never,
  });
}

function request(): ChatCompletionRequest {
  return {
    providerId: "local-wire-proof",
    model: "wire-proof-model",
    messages: [
      { role: "user", content: "check the time" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-wire-proof",
            type: "function",
            function: { name: "time_now", arguments: "{}" },
            [INTERNAL_TOOL_EFFECT_POTENTIAL_KEY]: "unknown",
            gc_internal_receipt_ref: "must-not-wire",
          },
        ],
      } as never,
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "time_now",
          description: "Read current time.",
          parameters: {
            type: "object",
            properties: {
              nested: { type: "string", gc_internal_effect_disposition: "unknown" },
            },
          },
        },
        gc_internal_effect_potential: "none",
      } as never,
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LlmService internal tool-effect wire boundary", () => {
  it("strips internal metadata before a complete provider request", async () => {
    let wireBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        wireBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            id: "completion-wire-proof",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    );

    await service().chatCompletions(request());

    expect(wireBody).not.toContain("gc_internal_");
    expect(wireBody).not.toContain("must-not-wire");
    expect(JSON.parse(wireBody)).toMatchObject({ model: "wire-proof-model" });
  });

  it("strips internal metadata before a streamed provider request", async () => {
    let wireBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        wireBody = String(init?.body ?? "");
        return new Response(
          'data: {"id":"stream-wire-proof","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch,
    );

    for await (const _chunk of service().chatCompletionsStream(request())) {
      // Consume the full stream so the provider adapter and release path run.
    }

    expect(wireBody).not.toContain("gc_internal_");
    expect(wireBody).not.toContain("must-not-wire");
    expect(JSON.parse(wireBody)).toMatchObject({ model: "wire-proof-model", stream: true });
  });
});
