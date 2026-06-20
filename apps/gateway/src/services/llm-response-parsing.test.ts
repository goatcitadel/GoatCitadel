import { describe, expect, it } from "vitest";
import { parseProviderJsonResponse } from "./llm-response-parsing.js";

describe("parseProviderJsonResponse", () => {
  it("parses provider JSON through the bounded response reader", async () => {
    await expect(parseProviderJsonResponse("chat completion", new Response('{"ok":true}'))).resolves.toEqual({
      ok: true,
    });
  });

  it("keeps malformed JSON errors provider-attributed with a bounded body snippet", async () => {
    await expect(
      parseProviderJsonResponse("chat completion", new Response("<html><body>bad gateway</body></html>")),
    ).rejects.toThrow("chat completion returned malformed JSON");
  });

  it("rejects oversized provider bodies before parsing", async () => {
    await expect(
      parseProviderJsonResponse(
        "chat completion",
        new Response("{}", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        }),
      ),
    ).rejects.toThrow("chat completion response body exceeded 2097152 bytes");
  });
});
