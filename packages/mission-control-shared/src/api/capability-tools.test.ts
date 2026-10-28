import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./client-core.js", () => ({ request }));
import { fetchCapabilityToolUsage, fetchCapabilityTools } from "./capability-tools.js";

beforeEach(() => {
  request.mockClear();
});

it("requests the tool groups for the encoded workspace", async () => {
  await fetchCapabilityTools("a/b");
  expect(request).toHaveBeenCalledWith("/api/v1/capabilities/tools?workspaceId=a%2Fb", {
    cache: "no-store",
  });
});

it("forwards the abort signal on both reads", async () => {
  const controller = new AbortController();
  await fetchCapabilityTools("a/b", { signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/tools?workspaceId=a%2Fb", {
    cache: "no-store",
    signal: controller.signal,
  });
  await fetchCapabilityToolUsage({ signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/tools/usage", {
    cache: "no-store",
    signal: controller.signal,
  });
});

it("asks for fresh counts only on refresh", async () => {
  await fetchCapabilityToolUsage();
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/tools/usage", { cache: "no-store" });
  await fetchCapabilityToolUsage({ refresh: false });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/tools/usage", { cache: "no-store" });
  await fetchCapabilityToolUsage({ refresh: true });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/tools/usage?refresh=true", { cache: "no-store" });
});
