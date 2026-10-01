import { beforeEach, describe, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request }));
import { updateProviderTransport } from "./provider-transport.js";

beforeEach(() => { request.mockReset(); });
describe("provider transport owner boundary", () => {
  it("sends only transport and exact revision through the existing authenticated client", async () => {
    const transport = { headers: { "X-Fixture": "reviewed" } };
    const receipt = { revision: 8 };
    request.mockResolvedValue(receipt);
    expect(await updateProviderTransport({ expectedRevision: 7, providerId: "fixture", request: transport })).toBe(receipt);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/v1/llm/config", {
      method: "PATCH", body: JSON.stringify({ expectedRevision: 7, upsertProvider: { providerId: "fixture", request: transport } }),
    });
  });
  it("does not fall back to another mutation when the owner rejects the request", async () => {
    const rejected = new Error("Inline credential rejected"); request.mockRejectedValue(rejected);
    await expect(updateProviderTransport({ expectedRevision: 7, providerId: "fixture", request: {} })).rejects.toBe(rejected);
    expect(request).toHaveBeenCalledOnce();
  });
});
