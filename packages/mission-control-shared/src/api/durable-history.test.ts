import { describe, expect, it, vi } from "vitest";
import { fetchDurableRunHistory, fetchDurableRuns } from "./durable.js";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: mocks.request }));

describe("durable history client", () => {
  it("encodes workspace and opaque cursor without dropping empty or invalid inputs", async () => {
    const result = { items: [], nextCursor: "next-page" };
    mocks.request.mockResolvedValueOnce(result);
    await expect(fetchDurableRunHistory({ workspaceId: "alpha & beta", limit: 20, cursor: "page+/=" })).resolves.toBe(result);
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/durable/runs?workspaceId=alpha+%26+beta&limit=20&cursor=page%2B%2F%3D", undefined);
    await fetchDurableRunHistory({ workspaceId: "alpha", cursor: "" });
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/durable/runs?workspaceId=alpha&cursor=", undefined);
  });

  it("retains the existing numeric unscoped list contract", async () => {
    await fetchDurableRuns(600);
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/durable/runs?limit=500");
    await fetchDurableRunHistory({ workspaceId: "alpha" });
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/durable/runs?workspaceId=alpha", undefined);
  });
});
