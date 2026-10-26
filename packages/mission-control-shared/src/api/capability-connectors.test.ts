import { expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn(async () => ({ workspaceId: "a/b", items: [], issues: [], generatedAt: "" })));
vi.mock("./client-core.js", () => ({ request }));
import { fetchCapabilityConnectors } from "./capability-connectors.js";
it("requests the connector list for the encoded workspace", async () => {
  await fetchCapabilityConnectors("a/b");
  expect(request).toHaveBeenCalledWith("/api/v1/capabilities/connectors?workspaceId=a%2Fb", {
    cache: "no-store",
  });
});
it("forwards the abort signal to the request", async () => {
  const controller = new AbortController();
  await fetchCapabilityConnectors("a/b", { signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/connectors?workspaceId=a%2Fb", {
    cache: "no-store",
    signal: controller.signal,
  });
});
