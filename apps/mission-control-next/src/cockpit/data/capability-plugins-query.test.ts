import { beforeEach, expect, it, vi } from "vitest";

const fetchCapabilityPlugins = vi.hoisted(() => vi.fn(async () => ({ installed: [], builtIn: [] })));
const fetchCapabilityPluginDetail = vi.hoisted(() => vi.fn(async () => ({ pluginId: "p-1" })));
const fetchCapabilityPluginInspection = vi.hoisted(() => vi.fn(async () => ({ inspectionId: "i-1" })));
vi.mock("@goatcitadel/mission-control-shared/api/capability-plugins", () => ({
  fetchCapabilityPlugins,
  fetchCapabilityPluginDetail,
  fetchCapabilityPluginInspection,
}));

import { pluginDetailQuery, pluginInspectionQuery, pluginListQuery } from "./capability-plugins-query";
import { queryKeys } from "./query-keys";

beforeEach(() => {
  fetchCapabilityPlugins.mockClear();
  fetchCapabilityPluginDetail.mockClear();
  fetchCapabilityPluginInspection.mockClear();
});

it("reads the plugin list for the workspace under its own key, passing the abort signal", async () => {
  const options = pluginListQuery("ws-1");
  expect(options.queryKey).toEqual(queryKeys.capabilityPlugins("ws-1"));
  expect(options.queryKey).toEqual(["plugins", "capability-plugins", "ws-1"]);
  expect(options.staleTime).toBeUndefined();
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilityPlugins).toHaveBeenCalledWith("ws-1", { signal });
});

it("reads one plugin's detail under a key that names the workspace and the plugin", async () => {
  const options = pluginDetailQuery("ws-1", "browser-checks");
  expect(options.queryKey).toEqual(queryKeys.capabilityPluginDetail("ws-1", "browser-checks"));
  expect(options.queryKey).toEqual(["plugins", "capability-plugin-detail", "ws-1", "browser-checks"]);
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilityPluginDetail).toHaveBeenCalledWith("ws-1", "browser-checks", { signal });
});

it("reads a kept inspection by its id alone", async () => {
  const options = pluginInspectionQuery("i-1");
  expect(options.queryKey).toEqual(queryKeys.capabilityPluginInspection("i-1"));
  expect(options.queryKey).toEqual(["plugins", "capability-plugin-inspection", "i-1"]);
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilityPluginInspection).toHaveBeenCalledWith("i-1", { signal });
});
