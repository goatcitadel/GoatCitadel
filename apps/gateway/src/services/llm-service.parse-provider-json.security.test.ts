import { describe, expect, it } from "vitest";
import { parseProviderJsonResponse } from "./llm-service.js";

// Regression coverage for SECURITY_AUDIT_2026-05-15 — S19. Every provider HTTP
// response decode must produce a typed provider-owned error instead of a raw
// `SyntaxError: Unexpected token <` when the provider returns a 200 with HTML
// (Cloudflare challenge, rate-limit page, gateway-timeout HTML, etc.).

function makeResponse(body: string, init?: { status?: number; statusText?: string }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: { "content-type": "application/json" },
  });
}

describe("parseProviderJsonResponse (S19)", () => {
  it("parses valid JSON bodies", async () => {
    const response = makeResponse('{"choices":[{"message":{"role":"assistant","content":"hi"}}]}');
    const parsed = await parseProviderJsonResponse("chat completion", response);
    expect(parsed).toEqual({ choices: [{ message: { role: "assistant", content: "hi" } }] });
  });

  it("throws a provider-owned error on HTML masquerading as a 200 JSON response", async () => {
    const cloudflareBody = "<html><head><title>Just a moment...</title></head><body>Verifying...</body></html>";

    await expect(
      parseProviderJsonResponse("chat completion", makeResponse(cloudflareBody, { status: 200 })),
    ).rejects.toThrow(/chat completion returned malformed JSON \(200 OK\)/);
    await expect(
      parseProviderJsonResponse("chat completion", makeResponse(cloudflareBody, { status: 200 })),
    ).rejects.toThrow(/Just a moment/);
  });

  it("includes the body snippet, redacted of newlines, in the error message", async () => {
    const messyBody = "<!doctype html>\n<html>\nRate\tlimited\n</html>";
    const response = makeResponse(messyBody, { status: 200 });
    await expect(parseProviderJsonResponse("provider stream", response)).rejects.toThrow(
      /provider stream returned malformed JSON .* body: <!doctype html> <html> Rate limited <\/html>/,
    );
  });

  it("clips a giant non-JSON body to a 400-char snippet", async () => {
    const giantBody = "X".repeat(10_000);
    const response = makeResponse(giantBody, { status: 200 });
    let captured: Error | undefined;
    try {
      await parseProviderJsonResponse("model listing", response);
    } catch (error) {
      captured = error as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = captured?.message ?? "";
    // Snippet should be 400 chars max + the surrounding error context
    const snippetMatch = message.match(/body: (X+)/);
    expect(snippetMatch).not.toBeNull();
    expect(snippetMatch?.[1]?.length ?? 0).toBeLessThanOrEqual(400);
  });

  it("does not include the body snippet when the response has no body", async () => {
    const response = makeResponse("", { status: 200 });
    await expect(parseProviderJsonResponse("chat completion", response)).rejects.toThrow(
      /chat completion returned malformed JSON \(200 OK\)/,
    );
    await expect(parseProviderJsonResponse("chat completion", makeResponse("", { status: 200 }))).rejects.not.toThrow(
      /body:/,
    );
  });
});
