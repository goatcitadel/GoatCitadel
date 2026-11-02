import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./http-internal.js";

const request = vi.hoisted(() => vi.fn());
vi.mock("./client-core.js", () => ({ request }));
import { fetchBrowserErrandStatus, stopBrowserErrand } from "./browser-errands.js";

beforeEach(() => {
  request.mockReset();
});

describe("browser errand api", () => {
  it("reads the status by encoded tool run id", async () => {
    request.mockResolvedValue({ errandId: "e1" });
    await expect(fetchBrowserErrandStatus("run/1")).resolves.toEqual({ errandId: "e1" });
    expect(request).toHaveBeenCalledWith("/api/v1/browser-errands/by-tool-run/run%2F1", { cache: "no-store" });
  });

  it("answers null when the Gateway holds no errand for the run", async () => {
    request.mockImplementation(() =>
      Promise.reject(
        new ApiRequestError("API error 404: gone", { kind: "http", method: "GET", path: "/x", status: 404 }),
      ),
    );
    expect(await fetchBrowserErrandStatus("run-1")).toBeNull();
  });

  it("rethrows other failures", async () => {
    request.mockImplementation(() =>
      Promise.reject(
        new ApiRequestError("API error 500: boom", { kind: "http", method: "GET", path: "/x", status: 500 }),
      ),
    );
    await expect(fetchBrowserErrandStatus("run-1")).rejects.toThrow("boom");
  });

  it("posts the stop for the encoded errand id", async () => {
    request.mockResolvedValue({ stopped: true });
    await expect(stopBrowserErrand("e/1")).resolves.toEqual({ stopped: true });
    expect(request).toHaveBeenCalledWith("/api/v1/browser-errands/e%2F1/stop", { method: "POST" });
  });
});
