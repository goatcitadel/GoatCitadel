// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCapabilityPluginDetail,
  fetchCapabilityPluginInspection,
  fetchCapabilityPlugins,
  inspectCapabilityPlugin,
  installCapabilityPlugin,
  uninstallCapabilityPlugin,
} from "./capability-plugins.js";

// The real client-core transport, so the test sees the headers it adds below `request` (the Idempotency-Key included).
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(body: unknown = {}, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () => json(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof stubFetch>, call = 0) {
  const [url, init] = fetchMock.mock.calls[call]!;
  const target = new URL(String(url), "http://gateway.invalid");
  return {
    path: target.pathname,
    query: target.search,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    key: new Headers(init?.headers).get("Idempotency-Key"),
    cache: init?.cache,
    signal: init?.signal,
  };
}

const ATTEMPT_KEY = "6f1c2b9e-3d4a-4b5c-8d7e-0a1b2c3d4e5f";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plugin reads", () => {
  it("reads the plugin list for the encoded workspace, never kept", async () => {
    const fetchMock = stubFetch({ installed: [], builtIn: [] });
    await fetchCapabilityPlugins("a/b");
    expect(sent(fetchMock)).toMatchObject({
      path: "/api/v1/capabilities/plugins",
      query: "?workspaceId=a%2Fb",
      method: "GET",
      cache: "no-store",
      key: null,
    });
  });

  it("reads one plugin's detail with both ids encoded", async () => {
    const fetchMock = stubFetch({ pluginId: "browser-checks" });
    await fetchCapabilityPluginDetail("w & x", "browser-checks");
    expect(sent(fetchMock)).toMatchObject({
      path: "/api/v1/capabilities/plugins/detail",
      query: "?pluginId=browser-checks&workspaceId=w+%26+x",
      method: "GET",
      cache: "no-store",
      key: null,
    });
  });

  it("reads a kept inspection back with no query at all, which the route refuses", async () => {
    const fetchMock = stubFetch({ inspectionId: "i/1" });
    await fetchCapabilityPluginInspection("i/1");
    expect(sent(fetchMock)).toMatchObject({
      path: "/api/v1/capabilities/plugins/inspections/i%2F1",
      query: "",
      method: "GET",
      cache: "no-store",
      key: null,
    });
  });

  it("forwards the abort signal on every read", async () => {
    const fetchMock = stubFetch({});
    const controller = new AbortController();
    await fetchCapabilityPlugins("w-1", { signal: controller.signal });
    await fetchCapabilityPluginDetail("w-2", "p", { signal: controller.signal });
    await fetchCapabilityPluginInspection("i-3", { signal: controller.signal });
    for (const call of [0, 1, 2]) {
      // The client joins the caller's signal with its own read timeout, so the one sent follows the caller's.
      const signal = sent(fetchMock, call).signal as AbortSignal;
      expect(signal.aborted, String(call)).toBe(false);
    }
    controller.abort();
    for (const call of [0, 1, 2])
      expect((sent(fetchMock, call).signal as AbortSignal).aborted, String(call)).toBe(true);
  });
});

describe("plugin actions", () => {
  it("sends an Idempotency-Key on install and uninstall", async () => {
    const fetchMock = stubFetch({ planId: "plan-1", outcome: "waiting", summary: "Waits." }, 202);
    await installCapabilityPlugin({ workspaceId: "lab", inspectionId: "i-1", hookSecrets: { alerts: "s3cret" } });
    await uninstallCapabilityPlugin({ workspaceId: "lab", pluginId: "browser-checks" });

    const install = sent(fetchMock, 0);
    expect(install).toMatchObject({
      path: "/api/v1/capabilities/plugins/install",
      method: "POST",
      body: { workspaceId: "lab", inspectionId: "i-1", hookSecrets: { alerts: "s3cret" } },
    });
    const uninstall = sent(fetchMock, 1);
    expect(uninstall).toMatchObject({
      path: "/api/v1/capabilities/plugins/uninstall",
      method: "POST",
      body: { workspaceId: "lab", pluginId: "browser-checks" },
    });
    // Each press is its own attempt: a fresh key every time, with no query string.
    expect(install.key).toBeTruthy();
    expect(uninstall.key).toBeTruthy();
    expect(install.key).not.toBe(uninstall.key);
    expect([install.query, uninstall.query]).toEqual(["", ""]);
  });

  it("sends an Idempotency-Key on an inspection, which answers 201", async () => {
    const fetchMock = stubFetch({ inspectionId: "i-1" }, 201);
    const answer = await inspectCapabilityPlugin({
      workspaceId: "lab",
      source: { kind: "git", url: "https://github.com/example/plugin" },
    });
    expect(answer).toEqual({ inspectionId: "i-1" });
    expect(sent(fetchMock)).toMatchObject({
      path: "/api/v1/capabilities/plugins/inspections",
      method: "POST",
      body: { workspaceId: "lab", source: { kind: "git", url: "https://github.com/example/plugin" } },
    });
    expect(sent(fetchMock).key).toBeTruthy();
  });

  it("sends the caller's attempt key on all three, so a retry of a lost answer gets the first one", async () => {
    const fetchMock = stubFetch({}, 202);
    const options = { attemptKey: ATTEMPT_KEY };
    await inspectCapabilityPlugin({ workspaceId: "lab", source: { kind: "built_in", pluginId: "x" } }, options);
    await installCapabilityPlugin({ workspaceId: "lab", inspectionId: "i-1" }, options);
    await uninstallCapabilityPlugin({ workspaceId: "lab", pluginId: "x" }, options);
    expect([0, 1, 2].map((call) => sent(fetchMock, call).key)).toEqual([ATTEMPT_KEY, ATTEMPT_KEY, ATTEMPT_KEY]);
  });

  it("refuses an attempt key that isn't a UUID before anything is sent", async () => {
    const fetchMock = stubFetch({}, 202);
    await expect(
      uninstallCapabilityPlugin({ workspaceId: "lab", pluginId: "x" }, { attemptKey: "press-1" }),
    ).rejects.toThrow("An attempt key must be a UUID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands a refusal back with its status and the Gateway's own body", async () => {
    stubFetch({ error: "This plugin isn't installed.", code: "NOT_FOUND" }, 404);
    await expect(uninstallCapabilityPlugin({ workspaceId: "lab", pluginId: "x" })).rejects.toMatchObject({
      status: 404,
      body: { error: "This plugin isn't installed." },
    });
  });
});
