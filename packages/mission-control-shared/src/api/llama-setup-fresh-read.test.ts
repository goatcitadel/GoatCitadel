import { afterEach, expect, it, vi } from "vitest";
import type { LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { fetchLlamaCppSetup } from "./platform.js";

afterEach(() => vi.unstubAllGlobals());
it("keeps a required setup refresh separate from an older pending-plan projection", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const transport = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(resolve)));
  vi.stubGlobal("fetch", transport);
  const base: LlamaCppSetupProjection = {
    settingsRevision: 8, managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1",
    runtime: { enabled: false, desiredState: "stopped", processState: "stopped", healthy: false,
      baseUrl: "http://127.0.0.1:8080/v1", updatedAt: "2026-09-30T00:00:00.000Z" },
    ownership: "none", binary: { found: false }, models: [], catalog: { status: "unavailable", modelIds: [] },
    chatRoute: { providerId: "fixture", model: "fixture-model", thinkingLevel: "off" },
  };
  const pending: LlamaCppSetupProjection = { ...base,
    pendingPlan: { planId: "plan-1", revision: 3, status: "awaiting_approval" } };
  const cancelled: LlamaCppSetupProjection = { ...base,
    recentPlan: { planId: "plan-1", revision: 4, status: "cancelled" } };
  const older = fetchLlamaCppSetup("workspace/a"), joined = fetchLlamaCppSetup("workspace/a");
  expect(transport).toHaveBeenCalledTimes(1);
  const signal = new AbortController().signal;
  const fresh = fetchLlamaCppSetup("workspace/a", signal);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", signal });
  expect(transport.mock.calls[1]?.[1]?.method ?? "GET").toBe("GET");
  expect(transport.mock.calls[1]?.[1]?.body).toBeUndefined();
  const url = new URL(transport.mock.calls[1]![0]);
  expect(url.pathname).toBe("/api/v1/llamacpp/setup");
  expect(url.search).toBe("?workspaceId=workspace%2Fa");
  resolvers[1]!(Response.json(cancelled));
  await expect(fresh).resolves.toEqual(cancelled);
  resolvers[0]!(Response.json(pending));
  expect(await Promise.all([older, joined])).toEqual([pending, pending]);
});
