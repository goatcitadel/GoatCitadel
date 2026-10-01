import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ request: vi.fn(async () => ({})) }));
vi.mock("./client-core.js", () => ({ request: api.request }));
import { completeReviewedMcpOAuth, startReviewedMcpOAuth } from "./mcp.js";
it("uses distinct guarded paths with exact opaque revision pair and transient completion data", async () => {
  const review = { expectedRevision: "a".repeat(64), expectedConnectionRevision: null };
  await startReviewedMcpOAuth("server/one", review);
  const completion = { ...review, code: "transient-code", state: "11111111-1111-4111-8111-111111111111" };
  await completeReviewedMcpOAuth("server/one", completion);
  expect(api.request.mock.calls).toEqual([
    ["/api/v1/mcp/servers/server%2Fone/oauth/start-reviewed", { method: "POST", body: JSON.stringify(review) }],
    ["/api/v1/mcp/servers/server%2Fone/oauth/complete-reviewed", { method: "POST", body: JSON.stringify(completion) }],
  ]);
});
