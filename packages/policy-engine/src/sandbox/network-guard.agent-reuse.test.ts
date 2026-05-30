import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for POLICY-003 (per-request undici `Agent` defeated
// connection reuse and churned handles/timers). The fix reuses one guarded
// `Agent` per (DNS-lookup fn, target host:port, allowlist signature) instead
// of constructing a fresh dispatcher on every request and redirect hop.
//
// We mock `undici` so the `Agent` constructor is observable, while still
// returning a real Agent instance (so `.close()` and the `dispatcher` option
// behave normally). `global.fetch` is stubbed so no real network I/O happens
// and we can capture the `dispatcher` passed through on each call to assert
// referential reuse and that request options/guards are unchanged.
//
// The guarded-Agent cache is module-level and persists for the lifetime of the
// imported module, so each test uses a UNIQUE host to keep construction counts
// deterministic regardless of execution order.

const agentConstructorSpy = vi.fn();

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  class ObservableAgent extends actual.Agent {
    constructor(...args: ConstructorParameters<typeof actual.Agent>) {
      super(...args);
      agentConstructorSpy(...args);
    }
  }
  return { ...actual, Agent: ObservableAgent };
});

// Imported after vi.mock so the module under test binds the mocked `Agent`.
const { fetchAllowlisted, fetchAllowlistedOnce } = await import("./network-guard.js");

interface CapturedCall {
  url: string;
  init: RequestInit & { dispatcher?: unknown };
}

const originalFetch = global.fetch;
let captured: CapturedCall[] = [];

function stubFetch(responder: (url: string) => Response): void {
  const stub = vi.fn(async (url: string, init?: RequestInit & { dispatcher?: unknown }) => {
    captured.push({ url, init: init ?? {} });
    return responder(url);
  });
  global.fetch = stub as unknown as typeof global.fetch;
}

beforeEach(() => {
  agentConstructorSpy.mockClear();
  captured = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("guarded Agent reuse (POLICY-003)", () => {
  it("constructs a single Agent and reuses it across requests to the same host + allowlist", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));

    const host = "reuse-same-host.example.com";
    const allowlist = [host];
    await fetchAllowlisted(`https://${host}/a`, { allowlist });
    await fetchAllowlisted(`https://${host}/b?x=1`, { allowlist });
    await fetchAllowlisted(`https://${host}/c`, { allowlist: [host] });

    // Three requests (differing only by path/query, identical host+allowlist)
    // must share exactly one Agent.
    expect(agentConstructorSpy).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(3);
    const dispatchers = captured.map((call) => call.init.dispatcher);
    expect(dispatchers[0]).toBeDefined();
    expect(dispatchers[1]).toBe(dispatchers[0]);
    expect(dispatchers[2]).toBe(dispatchers[0]);
  });

  it("reuses one Agent across every redirect hop of a single fetch", async () => {
    const host = "reuse-redirect.example.com";
    stubFetch((url) => {
      if (url === `https://${host}/start`) {
        return new Response(null, { status: 302, headers: { Location: `https://${host}/next` } });
      }
      return new Response("final", { status: 200 });
    });

    const response = await fetchAllowlisted(`https://${host}/start`, { allowlist: [host] });
    expect(await response.text()).toBe("final");

    // Two hops, same host+allowlist => one Agent, same dispatcher instance.
    expect(agentConstructorSpy).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(2);
    expect(captured[1]?.init.dispatcher).toBe(captured[0]?.init.dispatcher);
  });

  it("builds a distinct Agent per distinct host and per distinct allowlist signature", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));

    const hostA = "reuse-distinct-a.example.com";
    const hostB = "reuse-distinct-b.example.com";
    await fetchAllowlisted(`https://${hostA}/`, { allowlist: [hostA, hostB] });
    await fetchAllowlisted(`https://${hostB}/`, { allowlist: [hostA, hostB] });
    // Same host as the first request but a narrower allowlist => different key.
    await fetchAllowlisted(`https://${hostA}/`, { allowlist: [hostA] });

    expect(agentConstructorSpy).toHaveBeenCalledTimes(3);
    const dispatchers = captured.map((call) => call.init.dispatcher);
    expect(dispatchers[0]).not.toBe(dispatchers[1]);
    expect(dispatchers[0]).not.toBe(dispatchers[2]);
    expect(dispatchers[1]).not.toBe(dispatchers[2]);
  });

  it("keeps request options and the dispatcher wiring unchanged when reusing the Agent", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));

    const host = "reuse-options.example.com";
    const init: RequestInit = { method: "POST", headers: { "x-test": "1" }, body: "payload" };
    await fetchAllowlisted(`https://${host}/post`, { allowlist: [host], init });
    await fetchAllowlisted(`https://${host}/post2`, { allowlist: [host], init });

    expect(agentConstructorSpy).toHaveBeenCalledTimes(1);
    for (const call of captured) {
      expect(call.init.method).toBe("POST");
      expect(call.init.headers).toMatchObject({ "x-test": "1" });
      expect(call.init.body).toBe("payload");
      // The helper enforces manual redirect handling and always wires a guarded
      // dispatcher + an abort signal — these guards must be preserved.
      expect(call.init.redirect).toBe("manual");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.dispatcher).toBeDefined();
    }
  });

  it("does not construct an Agent or call fetch when the host is blocked (SSRF guard preserved)", async () => {
    stubFetch(() => new Response("should-not-be-reached", { status: 200 }));
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;

    await expect(fetchAllowlisted("http://169.254.169.254/latest/meta-data", { allowlist: ["*"] })).rejects.toThrow(
      /private|metadata|reserved|blocked/i,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(agentConstructorSpy).not.toHaveBeenCalled();
  });

  it("reuses the same Agent between fetchAllowlisted and fetchAllowlistedOnce for an identical key", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));

    const host = "reuse-shared-helpers.example.com";
    await fetchAllowlisted(`https://${host}/a`, { allowlist: [host] });
    await fetchAllowlistedOnce(`https://${host}/b`, { allowlist: [host] });

    expect(agentConstructorSpy).toHaveBeenCalledTimes(1);
    expect(captured[1]?.init.dispatcher).toBe(captured[0]?.init.dispatcher);
  });
});
