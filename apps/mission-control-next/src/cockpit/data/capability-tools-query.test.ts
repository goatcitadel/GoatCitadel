import { beforeEach, expect, it, vi } from "vitest";

const fetchCapabilityTools = vi.hoisted(() => vi.fn(async () => ({ groups: [] })));
const fetchCapabilityToolUsage = vi.hoisted(() => vi.fn(async () => ({ groups: [] })));
vi.mock("@goatcitadel/mission-control-shared/api/capability-tools", () => ({
  fetchCapabilityTools,
  fetchCapabilityToolUsage,
}));

import { toolListQuery, toolUsageQuery } from "./capability-tools-query";
import { queryKeys } from "./query-keys";

beforeEach(() => {
  fetchCapabilityTools.mockClear();
  fetchCapabilityToolUsage.mockClear();
});

it("reads the tool list for the workspace under its own key, passing the abort signal", async () => {
  const options = toolListQuery("ws-1");
  expect(options.queryKey).toEqual(queryKeys.capabilityTools("ws-1"));
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilityTools).toHaveBeenCalledWith("ws-1", { signal });
});

it("reads the call counts without asking for a re-count, and treats them as fresh for a minute", async () => {
  const options = toolUsageQuery();
  expect(options.queryKey).toEqual(queryKeys.capabilityToolUsage());
  expect(options.staleTime).toBe(60_000);
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilityToolUsage).toHaveBeenCalledWith({ signal });
});
