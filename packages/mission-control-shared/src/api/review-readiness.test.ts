import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchReviewReadiness, refreshRuntimeReleaseTrust } from "./review-readiness";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({ request: apiMocks.request }));

beforeEach(() => {
  apiMocks.request.mockReset();
  apiMocks.request.mockResolvedValue({});
});

describe("review readiness api", () => {
  it("keeps ordinary readiness reads non-mutating", async () => {
    await fetchReviewReadiness();
    expect(apiMocks.request).toHaveBeenCalledWith("/api/v1/review/readiness");
  });

  it("uses the explicit operator refresh route for a forced runtime payload scan", async () => {
    await refreshRuntimeReleaseTrust();
    expect(apiMocks.request).toHaveBeenCalledWith("/api/v1/review/readiness/runtime-release/refresh", {
      method: "POST",
    });
  });
});
